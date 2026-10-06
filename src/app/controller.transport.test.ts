import { describe, expect, it } from 'vitest';
import type { DocumentRuntime } from './api';
import { createHarness, deferred, dividerBoard, documentPayload, enc, flushMicrotasks, kicadText, openNative, seedWorkspace } from './testing';
import type { Harness } from './testing';

/** The original synthetic generator of the audit reproduction (203 bytes per label of this length). */
const eagle = (label: string) => `<eagle version="9.7.0"><drawing><schematic><libraries/><parts/><sheets><sheet><plain><text x="1" y="1" size="1">${label}</text></plain><instances/><nets/></sheet></sheets></schematic></drawing></eagle>`;
const file = (name: string, bytes: Uint8Array) => new File([bytes as Uint8Array<ArrayBuffer>], name);
const doc = (h: Harness, name: string): DocumentRuntime => h.state().documents.find(d => d.record.name === name)!;
const labelsOf = (runtime: DocumentRuntime) => JSON.stringify(runtime.design?.schematic);

/** Browser fallback with a tiny board already open; schematic requests travel through a real structured-clone transfer. */
async function browserWithBoard(): Promise<Harness> {
  const h = createHarness({ browser: true });
  h.boardWorkers.replies['tiny.cad'] = dividerBoard('tiny.cad');
  h.pickQueue.push([file('tiny.cad', enc('GENCAD tiny'))]);
  await h.controller.actions.openBoard();
  await h.controller.idle();
  expect(h.state().board?.name).toBe('tiny.cad');
  return h;
}

describe('B42: every schematic worker request owns its transferable bytes', () => {
  it('the generator produces the audited 203-byte originals', () => {
    expect(enc(eagle('ORIGINAL-A')).byteLength).toBe(203);
    expect(enc(eagle('ORIGINAL-B')).byteLength).toBe(203);
  });

  it('two different schematics attached together both reach ready with their own design', async () => {
    const h = await browserWithBoard();
    await h.controller.actions.attachFiles([file('a.sch', enc(eagle('ORIGINAL-A'))), file('b.sch', enc(eagle('ORIGINAL-B')))]);
    await h.controller.idle();
    const [a, b] = [doc(h, 'a.sch'), doc(h, 'b.sch')];
    expect([a.status, a.designState, b.status, b.designState]).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect(a.designError).toBeUndefined();
    expect(b.designError).toBeUndefined();
    expect(labelsOf(a)).toContain('ORIGINAL-A');
    expect(labelsOf(a)).not.toContain('ORIGINAL-B');
    expect(labelsOf(b)).toContain('ORIGINAL-B');
    expect(labelsOf(b)).not.toContain('ORIGINAL-A');
    // Each request carried the full, undetached payload and the sibling as its companion.
    expect(h.schematicWorkers.posted.map(request => request.data.byteLength)).toEqual([203, 203]);
    expect(h.schematicWorkers.posted.map(request => Object.fromEntries(Object.entries(request.companions ?? {}).map(([name, bytes]) => [name, bytes.byteLength])))).toEqual([{ 'b.sch': 203 }, { 'a.sch': 203 }]);
    expect(h.state().notices.filter(notice => notice.kind === 'error')).toEqual([]);
    expect(h.schematicWorkers.created).toBe(2);
    expect(h.schematicWorkers.terminated).toBe(0);
  });

  it('control: one schematic alone, and a schematic with a library companion, still parse', async () => {
    const h = await browserWithBoard();
    await h.controller.actions.attachFiles([file('a.sch', enc(eagle('ORIGINAL-A')))]);
    await h.controller.idle();
    expect(doc(h, 'a.sch')).toMatchObject({ status: 'ready', designState: 'ready' });
    const lib = enc('EESchema-LIBRARY Version 2.4');
    await h.controller.actions.attachFiles([file('top.kicad_sch', enc(kicadText())), file('sym.lib', lib)]);
    await h.controller.idle();
    expect(doc(h, 'top.kicad_sch')).toMatchObject({ status: 'ready', designState: 'ready' });
    const request = h.schematicWorkers.posted.at(-1)!;
    expect(Object.keys(request.companions ?? {})).toEqual(['sym.lib']);
    expect(request.companions!['sym.lib']).toEqual(lib);
  });

  it('later attachments, duplicate attaches and re-attaching after removal keep working with intact companions', async () => {
    const h = await browserWithBoard();
    const A = enc(eagle('ORIGINAL-A')), B = enc(eagle('ORIGINAL-B')), C = enc(eagle('ORIGINAL-C'));
    await h.controller.actions.attachFiles([file('a.sch', A), file('b.sch', B)]);
    await h.controller.idle();
    // The same bytes again attach nothing (duplicate), without a new request.
    await h.controller.actions.attachFiles([file('a.sch', A), file('b.sch', B)]);
    await h.controller.idle();
    expect(h.state().documents).toHaveLength(2);
    expect(h.schematicWorkers.posted).toHaveLength(2);
    // A later third schematic sees the earlier ones as companions only when they are part of its own batch.
    await h.controller.actions.attachFiles([file('c.sch', C)]);
    await h.controller.idle();
    expect(doc(h, 'c.sch')).toMatchObject({ status: 'ready', designState: 'ready' });
    expect(labelsOf(doc(h, 'c.sch'))).toContain('ORIGINAL-C');
    expect(h.schematicWorkers.posted.at(-1)!.companions).toBeUndefined();
    // Remove one and attach it again together with a new sibling: both requests are complete.
    h.controller.actions.removeDocument(doc(h, 'a.sch').record.id);
    await h.controller.actions.attachFiles([file('a.sch', A), file('c.sch', C), file('d.sch', enc(eagle('ORIGINAL-D')))]);
    await h.controller.idle();
    expect(h.state().documents.map(d => [d.record.name, d.status])).toEqual([['b.sch', 'ready'], ['c.sch', 'ready'], ['a.sch', 'ready'], ['d.sch', 'ready']]);
    const lastTwo = h.schematicWorkers.posted.slice(-2);
    expect(lastTwo.map(request => request.data.byteLength)).toEqual([203, 203]);
    expect(lastTwo.map(request => Object.values(request.companions ?? {}).every(bytes => bytes.byteLength === 203))).toEqual([true, true]);
    expect(h.state().notices.filter(notice => notice.kind === 'error')).toEqual([]);
  });

  it('relink re-posts the same document with fresh bytes (the controller keeps nothing detached)', async () => {
    const h = await browserWithBoard();
    const A = enc(eagle('ORIGINAL-A'));
    await h.controller.actions.attachFiles([file('a.sch', A), file('b.sch', enc(eagle('ORIGINAL-B')))]);
    await h.controller.idle();
    const id = doc(h, 'a.sch').record.id;
    h.pickQueue.push([file('a-copy.sch', A)]);
    await h.controller.actions.relinkDocument(id);
    await h.controller.idle();
    expect(doc(h, 'a-copy.sch')).toMatchObject({ status: 'ready', designState: 'ready' });
    expect(h.schematicWorkers.posted).toHaveLength(3);
    expect(h.schematicWorkers.posted.at(-1)!.data.byteLength).toBe(203);
  });

  it('native: re-reading a payload object the bridge hands out again does not find it detached', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [{ id: 'doc-sch', path: '/boards/docs/divider.kicad_sch', kind: 'schematic', key: 41 }]);
    const path = '/boards/docs/divider.kicad_sch';
    h.desktop.docs.set(path, documentPayload(path, 'schematic', 41, { data: enc(kicadText()) }));
    await openNative(h, 'a.cad', 1);
    expect(h.state().documents[0]).toMatchObject({ status: 'ready', designState: 'ready' });
    // Opening the same board again reads the very same payload object again.
    h.controller.actions.closeBoard();
    await openNative(h, 'a.cad', 1);
    expect(h.state().documents[0]).toMatchObject({ status: 'ready', designState: 'ready' });
    expect(h.schematicWorkers.posted).toHaveLength(2);
  });

  it('a request that is still in flight when its document is removed (or the board closes) never throws', async () => {
    const h = await browserWithBoard();
    const gate = deferred();
    h.schematicWorkers.gates['a.sch'] = gate.promise;
    await h.controller.actions.attachFiles([file('a.sch', enc(eagle('ORIGINAL-A'))), file('b.sch', enc(eagle('ORIGINAL-B')))]);
    h.controller.actions.removeDocument(doc(h, 'a.sch').record.id);
    gate.resolve();
    await flushMicrotasks();
    await h.controller.idle();
    expect(h.state().documents.map(d => [d.record.name, d.status])).toEqual([['b.sch', 'ready']]);
    expect(labelsOf(doc(h, 'b.sch'))).toContain('ORIGINAL-B');
    expect(h.state().notices.filter(notice => notice.kind === 'error')).toEqual([]);
    h.controller.actions.closeBoard();
    await h.controller.idle();
    expect(h.state().documents).toEqual([]);
  });
});

describe('B43: an old browser chooser result never supersedes a newer board intent', () => {
  const board = (h: Harness, name: string) => { h.boardWorkers.replies[name] = dividerBoard(name); return file(name, enc(`GENCAD ${name}`)); };
  const openedName = (h: Harness) => h.state().board?.name ?? null;

  it('audit reproduction: openBoard() waits in the chooser, a newer drop completes, then the older result arrives', async () => {
    const h = createHarness({ browser: true });
    const older = board(h, 'older.cad'), newer = board(h, 'newer.cad');
    const chooser = deferred<File[]>();
    h.pickHolds.push(chooser.promise);
    const opening = h.controller.actions.openBoard();
    await h.controller.actions.openDropped([newer]);
    await h.controller.idle();
    expect(openedName(h)).toBe('newer.cad');
    const key = h.state().boardKey;
    chooser.resolve([older]);
    await opening;
    await h.controller.idle();
    expect(openedName(h)).toBe('newer.cad');
    expect(h.state().boardKey).toBe(key);
    expect(h.state().import).toMatchObject({ phase: 'idle', keyRequest: null, file: { name: 'newer.cad' } });
    // The older file was dropped before any parser was started, and no error was reported for it.
    expect(h.boardWorkers.created).toBe(1);
    expect(h.state().notices.filter(notice => notice.kind === 'error')).toEqual([]);
  });

  it('control: a chooser that resolves first (nothing newer) opens its board, and a later intent still replaces it', async () => {
    const h = createHarness({ browser: true });
    const first = board(h, 'first.cad'), second = board(h, 'second.cad');
    const chooser = deferred<File[]>();
    h.pickHolds.push(chooser.promise);
    const opening = h.controller.actions.openBoard();
    chooser.resolve([first]);
    await opening;
    await h.controller.idle();
    expect(openedName(h)).toBe('first.cad');
    await h.controller.actions.openDropped([second]);
    await h.controller.idle();
    expect(openedName(h)).toBe('second.cad');
  });

  it('a cancelled chooser changes nothing: the open board stays and the import state is idle', async () => {
    const h = createHarness({ browser: true });
    const current = board(h, 'current.cad');
    await h.controller.actions.openDropped([current]);
    await h.controller.idle();
    const chooser = deferred<File[]>();
    h.pickHolds.push(chooser.promise);
    const opening = h.controller.actions.openBoard();
    chooser.resolve([]);
    await opening;
    await h.controller.idle();
    expect(openedName(h)).toBe('current.cad');
    expect(h.state().import).toMatchObject({ phase: 'idle', keyRequest: null });
    expect(h.state().notices.filter(notice => notice.kind === 'error')).toEqual([]);
  });

  it('a chooser that fails reports an error notice instead of rejecting the action', async () => {
    const h = createHarness({ browser: true });
    const chooser = deferred<File[]>();
    h.pickHolds.push(chooser.promise);
    const opening = h.controller.actions.openBoard();
    chooser.reject(new Error('chooser exploded'));
    await expect(opening).resolves.toBeUndefined();
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error' });
    expect(openedName(h)).toBeNull();
  });

  it('two choosers racing: the latest intent wins whichever result arrives first', async () => {
    for (const order of [['second', 'first'], ['first', 'second']] as const) {
      const h = createHarness({ browser: true });
      const a = board(h, 'a.cad'), b = board(h, 'b.cad');
      const chooser = { first: deferred<File[]>(), second: deferred<File[]>() };
      h.pickHolds.push(chooser.first.promise, chooser.second.promise);
      const firstOpen = h.controller.actions.openBoard();
      const secondOpen = h.controller.actions.openBoard();
      const files = { first: [a], second: [b] };
      for (const which of order) { chooser[which].resolve(files[which]); await flushMicrotasks(); }
      await Promise.all([firstOpen, secondOpen]);
      await h.controller.idle();
      expect(openedName(h)).toBe('b.cad');
      expect(h.boardWorkers.created).toBe(1);
    }
  });

  it('sequential control: opening through the chooser and then another file keeps the newer board', async () => {
    const h = createHarness({ browser: true });
    h.pickQueue.push([board(h, 'older.cad')]);
    await h.controller.actions.openBoard();
    await h.controller.idle();
    expect(openedName(h)).toBe('older.cad');
    h.pickQueue.push([board(h, 'newer.cad')]);
    await h.controller.actions.openBoard();
    await h.controller.idle();
    expect(openedName(h)).toBe('newer.cad');
  });
});

describe('quit-time *_CLOSING failures are silent', () => {
  const closing = (code: string, channel = 'trace:x') => new Error(`Error invoking remote method '${channel}': Error: [${code}] The application is quitting.`);
  const errorNotices = (h: Harness) => h.state().notices.filter(notice => notice.kind === 'error');

  it('shows no error notice and does not retry for open, read, attach, notes, export and save failures; other codes still notify', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [{ id: 'doc-pdf', path: '/boards/docs/service.pdf', kind: 'pdf', key: 42 }]);
    h.desktop.failures.openBoard = () => closing('BOARD_CLOSING');
    await h.controller.actions.openBoard();
    h.desktop.failures.openBoard = undefined;
    h.desktop.failures.readBoard = () => closing('BOARD_CLOSING');
    await h.controller.actions.openRecent('/boards/a.cad');
    await h.controller.actions.openDropped([Object.assign(new File([enc('x')], 'a.cad'), { path: '/boards/a.cad' })]);
    h.desktop.failures.readBoard = undefined;
    expect(errorNotices(h)).toEqual([]);
    expect(h.state().import.phase).toBe('idle');

    // The board opens; its document read, the attach picker, the export and every write fail with a closing code.
    h.desktop.failures.readDocument = () => closing('DOCUMENT_CLOSING');
    h.desktop.failures.getNotes = () => closing('STORE_CLOSING');
    await openNative(h, 'a.cad', 1);
    expect(errorNotices(h)).toEqual([]);
    h.desktop.failures.getNotes = undefined;
    await h.controller.actions.retryNotes();
    h.desktop.pickDocuments = async () => { throw closing('DOCUMENT_CLOSING'); };
    h.desktop.exportWorkspace = async () => { throw closing('EXPORT_CLOSING'); };
    await h.controller.actions.attachDocuments();
    await expect(h.controller.actions.exportWorkspace({ documentIds: [], includeBoard: true, includeNotes: false })).resolves.toBeNull();
    h.desktop.failures.saveNotes = () => closing('STORE_CLOSING');
    await h.controller.actions.upsertNote({ componentId: 'r1' }, { text: 'quitting' });
    h.desktop.failures.saveWorkspace = () => closing('STORE_CLOSING');
    h.controller.actions.setCamera('board', { zoom: 2, x: 0, y: 0 });
    await h.controller.flush();
    await h.controller.idle();
    expect(errorNotices(h)).toEqual([]);
    expect(h.state().save).toMatchObject({ failure: null });
    expect(h.desktop.log.filter(entry => entry.startsWith('saveWorkspace:'))).toHaveLength(1);

    // Control: a failure that is not a quit-time code is still reported.
    h.desktop.failures.saveNotes = () => new Error("Error invoking remote method 'trace:save-notes': Error: [STORE_TOO_LARGE] The notes are too large.");
    await h.controller.actions.upsertNote({ componentId: 'r2' }, { text: 'too large' });
    expect(errorNotices(h)).toHaveLength(1);
  });
});
