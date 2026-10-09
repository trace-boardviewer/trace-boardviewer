/**
 * Renderer-side workspace model: pure TypeScript (no React, no Electron) so that it is testable in node.
 *
 *  - validators that mirror electron/workspace.cjs bound for bound (same codes, messages and field order;
 *    src/lib/workspace.test.ts feeds both implementations the same corpus),
 *  - the canonical board identity key (parity with electron/identity.cjs),
 *  - immutable manifest operations (each returns the SAME object when nothing changes, so callers can
 *    skip a save by reference comparison), portable board-relative paths and note helpers,
 *  - a serialized, latest-wins persistence queue (`createWorkspaceSaver`).
 *
 * Every manifest an operation returns passes `validateManifest`; operations throw `WorkspaceError`
 * for arguments that would break a bound or an invariant instead of clamping silently.
 */
import { WORKSPACE_LIMITS } from './documents';
import type {
  DocumentAnnotation, DocumentBookmark, DocumentCalibration, DocumentCamera, DocumentKind, DocumentLocateResult,
  DocumentRecord, WorkspaceAliases, WorkspaceManifest, WorkspaceSplit, WorkspaceTab,
} from './documents';
import { isKeyedNote, noteKeyText, normalizeName, sameNoteKey } from './note-keys';
import type { BoardNote, KeyedNote, LegacyNote, NoteAnchor, NoteKey, NoteProblem } from './types';

// i18n: pending (error texts are English with a stable `code`; the catalogs are frozen)

/** Same values as LIMITS in electron/workspace.cjs (`path` = WORKSPACE_LIMITS.pathLength). */
export const WORKSPACE_MODEL_LIMITS = Object.freeze({
  documents: WORKSPACE_LIMITS.documents, bookmarks: WORKSPACE_LIMITS.bookmarks, annotations: WORKSPACE_LIMITS.annotations,
  cameras: WORKSPACE_LIMITS.cameras, notes: WORKSPACE_LIMITS.notes, aliases: WORKSPACE_LIMITS.aliases,
  text: WORKSPACE_LIMITS.text, path: WORKSPACE_LIMITS.pathLength, id: WORKSPACE_LIMITS.id, measurement: WORKSPACE_LIMITS.measurement,
  componentId: 256, alias: 256, timestamp: 40, page: 1_000_000, anchor: 1e9, ratioMin: 0.2, ratioMax: 0.8,
});
const LIMITS = WORKSPACE_MODEL_LIMITS;
const DOCUMENT_KINDS: readonly DocumentKind[] = Object.freeze(['pdf', 'image', 'schematic'] as const);
const TABS: readonly WorkspaceTab[] = Object.freeze(['board', 'schematic', 'documents'] as const);
const KEY_PATTERN = /^[a-f0-9]{64}$/;
/** The camera key of the board pane; every other camera key is a document id. */
export const BOARD_SOURCE = 'board';

export type WorkspaceErrorCode =
  | 'MANIFEST_INVALID' | 'BOARD_MISMATCH' | 'INVALID_KEY' | 'NOTES_INVALID' | 'TOO_MANY_NOTES'
  | 'LIMIT_EXCEEDED' | 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'IDENTITY_INVALID_ENTRIES' | 'IDENTITY_DUPLICATE_NAME';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  constructor(code: WorkspaceErrorCode, message: string) { super(message); this.name = 'WorkspaceError'; this.code = code; }
}
const invalid = (field: string) => new WorkspaceError('MANIFEST_INVALID', `Invalid workspace manifest: ${field}.`);
const argumentError = (message: string) => new WorkspaceError('INVALID_ARGUMENT', message);
const notFound = (what: string, id: string) => new WorkspaceError('NOT_FOUND', `Unknown ${what}: ${JSON.stringify(id)}.`);
const limitError = (what: string, max: number) => new WorkspaceError('LIMIT_EXCEEDED', `At most ${max} ${what} fit in one workspace.`);

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number, min = 0): value is string => typeof value === 'string' && value.length >= min && value.length <= max;
const isId = (value: unknown): value is string => isText(value, LIMITS.id, 1);
const isKey = (value: unknown): value is string => typeof value === 'string' && KEY_PATTERN.test(value);
const isTimestamp = (value: unknown): value is string => isText(value, LIMITS.timestamp, 1) && Number.isFinite(Date.parse(value));
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isCount = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const clampRatio = (ratio: number) => Math.min(LIMITS.ratioMax, Math.max(LIMITS.ratioMin, ratio));
// An own data property even for a key such as "__proto__" (a plain assignment would rewire the prototype).
const define = <V>(target: Record<string, V>, key: string, value: V) => { Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true }); };

// ---------------------------------------------------------------------------------------------
// Validators (mirror electron/workspace.cjs)
// ---------------------------------------------------------------------------------------------

export function validateKey(key: unknown): string {
  if (!isKey(key)) throw new WorkspaceError('INVALID_KEY', 'Invalid board key.');
  return key;
}

type BoardIdentity = WorkspaceManifest['board'];
function validateBoard(raw: unknown, field: string): BoardIdentity {
  if (!isObject(raw)) throw invalid(field);
  if (!isKey(raw.key)) throw invalid(`${field}.key`);
  if (!isText(raw.name, LIMITS.text, 1)) throw invalid(`${field}.name`);
  if (!isText(raw.path, LIMITS.path, 1)) throw invalid(`${field}.path`);
  if (!isText(raw.format, LIMITS.text, 1)) throw invalid(`${field}.format`);
  return { key: raw.key, name: raw.name, path: raw.path, format: raw.format };
}

function validateCamera(raw: unknown, field: string): DocumentCamera {
  if (!isObject(raw)) throw invalid(field);
  const camera: DocumentCamera = {};
  if (raw.page !== undefined) { if (!isCount(raw.page, LIMITS.page)) throw invalid(`${field}.page`); camera.page = raw.page; }
  if (raw.zoom !== undefined) { if (!isFiniteNumber(raw.zoom) || raw.zoom <= 0) throw invalid(`${field}.zoom`); camera.zoom = raw.zoom; }
  for (const name of ['rotation', 'x', 'y'] as const) {
    const value = raw[name];
    if (value !== undefined) { if (!isFiniteNumber(value)) throw invalid(`${field}.${name}`); camera[name] = value; }
  }
  // `fit` is a hint, not data: exactly the three modes are kept, anything else is dropped (like an unknown field) so that an
  // older or hand-edited file never invalidates the camera it sits in; the numbers then restore as a manual view (W-win-viewers-01).
  if (raw.fit === 'width' || raw.fit === 'page' || raw.fit === 'none') camera.fit = raw.fit;
  if (raw.side !== undefined) { if (raw.side !== 'top' && raw.side !== 'bottom') throw invalid(`${field}.side`); camera.side = raw.side; }
  return camera;
}

const isRightKind = (value: unknown): value is 'schematic' | 'document' => value === 'schematic' || value === 'document';
function validateSplit(raw: unknown, field: string): WorkspaceSplit {
  if (!isObject(raw)) throw invalid(field);
  if (typeof raw.enabled !== 'boolean') throw invalid(`${field}.enabled`);
  if (!isFiniteNumber(raw.ratio)) throw invalid(`${field}.ratio`);
  let right: WorkspaceSplit['right'] = null;
  if (raw.right !== null) {
    if (!isObject(raw.right) || !isRightKind(raw.right.kind)) throw invalid(`${field}.right.kind`);
    if (!isId(raw.right.id)) throw invalid(`${field}.right.id`);
    right = { kind: raw.right.kind, id: raw.right.id };
  }
  return { enabled: raw.enabled, ratio: clampRatio(raw.ratio), right };
}

/** The fields shared by a stored record and a freshly attached file (mirrors validateDocumentFields). */
export type DocumentFields = Pick<DocumentRecord, 'kind' | 'name' | 'path' | 'key' | 'size'> & Partial<Pick<DocumentRecord, 'relativePath' | 'pageCount'>>;
export function validateDocumentFields(raw: unknown, field: string): DocumentFields {
  if (!isObject(raw)) throw invalid(field);
  if (!DOCUMENT_KINDS.includes(raw.kind as DocumentKind)) throw invalid(`${field}.kind`);
  if (!isText(raw.name, LIMITS.text, 1)) throw invalid(`${field}.name`);
  if (!isText(raw.path, LIMITS.path, 1)) throw invalid(`${field}.path`);
  if (raw.relativePath !== undefined && !isText(raw.relativePath, LIMITS.path, 1)) throw invalid(`${field}.relativePath`);
  if (!isKey(raw.key)) throw invalid(`${field}.key`);
  if (!isCount(raw.size, Number.MAX_SAFE_INTEGER)) throw invalid(`${field}.size`);
  if (raw.pageCount !== undefined && (!isCount(raw.pageCount, LIMITS.page) || raw.pageCount < 1)) throw invalid(`${field}.pageCount`);
  const document: DocumentFields = { kind: raw.kind as DocumentKind, name: raw.name, path: raw.path, key: raw.key, size: raw.size };
  if (raw.relativePath !== undefined) document.relativePath = raw.relativePath as string;
  if (raw.pageCount !== undefined) document.pageCount = raw.pageCount as number;
  return document;
}

function validateBookmark(raw: unknown, at: string, seen?: Set<string>): DocumentBookmark {
  if (!isObject(raw)) throw invalid(at);
  if (!isId(raw.id) || seen?.has(raw.id)) throw invalid(`${at}.id`);
  seen?.add(raw.id);
  if (!isCount(raw.page, LIMITS.page)) throw invalid(`${at}.page`);
  if (!isText(raw.label, LIMITS.text)) throw invalid(`${at}.label`);
  const result: DocumentBookmark = { id: raw.id, page: raw.page, label: raw.label };
  for (const name of ['x', 'y'] as const) {
    const value = raw[name];
    if (value !== undefined) { if (!isFiniteNumber(value)) throw invalid(`${at}.${name}`); result[name] = value; }
  }
  return result;
}

function validateAnnotation(raw: unknown, at: string, seen?: Set<string>): DocumentAnnotation {
  if (!isObject(raw)) throw invalid(at);
  if (!isId(raw.id) || seen?.has(raw.id)) throw invalid(`${at}.id`);
  seen?.add(raw.id);
  if (!isCount(raw.page, LIMITS.page)) throw invalid(`${at}.page`);
  if (!isFiniteNumber(raw.x)) throw invalid(`${at}.x`);
  if (!isFiniteNumber(raw.y)) throw invalid(`${at}.y`);
  if (!isText(raw.text, LIMITS.text)) throw invalid(`${at}.text`);
  if (!isTimestamp(raw.updatedAt)) throw invalid(`${at}.updatedAt`);
  return { id: raw.id, page: raw.page, x: raw.x, y: raw.y, text: raw.text, updatedAt: raw.updatedAt };
}

function validateCalibration(raw: unknown, field: string): DocumentCalibration {
  if (!isObject(raw) || !isFiniteNumber(raw.pixelsPerMm) || raw.pixelsPerMm <= 0 || raw.confirmed !== true) throw invalid(field);
  return { pixelsPerMm: raw.pixelsPerMm, confirmed: true };
}

function validateDocument(raw: unknown, field: string): DocumentRecord {
  const fields = validateDocumentFields(raw, field);
  const item = raw as Obj;
  if (!isId(item.id) || item.id === BOARD_SOURCE) throw invalid(`${field}.id`); // reserved camera key of the board itself (B41)
  if (!Array.isArray(item.bookmarks) || item.bookmarks.length > LIMITS.bookmarks) throw invalid(`${field}.bookmarks`);
  if (!Array.isArray(item.annotations) || item.annotations.length > LIMITS.annotations) throw invalid(`${field}.annotations`);
  if (!isTimestamp(item.addedAt)) throw invalid(`${field}.addedAt`);
  if (item.missing !== undefined && typeof item.missing !== 'boolean') throw invalid(`${field}.missing`);
  const bookmarkIds = new Set<string>();
  const bookmarks = item.bookmarks.map((bookmark: unknown, index: number) => validateBookmark(bookmark, `${field}.bookmarks[${index}]`, bookmarkIds));
  const annotationIds = new Set<string>();
  const annotations = item.annotations.map((annotation: unknown, index: number) => validateAnnotation(annotation, `${field}.annotations[${index}]`, annotationIds));
  const document: DocumentRecord = { id: item.id, ...fields, bookmarks, annotations, addedAt: item.addedAt };
  if (item.calibration !== undefined) document.calibration = validateCalibration(item.calibration, `${field}.calibration`);
  if (item.missing !== undefined) document.missing = item.missing;
  return document;
}

function validateAliasMap(raw: unknown, field: string): Record<string, string> {
  if (!isObject(raw)) throw invalid(field);
  const keys = Object.keys(raw);
  if (keys.length > LIMITS.aliases) throw invalid(field);
  const map: Record<string, string> = {};
  keys.forEach((key, index) => {
    const value = raw[key];
    if (!isText(key, LIMITS.alias)) throw invalid(`${field}[${index}]`);
    if (!isText(value, LIMITS.alias)) throw invalid(`${field}[${index}]`);
    define(map, key, value);
  });
  return map;
}

function validateAliases(raw: unknown, field: string): WorkspaceAliases {
  if (!isObject(raw)) throw invalid(field);
  return { refs: validateAliasMap(raw.refs, `${field}.refs`), nets: validateAliasMap(raw.nets, `${field}.nets`) };
}

/**
 * Strict, bounded manifest validation. Unknown fields are dropped; anything invalid throws.
 * A manifest saved for another board is rejected so that it can never be attached by accident.
 */
export function validateManifest(raw: unknown, expectedBoardKey: string): WorkspaceManifest {
  validateKey(expectedBoardKey);
  if (!isObject(raw)) throw invalid('manifest');
  if (raw.version !== 1) throw invalid('version');
  const board = validateBoard(raw.board, 'board');
  if (board.key !== expectedBoardKey) throw new WorkspaceError('BOARD_MISMATCH', 'The workspace belongs to another board.');
  if (!Array.isArray(raw.documents) || raw.documents.length > LIMITS.documents) throw invalid('documents');
  const ids = new Set<string>();
  const documents = raw.documents.map((item: unknown, index: number) => {
    const document = validateDocument(item, `documents[${index}]`);
    if (ids.has(document.id)) throw invalid(`documents[${index}].id`);
    ids.add(document.id);
    return document;
  });
  const split = validateSplit(raw.split, 'split');
  if (!TABS.includes(raw.activeTab as WorkspaceTab)) throw invalid('activeTab');
  if (!isObject(raw.cameras)) throw invalid('cameras');
  const cameraKeys = Object.keys(raw.cameras);
  if (cameraKeys.length > LIMITS.cameras) throw invalid('cameras');
  const cameras: Record<string, DocumentCamera> = {};
  for (const key of cameraKeys) {
    if (!isId(key)) throw invalid(`cameras[${JSON.stringify(key)}]`);
    define(cameras, key, validateCamera(raw.cameras[key], `cameras[${JSON.stringify(key)}]`));
  }
  const aliases = raw.aliases === undefined ? undefined : validateAliases(raw.aliases, 'aliases');
  if (!isTimestamp(raw.updatedAt)) throw invalid('updatedAt');
  return { version: 1, board, documents, split, activeTab: raw.activeTab as WorkspaceTab, cameras, ...(aliases ? { aliases } : {}), updatedAt: raw.updatedAt };
}

type NoteMeasurements = NonNullable<BoardNote['measurements']>;
const MEASUREMENT_FIELDS = ['voltage', 'resistance', 'other'] as const;

/** Same list as NOTE_PROBLEMS in electron/workspace.cjs (and the NoteProblem union in types.ts). */
const NOTE_PROBLEMS: readonly NoteProblem[] = Object.freeze([
  'component-missing', 'component-ambiguous', 'pin-missing', 'pin-ambiguous', 'legacy-id-missing', 'legacy-indistinguishable', 'legacy-order-unknown', 'duplicate-target',
] as const);

/** A reference or pin number as a key holds it: NFKC and trim, 1 to 256 characters (null when it is none). */
function validateNoteName(value: unknown): string | null {
  if (!isText(value, LIMITS.componentId, 1)) return null;
  const name = normalizeName(value);
  return name.length >= 1 && name.length <= LIMITS.componentId ? name : null;
}
function validateNoteAnchor(raw: unknown, bad: (field: string) => WorkspaceError, field: string): NoteAnchor {
  if (!isObject(raw)) throw bad(field);
  if (raw.side !== 'top' && raw.side !== 'bottom' && raw.side !== 'both') throw bad(`${field}.side`);
  if (!isFiniteNumber(raw.x) || Math.abs(raw.x) > LIMITS.anchor) throw bad(`${field}.x`);
  if (!isFiniteNumber(raw.y) || Math.abs(raw.y) > LIMITS.anchor) throw bad(`${field}.y`);
  // `+ 0` turns a rounded -0 into 0, so a stored position never prints as "-0".
  return { side: raw.side, x: Math.round(raw.x * 1000) / 1000 + 0, y: Math.round(raw.y * 1000) / 1000 + 0 };
}
/** Strict, canonical form of a stored key: names normalized, anchors rounded to 1 um, unknown fields dropped, a reference or an anchor required. */
function validateNoteKey(raw: unknown, bad: (field: string) => WorkspaceError): NoteKey {
  if (!isObject(raw)) throw bad('target');
  const key: NoteKey = {};
  if (raw.ref !== undefined) { const ref = validateNoteName(raw.ref); if (ref === null) throw bad('target.ref'); key.ref = ref; }
  if (raw.at !== undefined) key.at = validateNoteAnchor(raw.at, bad, 'target.at');
  if (key.ref === undefined && key.at === undefined) throw bad('target');
  if (raw.pin !== undefined) { const pin = validateNoteName(raw.pin); if (pin === null) throw bad('target.pin'); key.pin = pin; }
  if (raw.pinAt !== undefined) {
    if (key.pin !== undefined) throw bad('target.pinAt');
    key.pinAt = validateNoteAnchor(raw.pinAt, bad, 'target.pinAt');
  }
  return key;
}

/**
 * Notes: same limits as the native validator plus the pin-note fields. A note names its target either by a key (`target`, see
 * note-keys.ts) or, when it was written before keys existed, by the importer's positional ids (`componentId` and `pinId`, with an
 * `unresolved` record once a migration could not place it); both kinds may share one list. One note per target is an invariant
 * (B15): duplicates are malformed input and are rejected, never merged.
 */
export function validateNotes(raw: unknown): BoardNote[] {
  if (!Array.isArray(raw)) throw new WorkspaceError('NOTES_INVALID', 'Invalid notes: not a list.');
  if (raw.length > LIMITS.notes) throw new WorkspaceError('TOO_MANY_NOTES', `Invalid notes: at most ${LIMITS.notes} notes can be saved for one board.`);
  const ids = new Set<string>();
  const targets = new Set<string>();
  return raw.map((note: unknown, index: number) => {
    const bad = (field: string) => new WorkspaceError('NOTES_INVALID', `Invalid notes: notes[${index}].${field}.`);
    if (!isObject(note)) throw new WorkspaceError('NOTES_INVALID', `Invalid notes: notes[${index}].`);
    if (!isId(note.id)) throw bad('id');
    if (ids.has(note.id)) throw bad('id (duplicate)');
    let key: NoteKey | undefined;
    if (note.target !== undefined) {
      if (note.componentId !== undefined || note.pinId !== undefined || note.unresolved !== undefined) throw bad('target (a note has a target or a componentId, not both)');
      key = validateNoteKey(note.target, bad);
    } else {
      if (!isText(note.componentId, LIMITS.componentId, 1)) throw bad('componentId');
      if (note.pinId !== undefined && !isText(note.pinId, LIMITS.componentId, 1)) throw bad('pinId');
    }
    if (!isText(note.text, LIMITS.text)) throw bad('text');
    if (!isTimestamp(note.updatedAt)) throw bad('updatedAt');
    let unresolved: LegacyNote['unresolved'];
    if (!key && note.unresolved !== undefined) {
      if (!isObject(note.unresolved) || !NOTE_PROBLEMS.includes(note.unresolved.reason as NoteProblem) || !isTimestamp(note.unresolved.at)) throw bad('unresolved');
      unresolved = { reason: note.unresolved.reason as NoteProblem, at: note.unresolved.at };
    }
    const target = key ? `K\0${noteKeyText(key)}` : `L\0${note.componentId}\0${note.pinId === undefined ? '' : note.pinId}`;
    if (targets.has(target)) throw bad(key ? 'target (duplicate note for this target)' : note.pinId === undefined ? 'componentId (duplicate note for this component)' : 'pinId (duplicate note for this pin)');
    ids.add(note.id);
    targets.add(target);
    let result: BoardNote;
    if (key) result = { id: note.id, target: key, text: note.text, updatedAt: note.updatedAt };
    else {
      const legacy: LegacyNote = { id: note.id, componentId: note.componentId as string, text: note.text, updatedAt: note.updatedAt };
      if (note.pinId !== undefined) legacy.pinId = note.pinId as string;
      if (unresolved) legacy.unresolved = unresolved;
      result = legacy;
    }
    if (note.measurements !== undefined) {
      if (!isObject(note.measurements)) throw bad('measurements');
      const measurements: NoteMeasurements = {};
      for (const name of MEASUREMENT_FIELDS) {
        const value = note.measurements[name];
        if (value !== undefined) {
          if (!isText(value, LIMITS.measurement)) throw bad(`measurements.${name}`);
          measurements[name] = value;
        }
      }
      if (Object.keys(measurements).length > 0) result.measurements = measurements;
    }
    return result;
  });
}

// ---------------------------------------------------------------------------------------------
// Board identity key (B32)
// ---------------------------------------------------------------------------------------------

export interface IdentityEntry { name: string; data: ArrayBufferView }

const MAX_IDENTITY_ENTRIES = 64;
const toHex = (digest: ArrayBuffer) => Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
const baseName = (name: string) => name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).toLowerCase();
const identityError = (code: 'IDENTITY_INVALID_ENTRIES' | 'IDENTITY_DUPLICATE_NAME', message: string) => new WorkspaceError(code, message);

/**
 * Canonical identity of a board (same rules and error codes as `boardKey` in electron/identity.cjs).
 * One file: plain SHA-256 of its bytes (existing notes keep working). Several files (ASC trio): SHA-256 over the
 * COMPLETE set sorted by lowercase basename, each entry encoded as `utf8(name) 0x00 uint64be(byteLength) bytes`, so
 * the key does not depend on which entry file was picked and changes when any file of the set changes. The length
 * prefix keeps entry boundaries unambiguous.
 */
export async function boardIdentityKey(entries: ReadonlyArray<IdentityEntry>): Promise<string> {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_IDENTITY_ENTRIES) {
    throw identityError('IDENTITY_INVALID_ENTRIES', `A board identity needs between 1 and ${MAX_IDENTITY_ENTRIES} files.`);
  }
  const encoder = new TextEncoder();
  const named = entries.map(entry => {
    if (!entry || typeof entry.name !== 'string' || !ArrayBuffer.isView(entry.data)) throw identityError('IDENTITY_INVALID_ENTRIES', 'Invalid board file entry.');
    const name = baseName(entry.name);
    if (!name) throw identityError('IDENTITY_INVALID_ENTRIES', 'Invalid board file entry name.');
    const { buffer, byteOffset, byteLength } = entry.data;
    return { name, bytes: encoder.encode(name), data: new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength) };
  });
  if (named.length === 1) return toHex(await crypto.subtle.digest('SHA-256', named[0].data as Uint8Array<ArrayBuffer>));
  named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let index = 1; index < named.length; index += 1) {
    if (named[index].name === named[index - 1].name) throw identityError('IDENTITY_DUPLICATE_NAME', 'Two board files share one name.');
  }
  const total = named.reduce((sum, entry) => sum + entry.bytes.byteLength + 1 + 8 + entry.data.byteLength, 0);
  const joined = new Uint8Array(total);
  const view = new DataView(joined.buffer);
  let offset = 0;
  for (const entry of named) {
    joined.set(entry.bytes, offset); offset += entry.bytes.byteLength;
    joined[offset] = 0; offset += 1;
    view.setBigUint64(offset, BigInt(entry.data.byteLength), false); offset += 8;
    joined.set(entry.data, offset); offset += entry.data.byteLength;
  }
  return toHex(await crypto.subtle.digest('SHA-256', joined));
}

// ---------------------------------------------------------------------------------------------
// Portable paths
// ---------------------------------------------------------------------------------------------

interface AbsolutePath { windows: boolean; root: string; segments: string[] }

/** Local absolute paths only (drive-letter or POSIX); UNC, relative, `.`/`..` segments, NUL and trailing separators are rejected. */
function parseAbsolute(path: unknown): AbsolutePath | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > LIMITS.path || path.includes('\0')) return null;
  let windows: boolean;
  let root: string;
  let rest: string;
  if (/^[A-Za-z]:[\\/]/.test(path)) { windows = true; root = path.slice(0, 2); rest = path.slice(3); }
  else if (path.startsWith('/') && !path.startsWith('//')) { windows = false; root = '/'; rest = path.slice(1); }
  else return null;
  const separator = windows ? /[\\/]/ : /\//;
  if (separator.test(rest.slice(-1))) return null;
  const segments = rest.split(windows ? /[\\/]+/ : /\/+/).filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..')) return null;
  return { windows, root, segments };
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** A segment that means the same thing on every platform and can neither escape the directory nor name a device. */
function portableSegment(segment: string, windows: boolean): boolean {
  if (segment.length === 0 || segment === '.' || segment === '..' || /[\\/\u0000-\u001f]/.test(segment)) return false;
  if (!windows) return true;
  return !/[<>:"|?*]/.test(segment) && !/[. ]$/.test(segment) && !WINDOWS_RESERVED.test(segment);
}
/** Every segment portable, and the first one cannot pass for a drive ("C:") on a POSIX board path. */
const portablePath = (segments: string[], windows: boolean) =>
  segments.every(segment => portableSegment(segment, windows)) && !/^[A-Za-z]:/.test(segments[0] ?? '');
const sameSegment = (a: string, b: string, windows: boolean) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Path of `docPath` relative to the directory of `boardPath`, with '/' separators, only when the document lies
 * inside that directory tree (beside or below the board file; never through `..`). Windows paths compare
 * case-insensitively. `null` when the document is elsewhere, the styles differ or a segment would not be portable.
 */
export function relativeToBoard(boardPath: string, docPath: string): string | null {
  const board = parseAbsolute(boardPath);
  const doc = parseAbsolute(docPath);
  if (!board || !doc || board.windows !== doc.windows || board.segments.length === 0) return null;
  if (board.windows && board.root.toLowerCase() !== doc.root.toLowerCase()) return null;
  const directory = board.segments.slice(0, -1);
  if (doc.segments.length <= directory.length) return null;
  if (!directory.every((segment, index) => sameSegment(segment, doc.segments[index], board.windows))) return null;
  const relative = doc.segments.slice(directory.length);
  return portablePath(relative, board.windows) ? relative.join('/') : null;
}

/** Inverse of `relativeToBoard`: absolute path of a stored relative path, or `null` for anything that could leave the board directory. */
export function resolveRelative(boardPath: string, relativePath: string): string | null {
  const board = parseAbsolute(boardPath);
  if (!board || board.segments.length === 0) return null;
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > LIMITS.path) return null;
  const parts = relativePath.split('/');
  if (!portablePath(parts, board.windows)) return null;
  const separator = board.windows ? '\\' : '/';
  const resolved = [...board.segments.slice(0, -1), ...parts].join(separator);
  const absolute = board.windows ? `${board.root}\\${resolved}` : `/${resolved}`;
  return absolute.length <= LIMITS.path ? absolute : null;
}

// ---------------------------------------------------------------------------------------------
// Immutable manifest operations
// ---------------------------------------------------------------------------------------------

const omit = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};
const optionalRelative = (manifest: WorkspaceManifest, path: string) => relativeToBoard(manifest.board.path, path) ?? undefined;

function withDocument(manifest: WorkspaceManifest, id: string, change: (document: DocumentRecord) => DocumentRecord): WorkspaceManifest {
  const index = manifest.documents.findIndex(document => document.id === id);
  if (index < 0) throw notFound('document', id);
  const next = change(manifest.documents[index]);
  if (next === manifest.documents[index]) return manifest;
  const documents = manifest.documents.slice();
  documents[index] = next;
  return { ...manifest, documents };
}

/** `createManifest` needs a validated board identity; a board without a path (browser fallback) cannot own a persisted workspace. */
export function createManifest(board: BoardIdentity, now: string = new Date().toISOString()): WorkspaceManifest {
  const checked = validateBoard(board, 'board');
  if (!isTimestamp(now)) throw invalid('updatedAt');
  return { version: 1, board: checked, documents: [], split: { enabled: false, ratio: 0.5, right: null }, activeTab: 'board', cameras: {}, updatedAt: now };
}

export function touch(manifest: WorkspaceManifest, updatedAt: string): WorkspaceManifest {
  if (!isTimestamp(updatedAt)) throw invalid('updatedAt');
  return manifest.updatedAt === updatedAt ? manifest : { ...manifest, updatedAt };
}

export function setActiveTab(manifest: WorkspaceManifest, tab: WorkspaceTab): WorkspaceManifest {
  if (!TABS.includes(tab)) throw invalid('activeTab');
  return manifest.activeTab === tab ? manifest : { ...manifest, activeTab: tab };
}

/** Everything the UI needs to attach a document (a DocumentPayload minus its bytes). */
export type NewDocument = Pick<DocumentRecord, 'kind' | 'name' | 'path' | 'key' | 'size'> & Partial<Pick<DocumentRecord, 'pageCount'>>;
export interface AddDocumentResult { manifest: WorkspaceManifest; document: DocumentRecord; added: boolean }

/**
 * Attaches a file by content identity. The same SHA-256 twice yields the existing record (annotations and bookmarks
 * stay on it); when that record was flagged missing, attaching the same bytes from a new place relinks it.
 */
export function addDocument(manifest: WorkspaceManifest, input: NewDocument, now: string, newId: () => string): AddDocumentResult {
  const fields = validateDocumentFields({ ...input, relativePath: undefined }, 'document');
  const existing = manifest.documents.find(document => document.key === fields.key);
  if (existing) {
    if (!existing.missing) return { manifest, document: existing, added: false };
    const next = relinked(manifest, existing, { name: fields.name, path: fields.path, key: fields.key, size: fields.size });
    return { manifest: withDocument(manifest, existing.id, () => next), document: next, added: false };
  }
  if (manifest.documents.length >= LIMITS.documents) throw limitError('documents', LIMITS.documents);
  if (!isTimestamp(now)) throw invalid('document.addedAt');
  const id = newId();
  if (!isId(id) || id === BOARD_SOURCE || manifest.documents.some(document => document.id === id)) throw invalid('document.id');
  const relativePath = optionalRelative(manifest, fields.path);
  const document: DocumentRecord = { id, ...fields, bookmarks: [], annotations: [], addedAt: now };
  if (relativePath) document.relativePath = relativePath;
  return { manifest: { ...manifest, documents: [...manifest.documents, document] }, document, added: true };
}

/** Removes a document with everything that references it (split pane, camera). Notes live elsewhere and are untouched. */
export function removeDocument(manifest: WorkspaceManifest, id: string): WorkspaceManifest {
  if (!manifest.documents.some(document => document.id === id)) return manifest;
  const cameras = { ...manifest.cameras };
  delete cameras[id];
  const split = manifest.split.right?.id === id ? { ...manifest.split, right: null } : manifest.split;
  return { ...manifest, documents: manifest.documents.filter(document => document.id !== id), split, cameras };
}

/** Drops references to documents that no longer exist (split pane, cameras): a loaded manifest may be stale. */
export function reconcileManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  const known = new Map(manifest.documents.map(document => [document.id, document.kind]));
  const right = manifest.split.right;
  const rightOk = !right || rightMatches(right, known.get(right.id));
  const staleCameras = Object.keys(manifest.cameras).filter(key => key !== BOARD_SOURCE && !known.has(key));
  if (rightOk && staleCameras.length === 0) return manifest;
  const cameras = { ...manifest.cameras };
  for (const key of staleCameras) delete cameras[key];
  return { ...manifest, split: rightOk ? manifest.split : { ...manifest.split, right: null }, cameras };
}

const rightMatches = (right: NonNullable<WorkspaceSplit['right']>, kind: DocumentKind | undefined) =>
  kind !== undefined && (right.kind === 'schematic' ? kind === 'schematic' : kind !== 'schematic');

export interface DocumentChange {
  id: string;
  name: string;
  /** Where the different file was found, and what it hashes to. */
  path: string;
  relativePath?: string;
  key: string;
  size: number;
  /** The key the workspace remembers for this document. */
  expectedKey: string;
}
export interface LocateOutcome {
  manifest: WorkspaceManifest;
  /** Files found whose bytes differ from the remembered ones: the UI must ask before `acceptChangedDocument`. */
  changed: DocumentChange[];
  /** Ids found at a different path than remembered (path and relative path were updated). */
  moved: string[];
  missing: string[];
  unreadable: string[];
}

/**
 * Applies the native re-find results. A file found with the same SHA-256 updates the path hints; a missing or
 * unreadable one sets the `missing` hint (never dropping notes or annotations). A file whose bytes differ NEVER
 * replaces the remembered key or annotations: it is listed in `changed`, the record keeps the `missing` hint until
 * the technician accepts the new file or relinks the original.
 */
export function applyLocateResults(manifest: WorkspaceManifest, results: readonly DocumentLocateResult[]): LocateOutcome {
  let current = manifest;
  const outcome: LocateOutcome = { manifest, changed: [], moved: [], missing: [], unreadable: [] };
  const setMissing = (document: DocumentRecord): DocumentRecord => (document.missing ? document : { ...document, missing: true });
  for (const result of results) {
    const document = isObject(result) ? current.documents.find(candidate => candidate.id === result.id) : undefined;
    if (!document) continue;
    if (result.status === 'missing') { outcome.missing.push(document.id); current = withDocument(current, document.id, setMissing); continue; }
    const found = result.status === 'ok' || result.status === 'moved' || result.status === 'changed';
    const differs = result.status === 'changed' ? result.key !== document.key : result.key !== undefined && result.key !== document.key;
    const readable = found && isText(result.path, LIMITS.path, 1) && (result.key === undefined || isKey(result.key))
      && (!differs || (isKey(result.key) && isCount(result.size, Number.MAX_SAFE_INTEGER)));
    if (!readable) { outcome.unreadable.push(document.id); current = withDocument(current, document.id, setMissing); continue; }
    const path = result.path as string;
    const relativePath = result.relativePath !== undefined && resolveRelative(current.board.path, result.relativePath) !== null ? result.relativePath : optionalRelative(current, path);
    if (differs) {
      outcome.changed.push({ id: document.id, name: document.name, path, ...(relativePath ? { relativePath } : {}), key: result.key as string, size: result.size as number, expectedKey: document.key });
      current = withDocument(current, document.id, setMissing);
      continue;
    }
    if (path !== document.path) outcome.moved.push(document.id);
    current = withDocument(current, document.id, candidate => {
      if (!candidate.missing && candidate.path === path && candidate.relativePath === relativePath) return candidate;
      const next: DocumentRecord = { ...omit(candidate, 'missing'), path };
      if (relativePath) next.relativePath = relativePath; else delete next.relativePath;
      return next;
    });
  }
  outcome.manifest = current;
  return outcome;
}

/** What a user-picked or re-found file contributes when it replaces the remembered one. */
export interface FoundFile { name?: string; path: string; relativePath?: string; key: string; size: number; pageCount?: number }

function checkFound(found: FoundFile): void {
  if (!isObject(found)) throw invalid('document');
  if (found.name !== undefined && !isText(found.name, LIMITS.text, 1)) throw invalid('document.name');
  if (!isText(found.path, LIMITS.path, 1)) throw invalid('document.path');
  if (!isKey(found.key)) throw invalid('document.key');
  if (!isCount(found.size, Number.MAX_SAFE_INTEGER)) throw invalid('document.size');
  if (found.pageCount !== undefined && (!isCount(found.pageCount, LIMITS.page) || found.pageCount < 1)) throw invalid('document.pageCount');
}

function relinked(manifest: WorkspaceManifest, document: DocumentRecord, found: FoundFile): DocumentRecord {
  const relativePath = found.relativePath !== undefined && resolveRelative(manifest.board.path, found.relativePath) !== null ? found.relativePath : optionalRelative(manifest, found.path);
  const next: DocumentRecord = { ...omit(document, 'missing'), name: found.name ?? document.name, path: found.path };
  if (relativePath) next.relativePath = relativePath; else delete next.relativePath;
  return next;
}

/** The technician confirmed that the changed file is the document: the key and size follow it, bookmarks and annotations stay. */
export function acceptChangedDocument(manifest: WorkspaceManifest, id: string, found: FoundFile): WorkspaceManifest {
  checkFound(found);
  if (manifest.documents.some(document => document.id !== id && document.key === found.key)) throw argumentError('Another document of this workspace already has this content.');
  return withDocument(manifest, id, document => {
    const next = relinked(manifest, document, found);
    next.key = found.key;
    next.size = found.size;
    // Page count and scale describe the old bytes; a calibration must never survive a different image.
    if (found.key !== document.key) { delete next.pageCount; delete next.calibration; }
    if (found.pageCount !== undefined) next.pageCount = found.pageCount;
    return next;
  });
}

export type RelinkResult =
  | { ok: true; manifest: WorkspaceManifest }
  | { ok: false; reason: 'not-found' | 'mismatch' | 'invalid'; manifest: WorkspaceManifest; actualKey?: string };

/** Relink accepts a file only when its SHA-256 equals the remembered key; otherwise it reports the mismatch and changes nothing. */
export function relinkDocument(manifest: WorkspaceManifest, id: string, payload: Pick<FoundFile, 'name' | 'path' | 'key'> & Partial<FoundFile>): RelinkResult {
  const document = manifest.documents.find(candidate => candidate.id === id);
  if (!document) return { ok: false, reason: 'not-found', manifest };
  if (!isObject(payload) || !isKey(payload.key) || !isText(payload.path, LIMITS.path, 1) || (payload.name !== undefined && !isText(payload.name, LIMITS.text, 1))) {
    return { ok: false, reason: 'invalid', manifest };
  }
  if (payload.key !== document.key) return { ok: false, reason: 'mismatch', manifest, actualKey: payload.key };
  const next = relinked(manifest, document, { ...payload, size: document.size });
  const same = !document.missing && next.name === document.name && next.path === document.path && next.relativePath === document.relativePath;
  return { ok: true, manifest: same ? manifest : withDocument(manifest, id, () => next) };
}

export function setPageCount(manifest: WorkspaceManifest, documentId: string, pageCount: number): WorkspaceManifest {
  if (!isCount(pageCount, LIMITS.page) || pageCount < 1) throw invalid('document.pageCount');
  return withDocument(manifest, documentId, document => (document.pageCount === pageCount ? document : { ...document, pageCount }));
}

export interface SplitPatch { enabled?: boolean; ratio?: number; right?: WorkspaceSplit['right'] }
/** The ratio is clamped to 0.2..0.8; the right pane must reference an existing structured schematic ('schematic') or PDF/image ('document'). */
export function setSplit(manifest: WorkspaceManifest, patch: SplitPatch): WorkspaceManifest {
  let { enabled, ratio, right } = manifest.split;
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw invalid('split.enabled');
    enabled = patch.enabled;
  }
  if (patch.ratio !== undefined) {
    if (!isFiniteNumber(patch.ratio)) throw invalid('split.ratio');
    ratio = clampRatio(patch.ratio);
  }
  if (patch.right !== undefined) {
    if (patch.right === null) right = null;
    else {
      if (!isObject(patch.right) || !isRightKind(patch.right.kind)) throw invalid('split.right.kind');
      if (!isId(patch.right.id)) throw invalid('split.right.id');
      const target = manifest.documents.find(document => document.id === (patch.right as { id: string }).id);
      if (!target) throw notFound('document', patch.right.id);
      if (!rightMatches(patch.right, target.kind)) throw argumentError(`A ${target.kind} cannot be shown as the ${patch.right.kind} pane.`);
      right = { kind: patch.right.kind, id: patch.right.id };
    }
  }
  const same = enabled === manifest.split.enabled && ratio === manifest.split.ratio && right?.id === manifest.split.right?.id && right?.kind === manifest.split.right?.kind;
  return same ? manifest : { ...manifest, split: { enabled, ratio, right } };
}

const sameCamera = (a: DocumentCamera | undefined, b: DocumentCamera) => !!a && a.page === b.page && a.zoom === b.zoom && a.rotation === b.rotation && a.x === b.x && a.y === b.y && a.fit === b.fit && a.side === b.side;

/** Replaces the camera of 'board' or of a document; `null` (or an empty camera) forgets it. */
export function setCamera(manifest: WorkspaceManifest, source: string, camera: DocumentCamera | null): WorkspaceManifest {
  if (source !== BOARD_SOURCE && !manifest.documents.some(document => document.id === source)) throw notFound('camera source', source);
  const normalized = camera === null ? {} : validateCamera(camera, `cameras[${JSON.stringify(source)}]`);
  const current = manifest.cameras[source];
  if (Object.keys(normalized).length === 0) {
    if (!current) return manifest;
    const cameras = { ...manifest.cameras };
    delete cameras[source];
    return { ...manifest, cameras };
  }
  if (sameCamera(current, normalized)) return manifest;
  if (!current && Object.keys(manifest.cameras).length >= LIMITS.cameras) throw limitError('camera positions', LIMITS.cameras);
  return { ...manifest, cameras: { ...manifest.cameras, [source]: normalized } };
}

/** Bookmark fields as the UI supplies them; the label is trimmed. */
export function upsertBookmark(manifest: WorkspaceManifest, documentId: string, bookmark: DocumentBookmark): WorkspaceManifest {
  const label = typeof bookmark?.label === 'string' ? bookmark.label.trim() : bookmark?.label;
  const next = validateBookmark({ ...bookmark, label }, 'bookmark');
  return withDocument(manifest, documentId, document => {
    const index = document.bookmarks.findIndex(candidate => candidate.id === next.id);
    if (index >= 0) {
      const old = document.bookmarks[index];
      if (old.page === next.page && old.label === next.label && old.x === next.x && old.y === next.y) return document;
      const bookmarks = document.bookmarks.slice();
      bookmarks[index] = next;
      return { ...document, bookmarks };
    }
    if (document.bookmarks.length >= LIMITS.bookmarks) throw limitError('bookmarks per document', LIMITS.bookmarks);
    return { ...document, bookmarks: [...document.bookmarks, next] };
  });
}

export function removeBookmark(manifest: WorkspaceManifest, documentId: string, bookmarkId: string): WorkspaceManifest {
  return withDocument(manifest, documentId, document => (document.bookmarks.some(bookmark => bookmark.id === bookmarkId)
    ? { ...document, bookmarks: document.bookmarks.filter(bookmark => bookmark.id !== bookmarkId) } : document));
}

/** `updatedAt` is set to `now` only when the annotation actually changes; the text is trimmed. */
export function upsertAnnotation(manifest: WorkspaceManifest, documentId: string, annotation: Omit<DocumentAnnotation, 'updatedAt'>, now: string): WorkspaceManifest {
  const text = typeof annotation?.text === 'string' ? annotation.text.trim() : annotation?.text;
  const next = validateAnnotation({ ...annotation, text, updatedAt: now }, 'annotation');
  return withDocument(manifest, documentId, document => {
    const index = document.annotations.findIndex(candidate => candidate.id === next.id);
    if (index >= 0) {
      const old = document.annotations[index];
      if (old.page === next.page && old.x === next.x && old.y === next.y && old.text === next.text) return document;
      const annotations = document.annotations.slice();
      annotations[index] = next;
      return { ...document, annotations };
    }
    if (document.annotations.length >= LIMITS.annotations) throw limitError('annotations per document', LIMITS.annotations);
    return { ...document, annotations: [...document.annotations, next] };
  });
}

export function removeAnnotation(manifest: WorkspaceManifest, documentId: string, annotationId: string): WorkspaceManifest {
  return withDocument(manifest, documentId, document => (document.annotations.some(annotation => annotation.id === annotationId)
    ? { ...document, annotations: document.annotations.filter(annotation => annotation.id !== annotationId) } : document));
}

/** A scale exists only after an explicit two-point calibration with a known distance (`confirmed: true`), and only on images. `null` clears it. */
export function setCalibration(manifest: WorkspaceManifest, documentId: string, calibration: DocumentCalibration | null): WorkspaceManifest {
  if (calibration !== null && (!isObject(calibration) || calibration.confirmed !== true)) throw argumentError('A calibration must be confirmed by the user.');
  const next = calibration === null ? null : validateCalibration(calibration, 'document.calibration');
  return withDocument(manifest, documentId, document => {
    if (next === null) return document.calibration ? omit(document, 'calibration') : document;
    if (document.kind !== 'image') throw argumentError('Only images can be calibrated.');
    return document.calibration?.pixelsPerMm === next.pixelsPerMm ? document : { ...document, calibration: next };
  });
}

export type AliasKind = keyof WorkspaceAliases;
const aliasText = (value: unknown, what: string): string => {
  const text = typeof value === 'string' ? value.trim() : value;
  if (!isText(text, LIMITS.alias, 1)) throw argumentError(`Invalid alias ${what}.`);
  return text;
};

/** Records a user-confirmed association (schematic name → board name). Never inferred; `removeAlias` undoes it. */
export function setAlias(manifest: WorkspaceManifest, kind: AliasKind, from: string, to: string): WorkspaceManifest {
  if (kind !== 'refs' && kind !== 'nets') throw argumentError('Invalid alias kind.');
  const source = aliasText(from, 'name');
  const target = aliasText(to, 'target');
  if (source === '__proto__') throw argumentError('Invalid alias name.');
  if (source === target) throw argumentError('An alias must map a name to a different name.');
  const aliases: WorkspaceAliases = manifest.aliases ?? { refs: {}, nets: {} };
  if (aliases[kind][source] === target && Object.hasOwn(aliases[kind], source)) return manifest;
  if (!Object.hasOwn(aliases[kind], source) && Object.keys(aliases[kind]).length >= LIMITS.aliases) throw limitError(`${kind} aliases`, LIMITS.aliases);
  return { ...manifest, aliases: { ...aliases, [kind]: { ...aliases[kind], [source]: target } } };
}

export function removeAlias(manifest: WorkspaceManifest, kind: AliasKind, from: string): WorkspaceManifest {
  if (kind !== 'refs' && kind !== 'nets') throw argumentError('Invalid alias kind.');
  const aliases = manifest.aliases;
  const source = typeof from === 'string' ? from.trim() : from;
  if (!aliases || !Object.hasOwn(aliases[kind], source)) return manifest;
  const map = { ...aliases[kind] };
  delete map[source];
  const next = { ...aliases, [kind]: map };
  if (Object.keys(next.refs).length === 0 && Object.keys(next.nets).length === 0) return omit(manifest, 'aliases') as WorkspaceManifest;
  return { ...manifest, aliases: next };
}

// ---------------------------------------------------------------------------------------------
// Notes helpers
// ---------------------------------------------------------------------------------------------

/** What a note is about: the key of a part or pin (note-keys.ts). Never the importer's positional ids. */
export type NoteTarget = NoteKey;
export interface NotePatch {
  text?: string;
  /** Replaces the whole set of measurements; `null` or an empty object clears it. Omit to keep the stored ones. */
  measurements?: NoteMeasurements | null;
}
const noteInvalid = (message: string) => new WorkspaceError('NOTES_INVALID', `Invalid notes: ${message}.`);

/** The canonical form of a key (names normalized, anchors rounded to 1 um). A key without reference and anchor, or with a malformed part, is an error. */
export function noteTarget(key: NoteKey): NoteTarget {
  return validateNoteKey(key, noteInvalid);
}

/** The note of exactly this target (a part note never answers for one of its pins, nor the reverse). */
export function noteFor(notes: readonly BoardNote[], target: NoteTarget): KeyedNote | undefined {
  return notes.find((note): note is KeyedNote => isKeyedNote(note) && sameNoteKey(note.target, target));
}

/** The list without the note of that id (the SAME array when there is none): how an unresolved note is deleted. */
export function removeNote(notes: BoardNote[], id: string): BoardNote[] {
  return notes.some(note => note.id === id) ? notes.filter(note => note.id !== id) : notes;
}

function normalizeMeasurements(raw: NoteMeasurements | null | undefined): NoteMeasurements | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (!isObject(raw)) throw noteInvalid('measurements');
  const result: NoteMeasurements = {};
  for (const name of MEASUREMENT_FIELDS) {
    const value = raw[name];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw noteInvalid(`measurements.${name}`);
    const text = value.trim();
    if (text.length > LIMITS.measurement) throw noteInvalid(`measurements.${name} is longer than ${LIMITS.measurement} characters`);
    if (text) result[name] = text;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
const sameMeasurements = (a: NoteMeasurements | undefined, b: NoteMeasurements | undefined) =>
  MEASUREMENT_FIELDS.every(name => a?.[name] === b?.[name]);

/**
 * Creates, changes or deletes the note of one target and returns the new list (the SAME array when nothing changes).
 * Text is trimmed; no text and no measurement deletes the note. A text over 8000 or a measurement over 64 characters
 * is rejected, never truncated, so a technician's record cannot be silently shortened. Only the note of the exact
 * target is touched (B15).
 */
export function upsertNote(notes: BoardNote[], target: NoteTarget, patch: NotePatch, now: string, newId: () => string): BoardNote[] {
  const checked = noteTarget(target);
  const existing = noteFor(notes, checked);
  const text = (patch.text === undefined ? existing?.text ?? '' : patch.text);
  if (typeof text !== 'string') throw noteInvalid('text');
  const trimmed = text.trim();
  if (trimmed.length > LIMITS.text) throw noteInvalid(`text is longer than ${LIMITS.text} characters`);
  const measurements = patch.measurements === undefined ? normalizeMeasurements(existing?.measurements) : normalizeMeasurements(patch.measurements);
  if (trimmed === '' && !measurements) return existing ? notes.filter(note => note !== existing) : notes;
  if (existing && existing.text === trimmed && sameMeasurements(existing.measurements, measurements)) return notes;
  if (!isTimestamp(now)) throw noteInvalid('updatedAt');
  const note: KeyedNote = { id: existing?.id ?? '', target: checked, text: trimmed, updatedAt: now };
  if (measurements) note.measurements = measurements;
  if (existing) return notes.map(candidate => (candidate === existing ? note : candidate));
  if (notes.length >= LIMITS.notes) throw new WorkspaceError('TOO_MANY_NOTES', `Invalid notes: at most ${LIMITS.notes} notes can be saved for one board.`);
  note.id = newId();
  if (!isId(note.id) || notes.some(candidate => candidate.id === note.id)) throw noteInvalid('id');
  return [...notes, note];
}

// ---------------------------------------------------------------------------------------------
// Persistence queue
// ---------------------------------------------------------------------------------------------

export interface SaveFailure {
  error: unknown;
  /** Consecutive failed attempts since the last successful write. */
  attempts: number;
  /** True when another attempt happens without user action (a newer snapshot is queued or a retry is armed). */
  willRetry: boolean;
  retryInMs: number | null;
}
export interface SaverState { saving: boolean; /** Accepted changes not written yet (queued or in flight). */ dirty: boolean; failure: SaveFailure | null }
export interface WorkspaceSaverOptions<T> {
  save(snapshot: T): Promise<void>;
  /** Quiet period: every accepted change restarts it and one write follows when it elapses. */
  delayMs: number;
  onError?(failure: SaveFailure): void;
  onStateChange?(state: SaverState): void;
  /** Delay before an automatic retry of a failed write (`null` stops retrying; `flush()` or a new change always try again). */
  retryDelayMs?(attempt: number, error: unknown): number | null;
}
export interface WorkspaceSaver<T> {
  /** Accepts the newest snapshot (latest wins). Returns false once disposed: such a change is NOT accepted. */
  schedule(snapshot: T): boolean;
  /** Resolves once the newest snapshot accepted so far is written; rejects with the write error if that write fails (the snapshot stays queued). Also works after dispose(). */
  flush(): Promise<void>;
  /** Stops timers and rejects further changes; an already accepted snapshot stays queued and can still be flushed. */
  dispose(): void;
  getState(): SaverState;
}

const PERMANENT_ERRORS = new Set(['STORE_CLOSING', 'EXPORT_CLOSING', 'BOARD_CLOSING', 'DOCUMENT_CLOSING', 'STORE_NOT_SERIALIZABLE', 'STORE_TOO_LARGE', 'MANIFEST_INVALID', 'BOARD_MISMATCH', 'INVALID_KEY', 'NOTES_INVALID', 'TOO_MANY_NOTES']);
const MAX_AUTO_RETRIES = 8;
/**
 * Stable code of an error from the native bridge. Electron's context bridge copies only `message` and `stack`, so
 * electron/preload.cjs delivers the code as a `[CODE] text` message prefix (and as `.code` in-process); read both.
 */
export function nativeErrorCode(error: unknown): string | undefined {
  if (!isObject(error)) return undefined;
  if (typeof error.code === 'string') return error.code;
  const match = typeof error.message === 'string' ? /^\[([A-Z][A-Z0-9_]+)\] / .exec(error.message) : null;
  return match?.[1];
}
function defaultRetryDelay(attempt: number, error: unknown): number | null {
  const code = nativeErrorCode(error);
  if (typeof code === 'string' && PERMANENT_ERRORS.has(code)) return null;
  return attempt > MAX_AUTO_RETRIES ? null : Math.min(30_000, 1000 * 2 ** (attempt - 1));
}

/**
 * Serialized latest-wins persistence. Rapid changes coalesce into one write per quiet period, two saves never run
 * at the same time, and every accepted snapshot is either written, superseded by a newer accepted one that is
 * written, or still queued (visible through `dirty` and flushable). A failed write keeps its snapshot queued unless
 * a newer one replaced it.
 */
export function createWorkspaceSaver<T>(options: WorkspaceSaverOptions<T>): WorkspaceSaver<T> {
  const { save, delayMs, onError, onStateChange, retryDelayMs = defaultRetryDelay } = options;
  let sequence = 0;
  let written = 0;
  let latest: { seq: number; value: T } | null = null;
  let running = false;
  let due = false;
  let disposed = false;
  let attempts = 0;
  let failure: SaveFailure | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastState: SaverState | null = null;
  const waiters: Array<{ target: number; resolve(): void; reject(error: unknown): void }> = [];

  const state = (): SaverState => ({ saving: running, dirty: written < sequence, failure });
  const emit = () => {
    const next = state();
    if (lastState && lastState.saving === next.saving && lastState.dirty === next.dirty && lastState.failure === next.failure) return;
    lastState = next;
    try { onStateChange?.(next); } catch { /* a faulty listener must not stop persistence */ }
  };
  const disarm = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  const arm = (ms: number) => {
    disarm();
    if (disposed) return;
    timer = setTimeout(() => { timer = undefined; due = true; void pump(); }, Math.max(0, ms));
  };

  function fail(item: { seq: number; value: T }, error: unknown) {
    attempts += 1;
    const superseded = latest !== null;
    let retryInMs: number | null = null;
    if (!superseded) {
      latest = item;
      if (!disposed) { retryInMs = retryDelayMs(attempts, error); if (retryInMs !== null) arm(retryInMs); }
    }
    failure = { error, attempts, willRetry: !disposed && (superseded || retryInMs !== null), retryInMs };
    if (!superseded) for (const waiter of waiters.splice(0)) waiter.reject(error);
    try { onError?.(failure); } catch { /* see emit */ }
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    emit();
    try {
      while (latest && (due || waiters.length > 0)) {
        const item: { seq: number; value: T } = latest;
        latest = null;
        due = false;
        // Nothing is queued any more, so a timer armed for this snapshot (flush wrote it early) must not fire into the next one.
        disarm();
        try { await save(item.value); }
        catch (error) { fail(item, error); emit(); continue; }
        written = item.seq;
        attempts = 0;
        failure = null;
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          if (waiters[index].target <= written) waiters.splice(index, 1)[0].resolve();
        }
        emit();
      }
    } finally {
      running = false;
      emit();
    }
  }

  return {
    schedule(snapshot) {
      if (disposed) return false;
      sequence += 1;
      latest = { seq: sequence, value: snapshot };
      arm(delayMs);
      emit();
      return true;
    },
    flush() {
      const target = sequence;
      if (written >= target) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        waiters.push({ target, resolve, reject });
        disarm();
        void pump();
      });
    },
    dispose() { disposed = true; disarm(); },
    getState: state,
  };
}
