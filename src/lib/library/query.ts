import type { FileRole, FileState, LibraryKind } from './model';
export const QUERY_MODES = ['boards', 'files', 'duplicates', 'problems', 'unsorted'] as const;
export const QUERY_SORTS = ['relevance', 'label', 'board-number', 'vendor', 'recent', 'documents', 'completeness'] as const;
export type QueryField = 'any' | 'part' | 'board' | 'ref' | 'rail' | 'file';
export type PartMatch = 'exact' | 'base' | 'prefix' | 'family';
export interface QueryTerm { field: QueryField; value: string; match?: PartMatch }
export interface QueryFilters { roots?: string[]; kinds?: LibraryKind[]; roles?: FileRole[]; states?: FileState[]; formats?: string[]; vendors?: string[]; deviceTypes?: string[]; has?: ('board' | 'schematic' | 'documents')[]; groupId?: string }
export interface QueryRequest { text: string; mode: typeof QUERY_MODES[number]; filters: QueryFilters; sort: typeof QUERY_SORTS[number]; direction: 'asc' | 'desc'; cursor?: string; limit: number }
export interface ParsedQuery { terms: QueryTerm[]; issues: ('too-long' | 'unclosed-quote' | 'missing-value' | 'short-prefix' | 'ref-needs-group')[] }
/** No regex supplied by users, operators, SQL or FTS syntax. Terms are ANDed, values are always bound parameters. */
export function parseQuery(input: unknown, groupId?: string): ParsedQuery {
  const result: ParsedQuery = { terms: [], issues: [] };
  if (typeof input !== 'string') return result;
  if (input.length > 200) { result.issues.push('too-long'); return result; }
  let at = 0;
  while (at < input.length) {
    while (at < input.length && /\s/.test(input[at])) at++;
    if (at === input.length) break;
    let token = '', quoted = false;
    while (at < input.length) {
      const c = input[at++];
      if (c === '"') { quoted = !quoted; continue; }
      if (c === '\\' && (input[at] === '"' || input[at] === '\\')) { token += input[at++]; continue; }
      if (!quoted && /\s/.test(c)) break;
      token += c;
    }
    if (quoted) result.issues.push('unclosed-quote');
    const colon = token.indexOf(':');
    const key = colon < 0 ? '' : token.slice(0, colon).toLowerCase();
    const keys: Record<string, { field: QueryField; match?: PartMatch }> = {
      part: { field: 'part', match: 'exact' }, exact: { field: 'part', match: 'exact' }, base: { field: 'part', match: 'base' }, prefix: { field: 'part', match: 'prefix' }, family: { field: 'part', match: 'family' }, board: { field: 'board' }, ref: { field: 'ref' }, rail: { field: 'rail' }, file: { field: 'file' },
    };
    const spec = Object.hasOwn(keys, key) ? keys[key] : { field: 'any' as const };
    let value = (Object.hasOwn(keys, key) ? token.slice(colon + 1) : token).normalize('NFKC').trim();
    if (value.length > 200) { result.issues.push('too-long'); continue; }
    if (!value) { result.issues.push('missing-value'); continue; }
    let match = spec.match;
    if (spec.field === 'part' && key === 'part' && value.endsWith('*')) { match = 'prefix'; value = value.slice(0, -1); }
    if (match === 'prefix' && value.length < 5) { result.issues.push('short-prefix'); continue; }
    if (spec.field === 'ref' && !groupId) { result.issues.push('ref-needs-group'); continue; }
    result.terms.push({ field: spec.field, value, ...(match ? { match } : {}) });
  }
  return result;
}
