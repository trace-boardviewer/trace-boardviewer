import { LOCALE_TAGS } from './i18n';
import type { Language, MessageKey } from './i18n';
import type { AppSettings, NetworkActivityEntry, NetworkActivityReport, NetworkFeature, TraceDesktop } from './types';

export type { NetworkActivityEntry, NetworkActivityReport, NetworkFeature };

/**
 * The pure part of Settings > Network (the markup is src/components/NetworkSettings.tsx, the main-process half is electron/net/egress.cjs and the two
 * 'trace:*-network-activity' channels of electron/main.cjs). The renderer never makes a request and never names a URL, a host or a feature: it can read
 * the list of network features and the in-memory log of every request the main process made, and it can empty that log. Everything that crosses the
 * bridge is checked here before it is drawn, so a damaged answer shows less, never something unvetted.
 */

/** Catalog keys (electron/locales/*.json, all eight languages). */
export const NETWORK_KEYS = {
  title: 'network.title', intro: 'network.intro', hosts: 'network.hosts', stateOn: 'network.stateOn', stateOff: 'network.stateOff',
  show: 'network.activityShow', hide: 'network.activityHide', activityTitle: 'network.activityTitle', activityIntro: 'network.activityIntro',
  caption: 'network.activityCaption', empty: 'network.activityEmpty', refresh: 'network.activityRefresh', clear: 'network.activityClear',
  cleared: 'network.activityCleared', dropped: 'network.activityDropped', loadFailed: 'network.activityLoadFailed',
  colTime: 'network.colTime', colFeature: 'network.colFeature', colHost: 'network.colHost', colResult: 'network.colResult',
} as const satisfies Record<string, MessageKey>;

/** The features the interface has words for. A feature registered in the main process that is not listed here is still shown, by its id and without a hint. */
export const FEATURE_TEXT: Readonly<Record<string, { name: MessageKey; hint: MessageKey }>> = {
  'update-check': { name: 'network.updateCheck', hint: 'network.updateCheckHint' },
  'support-verification': { name: 'support.verify', hint: 'support.referenceHint' },
  'bug-report': { name: 'network.bugReport', hint: 'network.bugReportHint' },
};

// ---------------------------------------------------------------------------------------------------------------
// The desktop bridge
// ---------------------------------------------------------------------------------------------------------------

type NetworkBridge = Required<Pick<TraceDesktop, 'getNetworkActivity' | 'clearNetworkActivity'>>;

/** True only for a desktop bridge that has both calls. Without the bridge (browser development mode) or with an older preload the section is not shown at all. */
export function networkActivitySupported(desktop: Partial<TraceDesktop> | undefined | null): desktop is Partial<TraceDesktop> & NetworkBridge {
  return !!desktop && typeof desktop.getNetworkActivity === 'function' && typeof desktop.clearNetworkActivity === 'function';
}

export interface NetworkActions {
  /** The current report, or null when it could not be read or looked damaged; never rejects. */
  read(): Promise<NetworkActivityReport | null>;
  /** Empties the log. True when the main process did it; never rejects. */
  clear(): Promise<boolean>;
}

export function createNetworkActions(desktop: Partial<TraceDesktop> | undefined | null): NetworkActions {
  return {
    async read() {
      if (!networkActivitySupported(desktop)) return null;
      try { return normalizeNetworkActivity(await desktop.getNetworkActivity()); } catch { return null; }
    },
    async clear() {
      if (!networkActivitySupported(desktop)) return false;
      try { await desktop.clearNetworkActivity(); return true; } catch { return false; }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Checking what crossed the bridge
// ---------------------------------------------------------------------------------------------------------------

const FEATURE_ID = /^[a-z][a-z0-9-]{1,47}$/;
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const HOST = /^[a-z0-9.:-]{0,253}$/;
const ERROR_CLASS = /^[a-z][a-z-]{0,31}$/;
const METHOD = /^[A-Z]{3,7}$/;
const MAX_FEATURES = 16;
const MAX_ENTRIES = 1000;
const OUTCOMES = new Set(['pending', 'ok', 'refused', 'error']);
const KINDS = new Set(['request', 'download']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null);

function normalizeFeature(value: unknown): NetworkFeature | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !FEATURE_ID.test(value.id) || typeof value.enabled !== 'boolean') return null;
  // A feature always has at least one host (the main process refuses to register one without), and never more than eight.
  if (!Array.isArray(value.hosts) || value.hosts.length < 1 || value.hosts.length > 8 || value.hosts.some(host => typeof host !== 'string' || !HOST.test(host) || host === '')) return null;
  if (value.optIn !== null && (typeof value.optIn !== 'string' || !SETTING_KEY.test(value.optIn))) return null;
  return { id: value.id, hosts: [...value.hosts as string[]], optIn: value.optIn, enabled: value.enabled };
}

function normalizeEntry(value: unknown): NetworkActivityEntry | null {
  if (!isRecord(value)) return null;
  const id = count(value.id);
  const bytes = count(value.bytes);
  if (id === null || bytes === null) return null;
  const durationMs = value.durationMs === null ? null : count(value.durationMs);
  const status = value.status === null ? null : count(value.status, 599);
  // null is a valid duration or status only when the main process sent null itself.
  if ((durationMs === null && value.durationMs !== null) || (status === null && value.status !== null) || (status !== null && status < 100)) return null;
  const { time, kind, feature, method, host, path, outcome, error } = value;
  if (typeof time !== 'string' || !Number.isFinite(Date.parse(time)) || typeof kind !== 'string' || !KINDS.has(kind) || typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return null;
  if (typeof feature !== 'string' || !(feature === '?' || FEATURE_ID.test(feature)) || typeof method !== 'string' || !METHOD.test(method)) return null;
  if (typeof host !== 'string' || !HOST.test(host) || typeof path !== 'string' || path.length > 120 || /[^\x20-\x7e…]/.test(path)) return null;
  if (error !== null && (typeof error !== 'string' || !ERROR_CLASS.test(error))) return null;
  return { id, time, kind: kind as NetworkActivityEntry['kind'], feature, method, host, path, outcome: outcome as NetworkActivityEntry['outcome'], status, bytes, durationMs, error };
}

/** Whatever crossed the bridge becomes a report with only well-formed features and entries, or null when it is not a report at all. */
export function normalizeNetworkActivity(value: unknown): NetworkActivityReport | null {
  if (!isRecord(value) || !Array.isArray(value.features) || !Array.isArray(value.entries)) return null;
  const dropped = count(value.dropped);
  const limit = count(value.limit, MAX_ENTRIES);
  if (dropped === null || limit === null || limit < 1) return null;
  const features = value.features.slice(0, MAX_FEATURES).flatMap(item => { const feature = normalizeFeature(item); return feature ? [feature] : []; });
  const entries = value.entries.slice(-MAX_ENTRIES).flatMap(item => { const entry = normalizeEntry(item); return entry ? [entry] : []; });
  return { features, entries, dropped, limit };
}

// ---------------------------------------------------------------------------------------------------------------
// What is drawn
// ---------------------------------------------------------------------------------------------------------------

/** Whether a feature is on: the setting in the interface's own state when the feature depends on one that exists (it changes at once), else what the main process said. */
export function featureEnabled(feature: NetworkFeature, settings: AppSettings): boolean {
  if (feature.optIn === null) return true;
  const own = (settings as unknown as Record<string, unknown>)[feature.optIn];
  return typeof own === 'boolean' ? own : feature.enabled;
}

export type ResultText = { key: MessageKey; params?: { status: number } };

/** The words for the Result column: the HTTP status of an answer, otherwise a short reason in the user's language (the error class itself is never shown). */
export function resultText(entry: NetworkActivityEntry): ResultText {
  if (entry.outcome === 'pending') return { key: 'network.resultPending' };
  if (entry.outcome === 'ok') return entry.status === null ? { key: 'network.resultFailed' } : { key: 'network.resultHttp', params: { status: entry.status } };
  if (entry.outcome === 'refused') {
    return { key: entry.error === 'disabled' ? 'network.resultDisabled' : entry.error === 'busy' ? 'network.resultBusy' : 'network.resultBlocked' };
  }
  switch (entry.error) {
    case 'cancelled': return { key: 'network.resultCancelled' };
    case 'http-status': return entry.status === null ? { key: 'network.resultFailed' } : { key: 'network.resultHttpStatus', params: { status: entry.status } };
    case 'redirect': return { key: 'network.resultRedirect' };
    case 'too-large': return { key: 'network.resultTooLarge' };
    case 'timeout': return { key: 'network.resultTimeout' };
    case 'network': return { key: 'network.resultNetwork' };
    case 'bad-response': return { key: 'network.resultBadResponse' };
    default: return { key: 'network.resultFailed' };
  }
}

/** 'good' for an answer below 400, 'wait' for a request still running, 'bad' for everything else: the markup colours the result by it and always says it in words as well. */
export function resultTone(entry: NetworkActivityEntry): 'good' | 'wait' | 'bad' {
  if (entry.outcome === 'pending') return 'wait';
  return entry.outcome === 'ok' && entry.status !== null && entry.status < 400 ? 'good' : 'bad';
}

const timeFormats = new Map<Language, Intl.DateTimeFormat>();
/** The time of day of an entry in the interface language; the full date and time stay in the title of the cell. */
export function formatActivityTime(iso: string, language: Language): string {
  const when = Date.parse(iso);
  if (!Number.isFinite(when)) return '—';
  let format = timeFormats.get(language);
  if (!format) { format = new Intl.DateTimeFormat(LOCALE_TAGS[language], { timeStyle: 'medium' }); timeFormats.set(language, format); }
  return format.format(when);
}
export function formatActivityDateTime(iso: string, language: Language): string {
  const when = Date.parse(iso);
  return Number.isFinite(when) ? new Intl.DateTimeFormat(LOCALE_TAGS[language], { dateStyle: 'medium', timeStyle: 'medium' }).format(when) : '';
}
