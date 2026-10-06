import { describe, expect, it } from 'vitest';
import { boardToScreen, distance, fitView, padBounds, padHitDistance, panBy, screenToBoard, SpatialIndex, viewportBounds, zoomAt } from './geometry';

describe('canonical board transforms', () => {
  for (const mirrored of [false, true]) for (const rotation of [0, 90, 180, 270]) {
    it(`round-trips screen coordinates at ${rotation} degrees, mirrored=${mirrored}`, () => {
      const view = { center: { x: 15, y: -27 }, scale: 8.25, rotation, mirrored };
      const point = { x: -4.3, y: 92.4 };
      const actual = screenToBoard(boardToScreen(point, view, 900, 650), view, 900, 650);
      expect(actual.x).toBeCloseTo(point.x, 10);
      expect(actual.y).toBeCloseTo(point.y, 10);
      const cursor = { x: 247, y: 519 };
      const anchor = screenToBoard(cursor, view, 900, 650);
      const zoomed = zoomAt(view, cursor, 19, 900, 650);
      const anchored = boardToScreen(anchor, zoomed, 900, 650);
      expect(anchored.x).toBeCloseTo(cursor.x, 10);
      expect(anchored.y).toBeCloseTo(cursor.y, 10);
      const panned = boardToScreen(point, panBy(view, { x: 75, y: -23 }), 900, 650);
      const initial = boardToScreen(point, view, 900, 650);
      expect(panned.x - initial.x).toBeCloseTo(75, 10);
      expect(panned.y - initial.y).toBeCloseTo(-23, 10);
    });
  }

  it('fits a non-square rotated board and measures canonical millimetres', () => {
    const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 80 };
    const view = fitView(bounds, 400, 600, 90, true, 50);
    expect(view.scale).toBeCloseTo(2.5);
    const visible = viewportBounds(view, 400, 600);
    expect(visible.minX).toBeLessThan(bounds.minX);
    expect(visible.maxX).toBeGreaterThan(bounds.maxX);
    expect(visible.minY).toBeLessThan(bounds.minY);
    expect(visible.maxY).toBeGreaterThan(bounds.maxY);
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

describe('spatial index', () => {
  it('includes components crossing cells, filters misses, and never duplicates a result', () => {
    const index = new SpatialIndex<string>(8);
    index.add('crossing', { minX: -1, minY: -1, maxX: 17, maxY: 17 });
    index.add('far', { minX: 80, minY: 80, maxX: 82, maxY: 82 });
    index.add('oversized', { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 });
    expect(index.query({ minX: 16.9, minY: 16.9, maxX: 18, maxY: 18 })).toEqual(['oversized', 'crossing']);
    expect(index.query({ minX: -3, minY: -3, maxX: 20, maxY: 20 }).sort()).toEqual(['crossing', 'oversized']);
    expect(index.query({ minX: 1200, minY: 1200, maxX: 1300, maxY: 1300 })).toEqual([]);
    expect(index.query({ minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 }).sort()).toEqual(['crossing', 'far', 'oversized']);
  });

  it('never loops on extreme, non-finite or inverted grid indices (B16)', () => {
    const index = new SpatialIndex<string>(8);
    // 1e20 / 8 is far beyond exact integers: incrementing that cell index would not change it.
    index.add('extreme', { minX: 1e20, minY: 2, maxX: 1e20, maxY: 3 });
    index.add('nan', { minX: NaN, minY: 0, maxX: 1, maxY: 1 });
    index.add('inverted', { minX: 5, minY: 5, maxX: 4, maxY: 4 });
    index.add('near', { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    expect(index.query({ minX: 1e20, minY: 0, maxX: 1e20, maxY: 5 })).toEqual(['extreme']);
    expect(index.query({ minX: -1, minY: -1, maxX: 2, maxY: 2 })).toEqual(['near']);
    expect(index.query({ minX: NaN, minY: 0, maxX: 1, maxY: 1 })).toEqual([]);
    expect(index.query({ minX: Infinity, minY: 0, maxX: Infinity, maxY: 1 })).toEqual([]);
  });
});

describe('physical pad geometry', () => {
  const rectangle = { x: 10, y: 20, shape: 'rect' as const, radius: 0.5, width: 4, height: 1, rotation: 45 };

  it('indexes the full rotated rectangle, including diagonal corners', () => {
    const extent = 2.5 / Math.sqrt(2);
    const bounds = padBounds(rectangle);
    expect(bounds.minX).toBeCloseTo(10 - extent, 10);
    expect(bounds.maxX).toBeCloseTo(10 + extent, 10);
    expect(bounds.minY).toBeCloseTo(20 - extent, 10);
    expect(bounds.maxY).toBeCloseTo(20 + extent, 10);
    const index = new SpatialIndex<typeof rectangle>(1);
    index.add(rectangle, bounds);
    expect(index.query({ minX: 11.7, maxX: 11.8, minY: 21, maxY: 21.1 })).toEqual([rectangle]);
  });

  it('tests the rotated pad shape instead of its enclosing circle or rectangle', () => {
    expect(padHitDistance({ x: 10 + Math.SQRT2, y: 20 + Math.SQRT2 }, rectangle)).toBeCloseTo(0, 10);
    expect(padHitDistance({ x: 10 + 1.7, y: 20 - 1.7 }, rectangle)).toBeGreaterThan(1.8);
    expect(padHitDistance({ x: 10 + Math.SQRT1_2, y: 20 - Math.SQRT1_2 }, rectangle)).toBeCloseTo(0.5, 10);
  });

  it('keeps zero-size pins physical dimensions at zero while allowing display bounds', () => {
    const marker = { x: 3, y: 4, shape: 'round' as const, radius: 0, width: 0, height: 0 };
    expect(padBounds(marker)).toEqual({ minX: 3, minY: 4, maxX: 3, maxY: 4 });
    expect(padBounds(marker, 0.1)).toEqual({ minX: 2.9, minY: 3.9, maxX: 3.1, maxY: 4.1 });
    expect(padHitDistance({ x: 3.3, y: 4.4 }, marker)).toBeCloseTo(0.5, 10);
    expect(marker).toMatchObject({ radius: 0, width: 0, height: 0 });
  });

  it('preserves round-pad geometry and axis-aligned rectangular hit distances', () => {
    expect(padBounds({ x: 0, y: 0, shape: 'round', radius: 2, rotation: 35 })).toEqual({ minX: -2, minY: -2, maxX: 2, maxY: 2 });
    expect(padHitDistance({ x: 3, y: 4 }, { x: 0, y: 0, shape: 'round', radius: 2 })).toBe(3);
    expect(padHitDistance({ x: 13, y: 20 }, { ...rectangle, rotation: 0 })).toBe(1);
    expect(padHitDistance({ x: 12.3, y: 20.9 }, { ...rectangle, rotation: 0 })).toBeCloseTo(0.5, 10);
  });
});
