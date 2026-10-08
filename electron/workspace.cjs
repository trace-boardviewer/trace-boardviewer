'use strict';

// Native twin of the manifest and notes validators in src/lib/workspace.ts. main.cjs cannot import
// TypeScript, so the renderer-side rules are duplicated here with the same bounds, field order,
// error codes and messages; src/lib/workspace.test.ts verifies parity on shared fixtures.
// Texts are English with a stable `code` (// i18n: pending): the catalogs are frozen.

const LIMITS = Object.freeze({
  documents: 200, bookmarks: 2000, annotations: 2000, cameras: 256, notes: 500, aliases: 1000, alias: 256,
  text: 8000, path: 32767, id: 128, componentId: 256, measurement: 64, timestamp: 40, page: 1000000, anchor: 1e9,
  ratioMin: 0.2, ratioMax: 0.8,
});
const DOCUMENT_KINDS = Object.freeze(['pdf', 'image', 'schematic']);
const TABS = Object.freeze(['board', 'schematic', 'documents']);
const RIGHT_KINDS = Object.freeze(['schematic', 'document']);
const KEY_PATTERN = /^[a-f0-9]{64}$/;
const BOARD_SOURCE = 'board';

class WorkspaceError extends Error {
  constructor(code, message) { super(message); this.name = 'WorkspaceError'; this.code = code; }
}
const invalid = (field) => new WorkspaceError('MANIFEST_INVALID', `Invalid workspace manifest: ${field}.`);
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value, max, min = 0) => typeof value === 'string' && value.length >= min && value.length <= max;
const isId = (value) => isText(value, LIMITS.id, 1);
const isKey = (value) => typeof value === 'string' && KEY_PATTERN.test(value);
const isTimestamp = (value) => isText(value, LIMITS.timestamp, 1) && Number.isFinite(Date.parse(value));
const isFinite = (value) => typeof value === 'number' && Number.isFinite(value);
const isCount = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const clampRatio = (ratio) => Math.min(LIMITS.ratioMax, Math.max(LIMITS.ratioMin, ratio));
// Own data property even for a key such as "__proto__" (plain assignment would change the prototype).
const define = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });

function validateKey(key) {
  if (!isKey(key)) throw new WorkspaceError('INVALID_KEY', 'Invalid board key.');
  return key;
}

function manifestName(boardKey) { return `workspaces/${validateKey(boardKey)}.json`; }

function validateBoard(raw, field) {
  if (!isObject(raw)) throw invalid(field);
  if (!isKey(raw.key)) throw invalid(`${field}.key`);
  if (!isText(raw.name, LIMITS.text, 1)) throw invalid(`${field}.name`);
  if (!isText(raw.path, LIMITS.path, 1)) throw invalid(`${field}.path`);
  if (!isText(raw.format, LIMITS.text, 1)) throw invalid(`${field}.format`);
  return { key: raw.key, name: raw.name, path: raw.path, format: raw.format };
}

function validateCamera(raw, field) {
  if (!isObject(raw)) throw invalid(field);
  const camera = {};
  if (raw.page !== undefined) { if (!isCount(raw.page, LIMITS.page)) throw invalid(`${field}.page`); camera.page = raw.page; }
  if (raw.zoom !== undefined) { if (!isFinite(raw.zoom) || raw.zoom <= 0) throw invalid(`${field}.zoom`); camera.zoom = raw.zoom; }
  for (const name of ['rotation', 'x', 'y']) {
    if (raw[name] !== undefined) { if (!isFinite(raw[name])) throw invalid(`${field}.${name}`); camera[name] = raw[name]; }
  }
  // `fit` is a hint, not data: exactly the three modes are kept, anything else is dropped (like an unknown field) so that an
  // older or hand-edited file never invalidates the camera it sits in (twin of validateCamera in src/lib/workspace.ts, W-win-viewers-01).
  if (raw.fit === 'width' || raw.fit === 'page' || raw.fit === 'none') camera.fit = raw.fit;
  if (raw.side !== undefined) { if (raw.side !== 'top' && raw.side !== 'bottom') throw invalid(`${field}.side`); camera.side = raw.side; }
  return camera;
}

function validateSplit(raw, field) {
  if (!isObject(raw)) throw invalid(field);
  if (typeof raw.enabled !== 'boolean') throw invalid(`${field}.enabled`);
  if (!isFinite(raw.ratio)) throw invalid(`${field}.ratio`);
  let right = null;
  if (raw.right !== null) {
    if (!isObject(raw.right) || !RIGHT_KINDS.includes(raw.right.kind)) throw invalid(`${field}.right.kind`);
    if (!isId(raw.right.id)) throw invalid(`${field}.right.id`);
    right = { kind: raw.right.kind, id: raw.right.id };
  }
  return { enabled: raw.enabled, ratio: clampRatio(raw.ratio), right };
}

function validateDocumentFields(raw, field) {
  if (!isObject(raw)) throw invalid(field);
  if (!DOCUMENT_KINDS.includes(raw.kind)) throw invalid(`${field}.kind`);
  if (!isText(raw.name, LIMITS.text, 1)) throw invalid(`${field}.name`);
  if (!isText(raw.path, LIMITS.path, 1)) throw invalid(`${field}.path`);
  if (raw.relativePath !== undefined && !isText(raw.relativePath, LIMITS.path, 1)) throw invalid(`${field}.relativePath`);
  if (!isKey(raw.key)) throw invalid(`${field}.key`);
  if (!isCount(raw.size, Number.MAX_SAFE_INTEGER)) throw invalid(`${field}.size`);
  if (raw.pageCount !== undefined && (!isCount(raw.pageCount, LIMITS.page) || raw.pageCount < 1)) throw invalid(`${field}.pageCount`);
  const document = { kind: raw.kind, name: raw.name, path: raw.path, key: raw.key, size: raw.size };
  if (raw.relativePath !== undefined) document.relativePath = raw.relativePath;
  if (raw.pageCount !== undefined) document.pageCount = raw.pageCount;
  return document;
}

function validateDocument(raw, field) {
  const fields = validateDocumentFields(raw, field);
  if (!isId(raw.id) || raw.id === BOARD_SOURCE) throw invalid(`${field}.id`); // 'board' is the reserved camera key of the board itself (B41)
  if (!Array.isArray(raw.bookmarks) || raw.bookmarks.length > LIMITS.bookmarks) throw invalid(`${field}.bookmarks`);
  if (!Array.isArray(raw.annotations) || raw.annotations.length > LIMITS.annotations) throw invalid(`${field}.annotations`);
  if (!isTimestamp(raw.addedAt)) throw invalid(`${field}.addedAt`);
  if (raw.missing !== undefined && typeof raw.missing !== 'boolean') throw invalid(`${field}.missing`);
  const bookmarkIds = new Set();
  const bookmarks = raw.bookmarks.map((bookmark, index) => {
    const at = `${field}.bookmarks[${index}]`;
    if (!isObject(bookmark)) throw invalid(at);
    if (!isId(bookmark.id) || bookmarkIds.has(bookmark.id)) throw invalid(`${at}.id`);
    bookmarkIds.add(bookmark.id);
    if (!isCount(bookmark.page, LIMITS.page)) throw invalid(`${at}.page`);
    if (!isText(bookmark.label, LIMITS.text)) throw invalid(`${at}.label`);
    const result = { id: bookmark.id, page: bookmark.page, label: bookmark.label };
    for (const name of ['x', 'y']) {
      if (bookmark[name] !== undefined) { if (!isFinite(bookmark[name])) throw invalid(`${at}.${name}`); result[name] = bookmark[name]; }
    }
    return result;
  });
  const annotationIds = new Set();
  const annotations = raw.annotations.map((annotation, index) => {
    const at = `${field}.annotations[${index}]`;
    if (!isObject(annotation)) throw invalid(at);
    if (!isId(annotation.id) || annotationIds.has(annotation.id)) throw invalid(`${at}.id`);
    annotationIds.add(annotation.id);
    if (!isCount(annotation.page, LIMITS.page)) throw invalid(`${at}.page`);
    if (!isFinite(annotation.x)) throw invalid(`${at}.x`);
    if (!isFinite(annotation.y)) throw invalid(`${at}.y`);
    if (!isText(annotation.text, LIMITS.text)) throw invalid(`${at}.text`);
    if (!isTimestamp(annotation.updatedAt)) throw invalid(`${at}.updatedAt`);
    return { id: annotation.id, page: annotation.page, x: annotation.x, y: annotation.y, text: annotation.text, updatedAt: annotation.updatedAt };
  });
  const document = { id: raw.id, ...fields, bookmarks, annotations, addedAt: raw.addedAt };
  if (raw.calibration !== undefined) {
    if (!isObject(raw.calibration) || !isFinite(raw.calibration.pixelsPerMm) || raw.calibration.pixelsPerMm <= 0 || raw.calibration.confirmed !== true) {
      throw invalid(`${field}.calibration`);
    }
    document.calibration = { pixelsPerMm: raw.calibration.pixelsPerMm, confirmed: true };
  }
  if (raw.missing !== undefined) document.missing = raw.missing;
  return document;
}

// User-confirmed associations (schematic reference/net -> board reference/net): both maps are bounded
// string -> string records; the field is optional on the manifest, but when present both maps are required.
function validateAliasMap(raw, field) {
  if (!isObject(raw)) throw invalid(field);
  const keys = Object.keys(raw);
  if (keys.length > LIMITS.aliases) throw invalid(field);
  const map = {};
  keys.forEach((key, index) => {
    if (!isText(key, LIMITS.alias)) throw invalid(`${field}[${index}]`);
    if (!isText(raw[key], LIMITS.alias)) throw invalid(`${field}[${index}]`);
    define(map, key, raw[key]);
  });
  return map;
}

function validateAliases(raw, field = 'aliases') {
  if (!isObject(raw)) throw invalid(field);
  return { refs: validateAliasMap(raw.refs, `${field}.refs`), nets: validateAliasMap(raw.nets, `${field}.nets`) };
}

// Strict, bounded manifest validation. Unknown fields are dropped; anything invalid throws.
// A manifest saved for another board is rejected so that it can never be attached by accident.
function validateManifest(raw, expectedBoardKey) {
  validateKey(expectedBoardKey);
  if (!isObject(raw)) throw invalid('manifest');
  if (raw.version !== 1) throw invalid('version');
  const board = validateBoard(raw.board, 'board');
  if (board.key !== expectedBoardKey) throw new WorkspaceError('BOARD_MISMATCH', 'The workspace belongs to another board.');
  if (!Array.isArray(raw.documents) || raw.documents.length > LIMITS.documents) throw invalid('documents');
  const ids = new Set();
  const documents = raw.documents.map((item, index) => {
    const document = validateDocument(item, `documents[${index}]`);
    if (ids.has(document.id)) throw invalid(`documents[${index}].id`);
    ids.add(document.id);
    return document;
  });
  const split = validateSplit(raw.split, 'split');
  if (!TABS.includes(raw.activeTab)) throw invalid('activeTab');
  if (!isObject(raw.cameras)) throw invalid('cameras');
  const cameraKeys = Object.keys(raw.cameras);
  if (cameraKeys.length > LIMITS.cameras) throw invalid('cameras');
  const cameras = {};
  for (const key of cameraKeys) {
    if (!isId(key)) throw invalid(`cameras[${JSON.stringify(key)}]`);
    define(cameras, key, validateCamera(raw.cameras[key], `cameras[${JSON.stringify(key)}]`));
  }
  const aliases = raw.aliases === undefined ? undefined : validateAliases(raw.aliases, 'aliases');
  if (!isTimestamp(raw.updatedAt)) throw invalid('updatedAt');
  return {
    version: 1, board, documents, split, activeTab: raw.activeTab, cameras,
    ...(aliases ? { aliases } : {}), updatedAt: raw.updatedAt,
  };
}

// Note keys (twin of src/lib/note-keys.ts; the grammar and the rules are documented there). Only the pieces a validator needs.
const normalizeName = (value) => value.normalize('NFKC').trim();
const ESCAPED = /[%/@\u0000-\u001f\u007f\ud800-\udfff]/g;
const escapeKeyName = (name) => name.replace(ESCAPED, (unit) => `%${unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
const SIDE_LETTER = Object.freeze({ top: 't', bottom: 'b', both: 'a' });
const micrometres = (mm) => Math.round(mm * 1000);
const anchorText = (anchor) => `${SIDE_LETTER[anchor.side]}${micrometres(anchor.x)},${micrometres(anchor.y)}`;
function noteKeyText(key) {
  let text = key.ref === undefined ? '' : escapeKeyName(key.ref);
  if (key.at) text += `@${anchorText(key.at)}`;
  if (key.pin !== undefined) text += `/${escapeKeyName(key.pin)}`;
  else if (key.pinAt) text += `/@${anchorText(key.pinAt)}`;
  return text;
}
// Same list as NOTE_PROBLEMS in src/lib/workspace.ts (and the NoteProblem union in src/lib/types.ts).
const NOTE_PROBLEMS = Object.freeze([
  'component-missing', 'component-ambiguous', 'pin-missing', 'pin-ambiguous', 'legacy-id-missing', 'legacy-indistinguishable', 'duplicate-target',
]);

// A reference or pin number as a key holds it: NFKC and trim, 1 to 256 characters (null when it is none).
function validateNoteName(value) {
  if (!isText(value, LIMITS.componentId, 1)) return null;
  const name = normalizeName(value);
  return name.length >= 1 && name.length <= LIMITS.componentId ? name : null;
}
function validateNoteAnchor(raw, bad, field) {
  if (!isObject(raw)) throw bad(field);
  if (raw.side !== 'top' && raw.side !== 'bottom' && raw.side !== 'both') throw bad(`${field}.side`);
  if (!isFinite(raw.x) || Math.abs(raw.x) > LIMITS.anchor) throw bad(`${field}.x`);
  if (!isFinite(raw.y) || Math.abs(raw.y) > LIMITS.anchor) throw bad(`${field}.y`);
  // `+ 0` turns a rounded -0 into 0, so a stored position never prints as "-0".
  return { side: raw.side, x: Math.round(raw.x * 1000) / 1000 + 0, y: Math.round(raw.y * 1000) / 1000 + 0 };
}
// Strict, canonical form of a stored key: names normalized, anchors rounded to 1 um, unknown fields dropped, a reference or an anchor required.
function validateNoteKey(raw, bad) {
  if (!isObject(raw)) throw bad('target');
  const key = {};
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

// Notes: same limits as the notesValue of main.cjs plus the pin-note fields. A note names its target either by a key (`target`,
// see src/lib/note-keys.ts) or, when it was written before keys existed, by the importer's positional ids (`componentId` and `pinId`,
// with an `unresolved` record once a migration could not place it); both kinds may share one list. One note per target is an
// invariant (B15): duplicates are malformed input.
function validateNotes(raw) {
  if (!Array.isArray(raw)) throw new WorkspaceError('NOTES_INVALID', 'Invalid notes: not a list.');
  if (raw.length > LIMITS.notes) throw new WorkspaceError('TOO_MANY_NOTES', `Invalid notes: at most ${LIMITS.notes} notes can be saved for one board.`);
  const ids = new Set();
  const targets = new Set();
  return raw.map((note, index) => {
    const bad = (field) => new WorkspaceError('NOTES_INVALID', `Invalid notes: notes[${index}].${field}.`);
    if (!isObject(note)) throw new WorkspaceError('NOTES_INVALID', `Invalid notes: notes[${index}].`);
    if (!isId(note.id)) throw bad('id');
    if (ids.has(note.id)) throw bad('id (duplicate)');
    let key;
    if (note.target !== undefined) {
      if (note.componentId !== undefined || note.pinId !== undefined || note.unresolved !== undefined) throw bad('target (a note has a target or a componentId, not both)');
      key = validateNoteKey(note.target, bad);
    } else {
      if (!isText(note.componentId, LIMITS.componentId, 1)) throw bad('componentId');
      if (note.pinId !== undefined && !isText(note.pinId, LIMITS.componentId, 1)) throw bad('pinId');
    }
    if (!isText(note.text, LIMITS.text)) throw bad('text');
    if (!isTimestamp(note.updatedAt)) throw bad('updatedAt');
    let unresolved;
    if (!key && note.unresolved !== undefined) {
      if (!isObject(note.unresolved) || !NOTE_PROBLEMS.includes(note.unresolved.reason) || !isTimestamp(note.unresolved.at)) throw bad('unresolved');
      unresolved = { reason: note.unresolved.reason, at: note.unresolved.at };
    }
    const target = key ? `K\0${noteKeyText(key)}` : `L\0${note.componentId}\0${note.pinId === undefined ? '' : note.pinId}`;
    if (targets.has(target)) throw bad(key ? 'target (duplicate note for this target)' : note.pinId === undefined ? 'componentId (duplicate note for this component)' : 'pinId (duplicate note for this pin)');
    ids.add(note.id);
    targets.add(target);
    let result;
    if (key) result = { id: note.id, target: key, text: note.text, updatedAt: note.updatedAt };
    else {
      result = { id: note.id, componentId: note.componentId, text: note.text, updatedAt: note.updatedAt };
      if (note.pinId !== undefined) result.pinId = note.pinId;
      if (unresolved) result.unresolved = unresolved;
    }
    if (note.measurements !== undefined) {
      if (!isObject(note.measurements)) throw bad('measurements');
      const measurements = {};
      for (const name of ['voltage', 'resistance', 'other']) {
        if (note.measurements[name] !== undefined) {
          if (!isText(note.measurements[name], LIMITS.measurement)) throw bad(`measurements.${name}`);
          measurements[name] = note.measurements[name];
        }
      }
      if (Object.keys(measurements).length > 0) result.measurements = measurements;
    }
    return result;
  });
}

module.exports = Object.freeze({
  LIMITS, DOCUMENT_KINDS, NOTE_PROBLEMS, WorkspaceError, validateKey, manifestName, validateManifest, validateNotes, validateDocumentFields, validateAliases,
  normalizeName, escapeKeyName, noteKeyText,
});
