/*
 * Original TRACE adapter (MIT): container and record layer of the Altium SchDoc reader (see altium-sch.ts for the model builder).
 *
 * Provenance: the SchDoc layout (an OLE compound file whose `FileHeader` stream holds length-prefixed `|KEY=VALUE|` records, and the
 * line-based "Ascii File" export of the same records) is documented publicly (the KiCad developer documentation on Altium import
 * formats, the python-altium format notes) and was checked against openly licensed real files. No implementation source code was
 * read or copied. The container is read with the bounded reader shared with the PcbDoc adapter (../formats/altium-cfb.ts).
 *
 * Record framing of the stream: [u32 word][word & 0xFFFFFF bytes of payload]; the high byte of the word is a flag (0 = text record,
 * anything else = binary record, skipped but counted). A text payload is `|RECORD=n|Key=Value|...` and usually ends with NUL. The
 * first record is `|HEADER=Protel for Windows - Schematic Capture ... File Version 5.0|...`; it is NOT counted: `OwnerIndex` values
 * refer to the zero-based position among the records after it (the sheet record, RECORD=31, normally sits at 0).
 *
 * Everything here is bounded and linear: payloads are never copied until a record is read, headers are scanned byte-wise without
 * allocating, and a record is limited in size.
 */
import { CFB_MAGIC, readCompound } from '../formats/altium-cfb';
import { SCHEMATIC_LIMITS, SchematicError, type SchematicErrorCode, type SchematicFormat } from './model';

export const ALTIUM_SCH_FORMAT = 'altium-sch' as const;
export const FORMAT_ID = ALTIUM_SCH_FORMAT satisfies SchematicFormat;

export const ALTIUM_SCH_LIMITS = Object.freeze({
  /** Records (text and binary) per document. */
  maxRecords: 1_000_000,
  /** Payload bytes of one record. */
  maxRecordBytes: 1 << 20,
  /** Vertices of one wire, bus, polyline or polygon. */
  maxVertices: 100_000,
  /** Fields of a project file and companion files read per design. */
  maxProjectDocuments: 4096,
  maxProjectBytes: 1 << 20,
});

export const fail = (message: string, code: SchematicErrorCode = 'INVALID_FORMAT'): SchematicError => new SchematicError(message, code, FORMAT_ID);

const cp1252 = new TextDecoder('windows-1252');
const utf8 = new TextDecoder('utf-8');
const HEADER_SCAN = 512;

// ---------------------------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------------------------

/** A decoded SchDoc: parallel arrays over the records after the header. Text is decoded lazily, one record at a time. */
export interface AltiumDocument {
  /** The bytes the offsets below point into (the FileHeader stream, or the whole file for the ASCII variant). */
  data: Uint8Array;
  ascii: boolean;
  /** Text of the header record, e.g. "|HEADER=Protel for Windows - Schematic Capture Binary File Version 5.0|Weight=1513|...". */
  header: string;
  count: number;
  /** RECORD number; -2 for a binary record, -1 when the record has no RECORD key. */
  kind: number[];
  /** OwnerIndex, -1 when absent. */
  owner: number[];
  start: number[];
  end: number[];
  binaryRecords: number;
  /** Bytes of the line-based export that follow the records (an `Icon storage` section of hex-encoded images): skipped, never read. */
  trailerBytes: number;
}

export type SchDocKind = 'binary' | 'ascii' | 'library' | null;

const asciiHead = (data: Uint8Array, length: number): string => {
  let text = '';
  const n = Math.min(length, data.length);
  for (let i = 0; i < n; i++) text += String.fromCharCode(data[i]);
  return text;
};

/** The header text of a SchDoc/SchLib text document or stream (first record), or null. Only a short prefix is examined. */
function headerOf(bytes: Uint8Array, framed: boolean): string | null {
  let at = 0;
  if (framed) {
    if (bytes.length < 4) return null;
    const word = (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    if (word >>> 24) return null;
    at = 4;
  } else {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) at = 3;
    while (at < bytes.length && (bytes[at] === 0x20 || bytes[at] === 0x09 || bytes[at] === 0x0d || bytes[at] === 0x0a)) at++;
  }
  const text = asciiHead(bytes.subarray(at), HEADER_SCAN);
  return /^\|HEADER=/i.test(text) ? text.split(/[\0\r\n]/)[0] : null;
}

const SCHDOC_HEADER = /Schematic Capture/i, SCHLIB_HEADER = /Schematic Library/i;

/** Quick classification of the primary file: 'binary' / 'ascii' SchDoc, 'library' for a SchLib, null for anything else. */
export function sniffSchDoc(data: Uint8Array): SchDocKind {
  if (data.length >= 8 && CFB_MAGIC.every((byte, i) => data[i] === byte)) return null; // classified after the container is read
  const header = headerOf(data, false);
  if (!header) return null;
  if (SCHLIB_HEADER.test(header)) return 'library';
  return SCHDOC_HEADER.test(header) ? 'ascii' : null;
}

const compoundFail = (message: string, code: 'INVALID_FORMAT' | 'UNSUPPORTED_VARIANT' | 'LIMIT_EXCEEDED'): never => { throw fail(message, code); };

/** FileHeader stream of an OLE compound file; null when the container is not an Altium schematic document. */
export function schDocStream(data: Uint8Array): { stream: Uint8Array; kind: 'binary' | 'library' } | null {
  const container = readCompound(data, compoundFail);
  const stream = container.stream('/FileHeader');
  if (!stream) return null;
  const header = headerOf(stream, true);
  if (!header) return null;
  if (SCHLIB_HEADER.test(header)) return { stream, kind: 'library' };
  return SCHDOC_HEADER.test(header) ? { stream, kind: 'binary' } : null;
}

const isDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x39;
/** Case-insensitive ASCII match of `key` (which includes the "=") at `at`. */
function keyAt(d: Uint8Array, at: number, end: number, key: string): boolean {
  if (at + key.length > end) return false;
  for (let i = 0; i < key.length; i++) {
    const c = d[at + i];
    if ((c >= 0x41 && c <= 0x5a ? c | 0x20 : c) !== key.charCodeAt(i)) return false;
  }
  return true;
}
function numberAt(d: Uint8Array, at: number, end: number): number {
  let i = at, negative = false, value = 0, digits = 0;
  if (d[i] === 0x2d) { negative = true; i++; }
  for (; i < end && isDigit(d[i]) && digits < 9; i++, digits++) value = value * 10 + d[i] - 0x30;
  return digits ? (negative ? -value : value) : -1;
}

/** RECORD and OwnerIndex of the record occupying [start, end); first occurrence of each key wins. One pass, no allocation. */
function scanRecord(d: Uint8Array, start: number, end: number, out: { kind: number; owner: number }): void {
  out.kind = -1; out.owner = -1;
  let kindSeen = false, ownerSeen = false;
  for (let i = start; i < end && d[i] !== 0; i++) {
    if (d[i] !== 0x7c) continue;
    if (!kindSeen && keyAt(d, i + 1, end, 'record=')) { kindSeen = true; out.kind = numberAt(d, i + 8, end); }
    else if (!ownerSeen && keyAt(d, i + 1, end, 'ownerindex=')) { ownerSeen = true; out.owner = numberAt(d, i + 12, end); }
  }
}

function emptyDocument(data: Uint8Array, ascii: boolean, header: string): AltiumDocument {
  return { data, ascii, header, count: 0, kind: [], owner: [], start: [], end: [], binaryRecords: 0, trailerBytes: 0 };
}

function push(doc: AltiumDocument, start: number, end: number, scratch: { kind: number; owner: number }, binary: boolean): void {
  if (doc.count >= ALTIUM_SCH_LIMITS.maxRecords) throw fail(`The Altium schematic has more than ${ALTIUM_SCH_LIMITS.maxRecords} records.`, 'LIMIT_EXCEEDED');
  if (binary) { doc.kind.push(-2); doc.owner.push(-1); doc.binaryRecords++; }
  else { scanRecord(doc.data, start, end, scratch); doc.kind.push(scratch.kind); doc.owner.push(scratch.owner); }
  doc.start.push(start); doc.end.push(end); doc.count++;
}

/** Records of the FileHeader stream of a binary SchDoc. */
export function decodeBinaryStream(stream: Uint8Array): AltiumDocument {
  const scratch = { kind: -1, owner: -1 };
  let at = 0, doc: AltiumDocument | undefined;
  while (at < stream.length) {
    if (stream.length - at < 4) throw fail(`The Altium FileHeader stream is truncated at byte ${at} (a record length is incomplete).`);
    const word = (stream[at] | stream[at + 1] << 8 | stream[at + 2] << 16 | stream[at + 3] << 24) >>> 0, size = word & 0xffffff, flag = word >>> 24;
    at += 4;
    if (size > stream.length - at) throw fail(`The Altium FileHeader stream is truncated at byte ${at} (a record of ${size} bytes is declared, ${stream.length - at} remain).`);
    if (size > ALTIUM_SCH_LIMITS.maxRecordBytes) throw fail(`An Altium record of ${size} bytes exceeds the ${ALTIUM_SCH_LIMITS.maxRecordBytes} byte limit.`, 'LIMIT_EXCEEDED');
    if (!doc) {
      if (flag !== 0) throw fail('The first record of the Altium FileHeader stream is not a text header.');
      const header = cp1252.decode(stream.subarray(at, at + Math.min(size, HEADER_SCAN)).filter(byte => byte !== 0));
      doc = emptyDocument(stream, false, header);
    } else push(doc, at, at + size, scratch, flag !== 0);
    at += size;
  }
  if (!doc) throw fail('The Altium FileHeader stream is empty.');
  return doc;
}

/**
 * Records of the line-based ("Ascii File") export: one record per line, the first line is the header. A second `|HEADER=` line (real
 * exports carry `|HEADER=Icon storage`, followed by hex-encoded embedded images wrapped over many lines that end in `|>`, and finish
 * with a copy of the first header) closes the records: everything after it is a storage section, skipped without being interpreted.
 */
export function decodeAsciiDocument(data: Uint8Array): AltiumDocument {
  const scratch = { kind: -1, owner: -1 };
  let at = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0, doc: AltiumDocument | undefined;
  while (at < data.length) {
    let end = at;
    while (end < data.length && data[end] !== 0x0a) end++;
    let last = end;
    if (last > at && data[last - 1] === 0x0d) last--;
    let first = at;
    while (first < last && (data[first] === 0x20 || data[first] === 0x09)) first++;
    if (last - first > ALTIUM_SCH_LIMITS.maxRecordBytes) throw fail(`An Altium ASCII record of ${last - first} bytes exceeds the ${ALTIUM_SCH_LIMITS.maxRecordBytes} byte limit.`, 'LIMIT_EXCEEDED');
    if (last > first) {
      if (!doc) doc = emptyDocument(data, true, cp1252.decode(data.subarray(first, Math.min(last, first + HEADER_SCAN))));
      else if (data[first] !== 0x7c) throw fail(`An Altium ASCII record at byte ${first} does not start with "|".`);
      else if (keyAt(data, first + 1, last, 'header=')) { doc.trailerBytes = data.length - first; break; }
      else push(doc, first, last, scratch, false);
    }
    at = end + 1;
  }
  if (!doc) throw fail('The Altium ASCII schematic is empty.');
  return doc;
}

// ---------------------------------------------------------------------------------------------------------------
// Record properties
// ---------------------------------------------------------------------------------------------------------------

const NUMBER_INT = /^[+-]?\d{1,15}$/, NUMBER_DEC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/, DECIMAL_COMMA = /^([+-]?\d{1,15}),(\d{1,15}(?:[eE][+-]?\d+)?)$/;
const UTF8_PREFIX = '%UTF8%';

/** Case-insensitive key/value view of one record. Altium omits zero and empty values, so every accessor has a default. */
export class Props {
  private readonly values = new Map<string, string>();
  /** Highest N of an X<N>/Y<N> key, and how many such keys the record has: both bound the vertex loops of a hostile LocationCount. */
  maxVertexKey = 0;
  vertexKeys = 0;
  constructor(readonly where: string, text: string, utf8Text?: string) {
    const fromUtf8 = new Set<string>();
    const take = (field: string, wantUtf8: boolean): void => {
      const eq = field.indexOf('=');
      if (eq <= 0) return;
      let key = field.slice(0, eq).trim().toUpperCase();
      const marked = key.startsWith(UTF8_PREFIX);
      if (marked) key = key.slice(UTF8_PREFIX.length);
      if (marked !== wantUtf8) return;
      if (!marked && (this.values.has(key) || fromUtf8.has(key))) return; // first occurrence wins
      if (marked) fromUtf8.add(key);
      this.values.set(key, field.slice(eq + 1));
      const lead = key.charCodeAt(0);
      if ((lead === 0x58 || lead === 0x59) && key.length <= 8) {
        const vertex = /^[XY](\d{1,7})$/.exec(key);
        if (vertex) { this.vertexKeys++; if (Number(vertex[1]) > this.maxVertexKey) this.maxVertexKey = Number(vertex[1]); }
      }
    };
    // A %UTF8% twin carries the exact text; the plain key holds the ANSI rendering of the same value.
    if (utf8Text !== undefined) for (const field of utf8Text.split('|')) take(field, true);
    for (const field of text.split('|')) take(field, false);
  }
  has(key: string): boolean { return this.values.has(key); }
  get(key: string): string | undefined { return this.values.get(key); }
  str(key: string, fallback = ''): string { return this.values.get(key) ?? fallback; }
  int(key: string, fallback = 0): number {
    const value = this.values.get(key);
    if (value === undefined || value.trim() === '') return fallback;
    const text = value.trim();
    if (!NUMBER_INT.test(text)) throw fail(`${this.where}: ${key} is not an integer ("${text.slice(0, 24)}").`);
    return Number(text);
  }
  float(key: string, fallback = 0): number {
    const value = this.values.get(key);
    if (value === undefined || value.trim() === '') return fallback;
    // The line-based export is written in the exporting machine's locale: real files carry decimal commas ("STARTANGLE=5,595").
    const text = value.trim().replace(DECIMAL_COMMA, '$1.$2');
    const result = NUMBER_DEC.test(text) ? Number(text) : Number.NaN;
    if (!Number.isFinite(result)) throw fail(`${this.where}: ${key} is not a number ("${text.slice(0, 24)}").`);
    return result;
  }
  bool(key: string): boolean { return (this.values.get(key) ?? '').trim().toUpperCase() === 'T'; }
  /** A length in sheet units (10 mil), with the optional ..._FRAC part in 1/100000 unit, e.g. Location.X=300 Location.X_Frac=50000. */
  units(key: string, fallback = 0): number {
    const whole = this.float(key, fallback), frac = this.float(`${key}_FRAC`, 0);
    return whole + frac / 100000;
  }
}

/** Decoded properties of record `index`; text is decoded here, once, and a %UTF8% twin is read from the UTF-8 view of the bytes. */
export function recordProps(doc: AltiumDocument, index: number): Props {
  const bytes = doc.data.subarray(doc.start[index], doc.end[index]);
  let length = bytes.indexOf(0);
  if (length < 0) length = bytes.length;
  const raw = bytes.subarray(0, length), text = cp1252.decode(raw);
  const twin = text.includes('%') && /\|%UTF8%/i.test(text) ? utf8.decode(raw) : undefined;
  return new Props(`Altium record ${index} (RECORD=${doc.kind[index]})`, text, twin);
}

export const MAX_DOCUMENTS = SCHEMATIC_LIMITS.maxSheetDefs;

// ---------------------------------------------------------------------------------------------------------------
// Project file (.PrjPcb): the sheet list and the net identifier scope
// ---------------------------------------------------------------------------------------------------------------

export interface AltiumProject {
  /** [Design] HierarchyMode when present. */
  hierarchyMode?: number;
  /** DocumentPath of every [DocumentN] section, in file order, as written. */
  documents: string[];
}

export function parseProject(bytes: Uint8Array): AltiumProject {
  if (bytes.length > ALTIUM_SCH_LIMITS.maxProjectBytes) throw fail('The Altium project file is larger than 1 MiB.', 'LIMIT_EXCEEDED');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = cp1252.decode(bytes); }
  const project: AltiumProject = { documents: [] };
  let section = '';
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    if (line.startsWith('[')) { section = line.slice(1, line.indexOf(']') < 0 ? undefined : line.indexOf(']')).toUpperCase(); continue; }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toUpperCase(), value = line.slice(eq + 1).trim();
    if (section === 'DESIGN' && key === 'HIERARCHYMODE' && /^\d{1,3}$/.test(value)) project.hierarchyMode = Number(value);
    else if (/^DOCUMENT\d{1,6}$/.test(section) && key === 'DOCUMENTPATH' && value) {
      if (project.documents.length >= ALTIUM_SCH_LIMITS.maxProjectDocuments) throw fail('The Altium project lists too many documents.', 'LIMIT_EXCEEDED');
      project.documents.push(value);
    }
  }
  return project;
}
