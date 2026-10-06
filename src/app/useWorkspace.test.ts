import { describe, expect, it, vi } from 'vitest';
import { attachFlushRequest } from './useWorkspace';

// useWorkspace.ts wires the PDF session factory at import time only; the flush hook under test never touches it.
vi.mock('../lib/pdf/session', () => ({ createPdfSession: vi.fn() }));

/** A controller whose flush() succeeds from the `succeedAt`-th call on (never when 0) and that records the order of events. */
function fakeController(log: string[], succeedAt: number) {
  let calls = 0;
  let dirty = true;
  return {
    flush: vi.fn(async () => { calls += 1; log.push(`flush ${calls}`); await Promise.resolve(); if (succeedAt > 0 && calls >= succeedAt) dirty = false; }),
    getSnapshot: () => ({ save: { dirty, saving: false, failure: dirty ? 'The workspace could not be saved.' : null } }),
  };
}

/** A desktop bridge that only keeps the flush listener, like electron/preload.cjs onFlushRequest. */
function fakeBridge() {
  const listeners = new Set<() => Promise<void> | void>();
  return {
    listeners,
    onFlushRequest: vi.fn((listener: () => Promise<void> | void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    /** What the preload does on 'trace:flush-request': run every listener and wait for all of them. */
    request: () => Promise.all([...listeners].map(listener => listener())),
  };
}

describe('attachFlushRequest (W-fin-lifecycle-02 / W-fin-documents-01: flush before the window closes or the app quits)', () => {
  it('does nothing without a desktop bridge or with one that has no flush hook (browser build, older preload)', () => {
    const controller = fakeController([], 1);
    for (const desktop of [undefined, null, {}, { onFlushRequest: 'not a function' }, 42]) {
      const detach = attachFlushRequest(desktop, controller);
      expect(detach).toBeTypeOf('function');
      expect(() => detach()).not.toThrow();
    }
    expect(controller.flush).not.toHaveBeenCalled();
  });

  it('registers one listener and hands back the bridge\'s own detach function', async () => {
    const bridge = fakeBridge();
    const detach = attachFlushRequest(bridge, fakeController([], 1));
    expect(bridge.onFlushRequest).toHaveBeenCalledTimes(1);
    expect(bridge.listeners.size).toBe(1);
    detach();
    expect(bridge.listeners.size).toBe(0);
  });

  it('a request first behaves like pagehide (views report a debounced camera), then writes the pending snapshot, and answers only after that write', async () => {
    const log: string[] = [];
    const target = new EventTarget();
    target.addEventListener('pagehide', () => log.push('pagehide'));
    const bridge = fakeBridge();
    const controller = fakeController(log, 1);
    attachFlushRequest(bridge, controller, target);
    let answered = false;
    const answer = bridge.request().then(() => { answered = true; log.push('answered'); });
    expect(log).toEqual(['pagehide', 'flush 1']); // The pagehide listeners ran synchronously, before the flush started.
    expect(answered).toBe(false);
    await answer;
    expect(log).toEqual(['pagehide', 'flush 1', 'answered']);
    expect(controller.flush).toHaveBeenCalledTimes(1); // Clean after the first flush: no second attempt.
  });

  it('a write that failed gets exactly one more attempt (the lock that blocked it is often gone by then), never an endless loop', async () => {
    const log: string[] = [];
    const bridge = fakeBridge();
    const recovers = fakeController(log, 2);
    attachFlushRequest(bridge, recovers);
    await bridge.request();
    expect(log).toEqual(['flush 1', 'flush 2']);
    expect(recovers.getSnapshot().save.dirty).toBe(false);

    const stuckLog: string[] = [];
    const stuckBridge = fakeBridge();
    const stuck = fakeController(stuckLog, 0);
    attachFlushRequest(stuckBridge, stuck);
    await expect(stuckBridge.request()).resolves.toBeDefined();
    expect(stuckLog).toEqual(['flush 1', 'flush 2']);
    expect(stuck.getSnapshot().save.dirty).toBe(true);
  });

  it('works without a pagehide target (nothing is dispatched) and a later request after detach is not served', async () => {
    const log: string[] = [];
    const bridge = fakeBridge();
    const controller = fakeController(log, 1);
    const detach = attachFlushRequest(bridge, controller);
    await bridge.request();
    expect(log).toEqual(['flush 1']);
    detach();
    await bridge.request();
    expect(controller.flush).toHaveBeenCalledTimes(1);
  });
});
