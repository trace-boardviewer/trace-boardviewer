import simdWasmUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm?url';
import plainWasmUrl from 'tesseract.js-core/tesseract-core-lstm.wasm?url';
import engDataUrl from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url';
import { OcrError } from './contract';
import type { OcrEngineFactory, OcrLanguage } from './contract';
import { createWorkerOcrEngineFactory } from './engine';
import type { OcrEngineAssets, OcrWorkerPort } from './engine';

/**
 * The OCR engine as shipped: the worker, both engine builds and the language data are files Vite emits into dist/assets (inside
 * app.asar when packaged) and the renderer reads them from there, exactly like the pdf.js resources. Nothing is downloaded.
 *
 * Languages: one row per language in LANGUAGE_DATA (the `@tesseract.js-data/<code>` package, `4.0.0_best_int` file) plus the code in
 * `OcrLanguage`. Only English is bundled today.
 */
const LANGUAGE_DATA: Readonly<Record<OcrLanguage, string>> = { eng: engDataUrl };

/** Reads a bundled file. Under file:// (the packaged app) fetch() is not available, so XMLHttpRequest reads it, as pdf.js does. */
export function readBundledFile(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (signal?.aborted) return Promise.reject(new OcrError('ABORTED', 'Text recognition was cancelled.'));
  const absolute = new URL(url, typeof document !== 'undefined' ? document.baseURI : self.location.href);
  if (absolute.protocol === 'http:' || absolute.protocol === 'https:') {
    if (absolute.origin !== (typeof location !== 'undefined' ? location.origin : absolute.origin)) return Promise.reject(new OcrError('UNAVAILABLE', 'OCR assets must be served by the application itself.'));
    return fetch(absolute.href, { signal, credentials: 'same-origin' }).then(response => {
      if (!response.ok) throw new OcrError('UNAVAILABLE', `A bundled OCR file is missing (${response.status}).`);
      return response.arrayBuffer();
    });
  }
  if (absolute.protocol !== 'file:') return Promise.reject(new OcrError('UNAVAILABLE', 'OCR assets must be local files.'));
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', absolute.href, true);
    request.responseType = 'arraybuffer';
    const onAbort = () => { signal?.removeEventListener('abort', onAbort); request.abort(); reject(new OcrError('ABORTED', 'Text recognition was cancelled.')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    request.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      if ((request.status === 200 || request.status === 0) && request.response instanceof ArrayBuffer && request.response.byteLength > 0) resolve(request.response);
      else reject(new OcrError('UNAVAILABLE', 'A bundled OCR file could not be read.'));
    };
    request.onerror = () => { signal?.removeEventListener('abort', onAbort); reject(new OcrError('UNAVAILABLE', 'A bundled OCR file could not be read.')); };
    request.send();
  });
}

/**
 * Engine bytes for this CPU: the SIMD build (3.5x faster) when WebAssembly SIMD validates here, else the plain build. Validation
 * only parses the module (it compiles nothing), so the page CSP allows it.
 */
async function loadBundledAssets(language: OcrLanguage, signal?: AbortSignal): Promise<OcrEngineAssets> {
  const dataUrl = LANGUAGE_DATA[language];
  if (!dataUrl) throw new OcrError('UNAVAILABLE', `No bundled text recognition data for "${language}".`);
  const [simdWasm, data] = await Promise.all([readBundledFile(simdWasmUrl, signal), readBundledFile(dataUrl, signal)]);
  if (WebAssembly.validate(simdWasm)) return { simd: true, wasm: simdWasm, data };
  return { simd: false, wasm: await readBundledFile(plainWasmUrl, signal), data };
}

function createBundledWorker(): OcrWorkerPort {
  // The `new Worker(new URL('<literal>', import.meta.url), ...)` form must stay literal: it is what Vite recognizes to bundle a worker.
  const worker = new Worker(new URL('./ocr.worker.ts', import.meta.url), { type: 'module', name: 'trace-ocr' });
  return {
    get onmessage() { return worker.onmessage as OcrWorkerPort['onmessage']; },
    set onmessage(handler) { worker.onmessage = handler ? (event: MessageEvent) => handler({ data: event.data }) : null; },
    get onerror() { return worker.onerror as OcrWorkerPort['onerror']; },
    set onerror(handler) { worker.onerror = handler ? (event: ErrorEvent) => { event.preventDefault(); handler(event); } : null; },
    postMessage: (message, transfer) => worker.postMessage(message, transfer),
    terminate: () => worker.terminate(),
  };
}

/** The application's OCR engine factory (one worker per engine). */
export const bundledOcrEngine: OcrEngineFactory = createWorkerOcrEngineFactory({ createWorker: createBundledWorker, loadAssets: loadBundledAssets });
