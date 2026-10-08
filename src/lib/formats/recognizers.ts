/*
 * Original TRACE module (MIT). Byte-level detection of board families TRACE cannot open, so the user gets a precise
 * explanation instead of a generic "unrecognized" error. A recognizer NEVER returns a Board: it throws
 * BoardFormatError(message, 'UNSUPPORTED_VARIANT', <capability id of FORMAT_CAPABILITIES>) or returns null.
 * Every scan is bounded: at most 64 KiB of text (+ the last 512 bytes for Gerber).
 *
 * Signature provenance (all conservative; a file that does not match stays "unrecognized"):
 *   allegro-brd   KiCad developer documentation (dev-docs.kicad.org/en/import-formats/allegro): 4-byte magic at offset 0 whose lower
 *                 byte is masked (documented values 0x00130000 ... 0x00150000 = Allegro 16.0 ... 18.0+), and the string "all" at
 *                 offset 0xF8, which that documentation calls the importer's validity check. Pre-16 databases and the "vie" marker
 *                 that the capability table once mentioned are NOT documented anywhere found, so they are not recognized.
 *   gerber        RS-274X: a mandatory %FS...X..Y..*% format statement plus a second marker (%MO, %AD, %TF, G04 comment, M02*).
 *   ipc2581       XML whose root element is <IPC-2581> (XML declaration, comments and DOCTYPE may precede it).
 *   mentor-neutral '# file :' and '# date :' comment lines at the top; that header is the only public example found (a vendor help page),
 *                 not a specification.
 *   samsung-cad   no longer a recognizer: the family is read by samsung-cad.ts (draft), which owns its detection.
 *   tvw           the experimental reader owns structural detection (tvw.ts); there is no fixed byte-zero magic.
 */
import { asciiPrefix, BoardFormatError, type BoardParser } from './common';

export const RECOGNIZER_IDS = ['allegro-brd', 'gerber', 'mentor-neutral'] as const;
export type RecognizerId = (typeof RECOGNIZER_IDS)[number];
/** Capability ids that cannot be recognized by bytes because no verifiable signature is public. */
export const UNVERIFIED_FAMILIES = [] as const;

const TEXT_SCAN_BYTES = 64 * 1024, TAIL_BYTES = 512, XML_SCAN_BYTES = 8 * 1024;

export interface Detection { id: RecognizerId; detail?: string }

const ALLEGRO_VERSIONS = new Map<number, string>([
  [0x00130000, '16.0'], [0x00130400, '16.2'], [0x00130c00, '16.4'], [0x00131000, '16.5'], [0x00131500, '16.6'],
  [0x00140400, '17.2'], [0x00140900, '17.4'], [0x00141500, '17.5'], [0x00150000, '18.0 or newer'],
]);
export function allegro(data: Uint8Array): Detection | null {
  if (data.length < 0x100 || data[0xf8] !== 0x61 || data[0xf9] !== 0x6c || data[0xfa] !== 0x6c) return null;
  const magic = (new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) & 0xffffff00) >>> 0, version = ALLEGRO_VERSIONS.get(magic);
  return version ? { id: 'allegro-brd', detail: version } : null;
}

// Linear time, and every step has one way to match. A comment is "<!--", text in which no run of two or more dashes is followed by
// ">" (a single dash may be: "->" is plain text), then a run of two or more dashes and ">": it ends at its first "-->", as in XML.
// The text is split into runs of non-dashes and runs of dashes, so there is no lookahead and no split point for the engine to
// backtrack over, however many comments precede the root; a trailing comment run belongs to the DOCTYPE group.
const IPC_ROOT = /^(?:\uFEFF|\xEF\xBB\xBF)?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[^-]*(?:-[^-]+|--+[^->][^-]*)*--+>\s*)*(?:<!DOCTYPE[^>]*>\s*(?:<!--[^-]*(?:-[^-]+|--+[^->][^-]*)*--+>\s*)*)?<IPC-2581(?=[\s/>])([^>]*)>/;
export function ipc2581(head: string): { id: 'ipc2581'; detail?: string } | null {
  const match = IPC_ROOT.exec(head.slice(0, XML_SCAN_BYTES));
  if (!match) return null;
  const revision = /\brevision\s*=\s*["']([A-Za-z0-9._-]{1,8})["']/.exec(match[1])?.[1];
  return { id: 'ipc2581', detail: revision };
}

export const GERBER_FORMAT = /%FS[LT][AI]X\d\dY\d\d\*%/, GERBER_UNITS = /%MO(MM|IN)\*%/;
export const GERBER_SECOND = /%MO(?:MM|IN)\*%|%ADD\d{2,}[A-Za-z]|%TF\.[A-Za-z]|^G04[ \t].*\*|^M02\*/m;
function gerber(head: string, tail: string): Detection | null {
  if (!GERBER_FORMAT.test(head) || !GERBER_SECOND.test(head + '\n' + tail)) return null;
  return { id: 'gerber', detail: GERBER_UNITS.exec(head)?.[1] };
}

// The blank before a keyword is horizontal: `^\s*` crossed line breaks, so a head of blank or space-only lines was retried from every line
// start (quadratic: about 6 s for 64 KiB). A keyword that follows only blanks on its own line is found by both; the verdict is the same.
export const GENCAD_GUARD = /^[^\S\n\r\u2028\u2029]*(?:\$HEADER\b|GENCAD\s)/im;
export function mentorNeutral(head: string): Detection | null {
  const lines = head.slice(0, 4096).replace(/^\uFEFF|^\xEF\xBB\xBF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 4);
  return /^#\s*file\s*:/i.test(lines[0] ?? '') && lines.slice(1).some(line => /^#\s*date\s*:/i.test(line)) ? { id: 'mentor-neutral' } : null;
}

/** Pure detection; returns the first matching family or null. GenCAD files are never reported as Mentor. */
export function detectUnsupported(data: Uint8Array): Detection | null {
  if (!(data instanceof Uint8Array) || data.length < 8) return null;
  const binary = allegro(data);
  if (binary) return binary;
  const head = asciiPrefix(data, TEXT_SCAN_BYTES);
  if (head.slice(0, 1024).includes('\0')) return null; // every remaining family is text

  const tail = data.length > TEXT_SCAN_BYTES ? asciiPrefix(data.subarray(data.length - TAIL_BYTES), TAIL_BYTES) : '';
  const rs274x = gerber(head, tail);
  if (rs274x) return rs274x;
  if (GENCAD_GUARD.test(head)) return null;
  return mentorNeutral(head);
}

// i18n: pending — English diagnostics with a stable code and capability id.
const EXPLANATIONS: Record<RecognizerId, (detail?: string) => string> = {
  'allegro-brd': detail => `Cadence Allegro native board database (.brd, format ${detail ?? 'unknown version'}) detected. It is a proprietary binary database that TRACE does not read. Export a GenCAD file from Allegro, or use Cadence's own viewer.`,
  gerber: detail => `Gerber RS-274X layer detected${detail ? ` (units: ${detail === 'MM' ? 'millimeters' : 'inches'})` : ''}. A single Gerber layer is drawing geometry only: it has no components, pins or nets, so it cannot be shown as a boardview.`,
  'mentor-neutral': () => 'Mentor Graphics neutral file (# file / # date header) detected. TRACE recognizes it but has no validated reader for this format. Export GenCAD or another supported boardview format.',
};
export const explainUnsupported = (detection: Detection): string => EXPLANATIONS[detection.id](detection.detail);

/** Throws UNSUPPORTED_VARIANT for recognized-but-unsupported families, otherwise null. */
export const recognizeUnsupported: BoardParser = input => {
  const detection = detectUnsupported(input.data);
  if (detection) throw new BoardFormatError(explainUnsupported(detection), 'UNSUPPORTED_VARIANT', detection.id);
  return null;
};
/** The parse of one family's adapter (adapters/<id>/): refuses the bytes when the recognizers name exactly that family, otherwise declines. */
export const refuseFamily = (id: RecognizerId): BoardParser => input => {
  const detection = detectUnsupported(input.data);
  if (detection?.id === id) throw new BoardFormatError(explainUnsupported(detection), 'UNSUPPORTED_VARIANT', detection.id);
  return null;
};
