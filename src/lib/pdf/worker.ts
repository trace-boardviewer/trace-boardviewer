import { GlobalWorkerOptions } from 'pdfjs-dist';

/**
 * Where PDF.js finds its module worker and its static resources. Everything is local:
 * - the worker is `pdfjs-dist/build/pdf.worker.min.mjs`, which Vite emits as a hashed asset next
 *   to the bundle (relative URL, so it also loads under file:// in the packaged app);
 * - CMaps, standard fonts, wasm decoders and ICC profiles live under `pdfjs/` beside index.html.
 *   The `pdfjsAssetsPlugin` in vite.config.ts copies them at build time and serves them in dev.
 * Folder URLs end with a slash, exactly as the pdf.js `cMapUrl`/`standardFontDataUrl`/`wasmUrl`/`iccUrl`
 * options require. Under http(s) pdf.js fetches them inside the worker; under file:// it asks the
 * main thread, which falls back to XMLHttpRequest (pdf.js only uses fetch() for http(s) URLs).
 */
export interface PdfResourceUrls {
  workerSrc: string;
  cMapUrl: string;
  standardFontDataUrl: string;
  wasmUrl: string;
  iccUrl: string;
}

let overrides: Partial<PdfResourceUrls> = {};
let appliedWorkerSrc: string | null = null;

/**
 * Overrides the browser defaults. Node tests point `workerSrc` at the file URL of
 * `pdfjs-dist/build/pdf.worker.mjs` and the folders at plain filesystem paths ending in "/" (pdf.js
 * insists on a trailing slash and reads them with `fs.readFile(base + filename)` in Node, so
 * file:// URLs would fail there).
 */
export function configurePdfResources(urls: Partial<PdfResourceUrls>): void {
  overrides = { ...overrides, ...urls };
  appliedWorkerSrc = null;
}

function defaultUrls(): PdfResourceUrls {
  const base = typeof document !== 'undefined' ? document.baseURI : 'file:///';
  return {
    workerSrc: new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href,
    cMapUrl: new URL('pdfjs/cmaps/', base).href,
    standardFontDataUrl: new URL('pdfjs/standard_fonts/', base).href,
    wasmUrl: new URL('pdfjs/wasm/', base).href,
    iccUrl: new URL('pdfjs/iccs/', base).href,
  };
}

/** Resolves the effective URLs and installs the worker source into pdf.js (idempotent). */
export function resolvePdfResources(): PdfResourceUrls {
  const urls = { ...defaultUrls(), ...overrides };
  if (appliedWorkerSrc !== urls.workerSrc) {
    GlobalWorkerOptions.workerSrc = urls.workerSrc;
    appliedWorkerSrc = urls.workerSrc;
  }
  return urls;
}
