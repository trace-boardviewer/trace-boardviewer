import { createRequire } from 'node:module';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DocumentCamera, DocumentRecord, WorkspaceManifest } from '../../src/lib/documents';
import { escapeKeyName, isKeyedNote, noteKeyText, normalizeName } from '../../src/lib/note-keys';
import type { BoardNote, NoteKey } from '../../src/lib/types';
import {
  addDocument, applyLocateResults, noteFor, noteTarget, reconcileManifest, relativeToBoard, relinkDocument, removeAlias, removeAnnotation, removeBookmark, removeDocument, removeNote, resolveRelative,
  setActiveTab, setAlias, setCalibration, setCamera, setPageCount, setSplit, touch, upsertAnnotation, upsertBookmark, upsertNote, validateKey, validateManifest, validateNotes, WorkspaceError,
} from '../../src/lib/workspace';
import { params, real } from './support';

// The native twin is CommonJS; the renderer module is the one under test and the native one is its oracle.
interface NativeWorkspace {
  validateKey(value: unknown): string;
  validateManifest(raw: unknown, boardKey: string): WorkspaceManifest;
  validateNotes(raw: unknown): BoardNote[];
  escapeKeyName(name: string): string;
  normalizeName(name: string): string;
  noteKeyText(key: NoteKey): string;
}
const native = createRequire(import.meta.url)('../../electron/workspace.cjs') as NativeWorkspace;

type Outcome = { ok: true; json: string } | { ok: false; code: unknown; message: string; typed: boolean };
const outcome = (fn: () => unknown, isTyped: (error: unknown) => boolean): Outcome => {
  try { return { ok: true, json: JSON.stringify(fn()) ?? 'undefined' }; }
  catch (error) { return { ok: false, code: (error as { code?: unknown }).code, message: (error as Error).message, typed: isTyped(error) }; }
};
const ours = (fn: () => unknown) => outcome(fn, error => error instanceof WorkspaceError);
const theirs = (fn: () => unknown) => outcome(fn, error => (error as Error)?.name === 'WorkspaceError');

// ---------------------------------------------------------------------------------------------------------------
// Generators of valid data
// ---------------------------------------------------------------------------------------------------------------

const HEX = '0123456789abcdef'.split('');
const key64 = fc.array(fc.constantFrom(...HEX), { minLength: 64, maxLength: 64 }).map(chars => chars.join(''));
const timestamp = fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2035-01-01T00:00:00Z'), noInvalidDate: true }).map(date => date.toISOString());
const word = (min = 1, max = 12) => fc.string({ minLength: min, maxLength: max, unit: 'grapheme-ascii' });
const text = (max: number, min = 0) => fc.oneof(fc.string({ minLength: min, maxLength: Math.min(max, 30) }), fc.string({ minLength: min, maxLength: Math.min(max, 30), unit: 'grapheme' }));
const segment = fc.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,7}$/).filter(name => name !== '.' && name !== '..' && !/[. ]$/.test(name));
const posixPath = fc.array(segment, { minLength: 1, maxLength: 5 }).map(parts => `/${parts.join('/')}`);
const windowsPath = fc.tuple(fc.constantFrom('C', 'D', 'e'), fc.array(segment, { minLength: 1, maxLength: 5 })).map(([drive, parts]) => `${drive}:\\${parts.join('\\')}`);
const anyPath = fc.oneof(posixPath, windowsPath);
const ID_MAX = 128;
const docId = fc.string({ minLength: 1, maxLength: 16, unit: 'grapheme-ascii' }).filter(id => id !== 'board');
const finite = fc.oneof(real(-1e6, 1e6), fc.integer({ min: -1000, max: 1000 }));

const camera: fc.Arbitrary<DocumentCamera> = fc.record({
  page: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }), zoom: fc.option(real(1e-3, 1e4), { nil: undefined }), rotation: fc.option(finite, { nil: undefined }),
  x: fc.option(finite, { nil: undefined }), y: fc.option(finite, { nil: undefined }), fit: fc.option(fc.constantFrom('width' as const, 'page' as const, 'none' as const), { nil: undefined }),
  side: fc.option(fc.constantFrom('top' as const, 'bottom' as const), { nil: undefined }),
}).map(c => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) as DocumentCamera);

const boardOf = (key: string, path: string) => ({ key, name: 'board', path, format: 'GenCAD 1.4' });
const manifest = (expectedKey: fc.Arbitrary<string> = key64): fc.Arbitrary<WorkspaceManifest> => fc.tuple(
  expectedKey, posixPath, timestamp, fc.constantFrom('board' as const, 'schematic' as const, 'documents' as const),
  fc.uniqueArray(docId, { maxLength: 4 }),
  fc.record({ enabled: fc.boolean(), ratio: real(0.2, 0.8) }),
  fc.boolean(), fc.integer({ min: 0, max: 20 }),
).chain(([boardKey, boardPath, updatedAt, activeTab, ids, split, withAliases, pick]) => fc.record({
  documents: fc.tuple(...ids.map(id => fc.record({
    kind: fc.constantFrom('pdf' as const, 'image' as const, 'schematic' as const), name: word(1, 10), path: posixPath, key: key64, size: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    pageCount: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined }), addedAt: timestamp,
    bookmarks: fc.uniqueArray(fc.record({ id: word(1, 6), page: fc.integer({ min: 0, max: 1_000_000 }), label: text(40), x: fc.option(finite, { nil: undefined }), y: fc.option(finite, { nil: undefined }) }), { selector: b => b.id, maxLength: 3 }),
    annotations: fc.uniqueArray(fc.record({ id: word(1, 6), page: fc.integer({ min: 0, max: 1_000_000 }), x: finite, y: finite, text: text(60), updatedAt: timestamp }), { selector: a => a.id, maxLength: 3 }),
    calibration: fc.option(real(1e-3, 1e4).map(pixelsPerMm => ({ pixelsPerMm, confirmed: true as const })), { nil: undefined }),
    missing: fc.option(fc.boolean(), { nil: undefined }),
  }).map(({ pageCount, calibration, missing, ...rest }, ) => {
    const record: DocumentRecord = { id: '', ...rest };
    if (pageCount !== undefined) record.pageCount = pageCount;
    if (calibration !== undefined) record.calibration = calibration;
    if (missing !== undefined) record.missing = missing;
    for (const b of record.bookmarks) { if (b.x === undefined) delete b.x; if (b.y === undefined) delete b.y; }
    return record;
  }))),
  cameras: fc.dictionary(fc.oneof(fc.constant('board'), fc.constantFrom(...ids, 'orphan')), camera, { maxKeys: 4 }),
  aliases: fc.record({ refs: fc.dictionary(word(1, 6), word(1, 6), { maxKeys: 3 }), nets: fc.dictionary(word(1, 6), word(1, 6), { maxKeys: 3 }) }),
  right: fc.option(fc.record({ kind: fc.constantFrom('schematic' as const, 'document' as const), id: fc.constantFrom(...ids, 'x') }), { nil: null }),
}).map(({ documents, cameras, aliases, right }) => {
  documents.forEach((document, index) => { document.id = ids[index]; });
  const result: WorkspaceManifest = {
    version: 1, board: boardOf(boardKey, boardPath), documents, split: { enabled: split.enabled, ratio: split.ratio, right: right ?? null }, activeTab, cameras, updatedAt,
    ...(withAliases ? { aliases } : {}),
  };
  void pick;
  return result;
}));

const noteName = fc.oneof(word(1, 8), fc.constantFrom('R1', ' R1 ', 'Ｒ１', 'U7', 'A/1', 'x%y', 'a@b', '\u00e9'));
const rawAnchor = fc.record({ side: fc.constantFrom('top', 'bottom', 'both'), x: fc.oneof(real(-1e3, 1e3), fc.constantFrom(-0, 1e9, -1e9, 0.0004, 0.0005, -0.0005)), y: real(-1e3, 1e3) });
const rawKey = fc.record({ ref: fc.option(noteName, { nil: undefined }), at: fc.option(rawAnchor, { nil: undefined }), pin: fc.option(noteName, { nil: undefined }), pinAt: fc.option(rawAnchor, { nil: undefined }) })
  .map(key => Object.fromEntries(Object.entries(key).filter(([, v]) => v !== undefined)));
const measurement = fc.record({ voltage: fc.option(text(64), { nil: undefined }), resistance: fc.option(text(64), { nil: undefined }), other: fc.option(text(64), { nil: undefined }) })
  .map(m => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)));
const rawNote = fc.record({
  id: fc.oneof(fc.string({ minLength: 1, maxLength: 5, unit: 'grapheme-ascii' }), fc.constantFrom('n1', 'n2')),
  body: fc.oneof(
    rawKey.map(target => ({ target })),
    fc.record({ componentId: word(1, 8), pinId: fc.option(word(1, 8), { nil: undefined }) }).map(legacy => Object.fromEntries(Object.entries(legacy).filter(([, v]) => v !== undefined))),
  ),
  text: text(100), updatedAt: timestamp, measurements: fc.option(measurement, { nil: undefined }),
}).map(({ id, body, text: t, updatedAt, measurements }) => ({ id, ...body, text: t, updatedAt, ...(measurements ? { measurements } : {}) }));
const rawNotes = fc.array(rawNote, { maxLength: 6 });

// ---------------------------------------------------------------------------------------------------------------
// Mutation of valid data into near-valid data
// ---------------------------------------------------------------------------------------------------------------

const evil = fc.oneof(
  fc.constantFrom<unknown>(null, undefined, NaN, Infinity, -Infinity, -0, 0, 1, -1, 1.5, 2 ** 53, -(2 ** 53), 1e308, '', ' ', 'x', 'a'.repeat(129), 'a'.repeat(257), 'a'.repeat(8001), 'a'.repeat(32768), [], {}, [null], true, false, '__proto__', 'board',
    '2026-13-45T00:00:00Z', '2026-10-05', '\u0000', 'Z'.repeat(41), { version: 1 }, [1, 2, 3], { refs: {}, nets: {} }, { refs: {} }, 1_000_001, 0.19, 0.81, 'top', 'both', 'documents'),
  fc.string({ maxLength: 12 }), fc.double({ noDefaultInfinity: false }), fc.integer(), fc.jsonValue(),
);
/** A copy of `root` with one value replaced (or removed) at a path chosen by `choices`; the root itself when the path is empty. */
function mutate(root: unknown, choices: readonly number[], action: 'set' | 'delete', value: unknown): unknown {
  const clone = structuredClone(root) as Record<string, unknown>;
  let node: unknown = clone, parent: Record<string, unknown> | unknown[] | null = null, key = '';
  for (const choice of choices) {
    if (node === null || typeof node !== 'object') break;
    const keys = Object.keys(node);
    if (keys.length === 0) break;
    parent = node as Record<string, unknown>; key = keys[choice % keys.length]; node = (node as Record<string, unknown>)[key];
    if (choice % 4 === 0) break;
  }
  if (parent === null) return value;
  if (action === 'delete') { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
  else (parent as Record<string, unknown>)[key] = value;
  return clone;
}
const mutation = fc.record({ choices: fc.array(fc.nat({ max: 50 }), { minLength: 1, maxLength: 7 }), action: fc.constantFrom('set' as const, 'delete' as const), value: evil });

const NOW = '2026-10-07T10:00:00.000Z';
const allowedCodes = new Set(['MANIFEST_INVALID', 'BOARD_MISMATCH', 'INVALID_KEY']);
const noteCodes = new Set(['NOTES_INVALID', 'TOO_MANY_NOTES']);

describe('manifest validator: renderer == native, canonical, idempotent', () => {
  it('accepts a valid manifest unchanged, in both implementations, and again after a JSON round trip', () => {
    fc.assert(fc.property(manifest(), m => {
      const key = m.board.key;
      const a = validateManifest(m, key);
      expect(a).toEqual(m);
      expect(JSON.stringify(a)).toBe(JSON.stringify(native.validateManifest(m, key)));
      const stored = JSON.parse(JSON.stringify(a));
      expect(validateManifest(stored, key)).toEqual(a);
      expect(JSON.stringify(validateManifest(a, key))).toBe(JSON.stringify(a));
    }), params(150));
  });

  it('gives the same verdict, code, message and result as the native validator for near-valid manifests, and its results are canonical', () => {
    fc.assert(fc.property(manifest(), mutation, fc.option(mutation, { nil: undefined }), (m, first, second) => {
      let raw = mutate(m, first.choices, first.action, first.value);
      if (second) raw = mutate(raw, second.choices, second.action, second.value);
      const key = m.board.key;
      const a = ours(() => validateManifest(raw, key)), b = theirs(() => native.validateManifest(raw, key));
      expect(a).toEqual(b);
      if (a.ok) {
        const again = validateManifest(JSON.parse(a.json), key);
        expect(JSON.stringify(again)).toBe(a.json);
      } else {
        expect(a.typed).toBe(true);
        expect(allowedCodes.has(a.code as string)).toBe(true);
      }
    }), params(600));
  });

  it('agrees with the native validator on arbitrary JSON, a foreign board key, and keys that are not keys', () => {
    fc.assert(fc.property(fc.jsonValue(), fc.oneof(key64, fc.string(), fc.constant(undefined as unknown as string)), (raw, key) => {
      const a = ours(() => validateManifest(raw, key)), b = theirs(() => native.validateManifest(raw, key));
      expect(a).toEqual(b);
      if (!a.ok) expect(a.typed).toBe(true);
    }), params(300));
    fc.assert(fc.property(fc.anything(), value => {
      const a = ours(() => validateKey(value)), b = theirs(() => native.validateKey(value));
      expect(a).toEqual(b);
      expect(a.ok).toBe(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
    }), params(300));
  });

  it('keeps an own "__proto__" key as data (cameras and aliases) in both validators and never rewires a prototype', () => {
    fc.assert(fc.property(manifest(), camera, word(1, 6), (m, cam, target) => {
      const raw = JSON.parse(JSON.stringify(m));
      raw.cameras = JSON.parse(`{"__proto__": ${JSON.stringify(cam)}, "board": {"zoom": 2}}`);
      raw.aliases = JSON.parse(`{"refs": {"__proto__": ${JSON.stringify(target)}}, "nets": {}}`);
      const a = ours(() => validateManifest(raw, m.board.key)), b = theirs(() => native.validateManifest(raw, m.board.key));
      expect(a).toEqual(b);
      if (a.ok) {
        const parsed = validateManifest(raw, m.board.key);
        expect(Object.hasOwn(parsed.cameras, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(parsed.cameras)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(parsed.aliases!.refs)).toBe(Object.prototype);
      }
      expect(({} as Record<string, unknown>).zoom).toBeUndefined();
    }), params(60));
  });
});

describe('manifest operations keep the manifest valid, canonical and unchanged when nothing changes', () => {
  const keyArb = key64;
  type Op = { kind: string; args: unknown[] };
  const index = fc.nat({ max: 12 });
  const operation: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant('add'), args: fc.tuple(fc.constantFrom('pdf', 'image', 'schematic'), word(1, 8), anyPath, keyArb, fc.integer({ min: 0, max: 1e9 }), fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }), word(1, 8)) }),
    fc.record({ kind: fc.constant('remove'), args: fc.tuple(index) }),
    fc.record({ kind: fc.constant('tab'), args: fc.tuple(fc.constantFrom('board', 'schematic', 'documents', 'other')) }),
    fc.record({ kind: fc.constant('split'), args: fc.tuple(fc.record({ enabled: fc.option(fc.boolean(), { nil: undefined }), ratio: fc.option(fc.oneof(real(-2, 3), fc.constantFrom(NaN, Infinity)), { nil: undefined }), right: fc.option(fc.oneof(fc.constant(null), fc.record({ kind: fc.constantFrom('schematic', 'document'), idx: index })), { nil: undefined }) })) }),
    fc.record({ kind: fc.constant('camera'), args: fc.tuple(index, fc.oneof(fc.constant(null), camera, fc.record({ zoom: fc.constantFrom(0, -1, NaN) }))) }),
    fc.record({ kind: fc.constant('bookmark'), args: fc.tuple(index, word(1, 4), fc.integer({ min: -2, max: 20 }), text(20)) }),
    fc.record({ kind: fc.constant('unbookmark'), args: fc.tuple(index, word(1, 4)) }),
    fc.record({ kind: fc.constant('annotate'), args: fc.tuple(index, word(1, 4), fc.integer({ min: 0, max: 20 }), real(-1e3, 1e3), text(30)) }),
    fc.record({ kind: fc.constant('unannotate'), args: fc.tuple(index, word(1, 4)) }),
    fc.record({ kind: fc.constant('calibrate'), args: fc.tuple(index, fc.oneof(fc.constant(null), real(-1, 100).map(pixelsPerMm => ({ pixelsPerMm, confirmed: true as const })), fc.constant({ pixelsPerMm: 3, confirmed: false }))) }),
    fc.record({ kind: fc.constant('alias'), args: fc.tuple(fc.constantFrom('refs', 'nets', 'other'), word(0, 5), word(0, 5)) }),
    fc.record({ kind: fc.constant('unalias'), args: fc.tuple(fc.constantFrom('refs', 'nets'), word(0, 5)) }),
    fc.record({ kind: fc.constant('pages'), args: fc.tuple(index, fc.integer({ min: -1, max: 50 })) }),
    fc.record({ kind: fc.constant('touch'), args: fc.tuple(fc.oneof(timestamp, fc.constant('later'))) }),
    fc.record({ kind: fc.constant('reconcile'), args: fc.tuple() }),
    fc.record({ kind: fc.constant('relink'), args: fc.tuple(index, anyPath, fc.boolean(), keyArb) }),
    fc.record({ kind: fc.constant('locate'), args: fc.tuple(index, fc.constantFrom('ok', 'moved', 'changed', 'missing', 'unreadable'), posixPath, keyArb) }),
  );

  it('every operation returns a manifest the validators accept (renderer and native) and that equals its own validation, or throws a WorkspaceError and changes nothing', () => {
    fc.assert(fc.property(manifest(), fc.array(operation, { minLength: 1, maxLength: 12 }), (start, operations) => {
      let current = start;
      let counter = 0;
      const doc = (i: number) => current.documents[i % Math.max(1, current.documents.length)]?.id ?? 'missing-id';
      for (const op of operations) {
        const before = current;
        const snapshot = JSON.stringify(before);
        let next: WorkspaceManifest;
        try {
          const a = op.args as any[];
          switch (op.kind) {
            case 'add': next = addDocument(current, { kind: a[0], name: a[1], path: a[2], key: a[3], size: a[4], ...(a[5] === undefined ? {} : { pageCount: a[5] }) }, NOW, () => `${a[6]}-${++counter}`).manifest; break;
            case 'remove': next = removeDocument(current, doc(a[0])); break;
            case 'tab': next = setActiveTab(current, a[0]); break;
            case 'split': { const patch = { ...a[0], ...(a[0].right && a[0].right.idx !== undefined ? { right: { kind: a[0].right.kind, id: doc(a[0].right.idx) } } : {}) }; for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k]; next = setSplit(current, patch); break; }
            case 'camera': next = setCamera(current, a[0] % 5 === 0 ? 'board' : doc(a[0]), a[1]); break;
            case 'bookmark': next = upsertBookmark(current, doc(a[0]), { id: a[1], page: a[2], label: a[3] }); break;
            case 'unbookmark': next = removeBookmark(current, doc(a[0]), a[1]); break;
            case 'annotate': next = upsertAnnotation(current, doc(a[0]), { id: a[1], page: a[2], x: a[3], y: a[3], text: a[4] }, NOW); break;
            case 'unannotate': next = removeAnnotation(current, doc(a[0]), a[1]); break;
            case 'calibrate': next = setCalibration(current, doc(a[0]), a[1]); break;
            case 'alias': next = setAlias(current, a[0], a[1], a[2]); break;
            case 'unalias': next = removeAlias(current, a[0], a[1]); break;
            case 'pages': next = setPageCount(current, doc(a[0]), a[1]); break;
            case 'touch': next = touch(current, a[0]); break;
            case 'reconcile': next = reconcileManifest(current); break;
            case 'relink': { const result = relinkDocument(current, doc(a[0]), { path: a[1], key: a[3] === 'x' ? 'y' : (a[2] ? current.documents[a[0] % Math.max(1, current.documents.length)]?.key ?? a[3] : a[3]) }); next = result.manifest; break; }
            case 'locate': next = applyLocateResults(current, [{ id: doc(a[0]), status: a[1], path: a[2], key: a[3] }]).manifest; break;
            default: throw new Error(`unknown operation ${op.kind}`);
          }
        } catch (error) {
          expect(error).toBeInstanceOf(WorkspaceError);
          expect(JSON.stringify(current)).toBe(snapshot);
          continue;
        }
        // An operation never edits its input.
        expect(JSON.stringify(before)).toBe(snapshot);
        if (next !== before) {
          const key = next.board.key;
          expect(validateManifest(next, key)).toEqual(next);
          expect(JSON.stringify(native.validateManifest(next, key))).toBe(JSON.stringify(validateManifest(next, key)));
          expect(validateManifest(JSON.parse(JSON.stringify(next)), key)).toEqual(next);
        }
        current = next;
      }
    }), params(250));
  });

  it('removing a document leaves no reference to it, and reconcileManifest is idempotent', () => {
    fc.assert(fc.property(manifest(), fc.nat({ max: 10 }), (m, pick) => {
      if (m.documents.length === 0) return;
      const gone = m.documents[pick % m.documents.length].id;
      const removed = removeDocument(m, gone);
      expect(removed.documents.some(d => d.id === gone)).toBe(false);
      expect(removed.split.right?.id).not.toBe(gone);
      expect(Object.hasOwn(removed.cameras, gone)).toBe(false);
      const clean = reconcileManifest(removed);
      expect(reconcileManifest(clean)).toBe(clean);
      for (const id of Object.keys(clean.cameras)) expect(id === 'board' || clean.documents.some(d => d.id === id)).toBe(true);
    }), params(150));
  });
});

describe('portable paths', () => {
  it('relativeToBoard and resolveRelative are inverse for a document beside or below the board file, and never reach outside the board directory', () => {
    fc.assert(fc.property(fc.oneof(posixPath, windowsPath), fc.array(segment, { minLength: 1, maxLength: 3 }), fc.boolean(), (boardPath, below, upper) => {
      const windows = boardPath.includes(':');
      const separator = windows ? '\\' : '/';
      const directory = boardPath.slice(0, boardPath.lastIndexOf(separator));
      fc.pre(directory.length > 0 && !(windows && directory.length <= 2));
      const docPath = `${directory}${separator}${below.join(separator)}`;
      const relative = relativeToBoard(boardPath, docPath);
      if (relative === null) return; // a segment that is not portable (reserved device name, trailing dot...) is refused
      expect(relative.split('/')).toEqual(below);
      expect(relative.startsWith('/') || relative.split('/').some(part => part === '..' || part === '.' || part === '')).toBe(false);
      const back = resolveRelative(boardPath, relative);
      expect(back).not.toBeNull();
      if (windows) expect((back as string).toLowerCase()).toBe(docPath.toLowerCase()); else expect(back).toBe(docPath);
      // On a POSIX board a different case is a different directory (names are case-sensitive there).
      if (!windows && upper && directory.toUpperCase() !== directory) expect(relativeToBoard(boardPath, `${directory.toUpperCase()}${separator}${below.join(separator)}`)).toBeNull();
      // Another path style is never "below".
      expect(relativeToBoard(windows ? '/x/board.brd' : 'C:\\x\\board.brd', docPath)).toBeNull();
    }), params(300));
  });

  it('resolveRelative refuses anything that could leave the board directory and never throws', () => {
    const hostile = fc.oneof(fc.string({ maxLength: 40 }), fc.constantFrom('..', '../x', 'a/../b', '/etc/passwd', 'C:\\x', 'a//b', 'a/', '', './a', 'con', 'a/NUL.txt', 'a\\b', 'x:y', 'a b ', 'a.', '\u0000'), fc.array(fc.constantFrom('a', '..', '.', '', 'b'), { maxLength: 5 }).map(parts => parts.join('/')));
    fc.assert(fc.property(fc.oneof(posixPath, windowsPath, fc.string({ maxLength: 20 })), hostile, (boardPath, relative) => {
      const resolved = resolveRelative(boardPath, relative);
      if (resolved === null) return;
      expect(relative.split('/').some(part => part === '..' || part === '.' || part === '')).toBe(false);
      expect(/[\u0000-\u001f]/.test(resolved)).toBe(false);
      const windows = /^[A-Za-z]:[\\/]/.test(boardPath);
      // The directory of the board file: a backslash separates only on a drive-letter path (on a POSIX path it is a legal file name character).
      const board = boardPath.slice(0, windows ? Math.max(boardPath.lastIndexOf('/'), boardPath.lastIndexOf('\\')) : boardPath.lastIndexOf('/'));
      expect((windows ? resolved.toLowerCase().replace(/\\/g, '/') : resolved).startsWith(windows ? board.toLowerCase().replace(/\\/g, '/') : board)).toBe(true);
    }), params(400));
  });
});

describe('notes: renderer == native, canonical, idempotent', () => {
  it('validates the same lists in both implementations, and what it accepts is canonical and survives JSON', () => {
    fc.assert(fc.property(rawNotes, fc.option(mutation, { nil: undefined }), (list, change) => {
      const raw = change ? mutate(list, change.choices, change.action, change.value) : list;
      const a = ours(() => validateNotes(raw)), b = theirs(() => native.validateNotes(raw));
      expect(a).toEqual(b);
      if (!a.ok) { expect(a.typed).toBe(true); expect(noteCodes.has(a.code as string)).toBe(true); return; }
      const notes = JSON.parse(a.json) as BoardNote[];
      expect(JSON.stringify(validateNotes(notes))).toBe(a.json);
      // One note per target, ids unique, keyed targets canonical.
      expect(new Set(notes.map(n => n.id)).size).toBe(notes.length);
      const targets = notes.map(n => (isKeyedNote(n) ? `K${noteKeyText(n.target)}` : `L${(n as { componentId: string }).componentId}\u0000${(n as { pinId?: string }).pinId ?? ''}`));
      expect(new Set(targets).size).toBe(targets.length);
      for (const n of notes) if (isKeyedNote(n)) { expect(noteTarget(n.target)).toEqual(n.target); expect(n.target.ref === undefined || n.target.ref === normalizeName(n.target.ref)).toBe(true); }
    }), params(600));
  });

  it('the twin helpers of the native module are the renderer\'s: escape, text form and name normalization', () => {
    const anyText = fc.string({ maxLength: 20 });
    fc.assert(fc.property(anyText, name => {
      expect(native.escapeKeyName(name)).toBe(escapeKeyName(name));
      expect(native.normalizeName(name)).toBe(normalizeName(name));
    }), params(300));
    fc.assert(fc.property(rawKey, key => {
      let canonical: NoteKey;
      try { canonical = noteTarget(key as NoteKey); } catch { return; }
      expect(native.noteKeyText(canonical)).toBe(noteKeyText(canonical));
    }), params(300));
  });

  const patchArb = fc.record({ text: fc.option(fc.oneof(text(40), fc.constantFrom('', '  ', ' x ')), { nil: undefined }), measurements: fc.option(fc.oneof(fc.constant(null), measurement), { nil: undefined }) })
    .map(p => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
  const targetArb = fc.oneof(
    fc.record({ ref: fc.constantFrom('R1', 'R2', 'U1') }), fc.record({ ref: fc.constantFrom('R1', 'U1'), pin: fc.constantFrom('1', '2', 'A') }),
    fc.record({ ref: fc.constantFrom('R1', 'U1'), at: fc.record({ side: fc.constantFrom('top' as const, 'bottom' as const), x: fc.constantFrom(0, 1.5, -2), y: fc.constantFrom(0, 3) }) }),
    fc.record({ at: fc.record({ side: fc.constantFrom('top' as const, 'both' as const), x: fc.constantFrom(0, 1.5), y: fc.constantFrom(0, 3) }), pinAt: fc.record({ side: fc.constant('top' as const), x: fc.constantFrom(0, 0.001), y: fc.constant(0) }) }),
  );

  it('upsertNote and removeNote always leave a list the validators accept unchanged: one note per target, trimmed text, no empty notes', () => {
    fc.assert(fc.property(fc.array(fc.tuple(targetArb, patchArb, fc.boolean()), { minLength: 1, maxLength: 14 }), steps => {
      let notes: BoardNote[] = [];
      let counter = 0;
      for (const [target, patch, remove] of steps) {
        const before = JSON.stringify(notes);
        if (remove && notes.length) { const gone = removeNote(notes, notes[counter % notes.length].id); notes = gone; counter++; continue; }
        try { notes = upsertNote(notes, target as NoteKey, patch as { text?: string; measurements?: null }, NOW, () => `id-${++counter}`); }
        catch (error) { expect(error).toBeInstanceOf(WorkspaceError); expect(JSON.stringify(notes)).toBe(before); continue; }
        const canonical = noteTarget(target as NoteKey);
        const found = noteFor(notes, canonical);
        if (found) { expect(found.text).toBe(found.text.trim()); expect(found.text !== '' || found.measurements !== undefined).toBe(true); }
        expect(JSON.stringify(validateNotes(notes))).toBe(JSON.stringify(notes));
        expect(JSON.stringify(native.validateNotes(notes))).toBe(JSON.stringify(notes));
        expect(notes.filter(n => isKeyedNote(n) && noteKeyText(n.target) === noteKeyText(canonical)).length).toBeLessThanOrEqual(1);
      }
    }), params(250));
  });
});
