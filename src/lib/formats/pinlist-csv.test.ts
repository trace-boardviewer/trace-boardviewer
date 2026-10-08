import { expectScaling, expectCostAtMost, linearReference } from '../../test-support/timing';
import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import headerlessFixture from '../../../tests/fixtures/pinlist/headerless.csv?raw';
import kicadFixture from '../../../tests/fixtures/pinlist/kicad-style.csv?raw';
import preambleFixture from '../../../tests/fixtures/pinlist/preamble.csv?raw';
import quotedFixture from '../../../tests/fixtures/pinlist/quoted.csv?raw';
import semicolonFixture from '../../../tests/fixtures/pinlist/semicolon-decimal-comma.csv?raw';
import tsvFixture from '../../../tests/fixtures/pinlist/tsv-mil.tsv?raw';
import inchIpcFixture from '../../../tests/fixtures/ipc356/inch-two-sided.ipc?raw';
import { BoardFormatError } from './common';
import { PARSERS } from './index';
import { parseIpc356 } from './ipc356';
import {
  analysePinList, buildPinListBoard, CsvTokenizer, decodeChunks, detectEncoding, guessDecimal, guessUnit, headerRole, looksLikePinList, parseNumber, parsePinList, PINLIST_CLAIM_CONFIDENCE, PINLIST_FORMAT,
  PINLIST_MAX_PARTS, PINLIST_MAX_PINS, readPinList, sideOfWord, sniffPinList, type CsvDelimiter, type CsvRecord, type PinListOptions,
} from './pinlist-csv';
import { DEFAULT_CSV_LIMITS, CSV_CHUNK_CHARS } from './pinlist-csv-reader';

// Original synthetic pin lists: a made-up board, no real design. The format is TRACE's own table definition (see pinlist-csv.ts).
const lf = (text: string) => text.replace(/\r\n/g, '\n');
const KICAD = lf(kicadFixture), SEMI = lf(semicolonFixture), TSV = lf(tsvFixture), PREAMBLE = lf(preambleFixture), HEADERLESS = lf(headerlessFixture), QUOTED = lf(quotedFixture);
const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (data: string | Uint8Array, options?: PinListOptions, name = 'list.csv') => parsePinList({ name, data: typeof data === 'string' ? bytes(data) : data }, options);
function must(data: string | Uint8Array, options?: PinListOptions, name?: string): Board {
  const board = parse(data, options, name);
  if (!board) throw new Error('fixture was not recognized');
  return board;
}
function thrown(data: string | Uint8Array, options?: PinListOptions): BoardFormatError {
  try { parse(data, options); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
}
const notes = (board: Board) => board.warnings.filter(issue => issue.key === 'parse.warning.formatNote').map(issue => String(issue.params?.message));
const comp = (board: Board, ref: string) => board.components.find(component => component.ref === ref)!;
const pinsOf = (board: Board, ref: string) => board.pins.filter(pin => pin.componentId === comp(board, ref).id);
const timed = <T>(work: () => T, units: number): { value: T } => {
  expectCostAtMost('netlist input work', work, linearReference(units), 300);
  return { value: work() };
};
const rows = (board: Board, ref: string) => pinsOf(board, ref).map(pin => [pin.number, pin.x, pin.y, pin.net, pin.side]);
const HEADER = 'Ref,Pin,Net,X,Y,Side\n';

function tokenize(text: string, delimiter: CsvDelimiter, chunk = Number.POSITIVE_INFINITY): CsvRecord[] {
  const out: CsvRecord[] = [];
  const tokenizer = new CsvTokenizer(delimiter, record => { out.push(record); });
  for (let at = 0; at < text.length; at += chunk) tokenizer.push(text.slice(at, at + chunk));
  tokenizer.push('', true);
  return out;
}

describe('header words and the column-mapping result', () => {
  const analysis = analysePinList(bytes(KICAD));
  it('maps the columns of a KiCad-style header and says how sure it is', () => {
    expect(analysis).toMatchObject({ encoding: 'utf-8', delimiter: ',', delimiterSource: 'detected', hasHeader: true, headerLine: 1, preambleRecords: 0, missing: [], decimal: '.', decimalSource: 'detected', confidence: 0.95, sampleRecords: 13, sampleComplete: true });
    expect(analysis.mapping).toEqual({ refdes: 0, pin: 1, net: 2, x: 3, y: 4, side: 5 });
    expect(analysis.columns.map(column => [column.index, column.header, column.role, column.source, column.confidence])).toEqual([
      [0, 'Ref', 'refdes', 'header', 1], [1, 'Pin', 'pin', 'header', 1], [2, 'Net', 'net', 'header', 1], [3, 'PosX', 'x', 'header', 1], [4, 'PosY', 'y', 'header', 1], [5, 'Layer', 'side', 'header', 0.8],
    ]);
    expect(analysis.columns[3].samples).toEqual(['10.00', '11.00', '30.50']);
    expect(analysis.sampleRows[0]).toEqual(['R1', '1', 'GND', '10.00', '20.00', 'F.Cu']);
    expect(analysis.side).toMatchObject({ column: 5, top: 9, bottom: 2, both: 2, blank: 0, unknownCount: 0, unknown: [] });
  });
  it('asks for a unit confirmation when the unit is only a guess from the size of the board, and not for anything else', () => {
    expect(analysis.unit).toEqual({ unit: 'mm', mmPerUnit: 1, source: 'guess', confidence: 0.9, candidates: ['mm'] });
    expect(analysis.needsConfirmation).toBe(true);
    expect(analysis.confirm).toEqual(['unit']);
    expect(analysePinList(bytes(KICAD), { unit: 'mm' })).toMatchObject({ needsConfirmation: false, confirm: [], unit: { source: 'user', confidence: 1 } });
  });

  const cases: Array<[string, string[], Record<string, number>]> = [
    ['plain', ['RefDes', 'Pin', 'Net', 'X', 'Y', 'Side'], { refdes: 0, pin: 1, net: 2, x: 3, y: 4, side: 5 }],
    ['long names', ['Reference Designator', 'Pin Number', 'Net Name', 'X Coordinate', 'Y Coordinate', 'Board Side'], { refdes: 0, pin: 1, net: 2, x: 3, y: 4, side: 5 }],
    ['assembly style with units', ['Designator', 'Pad', 'Signal', 'Center-X(mm)', 'Center-Y(mm)', 'Layer'], { refdes: 0, pin: 1, net: 2, x: 3, y: 4, side: 5 }],
    ['underscores', ['REF_DES', 'PIN_NUM', 'NET_NAME', 'LOC_X', 'LOC_Y', 'TB'], { refdes: 0, pin: 1, net: 2, x: 3, y: 4, side: 5 }],
    ['German', ['Bauteil', 'Pin', 'Netz', 'X', 'Y', 'Seite'], { refdes: 0, pin: 1, net: 2, x: 3, y: 4, side: 5 }],
    ['Hungarian with accents', ['Alkatrész', 'Láb', 'Hálózat', 'X', 'Y', 'Oldal'], { refdes: 0, pin: 1, net: 2, x: 3, y: 4, side: 5 }],
    ['Chinese', ['位号', '管脚', '网络', 'X坐标', 'Y坐标', '层别'], { refdes: 0, pin: 1, net: 2, x: 3, y: 4, side: 5 }],
    ['glued units, odd case and blanks', [' ref ', 'PIN', 'net ', 'xmm', 'Ymm', 'SIDE'], { refdes: 0, pin: 1, net: 2, x: 3, y: 4, side: 5 }],
    ['weak words', ['Part', 'Pin Name', 'Net', 'X', 'Y'], { refdes: 0, pin: 1, net: 2, x: 3, y: 4 }],
    ['order does not matter, extra columns are left alone', ['Net', 'Value', 'Y', 'Ref Des', 'Footprint', 'X', 'Pin', 'Notes'], { net: 0, value: 1, y: 2, refdes: 3, package: 4, x: 5, pin: 6 }],
  ];
  for (const [label, header, expected] of cases) {
    it(`reads the header: ${label}`, () => {
      const text = header.join(',') + '\nR1,1,GND,10.5,20.5,Top,a,b\nR1,2,VCC,11.5,20.5,Top,a,b\n';
      const result = analysePinList(bytes(text));
      expect(result.hasHeader).toBe(true);
      expect(result.mapping).toEqual(expected);
      expect(result.missing).toEqual([]);
    });
  }

  it('keeps the better of two columns that name the same role, and never gives one column two roles', () => {
    const result = analysePinList(bytes('Pin Name,Pin,Net,Ref,X,Y\nGND,1,GND,R1,1.5,2.5\nVCC,2,VCC,R1,2.5,2.5\n'));
    expect(result.mapping).toMatchObject({ pin: 1, refdes: 3 });
    expect(result.columns[0].role).toBeUndefined();
    expect(headerRole('Pin Name')).toEqual({ role: 'pin', weight: 0.7 });
    expect(headerRole('X (mm)')).toEqual({ role: 'x', weight: 1, unit: 'mm' });
    expect(headerRole('Y [mils]')).toEqual({ role: 'y', weight: 1, unit: 'mil' });
    expect(headerRole('Pin In')).toBeUndefined(); // a unit means something on a coordinate only
    for (const word of ['', 'Quantity', 'Description', 'X'.repeat(80), 'Ref Des Count']) expect(headerRole(word), word).toBeUndefined();
  });

  it('reads the unit from the header, the lines before it, or a unit word on every number, and says which', () => {
    expect(analysePinList(bytes(TSV)).unit).toMatchObject({ unit: 'mil', mmPerUnit: 0.0254, source: 'header', confidence: 0.95 });
    expect(analysePinList(bytes(SEMI)).unit).toMatchObject({ unit: 'mm', source: 'header' });
    expect(analysePinList(bytes(PREAMBLE)).unit).toMatchObject({ unit: 'mil', source: 'preamble' });
    expect(analysePinList(bytes(HEADER + 'R1,1,A,1.5 mm,2.5 mm,T\nR1,2,B,2.5mm,2.5mm,T\n')).unit).toMatchObject({ unit: 'mm', source: 'value' });
    expect(analysePinList(bytes('Ref,Pin,Net,X(mm),Y(mil),Side\nR1,1,A,1.5,2.5,T\n')).issues.map(issue => issue.code)).toContain('unit-conflict');
  });

  it('guesses a unit from the size of the board, with the other possible units, and falls back to mm with a low confidence', () => {
    expect(guessUnit(100.5, false)).toEqual({ unit: 'mm', candidates: ['mm'], confidence: 0.9 });
    expect(guessUnit(3.9, false)).toEqual({ unit: 'inch', candidates: ['inch'], confidence: 0.9 });
    expect(guessUnit(12.5, false)).toEqual({ unit: 'mm', candidates: ['mm', 'inch'], confidence: 0.5 });
    expect(guessUnit(4000, true)).toEqual({ unit: 'mil', candidates: ['mil'], confidence: 0.9 });
    expect(guessUnit(100000, true)).toEqual({ unit: 'um', candidates: ['um'], confidence: 0.9 });
    expect(guessUnit(500, true)).toMatchObject({ unit: 'mil', candidates: ['mil', 'mm'] });
    expect(guessUnit(0.2, false)).toEqual({ unit: 'mm', candidates: [], confidence: 0.1 });
    expect(guessUnit(0, true).confidence).toBe(0.1);
  });

  it('lists the columns in a table that no header describes, with a guess from the values at a low confidence', () => {
    const unknown = analysePinList(bytes('Name,Lead,Signal,East,North,Face\nR1,1,GND,10.5,20.5,Top\nR1,2,VCC,11.5,20.5,Top\nU1,1,SDA,30.5,20.5,Bottom\n'));
    expect(unknown.hasHeader).toBe(true); // words no role knows over rows of numbers
    expect(unknown.mapping).toEqual({ refdes: 0, pin: 1, net: 2, x: 3, y: 4, side: 5 });
    expect(unknown.columns.map(column => column.source)).toEqual(['content', 'content', 'header', 'content', 'content', 'header']);
    expect(unknown).toMatchObject({ confidence: 0.4, reason: 'the header words are not known: the columns were guessed from the values' });
    expect(unknown.confirm).toContain('columns');
    expect(parse('Name,Lead,Signal,East,North,Face\nR1,1,GND,10.5,20.5,Top\nR1,2,VCC,11.5,20.5,Top\n')).toBeNull();
  });

  it('guesses a table without any header from the values: designators, side words, two spread-out numeric columns, short pins, nets', () => {
    const result = analysePinList(bytes(HEADERLESS));
    expect(result).toMatchObject({ hasHeader: false, headerLine: 0, confidence: 0.4, missing: [] });
    expect(result.mapping).toEqual({ refdes: 0, pin: 1, net: 2, x: 3, y: 4, side: 5 });
    expect(result.columns.every(column => column.source === 'content' && column.confidence === 0.4)).toBe(true);
    expect(result.columns.map(column => column.header)).toEqual(['Column 1', 'Column 2', 'Column 3', 'Column 4', 'Column 5', 'Column 6']);
    expect(result.issues.map(issue => issue.code)).toContain('no-header');
    expect(result.confirm).toContain('columns');
    expect(parse(HEADERLESS)).toBeNull(); // below the claim threshold
    const board = must(HEADERLESS, { mapping: result.mapping, hasHeader: false, unit: 'mm' });
    expect(board.components.map(component => component.ref)).toEqual(['R1', 'R2', 'C1', 'U1']);
    expect(rows(board, 'C1')).toEqual([['1', 30.5, 20, 'SIG_A', 'bottom'], ['2', 31.5, 20, 'GND', 'bottom']]);
  });

  it('reads past the title lines in front of the header and counts them', () => {
    const result = analysePinList(bytes(PREAMBLE));
    expect(result).toMatchObject({ hasHeader: true, headerLine: 5, preambleRecords: 3, confidence: 0.95 });
    expect(result.mapping).toEqual({ refdes: 0, pin: 1, net: 2, x: 3, y: 4, side: 5 });
    expect(result.issues.map(issue => issue.code)).toContain('preamble');
    const board = must(PREAMBLE);
    expect(notes(board)).toContain('3 lines in front of the header were skipped.');
    expect(board.components.map(component => component.ref)).toEqual(['R1', 'U7', 'C9']);
    expect(rows(board, 'U7')[0]).toEqual(['1', 101.6, 25.4, '+3V3', 'top']);
  });
});

describe('delimiters, quoting, encodings and line endings', () => {
  const reference = must(KICAD);
  const asComma = (delimiter: string) => KICAD.split('\n').map(line => line.replace(/,/g, delimiter)).join('\n');
  it('finds the delimiter itself: comma, semicolon, tab and bar', () => {
    for (const delimiter of [',', ';', '\t', '|']) {
      const text = asComma(delimiter);
      expect(analysePinList(bytes(text)).delimiter, JSON.stringify(delimiter)).toBe(delimiter);
      expect(must(text), JSON.stringify(delimiter)).toEqual(reference);
    }
  });
  it('lets a "sep=" line choose the delimiter and ignores it, and lets the caller force one', () => {
    const board = must('sep=;\n' + asComma(';'));
    expect(board).toEqual(reference);
    expect(analysePinList(bytes('sep=;\n' + asComma(';')))).toMatchObject({ delimiter: ';', delimiterSource: 'sep-line', headerLine: 1 });
    expect(analysePinList(bytes(asComma(';')), { delimiter: ';' }).delimiterSource).toBe('user');
    expect(must('sep=,\r\n' + KICAD)).toEqual(reference);
  });
  it('picks the tab when net names hold commas and the semicolon when the numbers hold decimal commas', () => {
    expect(analysePinList(bytes('Ref\tPin\tNet\tX\tY\nU1\t1\tA,B,C\t1.5\t2.5\nU1\t2\tD,E\t2.5\t2.5\n')).delimiter).toBe('\t');
    expect(analysePinList(bytes(SEMI)).delimiter).toBe(';');
  });
  it('reads CRLF, lone CR, a byte-order mark, trailing blank lines, blank lines inside and a missing last line break to the same board', () => {
    expect(must(KICAD.replace(/\n/g, '\r\n'))).toEqual(reference);
    expect(must(KICAD.replace(/\n/g, '\r'))).toEqual(reference);
    expect(must('﻿' + KICAD)).toEqual(reference);
    expect(must(KICAD + '\n\n\n')).toEqual(reference);
    expect(must(KICAD.replace(/\n/g, '\n\n'))).toEqual(reference);
    expect(must(KICAD.replace(/\n$/, ''))).toEqual(reference);
  });
  it('reads UTF-16 with and without a byte-order mark, and windows-1252', () => {
    const utf16 = (text: string, little: boolean, mark: boolean) => {
      const out = new Uint8Array((text.length + (mark ? 1 : 0)) * 2);
      const view = new DataView(out.buffer);
      let at = 0;
      if (mark) { view.setUint16(at, 0xfeff, little); at += 2; }
      for (let index = 0; index < text.length; index++, at += 2) view.setUint16(at, text.charCodeAt(index), little);
      return out;
    };
    for (const [little, mark] of [[true, true], [false, true], [true, false], [false, false]] as const) {
      expect(must(utf16(KICAD, little, mark)), `${little ? 'LE' : 'BE'} ${mark ? 'with' : 'without'} mark`).toEqual(reference);
    }
    const latin = Uint8Array.from([...bytes(HEADER + 'U1,1,'), 0xb5, 0xa9, 0xe9, ...bytes(',1.5,2.5,T\nU1,2,B,2.5,2.5,T\n')]);
    expect(detectEncoding(latin)?.encoding).toBe('windows-1252');
    expect(pinsOf(must(latin), 'U1')[0].net).toBe('µ©é');
    expect(analysePinList(latin).encoding).toBe('windows-1252');
    expect(must(bytes(HEADER + 'U1,1,Ünï,1.5,2.5,T\nU1,2,B,2.5,2.5,T\n')).pins[0].net).toBe('Ünï');
  });
  it('reads quoted fields with delimiters, doubled quotes and line breaks inside', () => {
    const board = must(QUOTED, { unit: 'mm' });
    expect(pinsOf(board, 'R1').map(pin => [pin.number, pin.net])).toEqual([['1', 'GND'], ['2', 'NET,WITH,COMMAS']]);
    expect(pinsOf(board, 'R2').map(pin => [pin.number, pin.net, pin.y])).toEqual([['1', 'say "hi"', 22], ['2', 'VCC', 22]]);
    expect(comp(board, 'R1').value).toBe('10k, 1%');
    expect(comp(board, 'R2').value).toBe('two\nlines');
    expect(analysePinList(bytes(QUOTED)).mapping).toMatchObject({ value: 6, net: 2 });
  });
  it('tolerates the quoting that real exports get wrong: a quote inside a word, text after a closing quote, an unclosed quote at the end', () => {
    const board = must(HEADER + 'U1,1,5" screen,1.5,2.5,T\nU1,2,"B"x,2.5,2.5,T\nU1,3,C,3.5,2.5,T');
    expect(pinsOf(board, 'U1').map(pin => pin.net)).toEqual(['5" screen', 'Bx', 'C']);
    expect(notes(board)).toContain('1 record has text after a closing quote; the text was kept as part of the field.');
    const open = must(HEADER + 'U1,1,A,1.5,2.5,T\nU1,2,"B,2.5,2.5,T\nU1,3,C,3.5,2.5,T\n');
    expect(open.pins.map(pin => pin.net)).toEqual(['A']); // the rest of the file is one field of a short row
    expect(notes(open).some(message => /^A quoted field is never closed \(line 3\)/.test(message))).toBe(true);
    expect(notes(open).some(message => /^1 row was skipped: 1 too short for the mapped columns/.test(message))).toBe(true);
  });
  it('tokenizes a text the same way however it is cut into chunks (also across surrogate pairs and CRLF)', () => {
    const text = 'a,"b ""q"" c",\r\n"multi\r\nline",x,y\r"cr only",,\n\n' + '😀,é,日本\r\n' + 'last,"unfinished';
    const whole = tokenize(text, ',');
    expect(whole.map(record => record.fields)).toEqual([['a', 'b "q" c', ''], ['multi\r\nline', 'x', 'y'], ['cr only', '', ''], ['😀', 'é', '日本'], ['last', 'unfinished']]);
    expect(whole.map(record => record.line)).toEqual([1, 2, 4, 6, 7]);
    for (let chunk = 1; chunk < 60; chunk++) expect(tokenize(text, ',', chunk), `chunk ${chunk}`).toEqual(whole);
  });
  it('keeps at most the limit of fields of a record, also when the text ends with a delimiter after the last of them', () => {
    const { maxFields } = DEFAULT_CSV_LIMITS;
    for (const extra of [0, 1, 2, 5]) {
      const count = maxFields + extra;
      for (const ending of ['', '\n', ',']) {
        const text = `${Array.from({ length: count }, (_, index) => `f${index}`).join(',')}${ending}`;
        const [record] = tokenize(text, ',');
        const label = `${count} fields, ending ${JSON.stringify(ending)}`;
        expect(record.fields.length, label).toBeLessThanOrEqual(maxFields);
        expect(record.fields.slice(0, 3), label).toEqual(['f0', 'f1', 'f2']);
        const fields = count + (ending === ',' ? 1 : 0);
        expect(Boolean(record.flags & 8), label).toBe(fields > maxFields);
      }
    }
  });
  it('decodes in pieces without splitting a character', () => {
    const text = 'ab😀é日本cd\n'.repeat(50);
    for (const [encoding, data] of [['utf-8', bytes(text)], ['utf-16le', (() => { const out = new Uint8Array(text.length * 2); const view = new DataView(out.buffer); for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true); return out; })()]] as const) {
      for (const chunk of [1, 2, 3, 5, 7, 64]) expect([...decodeChunks(data, { encoding, bomLength: 0 }, chunk)].join(''), `${encoding} ${chunk}`).toBe(text);
    }
  });
});

describe('numbers', () => {
  it('parses plain decimals in the stated convention, with grouping and unit words', () => {
    expect(parseNumber('12.5')).toEqual({ value: 12.5 });
    expect(parseNumber('-0.5')).toEqual({ value: -0.5 });
    expect(parseNumber('+7')).toEqual({ value: 7 });
    expect(parseNumber('.5')).toEqual({ value: 0.5 });
    expect(parseNumber('5.')).toEqual({ value: 5 });
    expect(parseNumber('1e3')).toEqual({ value: 1000 });
    expect(parseNumber('1E-3')).toEqual({ value: 0.001 });
    expect(parseNumber('12,5', ',')).toEqual({ value: 12.5 });
    expect(parseNumber('−3,25', ',')).toEqual({ value: -3.25 });
    expect(parseNumber(' 1 234,5 ', ',')).toEqual({ value: 1234.5 });
    expect(parseNumber('1.234,5', ',')).toEqual({ value: 1234.5 });
    expect(parseNumber('1,234.5')).toEqual({ value: 1234.5 });
    expect(parseNumber("1'234.5")).toEqual({ value: 1234.5 });
    expect(parseNumber('12.5 mm')).toEqual({ value: 12.5, unit: 'mm' });
    expect(parseNumber('100mil')).toEqual({ value: 100, unit: 'mil' });
    expect(parseNumber('100 mils')).toEqual({ value: 100, unit: 'mil' });
    expect(parseNumber('0.5"')).toEqual({ value: 0.5, unit: 'inch' });
    expect(parseNumber('2 in')).toEqual({ value: 2, unit: 'inch' });
    expect(parseNumber('250 µm')).toEqual({ value: 250, unit: 'um' });
    expect(parseNumber('3,5 mm', ',')).toEqual({ value: 3.5, unit: 'mm' });
  });
  it('rejects everything that is not a plain number: hexadecimal, words, specials, the wrong separator, doubled signs, very long text', () => {
    for (const text of ['', ' ', '0x10', '0b1', 'Infinity', 'NaN', 'abc', '1.2.3', '1,2,3', '--1', '+-1', '1e', 'e5', '1 2', '12,5', '1..5', '.', '-', '12.5mmm', '12.5 cm', '1e400', '9'.repeat(40), '1'.repeat(60)]) {
      expect(parseNumber(text), JSON.stringify(text)).toBeUndefined();
    }
    expect(parseNumber('12.5', ',')).toBeUndefined();
    expect(parseNumber('1e16')).toBeUndefined();
  });
  it('detects the decimal separator from the fractions that are written', () => {
    expect(guessDecimal(['1,5', '2,25', '3'])).toEqual({ decimal: ',', source: 'detected', dot: 0, comma: 2 });
    expect(guessDecimal(['1.5', '2.25', '3'])).toEqual({ decimal: '.', source: 'detected', dot: 2, comma: 0 });
    expect(guessDecimal(['1', '2', '3'])).toEqual({ decimal: '.', source: 'default', dot: 0, comma: 0 });
    expect(guessDecimal(['1,5', '2.5', '3.5'])).toMatchObject({ decimal: '.', dot: 2, comma: 1 });
    expect(guessDecimal(['1,5 mm', '2,5 mm'])).toMatchObject({ decimal: ',' });
    expect(guessDecimal(['x'.repeat(100), '1,5'.repeat(30)])).toMatchObject({ source: 'default' });
  });
  it('reads a decimal-comma list and lets the caller override the separator', () => {
    const board = must(SEMI);
    expect(rows(board, 'U1')).toEqual([['1', 40, 10, 'VCC', 'top'], ['2', 40, 10.8, 'SIG_A', 'top'], ['3', 40, 11.6, '', 'top'], ['4', 40, 12.4, 'GND', 'top']]);
    expect(notes(board)).toContain('Numbers are read with a decimal comma.');
    expect(analysePinList(bytes(SEMI))).toMatchObject({ decimal: ',', decimalSource: 'detected' });
    expect(analysePinList(bytes(SEMI), { decimal: '.' })).toMatchObject({ decimal: '.', decimalSource: 'user' });
    expect(parse(SEMI, { decimal: '.' })).toBeNull(); // not claimed: no coordinate is readable with that separator
    expect(thrown(SEMI, { decimal: '.', mapping: { refdes: 0 } }).message).toMatch(/no row could be read as a pin \(13 with coordinates that are not numbers/);
  });
  it('flags a file that mixes both separators', () => {
    const mixed = 'Ref;Pin;Net;X;Y\nU1;1;A;1,5;2,5\nU1;2;B;2.5;3.5\nU1;3;C;3,5;4,5\n';
    const result = analysePinList(bytes(mixed));
    expect(result.decimal).toBe(',');
    expect(result.issues.map(issue => issue.code)).toContain('decimal-mixed');
    expect(result.confirm).toContain('decimal');
    expect(must(mixed).pins.length).toBe(2);
  });
});

describe('sides', () => {
  it('knows the usual words for the sides, in several tools and languages', () => {
    for (const word of ['Top', 'TOP', 'top layer', 'TopLayer', 'T', 'F.Cu', 'Front', 'Component', 'oben', '顶层']) expect(sideOfWord(word), word).toBe('top');
    for (const word of ['Bottom', 'BOT', 'Bottom Layer', 'B', 'B.Cu', 'Back', 'Solder', 'unten', '底层']) expect(sideOfWord(word), word).toBe('bottom');
    for (const word of ['Both', 'TH', 'Thru', 'Through-hole', 'Multi-Layer', 'All']) expect(sideOfWord(word), word).toBe('both');
    for (const word of ['', '0', '1', '2', 'Mid', 'x'.repeat(40)]) expect(sideOfWord(word), word).toBeUndefined();
  });
  it('puts a part on the side of its pins, and on both when its pins are on different sides', () => {
    const board = must(KICAD);
    expect(board.components.map(component => [component.ref, component.side])).toEqual([['R1', 'top'], ['R2', 'top'], ['C1', 'bottom'], ['U1', 'top'], ['J1', 'both'], ['TP1', 'top']]);
    expect(must(HEADER + 'X1,1,A,1,1,T\nX1,2,B,2,1,B\n').components[0].side).toBe('both');
  });
  it('uses the default side for a file without a side column, an empty cell or an unknown word, and says so', () => {
    const none = must('Ref,Pin,Net,X,Y\nU1,1,A,1.5,2.5\nU1,2,B,2.5,2.5\n');
    expect(none.pins.map(pin => pin.side)).toEqual(['top', 'top']);
    expect(notes(none)).toContain('The file has no side column; every pin is on the top side.');
    expect(must('Ref,Pin,Net,X,Y\nU1,1,A,1.5,2.5\nU1,2,B,2.5,2.5\n', { defaultSide: 'bottom' }).pins.map(pin => pin.side)).toEqual(['bottom', 'bottom']);
    const odd = must(HEADER + 'U1,1,A,1.5,2.5,1\nU1,2,B,2.5,2.5,\nU1,3,C,3.5,2.5,Comp\nU1,4,D,4.5,2.5,Bottom\n', { defaultSide: 'bottom' });
    expect(odd.pins.map(pin => pin.side)).toEqual(['bottom', 'bottom', 'top', 'bottom']);
    expect(notes(odd)).toContain('1 row has a side that is not recognised (1) and is shown on the bottom side.');
    expect(notes(odd)).toContain('1 row has no side and is shown on the bottom side.');
  });
  it('takes side words from the caller\'s map', () => {
    const text = HEADER + 'U1,1,A,1.5,2.5,1\nU1,2,B,2.5,2.5,2\nU1,3,C,3.5,2.5,0\n';
    expect(must(text, { sideMap: { '1': 'top', '2': 'bottom', '0': 'both' } }).pins.map(pin => pin.side)).toEqual(['top', 'bottom', 'both']);
    expect(analysePinList(bytes(text), { sideMap: { '1': 'top', '2': 'bottom', '0': 'both' } }).side).toMatchObject({ top: 1, bottom: 1, both: 1, unknownCount: 0 });
    expect(analysePinList(bytes(text)).side).toMatchObject({ unknownCount: 3, unknown: ['1', '2', '0'] });
    expect(analysePinList(bytes(text)).confirm).toContain('side');
  });
});

describe('a pin list to a board', () => {
  it('rebuilds parts, pins and nets exactly as listed (mm, Y up), and marks body, pad size and outline as estimated', () => {
    const board = must(KICAD, undefined, 'my-list.csv');
    expect(board).toMatchObject({ format: PINLIST_FORMAT, name: 'my-list', units: 'mm' });
    expect(board.components.map(component => [component.ref, component.pinIds.length])).toEqual([['R1', 2], ['R2', 2], ['C1', 2], ['U1', 4], ['J1', 2], ['TP1', 1]]);
    expect(rows(board, 'R1')).toEqual([['1', 10, 20, 'GND', 'top'], ['2', 11, 20, 'VCC', 'top']]);
    expect(rows(board, 'U1')).toEqual([['1', 40, 10, 'VCC', 'top'], ['2', 40, 10.8, 'SIG_A', 'top'], ['3', 40, 11.6, '', 'top'], ['4', 40, 12.4, 'GND', 'top']]);
    expect(rows(board, 'J1')).toEqual([['1', 5.08, 5.08, 'GND', 'both'], ['2', 5.08, 7.62, 'VCC', 'both']]);
    expect(board.nets.map(net => [net.name, net.pinIds.length])).toEqual([['GND', 4], ['VCC', 4], ['SIG_A', 3], ['SIG_B', 1]]);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 13 } });
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackComponents', params: { count: 6 } });
    expect(board.warnings).toContainEqual({ key: 'parse.warning.missingBoardOutline' });
    expect(comp(board, 'U1').bounds.minX).toBeCloseTo(39.7, 9);
    expect(notes(board)[0]).toMatch(/^Pin list import: reference designators, pins, nets and positions are read from the file as mapped\. The file has no pad sizes, component bodies or board outline/);
    expect(notes(board)).toContain('The file does not state the unit of its coordinates; they are read as mm, the only unit that gives a plausible board size.');
    expect(board.components.every(component => component.value === '' && component.package === '')).toBe(true);
  });
  it('converts mil, inch, micrometre and a caller-given unit to mm exactly, and applies a unit word on a number first', () => {
    const board = must(TSV);
    expect(rows(board, 'R1')).toEqual([['1', 25.4, 50.8, 'GND', 'top'], ['2', 27.94, 50.8, 'VCC', 'top']]);
    expect(rows(board, 'U7').map(row => row.slice(0, 5))).toEqual([['A1', 101.6, 25.4, '+3V3', 'top'], ['A2', 102.87, 25.4, 'SDA', 'top'], ['B1', 101.6, 26.67, 'SCL', 'top'], ['B2', 102.87, 26.67, '', 'top']]);
    expect(rows(board, 'C9')[0]).toEqual(['1', 152.4, 50.8, 'GND', 'bottom']);
    expect(notes(board).some(message => /does not state the unit/.test(message))).toBe(false);
    const plain = HEADER + 'U1,1,A,1000,2000,T\nU1,2,B,1100,2000,T\n';
    expect(pinsOf(must(plain, { unit: 'mil' }), 'U1').map(pin => [pin.x, pin.y])).toEqual([[25.4, 50.8], [27.94, 50.8]]);
    expect(pinsOf(must(plain, { unit: 'um' }), 'U1').map(pin => [pin.x, pin.y])).toEqual([[1, 2], [1.1, 2]]);
    expect(pinsOf(must(HEADER + 'U1,1,A,1,2,T\nU1,2,B,1.5,2,T\n', { unit: 'inch' }), 'U1').map(pin => [pin.x, pin.y])).toEqual([[25.4, 50.8], [38.1, 50.8]]);
    expect(pinsOf(must(plain, { unitsToMm: 0.01 }), 'U1').map(pin => [pin.x, pin.y])).toEqual([[10, 20], [11, 20]]);
    expect(pinsOf(must(plain, { unitsToMm: 0.01, unit: 'mil' }), 'U1')[0].x).toBe(10);
    const suffixed = must(HEADER + 'U1,1,A,1 in,2 in,T\nU1,2,B,10 mm,100 mil,T\nU1,3,C,5,5,T\n', { unit: 'mm' });
    expect(pinsOf(suffixed, 'U1').map(pin => [pin.x, pin.y])).toEqual([[25.4, 50.8], [10, 2.54], [5, 5]]);
    expect(notes(suffixed)).toContain('4 coordinates carry their own unit word, which takes precedence.');
  });
  it('guesses mil for a list of integers and says that it did', () => {
    const board = must(HEADER + 'U1,1,A,1000,2000,T\nU1,2,B,1100,2000,T\nU1,3,C,3000,1500,T\nU1,4,D,4000,2500,T\n');
    expect(board.pins[0]).toMatchObject({ x: 25.4, y: 50.8 });
    expect(notes(board)).toContain('The file does not state the unit of its coordinates; they are read as mil, the only unit that gives a plausible board size.');
    const tiny = must(HEADER + 'U1,1,A,0.1,0.2,T\nU1,2,B,0.3,0.2,T\n');
    expect(notes(tiny)).toContain('The file does not state the unit of its coordinates and none gives a plausible board size; they are read as mm.');
  });
  it('flips Y on request', () => {
    expect(pinsOf(must(HEADER + 'U1,1,A,1.5,2.5,T\nU1,2,B,2.5,-3.5,T\n', { flipY: true, unit: 'mm' }), 'U1').map(pin => pin.y)).toEqual([-2.5, 3.5]);
  });
  it('keeps net names exactly as written, reads N/C and No Net as no net, and keeps NC and unconnected-... names', () => {
    const board = must(HEADER + 'U1,1,+3V3,1,1,T\nU1,2,/Sub/Net_1,2,1,T\nU1,3,mixed Case 7,3,1,T\nU1,4,N/C,4,1,T\nU1,5,n/c,5,1,T\nU1,6,No Net,6,1,T\nU1,7,NC,7,1,T\nU1,8,unconnected-(R1-Pad2),8,1,T\nU1,9,,9,1,T\n');
    expect(board.pins.map(pin => pin.net)).toEqual(['+3V3', '/Sub/Net_1', 'mixed Case 7', '', '', '', 'NC', 'unconnected-(R1-Pad2)', '']);
    expect(notes(board)).toContain('3 pins are listed as N/C or No Net and have no net.');
  });
  it('merges rows of one pin at one place, keeps pads of one number at other places apart, and numbers a pin without a number with the smallest free one', () => {
    const board = must(HEADER + 'SP1,1,GND,5,5,T\nSP1,1,GND,5,5,T\nSP1,1,VCC,5,5,B\nU9,9,A,1,1,T\nU9,9,A,2,1,T\nMH1,2,A,1,1,T\nMH1,,,2,1,T\nMH1,,,3,1,T\nMH1,1,,4,1,T\nMH1,,,5,1,T\n', { unit: 'mm' });
    expect(rows(board, 'SP1')).toEqual([['1', 5, 5, 'GND', 'both']]);
    expect(rows(board, 'U9').map(row => row.slice(0, 3))).toEqual([['9', 1, 1], ['9', 2, 1]]);
    expect(pinsOf(board, 'MH1').map(pin => [pin.number, pin.numberGenerated])).toEqual([['2', undefined], ['3', true], ['4', true], ['1', undefined], ['5', true]]);
    expect(notes(board)).toEqual(expect.arrayContaining([
      '2 rows repeat a pin of the same reference at the same position and were merged into it.',
      '1 merged row names a different net than the first; the first net is kept.',
      '2 pins share a pin number with another pin of the same reference at another position (a pad listed twice or a multi-pad pin); they are kept as separate pads.',
      '3 rows have no pin number; the smallest free number was used.',
    ]));
  });
  it('keeps the value and package of the first row of a reference', () => {
    const board = must('Ref,Pin,Net,X,Y,Value,Footprint\nR1,1,A,1,1,10k,R_0603\nR1,2,B,2,1,,\nC1,1,A,3,1,,C_0402\nC1,2,B,4,1,100n,\n');
    expect(board.components.map(component => [component.ref, component.value, component.package])).toEqual([['R1', '10k', 'R_0603'], ['C1', '100n', 'C_0402']]);
  });
  it('builds a board with no nets (and says so) when there is no net column', () => {
    const board = must('Ref,Pin,X,Y,Side\nU1,1,1.5,2.5,T\nU1,2,2.5,2.5,T\n');
    expect(board.nets).toEqual([]);
    expect(notes(board)).toContain('The file has no net column; the board has no nets.');
    expect(board.warnings).toContainEqual({ key: 'parse.warning.noNets' });
  });
  it('counts and names the rows it skips, with the first line', () => {
    const good = Array.from({ length: 8 }, (_, index) => `U1,${index + 10},A,${index + 1.5},2.5,T`).join('\n');
    const text = HEADER + 'U1,1,A,1.5,2.5,T\n,2,B,2.5,2.5,T\nU1,3,C,abc,2.5,T\nU1,4\nU1,5,E,,,T\n\n   \n,,,,,\nU1,6,F,3.5,2.5,T\n' + good + '\n';
    const board = must(text);
    expect(board.pins.map(pin => pin.number)).toEqual(['1', '6', '10', '11', '12', '13', '14', '15', '16', '17']);
    expect(notes(board)).toContain('4 rows were skipped: 2 with coordinates that are not numbers, 1 without a reference designator, 1 too short for the mapped columns (the first on line 3).');
    expect(readPinList(bytes(text)).stats.examples.map(item => [item.code, item.line])).toEqual([['no-reference', 3], ['bad-coordinates', 4], ['short-row', 5], ['bad-coordinates', 6]]);
  });
  it('refuses a table that cannot be read as a pin list: most rows unreadable, or none', () => {
    const columns = { mapping: { refdes: 0, pin: 1, net: 2, x: 3, y: 4 } };
    expect(thrown(HEADER + 'U1,1,A,x,y,T\nU1,2,B,x,y,T\nU1,3,C,1,2,T\n', columns).message).toMatch(/only 1 of 3 rows could be read as a pin \(2 with coordinates that are not numbers/);
    expect(thrown(HEADER + 'U1,1,A,x,y,T\n', columns)).toMatchObject({ code: 'INVALID_FORMAT', format: PINLIST_FORMAT });
    expect(parse(HEADER + 'U1,1,A,x,y,T\n')).toBeNull(); // not claimed: no row has a readable position
    expect(thrown(HEADER).message).toMatch(/no data rows/);
    expect(thrown(HEADER + '\n\n  \n').message).toMatch(/no data rows/);
  });
  it('names the missing columns, and says that a list without positions is a netlist', () => {
    const netlist = thrown('RefDes,Pin,Net\nU1,1,GND\nU1,2,VCC\n');
    expect(netlist).toMatchObject({ code: 'UNSUPPORTED_VARIANT', format: PINLIST_FORMAT });
    expect(netlist.message).toMatch(/but no X and Y columns; without positions it is a netlist, not a board/);
    expect(sniffPinList(bytes('RefDes,Pin,Net\nU1,1,GND\nU1,2,VCC\n')).confidence).toBe(0.6);
    const one = thrown('Ref,Pin,Net,X\nU1,1,GND,1\nU1,2,VCC,2\n', { mapping: { refdes: 0, pin: 1 } });
    expect(one.message).toMatch(/no column was found for y; the columns are "Ref", "Pin", "Net", "X"/);
  });
  it('maps by the caller: by index or header text, removing a role, and refuses a column that does not exist', () => {
    const odd = 'Name,Lead,Signal,East,North,Face\nR1,1,GND,10.5,20.5,Top\nR1,2,VCC,11.5,20.5,Bottom\n';
    const board = must(odd, { mapping: { refdes: 'name', pin: 'LEAD', net: 2, x: 'East', y: 'North', side: 5 }, unit: 'mm' });
    expect(rows(board, 'R1')).toEqual([['1', 10.5, 20.5, 'GND', 'top'], ['2', 11.5, 20.5, 'VCC', 'bottom']]);
    expect(must(odd, { mapping: { net: null } }).nets).toEqual([]);
    expect(must(odd, { mapping: { net: null, side: null } }).pins.map(pin => pin.side)).toEqual(['top', 'top']);
    expect(analysePinList(bytes(odd), { mapping: { refdes: 0, pin: 1, x: 3, y: 4 } })).toMatchObject({ confidence: 0.9, reason: expect.stringMatching(/chosen by the caller/) });
    // a column that serves another role is taken from it
    const swapped = analysePinList(bytes(odd), { mapping: { pin: 'East', x: 'Lead' } });
    expect(swapped.mapping).toMatchObject({ pin: 3, x: 1 });
    expect(thrown(odd, { mapping: { pin: 'Missing' } }).message).toMatch(/The pin column "Missing" does not exist \(the table has 6 columns: "Name", "Lead"/);
    expect(thrown(odd, { mapping: { pin: 9 } }).message).toMatch(/The pin column number 10 does not exist/);
    expect(thrown(odd, { mapping: { pin: -1 } }).message).toMatch(/does not exist/);
    expect(analysePinList(bytes(odd), { mapping: { pin: 9 } }).issues.map(issue => issue.code)).toContain('unknown-column');
  });
  it('treats a first record as the header when asked, and as data when told there is none', () => {
    const text = 'a,b,c,d,e\nR1,1,GND,10.5,20.5\nR1,2,VCC,11.5,20.5\n';
    expect(analysePinList(bytes(text), { hasHeader: true }).hasHeader).toBe(true);
    expect(must(text, { mapping: { refdes: 'a', pin: 'b', net: 'c', x: 'd', y: 'e' }, hasHeader: true }).pins.length).toBe(2);
    const board = must(text, { mapping: { refdes: 0, pin: 1, net: 2, x: 3, y: 4 }, hasHeader: false });
    expect(board.pins.length).toBe(2); // the header row is a bad row: skipped and counted
    expect(notes(board).some(message => /1 row was skipped: 1 with coordinates that are not numbers/.test(message))).toBe(true);
  });
  it('reads the document in two steps with the same result as parsePinList', () => {
    const data = bytes(KICAD);
    const document = readPinList(data);
    expect(document.parts.map(part => [part.ref, part.side, part.pins.length])).toEqual([['R1', 'top', 2], ['R2', 'top', 2], ['C1', 'bottom', 2], ['U1', 'top', 4], ['J1', 'both', 2], ['TP1', 'top', 1]]);
    expect(document.stats).toMatchObject({ rows: 13, used: 13, blank: 0, short: 0, noRef: 0, badCoordinates: 0, merged: 0, noNet: 0 });
    expect(document.unit).toMatchObject({ unit: 'mm', source: 'guess' });
    expect(buildPinListBoard({ name: 'list.csv', data }, document)).toEqual(must(KICAD));
  });
  it('lets a caller who has confirmed a mapping read a file that nothing would claim', () => {
    const text = 'x1\tx2\tx3\tx4\tx5\nU1\t1\tA\t1.5\t2.5\nU1\t2\tB\t2.5\t2.5\n';
    expect(parse(text)).toBeNull();
    expect(must(text, { mapping: { refdes: 0, pin: 1, net: 2, x: 3, y: 4 } }).pins.length).toBe(2);
    expect(() => parse(new Uint8Array([0, 1, 2, 3, 4, 5, 255, 254, 0, 0, 1, 1, 1, 1]), { mapping: { refdes: 0, pin: 1, x: 2, y: 3 } })).toThrow(BoardFormatError);
  });
  it('judges the claim with the caller\'s options: a file the caller says has no header is not claimed, one with a forced delimiter is', () => {
    expect(parse(KICAD, { hasHeader: false })).toBeNull();
    expect(must(KICAD, { delimiter: ',', unit: 'mm' }).pins.length).toBe(13);
    expect(parse(KICAD, { delimiter: ';' })).toBeNull();
  });
  it('lists the side words it did not recognise over the whole file, not only the sample', () => {
    const body = Array.from({ length: 600 }, (_, index) => `R${index},1,N,${index % 90 + 10},${index % 80 + 10},${index < 450 ? 'Top' : index % 2 ? 'Mid' : 'Weird'}`).join('\n');
    const document = readPinList(bytes(HEADER + body), { unit: 'mm' });
    expect(document.analysis.side.unknown).toEqual([]);
    expect(document.stats).toMatchObject({ sideUnknown: 150, sideUnknownWords: ['Weird', 'Mid'] });
    expect(notes(buildPinListBoard({ name: 'x.csv', data: bytes(HEADER + body) }, document, { unit: 'mm' }))).toContain('150 rows have a side that is not recognised (Weird, Mid) and are shown on the top side.');
  });
});

describe('recognition (sniff) and claims', () => {
  it('is confident about a header that names a designator, a pin, X and Y, a little less without a net, and says what it saw', () => {
    expect(sniffPinList(bytes(KICAD))).toMatchObject({ confidence: 0.95, delimiter: ',', hasHeader: true, roles: ['refdes', 'pin', 'net', 'x', 'y', 'side'] });
    expect(sniffPinList(bytes('Ref,Pin,X,Y\nU1,1,1.5,2.5\nU1,2,2.5,2.5\n')).confidence).toBe(0.85);
    expect(sniffPinList(bytes(KICAD)).reason).toBe('a header names refdes, pin, net, x, y, side');
    expect(looksLikePinList(bytes(KICAD))).toBe(true);
    expect(PINLIST_CLAIM_CONFIDENCE).toBe(0.5);
  });
  it('lowers the claim when most rows have no readable coordinates', () => {
    expect(sniffPinList(bytes('Ref,Pin,Net,X,Y\nU1,1,A,x,y\nU1,2,B,x,y\nU1,3,C,1,2\n')).confidence).toBe(0.4);
    expect(parse('Ref,Pin,Net,X,Y\nU1,1,A,x,y\nU1,2,B,x,y\nU1,3,C,1,2\n')).toBeNull();
  });
  it('does not claim other tables: BOMs, pick-and-place and assembly files without a pin, plain data, one column', () => {
    const others: Record<string, string> = {
      bom: 'Reference,Value,Footprint,Quantity\nR1,10k,R_0603,1\nR2,10k,R_0603,1\n',
      pnp: 'Ref,Val,Package,PosX,PosY,Rot,Side\nR1,10k,R_0603,10.0,20.0,0,top\nR2,10k,R_0603,12.0,20.0,90,top\n',
      jlc: 'Designator,Mid X,Mid Y,Layer,Rotation\nR1,10.0mm,20.0mm,Top,0\nR2,12.0mm,20.0mm,Top,90\n',
      numbers: 'a,b,c\n1,2,3\n4,5,6\n',
      oneColumn: 'RefDes\nU1\nU2\n',
      prose: 'This is a text file\nwith a few lines\nand nothing else\n',
      empty: '',
      blank: '\n\n\n\n\n\n\n\n\n\n\n\n',
      tooShort: 'a,b\n1,2\n',
    };
    for (const [name, text] of Object.entries(others)) {
      expect(sniffPinList(bytes(text)).confidence, name).toBeLessThan(PINLIST_CLAIM_CONFIDENCE);
      expect(parse(text), name).toBeNull();
    }
  });
  it('does not claim the samples of any other registered format, nor an IPC-D-356 netlist, and no other registered format claims a pin list (collision check)', () => {
    const others: Record<string, string> = {
      gencad: '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nRECTANGLE 0 0 10 10\n$ENDBOARD\n$COMPONENTS\nCOMPONENT R1\nPLACE 1 1\n$ENDCOMPONENTS\n',
      samsung: '###Panel Added\nCOMP U1 PN 0 0 1.0 2.0 1 0\nC_PIN U1-1 1.0 2.0 0 0 0 X GND\n',
      brd2: 'BRDOUT: 4 1000 1000\n0 0\n1000 0\n1000 1000\n0 1000\nNETS: 1\n1 GND\nPARTS: 1\nU1 0 1 1 1\nPINS: 1\n100 100 1 1\nNAILS: 0\n',
      bvr: 'BVRAW_FORMAT_3\nBOARD 0 0 100 100\nPART_NAME U1\nPART_SIDE T\nPIN_NUMBER 1\nPIN_X 10\nPIN_Y 20\n',
      ipc2581: '<?xml version="1.0"?>\n<IPC-2581 revision="C">\n</IPC-2581>\n',
      gerber: '%FSLAX36Y36*%\n%MOMM*%\nG04 layer*\nM02*\n',
      ipc356: lf(inchIpcFixture),
    };
    for (const [name, text] of Object.entries(others)) { expect(sniffPinList(bytes(text)).confidence, name).toBeLessThan(PINLIST_CLAIM_CONFIDENCE); expect(parse(text), name).toBeNull(); }
    expect(parseIpc356({ name: 'x.csv', data: bytes(KICAD) })).toBeNull();
    for (const fixture of [KICAD, SEMI, TSV, PREAMBLE, QUOTED]) for (const { id, parse: other } of PARSERS.filter(entry => entry.id !== 'pinlist')) expect(other({ name: 'list.csv', data: bytes(fixture) }), id).toBeNull();
  });
  it('declines binary data, random bytes and a short buffer', () => {
    expect(sniffPinList(Uint8Array.from([0, 1, 2, 3, 255, 254, 253, 0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])).confidence).toBe(0);
    expect(sniffPinList(new Uint8Array(1000)).confidence).toBe(0);
    expect(sniffPinList(bytes('Ref,Pin')).confidence).toBe(0);
    let seed = 11;
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let round = 0; round < 50; round++) expect(parse(Uint8Array.from({ length: 4096 }, () => random() & 0xff)), `round ${round}`).toBeNull();
    expect(analysePinList(new Uint8Array(0)).confidence).toBe(0);
    expect(analysePinList(bytes('hello')).issues.length).toBeGreaterThan(0);
  });
  it('sniffs the first 64 KiB only: a header after that is not seen, and a record cut by the limit is ignored', () => {
    const body = Array.from({ length: 3000 }, (_, index) => `R${index},1,N${index % 50},${index},${index % 90},T`).join('\n');
    expect(sniffPinList(bytes(HEADER + body)).confidence).toBe(0.95);
    expect(sniffPinList(bytes(body + '\n' + HEADER)).confidence).toBeLessThan(PINLIST_CLAIM_CONFIDENCE);
    expect(sniffPinList(bytes('x'.repeat(200_000) + '\n' + HEADER + body)).confidence).toBe(0);
  });
  it('analyses a whole table that is bigger than the sample', () => {
    const body = Array.from({ length: 3000 }, (_, index) => `R${index},1,N${index % 50},${index},${index % 90},T`).join('\n');
    const result = analysePinList(bytes(HEADER + body));
    expect(result).toMatchObject({ sampleRecords: 399, sampleComplete: false, hasHeader: true });
  });
});

describe('malformed and hostile input', () => {
  it('turns every truncation of a valid list into a board, null or a BoardFormatError, nothing else', () => {
    const data = bytes(KICAD);
    let boards = 0, failures = 0, nulls = 0;
    for (let length = 0; length <= data.length; length++) {
      try { if (parse(data.slice(0, length))) boards++; else nulls++; }
      catch (error) { expect(error, `prefix ${length}`).toBeInstanceOf(BoardFormatError); failures++; }
    }
    expect(boards).toBeGreaterThan(0); expect(nulls).toBeGreaterThan(0); expect(failures).toBeGreaterThanOrEqual(0);
  });
  it('survives random byte and line mutations of the fixtures: a board, null or a BoardFormatError (also with a mapping given)', () => {
    let seed = 0x2545f491;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };
    const sources = [KICAD, SEMI, TSV, PREAMBLE, QUOTED, HEADERLESS].map(bytes);
    const outcomes = { board: 0, nul: 0, error: 0 };
    for (let round = 0; round < 800; round++) {
      const data = Uint8Array.from(sources[round % sources.length]);
      for (let flips = 1 + Math.floor(random() * 6); flips > 0; flips--) data[Math.floor(random() * data.length)] = random() < 0.4 ? 0x20 + Math.floor(random() * 96) : Math.floor(random() * 256);
      const cut = random() < 0.2 ? data.slice(0, Math.floor(random() * data.length)) : data;
      try { if (parse(cut, round % 3 === 0 ? { mapping: { refdes: 0, pin: 1, net: 2, x: 3, y: 4 } } : undefined)) outcomes.board++; else outcomes.nul++; }
      catch (error) { expect(error, `round ${round}`).toBeInstanceOf(BoardFormatError); outcomes.error++; }
    }
    expect(outcomes.board).toBeGreaterThan(0); expect(outcomes.error).toBeGreaterThan(0);
  });
  it('never fails analysis, whatever the bytes', () => {
    let seed = 5;
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let round = 0; round < 100; round++) {
      const data = Uint8Array.from({ length: 1 + (random() % 3000) }, () => (round % 2 ? 0x20 + (random() % 96) : random() & 0xff));
      const result = analysePinList(data, { mapping: { refdes: random() % 5, x: 'zz' }, delimiter: ',' });
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(sniffPinList(data).confidence).toBeLessThan(PINLIST_CLAIM_CONFIDENCE);
    }
  });
  it('bounds the number of pins and parts', () => {
    const rowsText = Array.from({ length: 6 }, (_, index) => `R${index},1,N,${index},0,T`).join('\n');
    expect(thrown(HEADER + rowsText, { limits: { maxParts: 5 } })).toMatchObject({ code: 'LIMIT_EXCEEDED', format: PINLIST_FORMAT });
    expect(must(HEADER + rowsText, { limits: { maxParts: 6 } }).components.length).toBe(6);
    const pins = Array.from({ length: 6 }, (_, index) => `R1,${index},N,${index},0,T`).join('\n');
    expect(thrown(HEADER + pins, { limits: { maxPins: 5 } }).message).toMatch(/pin count exceeds the import limit/);
    expect(PINLIST_MAX_PINS).toBe(1_000_000);
    expect(PINLIST_MAX_PARTS).toBe(250_000);
    const lines: string[] = [HEADER.trim()];
    for (let index = 0; index <= PINLIST_MAX_PARTS; index++) lines.push(`R${index},1,N,${index % 1000},${index >> 10},T`);
    expect(thrown(lines.join('\n'))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  }, 300_000);
  it('refuses input over the 64 MiB import limit before reading it, and reads a table with columns far to the right', () => {
    expect(thrown(new Uint8Array(64 * 1024 * 1024 + 1), { mapping: { refdes: 0, pin: 1, x: 2, y: 3 } })).toMatchObject({ code: 'LIMIT_EXCEEDED', format: PINLIST_FORMAT, message: 'Board data exceeds the 64 MiB import limit.' });
    const names = Array.from({ length: 120 }, (_, index) => `c${index}`);
    names[100] = 'Ref'; names[110] = 'Pin'; names[115] = 'X'; names[119] = 'Y'; names[90] = 'Net';
    const row = (ref: string, pin: string, net: string, x: string, y: string) => { const cells = Array.from({ length: 120 }, () => ''); cells[100] = ref; cells[110] = pin; cells[115] = x; cells[119] = y; cells[90] = net; return cells.join(','); };
    const board = must(names.join(',') + '\n' + row('U1', '1', 'A', '1.5', '2.5') + '\n' + row('U1', '2', 'B', '2.5', '2.5') + '\n', { unit: 'mm' });
    expect(rows(board, 'U1')).toEqual([['1', 1.5, 2.5, 'A', 'top'], ['2', 2.5, 2.5, 'B', 'top']]);
    expect(analysePinList(bytes(names.join(',') + '\n' + row('U1', '1', 'A', '1.5', '2.5') + '\n')).columns).toHaveLength(120);
  });
  it('cuts fields and rows that are too long and says so, and refuses a record that never ends', () => {
    const long = 'N' + 'x'.repeat(DEFAULT_CSV_LIMITS.maxFieldChars + 100);
    const board = must(HEADER + `U1,1,${long},1.5,2.5,T\nU1,2,B,2.5,2.5,T\n`);
    expect(board.pins[0].net).toHaveLength(DEFAULT_CSV_LIMITS.maxFieldChars);
    expect(notes(board)).toContain('1 field is longer than 4096 characters and was cut.');
    const wide = must(HEADER.trim() + ',x'.repeat(600) + '\nU1,1,A,1.5,2.5,T' + ',y'.repeat(600) + '\nU1,2,B,2.5,2.5,T\n');
    expect(wide.pins.length).toBe(2);
    expect(notes(wide)).toContain('2 rows have more than 512 cells; the extra cells were dropped.');
    expect(thrown(HEADER + 'U1,1,"' + 'a'.repeat(2_000_000))).toMatchObject({ code: 'LIMIT_EXCEEDED', format: undefined });
    expect(thrown(HEADER + 'U1,1,' + 'a'.repeat(2_000_000))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
  it('handles floods of blank lines, quotes, delimiters, spaces and long lines in bounded time', () => {
    const cases: Array<[string, string]> = [
      ['blank lines', HEADER + '\n'.repeat(4_000_000)], ['CRLF blank lines', HEADER + '\r\n'.repeat(2_000_000)], ['one space per line', HEADER + ' \n'.repeat(1_000_000)],
      ['delimiters only', HEADER + ','.repeat(3_000_000) + '\n'], ['quotes only', HEADER + '"'.repeat(4_000_000)], ['quote pairs', HEADER + '""'.repeat(2_000_000) + '\n'],
      ['one line without a break', 'x'.repeat(8_000_000)], ['header then one huge field', HEADER + 'U1,1,' + 'z'.repeat(8_000_000)], ['many short rows without a unit', HEADER + 'a,b,c,d,e\n'.repeat(300_000)],
      ['alternating quote and comma', HEADER + '",'.repeat(1_000_000)],
    ];
    for (const [label, text] of cases) {
      const result = timed(() => { try { return parse(text); } catch (error) { return error; } }, text.length);

      expect(result.value === null || result.value instanceof BoardFormatError, label).toBe(true);
    }
  }, 300_000);
  it('checks the number and header patterns against crafted worst cases in linear time', () => {
    const cells = ['1'.repeat(40) + 'x', '1,'.repeat(20), '1.'.repeat(20), '-'.repeat(40) + '1', '1e' + '1'.repeat(40), '1 ' + '1'.repeat(30) + ' mm', ' '.repeat(40) + '1', '(' + 'm'.repeat(30) + ')', 'x' + ' mm'.repeat(20), 'x_' + 'mm'.repeat(30), '"'.repeat(40)];
    const result = timed(() => { for (let round = 0; round < 20_000; round++) for (const cell of cells) { parseNumber(cell, '.'); parseNumber(cell, ','); headerRole(cell); sideOfWord(cell); } }, 20_000 * cells.reduce((n, cell) => n + cell.length, 0));
  });
});

describe('large lists: streamed in pieces and bounded', () => {
  const big = (count: number, eol = '\n') => {
    const parts: string[] = ['RefDes,Pin,Net Name,X (mm),Y (mm),Side'];
    for (let index = 0; index < count; index++) parts.push(`${index % 7 ? 'C' : 'J'}${index >> 2},${(index % 4) + 1},${index % 5 ? 'NET' + (index % 4000) : 'GND'},${(index % 1000) * 0.1 + 0.05},${(index >> 10) * 0.1},${index % 11 ? 'Top' : 'Bottom'}`);
    return parts.join(eol) + eol;
  };
  it('decodes a 20 MB list in pieces of bounded size, never as one string', () => {
    const data = bytes(big(400_000));
    expect(data.length).toBeGreaterThan(15_000_000);
    const guess = detectEncoding(data)!;
    let pieces = 0, longest = 0, total = 0;
    for (const piece of decodeChunks(data, guess)) { pieces++; longest = Math.max(longest, piece.length); total += piece.length; }
    expect(pieces).toBeGreaterThan(50);
    expect(longest).toBeLessThanOrEqual(CSV_CHUNK_CHARS);
    expect(total).toBe(data.length);
  });
  it('reads 400,000 rows (about 20 MB) quickly, in linear time, to the same board for every line ending', () => {
    expectScaling('CSV rows', [25_000, 100_000, 400_000], n => { const data = bytes(big(n)); return () => parse(data); });
    const text = big(400_000);
    const data = bytes(text);
    const result = { value: parse(data)! };
    expect(result.value.pins.length).toBe(400_000);
    expect(result.value.components.length).toBeGreaterThan(90_000);

    expect(parse(bytes(big(2000, '\r\n')))).toEqual(parse(bytes(big(2000, '\n'))));
    expect(sniffPinList(data).confidence).toBe(0.95);
  }, 300_000);
  it('keeps a part with a very large number of pins linear (one reference with 100,000 pins)', () => {
    const lines = ['Ref,Pin,Net,X,Y'];
    for (let index = 0; index < 100_000; index++) lines.push(`U1,${index},N${index % 100},${index % 300},${index >> 8}`);
    for (let index = 0; index < 1000; index++) lines.push(`U1,${index},N${index % 100},${index % 300},${index >> 8}`); // duplicates, merged
    expectScaling('pins of one CSV reference', [6250, 25_000, 100_000], n => { const text = lines.slice(0, n + 1).join('\n'); return () => must(text, { unit: 'mm' }); });
    const result = { value: must(lines.join('\n'), { unit: 'mm' }) };
    expect(result.value.pins.length).toBe(100_000);
    expect(notes(result.value).some(message => /^1000 rows repeat a pin/.test(message))).toBe(true);
  }, 300_000);
});
