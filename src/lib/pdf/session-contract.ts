import type { OutlineEntry, PdfErrorCode, PdfHandle } from './document';
import type { FindOptions, Hit, RefCandidate, TextIndex } from './search';

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
export interface PdfSessionSnapshot {
  readonly status: PdfSessionStatus;
  readonly error: { code: PdfErrorCode | 'UNKNOWN'; message: string } | null;
  readonly pageCount: number;
  /** null until the first pages have been sampled; false = scan-only / image-only document with no text layer. */
  readonly searchable: boolean | null;
  readonly index: PdfSessionIndexState;
  readonly outline: readonly OutlineEntry[];
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
  /** Cancels indexing and renders, destroys the pdf.js loading task and its worker. Idempotent. */
  dispose(): Promise<void>;
}
export interface CreatePdfSessionOptions {
  id: string;
  data: Uint8Array;
  password?: string;
  maxPages?: number;
  maxIndexItems?: number;
}
