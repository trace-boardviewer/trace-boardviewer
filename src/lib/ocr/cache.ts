import { OCR_PIPELINE_VERSION } from './contract';
import type { OcrLanguage } from './contract';
import type { TextItem } from '../pdf/document';

/**
 * Recognized text per document, kept in memory for the application session: closing and reopening a document (or attaching the same
 * file twice) shows its recognized pages again without running the engine. The key is the document content (SHA-256 of the bytes),
 * the language, the resolution and OCR_PIPELINE_VERSION, so a changed file or a changed pipeline never reuses old words.
 * Bounded: least recently used documents are dropped first once the document or word limit is exceeded.
 * (A persistent cache in the profile's derived-data store is a later step; nothing here touches the disk.)
 */
export interface OcrCacheKey { document: string; language: OcrLanguage; dpi: number }
export const OCR_CACHE_DOCUMENTS = 16;
export const OCR_CACHE_WORDS = 1_000_000;

const keyOf = (key: OcrCacheKey) => `${key.document}|${key.language}|${Math.round(key.dpi)}|${OCR_PIPELINE_VERSION}`;

export class OcrResultCache {
  readonly #entries = new Map<string, Map<number, readonly TextItem[]>>();
  #words = 0;
  constructor(private readonly limits: { documents: number; words: number } = { documents: OCR_CACHE_DOCUMENTS, words: OCR_CACHE_WORDS }) {}

  /** Recognized pages of a document (page -> items, possibly empty for a page without readable text), refreshing its recency. */
  get(key: OcrCacheKey): ReadonlyMap<number, readonly TextItem[]> | undefined {
    const id = keyOf(key);
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    this.#entries.delete(id); this.#entries.set(id, entry);
    return entry;
  }

  put(key: OcrCacheKey, page: number, items: readonly TextItem[]): void {
    const id = keyOf(key);
    let entry = this.#entries.get(id);
    if (entry) this.#entries.delete(id); else entry = new Map();
    this.#entries.set(id, entry);
    this.#words -= entry.get(page)?.length ?? 0;
    entry.set(page, Object.freeze([...items]));
    this.#words += items.length;
    this.#evict();
  }

  get size(): number { return this.#entries.size; }
  get words(): number { return this.#words; }
  clear(): void { this.#entries.clear(); this.#words = 0; }

  #evict(): void {
    for (const [id, entry] of this.#entries) {
      if (this.#entries.size <= this.limits.documents && this.#words <= this.limits.words) return;
      for (const items of entry.values()) this.#words -= items.length;
      this.#entries.delete(id);
    }
  }
}

/** The application-wide cache (one per renderer). */
export const sharedOcrCache = new OcrResultCache();

/** SHA-256 hex of document bytes (Web Crypto; available in the renderer, in workers and in Node). */
export async function documentDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
