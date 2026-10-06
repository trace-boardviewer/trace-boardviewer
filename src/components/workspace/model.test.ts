import { describe, expect, it } from 'vitest';
import type { SearchResult, SearchRow } from '../../lib/crossprobe';
import type { Board, BoardComponent, BoardNote, BoardPin } from '../../lib/types';
import { PANEL_AUTO_COLLAPSE_BELOW, autoCollapsePanels, deriveSide, noteMatches, normalizeMeasurements, resolvePanels } from './model';
import { flattenResults, GROUP_LABEL, listComponents, resultIdentity } from './search-model';

const component = (id: string, ref: string, side: BoardComponent['side']): BoardComponent => ({ id, ref, value: '', package: '', side, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, position: { x: 0, y: 0 }, rotation: 0, pinIds: [], outline: [] });
const pin = (id: string, componentId: string, side: BoardPin['side']): BoardPin => ({ id, componentId, number: '1', name: '', net: '', side, radius: 0.2, shape: 'round', x: 0, y: 0 });
const board = { name: 'b', format: 'x', units: 'mm', outline: [], bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, warnings: [], nets: [],
  components: [component('t', 'U1', 'top'), component('b', 'U2', 'bottom'), component('x', 'J1', 'both')],
  pins: [pin('t.far', 't', 'bottom'), pin('t.near', 't', 'top'), pin('x.p', 'x', 'both'), pin('b.far', 'b', 'top')] } as Board;

describe('deriveSide (B21)', () => {
  it('keeps the physical side of a pad even when its parent is on the other side', () => {
    expect(deriveSide(board, { componentId: 't', pinId: 't.far', net: null }, 'bottom')).toBe('bottom');
    expect(deriveSide(board, { componentId: 'b', pinId: 'b.far', net: null }, 'top')).toBe('top');
    expect(deriveSide(board, { componentId: 't', pinId: 't.near', net: null }, 'bottom')).toBe('top');
  });
  it('keeps the current side for a pad or a part that is on both sides', () => {
    expect(deriveSide(board, { componentId: 'x', pinId: 'x.p', net: null }, 'bottom')).toBe('bottom');
    expect(deriveSide(board, { componentId: 'x', pinId: null, net: null }, 'top')).toBe('top');
  });
  it('switches to the side of a one-sided part and ignores unknown or missing selections', () => {
    expect(deriveSide(board, { componentId: 'b', pinId: null, net: null }, 'top')).toBe('bottom');
    expect(deriveSide(board, { componentId: null, pinId: null, net: 'GND' }, 'bottom')).toBe('bottom');
    expect(deriveSide(board, { componentId: 'gone', pinId: 'nope', net: null }, 'top')).toBe('top');
    expect(deriveSide(null, { componentId: 't', pinId: null, net: null }, 'bottom')).toBe('bottom');
  });
});

describe('side panels in a narrow window (W-win-viewers-02)', () => {
  it('collapses the panels by default only for document-centric views in a narrow window; the Board tab keeps both', () => {
    expect(autoCollapsePanels(true, 'documents', false)).toBe(true);
    expect(autoCollapsePanels(true, 'schematic', false)).toBe(true);
    expect(autoCollapsePanels(true, 'board', true)).toBe(true);
    expect(autoCollapsePanels(true, 'board', false)).toBe(false);
    for (const tab of ['board', 'schematic', 'documents'] as const) for (const split of [false, true]) expect(autoCollapsePanels(false, tab, split)).toBe(false);
  });
  it('the breakpoint sits above the 960 px minimum window and below the 1440 px reference window', () => {
    expect(960).toBeLessThan(PANEL_AUTO_COLLAPSE_BELOW);
    expect(1440).toBeGreaterThan(PANEL_AUTO_COLLAPSE_BELOW);
  });
  it('an explicit panel choice always wins over the automatic rule, per panel', () => {
    expect(resolvePanels({ left: null, right: null }, true)).toEqual({ left: false, right: false });
    expect(resolvePanels({ left: null, right: null }, false)).toEqual({ left: true, right: true });
    expect(resolvePanels({ left: true, right: null }, true)).toEqual({ left: true, right: false });
    expect(resolvePanels({ left: null, right: false }, false)).toEqual({ left: true, right: false });
    expect(resolvePanels({ left: false, right: true }, false)).toEqual({ left: false, right: true });
  });
});

describe('note helpers', () => {
  const note = (text: string, measurements?: BoardNote['measurements']): BoardNote => ({ id: 'n', componentId: 'c', text, ...(measurements ? { measurements } : {}), updatedAt: '2026-01-01T00:00:00.000Z' });
  it('normalizes measurements like the core: trimmed, empty fields dropped', () => {
    expect(normalizeMeasurements({ voltage: ' 1.8 V ', resistance: '  ', other: '' })).toEqual({ voltage: '1.8 V' });
    expect(normalizeMeasurements({ voltage: '' })).toBeUndefined();
    expect(normalizeMeasurements(null)).toBeUndefined();
  });
  it('closes the editor only when the stored note equals what was submitted (a failed write keeps it open)', () => {
    expect(noteMatches(note('a', { voltage: '1 V' }), { text: ' a ', measurements: { voltage: '1 V ' } })).toBe(true);
    expect(noteMatches(note('a'), { text: 'b' })).toBe(false);
    expect(noteMatches(undefined, { text: 'a' })).toBe(false);
    expect(noteMatches(note('a', { voltage: '1 V' }), { text: 'a' })).toBe(false);
    expect(noteMatches(undefined, { text: '  ', measurements: { voltage: '' } })).toBe(true);
    expect(noteMatches(note('a'), { text: '' })).toBe(false);
  });
});

describe('search view-model', () => {
  const row = (source: SearchRow['source'], extra: Record<string, unknown>) => ({ source, ...extra }) as unknown as SearchRow;
  const group = (source: SearchRow['source'], rows: SearchRow[], total = rows.length) => ({ source, rows, total, truncated: total > rows.length });
  const result = (query: string, groups: ReturnType<typeof group>[]): SearchResult => ({ query, groups: groups as unknown as SearchResult['groups'], total: groups.reduce((n, g) => n + g.total, 0), truncated: false });
  const r1 = row('board-components', { componentId: 'c1', ref: 'R1' }), r2 = row('board-components', { componentId: 'c2', ref: 'r1' });
  const empty = (source: SearchRow['source']) => group(source, []);
  const full = result('r1', [group('board-components', [r1, r2], 5), empty('board-nets'), group('schematic-symbols', [row('schematic-symbols', { symbolId: 's' })]), empty('schematic-nets'), group('documents', [row('documents', { page: 2 })])]);
  it('flattens groups into headers and rows, skipping empty groups and keeping the group order', () => {
    const flat = flattenResults(full);
    expect(flat.items.filter(item => item.kind === 'header').map(item => item.kind === 'header' && item.source)).toEqual(['board-components', 'schematic-symbols', 'documents']);
    expect(flat.rows).toHaveLength(4);
    expect(flat.rows[0]).toBe(r1);
    expect(flat.items[0]).toMatchObject({ kind: 'header', shown: 2, total: 5, truncated: true });
    expect(Object.keys(GROUP_LABEL)).toHaveLength(5);
  });
  it('indexes data rows consecutively so keyboard navigation addresses them directly', () => {
    const rows = flattenResults(full).items.filter(item => item.kind === 'row');
    expect(rows.map(item => item.kind === 'row' && item.index)).toEqual([0, 1, 2, 3]);
  });
  it('an empty or missing result yields nothing and a result set has a changing identity', () => {
    expect(flattenResults(null).items).toEqual([]);
    expect(resultIdentity(null)).toBe('');
    expect(resultIdentity(full)).not.toBe(resultIdentity(result('r1', [group('board-components', [r1])])));
    expect(resultIdentity(full)).not.toBe(resultIdentity({ ...full, query: 'r2' }));
  });
  it('lists the components of one side (both-sided parts always) in natural order', () => {
    const numbered = { ...board, components: [component('1', 'R10', 'top'), component('2', 'R2', 'top'), component('3', 'R3', 'bottom'), component('4', 'J1', 'both')] } as Board;
    const natural = new Intl.Collator('en', { numeric: true }).compare;
    expect(listComponents(numbered, 'top', false, natural).map(c => c.ref)).toEqual(['J1', 'R2', 'R10']);
    expect(listComponents(numbered, 'bottom', false, natural).map(c => c.ref)).toEqual(['J1', 'R3']);
    expect(listComponents(numbered, 'top', true, natural).map(c => c.ref)).toEqual(['J1', 'R2', 'R3', 'R10']);
    expect(listComponents(null, 'top', true, natural)).toEqual([]);
  });
});
