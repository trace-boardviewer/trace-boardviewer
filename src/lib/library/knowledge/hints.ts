/**
 * Vendor, device-type and document-type hints from names and titles.
 *
 * A hint is a guess from words, never a fact: it says which lexicon entry matched, where (a span of the original text), and
 * how sure the match is (0..100). The Library keeps the hints with their source and decides later; "unknown" is a valid
 * answer and the absence of a hint is not an error.
 *
 * Matching rules (all linear: the text is cut into alphanumeric runs once and every run is looked at a constant number of
 * times; there is no regular expression over the text):
 *  - a run is lower-cased with the accents removed; runs longer than 64 units are skipped;
 *  - a phrase of two or three words matches when the words are separated by exactly one blank, "-", "_" or "."; the longest
 *    phrase at a position wins and the words it consumed are not looked at again;
 *  - a run followed by digits matches by its leading letters ("rtx3060" is "rtx", "macbookpro11" starts with "macbook");
 *  - product-line stems of seven letters or more also match as a start of a longer word ("macbookpro"); shorter lines only
 *    match whole words;
 *  - confidence: vendor name 90, ODM name 85, weak vendor word 55, product line 65; device word 80, weak 50, product line 65;
 *    document word 80, weak 45, strong extension 85, weak extension 35.
 *
 * The word lists are in `lexicon.ts` (CC0).
 */
import { DEVICES, DOCUMENTS, VENDORS, type DeviceEntry, type DeviceType, type DocumentEntry, type DocumentType, type VendorEntry } from './lexicon';
import { MAX_MATCHES, MAX_TEXT_LENGTH, MAX_TOKEN_LENGTH, isWordCode, lexiconKey, scanLength, tick, type WorkMeter } from './chars';

export interface HintOptions {
  /** Counts the characters examined (for tests). */
  meter?: WorkMeter;
}

export interface Hint<Id extends string> {
  id: Id;
  /** 0..100 */
  confidence: number;
  /** How the word matched: the entry's own name, a weak word, a product line or a file extension. */
  basis: 'name' | 'weak' | 'line' | 'extension' | 'weak-extension';
  /** The matched words in lexicon form (accents removed, lower case). */
  word: string;
  /** Span `[start, end)` of the match in the text. Absent for an extension hint. */
  start: number;
  end: number;
}

export type VendorHint = Hint<string> & { kind: VendorEntry['kind'] };
export type DeviceHint = Hint<DeviceType>;
export type DocumentHint = Hint<DocumentType>;

export interface HintSummary<Id extends string> {
  id: Id;
  /** The strongest hint of this id, plus 3 for each further hint (at most 10 in all). */
  confidence: number;
  count: number;
}

// --------------------------------------------------------------------------------------------------------------------
// Compiled lexicons
// --------------------------------------------------------------------------------------------------------------------

interface Compiled { id: string; confidence: number; basis: Hint<string>['basis']; kind?: VendorEntry['kind'] }
interface Lexicon { exact: Map<string, Compiled>; stems: Map<string, Compiled>; maxWords: number }

const PHRASE_SEPARATORS = /[\s\-_.]+/g;
const MIN_STEM = 7;
const MAX_STEM_PROBES = 6;

function phraseKey(entry: string): string {
  return lexiconKey(entry).replace(PHRASE_SEPARATORS, ' ').trim();
}

function compile(entries: ReadonlyArray<{ id: string; kind?: VendorEntry['kind']; groups: ReadonlyArray<[readonly string[] | undefined, number, Hint<string>['basis']]> }>): Lexicon {
  const exact = new Map<string, Compiled>(), stems = new Map<string, Compiled>();
  let maxWords = 1;
  for (const entry of entries) {
    for (const [words, confidence, basis] of entry.groups) {
      for (const word of words ?? []) {
        const key = phraseKey(word);
        if (key === '') continue;
        const value: Compiled = { id: entry.id, confidence, basis, kind: entry.kind };
        const known = exact.get(key);
        if (!known || known.confidence < confidence) exact.set(key, value);
        maxWords = Math.max(maxWords, key.split(' ').length);
        if (basis === 'line' && key.length >= MIN_STEM && !key.includes(' ')) stems.set(key, value);
      }
    }
  }
  return { exact, stems, maxWords: Math.min(maxWords, 3) };
}

const vendorLexicon = (): Lexicon => (vendorCompiled ??= compile(VENDORS.map(entry => ({
  id: entry.id, kind: entry.kind,
  groups: [[entry.words, entry.kind === 'odm' ? 85 : 90, 'name'], [entry.weak, 55, 'weak'], [entry.lines, 65, 'line']],
}))));
const deviceLexicon = (): Lexicon => (deviceCompiled ??= compile(DEVICES.map((entry: DeviceEntry) => ({
  id: entry.id, groups: [[entry.words, 80, 'name'], [entry.weak, 50, 'weak'], [entry.lines, 65, 'line']],
}))));
const documentLexicon = (): Lexicon => (documentCompiled ??= compile(DOCUMENTS.map((entry: DocumentEntry) => ({
  id: entry.id, groups: [[entry.words, 80, 'name'], [entry.weak, 45, 'weak']],
}))));
let vendorCompiled: Lexicon | undefined, deviceCompiled: Lexicon | undefined, documentCompiled: Lexicon | undefined;

// --------------------------------------------------------------------------------------------------------------------
// Words
// --------------------------------------------------------------------------------------------------------------------

interface Run { start: number; end: number; key: string; /** The key up to the first digit ("rtx" of "rtx3060"), or the key itself. */ letters: string }

const MAX_RUNS = 20_000;

/** The alphanumeric runs of the text with their keys, and for each run whether exactly one phrase separator joins it to the next. */
function runsOf(text: string, length: number, meter: WorkMeter | undefined): { runs: Run[]; joined: boolean[] } {
  const runs: Run[] = [], joined: boolean[] = [];
  let index = 0;
  while (index < length && runs.length < MAX_RUNS) {
    const code = text.charCodeAt(index);
    if (!isWordCode(code)) { index++; continue; }
    const start = index;
    while (index < length && isWordCode(text.charCodeAt(index))) index++;
    tick(meter, index - start + 1);
    if (index - start > MAX_TOKEN_LENGTH) continue;
    const raw = text.slice(start, index), key = lexiconKey(raw);
    let letters = key.length;
    for (let at = 0; at < key.length; at++) { const unit = key.charCodeAt(at); if (unit >= 48 && unit <= 57) { letters = at; break; } }
    if (runs.length > 0) {
      const previous = runs[runs.length - 1];
      const gap = start - previous.end;
      const separator = gap === 1 ? text.charCodeAt(previous.end) : -1;
      joined[runs.length - 1] = gap === 1 && (separator === 32 || separator === 45 || separator === 95 || separator === 46 || separator === 160);
    }
    runs.push({ start, end: index, key, letters: letters === key.length ? key : key.slice(0, letters) });
  }
  if (runs.length > 0) joined[runs.length - 1] = false;
  return { runs, joined };
}

function findHints<Id extends string>(text: unknown, lexicon: Lexicon, options: HintOptions | undefined): Array<Hint<Id> & { kind?: VendorEntry['kind'] }> {
  const length = scanLength(text);
  if (length === 0) return [];
  const source = text as string;
  const { runs, joined } = runsOf(source, length, options?.meter);
  const found: Array<Hint<Id> & { kind?: VendorEntry['kind'] }> = [];
  let index = 0;
  while (index < runs.length && found.length < MAX_MATCHES) {
    let hit: Compiled | undefined, used = 1, word = '';
    // Longest phrase first.
    for (let words = Math.min(lexicon.maxWords, runs.length - index); words >= 2 && !hit; words--) {
      let ok = true, key = runs[index].key;
      for (let step = 1; step < words; step++) {
        if (!joined[index + step - 1]) { ok = false; break; }
        key += ' ' + runs[index + step].key;
      }
      if (!ok) continue;
      const candidate = lexicon.exact.get(key);
      if (candidate) { hit = candidate; used = words; word = key; }
    }
    if (!hit) {
      const run = runs[index];
      hit = lexicon.exact.get(run.key);
      word = run.key;
      if (!hit && run.letters !== run.key) { hit = lexicon.exact.get(run.letters); word = run.letters; }
      if (!hit) {
        const top = Math.min(run.letters.length, MIN_STEM + MAX_STEM_PROBES - 1);
        for (let size = top; size >= MIN_STEM && !hit; size--) {
          const stem = lexicon.stems.get(run.letters.slice(0, size));
          if (stem) { hit = stem; word = run.letters.slice(0, size); }
        }
      }
    }
    if (hit) {
      found.push({ id: hit.id as Id, confidence: hit.confidence, basis: hit.basis, word, start: runs[index].start, end: runs[index + used - 1].end, kind: hit.kind });
    }
    index += used;
  }
  return found;
}

/** Vendors named in the text: the vendor's own names, weak two-letter names and product lines. */
export function vendorHints(text: string, options?: HintOptions): VendorHint[] {
  return findHints<string>(text, vendorLexicon(), options).map(hint => ({ ...hint, kind: hint.kind ?? 'brand' }));
}

/** Device types named in the text (laptop, phone, tablet, desktop board, GPU, console, monitor, PSU), in the eight interface languages. */
export function deviceTypeHints(text: string, options?: HintOptions): DeviceHint[] {
  return findHints<DeviceType>(text, deviceLexicon(), options).map(({ kind: _kind, ...hint }) => hint);
}

/** The extension of a file name without its dot, lower case, or '' (the part after the last dot of the last 16 units). */
export function extensionOf(name: string): string {
  if (typeof name !== 'string') return '';
  const end = Math.min(name.length, MAX_TEXT_LENGTH);
  const stop = Math.max(0, end - 17);
  for (let index = end - 1; index >= stop; index--) {
    const code = name.charCodeAt(index);
    if (code === 46) return index === end - 1 || index === 0 ? '' : name.slice(index + 1, end).toLowerCase();
    if (code === 47 || code === 92) return '';
  }
  return '';
}

const EXTENSION_HINTS: Map<string, { id: DocumentType; confidence: number; basis: 'extension' | 'weak-extension' }> = (() => {
  const map = new Map<string, { id: DocumentType; confidence: number; basis: 'extension' | 'weak-extension' }>();
  for (const entry of DOCUMENTS) {
    for (const extension of entry.extensions ?? []) map.set(extension, { id: entry.id, confidence: 85, basis: 'extension' });
  }
  for (const entry of DOCUMENTS) {
    for (const extension of entry.weakExtensions ?? []) if (!map.has(extension)) map.set(extension, { id: entry.id, confidence: 35, basis: 'weak-extension' });
  }
  return map;
})();

/** The document type an extension (with or without the dot, any case) suggests, or undefined. A `.pdf` suggests nothing. */
export function documentTypeForExtension(extension: string): DocumentHint | undefined {
  if (typeof extension !== 'string' || extension.length > 16) return undefined;
  const key = (extension.charCodeAt(0) === 46 ? extension.slice(1) : extension).toLowerCase();
  const entry = EXTENSION_HINTS.get(key);
  return entry ? { id: entry.id, confidence: entry.confidence, basis: entry.basis, word: key, start: 0, end: 0 } : undefined;
}

export interface DocumentHintOptions extends HintOptions {
  /** The file's extension, when the text is a file name without it; read from the text itself when omitted and the text ends in ".xxx". */
  extension?: string;
}

/** Document types named in the text, plus the one the extension suggests. */
export function documentTypeHints(text: string, options?: DocumentHintOptions): DocumentHint[] {
  const hints = findHints<DocumentType>(text, documentLexicon(), options).map(({ kind: _kind, ...hint }) => hint);
  const extension = options?.extension ?? extensionOf(text);
  const fromExtension = extension ? documentTypeForExtension(extension) : undefined;
  if (fromExtension) hints.push(fromExtension);
  return hints;
}

/** Groups hints by id: strongest confidence first, with a small bonus for repeated evidence. */
export function summarizeHints<Id extends string>(hints: ReadonlyArray<Hint<Id>>): Array<HintSummary<Id>> {
  const byId = new Map<Id, HintSummary<Id>>();
  for (const hint of hints) {
    const known = byId.get(hint.id);
    if (!known) byId.set(hint.id, { id: hint.id, confidence: hint.confidence, count: 1 });
    else { known.count++; known.confidence = Math.max(known.confidence, hint.confidence); }
  }
  const out = Array.from(byId.values());
  for (const summary of out) summary.confidence = Math.min(99, summary.confidence + Math.min(10, 3 * (summary.count - 1)));
  return out.sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The vendor lexicon entry for an id. */
export function vendorById(id: string): VendorEntry | undefined {
  return VENDORS.find(entry => entry.id === id);
}
