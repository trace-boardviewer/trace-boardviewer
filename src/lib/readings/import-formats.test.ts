import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, packToCsv, parseCsvRecords, parseReadingsCsv, readingsToCsv } from './csv';
import { detectReadingsFile } from './files';
import { OPENBOARDDATA_ATTRIBUTION, OPENBOARDDATA_LICENSE, looksLikeOpenBoardData, openBoardDataReadingId, parseOpenBoardData } from './openboarddata';
import { buildPack, planImport, serializePack } from './pack';
import { validateReading } from './schema';
import type { Reading } from './schema';

const voltage = (id: string, extra: Record<string, unknown> = {}): Reading => validateReading({ id, kind: 'voltage', target: { net: 'PP3V3' }, value: 3.3, unit: 'V', conditions: { power: 'powered' }, source: 'known-good', ...extra });

describe('CSV export', () => {
  it('writes a BOM, the header of every column, CRLF, and the shortest round-tripping numbers', () => {
    const text = readingsToCsv([voltage('r1', { value: 0.1 + 0.2, tolerance: { rel: 0.05 } })]);
    expect(text.startsWith('﻿id,kind,ref,pin,net,value,unit,')).toBe(true);
    const [header, row, end] = text.slice(1).split('\r\n');
    expect(header.split(',')).toEqual([...CSV_COLUMNS]);
    expect(row).toBe('r1,voltage,,,PP3V3,0.30000000000000004,V,,,,powered,,,,,,,,,0.05,known-good,,,,,,,,');
    expect(end).toBe('');
  });
  it('quotes separators, quotes and line breaks; text a spreadsheet would run as a formula gets one apostrophe, removed again on import', () => {
    const readings = [voltage('r1', { note: '=HYPERLINK("x")', target: { net: '-12V' } }), voltage('r2', { note: "'=already", target: { ref: '+5', pin: '@1' } }), voltage('r3', { note: 'a,b\n"c"' })];
    const text = readingsToCsv(readings);
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(text).toContain(",'-12V,");
    expect(text).toContain("''=already");
    expect(text).toContain(`"a,b\n""c"""`);
    expect(parseReadingsCsv(text).readings).toEqual(readings);
  });
  it('packToCsv names the licence on every row (a CSV has no header fields)', () => {
    const odbl = voltage('o1', { source: 'imported', license: 'ODbL-1.0', provenance: { origin: 'openboarddata' } });
    const { pack } = buildPack([voltage('r1'), odbl], { board: {}, foreign: 'mark' });
    const rows = packToCsv(pack).split('\r\n');
    expect(rows[1]).toContain(',known-good,CC0-1.0,');
    expect(rows[2]).toContain(',imported,ODbL-1.0,openboarddata,');
    expect(parseReadingsCsv(packToCsv(pack)).readings.map(reading => reading.license)).toEqual(['CC0-1.0', 'ODbL-1.0']);
  });
});

describe('CSV import', () => {
  it('reads a hand-made sheet: free column order and case, semicolons with decimal commas, value text with units, defaults reported', () => {
    const text = 'Ref;Pin;Kind;Value;Note\nU7;3;voltage;1,8;from the sheet\nU7;4;resistance;4k7;\nR1;1;diode;412 mV;\n;;voltage;3.3;no target\n';
    let next = 0;
    const parsed = parseReadingsCsv(text, { newId: () => `csv${++next}` });
    expect(parsed.readings.map(reading => [reading.id, reading.kind, reading.target, reading.value, reading.conditions.power, reading.source])).toEqual([
      ['csv1', 'voltage', { ref: 'U7', pin: '3' }, 1.8, 'powered', 'known-good'],
      ['csv2', 'resistance', { ref: 'U7', pin: '4' }, 4700, 'unpowered', 'known-good'],
      ['csv3', 'diode', { ref: 'R1', pin: '1' }, 0.412, 'unpowered', 'known-good'],
    ]);
    expect(parsed.issues).toEqual([{ row: 5, message: 'Invalid readings: row.target.' }]);
    expect(parsed.unknownColumns).toEqual([]);
    expect(parsed.powerAssumed).toBe(4);
  });
  it('tab separated; unknown columns are reported and ignored; a bad row names its row number and the others are kept', () => {
    const text = 'id\tkind\tnet\tvalue\tunit\tcolour\nr1\tdiode\tPP3V3\t0.41\tV\tred\nr2\tdiode\tPP1V8\t0.41\tohm\tred\nr3\tdiode\tPP5V\tOL\t\tred\nr1\tdiode\tPP3V3\t0.4\tV\t\n';
    const parsed = parseReadingsCsv(text);
    expect(parsed.readings.map(reading => [reading.id, reading.value ?? reading.ol])).toEqual([['r1', 0.41], ['r3', true]]);
    expect(parsed.issues).toEqual([{ row: 3, message: 'Invalid readings: row.unit.' }, { row: 5, message: 'Invalid readings: id r1 appears twice.' }]);
    expect(parsed.unknownColumns).toEqual(['colour']);
  });
  it('refuses an unreadable file as a whole: an unclosed quote, too many columns, a cell too long', () => {
    expect(() => parseReadingsCsv('id,kind\n"r1,diode\n')).toThrow('a quoted CSV cell is not closed');
    expect(() => parseCsvRecords(`${'a,'.repeat(70)}\n`, ',', 10)).toThrow('more than 64 columns');
    expect(() => parseCsvRecords(`${'x'.repeat(9000)}\n`, ',', 10)).toThrow('longer than 8192 characters');
    expect(parseCsvRecords('a,"b\r\nc",d\r\n\r\ne\n', ',', 10)).toEqual([['a', 'b\r\nc', 'd'], ['e']]);
  });
  it('takes linear time on pathological input', () => {
    const started = performance.now();
    parseCsvRecords(`${'"",'.repeat(60)}\n`.repeat(20000), ',', 100000);
    parseCsvRecords(`"${'""'.repeat(4000)}"\n`.repeat(100), ',', 1000);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('OpenBoardData files (import only)', () => {
  const now = '2026-10-07T12:00:00Z';
  const BOARD_FILE = [
    'ID 820-00165', 'BRAND', 'TYPE laptop', 'COMMENT ', '#', '# Each row represents a single net', '# Each field is separated by a single space',
    '# ol = over limit, na = non applicable, comment optional', '# NETNAME  DIODE_VALUE  NORMAL_VOLTAGE  RESISTANCE  COMMENT',
    'PPBUS_G3H 0.412 12.6 42k Main rail, check the  charger first', 'PP3V3_S5 0.38 3.3 ol', 'PP1V8_S0 na 1.8 na', '#PP5V_S0', ' INDENTED 1 2 3',
    'BAD_LINE 0.5 3.3', 'PP0V9 0.4V 0V9 4R7', 'PP3V3_S5 0.5 3.3 1k', 'NEG -0.2 -12 2.2M', 'WEIRD abc 1 1',
  ].join('\n');

  it('reads a board file: header, comments and blank-led lines skipped, ol / na, k and M suffixes, comment kept as the note', () => {
    const parsed = parseOpenBoardData(BOARD_FILE, { now });
    expect(parsed.shape).toBe('board');
    expect(parsed.board).toBe('820-00165');
    expect(parsed.diodeUnit).toBe('V');
    const rows = parsed.readings.map(reading => [reading.target.net, reading.kind, reading.ol ? 'OL' : reading.value, reading.raw, reading.conditions.power]);
    expect(rows).toEqual([
      ['PPBUS_G3H', 'diode', 0.412, '0.412', 'unpowered'], ['PPBUS_G3H', 'voltage', 12.6, '12.6', 'powered'], ['PPBUS_G3H', 'resistance', 42000, '42k', 'unpowered'],
      ['PP3V3_S5', 'diode', 0.38, '0.38', 'unpowered'], ['PP3V3_S5', 'voltage', 3.3, '3.3', 'powered'], ['PP3V3_S5', 'resistance', 'OL', 'ol', 'unpowered'],
      ['PP1V8_S0', 'voltage', 1.8, '1.8', 'powered'],
      ['PP0V9', 'diode', 0.4, '0.4V', 'unpowered'], ['PP0V9', 'voltage', 0.9, '0V9', 'powered'], ['PP0V9', 'resistance', 4.7, '4R7', 'unpowered'],
      ['NEG', 'voltage', -12, '-12', 'powered'], ['NEG', 'resistance', 2.2e6, '2.2M', 'unpowered'],
      ['WEIRD', 'voltage', 1, '1', 'powered'], ['WEIRD', 'resistance', 1, '1', 'unpowered'],
    ]);
    expect(parsed.readings[0]).toEqual({
      id: openBoardDataReadingId('820-00165', 'PPBUS_G3H', 'diode'), kind: 'diode', target: { net: 'PPBUS_G3H' }, value: 0.412, unit: 'V', raw: '0.412', conditions: { power: 'unpowered' },
      source: 'imported', license: OPENBOARDDATA_LICENSE, provenance: { origin: 'openboarddata', title: '820-00165', attribution: OPENBOARDDATA_ATTRIBUTION, importedAt: now },
      note: 'Main rail, check the  charger first',
    });
    expect(parsed.issues.map(issue => [issue.line, issue.message])).toEqual([
      [15, 'fewer than four fields'], [17, 'net PP3V3_S5 is listed twice; the first line is kept'], [18, 'diode value "-0.2" (out-of-range)'], [19, 'diode value "abc" (unrecognized)'],
    ]);
  });

  it('the same file imported twice gives the same ids, so planImport adds nothing the second time', () => {
    const first = parseOpenBoardData(BOARD_FILE, { now });
    const second = parseOpenBoardData(BOARD_FILE, { now: '2026-10-08T00:00:00Z' });
    expect(second.readings.map(reading => reading.id)).toEqual(first.readings.map(reading => reading.id));
    const existing = new Map(first.readings.map(reading => [reading.id, reading]));
    expect(planImport(second.readings, { origin: 'openboarddata', license: OPENBOARDDATA_LICENSE }, existing, { now, newId: () => 'unused' })).toEqual({ readings: [], unchanged: first.readings.length, renamed: [] });
  });

  it('ODbL readings never enter a CC0 pack unmarked', () => {
    const { readings } = parseOpenBoardData(BOARD_FILE, { now });
    expect(buildPack(readings, { board: {} }).pack.readings).toEqual([]);
    const marked = buildPack(readings, { board: {}, foreign: 'mark' }).pack;
    expect(marked.licenses).toEqual(['CC0-1.0', 'ODbL-1.0']);
    expect(serializePack(marked)).toContain('"license":"ODbL-1.0","provenance":{"origin":"openboarddata"');
  });

  it('reads the combined file of many boards: one board is chosen, millivolt diode files are recognised and reported', () => {
    const combined = ['820-00165 PPBUS_G3H 412 12.6 42k', '820-00165 PP3V3_S5 380 3.3 ol', '820-00840 PP3V3_S5 0.4 3.3 10k', '# comment', '820-00840 PP1V8 0.5 1.8 na extra words'].join('\r\n');
    const unchosen = parseOpenBoardData(combined, { now });
    expect(unchosen.shape).toBe('combined');
    expect(unchosen.boards).toEqual([{ id: '820-00165', lines: 2 }, { id: '820-00840', lines: 2 }]);
    expect(unchosen.board).toBeNull();
    expect(unchosen.readings).toEqual([]);
    const millivolts = parseOpenBoardData(combined, { now, board: '820-00165' });
    expect(millivolts.diodeUnit).toBe('mV');
    expect(millivolts.readings.filter(reading => reading.kind === 'diode').map(reading => [reading.value, reading.raw])).toEqual([[0.412, '412'], [0.38, '380']]);
    const volts = parseOpenBoardData(combined, { now, board: '820-00840' });
    expect(volts.readings.find(reading => reading.target.net === 'PP1V8')?.note).toBe('extra words');
    expect(parseOpenBoardData(combined, { now, board: 'missing' }).issues).toEqual([{ line: 0, message: 'the chosen board is not in the file' }]);
  });

  it('looksLikeOpenBoardData: an ID header or lines of five fields', () => {
    expect(looksLikeOpenBoardData(BOARD_FILE)).toBe(true);
    expect(looksLikeOpenBoardData('820-00165 PPBUS 0.4 12 42k\n820-00165 PP3V3 0.3 3.3 1k\n')).toBe(true);
    expect(looksLikeOpenBoardData('id,kind,net\nr1,diode,PP3V3\n')).toBe(false);
  });
});

describe('detectReadingsFile: the content decides, the name breaks a tie', () => {
  const pack = serializePack(buildPack([], { board: {} }).pack);
  it.each([
    ['set.json', pack, 'pack'], ['set.txt', pack, 'pack'], ['set.json', `﻿${pack}`, 'pack'],
    ['sheet.csv', 'id,kind,net,value\nr1,diode,PP3V3,0.4\n', 'csv'], ['sheet.txt', 'Ref;Pin;Kind;Value\n', 'csv'], ['sheet.csv', 'a,b\n1,2\n', 'csv'],
    ['820-00165.txt', 'ID 820-00165\nPP3V3 0.4 3.3 1k\n', 'openboarddata'], ['obdata.txt', '820-00165 PP3V3 0.4 3.3 1k\n', 'openboarddata'],
    ['other.json', '{"format":"other"}', 'pack'], ['notes.txt', 'hello world', null], ['image.png', '\u0089PNG', null],
  ] as const)('%s', (name, text, kind) => {
    expect(detectReadingsFile(name, text)).toBe(kind);
  });
});
