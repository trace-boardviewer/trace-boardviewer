import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFWorker } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cameraToView, fitViewMode, sameCamera, viewToCamera } from '../lib/images';
import { setPdfWorkerFactory } from '../lib/pdf/document';
import { buildPdfFixture } from '../lib/pdf/pdf-fixture';
import { createPdfSession } from '../lib/pdf/session';
import { configurePdfResources } from '../lib/pdf/worker';
import { createWorkspaceController } from './controller';
import type { ControllerDeps } from './controller';
import type { DocumentRuntime } from './api';
import {
  T0, createBoardWorkers, createFakeDesktop, createHarness, createPdfSessions, createSchematicWorkers, dividerBoard, documentPayload, enc, hexKey, hit, openNative, seedWorkspace,
} from './testing';
import type { FakePdfSession, FakePdfSessions, Harness, SeedDocument } from './testing';

// Same Node setup as src/lib/pdf/session.test.ts: pdf.js runs with its fake worker from the legacy build.
const nodeRequire = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(nodeRequire.resolve('pdfjs-dist/package.json'));
const folder = (name: string) => `${path.join(pdfjsRoot, name).replace(/\\/g, '/')}/`;
configurePdfResources({
  workerSrc: pathToFileURL(path.join(pdfjsRoot, 'legacy', 'build', 'pdf.worker.mjs')).href,
  cMapUrl: folder('cmaps'), standardFontDataUrl: folder('standard_fonts'), wasmUrl: folder('wasm'), iccUrl: folder('iccs'),
});

const doc = (h: Harness, id: string): DocumentRuntime => h.state().documents.find(d => d.record.id === id)!;
const PDF: SeedDocument = { id: 'doc-pdf', path: '/boards/docs/service.pdf', kind: 'pdf', key: 42 };
const IMG: SeedDocument = { id: 'doc-img', path: '/boards/docs/photo.png', kind: 'image', key: 43 };

/** createHarness (src/app/testing.ts) with a custom PDF session factory: the shared one always starts sessions as `ready`. */
function harnessWith(make: (pdf: FakePdfSessions) => ControllerDeps['createPdfSession']): Harness {
  const desktop = createFakeDesktop();
  const boardWorkers = createBoardWorkers();
  const schematicWorkers = createSchematicWorkers();
  const pdf = createPdfSessions();
  const storage = new Map<string, string>();
  const clock = { now: T0 };
  let counter = 0;
  const controller = createWorkspaceController({
    desktop, createBoardWorker: boardWorkers.factory, createSchematicWorker: schematicWorkers.factory, createPdfSession: make(pdf),
    now: () => clock.now, newId: () => `id-${++counter}`, storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } }, saveDelayMs: 5,
  });
  const messages = () => controller.getSnapshot().notices.map(notice => ('text' in notice.message ? notice.message.text : 'key' in notice.message ? notice.message.key : 'issue'));
  return { controller, desktop, boardWorkers, schematicWorkers, pdf, storage, clock, files: [], pickQueue: [], pickHolds: [], state: controller.getSnapshot, messages };
}
/** Sessions that start in the `opening` state (what the real pdf.js session does) and are driven by the test through `update`. */
const openingHarness = () => harnessWith(pdf => options => { const session = pdf.create(options) as FakePdfSession; session.update({ status: 'opening', pageCount: 0 }); return session; });

describe('document camera fit (W-win-viewers-01 / W-fin-crossprobe-02)', () => {
  const fitted = { page: 2, zoom: 0.585, rotation: 0, x: 12, y: 34, fit: 'width' } as const;

  it('setCamera / cameraOf keep the fit mode of a document camera (fit-width is not turned into a manual zoom); an invalid fit is dropped', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF, IMG]);
    await openNative(h, 'a.cad', 1);
    const { setCamera, cameraOf } = h.controller.actions;
    for (const source of ['doc-pdf', 'doc-img']) {
      for (const fit of ['width', 'page', 'none'] as const) {
        setCamera(source, { ...fitted, fit });
        expect(cameraOf(source), `${source} ${fit}`).toEqual({ ...fitted, fit });
      }
    }
    setCamera('doc-pdf', { ...fitted, fit: 'sideways' as never });
    expect(cameraOf('doc-pdf')).toEqual({ page: 2, zoom: 0.585, rotation: 0, x: 12, y: 34 });
    setCamera('doc-pdf', { ...fitted });
    expect(h.state().manifest?.cameras['doc-pdf']).toEqual(fitted);
  });

  it('the image viewer had the same loss: its emitted camera comes back from the core as the same camera (echo recognised) and restores as a fitted view', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [IMG]);
    await openNative(h, 'a.cad', 1);
    const emitted = viewToCamera({ ...fitViewMode('page', 2000, 1000, 0, 800, 600), fit: 'page' });
    h.controller.actions.setCamera('doc-img', emitted);
    const stored = h.controller.actions.cameraOf('doc-img');
    expect(sameCamera(emitted, stored)).toBe(true); // a stored camera that lost its fit is "new" to the viewer and replaces the fitted view by a manual one
    const restored = cameraToView(stored, 2000, 1000, 1200, 700); // the pane has another size by now
    expect(restored.fit).toBe('page');
    expect(restored.scale).toBe(fitViewMode('page', 2000, 1000, 0, 1200, 700).scale);
    expect(cameraToView(h.controller.actions.cameraOf('doc-none'), 2000, 1000, 1200, 700).fit).toBe('page'); // no stored camera: fitted as well
  });

  it('the board camera stays free of a fit (it belongs to documents) and keeps its side', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    h.controller.actions.setCamera('board', { zoom: 3, x: 1, y: 2, rotation: 0, fit: 'width', side: 'bottom' } as never);
    expect(h.controller.actions.cameraOf('board')).toEqual({ zoom: 3, x: 1, y: 2, rotation: 0, side: 'bottom' });
  });

  it('a fit-width camera survives the workspace file: saved, the board closed and reopened (restart), it is still fit-width', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF]);
    await openNative(h, 'a.cad', 1);
    h.controller.actions.setCamera('doc-pdf', fitted);
    await h.controller.flush();
    expect(h.desktop.workspaces.get(hexKey(1))?.cameras['doc-pdf']).toEqual(fitted);
    await openNative(h, 'b.cad', 2);
    expect(h.controller.actions.cameraOf('doc-pdf')).toEqual({});
    await openNative(h, 'a.cad', 1);
    expect(h.controller.actions.cameraOf('doc-pdf')).toEqual(fitted);
  });

  it('a unified-search hit keeps the document at fit-width and only moves the page (W-fin-crossprobe-02)', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF]);
    await openNative(h, 'a.cad', 1, dividerBoard('a.cad'));
    h.controller.actions.setCamera('doc-pdf', { ...fitted, page: 1 });
    h.pdf.sessions[0].hits['R2'] = [hit(2, 9, 'see R2 here', { x: 11, y: 12, width: 13, height: 14 })];
    h.controller.actions.setSearchQuery('R2');
    await h.controller.idle();
    const row = h.state().search.result!.groups[4].rows[0];
    h.controller.actions.activateSearchRow(row);
    expect(h.state().activeTab).toBe('documents');
    expect(h.controller.actions.cameraOf('doc-pdf')).toMatchObject({ page: 2, fit: 'width' });
  });
});

describe('PDF readiness follows the pdf.js session (I06 / W-win-viewers-04)', () => {
  const rejected = { status: 'error', error: { code: 'INVALID_PDF', message: 'Invalid PDF structure.' } } as const;

  it('the row is loading while pdf.js opens the file and ready only after a successful open', async () => {
    const h = openingHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF]);
    await openNative(h, 'a.cad', 1);
    expect(doc(h, 'doc-pdf')).toMatchObject({ status: 'loading' });
    expect(doc(h, 'doc-pdf').pdf).toBeDefined();
    h.pdf.sessions[0].update({ status: 'ready', pageCount: 3 });
    expect(doc(h, 'doc-pdf')).toMatchObject({ status: 'ready' });
    expect(doc(h, 'doc-pdf').message).toBeUndefined();
  });

  it('a PDF that pdf.js rejects ends as error with the session message (never ready), also for a later failure', async () => {
    const h = openingHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF]);
    await openNative(h, 'a.cad', 1);
    h.pdf.sessions[0].update(rejected);
    expect(doc(h, 'doc-pdf')).toMatchObject({ status: 'error', message: 'Invalid PDF structure.' });
    expect(doc(h, 'doc-pdf').pdf).toBeDefined(); // the viewer keeps rendering its own error panel (code included) from the session
    const ready = createHarness();
    seedWorkspace(ready, 1, '/boards/a.cad', [PDF]);
    await openNative(ready, 'a.cad', 1);
    expect(doc(ready, 'doc-pdf').status).toBe('ready');
    ready.pdf.sessions[0].update(rejected);
    expect(doc(ready, 'doc-pdf')).toMatchObject({ status: 'error', message: 'Invalid PDF structure.' });
  });

  it('a password prompt stays ready (the viewer owns that interactive state) and the document becomes ready again once unlocked', async () => {
    const h = openingHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF]);
    await openNative(h, 'a.cad', 1);
    h.pdf.sessions[0].update({ status: 'password-required', error: { code: 'PASSWORD_REQUIRED', message: 'The PDF is password protected.' } });
    expect(doc(h, 'doc-pdf')).toMatchObject({ status: 'ready' });
    expect(doc(h, 'doc-pdf').message).toBeUndefined();
    h.pdf.sessions[0].update({ status: 'invalid-password', error: { code: 'INVALID_PASSWORD', message: 'The password is incorrect.' } });
    expect(doc(h, 'doc-pdf').status).toBe('ready');
    h.pdf.sessions[0].update({ status: 'ready', error: null, pageCount: 3 });
    expect(doc(h, 'doc-pdf').status).toBe('ready');
  });

  it('the unified search takes a PDF only once it is ready, and then searches it (status first, then the re-run)', async () => {
    const h = openingHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF]);
    await openNative(h, 'a.cad', 1, dividerBoard('a.cad'));
    const [session] = h.pdf.sessions;
    session.hits['R2'] = [hit(2, 9, 'see R2 here')];
    h.controller.actions.setSearchQuery('R2');
    await h.controller.idle();
    expect(session.searches).toEqual([]);
    session.update({ status: 'ready', pageCount: 3 });
    await h.controller.idle();
    expect(session.searches).toEqual(['R2']);
    expect(h.state().search.result?.groups[4].rows).toMatchObject([{ documentId: 'doc-pdf', page: 2 }]);
  });

  describe('real pdf.js (synthetic fixtures)', () => {
    const workers: PDFWorker[] = [];
    beforeEach(() => { workers.length = 0; setPdfWorkerFactory(() => { const worker = new PDFWorker({ verbosity: 0 }); workers.push(worker); return worker; }); });
    afterEach(() => { setPdfWorkerFactory(null); });

    // 27 bytes, original: the shape of the QA `broken.pdf` (a valid-looking header, no structure).
    const BROKEN = enc('%PDF-1.4\nbroken pdf fixture');
    const GOOD = buildPdfFixture({ pages: [{ texts: [{ x: 72, y: 700, text: 'R2 sense' }] }] });

    it('an invalid PDF ends as error (message from pdf.js) while a valid one becomes ready; the rows never claim ready for the broken file', async () => {
      expect(BROKEN.byteLength).toBe(27);
      const h = harnessWith(() => options => createPdfSession(options));
      seedWorkspace(h, 1, '/boards/a.cad', [{ id: 'doc-bad', path: '/boards/docs/broken.pdf', kind: 'pdf', key: 61 }, { id: 'doc-good', path: '/boards/docs/good.pdf', kind: 'pdf', key: 62 }]);
      h.desktop.docs.set('/boards/docs/broken.pdf', documentPayload('/boards/docs/broken.pdf', 'pdf', 61, { data: BROKEN }));
      h.desktop.docs.set('/boards/docs/good.pdf', documentPayload('/boards/docs/good.pdf', 'pdf', 62, { data: GOOD }));
      const seen = new Set<string>();
      h.controller.subscribe(() => { const bad = doc(h, 'doc-bad'); if (bad) seen.add(bad.status); });
      await openNative(h, 'a.cad', 1);
      await vi.waitFor(() => { expect(doc(h, 'doc-bad').status).toBe('error'); expect(doc(h, 'doc-good').status).toBe('ready'); }, { timeout: 20_000, interval: 25 });
      expect(doc(h, 'doc-bad').message).toMatch(/\S/);
      expect(doc(h, 'doc-bad').pdf?.getSnapshot()).toMatchObject({ status: 'error', error: { code: 'INVALID_PDF' } });
      expect(doc(h, 'doc-good').pdf?.getSnapshot().status).toBe('ready');
      expect(seen.has('ready')).toBe(false);
      await openNative(h, 'b.cad', 2); // retires the board: disposes both sessions and their workers
      await vi.waitFor(() => expect(workers.every(worker => worker.destroyed)).toBe(true), { timeout: 10_000 });
    }, 30_000);
  });
});
