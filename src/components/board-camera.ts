import { clamp, viewportBounds } from '../lib/geometry';
import type { Bounds2, ViewTransform } from '../lib/geometry';

/**
 * Persisted board view (DocumentCamera semantics, src/lib/documents.ts): zoom = canvas scale in CSS px per mm, x/y = the canonical (Y-up)
 * board point at the viewport centre in mm, rotation in degrees and `side` = the viewed side (a mirrored bottom view cannot be restored
 * from the numbers alone).
 */
export interface BoardCamera { zoom: number; x: number; y: number; rotation: number; side: 'top' | 'bottom' }

export const MIN_BOARD_ZOOM = 0.1;
export const MAX_BOARD_ZOOM = 1000;
/** No real board is anywhere near this far from the origin; larger numbers are corrupt data, not a view. */
const MAX_COORDINATE = 1e6;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const round = (value: number, digits: number) => { const f = 10 ** digits; return Math.round(value * f) / f; };

export function normalizeRotation(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** Validates what the workspace manifest returned for the source 'board'. Anything unusable (absent, partial, out of range) is null: the caller fits instead. */
export function parseBoardCamera(raw: unknown): BoardCamera | null {
  if (!raw || typeof raw !== 'object') return null;
  const { zoom, x, y, rotation, side } = raw as Record<string, unknown>;
  if (!finite(zoom) || !finite(x) || !finite(y)) return null;
  if (zoom < MIN_BOARD_ZOOM || zoom > MAX_BOARD_ZOOM || Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE) return null;
  if (rotation !== undefined && !finite(rotation)) return null;
  if (side !== undefined && side !== 'top' && side !== 'bottom') return null;
  return { zoom, x, y, rotation: normalizeRotation(rotation ?? 0), side: side ?? 'top' };
}

export function cameraToView(camera: BoardCamera): ViewTransform {
  return { center: { x: camera.x, y: camera.y }, scale: clamp(camera.zoom, MIN_BOARD_ZOOM, MAX_BOARD_ZOOM), rotation: normalizeRotation(camera.rotation), mirrored: camera.side === 'bottom' };
}

/** Rounded so that an unchanged view always serializes identically (the caller drops equal consecutive cameras). */
export function viewToCamera(view: ViewTransform): BoardCamera {
  return { zoom: round(view.scale, 4), x: round(view.center.x, 3), y: round(view.center.y, 3), rotation: normalizeRotation(view.rotation), side: view.mirrored ? 'bottom' : 'top' };
}

export const sameCamera = (a: BoardCamera | null, b: BoardCamera | null): boolean =>
  a === b || (!!a && !!b && a.zoom === b.zoom && a.x === b.x && a.y === b.y && a.rotation === b.rotation && a.side === b.side);

/** A restored view is only kept when part of the board is on screen; a view panned into empty space (or a camera of another, larger board) falls back to fit. */
export function viewShowsBoard(view: ViewTransform, bounds: Bounds2, width: number, height: number): boolean {
  const seen = viewportBounds(view, width, height);
  return seen.maxX >= bounds.minX && seen.minX <= bounds.maxX && seen.maxY >= bounds.minY && seen.minY <= bounds.maxY;
}
