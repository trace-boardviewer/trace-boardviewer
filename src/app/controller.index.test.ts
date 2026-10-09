import { describe, expect, it, vi } from 'vitest';
import { boardIndexOf } from '../lib/board-index';
import { buildSchematicIndex, linkBoardSchematic, searchAll } from '../lib/crossprobe';
import { DEFAULT_PARSE_WATCHDOG } from './controller';
import type { ControllerTimers } from './controller';
import { createHarness, deferred, dividerBoard, dividerDesign, flushMicrotasks, hexKey, makeBoard, openNative, registerBoard, seedWorkspace } from './testing';
import type { Harness, SeedDocument } from './testing';

/** Timers that only fire when the test advances the clock. */
function manualTimers() {
  let now = 0, next = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: ControllerTimers = {
    setTimeout: (run, ms) => { const id = ++next; pending.set(id, { at: now + ms, run }); return id; },
    clearTimeout: handle => { pending.delete(handle as number); },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now && pending.delete(id)) timer.run();
  };
  return { timers, advance, count: () => pending.size };
}
const WATCHDOG = { stallMs: 1_000, stopMs: 5_000 };
const bigBoard = (name: string) => makeBoard(name, [{ ref: 'B1', id: 'b1', pins: [['1', 'N1']] }, { ref: 'B2', id: 'b2', pins: [['1', 'N1']] }]);

describe('import progress, watchdog and cancel', () => {
  it('shows the parser’s progress, says when it stalls, and clears both when the board is committed', async () => {
    const clock = manualTimers();
    const h = createHarness({ timers: clock.timers, parseWatchdog: WATCHDOG });
    registerBoard(h, 'big.cad', 2, bigBoard('big.cad'));
    const hold = deferred(), finish = deferred();
    h.boardWorkers.progress['big.cad'] = [{ progress: { fraction: 0.25 } }, hold.promise, { progress: { fraction: 7 } }, finish.promise];
    const opening = h.controller.actions.openRecent('/boards/big.cad');
    await vi.waitFor(() => expect(h.state().import).toMatchObject({ phase: 'processing', progress: { fraction: 0.25, stalled: false } }));
    clock.advance(WATCHDOG.stallMs - 1);
    expect(h.state().import.progress).toEqual({ fraction: 0.25, stalled: false });
    clock.advance(1);
    expect(h.state().import.progress).toEqual({ fraction: 0.25, stalled: true });
    hold.resolve();
    // A new report is a sign of life: not stalled any more (and an out-of-range fraction is clamped).
    await vi.waitFor(() => expect(h.state().import.progress).toEqual({ fraction: 1, stalled: false }));
    clock.advance(WATCHDOG.stopMs - 1); // the stop clock restarted with the report
    expect(h.state().import.phase).toBe('processing');
    finish.resolve();
    await opening;
    await h.controller.idle();
    expect(h.state().board?.name).toBe('big.cad');
    expect(h.state().import).toMatchObject({ phase: 'idle', progress: null });
    expect(clock.count()).toBe(0);
    expect(h.messages()).toEqual(['toast.loaded']);
  });

  it('stops a parse that reports nothing for the stop budget: worker ended, previous board kept, clear notice', async () => {
    const clock = manualTimers();
    const h = createHarness({ timers: clock.timers, parseWatchdog: WATCHDOG });
    await openNative(h, 'a.cad', 1);
    const before = h.state().board;
    registerBoard(h, 'stuck.cad', 2);
    h.boardWorkers.progress['stuck.cad'] = [new Promise(() => {})];
    const opening = h.controller.actions.openRecent('/boards/stuck.cad');
    await vi.waitFor(() => expect(h.state().import.phase).toBe('processing'));
    clock.advance(WATCHDOG.stallMs);
    expect(h.state().import.progress?.stalled).toBe(true);
    clock.advance(WATCHDOG.stopMs - WATCHDOG.stallMs);
    await opening;
    expect(h.state().import).toMatchObject({ phase: 'idle', progress: null });
    expect(h.state().board).toBe(before);
    expect(h.state().boardKey).toBe(hexKey(1));
    expect(h.boardWorkers.terminated).toBe(h.boardWorkers.created);
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error', message: { key: 'toast.importStopped', params: { seconds: 5 } } });
    expect(clock.count()).toBe(0);
  });

  it('defaults: 30 s to the stalled state, two minutes without progress to the stop', () => {
    expect(DEFAULT_PARSE_WATCHDOG).toEqual({ stallMs: 30_000, stopMs: 120_000 });
    expect(Object.isFrozen(DEFAULT_PARSE_WATCHDOG)).toBe(true);
  });

  it('Cancel ends the running parse at once: the worker is terminated, the previous board stays, a late reply is dropped', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    const before = h.state().board;
    registerBoard(h, 'slow.cad', 2);
    const gate = deferred();
    h.boardWorkers.gates['slow.cad'] = gate.promise;
    const opening = h.controller.actions.openRecent('/boards/slow.cad');
    await vi.waitFor(() => expect(h.state().import.phase).toBe('processing'));
    h.controller.actions.cancelImport();
    expect(h.state().import).toMatchObject({ phase: 'idle', progress: null });
    expect(h.boardWorkers.terminated).toBe(h.boardWorkers.created);
    gate.resolve();
    await opening;
    await h.controller.idle();
    expect(h.state().board).toBe(before);
    expect(h.messages()).toEqual(['toast.loaded', 'toast.importCancelled']);
    // Nothing is running: a second Cancel does nothing.
    h.controller.actions.cancelImport();
    expect(h.messages()).toEqual(['toast.loaded', 'toast.importCancelled']);
  });

  it('Cancel while the file is still being read drops the read result', async () => {
    const h = createHarness();
    const payload = registerBoard(h, 'a.cad', 1);
    const read = deferred<typeof payload>();
    const readBoard = h.desktop.readBoard.bind(h.desktop);
    h.desktop.readBoard = async path => (path === payload.path ? read.promise : readBoard(path));
    const opening = h.controller.actions.openRecent(payload.path);
    expect(h.state().import.phase).toBe('reading');
    h.controller.actions.cancelImport();
    expect(h.state().import.phase).toBe('idle');
    read.resolve(payload);
    await opening;
    await h.controller.idle();
    expect(h.state().board).toBeNull();
    expect(h.boardWorkers.created).toBe(0);
    expect(h.messages()).toEqual(['toast.importCancelled']);
  });

  it('progress of an import that a newer one replaced is ignored', async () => {
    const h = createHarness();
    registerBoard(h, 'old.cad', 1);
    registerBoard(h, 'new.cad', 2);
    const hold = deferred();
    h.boardWorkers.progress['old.cad'] = [hold.promise, { progress: { fraction: 0.9 } }];
    const newGate = deferred();
    h.boardWorkers.gates['new.cad'] = newGate.promise;
    void h.controller.actions.openRecent('/boards/old.cad');
    await vi.waitFor(() => expect(h.boardWorkers.created).toBe(1));
    const second = h.controller.actions.openRecent('/boards/new.cad');
    await vi.waitFor(() => expect(h.boardWorkers.created).toBe(2));
    hold.resolve();
    await flushMicrotasks();
    expect(h.state().import.progress).toEqual({ fraction: null, stalled: false });
    newGate.resolve();
    await second;
    await h.controller.idle();
    expect(h.state().board?.name).toBe('new.cad');
  });
});

describe('the shared board index in the workspace state', () => {
  it('publishes one index per board (the shared one) and drops it with the board', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    const { board, boardIndex } = h.state();
    expect(boardIndex).not.toBeNull();
    expect(boardIndex).toBe(boardIndexOf(board!));
    expect(boardIndex!.board).toBe(board);
    // Selection reads the same index: an unknown net is refused, a known one selected.
    h.controller.actions.selectNet('NOPE');
    expect(h.state().selection.net).toBeNull();
    h.controller.actions.selectNet('OUT');
    expect(h.state().selection.net).toBe('OUT');
    await openNative(h, 'b.cad', 2);
    expect(h.state().boardIndex).toBe(boardIndexOf(h.state().board!));
    expect(h.state().boardIndex).not.toBe(boardIndex);
    h.controller.actions.closeBoard();
    expect(h.state().boardIndex).toBeNull();
  });
});

describe('model worker: search and link reports off the UI thread', () => {
  const SCH: SeedDocument = { id: 'doc-sch', path: '/boards/docs/divider.kicad_sch', kind: 'schematic', key: 41 };
  async function modelHarness(board = dividerBoard('a.cad')): Promise<Harness> {
    const h = createHarness();
    h.boardWorkers.model = true;
    await openNative(h, 'a.cad', 1, board);
    return h;
  }

  it('keeps the parse worker as the board’s model worker and searches there, with the same rows as the UI thread', async () => {
    const h = await modelHarness();
    expect(h.boardWorkers.created).toBe(1);
    expect(h.boardWorkers.terminated).toBe(0);
    h.controller.actions.setSearchQuery('R');
    expect(h.state().search).toMatchObject({ query: 'R', pending: true });
    await h.controller.idle();
    expect(h.boardWorkers.modelRequests).toMatchObject([{ type: 'search', query: 'R' }]);
    const expected = searchAll({ query: 'R', board: boardIndexOf(h.state().board!) });
    expect(h.state().search).toMatchObject({ query: 'R', pending: false });
    expect(h.state().search.result).toEqual(expected);
  });

  it('only the newest query’s answer is applied; the older request is cancelled', async () => {
    const h = await modelHarness();
    let release!: () => void;
    h.boardWorkers.modelGate = new Promise<void>(resolve => { release = resolve; });
    h.controller.actions.setSearchQuery('R1');
    await flushMicrotasks();
    h.controller.actions.setSearchQuery('U1');
    release();
    await h.controller.idle();
    expect(h.boardWorkers.modelRequests.map(r => r.type)).toEqual(['search', 'cancel', 'search']);
    expect(h.state().search.query).toBe('U1');
    expect(h.state().search.result?.groups[0].rows.map(row => (row as { ref: string }).ref)).toEqual(['U1']);
  });

  it('drops previous-query rows while the model worker is delayed and retains current-query partials', async () => {
    const h = createHarness();
    h.boardWorkers.model = true;
    seedWorkspace(h, 1, '/boards/a.cad', [SCH]);
    h.schematicWorkers.designs['divider.kicad_sch'] = dividerDesign();
    await openNative(h, 'a.cad', 1, dividerBoard('a.cad'));
    await h.controller.idle();

    h.controller.actions.setSearchQuery('R1');
    await h.controller.idle();
    expect(h.state().search.result?.groups[0].rows.map(row => (row as { ref: string }).ref)).toEqual(['R1']);

    const response = deferred();
    h.boardWorkers.modelGate = response.promise;
    h.controller.actions.setSearchQuery('R2');
    expect(h.state().search).toMatchObject({ query: 'R2', pending: true, result: { query: 'R2' } });
    expect(h.state().search.result?.groups[0].rows).toEqual([]);
    expect(h.state().search.result?.groups[2].rows.map(row => (row as { ref: string }).ref)).toContain('R2');

    response.resolve();
    await h.controller.idle();
    expect(h.state().search).toMatchObject({ query: 'R2', pending: false, result: { query: 'R2' } });
    expect(h.state().search.result?.groups[0].rows.map(row => (row as { ref: string }).ref)).toEqual(['R2']);
  });

  it('falls back to the shared index on this thread when the model worker crashes', async () => {
    const h = await modelHarness();
    h.boardWorkers.crash[0]();
    expect(h.boardWorkers.terminated).toBe(1);
    h.controller.actions.setSearchQuery('R2');
    expect(h.state().search.pending).toBe(false);
    expect(h.state().search.result?.groups[0].rows.map(row => (row as { ref: string }).ref)).toEqual(['R2']);
    expect(h.boardWorkers.modelRequests).toEqual([]);
  });

  it('a search the worker could not answer is computed here instead', async () => {
    const h = await modelHarness();
    let release!: () => void;
    h.boardWorkers.modelGate = new Promise<void>(resolve => { release = resolve; });
    h.controller.actions.setSearchQuery('R2');
    await flushMicrotasks();
    h.boardWorkers.crash[0]();
    release();
    await h.controller.idle();
    expect(h.state().search).toMatchObject({ query: 'R2', pending: false });
    expect(h.state().search.result?.groups[0].rows.map(row => (row as { ref: string }).ref)).toEqual(['R2']);
  });

  it('computes the link report in the worker, equal to the UI-thread report, and sends the design once', async () => {
    const h = createHarness();
    h.boardWorkers.model = true;
    seedWorkspace(h, 1, '/boards/a.cad', [SCH]);
    h.schematicWorkers.designs['divider.kicad_sch'] = dividerDesign();
    await openNative(h, 'a.cad', 1, dividerBoard('a.cad'));
    await h.controller.idle();
    const link = h.state().link;
    expect(link).not.toBeNull();
    const design = h.state().documents.find(d => d.record.id === 'doc-sch')!.design!;
    expect(link).toEqual(linkBoardSchematic(boardIndexOf(h.state().board!), buildSchematicIndex([{ documentId: 'doc-sch', design }]), h.state().manifest?.aliases));
    const links = h.boardWorkers.modelRequests.filter(r => r.type === 'link') as Array<{ schematics: Array<{ design?: unknown }> }>;
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].schematics[0].design).toBeDefined();
    for (const later of links.slice(1)) expect(later.schematics[0].design).toBeUndefined();
  });

  it('a board switch ends the previous board’s model worker; a failed import never leaves one running', async () => {
    const h = await modelHarness();
    await openNative(h, 'b.cad', 2);
    expect(h.boardWorkers.created).toBe(2);
    expect(h.boardWorkers.terminated).toBe(1);
    // A board parsed while a newer import already started is dropped together with its worker.
    registerBoard(h, 'late.cad', 3);
    registerBoard(h, 'next.cad', 4);
    const gate = deferred();
    h.boardWorkers.gates['late.cad'] = gate.promise;
    const late = h.controller.actions.openRecent('/boards/late.cad');
    await vi.waitFor(() => expect(h.boardWorkers.created).toBe(3));
    await h.controller.actions.openRecent('/boards/next.cad');
    gate.resolve();
    await late;
    await h.controller.idle();
    expect(h.state().board?.name).toBe('next.cad');
    expect(h.boardWorkers.terminated).toBe(h.boardWorkers.created - 1);
    h.controller.actions.closeBoard();
    expect(h.boardWorkers.terminated).toBe(h.boardWorkers.created);
  });
});
