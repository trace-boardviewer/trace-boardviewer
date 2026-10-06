import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDesktop } from '../app/testing';
import { LANGUAGES, catalogs, createFormatters, createTranslator, translate } from '../lib/i18n';
import type { Language } from '../lib/i18n';
import type { AppSettings } from '../lib/types';
import { UPDATE_KEYS, UPDATE_OPEN_FAILED_KEY } from '../lib/update-check';
import type { CheckNowState } from '../lib/update-check';
import { CheckNow, UpdateSettings, UpdateStrip } from './UpdateNotice';
import { SettingsDialog } from './workspace/Dialogs';
import { UiContext } from './workspace/ui-context';
import type { UiContextValue } from './workspace/ui-context';

/**
 * Markup of the update notification (server-side render, no DOM needed): the strip under the top bar, the Settings rows and the Settings dialog with and without the
 * desktop bridge, in all eight languages. Clicks, the check itself and the timing are covered by src/lib/update-check.test.ts and the real-Electron smoke.
 */
const decode = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const encode = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const catalog = (lang: Language): Record<string, string> => catalogs[lang] as Record<string, string>;
const textOf = (html: string, pattern: RegExp): string => {
  const match = pattern.exec(html);
  expect(match, String(pattern)).not.toBeNull();
  return decode(match![1]);
};
const strip = (lang: Language, version = '1.2.1'): string => renderToStaticMarkup(createElement(UpdateStrip, { t: createTranslator(lang), version, onDownload: () => undefined, onDismiss: () => undefined }));
const checkNow = (lang: Language, initial?: CheckNowState): string => renderToStaticMarkup(createElement(CheckNow, { t: createTranslator(lang), initial, actions: { check: async () => null, open: async () => false } }));

describe('UpdateStrip markup', () => {
  it.each(LANGUAGES)('%s: a status region with the text, the Download button and the dismiss button, in the catalog language', (lang) => {
    const html = strip(lang);
    expect(html).toMatch(/^<div class="update-strip" role="status" data-testid="update-strip">/);
    expect(textOf(html, /data-testid="update-strip-text">([^<]*)<\/span>/)).toBe(translate(lang, UPDATE_KEYS.available, { version: '1.2.1' }));
    expect(textOf(html, /data-testid="update-download"[^>]*>([^<]*)<\/button>/)).toBe(catalog(lang)[UPDATE_KEYS.download]);
    expect(textOf(html, /aria-label="([^"]*)"[^>]*data-testid="update-dismiss"/)).toBe(catalog(lang)[UPDATE_KEYS.dismiss]);
    expect(textOf(html, /title="([^"]*)"[^>]*data-testid="update-dismiss"/)).toBe(catalog(lang)[UPDATE_KEYS.dismiss]);
  });

  it('the order is: the text, Download, then the dismiss button; two buttons, no link, no input', () => {
    const html = strip('en');
    const order = [...html.matchAll(/data-testid="(update-[a-z-]+)"/g)].map(match => match[1]);
    expect(order).toEqual(['update-strip', 'update-strip-text', 'update-download', 'update-dismiss']);
    expect([...html.matchAll(/<button /g)]).toHaveLength(2);
    expect(html).toMatch(/<button type="button" class="outline-button update-strip-download"/);
    expect(html).not.toMatch(/<(?:a|input|select|textarea)\b|href=|disabled/);
  });

  it('the markup names no URL: Download only calls back, the page comes from the main process', () => {
    const html = strip('en').replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '');
    expect(html).not.toMatch(/https?:|github|href=/i);
  });

  it('the icons are decorative and the version is escaped as text, never as markup', () => {
    const html = strip('en', '<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(strip('en')).toContain('aria-hidden="true"');
  });
});

describe('CheckNow markup (the Settings row)', () => {
  const status = (html: string): string => textOf(html, /data-testid="update-check-status">([^<]*)<\/span>/);

  it.each(LANGUAGES)('%s: before the first press there is a button, an empty polite status line and no Download', (lang) => {
    const html = checkNow(lang);
    expect(textOf(html, /data-testid="update-check-now"[^>]*>([^<]*)<\/button>/)).toBe(catalog(lang)[UPDATE_KEYS.checkNow]);
    expect(html).toMatch(/<span class="update-check-status" role="status" data-testid="update-check-status"><\/span>/);
    expect(html).not.toContain('update-check-download');
    expect(html).not.toMatch(/data-testid="update-check-now"[^>]*disabled/);
  });

  it.each(LANGUAGES)('%s: the status line and the Download button follow the state: checking, up to date, available, could not check, could not open', (lang) => {
    const done = (result: Extract<CheckNowState, { phase: 'done' }>['result'], openFailed?: boolean): CheckNowState => ({ phase: 'done', result, ...(openFailed ? { openFailed } : {}) });
    const checking = checkNow(lang, { phase: 'checking' });
    expect(status(checking)).toBe(catalog(lang)[UPDATE_KEYS.checking]);
    expect(checking, 'the button is disabled while checking').toMatch(/data-testid="update-check-now"[^>]*disabled|disabled=""[^>]*data-testid="update-check-now"/);
    expect(checking).not.toContain('update-check-download');
    const current = checkNow(lang, done({ status: 'current' }));
    expect(status(current)).toBe(catalog(lang)[UPDATE_KEYS.current]);
    expect(current).not.toContain('update-check-download');
    const failed = checkNow(lang, done({ status: 'unavailable' }));
    expect(status(failed)).toBe(catalog(lang)[UPDATE_KEYS.failed]);
    expect(failed).not.toContain('update-check-download');
    const available = checkNow(lang, done({ status: 'available', version: '1.2.1' }));
    expect(status(available)).toBe(translate(lang, UPDATE_KEYS.available, { version: '1.2.1' }));
    expect(textOf(available, /data-testid="update-check-download"[^>]*>([^<]*)<\/button>/)).toBe(catalog(lang)[UPDATE_KEYS.download]);
    expect(available).toMatch(/class="primary-button update-check-download"/);
    const openFailed = checkNow(lang, done({ status: 'available', version: '1.2.1' }, true));
    expect(status(openFailed)).toBe(catalog(lang)[UPDATE_OPEN_FAILED_KEY]);
    expect(openFailed).toContain('update-check-download');
  });
});

describe('UpdateSettings markup (the switch and the Check now row)', () => {
  const rows = (lang: Language, checked: boolean): string => renderToStaticMarkup(createElement(UpdateSettings, { t: createTranslator(lang), checked, onChange: () => undefined, actions: { check: async () => null, open: async () => false } }));

  it.each(LANGUAGES)('%s: a labelled switch with the setting text and the hint, then the Check now row', (lang) => {
    const html = rows(lang, true);
    expect(textOf(html, /<strong>([^<]*)<\/strong>/)).toBe(catalog(lang)[UPDATE_KEYS.setting]);
    expect(textOf(html, /<small>([^<]*)<\/small>/)).toBe(catalog(lang)[UPDATE_KEYS.settingHint]);
    expect(html).toMatch(/^<label><span><strong>/);
    expect(html).toMatch(/<input type="checkbox" role="switch" data-testid="update-check-switch"/);
    expect(html.indexOf('update-check-switch')).toBeLessThan(html.indexOf('update-check-now'));
  });

  it('the switch reflects the setting', () => {
    expect(rows('en', true)).toMatch(/data-testid="update-check-switch"[^>]*checked/);
    expect(rows('en', false)).not.toMatch(/data-testid="update-check-switch"[^>]*checked/);
  });
});

describe('SettingsDialog with and without the desktop bridge', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  // Modal reads document.activeElement at render; the node test environment has neither a document nor HTMLElement.
  const stubPage = (traceDesktop?: unknown): void => {
    vi.stubGlobal('HTMLElement', class {});
    vi.stubGlobal('document', { activeElement: null });
    vi.stubGlobal('window', traceDesktop === undefined ? {} : { traceDesktop });
  };
  const settings = (over: Partial<AppSettings> = {}): AppSettings => ({ language: 'en', theme: 'dark', layout: 'workshop', motion: true, showLabels: true, showConnections: true, updateCheck: true, ...over });
  const dialog = (lang: Language, over: Partial<AppSettings> = {}): string => {
    const ui: UiContextValue = { t: createTranslator(lang), fmt: createFormatters(lang), language: lang, text: () => '', copy: () => undefined };
    return renderToStaticMarkup(createElement(UiContext.Provider, { value: ui }, createElement(SettingsDialog, { settings: settings({ language: lang, ...over }), onUpdate: () => undefined, onClose: () => undefined })));
  };
  const switches = (html: string): number => [...html.matchAll(/role="switch"/g)].length;

  it.each(LANGUAGES)('%s: with the desktop bridge the update switch and the Check now row follow the other three switches', (lang) => {
    stubPage(createFakeDesktop());
    const html = dialog(lang);
    expect(switches(html)).toBe(4);
    expect(html).toContain(`<strong>${encode(catalog(lang)[UPDATE_KEYS.setting])}</strong><small>${encode(catalog(lang)[UPDATE_KEYS.settingHint])}</small>`);
    expect(textOf(html, /data-testid="update-check-now"[^>]*>([^<]*)<\/button>/)).toBe(catalog(lang)[UPDATE_KEYS.checkNow]);
    const connections = html.indexOf(`<strong>${encode(catalog(lang)['settings.connections'])}</strong>`);
    expect(connections, 'the existing switches are still there').toBeGreaterThan(0);
    expect(html.indexOf('update-check-switch'), 'the update switch comes after them').toBeGreaterThan(connections);
    expect(html).toMatch(/data-testid="update-check-switch"[^>]*checked/);
  });

  it('a switched-off setting renders the switch unchecked', () => {
    stubPage(createFakeDesktop());
    expect(dialog('en', { updateCheck: false })).not.toMatch(/data-testid="update-check-switch"[^>]*checked/);
  });

  it('without the desktop bridge (browser development mode) neither the switch nor the button is rendered', () => {
    stubPage();
    const html = dialog('en');
    expect(switches(html)).toBe(3);
    expect(html).not.toMatch(/update-check|Check now|Check for updates/);
  });

  it('an older preload without the update calls hides them as well', () => {
    const { checkForUpdates: _check, openUpdatePage: _open, ...older } = createFakeDesktop();
    stubPage(older);
    expect(switches(dialog('en'))).toBe(3);
    stubPage({ ...older, checkForUpdates: async () => ({ status: 'current' }) });
    expect(switches(dialog('en')), 'one of the two calls is not enough').toBe(3);
  });
});
