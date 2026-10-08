import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceApi } from '../app/api';
import { createHarness, dividerBoard, openNative, seedWorkspace } from '../app/testing';
import type { Harness } from '../app/testing';
import type { PdfHandle } from '../lib/pdf/document';
import type { PdfSession, PdfSessionSnapshot } from '../lib/pdf/session-contract';
import { PdfViewer } from './PdfViewer';
import type { PdfViewerProps, ViewerCamera } from './viewer-contracts';
import { DocumentViewer } from './workspace/DocumentViewer';

/**
 * No DOM here (the project has no jsdom): the viewers are rendered on the server, which runs every `useState` initializer. That is exactly
 * the "mount / remount" state of the PDF viewer, i.e. what a stored camera restores before any measurement. Without a measured viewport a
 * fitted zoom is the fallback 1 while a manual zoom is the stored number, which is how the two modes tell apart in the markup.
 */
const READY: PdfSessionSnapshot = {
  status: 'ready', error: null, pageCount: 3, searchable: true, index: { state: 'idle', indexedPages: 0, pageCount: 3, items: 0 }, outline: [],
  ocr: { state: 'unavailable', totalPages: 0, processedPages: 0, currentPage: 0, recognizedPages: 0, words: 0, failedPages: 0, revision: 0, error: null },
};
function fakeSession(snapshot: PdfSessionSnapshot = READY): PdfSession {
  const handle = {
    pageCount: snapshot.pageCount, getPageSize: async () => ({ width: 612, height: 792, rotation: 0 }), renderPage: async () => {}, getTextItems: async () => [], getOutline: async () => [], destroy: async () => {},
  } as PdfHandle;
  return {
    id: 'doc-pdf', getSnapshot: () => snapshot, subscribe: () => () => {}, submitPassword: async () => {}, getHandle: () => (snapshot.status === 'ready' ? handle : null),
    ensureIndex: async () => { throw new Error('not used'); }, find: async () => [], refCandidates: async () => ({ candidates: [], truncated: false, totalHits: 0 }), dispose: async () => {},
    inspectPage: async () => 'text', getRecognizedText: () => null, recognizeText: async () => {}, cancelRecognition: () => {},
  } as PdfSession;
}
function viewerMarkup(camera: ViewerCamera, snapshot?: PdfSessionSnapshot): string {
  const props: PdfViewerProps = {
    session: fakeSession(snapshot), camera, onCameraChange: () => {}, theme: 'dark', motion: false, compact: false, bookmarks: [], annotations: [],
    onBookmarksChange: () => {}, onAnnotationsChange: () => {}, searchQuery: '', onSearchQueryChange: () => {},
  };
  return renderToStaticMarkup(createElement(PdfViewer, props));
}
const attr = (markup: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(markup)?.[1];

// The first render reads `window.devicePixelRatio`; node has no window.
beforeAll(() => { Object.defineProperty(globalThis, 'window', { value: { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) }, configurable: true, writable: true }); });
afterAll(() => { Reflect.deleteProperty(globalThis, 'window'); });

describe('PdfViewer restores the stored fit mode before the stored zoom (W-win-viewers-01)', () => {
  it('a stored { fit: width, zoom: 0.585 } mounts as fit-width, not as a frozen manual zoom', () => {
    const markup = viewerMarkup({ page: 2, fit: 'width', zoom: 0.585, rotation: 0, x: 4, y: 5 });
    expect(attr(markup, 'data-fit')).toBe('width');
    expect(attr(markup, 'data-zoom')).toBe('1'); // derived from the (not yet measured) viewport, the stored 0.585 is not used
    expect(attr(markup, 'data-page')).toBe('2');
  });

  it('page fit and no stored camera mount fitted; a manual camera keeps its zoom', () => {
    expect(attr(viewerMarkup({ fit: 'page', zoom: 0.4 }), 'data-fit')).toBe('page');
    expect(attr(viewerMarkup({}), 'data-fit')).toBe('width');
    const manual = viewerMarkup({ fit: 'none', zoom: 1.75 });
    expect(attr(manual, 'data-fit')).toBe('none');
    expect(attr(manual, 'data-zoom')).toBe('1.75');
  });

  it('a camera without a fit (a workspace written before the fit was stored) is a manual view, as before', () => {
    const legacy = viewerMarkup({ page: 1, zoom: 0.585 });
    expect(attr(legacy, 'data-fit')).toBe('none');
    expect(attr(legacy, 'data-zoom')).toBe('0.585');
  });

  it('every remount of the viewer from the persisted camera of the core keeps the mode (tab switch, row switch, restart)', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [{ id: 'doc-pdf', path: '/boards/docs/service.pdf', kind: 'pdf', key: 42 }]);
    await openNative(h, 'a.cad', 1);
    // What the viewer emits at fit-width on a 1440 px wide window (src/components/PdfViewer.tsx computeCamera): the mode travels with the numbers.
    h.controller.actions.setCamera('doc-pdf', { page: 1, zoom: 0.585, rotation: 0, x: 0, y: 0, fit: 'width' });
    for (let remount = 0; remount < 3; remount++) {
      const stored = h.controller.actions.cameraOf('doc-pdf');
      expect(attr(viewerMarkup(stored), 'data-fit'), `remount ${remount}`).toBe('width');
      expect(attr(viewerMarkup(stored), 'data-zoom')).toBe('1');
    }
  });
});

describe('DocumentViewer keeps a PDF in its own viewer while it opens or after pdf.js rejected it (I06 / W-win-viewers-04)', () => {
  const apiOf = (h: Harness): WorkspaceApi => ({ state: h.state(), actions: h.controller.actions, sheetsOf: h.controller.sheetsOf, statusStore: h.controller.statusStore });
  const render = (h: Harness, id: string) => {
    const api = apiOf(h);
    const doc = api.state.documents.find(candidate => candidate.record.id === id)!;
    return renderToStaticMarkup(createElement(DocumentViewer, { api, doc, chrome: { theme: 'dark', motion: false, compact: false }, focusNonce: 0 }));
  };

  it('ready, loading and error PDFs render the viewer shell; a missing document renders the state card', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [
      { id: 'doc-pdf', path: '/boards/docs/service.pdf', kind: 'pdf', key: 42 },
      { id: 'doc-gone', path: '/boards/docs/gone.pdf', kind: 'pdf', key: 44, present: false },
    ]);
    await openNative(h, 'a.cad', 1, dividerBoard('a.cad'));
    expect(h.state().documents.find(d => d.record.id === 'doc-pdf')?.status).toBe('ready');
    expect(render(h, 'doc-pdf')).toContain('data-testid="document-viewer"');
    h.pdf.sessions[0].update({ status: 'opening', pageCount: 0 });
    expect(render(h, 'doc-pdf')).toContain('data-testid="document-viewer"');
    expect(render(h, 'doc-pdf')).not.toContain('data-testid="document-state"');
    h.pdf.sessions[0].update({ status: 'error', error: { code: 'INVALID_PDF', message: 'Invalid PDF structure.' } });
    expect(h.state().documents.find(d => d.record.id === 'doc-pdf')?.status).toBe('error');
    expect(render(h, 'doc-pdf')).toContain('data-testid="document-viewer"');
    expect(render(h, 'doc-pdf')).not.toContain('data-testid="document-state"');
    const missing = render(h, 'doc-gone');
    expect(missing).toContain('data-testid="document-state"');
    expect(missing).not.toContain('data-testid="document-viewer"');
  });
});
