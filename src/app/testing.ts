/**
 * Test support for the application core: original synthetic boards/schematics and fakes for every dependency of
 * `createWorkspaceController` (desktop bridge, workers, PDF sessions). Pure data and closures, no DOM, no Electron.
 */
import type { Board, BoardNote, FilePayload, RecentFile, TraceDesktop, UpdateCheckResult } from '../lib/types';
import { isSupportLinkId } from '../lib/support-notice';
import { createModelHost } from '../lib/model-host';
import type { ModelHost } from '../lib/model-host';
import { MODEL_PROTOCOL } from '../lib/model-protocol';
import type { BoardSide } from '../lib/types';
import type { DocumentKind, DocumentLocateRequest, DocumentLocateResult, DocumentPayload, WorkspaceExportRequest, WorkspaceExportResult, WorkspaceManifest } from '../lib/documents';
import type { Hit, RefCandidate } from '../lib/pdf/search';
import type { CreatePdfSessionOptions, PdfSession, PdfSessionSnapshot, RefCandidateResult } from '../lib/pdf/session-contract';
import { computeConnectivity } from '../lib/schematic/connectivity';
import { loadSchematicDesign, SchematicError } from '../lib/schematic/index';
import type { SchematicDesign } from '../lib/schematic/model';
import { buildSchematic, SheetBuilder } from '../lib/schematic/testing';
import type { SchematicWorkerRequest, SchematicWorkerResponse } from '../lib/schematic/schematic-worker';
import { addDocument, createManifest } from '../lib/workspace';
import { createWorkspaceController } from './controller';
import type { ControllerDeps, ControllerTimers, ParseWatchdog, WorkerFactory, WorkspaceController } from './controller';

export const enc = (value: string) => new TextEncoder().encode(value);
export const hexKey = (n: number) => n.toString(16).padStart(64, '0');
export const T0 = Date.parse('2026-10-05T10:00:00.000Z');

export interface Deferred<T = void> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
/** Lets every already-resolved promise continuation run. */
export const flushMicrotasks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// ---------------------------------------------------------------------------------------------------------------
// Boards and schematics
// ---------------------------------------------------------------------------------------------------------------

export interface BoardSpec { ref: string; id?: string; side?: BoardSide; pins: Array<[number: string, net: string]> }
export function makeBoard(name: string, specs: BoardSpec[]): Board {
  const components: Board['components'] = [], pins: Board['pins'] = [];
  const netPins = new Map<string, string[]>();
  specs.forEach((spec, i) => {
    const id = spec.id ?? `c${i}`, side = spec.side ?? 'top';
    const pinIds: string[] = [];
    for (const [number, net] of spec.pins) {
      const pinId = `${id}.${number}.${pins.length}`;
      pins.push({ id: pinId, componentId: id, number, name: '', net, side, radius: 0.2, shape: 'round', x: i, y: 0 });
      pinIds.push(pinId);
      if (net) { const list = netPins.get(net); if (list) list.push(pinId); else netPins.set(net, [pinId]); }
    }
    components.push({ id, ref: spec.ref, value: '', package: '', side, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, position: { x: i, y: 0 }, rotation: 0, pinIds, outline: [] });
  });
  const nets = [...netPins].map(([netName, pinIds], k) => ({ id: `n${k}`, name: netName, pinIds }));
  return { name, format: 'Synthetic board', units: 'mm', components, pins, nets, outline: [], bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, warnings: [] };
}
/** R1 (VCC, OUT), R2 (OUT, GND), U1: every reference exists once, on both the board and in `dividerDesign`. */
export const dividerBoard = (name = 'divider.cad') => makeBoard(name, [
  { ref: 'R1', id: 'r1', pins: [['1', 'VCC'], ['2', 'OUT']] },
  { ref: 'R2', id: 'r2', pins: [['1', 'OUT'], ['2', 'GND']] },
  { ref: 'U1', id: 'u1', pins: [['1', 'VCC'], ['2', 'GND']] },
]);
export function designOf(schematic: ReturnType<typeof buildSchematic>): SchematicDesign { return { schematic, connectivity: computeConnectivity(schematic) }; }
/** VCC -> R1 -> OUT -> R2 -> GND (the same shape as fixtureDivider in src/lib/schematic/testing.ts). */
export function dividerDesign(): SchematicDesign {
  const sheet = new SheetBuilder('root', 'divider')
    .power('VCC', 20, 0).wire(20, 0, 20, 10)
    .part('R1', [{ n: '1', x: 20, y: 10 }, { n: '2', x: 20, y: 20 }])
    .wire(20, 20, 20, 30).local('OUT', 20, 25)
    .part('R2', [{ n: '1', x: 20, y: 30 }, { n: '2', x: 20, y: 40 }])
    .wire(20, 40, 20, 50).power('GND', 20, 50);
  return designOf(buildSchematic([sheet]));
}
/** One definition placed twice, both placements annotated "R1": a board R1 maps to two schematic placements (ambiguous). */
export function twinDesign(): SchematicDesign {
  const amp = new SheetBuilder('amp', 'amp')
    .part('R?', [{ n: '1', x: 10, y: 0 }, { n: '2', x: 20, y: 0 }], { id: 'r', instances: { '/amp1': { ref: 'R1', unit: 1 }, '/amp2': { ref: 'R1', unit: 1 } } });
  const root = new SheetBuilder('root', 'top')
    .sheet('amp1', 'amp', 'amp1', [], { at: { x: 0, y: 0 } })
    .sheet('amp2', 'amp', 'amp2', [], { at: { x: 0, y: 40 } });
  return designOf(buildSchematic([root, amp]));
}

/**
 * One "amp" definition placed twice, each placement with its OWN local net "OUT" (so a board net "OUT" has two schematic
 * candidates) and one global net "VCC" shared by both placements (unique). R1 / R2 are the per-placement references.
 */
export function twinNetDesign(): SchematicDesign {
  const amp = new SheetBuilder('amp', 'amp')
    .part('R?', [{ n: '1', x: 10, y: 0 }, { n: '2', x: 20, y: 0 }], { id: 'r', instances: { '/amp1': { ref: 'R1', unit: 1 }, '/amp2': { ref: 'R2', unit: 1 } } })
    .wire(20, 0, 30, 0).local('OUT', 25, 0).wire(10, 0, 0, 0).global('VCC', 5, 0);
  const root = new SheetBuilder('root', 'top')
    .sheet('amp1', 'amp', 'amp1', [], { at: { x: 0, y: 0 } })
    .sheet('amp2', 'amp', 'amp2', [], { at: { x: 0, y: 40 } });
  return designOf(buildSchematic([root, amp]));
}

/** A real, tiny KiCad schematic (version 20231120): R1 (pin 1 wired to a global label "SIG") and R2 on the same net. */
export function kicadText(): string {
  const eff = '(effects (font (size 1.27 1.27)))';
  const pin = (at: string, number: string) => `(pin passive line (at ${at}) (length 1.27) (name "~" ${eff}) (number "${number}" ${eff}))`;
  const lib = `(symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 0 6 0) ${eff}) (property "Value" "R" (at 0 -6 0) ${eff})
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "R_1_1" ${pin('0 3.81 270', '1')} ${pin('0 -3.81 90', '2')}))`;
  const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const placed = (ref: string, uuid: string, x: number) => `(symbol (lib_id "Device:R") (at ${x} 50 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "${uuid}")
    (property "Reference" "${ref}" (at 0 0 0) ${eff}) (property "Value" "10k" (at 0 0 0) ${eff})
    (instances (project "demo" (path "/${U(1)}" (reference "${ref}") (unit 1)))))`;
  return `(kicad_sch (version 20231120) (generator "synthetic") (uuid "${U(1)}") (paper "A4") (lib_symbols ${lib})
    ${placed('R1', U(2), 40)} ${placed('R2', U(3), 80)}
    (wire (pts (xy 40 46.19) (xy 80 46.19)) (stroke (width 0) (type default)) (uuid "${U(4)}"))
    (global_label "SIG" (shape input) (at 60 46.19 0) ${eff} (uuid "${U(5)}")))`;
}

// ---------------------------------------------------------------------------------------------------------------
// Fake desktop bridge
// ---------------------------------------------------------------------------------------------------------------

export interface FakeDesktop extends TraceDesktop {
  /** Ordered log of calls, e.g. "loadWorkspace:<key>", "saveWorkspace:<key>". */
  readonly log: string[];
  readonly boards: Map<string, FilePayload>;
  readonly docs: Map<string, DocumentPayload>;
  readonly workspaces: Map<string, WorkspaceManifest>;
  readonly notes: Map<string, BoardNote[]>;
  recents: RecentFile[];
  initial: FilePayload | null;
  dialog: FilePayload | null;
  /** Results of successive pickDocuments calls. */
  picks: DocumentPayload[][];
  readonly pickOptions: Array<{ kinds?: DocumentKind[]; multiple?: boolean } | undefined>;
  /** Overrides locate results per document id (default: compares the file at the remembered path with the remembered key). */
  locate: Record<string, Partial<DocumentLocateResult>>;
  exportResult: WorkspaceExportResult | null;
  readonly exportRequests: WorkspaceExportRequest[];
  /** What the next checkForUpdates calls answer (default: up to date). */
  updateResult: UpdateCheckResult;
  /** True once a check reported a newer release: only then does openUpdatePage succeed (like the main process, which remembers the validated tag). */
  updateAvailable: boolean;
  /** Called before a method completes; return a promise to hold it. Keys: openBoard readBoard getNotes saveNotes loadWorkspace saveWorkspace readDocument openSupportLink checkForUpdates openUpdatePage. */
  holds: Partial<Record<string, (arg: string) => Promise<unknown> | undefined>>;
  failures: Partial<Record<string, (arg: string) => Error | undefined>>;
  activeReads: number;
  maxActiveReads: number;
  emitOpen(payload: FilePayload): void;
}

export function createFakeDesktop(): FakeDesktop {
  const openListeners = new Set<(payload: FilePayload) => void>();
  const fake = {
    log: [] as string[], boards: new Map<string, FilePayload>(), docs: new Map<string, DocumentPayload>(), workspaces: new Map<string, WorkspaceManifest>(), notes: new Map<string, BoardNote[]>(),
    recents: [] as RecentFile[], initial: null as FilePayload | null, dialog: null as FilePayload | null, picks: [] as DocumentPayload[][], pickOptions: [] as FakeDesktop['pickOptions'],
    locate: {} as FakeDesktop['locate'], exportResult: { path: '/exports/bundle.zip', files: 3, bytes: 1234 } as WorkspaceExportResult | null, exportRequests: [] as WorkspaceExportRequest[],
    holds: {} as FakeDesktop['holds'], failures: {} as FakeDesktop['failures'], activeReads: 0, maxActiveReads: 0,
    updateResult: { status: 'current' } as UpdateCheckResult, updateAvailable: false,
  };
  const step = async (name: string, arg = '') => {
    fake.log.push(arg ? `${name}:${arg}` : name);
    const hold = fake.holds[name]?.(arg);
    if (hold) await hold;
    const failure = fake.failures[name]?.(arg);
    if (failure) throw failure;
  };
  const desktop: FakeDesktop = {
    ...fake,
    get recents() { return fake.recents; }, set recents(value) { fake.recents = value; },
    get initial() { return fake.initial; }, set initial(value) { fake.initial = value; },
    get dialog() { return fake.dialog; }, set dialog(value) { fake.dialog = value; },
    get picks() { return fake.picks; }, set picks(value) { fake.picks = value; },
    get locate() { return fake.locate; }, set locate(value) { fake.locate = value; },
    get exportResult() { return fake.exportResult; }, set exportResult(value) { fake.exportResult = value; },
    get activeReads() { return fake.activeReads; }, set activeReads(value) { fake.activeReads = value; },
    get maxActiveReads() { return fake.maxActiveReads; }, set maxActiveReads(value) { fake.maxActiveReads = value; },
    get updateResult() { return fake.updateResult; }, set updateResult(value) { fake.updateResult = value; },
    get updateAvailable() { return fake.updateAvailable; }, set updateAvailable(value) { fake.updateAvailable = value; },
    emitOpen: payload => { for (const listener of [...openListeners]) listener(payload); },
    openBoard: async () => { await step('openBoard'); return fake.dialog; },
    readBoard: async path => {
      await step('readBoard', path);
      const payload = fake.boards.get(path);
      if (!payload) throw new Error("Error invoking remote method 'trace:read-board': Error: [DOCUMENT_NOT_FOUND] The file was not found.");
      return payload;
    },
    acceptBoard: async (path, key) => { await step('acceptBoard', key); fake.recents = [{ name: path.split('/').pop() ?? path, path, openedAt: new Date(T0).toISOString() }, ...fake.recents.filter(item => item.path !== path)]; },
    initialBoard: async () => fake.initial,
    recentBoards: async () => [...fake.recents],
    getSettings: async () => { throw new Error('not used'); },
    saveSettings: async () => {},
    getNotes: async key => { await step('getNotes', key); return structuredClone(fake.notes.get(key) ?? []); },
    saveNotes: async (key, notes) => { await step('saveNotes', key); fake.notes.set(key, structuredClone(notes)); },
    minimize() {}, maximize() {}, close() {},
    isMaximized: async () => false,
    onMaximized: () => () => {},
    droppedFilePath: file => (file as File & { path?: string }).path ?? '',
    onOpenBoard: listener => { openListeners.add(listener); return () => { openListeners.delete(listener); }; },
    onFlushRequest: () => () => {},
    loadWorkspace: async key => { await step('loadWorkspace', key); return structuredClone(fake.workspaces.get(key) ?? null); },
    saveWorkspace: async (key, manifest) => { await step('saveWorkspace', key); fake.workspaces.set(key, structuredClone(manifest)); },
    pickDocuments: async options => { fake.log.push('pickDocuments'); fake.pickOptions.push(options); return fake.picks.shift() ?? []; },
    readDocument: async path => {
      fake.activeReads++; fake.maxActiveReads = Math.max(fake.maxActiveReads, fake.activeReads);
      try { await step('readDocument', path); } finally { fake.activeReads--; }
      const payload = fake.docs.get(path);
      if (!payload) throw new Error("Error invoking remote method 'trace:read-document': Error: [DOCUMENT_NOT_FOUND] The file was not found.");
      return payload;
    },
    locateDocuments: async (boardPath: string, requests: DocumentLocateRequest[]) => {
      fake.log.push(`locateDocuments:${boardPath}`);
      return requests.map((request): DocumentLocateResult => {
        const override = fake.locate[request.id];
        const found = fake.docs.get(request.path);
        const base: DocumentLocateResult = !found ? { id: request.id, status: 'missing' }
          : found.key === request.key ? { id: request.id, status: 'ok', path: found.path, key: found.key, size: found.size }
            : { id: request.id, status: 'changed', path: found.path, key: found.key, size: found.size };
        return { ...base, ...override };
      });
    },
    exportWorkspace: async request => { fake.log.push('exportWorkspace'); fake.exportRequests.push(request); return fake.exportResult; },
    // Like the main process: only the fixed ids are accepted; the log gets "openSupportLink:<id>" for accepted ones.
    openSupportLink: async id => { if (!isSupportLinkId(id)) throw new Error('Unknown support link.'); await step('openSupportLink', id); },
    // Like the main process: no argument is read. `updateResult` is the answer of the next checks; openUpdatePage rejects, as the main process does, until a check reported a newer release.
    checkForUpdates: async () => { await step('checkForUpdates'); fake.updateAvailable = fake.updateResult.status === 'available'; return fake.updateResult; },
    openUpdatePage: async () => { if (!fake.updateAvailable) throw new Error('No update available.'); await step('openUpdatePage'); },
  } as FakeDesktop;
  // The object spread above copied plain values; share the live containers instead.
  Object.assign(desktop, { log: fake.log, boards: fake.boards, docs: fake.docs, workspaces: fake.workspaces, notes: fake.notes, pickOptions: fake.pickOptions, exportRequests: fake.exportRequests, holds: fake.holds, failures: fake.failures });
  return desktop;
}

export function boardPayload(name: string, key: number, over: Partial<FilePayload> = {}): FilePayload {
  return { name, path: `/boards/${name}`, data: enc(name), key: hexKey(key), ...over };
}
export function documentPayload(path: string, kind: DocumentKind, key: number, over: Partial<DocumentPayload> = {}): DocumentPayload {
  const name = path.split('/').pop()!;
  const format = kind === 'pdf' ? 'pdf' : kind === 'image' ? 'png' : 'kicad_sch';
  return { name, path, kind, format, data: enc(`bytes of ${name}`), key: hexKey(key), size: 100 + key, ...over };
}

// ---------------------------------------------------------------------------------------------------------------
// Fake workers and PDF sessions
// ---------------------------------------------------------------------------------------------------------------

export interface FakeBoardWorkers {
  factory: WorkerFactory;
  created: number;
  terminated: number;
  /** Boards (or parser replies) by file name. */
  replies: Record<string, unknown>;
  /** Holds the reply of a file name until the promise settles. */
  gates: Record<string, Promise<unknown>>;
  /** Options each import was posted with (session keys). */
  options: unknown[];
  /**
   * Answer like the real board worker (src/lib/board-worker.ts): `{ board, model: MODEL_PROTOCOL }`, after which the same worker serves
   * model requests from an in-process model host (src/lib/model-host.ts). Every message crosses the fake boundary structured-cloned.
   */
  model: boolean;
  /** Messages (`{ progress: { fraction } }` and the like) posted in order before the reply of a file name; a promise in the list holds the rest until it settles. */
  progress: Record<string, unknown[]>;
  /** Every model request the UI posted to a model worker, in order. */
  modelRequests: Array<{ type: string; id: number }>;
  /** While set, model responses wait for this promise. */
  modelGate: Promise<unknown> | null;
  /** The crash callback of every worker, in creation order (calls the controller's onError while the worker lives; the controller then terminates it). */
  crash: Array<() => void>;
}
export function createBoardWorkers(): FakeBoardWorkers {
  const fake: FakeBoardWorkers = {
    created: 0, terminated: 0, replies: {}, gates: {}, options: [], model: false, progress: {}, modelRequests: [], modelGate: null, crash: [],
    factory: (onMessage, onError) => {
      fake.created++;
      let dead = false;
      let host: ModelHost | null = null;
      fake.crash.push(() => { if (!dead) onError(); });
      return {
        post: message => {
          if (host) { fake.modelRequests.push(message as { type: string; id: number }); host.receive(structuredClone(message)); return; }
          const { name, options } = message as { name: string; options: unknown };
          fake.options.push(options);
          void (async () => {
            await fake.gates[name];
            for (const item of fake.progress[name] ?? []) {
              if (item instanceof Promise) { await item; continue; }
              if (dead) return;
              onMessage(item);
              await Promise.resolve();
            }
            if (dead) return;
            const reply = fake.replies[name];
            const board = reply !== undefined && 'components' in (reply as object) ? reply as Board : null;
            if (!board) { onMessage(reply); return; }
            if (!fake.model) { onMessage({ board }); return; }
            host = createModelHost(structuredClone(board), response => {
              void (async () => { await fake.modelGate; if (!dead) onMessage(structuredClone(response)); })();
            }, { schedule: run => { void Promise.resolve().then(run); } });
            onMessage({ board, model: MODEL_PROTOCOL });
          })();
        },
        terminate: () => { if (!dead) { dead = true; fake.terminated++; } },
      };
    },
  };
  return fake;
}

export interface FakeSchematicWorkers {
  factory: WorkerFactory;
  created: number;
  terminated: number;
  /** The requests as the worker received them (structured-cloned; transferred buffers are detached on the sender's side). */
  posted: SchematicWorkerRequest[];
  /** Delivers a raw reply as the worker would (for stale-reply tests). */
  emit: Array<(reply: unknown) => void>;
  /** Designs returned by file name instead of parsing the bytes. */
  designs: Record<string, SchematicDesign>;
  gates: Record<string, Promise<unknown>>;
}
export function createSchematicWorkers(): FakeSchematicWorkers {
  const fake: FakeSchematicWorkers = {
    created: 0, terminated: 0, posted: [], emit: [], designs: {}, gates: {},
    factory: onMessage => {
      fake.created++;
      fake.emit.push(onMessage);
      let dead = false;
      return {
        post: (message, transfer) => {
          // A real structured-clone transfer: a buffer that was already detached (or listed twice) throws exactly like Worker.postMessage.
          const request = (transfer?.length ? structuredClone(message, { transfer }) : structuredClone(message)) as SchematicWorkerRequest;
          fake.posted.push(request);
          void (async () => {
            await fake.gates[request.name];
            if (dead) return;
            let reply: SchematicWorkerResponse;
            try {
              const design = fake.designs[request.name] ?? loadSchematicDesign({ name: request.name, data: request.data, companions: request.companions });
              reply = { requestId: request.requestId, design };
            } catch (error) {
              reply = { requestId: request.requestId, error: error instanceof SchematicError ? { code: error.code, message: error.message } : { code: 'UNKNOWN', message: String(error) } };
            }
            onMessage(reply);
          })();
        },
        terminate: () => { if (!dead) { dead = true; fake.terminated++; } },
      };
    },
  };
  return fake;
}

export interface FakePdfSession extends PdfSession {
  options: CreatePdfSessionOptions;
  disposed: boolean;
  scans: Array<{ refs: ReadonlySet<string>; nets: ReadonlySet<string> }>;
  searches: string[];
  /** Candidates (and truncation) returned by refCandidates. */
  candidates: RefCandidate[];
  truncated: boolean;
  /** Hits returned by find, by query (default none). */
  hits: Record<string, Hit[]>;
  findGate: Promise<unknown> | null;
  scanGate: Promise<unknown> | null;
  update(patch: Partial<{ -readonly [K in keyof PdfSessionSnapshot]: PdfSessionSnapshot[K] }>): void;
}
export interface FakePdfSessions { create(options: CreatePdfSessionOptions): PdfSession; sessions: FakePdfSession[]; defaults: { candidates: RefCandidate[]; truncated: boolean; searchable: boolean | null }; /** Holds refCandidates of a session id. */ scanGates: Record<string, Promise<unknown>> }
export function createPdfSessions(): FakePdfSessions {
  const registry: FakePdfSessions = {
    sessions: [], scanGates: {}, defaults: { candidates: [], truncated: false, searchable: true },
    create(options) {
      const listeners = new Set<() => void>();
      let snapshot: PdfSessionSnapshot = { status: 'ready', error: null, pageCount: 3, searchable: registry.defaults.searchable, index: { state: 'idle', indexedPages: 0, pageCount: 3, items: 0 }, outline: [],
        ocr: { state: 'idle', totalPages: 0, processedPages: 0, currentPage: 0, recognizedPages: 0, words: 0, failedPages: 0, revision: 0, error: null } };
      const session: FakePdfSession = {
        id: options.id, options, disposed: false, scans: [], searches: [], candidates: registry.defaults.candidates, truncated: registry.defaults.truncated, hits: {}, findGate: null, scanGate: registry.scanGates[options.id] ?? null,
        getSnapshot: () => snapshot,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        update: patch => { snapshot = { ...snapshot, ...patch }; for (const listener of [...listeners]) listener(); },
        submitPassword: async () => {},
        getHandle: () => null,
        ensureIndex: async () => { throw new Error('not used'); },
        async find(query, findOptions) {
          session.searches.push(query);
          if (session.findGate) await session.findGate;
          if (findOptions?.signal?.aborted) throw Object.assign(new Error('The search was cancelled.'), { name: 'PdfError', code: 'ABORTED' });
          return session.hits[query] ?? [];
        },
        async refCandidates(refs, nets): Promise<RefCandidateResult> {
          session.scans.push({ refs, nets });
          if (session.scanGate) await session.scanGate;
          return { candidates: session.candidates, truncated: session.truncated, totalHits: session.candidates.reduce((sum, candidate) => sum + candidate.hits.length, 0) };
        },
        inspectPage: async () => 'text',
        recognizeText: async () => {},
        cancelRecognition: () => {},
        getRecognizedText: () => null,
        async dispose() { session.disposed = true; snapshot = { ...snapshot, status: 'closed' }; },
      };
      registry.sessions.push(session);
      return session;
    },
  };
  return registry;
}
export const hit = (page: number, x: number, context: string, over: Partial<Hit> = {}): Hit => ({ page, itemIndex: page * 100 + x, x, y: 10, width: 20, height: 8, context, token: context, ...over });

// ---------------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------------

export interface Harness {
  controller: WorkspaceController;
  desktop: FakeDesktop;
  boardWorkers: FakeBoardWorkers;
  schematicWorkers: FakeSchematicWorkers;
  pdf: FakePdfSessions;
  storage: Map<string, string>;
  clock: { now: number };
  files: File[][];
  /** Files the browser chooser returns next. */
  pickQueue: File[][];
  /** Held chooser results: the next `pickFiles` call waits for the first promise of this queue (instead of using `pickQueue`). */
  pickHolds: Array<Promise<File[]>>;
  state: () => ReturnType<WorkspaceController['getSnapshot']>;
  messages: () => string[];
}
export function createHarness(options: { browser?: boolean; saveDelayMs?: number; timers?: ControllerTimers; parseWatchdog?: Partial<ParseWatchdog> } = {}): Harness {
  const desktop = createFakeDesktop();
  const boardWorkers = createBoardWorkers();
  const schematicWorkers = createSchematicWorkers();
  const pdf = createPdfSessions();
  const storage = new Map<string, string>();
  const clock = { now: T0 };
  let counter = 0;
  const pickQueue: File[][] = [];
  const pickHolds: Array<Promise<File[]>> = [];
  const deps: ControllerDeps = {
    ...(options.browser ? {} : { desktop }),
    createBoardWorker: boardWorkers.factory,
    createSchematicWorker: schematicWorkers.factory,
    createPdfSession: pdf.create,
    now: () => clock.now,
    newId: () => `id-${++counter}`,
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } },
    pickFiles: async () => { const held = pickHolds.shift(); return held ? held : pickQueue.shift() ?? []; },
    saveDelayMs: options.saveDelayMs ?? 5,
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.parseWatchdog ? { parseWatchdog: options.parseWatchdog } : {}),
  };
  const controller = createWorkspaceController(deps);
  const messages = () => controller.getSnapshot().notices.map(notice => ('text' in notice.message ? notice.message.text : 'key' in notice.message ? notice.message.key : 'issue'));
  return { controller, desktop, boardWorkers, schematicWorkers, pdf, storage, clock, files: [], pickQueue, pickHolds, state: controller.getSnapshot, messages };
}

/** Registers a board in the fakes (worker reply + native payload) and returns the payload. */
export function registerBoard(h: Harness, name: string, key: number, board: Board = dividerBoard(name)): FilePayload {
  const payload = boardPayload(name, key);
  h.boardWorkers.replies[name] = board;
  h.desktop.boards.set(payload.path, payload);
  return payload;
}

// ---------------------------------------------------------------------------------------------------------------
// Workspace seeding
// ---------------------------------------------------------------------------------------------------------------

export interface SeedDocument { id: string; path: string; kind: DocumentKind; key: number; /** The file exists at its path (default true). */ present?: boolean }
/** Stores a manifest for the board key (as the native store would) and the files of its documents in the fake desktop. */
export function seedWorkspace(h: Harness, boardKey: number, boardPath: string, docs: SeedDocument[]): WorkspaceManifest {
  const iso = new Date(T0).toISOString();
  let manifest = createManifest({ key: hexKey(boardKey), name: boardPath.split('/').pop()!, path: boardPath, format: 'Synthetic board' }, iso);
  for (const doc of docs) {
    manifest = addDocument(manifest, { kind: doc.kind, name: doc.path.split('/').pop()!, path: doc.path, key: hexKey(doc.key), size: 100 + doc.key }, iso, () => doc.id).manifest;
    if (doc.present !== false) h.desktop.docs.set(doc.path, documentPayload(doc.path, doc.kind, doc.key));
  }
  h.desktop.workspaces.set(hexKey(boardKey), manifest);
  return manifest;
}
export async function openNative(h: Harness, name: string, key: number, board?: Board): Promise<FilePayload> {
  const payload = registerBoard(h, name, key, board);
  await h.controller.actions.openRecent(payload.path);
  await h.controller.idle();
  return payload;
}
