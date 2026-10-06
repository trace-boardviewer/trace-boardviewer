import { containsPoint, distance, expandBounds, padHitDistance, pointInPolygon, pointToSegmentDistance, screenToBoard } from '../lib/geometry';
import type { Bounds2, Point2, ViewTransform } from '../lib/geometry';
import type { BoardComponent, BoardPin } from '../lib/types';

/** A broad-phase lookup; BoardCanvas passes its `SpatialIndex`es, tests may pass plain arrays wrapped in `{ query }`. */
export interface HitSource<T> { query(bounds: Bounds2): T[] }
export interface HitIndices {
  pins: HitSource<BoardPin>;
  components: HitSource<BoardComponent>;
  componentsById: ReadonlyMap<string, BoardComponent>;
}
export interface HitTarget { component: BoardComponent; pin?: BoardPin }
export interface HitOptions {
  selectedComponentId: string | null;
  /** Screen-pixel tolerance around a pad (default 5.5). */
  pinTolerance?: number;
}

/** Pads of other components are only pickable from this zoom on (CSS px per mm); below it only the selected component's pads are. */
export const PAD_PICK_MIN_SCALE = 6;
/** Screen-pixel edge tolerance of a component hit. */
export const COMPONENT_EDGE_TOLERANCE_PX = 2;
export const DEFAULT_PIN_TOLERANCE_PX = 5.5;

/**
 * The pad under the pointer (B23). Candidates are the pads whose real edge is within `tolerancePx` of the pointer (that tolerance is what
 * keeps zero-size/unknown-size source pads and tiny pads clickable). Ranking: pads CONTAINING the pointer (edge distance 0) first, then the
 * smaller physical edge distance, and the distance to the pad centre only as the final tie-break. Ranking by the centre alone let a small
 * pad next to the pointer beat the large pad the pointer was inside.
 */
export function pickPad(candidates: readonly BoardPin[], point: Point2, scale: number, selectedComponentId: string | null, tolerancePx = DEFAULT_PIN_TOLERANCE_PX): BoardPin | undefined {
  const radius = tolerancePx / scale;
  let best: BoardPin | undefined;
  let bestEdge = Infinity, bestCentre = Infinity;
  for (const pin of candidates) {
    if (scale < PAD_PICK_MIN_SCALE && pin.componentId !== selectedComponentId) continue;
    const edge = padHitDistance(point, pin);
    if (!(edge <= radius)) continue;
    const centre = distance(point, pin);
    // edge === 0 is "contains": every containing pad ties on edge, so containing pads beat all non-containing ones by the same comparison.
    if (edge < bestEdge || (edge === bestEdge && centre < bestCentre)) { best = pin; bestEdge = edge; bestCentre = centre; }
  }
  return best;
}

/**
 * Whether the pointer hits a component (B17): inside its REAL outline, or within the bounded screen-pixel edge tolerance of it. The
 * bounding rectangle only stands in for a component without a usable outline (fewer than 3 vertices, which is also what is drawn).
 */
export function componentContainsPoint(component: BoardComponent, point: Point2, scale: number): boolean {
  const tolerance = COMPONENT_EDGE_TOLERANCE_PX / scale;
  if (!containsPoint(expandBounds(component.bounds, tolerance), point)) return false; // cheap reject; the outline lies within its bounds
  const outline = component.outline;
  if (outline.length < 3) return true;
  if (pointInPolygon(point, outline)) return true;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    if (pointToSegmentDistance(point, outline[j], outline[i]) <= tolerance) return true;
  }
  return false;
}

/** The smallest component whose hit region contains the point. */
export function pickComponent(candidates: readonly BoardComponent[], point: Point2, scale: number): BoardComponent | undefined {
  let nearest: BoardComponent | undefined;
  let smallest = Infinity;
  for (const component of candidates) {
    if (!componentContainsPoint(component, point, scale)) continue;
    const b = component.bounds;
    const area = Math.max(0.05, b.maxX - b.minX) * Math.max(0.05, b.maxY - b.minY);
    if (area < smallest) { nearest = component; smallest = area; }
  }
  return nearest;
}

/** Pad first (its own tolerance), then the component; `screen` is in canvas CSS pixels. */
export function hitTestBoard(indices: HitIndices, screen: Point2, view: ViewTransform, width: number, height: number, options: HitOptions): HitTarget | null {
  const point = screenToBoard(screen, view, width, height);
  const radius = (options.pinTolerance ?? DEFAULT_PIN_TOLERANCE_PX) / view.scale;
  const query = expandBounds({ minX: point.x, minY: point.y, maxX: point.x, maxY: point.y }, radius);
  const pin = pickPad(indices.pins.query(query), point, view.scale, options.selectedComponentId, options.pinTolerance);
  if (pin) {
    const component = indices.componentsById.get(pin.componentId);
    if (component) return { component, pin };
  }
  const component = pickComponent(indices.components.query(query), point, view.scale);
  return component ? { component } : null;
}
