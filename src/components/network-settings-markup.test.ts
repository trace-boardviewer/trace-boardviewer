import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDesktop } from '../app/testing';
import { LANGUAGES, catalogs, createFormatters, createTranslator, translate } from '../lib/i18n';
import type { Language } from '../lib/i18n';
import { NETWORK_KEYS, formatActivityTime } from '../lib/network-activity';
import type { NetworkActivityEntry, NetworkActivityReport } from '../lib/network-activity';
import type { AppSettings } from '../lib/types';
import { UPDATE_KEYS } from '../lib/update-check';
import NetworkSettings from './NetworkSettings';
import { SettingsDialog } from './workspace/Dialogs';
import { UiContext } from './workspace/ui-context';
import type { UiContextValue } from './workspace/ui-context';

/**
 * Markup of Settings > Network (server-side render, no DOM needed): the feature list with its state, the activity table, its empty and collapsed forms and the
 * Settings dialog with and without the bridge's network calls, in all eight languages. The reading, clearing and refreshing run through src/lib/network-activity.ts
 * (tested there) and the main process (tests/desktop-checks.cjs).
 */
const decode = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const catalog = (lang: Language): Record<string, string> => catalogs[lang] as Record<string, string>;
const textOf = (html: string, pattern: RegExp): string => {
  const match = pattern.exec(html);
  expect(match, String(pattern)).not.toBeNull();
  return decode(match![1]);
};
const settings = (over: Partial<AppSettings> = {}): AppSettings => ({ language: 'en', theme: 'dark', layout: 'workshop', motion: true, showLabels: true, showConnections: true, updateCheck: true, ...over });
const entry = (over: Partial<NetworkActivityEntry> = {}): NetworkActivityEntry => ({
  id: 1, time: '2026-10-07T10:00:00.000Z', kind: 'request', feature: 'update-check', method: 'GET', host: 'api.github.com', path: '/repos/example/example/releases/latest',
  outcome: 'ok', status: 200, bytes: 512, durationMs: 120, error: null, ...over,
});
const feature = { id: 'update-check', hosts: ['api.github.com'], optIn: 'updateCheck', enabled: true };
const report = (over: Partial<NetworkActivityReport> = {}): NetworkActivityReport => ({ features: [feature], entries: [entry()], dropped: 0, limit: 200, ...over });
const actions = { read: async () => null, clear: async () => false };
const section = (lang: Language, props: { report?: NetworkActivityReport | null; open?: boolean; settings?: Partial<AppSettings> } = {}): string => renderToStaticMarkup(createElement(NetworkSettings, {
  t: createTranslator(lang), language: lang, settings: settings({ language: lang, ...props.settings }), actions, initialOpen: props.open ?? false, initialReport: props.report === undefined ? report() : props.report,
}));
const rowsOf = (html: string): string[] => html.split('data-testid="network-row"').slice(1);

describe('Settings > Network markup', () => {
  it.each(LANGUAGES)('%s: a labelled section with the title and the intro, the update check with its hint, hosts and state, and a toggle for the activity', (lang) => {
    const html = section(lang);
    expect(html).toMatch(/^<section class="settings-section network-section" aria-labelledby="[^"]+" data-testid="network-section"><h3 id="[^"]+">/);
    expect(textOf(html, /<h3 id="[^"]+">([^<]*)<\/h3>/)).toBe(catalog(lang)[NETWORK_KEYS.title]);
    expect(textOf(html, /<p class="settings-hint">([^<]*)<\/p>/)).toBe(catalog(lang)[NETWORK_KEYS.intro]);
    const item = html.slice(html.indexOf('data-testid="network-feature-update-check"'));
    expect(textOf(item, /<strong>([^<]*)<\/strong>/)).toBe(catalog(lang)['network.updateCheck']);
    expect(item).toContain(`<small>${decode(catalog(lang)['network.updateCheckHint']).replace(/'/g, '&#x27;')}</small>`);
    expect(textOf(item, /<small class="mono">([^<]*)<\/small>/)).toBe(translate(lang, NETWORK_KEYS.hosts, { hosts: 'api.github.com' }));
    expect(textOf(item, /<span class="network-state" data-state="on">([^<]*)<\/span>/)).toBe(catalog(lang)[NETWORK_KEYS.stateOn]);
    expect(textOf(html, /data-testid="network-activity-toggle"[^>]*>([^<]*)<\/button>/)).toBe(catalog(lang)[NETWORK_KEYS.show]);
  });

  it('the list shows the state in words, from the interface\'s own setting: Off when the switch is off, On when it is on', () => {
    expect(section('en', { settings: { updateCheck: false } })).toMatch(/<span class="network-state" data-state="off">Off<\/span>/);
    expect(section('en', { settings: { updateCheck: true } })).toMatch(/<span class="network-state" data-state="on">On<\/span>/);
    expect(section('de', { settings: { updateCheck: false } })).toMatch(/data-state="off">Aus<\/span>/);
  });

  it('a feature the interface has no words for is listed by its id, with its hosts and no hint; many hosts are joined', () => {
    const html = section('en', { report: report({ features: [{ id: 'readings-library', hosts: ['a.example.org', 'b.example.org'], optIn: 'readingsLibrary', enabled: false }, { id: 'constructor', hosts: ['c.example.org'], optIn: null, enabled: true }] }) });
    expect(html).toContain('<strong>readings-library</strong>');
    expect(html).toContain('Connects to: a.example.org, b.example.org');
    expect(html).toMatch(/data-testid="network-feature-readings-library"[\s\S]*data-state="off">Off</);
    expect(html).toContain('<strong>constructor</strong>');
    expect(html).toMatch(/data-testid="network-feature-constructor"[\s\S]*data-state="on">On</);
    expect(html.match(/<small>/g)?.length ?? 0).toBe(0);
  });

  it('collapsed: the toggle says Show and is not expanded, the log container is hidden and empty, and the section holds no table', () => {
    const html = section('en');
    expect(html).toMatch(/<button type="button" class="outline-button network-toggle" aria-expanded="false" aria-controls="([^"]+)" data-testid="network-activity-toggle">Show network activity<\/button>/);
    const controls = /aria-controls="([^"]+)"/.exec(html)![1];
    expect(html).toMatch(new RegExp(`<div id="${controls.replace(/[:.]/g, '\\$&')}" class="network-log" data-testid="network-log" hidden=""></div>`));
    expect(html).not.toContain('<table');
    expect(html).not.toContain('network-refresh');
  });

  it.each(LANGUAGES)('%s: expanded: the toggle says Hide and is expanded and controls the log; intro, Refresh, Clear list, a polite status line and the table', (lang) => {
    const html = section(lang, { open: true });
    expect(html).toMatch(/aria-expanded="true" aria-controls="([^"]+)" data-testid="network-activity-toggle"/);
    expect(textOf(html, /data-testid="network-activity-toggle"[^>]*>([^<]*)<\/button>/)).toBe(catalog(lang)[NETWORK_KEYS.hide]);
    const controls = /aria-controls="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`<div id="${controls}" class="network-log" data-testid="network-log">`);
    expect(html).not.toMatch(/data-testid="network-log" hidden/);
    expect(html).toContain(`<p class="settings-hint">${decode(catalog(lang)[NETWORK_KEYS.activityIntro]).replace(/'/g, '&#x27;')}</p>`);
    expect(textOf(html, /data-testid="network-refresh">(?:<svg[^>]*>.*?<\/svg>)([^<]*)<\/button>/)).toBe(catalog(lang)[NETWORK_KEYS.refresh]);
    expect(textOf(html, /data-testid="network-clear">(?:<svg[^>]*>.*?<\/svg>)([^<]*)<\/button>/)).toBe(catalog(lang)[NETWORK_KEYS.clear]);
    expect(html).toMatch(/<p class="network-status" role="status" data-testid="network-status"><\/p>/);
    expect(textOf(html, /<caption class="network-sr-only">([^<]*)<\/caption>/)).toBe(catalog(lang)[NETWORK_KEYS.caption]);
    const headers = [...html.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map(match => decode(match[1]));
    expect(headers).toEqual([catalog(lang)[NETWORK_KEYS.colTime], catalog(lang)[NETWORK_KEYS.colFeature], catalog(lang)[NETWORK_KEYS.colHost], catalog(lang)[NETWORK_KEYS.colResult]]);
  });

  it('keyboard and screen reader structure: native buttons in the order toggle, Refresh, Clear list; decorative icons hidden; the scrolling table is a labelled, focusable region', () => {
    const html = section('en', { open: true });
    const order = ['network-activity-toggle', 'network-refresh', 'network-clear'].map(id => html.indexOf(`data-testid="${id}"`));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const button of html.match(/<button[^>]*>/g)!) expect(button).toMatch(/^<button type="button"/);
    expect(html.match(/<svg[^>]*>/g)!.every(svg => svg.includes('aria-hidden="true"'))).toBe(true);
    expect(html).toMatch(/<div class="network-table-wrap" role="region" aria-label="Network activity" tabindex="0">/);
    expect(html).not.toMatch(/<a\b|<input|onclick|tabindex="[1-9]/i);
    expect(html.match(/<h3/g)!.length).toBe(1);
  });

  it('the rows are newest first, with the time (and its full date in the title), the feature, host and path, and the result in words', () => {
    const entries = [
      entry({ id: 1 }), entry({ id: 2, outcome: 'refused', status: null, bytes: 0, durationMs: 0, error: 'disabled' }), entry({ id: 3, outcome: 'error', status: null, bytes: 0, error: 'timeout', host: 'data.example.org', path: '/x.json', feature: 'readings-library' }),
      entry({ id: 4, status: 429 }), entry({ id: 5, outcome: 'pending', status: null, durationMs: null }),
    ];
    const html = section('en', { open: true, report: report({ entries }) });
    const rows = rowsOf(html);
    expect(rows.length).toBe(5);
    expect(rows.map(row => /<span class="network-result" data-tone="(\w+)">([^<]*)<\/span>/.exec(row)!.slice(1).join(':'))).toEqual(['wait:In progress', 'bad:HTTP status 429', 'bad:Timed out', 'bad:Switched off', 'good:HTTP status 200']);
    expect(rows.map(row => /data-outcome="(\w+)"/.exec(row)![1])).toEqual(['pending', 'ok', 'error', 'refused', 'ok']);
    const first = rows[4];
    expect(first).toContain('<time dateTime="2026-10-07T10:00:00.000Z" title="');
    expect(textOf(first, /<time [^>]*>([^<]*)<\/time>/)).toBe(formatActivityTime('2026-10-07T10:00:00.000Z', 'en'));
    expect(first).toContain('<td>Update check</td>');
    expect(first).toContain('<span class="network-host-name mono">api.github.com</span><span class="network-path mono">/repos/example/example/releases/latest</span>');
    expect(rows[2]).toContain('<td>readings-library</td>');
    expect(rows[2]).toContain('data.example.org</span><span class="network-path mono">/x.json</span>');
    expect(html).toContain('<td><span class="network-host-name mono">api.github.com</span>');
    expect(section('en', { open: true, report: report({ entries: [entry({ host: '', path: '' })] }) })).toContain('<span class="network-host-name mono">—</span>');
  });

  it.each(LANGUAGES)('%s: every result label of the table is the catalog text of its language', (lang) => {
    const all: Array<[Partial<NetworkActivityEntry>, string]> = [
      [{ outcome: 'ok', status: 200 }, translate(lang, 'network.resultHttp', { status: 200 })], [{ outcome: 'pending', status: null }, catalog(lang)['network.resultPending']],
      [{ outcome: 'refused', status: null, error: 'disabled' }, catalog(lang)['network.resultDisabled']], [{ outcome: 'refused', status: null, error: 'host' }, catalog(lang)['network.resultBlocked']],
      [{ outcome: 'refused', status: null, error: 'busy' }, catalog(lang)['network.resultBusy']], [{ outcome: 'error', status: null, error: 'redirect' }, catalog(lang)['network.resultRedirect']],
      [{ outcome: 'error', status: null, error: 'too-large' }, catalog(lang)['network.resultTooLarge']], [{ outcome: 'error', status: null, error: 'timeout' }, catalog(lang)['network.resultTimeout']],
      [{ outcome: 'error', status: null, error: 'network' }, catalog(lang)['network.resultNetwork']], [{ outcome: 'error', status: null, error: 'bad-response' }, catalog(lang)['network.resultBadResponse']],
      [{ outcome: 'error', status: null, error: 'storage' }, catalog(lang)['network.resultFailed']],
    ];
    const html = section(lang, { open: true, report: report({ entries: all.map(([over], index) => entry({ id: index + 1, ...over })) }) });
    const labels = rowsOf(html).reverse().map(row => textOf(row, /<span class="network-result" data-tone="\w+">([^<]*)<\/span>/));
    expect(labels).toEqual(all.map(([, label]) => label));
  });

  it('no entry: the empty sentence and a Clear list button that is disabled; nothing is drawn as a table', () => {
    const html = section('en', { open: true, report: report({ entries: [] }) });
    expect(html).toContain('<p class="settings-hint" data-testid="network-empty">No network request since TRACE started.</p>');
    expect(html).toMatch(/data-testid="network-clear" disabled=""/);
    expect(html).not.toContain('<table');
    expect(section('en', { open: true, report: report() })).not.toMatch(/data-testid="network-clear" disabled/);
  });

  it('the status line says how many older entries are not shown; with no report yet the section shows its title and intro only', () => {
    expect(section('en', { open: true, report: report({ dropped: 12 }) })).toContain('data-testid="network-status">Older entries not shown: 12</p>');
    expect(section('de', { open: true, report: report({ dropped: 1234 }) })).toContain(`data-testid="network-status">${translate('de', NETWORK_KEYS.dropped, { count: 1234 })}</p>`);
    const loading = section('en', { report: null });
    expect(loading).toContain('<h3');
    expect(loading).not.toContain('<ul');
    expect(loading).not.toContain('network-feature');
    const openLoading = section('en', { report: null, open: true });
    expect(openLoading).not.toContain('data-testid="network-empty"');
    expect(openLoading).not.toContain('<table');
  });

  it('no English leaks into another language: a German section holds none of the English texts', () => {
    const html = section('de', { open: true });
    for (const key of [NETWORK_KEYS.title, NETWORK_KEYS.activityTitle, NETWORK_KEYS.refresh, NETWORK_KEYS.colResult, 'network.updateCheck'] as const) {
      expect(html).not.toContain(`>${catalog('en')[key]}<`);
      expect(html).toContain(catalog('de')[key]);
    }
  });

  it('shows nothing a request could carry: no query, no header names, no body, no local path', () => {
    const html = section('en', { open: true, report: report({ entries: [entry({ path: '/library/index.json' })] }) });
    expect(html).not.toMatch(/\?|token|cookie|authorization|user-agent|accept|bytes|C:\\|\/Users\//i);
  });
});

describe('the Settings dialog with and without the bridge\'s network calls', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const stubPage = (traceDesktop?: unknown): void => {
    vi.stubGlobal('HTMLElement', class {});
    vi.stubGlobal('document', { activeElement: null });
    vi.stubGlobal('window', traceDesktop === undefined ? {} : { traceDesktop });
  };
  const dialog = (lang: Language, over: Partial<AppSettings> = {}): string => {
    const ui: UiContextValue = { t: createTranslator(lang), fmt: createFormatters(lang), language: lang, text: () => '', copy: () => undefined };
    return renderToStaticMarkup(createElement(UiContext.Provider, { value: ui }, createElement(SettingsDialog, { settings: settings({ language: lang, ...over }), onUpdate: () => undefined, onClose: () => undefined })));
  };
  const withNetwork = () => ({ ...createFakeDesktop(), getNetworkActivity: async () => report(), clearNetworkActivity: async () => undefined });
  const switches = (html: string): number => [...html.matchAll(/role="switch"/g)].length;

  it.each(LANGUAGES)('%s: with the network calls the Network section follows the switches and the update rows, inside the dialog above its footer; the switches stay four', (lang) => {
    stubPage(withNetwork());
    const html = dialog(lang);
    expect(switches(html)).toBe(4);
    const update = html.indexOf('data-testid="update-check-switch"');
    const network = html.indexOf('data-testid="network-section"');
    const footer = html.indexOf('class="modal-footer"');
    expect(update).toBeGreaterThan(0);
    expect(network).toBeGreaterThan(update);
    expect(footer).toBeGreaterThan(network);
    expect(html).toContain(`<strong>${decode(catalog(lang)[UPDATE_KEYS.setting]).replace(/'/g, '&#x27;')}</strong>`);
    expect(html.match(/data-testid="network-section"/g)!.length).toBe(1);
  });

  it('without the network calls (an older preload, or the browser development mode) the section is not drawn, and the existing rows are as before', () => {
    stubPage(createFakeDesktop());
    const older = dialog('en');
    expect(older).not.toContain('network-section');
    expect(switches(older)).toBe(4);
    stubPage();
    const bare = dialog('en');
    expect(bare).not.toContain('network-section');
    expect(switches(bare)).toBe(3);
    stubPage({ ...createFakeDesktop(), getNetworkActivity: async () => report() });
    expect(dialog('en'), 'one of the two calls is not enough').not.toContain('network-section');
  });
});
