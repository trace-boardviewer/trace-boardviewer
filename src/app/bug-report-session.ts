import type { BugReportError, BugReportInput, BugReportPrepareResult, BugReportSendResult, TraceDesktop } from '../lib/types';

export type BugReportPhase = 'editing' | 'review' | 'sending' | 'result';
export type BugReportOutcome = 'idle' | 'received' | 'uncertain' | 'failed' | 'unavailable';
type BugReportSurface = NonNullable<BugReportInput['context']>['surface'];
type BugReportImport = NonNullable<BugReportInput['context']>['lastImport'];

export type BugReportSessionSnapshot = Readonly<{
  input: BugReportInput;
  phase: BugReportPhase;
  outcome: BugReportOutcome;
  preview: Extract<BugReportPrepareResult, { status: 'prepared' }> | null;
  attempted: boolean;
  busy: boolean;
  error: string | null;
}>;

export function shouldPromptForBugReportClose(snapshot: BugReportSessionSnapshot): boolean {
  return !snapshot.busy && snapshot.phase !== 'result' && snapshot.input.description.trim().length > 0;
}

export function shouldPreserveBugReportOnBoardChange(activeModal: string | null): boolean {
  return activeModal === 'bug-report';
}

export function hasBugReportSendCapability(desktop: TraceDesktop | undefined, enabled: boolean): boolean {
  return enabled && typeof desktop?.prepareBugReport === 'function' && typeof desktop.sendBugReport === 'function' && typeof desktop.cancelBugReport === 'function';
}

export function requestBugReportClose(session: BugReportSession, onClose: () => void, onPrompt: () => void): void {
  const current = session.getSnapshot();
  if (current.busy && current.phase === 'sending') {
    void session.cancel();
    onPrompt();
    return;
  }
  if (session.getSnapshot().busy) session.disposePendingPrepare();
  if (shouldPromptForBugReportClose(session.getSnapshot())) onPrompt();
  else onClose();
}

export function leaveBugReportWithoutPersistence(session: BugReportSession, onClose: () => void): void {
  session.disposePendingPrepare();
  onClose();
}

export async function discardBugReportDraft(discard: TraceDesktop['discardBugReportDraft'], afterDiscard: () => void): Promise<BugReportError | null> {
  if (!discard) return 'unavailable';
  try {
    const result = await discard();
    if (result.status !== 'discarded') return result.error;
    afterDiscard();
    return null;
  } catch { return 'storage'; }
}

type Listener = (snapshot: BugReportSessionSnapshot) => void;

/** One form lifetime. Import context and privacy choices are captured at construction; later workspace changes cannot rewrite it. */
export class BugReportSession {
  private snapshot: BugReportSessionSnapshot;
  private listeners = new Set<Listener>();
  private request = 0;
  private inputRevision = 0;
  private readonly desktop: TraceDesktop | undefined;
  private readonly sendEnabled: boolean;
  private contextSnapshot: BugReportInput['context'];

  constructor(options: { desktop?: TraceDesktop; surface: BugReportSurface; lastImport: BugReportImport; sendEnabled?: boolean }) {
    this.desktop = options.desktop;
    this.sendEnabled = options.sendEnabled === true;
    this.contextSnapshot = Object.freeze({ surface: options.surface, lastImport: options.lastImport ?? null });
    this.snapshot = Object.freeze({
      input: Object.freeze({ description: '', includeDiagnostics: true, context: this.contextSnapshot }),
      phase: 'editing', outcome: 'idle', preview: null, attempted: false, busy: false, error: null,
    });
  }

  getSnapshot = (): BugReportSessionSnapshot => this.snapshot;
  getInputRevision = (): number => this.inputRevision;
  subscribe = (listener: Listener): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  private update(patch: Partial<BugReportSessionSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) listener(this.snapshot);
  }

  setDescription(description: string): void {
    if (description === this.snapshot.input.description || this.snapshot.phase === 'sending') return;
    this.inputRevision++;
    this.request++;
    this.update({ input: Object.freeze({ ...this.snapshot.input, description }), preview: null, phase: 'editing', outcome: 'idle', attempted: false, busy: false, error: null });
  }

  restore(input: BugReportInput, pending = false): void {
    if (this.snapshot.phase === 'sending') return;
    this.request++;
    if (input.context) this.contextSnapshot = Object.freeze({ ...input.context });
    const context = input.includeDiagnostics ? (input.context ?? this.contextSnapshot) : null;
    this.update({ input: Object.freeze({ ...input, context }), attempted: pending, outcome: pending ? 'uncertain' : 'idle', preview: null, phase: 'editing', busy: false, error: null });
  }

  restoreIfUnchanged(input: BugReportInput, pending: boolean, expectedRevision: number): boolean {
    if (expectedRevision !== this.inputRevision || this.snapshot.phase === 'sending') return false;
    this.restore(input, pending);
    return true;
  }

  disposePendingPrepare(): void {
    if (this.snapshot.phase === 'sending' || !this.snapshot.busy) return;
    this.request++;
    this.update({ busy: false });
  }

  setDiagnostics(includeDiagnostics: boolean): void {
    if (includeDiagnostics === this.snapshot.input.includeDiagnostics || this.snapshot.phase === 'sending') return;
    this.inputRevision++;
    this.request++;
    this.update({ input: Object.freeze({ ...this.snapshot.input, includeDiagnostics, context: includeDiagnostics ? (this.contextSnapshot ?? this.snapshot.input.context) : null }), preview: null, phase: 'editing', outcome: 'idle', attempted: false, busy: false, error: null });
  }

  async prepare(): Promise<BugReportPrepareResult | null> {
    if (this.snapshot.busy) return null;
    if (!this.desktop?.prepareBugReport) { this.update({ outcome: 'unavailable', error: 'bridge' }); return null; }
    const request = ++this.request;
    this.update({ busy: true, error: null });
    try {
      const result = await this.desktop.prepareBugReport(this.snapshot.input);
      if (request !== this.request) return null;
      if (result.status === 'prepared') this.update({ preview: result, phase: 'review', outcome: 'idle', busy: false });
      else this.update({ busy: false, error: result.error, outcome: this.snapshot.attempted ? 'uncertain' : 'failed' });
      return result;
    } catch {
      if (request === this.request) this.update({ busy: false, error: 'unknown', outcome: this.snapshot.attempted ? 'uncertain' : 'failed' });
      return null;
    }
  }

  back(): void { this.update({ phase: 'editing' }); }

  async send(): Promise<BugReportSendResult | null> {
    const preview = this.snapshot.preview;
    if (this.snapshot.busy || !preview) return null;
    if (!hasBugReportSendCapability(this.desktop, this.sendEnabled)) { this.update({ outcome: 'unavailable', error: 'unavailable' }); return { status: 'error', error: 'unavailable' }; }
    if (!this.desktop?.sendBugReport) { this.update({ outcome: 'unavailable', error: 'bridge' }); return { status: 'error', error: 'unavailable' }; }
    const request = ++this.request;
    this.update({ busy: true, phase: 'sending', attempted: true, error: null });
    let result: BugReportSendResult;
    try { result = await this.desktop.sendBugReport({ prepareId: preview.prepareId }); }
    catch { result = { status: 'error', error: 'unknown' }; }
    if (request !== this.request) return null;
    if (result.status === 'received') this.update({ busy: false, phase: 'result', outcome: 'received', error: null });
    else this.update({ busy: false, phase: 'result', outcome: 'uncertain', error: result.error });
    return result;
  }

  async cancel(): Promise<boolean> {
    const preview = this.snapshot.preview;
    if (!this.snapshot.busy || !preview || !this.desktop?.cancelBugReport) return false;
    try { await this.desktop.cancelBugReport({ prepareId: preview.prepareId }); } catch { /* cancellation is always reported as uncertain by the UI */ }
    return true;
  }
}
