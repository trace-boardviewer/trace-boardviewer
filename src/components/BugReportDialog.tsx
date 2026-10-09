import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BugReportSession, discardBugReportDraft, hasBugReportSendCapability, leaveBugReportWithoutPersistence, requestBugReportClose } from '../app/bug-report-session';
import type { BugReportInput, BugReportError, BugReportLastImport, TraceDesktop } from '../lib/types';
import type { Translator } from '../lib/i18n';
import { findSensitiveDescriptionDetails, removeSensitiveDescriptionDetails } from '../lib/bug-report-description';
import './bug-report-dialog.css';

export const BUG_REPORT_SEND_ENABLED = true;
export const BUG_REPORT_CLOSE_TEST_IDS = Object.freeze({ header: 'bug-report-close', result: 'bug-report-result-close' });
const REPLACEMENT = '•••';

export function bugReportLeaveWarning(snapshot: { attempted: boolean; outcome: string }, journalUnknown: boolean, hasDesktop: boolean): 'diagnostic.bugReceived' | 'diagnostic.bugUnconfirmed' | 'diagnostic.bugStorageUnavailable' | 'diagnostic.bugDraftLocalInfo' {
  if (snapshot.outcome === 'received') return 'diagnostic.bugReceived';
  if (snapshot.attempted || snapshot.outcome === 'uncertain' || journalUnknown) return 'diagnostic.bugUnconfirmed';
  return hasDesktop ? 'diagnostic.bugDraftLocalInfo' : 'diagnostic.bugStorageUnavailable';
}

export function trapBugReportPromptTab(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>, controls: readonly Pick<HTMLElement, 'focus'>[], activeIndex: number): void {
  if (event.key !== 'Tab') return;
  if (controls.length === 0) { event.preventDefault(); return; }
  const last = controls.length - 1;
  if (event.shiftKey && activeIndex <= 0) { event.preventDefault(); controls[last].focus(); }
  else if (!event.shiftKey && (activeIndex < 0 || activeIndex === last)) { event.preventDefault(); controls[0].focus(); }
}

export function handleBugReportPromptKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>, controls: readonly Pick<HTMLElement, 'focus'>[], activeIndex: number, dismiss: () => void): void {
  if (event.key === 'Escape') { event.preventDefault(); dismiss(); return; }
  trapBugReportPromptTab(event, controls, activeIndex);
}

export async function copyBugReportText(description: string, clipboard: Pick<Clipboard, 'writeText'>): Promise<boolean> {
  try { await clipboard.writeText(description); return true; }
  catch { return false; }
}

function errorKey(error: BugReportError | string | null): Parameters<Translator>[0] {
  const keys: Record<string, Parameters<Translator>[0]> = {
    offline: 'diagnostic.bugErrorOffline', timeout: 'diagnostic.bugErrorTimeout', cancelled: 'diagnostic.bugErrorCancelled',
    invalid: 'diagnostic.bugErrorInvalid', 'too-large': 'diagnostic.bugErrorTooLarge', 'rate-limited': 'diagnostic.bugErrorRateLimited',
    unavailable: 'diagnostic.bugErrorUnavailable', storage: 'diagnostic.bugErrorStorage', conflict: 'diagnostic.bugErrorConflict',
    busy: 'diagnostic.bugErrorBusy', 'stale-preview': 'diagnostic.bugErrorStalePreview', unknown: 'diagnostic.bugErrorUnknown', bridge: 'diagnostic.bugBridgeUnavailable',
  };
  return keys[error ?? 'unknown'] ?? 'diagnostic.bugErrorUnknown';
}

function surfaceKey(surface: NonNullable<BugReportInput['context']>['surface']): Parameters<Translator>[0] {
  return ({ welcome: 'diagnostic.bugSurfaceWelcome', board: 'diagnostic.bugSurfaceBoard', documents: 'diagnostic.bugSurfaceDocuments', schematic: 'diagnostic.bugSurfaceSchematic', settings: 'diagnostic.bugSurfaceSettings', other: 'diagnostic.bugSurfaceOther' } as const)[surface];
}
function importLabel(t: Translator, last: BugReportLastImport): string {
  if (!last) return '—';
  const outcome = ({ reading: 'diagnostic.bugOutcomeReading', processing: 'diagnostic.bugOutcomeProcessing', opened: 'diagnostic.bugOutcomeOpened', failed: 'diagnostic.bugOutcomeFailed', cancelled: 'diagnostic.bugOutcomeCancelled', 'key-required': 'diagnostic.bugOutcomeKeyRequired', timeout: 'diagnostic.bugOutcomeTimeout', 'worker-failed': 'diagnostic.bugOutcomeWorkerFailed' } as const)[last.outcome];
  const stage = ({ read: 'diagnostic.bugStageRead', detect: 'diagnostic.bugStageDetect', unpack: 'diagnostic.bugStageUnpack', parse: 'diagnostic.bugStageParse', done: 'diagnostic.bugStageDone', unknown: 'diagnostic.bugStageUnknown' } as const)[last.stage];
  return `${t(outcome)} · ${t(stage)}${last.formatId ? ` · ${last.formatId}` : ''}${last.extensionClass !== 'none' ? ` · ${last.extensionClass}` : ''}${last.errorCode ? ` · ${last.errorCode}` : ''}`;
}

export default function BugReportDialog({ t, surface, lastImport, desktop, onClose, sendEnabled = BUG_REPORT_SEND_ENABLED }: {
  t: Translator; surface: NonNullable<BugReportInput['context']>['surface']; lastImport: BugReportLastImport;
  desktop?: TraceDesktop; onClose: () => void; sendEnabled?: boolean;
}) {
  const titleId = useId();
  const closePromptDescriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const description = useRef<HTMLTextAreaElement>(null);
  const closePromptRef = useRef<HTMLDivElement>(null);
  const closePromptFocus = useRef<HTMLButtonElement>(null);
  const promptInvoker = useRef<HTMLElement | null>(null);
  const invoker = useRef(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const canSend = hasBugReportSendCapability(desktop, sendEnabled);
  const [session] = useState(() => new BugReportSession({ desktop, surface, lastImport: lastImport ?? null, sendEnabled: canSend }));
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [closePrompt, setClosePrompt] = useState(false);
  const [message, setMessage] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  const [draft, setDraft] = useState<BugReportInput | null>(null);
  const [journalUnknown, setJournalUnknown] = useState(!!desktop && !desktop.getBugReportDraft);
  const [showJson, setShowJson] = useState(false);
  const [editedAfterAttempt, setEditedAfterAttempt] = useState(false);
  const input = snapshot.input;
  const matches = useMemo(() => {
    try { return findSensitiveDescriptionDetails(input.description); } catch { return []; }
  }, [input.description]);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    node.showModal();
    description.current?.focus({ preventScroll: true });
    let alive = true;
    const draftReadRevision = session.getInputRevision();
    void desktop?.getBugReportDraft?.().then(result => {
      if (!alive) return;
      if (result.status === 'available') {
        setJournalUnknown(false);
        const pendingInput: BugReportInput | null = result.pending ? {
          description: result.pending.report.description,
          includeDiagnostics: result.pending.report.diagnostics !== null,
          context: result.pending.report.diagnostics ? { surface: result.pending.report.diagnostics.surface, lastImport: result.pending.report.diagnostics.lastImport } : null,
        } : null;
        const restored = pendingInput ?? result.draft;
        setDraft(result.draft ?? pendingInput);
        if (restored && session.restoreIfUnchanged(restored, !!pendingInput, draftReadRevision)) {
          setMessage(t(pendingInput ? 'diagnostic.bugUnconfirmed' : 'diagnostic.bugDraftRestored'));
        }
      }
      if (result.status === 'error') { setJournalUnknown(true); setMessage(t('diagnostic.bugUnconfirmed')); }
      setDraftReady(true);
    }).catch(() => { if (alive) { setJournalUnknown(true); setMessage(t('diagnostic.bugUnconfirmed')); setDraftReady(true); } });
    if (!desktop?.getBugReportDraft) setDraftReady(true);
    return () => { alive = false; session.disposePendingPrepare(); node.close(); if (invoker.current?.isConnected) invoker.current.focus({ preventScroll: true }); };
  }, [desktop, session, t]);

  useEffect(() => {
    if (closePrompt) closePromptFocus.current?.focus({ preventScroll: true });
    else if (promptInvoker.current?.isConnected) { promptInvoker.current.focus({ preventScroll: true }); promptInvoker.current = null; }
  }, [closePrompt]);

  const dismissClosePrompt = () => setClosePrompt(false);

  const requestClose = () => {
    void requestBugReportClose(session, onClose, () => {
      promptInvoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setClosePrompt(true);
    });
  };
  const saveDraft = async (): Promise<boolean> => {
    if (!desktop?.saveBugReportDraft) { setMessage(t('diagnostic.bugBridgeUnavailable')); return false; }
    try {
      const result = await desktop.saveBugReportDraft(input);
      if (result.status === 'saved') { setDraft(input); setJournalUnknown(false); setMessage(t('diagnostic.bugDraftSaved')); return true; }
      setJournalUnknown(true);
      setMessage(t(snapshot.attempted || editedAfterAttempt ? 'diagnostic.bugUnconfirmed' : 'diagnostic.bugStorageUnavailable')); return false;
    } catch { setJournalUnknown(true); setMessage(t(snapshot.attempted || editedAfterAttempt ? 'diagnostic.bugUnconfirmed' : 'diagnostic.bugStorageUnavailable')); return false; }
  };
  const discardDraft = async (): Promise<boolean> => {
    const closeAfterDiscard = closePrompt;
    const error = await discardBugReportDraft(desktop?.discardBugReportDraft, () => {
      setDraft(null); setJournalUnknown(false); setClosePrompt(false);
      if (closeAfterDiscard) { promptInvoker.current = null; onClose(); }
      else if (description.current?.isConnected) description.current.focus({ preventScroll: true });
    });
    if (error) { if (error === 'storage' || error === 'unavailable') setJournalUnknown(true); setMessage(t(error === 'storage' || error === 'unavailable' ? 'diagnostic.bugStorageUnavailable' : errorKey(error))); return false; }
    return true;
  };
  const makePreview = async () => {
    const result = await session.prepare();
    if (result?.status === 'prepared') { setMessage(''); setShowJson(true); }
    else if (result?.status === 'error') setMessage(t(errorKey(result.error)));
  };
  const send = async () => { const result = await session.send(); if (result?.status === 'error') setMessage(t(errorKey(result.error))); else if (result?.status === 'received') setMessage(t('diagnostic.bugReceived')); };
  const retry = async () => { await makePreview(); if (canSend) await send(); };
  const removeDetails = () => {
    try { session.setDescription(removeSensitiveDescriptionDetails(input.description, REPLACEMENT)); }
    catch { setMessage(t('diagnostic.bugErrorInvalid')); }
  };
  const copyDescription = async () => {
    if (await copyBugReportText(input.description, navigator.clipboard)) setMessage(t('diagnostic.copy'));
    else setMessage(t('diagnostic.copyFailed'));
  };
  const preview = snapshot.preview;

  return <dialog ref={dialog} className="bug-report-dialog" aria-labelledby={titleId} data-testid="bug-report-dialog"
    onCancel={event => { event.preventDefault(); requestClose(); }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); requestClose(); } }}>
    <div className="bug-report-inner">
      <div className="bug-report-content" inert={closePrompt || undefined} aria-hidden={closePrompt || undefined}>
      <header className="bug-report-heading"><h2 id={titleId}>{t('diagnostic.bugTitle')}</h2><button type="button" className="bug-report-close" data-testid={BUG_REPORT_CLOSE_TEST_IDS.header} aria-label={t('common.close')} onClick={requestClose}>×</button></header>
      {snapshot.phase === 'editing' && <>
        <label className="bug-report-field"><span>{t('diagnostic.bugWhatHappened')}</span><textarea ref={description} data-testid="bug-report-description" value={input.description} maxLength={8192} onChange={event => { if (snapshot.attempted) setEditedAfterAttempt(true); session.setDescription(event.target.value); }} aria-describedby="bug-report-hint" /></label>
        <p id="bug-report-hint" className="bug-report-hint">{t('diagnostic.bugDescriptionHint')}</p>
        {editedAfterAttempt && <p className="bug-report-status" role="status">{t('diagnostic.bugEditedAfterAttempt')}</p>}
        {matches.length > 0 && <section className="bug-report-privacy-review" aria-live="polite"><p>{t('diagnostic.bugDetectedCount', { count: matches.length })}</p><p>{t('diagnostic.bugReviewReplacement')}</p><button type="button" className="outline-button" onClick={removeDetails}>{t('diagnostic.bugRemoveDetected')}</button></section>}
        <label className="bug-report-check"><input type="checkbox" data-testid="bug-report-diagnostics" checked={input.includeDiagnostics} onChange={event => { if (snapshot.attempted) setEditedAfterAttempt(true); session.setDiagnostics(event.target.checked); }} />{t('diagnostic.bugIncludeTechnical')}</label>
        {input.includeDiagnostics && input.context && <div className="bug-report-facts"><strong>{t('diagnostic.bugTechnicalSummary')}</strong><span>{t(surfaceKey(input.context.surface))}</span><span>{importLabel(t, input.context.lastImport)}</span></div>}
        <details className="bug-report-privacy"><summary>{t('diagnostic.bugPrivacyDetails')}</summary><p>{t('diagnostic.bugSendOnlyHint')}</p><p>{t('diagnostic.bugMinimalData')}</p><p>{t('diagnostic.bugProviderMetadata')}</p><p>{t('diagnostic.bugRetention')}</p><p>{t('diagnostic.bugCleanupTiming')}</p><p>{t('diagnostic.bugDraftLocalInfo')}</p></details>
        {!desktop && <p className="bug-report-status" role="status">{t('diagnostic.bugWebUnavailable')}</p>}
        {desktop && !canSend && <p className="bug-report-status" role="status">{t('diagnostic.bugBridgeUnavailable')}</p>}
        {message && <p className="bug-report-status" role="status">{message}</p>}
        {!closePrompt && <div className="bug-report-actions">
          <button type="button" className="outline-button" data-testid="bug-report-cancel" onClick={requestClose}>{t('diagnostic.cancel')}</button>
          <button type="button" className="outline-button" data-testid="bug-report-save-draft" disabled={!draftReady || !input.description.trim()} onClick={() => void saveDraft()}>{t('diagnostic.bugSaveDraft')}</button>
          {draft && !journalUnknown && desktop?.discardBugReportDraft && <button type="button" className="outline-button" data-testid="bug-report-discard-draft" onClick={() => void discardDraft()}>{t('diagnostic.bugDiscardDraft')}</button>}
          <button type="button" className="outline-button" data-testid="bug-report-copy" onClick={() => void copyDescription()}>{t('diagnostic.copy')}</button>
          <button type="button" className="primary-button" data-testid="bug-report-review" disabled={!draftReady || !input.description.trim() || snapshot.busy} onClick={() => void makePreview()}>{t('diagnostic.bugReview')}</button>
        </div>}
      </>}
      {snapshot.phase === 'review' && preview && <>
        <h3>{t('diagnostic.bugReview')}</h3>
        <pre className="bug-report-preview" data-testid="bug-report-preview">{preview.canonicalText}</pre>
        <p className="bug-report-hash">{t('diagnostic.bugHashBytes', { hash: preview.payloadHash, bytes: new TextEncoder().encode(preview.canonicalText).byteLength })}</p>
        {showJson && <details className="bug-report-json" open><summary>{t('diagnostic.bugExactJson')}</summary><pre>{preview.canonicalText}</pre></details>}
        <p className="bug-report-status" role="status">{canSend ? t('diagnostic.bugSendOnlyHint') : t('diagnostic.bugBridgeUnavailable')}</p>
        {message && <p className="bug-report-status" role="status">{message}</p>}
        <div className="bug-report-actions">
          <button type="button" className="outline-button" data-testid="bug-report-back" onClick={() => { session.back(); setShowJson(false); }}>{t('diagnostic.bugBack')}</button>
          <button type="button" className="outline-button" onClick={() => void copyDescription()}>{t('diagnostic.copy')}</button>
          <button type="button" className="outline-button" data-testid="bug-report-cancel" onClick={requestClose}>{t('diagnostic.cancel')}</button>
          <button type="button" className="primary-button" data-testid={snapshot.attempted ? 'bug-report-retry' : 'bug-report-send'} disabled={!canSend || snapshot.busy} onClick={() => void send()}>{snapshot.busy ? t('diagnostic.bugSending') : t(snapshot.attempted ? 'support.retry' : 'diagnostic.bugSend')}</button>
        </div>
      </>}
      {(snapshot.phase === 'sending' || snapshot.phase === 'result') && <section className="bug-report-result" data-testid="bug-report-result" role="status" aria-live="polite">
        <p>{snapshot.outcome === 'received' ? t('diagnostic.bugReference', { reference: preview?.report.reportId ?? '' }) : snapshot.outcome === 'uncertain' ? t('diagnostic.bugUnconfirmed') : snapshot.error ? t(errorKey(snapshot.error)) : t('diagnostic.bugSending')}</p>
        {snapshot.busy && <button type="button" className="outline-button" data-testid="bug-report-cancel" onClick={() => void session.cancel()}>{t('diagnostic.cancel')}</button>}
        {snapshot.outcome === 'uncertain' && <><p>{t('diagnostic.bugEditedAfterAttempt')}</p><button type="button" className="outline-button" data-testid="bug-report-back" onClick={() => session.back()}>{t('diagnostic.bugBack')}</button><button type="button" className="outline-button" data-testid="bug-report-retry" disabled={!canSend || snapshot.busy} onClick={() => void retry()}>{t('support.retry')}</button></>}
        {!snapshot.busy && <button type="button" className="primary-button" data-testid={BUG_REPORT_CLOSE_TEST_IDS.result} onClick={onClose}>{t('common.close')}</button>}
      </section>}
      </div>
      {closePrompt && <div ref={closePromptRef} className="bug-report-confirm" role="alertdialog" aria-modal="true" aria-label={t('diagnostic.bugTitle')} aria-describedby={closePromptDescriptionId} tabIndex={-1}
        onKeyDown={event => {
          event.stopPropagation();
          const controls = [...(closePromptRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])];
          handleBugReportPromptKey(event, controls, controls.indexOf(document.activeElement as HTMLElement), dismissClosePrompt);
        }}>
        <p id={closePromptDescriptionId}>{t(bugReportLeaveWarning(snapshot, journalUnknown, !!desktop))}</p>
        {message && <p className="bug-report-status" role="status">{message}</p>}
        {desktop?.saveBugReportDraft && <button ref={closePromptFocus} type="button" className="primary-button" onClick={() => void saveDraft().then(saved => { if (saved) onClose(); })} data-testid="bug-report-save-draft">{t('diagnostic.bugKeepDraft')}</button>}
        {draft && !journalUnknown && desktop?.discardBugReportDraft && <button type="button" className="outline-button" onClick={() => void discardDraft()} data-testid="bug-report-discard-draft">{t('diagnostic.bugDiscardDraft')}</button>}
        <button ref={!desktop?.saveBugReportDraft ? closePromptFocus : undefined} type="button" className="outline-button" onClick={() => leaveBugReportWithoutPersistence(session, onClose)} data-testid="bug-report-leave">{t('common.close')}</button>
        <button type="button" className="outline-button" onClick={dismissClosePrompt}>{t('diagnostic.bugContinueEditing')}</button>
      </div>}
    </div>
  </dialog>;
}
