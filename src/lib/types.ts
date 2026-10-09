import type { DiagnosticReport } from './diagnostics/report';
import type { Language, ParseIssue } from './i18n';
import type { DocumentKind, DocumentLocateRequest, DocumentLocateResult, DocumentPayload, WorkspaceExportRequest, WorkspaceExportResult, WorkspaceManifest } from './documents';
import type { AppendResult, FamilyListEntry, RawFamilySnapshot, ReadingsExportRequest, ReadingsExportResult, ReadingsImportFile } from './readings/model';
import type { RepairEvent } from './readings/schema';

export type { Language, ParseIssue };
export type BoardSide = 'top' | 'bottom' | 'both';
export type ViewSide = 'top' | 'bottom';
export interface Point { x: number; y: number }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
export interface BoardPin extends Point {
  /** Session-local handle (numbered by the parser); never persist it. Notes use the (reference, pin number) keys of note-keys.ts. */
  id: string;
  componentId: string;
  number: string;
  /** True when the file gives this pad no number and `number` is a placeholder made by the importer; such a number is not an identity. */
  numberGenerated?: true;
  name: string;
  net: string;
  side: BoardSide;
  radius: number;
  shape: 'round' | 'rect' | 'square';
  width?: number;
  height?: number;
  /** Counter-clockwise degrees in canonical Y-up coordinates; dimensions remain local. */
  rotation?: number;
}
export interface BoardComponent {
  /** Session-local handle (numbered by the parser); never persist it. Notes use the reference keys of note-keys.ts. */
  id: string;
  ref: string;
  /** True when the file gives this component no reference designator and `ref` is a placeholder made by the importer; such a reference is not an identity. */
  refGenerated?: true;
  value: string;
  package: string;
  side: BoardSide;
  bounds: Bounds;
  position: Point;
  rotation: number;
  pinIds: string[];
  outline: Point[];
}
export interface BoardNet { id: string; name: string; pinIds: string[] }
export interface Board {
  name: string;
  format: string;
  units: 'mm';
  components: BoardComponent[];
  pins: BoardPin[];
  nets: BoardNet[];
  outline: Point[];
  bounds: Bounds;
  /** Structured, so the info dialog is rendered in the language active at that moment. */
  warnings: ParseIssue[];
  /** Present only when shortened BDV or ASC component/pin headers can change the earlier reader's positional component/pin ids. */
  legacyPositionalNotesUnsafe?: true;
}
/** Original bytes of the chosen file; the parser (never the transport) decides the format. */
export interface FilePayload {
  name: string;
  path: string;
  data: Uint8Array;
  /** Fixed companion files from the same directory, keyed by lowercase basename. */
  companions?: Record<string, Uint8Array>;
  /** SHA-256 hex of the ORIGINAL bytes of the primary file: the notes identity. */
  key: string;
  startupSource?: 'argument' | 'recent';
}
/** Session-only keys for encrypted boardviews; never persisted. */
export type ImportOptions = import('./formats/common').ParseOptions;
/** A recognized-but-unreadable file, as the parser dispatcher reports it: English text, and a catalog message when there is one. */
export interface FormatFailure { message: string; code: string; format?: string; keyKind?: 'fz' | 'xzz'; issue?: ParseIssue }
export interface RecentFile { name: string; path: string; openedAt: string }
/** A place on the board in millimetres (rounded to 1 µm) plus the side it is on: the explicit fallback identity of an object the file does not name uniquely. */
export interface NoteAnchor { side: BoardSide; x: number; y: number }
/**
 * What a note is about, independent of how any parser numbers its records (grammar and rules: src/lib/note-keys.ts).
 * A part is `ref` (its normalized reference designator) and a pin is `ref` plus `pin` (its normalized pin number); the optional anchors apply
 * only where the file does not name the object uniquely: `at` tells apart parts that share a reference (or have none), `pinAt` names a pad
 * without a number. At least one of `ref` and `at` is present; `pin` and `pinAt` never both.
 */
export interface NoteKey { ref?: string; at?: NoteAnchor; pin?: string; pinAt?: NoteAnchor }
/** Why a note is not attached to a part or pin of the open board. The notes themselves are always kept. */
export type NoteProblem =
  | 'component-missing' | 'component-ambiguous' | 'pin-missing' | 'pin-ambiguous'
  | 'legacy-id-missing' | 'legacy-indistinguishable' | 'legacy-order-unknown' | 'duplicate-target';
interface NoteBase {
  id: string;
  text: string;
  /** Free-text values the technician measured, as typed ("1.8 V", "0.4 Ω"). */
  measurements?: { voltage?: string; resistance?: string; other?: string };
  updatedAt: string;
}
/** Technician-entered record, never an inferred measurement. One note per target: a part (`ref`) or one of its pins (`ref` + `pin`). */
export interface KeyedNote extends NoteBase { target: NoteKey }
/**
 * A note written before notes had keys: it names the importer's positional ids (`part:12`, `pin:341`). It is read, never created. Opening the
 * board turns it into a KeyedNote once (the id is looked up in this board as the current importer reads it); what cannot be resolved stays
 * here with `unresolved` filled in, so it is listed instead of being guessed or dropped.
 */
export interface LegacyNote extends NoteBase {
  componentId: string;
  /** BoardPin.id when the note belonged to a single pin of the component. */
  pinId?: string;
  unresolved?: { reason: NoteProblem; at: string };
}
export type BoardNote = KeyedNote | LegacyNote;
export interface AppSettings {
  language: Language;
  theme: 'dark' | 'light' | 'system';
  layout: 'workshop' | 'focus';
  motion: boolean;
  showLabels: boolean;
  showConnections: boolean;
  /** Ask GitHub once per launch whether a newer release exists (a notification only, nothing is installed). Profiles saved before this setting existed get true. */
  updateCheck: boolean;
}
/** What the main process reports about the latest release (see electron/updates.cjs); no tag, no URL, no server text. */
export type UpdateCheckResult = { status: 'available'; version: string } | { status: 'current' } | { status: 'unavailable' };
/** A network feature as the main process lists it (electron/net/egress.cjs): its hosts, the setting that switches it on (null: none) and whether it is on now. */
export interface NetworkFeature { id: string; hosts: string[]; optIn: string | null; enabled: boolean }
/** One line of the in-memory network log. `outcome` pending: still running; refused: blocked by policy before anything was sent; error: failed after sending. `error` is a class from a fixed list, never a message. */
export interface NetworkActivityEntry {
  id: number; time: string; kind: 'request' | 'download'; feature: string; method: string; host: string; path: string;
  outcome: 'pending' | 'ok' | 'refused' | 'error'; status: number | null; bytes: number; durationMs: number | null; error: string | null;
}
export interface NetworkActivityReport { features: NetworkFeature[]; entries: NetworkActivityEntry[]; dropped: number; limit: number }
export interface CanvasStatus {
  zoom: number;
  x: number;
  y: number;
  rotation: number;
  measurement: number | null;
}
export interface ViewCommand {
  type: 'fit' | 'zoom-in' | 'zoom-out' | 'center-selection' | 'rotate';
  nonce: number;
}
/**
 * Native rejections arrive with a stable machine code as a "[CODE] text" message prefix (see nativeErrorCode in workspace.ts). Quit-time codes:
 * STORE_CLOSING (a write after the quit intent), EXPORT_CLOSING (export after the quit intent), BOARD_CLOSING (open-board chooser after the quit intent),
 * DOCUMENT_CLOSING (document chooser after the quit intent). All are permanent for the current process: do not retry them.
 */
/**
 * What the main process hands over for a format diagnostic report: the bytes of the file the user chose under a neutral name (an extension only, or the fixed role name of a
 * companion-set member; never the real name or folder), its companions, the operating system family and the dedupe code (an HMAC under a secret that stays in the main process).
 */
export interface DiagnosticFilePayload { name: string; data: Uint8Array; companions?: Record<string, Uint8Array>; os: 'win32' | 'darwin' | 'linux' | 'other'; dedupe: string }
export interface SupportStatus { status: 'inactive' | 'verified' | 'pending' | 'unavailable'; expiresAt: number | null; available: boolean }

export interface TraceDesktop {
  openBoard(): Promise<FilePayload | null>;
  readBoard(path: string): Promise<FilePayload>;
  acceptBoard(path: string, key: string): Promise<void>;
  initialBoard(): Promise<FilePayload | null>;
  recentBoards(): Promise<RecentFile[]>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  getNotes(boardKey: string): Promise<BoardNote[]>;
  saveNotes(boardKey: string, notes: BoardNote[]): Promise<void>;
  minimize(): void;
  maximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  onMaximized(listener: (value: boolean) => void): () => void;
  droppedFilePath(file: File): string;
  onOpenBoard(listener: (payload: FilePayload) => void): () => void;
  /** Main process asks the renderer to write its pending (debounced) state before the window closes or the app quits; the bridge answers when every listener settled. Optional: an older preload or the browser build lacks it. */
  onFlushRequest?(listener: () => Promise<void> | void): () => void;
  /** Persisted workspace manifest of one board (null when none was saved); validated natively, bounded, never attached to another board. */
  loadWorkspace(boardKey: string): Promise<WorkspaceManifest | null>;
  /** Queued atomic write; rejected once the application is quitting. */
  saveWorkspace(boardKey: string, manifest: WorkspaceManifest): Promise<void>;
  /** Native multi-select dialog for documents; every file is sniffed, size-bounded and hashed. Cancel resolves []. */
  pickDocuments(options?: { kinds?: DocumentKind[]; multiple?: boolean }): Promise<DocumentPayload[]>;
  /** Reads one absolute path (restore after restart, relink); content must match an allowed kind. */
  readDocument(path: string, options?: { kinds?: DocumentKind[] }): Promise<DocumentPayload>;
  /** Re-finds remembered documents by absolute path, then by path relative to the board's directory, and verifies SHA-256. */
  locateDocuments(boardPath: string, requests: DocumentLocateRequest[]): Promise<DocumentLocateResult[]>;
  /** Save dialog + zip bundle of ONLY the documents (and optionally board/notes) the user selected. Cancel resolves null. */
  exportWorkspace(request: WorkspaceExportRequest): Promise<WorkspaceExportResult | null>;
  /** Format diagnostic report (Help): main opens the file dialog (any file) and reads the file with its companions. Cancel resolves null. Optional: an older preload lacks it. */
  pickDiagnosticFile?(): Promise<DiagnosticFilePayload | null>;
  /** Format diagnostic report: main validates the report against the closed schema again, opens the save dialog and writes the canonical text. Cancel resolves null; rejects with a DIAGNOSTIC_* code. Optional: an older preload lacks it. */
  saveDiagnosticReport?(report: DiagnosticReport): Promise<{ bytes: number } | null>;
  /** Prepare an immutable local report preview. No network request is made. Optional for older or browser bridges. */
  prepareBugReport?(request: BugReportInput): Promise<BugReportPrepareResult>;
  /** Explicitly send only the report identified by a current main-process preview handle. Optional for older bridges. */
  sendBugReport?(request: { prepareId: string }): Promise<BugReportSendResult>;
  /** Cancel the current send for this preview. A cancellation after transmission is uncertain. Optional for older bridges. */
  cancelBugReport?(request: { prepareId: string }): Promise<BugReportCancelResult>;
  /** Read the optional local draft and exact pending retry payload. Never sends. Optional for older bridges. */
  getBugReportDraft?(): Promise<BugReportDraftResult>;
  /** Save a bounded local draft. Never sends. Optional for older bridges. */
  saveBugReportDraft?(request: BugReportInput): Promise<{ status: 'saved' } | BugReportErrorResult>;
  /** Discard the local draft and pending retry journal, including an uncertain attempted report. This only removes local data; it does not delete a report remotely. Optional for older bridges. */
  discardBugReportDraft?(): Promise<{ status: 'discarded' } | BugReportErrorResult>;
  /** Support notice and top bar: asks the main process to open one of three fixed links (Stripe, Ko-fi, or the support page) in the system browser. The renderer sends an id, never a URL; any other id is rejected. Optional: an older preload lacks it. */
  openSupportLink?(id: 'stripe' | 'kofi' | 'support'): Promise<void>;
  getSupportStatus?(): Promise<SupportStatus>;
  prepareSupport?(): Promise<SupportStatus & { code: string }>;
  checkSupport?(): Promise<SupportStatus>;
  /** Update notification: one request from the main process to the GitHub releases API (never from the renderer). Never rejects for network reasons: any failure is { status: 'unavailable' }. Optional: an older preload lacks it. */
  checkForUpdates?(): Promise<UpdateCheckResult>;
  /** Opens the release page of the version the last check reported, in the system browser. Takes no argument: the main process remembers the validated tag, the renderer never sends a URL. Rejects when no update was found. Optional: an older preload lacks it. */
  openUpdatePage?(): Promise<void>;
  /** Network activity (Settings > Network): the network features and the in-memory log of every request the main process made, as plain data (see src/lib/network-activity.ts). Takes no argument. Optional: an older preload lacks it. */
  getNetworkActivity?(): Promise<NetworkActivityReport>;
  /** Empties that log. Takes no argument; the log is read-only otherwise. Optional: an older preload lacks it. */
  clearNetworkActivity?(): Promise<void>;
  /** Readings (src/lib/readings, docs/READINGS_FORMAT.md): every board family of the repair store, without its readings. Optional: an older preload lacks it. */
  listReadingFamilies?(): Promise<FamilyListEntry[]>;
  /** One family (null when it does not exist); the readings come as the text of one JSON array, see parseFamilySnapshot. */
  readReadings?(familyId: string, options?: { headerOnly?: boolean }): Promise<RawFamilySnapshot | null>;
  /** Appends the events of one call (all or nothing), validated natively; rejects with a READINGS_* code. */
  appendReadings?(familyId: string, events: RepairEvent[]): Promise<AppendResult>;
  /** Native open dialog for a readings file (pack, CSV, OpenBoardData text): its base name and text. Cancel resolves null. */
  importReadings?(): Promise<ReadingsImportFile | null>;
  /** Native save dialog, then writes the pack (validated natively) as a pack file or CSV. Cancel resolves null. */
  exportReadings?(request: ReadingsExportRequest): Promise<ReadingsExportResult | null>;
}

export type BugReportLastImport = {
  outcome: 'reading' | 'processing' | 'opened' | 'failed' | 'cancelled' | 'key-required' | 'timeout' | 'worker-failed';
  stage: 'read' | 'detect' | 'unpack' | 'parse' | 'done' | 'unknown';
  formatId: string | null; extensionClass: string; errorCode: string | null;
} | null;
export type BugReportDiagnostics = {
  app: { version: string; platform: 'windows' | 'macos' | 'linux' | 'other'; arch: 'x64' | 'arm64' | 'other' };
  locale: 'hu' | 'en' | 'de' | 'fr' | 'it' | 'sk' | 'pl' | 'uk';
  surface: 'welcome' | 'board' | 'documents' | 'schematic' | 'settings' | 'other'; lastImport: BugReportLastImport;
} | null;
export type BugReport = { schema: 'trace-bug-report/1'; reportId: string; description: string; diagnostics: BugReportDiagnostics };
export type BugReportInput = { description: string; includeDiagnostics: boolean; context: { surface: 'welcome' | 'board' | 'documents' | 'schematic' | 'settings' | 'other'; lastImport: BugReportLastImport } | null };
export type BugReportError = 'offline' | 'timeout' | 'cancelled' | 'invalid' | 'too-large' | 'rate-limited' | 'unavailable' | 'storage' | 'conflict' | 'busy' | 'stale-preview' | 'unknown';
export type BugReportErrorResult = { status: 'error'; error: BugReportError; retryAfterSeconds?: number };
export type BugReportPrepareResult = { status: 'prepared'; prepareId: string; report: BugReport; canonicalText: string; payloadHash: string } | BugReportErrorResult;
export type BugReportSendResult = { status: 'received'; reportId: string; payloadHash: string } | BugReportErrorResult;
export type BugReportCancelResult = { status: 'cancelled'; uncertain: boolean } | BugReportErrorResult;
export type BugReportDraftResult = { status: 'empty' } | { status: 'available'; draft: BugReportInput | null; pending: { report: BugReport; canonicalText: string; payloadHash: string } | null } | BugReportErrorResult;
declare global { interface Window { traceDesktop?: TraceDesktop } }
