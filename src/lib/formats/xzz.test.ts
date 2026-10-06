import { describe, expect, it } from 'vitest';
import { BoardFormatError } from './common';
import { createDes, xzzKeyParityValid } from './crypto';
import { parseXzz } from './xzz';

const encode = (text: string) => [...new TextEncoder().encode(text)];
const u32 = (value: number) => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
const i32 = (value: number) => u32(value >>> 0);
const zeros = (count: number) => Array<number>(count).fill(0);
const pad8 = (bytes: number[]) => [...bytes, ...zeros((8 - bytes.length % 8) % 8)];
const MIL = 2.54e-6;
/** Synthetic keys (no vendor key is used): bytes 0..6 (LSB first) have an even bit count, the leading byte an odd one. */
const GOOD_KEY = '0103030505060909', OTHER_KEY = '010f0c0a05030606';

function pin(name: string, x: number, y: number, netIndex: number, extra = 0): number[] {
  const body = [...zeros(4), ...i32(x), ...i32(y), ...zeros(8), ...u32(name.length), ...encode(name), ...zeros(32), ...u32(netIndex), ...zeros(extra)];
  return [0x09, ...u32(body.length), ...body];
}
function part(name: string, group: string, pins: number[][], extraRecords: number[] = []): number[] {
  const label = [0x06, ...u32(26 + 4 + name.length), ...zeros(26), ...u32(name.length), ...encode(name)];
  const body = [...zeros(18), ...u32(group.length), ...encode(group), ...label, ...pins.flat(), ...extraRecords];
  return [...u32(body.length), ...body];
}
const block = (type: number, payload: number[]) => [type, ...u32(payload.length), ...payload];
const line = (layer: number, x1: number, y1: number, x2: number, y2: number) => block(0x05, [...u32(layer), ...i32(x1), ...i32(y1), ...i32(x2), ...i32(y2), ...u32(10000), ...u32(0)]);
const arc = (layer: number, x: number, y: number, r: number, start: number, end: number) => block(0x01, [...u32(layer), ...i32(x), ...i32(y), ...u32(r), ...i32(start * 10000), ...i32(end * 10000), ...u32(10000), ...u32(0)]);
const testPad = (name: string, x: number, y: number, netIndex: number) => block(0x09, [...u32(1), ...i32(x), ...i32(y), ...zeros(8), ...u32(name.length), ...encode(name), ...zeros(6), ...u32(netIndex)]);
const netTable = (nets: Array<[number, string]>) => nets.flatMap(([index, name]) => [...u32(8 + name.length), ...u32(index), ...encode(name)]);

const PARTS = [
  part('U1', 'IC', [pin('1', 1_000_000, 2_000_000, 1), pin('2', 1_500_000, -2_000_000, 3)], block(0x05, zeros(12))),
  part('R1', 'RES', [pin('A', 0, 0, 2), pin('B', 10_000, 0, 99, 4)]),
];
interface Options { xor?: number; encrypt?: boolean; blocks?: number[][]; nets?: Array<[number, string]>; trailer?: number[]; mainOffset?: number }
function build({ xor = 0, encrypt = false, blocks, nets, trailer = [...encode('v6v6555v6v6'), 1, 2, 3], mainOffset }: Options = {}): Uint8Array {
  const partBlocks = PARTS.map(bytes => encrypt ? [...createDes(GOOD_KEY)(Uint8Array.from(pad8(bytes)), false)] : bytes).map(bytes => block(0x07, bytes));
  const list = blocks ?? [
    line(28, 0, 0, 40_000_000, 0), line(28, 40_000_000, 0, 40_000_000, 30_000_000), line(28, 40_000_000, 30_000_000, 0, 30_000_000), line(28, 0, 30_000_000, 0, 0),
    line(17, 5, 5, 6, 6), block(0x02, zeros(16)), block(0x06, encode('silk')), block(0x0b, zeros(3)), block(0x0b, zeros(1)),
    ...partBlocks, testPad('TP5', 3_000_000, 3_000_000, 2),
  ];
  const main = list.flat(), net = netTable(nets ?? [[1, 'GND'], [2, 'VCC'], [3, 'NC']]);
  const mainStart = 0x30, netStart = mainStart + 4 + main.length;
  const header = [...encode('XZZPCB'), ...zeros(mainStart - 6)]; // offsets at 0x20 (block list) and 0x28 (net table) are relative to 0x20
  header.splice(0x20, 4, ...u32((mainOffset ?? mainStart) - 0x20)); header.splice(0x28, 4, ...u32(netStart - 0x20));
  const clear = [...header, ...u32(main.length), ...main, ...u32(net.length), ...net, ...trailer];
  const data = Uint8Array.from(clear);
  if (xor) { const end = clear.length - trailer.length; for (let index = 0; index < end; index++) data[index] ^= xor; }
  return data;
}
const parse = (data: Uint8Array, xzzKey?: string) => parseXzz({ name: 'board.pcb', data, ...(xzzKey === undefined ? {} : { options: { xzzKey } }) });
function error(run: () => unknown): BoardFormatError {
  try { run(); } catch (caught) { if (caught instanceof BoardFormatError) return caught; throw caught; }
  throw new Error('expected a BoardFormatError');
}

describe('parseXzz', () => {
  it('parses a plaintext file: nets, components, pins in 1/10000 mil, test pads, outline from layer 28 and warnings', () => {
    const board = parse(build())!;
    expect(board.format).toBe('XZZ PCB'); expect(board.name).toBe('board');
    expect(board.components.map(part => [part.ref, part.side, part.package])).toEqual([['U1', 'top', ''], ['R1', 'top', ''], ['TP5', 'top', 'TESTPAD']]);
    const [u1, r1, tp5] = board.components;
    expect(board.pins).toHaveLength(5);
    expect(board.pins[0]).toMatchObject({ componentId: u1.id, number: '1', name: '1', net: 'GND', side: 'top', radius: 0 });
    expect(board.pins[0].x).toBeCloseTo(2.54, 9); expect(board.pins[0].y).toBeCloseTo(5.08, 9);
    expect(board.pins[1]).toMatchObject({ componentId: u1.id, number: '2', net: '' });
    expect(board.pins[1].x).toBeCloseTo(3.81, 9); expect(board.pins[1].y).toBeCloseTo(-5.08, 9);
    expect(board.pins[2]).toMatchObject({ componentId: r1.id, number: 'A', net: 'VCC', x: 0, y: 0 });
    expect(board.pins[3]).toMatchObject({ componentId: r1.id, number: 'B', net: '' });
    expect(board.pins[3].x).toBeCloseTo(0.0254, 9);
    expect(board.pins[4]).toMatchObject({ componentId: tp5.id, number: 'TP5', net: 'VCC' });
    expect(board.pins[4].x).toBeCloseTo(7.62, 9);
    expect(board.nets.map(net => [net.name, net.pinIds.length])).toEqual([['GND', 1], ['VCC', 2]]);
    expect(board.outline).toHaveLength(4);
    expect(board.bounds.minX).toBeCloseTo(0, 9); expect(board.bounds.maxX).toBeCloseTo(101.6, 9); expect(board.bounds.maxY).toBeCloseTo(76.2, 9);
    const notes = board.warnings.filter(w => w.key === 'parse.warning.formatNote').map(w => String(w.params?.message));
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(/component side is not decoded.*3 components/);
    expect(notes[1]).toMatch(/1 pin\(s\) reference net indices/);
    expect(notes[2]).toMatch(/0x0b x2/);
    expect(board.warnings).not.toContainEqual({ key: 'parse.warning.missingBoardOutline' });
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 5 } });
  });

  it('de-obfuscates the XOR header variant up to the plaintext marker and reads the same board', () => {
    const plain = parse(build())!, xored = parse(build({ xor: 0x5a }))!;
    expect(xored).toEqual(plain);
    const noMarker = parse(build({ xor: 0xa7, trailer: [] }))!; // without a marker the whole file is obfuscated
    expect(noMarker.pins).toEqual(plain.pins);
  });

  it('decrypts DES-ECB component records with the user key and only then asks for one', () => {
    const encrypted = build({ encrypt: true });
    expect(parse(encrypted, GOOD_KEY)).toEqual(parse(build()));
    expect(parse(encrypted, ' 0x' + GOOD_KEY + ' ')!.pins).toHaveLength(5);
    const missing = error(() => parse(encrypted));
    expect(missing).toMatchObject({ code: 'KEY_REQUIRED', format: 'XZZPCB', keyKind: 'xzz' });
    expect(error(() => parse(encrypted, '')).code).toBe('KEY_REQUIRED');
    expect(parse(build(), 'not-a-key')!.pins).toHaveLength(5); // plaintext records never consult the key
  });

  it('rejects wrong or malformed keys cleanly', () => {
    const encrypted = build({ encrypt: true });
    const wrong = error(() => parse(encrypted, OTHER_KEY));
    expect(wrong.code).toBe('INVALID_KEY'); expect(wrong.message).toMatch(/check the XZZ key/);
    expect(error(() => parse(encrypted, '0123')).message).toMatch(/16 hexadecimal/);
    const parity = error(() => parse(encrypted, '0000000000000000'));
    expect(parity.code).toBe('INVALID_KEY'); expect(parity.message).toMatch(/parity/);
    expect(xzzKeyParityValid(GOOD_KEY) && xzzKeyParityValid(OTHER_KEY)).toBe(true); // the wrong key is rejected by decryption, not by the parity guard
  });

  it('returns null for non-XZZ content', () => {
    expect(parse(new TextEncoder().encode('$HEADER\nGENCAD 1.4\n'))).toBeNull();
    expect(parse(Uint8Array.from([0x58, 0x5a, 0x5a]))).toBeNull();
    const data = build(); data[0x10] = 0; data[3] ^= 1;
    expect(parse(data)).toBeNull();
    expect(parse(new Uint8Array(0x40))).toBeNull();
  });

  it('fails on truncated headers, block lists and records instead of reading out of bounds', () => {
    const data = build();
    expect(error(() => parse(data.subarray(0, 0x28))).message).toMatch(/header is truncated/);
    expect(error(() => parse(data.subarray(0, 0x60))).message).toMatch(/exceeds the file|truncated/);
    expect(error(() => parse(build({ mainOffset: 0x7fffffff }))).message).toMatch(/truncated block list/);
    expect(error(() => parse(build({ blocks: [[0x05, ...u32(0xfffffff0), 1, 2, 3]] }))).message).toMatch(/exceeds the block list/);
    expect(error(() => parse(build({ blocks: [[0x05, 1, 2]] }))).message).toMatch(/truncated block header/);
    expect(error(() => parse(build({ blocks: [line(28, 0, 0, 1, 1).slice(0, 20)] }))).message).toMatch(/exceeds the block list/);
    expect(error(() => parse(build({ blocks: [block(0x05, zeros(20))] }))).message).toMatch(/line record is too short/);
    expect(error(() => parse(build({ blocks: [block(0x01, zeros(24))] }))).message).toMatch(/arc record is too short/);
    const emptyGroup = parse(build({ nets: [[1, 'G']], blocks: [block(0x07, part('U1', '', [pin('1', 0, 0, 1)]))] }))!; // an empty group name is legal
    expect(emptyGroup.pins.map(candidate => candidate.net)).toEqual(['G']);
    expect(error(() => parse(build({ blocks: [block(0x09, zeros(10))] }))).message).toMatch(/test pad record is too short/);
    expect(error(() => parse(build({ blocks: [block(0x09, [...zeros(20), ...u32(99), ...zeros(8)])] }))).message).toMatch(/test pad name exceeds/);
    expect(error(() => parse(build({ blocks: [block(0x02, [])] }))).message).toMatch(/no component records/);
  });

  it('validates net records and component sub-records', () => {
    const shortNet = build(); const netStart = new DataView(shortNet.buffer).getUint32(0x28, true) + 0x20;
    shortNet.set(u32(4), netStart + 4); // first net record claims 4 bytes (< 8)
    expect(error(() => parse(shortNet)).message).toMatch(/net record length/);
    const overflowNet = build(); overflowNet.set(u32(0xffff), netStart + 4);
    expect(error(() => parse(overflowNet)).message).toMatch(/net record length/);
    const longPin = part('U1', 'IC', [], [0x09, ...u32(500), ...zeros(70)]);
    expect(error(() => parse(build({ blocks: [block(0x07, longPin)] }))).message).toMatch(/sub-record exceeds component U1/);
    const shortPin = part('U1', 'IC', [], [0x09, ...u32(20), ...zeros(20)]);
    expect(error(() => parse(build({ blocks: [block(0x07, shortPin)] }))).message).toMatch(/pin record is too short/);
    const longName = part('U1', 'IC', [], [0x09, ...u32(64), ...zeros(20), ...u32(50), ...zeros(40)]);
    expect(error(() => parse(build({ blocks: [block(0x07, longName)] }))).message).toMatch(/pin name exceeds/);
    const unknownSub = part('U1', 'IC', [pin('1', 0, 0, 1)], [0x7e, ...u32(2), 0, 0]);
    expect(error(() => parse(build({ blocks: [block(0x07, unknownSub)] }))).message).toMatch(/unsupported component sub-record type 0x7e in U1/);
    const padded = part('U1', 'IC', [pin('1', 0, 0, 1)], [0, 0, 0]); // zero bytes are alignment padding, as upstream skips them
    expect(parse(build({ blocks: [block(0x07, padded)] }))!.pins).toHaveLength(1);
    const ciphertextLike = block(0x07, zeros(9)); // neither a plausible record nor whole DES blocks: corrupt, whatever key is given
    expect(error(() => parse(build({ blocks: [ciphertextLike] }), GOOD_KEY))).toMatchObject({ code: 'INVALID_FORMAT', message: expect.stringMatching(/9 bytes is corrupt/) });
  });

  it('reports a corrupt plaintext component block as such instead of asking for a key', () => {
    // 3 bytes, 9 bytes (not whole DES blocks) and 56 bytes (whole blocks, but shorter than the smallest record): no key could help.
    for (const corrupt of [block(0x07, [1, 2, 3]), block(0x07, zeros(9)), block(0x07, zeros(56))]) {
      const failure = error(() => parse(build({ blocks: [corrupt] })));
      expect(failure).toMatchObject({ code: 'INVALID_FORMAT', format: 'XZZPCB' });
      expect(failure.keyKind).toBeUndefined();
      expect(failure.message).toMatch(/bytes is corrupt/);
      expect(error(() => parse(build({ blocks: [corrupt] }), GOOD_KEY)).code).toBe('INVALID_FORMAT');
    }
    // Whole DES blocks of a plausible length can only be told apart by decrypting them, so they still ask for the key.
    expect(error(() => parse(build({ blocks: [block(0x07, zeros(64))] })))).toMatchObject({ code: 'KEY_REQUIRED', keyKind: 'xzz' });
  });

  it('approximates layer-28 arcs with nine chords and ignores other layers', () => {
    const blocks = [line(28, 0, 0, 100_000, 0), line(28, 100_000, 0, 100_000, 100_000), arc(28, 50_000, 100_000, 50_000, 0, 180), line(28, 0, 100_000, 0, 0), arc(17, 0, 0, 10, 0, 90), block(0x07, PARTS[0])];
    const board = parse(build({ blocks }))!;
    // Four line corners (the two arc endpoints coincide with two of them and merge within 1 mil) plus eight interior chord vertices.
    expect(board.outline).toHaveLength(4 + 8);
    const onArc = board.outline.filter(point => Math.abs(Math.hypot(point.x - 50_000 * MIL, point.y - 100_000 * MIL) - 50_000 * MIL) < 1e-9 && point.y > 100_000 * MIL);
    expect(onArc).toHaveLength(8);
    expect(board.bounds.maxY).toBeCloseTo((100_000 + 50_000 * Math.sin(80 * Math.PI / 180)) * MIL, 9); // the 80/100-degree chord vertices are the highest
  });

  it('enforces the import size limit before touching the body', () => {
    const data = new Uint8Array(64 * 1024 * 1024 + 1); data.set(new TextEncoder().encode('XZZPCB'));
    expect(error(() => parse(data)).code).toBe('LIMIT_EXCEEDED');
  });

  it('discloses cutouts: an inner closed loop is kept out of the outline and reported (outer + inner rectangle)', () => {
    const rect = (x0: number, y0: number, x1: number, y1: number) => [line(28, x0, y0, x1, y0), line(28, x1, y0, x1, y1), line(28, x1, y1, x0, y1), line(28, x0, y1, x0, y0)];
    const board = parse(build({ blocks: [...rect(0, 0, 40_000_000, 30_000_000), ...rect(10_000_000, 10_000_000, 20_000_000, 20_000_000), block(0x07, PARTS[0])] }))!;
    expect(board.warnings).toContainEqual({ key: 'parse.warning.boardCutouts' });
    expect(board.warnings.filter(w => w.key === 'parse.warning.boardCutouts')).toHaveLength(1);
    expect(board.outline).toHaveLength(4);
    expect(board.bounds.maxX).toBeCloseTo(101.6, 9); expect(board.bounds.maxY).toBeCloseTo(76.2, 9);
    const single = parse(build({ blocks: [...rect(0, 0, 40_000_000, 30_000_000), block(0x07, PARTS[0])] }))!;
    expect(single.warnings).not.toContainEqual({ key: 'parse.warning.boardCutouts' });
  });

  it('discloses open outline chains and never closes them', () => {
    const square = [line(28, 0, 0, 40_000_000, 0), line(28, 40_000_000, 0, 40_000_000, 30_000_000), line(28, 40_000_000, 30_000_000, 0, 30_000_000), line(28, 0, 30_000_000, 0, 0)];
    const spur = parse(build({ blocks: [...square, line(28, 40_000_000, 0, 50_000_000, 0), block(0x07, PARTS[0])] }))!;
    expect(spur.outline).toHaveLength(4);
    expect(spur.warnings.filter(w => w.key === 'parse.warning.formatNote').map(w => String(w.params?.message))).toContain('XZZ PCB: 1 open outline chain on layer 28 was not closed and is not drawn.');
    const open = parse(build({ blocks: [square[0], square[1], square[2], block(0x07, PARTS[0])] }))!;
    expect(open.warnings).toContainEqual({ key: 'parse.warning.missingBoardOutline' });
    expect(open.warnings.some(w => String(w.params?.message).includes('open outline chain'))).toBe(true);
  });

  it('carries keyKind and the XZZPCB format only on key errors', () => {
    const encrypted = build({ encrypt: true });
    for (const failure of [error(() => parse(encrypted)), error(() => parse(encrypted, '')), error(() => parse(encrypted, OTHER_KEY)), error(() => parse(encrypted, '0123')), error(() => parse(encrypted, '0000000000000000'))]) {
      expect(['KEY_REQUIRED', 'INVALID_KEY']).toContain(failure.code);
      expect(failure).toMatchObject({ format: 'XZZPCB', keyKind: 'xzz', name: 'BoardFormatError' });
    }
    const structural = error(() => parse(build({ blocks: [block(0x09, zeros(10))] })));
    expect(structural).toMatchObject({ code: 'INVALID_FORMAT', format: 'XZZPCB' }); expect(structural.keyKind).toBeUndefined();
  });

  it('round-trips a DES-encrypted board: the same key opens it, wrong keys do not, and obfuscation composes with encryption', () => {
    const plain = parse(build())!;
    expect(parse(build({ encrypt: true, xor: 0x33 }), GOOD_KEY)).toEqual(plain);
    expect(error(() => parse(build({ encrypt: true, xor: 0x33 }), OTHER_KEY)).code).toBe('INVALID_KEY');
    const mixed = build({ blocks: [block(0x07, PARTS[0]), block(0x07, [...createDes(GOOD_KEY)(Uint8Array.from(pad8(PARTS[1])), false)])] }); // plain and encrypted records side by side
    expect(parse(mixed, GOOD_KEY)!.components.map(part => part.ref)).toEqual(['U1', 'R1']);
  });

  it('B16: int32 coordinates and uint32 arc radii can never leave the canonical range; extremes stay finite', () => {
    const extreme = [line(28, -2_147_483_648, -2_147_483_648, 2_147_483_647, -2_147_483_648), line(28, 2_147_483_647, -2_147_483_648, 2_147_483_647, 2_147_483_647), line(28, 2_147_483_647, 2_147_483_647, -2_147_483_648, -2_147_483_648),
      arc(28, 0, 0, 0xffffffff, 0, 90), block(0x07, part('U1', 'IC', [pin('1', 2_147_483_647, -2_147_483_648, 1)]))];
    const board = parse(build({ blocks: extreme }))!;
    for (const value of Object.values(board.bounds)) { expect(Number.isFinite(value)).toBe(true); expect(Math.abs(value)).toBeLessThan(1e5); }
    expect(board.pins[0].x).toBeCloseTo(2_147_483_647 * MIL, 9);
  });

  it('B40: conflicting duplicate numeric net ids are rejected in either order, never resolved by record order', () => {
    const control = parse(build({ nets: [[1, 'GND'], [2, 'VCC'], [3, 'NC']] }))!;
    expect(control.nets.map(net => net.name)).toEqual(['GND', 'VCC']);
    for (const nets of [[[1, 'GND'], [2, 'VCC'], [3, 'NC'], [1, 'VCC']], [[1, 'VCC'], [2, 'VCC'], [3, 'NC'], [1, 'GND']], [[2, 'VCC'], [1, 'VCC'], [3, 'NC'], [1, 'GND']]] as Array<Array<[number, string]>>) {
      const failure = error(() => parse(build({ nets })));
      expect(failure).toMatchObject({ code: 'INVALID_FORMAT', format: 'XZZPCB' });
      expect(failure.message).toMatch(/net id 1 is defined twice with different names/);
      expect(failure.keyKind).toBeUndefined();
    }
    expect(parse(build({ nets: [[1, 'GND'], [2, 'VCC'], [3, 'NC'], [1, 'GND']] }))).toEqual(control); // an identical repeated row is harmless
  });

  it('decodes names without byte-order-mark sniffing (hostile bytes must not become a TypeError)', () => {
    const data = build({ blocks: [block(0x07, part('ABCD', 'IC', [pin('1', 0, 0, 1)]))] });
    const at = data.findIndex((_, index) => index > 0x30 && data[index] === 0x41 && data[index + 1] === 0x42 && data[index + 2] === 0x43 && data[index + 3] === 0x44);
    expect(at).toBeGreaterThan(0);
    data.set([0xff, 0xfe, 0x41, 0xd8], at);
    expect(parse(data)!.components[0].ref).toBe('\u00ff\u00fe\u0041\u00d8');
  });

  it('bounds record counts (LIMIT_EXCEEDED) for net tables, outline segments and components', { timeout: 120_000 }, () => {
    const assemble = (main: Uint8Array, net: Uint8Array): Uint8Array => {
      const out = new Uint8Array(0x30 + 4 + main.length + 4 + net.length), view = new DataView(out.buffer), netAt = 0x34 + main.length;
      out.set(encode('XZZPCB')); view.setUint32(0x20, 0x10, true); view.setUint32(0x28, netAt - 0x20, true);
      view.setUint32(0x30, main.length, true); out.set(main, 0x34); view.setUint32(netAt, net.length, true); out.set(net, netAt + 4);
      return out;
    };
    const oneNet = new Uint8Array(9); oneNet.set([9]); oneNet.set([1], 4); oneNet[8] = 0x41;
    const validMain = Uint8Array.from(block(0x07, PARTS[0]));
    const nets = new Uint8Array(9 * 1_000_001), netView = new DataView(nets.buffer);
    for (let index = 0; index < 1_000_001; index++) { netView.setUint32(index * 9, 9, true); netView.setUint32(index * 9 + 4, index, true); nets[index * 9 + 8] = 0x41; }
    expect(error(() => parse(assemble(validMain, nets))).code).toBe('LIMIT_EXCEEDED');
    expect(parse(assemble(validMain, oneNet))!.components).toHaveLength(1);
    const segment = Uint8Array.from(line(28, 0, 0, 1000, 1000)), many = new Uint8Array(segment.length * 1_000_001 + validMain.length);
    for (let index = 0; index < 1_000_001; index++) many.set(segment, index * segment.length);
    many.set(validMain, segment.length * 1_000_001);
    expect(error(() => parse(assemble(many, oneNet))).code).toBe('LIMIT_EXCEEDED');
    const pad = Uint8Array.from(testPad('T', 0, 0, 1)), pads = new Uint8Array(pad.length * 250_001);
    for (let index = 0; index < 250_001; index++) pads.set(pad, index * pad.length);
    expect(error(() => parse(assemble(pads, oneNet))).code).toBe('LIMIT_EXCEEDED');
  });

  it('rejects list offsets that point into the fixed header', () => {
    expect(error(() => parse(build({ mainOffset: 0x20 }))).message).toMatch(/header/);
    expect(error(() => parse(build({ mainOffset: 0x2c - 1 }))).message).toMatch(/header/);
  });
});

describe('parseXzz malformed input', () => {
  const variants: Array<[string, Uint8Array, string | undefined]> = [['plain', build(), undefined], ['xor-obfuscated', build({ xor: 0x5a }), undefined], ['DES-encrypted', build({ encrypt: true }), GOOD_KEY]];
  it.each(variants)('%s: every strict prefix is unrecognized (shorter than the signature) or a BoardFormatError, until only the trailer is cut', (_name, data, key) => {
    const trailer = 'v6v6555v6v6'.length + 3; // bytes after the net table that no list refers to
    expect(parse(data, key)).not.toBeNull();
    for (let length = 0; length < data.length - trailer; length++) {
      try { expect(parse(data.subarray(0, length), key), `length ${length}`).toBeNull(); expect(length, `length ${length}`).toBeLessThanOrEqual(0x10); }
      catch (caught) { if (!(caught instanceof BoardFormatError)) throw caught; }
    }
    for (let length = data.length - trailer; length < data.length; length++) expect(parse(data.subarray(0, length), key), `length ${length}`).not.toBeNull();
  });
  it.each(variants)('%s: every single-byte corruption is a board, null or a BoardFormatError', (_name, data, key) => {
    for (let index = 0; index < data.length; index++) {
      for (const mask of [0x01, 0x80, 0xff]) {
        const damaged = Uint8Array.from(data); damaged[index] ^= mask;
        try { parse(damaged, key); } catch (caught) { expect(caught, `byte ${index} ^ ${mask}`).toBeInstanceOf(BoardFormatError); }
      }
    }
  });
});


describe('parseXzz: vendor "no connection" net names (BRDBoard.cpp applies the UNCONNECTED prefix rule to every boardview format)', () => {
  it('treats UNCONNECTED<n> as no net, in component pins and test pads, and keeps look-alike names', () => {
    const board = parse(build({ nets: [[1, 'GND'], [2, 'UNCONNECTEDLY'], [3, 'UNCONNECTED7']] }))!;
    expect(board.pins.map(p => [p.number, p.net])).toEqual([['1', 'GND'], ['2', ''], ['A', 'UNCONNECTEDLY'], ['B', ''], ['TP5', 'UNCONNECTEDLY']]);
    expect(board.nets.map(net => net.name).sort()).toEqual(['GND', 'UNCONNECTEDLY']);
    const notes = board.warnings.filter(w => w.key === 'parse.warning.formatNote').map(w => String(w.params?.message));
    expect(notes).toContain('1 pin marked UNCONNECTED by the exporter is shown without a net.');
    const unnumbered = parse(build({ nets: [[1, 'GND'], [2, 'UNCONNECTED'], [3, 'UNCONNECTED12']] }))!;
    expect(unnumbered.nets.map(net => net.name)).toEqual(['GND']);
    expect(unnumbered.warnings.filter(w => w.key === 'parse.warning.formatNote').map(w => String(w.params?.message))).toContain('3 pins marked UNCONNECTED by the exporter are shown without a net.');
  });
});

describe('parseXzz: components without pins (OpenBoardView keeps them; this reader cannot place them)', () => {
  it('omits a component block that carries no pin record, discloses it, and still opens the board', () => {
    const bytes = build({ blocks: [block(0x07, part('MH1', 'HOLE', [])), block(0x07, PARTS[1]), block(0x07, part('LOGO', 'ART', [], block(0x05, zeros(12))))] });
    const board = parse(bytes)!;
    expect(board.components.map(c => c.ref)).toEqual(['R1']);
    const notes = board.warnings.filter(w => w.key === 'parse.warning.formatNote').map(w => String(w.params?.message));
    expect(notes).toContain('2 components without pins were omitted because the file gives no position for them.');
    expect(notes[0]).toMatch(/component side is not decoded.*1 components/);
    expect(error(() => parse(build({ blocks: [block(0x07, part('MH1', 'HOLE', []))] }))).message).toMatch(/no components were found/);
  });
});
