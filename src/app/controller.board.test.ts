import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { boardIdentityKey } from '../lib/workspace';
import { boardPayload, createHarness, dividerBoard, deferred, enc, hexKey, makeBoard, openNative, registerBoard, seedWorkspace } from './testing';
import type { Harness } from './testing';

const fzKeyText = Array.from({ length: 44 }, (_, i) => (i + 1).toString(16)).join(' ');
const keyRequired = (kind: 'fz' | 'xzz', code: 'KEY_REQUIRED' | 'INVALID_KEY' = 'KEY_REQUIRED') => ({ formatError: { message: `Encrypted ${kind} board.`, code, format: kind, keyKind: kind } });

describe('board import', () => {
  it('parses in a worker, commits the board with its identity, accepts it as recent and creates its workspace', async () => {
    const h = createHarness();
    const payload = await openNative(h, 'a.cad', 1);
    const state = h.state();
    expect(state.board?.components.map(c => c.ref)).toEqual(['R1', 'R2', 'U1']);
    expect(state.boardKey).toBe(hexKey(1));
    expect(state.boardPath).toBe(payload.path);
    expect(state.import).toMatchObject({ phase: 'idle', keyRequest: null, file: { name: 'a.cad', path: payload.path, key: hexKey(1) } });
    expect(state.import.recents.map(r => r.path)).toEqual([payload.path]);
    expect(state.persistence).toBe('native');
    expect(state.manifest?.board).toMatchObject({ key: hexKey(1), name: 'a.cad', path: payload.path });
    expect(h.desktop.log).toContain(`acceptBoard:${hexKey(1)}`);
    expect(h.messages()).toEqual(['toast.loaded']);
    expect(h.boardWorkers.created).toBe(1);
    expect(h.boardWorkers.terminated).toBe(1);
    expect(h.state().notices[0]).toMatchObject({ kind: 'success', message: { key: 'toast.loaded' } });
  });

  it('opens through the native dialog (cancel is a no-op) and through dropped files with a native path', async () => {
    const h = createHarness();
    const a = registerBoard(h, 'a.cad', 1);
    await h.controller.actions.openBoard();
    expect(h.state().board).toBeNull();
    expect(h.state().notices).toEqual([]);
    h.desktop.dialog = a;
    await h.controller.actions.openBoard();
    await h.controller.idle();
    expect(h.state().boardKey).toBe(hexKey(1));
    const b = registerBoard(h, 'b.cad', 2);
    await h.controller.actions.openDropped([Object.assign(new File([enc('b')], 'b.cad'), { path: b.path })]);
    await h.controller.idle();
    expect(h.state().boardKey).toBe(hexKey(2));
    await h.controller.actions.openDropped([new File([enc('c')], 'c.cad')]);
    expect(h.state().boardKey).toBe(hexKey(2));
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error', message: { key: 'toast.pathUnavailable' } });
  });

  it('keeps the previous board when a new import fails, and reports the failure', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    const before = h.state().board;
    const bad = boardPayload('bad.cad', 2);
    h.desktop.boards.set(bad.path, bad);
    h.boardWorkers.replies['bad.cad'] = { error: 'boom' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await h.controller.actions.openRecent(bad.path);
    await h.controller.idle();
    expect(h.state().board).toBe(before);
    expect(h.state().boardKey).toBe(hexKey(1));
    expect(h.state().import.phase).toBe('idle');
    expect(h.messages()).toEqual(['toast.loaded', 'toast.parseFailed']);
    // An unreadable path is also just a notice, with the native text.
    await h.controller.actions.openRecent('/boards/missing.cad');
    expect(h.state().board).toBe(before);
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error', message: { text: 'The file was not found.' } });
    vi.restoreAllMocks();
  });

  it('latest request wins: a slower first import is cancelled and never replaces the second', async () => {
    const h = createHarness();
    const slow = registerBoard(h, 'slow.cad', 1, makeBoard('slow.cad', [{ ref: 'S1', pins: [['1', 'N']] }]));
    registerBoard(h, 'fast.cad', 2);
    const gate = deferred();
    h.boardWorkers.gates['slow.cad'] = gate.promise;
    const first = h.controller.actions.openRecent(slow.path);
    await vi.waitFor(() => expect(h.boardWorkers.created).toBe(1));
    await h.controller.actions.openRecent('/boards/fast.cad');
    gate.resolve();
    await first;
    await h.controller.idle();
    expect(h.state().boardKey).toBe(hexKey(2));
    expect(h.state().board?.components.map(c => c.ref)).toContain('R1');
    expect(h.boardWorkers.terminated).toBe(2);
    expect(h.messages()).toEqual(['toast.loaded']);
  });

  it('asks for a key without touching the open board; keys stay session-only and are validated before retrying', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    const enc1 = registerBoard(h, 'enc.fz', 2);
    h.boardWorkers.replies['enc.fz'] = keyRequired('fz');
    await h.controller.actions.openRecent(enc1.path);
    await h.controller.idle();
    expect(h.state().boardKey).toBe(hexKey(1));
    expect(h.state().import.keyRequest).toEqual({ fileName: 'enc.fz', kind: 'fz', code: 'KEY_REQUIRED', message: 'Encrypted fz board.' });
    // Invalid text only updates the hint; nothing is posted.
    h.controller.actions.submitKey('12 34');
    expect(h.state().import.keyRequest?.message).toBe('Enter 44 hexadecimal 32-bit words (2 so far).');
    expect(h.boardWorkers.created).toBe(2);
    // A valid key re-parses the same payload with the key in the worker options.
    h.boardWorkers.replies['enc.fz'] = makeBoard('enc.fz', [{ ref: 'Q1', id: 'q1', pins: [['1', 'X']] }]);
    h.controller.actions.submitKey(fzKeyText);
    await h.controller.idle();
    expect(h.state().boardKey).toBe(hexKey(2));
    expect(h.state().import.keyRequest).toBeNull();
    expect((h.boardWorkers.options.at(-1) as { fzKey: number[] }).fzKey).toHaveLength(44);
    expect(JSON.stringify(h.state())).not.toContain('fzKey');
    expect([...h.desktop.workspaces.values(), ...h.storage.values()].map(v => JSON.stringify(v)).join('')).not.toContain('fzKey');
  });

  it('a wrong key asks again (INVALID_KEY) and cancel clears the request', async () => {
    const h = createHarness();
    const enc1 = registerBoard(h, 'enc.xzz', 3);
    h.boardWorkers.replies['enc.xzz'] = keyRequired('xzz');
    await h.controller.actions.openRecent(enc1.path);
    await h.controller.idle();
    h.boardWorkers.replies['enc.xzz'] = keyRequired('xzz', 'INVALID_KEY');
    h.controller.actions.submitKey('0123456789abcdef');
    await h.controller.idle();
    expect(h.state().import.keyRequest).toMatchObject({ kind: 'xzz', code: 'INVALID_KEY' });
    expect(h.state().board).toBeNull();
    h.controller.actions.cancelKeyRequest();
    expect(h.state().import.keyRequest).toBeNull();
    // The file stays unopened: the user is told so, and a cancel with nothing pending says nothing.
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'info', message: { key: 'toast.openFailed' } });
    h.controller.actions.cancelKeyRequest();
    expect(h.messages().filter(message => message === 'toast.openFailed')).toHaveLength(1);
    h.controller.actions.submitKey('0123456789abcdef');
    await h.controller.idle();
    expect(h.boardWorkers.created).toBe(2);
  });

  it('W-win-import-02: a rejected key is forgotten, so the next encrypted file asks (KEY_REQUIRED) instead of silently reusing it', async () => {
    const h = createHarness();
    const first = registerBoard(h, 'one.fz', 2);
    h.boardWorkers.replies['one.fz'] = keyRequired('fz');
    await h.controller.actions.openRecent(first.path);
    await h.controller.idle();
    // The user types a key and the parser rejects it: INVALID_KEY, the dialog stays for another try.
    h.boardWorkers.replies['one.fz'] = keyRequired('fz', 'INVALID_KEY');
    h.controller.actions.submitKey(fzKeyText);
    await h.controller.idle();
    expect((h.boardWorkers.options.at(-1) as { fzKey?: number[] }).fzKey).toHaveLength(44); // the typed key was tried once
    expect(h.state().import.keyRequest).toMatchObject({ fileName: 'one.fz', code: 'INVALID_KEY' });
    h.controller.actions.cancelKeyRequest();
    // An unrelated encrypted file: no key may be applied behind the user's back.
    const second = registerBoard(h, 'two.fz', 3);
    h.boardWorkers.replies['two.fz'] = keyRequired('fz');
    await h.controller.actions.openRecent(second.path);
    await h.controller.idle();
    expect(h.boardWorkers.options.at(-1)).not.toHaveProperty('fzKey');
    expect(h.state().import.keyRequest).toEqual({ fileName: 'two.fz', kind: 'fz', code: 'KEY_REQUIRED', message: 'Encrypted fz board.' });
  });

  it('W-win-import-02: the dialog stays usable after a rejection (a corrected key is stored and applied) and an accepted key is still reused for the next file', async () => {
    const h = createHarness();
    const first = registerBoard(h, 'one.fz', 2);
    h.boardWorkers.replies['one.fz'] = keyRequired('fz');
    await h.controller.actions.openRecent(first.path);
    await h.controller.idle();
    h.boardWorkers.replies['one.fz'] = keyRequired('fz', 'INVALID_KEY');
    h.controller.actions.submitKey(fzKeyText);
    await h.controller.idle();
    // Retry in the same dialog with another key: the parser accepts it.
    const betterKey = Array.from({ length: 44 }, (_, i) => (i + 101).toString(16)).join(' ');
    h.boardWorkers.replies['one.fz'] = makeBoard('one.fz', [{ ref: 'Q1', id: 'q1', pins: [['1', 'X']] }]);
    h.controller.actions.submitKey(betterKey);
    await h.controller.idle();
    expect(h.state().boardKey).toBe(hexKey(2));
    expect((h.boardWorkers.options.at(-1) as { fzKey: number[] }).fzKey[0]).toBe(0x65);
    // The accepted key stays the session key: the next encrypted file of the same family is parsed with it, without a dialog.
    const second = registerBoard(h, 'two.fz', 3);
    await h.controller.actions.openRecent(second.path);
    await h.controller.idle();
    expect((h.boardWorkers.options.at(-1) as { fzKey: number[] }).fzKey[0]).toBe(0x65);
    expect(h.state().import.keyRequest).toBeNull();
  });

  it('W-win-import-02: only the rejected kind of key is forgotten (an accepted FZ key survives a rejected XZZ key)', async () => {
    const h = createHarness();
    const fz = registerBoard(h, 'one.fz', 2);
    h.boardWorkers.replies['one.fz'] = keyRequired('fz');
    await h.controller.actions.openRecent(fz.path);
    await h.controller.idle();
    h.boardWorkers.replies['one.fz'] = makeBoard('one.fz', [{ ref: 'Q1', id: 'q1', pins: [['1', 'X']] }]);
    h.controller.actions.submitKey(fzKeyText);
    await h.controller.idle();
    const xzz = registerBoard(h, 'enc.xzz', 3);
    h.boardWorkers.replies['enc.xzz'] = keyRequired('xzz');
    await h.controller.actions.openRecent(xzz.path);
    await h.controller.idle();
    h.boardWorkers.replies['enc.xzz'] = keyRequired('xzz', 'INVALID_KEY');
    h.controller.actions.submitKey('0123456789abcdef');
    await h.controller.idle();
    h.controller.actions.cancelKeyRequest();
    const next = registerBoard(h, 'two.xzz', 4);
    h.boardWorkers.replies['two.xzz'] = keyRequired('xzz');
    await h.controller.actions.openRecent(next.path);
    await h.controller.idle();
    const options = h.boardWorkers.options.at(-1) as { fzKey?: number[]; xzzKey?: string };
    expect(options.fzKey).toHaveLength(44);
    expect(options).not.toHaveProperty('xzzKey');
  });

  it('a newer import dismisses a pending key request', async () => {
    const h = createHarness();
    const enc1 = registerBoard(h, 'enc.fz', 2);
    h.boardWorkers.replies['enc.fz'] = keyRequired('fz');
    await h.controller.actions.openRecent(enc1.path);
    await h.controller.idle();
    expect(h.state().import.keyRequest).not.toBeNull();
    await openNative(h, 'b.cad', 5);
    expect(h.state().import.keyRequest).toBeNull();
    expect(h.state().boardKey).toBe(hexKey(5));
  });

  it('startup: loads the initial board, falls back through recents when it fails, and follows external open events', async () => {
    const h = createHarness();
    const initial = boardPayload('last.cad', 7, { startupSource: 'recent' });
    h.desktop.initial = initial;
    h.boardWorkers.replies['last.cad'] = { error: 'broken' };
    const ok = registerBoard(h, 'older.cad', 8);
    const gone = '/boards/gone.cad';
    h.desktop.recents = [{ name: 'last.cad', path: initial.path, openedAt: '' }, { name: 'gone.cad', path: gone, openedAt: '' }, { name: 'older.cad', path: ok.path, openedAt: '' }];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = h.controller.start();
    await h.controller.idle();
    expect(h.state().boardKey).toBe(hexKey(8));
    expect(h.state().import.recents.length).toBeGreaterThan(0);
    // External open (second instance / OS file association).
    registerBoard(h, 'ext.cad', 9);
    h.desktop.emitOpen(h.desktop.boards.get('/boards/ext.cad')!);
    await h.controller.idle();
    expect(h.state().boardKey).toBe(hexKey(9));
    stop();
    registerBoard(h, 'after.cad', 10);
    h.desktop.emitOpen(h.desktop.boards.get('/boards/after.cad')!);
    await h.controller.idle();
    expect(h.state().boardKey).toBe(hexKey(9));
    vi.restoreAllMocks();
  });

  it('startup does not try other recents when the initial board only needs a key', async () => {
    const h = createHarness();
    h.desktop.initial = boardPayload('enc.fz', 7, { startupSource: 'recent' });
    h.boardWorkers.replies['enc.fz'] = keyRequired('fz');
    const other = registerBoard(h, 'other.cad', 8);
    h.desktop.recents = [{ name: 'enc.fz', path: '/boards/enc.fz', openedAt: '' }, { name: 'other.cad', path: other.path, openedAt: '' }];
    h.controller.start();
    await h.controller.idle();
    expect(h.state().board).toBeNull();
    expect(h.state().import.keyRequest).toMatchObject({ fileName: 'enc.fz' });
  });

  it('closeBoard clears every board-scoped slice and cancels a running import', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    h.controller.actions.selectComponent('r1', { center: true });
    h.controller.actions.setSearchQuery('R1');
    const slow = registerBoard(h, 'slow.cad', 2);
    h.boardWorkers.gates['slow.cad'] = new Promise(() => {});
    void h.controller.actions.openRecent(slow.path);
    await vi.waitFor(() => expect(h.boardWorkers.created).toBe(2));
    h.controller.actions.closeBoard();
    await h.controller.idle();
    const state = h.state();
    expect(state).toMatchObject({ board: null, boardKey: null, manifest: null, documents: [], notes: [], selection: { componentId: null }, link: null, import: { file: null, phase: 'idle' } });
    expect(state.search).toMatchObject({ query: '', result: null });
    expect(h.boardWorkers.terminated).toBe(2);
  });
});

describe('browser fallback', () => {
  const file = (name: string, bytes: Uint8Array) => new File([bytes as Uint8Array<ArrayBuffer>], name);

  it('imports files through the chooser, keys the board by content and keeps the workspace in memory only', async () => {
    const h = createHarness({ browser: true });
    h.boardWorkers.replies['a.cad'] = dividerBoard('a.cad');
    const bytes = enc('GENCAD a');
    h.pickQueue.push([file('a.cad', bytes)]);
    await h.controller.actions.openBoard();
    await h.controller.idle();
    const state = h.state();
    expect(state.boardKey).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(state.persistence).toBe('session-only');
    expect(state.manifest).toBeNull();
    expect(state.import.file).toEqual({ name: 'a.cad', path: '', key: state.boardKey });
    h.controller.actions.setActiveTab('documents');
    expect(h.state().activeTab).toBe('documents');
    expect(h.state().manifest).toBeNull();
  });

  it('uses the primary plus its companions for the identity (independent of which file was picked first)', async () => {
    const files = { 'format.asc': enc('F'), 'pins.asc': enc('P'), 'nails.asc': enc('N') };
    const keys: string[] = [];
    for (const order of [['format.asc', 'pins.asc', 'nails.asc'], ['pins.asc', 'nails.asc', 'format.asc']] as const) {
      const h = createHarness({ browser: true });
      for (const name of Object.keys(files)) h.boardWorkers.replies[name] = dividerBoard(name);
      await h.controller.actions.openDropped([...order.map(name => file(name, files[name])), file('unrelated.txt', enc('x'))]);
      await h.controller.idle();
      keys.push(h.state().boardKey!);
    }
    const expected = await boardIdentityKey(Object.entries(files).map(([name, data]) => ({ name, data })));
    expect(keys).toEqual([expected, expected]);
  });

  it('stores notes in the injected storage and reports an unreadable stored value instead of overwriting it', async () => {
    const h = createHarness({ browser: true });
    h.boardWorkers.replies['a.cad'] = dividerBoard('a.cad');
    const bytes = enc('GENCAD a');
    const key = createHash('sha256').update(bytes).digest('hex');
    h.storage.set(`trace-notes-${key}`, '{not json');
    await h.controller.actions.openDropped([file('a.cad', bytes)]);
    await h.controller.idle();
    expect(h.state().notesBlocked).toEqual({ key: 'toast.notesUnreadable' });
    await h.controller.actions.upsertNote({ componentId: 'r1' }, { text: 'x' });
    expect(h.storage.get(`trace-notes-${key}`)).toBe('{not json');
    expect(h.state().notes).toEqual([]);
    h.storage.set(`trace-notes-${key}`, '[]');
    await h.controller.actions.retryNotes();
    expect(h.state().notesBlocked).toBeNull();
    await h.controller.actions.upsertNote({ componentId: 'r1' }, { text: 'checked' });
    expect(JSON.parse(h.storage.get(`trace-notes-${key}`)!)).toMatchObject([{ componentId: 'r1', text: 'checked' }]);
  });
});

describe('notes', () => {
  async function opened(): Promise<Harness> {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    return h;
  }

  it('creates, changes and deletes one note per target through desktop.saveNotes; pin notes and measurements are separate', async () => {
    const h = await opened();
    const { upsertNote } = h.controller.actions;
    await upsertNote({ componentId: 'r1' }, { text: 'bulged' });
    await upsertNote({ componentId: 'r1', pinId: 'r1.1.0' }, { text: '', measurements: { voltage: '1.8 V' } });
    expect(h.state().notes.map(n => [n.componentId, n.pinId, n.text, n.measurements])).toEqual([['r1', undefined, 'bulged', undefined], ['r1', 'r1.1.0', '', { voltage: '1.8 V' }]]);
    expect(h.desktop.notes.get(hexKey(1))).toHaveLength(2);
    await upsertNote({ componentId: 'r1' }, { text: 'replaced' });
    expect(h.state().notes.filter(n => n.componentId === 'r1' && !n.pinId)).toHaveLength(1);
    await upsertNote({ componentId: 'r1' }, { text: '' });
    expect(h.state().notes.map(n => n.pinId)).toEqual(['r1.1.0']);
    expect(h.messages().filter(m => m === 'toast.noteDeleted')).toHaveLength(1);
    const same = h.state().notes;
    await upsertNote({ componentId: 'r1', pinId: 'r1.1.0' }, { measurements: { voltage: '1.8 V' } });
    expect(h.state().notes).toBe(same);
  });

  it('serializes concurrent saves so none is lost', async () => {
    const h = await opened();
    await Promise.all([
      h.controller.actions.upsertNote({ componentId: 'r1' }, { text: 'one' }),
      h.controller.actions.upsertNote({ componentId: 'r2' }, { text: 'two' }),
      h.controller.actions.upsertNote({ componentId: 'u1' }, { text: 'three' }),
    ]);
    expect(h.desktop.notes.get(hexKey(1))?.map(n => n.text).sort()).toEqual(['one', 'three', 'two']);
    expect(h.state().notes).toHaveLength(3);
  });

  it('rejects an over-long note with a message and writes nothing', async () => {
    const h = await opened();
    await h.controller.actions.upsertNote({ componentId: 'r1' }, { text: 'x'.repeat(8001) });
    expect(h.state().notes).toEqual([]);
    expect(h.desktop.notes.has(hexKey(1))).toBe(false);
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('blocks writes while the stored notes are unreadable and recovers through retryNotes', async () => {
    const h = createHarness();
    h.desktop.failures.getNotes = () => new Error("Error invoking remote method 'trace:get-notes': Error: [NOTES_INVALID] The notes file is damaged.");
    await openNative(h, 'a.cad', 1);
    expect(h.state().notesBlocked).toEqual({ text: 'The notes file is damaged.' });
    expect(h.messages()).toContain('toast.loadedNotesLocked');
    await h.controller.actions.upsertNote({ componentId: 'r1' }, { text: 'lost?' });
    expect(h.desktop.log.filter(l => l.startsWith('saveNotes'))).toEqual([]);
    await h.controller.actions.retryNotes();
    expect(h.state().notesBlocked).toEqual({ text: 'The notes file is damaged.' });
    delete h.desktop.failures.getNotes;
    h.desktop.notes.set(hexKey(1), [{ id: 'n1', componentId: 'u1', text: 'kept', updatedAt: '2026-10-05T10:00:00.000Z' }]);
    await h.controller.actions.retryNotes();
    expect(h.state().notesBlocked).toBeNull();
    expect(h.state().notes.map(n => n.text)).toEqual(['kept']);
    expect(h.messages().at(-1)).toBe('toast.notesReloaded');
  });

  it('a save that finishes after a board switch never lands on the other board (race)', async () => {
    const h = await opened();
    const gate = deferred();
    h.desktop.holds.saveNotes = key => (key === hexKey(1) ? gate.promise : undefined);
    const saving = h.controller.actions.upsertNote({ componentId: 'r1' }, { text: 'for board A' });
    await vi.waitFor(() => expect(h.desktop.log).toContain(`saveNotes:${hexKey(1)}`));
    // idle() would wait for the held save, so the switch is awaited through its outcome instead.
    registerBoard(h, 'b.cad', 2);
    await h.controller.actions.openRecent('/boards/b.cad');
    await vi.waitFor(() => expect(h.state().manifest?.board.key).toBe(hexKey(2)));
    const noticesBefore = h.state().notices.length;
    gate.resolve();
    await saving;
    await h.controller.idle();
    expect(h.state().boardKey).toBe(hexKey(2));
    expect(h.state().notes).toEqual([]);
    expect(h.state().notices).toHaveLength(noticesBefore);
    expect(h.desktop.notes.get(hexKey(1))).toMatchObject([{ text: 'for board A' }]);
    expect(h.desktop.notes.has(hexKey(2))).toBe(false);
    // The new board can save normally.
    await h.controller.actions.upsertNote({ componentId: 'r1' }, { text: 'for board B' });
    expect(h.desktop.notes.get(hexKey(2))).toMatchObject([{ text: 'for board B' }]);
  });

  it('a failing save is reported and the shown notes stay as stored', async () => {
    const h = await opened();
    h.desktop.failures.saveNotes = () => new Error("Error invoking remote method 'trace:save-notes': Error: [STORE_WRITE_FAILED] Disk full.");
    await h.controller.actions.upsertNote({ componentId: 'r1' }, { text: 'x' });
    expect(h.state().notes).toEqual([]);
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error', message: { text: 'Disk full.' } });
  });
});

describe('workspace persistence', () => {
  it('creates a manifest for a new board (nothing is written until something changes) and loads the stored one otherwise', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    expect(h.state().manifest).toMatchObject({ version: 1, documents: [], activeTab: 'board' });
    expect(h.desktop.log.filter(l => l.startsWith('saveWorkspace'))).toEqual([]);
    const stored = seedWorkspace(h, 2, '/boards/b.cad', []);
    await openNative(h, 'b.cad', 2);
    expect(h.state().manifest?.board.key).toBe(stored.board.key);
    expect(h.state().manifest?.updatedAt).toBe(stored.updatedAt);
  });

  it('refreshes the stored board path/name, drops stale references (reconcile) and reports a damaged file without overwriting it', async () => {
    const h = createHarness();
    const stored = seedWorkspace(h, 1, '/old/place/a.cad', []);
    h.desktop.workspaces.set(hexKey(1), { ...stored, cameras: { ghost: { zoom: 2 }, board: { zoom: 3 } }, split: { enabled: true, ratio: 0.4, right: { kind: 'document', id: 'ghost' } } });
    await openNative(h, 'a.cad', 1);
    expect(h.state().manifest?.board.path).toBe('/boards/a.cad');
    expect(h.state().manifest?.cameras).toEqual({ board: { zoom: 3 } });
    expect(h.state().split.right).toBeNull();

    const broken = createHarness();
    broken.desktop.failures.loadWorkspace = () => new Error("Error invoking remote method 'trace:load-workspace': Error: [MANIFEST_INVALID] Invalid workspace manifest: documents.");
    await openNative(broken, 'a.cad', 1);
    expect(broken.state().save.failure).toContain('Invalid workspace manifest');
    broken.controller.actions.setActiveTab('documents');
    await broken.controller.flush();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(broken.desktop.log.filter(l => l.startsWith('saveWorkspace'))).toEqual([]);
    expect(broken.state().notices.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('saves after a quiet period, reports dirty/saving, and flush() writes immediately', async () => {
    const h = createHarness({ saveDelayMs: 10_000 });
    await openNative(h, 'a.cad', 1);
    h.controller.actions.setActiveTab('documents');
    h.controller.actions.setSplit({ enabled: true, ratio: 0.9 });
    expect(h.state().save).toMatchObject({ dirty: true, failure: null });
    expect(h.state().split).toMatchObject({ enabled: true, ratio: 0.8 });
    await h.controller.flush();
    expect(h.state().save).toEqual({ dirty: false, saving: false, failure: null });
    expect(h.desktop.workspaces.get(hexKey(1))).toMatchObject({ activeTab: 'documents', split: { enabled: true, ratio: 0.8 } });
    expect(h.desktop.log.filter(l => l.startsWith('saveWorkspace'))).toHaveLength(1);
  });

  it('flushes the old workspace before the next board is loaded or committed (ordering)', async () => {
    const h = createHarness({ saveDelayMs: 10_000 });
    await openNative(h, 'a.cad', 1);
    h.controller.actions.setActiveTab('schematic');
    registerBoard(h, 'b.cad', 2);
    await h.controller.actions.openRecent('/boards/b.cad');
    await h.controller.idle();
    const log = h.desktop.log;
    expect(log.indexOf(`saveWorkspace:${hexKey(1)}`)).toBeGreaterThan(-1);
    expect(log.indexOf(`saveWorkspace:${hexKey(1)}`)).toBeLessThan(log.indexOf(`loadWorkspace:${hexKey(2)}`));
    expect(h.desktop.workspaces.get(hexKey(1))?.activeTab).toBe('schematic');
    expect(h.state().boardKey).toBe(hexKey(2));
    expect(h.state().activeTab).toBe('board');
    expect(h.state().save.dirty).toBe(false);
  });

  it('re-opening the same board after closing it reads what the close just wrote', async () => {
    const h = createHarness({ saveDelayMs: 10_000 });
    await openNative(h, 'a.cad', 1);
    h.controller.actions.setActiveTab('documents');
    h.controller.actions.closeBoard();
    await openNative(h, 'a.cad', 1);
    expect(h.state().activeTab).toBe('documents');
  });

  it('a failing save shows state.save.failure once and the next successful write clears it', async () => {
    const h = createHarness({ saveDelayMs: 1 });
    await openNative(h, 'a.cad', 1);
    h.desktop.failures.saveWorkspace = () => new Error("Error invoking remote method 'trace:save-workspace': Error: [STORE_TOO_LARGE] The workspace is too large.");
    h.controller.actions.setActiveTab('documents');
    await vi.waitFor(() => expect(h.state().save.failure).toBe('The workspace is too large.'));
    expect(h.state().notices.filter(n => 'text' in n.message && n.message.text.includes('could not be saved'))).toHaveLength(1);
    delete h.desktop.failures.saveWorkspace;
    await h.controller.flush();
    expect(h.state().save).toEqual({ dirty: false, saving: false, failure: null });
  });

  it('camera updates persist without changing the document list; an identical camera changes nothing', async () => {
    const h = createHarness({ saveDelayMs: 10_000 });
    seedWorkspace(h, 1, '/boards/a.cad', [{ id: 'doc-pdf', path: '/boards/docs/a.pdf', kind: 'pdf', key: 11 }]);
    await openNative(h, 'a.cad', 1);
    const documents = h.state().documents;
    const listener = vi.fn();
    h.controller.subscribe(listener);
    h.controller.actions.setCamera('board', { zoom: 2, x: 5, y: 6 });
    const manifest = h.state().manifest;
    expect(manifest?.cameras.board).toEqual({ zoom: 2, x: 5, y: 6 });
    expect(h.state().documents).toBe(documents);
    expect(h.controller.actions.cameraOf('board')).toEqual({ zoom: 2, x: 5, y: 6 });
    const calls = listener.mock.calls.length;
    h.controller.actions.setCamera('board', { zoom: 2, x: 5, y: 6 });
    expect(h.state().manifest).toBe(manifest);
    expect(listener.mock.calls.length).toBe(calls);
    h.controller.actions.setCamera('doc-pdf', { page: 3, zoom: 1.5 });
    h.controller.actions.setCamera('nope', { zoom: 1 });
    h.controller.actions.setCamera('board', { zoom: -4 });
    expect(h.controller.actions.cameraOf('doc-pdf')).toEqual({ page: 3, zoom: 1.5 });
    expect(h.controller.actions.cameraOf('nope')).toEqual({});
    expect(h.state().manifest?.cameras.board).toEqual({ zoom: 2, x: 5, y: 6 });
    await h.controller.flush();
    expect(h.desktop.workspaces.get(hexKey(1))?.cameras).toEqual({ board: { zoom: 2, x: 5, y: 6 }, 'doc-pdf': { page: 3, zoom: 1.5 } });
  });
});
