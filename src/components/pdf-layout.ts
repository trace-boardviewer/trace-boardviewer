/**
 * Pure geometry, virtualization and scheduling helpers of the PDF viewer (no DOM, no React: node-testable).
 *
 * Conventions: document space is the PDF page box in points at scale 1, origin top-left of the UNROTATED page,
 * Y down (src/lib/pdf/document.ts). A page is displayed rotated clockwise by `rotation` = page /Rotate + user
 * rotation. "Display units" are CSS pixels at zoom 1 (1 point = 1 CSS px).
 */
import type { DocRect, ViewerRotation } from './viewer-contracts';

export interface Size { width: number; height: number }
export interface Point { x: number; y: number }
/** A page box as reported by `PdfHandle.getPageSize`: unrotated points plus the page's own /Rotate. */
export interface PageBox extends Size { rotation: number }

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const ZOOM_STEPS: readonly number[] = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 3, 4, 6, 8];

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const clampZoom = (zoom: number) => (Number.isFinite(zoom) ? clamp(zoom, MIN_ZOOM, MAX_ZOOM) : 1);

/** Next entry of ZOOM_STEPS strictly above (direction 1) or below (-1) the current zoom. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const epsilon = 0.004;
  if (direction > 0) return ZOOM_STEPS.find(step => step > zoom + epsilon) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < zoom - epsilon) return ZOOM_STEPS[i];
  return MIN_ZOOM;
}

/** "150", "150%", " 1,5 % " -> 1.5 (percent input). Null for anything that is not a positive finite number. */
export function parseZoomInput(text: string): number | null {
  const cleaned = text.trim().replace(/%/g, '').replace(',', '.').trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const percent = Number(cleaned);
  return percent > 0 && Number.isFinite(percent) ? clampZoom(percent / 100) : null;
}
export const formatZoom = (zoom: number) => `${Math.round(zoom * 100)}%`;

export function normalizeRotation(degrees: number): ViewerRotation {
  const turns = ((Math.round(degrees / 90) % 4) + 4) % 4;
  return (turns * 90) as ViewerRotation;
}
export const displayRotation = (pageRotation: number, userRotation: number): ViewerRotation => normalizeRotation(pageRotation + userRotation);

/** Displayed size of a page box at zoom 1 once rotated by page /Rotate + user rotation. */
export function displaySize(box: PageBox, userRotation: number): Size {
  const turned = displayRotation(box.rotation, userRotation) % 180 !== 0;
  return turned ? { width: box.height, height: box.width } : { width: box.width, height: box.height };
}

/** Maps a point of the unrotated page (W x H) to the page displayed rotated clockwise by `rotation`, at zoom 1. */
export function rotatePoint(x: number, y: number, width: number, height: number, rotation: ViewerRotation): Point {
  switch (rotation) {
    case 90: return { x: height - y, y: x };
    case 180: return { x: width - x, y: height - y };
    case 270: return { x: y, y: width - x };
    default: return { x, y };
  }
}
/** Inverse of `rotatePoint`: a displayed point (zoom 1) back to document space. */
export function unrotatePoint(x: number, y: number, width: number, height: number, rotation: ViewerRotation): Point {
  switch (rotation) {
    case 90: return { x: y, y: height - x };
    case 180: return { x: width - x, y: height - y };
    case 270: return { x: width - y, y: x };
    default: return { x, y };
  }
}
export function rotateRect(rect: DocRect, width: number, height: number, rotation: ViewerRotation): DocRect {
  const a = rotatePoint(rect.x, rect.y, width, height, rotation);
  const b = rotatePoint(rect.x + rect.width, rect.y + rect.height, width, height, rotation);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}
/** CSS matrix(a, b, c, d, e, f) that maps document points of an unrotated W x H box straight to displayed pixels at `zoom`. */
export function pageMatrix(width: number, height: number, rotation: ViewerRotation, zoom: number): [number, number, number, number, number, number] {
  const z = zoom;
  switch (rotation) {
    case 90: return [0, z, -z, 0, height * z, 0];
    case 180: return [-z, 0, 0, -z, width * z, height * z];
    case 270: return [0, -z, z, 0, 0, width * z];
    default: return [z, 0, 0, z, 0, 0];
  }
}

export interface PageLayout {
  /** Top offset of every page in content pixels (index 0 = page 1). */
  tops: Float64Array;
  widths: Float64Array;
  heights: Float64Array;
  total: number;
  contentWidth: number;
  count: number;
}
export interface LayoutOptions { zoom: number; gap: number; padding: number; viewportWidth: number }

/** Vertical stack of pages (continuous scroll). `sizes[i]` = displayed size of page i + 1 at zoom 1. Pages are centred horizontally. */
export function computeLayout(sizes: ArrayLike<Size>, options: LayoutOptions): PageLayout {
  const count = sizes.length;
  const tops = new Float64Array(count), widths = new Float64Array(count), heights = new Float64Array(count);
  let y = options.padding, widest = 0;
  for (let i = 0; i < count; i++) {
    const width = sizes[i].width * options.zoom, height = sizes[i].height * options.zoom;
    tops[i] = y; widths[i] = width; heights[i] = height;
    y += height + options.gap;
    if (width > widest) widest = width;
  }
  const total = count ? y - options.gap + options.padding : 2 * options.padding;
  return { tops, widths, heights, total, contentWidth: Math.max(options.viewportWidth, widest + 2 * options.padding), count };
}
export const pageLeft = (layout: PageLayout, index: number) => (layout.contentWidth - layout.widths[index]) / 2;

/** Index (0-based) of the last page whose top is at or above `y`; 0 for y above the first page. */
export function pageIndexAt(layout: PageLayout, y: number): number {
  let low = 0, high = layout.count - 1;
  if (high < 0 || y <= layout.tops[0]) return 0;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (layout.tops[mid] <= y) low = mid; else high = mid - 1;
  }
  return low;
}
export interface IndexRange { first: number; last: number }
/** Pages (0-based, inclusive) intersecting the viewport; empty documents yield first > last. */
export function visibleRange(layout: PageLayout, scrollTop: number, viewportHeight: number): IndexRange {
  if (layout.count === 0) return { first: 0, last: -1 };
  let first = pageIndexAt(layout, scrollTop);
  if (layout.tops[first] + layout.heights[first] <= scrollTop && first < layout.count - 1) first++;
  const bottom = scrollTop + viewportHeight;
  let last = pageIndexAt(layout, bottom);
  if (layout.tops[last] >= bottom && last > first) last--;
  return { first, last: Math.max(first, last) };
}
export function expandRange(range: IndexRange, by: number, count: number): IndexRange {
  if (count === 0 || range.last < range.first) return { first: 0, last: -1 };
  return { first: Math.max(0, range.first - by), last: Math.min(count - 1, range.last + by) };
}
export const sameRange = (a: IndexRange, b: IndexRange) => a.first === b.first && a.last === b.last;

/**
 * The page "being read": the one under a reference line 40% down the viewport. At the very bottom of the
 * scroll range it is the last page, which could otherwise never reach the line.
 */
export function currentPageIndex(layout: PageLayout, scrollTop: number, viewportHeight: number): number {
  if (layout.count === 0) return 0;
  if (scrollTop > 0 && scrollTop + viewportHeight >= layout.total - 1) return layout.count - 1;
  return pageIndexAt(layout, scrollTop + viewportHeight * 0.4);
}

/** A scroll position remembered as "this fraction of this page is at this viewport offset": survives re-layout (zoom, rotation, size discovery). */
export interface ScrollAnchor { index: number; fx: number; fy: number; ax: number; ay: number }
export function captureAnchor(layout: PageLayout, scrollTop: number, scrollLeft: number, ax: number, ay: number): ScrollAnchor | null {
  if (layout.count === 0) return null;
  const y = scrollTop + ay;
  const index = pageIndexAt(layout, y);
  const height = layout.heights[index] || 1, width = layout.widths[index] || 1;
  return { index, ax, ay, fy: (y - layout.tops[index]) / height, fx: (scrollLeft + ax - pageLeft(layout, index)) / width };
}
export function resolveAnchor(layout: PageLayout, anchor: ScrollAnchor): { top: number; left: number } | null {
  if (anchor.index >= layout.count) return null;
  return {
    top: layout.tops[anchor.index] + anchor.fy * layout.heights[anchor.index] - anchor.ay,
    left: pageLeft(layout, anchor.index) + anchor.fx * layout.widths[anchor.index] - anchor.ax,
  };
}

/** Zoom that fits the page box into the viewport (width: only the width; page: the whole page). */
export function fitZoom(mode: 'width' | 'page', viewport: Size, page: Size, padding: number): number {
  if (viewport.width <= 0 || viewport.height <= 0 || page.width <= 0 || page.height <= 0) return 1;
  const byWidth = (viewport.width - 2 * padding) / page.width;
  const byHeight = (viewport.height - 2 * padding) / page.height;
  return clampZoom(mode === 'width' ? byWidth : Math.min(byWidth, byHeight));
}

/**
 * Raster scale for a page: zoom x devicePixelRatio, reduced so one canvas never exceeds `maxPixels` or `maxSide`
 * (the canvas is then stretched by CSS: softer, but bounded memory). Quantized so equal zooms share cache keys.
 */
export function planRenderScale(page: Size, zoom: number, dpr: number, maxPixels = 16_000_000, maxSide = 16_384): { scale: number; clamped: boolean } {
  const wanted = Math.max(0.05, zoom * Math.max(1, dpr));
  const area = page.width * page.height || 1;
  const cap = Math.min(Math.sqrt(maxPixels / area), maxSide / Math.max(page.width, page.height, 1));
  const clamped = wanted > cap;
  const scale = Math.min(wanted, cap);
  return { scale: Math.max(0.05, Math.floor(scale * 100) / 100), clamped };
}

/** Pages to keep rendered: visible pages, plus `neighbours` on each side while the whole window stays inside a pixel budget. */
export function renderWindow(visible: IndexRange, count: number, pixelsOfPage: (index: number) => number, neighbours: number, budgetPixels: number): IndexRange {
  if (count === 0 || visible.last < visible.first) return { first: 0, last: -1 };
  let pixels = 0;
  for (let i = visible.first; i <= visible.last; i++) pixels += pixelsOfPage(i);
  const range = { first: visible.first, last: visible.last };
  for (let step = 0; step < neighbours; step++) {
    const before = range.first > 0 ? pixelsOfPage(range.first - 1) : 0, after = range.last < count - 1 ? pixelsOfPage(range.last + 1) : 0;
    if (before && pixels + before <= budgetPixels) { range.first--; pixels += before; }
    if (after && pixels + after <= budgetPixels) { range.last++; pixels += after; }
  }
  return range;
}

export function groupByPage<T extends { page?: number }>(items: readonly T[] | undefined, max = Infinity): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const item of items ?? []) {
    if (item.page === undefined || !Number.isInteger(item.page)) continue;
    const list = groups.get(item.page);
    if (!list) groups.set(item.page, [item]);
    else if (list.length < max) list.push(item);
  }
  return groups;
}

export const wrapIndex = (index: number, delta: number, count: number) => (count <= 0 ? -1 : (((index + delta) % count) + count) % count);
/** First hit on or after `page` (hits come in page order); wraps to the first hit when none follows. */
export function nearestHitIndex(hits: readonly { page: number }[], page: number): number {
  if (!hits.length) return -1;
  const found = hits.findIndex(hit => hit.page >= page);
  return found === -1 ? 0 : found;
}

/** True when `rect` (content pixels) lies fully inside the viewport shrunk by `margin`. */
export function isRectVisible(rect: { left: number; top: number; width: number; height: number }, scrollLeft: number, scrollTop: number, viewport: Size, margin: number): boolean {
  return rect.left >= scrollLeft + margin && rect.top >= scrollTop + margin
    && rect.left + rect.width <= scrollLeft + viewport.width - margin && rect.top + rect.height <= scrollTop + viewport.height - margin;
}

/**
 * Bounded map with LRU eviction; `take` removes without disposing (ownership moves to the caller).
 * A closed cache disposes whatever is put into it, so late arrivals during teardown cannot leak.
 */
export class BoundedCache<K, V> {
  readonly #map = new Map<K, V>();
  #closed = false;
  constructor(readonly capacity: number, private readonly dispose?: (value: V, key: K) => void) {}
  get size() { return this.#map.size; }
  has(key: K) { return this.#map.has(key); }
  take(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) this.#map.delete(key);
    return value;
  }
  open(): void { this.#closed = false; }
  close(): void { this.#closed = true; this.clear(); }
  put(key: K, value: V): void {
    if (this.#closed) { this.dispose?.(value, key); return; }
    const previous = this.#map.get(key);
    if (previous !== undefined && previous !== value) this.dispose?.(previous, key);
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.capacity) {
      const oldest = this.#map.entries().next();
      if (oldest.done) break;
      this.#map.delete(oldest.value[0]);
      this.dispose?.(oldest.value[1], oldest.value[0]);
    }
  }
  clear(): void {
    const entries = [...this.#map];
    this.#map.clear();
    for (const [key, value] of entries) this.dispose?.(value, key);
  }
}

/**
 * Priority queue (lower number first, evaluated when a slot frees up) with bounded concurrency. A task whose signal aborts while it is still queued never starts;
 * a started task is expected to honour the signal itself (pdf.js render tasks are cancelled through it).
 */
export class TaskQueue {
  readonly #waiting: Array<{ priority: () => number; order: number; start(): void; cancel(): void }> = [];
  #active = 0;
  #order = 0;
  /** Counters for diagnostics and tests. */
  started = 0;
  skipped = 0;
  constructor(private readonly concurrency: number) {}
  get active() { return this.#active; }
  get queued() { return this.#waiting.length; }
  /** Resolves with the task result, or `undefined` when it was cancelled before starting. Task errors reject. */
  run<T>(task: () => Promise<T>, options: { signal?: AbortSignal; priority?: number | (() => number) } = {}): Promise<T | undefined> {
    const { signal, priority = 0 } = options;
    if (signal?.aborted) { this.skipped++; return Promise.resolve(undefined); }
    return new Promise<T | undefined>((resolve, reject) => {
      const entry = {
        priority: typeof priority === 'function' ? priority : () => priority, order: this.#order++,
        start: () => {
          signal?.removeEventListener('abort', entry.cancel);
          this.#active++; this.started++;
          task().then(resolve, reject).finally(() => { this.#active--; this.#pump(); });
        },
        cancel: () => {
          const at = this.#waiting.indexOf(entry);
          if (at === -1) return;
          this.#waiting.splice(at, 1); this.skipped++;
          resolve(undefined);
        },
      };
      signal?.addEventListener('abort', entry.cancel, { once: true });
      this.#waiting.push(entry);
      this.#pump();
    });
  }
  #pump(): void {
    while (this.#active < this.concurrency && this.#waiting.length) {
      // priorities are read lazily: a page that scrolled into view while queued is promoted without re-queueing
      this.#waiting.sort((a, b) => a.priority() - b.priority() || a.order - b.order);
      this.#waiting.shift()!.start();
    }
  }
}

/** Trailing throttle: at most one call per `ms`, always delivering the latest arguments; `flush` runs a pending call now. */
export function createThrottle<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  let last = -Infinity;
  const fire = () => {
    timer = null;
    if (!pending) return;
    const args = pending; pending = null; last = Date.now();
    fn(...args);
  };
  return {
    call(...args: A) {
      pending = args;
      if (timer) return;
      const wait = Math.max(0, last + ms - Date.now());
      timer = setTimeout(fire, wait);
    },
    flush() { if (timer) { clearTimeout(timer); fire(); } },
    cancel() { if (timer) clearTimeout(timer); timer = null; pending = null; },
  };
}
