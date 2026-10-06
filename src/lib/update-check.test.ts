import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDesktop } from '../app/testing';
import { LANGUAGES, catalogs, translate } from './i18n';
import type { Language } from './i18n';
import type { TraceDesktop } from './types';
import {
  UPDATE_CHECK_OPT_OUT, UPDATE_KEYS, UPDATE_OPEN_FAILED_KEY, beginStartupUpdateCheck, checkNowOffersDownload, checkNowStatus, claimStartupUpdateCheck, createUpdateActions, currentDesktop,
  dismissStartupUpdate, getStartupUpdateState, normalizeUpdateResult, resetUpdateCheckLaunch, startupUpdateToShow, subscribeStartupUpdate, updateCheckAllowed, updateCheckSupported,
} from './update-check';
import type { CheckNowState } from './update-check';

/**
 * Update notification (decided scope: a NOTIFICATION that sends the user to the release page; nothing is downloaded or installed, because the Windows build is an
 * unsigned portable EXE and the macOS build is unsigned). These tests cover the pure logic: the copy in all eight catalogs, the bridge checks, the result
 * normalization, the once-per-launch check, the dismissal and the ordering rule. The main-process half (electron/updates.cjs and the two handlers) is tested in
 * tests/desktop-checks.cjs; the markup in src/components/update-notice-markup.test.ts.
 */
const readSource = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const SETTLE = async (): Promise<void> => { for (let index = 0; index < 5; index++) await Promise.resolve(); };

describe('copy', () => {
  const EN = catalogs.en as Record<string, string>;
  const HU = catalogs.hu as Record<string, string>;
  const ALL_KEYS = [...Object.values(UPDATE_KEYS), UPDATE_OPEN_FAILED_KEY];

  it('the keys are named update.setting/settingHint/checkNow/checking/current/available/failed/download/dismiss, plus update.openFailed', () => {
    expect(UPDATE_KEYS).toEqual({
      setting: 'update.setting', settingHint: 'update.settingHint', checkNow: 'update.checkNow', checking: 'update.checking', current: 'update.current',
      available: 'update.available', failed: 'update.failed', download: 'update.download', dismiss: 'update.dismiss',
    });
    expect(UPDATE_OPEN_FAILED_KEY).toBe('update.openFailed');
  });

  it('English reference text', () => {
    expect(EN['update.setting']).toBe('Check for updates when TRACE starts');
    expect(EN['update.settingHint']).toBe('Makes one request to github.com, sends nothing about you or your files and never installs anything.');
    expect(EN['update.checkNow']).toBe('Check now');
    expect(EN['update.checking']).toBe('Checking…');
    expect(EN['update.current']).toBe('TRACE is up to date.');
    expect(EN['update.available']).toBe('TRACE {version} is available.');
    expect(EN['update.failed']).toBe('Could not check for updates.');
    expect(EN['update.openFailed']).toBe('The download page could not be opened.');
    expect(EN['update.download']).toBe('Download');
    expect(EN['update.dismiss']).toBe('Dismiss');
  });

  it('Hungarian reference text', () => {
    expect(HU['update.setting']).toBe('Frissítések keresése a TRACE indításakor');
    expect(HU['update.checkNow']).toBe('Keresés most');
    expect(HU['update.available']).toBe('Elérhető a TRACE {version} verziója.');
    expect(HU['update.download']).toBe('Letöltés');
  });

  it.each(LANGUAGES)('%s: every key is a real, non-empty, single-line string that translate() renders (no key echoed back)', (lang: Language) => {
    for (const key of ALL_KEYS) {
      const value = (catalogs[lang] as Record<string, unknown>)[key];
      expect(typeof value, `${lang} ${key}`).toBe('string');
      expect((value as string).trim().length, `${lang} ${key}`).toBeGreaterThan(3);
      expect(value, `${lang} ${key} is single-line`).not.toMatch(/[\r\n]/);
      expect(translate(lang, key, { version: '1.2.1' }), `${lang} ${key}`).not.toBe(key);
    }
  });

  it.each(LANGUAGES)('%s: only update.available has a placeholder, exactly {version} once; it renders the version and the product name', (lang: Language) => {
    for (const key of ALL_KEYS) {
      const value = (catalogs[lang] as Record<string, string>)[key];
      const placeholders = [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
      expect(placeholders, `${lang} ${key}`).toEqual(key === UPDATE_KEYS.available ? ['version'] : []);
    }
    const text = translate(lang, UPDATE_KEYS.available, { version: '1.10.3' });
    expect(text, lang).toContain('1.10.3');
    expect(text, lang).toContain('TRACE');
    expect(text, lang).not.toMatch(/[{}]/);
  });

  it.each(LANGUAGES)('%s: the switch label, the "up to date" line and the strip text name TRACE; the hint names github.com, promises no more than one request and carries no link or number', (lang: Language) => {
    const text = (key: string): string => (catalogs[lang] as Record<string, string>)[key];
    for (const key of [UPDATE_KEYS.setting, UPDATE_KEYS.current, UPDATE_KEYS.available]) expect(text(key), `${lang} ${key}`).toContain('TRACE');
    const hint = text(UPDATE_KEYS.settingHint);
    expect(hint, lang).toContain('github.com');
    expect(hint, lang).not.toMatch(/https?:|www\.|\/|\d/);
    expect(hint.length, `${lang} hint length`).toBeLessThanOrEqual(150);
  });

  it.each(LANGUAGES)('%s: buttons are short and distinct; the status lines end like the English ones', (lang: Language) => {
    const text = (key: string): string => (catalogs[lang] as Record<string, string>)[key];
    expect(text(UPDATE_KEYS.checkNow).length, `${lang} checkNow`).toBeLessThanOrEqual(30);
    expect(text(UPDATE_KEYS.download).length, `${lang} download`).toBeLessThanOrEqual(20);
    expect(text(UPDATE_KEYS.dismiss).length, `${lang} dismiss`).toBeLessThanOrEqual(20);
    expect(new Set([text(UPDATE_KEYS.checkNow), text(UPDATE_KEYS.download), text(UPDATE_KEYS.dismiss)]).size, `${lang} three different labels`).toBe(3);
    expect(text(UPDATE_KEYS.checking), `${lang} checking`).toMatch(/…$/);
    for (const key of [UPDATE_KEYS.current, UPDATE_KEYS.available, UPDATE_KEYS.failed, UPDATE_OPEN_FAILED_KEY]) expect(text(key), `${lang} ${key}`).toMatch(/\.$/);
    for (const key of [UPDATE_KEYS.setting, UPDATE_KEYS.checkNow, UPDATE_KEYS.download, UPDATE_KEYS.dismiss]) expect(text(key), `${lang} ${key}`).not.toMatch(/[.…,]$/);
  });
});

describe('the desktop bridge', () => {
  const both = { checkForUpdates: async () => ({ status: 'current' as const }), openUpdatePage: async () => undefined };

  it('is usable only with both calls: browser-only development mode and an older preload show and request nothing', () => {
    expect(updateCheckSupported(both)).toBe(true);
    expect(updateCheckSupported(undefined)).toBe(false);
    expect(updateCheckSupported(null)).toBe(false);
    expect(updateCheckSupported({})).toBe(false);
    expect(updateCheckSupported({ checkForUpdates: both.checkForUpdates })).toBe(false);
    expect(updateCheckSupported({ openUpdatePage: both.openUpdatePage })).toBe(false);
    expect(updateCheckSupported({ checkForUpdates: 'x', openUpdatePage: 'y' } as unknown as Partial<TraceDesktop>)).toBe(false);
    expect(updateCheckSupported(createFakeDesktop())).toBe(true);
  });

  it('there is no bridge without a window (the unit tests, server rendering)', () => {
    expect(currentDesktop()).toBeUndefined();
  });

  it('whatever crosses the bridge becomes one of three results; only status and a plain-digit version are kept', () => {
    expect(normalizeUpdateResult({ status: 'current' })).toEqual({ status: 'current' });
    expect(normalizeUpdateResult({ status: 'unavailable' })).toEqual({ status: 'unavailable' });
    expect(normalizeUpdateResult({ status: 'available', version: '1.2.1' })).toEqual({ status: 'available', version: '1.2.1' });
    expect(normalizeUpdateResult({ status: 'available', version: '1.10.0', tag: 'v1.10.0', url: 'https://evil.example/' })).toEqual({ status: 'available', version: '1.10.0' });
    expect(normalizeUpdateResult({ status: 'current', version: '9.9.9' })).toEqual({ status: 'current' });
    for (const value of [
      undefined, null, 0, 'available', [], {}, { status: 'available' }, { status: 'available', version: 121 }, { status: 'available', version: 'v1.2.1' }, { status: 'available', version: '1.2' },
      { status: 'available', version: '1.2.1-rc1' }, { status: 'available', version: '1.2.1 ' }, { status: 'available', version: '<img src=x onerror=1>' }, { status: 'available', version: '12345.0.0' },
      { status: 'AVAILABLE', version: '1.2.1' }, { status: 'error' }, { status: 'ok' },
    ]) {
      expect(normalizeUpdateResult(value), JSON.stringify(value)).toEqual({ status: 'unavailable' });
    }
  });
});

describe('createUpdateActions', () => {
  it('check asks the bridge once, with no argument, and returns the normalized answer (the tag and any other field are dropped)', async () => {
    const checkForUpdates = vi.fn(async () => ({ status: 'available', version: '1.2.1', tag: 'v1.2.1', html_url: 'https://evil.example/' }) as never);
    const actions = createUpdateActions({ checkForUpdates, openUpdatePage: async () => undefined });
    await expect(actions.check()).resolves.toEqual({ status: 'available', version: '1.2.1' });
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(checkForUpdates).toHaveBeenCalledWith();
  });

  it('a rejected or throwing check is "unavailable" (never an error); the next check works', async () => {
    let mode: 'reject' | 'throw' | 'ok' = 'reject';
    const checkForUpdates = vi.fn(async () => {
      if (mode === 'throw') throw new Error('sync');
      if (mode === 'reject') await Promise.reject(new Error('Error invoking remote method'));
      return { status: 'current' as const };
    });
    const actions = createUpdateActions({ checkForUpdates, openUpdatePage: async () => undefined });
    await expect(actions.check()).resolves.toEqual({ status: 'unavailable' });
    mode = 'throw';
    await expect(actions.check()).resolves.toEqual({ status: 'unavailable' });
    mode = 'ok';
    await expect(actions.check()).resolves.toEqual({ status: 'current' });
    const syncThrower = createUpdateActions({ checkForUpdates: (() => { throw new Error('plain throw'); }) as never, openUpdatePage: async () => undefined });
    await expect(syncThrower.check()).resolves.toEqual({ status: 'unavailable' });
  });

  it('a second check while one is running is ignored (a double click asks once); there is no answer without the bridge or with an older one', async () => {
    let release: (value: { status: 'current' }) => void = () => {};
    const checkForUpdates = vi.fn(() => new Promise<{ status: 'current' }>(resolve => { release = resolve; }));
    const actions = createUpdateActions({ checkForUpdates, openUpdatePage: async () => undefined });
    const first = actions.check();
    await expect(actions.check()).resolves.toBeNull();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    release({ status: 'current' });
    await expect(first).resolves.toEqual({ status: 'current' });
    await expect(createUpdateActions(undefined).check()).resolves.toBeNull();
    await expect(createUpdateActions({}).check()).resolves.toBeNull();
    await expect(createUpdateActions({ checkForUpdates: checkForUpdates }).check()).resolves.toBeNull();
  });

  it('open asks the bridge with no argument and says whether the system accepted it; a failure or a missing bridge is false, a double click opens once', async () => {
    const openUpdatePage = vi.fn(async () => undefined);
    const actions = createUpdateActions({ checkForUpdates: async () => ({ status: 'current' }), openUpdatePage });
    await expect(actions.open()).resolves.toBe(true);
    expect(openUpdatePage).toHaveBeenCalledTimes(1);
    expect(openUpdatePage).toHaveBeenCalledWith();
    const failing = createUpdateActions({ checkForUpdates: async () => ({ status: 'current' }), openUpdatePage: async () => { throw new Error('No update available.'); } });
    await expect(failing.open()).resolves.toBe(false);
    await expect(createUpdateActions(undefined).open()).resolves.toBe(false);
    let release: () => void = () => {};
    const slow = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = createUpdateActions({ checkForUpdates: async () => ({ status: 'current' }), openUpdatePage: slow });
    const first = pending.open();
    await expect(pending.open()).resolves.toBe(false);
    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toBe(true);
  });
});

describe('Check now status line', () => {
  const done = (result: { status: 'available'; version: string } | { status: 'current' } | { status: 'unavailable' }, openFailed?: boolean): CheckNowState => ({ phase: 'done', result, ...(openFailed ? { openFailed } : {}) });

  it('says nothing before the first press, then Checking…, Up to date, TRACE X is available, or Could not check', () => {
    expect(checkNowStatus({ phase: 'idle' })).toBeNull();
    expect(checkNowStatus({ phase: 'checking' })).toEqual({ key: 'update.checking' });
    expect(checkNowStatus(done({ status: 'current' }))).toEqual({ key: 'update.current' });
    expect(checkNowStatus(done({ status: 'unavailable' }))).toEqual({ key: 'update.failed' });
    expect(checkNowStatus(done({ status: 'available', version: '1.2.1' }))).toEqual({ key: 'update.available', params: { version: '1.2.1' } });
  });

  it('a Download that could not open the page replaces the line with the polite failure text, and the Download button stays', () => {
    const state = done({ status: 'available', version: '1.2.1' }, true);
    expect(checkNowStatus(state)).toEqual({ key: 'update.openFailed' });
    expect(checkNowOffersDownload(state)).toBe(true);
  });

  it('the Download button belongs to an "available" answer only', () => {
    expect(checkNowOffersDownload({ phase: 'idle' })).toBe(false);
    expect(checkNowOffersDownload({ phase: 'checking' })).toBe(false);
    expect(checkNowOffersDownload(done({ status: 'current' }))).toBe(false);
    expect(checkNowOffersDownload(done({ status: 'unavailable' }))).toBe(false);
    expect(checkNowOffersDownload(done({ status: 'available', version: '1.2.1' }))).toBe(true);
  });
});

describe('the check at start', () => {
  beforeEach(() => resetUpdateCheckLaunch());
  const available = (): ReturnType<typeof createFakeDesktop> => { const desktop = createFakeDesktop(); desktop.updateResult = { status: 'available', version: '1.2.1' }; return desktop; };

  it('there is exactly one check per launch: the claim is taken once (React StrictMode runs effects twice)', async () => {
    expect(claimStartupUpdateCheck()).toBe(true);
    expect(claimStartupUpdateCheck()).toBe(false);
    resetUpdateCheckLaunch();
    const desktop = available();
    await Promise.all([beginStartupUpdateCheck(desktop, true), beginStartupUpdateCheck(desktop, true), beginStartupUpdateCheck(desktop, true)]);
    expect(desktop.log.filter(entry => entry === 'checkForUpdates')).toHaveLength(1);
  });

  it('with the setting off nothing is requested, and switching it on later in the same launch does not start a request either (Check now is for that)', async () => {
    const desktop = available();
    await beginStartupUpdateCheck(desktop, false);
    await beginStartupUpdateCheck(desktop, true);
    expect(desktop.log).toEqual([]);
    expect(getStartupUpdateState().result).toBeNull();
  });

  it('without the bridge (browser development mode) or with an older preload nothing happens and nothing throws', async () => {
    await expect(beginStartupUpdateCheck(undefined, true)).resolves.toBeUndefined();
    expect(getStartupUpdateState().result).toBeNull();
    resetUpdateCheckLaunch();
    await expect(beginStartupUpdateCheck({} as Partial<TraceDesktop>, true)).resolves.toBeUndefined();
    expect(getStartupUpdateState().result).toBeNull();
  });

  it('an "available" answer is shown with its version; "current", "unavailable" and a failing bridge show nothing', async () => {
    const desktop = available();
    await beginStartupUpdateCheck(desktop, true);
    expect(getStartupUpdateState().result).toEqual({ status: 'available', version: '1.2.1' });
    expect(startupUpdateToShow(getStartupUpdateState(), true)).toBe('1.2.1');
    for (const result of [{ status: 'current' }, { status: 'unavailable' }] as const) {
      resetUpdateCheckLaunch();
      const quiet = createFakeDesktop();
      quiet.updateResult = result;
      await beginStartupUpdateCheck(quiet, true);
      expect(startupUpdateToShow(getStartupUpdateState(), true), result.status).toBeNull();
    }
    resetUpdateCheckLaunch();
    const broken = createFakeDesktop();
    broken.failures.checkForUpdates = () => new Error('Error invoking remote method');
    await expect(beginStartupUpdateCheck(broken, true)).resolves.toBeUndefined();
    expect(startupUpdateToShow(getStartupUpdateState(), true)).toBeNull();
  });

  it('the strip waits for the support notice: while that dialog is open (allowed = false) nothing is shown, and the answer is kept for later', async () => {
    await beginStartupUpdateCheck(available(), true);
    const state = getStartupUpdateState();
    expect(startupUpdateToShow(state, false)).toBeNull();
    expect(startupUpdateToShow(state, true)).toBe('1.2.1');
  });

  it('dismissal lasts for the launch (the strip stays closed, whatever happens next) and a new launch starts clean', async () => {
    await beginStartupUpdateCheck(available(), true);
    dismissStartupUpdate();
    expect(startupUpdateToShow(getStartupUpdateState(), true)).toBeNull();
    await beginStartupUpdateCheck(available(), true);
    expect(startupUpdateToShow(getStartupUpdateState(), true)).toBeNull();
    resetUpdateCheckLaunch();
    expect(getStartupUpdateState()).toEqual({ claimed: false, result: null, dismissed: false });
  });

  it('only an "available" answer that is not dismissed produces a version, and only when allowed', () => {
    const state = (over: Partial<ReturnType<typeof getStartupUpdateState>>) => ({ claimed: true, result: null, dismissed: false, ...over });
    expect(startupUpdateToShow(state({ result: { status: 'available', version: '2.0.0' } }), true)).toBe('2.0.0');
    expect(startupUpdateToShow(state({ result: { status: 'available', version: '2.0.0' }, dismissed: true }), true)).toBeNull();
    expect(startupUpdateToShow(state({ result: { status: 'available', version: '2.0.0' } }), false)).toBeNull();
    expect(startupUpdateToShow(state({ result: { status: 'current' } }), true)).toBeNull();
    expect(startupUpdateToShow(state({ result: { status: 'unavailable' } }), true)).toBeNull();
    expect(startupUpdateToShow(state({}), true)).toBeNull();
  });

  it('subscribers hear about the claim, the answer and a dismissal, and stop hearing after they unsubscribe', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeStartupUpdate(listener);
    await beginStartupUpdateCheck(available(), true);
    await SETTLE();
    expect(listener).toHaveBeenCalledTimes(2);
    dismissStartupUpdate();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    resetUpdateCheckLaunch();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('only the explicit QA flag "off" on the global scope switches the check off (it is never stored, and it can never switch a check on)', () => {
    expect(updateCheckAllowed({})).toBe(true);
    expect(updateCheckAllowed({ [UPDATE_CHECK_OPT_OUT]: 'off' })).toBe(false);
    for (const value of [true, false, 'on', 'OFF', 0, null, undefined, 'no']) expect(updateCheckAllowed({ [UPDATE_CHECK_OPT_OUT]: value }), String(value)).toBe(true);
    expect(updateCheckAllowed()).toBe(true); // the vitest global has no flag
    expect(UPDATE_CHECK_OPT_OUT).toBe('__TRACE_UPDATE_CHECK__');
    expect(readSource('src/components/UpdateNotice.tsx')).toContain('beginStartupUpdateCheck(currentDesktop(), enabledNow.current && updateCheckAllowed())');
  });
});

describe('the renderer asks the main process and never talks to the network itself', () => {
  it('the pure module and the component make no request, open no window and keep nothing: no fetch, XHR, WebSocket, link, window.open or storage', () => {
    for (const file of ['src/lib/update-check.ts', 'src/components/UpdateNotice.tsx']) {
      const source = readSource(file);
      expect(source, file).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\/|window\.open|location\.|localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(source, file).not.toMatch(/<a\b|href=/);
    }
  });

  it('the Content-Security-Policy still allows connections to the page itself only: connect-src has no GitHub', () => {
    const html = readSource('index.html');
    expect(html).toContain("connect-src 'self' ws://127.0.0.1:5173");
    expect(html).not.toMatch(/github/i);
  });

  it('the check starts only once the shell is ready, and the strip is shown only after the support notice is out of the way (Shell wiring)', () => {
    expect(readSource('src/components/UpdateNotice.tsx')).toMatch(/if \(ready\) void beginStartupUpdateCheck\(/);
    const shell = readSource('src/components/workspace/Shell.tsx');
    expect(shell).toMatch(/<UpdateNotice [^>]*enabled=\{settings\.updateCheck\}[^>]*ready=\{ready\}[^>]*after=\{supportSettled\}/);
    expect(shell).toMatch(/<SupportNotice [^>]*onSettled=\{onSupportSettled\}/);
    expect(shell.indexOf('<UpdateNotice'), 'the strip sits right under the top bar').toBeGreaterThan(shell.indexOf('<TopBar'));
    expect(shell.indexOf('<UpdateNotice')).toBeLessThan(shell.indexOf('className="workspace"'));
  });
});

describe('fake desktop bridge (src/app/testing.ts)', () => {
  it('answers "up to date" by default, logs the calls and reads no argument', async () => {
    const desktop = createFakeDesktop();
    await expect(desktop.checkForUpdates!()).resolves.toEqual({ status: 'current' });
    expect(desktop.log).toEqual(['checkForUpdates']);
    desktop.updateResult = { status: 'available', version: '1.2.1' };
    await expect(desktop.checkForUpdates!()).resolves.toEqual({ status: 'available', version: '1.2.1' });
  });

  it('openUpdatePage rejects like the main process until a check found a newer release, then logs the open', async () => {
    const desktop = createFakeDesktop();
    await expect(desktop.openUpdatePage!()).rejects.toThrow('No update available.');
    desktop.updateResult = { status: 'available', version: '1.2.1' };
    await desktop.checkForUpdates!();
    await desktop.openUpdatePage!();
    expect(desktop.log).toEqual(['checkForUpdates', 'openUpdatePage']);
    desktop.updateResult = { status: 'current' };
    await desktop.checkForUpdates!();
    await expect(desktop.openUpdatePage!()).rejects.toThrow('No update available.');
  });

  it('holds and failures apply to both calls like to every other call', async () => {
    const desktop = createFakeDesktop();
    desktop.failures.checkForUpdates = () => new Error('offline');
    await expect(desktop.checkForUpdates!()).rejects.toThrow('offline');
    await expect(createUpdateActions(desktop).check()).resolves.toEqual({ status: 'unavailable' });
  });
});
