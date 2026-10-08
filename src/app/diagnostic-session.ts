/*
 * The dialog logic of the format diagnostic report (Help > Format diagnostic report; docs/DIAGNOSTIC-REPORT.md): plain TypeScript, no React, every effect
 * through `DiagnosticDeps`, so the whole flow runs in node with fakes. One session is one visit of the dialog:
 *
 *   idle -> picking (the main process opens its own file dialog) -> running (one worker, the parse watchdog of the board import) -> review
 *   review: the user reads the JSON and the plain-language list, may switch level 2 and the repeat-detection code on, then Save (the main process opens
 *   its own save dialog, validates the report again and writes it) or - on an explicit click only - Copy.
 *
 * Nothing leaves the machine: there is no network call, no upload, and the clipboard is touched only by `copy()`, which only a click calls. The file name
 * never reaches this module (the main process hands over a neutral name), and the file bytes are transferred to the worker and dropped here.
 */
import { projectReport } from '../lib/diagnostics/project';
import { reportText, type DiagnosticReport } from '../lib/diagnostics/report';
import type { DiagnosticFilePayload, TraceDesktop } from '../lib/types';
import { DEFAULT_PARSE_WATCHDOG } from './controller';
import type { ControllerTimers, ParseWatchdog, WorkerFactory, WorkerPort } from './controller';

export type DiagnosticPhase = 'idle' | 'picking' | 'running' | 'review' | 'saving' | 'saved';
/** read: the file could not be read; stopped: the watchdog ended a run without progress; worker: the analysis failed; save / copy: that step failed. */
export type DiagnosticFailure = 'read' | 'stopped' | 'worker' | 'save' | 'copy';
export interface DiagnosticState {
  phase: DiagnosticPhase;
  progress: { fraction: number | null; stalled: boolean } | null;
  /** The user's choices in the review. */
  level: 1 | 2;
  dedupe: boolean;
  /** The main process supplied a repeat-detection code for this file. */
  hasDedupe: boolean;
  /** The exact text that Save writes and Copy copies; empty until a report exists. */
  text: string;
  /** What the report says about the file, for the plain-language list (no content: the same enumerations the report holds). */
  facts: { outcome: DiagnosticReport['detection']['outcome']; hook: string | null } | null;
  failure: DiagnosticFailure | null;
  /** The main process's own (already localized) text for a read or save failure, else ''. */
  detail: string;
  /** The text was copied by an explicit click. */
  copied: boolean;
  /** Seconds of the watchdog stop, for the 'stopped' text. */
  stopSeconds: number;
}

type DiagnosticBridge = Required<Pick<TraceDesktop, 'pickDiagnosticFile' | 'saveDiagnosticReport'>>;
export interface DiagnosticDeps {
  desktop: Partial<TraceDesktop> | undefined;
  createWorker: WorkerFactory;
  /** Writes text to the clipboard; called by `copy()` only. */
  copyText?(text: string): Promise<void>;
  watchdog?: Partial<ParseWatchdog>;
  timers?: ControllerTimers;
}

const TIMERS: ControllerTimers = {
  setTimeout: (run, ms) => { const handle = setTimeout(run, ms); (handle as { unref?: () => void }).unref?.(); return handle; },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const INITIAL: DiagnosticState = Object.freeze({
  phase: 'idle', progress: null, level: 1, dedupe: false, hasDedupe: false, text: '', facts: null, failure: null, detail: '', copied: false, stopSeconds: 0,
});
const bufferOf = (bytes: Uint8Array): ArrayBuffer => bytes.buffer as ArrayBuffer;
const DEDUPE_CODE = /^[0-9a-f]{16}$/;
/** The text of a rejected native call (already localized there); anything that is not a string message gives ''. */
const messageOf = (error: unknown): string => (error instanceof Error && typeof error.message === 'string' ? error.message.replace(/^\[[A-Z0-9_]+\] /, '') : '');

/** True only for a desktop bridge that has both calls; without them (the browser build, an older preload) the Help entry is not shown. */
export function diagnosticSupported(desktop: Partial<TraceDesktop> | undefined | null): desktop is Partial<TraceDesktop> & DiagnosticBridge {
  return typeof desktop?.pickDiagnosticFile === 'function' && typeof desktop.saveDiagnosticReport === 'function';
}

export class DiagnosticSession {
  private state: DiagnosticState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private full: DiagnosticReport | null = null;
  private port: WorkerPort | null = null;
  private token = 0;
  private stall: unknown = null;
  private stop: unknown = null;
  private readonly watchdog: ParseWatchdog;
  private readonly timers: ControllerTimers;

  constructor(private readonly deps: DiagnosticDeps) {
    this.watchdog = { ...DEFAULT_PARSE_WATCHDOG, ...deps.watchdog };
    this.timers = deps.timers ?? TIMERS;
  }

  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = (): DiagnosticState => this.state;

  private patch(next: Partial<DiagnosticState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of [...this.listeners]) listener();
  }
  /** The text of the report as the current choices project it (what Save writes). */
  private projected(): DiagnosticReport | null {
    return this.full ? projectReport(this.full, { level: this.state.level, dedupe: this.state.dedupe && this.state.hasDedupe, reviewed: true }) : null;
  }
  private refreshText(extra: Partial<DiagnosticState> = {}): void {
    const report = this.projected();
    this.patch({ text: report ? reportText(report) : '', copied: false, ...extra });
  }

  private disarm(): void {
    if (this.stall !== null) this.timers.clearTimeout(this.stall);
    if (this.stop !== null) this.timers.clearTimeout(this.stop);
    this.stall = this.stop = null;
  }
  private release(): void {
    this.disarm();
    if (this.port) { this.port.terminate(); this.port = null; }
  }
  private arm(token: number): void {
    this.disarm();
    this.stall = this.timers.setTimeout(() => {
      this.stall = null;
      if (token === this.token && this.state.phase === 'running') this.patch({ progress: { fraction: this.state.progress?.fraction ?? null, stalled: true } });
    }, this.watchdog.stallMs);
    this.stop = this.timers.setTimeout(() => {
      this.stop = null;
      if (token !== this.token || this.state.phase !== 'running') return;
      this.release();
      this.patch({ phase: 'idle', progress: null, failure: 'stopped', stopSeconds: Math.round(this.watchdog.stopMs / 1000) });
    }, this.watchdog.stopMs);
  }

  /** Opens the main process's file dialog, then analyses the chosen file in a worker. Does nothing while a step is running. */
  async start(): Promise<void> {
    if (this.state.phase === 'picking' || this.state.phase === 'running' || this.state.phase === 'saving') return;
    const desktop = this.deps.desktop;
    if (!diagnosticSupported(desktop)) return;
    const token = ++this.token;
    this.release();
    this.full = null;
    this.patch({ ...INITIAL, phase: 'picking' });
    let payload: DiagnosticFilePayload | null;
    try { payload = await desktop.pickDiagnosticFile(); }
    catch (error) {
      if (token === this.token) this.patch({ phase: 'idle', failure: 'read', detail: messageOf(error) });
      return;
    }
    if (token !== this.token) return;
    if (!payload) { this.patch({ phase: 'idle' }); return; }
    this.run(payload, token);
  }

  private run(payload: DiagnosticFilePayload, token: number): void {
    const hasDedupe = typeof payload.dedupe === 'string' && DEDUPE_CODE.test(payload.dedupe);
    this.patch({ phase: 'running', progress: { fraction: null, stalled: false }, hasDedupe });
    try {
      this.port = this.deps.createWorker(data => this.onReply(data, token), () => {
        if (token !== this.token || this.state.phase !== 'running') return;
        this.release();
        this.patch({ phase: 'idle', progress: null, failure: 'worker' });
      });
      // The bytes are transferred: this module keeps nothing of the file.
      const data = new Uint8Array(payload.data);
      const companions = payload.companions && Object.fromEntries(Object.entries(payload.companions).map(([name, bytes]) => [name, new Uint8Array(bytes)]));
      const transfer = [bufferOf(data), ...Object.values(companions ?? {}).map(bytes => bufferOf(bytes))];
      this.port.post({ name: payload.name, data, ...(companions ? { companions } : {}), os: payload.os, dedupe: hasDedupe ? payload.dedupe : null }, transfer);
      if (this.port) this.arm(token);
    } catch {
      this.release();
      this.patch({ phase: 'idle', progress: null, failure: 'worker' });
    }
  }

  private onReply(data: unknown, token: number): void {
    if (token !== this.token || this.state.phase !== 'running') return;
    const reply = data as { progress?: { fraction?: unknown }; report?: DiagnosticReport; error?: unknown } | null;
    if (reply?.progress) {
      const fraction = typeof reply.progress.fraction === 'number' && Number.isFinite(reply.progress.fraction) ? Math.min(1, Math.max(0, reply.progress.fraction)) : null;
      this.patch({ progress: { fraction, stalled: false } });
      this.arm(token);
      return;
    }
    this.release();
    if (reply?.report && typeof reply.report === 'object') {
      this.full = reply.report;
      this.patch({ phase: 'review', progress: null, facts: { outcome: reply.report.detection.outcome, hook: reply.report.structure?.hook ?? null } });
      this.refreshText();
    } else this.patch({ phase: 'idle', progress: null, failure: 'worker' });
  }

  /** Ends a running analysis (or a pending dialog) and returns to the start. */
  cancel(): void {
    this.token++;
    this.release();
    this.full = null;
    this.patch({ ...INITIAL });
  }

  setLevel(level: 1 | 2): void {
    if (!this.full || (this.state.phase !== 'review' && this.state.phase !== 'saved')) return;
    this.patch({ level, phase: 'review', failure: null });
    this.refreshText();
  }
  setDedupe(on: boolean): void {
    if (!this.full || !this.state.hasDedupe || (this.state.phase !== 'review' && this.state.phase !== 'saved')) return;
    this.patch({ dedupe: on, phase: 'review', failure: null });
    this.refreshText();
  }

  /** The main process validates the report again, opens its save dialog and writes the text the user sees. Cancel stays in the review. */
  async save(): Promise<void> {
    const desktop = this.deps.desktop;
    const report = this.projected();
    if (!report || !diagnosticSupported(desktop) || (this.state.phase !== 'review' && this.state.phase !== 'saved')) return;
    const token = this.token;
    this.patch({ phase: 'saving', failure: null, detail: '' });
    try {
      const result = await desktop.saveDiagnosticReport(report);
      if (token === this.token) this.patch({ phase: result ? 'saved' : 'review' });
    } catch (error) {
      if (token === this.token) this.patch({ phase: 'review', failure: 'save', detail: messageOf(error) });
    }
  }

  /** Copies the shown text to the clipboard. Only an explicit click calls this; nothing ever copies by itself. */
  async copy(): Promise<void> {
    if (!this.state.text || !this.deps.copyText) return;
    const token = this.token;
    try {
      await this.deps.copyText(this.state.text);
      if (token === this.token) this.patch({ copied: true, failure: null });
    } catch { if (token === this.token) this.patch({ copied: false, failure: 'copy' }); }
  }

  /** The dialog was closed: stops any worker and forgets the report. */
  dispose(): void {
    this.token++;
    this.release();
    this.full = null;
    this.listeners.clear();
  }
}

export function createDiagnosticSession(deps: DiagnosticDeps): DiagnosticSession {
  return new DiagnosticSession(deps);
}
