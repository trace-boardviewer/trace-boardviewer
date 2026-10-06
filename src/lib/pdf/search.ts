import { PdfError } from './document';
import type { PdfHandle, TextItem } from './document';

/**
 * Text search and board cross-reference candidates over a PDF's text items.
 *
 * Normalization rules (`normalizeToken`): Unicode NFKC, trim, strip surrounding brackets and sentence
 * punctuation ( ) [ ] { } < > . , ; : ! ? " ' ` * (leading and trailing only), collapse internal
 * whitespace to one space, uppercase. Characters that are part of electrical names stay: + - _ / # ~ % & @ $.
 * Examples: "(PU301)" -> "PU301", "gnd," -> "GND", "see PU301." -> "SEE PU301", "+3.3V" -> "+3.3V" (not "3.3V"),
 * "~RESET" -> "~RESET". `extractRefCandidatesBounded` splits each text item on whitespace and the separators
 * , ; : ( ) [ ] { } < > " ' | = and compares normalized tokens for EQUALITY only: "PU301" matches PU301,
 * never PU3011 or PU30; "GND" matches only as a whole token. A token containing "/" is also tried
 * split at the slashes ("D+/D-" yields D+/D-, D+ and D-). Every occurrence becomes a separate hit, so
 * duplicates are visible to the UI, which must ask the user instead of linking silently.
 *
 * Resource budget (B35): the cross-reference scan is bounded per reference (MAX_CANDIDATE_HITS), in aggregate
 * (MAX_TOTAL_CANDIDATE_HITS recorded hits) and in work (MAX_CANDIDATE_WORK units: items, their length and tokens examined). Items are
 * scanned in index order, so a budget stop returns EXACTLY the hits a full scan would list up to that point and
 * discloses the cut (`truncated`, `limit`, `scannedItems`); nothing past the budget is ever allocated.
 */
export interface TextIndex {
  readonly pageCount: number;
  /** All items in page order. `Hit.itemIndex` indexes this array. */
  readonly items: readonly TextItem[];
  /** `pageStarts[p - 1] .. pageStarts[p] - 1` are the item indices of page p (length pageCount + 1). */
  readonly pageStarts: readonly number[];
  /** Pages processed in order (equals pageCount unless the item bound stopped indexing). */
  readonly indexedPages: number;
  /** true when the item bound stopped indexing or a page could not be read: the index is exact but incomplete. */
  readonly truncated: boolean;
  /** Pages whose text could not be read (they contribute no items and make the index `truncated`). */
  readonly failedPages?: number;
}
export interface Hit {
  page: number; itemIndex: number; x: number; y: number; width: number; height: number; context: string;
  /**
   * The LITERAL text that matched, exactly as written in the PDF item (before normalization: "r1" for a board "R1"), capped at
   * MAX_HIT_TOKEN_LENGTH characters. Candidate hits: the matched token (for "D+/D-" parts: the part). Search hits: the matched
   * substring; absent when upper-casing changed the item's length (e.g. "ß" -> "SS"), because the offset is then not reliable.
   */
  token?: string;
}
export interface FindOptions { caseSensitive?: boolean; wholeWord?: boolean; maxHits?: number }
export interface RefCandidate { kind: 'ref' | 'net'; name: string; hits: Hit[] }
export interface BuildTextIndexOptions {
  signal?: AbortSignal;
  /** Called after each page; `items` is the running item count. */
  onProgress?(indexedPages: number, pageCount: number, items: number): void;
  maxItems?: number;
}
/** `reason` of a cut scan: aggregate hit budget, work budget, a single reference above its cap, or an incomplete index. */
export type RefScanLimit = 'total-hits' | 'work' | 'per-reference' | 'index';
export interface RefScanOptions {
  signal?: AbortSignal;
  /** Aggregate budget of recorded hits across all references (default MAX_TOTAL_CANDIDATE_HITS). */
  maxTotalHits?: number;
  /** Budget of work units, see MAX_CANDIDATE_WORK (default MAX_CANDIDATE_WORK). */
  maxWork?: number;
  /** Cap per reference or net (default MAX_CANDIDATE_HITS). */
  maxHitsPerReference?: number;
}
export interface RefCandidateScan {
  candidates: RefCandidate[];
  /** true when anything is missing from `candidates`: a budget stop, a capped reference or an incomplete index. */
  truncated: boolean;
  /** Hits recorded across `candidates`. */
  totalHits: number;
  /** Items scanned completely, in index order. */
  scannedItems: number;
  /** Why `truncated` is set; a scan-stopping budget outranks a per-reference cap, which outranks an incomplete index. */
  limit: RefScanLimit | null;
}

export const MAX_INDEX_ITEMS = 2_000_000;
export const MAX_FIND_HITS = 10_000;
/** Cap per reference or net name. */
export const MAX_CANDIDATE_HITS = 2000;
/** Aggregate cap of recorded hits (a recorded hit is ~0.25 KB, so this is a ~12 MB ceiling); exact 128x128 controls (16384 hits) fit. */
export const MAX_TOTAL_CANDIDATE_HITS = 50_000;
/** Work units: 1 per item (+1 per 64 characters) and 1 per token examined (~1 s per 1-2 million units); 20 million covers an index of MAX_INDEX_ITEMS at ~10 tokens per item. */
export const MAX_CANDIDATE_WORK = 20_000_000;
export const MAX_HIT_TOKEN_LENGTH = 128;
const CONTEXT_LENGTH = 160;
const capToken = (value: string) => (value.length > MAX_HIT_TOKEN_LENGTH ? value.slice(0, MAX_HIT_TOKEN_LENGTH) : value);
/** Work units between cooperative checkpoints (abort check, chance to yield to the event loop): at least every 4096 items, even when no item contains a token. */
const CHECKPOINT_WORK = 4096;

const aborted = (message: string) => new PdfError('ABORTED', message);

export async function buildTextIndex(handle: PdfHandle, options: BuildTextIndexOptions = {}): Promise<TextIndex> {
  const maxItems = options.maxItems ?? MAX_INDEX_ITEMS;
  const { signal } = options;
  const items: TextItem[] = [];
  const pageStarts: number[] = [0];
  let itemBound = false, indexedPages = 0, failedPages = 0;
  for (let page = 1; page <= handle.pageCount; page++) {
    if (signal?.aborted) throw aborted('Text indexing was cancelled.');
    let pageItems: readonly TextItem[];
    try {
      pageItems = await handle.getTextItems(page);
    } catch (error) {
      if (signal?.aborted) throw aborted('Text indexing was cancelled.');
      if (error instanceof PdfError) throw error;
      pageItems = []; failedPages++; // one unreadable page must not hide the text of the others; it is disclosed through `truncated`
    }
    if (signal?.aborted) throw aborted('Text indexing was cancelled.');
    const room = maxItems - items.length;
    if (pageItems.length > room) { itemBound = true; for (let i = 0; i < room; i++) items.push(pageItems[i]); }
    else for (const item of pageItems) items.push(item);
    indexedPages = page;
    pageStarts.push(items.length);
    options.onProgress?.(page, handle.pageCount, items.length);
    if (itemBound) break;
  }
  while (pageStarts.length < handle.pageCount + 1) pageStarts.push(items.length);
  return { pageCount: handle.pageCount, items, pageStarts, indexedPages, truncated: itemBound || failedPages > 0, ...(failedPages ? { failedPages } : {}) };
}

const wordChar = /[\p{L}\p{N}_]/u;
const isBoundary = (text: string, index: number) => index < 0 || index >= text.length || !wordChar.test(text[index]);

function context(text: string, start: number, length: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= CONTEXT_LENGTH) return trimmed;
  const from = Math.max(0, Math.min(start - Math.floor((CONTEXT_LENGTH - length) / 2), text.length - CONTEXT_LENGTH));
  return `${from > 0 ? '…' : ''}${text.slice(from, from + CONTEXT_LENGTH).trim()}${from + CONTEXT_LENGTH < text.length ? '…' : ''}`;
}

/** Approximate box of characters [start, start + length) of an item, split proportionally along its width. */
function partialBox(item: TextItem, start: number, length: number, total: number): Pick<Hit, 'x' | 'y' | 'width' | 'height'> {
  if (total <= 0 || length >= total) return { x: item.x, y: item.y, width: item.width, height: item.height };
  const from = Math.max(0, Math.min(1, start / total)), to = Math.max(from, Math.min(1, (start + length) / total));
  return { x: item.x + item.width * from, y: item.y, width: Math.max(1, item.width * (to - from)), height: item.height };
}

/**
 * Long scans are written as generators that `yield` every CHECKPOINT_WORK units: the synchronous entry points
 * run them to completion, `driveCooperatively` interleaves them with the event loop and checks the signal.
 */
type Steps<T> = Generator<void, T, void>;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return typeof scheduler?.yield === 'function' ? scheduler.yield() : new Promise(resolve => setTimeout(resolve, 0));
}
function runToEnd<T>(steps: Steps<T>): T {
  for (;;) { const next = steps.next(); if (next.done) return next.value; }
}
async function driveCooperatively<T>(steps: Steps<T>, signal: AbortSignal | undefined, message: string, sliceMs = 8): Promise<T> {
  let sliceStart = now();
  for (;;) {
    if (signal?.aborted) { steps.return(undefined as never); throw aborted(message); }
    const next = steps.next();
    if (next.done) return next.value;
    if (now() - sliceStart >= sliceMs) { await yieldToEventLoop(); sliceStart = now(); }
  }
}

function* findSteps(index: TextIndex, query: string, options: FindOptions, signal?: AbortSignal): Steps<Hit[]> {
  const needle = options.caseSensitive ? query : query.toUpperCase();
  const maxHits = options.maxHits ?? MAX_FIND_HITS;
  const hits: Hit[] = [];
  if (!needle.trim()) return hits;
  let work = 0, nextCheckpoint = CHECKPOINT_WORK;
  for (let i = 0; i < index.items.length; i++) {
    const item = index.items[i];
    const haystack = options.caseSensitive ? item.str : item.str.toUpperCase();
    work += 1 + (haystack.length >> 6);
    if (work >= nextCheckpoint) {
      nextCheckpoint = work + CHECKPOINT_WORK;
      yield;
      if (signal?.aborted) throw aborted('The search was cancelled.');
    }
    let from = 0, position: number;
    while ((position = haystack.indexOf(needle, from)) !== -1) {
      from = position + 1;
      if (options.wholeWord && (!isBoundary(haystack, position - 1) || !isBoundary(haystack, position + needle.length))) continue;
      hits.push({
        page: item.page, itemIndex: i, ...partialBox(item, position, needle.length, haystack.length), context: context(item.str, position, needle.length),
        ...(haystack.length === item.str.length ? { token: capToken(item.str.slice(position, position + needle.length)) } : {}),
      });
      if (hits.length >= maxHits) return hits;
      from = position + needle.length;
    }
  }
  return hits;
}

/** Substring search over every item (a match never spans two items). Case-insensitive unless asked otherwise. */
export function findText(index: TextIndex, query: string, options: FindOptions = {}): Hit[] {
  return runToEnd(findSteps(index, query, options));
}

/** Same results as `findText`, but yields to the event loop between slices and rejects with ABORTED when `signal` fires. */
export function findTextAsync(index: TextIndex, query: string, options: FindOptions & { signal?: AbortSignal } = {}): Promise<Hit[]> {
  const { signal, ...findOptions } = options;
  return driveCooperatively(findSteps(index, query, findOptions, signal), signal, 'The search was cancelled.');
}

const edgeCharacter = /[\s()[\]{}<>.,;:!?"'`*]/;
const plainAscii = /^[\x21-\x7e]+$/;
const edgeCharacters = '()[]{}<>.,;:!?"\'`*';

/**
 * Drops the leading and the trailing run of edge characters (whitespace and ( ) [ ] { } < > . , ; : ! ? " ' ` *).
 * One pass from each end: an end-anchored `[...]+$` pattern retries every position of a long run in the middle of a
 * text, which is quadratic (8.6 s for 80,000 characters).
 */
function stripEdges(value: string): string {
  let start = 0, end = value.length;
  while (start < end && edgeCharacter.test(value[start])) start++;
  while (end > start && edgeCharacter.test(value[end - 1])) end--;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

export function normalizeToken(value: string): string {
  // Fast path (the overwhelming majority of tokens): printable ASCII without whitespace or edge punctuation
  // is invariant under NFKC, trimming and edge stripping, so only the case fold remains.
  if (value.length > 0 && plainAscii.test(value) && !edgeCharacters.includes(value[0]) && !edgeCharacters.includes(value[value.length - 1])) return value.toUpperCase();
  return stripEdges(value.normalize('NFKC').trim()).replace(/\s+/g, ' ').toUpperCase();
}

const tokenPattern = /[^\s,;:()[\]{}<>"'|=]+/g;

function* tokens(text: string): Generator<{ token: string; start: number }> {
  // matchAll iterates a private clone of the pattern: interleaved scans (cooperative yielding) cannot corrupt each other's lastIndex.
  for (const match of text.matchAll(tokenPattern)) {
    const start = match.index ?? 0;
    yield { token: match[0], start };
    if (match[0].includes('/') && match[0].length > 1) {
      let offset = start;
      for (const part of match[0].split('/')) {
        if (part) yield { token: part, start: offset };
        offset += part.length + 1;
      }
    }
  }
}

const budget = (value: number | undefined, fallback: number) => (value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value)));

function* refScanSteps(index: TextIndex, refs: ReadonlySet<string>, nets: ReadonlySet<string>, options: RefScanOptions): Steps<RefCandidateScan> {
  const { signal } = options;
  const maxTotal = budget(options.maxTotalHits, MAX_TOTAL_CANDIDATE_HITS);
  const maxWork = budget(options.maxWork, MAX_CANDIDATE_WORK);
  const maxPerReference = budget(options.maxHitsPerReference, MAX_CANDIDATE_HITS);
  const lookup = new Map<string, RefCandidate[]>();
  const groups: RefCandidate[] = [];
  const register = (kind: RefCandidate['kind'], names: ReadonlySet<string>) => {
    for (const name of names) {
      const key = normalizeToken(name);
      if (!key) continue;
      const group: RefCandidate = { kind, name, hits: [] };
      groups.push(group);
      const list = lookup.get(key);
      if (list) list.push(group); else lookup.set(key, [group]);
    }
  };
  register('ref', refs);
  register('net', nets);
  if (!lookup.size) return { candidates: [], truncated: false, totalHits: 0, scannedItems: 0, limit: null }; // nothing was asked for, so nothing is missing

  let total = 0, work = 0, scannedItems = 0, nextCheckpoint = CHECKPOINT_WORK;
  let stop: 'total-hits' | 'work' | null = null, capped = false;
  scan: for (let i = 0; i < index.items.length; i++) {
    if (signal?.aborted) throw aborted('The reference scan was cancelled.');
    if (work >= maxWork) { stop = 'work'; break; }
    const item = index.items[i];
    work += 1 + (item.str.length >> 6); // an item costs even when it has no token (punctuation-only text), so the scan is always bounded and interruptible
    if (work >= nextCheckpoint) {
      nextCheckpoint = work + CHECKPOINT_WORK;
      yield;
      if (signal?.aborted) throw aborted('The reference scan was cancelled.');
    }
    for (const { token, start } of tokens(item.str)) {
      if (work >= maxWork) { stop = 'work'; break scan; }
      work++;
      const matches = lookup.get(normalizeToken(token));
      if (matches) {
        for (const group of matches) {
          if (group.hits.length >= maxPerReference) { capped = true; continue; }
          if (total >= maxTotal) { stop = 'total-hits'; break scan; } // checked BEFORE building the hit: nothing past the budget is allocated
          group.hits.push({ page: item.page, itemIndex: i, ...partialBox(item, start, token.length, item.str.length), context: context(item.str, start, token.length), token: capToken(token) });
          total++;
        }
      }
      if (work >= nextCheckpoint) {
        nextCheckpoint = work + CHECKPOINT_WORK;
        yield;
        if (signal?.aborted) throw aborted('The reference scan was cancelled.');
      }
    }
    scannedItems = i + 1;
  }
  const limit: RefScanLimit | null = stop ?? (capped ? 'per-reference' : index.truncated ? 'index' : null);
  return { candidates: groups.filter(group => group.hits.length > 0), truncated: limit !== null, totalHits: total, scannedItems, limit };
}

/**
 * Exact normalized-token matches of reference designators / net names within the budgets above (never partial).
 * Synchronous: a pre-aborted signal or one aborted by a callback rejects with ABORTED; prefer
 * `extractRefCandidatesAsync` for large indexes so the UI thread keeps breathing.
 */
export function extractRefCandidatesBounded(index: TextIndex, refs: ReadonlySet<string>, nets: ReadonlySet<string>, options: RefScanOptions = {}): RefCandidateScan {
  return runToEnd(refScanSteps(index, refs, nets, options));
}

/** `extractRefCandidatesBounded` that yields to the event loop between slices and stops promptly when `signal` fires (ABORTED). */
export function extractRefCandidatesAsync(index: TextIndex, refs: ReadonlySet<string>, nets: ReadonlySet<string>, options: RefScanOptions = {}): Promise<RefCandidateScan> {
  return driveCooperatively(refScanSteps(index, refs, nets, options), options.signal, 'The reference scan was cancelled.');
}

/** Candidates only, with the default budgets; the truncation disclosure is dropped. Use `extractRefCandidatesBounded` to get it. */
export function extractRefCandidates(index: TextIndex, refs: ReadonlySet<string>, nets: ReadonlySet<string>): RefCandidate[] {
  return extractRefCandidatesBounded(index, refs, nets).candidates;
}
