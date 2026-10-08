import type { SearchResult, SearchRow, SearchSource } from '../../lib/crossprobe';

/** Pure view-model of the unified search list: one flat, virtualizable sequence of group headers and result rows. */
export type FlatItem =
  | { kind: 'header'; source: SearchSource; shown: number; total: number; truncated: boolean }
  | { kind: 'row'; row: SearchRow; index: number };

export interface FlatResults { items: FlatItem[]; rows: SearchRow[] }
export const EMPTY_RESULTS: FlatResults = { items: [], rows: [] };

// i18n: pending
export const GROUP_LABEL: Record<SearchSource, string> = {
  'board-components': 'Board components', 'board-nets': 'Board nets', 'schematic-symbols': 'Schematic symbols', 'schematic-nets': 'Schematic nets', documents: 'Documents',
};

/** Groups keep searchAll's order (exact literal reference first inside a group); empty groups disappear. */
export function flattenResults(result: SearchResult | null): FlatResults {
  if (!result) return EMPTY_RESULTS;
  const items: FlatItem[] = [];
  const rows: SearchRow[] = [];
  for (const group of result.groups) {
    if (!group.rows.length) continue;
    items.push({ kind: 'header', source: group.source, shown: group.rows.length, total: group.total, truncated: group.truncated });
    for (const row of group.rows) { items.push({ kind: 'row', row, index: rows.length }); rows.push(row); }
  }
  return { items, rows };
}

/** Identity of a result set: scrolling restarts at the top when it changes (B12). */
export function resultIdentity(result: SearchResult | null): string {
  if (!result) return '';
  return `${result.query}\u0000${result.total}\u0000${result.groups.map(group => group.rows.length).join(',')}`;
}

export function rowKey(row: SearchRow): string {
  switch (row.source) {
    case 'board-components': return `bc:${row.componentId}`;
    case 'board-nets': return `bn:${row.id ?? row.name}`;
    case 'schematic-symbols': return `ss:${row.documentId}:${row.instancePath}:${row.symbolId}`;
    case 'schematic-nets': return `sn:${row.documentId}:${row.netKey}`;
    case 'documents': return `dh:${row.documentId}:${row.page}:${row.itemIndex}`;
  }
}
