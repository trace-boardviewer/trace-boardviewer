/** Original bounded reader for #Layout# / #Nail# / #Pin# CSV text boardviews. */
import type { Board } from '../types';
import { BoardFormatError, MAX_IMPORT_BYTES, number, type ParseInput } from './common';
import { assembleBvTables, isBvMilAnnotation, type BvTables } from './bv-model';
import { CSV_FLAG_FIELD_CUT, CSV_FLAG_TOO_MANY_FIELDS, decodeChunks, detectEncoding, tokenizeAll, type EncodingGuess } from './pinlist-csv-reader';
import type { JetValue } from './bv-jet';

export const BV2_FORMAT = 'BV2 text boardview';
type Section = 'Layout' | 'Nail' | 'Pin';
const SECTIONS: Section[] = ['Layout', 'Nail', 'Pin'];
const HEADERS: Record<Section, readonly string[]> = { Layout: ['x', 'y', 'r'], Nail: ['nail', 'x', 'y', 'type', 'grid', 'tb', 'net', 'netname'], Pin: ['part', 'tb', 'pin', 'name', 'x', 'y', 'layer', 'netname'] };
const COLUMNS: Record<Section, readonly string[]> = { Layout: ['X', 'Y', 'R', 'Group'], Nail: ['Nail', 'X', 'Y', 'Type', 'Grid', 'TB', 'NET', 'NetName'], Pin: ['Part', 'TB', 'Pin', 'Name', 'X', 'Y', 'Layer', 'Net'] };
const NUMERIC: Record<Section, ReadonlySet<string>> = { Layout: new Set(['X', 'Y', 'R', 'Group']), Nail: new Set(['X', 'Y', 'Type']), Pin: new Set(['Pin', 'X', 'Y', 'Layer']) };
export function hasBv2Header(data: Uint8Array): boolean {
  try {
    const head = data.subarray(0, 512), encoding = detectEncoding(head, 512);
    return encoding !== null && /^[ \t\r\n]*#Layout#(?:\r\n|\r|\n|$)/.test(new TextDecoder(encoding.encoding).decode(head.subarray(encoding.bomLength)));
  }
  catch { return false; }
}
function reject(message: string, code: 'INVALID_FORMAT' | 'LIMIT_EXCEEDED' | 'UNSUPPORTED_VARIANT' = 'INVALID_FORMAT'): never { throw new BoardFormatError(`BV2: ${message}`, code, BV2_FORMAT); }
function checkQuotes(data: Uint8Array, encoding: EncodingGuess): void {
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  for (const chunk of decodeChunks(data, encoding)) for (let i = 0; i < chunk.length; i++) {
    const char = chunk[i];
    if (state === 'quoted') { if (char === '"') state = 'closed'; continue; }
    if (state === 'closed' && char === '"') { state = 'quoted'; continue; }
    if (char === ',' || char === '\r' || char === '\n') { state = 'start'; continue; }
    if (state === 'closed' || char === '"' && state === 'plain') reject('stray quote in CSV record.');
    state = char === '"' ? 'quoted' : 'plain';
  }
  if (state === 'quoted') reject('unterminated quote in CSV record.');
}

export function readBv2Tables(data: Uint8Array): BvTables | null {
  if (!hasBv2Header(data)) return null;
  if (data.length > MAX_IMPORT_BYTES) reject('input exceeds the byte limit.', 'LIMIT_EXCEEDED');
  const encoding = detectEncoding(data); if (!encoding) reject('binary input is not a CSV boardview.');
  if (encoding.encoding === 'utf-16le' || encoding.encoding === 'utf-16be') {
    if ((data.length - encoding.bomLength) % 2) reject('truncated UTF-16 text.');
    const decoder = new TextDecoder(encoding.encoding, { fatal: true });
    try { for (let at = encoding.bomLength; at < data.length; at += 65536) decoder.decode(data.subarray(at, Math.min(data.length, at + 65536)), { stream: at + 65536 < data.length }); }
    catch { reject('invalid UTF-16 text.'); }
  }
  checkQuotes(data, encoding);
  const tables: BvTables = { layout: [], pins: [], nails: [], hasGroup: false }, seen = new Set<Section>();
  let current: Section | undefined, header = false, fieldCount = 0;
  try {
    tokenizeAll(data, encoding, ',', record => {
      if (record.flags) reject(`malformed or oversized CSV record at line ${record.line}.`, record.flags & (CSV_FLAG_FIELD_CUT | CSV_FLAG_TOO_MANY_FIELDS) ? 'LIMIT_EXCEEDED' : 'INVALID_FORMAT');
      const fields = record.fields;
      if (fields.length === 1 && /^#[^#]+#$/.test(fields[0])) {
        if (header) reject('a section is missing its column header.');
        const label = fields[0].slice(1, -1); if (!SECTIONS.includes(label as Section)) reject('unknown CSV boardview section.', 'UNSUPPORTED_VARIANT');
        current = label as Section; if (seen.has(current)) reject('duplicate CSV boardview section.'); seen.add(current); header = true; return;
      }
      if (!current) reject('a record occurs before the first section.');
      if (header) {
        const expected = [...HEADERS[current]], actual = fields.map(field => field.trim().toLowerCase());
        if (current === 'Layout' && actual.length === 4 && actual[3] === 'group') { expected.push('group'); tables.hasGroup = true; }
        if (actual.length !== expected.length || actual.some((field, i) => field !== expected[i])) reject('unsupported CSV column header.', 'UNSUPPORTED_VARIANT');
        fieldCount = actual.length; header = false; return;
      }
      if (fields.length !== fieldCount) reject(`wrong field count at line ${record.line}.`);
      const target = current === 'Layout' ? tables.layout : current === 'Pin' ? tables.pins : tables.nails;
      if (current === 'Layout' ? target.length >= 200_000 : tables.pins.length + tables.nails.length >= 1_000_000) reject('row count exceeds the import limit.', 'LIMIT_EXCEEDED');
      const row: Record<string, JetValue> = Object.create(null);
      fields.forEach((field, i) => {
        const key = COLUMNS[current!][i];
        row[key] = current === 'Nail' && key === 'Type' && (isBvMilAnnotation(field) || field === 'NO_PROBE') ? field : NUMERIC[current!].has(key) ? number(field, `${current} ${key}`) : field;
      });
      if (current === 'Nail') row.VirtualPinVia = '';
      target.push(row);
    }, { maxFieldChars: 8192, maxFields: 16, maxRecordChars: 131072 });
  } catch (error) {
    if (!(error instanceof BoardFormatError) || error.format) throw error;
    throw new BoardFormatError(`BV2: ${error.message}`, error.code, BV2_FORMAT);
  }
  if (header) reject('a section is missing its column header.');
  if (seen.size !== SECTIONS.length) reject('Layout, Nail and Pin sections are all required.');
  return tables;
}
export function parseBv2(input: ParseInput): Board | null {
  const tables = readBv2Tables(input.data); return tables ? assembleBvTables(input, tables, BV2_FORMAT) : null;
}
