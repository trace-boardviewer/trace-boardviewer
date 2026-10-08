import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configurePdfResources } from './worker';
import { buildPdfFixture } from './pdf-fixture';
import { createPdfSession } from './session';
import type { PdfSession, PdfSessionSnapshot } from './session-contract';
import { OcrResultCache } from '../ocr/cache';
import { OCR_LINK_MIN_CONFIDENCE, OcrError } from '../ocr/contract';
import type { GrayImage, OcrEngineFactory, OcrRecognizeOptions, OcrWord } from '../ocr/contract';
import { inProcessOcrEngine } from '../ocr/recognizer';
import type { TesseractCoreFactory } from '../ocr/recognizer';
import { buildSyntheticScan } from '../ocr/synthetic-scan';

// Node setup shared with document.test.ts, plus pdf.js' Node canvas (for the synthetic scans) and the bundled engine in-process.
const require = createRequire(import.meta.url);
const pdfjsRoot = realpathSync(path.dirname(require.resolve('pdfjs-dist/package.json')));
const nodeCanvas = createRequire(path.join(pdfjsRoot, 'package.json'))('@napi-rs/canvas') as Record<string, unknown>;
for (const name of ['Path2D', 'DOMMatrix', 'ImageData'] as const) (globalThis as Record<string, unknown>)[name] ??= nodeCanvas[name];
const folder = (name: string) => `${path.join(pdfjsRoot, name).replace(/\\/g, '/')}/`;
configurePdfResources({
  workerSrc: pathToFileURL(path.join(pdfjsRoot, 'legacy', 'build', 'pdf.worker.mjs')).href,
  cMapUrl: folder('cmaps'), standardFontDataUrl: folder('standard_fonts'), wasmUrl: folder('wasm'), iccUrl: folder('iccs'),
});
const coreRoot = path.dirname(require.resolve('tesseract.js-core/package.json'));
const realEngine = inProcessOcrEngine({
  core: require('tesseract.js-core/tesseract-core-simd-lstm.js') as TesseractCoreFactory,
  wasm: readFileSync(path.join(coreRoot, 'tesseract-core-simd-lstm.wasm')),
  data: new Uint8Array(readFileSync(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'))),
});

/** A fake engine: fixed words per call (pixels at 300 dpi), optional hang until cancelled, counted. */
function scriptedEngine(words: (call: number) => OcrWord[] | 'hang' | OcrError) {
  const state = { starts: 0, calls: 0, disposed: 0 };
  const factory: OcrEngineFactory = async ({ language }) => {
    state.starts++;
    let disposed = false;
    const stop = () => { if (!disposed) { disposed = true; state.disposed++; } };
    return {
      language,
      get disposed() { return disposed; },
      dispose: stop,
      async recognize(_image: GrayImage, options: OcrRecognizeOptions) {
        const step = words(state.calls++);
        if (step instanceof OcrError) throw step;
        if (step === 'hang') return new Promise<OcrWord[]>((_, reject) => options.signal?.addEventListener('abort', () => { stop(); reject(new OcrError('ABORTED', 'cancelled')); }, { once: true }));
        return step;
      },
    };
  };
  return { factory, state };
}
const px = (pt: number) => pt * (300 / 72);
const word = (text: string, xPt: number, yPt: number, confidence = 92): OcrWord => ({ text, x: px(xPt), y: px(yPt), width: px(text.length * 8), height: px(12), confidence, rotation: 0 });

function until(session: PdfSession, predicate: (snapshot: PdfSessionSnapshot) => boolean): Promise<PdfSessionSnapshot> {
  return new Promise(resolve => {
    let unsubscribe = () => {};
    const check = () => { const snapshot = session.getSnapshot(); if (predicate(snapshot)) { unsubscribe(); resolve(snapshot); } };
    unsubscribe = session.subscribe(check);
    check();
  });
}
const sessions: PdfSession[] = [];
const open = (data: Uint8Array, ocr?: Parameters<typeof createPdfSession>[0]['ocr']) => { const session = createPdfSession({ id: `s${sessions.length}`, data, ocr }); sessions.push(session); return session; };
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.dispose())); vi.unstubAllGlobals(); });

// Page 1: a text layer; page 2: a raster (the fixture's 2x2 image); page 3: empty.
const mixedPdf = buildPdfFixture({ pages: [{ texts: [{ x: 72, y: 700, text: 'R12 GND' }] }, { image: true }, {}] });
let scanPdf: Uint8Array;
beforeAll(async () => {
  scanPdf = await buildSyntheticScan([
    { texts: [{ x: 30, y: 150, text: 'U7  R220  C14', size: 14 }, { x: 30, y: 60, text: 'VCC_3V3  GND  R2201', size: 14 }] },
    { texts: [{ x: 30, y: 120, text: 'Q12  L3', size: 14 }] },
  ]);
}, 60_000);

describe('PDF session: text recognition', () => {
  it('without an engine the state is unavailable and recognizeText rejects', async () => {
    const session = open(mixedPdf);
    await until(session, s => s.status === 'ready');
    expect(session.getSnapshot().ocr.state).toBe('unavailable');
    await expect(session.recognizeText()).rejects.toMatchObject({ name: 'OcrError', code: 'UNAVAILABLE' });
    expect(await session.inspectPage(2)).toBe('image-only'); // inspection works regardless (it drives no engine)
  });

  it('inspectPage tells text pages, image-only pages and blank pages apart', async () => {
    const session = open(mixedPdf, { engine: scriptedEngine(() => []).factory, cache: new OcrResultCache() });
    expect(await Promise.all([1, 2, 3].map(page => session.inspectPage(page)))).toEqual(['text', 'image-only', 'blank']);
  });

  it('recognizes image-only pages, publishes progress, and makes the words searchable and linkable on exact names only', async () => {
    const engine = scriptedEngine(() => [word('R5', 100, 100), word('GND', 150, 100), word('R55', 100, 140), word('C9', 200, 100, OCR_LINK_MIN_CONFIDENCE - 1)]);
    const session = open(mixedPdf, { engine: engine.factory, cache: new OcrResultCache() });
    await until(session, s => s.status === 'ready');
    const seen: PdfSessionSnapshot['ocr'][] = [];
    const unsubscribe = session.subscribe(() => seen.push(session.getSnapshot().ocr));
    await session.recognizeText();
    unsubscribe();
    const ocr = session.getSnapshot().ocr;
    expect(ocr).toMatchObject({ state: 'done', totalPages: 3, processedPages: 3, currentPage: 0, recognizedPages: 1, words: 4, failedPages: 0, error: null });
    expect(ocr.revision).toBeGreaterThan(0);
    expect(seen.some(state => state.state === 'running' && state.currentPage === 2)).toBe(true);
    expect(engine.state).toEqual({ starts: 1, calls: 1, disposed: 1 }); // only page 2 needed the engine
    expect(session.getRecognizedText(1)).toBeNull();
    expect(session.getRecognizedText(2)?.map(item => [item.str, item.source, item.page])).toEqual([['R5', 'ocr', 2], ['GND', 'ocr', 2], ['R55', 'ocr', 2], ['C9', 'ocr', 2]]);
    // search: the text layer and the recognized words, the latter marked with their confidence
    const gnd = await session.find('GND');
    expect(gnd.map(hit => [hit.page, hit.source ?? 'text'])).toEqual([[1, 'text'], [2, 'ocr']]);
    expect(gnd[1].confidence).toBe(92);
    expect(gnd[1].x).toBeCloseTo(150, 5);
    expect((await session.find('C9')).map(hit => hit.confidence)).toEqual([OCR_LINK_MIN_CONFIDENCE - 1]); // searchable below the floor
    // cross-reference: exact tokens only, and only at or above the confidence floor
    const scan = await session.refCandidates(new Set(['R5', 'R1', 'C9']), new Set(['GND']));
    const byName = new Map(scan.candidates.map(candidate => [candidate.name, candidate]));
    expect(byName.get('R5')?.hits.map(hit => [hit.page, hit.source, hit.confidence])).toEqual([[2, 'ocr', 92]]); // not R55
    expect(byName.has('R1')).toBe(false);
    expect(byName.has('C9')).toBe(false);
    expect(byName.get('GND')?.hits.map(hit => hit.source ?? 'text')).toEqual(['text', 'ocr']);
    expect(session.getSnapshot().searchable).toBe(true); // still describes the PDF's own text layer
  });

  it('starts with the page in view, skips pages already recognized, and is single-flight', async () => {
    const engine = scriptedEngine(call => [word(`W${call}`, 50, 50)]);
    const data = buildPdfFixture({ pages: [{ image: true }, { image: true }, { image: true }] });
    const session = open(data, { engine: engine.factory, cache: new OcrResultCache() });
    const order: number[] = [];
    session.subscribe(() => { const { currentPage } = session.getSnapshot().ocr; if (currentPage && order.at(-1) !== currentPage) order.push(currentPage); });
    const first = session.recognizeText({ firstPage: 3, pages: [1, 3] });
    expect(session.recognizeText()).toBe(first);
    await first;
    expect(order).toEqual([3, 1]);
    await session.recognizeText();
    expect(session.getSnapshot().ocr).toMatchObject({ state: 'done', totalPages: 1, processedPages: 1, recognizedPages: 3 });
    expect(engine.state.calls).toBe(3);
  });

  it('cancelRecognition stops the job; recognized pages stay', async () => {
    const engine = scriptedEngine(call => (call === 0 ? [word('R1', 10, 10)] : 'hang'));
    const session = open(buildPdfFixture({ pages: [{ image: true }, { image: true }] }), { engine: engine.factory, cache: new OcrResultCache() });
    const job = session.recognizeText();
    await until(session, s => s.ocr.currentPage === 2);
    session.cancelRecognition();
    await job;
    expect(session.getSnapshot().ocr).toMatchObject({ state: 'cancelled', processedPages: 1, recognizedPages: 1, currentPage: 0 });
    expect(engine.state.disposed).toBe(1);
    expect((await session.find('R1')).length).toBe(1);
  });

  it('an engine that cannot start ends in the error state with its code', async () => {
    const failing: OcrEngineFactory = async () => { throw new OcrError('UNAVAILABLE', 'CompileError: WebAssembly.instantiate(): Refused to compile'); };
    const session = open(buildPdfFixture({ pages: [{ image: true }] }), { engine: failing, cache: new OcrResultCache() });
    await session.recognizeText();
    expect(session.getSnapshot().ocr).toMatchObject({ state: 'error', error: { code: 'UNAVAILABLE' }, recognizedPages: 0 });
  });

  it('closing the document during recognition stops the engine quietly', async () => {
    const engine = scriptedEngine(() => 'hang');
    const session = open(buildPdfFixture({ pages: [{ image: true }] }), { engine: engine.factory, cache: new OcrResultCache() });
    const job = session.recognizeText();
    await vi.waitFor(() => expect(engine.state.calls).toBe(1)); // the engine is working on page 1
    await session.dispose();
    await job;
    expect(engine.state.disposed).toBe(1);
    expect(session.getSnapshot().status).toBe('closed');
    await expect(session.recognizeText()).rejects.toMatchObject({ code: 'DESTROYED' });
    await expect(session.inspectPage(1)).rejects.toMatchObject({ code: 'DESTROYED' });
  });

  it('results are cached per document content: the same file opened again shows its recognized text without the engine', async () => {
    const cache = new OcrResultCache();
    const engine = scriptedEngine(() => [word('PU301', 40, 40)]);
    const data = buildPdfFixture({ pages: [{ image: true }] });
    const first = open(data, { engine: engine.factory, cache });
    await first.recognizeText();
    await first.dispose();
    const again = open(data.slice(), { engine: engine.factory, cache });
    const restored = await until(again, s => s.ocr.recognizedPages === 1);
    expect(restored.ocr).toMatchObject({ state: 'idle', words: 1 });
    expect(again.getRecognizedText(1)?.[0]).toMatchObject({ str: 'PU301', source: 'ocr' });
    expect((await again.find('PU301')).length).toBe(1);
    const other = open(buildPdfFixture({ pages: [{ image: true }, {}] }), { engine: engine.factory, cache });
    await until(other, s => s.status === 'ready');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(other.getSnapshot().ocr.recognizedPages).toBe(0); // different bytes, different key
    expect(engine.state.calls).toBe(1);
  });

  it('end to end with the real engine on a synthetic scan, with every network API stubbed to throw', async () => {
    const blocked = () => { throw new Error('network access during text recognition'); };
    vi.stubGlobal('fetch', blocked); vi.stubGlobal('XMLHttpRequest', blocked); vi.stubGlobal('WebSocket', blocked); vi.stubGlobal('EventSource', blocked);
    const session = open(scanPdf, { engine: realEngine, cache: new OcrResultCache() });
    const ready = await until(session, s => s.status === 'ready' && s.searchable !== null);
    expect(ready.searchable).toBe(false); // a scan: no text layer
    expect(await session.inspectPage(1)).toBe('image-only');
    await session.recognizeText({ firstPage: 2 });
    const ocr = session.getSnapshot().ocr;
    expect(ocr).toMatchObject({ state: 'done', recognizedPages: 2, failedPages: 0 });
    const scan = await session.refCandidates(new Set(['U7', 'R220', 'C14', 'Q12', 'L3', 'R22']), new Set(['GND', 'VCC_3V3']));
    const found = new Map(scan.candidates.map(candidate => [candidate.name, candidate.hits]));
    expect([...found.keys()].sort()).toEqual(['C14', 'GND', 'L3', 'Q12', 'R220', 'U7', 'VCC_3V3']); // R22 is never matched inside R220/R2201
    expect(found.get('R220')).toHaveLength(1);
    for (const hits of found.values()) for (const hit of hits) expect(hit).toMatchObject({ source: 'ocr' });
    expect((await session.find('R2201')).map(hit => hit.page)).toEqual([1]);
  }, 120_000);
});
