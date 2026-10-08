/**
 * OpenBoardData text files -> readings. File import only: TRACE never downloads OpenBoardData; the technician picks a file.
 *
 * OpenBoardData is a community database of known-good net values (diode mode, normal voltage, resistance) published under the Open
 * Database License (ODbL) 1.0. Its plain-text layout, as the project's board files describe it in their own comment block: each row is
 * one net, each field is separated by a single space, the columns are NETNAME DIODE_VALUE NORMAL_VOLTAGE RESISTANCE [COMMENT ...],
 * "ol" means over limit and "na" not applicable. Two file shapes exist:
 *  - a board file: header lines `ID <board id>`, `BRAND [text]`, `TYPE [text]`, `COMMENT [text]` (the last three may be empty), comment
 *    lines starting with `#` (a net that has not been measured yet is often listed as a comment), then the net lines;
 *  - the combined file the project builds from them: every line is `<board id> <net line>`, many boards in one file.
 * As in the project's own build tool, lines that start with a blank are not data. Tolerated beyond the documented layout: tabs or
 * several blanks between fields, and `<NAME>_START` ... `<NAME>_END` sections, whose lines are skipped and counted.
 *
 * Every reading made here is `imported`, licence `ODbL-1.0`, provenance `openboarddata` with the board id as title and the ODbL
 * attribution text, and keeps the field text verbatim in `raw` (lossless). Conditions follow what the columns mean: diode and
 * resistance unpowered, NORMAL_VOLTAGE powered; the lead polarity is not recorded by the format and stays absent.
 *
 * Field values: a number (resistance with an optional k / M suffix, units optional), `ol` (any case: open / over limit), or an unknown
 * marker (`na`, `n/a`, `-`, `?`, `x`, `none`, `null`, `nc`): no reading. Diode values are volts; a file whose diode numbers are all
 * whole and above 4 is read as millivolts and that is reported (`diodeUnit: 'mV'`). A file that mixes both is read as volts and the
 * out-of-range fields are reported.
 */
import { stableReadingId } from './ids';
import { READINGS_LIMITS, canonicalName, validateReading } from './schema';
import type { NumericKind, Reading } from './schema';
import { parseReadingValue } from './value';

export const OPENBOARDDATA_LICENSE = 'ODbL-1.0';
export const OPENBOARDDATA_ATTRIBUTION = 'Contains information from the OpenBoardData project, made available under the Open Database License (ODbL) 1.0.';
const MAX_LINE = 4096;
const UNKNOWN: ReadonlySet<string> = new Set(['-', '--', '?', 'x', 'n/a', 'na', 'none', 'null', 'nc', '']);

export interface OpenBoardDataBoard { id: string; lines: number }
export interface OpenBoardDataIssue { line: number; message: string }
export interface OpenBoardDataParse {
  /** File shape: one board with an ID header, or the combined file of many boards. */
  shape: 'board' | 'combined';
  /** Boards in the file with their net-line counts. */
  boards: OpenBoardDataBoard[];
  /** The board the readings were taken from (null when the combined file holds several and none was chosen). */
  board: string | null;
  readings: Reading[];
  diodeUnit: 'V' | 'mV';
  /** Lines skipped on purpose (headers, comments, component sections), and lines or fields that could not be read. */
  skipped: number;
  issues: OpenBoardDataIssue[];
}
export interface OpenBoardDataOptions {
  /** In a combined file: the board to read (required when it holds more than one). */
  board?: string;
  /** Time of the import (provenance). */
  now: string;
}

interface NetLine { line: number; board: string; net: string; fields: [string, string, string]; comment: string }

const isSectionMarker = (text: string): boolean => /^[A-Z][A-Z0-9_]*_(START|END)$/.test(text);
const HEADER = /^(ID|BRAND|TYPE|COMMENT)(?:\s|$)/;

// Four fields and the rest of the line (the comment, kept as written). Linear: the field and blank classes do not overlap.
const NET_LINE = /^(\S+)[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)(?:[ \t]+(.*))?$/;

/** Splits a line into the net, three value fields and the comment; null when it has fewer than four fields. */
function splitNetLine(text: string): { net: string; fields: [string, string, string]; comment: string } | null {
  const match = NET_LINE.exec(text);
  if (!match) return null;
  return { net: match[1], fields: [match[2], match[3], match[4]], comment: (match[5] ?? '').trim() };
}

/** The id of the reading of one column of one net of one board: the same file imported twice gives the same ids. */
export const openBoardDataReadingId = (board: string, net: string, kind: NumericKind): string => stableReadingId('obd', board, net, kind);

/** Reads an OpenBoardData text file. Never throws for content; `issues` lists what was not read. */
export function parseOpenBoardData(text: string, options: OpenBoardDataOptions): OpenBoardDataParse {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\n|\r/);
  const issues: OpenBoardDataIssue[] = [];
  let skipped = 0;
  let section: string | null = null;
  let boardId: string | null = null;
  const isBoardFile = lines.some(line => /^ID\s+\S/.test(line));
  const shape: 'board' | 'combined' = isBoardFile ? 'board' : 'combined';
  const netLines: NetLine[] = [];
  const counts = new Map<string, number>();
  lines.forEach((raw, index) => {
    const number = index + 1;
    const line = raw.trim();
    if (line === '') return;
    if (raw.charCodeAt(0) === 32 || raw.charCodeAt(0) === 9) { skipped++; return; }
    if (line.length > MAX_LINE) { skipped++; issues.push({ line: number, message: 'line too long' }); return; }
    if (line.startsWith('#')) { skipped++; return; }
    if (isSectionMarker(line)) { section = line.endsWith('_START') ? line : null; skipped++; return; }
    if (section !== null) { skipped++; return; }
    if (isBoardFile) {
      const header = HEADER.exec(line);
      if (header) {
        if (header[1] === 'ID') boardId = line.slice(2).trim() || null;
        skipped++;
        return;
      }
      if (boardId === null) { skipped++; issues.push({ line: number, message: 'net line before the ID line' }); return; }
      const split = splitNetLine(line);
      if (!split) { skipped++; issues.push({ line: number, message: 'fewer than four fields' }); return; }
      netLines.push({ line: number, board: boardId, ...split });
      counts.set(boardId, (counts.get(boardId) ?? 0) + 1);
      return;
    }
    const space = line.search(/[ \t]/);
    const split = space > 0 ? splitNetLine(line.slice(space + 1).trim()) : null;
    if (!split) { skipped++; issues.push({ line: number, message: 'fewer than five fields' }); return; }
    const board = line.slice(0, space);
    netLines.push({ line: number, board, ...split });
    counts.set(board, (counts.get(board) ?? 0) + 1);
  });
  const boards = [...counts].map(([id, count]) => ({ id, lines: count }));
  let chosen: string | null = options.board ?? null;
  if (chosen === null && boards.length === 1) chosen = boards[0].id;
  const result: OpenBoardDataParse = { shape, boards, board: chosen, readings: [], diodeUnit: 'V', skipped, issues };
  if (chosen === null || !counts.has(chosen)) {
    if (options.board !== undefined) issues.push({ line: 0, message: 'the chosen board is not in the file' });
    result.board = null;
    return result;
  }
  const selected = netLines.filter(entry => entry.board === chosen);
  // Diode unit for the whole file: millivolts only when every diode number is whole and above 4.
  const diodeNumbers = selected.map(entry => entry.fields[0]).filter(field => /^\d+(?:\.\d+)?$/.test(field)).map(Number).filter(value => value !== 0);
  const millivolts = diodeNumbers.length > 0 && diodeNumbers.every(value => Number.isInteger(value) && value > 4);
  result.diodeUnit = millivolts ? 'mV' : 'V';
  const kinds: readonly NumericKind[] = ['diode', 'voltage', 'resistance'];
  const title = chosen.slice(0, READINGS_LIMITS.title);
  const seen = new Set<string>();
  for (const entry of selected) {
    const net = canonicalName(entry.net, READINGS_LIMITS.net);
    if (net === null) { result.skipped++; issues.push({ line: entry.line, message: 'net name' }); continue; }
    if (seen.has(net)) { result.skipped++; issues.push({ line: entry.line, message: `net ${net.slice(0, 64)} is listed twice; the first line is kept` }); continue; }
    seen.add(net);
    const note = entry.comment === '' ? undefined : entry.comment.slice(0, READINGS_LIMITS.note);
    for (let index = 0; index < 3; index++) {
      const field = entry.fields[index];
      if (UNKNOWN.has(field.toLowerCase())) continue;
      const kind = kinds[index];
      let parsed = parseReadingValue(field, kind, { bareDiodeMillivolts: false });
      if (kind === 'diode' && millivolts && /^\d+$/.test(field)) parsed = parseReadingValue(`${field}m`, kind);
      if (!parsed.ok || 'connected' in parsed) { issues.push({ line: entry.line, message: `${kind} value "${field.slice(0, 32)}" (${parsed.ok ? 'unrecognized' : parsed.reason})` }); continue; }
      const reading: Record<string, unknown> = { id: openBoardDataReadingId(chosen, net, kind), kind, target: { net } };
      if ('ol' in parsed) reading.ol = true; else { reading.value = parsed.value; reading.unit = parsed.unit; }
      if (field.length <= READINGS_LIMITS.raw) reading.raw = field;
      reading.conditions = { power: kind === 'voltage' ? 'powered' : 'unpowered' };
      reading.source = 'imported';
      reading.license = OPENBOARDDATA_LICENSE;
      reading.provenance = { origin: 'openboarddata', title, attribution: OPENBOARDDATA_ATTRIBUTION, importedAt: options.now };
      if (note !== undefined) reading.note = note;
      if (result.readings.length >= READINGS_LIMITS.readings) { issues.push({ line: entry.line, message: 'reading limit reached' }); return result; }
      result.readings.push(validateReading(reading));
    }
  }
  return result;
}

/** True when text looks like an OpenBoardData file (an ID header, or lines of a board id, a net and three value fields). */
export function looksLikeOpenBoardData(text: string): boolean {
  const head = text.slice(0, 64 * 1024).split(/\r\n|\n|\r/).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'));
  if (head.some(line => /^ID\s+\S/.test(line))) return true;
  const sample = head.slice(0, 20).filter(line => !isSectionMarker(line));
  return sample.length > 0 && sample.every(line => line.split(/[ \t]+/).length >= 5);
}
