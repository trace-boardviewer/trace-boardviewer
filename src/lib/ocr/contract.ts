/**
 * Text recognition (OCR) contract. The engine is Tesseract 5 compiled to WebAssembly (tesseract.js-core), run in a dedicated
 * worker (src/lib/ocr/ocr.worker.ts) that does no I/O of its own: the renderer hands it the bundled engine and language bytes and
 * the page pixels. Nothing is ever downloaded.
 *
 * Entry points:
 * - `OcrEngineFactory` (src/lib/ocr/engine.ts `bundledOcrEngine`): one worker, one language; `recognize` one greyscale image.
 * - `recognizePdfPages` (src/lib/ocr/pdf-pages.ts): the background job over pages of a PDF handle, with cancellation, a time and a
 *   pixel budget per page and progress. It depends on no view, so a viewer, a session or a library indexer can all run it.
 *
 * Recognized words stay marked as such everywhere (`TextItem.source === 'ocr'` plus `confidence`): search finds them, and a word
 * becomes a board link only on an exact reference/net match AND a confidence of at least OCR_LINK_MIN_CONFIDENCE.
 */
export type OcrLanguage = 'eng';
/** Quarter turns clockwise (0, 90, 180, 270 degrees). */
export type QuarterTurn = 0 | 1 | 2 | 3;

export const OCR_ENGINE_NAME = 'Tesseract 5.1.0 (tesseract.js-core 7.0.0, LSTM)';
/**
 * Version of everything that changes the recognized words for the same page: engine build, language data, resolution, page
 * segmentation, passes and filters. Part of every cache key; bump it with any such change.
 */
export const OCR_PIPELINE_VERSION = 1;

/** Measured (evidence/ocr/spike.md): 300 dpi is the knee; 200 is page dependent, 150 loses 5 pt schematic text. */
export const OCR_DEFAULT_DPI = 300;
export const OCR_MIN_DPI = 100;
export const OCR_MAX_DPI = 400;
/** Pixel budget of one page raster; a larger page is rendered at a lower resolution (A3 at 300 dpi is 17.4 MP). */
export const OCR_MAX_PAGE_PIXELS = 40_000_000;
/** Time budget of one page (both passes). A page over budget is reported as `timeout`; the job continues with the next page. */
export const OCR_PAGE_TIME_BUDGET_MS = 120_000;
/** Tesseract page segmentation mode 11, "sparse text": labels scattered over a drawing (12 points above automatic layout). */
export const OCR_PAGE_SEGMENTATION = 11;
/** Words below this confidence are dropped as noise (they are almost always rotated text read in the wrong pass). */
export const OCR_MIN_WORD_CONFIDENCE = 20;
/**
 * A recognized word links to the board only at this confidence or above (0-100). Measured: every wrong board-name hit had at
 * most 48, and precision was 1.0 at 50 and above on all four benchmark pages; 60 keeps a margin.
 */
export const OCR_LINK_MIN_CONFIDENCE = 60;
export const OCR_MAX_WORDS_PER_PAGE = 20_000;
export const OCR_MAX_WORD_LENGTH = 128;

/** 8-bit luminance, row-major, `data.length === width * height`. */
export interface GrayImage { width: number; height: number; data: Uint8Array }

/** A word in pixel coordinates of the image handed in (already mapped back from a rotated pass). */
export interface OcrWord {
  text: string;
  x: number; y: number; width: number; height: number;
  /** 0-100 as reported by Tesseract. */
  confidence: number;
  /** The pass that read the word: 1 = the image turned 90 degrees clockwise (text that reads bottom to top on the page). */
  rotation: QuarterTurn;
}

export interface OcrRecognizeOptions {
  /** Resolution the image was rendered at (Tesseract uses it to judge text size). */
  dpi: number;
  /** Passes to run; the words of all passes are merged (an overlapping word keeps the more confident reading). Default [0, 1]. */
  rotations?: readonly QuarterTurn[];
  /** Tesseract page segmentation mode; default OCR_PAGE_SEGMENTATION. */
  pageSegmentation?: number;
  /** Hard time limit; on expiry the engine is stopped (its worker terminated) and the call rejects with TIMEOUT. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OcrEngine {
  readonly language: OcrLanguage;
  /** One call at a time per engine (calls queue). A TIMEOUT or ABORTED rejection disposes the engine: create a new one. */
  recognize(image: GrayImage, options: OcrRecognizeOptions): Promise<OcrWord[]>;
  readonly disposed: boolean;
  /** Stops the engine and frees its memory (terminates the worker). Idempotent. */
  dispose(): void;
}
export interface OcrEngineOptions { language: OcrLanguage; signal?: AbortSignal }
export type OcrEngineFactory = (options: OcrEngineOptions) => Promise<OcrEngine>;

/**
 * ABORTED: cancelled by the caller. TIMEOUT: a page exceeded its time budget. UNAVAILABLE: the engine cannot start in this
 * environment (for example WebAssembly blocked by a content security policy, or no bundled data for the language).
 * FAILED: the engine reported an error for this input. INVALID: the request itself was malformed.
 */
export type OcrErrorCode = 'ABORTED' | 'TIMEOUT' | 'UNAVAILABLE' | 'FAILED' | 'INVALID';
export class OcrError extends Error {
  readonly code: OcrErrorCode;
  constructor(code: OcrErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OcrError';
    this.code = code;
  }
}
/** Also recognizes an OcrError that crossed a realm (worker message, test module boundary) by its name. */
export function isOcrError(error: unknown, code?: OcrErrorCode): error is OcrError {
  const named = error instanceof OcrError || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'OcrError');
  return named && (code === undefined || (error as { code?: unknown }).code === code);
}
