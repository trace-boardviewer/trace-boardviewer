import { OCR_PAGE_SEGMENTATION, OcrError } from './contract';
import type { GrayImage, OcrEngine, OcrEngineFactory, OcrEngineOptions, OcrLanguage, OcrRecognizeOptions, OcrWord, QuarterTurn } from './contract';
import { parseWorkerReply } from './protocol';
import type { OcrWorkerReply, OcrWorkerRequest } from './protocol';

/**
 * Renderer side of the OCR worker: starts it, hands it the engine and language bytes, queues recognitions and enforces the time
 * budget. Cancelling (signal) and an expired budget both TERMINATE the worker - the WebAssembly engine cannot be interrupted - so
 * the engine is disposed and the caller creates a new one for the next page (recognizePdfPages does that).
 */

/** The parts of a Worker this module uses (a test double implements them in-process). */
export interface OcrWorkerPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  postMessage(message: OcrWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}
/** Bytes for one engine start (fresh buffers: they are transferred to the worker). */
export interface OcrEngineAssets { simd: boolean; wasm: ArrayBuffer; data: ArrayBuffer }
export interface WorkerEngineDeps {
  createWorker(): OcrWorkerPort;
  loadAssets(language: OcrLanguage, signal?: AbortSignal): Promise<OcrEngineAssets>;
  /** Bound for compiling the engine and loading the language data (default 60 s). */
  startTimeoutMs?: number;
}

export const ENGINE_START_TIMEOUT_MS = 60_000;
const DEFAULT_ROTATIONS: readonly QuarterTurn[] = [0, 1];

const aborted = () => new OcrError('ABORTED', 'Text recognition was cancelled.');

export function createWorkerOcrEngineFactory(deps: WorkerEngineDeps): OcrEngineFactory {
  return (options: OcrEngineOptions) => startWorkerEngine(deps, options);
}

async function startWorkerEngine(deps: WorkerEngineDeps, options: OcrEngineOptions): Promise<OcrEngine> {
  const { language, signal } = options;
  if (signal?.aborted) throw aborted();
  const assets = await deps.loadAssets(language, signal);
  if (signal?.aborted) throw aborted();
  let worker: OcrWorkerPort;
  try { worker = deps.createWorker(); } catch (error) { throw new OcrError('UNAVAILABLE', 'The text recognition worker could not be created.', { cause: error }); }

  let disposed = false, sequence = 0;
  const pending = new Map<number, { resolve(reply: OcrWorkerReply): void; reject(error: unknown): void }>();
  const dispose = (reason: OcrError = new OcrError('ABORTED', 'The text recognition engine was stopped.')) => {
    if (disposed) return;
    disposed = true;
    worker.onmessage = null; worker.onerror = null;
    try { worker.terminate(); } catch { /* already gone */ }
    for (const entry of pending.values()) entry.reject(reason);
    pending.clear();
  };
  worker.onmessage = event => {
    const reply = parseWorkerReply(event.data);
    if (!reply) { dispose(new OcrError('FAILED', 'The text recognition worker sent a malformed reply.')); return; }
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    if (reply.type === 'error') entry.reject(new OcrError(reply.code, reply.message));
    else entry.resolve(reply);
  };
  worker.onerror = () => dispose(new OcrError('UNAVAILABLE', 'The text recognition worker stopped unexpectedly.'));

  /** One request; the budget and the signal end it by terminating the worker. */
  function call(build: (id: number) => { message: OcrWorkerRequest; transfer: Transferable[] }, timeoutMs: number, callSignal?: AbortSignal): Promise<OcrWorkerReply> {
    if (disposed) return Promise.reject(new OcrError('ABORTED', 'The text recognition engine was stopped.'));
    if (callSignal?.aborted) return Promise.reject(aborted());
    const id = ++sequence;
    return new Promise<OcrWorkerReply>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => { cleanup(); reject(aborted()); dispose(); };
      const cleanup = () => { clearTimeout(timer); callSignal?.removeEventListener('abort', onAbort); pending.delete(id); };
      pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(() => { cleanup(); reject(new OcrError('TIMEOUT', 'Text recognition exceeded its time budget.')); dispose(); }, timeoutMs);
      callSignal?.addEventListener('abort', onAbort, { once: true });
      const { message, transfer } = build(id);
      try { worker.postMessage(message, transfer); } catch (error) { cleanup(); reject(new OcrError('FAILED', 'The request could not be sent to the text recognition worker.', { cause: error })); }
    });
  }

  try {
    const ready = await call(id => ({ message: { type: 'init', id, simd: assets.simd, wasm: assets.wasm, language, data: assets.data }, transfer: [assets.wasm, assets.data] }),
      deps.startTimeoutMs ?? ENGINE_START_TIMEOUT_MS, signal);
    if (ready.type !== 'ready') throw new OcrError('FAILED', 'The text recognition worker did not start.');
  } catch (error) {
    dispose();
    if (error instanceof OcrError && error.code === 'TIMEOUT') throw new OcrError('UNAVAILABLE', 'The text recognition engine did not start in time.', { cause: error });
    throw error;
  }

  let queue: Promise<unknown> = Promise.resolve();
  return {
    language,
    get disposed() { return disposed; },
    dispose: () => dispose(),
    recognize(image: GrayImage, request: OcrRecognizeOptions): Promise<OcrWord[]> {
      const run = async (): Promise<OcrWord[]> => {
        if (image.data.length !== image.width * image.height) throw new OcrError('INVALID', 'The image must be width x height bytes of 8-bit grey.');
        const pixels = image.data.slice().buffer; // a private copy is transferred; the caller keeps its image
        const reply = await call(id => ({
          message: { type: 'recognize', id, width: image.width, height: image.height, pixels, dpi: request.dpi, rotations: [...(request.rotations ?? DEFAULT_ROTATIONS)], pageSegmentation: request.pageSegmentation ?? OCR_PAGE_SEGMENTATION },
          transfer: [pixels],
        }), request.timeoutMs ?? Infinity, request.signal);
        if (reply.type !== 'words') throw new OcrError('FAILED', 'Unexpected reply from the text recognition worker.');
        return reply.words;
      };
      const result = queue.then(run, run);
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
