import { describe, expect, it } from 'vitest';
import { boardPayload, deferred, dividerBoard, flushMicrotasks, openNative, createHarness } from './testing';

describe('content-free latest import context', () => {
  it('starts empty and records only the successful adapter and closed extension class', async () => {
    const h = createHarness();
    expect(h.state().import.reportContext).toBeNull();
    h.boardWorkers.reportContexts['tiny.cad'] = { stage: 'done', formatId: 'gencad' };
    await openNative(h, 'tiny.cad', 11, dividerBoard('tiny.cad'));
    expect(h.state().import.reportContext).toEqual({ outcome: 'opened', stage: 'done', formatId: 'gencad', extensionClass: '.cad', errorCode: null });
  });

  it('describes a failed newer attempt while the previous board stays visible, without parser text or paths', async () => {
    const h = createHarness();
    await openNative(h, 'known.cad', 12);
    h.desktop.boards.set('/private/OEM/private.boardview', boardPayload('private.boardview', 13, { path: '/private/OEM/private.boardview' }));
    h.boardWorkers.replies['private.boardview'] = { formatError: { message: 'C:\\private\\OEM board data', code: 'INVALID_FORMAT', format: 'Private parser label' } };
    await h.controller.actions.openRecent('/private/OEM/private.boardview');
    await h.controller.idle();
    expect(h.state().board?.name).toBe('known.cad');
    expect(h.state().import.reportContext).toEqual({ outcome: 'failed', stage: 'detect', formatId: null, extensionClass: '.boardview', errorCode: 'INVALID_FORMAT' });
    expect(JSON.stringify(h.state().import.reportContext)).not.toMatch(/private|OEM|board data|parser label/i);
  });

  it('maps native read failures to the read stage without retaining the requested path', async () => {
    const h = createHarness();
    h.desktop.failures.readBoard = () => new Error('C:\\private\\secret board.cad');
    await h.controller.actions.openRecent('C:\\private\\secret board.cad');
    await h.controller.idle();
    expect(h.state().import.reportContext).toEqual({ outcome: 'failed', stage: 'read', formatId: null, extensionClass: '.cad', errorCode: 'READ_FAILED' });
    expect(JSON.stringify(h.state().import.reportContext)).not.toContain('private');
  });

  it('keeps the previous board and records a rejected native chooser read with an unknown extension', async () => {
    const h = createHarness();
    await openNative(h, 'visible.cad', 21);
    h.desktop.failures.openBoard = () => new Error('C:\\private\\chosen file could not be read');
    await h.controller.actions.openBoard();
    expect(h.state().board?.name).toBe('visible.cad');
    expect(h.state().import.reportContext).toEqual({ outcome: 'failed', stage: 'read', formatId: null, extensionClass: 'none', errorCode: 'READ_FAILED' });
  });

  it('records startup initial-read and most recent fallback-read failures without replacing the visible board', async () => {
    const initialFailure = createHarness();
    await openNative(initialFailure, 'visible.cad', 22);
    initialFailure.desktop.failures.initialBoard = () => new Error('startup read failed at C:\\private\\secret.cad');
    const stop = initialFailure.controller.start();
    await initialFailure.controller.idle();
    expect(initialFailure.state().board?.name).toBe('visible.cad');
    expect(initialFailure.state().import.reportContext).toEqual({ outcome: 'failed', stage: 'read', formatId: null, extensionClass: 'none', errorCode: 'READ_FAILED' });
    stop();

    const fallback = createHarness();
    await openNative(fallback, 'visible.cad', 23);
    fallback.desktop.initial = { ...boardPayload('broken.fz', 24), startupSource: 'recent' };
    fallback.desktop.recents = [{ name: 'latest.fz', path: 'C:\\private\\latest.fz', openedAt: '2026-01-01T00:00:00.000Z' }];
    fallback.boardWorkers.replies['broken.fz'] = { formatError: { message: 'bad synthetic data', code: 'INVALID_FORMAT', format: 'private parser label' } };
    fallback.desktop.failures.readBoard = () => new Error('C:\\private\\latest.fz missing');
    const stopFallback = fallback.controller.start();
    await fallback.controller.idle();
    expect(fallback.state().board?.name).toBe('visible.cad');
    expect(fallback.state().import.reportContext).toEqual({ outcome: 'failed', stage: 'read', formatId: null, extensionClass: '.fz', errorCode: 'READ_FAILED' });
    stopFallback();
    expect(JSON.stringify(fallback.state().import.reportContext)).not.toContain('private');
  });

  it('records dropped-file read and unavailable-path failures using only the safe extension', async () => {
    const h = createHarness();
    await openNative(h, 'visible.cad', 25);
    h.desktop.failures.readBoard = () => new Error('C:\\private\\gone.fz');
    await h.controller.actions.openDropped([{ name: 'gone.fz', path: 'C:\\private\\gone.fz' } as File]);
    expect(h.state().board?.name).toBe('visible.cad');
    expect(h.state().import.reportContext).toEqual({ outcome: 'failed', stage: 'read', formatId: null, extensionClass: '.fz', errorCode: 'READ_FAILED' });
    h.desktop.failures.readBoard = undefined;
    await h.controller.actions.openDropped([{ name: 'missing.cad' } as File]);
    expect(h.state().import.reportContext).toEqual({ outcome: 'failed', stage: 'read', formatId: null, extensionClass: '.cad', errorCode: 'READ_FAILED' });
  });

  it('does not let a superseded read failure replace the newer successful attempt', async () => {
    const h = createHarness();
    const gate = deferred();
    h.desktop.boards.set('/boards/old.cad', boardPayload('old.cad', 26, { path: '/boards/old.cad' }));
    h.desktop.holds.readBoard = path => path === '/boards/old.cad' ? gate.promise : undefined;
    h.desktop.failures.readBoard = path => path === '/boards/old.cad' ? new Error('C:\\private\\old.cad') : undefined;
    const stale = h.controller.actions.openRecent('/boards/old.cad');
    await flushMicrotasks();
    h.desktop.boards.set('/boards/new.cad', boardPayload('new.cad', 27, { path: '/boards/new.cad' }));
    h.boardWorkers.replies['new.cad'] = dividerBoard('new.cad');
    await h.controller.actions.openRecent('/boards/new.cad');
    gate.resolve(undefined);
    await stale;
    expect(h.state().import.reportContext).toEqual({ outcome: 'opened', stage: 'done', formatId: null, extensionClass: '.cad', errorCode: null });
    expect(h.state().board?.name).toBe('new.cad');
  });

  it('keeps cancellation as the latest attempt and ignores the late worker result', async () => {
    const h = createHarness();
    const gate = deferred();
    h.desktop.boards.set('/boards/slow.cad', { name: 'slow.cad', path: '/boards/slow.cad', data: new TextEncoder().encode('slow'), key: '0'.repeat(64) });
    h.boardWorkers.replies['slow.cad'] = dividerBoard('slow.cad');
    h.boardWorkers.gates['slow.cad'] = gate.promise;
    const opening = h.controller.actions.openRecent('/boards/slow.cad');
    await flushMicrotasks();
    h.controller.actions.cancelImport();
    expect(h.state().import.reportContext).toMatchObject({ outcome: 'cancelled', stage: 'detect', formatId: null, errorCode: 'CANCELLED' });
    gate.resolve(undefined);
    await opening;
    await h.controller.idle();
    expect(h.state().import.reportContext).toMatchObject({ outcome: 'cancelled', formatId: null });
    expect(h.state().board).toBeNull();
  });

  it('maps the parse watchdog stop to timeout without retaining the input name', async () => {
    const callbacks = new Map<object, () => void>();
    const timers = {
      setTimeout: (run: () => void) => { const handle = {}; callbacks.set(handle, run); return handle; },
      clearTimeout: (handle: unknown) => { callbacks.delete(handle as object); },
    };
    const h = createHarness({ timers, parseWatchdog: { stallMs: 10, stopMs: 20 } });
    const gate = deferred();
    h.desktop.boards.set('/boards/slow.cad', { name: 'slow.cad', path: '/boards/slow.cad', data: new TextEncoder().encode('synthetic'), key: '2'.repeat(64) });
    h.boardWorkers.progress['slow.cad'] = [{ reportContext: { stage: 'unpack' } }, gate.promise];
    const opening = h.controller.actions.openRecent('/boards/slow.cad');
    await flushMicrotasks();
    const stop = [...callbacks.values()][1];
    expect(stop).toBeDefined();
    stop();
    await opening;
    expect(h.state().import.reportContext).toMatchObject({ outcome: 'timeout', stage: 'unpack', formatId: null, extensionClass: '.cad', errorCode: 'TIMEOUT' });
    expect(JSON.stringify(h.state().import.reportContext)).not.toContain('slow.cad');
    gate.resolve(undefined);
  });

  it('uses key-required and worker-failed outcomes without copying worker diagnostics', async () => {
    const h = createHarness();
    h.desktop.boards.set('/boards/locked.fz', boardPayload('locked.fz', 14, { path: '/boards/locked.fz' }));
    h.boardWorkers.replies['locked.fz'] = { formatError: { message: 'confidential input text', code: 'KEY_REQUIRED', keyKind: 'fz', format: 'private label' } };
    await h.controller.actions.openRecent('/boards/locked.fz');
    await h.controller.idle();
    expect(h.state().import.reportContext).toMatchObject({ outcome: 'key-required', stage: 'detect', formatId: null, extensionClass: '.fz', errorCode: 'KEY_REQUIRED' });
    h.controller.actions.cancelKeyRequest();
    expect(h.state().import.reportContext).toMatchObject({ outcome: 'cancelled', errorCode: 'CANCELLED' });

    const failed = createHarness();
    failed.desktop.boards.set('/boards/crash.cad', { name: 'crash.cad', path: '/boards/crash.cad', data: new TextEncoder().encode('synthetic'), key: '1'.repeat(64) });
    failed.boardWorkers.replies['crash.cad'] = dividerBoard('crash.cad');
    const crashGate = deferred();
    failed.boardWorkers.progress['crash.cad'] = [{ reportContext: { stage: 'unpack' } }, crashGate.promise];
    const opening = failed.controller.actions.openRecent('/boards/crash.cad');
    await flushMicrotasks();
    failed.boardWorkers.crash[0]();
    crashGate.resolve(undefined);
    await opening;
    await failed.controller.idle();
    expect(failed.state().import.reportContext).toMatchObject({ outcome: 'worker-failed', stage: 'unpack', extensionClass: '.cad', errorCode: 'WORKER_FAILED' });
  });
});
