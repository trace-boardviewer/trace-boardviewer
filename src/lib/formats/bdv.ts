/*
 * Honhan BDV reader plus the ASC record dialect it shares with the ASC companion trio and (partly) BVR.
 * Section markers, header lengths, record layouts and the evolving-key encoding follow OpenBoardView's
 * BDVFile.cpp, ASCFile.cpp and BVRFile.cpp (MIT, Copyright (c) 2016 Chloridite and OpenBoardView contributors;
 * see assets/licenses/openboardview-MIT.txt). The code below is original.
 */
import type { Board, BoardSide, ParseIssue, Point } from '../types';
import { BoardFormatError, buildBoard, decodeText, note, vendorDisconnected, type FormatErrorCode, type ParseInput, type RawBoard, type RawPart, type RawPin } from './common';

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
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
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
  unconnected = 0; unknownSides = 0; defaultedSides = 0; emptyParts = 0; strayLines = 0; repeatedRefs = 0;
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
    if (this.ignoredSections.length) messages.push(`Sections without a documented layout were ignored: ${this.ignoredSections.slice(0, 5).join(', ')}${this.ignoredSections.length > 5 ? ', …' : ''}.`);
    if (this.strayLines) messages.push(`${plural(this.strayLines, 'non-empty line', 'non-empty lines')} outside any section ${n(this.strayLines) ? 'was' : 'were'} ignored.`);
    return [...messages, ...this.extra].map(note);
  }
}

export function splitLines(text: string, source: Source): string[] {
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
export function scanSections(lines: string[], source: Source, headers: ReadonlyMap<string, number>, tally: Tally, expectedPreamble?: RegExp): Map<string, Row[]> {
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
export function readFormat(rows: Row[], source: Source): Point[] {
  if (rows.length > MAX_OUTLINE_POINTS) reject(source, undefined, 'outline point count exceeds the import limit.', 'LIMIT_EXCEEDED');
  return rows.map(({ no, text }) => {
    const fields = text.split(/\s+/);
    if (fields.length !== 2) reject(source, no, 'an outline point needs two coordinates.');
    return { x: decimal(source, no, fields[0], 'outline X'), y: decimal(source, no, fields[1], 'outline Y') };
  });
}

export interface PendingPin { number: string; name: string; net: string; side: BoardSide; x: number; y: number }
export interface PendingPart { ref: string; side: BoardSide; pins: PendingPin[] }
const FIELD = /\S+/g;
/**
 * "Part <ref> <side>" lines open a component; every following line is one of its pins:
 * `id name X Y layer net probe`. The name is the free-text middle (pin names such as "A 1" contain blanks), so the fixed
 * fields are taken from the end. Pins take the side of their component; the layer column is validated but not used.
 */
export function readPins(rows: Row[], source: Source, tally: Tally): PendingPart[] {
  const parts: PendingPart[] = [];
  let pinCount = 0;
  for (const { no, text } of rows) {
    if (/^Part\s/.test(text)) {
      const fields = text.split(/\s+/);
      if (fields.length !== 3) reject(source, no, 'a Part line needs a reference and a side marker.');
      if (parts.length >= MAX_PARTS) reject(source, no, 'component count exceeds the import limit.', 'LIMIT_EXCEEDED');
      parts.push({ ref: fields[1], side: tally.side(fields[2]), pins: [] });
      continue;
    }
    const part = parts.at(-1);
    if (!part) reject(source, no, 'a pin record appears before the first Part line.');
    if (pinCount++ >= MAX_PINS) reject(source, no, 'pin count exceeds the import limit.', 'LIMIT_EXCEEDED');
    const found = [...text.matchAll(FIELD)], last = found.length;
    if (last < 7) reject(source, no, 'a pin needs id, name, X, Y, layer, net and probe.');
    integer(source, no, found[0][0], 'pin id');
    const nameEnd = found[last - 6];
    const name = text.slice(found[1].index, nameEnd.index + nameEnd[0].length);
    const x = decimal(source, no, found[last - 5][0], 'pin X'), y = decimal(source, no, found[last - 4][0], 'pin Y');
    integer(source, no, found[last - 3][0], 'pin layer', true);
    integer(source, no, found[last - 1][0], 'probe');
    part.pins.push({ number: name, name, net: tally.net(found[last - 2][0]), side: part.side, x, y });
  }
  return parts;
}

export interface Nail { probe: string; x: number; y: number; side: BoardSide; net: string }
/**
 * `<marker><probe> X Y type grid side netId net`. The reference reader skips exactly one marker character before the
 * probe number; a digit there would silently lose a digit of the probe, so it is rejected.
 */
export function readNails(rows: Row[], source: Source, tally: Tally): Nail[] {
  if (rows.length > MAX_PINS) reject(source, undefined, 'test point count exceeds the import limit.', 'LIMIT_EXCEEDED');
  return rows.map(({ no, text }) => {
    if (/^\d/.test(text)) reject(source, no, 'a test point starts with a marker character before its probe number.');
    const fields = text.slice(1).trim().split(/\s+/);
    if (fields.length !== 8) reject(source, no, 'a test point needs probe, X, Y, type, grid, side, net id and net.');
    integer(source, no, fields[3], 'test point type', true);
    return {
      probe: String(integer(source, no, fields[0], 'probe')), x: decimal(source, no, fields[1], 'test point X'), y: decimal(source, no, fields[2], 'test point Y'),
      side: tally.side(fields[5]), net: tally.net(fields[7]),
    };
  });
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
    parts.push({ key, ref: `TP:${nail.probe}`, side: nail.side, position: { x: nail.x, y: nail.y } });
    pins.push({ part: key, number: nail.probe, name: nail.probe, net: nail.net, side: nail.side, x: nail.x, y: nail.y });
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
const FORMAT_MARKER = '<<format.asc>>', PINS_MARKER = '<<pins.asc>>', NAILS_MARKER = '<<nails.asc>>';
/** Lines of fixed header after each marker (ASCFile.cpp: the first line plus 7 for format and pins, plus 6 for nails; BDVFile.cpp skips 8/8/7 after the marker). */
const HEADERS: ReadonlyMap<string, number> = new Map([[FORMAT_MARKER, 8], [PINS_MARKER, 8], [NAILS_MARKER, 7]]);
/**
 * BDVFile.cpp decode_bdv: every byte except CR, LF and NUL becomes (key - byte) mod 256. The key starts at 0xA0, grows by
 * one for each CR LF pair and wraps to 159 once it exceeds 285. The first line "<<format.asc>>" therefore reads
 * "dd:1.3?,r?-=bb" while encoded, which is the signature the reference reader looks for.
 */
function decodeBdv(data: Uint8Array): Uint8Array {
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
  const encoded = indexOfAscii(input.data, ENCODED_MARKER) >= 0;
  if (!encoded && !(indexOfAscii(input.data, FORMAT_MARKER) >= 0 && indexOfAscii(input.data, PINS_MARKER) >= 0)) return null;
  const source: Source = { label: 'BDV', format: BDV_FORMAT };
  const tally = new Tally();
  const sections = scanSections(splitLines(decodeText(encoded ? decodeBdv(input.data) : input.data), source), source, HEADERS, tally);
  const formatRows = sections.get(FORMAT_MARKER), pinRows = sections.get(PINS_MARKER);
  if (!formatRows) reject(source, undefined, `missing ${FORMAT_MARKER} section.`);
  if (!pinRows) reject(source, undefined, `missing ${PINS_MARKER} section.`);
  const model: Model = { outline: readFormat(formatRows, source), parts: readPins(pinRows, source, tally), nails: readNails(sections.get(NAILS_MARKER) ?? [], source, tally) };
  return assemble(input, source, model, tally);
}
