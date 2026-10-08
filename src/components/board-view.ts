import { boardToScreen, orientPoint, screenToBoard, viewportBounds } from '../lib/geometry';
import type { Bounds2, Point2, ViewTransform } from '../lib/geometry';
import type { ViewSide } from '../lib/types';

/**
 * Panes: one canvas can show the board more than once (the two-sided view shows the top and the mirrored bottom side, the overview a
 * small whole-board view). A pane is a rectangle of the canvas with its own view transform and side; renderers draw a list of panes,
 * input picks the pane under the pointer and converts with that pane's transform. Today the board canvas uses one pane that covers
 * the whole canvas, which draws exactly what the canvas drew before panes existed.
 */

/** A rectangle of the canvas in CSS pixels. */
export interface PaneRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface BoardPane {
  /** Stable name: `main` for the single view; later `top`/`bottom` (two-sided view) and `overview`. */
  readonly id: string;
  readonly rect: PaneRect;
  readonly view: ViewTransform;
  /** The side whose parts and pads the pane shows. */
  readonly side: ViewSide;
  /** Layer ids this pane does not draw (an overview pane leaves out labels, hover and the compass, for example). */
  readonly hiddenLayers?: ReadonlySet<string>;
}

/** `[a, b, c, d, e, f]` as `CanvasRenderingContext2D.setTransform` takes it: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix2D = readonly [number, number, number, number, number, number];

export const MAIN_PANE = 'main';

/** The single pane of today's board canvas: the whole canvas. */
export function fullPane(view: ViewTransform, side: ViewSide, width: number, height: number, id = MAIN_PANE): BoardPane {
  return { id, rect: { x: 0, y: 0, width, height }, view, side };
}

/** Board millimetres to canvas device pixels: what layers drawn in board space set on the context. */
export function boardMatrix(pane: BoardPane, dpr: number): Matrix2D {
  const { view, rect } = pane;
  const basisX = orientPoint({ x: 1, y: 0 }, view.rotation, view.mirrored);
  const basisY = orientPoint({ x: 0, y: 1 }, view.rotation, view.mirrored);
  const origin = boardToScreen({ x: 0, y: 0 }, view, rect.width, rect.height);
  return [
    basisX.x * view.scale * dpr, basisX.y * view.scale * dpr,
    basisY.x * view.scale * dpr, basisY.y * view.scale * dpr,
    (rect.x + origin.x) * dpr, (rect.y + origin.y) * dpr,
  ];
}

/** Pane CSS pixels to canvas device pixels: what layers drawn in screen space (labels, measurement, compass) set on the context. */
export function screenMatrix(pane: BoardPane, dpr: number): Matrix2D {
  return [dpr, 0, 0, dpr, pane.rect.x * dpr, pane.rect.y * dpr];
}

export function applyMatrix(matrix: Matrix2D, point: Point2): Point2 {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

/** A canonical board point in pane CSS pixels (origin at the pane's top left corner). */
export const paneToScreen = (pane: BoardPane, point: Point2): Point2 => boardToScreen(point, pane.view, pane.rect.width, pane.rect.height);

/** Canvas CSS pixels to the canonical board point under them in this pane. */
export const canvasToBoard = (pane: BoardPane, point: Point2): Point2 =>
  screenToBoard({ x: point.x - pane.rect.x, y: point.y - pane.rect.y }, pane.view, pane.rect.width, pane.rect.height);

/** A canonical board point in canvas CSS pixels. */
export function boardToCanvas(pane: BoardPane, point: Point2): Point2 {
  const screen = paneToScreen(pane, point);
  return { x: pane.rect.x + screen.x, y: pane.rect.y + screen.y };
}

/** The canonical bounds the pane shows, grown by `marginPx` screen pixels on every side. */
export const paneViewport = (pane: BoardPane, marginPx = 0): Bounds2 => viewportBounds(pane.view, pane.rect.width, pane.rect.height, marginPx);

export const paneContains = (pane: BoardPane, point: Point2): boolean =>
  point.x >= pane.rect.x && point.x < pane.rect.x + pane.rect.width && point.y >= pane.rect.y && point.y < pane.rect.y + pane.rect.height;

/** The pane under a canvas point (the last one wins where panes overlap, as it is drawn last), or undefined. */
export function paneAt(panes: readonly BoardPane[], point: Point2): BoardPane | undefined {
  for (let i = panes.length - 1; i >= 0; i--) if (paneContains(panes[i], point)) return panes[i];
  return undefined;
}

/** True when the pane covers the whole canvas: nothing needs to be clipped. */
export const coversCanvas = (pane: BoardPane, width: number, height: number): boolean =>
  pane.rect.x <= 0 && pane.rect.y <= 0 && pane.rect.x + pane.rect.width >= width && pane.rect.y + pane.rect.height >= height;
