import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_LIMITS } from './documents';
import type { DocumentLocateResult, DocumentRecord, WorkspaceManifest } from './documents';
import type { BoardNote } from './types';
import {
  BOARD_SOURCE, WORKSPACE_MODEL_LIMITS, WorkspaceError, acceptChangedDocument, addDocument, applyLocateResults, boardIdentityKey,
  createManifest, createWorkspaceSaver, noteFor, noteTarget, reconcileManifest, relativeToBoard, relinkDocument, removeAlias,
  removeAnnotation, removeBookmark, removeDocument, resolveRelative, setActiveTab, setAlias, setCalibration, setCamera, setPageCount,
  setSplit, touch, upsertAnnotation, upsertBookmark, upsertNote, validateKey, validateManifest, validateNotes,
} from './workspace';
import type { SaveFailure, SaverState } from './workspace';

// The native twins are CommonJS; they are loaded lazily so that a missing file only fails the parity tests.
const nodeRequire = createRequire(import.meta.url);
const nativeWorkspace = () => nodeRequire('../../electron/workspace.cjs');
const nativeIdentity = () => nodeRequire('../../electron/identity.cjs');

// ---------------------------------------------------------------------------------------------
// Fixtures (original, synthetic)
// ---------------------------------------------------------------------------------------------

const hexKey = (n: number) => n.toString(16).padStart(64, '0');
const BOARD_KEY = hexKey(0xb0a2d);
const T0 = '2026-10-05T10:00:00.000Z';
const T1 = '2026-10-05T11:30:00.000Z';
const BOARD_PATH = '/home/tech/repairs/rev-b/main.brd';

const boardOf = (key = BOARD_KEY) => ({ key, name: 'main.brd', path: BOARD_PATH, format: 'GENCAD 1.4' });
const record = (index: number, over: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id: `doc-${index}`, kind: 'pdf', name: `sheet-${index}.pdf`, path: `/home/tech/repairs/rev-b/docs/sheet-${index}.pdf`,
  relativePath: `docs/sheet-${index}.pdf`, key: hexKey(1000 + index), size: 4096 + index, pageCount: 3,
  bookmarks: [], annotations: [], addedAt: T0, ...over,
});
const manifestOf = (over: Partial<WorkspaceManifest> = {}): WorkspaceManifest => ({
  version: 1, board: boardOf(), documents: [], split: { enabled: false, ratio: 0.5, right: null }, activeTab: 'board', cameras: {}, updatedAt: T0, ...over,
});
const clone = <T,>(value: T): T => structuredClone(value);
const ids = (prefix: string) => { let n = 0; return () => `${prefix}-${++n}`; };

const expectCode = (fn: () => unknown, code: string) => {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).code).toBe(code);
    return;
  }
  throw new Error(`expected WorkspaceError ${code}, nothing was thrown`);
};

// ---------------------------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------------------------

describe('validateKey', () => {
  it('accepts lowercase 64-digit hex only', () => {
    expect(validateKey(BOARD_KEY)).toBe(BOARD_KEY);
    for (const bad of ['', BOARD_KEY.toUpperCase(), BOARD_KEY.slice(1), `${BOARD_KEY}0`, 'g'.repeat(64), 42, null, undefined, {}]) {
      expectCode(() => validateKey(bad), 'INVALID_KEY');
    }
  });
});

describe('validateManifest', () => {
  const rich = (): WorkspaceManifest => manifestOf({
    documents: [
      record(1, {
        bookmarks: [{ id: 'bm-1', page: 2, label: 'PMIC rails', x: 10.5, y: 4 }, { id: 'bm-2', page: 0, label: '' }],
        annotations: [{ id: 'an-1', page: 1, x: 1, y: 2, text: 'check C12', updatedAt: T1 }],
      }),
      record(2, { kind: 'image', calibration: { pixelsPerMm: 12.5, confirmed: true }, missing: true }),
      record(3, { kind: 'schematic' }),
    ],
    split: { enabled: true, ratio: 0.35, right: { kind: 'schematic', id: 'doc-3' } },
    activeTab: 'documents',
    cameras: { board: { zoom: 2, x: 1, y: -3, rotation: 90, side: 'bottom' }, 'doc-1': { page: 2, zoom: 1.25 } },
    aliases: { refs: { U1A: 'U1' }, nets: { VDD_MAIN: 'PP_VDD' } },
  });

  it('round-trips a rich manifest unchanged', () => {
    expect(validateManifest(clone(rich()), BOARD_KEY)).toEqual(rich());
  });

  it('drops unknown fields and clamps the split ratio', () => {
    const raw = { ...clone(rich()), extra: 1, split: { enabled: true, ratio: 7, right: null, junk: true } } as unknown;
    const out = validateManifest(raw, BOARD_KEY) as WorkspaceManifest & { extra?: unknown };
    expect(out.extra).toBeUndefined();
    expect(out.split).toEqual({ enabled: true, ratio: 0.8, right: null });
    expect(validateManifest({ ...clone(rich()), split: { enabled: false, ratio: -1, right: null } }, BOARD_KEY).split.ratio).toBe(0.2);
  });

  it('rejects a manifest of another board with BOARD_MISMATCH and an invalid expected key with INVALID_KEY', () => {
    expectCode(() => validateManifest(rich(), hexKey(7)), 'BOARD_MISMATCH');
    expectCode(() => validateManifest(rich(), 'nope'), 'INVALID_KEY');
  });

  it('rejects malformed shapes with MANIFEST_INVALID naming the field', () => {
    const failing: Array<[string, (m: any) => void]> = [
      ['version', m => { m.version = 2; }],
      ['board.key', m => { m.board.key = 'x'; }],
      ['documents', m => { m.documents = {}; }],
      ['documents[0].kind', m => { m.documents[0].kind = 'doc'; }],
      ['documents[0].size', m => { m.documents[0].size = -1; }],
      ['documents[0].pageCount', m => { m.documents[0].pageCount = 0; }],
      ['documents[1].id', m => { m.documents[1].id = m.documents[0].id; }],
      ['documents[0].bookmarks[1].id', m => { m.documents[0].bookmarks[1].id = 'bm-1'; }],
      ['documents[0].annotations[0].updatedAt', m => { m.documents[0].annotations[0].updatedAt = 'yesterday'; }],
      ['documents[1].calibration', m => { m.documents[1].calibration.confirmed = false; }],
      ['documents[1].missing', m => { m.documents[1].missing = 'yes'; }],
      ['split.enabled', m => { m.split.enabled = 1; }],
      ['split.right.kind', m => { m.split.right.kind = 'pdf'; }],
      ['activeTab', m => { m.activeTab = 'notes'; }],
      ['cameras["doc-1"].zoom', m => { m.cameras['doc-1'].zoom = 0; }],
      ['cameras["board"].side', m => { m.cameras.board.side = 'left'; }],
      ['aliases.refs[0]', m => { m.aliases.refs.U1A = 5; }],
      ['updatedAt', m => { delete m.updatedAt; }],
    ];
    for (const [field, mutate] of failing) {
      const raw = clone(rich());
      mutate(raw);
      try { validateManifest(raw, BOARD_KEY); } catch (error) {
        expect((error as WorkspaceError).code).toBe('MANIFEST_INVALID');
        expect((error as Error).message).toBe(`Invalid workspace manifest: ${field}.`);
        continue;
      }
      throw new Error(`accepted a manifest with a bad ${field}`);
    }
  });

  it('enforces every count bound at the boundary', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => record(i));
    expect(validateManifest(manifestOf({ documents: many(WORKSPACE_LIMITS.documents) }), BOARD_KEY).documents).toHaveLength(200);
    expectCode(() => validateManifest(manifestOf({ documents: many(WORKSPACE_LIMITS.documents + 1) }), BOARD_KEY), 'MANIFEST_INVALID');
    const cameras = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, { zoom: 1 }]));
    expect(Object.keys(validateManifest(manifestOf({ cameras: cameras(WORKSPACE_LIMITS.cameras) }), BOARD_KEY).cameras)).toHaveLength(256);
    expectCode(() => validateManifest(manifestOf({ cameras: cameras(WORKSPACE_LIMITS.cameras + 1) }), BOARD_KEY), 'MANIFEST_INVALID');
    const aliasMap = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`N${i}`, `M${i}`]));
    expect(Object.keys(validateManifest(manifestOf({ aliases: { refs: aliasMap(WORKSPACE_LIMITS.aliases), nets: {} } }), BOARD_KEY).aliases!.refs)).toHaveLength(1000);
    expectCode(() => validateManifest(manifestOf({ aliases: { refs: aliasMap(WORKSPACE_LIMITS.aliases + 1), nets: {} } }), BOARD_KEY), 'MANIFEST_INVALID');
  });

  it('keeps a __proto__ key as plain data and never rewires a prototype', () => {
    const raw = JSON.parse(`{"version":1,"board":${JSON.stringify(boardOf())},"documents":[],"split":{"enabled":false,"ratio":0.5,"right":null},"activeTab":"board","cameras":{"__proto__":{"zoom":2}},"aliases":{"refs":{"__proto__":"U1"},"nets":{}},"updatedAt":"${T0}"}`);
    const out = validateManifest(raw, BOARD_KEY);
    expect(Object.keys(out.cameras)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(out.cameras)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(out.aliases!.refs)).toBe(Object.prototype);
    expect(Object.keys(out.aliases!.refs)).toEqual(['__proto__']);
    expect(({} as { zoom?: number }).zoom).toBeUndefined();
    expect(JSON.stringify(out.cameras)).toBe('{"__proto__":{"zoom":2}}');
  });
});

describe('validateNotes (B15: one note per target)', () => {
  const note = (over: Partial<BoardNote> = {}): BoardNote => ({ id: 'n1', componentId: 'U1', text: 'hot', updatedAt: T0, ...over });

  it('accepts component notes, pin notes and measurements, and normalizes empty measurements away', () => {
    const list = [note(), note({ id: 'n2', pinId: 'U1.3', measurements: { voltage: '1.8 V', other: '' } }), note({ id: 'n3', componentId: 'C5', measurements: {} })];
    expect(validateNotes(clone(list))).toEqual([
      note(), note({ id: 'n2', pinId: 'U1.3', measurements: { voltage: '1.8 V', other: '' } }), note({ id: 'n3', componentId: 'C5' }),
    ]);
    expect(validateNotes([])).toEqual([]);
  });

  it('rejects duplicate note ids, duplicate component notes and duplicate pin notes as malformed input', () => {
    expect(() => validateNotes([note(), note()])).toThrow('Invalid notes: notes[1].id (duplicate).');
    expect(() => validateNotes([note(), note({ id: 'n2' })])).toThrow('notes[1].componentId (duplicate note for this component)');
    expect(() => validateNotes([note({ pinId: 'U1.3' }), note({ id: 'n2', pinId: 'U1.3' })])).toThrow('notes[1].pinId (duplicate note for this pin)');
    expect(validateNotes([note(), note({ id: 'n2', pinId: 'U1.3' }), note({ id: 'n3', pinId: 'U1.4' })])).toHaveLength(3);
  });

  it('enforces bounds with stable codes', () => {
    expectCode(() => validateNotes({}), 'NOTES_INVALID');
    expectCode(() => validateNotes([null]), 'NOTES_INVALID');
    expectCode(() => validateNotes([note({ text: 'x'.repeat(8001) })]), 'NOTES_INVALID');
    expect(validateNotes([note({ text: 'x'.repeat(8000) })])).toHaveLength(1);
    expectCode(() => validateNotes([note({ pinId: '' })]), 'NOTES_INVALID');
    expectCode(() => validateNotes([note({ measurements: { voltage: 'v'.repeat(65) } })]), 'NOTES_INVALID');
    expect(validateNotes([note({ measurements: { voltage: 'v'.repeat(64) } })])).toHaveLength(1);
    const many = (n: number) => Array.from({ length: n }, (_, i) => note({ id: `n${i}`, componentId: `C${i}` }));
    expect(validateNotes(many(500))).toHaveLength(500);
    expectCode(() => validateNotes(many(501)), 'TOO_MANY_NOTES');
  });
});

// ---------------------------------------------------------------------------------------------
// Parity with electron/workspace.cjs
// ---------------------------------------------------------------------------------------------

describe('parity with electron/workspace.cjs', () => {
  type Outcome = { ok: true; json: string } | { ok: false; code: unknown; message: string };
  const outcome = (fn: () => unknown): Outcome => {
    try { return { ok: true, json: JSON.stringify(fn()) }; }
    catch (error) { return { ok: false, code: (error as { code?: unknown }).code, message: (error as Error).message }; }
  };
  const bothAgree = (label: string, ours: () => unknown, theirs: () => unknown) => {
    const a = outcome(ours);
    const b = outcome(theirs);
    expect({ label, ...a }).toEqual({ label, ...b });
  };

  const longText = (n: number) => 'a'.repeat(n);
  const stamp = (length: number) => `2026-10-05T10:00:00.${'0'.repeat(length - 21)}Z`;
  const mutated = (mutate: (m: any) => void, base: unknown = manifestOf({
    documents: [record(1, { bookmarks: [{ id: 'b1', page: 1, label: 'x', x: 1, y: 2 }], annotations: [{ id: 'a1', page: 1, x: 1, y: 2, text: 't', updatedAt: T1 }] }), record(2, { kind: 'image' })],
    split: { enabled: true, ratio: 0.4, right: { kind: 'document', id: 'doc-1' } }, cameras: { board: { zoom: 1 }, 'doc-1': { page: 1 } },
  })) => { const value: any = clone(base); mutate(value); return value; };
  const aliasMap = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`N${i}`, `M${i}`]));
  const manyDocs = (n: number) => Array.from({ length: n }, (_, i) => record(i));
  const manyBookmarks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, page: i % 5, label: 'l' }));
  const manyAnnotations = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, page: 1, x: 0, y: 0, text: '', updatedAt: T0 }));
  const cameraSet = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, { zoom: 1 }]));

  const manifestCorpus: Array<[string, unknown]> = [
    ['minimal', manifestOf()],
    ['rich', mutated(() => {})],
    ['unknown fields', mutated(m => { m.extra = 1; m.board.extra = 2; m.documents[0].extra = 3; m.split.extra = 4; })],
    ['not an object', 'text'], ['null', null], ['array', []], ['version 2', mutated(m => { m.version = 2; })],
    ['board mismatch', mutated(m => { m.board.key = hexKey(9); })],
    ['document id is the reserved board camera key (B41)', mutated(m => { m.documents[0].id = 'board'; })],
    ['board key uppercase', mutated(m => { m.board.key = BOARD_KEY.toUpperCase(); })],
    ['board missing', mutated(m => { delete m.board; })],
    ['board name 8000', mutated(m => { m.board.name = longText(8000); })],
    ['board name 8001', mutated(m => { m.board.name = longText(8001); })],
    ['board name empty', mutated(m => { m.board.name = ''; })],
    ['board path 32767', mutated(m => { m.board.path = longText(32767); })],
    ['board path 32768', mutated(m => { m.board.path = longText(32768); })],
    ['board format 8001', mutated(m => { m.board.format = longText(8001); })],
    ['documents 200', mutated(m => { m.documents = manyDocs(200); })],
    ['documents 201', mutated(m => { m.documents = manyDocs(201); })],
    ['documents not array', mutated(m => { m.documents = 'x'; })],
    ['duplicate document ids', mutated(m => { m.documents[1].id = m.documents[0].id; })],
    ['document id 128', mutated(m => { m.documents[0].id = longText(128); })],
    ['document id 129', mutated(m => { m.documents[0].id = longText(129); })],
    ['document id empty', mutated(m => { m.documents[0].id = ''; })],
    ['document kind', mutated(m => { m.documents[0].kind = 'archive'; })],
    ['document name empty', mutated(m => { m.documents[0].name = ''; })],
    ['document path 32768', mutated(m => { m.documents[0].path = longText(32768); })],
    ['relativePath 32767', mutated(m => { m.documents[0].relativePath = longText(32767); })],
    ['relativePath 32768', mutated(m => { m.documents[0].relativePath = longText(32768); })],
    ['relativePath empty', mutated(m => { m.documents[0].relativePath = ''; })],
    ['document key short', mutated(m => { m.documents[0].key = 'abc'; })],
    ['size 0', mutated(m => { m.documents[0].size = 0; })],
    ['size max safe', mutated(m => { m.documents[0].size = Number.MAX_SAFE_INTEGER; })],
    ['size beyond safe', mutated(m => { m.documents[0].size = Number.MAX_SAFE_INTEGER + 2; })],
    ['size fractional', mutated(m => { m.documents[0].size = 1.5; })],
    ['size negative', mutated(m => { m.documents[0].size = -1; })],
    ['size string', mutated(m => { m.documents[0].size = '4'; })],
    ['pageCount 0', mutated(m => { m.documents[0].pageCount = 0; })],
    ['pageCount 1', mutated(m => { m.documents[0].pageCount = 1; })],
    ['pageCount 1e6', mutated(m => { m.documents[0].pageCount = 1_000_000; })],
    ['pageCount 1e6+1', mutated(m => { m.documents[0].pageCount = 1_000_001; })],
    ['bookmarks 2000', mutated(m => { m.documents[0].bookmarks = manyBookmarks(2000); })],
    ['bookmarks 2001', mutated(m => { m.documents[0].bookmarks = manyBookmarks(2001); })],
    ['bookmarks missing', mutated(m => { delete m.documents[0].bookmarks; })],
    ['bookmark duplicate id', mutated(m => { m.documents[0].bookmarks.push({ id: 'b1', page: 2, label: 'dup' }); })],
    ['bookmark page 1e6', mutated(m => { m.documents[0].bookmarks[0].page = 1_000_000; })],
    ['bookmark page 1e6+1', mutated(m => { m.documents[0].bookmarks[0].page = 1_000_001; })],
    ['bookmark page 0', mutated(m => { m.documents[0].bookmarks[0].page = 0; })],
    ['bookmark label empty', mutated(m => { m.documents[0].bookmarks[0].label = ''; })],
    ['bookmark label 8001', mutated(m => { m.documents[0].bookmarks[0].label = longText(8001); })],
    ['bookmark x null', mutated(m => { m.documents[0].bookmarks[0].x = null; })],
    ['bookmark x NaN', mutated(m => { m.documents[0].bookmarks[0].x = NaN; })],
    ['bookmark y Infinity', mutated(m => { m.documents[0].bookmarks[0].y = Infinity; })],
    ['bookmark not object', mutated(m => { m.documents[0].bookmarks = [3]; })],
    ['annotations 2000', mutated(m => { m.documents[0].annotations = manyAnnotations(2000); })],
    ['annotations 2001', mutated(m => { m.documents[0].annotations = manyAnnotations(2001); })],
    ['annotation duplicate id', mutated(m => { m.documents[0].annotations.push({ id: 'a1', page: 1, x: 0, y: 0, text: '', updatedAt: T0 }); })],
    ['annotation text 8001', mutated(m => { m.documents[0].annotations[0].text = longText(8001); })],
    ['annotation x missing', mutated(m => { delete m.documents[0].annotations[0].x; })],
    ['annotation updatedAt bad', mutated(m => { m.documents[0].annotations[0].updatedAt = 'soon'; })],
    ['addedAt 40', mutated(m => { m.documents[0].addedAt = stamp(40); })],
    ['addedAt 41', mutated(m => { m.documents[0].addedAt = stamp(41); })],
    ['addedAt empty', mutated(m => { m.documents[0].addedAt = ''; })],
    ['addedAt number', mutated(m => { m.documents[0].addedAt = 1759658400000; })],
    ['missing true', mutated(m => { m.documents[0].missing = true; })],
    ['missing false', mutated(m => { m.documents[0].missing = false; })],
    ['missing string', mutated(m => { m.documents[0].missing = 'no'; })],
    ['calibration confirmed', mutated(m => { m.documents[1].calibration = { pixelsPerMm: 8, confirmed: true, extra: 1 }; })],
    ['calibration unconfirmed', mutated(m => { m.documents[1].calibration = { pixelsPerMm: 8, confirmed: false }; })],
    ['calibration zero', mutated(m => { m.documents[1].calibration = { pixelsPerMm: 0, confirmed: true }; })],
    ['calibration missing flag', mutated(m => { m.documents[1].calibration = { pixelsPerMm: 8 }; })],
    ['calibration null', mutated(m => { m.documents[1].calibration = null; })],
    ['split ratio low', mutated(m => { m.split.ratio = 0.05; })],
    ['split ratio high', mutated(m => { m.split.ratio = 3; })],
    ['split ratio edge', mutated(m => { m.split.ratio = 0.8; })],
    ['split ratio NaN', mutated(m => { m.split.ratio = NaN; })],
    ['split ratio string', mutated(m => { m.split.ratio = '0.5'; })],
    ['split enabled not boolean', mutated(m => { m.split.enabled = 'true'; })],
    ['split right null', mutated(m => { m.split.right = null; })],
    ['split right undefined', mutated(m => { delete m.split.right; })],
    ['split right schematic', mutated(m => { m.split.right = { kind: 'schematic', id: 'nope' }; })],
    ['split right bad kind', mutated(m => { m.split.right.kind = 'image'; })],
    ['split right id empty', mutated(m => { m.split.right.id = ''; })],
    ['split missing', mutated(m => { delete m.split; })],
    ['tab schematic', mutated(m => { m.activeTab = 'schematic'; })],
    ['tab invalid', mutated(m => { m.activeTab = 'settings'; })],
    ['cameras 256', mutated(m => { m.cameras = cameraSet(256); })],
    ['cameras 257', mutated(m => { m.cameras = cameraSet(257); })],
    ['cameras array', mutated(m => { m.cameras = []; })],
    ['camera key 128', mutated(m => { m.cameras = { [longText(128)]: { zoom: 1 } }; })],
    ['camera key 129', mutated(m => { m.cameras = { [longText(129)]: { zoom: 1 } }; })],
    ['camera key empty', mutated(m => { m.cameras = { '': { zoom: 1 } }; })],
    ['camera full', mutated(m => { m.cameras.board = { page: 0, zoom: 0.01, rotation: -90, x: 1e9, y: -1e9, extra: 1 }; })],
    ['camera empty', mutated(m => { m.cameras.board = {}; })],
    // W-win-viewers-01: `fit` is kept for exactly 'width' | 'page' | 'none' and dropped (not rejected) for anything else, identically in both validators.
    ['camera fit width', mutated(m => { m.cameras['doc-1'] = { page: 2, zoom: 0.585, rotation: 0, x: 3, y: 4, fit: 'width' }; })],
    ['camera fit page', mutated(m => { m.cameras['doc-1'] = { page: 2, zoom: 0.5, fit: 'page' }; })],
    ['camera fit none', mutated(m => { m.cameras['doc-1'] = { zoom: 1.5, fit: 'none' }; })],
    ['camera fit only', mutated(m => { m.cameras['doc-1'] = { fit: 'width' }; })],
    ['camera fit unknown word', mutated(m => { m.cameras['doc-1'] = { zoom: 2, fit: 'fill' }; })],
    ['camera fit wrong case', mutated(m => { m.cameras['doc-1'] = { zoom: 2, fit: 'Width' }; })],
    ['camera fit number', mutated(m => { m.cameras['doc-1'] = { zoom: 2, fit: 1 }; })],
    ['camera fit null', mutated(m => { m.cameras['doc-1'] = { zoom: 2, fit: null }; })],
    ['camera fit object', mutated(m => { m.cameras['doc-1'] = { zoom: 2, fit: { mode: 'width' } }; })],
    ['camera fit on the board camera', mutated(m => { m.cameras.board = { zoom: 2, side: 'bottom', fit: 'page' }; })],
    ['camera zoom 0', mutated(m => { m.cameras.board.zoom = 0; })],
    ['camera zoom negative', mutated(m => { m.cameras.board.zoom = -1; })],
    ['camera zoom NaN', mutated(m => { m.cameras.board.zoom = NaN; })],
    ['camera page fractional', mutated(m => { m.cameras.board.page = 1.5; })],
    ['camera rotation string', mutated(m => { m.cameras.board.rotation = '90'; })],
    ['camera not object', mutated(m => { m.cameras.board = 5; })],
    ['updatedAt invalid', mutated(m => { m.updatedAt = 'tomorrow'; })],
    ['updatedAt missing', mutated(m => { delete m.updatedAt; })],
    ['updatedAt 40', mutated(m => { m.updatedAt = stamp(40); })],
    ['updatedAt 41', mutated(m => { m.updatedAt = stamp(41); })],
    ['aliases absent', mutated(() => {})],
    ['aliases empty', mutated(m => { m.aliases = { refs: {}, nets: {} }; })],
    ['aliases filled', mutated(m => { m.aliases = { refs: { U1A: 'U1', U1B: 'U1' }, nets: { VDD_MAIN: 'PP_VDD' } }; })],
    ['aliases refs 1000', mutated(m => { m.aliases = { refs: aliasMap(1000), nets: {} }; })],
    ['aliases refs 1001', mutated(m => { m.aliases = { refs: aliasMap(1001), nets: {} }; })],
    ['aliases nets 1000', mutated(m => { m.aliases = { refs: {}, nets: aliasMap(1000) }; })],
    ['aliases nets 1001', mutated(m => { m.aliases = { refs: {}, nets: aliasMap(1001) }; })],
    ['aliases both 1000', mutated(m => { m.aliases = { refs: aliasMap(1000), nets: aliasMap(1000) }; })],
    ['aliases not object', mutated(m => { m.aliases = []; })],
    ['aliases null', mutated(m => { m.aliases = null; })],
    ['aliases refs missing', mutated(m => { m.aliases = { nets: {} }; })],
    ['aliases nets missing', mutated(m => { m.aliases = { refs: {} }; })],
    ['aliases value empty', mutated(m => { m.aliases = { refs: { U1A: '' }, nets: {} }; })],
    ['aliases value number', mutated(m => { m.aliases = { refs: { U1A: 1 }, nets: {} }; })],
    ['aliases value 256', mutated(m => { m.aliases = { refs: { U1A: longText(256) }, nets: {} }; })],
    ['aliases value 257', mutated(m => { m.aliases = { refs: { U1A: longText(257) }, nets: {} }; })],
    ['aliases key 256', mutated(m => { m.aliases = { refs: {}, nets: { [longText(256)]: 'X' } }; })],
    ['aliases key 257', mutated(m => { m.aliases = { refs: {}, nets: { [longText(257)]: 'X' } }; })],
    ['aliases key empty', mutated(m => { m.aliases = { refs: { '': 'X' }, nets: {} }; })],
    ['aliases extra field', mutated(m => { m.aliases = { refs: {}, nets: {}, extra: 1 }; })],
  ];

  it('shares the numeric bounds', () => {
    const native = nativeWorkspace().LIMITS as Record<string, number>;
    for (const [name, value] of Object.entries(native)) {
      if (name in WORKSPACE_MODEL_LIMITS) expect({ name, value: (WORKSPACE_MODEL_LIMITS as Record<string, number>)[name] }).toEqual({ name, value });
    }
    expect(WORKSPACE_MODEL_LIMITS.path).toBe(WORKSPACE_LIMITS.pathLength);
  });

  it.each(manifestCorpus)('manifest: %s', (label, input) => {
    const native = nativeWorkspace();
    bothAgree(label, () => validateManifest(input, BOARD_KEY), () => native.validateManifest(input, BOARD_KEY));
  });

  it('manifest: a __proto__ camera or alias key is handled identically', () => {
    const native = nativeWorkspace();
    const raw = JSON.parse(`{"version":1,"board":${JSON.stringify(boardOf())},"documents":[],"split":{"enabled":false,"ratio":0.5,"right":null},"activeTab":"board","cameras":{"__proto__":{"zoom":2},"board":{"zoom":1}},"aliases":{"refs":{"__proto__":"U1"},"nets":{}},"updatedAt":"${T0}"}`);
    bothAgree('proto', () => validateManifest(raw, BOARD_KEY), () => native.validateManifest(raw, BOARD_KEY));
  });

  it('manifest: expected-key validation is identical', () => {
    const native = nativeWorkspace();
    for (const key of ['', 'x', BOARD_KEY.toUpperCase(), hexKey(5), 7, null, undefined]) {
      bothAgree(`expected ${String(key)}`, () => validateManifest(manifestOf(), key as string), () => native.validateManifest(manifestOf(), key));
    }
  });

  it('validateKey: identical accept/reject', () => {
    const native = nativeWorkspace();
    for (const key of [BOARD_KEY, hexKey(0), 'f'.repeat(64), 'F'.repeat(64), `${BOARD_KEY}\n`, ` ${BOARD_KEY}`, '', 5, null, {}, 'g'.repeat(64)]) {
      bothAgree(`key ${String(key)}`, () => validateKey(key), () => native.validateKey(key));
    }
  });

  const n = (over: Record<string, unknown> = {}) => ({ id: 'n1', componentId: 'U1', text: 'hot', updatedAt: T0, ...over });
  const manyNotes = (count: number) => Array.from({ length: count }, (_, i) => n({ id: `n${i}`, componentId: `C${i}` }));
  const notesCorpus: Array<[string, unknown]> = [
    ['empty', []], ['single', [n()]], ['not a list', {}], ['null', null], ['string', 'x'],
    ['500 notes', manyNotes(500)], ['501 notes', manyNotes(501)],
    ['null item', [null]], ['array item', [[]]], ['number item', [1]],
    ['id empty', [n({ id: '' })]], ['id 128', [n({ id: longText(128) })]], ['id 129', [n({ id: longText(129) })]], ['id number', [n({ id: 4 })]],
    ['duplicate id', [n(), n({ componentId: 'C1' })]],
    ['duplicate component', [n(), n({ id: 'n2' })]],
    ['duplicate component, pin variants', [n(), n({ id: 'n2', pinId: 'U1.1' }), n({ id: 'n3', pinId: 'U1.2' })]],
    ['duplicate pin', [n({ pinId: 'U1.1' }), n({ id: 'n2', pinId: 'U1.1' })]],
    ['pin only (no component note)', [n({ pinId: 'U1.1' })]],
    ['componentId empty', [n({ componentId: '' })]], ['componentId 256', [n({ componentId: longText(256) })]], ['componentId 257', [n({ componentId: longText(257) })]],
    ['pinId empty', [n({ pinId: '' })]], ['pinId 256', [n({ pinId: longText(256) })]], ['pinId 257', [n({ pinId: longText(257) })]], ['pinId number', [n({ pinId: 3 })]],
    ['text empty', [n({ text: '' })]], ['text 8000', [n({ text: longText(8000) })]], ['text 8001', [n({ text: longText(8001) })]], ['text number', [n({ text: 1 })]],
    ['updatedAt invalid', [n({ updatedAt: 'later' })]], ['updatedAt missing', [n({ updatedAt: undefined })]], ['updatedAt 41', [n({ updatedAt: stamp(41) })]],
    ['measurements full', [n({ measurements: { voltage: '1.8 V', resistance: '0.4 Ω', other: 'ok', ignored: 'x' } })]],
    ['measurements empty object', [n({ measurements: {} })]],
    ['measurements only unknown', [n({ measurements: { ignored: 'x' } })]],
    ['measurements empty strings', [n({ measurements: { voltage: '', resistance: '' } })]],
    ['measurement 64', [n({ measurements: { voltage: longText(64) } })]], ['measurement 65', [n({ measurements: { other: longText(65) } })]],
    ['measurements null', [n({ measurements: null })]], ['measurements array', [n({ measurements: [] })]], ['measurement number', [n({ measurements: { voltage: 1.8 } })]],
    ['unknown note fields dropped', [n({ extra: 1 })]],
  ];
  it.each(notesCorpus)('notes: %s', (label, input) => {
    const native = nativeWorkspace();
    bothAgree(label, () => validateNotes(input), () => native.validateNotes(input));
  });
});

// ---------------------------------------------------------------------------------------------
// Board identity key (B32)
// ---------------------------------------------------------------------------------------------

describe('boardIdentityKey', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const trio = () => ({
    format: { name: 'format.asc', data: bytes('FORMAT: parts, pins') },
    pins: { name: 'pins.asc', data: bytes('1 U1 1\n2 U1 2\n') },
    nails: { name: 'nails.asc', data: bytes('NAIL 1 NET_A 10 20') },
  });
  /** Independent reference of the contract: no code shared with the implementation. */
  const reference = (entries: Array<{ name: string; data: Uint8Array }>) => {
    if (entries.length === 1) return createHash('sha256').update(entries[0].data).digest('hex');
    const hash = createHash('sha256');
    for (const entry of [...entries].map(e => ({ name: e.name.toLowerCase(), data: e.data })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(entry.data.byteLength));
      hash.update(Buffer.from(entry.name, 'utf8')).update(Buffer.from([0])).update(length).update(entry.data);
    }
    return hash.digest('hex');
  };

  it('a single file is the plain SHA-256 of its bytes', async () => {
    expect(await boardIdentityKey([{ name: 'board.brd', data: bytes('abc') }])).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await boardIdentityKey([{ name: 'whatever.name', data: new Uint8Array(0) }])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('the complete companion set follows the documented encoding (known answer)', async () => {
    const { format, pins, nails } = trio();
    const key = await boardIdentityKey([format, pins, nails]);
    expect(key).toBe(reference([format, pins, nails]));
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    // Pinned so that an accidental change of the encoding (and with it every stored workspace) fails loudly.
    expect(key).toBe('82b548fbccdc7bb2461536a83d384fef395ac5b5d54b2ae1c81549f72c24e31f');
  });

  it('is the same key whichever entry file the technician picked, in any order, with any name casing or directory', async () => {
    const { format, pins, nails } = trio();
    const expected = await boardIdentityKey([format, pins, nails]);
    for (const order of [[format, pins, nails], [pins, nails, format], [nails, format, pins], [nails, pins, format]]) {
      expect(await boardIdentityKey(order)).toBe(expected);
    }
    expect(await boardIdentityKey([
      { name: 'C:\\repairs\\FORMAT.ASC', data: format.data }, { name: '/x/Pins.Asc', data: pins.data }, { name: 'NAILS.asc', data: nails.data },
    ])).toBe(expected);
  });

  it('changes when any byte of any file changes, or a file is added, removed or renamed', async () => {
    const { format, pins, nails } = trio();
    const base = await boardIdentityKey([format, pins, nails]);
    const seen = new Set([base]);
    const flip = (entry: { name: string; data: Uint8Array }, index: number) => {
      const data = entry.data.slice();
      data[index] ^= 1;
      return { name: entry.name, data };
    };
    for (const [target, index] of [[format, 0], [pins, 3], [nails, nails.data.length - 1]] as const) {
      const entries = [format, pins, nails].map(entry => (entry === target ? flip(entry, index) : entry));
      const key = await boardIdentityKey(entries);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    for (const entries of [[format, pins], [format, pins, nails, { name: 'extra.asc', data: bytes('x') }], [format, pins, { name: 'nails2.asc', data: nails.data }]]) {
      const key = await boardIdentityKey(entries);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('length prefixes keep entry boundaries unambiguous', async () => {
    const a = await boardIdentityKey([{ name: 'a.asc', data: bytes('xy') }, { name: 'b.asc', data: bytes('z') }]);
    const b = await boardIdentityKey([{ name: 'a.asc', data: bytes('x') }, { name: 'b.asc', data: bytes('yz') }]);
    expect(a).not.toBe(b);
  });

  it('rejects empty or oversized sets, malformed or nameless entries and ambiguous duplicates with stable codes', async () => {
    const entry = (name: string, text = '1') => ({ name, data: bytes(text) });
    await expect(boardIdentityKey([])).rejects.toMatchObject({ code: 'IDENTITY_INVALID_ENTRIES', message: 'A board identity needs between 1 and 64 files.' });
    await expect(boardIdentityKey(Array.from({ length: 65 }, (_, i) => entry(`f${i}.asc`)))).rejects.toMatchObject({ code: 'IDENTITY_INVALID_ENTRIES' });
    await expect(boardIdentityKey(Array.from({ length: 64 }, (_, i) => entry(`f${i}.asc`)))).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(boardIdentityKey([entry('a.asc'), entry('')])).rejects.toMatchObject({ code: 'IDENTITY_INVALID_ENTRIES', message: 'Invalid board file entry name.' });
    await expect(boardIdentityKey([entry('a.asc'), entry('dir/')])).rejects.toMatchObject({ code: 'IDENTITY_INVALID_ENTRIES' });
    await expect(boardIdentityKey([entry('a.asc'), entry('A.ASC', '2')])).rejects.toMatchObject({ code: 'IDENTITY_DUPLICATE_NAME', message: 'Two board files share one name.' });
    await expect(boardIdentityKey([entry('x/a.asc'), entry('y\\A.asc', '2')])).rejects.toMatchObject({ code: 'IDENTITY_DUPLICATE_NAME' });
    await expect(boardIdentityKey([{ name: 'a.asc', data: 'text' as unknown as Uint8Array }])).rejects.toMatchObject({ code: 'IDENTITY_INVALID_ENTRIES', message: 'Invalid board file entry.' });
    await expect(boardIdentityKey([{ name: 5 as unknown as string, data: bytes('x') }])).rejects.toMatchObject({ code: 'IDENTITY_INVALID_ENTRIES' });
    await expect(boardIdentityKey(null as unknown as [])).rejects.toMatchObject({ code: 'IDENTITY_INVALID_ENTRIES' });
  });

  it('hashes a view over a larger buffer by its own bytes only', async () => {
    const backing = new Uint8Array([9, 9, 97, 98, 99, 9]);
    expect(await boardIdentityKey([{ name: 'x.brd', data: backing.subarray(2, 5) }])).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const trio3 = [{ name: 'a.asc', data: backing.subarray(2, 3) }, { name: 'b.asc', data: backing.subarray(3, 5) }];
    expect(await boardIdentityKey(trio3)).toBe(await boardIdentityKey([{ name: 'a.asc', data: bytes('a') }, { name: 'b.asc', data: bytes('bc') }]));
  });

  it('is identical to electron/identity.cjs', async () => {
    const { boardKey } = nativeIdentity();
    const { format, pins, nails } = trio();
    const big = { name: 'big.bin', data: Uint8Array.from({ length: 70000 }, (_, i) => (i * 31) & 255) };
    const sets = [
      [{ name: 'board.brd', data: bytes('abc') }], [{ name: 'empty', data: new Uint8Array(0) }], [big],
      [format, pins, nails], [nails, format, pins], [pins, nails, format],
      [{ name: 'A.asc', data: bytes('1') }, { name: 'b.asc', data: big.data }], [{ name: 'é.asc', data: bytes('1') }, { name: 'z.asc', data: bytes('') }],
    ];
    for (const entries of sets) expect(await boardIdentityKey(entries)).toBe(await boardKey(entries));
  });

  it('fails like electron/identity.cjs on malformed sets (same code and message)', async () => {
    const { boardKey } = nativeIdentity();
    const bad: unknown[] = [
      [], null, 'abc', Array.from({ length: 65 }, (_, i) => ({ name: `f${i}`, data: bytes('x') })),
      [{ name: '', data: bytes('x') }], [{ name: 'dir/', data: bytes('x') }], [{ name: 'a', data: 'text' }], [{ name: 3, data: bytes('x') }], [null],
      [{ name: 'a.asc', data: bytes('1') }, { name: 'A.asc', data: bytes('2') }],
    ];
    const settle = async (fn: () => unknown) => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, code: (error as { code?: string }).code, message: (error as Error).message }; } };
    for (const entries of bad) {
      expect(await settle(() => boardIdentityKey(entries as never))).toEqual(await settle(() => boardKey(entries)));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Portable paths
// ---------------------------------------------------------------------------------------------

describe('relativeToBoard / resolveRelative', () => {
  it('relates documents beside or below the board file (POSIX)', () => {
    expect(relativeToBoard('/home/tech/rev-b/main.brd', '/home/tech/rev-b/sheet.pdf')).toBe('sheet.pdf');
    expect(relativeToBoard('/home/tech/rev-b/main.brd', '/home/tech/rev-b/docs/ref/sheet 1.pdf')).toBe('docs/ref/sheet 1.pdf');
    expect(relativeToBoard('/main.brd', '/docs/a.pdf')).toBe('docs/a.pdf');
  });

  it('returns null outside the board directory tree, for siblings of the directory and for lookalike prefixes', () => {
    expect(relativeToBoard('/home/tech/rev-b/main.brd', '/home/tech/other/sheet.pdf')).toBeNull();
    expect(relativeToBoard('/home/tech/rev-b/main.brd', '/home/tech/sheet.pdf')).toBeNull();
    expect(relativeToBoard('/home/tech/rev-b/main.brd', '/home/tech/rev-bad/sheet.pdf')).toBeNull();
    expect(relativeToBoard('/home/tech/rev-b/main.brd', '/home/tech/rev-b')).toBeNull();
    expect(relativeToBoard('/home/tech/rev-b/main.brd', '/home/tech/rev-b/')).toBeNull();
    expect(relativeToBoard('/home/tech/rev-b/main.brd', '/HOME/tech/rev-b/sheet.pdf')).toBeNull();
  });

  it('never produces or accepts traversal, relative or UNC inputs', () => {
    expect(relativeToBoard('/a/b/main.brd', '/a/b/../c/x.pdf')).toBeNull();
    expect(relativeToBoard('/a/b/main.brd', '/a/b/docs/../x.pdf')).toBeNull();
    expect(relativeToBoard('/a/b/main.brd', 'docs/x.pdf')).toBeNull();
    expect(relativeToBoard('main.brd', '/a/b/x.pdf')).toBeNull();
    expect(relativeToBoard('/a/b/main.brd', '//server/share/x.pdf')).toBeNull();
    expect(relativeToBoard('\\\\server\\share\\main.brd', '\\\\server\\share\\x.pdf')).toBeNull();
    expect(relativeToBoard('/a/b/main.brd', '/a/b/x\0.pdf')).toBeNull();
    expect(relativeToBoard('/a/b/main.brd', '')).toBeNull();
    expect(relativeToBoard('/a/b/main.brd', '/a/b/dir\\evil.pdf')).toBeNull();
  });

  it('handles Windows paths: drive letters, both separators, case-insensitive prefix, original casing of the document', () => {
    expect(relativeToBoard('C:\\Boards\\Rev B\\main.brd', 'C:\\Boards\\Rev B\\Docs\\Sheet.PDF')).toBe('Docs/Sheet.PDF');
    expect(relativeToBoard('C:\\Boards\\Rev B\\main.brd', 'c:/boards/rev b/Docs/Sheet.PDF')).toBe('Docs/Sheet.PDF');
    expect(relativeToBoard('C:/Boards/main.brd', 'C:\\Boards\\x.pdf')).toBe('x.pdf');
    expect(relativeToBoard('C:\\Boards\\main.brd', 'D:\\Boards\\x.pdf')).toBeNull();
    expect(relativeToBoard('C:\\Boards\\main.brd', 'C:\\Other\\x.pdf')).toBeNull();
    expect(relativeToBoard('C:\\Boards\\main.brd', 'C:x.pdf')).toBeNull();
    expect(relativeToBoard('C:\\main.brd', 'C:\\docs\\x.pdf')).toBe('docs/x.pdf');
  });

  it('does not mix path styles', () => {
    expect(relativeToBoard('C:\\Boards\\main.brd', '/Boards/x.pdf')).toBeNull();
    expect(relativeToBoard('/Boards/main.brd', 'C:\\Boards\\x.pdf')).toBeNull();
  });

  it('keeps POSIX case-sensitive and drops segments that would not be portable', () => {
    expect(relativeToBoard('/a/Rev/main.brd', '/a/rev/x.pdf')).toBeNull();
    expect(relativeToBoard('C:\\a\\main.brd', 'C:\\a\\nul.pdf')).toBeNull();
    expect(relativeToBoard('C:\\a\\main.brd', 'C:\\a\\x.pdf:stream')).toBeNull();
    expect(relativeToBoard('C:\\a\\main.brd', 'C:\\a\\trailing.')).toBeNull();
    expect(relativeToBoard('C:\\a\\main.brd', 'C:\\a\\what?.pdf')).toBeNull();
  });

  it('resolveRelative joins with the separator of the board path and round-trips relativeToBoard', () => {
    expect(resolveRelative('/home/tech/rev-b/main.brd', 'docs/sheet.pdf')).toBe('/home/tech/rev-b/docs/sheet.pdf');
    expect(resolveRelative('C:\\Boards\\Rev B\\main.brd', 'Docs/Sheet.PDF')).toBe('C:\\Boards\\Rev B\\Docs\\Sheet.PDF');
    expect(resolveRelative('/main.brd', 'a.pdf')).toBe('/a.pdf');
    expect(resolveRelative('C:\\main.brd', 'a.pdf')).toBe('C:\\a.pdf');
    for (const [board, doc] of [['/x/y/b.brd', '/x/y/z/q w.pdf'], ['D:\\x\\b.brd', 'd:\\X\\z\\Q.pdf']]) {
      const relative = relativeToBoard(board, doc)!;
      const back = resolveRelative(board, relative)!;
      expect(relativeToBoard(board, back)).toBe(relative);
    }
  });

  it('resolveRelative rejects traversal, absolute and malformed relative paths', () => {
    for (const bad of ['../x.pdf', 'docs/../../x.pdf', '..', '.', './x.pdf', 'docs//x.pdf', '/etc/passwd', 'C:/x.pdf', 'C:\\x.pdf', '\\x.pdf', 'docs\\x.pdf', 'x\0.pdf', '', 'docs/', 'a/\n/b']) {
      expect({ bad, posix: resolveRelative('/a/b/main.brd', bad) }).toEqual({ bad, posix: null });
      expect({ bad, windows: resolveRelative('C:\\a\\main.brd', bad) }).toEqual({ bad, windows: null });
    }
    expect(resolveRelative('/a/b/main.brd', 'docs/x:y.pdf')).toBe('/a/b/docs/x:y.pdf');
    expect(resolveRelative('C:\\a\\main.brd', 'docs/x:y.pdf')).toBeNull();
    expect(resolveRelative('C:\\a\\main.brd', 'docs/CON.pdf')).toBeNull();
    expect(resolveRelative('relative/main.brd', 'x.pdf')).toBeNull();
    expect(resolveRelative('/a/main.brd', 'x'.repeat(40000))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Manifest operations
// ---------------------------------------------------------------------------------------------

describe('manifest operations', () => {
  const base = () => createManifest(boardOf(), T0);
  const payload = (index: number, over: Record<string, unknown> = {}) => ({
    kind: 'pdf' as const, name: `sheet-${index}.pdf`, path: `/home/tech/repairs/rev-b/docs/sheet-${index}.pdf`, key: hexKey(2000 + index), size: 1000 + index, pageCount: 4, ...over,
  });
  const withDocs = (count = 3) => {
    let manifest = base();
    const newId = ids('doc');
    for (let i = 1; i <= count; i += 1) manifest = addDocument(manifest, payload(i, i === 3 ? { kind: 'schematic', pageCount: undefined } : {}), T0, newId).manifest;
    return manifest;
  };
  /** Everything the model returns must satisfy the native validator and be a fixed point of it. */
  const sane = (manifest: WorkspaceManifest) => {
    expect(validateManifest(clone(manifest), BOARD_KEY)).toEqual(manifest);
    return manifest;
  };

  describe('createManifest', () => {
    it('starts empty on the board tab and validates the board identity', () => {
      const manifest = sane(base());
      expect(manifest).toEqual({ version: 1, board: boardOf(), documents: [], split: { enabled: false, ratio: 0.5, right: null }, activeTab: 'board', cameras: {}, updatedAt: T0 });
      expectCode(() => createManifest({ ...boardOf(), path: '' }), 'MANIFEST_INVALID');
      expectCode(() => createManifest({ ...boardOf(), key: 'abc' }), 'MANIFEST_INVALID');
      expectCode(() => createManifest(boardOf(), 'never'), 'MANIFEST_INVALID');
      expect(createManifest(boardOf()).updatedAt).toMatch(/^\d{4}-/);
    });
  });

  describe('addDocument', () => {
    it("B41: never mints the reserved id 'board' (it is the board's own camera key) and an existing board camera stays intact", () => {
      const withCamera = setCamera(base(), 'board', { zoom: 2, x: 1, y: 2 });
      expect(() => addDocument(withCamera, payload(1), T1, () => 'board')).toThrow(WorkspaceError);
      const added = addDocument(withCamera, payload(1), T1, ids('doc'));
      const afterCamera = setCamera(added.manifest, added.document.id, { zoom: 3 });
      expect(afterCamera.cameras.board).toEqual({ zoom: 2, x: 1, y: 2 });
      expect(removeDocument(afterCamera, added.document.id).cameras.board).toEqual({ zoom: 2, x: 1, y: 2 });
    });

    it('attaches a document with a portable relative path only when it lies inside the board tree', () => {
      const newId = vi.fn(ids('doc'));
      const first = addDocument(base(), payload(1), T1, newId);
      expect(first.added).toBe(true);
      expect(first.document).toEqual({ id: 'doc-1', kind: 'pdf', name: 'sheet-1.pdf', path: '/home/tech/repairs/rev-b/docs/sheet-1.pdf', relativePath: 'docs/sheet-1.pdf', key: hexKey(2001), size: 1001, pageCount: 4, bookmarks: [], annotations: [], addedAt: T1 });
      sane(first.manifest);
      const outside = addDocument(first.manifest, payload(2, { path: '/elsewhere/sheet-2.pdf' }), T1, newId);
      expect(outside.document.relativePath).toBeUndefined();
      expect('relativePath' in outside.document).toBe(false);
      sane(outside.manifest);
    });

    it('returns the existing record when the same SHA-256 is attached twice, without burning an id or touching anything', () => {
      const newId = vi.fn(ids('doc'));
      const first = addDocument(base(), payload(1), T0, newId);
      const withBookmark = upsertBookmark(first.manifest, 'doc-1', { id: 'bm', page: 1, label: 'keep me' });
      const again = addDocument(withBookmark, payload(9, { key: hexKey(2001), name: 'copy.pdf', path: '/tmp/copy.pdf' }), T1, newId);
      expect(again.added).toBe(false);
      expect(again.manifest).toBe(withBookmark);
      expect(again.document.id).toBe('doc-1');
      expect(again.document.bookmarks).toHaveLength(1);
      expect(newId).toHaveBeenCalledTimes(1);
    });

    it('attaching the same bytes from a new place relinks a document flagged missing and keeps its annotations', () => {
      let manifest = withDocs(1);
      manifest = upsertAnnotation(manifest, 'doc-1', { id: 'an', page: 1, x: 1, y: 2, text: 'note' }, T0);
      manifest = applyLocateResults(manifest, [{ id: 'doc-1', status: 'missing' }]).manifest;
      expect(manifest.documents[0].missing).toBe(true);
      const result = addDocument(manifest, payload(1, { path: '/new/place/sheet-1.pdf', name: 'renamed.pdf' }), T1, ids('x'));
      expect(result.added).toBe(false);
      expect(result.document).toMatchObject({ id: 'doc-1', path: '/new/place/sheet-1.pdf', name: 'renamed.pdf' });
      expect(result.document.missing).toBeUndefined();
      expect(result.document.relativePath).toBeUndefined();
      expect(result.document.annotations).toHaveLength(1);
      sane(result.manifest);
    });

    it('enforces the document limit and rejects invalid input and colliding ids', () => {
      let manifest = base();
      const newId = ids('d');
      for (let i = 0; i < WORKSPACE_LIMITS.documents; i += 1) manifest = addDocument(manifest, payload(i), T0, newId).manifest;
      expect(manifest.documents).toHaveLength(200);
      expectCode(() => addDocument(manifest, payload(500), T0, newId), 'LIMIT_EXCEEDED');
      // an already attached key still resolves at the limit
      expect(addDocument(manifest, payload(7), T0, newId).added).toBe(false);
      expectCode(() => addDocument(base(), payload(1, { key: 'abc' }), T0, ids('d')), 'MANIFEST_INVALID');
      expectCode(() => addDocument(base(), payload(1, { kind: 'zip' }), T0, ids('d')), 'MANIFEST_INVALID');
      expectCode(() => addDocument(base(), payload(1, { path: '' }), T0, ids('d')), 'MANIFEST_INVALID');
      expectCode(() => addDocument(base(), payload(1, { size: -1 }), T0, ids('d')), 'MANIFEST_INVALID');
      expectCode(() => addDocument(base(), payload(1), 'never', ids('d')), 'MANIFEST_INVALID');
      const one = addDocument(base(), payload(1), T0, () => 'same').manifest;
      expectCode(() => addDocument(one, payload(2), T0, () => 'same'), 'MANIFEST_INVALID');
      expectCode(() => addDocument(base(), payload(1), T0, () => ''), 'MANIFEST_INVALID');
    });
  });

  describe('removeDocument', () => {
    it('removes the document and clears the split pane and camera that referenced it', () => {
      let manifest = withDocs(3);
      manifest = setSplit(manifest, { enabled: true, ratio: 0.4, right: { kind: 'document', id: 'doc-1' } });
      manifest = setCamera(manifest, 'doc-1', { page: 2, zoom: 1.5 });
      manifest = setCamera(manifest, 'doc-2', { page: 1 });
      manifest = setCamera(manifest, BOARD_SOURCE, { zoom: 3 });
      const next = sane(removeDocument(manifest, 'doc-1'));
      expect(next.documents.map(d => d.id)).toEqual(['doc-2', 'doc-3']);
      expect(next.split).toEqual({ enabled: true, ratio: 0.4, right: null });
      expect(next.cameras).toEqual({ board: { zoom: 3 }, 'doc-2': { page: 1 } });
      expect(manifest.documents).toHaveLength(3);
      expect(manifest.split.right).toEqual({ kind: 'document', id: 'doc-1' });
    });

    it('keeps an unrelated split pane and returns the same manifest for an unknown id', () => {
      const manifest = setSplit(withDocs(3), { right: { kind: 'schematic', id: 'doc-3' } });
      expect(removeDocument(manifest, 'doc-1').split.right).toEqual({ kind: 'schematic', id: 'doc-3' });
      expect(removeDocument(manifest, 'nope')).toBe(manifest);
    });
  });

  describe('applyLocateResults', () => {
    const okResult = (id: string, over: Partial<DocumentLocateResult> = {}): DocumentLocateResult => ({ id, status: 'ok', path: `/home/tech/repairs/rev-b/docs/sheet-${id.slice(-1)}.pdf`, relativePath: `docs/sheet-${id.slice(-1)}.pdf`, key: hexKey(2000 + Number(id.slice(-1))), ...over });

    it('returns the same manifest when every document is found exactly where it was', () => {
      const manifest = withDocs(3);
      const outcome = applyLocateResults(manifest, [okResult('doc-1'), okResult('doc-2'), { ...okResult('doc-3'), key: hexKey(2003) }]);
      expect(outcome.manifest).toBe(manifest);
      expect(outcome).toMatchObject({ changed: [], moved: [], missing: [], unreadable: [] });
    });

    it('updates path and relative path of a moved document and clears the missing hint', () => {
      let manifest = withDocs(2);
      manifest = applyLocateResults(manifest, [{ id: 'doc-1', status: 'missing' }]).manifest;
      const moved = applyLocateResults(manifest, [{ ...okResult('doc-1'), status: 'moved', path: '/home/tech/repairs/rev-b/archive/sheet-1.pdf', relativePath: 'archive/sheet-1.pdf' }]);
      expect(moved.moved).toEqual(['doc-1']);
      expect(moved.manifest.documents[0]).toMatchObject({ path: '/home/tech/repairs/rev-b/archive/sheet-1.pdf', relativePath: 'archive/sheet-1.pdf' });
      expect(moved.manifest.documents[0].missing).toBeUndefined();
      sane(moved.manifest);
      expect(applyLocateResults(moved.manifest, [{ ...okResult('doc-1'), status: 'ok', path: '/home/tech/repairs/rev-b/archive/sheet-1.pdf', relativePath: 'archive/sheet-1.pdf' }]).manifest).toBe(moved.manifest);
    });

    it('drops the relative path when the file now lives outside the board tree, and never stores a traversing one', () => {
      const manifest = withDocs(1);
      const outside = applyLocateResults(manifest, [{ ...okResult('doc-1'), status: 'moved', path: '/mnt/usb/sheet-1.pdf', relativePath: undefined }]);
      expect('relativePath' in outside.manifest.documents[0]).toBe(false);
      const evil = applyLocateResults(manifest, [{ ...okResult('doc-1'), status: 'moved', path: '/home/tech/repairs/rev-b/x/sheet-1.pdf', relativePath: '../../../etc/passwd' }]);
      expect(evil.manifest.documents[0].relativePath).toBe('x/sheet-1.pdf');
    });

    it('marks missing and unreadable documents with the hint and keeps their notes-bearing data', () => {
      let manifest = withDocs(3);
      manifest = upsertBookmark(manifest, 'doc-2', { id: 'b', page: 1, label: 'l' });
      const outcome = applyLocateResults(manifest, [
        { id: 'doc-1', status: 'missing' }, { id: 'doc-2', status: 'unreadable', message: 'EACCES' },
        { id: 'doc-3', status: 'ok', path: '', key: hexKey(2003) }, { id: 'ghost', status: 'missing' },
      ]);
      expect(outcome.missing).toEqual(['doc-1']);
      expect(outcome.unreadable).toEqual(['doc-2', 'doc-3']);
      expect(outcome.manifest.documents.every(d => d.missing === true)).toBe(true);
      expect(outcome.manifest.documents[1].bookmarks).toHaveLength(1);
      sane(outcome.manifest);
      expect(applyLocateResults(outcome.manifest, [{ id: 'doc-1', status: 'missing' }]).manifest).toBe(outcome.manifest);
    });

    it('a changed file never replaces the remembered key or annotations; it is reported for confirmation', () => {
      let manifest = withDocs(2);
      manifest = upsertAnnotation(manifest, 'doc-1', { id: 'an', page: 1, x: 5, y: 6, text: 'C12 is shorted' }, T0);
      const newKey = hexKey(777);
      const outcome = applyLocateResults(manifest, [{ id: 'doc-1', status: 'changed', path: '/home/tech/repairs/rev-b/docs/sheet-1.pdf', relativePath: 'docs/sheet-1.pdf', key: newKey, size: 9999 }]);
      expect(outcome.changed).toEqual([{ id: 'doc-1', name: 'sheet-1.pdf', path: '/home/tech/repairs/rev-b/docs/sheet-1.pdf', relativePath: 'docs/sheet-1.pdf', key: newKey, expectedKey: hexKey(2001), size: 9999 }]);
      const kept = outcome.manifest.documents[0];
      expect(kept).toMatchObject({ key: hexKey(2001), size: 1001, missing: true });
      expect(kept.annotations).toHaveLength(1);
      sane(outcome.manifest);
    });

    it('treats an ok/moved result whose key disagrees as changed, and a changed result with the remembered key as found', () => {
      const manifest = withDocs(1);
      const wrong = applyLocateResults(manifest, [okResult('doc-1', { key: hexKey(5), size: 3 })]);
      expect(wrong.changed.map(c => c.id)).toEqual(['doc-1']);
      expect(wrong.manifest.documents[0].key).toBe(hexKey(2001));
      const same = applyLocateResults(manifest, [okResult('doc-1', { status: 'changed', key: hexKey(2001) })]);
      expect(same.changed).toEqual([]);
      expect(same.manifest).toBe(manifest);
      const noKey = applyLocateResults(manifest, [okResult('doc-1', { status: 'changed', key: undefined })]);
      expect(noKey.unreadable).toEqual(['doc-1']);
    });

    it('acceptChangedDocument follows the new bytes after confirmation and keeps bookmarks and annotations', () => {
      let manifest = withDocs(3);
      manifest = upsertAnnotation(manifest, 'doc-1', { id: 'an', page: 1, x: 5, y: 6, text: 'keep' }, T0);
      manifest = upsertBookmark(manifest, 'doc-1', { id: 'bm', page: 2, label: 'keep' });
      manifest = setCamera(manifest, 'doc-1', { page: 2 });
      const found = { path: '/home/tech/repairs/rev-b/docs/sheet-1.pdf', key: hexKey(777), size: 9999, pageCount: 8 };
      const accepted = sane(acceptChangedDocument(applyLocateResults(manifest, [{ id: 'doc-1', status: 'changed', ...found, relativePath: 'docs/sheet-1.pdf' }]).manifest, 'doc-1', found));
      expect(accepted.documents[0]).toMatchObject({ id: 'doc-1', key: hexKey(777), size: 9999, pageCount: 8, relativePath: 'docs/sheet-1.pdf' });
      expect(accepted.documents[0].missing).toBeUndefined();
      expect(accepted.documents[0].annotations).toHaveLength(1);
      expect(accepted.documents[0].bookmarks).toHaveLength(1);
      expect(accepted.cameras['doc-1']).toEqual({ page: 2 });
      expectCode(() => acceptChangedDocument(manifest, 'doc-1', { ...found, key: hexKey(2002) }), 'INVALID_ARGUMENT');
      expectCode(() => acceptChangedDocument(manifest, 'ghost', found), 'NOT_FOUND');
      expectCode(() => acceptChangedDocument(manifest, 'doc-1', { ...found, key: 'abc' }), 'MANIFEST_INVALID');
    });

    it('a different image invalidates the old calibration and page count', () => {
      let manifest = addDocument(base(), payload(1, { kind: 'image', pageCount: undefined }), T0, ids('img')).manifest;
      manifest = setCalibration(manifest, 'img-1', { pixelsPerMm: 20, confirmed: true });
      const accepted = acceptChangedDocument(manifest, 'img-1', { path: '/home/tech/repairs/rev-b/docs/sheet-1.pdf', key: hexKey(55), size: 1 });
      expect(accepted.documents[0].calibration).toBeUndefined();
      expect(accepted.documents[0].key).toBe(hexKey(55));
    });
  });

  describe('relinkDocument', () => {
    it('accepts a file only when its SHA-256 equals the remembered key', () => {
      let manifest = withDocs(2);
      manifest = applyLocateResults(manifest, [{ id: 'doc-1', status: 'missing' }]).manifest;
      const good = relinkDocument(manifest, 'doc-1', { name: 'moved.pdf', path: '/home/tech/repairs/rev-b/new/moved.pdf', key: hexKey(2001) });
      expect(good.ok).toBe(true);
      if (good.ok) {
        expect(good.manifest.documents[0]).toMatchObject({ name: 'moved.pdf', path: '/home/tech/repairs/rev-b/new/moved.pdf', relativePath: 'new/moved.pdf', key: hexKey(2001), size: 1001 });
        expect(good.manifest.documents[0].missing).toBeUndefined();
        sane(good.manifest);
      }
      const bad = relinkDocument(manifest, 'doc-1', { path: '/x/other.pdf', key: hexKey(9) });
      expect(bad).toEqual({ ok: false, reason: 'mismatch', manifest, actualKey: hexKey(9) });
      expect(relinkDocument(manifest, 'ghost', { path: '/x.pdf', key: hexKey(2001) })).toMatchObject({ ok: false, reason: 'not-found' });
      expect(relinkDocument(manifest, 'doc-1', { path: '', key: hexKey(2001) })).toMatchObject({ ok: false, reason: 'invalid' });
      expect(relinkDocument(manifest, 'doc-1', { path: '/x.pdf', key: 'abc' })).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it('is a no-op when nothing about the record changes', () => {
      const manifest = withDocs(1);
      const same = relinkDocument(manifest, 'doc-1', { name: 'sheet-1.pdf', path: '/home/tech/repairs/rev-b/docs/sheet-1.pdf', key: hexKey(2001) });
      expect(same).toEqual({ ok: true, manifest });
      if (same.ok) expect(same.manifest).toBe(manifest);
    });
  });

  describe('split, tab, camera, page count, touch', () => {
    it('clamps the ratio to 0.2..0.8 and returns the same object when nothing changes', () => {
      const manifest = withDocs(3);
      expect(setSplit(manifest, { ratio: 0.05 }).split.ratio).toBe(0.2);
      expect(setSplit(manifest, { ratio: 9 }).split.ratio).toBe(0.8);
      expect(setSplit(manifest, { ratio: 0.33 }).split.ratio).toBe(0.33);
      expect(setSplit(manifest, {})).toBe(manifest);
      expect(setSplit(manifest, { ratio: 0.5, enabled: false, right: null })).toBe(manifest);
      expectCode(() => setSplit(manifest, { ratio: Number.NaN }), 'MANIFEST_INVALID');
      expectCode(() => setSplit(manifest, { enabled: 'yes' as unknown as boolean }), 'MANIFEST_INVALID');
    });

    it('the right pane must reference an existing document of the matching kind', () => {
      const manifest = withDocs(3);
      const shown = sane(setSplit(manifest, { enabled: true, right: { kind: 'document', id: 'doc-1' } }));
      expect(shown.split).toEqual({ enabled: true, ratio: 0.5, right: { kind: 'document', id: 'doc-1' } });
      expect(setSplit(shown, { right: { kind: 'document', id: 'doc-1' } })).toBe(shown);
      expect(setSplit(shown, { right: { kind: 'schematic', id: 'doc-3' } }).split.right).toEqual({ kind: 'schematic', id: 'doc-3' });
      expect(setSplit(shown, { right: null }).split.right).toBeNull();
      expectCode(() => setSplit(manifest, { right: { kind: 'document', id: 'ghost' } }), 'NOT_FOUND');
      expectCode(() => setSplit(manifest, { right: { kind: 'schematic', id: 'doc-1' } }), 'INVALID_ARGUMENT');
      expectCode(() => setSplit(manifest, { right: { kind: 'document', id: 'doc-3' } }), 'INVALID_ARGUMENT');
      expectCode(() => setSplit(manifest, { right: { kind: 'pdf', id: 'doc-1' } as never }), 'MANIFEST_INVALID');
      expectCode(() => setSplit(manifest, { right: { kind: 'document', id: '' } }), 'MANIFEST_INVALID');
    });

    it('setActiveTab validates and short-circuits', () => {
      const manifest = base();
      expect(setActiveTab(manifest, 'board')).toBe(manifest);
      expect(setActiveTab(manifest, 'schematic').activeTab).toBe('schematic');
      expectCode(() => setActiveTab(manifest, 'notes' as never), 'MANIFEST_INVALID');
    });

    it('setCamera replaces, forgets and bounds cameras', () => {
      const manifest = withDocs(2);
      const a = sane(setCamera(manifest, 'doc-1', { page: 3, zoom: 1.5, x: 10, y: 20, rotation: 90 }));
      expect(a.cameras['doc-1']).toEqual({ page: 3, zoom: 1.5, x: 10, y: 20, rotation: 90 });
      expect(setCamera(a, 'doc-1', { page: 3, zoom: 1.5, x: 10, y: 20, rotation: 90 })).toBe(a);
      expect(setCamera(a, 'doc-1', { page: 4 }).cameras['doc-1']).toEqual({ page: 4 });
      expect(setCamera(a, 'doc-1', null).cameras).toEqual({});
      expect(setCamera(a, 'doc-1', {}).cameras).toEqual({});
      expect(setCamera(manifest, 'doc-1', null)).toBe(manifest);
      expect(setCamera(manifest, BOARD_SOURCE, { zoom: 2 }).cameras.board).toEqual({ zoom: 2 });
      expectCode(() => setCamera(manifest, 'ghost', { zoom: 1 }), 'NOT_FOUND');
      expectCode(() => setCamera(manifest, 'doc-1', { zoom: 0 }), 'MANIFEST_INVALID');
      expectCode(() => setCamera(manifest, 'doc-1', { x: Number.NaN }), 'MANIFEST_INVALID');
      expectCode(() => setCamera(manifest, 'doc-1', { page: -1 }), 'MANIFEST_INVALID');
      const dropped = setCamera(manifest, 'doc-1', { zoom: 2, extra: 1 } as never);
      expect(dropped.cameras['doc-1']).toEqual({ zoom: 2 });
    });

    it('W-win-viewers-01: setCamera carries the fit mode (width | page | none), drops anything else, and a fit change is a change', () => {
      const manifest = withDocs(2);
      const camera = { page: 2, zoom: 0.585, rotation: 0, x: 12, y: 34 };
      for (const fit of ['width', 'page', 'none'] as const) {
        const stored = sane(setCamera(manifest, 'doc-1', { ...camera, fit }));
        expect(stored.cameras['doc-1']).toEqual({ ...camera, fit });
        expect(setCamera(stored, 'doc-1', { ...camera, fit })).toBe(stored);
      }
      const width = sane(setCamera(manifest, 'doc-1', { ...camera, fit: 'width' }));
      expect(setCamera(width, 'doc-1', { ...camera, fit: 'none' })).not.toBe(width);
      expect(setCamera(width, 'doc-1', { ...camera, fit: 'none' }).cameras['doc-1'].fit).toBe('none');
      expect(setCamera(width, 'doc-1', camera)).not.toBe(width); // a fit-less camera replaces the fitted one
      expect(setCamera(width, 'doc-1', camera).cameras['doc-1']).toEqual(camera);
      expect(setCamera(manifest, 'doc-1', { fit: 'width' }).cameras['doc-1']).toEqual({ fit: 'width' });
      for (const bad of ['fill', 'Width', '', 1, null, {}, ['width'], true]) {
        expect(setCamera(manifest, 'doc-1', { ...camera, fit: bad as never }).cameras['doc-1'], String(bad)).toEqual(camera);
      }
      expect(setCamera(manifest, 'doc-1', { fit: 'fill' as never })).toBe(manifest); // nothing but the dropped hint: an empty camera forgets
    });

    it('W-win-viewers-01: the workspace file round trip keeps the fit of a document camera and drops a corrupted one', () => {
      const manifest = withDocs(2);
      const cameras = { board: { zoom: 2, x: 1, y: 2, side: 'bottom' as const }, 'doc-1': { page: 3, zoom: 0.585, rotation: 90, x: 5, y: 6, fit: 'width' as const }, 'doc-2': { zoom: 1, fit: 'none' as const } };
      let current = manifest;
      for (const [source, camera] of Object.entries(cameras)) current = setCamera(current, source, camera);
      const file = JSON.parse(JSON.stringify(current));
      expect(file.cameras['doc-1'].fit).toBe('width');
      const loaded = validateManifest(file, BOARD_KEY);
      expect(loaded.cameras).toEqual(cameras);
      expect(validateManifest(JSON.parse(JSON.stringify(loaded)), BOARD_KEY)).toEqual(loaded);
      const hand = clone(file); hand.cameras['doc-1'].fit = 'maximum';
      expect(validateManifest(hand, BOARD_KEY).cameras['doc-1']).toEqual({ page: 3, zoom: 0.585, rotation: 90, x: 5, y: 6 });
    });

    it('setCamera enforces the camera limit but still updates an existing entry', () => {
      const cameras = Object.fromEntries(Array.from({ length: 254 }, (_, i) => [`stale-${i}`, { zoom: 1 }]));
      const manifest = { ...withDocs(2), cameras: { ...cameras, board: { zoom: 1 } } };
      const full = setCamera(manifest, 'doc-1', { zoom: 2 });
      expect(Object.keys(full.cameras)).toHaveLength(256);
      expectCode(() => setCamera(full, 'doc-2', { zoom: 2 }), 'LIMIT_EXCEEDED');
      expect(setCamera(full, 'doc-1', { zoom: 3 }).cameras['doc-1']).toEqual({ zoom: 3 });
    });

    it('setPageCount and touch', () => {
      const manifest = withDocs(1);
      expect(setPageCount(manifest, 'doc-1', 4)).toBe(manifest);
      expect(setPageCount(manifest, 'doc-1', 9).documents[0].pageCount).toBe(9);
      expectCode(() => setPageCount(manifest, 'doc-1', 0), 'MANIFEST_INVALID');
      expectCode(() => setPageCount(manifest, 'ghost', 1), 'NOT_FOUND');
      expect(touch(manifest, T0)).toBe(manifest);
      expect(touch(manifest, T1).updatedAt).toBe(T1);
      expectCode(() => touch(manifest, 'later'), 'MANIFEST_INVALID');
    });

    it('reconcileManifest drops references to unknown documents only', () => {
      const manifest = withDocs(3);
      const stale: WorkspaceManifest = { ...manifest, split: { enabled: true, ratio: 0.5, right: { kind: 'document', id: 'gone' } }, cameras: { board: { zoom: 1 }, gone: { zoom: 2 }, 'doc-1': { page: 1 } } };
      const fixed = reconcileManifest(stale);
      expect(fixed.split.right).toBeNull();
      expect(fixed.cameras).toEqual({ board: { zoom: 1 }, 'doc-1': { page: 1 } });
      expect(reconcileManifest(manifest)).toBe(manifest);
      const wrongKind = reconcileManifest({ ...manifest, split: { enabled: true, ratio: 0.5, right: { kind: 'schematic', id: 'doc-1' } } });
      expect(wrongKind.split.right).toBeNull();
    });
  });

  describe('bookmarks and annotations', () => {
    it('upserts by id, trims labels, replaces in place and short-circuits identical writes', () => {
      const manifest = withDocs(2);
      const a = sane(upsertBookmark(manifest, 'doc-1', { id: 'bm-1', page: 2, label: '  PMIC  ', x: 1, y: 2 }));
      expect(a.documents[0].bookmarks).toEqual([{ id: 'bm-1', page: 2, label: 'PMIC', x: 1, y: 2 }]);
      expect(upsertBookmark(a, 'doc-1', { id: 'bm-1', page: 2, label: 'PMIC', x: 1, y: 2 })).toBe(a);
      const b = upsertBookmark(a, 'doc-1', { id: 'bm-2', page: 5, label: '' });
      const c = upsertBookmark(b, 'doc-1', { id: 'bm-1', page: 3, label: 'PMIC' });
      expect(c.documents[0].bookmarks.map(x => [x.id, x.page])).toEqual([['bm-1', 3], ['bm-2', 5]]);
      expect(a.documents[0].bookmarks[0].page).toBe(2);
      expect(c.documents[1].bookmarks).toEqual([]);
      expect(removeBookmark(c, 'doc-1', 'bm-1').documents[0].bookmarks.map(x => x.id)).toEqual(['bm-2']);
      expect(removeBookmark(c, 'doc-1', 'ghost')).toBe(c);
    });

    it('bounds bookmark fields, count and target document', () => {
      const manifest = withDocs(1);
      expectCode(() => upsertBookmark(manifest, 'ghost', { id: 'b', page: 1, label: '' }), 'NOT_FOUND');
      expectCode(() => upsertBookmark(manifest, 'doc-1', { id: '', page: 1, label: '' }), 'MANIFEST_INVALID');
      expectCode(() => upsertBookmark(manifest, 'doc-1', { id: 'x'.repeat(129), page: 1, label: '' }), 'MANIFEST_INVALID');
      expectCode(() => upsertBookmark(manifest, 'doc-1', { id: 'b', page: 1.5, label: '' }), 'MANIFEST_INVALID');
      expectCode(() => upsertBookmark(manifest, 'doc-1', { id: 'b', page: 1_000_001, label: '' }), 'MANIFEST_INVALID');
      expectCode(() => upsertBookmark(manifest, 'doc-1', { id: 'b', page: 1, label: 'x'.repeat(8001) }), 'MANIFEST_INVALID');
      expectCode(() => upsertBookmark(manifest, 'doc-1', { id: 'b', page: 1, label: '', x: Infinity }), 'MANIFEST_INVALID');
      expect(upsertBookmark(manifest, 'doc-1', { id: 'b', page: 1, label: 'x'.repeat(8000) }).documents[0].bookmarks).toHaveLength(1);
      const full = { ...manifest, documents: [{ ...manifest.documents[0], bookmarks: Array.from({ length: 2000 }, (_, i) => ({ id: `b${i}`, page: 1, label: '' })) }] };
      expectCode(() => upsertBookmark(full, 'doc-1', { id: 'new', page: 1, label: '' }), 'LIMIT_EXCEEDED');
      expect(upsertBookmark(full, 'doc-1', { id: 'b7', page: 2, label: '' }).documents[0].bookmarks).toHaveLength(2000);
    });

    it('annotations carry updatedAt only from the change that wrote them', () => {
      const manifest = withDocs(1);
      const a = sane(upsertAnnotation(manifest, 'doc-1', { id: 'an', page: 1, x: 3, y: 4, text: ' first ' }, T0));
      expect(a.documents[0].annotations).toEqual([{ id: 'an', page: 1, x: 3, y: 4, text: 'first', updatedAt: T0 }]);
      expect(upsertAnnotation(a, 'doc-1', { id: 'an', page: 1, x: 3, y: 4, text: 'first' }, T1)).toBe(a);
      const b = upsertAnnotation(a, 'doc-1', { id: 'an', page: 1, x: 3, y: 4, text: 'second' }, T1);
      expect(b.documents[0].annotations[0]).toMatchObject({ text: 'second', updatedAt: T1 });
      expect(removeAnnotation(b, 'doc-1', 'an').documents[0].annotations).toEqual([]);
      expect(removeAnnotation(b, 'doc-1', 'ghost')).toBe(b);
      expectCode(() => upsertAnnotation(manifest, 'doc-1', { id: 'a', page: 1, x: NaN, y: 0, text: '' }, T0), 'MANIFEST_INVALID');
      expectCode(() => upsertAnnotation(manifest, 'doc-1', { id: 'a', page: 1, x: 0, y: 0, text: 'x'.repeat(8001) }, T0), 'MANIFEST_INVALID');
      expectCode(() => upsertAnnotation(manifest, 'doc-1', { id: 'a', page: 1, x: 0, y: 0, text: '' }, 'never'), 'MANIFEST_INVALID');
      const full = { ...manifest, documents: [{ ...manifest.documents[0], annotations: Array.from({ length: 2000 }, (_, i) => ({ id: `a${i}`, page: 1, x: 0, y: 0, text: '', updatedAt: T0 })) }] };
      expectCode(() => upsertAnnotation(full, 'doc-1', { id: 'new', page: 1, x: 0, y: 0, text: '' }, T0), 'LIMIT_EXCEEDED');
    });
  });

  describe('calibration', () => {
    const imageManifest = () => addDocument(withDocs(1), payload(8, { kind: 'image', pageCount: undefined }), T0, () => 'img').manifest;

    it('is stored only when confirmed, only on images, and clears back to nothing', () => {
      const manifest = imageManifest();
      const calibrated = sane(setCalibration(manifest, 'img', { pixelsPerMm: 14.25, confirmed: true }));
      expect(calibrated.documents[1].calibration).toEqual({ pixelsPerMm: 14.25, confirmed: true });
      expect(setCalibration(calibrated, 'img', { pixelsPerMm: 14.25, confirmed: true })).toBe(calibrated);
      expect(setCalibration(calibrated, 'img', { pixelsPerMm: 15, confirmed: true }).documents[1].calibration!.pixelsPerMm).toBe(15);
      const cleared = setCalibration(calibrated, 'img', null);
      expect('calibration' in cleared.documents[1]).toBe(false);
      expect(setCalibration(manifest, 'img', null)).toBe(manifest);
      expectCode(() => setCalibration(manifest, 'img', { pixelsPerMm: 14, confirmed: false as never }), 'INVALID_ARGUMENT');
      expectCode(() => setCalibration(manifest, 'img', { pixelsPerMm: 14 } as never), 'INVALID_ARGUMENT');
      expectCode(() => setCalibration(manifest, 'img', { pixelsPerMm: 0, confirmed: true }), 'MANIFEST_INVALID');
      expectCode(() => setCalibration(manifest, 'img', { pixelsPerMm: Number.NaN, confirmed: true }), 'MANIFEST_INVALID');
      expectCode(() => setCalibration(manifest, 'doc-1', { pixelsPerMm: 14, confirmed: true }), 'INVALID_ARGUMENT');
      expectCode(() => setCalibration(manifest, 'ghost', { pixelsPerMm: 14, confirmed: true }), 'NOT_FOUND');
    });
  });

  describe('aliases', () => {
    it('sets, replaces and removes user-confirmed aliases; the last removal drops the aliases object', () => {
      const manifest = base();
      const a = sane(setAlias(manifest, 'refs', ' U1A ', 'U1'));
      expect(a.aliases).toEqual({ refs: { U1A: 'U1' }, nets: {} });
      expect(setAlias(a, 'refs', 'U1A', 'U1')).toBe(a);
      const b = sane(setAlias(a, 'nets', 'VDD_MAIN', 'PP_VDD'));
      expect(b.aliases).toEqual({ refs: { U1A: 'U1' }, nets: { VDD_MAIN: 'PP_VDD' } });
      expect(setAlias(b, 'refs', 'U1A', 'U2').aliases!.refs).toEqual({ U1A: 'U2' });
      expect(a.aliases!.refs).toEqual({ U1A: 'U1' });
      expect(removeAlias(b, 'refs', 'ghost')).toBe(b);
      const c = sane(removeAlias(b, 'refs', 'U1A'));
      expect(c.aliases).toEqual({ refs: {}, nets: { VDD_MAIN: 'PP_VDD' } });
      const d = sane(removeAlias(c, 'nets', ' VDD_MAIN '));
      expect('aliases' in d).toBe(false);
      expect(removeAlias(manifest, 'refs', 'U1A')).toBe(manifest);
    });

    it('rejects empty, oversized, self-referential and prototype names and bounds the count per map', () => {
      const manifest = base();
      expectCode(() => setAlias(manifest, 'refs', '', 'U1'), 'INVALID_ARGUMENT');
      expectCode(() => setAlias(manifest, 'refs', 'U1A', '   '), 'INVALID_ARGUMENT');
      expectCode(() => setAlias(manifest, 'refs', 'U1', 'U1'), 'INVALID_ARGUMENT');
      expectCode(() => setAlias(manifest, 'refs', '__proto__', 'U1'), 'INVALID_ARGUMENT');
      expectCode(() => setAlias(manifest, 'refs', 'x'.repeat(257), 'U1'), 'INVALID_ARGUMENT');
      expectCode(() => setAlias(manifest, 'bogus' as never, 'A', 'B'), 'INVALID_ARGUMENT');
      expect(setAlias(manifest, 'nets', 'x'.repeat(256), 'y'.repeat(256)).aliases!.nets).toHaveProperty('x'.repeat(256));
      const full = { ...manifest, aliases: { refs: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`R${i}`, `B${i}`])), nets: {} } };
      expectCode(() => setAlias(full, 'refs', 'NEW', 'B'), 'LIMIT_EXCEEDED');
      expect(setAlias(full, 'refs', 'R5', 'OTHER').aliases!.refs.R5).toBe('OTHER');
      expect(setAlias(full, 'nets', 'N', 'M').aliases!.nets).toEqual({ N: 'M' });
    });
  });

  it('a long editing session keeps the manifest valid and never mutates earlier versions', () => {
    const newId = ids('doc');
    const history: Array<{ manifest: WorkspaceManifest; json: string }> = [];
    let manifest = base();
    const step = (next: WorkspaceManifest) => { manifest = sane(next); history.push({ manifest, json: JSON.stringify(manifest) }); return next; };
    const before = JSON.stringify(manifest);
    step(addDocument(manifest, payload(1), T0, newId).manifest);
    step(addDocument(manifest, payload(2, { kind: 'image', pageCount: undefined }), T0, newId).manifest);
    step(addDocument(manifest, payload(3, { kind: 'schematic', pageCount: undefined }), T0, newId).manifest);
    step(setSplit(manifest, { enabled: true, ratio: 0.7, right: { kind: 'schematic', id: 'doc-3' } }));
    step(setCamera(manifest, 'doc-1', { page: 2, zoom: 2 }));
    step(upsertBookmark(manifest, 'doc-1', { id: 'b', page: 2, label: 'rails' }));
    step(upsertAnnotation(manifest, 'doc-1', { id: 'a', page: 2, x: 1, y: 1, text: 'hot' }, T1));
    step(setCalibration(manifest, 'doc-2', { pixelsPerMm: 9, confirmed: true }));
    step(setAlias(manifest, 'refs', 'U1A', 'U1'));
    step(applyLocateResults(manifest, [{ id: 'doc-2', status: 'missing' }]).manifest);
    step(removeDocument(manifest, 'doc-3'));
    step(touch(manifest, T1));
    expect(JSON.stringify(base())).toBe(before);
    for (const { manifest: earlier, json } of history) expect(JSON.stringify(earlier)).toBe(json);
    expect(manifest.documents.map(d => d.id)).toEqual(['doc-1', 'doc-2']);
    expect(manifest.split.right).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Notes helpers
// ---------------------------------------------------------------------------------------------

describe('notes helpers', () => {
  const seq = () => { let n = 0; return () => `note-${++n}`; };
  const U1 = noteTarget('U1');
  const U1pin = noteTarget('U1', 'U1.3');

  it('noteTarget keeps component and pin targets apart and rejects empty names', () => {
    expect(noteTarget('U1')).toEqual({ componentId: 'U1' });
    expect(noteTarget('U1', 'U1.3')).toEqual({ componentId: 'U1', pinId: 'U1.3' });
    expect('pinId' in noteTarget('U1')).toBe(false);
    expect(() => noteTarget('')).toThrow(WorkspaceError);
    expect(() => noteTarget('U1', '')).toThrow(WorkspaceError);
    expect(() => noteTarget('x'.repeat(257))).toThrow(WorkspaceError);
    expect(noteTarget('x'.repeat(256), 'y'.repeat(256)).pinId).toHaveLength(256);
  });

  it('creates, finds, updates in place and deletes by target; a pin note never answers for its component', () => {
    const newId = seq();
    let notes: BoardNote[] = [];
    notes = upsertNote(notes, U1, { text: '  hot after 10 s  ' }, T0, newId);
    expect(notes).toEqual([{ id: 'note-1', componentId: 'U1', text: 'hot after 10 s', updatedAt: T0 }]);
    notes = upsertNote(notes, U1pin, { text: 'shorted', measurements: { voltage: ' 0.02 V ', resistance: '', other: '  ' } }, T0, newId);
    expect(notes[1]).toEqual({ id: 'note-2', componentId: 'U1', pinId: 'U1.3', text: 'shorted', measurements: { voltage: '0.02 V' }, updatedAt: T0 });
    expect(noteFor(notes, U1)!.id).toBe('note-1');
    expect(noteFor(notes, U1pin)!.id).toBe('note-2');
    expect(noteFor(notes, noteTarget('U1', 'U1.4'))).toBeUndefined();
    expect(noteFor(notes, noteTarget('U2'))).toBeUndefined();
    const updated = upsertNote(notes, U1, { text: 'hot after 3 s' }, T1, newId);
    expect(updated.map(n => n.id)).toEqual(['note-1', 'note-2']);
    expect(updated[0]).toMatchObject({ text: 'hot after 3 s', updatedAt: T1 });
    expect(notes[0].text).toBe('hot after 10 s');
    expect(validateNotes(JSON.parse(JSON.stringify(updated)))).toEqual(updated);
    const without = upsertNote(updated, U1pin, { text: '', measurements: null }, T1, newId);
    expect(without.map(n => n.id)).toEqual(['note-1']);
  });

  it('empty text AND no measurements deletes; measurements alone keep the note', () => {
    const newId = seq();
    let notes = upsertNote([], U1, { text: 'x', measurements: { voltage: '1 V' } }, T0, newId);
    const onlyMeasure = upsertNote(notes, U1, { text: '   ' }, T1, newId);
    expect(onlyMeasure).toHaveLength(1);
    expect(onlyMeasure[0]).toMatchObject({ text: '', measurements: { voltage: '1 V' } });
    const onlyText = upsertNote(notes, U1, { measurements: null }, T1, newId);
    expect(onlyText[0].measurements).toBeUndefined();
    expect(onlyText[0].text).toBe('x');
    const emptied = upsertNote(onlyMeasure, U1, { measurements: { voltage: ' ', other: '' } }, T1, newId);
    expect(emptied).toEqual([]);
    // nothing to create: the same array comes back
    const none: BoardNote[] = [];
    expect(upsertNote(none, U1, { text: '  ' }, T0, newId)).toBe(none);
    expect(upsertNote(none, U1, {}, T0, newId)).toBe(none);
    notes = [];
  });

  it('returns the SAME array when the change is a no-op (so no save is triggered and updatedAt does not move)', () => {
    const newId = seq();
    const notes = upsertNote([], U1, { text: 'x', measurements: { voltage: '1 V' } }, T0, newId);
    expect(upsertNote(notes, U1, { text: ' x ' }, T1, newId)).toBe(notes);
    expect(upsertNote(notes, U1, { text: 'x', measurements: { voltage: '1 V ' } }, T1, newId)).toBe(notes);
    expect(upsertNote(notes, U1, {}, T1, newId)).toBe(notes);
    expect(upsertNote(notes, U1, { measurements: { voltage: '2 V' } }, T1, newId)).not.toBe(notes);
  });

  it('enforces text 8000, measurement 64 and the 500-note limit without truncating', () => {
    const newId = seq();
    expect(upsertNote([], U1, { text: 'x'.repeat(8000) }, T0, newId)[0].text).toHaveLength(8000);
    expect(upsertNote([], U1, { text: `  ${'x'.repeat(8000)}  ` }, T0, newId)[0].text).toHaveLength(8000);
    expectCode(() => upsertNote([], U1, { text: 'x'.repeat(8001) }, T0, newId), 'NOTES_INVALID');
    expect(upsertNote([], U1, { measurements: { voltage: 'v'.repeat(64) } }, T0, newId)).toHaveLength(1);
    expectCode(() => upsertNote([], U1, { measurements: { voltage: 'v'.repeat(65) } }, T0, newId), 'NOTES_INVALID');
    expectCode(() => upsertNote([], U1, { measurements: { voltage: 5 as unknown as string } }, T0, newId), 'NOTES_INVALID');
    expectCode(() => upsertNote([], U1, { text: 5 as unknown as string }, T0, newId), 'NOTES_INVALID');
    expectCode(() => upsertNote([], U1, { text: 'x' }, 'never', newId), 'NOTES_INVALID');
    const full = Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, componentId: `C${i}`, text: 't', updatedAt: T0 }));
    expectCode(() => upsertNote(full, noteTarget('NEW'), { text: 'x' }, T0, newId), 'TOO_MANY_NOTES');
    expect(upsertNote(full, noteTarget('C3'), { text: 'changed' }, T0, newId)).toHaveLength(500);
    expect(upsertNote(full, noteTarget('C3'), { text: '' }, T0, newId)).toHaveLength(499);
  });

  it('rejects ids that are invalid or already used', () => {
    const notes = upsertNote([], U1, { text: 'x' }, T0, () => 'same');
    expectCode(() => upsertNote(notes, noteTarget('U2'), { text: 'y' }, T0, () => 'same'), 'NOTES_INVALID');
    expectCode(() => upsertNote([], U1, { text: 'x' }, T0, () => ''), 'NOTES_INVALID');
  });

  it('B15: touches only the note of the exact target, never every note of the same component', () => {
    const newId = seq();
    let notes: BoardNote[] = [];
    notes = upsertNote(notes, U1, { text: 'component' }, T0, newId);
    notes = upsertNote(notes, U1pin, { text: 'pin' }, T0, newId);
    notes = upsertNote(notes, noteTarget('U1', 'U1.4'), { text: 'other pin' }, T0, newId);
    const edited = upsertNote(notes, U1, { text: 'component edited' }, T1, newId);
    expect(edited.map(n => [n.pinId ?? '-', n.text])).toEqual([['-', 'component edited'], ['U1.3', 'pin'], ['U1.4', 'other pin']]);
    const deleted = upsertNote(notes, U1, { text: '' }, T1, newId);
    expect(deleted.map(n => n.pinId)).toEqual(['U1.3', 'U1.4']);
    // a list that is already malformed (hand edited) is not "repaired" by silently dropping the hidden duplicate
    const malformed: BoardNote[] = [{ id: 'a', componentId: 'U9', text: 'first', updatedAt: T0 }, { id: 'b', componentId: 'U9', text: 'second', updatedAt: T0 }];
    expect(() => validateNotes(malformed)).toThrow('duplicate note for this component');
    const touched = upsertNote(malformed, noteTarget('U9'), { text: 'edited' }, T1, newId);
    expect(touched.map(n => n.text)).toEqual(['edited', 'second']);
  });
});

// ---------------------------------------------------------------------------------------------
// Persistence queue
// ---------------------------------------------------------------------------------------------

describe('createWorkspaceSaver (B01: no accepted change is lost, saves never overlap)', () => {
  interface Call { value: number | null; resolve(): void; reject(error: unknown): void; settled: boolean }

  function harness(options: { delayMs?: number; retryDelayMs?: (attempt: number, error: unknown) => number | null } = {}) {
    const calls: Call[] = [];
    let active = 0;
    let maxActive = 0;
    const errors: SaveFailure[] = [];
    const states: SaverState[] = [];
    const saver = createWorkspaceSaver<number | null>({
      delayMs: options.delayMs ?? 100,
      retryDelayMs: options.retryDelayMs ?? (() => null),
      save: value => new Promise<void>((resolve, reject) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const call: Call = {
          value, settled: false,
          resolve: () => { if (!call.settled) { call.settled = true; active -= 1; resolve(); } },
          reject: error => { if (!call.settled) { call.settled = true; active -= 1; reject(error); } },
        };
        calls.push(call);
      }),
      onError: failure => errors.push(failure),
      onStateChange: state => states.push(state),
    });
    return { saver, calls, errors, states, maxActive: () => maxActive, values: () => calls.map(call => call.value) };
  }
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const settle = () => tick(0);

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('coalesces rapid changes into one write per quiet period, restarting the period on every change', async () => {
    const h = harness();
    h.saver.schedule(1);
    await tick(60);
    h.saver.schedule(2);
    await tick(60);
    h.saver.schedule(3);
    await tick(99);
    expect(h.calls).toHaveLength(0);
    await tick(1);
    expect(h.values()).toEqual([3]);
    h.calls[0].resolve();
    await settle();
    await tick(1000);
    expect(h.values()).toEqual([3]);
    expect(h.saver.getState()).toEqual({ saving: false, dirty: false, failure: null });
  });

  it('writes falsy snapshots too (0 and null are values, not absence)', async () => {
    const h = harness();
    h.saver.schedule(0);
    await tick(100);
    h.calls[0].resolve();
    await settle();
    h.saver.schedule(null);
    await tick(100);
    expect(h.values()).toEqual([0, null]);
  });

  it('never runs two saves at once: a change during an in-flight save waits for it and then for its own quiet period', async () => {
    const h = harness();
    h.saver.schedule(1);
    await tick(100);
    expect(h.values()).toEqual([1]);
    h.saver.schedule(2);
    await tick(10);
    h.saver.schedule(3);
    await tick(500);
    expect(h.values()).toEqual([1]);
    h.calls[0].resolve();
    await settle();
    expect(h.values()).toEqual([1, 3]);
    h.calls[1].resolve();
    await settle();
    expect(h.maxActive()).toBe(1);
    expect(h.saver.getState().dirty).toBe(false);
  });

  it('a change made during a save does not write early: the quiet period still applies after the save ends', async () => {
    const h = harness();
    h.saver.schedule(1);
    await tick(100);
    await tick(20);
    h.saver.schedule(2);
    await tick(30);
    h.calls[0].resolve();
    await settle();
    expect(h.values()).toEqual([1]);
    await tick(69);
    expect(h.values()).toEqual([1]);
    await tick(1);
    expect(h.values()).toEqual([1, 2]);
  });

  it('flush writes the pending snapshot immediately and resolves only after it is written', async () => {
    const h = harness();
    h.saver.schedule(1);
    let flushed = false;
    const flush = h.saver.flush().then(() => { flushed = true; });
    await settle();
    expect(h.values()).toEqual([1]);
    expect(flushed).toBe(false);
    h.calls[0].resolve();
    await flush;
    expect(flushed).toBe(true);
    await tick(1000);
    expect(h.values()).toEqual([1]);
  });

  it('flush while a save is in flight waits for it; with a newer pending snapshot it writes that one too, in order', async () => {
    const h = harness();
    h.saver.schedule(1);
    await tick(100);
    let flushedOnlyInFlight = false;
    const first = h.saver.flush().then(() => { flushedOnlyInFlight = true; });
    await settle();
    expect(flushedOnlyInFlight).toBe(false);
    h.calls[0].resolve();
    await first;
    expect(h.values()).toEqual([1]);

    h.saver.schedule(2);
    await tick(100);
    h.saver.schedule(3);
    let flushedAll = false;
    const second = h.saver.flush().then(() => { flushedAll = true; });
    await settle();
    h.calls[1].resolve();
    await settle();
    expect(h.values()).toEqual([1, 2, 3]);
    expect(flushedAll).toBe(false);
    h.calls[2].resolve();
    await second;
    expect(flushedAll).toBe(true);
    expect(h.maxActive()).toBe(1);
  });

  it('a change accepted after flush() started supersedes the snapshot the flush was waiting for, and that newer one is written', async () => {
    const h = harness();
    h.saver.schedule(1);
    await tick(100);
    h.saver.schedule(2);
    let flushed = false;
    const flush = h.saver.flush().then(() => { flushed = true; });
    h.saver.schedule(3);
    h.calls[0].resolve();
    await settle();
    expect(h.values()).toEqual([1, 3]);
    expect(flushed).toBe(false);
    h.calls[1].resolve();
    await flush;
    expect(flushed).toBe(true);
    expect(h.maxActive()).toBe(1);
  });

  it('a snapshot written early by flush leaves no stale timer that would cut the quiet period of the next change', async () => {
    const h = harness();
    h.saver.schedule(1);
    await tick(100);
    h.saver.schedule(2);
    const flush = h.saver.flush();
    h.saver.schedule(3);
    h.calls[0].resolve();
    await settle();
    expect(h.values()).toEqual([1, 3]);
    await tick(150);
    h.saver.schedule(4);
    h.calls[1].resolve();
    await flush;
    await tick(99);
    expect(h.values()).toEqual([1, 3]);
    await tick(1);
    expect(h.values()).toEqual([1, 3, 4]);
  });

  it('flush with nothing to write resolves immediately; concurrent flushes all resolve', async () => {
    const h = harness();
    await h.saver.flush();
    h.saver.schedule(1);
    const a = h.saver.flush();
    const b = h.saver.flush();
    await settle();
    expect(h.values()).toEqual([1]);
    h.calls[0].resolve();
    await Promise.all([a, b]);
    await h.saver.flush();
    expect(h.values()).toEqual([1]);
  });

  it('failure then a newer change: the newer snapshot is written after the quiet period and the failed one is not retried', async () => {
    const h = harness();
    h.saver.schedule(1);
    await tick(100);
    h.calls[0].reject(new Error('disk full'));
    await settle();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ attempts: 1, willRetry: false, retryInMs: null });
    expect(h.saver.getState()).toMatchObject({ saving: false, dirty: true });
    expect(h.saver.getState().failure).not.toBeNull();
    await tick(10_000);
    expect(h.values()).toEqual([1]);
    h.saver.schedule(2);
    await tick(100);
    expect(h.values()).toEqual([1, 2]);
    h.calls[1].resolve();
    await settle();
    expect(h.saver.getState()).toEqual({ saving: false, dirty: false, failure: null });
    await tick(60_000);
    expect(h.values()).toEqual([1, 2]);
  });

  it('a failure while a newer snapshot is already queued writes the newer one and never the failed one', async () => {
    const h = harness();
    h.saver.schedule(1);
    await tick(100);
    h.saver.schedule(2);
    h.calls[0].reject(new Error('EBUSY'));
    await settle();
    expect(h.errors[0]).toMatchObject({ attempts: 1, willRetry: true });
    expect(h.values()).toEqual([1]);
    await tick(100);
    expect(h.values()).toEqual([1, 2]);
    h.calls[1].resolve();
    await settle();
    expect(h.saver.getState().failure).toBeNull();
  });

  it('retries a failed snapshot with the configured backoff and stops when told to', async () => {
    const delays = [200, 400, null];
    const h = harness({ retryDelayMs: attempt => delays[attempt - 1] ?? null });
    h.saver.schedule(7);
    await tick(100);
    h.calls[0].reject(new Error('1'));
    await settle();
    expect(h.errors[0]).toMatchObject({ attempts: 1, willRetry: true, retryInMs: 200 });
    await tick(199);
    expect(h.values()).toEqual([7]);
    await tick(1);
    expect(h.values()).toEqual([7, 7]);
    h.calls[1].reject(new Error('2'));
    await settle();
    expect(h.errors[1]).toMatchObject({ attempts: 2, retryInMs: 400 });
    await tick(400);
    expect(h.values()).toEqual([7, 7, 7]);
    h.calls[2].reject(new Error('3'));
    await settle();
    expect(h.errors[2]).toMatchObject({ attempts: 3, willRetry: false, retryInMs: null });
    await tick(60_000);
    expect(h.values()).toEqual([7, 7, 7]);
    expect(h.saver.getState().dirty).toBe(true);
    // the user can still force it through
    const flush = h.saver.flush();
    await settle();
    h.calls[3].resolve();
    await flush;
    expect(h.saver.getState()).toEqual({ saving: false, dirty: false, failure: null });
  });

  it('flush rejects with the write error, keeps the snapshot queued, and a second flush retries it', async () => {
    const h = harness();
    h.saver.schedule(5);
    const flush = h.saver.flush();
    const caught = flush.then(() => 'resolved', error => (error as Error).message);
    await settle();
    h.calls[0].reject(new Error('EACCES'));
    expect(await caught).toBe('EACCES');
    expect(h.saver.getState()).toMatchObject({ dirty: true });
    const again = h.saver.flush();
    await settle();
    expect(h.values()).toEqual([5, 5]);
    h.calls[1].resolve();
    await again;
    expect(h.saver.getState()).toEqual({ saving: false, dirty: false, failure: null });
  });

  it('a save that throws synchronously is a failure like any other', async () => {
    const errors: SaveFailure[] = [];
    const saver = createWorkspaceSaver<number>({ delayMs: 10, retryDelayMs: () => null, save: () => { throw new Error('sync'); }, onError: f => errors.push(f) });
    saver.schedule(1);
    await tick(10);
    expect(errors).toHaveLength(1);
    expect((errors[0].error as Error).message).toBe('sync');
    await expect(saver.flush()).rejects.toThrow('sync');
  });

  it('permanent store errors are not retried automatically by the default policy; transient ones back off 1 s, 2 s, 4 s', async () => {
    const run = async (code: string) => {
      const attempts: number[] = [];
      const saver = createWorkspaceSaver<number>({ delayMs: 10, save: async value => { attempts.push(value); throw Object.assign(new Error('x'), { code }); } });
      saver.schedule(1);
      await tick(10);
      return { attempts, saver };
    };
    const closing = await run('STORE_CLOSING');
    await tick(120_000);
    expect(closing.attempts).toEqual([1]);
    const transient = await run('STORE_WRITE_FAILED');
    await tick(999);
    expect(transient.attempts).toEqual([1]);
    await tick(1);
    expect(transient.attempts).toEqual([1, 1]);
    await tick(1999);
    expect(transient.attempts).toEqual([1, 1]);
    await tick(1);
    expect(transient.attempts).toEqual([1, 1, 1]);
    await tick(4000);
    expect(transient.attempts).toEqual([1, 1, 1, 1]);
    transient.saver.dispose();
    await tick(120_000);
    expect(transient.attempts).toHaveLength(4);
  });

  it('dispose stops the timers but keeps the pending snapshot flushable; later changes are not accepted', async () => {
    const h = harness();
    expect(h.saver.schedule(1)).toBe(true);
    h.saver.dispose();
    await tick(10_000);
    expect(h.values()).toEqual([]);
    expect(h.saver.schedule(2)).toBe(false);
    expect(h.saver.getState().dirty).toBe(true);
    const flush = h.saver.flush();
    await settle();
    expect(h.values()).toEqual([1]);
    h.calls[0].resolve();
    await flush;
    expect(h.saver.getState()).toEqual({ saving: false, dirty: false, failure: null });
    expect(h.saver.schedule(3)).toBe(false);
    await h.saver.flush();
    expect(h.values()).toEqual([1]);
  });

  it('dispose during an in-flight save lets it finish; a failure after dispose arms no retry but flush can still retry', async () => {
    const h = harness({ retryDelayMs: () => 50 });
    h.saver.schedule(1);
    await tick(100);
    h.saver.dispose();
    h.calls[0].reject(new Error('late'));
    await settle();
    expect(h.errors[0]).toMatchObject({ willRetry: false });
    await tick(10_000);
    expect(h.values()).toEqual([1]);
    const flush = h.saver.flush();
    await settle();
    expect(h.values()).toEqual([1, 1]);
    h.calls[1].resolve();
    await flush;
  });

  it('dispose with a queued snapshot behind an in-flight save: flush writes both in order without overlap', async () => {
    const h = harness();
    h.saver.schedule(1);
    await tick(100);
    h.saver.schedule(2);
    h.saver.dispose();
    const flush = h.saver.flush();
    await settle();
    expect(h.values()).toEqual([1]);
    h.calls[0].resolve();
    await settle();
    expect(h.values()).toEqual([1, 2]);
    h.calls[1].resolve();
    await flush;
    expect(h.maxActive()).toBe(1);
  });

  it('reports state transitions and survives a throwing listener', async () => {
    const h = harness();
    h.saver.schedule(1);
    await tick(100);
    h.calls[0].resolve();
    await settle();
    expect(h.states.map(s => [s.dirty, s.saving])).toEqual([[true, false], [true, true], [false, true], [false, false]]);
    const safe = createWorkspaceSaver<number>({ delayMs: 1, save: async () => {}, onStateChange: () => { throw new Error('listener'); }, onError: () => { throw new Error('listener'); } });
    safe.schedule(1);
    await tick(1);
    await expect(safe.flush()).resolves.toBeUndefined();
  });

  it('stress: with random timing, failures and flushes no accepted snapshot is lost, order is monotonic and saves never overlap', async () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      let state = seed * 2654435761;
      const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
      const written: number[] = [];
      let active = 0;
      let overlap = false;
      const pending: Array<{ value: number; done: () => void }> = [];
      const saver = createWorkspaceSaver<number>({
        delayMs: 20,
        retryDelayMs: () => (random() < 0.5 ? 15 : null),
        save: value => new Promise<void>((resolve, reject) => {
          active += 1;
          if (active > 1) overlap = true;
          pending.push({
            value,
            done: () => {
              active -= 1;
              if (random() < 0.3) reject(new Error('flaky')); else { written.push(value); resolve(); }
            },
          });
        }),
      });
      let latest = 0;
      for (let step = 0; step < 150; step += 1) {
        const roll = random();
        if (roll < 0.4) { latest += 1; saver.schedule(latest); }
        else if (roll < 0.7) await tick(Math.floor(random() * 40));
        else if (roll < 0.9) pending.shift()?.done();
        else void saver.flush().catch(() => {});
        await settle();
      }
      // drain: keep finishing saves and flushing until everything accepted is written
      for (let round = 0; round < 200 && (written.at(-1) ?? 0) < latest; round += 1) {
        const flush = saver.flush().catch(() => {});
        await settle();
        while (pending.length) { pending.shift()!.done(); await settle(); }
        await flush;
      }
      expect({ seed, overlap }).toEqual({ seed, overlap: false });
      expect(written.at(-1) ?? 0).toBe(latest);
      expect(written).toEqual([...written].sort((a, b) => a - b));
      expect(saver.getState().dirty).toBe(false);
    }
  });
});

describe('nativeErrorCode', () => {
  it('reads the code from .code or from the "[CODE] text" message prefix the preload delivers', async () => {
    const { nativeErrorCode } = await import('./workspace');
    expect(nativeErrorCode(Object.assign(new Error('x'), { code: 'STORE_CLOSING' }))).toBe('STORE_CLOSING');
    expect(nativeErrorCode(new Error('[STORE_CLOSING] The application is closing.'))).toBe('STORE_CLOSING');
    expect(nativeErrorCode(new Error('plain message'))).toBeUndefined();
    expect(nativeErrorCode(new Error('prefix [STORE_CLOSING] inside'))).toBeUndefined();
    expect(nativeErrorCode('text')).toBeUndefined();
  });
});
