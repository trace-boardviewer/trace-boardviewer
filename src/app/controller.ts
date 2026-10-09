import type { ViewerCamera, ViewerHighlight } from '../components/viewer-contracts';
import { companionNames } from '../lib/formats';
import { boardIndexOf } from '../lib/board-index';
import {
  buildSchematicIndex, linkBoardSchematic, normalizeQuery, resolvePdfRefHits, searchAll, searchBoardGroups, DEFAULT_SEARCH_LIMITS,
} from '../lib/crossprobe';
import type { BoardIndex, BoardSearchGroups, DocumentSearchSource, SchematicIndex, SchematicSource, SearchRow } from '../lib/crossprobe';
import { MODEL_PROTOCOL } from '../lib/model-protocol';
import { ERROR_CODES, EXTENSIONS, FORMAT_IDS } from '../lib/diagnostics/report';
import type { DocumentAnnotation, DocumentBookmark, DocumentCalibration, DocumentKind, DocumentLocateResult, DocumentPayload, WorkspaceExportResult, WorkspaceManifest, WorkspaceTab } from '../lib/documents';
import type { Message, MessageKey, MessageParam, ParseIssue } from '../lib/i18n';
import { assertStorable, migrateNotes, noteKeyIndex, unresolvedNotes } from '../lib/note-keys';
import type { NoteSubject } from '../lib/note-keys';
import type { CreatePdfSessionOptions, PdfSession, PdfSessionSnapshot } from '../lib/pdf/session-contract';
import { pinKey, symbolKey } from '../lib/schematic/model';
import type { SchSheetInstance, SchematicDesign } from '../lib/schematic/model';
import type { SchematicWorkerResponse } from '../lib/schematic/schematic-worker';
import type { Board, BoardNote, FilePayload, FormatFailure, ImportOptions, RecentFile, TraceDesktop } from '../lib/types';
import {
  WorkspaceError, acceptChangedDocument, addDocument, applyLocateResults, boardIdentityKey, createManifest, createWorkspaceSaver,
  noteFor, reconcileManifest, relinkDocument, removeAlias, removeAnnotation, removeBookmark, removeDocument, removeNote as dropNote, setActiveTab, setAlias, setCalibration, setCamera, setPageCount,
  setSplit, touch, upsertAnnotation, upsertBookmark, upsertNote, validateNotes,
} from '../lib/workspace';
import type { DocumentChange, SaverState, WorkspaceSaver } from '../lib/workspace';
import type {
  BoardSelectionState, DocumentOverlay, DocumentRuntime, DocumentStatus, ImportProgress, ImportState, Notice, NoticeKind, ProbeState, SaveState, SearchState, SelectionOrigin, WorkspaceActions,
  WorkspaceApi, WorkspaceState,
} from './api';
import { createModelClient } from './model-client';
import type { ModelClient } from './model-client';
import { errorText, FormatFailureError, isAbortError, isClosingError, nativeCode, nativeFailure, UiError } from './errors';
import { validateKeyText } from './keys';
import type { KeyKind } from './keys';
import {
  buildOverlay, documentRefOf, EMPTY_PROBE, EMPTY_SELECTION, mapBoardToSchematic, mapSchematicNet, mapSchematicToBoard, mappingOfLink, MAX_PDF_SCAN_HITS, pdfScanTargets, probeRegionsOf,
  sameView, selectionOfBoardTarget, uniqueComponentByRef, viewOfNetTarget, viewOfTarget,
} from './probe';
import type { ProbeInputs, SchematicView } from './probe';
import { sniffDocument } from './sniff';
import { createStatusStore } from './statusStore';

/**
 * The application core behind `WorkspaceApi` (src/app/api.ts): plain TypeScript, no React, no DOM; every effect goes through
 * `ControllerDeps`, so the whole thing runs in node with fakes. State is replaced, never mutated, and only the slices that
 * changed get a new identity; several patches of one action reach subscribers as one notification.
 *
 * Generations: every board switch bumps `generation`. Anything asynchronous (document reads, workers, PDF scans, notes, saves)
 * captures the generation (or the board key) when it starts and drops its result when it no longer matches, so nothing of an old
 * board can attach to, overwrite or notify a new one. Imports use a second token (`sequence`): the latest request wins.
 */
// i18n: pending — every `{ text }` message below is an English constant; the catalogs are frozen this phase.

/** Primary file plus every companion together, the same bound the native process enforces. */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
/** Browser fallback mirrors the native bounds of one attach call (electron/documents.cjs). */
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_ATTACH_FILES = 16;
const MAX_ATTACH_BYTES = 256 * 1024 * 1024;
const MAX_NOTICES = 6;
const LOAD_CONCURRENCY = 2;
const NOTES_PREFIX = 'trace-notes-';

export interface WorkerPort { post(message: unknown, transfer?: Transferable[]): void; terminate(): void }
/** Creates a worker whose replies and crashes are delivered to the callbacks (a real Worker, or a fake in tests). */
export type WorkerFactory = (onMessage: (data: unknown) => void, onError: () => void) => WorkerPort;
export interface KeyValueStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
/** Timer functions of the import watchdog (tests pass fakes). */
export interface ControllerTimers { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
/**
 * Import watchdog: a parse that reports no progress for `stallMs` turns the progress state to `stalled` (the UI says so and keeps
 * Cancel available); one that reports none for `stopMs` is stopped (its worker is terminated) with a notice. Every progress report
 * of the parser restarts both clocks.
 */
export interface ParseWatchdog { stallMs: number; stopMs: number }
export const DEFAULT_PARSE_WATCHDOG: Readonly<ParseWatchdog> = Object.freeze({ stallMs: 30_000, stopMs: 120_000 });
const DEFAULT_TIMERS: ControllerTimers = {
  setTimeout: (run, ms) => { const handle = setTimeout(run, ms); (handle as { unref?: () => void }).unref?.(); return handle; },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export interface ControllerDeps {
  /** Undefined in the browser fallback (no persistence, files come from `pickFiles`). */
  desktop?: TraceDesktop;
  createBoardWorker: WorkerFactory;
  createSchematicWorker: WorkerFactory;
  createPdfSession(options: CreatePdfSessionOptions): PdfSession;
  now?: () => number;
  newId?: () => string;
  /** Browser notes storage (localStorage); null/undefined when unavailable. */
  storage?: KeyValueStorage | null;
  /** Browser fallback: opens a file chooser (called from a user gesture). */
  pickFiles?(options: { multiple: boolean }): Promise<File[]>;
  /** Quiet period of the workspace saver (default 400 ms). */
  saveDelayMs?: number;
  /** Import watchdog thresholds (default DEFAULT_PARSE_WATCHDOG). */
  parseWatchdog?: Partial<ParseWatchdog>;
  timers?: ControllerTimers;
}
export interface WorkspaceController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): WorkspaceState;
  readonly actions: WorkspaceActions;
  readonly sheetsOf: WorkspaceApi['sheetsOf'];
  readonly statusStore: WorkspaceApi['statusStore'];
  /** Startup (recents, initial board, external opens). Returns the function that detaches them; safe to call again (StrictMode). */
  start(): () => void;
  /** Writes the pending workspace snapshot (pagehide, tests). Never rejects: failures show up in `state.save`. */
  flush(): Promise<void>;
  /** Resolves when no asynchronous work started by the controller is in flight (tests, shutdown). */
  idle(): Promise<void>;
}

type ImportOutcome = 'loaded' | 'failed' | 'key-required';
type AttachOutcome = 'added' | 'duplicate' | 'restored' | 'failed';
type ParserReply = { board?: Board; model?: number; progress?: { fraction?: unknown }; reportContext?: { stage?: unknown; formatId?: unknown }; issue?: ParseIssue; formatError?: FormatFailure; error?: string };
/** A parsed board and, when the worker speaks the model protocol, the client of the worker that now serves this board. */
interface Parsed { board: Board; model: ModelClient | null; formatId: string | null }

type SafeImportContext = NonNullable<NonNullable<WorkspaceState['import']['reportContext']>>;
type ContextOutcome = SafeImportContext['outcome'];
type ContextStage = SafeImportContext['stage'];
const CONTEXT_STAGES: readonly ContextStage[] = ['read', 'detect', 'unpack', 'parse', 'done', 'unknown'];
const CONTEXT_CODES = [...ERROR_CODES, 'READ_FAILED', 'WORKER_FAILED', 'TIMEOUT', 'CANCELLED', 'UNKNOWN'] as const;
function extensionClassOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 && !(dot === 0 && base.length > 1)) return 'none';
  const extension = base.slice(dot).toLowerCase();
  return /^\.[a-z0-9_]{1,10}$/.test(extension) && EXTENSIONS.has(extension) ? extension : 'other';
}
function safeFormatId(value: unknown): string | null {
  return typeof value === 'string' && (FORMAT_IDS as readonly string[]).includes(value) ? value : null;
}
function safeErrorCode(value: unknown): string | null {
  return typeof value === 'string' && (CONTEXT_CODES as readonly string[]).includes(value) ? value : null;
}
function safeStage(value: unknown): ContextStage { return CONTEXT_STAGES.includes(value as ContextStage) ? value as ContextStage : 'unknown'; }
function importContext(name: string, outcome: ContextOutcome, stage: ContextStage, formatId: unknown = null, errorCode: unknown = null): SafeImportContext {
  return { outcome, stage, formatId: safeFormatId(formatId), extensionClass: extensionClassOf(name), errorCode: safeErrorCode(errorCode) };
}
class ImportContextError extends UiError {
  constructor(readonly outcome: 'timeout' | 'worker-failed', readonly code: 'TIMEOUT' | 'WORKER_FAILED', message: Message) { super(message); }
}

interface Entry {
  version: number;
  status: DocumentStatus;
  message?: string;
  pdf?: PdfSession;
  bytes?: Uint8Array;
  design?: SchematicDesign;
  designState?: DocumentRuntime['designState'];
  designError?: DocumentRuntime['designError'];
  /** Latest load request; an older read that returns later is ignored. */
  loadToken: number;
  change?: DocumentChange;
  unsubscribe?: () => void;
  worker?: WorkerPort;
  requestId?: number;
  finishRequest?: () => void;
  pageRecorded?: boolean;
  linkStarted?: boolean;
  linkAbort?: AbortController;
  readyNoticed?: boolean;
  /** `snapshot.ocr.revision` the current cross-reference and search results were made with. */
  ocrRevision?: number;
}

/**
 * Row status implied by a PDF session (I06 / W-win-viewers-04): `ready` has to mean that pdf.js really opened the file. While it
 * opens the row is `loading`; a file pdf.js rejects is `error` (with the session's own message, the existing error state), no longer a
 * green chip next to an error panel. A password prompt stays `ready`: that interactive state belongs to the viewer (api.ts: the session
 * is present while it asks for one). `null` (a closed session) leaves the status as it is.
 */
function pdfStatusOf(snapshot: PdfSessionSnapshot): { status: DocumentStatus; message: string | undefined } | null {
  switch (snapshot.status) {
    case 'opening': return { status: 'loading', message: undefined };
    case 'ready': case 'password-required': case 'invalid-password': return { status: 'ready', message: undefined };
    case 'error': return { status: 'error', message: snapshot.error?.message };
    default: return null;
  }
}

const NO_DOCUMENTS: DocumentRuntime[] = [];
const NO_NOTES: BoardNote[] = [];
const NO_NOTICES: Notice[] = [];
const NO_RECENTS: RecentFile[] = [];
const NO_SHEETS: SchSheetInstance[] = [];
const NO_LINKS: WorkspaceState['pdfLinks'] = Object.freeze({});
const NO_OVERLAYS: WorkspaceState['overlays'] = Object.freeze({});
const DEFAULT_SPLIT: WorkspaceState['split'] = Object.freeze({ enabled: false, ratio: 0.5, right: null });
const IDLE_SAVE: SaveState = Object.freeze({ dirty: false, saving: false, failure: null });
const EMPTY_SEARCH: SearchState = Object.freeze({ query: '', result: null, pending: false });
const EMPTY_CAMERA: ViewerCamera = Object.freeze({});
/** The board camera also carries the viewed side (DocumentCamera.side); ViewerCamera is the document-viewer contract and does not name it. */
type BoardCamera = ViewerCamera & { side?: 'top' | 'bottom' };
const NO_HIGHLIGHTS: readonly ViewerHighlight[] = Object.freeze([]);

const say = (key: MessageKey, params?: Readonly<Record<string, MessageParam>>): Message => (params ? { key, params } : { key });
const text = (value: string): Message => ({ text: value });
const baseName = (name: string) => name.split(/[\\/]/).pop() || name;
const hex = (digest: ArrayBuffer) => Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (data: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
const bufferOf = (bytes: Uint8Array) => bytes.buffer as ArrayBuffer;
const workspaceMessage = (error: unknown): Message => (error instanceof WorkspaceError ? text(error.message) : nativeFailure(error, text('The change could not be applied.')));
const sameSelection = (a: BoardSelectionState, b: BoardSelectionState) => a.componentId === b.componentId && a.pinId === b.pinId && a.net === b.net;

export function createWorkspaceController(deps: ControllerDeps): WorkspaceController {
  return new Controller(deps).api();
}

class Controller {
  private readonly desktop: TraceDesktop | undefined;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly statusStore = createStatusStore();
  private readonly listeners = new Set<() => void>();
  private state: WorkspaceState;

  // --- import ---
  private sequence = 0;
  private parser: { cancel(): void } | null = null;
  private readonly timers: ControllerTimers;
  private readonly watchdog: ParseWatchdog;
  private sessionOptions: ImportOptions = {};
  private waitingKey: { payload: FilePayload; kind: KeyKind } | null = null;

  // --- board-scoped resources (everything below is dropped on a board switch) ---
  private generation = 0;
  /** The shared index of the open board (boardIndexOf), also published as `state.boardIndex`. */
  private boardIndex: BoardIndex | null = null;
  /** The model worker of the open board; null in the synchronous fallback (a worker that does not speak the model protocol, tests). */
  private model: ModelClient | null = null;
  private linkRun = 0;
  private linkAbort: AbortController | null = null;
  private schIndex: SchematicIndex | null = null;
  private sources: SchematicSource[] = [];
  private linkKey: { board: BoardIndex | null; schematic: SchematicIndex | null; aliases: unknown } | null = null;
  private ws: WorkspaceManifest | null = null;
  private saver: WorkspaceSaver<WorkspaceManifest> | null = null;
  private saveBlocked = false;
  private saveFailureNotified = false;
  private flushing: Promise<void> = Promise.resolve();
  private readonly entries = new Map<string, Entry>();
  private readonly runtimeCache = new Map<string, { record: unknown; version: number; runtime: DocumentRuntime }>();
  private readonly views = new Map<string, string>();
  private readonly overlayStates = new Map<string, DocumentOverlay['state']>();
  private readonly docHighlights = new Map<string, ViewerHighlight[]>();
  private loadQueue: Array<{ generation: number; id: string }> = [];
  private loading = 0;
  private schematicRequests = 0;
  private schematicDriven = false;
  private boardChoiceOrigin: SelectionOrigin = 'schematic';
  private searchRun = 0;
  private searchAbort: AbortController | null = null;
  private searchText = '';
  private noticeId = 0;
  private noteChain: Promise<void> = Promise.resolve();
  private scanChain: Promise<void> = Promise.resolve();

  // --- async bookkeeping for idle() ---
  private pending = 0;
  private idleWaiters: Array<() => void> = [];

  readonly actions: WorkspaceActions;

  constructor(private readonly deps: ControllerDeps) {
    this.desktop = deps.desktop;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.timers = deps.timers ?? DEFAULT_TIMERS;
    this.watchdog = { ...DEFAULT_PARSE_WATCHDOG, ...deps.parseWatchdog };
    this.state = {
      board: null, boardIndex: null, boardKey: null, boardPath: '', manifest: null, activeTab: 'board', split: DEFAULT_SPLIT, documents: NO_DOCUMENTS, notes: NO_NOTES, notesBlocked: null,
      save: IDLE_SAVE, selection: EMPTY_SELECTION, probe: EMPTY_PROBE, search: EMPTY_SEARCH, link: null, pdfLinks: NO_LINKS, overlays: NO_OVERLAYS, notices: NO_NOTICES,
      persistence: this.desktop ? 'native' : 'session-only', import: { phase: 'idle', keyRequest: null, recents: NO_RECENTS, file: null, progress: null, reportContext: null },
    };
    this.actions = this.createActions();
  }

  api(): WorkspaceController {
    return {
      subscribe: listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
      getSnapshot: () => this.state,
      actions: this.actions,
      sheetsOf: documentId => this.entries.get(documentId)?.design?.schematic.instances ?? NO_SHEETS,
      statusStore: this.statusStore,
      start: () => this.start(),
      flush: () => this.track(this.flushActive()),
      idle: () => (this.pending === 0 ? Promise.resolve() : new Promise<void>(resolve => { this.idleWaiters.push(resolve); })),
    };
  }

  // =============================================================================================================
  // Infrastructure: state patching, notices, async tracking
  // =============================================================================================================

  /** Several patches of one action reach subscribers as ONE notification (the last state), never as intermediate states. */
  private batchDepth = 0;
  private dirty = false;
  private emit(): void {
    if (this.batchDepth > 0) { this.dirty = true; return; }
    for (const listener of [...this.listeners]) listener();
  }
  private batch<T>(run: () => T): T {
    this.batchDepth++;
    try { return run(); }
    finally {
      if (--this.batchDepth === 0 && this.dirty) { this.dirty = false; this.emit(); }
    }
  }

  private patch(changes: Partial<WorkspaceState>): void {
    let next: WorkspaceState | null = null;
    for (const key of Object.keys(changes) as Array<keyof WorkspaceState>) {
      if (Object.is(changes[key], this.state[key])) continue;
      next ??= { ...this.state };
      (next as unknown as Record<string, unknown>)[key] = changes[key];
    }
    if (!next) return;
    this.state = next;
    this.emit();
  }
  private patchImport(changes: Partial<ImportState>): void {
    const current = this.state.import;
    if ((Object.keys(changes) as Array<keyof ImportState>).every(key => Object.is(changes[key], current[key]))) return;
    this.patch({ import: { ...current, ...changes } });
  }
  private setReportContext(token: number, context: SafeImportContext | null): void {
    if (token !== this.sequence) return;
    this.patchImport({ reportContext: context });
  }
  private setProbe(changes: Partial<ProbeState>): void {
    const current = this.state.probe;
    if ((Object.keys(changes) as Array<keyof ProbeState>).every(key => Object.is(changes[key], current[key]))) return;
    this.patch({ probe: { ...current, ...changes } });
  }
  /** A native failure as an error notice, except `*_CLOSING` (the application is quitting): then nothing is reported. */
  private notifyFailure(error: unknown, fallback: Message): void {
    if (!isClosingError(error)) this.notify(nativeFailure(error, fallback), 'error');
  }
  private notify(message: Message, kind: NoticeKind = 'info'): void {
    this.patch({ notices: [...this.state.notices, { id: ++this.noticeId, kind, message }].slice(-MAX_NOTICES) });
  }
  private iso = () => new Date(this.now()).toISOString();

  private begin(): () => void {
    this.pending++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.pending === 0) for (const resolve of this.idleWaiters.splice(0)) resolve();
    };
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    const end = this.begin();
    return promise.finally(end);
  }

  // =============================================================================================================
  // Board import (extracted from App.tsx: sequence tokens, one worker per import, keys, recents, startup)
  // =============================================================================================================

  private beginImport(): number {
    const token = ++this.sequence;
    this.parser?.cancel();
    this.parser = null;
    this.waitingKey = null;
    this.patchImport({ phase: 'idle', keyRequest: null, progress: null, reportContext: null });
    return token;
  }

  /** The model worker of the open board while it runs; null means: answer on this thread from the shared index. */
  private get liveModel(): ModelClient | null { return this.model?.alive ? this.model : null; }

  /**
   * One worker per import. Its progress reports (`{ progress: { fraction } }`) update `import.progress` and restart the watchdog; a
   * watchdog stop or a cancel terminates the worker. A worker that answers `{ board, model: MODEL_PROTOCOL }` is not terminated: it
   * becomes the model worker of the board, and its later messages go to the model client returned with the board.
   */
  private parse(payload: FilePayload, token: number): Promise<Parsed> {
    return new Promise<Parsed>((resolve, reject) => {
      let port: WorkerPort | null = null;
      let handover: { receive(data: unknown): void; fail(): void } | null = null;
      let stall: unknown = null, stop: unknown = null;
      const disarm = () => {
        if (stall !== null) this.timers.clearTimeout(stall);
        if (stop !== null) this.timers.clearTimeout(stop);
        stall = stop = null;
      };
      const handle = { cancel: () => { release(); reject(new DOMException('Import cancelled.', 'AbortError')); } };
      const release = () => { disarm(); if (port) { port.terminate(); port = null; } if (this.parser === handle) this.parser = null; };
      const arm = () => {
        disarm();
        stall = this.timers.setTimeout(() => {
          stall = null;
          const progress = this.state.import.progress;
          if (token === this.sequence && this.parser === handle) this.patchImport({ progress: { fraction: progress?.fraction ?? null, stalled: true } });
        }, this.watchdog.stallMs);
        stop = this.timers.setTimeout(() => {
          stop = null;
          if (this.parser !== handle) return;
          const current = this.state.import.reportContext;
          if (current && token === this.sequence) this.setReportContext(token, { ...current, outcome: 'timeout', errorCode: 'TIMEOUT' });
          release();
          reject(new ImportContextError('timeout', 'TIMEOUT', say('toast.importStopped', { seconds: Math.round(this.watchdog.stopMs / 1000) })));
        }, this.watchdog.stopMs);
      };
      const onReply = (data: unknown) => {
        const reply = data as ParserReply;
        const context = reply.reportContext;
        if (context && CONTEXT_STAGES.includes(context.stage as ContextStage) && token === this.sequence && this.parser === handle) {
          const current = this.state.import.reportContext;
          if (current) this.setReportContext(token, { ...current, outcome: 'processing', stage: safeStage(context.stage) });
        }
        if (reply.reportContext && !reply.progress && !reply.board && !reply.issue && !reply.formatError && !reply.error) return;
        if (reply.progress) {
          const fraction = typeof reply.progress.fraction === 'number' && Number.isFinite(reply.progress.fraction) ? Math.min(1, Math.max(0, reply.progress.fraction)) : null;
          if (token === this.sequence && this.parser === handle) { this.patchImport({ progress: { fraction, stalled: false } satisfies ImportProgress }); arm(); }
          return;
        }
        if (reply.board && reply.model === MODEL_PROTOCOL && port) {
          // The worker keeps the board and answers model requests from now on: hand it over instead of terminating it.
          const kept: WorkerPort = port;
          port = null;
          release();
          const client = createModelClient(kept);
          handover = client;
          resolve({ board: reply.board, model: client, formatId: safeFormatId(context?.formatId) });
          return;
        }
        release();
        if (reply.board) resolve({ board: reply.board, model: null, formatId: safeFormatId(context?.formatId) });
        else if (reply.issue) reject(new UiError({ issue: reply.issue }));
        else if (reply.formatError) reject(new FormatFailureError(reply.formatError));
        else { if (reply.error) console.error('TRACE: unexpected parser failure:', reply.error); reject(new UiError(say('toast.parseFailed'))); }
      };
      try {
        port = this.deps.createBoardWorker(data => { if (handover) handover.receive(data); else onReply(data); }, () => {
          if (handover) { handover.fail(); return; }
          const current = this.state.import.reportContext;
          if (current && token === this.sequence) this.setReportContext(token, { ...current, outcome: 'worker-failed', errorCode: 'WORKER_FAILED' });
          release(); reject(new ImportContextError('worker-failed', 'WORKER_FAILED', say('toast.workerCrashed')));
        });
        this.parser = handle;
        // Exactly sized copies are transferred (the payload keeps its bytes for a retry with a key).
        const data = new Uint8Array(payload.data);
        const companions = payload.companions && Object.fromEntries(Object.entries(payload.companions).map(([name, bytes]) => [name, new Uint8Array(bytes)]));
        const transfer = [bufferOf(data), ...Object.values(companions ?? {}).map(bytes => bufferOf(bytes))];
        port.post({ name: payload.name, data, companions, options: this.sessionOptions }, transfer);
        if (port) arm(); // a worker that already answered (or failed) has released the import
      } catch (error) {
        release();
        reject(error instanceof UiError ? error : new UiError(say('toast.workerCrashed')));
      }
    });
  }

  /** Drops the remembered key of one kind (session-only keys never persist anywhere else). */
  private forgetKey(kind: KeyKind): void {
    const options = { ...this.sessionOptions };
    delete options[kind === 'fz' ? 'fzKey' : 'xzzKey'];
    this.sessionOptions = options;
  }

  private async loadPayload(payload: FilePayload, token: number): Promise<ImportOutcome> {
    if (token !== this.sequence) return 'failed';
    this.patchImport({ phase: 'processing', progress: { fraction: null, stalled: false } });
    this.setReportContext(token, importContext(payload.name, 'processing', 'detect'));
    // The model worker of the parsed board until the board is committed (or dropped, when a newer request won meanwhile).
    let model: ModelClient | null = null;
    try {
      const result = await this.parse(payload, token);
      const parsed = result.board;
      model = result.model;
      this.setReportContext(token, importContext(payload.name, 'processing', 'done', result.formatId));
      if (token !== this.sequence) return 'failed';
      // The previous board's workspace is written before its state is replaced (and before a re-open of the same board reads it).
      await this.flushActive();
      if (token !== this.sequence) return 'failed';
      let saved: BoardNote[] = [];
      let notesError: Message | null = null;
      let quitting = false;
      let notesUnsaved: unknown = null;
      try { ({ notes: saved, unsaved: notesUnsaved } = await this.loadNotes(payload.key, parsed)); }
      catch (error) { notesError = nativeFailure(error, say('toast.notesReadFailed')); quitting = isClosingError(error); }
      if (token !== this.sequence) return 'failed';
      this.commitBoard(payload, parsed, saved, notesError, model);
      model = null;
      this.setReportContext(token, importContext(payload.name, 'opened', 'done', result.formatId));
      if (notesError) { if (!quitting) this.notify(say('toast.loadedNotesLocked'), 'error'); }
      else {
        this.notify(say('toast.loaded', { components: say('unit.components', { count: parsed.components.length }), pins: say('unit.pins', { count: parsed.pins.length }) }), 'success');
        if (notesUnsaved && !isClosingError(notesUnsaved)) this.notify(say('toast.notesUpdateFailed'), 'error');
        if (unresolvedNotes(parsed, saved).length) this.notify(say('toast.notesUnresolved'), 'error');
      }
      const desktop = this.desktop;
      if (desktop) {
        void this.track(desktop.acceptBoard(payload.path, payload.key).then(() => desktop.recentBoards()).then(recents => {
          if (token === this.sequence) this.patchImport({ recents });
        }).catch(error => { if (token === this.sequence) this.notifyFailure(error, say('toast.recentSaveFailed')); }));
      }
      return 'loaded';
    } catch (error) {
      if (token !== this.sequence) return 'failed';
      if (error instanceof FormatFailureError && (error.failure.code === 'KEY_REQUIRED' || error.failure.code === 'INVALID_KEY') && error.failure.keyKind) {
        // A key the parser rejected is no longer the session key: left in `sessionOptions` it would be applied silently to the next, unrelated
        // encrypted file, which would then fail with INVALID_KEY instead of asking (W-win-import-02). A retry in the open dialog stores the new key.
        if (error.failure.code === 'INVALID_KEY') this.forgetKey(error.failure.keyKind);
        // The previous board stays on screen; a newer import (beginImport) dismisses this request.
        this.waitingKey = { payload, kind: error.failure.keyKind };
        this.patchImport({ keyRequest: { fileName: payload.name, kind: error.failure.keyKind, code: error.failure.code, message: error.failure.message } });
        this.setReportContext(token, importContext(payload.name, 'key-required', this.state.import.reportContext?.stage ?? 'unknown', null, error.failure.code));
        return 'key-required';
      }
      if (error instanceof ImportContextError) this.setReportContext(token, importContext(payload.name, error.outcome, this.state.import.reportContext?.stage ?? 'unknown', null, error.code));
      else this.setReportContext(token, importContext(payload.name, 'failed', this.state.import.reportContext?.stage ?? 'unknown', null,
        error instanceof FormatFailureError ? error.failure.code : 'UNKNOWN'));
      this.notifyFailure(error, say('toast.openFailed'));
      return 'failed';
    } finally {
      model?.dispose();
      if (token === this.sequence) this.patchImport({ phase: 'idle', progress: null });
    }
  }

  /** `token` comes from the caller when the intent was declared earlier (the chooser); a dropped selection takes its own. */
  private async readBrowserFiles(list: File[], token = this.beginImport()): Promise<void> {
    const primary = list.find(value => companionNames(value.name).length > 0) ?? list[0];
    if (!primary) return;
    this.setReportContext(token, importContext(primary.name, 'reading', 'read'));
    const wanted = new Set(companionNames(primary.name));
    const siblings = list.filter(value => value !== primary && wanted.has(value.name.toLowerCase()));
    if (primary.size + siblings.reduce((sum, value) => sum + value.size, 0) > MAX_IMPORT_BYTES) {
      this.setReportContext(token, importContext(primary.name, 'failed', 'read', null, 'LIMIT_EXCEEDED'));
      this.notify(say('toast.fileTooLarge', { max: 64 }), 'error'); return;
    }
    this.patchImport({ phase: 'reading' });
    try {
      const data = new Uint8Array(await primary.arrayBuffer());
      const companions: Record<string, Uint8Array> = {};
      let total = data.byteLength;
      for (const sibling of siblings) {
        const name = sibling.name.toLowerCase();
        if (name in companions) continue;
        companions[name] = new Uint8Array(await sibling.arrayBuffer());
        total += companions[name].byteLength;
      }
      if (token !== this.sequence) return;
      if (total > MAX_IMPORT_BYTES) { this.patchImport({ phase: 'idle' }); this.setReportContext(token, importContext(primary.name, 'failed', 'read', null, 'LIMIT_EXCEEDED')); this.notify(say('toast.fileTooLarge', { max: 64 }), 'error'); return; }
      const withCompanions = Object.keys(companions).length > 0;
      const key = await boardIdentityKey([{ name: primary.name, data }, ...(withCompanions ? Object.entries(companions).map(([name, bytes]) => ({ name, data: bytes })) : [])]);
      if (token !== this.sequence) return;
      await this.loadPayload({ name: primary.name, path: '', data, ...(withCompanions ? { companions } : {}), key }, token);
    } catch {
      if (token === this.sequence) { this.patchImport({ phase: 'idle' }); this.setReportContext(token, importContext(primary.name, 'failed', 'read', null, 'READ_FAILED')); this.notify(say('toast.readFailed'), 'error'); }
    }
  }

  private start(): () => void {
    const desktop = this.desktop;
    let active = true;
    const token = this.beginImport();
    const unopen = desktop?.onOpenBoard(payload => { void this.track(this.loadPayload(payload, this.beginImport())); });
    if (desktop) {
      void this.track(desktop.recentBoards().then(recents => { if (active && token === this.sequence) this.patchImport({ recents }); }).catch(() => {}));
      void this.track(desktop.initialBoard().then(async payload => {
        if (!active || !payload || token !== this.sequence) return;
        const outcome = await this.loadPayload(payload, token);
        // A key request counts as handled: the user decides, the other recents are not tried behind the dialog.
        if (outcome !== 'failed' || payload.startupSource !== 'recent' || !active || token !== this.sequence) return;
        const alternatives = await desktop.recentBoards();
        const attempted = new Set([payload.path.toLowerCase()]);
        for (const recent of alternatives) {
          if (!active || token !== this.sequence) return;
          const canonical = recent.path.toLowerCase();
          if (attempted.has(canonical)) continue;
          attempted.add(canonical);
          try {
            const candidate = await desktop.readBoard(recent.path);
            if (!active || token !== this.sequence) return;
            if (await this.loadPayload(candidate, token) !== 'failed') return;
          } catch {
            if (active && token === this.sequence) this.setReportContext(token, importContext(recent.path, 'failed', 'read', null, 'READ_FAILED'));
            /* A missing legacy recent must not prevent trying the next one. */
          }
        }
      }).catch(error => {
        if (active && token === this.sequence) {
          this.setReportContext(token, importContext('', 'failed', 'read', null, 'READ_FAILED'));
          this.notifyFailure(error, say('toast.startupFailed'));
        }
      }));
    }
    return () => {
      active = false;
      unopen?.();
      this.sequence++;
      this.parser?.cancel();
      this.parser = null;
    };
  }

  // =============================================================================================================
  // Board switch: retire the old board's resources, commit the new one, open its workspace
  // =============================================================================================================

  /** Detaches everything that belongs to the current board. The saver is flushed first (and chained, so a re-open waits for it). */
  private retireBoard(): void {
    const saver = this.saver;
    this.saver = null;
    if (saver) {
      this.flushing = this.flushing.then(() => saver.flush()).catch(() => {}).finally(() => saver.dispose());
      void this.track(this.flushing);
    }
    this.saveBlocked = false;
    this.saveFailureNotified = false;
    this.model?.dispose();
    this.model = null;
    this.linkRun++;
    this.linkAbort?.abort();
    this.linkAbort = null;
    this.searchAbort?.abort();
    this.searchAbort = null;
    this.searchRun++;
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.runtimeCache.clear();
    this.views.clear();
    this.overlayStates.clear();
    this.docHighlights.clear();
    this.loadQueue = [];
    this.scanChain = Promise.resolve();
    this.sources = [];
    this.linkKey = null;
    this.ws = null;
    this.schematicDriven = false;
  }

  private commitBoard(payload: FilePayload, board: Board, notes: BoardNote[], notesError: Message | null, model: ModelClient | null): void {
    this.batch(() => this.commitBoardNow(payload, board, notes, notesError, model));
  }
  private commitBoardNow(payload: FilePayload, board: Board, notes: BoardNote[], notesError: Message | null, model: ModelClient | null): void {
    this.retireBoard();
    this.generation++;
    this.noteChain = Promise.resolve();
    // One shared index per board (core only here; its cross-probe layer is built when a schematic or PDF first needs it).
    this.boardIndex = boardIndexOf(board);
    this.model = model;
    this.schIndex = null;
    this.waitingKey = null;
    this.patch({
      board, boardIndex: this.boardIndex, boardKey: payload.key, boardPath: payload.path, manifest: null, activeTab: 'board', split: DEFAULT_SPLIT, documents: NO_DOCUMENTS, notes: notes.length ? notes : NO_NOTES,
      notesBlocked: notesError, save: IDLE_SAVE, selection: EMPTY_SELECTION, probe: EMPTY_PROBE, search: EMPTY_SEARCH, link: null, pdfLinks: NO_LINKS, overlays: NO_OVERLAYS,
      persistence: this.desktop ? 'native' : 'session-only',
      import: { ...this.state.import, phase: 'idle', keyRequest: null, progress: null, file: { name: payload.name, path: payload.path, key: payload.key } },
    });
    this.searchText = '';
    this.statusStore.setSource(`${board.format} · ${board.units}`);
    const generation = this.generation;
    void this.track(this.openWorkspace(generation, payload, board).catch(error => {
      if (generation === this.generation && !isClosingError(error)) this.notify(workspaceMessage(error), 'error');
    }));
  }

  private closeBoard(): void {
    this.batch(() => this.closeBoardNow());
  }
  private closeBoardNow(): void {
    this.beginImport();
    this.retireBoard();
    this.generation++;
    this.noteChain = Promise.resolve();
    this.boardIndex = null;
    this.schIndex = null;
    this.searchText = '';
    this.patch({
      board: null, boardIndex: null, boardKey: null, boardPath: '', manifest: null, activeTab: 'board', split: DEFAULT_SPLIT, documents: NO_DOCUMENTS, notes: NO_NOTES, notesBlocked: null, save: IDLE_SAVE,
      selection: EMPTY_SELECTION, probe: EMPTY_PROBE, search: EMPTY_SEARCH, link: null, pdfLinks: NO_LINKS, overlays: NO_OVERLAYS,
      import: { ...this.state.import, phase: 'idle', keyRequest: null, progress: null, file: null },
    });
    this.statusStore.setSource('');
  }

  // =============================================================================================================
  // Workspace lifecycle (native: persisted manifest; browser: in memory only)
  // =============================================================================================================

  private get native(): boolean { return this.desktop !== undefined; }

  private async openWorkspace(generation: number, payload: FilePayload, board: Board): Promise<void> {
    const identity = { key: payload.key, name: baseName(payload.name) || 'board', path: payload.path || `/${baseName(payload.name) || 'board'}`, format: board.format || 'board' };
    const desktop = this.desktop;
    if (!desktop) {
      this.ws = createManifest(identity, this.iso());
      this.syncManifest();
      return;
    }
    await this.flushing;
    if (generation !== this.generation) return;
    let manifest: WorkspaceManifest | null = null;
    let blocked: string | null = null;
    try {
      const stored = await desktop.loadWorkspace(payload.key);
      if (stored) manifest = reconcileManifest({ ...stored, board: { ...stored.board, name: identity.name, path: identity.path, format: identity.format } });
    } catch (error) {
      if (isClosingError(error)) return;
      blocked = errorText(error, 'The saved workspace of this board cannot be read.');
    }
    if (generation !== this.generation) return;
    if (blocked === null && manifest === null) {
      try { manifest = createManifest(identity, this.iso()); }
      catch (error) { blocked = errorText(error, 'A workspace cannot be created for this board.'); }
    }
    if (manifest === null) {
      // The stored file is left untouched: nothing is saved over data that could not be read.
      this.saveBlocked = true;
      this.ws = createManifest({ ...identity, path: identity.path }, this.iso());
      this.patch({ save: { dirty: false, saving: false, failure: `The saved workspace cannot be read, so changes are not saved: ${blocked}` } });
      this.notify(text(`The saved workspace of this board cannot be read. Documents and layout changes will not be saved. ${blocked}`), 'error');
      this.syncManifest();
      return;
    }
    this.ws = manifest;
    this.createSaver(generation, payload.key);
    this.syncManifest();
    if (manifest.documents.length === 0) return;
    for (const record of manifest.documents) this.entries.set(record.id, this.newEntry('loading'));
    this.refreshDocuments();
    await this.locateDocuments(generation, payload.path);
  }

  private createSaver(generation: number, boardKey: string): void {
    const desktop = this.desktop!;
    const saver: WorkspaceSaver<WorkspaceManifest> = createWorkspaceSaver<WorkspaceManifest>({
      save: manifest => desktop.saveWorkspace(boardKey, manifest),
      delayMs: this.deps.saveDelayMs ?? 400,
      onStateChange: (saverState: SaverState) => {
        if (this.saver !== saver || generation !== this.generation) return;
        const failure = saverState.failure && !isClosingError(saverState.failure.error) ? errorText(saverState.failure.error, 'The workspace could not be saved.') : null;
        const current = this.state.save;
        if (current.dirty !== saverState.dirty || current.saving !== saverState.saving || current.failure !== failure) this.patch({ save: { dirty: saverState.dirty, saving: saverState.saving, failure } });
        if (!failure) this.saveFailureNotified = false;
      },
      onError: failure => {
        if (this.saver !== saver || this.saveFailureNotified || isClosingError(failure.error)) return;
        this.saveFailureNotified = true;
        this.notify(text(`The workspace could not be saved: ${errorText(failure.error, 'unknown error')}${failure.willRetry ? ' Another attempt follows.' : ''}`), 'error');
      },
    });
    this.saver = saver;
  }

  private async locateDocuments(generation: number, boardPath: string): Promise<void> {
    const desktop = this.desktop!;
    const manifest = this.ws!;
    let results: DocumentLocateResult[];
    try {
      results = await desktop.locateDocuments(boardPath, manifest.documents.map(({ id, kind, path, relativePath, key }) => ({ id, kind, path, ...(relativePath ? { relativePath } : {}), key })));
    } catch (error) {
      if (generation !== this.generation || isClosingError(error)) return;
      const message = errorText(error, 'The documents could not be located.');
      for (const record of manifest.documents) this.setEntry(record.id, { status: 'unreadable', message: `The document could not be located: ${message}` });
      this.notifyFailure(error, text('The attached documents could not be located.'));
      return;
    }
    if (generation !== this.generation || !this.ws) return;
    const outcome = applyLocateResults(this.ws!, results);
    this.setManifest(outcome.manifest);
    const answered = new Set(results.map(result => result.id));
    for (const change of outcome.changed) {
      const entry = this.entries.get(change.id);
      if (!entry) continue;
      entry.change = change;
      this.setEntry(change.id, { status: 'changed', message: `The file at ${change.path} has different content than the one that was attached. Accept the changed file to use it, or relink the original.` });
    }
    const changed = new Set(outcome.changed.map(change => change.id));
    const missing = new Set(outcome.missing);
    const unreadable = new Set(outcome.unreadable);
    for (const record of this.ws!.documents) {
      if (changed.has(record.id)) continue;
      const result = results.find(candidate => candidate.id === record.id);
      if (missing.has(record.id)) this.setEntry(record.id, { status: 'missing', message: `The file was not found at its remembered location (${record.path}). Relink it to the same file, or remove it from the workspace.` });
      else if (unreadable.has(record.id) || !answered.has(record.id)) this.setEntry(record.id, { status: 'unreadable', message: `The file could not be read${result?.message ? `: ${result.message}` : '.'} Relink it, or remove it from the workspace.` });
      else this.enqueueLoad(generation, record.id);
    }
  }

  // --- lazy loading of located documents, at most LOAD_CONCURRENCY reads at a time ---

  private enqueueLoad(generation: number, id: string): void {
    this.loadQueue.push({ generation, id });
    this.pumpLoads();
  }
  private pumpLoads(): void {
    while (this.loading < LOAD_CONCURRENCY && this.loadQueue.length) {
      const job = this.loadQueue.shift()!;
      if (job.generation !== this.generation) continue;
      this.loading++;
      void this.track(this.loadDocument(job.generation, job.id).catch(() => {}).finally(() => { this.loading--; this.pumpLoads(); }));
    }
  }
  private async loadDocument(generation: number, id: string): Promise<void> {
    const desktop = this.desktop;
    const record = this.record(id);
    const entry = this.entries.get(id);
    if (!desktop || !record || !entry || generation !== this.generation) return;
    const token = ++entry.loadToken;
    const stale = () => generation !== this.generation || this.entries.get(id) !== entry || entry.loadToken !== token;
    let payload: DocumentPayload;
    try { payload = await desktop.readDocument(record.path, { kinds: [record.kind] }); }
    catch (error) {
      if (stale() || isClosingError(error)) return;
      const code = nativeCode(error);
      const detail = errorText(error, 'The file could not be read.');
      this.setEntry(id, code === 'DOCUMENT_NOT_FOUND'
        ? { status: 'missing', message: `The file was not found at its remembered location (${record.path}). Relink it to the same file, or remove it from the workspace.` }
        : { status: 'unreadable', message: `${detail} Relink it, or remove it from the workspace.` });
      return;
    }
    if (stale()) return;
    if (payload.key !== record.key) {
      entry.change = { id, name: record.name, path: payload.path, key: payload.key, size: payload.size, expectedKey: record.key };
      this.setEntry(id, { status: 'changed', message: `The file at ${payload.path} has different content than the one that was attached. Accept the changed file to use it, or relink the original.` });
      return;
    }
    this.installPayload(generation, id, payload);
  }

  // --- runtimes ---

  private newEntry(status: DocumentStatus): Entry { return { version: 0, status, loadToken: 0 }; }
  private record(id: string) { return this.ws?.documents.find(document => document.id === id); }

  private disposeEntry(entry: Entry): void {
    entry.unsubscribe?.();
    entry.linkAbort?.abort();
    entry.worker?.terminate();
    entry.finishRequest?.();
    if (entry.pdf) void this.track(entry.pdf.dispose().catch(() => {}));
    entry.unsubscribe = entry.worker = entry.pdf = entry.finishRequest = entry.linkAbort = undefined;
  }

  /** Replaces the runtime fields of an entry (status/message/handles) and republishes the document list. */
  private setEntry(id: string, change: Partial<Pick<Entry, 'status' | 'message' | 'design' | 'designState' | 'designError' | 'bytes'>>): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    Object.assign(entry, change);
    if (change.status !== undefined && change.message === undefined && !('message' in change)) entry.message = undefined;
    entry.version++;
    this.refreshDocuments();
  }

  /** The bytes of an attached document become its runtime. PDF bytes belong to the session afterwards; nothing else keeps them. */
  private installPayload(generation: number, id: string, payload: DocumentPayload): void {
    this.batch(() => this.installPayloadNow(generation, id, payload));
  }
  private installPayloadNow(generation: number, id: string, payload: DocumentPayload): void {
    if (generation !== this.generation) return;
    const record = this.record(id);
    if (!record) return;
    let entry = this.entries.get(id);
    if (entry) this.disposeEntry(entry); else { entry = this.newEntry('loading'); this.entries.set(id, entry); }
    entry.loadToken++;
    entry.change = undefined; entry.design = undefined; entry.designState = undefined; entry.designError = undefined; entry.bytes = undefined; entry.pageRecorded = false; entry.linkStarted = false; entry.readyNoticed = false; entry.ocrRevision = 0;
    this.overlayStates.delete(id);
    this.docHighlights.delete(id);
    if (record.kind === 'pdf') {
      const session = this.deps.createPdfSession({ id, data: payload.data });
      entry.pdf = session;
      entry.unsubscribe = session.subscribe(() => this.onPdfSnapshot(generation, id));
      this.setEntry(id, pdfStatusOf(session.getSnapshot()) ?? { status: 'loading', message: undefined });
      this.onPdfSnapshot(generation, id);
    } else if (record.kind === 'image') {
      this.setEntry(id, { status: 'ready', message: undefined, bytes: payload.data });
    } else {
      this.startSchematic(generation, id, payload);
    }
    this.refreshSchematicIndex();
    this.refreshOverlays();
    this.rerunSearch();
  }

  private startSchematic(generation: number, id: string, payload: DocumentPayload): void {
    const entry = this.entries.get(id)!;
    const requestId = ++this.schematicRequests;
    entry.requestId = requestId;
    entry.finishRequest?.();
    entry.finishRequest = this.begin();
    this.setEntry(id, { status: 'loading', message: undefined, designState: 'parsing', designError: undefined, design: undefined });
    try {
      entry.worker ??= this.deps.createSchematicWorker(data => this.onSchematicReply(generation, id, data as SchematicWorkerResponse), () => this.onSchematicFailure(generation, id, this.entries.get(id)?.requestId ?? -1, { code: 'UNKNOWN', message: 'The schematic processor stopped unexpectedly.' }));
      // Every request owns its transferable bytes: payloads (and the sibling files of one attach batch) are shared with other requests, relinks and the
      // caller, and a transferred buffer is detached on this side. The payload itself is never handed over.
      const data = payload.data.slice();
      const companions = payload.companions && Object.fromEntries(Object.entries(payload.companions).map(([name, bytes]) => [name, bytes.slice()]));
      entry.worker.post({ requestId, name: payload.name, data, ...(companions ? { companions } : {}) }, [bufferOf(data), ...Object.values(companions ?? {}).map(bufferOf)]);
    } catch (error) {
      this.onSchematicFailure(generation, id, requestId, { code: 'UNKNOWN', message: errorText(error, 'The schematic could not be processed.') });
    }
  }
  private onSchematicReply(generation: number, id: string, reply: SchematicWorkerResponse): void {
    const entry = this.entries.get(id);
    if (!entry || generation !== this.generation || reply.requestId !== entry.requestId) return;
    if ('design' in reply) {
      this.setEntry(id, { status: 'ready', message: undefined, design: reply.design, designState: 'ready', designError: undefined });
      entry.finishRequest?.();
      this.refreshSchematicIndex();
      return;
    }
    this.onSchematicFailure(generation, id, reply.requestId, reply.error);
  }
  private onSchematicFailure(generation: number, id: string, requestId: number, failure: { code: string; message: string }): void {
    const entry = this.entries.get(id);
    if (!entry || generation !== this.generation || requestId !== entry.requestId) return;
    this.setEntry(id, { status: 'error', message: failure.message, design: undefined, designState: 'error', designError: { code: failure.code, message: failure.message } });
    entry.finishRequest?.();
    this.refreshSchematicIndex();
  }

  private refreshDocuments(): void {
    const records = this.ws?.documents ?? [];
    const previous = this.state.documents;
    const next: DocumentRuntime[] = [];
    let same = records.length === previous.length;
    const live = new Set<string>();
    records.forEach((record, index) => {
      live.add(record.id);
      const entry = this.entries.get(record.id);
      const version = entry?.version ?? -1;
      let cached = this.runtimeCache.get(record.id);
      if (!cached || cached.record !== record || cached.version !== version) {
        const runtime: DocumentRuntime = { record, status: entry?.status ?? 'loading' };
        if (entry?.message) runtime.message = entry.message;
        if (entry?.pdf) runtime.pdf = entry.pdf;
        if (entry?.bytes) runtime.bytes = entry.bytes;
        if (entry?.design) runtime.design = entry.design;
        if (entry?.designState) runtime.designState = entry.designState;
        if (entry?.designError) runtime.designError = entry.designError;
        cached = { record, version, runtime };
        this.runtimeCache.set(record.id, cached);
      }
      next.push(cached.runtime);
      if (previous[index] !== cached.runtime) same = false;
    });
    for (const id of [...this.runtimeCache.keys()]) if (!live.has(id)) this.runtimeCache.delete(id);
    this.patch({ documents: same ? previous : next.length ? next : NO_DOCUMENTS });
  }

  // =============================================================================================================
  // Manifest mutation (every change funnels through setManifest: stamp, publish, schedule the save)
  // =============================================================================================================

  private syncManifest(): void {
    const ws = this.ws;
    this.patch({ manifest: this.native ? ws : null, activeTab: ws?.activeTab ?? 'board', split: ws?.split ?? DEFAULT_SPLIT });
    this.refreshDocuments();
  }

  private setManifest(next: WorkspaceManifest): void {
    const previous = this.ws;
    if (!previous || next === previous) return;
    const stamped = touch(next, this.iso());
    this.ws = stamped;
    this.syncManifest();
    if (this.saver && !this.saveBlocked) this.saver.schedule(stamped);
    if (previous.aliases !== stamped.aliases) { this.refreshLink(); this.recomputeProbe(); }
  }

  /** Applies a manifest operation; a rejected change (limit, invalid value) becomes an error notice and leaves the manifest as it was. */
  private mutate(change: (manifest: WorkspaceManifest) => WorkspaceManifest): boolean {
    const current = this.ws;
    if (!current) return false;
    let next: WorkspaceManifest;
    try { next = change(current); }
    catch (error) { this.notify(workspaceMessage(error), 'error'); return false; }
    this.setManifest(next);
    return true;
  }

  private async flushActive(): Promise<void> {
    const saver = this.saver;
    if (!saver) return;
    try { await saver.flush(); } catch { /* state.save.failure and the failure notice already report it */ }
  }

  // =============================================================================================================
  // Schematic index, link report, probe
  // =============================================================================================================

  private refreshSchematicIndex(): void {
    const sources: SchematicSource[] = [];
    for (const record of this.ws?.documents ?? []) {
      const design = record.kind === 'schematic' ? this.entries.get(record.id)?.design : undefined;
      if (design) sources.push({ documentId: record.id, design });
    }
    const same = sources.length === this.sources.length && sources.every((source, i) => source.documentId === this.sources[i].documentId && source.design === this.sources[i].design);
    if (same) return;
    this.sources = sources;
    this.schIndex = sources.length ? buildSchematicIndex(sources) : null;
    for (const id of [...this.views.keys()]) if (!sources.some(source => source.documentId === id)) this.views.delete(id);
    this.refreshLink();
    this.recomputeProbe();
    this.rerunSearch();
  }

  /**
   * Memoized on (board index, schematic index, aliases); only these inputs trigger the comparison, never the pointer. With a model worker
   * the report is computed there (the previous report stays until the new one arrives; only the newest request's answer is applied);
   * without one, or when the worker cannot answer, it is computed here from the shared index.
   */
  private refreshLink(): void {
    const aliases = this.ws?.aliases;
    const key = this.linkKey;
    if (key && key.board === this.boardIndex && key.schematic === this.schIndex && key.aliases === aliases) return;
    this.linkKey = { board: this.boardIndex, schematic: this.schIndex, aliases };
    const run = ++this.linkRun;
    this.linkAbort?.abort();
    this.linkAbort = null;
    const board = this.boardIndex, schematic = this.schIndex;
    if (!board || !schematic) { this.patch({ link: null }); return; }
    const model = this.liveModel;
    if (!model) { this.patch({ link: linkBoardSchematic(board, schematic, aliases) }); return; }
    const abort = this.linkAbort = new AbortController();
    void this.track(model.link(this.sources, aliases, { signal: abort.signal }).then(report => {
      if (run === this.linkRun) this.patch({ link: report });
    }, error => {
      if (run !== this.linkRun || isAbortError(error)) return;
      this.patch({ link: linkBoardSchematic(board, schematic, aliases) });
    }));
  }

  private inputs(): ProbeInputs {
    return { board: this.boardIndex, schematic: this.schIndex, aliases: this.ws?.aliases, views: this.views };
  }

  /** The schematic pane state when nothing is linked: the document and sheet being looked at, with an empty selection. */
  private neutralView(): SchematicView | null {
    const ids = this.sources.map(source => source.documentId);
    if (!ids.length) return null;
    const current = this.state.probe.schematic;
    const documentId = current && ids.includes(current.documentId) ? current.documentId : ids[0];
    const design = this.sources.find(source => source.documentId === documentId)!.design;
    const known = design.schematic.instances.map(instance => instance.path);
    const wanted = this.views.get(documentId);
    const instancePath = wanted !== undefined && known.includes(wanted) ? wanted : known[0] ?? '';
    return { documentId, instancePath, selection: {} };
  }
  private setSchematicView(next: SchematicView | null): void {
    const current = this.state.probe.schematic;
    if (next) this.views.set(next.documentId, next.instancePath);
    this.setProbe({ schematic: sameView(current, next) ? current : next });
  }

  /**
   * The schematic counterpart of the selected board part, as the inspector reports it. It is a function of the board selection alone,
   * so it is refreshed whoever made the selection: a part picked in the schematic (or chosen from several board parts) is still a
   * board part with a counterpart. Unlike recomputeProbe this never moves the schematic pane.
   */
  private refreshCounterpart(): void {
    this.setProbe({ schematicMapping: mapBoardToSchematic(this.inputs(), this.state.selection).mapping });
  }

  /** Board → schematic for the current selection (the pane itself is left alone when the schematic drives the selection). */
  private recomputeProbe(): void {
    const probe = this.state.probe;
    const sources = this.sources;
    if (this.schematicDriven) {
      const view = probe.schematic;
      if (view && !sources.some(source => source.documentId === view.documentId)) { this.schematicDriven = false; this.setProbe({ schematic: this.neutralView(), boardMapping: null, boardNetMapping: null }); }
      this.refreshCounterpart();
      return;
    }
    if (!sources.length) { this.setProbe({ schematic: null, schematicMapping: null, schematicNetMapping: null }); return; }
    const forward = mapBoardToSchematic(this.inputs(), this.state.selection);
    const view = forward.view ?? this.neutralView();
    if (view) this.views.set(view.documentId, view.instancePath);
    this.setProbe({ schematicMapping: forward.mapping, schematicNetMapping: forward.netMapping, schematic: sameView(probe.schematic, view) ? probe.schematic : view });
  }

  // --- selection ---

  private applyBoardSelection(selection: BoardSelectionState, origin: SelectionOrigin, goTo: boolean): void {
    const current = this.state.selection;
    const probe = this.state.probe;
    const next = sameSelection(current, selection) ? current : selection;
    const empty = next.componentId === null && next.net === null;
    this.schematicDriven = origin === 'schematic';
    this.patch({ selection: next });
    this.setProbe({ origin: empty ? null : origin, nonce: goTo ? probe.nonce + 1 : probe.nonce, documentRef: documentRefOf(this.boardIndex, next), boardMapping: origin === 'schematic' ? probe.boardMapping : null, boardNetMapping: origin === 'schematic' ? probe.boardNetMapping : null });
    if (this.schematicDriven) this.refreshCounterpart(); else this.recomputeProbe();
    this.refreshOverlays();
  }

  private selectComponent(id: string | null, options?: { center?: boolean; origin?: SelectionOrigin }): void {
    if (id !== null && !this.boardIndex?.componentById.has(id)) return;
    this.applyBoardSelection(id === null ? EMPTY_SELECTION : { componentId: id, pinId: null, net: null }, options?.origin ?? 'board', !!options?.center);
  }
  private selectPin(id: string, options?: { center?: boolean; origin?: SelectionOrigin }): void {
    const pin = this.boardIndex?.pinById.get(id);
    if (!pin) return;
    this.applyBoardSelection({ componentId: pin.componentId, pinId: id, net: pin.net || null }, options?.origin ?? 'board', !!options?.center);
  }
  private selectNet(name: string | null, origin: SelectionOrigin = 'board'): void {
    const current = this.state.selection;
    if (name === null) { this.applyBoardSelection({ ...current, net: null }, origin ?? 'board', false); return; }
    if (!this.boardIndex?.hasNet(name)) return;
    const pin = current.pinId ? this.boardIndex.pinById.get(current.pinId) : undefined;
    // The pad (and its part) stay selected only while the net is the pad's own; any other net is selected on its own.
    const keep = pin !== undefined && pin.net === name;
    this.applyBoardSelection(keep ? { ...current, net: name } : { componentId: null, pinId: null, net: name }, origin ?? 'board', true);
  }
  private clearSelection(): void {
    this.applyBoardSelection(EMPTY_SELECTION, 'board', false);
    this.setProbe({ origin: null, schematicMapping: null, boardMapping: null, schematicNetMapping: null, boardNetMapping: null, documentRef: null });
  }

  private pickSchematic(target: { documentId: string; instancePath: string; symbolId: string; pinId?: string }, origin: SelectionOrigin): void {
    const source = this.sources.find(candidate => candidate.documentId === target.documentId);
    if (!source) return;
    const selection: SchematicView['selection'] = { symbolKey: symbolKey(target.instancePath, target.symbolId) };
    if (target.pinId !== undefined) {
      const key = pinKey(target.instancePath, target.symbolId, target.pinId);
      selection.pinKey = key;
      const netId = source.design.connectivity.pinNet[key];
      if (netId !== undefined) selection.netId = netId;
    }
    this.schematicDriven = true;
    const mapping = mapSchematicToBoard(this.inputs(), target);
    const unique = mapping?.status === 'unique' ? selectionOfBoardTarget(mapping.candidates[0]) : EMPTY_SELECTION;
    const current = this.state.selection;
    const board = sameSelection(current, unique) ? current : unique;
    this.boardChoiceOrigin = 'schematic';
    this.patch({ selection: board });
    this.setProbe({ origin, nonce: this.state.probe.nonce + 1, documentRef: documentRefOf(this.boardIndex, board), schematicNetMapping: null, boardMapping: mapping, boardNetMapping: null });
    this.setSchematicView({ documentId: target.documentId, instancePath: target.instancePath, selection });
    this.refreshCounterpart();
    this.refreshOverlays();
  }
  private selectSchematicNet(documentId: string, netId: string | null, preferred?: string): void {
    const source = this.sources.find(candidate => candidate.documentId === documentId);
    if (!source) return;
    const view = this.state.probe.schematic;
    const known = source.design.schematic.instances.map(instance => instance.path);
    const instancePath = preferred !== undefined && known.includes(preferred) ? preferred : view?.documentId === documentId ? view.instancePath : this.views.get(documentId) ?? known[0] ?? '';
    if (netId === null) { this.setSchematicView({ documentId, instancePath, selection: {} }); this.setProbe({ boardMapping: null, boardNetMapping: null }); return; }
    this.schematicDriven = true;
    const mapping = mapSchematicNet(this.inputs(), documentId, netId);
    let board: BoardSelectionState = EMPTY_SELECTION;
    if (mapping?.status === 'unique') board = { componentId: null, pinId: null, net: mapping.candidates[0].name };
    this.patch({ selection: sameSelection(this.state.selection, board) ? this.state.selection : board });
    this.setProbe({ origin: 'schematic', nonce: this.state.probe.nonce + 1, documentRef: documentRefOf(this.boardIndex, board), schematicMapping: null, schematicNetMapping: null, boardMapping: null, boardNetMapping: mapping });
    this.setSchematicView({ documentId, instancePath, selection: { netId } });
    this.refreshOverlays();
  }

  private chooseSchematicTarget(index: number): void {
    const mapping = this.state.probe.schematicMapping;
    const target = mapping?.candidates[index];
    if (!target) return;
    const view = viewOfTarget(target, this.views.get(target.documentId));
    if (!view) return;
    this.setSchematicView(view);
    this.setProbe({ nonce: this.state.probe.nonce + 1 });
  }
  private chooseBoardTarget(index: number): void {
    const mapping = this.state.probe.boardMapping;
    const target = mapping?.candidates[index];
    if (!target) return;
    const origin = this.boardChoiceOrigin;
    this.applyBoardSelection(selectionOfBoardTarget(target), origin, true);
    if (origin === 'schematic') this.schematicDriven = true;
    this.setProbe({ boardMapping: null });
  }
  /** Net-only board selection with several schematic nets of that name: the chosen net is shown, the board selection stays. */
  private chooseSchematicNet(index: number): void {
    const target = this.state.probe.schematicNetMapping?.candidates[index];
    const view = target && this.schIndex ? viewOfNetTarget(this.schIndex, target, this.views.get(target.documentId)) : null;
    if (!view) return;
    this.setSchematicView(view);
    this.setProbe({ nonce: this.state.probe.nonce + 1, schematicNetMapping: null });
  }
  /** A schematic net with several board nets: the chosen one is selected by name (as the schematic-origin selection, so nothing bounces back). */
  private chooseBoardNet(index: number): void {
    const target = this.state.probe.boardNetMapping?.candidates[index];
    if (!target) return;
    this.applyBoardSelection({ componentId: null, pinId: null, net: target.name }, 'schematic', true);
    this.setProbe({ boardNetMapping: null });
  }
  private setSchematicInstance(documentId: string, instancePath: string): void {
    const source = this.sources.find(candidate => candidate.documentId === documentId);
    if (!source || !source.design.schematic.instances.some(instance => instance.path === instancePath)) return;
    const current = this.state.probe.schematic;
    this.setSchematicView({ documentId, instancePath, selection: current?.documentId === documentId ? current.selection : {} });
  }

  // =============================================================================================================
  // PDF cross-reference and overlays
  // =============================================================================================================

  private onPdfSnapshot(generation: number, id: string): void {
    const entry = this.entries.get(id);
    const session = entry?.pdf;
    if (!entry || !session || generation !== this.generation) return;
    const snapshot = session.getSnapshot();
    // The row follows the session before anything else reacts to it (the unified search below only takes `ready` documents).
    const implied = pdfStatusOf(snapshot);
    if (implied && (entry.status !== implied.status || entry.message !== implied.message)) this.setEntry(id, implied);
    if (!entry.pageRecorded && snapshot.pageCount > 0) {
      entry.pageRecorded = true;
      this.mutate(manifest => setPageCount(manifest, id, snapshot.pageCount));
    }
    if (snapshot.status === 'ready' && !entry.readyNoticed) { entry.readyNoticed = true; this.rerunSearch(); }
    // Recognized text changed (a page was recognized, or recognized pages came back from the cache): match and search again.
    if (snapshot.ocr.revision !== (entry.ocrRevision ?? 0)) {
      entry.ocrRevision = snapshot.ocr.revision;
      if (entry.linkStarted) { entry.linkAbort?.abort(); entry.linkStarted = false; }
      this.rerunSearch();
    }
    const hasText = snapshot.searchable === true || snapshot.ocr.words > 0 || (snapshot.searchable !== false && (snapshot.index.state === 'done' || snapshot.index.state === 'truncated'));
    if (snapshot.status === 'ready' && hasText && !entry.linkStarted) this.startPdfLinks(generation, id);
  }

  /** One scan at a time: every scan builds (or waits for) a full text index, so several large PDFs must not index at once. */
  private startPdfLinks(generation: number, id: string): void {
    const entry = this.entries.get(id);
    const session = entry?.pdf;
    const board = this.boardIndex;
    if (!entry || !session || !board || entry.linkStarted) return;
    entry.linkStarted = true;
    const abort = entry.linkAbort = new AbortController();
    this.overlayStates.set(id, 'working');
    this.refreshOverlays();
    const { refs, nets } = pdfScanTargets(board);
    const stale = () => generation !== this.generation || this.entries.get(id) !== entry || abort.signal.aborted;
    const run = async (): Promise<void> => {
      if (stale()) return;
      try {
        const result = await session.refCandidates(refs, nets, { signal: abort.signal, maxTotalHits: MAX_PDF_SCAN_HITS });
        if (stale()) return;
        const report = resolvePdfRefHits(result, board, { documentId: id });
        this.overlayStates.set(id, 'ready');
        this.batch(() => { this.patch({ pdfLinks: { ...this.state.pdfLinks, [id]: report } }); this.refreshOverlays(); });
      } catch (error) {
        if (stale() || isAbortError(error) || nativeCode(error) === 'DESTROYED' || (error as { code?: string })?.code === 'DESTROYED') return;
        this.overlayStates.set(id, 'idle');
        this.refreshOverlays();
        this.notify(text(`The references of "${this.record(id)?.name ?? 'a document'}" could not be matched: ${errorText(error, 'unknown error')}`), 'error');
      }
    };
    this.scanChain = this.scanChain.then(run);
    void this.track(this.scanChain);
  }

  private refreshOverlays(): void {
    const previous = this.state.overlays;
    const next: Record<string, DocumentOverlay> = {};
    let changed = false;
    let count = 0;
    for (const record of this.ws?.documents ?? []) {
      if (record.kind !== 'pdf' || !this.entries.get(record.id)?.pdf) continue;
      const id = record.id;
      const before = previous[id];
      const overlay = buildOverlay(before, { report: this.state.pdfLinks[id], state: this.overlayStates.get(id) ?? 'idle', ref: this.state.probe.documentRef, extra: this.docHighlights.get(id) ?? NO_HIGHLIGHTS });
      next[id] = overlay;
      count++;
      if (overlay !== before) changed = true;
    }
    if (!changed && count === Object.keys(previous).length) return;
    this.patch({ overlays: count ? next : NO_OVERLAYS });
  }

  private activateProbeRegion(documentId: string, regionId: string): void {
    const report = this.state.pdfLinks[documentId];
    const target = report ? probeRegionsOf(report).targets.get(regionId) : undefined;
    if (!target) return;
    const { link } = target;
    if (link.kind === 'net') {
      const net = link.targets.find(candidate => candidate.kind === 'net');
      if (net && net.kind === 'net') this.applyBoardSelection({ componentId: null, pinId: null, net: net.name }, 'document', true);
      return;
    }
    const components = link.targets.filter(candidate => candidate.kind === 'component');
    if (components.length === 1 && components[0].kind === 'component') {
      this.applyBoardSelection({ componentId: components[0].componentId, pinId: null, net: null }, 'document', true);
    } else if (components.length > 1) {
      // Several board parts carry this exact reference: the user chooses, nothing is selected on a guess.
      this.schematicDriven = false;
      this.boardChoiceOrigin = 'document';
      this.setProbe({ origin: 'document', nonce: this.state.probe.nonce + 1, boardMapping: mappingOfLink(link) });
    }
  }

  // =============================================================================================================
  // Unified search
  // =============================================================================================================

  private rerunSearch(): void {
    if (normalizeQuery(this.searchText)) this.runSearch();
  }

  /**
   * Board groups come from the model worker when there is one (else from the shared index, synchronously), schematic groups from the
   * schematic index on this thread, document hits from the PDF sessions. The result is published whenever a part arrives; `pending`
   * stays true until all have. Only the newest query's parts are applied (`searchRun`), and a newer query cancels the older requests.
   */
  private runSearch(): void {
    const query = this.searchText;
    this.searchAbort?.abort();
    this.searchAbort = null;
    const run = ++this.searchRun;
    if (!normalizeQuery(query)) { this.patch({ search: query === this.state.search.query && this.state.search.result === null && !this.state.search.pending ? this.state.search : { query, result: null, pending: false } }); return; }
    const board = this.boardIndex, schematic = this.schIndex;
    const sessions: Array<{ id: string; name: string; session: PdfSession }> = [];
    for (const record of this.ws?.documents ?? []) {
      const entry = this.entries.get(record.id);
      if (record.kind === 'pdf' && entry?.pdf && entry.status === 'ready') {
        const snapshot = entry.pdf.getSnapshot();
        if (snapshot.status === 'ready' && (snapshot.searchable !== false || snapshot.ocr.words > 0)) sessions.push({ id: record.id, name: record.name, session: entry.pdf });
      }
    }
    const model = board ? this.liveModel : null;
    let boardGroups: BoardSearchGroups | null = model ? null : searchBoardGroups(query, board);
    let documents: DocumentSearchSource[] | null = sessions.length ? null : [];
    const publish = () => {
      if (run !== this.searchRun) return;
      const pending = boardGroups === null || documents === null;
      // Board-worker latency must not leave rows from the previous query selectable. Other current-query sources can still show partial results.
      if (boardGroups === null) {
        const result = searchAll({ query, boardGroups, schematic, documents: documents ?? [] });
        this.patch({ search: { query, result, pending } });
        return;
      }
      this.patch({ search: { query, result: searchAll({ query, boardGroups, schematic, documents: documents ?? [] }), pending } });
    };
    publish();
    if (!model && !sessions.length) return;
    const abort = this.searchAbort = new AbortController();
    if (model) {
      void this.track(model.search(query, { signal: abort.signal }).then(groups => { boardGroups = groups; publish(); }, error => {
        if (run !== this.searchRun || isAbortError(error)) return;
        boardGroups = searchBoardGroups(query, board); // the worker could not answer: search the shared index here
        publish();
      }));
    }
    if (sessions.length) {
      const limit = DEFAULT_SEARCH_LIMITS.documentsPerDocument + 1;
      void this.track(Promise.allSettled(sessions.map(async ({ id, name, session }): Promise<DocumentSearchSource> => {
        const hits = await session.find(query, { signal: abort.signal, maxHits: limit });
        return { documentId: id, name, hits, total: hits.length, truncated: hits.length >= limit };
      })).then(settled => {
        documents = settled.flatMap(item => (item.status === 'fulfilled' ? [item.value] : []));
        publish();
      }));
    }
  }

  private activateSearchRow(row: SearchRow): void {
    switch (row.source) {
      case 'board-components':
        this.selectComponent(row.componentId, { center: true, origin: 'search' });
        break;
      case 'board-nets':
        this.selectNet(row.name, 'search');
        break;
      case 'schematic-symbols':
        this.routeTab('schematic', row.documentId);
        this.pickSchematic({ documentId: row.documentId, instancePath: row.instancePath, symbolId: row.symbolId }, 'search');
        break;
      case 'schematic-nets':
        this.routeTab('schematic', row.documentId);
        this.selectSchematicNet(row.documentId, row.netId, row.scopePath);
        this.setProbe({ origin: 'search' });
        break;
      case 'documents': {
        const record = this.record(row.documentId);
        if (!record) return;
        this.routeTab('documents', row.documentId);
        const highlight: ViewerHighlight = { id: `search:${row.itemIndex}`, kind: 'selection', page: row.page, rect: { x: row.x, y: row.y, width: row.width, height: row.height }, label: row.context, active: true };
        this.docHighlights.set(row.documentId, [highlight]);
        this.mutate(manifest => setCamera(manifest, row.documentId, { ...manifest.cameras[row.documentId], page: row.page }));
        const component = uniqueComponentByRef(this.boardIndex, row.context);
        if (component) this.applyBoardSelection({ componentId: component, pinId: null, net: null }, 'search', true);
        else this.setProbe({ origin: 'search', nonce: this.state.probe.nonce + 1 });
        this.refreshOverlays();
        break;
      }
    }
  }
  /** A schematic/document row brings its pane forward unless the split view already shows that document. */
  private routeTab(tab: WorkspaceTab, documentId: string): void {
    const split = this.ws?.split;
    if (split?.enabled && split.right?.id === documentId) return;
    this.mutate(manifest => setActiveTab(manifest, tab));
  }

  // =============================================================================================================
  // Documents
  // =============================================================================================================

  private async readBrowserDocuments(files: File[]): Promise<DocumentPayload[]> {
      if (files.length > MAX_ATTACH_FILES * 4) throw new UiError(text(`Too many files at once (at most ${MAX_ATTACH_FILES} documents per attach).`));
      const sniffed: Array<{ file: File; data: Uint8Array; kind: DocumentKind; format: string }> = [];
      let total = 0;
      for (const file of files) {
        if (file.size > MAX_DOCUMENT_BYTES) throw new UiError(text(`"${file.name}" is larger than 64 MB.`));
        total += file.size;
        if (total > MAX_ATTACH_BYTES) throw new UiError(text('The selected files are larger than 256 MB together.'));
        const data = new Uint8Array(await file.arrayBuffer());
        const found = sniffDocument(data);
        if (found) sniffed.push({ file, data, ...found });
      }
      const documents = sniffed.filter(item => item.format !== 'eeschema-lib');
      if (documents.length > MAX_ATTACH_FILES) throw new UiError(text(`At most ${MAX_ATTACH_FILES} documents can be attached at once.`));
      const siblings = sniffed.filter(item => item.kind === 'schematic');
      const payloads: DocumentPayload[] = [];
      for (const item of documents) {
        const name = baseName(item.file.name) || 'document';
        const payload: DocumentPayload = { name, path: '', kind: item.kind, format: item.format, data: item.data, key: await sha256Hex(item.data), size: item.data.byteLength };
        if (item.kind === 'schematic') {
          const companions: Record<string, Uint8Array> = {};
          for (const sibling of siblings) if (sibling !== item) companions[baseName(sibling.file.name).toLowerCase()] = sibling.data;
          if (Object.keys(companions).length) payload.companions = companions;
        }
        payloads.push(payload);
      }
      if (!payloads.length && files.length) throw new UiError(text('None of the selected files is a PDF, image or schematic that TRACE can open.'));
      return payloads;
  }

  /** Attaches one file by content identity; returns what happened for the summary notice. */
  private attachOne(generation: number, payload: DocumentPayload): 'added' | 'duplicate' | 'restored' | 'failed' {
    if (generation !== this.generation || !this.ws) return 'failed';
    const path = payload.path || `/${payload.name}`;
    let result;
    try { result = addDocument(this.ws, { kind: payload.kind, name: payload.name, path, key: payload.key, size: payload.size }, this.iso(), this.newId); }
    catch (error) { this.notify(text(`"${payload.name}" was not attached: ${errorText(error, 'invalid document')}`), 'error'); return 'failed'; }
    this.setManifest(result.manifest);
    const id = result.document.id;
    const entry = this.entries.get(id);
    if (!result.added && entry && (entry.status === 'ready' || entry.status === 'loading')) return 'duplicate';
    this.installPayload(generation, id, payload);
    return result.added ? 'added' : 'restored';
  }

  private summarizeAttach(outcomes: Array<{ name: string; outcome: AttachOutcome }>): void {
    const count = (kind: string) => outcomes.filter(item => item.outcome === kind);
    const added = count('added').length + count('restored').length;
    if (added) this.notify(text(added === 1 ? `Attached "${[...count('added'), ...count('restored')][0].name}".` : `Attached ${added} documents.`), 'success');
    const duplicates = count('duplicate');
    if (duplicates.length) this.notify(text(duplicates.length === 1 ? `"${duplicates[0].name}" is already attached to this workspace.` : `${duplicates.length} of the files are already attached to this workspace.`), 'info');
  }

  private async attachPayloads(generation: number, payloads: DocumentPayload[]): Promise<void> {
    const outcomes: Array<{ name: string; outcome: AttachOutcome }> = [];
    for (const payload of payloads) outcomes.push({ name: payload.name, outcome: this.attachOne(generation, payload) });
    if (generation === this.generation) this.summarizeAttach(outcomes);
  }

  private async attachDocuments(kinds?: DocumentKind[]): Promise<void> {
    if (!this.ws) { this.notify(text('Open a board before attaching documents.'), 'info'); return; }
    const generation = this.generation;
    try {
      if (this.desktop) {
        const payloads = await this.desktop.pickDocuments({ ...(kinds ? { kinds } : {}), multiple: true });
        await this.attachPayloads(generation, payloads);
      } else {
        const files = await this.deps.pickFiles?.({ multiple: true });
        if (files?.length) await this.attachBrowser(generation, files);
      }
    } catch (error) {
      if (generation === this.generation) this.notifyFailure(error, text('The documents could not be attached.'));
    }
  }
  private async attachBrowser(generation: number, files: File[]): Promise<void> {
    await this.attachPayloads(generation, await this.readBrowserDocuments(files));
  }
  private async attachFiles(files: File[]): Promise<void> {
    if (!this.ws) { this.notify(text('Open a board before attaching documents.'), 'info'); return; }
    const generation = this.generation;
    try {
      const desktop = this.desktop;
      if (!desktop) { await this.attachBrowser(generation, files); return; }
      const outcomes: Array<{ name: string; outcome: AttachOutcome }> = [];
      for (const file of files) {
        const path = desktop.droppedFilePath(file);
        if (!path) { this.notify(text(`"${file.name}" has no file path, so it cannot be attached.`), 'error'); continue; }
        let payload: DocumentPayload;
        try { payload = await desktop.readDocument(path); }
        catch (error) { this.notifyFailure(error, text(`"${file.name}" could not be read.`)); continue; }
        if (generation !== this.generation) return;
        outcomes.push({ name: payload.name, outcome: this.attachOne(generation, payload) });
      }
      if (generation === this.generation) this.summarizeAttach(outcomes);
    } catch (error) {
      if (generation === this.generation) this.notifyFailure(error, text('The documents could not be attached.'));
    }
  }

  private removeDocument(id: string): void {
    this.batch(() => this.removeDocumentNow(id));
  }
  private removeDocumentNow(id: string): void {
    const record = this.record(id);
    if (!record) return;
    if (!this.mutate(manifest => removeDocument(manifest, id))) return;
    const entry = this.entries.get(id);
    if (entry) { this.disposeEntry(entry); this.entries.delete(id); }
    this.overlayStates.delete(id);
    this.docHighlights.delete(id);
    if (id in this.state.pdfLinks) { const { [id]: _removed, ...rest } = this.state.pdfLinks; this.patch({ pdfLinks: Object.keys(rest).length ? rest : NO_LINKS }); }
    this.refreshDocuments();
    this.refreshSchematicIndex();
    this.refreshOverlays();
    this.rerunSearch();
    this.notify(text(`Removed "${record.name}" from the workspace. The file itself was not touched.`), 'success');
  }

  private async pickOne(kind: DocumentKind): Promise<DocumentPayload | null> {
    if (this.desktop) return (await this.desktop.pickDocuments({ kinds: [kind], multiple: false }))[0] ?? null;
    const files = await this.deps.pickFiles?.({ multiple: false });
    if (!files?.length) return null;
    const payloads = await this.readBrowserDocuments(files.slice(0, 1));
    return payloads[0] ?? null;
  }

  private async relinkDocument(id: string): Promise<void> {
    const record = this.record(id);
    if (!record || !this.ws) return;
    const generation = this.generation;
    try {
      const payload = await this.pickOne(record.kind);
      if (!payload || generation !== this.generation || !this.ws) return;
      const result = relinkDocument(this.ws, id, { name: payload.name, path: payload.path || `/${payload.name}`, key: payload.key });
      if (!result.ok) {
        this.notify(text(result.reason === 'mismatch'
          ? `That file is not "${record.name}": its content differs from the attached document (SHA-256 mismatch). Nothing was changed.`
          : 'The document could not be relinked.'), 'error');
        return;
      }
      this.setManifest(result.manifest);
      this.installPayload(generation, id, payload);
      this.notify(text(`Relinked "${record.name}".`), 'success');
    } catch (error) {
      if (generation === this.generation) this.notifyFailure(error, text('The document could not be relinked.'));
    }
  }

  private async acceptChangedDocument(id: string): Promise<void> {
    const desktop = this.desktop;
    const record = this.record(id);
    const change = this.entries.get(id)?.change;
    if (!desktop || !record || !change) { this.notify(text('There is no changed file to accept for this document.'), 'info'); return; }
    const generation = this.generation;
    try {
      const payload = await desktop.readDocument(change.path, { kinds: [record.kind] });
      if (generation !== this.generation || this.entries.get(id)?.change !== change) return;
      if (payload.key !== change.key) { this.notify(text(`The file at ${change.path} changed again while it was being read. Nothing was accepted; review it and try again.`), 'error'); return; }
      const ok = this.mutate(manifest => acceptChangedDocument(manifest, id, { path: payload.path, ...(change.relativePath ? { relativePath: change.relativePath } : {}), key: payload.key, size: payload.size }));
      if (!ok) return;
      this.installPayload(generation, id, payload);
      this.notify(text(`Now using the changed file for "${record.name}". Bookmarks and annotations were kept; a calibration was cleared.`), 'success');
    } catch (error) {
      if (generation === this.generation) this.notifyFailure(error, text('The changed file could not be read.'));
    }
  }

  private setBookmarks(id: string, next: DocumentBookmark[]): void {
    this.mutate(manifest => {
      const keep = new Set(next.map(bookmark => bookmark.id));
      let current = manifest;
      for (const old of manifest.documents.find(document => document.id === id)?.bookmarks ?? []) if (!keep.has(old.id)) current = removeBookmark(current, id, old.id);
      for (const bookmark of next) current = upsertBookmark(current, id, bookmark);
      return current;
    });
  }
  private setAnnotations(id: string, next: DocumentAnnotation[]): void {
    this.mutate(manifest => {
      const keep = new Set(next.map(annotation => annotation.id));
      let current = manifest;
      for (const old of manifest.documents.find(document => document.id === id)?.annotations ?? []) if (!keep.has(old.id)) current = removeAnnotation(current, id, old.id);
      const now = this.iso();
      for (const { updatedAt: _updated, ...annotation } of next) current = upsertAnnotation(current, id, annotation, now);
      return current;
    });
  }

  private async exportWorkspace(options: { documentIds: string[]; includeBoard: boolean; includeNotes: boolean }): Promise<WorkspaceExportResult | null> {
    const desktop = this.desktop;
    const key = this.state.boardKey;
    if (!desktop || !key || !this.ws) { this.notify(text('Exporting a workspace needs the desktop app and an open board.'), 'info'); return null; }
    const generation = this.generation;
    try {
      const saver = this.saver;
      if (saver) {
        try { await saver.flush(); }
        catch { this.notify(text('The workspace could not be saved first, so nothing was exported.'), 'error'); return null; }
      }
      if (generation !== this.generation) return null;
      const known = new Set(this.ws.documents.map(document => document.id));
      const result = await desktop.exportWorkspace({ boardKey: key, documentIds: options.documentIds.filter(id => known.has(id)), includeBoard: options.includeBoard, includeNotes: options.includeNotes });
      if (result && generation === this.generation) this.notify(text(`Exported ${result.files} file${result.files === 1 ? '' : 's'} to ${result.path}.`), 'success');
      return result;
    } catch (error) {
      if (generation === this.generation) this.notifyFailure(error, text('The workspace could not be exported.'));
      return null;
    }
  }

  // =============================================================================================================
  // Notes (per-board generation: a save that finishes after a board switch never touches the new board)
  // =============================================================================================================

  private async readNotes(key: string): Promise<BoardNote[]> {
    let value: unknown;
    try {
      if (this.desktop) value = await this.desktop.getNotes(key);
      else value = JSON.parse(this.deps.storage?.getItem(NOTES_PREFIX + key) || '[]');
    } catch (error) { throw this.desktop ? error : new UiError(say('toast.notesUnreadable')); }
    try { return validateNotes(value); }
    catch { throw new UiError(say('toast.notesUnreadable')); }
  }
  private async writeNotes(key: string, notes: BoardNote[]): Promise<void> {
    // Conformance: this application never stores a positional note that has not been through the conversion (a converted one is keyed, a
    // failed one carries `unresolved`). A path that skipped it would otherwise write the parser's positional ids back to disk.
    try { assertStorable(notes); } catch { throw new UiError(say('toast.noteSaveFailed')); }
    if (this.desktop) { await this.desktop.saveNotes(key, notes); return; }
    if (!this.deps.storage) throw new UiError(say('toast.noteSaveFailed'));
    this.deps.storage.setItem(NOTES_PREFIX + key, JSON.stringify(notes));
  }
  /**
   * Reads the stored notes of a board and converts the positional ones once (note-keys.ts): every positional id is looked up in `board` as
   * the current importer parsed it, the result is written back, and what could not be placed stays stored as unresolved. A failed
   * write-back is returned in `unsaved` (the converted notes are still shown, and the next save writes them); a failed READ throws.
   */
  private async loadNotes(key: string, board: Board): Promise<{ notes: BoardNote[]; unsaved: unknown }> {
    const stored = await this.readNotes(key);
    const converted = migrateNotes(board, stored, this.iso());
    if (!converted.changed) return { notes: stored, unsaved: null };
    try { await this.writeNotes(key, converted.notes); return { notes: converted.notes, unsaved: null }; }
    catch (error) { return { notes: converted.notes, unsaved: error }; }
  }

  private noteOperation(run: (identity: { key: string; generation: number }, isCurrent: () => boolean) => Promise<void>): Promise<void> {
    const key = this.state.boardKey;
    if (!key) return Promise.resolve();
    const identity = { key, generation: this.generation };
    const isCurrent = () => this.state.boardKey === identity.key && this.generation === identity.generation;
    const chained = this.noteChain.then(() => (isCurrent() ? run(identity, isCurrent) : undefined));
    this.noteChain = chained.catch(() => {});
    return this.track(chained);
  }

  /** The caller names a part or pad by the board's session handles; the note is stored under its key (reference and pin number, or the explicit position fallback). */
  private upsertNote(subject: NoteSubject, patch: Parameters<WorkspaceActions['upsertNote']>[1]): Promise<void> {
    return this.noteOperation(async (identity, isCurrent) => {
      const blocked = this.state.notesBlocked;
      if (blocked) { this.notify(blocked, 'error'); return; }
      const board = this.state.board;
      const target = board ? noteKeyIndex(board).target(subject?.componentId, subject?.pinId) : null;
      if (!target) return;
      if (!target.ok) {
        this.notify(say(target.reason === 'part-indistinguishable' ? 'notes.refusePart' : target.reason === 'pin-indistinguishable' ? 'notes.refusePin' : 'toast.noteSaveFailed'), 'error');
        return;
      }
      const notes = this.state.notes;
      let next: BoardNote[];
      try { next = upsertNote(notes, target.key, patch, this.iso(), this.newId); }
      catch (error) { this.notify(workspaceMessage(error), 'error'); return; }
      if (next === notes) return;
      const removed = noteFor(next, target.key) === undefined;
      try { await this.writeNotes(identity.key, next); }
      catch (error) { if (isCurrent() && !(this.desktop && isClosingError(error))) this.notify(this.desktop ? nativeFailure(error, say('toast.noteSaveFailed')) : say('toast.noteSaveFailed'), 'error'); return; }
      if (!isCurrent()) return;
      this.patch({ notes: next.length ? next : NO_NOTES });
      this.notify(say(removed ? 'toast.noteDeleted' : 'toast.noteSaved'), 'success');
    });
  }
  /** Deletes one stored note by id (an unresolved note has no part to select, so it cannot be reached through `upsertNote`). */
  private removeNote(id: string): Promise<void> {
    return this.noteOperation(async (identity, isCurrent) => {
      const blocked = this.state.notesBlocked;
      if (blocked) { this.notify(blocked, 'error'); return; }
      const notes = this.state.notes;
      const next = dropNote(notes, id);
      if (next === notes) return;
      try { await this.writeNotes(identity.key, next); }
      catch (error) { if (isCurrent() && !(this.desktop && isClosingError(error))) this.notify(this.desktop ? nativeFailure(error, say('toast.noteSaveFailed')) : say('toast.noteSaveFailed'), 'error'); return; }
      if (!isCurrent()) return;
      this.patch({ notes: next.length ? next : NO_NOTES });
      this.notify(say('toast.noteDeleted'), 'success');
    });
  }
  private retryNotes(): Promise<void> {
    return this.noteOperation(async (identity, isCurrent) => {
      try {
        const board = this.state.board;
        if (!board) return;
        const { notes: saved, unsaved } = await this.loadNotes(identity.key, board);
        if (!isCurrent()) return;
        this.patch({ notes: saved.length ? saved : NO_NOTES, notesBlocked: null });
        this.notify(say('toast.notesReloaded'), 'success');
        if (unsaved && !isClosingError(unsaved)) this.notify(say('toast.notesUpdateFailed'), 'error');
        if (unresolvedNotes(board, saved).length) this.notify(say('toast.notesUnresolved'), 'error');
      } catch (error) {
        if (!isCurrent() || isClosingError(error)) return;
        const message = nativeFailure(error, say('toast.notesStillUnreadable'));
        this.patch({ notesBlocked: message });
        this.notify(message, 'error');
      }
    });
  }

  // =============================================================================================================
  // Actions
  // =============================================================================================================

  private createActions(): WorkspaceActions {
    return {
      openBoard: async () => {
        const desktop = this.desktop;
        // The intent is declared BEFORE the chooser opens (as for the native dialog): whatever it returns after a newer request began is dropped.
        const token = this.beginImport();
        if (!desktop) {
          // The chooser is a user dialog, not controller work: it stays outside track() so idle() does not wait for a person.
          let files: File[] | undefined;
          try { files = await this.deps.pickFiles?.({ multiple: true }); }
          catch (error) { if (token === this.sequence) this.notifyFailure(error, say('toast.openFailed')); return; }
          if (token === this.sequence && files?.length) await this.track(this.readBrowserFiles(files, token));
          return;
        }
        await this.track((async () => {
          try { const payload = await desktop.openBoard(); if (payload) await this.loadPayload(payload, token); }
          catch (error) {
            if (token === this.sequence) {
              // The native chooser resolves null on cancellation; a rejection after selection has no safe filename descriptor here.
              this.setReportContext(token, importContext('', 'failed', 'read', null, 'READ_FAILED'));
              this.patchImport({ phase: 'idle' });
              this.notifyFailure(error, say('toast.openFailed'));
            }
          }
        })());
      },
      openRecent: async path => {
        const desktop = this.desktop;
        if (!desktop) return;
        const token = this.beginImport();
        this.patchImport({ phase: 'reading' });
        this.setReportContext(token, importContext(path, 'reading', 'read'));
        await this.track((async () => {
          try { await this.loadPayload(await desktop.readBoard(path), token); }
          catch (error) { if (token === this.sequence) { this.patchImport({ phase: 'idle' }); this.setReportContext(token, importContext(path, 'failed', 'read', null, 'READ_FAILED')); this.notifyFailure(error, say('toast.fileUnavailable')); } }
        })());
      },
      openDropped: async files => {
        const desktop = this.desktop;
        if (!desktop) { if (files.length) await this.track(this.readBrowserFiles(files)); return; }
        const primary = files.find(file => companionNames(file.name).length > 0) ?? files[0];
        if (!primary) return;
        const token = this.beginImport();
        const path = desktop.droppedFilePath(primary);
        if (!path) {
          this.setReportContext(token, importContext(primary.name, 'failed', 'read', null, 'READ_FAILED'));
          this.notify(say('toast.pathUnavailable'), 'error'); return;
        }
        this.patchImport({ phase: 'reading' });
        this.setReportContext(token, importContext(primary.name, 'reading', 'read'));
        await this.track((async () => {
          try { await this.loadPayload(await desktop.readBoard(path), token); }
          catch (error) { if (token === this.sequence) { this.patchImport({ phase: 'idle' }); this.setReportContext(token, importContext(primary.name, 'failed', 'read', null, 'READ_FAILED')); this.notifyFailure(error, say('toast.fileUnavailable')); } }
        })());
      },
      submitKey: input => {
        const waiting = this.waitingKey;
        const request = this.state.import.keyRequest;
        if (!waiting || !request) return;
        const check = validateKeyText(waiting.kind, input);
        if ('error' in check) { this.patchImport({ keyRequest: { ...request, message: check.error } }); return; }
        this.sessionOptions = { ...this.sessionOptions, ...check.options };
        const { payload } = waiting;
        void this.track(this.loadPayload(payload, this.beginImport()));
      },
      cancelImport: () => {
        if (this.state.import.phase === 'idle') return;
        // The worker is terminated and whatever the read or the parse still returns is dropped (a new import token).
        const previous = this.state.import.reportContext;
        this.beginImport();
        if (previous) this.patchImport({ reportContext: { ...previous, outcome: 'cancelled', errorCode: 'CANCELLED' } });
        this.notify(say('toast.importCancelled'));
      },
      cancelKeyRequest: () => {
        if (!this.state.import.keyRequest) return;
        this.waitingKey = null;
        const context = this.state.import.reportContext;
        this.patchImport({ keyRequest: null, ...(context ? { reportContext: { ...context, outcome: 'cancelled', errorCode: 'CANCELLED' } } : {}) });
        // Closing the key dialog leaves the file unopened; without a word the vanished dialog reads as a silent failure (H3-03).
        this.notify(say('toast.openFailed'));
      },
      closeBoard: () => this.closeBoard(),

      setActiveTab: tab => { this.mutate(manifest => setActiveTab(manifest, tab)); },
      setSplit: patch => { this.mutate(manifest => setSplit(manifest, patch)); },
      setCamera: (source, camera) => {
        // Pointer-adjacent (rAF-throttled by the viewers): an invalid or unchanged camera is dropped silently, no notice.
        const current = this.ws;
        if (!current) return;
        const { page, zoom, rotation, x, y, fit, side } = camera as BoardCamera;
        // `side` (the viewed board side) belongs to the board only; the validator rejects anything but 'top' | 'bottom' as for every number.
        // `fit` (the viewers' requested fit mode) belongs to documents only and is stored with them: without it a fitted zoom comes back as a
        // frozen manual zoom on every remount (W-win-viewers-01 / W-fin-crossprobe-02); the validator keeps exactly 'width' | 'page' | 'none'.
        try { this.setManifest(setCamera(current, source, { page, zoom, rotation, x, y, ...(source !== 'board' && fit !== undefined ? { fit } : {}), ...(source === 'board' && side !== undefined ? { side } : {}) })); } catch { /* ignored on purpose */ }
      },
      cameraOf: source => (this.ws?.cameras[source] as ViewerCamera | undefined) ?? EMPTY_CAMERA,

      attachDocuments: kinds => this.track(this.attachDocuments(kinds)),
      attachFiles: files => this.track(this.attachFiles(files)),
      removeDocument: id => this.removeDocument(id),
      relinkDocument: id => this.track(this.relinkDocument(id)),
      acceptChangedDocument: id => this.track(this.acceptChangedDocument(id)),
      setBookmarks: (id, next) => this.setBookmarks(id, next),
      setAnnotations: (id, next) => this.setAnnotations(id, next),
      setCalibration: (id, next: DocumentCalibration | undefined) => { this.mutate(manifest => setCalibration(manifest, id, next ?? null)); },
      exportWorkspace: options => this.track(this.exportWorkspace(options)),

      selectComponent: (id, options) => this.batch(() => this.selectComponent(id, options)),
      selectPin: (id, options) => this.batch(() => this.selectPin(id, options)),
      selectNet: (name, origin) => this.batch(() => this.selectNet(name, origin)),
      selectSchematicSymbol: target => this.batch(() => this.pickSchematic({ documentId: target.documentId, instancePath: target.instancePath, symbolId: target.symbolId }, 'schematic')),
      selectSchematicPin: target => this.batch(() => this.pickSchematic({ documentId: target.documentId, instancePath: target.instancePath, symbolId: target.symbolId, pinId: target.pinId }, 'schematic')),
      selectSchematicNet: (documentId, netId) => this.batch(() => this.selectSchematicNet(documentId, netId)),
      chooseSchematicTarget: index => this.batch(() => this.chooseSchematicTarget(index)),
      chooseBoardTarget: index => this.batch(() => this.chooseBoardTarget(index)),
      chooseSchematicNet: index => this.batch(() => this.chooseSchematicNet(index)),
      chooseBoardNet: index => this.batch(() => this.chooseBoardNet(index)),
      activateProbeRegion: (documentId, regionId) => this.batch(() => this.activateProbeRegion(documentId, regionId)),
      setSchematicInstance: (documentId, instancePath) => this.batch(() => this.setSchematicInstance(documentId, instancePath)),
      clearSelection: () => this.batch(() => this.clearSelection()),
      setAlias: (kind, from, to) => { this.batch(() => this.mutate(manifest => setAlias(manifest, kind, from, to))); },
      removeAlias: (kind, from) => { this.batch(() => this.mutate(manifest => removeAlias(manifest, kind, from))); },

      setSearchQuery: query => { this.searchText = query; this.runSearch(); },
      activateSearchRow: row => this.batch(() => this.activateSearchRow(row)),

      upsertNote: (target, patch) => this.upsertNote(target, patch),
      removeNote: id => this.removeNote(id),
      retryNotes: () => this.retryNotes(),

      dismissNotice: id => {
        if (!this.state.notices.some(notice => notice.id === id)) return;
        const rest = this.state.notices.filter(notice => notice.id !== id);
        this.patch({ notices: rest.length ? rest : NO_NOTICES });
      },
    };
  }
}
