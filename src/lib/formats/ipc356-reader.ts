/*
 * IPC-D-356 / IPC-D-356A bare-board test netlist: record reader and format sniffer. Original TRACE module (MIT).
 *
 * Provenance: the layout below is written from the public descriptions of the format (an 80-column, fixed-column text
 * file of test records, parameter records and comment records) and checked against netlists written by an open-source
 * tool from open-licence designs. No part of the standard's text or of any other implementation is reproduced.
 *
 * Record layout read here (1-based columns; the checks in `fixedRecord` are the authority):
 *    1-3   operation code: 317 through-hole feature, 327 surface-mount feature, 367 tooling or mechanical feature,
 *          999 end of file; a leading 0 instead of 3 (017, 027, 067) marks a continuation of the record before it
 *    4-17  net name (14 characters, "N/C" means no net)
 *   18-20  blank
 *   21-26  reference designator ("VIA" names a via)
 *      27  "-" and 28-31 the pin number (4 characters)
 *      32  "M" when the point is a midpoint (a via)
 *   33-38  "D" + four digits hole diameter + "P" plated or "U" unplated (through-hole features only)
 *   39-41  "A" + two digits access: 00 both sides, 01 the primary (top) side, the highest code in the file the
 *          secondary (bottom) side, anything between is an inner layer
 *   42-49  "X" + signed X coordinate (six digits)      50-57 "Y" + signed Y coordinate
 *   58-62  "X" + four digits size across X            63-67 "Y" + four digits size across Y (0: a round feature)
 *   68-71  "R" + three digits rotation, counter-clockwise degrees      72-73 "S" + solder-mask code
 * Parameter records ("P  UNITS CUST 0", "P  JOB ...") sit before the test records; "C  ..." lines are comments.
 *
 * Writer behaviour seen in the files checked (all written by one open-source tool): net names are upper-cased and cut to their
 * last 14 characters, a blank in a name is written as "?", and "#1" is appended when two cut names would collide; reference
 * designators are cut to their first 6 characters (so parts that differ only after the sixth character share a name).
 *
 * What is NOT verified: only "UNITS CUST 0" (0.0001 inch) is proven on real files. The metric flavours (CUST 1, SI: 0.001 mm)
 * and the continuation record are read from public descriptions and are proven on synthetic fixtures only.
 */
import { asciiPrefix, BoardFormatError, type FormatErrorCode } from './common';

export const IPC356_FORMAT = 'IPC-D-356';
/** Mirrors the pin budget of common.buildBoard, so a hostile file fails before large arrays exist. */
export const IPC356_MAX_FEATURES = 1_000_000;
/** The standard allows 80 columns; real writers add a little padding. A longer record line is refused instead of scanned. */
export const IPC356_MAX_RECORD_LINE = 256;
const SNIFF_BYTES = 64 * 1024, SNIFF_LINES = 400, MAX_PARAMETERS = 64, MAX_COMMENTS = 16, MAX_UNSUPPORTED_CODES = 32;

export type Ipc356Kind = 'through-hole' | 'surface-mount' | 'tooling';
export interface Ipc356Units {
  /** The text after "UNITS", normalised to upper case ("CUST 0", "SI"). */
  code: string;
  unit: 'inch' | 'mm';
  /** Millimetres per raw coordinate step. */
  mmPerUnit: number;
}
export interface Ipc356Header {
  units?: Ipc356Units;
  /** The text of a UNITS record that is not understood (the build step refuses it unless the caller gives the unit). */
  unknownUnits?: string;
  job?: string;
  title?: string;
  version?: string;
  parameters: Array<{ key: string; value: string }>;
  comments: string[];
}
/** One test record, in raw file units (coordinates, sizes and the hole diameter are integers of the unit in the header). */
export interface Ipc356Feature {
  line: number;
  kind: Ipc356Kind;
  /** A continuation line (operation code beginning with 0): empty reference, pin and net are inherited from the record before. */
  continuation: boolean;
  net: string;
  ref: string;
  pin: string;
  midpoint: boolean;
  holeDiameter?: number;
  /** P: plated hole, U: unplated. */
  plated?: boolean;
  access?: number;
  x: number;
  y: number;
  xSize: number;
  ySize: number;
  /** Counter-clockwise degrees, 0-359. */
  rotation: number;
  /** The solder-mask digit when it is 0-3 (some writers put other numbers there; those are not interpreted). */
  mask?: number;
  /** The record did not follow the fixed columns and was split on blanks instead. */
  relaxed: boolean;
}
export interface Ipc356Stats {
  /** Lines scanned (blank lines included). */
  lines: number;
  /** Lines that are neither blank, comment, parameter nor an operation code. */
  unknownLines: number;
  /** Operation codes that are not read (conductors, blind vias, ...), with their record counts. */
  unsupported: Array<{ code: string; count: number }>;
  /** Continuation lines with no record before them. */
  strayContinuations: number;
  /** Continuation lines that did not carry a readable feature. */
  ignoredContinuations: number;
  /** The 999 end record was found. */
  end: boolean;
}
export interface Ipc356Document { header: Ipc356Header; features: Ipc356Feature[]; stats: Ipc356Stats }
export interface Ipc356Limits { maxFeatures?: number }

function fail(line: number, message: string, code: FormatErrorCode = 'INVALID_FORMAT'): never {
  throw new BoardFormatError(`${IPC356_FORMAT} line ${line}: ${message}`, code, IPC356_FORMAT);
}

const INT = /^[+-]?\d{1,9}$/, UINT = /^\d{1,9}$/;
const KIND_OF_CODE: Readonly<Record<string, Ipc356Kind | undefined>> = { '17': 'through-hole', '27': 'surface-mount', '67': 'tooling' };
export interface Ipc356Tail { midpoint: boolean; holeDiameter?: number; plated?: boolean; access?: number; x: number; y: number; xSize: number; ySize: number; rotation: number; mask?: number }
/** The fields of one test record line, in raw file units. */
export interface Ipc356Record extends Ipc356Tail { net: string; ref: string; pin: string; relaxed: boolean }

// Everything after the size block: optional rotation and optional solder-mask code (some writers append a long number there).
const SIZE_REST = /^(?:R(\d{3}))?(?:S(-?\d{1,12}))?[ ]*$/;
function maskOf(text: string | undefined): number | undefined { return text !== undefined && /^[0-3]$/.test(text) ? Number(text) : undefined; }

/** Reads the fixed columns after the pin; null when any marker letter is not where the layout puts it. Only slices and anchored patterns: linear. */
function fixedTail(line: string): Ipc356Tail | null {
  if (line.length < 57 || line[41] !== 'X' || line[49] !== 'Y') return null;
  const x = line.slice(42, 49), y = line.slice(50, 57);
  if (!INT.test(x) || !INT.test(y)) return null;
  if (line[31] !== 'M' && line[31] !== ' ') return null;
  let holeDiameter: number | undefined, plated: boolean | undefined, access: number | undefined;
  if (line[32] === 'D') {
    const digits = line.slice(33, 37);
    if (!UINT.test(digits)) return null;
    holeDiameter = Number(digits);
    if (line[37] === 'P') plated = true; else if (line[37] === 'U') plated = false; else if (line[37] !== ' ') return null;
  } else if (line.slice(32, 38).trim()) return null;
  if (line[38] === 'A') {
    const digits = line.slice(39, 41);
    if (!UINT.test(digits)) return null;
    access = Number(digits);
  } else if (line.slice(38, 41).trim()) return null;
  let xSize = 0, ySize = 0, at = 57;
  if (line[57] === 'X') { // the size block is optional; when it starts it is complete
    if (line.length < 67 || line[62] !== 'Y') return null;
    const sx = line.slice(58, 62), sy = line.slice(63, 67);
    if (!/^\d{4}$/.test(sx) || !/^\d{4}$/.test(sy)) return null;
    xSize = Number(sx); ySize = Number(sy); at = 67;
  }
  const tail = SIZE_REST.exec(line.slice(at));
  if (!tail) return null;
  const rotation = tail[1] === undefined ? 0 : Number(tail[1]) % 360, mask = maskOf(tail[2]);
  return { midpoint: line[31] === 'M', holeDiameter, plated, access, x: Number(x), y: Number(y), xSize, ySize, rotation, mask };
}

// The whole tail as one blank-free token, with the standard field widths (a record cut off inside a number does not match). Every optional group starts with its own letter, so there is nothing to backtrack over.
const TAIL = /^(M)?(?:D(\d{4})([PU])?)?(?:A(\d{2}))?X([+-]?\d{6})Y([+-]?\d{6})(?:X(\d{4})Y(\d{4}))?(?:R(\d{3}))?(?:S(-?\d{1,12}))?$/;
function tailOf(match: RegExpExecArray): Ipc356Tail {
  return {
    midpoint: match[1] === 'M', holeDiameter: match[2] === undefined ? undefined : Number(match[2]), plated: match[3] === undefined ? undefined : match[3] === 'P',
    access: match[4] === undefined ? undefined : Number(match[4]), x: Number(match[5]), y: Number(match[6]),
    xSize: match[7] === undefined ? 0 : Number(match[7]), ySize: match[8] === undefined ? 0 : Number(match[8]),
    rotation: match[9] === undefined ? 0 : Number(match[9]) % 360, mask: maskOf(match[10]),
  };
}
/**
 * net, reference and pin from the blank-separated tokens in front of the tail. A last token '-<pin>' is the pin and the token before it
 * the reference; net names may contain blanks, so the net takes whatever is left in front of the reference.
 */
function splitLeft(left: string[]): { net: string; ref: string; pin: string } {
  if (!left.length) return { net: '', ref: '', pin: '' };
  const last = left[left.length - 1];
  if (last.length > 1 && last[0] === '-') {
    if (left.length >= 3) return { net: left.slice(0, -2).join(' '), ref: left[left.length - 2], pin: last.slice(1) };
    if (left.length === 2) return { net: '', ref: left[0], pin: last.slice(1) };
    return { net: '', ref: '', pin: last.slice(1) };
  }
  if (left.length >= 2) return { net: left.slice(0, -1).join(' '), ref: last, pin: '' };
  return { net: left[0], ref: '', pin: '' };
}
/** Fallback for writers that do not keep the columns: the coordinates and size block is the last blank-free token (or the last two or three). */
function relaxedRecord(line: string): Ipc356Record | null {
  const tokens = line.slice(3).trim().split(/\s+/);
  for (let take = Math.min(3, tokens.length); take >= 1; take--) {
    const match = TAIL.exec(tokens.slice(tokens.length - take).join(''));
    if (match) return { ...splitLeft(tokens.slice(0, tokens.length - take)), ...tailOf(match), relaxed: true };
  }
  return null;
}
function fixedRecord(line: string): Ipc356Record | null {
  if (line.slice(17, 20).trim()) return null; // a net name wider than the field pushes the other columns: not the fixed layout
  if (line[26] !== '-' && line[26] !== ' ') return null;
  const tail = fixedTail(line);
  if (!tail) return null;
  const pin = line.slice(26, 31).trim().replace(/^-\s*/, '');
  return { net: line.slice(3, 17).trim(), ref: line.slice(20, 26).trim(), pin, ...tail, relaxed: false };
}
/** One test record line (operation code included); null when neither the fixed columns nor the blank-split fallback fit. */
export function readIpc356Record(line: string): Ipc356Record | null { return fixedRecord(line) ?? relaxedRecord(line); }

/** "CUST 0": 0.0001 inch. "CUST 1" and "SI": 0.001 mm. Anything else is left to the caller. */
export function ipc356Units(text: string): Ipc356Units | undefined {
  const tokens = text.trim().toUpperCase().split(/\s+/);
  if (tokens[0] === 'SI' && tokens.length === 1) return { code: 'SI', unit: 'mm', mmPerUnit: 0.001 };
  if (tokens[0] !== 'CUST' || tokens.length > 2) return undefined;
  const flavour = tokens[1] ?? '0';
  if (flavour === '0') return { code: 'CUST 0', unit: 'inch', mmPerUnit: 0.00254 };
  if (flavour === '1') return { code: 'CUST 1', unit: 'mm', mmPerUnit: 0.001 };
  return undefined;
}

const isDigit = (code: number) => code >= 48 && code <= 57;
const clip = (text: string, length = 200) => text.length > length ? text.slice(0, length) : text;

/**
 * Reads the whole file. Parameter and comment records fill the header; 317/327/367 records (and their continuations) become
 * features; other operation codes are counted, not read. A recognised record that does not fit the layout is rejected with
 * its line number; the 999 record ends the file.
 */
export function readIpc356(text: string, limits: Ipc356Limits = {}): Ipc356Document {
  const maxFeatures = limits.maxFeatures ?? IPC356_MAX_FEATURES;
  const header: Ipc356Header = { parameters: [], comments: [] };
  const features: Ipc356Feature[] = [];
  const unsupported = new Map<string, number>();
  const stats: Ipc356Stats = { lines: 0, unknownLines: 0, unsupported: [], strayContinuations: 0, ignoredContinuations: 0, end: false };
  let previous: Ipc356Feature | undefined, pos = 0, no = 0, unitsSeen = false;
  const length = text.length;
  while (pos < length && !stats.end) {
    let end = pos;
    for (let code = 0; end < length && (code = text.charCodeAt(end)) !== 10 && code !== 13; end++);
    no++;
    const next = end < length && text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10 ? end + 2 : end + 1;
    const size = end - pos, first = size ? text.charCodeAt(pos) : 0;
    const start = pos;
    pos = next;
    if (!size) continue;
    if (size >= 3 && isDigit(first) && isDigit(text.charCodeAt(start + 1)) && isDigit(text.charCodeAt(start + 2))) {
      if (size > IPC356_MAX_RECORD_LINE) fail(no, `a record is longer than ${IPC356_MAX_RECORD_LINE} characters; IPC-D-356 records have 80.`, 'LIMIT_EXCEEDED');
      const line = text.slice(start, end), code = line.slice(0, 3);
      if (code === '999') { stats.end = true; break; }
      const kind = KIND_OF_CODE[code.slice(1)];
      const continuation = first === 48;
      if (!kind || first !== 51 && !continuation) {
        if (unsupported.has(code) || unsupported.size < MAX_UNSUPPORTED_CODES) unsupported.set(code, (unsupported.get(code) ?? 0) + 1);
        else unsupported.set('other', (unsupported.get('other') ?? 0) + 1);
        continue;
      }
      const fields = readIpc356Record(line);
      if (!fields) {
        if (continuation) { stats.ignoredContinuations++; continue; }
        fail(no, `a ${code} record does not follow the IPC-D-356 column layout (net, reference, pin, then the X/Y coordinates).`);
      }
      if (continuation && !previous) { stats.strayContinuations++; continue; }
      if (features.length >= maxFeatures) fail(no, 'the number of test records exceeds the import limit.', 'LIMIT_EXCEEDED');
      const feature: Ipc356Feature = {
        line: no, kind, continuation, net: fields.net || (continuation ? previous!.net : ''), ref: fields.ref || (continuation ? previous!.ref : ''), pin: fields.pin || (continuation && !fields.ref ? previous!.pin : ''),
        midpoint: fields.midpoint, ...(fields.holeDiameter === undefined ? {} : { holeDiameter: fields.holeDiameter }), ...(fields.plated === undefined ? {} : { plated: fields.plated }),
        ...(fields.access === undefined ? {} : { access: fields.access }), x: fields.x, y: fields.y, xSize: fields.xSize, ySize: fields.ySize, rotation: fields.rotation,
        ...(fields.mask === undefined ? {} : { mask: fields.mask }), relaxed: fields.relaxed,
      };
      features.push(feature);
      previous = feature;
      continue;
    }
    const lead = text.charCodeAt(start + 1);
    if ((first === 67 || first === 80) && (size === 1 || lead === 32 || lead === 9)) {
      const body = clip(text.slice(start + 1, Math.min(end, start + 1 + IPC356_MAX_RECORD_LINE))).trim();
      if (first === 67) { if (header.comments.length < MAX_COMMENTS && body) header.comments.push(body); continue; }
      const match = /^(\S+)\s*(.*)$/.exec(body);
      if (!match) continue;
      const key = match[1].toUpperCase(), value = match[2].trim();
      if (header.parameters.length < MAX_PARAMETERS) header.parameters.push({ key, value });
      if (key === 'UNITS') {
        if (features.length) fail(no, 'a UNITS record follows test records; the unit of the records before it would be unknown.');
        const units = ipc356Units(value);
        if (unitsSeen && (units?.code ?? value) !== (header.units?.code ?? header.unknownUnits)) fail(no, 'the file changes its units; one unit per file is supported.', 'UNSUPPORTED_VARIANT');
        unitsSeen = true;
        if (units) header.units = units; else header.unknownUnits = value;
      } else if (key === 'JOB') header.job = value;
      else if (key === 'TITLE') header.title = value;
      else if (key === 'VER' || key === 'VERSION') header.version = value;
      continue;
    }
    if (size <= IPC356_MAX_RECORD_LINE && !text.slice(start, end).trim()) continue;
    stats.unknownLines++;
  }
  stats.lines = no;
  stats.unsupported = [...unsupported].map(([code, count]) => ({ code, count }));
  return { header, features, stats };
}

export interface Ipc356Sniff {
  /** 0 (not this format) to about 0.97. Below 0.5 the adapter declines the bytes. */
  confidence: number;
  /** "IPC-D-356A" when a version parameter says so, otherwise "IPC-D-356". */
  variant?: string;
  /** The text of the UNITS record, when the head has one. */
  units?: string;
  reason: string;
}

/**
 * Looks at the first 64 KiB only (at most 400 lines): parameter and comment records, and how many numbered records fit the
 * column layout. Binary data and files without a single readable test record score 0.
 */
export function sniffIpc356(data: Uint8Array): Ipc356Sniff {
  if (!(data instanceof Uint8Array) || data.length < 20) return { confidence: 0, reason: 'too short' };
  let head = asciiPrefix(data, SNIFF_BYTES);
  if (head.slice(0, 1024).includes('\0')) return { confidence: 0, reason: 'binary data' };
  if (head.startsWith('\xEF\xBB\xBF')) head = head.slice(3);
  if (data.length > SNIFF_BYTES) { const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('\r')); if (cut > 0) head = head.slice(0, cut); }
  let valid = 0, invalid = 0, junk = 0, parameters = 0, units: string | undefined, version: string | undefined, other = 0, lines = 0;
  for (let pos = 0; pos < head.length && lines < SNIFF_LINES; lines++) {
    let end = pos;
    for (let code = 0; end < head.length && (code = head.charCodeAt(end)) !== 10 && code !== 13; end++);
    const size = end - pos, start = pos;
    pos = end + 1;
    if (!size) { lines--; continue; }
    const first = head.charCodeAt(start);
    if (size >= 3 && isDigit(first) && isDigit(head.charCodeAt(start + 1)) && isDigit(head.charCodeAt(start + 2))) {
      if (size > IPC356_MAX_RECORD_LINE) { invalid++; continue; }
      const line = head.slice(start, end), code = line.slice(0, 3);
      if (code === '999') continue;
      if (KIND_OF_CODE[code.slice(1)] && (first === 51 || first === 48)) {
        if (readIpc356Record(line)) valid++; else if (first === 51) invalid++; else other++; // a continuation without a readable pad is skipped by the reader too
      } else other++;
      continue;
    }
    const lead = head.charCodeAt(start + 1);
    if ((first === 67 || first === 80) && (size === 1 || lead === 32 || lead === 9)) {
      if (first === 80) {
        parameters++;
        const body = clip(head.slice(start + 1, end)).trim(), match = /^(\S+)\s*(.*)$/.exec(body);
        if (match) { const key = match[1].toUpperCase(); if (key === 'UNITS') units = match[2].trim(); else if (key === 'VER' || key === 'VERSION') version = match[2].trim(); }
      }
      continue;
    }
    if (size <= IPC356_MAX_RECORD_LINE && !head.slice(start, end).trim()) { lines--; continue; }
    junk++;
  }
  const variant = version && /356\s*-?\s*A/i.test(version) ? 'IPC-D-356A' : 'IPC-D-356';
  if (!valid) {
    if (units !== undefined && (other || invalid)) return { confidence: 0.2, variant, units, reason: 'a UNITS record and numbered records, none a readable test record' };
    return { confidence: 0, reason: 'no test record' };
  }
  const ratio = valid / (valid + invalid + junk);
  let confidence = ratio >= 0.9 ? 0.85 : ratio >= 0.6 ? 0.6 : 0.3;
  if (confidence >= 0.6 && units !== undefined) confidence += 0.1;
  if (confidence >= 0.85 && parameters >= 2) confidence += 0.02;
  return { confidence: Math.min(confidence, 0.97), variant, ...(units === undefined ? {} : { units }), reason: `${valid} test record${valid === 1 ? '' : 's'} in the first ${lines} lines` };
}
/** True when the bytes are confidently an IPC-D-356 netlist (the adapter's own claim threshold). */
export const looksLikeIpc356 = (data: Uint8Array): boolean => sniffIpc356(data).confidence >= 0.5;
