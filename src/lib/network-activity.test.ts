import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { LANGUAGES, catalogs, translate } from './i18n';
import type { Language, MessageKey } from './i18n';
import {
  FEATURE_TEXT, NETWORK_KEYS, createNetworkActions, featureEnabled, formatActivityDateTime, formatActivityTime, networkActivitySupported, normalizeNetworkActivity, resultText, resultTone,
} from './network-activity';
import type { NetworkActivityEntry, NetworkActivityReport } from './network-activity';
import type { AppSettings, TraceDesktop } from './types';

const readSource = (file: string): string => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const nativeRequire = createRequire(import.meta.url);
const egress = nativeRequire('../../electron/net/egress.cjs') as { ERROR_CLASSES: readonly string[] };
const catalog = (lang: Language): Record<string, unknown> => catalogs[lang] as Record<string, unknown>;

const entry = (over: Partial<NetworkActivityEntry> = {}): NetworkActivityEntry => ({
  id: 1, time: '2026-10-07T10:00:00.000Z', kind: 'request', feature: 'update-check', method: 'GET', host: 'api.github.com', path: '/repos/example/example/releases/latest',
  outcome: 'ok', status: 200, bytes: 512, durationMs: 120, error: null, ...over,
});
const report = (over: Partial<NetworkActivityReport> = {}): NetworkActivityReport => ({
  features: [{ id: 'update-check', hosts: ['api.github.com'], optIn: 'updateCheck', enabled: true }], entries: [entry()], dropped: 0, limit: 200, ...over,
});
const settings = (over: Partial<AppSettings> = {}): AppSettings => ({ language: 'en', theme: 'dark', layout: 'workshop', motion: true, showLabels: true, showConnections: true, updateCheck: true, ...over });

describe('the catalogs have every word of the Network section in all eight languages', () => {
  const keys = (): MessageKey[] => [...Object.values(NETWORK_KEYS), ...Object.values(FEATURE_TEXT).flatMap(text => [text.name, text.hint]), ...(['Pending', 'Http', 'Disabled', 'Blocked', 'Busy', 'Failed', 'Redirect', 'TooLarge', 'Timeout', 'Network', 'BadResponse'].map(name => `network.result${name}` as MessageKey))];

  it.each(LANGUAGES)('%s: every key exists, is a non-empty string and the placeholders are the English ones', (lang) => {
    for (const key of keys()) {
      const text = catalog(lang)[key];
      expect(typeof text, `${lang} ${key}`).toBe('string');
      expect((text as string).length, `${lang} ${key}`).toBeGreaterThan(0);
      const placeholders = (value: unknown): string[] => [...(value as string).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
      expect(placeholders(text), `${lang} ${key}`).toEqual(placeholders(catalog('en')[key]));
    }
  });

  it('the placeholders the markup passes exist: hosts, count and status', () => {
    expect(catalog('en')[NETWORK_KEYS.hosts]).toContain('{hosts}');
    expect(catalog('en')[NETWORK_KEYS.dropped]).toContain('{count}');
    expect(catalog('en')['network.resultHttp']).toContain('{status}');
  });

  it.each(LANGUAGES)('%s: On and Off, and the labels of the result column, read differently from each other', (lang) => {
    expect(translate(lang, NETWORK_KEYS.stateOn)).not.toBe(translate(lang, NETWORK_KEYS.stateOff));
    const labels = ['Pending', 'Disabled', 'Blocked', 'Busy', 'Failed', 'Redirect', 'TooLarge', 'Timeout', 'Network', 'BadResponse'].map(name => translate(lang, `network.result${name}`));
    // Switched off appears twice on purpose in some languages (the state and the refusal), so only the result labels are compared with each other.
    expect(new Set(labels).size, labels.join(' | ')).toBe(labels.length);
  });
});

describe('the desktop bridge', () => {
  it('is supported only when both network calls exist', () => {
    expect(networkActivitySupported(undefined)).toBe(false);
    expect(networkActivitySupported(null)).toBe(false);
    expect(networkActivitySupported({})).toBe(false);
    expect(networkActivitySupported({ getNetworkActivity: async () => report() })).toBe(false);
    expect(networkActivitySupported({ clearNetworkActivity: async () => undefined })).toBe(false);
    expect(networkActivitySupported({ getNetworkActivity: async () => report(), clearNetworkActivity: async () => undefined })).toBe(true);
    expect(networkActivitySupported({ getNetworkActivity: 'x', clearNetworkActivity: 1 } as unknown as Partial<TraceDesktop>)).toBe(false);
  });

  it('read() returns the checked report and never rejects; clear() says whether the main process did it; neither sends an argument', async () => {
    const getNetworkActivity = vi.fn(async (..._args: unknown[]) => report());
    const clearNetworkActivity = vi.fn(async (..._args: unknown[]) => undefined);
    const actions = createNetworkActions({ getNetworkActivity, clearNetworkActivity } as Partial<TraceDesktop>);
    expect(await actions.read()).toEqual(report());
    expect(await actions.clear()).toBe(true);
    expect(getNetworkActivity.mock.calls).toEqual([[]]);
    expect(clearNetworkActivity.mock.calls).toEqual([[]]);
    const failing = createNetworkActions({ getNetworkActivity: async () => { throw new Error('C:\\Users\\Someone\\secret'); }, clearNetworkActivity: async () => { throw new Error('no'); } });
    expect(await failing.read()).toBeNull();
    expect(await failing.clear()).toBe(false);
    const damaged = createNetworkActions({ getNetworkActivity: async () => ({ nonsense: true }) as never, clearNetworkActivity: async () => undefined });
    expect(await damaged.read()).toBeNull();
    const bare = createNetworkActions(undefined);
    expect(await bare.read()).toBeNull();
    expect(await bare.clear()).toBe(false);
  });
});

describe('normalizeNetworkActivity checks everything that crossed the bridge', () => {
  it('keeps a well-formed report as it is', () => {
    expect(normalizeNetworkActivity(report())).toEqual(report());
    const rich = report({ entries: [entry({ outcome: 'refused', status: null, bytes: 0, durationMs: 0, error: 'disabled' }), entry({ id: 2, outcome: 'pending', status: null, durationMs: null }), entry({ id: 3, kind: 'download', feature: '?' })], dropped: 7, limit: 5 });
    expect(normalizeNetworkActivity(rich)).toEqual(rich);
  });

  it('is null for anything that is not a report', () => {
    for (const value of [null, undefined, 42, 'report', [], {}, { features: [], entries: [] }, { features: 'x', entries: [], dropped: 0, limit: 1 }, { features: [], entries: {}, dropped: 0, limit: 1 },
      { ...report(), dropped: -1 }, { ...report(), dropped: 1.5 }, { ...report(), dropped: '0' }, { ...report(), limit: 0 }, { ...report(), limit: 1001 }, { ...report(), limit: null }]) {
      expect(normalizeNetworkActivity(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('drops a damaged entry or feature and keeps the rest; unknown fields are not carried over', () => {
    const bad: unknown[] = [
      null, 'x', 42, [], { ...entry(), id: -1 }, { ...entry(), id: 1.5 }, { ...entry(), id: '1' }, { ...entry(), time: 'yesterday' }, { ...entry(), time: 42 }, { ...entry(), kind: 'upload' }, { ...entry(), feature: 'Bad Feature' },
      { ...entry(), feature: '' }, { ...entry(), method: 'get' }, { ...entry(), method: 'POSTPOSTPOST' }, { ...entry(), host: 'evil.example/with space' }, { ...entry(), host: 'a'.repeat(300) }, { ...entry(), path: 'x'.repeat(121) },
      { ...entry(), path: '/a\u0007b' }, { ...entry(), path: '/\u202ex' }, { ...entry(), outcome: 'done' }, { ...entry(), status: 99 }, { ...entry(), status: 600 }, { ...entry(), status: '200' }, { ...entry(), status: undefined },
      { ...entry(), bytes: -1 }, { ...entry(), bytes: null }, { ...entry(), durationMs: '5' }, { ...entry(), durationMs: -2 }, { ...entry(), durationMs: undefined }, { ...entry(), error: 'Not A Class' }, { ...entry(), error: 7 }, { ...entry(), error: undefined },
    ];
    const good = entry({ id: 9, outcome: 'ok', status: 204 });
    const result = normalizeNetworkActivity({
      features: [null, { id: 'update-check', hosts: ['api.github.com'], optIn: 'updateCheck', enabled: true, extra: 'x' }, { id: 'Bad', hosts: [], optIn: null, enabled: true }, { id: 'ok-one', hosts: [], optIn: null, enabled: true },
        { id: 'ok-two', hosts: ['a.example.org'], optIn: 'bad key', enabled: true }, { id: 'ok-three', hosts: ['a.example.org'], optIn: null, enabled: 'yes' }, { id: 'ok-four', hosts: ['not a host'], optIn: null, enabled: true }],
      entries: [...bad, { ...good, secret: 'x', headers: { cookie: 'a' } }], dropped: 0, limit: 200,
    });
    expect(result).not.toBeNull();
    expect(result!.features).toEqual([{ id: 'update-check', hosts: ['api.github.com'], optIn: 'updateCheck', enabled: true }]);
    expect(result!.entries).toEqual([good]);
    expect(Object.keys(result!.entries[0]).sort()).toEqual(Object.keys(entry()).sort());
  });

  it('is bounded: at most 16 features and the newest 1000 entries', () => {
    const features = Array.from({ length: 30 }, (_, i) => ({ id: `feature-${i}`, hosts: ['a.example.org'], optIn: null, enabled: true }));
    const entries = Array.from({ length: 1500 }, (_, i) => entry({ id: i + 1 }));
    const result = normalizeNetworkActivity({ features, entries, dropped: 0, limit: 1000 })!;
    expect(result.features.length).toBe(16);
    expect(result.entries.length).toBe(1000);
    expect(result.entries[0].id).toBe(501);
    expect(result.entries.at(-1)!.id).toBe(1500);
  });

  it('accepts the path of a long entry as the main process cuts it (ending in an ellipsis)', () => {
    expect(normalizeNetworkActivity(report({ entries: [entry({ path: `/${'a'.repeat(118)}…` })] }))!.entries.length).toBe(1);
  });
});

describe('what the Result column says', () => {
  const classes = egress.ERROR_CLASSES;

  it('the main process names the error classes this view has words for (a new class is a deliberate change here too)', () => {
    expect([...classes].sort()).toEqual(['bad-response', 'busy', 'disabled', 'hash-mismatch', 'host', 'invalid-url', 'method', 'network', 'not-allowed', 'not-registered', 'path', 'redirect', 'scheme', 'storage', 'timeout', 'too-large']);
  });

  it('an answer shows its HTTP status, a request in flight says so, and every refusal and failure has a label that exists in all languages', () => {
    expect(resultText(entry({ status: 404 }))).toEqual({ key: 'network.resultHttp', params: { status: 404 } });
    expect(resultText(entry({ outcome: 'pending', status: null }))).toEqual({ key: 'network.resultPending' });
    expect(resultText(entry({ outcome: 'ok', status: null }))).toEqual({ key: 'network.resultFailed' });
    for (const error of classes) {
      for (const outcome of ['refused', 'error'] as const) {
        const { key, params } = resultText(entry({ outcome, status: null, error }));
        expect(params, `${outcome} ${error}`).toBeUndefined();
        for (const lang of LANGUAGES) expect(typeof catalog(lang)[key], `${lang} ${key}`).toBe('string');
      }
    }
    expect(resultText(entry({ outcome: 'refused', status: null, error: 'disabled' })).key).toBe('network.resultDisabled');
    expect(resultText(entry({ outcome: 'refused', status: null, error: 'busy' })).key).toBe('network.resultBusy');
    for (const error of ['host', 'scheme', 'path', 'method', 'invalid-url', 'not-registered', 'not-allowed']) expect(resultText(entry({ outcome: 'refused', status: null, error })).key, error).toBe('network.resultBlocked');
    const failed: Record<string, string> = { redirect: 'network.resultRedirect', 'too-large': 'network.resultTooLarge', timeout: 'network.resultTimeout', network: 'network.resultNetwork', 'bad-response': 'network.resultBadResponse', storage: 'network.resultFailed', 'hash-mismatch': 'network.resultFailed' };
    for (const [error, key] of Object.entries(failed)) expect(resultText(entry({ outcome: 'error', status: null, error })).key, error).toBe(key);
    expect(resultText(entry({ outcome: 'error', status: null, error: null })).key).toBe('network.resultFailed');
  });

  it('the tone: an answer below 400 is good, a running request waits, everything else is bad', () => {
    expect(resultTone(entry({ status: 200 }))).toBe('good');
    expect(resultTone(entry({ status: 399 }))).toBe('good');
    expect(resultTone(entry({ status: 404 }))).toBe('bad');
    expect(resultTone(entry({ status: 429 }))).toBe('bad');
    expect(resultTone(entry({ outcome: 'pending', status: null }))).toBe('wait');
    expect(resultTone(entry({ outcome: 'refused', status: null, error: 'host' }))).toBe('bad');
    expect(resultTone(entry({ outcome: 'error', status: null, error: 'timeout' }))).toBe('bad');
  });
});

describe('the state of a feature and the times', () => {
  it('a feature depends on the setting of the interface itself when it names one that exists, so the list follows the switch at once', () => {
    const feature = { id: 'update-check', hosts: ['api.github.com'], optIn: 'updateCheck', enabled: true };
    expect(featureEnabled(feature, settings({ updateCheck: true }))).toBe(true);
    expect(featureEnabled(feature, settings({ updateCheck: false }))).toBe(false);
    expect(featureEnabled({ ...feature, enabled: false }, settings({ updateCheck: true }))).toBe(true);
    expect(featureEnabled({ ...feature, optIn: 'someFutureSetting', enabled: false }, settings())).toBe(false);
    expect(featureEnabled({ ...feature, optIn: 'someFutureSetting', enabled: true }, settings())).toBe(true);
    expect(featureEnabled({ ...feature, optIn: 'language', enabled: false }, settings())).toBe(false);
    expect(featureEnabled({ ...feature, optIn: null, enabled: false }, settings({ updateCheck: false }))).toBe(true);
  });

  it.each(LANGUAGES)('%s: the time is the time of day in the language; a bad value is a dash', (lang) => {
    const text = formatActivityTime('2026-10-07T10:00:05.000Z', lang);
    expect(text).toMatch(/\d/);
    expect(text).not.toMatch(/2026|Invalid/);
    expect(formatActivityDateTime('2026-10-07T10:00:05.000Z', lang)).toContain('2026');
    expect(formatActivityTime('nonsense', lang)).toBe('—');
    expect(formatActivityDateTime('nonsense', lang)).toBe('');
  });
});

describe('the renderer asks the main process and never talks to the network itself', () => {
  it('the pure module and the component make no request, open no window and keep nothing: no fetch, XHR, WebSocket, address, link, window.open or storage', () => {
    for (const file of ['src/lib/network-activity.ts', 'src/components/NetworkSettings.tsx']) {
      const source = readSource(file);
      expect(source, file).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|https?:\/\/|window\.open|location\.|localStorage|sessionStorage|indexedDB|document\.cookie|dangerouslySetInnerHTML/);
      expect(source, file).not.toMatch(/<a\b|href=/);
    }
  });

  it('the Content-Security-Policy still allows connections to the page itself only', () => {
    const html = readSource('index.html');
    expect(html).toContain("connect-src 'self' ws://127.0.0.1:5173");
    expect(html).not.toMatch(/github/i);
  });

  it('the section is drawn by the Settings dialog only when the bridge has the calls, after the switches', () => {
    const dialog = readSource('src/components/workspace/Dialogs.tsx');
    expect(dialog).toMatch(/networkActivitySupported\(currentDesktop[(][)]\) && <NetworkSettings t=\{t\} language=\{language\} settings=\{settings\} \/>/);
    expect(dialog.indexOf('<UpdateSettings')).toBeLessThan(dialog.indexOf('<NetworkSettings'));
    expect(dialog.indexOf('<NetworkSettings')).toBeLessThan(dialog.indexOf('modal-footer'));
  });
});
