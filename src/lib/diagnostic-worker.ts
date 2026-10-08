import { collectDiagnostic } from './diagnostics/collect';
import type { OsFamily } from './diagnostics/report';

/**
 * The worker of the format diagnostic report (Help > Format diagnostic report, docs/DIAGNOSTIC-REPORT.md), one per run. It receives the bytes of ONE file
 * with its companions under the neutral name the main process chose, runs the collector (src/lib/diagnostics/collect.ts) and answers with the full report
 * (level 2; the review dialog derives what is shared) or a failure without any text of the file. Progress messages ({ progress: { fraction } }) are the
 * signs of life the dialog's watchdog waits for. The worker makes no request of any kind and reads nothing but this one message.
 */
interface RunMessage {
  name: string;
  data: Uint8Array;
  companions?: Record<string, Uint8Array>;
  options?: { fzKey?: number[]; xzzKey?: string };
  os: OsFamily;
  dedupe: string | null;
}
const OS_FAMILIES: readonly string[] = ['win32', 'darwin', 'linux', 'other'];
const PROGRESS_STEP = 0.02;
/** Shape check of the one request (exported for the tests). */
export const isRun = (value: unknown): value is RunMessage => {
  const message = value as Partial<RunMessage> | null;
  return !!message && typeof message === 'object' && typeof message.name === 'string' && message.data instanceof Uint8Array && typeof message.os === 'string' && OS_FAMILIES.includes(message.os)
    && (message.dedupe === null || typeof message.dedupe === 'string') && (message.companions === undefined || (typeof message.companions === 'object' && message.companions !== null));
};

let started = false;
self.onmessage = (event: MessageEvent<unknown>) => {
  if (started) return; // one file per worker
  started = true;
  if (!isRun(event.data)) { self.postMessage({ error: 'INVALID_REQUEST' }); return; }
  const { name, data, companions, options, os, dedupe } = event.data;
  let posted = 0;
  const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  collectDiagnostic({ name, data, ...(companions ? { companions } : {}), ...(options ? { options } : {}) }, {
    os, dedupe, now: () => performance.now(), heap: () => (typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null),
    progress: fraction => {
      if (fraction - posted < PROGRESS_STEP && fraction < 1) return;
      posted = fraction;
      self.postMessage({ progress: { fraction } });
    },
  }).then(report => self.postMessage({ report }), (error: unknown) => {
    // Never the message: an error text could quote the file. The class of the failure is all the dialog needs.
    self.postMessage({ error: error instanceof RangeError ? 'TOO_LARGE' : 'FAILED' });
  });
};
