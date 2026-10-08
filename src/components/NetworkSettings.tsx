import { Eraser, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Language, Translator } from '../lib/i18n';
import {
  FEATURE_TEXT, NETWORK_KEYS, createNetworkActions, featureEnabled, formatActivityDateTime, formatActivityTime, resultText, resultTone,
} from '../lib/network-activity';
import type { NetworkActions, NetworkActivityReport } from '../lib/network-activity';
import type { AppSettings } from '../lib/types';
import { currentDesktop } from '../lib/update-check';
import './network-settings.css';

/**
 * Settings > Network (the logic is in src/lib/network-activity.ts, the main-process half in electron/net/egress.cjs). Two parts:
 *  - the network features with their state (On or Off, in words) and the hosts each one may contact;
 *  - "Network activity": a table of every request the main process made since TRACE started (time, feature, host and path, result), newest first, with
 *    Refresh and Clear list. It refreshes by itself every two seconds while it is shown. The interface only reads this list and empties it; it never starts a request.
 * Everything is a native button or table, so Tab reaches the toggle, Refresh and Clear list in that order, and the scrollable list is a focusable region.
 * The caller shows the section only when the desktop bridge has the two network calls.
 */
const REFRESH_MS = 2000;

const featureText = (id: string) => (Object.hasOwn(FEATURE_TEXT, id) ? FEATURE_TEXT[id] : undefined);

export default function NetworkSettings({ t, language, settings, actions: provided, initialOpen = false, initialReport = null }: {
  t: Translator; language: Language; settings: AppSettings; actions?: NetworkActions; initialOpen?: boolean; initialReport?: NetworkActivityReport | null;
}) {
  const actions = useMemo(() => provided ?? createNetworkActions(currentDesktop()), [provided]);
  const [open, setOpen] = useState(initialOpen);
  const [report, setReport] = useState<NetworkActivityReport | null>(initialReport);
  const [failed, setFailed] = useState(false);
  const [cleared, setCleared] = useState(false);
  const alive = useRef(true);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const logId = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = useCallback(async () => {
    const next = await actions.read();
    if (!alive.current) return;
    if (next === null) { setFailed(true); return; }
    setFailed(false);
    setReport(next);
    if (next.entries.length > 0) setCleared(false);
  }, [actions]);
  // The features are listed from the first moment; the list itself is kept fresh only while it is shown.
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!open) return undefined;
    const timer = setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, refresh]);
  const clear = async () => {
    const done = await actions.clear();
    if (!alive.current) return;
    if (!done) { setFailed(true); return; }
    setCleared(true);
    await refresh();
    // The Clear list button is disabled by now (nothing left to clear); keyboard focus moves to its neighbour instead of falling out of the dialog.
    if (alive.current && document.activeElement !== refreshButton.current) refreshButton.current?.focus();
  };
  const rows = report ? [...report.entries].reverse() : [];
  const status = failed ? t(NETWORK_KEYS.loadFailed) : cleared && rows.length === 0 ? t(NETWORK_KEYS.cleared) : report && report.dropped > 0 ? t(NETWORK_KEYS.dropped, { count: report.dropped }) : '';
  return <section className="settings-section network-section" aria-labelledby={titleId} data-testid="network-section">
    <h3 id={titleId}>{t(NETWORK_KEYS.title)}</h3>
    <p className="settings-hint">{t(NETWORK_KEYS.intro)}</p>
    {report && <ul className="network-features">
      {report.features.map(feature => {
        const text = featureText(feature.id);
        const on = featureEnabled(feature, settings);
        return <li key={feature.id} className="network-feature" data-testid={`network-feature-${feature.id}`}>
          <span className="network-feature-text">
            <strong>{text ? t(text.name) : feature.id}</strong>
            {text && <small>{t(text.hint)}</small>}
            <small className="mono">{t(NETWORK_KEYS.hosts, { hosts: feature.hosts.join(', ') })}</small>
          </span>
          <span className="network-state" data-state={on ? 'on' : 'off'}>{on ? t(NETWORK_KEYS.stateOn) : t(NETWORK_KEYS.stateOff)}</span>
        </li>;
      })}
    </ul>}
    <button type="button" className="outline-button network-toggle" aria-expanded={open} aria-controls={logId} data-testid="network-activity-toggle" onClick={() => setOpen(value => !value)}>
      {open ? t(NETWORK_KEYS.hide) : t(NETWORK_KEYS.show)}
    </button>
    <div id={logId} className="network-log" data-testid="network-log" hidden={!open}>
      {open && <>
        <p className="settings-hint">{t(NETWORK_KEYS.activityIntro)}</p>
        <div className="network-toolbar">
          <button type="button" className="outline-button" data-testid="network-refresh" ref={refreshButton} onClick={() => void refresh()}><RefreshCw size={13} aria-hidden="true" />{t(NETWORK_KEYS.refresh)}</button>
          <button type="button" className="outline-button" data-testid="network-clear" disabled={rows.length === 0} onClick={() => void clear()}><Eraser size={13} aria-hidden="true" />{t(NETWORK_KEYS.clear)}</button>
        </div>
        <p className="network-status" role="status" data-testid="network-status">{status}</p>
        {rows.length === 0
          ? report && <p className="settings-hint" data-testid="network-empty">{t(NETWORK_KEYS.empty)}</p>
          : <div className="network-table-wrap" role="region" aria-label={t(NETWORK_KEYS.activityTitle)} tabIndex={0}>
            <table className="network-table" data-testid="network-table">
              <caption className="network-sr-only">{t(NETWORK_KEYS.caption)}</caption>
              <thead><tr>
                <th scope="col">{t(NETWORK_KEYS.colTime)}</th><th scope="col">{t(NETWORK_KEYS.colFeature)}</th><th scope="col">{t(NETWORK_KEYS.colHost)}</th><th scope="col">{t(NETWORK_KEYS.colResult)}</th>
              </tr></thead>
              <tbody>
                {rows.map(entry => {
                  const text = featureText(entry.feature);
                  const result = resultText(entry);
                  return <tr key={entry.id} data-testid="network-row" data-outcome={entry.outcome}>
                    <td><time dateTime={entry.time} title={formatActivityDateTime(entry.time, language)}>{formatActivityTime(entry.time, language)}</time></td>
                    <td>{text ? t(text.name) : entry.feature}</td>
                    <td><span className="network-host-name mono">{entry.host || '—'}</span><span className="network-path mono">{entry.path}</span></td>
                    <td><span className="network-result" data-tone={resultTone(entry)}>{t(result.key, result.params)}</span></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>}
      </>}
    </div>
  </section>;
}
