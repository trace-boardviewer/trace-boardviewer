import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import { BoardFormatError, textInput } from './common';
import { parseBdv } from './bdv';

const inch = (value: number) => value * 25.4;
const header = (count: number, tag: string) => Array.from({ length: count }, (_, index) => `; ${tag} header ${index + 1}`);
const FORMAT = ['0.000 0.000', '2.000 0.000', '2.000 1.000', '0.000 1.000'];
const PINS = [
  'Part U1 (T)',
  '1  1  0.100 0.200  1  VCC  5',
  '2  2  0.150 0.200  1  UNCONNECTED12  0',
  'Part R1 (B)',
  '1  A 1  1.500 0.500  2  GND  7',
  '2  2  1.600 0.500  2  UNCONNECTED  0',
];
const NAILS = ['*5  0.100 0.200  1  G1 (T) 11  VCC', '#6  1.500 0.500  2  G2 (B) 12  GND'];
const lines = (format = FORMAT, pins = PINS, nails = NAILS) => [
  '<<format.asc>>', ...header(8, 'format'), ...format,
  '<<pins.asc>>', ...header(8, 'pins'), ...pins,
  '<<nails.asc>>', ...header(7, 'nails'), ...nails,
];
const text = (all: string[], eol = '\r\n') => all.join(eol) + eol;
const bytes = (value: string) => new TextEncoder().encode(value);
const GOLDEN = text(lines());

const parse = (data: string | Uint8Array, name = 'board.bdv') => parseBdv({ name, data: typeof data === 'string' ? bytes(data) : data });
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

/** Independent model of the evolving key (BDVFile.cpp decode_bdv): 160..285 for the first 126 lines, then 159..285 repeating. */
const keyOfLine = (line: number) => line <= 125 ? 160 + line : 159 + (line - 126) % 127;
function encode(all: string[]): Uint8Array {
  const out: number[] = [];
  all.forEach((line, index) => {
    for (const char of line) {
      const encoded = (keyOfLine(index) - char.charCodeAt(0)) & 0xff;
      if (encoded === 0 || encoded === 10 || encoded === 13) throw new Error('fixture byte cannot be encoded');
      out.push(encoded);
    }
    out.push(13, 10);
  });
  return Uint8Array.from(out);
}

describe('Honhan BDV (plain)', () => {
  it('parses the golden fixture: inch units, part-line sides, free-text pin names, test points', () => {
    const board = must(GOLDEN);
    expect(board.format).toBe('Honhan BDV');
    expect(board.name).toBe('board');
    expect(board.units).toBe('mm');
    expect(board.components.map(c => [c.ref, c.side])).toEqual([['U1', 'top'], ['R1', 'bottom'], ['TP:5', 'top'], ['TP:6', 'bottom']]);
    expect(pinRows(board)).toEqual([
      ['U1', '1', inch(0.1), inch(0.2), 'VCC', 'top'],
      ['U1', '2', inch(0.15), inch(0.2), '', 'top'],
      ['R1', 'A 1', inch(1.5), inch(0.5), 'GND', 'bottom'],
      ['R1', '2', inch(1.6), inch(0.5), '', 'bottom'],
      ['TP:5', '5', inch(0.1), inch(0.2), 'VCC', 'top'],
      ['TP:6', '6', inch(1.5), inch(0.5), 'GND', 'bottom'],
    ]);
    expect(board.pins[0].x).toBeCloseTo(2.54, 12);
    expect(board.pins[2].name).toBe('A 1');
    expect(board.outline).toEqual([{ x: 0, y: 0 }, { x: inch(2), y: 0 }, { x: inch(2), y: inch(1) }, { x: 0, y: inch(1) }]);
    expect(board.bounds).toEqual({ minX: 0, minY: 0, maxX: inch(2), maxY: inch(1) });
  });
  it('carries no pad geometry: radius 0, no width/height, estimated-pad warnings', () => {
    const board = must(GOLDEN);
    expect(board.pins.every(pin => pin.radius === 0 && pin.width === undefined && pin.height === undefined)).toBe(true);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 6 } });
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackComponents', params: { count: 4 } });
  });
  it('does not turn UNCONNECTED<n> placeholders into a net, but keeps other names (B06)', () => {
    const board = must(GOLDEN);
    expect(board.nets.map(net => net.name).sort()).toEqual(['GND', 'VCC']);
    expect(board.nets.find(net => net.name === 'VCC')?.pinIds).toEqual(['pin:0', 'pin:4']);
    expect(board.nets.find(net => net.name === 'GND')?.pinIds).toEqual(['pin:2', 'pin:5']);
    expect(notes(board)).toEqual(['2 pins marked UNCONNECTED by the exporter are shown without a net.']);
    const real = must(text(lines(FORMAT, ['Part U1 (T)', '1 1 0.1 0.2 1 UNCONNECTEDLY 0', '2 2 0.2 0.2 1 UNCONNECTEDLY 0'], [])));
    expect(real.nets.map(net => [net.name, net.pinIds.length])).toEqual([['UNCONNECTEDLY', 2]]);
  });
  it('is independent of line endings, a UTF-8 BOM and the file extension', () => {
    const golden = must(GOLDEN);
    expect(must(text(lines(), '\n'))).toEqual(golden);
    expect(must(text(lines(), '\r'))).toEqual(golden);
    expect(must('﻿' + GOLDEN)).toEqual(golden);
    expect(must(GOLDEN, 'mystery.dat')).toEqual({ ...golden, name: 'mystery' });
  });
  it('treats only exactly "(T)" as top and discloses side markers other than (T)/(B)', () => {
    const board = must(text(lines(FORMAT, ['Part U1 (T)', '1 1 0.1 0.1 1 A 0', 'Part U2 (B)', '1 1 0.2 0.1 1 A 0', 'Part U3 T', '1 1 0.3 0.1 1 A 0', 'Part U4 (t)', '1 1 0.4 0.1 1 A 0'], [])));
    expect(board.components.map(c => [c.ref, c.side])).toEqual([['U1', 'top'], ['U2', 'bottom'], ['U3', 'bottom'], ['U4', 'bottom']]);
    expect(board.pins.map(pin => pin.side)).toEqual(['top', 'bottom', 'bottom', 'bottom']);
    expect(notes(board)).toEqual(['2 records have a side marker other than (T) or (B) and are placed on the bottom side, as OpenBoardView does.']);
  });
  it('places each test point on its own side and numbers it by the probe', () => {
    const board = must(text(lines(FORMAT, PINS, ['*1 0.5 0.5 1 G (B) 3 N1', '*2 0.6 0.5 1 G (T) 3 N2', '*003 0.7 0.5 1 G (X) 3 N3'])));
    expect(board.components.slice(2).map(c => [c.ref, c.side])).toEqual([['TP:1', 'bottom'], ['TP:2', 'top'], ['TP:3', 'bottom']]);
    expect(board.pins.slice(4).map(pin => [pin.number, pin.side, pin.net])).toEqual([['1', 'bottom', 'N1'], ['2', 'top', 'N2'], ['3', 'bottom', 'N3']]);
  });
  it('discloses omitted pinless components, repeated references, ignored sections and stray lines', () => {
    const board = must(text(['preamble', 'second preamble', ...lines(FORMAT, ['Part E1 (T)', 'Part U1 (T)', '1 1 0.1 0.1 1 A 0', 'Part U1 (T)', '1 1 0.2 0.1 1 A 0'], []), '<<parts.asc>>', 'Part X (T)', 'whatever']));
    expect(board.components.map(c => c.ref)).toEqual(['U1', 'U1']);
    expect(notes(board)).toEqual([
      '1 component without pins was omitted because the file gives no position for it.',
      '1 component reuses a reference designator that another component already has; all are kept as separate components.',
      'Sections without a documented layout were ignored: <<parts.asc>>.',
      '2 non-empty lines outside any section were ignored.',
    ]);
  });
  it('keeps UTF-8 text and decodes legacy single-byte text', () => {
    expect(must(text(lines(FORMAT, ['Part U1 (T)', '1 1 0.1 0.1 1 3V3_μ 0'], [])), 'a.bdv').pins[0].net).toBe('3V3_μ');
    const legacy = bytes(text(lines(FORMAT, ['Part U1 (T)', '1 1 0.1 0.1 1 NETX 0'], [])));
    legacy[legacy.indexOf(0x58)] = 0xb5; // µ in windows-1252, invalid as UTF-8
    expect(must(legacy).pins[0].net).toBe('NETµ');
  });
  it('rejects malformed records with a precise BDV diagnostic', () => {
    const withPins = (...pins: string[]) => text(lines(FORMAT, pins, []));
    const cases: Array<[string, RegExp]> = [
      [text(lines(['0.0'], PINS)), /line 10: an outline point needs two coordinates/],
      [text(lines(['0.0 abc'], PINS)), /invalid outline Y "abc"/],
      [text(lines(['0.0 1e999'], PINS)), /invalid outline Y/],
      [text(lines(['0.0 0x10'], PINS)), /invalid outline Y/],
      [text(lines(['0.0 inf'], PINS)), /invalid outline Y/],
      [text(lines(['0.0 0.0 0.0'], PINS)), /two coordinates/],
      [withPins('Part U1'), /a Part line needs a reference and a side marker/],
      [withPins('Part U 1 (T)'), /a Part line needs a reference and a side marker/],
      [withPins('1 1 0.1 0.1 1 A 0'), /pin record appears before the first Part line/],
      [withPins('Part U1 (T)', '1 1 0.1 0.1 1 A'), /a pin needs id, name, X, Y, layer, net and probe/],
      [withPins('Part U1 (T)', 'x 1 0.1 0.1 1 A 0'), /invalid pin id "x"/],
      [withPins('Part U1 (T)', '1 1 0.1 q 1 A 0'), /invalid pin Y "q"/],
      [withPins('Part U1 (T)', '1 1 0.1 0.1 1.5 A 0'), /invalid pin layer/],
      [withPins('Part U1 (T)', '1 1 0.1 0.1 1 A -1'), /invalid probe "-1"/],
      [withPins('Part U1 (T)', '1 1 0.1 0.1 1 A B 0'), /invalid pin layer "A"/],
      [text(lines(FORMAT, PINS, ['5 0.1 0.2 1 G1 (T) 11 VCC'])), /marker character before its probe number/],
      [text(lines(FORMAT, PINS, ['*5 0.1 0.2 1 G1 (T) 11'])), /a test point needs probe, X, Y, type, grid, side, net id and net/],
      [text(lines(FORMAT, PINS, ['*x 0.1 0.2 1 G1 (T) 11 VCC'])), /invalid probe/],
      [text(lines(FORMAT, PINS, ['*5 0.1 0.2 z G1 (T) 11 VCC'])), /invalid test point type/],
    ];
    for (const [input, pattern] of cases) {
      const error = thrown(input);
      expect(error.message, input).toMatch(pattern);
      expect(error.code).toBe('INVALID_FORMAT');
      expect(error.format).toBe('Honhan BDV');
    }
  });
  it('rejects structural damage: short headers, duplicate sections, no pins', () => {
    const shortHeader = text(['<<format.asc>>', ...header(3, 'f'), ...lines().slice(13)]);
    expect(thrown(shortHeader).message).toMatch(/<<format\.asc>> has fewer than its 8 header lines/);
    expect(thrown(text([...lines(), '<<pins.asc>>'])).message).toMatch(/duplicate <<pins\.asc>> section/);
    expect(thrown(text(['<<format.asc>>', ...header(8, 'f'), ...FORMAT, '<<pins.asc>>', ...header(8, 'p')])).message).toMatch(/no component with pins was found/);
    expect(thrown(text(lines(FORMAT, ['Part E (T)'], []))).message).toMatch(/no component with pins/);
  });
  it('rejects coordinates outside the supported range after unit conversion', () => {
    const error = thrown(text(lines(['0 0', '1e12 0', '0 1'], PINS)));
    expect(error.message).toMatch(/exceeds the supported range/);
    expect(error.format).toBe('Honhan BDV');
  });
  it('bounds resources: component budget and line length', () => {
    const many = '<<format.asc>>\n' + header(8, 'f').join('\n') + '\n<<pins.asc>>\n' + header(8, 'p').join('\n') + '\n' + 'Part R1 (T)\n'.repeat(250_001);
    expect(thrown(many)).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const long = text(lines(['0 ' + '1'.repeat(4_194_305)], PINS));
    expect(thrown(long)).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const ok = text(lines(Array.from({ length: 2000 }, (_, index) => `${index} 0`), PINS));
    expect(must(ok).outline).toHaveLength(2000);
  });
  it('returns null for everything that is not BDV', () => {
    expect(parse('')).toBeNull();
    expect(parse('$HEADER\nGENCAD 1.4\n$ENDHEADER\n')).toBeNull();
    expect(parse(text(['<<format.asc>>', ...header(8, 'f'), ...FORMAT]))).toBeNull();
    expect(parse(text(['<<pins.asc>>', ...header(8, 'p'), ...PINS]))).toBeNull();
    expect(parse(Uint8Array.from([0, 1, 2, 3, 255, 254, 253]))).toBeNull();
    expect(parse('dd:1.3?,r?-=b')).toBeNull();
  });
  it('turns every truncation of a valid file into a board, null (marker incomplete) or a BoardFormatError', () => {
    const data = bytes(GOLDEN), recognized = GOLDEN.indexOf('<<pins.asc>>') + '<<pins.asc>>'.length;
    let boards = 0, failures = 0;
    for (let length = 0; length <= data.length; length++) {
      try {
        const board = parse(data.slice(0, length));
        if (board) boards++; else expect(length, `prefix ${length}`).toBeLessThan(recognized);
      } catch (error) {
        expect(error, `prefix ${length}`).toBeInstanceOf(BoardFormatError);
        expect(length, `prefix ${length}`).toBeGreaterThanOrEqual(recognized);
        failures++;
      }
    }
    expect(boards).toBeGreaterThan(0); expect(failures).toBeGreaterThan(0);
  });
});

describe('Honhan BDV: very long numeric tokens', () => {
  it('reads a 40,000-digit coordinate and rejects a malformed one in linear time', () => {
    const withCorner = (corner: string) => text(lines(['0.000 0.000', '2.000 0.000', '2.000 1.000', corner]));
    const started = performance.now();
    expect(must(withCorner(`0.000 ${'0'.repeat(40_000)}1.000`))).toEqual(must(GOLDEN));
    for (const token of [`${'1'.repeat(40_000)}x`, `${'1'.repeat(40_000)}e`, '1'.repeat(40_000)]) expect(thrown(withCorner(`0.000 ${token}`)).message).toMatch(/invalid/i);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('Honhan BDV (encoded)', () => {
  it('starts with the signature "dd:1.3?,r?-=bb" because the first line uses key 160', () => {
    const encoded = encode(lines());
    expect(new TextDecoder('latin1').decode(encoded.subarray(0, 14))).toBe('dd:1.3?,r?-=bb');
  });
  it('round-trips to exactly the plain board across the key wrap-around at 126 and 253 lines', () => {
    const many = Array.from({ length: 300 }, (_, index) => `${index + 1}  P${index + 1}  ${(0.1 + index * 0.001).toFixed(3)} 0.500  1  N${index % 7}  0`);
    for (const pins of [PINS, ['Part U1 (T)', ...many]]) {
      const plain = lines(FORMAT, pins);
      if (pins !== PINS) expect(plain.length).toBeGreaterThan(300);
      expect(must(encode(plain))).toEqual(must(text(plain)));
    }
    const wide = must(encode(lines(FORMAT, ['Part U1 (T)', ...many])));
    expect(wide.pins).toHaveLength(302);
    expect(wide.pins[299].number).toBe('P300');
    expect(wide.pins[299].x).toBeCloseTo(inch(0.1 + 299 * 0.001), 9);
  });
  it('refuses a stream encoded with a key that does not wrap (the schedule is load-bearing)', () => {
    const many = Array.from({ length: 140 }, (_, index) => `${index + 1}  P${index + 1}  0.100 0.500  1  N0  0`);
    const unwrapped: number[] = [];
    lines(FORMAT, ['Part U1 (T)', ...many]).forEach((line, index) => { for (const char of line) unwrapped.push((160 + index - char.charCodeAt(0)) & 0xff); unwrapped.push(13, 10); });
    expect(() => parse(Uint8Array.from(unwrapped))).toThrow(BoardFormatError);
  });
  it('never fails with anything but a BoardFormatError on a corrupted stream, and rejects a file without pins', () => {
    const encoded = encode(lines());
    for (let at = 0; at < encoded.length; at += 7) {
      const corrupted = encoded.slice(); corrupted[at] ^= 0x55;
      try { parse(corrupted); } catch (error) { expect(error, `byte ${at}`).toBeInstanceOf(BoardFormatError); }
    }
    expect(thrown(encode(['<<format.asc>>', ...header(8, 'f'), ...FORMAT])).message).toMatch(/missing <<pins\.asc>> section/);
  });
  it('turns every truncation of an encoded file into a board or a BoardFormatError once the signature is complete', () => {
    const data = encode(lines());
    for (let length = 0; length <= data.length; length++) {
      try {
        const board = parse(data.slice(0, length));
        if (!board) expect(length, `prefix ${length}`).toBeLessThan(14);
      } catch (error) {
        expect(error, `prefix ${length}`).toBeInstanceOf(BoardFormatError);
        expect(length, `prefix ${length}`).toBeGreaterThanOrEqual(14);
      }
    }
  });
});

describe('Honhan BDV: OpenBoardView edge conformance (synthetic, modelled on BDVFile.cpp)', () => {
  const latin1 = (value: string) => Uint8Array.from(value, ch => ch.charCodeAt(0) & 255);
  it('reads negative coordinates, trailing blanks and blank lines between records, with LF or CRLF line ends', () => {
    const negative = lines(['-0.500 -0.250', '2.000 -0.250', '2.000 1.000', '-0.500 1.000'], ['Part U1 (T)  ', '1  1  -0.100 -0.200  1  VCC  5  ', '', '2  2  0.150 -0.200  1  GND  0', '', 'Part R1 (B)', '1  1  1.500 -0.500  2  GND  7'], []);
    for (const eol of ['\n', '\r\n']) {
      const board = must(text(negative.map(row => row + '  '), eol));
      expect(board.outline[0]).toEqual({ x: inch(-0.5), y: inch(-0.25) });
      expect(pinRows(board)).toEqual([['U1', '1', inch(-0.1), inch(-0.2), 'VCC', 'top'], ['U1', '2', inch(0.15), inch(-0.2), 'GND', 'top'], ['R1', '1', inch(1.5), inch(-0.5), 'GND', 'bottom']]);
    }
  });
  it('decodes Windows-1252 bytes in component names and keeps the rest of the file intact', () => {
    const board = must(latin1(text(lines(FORMAT, ['Part U\xE9\xFC (T)', '1  1  0.100 0.200  1  N\xB5  5'], []))));
    expect(board.components[0].ref).toBe('U\u00e9\u00fc');
    expect(board.pins[0].net).toBe('N\u00b5');
  });
  it('places a side marker other than exactly (T) on the bottom, as BDVFile.cpp does, and discloses it', () => {
    const board = must(text(lines(FORMAT, ['Part U1 (t)', '1  1  0.100 0.200  1  VCC  5', 'Part U2 T', '1  1  0.300 0.200  1  VCC  5'], [])));
    expect(board.components.map(c => c.side)).toEqual(['bottom', 'bottom']);
    expect(notes(board)).toContain('2 records have a side marker other than (T) or (B) and are placed on the bottom side, as OpenBoardView does.');
  });
});
