/**
 * Readings as CSV, for spreadsheets (docs/READINGS_FORMAT.md, "CSV").
 *
 * Export (`readingsToCsv`): RFC 4180 with a UTF-8 byte order mark (spreadsheet programs need it to read UTF-8), comma separated,
 * CRLF line ends, a header row with every column of `CSV_COLUMNS` in that order and one row per reading. Numbers are written in the
 * shortest form that reads back as the same double. A text cell that a spreadsheet would run as a formula (it starts with = + - @,
 * a tab or a carriage return, after any leading apostrophes) gets one more apostrophe in front, and import removes exactly one, so
 * the escape is lossless. electron/readings.cjs writes the identical bytes.
 *
 * Import (`parseReadingsCsv`): the header names the columns (case and blanks do not matter, order is free, unknown columns are
 * reported and ignored); comma, semicolon or tab is detected from the header row; with a semicolon a decimal comma is accepted.
 * `value` may also hold text such as "412mV", "4k7" or "OL" (read with parseReadingValue). Rows that do not form a valid reading are
 * reported with their row number and skipped; the others are returned validated. parseReadingsCsv(readingsToCsv(r)) equals r.
 */
import { READINGS_LIMITS, UNIT_OF, ReadingsError, isReadingId, validateReading } from './schema';
import type { Reading, ReadingKind, ReadingSource, ReadingsPack } from './schema';
import { parseReadingValue } from './value';

export const CSV_COLUMNS = [
  'id', 'kind', 'ref', 'pin', 'net', 'value', 'unit', 'ol', 'connected', 'raw', 'power', 'state', 'reference_ref', 'reference_pin', 'reference_net',
  'polarity', 'meter_mode', 'meter', 'tol_abs', 'tol_rel', 'source', 'license', 'origin', 'title', 'attribution', 'source_id', 'imported_at', 'taken_at', 'note',
] as const;
export type CsvColumn = typeof CSV_COLUMNS[number];

/** Largest CSV text accepted (characters), longest cell, most columns. */
export const MAX_CSV_TEXT = 32 * 1024 * 1024;
const MAX_CELL = 8192;
const MAX_COLUMNS = 64;

const FORMULA = /^'*[=+\-@\t\r]/;
const escapeFormula = (text: string): string => (FORMULA.test(text) ? `'${text}` : text);
const unescapeFormula = (text: string): string => (text.charCodeAt(0) === 39 && FORMULA.test(text) ? text.slice(1) : text);
const NEEDS_QUOTES = /[",\r\n]/;

function textCell(value: string | undefined): string {
  if (value === undefined) return '';
  const text = escapeFormula(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const numberCell = (value: number | undefined): string => (value === undefined ? '' : String(value));

function row(reading: Reading): string {
  const c = reading.conditions;
  const p = reading.provenance;
  return [
    textCell(reading.id), reading.kind, textCell(reading.target.ref), textCell(reading.target.pin), textCell(reading.target.net),
    numberCell(reading.value), reading.unit ?? '', reading.ol ? 'true' : '', reading.connected === undefined ? '' : String(reading.connected), textCell(reading.raw),
    c.power, textCell(c.state), textCell(c.reference?.ref), textCell(c.reference?.pin), textCell(c.reference?.net),
    c.polarity ?? '', c.meterMode ?? '', textCell(c.meter), numberCell(reading.tolerance?.abs), numberCell(reading.tolerance?.rel),
    reading.source, textCell(reading.license), p?.origin ?? '', textCell(p?.title), textCell(p?.attribution), textCell(p?.sourceId), textCell(p?.importedAt),
    textCell(reading.takenAt), textCell(reading.note),
  ].join(',');
}

/** CSV text of readings (BOM, header, CRLF). */
export function readingsToCsv(readings: readonly Reading[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const reading of readings) lines.push(row(reading));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** The reading with `license` inserted at its canonical place (after `source`). */
function withLicense(reading: Reading, license: string): Reading {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(reading)) {
    result[key] = value;
    if (key === 'source') result.license = license;
  }
  return result as unknown as Reading;
}

/** CSV of a pack: a reading without a licence of its own gets the pack's, so every row names its licence (a CSV has no header fields). */
export function packToCsv(pack: ReadingsPack): string {
  return readingsToCsv(pack.readings.map(reading => (reading.license === undefined ? withLicense(reading, pack.license) : reading)));
}

// ---------------------------------------------------------------------------------------------------------------
// Reading CSV
// ---------------------------------------------------------------------------------------------------------------

/** RFC 4180 records (quoted cells may hold the separator, quotes and line breaks). Linear; throws on an unterminated quote or a bound. */
export function parseCsvRecords(text: string, separator: string, maxRecords: number): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const sep = separator.charCodeAt(0);
  const endCell = () => {
    if (cell.length > MAX_CELL) throw new ReadingsError('READINGS_INVALID', `Invalid readings: CSV row ${records.length + 1} has a cell longer than ${MAX_CELL} characters.`);
    record.push(cell);
    if (record.length > MAX_COLUMNS) throw new ReadingsError('READINGS_INVALID', `Invalid readings: CSV row ${records.length + 1} has more than ${MAX_COLUMNS} columns.`);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    if (!(record.length === 1 && record[0] === '')) {
      records.push(record);
      if (records.length > maxRecords) throw new ReadingsError('READINGS_TOO_MANY', `Invalid readings: a CSV file holds at most ${maxRecords - 1} readings.`);
    }
    record = [];
  };
  let start = index;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (quoted) {
      if (code === 34) {
        if (text.charCodeAt(index + 1) === 34) { cell += text.slice(start, index + 1); index += 2; start = index; continue; }
        cell += text.slice(start, index); quoted = false; index++; start = index; continue;
      }
      index++; continue;
    }
    if (code === 34 && index === start && cell === '') { quoted = true; index++; start = index; continue; }
    if (code === sep) { cell += text.slice(start, index); endCell(); index++; start = index; continue; }
    if (code === 13 || code === 10) {
      cell += text.slice(start, index); endRecord();
      index += code === 13 && text.charCodeAt(index + 1) === 10 ? 2 : 1; start = index; continue;
    }
    index++;
  }
  if (quoted) throw new ReadingsError('READINGS_INVALID', 'Invalid readings: a quoted CSV cell is not closed.');
  cell += text.slice(start, index);
  if (cell !== '' || record.length > 0) endRecord();
  return records;
}

function detectSeparator(text: string): string {
  let comma = 0, semicolon = 0, tab = 0, quoted = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 34) quoted = !quoted;
    else if (!quoted && (code === 10 || code === 13)) break;
    else if (!quoted) { if (code === 44) comma++; else if (code === 59) semicolon++; else if (code === 9) tab++; }
  }
  if (semicolon > comma && semicolon >= tab) return ';';
  if (tab > comma && tab > semicolon) return '\t';
  return ',';
}

export interface CsvIssue { row: number; message: string }
export interface CsvParse {
  readings: Reading[];
  /** Rows (1-based, the header is row 1) that were skipped, and why. */
  issues: CsvIssue[];
  /** Header names that are not columns of the format. */
  unknownColumns: string[];
  /** Rows without a `power` cell, read as voltage = powered, others = unpowered. */
  powerAssumed: number;
}
export interface CsvOptions {
  /** Source of rows without a `source` cell; default known-good. */
  defaultSource?: ReadingSource;
  /** Id for rows without an `id` cell. */
  newId?: () => string;
}

const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const COMMA_NUMBER = /^[+-]?\d+,\d+$/;
const TRUE_WORDS: ReadonlySet<string> = new Set(['true', '1', 'yes', 'y']);
const FALSE_WORDS: ReadonlySet<string> = new Set(['false', '0', 'no', 'n']);

function numberOf(text: string, decimalComma: boolean): number | null {
  if (PLAIN_NUMBER.test(text)) return Number(text);
  if (decimalComma && COMMA_NUMBER.test(text)) return Number(text.replace(',', '.'));
  return null;
}

/** Reads CSV text into validated readings; never throws for a bad row (only for an unreadable file: unclosed quote, bounds). */
export function parseReadingsCsv(text: string, options: CsvOptions = {}): CsvParse {
  if (text.length > MAX_CSV_TEXT) throw new ReadingsError('READINGS_TOO_LARGE', 'The readings file is too large.');
  const separator = detectSeparator(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const records = parseCsvRecords(text, separator, READINGS_LIMITS.readings + 1);
  const result: CsvParse = { readings: [], issues: [], unknownColumns: [], powerAssumed: 0 };
  if (records.length === 0) return result;
  const known = new Set<string>(CSV_COLUMNS);
  const columns = new Map<CsvColumn, number>();
  records[0].forEach((name, index) => {
    const key = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (known.has(key) && !columns.has(key as CsvColumn)) columns.set(key as CsvColumn, index);
    else result.unknownColumns.push(name);
  });
  const decimalComma = separator === ';';
  const ids = new Set<string>();
  for (let index = 1; index < records.length; index++) {
    const record = records[index];
    const cell = (column: CsvColumn): string | undefined => {
      const at = columns.get(column);
      if (at === undefined) return undefined;
      const value = record[at];
      return value === undefined || value === '' ? undefined : unescapeFormula(value);
    };
    const rowNumber = index + 1;
    try {
      const kind = cell('kind')?.trim().toLowerCase() as ReadingKind | undefined;
      const raw: Record<string, unknown> = { id: cell('id') ?? options.newId?.(), kind };
      const target: Record<string, unknown> = {};
      if (cell('ref') !== undefined) target.ref = cell('ref');
      if (cell('pin') !== undefined) target.pin = cell('pin');
      if (cell('net') !== undefined) target.net = cell('net');
      raw.target = target;
      const valueText = cell('value')?.trim();
      const unitText = cell('unit')?.trim();
      if (valueText !== undefined && kind !== undefined && kind !== 'continuity' && Object.hasOwn(UNIT_OF, kind)) {
        const number = numberOf(valueText, decimalComma);
        if (number !== null) { raw.value = number; raw.unit = unitText === undefined ? UNIT_OF[kind as keyof typeof UNIT_OF] : normalizeUnit(unitText); }
        else {
          const parsed = parseReadingValue(valueText, kind, { bareDiodeMillivolts: false });
          if (!parsed.ok) throw new ReadingsError('READINGS_INVALID', `Invalid readings: value "${valueText.slice(0, 32)}" (${parsed.reason}).`);
          if ('ol' in parsed) raw.ol = true; else if ('value' in parsed) { raw.value = parsed.value; raw.unit = parsed.unit; }
        }
      } else if (valueText !== undefined) raw.value = valueText;
      const ol = cell('ol')?.trim().toLowerCase();
      if (ol !== undefined && ol !== 'false' && ol !== '0' && ol !== 'no') raw.ol = TRUE_WORDS.has(ol) || ol === 'ol' ? true : ol;
      const connected = cell('connected')?.trim().toLowerCase();
      if (connected !== undefined) raw.connected = TRUE_WORDS.has(connected) || connected === 'beep' ? true : FALSE_WORDS.has(connected) ? false : connected;
      if (cell('raw') !== undefined) raw.raw = cell('raw');
      const power = cell('power')?.trim().toLowerCase();
      const conditions: Record<string, unknown> = { power: power ?? (kind === 'voltage' ? 'powered' : 'unpowered') };
      if (power === undefined) result.powerAssumed++;
      if (cell('state') !== undefined) conditions.state = cell('state');
      const reference: Record<string, unknown> = {};
      if (cell('reference_ref') !== undefined) reference.ref = cell('reference_ref');
      if (cell('reference_pin') !== undefined) reference.pin = cell('reference_pin');
      if (cell('reference_net') !== undefined) reference.net = cell('reference_net');
      if (Object.keys(reference).length > 0) conditions.reference = reference;
      if (cell('polarity') !== undefined) conditions.polarity = cell('polarity')?.trim().toLowerCase();
      if (cell('meter_mode') !== undefined) conditions.meterMode = cell('meter_mode')?.trim().toLowerCase();
      if (cell('meter') !== undefined) conditions.meter = cell('meter');
      raw.conditions = conditions;
      const abs = cell('tol_abs')?.trim(), rel = cell('tol_rel')?.trim();
      if (abs !== undefined || rel !== undefined) {
        const tolerance: Record<string, unknown> = {};
        if (abs !== undefined) tolerance.abs = numberOf(abs, decimalComma) ?? abs;
        if (rel !== undefined) tolerance.rel = numberOf(rel, decimalComma) ?? rel;
        raw.tolerance = tolerance;
      }
      raw.source = cell('source')?.trim().toLowerCase() ?? options.defaultSource ?? 'known-good';
      if (cell('license') !== undefined) raw.license = cell('license')?.trim();
      const origin = cell('origin')?.trim().toLowerCase();
      if (origin !== undefined || cell('title') !== undefined || cell('attribution') !== undefined || cell('source_id') !== undefined || cell('imported_at') !== undefined) {
        const provenance: Record<string, unknown> = { origin };
        if (cell('title') !== undefined) provenance.title = cell('title');
        if (cell('attribution') !== undefined) provenance.attribution = cell('attribution');
        if (cell('source_id') !== undefined) provenance.sourceId = cell('source_id');
        if (cell('imported_at') !== undefined) provenance.importedAt = cell('imported_at')?.trim();
        raw.provenance = provenance;
      }
      if (cell('taken_at') !== undefined) raw.takenAt = cell('taken_at')?.trim();
      if (cell('note') !== undefined) raw.note = cell('note');
      if (raw.id !== undefined && !isReadingId(raw.id)) throw new ReadingsError('READINGS_INVALID', 'Invalid readings: id.');
      const reading = validateReading(raw, 'row');
      if (ids.has(reading.id)) throw new ReadingsError('READINGS_INVALID', `Invalid readings: id ${reading.id} appears twice.`);
      ids.add(reading.id);
      result.readings.push(reading);
    } catch (error) {
      if (!(error instanceof ReadingsError)) throw error;
      result.issues.push({ row: rowNumber, message: error.message });
    }
  }
  return result;
}

function normalizeUnit(text: string): string {
  if (text === 'V' || text === 'v') return 'V';
  if (text === 'Ω' || text === 'Ω' || /^(ohms?|r)$/i.test(text)) return 'ohm';
  return text;
}
