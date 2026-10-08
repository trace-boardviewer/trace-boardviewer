import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import { BoardFormatError, textInput } from './common';
import { parseBrd } from './brd';
import { expectScaling } from '../../test-support/timing';

const mm = (mil: number) => mil * 0.0254;
const parse = (text: string, name = 'board.brd') => parseBrd(textInput(text, name));
function must(text: string, name?: string): Board {
  const board = parse(text, name);
  if (!board) throw new Error('fixture was not recognized');
  return board;
}
function thrown(text: string, name?: string): BoardFormatError {
  try { parse(text, name); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
}
const noteMessages = (board: Board) => board.warnings.filter(issue => issue.key === 'parse.warning.formatNote').map(issue => String(issue.params?.message));
const pinRows = (board: Board) => board.pins.map(pin => {
  const component = board.components.find(candidate => candidate.id === pin.componentId)!;
  return [component.ref, pin.number, pin.x, pin.y, pin.net, pin.side] as const;
});
const netNames = (board: Board) => board.nets.map(net => net.name).sort();

// Three components on three sides, a pin without a net (Lenovo nail fallback), three UNCONNECTED sentinels, test points with side 1 and 0.
const LANDREX = `str_length:
0
var_data:
4 3 7 2
Format:
0 0
2000 0
2000 1000
0 1000
Parts:
U1 1 3
R1 2 5
J1 0 7
Pins:
100 100 1 1 VCC
100 200 -99 1 UNCONNECTED12
100 300 2 1
500 500 3 2 GND
500 600 4 2 UNCONNECTED
900.5 100 5 3 SDA
900.5 200 6 3 UNCONNECTED7
Nails:
1 100 100 1 VCC
2 100 300 0 SCL
`;
const landrexPart = (type: number) => `str_length:\n0\nvar_data:\n0 1 1 0\nParts:\nU1 ${type} 1\nPins:\n10 20 1 1 N1\n`;

// Two-pin top component, two-pin bottom component (mirrored Y), zero-pin component, nails with side 1 and 0.
const BRD2 = `BRDOUT: 4 2000 1000
0 0
2000 0
2000 1000
0 1000
NETS: 3
1 GND
2 VCC
3 UNCONNECTED5
PARTS: 3
U1 100 100 300 300 0 1
R1 500 100 700 200 2 2
C1 800 800 900 900 4 1
PINS: 4
150 150 2 1
250 250 1 1
550 150 1 2
650 150 3 2
NAILS: 2
1 150 150 2 1
2 550 850 1 0
`;

describe('Landrex / TestLink BRD', () => {
  it('parses the plaintext golden fixture with mil units, component-derived pin sides and nail nets', () => {
    const board = must(LANDREX);
    expect(board.format).toBe('Landrex / TestLink BRD');
    expect(board.components.map(c => [c.ref, c.side])).toEqual([['U1', 'top'], ['R1', 'bottom'], ['J1', 'both'], ['TP:1', 'top'], ['TP:2', 'bottom']]);
    expect(pinRows(board)).toEqual([
      ['U1', '1', mm(100), mm(100), 'VCC', 'top'],
      ['U1', '2', mm(100), mm(200), '', 'top'],
      ['U1', '3', mm(100), mm(300), 'SCL', 'top'],
      ['R1', '1', mm(500), mm(500), 'GND', 'bottom'],
      ['R1', '2', mm(500), mm(600), '', 'bottom'],
      ['J1', '1', mm(900.5), mm(100), 'SDA', 'both'],
      ['J1', '2', mm(900.5), mm(200), '', 'both'],
      ['TP:1', '1', mm(100), mm(100), 'VCC', 'top'],
      ['TP:2', '2', mm(100), mm(300), 'SCL', 'bottom'],
    ]);
    expect(board.pins[5].x).toBeCloseTo(22.8727, 10);
    expect(board.pins.every(pin => pin.radius === 0)).toBe(true);
    expect(board.outline).toEqual([{ x: 0, y: 0 }, { x: mm(2000), y: 0 }, { x: mm(2000), y: mm(1000) }, { x: 0, y: mm(1000) }]);
    expect(netNames(board)).toEqual(['GND', 'SCL', 'SDA', 'VCC']);
    expect(board.nets.find(net => net.name === 'VCC')?.pinIds).toEqual(['pin:0', 'pin:7']);
    expect(board.nets.some(net => net.name.startsWith('UNCONNECTED'))).toBe(false);
    expect(noteMessages(board)).toEqual(['3 pins marked UNCONNECTED by the exporter are shown without a net.']);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 9 } });
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackComponents', params: { count: 5 } });
  });
  it('maps component type codes like BRDFile.cpp:109-110', () => {
    for (const [type, side] of [[0, 'both'], [1, 'top'], [2, 'bottom'], [3, 'both'], [4, 'top'], [7, 'top'], [8, 'bottom'], [255, 'bottom']] as const) {
      expect(must(landrexPart(type)).components[0].side, `type ${type}`).toBe(side);
    }
    expect(thrown(landrexPart(256)).message).toMatch(/component type/);
  });
  it('places test points on top only for side code 1 (B07)', () => {
    for (const [code, side] of [[1, 'top'], [0, 'bottom'], [2, 'bottom'], [7, 'bottom']] as const) {
      const board = must(`str_length:\n0\nvar_data:\n0 1 1 1\nParts:\nU1 1 1\nPins:\n10 20 1 1 N1\nNails:\n5 30 40 ${code} N1\n`);
      expect(board.components[1].side, `code ${code}`).toBe(side);
      expect(board.pins[1].side).toBe(side);
    }
  });
  it('does not use the nail net for a pin whose net is a vendor sentinel', () => {
    const board = must('str_length:\n0\nvar_data:\n0 1 1 1\nParts:\nU1 1 1\nPins:\n10 20 1 1 UNCONNECTED3\nNails:\n1 10 20 1 VCC\n');
    expect(board.pins[0].net).toBe('');
    expect(netNames(board)).toEqual(['VCC']);
  });
  it('reproduces the B06/B07 fixture without a false net or a "both" nail', () => {
    const board = must('str_length:\n0\nvar_data:\n4 1 2 1\nFormat:\n0 0\n1000 0\n1000 1000\n0 1000\nParts:\nR1 1 2\nPins:\n100 100 1 1 UNCONNECTED12\n200 200 2 1 UNCONNECTED12\nNails:\n99 300 300 0 GND\n', 'synthetic.brd');
    expect(board.nets.map(net => net.name)).toEqual(['GND']);
    expect(board.pins.at(-1)?.side).toBe('bottom');
    expect(board.components.at(-1)).toMatchObject({ ref: 'TP:99', side: 'bottom' });
    expect(noteMessages(board)).toEqual(['2 pins marked UNCONNECTED by the exporter are shown without a net.']);
  });
  it('B06: every UNCONNECTED<n> spelling is "no net", while look-alike names keep their identity', () => {
    const names = ['UNCONNECTED', 'unconnected3', 'UNCONNECTED<123>', 'UNCONNECTED-5', 'UNCONNECTED_7', 'UNCONNECTED(2)'];
    const keep = ['NC', 'UNCONNECTEDX', 'MY_UNCONNECTED1', 'NOT-UNCONNECTED', 'UNCONNECT1'];
    const pins = [...names, ...keep].map((net, index) => `${100 + index} 100 ${index + 1} 1 ${net}`);
    const board = must(`str_length:\n0\nvar_data:\n0 1 ${pins.length} 0\nParts:\nU1 1 ${pins.length}\nPins:\n${pins.join('\n')}\n`);
    expect(board.pins.map(pin => pin.net)).toEqual([...names.map(() => ''), ...keep]);
    expect(netNames(board)).toEqual([...keep].sort());
    expect(noteMessages(board)).toEqual([`${names.length} pins marked UNCONNECTED by the exporter are shown without a net.`]);
  });
  it('B06: a nail whose own net is a sentinel does not connect the pins that share its probe', () => {
    const board = must('str_length:\n0\nvar_data:\n0 1 2 1\nParts:\nU1 1 2\nPins:\n10 20 7 1\n30 40 8 1 GND\nNails:\n7 10 20 1 UNCONNECTED9\n');
    expect(board.pins.map(pin => pin.net)).toEqual(['', 'GND', '']);
    expect(netNames(board)).toEqual(['GND']);
  });
  it('decodes the rotated-byte variant to the same board as the plaintext', () => {
    // Inverse of BRDFile.cpp:47 (decoded = ~ROL2(byte)): undo the NOT, then rotate right by two bits.
    const encode = (text: string) => new TextEncoder().encode(text).map(byte => {
      if (byte === 0 || byte === 10 || byte === 13) return byte;
      const inverted = ~byte & 0xff;
      return ((inverted >>> 2) | (inverted << 6)) & 0xff;
    });
    const decode = (byte: number) => byte === 0 || byte === 10 || byte === 13 ? byte : ~((byte >>> 6) | (byte << 2)) & 0xff;
    const encoded = encode(LANDREX.replace(/\n/g, '\r\n'));
    expect([...encoded.subarray(0, 4)]).toEqual([0x23, 0xe2, 0x63, 0x28]);
    for (let byte = 9; byte < 127; byte++) expect(decode(encode(String.fromCharCode(byte))[0]), `byte ${byte}`).toBe(byte);
    const board = parseBrd({ name: 'board.brd', data: encoded });
    expect(board).toEqual(must(LANDREX));
    expect(() => parseBrd({ name: 'x.brd', data: Uint8Array.from([0x23, 0xe2, 0x63, 0x28, 0x41, 0x42]) })).toThrow(/record counts/);
  });
  it('rejects malformed counts, references, boundaries, probes and sections', () => {
    expect(thrown(LANDREX.replace('4 3 7 2', '5 3 7 2')).message).toMatch(/outline count/);
    expect(thrown(LANDREX.replace('4 3 7 2', '4 3 7 1')).message).toMatch(/test point count/);
    expect(thrown(LANDREX.replace('100 100 1 1 VCC', '100 100 1 0 VCC')).message).toMatch(/one-based/);
    expect(thrown(LANDREX.replace('100 100 1 1 VCC', '100 100 1 4 VCC')).message).toMatch(/pin component/);
    expect(thrown(LANDREX.replace('R1 2 5', 'R1 2 2')).message).toMatch(/decreasing/);
    expect(thrown(LANDREX.replace('J1 0 7', 'J1 0 6')).message).toMatch(/final component pin boundary/);
    expect(thrown(LANDREX.replace('J1 0 7', 'J1 0 8')).message).toMatch(/pin boundary/);
    expect(thrown(LANDREX.replace('100 100 1 1 VCC', '100 100 1.5 1 VCC')).message).toMatch(/probe must be an integer/);
    expect(thrown(LANDREX.replace('Nails:', 'Parts:')).message).toMatch(/duplicate Parts section/);
    expect(thrown(LANDREX.replace('var_data:\n4 3 7 2\n', 'var_data:\n4 3 7 2\n1 2 3 4\n')).message).toMatch(/record counts/);
    expect(thrown(LANDREX.replace('0 1000\nParts', '0 1000 5\nParts')).message).toMatch(/two coordinates/);
    const error = thrown(LANDREX.replace('1 100 100 1 VCC', '1 100 100 1 VCC extra'));
    expect(error.format).toBe('Landrex / TestLink BRD');
    expect(error.code).toBe('INVALID_FORMAT');
  });
  it('B16: absurd, non-finite or out-of-range coordinates are a BoardFormatError in every record kind', () => {
    const base = 'str_length:\n0\nvar_data:\n4 1 1 1\nFormat:\n0 0\n1000 0\n1000 1000\n0 1000\nParts:\nU1 1 1\nPins:\n100 100 1 1 N1\nNails:\n1 100 100 1 N1\n';
    for (const bad of ['1e30', '1e999', '-1e30', 'NaN', 'Infinity']) {
      for (const [from, to] of [['100 100 1 1 N1', `${bad} 100 1 1 N1`], ['100 100 1 1 N1', `100 ${bad} 1 1 N1`], ['1 100 100 1 N1', `1 ${bad} 100 1 N1`], ['1000 1000\n0 1000', `${bad} 1000\n0 1000`]]) {
        expect(thrown(base.replace(from, to)).message, `${bad} in "${to}"`).toMatch(/Invalid coordinate|exceeds the supported range/);
      }
    }
    const atCap = (1e9 / 0.0254).toString(), over = (1.01e9 / 0.0254).toString();
    expect(must(base.replace('100 100 1 1 N1', `${atCap} 100 1 1 N1`)).pins[0].x).toBeCloseTo(1e9, 0);
    expect(thrown(base.replace('100 100 1 1 N1', `${over} 100 1 1 N1`)).message).toMatch(/exceeds the supported range/);
  });
  it('B08: the Landrex section scan rejects a header whose counts disagree even when the file ends mid-section', () => {
    const error = thrown('str_length:\n0\nvar_data:\n4 1 1 0\nFormat:\n0 0\n');
    expect(error.format).toBe('Landrex / TestLink BRD'); expect(error.code).toBe('INVALID_FORMAT');
  });
  it('bounds the work for hostile section sizes (LIMIT_EXCEEDED before millions of rows are materialised)', { timeout: 300_000 }, () => {
    const header = 'str_length:\n0\nvar_data:\n0 1 1 0\nParts:\nU1 1 1\nPins:\n1 1 1 1 N\n';
    expect(thrown(header.replace('0 1 1 0', '0 1 1 1000001')).message).toMatch(/record count/);
    const flood = `${header}Nails:\n${'1 1 1 1 N\n'.repeat(1_000_001)}`;
    expect(thrown(flood.replace('0 1 1 0', '0 1 1 1000000')).code).toBe('LIMIT_EXCEEDED');
  });
  it('treats undecodable text as "not BRD" and survives a UTF-16 byte-order mark followed by garbage', () => {
    expect(parseBrd({ name: 'x.brd', data: Uint8Array.from([0xff, 0xfe, 0x41, 0xd8]) })).toBeNull();
    expect(parseBrd({ name: 'x.brd', data: Uint8Array.from([0xfe, 0xff, 0xd8, 0x41, 0x00]) })).toBeNull();
    const utf16 = new Uint8Array(2 + LANDREX.length * 2); utf16.set([0xff, 0xfe]);
    for (let index = 0; index < LANDREX.length; index++) utf16[2 + index * 2] = LANDREX.charCodeAt(index);
    expect(parseBrd({ name: 'board.brd', data: utf16 })).toEqual(must(LANDREX));
  });
  it('does not take quadratic time on whitespace-only or blank-line floods (the sniffing regexes must not cross lines)', { timeout: 300_000 }, () => {
    // The quadratic regex needed minutes for 300,000 characters and about 1 s for 20,000, so a regression fails at the first pair.
    const floods: Array<[string, (size: number) => string]> = [
      ['newlines', size => '\n'.repeat(size)], ['CRLF', size => '\r\n'.repeat(size / 2)], ['blank lines of one space', size => ' \n'.repeat(size / 2)],
      ['blank lines around a keyword', size => `${'\n'.repeat(size * 2 / 3)}str_length:\n${'\n'.repeat(size * 2 / 3)}`],
    ];
    for (const [label, flood] of floods) expectScaling(label, [20_000, 80_000, 320_000], size => { const input = textInput(flood(size), 'board.brd'); return () => parseBrd(input); });
    for (const [label, flood] of floods) expect(parse(flood(300_000)), label).toBeNull();
  });
  it('returns null for files without the BRD markers', () => {
    expect(parse('$HEADER\nGENCAD 1.4\n$ENDHEADER\n')).toBeNull();
    expect(parse('')).toBeNull();
    expect(parse('str_length:\n0\nFormat:\n')).toBeNull();
    expect(parse('var_data:\n0 0 0 0\n')).toBeNull();
  });
});

describe('TOPTEST BRD2', () => {
  it('parses the golden fixture with bottom mirroring, pin start ranges, net ids and nail sides', () => {
    const board = must(BRD2);
    expect(board.format).toBe('TOPTEST BRD2');
    expect(board.components.map(c => [c.ref, c.side])).toEqual([['U1', 'top'], ['R1', 'bottom'], ['C1', 'top'], ['TP:1', 'top'], ['TP:2', 'bottom']]);
    expect(board.components[0].bounds).toEqual({ minX: mm(100), minY: mm(100), maxX: mm(300), maxY: mm(300) });
    expect(board.components[1].bounds).toEqual({ minX: mm(500), minY: mm(800), maxX: mm(700), maxY: mm(900) });
    expect(board.components[2].bounds).toEqual({ minX: mm(800), minY: mm(800), maxX: mm(900), maxY: mm(900) });
    expect(board.components[2].pinIds).toEqual([]);
    expect(pinRows(board)).toEqual([
      ['U1', '1', mm(150), mm(150), 'VCC', 'top'],
      ['U1', '2', mm(250), mm(250), 'GND', 'top'],
      ['R1', '1', mm(550), mm(850), 'GND', 'bottom'],
      ['R1', '2', mm(650), mm(850), '', 'bottom'],
      ['TP:1', '1', mm(150), mm(150), 'VCC', 'top'],
      ['TP:2', '2', mm(550), mm(150), 'GND', 'bottom'],
    ]);
    expect(board.outline).toEqual([{ x: 0, y: 0 }, { x: mm(2000), y: 0 }, { x: mm(2000), y: mm(1000) }, { x: 0, y: mm(1000) }]);
    expect(netNames(board)).toEqual(['GND', 'VCC']);
    expect(board.nets.find(net => net.name === 'GND')?.pinIds).toEqual(['pin:1', 'pin:2', 'pin:5']);
    expect(board.nets.some(net => net.name.startsWith('UNCONNECTED'))).toBe(false);
    expect(noteMessages(board)).toEqual(['1 pin marked UNCONNECTED by the exporter is shown without a net.']);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 6 } });
  });
  it('treats a component without pins on its own side as through-hole and mirrors its "both" pins', () => {
    const board = must('BRDOUT: 4 1000 1000\n0 0\n1000 0\n1000 1000\n0 1000\nNETS: 1\n1 GND\nPARTS: 1\nJ1 100 100 200 200 0 1\nPINS: 2\n150 150 1 0\n150 170 1 0\n');
    expect(board.components[0].side).toBe('both');
    expect(board.components[0].bounds).toEqual({ minX: mm(100), minY: mm(100), maxX: mm(200), maxY: mm(200) });
    expect(pinRows(board)).toEqual([['J1', '1', mm(150), mm(850), 'GND', 'both'], ['J1', '2', mm(150), mm(830), 'GND', 'both']]);
  });
  it('tolerates an undefined net id with a disclosed warning', () => {
    const board = must(BRD2.replace('250 250 1 1', '250 250 9 1'));
    expect(board.pins[1].net).toBe('');
    expect(noteMessages(board)).toContain('1 record references an undefined net id and is shown without a net.');
  });
  it('recognizes a truncated BRDOUT file as malformed BRD2 instead of returning null (B08)', () => {
    const error = thrown('BRDOUT: 4 1000 1000\n0 0\n', 'truncated.brd');
    expect(error.message).toBe('BRD2: missing NETS section.');
    expect(error.format).toBe('TOPTEST BRD2');
    expect(error.code).toBe('INVALID_FORMAT');
    expect(thrown('BRDOUT: 4 1000 1000\nNETS: 0\n').message).toMatch(/missing PARTS section/);
  });
  it('B08: the issue repro without a trailing newline is the same recognized-but-malformed error, not null', () => {
    for (const text of ['BRDOUT: 4 1000 1000\n0 0', 'BRDOUT: 4 1000 1000', '\ufeffBRDOUT: 4 1000 1000\n0 0\r\n', '  BRDOUT: 0 0 0']) {
      const error = thrown(text, 'truncated.brd');
      expect(error, JSON.stringify(text)).toMatchObject({ code: 'INVALID_FORMAT', format: 'TOPTEST BRD2' });
      expect(error.message).toMatch(/^BRD2: /);
    }
  });
  it('B06: UNCONNECTED<n> net names are "no net" in NETS and in NAILS, look-alikes stay real nets', () => {
    const text = BRD2.replace('NETS: 3', 'NETS: 5').replace('3 UNCONNECTED5', '3 UNCONNECTED<5>\n4 UNCONNECTEDX\n5 unconnected-9')
      .replace('250 250 1 1', '250 250 4 1').replace('1 150 150 2 1\n', '1 150 150 5 1\n');
    const board = must(text);
    expect(board.pins.map(pin => pin.net)).toEqual(['VCC', 'UNCONNECTEDX', 'GND', '', '', 'GND']);
    expect(netNames(board)).toEqual(['GND', 'UNCONNECTEDX', 'VCC']);
    expect(noteMessages(board)).toEqual(['2 pins marked UNCONNECTED by the exporter are shown without a net.']);
  });
  it('B07: only nail side code 1 is top; 0, 2 and any other code are bottom with a mirrored Y', () => {
    for (const [code, side] of [[1, 'top'], [0, 'bottom'], [2, 'bottom'], [9, 'bottom']] as const) {
      const board = must(`BRDOUT: 4 1000 1000\n0 0\n1000 0\n1000 1000\n0 1000\nNETS: 1\n1 GND\nPARTS: 1\nU1 100 100 200 200 0 1\nPINS: 1\n150 150 1 1\nNAILS: 1\n7 300 250 1 ${code}\n`);
      const nail = board.components.at(-1)!;
      expect(nail, `code ${code}`).toMatchObject({ ref: 'TP:7', side });
      expect(board.pins.at(-1)!.side).toBe(side);
      expect(board.pins.at(-1)!.y).toBeCloseTo(mm(side === 'top' ? 250 : 750), 9);
    }
  });
  it('B16: absurd, non-finite or out-of-range coordinates are a BoardFormatError in every record kind', () => {
    for (const bad of ['1e30', '1e999', '-1e30', 'NaN']) {
      for (const [from, to] of [['150 150 2 1\n', `${bad} 150 2 1\n`], ['150 150 2 1\n', `150 ${bad} 2 1\n`], ['1 150 150 2 1\n', `1 ${bad} 150 2 1\n`], ['U1 100 100 300 300 0 1', `U1 ${bad} 100 300 300 0 1`], ['U1 100 100 300 300 0 1', `U1 100 100 300 ${bad} 0 1`]]) {
        expect(thrown(BRD2.replace(from, to)).message, `${bad} -> "${to}"`).toMatch(/Invalid (?:coordinate|board width)|exceeds the supported range/);
      }
    }
    expect(thrown(BRD2.replace('BRDOUT: 4 2000 1000', 'BRDOUT: 4 1e30 1000').replace('150 150 2 1\n', '1e29 150 2 1\n')).message).toMatch(/exceeds the supported range/);
    const over = (1.01e9 / 0.0254).toString();
    expect(thrown(BRD2.replace('BRDOUT: 4 2000 1000', `BRDOUT: 4 ${over} 1000`).replace('150 150 2 1\n', `${over} 150 2 1\n`)).message).toMatch(/exceeds the supported range/);
  });
  it('rejects malformed counts, ids, ranges, sides and sections', () => {
    expect(thrown(BRD2.replace('NETS: 3', 'NETS: 2')).message).toMatch(/NETS count/);
    expect(thrown(BRD2.replace('2 VCC', '1 VCC')).message).toMatch(/duplicate net id/);
    expect(thrown(BRD2.replace('NAILS: 2', 'NETS: 2')).message).toMatch(/duplicate NETS section/);
    expect(thrown(BRD2.replace('C1 800 800 900 900 4 1', 'C1 800 800 900 900 5 1')).message).toMatch(/component pin start/);
    expect(thrown(BRD2.replace('C1 800 800 900 900 4 1', 'C1 800 800 900 900 1 1')).message).toMatch(/never decrease/);
    expect(thrown(BRD2.replace('U1 100 100 300 300 0 1', 'U1 100 100 300 300 1 1')).message).toMatch(/start at 0/);
    expect(thrown(BRD2.replace('U1 100 100 300 300 0 1', 'U1 100 100 300 300 0 3')).message).toMatch(/unknown component side code 3/);
    expect(thrown(BRD2.replace('150 150 2 1\n', '150 150 2 4\n')).message).toMatch(/unknown pin side code 4/);
    expect(thrown(BRD2.replace('2000 1000\n0 1000', '2000 1000\n0 1001')).message).toMatch(/outside the declared board size/);
    expect(thrown(BRD2.replace('BRDOUT: 4 2000 1000', 'BRDOUT: 4 2000')).message).toMatch(/invalid BRDOUT header/);
    expect(thrown(BRD2.replace('1 150 150 2 1\n', '1 150 150 2\n')).message).toMatch(/test point needs five fields/);
    expect(thrown(BRD2.replace('150 150 2 1\n', '150 150 2 1 9\n')).message).toMatch(/pin needs four fields/);
  });

  it('reads section headings and ignores a line of blanks cut by a line separator in linear time', () => {
    const separator = String.fromCharCode(0x2028);
    const golden = must(BRD2);
    const sizes = [1000, 40_000, 200_000];
    const files: Array<[string, (blanks: string) => string]> = [
      ['line separator after the text', blanks => `PINS:${blanks}x${separator}y\n${BRD2}`], ['two separators', blanks => `NAILS:${blanks}x${separator}${blanks}${separator}y\n${BRD2}`],
      ['a heading word that is no heading', blanks => `PINSX:${blanks}x${separator}y\n${BRD2}`],
      // The same blanks after a real heading are skipped: the count is read behind them, whatever the blank characters are.
      ['spaced headings', blanks => BRD2.replace('NETS: 3', `NETS:${blanks}\t3`).replace('PARTS: 3', `PARTS:${String.fromCharCode(0xa0)}${blanks}3`)],
    ];
    // Ascending sizes: a heading pattern whose blank run and "rest of the line" share the spaces retries every length and needs about 1 s for 40,000 blanks, so a regression fails at the first pair.
    for (const [label, file] of files) expectScaling(label, sizes, count => { const input = textInput(file(' '.repeat(count)), 'board.brd'); return () => parseBrd(input); });
    for (const count of sizes) for (const [label, file] of files) expect(must(file(' '.repeat(count))), `${count}: ${label}`).toEqual(golden);
    // A heading whose rest holds a line separator is not a heading (it is a data row of the section above), exactly as before.
    expect(thrown(BRD2.replace('NETS: 3', `NETS: 3${separator}4`)).message).toMatch(/BRDOUT count does not match its header/);
  });
});

describe('BRD / BRD2 malformed input', () => {
  const encodeLandrex = (text: string) => new TextEncoder().encode(text).map(byte => {
    if (byte === 0 || byte === 10 || byte === 13) return byte;
    const inverted = ~byte & 0xff;
    return ((inverted >>> 2) | (inverted << 6)) & 0xff;
  });
  const hasMarkers = (text: string) => /^\s*BRDOUT:/m.test(text) || /^\s*str_length:\s*$/m.test(text) && /^\s*var_data:\s*$/m.test(text);
  it.each([['Landrex', LANDREX], ['BRD2', BRD2]])('%s: every strict text prefix is a board, null (markers not yet complete) or a BoardFormatError', (_name, text) => {
    for (let length = 0; length < text.length; length++) {
      const prefix = text.slice(0, length);
      try { parse(prefix); } catch (error) { expect(error, `length ${length}`).toBeInstanceOf(BoardFormatError); continue; }
      if (hasMarkers(prefix)) {
        // Cut exactly at a record boundary the counts may still disagree, but a recognized prefix may never return null.
        expect(parse(prefix), `length ${length}`).not.toBeNull();
      }
    }
  });
  it('the rotated-byte variant: every strict prefix is a board or a BoardFormatError (the signature is always present)', () => {
    const encoded = encodeLandrex(LANDREX);
    for (let length = 4; length < encoded.length; length++) {
      try { parseBrd({ name: 'a.brd', data: encoded.subarray(0, length) }); } catch (error) { expect(error, `length ${length}`).toBeInstanceOf(BoardFormatError); }
    }
  });
  it.each([['Landrex', LANDREX], ['BRD2', BRD2]])('%s: single-character corruption never throws anything but BoardFormatError', (_name, text) => {
    const replacements = ['x', '-', '9', ' ', '\n', '\u00ff'];
    for (let index = 0; index < text.length; index++) {
      for (const replacement of replacements) {
        try { parse(text.slice(0, index) + replacement + text.slice(index + 1)); } catch (error) { expect(error, `char ${index} -> ${JSON.stringify(replacement)}`).toBeInstanceOf(BoardFormatError); }
      }
    }
  });
});

// OpenBoardView conformance probes. The fixtures are original synthetic files modelled on BRDFile.cpp / BRD2File.cpp.
const landrex = (parts: string[], pins: string[], format = ['0 0', '1000 0', '1000 500', '0 500']) =>
  ['str_length:', '0', 'var_data:', `${format.length} ${parts.length} ${pins.length} 0`, 'Format:', ...format, 'Parts:', ...parts, 'Pins:', ...pins, ''].join('\n');

describe('Landrex / TestLink BRD: components without pins (BRDFile.cpp reads them, BRDBoard.cpp keeps them)', () => {
  it('omits a component that owns no pin, with a disclosure, instead of rejecting the whole file', () => {
    const board = must(landrex(['U1 5 2', 'MH1 1 2', 'R1 8 3'], ['100 100 1 1 VCC', '200 100 2 1 GND', '300 100 3 3 GND']));
    expect(board.components.map(c => [c.ref, c.side, c.pinIds.length])).toEqual([['U1', 'top', 2], ['R1', 'bottom', 1]]);
    expect(pinRows(board)).toEqual([['U1', '1', mm(100), mm(100), 'VCC', 'top'], ['U1', '2', mm(200), mm(100), 'GND', 'top'], ['R1', '1', mm(300), mm(100), 'GND', 'bottom']]);
    expect(noteMessages(board)).toEqual(['1 component without pins was omitted because the file gives no position for it.']);
  });
  it('omits several pinless components, including a pinless first and last one, and keeps the pin-to-component binding by index', () => {
    const board = must(landrex(['A0 1 0', 'U1 5 1', 'B1 2 1', 'C2 2 1', 'R1 8 2', 'Z9 1 2'], ['100 100 1 2 VCC', '200 100 2 5 GND']));
    expect(board.components.map(c => [c.ref, c.pinIds.length])).toEqual([['U1', 1], ['R1', 1]]);
    expect(noteMessages(board)).toEqual(['4 components without pins were omitted because the file gives no position for them.']);
  });
  it('still rejects a file whose every component is pinless', () => {
    expect(thrown(landrex(['MH1 1 0'], [])).message).toMatch(/no components were found|no component/);
  });
});

describe('Landrex / TestLink BRD: OpenBoardView edge conformance (synthetic, modelled on BRDFile.cpp)', () => {
  const latin1 = (value: string) => Uint8Array.from(value, ch => ch.charCodeAt(0) & 255);
  it('reads CRLF files whose section headings carry trailing blanks, blank lines between records and negative coordinates', () => {
    const base = landrex(['U1 5 2', 'R1 8 3'], ['-100 -100 1 1 VCC', '-200 100 2 1 GND', '300 -100 3 2 GND'], ['-500 -500', '1000 -500', '1000 500', '-500 500']);
    for (const eol of ['\n', '\r\n']) {
      const board = must(base.split('\n').map(row => (row ? row + ' ' : row)).join(eol + eol));
      expect(pinRows(board)).toEqual([['U1', '1', mm(-100), mm(-100), 'VCC', 'top'], ['U1', '2', mm(-200), mm(100), 'GND', 'top'], ['R1', '1', mm(300), mm(-100), 'GND', 'bottom']]);
      expect(board.outline).toEqual([{ x: mm(-500), y: mm(-500) }, { x: mm(1000), y: mm(-500) }, { x: mm(1000), y: mm(500) }, { x: mm(-500), y: mm(500) }]);
    }
  });
  it('decodes Windows-1252 bytes in component names', () => {
    const text = landrex(['R\xB51 5 2', 'R1 8 3'], ['100 100 1 1 VCC', '200 100 2 1 GND', '300 100 3 2 GND']);
    expect(parseBrd({ name: 'a.brd', data: latin1(text) })!.components.map(c => c.ref)).toEqual(['R\u00b51', 'R1']);
  });
  it('gives a pin without a net field no net (BRDFile.cpp: empty net string, no nail with its probe number)', () => {
    const board = must(landrex(['U1 5 2', 'R1 8 3'], ['100 100 1 1', '200 100 2 1 GND', '300 100 3 2 GND']));
    expect(pinRows(board)[0]).toEqual(['U1', '1', mm(100), mm(100), '', 'top']);
    expect(netNames(board)).toEqual(['GND']);
  });
});

describe('Landrex / TestLink BRD export variants (original synthetic regressions)', () => {
  it('accepts two extra signed var_data fields in both plain and encoded data without guessing an offset', () => {
    const source = LANDREX.replace('4 3 7 2\n', '4 3 7 2 -1000 -500\n');
    const encode = (value: string) => new TextEncoder().encode(value).map(byte => {
      if (byte === 0 || byte === 10 || byte === 13) return byte;
      const inverted = ~byte & 0xff; return ((inverted >>> 2) | (inverted << 6)) & 0xff;
    });
    const expected = must(LANDREX);
    expect(must(source)).toEqual(expected);
    expect(parseBrd({ name: 'board.brd', data: encode(source) })).toEqual(expected);
    expect(thrown(source.replace('-1000 -500', '-1000 bad')).message).toMatch(/extra header value/);
    expect(thrown(source.replace('-1000 -500', '-1000')).message).toMatch(/record counts/);
  });
  it('keeps a nail with an absent net and leaves a matching Lenovo pin disconnected', () => {
    const source = 'str_length:\n0\nvar_data:\n0 1 1 1\nParts:\nU1 1 1\nPins:\n10 20 7 1\nNails:\n7 10 20 1\n';
    const board = must(source);
    expect(board.components.map(part => part.ref)).toEqual(['U1', 'TP:7']);
    expect(board.pins.map(pin => pin.net)).toEqual(['', '']);
    expect(thrown(source.replace('7 10 20 1\n', '7 10 20\n')).message).toMatch(/test point needs/);
  });
});
