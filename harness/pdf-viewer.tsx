import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '../src/styles.css';
import { PdfViewer } from '../src/components/PdfViewer';
import type { ViewerCamera, ViewerHighlight, ViewerProbeRegion } from '../src/components/viewer-contracts';
import type { DocumentAnnotation, DocumentBookmark } from '../src/lib/documents';
import type { PdfHandle, RenderPageOptions } from '../src/lib/pdf/document';
import { buildPdfFixture, rc4Encryption } from '../src/lib/pdf/pdf-fixture';
import type { FixturePage } from '../src/lib/pdf/pdf-fixture';
import { createPdfSession } from '../src/lib/pdf/session';
import type { PdfSession } from '../src/lib/pdf/session-contract';
import { configurePdfResources } from '../src/lib/pdf/worker';

/**
 * Dev harness of PdfViewer: synthetic PDFs, a controlled shell (camera / bookmarks / annotations / search / probes kept in React
 * state exactly like the application shell will) and an instrumented pdf.js handle that counts renders for scripts/qa-pdf-viewer.cjs.
 * URL: ?doc=vector|scan|rotated|mixed|big|encrypted  &w=<pane px>  &h=<pane px>  &compact=1  &theme=light  &motion=off  &strict=1  &slow=<ms>
 */
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
if (params.get('motion') === 'off') document.documentElement.dataset.motion = 'off';
const origin = location.origin;
configurePdfResources({ workerSrc: new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).href, cMapUrl: `${origin}/pdfjs/cmaps/`, standardFontDataUrl: `${origin}/pdfjs/standard_fonts/`, wasmUrl: `${origin}/pdfjs/wasm/`, iccUrl: `${origin}/pdfjs/iccs/` });

// ---------------------------------------------------------------------------------------------------------------- fixtures
const textPage = (n: number, extra: FixturePage = {}): FixturePage => {
  const dy = (extra.height ?? 792) - 792; // keep the text on pages with another height
  const at = (x: number, y: number, text: string, size?: number) => ({ x, y: y + dy, text, size });
  return {
    ...extra,
    texts: [
      at(72, 720, `Power sheet ${n}`, 18), at(72, 680, 'PU301'), at(160, 680, 'GND'), at(220, 680, '+3.3V'),
      at(72, 640, n === 2 ? 'PU301 and PU3011 share GND' : `R12 C7 D+/D- U${n}`),
      at(72, 600, 'The quick brown fox jumps over the lazy dog. Select this sentence.'),
      at(360, 120, `PU301 page ${n}`),
    ],
  };
};
const outline = [{ title: 'Power', page: 1, children: [{ title: 'Regulators', page: 2 }] }, { title: 'Details', page: 3, children: [{ title: 'Pinout', page: 3 }] }];

const FIXTURES: Record<string, () => { data: Uint8Array; password?: string }> = {
  vector: () => ({ data: buildPdfFixture({ pages: [textPage(1), textPage(2), textPage(3)], outline }) }),
  scan: () => ({ data: buildPdfFixture({ pages: [{ image: true }, { image: true, width: 595, height: 842 }] }) }),
  rotated: () => ({
    data: buildPdfFixture({ pages: [textPage(1), textPage(2, { rotate: 90 }), textPage(3, { rotate: 180 }), textPage(4, { rotate: 270 }), textPage(5, { width: 842, height: 595 })], outline }),
  }),
  mixed: () => ({ data: buildPdfFixture({ pages: [textPage(1, { width: 595, height: 842 }), textPage(2, { width: 1190, height: 842 }), textPage(3), textPage(4, { width: 300, height: 300 })] }) }),
  big: () => {
    const pages: FixturePage[] = [];
    for (let n = 1; n <= 300; n++) {
      pages.push({
        ...(n % 50 === 0 ? { width: 842, height: 595 } : {}),
        texts: [{ x: 72, y: 540, text: `Page ${n}`, size: 24 }, { x: 72, y: 500, text: `PU${n}` }, { x: 72, y: 470, text: 'GND' }, { x: 200, y: 500, text: n === 150 ? 'NEEDLE' : 'hay' }],
      });
    }
    return { data: buildPdfFixture({ pages, outline: [{ title: 'Start', page: 1 }, { title: 'Middle', page: 150 }, { title: 'End', page: 300 }] }) };
  },
  encrypted: () => ({ data: buildPdfFixture({ pages: [textPage(1), textPage(2)], outline, encryption: rc4Encryption('secret') }), password: 'secret' }),
  broken: () => ({ data: new TextEncoder().encode('%PDF-1.4\nthis is not a pdf at all\n') }),
};

// ---------------------------------------------------------------------------------------------------------------- render instrumentation
interface RenderStats {
  calls: number; completed: number; aborted: number; failed: number; inflight: number; maxInflight: number;
  perPage: Record<number, number>; log: Array<{ page: number; scale: number; result: string }>;
}
const stats: RenderStats = { calls: 0, completed: 0, aborted: 0, failed: 0, inflight: 0, maxInflight: 0, perPage: {}, log: [] };
const tracked = new Set<HTMLCanvasElement>();
let slowMs = Number(params.get('slow') ?? 0);
let handleLog: string[] = [];

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

const instrumented = new WeakMap<PdfHandle, PdfHandle>();
function instrument(handle: PdfHandle): PdfHandle {
  const existing = instrumented.get(handle);
  if (existing) return existing;
  const wrapped: PdfHandle = {
    get pageCount() { return handle.pageCount; },
    getPageSize: page => handle.getPageSize(page),
    getTextItems: page => handle.getTextItems(page),
    getOutline: () => handle.getOutline(),
    destroy: () => { handleLog.push('destroy'); return handle.destroy(); },
    async renderPage(page: number, options: RenderPageOptions) {
      stats.calls++; stats.inflight++; stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
      tracked.add(options.canvas);
      let result = 'completed', detail = '';
      try {
        if (slowMs > 0) await sleep(slowMs, options.signal);
        if (options.signal?.aborted) { result = 'aborted'; return; }
        await handle.renderPage(page, options);
        result = options.signal?.aborted ? 'aborted' : 'completed';
      } catch (error) {
        result = 'failed'; detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error); stats.failed++; throw error;
      } finally {
        stats.inflight--;
        if (result === 'completed') { stats.completed++; stats.perPage[page] = (stats.perPage[page] ?? 0) + 1; }
        else if (result === 'aborted') stats.aborted++;
        if (stats.log.length < 2000) stats.log.push({ page, scale: options.scale, result: detail ? `${result} ${detail}` : result });
      }
    },
  };
  instrumented.set(handle, wrapped);
  return wrapped;
}
function instrumentSession(session: PdfSession): PdfSession {
  return {
    id: session.id,
    getSnapshot: () => session.getSnapshot(),
    subscribe: listener => session.subscribe(listener),
    submitPassword: password => session.submitPassword(password),
    getHandle: () => { const handle = session.getHandle(); return handle ? instrument(handle) : null; },
    ensureIndex: () => session.ensureIndex(),
    find: (query, options) => session.find(query, options),
    refCandidates: (refs, nets, options) => session.refCandidates(refs, nets, options),
    dispose: () => session.dispose(),
  };
}
function liveCanvasStats() {
  let live = 0, pixels = 0, maxPixels = 0;
  for (const canvas of [...tracked]) {
    if (canvas.width === 0 || canvas.height === 0) { tracked.delete(canvas); continue; }
    live++; pixels += canvas.width * canvas.height; maxPixels = Math.max(maxPixels, canvas.width * canvas.height);
  }
  return { live, megapixels: Math.round(pixels / 1e4) / 100, maxCanvasMegapixels: Math.round(maxPixels / 1e4) / 100 };
}

// ---------------------------------------------------------------------------------------------------------------- harness shell
interface HarnessApi {
  load(name: string): Promise<void>;
  state(): Record<string, unknown>;
  setCamera(camera: ViewerCamera): void;
  setQuery(query: string): void;
  setPane(size: { width?: number; height?: number }): void;
  setCompact(compact: boolean): void;
  setTheme(theme: 'dark' | 'light'): void;
  setMotion(motion: boolean): void;
  setSlow(ms: number): void;
  setProbes(enabled: boolean): void;
  bumpSearchFocus(): void;
  /** Explicit "go to" intent (ProbeState.nonce): the viewer may navigate to the active highlight only after this. */
  bumpNavigate(): void;
  /** Selects a probe region as the active highlight; `navigate` also raises the navigate intent like the shell does for a fresh probe. */
  selectRegion(id: string | null, navigate?: boolean): void;
  regions(): Array<{ id: string; page?: number }>;
  /** Unmounts and mounts the viewer again with the same camera, query, highlights and annotations (tab switch in the shell). */
  remount(): void;
  dispose(): Promise<void>;
  resetStats(): void;
  stats(): RenderStats & ReturnType<typeof liveCanvasStats> & { handleLog: string[] };
}
declare global { interface Window { __harness: HarnessApi; __harnessReady: boolean } }

function Harness() {
  const [docName, setDocName] = useState(params.get('doc') ?? 'vector');
  const [session, setSession] = useState<PdfSession | null>(null);
  const [camera, setCamera] = useState<ViewerCamera>({});
  const [bookmarks, setBookmarks] = useState<DocumentBookmark[]>([]);
  const [annotations, setAnnotations] = useState<DocumentAnnotation[]>([]);
  const [query, setQuery] = useState('');
  const [regions, setRegions] = useState<ViewerProbeRegion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pane, setPane] = useState({ width: Number(params.get('w') ?? 0) || 0, height: Number(params.get('h') ?? 0) || 0 });
  const [compact, setCompact] = useState(params.get('compact') === '1');
  const [theme, setTheme] = useState<'dark' | 'light'>(params.get('theme') === 'light' ? 'light' : 'dark');
  const [motion, setMotion] = useState(params.get('motion') !== 'off');
  const [probes, setProbes] = useState(params.get('probes') !== '0');
  const [focusNonce, setFocusNonce] = useState(0);
  const [navigateNonce, setNavigateNonce] = useState(0);
  const [mountKey, setMountKey] = useState(0);
  const sessionRef = useRef<PdfSession | null>(null);
  const log = useRef({ cameraCalls: 0, probeClicks: [] as string[], bookmarkCalls: 0, annotationCalls: 0, cameras: [] as ViewerCamera[] });
  const current = useRef({ camera, bookmarks, annotations, query, selected });
  current.current = { camera, bookmarks, annotations, query, selected };

  const open = useCallback(async (name: string) => {
    const make = FIXTURES[name];
    if (!make) throw new Error(`unknown fixture ${name}`);
    const previous = sessionRef.current;
    sessionRef.current = null; setSession(null); setRegions([]); setSelected(null); setCamera({}); setBookmarks([]); setAnnotations([]); setQuery('');
    log.current = { cameraCalls: 0, probeClicks: [], bookmarkCalls: 0, annotationCalls: 0, cameras: [] };
    if (previous) { handleLog.push('dispose'); await previous.dispose(); }
    const fixture = make();
    const next = createPdfSession({ id: `harness-${name}-${Date.now()}`, data: fixture.data });
    sessionRef.current = next;
    setDocName(name);
    setSession(instrumentSession(next));
  }, []);

  useEffect(() => { void open(docName); return () => { void sessionRef.current?.dispose(); sessionRef.current = null; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { // cross-reference regions for the exact board references of the fixture
    if (!session || !probes) { setRegions([]); return; }
    let cancelled = false;
    void (async () => {
      for (;;) {
        const status = session.getSnapshot().status;
        if (status === 'ready') break;
        if (cancelled || status === 'closed' || status === 'error') return;
        await sleep(50);
      }
      const result = await session.refCandidates(new Set(['PU301', 'R12']), new Set(['GND'])).catch(() => null);
      if (!result || cancelled) return;
      const next: ViewerProbeRegion[] = [];
      for (const candidate of result.candidates) candidate.hits.forEach((hit, i) => next.push({ id: `${candidate.kind}:${candidate.name}:${hit.page}:${i}`, page: hit.page, rect: { x: hit.x, y: hit.y, width: hit.width, height: hit.height }, label: `${candidate.kind === 'ref' ? 'Component' : 'Net'} ${candidate.name}, page ${hit.page}` }));
      setRegions(next);
    })();
    return () => { cancelled = true; };
  }, [session, probes]);

  const highlights = useMemo<ViewerHighlight[]>(() => regions.map(region => ({
    id: region.id, kind: region.id === selected ? 'selection' : 'probe', page: region.page, rect: region.rect, label: region.label, active: region.id === selected,
  })), [regions, selected]);

  useEffect(() => {
    const api: HarnessApi = {
      load: name => open(name),
      state: () => ({
        camera: current.current.camera, cameraCalls: log.current.cameraCalls, lastCamera: log.current.cameras.at(-1) ?? null, probeClicks: log.current.probeClicks,
        bookmarks: current.current.bookmarks, annotations: current.current.annotations, bookmarkCalls: log.current.bookmarkCalls, annotationCalls: log.current.annotationCalls,
        query: current.current.query, selected: current.current.selected, status: sessionRef.current?.getSnapshot().status ?? 'none', snapshot: sessionRef.current?.getSnapshot() ?? null,
        regions: regions.length,
      }),
      setCamera: next => setCamera(next),
      setQuery: next => setQuery(next),
      setPane: size => setPane(previous => ({ ...previous, ...size })),
      setCompact, setTheme: next => { setTheme(next); document.documentElement.dataset.theme = next; },
      setMotion: next => { setMotion(next); if (next) delete document.documentElement.dataset.motion; else document.documentElement.dataset.motion = 'off'; },
      setSlow: ms => { slowMs = ms; }, setProbes,
      bumpSearchFocus: () => setFocusNonce(value => value + 1),
      bumpNavigate: () => setNavigateNonce(value => value + 1),
      selectRegion: (id, navigate) => { setSelected(id); if (navigate) setNavigateNonce(value => value + 1); },
      regions: () => regions.map(region => ({ id: region.id, page: region.page })),
      remount: () => setMountKey(value => value + 1),
      dispose: async () => { const s = sessionRef.current; sessionRef.current = null; await s?.dispose(); },
      resetStats: () => { stats.calls = stats.completed = stats.aborted = stats.failed = stats.maxInflight = 0; stats.inflight = 0; stats.perPage = {}; stats.log = []; handleLog = []; },
      stats: () => ({ ...stats, ...liveCanvasStats(), handleLog, log: stats.log.slice(-200) }),
    };
    window.__harness = api;
    window.__harnessReady = true;
  }, [open, regions.length]);

  const paneStyle = { width: pane.width || '100%', height: pane.height || '100%' };
  return (
    <div className="harness-root" style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {params.get('bar') === '0' ? null : (
        <div style={{ flex: '0 0 34px', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--line)', background: 'var(--panel)', fontSize: 12 }}>
          <strong>PdfViewer harness</strong>
          <select aria-label="Fixture" value={docName} onChange={event => void open(event.target.value)}>{Object.keys(FIXTURES).map(name => <option key={name}>{name}</option>)}</select>
          <label><input type="checkbox" checked={compact} onChange={event => setCompact(event.target.checked)} /> compact</label>
          <label><input type="checkbox" checked={theme === 'light'} onChange={event => { const next = event.target.checked ? 'light' : 'dark'; setTheme(next); document.documentElement.dataset.theme = next; }} /> light</label>
          <span className="muted" data-testid="harness-selected">{selected ?? ''}</span>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div id="pane" data-testid="pane" style={{ ...paneStyle, minWidth: 0, minHeight: 0, borderRight: '1px solid var(--line)' }}>
          {session ? (
            <PdfViewer
              key={mountKey}
              session={session} theme={theme} motion={motion} compact={compact} camera={camera}
              onCameraChange={next => { log.current.cameraCalls++; log.current.cameras.push(next); setCamera(next); }}
              bookmarks={bookmarks} annotations={annotations}
              onBookmarksChange={next => { log.current.bookmarkCalls++; setBookmarks(next); }}
              onAnnotationsChange={next => { log.current.annotationCalls++; setAnnotations(next); }}
              highlights={highlights} probeRegions={regions}
              onProbeRegionClick={id => { log.current.probeClicks.push(id); setSelected(id); setNavigateNonce(value => value + 1); }}
              searchQuery={query} onSearchQueryChange={setQuery} focusSearchNonce={focusNonce} navigateNonce={navigateNonce}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

const tree = <Harness />;
createRoot(document.getElementById('root')!).render(params.get('strict') === '1' ? <StrictMode>{tree}</StrictMode> : tree);
