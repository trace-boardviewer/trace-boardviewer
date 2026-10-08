import { useEffect, useState } from 'react';
import type { Translator } from '../lib/i18n';
import type { SupportStatus } from '../lib/types';

export default function SupportVerification({ t, onVerified }: { t: Translator; onVerified?: (value: SupportStatus) => void }) {
  const [code, setCode] = useState('');
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'pending' | 'unavailable' | null>(null);
  useEffect(() => {
    let alive = true;
    window.traceDesktop?.prepareSupport?.().then(value => { if (alive && /^[a-f0-9]{32}$/.test(value.code)) { setCode(value.code); setAvailable(value.available === true); } }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!available) return null;
  const check = async () => {
    if (busy) return;
    setBusy(true); setResult(null);
    try {
      const value = await window.traceDesktop?.checkSupport?.();
      if (value?.status === 'verified') onVerified?.(value);
      else setResult(value?.status === 'pending' ? 'pending' : 'unavailable');
    } catch { setResult('unavailable'); }
    finally { setBusy(false); }
  };
  return <div className="support-verification" data-testid="support-verification">
    <p>{t('support.referenceHint')}</p>
    <input aria-label={t('support.reference')} readOnly value={'TRACE-' + code} onFocus={event => event.currentTarget.select()} />
    <button type="button" className="outline-button" disabled={busy} onClick={() => void check()} data-testid="support-verify">{t('support.verify')}</button>
    {result && <p role="status">{t(result === 'pending' ? 'support.pending' : 'support.unavailable')}</p>}
  </div>;
}
