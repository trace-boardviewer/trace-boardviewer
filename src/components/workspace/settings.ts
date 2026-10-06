import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createFormatters, createTranslator, detectLanguage, renderMessage, resolveLanguage } from '../../lib/i18n';
import type { Message } from '../../lib/i18n';
import type { AppSettings } from '../../lib/types';

const SETTINGS_KEY = 'trace-settings';
export const defaults: AppSettings = { language: 'hu', theme: 'dark', layout: 'workshop', motion: true, showLabels: true, showConnections: true, updateCheck: true };

/** Each field is checked on its own: one damaged value falls back to its default without resetting the others, and a profile saved before a field existed gets that field's default. */
export function savedSettings(value: unknown, fresh = false): AppSettings {
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    // A stored language wins; a pre-language profile keeps Hungarian; only a fresh profile follows the system.
    language: resolveLanguage(stored.language, { fresh, system: navigator.languages }),
    theme: stored.theme === 'dark' || stored.theme === 'light' || stored.theme === 'system' ? stored.theme : defaults.theme,
    layout: stored.layout === 'workshop' || stored.layout === 'focus' ? stored.layout : defaults.layout,
    motion: typeof stored.motion === 'boolean' ? stored.motion : defaults.motion,
    showLabels: typeof stored.showLabels === 'boolean' ? stored.showLabels : defaults.showLabels,
    showConnections: typeof stored.showConnections === 'boolean' ? stored.showConnections : defaults.showConnections,
    updateCheck: typeof stored.updateCheck === 'boolean' ? stored.updateCheck : defaults.updateCheck,
  };
}
/** Settings known synchronously at startup. In the desktop app the native process supplies them a moment later. */
function initialSettings(desktop: boolean): { settings: AppSettings; corrupt: boolean } {
  if (desktop) return { settings: { ...defaults, language: detectLanguage(navigator.languages) }, corrupt: false };
  let raw: string | null;
  try { raw = localStorage.getItem(SETTINGS_KEY); }
  catch { return { settings: savedSettings({}, true), corrupt: true }; }
  if (raw === null) {
    const settings = savedSettings({}, true);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Detection simply repeats next time. */ }
    return { settings, corrupt: false };
  }
  try { return { settings: savedSettings(JSON.parse(raw)), corrupt: false }; }
  catch { return { settings: savedSettings({}), corrupt: true }; }
}
/** Text of an error raised by the (already localized) native process is shown verbatim. */
const failureText = (error: unknown): Message | null => {
  if (!(error instanceof Error)) return null;
  const text = error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
  return text ? { text } : null;
};

/** UI settings (language, theme, layout, motion, labels). They belong to the shell, not to a board workspace; the native store keeps them. */
export function useSettings(notify: (message: Message, error?: boolean) => void) {
  const desktop = window.traceDesktop;
  const [initial] = useState(() => initialSettings(!!desktop));
  const [settings, setSettings] = useState(initial.settings);
  const [ready, setReady] = useState(!desktop);
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const settingsRef = useRef(initial.settings);
  const changed = useRef(false);
  const corrupt = useRef(initial.corrupt);
  const notifyRef = useRef(notify); notifyRef.current = notify;
  const theme: 'dark' | 'light' = settings.theme === 'system' ? systemDark ? 'dark' : 'light' : settings.theme;
  const language = settings.language;
  const t = useMemo(() => createTranslator(language), [language]);
  const fmt = useMemo(() => createFormatters(language), [language]);
  const text = useCallback((message: Message) => renderMessage(language, message), [language]);
  const update = useCallback((next: Partial<AppSettings>) => {
    const value = { ...settingsRef.current, ...next };
    settingsRef.current = value; changed.current = true; setSettings(value);
    try {
      if (desktop) void desktop.saveSettings(value).catch(error => notifyRef.current(failureText(error) ?? { key: 'toast.settingsSaveFailed' }, true));
      else localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
    } catch { notifyRef.current({ key: 'toast.settingsSaveFailed' }, true); }
  }, [desktop]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const listener = () => setSystemDark(media.matches); media.addEventListener('change', listener); return () => media.removeEventListener('change', listener);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.motion = settings.motion ? 'on' : 'off';
    document.documentElement.lang = language;
  }, [theme, settings.motion, language]);
  useEffect(() => {
    let active = true;
    if (desktop) {
      void desktop.getSettings().then(saved => {
        if (active && !changed.current) { const next = savedSettings(saved); settingsRef.current = next; setSettings(next); }
        if (active) setReady(true);
      }).catch(error => { if (active) { setReady(true); notifyRef.current(failureText(error) ?? { key: 'toast.settingsReadFailed' }, true); } });
    } else if (corrupt.current) { corrupt.current = false; notifyRef.current({ key: 'toast.settingsDefaulted' }, true); }
    return () => { active = false; };
  }, [desktop]);
  return { settings, settingsRef, update, ready, theme, language, t, fmt, text };
}
