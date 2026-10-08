import { describe, expect, it } from 'vitest';
import { boardToScreen, orientPoint, screenToBoard, viewportBounds } from '../lib/geometry';
import type { Point2, ViewTransform } from '../lib/geometry';
import { applyMatrix, boardMatrix, boardToCanvas, canvasToBoard, coversCanvas, fullPane, MAIN_PANE, paneAt, paneToScreen, paneViewport, screenMatrix } from './board-view';
import type { BoardPane } from './board-view';

const views: ViewTransform[] = [];
for (const rotation of [0, 90, 180, 270]) for (const mirrored of [false, true]) for (const scale of [0.37, 4.2, 61]) {
  views.push({ center: { x: 31.25 - rotation / 10, y: -12.5 + scale }, scale, rotation, mirrored });
}
const points: Point2[] = [{ x: 0, y: 0 }, { x: 31.25, y: -12.5 }, { x: -140.3, y: 88.1 }, { x: 1e4, y: -3e3 }];
const close = (a: Point2, b: Point2, tolerance = 1e-9) => {
  expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(tolerance * Math.max(1, Math.abs(b.x)));
  expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(tolerance * Math.max(1, Math.abs(b.y)));
};

describe('board view: the transforms of a pane', () => {
  it('sets exactly the board transform the canvas set before panes existed (single pane, any view, any device scale)', () => {
    for (const view of views) for (const dpr of [1, 1.25, 2, 2.5]) {
      const width = 1440, height = 960;
      // The canvas' own transform before the split, verbatim.
      const basisX = orientPoint({ x: 1, y: 0 }, view.rotation, view.mirrored);
      const basisY = orientPoint({ x: 0, y: 1 }, view.rotation, view.mirrored);
      const screenOrigin = boardToScreen({ x: 0, y: 0 }, view, width, height);
      const legacy = [
        basisX.x * view.scale * dpr, basisX.y * view.scale * dpr,
        basisY.x * view.scale * dpr, basisY.y * view.scale * dpr,
        screenOrigin.x * dpr, screenOrigin.y * dpr,
      ];
      const pane = fullPane(view, view.mirrored ? 'bottom' : 'top', width, height);
      expect([...boardMatrix(pane, dpr)].map(value => value + 0)).toEqual(legacy.map(value => value + 0));
      expect(screenMatrix(pane, dpr)).toEqual([dpr, 0, 0, dpr, 0, 0]);
    }
  });

  it('maps a board point to the same canvas pixel through the matrix and through the point conversion, in a pane anywhere on the canvas', () => {
    for (const view of views) {
      const pane: BoardPane = { id: 'second', rect: { x: 700, y: 40, width: 640, height: 480 }, view, side: view.mirrored ? 'bottom' : 'top' };
      for (const point of points) {
        const canvas = boardToCanvas(pane, point);
        const screen = paneToScreen(pane, point);
        close(canvas, { x: screen.x + 700, y: screen.y + 40 });
        close(applyMatrix(boardMatrix(pane, 1), point), canvas);
        const device = applyMatrix(boardMatrix(pane, 2), point);
        close(device, { x: canvas.x * 2, y: canvas.y * 2 });
        close(canvasToBoard(pane, canvas), point, 1e-7);
        close(applyMatrix(screenMatrix(pane, 2), screen), device);
      }
    }
  });

  it('converts like the plain view functions when the pane covers the canvas', () => {
    for (const view of views) {
      const pane = fullPane(view, 'top', 800, 600);
      expect(pane.id).toBe(MAIN_PANE);
      for (const point of points) {
        expect(paneToScreen(pane, point)).toEqual(boardToScreen(point, view, 800, 600));
        const screen = { x: 123.5, y: 456.25 };
        expect(canvasToBoard(pane, screen)).toEqual(screenToBoard(screen, view, 800, 600));
      }
      expect(paneViewport(pane, 30)).toEqual(viewportBounds(view, 800, 600, 30));
      expect(paneViewport(pane)).toEqual(viewportBounds(view, 800, 600, 0));
    }
  });
});

describe('board view: pane layout', () => {
  const view: ViewTransform = { center: { x: 0, y: 0 }, scale: 1, rotation: 0, mirrored: false };
  const left: BoardPane = { id: 'top', rect: { x: 0, y: 0, width: 400, height: 300 }, view, side: 'top' };
  const right: BoardPane = { id: 'bottom', rect: { x: 400, y: 0, width: 400, height: 300 }, view: { ...view, mirrored: true }, side: 'bottom' };
  const overview: BoardPane = { id: 'overview', rect: { x: 300, y: 200, width: 160, height: 100 }, view, side: 'top' };

  it('finds the pane under a canvas point, the last one where panes overlap (it is drawn on top)', () => {
    const panes = [left, right, overview];
    expect(paneAt(panes, { x: 10, y: 10 })?.id).toBe('top');
    expect(paneAt(panes, { x: 399.99, y: 10 })?.id).toBe('top');
    expect(paneAt(panes, { x: 400, y: 10 })?.id).toBe('bottom');
    expect(paneAt(panes, { x: 350, y: 250 })?.id).toBe('overview');
    expect(paneAt(panes, { x: 450, y: 250 })?.id).toBe('overview');
    expect(paneAt(panes, { x: 800, y: 10 })).toBeUndefined();
    expect(paneAt(panes, { x: -1, y: 10 })).toBeUndefined();
    expect(paneAt([], { x: 1, y: 1 })).toBeUndefined();
  });

  it('knows when a pane covers the whole canvas (nothing to clip)', () => {
    expect(coversCanvas(fullPane(view, 'top', 800, 300), 800, 300)).toBe(true);
    expect(coversCanvas(left, 800, 300)).toBe(false);
    expect(coversCanvas(right, 800, 300)).toBe(false);
  });
});
