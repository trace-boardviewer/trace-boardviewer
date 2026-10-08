import { Bug } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Translator } from '../lib/i18n';
import {
  SUPPORT_NOTICE_KEYS, claimSupportNotice, closesOnBackdrop, createSupportLinkRequester, postponeSupportNotice, resolveSupportLinkOpener, supportNoticeAllowed,
} from '../lib/support-notice';
import type { SupportLinkId, SupportLinkOpener } from '../lib/support-notice';
import './support-notice.css';
import SupportVerification from './SupportVerification';
import type { SupportStatus } from '../lib/types';

/**
 * Support notice: shown at startup and hourly over the ready UI. It is easy to skip and
 * never gets in the way: "Not now" has the initial focus, so Enter and Esc skip it, and so does a click outside the dialog.
 * A verified support receipt suppresses the reminder for one calendar year. Loading a board (command line, drag and drop) is not affected: the
 * dialog only covers the UI, the board loads in the background.
 *
 * Opening a link sends an id ('stripe' | 'kofi') to the main process (window.traceDesktop.openSupportLink); the URLs are constants
 * in electron/main.cjs. The pure logic (allow-list, hourly claim, request flow) is in src/lib/support-notice.ts.
 */
export default function SupportNotice({ ready, blocked = false, suppressed = false, requested = 0, t, open, onShown, onSettled, onVerified }: { ready: boolean; blocked?: boolean; suppressed?: boolean; requested?: number; t: Translator; open?: SupportLinkOpener; onShown?: () => void; onSettled?: () => void; onVerified?: (value: SupportStatus) => void }) {
  const [visible, setVisible] = useState(false);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const shown = useRef(onShown); shown.current = onShown;
  const handledRequest = useRef(0);
  useEffect(() => {
    if (suppressed) { setVisible(false); settled.current?.(); return; }
    if (ready && !blocked && requested > handledRequest.current) { handledRequest.current = requested; shown.current?.(); setVisible(true); }
  }, [ready, blocked, suppressed, requested]);
  useEffect(() => {
    if (!ready || visible || suppressed) return;
    const tick = () => {
      // Reminders wait for active work and other dialogs; returning to the app produces at most one reminder, never a backlog.
      if (supportNoticeAllowed() && !blocked && document.visibilityState === 'visible' && document.hasFocus() && claimSupportNotice()) {
        shown.current?.(); setVisible(true);
      } else settled.current?.();
    };
    tick();
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, [ready, blocked, visible, suppressed]);
  // `onSettled` tells the shell that the notice is out of the way (closed, or never shown): the update strip waits for it, so the two never compete.
  const close = () => { postponeSupportNotice(); setVisible(false); settled.current?.(); };
  return visible && !suppressed ? <SupportDialog t={t} open={open} onVerified={value => { onVerified?.(value); close(); }} onClose={close} /> : null;
}

/** The dialog itself (exported for the markup test). */
export function SupportDialog({ t, open, onClose, onVerified }: { t: Translator; open?: SupportLinkOpener; onClose: () => void; onVerified?: (value: SupportStatus) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const notNow = useRef<HTMLButtonElement>(null);
  const pressTarget = useRef<EventTarget | null>(null);
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const bodyId = useId();
  const requester = useMemo(() => createSupportLinkRequester(open ?? resolveSupportLinkOpener(window.traceDesktop)), [open]);
  // Capture the invoker before the dialog takes the focus.
  const invoker = useRef(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    alive.current = true;
    node.showModal();
    notNow.current?.focus({ preventScroll: true }); // Enter and Esc both skip the notice
    return () => { alive.current = false; node.close(); if (invoker.current?.isConnected) invoker.current.focus({ preventScroll: true }); };
  }, []);

  const activate = async (id: SupportLinkId) => {
    if (requester.pending) return;
    setBusy(true);
    const opened = await requester.request(id);
    if (!alive.current) return;
    setBusy(false);
    if (opened && (id === 'bug' || !window.traceDesktop?.checkSupport)) onClose();
  };

  return <dialog ref={dialog} className="support-notice" role="dialog" aria-labelledby={titleId} aria-describedby={bodyId} data-testid="support-notice"
    onCancel={event => { event.preventDefault(); onClose(); }}
    // The notice is modal: keys typed in it never reach the shell's global shortcuts (n, f, Ctrl+O ...). Esc skips it.
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } event.stopPropagation(); }}
    onPointerDown={event => { pressTarget.current = event.target; }}
    onClick={event => { const press = pressTarget.current; pressTarget.current = null; if (closesOnBackdrop(press, event.target, event.currentTarget)) onClose(); }}>
    <div className="support-notice-inner">
      <h2 id={titleId}>{t(SUPPORT_NOTICE_KEYS.title)}</h2>
      <p id={bodyId} className="support-notice-body">{t(SUPPORT_NOTICE_KEYS.body)}</p>
      <p className="support-notice-thanks">{t(SUPPORT_NOTICE_KEYS.thanks)}</p>
      <p className="support-notice-testing">{t(SUPPORT_NOTICE_KEYS.testing)}</p>
      <div className="support-notice-actions">
        <button type="button" className="primary-button" data-testid="support-stripe" data-support-link="stripe" disabled={busy} onClick={() => void activate('stripe')}>{t(SUPPORT_NOTICE_KEYS.stripe)}</button>
        <button type="button" className="outline-button" data-testid="support-kofi" data-support-link="kofi" disabled={busy} onClick={() => void activate('kofi')}>{t(SUPPORT_NOTICE_KEYS.kofi)}</button>
        <button type="button" className="outline-button" data-testid="support-bug" data-support-link="bug" disabled={busy} onClick={() => void activate('bug')}><Bug size={14} />{t(SUPPORT_NOTICE_KEYS.bug)}</button>
        <button type="button" className="outline-button support-notice-skip" ref={notNow} data-testid="support-not-now" onClick={onClose}>{t(SUPPORT_NOTICE_KEYS.notNow)}</button>
      </div>
      <SupportVerification t={t} onVerified={onVerified} />
    </div>
  </dialog>;
}
