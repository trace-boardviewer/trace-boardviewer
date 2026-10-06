import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFWorker } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configurePdfResources } from './worker';
import { PdfError, setPdfWorkerFactory } from './document';
import type { OutlineEntry, openPdf, PdfHandle, TextItem } from './document';
import { buildPdfFixture, rc4Encryption } from './pdf-fixture';
import { DEFAULT_SESSION_MAX_INDEX_ITEMS, createPdfSession, samplePageNumbers } from './session';
import type { PdfSessionHooks } from './session';
import type { PdfSession, PdfSessionSnapshot } from './session-contract';

// Same Node setup as document.test.ts: fake worker from the legacy build, plain-path resource folders.
const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const folder = (name: string) => `${path.join(pdfjsRoot, name).replace(/\\/g, '/')}/`;
configurePdfResources({
  workerSrc: pathToFileURL(path.join(pdfjsRoot, 'legacy', 'build', 'pdf.worker.mjs')).href,
  cMapUrl: folder('cmaps'), standardFontDataUrl: folder('standard_fonts'), wasmUrl: folder('wasm'), iccUrl: folder('iccs'),
});

const failure = async (promise: Promise<unknown>): Promise<PdfError> => {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(PdfError); return error as PdfError; }
  throw new Error('expected rejection');
};
const textPage = {
  texts: [
    { x: 72, y: 700, text: 'PU301' }, { x: 200, y: 700, text: 'GND' }, { x: 300, y: 700, text: '3.3V' },
    { x: 72, y: 650, text: 'PU301 GND 3.3V' },
    { x: 72, y: 600, text: 'PU3011 drives (PU301) from +3.3V; see PU301.' },
    { x: 72, y: 560, text: 'R12 C7 D+/D-' },
  ],
};
const vectorPdf = buildPdfFixture({ pages: [textPage], outline: [{ title: 'Power', page: 1 }] });
const scanPdf = buildPdfFixture({ pages: [{ image: true }] });
const mixedPdf = buildPdfFixture({ pages: [textPage, { image: true }] });
const encryptedPdf = buildPdfFixture({ pages: [textPage], encryption: rc4Encryption('secret') });
const invalidPdf = new TextEncoder().encode('%PDF-1.4\nthis is not a pdf');

function until(session: PdfSession, predicate: (snapshot: PdfSessionSnapshot) => boolean): Promise<PdfSessionSnapshot> {
  return new Promise(resolve => {
    let unsubscribe = () => {};
    const check = () => { const snapshot = session.getSnapshot(); if (predicate(snapshot)) { unsubscribe(); resolve(snapshot); } };
    unsubscribe = session.subscribe(check);
    check();
  });
}
const deferred = <T = void>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// Every pdf.js worker the real layer starts is recorded: a session must never leave one alive after dispose.
const workers: PDFWorker[] = [];
const live = () => workers.filter(worker => !worker.destroyed).length;
const sessions: PdfSession[] = [];
const track = (session: PdfSession) => { sessions.push(session); return session; };
beforeEach(() => {
  workers.length = 0;
  setPdfWorkerFactory(() => { const worker = new PDFWorker({ verbosity: 0 }); workers.push(worker); return worker; });
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  setPdfWorkerFactory(null);
});

describe('PdfSession over real PDFs', () => {
  it('publishes stable snapshots and exposes the handle only once ready', async () => {
    const session = track(createPdfSession({ id: 'doc-1', data: vectorPdf }));
    expect(session.id).toBe('doc-1');
    expect(session.getSnapshot()).toBe(session.getSnapshot());
    expect(session.getSnapshot()).toMatchObject({ status: 'opening', error: null, pageCount: 0, searchable: null, index: { state: 'idle' }, outline: [] });
    expect(session.getHandle()).toBeNull();
    const seen: PdfSessionSnapshot[] = [];
    session.subscribe(() => seen.push(session.getSnapshot()));
    const ready = await until(session, snapshot => snapshot.status === 'ready' && snapshot.searchable !== null && snapshot.outline.length > 0);
    expect(ready).toMatchObject({ status: 'ready', error: null, pageCount: 1, searchable: true, outline: [{ title: 'Power', page: 1, depth: 0 }] });
    expect(session.getSnapshot()).toBe(ready);
    expect(new Set(seen).size).toBe(seen.length); // a notification always comes with a NEW snapshot object
    expect(seen.every((snapshot, i) => i === 0 || snapshot !== seen[i - 1])).toBe(true);
    const handle = session.getHandle()!;
    expect(handle.pageCount).toBe(1);
    expect((await handle.getTextItems(1)).length).toBeGreaterThan(3);
    expect(Object.isFrozen(ready)).toBe(true);
  });

  it('builds the index lazily and once, and serves find and exact reference candidates from it', async () => {
    const session = track(createPdfSession({ id: 'doc', data: vectorPdf }));
    await until(session, snapshot => snapshot.status === 'ready');
    expect(session.getSnapshot().index.state).toBe('idle');
    expect(await session.find('')).toEqual([]);
    expect(await session.find('   ')).toEqual([]);
    expect(session.getSnapshot().index.state).toBe('idle'); // an empty query must not start indexing
    expect(await session.refCandidates(new Set(), new Set())).toEqual({ candidates: [], truncated: false, totalHits: 0 });
    expect(session.getSnapshot().index.state).toBe('idle');

    const [first, second] = [session.ensureIndex(), session.ensureIndex()];
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(await session.ensureIndex()).toBe(a);
    expect(a.truncated).toBe(false);
    expect(session.getSnapshot().index).toEqual({ state: 'done', indexedPages: 1, pageCount: 1, items: a.items.length });

    expect((await session.find('pu301')).length).toBe(5);
    expect((await session.find('pu301')).map(hit => hit.token)).toContain('PU301');
    expect((await session.find('PU301', { wholeWord: true, caseSensitive: true })).length).toBe(4);
    const result = await session.refCandidates(new Set(['PU301', 'PU30', 'R12']), new Set(['GND', 'VCC', 'D+/D-']));
    const byName = new Map(result.candidates.map(candidate => [candidate.name, candidate]));
    expect(result).toMatchObject({ truncated: false, totalHits: 4 + 1 + 2 + 1 });
    expect(byName.get('PU301')!.hits.length).toBe(4);
    expect(byName.get('PU301')!.hits.map(hit => hit.token).sort()).toEqual(['PU301', 'PU301', 'PU301', 'PU301.']); // literal text: the sentence-final period is kept
    expect(byName.has('PU30')).toBe(false); // never partial
    expect(byName.has('VCC')).toBe(false);
    expect(byName.get('GND')!.kind).toBe('net');
    const capped = await session.refCandidates(new Set(['PU301']), new Set(['GND']), { maxTotalHits: 3 });
    expect(capped).toMatchObject({ truncated: true, totalHits: 3 });
  });

  it('starts indexing on demand from find() even before the document finished opening', async () => {
    const session = track(createPdfSession({ id: 'doc', data: vectorPdf }));
    expect((await session.find('GND')).length).toBe(2);
    expect(session.getSnapshot()).toMatchObject({ status: 'ready', index: { state: 'done' } });
  });

  it('stops waiting when the caller aborts, without cancelling the shared index build', async () => {
    const session = track(createPdfSession({ id: 'doc', data: mixedPdf }));
    const controller = new AbortController();
    const waiting = session.find('PU301', { signal: controller.signal });
    controller.abort();
    expect((await failure(waiting)).code).toBe('ABORTED');
    expect((await failure(session.find('x', { signal: controller.signal }))).code).toBe('ABORTED');
    expect((await failure(session.refCandidates(new Set(['x']), new Set(), { signal: controller.signal }))).code).toBe('ABORTED');
    const index = await session.ensureIndex(); // the build kept going and is reusable
    expect(index.items.length).toBeGreaterThan(0);
    expect(session.getSnapshot().index.state).toBe('done');
  });

  it('reports scan-only documents as not searchable and keeps find honest', async () => {
    const session = track(createPdfSession({ id: 'scan', data: scanPdf }));
    const snapshot = await until(session, current => current.searchable !== null);
    expect(snapshot).toMatchObject({ status: 'ready', searchable: false, pageCount: 1 });
    expect(await session.find('PU301')).toEqual([]);
    expect(session.getSnapshot()).toMatchObject({ searchable: false, index: { state: 'done', items: 0 } });
    expect(await session.refCandidates(new Set(['PU301']), new Set())).toMatchObject({ candidates: [], truncated: false, totalHits: 0 });
    const mixed = track(createPdfSession({ id: 'mixed', data: mixedPdf }));
    expect((await until(mixed, current => current.searchable !== null)).searchable).toBe(true);
  });

  it('corrects a provisional "not searchable" verdict once the full index finds text beyond the sampled pages', async () => {
    const pages = Array.from({ length: 40 }, (_, i) => (i === 19 ? { texts: [{ x: 72, y: 700, text: 'PU301' }] } : { image: true }));
    const session = track(createPdfSession({ id: 'late-text', data: buildPdfFixture({ pages }) }));
    expect(samplePageNumbers(40, 6)).not.toContain(20);
    expect((await until(session, current => current.searchable !== null)).searchable).toBe(false);
    expect((await session.find('pu301')).map(hit => hit.page)).toEqual([20]);
    expect(session.getSnapshot().searchable).toBe(true);
  });

  it('asks for a password, rejects wrong ones and opens with the right one without leaking workers', async () => {
    const session = track(createPdfSession({ id: 'enc', data: encryptedPdf }));
    const locked = await until(session, snapshot => snapshot.status !== 'opening');
    expect(locked).toMatchObject({ status: 'password-required', error: { code: 'PASSWORD_REQUIRED' } });
    expect(session.getHandle()).toBeNull();
    expect((await failure(session.find('PU301'))).code).toBe('PASSWORD_REQUIRED');
    expect(live()).toBe(0);

    expect((await failure(session.submitPassword('wrong'))).code).toBe('INVALID_PASSWORD');
    expect(session.getSnapshot()).toMatchObject({ status: 'invalid-password', error: { code: 'INVALID_PASSWORD' } });
    expect((await failure(session.submitPassword(''))).code).toBe('INVALID_PASSWORD'); // an empty password is a wrong password
    expect(session.getSnapshot().status).toBe('invalid-password');
    expect(live()).toBe(0);

    await session.submitPassword('secret');
    expect(session.getSnapshot()).toMatchObject({ status: 'ready', error: null, pageCount: 1 });
    expect(live()).toBe(1);
    expect((await session.find('GND')).length).toBe(2);
    await session.submitPassword('anything'); // already open: nothing to do, no second worker
    expect(live()).toBe(1);
    await session.dispose();
    expect(live()).toBe(0);
  });

  it('opens an encrypted document directly when the right password is given up front', async () => {
    const session = track(createPdfSession({ id: 'enc', data: encryptedPdf, password: 'secret' }));
    expect((await until(session, snapshot => snapshot.status !== 'opening')).status).toBe('ready');
    const wrong = track(createPdfSession({ id: 'enc2', data: encryptedPdf, password: 'nope' }));
    expect((await until(wrong, snapshot => snapshot.status !== 'opening'))).toMatchObject({ status: 'invalid-password', error: { code: 'INVALID_PASSWORD' } });
  });

  it('lets the latest password attempt win when attempts overlap', async () => {
    const session = track(createPdfSession({ id: 'enc', data: encryptedPdf }));
    await until(session, snapshot => snapshot.status === 'password-required');
    const stale = session.submitPassword('wrong');
    const latest = session.submitPassword('secret');
    expect((await failure(stale)).code).toBe('ABORTED');
    await latest;
    expect(session.getSnapshot().status).toBe('ready');
    expect(live()).toBe(1);
  });

  it('turns unreadable input and the page limit into terminal error states with every worker destroyed', async () => {
    const broken = track(createPdfSession({ id: 'bad', data: invalidPdf }));
    expect(await until(broken, snapshot => snapshot.status !== 'opening')).toMatchObject({ status: 'error', error: { code: 'INVALID_PDF' }, pageCount: 0 });
    expect(broken.getHandle()).toBeNull();
    expect((await failure(broken.submitPassword('x'))).code).toBe('INVALID_PDF');
    expect((await failure(broken.ensureIndex())).code).toBe('INVALID_PDF');
    const limited = track(createPdfSession({ id: 'big', data: mixedPdf, maxPages: 1 }));
    expect(await until(limited, snapshot => snapshot.status !== 'opening')).toMatchObject({ status: 'error', error: { code: 'LIMIT_EXCEEDED' } });
    expect(live()).toBe(0);
  });

  it('dispose() is idempotent, closes the session and destroys the worker', async () => {
    const session = track(createPdfSession({ id: 'doc', data: vectorPdf }));
    await until(session, snapshot => snapshot.status === 'ready');
    await session.ensureIndex();
    expect(live()).toBe(1);
    const notified: PdfSessionSnapshot[] = [];
    session.subscribe(() => notified.push(session.getSnapshot()));
    const [a, b] = [session.dispose(), session.dispose()];
    expect(a).toBe(b);
    await Promise.all([a, b]);
    await session.dispose();
    expect(live()).toBe(0);
    expect(session.getSnapshot()).toMatchObject({ status: 'closed', error: null, outline: [] });
    expect(notified.at(-1)?.status).toBe('closed');
    expect(session.getHandle()).toBeNull();
    expect((await failure(session.find('PU301'))).code).toBe('DESTROYED');
    expect((await failure(session.ensureIndex())).code).toBe('DESTROYED');
    expect((await failure(session.refCandidates(new Set(['PU301']), new Set()))).code).toBe('DESTROYED');
    expect((await failure(session.submitPassword('x'))).code).toBe('DESTROYED');
    const later = session.subscribe(() => notified.push(session.getSnapshot()));
    later();
    expect(notified.at(-1)?.status).toBe('closed');
  });

  it('dispose() mid-open destroys the loading task and its worker before it resolves', async () => {
    const session = createPdfSession({ id: 'doc', data: vectorPdf });
    await session.dispose(); // synchronously after creation: the open is still in flight
    expect(session.getSnapshot().status).toBe('closed');
    expect(live()).toBe(0);
    const password = createPdfSession({ id: 'enc', data: encryptedPdf });
    await until(password, snapshot => snapshot.status === 'password-required');
    const pending = password.submitPassword('secret');
    await password.dispose();
    expect(['ABORTED', 'DESTROYED']).toContain((await failure(pending)).code);
    expect(live()).toBe(0);
  });

  it('keeps unsubscribed listeners quiet and isolates subscribers from each other', async () => {
    const session = track(createPdfSession({ id: 'doc', data: vectorPdf }));
    let kept = 0, dropped = 0;
    session.subscribe(() => { kept++; });
    const unsubscribe = session.subscribe(() => { dropped++; });
    unsubscribe();
    unsubscribe();
    await until(session, snapshot => snapshot.status === 'ready');
    expect(kept).toBeGreaterThan(0);
    expect(dropped).toBe(0);
  });
});

describe('PdfSession with a controllable pdf layer', () => {
  const item = (str: string, page: number): TextItem => ({ str, x: 0, y: 0, width: 6 * str.length, height: 10, page });
  interface FakeSpec { pages: number; perPage?: number; text?: (page: number, index: number) => string; outline?: 'fail' | OutlineEntry[]; gate?: Promise<void>; pageGate?: (page: number) => Promise<void> | undefined }
  function fake(spec: FakeSpec) {
    const stats = { opens: 0, destroyed: 0, textCalls: [] as number[] };
    const release = deferred();
    const handle: PdfHandle = {
      pageCount: spec.pages,
      getPageSize: async () => ({ width: 100, height: 100, rotation: 0 }),
      renderPage: async () => {},
      async getTextItems(page) {
        stats.textCalls.push(page);
        await Promise.race([spec.pageGate?.(page), release.promise.then(() => { throw new PdfError('DESTROYED', 'closed'); })]);
        return Array.from({ length: spec.perPage ?? 2 }, (_, i) => item(spec.text?.(page, i) ?? `R${page}${String.fromCharCode(65 + i)}`, page));
      },
      async getOutline() { if (spec.outline === 'fail') throw new Error('broken outline'); return spec.outline ?? []; },
      async destroy() { stats.destroyed++; release.resolve(); },
    };
    const open: typeof openPdf = async (_data, options) => {
      stats.opens++;
      const cancelled = new Promise<never>((_, reject) => { options?.signal?.addEventListener('abort', () => reject(new PdfError('ABORTED', 'cancelled')), { once: true }); });
      await Promise.race([spec.gate, cancelled]);
      if (options?.signal?.aborted) throw new PdfError('ABORTED', 'cancelled');
      return handle;
    };
    return { open, handle, stats };
  }
  const bytes = new Uint8Array([1, 2, 3]);
  const create = (spec: FakeSpec, extra: Partial<Parameters<typeof createPdfSession>[0]> = {}, hooks: PdfSessionHooks = {}) => {
    const double = fake(spec);
    return { ...double, session: track(createPdfSession({ id: 'fake', data: bytes, ...extra }, { open: double.open, ...hooks })) };
  };

  it('throttles index progress: a 1000-page build produces a handful of snapshots, not one per page', async () => {
    let clock = 0;
    const { session } = create({ pages: 1000, perPage: 3 }, {}, { now: () => clock++, progressIntervalMs: 100 });
    await until(session, snapshot => snapshot.status === 'ready');
    let notifications = 0;
    const progress: number[] = [];
    session.subscribe(() => { notifications++; progress.push(session.getSnapshot().index.indexedPages); });
    const index = await session.ensureIndex();
    expect(index.items.length).toBe(3000);
    expect(session.getSnapshot().index).toEqual({ state: 'done', indexedPages: 1000, pageCount: 1000, items: 3000 });
    expect(notifications).toBeGreaterThanOrEqual(5);
    expect(notifications).toBeLessThan(30);
    expect(progress.every((value, i) => i === 0 || value >= progress[i - 1])).toBe(true);
  });

  it('bounds the index by maxIndexItems and says so', async () => {
    const { session } = create({ pages: 10, perPage: 10 }, { maxIndexItems: 25 });
    const index = await session.ensureIndex();
    expect(index).toMatchObject({ truncated: true, indexedPages: 3 });
    expect(index.items.length).toBe(25);
    expect(session.getSnapshot().index).toEqual({ state: 'truncated', indexedPages: 3, pageCount: 10, items: 25 });
    const result = await session.refCandidates(new Set(['R1A']), new Set());
    expect(result).toMatchObject({ truncated: true, totalHits: 1 }); // exact for what was indexed, but disclosed as incomplete
    expect(DEFAULT_SESSION_MAX_INDEX_ITEMS).toBeLessThan(2_000_000);
  });

  it('discloses unreadable pages instead of failing the whole index', async () => {
    const double = fake({ pages: 3 });
    const original = double.handle.getTextItems.bind(double.handle);
    double.handle.getTextItems = async page => { if (page === 2) throw new Error('broken page tree'); return original(page); };
    const session = track(createPdfSession({ id: 'f', data: bytes }, { open: double.open }));
    const index = await session.ensureIndex();
    expect(index).toMatchObject({ failedPages: 1, truncated: true });
    expect(session.getSnapshot().index.state).toBe('truncated');
    expect((await session.find('R3A')).length).toBe(1);
  });

  it('treats a failing outline as non-fatal', async () => {
    const { session, stats } = create({ pages: 2, outline: 'fail' });
    await until(session, snapshot => snapshot.status === 'ready' && snapshot.searchable !== null);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(session.getSnapshot()).toMatchObject({ status: 'ready', error: null, outline: [] });
    expect(stats.destroyed).toBe(0);
  });

  it('loads the outline and samples text before any search', async () => {
    const outline: OutlineEntry[] = [{ title: 'A', page: 1, depth: 0 }];
    const { session, stats } = create({ pages: 50, outline });
    const snapshot = await until(session, current => current.searchable !== null && current.outline.length > 0);
    expect(snapshot.outline).toEqual(outline);
    expect(snapshot.searchable).toBe(true);
    expect(stats.textCalls).toEqual([1]); // text on the first page ends the probe: no needless reads
    expect(samplePageNumbers(1, 6)).toEqual([1]);
    expect(samplePageNumbers(3, 6)).toEqual([1, 2, 3]);
    expect(samplePageNumbers(6, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(samplePageNumbers(100, 6)).toEqual([1, 2, 3, 36, 68, 100]);
  });

  it('keeps a reference scan over 400k punctuation-only items interruptible and exact for a real token (B35 follow-up)', async () => {
    const planted = (page: number, i: number) => (page === 123 && i === 456 ? 'see PU301' : '( ) , ; : [ ] { } < > " | =');
    const { session } = create({ pages: 400, perPage: 1000, text: planted });
    await session.ensureIndex();
    expect(session.getSnapshot().index).toMatchObject({ state: 'done', items: 400_000 });
    const exact = await session.refCandidates(new Set(['PU301']), new Set());
    expect(exact).toMatchObject({ truncated: false, totalHits: 1 });
    expect(exact.candidates[0].hits[0].page).toBe(123);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0); // queued: it can only run if the scan yields to the event loop
    expect((await failure(session.refCandidates(new Set(['PU301']), new Set(['GND']), { signal: controller.signal }))).code).toBe('ABORTED');
    expect(session.getSnapshot().status).toBe('ready'); // an aborted query never harms the session
    expect((await session.refCandidates(new Set(['PU301']), new Set())).totalHits).toBe(1);
  });

  it('dispose() mid-index cancels the build, rejects waiters and destroys the handle', async () => {
    const stall = deferred();
    const { session, stats } = create({ pages: 5, pageGate: page => (page === 2 ? stall.promise : undefined) });
    await until(session, snapshot => snapshot.status === 'ready');
    const indexing = session.ensureIndex();
    const searching = session.find('R');
    await until(session, snapshot => snapshot.index.state === 'building');
    while (!stats.textCalls.includes(2)) await new Promise(resolve => setTimeout(resolve, 1));
    await session.dispose();
    expect(['ABORTED', 'DESTROYED']).toContain((await failure(indexing)).code);
    expect(['ABORTED', 'DESTROYED']).toContain((await failure(searching)).code);
    expect(session.getSnapshot()).toMatchObject({ status: 'closed', index: { state: 'cancelled' } });
    expect(stats.destroyed).toBe(1);
    await session.dispose();
    expect(stats.destroyed).toBe(1);
  });

  it('dispose() mid-open aborts the open, never publishes ready and destroys a handle that arrives late', async () => {
    const gate = deferred();
    const { session, stats } = create({ pages: 2, gate: gate.promise });
    const ready: string[] = [];
    session.subscribe(() => ready.push(session.getSnapshot().status));
    await session.dispose();
    gate.resolve();
    expect(ready).toEqual(['closed']);
    expect(stats.opens).toBe(1);
    expect(session.getHandle()).toBeNull();

    // A handle that was produced just as the dispose happened must still be closed.
    const late = deferred();
    const double = fake({ pages: 1 });
    const slow: typeof openPdf = async () => { await late.promise; return double.handle; };
    const racing = track(createPdfSession({ id: 'late', data: bytes }, { open: slow }));
    const disposing = racing.dispose();
    late.resolve();
    await disposing;
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(double.stats.destroyed).toBe(1);
    expect(racing.getSnapshot().status).toBe('closed');
  });

  it('rejects calls that wait for an opening session when it turns out to need a password', async () => {
    const gate = deferred();
    const double = fake({ pages: 1, gate: gate.promise });
    const open: typeof openPdf = async (data, options) => { await double.open(data, options); throw new PdfError('PASSWORD_REQUIRED', 'No password given'); };
    const session = track(createPdfSession({ id: 'p', data: bytes }, { open }));
    const search = session.find('x');
    const index = session.ensureIndex();
    gate.resolve();
    expect((await failure(search)).code).toBe('PASSWORD_REQUIRED');
    expect((await failure(index)).code).toBe('PASSWORD_REQUIRED');
    expect(session.getSnapshot()).toMatchObject({ status: 'password-required', index: { state: 'idle' } });
  });

  it('retries a failed index build on the next call and only keeps the bounded index afterwards', async () => {
    let failOnce = true;
    const double = fake({ pages: 3 });
    const original = double.handle.getTextItems.bind(double.handle);
    double.handle.getTextItems = async page => { if (failOnce && page === 2) { failOnce = false; throw new PdfError('INVALID_PDF', 'transient'); } return original(page); };
    const session = track(createPdfSession({ id: 'r', data: bytes }, { open: double.open }));
    expect((await failure(session.ensureIndex())).code).toBe('INVALID_PDF');
    expect(session.getSnapshot().index.state).toBe('error');
    const index = await session.ensureIndex();
    expect(index.items.length).toBe(6);
    expect(session.getSnapshot().index.state).toBe('done');
  });

  it('does not reopen a document that is already open or retry bytes it no longer needs', async () => {
    const { session, stats } = create({ pages: 1 });
    await until(session, snapshot => snapshot.status === 'ready');
    await session.submitPassword('ignored');
    await session.submitPassword('ignored');
    expect(stats.opens).toBe(1);
  });
});
