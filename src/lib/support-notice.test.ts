import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDesktop } from '../app/testing';
import { LANGUAGES, catalogs, translate } from './i18n';
import type { Language } from './i18n';
import {
  BUG_REPORT_FAILED_KEY, SUPPORT_BUTTON_FAILED_KEY, SUPPORT_BUTTON_KEY, SUPPORT_LINK_IDS, SUPPORT_NOTICE_KEYS, SUPPORT_NOTICE_OPT_OUT, WEB_SUPPORT_LINKS,
  claimSupportNotice, closesOnBackdrop, createBackdropDismisser, createSupportLinkRequester, isSupportLinkId, openFixedLink, openSupportLinkInBrowser,
  resetSupportNoticeLaunch, resolveSupportLinkOpener, supportNoticeAllowed, postponeSupportNotice, SUPPORT_REMINDER_INTERVAL_MS,
} from './support-notice';
import type { SupportLinkId, SupportLinkOpener } from './support-notice';

/**
 * Support notice (a short notice on EVERY start, easy to skip, never blocking). These tests cover the pure
 * logic: the id allow-list, the once-per-launch claim, the copy in all eight catalogs, the link request flow and the web fallback.
 * The main-process allow-list itself is tested in tests/desktop-checks.cjs (trace:open-support-link).
 */
const STRIPE = 'https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00';
const KOFI = 'https://ko-fi.com/tracerboardview';
const BUG = 'https://github.com/trace-boardviewer/trace-boardviewer/issues/new?template=bug_report.yml';
const SUPPORT_PAGE = 'https://trace-boardviewer.github.io/support.html';
const readSource = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

describe('link ids', () => {
  it('there are exactly four ids, stripe, kofi, bug and support, in this order', () => {
    expect([...SUPPORT_LINK_IDS]).toEqual(['stripe', 'kofi', 'bug', 'support']);
  });

  it('isSupportLinkId accepts those four strings and nothing else (case, spacing, prototype names, URLs, non-strings)', () => {
    expect(isSupportLinkId('stripe')).toBe(true);
    expect(isSupportLinkId('kofi')).toBe(true);
    expect(isSupportLinkId('bug')).toBe(true);
    expect(isSupportLinkId('support')).toBe(true);
    for (const value of ['Stripe', 'KOFI', ' stripe', 'kofi ', '', 'ko-fi', 'Bug', 'bug ', 'issues', 'Support', 'SUPPORT', ' support', 'support ', 'supports', 'website', 'constructor', '__proto__', 'toString', STRIPE, KOFI, BUG, SUPPORT_PAGE, 'https://evil.example/', undefined, null, 0, true, ['stripe'], ['support'], { id: 'stripe' }, { id: 'support' }, new String('stripe'), new String('support')]) {
      expect(isSupportLinkId(value), String(value)).toBe(false);
    }
  });
});

describe('once per launch', () => {
  beforeEach(() => resetSupportNoticeLaunch());

  it('the first claim wins, every later claim of the same launch is refused (React StrictMode mounts effects twice)', () => {
    expect(claimSupportNotice()).toBe(true);
    expect(claimSupportNotice()).toBe(false);
    expect(claimSupportNotice()).toBe(false);
  });

  it('waits a full hour, allows one reminder at the boundary and never catches up with several missed reminders', () => {
    expect(claimSupportNotice(100)).toBe(true);
    expect(claimSupportNotice(100 + SUPPORT_REMINDER_INTERVAL_MS - 1)).toBe(false);
    expect(claimSupportNotice(100 + SUPPORT_REMINDER_INTERVAL_MS)).toBe(true);
    expect(claimSupportNotice(100 + SUPPORT_REMINDER_INTERVAL_MS)).toBe(false);
    expect(claimSupportNotice(100 + 8 * SUPPORT_REMINDER_INTERVAL_MS)).toBe(true);
    expect(claimSupportNotice(100 + 8 * SUPPORT_REMINDER_INTERVAL_MS)).toBe(false);
  });

  it('gives another full hour after dismissal, even when the reminder was left open for longer', () => {
    expect(claimSupportNotice(0)).toBe(true);
    postponeSupportNotice(2 * SUPPORT_REMINDER_INTERVAL_MS);
    expect(claimSupportNotice(3 * SUPPORT_REMINDER_INTERVAL_MS - 1)).toBe(false);
    expect(claimSupportNotice(3 * SUPPORT_REMINDER_INTERVAL_MS)).toBe(true);
  });

  it('handles an invalid or backwards clock without repeated popups', () => {
    expect(claimSupportNotice(NaN)).toBe(false);
    expect(claimSupportNotice(1000)).toBe(true);
    expect(claimSupportNotice(500)).toBe(false);
    expect(claimSupportNotice(500)).toBe(false);
    expect(claimSupportNotice(500 + SUPPORT_REMINDER_INTERVAL_MS)).toBe(true);
  });

  it('a new launch (fresh module state) shows the notice again: there is no "do not show again" memory', () => {
    expect(claimSupportNotice()).toBe(true);
    resetSupportNoticeLaunch();
    expect(claimSupportNotice()).toBe(true);
    // Nothing is persisted: the state lives in the module only.
    const source = readSource('src/lib/support-notice.ts');
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });

  it('only the explicit QA flag "off" on the global scope suppresses the notice (it is never persisted)', () => {
    expect(supportNoticeAllowed({})).toBe(true);
    expect(supportNoticeAllowed({ [SUPPORT_NOTICE_OPT_OUT]: 'off' })).toBe(false);
    for (const value of [true, false, 'on', 'OFF', 0, null, undefined, 'no']) expect(supportNoticeAllowed({ [SUPPORT_NOTICE_OPT_OUT]: value }), String(value)).toBe(true);
    expect(supportNoticeAllowed()).toBe(true); // the vitest global has no flag
  });
});

describe('copy', () => {
  const EN = catalogs.en as Record<string, string>;
  const HU = catalogs.hu as Record<string, string>;

  it('the eight keys are named support.title/body/thanks/testing/stripe/kofi/bug/notNow', () => {
    expect(SUPPORT_NOTICE_KEYS).toEqual({
      title: 'support.title', body: 'support.body', thanks: 'support.thanks', testing: 'support.testing', stripe: 'support.stripe', kofi: 'support.kofi', bug: 'support.bug', notNow: 'support.notNow',
    });
    expect(BUG_REPORT_FAILED_KEY).toBe('support.bugFailed');
  });

  it('the top bar heart button has its own two keys, support.button and support.buttonFailed, apart from the notice keys', () => {
    expect(SUPPORT_BUTTON_KEY).toBe('support.button');
    expect(SUPPORT_BUTTON_FAILED_KEY).toBe('support.buttonFailed');
    expect(Object.values(SUPPORT_NOTICE_KEYS)).not.toContain(SUPPORT_BUTTON_KEY);
  });

  it('the heart button reads "Support TRACE" in all eight languages (the label and the tooltip are the same string)', () => {
    const expected: Record<Language, string> = {
      hu: 'TRACE támogatása', en: 'Support TRACE', de: 'TRACE unterstützen', fr: 'Soutenir TRACE', it: 'Sostieni TRACE', sk: 'Podporiť TRACE', pl: 'Wesprzyj TRACE', uk: 'Підтримати TRACE',
    };
    for (const lang of LANGUAGES) expect((catalogs[lang] as Record<string, string>)[SUPPORT_BUTTON_KEY], lang).toBe(expected[lang]);
  });

  it.each(LANGUAGES)('%s: the heart button label names TRACE and is short; its failure toast is a one-line sentence', (lang: Language) => {
    const catalog = catalogs[lang] as Record<string, string>;
    expect(translate(lang, SUPPORT_BUTTON_KEY), lang).toBe(catalog[SUPPORT_BUTTON_KEY]);
    expect(translate(lang, SUPPORT_BUTTON_FAILED_KEY), lang).toBe(catalog[SUPPORT_BUTTON_FAILED_KEY]);
    expect(catalog[SUPPORT_BUTTON_KEY], `${lang} label`).toContain('TRACE');
    expect(catalog[SUPPORT_BUTTON_KEY].length, `${lang} label length`).toBeLessThanOrEqual(30);
    expect(catalog[SUPPORT_BUTTON_FAILED_KEY], `${lang} toast ends like a sentence`).toMatch(/\.$/);
    expect(catalog[SUPPORT_BUTTON_FAILED_KEY], `${lang} toast is single-line`).not.toMatch(/[\r\n]/);
    expect(catalog[SUPPORT_BUTTON_KEY], `${lang} label differs from the bug button`).not.toBe(catalog[SUPPORT_NOTICE_KEYS.bug]);
  });

  it('English reference text', () => {
    expect(EN['support.title']).toBe('TRACE is free and stays free');
    expect(EN['support.body']).toBe('If TRACE saves you time at the bench, please support its further development with €5. Your support pays for the development tools and services behind TRACE, the Windows code-signing certificate, the Apple Developer Program needed to sign the macOS build, the website and new projects — the next one is coming soon and will later be integrated into TRACE.');
    expect(EN['support.thanks']).toBe('Thank you to everyone who already supports TRACE ❤');
    expect(EN['support.stripe']).toBe('Support with €5');
    expect(EN['support.kofi']).toBe('Buy a coffee on Ko-fi');
    expect(EN['support.testing']).toBe('Thank you very much for testing TRACE and sharing your opinion, special thanks for that! If you find a bug, please be sure to report it.');
    expect(EN['support.bug']).toBe('Report a bug');
    expect(EN['support.notNow']).toBe('Not now');
  });

  it('Hungarian reference text', () => {
    expect(HU['support.title']).toBe('A TRACE ingyenes, és az is marad');
    expect(HU['support.body']).toBe('Ha a TRACE időt spórol neked a műhelyben, kérlek támogasd a további fejlesztését 5 euróval. A támogatás a fejlesztés eszközeire és szolgáltatásaira, a windowsos kódaláíró tanúsítványra, a macOS-build aláírásához szükséges Apple Developer Program tagságra, a weboldalra és az új projektek elindítására megy — a következő hamarosan érkezik, és később a TRACE-be kerül integrálásra.');
    expect(HU['support.thanks']).toBe('Köszönjük mindenkinek, aki már támogatja a TRACE-t ❤');
    expect(HU['support.stripe']).toBe('Támogatom 5 euróval');
    expect(HU['support.kofi']).toBe('Egy kávé a Ko-fi-n');
    expect(HU['support.testing']).toBe('Nagyon köszönöm, ha teszteled a TRACE-t és megosztod a véleményed, külön köszönet érte! Ha bugot találsz, kérlek mindenképp jelezd.');
    expect(HU['support.bug']).toBe('Hiba bejelentése');
    expect(HU['support.notNow']).toBe('Most nem');
  });

  it.each(LANGUAGES)('%s: all eight keys (and the bug toast key) are real, non-empty, single-line strings that translate() renders (no key echoed back)', (lang: Language) => {
    for (const key of [...Object.values(SUPPORT_NOTICE_KEYS), BUG_REPORT_FAILED_KEY]) {
      const value = (catalogs[lang] as Record<string, unknown>)[key];
      expect(typeof value, `${lang} ${key}`).toBe('string');
      expect((value as string).trim().length, `${lang} ${key}`).toBeGreaterThan(2);
      expect(value, `${lang} ${key} is single-line`).not.toMatch(/[\r\n]/);
      expect(translate(lang, key), `${lang} ${key}`).toBe(value);
    }
  });

  it.each(LANGUAGES)('%s: TRACE, Ko-fi and the amount 5 survive translation; the body names the money once and fits the dialog', (lang: Language) => {
    const text = (key: keyof typeof SUPPORT_NOTICE_KEYS): string => (catalogs[lang] as Record<string, string>)[SUPPORT_NOTICE_KEYS[key]];
    for (const key of ['title', 'body', 'thanks', 'testing'] as const) expect(text(key), `${lang} ${key}`).toContain('TRACE');
    expect(text('testing').length, `${lang} testing length`).toBeLessThanOrEqual(220);
    expect(text('testing'), `${lang} testing ends like a sentence`).toMatch(/[.!]$/);
    expect(text('kofi'), lang).toContain('Ko-fi');
    for (const key of ['body', 'stripe'] as const) expect(text(key), `${lang} ${key}`).toMatch(/(?<!\d)5(?!\d)/);
    if (lang !== 'hu') for (const key of ['body', 'stripe'] as const) expect(text(key), `${lang} ${key}`).toContain('€5');
    expect(text('thanks'), lang).toContain('❤');
    expect(text('body').length, `${lang} body length`).toBeLessThanOrEqual(420);
    expect(text('body'), `${lang} body ends like a sentence`).toMatch(/\.$/);
    expect(text('title').length, `${lang} title length`).toBeLessThanOrEqual(60);
    for (const key of ['stripe', 'kofi', 'bug', 'notNow'] as const) expect(text(key).length, `${lang} ${key} length`).toBeLessThanOrEqual(40);
    expect(text('bug'), `${lang} bug button is its own label`).not.toBe(text('kofi'));
    expect(text('stripe'), `${lang} Stripe button is not the Ko-fi button`).not.toBe(text('kofi'));
    expect(text('notNow'), `${lang} skip button`).not.toBe(text('stripe'));
  });

  it('the notice carries no "don\'t show again" text in any language (it is meant to appear on every start)', () => {
    const forbidden = /don't show|do not show|never show|nie wieder|nicht mehr anzeigen|ne plus afficher|non mostrare|nem jelenjen|nezobrazovať|не показувати|więcej nie|többé/i;
    for (const lang of LANGUAGES) for (const key of Object.values(SUPPORT_NOTICE_KEYS)) expect((catalogs[lang] as Record<string, string>)[key], `${lang} ${key}`).not.toMatch(forbidden);
  });
});

describe('link requests (the renderer sends an id, never a URL)', () => {
  it('a valid id reaches the opener once, as the id, and resolves true so the dialog can close', async () => {
    const open = vi.fn(async (_id: SupportLinkId) => undefined);
    const requester = createSupportLinkRequester(open);
    await expect(requester.request('stripe')).resolves.toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('stripe');
    await expect(requester.request('kofi')).resolves.toBe(true);
    await expect(requester.request('support')).resolves.toBe(true);
    expect(open.mock.calls).toEqual([['stripe'], ['kofi'], ['support']]);
  });

  it('an unknown id, a URL or a non-string never reaches the opener and resolves false', async () => {
    const open = vi.fn();
    const requester = createSupportLinkRequester(open);
    for (const value of ['paypal', STRIPE, KOFI, SUPPORT_PAGE, '', 'Stripe', 'Support', undefined, null, 5, {}, ['stripe'], ['support']]) {
      await expect(requester.request(value), String(value)).resolves.toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('a failing opener (rejected promise or synchronous throw) resolves false, keeps the dialog open and allows a retry', async () => {
    let mode: 'reject' | 'throw' | 'ok' = 'reject';
    const open = vi.fn(async (_id: SupportLinkId) => {
      if (mode === 'throw') throw new Error('sync');
      if (mode === 'reject') await Promise.reject(new Error('async'));
    });
    const requester = createSupportLinkRequester(open);
    await expect(requester.request('stripe')).resolves.toBe(false);
    mode = 'throw';
    await expect(requester.request('kofi')).resolves.toBe(false);
    expect(requester.pending).toBe(false);
    mode = 'ok';
    await expect(requester.request('kofi')).resolves.toBe(true);
    expect(open).toHaveBeenCalledTimes(3);
    const syncThrower = createSupportLinkRequester(() => { throw new Error('plain throw'); });
    await expect(syncThrower.request('stripe')).resolves.toBe(false);
  });

  it('a double click while the first request is still pending opens nothing twice', async () => {
    let release: () => void = () => {};
    const open = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const requester = createSupportLinkRequester(open);
    const first = requester.request('stripe');
    expect(requester.pending).toBe(true);
    await expect(requester.request('stripe')).resolves.toBe(false);
    await expect(requester.request('kofi')).resolves.toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toBe(true);
    expect(requester.pending).toBe(false);
  });
});

describe('openFixedLink (the top bar link buttons)', () => {
  it('asks the opener of the moment for exactly the id, once, and reports nothing on success', async () => {
    const open = vi.fn(async (_id: SupportLinkId) => undefined);
    const failed = vi.fn();
    await expect(openFixedLink('support', () => open, failed)).resolves.toBeUndefined();
    expect(open.mock.calls).toEqual([['support']]);
    expect(failed).not.toHaveBeenCalled();
  });

  it('a rejected opener, a throwing opener and a throwing resolver each report the failure once and never reject', async () => {
    for (const resolver of [
      () => async () => { throw new Error('no browser'); },
      () => () => { throw new Error('sync'); },
      () => { throw new Error('no bridge'); },
    ] as Array<() => SupportLinkOpener>) {
      const failed = vi.fn();
      await expect(openFixedLink('support', resolver, failed)).resolves.toBeUndefined();
      expect(failed).toHaveBeenCalledTimes(1);
    }
  });

  it('goes through the desktop bridge when there is one and never falls back to window.open inside it', async () => {
    const openSupportLink = vi.fn(async (_id: SupportLinkId) => undefined);
    const openWindow = vi.fn();
    await openFixedLink('support', () => resolveSupportLinkOpener({ openSupportLink }, openWindow), () => undefined);
    expect(openSupportLink.mock.calls).toEqual([['support']]);
    const failed = vi.fn();
    await openFixedLink('support', () => resolveSupportLinkOpener({}, openWindow), failed);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });
});

describe('opener selection and the browser-only fallback', () => {
  it('the desktop bridge gets the id and nothing else', async () => {
    const openSupportLink = vi.fn(async (_id: SupportLinkId) => undefined);
    const open = resolveSupportLinkOpener({ openSupportLink }, () => { throw new Error('the browser fallback must not run in the desktop app'); });
    await open('kofi');
    await open('support');
    expect(openSupportLink.mock.calls).toEqual([['kofi'], ['support']]);
  });

  it('an older desktop bridge without openSupportLink rejects instead of opening a window (the renderer never falls back to window.open inside Electron)', async () => {
    const openWindow = vi.fn();
    const open = resolveSupportLinkOpener({}, openWindow);
    await expect(Promise.resolve(open('stripe'))).rejects.toThrow(/not available/i);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('without a desktop bridge (browser-only dev mode) the exact constants open in a new context with noopener', async () => {
    const openWindow = vi.fn(() => null);
    const open = resolveSupportLinkOpener(undefined, openWindow);
    await open('stripe');
    await open('kofi');
    await open('support');
    expect(openWindow.mock.calls).toEqual([[STRIPE, '_blank', 'noopener'], [KOFI, '_blank', 'noopener'], [SUPPORT_PAGE, '_blank', 'noopener']]);
  });

  it('the web constants are exactly the four links of the main process, keyed by the four ids; the bug form address comes from the one repository slug', () => {
    expect({ ...WEB_SUPPORT_LINKS }).toEqual({ stripe: STRIPE, kofi: KOFI, bug: BUG, support: SUPPORT_PAGE });
    expect(Object.isFrozen(WEB_SUPPORT_LINKS)).toBe(true);
    const main = readSource('electron/main.cjs');
    for (const url of [STRIPE, KOFI, SUPPORT_PAGE]) expect(main.split(url).length - 1, `${url} appears once in electron/main.cjs`).toBe(1);
    expect(readSource('src/lib/support-notice.ts').split(SUPPORT_PAGE).length - 1, 'the browser-only table names the support page once').toBe(1);
    for (const id of SUPPORT_LINK_IDS) expect(main, `main.cjs maps ${id}`).toMatch(new RegExp(`\\b${id}:\\s*[\`']https://`));
    // The slug is written once, in electron/repository.json; both processes build the bug form address from it and neither names a repository of its own.
    expect(JSON.parse(readSource('electron/repository.json'))).toEqual({ repository: 'trace-boardviewer/trace-boardviewer' });
    expect(main).toContain('bug: `https://github.com/${updates.REPOSITORY}/issues/new?template=bug_report.yml`');
    expect(readSource('src/lib/support-notice.ts')).toContain('bug: `https://github.com/${github.repository}/issues/new?template=bug_report.yml`');
    for (const file of ['electron/main.cjs', 'electron/updates.cjs', 'src/lib/support-notice.ts']) expect(readSource(file), `${file} names no repository of its own`).not.toMatch(/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+/);
  });

  it('openSupportLinkInBrowser refuses ids outside the allow-list', async () => {
    const openWindow = vi.fn();
    await expect(openSupportLinkInBrowser('paypal' as SupportLinkId, openWindow)).rejects.toThrow(/unknown support link/i);
    await expect(openSupportLinkInBrowser(STRIPE as SupportLinkId, openWindow)).rejects.toThrow(/unknown support link/i);
    await expect(openSupportLinkInBrowser(SUPPORT_PAGE as SupportLinkId, openWindow)).rejects.toThrow(/unknown support link/i);
    await expect(openSupportLinkInBrowser('Support' as SupportLinkId, openWindow)).rejects.toThrow(/unknown support link/i);
    expect(openWindow).not.toHaveBeenCalled();
  });
});

describe('fake desktop bridge (src/app/testing.ts)', () => {
  it('mirrors the main-process allow-list: accepted ids are logged, anything else is rejected and not logged', async () => {
    const desktop = createFakeDesktop();
    await desktop.openSupportLink!('stripe');
    await desktop.openSupportLink!('kofi');
    await desktop.openSupportLink!('support');
    expect(desktop.log).toEqual(['openSupportLink:stripe', 'openSupportLink:kofi', 'openSupportLink:support']);
    for (const value of ['paypal', STRIPE, SUPPORT_PAGE, 'Support', '', undefined, null, 5]) await expect(desktop.openSupportLink!(value as unknown as SupportLinkId), String(value)).rejects.toThrow(/unknown support link/i);
    expect(desktop.log).toHaveLength(3);
  });

  it('holds and failures apply to openSupportLink like to every other call', async () => {
    const desktop = createFakeDesktop();
    desktop.failures.openSupportLink = () => new Error('no browser');
    await expect(desktop.openSupportLink!('kofi')).rejects.toThrow('no browser');
    const requester = createSupportLinkRequester(id => desktop.openSupportLink!(id));
    await expect(requester.request('kofi')).resolves.toBe(false);
    delete desktop.failures.openSupportLink;
    await expect(requester.request('kofi')).resolves.toBe(true);
  });
});

describe('dismissing by clicking outside', () => {
  const dialog = {};
  const inner = {};

  it('a click on the backdrop (press and release on the dialog element itself) closes', () => {
    expect(closesOnBackdrop(dialog, dialog, dialog)).toBe(true);
  });

  it('a click inside the dialog, or a text selection that starts inside and ends on the backdrop, does not close', () => {
    expect(closesOnBackdrop(inner, inner, dialog)).toBe(false);
    expect(closesOnBackdrop(inner, dialog, dialog)).toBe(false);
    expect(closesOnBackdrop(dialog, inner, dialog)).toBe(false);
    expect(closesOnBackdrop(null, dialog, dialog)).toBe(false);
    expect(closesOnBackdrop(dialog, null, dialog)).toBe(false);
  });
});

describe('createBackdropDismisser (the workspace Modal dialogs, H3-01)', () => {
  const dialog = { name: 'dialog' }, inner = { name: 'inner' };
  const setup = () => { let closed = 0; const backdrop = createBackdropDismisser(() => { closed++; }); return { backdrop, closed: () => closed }; };

  it('closes on a click whose press and release were both on the backdrop', () => {
    const { backdrop, closed } = setup();
    backdrop.onPointerDown({ target: dialog }); backdrop.onClick({ target: dialog, currentTarget: dialog });
    expect(closed()).toBe(1);
  });

  it('keeps the dialog open when the press started inside (a text selection or drag that ends on the backdrop) or ended inside', () => {
    const { backdrop, closed } = setup();
    backdrop.onPointerDown({ target: inner }); backdrop.onClick({ target: dialog, currentTarget: dialog });
    backdrop.onPointerDown({ target: dialog }); backdrop.onClick({ target: inner, currentTarget: dialog });
    backdrop.onPointerDown({ target: inner }); backdrop.onClick({ target: inner, currentTarget: dialog });
    expect(closed()).toBe(0);
  });

  it('a click without a preceding press (keyboard activation, synthetic click) never closes, and a press is used up by one click', () => {
    const { backdrop, closed } = setup();
    backdrop.onClick({ target: dialog, currentTarget: dialog });
    expect(closed()).toBe(0);
    backdrop.onPointerDown({ target: dialog }); backdrop.onClick({ target: dialog, currentTarget: dialog }); backdrop.onClick({ target: dialog, currentTarget: dialog });
    expect(closed()).toBe(1);
  });
});
