import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { PDFWorker } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Board } from './types';
import { buildBoardIndex, resolvePdfRefHits } from './crossprobe';
import { configurePdfResources } from './pdf/worker';
import { buildPdfFixture } from './pdf/pdf-fixture';
import { createPdfSession } from './pdf/session';
import type { PdfSession, PdfSessionSnapshot } from './pdf/session-contract';
import { OcrResultCache } from './ocr/cache';
import type { OcrEngineFactory, OcrRecognizeOptions, OcrWord } from './ocr/contract';
import { setPdfWorkerFactory } from './pdf/document';

const require = createRequire(import.meta.url);
const pdfjsRoot = realpathSync(path.dirname(require.resolve('pdfjs-dist/package.json')));
const nodeCanvas = createRequire(path.join(pdfjsRoot, 'package.json'))('@napi-rs/canvas') as Record<string, unknown>;
for (const name of ['Path2D', 'DOMMatrix', 'ImageData'] as const) (globalThis as Record<string, unknown>)[name] ??= nodeCanvas[name];
const folder = (name: string) => `${path.join(pdfjsRoot, name).replace(/\\/g, '/')}/`;
configurePdfResources({
  workerSrc: pathToFileURL(path.join(pdfjsRoot, 'legacy', 'build', 'pdf.worker.mjs')).href,
  cMapUrl: folder('cmaps'), standardFontDataUrl: folder('standard_fonts'), wasmUrl: folder('wasm'), iccUrl: folder('iccs'),
});

const sessions: PdfSession[] = [];
const workers: PDFWorker[] = [];
const waitFor = (session: PdfSession, predicate: (snapshot: PdfSessionSnapshot) => boolean) => new Promise<PdfSessionSnapshot>(resolve => {
  let unsubscribe = () => {};
  const check = () => {
    const snapshot = session.getSnapshot();
    if (predicate(snapshot)) { unsubscribe(); resolve(snapshot); }
  };
  unsubscribe = session.subscribe(check);
  check();
});

const board = (): Board => ({
  name: 'synthetic', format: 'test', units: 'mm',
  components: [{ id: 'u7', ref: 'U7', value: '', package: '', side: 'top', bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, position: { x: 0, y: 0 }, rotation: 0, pinIds: [], outline: [] }],
  pins: [], nets: [], outline: [], bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, warnings: [],
});

function engine(words: OcrWord[]): OcrEngineFactory {
  return async ({ language }) => ({
    language,
    disposed: false,
    async recognize(_image, _options: OcrRecognizeOptions) { return words; },
    dispose() {},
  });
}

const pdf = buildPdfFixture({ pages: [{ image: true }] });

describe('stable document session regressions', () => {
  beforeEach(() => {
    workers.length = 0;
    setPdfWorkerFactory(() => { const worker = new PDFWorker({ verbosity: 0 }); workers.push(worker); return worker; });
  });

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map(session => session.dispose()));
    setPdfWorkerFactory(null);
  });

  it('keeps an OCR reference searchable and cross-probeable after indexing, cache restore, and session teardown', async () => {
    const cache = new OcrResultCache();
    const recognition = engine([
      { text: 'U7', x: 80, y: 100, width: 24, height: 16, confidence: 94, rotation: 0 },
      { text: 'U77', x: 130, y: 100, width: 36, height: 16, confidence: 91, rotation: 0 },
    ]);
    const first = createPdfSession({ id: 'first', data: pdf, ocr: { engine: recognition, cache } });
    sessions.push(first);
    await waitFor(first, snapshot => snapshot.status === 'ready' && snapshot.searchable !== null);
    expect(first.getSnapshot().searchable).toBe(false);
    await first.ensureIndex(); // Build the native text index before OCR adds its separate recognized-text revision.
    await first.recognizeText();

    const refs = new Set(['U7']);
    const firstCandidates = await first.refCandidates(refs, new Set());
    expect(firstCandidates.candidates.map(candidate => candidate.name)).toEqual(['U7']); // U7 is not a substring match inside U77.
    expect((await first.find('U7')).map(hit => hit.source)).toEqual(['ocr', 'ocr']);
    expect(resolvePdfRefHits(firstCandidates, buildBoardIndex(board()), { documentId: 'first' }).links).toMatchObject([
      { name: 'U7', status: 'unique', targets: [{ kind: 'component', ref: 'U7' }], hitsTotal: 1 },
    ]);
    expect(workers.filter(worker => !worker.destroyed)).toHaveLength(1);
    await first.dispose();
    expect(workers.filter(worker => !worker.destroyed)).toHaveLength(0);

    const shouldNotRecognize: OcrEngineFactory = async () => { throw new Error('cached OCR should not start the engine'); };
    const reopened = createPdfSession({ id: 'reopened', data: pdf.slice(), ocr: { engine: shouldNotRecognize, cache } });
    sessions.push(reopened);
    const restored = await waitFor(reopened, snapshot => snapshot.ocr.recognizedPages === 1);
    expect(restored.status).toBe('ready');
    const restoredCandidates = await reopened.refCandidates(refs, new Set());
    expect(restoredCandidates).toEqual(firstCandidates);
    expect(resolvePdfRefHits(restoredCandidates, buildBoardIndex(board()), { documentId: 'reopened' }).links[0]).toMatchObject({ status: 'unique', hitsTotal: 1 });
    await reopened.dispose();
    expect(workers.filter(worker => !worker.destroyed)).toHaveLength(0);
  });
});
