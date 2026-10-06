/** Board geometry remains in canonical millimetres, independent of view side. */
export interface Point2 { x: number; y: number }
export interface Bounds2 { minX: number; minY: number; maxX: number; maxY: number }
interface PadGeometry extends Point2 {
  shape: 'round' | 'rect' | 'square'; radius: number; width?: number; height?: number; rotation?: number;
}
export interface ViewTransform {
  /** Canonical board coordinate at the centre of the viewport. */
  center: Point2;
  /** CSS pixels per millimetre. */
  scale: number;
  rotation: number;
  mirrored: boolean;
}

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const distance = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y);
export const boundsCenter = (b: Bounds2): Point2 => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
export const expandBounds = (b: Bounds2, padding: number): Bounds2 => ({
  minX: b.minX - padding, minY: b.minY - padding, maxX: b.maxX + padding, maxY: b.maxY + padding,
});
export const intersects = (a: Bounds2, b: Bounds2) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
export const containsPoint = (b: Bounds2, p: Point2) =>
  p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;

/** Physical pad bounds, with an optional display-only radius for zero-size markers. */
export function padBounds(pad: PadGeometry, markerRadius = 0): Bounds2 {
  let halfWidth = pad.radius, halfHeight = pad.radius;
  if (pad.shape !== 'round' && (pad.width || pad.height)) {
    const w = (pad.width ?? pad.radius * 2) / 2, h = (pad.height ?? pad.radius * 2) / 2;
    const angle = (pad.rotation ?? 0) * Math.PI / 180;
    const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
    halfWidth = w * c + h * s; halfHeight = w * s + h * c;
  }
  halfWidth = Math.max(halfWidth, markerRadius); halfHeight = Math.max(halfHeight, markerRadius);
  return { minX: pad.x - halfWidth, minY: pad.y - halfHeight, maxX: pad.x + halfWidth, maxY: pad.y + halfHeight };
}

/** Distance from a point to the real pad edge; rotation never changes hit coordinates. */
export function padHitDistance(point: Point2, pad: PadGeometry): number {
  if (pad.shape === 'round' || !(pad.width || pad.height)) return Math.max(0, distance(point, pad) - pad.radius);
  const angle = (pad.rotation ?? 0) * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  const dx = point.x - pad.x, dy = point.y - pad.y;
  const x = dx * c + dy * s, y = -dx * s + dy * c;
  return Math.hypot(
    Math.max(0, Math.abs(x) - (pad.width ?? pad.radius * 2) / 2),
    Math.max(0, Math.abs(y) - (pad.height ?? pad.radius * 2) / 2),
  );
}

/** Mirrors about canonical Y, flips engineering Y into screen Y, then rotates clockwise. */
export function orientPoint(point: Point2, rotation: number, mirrored: boolean): Point2 {
  const x = mirrored ? -point.x : point.x;
  const y = -point.y;
  const angle = rotation * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: x * c - y * s, y: x * s + y * c };
}

export function unorientPoint(point: Point2, rotation: number, mirrored: boolean): Point2 {
  const angle = -rotation * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  const x = point.x * c - point.y * s;
  const y = point.x * s + point.y * c;
  return { x: mirrored ? -x : x, y: -y };
}

export function boardToScreen(point: Point2, view: ViewTransform, width: number, height: number): Point2 {
  const delta = orientPoint({ x: point.x - view.center.x, y: point.y - view.center.y }, view.rotation, view.mirrored);
  return { x: width / 2 + delta.x * view.scale, y: height / 2 + delta.y * view.scale };
}

export function screenToBoard(point: Point2, view: ViewTransform, width: number, height: number): Point2 {
  const delta = unorientPoint({ x: (point.x - width / 2) / view.scale, y: (point.y - height / 2) / view.scale }, view.rotation, view.mirrored);
  return { x: view.center.x + delta.x, y: view.center.y + delta.y };
}

export function boundsFromPoints(points: readonly Point2[]): Bounds2 {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

export function boundsCorners(b: Bounds2): Point2[] {
  return [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
}

/** The canonical AABB of the viewport, used to query the spatial index. */
export function viewportBounds(view: ViewTransform, width: number, height: number, margin = 0): Bounds2 {
  return boundsFromPoints([
    { x: -margin, y: -margin }, { x: width + margin, y: -margin },
    { x: width + margin, y: height + margin }, { x: -margin, y: height + margin },
  ].map(p => screenToBoard(p, view, width, height)));
}

export function fitView(bounds: Bounds2, width: number, height: number, rotation = 0, mirrored = false, padding = 60): ViewTransform {
  const oriented = boundsFromPoints(boundsCorners(bounds).map(p => orientPoint(p, rotation, mirrored)));
  const scale = Math.min(
    Math.max(1, width - padding * 2) / Math.max(0.1, oriented.maxX - oriented.minX),
    Math.max(1, height - padding * 2) / Math.max(0.1, oriented.maxY - oriented.minY),
  );
  return { center: boundsCenter(bounds), scale: clamp(scale, 0.1, 1000), rotation, mirrored };
}

/** Preserves the exact canonical point under the mouse, including rotated back views. */
export function zoomAt(view: ViewTransform, anchor: Point2, nextScale: number, width: number, height: number): ViewTransform {
  const original = screenToBoard(anchor, view, width, height);
  const next = { ...view, scale: clamp(nextScale, 0.1, 1000) };
  const moved = screenToBoard(anchor, next, width, height);
  return { ...next, center: { x: next.center.x + original.x - moved.x, y: next.center.y + original.y - moved.y } };
}

export function panBy(view: ViewTransform, screenDelta: Point2): ViewTransform {
  const delta = unorientPoint({ x: screenDelta.x / view.scale, y: screenDelta.y / view.scale }, view.rotation, view.mirrored);
  return { ...view, center: { x: view.center.x - delta.x, y: view.center.y - delta.y } };
}

export function pointToSegmentDistance(point: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

export function pointInPolygon(point: Point2, polygon: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Grid indices stay exact integers below this; beyond it `x + 1 === x` and a cell loop could never advance. */
const MAX_CELL_INDEX = 2 ** 40;
interface CellRange { minX: number; maxX: number; minY: number; maxY: number }
/** Integer cell range of bounds, or null when the bounds are not finite, inverted or too far out to index safely. */
function cellRange(bounds: Bounds2, cellSize: number): CellRange | null {
  const range = {
    minX: Math.floor(bounds.minX / cellSize), maxX: Math.floor(bounds.maxX / cellSize),
    minY: Math.floor(bounds.minY / cellSize), maxY: Math.floor(bounds.maxY / cellSize),
  };
  for (const index of Object.values(range)) if (!Number.isFinite(index) || Math.abs(index) > MAX_CELL_INDEX) return null;
  return range.minX > range.maxX || range.minY > range.maxY ? null : range;
}
const cellCount = (range: CellRange) => (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);

/** A static uniform grid. Bounds crossing a cell edge are indexed in every touched cell. */
export class SpatialIndex<T> {
  private readonly cells = new Map<string, number[]>();
  private readonly oversized: number[] = [];
  private readonly items: Array<{ value: T; bounds: Bounds2 }> = [];
  constructor(readonly cellSize = 8) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('The spatial cell size must be positive.');
  }

  add(value: T, bounds: Bounds2): void {
    const id = this.items.push({ value, bounds }) - 1;
    // Unindexable bounds (non-finite, inverted or beyond exact integer cells) are scanned linearly instead.
    const range = cellRange(bounds, this.cellSize);
    if (!range || cellCount(range) > 256) {
      this.oversized.push(id); return;
    }
    for (let x = range.minX; x <= range.maxX; x++) for (let y = range.minY; y <= range.maxY; y++) {
      const key = `${x}:${y}`;
      const cell = this.cells.get(key);
      if (cell) cell.push(id); else this.cells.set(key, [id]);
    }
  }

  query(bounds: Bounds2): T[] {
    const range = cellRange(bounds, this.cellSize);
    // Fit-to-board queries can cover many empty cells; scanning all items is cheaper here.
    if (!range || cellCount(range) > Math.max(this.cells.size * 2, 512)) {
      return this.items.filter(item => intersects(item.bounds, bounds)).map(item => item.value);
    }
    const { minX, maxX, minY, maxY } = range;
    const candidates = new Set<number>(this.oversized);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const cell = this.cells.get(`${x}:${y}`);
      if (cell) for (const id of cell) candidates.add(id);
    }
    const result: T[] = [];
    for (const id of candidates) if (intersects(this.items[id].bounds, bounds)) result.push(this.items[id].value);
    return result;
  }
}
