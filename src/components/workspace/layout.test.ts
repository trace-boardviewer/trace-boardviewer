import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceApi } from '../../app/api';
import { DocumentList } from './DocumentList';
import { SchematicBanners, needsBanner, schematicOverlay } from './Tabs';

// The node test environment has no layout engine: the geometry itself is proven on the source-level Electron app
// (evidence/dev-ui). These tests pin the DOM structure and the CSS contract that the geometry depends on.
const css = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const rule = (sheet: string, selector: string) => {
  const match = sheet.match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm'));
  return match ? match[1] : null;
};

const doc = (id: string, kind: 'pdf' | 'image' | 'schematic', name: string) => ({ record: { id, kind, name, path: `/x/${name}`, size: 1 }, status: 'ready' });
const stripApi = (names: Array<[string, 'pdf' | 'image' | 'schematic', string]>) => ({ state: { documents: names.map(([id, kind, name]) => doc(id, kind, name)), persistence: 'native' }, actions: {} }) as unknown as WorkspaceApi;
const strip = (api: WorkspaceApi) => renderToStaticMarkup(createElement(DocumentList, { api, selectedId: 'img', onSelect: () => {}, onAttach: () => {}, onExport: () => {}, layout: 'strip' }));
const between = (html: string, open: string, close: string) => { const start = html.indexOf(open); const end = html.indexOf(close, start); return start < 0 || end < 0 ? '' : html.slice(start, end); };

describe('compact document strip (W-win-viewers-03)', () => {
  const html = strip(stripApi([['pdf', 'pdf', 'circuit.pdf'], ['img', 'image', 'photo.png'], ['sch', 'schematic', 'main.kicad_sch']]));
  it('keeps Attach and Export in a group of their own, outside the chip list (so they can never scroll away)', () => {
    const actions = between(html, '<div class="wsp-docstrip-actions"', '</div>');
    expect(actions).toContain('data-testid="attach"');
    expect(actions).toContain('data-testid="export-open"');
    const chips = between(html, '<ul class="wsp-docstrip-chips"', '</ul>');
    expect(chips).not.toContain('data-testid="attach"');
    expect(chips).not.toContain('data-testid="export-open"');
  });
  it('lists every document as a chip, in order, with its status', () => {
    const chips = between(html, '<ul class="wsp-docstrip-chips"', '</ul>');
    expect([...chips.matchAll(/class="wsp-docchip[^"]*"[^>]*title="([^"]+)"/g)].map(m => m[1])).toEqual(['circuit.pdf', 'photo.png', 'main.kicad_sch']);
    expect(chips.match(/data-testid="status-chip"/g)).toHaveLength(3);
    expect(chips).toContain('aria-current="true"');
  });
  it('shows no Export control without documents', () => {
    const empty = strip(stripApi([]));
    expect(empty).toContain('data-testid="attach"');
    expect(empty).not.toContain('data-testid="export-open"');
  });
  it('wraps the chips instead of scrolling sideways, and the strip itself never scrolls (CSS contract)', () => {
    const sheet = css('./workspace.css');
    const chips = rule(sheet, '.wsp-docstrip-chips') ?? '';
    expect(chips).toMatch(/flex-wrap:\s*wrap/);
    expect(chips).toMatch(/overflow-x:\s*hidden/);
    expect(chips).toMatch(/max-height:\s*\d+px/);
    expect(chips).toMatch(/min-width:\s*0/);
    const wrapper = rule(sheet, '.wsp-docstrip') ?? '';
    expect(wrapper).not.toMatch(/overflow-x:\s*auto/);
    expect(rule(sheet, '.wsp-docstrip-actions') ?? '').toMatch(/flex:\s*none/);
  });
});

describe('board-candidate banner is an overlay (W-fin-crossprobe-01)', () => {
  const ambiguousNet = { status: 'ambiguous', total: 2, truncated: false, reasons: ['several-board-nets'], caseInsensitive: [], candidates: [{ name: 'SIGA', pinCount: 1, via: 'alias' }, { name: 'SIGB', pinCount: 1, via: 'alias' }] } as unknown as WorkspaceApi['state']['probe']['boardNetMapping'];
  const uniqueNet = { status: 'unique', total: 1, truncated: false, reasons: [], caseInsensitive: [], candidates: [{ name: 'GND', pinCount: 2, via: 'exact' }] } as unknown as WorkspaceApi['state']['probe']['boardNetMapping'];
  const missingPart = { status: 'missing', total: 0, truncated: false, reasons: [], caseInsensitive: [], candidates: [] } as unknown as WorkspaceApi['state']['probe']['boardMapping'];
  const actions = { chooseBoardNet: vi.fn(), chooseBoardTarget: vi.fn() } as unknown as WorkspaceApi['actions'];

  it('needs a banner only for an ambiguous or missing counterpart', () => {
    expect(needsBanner(null)).toBe(false);
    expect(needsBanner(uniqueNet)).toBe(false);
    expect(needsBanner(ambiguousNet)).toBe(true);
    expect(needsBanner(missingPart)).toBe(true);
  });
  it('hands the viewer an overlay element only while a decision is pending (null otherwise, so the slot stays empty)', () => {
    expect(schematicOverlay(null, null, actions, () => {})).toBeNull();
    expect(schematicOverlay(null, uniqueNet, actions, () => {})).toBeNull();
    const overlay = schematicOverlay(null, ambiguousNet, actions, () => {});
    expect(overlay).not.toBeNull();
    const html = renderToStaticMarkup(overlay);
    expect(html).toContain('data-testid="board-net-mapping"');
    expect(html.match(/data-testid="board-net-candidate"/g)).toHaveLength(2);
    expect(html).toContain('SIGA');
    expect(html).toContain('SIGB');
  });
  it('renders the part banner through the same overlay', () => {
    const html = renderToStaticMarkup(createElement(SchematicBanners, { mapping: missingPart, netMapping: null, actions, onLink: () => {} }));
    expect(html).toContain('data-testid="board-mapping"');
    expect(html).not.toContain('data-testid="board-net-mapping"');
  });
  it('the overlay is out of the layout flow and only its own boxes take pointer events (CSS contract)', () => {
    const viewer = css('../schematic-viewer.css');
    const host = rule(viewer, '.schv-host-overlay') ?? '';
    expect(host).toMatch(/position:\s*absolute/);
    expect(host).toMatch(/pointer-events:\s*none/);
    expect(rule(viewer, '.schv-host-overlay>*') ?? '').toMatch(/pointer-events:\s*auto/);
    expect(rule(viewer, '.schv-stage') ?? '').toMatch(/position:\s*relative/);
  });
});
