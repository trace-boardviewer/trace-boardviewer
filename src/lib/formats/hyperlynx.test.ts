import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import { BoardFormatError, TextDecodeError, textInput } from './common';
import { parseHyperlynx, sniffHyperlynx, sniffHyperlynxText } from './hyperlynx';
import { catching, expectCostAtMost, expectScaling } from '../../test-support/timing';

// Original synthetic files written from the public record layout (the IBIS BIRD 33 ancestor of the format, exporter documentation);
// no byte of a vendor file is used. Fixtures on disk live in tests/fixtures/hyperlynx.
const fixture = (name: string) => readFileSync(new URL(`../../../tests/fixtures/hyperlynx/${name}`, import.meta.url), 'utf8');
const bytes = (value: string) => new TextEncoder().encode(value);
const inch = (value: number) => value * 25.4;
const parse = (text: string | Uint8Array, name = 'board.hyp'): Board => {
  const board = parseHyperlynx({ name, data: typeof text === 'string' ? bytes(text) : text });
  if (!board) throw new Error('fixture was not recognized');
  return board;
};
const thrown = (text: string | Uint8Array, name = 'board.hyp'): BoardFormatError => {
  try { parseHyperlynx({ name, data: typeof text === 'string' ? bytes(text) : text }); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
};
const notes = (board: Board) => board.warnings.filter(issue => issue.key === 'parse.warning.formatNote').map(issue => String(issue.params?.message));
const warningKeys = (board: Board) => board.warnings.map(issue => issue.key);
const refOf = (board: Board, pin: Board['pins'][number]) => board.components.find(component => component.id === pin.componentId)!.ref;
const pinRows = (board: Board) => board.pins.map(pin => `${refOf(board, pin)}.${pin.number}|${pin.net}|${pin.side}|${pin.shape}`);
const near = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 6);

interface Doc { units?: string; version?: string; board?: string; stackup?: string; devices?: string; padstacks?: string; nets?: string; end?: boolean; head?: string }
const SQUARE = (x0: number, y0: number, x1: number, y1: number) => [`(PERIMETER_SEGMENT X1=${x0} Y1=${y0} X2=${x1} Y2=${y0})`, `(PERIMETER_SEGMENT X1=${x1} Y1=${y0} X2=${x1} Y2=${y1})`, `(PERIMETER_SEGMENT X1=${x1} Y1=${y1} X2=${x0} Y2=${y1})`, `(PERIMETER_SEGMENT X1=${x0} Y1=${y1} X2=${x0} Y2=${y0})`].join('\n');
const doc = ({ units = '{UNITS=ENGLISH LENGTH}', version = '{VERSION=2.0}', board = SQUARE(0, 0, 2, 1), stackup = '(SIGNAL T=0.0014 L=TOP)\n(DIELECTRIC T=0.01)\n(SIGNAL T=0.0014 L=BOTTOM)', devices = '(R REF=R1 VAL=10k L=TOP)',
  padstacks = '{PADSTACK=S\n(TOP, 1, 0.02, 0.01, 0.0, M)\n}', nets = '{NET=N1\n(PIN X=0.5 Y=0.5 R=R1.1 P=S)\n(PIN X=0.6 Y=0.5 R=R1.2 P=S)\n}', end = true, head = '' }: Doc = {}) =>
  `${head}${version}\n${units}\n{BOARD\n${board}\n}\n{STACKUP\n${stackup}\n}\n{DEVICES\n${devices}\n}\n${padstacks}\n${nets}\n${end ? '{END}\n' : ''}`;

describe('HyperLynx: golden fixture', () => {
  const board = parse(fixture('golden.hyp'), 'golden.hyp');
  it('reads units, components, sides, values and pins', () => {
    expect(board.format).toBe('HyperLynx (.hyp)'); expect(board.name).toBe('golden'); expect(board.units).toBe('mm');
    expect(board.components.map(c => [c.ref, c.side, c.value, c.pinIds.length])).toEqual([['U1', 'top', 'QFN4', 4], ['R1', 'top', '10k', 2], ['C1', 'bottom', '100n', 2], ['J1', 'top', 'HDR2', 2], ['TP9', 'top', '', 1]]);
    expect(pinRows(board)).toEqual([
      'U1.1|GND|top|rect', 'U1.2|GND|top|rect', 'C1.2|GND|bottom|square', 'J1.1|GND|both|round',
      'U1.3|+3V3|top|rect', 'R1.1|+3V3|top|rect', 'J1.2|+3V3|both|round', 'TP9.1|+3V3|top|rect',
      'R1.2|SIG|top|rect', 'C1.1|SIG|bottom|square', 'U1.4|SIG|top|rect',
    ]);
    expect(board.nets.map(net => [net.name, net.pinIds.length])).toEqual([['GND', 4], ['+3V3', 4], ['SIG', 3]]);
  });
  it('converts inches to millimetres, keeps Y up and reads exact pad sizes and angles', () => {
    const [u11] = board.pins, c12 = board.pins[2], j11 = board.pins[3];
    near(u11.x, inch(0.5)); near(u11.y, inch(0.5)); near(u11.width!, inch(0.02)); near(u11.height!, inch(0.01)); near(u11.radius, inch(0.005));
    expect(u11.rotation).toBe(0);
    expect(c12.rotation).toBe(90); near(c12.width!, inch(0.02));
    near(j11.radius, inch(0.03)); near(j11.width!, inch(0.06));
    expect(board.bounds.minX).toBeCloseTo(0, 9); near(board.bounds.maxX, inch(2)); near(board.bounds.maxY, inch(1));
    expect(board.outline).toHaveLength(4);
  });
  it('discloses what the format cannot give and what is not shown', () => {
    expect(notes(board)).toEqual([
      'HyperLynx: the file stores no component origin, rotation or body; each component is placed at the centre of its pads, and only pins that belong to a net are listed.',
      'HyperLynx traces, vias and copper polygons are not shown (1 trace record, 1 via or pad record, 1 polygon block).',
    ]);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 1 } });
    expect(warningKeys(board)).not.toContain('parse.warning.missingBoardOutline');
  });
});

describe('HyperLynx: KiCad-style export (quoted names, F.Cu/B.Cu layers, numeric padstacks, Y already up)', () => {
  const board = parse(fixture('kicad-style.hyp'), 'kicad-style.hyp');
  it('resolves sides from the first and last metal layer of the stackup', () => {
    expect(board.components.map(c => [c.ref, c.side])).toEqual([['U1', 'top'], ['R1', 'top'], ['C1', 'bottom'], ['J1', 'top']]);
    expect(pinRows(board)).toEqual(['U1.1|GND|top|rect', 'U1.2|GND|top|rect', 'C1.2|GND|bottom|square', 'J1.1|GND|both|round', 'R1.1|Net-(R1-Pad1)|top|rect', 'U1.3|Net-(R1-Pad1)|top|rect']);
  });
  it('keeps negative Y as the file has it and uses the layer-specific pad', () => {
    const pad = board.pins[2]; // C1.2 on B.Cu: 0.0590551181 in square
    near(pad.x, inch(2.5)); near(pad.y, inch(-1.5)); near(pad.width!, inch(0.0590551181));
    near(board.bounds.minY, inch(-2)); near(board.bounds.maxY, inch(-1));
  });
  it('notes the component the DEVICES section does not list', () => {
    expect(notes(board).some(message => /1 component is named by pins but not listed in \{DEVICES\}/.test(message))).toBe(true);
  });
});

describe('HyperLynx: text layout tolerance', () => {
  const reference = parse(doc());
  it('reads CRLF, CR-only, a BOM, tabs, trailing comments, * comments and blank lines to the same board', () => {
    const text = doc();
    expect(parse(text.replace(/\n/g, '\r\n'))).toEqual(reference);
    expect(parse(text.replace(/\n/g, '\r'))).toEqual(reference);
    expect(parse('\uFEFF' + text)).toEqual(reference);
    expect(parse(text.replace(/ /g, '\t'))).toEqual(reference);
    expect(parse(text.replace(/\)\n/g, ')   35 micrometres thick (1 oz)\n'))).toEqual(reference);
    expect(parse(`* comment\n\n${text}\n* trailing comment`)).toEqual(reference);
    expect(parse(text.replace(/\n/g, '\n\n  '))).toEqual(reference);
  });
  it('accepts a closing brace on the last subrecord line and one-line empty blocks', () => {
    expect(parse(doc({ devices: '(R REF=R1 VAL=10k L=TOP)}\n{SUPPLIES}' }).replace('\n}\n{PADSTACK', '\n{PADSTACK'))).toEqual(reference);
  });
  it('reads UTF-16 with a byte-order mark', () => {
    const text = '\uFEFF' + doc(), data = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) { data[2 * i] = text.charCodeAt(i) & 255; data[2 * i + 1] = text.charCodeAt(i) >> 8; }
    expect(parse(Uint8Array.from([0xff, 0xfe, ...data.subarray(2)]))).toEqual(reference);
  });
  it('reads lowercase keywords and unquoted values that contain blanks', () => {
    const board = parse(doc({ devices: '(? ref=R1 name=Resistor 0402 1% val=10k l=TOP)' }));
    expect(board.components[0]).toMatchObject({ ref: 'R1', value: '10k' });
    const unquoted = parse(doc({ devices: '(? REF=R1 NAME=Chip Resistor VAL=4.7k L=TOP PKG=0402)' }));
    expect(unquoted.components[0]).toMatchObject({ ref: 'R1', value: '4.7k', package: '0402' });
  });
  it('treats an empty value before the next KEY= as an empty string', () => {
    expect(parse(doc({ devices: '(? REF=R1 NAME= VAL= L=TOP)' })).components[0]).toMatchObject({ ref: 'R1', value: '', side: 'top' });
  });
  it('accepts doubled quotes inside quoted names and parentheses in unquoted values', () => {
    const board = parse(doc({ devices: '(? REF=R1 NAME="a ""b"" c" VAL=CAP(0402) L=TOP)' }));
    expect(board.components[0]).toMatchObject({ ref: 'R1', value: 'CAP(0402)' });
  });
});

describe('HyperLynx: units and numbers', () => {
  it('reads METRIC as millimetres and ENGLISH as inches (the second word is only the metal thickness unit)', () => {
    const metric = parse(doc({ units: '{UNITS=METRIC WEIGHT}', board: SQUARE(0, 0, 50, 25), nets: '{NET=N1\n(PIN X=10 Y=5 R=R1.1 P=S)\n}' }));
    near(metric.pins[0].x, 10); near(metric.bounds.maxX, 50);
    const english = parse(doc({ units: '{UNITS=ENGLISH WEIGHT}', nets: '{NET=N1\n(PIN X=1 Y=0.5 R=R1.1 P=S)\n}' }));
    near(english.pins[0].x, 25.4);
  });
  it('reads exponents and the SI suffixes of the number syntax', () => {
    const board = parse(doc({ units: '{UNITS=METRIC LENGTH}', nets: '{NET=N1\n(PIN X=1e1 Y=500m R=R1.1 P=S)\n(PIN X=12k Y=-3u R=R1.2 P=S)\n}' }));
    near(board.pins[0].x, 10); near(board.pins[0].y, 0.5); near(board.pins[1].x, 12000); near(board.pins[1].y, -0.000003);
  });
  it('rejects invalid, hexadecimal, non-finite and over-long numbers with the line number', () => {
    for (const bad of ['0x10', 'Infinity', 'NaN', '1..2', '1e', '--1', '1x', '1'.repeat(129)]) {
      const error = thrown(doc({ nets: `{NET=N1\n(PIN X=${bad} Y=0.5 R=R1.1 P=S)\n}` }));
      expect(error.code, bad).toBe('INVALID_FORMAT'); expect(error.message, bad).toMatch(/line \d+: (invalid|pin X)/);
    }
    expect(thrown(doc({ nets: '{NET=N1\n(PIN Y=0.5 R=R1.1 P=S)\n}' })).message).toMatch(/missing pin X/);
  });
  it('rejects coordinates beyond the supported range', () => {
    expect(thrown(doc({ nets: '{NET=N1\n(PIN X=1e12 Y=0 R=R1.1 P=S)\n}' })).message).toMatch(/exceeds the supported range/);
  });
  it('requires a known {UNITS} record', () => {
    expect(thrown(doc({ units: '' }).replace('\n\n', '\n')).message).toMatch(/no \{UNITS\} record/);
    expect(thrown(doc({ units: '{UNITS=FURLONGS LENGTH}' })).message).toMatch(/must be ENGLISH or METRIC/);
    expect(thrown(doc({ units: '{UNITS=ENGLISH LENGTH}\n{UNITS=METRIC LENGTH}' })).message).toMatch(/two different \{UNITS\}/);
    expect(parse(doc({ units: '{UNITS=ENGLISH LENGTH}\n{UNITS=ENGLISH WEIGHT}' })).pins).toHaveLength(2);
  });
});

describe('HyperLynx: sides', () => {
  const stack = '(SIGNAL L="L1_Top Layer")\n(PLANE L=GND)\n(SIGNAL L=INNER)\n(SIGNAL L="L4_Bottom Layer")';
  it('uses the position of the component layer in the stackup, with a case-insensitive match', () => {
    const board = parse(doc({ stackup: stack, padstacks: '{PADSTACK=S\n(MDEF, 1, 0.02, 0.01, 0.0, M)\n}', devices: '(R REF=R1 L="l1_top layer")\n(R REF=R2 L="L4_Bottom Layer")\n(J REF=J1 L=EDGE)',
      nets: '{NET=N\n(PIN X=1 Y=1 R=R1.1 P=S)\n(PIN X=2 Y=1 R=R2.1 P=S)\n(PIN X=3 Y=1 R=J1.1 P=S)\n}' }));
    expect(board.components.map(c => c.side)).toEqual(['top', 'bottom', 'both']);
    expect(board.pins.map(p => p.side)).toEqual(['top', 'bottom', 'both']);
  });
  it('puts a pad on the one outer layer its padstack lists, or on its own L= layer, even when that is not the side of the component', () => {
    const padstacks = '{PADSTACK=T\n(TOP, 1, 0.02, 0.01, 0)\n}\n{PADSTACK=B\n(BOTTOM, 1, 0.03, 0.04, 0)\n}\n{PADSTACK=D\n(MDEF, 1, 0.05, 0.05, 0)\n(BOTTOM, 1, 0.06, 0.06, 0)\n}\n{PADSTACK=I\n(INNER, 1, 0.07, 0.07, 0)\n(BOTTOM, 1, 0.08, 0.08, 0)\n}';
    const board = parse(doc({ stackup: '(SIGNAL L=TOP)\n(SIGNAL L=INNER)\n(SIGNAL L=BOTTOM)', padstacks, devices: '(J REF=J1 L=TOP)\n(R REF=R1 L=TOP)',
      nets: '{NET=N\n(PIN X=1 Y=1 R=J1.1 P=T)\n(PIN X=2 Y=1 R=J1.2 P=B)\n(PIN X=3 Y=1 R=J1.3 P=D)\n(PIN X=4 Y=1 R=J1.4 P=I)\n(PIN X=5 Y=1 R=J1.5 L=BOTTOM P=T)\n(PIN X=6 Y=1 R=J1.6 L=NOWHERE P=T)\n}' }));
    expect(board.pins.map(p => [p.number, p.side])).toEqual([['1', 'top'], ['2', 'bottom'], ['3', 'top'], ['4', 'bottom'], ['5', 'bottom'], ['6', 'top']]);
    near(board.pins[1].width!, inch(0.03)); near(board.pins[3].width!, inch(0.08)); near(board.pins[2].width!, inch(0.05));
    expect(board.components.map(c => [c.ref, c.side])).toEqual([['J1', 'top']]);
  });
  it('reads a declared component by its own layer when every pad of it names the other side, and says so', () => {
    const padstacks = '{PADSTACK=T\n(TOP, 1, 0.02, 0.01, 0)\n}';
    const board = parse(doc({ padstacks, devices: '(R REF=R1 L=BOTTOM)\n(R REF=R2 L=BOTTOM)',
      nets: '{NET=N\n(PIN X=1 Y=1 R=R1.1 P=T)\n(PIN X=2 Y=1 R=R1.2 P=T)\n(PIN X=3 Y=1 R=R2.1 P=T)\n}' }));
    expect(board.pins.map(p => p.side)).toEqual(['bottom', 'bottom', 'bottom']);
    expect(notes(board).some(message => /^2 components have pads that all lie on the other side than their L= layer/.test(message))).toBe(true);
    // One agreeing pad is enough to trust the others (an edge-connector finger on the far side).
    const mixed = parse(doc({ padstacks: `${padstacks}\n{PADSTACK=B\n(BOTTOM, 1, 0.02, 0.01, 0)\n}`, devices: '(J REF=J1 L=BOTTOM)', nets: '{NET=N\n(PIN X=1 Y=1 R=J1.1 P=T)\n(PIN X=2 Y=1 R=J1.2 P=B)\n}' }));
    expect(mixed.pins.map(p => p.side)).toEqual(['top', 'bottom']);
    expect(notes(mixed).some(message => /other side than/.test(message))).toBe(false);
  });
  it('shows an inner-layer or unknown-layer component on top and says so', () => {
    const board = parse(doc({ stackup: stack, devices: '(R REF=R1 L=INNER)\n(R REF=R2 L=NOWHERE)',
      nets: '{NET=N\n(PIN X=1 Y=1 R=R1.1 P=S)\n(PIN X=2 Y=1 R=R2.1 P=S)\n}' }));
    expect(board.components.map(c => c.side)).toEqual(['top', 'top']);
    expect(notes(board).some(message => /2 components are on a layer that is not the first or last metal layer/.test(message))).toBe(true);
  });
  it('falls back to TOP/BOTTOM words and F./B. prefixes when the stackup has no such layer', () => {
    const board = parse(doc({ stackup: '(DIELECTRIC T=0.01)', devices: '(R REF=R1 L=Bottom)\n(R REF=R2 L=Top_Side)\n(R REF=R3 L=B.Cu)\n(R REF=R4 L=F.Cu)',
      nets: '{NET=N\n(PIN X=1 Y=1 R=R1.1 P=S)\n(PIN X=2 Y=1 R=R2.1 P=S)\n(PIN X=3 Y=1 R=R3.1 P=S)\n(PIN X=4 Y=1 R=R4.1 P=S)\n}' }));
    expect(board.components.map(c => c.side)).toEqual(['bottom', 'top', 'bottom', 'top']);
  });
  it('infers the side of a part the DEVICES section omits from an SMD pad that exists only on the bottom layer', () => {
    const board = parse(doc({ devices: '(R REF=R1 L=TOP)', padstacks: '{PADSTACK=S\n(TOP, 1, 0.02, 0.01, 0)\n}\n{PADSTACK=SB\n(BOTTOM, 1, 0.02, 0.01, 0)\n}',
      nets: '{NET=N\n(PIN X=1 Y=1 R=R1.1 P=S)\n(PIN X=2 Y=1 R=Q1.1 P=SB)\n(PIN X=3 Y=1 R=Q2.1 P=S)\n}' }));
    expect(board.components.map(c => [c.ref, c.side])).toEqual([['R1', 'top'], ['Q1', 'bottom'], ['Q2', 'top']]);
  });
});

describe('HyperLynx: padstacks', () => {
  const withStacks = (padstacks: string, pins: string) => parse(doc({ padstacks, nets: `{NET=N\n${pins}\n}` }));
  it('maps shape codes: 0/-1 round or oval, 1 square or rectangle, 2 oblong, unknown as rectangle', () => {
    const board = withStacks(['{PADSTACK=A\n(TOP, 0, 0.02, 0.02, 0)\n}', '{PADSTACK=B\n(TOP, 0, 0.03, 0.02, 0)\n}', '{PADSTACK=C\n(TOP, 1, 0.02, 0.02, 45)\n}', '{PADSTACK=D\n(TOP, 2, 0.02, 0.02, 0)\n}', '{PADSTACK=E\n(TOP, -1, 0.02, 0.02, 0)\n}', '{PADSTACK=F\n(TOP, 9, 0.02, 0.03, 0)\n}'].join('\n'),
      'ABCDEF'.split('').map((id, i) => `(PIN X=${i + 1} Y=1 R=R1.${id} P=${id})`).join('\n'));
    expect(board.pins.map(p => p.shape)).toEqual(['round', 'rect', 'square', 'round', 'round', 'rect']);
    expect(board.pins[2].rotation).toBe(45);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 1 } });
    expect(notes(board).some(message => /1 pad uses an unknown HyperLynx pad shape code/.test(message))).toBe(true);
  });
  it('picks the pad on the component layer, then MDEF, then the first metal pad; anti-pads are never used', () => {
    const stacks = '{PADSTACK=P\n(MDEF, 1, 0.05, 0.05, 0)\n(BOTTOM, 1, 0.03, 0.03, 0)\n(ADEF, 1, 0.09, 0.09, 0, A)\n}\n{PADSTACK=Q\n(INNER, 1, 0.07, 0.07, 0)\n(ADEF, 1, 0.09, 0.09, 0, A)\n}\n{PADSTACK=A\n(TOP, 1, 0.08, 0.08, 0, A)\n}';
    const board = parse(doc({ padstacks: stacks, devices: '(R REF=R1 L=BOTTOM)\n(R REF=R2 L=TOP)', nets: '{NET=N\n(PIN X=1 Y=1 R=R1.1 P=P)\n(PIN X=2 Y=1 R=R2.1 P=P)\n(PIN X=3 Y=1 R=R2.2 P=Q)\n(PIN X=4 Y=1 R=R2.3 P=A)\n}' }));
    near(board.pins[0].width!, inch(0.03)); near(board.pins[1].width!, inch(0.05)); near(board.pins[2].width!, inch(0.07));
    expect(board.pins[3].width).toBeUndefined();
    expect(notes(board).some(message => /1 pin has a padstack without a usable metal pad size/.test(message))).toBe(true);
  });
  it('treats a drilled padstack as through-hole (both sides) and a plain one as the component side', () => {
    const board = withStacks('{PADSTACK=T, 0.035\n(MDEF, 0, 0.06, 0.06, 0)\n}\n{PADSTACK=S\n(TOP, 1, 0.02, 0.01, 0)\n}', '(PIN X=1 Y=1 R=R1.1 P=T)\n(PIN X=2 Y=1 R=R1.2 P=S)');
    expect(board.pins.map(p => p.side)).toEqual(['both', 'top']);
  });
  it('reads a padstack name given in quotes or as a number, and thermal-relief elements as metal', () => {
    const board = withStacks('{PADSTACK="1", 0.01\n("MDEF", 0, 0.04, 0.04, 0.0, T, 0, 0.05, 0.05, 0.0)\n}', '(PIN X=1 Y=1 R=R1.1 P=1)');
    near(board.pins[0].width!, inch(0.04));
  });
  it('keeps a pin without a padstack or with an unknown padstack, and counts it', () => {
    const board = withStacks('', '(PIN X=1 Y=1 R=R1.1)\n(PIN X=2 Y=1 R=R1.2 P=NOPE)');
    expect(board.pins.map(p => p.width)).toEqual([undefined, undefined]);
    expect(notes(board).some(message => /1 pin record names a padstack that the file does not define/.test(message))).toBe(true);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 2 } });
  });
  it('rejects a padstack defined twice, one without a name, and more than 512 elements', () => {
    expect(thrown(doc({ padstacks: '{PADSTACK=S\n(TOP, 1, 1, 1, 0)\n}\n{PADSTACK=S\n(TOP, 1, 1, 1, 0)\n}' })).message).toMatch(/defined twice/);
    expect(thrown(doc({ padstacks: '{PADSTACK=\n(TOP, 1, 1, 1, 0)\n}' })).message).toMatch(/no name/);
    const many = Array.from({ length: 513 }, (_, i) => `(L${i}, 1, 1, 1, 0)`).join('\n');
    expect(thrown(doc({ padstacks: `{PADSTACK=S\n${many}\n}` })).code).toBe('LIMIT_EXCEEDED');
  });
});

describe('HyperLynx: pins and nets', () => {
  it('splits R= at the last dot that follows a declared device, otherwise at the first dot', () => {
    const board = parse(doc({ devices: '(J REF=J1.A L=TOP)\n(R REF=R1 L=TOP)',
      nets: '{NET=N\n(PIN X=1 Y=1 R=J1.A.3 P=S)\n(PIN X=2 Y=1 R=R1.1.2 P=S)\n(PIN X=3 Y=1 R=Q9.A.B P=S)\n}' }));
    expect(board.components.map(c => c.ref)).toEqual(['J1.A', 'R1', 'Q9']);
    expect(board.pins.map(p => p.number)).toEqual(['3', '1.2', 'A.B']);
  });
  it('rejects a reference without a dot or without a component name, and a very long reference', () => {
    expect(thrown(doc({ nets: '{NET=N\n(PIN X=1 Y=1 R=R1 P=S)\n}' })).message).toMatch(/has no "\.pin" part/);
    expect(thrown(doc({ nets: '{NET=N\n(PIN X=1 Y=1 R=.1 P=S)\n}' })).message).toMatch(/no component name/);
    expect(thrown(doc({ nets: `{NET=N\n(PIN X=1 Y=1 R=${'R'.repeat(300)}.1 P=S)\n}` })).message).toMatch(/longer than 256/);
    expect(thrown(doc({ nets: '{NET=N\n(PIN X=1 Y=1 P=S)\n}' })).message).toMatch(/no R= reference/);
  });
  it('reads quoted, unquoted, parenthesised and parameterised net names and an empty net as no net', () => {
    const board = parse(doc({ nets: ['{NET="A B"\n(PIN X=1 Y=1 R=R1.1 P=S)\n}', '{NET=(Net0)\n(PIN X=2 Y=1 R=R1.2 P=S)\n}', '{NET=GND PS=0.01\n(PIN X=3 Y=1 R=R1.3 P=S)\n}', '{NET=\n(PIN X=4 Y=1 R=R1.4 P=S)\n}', '{NET="say ""hi"""\n(PIN X=5 Y=1 R=R1.5 P=S)\n}'].join('\n') }));
    expect(board.pins.map(p => p.net)).toEqual(['A B', '(Net0)', 'GND', '', 'say "hi"']);
  });
  it('keeps several pads that share a pin name, merges an exact repeat, and reports a pad listed in two nets', () => {
    const board = parse(doc({ nets: '{NET=A\n(PIN X=1 Y=1 R=R1.EP P=S)\n(PIN X=1.2 Y=1 R=R1.EP P=S)\n(PIN X=1 Y=1 R=R1.EP P=S)\n}\n{NET=B\n(PIN X=1 Y=1 R=R1.EP P=S)\n}' }));
    expect(board.pins.map(p => [p.number, p.net])).toEqual([['EP', 'A'], ['EP', 'A']]);
    expect(notes(board).some(message => /1 pad is listed in two nets at the same place/.test(message))).toBe(true);
  });
  it('keeps two pads of one pin at the same place when their padstacks differ (a via in a pad)', () => {
    const board = parse(doc({ padstacks: '{PADSTACK=S\n(TOP, 1, 0.02, 0.01, 0)\n}\n{PADSTACK=V, 0.01\n(MDEF, 0, 0.02, 0.02, 0)\n}', nets: '{NET=A\n(PIN X=1 Y=1 R=R1.1 P=S)\n(PIN X=1 Y=1 R=R1.1 P=V)\n(PIN X=1 Y=1 R=R1.1 P=S)\n}' }));
    expect(board.pins.map(p => [p.number, p.side, p.shape])).toEqual([['1', 'top', 'rect'], ['1', 'both', 'round']]);
  });
  it('omits a declared component that no pin names, and says so', () => {
    const board = parse(doc({ devices: '(R REF=R1 L=TOP)\n(R REF=R2 L=TOP)\n(R REF=R3 L=TOP)' }));
    expect(board.components.map(c => c.ref)).toEqual(['R1']);
    expect(notes(board)).toContain('2 components without pins were omitted because the file gives no position for them.');
  });
  it('keeps the first of a repeated device reference and says so, and rejects a missing one and a file whose devices have no pins at all', () => {
    const repeated = parse(doc({ devices: '(R REF=R1 VAL=10k L=TOP)\n(R REF=R1 VAL=1k L=BOTTOM)' }));
    expect(repeated.components.map(c => [c.ref, c.value, c.side])).toEqual([['R1', '10k', 'top']]);
    expect(notes(repeated).some(message => /^1 device record repeats a reference that is already declared/.test(message))).toBe(true);
    expect(thrown(doc({ devices: '(R VAL=1 L=TOP)' })).message).toMatch(/has no REF/);
    expect(thrown(doc({ nets: '' })).message).toMatch(/no components were found/);
  });
});

describe('HyperLynx: board outline', () => {
  it('stitches perimeter segments in any order and direction, and reports cutouts', () => {
    const outer = SQUARE(0, 0, 4, 3).split('\n'), inner = SQUARE(1, 1, 2, 2).split('\n');
    const board = parse(doc({ board: [outer[2], inner[1], outer[0], inner[3], outer[3], inner[0], outer[1], inner[2]].join('\n') }));
    expect(board.outline).toHaveLength(4); near(board.bounds.maxX, inch(4));
    expect(warningKeys(board)).toContain('parse.warning.boardCutouts');
  });
  it('draws a PERIMETER_ARC clockwise from end 1 to end 2 around its centre, and closes a rounded corner', () => {
    // A 2 x 2 square whose top-right corner is a quarter circle of radius 1 about (1,1): clockwise from (1,2) to (2,1).
    const board = parse(doc({ board: ['(PERIMETER_SEGMENT X1=0 Y1=0 X2=2 Y2=0)', '(PERIMETER_SEGMENT X1=2 Y1=0 X2=2 Y2=1)', '(PERIMETER_ARC X1=1 Y1=2 X2=2 Y2=1 XC=1 YC=1 R=1)', '(PERIMETER_SEGMENT X1=1 Y1=2 X2=0 Y2=2)', '(PERIMETER_SEGMENT X1=0 Y1=2 X2=0 Y2=0)'].join('\n') }));
    expect(board.outline.length).toBeGreaterThan(10);
    near(board.bounds.maxX, inch(2)); near(board.bounds.maxY, inch(2));
    // The sampled arc bulges outwards: a counter-clockwise reading would cut the corner inwards through (1.29, 1.29).
    expect(board.outline.some(p => Math.hypot(p.x - inch(1), p.y - inch(1)) > inch(0.99) && p.x > inch(1.6) && p.y > inch(1.6))).toBe(true);
    expect(notes(board)).toContain('1 HyperLynx perimeter arc was approximated by straight segments.');
  });
  it('draws a full circle when an arc starts and ends at the same point', () => {
    const board = parse(doc({ board: '(PERIMETER_ARC X1=1 Y1=0 X2=1 Y2=0 XC=0 YC=0 R=1)' }));
    near(board.bounds.minX, inch(-1)); near(board.bounds.maxY, inch(1));
  });
  it('shows an estimated boundary when the perimeter is open or missing', () => {
    const open = parse(doc({ board: '(PERIMETER_SEGMENT X1=0 Y1=0 X2=2 Y2=0)\n(PERIMETER_SEGMENT X1=2 Y1=0 X2=2 Y2=1)' }));
    expect(warningKeys(open)).toContain('parse.warning.missingBoardOutline');
    expect(notes(open).some(message => /do not form a closed contour/.test(message))).toBe(true);
    const none = parse(doc({ board: '' }));
    expect(warningKeys(none)).toContain('parse.warning.missingBoardOutline');
  });
  it('rejects a perimeter record without coordinates', () => {
    expect(thrown(doc({ board: '(PERIMETER_SEGMENT X1=0 Y1=0 X2=2)' })).message).toMatch(/missing perimeter Y2/);
  });
});

describe('HyperLynx: recognition', () => {
  it('scores a real header high and everything else zero', () => {
    expect(sniffHyperlynxText('{VERSION=2.0}\n{UNITS=ENGLISH LENGTH}\n{BOARD\n').confidence).toBeGreaterThanOrEqual(0.8);
    expect(sniffHyperlynxText('{VERSION=2.14}\n{UNITS=METRIC WEIGHT}\n{DEVICES\n{NET=A\n').confidence).toBeGreaterThanOrEqual(0.95);
    expect(sniffHyperlynxText('* a comment\n\n  {VERSION=2.0}\r\n{UNITS=ENGLISH LENGTH}').confidence).toBeGreaterThanOrEqual(0.8);
    expect(sniffHyperlynxText('{VERSION=2.0}\n').confidence).toBeLessThan(0.8);
    expect(sniffHyperlynxText('{VERSION').confidence).toBeLessThan(0.8);
    for (const text of ['', '   ', 'VERSION', '$HEADER\nGENCAD 1.4', '(kicad_pcb (version 20240108))', '<?xml version="1.0"?>', '{"json":1}', '{FOO=1}\n{UNITS=ENGLISH LENGTH}', '(PIN X=1)', 'A!REFDES!COMP_CLASS!\n']) {
      expect(sniffHyperlynxText(text).confidence, text).toBe(0);
    }
  });
  it('sniffs bytes, ignores binary data and tiny inputs', () => {
    expect(sniffHyperlynx(bytes(doc())).confidence).toBeGreaterThanOrEqual(0.9);
    expect(sniffHyperlynx(Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes(doc())])).confidence).toBeGreaterThanOrEqual(0.9);
    expect(sniffHyperlynx(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).confidence).toBe(0);
    expect(sniffHyperlynx(bytes('{VER')).confidence).toBe(0);
    expect(sniffHyperlynx(bytes(`{VERSION=2.0}\n{UNITS=ENGLISH LENGTH}\n${' '.repeat(2000)}\0`)).confidence).toBeGreaterThan(0); // a NUL after the first KiB does not matter
    expect(sniffHyperlynx(Uint8Array.from([...bytes('{VERSION=2.0}\n{UNITS=ENGLISH LENGTH}\n'), 0, 0, 0])).confidence).toBe(0);
  });
  it('returns null for other formats and claims a weak header only through the .hyp extension', () => {
    for (const text of ['', '$HEADER\nGENCAD 1.4\n', '(kicad_pcb (version 20240108))', '<eagle version="9"/>', 'A!REFDES!COMP_CLASS!\nJ!MILS!\n']) {
      expect(parseHyperlynx(textInput(text, 'board.hyp')), JSON.stringify(text)).toBeNull();
    }
    expect(parseHyperlynx(textInput('{UNITS=ENGLISH LENGTH}\n{BOARD\n}\n', 'board.txt'))).toBeNull();
    expect(parseHyperlynx(textInput('{VERSION=2.0}\n', 'board.txt'))).toBeNull();
    expect(thrown('{VERSION=2.0}\n', 'board.hyp').message).toMatch(/\{END\}/);
    expect(thrown('{UNITS=ENGLISH LENGTH}\n{BOARD\n}\n', 'board.hyp').message).toMatch(/\{END\}/);
  });
});

describe('HyperLynx: malformed and truncated files', () => {
  it('reports a UTF-16 byte-order mark that is followed by invalid UTF-16 as undecodable text, like the other text adapters', () => {
    expect(() => parseHyperlynx({ name: 'broken.hyp', data: Uint8Array.from([0xff, 0xfe, 0x41]) })).toThrow(TextDecodeError);
    expect(() => parseHyperlynx({ name: 'broken.hyp', data: Uint8Array.from([0xfe, 0xff, 0xd8, 0x00, 0x00, 0x41]) })).toThrow(TextDecodeError);
  });
  it('requires {END}: a truncated file is an error, never a smaller board', () => {
    expect(thrown(doc({ end: false })).message).toMatch(/no \{END\} record/);
    const text = doc();
    for (let length = 0; length < text.length; length += 7) {
      const prefix = text.slice(0, length);
      let outcome: string;
      try { outcome = parseHyperlynx(textInput(prefix, 'board.hyp')) ? 'board' : 'null'; } catch (error) { if (!(error instanceof BoardFormatError)) throw error; outcome = 'error'; }
      expect(outcome === 'board', `prefix ${length}`).toBe(false);
    }
  });
  it('rejects an unclosed subrecord, ignores text after {END} and tolerates an unknown record', () => {
    expect(thrown(doc({ devices: '(R REF=R1 L=TOP' })).message).toMatch(/not closed/);
    const reference = parse(doc());
    expect(parse(doc() + 'garbage \u0000 ((((\n{NET=Z\n').pins).toEqual(reference.pins);
    expect(parse(doc().replace('{VERSION=2.0}\n', '{VERSION=2.0}\n{SOMETHING=1}\n{WEIRD\n(X 1 2)\n}\n')).pins).toEqual(reference.pins);
  });
  it('survives byte mutations of a valid file: a board, null or a BoardFormatError, nothing else', () => {
    const text = fixture('golden.hyp');
    let state = 0x2545f491;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
    let boards = 0, errors = 0;
    for (let round = 0; round < 400; round++) {
      const chars = [...text];
      for (let edit = 0; edit < 1 + Math.floor(random() * 4); edit++) {
        const at = Math.floor(random() * chars.length), kind = Math.floor(random() * 4);
        if (kind === 0) chars.splice(at, 1);
        else if (kind === 1) chars.splice(at, 0, '(){}=",*\n .'[Math.floor(random() * 11)]);
        else if (kind === 2) chars[at] = String.fromCharCode(32 + Math.floor(random() * 95));
        else chars.splice(at, Math.floor(random() * 40));
      }
      try { if (parseHyperlynx(textInput(chars.join(''), 'fuzz.hyp'))) boards++; } catch (error) { if (!(error instanceof BoardFormatError)) throw error; errors++; }
    }
    expect(boards).toBeGreaterThan(0); expect(errors).toBeGreaterThan(0);
  });
});

describe('HyperLynx: limits and linear time', () => {
  /** The three sizes of a scaling check: a sixteenth, a quarter and all of the size the old budgets were set for. */
  const steps = (full: number): number[] => [Math.floor(full / 16), Math.floor(full / 4), full];
  const deviceRows = (count: number) => Array.from({ length: count }, (_, i) => `(R REF=R${i} L=TOP)`).join('\n');
  const pinRows = (count: number) => Array.from({ length: count }, (_, i) => `(PIN X=${i} Y=1 R=R1.${i % 7} P=S)`).join('\n');
  it('rejects more than 250,000 devices', () => {
    expect(thrown(doc({ devices: deviceRows(250_001) })).code).toBe('LIMIT_EXCEEDED');
    // A quarter-sized valid board calibrates parser and allocation costs without expanding the full capacity.
    const refused = doc({ devices: deviceRows(250_001) }), accepted = doc({ devices: deviceRows(62_500) });
    expectCostAtMost('refusing 250,001 devices', catching(() => parse(refused)), () => parse(accepted), 12);
  });
  it('rejects more than 1,000,000 pins', () => {
    expect(thrown(doc({ nets: `{NET=N\n${pinRows(1_000_001)}\n}` })).code).toBe('LIMIT_EXCEEDED');
    const refused = doc({ nets: `{NET=N\n${pinRows(1_000_001)}\n}` }), accepted = doc({ nets: `{NET=N\n${pinRows(250_000)}\n}` });
    expectCostAtMost('refusing 1,000,001 pins', catching(() => parse(refused)), () => parse(accepted), 12);
  }, 300_000);
  it('reads a large valid board in linear time (200,000 pins)', () => {
    const boardOf = (refs: number) => {
      const devices = Array.from({ length: refs }, (_, i) => `(U REF=U${i} VAL=${i} L=${i % 2 ? 'TOP' : 'BOTTOM'})`).join('\n');
      const pins = Array.from({ length: refs * 10 }, (_, i) => `(PIN X=${(i % 500) / 10} Y=${Math.floor(i / 500) / 10} R=U${Math.floor(i / 10)}.${i % 10 + 1} P=S)`).join('\n');
      return doc({ devices, nets: `{NET=N1\n${pins}\n}` });
    };
    expectScaling('parts of a board', [1250, 5000, 20_000], refs => { const text = boardOf(refs); return () => parse(text); });
    const refs = 20_000, value = parse(boardOf(refs));
    expect(value.components).toHaveLength(refs); expect(value.pins).toHaveLength(refs * 10);
  }, 300_000);
  it('handles hostile single lines in linear time: blanks, parentheses, quotes, braces and long tokens', () => {
    const head = '{VERSION=2.0}\n{UNITS=ENGLISH LENGTH}\n{BOARD\n}\n';
    // Each case is built from a count of units; its full count is the size the old budget was set for.
    const cases: Array<[string, (count: number) => string, number]> = [
      ['blank flood', count => ' '.repeat(count), 5_000_000],
      ['open parens', count => '('.repeat(count), 2_000_000],
      ['quote flood', count => '(? REF="' + '""'.repeat(count) + '")', 1_000_000],
      ['open braces', count => '{'.repeat(count), 2_000_000],
      ['close braces', count => '}'.repeat(count), 2_000_000],
      ['digit run', count => '(PIN X=' + '1'.repeat(count) + ' Y=1 R=R1.1)', 3_000_000],
      ['key flood', count => '(? ' + 'A=1 '.repeat(count) + ')', 500_000],
      ['equals flood', count => '(? ' + '='.repeat(count) + ')', 2_000_000],
      ['word flood', count => '(? REF=R1 NAME=' + 'w '.repeat(count) + ')', 1_000_000],
      ['dot flood', count => '(PIN X=1 Y=1 R=' + '.'.repeat(count) + ')', 5000],
      ['comma flood', count => '(' + ','.repeat(count) + ')', 2_000_000],
    ];
    const fileOf = (body: string) => `${head}{DEVICES\n${body}\n}\n{END}\n`;
    // Ascending sizes: a pattern that retries every position of a run is quadratic and fails at the first pair.
    for (const [label, body, full] of cases) {
      expectScaling(label, steps(full), count => { const input = textInput(fileOf(body(count)), 'hostile.hyp'); return catching(() => parseHyperlynx(input)); });
    }
    // Whatever the line holds, the reader refuses with its own error and never with another one.
    for (const [label, body, full] of cases) {
      try { parseHyperlynx(textInput(fileOf(body(full)), 'hostile.hyp')); } catch (error) { expect(error, label).toBeInstanceOf(BoardFormatError); }
    }
  }, 300_000);
  it('handles millions of short records and blank lines in linear time', () => {
    expectScaling('blank lines', steps(3_000_000), count => { const text = `{VERSION=2.0}\n{UNITS=ENGLISH LENGTH}${'\n'.repeat(count)}`; return catching(() => parse(text)); });
    const segmentsOf = (count: number) => doc({ nets: `{NET=N1\n(PIN X=1 Y=1 R=R1.1 P=S)\n${'(SEG X1=0 Y1=0 X2=1 Y2=1 W=1 L=TOP)\n'.repeat(count)}}\n` });
    expectScaling('trace records', steps(500_000), count => { const text = segmentsOf(count); return () => parse(text); });
    expect(thrown(`{VERSION=2.0}\n{UNITS=ENGLISH LENGTH}${'\n'.repeat(3_000_000)}`)).toBeInstanceOf(BoardFormatError);
    expect(notes(parse(segmentsOf(500_000))).some(message => /500000 trace records/.test(message))).toBe(true);
  }, 300_000);
});
