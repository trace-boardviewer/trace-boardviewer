/*
 * Generic pin-list importer: a CSV, TSV or other delimited list with one row per pin (reference designator, pin, net, X, Y,
 * side) becomes a board. Original TRACE module (MIT). The row format is TRACE's own definition, not a vendor format: any CAD
 * report, assembly export or test-fixture export that can be turned into such a table can be read, and the importer says how it
 * understood the table so that a person can confirm or correct it.
 *
 * Two steps, both pure functions of the bytes and the options:
 *   - analysePinList(data, options): looks at the first 64 KiB only and returns a PinListAnalysis, the "column mapping result":
 *     encoding, delimiter, header row, which column was taken for which role and why, decimal separator, unit, how the side
 *     column reads, a few sample rows, and a list of what still needs a person's confirmation. It never throws.
 *   - parsePinList(input, options) / readPinList + buildPinListBoard: reads the whole file with the mapping (the options replace
 *     any part of the analysis), streams it in chunks (see pinlist-csv-reader.ts) and builds the board.
 * The adapter claims a file only when its header names a reference designator, a pin, X and Y (sniffPinList says how sure it is);
 * a caller that has confirmed a mapping passes it in the options and no claim is needed.
 *
 * What the file gives and what is estimated: nets and positions are exactly as listed; the list has no pad sizes (pads are drawn
 * at a default size), no component bodies (the box around the pins of a reference) and no outline (the extent of all pins).
 * Part sides are the sides of their pins: a part whose pins are on different sides is shown on both.
 */
import type { Board, BoardSide } from '../types';
import { BoardFormatError, buildBoard, MAX_IMPORT_BYTES, note, type ParseInput, type RawBoard, type RawPart, type RawPin } from './common';
import {
  guessDecimal, guessUnit, headerRole, isNoNet, looksLikeRefdes, parseNumber, PINLIST_REQUIRED, PINLIST_ROLES, PINLIST_UNIT_MM, sideOfWord, unitOfWord,
  type Decimal, type DecimalGuess, type PinListRole, type PinListUnit,
} from './pinlist-csv-columns';
import {
  CSV_DELIMITERS, CSV_FLAG_FIELD_CUT, CSV_FLAG_STRAY_QUOTE, CSV_FLAG_TOO_MANY_FIELDS, CSV_FLAG_UNTERMINATED_QUOTE, CsvTokenizer, DEFAULT_CSV_LIMITS, decodeChunks, detectEncoding,
  type CsvDelimiter, type CsvEncoding, type CsvLimits, type CsvRecord, type EncodingGuess,
} from './pinlist-csv-reader';

export { PINLIST_REQUIRED, PINLIST_ROLES, PINLIST_UNIT_MM, guessDecimal, guessUnit, headerRole, parseNumber, sideOfWord } from './pinlist-csv-columns';
export type { Decimal, DecimalGuess, PinListRole, PinListUnit } from './pinlist-csv-columns';
export { CSV_DELIMITERS, CsvTokenizer, decodeChunks, detectEncoding, tokenizeAll } from './pinlist-csv-reader';
export type { CsvDelimiter, CsvEncoding, CsvLimits, CsvRecord, EncodingGuess } from './pinlist-csv-reader';

export const PINLIST_FORMAT = 'Pin list (CSV/TSV)';
/** The adapter claims bytes the sniffer is at least this sure about. */
export const PINLIST_CLAIM_CONFIDENCE = 0.5;
/** Mirrors the budgets of common.buildBoard, so a hostile file fails while it is read and not after it has been stored. */
export const PINLIST_MAX_PINS = 1_000_000;
export const PINLIST_MAX_PARTS = 250_000;

/** Zero-based column index per role. */
export type PinListMapping = Partial<Record<PinListRole, number>>;
export type PinListColumnSource = 'header' | 'content' | 'user';

export interface PinListOptions {
  /** Replaces the detected delimiter. */
  delimiter?: CsvDelimiter;
  /** true: the first record (after any lines before the header that are recognised) is the header; false: there is none. Default: detected. */
  hasHeader?: boolean;
  /** Column per role, by zero-based index or by header text; null removes a role. Roles that are not named keep the detected column. */
  mapping?: Partial<Record<PinListRole, number | string | null>>;
  /** Replaces the detected decimal separator of the coordinates. */
  decimal?: Decimal;
  /** The unit of the coordinates (a unit written after a number, such as "12.5 mm", still wins for that number). */
  unit?: PinListUnit;
  /** Millimetres per file unit when the unit is none of the named ones; takes precedence over `unit`. */
  unitsToMm?: number;
  /** Side of a pin whose side cell is empty or not a known word, and of every pin when there is no side column. Default "top". */
  defaultSide?: BoardSide;
  /** Side words of this file, by upper- or lower-case text, for values the importer does not know ("1", "2", "Comp"). Takes precedence over the built-in words. */
  sideMap?: Record<string, BoardSide>;
  /** The file's Y axis points down: Y is negated. */
  flipY?: boolean;
  limits?: { maxPins?: number; maxParts?: number };
}

export interface PinListColumn {
  index: number;
  /** The header cell, or "Column N" (1-based) when the file has no header. */
  header: string;
  role?: PinListRole;
  /** How the role was chosen: a header word, the look of the values (a guess), or the caller. */
  source?: PinListColumnSource;
  /** 0 to 1; a header word is 0.6 to 1, a guess from the values 0.4. */
  confidence: number;
  /** Up to three different non-empty values from the sample. */
  samples: string[];
  /** The unit named by the header ("X (mm)"). */
  unit?: PinListUnit;
}
export interface PinListIssue { code: string; message: string; line?: number }
export interface PinListUnitChoice {
  unit: PinListUnit | 'custom';
  mmPerUnit: number;
  /** user: the options; header: "X (mm)"; preamble: a "Units: mil" line before the header; value: every number carries its unit; guess: from the size of the board; default: nothing fits, millimetres. */
  source: 'user' | 'header' | 'preamble' | 'value' | 'guess' | 'default';
  confidence: number;
  /** Units that give a plausible board size (8 to 1000 mm across); empty unless the unit was guessed. */
  candidates: PinListUnit[];
}
export interface PinListSideSummary {
  column?: number;
  top: number; bottom: number; both: number;
  /** Rows whose side cell is empty. */
  blank: number;
  /** Rows whose side cell is not a known word (and not in the caller's sideMap). */
  unknownCount: number;
  /** Up to 8 of those words. */
  unknown: string[];
}
export type PinListConfirm = 'columns' | 'unit' | 'decimal' | 'side';
export interface PinListAnalysis {
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
  delimiterSource: 'user' | 'sep-line' | 'detected';
  hasHeader: boolean;
  /** 1-based physical line of the header (0: none). */
  headerLine: number;
  /** Records in front of the header (titles, notes); they are skipped. */
  preambleRecords: number;
  columns: PinListColumn[];
  mapping: PinListMapping;
  /** Roles the board needs (reference designator, pin, X, Y) that no column has. */
  missing: PinListRole[];
  decimal: Decimal;
  decimalSource: 'user' | 'detected' | 'default';
  unit: PinListUnitChoice;
  side: PinListSideSummary;
  /** The first data records, as text. */
  sampleRows: string[][];
  /** Data records in the sample, and whether the sample is the whole file. */
  sampleRecords: number;
  sampleComplete: boolean;
  /** 0 (not a pin list) to 0.95. At least PINLIST_CLAIM_CONFIDENCE and the adapter claims the file. */
  confidence: number;
  /** The mapping should be shown to a person before the file is imported. */
  needsConfirmation: boolean;
  confirm: PinListConfirm[];
  issues: PinListIssue[];
  reason: string;
}

export interface PinListSniff {
  confidence: number;
  delimiter?: CsvDelimiter;
  hasHeader?: boolean;
  /** Roles found, by header words. */
  roles: PinListRole[];
  reason: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// layout detection (the sample)

const SAMPLE_BYTES = 1 << 16, SAMPLE_RECORDS = 400, HEADER_SEARCH_RECORDS = 25, MAX_COLUMNS_SHOWN = 128, MAX_ISSUE_EXAMPLES = 8;
const SAMPLE_LIMITS: CsvLimits = { maxFieldChars: 512, maxRecordChars: 1 << 17, maxFields: 128 };
const SEP_LINE = /^sep=(.)[ \t]*(?:\r\n|\r|\n)/i;

function tokenizeSample(text: string, delimiter: CsvDelimiter, complete: boolean): CsvRecord[] {
  const records: CsvRecord[] = [];
  try {
    new CsvTokenizer(delimiter, record => { records.push(record); return records.length < SAMPLE_RECORDS; }, SAMPLE_LIMITS).push(text, complete);
  } catch { /* a record longer than the sample limit: what came before it is the sample */ }
  return records;
}

type HeaderCells = Array<ReturnType<typeof headerRole>>;
const headerCells = (fields: readonly string[]): HeaderCells => fields.map(cell => headerRole(cell.trim()));
const distinctRoles = (cells: HeaderCells): Set<PinListRole> => new Set(cells.filter(Boolean).map(cell => cell!.role));
/** Index of the first record in the sample that reads as a header (at least three roles, or a reference designator and a pin), or -1. */
function findHeader(records: readonly CsvRecord[]): number {
  for (let index = 0; index < records.length && index < HEADER_SEARCH_RECORDS; index++) {
    const fields = records[index].fields;
    if (fields.length < 3) continue;
    const roles = distinctRoles(headerCells(fields));
    if (roles.size >= 3 || roles.has('refdes') && roles.has('pin')) return index;
  }
  return -1;
}
function modalCount(records: readonly CsvRecord[]): { modal: number; share: number } {
  const counts = new Map<number, number>();
  for (const record of records) counts.set(record.fields.length, (counts.get(record.fields.length) ?? 0) + 1);
  let modal = 0, best = 0;
  for (const [fields, count] of counts) if (fields >= 2 && (count > best || count === best && fields > modal)) { modal = fields; best = count; }
  return { modal, share: records.length ? best / records.length : 0 };
}

interface Candidate { delimiter: CsvDelimiter; records: CsvRecord[]; header: number; modal: number; score: number }
function chooseDelimiter(text: string, complete: boolean, forced?: CsvDelimiter): Candidate | undefined {
  let best: Candidate | undefined;
  for (const delimiter of forced ? [forced] : CSV_DELIMITERS) {
    const records = tokenizeSample(text, delimiter, complete);
    const { modal, share } = modalCount(records);
    if (modal < 2) continue;
    const header = findHeader(records);
    const roles = header >= 0 ? distinctRoles(headerCells(records[header].fields)).size : 0;
    const score = share * 10 + roles * 2 + Math.min(modal, 10) * 0.05;
    if (!best || score > best.score) best = { delimiter, records, header, modal, score };
  }
  return best;
}

const clipText = (text: string, length = 60) => text.length > length ? text.slice(0, length) + '…' : text;
const rolesOf = (mapping: PinListMapping): PinListRole[] => PINLIST_ROLES.filter(role => mapping[role] !== undefined);

interface Profile { count: number; numeric: number; integer: number; refdes: number; side: number; short: number; distinct: Set<string>; min: number; max: number }
function profileColumn(rows: readonly string[][], index: number, decimal: Decimal): Profile {
  const profile: Profile = { count: 0, numeric: 0, integer: 0, refdes: 0, side: 0, short: 0, distinct: new Set(), min: Infinity, max: -Infinity };
  for (const row of rows) {
    const cell = (row[index] ?? '').trim();
    if (!cell) continue;
    profile.count++;
    if (profile.distinct.size < 64) profile.distinct.add(cell);
    if (cell.length <= 6) profile.short++;
    const number = cell.length <= 24 ? parseNumber(cell, decimal) : undefined;
    if (number) { profile.numeric++; if (Number.isInteger(number.value)) profile.integer++; profile.min = Math.min(profile.min, number.value); profile.max = Math.max(profile.max, number.value); }
    else { if (looksLikeRefdes(cell)) profile.refdes++; if (sideOfWord(cell)) profile.side++; }
  }
  return profile;
}
/**
 * A guess for the roles that are still missing, from what the values look like: a column of reference designators, a column of
 * side words, two neighbouring columns of spread-out numbers (X and Y), a column of short pin names, a text column of net names.
 * Used only when the header does not name the columns; never raises the confidence of the file above a header-less guess.
 */
function inferRoles(rows: readonly string[][], fieldCount: number, mapping: PinListMapping, decimal: Decimal, skip: ReadonlySet<PinListRole>): PinListMapping {
  const found: PinListMapping = {};
  if (rows.length < 2) return found;
  const used = new Set(Object.values(mapping));
  const profiles = Array.from({ length: Math.min(fieldCount, MAX_COLUMNS_SHOWN) }, (_, index) => profileColumn(rows, index, decimal));
  const free = (index: number) => !used.has(index) && profiles[index].count > 0;
  const take = (role: PinListRole, index: number | undefined) => { if (index !== undefined) { found[role] = index; used.add(index); } };
  const best = (test: (profile: Profile, index: number) => boolean, rank: (profile: Profile, index: number) => number): number | undefined => {
    let pick: number | undefined, top = -Infinity;
    profiles.forEach((profile, index) => { if (free(index) && test(profile, index)) { const value = rank(profile, index); if (value > top) { top = value; pick = index; } } });
    return pick;
  };
  if (mapping.refdes === undefined && !skip.has('refdes')) take('refdes', best((p) => p.refdes / p.count >= 0.9, (p, i) => p.refdes / p.count - i * 1e-3));
  if (mapping.side === undefined && !skip.has('side')) take('side', best((p) => p.side / p.count >= 0.9, (p, i) => -i));
  const numeric = (p: Profile) => p.numeric / p.count >= 0.95;
  const spread = (p: Profile) => p.max - p.min;
  const coordinate = (p: Profile) => numeric(p) && (p.integer / p.count < 0.95 || spread(p) > 4096);
  if (mapping.x === undefined && mapping.y === undefined && !skip.has('x') && !skip.has('y')) {
    let pair: number | undefined, top = -Infinity;
    for (let index = 0; index + 1 < profiles.length; index++) {
      if (!free(index) || !free(index + 1) || !coordinate(profiles[index]) && !coordinate(profiles[index + 1]) || !numeric(profiles[index]) || !numeric(profiles[index + 1])) continue;
      const value = spread(profiles[index]) + spread(profiles[index + 1]);
      if (value > top) { top = value; pair = index; }
    }
    if (pair !== undefined) { take('x', pair); take('y', pair + 1); }
  } else if (mapping.x !== undefined && mapping.y === undefined && !skip.has('y')) take('y', best((p, i) => numeric(p) && Math.abs(i - mapping.x!) === 1, (p, i) => i > mapping.x! ? 1 : 0));
  else if (mapping.y !== undefined && mapping.x === undefined && !skip.has('x')) take('x', best((p, i) => numeric(p) && Math.abs(i - mapping.y!) === 1, (p, i) => i < mapping.y! ? 1 : 0));
  if (mapping.pin === undefined && !skip.has('pin')) {
    const anchor = mapping.refdes ?? found.refdes;
    take('pin', best((p) => p.short / p.count >= 0.9 && !(p.refdes / p.count >= 0.9) && (p.numeric === 0 || p.integer === p.numeric && p.max <= 4096), (p, i) => anchor !== undefined && i > anchor ? 1000 - (i - anchor) : -i));
  }
  if (mapping.net === undefined && !skip.has('net')) take('net', best((p) => p.numeric / p.count < 0.5 && p.refdes / p.count < 0.9 && p.side / p.count < 0.9, (p, i) => p.distinct.size - i * 1e-3));
  return found;
}

const DEFAULT_SIDE: BoardSide = 'top';
const sideOfCell = (cell: string, sideMap: Record<string, BoardSide> | undefined): BoardSide | undefined => {
  if (sideMap) { const direct = sideMap[cell.trim()] ?? sideMap[cell.trim().toUpperCase()] ?? sideMap[cell.trim().toLowerCase()]; if (direct) return direct; }
  return sideOfWord(cell);
};

interface Inspection {
  analysis: PinListAnalysis;
  /** The decoded encoding guess; undefined for binary data. */
  guess?: EncodingGuess;
  /** First data record's ordinal among all records (records before it are the lines before the header and the header). */
  skipRecords: number;
  /** The file starts with an Excel "sep=" line (it is not a record). */
  sepLine: boolean;
  /** The first of the caller's mapping entries that names a column that does not exist. */
  mappingError?: string;
}

const emptyAnalysis = (reason: string, issue: PinListIssue, encoding: CsvEncoding = 'utf-8'): PinListAnalysis => ({
  encoding, delimiter: ',', delimiterSource: 'detected', hasHeader: false, headerLine: 0, preambleRecords: 0, columns: [], mapping: {}, missing: [...PINLIST_REQUIRED], decimal: '.', decimalSource: 'default',
  unit: { unit: 'mm', mmPerUnit: 1, source: 'default', confidence: 0, candidates: [] }, side: { top: 0, bottom: 0, both: 0, blank: 0, unknownCount: 0, unknown: [] },
  sampleRows: [], sampleRecords: 0, sampleComplete: true, confidence: 0, needsConfirmation: true, confirm: ['columns'], issues: [issue], reason,
});

function inspect(data: Uint8Array, options: PinListOptions, full: boolean): Inspection {
  const guess = detectEncoding(data, full ? Number.POSITIVE_INFINITY : 1 << 20);
  if (!guess) return { analysis: emptyAnalysis('binary data', { code: 'binary', message: 'The file is not text.' }), skipRecords: 0, sepLine: false };
  const first = decodeChunks(data, guess, SAMPLE_BYTES).next();
  let text = first.done ? '' : first.value;
  const complete = guess.bomLength + (guess.encoding === 'utf-16le' || guess.encoding === 'utf-16be' ? SAMPLE_BYTES * 2 : SAMPLE_BYTES) >= data.length;
  const issues: PinListIssue[] = [];
  let sepLine = false, forced = options.delimiter, delimiterSource: PinListAnalysis['delimiterSource'] = forced ? 'user' : 'detected';
  const sep = SEP_LINE.exec(text);
  if (sep) {
    sepLine = true; text = text.slice(sep[0].length);
    if (!forced && (CSV_DELIMITERS as readonly string[]).includes(sep[1])) { forced = sep[1] as CsvDelimiter; delimiterSource = 'sep-line'; }
  }
  const chosen = chooseDelimiter(text, complete, forced);
  if (!chosen) {
    const analysis = emptyAnalysis('no delimited table', { code: 'few-columns', message: 'No delimiter splits the first lines into at least two columns.' }, guess.encoding);
    return { analysis, guess, skipRecords: 0, sepLine };
  }
  const { delimiter, records } = chosen;
  let header = options.hasHeader === false ? -1 : chosen.header;
  if (header < 0 && options.hasHeader === true) header = 0;
  // A first record of words that no column role knows, above records that hold numbers: a header in a vocabulary we do not have.
  const numberCells = (fields: readonly string[]) => fields.filter(cell => cell.trim() && (parseNumber(cell, '.') || parseNumber(cell, ','))).length;
  if (header < 0 && options.hasHeader === undefined && records.length >= 2 && records[0].fields.length >= 3 && numberCells(records[0].fields) === 0 && numberCells(records[1].fields) >= 2) header = 0;
  if (!records.length) {
    const analysis = emptyAnalysis('no records', { code: 'no-rows', message: 'The file has no rows.' }, guess.encoding);
    return { analysis, guess, skipRecords: 0, sepLine };
  }
  const skipRecords = header + 1;
  const dataRecords = records.slice(skipRecords);
  const rows = dataRecords.map(record => record.fields.map(cell => cell.trim()));
  const fieldCount = Math.max(chosen.modal, header >= 0 ? records[header].fields.length : 0);
  const headerFields = header >= 0 ? records[header].fields.map(cell => cell.trim()) : [];
  const cells = header >= 0 ? headerCells(headerFields) : [];

  // 1. header words
  const mapping: PinListMapping = {};
  const columns: PinListColumn[] = Array.from({ length: Math.min(fieldCount, MAX_COLUMNS_SHOWN) }, (_, index) => ({ index, header: headerFields[index] || `Column ${index + 1}`, confidence: 0, samples: [] }));
  const assign = (role: PinListRole, index: number, source: PinListColumnSource, confidence: number) => {
    const previous = mapping[role];
    if (previous !== undefined && columns[previous]) { delete columns[previous].role; delete columns[previous].source; columns[previous].confidence = 0; }
    for (const other of PINLIST_ROLES) if (other !== role && mapping[other] === index) delete mapping[other];
    mapping[role] = index;
    if (columns[index]) { columns[index].role = role; columns[index].source = source; columns[index].confidence = confidence; }
  };
  for (const role of PINLIST_ROLES) {
    let pick = -1, weight = 0;
    cells.forEach((cell, index) => { if (cell && cell.role === role && cell.weight > weight && index < MAX_COLUMNS_SHOWN) { pick = index; weight = cell.weight; } });
    if (pick >= 0) assign(role, pick, 'header', weight);
  }
  cells.forEach((cell, index) => { if (cell?.unit && columns[index]) columns[index].unit = cell.unit; });
  const headerRoles = new Set(rolesOf(mapping));

  // 2. the caller's mapping
  let mappingError: string | undefined;
  const removed = new Set<PinListRole>();
  if (options.mapping) {
    for (const role of PINLIST_ROLES) {
      if (!(role in options.mapping)) continue;
      const wanted = options.mapping[role];
      if (wanted === null || wanted === undefined) { const at = mapping[role]; if (at !== undefined && columns[at]) { delete columns[at].role; delete columns[at].source; columns[at].confidence = 0; } delete mapping[role]; removed.add(role); continue; }
      let index = -1;
      if (typeof wanted === 'number') index = Number.isInteger(wanted) && wanted >= 0 && wanted < Math.max(fieldCount, 1) ? wanted : -1;
      else { const key = wanted.trim().toLowerCase(); index = headerFields.findIndex(cell => cell.toLowerCase() === key); }
      if (index < 0 || index >= MAX_COLUMNS_SHOWN) { mappingError ??= `The ${role} column ${typeof wanted === 'number' ? `number ${wanted + 1}` : `"${clipText(wanted, 40)}"`} does not exist (the table has ${fieldCount} columns${headerFields.length ? `: ${headerFields.slice(0, 12).map(cell => `"${clipText(cell, 20)}"`).join(', ')}${headerFields.length > 12 ? ', …' : ''}` : ''}).`; continue; }
      assign(role, index, 'user', 1);
    }
  }
  if (mappingError) issues.push({ code: 'unknown-column', message: mappingError });

  // 3. decimal separator and the look of the values for the roles that are still missing
  const coordinateCells = (['x', 'y'] as const).flatMap(role => mapping[role] === undefined ? [] : rows.map(row => row[mapping[role]!] ?? ''));
  const decimalGuess: DecimalGuess = guessDecimal(coordinateCells.length ? coordinateCells : rows.flat());
  const decimal: Decimal = options.decimal ?? decimalGuess.decimal;
  const decimalSource: PinListAnalysis['decimalSource'] = options.decimal ? 'user' : decimalGuess.source;
  if (PINLIST_REQUIRED.some(role => mapping[role] === undefined)) {
    const inferred = inferRoles(rows, fieldCount, mapping, decimal, removed);
    for (const role of PINLIST_ROLES) if (inferred[role] !== undefined) assign(role, inferred[role]!, 'content', 0.4);
  }
  // samples
  for (const row of rows) for (const column of columns) {
    if (column.samples.length < 3 && row[column.index] && !column.samples.includes(row[column.index])) column.samples.push(clipText(row[column.index], 40));
  }

  // 4. unit
  let unitHint: { unit: PinListUnit; source: 'header' | 'preamble' } | undefined, suffixUnit: PinListUnit | undefined;
  const headerUnits = (['x', 'y'] as const).map(role => mapping[role] === undefined ? undefined : columns[mapping[role]!]?.unit).filter(Boolean) as PinListUnit[];
  if (headerUnits.length) {
    unitHint = { unit: headerUnits[0], source: 'header' };
    if (headerUnits.some(unit => unit !== headerUnits[0])) issues.push({ code: 'unit-conflict', message: 'The X and Y headers name different units; the X unit is used.' });
  } else if (header > 0) {
    for (let index = 0; index < header && !unitHint; index++) {
      const match = /\bunits?\b\s*[:=,;]?\s*([a-zµμ"]{1,12})/i.exec(records[index].fields.join(' ').slice(0, 400));
      const unit = match ? unitOfWord(match[1]) : undefined;
      if (unit) unitHint = { unit, source: 'preamble' };
    }
  }
  const suffixes = new Map<PinListUnit | undefined, number>();
  let numbers = 0;
  for (const role of ['x', 'y'] as const) {
    if (mapping[role] === undefined) continue;
    for (const row of rows) { const cell = row[mapping[role]!]; const number = cell ? parseNumber(cell, decimal) : undefined; if (number) { numbers++; suffixes.set(number.unit, (suffixes.get(number.unit) ?? 0) + 1); } }
  }
  for (const [unit, count] of suffixes) if (unit && numbers && count / numbers >= 0.9) suffixUnit = unit;

  let extent = 0, integers = true, extentRows = 0;
  if (mapping.x !== undefined && mapping.y !== undefined) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const row of rows) {
      const x = row[mapping.x] ? parseNumber(row[mapping.x], decimal) : undefined, y = row[mapping.y] ? parseNumber(row[mapping.y], decimal) : undefined;
      if (!x || !y || x.unit || y.unit) continue;
      extentRows++; minX = Math.min(minX, x.value); maxX = Math.max(maxX, x.value); minY = Math.min(minY, y.value); maxY = Math.max(maxY, y.value);
      if (integers && !(Number.isInteger(x.value) && Number.isInteger(y.value))) integers = false;
    }
    if (extentRows) extent = Math.max(maxX - minX, maxY - minY);
  }
  let unit: PinListUnitChoice;
  if (options.unitsToMm !== undefined && options.unitsToMm > 0 && Number.isFinite(options.unitsToMm)) unit = { unit: 'custom', mmPerUnit: options.unitsToMm, source: 'user', confidence: 1, candidates: [] };
  else if (options.unit) unit = { unit: options.unit, mmPerUnit: PINLIST_UNIT_MM[options.unit], source: 'user', confidence: 1, candidates: [] };
  else if (unitHint) unit = { unit: unitHint.unit, mmPerUnit: PINLIST_UNIT_MM[unitHint.unit], source: unitHint.source, confidence: 0.95, candidates: [] };
  else if (suffixUnit) unit = { unit: suffixUnit, mmPerUnit: PINLIST_UNIT_MM[suffixUnit], source: 'value', confidence: 0.95, candidates: [] };
  else {
    const guessed = guessUnit(extent, integers);
    unit = { unit: guessed.unit, mmPerUnit: PINLIST_UNIT_MM[guessed.unit], source: guessed.candidates.length ? 'guess' : 'default', confidence: extentRows ? guessed.confidence : 0, candidates: guessed.candidates };
  }

  // 5. side
  const side: PinListSideSummary = { top: 0, bottom: 0, both: 0, blank: 0, unknownCount: 0, unknown: [] };
  if (mapping.side !== undefined) {
    side.column = mapping.side;
    for (const row of rows) {
      const cell = row[mapping.side] ?? '';
      if (!cell) { side.blank++; continue; }
      const value = sideOfCell(cell, options.sideMap);
      if (value) side[value]++;
      else { side.unknownCount++; if (side.unknown.length < MAX_ISSUE_EXAMPLES && !side.unknown.includes(clipText(cell, 24))) side.unknown.push(clipText(cell, 24)); }
    }
  }

  // 6. confidence
  const missing = PINLIST_REQUIRED.filter(role => mapping[role] === undefined);
  let readable = 0, coordinateRows = 0;
  if (mapping.x !== undefined && mapping.y !== undefined) for (const row of rows) { if (row.every(cell => !cell)) continue; coordinateRows++; if (row[mapping.x] && row[mapping.y] && parseNumber(row[mapping.x], decimal) && parseNumber(row[mapping.y], decimal)) readable++; }
  const byHeader = (role: PinListRole) => headerRoles.has(role);
  let confidence = 0, reason: string;
  if (options.mapping && !missing.length) { confidence = 0.9; reason = `the columns were chosen by the caller: ${rolesOf(mapping).join(', ')}`; }
  else if (header >= 0 && PINLIST_REQUIRED.every(byHeader)) { confidence = byHeader('net') ? 0.95 : 0.85; reason = `a header names ${rolesOf(mapping).join(', ')}`; }
  else if (header >= 0 && byHeader('refdes') && byHeader('pin') && byHeader('net')) { confidence = 0.6; reason = 'a header names reference designators, pins and nets, but no coordinates'; }
  else if (header >= 0 && headerRoles.size >= 3) { confidence = 0.35; reason = `a header names ${[...headerRoles].join(', ')}, which is not enough for a pin list`; }
  else if (!missing.length) { confidence = 0.4; reason = header >= 0 ? 'the header words are not known: the columns were guessed from the values' : 'no header: the columns were guessed from the values'; }
  else reason = header >= 0 ? 'the header does not name the columns of a pin list' : 'no header and the values do not look like a pin list';
  if (confidence >= 0.5 && !options.mapping && coordinateRows && readable / coordinateRows < 0.5) { confidence = 0.4; reason += '; most rows have no readable coordinates'; }
  if (header >= 0 && records.length <= header + 1 && complete) reason += '; the file has no data rows';
  if (header > 0) issues.push({ code: 'preamble', message: `${header} line${header === 1 ? '' : 's'} before the header ${header === 1 ? 'is' : 'are'} skipped.`, line: records[0].line });
  if (header < 0 && records.length) issues.push({ code: 'no-header', message: 'No header row was recognised; the columns are named by their position.' });
  if (missing.length) issues.push({ code: 'missing-columns', message: `No column was found for ${missing.join(', ')}.` });
  if (decimalSource === 'detected' && decimalGuess.dot && decimalGuess.comma) issues.push({ code: 'decimal-mixed', message: `The coordinates use both "." and "," as the decimal separator (${decimalGuess.dot} and ${decimalGuess.comma} values); "${decimal}" is read as the separator.` });
  if (side.unknownCount) issues.push({ code: 'side-unknown', message: `${side.unknownCount} side value${side.unknownCount === 1 ? ' is' : 's are'} not recognised (${side.unknown.join(', ')}).` });

  const confirm: PinListConfirm[] = [];
  const sureColumns = !missing.length && PINLIST_REQUIRED.every(role => columns[mapping[role]!]?.source !== 'content');
  if (!sureColumns) confirm.push('columns');
  if (unit.source === 'guess' || unit.source === 'default') confirm.push('unit');
  if (decimalGuess.dot && decimalGuess.comma) confirm.push('decimal');
  if (mapping.side === undefined || side.unknownCount) confirm.push('side');
  const analysis: PinListAnalysis = {
    encoding: guess.encoding, delimiter, delimiterSource, hasHeader: header >= 0, headerLine: header >= 0 ? records[header].line : 0, preambleRecords: Math.max(header, 0), columns, mapping, missing, decimal, decimalSource, unit, side,
    sampleRows: rows.slice(0, 8).map(row => row.slice(0, MAX_COLUMNS_SHOWN).map(cell => clipText(cell, 60))), sampleRecords: rows.length, sampleComplete: complete && records.length < SAMPLE_RECORDS, confidence, needsConfirmation: confirm.length > 0, confirm, issues, reason,
  };
  return { analysis, guess, skipRecords, sepLine, mappingError };
}

/**
 * How a delimited text file reads as a pin list: the column-mapping result for a person to confirm. Looks at the first 64 KiB.
 * Never throws (binary data and tables that are not pin lists get a confidence of 0).
 */
export function analysePinList(data: Uint8Array, options: PinListOptions = {}): PinListAnalysis {
  try { return inspect(data, options, false).analysis; }
  catch { return emptyAnalysis('unreadable', { code: 'unreadable', message: 'The file could not be analysed.' }); }
}
/** The recognition helper: how sure the first 64 KiB are a pin list (see PinListAnalysis.confidence). */
export function sniffPinList(data: Uint8Array): PinListSniff {
  if (!(data instanceof Uint8Array) || data.length < 12) return { confidence: 0, roles: [], reason: 'too short' };
  const analysis = analysePinList(data);
  if (!analysis.confidence) return { confidence: 0, roles: [], reason: analysis.reason };
  return { confidence: analysis.confidence, delimiter: analysis.delimiter, hasHeader: analysis.hasHeader, roles: rolesOf(analysis.mapping), reason: analysis.reason };
}
/** True when the bytes are confidently a pin list (the adapter's own claim threshold). */
export const looksLikePinList = (data: Uint8Array): boolean => sniffPinList(data).confidence >= PINLIST_CLAIM_CONFIDENCE;

// ---------------------------------------------------------------------------------------------------------------------
// the whole file

export interface PinListPin { number: string; /** The file gave no pin number: the smallest free number was used. */ numberGenerated: boolean; net: string; side: BoardSide; x: number; y: number }
export interface PinListPart { ref: string; value: string; package: string; side: BoardSide; pins: PinListPin[] }
export interface PinListStats {
  /** Records after the header (blank lines excluded). */
  rows: number;
  /** Rows that became or merged into a pin. */
  used: number;
  blank: number;
  /** Rows with fewer cells than the mapped columns need. */
  short: number;
  noRef: number;
  badCoordinates: number;
  /** A row whose reference, pin and position repeat an earlier row's. */
  merged: number;
  netConflicts: number;
  /** Pins that share a pin number with another pin of the same part at another position. */
  repeatedNumbers: number;
  generatedNumbers: number;
  noNet: number;
  sideUnknown: number;
  /** Up to 8 of the side words that were not recognised. */
  sideUnknownWords: string[];
  sideBlank: number;
  strayQuotes: number;
  unterminatedQuote: number;
  cutFields: number;
  extraFields: number;
  /** Rows that came with a unit word on a coordinate ("12 mm"). */
  suffixed: number;
  examples: PinListIssue[];
}
export interface PinListDocument {
  analysis: PinListAnalysis;
  mapping: PinListMapping;
  /** The unit the unsuffixed coordinates were read in (final: a guess is made from every row, not from the sample). */
  unit: PinListUnitChoice;
  decimal: Decimal;
  parts: PinListPart[];
  stats: PinListStats;
}

interface PinAcc { number: string; net: string; side: BoardSide; x: number; y: number; /** bit 1: x is in file units, bit 2: y is */ raw: number }
interface PartAcc { ref: string; value: string; package: string; pins: PinAcc[]; index?: Map<string, PinAcc> }
const INDEX_FROM = 16;
const keyOf = (pin: string, x: number, y: number, raw: number): string => `${pin}\u0000${x}\u0000${y}\u0000${raw}`;
/** A copy that does not keep the decoded chunk alive (long substrings share their parent's memory). */
const own = (text: string): string => text.length >= 13 ? ' '.concat(text).slice(1) : text;
const roundMm = (value: number) => Math.round(value * 1e9) / 1e9;

/** Reads the whole file with the mapping of `analysePinList` (and the options on top of it) into parts, pins and counts. */
export function readPinList(data: Uint8Array, options: PinListOptions = {}): PinListDocument {
  if (data.length > MAX_IMPORT_BYTES) throw new BoardFormatError('Board data exceeds the 64 MiB import limit.', 'LIMIT_EXCEEDED', PINLIST_FORMAT);
  const inspection = inspect(data, options, true), { analysis, guess } = inspection;
  if (!guess) throw new BoardFormatError(`${PINLIST_FORMAT}: the file is not text.`, 'INVALID_FORMAT', PINLIST_FORMAT);
  if (inspection.mappingError) throw new BoardFormatError(`${PINLIST_FORMAT}: ${inspection.mappingError}`, 'INVALID_FORMAT', PINLIST_FORMAT);
  if (!analysis.columns.length) throw new BoardFormatError(`${PINLIST_FORMAT}: ${analysis.issues[0]?.message ?? 'the file is not a delimited table.'}`, 'INVALID_FORMAT', PINLIST_FORMAT);
  const { mapping } = analysis, { x: cx, y: cy, refdes: cr, pin: cp } = mapping;
  if (cx === undefined && cy === undefined && cr !== undefined && cp !== undefined) {
    throw new BoardFormatError(`${PINLIST_FORMAT}: the list has reference designators, pins${mapping.net === undefined ? '' : ' and nets'} but no X and Y columns; without positions it is a netlist, not a board. Name the coordinate columns in the mapping.`, 'UNSUPPORTED_VARIANT', PINLIST_FORMAT);
  }
  if (analysis.missing.length) {
    const headers = analysis.columns.slice(0, 12).map(column => `"${clipText(column.header, 24)}"`).join(', ');
    throw new BoardFormatError(`${PINLIST_FORMAT}: no column was found for ${analysis.missing.join(', ')}; the columns are ${headers}${analysis.columns.length > 12 ? ', …' : ''}. Name them in the mapping.`, 'INVALID_FORMAT', PINLIST_FORMAT);
  }
  const maxPins = options.limits?.maxPins ?? PINLIST_MAX_PINS, maxParts = options.limits?.maxParts ?? PINLIST_MAX_PARTS;
  const { decimal } = analysis, defaultSide = options.defaultSide ?? DEFAULT_SIDE, sideColumn = mapping.side, netColumn = mapping.net;
  const valueColumn = mapping.value, packageColumn = mapping.package, flip = options.flipY ? -1 : 1;
  const needed = Math.max(cx!, cy!, cr!, cp!) + 1;
  const stats: PinListStats = { rows: 0, used: 0, blank: 0, short: 0, noRef: 0, badCoordinates: 0, merged: 0, netConflicts: 0, repeatedNumbers: 0, generatedNumbers: 0, noNet: 0, sideUnknown: 0, sideUnknownWords: [], sideBlank: 0, strayQuotes: 0, unterminatedQuote: 0, cutFields: 0, extraFields: 0, suffixed: 0, examples: [] };
  const example = (code: string, message: string, line: number) => { if (stats.examples.length < MAX_ISSUE_EXAMPLES * 4) stats.examples.push({ code, message, line }); };
  const parts = new Map<string, PartAcc>(), nets = new Map<string, string>();
  let pinCount = 0, ordinal = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, rawRows = 0, allIntegers = true;
  const factor = (unit: PinListUnit | undefined) => unit ? PINLIST_UNIT_MM[unit] : 0;

  const onRecord = (record: CsvRecord): boolean => {
    if (record.flags) {
      if (record.flags & CSV_FLAG_STRAY_QUOTE) stats.strayQuotes++;
      if (record.flags & CSV_FLAG_UNTERMINATED_QUOTE) { stats.unterminatedQuote++; example('unterminated-quote', 'A quoted field is never closed; the rest of the file is part of it.', record.line); }
      if (record.flags & CSV_FLAG_FIELD_CUT) stats.cutFields++;
      if (record.flags & CSV_FLAG_TOO_MANY_FIELDS) stats.extraFields++;
    }
    if (++ordinal <= inspection.skipRecords) return true;
    const fields = record.fields;
    stats.rows++;
    if (fields.length < needed) {
      if (fields.every(cell => !cell.trim())) stats.blank++; else { stats.short++; example('short-row', `The row has ${fields.length} cell${fields.length === 1 ? '' : 's'}; the mapped columns need ${needed}.`, record.line); }
      return true;
    }
    const ref = fields[cr!].trim();
    if (!ref) { if (fields.every(cell => !cell.trim())) stats.blank++; else { stats.noRef++; example('no-reference', 'The row has no reference designator.', record.line); } return true; }
    const xs = parseNumber(fields[cx!], decimal), ys = parseNumber(fields[cy!], decimal);
    if (!xs || !ys) { stats.badCoordinates++; example('bad-coordinates', `The coordinates "${clipText(fields[cx!].trim(), 24)}", "${clipText(fields[cy!].trim(), 24)}" are not numbers.`, record.line); return true; }
    let raw = 0, x = xs.value, y = ys.value * flip;
    if (xs.unit) { x *= factor(xs.unit); stats.suffixed++; } else raw |= 1;
    if (ys.unit) { y *= factor(ys.unit); stats.suffixed++; } else raw |= 2;
    if (raw & 1) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    if (raw & 2) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
    if (raw && allIntegers && !((raw & 1 ? Number.isInteger(x) : true) && (raw & 2 ? Number.isInteger(y) : true))) allIntegers = false;
    if (raw) rawRows++;
    let pinText = fields[cp!].trim();
    if (pinText.length >= 13) pinText = own(pinText);
    let net = netColumn === undefined ? '' : (fields[netColumn] ?? '').trim();
    if (isNoNet(net)) { if (net) stats.noNet++; net = ''; }
    else { let known = nets.get(net); if (known === undefined) { known = own(net); nets.set(known, known); } net = known; }
    let side = defaultSide;
    if (sideColumn !== undefined) {
      const cell = (fields[sideColumn] ?? '').trim();
      if (!cell) stats.sideBlank++;
      else { const value = sideOfCell(cell, options.sideMap); if (value) side = value; else { stats.sideUnknown++; if (stats.sideUnknownWords.length < MAX_ISSUE_EXAMPLES && !stats.sideUnknownWords.includes(clipText(cell, 24))) stats.sideUnknownWords.push(clipText(cell, 24)); } }
    }
    let part = parts.get(ref);
    if (!part) {
      if (parts.size >= maxParts) throw new BoardFormatError(`${PINLIST_FORMAT}: component count exceeds the import limit.`, 'LIMIT_EXCEEDED', PINLIST_FORMAT);
      const name = own(ref);
      part = { ref: name, value: '', package: '', pins: [] }; parts.set(name, part);
    }
    if (valueColumn !== undefined && !part.value) part.value = own((fields[valueColumn] ?? '').trim());
    if (packageColumn !== undefined && !part.package) part.package = own((fields[packageColumn] ?? '').trim());
    // the same pin at the same place is one pad; the same number at another place is another pad of the part
    let existing: PinAcc | undefined;
    if (part.index) existing = part.index.get(keyOf(pinText, x, y, raw));
    else for (const pin of part.pins) if (pin.number === pinText && pin.x === x && pin.y === y && pin.raw === raw) { existing = pin; break; }
    if (existing) {
      stats.merged++; stats.used++;
      if (!existing.net) existing.net = net; else if (net && net !== existing.net) stats.netConflicts++;
      if (existing.side !== side) existing.side = 'both';
      return true;
    }
    if (pinCount >= maxPins) throw new BoardFormatError(`${PINLIST_FORMAT}: pin count exceeds the import limit.`, 'LIMIT_EXCEEDED', PINLIST_FORMAT);
    const pin: PinAcc = { number: pinText, net, side, x, y, raw };
    part.pins.push(pin); pinCount++; stats.used++;
    if (part.index) part.index.set(keyOf(pinText, x, y, raw), pin);
    else if (part.pins.length >= INDEX_FROM) { part.index = new Map(); for (const item of part.pins) part.index.set(keyOf(item.number, item.x, item.y, item.raw), item); }
    return true;
  };
  const tokenizer = new CsvTokenizer(analysis.delimiter, onRecord, DEFAULT_CSV_LIMITS);
  let sepPending = inspection.sepLine;
  for (let chunk of decodeChunks(data, guess)) {
    if (sepPending) { const sep = SEP_LINE.exec(chunk); if (sep) chunk = chunk.slice(sep[0].length); sepPending = false; }
    tokenizer.push(chunk);
    if (tokenizer.done) break;
  }
  tokenizer.push('', true);

  if (stats.rows - stats.blank === 0) throw new BoardFormatError(`${PINLIST_FORMAT}: the file has no data rows.`, 'INVALID_FORMAT', PINLIST_FORMAT);
  if (!stats.used) throw new BoardFormatError(`${PINLIST_FORMAT}: no row could be read as a pin (${stats.badCoordinates} with coordinates that are not numbers, ${stats.noRef} without a reference designator, ${stats.short} too short); check the column mapping, the decimal separator and the header row.`, 'INVALID_FORMAT', PINLIST_FORMAT);
  if (stats.used * 2 < stats.rows - stats.blank) throw new BoardFormatError(`${PINLIST_FORMAT}: only ${stats.used} of ${stats.rows - stats.blank} rows could be read as a pin (${stats.badCoordinates} with coordinates that are not numbers, ${stats.noRef} without a reference designator, ${stats.short} too short); check the column mapping, the decimal separator and the header row.`, 'INVALID_FORMAT', PINLIST_FORMAT);

  // the unit of the plain numbers: the caller's, a header's or the numbers' own, else a guess from the size of everything that was read
  let unit = analysis.unit;
  if (unit.source === 'guess' || unit.source === 'default') {
    if (rawRows) {
      const guessed = guessUnit(Math.max(Number.isFinite(maxX) ? maxX - minX : 0, Number.isFinite(maxY) ? maxY - minY : 0), allIntegers);
      unit = { unit: guessed.unit, mmPerUnit: PINLIST_UNIT_MM[guessed.unit], source: guessed.candidates.length ? 'guess' : 'default', confidence: guessed.confidence, candidates: guessed.candidates };
    }
  }
  const out: PinListPart[] = [];
  for (const part of parts.values()) {
    const taken = new Set<string>(), seen = new Set<string>();
    let generated = 0;
    for (const pin of part.pins) if (pin.number) { if (taken.has(pin.number)) { if (!seen.has(pin.number)) { seen.add(pin.number); } } else taken.add(pin.number); }
    stats.repeatedNumbers += part.pins.filter(pin => pin.number && seen.has(pin.number)).length;
    let next = 1;
    const pins: PinListPin[] = part.pins.map(pin => {
      let number = pin.number, made = false;
      if (!number) { while (taken.has(String(next))) next++; number = String(next); taken.add(number); made = true; generated++; }
      return { number, numberGenerated: made, net: pin.net, side: pin.side, x: roundMm(pin.raw & 1 ? pin.x * unit.mmPerUnit : pin.x), y: roundMm(pin.raw & 2 ? pin.y * unit.mmPerUnit : pin.y) };
    });
    stats.generatedNumbers += generated;
    const sides = new Set(pins.map(pin => pin.side));
    out.push({ ref: part.ref, value: part.value, package: part.package, side: sides.size === 1 ? pins[0].side : 'both', pins });
  }
  return { analysis, mapping, unit, decimal, parts: out, stats };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function buildPinListBoard(input: ParseInput, document: PinListDocument, options: PinListOptions = {}): Board {
  const { analysis, stats, unit, parts } = document;
  const rawParts: RawPart[] = [], rawPins: RawPin[] = [];
  parts.forEach((part, index) => {
    const key = `part:${index}`;
    rawParts.push({ key, ref: part.ref, side: part.side, ...(part.value ? { value: part.value } : {}), ...(part.package ? { package: part.package } : {}) });
    for (const pin of part.pins) rawPins.push({ part: key, number: pin.number, ...(pin.numberGenerated ? { numberGenerated: true } : {}), name: pin.number, net: pin.net, side: pin.side, x: pin.x, y: pin.y });
  });
  const notes: string[] = [];
  // English format diagnostics through the formatNote catalog entry, like the other boardview adapters.
  notes.push('Pin list import: reference designators, pins, nets and positions are read from the file as mapped. The file has no pad sizes, component bodies or board outline, so pads are drawn at a default size, component bodies are the boxes around their pins and the outline is the extent of all pins (estimated).');
  if (unit.source === 'guess') {
    const others = unit.candidates.filter(candidate => candidate !== unit.unit);
    notes.push(`The file does not state the unit of its coordinates; they are read as ${unit.unit}${others.length ? `, but ${others.join(' and ')} would also give a plausible board size` : ', the only unit that gives a plausible board size'}.`);
  }
  else if (unit.source === 'default') notes.push('The file does not state the unit of its coordinates and none gives a plausible board size; they are read as mm.');
  else if (unit.source === 'preamble') notes.push(`The unit ${unit.unit} comes from a line in front of the header.`);
  if (analysis.decimal === ',' && analysis.decimalSource !== 'user') notes.push('Numbers are read with a decimal comma.');
  const guessed = analysis.columns.filter(column => column.source === 'content' && column.role);
  if (guessed.length) notes.push(`No header named the ${guessed.map(column => column.role).join(', ')} column${guessed.length === 1 ? '' : 's'}; ${guessed.length === 1 ? 'it was' : 'they were'} guessed from the values.`);
  if (analysis.mapping.side === undefined) notes.push(`The file has no side column; every pin is on the ${options.defaultSide ?? DEFAULT_SIDE} side.`);
  if (analysis.mapping.net === undefined) notes.push('The file has no net column; the board has no nets.');
  if (stats.sideUnknown) notes.push(`${plural(stats.sideUnknown, 'row has a side that is', 'rows have a side that is')} not recognised${stats.sideUnknownWords.length ? ` (${stats.sideUnknownWords.join(', ')})` : ''} and ${stats.sideUnknown === 1 ? 'is' : 'are'} shown on the ${options.defaultSide ?? DEFAULT_SIDE} side.`);
  if (stats.sideBlank) notes.push(`${plural(stats.sideBlank, 'row has', 'rows have')} no side and ${stats.sideBlank === 1 ? 'is' : 'are'} shown on the ${options.defaultSide ?? DEFAULT_SIDE} side.`);
  const skipped = stats.short + stats.noRef + stats.badCoordinates;
  if (skipped) {
    const why = [stats.badCoordinates && `${stats.badCoordinates} with coordinates that are not numbers`, stats.noRef && `${stats.noRef} without a reference designator`, stats.short && `${stats.short} too short for the mapped columns`].filter(Boolean);
    const first = stats.examples.find(item => item.code === 'bad-coordinates' || item.code === 'no-reference' || item.code === 'short-row');
    notes.push(`${plural(skipped, 'row was', 'rows were')} skipped: ${why.join(', ')}${first?.line ? ` (the first on line ${first.line})` : ''}.`);
  }
  if (stats.merged) notes.push(`${plural(stats.merged, 'row repeats', 'rows repeat')} a pin of the same reference at the same position and ${stats.merged === 1 ? 'was' : 'were'} merged into it.`);
  if (stats.netConflicts) notes.push(`${plural(stats.netConflicts, 'merged row names', 'merged rows name')} a different net than the first; the first net is kept.`);
  if (stats.repeatedNumbers) notes.push(`${plural(stats.repeatedNumbers, 'pin shares', 'pins share')} a pin number with another pin of the same reference at another position (a pad listed twice or a multi-pad pin); ${stats.repeatedNumbers === 1 ? 'it is' : 'they are'} kept as separate pads.`);
  if (stats.generatedNumbers) notes.push(`${plural(stats.generatedNumbers, 'row has', 'rows have')} no pin number; the smallest free number was used.`);
  if (stats.noNet) notes.push(`${plural(stats.noNet, 'pin is', 'pins are')} listed as N/C or No Net and ${stats.noNet === 1 ? 'has' : 'have'} no net.`);
  if (stats.suffixed) notes.push(`${plural(stats.suffixed, 'coordinate carries its', 'coordinates carry their')} own unit word, which takes precedence.`);
  if (stats.strayQuotes) notes.push(`${plural(stats.strayQuotes, 'record has', 'records have')} text after a closing quote; the text was kept as part of the field.`);
  if (stats.unterminatedQuote) notes.push(`A quoted field is never closed (line ${stats.examples.find(item => item.code === 'unterminated-quote')?.line}); the rest of the file is part of it.`);
  if (stats.cutFields) notes.push(`${plural(stats.cutFields, 'field is', 'fields are')} longer than ${DEFAULT_CSV_LIMITS.maxFieldChars} characters and ${stats.cutFields === 1 ? 'was' : 'were'} cut.`);
  if (stats.extraFields) notes.push(`${plural(stats.extraFields, 'row has', 'rows have')} more than ${DEFAULT_CSV_LIMITS.maxFields} cells; the extra cells were dropped.`);
  if (analysis.preambleRecords) notes.push(`${plural(analysis.preambleRecords, 'line', 'lines')} in front of the header ${analysis.preambleRecords === 1 ? 'was' : 'were'} skipped.`);
  const raw: RawBoard = { format: PINLIST_FORMAT, unitsToMm: 1, parts: rawParts, pins: rawPins, warnings: notes.map(note) };
  return buildBoard(input, raw);
}

/**
 * Adapter entry, the same shape as the other adapters: null for bytes that are not a pin list (the header does not name a
 * reference designator, a pin, X and Y; judged with the caller's delimiter, header and decimal options), a Board for a pin list,
 * a BoardFormatError for a pin list that is unusable or over a limit. With `options.mapping` (a confirmed mapping) any delimited
 * text is read: nothing is claimed, the mapping is the claim.
 */
export function parsePinList(input: ParseInput, options: PinListOptions = {}): Board | null {
  if (!options.mapping && analysePinList(input.data, options).confidence < PINLIST_CLAIM_CONFIDENCE) return null;
  return buildPinListBoard(input, readPinList(input.data, options), options);
}
