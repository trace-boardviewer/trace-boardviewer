/** FZ (ASUS) and CAE (ASRock) boardview adapter, based on OpenBoardView FZFile.cpp / CAEFile.cpp.
 * Copyright (c) 2016 Chloridite and OpenBoardView contributors, MIT.
 * Container framing reference: OpenBoardView commit cc76e697c85efd2285134dfe2df0b7809e4a49d0,
 * https://github.com/OpenBoardView/OpenBoardView/blob/cc76e697c85efd2285134dfe2df0b7809e4a49d0/src/openboardview/FileFormats/FZFile.cpp
 *
 * Format facts: an RC6-feedback encrypted container (44 expanded key words) holding two
 * zlib blobs, content and description. The content is a Cadence Allegro style extract: `A!` header lines open a block
 * (REFDES parts, NET_NAME pins, TESTVIA nails), `S!` rows carry `!`-delimited fields. Coordinates are absolute board
 * coordinates in thou (0.001") unless a `UNIT:millimeters` line is present; upstream multiplies mm values by 25.4 to reach
 * its mil world, which is the wrong direction (1 mm = 39.37 mil) - this adapter uses the physical factor instead.
 * CAE differs from FZ only in the key (its parity table) and the extension.
 */
import type { Board, BoardSide, ParseIssue } from '../types';
import { asciiPrefix, BoardFormatError, buildBoard, decodeText, MAX_IMPORT_BYTES, note, vendorDisconnected, type FormatErrorCode, type ParseInput, type RawBoard, type RawPart, type RawPin } from './common';
import { inflateZlib } from './compression';
import { fzKeyParityValid, rc6Feedback } from './crypto';
import { CAE_DEFAULT_KEY, FZ_DEFAULT_KEY } from './fz-default-keys';

const MIL = 0.0254;
const MAX_DESCRIPTION_BYTES = 16 * 1024 * 1024;
const MIN_ZLIB = 6; // 2-byte header + 4-byte Adler-32
const MAX_PARTS = 250_000, MAX_PINS = 1_000_000; // the same record budgets buildBoard enforces, applied while reading
const BLOCKS: Record<string, number> = { REFDES: 1, NET_NAME: 2, TESTVIA: 3, GRAPHIC_DATA_NAME: 4, CLASS: 5, LOGOInfo: 6, UnDrawSym: 7 };
type Variant = 'fz' | 'cae';
interface Container { content: Uint8Array; description: Uint8Array; contentBytes?: number; descriptionBytes?: number; layout: number }

const zlibHeaderAt = (data: Uint8Array, offset: number) =>
  offset + MIN_ZLIB <= data.length && (data[offset] & 15) === 8 && data[offset] >>> 4 <= 7 && ((data[offset] << 8) | data[offset + 1]) % 31 === 0 && !(data[offset + 1] & 32);
/** A plaintext-container clue at its fixed offset, shared by the bounded sniffer and parser; the complete framing and streams still need validation. */
export const hasFzZlibHeader = (data: Uint8Array): boolean => zlibHeaderAt(data, 4);
/** A bounded clue using the variant's published default key; full framing/checksums remain mandatory. */
export const hasFzDefaultKeyHeader = (data: Uint8Array, variant: Variant): boolean => hasFzZlibHeader(rc6Feedback(data.subarray(0, 4 + MIN_ZLIB), variant === 'cae' ? CAE_DEFAULT_KEY : FZ_DEFAULT_KEY));
/** Plain text rather than ciphertext: the leading bytes are valid UTF-8 without control characters (random bytes fail this almost surely, even for a 20-byte file). */
export function looksLikeText(data: Uint8Array): boolean {
  if (!data.length) return false;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, 4096), { stream: true }); } catch { return false; }
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text);
}
/** decodeText sniffs byte-order marks and throws a TypeError for invalid UTF-16; inflated bytes are untrusted, so that becomes a format error. */
function inflatedText(bytes: Uint8Array): string {
  try { return decodeText(bytes); }
  catch (error) { if (error instanceof BoardFormatError) throw error; throw new BoardFormatError('the decompressed text is not valid.', 'INVALID_FORMAT', 'FZ/CAE'); }
}

/**
 * Splits the decoded container `[u32 contentLength][content zlib][u32 descriptionLength]?[description zlib][u32 footer]`.
 * The footer is accepted as either the description blob length or, as FZFile::split() arithmetic implies
 * (description starts at size - footer + 4), blob length + 8 framing bytes. Every candidate must account for the total size
 * exactly and both blobs must start with a zlib header; nothing is searched. Upstream's footer-framed spelling does
 * not interpret the first four bytes as a content length, so it is also accepted with an opaque leading word.
 * Real FZ containers use that word as the inflated content size and put two size words between the streams:
 * `[u32 inflatedContent][content zlib][u32 contentZlib+8][u32 inflatedDescription][description zlib][u32 descriptionZlib+8]`.
 */
export function splitFzContainer(data: Uint8Array): Container | undefined {
  const size = data.length;
  if (size < 4 + MIN_ZLIB + MIN_ZLIB + 4) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const contentLength = view.getUint32(0, true), footer = view.getUint32(size - 4, true);
  if (!hasFzZlibHeader(data)) return undefined;
  if (contentLength >= MIN_ZLIB && 4 + contentLength + MIN_ZLIB + 4 <= size) {
    for (const prefixed of [false, true]) {
      const start = 4 + contentLength + (prefixed ? 4 : 0), length = size - 4 - start;
      if (length < MIN_ZLIB) continue;
      if (prefixed && view.getUint32(4 + contentLength, true) !== length) continue;
      if (footer !== length && footer !== length + 8) continue;
      if (!zlibHeaderAt(data, start)) continue;
      return { content: data.subarray(4, 4 + contentLength), description: data.subarray(start, start + length), layout: (prefixed ? 2 : 1) + (footer === length + 8 ? 2 : 0) };
    }
  }
  // FZFile::split derives this offset from the footer alone and skips the leading word. Preserve its exact arithmetic,
  // but exclude the footer from the description stream and require both compressed streams to consume their slices.
  const descriptionLength = footer - 8, start = size - footer + 4;
  if (descriptionLength >= MIN_ZLIB && start >= 4 + MIN_ZLIB && start + descriptionLength === size - 4 && zlibHeaderAt(data, start)) {
    if (start >= 4 + MIN_ZLIB + 8 && view.getUint32(start - 8, true) === start - 4) {
      return { content: data.subarray(4, start - 8), description: data.subarray(start, size - 4), contentBytes: contentLength, descriptionBytes: view.getUint32(start - 4, true), layout: 6 };
    }
    return { content: data.subarray(4, start), description: data.subarray(start, size - 4), layout: 5 };
  }
  return undefined;
}

/** Parses the decoded content text (and the optional tab-separated description table) into source-unit geometry. */
export function parseFzContent(content: string, description: string | undefined, format: string): RawBoard {
  function fail(message: string, code: FormatErrorCode = 'INVALID_FORMAT'): never { throw new BoardFormatError(`${format}: ${message}`, code, 'FZ/CAE'); }
  // Numbers may use a decimal comma in some regional exports (upstream rewrites ',' to '.' globally). Only plain decimal
  // notation is accepted: Number() would also read hex/binary/octal prefixes and "Infinity".
  const decimal = (value: string | undefined, label: string, line: number): number => {
    const text = (value ?? '').trim().replace(',', '.');
    const result = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : NaN;
    return Number.isFinite(result) ? result : fail(`invalid ${label} on line ${line}: ${text.slice(0, 40) || '(empty)'}.`);
  };
  const optionalDecimal = (value: string | undefined, label: string, line: number) => value === undefined || !value.trim() ? undefined : decimal(value, label, line);
  // B06: UNCONNECTED<n> is the exporter's "no net" placeholder (BRDBoard.cpp), never a shared electrical net.
  let disconnected = 0;
  const netOf = (value: string | undefined): string | undefined => {
    const name = value?.trim();
    if (!name) return undefined;
    if (vendorDisconnected(name)) { disconnected++; return undefined; }
    return name;
  };
  const parts = new Map<string, RawPart>(), ordered: RawPart[] = [], pins: RawPin[] = [];
  let block = 0, unitsToMm = MIL, nails = 0, radii = 0, unknownUnit: string | undefined;
  const lines = content.split(/\r\n|\n|\r/);
  if (lines.length > 4_000_000) fail('too many lines.');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim(), lineNumber = index + 1;
    if (!line) continue;
    if (line.startsWith('UNIT:')) {
      const unit = line.slice(5).trim().toLowerCase();
      if (unit === 'millimeters') unitsToMm = 1;
      else if (unit === 'thou' || unit === 'mil' || unit === 'mils') unitsToMm = MIL;
      else unknownUnit ??= line.slice(0, 40); // upstream knows only millimeters; anything else stays thou, but never silently
      continue;
    }
    if (line.startsWith('A!')) {
      const header = line.slice(2);
      block = Object.entries(BLOCKS).find(([name]) => header.startsWith(name))?.[1] ?? -1;
      continue;
    }
    if (!line.startsWith('S!')) continue;
    const fields = line.slice(2).split('!').map(field => field.trimStart());
    if (block === 1) {
      // REFDES ! COMP_INSERTION_CODE ! SYM_NAME ! SYM_MIRROR ! SYM_ROTATE
      const ref = fields[0]?.trim();
      if (!ref) fail(`empty REFDES on line ${lineNumber}.`);
      if (parts.has(ref)) fail(`duplicate REFDES ${ref} on line ${lineNumber}.`);
      const side: BoardSide = fields[3]?.trim() === 'YES' ? 'bottom' : 'top';
      // Internal identities are typed by prefix: source REFDES text ("r:") can never equal a generated test-via part ("t:").
      const part: RawPart = { key: `r:${ref}`, ref, side, ...(fields[2]?.trim() ? { package: fields[2].trim() } : {}) };
      parts.set(ref, part); ordered.push(part);
      if (ordered.length > MAX_PARTS) fail(`more than ${MAX_PARTS} components.`, 'LIMIT_EXCEEDED');
    } else if (block === 2) {
      // NET_NAME ! REFDES ! PIN_NUMBER ! PIN_NAME ! PIN_X ! PIN_Y ! TEST_POINT ! RADIUS
      const ref = fields[1]?.trim() ?? '', parent = parts.get(ref);
      if (!parent) fail(`pin on line ${lineNumber} references unknown component ${ref || '(empty)'}.`);
      const number = fields[2]?.trim() ?? '', name = fields[3]?.trim() ?? '';
      // Some exports put the position id in PIN_NAME and a literal 0 in PIN_NUMBER (upstream variant 2).
      const pinNumber = (number === '' || number === '0') && name ? name : number;
      if (!pinNumber) fail(`pin without number on line ${lineNumber}.`);
      const radius = optionalDecimal(fields[7], 'pin radius', lineNumber);
      if (radius !== undefined) { if (radius < 0) fail(`negative pin radius on line ${lineNumber}.`); radii++; }
      pins.push({
        part: parent.key, number: pinNumber, name: name || pinNumber, net: netOf(fields[0]), side: parent.side,
        x: decimal(fields[4], 'pin X', lineNumber), y: decimal(fields[5], 'pin Y', lineNumber), ...(radius === undefined ? {} : { radius }),
      });
      if (pins.length > MAX_PINS) fail(`more than ${MAX_PINS} pins.`, 'LIMIT_EXCEEDED');
    } else if (block === 3) {
      // TESTVIA flag ! NET_NAME ! REFDES ! PIN_NUMBER ! PIN_NAME ! X ! Y ! LOCATION (T = top) ! RADIUS
      const key = `t:${++nails}`, side: BoardSide = fields[7]?.trim() === 'T' ? 'top' : 'bottom';
      const x = decimal(fields[5], 'test via X', lineNumber), y = decimal(fields[6], 'test via Y', lineNumber);
      const radius = optionalDecimal(fields[8], 'test via radius', lineNumber);
      if (radius !== undefined && radius < 0) fail(`negative test via radius on line ${lineNumber}.`);
      const number = fields[3]?.trim() || '1', name = fields[4]?.trim() || number;
      const part: RawPart = { key, ref: `TP:${nails}`, package: 'TESTVIA', side, position: { x, y } };
      ordered.push(part);
      if (ordered.length > MAX_PARTS || pins.length >= MAX_PINS) fail('record count exceeds the import limit.', 'LIMIT_EXCEEDED');
      pins.push({ part: key, number, name, net: netOf(fields[1]), side, x, y, ...(radius === undefined ? {} : { radius }) });
    }
  }
  if (block === 0) fail('no A! block headers were found in the decoded content.');
  if (description) {
    // Tab-separated rows after two header lines: PARTNO, DESCRIPTION, QUANTITY, LOCATIONS (space separated REFDES list), PARTNO2.
    const rows = description.split(/\r\n|\n|\r/);
    for (let index = 2; index < rows.length; index++) {
      const row = rows[index].replace(/^[ \f\v]+/, '');
      if (!row.trim() || row.startsWith('s')) continue;
      const fields = row.split('\t');
      const value = fields[1]?.trim();
      if (!value) continue;
      for (const location of (fields[3] ?? '').trim().split(/\s+/)) {
        const part = parts.get(location);
        if (part && part.value === undefined) part.value = value;
      }
    }
  }
  const warnings: ParseIssue[] = [];
  if (unknownUnit) warnings.push(note(`${format}: unrecognized unit line "${unknownUnit}"; coordinates are read as thou (0.001 inch).`));
  if (disconnected) warnings.push(note(`${disconnected} ${disconnected === 1 ? 'pin' : 'pins'} marked UNCONNECTED by the exporter ${disconnected === 1 ? 'is' : 'are'} shown without a net.`));
  if (radii) warnings.push({ key: 'parse.warning.formatNote', params: { message: `${format}: the RADIUS column is used as pad radius in file units; OpenBoardView instead divides it by 100 and clamps it, which has not been verified against a vendor file.` } });
  // FZFile.cpp keeps a REFDES that owns no pin (mounting hole, logo, fiducial); this format gives it neither a position nor a body, so it cannot be drawn.
  // It is omitted and disclosed instead of rejecting the whole file (same English wording as the BDV/ASC/BVR1/BRD note).
  const owners = new Set(pins.map(pin => pin.part)), drawable = ordered.filter(part => owners.has(part.key)), omitted = ordered.length - drawable.length;
  // i18n: pending
  if (omitted) warnings.push(note(`${omitted} ${omitted === 1 ? 'component' : 'components'} without pins ${omitted === 1 ? 'was' : 'were'} omitted because the file gives no position for ${omitted === 1 ? 'it' : 'them'}.`));
  return { format, parts: drawable, pins, unitsToMm, warnings };
}

function inflateContainer(container: Container, onError: (error: BoardFormatError) => never): { content: string; description: string } {
  try {
    const content = inflateZlib(container.content), description = inflateZlib(container.description, MAX_DESCRIPTION_BYTES);
    if ((container.contentBytes !== undefined && container.contentBytes !== content.length) || (container.descriptionBytes !== undefined && container.descriptionBytes !== description.length)) {
      throw new BoardFormatError('the declared decompressed lengths do not match the compressed streams.', 'INVALID_FORMAT', 'FZ/CAE');
    }
    return { content: inflatedText(content), description: inflatedText(description) };
  } catch (error) {
    if (error instanceof BoardFormatError && error.code !== 'LIMIT_EXCEEDED') onError(error);
    throw error;
  }
}

export const CONTENT_SIGNATURE = /^(?:\xef\xbb\xbf)?\s*(?:A!|UNIT:)/;

/**
 * Recognition is by extension (.fz / .cae), as upstream: encrypted content carries no magic, so a file is only accepted once
 * its (decrypted) container, both zlib streams and the A!/S! content have validated. FZ and CAE each use a published default
 * key; an explicit user key overrides it. Unsupported key variants retain the session-key error path.
 */
export function parseFz(input: ParseInput): Board | null {
  const match = /\.(fz|cae)$/i.exec(input.name);
  if (!match) return null;
  const variant = match[1].toLowerCase() as Variant, format = variant === 'cae' ? 'CAE' : 'FZ (RC6)';
  const { data } = input;
  if (data.length > MAX_IMPORT_BYTES) throw new BoardFormatError(`${format}: file exceeds the 64 MiB import limit.`, 'LIMIT_EXCEEDED', 'FZ/CAE');
  // keyKind travels only with key errors: the UI opens its key dialog on these two codes and nothing else.
  function fail(message: string, code: FormatErrorCode = 'INVALID_FORMAT'): never {
    throw new BoardFormatError(`${format}: ${message}`, code, 'FZ/CAE', code === 'KEY_REQUIRED' || code === 'INVALID_KEY' ? 'fz' : undefined);
  }
  if (CONTENT_SIGNATURE.test(asciiPrefix(data, 64))) return buildBoard(input, parseFzContent(decodeText(data), undefined, format)); // already decoded content (upstream only reads containers)
  if (looksLikeText(data)) return null; // any other text belongs to another format
  if (data.length < 4 + MIN_ZLIB + MIN_ZLIB + 4) fail('file is too short to be an FZ container.');
  if (hasFzZlibHeader(data)) {
    // Unencrypted container variant ("zip-encoded" files noted by upstream): never decrypted. A zlib header at the fixed
    // offset is evidence of it; the complete framing and both checksums must validate before any board is imported.
    const container = splitFzContainer(data) ?? fail('unencrypted container lengths are inconsistent.');
    const { content, description } = inflateContainer(container, error => fail(`unencrypted container: ${error.message}`));
    return buildBoard(input, parseFzContent(content, description, format));
  }
  const explicitKey = input.options?.fzKey;
  const key = explicitKey ?? (variant === 'cae' ? CAE_DEFAULT_KEY : FZ_DEFAULT_KEY);
  if (!Array.isArray(key) || key.length !== 44 || key.some(word => !Number.isInteger(word) || word < 0 || word > 0xffffffff)) fail('the key must contain 44 unsigned 32-bit words.', 'INVALID_KEY');
  // The ASRock CAE key publication says not to apply ASUS parity restrictions (OpenBoardView issue 162).
  // CAE still validates all 44 uint32 words, the decrypted framing, both Adler-32 checksums and the board records.
  if (variant === 'fz' && !fzKeyParityValid(key, variant)) fail('the key does not match the FZ key parity pattern (a word is mistyped).', 'INVALID_KEY');
  // The feedback cipher is a prefix function of the ciphertext: check the first block header before paying for the whole file (about 4 s per 16 MiB).
  const head = rc6Feedback(data.subarray(0, 4 + MIN_ZLIB), key);
  // Without a session key only the built-in key was tried: when it does not open the file the user has to supply the key
  // (KEY_REQUIRED). Once the built-in key has produced the container header, a later failure means the file is damaged.
  if (!hasFzZlibHeader(head)) {
    if (explicitKey === undefined) fail('this file is encrypted and the built-in key does not open it; the vendor RC6 key (44 32-bit words) is required.', 'KEY_REQUIRED');
    fail('the key did not produce a valid container; check the key.', 'INVALID_KEY');
  }
  const damaged = (message: string, keyMessage: string): never => explicitKey === undefined ? fail(message) : fail(keyMessage, 'INVALID_KEY');
  const container = splitFzContainer(rc6Feedback(data, key)) ?? damaged('the container opened with the built-in key is inconsistent.', 'the key did not produce a valid container; check the key.');
  const { content, description } = inflateContainer(container, () => damaged('the compressed content opened with the built-in key is damaged.', 'the key did not produce valid compressed content; check the key.'));
  return buildBoard(input, parseFzContent(content, description, format));
}
