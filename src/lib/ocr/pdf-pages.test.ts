import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { configurePdfResources } from '../pdf/worker';
import { openPdf } from '../pdf/document';
import type { TextItem } from '../pdf/document';
import { OCR_MAX_DPI, OcrError } from './contract';
import type { GrayImage, OcrEngine, OcrEngineFactory, OcrRecognizeOptions, OcrWord } from './contract';
import { MAX_CONSECUTIVE_ENGINE_FAILURES, orderPages, recognizeLibraryPdf, recognizePdfPages, wordsToTextItems } from './pdf-pages';
import type { OcrPageSource, OcrPageResult, PageRaster } from './pdf-pages';
import { inProcessOcrEngine } from './recognizer';
import type { TesseractCoreFactory } from './recognizer';
import { buildSyntheticScan } from './synthetic-scan';

// ------------------------------------------------------------------------------------------------ fakes
interface FakePage { text?: number; images?: number; rotation?: number; renderMs?: number; fail?: string }
function fakeSource(pages: FakePage[]) {
  const renders: Array<{ page: number; dpi: number; maxPixels: number }> = [];
  const source: OcrPageSource = {
    pageCount: pages.length,
    getTextItems: async page => Array.from({ length: pages[page - 1].text ?? 0 }, (_, i) => ({ str: `T${i}`, x: 0, y: 0, width: 1, height: 1, page })),
    getPageImageCount: async page => pages[page - 1].images ?? 1,
    async renderPageGray(page, options): Promise<PageRaster> {
      renders.push({ page, dpi: options.dpi, maxPixels: options.maxPixels });
      const spec = pages[page - 1];
      if (spec.fail) throw new Error(spec.fail);
      if (spec.renderMs) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, spec.renderMs);
        options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('render cancelled')); }, { once: true });
      });
      return { image: { width: 10, height: 10, data: new Uint8Array(100).fill(255) }, scale: options.dpi / 72, rotation: spec.rotation ?? 0 };
    },
  };
  return { source, renders };
}
interface FakeEngineScript { words?: OcrWord[]; hang?: boolean; fail?: OcrError; startFail?: OcrError }
function fakeEngines(script: (call: number) => FakeEngineScript = () => ({})) {
  const engines: Array<OcrEngine & { calls: OcrRecognizeOptions[] }> = [];
  let calls = 0;
  const factory: OcrEngineFactory = async ({ language }) => {
    const first = script(calls);
    if (first.startFail) throw first.startFail;
    let disposed = false;
    const engine = {
      language, calls: [] as OcrRecognizeOptions[],
      get disposed() { return disposed; },
      dispose: vi.fn(() => { disposed = true; }),
      async recognize(_image: GrayImage, options: OcrRecognizeOptions): Promise<OcrWord[]> {
        engine.calls.push(options);
        const step = script(calls++);
        if (step.fail) throw step.fail;
        if (step.hang) {
          await new Promise<void>((_, reject) => {
            const timer = options.timeoutMs !== undefined ? setTimeout(() => { disposed = true; reject(new OcrError('TIMEOUT', 'budget')); }, options.timeoutMs) : undefined;
            options.signal?.addEventListener('abort', () => { clearTimeout(timer); disposed = true; reject(new OcrError('ABORTED', 'cancelled')); }, { once: true });
          });
        }
        return step.words ?? [{ text: 'R1', x: 72, y: 144, width: 36, height: 18, confidence: 91.4, rotation: 0 }];
      },
    };
    engines.push(engine);
    return engine;
  };
  return { factory, engines };
}

describe('recognizePdfPages (fake source and engine)', () => {
  it('limits Library scans to the first two pages, including mixed documents', async () => {
    const { source, renders } = fakeSource([{ text: 1 }, {}, {}, {}]);
    const result = await recognizeLibraryPdf(source, { engine: fakeEngines().factory, maxPixels: 1000 });
    expect(result.pages.map(page => [page.page, page.status])).toEqual([[1, 'has-text'], [2, 'recognized']]);
    expect(renders).toEqual([{ page: 2, dpi: 300, maxPixels: 1000 }]);
  });

  it('bounds hung metadata and cancellation without relying on the source to settle', async () => {
    vi.useFakeTimers();
    try {
      const { source } = fakeSource([{}, {}]);
      source.getTextItems = page => page === 1 ? new Promise(() => {}) : Promise.resolve([]);
      const job = recognizePdfPages(source, { engine: fakeEngines().factory, pageTimeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      expect((await job).pages.map(page => page.status)).toEqual(['timeout', 'recognized']);
      const abort = new AbortController();
      const cancelled = recognizePdfPages(source, { engine: fakeEngines().factory, signal: abort.signal });
      abort.abort();
      expect(await cancelled).toEqual({ pages: [], cancelled: true });
    } finally { vi.useRealTimers(); }
  });

  it('bounds engine startup and disposes an engine that arrives after its deadline', async () => {
    vi.useFakeTimers();
    try {
      const { source } = fakeSource([{}]);
      const { factory, engines } = fakeEngines();
      let deliver!: (engine: OcrEngine) => void;
      const job = recognizePdfPages(source, { engine: () => new Promise(resolve => { deliver = resolve; }), pageTimeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      expect((await job).pages[0].status).toBe('timeout');
      deliver(await factory({ language: 'eng' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(engines[0].disposed).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('rejects a source raster that exceeds the requested size budget', async () => {
    const { source } = fakeSource([{}]);
    const { factory, engines } = fakeEngines();
    const result = await recognizePdfPages(source, { engine: factory, maxPixels: 50 });
    expect(result.pages[0].status).toBe('failed');
    expect(engines).toHaveLength(0);
  });
  it('recognizes only image pages without text, in order, converting pixels to points', async () => {
    const { source, renders } = fakeSource([{ text: 3 }, { images: 2 }, { images: 0 }, { images: 1 }]);
    const { factory, engines } = fakeEngines();
    const started: number[] = [], done: OcrPageResult[] = [];
    const result = await recognizePdfPages(source, { engine: factory, onPageStart: page => started.push(page), onPage: page => done.push(page) });
    expect(result.cancelled).toBe(false);
    expect(result.pages.map(page => [page.page, page.status])).toEqual([[1, 'has-text'], [2, 'recognized'], [3, 'no-image'], [4, 'recognized']]);
    expect(started).toEqual([1, 2, 3, 4]);
    expect(done.map(page => page.page)).toEqual([1, 2, 3, 4]);
    expect(renders.map(render => render.page)).toEqual([2, 4]);
    expect(renders[0]).toMatchObject({ dpi: 300, maxPixels: 40_000_000 });
    const [item] = result.pages[1].items;
    expect(item).toEqual({ str: 'R1', x: 72 / (300 / 72), y: 144 / (300 / 72), width: 36 / (300 / 72), height: 18 / (300 / 72), page: 2, source: 'ocr', confidence: 91 });
    expect(result.pages[1].dpi).toBe(300);
    expect(engines).toHaveLength(1); // one engine for the whole job ...
    expect(engines[0].dispose).toHaveBeenCalled(); // ... stopped at the end
    expect(engines[0].calls[0]).toMatchObject({ dpi: 300, rotations: [0, 1], pageSegmentation: 11 });
  });

  it('runs the passes upright as displayed: a page with /Rotate 90 is read at a quarter and a half turn', async () => {
    const { source } = fakeSource([{ rotation: 90 }, { rotation: 270 }]);
    const { factory, engines } = fakeEngines();
    await recognizePdfPages(source, { engine: factory });
    expect(engines[0].calls.map(call => call.rotations)).toEqual([[1, 2], [3, 0]]);
  });

  it('can include text pages and vector pages on request; honours the page list; clamps the resolution', async () => {
    const { source, renders } = fakeSource([{ text: 3 }, { images: 0 }, {}]);
    const { factory } = fakeEngines();
    const result = await recognizePdfPages(source, { engine: factory, pages: [3, 1, 3, 9, 0, 2], includePagesWithText: true, includePagesWithoutImages: true, dpi: 9000, maxPixels: 5_000_000 });
    expect(result.pages.map(page => [page.page, page.status])).toEqual([[3, 'recognized'], [1, 'recognized'], [2, 'recognized']]);
    expect(renders.every(render => render.dpi === OCR_MAX_DPI && render.maxPixels === 5_000_000)).toBe(true);
    expect(orderPages(3)).toEqual([1, 2, 3]);
  });

  it('a page over its time budget is reported as timeout and the next page gets a fresh engine', async () => {
    const { source } = fakeSource([{}, {}, {}]);
    const { factory, engines } = fakeEngines(call => (call === 1 ? { hang: true } : {}));
    const result = await recognizePdfPages(source, { engine: factory, pageTimeoutMs: 50 });
    expect(result.pages.map(page => page.status)).toEqual(['recognized', 'timeout', 'recognized']);
    expect(engines).toHaveLength(2);
    expect(engines[0].disposed).toBe(true);
  });

  it('the budget covers rendering too', async () => {
    const { source } = fakeSource([{ renderMs: 5_000 }, {}]);
    const { factory } = fakeEngines();
    const result = await recognizePdfPages(source, { engine: factory, pageTimeoutMs: 40 });
    expect(result.pages.map(page => page.status)).toEqual(['timeout', 'recognized']);
  });

  it('cancelling stops at once and returns the finished pages; the engine is stopped', async () => {
    const { source } = fakeSource([{}, {}, {}]);
    const { factory, engines } = fakeEngines(call => (call === 1 ? { hang: true } : {}));
    const controller = new AbortController();
    const result = await recognizePdfPages(source, { engine: factory, signal: controller.signal, onPageStart: page => { if (page === 2) setTimeout(() => controller.abort(), 20); } });
    expect(result.cancelled).toBe(true);
    expect(result.pages.map(page => page.page)).toEqual([1]);
    expect(engines.every(engine => engine.disposed)).toBe(true);
    const before = new AbortController(); before.abort();
    expect(await recognizePdfPages(source, { engine: factory, signal: before.signal })).toEqual({ pages: [], cancelled: true });
  });

  it('an engine that cannot start rejects the job (UNAVAILABLE); repeated failures end it too', async () => {
    const { source } = fakeSource([{}, {}]);
    await expect(recognizePdfPages(source, { engine: fakeEngines(() => ({ startFail: new OcrError('UNAVAILABLE', 'CompileError') })).factory })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const many = fakeSource(Array.from({ length: 6 }, () => ({})));
    await expect(recognizePdfPages(many.source, { engine: fakeEngines(() => ({ fail: new OcrError('FAILED', 'bad page') })).factory })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const some = fakeSource([{}, {}, {}]);
    const flaky = fakeEngines(call => (call === 0 ? { fail: new OcrError('FAILED', 'bad page') } : {}));
    const result = await recognizePdfPages(some.source, { engine: flaky.factory });
    expect(result.pages.map(page => page.status)).toEqual(['failed', 'recognized', 'recognized']);
    expect(MAX_CONSECUTIVE_ENGINE_FAILURES).toBe(3);
  });

  it('a page that cannot be rendered fails alone', async () => {
    const { source } = fakeSource([{ fail: 'broken image stream' }, {}]);
    const result = await recognizePdfPages(source, { engine: fakeEngines().factory });
    expect(result.pages.map(page => [page.status, page.error])).toEqual([['failed', 'broken image stream'], ['recognized', undefined]]);
  });

  it('wordsToTextItems marks every word as recognized text with an integer confidence', () => {
    const items: TextItem[] = wordsToTextItems([{ text: 'GND', x: 300, y: 600, width: 150, height: 60, confidence: 59.6, rotation: 1 }], 300 / 72, 4);
    expect(items).toEqual([{ str: 'GND', x: 72, y: 144, width: 36, height: 60 / (300 / 72), page: 4, source: 'ocr', confidence: 59 }]);
  });
});

// ------------------------------------------------------------------------------------------------ real pipeline
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
const engine = inProcessOcrEngine({
  core: require('tesseract.js-core/tesseract-core-simd-lstm.js') as TesseractCoreFactory,
  wasm: readFileSync(path.join(coreRoot, 'tesseract-core-simd-lstm.wasm')),
  data: new Uint8Array(readFileSync(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'))),
});

describe('recognizePdfPages on a synthetic scanned PDF (real engine)', () => {
  it('finds the drawn labels at their drawn positions; text pages and vector pages are left alone', async () => {
    const data = await buildSyntheticScan([
      { texts: [{ x: 30, y: 150, text: 'U7  R220  C14', size: 14 }, { x: 30, y: 60, text: 'VCC_3V3  GND', size: 14 }] },
      { texts: [{ x: 30, y: 120, text: 'Q12  L3  PP3V3_S5', size: 14 }], turn: 3, noise: 0.01 },
    ], { extra: [{ texts: [{ x: 72, y: 700, text: 'Already searchable R220' }] }, {}] });
    const handle = await openPdf(data);
    try {
      expect(await handle.getTextItems(1)).toEqual([]);
      expect(await handle.getPageImageCount(1)).toBe(1);
      expect(await handle.getPageImageCount(4)).toBe(0);
      const result = await recognizePdfPages(handle, { engine });
      expect(result.pages.map(page => [page.page, page.status])).toEqual([[1, 'recognized'], [2, 'recognized'], [3, 'has-text'], [4, 'no-image']]);
      const first = new Map(result.pages[0].items.map(item => [item.str, item]));
      for (const label of ['U7', 'R220', 'C14', 'VCC_3V3', 'GND']) expect(first.has(label), [...first.keys()].join(' ')).toBe(true);
      // "U7" is drawn at x = 30 pt with its baseline 150 pt above the bottom of a 200 pt page: top-left convention, Y down.
      const u7 = first.get('U7')!;
      expect(u7.x).toBeGreaterThan(27); expect(u7.x).toBeLessThan(36);
      expect(u7.y).toBeGreaterThan(36); expect(u7.y + u7.height).toBeLessThan(56);
      expect(u7.source).toBe('ocr');
      expect(u7.confidence).toBeGreaterThanOrEqual(80);
      // page 2 is the same kind of label block, scanned so that it reads bottom to top: found by the quarter-turn pass, tall boxes
      const second = result.pages[1].items.filter(item => ['Q12', 'L3', 'PP3V3_S5'].includes(item.str));
      expect(second.map(item => item.str).sort()).toEqual(['L3', 'PP3V3_S5', 'Q12']);
      for (const item of second) expect(item.height).toBeGreaterThan(item.width);
    } finally {
      await handle.destroy();
    }
  }, 120_000);
});
