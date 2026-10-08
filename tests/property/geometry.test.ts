import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  boardToScreen, boundsCenter, boundsCorners, boundsFromPoints, clamp, containsPoint, distance, expandBounds, fitView, intersects, orientPoint, padBounds, padHitDistance, panBy, pointInPolygon,
  pointToSegmentDistance, screenToBoard, SpatialIndex, unorientPoint, viewportBounds, zoomAt,
} from '../../src/lib/geometry';
import type { Bounds2, Point2 } from '../../src/lib/geometry';
import { bounds, real, coordinate, near, params, point, rotation, view, viewport } from './support';

const closePoint = (a: Point2, b: Point2, magnitude: number) => near(a.x, b.x, 1e-9, 1e-9 * Math.max(1, magnitude)) && near(a.y, b.y, 1e-9, 1e-9 * Math.max(1, magnitude));
const magnitudeOf = (...values: number[]) => Math.max(1, ...values.map(Math.abs));

describe('view transforms', () => {
  it('orientPoint and unorientPoint are exact inverses for any rotation and mirroring', () => {
    fc.assert(fc.property(point(1e5), rotation, fc.boolean(), (p, degrees, mirrored) => {
      expect(closePoint(unorientPoint(orientPoint(p, degrees, mirrored), degrees, mirrored), p, magnitudeOf(p.x, p.y))).toBe(true);
      expect(closePoint(orientPoint(unorientPoint(p, degrees, mirrored), degrees, mirrored), p, magnitudeOf(p.x, p.y))).toBe(true);
    }), params(200));
  });

  it('orientation is an isometry, and only the mirrored view reverses handedness', () => {
    fc.assert(fc.property(point(1e4), point(1e4), rotation, fc.boolean(), (a, b, degrees, mirrored) => {
      const oa = orientPoint(a, degrees, mirrored), ob = orientPoint(b, degrees, mirrored);
      expect(near(distance(oa, ob), distance(a, b), 1e-9, 1e-9)).toBe(true);
      const e1 = orientPoint({ x: 1, y: 0 }, degrees, mirrored), e2 = orientPoint({ x: 0, y: 1 }, degrees, mirrored);
      // Canonical Y is up and the screen's Y is down, so the unmirrored view has determinant -1 and mirroring flips it.
      expect(Math.sign(Math.round((e1.x * e2.y - e1.y * e2.x) * 1e9))).toBe(mirrored ? 1 : -1);
    }), params(150));
  });

  it('screenToBoard(boardToScreen(p)) is p, and boardToScreen(screenToBoard(s)) is s, for random views, sizes, mirrors and rotations', () => {
    fc.assert(fc.property(view(), viewport, point(1e4), (v, size, p) => {
      const there = boardToScreen(p, v, size.width, size.height);
      expect(Number.isFinite(there.x) && Number.isFinite(there.y)).toBe(true);
      expect(closePoint(screenToBoard(there, v, size.width, size.height), p, magnitudeOf(p.x, p.y, v.center.x, v.center.y))).toBe(true);
      const s = { x: p.x % size.width, y: p.y % size.height };
      const back = boardToScreen(screenToBoard(s, v, size.width, size.height), v, size.width, size.height);
      expect(closePoint(back, s, 1e4)).toBe(true);
    }), params(300));
  });

  it('the viewport centre shows the view centre, and the screen scale is exactly CSS pixels per millimetre', () => {
    fc.assert(fc.property(view(), viewport, point(1e3), (v, size, d) => {
      const centre = boardToScreen(v.center, v, size.width, size.height);
      expect(near(centre.x, size.width / 2, 1e-12, 1e-9)).toBe(true);
      expect(near(centre.y, size.height / 2, 1e-12, 1e-9)).toBe(true);
      const moved = boardToScreen({ x: v.center.x + d.x, y: v.center.y + d.y }, v, size.width, size.height);
      expect(near(Math.hypot(moved.x - centre.x, moved.y - centre.y), v.scale * Math.hypot(d.x, d.y), 1e-9, 1e-6)).toBe(true);
    }), params(150));
  });

  it('zoomAt keeps the board point under the cursor fixed, clamps the scale and leaves rotation and mirroring alone', () => {
    fc.assert(fc.property(view(), viewport, point(3000), real(1e-3, 1e5), (v, size, cursor, next) => {
      const anchorBoard = screenToBoard(cursor, v, size.width, size.height);
      const zoomed = zoomAt(v, cursor, next, size.width, size.height);
      expect(zoomed.scale).toBe(clamp(next, 0.1, 1000));
      expect(zoomed.rotation).toBe(v.rotation);
      expect(zoomed.mirrored).toBe(v.mirrored);
      const after = boardToScreen(anchorBoard, zoomed, size.width, size.height);
      expect(near(after.x, cursor.x, 1e-9, 1e-6 * Math.max(1, Math.abs(cursor.x))) && near(after.y, cursor.y, 1e-9, 1e-6 * Math.max(1, Math.abs(cursor.y)))).toBe(true);
    }), params(200));
  });

  it('panBy moves every board point by exactly the screen delta and changes nothing else', () => {
    fc.assert(fc.property(view(), viewport, point(1e3), point(5e3), (v, size, delta, p) => {
      const panned = panBy(v, delta);
      expect(panned.scale).toBe(v.scale);
      expect(panned.rotation).toBe(v.rotation);
      expect(panned.mirrored).toBe(v.mirrored);
      const a = boardToScreen(p, v, size.width, size.height), b = boardToScreen(p, panned, size.width, size.height);
      const tolerance = 1e-9 * magnitudeOf(a.x, a.y, b.x, b.y, delta.x, delta.y);
      expect(Math.abs(b.x - a.x - delta.x)).toBeLessThanOrEqual(tolerance + 1e-6);
      expect(Math.abs(b.y - a.y - delta.y)).toBeLessThanOrEqual(tolerance + 1e-6);
    }), params(200));
  });

  it('viewportBounds contains the board image of every screen point inside the viewport and margin', () => {
    fc.assert(fc.property(view(), viewport, fc.integer({ min: 0, max: 64 }), real(0, 1), real(0, 1), (v, size, margin, u, w) => {
      const seen = viewportBounds(v, size.width, size.height, margin);
      expect(seen.minX <= seen.maxX && seen.minY <= seen.maxY).toBe(true);
      const s = { x: -margin + u * (size.width + 2 * margin), y: -margin + w * (size.height + 2 * margin) };
      const p = screenToBoard(s, v, size.width, size.height);
      const slack = 1e-9 * magnitudeOf(p.x, p.y, seen.minX, seen.maxX, seen.minY, seen.maxY);
      expect(p.x).toBeGreaterThanOrEqual(seen.minX - slack); expect(p.x).toBeLessThanOrEqual(seen.maxX + slack);
      expect(p.y).toBeGreaterThanOrEqual(seen.minY - slack); expect(p.y).toBeLessThanOrEqual(seen.maxY + slack);
    }), params(200));
  });

  it('fitView centres the board, picks the largest scale that fits (within its clamp) and keeps all four corners inside the padded viewport', () => {
    fc.assert(fc.property(bounds(1e4, 1e4), viewport, rotation, fc.boolean(), fc.integer({ min: 0, max: 80 }), (b, size, degrees, mirrored, padding) => {
      const fitted = fitView(b, size.width, size.height, degrees, mirrored, padding);
      expect(fitted.center).toEqual(boundsCenter(b));
      expect(fitted.rotation).toBe(degrees);
      expect(fitted.mirrored).toBe(mirrored);
      expect(fitted.scale).toBeGreaterThanOrEqual(0.1); expect(fitted.scale).toBeLessThanOrEqual(1000);
      // Independent reading of the same rule.
      const oriented = boundsFromPoints(boundsCorners(b).map(corner => orientPoint(corner, degrees, mirrored)));
      const raw = Math.min(Math.max(1, size.width - padding * 2) / Math.max(0.1, oriented.maxX - oriented.minX), Math.max(1, size.height - padding * 2) / Math.max(0.1, oriented.maxY - oriented.minY));
      expect(near(fitted.scale, clamp(raw, 0.1, 1000), 1e-12, 0)).toBe(true);
      if (raw >= 0.1 && size.width >= padding * 2 + 1 && size.height >= padding * 2 + 1) {
        for (const corner of boundsCorners(b)) {
          const s = boardToScreen(corner, fitted, size.width, size.height);
          const slack = 1e-6 * magnitudeOf(size.width, size.height);
          expect(s.x).toBeGreaterThanOrEqual(padding - slack); expect(s.x).toBeLessThanOrEqual(size.width - padding + slack);
          expect(s.y).toBeGreaterThanOrEqual(padding - slack); expect(s.y).toBeLessThanOrEqual(size.height - padding + slack);
        }
      }
    }), params(250));
  });
});

describe('segment and polygon distances', () => {
  const segment = fc.record({ a: point(1e3), b: point(1e3) });

  it('pointToSegmentDistance is non-negative, symmetric in the end points, bounded by both end points and zero on the segment', () => {
    fc.assert(fc.property(segment, point(1e3), real(0, 1), ({ a, b }, p, t) => {
      const d = pointToSegmentDistance(p, a, b);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(near(d, pointToSegmentDistance(p, b, a), 1e-9, 1e-9)).toBe(true);
      expect(d).toBeLessThanOrEqual(Math.min(distance(p, a), distance(p, b)) + 1e-9);
      const onSegment = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      expect(pointToSegmentDistance(onSegment, a, b)).toBeLessThanOrEqual(1e-9 * magnitudeOf(a.x, a.y, b.x, b.y));
    }), params(300));
  });

  it('pointToSegmentDistance is the point distance for a zero-length segment and does not change under a rigid motion', () => {
    fc.assert(fc.property(segment, point(1e3), point(1e3), rotation, ({ a, b }, p, shift, degrees) => {
      expect(near(pointToSegmentDistance(p, a, a), distance(p, a), 1e-12, 1e-12)).toBe(true);
      const turn = (q: Point2): Point2 => { const r = degrees * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return { x: q.x * c - q.y * s + shift.x, y: q.x * s + q.y * c + shift.y }; };
      expect(near(pointToSegmentDistance(turn(p), turn(a), turn(b)), pointToSegmentDistance(p, a, b), 1e-9, 1e-7)).toBe(true);
    }), params(200));
  });

  it('pointInPolygon agrees with the half-plane test on convex polygons for every vertex start and both windings', () => {
    const regular = fc.record({ n: fc.integer({ min: 3, max: 12 }), r: real(1, 500), start: rotation, centre: point(500), flip: fc.boolean(), skip: fc.integer({ min: 0, max: 11 }) });
    fc.assert(fc.property(regular, point(1000), ({ n, r, start, centre, flip, skip }, p) => {
      let polygon = Array.from({ length: n }, (_, i) => ({ x: centre.x + r * Math.cos(start * Math.PI / 180 + i * 2 * Math.PI / n), y: centre.y + r * Math.sin(start * Math.PI / 180 + i * 2 * Math.PI / n) }));
      // Counter-clockwise by construction: inside means left of (or on) every edge. Skip points too close to the boundary.
      let edgeDistance = Infinity, leftOfAll = true;
      for (let i = 0; i < n; i++) {
        const a = polygon[i], b = polygon[(i + 1) % n];
        edgeDistance = Math.min(edgeDistance, pointToSegmentDistance(p, a, b));
        if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < 0) leftOfAll = false;
      }
      fc.pre(edgeDistance > 1e-6);
      if (flip) polygon = polygon.slice().reverse();
      const rotated = polygon.slice(skip % n).concat(polygon.slice(0, skip % n));
      expect(pointInPolygon(p, rotated)).toBe(leftOfAll);
    }), params(300));
  });

  it('a point is inside an axis-aligned rectangle polygon exactly when it is inside the rectangle (off the boundary)', () => {
    const rectangle = fc.record({ x: coordinate(500), y: coordinate(500), w: real(0.01, 500), h: real(0.01, 500) }).map(({ x, y, w, h }) => ({ minX: x, minY: y, maxX: x + w, maxY: y + h }));
    fc.assert(fc.property(rectangle, point(700), (b, p) => {
      fc.pre([Math.abs(p.x - b.minX), Math.abs(p.x - b.maxX), Math.abs(p.y - b.minY), Math.abs(p.y - b.maxY)].every(d => d > 1e-9));
      expect(pointInPolygon(p, boundsCorners(b))).toBe(p.x > b.minX && p.x < b.maxX && p.y > b.minY && p.y < b.maxY);
    }), params(300));
  });
});

describe('pad geometry', () => {
  const pad = fc.record({
    x: point(500), shape: fc.constantFrom('round' as const, 'rect' as const, 'square' as const), radius: real(0, 20),
    width: fc.option(real(0, 40), { nil: undefined }), height: fc.option(real(0, 40), { nil: undefined }), rotation: fc.option(rotation, { nil: undefined }),
  }).map(({ x, ...rest }) => ({ ...x, ...rest }));

  it('padHitDistance is never negative, zero at the pad centre, never beyond the centre distance and never below the distance to the pad bounds', () => {
    fc.assert(fc.property(pad, point(520), (p, q) => {
      const d = padHitDistance(q, p);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(padHitDistance({ x: p.x, y: p.y }, p)).toBe(0);
      expect(d).toBeLessThanOrEqual(distance(q, p) + 1e-9);
      const box = padBounds(p);
      const toBox = Math.hypot(Math.max(0, box.minX - q.x, q.x - box.maxX), Math.max(0, box.minY - q.y, q.y - box.maxY));
      expect(d).toBeGreaterThanOrEqual(toBox - 1e-9 * magnitudeOf(q.x, q.y, p.x, p.y));
    }), params(300));
  });

  it('padHitDistance is zero for the corners of a rotated rectangle and padBounds contains them', () => {
    const rectangle = fc.record({ x: point(300), width: real(0.1, 30), height: real(0.1, 30), rotation });
    fc.assert(fc.property(rectangle, fc.constantFrom(-1, 1), fc.constantFrom(-1, 1), (r, sx, sy) => {
      const pin = { x: r.x.x, y: r.x.y, shape: 'rect' as const, radius: 0, width: r.width, height: r.height, rotation: r.rotation };
      const angle = r.rotation * Math.PI / 180;
      const lx = sx * r.width / 2, ly = sy * r.height / 2;
      const corner = { x: pin.x + lx * Math.cos(angle) - ly * Math.sin(angle), y: pin.y + lx * Math.sin(angle) + ly * Math.cos(angle) };
      expect(padHitDistance(corner, pin)).toBeLessThanOrEqual(1e-6 * magnitudeOf(pin.x, pin.y));
      expect(containsPoint(expandBounds(padBounds(pin), 1e-6 * magnitudeOf(pin.x, pin.y)), corner)).toBe(true);
    }), params(200));
  });

  it('a round pad hits exactly at its radius and padBounds is the square around it, never smaller than the marker radius', () => {
    fc.assert(fc.property(point(300), real(0, 20), rotation, real(0, 5), (c, radius, degrees, marker) => {
      const pin = { x: c.x, y: c.y, shape: 'round' as const, radius, rotation: degrees };
      const edge = padHitDistance({ x: c.x + radius + 2, y: c.y }, pin);
      expect(near(edge, 2, 1e-9, 1e-6 * magnitudeOf(c.x, c.y, radius))).toBe(true);
      const box = padBounds(pin, marker);
      const half = Math.max(radius, marker);
      expect(near(box.maxX - box.minX, 2 * half, 1e-9, 1e-9 * magnitudeOf(c.x))).toBe(true);
      expect(near(box.maxY - box.minY, 2 * half, 1e-9, 1e-9 * magnitudeOf(c.y))).toBe(true);
    }), params(200));
  });
});

describe('SpatialIndex', () => {
  // Hostile bounds on purpose: inverted, NaN, infinite, beyond exact cell indices, zero-size, huge.
  const odd = fc.oneof(
    { weight: 6, arbitrary: bounds(200, 60) },
    { weight: 1, arbitrary: bounds(1e6, 1e6) },
    { weight: 1, arbitrary: fc.constantFrom<Bounds2>({ minX: NaN, minY: 0, maxX: 1, maxY: 1 }, { minX: 5, minY: 5, maxX: 4, maxY: 4 }, { minX: -Infinity, minY: -1, maxX: Infinity, maxY: 1 }, { minX: 1e20, minY: 2, maxX: 1e20, maxY: 3 }, { minX: 0, minY: 0, maxX: 0, maxY: 0 }, { minX: -1e300, minY: -1e300, maxX: 1e300, maxY: 1e300 }) },
  );

  it('query returns exactly the items whose bounds intersect, each once, whatever the cell size and however odd the bounds', () => {
    fc.assert(fc.property(fc.constantFrom(0.5, 1, 8, 64), fc.array(odd, { maxLength: 60 }), fc.array(odd, { minLength: 1, maxLength: 12 }), (cellSize, items, queries) => {
      const index = new SpatialIndex<number>(cellSize);
      items.forEach((b, i) => index.add(i, b));
      for (const q of queries) {
        const found = index.query(q);
        expect(new Set(found).size).toBe(found.length);
        const expected = items.map((b, i) => (intersects(b, q) ? i : -1)).filter(i => i >= 0);
        expect([...found].sort((a, b) => a - b)).toEqual(expected);
      }
    }), params(300));
  });

  it('rejects a non-positive or non-finite cell size', () => {
    fc.assert(fc.property(fc.constantFrom(0, -1, -0.5, NaN, Infinity, -Infinity), size => { expect(() => new SpatialIndex(size)).toThrow(); }), params(10));
  });
});

describe('bounds helpers', () => {
  it('boundsFromPoints is the tightest box and boundsCorners of it returns the four extreme corners', () => {
    fc.assert(fc.property(fc.array(point(1e4), { minLength: 1, maxLength: 40 }), points => {
      const b = boundsFromPoints(points);
      for (const p of points) expect(containsPoint(b, p)).toBe(true);
      expect(points.some(p => p.x === b.minX) && points.some(p => p.x === b.maxX) && points.some(p => p.y === b.minY) && points.some(p => p.y === b.maxY)).toBe(true);
      expect(boundsFromPoints(boundsCorners(b))).toEqual(b);
    }), params(150));
  });

  it('expandBounds and intersects are consistent: a box always intersects itself and every expansion of itself', () => {
    fc.assert(fc.property(bounds(), real(0, 100), (b, pad) => {
      expect(intersects(b, b)).toBe(true);
      expect(intersects(b, expandBounds(b, pad))).toBe(true);
      expect(containsPoint(expandBounds(b, pad), boundsCenter(b))).toBe(true);
    }), params(100));
  });

  it('clamp stays inside its limits and is the identity inside them', () => {
    fc.assert(fc.property(coordinate(1e6), coordinate(1e3), real(0, 1e3), (v, lo, span) => {
      const hi = lo + span;
      const c = clamp(v, lo, hi);
      expect(c).toBeGreaterThanOrEqual(lo); expect(c).toBeLessThanOrEqual(hi);
      if (v >= lo && v <= hi) expect(c === v).toBe(true);
    }), params(100));
  });
});
