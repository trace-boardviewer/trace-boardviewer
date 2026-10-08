/**
 * Normalization and ordering of board and schematic names, shared by the board index (board-index.ts) and the cross-probe
 * (crossprobe.ts, which re-exports them). Pure, no DOM: runs in the UI thread, in a worker and in node.
 */

let collator: Intl.Collator | undefined;
/** One cached collator for every natural ordering of board data (P02); 'en' is DATA_LOCALE, so data is ordered alike in every UI language. */
export const naturalCollator = (): Intl.Collator => (collator ??= new Intl.Collator('en', { numeric: true }));

/** Natural order ("R2" < "R10") through the cached collator, with a code-unit tie-break so that the order is total. */
export function naturalCompare(a: string, b: string): number {
  return naturalCollator().compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** The identity key of a reference, pin number or net name: NFKC and trim, case preserved. */
export const normalizeKey = (value: string): string => value.normalize('NFKC').trim();
/** Lowercase form used for case-insensitive lookups and search. */
export const fold = (value: string): string => value.toLowerCase();
/** Query/haystack form for search: NFKC, invisible zero-width characters dropped (IME / paste debris), whitespace runs collapsed to one space, trimmed. */
export const normalizeQuery = (value: string): string => value.normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/gu, '').replace(/\s+/gu, ' ').trim();
