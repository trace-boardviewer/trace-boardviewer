import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configurePdfResources } from '../pdf/worker';
import { openPdf } from '../pdf/document';
import type { PdfHandle } from '../pdf/document';
import { buildPdfFixture } from '../pdf/pdf-fixture';
import { OCR_LINK_MIN_CONFIDENCE, OcrError } from './contract';
import type { GrayImage } from './contract';
import { createRecognizer, gunzipIfNeeded } from './recognizer';
import type { Recognizer, TesseractCoreFactory } from './recognizer';
import { rotateGray } from './raster';

// The real engine in Node: the same Emscripten build and language data the app bundles, run in-process. Synthetic text is drawn
// by pdf.js (Helvetica from the bundled standard fonts) onto pdf.js' Node canvas, so every test image is generated here.
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
const core = require('tesseract.js-core/tesseract-core-simd-lstm.js') as TesseractCoreFactory;
const wasm = readFileSync(path.join(coreRoot, 'tesseract-core-simd-lstm.wasm'));
const engData = readFileSync(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'));

const LABELS = ['R101', 'C12', 'PU301', 'GND', 'VBUS', 'SW_EN', 'Q7'];
const labelPdf = buildPdfFixture({ pages: [{ width: 360, height: 160, texts: [
  { x: 20, y: 120, text: 'R101  C12  PU301', size: 16 },
  { x: 20, y: 70, text: 'GND  VBUS  SW_EN  Q7', size: 16 },
] }] });

let handle: PdfHandle;
let page: { image: GrayImage; scale: number };
let recognizer: Recognizer;
beforeAll(async () => {
  handle = await openPdf(labelPdf);
  page = await handle.renderPageGray(1, { dpi: 300, maxPixels: 40_000_000 });
  recognizer = await createRecognizer({ core, wasm, language: 'eng', data: engData });
}, 60_000);
afterAll(async () => { recognizer?.dispose(); await handle?.destroy(); });

describe('Tesseract engine core (in-process, synthetic rendered text)', () => {
  it('renders the synthetic page at 300 dpi as 8-bit grey', () => {
    expect(page.scale).toBeCloseTo(300 / 72, 2);
    expect([page.image.width, page.image.height]).toEqual([1500, 666]);
    let dark = 0;
    for (const value of page.image.data) if (value < 128) dark++;
    expect(dark).toBeGreaterThan(5_000);
  });

  it('reads every horizontal label with high confidence, at the right place', () => {
    const { words, passes } = recognizer.recognize(page.image, { dpi: 300, rotations: [0, 1] });
    expect(passes).toBe(2);
    const byText = new Map(words.map(word => [word.text, word]));
    for (const label of LABELS) {
      expect(byText.get(label), `${label} in ${words.map(w => w.text).join(' ')}`).toBeDefined();
      // a name joined at its underscore keeps the lower confidence of its two halves; every label still clears the link floor
      expect(byText.get(label)!.confidence, label).toBeGreaterThanOrEqual(label.includes('_') ? OCR_LINK_MIN_CONFIDENCE : 80);
      expect(byText.get(label)!.rotation).toBe(0);
    }
    // R101 is drawn at x=20 pt, baseline 120 pt from the bottom of a 160 pt page: its box starts near 20 pt and 24-40 pt from the top.
    const r101 = byText.get('R101')!;
    expect(r101.x / page.scale).toBeGreaterThan(17);
    expect(r101.x / page.scale).toBeLessThan(26);
    expect(r101.y / page.scale).toBeGreaterThan(20);
    expect((r101.y + r101.height) / page.scale).toBeLessThan(44);
  }, 60_000);

  it('reads labels that run bottom to top in the quarter-turn pass and maps their boxes back onto the page', () => {
    const upward = rotateGray(page.image, 3); // the whole label block now reads bottom to top
    const { words } = recognizer.recognize(upward, { dpi: 300, rotations: [0, 1] });
    const found = words.filter(word => LABELS.includes(word.text));
    expect(found.length).toBeGreaterThanOrEqual(LABELS.length - 1);
    for (const word of found) {
      expect(word.rotation).toBe(1);
      expect(word.height).toBeGreaterThan(word.width); // a tall box on the page
      expect(word.x + word.width).toBeLessThanOrEqual(upward.width);
      expect(word.y + word.height).toBeLessThanOrEqual(upward.height);
    }
    const onlyUpright = recognizer.recognize(upward, { dpi: 300, rotations: [0] }).words.filter(word => LABELS.includes(word.text));
    expect(onlyUpright.length).toBeLessThan(found.length);
  }, 60_000);

  it('a blank page has no words; malformed input is refused', () => {
    const blank: GrayImage = { width: 400, height: 300, data: new Uint8Array(400 * 300).fill(255) };
    expect(recognizer.recognize(blank, { dpi: 300, rotations: [0] }).words).toEqual([]);
    expect(() => recognizer.recognize({ width: 10, height: 10, data: new Uint8Array(5) }, { dpi: 300, rotations: [0] })).toThrow(OcrError);
    expect(() => recognizer.recognize(blank, { dpi: 0, rotations: [0] })).toThrow(/resolution/);
  }, 60_000);

  it('the language data is gzip-compressed and unpacks to the integer LSTM model', async () => {
    expect([engData[0], engData[1]]).toEqual([0x1f, 0x8b]);
    const raw = await gunzipIfNeeded(new Uint8Array(engData));
    expect(raw.length).toBeGreaterThan(4_000_000);
    const plain = new Uint8Array([1, 2, 3]);
    expect(await gunzipIfNeeded(plain)).toBe(plain);
  }, 30_000);

  it('a build that cannot be compiled makes the engine UNAVAILABLE instead of hanging', async () => {
    const broken = createRecognizer({ core, wasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 99]), language: 'eng', data: engData });
    await expect(broken).rejects.toMatchObject({ name: 'OcrError', code: 'UNAVAILABLE' });
  }, 30_000);
});
