import type { OutlineEntry, PdfErrorCode, PdfHandle, TextItem } from './document';
import type { FindOptions, Hit, RefCandidate, TextIndex } from './search';
import type { OcrEngineFactory, OcrLanguage } from '../ocr/contract';
import type { OcrResultCache } from '../ocr/cache';

/**
 * Contract of a PDF document session: ONE object per attached PDF, owned by the application shell (not by a
 * viewer), so the text index, outline and search survive tab switches and feed the unified search and the
 * cross-reference while the viewer is not mounted. Implemented by src/lib/pdf/session.ts, consumed by
 * src/components/PdfViewer.tsx and the workspace shell.
 *
 * `getSnapshot()` is `useSyncExternalStore`-compatible: it returns the SAME object until something changes.
 */
export type PdfSessionStatus = 'opening' | 'ready' | 'password-required' | 'invalid-password' | 'error' | 'closed';

export interface RefCandidateResult {
  candidates: RefCandidate[];
  /** true when the aggregate hit/work budget stopped the scan: the listed candidates are exact but incomplete. */
  truncated: boolean;
  totalHits: number;
}
export interface PdfSessionIndexState {
  state: 'idle' | 'building' | 'done' | 'truncated' | 'cancelled' | 'error';
  indexedPages: number;
  pageCount: number;
  items: number;
}
/**
 * Text recognition (OCR) of the pages that have no text layer. `unavailable`: no engine was configured for this session.
 * `idle`: nothing started (results restored from the cache still count in recognizedPages/words). `running`, then `done`,
 * `cancelled` or `error` for the last job. `revision` changes whenever the recognized text changes: searches and the board
 * cross-reference must run again.
 */
export interface PdfSessionOcrState {
  readonly state: 'unavailable' | 'idle' | 'running' | 'done' | 'cancelled' | 'error';
  /** Pages of the running or last job, how many of them are finished, and the page being recognized (0 when none). */
  readonly totalPages: number;
  readonly processedPages: number;
  readonly currentPage: number;
  /** Pages with recognized text and their words (every job of the session, plus the cache). */
  readonly recognizedPages: number;
  readonly words: number;
  /** Pages of the last job that failed or exceeded their time budget (they can be tried again). */
  readonly failedPages: number;
  readonly revision: number;
  /** `code: message` of the last job's failure (state `error`), else null. */
  readonly error: { code: string; message: string } | null;
}
/** `text`: the page has a text layer. `image-only`: no text, at least one image (recognition can help). `blank`: neither. */
export type PdfPageTextKind = 'text' | 'image-only' | 'blank';

export interface PdfSessionSnapshot {
  readonly status: PdfSessionStatus;
  readonly error: { code: PdfErrorCode | 'UNKNOWN'; message: string } | null;
  readonly pageCount: number;
  /** null until the first pages have been sampled; false = scan-only / image-only document with no text layer. */
  readonly searchable: boolean | null;
  readonly index: PdfSessionIndexState;
  readonly outline: readonly OutlineEntry[];
  readonly ocr: PdfSessionOcrState;
}
export interface PdfSession {
  readonly id: string;
  getSnapshot(): PdfSessionSnapshot;
  subscribe(listener: () => void): () => void;
  /** Retries opening an encrypted document; rejects with PdfError when the password is wrong. */
  submitPassword(password: string): Promise<void>;
  /** Live pdf.js handle for rendering; null unless status === 'ready'. */
  getHandle(): PdfHandle | null;
  /** Starts (once) bounded, cancellable text indexing and resolves with the index (possibly truncated). */
  ensureIndex(): Promise<TextIndex>;
  /** Substring search; builds the index first when needed. An aborted signal rejects with PdfError('ABORTED'). */
  find(query: string, options?: FindOptions & { signal?: AbortSignal }): Promise<Hit[]>;
  /**
   * Exact normalized-token matches of board references / net names (never partial); duplicates stay separate hits.
   * Bounded (B35): per reference AND in aggregate; `truncated` discloses that the budget stopped the scan.
   */
  refCandidates(refs: ReadonlySet<string>, nets: ReadonlySet<string>, options?: { signal?: AbortSignal; maxTotalHits?: number }): Promise<RefCandidateResult>;
  /** What a page holds (cached per page): drives the "Recognize text" offer. */
  inspectPage(page: number): Promise<PdfPageTextKind>;
  /**
   * Recognizes the pages that have no text layer but an image (default: the whole document; `firstPage` goes first). Pages already
   * recognized are skipped. Single-flight: a call while a job runs returns that job. Progress and results arrive through
   * `snapshot.ocr`; recognized words become part of `find` and `refCandidates` (links need OCR_LINK_MIN_CONFIDENCE).
   * Resolves when the job ends (also when it is cancelled); rejects only when no engine is configured or the session is closed.
   */
  recognizeText(options?: { pages?: readonly number[]; firstPage?: number }): Promise<void>;
  /** Stops the running recognition job; finished pages stay. */
  cancelRecognition(): void;
  /** Recognized words of a page (TextItem with source 'ocr'), or null when the page has not been recognized. */
  getRecognizedText(page: number): readonly TextItem[] | null;
  /** Cancels indexing, recognition and renders, destroys the pdf.js loading task and its worker. Idempotent. */
  dispose(): Promise<void>;
}
export interface CreatePdfSessionOptions {
  id: string;
  data: Uint8Array;
  password?: string;
  maxPages?: number;
  maxIndexItems?: number;
  /** Text recognition for pages without a text layer; without it `snapshot.ocr.state` is `unavailable`. */
  ocr?: PdfSessionOcrOptions;
}
export interface PdfSessionOcrOptions {
  engine: OcrEngineFactory;
  language?: OcrLanguage;
  /** Default: the application-wide in-memory cache. */
  cache?: OcrResultCache;
  dpi?: number;
  pageTimeoutMs?: number;
}
