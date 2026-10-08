# Offline text recognition

Image pages without a text layer offer **Recognize text**. Recognition uses bundled English data, runs in a dedicated worker, and supports progress and cancellation. Results are marked as recognized text with confidence and cached in memory by document digest, language, resolution and pipeline version. Search includes recognized words; board links require exact normalized reference or net equality and confidence of at least 60. Confidence is rounded down so an uncertain word cannot cross the link threshold through rounding.

## Background jobs

`recognizePdfPages` in `src/lib/ocr/pdf-pages.ts` accepts an `OcrPageSource` and engine factory without a view or session. A `PdfHandle` from `openPdf` implements that source. Use `bundledOcrEngine` from `src/lib/ocr/bundled.ts` in the application renderer or a dedicated background renderer. It loads application assets only and starts a separate engine worker, so synchronous WebAssembly recognition can be interrupted by terminating that worker.

For Library scans, call `recognizeLibraryPdf(handle, { engine: bundledOcrEngine, signal, onPage })`. This entry point inspects only pages 1 and 2, skips pages with text or without images, and preserves completed page results when cancelled. It does not open a document view or copy the source file. The caller owns opening and destroying the PDF handle and persisting any Library index results. Configure the PDF resource URLs through the existing PDF resource setup before opening files in a background context.

Each page has a default 120-second deadline covering metadata inspection, rendering, asset loading, engine startup and recognition. The default raster cap is 40 million pixels; callers can lower it with `maxPixels` and lower the deadline with `pageTimeoutMs`. Rendering reduces resolution to fit the cap. A timed-out page is reported and processing continues on a fresh engine. Three consecutive page failures stop the job. Every engine is disposed when the job ends, including engines whose startup completes after cancellation. PDF source operations receive cancellation for rendering; the caller should also destroy the handle after the job to release its PDF worker and any outstanding metadata work.

The in-process engine adapter is for synthetic tests. Its synchronous recognition cannot be interrupted and must not be used for background scan budgets.

## Security and packaging

The renderer CSP, Electron sandbox and fuses are unchanged. The engine runs in a local file module worker, where the current runtime permits WebAssembly compilation without adding `wasm-unsafe-eval` to the page policy. Worker network and script-loading globals are disabled before engine initialization; engine code, language data and pixels are supplied as bytes. No CDN or runtime download is configured.

Vite emits the worker, SIMD and fallback LSTM WebAssembly files, and compressed English data under `dist/assets`. The existing builder file selection includes them inside `app.asar`; no unpacking is needed. Both OCR packages are pinned development dependencies, so their unused builds and data variants are excluded from the application. Adding a language requires a bundled data asset, an entry in the language table and an extension of the language contract.

The file worker's policy must be revisited when adopting a custom application protocol with CSP response headers. Such a worker will need a separate policy permitting WebAssembly compilation while retaining a strict page policy.
