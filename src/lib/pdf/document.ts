import { getDocument, OPS, PasswordResponses, PDFWorker } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { resolvePdfResources } from './worker';
import { planRaster, rgbaToGray } from '../ocr/raster';
import type { PageRaster } from '../ocr/pdf-pages';

/**
 * Offline PDF document layer on top of pdf.js.
 *
 * Security posture (each point is pinned by a test in document.test.ts):
 * - Bytes in, nothing out: a document is opened from a Uint8Array only. `url`, `range`, `httpHeaders`,
 *   `withCredentials` and `docBaseUrl` are never passed and auto-fetch, streaming and range requests are
 *   disabled, so no code path starts a network request for the document. The only fetches are the bundled
 *   same-origin resource folders (CMaps, standard fonts, wasm decoders, ICC profiles; see worker.ts).
 * - No document JavaScript: pdf.js runs PDF scripting in a separate sandbox (pdf.sandbox + quickjs-eval.wasm) that only
 *   the pdfjs-dist/web viewer components load. This layer never imports them and `enableXfa` is off, so OpenAction,
 *   additional-action and widget scripts and XFA forms stay inert data.
 * - Annotation links (URI, GoToR, Launch, SubmitForm, ...) are never followed: the handle exposes no link service,
 *   annotation layer or navigation, and `renderPage` only paints appearance streams.
 * - No system fonts (`useSystemFonts: false`): glyphs come from embedded fonts or the bundled substitutes; worker verbosity 0.
 * - pdfjs-dist 6.4 has no `isEvalSupported` option any more: the build contains no `eval`/`new Function` call
 *   sites, so it runs under a CSP without 'unsafe-eval'.
 * - Resource ownership: every document gets a DEDICATED pdf.js worker that this layer creates and destroys itself
 *   (`WorkerLease`), on success, failure, abort and limit paths alike (B31).
 *
 * Coordinate convention for `TextItem`: PDF points (1/72 in) at scale 1 on an UNROTATED viewport
 * (the page /Rotate is ignored, it is reported separately by `getPageSize`), origin at the top-left
 * corner of the page box, Y pointing down. `x`/`y` are the top-left corner of the item's box, whose
 * height is the font size (the box spans one font size above the baseline). Rotated text is reported
 * as its axis-aligned bounding box. To place an item on a page displayed with rotation `r`
 * (page rotation + user rotation) rotate the box about the page: see `rotateRect` in PdfViewer.
 */
export type PdfErrorCode = 'PASSWORD_REQUIRED' | 'INVALID_PASSWORD' | 'LIMIT_EXCEEDED' | 'INVALID_PDF' | 'ABORTED' | 'DESTROYED';

export class PdfError extends Error {
  readonly code: PdfErrorCode;
  constructor(code: PdfErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfError';
    this.code = code;
  }
}

export interface TextItem {
  str: string; x: number; y: number; width: number; height: number; page: number;
  /** Absent for the PDF's own text layer; 'ocr' for a word recognized from the page image (src/lib/ocr). */
  source?: 'ocr';
  /** Recognition confidence 0-100 (recognized words only). */
  confidence?: number;
}
export interface PageSize { width: number; height: number; rotation: number }
export interface OutlineEntry { title: string; page: number; depth: number }
export interface RenderPageOptions {
  /** CSS-pixel-per-point factor multiplied by the device pixel ratio; the canvas is resized to the viewport. */
  scale: number;
  /** Extra clockwise rotation on top of the page's own /Rotate. */
  rotation: 0 | 90 | 180 | 270;
  canvas: HTMLCanvasElement;
  signal?: AbortSignal;
  /** Canvas fill behind the page content; pdf.js defaults to white. */
  background?: string;
}
export interface PdfHandle {
  readonly pageCount: number;
  /** Unrotated page box in points at scale 1 plus the page's own /Rotate (0, 90, 180 or 270). */
  getPageSize(page: number): Promise<PageSize>;
  /** Resolves when drawn, or silently when cancelled through `signal` (check `signal.aborted`). */
  renderPage(page: number, options: RenderPageOptions): Promise<void>;
  /** Text items in the convention documented above; whitespace-only items are dropped. Cached (LRU). */
  getTextItems(page: number): Promise<TextItem[]>;
  /** Flattened PDF bookmarks (depth-first) that resolve to a page; bounded to MAX_OUTLINE_ENTRIES. */
  getOutline(): Promise<OutlineEntry[]>;
  /** Image painting operations of the page (raster images, inline images, image masks); 0 for a vector or empty page. Cached. */
  getPageImageCount(page: number): Promise<number>;
  /**
   * The page, UNROTATED (the convention of TextItem), on white as 8-bit grey at `dpi` (lowered so the raster stays within
   * `maxPixels`): the input of text recognition. `scale` is pixels per point; `rotation` is the page's own /Rotate.
   * Rejects with PdfError('ABORTED') when `signal` fires.
   */
  renderPageGray(page: number, options: { dpi: number; maxPixels: number; signal?: AbortSignal }): Promise<PageRaster>;
  destroy(): Promise<void>;
}
export interface OpenPdfOptions { maxPages?: number; password?: string; signal?: AbortSignal }

export const DEFAULT_MAX_PAGES = 2000;
export const TEXT_CACHE_PAGES = 64;
export const MAX_TEXT_ITEMS_PER_PAGE = 50_000;
export const MAX_OUTLINE_ENTRIES = 2000;

/**
 * Test seam: every pdf.js worker this layer starts is created here, so tests can observe whether each one was
 * destroyed. Passing null restores the default.
 */
let createWorker = (): PDFWorker => new PDFWorker({ verbosity: 0 });
export function setPdfWorkerFactory(factory: (() => PDFWorker) | null): void {
  createWorker = factory ?? (() => new PDFWorker({ verbosity: 0 }));
}

/** Upper bound for the teardown handshake: a worker that never came up must not block a rejection forever. */
const CLEANUP_TIMEOUT_MS = 5000;

/**
 * Owns one loading task and the dedicated worker created for it. `release()` is idempotent, never rejects and always
 * destroys the worker, even when the task's own teardown fails or hangs (pdf.js does not destroy a worker that was
 * passed in, and `task.destroy()` skips its worker step when it throws).
 */
class WorkerLease {
  #released: Promise<void> | null = null;
  constructor(readonly task: PDFDocumentLoadingTask, readonly worker: PDFWorker) {}
  release(): Promise<void> {
    return this.#released ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.task.destroy(), new Promise<void>(resolve => { timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS); })]);
      } catch { /* a failing teardown must not mask the error being reported; the worker is destroyed below regardless */ } finally {
        clearTimeout(timer);
      }
      try { this.worker.destroy(); } catch { /* already gone */ }
    })();
  }
}

const hasName = (error: unknown, name: string) => typeof error === 'object' && error !== null && (error as { name?: unknown }).name === name;

function toPdfError(error: unknown, signal?: AbortSignal): PdfError {
  if (error instanceof PdfError) return error;
  if (signal?.aborted) return new PdfError('ABORTED', 'Opening the PDF was cancelled.', { cause: error });
  const message = error instanceof Error ? error.message : String(error);
  if (hasName(error, 'PasswordException')) {
    const incorrect = (error as { code?: unknown }).code === PasswordResponses.INCORRECT_PASSWORD;
    return new PdfError(incorrect ? 'INVALID_PASSWORD' : 'PASSWORD_REQUIRED', message, { cause: error });
  }
  return new PdfError('INVALID_PDF', message || 'The file is not a readable PDF.', { cause: error });
}

class Lru<K, V> {
  readonly #map = new Map<K, V>();
  constructor(private readonly capacity: number) {}
  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) { this.#map.delete(key); this.#map.set(key, value); }
    return value;
  }
  set(key: K, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.capacity) {
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      this.#map.delete(oldest.value);
    }
  }
  clear(): void { this.#map.clear(); }
}

/** Operators that paint raster data (pdf.js OPS); a page with none of them has nothing to recognize. */
const IMAGE_OPS: ReadonlySet<number> = new Set([
  OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup, OPS.paintImageXObjectRepeat,
  OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintImageMaskXObjectRepeat,
]);

type RawTextItem = { str: string; transform: number[]; width: number; height: number; fontName: string };
const isTextItem = (item: unknown): item is RawTextItem => typeof item === 'object' && item !== null && typeof (item as { str?: unknown }).str === 'string';
const isRef = (value: unknown): value is { num: number; gen: number } =>
  typeof value === 'object' && value !== null && Number.isInteger((value as { num?: unknown }).num) && Number.isInteger((value as { gen?: unknown }).gen);

class Handle implements PdfHandle {
  readonly pageCount: number;
  readonly #lease: WorkerLease;
  readonly #doc: PDFDocumentProxy;
  readonly #pages = new Map<number, Promise<PDFPageProxy>>();
  readonly #text = new Lru<number, TextItem[]>(TEXT_CACHE_PAGES);
  readonly #textPending = new Map<number, Promise<TextItem[]>>();
  readonly #imageCounts = new Map<number, Promise<number>>();
  #destroyed = false;
  #destroying: Promise<void> | null = null;

  constructor(lease: WorkerLease, doc: PDFDocumentProxy) {
    this.#lease = lease; this.#doc = doc; this.pageCount = doc.numPages;
  }

  /** pdf.js rejects in-flight work with assorted errors once its transport is torn down; callers get one structured code. */
  async #guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (this.#destroyed && !(error instanceof PdfError)) throw new PdfError('DESTROYED', 'The PDF document has been closed.', { cause: error });
      throw error;
    }
  }

  #page(page: number): Promise<PDFPageProxy> {
    if (this.#destroyed) return Promise.reject(new PdfError('DESTROYED', 'The PDF document has been closed.'));
    if (!Number.isInteger(page) || page < 1 || page > this.pageCount) return Promise.reject(new RangeError(`Page ${page} is out of range 1..${this.pageCount}.`));
    let pending = this.#pages.get(page);
    if (!pending) {
      pending = this.#doc.getPage(page);
      this.#pages.set(page, pending);
      pending.catch(() => this.#pages.delete(page));
    }
    return pending;
  }

  getPageSize(page: number): Promise<PageSize> {
    return this.#guard(async () => {
      const proxy = await this.#page(page);
      const viewport = proxy.getViewport({ scale: 1, rotation: 0 });
      return { width: viewport.width, height: viewport.height, rotation: ((proxy.rotate % 360) + 360) % 360 };
    });
  }

  renderPage(page: number, options: RenderPageOptions): Promise<void> {
    return this.#guard(async () => {
      const proxy = await this.#page(page);
      if (options.signal?.aborted) return;
      const viewport = proxy.getViewport({ scale: options.scale, rotation: (((proxy.rotate + options.rotation) % 360) + 360) % 360 });
      const { canvas } = options;
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const task = proxy.render({ canvas, viewport, background: options.background });
      const cancel = () => task.cancel();
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        await task.promise;
      } catch (error) {
        if (hasName(error, 'RenderingCancelledException') || options.signal?.aborted) return;
        throw error;
      } finally {
        options.signal?.removeEventListener('abort', cancel);
      }
    });
  }

  /** Single-flight per page: concurrent callers (viewer, indexer, sampler) share one `getTextContent` round trip. */
  getTextItems(page: number): Promise<TextItem[]> {
    const cached = this.#text.get(page);
    if (cached) return Promise.resolve(cached);
    let pending = this.#textPending.get(page);
    if (!pending) {
      pending = this.#guard(() => this.#readText(page)).finally(() => this.#textPending.delete(page));
      this.#textPending.set(page, pending);
    }
    return pending;
  }

  async #readText(page: number): Promise<TextItem[]> {
    const proxy = await this.#page(page);
    const viewport = proxy.getViewport({ scale: 1, rotation: 0 });
    const content = await proxy.getTextContent();
    const items: TextItem[] = [];
    for (const raw of content.items) {
      if (!isTextItem(raw) || raw.str.trim() === '') continue;
      if (items.length >= MAX_TEXT_ITEMS_PER_PAGE) break;
      const [a, b, c, d, e, f] = raw.transform;
      const fontHeight = Math.hypot(c, d) || raw.height || 1;
      const vertical = content.styles[raw.fontName]?.vertical === true;
      const xLength = Math.hypot(a, b) || 1, yLength = Math.hypot(c, d) || 1;
      const xDir = { x: a / xLength, y: b / xLength }, yDir = { x: c / yLength, y: d / yLength };
      const along = vertical ? fontHeight : raw.width;
      const up = vertical ? -raw.height : fontHeight;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [u, v] of [[0, 0], [along, 0], [along, up], [0, up]]) {
        const point = viewport.convertToViewportPoint(e + u * xDir.x + v * yDir.x, f + u * xDir.y + v * yDir.y) as [number, number];
        minX = Math.min(minX, point[0]); maxX = Math.max(maxX, point[0]);
        minY = Math.min(minY, point[1]); maxY = Math.max(maxY, point[1]);
      }
      items.push({ str: raw.str, x: minX, y: minY, width: maxX - minX, height: maxY - minY, page });
    }
    if (this.#destroyed) throw new PdfError('DESTROYED', 'The PDF document has been closed.');
    this.#text.set(page, items);
    return items;
  }

  getPageImageCount(page: number): Promise<number> {
    let pending = this.#imageCounts.get(page);
    if (!pending) {
      pending = this.#guard(async () => {
        const proxy = await this.#page(page);
        const list = await proxy.getOperatorList();
        let count = 0;
        for (const op of list.fnArray) if (IMAGE_OPS.has(op)) count++;
        return count;
      });
      this.#imageCounts.set(page, pending);
      pending.catch(() => this.#imageCounts.delete(page));
    }
    return pending;
  }

  renderPageGray(page: number, options: { dpi: number; maxPixels: number; signal?: AbortSignal }): Promise<PageRaster> {
    return this.#guard(async () => {
      const cancelled = () => new PdfError('ABORTED', 'Rendering the page was cancelled.');
      if (options.signal?.aborted) throw cancelled();
      const proxy = await this.#page(page);
      const base = proxy.getViewport({ scale: 1, rotation: 0 });
      const plan = planRaster(base.width, base.height, options.dpi, options.maxPixels);
      const viewport = proxy.getViewport({ scale: plan.scale, rotation: 0 });
      if (options.signal?.aborted) throw cancelled();
      const { width, height } = plan;
      // OffscreenCanvas in the renderer (no DOM needed, so a background job can call this too); pdf.js' own factory in Node.
      const target = typeof OffscreenCanvas !== 'undefined'
        ? { canvas: new OffscreenCanvas(width, height), context: null as null | CanvasRenderingContext2D }
        : (this.#doc.canvasFactory as { create(w: number, h: number): { canvas: OffscreenCanvas; context: CanvasRenderingContext2D } }).create(width, height);
      const canvas = target.canvas;
      try {
        const task = proxy.render({ canvas: canvas as unknown as HTMLCanvasElement, ...(target.context ? { canvasContext: target.context } : {}), viewport, background: '#ffffff' });
        const cancel = () => task.cancel();
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.signal?.aborted) cancel();
        try {
          await task.promise;
        } catch (error) {
          if (hasName(error, 'RenderingCancelledException') || options.signal?.aborted) throw cancelled();
          throw error;
        } finally {
          options.signal?.removeEventListener('abort', cancel);
        }
        if (options.signal?.aborted) throw cancelled();
        const context = (target.context ?? canvas.getContext('2d')) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!context) throw new PdfError('INVALID_PDF', 'No 2D canvas is available to render the page.');
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        return { image: rgbaToGray(pixels.data, canvas.width, canvas.height), scale: canvas.width / base.width, rotation: ((proxy.rotate % 360) + 360) % 360 };
      } finally {
        canvas.width = 0; canvas.height = 0; // frees the backing store at once (an A3 page at 300 dpi is 70 MB of RGBA)
      }
    });
  }

  getOutline(): Promise<OutlineEntry[]> {
    if (this.#destroyed) return Promise.reject(new PdfError('DESTROYED', 'The PDF document has been closed.'));
    return this.#guard(() => this.#readOutline());
  }

  async #readOutline(): Promise<OutlineEntry[]> {
    const roots = await this.#doc.getOutline();
    if (!roots?.length) return [];
    type Node = { title: string; dest: string | unknown[] | null; items?: Node[] };
    const flat: { title: string; depth: number; dest: string | unknown[] | null }[] = [];
    const stack: { node: Node; depth: number }[] = roots.map(node => ({ node: node as Node, depth: 0 })).reverse();
    while (stack.length && flat.length < MAX_OUTLINE_ENTRIES) {
      const { node, depth } = stack.pop()!;
      flat.push({ title: String(node.title ?? '').trim(), depth, dest: node.dest ?? null });
      const children = Array.isArray(node.items) ? node.items : [];
      for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth: depth + 1 });
    }
    const pageByRef = new Map<string, Promise<number>>();
    const resolve = async (dest: string | unknown[] | null): Promise<number | null> => {
      try {
        const explicit = typeof dest === 'string' ? await this.#doc.getDestination(dest) : dest;
        if (!Array.isArray(explicit) || !explicit.length) return null;
        const target = explicit[0];
        let index: number;
        if (typeof target === 'number') index = target;
        else if (isRef(target)) {
          const key = `${target.num}R${target.gen}`;
          let pending = pageByRef.get(key);
          if (!pending) { pending = this.#doc.getPageIndex(target); pageByRef.set(key, pending); }
          index = await pending;
        } else return null;
        return Number.isInteger(index) && index >= 0 && index < this.pageCount ? index + 1 : null;
      } catch {
        return null;
      }
    };
    const pages = await Promise.all(flat.map(entry => resolve(entry.dest)));
    const entries: OutlineEntry[] = [];
    flat.forEach((entry, i) => { const page = pages[i]; if (page !== null) entries.push({ title: entry.title, page, depth: entry.depth }); });
    return entries;
  }

  destroy(): Promise<void> {
    return this.#destroying ??= (async () => {
      this.#destroyed = true;
      this.#pages.clear();
      this.#text.clear();
      this.#imageCounts.clear();
      await this.#lease.release();
    })();
  }
}

/**
 * Opens a PDF from bytes. The data is copied because pdf.js transfers the buffer to its worker.
 * Rejects with `PdfError` codes PASSWORD_REQUIRED / INVALID_PASSWORD / LIMIT_EXCEEDED (pageCount >
 * maxPages, default 2000) / INVALID_PDF / ABORTED. On EVERY rejection the loading task and its dedicated
 * worker are already destroyed when the promise settles (B31); on success they belong to the returned handle.
 */
export async function openPdf(data: Uint8Array, options: OpenPdfOptions = {}): Promise<PdfHandle> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const { signal } = options;
  if (signal?.aborted) throw new PdfError('ABORTED', 'Opening the PDF was cancelled.');
  const urls = resolvePdfResources();
  const worker = createWorker();
  let task: PDFDocumentLoadingTask;
  try {
    task = getDocument({
      data: data.slice(), worker,
      password: options.password,
      disableAutoFetch: true, disableStream: true, disableRange: true, enableXfa: false, useSystemFonts: false,
      cMapUrl: urls.cMapUrl, cMapPacked: true, standardFontDataUrl: urls.standardFontDataUrl, wasmUrl: urls.wasmUrl, iccUrl: urls.iccUrl,
      verbosity: 0,
    });
  } catch (error) {
    try { worker.destroy(); } catch { /* nothing started yet */ }
    throw toPdfError(error, signal);
  }
  const lease = new WorkerLease(task, worker);
  // An abort settles the open immediately (even if pdf.js never answers, e.g. its worker failed to start); the teardown
  // runs in the background and is awaited before rejecting.
  let onAbort: (() => void) | undefined;
  const cancelled = signal ? new Promise<never>((_, reject) => {
    onAbort = () => { void lease.release(); reject(new PdfError('ABORTED', 'Opening the PDF was cancelled.')); };
    signal.addEventListener('abort', onAbort, { once: true });
  }) : null;
  cancelled?.catch(() => {});
  try {
    const doc = await (cancelled ? Promise.race([task.promise, cancelled]) : task.promise);
    if (signal?.aborted) throw new PdfError('ABORTED', 'Opening the PDF was cancelled.');
    if (doc.numPages > maxPages) throw new PdfError('LIMIT_EXCEEDED', `The PDF has ${doc.numPages} pages; at most ${maxPages} are supported.`);
    return new Handle(lease, doc);
  } catch (error) {
    await lease.release();
    throw toPdfError(error, signal);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** Samples the first pages; a document whose sampled pages have no text items is treated as scan-only. */
export async function isTextSearchable(handle: PdfHandle, options: { samplePages?: number } = {}): Promise<{ searchable: boolean; sampledPages: number; itemsFound: number }> {
  const sampledPages = Math.max(0, Math.min(handle.pageCount, Math.floor(options.samplePages ?? 5)));
  let itemsFound = 0;
  for (let page = 1; page <= sampledPages; page++) itemsFound += (await handle.getTextItems(page)).length;
  return { searchable: itemsFound > 0, sampledPages, itemsFound };
}
