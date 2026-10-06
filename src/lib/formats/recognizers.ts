/*
 * Original TRACE module (MIT). Byte-level detection of board families TRACE cannot open, so the user gets a precise
 * explanation instead of a generic "unrecognized" error. A recognizer NEVER returns a Board: it throws
 * BoardFormatError(message, 'UNSUPPORTED_VARIANT', <capability id of FORMAT_CAPABILITIES>) or returns null.
 * Every scan is bounded: at most 64 KiB of text (+ the last 512 bytes for Gerber), 8 MiB of gunzipped tar prefix.
 *
 * Signature provenance (all conservative; a file that does not match stays "unrecognized"):
 *   allegro-brd   KiCad developer documentation (dev-docs.kicad.org/en/import-formats/allegro): 4-byte magic at offset 0 whose lower
 *                 byte is masked (documented values 0x00130000 ... 0x00150000 = Allegro 16.0 ... 18.0+), and the string "all" at
 *                 offset 0xF8, which that documentation calls the importer's validity check. Pre-16 databases and the "vie" marker
 *                 that the capability table once mentioned are NOT documented anywhere found, so they are not recognized.
 *   gerber        RS-274X: a mandatory %FS...X..Y..*% format statement plus a second marker (%MO, %AD, %TF, G04 comment, M02*).
 *   odbpp         gzip + ustar headers (valid checksums) whose paths contain matrix/matrix or steps/<step>/ below an optional job directory.
 *   ipc2581       XML whose root element is <IPC-2581> (XML declaration, comments and DOCTYPE may precede it).
 *   mentor-neutral '# file :' and '# date :' comment lines at the top; that header is the only public example found (a vendor help page),
 *                 not a specification.
 *   samsung-cad   no longer a recognizer: the family is read by samsung-cad.ts (draft), which owns its detection.
 *   tvw           NO public signature exists, so TVW is never detected by bytes (see UNVERIFIED_FAMILIES).
 */
import { Gunzip } from 'fflate';
import { asciiPrefix, BoardFormatError, type BoardParser } from './common';

export const RECOGNIZER_IDS = ['allegro-brd', 'odbpp', 'ipc2581', 'gerber', 'mentor-neutral'] as const;
export type RecognizerId = (typeof RECOGNIZER_IDS)[number];
/** Capability ids that cannot be recognized by bytes because no verifiable signature is public. */
export const UNVERIFIED_FAMILIES = ['tvw'] as const;

const TEXT_SCAN_BYTES = 64 * 1024, TAIL_BYTES = 512, XML_SCAN_BYTES = 8 * 1024;
const ODB_DECOMPRESSED_CAP = 8 << 20, ODB_INPUT_CHUNK = 4096, ODB_MAX_HEADERS = 4096;

export interface Detection { id: RecognizerId; detail?: string }

const ALLEGRO_VERSIONS = new Map<number, string>([
  [0x00130000, '16.0'], [0x00130400, '16.2'], [0x00130c00, '16.4'], [0x00131000, '16.5'], [0x00131500, '16.6'],
  [0x00140400, '17.2'], [0x00140900, '17.4'], [0x00141500, '17.5'], [0x00150000, '18.0 or newer'],
]);
function allegro(data: Uint8Array): Detection | null {
  if (data.length < 0x100 || data[0xf8] !== 0x61 || data[0xf9] !== 0x6c || data[0xfa] !== 0x6c) return null;
  const magic = (new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) & 0xffffff00) >>> 0, version = ALLEGRO_VERSIONS.get(magic);
  return version ? { id: 'allegro-brd', detail: version } : null;
}

const octal = (header: Uint8Array, from: number, to: number): number => {
  const text = asciiPrefix(header.subarray(from, to), to - from).replace(/[\0 ]+$/, '').replace(/^ +/, '');
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : Number.NaN;
};
/** Entry paths from the valid ustar headers of a tar prefix; stops at the first invalid header, never reads past the prefix. */
function tarPaths(prefix: Uint8Array): string[] {
  const paths: string[] = [];
  let position = 0;
  for (let count = 0; count < ODB_MAX_HEADERS && position + 512 <= prefix.length; count++) {
    const header = prefix.subarray(position, position + 512);
    if (header.every(byte => byte === 0)) break;
    const stored = octal(header, 148, 156);
    let sum = 0;
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index];
    if (stored !== sum) break;
    const name = asciiPrefix(header.subarray(0, 100), 100).split('\0')[0], parent = asciiPrefix(header.subarray(345, 500), 155).split('\0')[0];
    paths.push(header.subarray(257, 262).every((byte, index) => byte === 'ustar'.charCodeAt(index)) && parent ? `${parent}/${name}` : name);
    const size = octal(header, 124, 136);
    if (!Number.isFinite(size)) break;
    position += 512 + Math.ceil(size / 512) * 512;
  }
  return paths;
}
/** Gunzips at most ODB_DECOMPRESSED_CAP bytes, feeding small input chunks so a bomb cannot allocate more than one chunk's expansion past the cap. */
function gunzipPrefix(data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const gunzip = new Gunzip(chunk => { const room = ODB_DECOMPRESSED_CAP - total; if (room > 0) { chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk.slice()); total += Math.min(room, chunk.length); } });
    for (let offset = 0; offset < data.length && total < ODB_DECOMPRESSED_CAP; offset += ODB_INPUT_CHUNK) gunzip.push(data.subarray(offset, offset + ODB_INPUT_CHUNK), offset + ODB_INPUT_CHUNK >= data.length);
  } catch { /* A damaged or truncated tail does not matter: only the prefix is inspected. */ }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
const ODB_PATH = /^(?:\.\/)?(?:[^/]+\/)?(?:matrix\/(?:matrix)?|steps\/[^/]+\/)/;
function odbpp(data: Uint8Array): Detection | null {
  if (data.length < 20 || data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 0x08) return null;
  const paths = tarPaths(gunzipPrefix(data));
  return paths.some(path => ODB_PATH.test(path)) ? { id: 'odbpp', detail: `${paths.length} tar entries inspected` } : null;
}

// Linear time, and every step has one way to match. A comment is "<!--", text in which no run of two or more dashes is followed by
// ">" (a single dash may be: "->" is plain text), then a run of two or more dashes and ">": it ends at its first "-->", as in XML.
// The text is split into runs of non-dashes and runs of dashes, so there is no lookahead and no split point for the engine to
// backtrack over, however many comments precede the root; a trailing comment run belongs to the DOCTYPE group.
const IPC_ROOT = /^(?:\uFEFF|\xEF\xBB\xBF)?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[^-]*(?:-[^-]+|--+[^->][^-]*)*--+>\s*)*(?:<!DOCTYPE[^>]*>\s*(?:<!--[^-]*(?:-[^-]+|--+[^->][^-]*)*--+>\s*)*)?<IPC-2581(?=[\s/>])([^>]*)>/;
function ipc2581(head: string): Detection | null {
  const match = IPC_ROOT.exec(head.slice(0, XML_SCAN_BYTES));
  if (!match) return null;
  const revision = /\brevision\s*=\s*["']([A-Za-z0-9._-]{1,8})["']/.exec(match[1])?.[1];
  return { id: 'ipc2581', detail: revision };
}

const GERBER_FORMAT = /%FS[LT][AI]X\d\dY\d\d\*%/, GERBER_UNITS = /%MO(MM|IN)\*%/;
const GERBER_SECOND = /%MO(?:MM|IN)\*%|%ADD\d{2,}[A-Za-z]|%TF\.[A-Za-z]|^G04[ \t].*\*|^M02\*/m;
function gerber(head: string, tail: string): Detection | null {
  if (!GERBER_FORMAT.test(head) || !GERBER_SECOND.test(head + '\n' + tail)) return null;
  return { id: 'gerber', detail: GERBER_UNITS.exec(head)?.[1] };
}

const GENCAD_GUARD = /^\s*\$HEADER\b|^\s*GENCAD\s/im;
function mentorNeutral(head: string): Detection | null {
  const lines = head.slice(0, 4096).replace(/^\uFEFF|^\xEF\xBB\xBF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 4);
  return /^#\s*file\s*:/i.test(lines[0] ?? '') && lines.slice(1).some(line => /^#\s*date\s*:/i.test(line)) ? { id: 'mentor-neutral' } : null;
}

/** Pure detection; returns the first matching family or null. GenCAD files are never reported as Mentor. */
export function detectUnsupported(data: Uint8Array): Detection | null {
  if (!(data instanceof Uint8Array) || data.length < 8) return null;
  const binary = allegro(data) ?? odbpp(data);
  if (binary) return binary;
  const head = asciiPrefix(data, TEXT_SCAN_BYTES);
  if (head.slice(0, 1024).includes('\0')) return null; // every remaining family is text
  const xml = ipc2581(head);
  if (xml) return xml;
  const tail = data.length > TEXT_SCAN_BYTES ? asciiPrefix(data.subarray(data.length - TAIL_BYTES), TAIL_BYTES) : '';
  const rs274x = gerber(head, tail);
  if (rs274x) return rs274x;
  if (GENCAD_GUARD.test(head)) return null;
  return mentorNeutral(head);
}

// i18n: pending — English diagnostics with a stable code and capability id.
const EXPLANATIONS: Record<RecognizerId, (detail?: string) => string> = {
  'allegro-brd': detail => `Cadence Allegro native board database (.brd, format ${detail ?? 'unknown version'}) detected. It is a proprietary binary database that TRACE does not read. Export a GenCAD file from Allegro, or use Cadence's own viewer.`,
  odbpp: () => 'ODB++ job archive detected (gzip tar with matrix/steps entries). TRACE does not import ODB++: multi-file archive import is not implemented. Export GenCAD or another supported boardview format.',
  ipc2581: detail => `IPC-2581 XML${detail ? ` (revision ${detail})` : ''} detected. TRACE does not import IPC-2581 yet; no components, nets or geometry were read. Export GenCAD or another supported boardview format.`,
  gerber: detail => `Gerber RS-274X layer detected${detail ? ` (units: ${detail === 'MM' ? 'millimeters' : 'inches'})` : ''}. A single Gerber layer is drawing geometry only: it has no components, pins or nets, so it cannot be shown as a boardview.`,
  'mentor-neutral': () => 'Mentor Graphics neutral file (# file / # date header) detected. TRACE recognizes it but has no validated reader for this format. Export GenCAD or another supported boardview format.',
};
export const explainUnsupported = (detection: Detection): string => EXPLANATIONS[detection.id](detection.detail);

/** Registered last in the dispatcher: throws UNSUPPORTED_VARIANT for recognized-but-unsupported families, otherwise null. */
export const recognizeUnsupported: BoardParser = input => {
  const detection = detectUnsupported(input.data);
  if (detection) throw new BoardFormatError(explainUnsupported(detection), 'UNSUPPORTED_VARIANT', detection.id);
  return null;
};
