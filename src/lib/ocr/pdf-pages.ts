import {
  OCR_DEFAULT_DPI, OCR_MAX_DPI, OCR_MAX_PAGE_PIXELS, OCR_MIN_DPI, OCR_PAGE_SEGMENTATION, OCR_PAGE_TIME_BUDGET_MS, OcrError, isOcrError,
} from './contract';
import type { GrayImage, OcrEngine, OcrEngineFactory, OcrLanguage, OcrWord, QuarterTurn } from './contract';
import type { TextItem } from '../pdf/document';

/**
 * The OCR job over PDF pages: the entry point for anything that wants recognized text, with no dependency on a viewer. The PDF
 * session runs it for "Recognize text", and a background indexer can run it for files nobody has open.
 *
 * Per page: pages that already have a text layer and pages that paint no image are skipped (reported, never recognized); the page
 * is rendered unrotated at `dpi` (lowered to fit `maxPixels`), turned to grey and recognized in two passes (upright as displayed and
 * a quarter turn more, for vertical labels). The page's TIME BUDGET covers rendering and recognition: on expiry the engine's worker
 * is terminated, the page is reported as `timeout` and the job continues on a fresh engine. Cancelling (signal) stops at once and
 * resolves with the pages finished so far (`cancelled: true`). An engine that cannot start at all rejects with UNAVAILABLE.
 *
 * Output words are PDF `TextItem`s in the convention of src/lib/pdf/document.ts (points, unrotated page box, top-left, Y down) with
 * `source: 'ocr'` and `confidence`.
 */

/** What the job needs from a PDF (PdfHandle implements it). */
export interface OcrPageSource {
  readonly pageCount: number;
  getTextItems(page: number): Promise<readonly TextItem[]>;
  /** Number of image painting operations of the page (0 = vector or empty page). */
  getPageImageCount(page: number): Promise<number>;
  /** The unrotated page as 8-bit grey at `scale` pixels per point (at most `maxPixels`), with the page's own /Rotate. */
  renderPageGray(page: number, options: { dpi: number; maxPixels: number; signal?: AbortSignal }): Promise<PageRaster>;
}
export interface PageRaster { image: GrayImage; scale: number; rotation: number }

export type OcrPageStatus = 'recognized' | 'has-text' | 'no-image' | 'timeout' | 'failed';
export interface OcrPageResult {
  page: number;
  status: OcrPageStatus;
  /** Recognized words (only for `recognized`; may be empty when the image holds no readable text). */
  items: TextItem[];
  /** Resolution actually used (0 when the page was not rendered). */
  dpi: number;
  ms: number;
  error?: string;
}
export interface RecognizePdfPagesOptions {
  engine: OcrEngineFactory;
  language?: OcrLanguage;
  /** 1-based pages in the order to process; default every page. Out-of-range and repeated pages are dropped. */
  pages?: readonly number[];
  dpi?: number;
  maxPixels?: number;
  /** Time budget per page (render + recognition), default OCR_PAGE_TIME_BUDGET_MS. */
  pageTimeoutMs?: number;
  /** Also recognize pages that have a text layer (default false). */
  includePagesWithText?: boolean;
  /** Also recognize pages that paint no image, e.g. outlined (stroked) text (default false). */
  includePagesWithoutImages?: boolean;
  signal?: AbortSignal;
  onPageStart?(page: number, index: number, total: number): void;
  onPage?(result: OcrPageResult, index: number, total: number): void;
}
export interface RecognizePdfPagesResult { pages: OcrPageResult[]; cancelled: boolean }

/** The engine is restarted after a failure; this many failures in a row (no page recognized in between) end the job. */
export const MAX_CONSECUTIVE_ENGINE_FAILURES = 3;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clampDpi = (dpi: number | undefined) => Math.min(OCR_MAX_DPI, Math.max(OCR_MIN_DPI, Number.isFinite(dpi) ? dpi as number : OCR_DEFAULT_DPI));
const turnsOf = (rotation: number): QuarterTurn => ((((Math.round(rotation / 90) % 4) + 4) % 4) as QuarterTurn);

/** Words in pixels of a raster at `scale` pixels per point -> recognized TextItems of `page`. */
export function wordsToTextItems(words: readonly OcrWord[], scale: number, page: number): TextItem[] {
  return words.map(word => ({
    str: word.text, x: word.x / scale, y: word.y / scale, width: word.width / scale, height: word.height / scale, page,
    source: 'ocr' as const, confidence: Math.floor(word.confidence),
  }));
}

export function orderPages(pageCount: number, pages?: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const page of pages ?? Array.from({ length: pageCount }, (_, i) => i + 1)) {
    if (Number.isInteger(page) && page >= 1 && page <= pageCount && !seen.has(page)) { seen.add(page); out.push(page); }
  }
  return out;
}

export async function recognizePdfPages(source: OcrPageSource, options: RecognizePdfPagesOptions): Promise<RecognizePdfPagesResult> {
  const pages = orderPages(source.pageCount, options.pages);
  const dpi = clampDpi(options.dpi);
  const maxPixels = Number.isFinite(options.maxPixels) ? Math.max(1, Math.min(OCR_MAX_PAGE_PIXELS, Math.floor(options.maxPixels!))) : OCR_MAX_PAGE_PIXELS;
  const budget = Number.isFinite(options.pageTimeoutMs) ? Math.max(1, options.pageTimeoutMs!) : OCR_PAGE_TIME_BUDGET_MS;
  const language = options.language ?? 'eng';
  const { signal } = options;
  const results: OcrPageResult[] = [];
  let engine: OcrEngine | null = null;
  let failures = 0;
  const cancelled = () => signal?.aborted === true;

  const getEngine = async (pageSignal: AbortSignal): Promise<OcrEngine> => {
    if (engine && !engine.disposed) return engine;
    engine = null;
    const created = await options.engine({ language, signal: pageSignal });
    if (pageSignal.aborted) { created.dispose(); throw new OcrError('ABORTED', 'Text recognition was cancelled.'); }
    engine = created;
    return engine;
  };

  try {
    for (let index = 0; index < pages.length; index++) {
      if (cancelled()) return { pages: results, cancelled: true };
      const page = pages[index];
      options.onPageStart?.(page, index, pages.length);
      const started = now();
      const finish = (result: Omit<OcrPageResult, 'ms' | 'page'>) => {
        const full: OcrPageResult = { page, ...result, ms: now() - started };
        results.push(full);
        options.onPage?.(full, index, pages.length);
      };
      // Metadata, rendering, asset loading, engine startup and recognition all share one deadline.
      const pageAbort = new AbortController();
      const deadline = started + budget;
      const timer = setTimeout(() => pageAbort.abort(), budget);
      const pageSignal = signal ? AbortSignal.any([signal, pageAbort.signal]) : pageAbort.signal;
      const check = () => { if (pageSignal.aborted) throw new OcrError(cancelled() ? 'ABORTED' : 'TIMEOUT', 'The page job was stopped.'); };
      let onAbort: () => void = () => {};
      const stopped = new Promise<never>((_, reject) => {
        onAbort = () => {
          (engine as OcrEngine | null)?.dispose();
          reject(new OcrError(cancelled() ? 'ABORTED' : 'TIMEOUT', 'The page job was stopped.'));
        };
        pageSignal.addEventListener('abort', onAbort, { once: true });
        if (pageSignal.aborted) onAbort();
      });
      try {
        const work = async (): Promise<Omit<OcrPageResult, 'ms' | 'page'>> => {
          check();
          if (!options.includePagesWithText && (await source.getTextItems(page)).length > 0) { check(); return { status: 'has-text', items: [], dpi: 0 }; }
          check();
          if (!options.includePagesWithoutImages && (await source.getPageImageCount(page)) === 0) { check(); return { status: 'no-image', items: [], dpi: 0 }; }
          check();
          const raster = await source.renderPageGray(page, { dpi, maxPixels, signal: pageSignal });
          check();
          if (!Number.isFinite(raster.scale) || raster.scale <= 0 || raster.image.width * raster.image.height > maxPixels) throw new OcrError('INVALID', 'The page raster exceeds its size budget.');
          const current = await getEngine(pageSignal);
          check();
          const remaining = Math.max(1, deadline - now());
          const upright = turnsOf(raster.rotation);
          const words = await current.recognize(raster.image, {
            dpi: raster.scale * 72, rotations: [upright, ((upright + 1) % 4) as QuarterTurn], pageSegmentation: OCR_PAGE_SEGMENTATION, timeoutMs: remaining, signal: pageSignal,
          });
          check();
          return { status: 'recognized', items: wordsToTextItems(words, raster.scale, page), dpi: Math.round(raster.scale * 72) };
        };
        const result = await Promise.race([work(), stopped]);
        failures = 0;
        finish(result);
      } catch (error) {
        if (cancelled()) return { pages: results, cancelled: true };
        if (isOcrError(error, 'UNAVAILABLE') && engine === null && !pageAbort.signal.aborted) throw error;
        (engine as OcrEngine | null)?.dispose();
        engine = null;
        failures++;
        if (failures >= MAX_CONSECUTIVE_ENGINE_FAILURES) throw new OcrError('UNAVAILABLE', 'Text recognition failed repeatedly.', { cause: error });
        const timedOut = isOcrError(error, 'TIMEOUT') || pageAbort.signal.aborted;
        finish({ status: timedOut ? 'timeout' : 'failed', items: [], dpi: 0, error: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(timer);
        pageSignal.removeEventListener('abort', onAbort);
      }
    }
    return { pages: results, cancelled: cancelled() };
  } finally {
    (engine as OcrEngine | null)?.dispose(); // the WebAssembly heap never shrinks: the worker goes when the job ends
  }
}

/** Library scan policy: inspect only the first two pages, without opening a document view. */
export function recognizeLibraryPdf(source: OcrPageSource, options: Omit<RecognizePdfPagesOptions, 'pages' | 'includePagesWithText' | 'includePagesWithoutImages'>): Promise<RecognizePdfPagesResult> {
  return recognizePdfPages(source, { ...options, pages: [1, 2], includePagesWithText: false, includePagesWithoutImages: false });
}
