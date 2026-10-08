import { openPdf, PdfError } from './document';
import type { OutlineEntry, PdfErrorCode, PdfHandle, TextItem } from './document';
import { buildTextIndex, extractRefCandidatesAsync, findTextAsync, mergeRecognizedText } from './search';
import type { FindOptions, Hit, TextIndex } from './search';
import type {
  CreatePdfSessionOptions, PdfPageTextKind, PdfSession, PdfSessionIndexState, PdfSessionOcrState, PdfSessionSnapshot, RefCandidateResult,
} from './session-contract';
import { documentDigest, sharedOcrCache } from '../ocr/cache';
import { OCR_DEFAULT_DPI, OcrError, isOcrError } from '../ocr/contract';
import { orderPages, recognizePdfPages } from '../ocr/pdf-pages';

/**
 * One PdfSession per attached PDF (contract: session-contract.ts). It owns the pdf.js handle, the lazily built text
 * index and the outline, so they survive viewer unmounts and feed the unified search and the board cross-reference.
 *
 * Lifecycle: `opening` -> `ready` | `password-required` | `error`; `password-required` <-> `invalid-password` until
 * `submitPassword` succeeds (the status stays unchanged WHILE a password is being checked: a form stays mounted and
 * tracks its own pending state through the returned promise); `dispose()` -> `closed` from anywhere, even mid-open.
 * The original bytes are kept only while a password retry may still need them.
 *
 * Memory: the session holds the handle (pdf.js keeps a 64-page text LRU), at most `maxIndexItems` indexed text items
 * (default DEFAULT_SESSION_MAX_INDEX_ITEMS), the outline (<= 2000 entries) and the immutable snapshot. Search results
 * and reference candidates are returned to the caller and never cached here.
 *
 * Index: built lazily on the first `ensureIndex` / `find` / `refCandidates` and single-flight. It runs to completion
 * once started; aborting the `signal` of one `find` or `refCandidates` call only stops THAT call from waiting (a UI that
 * aborts and re-issues a query per keystroke must not restart the build). Only `dispose()` cancels it (state `cancelled`).
 * A page whose text cannot be read is skipped and disclosed (`index.state === 'truncated'`), never silently dropped.
 *
 * Scan-only detection: after opening, a few pages (the first ones plus an even spread) are sampled; no text items =>
 * `searchable: false` (image-only / raster document: nothing to search, the UI must say so). The verdict is provisional
 * for documents longer than the sample and is corrected as soon as the full index proves otherwise.
 *
 * Text recognition (`options.ocr`): `inspectPage` tells a page with a text layer from an image-only one; `recognizeText` runs the
 * OCR job (src/lib/ocr/pdf-pages.ts) over the image-only pages, one at a time, publishing progress in `snapshot.ocr`. Recognized
 * words are kept per page (`getRecognizedText`), stored in the in-memory cache under the SHA-256 of the document bytes (restored when
 * the same document is opened again) and merged into the index used by `find` and `refCandidates`. `searchable` keeps describing
 * the PDF's own text layer.
 */
export const DEFAULT_SESSION_MAX_INDEX_ITEMS = 500_000;
/** Minimum time between two `building` snapshots: indexing a 2000-page document must not flood React with commits. */
export const INDEX_PROGRESS_INTERVAL_MS = 100;
export const SAMPLE_PAGE_COUNT = 6;

/** Test seams; production code passes none. */
export interface PdfSessionHooks {
  open?: typeof openPdf;
  now?: () => number;
  progressIntervalMs?: number;
  samplePages?: number;
}

/** Pages to probe for a text layer: the leading pages, then an even spread up to and including the last page. */
export function samplePageNumbers(pageCount: number, count: number): number[] {
  const pages = new Set<number>();
  const head = Math.min(pageCount, Math.ceil(count / 2));
  for (let page = 1; page <= head; page++) pages.add(page);
  const rest = count - head, remaining = pageCount - head;
  for (let k = 1; k <= rest && remaining > 0; k++) pages.add(Math.min(pageCount, head + Math.ceil((remaining * k) / rest)));
  return [...pages].sort((a, b) => a - b);
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };
const NO_OUTLINE: readonly OutlineEntry[] = Object.freeze([]);
const KNOWN_CODES: readonly string[] = ['PASSWORD_REQUIRED', 'INVALID_PASSWORD', 'LIMIT_EXCEEDED', 'INVALID_PDF', 'ABORTED', 'DESTROYED'];

const sameIndex = (a: PdfSessionIndexState, b: PdfSessionIndexState) => a.state === b.state && a.indexedPages === b.indexedPages && a.pageCount === b.pageCount && a.items === b.items;
const sameError = (a: PdfSessionSnapshot['error'], b: PdfSessionSnapshot['error']) => a === b || (a !== null && b !== null && a.code === b.code && a.message === b.message);
const OCR_FIELDS = ['state', 'totalPages', 'processedPages', 'currentPage', 'recognizedPages', 'words', 'failedPages', 'revision'] as const;
const sameOcrError = (a: PdfSessionOcrState['error'], b: PdfSessionOcrState['error']) => a === b || (a !== null && b !== null && a.code === b.code && a.message === b.message);
const sameOcr = (a: PdfSessionOcrState, b: PdfSessionOcrState) => a === b || (OCR_FIELDS.every(field => a[field] === b[field]) && sameOcrError(a.error, b.error));
const ocrState = (state: PdfSessionOcrState['state']): PdfSessionOcrState => Object.freeze({
  state, totalPages: 0, processedPages: 0, currentPage: 0, recognizedPages: 0, words: 0, failedPages: 0, revision: 0, error: null,
});

export function createPdfSession(options: CreatePdfSessionOptions, hooks: PdfSessionHooks = {}): PdfSession {
  const open = hooks.open ?? openPdf;
  const now = hooks.now ?? (() => performance.now());
  const progressInterval = hooks.progressIntervalMs ?? INDEX_PROGRESS_INTERVAL_MS;
  const maxIndexItems = options.maxIndexItems ?? DEFAULT_SESSION_MAX_INDEX_ITEMS;
  const lifecycle = new AbortController(); // aborted by dispose(): cancels the open, the index build and every waiting call
  const listeners = new Set<() => void>();
  const readyWaiters = new Set<{ resolve(handle: PdfHandle): void; reject(error: unknown): void }>();

  const ocr = options.ocr;
  const ocrLanguage = ocr?.language ?? 'eng';
  const ocrDpi = ocr?.dpi ?? OCR_DEFAULT_DPI;
  const ocrCache = ocr?.cache ?? sharedOcrCache;
  let snapshot: PdfSessionSnapshot = Object.freeze({
    status: 'opening', error: null, pageCount: 0, searchable: null,
    index: Object.freeze({ state: 'idle', indexedPages: 0, pageCount: 0, items: 0 }) as PdfSessionIndexState, outline: NO_OUTLINE,
    ocr: ocrState(ocr ? 'idle' : 'unavailable'),
  });
  let handle: PdfHandle | null = null;
  let bytes: Uint8Array | null = options.data; // released as soon as no password retry can need it
  let index: TextIndex | null = null;
  let indexing: Promise<TextIndex> | null = null;
  let closed = false;
  let disposing: Promise<void> | null = null;
  let attemptSeq = 0;
  let attempt: AbortController | null = null;
  let openSettled: Promise<void> = Promise.resolve();
  // Text recognition state: recognized words per page, the page kinds seen so far, the running job and the merged index.
  const recognized = new Map<number, readonly TextItem[]>();
  const pageKinds = new Map<number, Promise<PdfPageTextKind>>();
  let ocrJob: Promise<void> | null = null;
  let ocrAbort: AbortController | null = null;
  let merged: { base: TextIndex; revision: number; index: TextIndex } | null = null;
  /** Content key of the recognized-text cache (null without OCR or when hashing failed). */
  const documentKey: Promise<string | null> = ocr ? documentDigest(options.data).catch(() => null) : Promise.resolve(null);

  const destroyed = () => new PdfError('DESTROYED', 'The PDF session has been closed.');
  const interrupted = (message: string) => (closed ? destroyed() : new PdfError('ABORTED', message));

  function update(patch: Partial<Writable<PdfSessionSnapshot>>): void {
    const next = { ...snapshot, ...patch };
    const changed = next.status !== snapshot.status || next.pageCount !== snapshot.pageCount || next.searchable !== snapshot.searchable
      || next.outline !== snapshot.outline || !sameError(next.error, snapshot.error) || !sameIndex(next.index, snapshot.index) || !sameOcr(next.ocr, snapshot.ocr);
    if (!changed) return;
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { queueMicrotask(() => { throw error; }); } // one faulty subscriber must not starve the others
    }
  }
  const setIndex = (state: PdfSessionIndexState['state'], indexedPages: number, pageCount: number, items: number) =>
    Object.freeze({ state, indexedPages, pageCount, items }) as PdfSessionIndexState;
  const setOcr = (patch: Partial<Writable<PdfSessionOcrState>>) => {
    const next = Object.freeze({ ...snapshot.ocr, ...patch }) as PdfSessionOcrState;
    if (!sameOcr(next, snapshot.ocr)) update({ ocr: next });
  };
  /** Publishes the recognized pages and words; a new revision tells consumers to search and cross-reference again. */
  const publishRecognized = (patch: Partial<Writable<PdfSessionOcrState>> = {}) => {
    let words = 0;
    for (const items of recognized.values()) words += items.length;
    setOcr({ ...patch, recognizedPages: recognized.size, words, revision: snapshot.ocr.revision + 1 });
  };

  const statusError = (): PdfError => {
    const { status, error } = snapshot;
    if (status === 'closed') return destroyed();
    if (status === 'password-required') return new PdfError('PASSWORD_REQUIRED', error?.message ?? 'The PDF is password protected.');
    if (status === 'invalid-password') return new PdfError('INVALID_PASSWORD', error?.message ?? 'The password is incorrect.');
    const code = error && KNOWN_CODES.includes(error.code) ? error.code as PdfErrorCode : 'INVALID_PDF';
    return new PdfError(code, error?.message ?? 'The PDF could not be opened.');
  };
  function settleWaiters(): void {
    for (const waiter of [...readyWaiters]) {
      readyWaiters.delete(waiter);
      if (snapshot.status === 'ready' && handle) waiter.resolve(handle); else waiter.reject(statusError());
    }
  }
  function whenReady(): Promise<PdfHandle> {
    if (snapshot.status === 'ready' && handle) return Promise.resolve(handle);
    if (snapshot.status !== 'opening') return Promise.reject(statusError());
    return new Promise((resolve, reject) => { readyWaiters.add({ resolve, reject }); });
  }

  /** Rejects with ABORTED/DESTROYED when `signal` fires; the wrapped work itself is not cancelled. */
  function abortable<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(interrupted(message));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  const isLive = (candidate: PdfHandle) => !closed && handle === candidate;

  async function sampleSearchable(target: PdfHandle, samplePages: number): Promise<void> {
    let read = 0, found = 0;
    for (const page of samplePageNumbers(target.pageCount, samplePages)) {
      if (!isLive(target)) return;
      try { found += (await target.getTextItems(page)).length; read++; } catch { if (!isLive(target)) return; } // an unreadable page proves nothing either way
      if (found > 0) break;
    }
    if (!isLive(target) || snapshot.searchable !== null) return;
    if (found > 0) update({ searchable: true });
    else if (read > 0) update({ searchable: false });
  }
  async function loadOutline(target: PdfHandle): Promise<void> {
    try {
      const entries = await target.getOutline();
      if (isLive(target) && entries.length) update({ outline: Object.freeze(entries) });
    } catch { /* bookmarks are optional: a broken outline never fails the document */ }
  }

  function startAttempt(password: string | undefined, userSubmitted: boolean): Promise<void> {
    const mine = ++attemptSeq;
    attempt?.abort();
    const controller = attempt = new AbortController();
    const signal = AbortSignal.any([lifecycle.signal, controller.signal]);
    const run = (async () => {
      const source = bytes;
      if (!source) throw destroyed();
      let opened: PdfHandle;
      try {
        opened = await open(source, { maxPages: options.maxPages, password, signal });
      } catch (raw) {
        if (closed || mine !== attemptSeq) throw new PdfError('ABORTED', 'Opening the PDF was cancelled.', { cause: raw });
        const error = raw instanceof PdfError ? raw : new PdfError('INVALID_PDF', raw instanceof Error ? raw.message : String(raw), { cause: raw });
        // A submitted empty password is simply a wrong password; a first attempt without one is "password required".
        const code: PdfErrorCode = userSubmitted && error.code === 'PASSWORD_REQUIRED' ? 'INVALID_PASSWORD' : error.code;
        const status = code === 'PASSWORD_REQUIRED' ? 'password-required' : code === 'INVALID_PASSWORD' ? 'invalid-password' : 'error';
        if (status === 'error') bytes = null;
        update({ status, error: { code, message: code === error.code ? error.message : 'The password is incorrect.' } });
        settleWaiters();
        throw code === error.code ? error : new PdfError(code, 'The password is incorrect.', { cause: error });
      }
      if (closed || mine !== attemptSeq) {
        await opened.destroy().catch(() => {});
        throw new PdfError('ABORTED', 'Opening the PDF was cancelled.');
      }
      handle = opened;
      bytes = null;
      update({ status: 'ready', error: null, pageCount: opened.pageCount, index: setIndex('idle', 0, opened.pageCount, 0) });
      settleWaiters();
      void sampleSearchable(opened, hooks.samplePages ?? SAMPLE_PAGE_COUNT);
      void loadOutline(opened);
    })();
    openSettled = run.catch(() => {});
    return run;
  }

  async function buildIndex(): Promise<TextIndex> {
    try {
      const target = await whenReady();
      update({ index: setIndex('building', 0, target.pageCount, 0) });
      let lastNotified = now();
      const built = await buildTextIndex(target, {
        signal: lifecycle.signal, maxItems: maxIndexItems,
        onProgress(indexedPages, pageCount, items) {
          const time = now();
          if (time - lastNotified < progressInterval) return;
          lastNotified = time;
          update({ index: setIndex('building', indexedPages, pageCount, items) });
        },
      });
      if (closed) throw destroyed();
      index = built;
      // Items prove a text layer; an index that read every page without finding any proves its absence.
      const searchable = built.items.length > 0 ? true : built.truncated ? snapshot.searchable : false;
      update({ index: setIndex(built.truncated ? 'truncated' : 'done', built.indexedPages, built.pageCount, built.items.length), searchable });
      return built;
    } catch (error) {
      if (snapshot.index.state === 'building') update({ index: setIndex(closed ? 'cancelled' : 'error', snapshot.index.indexedPages, snapshot.index.pageCount, snapshot.index.items) });
      throw error;
    } finally {
      indexing = null;
    }
  }
  function ensureIndex(): Promise<TextIndex> {
    if (closed) return Promise.reject(destroyed());
    if (index) return Promise.resolve(index);
    return indexing ??= buildIndex();
  }
  const combine = (signal: AbortSignal | undefined) => (signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal);

  /** The text index plus the recognized words (rebuilt only when the recognized text changed). */
  async function indexWithRecognized(): Promise<TextIndex> {
    const base = await ensureIndex();
    if (!recognized.size) return base;
    const revision = snapshot.ocr.revision;
    if (merged && merged.base === base && merged.revision === revision) return merged.index;
    const index = mergeRecognizedText(base, recognized, maxIndexItems);
    merged = { base, revision, index };
    return index;
  }

  function inspectPage(page: number): Promise<PdfPageTextKind> {
    if (closed) return Promise.reject(destroyed());
    let pending = pageKinds.get(page);
    if (!pending) {
      pending = (async (): Promise<PdfPageTextKind> => {
        const target = await whenReady();
        if ((await target.getTextItems(page)).length > 0) return 'text';
        return (await target.getPageImageCount(page)) > 0 ? 'image-only' : 'blank';
      })();
      pageKinds.set(page, pending);
      pending.catch(() => pageKinds.delete(page));
    }
    return pending;
  }

  async function runRecognition(engine: NonNullable<CreatePdfSessionOptions['ocr']>, jobOptions: { pages?: readonly number[]; firstPage?: number }): Promise<void> {
    const target = await whenReady();
    const abort = ocrAbort = new AbortController();
    const signal = AbortSignal.any([lifecycle.signal, abort.signal]);
    let order = orderPages(target.pageCount, jobOptions.pages);
    const first = jobOptions.firstPage;
    if (first !== undefined && order.includes(first)) order = [first, ...order.filter(page => page !== first)];
    const todo = order.filter(page => !recognized.has(page));
    setOcr({ state: 'running', totalPages: todo.length, processedPages: 0, currentPage: 0, failedPages: 0, error: null });
    const key = await documentKey;
    let processed = 0, failed = 0;
    try {
      const result = await recognizePdfPages(target, {
        engine: engine.engine, language: ocrLanguage, pages: todo, dpi: ocrDpi, pageTimeoutMs: engine.pageTimeoutMs, signal,
        onPageStart: page => { if (isLive(target)) setOcr({ currentPage: page }); },
        onPage: pageResult => {
          if (!isLive(target)) return;
          processed++;
          if (pageResult.status === 'timeout' || pageResult.status === 'failed') failed++;
          if (pageResult.status !== 'recognized') { setOcr({ processedPages: processed, failedPages: failed }); return; }
          const items = Object.freeze(pageResult.items);
          recognized.set(pageResult.page, items);
          if (key) ocrCache.put({ document: key, language: ocrLanguage, dpi: ocrDpi }, pageResult.page, items);
          publishRecognized({ processedPages: processed, failedPages: failed });
        },
      });
      if (isLive(target)) setOcr({ state: result.cancelled ? 'cancelled' : 'done', currentPage: 0 });
    } catch (error) {
      if (!isLive(target)) return;
      if (signal.aborted) { setOcr({ state: 'cancelled', currentPage: 0 }); return; }
      setOcr({ state: 'error', currentPage: 0, error: { code: isOcrError(error) ? error.code : 'FAILED', message: error instanceof Error ? error.message : String(error) } });
    }
  }

  if (ocr) {
    // The same document opened again (or attached twice) shows its recognized pages at once.
    void documentKey.then(key => {
      if (!key || closed) return;
      const cached = ocrCache.get({ document: key, language: ocrLanguage, dpi: ocrDpi });
      if (!cached?.size) return;
      for (const [page, items] of cached) if (!recognized.has(page)) recognized.set(page, items);
      publishRecognized();
    });
  }

  const initial = startAttempt(options.password, false);
  initial.catch(() => {}); // the outcome is published through the snapshot

  return {
    id: options.id,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getHandle: () => (snapshot.status === 'ready' ? handle : null),

    async submitPassword(password) {
      if (closed) throw destroyed();
      if (snapshot.status === 'opening') await initial.catch(() => {});
      const { status } = snapshot;
      if (status === 'closed') throw destroyed();
      if (status === 'ready') return;
      if (status === 'error') throw statusError();
      await startAttempt(password, true);
    },

    ensureIndex,
    inspectPage,

    recognizeText(jobOptions = {}) {
      if (closed) return Promise.reject(destroyed());
      if (!ocr) return Promise.reject(new OcrError('UNAVAILABLE', 'Text recognition is not available for this document.'));
      return ocrJob ??= runRecognition(ocr, jobOptions).finally(() => { ocrJob = null; ocrAbort = null; });
    },
    cancelRecognition() { ocrAbort?.abort(); },
    getRecognizedText: page => recognized.get(page) ?? null,

    async find(query: string, findOptions: FindOptions & { signal?: AbortSignal } = {}): Promise<Hit[]> {
      if (closed) throw destroyed();
      const { signal, ...rest } = findOptions;
      if (signal?.aborted) throw new PdfError('ABORTED', 'The search was cancelled.');
      if (!query.trim()) return []; // nothing to look for: do not start indexing
      const cancel = combine(signal);
      const built = await abortable(indexWithRecognized(), cancel, 'The search was cancelled.');
      return findTextAsync(built, query, { ...rest, signal: cancel });
    },

    async refCandidates(refs, nets, scanOptions = {}): Promise<RefCandidateResult> {
      if (closed) throw destroyed();
      const { signal, maxTotalHits } = scanOptions;
      if (signal?.aborted) throw new PdfError('ABORTED', 'The reference scan was cancelled.');
      if (!refs.size && !nets.size) return { candidates: [], truncated: false, totalHits: 0 };
      const cancel = combine(signal);
      const built = await abortable(indexWithRecognized(), cancel, 'The reference scan was cancelled.');
      return extractRefCandidatesAsync(built, refs, nets, { signal: cancel, maxTotalHits });
    },

    dispose(): Promise<void> {
      return disposing ??= (async () => {
        closed = true;
        lifecycle.abort();
        attempt?.abort();
        const building = snapshot.index.state === 'building';
        update({ status: 'closed', error: null, outline: NO_OUTLINE, index: building ? setIndex('cancelled', snapshot.index.indexedPages, snapshot.index.pageCount, snapshot.index.items) : snapshot.index });
        index = null; bytes = null; merged = null;
        recognized.clear(); pageKinds.clear();
        settleWaiters();
        // Destroy the handle first: it rejects page reads still in flight, which is what lets a running index build observe
        // the abort. A mid-open abort destroys the loading task and its worker before `openSettled` resolves.
        const target = handle;
        handle = null;
        await Promise.allSettled([target ? target.destroy() : null, openSettled, indexing, ocrJob]);
        listeners.clear();
      })();
    },
  };
}
