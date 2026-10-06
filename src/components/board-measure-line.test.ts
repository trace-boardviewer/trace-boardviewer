import { describe, expect, it } from 'vitest';
import { distance } from '../lib/geometry';
import type { Point2 } from '../lib/geometry';
import { clipDashedSegment, MEASURE_CLIP_MARGIN_PX, strokeMeasurementLine } from './board-measure-line';
import type { DashedLineContext } from './board-measure-line';

const WIDTH = 1000, HEIGHT = 700;
const PERIOD = 9, ON = 5;
/** Is the dash pattern [5, 4] "on" `s` pixels along a stroke whose phase offset is `offset`? */
const dashOn = (s: number, offset: number) => (((s + offset) % PERIOD) + PERIOD) % PERIOD < ON;

function recorder(initialOffset = 0) {
  const strokes: Array<{ from: Point2; to: Point2; offset: number; dash: number[] }> = [];
  let path: Point2[] = [];
  let dash: number[] = [];
  const calls: string[] = [];
  const ctx: DashedLineContext = {
    lineDashOffset: initialOffset,
    setLineDash(segments) { dash = [...segments]; calls.push(`dash:${segments.join(',')}`); },
    beginPath() { path = []; calls.push('begin'); },
    moveTo(x, y) { path.push({ x, y }); calls.push(`move:${x},${y}`); },
    lineTo(x, y) { path.push({ x, y }); calls.push(`line:${x},${y}`); },
    stroke() { strokes.push({ from: path[0], to: path[1], offset: ctx.lineDashOffset, dash }); calls.push('stroke'); },
  };
  return { ctx, strokes, calls };
}

/** Walks the visible dashes of the ORIGINAL line over the arc-length range [d0, d1] and of the CLIPPED stroke, and compares them. */
function expectSameDashes(a: Point2, b: Point2, from: Point2, to: Point2, offset: number, prior = 0) {
  const d0 = distance(a, from), length = distance(from, to);
  for (let s = 0.013; s < length; s += 0.37) {
    expect(dashOn(s, offset), `arc length ${s}`).toBe(dashOn(d0 + s, prior));
  }
}

describe('P03 measurement line is clipped to the viewport with a stable dash phase', () => {
  it('strokes a 447,213 px diagonal (centre visible) over the viewport plus 16 px margin only', () => {
    const a = { x: 500 - 200000, y: 350 - 100000 }, b = { x: 500 + 200000, y: 350 + 100000 };
    expect(distance(a, b)).toBeCloseTo(447213.6, 0);
    const { ctx, strokes } = recorder();
    strokeMeasurementLine(ctx, a, b, WIDTH, HEIGHT);
    expect(strokes).toHaveLength(1);
    const { from, to } = strokes[0];
    const inClip = (p: Point2) => p.x >= -MEASURE_CLIP_MARGIN_PX - 1e-6 && p.x <= WIDTH + MEASURE_CLIP_MARGIN_PX + 1e-6 && p.y >= -MEASURE_CLIP_MARGIN_PX - 1e-6 && p.y <= HEIGHT + MEASURE_CLIP_MARGIN_PX + 1e-6;
    expect(inClip(from)).toBe(true);
    expect(inClip(to)).toBe(true);
    expect(distance(from, to)).toBeLessThan(WIDTH * 1.5); // not 447,213
    expect(strokes[0].dash).toEqual([5, 4]);
    expect(ctx.lineDashOffset).toBe(0); // restored for later strokes
  });

  it('keeps the visible dashes exactly where the unclipped line has them (offset = prior + t0 * length, modulo 9)', () => {
    // horizontal, entry point known analytically: x = -16 is 984 px from a; 984 mod 9 = 3
    const horizontal = clipDashedSegment({ x: -1000, y: 350 }, { x: 2000, y: 350 }, WIDTH, HEIGHT)!;
    expect(horizontal.from.x).toBeCloseTo(-16, 9); expect(horizontal.from.y).toBe(350);
    expect(horizontal.to.x).toBeCloseTo(1016, 9); expect(horizontal.to.y).toBe(350);
    expect(horizontal.dashOffset).toBeCloseTo(3, 9);
    expect(clipDashedSegment({ x: -1000, y: 350 }, { x: 2000, y: 350 }, WIDTH, HEIGHT, MEASURE_CLIP_MARGIN_PX, 1.5)!.dashOffset).toBeCloseTo(4.5, 9);
    expect(clipDashedSegment({ x: -1000, y: 350 }, { x: 2000, y: 350 }, WIDTH, HEIGHT, MEASURE_CLIP_MARGIN_PX, 7)!.dashOffset).toBeCloseTo(1, 9); // (7 + 984) mod 9

    const cases: Array<[string, Point2, Point2]> = [
      ['diagonal', { x: 500 - 200000, y: 350 - 100000 }, { x: 500 + 200000, y: 350 + 100000 }],
      ['diagonal reversed', { x: 500 + 200000, y: 350 + 100000 }, { x: 500 - 200000, y: 350 - 100000 }],
      ['steep', { x: 123.456, y: -987654.321 }, { x: 777.7, y: 987654.321 }],
      ['one endpoint inside', { x: 300.25, y: 200.5 }, { x: 70000.125, y: -4000.75 }],
      ['both outside, crossing a corner', { x: -300, y: 500 }, { x: 400, y: -250 }],
      ['vertical', { x: 250.5, y: -50000 }, { x: 250.5, y: 90000 }],
    ];
    for (const [name, a, b] of cases) for (const prior of [0, 2.25]) {
      const segment = clipDashedSegment(a, b, WIDTH, HEIGHT, MEASURE_CLIP_MARGIN_PX, prior);
      expect(segment, name).not.toBeNull();
      expect(segment!.dashOffset, name).toBeGreaterThanOrEqual(0);
      expect(segment!.dashOffset, name).toBeLessThan(9);
      expectSameDashes(a, b, segment!.from, segment!.to, segment!.dashOffset, prior);
    }
  });

  it('covers every point of the line that is on screen (nothing visible is clipped away)', () => {
    const a = { x: -5000, y: -3000 }, b = { x: 6200, y: 3900 };
    const segment = clipDashedSegment(a, b, WIDTH, HEIGHT)!;
    const total = distance(a, b);
    const start = distance(a, segment.from) / total, end = distance(a, segment.to) / total;
    for (let t = 0; t <= 1; t += 1 / 20000) {
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (p.x >= 0 && p.x <= WIDTH && p.y >= 0 && p.y <= HEIGHT) {
        expect(t >= start - 1e-9 && t <= end + 1e-9, `t=${t}`).toBe(true);
      }
    }
  });

  it('draws nothing for a line that misses the viewport and its margin, and skips non-finite endpoints', () => {
    expect(clipDashedSegment({ x: -400, y: -400 }, { x: 5000, y: -40 }, WIDTH, HEIGHT)).toBeNull();
    expect(clipDashedSegment({ x: 0, y: -17 }, { x: 1000, y: -17 }, WIDTH, HEIGHT)).toBeNull();
    expect(clipDashedSegment({ x: 0, y: -15 }, { x: 1000, y: -15 }, WIDTH, HEIGHT)).not.toBeNull(); // inside the 16 px margin
    expect(clipDashedSegment({ x: NaN, y: 0 }, { x: 10, y: 10 }, WIDTH, HEIGHT)).toBeNull();
    expect(clipDashedSegment({ x: 0, y: 0 }, { x: Infinity, y: 10 }, WIDTH, HEIGHT)).toBeNull();
    const { ctx, strokes, calls } = recorder();
    strokeMeasurementLine(ctx, { x: -400, y: -400 }, { x: 5000, y: -40 }, WIDTH, HEIGHT);
    expect(strokes).toHaveLength(0);
    expect(calls).toEqual(['dash:5,4', 'dash:']);
  });

  it('issues exactly the original calls (same endpoints, same offset) for a line that is already on screen', () => {
    const a = { x: 120.5, y: 80.25 }, b = { x: 640, y: 512.75 };
    const segment = clipDashedSegment(a, b, WIDTH, HEIGHT)!;
    expect(segment.from).toBe(a);
    expect(segment.to).toBe(b);
    expect(segment.dashOffset).toBe(0);
    const { ctx, strokes, calls } = recorder();
    strokeMeasurementLine(ctx, a, b, WIDTH, HEIGHT);
    expect(calls).toEqual(['dash:5,4', 'begin', 'move:120.5,80.25', 'line:640,512.75', 'stroke', 'dash:']);
    expect(strokes[0].offset).toBe(0);
    // a zero-length measurement (first click, cursor on it) is not special-cased
    const zero = recorder();
    strokeMeasurementLine(zero.ctx, a, a, WIDTH, HEIGHT);
    expect(zero.calls).toEqual(['dash:5,4', 'begin', 'move:120.5,80.25', 'line:120.5,80.25', 'stroke', 'dash:']);
  });

  it('adds the context\'s current dash offset as the prior phase and restores it', () => {
    const { ctx, strokes } = recorder(2);
    strokeMeasurementLine(ctx, { x: -1000, y: 350 }, { x: 2000, y: 350 }, WIDTH, HEIGHT);
    expect(strokes[0].offset).toBeCloseTo(5, 9); // 2 + 984 mod 9
    expect(ctx.lineDashOffset).toBe(2);
  });
});
