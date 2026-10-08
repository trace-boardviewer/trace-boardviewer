import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { ALL_BUILDERS, NAMES, asc, kicad, type BuiltFile } from '../lib/diagnostics/canary-kit';
import { findLeaks } from '../lib/diagnostics/canary-check';
import { collectDiagnostic } from '../lib/diagnostics/collect';
import type { DiagnosticReport } from '../lib/diagnostics/report';
import type { DiagnosticFilePayload } from '../lib/types';
import { createDiagnosticSession, diagnosticSupported } from './diagnostic-session';
import type { DiagnosticDeps, DiagnosticSession } from './diagnostic-session';
import type { WorkerFactory } from './controller';

const nativeRequire = createRequire(import.meta.url);
const diagnostics = nativeRequire('../../electron/diagnostics.cjs') as { validateReport(value: unknown, options?: { reviewed?: boolean }): DiagnosticReport; serializeReport(report: DiagnosticReport): string };

const CODE = '0123456789abcdef';
const payloadOf = (file: BuiltFile, over: Partial<DiagnosticFilePayload> = {}): DiagnosticFilePayload => ({
  name: file.name.includes('.') ? `diagnostic${file.name.slice(file.name.lastIndexOf('.'))}` : file.name, data: file.data, ...(file.companions ? { companions: file.companions } : {}), os: 'linux', dedupe: CODE, ...over,
});

/** A worker that runs the real collector on the message it gets, like diagnostic-worker.ts does, and answers on a later turn. */
function collectorWorker(options: { silent?: boolean; crash?: boolean; fail?: boolean; steps?: number[] } = {}) {
  const log: { posts: Array<Record<string, unknown>>; terminated: number; transfers: Transferable[][] } = { posts: [], terminated: 0, transfers: [] };
  const factory: WorkerFactory = (onMessage, onError) => ({
    post(message, transfer) {
      const request = message as { name: string; data: Uint8Array; companions?: Record<string, Uint8Array>; os: 'linux'; dedupe: string | null };
      log.posts.push(request);
      log.transfers.push(transfer ?? []);
      if (options.crash) { queueMicrotask(onError); return; }
      if (options.silent) { for (const fraction of options.steps ?? []) queueMicrotask(() => onMessage({ progress: { fraction } })); return; }
      if (options.fail) { queueMicrotask(() => onMessage({ error: 'FAILED' })); return; }
      void collectDiagnostic({ name: request.name, data: request.data, ...(request.companions ? { companions: request.companions } : {}) }, { os: request.os, dedupe: request.dedupe, appVersion: '1.3.0' })
        .then(report => { onMessage({ progress: { fraction: 0.5 } }); onMessage({ report }); });
    },
    terminate() { log.terminated++; },
  });
  return { factory, log };
}

interface Bridge { picks: number; saved: DiagnosticReport[]; pick: () => Promise<DiagnosticFilePayload | null>; save: (report: DiagnosticReport) => Promise<{ bytes: number } | null> }
function bridge(initial: Partial<Bridge> = {}): Bridge {
  const state: Bridge = {
    picks: 0, saved: [], pick: async () => null, save: async () => ({ bytes: 1 }), ...initial,
  };
  return state;
}
function sessionFor(state: Bridge, worker = collectorWorker(), extra: Partial<DiagnosticDeps> = {}): { session: DiagnosticSession; worker: ReturnType<typeof collectorWorker> } {
  const session = createDiagnosticSession({
    desktop: {
      pickDiagnosticFile: async () => { state.picks++; return state.pick(); },
      saveDiagnosticReport: async report => { state.saved.push(report); return state.save(report); },
    },
    createWorker: worker.factory, ...extra,
  });
  return { session, worker };
}
const settle = async (session: DiagnosticSession, phase: string) => { for (let turn = 0; turn < 500 && session.getSnapshot().phase !== phase; turn++) await new Promise(resolve => setTimeout(resolve, 2)); expect(session.getSnapshot().phase).toBe(phase); };
const manualTimers = () => {
  const tasks: Array<{ at: number; run: () => void; id: number }> = [];
  let now = 0, next = 1;
  return {
    timers: {
      setTimeout: (run: () => void, ms: number) => { const id = next++; tasks.push({ at: now + ms, run, id }); return id; },
      clearTimeout: (handle: unknown) => { const at = tasks.findIndex(task => task.id === handle); if (at >= 0) tasks.splice(at, 1); },
    },
    advance(ms: number) { now += ms; for (const task of tasks.filter(item => item.at <= now).sort((a, b) => a.at - b.at)) { const at = tasks.indexOf(task); if (at >= 0) { tasks.splice(at, 1); task.run(); } } },
    pending: () => tasks.length,
  };
};

describe('the dialog flow', () => {
  it('picks a file, analyses it in one worker and reaches the review with the report at level 1', async () => {
    const file = kicad();
    const state = bridge({ pick: async () => payloadOf(file) });
    const { session, worker } = sessionFor(state);
    expect(session.getSnapshot().phase).toBe('idle');
    const start = session.start();
    expect(session.getSnapshot().phase).toBe('picking');
    await start;
    await settle(session, 'review');
    const view = session.getSnapshot();
    expect(view).toMatchObject({ level: 1, dedupe: false, hasDedupe: true, failure: null, facts: { outcome: 'opened', hook: 'kicad' } });
    const report = JSON.parse(view.text) as DiagnosticReport;
    expect(report.privacy).toMatchObject({ level: 1, reviewedByUser: true, dedupe: false });
    expect(report.dedupe).toBeNull();
    expect(worker.log.posts).toHaveLength(1);
    expect(worker.log.terminated).toBe(1);
    expect(state.saved).toHaveLength(0);
  });

  it('hands the worker the neutral name, the bytes (transferred) and the dedupe code, and nothing of the file stays in the state', async () => {
    const file = asc();
    const state = bridge({ pick: async () => payloadOf(file, { name: 'format.asc' }) });
    const { session, worker } = sessionFor(state);
    await session.start();
    await settle(session, 'review');
    const [post] = worker.log.posts as Array<{ name: string; data: Uint8Array; companions: Record<string, Uint8Array>; os: string; dedupe: string | null }>;
    expect(post).toMatchObject({ name: 'format.asc', os: 'linux', dedupe: CODE });
    expect(Object.keys(post.companions).sort()).toEqual(['nails.asc', 'pins.asc']);
    expect(worker.log.transfers[0]).toHaveLength(3);
    const snapshot = JSON.stringify(session.getSnapshot());
    expect(snapshot).not.toContain(NAMES.refs[0]);
    expect(findLeaks(snapshot, { strings: [...NAMES.refs, ...NAMES.nets] })).toEqual([]);
  });

  it('level 2 and the dedupe code change the shown text and the saved report together; the text is exactly what is saved', async () => {
    const state = bridge({ pick: async () => payloadOf(ALL_BUILDERS[0]()) });
    const { session } = sessionFor(state);
    await session.start();
    await settle(session, 'review');
    const level1 = session.getSnapshot().text;
    session.setLevel(2);
    const level2 = session.getSnapshot().text;
    expect(level2.length).toBeGreaterThan(level1.length);
    expect(JSON.parse(level2).privacy).toMatchObject({ level: 2, dedupe: false });
    session.setDedupe(true);
    expect(JSON.parse(session.getSnapshot().text)).toMatchObject({ dedupe: CODE, privacy: { dedupe: true, level: 2 } });
    await session.save();
    expect(state.saved).toHaveLength(1);
    // What the user read is what the main process writes: its canonical text equals the displayed text.
    expect(diagnostics.serializeReport(diagnostics.validateReport(state.saved[0], { reviewed: true }))).toBe(session.getSnapshot().text);
    session.setLevel(1);
    session.setDedupe(false);
    expect(session.getSnapshot().text).toBe(level1);
  });

  it('shows the repeat-detection switch only when the main process supplied a code', async () => {
    const state = bridge({ pick: async () => payloadOf(kicad(), { dedupe: '' }) });
    const { session } = sessionFor(state);
    await session.start();
    await settle(session, 'review');
    expect(session.getSnapshot().hasDedupe).toBe(false);
    session.setDedupe(true);
    expect(session.getSnapshot().dedupe).toBe(false);
    expect(JSON.parse(session.getSnapshot().text).dedupe).toBeNull();
  });

  it('saves through the main process only on the Save click, with reviewedByUser set, and stays in the review when the dialog is cancelled', async () => {
    const state = bridge({ pick: async () => payloadOf(kicad()), save: async () => null });
    const { session } = sessionFor(state);
    await session.start();
    await settle(session, 'review');
    expect(state.saved).toHaveLength(0);
    const saving = session.save();
    expect(session.getSnapshot().phase).toBe('saving');
    await saving;
    expect(session.getSnapshot()).toMatchObject({ phase: 'review', failure: null });
    expect(state.saved[0].privacy.reviewedByUser).toBe(true);
    state.save = async () => ({ bytes: 5000 });
    await session.save();
    expect(session.getSnapshot().phase).toBe('saved');
    session.setLevel(2);
    expect(session.getSnapshot().phase).toBe('review'); // a changed choice is not saved yet
  });

  it('keeps the review and shows the main process text when saving fails', async () => {
    const state = bridge({ pick: async () => payloadOf(kicad()), save: async () => { throw Object.assign(new Error('[DIAGNOSTIC_WRITE_FAILED] The report could not be written to the chosen location.'), { code: 'DIAGNOSTIC_WRITE_FAILED' }); } });
    const { session } = sessionFor(state);
    await session.start();
    await settle(session, 'review');
    await session.save();
    expect(session.getSnapshot()).toMatchObject({ phase: 'review', failure: 'save', detail: 'The report could not be written to the chosen location.' });
  });

  it('never touches the clipboard by itself; Copy text does it once, on request', async () => {
    const copyText = vi.fn(async () => {});
    const state = bridge({ pick: async () => payloadOf(kicad()) });
    const { session } = sessionFor(state, collectorWorker(), { copyText });
    await session.start();
    await settle(session, 'review');
    session.setLevel(2);
    await session.save();
    expect(copyText).not.toHaveBeenCalled();
    await session.copy();
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copyText).toHaveBeenCalledWith(session.getSnapshot().text);
    expect(session.getSnapshot().copied).toBe(true);
    session.setLevel(1);
    expect(session.getSnapshot().copied).toBe(false);
  });

  it('reports a clipboard that is not available instead of failing silently', async () => {
    const state = bridge({ pick: async () => payloadOf(kicad()) });
    const { session } = sessionFor(state, collectorWorker(), { copyText: async () => { throw new Error('denied'); } });
    await session.start();
    await settle(session, 'review');
    await session.copy();
    expect(session.getSnapshot()).toMatchObject({ copied: false, failure: 'copy' });
  });

  it('returns to the start when the file dialog is cancelled, and reports a read failure with the main process text', async () => {
    const state = bridge();
    const { session } = sessionFor(state);
    await session.start();
    expect(session.getSnapshot()).toMatchObject({ phase: 'idle', failure: null });
    state.pick = async () => { throw new Error('The file is too large.'); };
    await session.start();
    expect(session.getSnapshot()).toMatchObject({ phase: 'idle', failure: 'read', detail: 'The file is too large.' });
    state.pick = async () => payloadOf(kicad());
    await session.start();
    await settle(session, 'review');
    expect(session.getSnapshot().failure).toBeNull();
  });

  it('reports an analysis that failed or crashed, and an unrecognized file still produces a report', async () => {
    for (const worker of [collectorWorker({ fail: true }), collectorWorker({ crash: true })]) {
      const state = bridge({ pick: async () => payloadOf(kicad()) });
      const { session } = sessionFor(state, worker);
      await session.start();
      await settle(session, 'idle');
      expect(session.getSnapshot().failure).toBe('worker');
      expect(worker.log.terminated).toBeGreaterThan(0);
    }
    const unknown = { name: 'x.bin', data: Uint8Array.from({ length: 2000 }, (_, index) => (index * 97 + 5) & 255), label: 'noise', format: 'other', hook: 'generic-binary', integers: [] } as BuiltFile;
    const state = bridge({ pick: async () => payloadOf(unknown, { name: 'diagnostic.bin' }) });
    const { session } = sessionFor(state);
    await session.start();
    await settle(session, 'review');
    expect(session.getSnapshot().facts).toEqual({ outcome: 'unrecognized', hook: 'generic-binary' });
  });
});

describe('the parse watchdog', () => {
  it('marks a run without progress as stalled, ends it at the stop time and terminates the worker', async () => {
    const clock = manualTimers();
    const worker = collectorWorker({ silent: true });
    const state = bridge({ pick: async () => payloadOf(kicad()) });
    const { session } = sessionFor(state, worker, { timers: clock.timers, watchdog: { stallMs: 1000, stopMs: 5000 } });
    await session.start();
    expect(session.getSnapshot().phase).toBe('running');
    expect(session.getSnapshot().progress).toEqual({ fraction: null, stalled: false });
    clock.advance(999);
    expect(session.getSnapshot().progress?.stalled).toBe(false);
    clock.advance(1);
    expect(session.getSnapshot().progress?.stalled).toBe(true);
    clock.advance(4000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'idle', progress: null, failure: 'stopped', stopSeconds: 5 });
    expect(worker.log.terminated).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it('treats every progress report as a sign of life that restarts both clocks', async () => {
    const clock = manualTimers();
    const worker = collectorWorker({ silent: true, steps: [0.2] });
    const state = bridge({ pick: async () => payloadOf(kicad()) });
    const { session } = sessionFor(state, worker, { timers: clock.timers, watchdog: { stallMs: 1000, stopMs: 5000 } });
    await session.start();
    await Promise.resolve();
    expect(session.getSnapshot().progress).toEqual({ fraction: 0.2, stalled: false });
    clock.advance(4000);
    expect(session.getSnapshot().phase).toBe('running');
    expect(session.getSnapshot().progress?.stalled).toBe(true);
  });

  it('Cancel ends the run, terminates the worker, and a late answer of that worker is ignored', async () => {
    const clock = manualTimers();
    let reply: ((data: unknown) => void) | null = null;
    const log = { terminated: 0 };
    const factory: WorkerFactory = onMessage => { reply = onMessage; return { post() {}, terminate() { log.terminated++; } }; };
    const state = bridge({ pick: async () => payloadOf(kicad()) });
    const session = createDiagnosticSession({ desktop: { pickDiagnosticFile: async () => state.pick(), saveDiagnosticReport: async () => null }, createWorker: factory, timers: clock.timers });
    await session.start();
    expect(session.getSnapshot().phase).toBe('running');
    session.cancel();
    expect(session.getSnapshot()).toMatchObject({ phase: 'idle', progress: null });
    expect(log.terminated).toBe(1);
    expect(clock.pending()).toBe(0);
    reply!({ report: await collectDiagnostic({ name: 'a.kicad_pcb', data: kicad().data }, { os: 'linux' }) });
    expect(session.getSnapshot().phase).toBe('idle');
  });

  it('ignores a pick that finishes after the dialog was closed', async () => {
    let finish: (value: DiagnosticFilePayload | null) => void = () => {};
    const state = bridge({ pick: () => new Promise(resolve => { finish = resolve; }) });
    const { session, worker } = sessionFor(state);
    const starting = session.start();
    session.dispose();
    finish(payloadOf(kicad()));
    await starting;
    expect(worker.log.posts).toHaveLength(0);
  });
});

describe('support for the bridge', () => {
  it('needs both calls: a bridge without them (the browser build, an older preload) hides the feature and start() does nothing', async () => {
    expect(diagnosticSupported(undefined)).toBe(false);
    expect(diagnosticSupported({})).toBe(false);
    expect(diagnosticSupported({ pickDiagnosticFile: async () => null })).toBe(false);
    expect(diagnosticSupported({ pickDiagnosticFile: async () => null, saveDiagnosticReport: async () => null })).toBe(true);
    const session = createDiagnosticSession({ desktop: undefined, createWorker: collectorWorker().factory });
    await session.start();
    expect(session.getSnapshot().phase).toBe('idle');
  });

  it('does nothing while a step is already running', async () => {
    let finish: (value: DiagnosticFilePayload | null) => void = () => {};
    const state = bridge({ pick: () => new Promise(resolve => { finish = resolve; }) });
    const { session } = sessionFor(state);
    const first = session.start();
    void session.start();
    expect(state.picks).toBe(1);
    finish(null);
    await first;
  });
});
