import type { MessageKey } from './i18n';

/**
 * Support notice: a short, skippable reminder at startup and once per hour while the app is in use. This module is the pure part:
 * the link ids, the reminder claim, the copy keys and the way a link request is made. The dialog itself is
 * src/components/SupportNotice.tsx; the links themselves are constants of the MAIN process (electron/main.cjs, channel
 * 'trace:open-support-link'): the renderer sends an id, never a URL. Bug reports use the local form.
 */

/**
 * The only things the renderer may ask the main process to open are the two donation pages and the project's support page.
 */
export const SUPPORT_LINK_IDS = ['stripe', 'kofi', 'support'] as const;
export type SupportLinkId = (typeof SUPPORT_LINK_IDS)[number];

export function isSupportLinkId(value: unknown): value is SupportLinkId {
  return typeof value === 'string' && (SUPPORT_LINK_IDS as readonly string[]).includes(value);
}

/** Catalog keys of the notice (electron/locales/*.json, all eight languages). */
export const SUPPORT_NOTICE_KEYS = {
  title: 'support.title', body: 'support.body', thanks: 'support.thanks', testing: 'support.testing', stripe: 'support.stripe', kofi: 'support.kofi', bug: 'support.bug', notNow: 'support.notNow',
} as const satisfies Record<string, MessageKey>;

/** The top bar's support (heart) button: its accessible label and tooltip, and the toast when the support page could not be opened. */
export const SUPPORT_BUTTON_KEY = 'support.button' as const satisfies MessageKey;
export const SUPPORT_BUTTON_FAILED_KEY = 'support.buttonFailed' as const satisfies MessageKey;

// ---------------------------------------------------------------------------------------------------------------
// Hourly reminders
// ---------------------------------------------------------------------------------------------------------------

export const SUPPORT_REMINDER_INTERVAL_MS = 60 * 60 * 1000;
// A React StrictMode remount or another shell in the same page cannot show a second reminder within the hour.
let claimedAt: number | null = null;

/** The caller that gets the claim shows the reminder; other callers wait until the next hour. */
export function claimSupportNotice(now = Date.now()): boolean {
  if (!Number.isFinite(now)) return false;
  if (claimedAt !== null && now < claimedAt) { claimedAt = now; return false; }
  if (claimedAt !== null && now - claimedAt < SUPPORT_REMINDER_INTERVAL_MS) return false;
  claimedAt = now;
  return true;
}

/** Dismissing a reminder starts a fresh hour; a dialog left open for an hour must not pop up again immediately. */
export function postponeSupportNotice(now = Date.now()): void {
  if (Number.isFinite(now)) claimedAt = now;
}

/** Forgets the claim. Tests only: a real launch is a fresh page, so the state starts clean by itself. */
export function resetSupportNoticeLaunch(): void {
  claimedAt = null;
}

/**
 * QA hook: automated UI scripts that click through the shell set `window.__TRACE_SUPPORT_NOTICE__ = 'off'` before the page starts
 * (for example with Playwright's addInitScript). It is a plain global: it is not stored anywhere, so it can never turn into a
 * "do not show again" switch for a user.
 */
export const SUPPORT_NOTICE_OPT_OUT = '__TRACE_SUPPORT_NOTICE__';
export function supportNoticeAllowed(scope: object = globalThis): boolean {
  return (scope as Record<string, unknown>)[SUPPORT_NOTICE_OPT_OUT] !== 'off';
}

// ---------------------------------------------------------------------------------------------------------------
// Opening a link
// ---------------------------------------------------------------------------------------------------------------

export type SupportLinkOpener = (id: SupportLinkId) => Promise<void> | void;

/**
 * Turns a button press into an opener call. Only an allow-listed id is forwarded; a request while another one is still pending is
 * ignored (a double click opens one browser tab); the result says whether the link was opened, so the dialog closes on success and
 * stays open (the buttons usable again) when the system could not open it.
 */
export function createSupportLinkRequester(open: SupportLinkOpener): { request(id: unknown): Promise<boolean>; readonly pending: boolean } {
  let pending = false;
  return {
    get pending() { return pending; },
    async request(id: unknown): Promise<boolean> {
      if (pending || !isSupportLinkId(id)) return false;
      pending = true;
      try {
        await open(id);
        return true;
      } catch {
        return false;
      } finally {
        pending = false;
      }
    },
  };
}

/**
 * Browser-only development mode (no Electron bridge): the same three links, duplicated here on purpose because there is no main
 * process to hold them. The desktop app never uses this table; electron/main.cjs owns the real constants (a test keeps both in step).
 * Bug reports are handled inside the application.
 */
export const WEB_SUPPORT_LINKS: Readonly<Record<SupportLinkId, string>> = Object.freeze({
  stripe: 'https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00',
  kofi: 'https://ko-fi.com/tracerboardview',
  support: 'https://trace-boardviewer.github.io/support.html',
});

type OpenWindow = (url: string, target: string, features: string) => unknown;

export async function openSupportLinkInBrowser(id: SupportLinkId, openWindow: OpenWindow = (url, target, features) => window.open(url, target, features)): Promise<void> {
  if (!isSupportLinkId(id)) throw new Error('Unknown support link.');
  openWindow(WEB_SUPPORT_LINKS[id], '_blank', 'noopener');
}

/**
 * The opener for the current environment: the desktop bridge when there is one (it sends the id to the main process), the browser
 * fallback only when there is no bridge at all. A bridge that predates the channel never falls back to window.open: inside Electron
 * the main process denies popups anyway, and silently doing nothing would hide the problem.
 */
export function resolveSupportLinkOpener(desktop: { openSupportLink?: (id: SupportLinkId) => Promise<void> } | undefined, openWindow?: OpenWindow): SupportLinkOpener {
  if (!desktop) return (id) => openSupportLinkInBrowser(id, openWindow);
  return (id) => {
    if (typeof desktop.openSupportLink !== 'function') return Promise.reject(new Error('The support link is not available in this version of the desktop bridge.'));
    return desktop.openSupportLink(id);
  };
}

/**
 * One click on a top bar support link button: the opener of the moment is asked for exactly this id and
 * a failure of any kind (a rejection, or a synchronous throw while resolving or calling the opener) is reported through `onFailure` once.
 * It never rejects, so the click handler can fire and forget it.
 */
export function openFixedLink(id: SupportLinkId, opener: () => SupportLinkOpener, onFailure: () => void): Promise<void> {
  return Promise.resolve().then(() => opener()(id)).then(() => undefined, () => { onFailure(); });
}

// ---------------------------------------------------------------------------------------------------------------
// Dismissing
// ---------------------------------------------------------------------------------------------------------------

/**
 * A click outside the dialog closes it. In a modal <dialog> a click on the backdrop reports the dialog element itself as its
 * target. Both the press and the release must be on it: a text selection that starts inside the dialog and ends outside must not close it.
 */
export function closesOnBackdrop(pressTarget: unknown, clickTarget: unknown, dialog: unknown): boolean {
  return pressTarget !== null && clickTarget !== null && pressTarget === dialog && clickTarget === dialog;
}

/**
 * The two handlers of a modal <dialog> that apply that rule: `onPointerDown` remembers where the press started, `onClick` closes
 * only when the press and the click were both on the dialog element (its backdrop) and forgets the press either way.
 */
export function createBackdropDismisser(close: () => void): { onPointerDown(event: { target: unknown }): void; onClick(event: { target: unknown; currentTarget: unknown }): void } {
  let press: unknown = null;
  return {
    onPointerDown(event) { press = event.target; },
    onClick(event) { const start = press; press = null; if (closesOnBackdrop(start, event.target, event.currentTarget)) close(); },
  };
}
