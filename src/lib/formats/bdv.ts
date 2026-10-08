/*
 * Honhan BDV reader plus the ASC record dialect it shares with the ASC companion trio and (partly) BVR.
 * Section markers, header lengths, record layouts and the evolving-key encoding follow OpenBoardView's
 * BDVFile.cpp, ASCFile.cpp and BVRFile.cpp (MIT, Copyright (c) 2016 Chloridite and OpenBoardView contributors;
 * see assets/licenses/openboardview-MIT.txt). The code below is original.
 */
import type { Board, BoardSide, ParseIssue, Point } from '../types';
import { BoardFormatError, buildBoard, decodeText, MAX_IMPORT_BYTES, note, vendorDisconnected, type FormatErrorCode, type ParseInput, type RawBoard, type RawPart, type RawPin } from './common';

/** Every coordinate of BDV, ASC and BVRAW_FORMAT_1 is in inches (OpenBoardView multiplies by 1000 to get mil). */
export const INCH = 25.4;
export const BDV_FORMAT = 'Honhan BDV';
/** Mirror the common.buildBoard budgets so a hostile file fails before large arrays exist. */
export const MAX_PARTS = 250_000, MAX_PINS = 1_000_000, MAX_OUTLINE_POINTS = 200_000;
export const MAX_LINE = 1 << 22;

export interface Source { label: string; format: string }
export function reject(source: Source, line: number | undefined, message: string, code: FormatErrorCode = 'INVALID_FORMAT'): never {
  throw new BoardFormatError(`${source.label}${line === undefined ? '' : ` line ${line}`}: ${message}`, code, source.format);
}

// strtod also accepts "inf", "nan" and hex floats; a boardview coordinate never is one, so reject them instead of guessing.
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
export function decimal(source: Source, line: number, token: string | undefined, label: string): number {
  const value = token !== undefined && DECIMAL.test(token) ? Number(token) : NaN;
  if (!Number.isFinite(value)) reject(source, line, `invalid ${label}${token === undefined ? '' : ` "${token.slice(0, 40)}"`}.`);
  return value;
}
export function integer(source: Source, line: number, token: string | undefined, label: string, signed = false): number {
  const value = token !== undefined && /^[+-]?\d{1,15}$/.test(token) ? Number(token) : NaN;
  if (!Number.isSafeInteger(value) || !signed && value < 0) reject(source, line, `invalid ${label}${token === undefined ? '' : ` "${token.slice(0, 40)}"`}.`);
  return value;
}

/** buildBoard errors carry no format name; the UI shows it, so attach it. */
export function build(input: ParseInput, source: Source, raw: RawBoard): Board {
  try { return buildBoard(input, raw); }
  catch (error) {
    if (error instanceof BoardFormatError && !error.format) throw new BoardFormatError(error.message, error.code, source.format);
    throw error;
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** Counters behind the English format notes (parser diagnostics, not catalog strings). */
export class Tally {
  unconnected = 0; unknownSides = 0; defaultedSides = 0; emptyParts = 0; strayLines = 0; repeatedRefs = 0; abbreviatedProbes = 0; markedProbes = 0; unlocatedPins = 0;
  readonly ignoredSections: string[] = [];
  readonly extra: string[] = [];
  /** B06: UNCONNECTED<n> is the exporter's "no net" placeholder, never an electrical net. */
  net(name: string): string {
    if (!vendorDisconnected(name)) return name;
    this.unconnected++; return '';
  }
  /** OpenBoardView: exactly "(T)" is top, everything else is bottom. Markers other than "(B)" are counted and disclosed. */
  side(token: string): BoardSide {
    if (token === '(T)') return 'top';
    if (token !== '(B)') this.unknownSides++;
    return 'bottom';
  }
  // i18n: pending
  issues(): ParseIssue[] {
    const messages: string[] = [];
    const n = (count: number) => count === 1;
    if (this.unconnected) messages.push(`${plural(this.unconnected, 'pin', 'pins')} marked UNCONNECTED by the exporter ${n(this.unconnected) ? 'is' : 'are'} shown without a net.`);
    if (this.unknownSides) messages.push(`${plural(this.unknownSides, 'record has', 'records have')} a side marker other than (T) or (B) and ${n(this.unknownSides) ? 'is' : 'are'} placed on the bottom side, as OpenBoardView does.`);
    if (this.defaultedSides) messages.push(`${plural(this.defaultedSides, 'record has', 'records have')} no side field and ${n(this.defaultedSides) ? 'is' : 'are'} shown on both sides, as OpenBoardView does.`);
    if (this.emptyParts) messages.push(`${plural(this.emptyParts, 'component', 'components')} without pins ${n(this.emptyParts) ? 'was' : 'were'} omitted because the file gives no position for ${n(this.emptyParts) ? 'it' : 'them'}.`);
    if (this.repeatedRefs) messages.push(`${plural(this.repeatedRefs, 'component reuses', 'components reuse')} a reference designator that another component already has; all are kept as separate components.`);
    if (this.abbreviatedProbes) messages.push(`${this.abbreviatedProbes} probe lists end in an ellipsis; their omitted probe annotations do not change pin positions or nets.`);
    if (this.markedProbes) messages.push(`${this.markedProbes} probe annotations have a marker before their numeric id; the annotations do not change pin positions or nets.`);
    if (this.unlocatedPins) messages.push(`${this.unlocatedPins} pin records contain only an id and name, without coordinates or a net; they cannot be drawn and were omitted.`);
    if (this.ignoredSections.length) messages.push(`Sections without a documented layout were ignored: ${this.ignoredSections.slice(0, 5).join(', ')}${this.ignoredSections.length > 5 ? ', …' : ''}.`);
    if (this.strayLines) messages.push(`${plural(this.strayLines, 'non-empty line', 'non-empty lines')} outside any section ${n(this.strayLines) ? 'was' : 'were'} ignored.`);
    return [...messages, ...this.extra].map(note);
  }
}

export function splitLines(text: string, source: Source): string[] {
  // Some text exports finish with NUL padding or text sentinels on separate final lines.
  // Only that suffix is removed; embedded control bytes remain invalid record data.
  text = text.replace(/(?:\r\n|\r|\n)[\0\x02-\x04][\0\x02-\x04 \t\r\n]*$/, '\n');
  const lines = text.split(/\r\n|\r|\n/);
  const long = lines.findIndex(line => line.length > MAX_LINE);
  if (long >= 0) reject(source, long + 1, `line exceeds ${MAX_LINE} characters.`, 'LIMIT_EXCEEDED');
  return lines;
}
export interface Row { no: number; text: string }

const MARKER = /^<<[^<>]{1,64}>>$/;
/**
 * Splits a marker-delimited file ("<<name>>" lines) into the rows of the sections in `headers`, skipping each section's
 * fixed header lines. Like the reference reader the skip counts physical lines, so a marker inside a header is a
 * truncated section and is rejected rather than swallowed.
 */
export function scanSections(lines: string[], source: Source, headers: ReadonlyMap<string, number>, tally: Tally, expectedPreamble?: RegExp, firstRecords?: ReadonlyMap<string, (row: string) => boolean>): Map<string, Row[]> {
  const sections = new Map<string, Row[]>();
  let current: Row[] | null | undefined;
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index].trim();
    if (MARKER.test(text)) {
      const header = headers.get(text);
      if (header === undefined) {
        if (!tally.ignoredSections.includes(text)) tally.ignoredSections.push(text);
        current = null; continue;
      }
      if (sections.has(text)) reject(source, index + 1, `duplicate ${text} section.`);
      current = []; sections.set(text, current);
      for (let skipped = 0; skipped < header && index + 1 < lines.length; skipped++) {
        // Some Honhan exports omit their banner or shorten it. Stop only at a complete record of the current section:
        // this cannot swallow a marker, and preserves the fixed-header behavior for ASC/BVR callers.
        if (firstRecords?.get(text)?.(lines[index + 1].trim())) {
          tally.extra.push(`${text}: read a shortened section header (${skipped} of the usual ${header} lines).`);
          break;
        }
        index++;
        if (MARKER.test(lines[index].trim())) reject(source, index + 1, `${text} has fewer than its ${header} header lines.`);
      }
      continue;
    }
    if (!text) continue;
    if (current) current.push({ no: index + 1, text });
    else if (current === undefined && !expectedPreamble?.test(text)) tally.strayLines++;
  }
  return sections;
}

/** The outline is one polygon: the points of format.asc in file order. */
export function readFormat(rows: Row[], source: Source, radiusTally?: Tally): Point[] {
  if (rows.length > MAX_OUTLINE_POINTS) reject(source, undefined, 'outline point count exceeds the import limit.', 'LIMIT_EXCEEDED');
  let curved = 0, grids = 0;
  const points = rows.map(({ no, text }) => {
    const fields = text.split(/\s+/);
    if (fields.length !== 2 && !(radiusTally && fields.length === 3)) reject(source, no, 'an outline point needs two coordinates and optionally a radius.');
    // Real exports of this format add a Radius column; the reference reader consumes X/Y and leaves it unread.
    if (fields.length === 3) {
      if (/^[A-Z]\d{1,6}$/.test(fields[2])) grids++;
      else if (decimal(source, no, fields[2], 'outline radius') !== 0) curved++;
    }
    return { x: decimal(source, no, fields[0], 'outline X'), y: decimal(source, no, fields[1], 'outline Y') };
  });
  if (curved) radiusTally?.extra.push(`${curved} outline ${curved === 1 ? 'point carries' : 'points carry'} a non-zero radius; the outline is shown with straight segments, as OpenBoardView does.`);
  if (grids) radiusTally?.extra.push(`${grids} outline records carry a grid annotation; only their X/Y coordinates are used.`);
  return points;
}

export interface PendingPin { number: string; name: string; net: string; side: BoardSide; x: number; y: number }
export interface PendingPart { ref: string; side: BoardSide; pins: PendingPin[] }
const FIELD = /\S+/g;
const PROBES = /^[@*]?\d+(?:,[@*]?\d+)*(?:,|,?\.\.\.)?$/;
const MAX_PIN_ROW = 16_384;
function probeList(source: Source, no: number, token: string, tally: Tally): void {
  if (token.endsWith('...')) { tally.abbreviatedProbes++; token = token.slice(0, -3); }
  token = token.replace(/,$/, '');
  for (let value of token.split(',')) {
    if (/^[@*]\d+$/.test(value)) { tally.markedProbes++; value = value.slice(1); }
    integer(source, no, value, 'probe');
  }
}
/**
 * "Part <ref> <side>" lines open a component; every following line is one of its pins:
 * `id name X Y layer net [probe-list]`. Real exports list several comma-separated nails per pin and wraps long lists onto
 * following lines. The name is the free-text middle (such as "A 1"), so the fixed fields are taken from the end.
 * Pins take the side of their component; the layer and probe columns are validated but not used for geometry.
 */
export function readPins(rows: Row[], source: Source, tally: Tally, variantProbeLists = false): PendingPart[] {
  const parts: PendingPart[] = [];
  let pinCount = 0;
  for (const { no, text } of rows) {
    if (/^Part\s/i.test(text)) {
      const fields = text.split(/\s+/);
      if (fields.length < 3 || fields.length > 3 && !/^\([^\s()]+\)$/.test(fields.at(-1)!)) reject(source, no, 'a Part line needs a reference and a side marker.');
      if (parts.length >= MAX_PARTS) reject(source, no, 'component count exceeds the import limit.', 'LIMIT_EXCEEDED');
      parts.push({ ref: fields.slice(1, -1).join(' '), side: tally.side(fields.at(-1)!), pins: [] });
      continue;
    }
    const part = parts.at(-1);
    if (!part) reject(source, no, 'a pin record appears before the first Part line.');
    const continuation = text.replace(/^,/, '').split(/\s+/);
    if (variantProbeLists && continuation.length === 2 && /^\d+$/.test(continuation[0]) && /^\d+$/.test(continuation[1])) {
      integer(source, no, continuation[0], 'pin id');
      if (pinCount++ >= MAX_PINS) reject(source, no, 'pin count exceeds the import limit.', 'LIMIT_EXCEEDED');
      tally.unlocatedPins++; continue;
    }
    if (variantProbeLists && (continuation.length === 1 || text.includes(',') || text.endsWith('...')) && continuation.every(token => PROBES.test(token))) {
      if (!part.pins.length) reject(source, no, 'a probe-list continuation appears before the first pin.');
      for (const token of continuation) probeList(source, no, token, tally); continue;
    }
    if (pinCount++ >= MAX_PINS) reject(source, no, 'pin count exceeds the import limit.', 'LIMIT_EXCEEDED');
    // A pin row holds a handful of fields; bounding its length bounds the token list built below.
    if (variantProbeLists && text.length > MAX_PIN_ROW) reject(source, no, `a pin record is longer than ${MAX_PIN_ROW} characters.`, 'LIMIT_EXCEEDED');
    const found = [...text.matchAll(FIELD)]; let last = found.length;
    if (last < (variantProbeLists ? 6 : 7)) reject(source, no, `a pin needs id, name, X, Y, layer, net and ${variantProbeLists ? 'an optional probe' : 'probe'}.`);
    integer(source, no, found[0][0], 'pin id');
    if (!variantProbeLists || last >= 7 && (PROBES.test(found[last - 1][0]) || /^-\d/.test(found[last - 1][0]) || found[last - 1][0].includes(','))) {
      if (variantProbeLists) probeList(source, no, found[last - 1][0], tally);
      else integer(source, no, found[last - 1][0], 'probe');
      last--;
    }
    let coordinate = last - 4;
    // Some net names in real exports contain blanks too. When the right-aligned layout does not contain a valid layer,
    // locate the X/Y/layer tuple instead and retain the entire net column; do not split it into invented nets.
    if (variantProbeLists && !/^[+-]?\d{1,15}$/.test(found[coordinate + 2][0])) {
      for (let candidate = 2; candidate < last - 3; candidate++) {
        if (DECIMAL.test(found[candidate][0]) && DECIMAL.test(found[candidate + 1][0]) && /^[+-]?\d{1,15}$/.test(found[candidate + 2][0])) {
          coordinate = candidate; break;
        }
      }
    }
    const nameEnd = found[coordinate - 1];
    const name = text.slice(found[1].index, nameEnd.index + nameEnd[0].length);
    const x = decimal(source, no, found[coordinate][0], 'pin X'), y = decimal(source, no, found[coordinate + 1][0], 'pin Y');
    integer(source, no, found[coordinate + 2][0], 'pin layer', true);
    const netEnd = found[last - 1];
    const net = text.slice(found[coordinate + 3].index, netEnd.index + netEnd[0].length);
    part.pins.push({ number: name, name, net: tally.net(net), side: part.side, x, y });
  }
  return parts;
}

/** `tail` holds the fields from the net column on (BDV only): a net name may contain blanks and be followed by annotations. */
export interface Nail { probe: string; x: number; y: number; side: BoardSide; net: string; generated?: boolean; tail?: string[] }
/**
 * `<marker><probe> X Y type grid side netId net`. A probe has one marker, or a short punctuation-only marker prefix.
 * A leading digit would silently lose a digit under the reference reader's one-character skip, so it is rejected.
 */
export function readNails(rows: Row[], source: Source, tally: Tally): Nail[] {
  if (rows.length > MAX_PINS) reject(source, undefined, 'test point count exceeds the import limit.', 'LIMIT_EXCEEDED');
  return rows.map(({ no, text }) => {
    if (/^\d/.test(text)) reject(source, no, 'a test point starts with a marker character before its probe number.');
    const fields = text.split(/\s+/);
    const probe = /^(?:[^\d\s]|[^\dA-Za-z\s]{2,3})(\d+)$/.exec(fields[0]);
    if (!probe) reject(source, no, 'invalid probe marker or probe id.');
    fields[0] = probe[1];
    if (fields.length < 8) reject(source, no, 'a test point needs probe, X, Y, type, grid, side, net id and net.');
    // Real exports may append virtual PIN / VIA / TEST descriptions after the net name. They do not change the nail.
    if (fields[3] === 'FPT') {
      if (!tally.extra.includes('The FPT test point type is retained as a test point; type annotations do not change its coordinates or net.')) tally.extra.push('The FPT test point type is retained as a test point; type annotations do not change its coordinates or net.');
    } else integer(source, no, fields[3], 'test point type', true);
    return {
      probe: String(integer(source, no, fields[0], 'probe')), x: decimal(source, no, fields[1], 'test point X'), y: decimal(source, no, fields[2], 'test point Y'),
      side: tally.side(fields[5]), net: tally.net(fields[7]), ...(fields.length > 8 ? { tail: fields.slice(7, 7 + MAX_NET_WORDS) } : {}),
    };
  });
}

const MAX_NET_WORDS = 8;
/**
 * A test point row names its net with one word and may carry annotations after it, while a pin's net can contain blanks.
 * When the first words of the tail spell a net name that a pin already has, the nail takes that whole name; otherwise it
 * keeps its first word. A net is never invented from the annotations.
 */
function nameNailNets(model: Model, tally: Tally): void {
  const known = new Map<string, string>();
  for (const part of model.parts) for (const pin of part.pins) if (pin.net && /\s/.test(pin.net)) known.set(pin.net.split(/\s+/).join(' '), pin.net);
  if (!known.size) return;
  for (const nail of model.nails) {
    const tail = nail.tail;
    if (!tail) continue;
    for (let words = tail.length; words >= 2; words--) {
      const match = known.get(tail.slice(0, words).join(' '));
      if (match !== undefined) { nail.net = tally.net(match); break; }
    }
  }
}

export interface Model { outline: Point[]; parts: PendingPart[]; nails: Nail[] }
/** Components without pins have no position in these formats and are dropped (disclosed); test points become one-pin TP:<probe> components like the BRD adapter. */
export function assemble(input: ParseInput, source: Source, model: Model, tally: Tally): Board {
  const parts: RawPart[] = [], pins: RawPin[] = [];
  for (const part of model.parts) {
    if (!part.pins.length) { tally.emptyParts++; continue; }
    const key = `part:${parts.length}`;
    parts.push({ key, ref: part.ref, side: part.side });
    for (const pin of part.pins) pins.push({ part: key, ...pin });
  }
  if (!parts.length) reject(source, undefined, 'no component with pins was found.');
  if (parts.length + model.nails.length > MAX_PARTS || pins.length + model.nails.length > MAX_PINS) reject(source, undefined, 'board record count exceeds the import limit.', 'LIMIT_EXCEEDED');
  model.nails.forEach((nail, index) => {
    const key = `nail:${index}`;
    parts.push({ key, ref: `TP:${nail.probe}`, ...(nail.generated ? { refGenerated: true } : {}), side: nail.side, position: { x: nail.x, y: nail.y } });
    pins.push({ part: key, number: nail.probe, ...(nail.generated ? { numberGenerated: true } : {}), name: nail.probe, net: nail.net, side: nail.side, x: nail.x, y: nail.y });
  });
  const refs = new Set<string>();
  for (const part of parts) { if (refs.has(part.ref!)) tally.repeatedRefs++; else refs.add(part.ref!); }
  return build(input, source, { format: source.format, unitsToMm: INCH, parts, pins, outline: model.outline, warnings: tally.issues() });
}

/** Byte search for an ASCII needle; avoids decoding a 64 MiB file just to find out it is some other format. */
export function indexOfAscii(data: Uint8Array, needle: string, from = 0): number {
  const first = needle.charCodeAt(0), lastStart = data.length - needle.length;
  for (let at = data.indexOf(first, from); at >= 0 && at <= lastStart; at = data.indexOf(first, at + 1)) {
    let k = 1;
    while (k < needle.length && data[at + k] === needle.charCodeAt(k)) k++;
    if (k === needle.length) return at;
  }
  return -1;
}

const ENCODED_MARKER = 'dd:1.3?,r?-=bb';
const ENCODED_NAILS_MARKER = 'dd2?74-r?-=bb';
/** Same evolving-key encoding, with nails as the first section and no supplied outline. */
export function encodedNailsFirst(data: Uint8Array): boolean {
  return indexOfAscii(data, ENCODED_NAILS_MARKER) === 0 && (data[ENCODED_NAILS_MARKER.length] === 13 || data[ENCODED_NAILS_MARKER.length] === 10);
}
const FORMAT_MARKER = '<<format.asc>>', PINS_MARKER = '<<pins.asc>>', NAILS_MARKER = '<<nails.asc>>';
/** Lines of fixed header after each marker (ASCFile.cpp: the first line plus 7 for format and pins, plus 6 for nails; BDVFile.cpp skips 8/8/7 after the marker). */
const HEADERS: ReadonlyMap<string, number> = new Map([[FORMAT_MARKER, 8], [PINS_MARKER, 8], [NAILS_MARKER, 7]]);
/** Full, unambiguous record starts; arbitrary numbers or prose in a banner remain header lines. */
const FIRST_RECORDS: ReadonlyMap<string, (row: string) => boolean> = new Map([
  [FORMAT_MARKER, row => { const f = row.split(/\s+/); return (f.length === 2 || f.length === 3) && DECIMAL.test(f[0]) && DECIMAL.test(f[1]) && (f.length === 2 || DECIMAL.test(f[2]) || /^[A-Z]\d{1,6}$/.test(f[2])); }],
  [PINS_MARKER, row => /^[Pp][Aa][Rr][Tt]\s+.+\s+\([TB]\)$/.test(row)],
  [NAILS_MARKER, row => { const f = row.split(/\s+/); return f.length >= 8 && /^[^\d\s]\d+$/.test(f[0]) && DECIMAL.test(f[1]) && DECIMAL.test(f[2]) && /^\([TB]\)$/.test(f[5]); }],
]);
/**
 * BDVFile.cpp decode_bdv: every byte except CR, LF and NUL becomes (key - byte) mod 256. The key starts at 0xA0, grows by
 * one for each CR LF pair and wraps to 159 once it exceeds 285. The first line "<<format.asc>>" therefore reads
 * "dd:1.3?,r?-=bb" while encoded, which is the signature the reference reader looks for.
 */
export function decodeBdv(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let key = 0xa0;
  for (let index = 0; index < data.length; index++) {
    const byte = data[index];
    if (byte === 13 && data[index + 1] === 10) key++;
    out[index] = byte === 13 || byte === 10 || byte === 0 ? byte : (key - byte) & 0xff;
    if (key > 285) key = 159;
  }
  return out;
}

/**
 * Honhan BDV: the format.asc/pins.asc/nails.asc trio concatenated behind "<<name>>" markers, plain or encoded.
 * Recognition (by bytes): the encoded first-line signature, or both the format and pins markers.
 */
export function parseBdv(input: ParseInput): Board | null {
  if (input.data.length > MAX_IMPORT_BYTES) throw new BoardFormatError('BDV exceeds the import limit.', 'LIMIT_EXCEEDED', BDV_FORMAT);
  let plain: string | undefined;
  if (input.data[0] === 0xff && input.data[1] === 0xfe || input.data[0] === 0xfe && input.data[1] === 0xff) {
    try { plain = decodeText(input.data); }
    catch (error) { if (error instanceof BoardFormatError) throw error; return null; }
  }
  const nailsFirst = plain === undefined && encodedNailsFirst(input.data);
  const encoded = plain === undefined && (indexOfAscii(input.data, ENCODED_MARKER) >= 0 || nailsFirst);
  const marked = plain === undefined ? indexOfAscii(input.data, FORMAT_MARKER) >= 0 && indexOfAscii(input.data, PINS_MARKER) >= 0 : plain.includes(FORMAT_MARKER) && plain.includes(PINS_MARKER);
  if (!encoded && !marked) return null;
  const source: Source = { label: 'BDV', format: BDV_FORMAT };
  const tally = new Tally();
  const sections = scanSections(splitLines(plain ?? decodeText(encoded ? decodeBdv(input.data) : input.data), source), source, HEADERS, tally, undefined, FIRST_RECORDS);
  const formatRows = sections.get(FORMAT_MARKER), pinRows = sections.get(PINS_MARKER);
  if (!formatRows && !nailsFirst) reject(source, undefined, `missing ${FORMAT_MARKER} section.`);
  if (!pinRows) reject(source, undefined, `missing ${PINS_MARKER} section.`);
  if (!formatRows) tally.extra.push('The encoded nails-first BDV export has no format.asc section; its board outline is estimated from its component and test-point coordinates.');
  const model: Model = { outline: readFormat(formatRows ?? [], source, tally), parts: readPins(pinRows, source, tally, true), nails: readNails(sections.get(NAILS_MARKER) ?? [], source, tally) };
  nameNailNets(model, tally);
  return assemble(input, source, model, tally);
}
