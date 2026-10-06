/**
 * Document and workspace contracts shared by the native process (electron/documents.cjs, electron/workspace.cjs),
 * the renderer workspace model (src/lib/workspace.ts) and every viewer. The native twin validators enforce exactly
 * these shapes and bounds (see LIMITS in electron/workspace.cjs); change both together.
 */

export type DocumentKind = 'pdf' | 'image' | 'schematic';
export type WorkspaceTab = 'board' | 'schematic' | 'documents';

/** A document file read natively: absolute local path, sniffed by content (never by extension alone), hashed over the ORIGINAL bytes. */
export interface DocumentPayload {
  name: string;
  /** Canonical absolute path ('' in the browser fallback, where only the File object exists). */
  path: string;
  kind: DocumentKind;
  /** Content format found by sniffing: 'pdf' | 'png' | 'jpeg' | 'webp' | 'svg' | 'kicad_sch' | 'eeschema' | 'eagle' | 'eeschema-lib'. */
  format: string;
  data: Uint8Array;
  /** SHA-256 hex of `data` (the robust identity of a document). */
  key: string;
  size: number;
  /** kind 'schematic' only: sibling schematic/library files of the SAME directory (lowercase basename keys), bounded in count and bytes. */
  companions?: Record<string, Uint8Array>;
  /** Siblings that were not loaded and why (limits, links leaving the directory...). */
  skipped?: Array<{ name: string; reason: string }>;
}

export interface DocumentBookmark { id: string; page: number; label: string; x?: number; y?: number }
export interface DocumentAnnotation { id: string; page: number; x: number; y: number; text: string; updatedAt: string }
/** User-confirmed physical scale of an image. Only ever created from an explicit two-point calibration with a known distance. */
export interface DocumentCalibration { pixelsPerMm: number; confirmed: true }
/**
 * Stored view of one source. For a document: page/zoom/rotation/x/y as the viewers define them. For the BOARD (key 'board'):
 * zoom = canvas scale in CSS px per mm, x/y = the board point (mm, canonical Y-up) at the viewport centre, rotation in degrees,
 * and `side` = the viewed side, because a mirrored bottom view cannot be restored from the numbers alone.
 * `fit` (documents only) is the fit mode the user asked for ('none' once zoomed manually): a fitted zoom depends on the pane size,
 * so it is restored as the MODE (the viewer recomputes the zoom) and only a 'none' camera restores its zoom verbatim (W-win-viewers-01).
 */
export type DocumentCameraFit = 'width' | 'page' | 'none';
export interface DocumentCamera { page?: number; zoom?: number; rotation?: number; x?: number; y?: number; fit?: DocumentCameraFit; side?: 'top' | 'bottom' }

export interface DocumentRecord {
  /** Stable workspace-local id (uuid), independent of path and content. */
  id: string;
  kind: DocumentKind;
  name: string;
  /** Absolute path last seen. */
  path: string;
  /** Path relative to the board file's directory when the document lives below/beside it (portable workspaces). */
  relativePath?: string;
  /** SHA-256 hex of the file bytes when attached (identity used to verify, relink and detect edits). */
  key: string;
  size: number;
  pageCount?: number;
  bookmarks: DocumentBookmark[];
  annotations: DocumentAnnotation[];
  addedAt: string;
  calibration?: DocumentCalibration;
  /** Set by the loader, persisted only as a hint: the file could not be found at its path or relative path. */
  missing?: boolean;
}

export interface WorkspaceSplit {
  enabled: boolean;
  /** Fraction of the width given to the board pane, clamped to 0.2..0.8. */
  ratio: number;
  right: { kind: 'schematic' | 'document'; id: string } | null;
}

/** Technician-confirmed associations; both directions stay reversible and apply only to this board's workspace. */
export interface WorkspaceAliases {
  /** schematic reference → board reference (explicit ref aliasing, e.g. "U1A" → "U1"). */
  refs: Record<string, string>;
  /** schematic net name → board net name, confirmed by the user. */
  nets: Record<string, string>;
}

export interface WorkspaceManifest {
  version: 1;
  board: { key: string; name: string; path: string; format: string };
  documents: DocumentRecord[];
  split: WorkspaceSplit;
  activeTab: WorkspaceTab;
  /** Camera per source: the key 'board' or a document id. */
  cameras: Record<string, DocumentCamera>;
  aliases?: WorkspaceAliases;
  updatedAt: string;
}

/** Result of re-finding a remembered document. 'moved' = found through the relative path; 'changed' = found but the bytes differ. */
export interface DocumentLocateRequest { id: string; kind: DocumentKind; path: string; relativePath?: string; key: string }
export interface DocumentLocateResult {
  id: string;
  status: 'ok' | 'moved' | 'changed' | 'missing' | 'unreadable';
  /** Canonical path found (ok/moved/changed). */
  path?: string;
  /** Relative path to store when the file lives inside the board's directory tree. */
  relativePath?: string;
  /** Actual SHA-256 of the file found; equals the request key for ok/moved. */
  key?: string;
  size?: number;
  message?: string;
}

export interface WorkspaceExportRequest {
  boardKey: string;
  /** ONLY these documents are written to the bundle; nothing else is ever included implicitly. */
  documentIds: string[];
  /** The board file itself is included only when the user explicitly ticks it. */
  includeBoard: boolean;
  includeNotes: boolean;
}
export interface WorkspaceExportResult { path: string; files: number; bytes: number }

/** Bounds shared with electron/workspace.cjs. */
export const WORKSPACE_LIMITS = Object.freeze({
  documents: 200, bookmarks: 2000, annotations: 2000, cameras: 256, notes: 500, aliases: 1000,
  text: 8000, id: 128, measurement: 64, pathLength: 32767,
  /** Longest alias / component or pin id / timestamp string, and the highest page number a manifest may hold (as in electron/workspace.cjs). */
  alias: 256, componentId: 256, timestamp: 40, page: 1_000_000,
});
