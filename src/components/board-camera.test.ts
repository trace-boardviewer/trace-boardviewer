import { describe, expect, it } from 'vitest';
import { fitView } from '../lib/geometry';
import { cameraToView, normalizeRotation, parseBoardCamera, sameCamera, viewShowsBoard, viewToCamera } from './board-camera';

const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 60 };

describe('board camera persistence', () => {
  it('round-trips a view including the viewed side and rotation', () => {
    const view = { center: { x: 12.3456, y: 40.9876 }, scale: 7.123456, rotation: 90, mirrored: true };
    const camera = viewToCamera(view);
    expect(camera).toEqual({ zoom: 7.1235, x: 12.346, y: 40.988, rotation: 90, side: 'bottom' });
    const back = cameraToView(camera);
    expect(back.mirrored).toBe(true);
    expect(back.rotation).toBe(90);
    expect(back.center).toEqual({ x: 12.346, y: 40.988 });
    expect(viewToCamera(back)).toEqual(camera);
  });

  it('accepts a complete camera, defaults the side to top and the rotation to 0, and normalizes the rotation', () => {
    expect(parseBoardCamera({ zoom: 4, x: 1, y: 2, rotation: 450, side: 'bottom' })).toEqual({ zoom: 4, x: 1, y: 2, rotation: 90, side: 'bottom' });
    expect(parseBoardCamera({ zoom: 4, x: 1, y: 2 })).toEqual({ zoom: 4, x: 1, y: 2, rotation: 0, side: 'top' });
    expect(normalizeRotation(-90)).toBe(270);
  });

  it('rejects absent, partial, non-finite and out-of-range data (the caller then fits)', () => {
    for (const bad of [undefined, null, 5, 'x', {}, { zoom: 4 }, { zoom: 4, x: 1 }, { zoom: 0, x: 1, y: 2 }, { zoom: 0.05, x: 1, y: 2 }, { zoom: 5000, x: 1, y: 2 },
      { zoom: NaN, x: 1, y: 2 }, { zoom: 4, x: Infinity, y: 2 }, { zoom: 4, x: 1, y: 2e7 }, { zoom: '4', x: 1, y: 2 }, { zoom: 4, x: 1, y: 2, side: 'left' }, { zoom: 4, x: 1, y: 2, rotation: 'a' }]) {
      expect(parseBoardCamera(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('drops a view that shows nothing of the board, keeps a partly visible one', () => {
    const fit = fitView(bounds, 800, 500);
    expect(viewShowsBoard(fit, bounds, 800, 500)).toBe(true);
    expect(viewShowsBoard({ ...fit, center: { x: 50, y: 30 }, scale: 40 }, bounds, 800, 500)).toBe(true);
    expect(viewShowsBoard({ ...fit, center: { x: 5000, y: 30 } }, bounds, 800, 500)).toBe(false);
    expect(viewShowsBoard({ ...fit, center: { x: 100 + 400 / fit.scale - 1, y: 30 } }, bounds, 800, 500)).toBe(true);
    expect(viewShowsBoard({ ...fit, rotation: 90, mirrored: true, center: { x: 0, y: -9000 } }, bounds, 800, 500)).toBe(false);
  });

  it('compares cameras by value', () => {
    const a = { zoom: 2, x: 1, y: 1, rotation: 0, side: 'top' as const };
    expect(sameCamera(a, { ...a })).toBe(true);
    expect(sameCamera(a, { ...a, side: 'bottom' })).toBe(false);
    expect(sameCamera(a, null)).toBe(false);
    expect(sameCamera(null, null)).toBe(true);
  });
});
