import { describe, expect, it } from 'vitest';
import type { Board, Point } from '../types';
import { BoardFormatError } from './common';
import { parseBvr } from './bvr';

const inch = (value: number) => value * 25.4;
const mil = (value: number) => value * 0.0254;
const bytes = (value: string) => new TextEncoder().encode(value);
const text = (rows: string[], eol = '\r\n') => rows.join(eol) + eol;
const parse = (data: string | Uint8Array, name = 'board.bvr') => parseBvr({ name, data: typeof data === 'string' ? bytes(data) : data });
function must(data: string | Uint8Array, name?: string): Board {
  const board = parse(data, name);
  if (!board) throw new Error('fixture was not recognized');
  return board;
}
function thrown(data: string | Uint8Array): BoardFormatError {
  try { parse(data); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
}
const notes = (board: Board) => board.warnings.filter(issue => issue.key === 'parse.warning.formatNote').map(issue => String(issue.params?.message));
const pinRows = (board: Board) => board.pins.map(pin => {
  const component = board.components.find(candidate => candidate.id === pin.componentId)!;
  return [component.ref, pin.number, pin.x, pin.y, pin.net, pin.side] as const;
});
const sorted = (points: Point[]) => [...points].sort((a, b) => a.x - b.x || a.y - b.y);
const keys = (board: Board) => board.warnings.map(warning => warning.key);

const BVR1 = [
  'BVRAW_FORMAT_1',
  '<<Layout>>', 'X,Y',
  '0.000,0.000', '2.000, 0.000', '2.000 1.000', '0.000,1.000',
  '<<Pin>>', 'PART SIDE ID NAME X Y LAYER NET',
  'U1\t(T)\t1\t1\t0.100\t0.200\t1\tVCC',
  'U1 (T) 2 2 0.150 0.200 1 UNCONNECTED3',
  'R1 (B) 1 A1 1.500 0.500 2 GND',
  'R1 (B) 2 A2 1.600 0.500 2 GND 7',
  '<<Nail>>', 'TAG X Y TYPE GRID SIDE NETID NET',
  'N1\t0.100 0.200 1 G1 (T) 3 VCC',
  'N2\t1.500 0.500 2 G2 (B) 4 GND',
];

describe('BVRAW_FORMAT_1', () => {
  it('parses the golden fixture: inch units, per-line sides, comma or blank separated outline', () => {
    const board = must(text(BVR1));
    expect(board.format).toBe('BVR raw boardview (BVRAW_FORMAT_1)');
    expect(board.name).toBe('board');
    expect(board.components.map(c => [c.ref, c.side])).toEqual([['U1', 'top'], ['R1', 'bottom'], ['TP:1', 'top'], ['TP:2', 'bottom']]);
    expect(pinRows(board)).toEqual([
      ['U1', '1', inch(0.1), inch(0.2), 'VCC', 'top'],
      ['U1', '2', inch(0.15), inch(0.2), '', 'top'],
      ['R1', 'A1', inch(1.5), inch(0.5), 'GND', 'bottom'],
      ['R1', 'A2', inch(1.6), inch(0.5), 'GND', 'bottom'],
      ['TP:1', '1', inch(0.1), inch(0.2), 'VCC', 'top'],
      ['TP:2', '2', inch(1.5), inch(0.5), 'GND', 'bottom'],
    ]);
    expect(board.outline).toEqual([{ x: 0, y: 0 }, { x: inch(2), y: 0 }, { x: inch(2), y: inch(1) }, { x: 0, y: inch(1) }]);
    expect(board.pins.every(pin => pin.radius === 0 && pin.width === undefined)).toBe(true);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 6 } });
  });
  it('does not turn UNCONNECTED<n> into a net (B06)', () => {
    const board = must(text(BVR1));
    expect(board.nets.map(net => net.name).sort()).toEqual(['GND', 'VCC']);
    expect(notes(board)).toEqual(['1 pin marked UNCONNECTED by the exporter is shown without a net.']);
    // The same exporter marker with a two-digit counter; the substitution must really change the fixture, or the second check would repeat the first.
    const twoDigit = BVR1.map(row => row.replace('UNCONNECTED3', 'UNCONNECTED12'));
    expect(twoDigit.filter(row => row.endsWith(' UNCONNECTED12'))).toHaveLength(1);
    expect(twoDigit).not.toEqual(BVR1);
    expect(must(text(twoDigit)).nets.some(net => net.name.startsWith('UNCONNECTED'))).toBe(false);
  });
  it('starts a component whenever the part name changes and keeps each pin line\'s own side', () => {
    const board = must(text(['BVRAW_FORMAT_1', '<<Pin>>', 'h', 'U1 (T) 1 1 0.1 0.1 1 A', 'R1 (B) 1 1 0.2 0.1 1 B', 'R1 (T) 2 2 0.3 0.1 1 B', 'U1 (T) 3 3 0.4 0.1 1 C']));
    expect(board.components.map(c => [c.ref, c.side, c.pinIds.length])).toEqual([['U1', 'top', 1], ['R1', 'bottom', 2], ['U1', 'top', 1]]);
    expect(board.pins.map(pin => pin.side)).toEqual(['top', 'bottom', 'top', 'top']);
    expect(notes(board)).toEqual(['1 component reuses a reference designator that another component already has; all are kept as separate components.']);
    expect(keys(board)).toContain('parse.warning.missingBoardOutline');
  });
  it('discloses side markers other than (T)/(B) and ignored sections', () => {
    const board = must(text([...BVR1.slice(0, 9), 'U1 X 1 1 0.1 0.1 1 A', '<<Net>>', 'whatever']));
    expect(board.components[0].side).toBe('bottom');
    expect(notes(board)).toEqual(['1 record has a side marker other than (T) or (B) and is placed on the bottom side, as OpenBoardView does.', 'Sections without a documented layout were ignored: <<Net>>.']);
  });
  it('rejects malformed records', () => {
    const body = (...rows: string[]) => text(['BVRAW_FORMAT_1', '<<Pin>>', 'h', ...rows]);
    const cases: Array<[string, RegExp]> = [
      [body('U1 (T) 1 1 0.1 0.1 1'), /line 4: a pin needs part, side, id, name, X, Y, layer and net/],
      [body('U1 (T) 1 1 0.1 0.1 1 A 1 2'), /a pin needs part/],
      [body('U1 (T) x 1 0.1 0.1 1 A'), /invalid pin id "x"/],
      [body('U1 (T) 1 1 0.1 nan 1 A'), /invalid pin Y "nan"/],
      [body('U1 (T) 1 1 0.1 0.1 1.2 A'), /invalid pin layer/],
      [body('U1 (T) 1 1 0.1 0.1 1 A -3'), /invalid probe/],
      [text(['BVRAW_FORMAT_1', '<<Layout>>', 'h', '1']), /an outline point needs two coordinates/],
      [text(['BVRAW_FORMAT_1', '<<Layout>>', 'h', '1,2,3', '<<Pin>>', 'h']), /two coordinates/],
      [text(['BVRAW_FORMAT_1', '<<Layout>>', 'h', '1,x']), /invalid outline Y "x"/],
      [text(['BVRAW_FORMAT_1', '<<Layout>>', 'h', '1,2']), /missing <<Pin>> section/],
      [text(['BVRAW_FORMAT_1', '<<Pin>>', 'h']), /no component with pins was found/],
      [text(['BVRAW_FORMAT_1', '<<Pin>>', '<<Nail>>', 'U1 (T) 1 1 0.1 0.1 1 A']), /<<Pin>> has fewer than its 1 header lines/],
      [text(['BVRAW_FORMAT_1', '<<Pin>>', 'h', 'U1 (T) 1 1 0.1 0.1 1 A', '<<Pin>>', 'h']), /duplicate <<Pin>> section/],
      [body('U1 (T) 1 1 0.1 0.1 1 A', '<<Nail>>', 'h', 'N1 0.1 0.2 1 G (T) 3 VCC'), /a test point needs a tab/],
      [body('U1 (T) 1 1 0.1 0.1 1 A', '<<Nail>>', 'h', 'N1\t0.1 0.2 1 G (T) 3'), /a test point needs X, Y, type, grid, side, net id and net/],
      [body('U1 (T) 1 1 0.1 0.1 1 A', '<<Nail>>', 'h', 'N1\tq 0.2 1 G (T) 3 V'), /invalid test point X "q"/],
      [body('U1 (T) 1 1 1e12 0.1 1 A'), /exceeds the supported range/],
    ];
    for (const [input, pattern] of cases) {
      const error = thrown(input);
      expect(error.message, input).toMatch(pattern);
      expect(error).toMatchObject({ code: 'INVALID_FORMAT', format: 'BVR raw boardview (BVRAW_FORMAT_1)' });
    }
  });
});

const BVR3 = [
  'BVRAW_FORMAT_3',
  'OUTLINE_POINTS 0 0 3000 0 3000 2000 0 2000',
  'PART_NAME U1', 'PART_SIDE T', 'PART_ORIGIN 1000 2000', 'PART_MOUNT SMD', 'PART_OUTLINE_RELATIVE -50 -50 50 50',
  'PIN_ID 1', 'PIN_NUMBER 1', 'PIN_NAME A1', 'PIN_SIDE T', 'PIN_ORIGIN 10 -20', 'PIN_RADIUS 12.5', 'PIN_NET VCC', 'PIN_TYPE SMD', 'PIN_COMMENT hello world', 'PIN_END',
  'PIN_NUMBER 2', 'PIN_ORIGIN -10 -20', 'PIN_RADIUS 12.5', 'PIN_NET UNCONNECTED7', 'PIN_SIDE T', 'PIN_END',
  'PART_END',
  'PART_NAME J1', 'PART_SIDE O', 'PART_ORIGIN 2500 500', 'PIN_NUMBER 1', 'PIN_SIDE O', 'PIN_ORIGIN 0 0', 'PIN_RADIUS 20', 'PIN_NET GND', 'PIN_END', 'PART_END',
  'PART_NAME C1', 'PART_SIDE B', 'PART_ORIGIN 500 500', 'PART_END',
];

describe('BVRAW_FORMAT_3', () => {
  it('parses the golden fixture: mil units, relative pin origins, real radii, T/B/O sides', () => {
    const board = must(text(BVR3));
    expect(board.format).toBe('BVR raw boardview (BVRAW_FORMAT_3)');
    expect(board.components.map(c => [c.ref, c.side, c.pinIds.length])).toEqual([['U1', 'top', 2], ['J1', 'both', 1], ['C1', 'bottom', 0]]);
    expect(pinRows(board)).toEqual([
      ['U1', '1', mil(1010), mil(1980), 'VCC', 'top'],
      ['U1', '2', mil(990), mil(1980), '', 'top'],
      ['J1', '1', mil(2500), mil(500), 'GND', 'both'],
    ]);
    expect(board.pins.map(pin => pin.name)).toEqual(['A1', '2', '1']);
    expect(board.pins.map(pin => pin.radius)).toEqual([mil(12.5), mil(12.5), mil(20)]);
    expect(board.pins[0].radius).toBeCloseTo(0.3175, 12);
    expect(board.pins[0].x).toBeCloseTo(25.654, 12);
    expect(board.components[0].position).toEqual({ x: mil(1000), y: mil(2000) });
    expect(board.components[2].position).toEqual({ x: mil(500), y: mil(500) });
    expect(board.outline).toEqual([{ x: 0, y: 0 }, { x: mil(3000), y: 0 }, { x: mil(3000), y: mil(2000) }, { x: 0, y: mil(2000) }]);
    expect(keys(board)).not.toContain('parse.warning.fallbackPads');
    expect(notes(board)).toEqual([
      '1 pin marked UNCONNECTED by the exporter is shown without a net.',
      '1 PART_OUTLINE_RELATIVE/PIN_OUTLINE_RELATIVE record is not used: the reference reader does not document custom outlines.',
      'BVR3 PIN_RADIUS is applied as the pad radius in mil, like PIN_ORIGIN; OpenBoardView recomputes pad sizes itself, so the unit has not been verified against a vendor file.',
    ]);
  });
  it('does not turn UNCONNECTED<n> into a net but keeps similar real names (B06)', () => {
    const board = must(text(BVR3.map(row => row === 'PIN_NET GND' ? 'PIN_NET UNCONNECTEDLY' : row)));
    expect(board.nets.map(net => net.name).sort()).toEqual(['UNCONNECTEDLY', 'VCC']);
  });
  it('uses the reference defaults for absent sides (both) and a missing radius stays unknown', () => {
    const board = must(text(['BVRAW_FORMAT_3', 'PART_NAME U1', 'PART_ORIGIN 100 100', 'PIN_ORIGIN 5 5', 'PIN_END', 'PART_END']));
    expect(board.components[0].side).toBe('both');
    expect(board.pins[0]).toMatchObject({ number: '~1', name: '~1', numberGenerated: true, side: 'both', net: '', radius: 0 });
    expect(notes(board)).toEqual(['2 records have no side field and are shown on both sides, as OpenBoardView does.']);
    expect(keys(board)).toContain('parse.warning.fallbackPads');
    expect(keys(board)).toContain('parse.warning.missingBoardOutline');
  });
  it('numbers by PIN_NUMBER, then PIN_NAME, then "~" and the position in the part', () => {
    const board = must(text(['BVRAW_FORMAT_3', 'PART_NAME U1', 'PART_SIDE T', 'PART_ORIGIN 0 0', 'PIN_NAME X', 'PIN_ORIGIN 1 1', 'PIN_END', 'PIN_ORIGIN 2 2', 'PIN_END', 'PIN_NUMBER 7', 'PIN_NAME Y', 'PIN_ORIGIN 3 3', 'PIN_END', 'PART_END']));
    expect(board.pins.map(pin => [pin.number, pin.name])).toEqual([['X', 'X'], ['~2', '~2'], ['7', 'Y']]);
    // a number taken from the file (PIN_NUMBER or PIN_NAME) is real; "~" and the position in the part is a placeholder that no real number of the part can be
    expect(board.pins.map(pin => pin.numberGenerated)).toEqual([undefined, true, undefined]);
  });
  it('reads OUTLINE_SEGMENTED in any order and direction, and discloses open chains', () => {
    const base = ['BVRAW_FORMAT_3', 'PART_NAME U1', 'PART_SIDE T', 'PART_ORIGIN 10 10', 'PART_END'];
    const closed = must(text([...base, 'OUTLINE_SEGMENTED 1000 0 1000 500 0 0 1000 0', 'OUTLINE_SEGMENTED 0 500 0 0 1000 500 0 500']));
    expect(sorted(closed.outline)).toEqual(sorted([{ x: 0, y: 0 }, { x: mil(1000), y: 0 }, { x: mil(1000), y: mil(500) }, { x: 0, y: mil(500) }]));
    expect(keys(closed)).not.toContain('parse.warning.missingBoardOutline');
    const open = must(text([...base, 'OUTLINE_SEGMENTED 0 0 1000 0 1000 0 1000 500']));
    expect(keys(open)).toContain('parse.warning.missingBoardOutline');
    expect(notes(open)).toEqual(['1 OUTLINE_SEGMENTED chain does not close and is not drawn.']);
  });
  it('reads several OUTLINE_POINTS lines as separate loops: the largest is the outline, the rest are cutouts', () => {
    const board = must(text(['BVRAW_FORMAT_3', 'OUTLINE_POINTS 100 100 200 100 200 200 100 200', 'PART_NAME U1', 'PART_SIDE T', 'PART_ORIGIN 10 10', 'PART_END', 'OUTLINE_POINTS 0 0 1000 0 1000 800 0 800']));
    expect(board.outline).toEqual([{ x: 0, y: 0 }, { x: mil(1000), y: 0 }, { x: mil(1000), y: mil(800) }, { x: 0, y: mil(800) }]);
    expect(keys(board)).toContain('parse.warning.boardCutouts');
    expect(notes(board)).toEqual(['2 OUTLINE_POINTS lines were read as separate loops; the largest is the board outline.']);
  });
  it('ignores unrecognized keywords with a disclosure', () => {
    const board = must(text([...BVR3, 'BOARD_THICKNESS 62', 'WHAT 1']));
    expect(notes(board)).toContain('Lines with unrecognized keywords were ignored: BOARD_THICKNESS, WHAT.');
  });
  it('rejects malformed and truncated structure', () => {
    const head = ['BVRAW_FORMAT_3'];
    const cases: Array<[string[], RegExp]> = [
      [[...head, 'PART_NAME U1', 'PART_NAME U2'], /PART_NAME starts before the previous part reached PART_END/],
      [[...head, 'PIN_NUMBER 1'], /PIN_NUMBER appears outside a PART_NAME ... PART_END block/],
      [[...head, 'PART_SIDE T'], /PART_SIDE appears outside/],
      [[...head, 'PART_NAME'], /PART_NAME needs a name/],
      [[...head, 'PART_NAME U1', 'PART_SIDE X'], /PART_SIDE must be T, B or O, not "X"/],
      [[...head, 'PART_NAME U1', 'PART_SIDE constructor'], /PART_SIDE must be T, B or O/],
      [[...head, 'PART_NAME U1', 'PART_ORIGIN 1'], /PART_ORIGIN needs two coordinates/],
      [[...head, 'PART_NAME U1', 'PART_ORIGIN 1 nan'], /invalid part origin Y "nan"/],
      [[...head, 'PART_NAME U1', 'PART_SIDE T', 'PART_SIDE T'], /PART_SIDE is given twice/],
      [[...head, 'PART_NAME U1', 'PART_ORIGIN 0 0', 'PIN_NET A', 'PIN_NET B'], /PIN_NET is given twice/],
      [[...head, 'PART_NAME U1', 'PIN_ORIGIN 1 1'], /PIN_ORIGIN appears before PART_ORIGIN/],
      [[...head, 'PART_NAME U1', 'PART_ORIGIN 0 0', 'PIN_END'], /PIN_END without a PIN_ORIGIN/],
      [[...head, 'PART_NAME U1', 'PART_ORIGIN 0 0', 'PIN_ORIGIN 1 1', 'PIN_RADIUS -1'], /negative pin radius/],
      [[...head, 'PART_NAME U1', 'PART_ORIGIN 0 0', 'PIN_ORIGIN 1 1', 'PART_END'], /PART_END while a pin has no PIN_END/],
      [[...head, 'PART_NAME U1', 'PART_SIDE T', 'PART_END'], /part U1 has no PART_ORIGIN/],
      [[...head, 'PART_NAME U1', 'PART_ORIGIN 0 0'], /ends inside part U1 \(missing PART_END\)/],
      [[...head, 'PART_NAME U1', 'PART_ORIGIN 0 0', 'PIN_ORIGIN 1 1'], /ends inside a pin \(missing PIN_END\)/],
      [[...head, 'PART_END'], /PART_END appears outside/],
      [[...head, 'OUTLINE_POINTS 0 0 1 1 2'], /OUTLINE_POINTS needs an even number of coordinates/],
      [[...head, 'OUTLINE_POINTS 0 0 1 1'], /OUTLINE_POINTS needs at least three points/],
      [[...head, 'OUTLINE_POINTS 0 0 1 1 2 x'], /invalid outline Y "x"/],
      [[...head, 'OUTLINE_SEGMENTED 0 0 1 1 2'], /four coordinates per segment/],
      [[...head, 'OUTLINE_SEGMENTED 0 0 1 1'], /no PART_NAME \.\.\. PART_END block was found/],
      [head, /no PART_NAME \.\.\. PART_END block was found/],
    ];
    for (const [rows, pattern] of cases) {
      const error = thrown(text(rows));
      expect(error.message, rows.join(' | ')).toMatch(pattern);
      expect(error).toMatchObject({ code: 'INVALID_FORMAT', format: 'BVR raw boardview (BVRAW_FORMAT_3)' });
    }
    expect(thrown(text([...head, 'PART_NAME U1', 'PART_ORIGIN 1e11 0', 'PART_END'])).message).toMatch(/exceeds the supported range/);
  });
  it('bounds resources: components, outline points', () => {
    const many = ['BVRAW_FORMAT_3', ...Array.from({ length: 250_001 }, (_, index) => `PART_NAME R${index}\nPART_ORIGIN 0 0\nPART_END`)].join('\n');
    expect(thrown(many)).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const points = Array.from({ length: 100_001 }, (_, index) => `${index} 0`).join(' ');
    expect(thrown(text(['BVRAW_FORMAT_3', `OUTLINE_POINTS ${points}`, `OUTLINE_POINTS ${points}`, 'PART_NAME U1', 'PART_ORIGIN 0 0', 'PART_END']))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});

describe('BVR recognition', () => {
  it('selects the dialect by the BVRAW_FORMAT_<n> line, not by extension', () => {
    expect(must(text(BVR1), 'x.dat').format).toBe('BVR raw boardview (BVRAW_FORMAT_1)');
    expect(must(text(BVR3), 'x.bvr').format).toBe('BVR raw boardview (BVRAW_FORMAT_3)');
    expect(must('﻿' + text(BVR3)).components).toHaveLength(3);
    expect(must('  \t BVRAW_FORMAT_3\n' + BVR3.slice(1).join('\n')).components).toHaveLength(3);
    expect(must(text(['# comment', ...BVR3])).components).toHaveLength(3);
  });
  it('recognizes other BVRAW_FORMAT versions and refuses them with UNSUPPORTED_VARIANT', () => {
    for (const version of ['2', '0', '10', '31']) {
      const error = thrown(text([`BVRAW_FORMAT_${version}`, 'PART_NAME U1']));
      expect(error).toMatchObject({ code: 'UNSUPPORTED_VARIANT', format: 'BVR raw boardview' });
      expect(error.message).toBe(`BVR: BVRAW_FORMAT_${Number(version)} is not supported; only BVRAW_FORMAT_1 and BVRAW_FORMAT_3 are documented.`);
    }
  });
  it('returns null when no BVRAW_FORMAT line exists', () => {
    expect(parse('')).toBeNull();
    expect(parse('$HEADER\nGENCAD 1.4\n')).toBeNull();
    expect(parse('<<Pin>>\nU1 (T) 1 1 0.1 0.1 1 A\n')).toBeNull();
    expect(parse('PART_NAME U1\nPART_ORIGIN 0 0\nPART_END\n')).toBeNull();
    expect(parse('BVRAW_FORMAT_')).toBeNull();
    expect(parse('BVRAW_FORMAT_x\n')).toBeNull();
    expect(parse('see BVRAW_FORMAT_1 here\n')).toBeNull();
    expect(parse('XBVRAW_FORMAT_1\n')).toBeNull();
    expect(parse(Uint8Array.from([0, 1, 2, 255, 254]))).toBeNull();
    expect(parse('.bv Standard Jet DB\n')).toBeNull();
  });
  it('turns every truncation of a valid BVR1 or BVR3 file into a board or a BoardFormatError', () => {
    for (const rows of [BVR1, BVR3]) {
      const data = bytes(text(rows));
      let boards = 0, failures = 0;
      for (let length = 0; length <= data.length; length++) {
        try {
          const board = parse(data.slice(0, length));
          if (board) boards++; else expect(length, `prefix ${length}`).toBeLessThan('BVRAW_FORMAT_1'.length);
        } catch (error) {
          expect(error, `prefix ${length}`).toBeInstanceOf(BoardFormatError);
          failures++;
        }
      }
      expect(boards).toBeGreaterThan(0); expect(failures).toBeGreaterThan(0);
    }
  });
  it('detects a BVR3 file cut inside a part or a pin by its missing END records', () => {
    const complete = text(BVR3);
    const cut = complete.indexOf('PIN_ID 1');
    expect(thrown(complete.slice(0, cut)).message).toMatch(/ends inside part U1 \(missing PART_END\)/);
    expect(thrown(complete.slice(0, complete.indexOf('PIN_RADIUS 12.5'))).message).toMatch(/ends inside a pin \(missing PIN_END\)/);
  });
});

// Layout of a BVRAW_FORMAT_3 file as written by the open-source kicad-boardview exporter (observed on the five Raspberry Pi Pico
// boardviews, CRLF or LF): indented keywords, blank lines between records, absolute pin origins with a zero PART_ORIGIN, and the
// free-text PIN_NUMBER / PIN_NAME / PIN_NET lines written WITHOUT a value for fiducials and unconnected pads. The fixture below is
// an original synthetic file in that shape (no bytes of a real file).
const pin = (id: string, number: string, name: string, side: string, x: number, y: number, radius: number, net: string) => [
  `   PIN_ID ${id}`, `      PIN_NUMBER ${number}`, `      PIN_NAME ${name}`, `      PIN_SIDE ${side}`, `      PIN_ORIGIN ${x.toFixed(1)} ${y.toFixed(1)}`,
  `      PIN_RADIUS ${radius.toFixed(1)}`, `      PIN_NET ${net}`, '      PIN_TYPE 2', '      PIN_COMMENT', '   PIN_END', '',
];
const part = (name: string, side: string, mount: string, ...pins: string[][]) => [
  `PART_NAME ${name}`, `   PART_SIDE ${side}`, '   PART_ORIGIN 0.000 0.000', `   PART_MOUNT ${mount}`, '', ...pins.flat(), 'PART_END', '', '',
];
const KICAD_EXPORT = [
  'BVRAW_FORMAT_3', '',
  ...part('R4', 'T', 'SMD', pin('R4-1', '1', '1', 'T', 6187, 653, 13, 'QSPI_SS'), pin('R4-2', '2', '2', 'T', 6146, 653, 13, '+3V3')),
  ...part('FID2', 'T', 'SMD', pin('FID2-', '', '', 'T', 5141, 208, 24, '')),
  ...part('H1', 'B', 'Through hole', pin('H1-', '', '', 'B', 5000, 500, 40, ''), pin('H1-1', '1', '1', 'B', 5100, 500, 40, 'GND')),
  ...part('U9', 'B', 'Other', pin('U9-A1', 'A1', 'A1', 'B', 5600, 300, 8, 'Net-(U9 PAD A1)')),
  'OUTLINE_POINTS 6953 0 4945 0 4945 826 6953 826 6953 0', '',
];

describe('BVRAW_FORMAT_3 as written by kicad-boardview (real-file shape, Raspberry Pi Pico exports)', () => {
  it('reads empty PIN_NUMBER / PIN_NAME / PIN_NET lines (with or without the trailing blank) instead of rejecting the file', () => {
    for (const eol of ['\r\n', '\n']) {
      for (const strip of [false, true]) {
        const rows = strip ? KICAD_EXPORT.map(row => row.replace(/ +$/, '')) : KICAD_EXPORT;
        const board = must(rows.join(eol));
        expect(board.components.map(c => [c.ref, c.side, c.pinIds.length]), `${JSON.stringify(eol)} stripped=${strip}`).toEqual([['R4', 'top', 2], ['FID2', 'top', 1], ['H1', 'bottom', 2], ['U9', 'bottom', 1]]);
        expect(board.pins).toHaveLength(6);
      }
    }
  });
  it('numbers a pin without PIN_NUMBER and PIN_NAME "~" and its position in the part, marks it as generated and gives it no net', () => {
    const board = must(KICAD_EXPORT.join('\r\n'));
    const fiducial = board.pins.find(p => p.componentId === board.components.find(c => c.ref === 'FID2')!.id)!;
    expect(fiducial).toMatchObject({ number: '~1', name: '~1', numberGenerated: true, net: '', side: 'top' });
    const hole = board.components.find(c => c.ref === 'H1')!;
    // the unnumbered pad no longer shares the number of the real pad 1 of the same part
    expect(board.pins.filter(p => p.componentId === hole.id).map(p => [p.number, p.name, p.net, p.numberGenerated])).toEqual([['~1', '~1', '', true], ['1', '1', 'GND', undefined]]);
    expect(board.nets.map(n => n.name).sort()).toEqual(['+3V3', 'GND', 'Net-(U9 PAD A1)', 'QSPI_SS']);
  });
  it('keeps a net name that contains blanks whole (the exporter writes the raw KiCad name)', () => {
    const board = must(KICAD_EXPORT.join('\n'));
    expect(board.nets.some(n => n.name === 'Net-(U9 PAD A1)')).toBe(true);
    expect(board.pins.find(p => p.net === 'Net-(U9 PAD A1)')).toMatchObject({ number: 'A1', side: 'bottom' });
  });
  it('treats PART_MOUNT values with blanks as ignorable and keeps the closed outline polygon (first point repeated)', () => {
    const board = must(KICAD_EXPORT.join('\r\n'));
    expect(board.outline).toHaveLength(5);
    expect(board.outline[0]).toEqual(board.outline[4]);
    expect(board.bounds).toEqual({ minX: mil(4945), minY: 0, maxX: mil(6953), maxY: mil(826) });
    expect(board.pins[0]).toMatchObject({ x: mil(6187), y: mil(653), radius: mil(13) });
  });
  it('still rejects a repeated empty value line and a value given twice', () => {
    const doubled = KICAD_EXPORT.flatMap(row => row.trim() === 'PIN_NET' ? [row, row] : [row]);
    expect(thrown(doubled.join('\n')).message).toMatch(/PIN_NET is given twice/);
  });
});

describe('BVRAW_FORMAT_3 component names', () => {
  it('keeps a reference designator that contains blanks whole (the exporter writes the raw KiCad reference) and still rejects an empty one', () => {
    const rows = ['BVRAW_FORMAT_3', 'PART_NAME TP 1', 'PART_SIDE T', 'PART_ORIGIN 0 0', 'PIN_ORIGIN 5 5', 'PIN_END', 'PART_END'];
    expect(must(text(rows)).components.map(c => c.ref)).toEqual(['TP 1']);
    for (const empty of ['PART_NAME ', 'PART_NAME']) expect(thrown(text(rows.map(row => row === 'PART_NAME TP 1' ? empty : row))).message).toMatch(/line 2: PART_NAME needs a name/);
  });
});
