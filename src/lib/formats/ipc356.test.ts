import { expectScaling, expectCostAtMost, linearReference } from '../../test-support/timing';
import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import continuationFixture from '../../../tests/fixtures/ipc356/continuation.ipc?raw';
import inchFixture from '../../../tests/fixtures/ipc356/inch-two-sided.ipc?raw';
import metricFixture from '../../../tests/fixtures/ipc356/metric-si.ipc?raw';
import noHeaderFixture from '../../../tests/fixtures/ipc356/no-header.ipc?raw';
import relaxedFixture from '../../../tests/fixtures/ipc356/relaxed-spacing.ipc?raw';
import { BoardFormatError, padExtent } from './common';
import { PARSERS } from './index';
import {
  IPC356_FORMAT, IPC356_MAX_RECORD_LINE, buildIpc356Board, ipc356Units, looksLikeIpc356, parseIpc356, readIpc356, readIpc356Record, sniffIpc356, type Ipc356Options,
} from './ipc356';

// Original synthetic netlists modelled on the public layout of IPC-D-356A (see ipc356-reader.ts). No byte of a real design is used.
const mm = (steps: number) => Number((steps * 0.00254).toFixed(9)); // millimetres of 0.0001 inch steps (UNITS CUST 0)
const bytes = (text: string) => new TextEncoder().encode(text);
const lf = (text: string) => text.replace(/\r\n/g, '\n');
const INCH = lf(inchFixture), METRIC = lf(metricFixture), CONTINUATION = lf(continuationFixture), RELAXED = lf(relaxedFixture), NO_HEADER = lf(noHeaderFixture);
const parse = (data: string | Uint8Array, name = 'board.ipc', options?: Ipc356Options) => parseIpc356({ name, data: typeof data === 'string' ? bytes(data) : data }, options);
function must(data: string | Uint8Array, name?: string, options?: Ipc356Options): Board {
  const board = parse(data, name, options);
  if (!board) throw new Error('fixture was not recognized');
  return board;
}
function thrown(data: string | Uint8Array, options?: Ipc356Options): BoardFormatError {
  try { parse(data, 'board.ipc', options); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
}
const notes = (board: Board) => board.warnings.filter(issue => issue.key === 'parse.warning.formatNote').map(issue => String(issue.params?.message));
const comp = (board: Board, ref: string) => board.components.find(component => component.ref === ref)!;
const pinsOf = (board: Board, ref: string) => board.pins.filter(pin => pin.componentId === comp(board, ref).id);
const timed = <T>(work: () => T, units: number): { value: T } => {
  expectCostAtMost('netlist input work', work, linearReference(units), 300);
  return { value: work() };
};

/** One 73-column test record exactly as the layout in ipc356-reader.ts places it. */
interface Rec { code?: string; net?: string; ref?: string; pin?: string; mid?: boolean; hole?: number; plated?: boolean; access?: number; x: number; y: number; xs?: number; ys?: number; rot?: number; mask?: number | string }
const pad = (text: string, width: number) => text.slice(0, width).padEnd(width);
const signed = (value: number, width: number) => (value < 0 ? '-' : '+') + String(Math.abs(value)).padStart(width, '0');
function rec(r: Rec): string {
  let line = (r.code ?? '317') + pad(r.net ?? '', 14) + '   ' + pad(r.ref ?? '', 6) + (r.pin ? '-' : ' ') + pad(r.pin ?? '', 4) + (r.mid ? 'M' : ' ');
  line += r.hole !== undefined ? 'D' + String(r.hole).padStart(4, '0') + (r.plated === false ? 'U' : 'P') : ' '.repeat(6);
  line += r.access !== undefined ? 'A' + String(r.access).padStart(2, '0') : '   ';
  line += 'X' + signed(r.x, 6) + 'Y' + signed(r.y, 6);
  if (r.xs !== undefined) line += 'X' + String(r.xs).padStart(4, '0') + 'Y' + String(r.ys ?? 0).padStart(4, '0');
  return line + 'R' + String(r.rot ?? 0).padStart(3, '0') + 'S' + (r.mask ?? 0);
}
const smd = (net: string, ref: string, pin: string, x: number, y: number, access = 1, extra: Partial<Rec> = {}) => rec({ code: '327', net, ref, pin, access, x, y, xs: 300, ys: 600, ...extra });
const tht = (net: string, ref: string, pin: string, x: number, y: number, extra: Partial<Rec> = {}) => rec({ net, ref, pin, hole: 300, access: 0, x, y, xs: 600, ys: 600, ...extra });
const file = (rows: string[], head: string[] = ['P  UNITS CUST 0'], eol = '\n') => [...head, ...rows, '999'].join(eol) + eol;

describe('IPC-D-356 record layout (columns)', () => {
  it('the generator and the reader agree with the 73-column layout of a real-world writer: every field lands in its columns', () => {
    const line = rec({ net: 'VCC', ref: 'C1', pin: '1', hole: 472, access: 0, x: 19000, y: 29450, xs: 945, ys: 945, rot: 180 });
    expect(line).toBe('317VCC              C1    -1    D0472PA00X+019000Y+029450X0945Y0945R180S0');
    expect(line).toHaveLength(73);
    expect(readIpc356Record(line)).toEqual({ net: 'VCC', ref: 'C1', pin: '1', midpoint: false, holeDiameter: 472, plated: true, access: 0, x: 19000, y: 29450, xSize: 945, ySize: 945, rotation: 180, mask: 0, relaxed: false });
    const surface = readIpc356Record('327GND              REC1  -1          A01X+038016Y-006194X0295Y0709R090S2');
    expect(surface).toMatchObject({ net: 'GND', ref: 'REC1', pin: '1', access: 1, x: 38016, y: -6194, xSize: 295, ySize: 709, rotation: 90, mask: 2, relaxed: false });
    expect(surface?.holeDiameter).toBeUndefined();
  });

  it('reads a via (blank pin, midpoint flag), an unplated hole, a pin without a dash, a 4-character pin and a long solder-mask number some writers put there', () => {
    expect(readIpc356Record('317P3V3             VIA        MD0236PA00X+015575Y+004451X0177Y0000R000S-875262333')).toMatchObject({ net: 'P3V3', ref: 'VIA', pin: '', midpoint: true, holeDiameter: 236, plated: true, xSize: 177, ySize: 0, mask: undefined });
    expect(readIpc356Record('367N/C              J2          D0394UA00X+022422Y+004754X0394Y0000R000S0')).toMatchObject({ net: 'N/C', ref: 'J2', pin: '', plated: false });
    expect(readIpc356Record('317GND              J13   -SHIE D0866PA00X-058937Y+035000X1732Y0000R270S0')).toMatchObject({ pin: 'SHIE', x: -58937 });
    expect(readIpc356Record(rec({ net: 'A', ref: 'U1', pin: '12', access: 1, code: '327', x: 1, y: 2 }))).toMatchObject({ xSize: 0, ySize: 0, rotation: 0 });
    // the sizes, rotation and mask are optional: a record may end after the coordinates
    expect(readIpc356Record(rec({ code: '327', net: 'NET', ref: 'U1', pin: '3', access: 1, x: 10, y: 20 }).slice(0, 57))).toMatchObject({ x: 10, y: 20, xSize: 0, ySize: 0, rotation: 0, relaxed: false });
  });

  it('refuses a line when a marker letter is missing or not where the layout puts it, and splits on blanks only when the tail is intact', () => {
    const good = rec({ net: 'GND', ref: 'R1', pin: '1', hole: 300, access: 0, x: 1, y: 2, xs: 100, ys: 100 });
    expect(readIpc356Record(good)?.relaxed).toBe(false);
    expect(readIpc356Record(good.replace('X+000001', 'Z+000001'))).toBeNull();
    expect(readIpc356Record(good.slice(0, 50))).toBeNull();
    expect(readIpc356Record(good.replace('A00', 'A0x'))).toBeNull();
    expect(readIpc356Record(good.replace('X+000001Y+000002', 'X+0000.1Y+000002'))).toBeNull();
    expect(readIpc356Record(good.replace('D0300P', 'D03x0P'))).toBeNull();
    expect(readIpc356Record('317')).toBeNull();
    expect(readIpc356Record('317 hello world')).toBeNull();
  });

  it('understands the UNITS parameter: CUST 0 is 0.0001 inch, CUST 1 and SI are 0.001 mm, everything else is left to the caller', () => {
    expect(ipc356Units('CUST 0')).toEqual({ code: 'CUST 0', unit: 'inch', mmPerUnit: 0.00254 });
    expect(ipc356Units('cust')).toMatchObject({ unit: 'inch' });
    expect(ipc356Units('  CUST   1 ')).toEqual({ code: 'CUST 1', unit: 'mm', mmPerUnit: 0.001 });
    expect(ipc356Units('SI')).toEqual({ code: 'SI', unit: 'mm', mmPerUnit: 0.001 });
    for (const other of ['', 'CUST 2', 'CUST 0 1', 'SI 0', 'INCH', 'MM', 'CUSTOM 0']) expect(ipc356Units(other), JSON.stringify(other)).toBeUndefined();
  });
});

describe('IPC-D-356 to a board: two-sided golden fixture', () => {
  const board = must(INCH, 'sample-a.ipc');

  it('rebuilds one component per reference designator, with sides from the pads', () => {
    expect(board.format).toBe(IPC356_FORMAT);
    expect(board.format).toBe('IPC-D-356');
    expect(board.name).toBe('sample-a');
    expect(board.units).toBe('mm');
    expect(board.components.map(component => [component.ref, component.side, component.pinIds.length])).toEqual([['J1', 'both', 2], ['U1', 'top', 4], ['C1', 'bottom', 2], ['H1', 'both', 1], ['TP1', 'top', 1]]);
    expect(board.components.every(component => component.value === '' && component.package === '')).toBe(true);
  });

  it('keeps the pad positions exact (0.0001 inch steps, Y up) and the net of every pad', () => {
    const rows = (ref: string) => pinsOf(board, ref).map(pin => [pin.number, pin.x, pin.y, pin.net, pin.side]);
    expect(rows('J1')).toEqual([['1', 25.4, 25.4, 'GND', 'both'], ['2', 25.4, 30.48, 'VCC', 'both']]);
    expect(rows('U1')).toEqual([['1', 50.8, 25.4, 'VCC', 'top'], ['2', 50.8, 27.94, 'SIG_A', 'top'], ['3', 50.8, 30.48, '', 'top'], ['4', 50.8, 33.02, 'GND', 'top']]);
    expect(rows('C1')).toEqual([['1', 76.2, 25.4, 'SIG_A', 'bottom'], ['2', 76.2, 27.94, 'GND', 'bottom']]);
    expect(rows('TP1')).toEqual([['1', 88.9, 88.9, 'SIG_B', 'top']]);
    expect(board.nets.map(net => [net.name, net.pinIds.length])).toEqual([['GND', 3], ['VCC', 2], ['SIG_A', 2], ['SIG_B', 1]]);
    const named = (net: string) => board.nets.find(item => item.name === net)!.pinIds.map(id => { const pin = board.pins.find(item => item.id === id)!; return `${board.components.find(c => c.id === pin.componentId)!.ref}-${pin.number}`; });
    expect(named('GND')).toEqual(['J1-1', 'U1-4', 'C1-2']);
    expect(named('SIG_A')).toEqual(['U1-2', 'C1-1']);
  });

  it('takes the pad shape from the sizes: no Y size is a round pad, equal sizes a square, different sizes a rectangle at its rotation', () => {
    const [j1a, j1b] = pinsOf(board, 'J1'), u1 = pinsOf(board, 'U1')[0], c1 = pinsOf(board, 'C1')[0], tp = pinsOf(board, 'TP1')[0];
    expect(j1a).toMatchObject({ shape: 'square', width: mm(945), height: mm(945) });
    expect(j1b).toMatchObject({ shape: 'round', radius: mm(945) / 2, width: mm(945), height: mm(945) });
    expect(u1).toMatchObject({ shape: 'rect', width: mm(236), height: mm(630), rotation: 270 }); // R090 is clockwise
    expect(c1).toMatchObject({ shape: 'square', rotation: 0 });
    expect(tp).toMatchObject({ shape: 'square', rotation: 315 }); // R045
    expect(board.warnings.some(issue => issue.key === 'parse.warning.fallbackPads')).toBe(false);
  });

  it('numbers a pad that has no pin (a mounting pad) and says the number is made up', () => {
    const mount = pinsOf(board, 'H1');
    expect(mount).toHaveLength(1);
    expect(mount[0]).toMatchObject({ number: '1', numberGenerated: true, net: '', shape: 'round', radius: mm(1500) / 2 });
    expect(board.pins.filter(pin => pin.numberGenerated).length).toBe(1);
  });

  it('estimates the bodies from the pads and the outline from all pads, and says so', () => {
    const u1 = comp(board, 'U1');
    // R090 clockwise = 270 counter-clockwise: a 0.6 x 1.6 mm pad is 1.6 mm wide in X
    expect(u1.bounds.minX).toBeCloseTo(50.8 - mm(630) / 2, 9);
    expect(u1.bounds.maxX).toBeCloseTo(50.8 + mm(630) / 2, 9);
    expect(u1.bounds.minY).toBeCloseTo(25.4 - mm(236) / 2, 9);
    expect(u1.bounds.maxY).toBeCloseTo(33.02 + mm(236) / 2, 9);
    expect(u1.outline).toHaveLength(4);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackComponents', params: { count: 5 } });
    expect(board.warnings).toContainEqual({ key: 'parse.warning.missingBoardOutline' });
    expect(board.bounds.minX).toBeCloseTo(25.4 - mm(945) / 2, 9);
    expect(board.bounds.maxX).toBeCloseTo(101.6 + mm(1500) / 2, 9);
    expect(board.bounds.maxY).toBeCloseTo(101.6 + mm(1500) / 2, 9);
    expect(notes(board)[0]).toMatch(/^IPC-D-356 is a bare-board test netlist: nets, pad positions and pad sizes are exact, but the file has no component bodies, board outline or pad shapes\./);
  });

  it('counts what it does not show: tooling holes, vias (with their nets) and unsupported record types', () => {
    expect(notes(board).slice(1)).toEqual([
      '1 tooling or mechanical hole record (367) is not shown: it carries no pin.',
      '2 vias are not shown (on 2 nets): the board model has no vias.',
      'Records of operation code 378 (1) are not read.',
    ]);
  });

  it('reads the header: job, title, version, comments, parameters and the 999 end record', () => {
    const document = readIpc356(INCH);
    expect(document.header).toMatchObject({ job: 'TRACE-SAMPLE-A', title: 'TWO-SIDED SAMPLE', version: 'IPC-D-356A', units: { code: 'CUST 0', unit: 'inch' } });
    expect(document.header.comments).toEqual(['Synthetic IPC-D-356A netlist written for the TRACE test suite (no real design)']);
    expect(document.header.parameters.map(item => item.key)).toEqual(['JOB', 'TITLE', 'VER', 'CODE', 'UNITS', 'ARRAYDIM']);
    expect(document.stats).toMatchObject({ end: true, unknownLines: 0, strayContinuations: 0, ignoredContinuations: 0, unsupported: [{ code: '378', count: 1 }] });
    expect(document.features).toHaveLength(13);
    expect(document.features.filter(feature => feature.kind === 'tooling')).toHaveLength(1);
    expect(document.features.find(feature => feature.ref === 'VIA')).toMatchObject({ midpoint: true, holeDiameter: 236, plated: true, access: 0 });
  });
});

describe('units', () => {
  it('reads UNITS SI and UNITS CUST 1 as 0.001 mm', () => {
    const board = must(METRIC);
    expect(board.components.map(component => [component.ref, component.side])).toEqual([['R1', 'top'], ['D1', 'both']]);
    expect(pinsOf(board, 'R1').map(pin => [pin.number, pin.x, pin.y, pin.net])).toEqual([['1', 10, 5, '+3V3'], ['2', 12, 5, 'SDA']]);
    expect(pinsOf(board, 'D1').map(pin => [pin.number, pin.x, pin.y, pin.shape])).toEqual([['A', 20, 5, 'square'], ['K', 22.54, 5, 'round']]);
    expect(pinsOf(board, 'R1')[0]).toMatchObject({ width: 0.8, height: 0.95, shape: 'rect' });
    expect(pinsOf(board, 'D1')[1].radius).toBeCloseTo(0.8, 12);
    expect(notes(board).some(message => /UNITS/.test(message))).toBe(false);
    const cust1 = must(METRIC.replace('P  UNITS SI', 'P  UNITS CUST 1'));
    expect(cust1.pins.map(pin => [pin.x, pin.y])).toEqual(must(METRIC).pins.map(pin => [pin.x, pin.y]));
  });

  it('reads a bare "CUST" as inch and defaults to CUST 0 with a note when the file has no UNITS record', () => {
    expect(must(INCH.replace('P  UNITS CUST 0', 'P  UNITS CUST')).pins.map(pin => pin.x)).toEqual(must(INCH).pins.map(pin => pin.x));
    const bare = must(NO_HEADER);
    expect(pinsOf(bare, 'F1').map(pin => [pin.x, pin.y])).toEqual([[mm(1000), mm(1000)], [mm(1000), mm(2000)]]);
    expect(notes(bare)).toContain('The file has no UNITS parameter record; coordinates are read as 0.0001 inch (UNITS CUST 0), the default of the format.');
    expect(notes(bare)).toContain('The file has no 999 end record: it may be incomplete.');
    expect(notes(must(INCH))).not.toContain('The file has no 999 end record: it may be incomplete.');
  });

  it('refuses a UNITS record it does not know unless the caller names the unit, and lets the caller override a known one', () => {
    const odd = INCH.replace('P  UNITS CUST 0', 'P  UNITS CUST 2');
    expect(thrown(odd)).toMatchObject({ code: 'UNSUPPORTED_VARIANT', format: 'IPC-D-356' });
    expect(thrown(odd).message).toMatch(/UNITS record "CUST 2"/);
    expect(must(odd, 'board.ipc', { unitsToMm: 0.00254 }).pins.map(pin => pin.x)).toEqual(must(INCH).pins.map(pin => pin.x));
    expect(must(METRIC, 'board.ipc', { unitsToMm: 0.01 }).pins[0].x).toBeCloseTo(100, 9);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(thrown(INCH, { unitsToMm: bad }), String(bad)).toMatchObject({ code: 'INVALID_FORMAT' });
  });

  it('rejects a UNITS record after test records and a file that changes its units', () => {
    const after = thrown(file([tht('A', 'R1', '1', 1, 1), 'P  UNITS CUST 1'], []));
    expect(after.message).toMatch(/line 2: a UNITS record follows test records/);
    expect(after.code).toBe('INVALID_FORMAT');
    expect(thrown(file([tht('A', 'R1', '1', 1, 1)], ['P  UNITS CUST 0', 'P  UNITS SI'])).code).toBe('UNSUPPORTED_VARIANT');
    expect(must(file([tht('A', 'R1', '1', 1, 1)], ['P  UNITS CUST 0', 'P  UNITS CUST 0'])).components).toHaveLength(1);
  });
});

describe('access side, through-hole and surface-mount features', () => {
  it('reads A00 as both sides, A01 as top and the highest access code as the bottom side; codes between are inner and shown on both sides', () => {
    const board = must(file([
      smd('N1', 'U1', '1', 1000, 1000, 1), smd('N2', 'U1', '2', 1000, 2000, 4), smd('N3', 'U1', '3', 1000, 3000, 2), smd('N4', 'U1', '4', 1000, 4000, 3),
      tht('N5', 'J1', '1', 5000, 5000),
    ]));
    expect(pinsOf(board, 'U1').map(pin => pin.side)).toEqual(['top', 'bottom', 'both', 'both']);
    expect(comp(board, 'U1').side).toBe('both'); // SMD pads on top and bottom
    expect(comp(board, 'J1').side).toBe('both');
    expect(notes(board)).toContain('Access codes go up to A04: A00 is read as both sides, A01 as the top side, A04 as the bottom side, the 2 features in between as inner (shown on both sides).');
  });

  it('puts a part on the side of its surface-mount pads, even when it also has through-hole pads', () => {
    const board = must(file([
      smd('A', 'X1', '1', 1000, 1000, 2), smd('B', 'X1', '2', 1000, 2000, 2), tht('C', 'X1', '3', 1000, 3000),
      smd('A', 'X2', '1', 3000, 1000, 1), tht('B', 'X2', '2', 3000, 2000), smd('C', 'X3', '1', 5000, 1000, 2),
      tht('A', 'X4', '1', 7000, 1000), tht('A', 'X4', '2', 7000, 2000, { access: 1 }), tht('A', 'X5', '1', 9000, 1000, { access: 2 }),
    ]));
    expect(['X1', 'X2', 'X3', 'X4', 'X5'].map(ref => comp(board, ref).side)).toEqual(['bottom', 'top', 'bottom', 'both', 'bottom']);
    expect(pinsOf(board, 'X4').map(pin => pin.side)).toEqual(['both', 'top']);
  });

  it('lets the caller name the bottom access code (a writer whose bottom side is always A02)', () => {
    const rows = file([smd('A', 'U1', '1', 1000, 1000, 1), smd('B', 'U1', '2', 1000, 2000, 2), smd('C', 'U1', '3', 1000, 3000, 4)]);
    expect(pinsOf(must(rows), 'U1').map(pin => pin.side)).toEqual(['top', 'both', 'bottom']);
    const named = must(rows, 'board.ipc', { bottomAccess: 2 });
    expect(pinsOf(named, 'U1').map(pin => pin.side)).toEqual(['top', 'bottom', 'both']);
  });

  it('places records with no access code on top (surface-mount) or on both sides (through-hole) and counts them', () => {
    const board = must(file([rec({ code: '327', net: 'A', ref: 'U1', pin: '1', x: 1000, y: 1000, xs: 300, ys: 600 }), rec({ net: 'B', ref: 'J1', pin: '1', hole: 300, x: 3000, y: 3000, xs: 600, ys: 600 })]));
    expect(pinsOf(board, 'U1')[0].side).toBe('top');
    expect(pinsOf(board, 'J1')[0].side).toBe('both');
    expect(notes(board)).toContain('2 records have no access code; surface-mount records are placed on top, through-hole records on both sides.');
  });

  it('puts a top-only through-hole record on top', () => {
    expect(pinsOf(must(file([tht('A', 'J1', '1', 1000, 1000, { access: 1 })])), 'J1')[0].side).toBe('top');
  });
});

describe('pad geometry', () => {
  it('draws a feature with no Y size as a round pad of the X size, a zero X size with a Y size the same way, and marks size-less pads as such', () => {
    const board = must(file([
      tht('A', 'R1', '1', 1000, 1000, { xs: 500, ys: 0 }), tht('A', 'R1', '2', 2000, 1000, { xs: 0, ys: 400 }),
      tht('A', 'R1', '3', 3000, 1000, { xs: 0, ys: 0 }), rec({ code: '327', net: 'A', ref: 'R1', pin: '4', access: 1, x: 4000, y: 1000 }),
    ]));
    const [a, b, c, d] = pinsOf(board, 'R1');
    expect(a).toMatchObject({ shape: 'round', width: mm(500), height: mm(500) }); expect(a.radius).toBeCloseTo(mm(250), 12);
    expect(b).toMatchObject({ shape: 'round', width: mm(400) }); expect(b.radius).toBeCloseTo(mm(200), 12);
    expect(c).toMatchObject({ shape: 'round', radius: 0 }); expect(c.width).toBeUndefined();
    expect(d.radius).toBe(0);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 2 } });
  });

  it('reads the R field as clockwise degrees by default and as counter-clockwise on request; bounding extents do not depend on it', () => {
    const rows = file([smd('A', 'U1', '1', 1000, 1000, 1, { rot: 90 }), smd('A', 'U1', '2', 2000, 1000, 1, { rot: 30 }), smd('A', 'U1', '3', 3000, 1000, 1, { rot: 0 }), smd('A', 'U1', '4', 4000, 1000, 1, { rot: 359 })]);
    expect(pinsOf(must(rows), 'U1').map(pin => pin.rotation)).toEqual([270, 330, 0, 1]);
    const ccw = must(rows, 'board.ipc', { rotation: 'counterclockwise' });
    expect(pinsOf(ccw, 'U1').map(pin => pin.rotation)).toEqual([90, 30, 0, 359]);
    const clockwiseExtent = padExtent(pinsOf(must(rows), 'U1')[1]), counterExtent = padExtent(pinsOf(ccw, 'U1')[1]);
    clockwiseExtent.forEach((corner, index) => { expect(corner.x).toBeCloseTo(counterExtent[index].x, 9); expect(corner.y).toBeCloseTo(counterExtent[index].y, 9); });
    expect(readIpc356(rows).features.map(feature => feature.rotation)).toEqual([90, 30, 0, 359]);
  });

  it('wraps a rotation of 360 or more instead of keeping it', () => {
    const relaxed = '327NET U1 -1 A01X+000010Y+000020X0300Y0600R450S0';
    expect(readIpc356Record(relaxed)).toMatchObject({ rotation: 90, relaxed: true });
  });
});

describe('nets', () => {
  it('keeps net names exactly as written (case, blanks, symbols) and reads N/C in any case as no net', () => {
    const board = must(file([
      smd('+3V3', 'U1', '1', 1000, 1000), smd('/Sub/Net_1', 'U1', '2', 1000, 2000), smd('mixed Case 7', 'U1', '3', 1000, 3000), smd('N/C', 'U1', '4', 1000, 4000), smd('n/c', 'U1', '5', 1000, 5000),
      smd('NC', 'U1', '6', 1000, 6000), smd('+3V3', 'R1', '1', 3000, 1000), smd('mixed Case 7', 'R1', '2', 3000, 2000),
    ]));
    expect(pinsOf(board, 'U1').map(pin => pin.net)).toEqual(['+3V3', '/Sub/Net_1', 'mixed Case 7', '', '', 'NC']);
    expect(board.nets.map(net => [net.name, net.pinIds.length])).toEqual([['+3V3', 2], ['/Sub/Net_1', 1], ['mixed Case 7', 2], ['NC', 1]]);
  });

  it('says when a name fills the 14-character net field or the 6-character reference field, because the writer may have cut it', () => {
    const board = must(file([smd('A_VERY_LONG_NET', 'U1', '1', 1000, 1000), smd('EXACTLY14CHARS', 'ABCDEF', '1', 2000, 1000), smd('SHORT', 'R1', '1', 3000, 1000)]));
    expect(notes(board)).toContain('2 net names fill the whole 14-character net field and may have been shortened by the writing tool; nets that differ only in the cut part would be merged.');
    expect(notes(board)).toContain('1 reference designator fills the whole 6-character field and may have been shortened by the writing tool; parts that differ only in the cut part would be merged into one.');
    expect(notes(must(file([smd('SHORT', 'R1', '1', 3000, 1000)]))).some(message => /14-character|6-character/.test(message))).toBe(false);
  });

  it('says when a net name holds a "?", which some writers put where the name had a blank', () => {
    const board = must(file([smd('D?SERIAL/SN_WP', 'U1', '1', 1000, 1000), smd('D?SERIAL/SN_WP', 'U1', '2', 2000, 1000), smd('?POWER/LPC_VCC', 'U1', '3', 3000, 1000), smd('GND', 'U1', '4', 4000, 1000)]));
    expect(notes(board)).toContain('2 net names contain a "?": the writing tool may have put it where the name had a blank.');
    expect(board.nets.map(net => net.name)).toEqual(['D?SERIAL/SN_WP', '?POWER/LPC_VCC', 'GND']);
    expect(notes(must(file([smd('GND', 'U1', '1', 1000, 1000)]))).some(message => /"\?"/.test(message))).toBe(false);
  });

  it('merges records of one pin at one place into one pad (a through-hole record plus the surface-mount ring on top) and keeps pads at other places apart', () => {
    const board = must(file([
      tht('GND', 'SP1', '1', 5000, 5000, { xs: 1614, ys: 0 }), smd('GND', 'SP1', '1', 5000, 5000, 1, { xs: 2362, ys: 0 }),
      smd('GND', 'U9', '9', 1000, 1000, 1, { xs: 500, ys: 500 }), smd('GND', 'U9', '9', 2000, 1000, 1, { xs: 500, ys: 500 }), smd('GND', 'U9', '9', 2000, 1000, 2, { xs: 500, ys: 500 }),
    ]));
    const sp = pinsOf(board, 'SP1');
    expect(sp).toHaveLength(1);
    expect(sp[0]).toMatchObject({ side: 'both', shape: 'round' });
    expect(sp[0].radius).toBeCloseTo(mm(2362) / 2, 12); // the larger ring wins
    expect(pinsOf(board, 'U9').map(pin => [pin.number, pin.x, pin.side])).toEqual([['9', mm(1000), 'top'], ['9', mm(2000), 'both']]);
    expect(notes(board)).toContain('2 records are at the same position as another record of the same pin and were merged into one pad.');
  });

  it('keeps the first net when merged records disagree, and says so', () => {
    const board = must(file([smd('A', 'U1', '1', 1000, 1000), smd('B', 'U1', '1', 1000, 1000), smd('', 'U1', '2', 2000, 2000), smd('C', 'U1', '2', 2000, 2000)]));
    expect(pinsOf(board, 'U1').map(pin => pin.net)).toEqual(['A', 'C']);
    expect(notes(board)).toContain('1 merged record names a different net than the first; the first net is kept.');
  });

  it('numbers unnumbered pads with the smallest free number, flagged as made up', () => {
    const board = must(file([tht('A', 'MH1', '2', 1000, 1000), tht('', 'MH1', '', 2000, 1000), tht('', 'MH1', '', 3000, 1000), tht('', 'MH1', '1', 4000, 1000), tht('', 'MH1', '', 5000, 1000)]));
    expect(pinsOf(board, 'MH1').map(pin => [pin.number, pin.numberGenerated])).toEqual([['2', undefined], ['3', true], ['4', true], ['1', undefined], ['5', true]]);
  });
});

describe('vias, tooling holes, unnamed records', () => {
  const rows = [
    smd('GND', 'U1', '1', 1000, 1000), rec({ net: 'GND', ref: 'VIA', mid: true, hole: 236, access: 0, x: 2000, y: 2000, xs: 500, ys: 0 }), rec({ net: 'SIG', ref: 'VIA', mid: true, hole: 236, access: 2, x: 3000, y: 3000, xs: 500, ys: 0 }),
    rec({ net: 'N/C', ref: 'VIA', mid: true, hole: 236, access: 0, x: 4000, y: 4000 }), rec({ code: '367', net: 'N/C', ref: 'H1', hole: 866, plated: false, access: 0, x: 5000, y: 5000 }),
    rec({ code: '327', net: 'LOOSE', ref: '', pin: '', access: 1, x: 6000, y: 6000, xs: 100, ys: 100 }), smd('SIG', 'R1', '1', 7000, 7000, 2),
  ];
  it('leaves vias, tooling holes and records with no reference designator out and counts them', () => {
    const board = must(file(rows));
    expect(board.components.map(component => component.ref)).toEqual(['U1', 'R1']);
    expect(notes(board).slice(1)).toEqual([
      '1 tooling or mechanical hole record (367) is not shown: it carries no pin.',
      '3 vias are not shown (on 2 nets): the board model has no vias.',
      '1 record without a reference designator is not shown.',
    ]);
  });
  it('keeps vias as one-pin test points named VIA:<n> on request, with made-up names and numbers', () => {
    const board = must(file(rows), 'board.ipc', { vias: 'points' });
    expect(board.components.map(component => [component.ref, component.refGenerated, component.side])).toEqual([['U1', undefined, 'top'], ['R1', undefined, 'bottom'], ['VIA:1', true, 'both'], ['VIA:2', true, 'bottom'], ['VIA:3', true, 'both']]);
    expect(board.pins.filter(pin => pin.componentId === comp(board, 'VIA:2').id).map(pin => [pin.number, pin.numberGenerated, pin.net, pin.x, pin.shape])).toEqual([['1', true, 'SIG', mm(3000), 'round']]);
    expect(board.nets.find(net => net.name === 'GND')!.pinIds).toHaveLength(2);
    expect(notes(board)).toContain('3 vias are shown as one-pin test points named VIA:<n>; their pin numbers are made up.');
    expect(notes(board).some(message => /not shown \(on/.test(message))).toBe(false);
  });
  it('rejects a file with no component pad at all', () => {
    const error = thrown(file([rows[1], rows[4]]));
    expect(error.message).toMatch(/holds no component pad \(1 via and 1 tooling record only\)/);
    expect(error.code).toBe('INVALID_FORMAT');
    expect(() => buildIpc356Board({ name: 'x.ipc', data: new Uint8Array() }, readIpc356('P  UNITS CUST 0\n999\n'))).toThrow(/no test record was found/);
    expect(parse(file([]))).toBeNull(); // a file of parameter records only is not claimed
  });
});

describe('continuation records (operation code 0xx)', () => {
  it('reads a 0xx line with the standard tail as another pad of the record before it, inheriting the blank net, reference and pin', () => {
    const board = must(CONTINUATION);
    expect(pinsOf(board, 'J2').map(pin => [pin.number, pin.x, pin.y, pin.net])).toEqual([['1', 25.4, 50.8, 'DATA'], ['1', 25.4, 52.07, 'DATA']]);
    expect(pinsOf(board, 'U2').map(pin => [pin.number, pin.x, pin.y, pin.net, pin.side])).toEqual([['1', 38.1, 50.8, 'CLK', 'top'], ['1', 38.608, 50.8, 'CLK', 'top'], ['2', 38.1, 52.07, 'CLK', 'top']]);
    expect(notes(board)).toContain('2 continuation records (operation code 0xx) were read as additional pads of the record before them.');
    expect(notes(board)).toContain('1 continuation line was ignored: no readable pad.');
    expect(readIpc356(CONTINUATION).stats).toMatchObject({ ignoredContinuations: 1, strayContinuations: 0 });
  });
  it('ignores a continuation with no record before it', () => {
    const document = readIpc356(file([rec({ code: '017', net: 'A', ref: 'R1', pin: '1', hole: 300, access: 0, x: 1, y: 2, xs: 100, ys: 100 }), tht('B', 'R2', '1', 10, 20)]));
    expect(document.stats.strayContinuations).toBe(1);
    expect(document.features).toHaveLength(1);
    expect(notes(must(file([rec({ code: '017', net: 'A', ref: 'R1', pin: '1', hole: 300, access: 0, x: 1, y: 2 }), tht('B', 'R2', '1', 10, 20)]))).join('\n')).toMatch(/1 continuation line was ignored: no record before it, or no readable pad\./);
  });
  it('lets a continuation name its own reference and pin', () => {
    const board = must(file([tht('A', 'R1', '1', 1000, 1000), rec({ code: '017', net: 'B', ref: 'R2', pin: '3', hole: 300, access: 0, x: 2000, y: 2000, xs: 600, ys: 600 })]));
    expect(board.components.map(component => component.ref)).toEqual(['R1', 'R2']);
    expect(pinsOf(board, 'R2').map(pin => [pin.number, pin.net])).toEqual([['3', 'B']]);
  });
});

describe('operation codes that are not read', () => {
  it('counts conductor and other records by code and keeps reading', () => {
    const board = must(file(['378SIG   L01 X+000100Y+000100', '078        X+000200Y+000100', '389NET     L02', '378SIG   L01 X+000300Y+000100', tht('A', 'R1', '1', 1000, 1000), '170 something', '389NET     L02']));
    expect(notes(board)).toContain('Records of operation code 378 (2), 078 (1), 389 (2), 170 (1) are not read.');
    expect(board.components).toHaveLength(1);
  });
  it('bounds the list of distinct codes it remembers', () => {
    const codes = Array.from({ length: 100 }, (_, index) => String(100 + index));
    const document = readIpc356(file([...codes.map(code => `${code}X`), tht('A', 'R1', '1', 1000, 1000)]));
    expect(document.stats.unsupported.length).toBeLessThanOrEqual(33);
    expect(document.stats.unsupported.find(item => item.code === 'other')?.count).toBeGreaterThan(0);
  });
  it('counts lines that are nothing it knows, without failing', () => {
    const board = must(file(['hello', '   indented', 'Cxyz not a comment', ...Array.from({ length: 8 }, (_, index) => tht('A', 'R1', String(index + 1), 1000, 1000 + index))]));
    expect(notes(board)).toContain('3 lines were not recognised and ignored.');
  });
});

describe('writers that do not keep the columns', () => {
  const board = must(RELAXED);
  it('splits a record on blanks when the fixed columns do not fit, keeping blanks inside the net name', () => {
    expect(board.components.map(component => [component.ref, component.pinIds.length])).toEqual([['R1', 1], ['U1', 3], ['J9', 1]]);
    expect(pinsOf(board, 'U1').map(pin => [pin.number, pin.net])).toEqual([['1', 'VCC'], ['2', 'BUS A 3'], ['3', '']]);
    expect(pinsOf(board, 'J9')[0].net).toBe('LONG_NET_NAME_OVER_FOURTEEN'); // no cut: this writer's net field is wider
    expect(pinsOf(board, 'R1')[0]).toMatchObject({ net: 'GND', x: 25.4, side: 'both' });
    expect(notes(board)).toContain('5 records did not follow the fixed columns and were split on blanks instead.');
  });
  it('splits a glued or blank-broken tail, and takes the first token as the reference when no net is given', () => {
    expect(readIpc356Record('327NET U1 -3 A 01X+000010Y+000020')).toMatchObject({ net: 'NET', ref: 'U1', pin: '3', access: 1, relaxed: true });
    expect(readIpc356Record('327NET U1 -3 A01X+0000Y+000020')).toBeNull(); // a number cut short is not a number
    expect(readIpc356Record('327NET U1 -3 M D0300P A01X+000010Y+000020')).toMatchObject({ net: 'NET', ref: 'U1', pin: '3', midpoint: true, holeDiameter: 300, plated: true, access: 1, relaxed: true });
    expect(readIpc356Record('327 U1 -3 A01X+000010Y+000020')).toMatchObject({ net: '', ref: 'U1', pin: '3', relaxed: true });
    expect(readIpc356Record('327 -3 A01X+000010Y+000020')).toMatchObject({ net: '', ref: '', pin: '3' });
    expect(readIpc356Record('327NET U1 A01X+000010Y+000020')).toMatchObject({ net: 'NET', ref: 'U1', pin: '' });
    expect(readIpc356Record('327NET A01X+000010Y+000020')).toMatchObject({ net: 'NET', ref: '', pin: '' });
  });
});

describe('text decoding and line endings', () => {
  const reference = must(INCH);
  it('reads CRLF, lone CR, a byte-order mark, trailing blanks and blank lines to the same board', () => {
    expect(must(INCH.replace(/\n/g, '\r\n'))).toEqual(reference);
    expect(must(INCH.replace(/\n/g, '\r'))).toEqual(reference);
    expect(must('﻿' + INCH)).toEqual(reference);
    expect(must(INCH.split('\n').map(line => line + '   ').join('\n'))).toEqual(reference);
    expect(must(INCH.replace(/\n/g, '\n\n'))).toEqual(reference);
    expect(must(INCH.replace(/\n/g, '\r\n\r\n'))).toEqual(reference);
  });
  it('reads Windows-1252 net names and a UTF-16 file the dispatcher has already re-encoded', () => {
    const latin1 = Uint8Array.from([...bytes(INCH.split('\n').slice(0, 8).join('\n') + '\n'), ...bytes('317N'), 0xb5, 0xa9, ...bytes('          J3    -1    D0300PA00X+001000Y+001000X0600Y0600R000S0\n999\n')]);
    expect(must(latin1).pins.at(-1)!.net).toBe('Nµ©');
  });
  it('accepts P and C records written with a single blank and lower-case keys', () => {
    const document = readIpc356(['C comment one', 'P JOB lower', 'P units cust 0', tht('A', 'R1', '1', 1, 1), '999'].join('\n'));
    expect(document.header).toMatchObject({ job: 'lower', units: { code: 'CUST 0' } });
    expect(document.header.comments).toEqual(['comment one']);
  });
  it('stops at the 999 record: what follows is not read, however broken', () => {
    const board = must(INCH + '317 this is not a record\nzzz\n' + '\0'.repeat(10));
    expect(board).toEqual(reference);
  });
});

describe('recognition (sniff) and claims', () => {
  const asBytes = (text: string) => bytes(text);
  it('is confident about a netlist with parameter records, a little less without them, and says what it saw', () => {
    expect(sniffIpc356(asBytes(INCH))).toMatchObject({ confidence: 0.97, variant: 'IPC-D-356A', units: 'CUST 0' });
    expect(sniffIpc356(asBytes(METRIC)).confidence).toBeCloseTo(0.97, 9);
    expect(sniffIpc356(asBytes('P  UNITS CUST 0\n' + NO_HEADER)).confidence).toBeCloseTo(0.95, 9); // one parameter record: no bonus for two
    expect(sniffIpc356(asBytes(NO_HEADER))).toMatchObject({ confidence: 0.85, variant: 'IPC-D-356' });
    expect(sniffIpc356(asBytes(CONTINUATION)).confidence).toBeGreaterThanOrEqual(0.9);
    expect(sniffIpc356(asBytes(INCH)).reason).toMatch(/test records in the first/);
    expect(looksLikeIpc356(asBytes(INCH))).toBe(true);
  });
  it('lowers its confidence as lines that are not records appear, and declines below 0.5', () => {
    const records = [tht('A', 'R1', '1', 1, 1), tht('A', 'R1', '2', 1, 2), tht('A', 'R1', '3', 1, 3)];
    expect(sniffIpc356(asBytes([...records, 'junk one', 'junk two'].join('\n'))).confidence).toBe(0.6);
    expect(sniffIpc356(asBytes(['P  UNITS CUST 0', ...records, 'junk one', 'junk two'].join('\n'))).confidence).toBeCloseTo(0.7, 9);
    expect(sniffIpc356(asBytes([...records, ...Array.from({ length: 12 }, (_, index) => `junk ${index}`)].join('\n'))).confidence).toBe(0.3);
    expect(parse([...records, ...Array.from({ length: 12 }, (_, index) => `junk ${index}`)].join('\n'))).toBeNull();
  });
  it('scores a UNITS record with numbered records that are not test records low and nothing else zero', () => {
    expect(sniffIpc356(asBytes('P  UNITS CUST 0\n378SIG   L01 X+000100Y+000100\n378SIG   L01 X+000100Y+000200\n')).confidence).toBe(0.2);
    for (const text of ['', 'P  UNITS CUST 0\nC  nothing else\n', '999\n', 'hello world\n'.repeat(5), '317 not a record at all\n'.repeat(4)]) {
      expect(sniffIpc356(asBytes(text)).confidence, JSON.stringify(text)).toBe(0);
    }
    expect(parse('P  UNITS CUST 0\n378SIG   L01 X+000100Y+000100\n378SIG   L01 X+000100Y+000200\n')).toBeNull();
  });
  it('declines binary data, other text formats and an oversized record line', () => {
    expect(sniffIpc356(Uint8Array.from([0, 1, 2, 3, 255, 254, 253, 0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])).confidence).toBe(0);
    expect(sniffIpc356(new Uint8Array(1000)).confidence).toBe(0);
    const others: Record<string, string> = {
      gencad: '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nRECTANGLE 0 0 10 10\n$ENDBOARD\n$COMPONENTS\nCOMPONENT R1\nPLACE 1 1\n$ENDCOMPONENTS\n',
      samsung: '###Panel Added\nCOMP U1 PN 0 0 1.0 2.0 1 0\nC_PIN U1-1 1.0 2.0 0 0 0 X GND\n',
      brd2: 'BRDOUT: 4 1000 1000\n0 0\n1000 0\n1000 1000\n0 1000\nNETS: 1\n1 GND\nPARTS: 1\nU1 0 1 1 1\nPINS: 1\n100 100 1 1\nNAILS: 0\n',
      bvr: 'BVRAW_FORMAT_3\nBOARD 0 0 100 100\nPART_NAME U1\nPART_SIDE T\nPIN_NUMBER 1\nPIN_X 10\nPIN_Y 20\n',
      ipc2581: '<?xml version="1.0"?>\n<IPC-2581 revision="C">\n</IPC-2581>\n',
      gerber: '%FSLAX36Y36*%\n%MOMM*%\nG04 layer*\nM02*\n',
      csv: 'RefDes,Pin,Net,X,Y,Side\nU1,1,GND,10,20,top\nU1,2,VCC,11,20,top\n',
      numbers: '317 123\n327 456 X1Y2\n999\n',
    };
    for (const [name, text] of Object.entries(others)) expect(sniffIpc356(asBytes(text)).confidence, name).toBeLessThan(0.5);
    for (const [name, text] of Object.entries(others)) expect(parse(text), name).toBeNull();
    const long = '317' + 'X'.repeat(IPC356_MAX_RECORD_LINE + 10);
    expect(sniffIpc356(asBytes(long + '\n' + long + '\n')).confidence).toBe(0);
  });
  it('is not claimed by any other registered adapter, and claims none of their synthetic samples (collision check)', () => {
    const input = { name: 'netlist.ipc', data: asBytes(INCH) };
    for (const { id, parse: other } of PARSERS.filter(entry => entry.id !== 'ipc356')) expect(other(input), id).toBeNull();
    for (const text of [METRIC, CONTINUATION, RELAXED, NO_HEADER]) for (const { id, parse: other } of PARSERS.filter(entry => entry.id !== 'ipc356')) expect(other({ name: 'x.ipc', data: asBytes(text) }), id).toBeNull();
  });
  it('sniffs the first 64 KiB only and ignores a record that the cut leaves half written', () => {
    const records = Array.from({ length: 2000 }, (_, index) => tht('NET' + (index % 50), 'R' + index, '1', 1000 + index, 1000));
    const text = ['P  UNITS CUST 0', ...records].join('\n');
    expect(text.length).toBeGreaterThan(64 * 1024);
    expect(sniffIpc356(asBytes(text)).confidence).toBeGreaterThanOrEqual(0.9);
    expect(sniffIpc356(asBytes('x'.repeat(200_000) + '\n' + text)).confidence).toBe(0);
  });
});

describe('malformed and hostile input', () => {
  it('rejects a recognized record that does not fit, with its line number and the format name', () => {
    const lines = INCH.split('\n');
    const damaged = (index: number, replace: (line: string) => string) => lines.map((line, at) => at === index ? replace(line) : line).join('\n');
    const cases: Array<[string, RegExp]> = [
      [damaged(7, line => line.replace('X+010000', 'Z+010000')), /line 8: a 317 record does not follow the IPC-D-356 column layout/],
      [damaged(9, line => line.slice(0, 55)), /line 10: a 327 record does not follow/],
      [damaged(13, line => line.replace('A02', 'AZZ')), /line 14: a 327 record does not follow/],
      [damaged(7, line => line.padEnd(IPC356_MAX_RECORD_LINE + 1, ' ') + 'X'), /line 8: a record is longer than 256 characters/],
    ];
    for (const [text, pattern] of cases) {
      const error = thrown(text);
      expect(error.message).toMatch(pattern);
      expect(error.format).toBe('IPC-D-356');
    }
    expect(thrown(cases[3][0]).code).toBe('LIMIT_EXCEEDED');
    expect(thrown(cases[0][0]).code).toBe('INVALID_FORMAT');
  });

  it('rejects coordinates the board cannot hold, naming the format', () => {
    const big = must(file([tht('A', 'R1', '1', 1000, 1000)]), 'board.ipc', { unitsToMm: 1 });
    expect(big.pins[0].x).toBe(1000);
    expect(thrown(file([tht('A', 'R1', '1', 999_999, 999_999)]), { unitsToMm: 1e6 })).toMatchObject({ format: 'IPC-D-356' });
    expect(thrown(file([tht('A', 'R1', '1', 999_999, 999_999)]), { unitsToMm: 1e6 }).message).toMatch(/exceeds the supported range/);
  });

  it('bounds the number of test records and components', () => {
    const rows = Array.from({ length: 6 }, (_, index) => tht('A', 'R' + index, '1', index * 10, 0));
    expect(() => readIpc356(file(rows), { maxFeatures: 5 })).toThrow(/line 7: the number of test records exceeds the import limit/);
    expect(readIpc356(file(rows), { maxFeatures: 6 }).features).toHaveLength(6);
    try { readIpc356(file(rows), { maxFeatures: 5 }); } catch (error) { expect(error).toMatchObject({ code: 'LIMIT_EXCEEDED', format: 'IPC-D-356' }); }
    const parts = ['P  UNITS CUST 0', ...Array.from({ length: 250_001 }, (_, index) => `317A             R${index}`.padEnd(26, ' ') + ' ' + ' '.repeat(4) + ' ' + 'D0300PA00X+000001Y+000001X0100Y0100R000S0')].join('\n');
    expect(thrown(parts)).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  }, 300_000);

  it('turns every truncation of a valid file into a board, null or a BoardFormatError, nothing else', () => {
    const data = bytes(INCH);
    let boards = 0, failures = 0, nulls = 0;
    for (let length = 0; length <= data.length; length++) {
      try { if (parse(data.slice(0, length))) boards++; else nulls++; }
      catch (error) { expect(error, `prefix ${length}`).toBeInstanceOf(BoardFormatError); failures++; }
    }
    expect(boards).toBeGreaterThan(0); expect(failures).toBeGreaterThan(0); expect(nulls).toBeGreaterThan(0);
  });

  it('survives random byte and line mutations of valid files: a board, null or a BoardFormatError', () => {
    let seed = 0x2545f491;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };
    const sources = [INCH, METRIC, CONTINUATION, RELAXED, NO_HEADER].map(bytes);
    let outcomes = { board: 0, nul: 0, error: 0 };
    for (let round = 0; round < 600; round++) {
      const data = Uint8Array.from(sources[round % sources.length]);
      for (let flips = 1 + Math.floor(random() * 6); flips > 0; flips--) data[Math.floor(random() * data.length)] = random() < 0.3 ? 0x20 + Math.floor(random() * 96) : Math.floor(random() * 256);
      const cut = random() < 0.2 ? data.slice(0, Math.floor(random() * data.length)) : data;
      try { if (parse(cut)) outcomes.board++; else outcomes.nul++; }
      catch (error) { expect(error, `round ${round}`).toBeInstanceOf(BoardFormatError); outcomes.error++; }
    }
    expect(outcomes.board).toBeGreaterThan(0); expect(outcomes.error).toBeGreaterThan(0);
  });

  it('never reads random binary as a netlist', () => {
    let seed = 7;
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let round = 0; round < 50; round++) expect(parse(Uint8Array.from({ length: 4096 }, () => random() & 0xff)), `round ${round}`).toBeNull();
  });

  it('handles blank-line, space and long-line floods in linear time', () => {
    const cases: Array<[string, string]> = [
      ['blank lines', '\n'.repeat(4_000_000)], ['CRLF blank lines', '\r\n'.repeat(2_000_000)], ['one space per line', ' \n'.repeat(2_000_000)],
      ['one line without a break', 'x'.repeat(8_000_000)], ['record prefix then blanks', '317' + ' '.repeat(8_000_000)], ['digits only', '3'.repeat(8_000_000)],
      ['space-filled record', ['P  UNITS CUST 0', '317A' + ' '.repeat(240) + 'X+000001Y+000001', '999'].join('\n')],
    ];
    for (const [label, text] of cases) {
      const result = timed(() => { try { return parse(text); } catch (error) { return error; } }, text.length);

      expect(result.value === null || result.value instanceof BoardFormatError || (result.value as Board).format === 'IPC-D-356', label).toBe(true);
    }
  });

  it('checks the tail patterns against crafted worst cases in linear time', () => {
    const tails = ['X+' + '1'.repeat(200) + 'Y+1', 'D' + '1'.repeat(200) + 'P', 'M'.repeat(200) + 'X', 'X+000001Y+000001' + 'R' + '1'.repeat(200), 'X+000001Y+000001X' + '1'.repeat(200), '317' + ' -'.repeat(110) + 'X+000001Y+000001'];
    const result = timed(() => { for (let round = 0; round < 2000; round++) for (const tail of tails) readIpc356Record('327NET U1 -1 ' + tail); }, 2000 * tails.reduce((n, tail) => n + tail.length, 0));
  });

  it('reads a large netlist quickly and in bounded memory (200,000 test records, about 15 MB)', () => {
    const rows: string[] = ['P  UNITS CUST 0'];
    for (let index = 0; index < 200_000; index++) rows.push(index % 5 ? smd('NET' + (index % 4000), 'C' + (index >> 2), String((index % 5) + 1), (index % 1000) * 100, (index >> 10) * 100) : tht('GND', 'J' + (index >> 6), String((index >> 2) % 60 + 1), (index % 1000) * 100 + 50, (index >> 10) * 100 + 50));
    rows.push('999');
    const data = bytes(rows.join('\r\n') + '\r\n');
    expect(data.length).toBeGreaterThan(14_000_000);
    expectScaling('IPC test records', [12_500, 50_000, 200_000], n => {
      const input = bytes(rows.slice(0, n + 1).join('\n') + '\n999\n');
      return () => parse(input);
    });
    const result = { value: parse(data)! };
    expect(result.value.pins.length).toBeGreaterThan(190_000);
    expect(result.value.components.length).toBeGreaterThan(40_000);
  }, 300_000);
});
