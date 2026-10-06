import type { MessageKey } from './i18n';
import type { TraceDesktop, UpdateCheckResult } from './types';

export type { UpdateCheckResult };

/**
 * Update notification, the pure part (the main-process half is electron/updates.cjs and the 'trace:check-for-updates' / 'trace:open-update-page' handlers
 * of electron/main.cjs). TRACE tells the user that a newer release exists and sends them to its release page in the browser; it never downloads or installs
 * anything (the Windows build is an unsigned portable EXE and the macOS build is unsigned). The renderer never sends a URL or a tag: it asks, the main process
 * answers with a bare result and opens the page of the tag it validated itself.
 * The markup is in src/components/UpdateNotice.tsx (the strip under the top bar and the Settings rows).
 */

/** Catalog keys (electron/locales/*.json, all eight languages). `available` takes {version}. */
export const UPDATE_KEYS = {
  setting: 'update.setting', settingHint: 'update.settingHint', checkNow: 'update.checkNow', checking: 'update.checking', current: 'update.current',
  available: 'update.available', failed: 'update.failed', download: 'update.download', dismiss: 'update.dismiss',
} as const satisfies Record<string, MessageKey>;
/** Shown when the release page could not be opened (the Download button of the strip or of Settings). */
export const UPDATE_OPEN_FAILED_KEY = 'update.openFailed' as const satisfies MessageKey;

// ---------------------------------------------------------------------------------------------------------------
// The desktop bridge
// ---------------------------------------------------------------------------------------------------------------

type UpdateBridge = Required<Pick<TraceDesktop, 'checkForUpdates' | 'openUpdatePage'>>;

/** The bridge of this page, or undefined in browser-only development mode (and anywhere without a window, such as the unit tests). */
export function currentDesktop(): TraceDesktop | undefined {
  return typeof window === 'undefined' ? undefined : window.traceDesktop;
}

/**
 * True only for a desktop bridge that has both calls. Without the bridge (browser development mode) or with an older preload that lacks them,
 * the setting, the button and the strip are not shown at all, and nothing is ever requested.
 */
export function updateCheckSupported(desktop: Partial<TraceDesktop> | undefined | null): desktop is Partial<TraceDesktop> & UpdateBridge {
  return !!desktop && typeof desktop.checkForUpdates === 'function' && typeof desktop.openUpdatePage === 'function';
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** Whatever crossed the bridge becomes one of the three results; an unknown status or a version that is not plain digits is "unavailable". Only status and version are kept. */
export function normalizeUpdateResult(value: unknown): UpdateCheckResult {
  if (typeof value === 'object' && value !== null) {
    const { status, version } = value as Record<string, unknown>;
    if (status === 'current') return { status: 'current' };
    if (status === 'available' && typeof version === 'string' && VERSION.test(version)) return { status: 'available', version };
  }
  return { status: 'unavailable' };
}

export interface UpdateActions {
  /** One check. Resolves to null when another check of these actions is still running (a double click asks once) or there is no bridge; never rejects: any failure is "unavailable". */
  check(): Promise<UpdateCheckResult | null>;
  /** Opens the release page of the version the last check reported. True when the system accepted the request; a second call while one is pending is ignored (false). */
  open(): Promise<boolean>;
}

export function createUpdateActions(desktop: Partial<TraceDesktop> | undefined | null): UpdateActions {
  let checking = false;
  let opening = false;
  return {
    async check() {
      if (checking || !updateCheckSupported(desktop)) return null;
      checking = true;
      try { return normalizeUpdateResult(await desktop.checkForUpdates()); }
      catch { return { status: 'unavailable' }; }
      finally { checking = false; }
    },
    async open() {
      if (opening || !updateCheckSupported(desktop)) return false;
      opening = true;
      try { await desktop.openUpdatePage(); return true; }
      catch { return false; }
      finally { opening = false; }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// "Check now" in Settings
// ---------------------------------------------------------------------------------------------------------------

export type CheckNowState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'done'; result: UpdateCheckResult; openFailed?: boolean };

/** The polite status line under the "Check now" button: nothing before the first press, then Checking…, Up to date, TRACE X is available or Could not check. */
export function checkNowStatus(state: CheckNowState): { key: MessageKey; params?: { version: string } } | null {
  if (state.phase === 'idle') return null;
  if (state.phase === 'checking') return { key: UPDATE_KEYS.checking };
  if (state.openFailed) return { key: UPDATE_OPEN_FAILED_KEY };
  const { result } = state;
  if (result.status === 'available') return { key: UPDATE_KEYS.available, params: { version: result.version } };
  return { key: result.status === 'current' ? UPDATE_KEYS.current : UPDATE_KEYS.failed };
}

/** The Download button of the Settings row appears next to an "available" answer. */
export function checkNowOffersDownload(state: CheckNowState): boolean {
  return state.phase === 'done' && state.result.status === 'available';
}

// ---------------------------------------------------------------------------------------------------------------
// The check at start
// ---------------------------------------------------------------------------------------------------------------

export interface StartupUpdateState {
  /** The one check of this launch has been taken (whether or not it ran). */
  readonly claimed: boolean;
  readonly result: UpdateCheckResult | null;
  /** The user closed the strip: it stays closed for the rest of this launch. */
  readonly dismissed: boolean;
}

// Module state, never persisted: every new launch (a new renderer process) starts fresh, so there is one check per launch and a dismissed strip comes back
// only with the next launch. The state lives outside React so that a StrictMode remount (or a second mount of the shell) can neither repeat the check nor lose its answer.
let launch: StartupUpdateState = { claimed: false, result: null, dismissed: false };
const listeners = new Set<() => void>();
function publish(next: StartupUpdateState): void {
  launch = next;
  for (const listener of [...listeners]) listener();
}

export const getStartupUpdateState = (): StartupUpdateState => launch;
export function subscribeStartupUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** True exactly once per launch: the caller that gets it decides whether to check. */
export function claimStartupUpdateCheck(): boolean {
  if (launch.claimed) return false;
  publish({ ...launch, claimed: true });
  return true;
}

/**
 * The check at start. The launch's single claim is taken whatever the setting says, so switching the setting on later in the same launch does not start a request
 * (the "Check now" button is for that). Without the setting, without the bridge or when the check fails, nothing is shown and nothing is said.
 */
export async function beginStartupUpdateCheck(desktop: Partial<TraceDesktop> | undefined | null, enabled: boolean): Promise<void> {
  if (!claimStartupUpdateCheck()) return;
  if (!enabled || !updateCheckSupported(desktop)) return;
  const result = await createUpdateActions(desktop).check();
  if (result) publish({ ...launch, result });
}

/**
 * QA hook, like the support notice's: automated UI scripts set `window.__TRACE_UPDATE_CHECK__ = 'off'` before the page starts (for example with Playwright's addInitScript)
 * so that a test run makes no request at all. It is a plain global that is stored nowhere; it can only ever switch the check off.
 */
export const UPDATE_CHECK_OPT_OUT = '__TRACE_UPDATE_CHECK__';
export function updateCheckAllowed(scope: object = globalThis): boolean {
  return (scope as Record<string, unknown>)[UPDATE_CHECK_OPT_OUT] !== 'off';
}

/** The user closed the strip. */
export function dismissStartupUpdate(): void {
  publish({ ...launch, dismissed: true });
}

/**
 * The version the strip announces, or null when there is no strip: only for an "available" answer, not dismissed, with the setting still on, and only once
 * `allowed` says the support notice is out of the way (the strip never shows while that dialog is open).
 */
export function startupUpdateToShow(state: StartupUpdateState, allowed: boolean): string | null {
  return allowed && !state.dismissed && state.result?.status === 'available' ? state.result.version : null;
}

/** Forgets the launch state. Tests only: a real launch is a fresh page, so the state starts clean by itself. */
export function resetUpdateCheckLaunch(): void {
  publish({ claimed: false, result: null, dismissed: false });
}
