import { describe, expect, it } from 'vitest';
import type { BoardPin, Point } from '../types';
import {
  BoardFormatError, MAX_IMPORT_BYTES, MAX_MM, TextDecodeError, asciiPrefix, buildBoard, decodeText, note, number, padExtent, startsWithBytes,
  stitchOutline, stitchOutlines, textInput, vendorDisconnected, type RawBoard, type RawPart, type RawPin,
} from './common';

const p = (x: number, y: number): Point => ({ x, y });
const edge = (a: Point, b: Point): readonly [Point, Point] => [a, b];
const rectangle = (x0: number, y0: number, x1: number, y1: number) => {
  const a = p(x0, y0), b = p(x1, y0), c = p(x1, y1), d = p(x0, y1);
  return [edge(a, b), edge(b, c), edge(c, d), edge(d, a)];
};
const sorted = (points: Point[]) => [...points].sort((a, b) => a.x - b.x || a.y - b.y);
const input = (name = 'board.brd') => textInput('', name);
const part = (key = 'U1', extra: Partial<RawPart> = {}): RawPart => ({ key, ref: key, side: 'top', ...extra });
const pin = (partKey: string, number: string, x: number, y: number, extra: Partial<RawPin> = {}): RawPin => ({ part: partKey, number, x, y, ...extra });
const raw = (overrides: Partial<RawBoard> = {}): RawBoard => ({ format: 'TEST', unitsToMm: 1, parts: [part()], pins: [pin('U1', '1', 0, 0, { net: 'GND' })], outline: [p(0, 0), p(10, 0), p(10, 10), p(0, 10)], ...overrides });
const keys = (board: { warnings: { key: string }[] }) => board.warnings.map(warning => warning.key);

describe('stitchOutlines (B05)', () => {
  const A = p(0, 0), B = p(10, 0), C = p(10, 10), D = p(0, 10);
  it('keeps a closed rectangle when an open spur shares vertex B (inbox repro, order AB, spur, BC, CD, DA)', () => {
    const outline = stitchOutline([edge(A, B), edge(B, p(15, 0)), edge(B, C), edge(C, D), edge(D, A)]);
    expect(outline).toEqual([A, B, C, D]);
    const { loops, openChains } = stitchOutlines([edge(A, B), edge(B, p(15, 0)), edge(B, C), edge(C, D), edge(D, A)]);
    expect(loops).toHaveLength(1); expect(openChains).toBe(1);
  });
  it('keeps a 4x3 rectangle preceded by a leading open spur (-1,0)->(0,0) (inbox repro)', () => {
    const edges = [edge(p(-1, 0), p(0, 0)), edge(p(0, 0), p(4, 0)), edge(p(4, 0), p(4, 3)), edge(p(4, 3), p(0, 3)), edge(p(0, 3), p(0, 0))];
    expect(stitchOutline(edges)).toEqual([p(0, 0), p(4, 0), p(4, 3), p(0, 3)]);
    expect(stitchOutlines(edges)).toMatchObject({ openChains: 1 });
  });
  it('returns the four corners of a pure rectangle and no open chains', () => {
    expect(stitchOutline(rectangle(0, 0, 10, 10))).toEqual([A, B, C, D]);
    expect(stitchOutlines(rectangle(0, 0, 10, 10))).toEqual({ loops: [[A, B, C, D]], openChains: 0 });
  });
  it('returns the largest of two disjoint loops and lists both, largest first', () => {
    const result = stitchOutlines([...rectangle(20, 20, 22, 22), ...rectangle(0, 0, 10, 10)]);
    expect(result.loops).toHaveLength(2);
    expect(sorted(result.loops[0])).toEqual(sorted([A, B, C, D]));
    expect(sorted(result.loops[1])).toEqual(sorted([p(20, 20), p(22, 20), p(22, 22), p(20, 22)]));
    expect(stitchOutline([...rectangle(20, 20, 22, 22), ...rectangle(0, 0, 10, 10)])).toHaveLength(4);
  });
  it('never closes open chains: a polyline yields no loop and one chain, two polylines two chains', () => {
    expect(stitchOutline([edge(p(0, 0), p(2, 0)), edge(p(2, 0), p(2, 2))])).toEqual([]);
    expect(stitchOutlines([edge(p(0, 0), p(2, 0)), edge(p(2, 0), p(2, 2))])).toEqual({ loops: [], openChains: 1 });
    expect(stitchOutlines([edge(p(0, 0), p(2, 0)), edge(p(5, 5), p(6, 6)), edge(p(6, 6), p(7, 7))]).openChains).toBe(2);
    expect(stitchOutlines([])).toEqual({ loops: [], openChains: 0 });
  });
  it('joins reversed and unordered edges into one loop', () => {
    const outline = stitchOutline([edge(C, D), edge(B, A), edge(D, A), edge(C, B)]);
    expect(outline).toHaveLength(4);
    expect(sorted(outline)).toEqual(sorted([A, B, C, D]));
  });
  it('merges vertices within the tolerance and keeps them apart beyond it', () => {
    const almost = [edge(A, B), edge(p(10, 1e-7), C), edge(C, D), edge(D, p(1e-7, 0))];
    expect(stitchOutline(almost)).toHaveLength(4);
    expect(stitchOutline(almost, 1e-9)).toEqual([]);
    // Beyond the tolerance A-B stands alone and B'-C-D-A' is a second chain, so there are two open chains.
    expect(stitchOutlines(almost, 1e-9)).toEqual({ loops: [], openChains: 2 });
  });
  it('ignores duplicate edges (both directions) and zero-length edges', () => {
    const result = stitchOutlines([edge(A, B), edge(B, A), edge(A, B), ...rectangle(0, 0, 10, 10), edge(C, C), edge(p(5, 5), p(5, 5 + 1e-9))]);
    expect(result).toEqual({ loops: [[A, B, C, D]], openChains: 0 });
  });
  it('finds both loops of a figure eight sharing one vertex and a cutout inside an outline', () => {
    const figure = [...rectangle(0, 0, 10, 10), edge(C, p(20, 10)), edge(p(20, 10), p(20, 20)), edge(p(20, 20), p(10, 20)), edge(p(10, 20), C)];
    expect(stitchOutlines(figure).loops).toHaveLength(2);
    const withCutout = stitchOutlines([...rectangle(0, 0, 40, 30), ...rectangle(10, 10, 12, 12), edge(p(40, 30), p(45, 30))]);
    expect(withCutout.loops).toHaveLength(2); expect(withCutout.openChains).toBe(1);
    expect(sorted(withCutout.loops[0])).toEqual(sorted([p(0, 0), p(40, 0), p(40, 30), p(0, 30)]));
    expect(stitchOutline([...rectangle(0, 0, 40, 30), ...rectangle(10, 10, 12, 12)])).toHaveLength(4);
  });
  it('handles a loop attached to a bridge to another loop (barbell) without losing either', () => {
    const result = stitchOutlines([...rectangle(0, 0, 10, 10), edge(B, p(20, 0)), ...rectangle(20, 0, 30, 10)]);
    expect(result.loops).toHaveLength(2); expect(result.openChains).toBe(1);
  });
  it('rejects an invalid tolerance and non-finite coordinates', () => {
    for (const tolerance of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => stitchOutline(rectangle(0, 0, 1, 1), tolerance)).toThrow(BoardFormatError);
    expect(() => stitchOutline([edge(p(Number.NaN, 0), B)])).toThrow(BoardFormatError);
  });
  it('scales to thousands of sampled arc segments', () => {
    const circle = Array.from({ length: 4096 }, (_, index) => {
      const a = index / 4096 * 2 * Math.PI, b = (index + 1) / 4096 * 2 * Math.PI;
      return edge(p(Math.cos(a), Math.sin(a)), p(Math.cos(b), Math.sin(b)));
    });
    const start = performance.now();
    const result = stitchOutlines([...circle, ...rectangle(-5, -5, 5, 5)]);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(result.loops).toHaveLength(2); expect(result.loops[0]).toHaveLength(4); expect(result.loops[1]).toHaveLength(4096);
  });
});

describe('stitchOutlines (B05/B20 chord and edge-order coverage)', () => {
  const area = (points: Point[]) => Math.abs(points.reduce((sum, a, index) => { const b = points[(index + 1) % points.length]; return sum + a.x * b.y - b.x * a.y; }, 0) / 2);
  const rect = rectangle(0, 0, 40, 30), chord = edge(p(0, 0), p(40, 30));
  it('a diagonal chord never replaces the rectangle by a triangle, whatever the edge order (inbox: 600 mm2 vs 1200 mm2)', () => {
    const orders = [[chord, ...rect], [...rect, chord], [rect[0], chord, ...rect.slice(1)], [rect[2], rect[0], chord, rect[3], rect[1]], [...rect].reverse().concat([chord]), [edge(p(40, 30), p(0, 0)), ...rect]];
    for (const edges of orders) {
      const { loops, openChains } = stitchOutlines(edges);
      expect(loops).toHaveLength(1); expect(area(loops[0])).toBe(1200); expect(openChains).toBe(1);
      expect(sorted(loops[0])).toEqual(sorted([p(0, 0), p(40, 0), p(40, 30), p(0, 30)]));
    }
  });
  it('returns the same loops in the same canonical form for every edge order and direction', () => {
    const cases: Record<string, Array<readonly [Point, Point]>> = {
      chordSpurCutout: [...rect, chord, edge(p(40, 30), p(45, 30)), ...rectangle(10, 10, 12, 12)],
      keyhole: [...rect, ...rectangle(10, 10, 20, 20), edge(p(20, 20), p(40, 30))],
      domino: [...rectangle(0, 0, 10, 10), ...rectangle(10, 0, 20, 10)],
      cornerTouch: [...rectangle(0, 0, 10, 10), edge(p(0, 0), p(4, 1)), edge(p(4, 1), p(1, 4)), edge(p(1, 4), p(0, 0))],
      barbell: [...rectangle(0, 0, 10, 10), edge(p(10, 0), p(20, 0)), ...rectangle(20, 0, 30, 10)],
      figureEight: [...rectangle(0, 0, 10, 10), edge(p(10, 10), p(20, 10)), edge(p(20, 10), p(20, 20)), edge(p(20, 20), p(10, 20)), edge(p(10, 20), p(10, 10))],
    };
    const expected: Record<string, { loops: number[]; openChains: number }> = {
      chordSpurCutout: { loops: [1200, 4], openChains: 1 }, keyhole: { loops: [1200, 100], openChains: 1 }, domino: { loops: [200], openChains: 1 },
      cornerTouch: { loops: [100, 7.5], openChains: 0 }, barbell: { loops: [100, 100], openChains: 1 }, figureEight: { loops: [100, 100], openChains: 0 },
    };
    let seed = 12345;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (const [name, base] of Object.entries(cases)) {
      const reference = stitchOutlines(base);
      expect(reference.loops.map(area), name).toEqual(expected[name].loops); expect(reference.openChains, name).toBe(expected[name].openChains);
      for (let round = 0; round < 40; round++) {
        const shuffled = base.map(item => [random() < 0.5 ? item : [item[1], item[0]] as const, random()] as const).sort((a, b) => a[1] - b[1]).map(item => item[0]);
        expect(stitchOutlines(shuffled), `${name} #${round}`).toEqual(reference);
      }
    }
  });
  it('returns loops counter-clockwise starting at the lowest-left vertex, largest area first', () => {
    const { loops } = stitchOutlines([...rectangle(20, 20, 22, 22).map(([a, b]) => edge(b, a)), ...rectangle(0, 0, 10, 10).map(([a, b]) => edge(b, a))]);
    expect(loops).toEqual([[p(0, 0), p(10, 0), p(10, 10), p(0, 10)], [p(20, 20), p(22, 20), p(22, 22), p(20, 22)]]);
  });
  it('a stray segment floating inside the board is an extra open chain and never joins the loop', () => {
    const result = stitchOutlines([chord, edge(p(30, 5), p(35, 6)), ...rect]);
    expect(result.loops).toHaveLength(1); expect(area(result.loops[0])).toBe(1200); expect(result.openChains).toBe(2);
  });
});

describe('buildBoard', () => {
  it('scales positions and dimensions to mm and preserves fractions', () => {
    const board = buildBoard(input(), raw({ unitsToMm: 0.0254, parts: [part('U1', { position: p(1000, 2000), bounds: { minX: 900, minY: 1900, maxX: 1100, maxY: 2100 } })],
      pins: [pin('U1', '1', 1000, 2000, { radius: 50, width: 100, height: 25, rotation: 45, net: 'GND' })], outline: [p(0, 0), p(4000, 0), p(4000, 4000), p(0, 4000)] }));
    expect(board.units).toBe('mm');
    expect(board.pins[0]).toMatchObject({ x: 25.4, y: 50.8, radius: 1.27, width: 2.54, height: 0.635, rotation: 45 });
    expect(board.components[0].position).toEqual({ x: 25.4, y: 50.8 });
    for (const [key, value] of Object.entries({ minX: 22.86, minY: 48.26, maxX: 27.94, maxY: 53.34 })) expect(board.components[0].bounds[key as 'minX'], key).toBeCloseTo(value, 9);
    expect(board.outline).toEqual([p(0, 0), p(101.6, 0), p(101.6, 101.6), p(0, 101.6)]);
    expect(board.bounds).toEqual({ minX: 0, minY: 0, maxX: 101.6, maxY: 101.6 });
  });
  it('rejects non-finite values, invalid units and invalid sides', () => {
    expect(() => buildBoard(input(), raw({ pins: [pin('U1', '1', Number.NaN, 0)] }))).toThrow(/Invalid coordinate/);
    expect(() => buildBoard(input(), raw({ pins: [pin('U1', '1', 0, Number.POSITIVE_INFINITY)] }))).toThrow(BoardFormatError);
    expect(() => buildBoard(input(), raw({ pins: [pin('U1', '1', 0, 0, { radius: Number.NaN })] }))).toThrow(/pad radius/);
    expect(() => buildBoard(input(), raw({ unitsToMm: 0 }))).toThrow(/Invalid board units/);
    expect(() => buildBoard(input(), raw({ unitsToMm: Number.NaN }))).toThrow(BoardFormatError);
    expect(() => buildBoard(input(), raw({ parts: [part('U1', { side: 'left' as never })] }))).toThrow(/Invalid board side/);
    expect(() => buildBoard(input(), raw({ pins: [pin('U1', '1', 0, 0, { radius: -1 })] }))).toThrow(/Negative pad radius/);
    expect(() => buildBoard(input(), raw({ pins: [pin('U1', '1', 0, 0, { width: -1 })] }))).toThrow(/Negative pad dimensions/);
  });
  it('B16: rejects canonical magnitudes beyond 1e9 mm for coordinates and dimensions, accepts 1e8', () => {
    expect(MAX_MM).toBe(1e9);
    for (const value of [1e20, 1e10, -1e10, 1e9 + 1]) {
      expect(() => buildBoard(input(), raw({ pins: [pin('U1', '1', value, 0)] }))).toThrow(/exceeds the supported range/);
      expect(() => buildBoard(input(), raw({ parts: [part('U1', { position: p(0, value) })] }))).toThrow(/exceeds the supported range/);
      expect(() => buildBoard(input(), raw({ pins: [pin('U1', '1', 0, 0, { width: value })] }))).toThrow(/exceeds the supported range/);
      expect(() => buildBoard(input(), raw({ pins: [pin('U1', '1', 0, 0, { radius: value })] }))).toThrow(/exceeds the supported range/);
      expect(() => buildBoard(input(), raw({ outline: [p(0, 0), p(value, 0), p(0, 1)] }))).toThrow(/exceeds the supported range/);
    }
    expect(buildBoard(input(), raw({ pins: [pin('U1', '1', 1e8, -1e8)] })).pins[0]).toMatchObject({ x: 1e8, y: -1e8 });
    // The cap applies after unit conversion: 1e10 mil is 2.54e8 mm.
    expect(buildBoard(input(), raw({ unitsToMm: 0.0254, pins: [pin('U1', '1', 1e10, 0)] })).pins[0].x).toBeCloseTo(2.54e8);
    expect(() => buildBoard(input(), raw({ unitsToMm: 0.0254, pins: [pin('U1', '1', 1e11, 0)] }))).toThrow(/exceeds the supported range/);
  });
  it('assigns deterministic ids and keeps pin numbers/names as strings', () => {
    const data = raw({ parts: [part('A'), part('B')], pins: [pin('B', '7', 1, 1, { net: 'N1' }), pin('A', '', 2, 2, { net: 'N1', name: 'CLK' })] });
    const first = buildBoard(input(), data), second = buildBoard(input(), data);
    expect(first).toEqual(second);
    expect(first.components.map(component => component.id)).toEqual(['part:0', 'part:1']);
    expect(first.pins.map(item => item.id)).toEqual(['pin:0', 'pin:1']);
    expect(first.pins[0]).toMatchObject({ componentId: 'part:1', number: '7', name: '7' });
    expect(first.pins[1]).toMatchObject({ componentId: 'part:0', number: '2', name: 'CLK' });
    expect(first.nets).toEqual([{ id: 'net:0', name: 'N1', pinIds: ['pin:0', 'pin:1'] }]);
    expect(first.components[1].pinIds).toEqual(['pin:0']);
  });
  it('rejects duplicate or empty component keys, missing component references and empty part lists', () => {
    expect(() => buildBoard(input(), raw({ parts: [part('U1'), part('U1')] }))).toThrow(/duplicate or empty component identity/);
    expect(() => buildBoard(input(), raw({ parts: [part('')] }))).toThrow(/duplicate or empty component identity/);
    expect(() => buildBoard(input(), raw({ pins: [pin('U9', '1', 0, 0)] }))).toThrow(/missing component \(U9\)/);
    expect(() => buildBoard(input(), raw({ parts: [] }))).toThrow(/no components were found/);
    expect(() => buildBoard(input(), raw({ parts: [part('U1')], pins: [] }))).toThrow(/has no position or pins/);
  });
  it('enforces the 250k part and 1M pin bounds with LIMIT_EXCEEDED', () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => part(`P${index}`));
    expect(() => buildBoard(input(), raw({ parts: many(250_001), pins: [] }))).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    const samePin = pin('U1', '1', 0, 0);
    expect(() => buildBoard(input(), raw({ pins: Array.from({ length: 1_000_001 }, () => samePin) }))).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });
  it('B24: excludes only empty nets; a declared net literally named UNCONNECTED survives in the common builder', () => {
    const board = buildBoard(input(), raw({ pins: [pin('U1', '1', 0, 0, { net: 'UNCONNECTED' }), pin('U1', '2', 1, 0, { net: 'UNCONNECTED' }), pin('U1', '3', 2, 0, { net: '' }), pin('U1', '4', 3, 0)] }));
    expect(board.nets).toEqual([{ id: 'net:0', name: 'UNCONNECTED', pinIds: ['pin:0', 'pin:1'] }]);
    expect(board.pins.map(item => item.net)).toEqual(['UNCONNECTED', 'UNCONNECTED', '', '']);
    expect(keys(board)).not.toContain('parse.warning.noNets');
    const silent = buildBoard(input(), raw({ pins: [pin('U1', '1', 0, 0), pin('U1', '2', 1, 0, { net: '' })] }));
    expect(silent.nets).toEqual([]); expect(keys(silent)).toContain('parse.warning.noNets');
  });
  it('reports fallback pads, fallback components and a missing outline, and keeps adapter warnings first', () => {
    const board = buildBoard(input(), { format: 'TEST', unitsToMm: 1, parts: [part('U1'), part('U2', { bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } })],
      pins: [pin('U1', '1', 0, 0, { net: 'A' }), pin('U1', '2', 1, 0, { net: 'A', radius: 0.5 }), pin('U2', '1', 0.5, 0.5, { net: 'A', width: 1, height: 1 })], warnings: [note('vendor note')] });
    expect(board.warnings).toEqual([
      { key: 'parse.warning.formatNote', params: { message: 'vendor note' } },
      { key: 'parse.warning.fallbackPads', params: { count: 1 } },
      { key: 'parse.warning.fallbackComponents', params: { count: 1 } },
      { key: 'parse.warning.missingBoardOutline' },
    ]);
    expect(board.outline).toHaveLength(4);
  });
  it('B19: fallback component bounds enclose the physical pad extents instead of ±0.3 around the centres', () => {
    const close = (bounds: { minX: number; minY: number; maxX: number; maxY: number }, expected: [number, number, number, number]) => {
      expect(bounds.minX).toBeCloseTo(expected[0], 9); expect(bounds.minY).toBeCloseTo(expected[1], 9); expect(bounds.maxX).toBeCloseTo(expected[2], 9); expect(bounds.maxY).toBeCloseTo(expected[3], 9);
    };
    const build = (pins: RawPin[]) => buildBoard(input(), { format: 'TEST', unitsToMm: 1, parts: [part('U1', { position: p(0, 0) })], pins });
    const rect = build([pin('U1', '1', 0, 0, { width: 20, height: 10, shape: 'rect' })]);
    close(rect.components[0].bounds, [-10, -5, 10, 5]); close(rect.bounds, [-10, -5, 10, 5]);
    expect(keys(rect)).toContain('parse.warning.fallbackComponents');
    const rotated = build([pin('U1', '1', 0, 0, { width: 20, height: 10, shape: 'rect', rotation: 45 })]);
    close(rotated.components[0].bounds, [-15 / Math.SQRT2, -15 / Math.SQRT2, 15 / Math.SQRT2, 15 / Math.SQRT2]);
    const round = build([pin('U1', '1', 0, 0, { radius: 5 })]);
    close(round.components[0].bounds, [-5, -5, 5, 5]); close(round.bounds, [-5, -5, 5, 5]);
    const sizeless = build([pin('U1', '1', 0, 0), pin('U1', '2', 2, 0)]);
    close(sizeless.components[0].bounds, [-0.3, -0.3, 2.3, 0.3]);
    const mixed = build([pin('U1', '1', 0, 0, { width: 2, height: 2 }), pin('U1', '2', 10, 0)]);
    close(mixed.components[0].bounds, [-1, -1, 10.3, 1]);
    const lonely = buildBoard(input(), { format: 'TEST', unitsToMm: 1, parts: [part('U1', { position: p(5, 5) })], pins: [] });
    close(lonely.components[0].bounds, [4.7, 4.7, 5.3, 5.3]);
    // An explicit outline/bounds is never widened by pads, but the estimated board outline still encloses them.
    const explicit = buildBoard(input(), { format: 'TEST', unitsToMm: 1, parts: [part('U1', { bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 } })], pins: [pin('U1', '1', 0, 0, { width: 20, height: 10 })] });
    close(explicit.components[0].bounds, [-1, -1, 1, 1]); close(explicit.bounds, [-10, -5, 10, 5]);
  });
  it('padExtent follows the rotated-rectangle and circle math, exactly at right angles', () => {
    const base: BoardPin = { id: 'pin:0', componentId: 'part:0', number: '1', name: '1', net: '', side: 'top', x: 1, y: 2, radius: 0, shape: 'round' };
    expect(padExtent(base)).toEqual([{ x: 1, y: 2 }]);
    expect(sorted(padExtent({ ...base, radius: 3 }))).toEqual(sorted([p(-2, -1), p(4, -1), p(4, 5), p(-2, 5)]));
    expect(sorted(padExtent({ ...base, width: 4, height: 2, rotation: 90 }))).toEqual(sorted([p(0, 0), p(2, 0), p(2, 4), p(0, 4)]));
  });
  it('B27: a round pad extent uses its radius at any rotation; rotated half extents are for rect and square only', () => {
    const base: BoardPin = { id: 'pin:0', componentId: 'part:0', number: '1', name: '1', net: '', side: 'top', x: 20, y: 30, radius: 2, shape: 'round', width: 4, height: 4 };
    const bounds = (pad: BoardPin) => { const xs = padExtent(pad).map(point => point.x), ys = padExtent(pad).map(point => point.y); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
    for (const rotation of [0, 45, 90, 30]) expect(bounds({ ...base, rotation }), `round ${rotation}`).toEqual([18, 28, 22, 32]);
    expect(bounds({ ...base, shape: 'square', rotation: 45 })[0]).toBeCloseTo(20 - 2 * Math.SQRT2, 9);
    const rect = bounds({ ...base, shape: 'rect', width: 20, height: 10, rotation: 45 });
    expect(rect[2]).toBeCloseTo(20 + 15 / Math.SQRT2, 9); expect(rect[3]).toBeCloseTo(30 + 15 / Math.SQRT2, 9);
    expect(bounds({ ...base, shape: 'rect', width: 20, height: 10, rotation: 90 })).toEqual([15, 20, 25, 40]);
    // A round pad with only a radius, or only an unknown radius and a size, still encloses what is known.
    expect(bounds({ ...base, width: undefined, height: undefined, rotation: 45 })).toEqual([18, 28, 22, 32]);
    const built = buildBoard(input(), { format: 'TEST', unitsToMm: 1, parts: [part('U1', { position: p(20, 30) })], pins: [pin('U1', '1', 20, 30, { radius: 2, width: 4, height: 4, rotation: 45, shape: 'round' })] });
    expect(built.components[0].bounds).toEqual({ minX: 18, minY: 28, maxX: 22, maxY: 32 }); expect(built.bounds).toEqual(built.components[0].bounds);
  });
  it('B16: cutout loops that are not the outline are range-checked too, so no unvalidated geometry escapes the cap', () => {
    const outer = [p(0, 0), p(40, 0), p(40, 30), p(0, 30)];
    for (const value of [1e20, -1e10, 1e9 + 1]) expect(() => buildBoard(input(), raw({ outline: undefined, outlines: [outer, [p(10, 10), p(value, 10), p(10, 12)]] }))).toThrow(/exceeds the supported range/);
    expect(() => buildBoard(input(), raw({ outline: undefined, outlines: [outer, [p(10, 10), p(Number.NaN, 10), p(10, 12)]] }))).toThrow(/Invalid coordinate/);
    expect(buildBoard(input(), raw({ outline: undefined, outlines: [outer, [p(10, 10), p(12, 10), p(10, 12)]] })).warnings.map(warning => warning.key)).toContain('parse.warning.boardCutouts');
  });
  it('B16: the cap applies to component bounds, outlines, every pad dimension and the rotation-free extremes', () => {
    const bounds = (value: number) => ({ minX: 0, minY: 0, maxX: value, maxY: 1 });
    expect(() => buildBoard(input(), raw({ parts: [part('U1', { bounds: bounds(1e12) })] }))).toThrow(/exceeds the supported range/);
    expect(() => buildBoard(input(), raw({ parts: [part('U1', { outline: [p(0, 0), p(1e12, 0), p(0, 1)] })] }))).toThrow(/exceeds the supported range/);
    expect(() => buildBoard(input(), raw({ pins: [pin('U1', '1', 0, 0, { height: 2e9 })] }))).toThrow(/exceeds the supported range/);
    expect(() => buildBoard(input(), raw({ pins: [pin('U1', '1', 0, 0, { rotation: 1e400 })] }))).toThrow(BoardFormatError);
    const edge1 = buildBoard(input(), raw({ outline: undefined, parts: [part('U1', { position: p(1e9, -1e9) })], pins: [pin('U1', '1', 1e9, -1e9, { width: 1e9, height: 1e9, shape: 'rect' })] }));
    expect(Object.values(edge1.bounds).every(value => Number.isFinite(value) && Math.abs(value) <= 2 * MAX_MM)).toBe(true);
  });
  it('uses the largest of several outlines and discloses cutouts exactly once', () => {
    const outer = [p(0, 0), p(40, 0), p(40, 30), p(0, 30)], hole = [p(10, 10), p(12, 10), p(12, 12), p(10, 12)];
    const board = buildBoard(input(), raw({ unitsToMm: 2, outline: undefined, outlines: [hole, outer] }));
    expect(board.outline).toEqual([p(0, 0), p(80, 0), p(80, 60), p(0, 60)]);
    expect(keys(board).filter(key => key === 'parse.warning.boardCutouts')).toHaveLength(1);
    const single = buildBoard(input(), raw({ outline: undefined, outlines: [outer] }));
    expect(single.outline).toEqual(outer); expect(keys(single)).not.toContain('parse.warning.boardCutouts');
    const legacy = buildBoard(input(), raw({ outline: outer }));
    expect(legacy.outline).toEqual(outer); expect(keys(legacy)).not.toContain('parse.warning.boardCutouts');
    const announced = buildBoard(input(), raw({ outline: undefined, outlines: [outer, hole], warnings: [{ key: 'parse.warning.boardCutouts' }] }));
    expect(keys(announced).filter(key => key === 'parse.warning.boardCutouts')).toHaveLength(1);
    const degenerate = buildBoard(input(), raw({ outline: undefined, outlines: [[p(0, 0), p(1, 1)]] }));
    expect(keys(degenerate)).toContain('parse.warning.missingBoardOutline');
  });
  it('derives the board name from the file name without directories or the last extension', () => {
    expect(buildBoard(input('C:\\boards\\My Board.v2.kicad_pcb'), raw()).name).toBe('My Board.v2');
    expect(buildBoard(input('/x/y/board.cad'), raw()).name).toBe('board');
    expect(buildBoard(input('noext'), raw()).name).toBe('noext');
    expect(buildBoard(input(), raw()).format).toBe('TEST');
  });
  it('pin side defaults to the part side and explicit sides are kept', () => {
    const board = buildBoard(input(), raw({ parts: [part('U1', { side: 'bottom' })], pins: [pin('U1', '1', 0, 0), pin('U1', '2', 1, 0, { side: 'both' })] }));
    expect(board.components[0].side).toBe('bottom');
    expect(board.pins.map(item => item.side)).toEqual(['bottom', 'both']);
  });
});

describe('buildBoard error attribution', () => {
  it('every BoardFormatError from buildBoard carries raw.format and keeps its code and message', () => {
    const cases: Array<[() => unknown, RegExp, string]> = [
      [() => buildBoard(input(), raw({ pins: [pin('U1', '1', 1e20, 0)] })), /exceeds the supported range/, 'INVALID_FORMAT'],
      [() => buildBoard(input(), raw({ pins: [pin('U1', '1', Number.NaN, 0)] })), /Invalid coordinate/, 'INVALID_FORMAT'],
      [() => buildBoard(input(), raw({ pins: [pin('U1', '1', 0, 0, { width: -1 })] })), /Negative pad dimensions/, 'INVALID_FORMAT'],
      [() => buildBoard(input(), raw({ pins: [pin('U1', '1', 0, 0, { radius: -1 })] })), /Negative pad radius/, 'INVALID_FORMAT'],
      [() => buildBoard(input(), raw({ parts: Array.from({ length: 250_001 }, (_, index) => part(`P${index}`)), pins: [] })), /record count/, 'LIMIT_EXCEEDED'],
      [() => buildBoard(input(), raw({ outline: undefined, outlines: [[p(0, 0), p(1e12, 0), p(0, 1)]] })), /exceeds the supported range/, 'INVALID_FORMAT'],
      [() => buildBoard(input(), raw({ pins: [pin('U9', '1', 0, 0)] })), /missing component/, 'INVALID_FORMAT'],
      [() => buildBoard(input(), raw({ parts: [part('U1'), part('U1')] })), /duplicate or empty component identity/, 'INVALID_FORMAT'],
      [() => buildBoard(input(), raw({ parts: [] })), /no components were found/, 'INVALID_FORMAT'],
      [() => buildBoard(input(), raw({ unitsToMm: 0 })), /Invalid board units/, 'INVALID_FORMAT'],
      [() => buildBoard(input(), raw({ parts: [part('U1', { side: 'left' as never })] })), /Invalid board side/, 'INVALID_FORMAT'],
    ];
    for (const [action, message, code] of cases) expect(action, String(message)).toThrow(expect.objectContaining({ format: 'TEST', code, message: expect.stringMatching(message) }));
  });
});

describe('helpers', () => {
  it('number() accepts plain decimal and exponent text only: hex, binary, octal, Infinity and separators are rejected', () => {
    for (const [text, value] of [['12', 12], [' 5 ', 5], ['-1.5', -1.5], ['+3', 3], ['.5', 0.5], ['5.', 5], ['1e3', 1000], ['-2.5E-2', -0.025], ['007', 7]] as const) expect(number(text), text).toBe(value);
    for (const text of ['0x10', '0X1f', '0b11', '0o7', 'Infinity', '-Infinity', '1e999', 'NaN', '1_000', '1,5', '1 2', '5mil', '--1', '.', 'e5', '']) expect(() => number(text), text).toThrow(BoardFormatError);
    expect(number(0x10)).toBe(16); expect(() => number(Number.POSITIVE_INFINITY)).toThrow(BoardFormatError);
  });
  it('decodeText reports a UTF-16 BOM followed by invalid data as a descriptive TextDecodeError, never a raw TypeError', () => {
    for (const bytes of [[0xff, 0xfe, 0x41], [0xfe, 0xff, 0x41], [0xff, 0xfe, 0x00, 0xd8], [0xfe, 0xff, 0xdc, 0x00]]) {
      const failure = (() => { try { decodeText(Uint8Array.from(bytes)); } catch (error) { return error; } })();
      expect(failure, bytes.join()).toBeInstanceOf(TextDecodeError); expect(failure).not.toBeInstanceOf(TypeError); expect(failure).not.toBeInstanceOf(BoardFormatError);
      expect((failure as Error).message).toMatch(/UTF-16/);
    }
    expect(decodeText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x3d, 0xd8, 0x00, 0xde]))).toBe('A\u{1f600}');
  });
  it('decodeText handles UTF-8 with BOM, UTF-16 BOMs, windows-1252 fallback, the size limit and memoization', () => {
    expect(decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
    expect(decodeText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00]))).toBe('A');
    expect(decodeText(Uint8Array.from([0xfe, 0xff, 0x00, 0x41]))).toBe('A');
    expect(decodeText(Uint8Array.from([0xe9]))).toBe('\u00e9');
    expect(decodeText(new TextEncoder().encode('\u0151'))).toBe('\u0151');
    const big = new Uint8Array(2048).fill(0x41);
    expect(decodeText(big)).toBe(decodeText(big));
    expect(decodeText(big)).toHaveLength(2048);
    expect(() => decodeText({ length: MAX_IMPORT_BYTES + 1 } as unknown as Uint8Array)).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });
});
