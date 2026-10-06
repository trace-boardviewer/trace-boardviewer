import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import { BoardFormatError } from './common';
import { parseBoard } from './index';
import { looksLikeSamsungCad, parseSamsungCad } from './samsung-cad';

// Original synthetic files modelled on the record layout OpenBoardView's CADFile.cpp reads (COMP / C_PIN / NET / N_VIA lines after a
// "###Panel Added" comment). No byte of a real file is used; the unknown columns carry placeholder values.
const inch = (value: number) => value * 25.4;
const bytes = (value: string) => new TextEncoder().encode(value);
const text = (rows: string[], eol = '\n') => rows.join(eol) + eol;
const parse = (data: string | Uint8Array, name = 'panel.cad') => parseSamsungCad({ name, data: typeof data === 'string' ? bytes(data) : data });
function must(data: string | Uint8Array, name?: string): Board {
  const board = parse(data, name);
  if (!board) throw new Error('fixture was not recognized');
  return board;
}
function thrown(data: string | Uint8Array): BoardFormatError {
  try { parse(data); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError for ' + JSON.stringify(typeof data === 'string' ? data : '[bytes]'));
}
const notes = (board: Board) => board.warnings.filter(issue => issue.key === 'parse.warning.formatNote').map(issue => String(issue.params?.message));
const pinRows = (board: Board) => board.pins.map(pin => [board.components.find(c => c.id === pin.componentId)!.ref, pin.number, pin.x, pin.y, pin.net, pin.side] as const);

const UNITS_NOTE = 'Samsung CAD: the format is not documented; coordinates are read as inches, like OpenBoardView, and no vendor file was tested.';
const SAMPLE = [
  '###Panel Added: synthetic sample',
  'COMP  U1   PN-100  0  0  1.000  2.000  1  0',
  'COMP  R1   PN-200  0  0  3.000  2.000  2  0',
  'COMP  MH1  PN-300  0  0  0.500  0.500  1  0',
  'COMP  J-1  PN-400  0  0  2.000  0.250  1  0',
  'NET  /VCC',
  'N_VIA  1.250  2.250  X  1  0',
  'N_VIA  -1.250  2.250  X  2  0',
  'C_PIN  U1-1    1.000   2.000  0  0  0  X  /VCC',
  'C_PIN  U1-2    1.100   2.000  0  0  0  X  GND',
  'C_PIN  R1-1    3.000  -2.000  0  0  0  X  /VCC',
  'C_PIN  R1-2    3.100  -2.000  0  0  0  X  UNCONNECTED12',
  'C_PIN  J-1-3   2.000   0.250  0  0  0  X  GND',
  'C_PIN  J-1-4   2.100   0.250  0  0  0  X',
];

describe('Samsung CAD (OpenBoardView CADFile layout)', () => {
  it('parses the golden fixture: inch units, side code 1 = top else bottom, pin numbers after the dash, leading "/" removed', () => {
    const board = must(text(SAMPLE));
    expect(board.format).toBe('Samsung CAD');
    expect(board.name).toBe('panel');
    expect(board.components.map(c => [c.ref, c.side, c.pinIds.length])).toEqual([['U1', 'top', 2], ['R1', 'bottom', 2], ['J-1', 'top', 2]]);
    expect(pinRows(board)).toEqual([
      ['U1', '1', inch(1), inch(2), 'VCC', 'top'], ['U1', '2', inch(1.1), inch(2), 'GND', 'top'],
      ['R1', '1', inch(3), -inch(2), 'VCC', 'bottom'], ['R1', '2', inch(3.1), -inch(2), '', 'bottom'],
      ['J-1', '3', inch(2), inch(0.25), 'GND', 'top'], ['J-1', '4', inch(2.1), inch(0.25), '', 'top'],
    ]);
    expect(board.nets.map(net => [net.name, net.pinIds.length])).toEqual([['VCC', 2], ['GND', 2]]);
    expect(board.pins.every(pin => pin.radius === 0)).toBe(true);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.missingBoardOutline' });
    expect(notes(board)).toEqual([
      '1 pin marked UNCONNECTED by the exporter is shown without a net.',
      '1 component without pins was omitted because the file gives no position for it.',
      UNITS_NOTE,
      '2 N_VIA records are not shown: test vias carry no component or pin.',
    ]);
  });

  it('reads CRLF, trailing blanks, a BOM, blank lines and Windows-1252 net names to the same board', () => {
    const reference = must(text(SAMPLE));
    expect(must(text(SAMPLE, '\r\n'))).toEqual(reference);
    expect(must(text(SAMPLE.map(row => row + '   '), '\r\n\r\n'))).toEqual(reference);
    expect(must('﻿' + text(SAMPLE))).toEqual(reference);
    const latin1 = Uint8Array.from([...bytes(text(SAMPLE.slice(0, 13))), ...bytes('C_PIN  J-1-5   2.200   0.250  0  0  0  X  /N'), 0xb5, 0xa9, 10]);
    expect(must(latin1).pins.at(-1)!.net).toBe('Nµ©');
  });

  it('only removes a LEADING slash from a net name (OpenBoardView drops the first character of any name containing one)', () => {
    const board = must(text([...SAMPLE.slice(0, 4), 'C_PIN  U1-1  1  2  0  0  0  X  /SUB/NET', 'C_PIN  U1-2  1  3  0  0  0  X  A/B', 'C_PIN  R1-1  1  4  0  0  0  X  //TWO']));
    expect(board.pins.map(pin => pin.net)).toEqual(['SUB/NET', 'A/B', '/TWO']);
  });

  it('binds a pin to the longest known component name, accepts a bare component name and numbers pins by position then', () => {
    const board = must(text(['###Panel Added', 'COMP A 1 0 0 0 0 1 0', 'COMP A-B 1 0 0 0 0 2 0', 'C_PIN A-B-7 1 1 0 0 0 X N1', 'C_PIN A-1 2 1 0 0 0 X N1', 'C_PIN A 3 1 0 0 0 X N2']));
    expect(board.components.map(c => [c.ref, c.pinIds.length])).toEqual([['A', 2], ['A-B', 1]]);
    expect(board.pins.map(pin => [pin.componentId === board.components[0].id ? 'A' : 'A-B', pin.number])).toEqual([['A', '1'], ['A', '2'], ['A-B', '7']]);
  });

  it('keeps repeated component names as separate components and binds later pins to the latest one, like the reference reader', () => {
    const board = must(text(['###Panel Added', 'COMP U1 1 0 0 0 0 1 0', 'C_PIN U1-1 1 1 0 0 0 X N1', 'COMP U1 1 0 0 0 0 2 0', 'C_PIN U1-1 2 2 0 0 0 X N2']));
    expect(board.components.map(c => [c.ref, c.side, c.pinIds.length])).toEqual([['U1', 'top', 1], ['U1', 'bottom', 1]]);
    expect(notes(board)).toContain('1 component reuses a reference designator that another component already has; all are kept as separate components.');
  });

  it('places side codes other than 1 on the bottom, as the reference reader does, and says so', () => {
    const board = must(text(['###Panel Added', 'COMP U1 1 0 0 0 0 7 0', 'COMP U2 1 0 0 0 0 2 0', 'C_PIN U1-1 1 1 0 0 0 X N1', 'C_PIN U2-1 2 2 0 0 0 X N1']));
    expect(board.components.map(c => c.side)).toEqual(['bottom', 'bottom']);
    expect(notes(board)).toContain('1 component has a side code other than 1 or 2 and is placed on the bottom side, as OpenBoardView does.');
  });

  it('does not validate the columns the reference reader never uses (COMP X/Y are read as plain strings, the three C_PIN fields before the net are skipped)', () => {
    const board = must(text(['###Panel Added', 'COMP U1 PN-1 a b X? Y? 1 z', 'C_PIN U1-1 1.5 2.5 p q r X N1']));
    expect(pinRows(board)).toEqual([['U1', '1', inch(1.5), inch(2.5), 'N1', 'top']]);
  });

  it('rejects malformed records with a line number and a BoardFormatError', () => {
    const head = ['###Panel Added', 'COMP U1 1 0 0 0 0 1 0'];
    const cases: Array<[string[], RegExp]> = [
      [[...head, 'C_PIN U9-1 1 1 0 0 0 X N1'], /line 3: a C_PIN record references the unknown component "U9-1"/],
      [[...head, 'C_PIN U1-1 1 1 0 0 0'], /line 3: a C_PIN record needs/],
      [[...head, 'C_PIN U1-1 x 1 0 0 0 X N1'], /invalid pin X "x"/],
      [[...head, 'C_PIN U1-1 1 nan 0 0 0 X N1'], /invalid pin Y "nan"/],
      [[...head, 'C_PIN U1-1 1e12 1 0 0 0 X N1'], /exceeds the supported range/],
      [['###Panel Added', 'COMP U1 1 0 0 0 0', 'C_PIN U1-1 1 1 0 0 0 X N1'], /line 2: a COMP record needs/],
      [['###Panel Added C_PIN', 'COMP U1 1 0 0 0 0 1 0'], /no component with pins was found/],
      [['###Panel Added', 'C_PIN U1-1 1 1 0 0 0 X N1'], /unknown component "U1-1"/],
    ];
    for (const [rows, pattern] of cases) {
      const error = thrown(text(rows));
      expect(error.message, rows.join(' | ')).toMatch(pattern);
      expect(error).toMatchObject({ code: 'INVALID_FORMAT', format: 'Samsung CAD' });
    }
  });

  it('is recognized only when both "###Panel Added" and "C_PIN" appear (CADFile::verifyFormat), anywhere in the file', () => {
    expect(looksLikeSamsungCad(bytes(text(SAMPLE)))).toBe(true);
    expect(looksLikeSamsungCad(bytes('x\n'.repeat(5000) + '  ###Panel Added\n' + 'C_PIN'))).toBe(true);
    for (const rejected of ['', '###Panel Added\nCOMP U1 1\n', 'COMP U1 1 0 0 0 0 1 0\nC_PIN U1-1 1 1 0 0 0 X N1\n', '$HEADER\nGENCAD 1.4\n']) {
      expect(parse(rejected), JSON.stringify(rejected)).toBeNull();
    }
    expect(parse(Uint8Array.from([0, 1, 2, 255, 254]))).toBeNull();
  });

  it('is routed by content: GenCAD .cad files stay GenCAD, a Samsung CAD file opens through the dispatcher whatever its extension', () => {
    const viaDispatcher = parseBoard({ name: 'MAIN.CAD', data: bytes(text(SAMPLE)) });
    expect(viaDispatcher.format).toBe('Samsung CAD');
    expect(parseBoard({ name: 'weird.txt', data: bytes(text(SAMPLE)) }).components).toHaveLength(3);
    const gencad = '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nRECTANGLE 0 0 10 10\n$ENDBOARD\n$PADS\nPAD P ROUND -1\nCIRCLE 0 0 0.2\n$ENDPADS\n$PADSTACKS\nPADSTACK PS 0\nPAD P TOP 0 0\n$ENDPADSTACKS\n$SHAPES\nSHAPE S\nPIN 1 PS 0 0 TOP 0 0\n$ENDSHAPES\n$COMPONENTS\nCOMPONENT R1\nPLACE 1 1\nLAYER TOP\nROTATION 0\nSHAPE S\n$ENDCOMPONENTS\n$SIGNALS\nSIGNAL N1\nNODE R1 1\n$ENDSIGNALS\n$TEXT\n###Panel Added\nC_PIN\n$ENDTEXT\n';
    expect(parseBoard({ name: 'board.cad', data: bytes(gencad) }).format).toBe('GENCAD 1.4');
  });

  it('turns every truncation of a valid file into a board, null or a BoardFormatError', () => {
    const data = bytes(text(SAMPLE));
    let boards = 0, failures = 0, nulls = 0;
    for (let length = 0; length <= data.length; length++) {
      try { if (parse(data.slice(0, length))) boards++; else nulls++; }
      catch (error) { expect(error, `prefix ${length}`).toBeInstanceOf(BoardFormatError); failures++; }
    }
    expect(boards).toBeGreaterThan(0); expect(failures).toBeGreaterThan(0); expect(nulls).toBeGreaterThan(0);
  });

  it('bounds resources: components, pins', () => {
    const many = ['###Panel Added C_PIN', ...Array.from({ length: 250_001 }, (_, index) => `COMP R${index} 1 0 0 0 0 1 0`)].join('\n');
    expect(thrown(many)).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});
