import type { ViewerCamera, ViewerHighlight, ViewerProbeRegion, SchematicSelection } from '../components/viewer-contracts';
import type { BoardIndex } from '../lib/board-index';
import type { BoardNetTarget, BoardTarget, LinkReport, Mapping, PdfLinkReport, SchematicNetTarget, SchematicTarget, SearchResult, SearchRow } from '../lib/crossprobe';
import type { DocumentAnnotation, DocumentBookmark, DocumentCalibration, DocumentKind, DocumentRecord, WorkspaceExportResult, WorkspaceManifest, WorkspaceSplit, WorkspaceTab } from '../lib/documents';
import type { PdfSession } from '../lib/pdf/session-contract';
import type { SchSheetInstance, SchematicDesign } from '../lib/schematic/model';
import type { Message } from '../lib/i18n';
import type { Board, BoardNote, RecentFile } from '../lib/types';
import type { NoteSubject } from '../lib/note-keys';
import type { NotePatch } from '../lib/workspace';

/**
 * Contract between the application core (src/app/**: `useWorkspace()` implements it, no JSX) and the UI
 * (src/App.tsx + src/components/workspace/**: renders it, owns layout/CSS/focus, never talks to Electron, workers,
 * pdf.js or the workspace manifest directly). Everything here is plain data or functions, so the UI can be exercised with
 * a mock implementation (src/app/mock-api.ts) without the real core.
 *
 * Rules every implementer follows:
 *  - State objects are immutable and referentially stable until something changes (React-friendly).
 *  - Pointer-rate data (canvas coordinates/zoom/measurement) NEVER goes through `WorkspaceState`: it lives in `statusStore`
 *    and only the status bar subscribes (P01). Documents' cameras are persisted through `setCamera`, rAF-throttled by the viewer.
 *  - Actions never throw to the UI: failures become `state.notice` (error) messages; async actions resolve when settled.
 *  - Message texts for user-facing text are `{ text }` English strings (catalogs are frozen this phase; `// i18n: pending`).
 */

export type DocumentStatus = 'loading' | 'ready' | 'missing' | 'changed' | 'unreadable' | 'error';

/** One attached document with everything the viewers need; the bytes never leave the core except as these handles. */
export interface DocumentRuntime {
  record: DocumentRecord;
  status: DocumentStatus;
  /** English explanation for missing/changed/unreadable/error (what happened and what the user can do). */
  message?: string;
  /** kind 'pdf': live session (text index, outline, search); present while status is 'ready' or while it asks for a password. */
  pdf?: PdfSession;
  /** kind 'image': original bytes handed to ImageViewer. */
  bytes?: Uint8Array;
  /** kind 'schematic': parsed model + computed connectivity. */
  design?: SchematicDesign;
  designState?: 'parsing' | 'ready' | 'error';
  designError?: { code: string; message: string };
}

/** Per-document cross-reference overlay for the viewers (computed by the core from the board index and the PDF text index). */
export interface DocumentOverlay {
  highlights: ViewerHighlight[];
  probeRegions: ViewerProbeRegion[];
  /** 'working' while the PDF index is being scanned; 'truncated' when a budget stopped the scan (disclose it). */
  state: 'idle' | 'working' | 'ready' | 'truncated';
}

export type SelectionOrigin = 'board' | 'schematic' | 'document' | 'search' | 'inspector' | null;

export interface BoardSelectionState { componentId: string | null; pinId: string | null; net: string | null }

/** The cross-probe state around the current selection. `nonce` increments for every explicit "go to" so panes center again. */
export interface ProbeState {
  origin: SelectionOrigin;
  nonce: number;
  /** What the schematic viewer shows/selects (set when a unique target exists or the user chose one candidate). */
  schematic: { documentId: string; instancePath: string; selection: SchematicSelection } | null;
  /** Board → schematic resolution of the selected board part, whoever made the selection (null only when no part is selected or no schematic is attached); `ambiguous` means the UI must offer `chooseSchematicTarget`. */
  schematicMapping: Mapping<SchematicTarget> | null;
  /** Schematic → board resolution of the current schematic selection (ambiguous → `chooseBoardTarget`). */
  boardMapping: Mapping<BoardTarget> | null;
  /** The reference the document panes should look for (exact selected reference, if any). */
  documentRef: string | null;
  /** Net-only board selection → schematic nets. `ambiguous` (several schematic nets carry the name) needs `chooseSchematicNet`; `missing` is explained, never guessed. */
  schematicNetMapping: Mapping<SchematicNetTarget> | null;
  /** Schematic net selection → board nets. `ambiguous` needs `chooseBoardNet`. */
  boardNetMapping: Mapping<BoardNetTarget> | null;
}

export interface SearchState {
  query: string;
  /** null while the query is empty. Built only from committed text (never from IME composition). */
  result: SearchResult | null;
  pending: boolean;
}

export type NoticeKind = 'info' | 'success' | 'error';
export interface Notice { id: number; kind: NoticeKind; message: Message }

export interface SaveState { dirty: boolean; saving: boolean; failure: string | null }

/** An encrypted board waiting for its key (the same payload is re-parsed once a key is entered; keys are session-only). */
export interface KeyRequest { fileName: string; kind: 'fz' | 'xzz'; code: 'KEY_REQUIRED' | 'INVALID_KEY'; message: string }
/** How far the parser of the running import got. */
export interface ImportProgress {
  /** 0..1 when the parser reports its position (GenCAD, KiCad), else null (the UI shows no percentage). */
  fraction: number | null;
  /** The watchdog saw no progress for a while (DEFAULT_PARSE_WATCHDOG.stallMs): the UI says the file takes unusually long. */
  stalled: boolean;
}
export interface ImportState {
  /** 'reading' = native/browser file read, 'processing' = parser worker running. */
  phase: 'idle' | 'reading' | 'processing';
  keyRequest: KeyRequest | null;
  recents: RecentFile[];
  /** Original-file identity of the open board (null without a board). */
  file: { name: string; path: string; key: string } | null;
  /** Set while `phase` is 'processing' (null otherwise). */
  progress: ImportProgress | null;
}

export interface WorkspaceState {
  /** Null until a board is loaded. All other workspace data belongs to exactly this board (its identity key). */
  board: Board | null;
  /**
   * The shared, immutable index of `board` (src/lib/board-index.ts; the same object `boardIndexOf(board)` returns): O(1) lookups of parts,
   * pads and nets, part kinds and per-side buckets. Null without a board. Components look parts up here instead of scanning `board`.
   */
  boardIndex: BoardIndex | null;
  boardKey: string | null;
  boardPath: string;
  /** Workspace manifest of the current board; null when no board or in the browser fallback (no persistence). */
  manifest: WorkspaceManifest | null;
  activeTab: WorkspaceTab;
  split: WorkspaceSplit;
  documents: DocumentRuntime[];
  /** Notes of the current board as stored: one per part or pin key, plus any that could not be placed (see `unresolvedNotes` in lib/note-keys.ts). */
  notes: BoardNote[];
  notesBlocked: Message | null;
  save: SaveState;
  selection: BoardSelectionState;
  probe: ProbeState;
  search: SearchState;
  /** Board ↔ schematic comparison for every ready schematic (null without one). */
  link: LinkReport | null;
  /** PDF cross-reference results per document (links per ref/net with explicit duplicate/ambiguity status). */
  pdfLinks: Record<string, PdfLinkReport>;
  overlays: Record<string, DocumentOverlay>;
  notices: Notice[];
  /** The Documents tab / panels use it to show the first-run empty state. */
  persistence: 'native' | 'session-only';
  import: ImportState;
}

/** Actions available to the UI. IDs are `DocumentRecord.id` (documents) or Board ids (components/pins). */
export interface WorkspaceActions {
  // --- board lifecycle (the core owns the whole import pipeline: dialogs, drops, recents, worker, keys, startup, external opens) ---
  openBoard(): Promise<void>;
  openRecent(path: string): Promise<void>;
  /** Drag-and-drop or a browser file input: the native process reads a dropped path (and its companions); the browser gets the files. */
  openDropped(files: File[]): Promise<void>;
  /** Re-parses the waiting encrypted board with a key typed by the user (validated by `validateKeyText` in src/app/keys.ts); keys never persist. */
  submitKey(text: string): void;
  cancelKeyRequest(): void;
  /** Stops the running import (read or parse); the previous board, if any, stays open. A notice says it was cancelled. */
  cancelImport(): void;
  closeBoard(): void;

  // --- navigation / layout (persisted in the manifest) ---
  setActiveTab(tab: WorkspaceTab): void;
  setSplit(patch: { enabled?: boolean; ratio?: number; right?: WorkspaceSplit['right'] }): void;
  /** Persists the camera of 'board' or a document id (viewers call it rAF-throttled). */
  setCamera(source: string, camera: ViewerCamera): void;
  cameraOf(source: string): ViewerCamera;

  // --- documents ---
  /** Native multi-select dialog (browser: file input). Duplicate bytes attach once. */
  attachDocuments(kinds?: DocumentKind[]): Promise<void>;
  /** Drag-and-drop / browser files / native paths. */
  attachFiles(files: File[]): Promise<void>;
  removeDocument(id: string): void;
  /** Pick a replacement file; accepted only when its SHA-256 equals the remembered key, else a mismatch notice (nothing changes). */
  relinkDocument(id: string): Promise<void>;
  /** The file at the path changed: adopt the new bytes (keeps bookmarks/annotations, drops calibration). Explicit user action only. */
  acceptChangedDocument(id: string): Promise<void>;
  setBookmarks(id: string, next: DocumentBookmark[]): void;
  setAnnotations(id: string, next: DocumentAnnotation[]): void;
  /** Only ever called from a completed, user-confirmed calibration. */
  setCalibration(id: string, next: DocumentCalibration | undefined): void;
  /** Saves first, then exports ONLY the listed documents (and the board/notes only when asked). Resolves null on cancel. */
  exportWorkspace(options: { documentIds: string[]; includeBoard: boolean; includeNotes: boolean }): Promise<WorkspaceExportResult | null>;

  // --- selection / cross-probe ---
  selectComponent(id: string | null, options?: { center?: boolean; origin?: SelectionOrigin }): void;
  /** Keeps the physical pad's side; never flips the board side because of the parent (B21). */
  selectPin(id: string, options?: { center?: boolean; origin?: SelectionOrigin }): void;
  selectNet(name: string | null, origin?: SelectionOrigin): void;
  selectSchematicSymbol(target: { documentId: string; instancePath: string; symbolId: string; ref: string }): void;
  selectSchematicPin(target: { documentId: string; instancePath: string; symbolId: string; pinId: string; ref: string; pinNumber: string }): void;
  selectSchematicNet(documentId: string, netId: string | null): void;
  /** Resolve an `ambiguous` mapping by explicit choice (index into `mapping.candidates`). */
  chooseSchematicTarget(index: number): void;
  chooseBoardTarget(index: number): void;
  /** Resolve an ambiguous NET mapping (index into `schematicNetMapping.candidates` / `boardNetMapping.candidates`). */
  chooseSchematicNet(index: number): void;
  chooseBoardNet(index: number): void;
  /** Click on a cross-reference region of a document pane: selects the linked board part/net (explicit choice for duplicates). */
  activateProbeRegion(documentId: string, regionId: string): void;
  setSchematicInstance(documentId: string, instancePath: string): void;
  clearSelection(): void;
  setAlias(kind: 'refs' | 'nets', from: string, to: string): void;
  removeAlias(kind: 'refs' | 'nets', from: string): void;

  // --- unified search ---
  setSearchQuery(query: string): void;
  /** Row activation: selects/centers on the board and opens the matching schematic sheet or document page. */
  activateSearchRow(row: SearchRow): void;

  // --- notes (technician records, never inferred measurements) ---
  /** `target` names the part or pad by this session's board ids; the note is stored under its key (reference and pin number). */
  upsertNote(target: NoteSubject, patch: NotePatch): Promise<void>;
  /** Deletes one stored note by id, whether or not it is attached to a part (the way an unresolved note is removed). */
  removeNote(id: string): Promise<void>;
  retryNotes(): Promise<void>;

  // --- misc ---
  dismissNotice(id: number): void;
}

/** Everything the UI subscribes to. `statusStore` is separate on purpose (P01). */
export interface WorkspaceApi {
  state: WorkspaceState;
  actions: WorkspaceActions;
  /** Derived schematic sheet list for navigation without re-deriving it in the UI. */
  sheetsOf(documentId: string): SchSheetInstance[];
  /** Pointer-rate canvas status for the status bar only (P01); give `statusStore.publish` to BoardCanvas as onStatusChange. */
  statusStore: StatusStore;
}

/** External store for pointer-rate canvas status: a `useSyncExternalStore`-compatible source only the status bar reads. */
export interface StatusSnapshot {
  zoom: number;
  x: number;
  y: number;
  rotation: number;
  measurement: number | null;
  /** Geometry/unit/source label for the status area, e.g. "KiCad PCB · mm · real geometry". */
  source: string;
}
export interface StatusStore {
  getSnapshot(): StatusSnapshot;
  subscribe(listener: () => void): () => void;
  /** Called by the canvas at pointer rate; the store dedupes by displayed precision before notifying. */
  publish(next: Omit<StatusSnapshot, 'source'>): void;
  setSource(source: string): void;
}
