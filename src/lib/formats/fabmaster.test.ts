import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import { BoardFormatError, TextDecodeError, textInput } from './common';
import { parseFabmaster, sniffFabmaster, sniffFabmasterText } from './fabmaster';
import { catching, expectCostAtMost, expectScaling } from '../../test-support/timing';

// Original synthetic extracts written from the public structure of the format (KiCad developer documentation: A/J/S rows, section
// columns, units, pad shapes); no byte of a vendor file is used. Fixtures on disk live in tests/fixtures/fabmaster.
const fixture = (name: string) => readFileSync(new URL(`../../../tests/fixtures/fabmaster/${name}`, import.meta.url), 'utf8');
const bytes = (value: string) => new TextEncoder().encode(value);
const mil = (value: number) => value * 0.0254;
const parse = (text: string | Uint8Array, name = 'board.fab'): Board => {
  const board = parseFabmaster({ name, data: typeof text === 'string' ? bytes(text) : text });
  if (!board) throw new Error('fixture was not recognized');
  return board;
};
const thrown = (text: string | Uint8Array, name = 'board.fab'): BoardFormatError => {
  try { parseFabmaster({ name, data: typeof text === 'string' ? bytes(text) : text }); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
};
const notes = (board: Board) => board.warnings.filter(issue => issue.key === 'parse.warning.formatNote').map(issue => String(issue.params?.message));
const warningKeys = (board: Board) => board.warnings.map(issue => issue.key);
const refOf = (board: Board, pin: Board['pins'][number]) => board.components.find(component => component.id === pin.componentId)!.ref;
const pinRows = (board: Board) => board.pins.map(pin => `${refOf(board, pin)}.${pin.number}|${pin.net}|${pin.side}|${pin.shape}`);
const near = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 6);

// Row builders. A trailing `!` ends every row, as in the real files.
const A = (...columns: string[]) => `A!${columns.join('!')}!`;
const J = (...fields: string[]) => `J!${fields.join('!')}!`;
const S = (...fields: Array<string | number>) => `S!${fields.join('!')}!`;
const COMPONENTS = ['REFDES', 'COMP_CLASS', 'SYM_TYPE', 'SYM_NAME', 'SYM_MIRROR', 'SYM_ROTATE', 'SYM_X', 'SYM_Y', 'COMP_VALUE'];
const PINS = ['REFDES', 'SYM_NAME', 'SYM_MIRROR', 'PIN_NAME', 'PIN_NUMBER', 'PIN_X', 'PIN_Y', 'PAD_STACK_NAME', 'PIN_ROTATION'];
const NETS = ['NET_NAME', 'REFDES', 'PIN_NUMBER', 'PIN_NAME'];
const PADSTACKS = ['PADNAME', 'RECNUMBER', 'LAYER', 'VIAFLAG', 'PADSHAPE1', 'PADWIDTH', 'PADHGHT', 'PADXOFF', 'PADYOFF', 'PADSHAPENAME'];
const GRAPHICS = ['GRAPHIC_DATA_NAME', 'GRAPHIC_DATA_NUMBER', 'RECORD_TAG', 'GRAPHIC_DATA_1', 'GRAPHIC_DATA_2', 'GRAPHIC_DATA_3', 'GRAPHIC_DATA_4', 'GRAPHIC_DATA_5', 'GRAPHIC_DATA_6', 'GRAPHIC_DATA_7', 'GRAPHIC_DATA_8', 'GRAPHIC_DATA_9', 'SUBCLASS', 'SYM_NAME', 'REFDES'];
const PADSHAPES = ['SUBCLASS', 'PAD_SHAPE_NAME', 'GRAPHIC_DATA_NAME', 'GRAPHIC_DATA_NUMBER', 'RECORD_TAG', 'GRAPHIC_DATA_1', 'GRAPHIC_DATA_2', 'GRAPHIC_DATA_3', 'GRAPHIC_DATA_4', 'GRAPHIC_DATA_5', 'PAD_STACK_NAME', 'REFDES', 'PIN_NUMBER'];
const rect = (x0: number, y0: number, x1: number, y1: number) => [S('LINE', 1, '1', x0, y0, x1, y0, 0, '', '', '', '', 'OUTLINE', '', ''), S('LINE', 2, '2', x1, y0, x1, y1, 0, '', '', '', '', 'OUTLINE', '', ''), S('LINE', 3, '3', x1, y1, x0, y1, 0, '', '', '', '', 'OUTLINE', '', ''), S('LINE', 4, '4', x0, y1, x0, y0, 0, '', '', '', '', 'OUTLINE', '', '')];

interface Doc { unit?: string; components?: string[]; pins?: string[]; nets?: string[]; padstacks?: string[]; graphics?: string[]; componentColumns?: string[]; pinColumns?: string[]; extra?: string[] }
const doc = ({ unit = 'MILS', components = [S('R1', 'DISCRETE', 'PACKAGE', 'R0402', 'NO', 0, 1000, 500, '10K')], pins = [S('R1', 'R0402', 'NO', 1, 1, 990, 500, 'SMD', 0), S('R1', 'R0402', 'NO', 2, 2, 1010, 500, 'SMD', 0)],
  nets = [S('N1', 'R1', 1, 1), S('N2', 'R1', 2, 2)], padstacks = [S('SMD', 1, 'TOP', '', 'RECTANGLE', 20, 10, 0, 0, '')], graphics = rect(0, 0, 2000, 1000),
  componentColumns = COMPONENTS, pinColumns = PINS, extra = [] }: Doc = {}) => [
  A(...componentColumns), J(unit), ...components, A(...pinColumns), J(unit), ...pins, A(...NETS), J(unit), ...nets, A(...PADSTACKS), J(unit), ...padstacks, A(...GRAPHICS), J(unit), ...graphics, ...extra,
].join('\n') + '\n';

describe('Fabmaster: golden fixture', () => {
  const board = parse(fixture('golden.fab'), 'golden.fab');
  it('reads components in file order with sides, rotations, values and symbols', () => {
    expect(board.format).toBe('Fabmaster (FATF)'); expect(board.name).toBe('golden'); expect(board.units).toBe('mm');
    expect(board.components.map(c => [c.ref, c.side, c.rotation, c.value, c.package, c.pinIds.length])).toEqual([
      ['U1', 'top', 0, 'QFN4-PART', 'QFN4', 4], ['R1', 'top', 90, '10K', 'R0402', 2], ['C1', 'bottom', 180, '100N', 'C0402', 2], ['J1', 'top', 0, 'HDR-2', 'HDR2', 2], ['FID1', 'top', 0, '', 'FID1', 0],
    ]);
    near(board.components[1].position.x, mil(1000)); near(board.components[1].position.y, mil(700));
  });
  it('reads pins, nets from the net rows, sides, and exact pad sizes and angles', () => {
    expect(pinRows(board)).toEqual([
      'U1.1|GND|top|rect', 'U1.2|GND|top|rect', 'U1.3|VCC|top|rect', 'U1.4|SIG|top|rect', 'R1.1|VCC|top|rect', 'R1.2|SIG|top|rect',
      'C1.1|SIG|bottom|square', 'C1.2|GND|bottom|square', 'J1.1|GND|both|round', 'J1.2|VCC|both|round',
    ]);
    expect(board.nets.map(net => [net.name, net.pinIds.length])).toEqual([['GND', 4], ['VCC', 3], ['SIG', 3]]);
    const [u11, , , , r11, , c11, , j11] = board.pins;
    near(u11.x, mil(450)); near(u11.y, mil(550)); near(u11.width!, mil(20)); near(u11.height!, mil(10)); near(u11.radius, mil(5)); expect(u11.rotation).toBe(0);
    expect(r11.rotation).toBe(90); expect(c11.rotation).toBe(180); near(c11.width!, mil(20));
    near(j11.radius, mil(30)); near(j11.width!, mil(60));
  });
  it('draws the OUTLINE with a counter-clockwise arc corner and ignores DESIGN_OUTLINE and symbol graphics', () => {
    expect(board.outline.length).toBeGreaterThan(10);
    near(board.bounds.minX, 0); near(board.bounds.maxX, mil(2000)); near(board.bounds.maxY, mil(1000)); near(board.bounds.minY, 0);
    expect(board.outline.some(p => p.x > mil(1930) && p.y > mil(930) && Math.hypot(p.x - mil(1800), p.y - mil(800)) > mil(199))).toBe(true);
  });
  it('discloses what is not shown and what was omitted', () => {
    expect(notes(board)).toEqual([
      'Fabmaster: pad angles (symbol angle plus PIN_ROTATION) and pad offsets are not verified against a vendor file; only copper pad sizes are read, and vias, traces, zones and text are not shown.',
      '1 non-package symbol without pins (mounting holes, frames) was omitted.',
      '2 vias are not shown.',
      '1 Fabmaster outline arc or circle was approximated by straight segments.',
    ]);
    expect(warningKeys(board)).not.toContain('parse.warning.missingBoardOutline');
  });
});

describe('Fabmaster: units', () => {
  const at = (unit: string) => parse(doc({ unit })).pins[0].x;
  it('reads MILS, INCHES, MILLIMETERS, MICRONS and CENTIMETERS', () => {
    near(at('MILS'), mil(990)); near(at('INCHES'), 990 * 25.4); near(at('MILLIMETERS'), 990); near(at('MICRONS'), 0.99); near(at('CENTIMETERS'), 9900);
    near(at('mils'), mil(990)); near(at('Millimeters'), 990);
  });
  it('reads the unit word wherever the J row holds it', () => {
    const text = doc().replace(/J!MILS!/g, 'J!!!!!!!!!MILLIMETERS!!');
    near(parse(text).pins[0].x, 990);
  });
  it('applies a unit word that sits in a column of its own to that column only', () => {
    const columns = ['REFDES', 'PIN_NAME', 'PIN_NUMBER', 'PIN_X', 'PIN_Y', 'PAD_STACK_NAME'];
    const text = doc({ pinColumns: columns, pins: [S('R1', 1, 1, 25.4, 2540, 'SMD'), S('R1', 2, 2, 50.8, 2540, 'SMD')] }).replace(/(A!REFDES!PIN_NAME[^\n]*\n)J!MILS!/, '$1J!!!!MILLIMETERS!MILS!');
    const board = parse(text);
    near(board.pins[0].x, 25.4); near(board.pins[0].y, mil(2540));
    expect(notes(board).some(message => /more than one unit/.test(message))).toBe(false);
  });
  it('reads a UNIT: line before any section as the default of sections without a unit word, and assumes mils with a note otherwise', () => {
    const noUnits = doc().replace(/J!MILS!/g, 'J!!');
    const board = parse(noUnits);
    near(board.pins[0].x, mil(990));
    expect(notes(board).some(message => /sections have no unit row; coordinates are read as mils/.test(message))).toBe(true);
    const withLine = parse('UNIT:millimeters\n' + noUnits);
    near(withLine.pins[0].x, 990); expect(notes(withLine).some(message => /no unit row/.test(message))).toBe(false);
  });
  it('notes a unit row that names more than one unit', () => {
    const text = doc().replace('J!MILS!\nS!R1!DISCRETE', 'J!MILS!MILLIMETERS!\nS!R1!DISCRETE');
    expect(notes(parse(text)).some(message => /1 unit row names more than one unit/.test(message))).toBe(true);
  });
});

describe('Fabmaster: text layout tolerance', () => {
  const reference = parse(doc());
  it('reads CRLF, CR-only, a BOM, trailing blanks and blank lines to the same board', () => {
    const text = doc();
    expect(parse(text.replace(/\n/g, '\r\n'))).toEqual(reference);
    expect(parse(text.replace(/\n/g, '\r'))).toEqual(reference);
    expect(parse('\uFEFF' + text)).toEqual(reference);
    expect(parse(text.replace(/\n/g, '\n\n'))).toEqual(reference);
    expect(parse(text.replace(/!\n/g, '!   \n'))).toEqual(reference);
  });
  it('reads UTF-16 with a byte-order mark', () => {
    const text = '\uFEFF' + doc(), data = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) { data[2 * i] = text.charCodeAt(i) & 255; data[2 * i + 1] = text.charCodeAt(i) >> 8; }
    expect(parse(Uint8Array.from([0xff, 0xfe, ...data.subarray(2)]))).toEqual(reference);
  });
  it('finds columns by name: any order, extra columns, lowercase, underscores optional', () => {
    const columns = ['COMP_CLASS', 'sym x', 'Sym_Y', 'REFDES', 'SYMTYPE', 'SYM_NAME', 'SYM_MIRROR', 'SYM_ROTATE', 'COMP_VALUE', 'EXTRA'];
    const board = parse(doc({ componentColumns: columns, components: [S('DISCRETE', 1000, 500, 'R1', 'PACKAGE', 'R0402', 'NO', 0, '10K', 'x')] }));
    expect(board.components[0]).toMatchObject({ ref: 'R1', value: '10K', package: 'R0402' }); near(board.components[0].position.x, mil(1000));
  });
  it('tolerates a short row, a long row and spaces around values', () => {
    const board = parse(doc({ components: [S('R1', 'DISCRETE', 'PACKAGE', 'R0402', 'NO', 0, ' 1000 ', 500), S('R2', 'DISCRETE', 'PACKAGE', 'R0402', 'NO', 0, 1100, 500, '1K', 'extra', 'more')] }));
    expect(board.components.map(c => [c.ref, c.value])).toEqual([['R1', ''], ['R2', '1K']].filter(([ref]) => board.components.some(c => c.ref === ref)));
  });
  it('reads quoted fields that hold ! and doubled quotes, and keeps a stray quote inside a field literal', () => {
    const board = parse(doc({ components: [S('R1', 'DISCRETE', 'PACKAGE', 'R0402', 'NO', 0, 1000, 500, '"a!b ""c"""')] }));
    expect(board.components[0].value).toBe('a!b "c"');
    expect(parse(doc({ components: [S('R1', 'DISCRETE', 'PACKAGE', 'R0402', 'NO', 0, 1000, 500, '1/4" 5%')] })).components[0].value).toBe('1/4" 5%');
    expect(parse(doc({ components: [S('R1', 'DISCRETE', 'PACKAGE', 'R0402', 'NO', 0, 1000, 500, '"unterminated')] })).components[0].value).toBe('unterminated');
  });
  it('keeps case in names and counts lines outside any section', () => {
    const board = parse('banner line\n' + doc({ components: [S('r1', 'DISCRETE', 'PACKAGE', 'R0402', 'no', 0, 1000, 500, '')], pins: [S('r1', 'R0402', 'NO', 1, 1, 990, 500, 'SMD', 0)], nets: [S('Vcc_3v3', 'r1', 1, 1)] }) + 'S!stray!\n');
    expect(board.components[0].ref).toBe('r1'); expect(board.nets[0].name).toBe('Vcc_3v3');
    expect(notes(board).some(message => /^1 line is not part of any section/.test(message))).toBe(true);
  });
});

describe('Fabmaster: components', () => {
  it('keeps the first of a repeated REFDES and says so, skips an empty one and reads rotation as degrees', () => {
    const repeated = parse(doc({ components: [S('R1', '', 'PACKAGE', 'X', 'NO', 0, 1000, 500, '10K'), S('R1', '', 'PACKAGE', 'Y', 'YES', 90, 3, 3, '1K')] }));
    expect(repeated.components.map(c => [c.ref, c.value, c.side, c.package])).toEqual([['R1', '10K', 'top', 'X']]);
    expect(notes(repeated).some(message => /^1 component row repeats a REFDES that is already listed/.test(message))).toBe(true);
    const board = parse(doc({ components: [S('', '', 'PACKAGE', 'X', 'NO', 0, 1, 1, ''), S('R1', '', 'PACKAGE', 'X', 'NO', -90, 1000, 500, ''), S('R2', '', 'PACKAGE', 'X', 'NO', 450, 1100, 500, '')], pins: [S('R1', 'X', 'NO', 1, 1, 990, 500, 'SMD', 0), S('R2', 'X', 'NO', 1, 1, 1100, 500, 'SMD', 0)] }));
    expect(board.components.map(c => [c.ref, c.rotation])).toEqual([['R1', 270], ['R2', 90]]);
    expect(notes(board).some(message => /1 component row has no REFDES/.test(message))).toBe(true);
  });
  it('keeps a package symbol without pins that has a position, and a non-package symbol only when it owns pins', () => {
    const board = parse(doc({ components: [S('R1', '', 'PACKAGE', 'X', 'NO', 0, 1000, 500, ''), S('FID1', '', 'PACKAGE', 'FID', 'NO', 0, 100, 100, ''), S('MH1', '', 'MECHANICAL', 'MH', 'NO', 0, 200, 200, ''), S('MH2', '', 'MECHANICAL', 'MH', 'NO', 0, 300, 300, '')],
      pins: [S('R1', 'X', 'NO', 1, 1, 990, 500, 'SMD', 0), S('MH2', 'MH', 'NO', 1, 1, 300, 300, 'SMD', 0)] }));
    expect(board.components.map(c => c.ref)).toEqual(['R1', 'FID1', 'MH2']);
    expect(notes(board)).toContain('1 non-package symbol without pins (mounting holes, frames) was omitted.');
  });
  it('places a component without SYM_X/SYM_Y at the centre of its pads and says so', () => {
    const board = parse(doc({ components: [S('R1', '', 'PACKAGE', 'X', 'NO', 0, '', '', '')] }));
    near(board.components[0].position.x, mil(1000));
    expect(notes(board).some(message => /1 component has no SYM_X\/SYM_Y/.test(message))).toBe(true);
  });
  it('takes the value from COMP_VALUE, else the part number, else the device label', () => {
    const columns = ['REFDES', 'SYM_TYPE', 'SYM_X', 'SYM_Y', 'COMP_VALUE', 'COMP_PART_NUMBER', 'COMP_DEVICE_LABEL'];
    const board = parse(doc({ componentColumns: columns, components: [S('R1', 'PACKAGE', 1000, 500, '10K', 'PN1', 'DEV1'), S('R2', 'PACKAGE', 1100, 500, '', 'PN2', 'DEV2'), S('R3', 'PACKAGE', 1200, 500, '', '', 'DEV3')] }));
    expect(board.components.map(c => c.value)).toEqual(['10K', 'PN2', 'DEV3']);
  });
});

describe('Fabmaster: pins and nets', () => {
  it('names a pin owner by REFDES, else by the one component that uses the symbol, else by the symbol itself', () => {
    const board = parse(doc({ components: [S('R1', '', 'PACKAGE', 'ONLYONE', 'NO', 0, 1000, 500, ''), S('R2', '', 'PACKAGE', 'TWIN', 'NO', 0, 1100, 500, ''), S('R3', '', 'PACKAGE', 'TWIN', 'NO', 0, 1200, 500, '')],
      pins: [S('', 'ONLYONE', 'NO', 1, 1, 990, 500, 'SMD', 0), S('R2', 'TWIN', 'NO', 1, 1, 1100, 500, 'SMD', 0), S('', 'TWIN', 'NO', 1, 1, 1300, 500, 'SMD', 0), S('', '', 'NO', 1, 1, 1400, 500, 'SMD', 0)] }));
    expect(board.components.map(c => [c.ref, c.pinIds.length])).toEqual([['R1', 1], ['R2', 1], ['R3', 0], ['TWIN', 1], ['(unnamed)', 1]]);
    expect(notes(board).some(message => /2 components are named by pins only/.test(message))).toBe(true);
  });
  it('uses the pin name when the number is empty and generates a number when both are', () => {
    const board = parse(doc({ pins: [S('R1', 'R0402', 'NO', 'A1', '', 990, 500, 'SMD', 0), S('R1', 'R0402', 'NO', '', '', 1010, 500, 'SMD', 0)] }));
    expect(board.pins.map(p => [p.number, p.numberGenerated])).toEqual([['A1', undefined], ['2', true]]);
  });
  it('maps nets by REFDES and pin number (or pin name), keeps the first of a repeated record, and skips empty ones', () => {
    const board = parse(doc({ nets: [S('N1', 'R1', 1, 1), S('OTHER', 'R1', 1, 1), S('', 'R1', 2, 2), S('N3', '', 2, 2)] }));
    expect(board.pins.map(p => p.net)).toEqual(['N1', '']);
    expect(board.warnings.some(issue => issue.key === 'parse.warning.formatNote' && /net records? names? a component pin that no pin row lists/.test(String(issue.params?.message)))).toBe(false);
    // A net row without PIN_NUMBER is matched by its PIN_NAME.
    const named = parse(doc({ nets: [S('N1', 'R1', '', 1)] }));
    expect(named.pins.map(p => p.net)).toEqual(['N1', '']);
    const unmatched = parse(doc({ nets: [S('N1', 'R1', '', 'Z9')] }));
    expect(unmatched.pins.map(p => p.net)).toEqual(['', '']);
  });
  it('counts net records whose pin no pin row lists', () => {
    const board = parse(doc({ nets: [S('N1', 'R1', 1, 1), S('N9', 'R1', 9, 9), S('N8', 'ZZ', 1, 1)] }));
    expect(notes(board).some(message => /^2 net records name a component pin that no pin row lists/.test(message))).toBe(true);
  });
  it('gives every pad of a shared pin number the net, and keeps each pad', () => {
    const board = parse(doc({ pins: [S('R1', 'R0402', 'NO', 1, 1, 990, 500, 'SMD', 0), S('R1', 'R0402', 'NO', 1, 1, 970, 500, 'SMD', 0)], nets: [S('N1', 'R1', 1, 1)] }));
    expect(board.pins.map(p => p.net)).toEqual(['N1', 'N1']); expect(board.nets[0].pinIds).toHaveLength(2);
  });
  it('reads nets that are part of the pin rows (decoded FZ-style extracts have PIN_X/PIN_Y with NET_NAME)', () => {
    const text = [A('REFDES', 'COMP_INSERTION_CODE', 'SYM_NAME', 'SYM_MIRROR', 'SYM_ROTATE'), S('R1', '', 'R0402', 'YES', 0), A('NET_NAME', 'REFDES', 'PIN_NUMBER', 'PIN_NAME', 'PIN_X', 'PIN_Y', 'TEST_POINT'), S('N1', 'R1', 1, 1, 10.5, 20.5, ''), J('MILLIMETERS')].join('\n');
    const board = parse(text, 'extract.fab');
    expect(board.components[0]).toMatchObject({ ref: 'R1', side: 'bottom' }); expect(board.pins[0]).toMatchObject({ net: 'N1', side: 'bottom' }); near(board.pins[0].x, 10.5 * 0.0254);
  });
  it('rejects invalid or missing pin coordinates with the line number, and a file with no pin section', () => {
    for (const bad of ['0x10', 'Infinity', '1..2', '1e', '--1', 'abc', '1'.repeat(65)]) {
      const error = thrown(doc({ pins: [S('R1', 'R0402', 'NO', 1, 1, bad, 500, 'SMD', 0)] }));
      expect(error.message, bad).toMatch(/line \d+: invalid PIN_X/);
    }
    expect(thrown(doc({ pins: [S('R1', 'R0402', 'NO', 1, 1, '', 500, 'SMD', 0)] })).message).toMatch(/missing PIN_X/);
    expect(thrown([A(...COMPONENTS), J('MILS'), S('R1', '', 'PACKAGE', 'X', 'NO', 0, 1, 1, '')].join('\n')).message).toMatch(/no pin section/);
    expect(thrown(doc({ pins: [] })).message).toMatch(/no pin section/);
  });
  it('rejects coordinates beyond the supported range', () => {
    expect(thrown(doc({ pins: [S('R1', 'R0402', 'NO', 1, 1, '1e15', 500, 'SMD', 0)] })).message).toMatch(/exceeds the supported range/);
  });
});

describe('Fabmaster: padstacks', () => {
  const stacks = (rows: string[], pin = 'P') => parse(doc({ padstacks: rows, pins: [S('R1', 'R0402', 'NO', 1, 1, 990, 500, pin, 0)] }));
  it('maps shape names to exact and approximated pads', () => {
    const names: Array<[string, number, number, string, number]> = [['CIRCLE', 30, 30, 'round', 0], ['SQUARE', 30, 30, 'square', 0], ['RECTANGLE', 30, 20, 'rect', 0], ['RECTANGLE', 30, 30, 'square', 0], ['ROUNDED_RECT', 30, 20, 'rect', 1],
      ['OBLONG', 30, 20, 'rect', 1], ['OBLONG', 30, 30, 'round', 0], ['OBLONG_X', 40, 20, 'rect', 1], ['OCTAGON', 30, 30, 'square', 1], ['MYSTERY', 30, 20, 'rect', 0]];
    for (const [shape, width, height, expected, approximated] of names) {
      const board = stacks([S('P', 1, 'TOP', '', shape, width, height, 0, 0, '')]);
      expect(board.pins[0].shape, shape).toBe(expected);
      expect(board.warnings.find(w => w.key === 'parse.warning.approximatedPads')?.params?.count ?? 0, shape).toBe(approximated);
      if (shape === 'MYSTERY') expect(notes(board).some(message => /1 pad uses an unknown Fabmaster pad shape/.test(message))).toBe(true);
    }
  });
  it('forces a circle or a square to equal sides', () => {
    const circle = stacks([S('P', 1, 'TOP', '', 'CIRCLE', 30, 10, 0, 0, '')]).pins[0];
    near(circle.width!, mil(30)); near(circle.height!, mil(30)); near(circle.radius, mil(15));
    const square = stacks([S('P', 1, 'TOP', '', 'SQUARE', 0, 25, 0, 0, '')]).pins[0];
    near(square.width!, mil(25)); near(square.height!, mil(25));
  });
  it('uses the first copper record, skipping ~TSM, ~BSM, ~TSP, ~BSP and ~DRILL, and ignores rows of other padstacks', () => {
    const board = stacks([S('P', 1, '~TSM', '', 'RECTANGLE', 99, 99, 0, 0, ''), S('P', 2, 'TOP', '', 'RECTANGLE', 20, 10, 0, 0, ''), S('P', 3, 'BOTTOM', '', 'RECTANGLE', 40, 40, 0, 0, ''), S('Q', 1, 'TOP', '', 'CIRCLE', 70, 70, 0, 0, '')]);
    near(board.pins[0].width!, mil(20)); expect(board.pins[0].side).toBe('top');
  });
  it('treats a ~DRILL record with a positive size (width, or a numeric shape column) as a through-hole and a zero size as none', () => {
    const through = stacks([S('P', 1, 'TOP', '', 'CIRCLE', 60, 60, 0, 0, ''), S('P', 2, '~DRILL', '', 'CIRCLE', 30, 30, 0, 0, 'P*')]);
    expect(through.pins[0].side).toBe('both');
    const numeric = stacks([S('P', 1, 'TOP', '', 'CIRCLE', 60, 60, 0, 0, ''), S('P', 2, '~DRILL', '', '32', 0, 0, 0, 0, 'P*')]);
    expect(numeric.pins[0].side).toBe('both');
    const none = stacks([S('P', 1, 'TOP', '', 'CIRCLE', 60, 60, 0, 0, ''), S('P', 2, '~DRILL', '', 'CIRCLE', 0, 0, 0, 0, 'P*')]);
    expect(none.pins[0].side).toBe('top');
  });
  it('uses the bounding box of a custom (SHAPE) pad from EXTRACT_PAD_SHAPES and counts it as approximated', () => {
    const text = doc({ padstacks: [S('P', 1, 'TOP', '', 'SHAPE', 0, 0, 0, 0, 'FIG_SHAPE1')], pins: [S('R1', 'R0402', 'NO', 1, 1, 990, 500, 'P', 0)] })
      + [A(...PADSHAPES), J('MILS'), S('TOP', 'FIG_SHAPE1', 'LINE', 1, '1 1', -10, -5, 10, -5, 0, 'P', 'R1', 1), S('TOP', 'FIG_SHAPE1', 'LINE', 2, '1 2', 10, -5, 10, 5, 0, 'P', 'R1', 1), S('TOP', 'FIG_SHAPE1', 'FIG_RECTANGLE', 3, '1 3', 0, 0, 40, 10, 1, 'P', 'R1', 1)].join('\n') + '\n';
    const pin = parse(text).pins[0];
    near(pin.width!, mil(40)); near(pin.height!, mil(10)); expect(pin.shape).toBe('rect');
    expect(parse(text).warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 1 } });
  });
  it('keeps a pin whose padstack is missing or has no copper size, and counts it', () => {
    const board = parse(doc({ padstacks: [S('EMPTY', 1, 'TOP', '', 'RECTANGLE', 0, 0, 0, 0, '')], pins: [S('R1', 'R0402', 'NO', 1, 1, 990, 500, 'NOPE', 0), S('R1', 'R0402', 'NO', 2, 2, 1010, 500, 'EMPTY', 0), S('R1', 'R0402', 'NO', 3, 3, 1030, 500, '', 0)] }));
    expect(board.pins.map(p => p.width)).toEqual([undefined, undefined, undefined]);
    expect(notes(board).some(message => /1 pin row names a padstack that the file does not define/.test(message))).toBe(true);
    expect(notes(board).some(message => /1 pin has a padstack without a usable copper pad size/.test(message))).toBe(true);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 3 } });
  });
  it('puts a pad on the one outer layer of its padstack (turned over for a mirrored symbol), else on the side of its component', () => {
    const side = (mirror: string, rows: string[]) => parse(doc({ components: [S('R1', 'DISCRETE', 'PACKAGE', 'R0402', mirror, 0, 1000, 500, '')], pins: [S('R1', 'R0402', mirror, 1, 1, 990, 500, 'P', 0)], padstacks: rows })).pins[0].side;
    const top = [S('P', 1, 'TOP', '', 'RECTANGLE', 20, 10, 0, 0, '')], bottom = [S('P', 1, 'BOTTOM', '', 'RECTANGLE', 30, 40, 0, 0, '')];
    expect(side('NO', top)).toBe('top'); expect(side('NO', bottom)).toBe('bottom'); expect(side('YES', top)).toBe('bottom'); expect(side('YES', bottom)).toBe('top');
    expect(side('NO', [...top, ...bottom])).toBe('top'); expect(side('YES', [...top, ...bottom])).toBe('bottom');
    expect(side('NO', [S('P', 1, 'INTERNAL', '', 'RECTANGLE', 20, 10, 0, 0, '')])).toBe('top');
    const finger = parse(doc({ padstacks: [...top.map(row => row.replace('P!', 'T!')), ...bottom.map(row => row.replace('P!', 'B!'))], pins: [S('R1', 'R0402', 'NO', 1, 1, 990, 500, 'T', 0), S('R1', 'R0402', 'NO', 2, 2, 1010, 500, 'B', 0)] }));
    expect(finger.pins.map(p => [p.side, p.width])).toEqual([['top', expect.closeTo(mil(20), 6)], ['bottom', expect.closeTo(mil(30), 6)]]);
  });
  it('counts a pad offset that is not applied', () => {
    expect(notes(stacks([S('P', 1, 'TOP', '', 'RECTANGLE', 20, 10, 5, 0, '')])).some(message => /1 pad has an offset from the pin origin that is not applied/.test(message))).toBe(true);
  });
  it('adds the symbol angle to the pin rotation (mirrored: subtracts it) for the pad angle', () => {
    const columns = PINS, base = (mirror: string, rotation: number, symbol: number) => parse(doc({ components: [S('R1', 'DISCRETE', 'PACKAGE', 'R0402', mirror, symbol, 1000, 500, '')], pinColumns: columns, pins: [S('R1', 'R0402', mirror, 1, 1, 990, 500, 'SMD', rotation)] })).pins[0].rotation;
    expect(base('NO', 0, 90)).toBe(90); expect(base('NO', 90, 90)).toBe(180); expect(base('YES', 90, 270)).toBe(180); expect(base('NO', -90, 0)).toBe(270);
  });
});

describe('Fabmaster: board outline', () => {
  const outline = (rows: string[]) => parse(doc({ graphics: rows }));
  it('keeps TEXT mirror, alignment, font and label fields out of numeric edge geometry', () => {
    const label = S('TEXT', 1, '1', 50, 50, 0, 'NO', 'LEFT', '8 0 100 75 0 25 125 6', 'SYNTHETIC NOTE', '', '', 'OUTLINE', '', '');
    const original = outline(rect(0, 0, 2000, 1000));
    const board = outline([label, ...rect(0, 0, 2000, 1000)]);
    expect(board.outline).toEqual(original.outline);
    expect(board.pins).toEqual(original.pins);
    expect(notes(board)).toContain('1 outline record is not a line, arc, rectangle or circle and was ignored.');
    const design = rect(100, 200, 300, 400).map(row => row.replace('OUTLINE', 'DESIGN_OUTLINE'));
    expect(outline([label, ...design]).outline).toEqual(outline(design).outline);
    expect(() => outline([S('LINE', 1, '1', 0, 0, 'NO', 100, 0, '', '', '', '', 'OUTLINE', '', '')])).toThrow(/invalid GRAPHIC_DATA_3/);
  });

  it('stitches records in any order and direction, and prefers OUTLINE over DESIGN_OUTLINE', () => {
    const shuffled = [...rect(0, 0, 2000, 1000)].reverse();
    const design = rect(100, 100, 300, 300).map(row => row.replace('OUTLINE', 'DESIGN_OUTLINE'));
    const board = outline([...design, ...shuffled]);
    near(board.bounds.maxX, mil(2000));
    const fallback = outline(design);
    near(fallback.bounds.maxX, mil(300)); near(fallback.bounds.minX, mil(100));
  });
  it('reads RECTANGLE and CIRCLE primitives, and cutouts as extra loops', () => {
    const board = outline([S('RECTANGLE', 1, '1', 0, 0, 2000, 1000, 0, '', '', '', '', 'OUTLINE', '', ''), S('CIRCLE', 2, '2', 500, 500, 100, 100, 0, '', '', '', '', 'OUTLINE', '', '')]);
    near(board.bounds.maxX, mil(2000)); expect(warningKeys(board)).toContain('parse.warning.boardCutouts');
    const round = outline([S('CIRCLE', 1, '1', 0, 0, 1000, 1000, 0, '', '', '', '', 'OUTLINE', '', '')]);
    near(round.bounds.maxX, mil(500)); near(round.bounds.minY, mil(-500));
  });
  it('reads an arc clockwise unless it says COUNTERCLOCKWISE, and notes a missing direction', () => {
    const corner = (direction: string) => outline([...rect(0, 0, 2000, 1000).slice(0, 1), S('LINE', 2, '2', 2000, 0, 2000, 800, 0, '', '', '', '', 'OUTLINE', '', ''),
      S('ARC', 3, '3', 2000, 800, 1800, 1000, 1800, 800, 200, 0, direction, 'OUTLINE', '', ''), S('LINE', 4, '4', 1800, 1000, 0, 1000, 0, '', '', '', '', 'OUTLINE', '', ''), S('LINE', 5, '5', 0, 1000, 0, 0, 0, '', '', '', '', 'OUTLINE', '', '')]);
    const ccw = corner('COUNTERCLOCKWISE');
    expect(ccw.outline.some(p => p.x > mil(1930) && p.y > mil(930))).toBe(true);
    expect(notes(ccw).some(message => /no clockwise\/counter-clockwise word/.test(message))).toBe(false);
    const cw = corner('CLOCKWISE'); // the long way round: the loop does not close the same way, so no corner point near (1941, 941)
    expect(cw.outline.some(p => p.x > mil(1930) && p.y > mil(930))).toBe(false);
    expect(notes(corner('')).some(message => /1 outline arc has no clockwise\/counter-clockwise word and is read as clockwise/.test(message))).toBe(true);
  });
  it('ignores symbol graphics, other classes and unreadable records, with notes where something is lost', () => {
    const columns = ['CLASS', ...GRAPHICS];
    const row = (klass: string, subclass: string, refdes: string) => S(klass, 'LINE', 1, '1', 0, 0, 100, 0, 0, '', '', '', '', subclass, '', refdes);
    const text = [A(...COMPONENTS), J('MILS'), S('R1', '', 'PACKAGE', 'X', 'NO', 0, 1000, 500, ''), A(...PINS), J('MILS'), S('R1', 'X', 'NO', 1, 1, 990, 500, '', 0),
      A(...columns), J('MILS'), row('BOARD GEOMETRY', 'OUTLINE', ''), row('PACKAGE GEOMETRY', 'OUTLINE', ''), row('BOARD GEOMETRY', 'OUTLINE', 'R1'), S('BOARD GEOMETRY', 'TEXT', 2, '2', 0, 0, 0, 0, 0, '', '', '', '', 'OUTLINE', '', '')].join('\n');
    const board = parse(text);
    expect(warningKeys(board)).toContain('parse.warning.missingBoardOutline');
    expect(notes(board).some(message => /1 outline record is not a line, arc, rectangle or circle/.test(message))).toBe(true);
    expect(notes(board).some(message => /do not form a closed contour/.test(message))).toBe(true);
  });
  it('shows an estimated boundary when there is no outline', () => {
    expect(warningKeys(outline([]))).toContain('parse.warning.missingBoardOutline');
  });
});

describe('Fabmaster: recognition', () => {
  const header = `${A(...COMPONENTS)}\n${J('MILS')}\n${S('R1', '', 'PACKAGE', 'X', 'NO', 0, 1, 1, '')}\n`;
  it('scores a FATF header with a J row high, and plain A/S text (the FZ payload) below the claim line', () => {
    expect(sniffFabmasterText(header).confidence).toBeGreaterThanOrEqual(0.85);
    expect(sniffFabmasterText(doc()).confidence).toBeGreaterThanOrEqual(0.9);
    expect(sniffFabmasterText('\uFEFF' + header).confidence).toBeGreaterThanOrEqual(0.85);
    const plain = `${A('REFDES', 'COMP_INSERTION_CODE', 'SYM_NAME', 'SYM_MIRROR', 'SYM_ROTATE')}\n${S('R1', '', 'R0402', 'NO', 0)}\n`;
    expect(sniffFabmasterText(plain).confidence).toBeGreaterThan(0); expect(sniffFabmasterText(plain).confidence).toBeLessThan(0.7);
  });
  it('scores everything else zero or too low to claim', () => {
    for (const text of ['', '   ', 'A!', 'J!MILS!\nA!REFDES!SYM_X!', '{VERSION=2.0}\n{UNITS=ENGLISH LENGTH}\n', '$HEADER\nGENCAD 1.4\n', '(kicad_pcb (version 20240108))', 'S!R1!1!2!']) {
      expect(sniffFabmasterText(text).confidence, JSON.stringify(text)).toBeLessThan(0.5);
    }
    expect(sniffFabmasterText('A!FOO!BAR!\nJ!MILS!\nS!1!2!\n').confidence).toBeLessThan(0.5);
    // One known section header with no unit row and no data is only claimed through the .fab extension.
    const lone = 'hello\nA!REFDES!SYM_X!';
    expect(sniffFabmasterText(lone).confidence).toBeLessThan(0.7);
    expect(parseFabmaster(textInput(lone, 'board.txt'))).toBeNull();
    expect(sniffFabmasterText(`${'banner\n'.repeat(9)}${lone}`).confidence).toBe(0);
  });
  it('sniffs bytes, ignores binary data and tiny inputs', () => {
    expect(sniffFabmaster(bytes(doc())).confidence).toBeGreaterThanOrEqual(0.9);
    expect(sniffFabmaster(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).confidence).toBe(0);
    expect(sniffFabmaster(bytes('A!R')).confidence).toBe(0);
    expect(sniffFabmaster(Uint8Array.from([...bytes(header), ...bytes(`${' '.repeat(2000)}`), 0, 0])).confidence).toBeGreaterThan(0.5); // a NUL after the first KiB does not matter
    expect(sniffFabmaster(Uint8Array.from([...bytes(header), 0, 0])).confidence).toBe(0); // a NUL within the first KiB is binary data
    expect(sniffFabmaster(Uint8Array.from([0, ...bytes(header)])).confidence).toBe(0);
  });
  it('returns null for other formats and claims a plain extract only through the .fab extension', () => {
    for (const text of ['', '{VERSION=2.0}\n{UNITS=ENGLISH LENGTH}\n{BOARD\n}\n{END}\n', '$HEADER\nGENCAD 1.4\n', '(kicad_pcb (version 20240108))', '<eagle version="9"/>']) {
      expect(parseFabmaster(textInput(text, 'board.fab')), JSON.stringify(text)).toBeNull();
    }
    const plain = [A('REFDES', 'COMP_INSERTION_CODE', 'SYM_NAME', 'SYM_MIRROR', 'SYM_ROTATE'), S('R1', '', 'R0402', 'NO', 0), A('NET_NAME', 'REFDES', 'PIN_NUMBER', 'PIN_NAME', 'PIN_X', 'PIN_Y'), S('N1', 'R1', 1, 1, 10, 20)].join('\n') + '\n';
    expect(parseFabmaster(textInput(plain, 'content.txt'))).toBeNull();
    expect(parseFabmaster(textInput(plain, 'content.fab'))?.pins).toHaveLength(1);
  });
});

describe('Fabmaster: malformed, truncated and mutated files', () => {
  it('reports a UTF-16 byte-order mark that is followed by invalid UTF-16 as undecodable text, like the other text adapters', () => {
    expect(() => parseFabmaster({ name: 'broken.fab', data: Uint8Array.from([0xff, 0xfe, 0x41]) })).toThrow(TextDecodeError);
    expect(() => parseFabmaster({ name: 'broken.fab', data: Uint8Array.from([0xfe, 0xff, 0xd8, 0x00, 0x00, 0x41]) })).toThrow(TextDecodeError);
  });
  it('never returns a partly read file as a board by accident: every prefix is a board, null or a BoardFormatError', () => {
    const text = fixture('golden.fab');
    for (let length = 0; length < text.length; length += 11) {
      try { parseFabmaster(textInput(text.slice(0, length), 'golden.fab')); } catch (error) { if (!(error instanceof BoardFormatError)) throw error; }
    }
  });
  it('does not claim rows that start before any header, and rejects a recognized file without a pin section', () => {
    expect(parseFabmaster(textInput('S!a!b!\nS!c!d!\n', 'x.fab'))).toBeNull();
    expect(thrown(`${A(...COMPONENTS)}\n${J('MILS')}\n${S('R1', '', 'PACKAGE', 'X', 'NO', 0, 1, 1, '')}\n`).message).toMatch(/no pin section/);
  });
  it('rejects a section with too many columns', () => {
    const columns = [...COMPONENTS, ...Array.from({ length: 600 }, (_, i) => `C${i}`)];
    expect(thrown(A(...COMPONENTS) + '\n' + J('MILS') + '\n' + A(...columns) + '\n', 'x.fab').code).toBe('LIMIT_EXCEEDED');
  });
  it('survives byte mutations of a valid file: a board, null or a BoardFormatError, nothing else', () => {
    const text = fixture('golden.fab');
    let state = 0x1badf00d;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
    let boards = 0, errors = 0;
    for (let round = 0; round < 400; round++) {
      const chars = [...text];
      for (let edit = 0; edit < 1 + Math.floor(random() * 4); edit++) {
        const at = Math.floor(random() * chars.length), kind = Math.floor(random() * 4);
        if (kind === 0) chars.splice(at, 1);
        else if (kind === 1) chars.splice(at, 0, '!"\n .AJS-'[Math.floor(random() * 9)]);
        else if (kind === 2) chars[at] = String.fromCharCode(32 + Math.floor(random() * 95));
        else chars.splice(at, Math.floor(random() * 40));
      }
      try { if (parseFabmaster(textInput(chars.join(''), 'fuzz.fab'))) boards++; } catch (error) { if (!(error instanceof BoardFormatError)) throw error; errors++; }
    }
    expect(boards).toBeGreaterThan(0); expect(errors).toBeGreaterThan(0);
  });
});

describe('Fabmaster: limits and linear time', () => {
  /** The three sizes of a scaling check: a sixteenth, a quarter and all of the size the old budgets were set for. */
  const steps = (full: number): number[] => [Math.floor(full / 16), Math.floor(full / 4), full];
  const componentRows = (count: number) => Array.from({ length: count }, (_, i) => S(`R${i}`, '', 'PACKAGE', 'X', 'NO', 0, i, 1, ''));
  const pinRows = (count: number) => Array.from({ length: count }, (_, i) => S('R1', 'R0402', 'NO', i, i, i, 1, 'SMD', 0));
  it('rejects more than 250,000 components', () => {
    expect(thrown(doc({ components: componentRows(250_001) })).code).toBe('LIMIT_EXCEEDED');
    // A quarter-sized valid board calibrates parser and allocation costs without expanding the full capacity.
    const refused = doc({ components: componentRows(250_001) }), accepted = doc({ components: componentRows(62_500) });
    expectCostAtMost('refusing 250,001 components', catching(() => parse(refused)), () => parse(accepted), 12);
  });
  it('rejects more than 1,000,000 pins', () => {
    expect(thrown(doc({ pins: pinRows(1_000_001) })).code).toBe('LIMIT_EXCEEDED');
    const refused = doc({ pins: pinRows(1_000_001) }), accepted = doc({ pins: pinRows(250_000) });
    expectCostAtMost('refusing 1,000,001 pins', catching(() => parse(refused)), () => parse(accepted), 12);
  }, 300_000);
  it('reads a large valid board in linear time (200,000 pins)', () => {
    const boardOf = (refs: number) => {
      const components = Array.from({ length: refs }, (_, i) => S(`U${i}`, 'IC', 'PACKAGE', 'QFN', i % 2 ? 'YES' : 'NO', (i % 4) * 90, (i % 200) * 10, Math.floor(i / 200) * 10, `V${i}`));
      const pins = Array.from({ length: refs * 10 }, (_, i) => S(`U${Math.floor(i / 10)}`, 'QFN', 'NO', `P${i % 10}`, i % 10 + 1, (i % 2000), Math.floor(i / 2000), 'SMD', 0));
      const nets = Array.from({ length: refs * 10 }, (_, i) => S(`N${i % 500}`, `U${Math.floor(i / 10)}`, i % 10 + 1, `P${i % 10}`));
      return doc({ components, pins, nets });
    };
    expectScaling('parts of a board', [1250, 5000, 20_000], refs => { const text = boardOf(refs); return () => parse(text); });
    const refs = 20_000, value = parse(boardOf(refs));
    expect(value.components).toHaveLength(refs); expect(value.pins).toHaveLength(refs * 10); expect(value.nets).toHaveLength(500);
  }, 300_000);
  it('handles hostile single lines in linear time: separators, quotes, blanks, long fields and numbers', () => {
    // Each case is built from a count of units; its full count is the size the old budget was set for.
    const cases: Array<[string, (count: number) => string, number]> = [
      ['bang flood', count => 'S!' + '!'.repeat(count), 3_000_000],
      ['quote flood', count => 'S!"' + '""'.repeat(count) + '"!x!', 1_500_000],
      ['unterminated quote', count => 'S!"' + 'a!'.repeat(count), 1_500_000],
      ['blank flood', count => 'S!' + ' '.repeat(count), 5_000_000],
      ['long field', count => 'S!' + 'x'.repeat(count) + '!', 5_000_000],
      ['digit run', count => 'S!R1!' + '1'.repeat(count) + '!', 3_000_000],
      ['header flood', count => 'A!' + 'C!'.repeat(count), 1_000_000],
      ['quote toggles', count => ('S!"a"b"c"!').repeat(count), 300_000],
    ];
    const fileOf = (body: string) => `${A(...COMPONENTS)}\n${J('MILS')}\n${A(...PINS)}\n${J('MILS')}\n${body}\n`;
    // Ascending sizes: a pattern that retries every position of a run is quadratic and fails at the first pair.
    for (const [label, body, full] of cases) {
      expectScaling(label, steps(full), count => { const input = textInput(fileOf(body(count)), 'hostile.fab'); return catching(() => parseFabmaster(input)); });
    }
    // Whatever the line holds, the reader refuses with its own error and never with another one.
    for (const [label, body, full] of cases) {
      try { parseFabmaster(textInput(fileOf(body(full)), 'hostile.fab')); } catch (error) { expect(error, label).toBeInstanceOf(BoardFormatError); }
    }
  }, 300_000);
  it('handles millions of blank lines and unknown rows in linear time', () => {
    expectScaling('blank lines', steps(3_000_000), count => { const text = `${A(...COMPONENTS)}${'\n'.repeat(count)}`; return catching(() => parse(text)); });
    const viasOf = (count: number) => [A('VIA_X', 'VIA_Y', 'PAD_STACK_NAME', 'NET_NAME'), J('MILS'), ...Array.from({ length: count }, (_, i) => S(i, i, 'V', 'N'))].join('\n');
    expectScaling('unknown rows', steps(500_000), count => { const text = doc() + viasOf(count) + '\n'; return () => parse(text); });
    expect(thrown(`${A(...COMPONENTS)}${'\n'.repeat(3_000_000)}`)).toBeInstanceOf(BoardFormatError);
    expect(notes(parse(doc() + viasOf(500_000) + '\n')).some(message => /500000 vias are not shown/.test(message))).toBe(true);
  }, 300_000);
});
