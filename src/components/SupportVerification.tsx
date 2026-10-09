import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Translator } from '../lib/i18n';
import type { SupportStatus } from '../lib/types';

type PreparationResult = SupportStatus & { code?: unknown };
type VerificationViewState = { code: string; available: boolean; busy: boolean; result: 'pending' | 'unavailable' | null };
const EMPTY_VIEW: VerificationViewState = { code: '', available: false, busy: false, result: null };

/** Shared by the component and its behavioral test so an unavailable store can be retried through the same path as initial preparation. */
export function createSupportPreparationFlow(prepare: () => Promise<PreparationResult>, publish: (state: VerificationViewState) => void) {
  let active = true;
  let busy = false;
  let state = EMPTY_VIEW;
  return Object.freeze({
    async run() {
      if (!active || busy) return;
      busy = true;
      publish(state = { ...state, busy: true, result: null });
      try {
        const value = await prepare();
        if (!active) return;
        const code = typeof value.code === 'string' && /^[a-f0-9]{32}$/.test(value.code) ? value.code : '';
        state = { code, available: value.available === true, busy: false, result: value.status === 'unavailable' || !code ? 'unavailable' : null };
      } catch {
        if (!active) return;
        state = { code: '', available: true, busy: false, result: 'unavailable' };
      } finally {
        busy = false;
        if (active) publish(state);
      }
    },
    dispose() { active = false; },
  });
}

export default function SupportVerification({ t, onVerified }: { t: Translator; onVerified?: (value: SupportStatus) => void }) {
  const [view, setView] = useState(EMPTY_VIEW);
  const flow = useRef<ReturnType<typeof createSupportPreparationFlow> | null>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const verifyButton = useRef<HTMLButtonElement>(null);
  const moveFocusToVerify = useRef(false);
  useEffect(() => {
    const prepare = window.traceDesktop?.prepareSupport;
    flow.current = createSupportPreparationFlow(() => prepare ? prepare() : Promise.reject(new Error('Support preparation is unavailable.')), state => {
      if (!state.busy && state.code && retryButton.current && document.activeElement === retryButton.current) moveFocusToVerify.current = true;
      setView(state);
    });
    void flow.current.run();
    return () => flow.current?.dispose();
  }, []);
  useLayoutEffect(() => {
    if (!view.code || !moveFocusToVerify.current) return;
    moveFocusToVerify.current = false;
    // Retry remains focusable while busy, then is replaced by Verify only after preparation recovers.
    // If the user moved elsewhere during the request, keep their chosen focus instead.
    if (document.activeElement === document.body) verifyButton.current?.focus({ preventScroll: true });
  }, [view.code]);
  if (!view.available) return null;
  const check = async () => {
    if (view.busy || !view.code) return;
    setView(current => ({ ...current, busy: true, result: null }));
    try {
      const value = await window.traceDesktop?.checkSupport?.();
      if (value?.status === 'verified') onVerified?.(value);
      else setView(current => ({ ...current, result: value?.status === 'pending' ? 'pending' : 'unavailable' }));
    } catch { setView(current => ({ ...current, result: 'unavailable' })); }
    finally { setView(current => ({ ...current, busy: false })); }
  };
  return <div className="support-verification" data-testid="support-verification">
    <div data-testid="support-verification-controls" aria-busy={view.busy}>
      {view.code && <>
          <p>{t('support.referenceHint')}</p>
          <input aria-label={t('support.reference')} readOnly value={'TRACE-' + view.code} onFocus={event => event.currentTarget.select()} />
          <button ref={verifyButton} type="button" className="outline-button" disabled={view.busy} onClick={() => void check()} data-testid="support-verify">{t('support.verify')}</button>
        </>}
      {!view.code && view.available && (view.result === 'unavailable' || view.busy) && <button ref={retryButton} type="button" className="outline-button" aria-disabled={view.busy} onClick={() => { if (!view.busy) void flow.current?.run(); }} data-testid="support-retry">{t('support.retry')}</button>}
    </div>
    <p role="status" aria-live="polite" aria-atomic="true">{view.busy && !view.code ? t('support.retrying') : view.result ? t(view.result === 'pending' ? 'support.pending' : 'support.unavailable') : ''}</p>
  </div>;
}
