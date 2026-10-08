import { describe, expect, it } from 'vitest';
import { BoardFormatError } from './common';
import { readTvwLayers } from './tvw-layers';

// Original synthetic records from the documented grammar and independently observed optional-field boundaries.
const u32 = (n: number) => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const words = (...values: number[]) => values.flatMap(u32);
const text = (s: string) => [s.length, ...new TextEncoder().encode(s)];
const definition = (firstDimension = 1200, secondDimension = 4000, shape = 1) => words(1, firstDimension, secondDimension, shape, 0, 0);
const polygon = () => [...words(1, 1200, 4000, 5, 0), ...text('Original'), ...words(-600, -2000, 600, 2000, 1, 2, 1, 0, 0, 4), ...words(-600, -2000, -600, 2000, 600, 2000, 600, -2000)];
const composite = () => [...words(1, 1200, 4000, 5, 0), ...text('Lines'), ...words(-600, -2000, 600, 2000, 2, 5, 1, 0, 0, -550, -1950, -550, 1950, 100, 5, 1, 0, 0, 550, -1950, 550, 1950, 100)];
interface PadInput { net?: number; dcode?: number; x?: number; y?: number; plain?: boolean; extended?: boolean; hole?: boolean; round?: boolean; geometry?: number }
const pad = ({ net = 0, dcode = 10, x = 250, y = 100, plain = false, extended = false, hole = false, round = false, geometry }: PadInput = {}) => {
  const base = words(net, dcode, y, x);
  if (plain) return [...base, 0, 0, 2];
  const prefix = [...base, 1, 1, extended ? 1 : 0, ...(extended ? words(0, 0, 0) : [])];
  return round
    ? [...prefix, 0, ...words(1, 0), 0, ...words(600, 2000), 0]
    : [...prefix, geometry ?? 1, ...words(-600, -2000, 600, 2000), hole ? 1 : 0, ...(hole ? words(0, 0, 1000, 2000) : []), 5];
};
function layer(pads: number[][] = [pad()], defs: number[][] = [definition()], type = 1) {
  const header = [...words(0, 3, 2, 1), ...text(type === 1 ? 'TOP' : 'BOTTOM'), ...text('Original layer'), ...text(''), ...words(type, 255, 255, defs.length + 10)];
  const table = [...defs.flat(), ...words(1, 0, 1)], padOffset = header.length + table.length;
  return { data: Uint8Array.from([...header, ...table, ...words(pads.length, 2), ...pads.flat(), ...words(1, 0, 0, 10, 100, 250, 200, 350)]), padOffset, headerCountOffset: header.length - 4 };
}

describe('readTvwLayers', () => {
  it('reads declared top/bottom layers with exact nets and swapped coordinate/dimension axes', () => {
    const top = layer([pad({ net: 1 })]), bottom = layer([pad({ net: -1 })], [definition()], 2);
    const result = readTvwLayers(Uint8Array.from([...top.data, ...bottom.data]), 2);
    expect(result.skippedLayers).toBe(0);
    expect(result.layers.map(x => [x.name, x.side, x.pads.length])).toEqual([['TOP', 'top', 1], ['BOTTOM', 'bottom', 1]]);
    expect(result.layers[0].pads[0]).toMatchObject({ x: 250, y: 100, width: 4000, height: 1200, net: 1, dcode: 10, side: 'top', shapeType: 1 });
    expect(result.layers[0].pads[0].bounds).toEqual({ minX: -2000, minY: -600, maxX: 2000, maxY: 600 });
    expect(result.layers[1].pads[0].net).toBe(-1);
    expect(result.layers[0].pads[0].sourceOffset).toBe(top.padOffset + 8);
  });

  it('traverses all observed PAD payload sizes without interpreting opaque flags as board sides', () => {
    const payloads = [pad({ plain: true }), pad(), pad({ hole: true }), pad({ extended: true }), pad({ hole: true, extended: true }), pad({ round: true })];
    expect(payloads.map(x => x.length)).toEqual([19, 38, 54, 50, 66, 38]);
    const source = layer(payloads), result = readTvwLayers(source.data, 1);
    expect(result.skippedLayers).toBe(0); expect(result.layers[0].pads).toHaveLength(6);
    expect(result.layers[0].pads.every(x => x.side === 'top' && x.width === 4000 && x.height === 1200)).toBe(true);
    expect(result.layers[0].end).toBe(source.padOffset + 8 + payloads.reduce((n, x) => n + x.length, 0));
  });

  it('uses explicitly declared per-pad dimensions when they differ from the D-code table', () => {
    const result = readTvwLayers(layer([pad()], [definition(200, 400)]).data, 1);
    expect(result.layers[0].pads[0]).toMatchObject({ width: 4000, height: 1200 });
    const plain = readTvwLayers(layer([pad({ plain: true })], [definition(200, 400)]).data, 1);
    expect(plain.layers[0].pads[0]).toMatchObject({ width: 400, height: 200 });
  });

  it('reads count-delimited custom polygons and skips rendering composite line macros with a known cursor', () => {
    const source = layer([pad(), pad({ dcode: 11 })], [polygon(), composite()]), result = readTvwLayers(source.data, 1);
    expect(result.skippedLayers).toBe(0);
    expect(result.layers[0].pads[0].polygon).toEqual([{ x: -2000, y: -600 }, { x: 2000, y: -600 }, { x: 2000, y: 600 }, { x: -2000, y: 600 }]);
    expect(result.layers[0].pads[1]).toMatchObject({ dcode: 11, shapeType: 5, width: 4000, height: 1200 });
    expect(result.layers[0].pads[1].polygon).toBeUndefined();
  });

  it.each([
    ['invalid dcode', pad({ dcode: 0 })], ['out-of-range dcode', pad({ dcode: 11 })], ['invalid net', pad({ net: 2 })],
    ['invalid negative net', pad({ net: -2 })], ['coordinate overflow', pad({ x: 2_000_001 })], ['unknown geometry', pad({ geometry: 9 })],
  ])('drops the entire layer on %s, including earlier valid pads, while preserving another valid layer', (_label, bad) => {
    const source = layer([pad(), bad]), valid = layer([pad()], [definition()], 2);
    const result = readTvwLayers(Uint8Array.from([...source.data, ...valid.data]), 2);
    expect(result.skippedLayers).toBe(1);
    expect(result.layers).toHaveLength(1); expect(result.layers[0].side).toBe('bottom');
  });

  it('rejects shifted/truncated optional payloads and a bad following line-list boundary without leaking partial pads', () => {
    const source = layer([pad(), pad({ hole: true })]);
    const marker = source.data.slice(); new DataView(marker.buffer).setUint32(source.padOffset + 4, 3, true);
    const truncated = source.data.subarray(0, source.data.length - 1);
    const shifted = Uint8Array.from([...source.data.subarray(0, source.padOffset + 9), 0, ...source.data.subarray(source.padOffset + 9)]);
    const line = source.data.slice(); line[line.length - 27] = 1; // nonzero line-list reserved word
    for (const data of [marker, truncated, shifted, line]) {
      const result = readTvwLayers(data, 1);
      expect(result.layers).toEqual([]); expect(result.skippedLayers).toBe(1);
    }
  });

  it('requires the complete D-code count and [1,0,1] terminator, and rejects unknown macro primitives', () => {
    const source = layer(), badCount = source.data.slice(), badEnd = source.data.slice();
    new DataView(badCount.buffer).setUint32(source.headerCountOffset, 12, true);
    badEnd[source.padOffset - 4] = 2;
    const unknown = polygon(); unknown[20 + text('Original').length + 20] = 7; // first custom primitive type
    for (const data of [badCount, badEnd, layer([pad()], [unknown]).data]) expect(readTvwLayers(data, 1).layers).toEqual([]);
  });

  it('enforces import, declared definition and declared pad budgets before allocating records', () => {
    const source = layer(), defs = source.data.slice(), pads = source.data.slice();
    new DataView(defs.buffer).setUint32(source.headerCountOffset, 250_011, true);
    new DataView(pads.buffer).setUint32(source.padOffset, 1_000_001, true);
    for (const data of [defs, pads, new Uint8Array(64 * 1024 * 1024 + 1)]) {
      try { readTvwLayers(data, 1); throw new Error('expected a limit error'); }
      catch (error) { expect(error).toBeInstanceOf(BoardFormatError); expect((error as BoardFormatError).code).toBe('LIMIT_EXCEEDED'); }
    }
  });

  it('ignores unstructured pad-looking bytes and reports no layer for incomplete headers', () => {
    expect(readTvwLayers(Uint8Array.from(pad()), 2)).toEqual({ layers: [], skippedLayers: 0, headers: [] });
    expect(readTvwLayers(new Uint8Array(30), 2)).toEqual({ layers: [], skippedLayers: 0, headers: [] });
  });

  it('lists every layer header in file order, counts the kinds it does not read and decodes only top and bottom', () => {
    const other = (type: number, name = 'Original aux') => Uint8Array.from([...words(0, 3, 2, 1), ...text(name), ...text('Original layer'), ...text(''), ...words(type, 255, 255, 11), ...words(0, 0, 0)]);
    const top = layer([pad({ net: 1 })]), bottom = layer([pad({ net: 0 })], [definition()], 2);
    const data = Uint8Array.from([...other(3, 'Aux A'), ...other(4, 'Silk'), ...top.data, ...other(5, 'Mask'), ...bottom.data]);
    const result = readTvwLayers(data, 2);
    expect(result.skippedLayers).toBe(0);
    expect(result.headers.map(header => [header.index, header.name, header.type, header.layer?.side])).toEqual([
      [0, 'Aux A', 3, undefined], [1, 'Silk', 4, undefined], [2, 'TOP', 1, 'top'], [3, 'Mask', 5, undefined], [4, 'BOTTOM', 2, 'bottom']]);
    expect(result.layers.map(item => item.side)).toEqual(['top', 'bottom']);
    expect(result.headers[2].layer).toBe(result.layers[0]);
  });

  it('does not count a header whose type word is implausible, and bounds the number of headers it lists', () => {
    const other = (type: number) => Uint8Array.from([...words(0, 3, 2, 1), ...text('Aux'), ...text('Original layer'), ...text(''), ...words(type, 0, 0, 11), ...words(0, 0)]);
    expect(readTvwLayers(other(0x10000), 1).headers).toEqual([]);
    expect(readTvwLayers(Uint8Array.from([...other(3), ...other(255)]), 1).headers.map(header => header.type)).toEqual([3, 255]);
    const many = Uint8Array.from(Array.from({ length: 1100 }, () => [...other(3)]).flat());
    try { readTvwLayers(many, 1); throw new Error('expected a limit error'); }
    catch (error) { expect(error).toBeInstanceOf(BoardFormatError); expect((error as BoardFormatError).code).toBe('LIMIT_EXCEEDED'); }
  });
});
