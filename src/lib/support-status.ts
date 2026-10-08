import { useEffect, useState } from 'react';
import type { SupportStatus, TraceDesktop } from './types';

export function supportIsActive(value: SupportStatus | null, now = Date.now()): boolean {
  return value?.status === 'verified' && typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt) && value.expiresAt > now;
}

/** Reads only the local signed receipt. No startup, hourly or focus-triggered network request. */
export function useSupportStatus(desktop: TraceDesktop | undefined) {
  const [value, setValue] = useState<SupportStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => desktop?.getSupportStatus?.()).then(result => { if (alive) { setValue(result ?? null); setReady(true); } }, () => { if (alive) setReady(true); });
    const timer = setInterval(() => setClock(Date.now()), 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [desktop]);
  return { ready, active: supportIsActive(value, clock), verified: (result: SupportStatus) => { setValue(result); setClock(Date.now()); } };
}
