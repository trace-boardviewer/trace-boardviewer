import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { bundledOcrEngine } from '../lib/ocr/bundled';
import { createPdfSession } from '../lib/pdf/session';
import type { WorkspaceApi } from './api';
import { createWorkspaceController } from './controller';
import type { ControllerDeps, KeyValueStorage, WorkerFactory, WorkspaceController } from './controller';

/** Wires a started worker to the controller's callbacks (the controller never touches `Worker` itself). */
const attach = (worker: Worker, onMessage: (data: unknown) => void, onError: () => void) => {
  worker.onmessage = event => onMessage(event.data);
  worker.onerror = () => onError();
  return {
    post: (message: unknown, transfer?: Transferable[]) => worker.postMessage(message, transfer ?? []),
    terminate: () => { worker.onmessage = null; worker.onerror = null; worker.terminate(); },
  };
};
// The `new Worker(new URL('<literal>', import.meta.url), ...)` form must stay literal: it is what Vite recognizes to bundle a worker.
const boardWorker: WorkerFactory = (onMessage, onError) => attach(new Worker(new URL('../lib/board-worker.ts', import.meta.url), { type: 'module' }), onMessage, onError);
const schematicWorker: WorkerFactory = (onMessage, onError) => attach(new Worker(new URL('../lib/schematic/schematic-worker.ts', import.meta.url), { type: 'module' }), onMessage, onError);

function browserStorage(): KeyValueStorage | null {
  try { return window.localStorage; } catch { return null; }
}

/** Browser fallback chooser: a transient file input, opened from the user's click. Resolves [] when dismissed. */
function pickFiles({ multiple }: { multiple: boolean }): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}

export function browserDeps(): ControllerDeps {
  return {
    desktop: window.traceDesktop,
    createBoardWorker: boardWorker,
    createSchematicWorker: schematicWorker,
    // Text recognition for pages without a text layer: the bundled engine, run in its own worker, offered on request only.
    createPdfSession: options => createPdfSession({ ...options, ocr: { engine: bundledOcrEngine } }),
    storage: browserStorage(),
    pickFiles,
  };
}

/** The close/quit hook of the desktop bridge (electron/preload.cjs onFlushRequest); an older preload or the browser build lacks it. */
interface FlushRequestSource { onFlushRequest?(listener: () => Promise<void> | void): () => void }

/**
 * W-fin-lifecycle-02 / W-fin-documents-01: before it destroys the window or shuts the store down, the main process asks
 * the renderer to write what it still holds (`pagehide` is too late for a direct `app.quit()`, and a destroyed renderer
 * cannot retry a failed write) and waits - bounded - for the answer. The request first behaves like `pagehide`, so views
 * that debounce a camera report it now, then writes the pending workspace snapshot; a write that failed gets one more
 * attempt (a lock that blocked it is often gone by then). Returns the function that detaches the listener.
 */
export function attachFlushRequest(
  desktop: unknown,
  controller: { flush(): Promise<void>; getSnapshot(): { save: { dirty: boolean } } },
  pageHide?: Pick<EventTarget, 'dispatchEvent'>,
): () => void {
  const source = desktop as FlushRequestSource | null | undefined;
  if (typeof source?.onFlushRequest !== 'function') return () => {};
  return source.onFlushRequest(async () => {
    pageHide?.dispatchEvent(new Event('pagehide'));
    await controller.flush();
    if (controller.getSnapshot().save.dirty) await controller.flush();
  });
}

/**
 * The application core as one hook: `state` is immutable and referentially stable until something changes, `actions`,
 * `sheetsOf` and `statusStore` never change identity. Startup (recents, initial board, external opens) runs once the component
 * mounts; the workspace is written on `pagehide` as well as after every change, and whenever the main process asks for
 * a flush before the window closes or the application quits (see attachFlushRequest).
 */
export function useWorkspace(): WorkspaceApi {
  const [controller] = useState<WorkspaceController>(() => createWorkspaceController(browserDeps()));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    const detach = attachFlushRequest(window.traceDesktop, controller, window);
    const stop = controller.start();
    const flush = () => { void controller.flush(); };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); detach(); stop(); };
  }, [controller]);
  return useMemo(() => ({ state, actions: controller.actions, sheetsOf: controller.sheetsOf, statusStore: controller.statusStore }), [state, controller]);
}
