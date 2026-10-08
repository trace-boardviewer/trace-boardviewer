/**
 * From recognition results to the Library's model: sourced identifiers and part-term keys.
 *
 * The scanner (stage "name") and the indexer (title blocks, headers, outlines, OCR) call these functions to turn a text and the
 * place it came from into `Identifier` rows of the Library model (`../model`), ready for a summary: board numbers and model
 * numbers, revisions, vendors and device types, each with its source, confidence, page and pattern. The output passes the
 * contract validators of `../validate`: raw and normalised texts are 1 to 256 characters without control characters, patterns
 * are ids, confidence is an integer from 0 to 100, at most `MAX_IDENTIFIERS` rows.
 *
 * Document-type hints are not identifiers (they suggest a file role); use `documentTypeHints` for them.
 */
import type { Identifier, MetadataSource } from '../model';
import type { RecognitionScope, WorkMeter } from './chars';
import { recognizeBoardNumbers } from './board-numbers';
import { deviceTypeHints, summarizeHints, vendorHints, type Hint } from './hints';
import { boardNumberShape } from './board-number-shapes';
import { analyzePath, type PathOptions } from './names';
import { normalizePartNumber } from './part-numbers';
import { parseRevisions } from './revision';

export type IdentifierSource = Exclude<MetadataSource, 'user'>;
export const MAX_IDENTIFIERS = 256;
const MAX_PAGE = 2000;

export interface IdentifierOptions {
  /** The page of a PDF the text comes from (1 to 2000). */
  page?: number;
  /** Which shapes may be read; defaults to the source. Pass 'body' for running text that is not a title block. */
  scope?: RecognitionScope;
  meter?: WorkMeter;
}

const KIND_ORDER: Readonly<Record<Identifier['kind'], number>> = { 'board-number': 0, model: 1, revision: 2, vendor: 3, 'device-type': 4, title: 5 };

/** A raw text for the model: control characters become blanks, the ends are trimmed, 256 characters at most. */
export function cleanRaw(raw: string): string {
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.length > 256 ? text.slice(0, 256) : text;
}

function pageOf(options: IdentifierOptions | undefined): number | undefined {
  const page = options?.page;
  return page !== undefined && Number.isSafeInteger(page) && page >= 1 && page <= MAX_PAGE ? page : undefined;
}

/** Keeps the most confident row per kind, norm, source and page; strongest first; at most MAX_IDENTIFIERS. */
function finish(rows: Identifier[]): Identifier[] {
  const best = new Map<string, Identifier>();
  for (const row of rows) {
    if (row.raw.length === 0 || row.norm.length === 0) continue;
    const key = `${row.kind}\u0000${row.norm}\u0000${row.source}\u0000${row.page ?? ''}`;
    const known = best.get(key);
    if (!known || known.confidence < row.confidence) best.set(key, row);
  }
  return Array.from(best.values())
    .sort((a, b) => b.confidence - a.confidence || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0))
    .slice(0, MAX_IDENTIFIERS);
}

function hintRows(hints: ReadonlyArray<Hint<string>>, rawOf: (hint: Hint<string>) => string, kind: 'vendor' | 'device-type', source: IdentifierSource, page: number | undefined): Identifier[] {
  const first = new Map<string, Hint<string>>();
  for (const hint of hints) if (!first.has(hint.id)) first.set(hint.id, hint);
  return summarizeHints(hints).map(summary => ({
    kind, raw: cleanRaw(rawOf(first.get(summary.id)!)) || summary.id, norm: summary.id, source, confidence: summary.confidence, ...(page !== undefined ? { page } : {}),
  }));
}

/**
 * The identifiers a text carries: board numbers and model numbers, revisions, vendors and device types. `source` is where the
 * text comes from and, unless `options.scope` says otherwise, decides which shapes may be read.
 */
export function textIdentifiers(text: string, source: IdentifierSource, options: IdentifierOptions = {}): Identifier[] {
  if (typeof text !== 'string') return [];
  const page = pageOf(options);
  const scope = options.scope ?? source;
  const meter = options.meter;
  const rows: Identifier[] = [];
  for (const match of recognizeBoardNumbers(text, { scope, meter })) {
    const kind = boardNumberShape(match.shape)?.identifies ?? 'board-number';
    rows.push({ kind, raw: cleanRaw(match.raw) || match.normalized, norm: match.normalized, source, confidence: match.confidence, pattern: match.shape, ...(page !== undefined ? { page } : {}) });
  }
  for (const revision of parseRevisions(text, { scope, meter })) {
    rows.push({ kind: 'revision', raw: cleanRaw(revision.raw) || revision.normalized, norm: revision.normalized, source, confidence: revision.confidence, pattern: revision.scheme, ...(page !== undefined ? { page } : {}) });
  }
  const slice = (hint: Hint<string>): string => text.slice(hint.start, hint.end);
  rows.push(...hintRows(vendorHints(text, { meter }), slice, 'vendor', source, page));
  rows.push(...hintRows(deviceTypeHints(text, { meter }), slice, 'device-type', source, page));
  return finish(rows);
}

/** The identifiers the folders, the archive name and the file name of a relative path carry (stage "name"). */
export function pathIdentifiers(path: string, options: PathOptions = {}): Identifier[] {
  const analysis = analyzePath(path, options);
  const rows: Identifier[] = [];
  for (const { value, source } of analysis.boardNumbers) {
    const kind = boardNumberShape(value.shape)?.identifies ?? 'board-number';
    rows.push({ kind, raw: cleanRaw(value.raw) || value.normalized, norm: value.normalized, source, confidence: value.confidence, pattern: value.shape });
  }
  for (const { value, source } of analysis.revisions) {
    rows.push({ kind: 'revision', raw: cleanRaw(value.raw) || value.normalized, norm: value.normalized, source, confidence: value.confidence, pattern: value.scheme });
  }
  for (const [items, kind] of [[analysis.vendors, 'vendor'], [analysis.devices, 'device-type']] as const) {
    const bySource = new Map<IdentifierSource, Array<Hint<string>>>();
    for (const { value, source } of items) bySource.set(source, [...(bySource.get(source) ?? []), value]);
    for (const [source, hints] of bySource) rows.push(...hintRows(hints, hint => hint.word, kind, source, undefined));
  }
  return finish(rows);
}

/** The fields of a part term of the model for a part-number text: exact form, base, family and category. Null when the text is not a part number. */
export function partTermKeys(text: string, options: { meter?: WorkMeter } = {}): { norm: string; base?: string; family?: string; category?: string } | null {
  const keys = normalizePartNumber(text, options);
  if (!keys) return null;
  return { norm: keys.exact, ...(keys.base !== undefined ? { base: keys.base } : {}), ...(keys.family !== undefined ? { family: keys.family } : {}), ...(keys.category !== undefined ? { category: keys.category } : {}) };
}
