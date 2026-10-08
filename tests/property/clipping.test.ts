import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { boardToScreen, distance, padBounds, screenToBoard, viewportBounds } from '../../src/lib/geometry';
import type { Bounds2, Point2 } from '../../src/lib/geometry';
import { appendPadPath, clipSegmentToBounds } from '../../src/lib/render-geometry';
import type { BoardPin } from '../../src/lib/types';
import { clipDashedSegment, MEASURE_CLIP_MARGIN_PX, MEASURE_DASH, strokeMeasurementLine } from '../../src/components/board-measure-line';
import type { DashedLineContext } from '../../src/components/board-measure-line';
import { bounds, real, near, params, point, rotation, view, viewport } from './support';

const PERIOD = MEASURE_DASH.reduce((sum, part) => sum + part, 0);
const magnitudeOf = (...values: number[]) => Math.max(1, ...values.map(Math.abs));
const lerp = (a: Point2, b: Point2, t: number): Point2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
/** Parameter of the orthogonal projection of p on the line a -> b (0 for a zero-length line). */
const parameterOf = (p: Point2, a: Point2, b: Point2) => { const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy; return l === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l; };
const insideBy = (p: Point2, b: Bounds2, slack: number) => p.x >= b.minX - slack && p.x <= b.maxX + slack && p.y >= b.minY - slack && p.y <= b.maxY + slack;
const strictlyInside = (p: Point2, b: Bounds2, margin: number) => p.x > b.minX + margin && p.x < b.maxX - margin && p.y > b.minY + margin && p.y < b.maxY - margin;
/** Is the line (a, b) through c (up to a relative tolerance)? */
const collinear = (a: Point2, b: Point2, c: Point2) => {
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(cross) <= 1e-9 * (Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - a.x, c.y - a.y) + 1e-12 + magnitudeOf(a.x, a.y, b.x, b.y) * 1e-6);
};

// Segments: free ones, and ones aimed at the box so that crossings with both end points outside are common.
const free = fc.record({ from: point(1e5), to: point(1e5) });
const aimed = fc.record({ box: bounds(1e3, 2e3), s: real(-2, 3), t: real(-2, 3), u: real(-2, 3), v: real(-2, 3) })
  .map(({ box, s, t, u, v }) => ({ box, from: { x: box.minX + s * (box.maxX - box.minX), y: box.minY + t * (box.maxY - box.minY) }, to: { x: box.minX + u * (box.maxX - box.minX), y: box.minY + v * (box.maxY - box.minY) } }));
const clipCase = fc.oneof(
  aimed,
  fc.record({ box: bounds(1e3, 2e3), seg: free }).map(({ box, seg }) => ({ box, ...seg })),
  fc.record({ box: bounds(1e3, 2e3), seg: free }).map(({ box, seg }) => ({ box, from: seg.from, to: seg.from })), // zero length
);

describe('clipSegmentToBounds', () => {
  it('returns a piece of the segment inside the bounds, in the original direction', () => {
    fc.assert(fc.property(clipCase, ({ box, from, to }) => {
      const clipped = clipSegmentToBounds(from, to, box);
      if (!clipped) return;
      const scale = magnitudeOf(from.x, from.y, to.x, to.y, box.minX, box.maxX, box.minY, box.maxY);
      const slack = 1e-9 * scale;
      expect(insideBy(clipped.from, box, slack) && insideBy(clipped.to, box, slack)).toBe(true);
      expect(collinear(from, to, clipped.from) && collinear(from, to, clipped.to)).toBe(true);
      const t0 = parameterOf(clipped.from, from, to), t1 = parameterOf(clipped.to, from, to);
      if (distance(from, to) > 1e-6) {
        expect(t0).toBeGreaterThanOrEqual(-1e-9); expect(t1).toBeLessThanOrEqual(1 + 1e-9); expect(t0).toBeLessThanOrEqual(t1 + 1e-9);
      }
    }), params(400));
  });

  it('keeps an end point that is inside exactly, and returns the segment itself when both are', () => {
    fc.assert(fc.property(clipCase, ({ box, from, to }) => {
      const clipped = clipSegmentToBounds(from, to, box);
      const inside = (p: Point2) => insideBy(p, box, 0);
      if (inside(from) || inside(to)) expect(clipped).not.toBeNull();
      if (clipped && inside(from)) expect(clipped.from).toEqual(from);
      if (clipped && inside(to)) expect(clipped.to).toEqual(to);
      if (inside(from) && inside(to)) expect(clipped).toEqual({ from, to });
    }), params(400));
  });

  it('misses only when no point of the segment is inside, and the piece covers every sampled point that is', () => {
    fc.assert(fc.property(clipCase, fc.array(real(0, 1), { minLength: 8, maxLength: 24 }), ({ box, from, to }, samples) => {
      const clipped = clipSegmentToBounds(from, to, box);
      const margin = 1e-7 * magnitudeOf(from.x, from.y, to.x, to.y, box.minX, box.maxX, box.minY, box.maxY);
      for (const t of [0, 0.25, 0.5, 0.75, 1, ...samples]) {
        const p = lerp(from, to, t);
        if (!strictlyInside(p, box, margin)) continue;
        expect(clipped).not.toBeNull();
        if (clipped && distance(from, to) > 1e-6) {
          const t0 = parameterOf(clipped.from, from, to), t1 = parameterOf(clipped.to, from, to);
          expect(t).toBeGreaterThanOrEqual(t0 - 1e-6); expect(t).toBeLessThanOrEqual(t1 + 1e-6);
        }
      }
    }), params(400));
  });

  it('is symmetric in the direction of the segment and idempotent', () => {
    fc.assert(fc.property(clipCase, ({ box, from, to }) => {
      const forward = clipSegmentToBounds(from, to, box), backward = clipSegmentToBounds(to, from, box);
      expect(forward === null).toBe(backward === null);
      if (!forward || !backward) return;
      const tolerance = 1e-8 * magnitudeOf(from.x, from.y, to.x, to.y);
      expect(distance(forward.from, backward.to)).toBeLessThanOrEqual(tolerance);
      expect(distance(forward.to, backward.from)).toBeLessThanOrEqual(tolerance);
      // A piece shorter than rounding, or a box thinner than rounding, cannot be clipped again reliably: the intersection point is computed, not exact.
      const scale = magnitudeOf(from.x, from.y, to.x, to.y, box.minX, box.maxX, box.minY, box.maxY);
      if (distance(forward.from, forward.to) < 1e-6 * scale || box.maxX - box.minX < 1e-6 * scale || box.maxY - box.minY < 1e-6 * scale) return;
      const again = clipSegmentToBounds(forward.from, forward.to, box);
      expect(again).not.toBeNull();
      if (again) { expect(distance(again.from, forward.from)).toBeLessThanOrEqual(tolerance); expect(distance(again.to, forward.to)).toBeLessThanOrEqual(tolerance); }
    }), params(300));
  });

  it('clips against the viewport of any view so that the piece shows on the screen (rotation and mirroring included)', () => {
    fc.assert(fc.property(view(1e3), viewport, real(-3, 4), real(-3, 4), real(-3, 4), real(-3, 4), (v, size, a, b, c, d) => {
      const s0 = { x: a * size.width, y: b * size.height }, s1 = { x: c * size.width, y: d * size.height };
      const from = screenToBoard(s0, v, size.width, size.height), to = screenToBoard(s1, v, size.width, size.height);
      const clipped = clipSegmentToBounds(from, to, viewportBounds(v, size.width, size.height));
      if (!clipped) return;
      // The viewport box is the AABB of the screen rectangle, so for turned views the piece may lie outside the rectangle; it must lie inside the box.
      const box = viewportBounds(v, size.width, size.height);
      expect(insideBy(clipped.from, box, 1e-6 * magnitudeOf(box.minX, box.maxX, box.minY, box.maxY)) && insideBy(clipped.to, box, 1e-6 * magnitudeOf(box.minX, box.maxX, box.minY, box.maxY))).toBe(true);
      if (v.rotation % 90 === 0) {
        const p = boardToScreen(clipped.from, v, size.width, size.height), q = boardToScreen(clipped.to, v, size.width, size.height);
        const slack = 1e-6 * magnitudeOf(size.width, size.height) + 1e-6;
        expect(p.x).toBeGreaterThanOrEqual(-slack); expect(p.x).toBeLessThanOrEqual(size.width + slack); expect(p.y).toBeGreaterThanOrEqual(-slack); expect(p.y).toBeLessThanOrEqual(size.height + slack);
        expect(q.x).toBeGreaterThanOrEqual(-slack); expect(q.x).toBeLessThanOrEqual(size.width + slack); expect(q.y).toBeGreaterThanOrEqual(-slack); expect(q.y).toBeLessThanOrEqual(size.height + slack);
      }
    }), params(200));
  });
});

describe('appendPadPath (display pads)', () => {
  interface Op { kind: 'move' | 'line' | 'arc' | 'close'; values: number[] }
  function record() {
    const ops: Op[] = [];
    return { ops, path: {
      moveTo: (...values: number[]) => { ops.push({ kind: 'move', values }); },
      lineTo: (...values: number[]) => { ops.push({ kind: 'line', values }); },
      arc: (...values: number[]) => { ops.push({ kind: 'arc', values }); },
      closePath: () => { ops.push({ kind: 'close', values: [] }); },
    } };
  }
  const pin = fc.record({
    at: point(500), shape: fc.constantFrom('round' as const, 'rect' as const, 'square' as const), radius: real(0, 5),
    width: fc.option(real(0, 20), { nil: undefined }), height: fc.option(real(0, 20), { nil: undefined }), rotation: fc.option(rotation, { nil: undefined }),
  }).map(({ at, ...rest }): BoardPin => ({ id: 'p', componentId: 'c', number: '1', name: '1', net: '', side: 'top', x: at.x, y: at.y, ...rest }));

  it('draws a circle at the pad for round or unsized pads and a closed rectangle around it otherwise, never smaller than the marker', () => {
    fc.assert(fc.property(pin, real(0.1, 1000), real(0, 8), (p, scale, marker) => {
      const { ops, path } = record();
      appendPadPath(path, p, scale, marker);
      if (p.shape === 'round' || !(p.width || p.height)) {
        expect(ops.map(op => op.kind)).toEqual(['move', 'arc']);
        const [x, y, radius] = ops[1].values;
        expect(x).toBe(p.x); expect(y).toBe(p.y);
        expect(radius).toBe(Math.max(p.radius, marker / scale));
        return;
      }
      expect(ops.map(op => op.kind)).toEqual(['move', 'line', 'line', 'line', 'close']);
      const corners = ops.slice(0, 4).map(op => ({ x: op.values[0], y: op.values[1] }));
      const centroid = { x: corners.reduce((s, c) => s + c.x, 0) / 4, y: corners.reduce((s, c) => s + c.y, 0) / 4 };
      const slack = 1e-9 * magnitudeOf(p.x, p.y, ...corners.flatMap(c => [c.x, c.y]));
      expect(distance(centroid, { x: p.x, y: p.y })).toBeLessThanOrEqual(slack + 1e-9);
      // A rectangle: equal diagonals through the centre, and right angles.
      const half = corners.map(c => distance(c, { x: p.x, y: p.y }));
      for (const h of half) expect(near(h, half[0], 1e-9, slack + 1e-9)).toBe(true);
      const edge = (i: number) => ({ x: corners[(i + 1) % 4].x - corners[i % 4].x, y: corners[(i + 1) % 4].y - corners[i % 4].y });
      for (let i = 0; i < 4; i++) { const a = edge(i), b = edge(i + 1); expect(Math.abs(a.x * b.x + a.y * b.y)).toBeLessThanOrEqual(1e-9 * (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)) + 1e-9); }
      // Each side is at least 1.5 px wide and the drawn pad covers the physical one.
      for (let i = 0; i < 4; i++) { const e = edge(i); expect(Math.hypot(e.x, e.y)).toBeGreaterThanOrEqual(1.5 / scale - 1e-9 * magnitudeOf(1 / scale)); }
      const drawn = { minX: Math.min(...corners.map(c => c.x)), maxX: Math.max(...corners.map(c => c.x)), minY: Math.min(...corners.map(c => c.y)), maxY: Math.max(...corners.map(c => c.y)) };
      const physical = padBounds(p);
      const wiggle = 1e-9 * magnitudeOf(drawn.minX, drawn.maxX, drawn.minY, drawn.maxY) + 1e-9;
      expect(drawn.minX).toBeLessThanOrEqual(physical.minX + wiggle); expect(drawn.maxX).toBeGreaterThanOrEqual(physical.maxX - wiggle);
      expect(drawn.minY).toBeLessThanOrEqual(physical.minY + wiggle); expect(drawn.maxY).toBeGreaterThanOrEqual(physical.maxY - wiggle);
    }), params(300));
  });
});

describe('clipDashedSegment and strokeMeasurementLine (measurement line)', () => {
  const screenSegment = fc.record({ size: fc.record({ w: fc.integer({ min: 50, max: 3000 }), h: fc.integer({ min: 50, max: 2000 }) }), a: point(1e6), b: point(1e6), prior: fc.oneof(fc.constant(0), real(-50, 50)) });
  const nearScreen = fc.record({ size: fc.record({ w: fc.integer({ min: 50, max: 3000 }), h: fc.integer({ min: 50, max: 2000 }) }), pa: fc.record({ x: real(-3, 4), y: real(-3, 4) }), pb: fc.record({ x: real(-3, 4), y: real(-3, 4) }), prior: real(-20, 20) })
    .map(({ size, pa, pb, prior }) => ({ size, a: { x: pa.x * size.w, y: pa.y * size.h }, b: { x: pb.x * size.w, y: pb.y * size.h }, prior }));
  const anyScreenSegment = fc.oneof(screenSegment, nearScreen);
  const rectOf = (size: { w: number; h: number }, margin = MEASURE_CLIP_MARGIN_PX): Bounds2 => ({ minX: -margin, minY: -margin, maxX: size.w + margin, maxY: size.h + margin });

  it('returns null or a piece of the line inside the clip rectangle, with the dash pattern carried over exactly', () => {
    fc.assert(fc.property(anyScreenSegment, ({ size, a, b, prior }) => {
      const clip = clipDashedSegment(a, b, size.w, size.h, MEASURE_CLIP_MARGIN_PX, prior);
      const box = rectOf(size);
      if (insideBy(a, box, 0) && insideBy(b, box, 0)) { expect(clip).toEqual({ from: a, to: b, dashOffset: prior }); return; }
      if (!clip) return;
      const slack = 1e-7 * magnitudeOf(a.x, a.y, b.x, b.y);
      expect(insideBy(clip.from, box, slack) && insideBy(clip.to, box, slack)).toBe(true);
      expect(collinear(a, b, clip.from) && collinear(a, b, clip.to)).toBe(true);
      expect(clip.dashOffset).toBeGreaterThanOrEqual(0); expect(clip.dashOffset).toBeLessThan(PERIOD);
      // The pattern must be in the phase the unclipped line has at `clip.from`: prior + length so far, modulo the period.
      const wanted = (((prior + distance(a, clip.from)) % PERIOD) + PERIOD) % PERIOD;
      const gap = Math.abs(clip.dashOffset - wanted);
      expect(Math.min(gap, PERIOD - gap)).toBeLessThanOrEqual(1e-9);
    }), params(400));
  });

  it('is null exactly when the line misses the clip rectangle (sampled), and covers every sampled visible point', () => {
    fc.assert(fc.property(anyScreenSegment, fc.array(real(0, 1), { minLength: 6, maxLength: 20 }), ({ size, a, b, prior }, samples) => {
      const clip = clipDashedSegment(a, b, size.w, size.h, MEASURE_CLIP_MARGIN_PX, prior);
      const box = rectOf(size);
      const margin = 1e-6 * magnitudeOf(a.x, a.y, b.x, b.y);
      for (const t of [0, 0.5, 1, ...samples]) {
        const p = lerp(a, b, t);
        if (!strictlyInside(p, box, margin)) continue;
        expect(clip).not.toBeNull();
        if (clip && distance(a, b) > 1e-6) { const t0 = parameterOf(clip.from, a, b), t1 = parameterOf(clip.to, a, b); expect(t).toBeGreaterThanOrEqual(t0 - 1e-6); expect(t).toBeLessThanOrEqual(t1 + 1e-6); }
      }
    }), params(300));
  });

  it('never throws and never returns a non-finite number, for any end points', () => {
    const wild = fc.oneof(point(1e9), fc.constantFrom({ x: NaN, y: 0 }, { x: Infinity, y: 5 }, { x: -Infinity, y: -Infinity }, { x: 1e308, y: -1e308 }, { x: 0, y: 0 }, { x: -0, y: 0 }));
    fc.assert(fc.property(wild, wild, fc.integer({ min: 0, max: 4000 }), fc.integer({ min: 0, max: 4000 }), real(-1e3, 1e3), (a, b, w, h, prior) => {
      const clip = clipDashedSegment(a, b, w, h, MEASURE_CLIP_MARGIN_PX, prior);
      if (!clip) return;
      expect([clip.from.x, clip.from.y, clip.to.x, clip.to.y, clip.dashOffset].every(Number.isFinite)).toBe(true);
    }), params(300));
  });

  function recorder(initialOffset: number) {
    const calls: string[] = [];
    let offset = initialOffset, dash: number[] = [];
    const strokes: Array<{ path: Point2[]; offset: number; dash: number[] }> = [];
    let path: Point2[] = [];
    const ctx: DashedLineContext = {
      get lineDashOffset() { return offset; }, set lineDashOffset(value: number) { offset = value; calls.push(`offset:${value}`); },
      setLineDash(segments) { dash = [...segments]; calls.push(`dash:${segments.join(',')}`); },
      beginPath() { path = []; calls.push('begin'); },
      moveTo(x, y) { path.push({ x, y }); },
      lineTo(x, y) { path.push({ x, y }); },
      stroke() { strokes.push({ path, offset, dash }); calls.push('stroke'); },
    };
    return { ctx, strokes, calls, offset: () => offset, dash: () => dash };
  }

  it('strokes at most once, the visible piece with its dash phase, and restores the dash and the dash offset of the context', () => {
    fc.assert(fc.property(anyScreenSegment, ({ size, a, b, prior }) => {
      const r = recorder(prior);
      strokeMeasurementLine(r.ctx, a, b, size.w, size.h);
      expect(r.offset()).toBe(prior);
      expect(r.dash()).toEqual([]);
      expect(r.strokes.length).toBeLessThanOrEqual(1);
      const clip = clipDashedSegment(a, b, size.w, size.h, MEASURE_CLIP_MARGIN_PX, prior);
      expect(r.strokes.length).toBe(clip ? 1 : 0);
      if (clip) {
        expect(r.strokes[0].path).toEqual([clip.from, clip.to]);
        expect(r.strokes[0].dash).toEqual([...MEASURE_DASH]);
        expect(r.strokes[0].offset).toBe(clip.dashOffset);
      }
    }), params(300));
  });
});
