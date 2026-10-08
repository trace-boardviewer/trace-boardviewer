import { AlertCircle, Check, ClipboardCopy, FileSearch, Save, ShieldCheck } from 'lucide-react';
import { useEffect, useId, useMemo, useSyncExternalStore } from 'react';
import { createDiagnosticSession } from '../app/diagnostic-session';
import type { DiagnosticFailure, DiagnosticSession, DiagnosticState } from '../app/diagnostic-session';
import type { MessageKey, Translator } from '../lib/i18n';
import { Modal } from './workspace/ui';
import { useUi } from './workspace/ui-context';
import './diagnostic-report.css';

/**
 * Help > "Format diagnostic report…" (logic: src/app/diagnostic-session.ts; collector: src/lib/diagnostics; main-process half: electron/main.cjs,
 * 'trace:diagnostic-pick' and 'trace:diagnostic-save'). One dialog, three views:
 *  - start: what the report is for, what it contains and what it never contains, and the button that opens the main process's file dialog;
 *  - running: a progress bar with Cancel (the watchdog of the board import ends a run that makes no progress);
 *  - review: the plain-language list of what is included (it follows the two opt-in switches), the residual-risk notice, the switches (level 2, repeat-detection
 *    code, both off), the JSON exactly as it will be written, and Save (the main process's save dialog) and Copy text (an explicit click, never automatic).
 * Nothing in the dialog sends anything anywhere.
 */
export const DIAGNOSTIC_KEYS = {
  title: 'diagnostic.title', intro: 'diagnostic.intro', choose: 'diagnostic.choose', chooseAnother: 'diagnostic.chooseAnother', picking: 'diagnostic.picking',
  running: 'diagnostic.running', stalled: 'diagnostic.stalled', cancel: 'diagnostic.cancel', stopped: 'diagnostic.stopped', workerFailed: 'diagnostic.workerFailed', readFailed: 'diagnostic.readFailed',
  includedTitle: 'diagnostic.includedTitle', incApp: 'diagnostic.incApp', incFile: 'diagnostic.incFile', incDetection: 'diagnostic.incDetection', incStructure: 'diagnostic.incStructure',
  incResult: 'diagnostic.incResult', incChecks: 'diagnostic.incChecks', incPerformance: 'diagnostic.incPerformance', incLevel2: 'diagnostic.incLevel2', incDedupe: 'diagnostic.incDedupe',
  neverTitle: 'diagnostic.neverTitle', never: 'diagnostic.never', level2Label: 'diagnostic.level2Label', level2Hint: 'diagnostic.level2Hint', dedupeLabel: 'diagnostic.dedupeLabel',
  dedupeHint: 'diagnostic.dedupeHint', risk: 'diagnostic.risk', reportTitle: 'diagnostic.reportTitle', save: 'diagnostic.save', saving: 'diagnostic.saving', saved: 'diagnostic.saved',
  saveFailed: 'diagnostic.saveFailed', copy: 'diagnostic.copy', copied: 'diagnostic.copied', copyFailed: 'diagnostic.copyFailed',
  outcomeOpened: 'diagnostic.outcomeOpened', outcomeFailed: 'diagnostic.outcomeFailed', outcomeUnrecognized: 'diagnostic.outcomeUnrecognized',
} as const satisfies Record<string, MessageKey>;
const K = DIAGNOSTIC_KEYS;

const OUTCOME_KEY = { opened: K.outcomeOpened, failed: K.outcomeFailed, unrecognized: K.outcomeUnrecognized } as const;

/** The lines of "What this report contains", in the order of the report; the two opt-in lines appear only while their switch is on. */
export function includedKeys(state: Pick<DiagnosticState, 'level' | 'dedupe' | 'hasDedupe' | 'facts'>): MessageKey[] {
  const keys: MessageKey[] = [K.incApp, K.incFile, K.incDetection, K.incStructure];
  if (state.facts?.outcome === 'opened' || !state.facts) keys.push(K.incResult, K.incChecks);
  keys.push(K.incPerformance);
  if (state.level === 2) keys.push(K.incLevel2);
  if (state.dedupe && state.hasDedupe) keys.push(K.incDedupe);
  return keys;
}

function failureText(t: Translator, failure: DiagnosticFailure, state: DiagnosticState): string {
  switch (failure) {
    case 'stopped': return t(K.stopped, { seconds: state.stopSeconds });
    case 'worker': return t(K.workerFailed);
    case 'copy': return t(K.copyFailed);
    case 'save': return state.detail || t(K.saveFailed);
    default: return state.detail || t(K.readFailed);
  }
}

/** The static half of the start view and the review: what the report is, and what it never holds. */
function NeverList({ t }: { t: Translator }) {
  return <section className="diag-section" aria-label={t(K.neverTitle)}>
    <h3><ShieldCheck size={13} aria-hidden="true" />{t(K.neverTitle)}</h3>
    <p className="settings-hint">{t(K.never)}</p>
  </section>;
}

export function DiagnosticView({ session, t }: { session: DiagnosticSession; t: Translator }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const listId = useId();
  const failure = state.failure ? failureText(t, state.failure, state) : '';
  const review = state.phase === 'review' || state.phase === 'saving' || state.phase === 'saved';
  return <div className="diag" data-testid="diagnostic-dialog-body" data-phase={state.phase}>
    {!review && <p className="settings-hint">{t(K.intro)}</p>}
    {failure && <p className="data-warning diag-failure" role="alert" data-testid="diagnostic-failure"><AlertCircle size={16} aria-hidden="true" /><span>{failure}</span></p>}

    {(state.phase === 'idle' || state.phase === 'picking') && <>
      <section className="diag-section" aria-labelledby={listId}>
        <h3 id={listId}>{t(K.includedTitle)}</h3>
        <ul className="diag-list">{includedKeys({ level: 1, dedupe: false, hasDedupe: false, facts: null }).map(key => <li key={key}>{t(key)}</li>)}</ul>
      </section>
      <NeverList t={t} />
      <div className="modal-footer">
        <button type="button" className="primary-button" data-testid="diagnostic-choose" disabled={state.phase === 'picking'} onClick={() => void session.start()}>
          <FileSearch size={16} aria-hidden="true" />{state.phase === 'picking' ? t(K.picking) : t(K.choose)}
        </button>
      </div>
    </>}

    {state.phase === 'running' && <>
      <p className="diag-status" role="status" data-testid="diagnostic-running">{t(K.running)}</p>
      {state.progress?.fraction != null
        ? <progress className="diag-progress" max={1} value={state.progress.fraction} aria-label={t(K.running)} />
        : <progress className="diag-progress" aria-label={t(K.running)} />}
      {state.progress?.stalled && <p className="settings-hint" role="status" data-testid="diagnostic-stalled">{t(K.stalled)}</p>}
      <div className="modal-footer"><button type="button" className="outline-button" data-testid="diagnostic-cancel" onClick={() => session.cancel()}>{t(K.cancel)}</button></div>
    </>}

    {review && <>
      {state.facts && <p className="diag-status" data-testid="diagnostic-outcome">{t(OUTCOME_KEY[state.facts.outcome])}</p>}
      <section className="diag-section" aria-labelledby={listId}>
        <h3 id={listId}>{t(K.includedTitle)}</h3>
        <ul className="diag-list" data-testid="diagnostic-included">{includedKeys(state).map(key => <li key={key}>{t(key)}</li>)}</ul>
      </section>
      <NeverList t={t} />
      <div className="setting-toggles diag-toggles">
        <label><span><strong>{t(K.level2Label)}</strong><small>{t(K.level2Hint)}</small></span>
          <input type="checkbox" role="switch" data-testid="diagnostic-level2" checked={state.level === 2} onChange={event => session.setLevel(event.target.checked ? 2 : 1)} /></label>
        {state.hasDedupe && <label><span><strong>{t(K.dedupeLabel)}</strong><small>{t(K.dedupeHint)}</small></span>
          <input type="checkbox" role="switch" data-testid="diagnostic-dedupe" checked={state.dedupe} onChange={event => session.setDedupe(event.target.checked)} /></label>}
      </div>
      <p className="data-warning diag-risk" data-testid="diagnostic-risk"><AlertCircle size={16} aria-hidden="true" /><span>{t(K.risk)}</span></p>
      <h3 className="diag-json-title">{t(K.reportTitle)}</h3>
      <pre className="diag-json mono" tabIndex={0} aria-label={t(K.reportTitle)} data-testid="diagnostic-json">{state.text}</pre>
      <p className="diag-status" role="status" data-testid="diagnostic-status">
        {state.phase === 'saved' ? t(K.saved) : state.copied ? t(K.copied) : state.phase === 'saving' ? t(K.saving) : ''}
      </p>
      <div className="modal-footer diag-actions">
        <button type="button" className="outline-button" data-testid="diagnostic-again" disabled={state.phase === 'saving'} onClick={() => void session.start()}>{t(K.chooseAnother)}</button>
        <button type="button" className="outline-button" data-testid="diagnostic-copy" disabled={state.phase === 'saving'} onClick={() => void session.copy()}><ClipboardCopy size={15} aria-hidden="true" />{t(K.copy)}</button>
        <button type="button" className="primary-button" data-testid="diagnostic-save" disabled={state.phase === 'saving'} onClick={() => void session.save()}>
          {state.phase === 'saved' ? <Check size={16} aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}{state.phase === 'saving' ? t(K.saving) : t(K.save)}
        </button>
      </div>
    </>}
  </div>;
}

/**
 * The worker of one run. The `new Worker(new URL('<literal>', import.meta.url), ...)` form must stay literal: it is what Vite recognizes to bundle a worker.
 */
export function createDiagnosticWorker(onMessage: (data: unknown) => void, onError: () => void) {
  const worker = new Worker(new URL('../lib/diagnostic-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = event => onMessage(event.data);
  worker.onerror = () => onError();
  return {
    post: (message: unknown, transfer?: Transferable[]) => worker.postMessage(message, transfer ?? []),
    terminate: () => { worker.onmessage = null; worker.onerror = null; worker.terminate(); },
  };
}

export default function DiagnosticDialog({ onClose, session: provided }: { onClose(): void; session?: DiagnosticSession }) {
  const { t } = useUi();
  const session = useMemo(() => provided ?? createDiagnosticSession({
    desktop: typeof window === 'undefined' ? undefined : window.traceDesktop, createWorker: createDiagnosticWorker,
    // Only the Copy text button calls this.
    copyText: text => navigator.clipboard.writeText(text),
  }), [provided]);
  // Closing the dialog ends a running analysis and forgets the report.
  useEffect(() => () => session.dispose(), [session]);
  return <Modal title={t(K.title)} closeLabel={t('common.close')} close={onClose} wide testId="diagnostic-dialog">
    <DiagnosticView session={session} t={t} />
  </Modal>;
}
