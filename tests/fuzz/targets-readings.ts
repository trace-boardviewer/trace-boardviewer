/**
 * Fuzz targets of the readings importers, the other files a technician opens: a TRACE readings pack (JSON), a readings CSV table, an
 * OpenBoardData text file, the detection that tells them apart, and the value parser that reads a typed meter value. They read text that
 * somebody else wrote, so they must be total (a documented error or a result, never another exception), bounded, and what they accept
 * must be what the validators accept.
 */
import { MAX_MESSAGE_CHARS } from '../../src/lib/bounded-text';
import { parseReadingsCsv } from '../../src/lib/readings/csv';
import { detectReadingsFile } from '../../src/lib/readings/files';
import { parseOpenBoardData } from '../../src/lib/readings/openboarddata';
import { auditPack, parsePack, serializePack } from '../../src/lib/readings/pack';
import { READING_KINDS, READINGS_LIMITS, ReadingsError, UNIT_OF, validateReading } from '../../src/lib/readings/schema';
import type { NumericKind, Reading } from '../../src/lib/readings/schema';
import { parseReadingValue } from '../../src/lib/readings/value';
import type { FuzzInput } from './corpus';
import type { FuzzTarget } from './targets';

/** The bytes as text the way the main process hands a readings file to the renderer. */
const textOf = (input: FuzzInput): string => new TextDecoder('utf-8').decode(input.data);
const isReadingsError = (error: unknown): boolean => error instanceof ReadingsError;
const NOW = '2026-10-07T10:00:00Z';

/** A reading that came out of an importer is canonical: the validator accepts it and changes nothing. */
function checkReadings(readings: readonly Reading[]): string | null {
  if (readings.length > READINGS_LIMITS.readings) return `${readings.length} readings`;
  for (const reading of readings.slice(0, 400)) {
    let again: Reading;
    try { again = validateReading(reading); } catch (error) { return `a reading that the validator refuses (${(error as Error).message.slice(0, 120)})`; }
    if (JSON.stringify(again) !== JSON.stringify(reading)) return 'a reading that is not canonical (the validator changes it)';
  }
  return null;
}

const issueTexts = (issues: ReadonlyArray<{ message: string }>): string | null => (issues.some(issue => typeof issue.message !== 'string' || issue.message.length > MAX_MESSAGE_CHARS) ? 'an issue message that is not a bounded text' : null);

const csvTarget: FuzzTarget = {
  id: 'readings:csv', family: 'util', seeds: ['readings-csv'],
  run: input => { let next = 0; return parseReadingsCsv(textOf(input), { newId: () => `row${next++}` }); },
  allowed: isReadingsError,
  check: output => {
    const { readings, issues, unknownColumns, powerAssumed } = output as ReturnType<typeof parseReadingsCsv>;
    if (unknownColumns.length > 64) return `${unknownColumns.length} unknown columns`;
    // powerAssumed counts the rows without a power cell, also those that are skipped later: only its shape is checked.
    if (!Number.isSafeInteger(powerAssumed) || powerAssumed < 0) return `${powerAssumed} assumed power states`;
    if (issues.some(issue => !Number.isInteger(issue.row) || issue.row < 1)) return 'an issue without a row';
    return checkReadings(readings) ?? issueTexts(issues);
  },
  units: output => (output as ReturnType<typeof parseReadingsCsv>).readings.length,
  digest: output => JSON.stringify(output),
};

/** The OpenBoardData reader, with the board chosen for a part of the inputs (by the name of the first board it found). */
const openBoardDataTarget: FuzzTarget = {
  id: 'readings:openboarddata', family: 'util', seeds: ['readings-obd'],
  run: input => {
    const text = textOf(input);
    const first = parseOpenBoardData(text, { now: NOW });
    return input.data.length % 3 === 0 && first.boards.length > 1 ? parseOpenBoardData(text, { now: NOW, board: first.boards[input.data.length % first.boards.length].id }) : first;
  },
  allowed: () => false,
  check: output => {
    const result = output as ReturnType<typeof parseOpenBoardData>;
    if (result.board !== null && !result.boards.some(board => board.id === result.board)) return 'the chosen board is not one of the boards of the file';
    if (result.board === null && result.readings.length) return 'readings without a board';
    const ids = new Set(result.readings.map(reading => reading.id));
    if (ids.size !== result.readings.length) return 'two readings with one id';
    return checkReadings(result.readings) ?? issueTexts(result.issues);
  },
  units: output => (output as ReturnType<typeof parseOpenBoardData>).readings.length + (output as ReturnType<typeof parseOpenBoardData>).issues.length,
  digest: output => JSON.stringify(output),
};

/** A pack is parsed without throwing; what is accepted survives writing and reading again unchanged. */
const packTarget: FuzzTarget = {
  id: 'readings:pack', family: 'util', seeds: ['readings-pack'],
  run: input => {
    const parsed = parsePack(textOf(input));
    if (!parsed.ok) return parsed;
    return { ...parsed, audit: auditPack(parsed.pack).length, again: parsePack(serializePack(parsed.pack)) };
  },
  allowed: () => false,
  check: output => {
    const result = output as ReturnType<typeof parsePack> & { audit?: number; again?: ReturnType<typeof parsePack> };
    if (!result.ok) return /^READINGS_[A-Z_]+$/.test(result.code) && result.message.length <= MAX_MESSAGE_CHARS ? null : `a refusal with the code "${String(result.code).slice(0, 40)}" and a message of ${String(result.message).length} characters`;
    if (!result.again?.ok) return 'a pack that cannot be read again after it is written';
    if (JSON.stringify(result.again.pack) !== JSON.stringify(result.pack)) return 'a pack that changes when it is written and read again';
    return checkReadings(result.pack.readings);
  },
  units: output => { const result = output as ReturnType<typeof parsePack>; return result.ok ? result.pack.readings.length : 0; },
  digest: output => JSON.stringify(output),
};

const KINDS_OF_FILE: ReadonlySet<unknown> = new Set(['pack', 'csv', 'openboarddata', null]);
const detectTarget: FuzzTarget = {
  id: 'readings:detect', family: 'util', seeds: ['readings-csv', 'readings-obd', 'readings-pack'],
  run: input => ({ kind: detectReadingsFile(input.name, textOf(input)) }),
  allowed: () => false,
  check: output => (KINDS_OF_FILE.has((output as { kind: unknown }).kind) ? null : 'a kind of file that does not exist'),
  digest: output => JSON.stringify(output),
};

/** The value parser reads every line of the input as the typed value of each kind of reading. */
const valueTarget: FuzzTarget = {
  id: 'readings:value', family: 'util', seeds: ['readings-csv', 'readings-obd'],
  run: input => {
    const lines = textOf(input).split(/\r\n|\n|\r/, 64);
    return lines.flatMap(line => READING_KINDS.map(kind => ({ kind, line: line.slice(0, 300), parsed: parseReadingValue(line.slice(0, 300), kind) })));
  },
  allowed: () => false,
  check: output => {
    for (const { kind, parsed } of output as Array<{ kind: (typeof READING_KINDS)[number]; parsed: ReturnType<typeof parseReadingValue> }>) {
      if (!parsed.ok || !('value' in parsed)) continue;
      if (!Number.isFinite(parsed.value) || Math.abs(parsed.value) > READINGS_LIMITS.value) return `a value of ${parsed.value} for a ${kind} reading`;
      if (kind !== 'continuity' && parsed.unit !== UNIT_OF[kind as NumericKind]) return `the unit ${parsed.unit} for a ${kind} reading`;
    }
    return null;
  },
  units: output => (output as unknown[]).length,
  digest: output => JSON.stringify(output),
};

export const readingsTargets = (): FuzzTarget[] => [csvTarget, openBoardDataTarget, packTarget, detectTarget, valueTarget];
