/**
 * Geometry and Canvas 2D drawing of one schematic sheet instance. Everything before the `// ---- drawing` marker is
 * pure (no DOM): camera math, the uniform-grid culling index, label / text layout, hit-testing, net highlighting and
 * navigation helpers, so it runs in node under vitest. The drawing code only touches the context it is handed.
 *
 * Conventions (document space = millimetres of the sheet definition, Y down, see src/lib/schematic/model.ts):
 *  - View: `{ x, y, scale }` = sheet point at the viewport centre + CSS pixels per mm. `ViewerCamera.zoom` is
 *    `scale / BASE_SCALE`, `ViewerCamera.x/y` the same centre point.
 *  - Text angles are degrees counter-clockwise on screen. A label extends from its anchor in the direction of its
 *    angle (0 = right, 90 = up, 180 = left, 270 = down); the glyphs are never upside down (180 reads left to right and
 *    is right-aligned at the anchor, 270 reads bottom to top and extends downwards).
 *  - Text is monospaced (advance 0.6 em) so label boxes are exact without measuring.
 */
import type {
  SchBounds, SchConnectivity, SchGraphic, SchLabel, SchNet, SchPin, SchPoint, SchSheetDef, SchSheetInstance, SchSymbol, Schematic,
} from '../lib/schematic/model';
import type { ViewerCamera } from './viewer-contracts';

// ---------------------------------------------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------------------------------------------

export const BASE_SCALE = 4;
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 320;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const clampScale = (scale: number) => (Number.isFinite(scale) ? clamp(scale, MIN_SCALE, MAX_SCALE) : BASE_SCALE);

export interface SchView { x: number; y: number; scale: number }
export type FitMode = 'width' | 'page' | 'none';

export const sheetToScreen = (view: SchView, width: number, height: number, p: SchPoint): SchPoint =>
  ({ x: width / 2 + (p.x - view.x) * view.scale, y: height / 2 + (p.y - view.y) * view.scale });
export const screenToSheet = (view: SchView, width: number, height: number, p: SchPoint): SchPoint =>
  ({ x: view.x + (p.x - width / 2) / view.scale, y: view.y + (p.y - height / 2) / view.scale });

/** Sheet-space rectangle covered by the viewport, grown by `marginPx` screen pixels. */
export function viewBounds(view: SchView, width: number, height: number, marginPx = 0): SchBounds {
  const hw = width / 2 + marginPx, hh = height / 2 + marginPx;
  return { minX: view.x - hw / view.scale, minY: view.y - hh / view.scale, maxX: view.x + hw / view.scale, maxY: view.y + hh / view.scale };
}

/** `page` shows the whole extent; `width` fits its width and aligns the top edge (long sheets scroll vertically). */
export function fitView(bounds: SchBounds, width: number, height: number, mode: 'width' | 'page', padding = 28): SchView {
  const pad = Math.min(padding, width / 4, height / 4);
  const bw = Math.max(1e-3, bounds.maxX - bounds.minX), bh = Math.max(1e-3, bounds.maxY - bounds.minY);
  const fitW = Math.max(1, width - pad * 2) / bw, fitH = Math.max(1, height - pad * 2) / bh;
  const scale = clampScale(mode === 'width' ? fitW : Math.min(fitW, fitH));
  const x = (bounds.minX + bounds.maxX) / 2;
  const y = mode === 'width' ? bounds.minY + (height / 2 - pad) / scale : (bounds.minY + bounds.maxY) / 2;
  return { x, y, scale };
}

/** Keeps the sheet point under `anchor` (screen px) fixed while the scale changes. */
export function zoomAt(view: SchView, anchor: SchPoint, nextScale: number, width: number, height: number): SchView {
  const scale = clampScale(nextScale);
  const dx = anchor.x - width / 2, dy = anchor.y - height / 2;
  return { scale, x: view.x + dx / view.scale - dx / scale, y: view.y + dy / view.scale - dy / scale };
}

export const panBy = (view: SchView, dxPx: number, dyPx: number): SchView =>
  ({ scale: view.scale, x: view.x - dxPx / view.scale, y: view.y - dyPx / view.scale });

/** Never lets the sheet leave the viewport entirely: at least `keepPx` of the extent stays visible. */
export function clampView(view: SchView, extent: SchBounds, width: number, height: number, keepPx = 96): SchView {
  const hw = width / (2 * view.scale), hh = height / (2 * view.scale);
  const kx = Math.min(keepPx / view.scale, hw), ky = Math.min(keepPx / view.scale, hh);
  return {
    scale: view.scale,
    x: clamp(view.x, extent.minX - hw + kx, extent.maxX + hw - kx),
    y: clamp(view.y, extent.minY - hh + ky, extent.maxY + hh - ky),
  };
}

export const viewToCamera = (view: SchView, fit: FitMode): ViewerCamera => ({ zoom: view.scale / BASE_SCALE, x: view.x, y: view.y, fit });

/** Restores a persisted camera; anything incomplete or non-finite degrades to a page fit instead of a broken view. */
export function cameraToView(camera: ViewerCamera, extent: SchBounds, width: number, height: number): { view: SchView; fit: FitMode } {
  if (camera.fit === 'page' || camera.fit === 'width') return { view: fitView(extent, width, height, camera.fit), fit: camera.fit };
  const { zoom, x, y } = camera;
  if (typeof zoom === 'number' && typeof x === 'number' && typeof y === 'number' && Number.isFinite(zoom) && Number.isFinite(x) && Number.isFinite(y) && zoom > 0) {
    return { view: clampView({ x, y, scale: clampScale(zoom * BASE_SCALE) }, extent, width, height), fit: 'none' };
  }
  return { view: fitView(extent, width, height, 'page'), fit: 'page' };
}

/** Equality with a sub-pixel tolerance, so a shell that rounds the stored camera does not cause a feedback loop. */
export function sameCamera(a: ViewerCamera | null | undefined, b: ViewerCamera | null | undefined): boolean {
  if (!a || !b) return a === b;
  if ((a.fit ?? 'none') !== (b.fit ?? 'none')) return false;
  if (a.zoom === undefined || b.zoom === undefined || a.x === undefined || b.x === undefined || a.y === undefined || b.y === undefined) {
    return a.zoom === b.zoom && a.x === b.x && a.y === b.y;
  }
  const scale = Math.max(a.zoom, 1e-6) * BASE_SCALE;
  return Math.abs(a.zoom - b.zoom) <= 1e-3 * Math.max(a.zoom, b.zoom) && Math.abs(a.x - b.x) <= 0.5 / scale && Math.abs(a.y - b.y) <= 0.5 / scale;
}

// ---------------------------------------------------------------------------------------------------------------
// Bounds and text layout
// ---------------------------------------------------------------------------------------------------------------

const emptyBounds = (): SchBounds => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
const isValid = (b: SchBounds) => b.minX <= b.maxX && b.minY <= b.maxY && Number.isFinite(b.minX + b.minY + b.maxX + b.maxY);
function grow(b: SchBounds, x: number, y: number) {
  if (x < b.minX) b.minX = x;
  if (x > b.maxX) b.maxX = x;
  if (y < b.minY) b.minY = y;
  if (y > b.maxY) b.maxY = y;
}
const growBounds = (b: SchBounds, o: SchBounds) => { grow(b, o.minX, o.minY); grow(b, o.maxX, o.maxY); };
export const pointsBounds = (points: readonly SchPoint[]): SchBounds => {
  const b = emptyBounds();
  for (const p of points) grow(b, p.x, p.y);
  return b;
};

export type TextAnchor = 'start' | 'middle' | 'end';
export const MONO_ADVANCE = 0.6;
export const textWidth = (text: string, size: number) => text.length * size * MONO_ADVANCE;
/** Glyph box half-height as a fraction of the text size (centred on the middle baseline). */
const TEXT_HALF_HEIGHT = 0.6;

/** Keeps text readable: angles in (90, 270] flip by 180 degrees and mirror the anchor so the text covers the same area. */
export function normalizeTextOrientation(angle: number, anchor: TextAnchor): { angle: number; anchor: TextAnchor } {
  let a = ((Number.isFinite(angle) ? angle : 0) % 360 + 360) % 360;
  let next = anchor;
  if (a > 90 && a <= 270) { a -= 180; next = anchor === 'start' ? 'end' : anchor === 'end' ? 'start' : anchor; }
  if (a > 180) a -= 360;
  return { angle: a, anchor: next };
}

export interface TextPlacement { at: SchPoint; angle: number; anchor: TextAnchor; dy: number }

/** Four corners of a text box placed at `at`; `dy` shifts the box along the glyph "down" axis (negative = above). */
export function textCorners(at: SchPoint, angle: number, anchor: TextAnchor, width: number, size: number, dy = 0): SchPoint[] {
  const rad = angle * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
  const x0 = anchor === 'start' ? 0 : anchor === 'middle' ? -width / 2 : -width;
  const y0 = dy - size * TEXT_HALF_HEIGHT, y1 = dy + size * TEXT_HALF_HEIGHT;
  const at2 = (x: number, y: number): SchPoint => ({ x: at.x + x * c + y * s, y: at.y - x * s + y * c });
  return [at2(x0, y0), at2(x0 + width, y0), at2(x0 + width, y1), at2(x0, y1)];
}

export const LABEL_SIZE = 1.27;
export const PIN_TEXT_SIZE = 1.0;

export interface LabelLayout {
  /** Flag outline of global / hierarchical labels; null for local labels (plain text). */
  polygon: SchPoint[] | null;
  text: TextPlacement;
  size: number;
  bounds: SchBounds;
}

export function layoutLabel(label: SchLabel, size = LABEL_SIZE): LabelLayout {
  const a = (Number.isFinite(label.angle) ? label.angle : 0) * Math.PI / 180;
  const dir = { x: Math.cos(a), y: -Math.sin(a) }, side = { x: Math.sin(a), y: Math.cos(a) };
  const tw = textWidth(label.text, size);
  const frame = (x: number, y: number): SchPoint => ({ x: label.at.x + dir.x * x + side.x * y, y: label.at.y + dir.y * x + side.y * y });
  if (label.kind === 'local') {
    const start = frame(0.3, 0);
    const o = normalizeTextOrientation(label.angle, 'start');
    const text: TextPlacement = { at: start, angle: o.angle, anchor: o.anchor, dy: -size * 0.7 };
    return { polygon: null, text, size, bounds: pointsBounds(textCorners(text.at, text.angle, text.anchor, tw, size, text.dy)) };
  }
  const shape = label.shape ?? 'passive';
  const tipAnchor = shape === 'input' || shape === 'bidirectional' || shape === 'tri_state';
  const tipFar = shape === 'output' || shape === 'bidirectional' || shape === 'tri_state';
  const h = size * 1.8, pad = size * 0.4, tip = h / 2;
  const length = (tipAnchor ? tip : 0) + pad + tw + pad + (tipFar ? tip : 0);
  const pts: Array<[number, number]> = [];
  if (tipAnchor) pts.push([0, 0], [tip, -tip]); else pts.push([0, -tip]);
  if (tipFar) pts.push([length - tip, -tip], [length, 0], [length - tip, tip]); else pts.push([length, -tip], [length, tip]);
  pts.push(tipAnchor ? [tip, tip] : [0, tip]);
  const polygon = pts.map(([x, y]) => frame(x, y));
  const o = normalizeTextOrientation(label.angle, 'start');
  const text: TextPlacement = { at: frame((tipAnchor ? tip : 0) + pad, 0), angle: o.angle, anchor: o.anchor, dy: 0 };
  return { polygon, text, size, bounds: pointsBounds(polygon) };
}

export interface PinTextLayout { number: TextPlacement; name: TextPlacement | null }
/** Pin number above / beside the pin line, pin name inside the body, both snapped to the nearest axis. */
export function layoutPinText(pin: SchPin): PinTextLayout {
  let ux = pin.body.x - pin.at.x, uy = pin.body.y - pin.at.y;
  const len = Math.hypot(ux, uy);
  if (len < 1e-9) { ux = 1; uy = 0; } else { ux /= len; uy /= len; }
  const horizontal = Math.abs(ux) >= Math.abs(uy);
  const sx = horizontal ? Math.sign(ux) || 1 : 0, sy = horizontal ? 0 : Math.sign(uy) || 1;
  const mid = { x: (pin.at.x + pin.body.x) / 2, y: (pin.at.y + pin.body.y) / 2 };
  const gap = 0.7;
  const number: TextPlacement = horizontal
    ? { at: mid, angle: 0, anchor: 'middle', dy: -gap }
    : { at: mid, angle: 90, anchor: 'middle', dy: -gap };
  let name: TextPlacement | null = null;
  if (pin.name && pin.name !== '~') {
    const at = { x: pin.body.x + sx * 0.6, y: pin.body.y + sy * 0.6 };
    // Reading direction: 0 deg = +x, 90 deg = -y. The name extends along the pin direction.
    name = horizontal
      ? { at, angle: 0, anchor: sx > 0 ? 'start' : 'end', dy: 0 }
      : { at, angle: 90, anchor: sy < 0 ? 'start' : 'end', dy: 0 };
  }
  return { number, name };
}

// ---------------------------------------------------------------------------------------------------------------
// Sheet data: element table, real symbol geometry and the culling grid
// ---------------------------------------------------------------------------------------------------------------

export const K = { symbol: 0, wire: 1, bus: 2, busEntry: 3, junction: 4, noConnect: 5, label: 6, sheet: 7, graphic: 8 } as const;
const KIND_COUNT = 9;
export const DEFAULT_LINE = 0.254;
const PIN_LINE = 0.152;
const WIRE_LINE = 0.152;

export interface PaperFrame { paper: SchBounds; inner: SchBounds; title: SchBounds }
const FRAME_MARGIN = 10;
export function paperFrame(def: Pick<SchSheetDef, 'paper'>): PaperFrame | null {
  const paper = def.paper;
  if (!paper || !(paper.width > 0) || !(paper.height > 0) || !Number.isFinite(paper.width + paper.height)) return null;
  const m = Math.min(FRAME_MARGIN, paper.width / 8, paper.height / 8);
  const inner = { minX: m, minY: m, maxX: paper.width - m, maxY: paper.height - m };
  const tw = Math.min(110, (inner.maxX - inner.minX) * 0.6), th = Math.min(32, (inner.maxY - inner.minY) * 0.3);
  return { paper: { minX: 0, minY: 0, maxX: paper.width, maxY: paper.height }, inner, title: { minX: inner.maxX - tw, minY: inner.maxY - th, maxX: inner.maxX, maxY: inner.maxY } };
}

interface Grid { minX: number; minY: number; cw: number; ch: number; cols: number; rows: number; start: Int32Array; items: Int32Array; big: Int32Array }
const MAX_CELLS_PER_ITEM = 64;

function buildGrid(boxes: Float64Array, count: number, extent: SchBounds): Grid {
  const cols = clamp(Math.round(Math.sqrt(count / 3)), 1, 512), rows = cols;
  const cw = Math.max(1e-6, (extent.maxX - extent.minX) / cols), ch = Math.max(1e-6, (extent.maxY - extent.minY) / rows);
  const range = (i: number) => {
    const x0 = clamp(Math.floor((boxes[i * 4] - extent.minX) / cw), 0, cols - 1), x1 = clamp(Math.floor((boxes[i * 4 + 2] - extent.minX) / cw), 0, cols - 1);
    const y0 = clamp(Math.floor((boxes[i * 4 + 1] - extent.minY) / ch), 0, rows - 1), y1 = clamp(Math.floor((boxes[i * 4 + 3] - extent.minY) / ch), 0, rows - 1);
    return [x0, y0, x1, y1] as const;
  };
  const start = new Int32Array(cols * rows + 1);
  const big: number[] = [];
  const finite = (i: number) => Number.isFinite(boxes[i * 4] + boxes[i * 4 + 1] + boxes[i * 4 + 2] + boxes[i * 4 + 3]);
  for (let i = 0; i < count; i++) {
    if (!finite(i)) continue;
    const [x0, y0, x1, y1] = range(i);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_ITEM) { big.push(i); continue; }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) start[y * cols + x + 1]++;
  }
  for (let c = 0; c < cols * rows; c++) start[c + 1] += start[c];
  const items = new Int32Array(start[cols * rows]);
  const fill = start.slice(0, cols * rows);
  for (let i = 0; i < count; i++) {
    if (!finite(i)) continue;
    const [x0, y0, x1, y1] = range(i);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_ITEM) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) items[fill[y * cols + x]++] = i;
  }
  return { minX: extent.minX, minY: extent.minY, cw, ch, cols, rows, start, items, big: Int32Array.from(big) };
}

export interface SheetData {
  def: SchSheetDef;
  /** Everything that can appear on the sheet (content and paper): the extent a camera may roam over and fit to. */
  extent: SchBounds;
  frame: PaperFrame | null;
  count: number;
  boxes: Float64Array;
  kind: Uint8Array;
  /** First element id of each kind (element id = offsets[kind] + index into the def's array of that kind). */
  offsets: number[];
  /** Real geometry bounds of each symbol: body graphics, else pins, else the parser's box. 4 numbers per symbol. */
  hit: Float64Array;
  labels: LabelLayout[];
  symbolById: Map<string, number>;
  wireById: Map<string, number>;
  grid: Grid;
  stamp: Uint32Array;
  epoch: number;
}

function graphicBounds(g: SchGraphic): SchBounds | null {
  const b = emptyBounds();
  const half = Math.max(g.kind === 'text' ? 0 : g.width, DEFAULT_LINE) / 2;
  switch (g.kind) {
    case 'poly': for (const p of g.points) grow(b, p.x, p.y); break;
    case 'rect': grow(b, g.min.x, g.min.y); grow(b, g.max.x, g.max.y); break;
    case 'circle': grow(b, g.center.x - g.radius, g.center.y - g.radius); grow(b, g.center.x + g.radius, g.center.y + g.radius); break;
    case 'text': {
      if (g.hidden || !g.text) return null;
      const o = normalizeTextOrientation(g.angle, g.anchor);
      for (const p of textCorners(g.at, o.angle, o.anchor, textWidth(g.text, g.size), g.size)) grow(b, p.x, p.y);
      return isValid(b) ? b : null;
    }
  }
  if (!isValid(b)) return null;
  return { minX: b.minX - half, minY: b.minY - half, maxX: b.maxX + half, maxY: b.maxY + half };
}

/** Culling bounds (everything drawn for the symbol) and hit bounds (the real body, for click selection). */
export function symbolGeometry(sym: SchSymbol): { draw: SchBounds; hit: SchBounds } {
  const draw = emptyBounds(), body = emptyBounds(), pins = emptyBounds();
  for (const g of sym.graphics) {
    const b = graphicBounds(g);
    if (!b) continue;
    growBounds(draw, b);
    if (g.kind !== 'text') growBounds(body, b);
  }
  for (const pin of sym.pins) {
    grow(pins, pin.body.x, pin.body.y); grow(pins, pin.at.x, pin.at.y);
    if (!pin.hidden) { grow(draw, pin.at.x, pin.at.y); grow(draw, pin.body.x, pin.body.y); }
  }
  for (const field of sym.fields) {
    if (field.hidden || !field.at || !field.value) continue;
    const o = normalizeTextOrientation(field.angle ?? 0, 'start');
    for (const p of textCorners(field.at, o.angle, o.anchor, textWidth(field.value, LABEL_SIZE), LABEL_SIZE)) grow(draw, p.x, p.y);
  }
  let hit = isValid(body) ? body : isValid(pins) ? pins : { ...sym.bounds };
  if (!isValid(hit)) hit = { minX: sym.at.x, minY: sym.at.y, maxX: sym.at.x, maxY: sym.at.y };
  if (!isValid(draw)) growBounds(draw, hit);
  return { draw, hit };
}

export function buildSheetData(def: SchSheetDef): SheetData {
  const counts = [def.symbols.length, def.wires.length, def.buses.length, def.busEntries.length, def.junctions.length, def.noConnects.length, def.labels.length, def.sheetRefs.length, def.graphics.length];
  const offsets: number[] = [];
  let count = 0;
  for (const c of counts) { offsets.push(count); count += c; }
  const boxes = new Float64Array(count * 4).fill(NaN);
  const kind = new Uint8Array(count);
  for (let k = 0; k < KIND_COUNT; k++) kind.fill(k, offsets[k], offsets[k] + counts[k]);
  const set = (id: number, b: SchBounds | null) => {
    if (!b || !isValid(b)) return;
    boxes[id * 4] = b.minX; boxes[id * 4 + 1] = b.minY; boxes[id * 4 + 2] = b.maxX; boxes[id * 4 + 3] = b.maxY;
  };
  const segment = (a: SchPoint, b: SchPoint, pad: number): SchBounds => ({
    minX: Math.min(a.x, b.x) - pad, minY: Math.min(a.y, b.y) - pad, maxX: Math.max(a.x, b.x) + pad, maxY: Math.max(a.y, b.y) + pad,
  });
  const hit = new Float64Array(def.symbols.length * 4);
  const symbolById = new Map<string, number>(), wireById = new Map<string, number>();
  def.symbols.forEach((sym, i) => {
    const g = symbolGeometry(sym);
    set(offsets[K.symbol] + i, g.draw);
    hit[i * 4] = g.hit.minX; hit[i * 4 + 1] = g.hit.minY; hit[i * 4 + 2] = g.hit.maxX; hit[i * 4 + 3] = g.hit.maxY;
    symbolById.set(sym.id, i);
  });
  def.wires.forEach((w, i) => { set(offsets[K.wire] + i, segment(w.a, w.b, 0.2)); wireById.set(w.id, i); });
  def.buses.forEach((w, i) => set(offsets[K.bus] + i, segment(w.a, w.b, 0.4)));
  def.busEntries.forEach((w, i) => set(offsets[K.busEntry] + i, segment(w.at, w.to, 0.2)));
  def.junctions.forEach((j, i) => set(offsets[K.junction] + i, { minX: j.at.x - 0.6, minY: j.at.y - 0.6, maxX: j.at.x + 0.6, maxY: j.at.y + 0.6 }));
  def.noConnects.forEach((n, i) => set(offsets[K.noConnect] + i, { minX: n.at.x - 0.7, minY: n.at.y - 0.7, maxX: n.at.x + 0.7, maxY: n.at.y + 0.7 }));
  const labels = def.labels.map(label => layoutLabel(label));
  labels.forEach((layout, i) => set(offsets[K.label] + i, layout.bounds));
  def.sheetRefs.forEach((ref, i) => {
    const b = emptyBounds();
    grow(b, ref.at.x, ref.at.y); grow(b, ref.at.x + ref.size.x, ref.at.y + ref.size.y);
    for (const p of ref.pins) grow(b, p.at.x, p.at.y);
    // Name above, file name below (drawn 1.2 mm and 2.4 mm outside the rectangle).
    const w = Math.max(textWidth(ref.name, LABEL_SIZE), textWidth(`File: ${ref.file}`, 1));
    grow(b, ref.at.x + w, ref.at.y - 2.4); grow(b, ref.at.x, ref.at.y + ref.size.y + 2.4);
    set(offsets[K.sheet] + i, b);
  });
  def.graphics.forEach((g, i) => set(offsets[K.graphic] + i, graphicBounds(g)));

  const content = emptyBounds();
  for (let i = 0; i < count; i++) if (boxes[i * 4] <= boxes[i * 4 + 2]) { grow(content, boxes[i * 4], boxes[i * 4 + 1]); grow(content, boxes[i * 4 + 2], boxes[i * 4 + 3]); }
  const hasArea = (b: SchBounds) => isValid(b) && (b.maxX > b.minX || b.maxY > b.minY);
  if (!isValid(content) && hasArea(def.bounds)) growBounds(content, def.bounds);
  const frame = paperFrame(def);
  const extent = isValid(content) ? { ...content } : emptyBounds();
  if (frame) growBounds(extent, frame.paper);
  if (!hasArea(extent)) { extent.minX = 0; extent.minY = 0; extent.maxX = 100; extent.maxY = 100; }
  return { def, extent, frame, count, boxes, kind, offsets, hit, labels, symbolById, wireById, grid: buildGrid(boxes, count, extent), stamp: new Uint32Array(count), epoch: 0 };
}

/** Appends the ids of every element whose bounds intersect the rectangle to `out` (cleared first). */
export function queryData(data: SheetData, minX: number, minY: number, maxX: number, maxY: number, out: number[]): number[] {
  out.length = 0;
  const { grid, boxes, stamp } = data;
  if (++data.epoch > 0xfffffff0) { stamp.fill(0); data.epoch = 1; }
  const epoch = data.epoch;
  const test = (id: number) => {
    if (stamp[id] === epoch) return;
    stamp[id] = epoch;
    const o = id * 4;
    if (boxes[o] <= maxX && boxes[o + 2] >= minX && boxes[o + 1] <= maxY && boxes[o + 3] >= minY) out.push(id);
  };
  for (let i = 0; i < grid.big.length; i++) test(grid.big[i]);
  const x0 = Math.floor((minX - grid.minX) / grid.cw), x1 = Math.floor((maxX - grid.minX) / grid.cw);
  const y0 = Math.floor((minY - grid.minY) / grid.ch), y1 = Math.floor((maxY - grid.minY) / grid.ch);
  if (x1 < 0 || y1 < 0 || x0 >= grid.cols || y0 >= grid.rows) return out;
  const cx0 = Math.max(0, x0), cx1 = Math.min(grid.cols - 1, x1), cy0 = Math.max(0, y0), cy1 = Math.min(grid.rows - 1, y1);
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      const cell = y * grid.cols + x;
      for (let i = grid.start[cell], end = grid.start[cell + 1]; i < end; i++) test(grid.items[i]);
    }
  }
  return out;
}

/** Bounded cache of per-definition render data (index, real bounds, label layouts): least recently used goes first. */
export class SheetCache {
  private readonly map = new Map<SchSheetDef, SheetData>();
  constructor(readonly limit = 6) {}
  get(def: SchSheetDef): SheetData {
    let data = this.map.get(def);
    if (data) this.map.delete(def); else data = buildSheetData(def);
    this.map.set(def, data);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as SchSheetDef);
    return data;
  }
  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}

// ---------------------------------------------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------------------------------------------

export type SchHit =
  | { kind: 'pin'; symbol: number; pin: number }
  | { kind: 'symbol'; symbol: number }
  | { kind: 'sheetPin'; ref: number; pin: number }
  | { kind: 'wire'; wire: number }
  | { kind: 'label'; label: number }
  | { kind: 'bus'; bus: number }
  | { kind: 'sheet'; ref: number };

export function segmentDistance(p: SchPoint, a: SchPoint, b: SchPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 0 = a dot, 1 = a box, 2 = full detail (graphics, pins and text), by the projected size of the symbol body. */
export const symbolDetail = (maxExtentMm: number, scale: number): 0 | 1 | 2 => {
  const px = maxExtentMm * scale;
  return px < 2.5 ? 0 : px < 7 ? 1 : 2;
};
/** Pins are drawn (and therefore selectable) once the symbol is at least this many px wide. */
export const PIN_TEXT_SCALE = 5.5;
export const FIELD_TEXT_SCALE = 3.6;

export interface HitOptions { pinTolPx?: number; wireTolPx?: number; symbolTolPx?: number }

export function hitTest(data: SheetData, point: SchPoint, scale: number, options: HitOptions = {}): SchHit | null {
  const pinTol = (options.pinTolPx ?? 6) / scale, wireTol = (options.wireTolPx ?? 5) / scale, symbolTol = (options.symbolTolPx ?? 2.5) / scale;
  const reach = Math.max(pinTol, wireTol, symbolTol);
  const ids = queryData(data, point.x - reach, point.y - reach, point.x + reach, point.y + reach, []);
  const def = data.def;
  let pin: SchHit | null = null, pinDist = Infinity;
  let symbol: SchHit | null = null, symbolArea = Infinity;
  let sheetPin: SchHit | null = null, sheetPinDist = Infinity;
  let wire: SchHit | null = null, wireDist = Infinity;
  let bus: SchHit | null = null, busDist = Infinity;
  let label: SchHit | null = null;
  let sheet: SchHit | null = null;
  for (const id of ids) {
    const k = data.kind[id], i = id - data.offsets[k];
    if (k === K.symbol) {
      const o = i * 4, h = data.hit;
      const w = h[o + 2] - h[o], ht = h[o + 3] - h[o + 1];
      if (point.x >= h[o] - symbolTol && point.x <= h[o + 2] + symbolTol && point.y >= h[o + 1] - symbolTol && point.y <= h[o + 3] + symbolTol) {
        const area = Math.max(w, 0.05) * Math.max(ht, 0.05);
        if (area < symbolArea) { symbolArea = area; symbol = { kind: 'symbol', symbol: i }; }
      }
      if (symbolDetail(Math.max(w, ht), scale) === 2) {
        const pins = def.symbols[i].pins;
        for (let p = 0; p < pins.length; p++) {
          if (pins[p].hidden) continue;
          const d = segmentDistance(point, pins[p].at, pins[p].body);
          if (d <= pinTol && d < pinDist) { pinDist = d; pin = { kind: 'pin', symbol: i, pin: p }; }
        }
      }
    } else if (k === K.wire) {
      const w = def.wires[i], d = segmentDistance(point, w.a, w.b);
      if (d <= wireTol && d < wireDist) { wireDist = d; wire = { kind: 'wire', wire: i }; }
    } else if (k === K.bus) {
      const b = def.buses[i], d = segmentDistance(point, b.a, b.b);
      if (d <= wireTol && d < busDist) { busDist = d; bus = { kind: 'bus', bus: i }; }
    } else if (k === K.label) {
      const b = data.labels[i].bounds, pad = 1 / scale;
      if (!label && point.x >= b.minX - pad && point.x <= b.maxX + pad && point.y >= b.minY - pad && point.y <= b.maxY + pad) label = { kind: 'label', label: i };
    } else if (k === K.sheet) {
      const ref = def.sheetRefs[i];
      for (let p = 0; p < ref.pins.length; p++) {
        const d = Math.hypot(point.x - ref.pins[p].at.x, point.y - ref.pins[p].at.y);
        if (d <= pinTol && d < sheetPinDist) { sheetPinDist = d; sheetPin = { kind: 'sheetPin', ref: i, pin: p }; }
      }
      if (point.x >= ref.at.x && point.x <= ref.at.x + ref.size.x && point.y >= ref.at.y && point.y <= ref.at.y + ref.size.y) sheet = { kind: 'sheet', ref: i };
    }
  }
  return pin ?? symbol ?? sheetPin ?? wire ?? label ?? bus ?? sheet;
}

// ---------------------------------------------------------------------------------------------------------------
// Selection, nets and hierarchy helpers
// ---------------------------------------------------------------------------------------------------------------

const KEY_SEPARATOR = '\u0000';
/** Splits a `symbolKey` / `pinKey` / `wireKey` of model.ts into its components (instance path first). */
export const parseKey = (key: string | undefined): string[] => (key ? key.split(KEY_SEPARATOR) : []);

export interface ResolvedSelection { symbol: number; pin: { symbol: number; pin: number } | null }
/** Maps the controlled selection onto the displayed instance; keys of other instances resolve to nothing. */
export function resolveSelection(data: SheetData, instancePath: string, selection: { symbolKey?: string; pinKey?: string }): ResolvedSelection {
  const out: ResolvedSelection = { symbol: -1, pin: null };
  const s = parseKey(selection.symbolKey);
  if (s.length === 2 && s[0] === instancePath) out.symbol = data.symbolById.get(s[1]) ?? -1;
  const p = parseKey(selection.pinKey);
  if (p.length === 3 && p[0] === instancePath) {
    const symbol = data.symbolById.get(p[1]);
    if (symbol !== undefined) {
      const pin = data.def.symbols[symbol].pins.findIndex(item => item.id === p[2]);
      if (pin >= 0) { out.pin = { symbol, pin }; if (out.symbol < 0) out.symbol = symbol; }
    }
  }
  return out;
}

const netIndexes = new WeakMap<SchConnectivity, Map<string, SchNet>>();
export function netIndex(connectivity: SchConnectivity): Map<string, SchNet> {
  let index = netIndexes.get(connectivity);
  if (!index) { index = new Map(connectivity.nets.map(net => [net.id, net])); netIndexes.set(connectivity, index); }
  return index;
}

export interface NetHighlight {
  netId: string;
  name: string;
  wires: number[];
  wireSet: Set<number>;
  pinsBySymbol: Map<number, number[]>;
  labels: Set<number>;
  junctions: Set<number>;
  noConnects: Set<number>;
  sheetPins: Set<string>;
}

const POINT_EPS = 0.05;
const pointKey = (p: SchPoint) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;

/**
 * Wires, pins and sheet pins come from the connectivity result. Labels, junctions and no-connect marks carry no net
 * id in the model, so they belong to the net when they sit on one of its wires or pins (or a label repeats a net name).
 */
export function buildNetHighlight(data: SheetData, instancePath: string, connectivity: SchConnectivity, netId: string | undefined): NetHighlight | null {
  if (!netId) return null;
  const net = netIndex(connectivity).get(netId);
  if (!net) return null;
  const def = data.def;
  const wires: number[] = [], wireSet = new Set<number>();
  for (const w of net.wires) {
    if (w.instancePath !== instancePath) continue;
    const i = data.wireById.get(w.wireId);
    if (i !== undefined && !wireSet.has(i)) { wireSet.add(i); wires.push(i); }
  }
  const pinsBySymbol = new Map<number, number[]>();
  const pinPoints = new Set<string>();
  for (const m of net.members) {
    if (m.instancePath !== instancePath) continue;
    const s = data.symbolById.get(m.symbolId);
    if (s === undefined) continue;
    const p = def.symbols[s].pins.findIndex(item => item.id === m.pinId);
    if (p < 0) continue;
    let list = pinsBySymbol.get(s);
    if (!list) { list = []; pinsBySymbol.set(s, list); }
    list.push(p);
    pinPoints.add(pointKey(def.symbols[s].pins[p].at));
  }
  const scratch: number[] = [];
  const onNet = (p: SchPoint): boolean => {
    if (pinPoints.has(pointKey(p))) return true;
    for (const id of queryData(data, p.x - POINT_EPS, p.y - POINT_EPS, p.x + POINT_EPS, p.y + POINT_EPS, scratch)) {
      if (data.kind[id] !== K.wire) continue;
      const i = id - data.offsets[K.wire];
      if (wireSet.has(i) && segmentDistance(p, def.wires[i].a, def.wires[i].b) <= POINT_EPS) return true;
    }
    return false;
  };
  const names = new Set(net.aliases); names.add(net.name);
  const labels = new Set<number>();
  const sameName = (label: SchLabel) => names.has(label.text)
    && (label.kind === 'global' ? net.scope === 'global' : label.kind === 'local' && net.scope === 'local' && net.scopePath === instancePath);
  def.labels.forEach((label, i) => { if (onNet(label.at) || sameName(label)) labels.add(i); });
  const junctions = new Set<number>(), noConnects = new Set<number>(), sheetPins = new Set<string>();
  def.junctions.forEach((j, i) => { if (onNet(j.at)) junctions.add(i); });
  def.noConnects.forEach((n, i) => { if (onNet(n.at)) noConnects.add(i); });
  def.sheetRefs.forEach((ref, r) => ref.pins.forEach((pin, p) => { if (onNet(pin.at)) sheetPins.add(`${r}:${p}`); }));
  return { netId, name: net.name, wires, wireSet, pinsBySymbol, labels, junctions, noConnects, sheetPins };
}

/** Instance a sheet symbol leads to: the (parentPath, sheetRefId) entry of the hierarchy, else the joined path if it exists. */
export function resolveChildPath(schematic: Pick<Schematic, 'instances'>, parentPath: string, sheetRefId: string): string | null {
  for (const instance of schematic.instances) if (instance.parentPath === parentPath && instance.sheetRefId === sheetRefId) return instance.path;
  const joined = parentPath ? `${parentPath}/${sheetRefId}` : sheetRefId;
  return schematic.instances.some(instance => instance.path === joined) ? joined : null;
}

export interface NavRow { instance: SchSheetInstance; index: number; hasChildren: boolean; collapsed: boolean }
/** Rows of the sheet tree in preorder; the descendants of collapsed instances are skipped. */
export function buildNavRows(instances: readonly SchSheetInstance[], collapsed: ReadonlySet<string>): NavRow[] {
  const rows: NavRow[] = [];
  let skipBelow = Infinity;
  instances.forEach((instance, index) => {
    if (instance.depth > skipBelow) return;
    skipBelow = Infinity;
    const hasChildren = instance.childPaths.length > 0;
    const isCollapsed = hasChildren && collapsed.has(instance.path);
    rows.push({ instance, index, hasChildren, collapsed: isCollapsed });
    if (isCollapsed) skipBelow = instance.depth;
  });
  return rows;
}

/** Ancestors from the root down to (and including) `path`; stops safely on cycles or missing parents. */
export function instanceChain(instances: readonly SchSheetInstance[], path: string): SchSheetInstance[] {
  const byPath = new Map(instances.map(instance => [instance.path, instance]));
  const chain: SchSheetInstance[] = [];
  let current = byPath.get(path);
  for (let guard = 0; current && guard < 128; guard++) {
    chain.unshift(current);
    current = current.parentPath === null ? undefined : byPath.get(current.parentPath);
  }
  return chain;
}

// ---- drawing --------------------------------------------------------------------------------------------------

export interface SchTokens { bg: string; panel: string; text: string; muted: string; subtle: string; line: string; accent: string; net: string; danger: string }
export const FALLBACK_TOKENS: Record<'dark' | 'light', SchTokens> = {
  dark: { bg: '#0d131b', panel: '#141d28', text: '#e8eff5', muted: '#96a8b9', subtle: '#63778c', line: '#283748', accent: '#efb751', net: '#56d4cf', danger: '#f58d83' },
  light: { bg: '#f1f3ef', panel: '#fcfcf8', text: '#1b2b32', muted: '#586b73', subtle: '#7c8c92', line: '#d4ddd7', accent: '#96620d', net: '#007d81', danger: '#b44336' },
};

export interface SchPalette {
  bg: string; sheet: string; sheetLine: string; frame: string; text: string; muted: string; subtle: string;
  accent: string; accentFill: string; net: string; netGlow: string; danger: string;
  wire: string; bus: string; bodyLine: string; bodyFill: string; pin: string; pinText: string;
  local: string; global: string; hier: string; sheetSymbol: string; sheetFill: string; free: string; hover: string; halo: string;
}

/** `#rgb` / `#rrggbb` to rgba(); other CSS colours fall back to color-mix. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (!m) return `color-mix(in srgb, ${c} ${Math.round(alpha * 100)}%, transparent)`;
  const h = m[1].length === 3 ? m[1].split('').map(ch => ch + ch).join('') : m[1];
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${alpha})`;
}

export function buildPalette(t: SchTokens, theme: 'dark' | 'light'): SchPalette {
  const dark = theme === 'dark';
  const sheetSymbol = dark ? '#b996ea' : '#7a46b3';
  return {
    bg: t.bg, sheet: t.panel, sheetLine: t.line, frame: dark ? '#3a4d62' : '#a9b8b2', text: t.text, muted: t.muted, subtle: t.subtle,
    accent: t.accent, accentFill: withAlpha(t.accent, 0.16), net: t.net, netGlow: withAlpha(t.net, 0.28), danger: t.danger,
    wire: dark ? '#4fb283' : '#2f8a5b', bus: dark ? '#6c9be8' : '#2f62b8',
    bodyLine: dark ? '#c3d0de' : '#46586a', bodyFill: dark ? '#1b2735' : '#f3eed9',
    pin: dark ? '#8fa2b6' : '#6f8290', pinText: dark ? '#8fa2b6' : '#667a88',
    local: dark ? '#8bd9ae' : '#237a4e', global: dark ? '#f2907b' : '#b4442d', hier: dark ? '#d4a4f2' : '#8a3fb5',
    sheetSymbol, sheetFill: withAlpha(sheetSymbol, dark ? 0.1 : 0.07), free: dark ? '#7f93a8' : '#7c8c92',
    hover: dark ? '#e8eff5' : '#1b2b32', halo: t.panel,
  };
}

export interface RenderStats { symbols: number; wires: number; labels: number; texts: number; elements: number; ms: number }

export interface SheetScene {
  data: SheetData;
  instancePath: string;
  view: SchView;
  width: number;
  height: number;
  dpr: number;
  palette: SchPalette;
  /** Annotated reference of every symbol on this instance (parallel to def.symbols). */
  refs: readonly string[];
  /** Whether each sheet symbol's definition is available (parallel to def.sheetRefs). */
  sheetResolved: readonly boolean[];
  netHighlight: NetHighlight | null;
  page: string;
}

type PathLike = Pick<Path2D, 'moveTo' | 'lineTo' | 'rect' | 'arc' | 'closePath'>;
const TAU = Math.PI * 2;
const FONT = "'IBM Plex Mono', Consolas, 'DejaVu Sans Mono', monospace";
const MIN_TEXT_PX = 4.5;

function appendGraphic(path: PathLike, g: SchGraphic) {
  if (g.kind === 'poly') {
    if (!g.points.length) return;
    path.moveTo(g.points[0].x, g.points[0].y);
    for (let i = 1; i < g.points.length; i++) path.lineTo(g.points[i].x, g.points[i].y);
    if (g.filled && g.points.length > 2) path.closePath();
  } else if (g.kind === 'rect') {
    path.rect(Math.min(g.min.x, g.max.x), Math.min(g.min.y, g.max.y), Math.abs(g.max.x - g.min.x), Math.abs(g.max.y - g.min.y));
  } else if (g.kind === 'circle') {
    path.moveTo(g.center.x + g.radius, g.center.y);
    path.arc(g.center.x, g.center.y, g.radius, 0, TAU);
  }
}

const lineWidth = (mm: number, minPx: number, scale: number) => Math.max(mm, minPx / scale);

/** Per-frame bookkeeping that is reused between frames so a redraw does not allocate arrays. */
interface Scratch { ids: number[]; symbols: number[]; detailed: number[]; sheets: number[]; labels: number[]; texts: number[] }
const scratch: Scratch = { ids: [], symbols: [], detailed: [], sheets: [], labels: [], texts: [] };

class TextPen {
  private font = '';
  constructor(private readonly ctx: CanvasRenderingContext2D, private readonly scene: SheetScene) {}
  /** Draws sheet-space text in screen space (crisp glyphs). `size` is in mm. Returns false when it is too small to read. */
  draw(text: string, p: TextPlacement, size: number, color: string, opts: { bold?: boolean; italic?: boolean; halo?: boolean; minPx?: number } = {}): boolean {
    const { view, width, height, dpr } = this.scene;
    const px = size * view.scale;
    if (px < (opts.minPx ?? MIN_TEXT_PX) || !text) return false;
    const sx = width / 2 + (p.at.x - view.x) * view.scale, sy = height / 2 + (p.at.y - view.y) * view.scale;
    if (sx < -400 || sy < -400 || sx > width + 400 || sy > height + 400) return false;
    const rad = p.angle * Math.PI / 180, c = Math.cos(rad) * dpr, s = Math.sin(rad) * dpr;
    const ctx = this.ctx;
    ctx.setTransform(c, -s, s, c, sx * dpr, sy * dpr);
    const font = `${opts.italic ? 'italic ' : ''}${opts.bold ? '600' : '500'} ${Math.round(px * 10) / 10}px ${FONT}`;
    if (font !== this.font) { ctx.font = font; this.font = font; }
    ctx.textAlign = p.anchor === 'middle' ? 'center' : p.anchor === 'end' ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    const y = p.dy * view.scale;
    if (opts.halo) { ctx.lineWidth = Math.max(2, px * 0.28); ctx.strokeStyle = this.scene.palette.halo; ctx.strokeText(text, 0, y); }
    ctx.fillStyle = color;
    ctx.fillText(text, 0, y);
    return true;
  }
}

function setWorld(ctx: CanvasRenderingContext2D, scene: SheetScene) {
  const { view, width, height, dpr } = scene;
  const k = view.scale * dpr;
  ctx.setTransform(k, 0, 0, k, (width / 2 - view.x * view.scale) * dpr, (height / 2 - view.y * view.scale) * dpr);
}

function drawPaper(ctx: CanvasRenderingContext2D, scene: SheetScene, pen: TextPen) {
  const frame = scene.data.frame;
  if (!frame) return;
  const { palette: pal, view } = scene;
  const px = 1 / view.scale;
  ctx.fillStyle = pal.sheet;
  ctx.fillRect(frame.paper.minX, frame.paper.minY, frame.paper.maxX - frame.paper.minX, frame.paper.maxY - frame.paper.minY);
  ctx.lineWidth = px * 1.2; ctx.strokeStyle = pal.sheetLine;
  ctx.strokeRect(frame.paper.minX, frame.paper.minY, frame.paper.maxX - frame.paper.minX, frame.paper.maxY - frame.paper.minY);
  ctx.strokeStyle = pal.frame; ctx.lineWidth = Math.max(0.25, px);
  const i = frame.inner, t = frame.title;
  ctx.strokeRect(i.minX, i.minY, i.maxX - i.minX, i.maxY - i.minY);
  ctx.strokeRect(t.minX, t.minY, t.maxX - t.minX, t.maxY - t.minY);
  const rowH = (t.maxY - t.minY) / 4;
  ctx.beginPath();
  for (let r = 1; r < 4; r++) { ctx.moveTo(t.minX, t.minY + rowH * r); ctx.lineTo(t.maxX, t.minY + rowH * r); }
  ctx.stroke();
  // Title block text (screen space; skipped when it would be unreadable).
  const def = scene.data.def, block = def.titleBlock;
  const pick = (...keys: string[]) => { for (const k of keys) { const v = block[k] ?? block[k.toLowerCase()]; if (v) return v; } return ''; };
  const rows: Array<[string, string, number]> = [
    ['Title', def.title || pick('title', 'Title') || def.name, 2],
    ['Company', pick('company', 'Company'), 1.4],
    ['Rev / Date', [pick('rev', 'Rev'), pick('date', 'Date')].filter(Boolean).join('   '), 1.4],
    ['File / Sheet', `${def.file || def.name}${scene.page ? `   page ${scene.page}` : ''}`, 1.4],
  ];
  const w = t.maxX - t.minX;
  rows.forEach(([label, value, size], r) => {
    const y = t.minY + rowH * r + rowH / 2;
    pen.draw(label, { at: { x: t.minX + 1, y: y - rowH * 0.28 }, angle: 0, anchor: 'start', dy: 0 }, 0.9, pal.subtle, { minPx: 5 });
    const max = Math.max(4, Math.floor((w - 3) / (size * MONO_ADVANCE)));
    const shown = value.length > max ? `${value.slice(0, max - 1)}…` : value;
    pen.draw(shown, { at: { x: t.minX + 1.5, y: y + rowH * 0.12 }, angle: 0, anchor: 'start', dy: 0 }, size, pal.text, { minPx: 5, bold: r === 0 });
  });
}

function drawSymbolText(pen: TextPen, scene: SheetScene, index: number) {
  const { palette: pal, view } = scene;
  const sym = scene.data.def.symbols[index];
  if (view.scale >= FIELD_TEXT_SCALE) {
    for (const f of sym.fields) {
      if (f.hidden || !f.at) continue;
      const value = f.name === 'Reference' ? scene.refs[index] : f.value;
      if (!value) continue;
      const o = normalizeTextOrientation(f.angle ?? 0, 'start');
      const color = f.name === 'Reference' ? pal.text : f.name === 'Value' ? pal.muted : pal.subtle;
      pen.draw(value, { at: f.at, angle: o.angle, anchor: o.anchor, dy: 0 }, LABEL_SIZE, color, { bold: f.name === 'Reference' });
    }
    for (const g of sym.graphics) {
      if (g.kind !== 'text' || g.hidden || !g.text) continue;
      const o = normalizeTextOrientation(g.angle, g.anchor);
      pen.draw(g.text, { at: g.at, angle: o.angle, anchor: o.anchor, dy: 0 }, g.size, pal.muted, { bold: g.bold, italic: g.italic });
    }
  }
  if (view.scale >= PIN_TEXT_SCALE) {
    for (const pin of sym.pins) {
      if (pin.hidden) continue;
      const layout = layoutPinText(pin);
      pen.draw(pin.number, layout.number, PIN_TEXT_SIZE, pal.pinText);
      if (layout.name) pen.draw(pin.name, layout.name, PIN_TEXT_SIZE, pal.muted);
    }
  }
}

/** Draws the whole sheet (base layer). Pointer-rate state never reaches this function: it is called from a rAF. */
export function drawSheet(ctx: CanvasRenderingContext2D, scene: SheetScene): RenderStats {
  const t0 = performance.now();
  const { data, view, width, height, dpr, palette: pal, netHighlight: net } = scene;
  const def = data.def, scale = view.scale;
  const px = 1 / scale;
  const pen = new TextPen(ctx, scene);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, width, height);
  setWorld(ctx, scene);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  const vb = viewBounds(view, width, height, 8);
  const ids = queryData(data, vb.minX, vb.minY, vb.maxX, vb.maxY, scratch.ids);
  const symbols = scratch.symbols, detailedSymbols = scratch.detailed, sheets = scratch.sheets, labels = scratch.labels, texts = scratch.texts;
  symbols.length = 0; detailedSymbols.length = 0; sheets.length = 0; labels.length = 0; texts.length = 0;
  const wires = new Path2D(), buses = new Path2D(), entries = new Path2D(), freeStrokes = new Map<number, Path2D>(), junctions = new Path2D(), crosses = new Path2D();
  let wireCount = 0, junctionCount = 0;
  const dimmed = !!net;
  const junctionRadius = Math.max(0.42, 2.2 * px);
  const cross = Math.max(0.6, 3.5 * px);
  for (const id of ids) {
    const k = data.kind[id], i = id - data.offsets[k];
    switch (k) {
      case K.symbol: symbols.push(i); break;
      case K.wire: {
        if (net?.wireSet.has(i)) break;
        const w = def.wires[i]; wires.moveTo(w.a.x, w.a.y); wires.lineTo(w.b.x, w.b.y); wireCount++; break;
      }
      case K.bus: { const b = def.buses[i]; buses.moveTo(b.a.x, b.a.y); buses.lineTo(b.b.x, b.b.y); break; }
      case K.busEntry: { const e = def.busEntries[i]; entries.moveTo(e.at.x, e.at.y); entries.lineTo(e.to.x, e.to.y); break; }
      case K.junction: {
        if (net?.junctions.has(i)) break;
        const j = def.junctions[i].at; junctions.moveTo(j.x + junctionRadius, j.y); junctions.arc(j.x, j.y, junctionRadius, 0, TAU); junctionCount++; break;
      }
      case K.noConnect: {
        const n = def.noConnects[i].at;
        crosses.moveTo(n.x - cross, n.y - cross); crosses.lineTo(n.x + cross, n.y + cross); crosses.moveTo(n.x - cross, n.y + cross); crosses.lineTo(n.x + cross, n.y - cross); break;
      }
      case K.label: labels.push(i); break;
      case K.sheet: sheets.push(i); break;
      case K.graphic: {
        const g = def.graphics[i];
        if (g.kind === 'text') { texts.push(i); break; }
        const key = Math.round(lineWidth(g.width > 0 ? g.width : DEFAULT_LINE, 1, scale) * 1000);
        let path = freeStrokes.get(key); if (!path) freeStrokes.set(key, path = new Path2D());
        appendGraphic(path, g);
        break;
      }
    }
  }

  drawPaper(ctx, scene, pen);
  setWorld(ctx, scene);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  ctx.strokeStyle = pal.free;
  for (const [key, path] of freeStrokes) { ctx.lineWidth = key / 1000; ctx.stroke(path); }
  const faded = dimmed ? 0.5 : 1;
  ctx.globalAlpha = faded;
  ctx.strokeStyle = pal.bus; ctx.lineWidth = lineWidth(0.6, 2, scale); ctx.stroke(buses);
  ctx.lineWidth = lineWidth(DEFAULT_LINE, 1.2, scale); ctx.stroke(entries);
  ctx.strokeStyle = pal.wire; ctx.lineWidth = lineWidth(WIRE_LINE, 1.3, scale); ctx.stroke(wires);
  ctx.globalAlpha = 1;

  // Sheet symbols (below the symbols, above the wires).
  const hPins = new Path2D(), hBoxes = new Path2D();
  const flagSize = LABEL_SIZE * 1.6;
  ctx.setLineDash([]);
  for (const r of sheets) {
    const ref = def.sheetRefs[r], resolved = scene.sheetResolved[r];
    ctx.fillStyle = pal.sheetFill; ctx.fillRect(ref.at.x, ref.at.y, ref.size.x, ref.size.y);
    ctx.strokeStyle = pal.sheetSymbol; ctx.lineWidth = lineWidth(0.3, 1.4, scale);
    if (!resolved) ctx.setLineDash([2.2, 1.4]);
    ctx.strokeRect(ref.at.x, ref.at.y, ref.size.x, ref.size.y);
    ctx.setLineDash([]);
    for (const p of ref.pins) {
      const left = Math.abs(p.at.x - ref.at.x), right = Math.abs(p.at.x - (ref.at.x + ref.size.x));
      const top = Math.abs(p.at.y - ref.at.y), bottom = Math.abs(p.at.y - (ref.at.y + ref.size.y));
      const m = Math.min(left, right, top, bottom);
      const inward = m === left ? { x: 1, y: 0 } : m === right ? { x: -1, y: 0 } : m === top ? { x: 0, y: 1 } : { x: 0, y: -1 };
      const half = flagSize / 2;
      const q = { x: -inward.y, y: inward.x };
      const at = (a: number, b: number) => ({ x: p.at.x + inward.x * a + q.x * b, y: p.at.y + inward.y * a + q.y * b });
      const pts = p.shape === 'input' ? [at(0, 0), at(half, -half), at(half * 2, -half), at(half * 2, half), at(half, half)]
        : p.shape === 'output' ? [at(0, -half), at(half, -half), at(half * 2, 0), at(half, half), at(0, half)]
          : p.shape === 'passive' ? [at(0, -half), at(half * 2, -half), at(half * 2, half), at(0, half)]
            : [at(0, 0), at(half, -half), at(half * 2, 0), at(half, half)];
      hPins.moveTo(pts[0].x, pts[0].y);
      for (let n = 1; n < pts.length; n++) hPins.lineTo(pts[n].x, pts[n].y);
      hPins.closePath();
    }
  }
  ctx.strokeStyle = pal.sheetSymbol; ctx.lineWidth = lineWidth(0.2, 1, scale); ctx.stroke(hPins);

  // Symbols: batched per style so thousands of parts cost a handful of draw calls.
  const fillBody = new Path2D(), fillOutline = new Path2D(), pinsPath = new Path2D(), dnp = new Path2D();
  const strokes = new Map<number, Path2D>();
  const dots = new Path2D();
  for (const i of symbols) {
    const sym = def.symbols[i];
    const h = data.hit, o = i * 4;
    const level = symbolDetail(Math.max(h[o + 2] - h[o], h[o + 3] - h[o + 1]), scale);
    if (level === 0) {
      const cx = (h[o] + h[o + 2]) / 2, cy = (h[o + 1] + h[o + 3]) / 2, d = 1.4 * px;
      dots.rect(cx - d, cy - d, d * 2, d * 2); continue;
    }
    if (level === 1) {
      fillBody.rect(h[o], h[o + 1], h[o + 2] - h[o], h[o + 3] - h[o + 1]);
      let box = strokes.get(-1); if (!box) strokes.set(-1, box = new Path2D());
      box.rect(h[o], h[o + 1], h[o + 2] - h[o], h[o + 3] - h[o + 1]); continue;
    }
    detailedSymbols.push(i);
    for (const g of sym.graphics) {
      if (g.kind === 'text') continue;
      const key = Math.round(lineWidth(g.width > 0 ? g.width : DEFAULT_LINE, 1, scale) * 1000);
      let path = strokes.get(key); if (!path) strokes.set(key, path = new Path2D());
      appendGraphic(path, g);
      const fill = g.kind === 'poly' ? (g.filled ? 'outline' : 'none') : g.fill;
      if (fill === 'background') appendGraphic(fillBody, g); else if (fill === 'outline') appendGraphic(fillOutline, g);
    }
    for (const pin of sym.pins) {
      if (pin.hidden) continue;
      pinsPath.moveTo(pin.at.x, pin.at.y); pinsPath.lineTo(pin.body.x, pin.body.y);
    }
    if (sym.dnp) {
      dnp.moveTo(h[o], h[o + 1]); dnp.lineTo(h[o + 2], h[o + 3]); dnp.moveTo(h[o], h[o + 3]); dnp.lineTo(h[o + 2], h[o + 1]);
    }
  }
  ctx.fillStyle = pal.bodyFill; ctx.fill(fillBody);
  ctx.strokeStyle = pal.bodyLine;
  for (const [key, path] of strokes) { ctx.lineWidth = key < 0 ? 1 : key / 1000; ctx.stroke(path); }
  ctx.fillStyle = pal.bodyLine; ctx.fill(fillOutline); ctx.fill(dots);
  ctx.strokeStyle = pal.pin; ctx.lineWidth = lineWidth(PIN_LINE, 1.1, scale); ctx.stroke(pinsPath);
  if (detailedSymbols.length) { ctx.strokeStyle = withAlpha(pal.danger, 0.8); ctx.lineWidth = lineWidth(0.3, 1.2, scale); ctx.stroke(dnp); }

  ctx.globalAlpha = faded;
  ctx.fillStyle = pal.wire; ctx.fill(junctions);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = pal.danger; ctx.lineWidth = lineWidth(0.25, 1.4, scale); ctx.stroke(crosses);

  // Flag outlines of global / hierarchical labels.
  if (labels.length) {
    const globalFlags = new Path2D(), hierFlags = new Path2D();
    for (const i of labels) {
      const poly = data.labels[i].polygon;
      if (!poly || net?.labels.has(i)) continue;
      const target = def.labels[i].kind === 'global' ? globalFlags : hierFlags;
      target.moveTo(poly[0].x, poly[0].y);
      for (let n = 1; n < poly.length; n++) target.lineTo(poly[n].x, poly[n].y);
      target.closePath();
    }
    ctx.globalAlpha = faded;
    ctx.lineWidth = lineWidth(0.2, 1.2, scale);
    ctx.strokeStyle = pal.global; ctx.stroke(globalFlags);
    ctx.strokeStyle = pal.hier; ctx.stroke(hierFlags);
    ctx.globalAlpha = 1;
  }

  // Highlighted net: glow underlay, then the net colour on top of everything electrical.
  let netWires = 0;
  if (net) {
    const netPath = new Path2D(), netPins = new Path2D(), netDots = new Path2D(), netFlags = new Path2D(), netJunctions = new Path2D();
    for (const i of net.wires) {
      const o = (data.offsets[K.wire] + i) * 4;
      if (data.boxes[o] > vb.maxX || data.boxes[o + 2] < vb.minX || data.boxes[o + 1] > vb.maxY || data.boxes[o + 3] < vb.minY) continue;
      const w = def.wires[i]; netPath.moveTo(w.a.x, w.a.y); netPath.lineTo(w.b.x, w.b.y); netWires++;
    }
    const dot = Math.max(0.5, 3 * px);
    for (const [s, pins] of net.pinsBySymbol) {
      const o = (data.offsets[K.symbol] + s) * 4;
      if (data.boxes[o] > vb.maxX || data.boxes[o + 2] < vb.minX || data.boxes[o + 1] > vb.maxY || data.boxes[o + 3] < vb.minY) continue;
      for (const p of pins) {
        const pin = def.symbols[s].pins[p];
        if (pin.hidden) continue;
        netPins.moveTo(pin.at.x, pin.at.y); netPins.lineTo(pin.body.x, pin.body.y);
        netDots.moveTo(pin.at.x + dot, pin.at.y); netDots.arc(pin.at.x, pin.at.y, dot, 0, TAU);
      }
    }
    for (const i of net.junctions) { const j = def.junctions[i].at; netJunctions.moveTo(j.x + junctionRadius * 1.2, j.y); netJunctions.arc(j.x, j.y, junctionRadius * 1.2, 0, TAU); }
    for (const i of net.labels) {
      const poly = data.labels[i].polygon;
      if (!poly) continue;
      netFlags.moveTo(poly[0].x, poly[0].y);
      for (let n = 1; n < poly.length; n++) netFlags.lineTo(poly[n].x, poly[n].y);
      netFlags.closePath();
    }
    ctx.strokeStyle = pal.netGlow; ctx.lineWidth = lineWidth(0.9, 6, scale); ctx.stroke(netPath); ctx.stroke(netPins);
    ctx.strokeStyle = pal.net; ctx.lineWidth = lineWidth(0.4, 2.2, scale); ctx.stroke(netPath); ctx.stroke(netPins); ctx.stroke(netFlags);
    ctx.fillStyle = pal.net; ctx.fill(netDots); ctx.fill(netJunctions);
  }

  // Text pass (screen space).
  let textCount = 0;
  for (const i of detailedSymbols) { drawSymbolText(pen, scene, i); textCount++; }
  for (const i of labels) {
    const label = def.labels[i], layout = data.labels[i];
    const onNet = !!net?.labels.has(i);
    ctx.globalAlpha = dimmed && !onNet ? 0.6 : 1;
    const color = onNet ? pal.net : label.kind === 'global' ? pal.global : label.kind === 'hierarchical' ? pal.hier : pal.local;
    if (pen.draw(label.text, layout.text, layout.size, color, { bold: true, halo: label.kind === 'local' })) textCount++;
  }
  ctx.globalAlpha = 1;
  for (const r of sheets) {
    const ref = def.sheetRefs[r], resolved = scene.sheetResolved[r];
    pen.draw(ref.name, { at: { x: ref.at.x, y: ref.at.y - 1.2 }, angle: 0, anchor: 'start', dy: 0 }, LABEL_SIZE, pal.sheetSymbol, { bold: true });
    pen.draw(`File: ${ref.file}`, { at: { x: ref.at.x, y: ref.at.y + ref.size.y + 1.4 }, angle: 0, anchor: 'start', dy: 0 }, 1, pal.muted);
    if (!resolved) pen.draw('file missing', { at: { x: ref.at.x + ref.size.x / 2, y: ref.at.y + ref.size.y / 2 }, angle: 0, anchor: 'middle', dy: 0 }, LABEL_SIZE, pal.danger, { bold: true, minPx: 4 });
    for (const p of ref.pins) {
      const inward = Math.abs(p.at.x - ref.at.x) < 1e-6 ? 0 : Math.abs(p.at.x - (ref.at.x + ref.size.x)) < 1e-6 ? 180 : Math.abs(p.at.y - ref.at.y) < 1e-6 ? 270 : 90;
      const o = normalizeTextOrientation(inward, 'start');
      const rad = inward * Math.PI / 180;
      const at = { x: p.at.x + Math.cos(rad) * (flagSize + 0.6), y: p.at.y - Math.sin(rad) * (flagSize + 0.6) };
      pen.draw(p.name, { at, angle: o.angle, anchor: o.anchor, dy: 0 }, 1.1, pal.sheetSymbol);
    }
  }
  for (const i of texts) {
    const g = def.graphics[i];
    if (g.kind !== 'text' || g.hidden) continue;
    const o = normalizeTextOrientation(g.angle, g.anchor);
    if (pen.draw(g.text, { at: g.at, angle: o.angle, anchor: o.anchor, dy: 0 }, g.size, pal.muted, { bold: g.bold, italic: g.italic })) textCount++;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { symbols: symbols.length, wires: wireCount + netWires, labels: labels.length, texts: textCount, elements: ids.length + junctionCount, ms: performance.now() - t0 };
}

export interface OverlayScene {
  data: SheetData;
  instancePath: string;
  view: SchView;
  width: number;
  height: number;
  dpr: number;
  palette: SchPalette;
  selection: ResolvedSelection;
  hover: SchHit | null;
  focusedSheet: number;
  highlights: ReadonlyArray<{ kind: 'search' | 'probe' | 'selection'; rect: { x: number; y: number; width: number; height: number }; label?: string; active?: boolean }>;
}

function strokeSymbol(ctx: CanvasRenderingContext2D, sym: SchSymbol) {
  const path = new Path2D();
  for (const g of sym.graphics) appendGraphic(path, g);
  for (const pin of sym.pins) if (!pin.hidden) { path.moveTo(pin.at.x, pin.at.y); path.lineTo(pin.body.x, pin.body.y); }
  ctx.stroke(path);
}

/** Selection, hover, highlights and keyboard focus: cheap, redrawn alone when only the pointer moves. */
export function drawOverlay(ctx: CanvasRenderingContext2D, scene: OverlayScene) {
  const { data, view, width, height, dpr, palette: pal } = scene;
  const def = data.def, px = 1 / view.scale;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const k = view.scale * dpr;
  ctx.setTransform(k, 0, 0, k, (width / 2 - view.x * view.scale) * dpr, (height / 2 - view.y * view.scale) * dpr);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const vb = viewBounds(view, width, height, 8);

  for (const h of scene.highlights) {
    const r = h.rect;
    if (r.x > vb.maxX || r.x + r.width < vb.minX || r.y > vb.maxY || r.y + r.height < vb.minY) continue;
    const minSide = 10 * px;
    const w = Math.max(r.width, minSide), ht = Math.max(r.height, minSide);
    const x = r.x - (w - r.width) / 2, y = r.y - (ht - r.height) / 2;
    const color = h.kind === 'search' ? pal.accent : pal.net;
    ctx.fillStyle = withAlpha(color, h.active ? 0.3 : 0.16);
    ctx.fillRect(x, y, w, ht);
    ctx.strokeStyle = color; ctx.lineWidth = (h.active || h.kind === 'selection' ? 2.2 : 1.4) * px;
    ctx.setLineDash(h.kind === 'probe' ? [4 * px, 3 * px] : []);
    ctx.strokeRect(x, y, w, ht);
    ctx.setLineDash([]);
  }

  const sel = scene.selection;
  if (sel.symbol >= 0) {
    const sym = def.symbols[sel.symbol], o = sel.symbol * 4, hb = data.hit;
    const pad = 1.2;
    ctx.fillStyle = pal.accentFill;
    ctx.fillRect(hb[o] - pad, hb[o + 1] - pad, hb[o + 2] - hb[o] + pad * 2, hb[o + 3] - hb[o + 1] + pad * 2);
    ctx.strokeStyle = pal.accent; ctx.lineWidth = lineWidth(0.3, 2, view.scale);
    strokeSymbol(ctx, sym);
    ctx.lineWidth = 1.2 * px; ctx.setLineDash([4 * px, 3 * px]);
    ctx.strokeRect(hb[o] - pad, hb[o + 1] - pad, hb[o + 2] - hb[o] + pad * 2, hb[o + 3] - hb[o + 1] + pad * 2);
    ctx.setLineDash([]);
  }
  if (sel.pin) {
    const pin = def.symbols[sel.pin.symbol].pins[sel.pin.pin];
    ctx.strokeStyle = pal.net; ctx.lineWidth = lineWidth(0.4, 2.4, view.scale);
    ctx.beginPath(); ctx.moveTo(pin.at.x, pin.at.y); ctx.lineTo(pin.body.x, pin.body.y); ctx.stroke();
    const r = Math.max(0.9, 6 * px);
    ctx.fillStyle = withAlpha(pal.net, 0.25);
    ctx.beginPath(); ctx.arc(pin.at.x, pin.at.y, r, 0, TAU); ctx.fill();
    ctx.lineWidth = 1.8 * px; ctx.stroke();
  }

  const hv = scene.hover;
  if (hv) {
    ctx.strokeStyle = withAlpha(pal.hover, 0.85); ctx.fillStyle = withAlpha(pal.hover, 0.1);
    ctx.lineWidth = 1.5 * px;
    if (hv.kind === 'pin') {
      const pin = def.symbols[hv.symbol].pins[hv.pin];
      ctx.beginPath(); ctx.arc(pin.at.x, pin.at.y, Math.max(0.8, 5 * px), 0, TAU); ctx.fill(); ctx.stroke();
    } else if (hv.kind === 'symbol') {
      const o = hv.symbol * 4, hb = data.hit, pad = 0.6;
      ctx.setLineDash([3 * px, 3 * px]);
      ctx.strokeRect(hb[o] - pad, hb[o + 1] - pad, hb[o + 2] - hb[o] + pad * 2, hb[o + 3] - hb[o + 1] + pad * 2);
      ctx.setLineDash([]);
    } else if (hv.kind === 'wire' || hv.kind === 'bus') {
      const w = hv.kind === 'wire' ? def.wires[hv.wire] : def.buses[hv.bus];
      ctx.lineWidth = lineWidth(0.6, 3, view.scale); ctx.strokeStyle = withAlpha(pal.hover, 0.35);
      ctx.beginPath(); ctx.moveTo(w.a.x, w.a.y); ctx.lineTo(w.b.x, w.b.y); ctx.stroke();
    } else if (hv.kind === 'label') {
      const b = data.labels[hv.label].bounds;
      ctx.strokeRect(b.minX - 0.3, b.minY - 0.3, b.maxX - b.minX + 0.6, b.maxY - b.minY + 0.6);
    } else if (hv.kind === 'sheetPin') {
      const p = def.sheetRefs[hv.ref].pins[hv.pin].at;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.8, 5 * px), 0, TAU); ctx.fill(); ctx.stroke();
    } else if (hv.kind === 'sheet') {
      const ref = def.sheetRefs[hv.ref];
      ctx.strokeRect(ref.at.x - 0.6, ref.at.y - 0.6, ref.size.x + 1.2, ref.size.y + 1.2);
    }
  }

  if (scene.focusedSheet >= 0 && scene.focusedSheet < def.sheetRefs.length) {
    const ref = def.sheetRefs[scene.focusedSheet];
    ctx.strokeStyle = pal.accent; ctx.lineWidth = 2 * px; ctx.setLineDash([5 * px, 3 * px]);
    ctx.strokeRect(ref.at.x - 1.2, ref.at.y - 1.2, ref.size.x + 2.4, ref.size.y + 2.4);
    ctx.setLineDash([]);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
