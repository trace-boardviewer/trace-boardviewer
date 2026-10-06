import type { Language, ParseIssue } from './i18n';
import type { DocumentKind, DocumentLocateRequest, DocumentLocateResult, DocumentPayload, WorkspaceExportRequest, WorkspaceExportResult, WorkspaceManifest } from './documents';

export type { Language, ParseIssue };
export type BoardSide = 'top' | 'bottom' | 'both';
export type ViewSide = 'top' | 'bottom';
export interface Point { x: number; y: number }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
export interface BoardPin extends Point {
  id: string;
  componentId: string;
  number: string;
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
  id: string;
  ref: string;
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
}
/** Original bytes of the chosen file; the parser (never the transport) decides the format. */
export interface FilePayload {
  name: string;
  path: string;
  data: Uint8Array;
  /** Sidecar files from the same directory, keyed by lowercase basename (ASC trio). */
  companions?: Record<string, Uint8Array>;
  /** SHA-256 hex of the ORIGINAL bytes of the primary file: the notes identity. */
  key: string;
  startupSource?: 'argument' | 'recent';
}
/** Session-only keys for encrypted boardviews; never persisted. */
export interface ImportOptions { fzKey?: number[]; xzzKey?: string }
/** A recognized-but-unreadable file, as the parser dispatcher reports it (English text). */
export interface FormatFailure { message: string; code: string; format?: string; keyKind?: 'fz' | 'xzz' }
export interface RecentFile { name: string; path: string; openedAt: string }
/** Technician-entered record, never an inferred measurement. One note per target: (componentId) or (componentId + pinId). */
export interface BoardNote {
  id: string;
  componentId: string;
  /** BoardPin.id when the note belongs to a single pin of the component. */
  pinId?: string;
  text: string;
  /** Free-text values the technician measured, as typed ("1.8 V", "0.4 Ω"). */
  measurements?: { voltage?: string; resistance?: string; other?: string };
  updatedAt: string;
}
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
  /** Support notice: asks the main process to open one of its three fixed links (Stripe, Ko-fi, the GitHub bug report form) in the system browser. The renderer sends an id, never a URL; any other id is rejected. Optional: an older preload lacks it. */
  openSupportLink?(id: 'stripe' | 'kofi' | 'bug'): Promise<void>;
  /** Update notification: one request from the main process to the GitHub releases API (never from the renderer). Never rejects for network reasons: any failure is { status: 'unavailable' }. Optional: an older preload lacks it. */
  checkForUpdates?(): Promise<UpdateCheckResult>;
  /** Opens the release page of the version the last check reported, in the system browser. Takes no argument: the main process remembers the validated tag, the renderer never sends a URL. Rejects when no update was found. Optional: an older preload lacks it. */
  openUpdatePage?(): Promise<void>;
}
declare global { interface Window { traceDesktop?: TraceDesktop } }
