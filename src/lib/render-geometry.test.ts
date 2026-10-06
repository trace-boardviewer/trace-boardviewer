import { describe, expect, it } from 'vitest';
import { boardToScreen, screenToBoard, viewportBounds } from './geometry';
import { appendPadPath, clipSegmentToBounds } from './render-geometry';
import type { BoardPin } from './types';

describe('viewport relation clipping', () => {
  const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 8 };

  it('retains crossings even with both endpoints outside, and clips to the true segment', () => {
    expect(clipSegmentToBounds({ x: -10, y: -5 }, { x: 20, y: 10 }, bounds)).toEqual({
      from: { x: 0, y: 0 }, to: { x: 10, y: 5 },
    });
    expect(clipSegmentToBounds({ x: -10, y: 7 }, { x: 20, y: 7 }, bounds)).toEqual({
      from: { x: 0, y: 7 }, to: { x: 10, y: 7 },
    });
    expect(clipSegmentToBounds({ x: 20, y: 7 }, { x: -10, y: 7 }, bounds)).toEqual({
      from: { x: 10, y: 7 }, to: { x: 0, y: 7 },
    });
  });

  it('rejects misses without dropping edge tangents or zero-length relations', () => {
    expect(clipSegmentToBounds({ x: -10, y: 9 }, { x: 20, y: 9 }, bounds)).toBeNull();
    expect(clipSegmentToBounds({ x: -2, y: -2 }, { x: -1, y: -1 }, bounds)).toBeNull();
    expect(clipSegmentToBounds({ x: 3, y: -10 }, { x: 3, y: 20 }, bounds)).toEqual({
      from: { x: 3, y: 0 }, to: { x: 3, y: 8 },
    });
    expect(clipSegmentToBounds({ x: -1, y: 0 }, { x: 11, y: 0 }, bounds)).toEqual({
      from: { x: 0, y: 0 }, to: { x: 10, y: 0 },
    });
    expect(clipSegmentToBounds({ x: 3, y: 4 }, { x: 3, y: 4 }, bounds)).toEqual({
      from: { x: 3, y: 4 }, to: { x: 3, y: 4 },
    });
  });

  for (const mirrored of [false, true]) for (const rotation of [0, 90, 180, 270]) {
    it(`keeps the correct viewport crossing at ${rotation} degrees, mirrored=${mirrored}`, () => {
      const view = { center: { x: 21, y: -4 }, scale: 3, rotation, mirrored };
      const from = screenToBoard({ x: -200, y: 200 }, view, 800, 600);
      const to = screenToBoard({ x: 1000, y: 400 }, view, 800, 600);
      const clipped = clipSegmentToBounds(from, to, viewportBounds(view, 800, 600))!;
      const a = boardToScreen(clipped.from, view, 800, 600);
      const b = boardToScreen(clipped.to, view, 800, 600);
      expect(a.x).toBeCloseTo(0, 9); expect(a.y).toBeCloseTo(233.333333333, 8);
      expect(b.x).toBeCloseTo(800, 9); expect(b.y).toBeCloseTo(366.666666667, 8);
    });
  }
});

describe('batched display pads', () => {
  const pin: BoardPin = { id: 'R1:1', componentId: 'R1', number: '1', name: '1', net: 'GND', side: 'top', x: 10, y: 20, radius: 0, shape: 'round' };
  function record() {
    const operations: Array<{ kind: string; values: number[] }> = [];
    return { operations, path: {
      moveTo: (...values: number[]) => { operations.push({ kind: 'move', values }); },
      lineTo: (...values: number[]) => { operations.push({ kind: 'line', values }); },
      arc: (...values: number[]) => { operations.push({ kind: 'arc', values }); },
      closePath: () => { operations.push({ kind: 'close', values: [] }); },
    } };
  }

  it('preserves zero-size physical pads and creates separate visible circle subpaths', () => {
    const { path, operations } = record();
    appendPadPath(path, pin, 10, 2.2);
    appendPadPath(path, { ...pin, x: 30, radius: 0.5 }, 10, 2.2);
    expect(operations.map(item => item.kind)).toEqual(['move', 'arc', 'move', 'arc']);
    expect(operations[1].values[2]).toBeCloseTo(0.22, 10);
    expect(operations[3].values[2]).toBe(0.5);
    expect(pin.radius).toBe(0);
  });

  it('places real rectangular corners with the source rotation and original dimensions', () => {
    const { path, operations } = record();
    const rectangle = { ...pin, shape: 'rect' as const, width: 4, height: 2, rotation: 90 };
    appendPadPath(path, rectangle, 10, 1);
    const corners = operations.filter(item => item.kind === 'move' || item.kind === 'line');
    const expected = [[11, 18], [11, 22], [9, 22], [9, 18]];
    corners.forEach((corner, index) => {
      expect(corner.values[0]).toBeCloseTo(expected[index][0], 10);
      expect(corner.values[1]).toBeCloseTo(expected[index][1], 10);
    });
    expect(rectangle).toMatchObject({ x: 10, y: 20, width: 4, height: 2, rotation: 90 });
  });
});
