import simdCore from 'tesseract.js-core/tesseract-core-simd-lstm.js';
import plainCore from 'tesseract.js-core/tesseract-core-lstm.js';
import { OcrError, isOcrError } from './contract';
import type { OcrErrorCode } from './contract';
import { parseWorkerRequest } from './protocol';
import type { OcrWorkerReply } from './protocol';
import { createRecognizer } from './recognizer';
import type { Recognizer } from './recognizer';
import { blockNetworkAccess } from './sandbox';

/**
 * The OCR worker: Tesseract (WebAssembly) and nothing else. It is a dedicated module worker emitted by Vite next to the bundle (in
 * app.asar when packaged), never a blob: worker, so the engine compiles without 'wasm-unsafe-eval' in the page CSP. It performs no
 * I/O: the network and script-loading globals are disabled first (sandbox.ts), and the engine bytes, the language data and the
 * pixels arrive in messages. One request at a time; the renderer terminates the worker to cancel or to enforce a time budget.
 */
const scope = self as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(message: OcrWorkerReply): void };
const blocked = blockNetworkAccess(self);
let recognizer: Recognizer | null = null;
let busy = false;

const reply = (message: OcrWorkerReply) => scope.postMessage(message);
const fail = (id: number, error: unknown, fallback: OcrErrorCode) => {
  const code: OcrErrorCode = isOcrError(error) ? error.code : fallback;
  reply({ type: 'error', id, code, message: error instanceof Error ? error.message : String(error) });
};

scope.onmessage = (event: MessageEvent) => {
  const request = parseWorkerRequest(event.data);
  const id = typeof (event.data as { id?: unknown } | null)?.id === 'number' ? (event.data as { id: number }).id : 0;
  if (!request) { if (id > 0) fail(id, new OcrError('INVALID', 'Malformed request.'), 'INVALID'); return; }
  if (busy) { fail(request.id, new OcrError('INVALID', 'The worker is busy.'), 'INVALID'); return; }
  busy = true;
  void (async () => {
    try {
      if (request.type === 'init') {
        if (recognizer) throw new OcrError('INVALID', 'The engine is already initialized.');
        recognizer = await createRecognizer({ core: request.simd ? simdCore : plainCore, wasm: request.wasm, language: request.language, data: new Uint8Array(request.data) });
        reply({ type: 'ready', id: request.id, version: recognizer.version, blocked });
      } else {
        if (!recognizer) throw new OcrError('INVALID', 'The engine is not initialized.');
        const started = performance.now();
        const { words } = recognizer.recognize({ width: request.width, height: request.height, data: new Uint8Array(request.pixels) }, {
          dpi: request.dpi, rotations: request.rotations, pageSegmentation: request.pageSegmentation,
        });
        reply({ type: 'words', id: request.id, words, ms: performance.now() - started });
      }
    } catch (error) {
      fail(request.id, error, request.type === 'init' ? 'UNAVAILABLE' : 'FAILED');
    } finally {
      busy = false;
    }
  })();
};
