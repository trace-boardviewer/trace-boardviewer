import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react';
import {
  Bookmark as BookmarkIcon, BookmarkPlus, CaseSensitive, ChevronDown, ChevronUp, FileWarning, Images, ListTree, LoaderCircle, Lock, Maximize, MoveHorizontal,
  PanelLeft, Pencil, RotateCcw, RotateCw, ScanLine, Search, StickyNote, Trash2, TriangleAlert, WholeWord, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { DocumentAnnotation, DocumentBookmark } from '../lib/documents';
import { WORKSPACE_LIMITS } from '../lib/documents';
import type { OutlineEntry, PdfHandle, TextItem } from '../lib/pdf/document';
import type { PdfSession, PdfSessionSnapshot } from '../lib/pdf/session-contract';
import type { Hit } from '../lib/pdf/search';
import {
  BoundedCache, TaskQueue, captureAnchor, clamp, clampZoom, computeLayout, createThrottle, currentPageIndex, displayRotation, displaySize, expandRange, fitZoom,
  formatZoom, groupByPage, isRectVisible, nearestHitIndex, normalizeRotation, pageLeft, pageMatrix, parseZoomInput, planRenderScale, renderWindow,
  resolveAnchor, rotatePoint, rotateRect, sameRange, stepZoom, unrotatePoint, visibleRange, wrapIndex,
} from './pdf-layout';
import type { IndexRange, PageBox, PageLayout, Point, ScrollAnchor, Size } from './pdf-layout';
import type { DocRect, PdfViewerProps, ViewerCamera, ViewerHighlight, ViewerProbeRegion, ViewerRotation } from './viewer-contracts';
import './pdf-viewer.css';

// i18n: pending
const T = {
  toolbar: 'PDF viewer controls', sidebarShow: 'Show sidebar', sidebarHide: 'Hide sidebar', pageGroup: 'Page navigation', prevPage: 'Previous page', nextPage: 'Next page',
  pageInput: 'Page number', zoomGroup: 'Zoom', zoomOut: 'Zoom out (-)', zoomIn: 'Zoom in (+)', zoomInput: 'Zoom percent', fitWidth: 'Fit width', fitPage: 'Fit page',
  rotateLeft: 'Rotate counterclockwise', rotateRight: 'Rotate clockwise', viewGroup: 'Page rotation', marksGroup: 'Bookmarks and notes',
  addBookmark: 'Add bookmark at this position', addNote: 'Add note (then click the page to place it)', addNoteKeyboard: 'Add note at the center of the view',
  noteCancel: 'Click a page to place the note, Esc to cancel', searchLabel: 'Find in document', searchPlaceholder: 'Find in document', searchClear: 'Clear search',
  prevHit: 'Previous match (Shift+Enter)', nextHit: 'Next match (Enter)', caseSensitive: 'Match case', wholeWord: 'Whole word', searching: 'Searching…',
  noMatches: 'No matches', hitLimit: (n: number) => `Showing the first ${n.toLocaleString('en')} matches only.`,
  noTextLayer: 'No text layer: this is a scanned or raster PDF, so text search is unavailable. The pages can still be viewed.',
  indexing: (done: number, total: number) => `Indexing text: ${done} of ${total} pages`,
  truncated: (done: number, total: number) => `Text index truncated: only the first ${done} of ${total} pages are searchable.`,
  indexFailed: 'Text indexing failed; search results may be incomplete.', searchFailed: (message: string) => `Search failed: ${message}`,
  pages: 'Pages', outline: 'Outline', bookmarks: 'Bookmarks', notes: 'Notes', sidebarTabs: 'Document panels', pagesRegion: 'PDF pages',
  thumbnailsLabel: 'Page thumbnails', pageN: (n: number) => `Page ${n}`, goToPage: (n: number) => `Go to page ${n}`,
  noOutline: 'This PDF has no outline.', noBookmarks: 'No bookmarks yet. Add one at the current position.', noNotes: 'No notes yet. Use "Add note" and click a page.',
  addBookmarkHere: 'Add bookmark here', renameBookmark: 'Rename bookmark', deleteBookmark: 'Delete bookmark', bookmarkLabel: 'Bookmark name', deleteNote: 'Delete note',
  noteMarker: (text: string) => `Note: ${text}`, noteEditor: 'Note text', noteDone: 'Done', noteDiscard: 'Discard', notePlaceholder: 'Write a note…', emptyNote: '(empty note)',
  openingTitle: 'Opening PDF…', passwordTitle: 'This PDF is password protected', passwordLabel: 'Password', passwordUnlock: 'Unlock', passwordWrong: 'That password is not correct. Try again.',
  passwordFailed: (message: string) => `Could not unlock the PDF: ${message}`, errorTitle: 'The PDF could not be opened', closedTitle: 'This document has been closed',
  closedHint: 'Reopen it from the document list.', renderFailed: 'This page could not be rendered.', pageClamped: 'Rendered at reduced resolution to bound memory.',
  loadingPage: 'Rendering page',
} as const;

const PAGE_GAP = 12;
const PAD = 16;
const PAD_COMPACT = 8;
const THUMB_WIDTH = 124;
const THUMB_LABEL = 22;
const MAIN_CANVAS_CACHE = 6;
const THUMB_CANVAS_CACHE = 24;
const RENDER_BUDGET_PIXELS = 48_000_000;
const PAGE_RENDER_DELAY_MS = 60;
const THUMB_RENDER_DELAY_MS = 160;
const SEARCH_DEBOUNCE_MS = 200;
/** How long a navigate intent from the shell waits for its highlight to arrive (they normally land in the same commit). */
const NAVIGATE_INTENT_MS = 1500;
const SEARCH_HIT_LIMIT = 10_000;
const CAMERA_THROTTLE_MS = 250;
const ECHO_WINDOW_MS = 1000;
const TEXT_SPAN_LIMIT = 15_000;
const HIGHLIGHTS_PER_PAGE = 1500;
const LETTER: PageBox = { width: 612, height: 792, rotation: 0 };
const NO_HITS: readonly Hit[] = [];
const NO_ITEMS: readonly never[] = [];

type Fit = 'width' | 'page' | 'none';
type SidebarTab = 'pages' | 'outline' | 'bookmarks' | 'notes';
type RenderState = 'pending' | 'done' | 'error';
interface Nav { page: number; point?: Point; rect?: DocRect; instant?: boolean }
interface Lock { page: number; top: number; left: number; reached: boolean }
interface OpenNote { id: string; draft?: { page: number; x: number; y: number } }
interface PageActions {
  probeClick(id: string): void;
  placeNote(page: number, x: number, y: number): void;
  openNote(id: string | null): void;
  commitNote(id: string, text: string, refocus: boolean): void;
  deleteNote(id: string): void;
}

const newId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const round = (value: number, digits: number) => { const k = 10 ** digits; return Math.round(value * k) / k; };
const prefersReducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isAbort = (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ABORTED';
const sameRect = (a: DocRect, b: DocRect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0; canvas.height = 0; // frees the backing store immediately instead of waiting for GC
  canvas.remove();
}

/** True when every field the incoming camera defines already equals `actual` (zoom within 0.2%, x/y within 1 pt). */
function cameraMatches(incoming: ViewerCamera, actual: ViewerCamera): boolean {
  if (incoming.page !== undefined && incoming.page !== actual.page) return false;
  if (incoming.rotation !== undefined && normalizeRotation(incoming.rotation) !== (actual.rotation ?? 0)) return false;
  if (incoming.fit !== undefined && incoming.fit !== (actual.fit ?? 'none')) return false;
  if (incoming.zoom !== undefined && (actual.zoom === undefined || Math.abs(incoming.zoom - actual.zoom) > Math.max(0.002, actual.zoom * 0.002))) return false;
  if (incoming.x !== undefined && (actual.x === undefined || Math.abs(incoming.x - actual.x) > 1)) return false;
  if (incoming.y !== undefined && (actual.y === undefined || Math.abs(incoming.y - actual.y) > 1)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry point

export function PdfViewer(props: PdfViewerProps) {
  return <ViewerGate key={props.session.id} {...props} />;
}

function useSession(session: PdfSession): PdfSessionSnapshot {
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const getSnapshot = useCallback(() => session.getSnapshot(), [session]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function ViewerGate(props: PdfViewerProps) {
  const snapshot = useSession(props.session);
  const handle = snapshot.status === 'ready' ? props.session.getHandle() : null;
  if (handle) return <ReadyViewer {...props} handle={handle} snapshot={snapshot} />;
  return (
    <section className="pdfv pdfv-bare" data-theme={props.theme} data-motion={props.motion ? 'on' : 'off'} data-compact={props.compact ? 'true' : 'false'} data-state={snapshot.status} style={{ colorScheme: props.theme }}>
      <StatePanel session={props.session} snapshot={snapshot} />
    </section>
  );
}

function StatePanel({ session, snapshot }: { session: PdfSession; snapshot: PdfSessionSnapshot }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const submit = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    if (!password || busy) return;
    const attempt = password;
    setBusy(true); setFailure(null); setPassword('');
    try { await session.submitPassword(attempt); }
    catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      setFailure(code === 'INVALID_PASSWORD' ? T.passwordWrong : T.passwordFailed(errorMessage(error)));
    } finally { setBusy(false); }
  };
  switch (snapshot.status) {
    case 'password-required':
    case 'invalid-password':
      return (
        <form className="pdfv-state" onSubmit={submit} aria-labelledby="pdfv-pw-title">
          <Lock size={28} aria-hidden="true" className="pdfv-state-icon" />
          <h2 id="pdfv-pw-title">{T.passwordTitle}</h2>
          <label className="pdfv-field">
            <span>{T.passwordLabel}</span>
            <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="off" autoFocus spellCheck={false} disabled={busy} aria-invalid={snapshot.status === 'invalid-password' || failure !== null} aria-describedby="pdfv-pw-error" />
          </label>
          <button type="submit" className="pdfv-primary" disabled={busy || !password}>{busy ? <LoaderCircle size={14} className="pdfv-spin" aria-hidden="true" /> : null}{T.passwordUnlock}</button>
          <p id="pdfv-pw-error" className="pdfv-state-error" role="alert">{failure ?? (snapshot.status === 'invalid-password' ? T.passwordWrong : '')}</p>
        </form>
      );
    case 'error':
      return (
        <div className="pdfv-state" role="alert">
          <FileWarning size={28} aria-hidden="true" className="pdfv-state-icon pdfv-state-icon-bad" />
          <h2>{T.errorTitle}</h2>
          <p>{snapshot.error?.message ?? ''}</p>
          {snapshot.error ? <p className="pdfv-state-code mono">{snapshot.error.code}</p> : null}
        </div>
      );
    case 'closed':
      return (
        <div className="pdfv-state" role="status">
          <FileWarning size={28} aria-hidden="true" className="pdfv-state-icon" />
          <h2>{T.closedTitle}</h2>
          <p>{T.closedHint}</p>
        </div>
      );
    default:
      return (
        <div className="pdfv-state" role="status" aria-live="polite">
          <LoaderCircle size={28} aria-hidden="true" className="pdfv-spin pdfv-state-icon" />
          <h2>{T.openingTitle}</h2>
        </div>
      );
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Page sizes: discovered lazily (visible pages first, then the rest in the background), applied in batches

function usePageSizes(handle: PdfHandle, before: RefObject<(() => void) | null>, focusPage: RefObject<number>) {
  const boxes = useRef(new Map<number, PageBox>()).current;
  const inflight = useRef(new Set<number>()).current;
  const batch = useRef(new Map<number, PageBox>()).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const [version, setVersion] = useState(0);

  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (!batch.size || !alive.current) return;
    before.current?.();
    for (const [page, box] of batch) boxes.set(page, box);
    batch.clear();
    setVersion(value => value + 1);
  }, [batch, boxes, before]);

  const request = useCallback((page: number) => {
    if (boxes.has(page) || batch.has(page) || inflight.has(page) || page < 1 || page > handle.pageCount) return;
    inflight.add(page);
    handle.getPageSize(page).catch(() => LETTER).then(box => {
      inflight.delete(page);
      if (!alive.current) return;
      batch.set(page, { width: box.width, height: box.height, rotation: box.rotation });
      if (!timer.current) timer.current = setTimeout(flush, 40);
    });
  }, [batch, boxes, flush, handle, inflight]);

  useEffect(() => {
    alive.current = true;
    let stop = false;
    void (async () => {
      const total = handle.pageCount;
      while (!stop) {
        // nearest unknown pages first so content above the reader settles before the rest of the document
        const centre = focusPage.current ?? 1;
        const wanted: number[] = [];
        for (let distance = 0; distance < total && wanted.length < 16; distance++) {
          for (const page of distance === 0 ? [centre] : [centre + distance, centre - distance]) {
            if (page >= 1 && page <= total && !boxes.has(page) && !batch.has(page) && !inflight.has(page) && wanted.length < 16) wanted.push(page);
          }
        }
        if (!wanted.length) break;
        wanted.forEach(request);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    })();
    return () => {
      stop = true; alive.current = false;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      batch.clear(); inflight.clear();
    };
  }, [batch, boxes, focusPage, handle, inflight, request]);

  return { boxes, version, request };
}

// ---------------------------------------------------------------------------------------------------------------------
// Canvas rendering shared by pages and thumbnails

interface CanvasRenderOptions {
  handle: PdfHandle; page: number; enabled: boolean; scale: number; rotation: ViewerRotation;
  cache: BoundedCache<string, HTMLCanvasElement>; queue: TaskQueue; priority: () => number; delay: number;
  host: RefObject<HTMLDivElement | null>; onChange?: () => void;
}
function useCanvasRender(options: CanvasRenderOptions): RenderState {
  const { handle, page, enabled, scale, rotation, cache, queue, host } = options;
  const [state, setState] = useState<RenderState>('pending');
  const current = useRef<{ canvas: HTMLCanvasElement; key: string; rotation: ViewerRotation } | null>(null);
  const latest = useRef(options); latest.current = options;
  const key = `${page}|${rotation}|${scale}`;

  useEffect(() => {
    const element = host.current;
    if (!enabled || !element) return;
    const showing = current.current;
    if (showing && showing.rotation !== rotation) { releaseCanvas(showing.canvas); current.current = null; element.replaceChildren(); setState('pending'); }
    else if (showing?.key === key) return;
    const adopt = (canvas: HTMLCanvasElement) => {
      canvas.className = 'pdfv-canvas';
      element.replaceChildren(canvas);
      const previous = current.current;
      current.current = { canvas, key, rotation };
      if (previous && previous.canvas !== canvas) releaseCanvas(previous.canvas);
      setState('done');
      latest.current.onChange?.();
    };
    const cached = cache.take(key);
    if (cached) { adopt(cached); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void queue.run(async () => {
        if (controller.signal.aborted) return;
        const canvas = document.createElement('canvas');
        try {
          await handle.renderPage(page, { scale, rotation, canvas, signal: controller.signal, background: '#ffffff' });
        } catch {
          releaseCanvas(canvas);
          if (!controller.signal.aborted) setState('error');
          return;
        }
        if (controller.signal.aborted) { releaseCanvas(canvas); return; }
        adopt(canvas);
      }, { signal: controller.signal, priority: () => latest.current.priority() }).catch(() => undefined);
    }, latest.current.delay);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [cache, enabled, handle, host, key, page, queue, rotation, scale]);

  useEffect(() => () => {
    const showing = current.current;
    current.current = null;
    if (!showing) return;
    cache.put(showing.key, showing.canvas); // keeps a few recently left pages so scrolling back is instant; bounded by the cache
    latest.current.onChange?.();
  }, [cache]);

  return state;
}

// ---------------------------------------------------------------------------------------------------------------------
// Text layer (transparent, selectable): one absolutely positioned span per text item, in document space, under one CSS matrix

let measureContext: CanvasRenderingContext2D | null | undefined;
const TEXT_FONT = 'Arial, Helvetica, "Liberation Sans", sans-serif';
function textWidthAt100(text: string): number {
  if (measureContext === undefined) {
    measureContext = document.createElement('canvas').getContext('2d');
    if (measureContext) measureContext.font = `100px ${TEXT_FONT}`;
  }
  return measureContext ? measureContext.measureText(text).width : text.length * 55;
}

function buildTextSpans(items: readonly TextItem[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const count = Math.min(items.length, TEXT_SPAN_LIMIT);
  for (let i = 0; i < count; i++) {
    const item = items[i];
    if (!(item.width > 0 && item.height > 0)) continue;
    const span = document.createElement('span');
    span.textContent = item.str;
    const natural = textWidthAt100(item.str) / 100;
    // Rotated text is only known as its axis-aligned box: a tall box with a longer string is treated as text reading upwards.
    if (item.str.length >= 3 && item.height > item.width * 1.3) {
      const size = Math.max(0.5, item.width);
      const stretch = clamp(item.height / Math.max(0.001, natural * size), 0.05, 20);
      span.style.cssText = `left:0;top:0;font-size:${size.toFixed(2)}px;transform:translate(${item.x.toFixed(2)}px,${(item.y + item.height).toFixed(2)}px) rotate(-90deg) scaleX(${stretch.toFixed(4)})`;
    } else {
      const size = Math.max(0.5, item.height);
      const stretch = clamp(item.width / Math.max(0.001, natural * size), 0.05, 20);
      span.style.cssText = `left:${item.x.toFixed(2)}px;top:${item.y.toFixed(2)}px;font-size:${size.toFixed(2)}px;transform:scaleX(${stretch.toFixed(4)})`;
    }
    fragment.appendChild(span);
  }
  return fragment;
}

const PageTextLayer = memo(function PageTextLayer({ handle, page, box, rotation, zoom }: { handle: PdfHandle; page: number; box: PageBox; rotation: ViewerRotation; zoom: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let cancelled = false;
    handle.getTextItems(page).then(items => { if (!cancelled) host.replaceChildren(buildTextSpans(items)); }, () => undefined);
    return () => { cancelled = true; host.replaceChildren(); };
  }, [handle, page]);
  const [a, b, c, d, e, f] = pageMatrix(box.width, box.height, rotation, zoom);
  return <div ref={ref} className="pdfv-text" style={{ width: box.width, height: box.height, transform: `matrix(${a},${b},${c},${d},${e},${f})` }} />;
});

// ---------------------------------------------------------------------------------------------------------------------
// Page overlays: highlights (under the text layer) and interactive probe regions / notes (above it)

interface Placement { left: number; top: number; width: number; height: number }
const placeRect = (rect: DocRect, box: PageBox, rotation: ViewerRotation, zoom: number): Placement => {
  const r = rotateRect(rect, box.width, box.height, rotation);
  return { left: r.x * zoom, top: r.y * zoom, width: Math.max(r.width * zoom, 2), height: Math.max(r.height * zoom, 2) };
};

const PageHighlights = memo(function PageHighlights({ box, rotation, zoom, hits, active, highlights }: {
  box: PageBox; rotation: ViewerRotation; zoom: number; hits: readonly Hit[]; active: Hit | null; highlights: readonly ViewerHighlight[];
}) {
  if (!hits.length && !highlights.length) return null;
  return (
    <div className="pdfv-hl" aria-hidden="true">
      {highlights.filter(item => item.kind !== 'selection').map(item => <span key={item.id} className={`pdfv-xhl pdfv-xhl-${item.kind}${item.active ? ' is-active' : ''}`} style={placeRect(item.rect, box, rotation, zoom)} />)}
      {hits.map((hit, i) => <span key={i} className={hit === active ? 'pdfv-hit is-active' : 'pdfv-hit'} style={placeRect(hit, box, rotation, zoom)} />)}
      {highlights.filter(item => item.kind === 'selection').map(item => <span key={item.id} className={`pdfv-xhl pdfv-xhl-selection${item.active ? ' is-active' : ''}`} style={placeRect(item.rect, box, rotation, zoom)} />)}
    </div>
  );
});

function NoteMarker({ note, style, open, actions }: { note: { id: string; text: string }; style: CSSProperties; open: boolean; actions: PageActions }) {
  const wasOpen = useRef(false);
  return (
    <button
      type="button" className={open ? 'pdfv-note is-open' : 'pdfv-note'} style={style} data-note-marker={note.id}
      aria-label={T.noteMarker(note.text || T.emptyNote)} aria-expanded={open} title={note.text || T.emptyNote}
      onPointerDown={() => { wasOpen.current = open; }}
      onClick={event => { event.stopPropagation(); if (wasOpen.current) { wasOpen.current = false; return; } actions.openNote(note.id); }}
    ><StickyNote size={13} aria-hidden="true" /></button>
  );
}

function NotePopover({ note, isDraft, left, top, pageWidth, actions }: { note: { id: string; text: string }; isDraft: boolean; left: number; top: number; pageWidth: number; actions: PageActions }) {
  const [text, setText] = useState(note.text);
  const finished = useRef(false);
  const finish = (commit: boolean, refocus = true) => {
    if (finished.current) return;
    finished.current = true;
    if (commit) actions.commitNote(note.id, text, refocus); else actions.deleteNote(note.id);
  };
  const x = clamp(left - 14, 4, Math.max(4, pageWidth - 252));
  return (
    <div
      className="pdfv-popover" role="dialog" aria-label={T.noteEditor} style={{ left: x, top: top + 18 }}
      onClick={event => event.stopPropagation()}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) finish(true, false); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); finish(true); }
        else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); finish(true); }
      }}
    >
      <textarea
        autoFocus value={text} rows={4} maxLength={WORKSPACE_LIMITS.text} aria-label={T.noteEditor} placeholder={T.notePlaceholder}
        onChange={event => setText(event.target.value)} onFocus={event => { const end = event.target.value.length; event.target.setSelectionRange(end, end); }}
      />
      <div className="pdfv-popover-actions">
        <button type="button" className="pdfv-chip pdfv-chip-danger" onClick={() => finish(false)}><Trash2 size={13} aria-hidden="true" />{isDraft ? T.noteDiscard : T.deleteNote}</button>
        <button type="button" className="pdfv-chip pdfv-chip-primary" onClick={() => finish(true)}>{T.noteDone}</button>
      </div>
    </div>
  );
}

const PageInteractive = memo(function PageInteractive({ box, rotation, zoom, width, probes, notes, openNote, actions }: {
  box: PageBox; rotation: ViewerRotation; zoom: number; width: number; probes: readonly ViewerProbeRegion[];
  notes: readonly { id: string; text: string; x: number; y: number }[]; openNote: OpenNote | null; actions: PageActions;
}) {
  if (!probes.length && !notes.length) return null;
  return (
    <div className="pdfv-ui">
      {probes.map(region => (
        <button
          key={region.id} type="button" className="pdfv-probe" style={placeRect(region.rect, box, rotation, zoom)} aria-label={region.label} title={region.label}
          onClick={event => { event.stopPropagation(); actions.probeClick(region.id); }}
        />
      ))}
      {notes.map(note => {
        const at = rotatePoint(note.x, note.y, box.width, box.height, rotation);
        const open = openNote?.id === note.id;
        return (
          <span key={note.id}>
            <NoteMarker note={note} open={open} actions={actions} style={{ left: at.x * zoom, top: at.y * zoom }} />
            {open ? <NotePopover note={note} isDraft={openNote?.draft !== undefined} left={at.x * zoom} top={at.y * zoom} pageWidth={width} actions={actions} /> : null}
          </span>
        );
      })}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// One page

interface PdfPageProps {
  handle: PdfHandle; page: number; box: PageBox | undefined; estimate: Size; zoom: number; userRotation: ViewerRotation; dpr: number;
  top: number; left: number; width: number; height: number; visible: boolean;
  cache: BoundedCache<string, HTMLCanvasElement>; queue: TaskQueue; onCanvasChange(): void;
  hits: readonly Hit[]; activeHit: Hit | null; highlights: readonly ViewerHighlight[]; probes: readonly ViewerProbeRegion[];
  notes: readonly { id: string; text: string; x: number; y: number }[]; openNote: OpenNote | null; noteArmed: boolean; actions: PageActions;
}
const PdfPage = memo(function PdfPage(props: PdfPageProps) {
  const { handle, page, box, estimate, zoom, userRotation, dpr, top, left, width, height, visible, hits, activeHit, highlights, probes, notes, openNote, noteArmed, actions } = props;
  const host = useRef<HTMLDivElement>(null);
  const shown = box ? displaySize(box, userRotation) : estimate;
  const plan = planRenderScale(shown, zoom, dpr);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const state = useCanvasRender({
    handle, page, enabled: box !== undefined, scale: plan.scale, rotation: userRotation, cache: props.cache, queue: props.queue,
    priority: () => (visibleRef.current ? 0 : 1), delay: PAGE_RENDER_DELAY_MS, host, onChange: props.onCanvasChange,
  });
  const rotation = box ? displayRotation(box.rotation, userRotation) : userRotation;
  const hasOpen = openNote !== null && notes.some(note => note.id === openNote.id);
  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!noteArmed || !box) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = unrotatePoint((event.clientX - rect.left) / zoom, (event.clientY - rect.top) / zoom, box.width, box.height, rotation);
    actions.placeNote(page, clamp(point.x, 0, box.width), clamp(point.y, 0, box.height));
  };
  return (
    <div
      className="pdfv-page" data-page={page} data-render={state} data-clamped={plan.clamped ? 'true' : undefined} onClick={onClick}
      style={{ top, left, width, height, zIndex: hasOpen ? 5 : undefined }}
    >
      <div ref={host} className="pdfv-canvas-host" />
      {state !== 'done' ? (
        <div className="pdfv-page-ph" aria-hidden="true" data-failed={state === 'error' ? 'true' : undefined}>
          <span className="mono">{page}</span>
          {state === 'error' ? <span className="pdfv-page-fail" role="alert"><TriangleAlert size={14} aria-hidden="true" />{T.renderFailed}</span> : null}
        </div>
      ) : null}
      {box ? <PageHighlights box={box} rotation={rotation} zoom={zoom} hits={hits} active={activeHit} highlights={highlights} /> : null}
      {box ? <PageTextLayer handle={handle} page={page} box={box} rotation={rotation} zoom={zoom} /> : null}
      {box ? <PageInteractive box={box} rotation={rotation} zoom={zoom} width={width} probes={probes} notes={notes} openNote={openNote} actions={actions} /> : null}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// Sidebar

const Thumb = memo(function Thumb({ handle, page, box, estimate, rotation, dpr, active, top, height, cache, queue, onJump }: {
  handle: PdfHandle; page: number; box: PageBox | undefined; estimate: Size; rotation: ViewerRotation; dpr: number; active: boolean; top: number; height: number;
  cache: BoundedCache<string, HTMLCanvasElement>; queue: TaskQueue; onJump(page: number): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const shown = box ? displaySize(box, rotation) : estimate;
  const plan = planRenderScale(shown, THUMB_WIDTH / shown.width, dpr, 2_000_000);
  const state = useCanvasRender({ handle, page, enabled: box !== undefined, scale: plan.scale, rotation, cache, queue, priority: () => 2, delay: THUMB_RENDER_DELAY_MS, host });
  const imageHeight = height - THUMB_LABEL;
  return (
    <button type="button" className={active ? 'pdfv-thumb is-active' : 'pdfv-thumb'} style={{ top, height }} aria-label={T.goToPage(page)} aria-current={active ? 'page' : undefined} onClick={() => onJump(page)} data-thumb={page}>
      <div className="pdfv-thumb-image" style={{ width: THUMB_WIDTH, height: imageHeight }} data-render={state}><div ref={host} className="pdfv-canvas-host" /></div>
      <span className="pdfv-thumb-label mono">{page}</span>
    </button>
  );
});

function ThumbList({ handle, pageCount, boxes, version, rotation, current, dpr, request, onJump, cache, queue }: {
  handle: PdfHandle; pageCount: number; boxes: Map<number, PageBox>; version: number; rotation: ViewerRotation; current: number; dpr: number;
  request(page: number): void; onJump(page: number): void; cache: BoundedCache<string, HTMLCanvasElement>; queue: TaskQueue;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  const fallback = useMemo(() => displaySize(boxes.get(1) ?? boxes.values().next().value ?? LETTER, rotation), [boxes, version, rotation]);
  const layout = useMemo(() => {
    const sizes: Size[] = new Array(pageCount);
    for (let i = 0; i < pageCount; i++) {
      const box = boxes.get(i + 1);
      const shown = box ? displaySize(box, rotation) : fallback;
      sizes[i] = { width: THUMB_WIDTH, height: Math.round((THUMB_WIDTH * shown.height) / shown.width) + THUMB_LABEL };
    }
    return computeLayout(sizes, { zoom: 1, gap: 8, padding: 10, viewportWidth: THUMB_WIDTH });
  }, [boxes, version, rotation, pageCount, fallback]);
  const layoutRef = useRef<PageLayout>(layout); layoutRef.current = layout;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setView(prev => (prev.height === element.clientHeight && prev.top === element.scrollTop ? prev : { top: element.scrollTop, height: element.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (element) setView(prev => (Math.abs(prev.top - element.scrollTop) < 24 && prev.height === element.clientHeight ? prev : { top: element.scrollTop, height: element.clientHeight }));
  }, []);

  const range = useMemo(() => expandRange(visibleRange(layout, view.top, view.height), 2, pageCount), [layout, view, pageCount]);
  useEffect(() => { for (let i = range.first; i <= range.last; i++) request(i + 1); }, [range.first, range.last, request]);

  useEffect(() => { // keep the current page's thumbnail in view without fighting a user who is scrolling the list
    const element = scroller.current, lay = layoutRef.current, index = current - 1;
    if (!element || index < 0 || index >= lay.count) return;
    const top = lay.tops[index], bottom = top + lay.heights[index];
    if (top < element.scrollTop + 4 || bottom > element.scrollTop + element.clientHeight - 4) element.scrollTop = Math.max(0, top - (element.clientHeight - lay.heights[index]) / 2);
  }, [current]);

  const items: ReactNode[] = [];
  for (let i = range.first; i <= range.last; i++) {
    items.push(<Thumb key={i} handle={handle} page={i + 1} box={boxes.get(i + 1)} estimate={fallback} rotation={rotation} dpr={dpr} active={current === i + 1} top={layout.tops[i]} height={layout.heights[i]} cache={cache} queue={queue} onJump={onJump} />);
  }
  return (
    <div ref={scroller} className="pdfv-scroll pdfv-thumbs" role="group" aria-label={T.thumbnailsLabel} onScroll={onScroll}>
      <div className="pdfv-thumbs-spacer" style={{ height: layout.total }}>{items}</div>
    </div>
  );
}

function OutlineList({ outline, current, onJump }: { outline: readonly OutlineEntry[]; current: number; onJump(page: number): void }) {
  if (!outline.length) return <p className="pdfv-empty">{T.noOutline}</p>;
  let active = -1;
  outline.forEach((entry, i) => { if (entry.page <= current) active = i; });
  return (
    <ul className="pdfv-list pdfv-outline">
      {outline.map((entry, i) => (
        <li key={i}>
          <button type="button" className={i === active ? 'pdfv-row is-active' : 'pdfv-row'} style={{ paddingLeft: 10 + Math.min(entry.depth, 6) * 12 }} onClick={() => onJump(entry.page)} title={`${entry.title} (${T.pageN(entry.page)})`} aria-label={`${entry.title || T.pageN(entry.page)}, ${T.pageN(entry.page).toLowerCase()}`}>
            <span className="pdfv-row-text">{entry.title || T.pageN(entry.page)}</span><span className="pdfv-row-page mono">{entry.page}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function BookmarkList({ bookmarks, renaming, setRenaming, onJump, onChange, onAdd, canAdd }: {
  bookmarks: readonly DocumentBookmark[]; renaming: string | null; setRenaming(id: string | null): void; onJump(bookmark: DocumentBookmark): void;
  onChange(next: DocumentBookmark[]): void; onAdd(): void; canAdd: boolean;
}) {
  const sorted = useMemo(() => [...bookmarks].sort((a, b) => a.page - b.page || (a.y ?? 0) - (b.y ?? 0)), [bookmarks]);
  const commit = (bookmark: DocumentBookmark, label: string) => {
    setRenaming(null);
    const next = label.trim();
    if (next && next !== bookmark.label) onChange(bookmarks.map(item => (item.id === bookmark.id ? { ...item, label: next } : item)));
  };
  return (
    <div className="pdfv-bookmarks">
      <button type="button" className="pdfv-chip pdfv-chip-primary pdfv-add" onClick={onAdd} disabled={!canAdd}><BookmarkPlus size={14} aria-hidden="true" />{T.addBookmarkHere}</button>
      {sorted.length ? (
        <ul className="pdfv-list">
          {sorted.map(bookmark => (
            <li key={bookmark.id} className="pdfv-bm">
              {renaming === bookmark.id ? (
                <input
                  className="pdfv-rename" autoFocus defaultValue={bookmark.label} aria-label={T.bookmarkLabel} maxLength={200}
                  onFocus={event => event.target.select()} onBlur={event => commit(bookmark, event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') commit(bookmark, event.currentTarget.value); else if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null); } }}
                />
              ) : (
                <button type="button" className="pdfv-row" onClick={() => onJump(bookmark)} title={`${bookmark.label} (${T.pageN(bookmark.page)})`} aria-label={`${bookmark.label}, ${T.pageN(bookmark.page).toLowerCase()}`}>
                  <BookmarkIcon size={13} aria-hidden="true" /><span className="pdfv-row-text">{bookmark.label}</span><span className="pdfv-row-page mono">{bookmark.page}</span>
                </button>
              )}
              <button type="button" className="pdfv-mini" aria-label={`${T.renameBookmark}: ${bookmark.label}`} title={T.renameBookmark} onClick={() => setRenaming(bookmark.id)}><Pencil size={13} aria-hidden="true" /></button>
              <button type="button" className="pdfv-mini" aria-label={`${T.deleteBookmark}: ${bookmark.label}`} title={T.deleteBookmark} onClick={() => onChange(bookmarks.filter(item => item.id !== bookmark.id))}><Trash2 size={13} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      ) : <p className="pdfv-empty">{T.noBookmarks}</p>}
    </div>
  );
}

function NoteList({ annotations, onOpen, onDelete }: { annotations: readonly DocumentAnnotation[]; onOpen(note: DocumentAnnotation): void; onDelete(note: DocumentAnnotation): void }) {
  const sorted = useMemo(() => [...annotations].sort((a, b) => a.page - b.page || a.y - b.y), [annotations]);
  if (!sorted.length) return <p className="pdfv-empty">{T.noNotes}</p>;
  return (
    <ul className="pdfv-list">
      {sorted.map(note => (
        <li key={note.id} className="pdfv-bm">
          <button type="button" className="pdfv-row" onClick={() => onOpen(note)} title={note.text} aria-label={`${note.text.split('\n')[0] || T.emptyNote}, ${T.pageN(note.page).toLowerCase()}`}>
            <StickyNote size={13} aria-hidden="true" /><span className="pdfv-row-text">{note.text.split('\n')[0] || T.emptyNote}</span><span className="pdfv-row-page mono">{note.page}</span>
          </button>
          <button type="button" className="pdfv-mini" aria-label={`${T.deleteNote}: ${note.text.slice(0, 40)}`} title={T.deleteNote} onClick={() => onDelete(note)}><Trash2 size={13} aria-hidden="true" /></button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Toolbar atoms

function IconButton({ label, onClick, disabled, pressed, children, hint, className }: {
  label: string; onClick(event: ReactMouseEvent<HTMLButtonElement>): void; disabled?: boolean; pressed?: boolean; children: ReactNode; hint?: string; className?: string;
}) {
  return <button type="button" className={className ? `pdfv-btn ${className}` : 'pdfv-btn'} aria-label={label} title={hint ?? label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{children}</button>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Search

/** `query` = the trimmed text the hits were found for (lets the viewer tell results of its own typing from restored/driven queries). */
interface SearchState { hits: readonly Hit[]; busy: boolean; error: string | null; query: string }
const IDLE_SEARCH: SearchState = { hits: NO_HITS, busy: false, error: null, query: '' };
function usePdfSearch(session: PdfSession, query: string, enabled: boolean, caseSensitive: boolean, wholeWord: boolean): SearchState {
  const [state, setState] = useState<SearchState>(IDLE_SEARCH);
  useEffect(() => {
    const text = query.trim();
    if (!enabled || !text) { setState(previous => (previous === IDLE_SEARCH ? previous : IDLE_SEARCH)); return; }
    const controller = new AbortController();
    setState(previous => ({ hits: previous.hits, busy: true, error: null, query: previous.query }));
    const timer = setTimeout(() => {
      session.find(text, { caseSensitive, wholeWord, maxHits: SEARCH_HIT_LIMIT, signal: controller.signal }).then(
        hits => { if (!controller.signal.aborted) setState({ hits, busy: false, error: null, query: text }); },
        error => { if (!controller.signal.aborted && !isAbort(error)) setState({ hits: NO_HITS, busy: false, error: errorMessage(error), query: text }); },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [session, query, enabled, caseSensitive, wholeWord]);
  return state;
}

// ---------------------------------------------------------------------------------------------------------------------
// The viewer

function ReadyViewer(props: PdfViewerProps & { handle: PdfHandle; snapshot: PdfSessionSnapshot }) {
  const { handle, snapshot, session, camera, theme, motion, compact = false, bookmarks, annotations, searchQuery } = props;
  const pageCount = handle.pageCount;
  const pad = compact ? PAD_COMPACT : PAD;
  const propsRef = useRef(props); propsRef.current = props;

  const [rotation, setRotation] = useState<ViewerRotation>(() => normalizeRotation(camera.rotation ?? 0));
  const [fit, setFit] = useState<Fit>(() => camera.fit ?? (camera.zoom !== undefined ? 'none' : 'width'));
  const [manualZoom, setManualZoom] = useState(() => clampZoom(camera.zoom ?? 1));
  const [fitPage, setFitPage] = useState(() => clamp(camera.page ?? 1, 1, Math.max(1, pageCount)));
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const [page, setPage] = useState(() => clamp(camera.page ?? 1, 1, Math.max(1, pageCount)));
  const [range, setRange] = useState<IndexRange>({ first: 0, last: 0 });
  const [navTick, setNavTick] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(!compact);
  const [tab, setTab] = useState<SidebarTab>('pages');
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const [zoomDraft, setZoomDraft] = useState<string | null>(null);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [activeHit, setActiveHit] = useState(-1);
  const [noteArmed, setNoteArmed] = useState(false);
  const [openNote, setOpenNote] = useState<OpenNote | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const rootRef = useRef<HTMLElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const navRef = useRef<Nav | null>(null);
  const lockRef = useRef<Lock | null>(null);
  const anchorRef = useRef<{ anchor: ScrollAnchor; at: number } | null>(null);
  const layoutRef = useRef<PageLayout | null>(null);
  const pageRef = useRef(page);
  const sizeBefore = useRef<(() => void) | null>(null);
  const emitted = useRef<Array<{ camera: ViewerCamera; at: number }>>([]);
  const frame = useRef(0);

  const { boxes, version, request } = usePageSizes(handle, sizeBefore, pageRef);
  const boxesRef = useRef(boxes);

  const mainCache = useMemo(() => new BoundedCache<string, HTMLCanvasElement>(MAIN_CANVAS_CACHE, releaseCanvas), []);
  const thumbCache = useMemo(() => new BoundedCache<string, HTMLCanvasElement>(THUMB_CANVAS_CACHE, releaseCanvas), []);
  const mainQueue = useMemo(() => new TaskQueue(2), []);
  const thumbQueue = useMemo(() => new TaskQueue(1), []);

  // ---- derived geometry
  const firstBox = useMemo(() => boxes.get(1) ?? boxes.values().next().value ?? LETTER, [boxes, version]);
  const estimate = useMemo(() => displaySize(firstBox, rotation), [firstBox, rotation]);
  const fitBox = boxes.get(fitPage) ?? firstBox;
  const zoom = fit === 'none' ? manualZoom : fitZoom(fit, viewport, displaySize(fitBox, rotation), pad);
  const layout = useMemo(() => {
    const sizes: Size[] = new Array(pageCount);
    for (let i = 0; i < pageCount; i++) { const box = boxes.get(i + 1); sizes[i] = box ? displaySize(box, rotation) : estimate; }
    return computeLayout(sizes, { zoom, gap: PAGE_GAP, padding: pad, viewportWidth: viewport.width });
  }, [boxes, version, rotation, estimate, zoom, pad, pageCount, viewport.width]);
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const rotationRef = useRef(rotation); rotationRef.current = rotation;
  const fitRef = useRef(fit); fitRef.current = fit;
  const viewportRef = useRef(viewport); viewportRef.current = viewport;
  const padRef = useRef(pad); padRef.current = pad;
  boxesRef.current = boxes;

  const pixelsOfPage = (index: number) => Math.min(16_000_000, layout.widths[index] * dpr * layout.heights[index] * dpr);
  const windowRange = useMemo(() => renderWindow(range, pageCount, pixelsOfPage, 1, RENDER_BUDGET_PIXELS), [range, layout, dpr, pageCount]);

  // ---- debug-friendly counters (read by the QA harness, cheap DOM writes)
  const publishStats = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    element.dataset.canvasesAttached = String(element.querySelectorAll('.pdfv-page canvas').length);
    element.dataset.canvasesCached = String(mainCache.size);
    element.dataset.pagesMounted = String(element.querySelectorAll('.pdfv-page').length);
  }, [mainCache]);

  // ---- camera out: computed from the DOM on every scroll/zoom tick, delivered throttled, and only when it really changed
  const latestCamera = useRef<ViewerCamera | null>(null);
  const lastSent = useRef<ViewerCamera | null>(null);
  const computeCamera = useCallback((): ViewerCamera | null => {
    const element = scrollerRef.current, lay = layoutRef.current;
    if (!element || !lay || lay.count === 0) return null;
    const current = pageRef.current, box = boxesRef.current.get(current), z = zoomRef.current;
    const next: ViewerCamera = { page: current, zoom: round(z, 4), rotation: rotationRef.current, fit: fitRef.current };
    if (box && current <= lay.count) {
      const index = current - 1;
      const point = unrotatePoint((element.scrollLeft - pageLeft(lay, index)) / z, (element.scrollTop - lay.tops[index]) / z, box.width, box.height, displayRotation(box.rotation, rotationRef.current));
      next.x = round(point.x, 2); next.y = round(point.y, 2);
    }
    return next;
  }, []);
  const emitCamera = useCallback(() => {
    const next = latestCamera.current, previous = lastSent.current;
    if (!next || navRef.current) return; // a pending jump means the scroll position is not the intended one yet
    if (previous && cameraMatches(next, previous) && cameraMatches(previous, next)) return;
    const now = Date.now();
    emitted.current = [...emitted.current.filter(entry => now - entry.at < ECHO_WINDOW_MS), { camera: next, at: now }];
    lastSent.current = next;
    propsRef.current.onCameraChange(next);
  }, []);
  const cameraThrottle = useMemo(() => createThrottle(emitCamera, CAMERA_THROTTLE_MS), [emitCamera]);
  const touchCamera = useCallback(() => {
    const next = computeCamera();
    if (next) latestCamera.current = next;
    cameraThrottle.call();
  }, [computeCamera, cameraThrottle]);

  // ---- scroll bookkeeping
  const syncFromScroll = useCallback(() => {
    const element = scrollerRef.current, lay = layoutRef.current;
    if (!element || !lay) return;
    const top = element.scrollTop, height = element.clientHeight;
    const visible = visibleRange(lay, top, height);
    setRange(previous => (sameRange(previous, visible) ? previous : visible));
    let current = currentPageIndex(lay, top, height) + 1;
    const lock = lockRef.current;
    if (lock) {
      if (Math.abs(top - lock.top) < 2 && Math.abs(element.scrollLeft - lock.left) < 2) lock.reached = true;
      if (lock.reached && Math.abs(top - lock.top) >= 2) lockRef.current = null; else current = lock.page;
    }
    pageRef.current = current;
    setPage(previous => (previous === current ? previous : current));
    touchCamera();
  }, [touchCamera]);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; syncFromScroll(); });
  }, [syncFromScroll]);
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);

  const captureViewAnchor = useCallback((ax: number, ay: number) => {
    const element = scrollerRef.current, lay = layoutRef.current;
    const now = performance.now();
    if (!element || !lay || (anchorRef.current && now - anchorRef.current.at < 250)) return; // the first capture of a burst describes the layout the reader last saw
    const anchor = captureAnchor(lay, element.scrollTop, element.scrollLeft, ax, ay);
    anchorRef.current = anchor ? { anchor, at: now } : null;
  }, []);
  sizeBefore.current = () => captureViewAnchor(0, 0);

  // ---- navigation
  const goToPage = useCallback((target: number, extra: Omit<Nav, 'page'> = {}) => {
    const clamped = clamp(Math.round(target), 1, Math.max(1, pageCount));
    navRef.current = { page: clamped, ...extra };
    request(clamped);
    setNavTick(tick => tick + 1);
  }, [pageCount, request]);

  const applyNav = useCallback((): boolean => {
    const nav = navRef.current, element = scrollerRef.current, lay = layoutRef.current;
    if (!nav || !element || !lay || viewportRef.current.width <= 0) return false;
    const index = nav.page - 1;
    if (index < 0 || index >= lay.count) { navRef.current = null; return false; }
    const box = boxesRef.current.get(nav.page);
    if ((nav.point || nav.rect) && !box) { request(nav.page); return false; }
    const z = zoomRef.current, originX = pageLeft(lay, index), originY = lay.tops[index];
    const turned = box ? displayRotation(box.rotation, rotationRef.current) : 0;
    let top = originY - Math.min(padRef.current, 8), left = element.scrollLeft;
    if (nav.rect && box) {
      const r = rotateRect(nav.rect, box.width, box.height, turned);
      const target = { left: originX + r.x * z, top: originY + r.y * z, width: r.width * z, height: r.height * z };
      const view = { width: element.clientWidth, height: element.clientHeight };
      if (isRectVisible(target, element.scrollLeft, element.scrollTop, view, 48)) { navRef.current = null; return false; }
      top = target.top + target.height / 2 - view.height / 2; left = target.left + target.width / 2 - view.width / 2;
    } else if (nav.point && box) {
      const p = rotatePoint(nav.point.x, nav.point.y, box.width, box.height, turned);
      top = originY + p.y * z; left = originX + p.x * z;
    }
    top = clamp(top, 0, Math.max(0, lay.total - element.clientHeight));
    left = clamp(left, 0, Math.max(0, lay.contentWidth - element.clientWidth));
    navRef.current = null;
    const smooth = propsRef.current.motion && !prefersReducedMotion() && !nav.instant && Math.abs(top - element.scrollTop) < element.clientHeight * 1.5;
    lockRef.current = { page: nav.page, top, left, reached: false };
    pageRef.current = nav.page;
    setPage(nav.page);
    element.scrollTo({ top, left, behavior: smooth ? 'smooth' : 'instant' });
    return true;
  }, [request]);

  // After every layout change (zoom, rotation, size discovery, resize): honour a pending jump, else keep the reader's anchor.
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    layoutRef.current = layout;
    if (!element) return;
    const moved = navRef.current ? applyNav() : false;
    const pending = anchorRef.current;
    anchorRef.current = null;
    if (!moved && pending && performance.now() - pending.at < 1000) {
      const target = resolveAnchor(layout, pending.anchor);
      if (target && (Math.abs(target.top - element.scrollTop) > 0.5 || Math.abs(target.left - element.scrollLeft) > 0.5)) { element.scrollTop = target.top; element.scrollLeft = target.left; }
    }
    syncFromScroll();
  }, [layout, navTick, applyNav, syncFromScroll]);

  // Viewport size and device pixel ratio
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      const previous = viewportRef.current;
      if (next.width === previous.width && next.height === previous.height) return;
      if (next.width !== previous.width) captureViewAnchor(0, 0);
      setViewport(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const onResize = () => setDpr(window.devicePixelRatio || 1);
    window.addEventListener('resize', onResize);
    return () => { observer.disconnect(); window.removeEventListener('resize', onResize); };
  }, [captureViewAnchor]);

  // Stale canvases of another scale or rotation can never be reused
  useEffect(() => { mainCache.clear(); }, [zoom, rotation, dpr, mainCache]);
  useEffect(() => { thumbCache.clear(); }, [rotation, dpr, thumbCache]);
  useEffect(() => {
    mainCache.open(); thumbCache.open();
    return () => { mainCache.close(); thumbCache.close(); cameraThrottle.flush(); }; // closed caches dispose late arrivals instead of keeping canvases alive
  }, [mainCache, thumbCache, cameraThrottle]);
  const compactBefore = useRef(compact);
  useEffect(() => { if (compactBefore.current !== compact) { compactBefore.current = compact; setSidebarOpen(!compact); } }, [compact]);
  useEffect(() => { publishStats(); }, [windowRange.first, windowRange.last, version, zoom, rotation, publishStats]);
  useEffect(() => { touchCamera(); }, [zoom, rotation, fit, touchCamera]);

  // ---- camera in (restore on mount, then external changes that are not echoes of what was emitted)
  const applyCamera = useCallback((incoming: ViewerCamera) => {
    if (incoming.rotation !== undefined) { const next = normalizeRotation(incoming.rotation); if (next !== rotationRef.current) setRotation(next); }
    if (incoming.fit && incoming.fit !== 'none') { setFit(incoming.fit); setFitPage(clamp(incoming.page ?? pageRef.current, 1, Math.max(1, pageCount))); }
    else if (incoming.zoom !== undefined) { setFit('none'); setManualZoom(clampZoom(incoming.zoom)); }
    else if (incoming.fit === 'none') { setManualZoom(zoomRef.current); setFit('none'); }
    if (incoming.page !== undefined) goToPage(incoming.page, incoming.x !== undefined && incoming.y !== undefined ? { point: { x: incoming.x, y: incoming.y }, instant: true } : { instant: true });
  }, [goToPage, pageCount]);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; if (camera.page !== undefined || camera.x !== undefined) applyCamera(camera); return; }
    const now = Date.now();
    if (emitted.current.some(entry => now - entry.at < ECHO_WINDOW_MS && cameraMatches(camera, entry.camera))) return;
    const current: ViewerCamera = { page: pageRef.current, zoom: zoomRef.current, rotation: rotationRef.current, fit: fitRef.current };
    if (cameraMatches(camera, current) && camera.x === undefined) return;
    applyCamera(camera);
  }, [camera, applyCamera]);

  // ---- user actions: zoom, fit, rotate, page
  const zoomTo = useCallback((next: number, anchor?: { x: number; y: number }) => {
    const element = scrollerRef.current;
    if (!element) return;
    captureViewAnchor(anchor?.x ?? element.clientWidth / 2, anchor?.y ?? element.clientHeight / 2);
    lockRef.current = null;
    setFit('none');
    setManualZoom(clampZoom(next));
  }, [captureViewAnchor]);
  const stepZoomBy = useCallback((direction: 1 | -1) => zoomTo(stepZoom(zoomRef.current, direction)), [zoomTo]);
  const fitTo = useCallback((mode: 'width' | 'page') => {
    captureViewAnchor(0, 0);
    lockRef.current = null;
    setFit(mode); setFitPage(pageRef.current);
  }, [captureViewAnchor]);
  const rotateBy = useCallback((delta: number) => {
    setRotation(normalizeRotation(rotationRef.current + delta));
    goToPage(pageRef.current, { instant: true });
  }, [goToPage]);
  const jumpBy = useCallback((delta: number) => goToPage(pageRef.current + delta), [goToPage]);

  useEffect(() => { // Ctrl/Cmd + wheel (and pinch gestures, which Chromium reports the same way) zooms around the pointer
    const element = scrollerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      zoomTo(zoomRef.current * Math.exp(-event.deltaY * 0.0025), { x: event.clientX - box.left, y: event.clientY - box.top });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // ---- search
  const searchable = snapshot.searchable;
  const search = usePdfSearch(session, searchQuery, searchable !== false, caseSensitive, wholeWord);
  const hits = search.hits;
  const hitsRef = useRef(hits); hitsRef.current = hits;
  const activeHitRef = useRef(activeHit); activeHitRef.current = activeHit;
  const hitsByPage = useMemo(() => groupByPage(hits, HIGHLIGHTS_PER_PAGE), [hits]);
  const activeHitObject = activeHit >= 0 && activeHit < hits.length ? hits[activeHit] : null;
  const revealHit = useCallback((hit: Hit) => goToPage(hit.page, { rect: { x: hit.x, y: hit.y, width: hit.width, height: hit.height } }), [goToPage]);
  // B46: results move the camera only when the user just typed/changed options in this viewer's own field. A query restored by the
  // shell (remount, unified search) still gets its hits drawn and counted, but never scrolls the page the user is reading.
  const searchIntent = useRef<string | null>(null);
  const markSearchIntent = useCallback((text: string) => { searchIntent.current = text.trim() || null; }, []);
  const resultQuery = search.query;
  useEffect(() => { // new results: the first match on or after the page being read becomes the active one
    const index = nearestHitIndex(hits, pageRef.current);
    activeHitRef.current = index;
    setActiveHit(index);
    const wanted = searchIntent.current !== null && searchIntent.current === resultQuery;
    searchIntent.current = null;
    if (index >= 0 && wanted) revealHit(hits[index]);
  }, [hits, resultQuery, revealHit]);
  const stepHit = useCallback((delta: number) => {
    const current = hitsRef.current, previous = activeHitRef.current;
    if (!current.length) return;
    const next = wrapIndex(previous < 0 ? (delta > 0 ? -1 : 0) : previous, delta, current.length);
    activeHitRef.current = next;
    setActiveHit(next);
    revealHit(current[next]);
  }, [revealHit]);
  const nonce = props.focusSearchNonce;
  const firstNonce = useRef(nonce);
  const focusSearch = useCallback(() => {
    const input = searchRef.current;
    if (input && !input.disabled) { input.focus(); input.select(); }
  }, []);
  useEffect(() => { if (nonce !== firstNonce.current) focusSearch(); }, [nonce, focusSearch]);

  // ---- external highlights / probe regions
  const externalByPage = useMemo(() => groupByPage(props.highlights, HIGHLIGHTS_PER_PAGE), [props.highlights]);
  const probesByPage = useMemo(() => groupByPage(props.probeRegions, HIGHLIGHTS_PER_PAGE), [props.probeRegions]);
  const activeExternal = useMemo(() => (props.highlights ?? []).find(item => item.active && item.page !== undefined) ?? null, [props.highlights]);
  const activeExternalKey = activeExternal ? `${activeExternal.id}|${activeExternal.page}|${activeExternal.rect.x}|${activeExternal.rect.y}` : '';
  // B46: the active highlight/probe target is navigated to only after a fresh explicit intent (navigateNonce changed after mount).
  // The intent stays armed briefly so a highlight that arrives in the commit after the nonce is still honoured, then expires.
  const navigateNonce = props.navigateNonce;
  const seenNavigateNonce = useRef(navigateNonce);
  const navigateArmedUntil = useRef(0);
  useEffect(() => {
    if (navigateNonce !== seenNavigateNonce.current) { seenNavigateNonce.current = navigateNonce; navigateArmedUntil.current = Date.now() + NAVIGATE_INTENT_MS; }
    if (navigateArmedUntil.current > Date.now() && activeExternal && activeExternal.page !== undefined) {
      navigateArmedUntil.current = 0;
      goToPage(activeExternal.page, { rect: activeExternal.rect });
    }
  }, [navigateNonce, activeExternalKey]);

  // ---- notes and bookmarks
  const notesByPage = useMemo(() => groupByPage(annotations), [annotations]);
  const openNoteRef = useRef(openNote); openNoteRef.current = openNote;
  const draftNote = openNote?.draft ? { id: openNote.id, text: '', x: openNote.draft.x, y: openNote.draft.y, page: openNote.draft.page } : null;
  const focusMarker = (id: string) => requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-note-marker="${CSS.escape(id)}"]`)?.focus());
  const actions = useMemo<PageActions>(() => ({
    probeClick: id => propsRef.current.onProbeRegionClick?.(id),
    placeNote: (target, x, y) => { setNoteArmed(false); setOpenNote({ id: newId(), draft: { page: target, x: round(x, 2), y: round(y, 2) } }); },
    openNote: id => setOpenNote(id ? { id } : null),
    commitNote: (id, text, refocus) => {
      const { annotations: current, onAnnotationsChange } = propsRef.current;
      const open = openNoteRef.current;
      const updatedAt = new Date().toISOString();
      if (open?.id === id && open.draft) {
        if (text.trim()) onAnnotationsChange([...current, { id, page: open.draft.page, x: open.draft.x, y: open.draft.y, text, updatedAt }]);
      } else {
        const existing = current.find(item => item.id === id);
        if (existing && !text.trim()) onAnnotationsChange(current.filter(item => item.id !== id));
        else if (existing && existing.text !== text) onAnnotationsChange(current.map(item => (item.id === id ? { ...item, text, updatedAt } : item)));
      }
      setOpenNote(null);
      if (refocus) focusMarker(id);
    },
    deleteNote: id => {
      const { annotations: current, onAnnotationsChange } = propsRef.current;
      if (current.some(item => item.id === id)) onAnnotationsChange(current.filter(item => item.id !== id));
      setOpenNote(null);
      scrollerRef.current?.focus({ preventScroll: true });
    },
  }), []);
  const canAnnotate = annotations.length < WORKSPACE_LIMITS.annotations;
  const startNote = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!canAnnotate) return;
    if (noteArmed) { setNoteArmed(false); return; }
    if (event.detail !== 0) { setNoteArmed(true); return; } // pointer: place by clicking on the page
    const element = scrollerRef.current, lay = layoutRef.current, box = boxesRef.current.get(pageRef.current);
    if (!element || !lay || !box) return; // keyboard: drop the note at the middle of the visible part of the current page
    const index = pageRef.current - 1, z = zoomRef.current, turned = displayRotation(box.rotation, rotationRef.current);
    const centre = { x: element.scrollLeft + element.clientWidth / 2 - pageLeft(lay, index), y: element.scrollTop + element.clientHeight / 2 - lay.tops[index] };
    const shown = displaySize(box, rotationRef.current);
    const point = unrotatePoint(clamp(centre.x / z, 0, shown.width), clamp(centre.y / z, 0, shown.height), box.width, box.height, turned);
    actions.placeNote(pageRef.current, point.x, point.y);
  };
  const addBookmark = useCallback(() => {
    const { bookmarks: current, onBookmarksChange } = propsRef.current;
    if (current.length >= WORKSPACE_LIMITS.bookmarks) return;
    const element = scrollerRef.current, lay = layoutRef.current, target = pageRef.current, box = boxesRef.current.get(target);
    const bookmark: DocumentBookmark = { id: newId(), page: target, label: T.pageN(target) };
    if (element && lay && box) {
      const z = zoomRef.current, index = target - 1, shown = displaySize(box, rotationRef.current);
      // bookmarks stay inside the page even when the viewport corner is in the margin above it
      const inside = unrotatePoint(clamp((element.scrollLeft - pageLeft(lay, index)) / z, 0, shown.width), clamp((element.scrollTop - lay.tops[index]) / z, 0, shown.height), box.width, box.height, displayRotation(box.rotation, rotationRef.current));
      bookmark.x = round(inside.x, 2); bookmark.y = round(inside.y, 2);
    }
    onBookmarksChange([...current, bookmark]);
    setSidebarOpen(true); setTab('bookmarks'); setRenaming(bookmark.id);
  }, []);

  // ---- keyboard (scoped to this pane: the handler lives on the viewer root)
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    lockRef.current = null;
    const target = event.target as HTMLElement;
    const typing = target.matches('input, textarea, select, [contenteditable="true"]');
    const mod = event.ctrlKey || event.metaKey;
    if (mod && (event.key === 'f' || event.key === 'F')) { event.preventDefault(); focusSearch(); return; }
    if (event.key === 'Escape') {
      if (noteArmed) { setNoteArmed(false); event.stopPropagation(); }
      else if (openNote) { setOpenNote(null); event.stopPropagation(); }
      else if (compact && sidebarOpen && !typing) { setSidebarOpen(false); event.stopPropagation(); }
      return;
    }
    if (typing) return;
    if (event.key === 'F3') { event.preventDefault(); stepHit(event.shiftKey ? -1 : 1); return; }
    if (mod && event.key === '0') { event.preventDefault(); zoomTo(1); return; }
    if (mod || event.altKey) return;
    switch (event.key) {
      case 'PageDown': case 'PageUp': {
        const element = scrollerRef.current, lay = layoutRef.current;
        if (element && lay && lay.heights[pageRef.current - 1] <= element.clientHeight) { event.preventDefault(); jumpBy(event.key === 'PageDown' ? 1 : -1); }
        break; // taller pages keep the native screen-wise scrolling
      }
      case '+': case '=': event.preventDefault(); stepZoomBy(1); break;
      case '-': case '_': event.preventDefault(); stepZoomBy(-1); break;
      default:
    }
  };

  // ---- derived UI state
  const pageText = pageDraft ?? String(page);
  const zoomText = zoomDraft ?? formatZoom(zoom);
  const commitPage = () => {
    const value = Number(pageDraft);
    setPageDraft(null);
    if (Number.isInteger(value) && value >= 1) { goToPage(value); scrollerRef.current?.focus({ preventScroll: true }); }
  };
  const commitZoom = () => {
    const parsed = zoomDraft === null ? null : parseZoomInput(zoomDraft);
    setZoomDraft(null);
    if (parsed !== null && Math.abs(parsed - zoomRef.current) > 0.0005) zoomTo(parsed);
  };
  const effectiveTab: SidebarTab = compact && tab === 'pages' ? 'outline' : tab;
  const jumpFromSidebar = useCallback((target: number, extra: Omit<Nav, 'page'> = {}) => { goToPage(target, { instant: true, ...extra }); if (compact) setSidebarOpen(false); }, [compact, goToPage]);
  const thumbJump = useCallback((target: number) => jumpFromSidebar(target), [jumpFromSidebar]);
  const index = snapshot.index;
  const limited = hits.length >= SEARCH_HIT_LIMIT;
  const countText = search.busy ? T.searching : searchQuery.trim() && searchable !== false ? (hits.length ? `${Math.max(activeHit, 0) + 1} / ${hits.length.toLocaleString('en')}${limited ? '+' : ''}` : search.error ? '' : T.noMatches) : '';
  const notices: Array<{ key: string; tone: 'info' | 'warn'; icon: ReactNode; text: string; progress?: number }> = [];
  if (searchable === false) notices.push({ key: 'raster', tone: 'warn', icon: <ScanLine size={14} aria-hidden="true" />, text: T.noTextLayer });
  else if (index.state === 'building') notices.push({ key: 'building', tone: 'info', icon: <LoaderCircle size={14} className="pdfv-spin" aria-hidden="true" />, text: T.indexing(index.indexedPages, index.pageCount), progress: index.pageCount ? index.indexedPages / index.pageCount : 0 });
  else if (index.state === 'truncated') notices.push({ key: 'truncated', tone: 'warn', icon: <TriangleAlert size={14} aria-hidden="true" />, text: T.truncated(index.indexedPages, index.pageCount) });
  else if (index.state === 'error') notices.push({ key: 'index-error', tone: 'warn', icon: <TriangleAlert size={14} aria-hidden="true" />, text: T.indexFailed });
  if (search.error) notices.push({ key: 'search-error', tone: 'warn', icon: <TriangleAlert size={14} aria-hidden="true" />, text: T.searchFailed(search.error) });
  if (limited) notices.push({ key: 'limit', tone: 'info', icon: <Search size={14} aria-hidden="true" />, text: T.hitLimit(SEARCH_HIT_LIMIT) });

  // ---- pages in the window
  const pageNodes: ReactNode[] = [];
  const noHighlights: readonly ViewerHighlight[] = NO_ITEMS, noProbes: readonly ViewerProbeRegion[] = NO_ITEMS;
  for (let i = windowRange.first; i <= windowRange.last; i++) {
    const number = i + 1;
    const notes = notesByPage.get(number) ?? NO_ITEMS;
    const draft = draftNote && draftNote.page === number ? [...notes, draftNote] : notes;
    pageNodes.push(
      <PdfPage
        key={number} handle={handle} page={number} box={boxes.get(number)} estimate={estimate} zoom={zoom} userRotation={rotation} dpr={dpr}
        top={layout.tops[i]} left={pageLeft(layout, i)} width={layout.widths[i]} height={layout.heights[i]} visible={i >= range.first && i <= range.last}
        cache={mainCache} queue={mainQueue} onCanvasChange={publishStats}
        hits={hitsByPage.get(number) ?? NO_HITS} activeHit={activeHitObject && activeHitObject.page === number ? activeHitObject : null}
        highlights={externalByPage.get(number) ?? noHighlights} probes={probesByPage.get(number) ?? noProbes}
        notes={draft} openNote={openNote} noteArmed={noteArmed} actions={actions}
      />,
    );
  }

  const tabs: Array<{ id: SidebarTab; label: string; icon: ReactNode; count?: number }> = [];
  if (!compact) tabs.push({ id: 'pages', label: T.pages, icon: <Images size={15} aria-hidden="true" /> });
  tabs.push({ id: 'outline', label: T.outline, icon: <ListTree size={15} aria-hidden="true" />, count: snapshot.outline.length });
  tabs.push({ id: 'bookmarks', label: T.bookmarks, icon: <BookmarkIcon size={15} aria-hidden="true" />, count: bookmarks.length });
  tabs.push({ id: 'notes', label: T.notes, icon: <StickyNote size={15} aria-hidden="true" />, count: annotations.length });
  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = tabs.findIndex(item => item.id === effectiveTab);
    const next = tabs[wrapIndex(at, step, tabs.length)];
    setTab(next.id);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus());
  };

  return (
    <section
      ref={rootRef} className="pdfv" data-theme={theme} data-motion={motion ? 'on' : 'off'} data-compact={compact ? 'true' : 'false'} data-sidebar={sidebarOpen ? 'open' : 'closed'}
      data-page={page} data-zoom={round(zoom, 4)} data-rotation={rotation} data-fit={fit} style={{ colorScheme: theme }} onKeyDown={onKeyDown}
    >
      <div className="pdfv-toolbar" role="toolbar" aria-label={T.toolbar}>
        <div className="pdfv-bar">
          <IconButton label={sidebarOpen ? T.sidebarHide : T.sidebarShow} pressed={sidebarOpen} onClick={() => setSidebarOpen(open => !open)}><PanelLeft size={16} aria-hidden="true" /></IconButton>
          <div className="pdfv-group" role="group" aria-label={T.pageGroup}>
            <IconButton label={T.prevPage} hint={`${T.prevPage} (PageUp)`} disabled={page <= 1} onClick={() => jumpBy(-1)}><ChevronUp size={16} aria-hidden="true" /></IconButton>
            <input
              className="pdfv-num mono" aria-label={T.pageInput} inputMode="numeric" value={pageText} size={Math.max(2, String(pageCount).length)}
              onFocus={event => event.target.select()} onChange={event => setPageDraft(event.target.value)} onBlur={() => setPageDraft(null)}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitPage(); } else if (event.key === 'Escape') { setPageDraft(null); event.currentTarget.blur(); } }}
            />
            <span className="pdfv-of mono" aria-hidden="true">/ {pageCount}</span>
            <IconButton label={T.nextPage} hint={`${T.nextPage} (PageDown)`} disabled={page >= pageCount} onClick={() => jumpBy(1)}><ChevronDown size={16} aria-hidden="true" /></IconButton>
          </div>
          <div className="pdfv-group" role="group" aria-label={T.zoomGroup}>
            <IconButton label={T.zoomOut} onClick={() => stepZoomBy(-1)} disabled={zoom <= 0.1001}><ZoomOut size={16} aria-hidden="true" /></IconButton>
            <input
              className="pdfv-num pdfv-zoom mono" aria-label={T.zoomInput} inputMode="decimal" value={zoomText} size={5}
              onFocus={event => { setZoomDraft(formatZoom(zoomRef.current).replace('%', '')); event.target.select(); }} onChange={event => setZoomDraft(event.target.value)} onBlur={commitZoom}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitZoom(); scrollerRef.current?.focus({ preventScroll: true }); } else if (event.key === 'Escape') { setZoomDraft(null); event.currentTarget.blur(); } }}
            />
            <IconButton label={T.zoomIn} onClick={() => stepZoomBy(1)} disabled={zoom >= 7.999}><ZoomIn size={16} aria-hidden="true" /></IconButton>
            <IconButton label={T.fitWidth} pressed={fit === 'width'} onClick={() => fitTo('width')}><MoveHorizontal size={16} aria-hidden="true" /></IconButton>
            <IconButton label={T.fitPage} pressed={fit === 'page'} onClick={() => fitTo('page')}><Maximize size={16} aria-hidden="true" /></IconButton>
          </div>
          <div className="pdfv-group" role="group" aria-label={T.viewGroup}>
            <IconButton label={T.rotateLeft} onClick={() => rotateBy(-90)}><RotateCcw size={16} aria-hidden="true" /></IconButton>
            <IconButton label={T.rotateRight} onClick={() => rotateBy(90)}><RotateCw size={16} aria-hidden="true" /></IconButton>
          </div>
        </div>
        <div className="pdfv-bar pdfv-bar-end">
          <div className="pdfv-group" role="group" aria-label={T.marksGroup}>
            <IconButton label={T.addBookmark} onClick={addBookmark} disabled={bookmarks.length >= WORKSPACE_LIMITS.bookmarks}><BookmarkPlus size={16} aria-hidden="true" /></IconButton>
            <IconButton label={noteArmed ? T.noteCancel : T.addNote} hint={noteArmed ? T.noteCancel : `${T.addNote}. Keyboard: ${T.addNoteKeyboard}`} pressed={noteArmed} onClick={startNote} disabled={!canAnnotate}><StickyNote size={16} aria-hidden="true" /></IconButton>
          </div>
          <div className="pdfv-search" role="search" data-disabled={searchable === false ? 'true' : undefined}>
            <Search size={14} aria-hidden="true" className="pdfv-search-icon" />
            <input
              ref={searchRef} className="pdfv-search-input" type="text" value={searchQuery} placeholder={T.searchPlaceholder} aria-label={T.searchLabel} disabled={searchable === false}
              spellCheck={false} autoComplete="off" onChange={event => { markSearchIntent(event.target.value); props.onSearchQueryChange(event.target.value); }}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); stepHit(event.shiftKey ? -1 : 1); }
                else if (event.key === 'Escape') { event.stopPropagation(); if (searchQuery) props.onSearchQueryChange(''); else scrollerRef.current?.focus({ preventScroll: true }); }
              }}
            />
            {searchQuery ? <button type="button" className="pdfv-mini" aria-label={T.searchClear} title={T.searchClear} onClick={() => { props.onSearchQueryChange(''); searchRef.current?.focus(); }}><X size={13} aria-hidden="true" /></button> : null}
            <button type="button" className="pdfv-mini" aria-label={T.caseSensitive} title={T.caseSensitive} aria-pressed={caseSensitive} disabled={searchable === false} onClick={() => { markSearchIntent(searchQuery); setCaseSensitive(value => !value); }}><CaseSensitive size={15} aria-hidden="true" /></button>
            <button type="button" className="pdfv-mini" aria-label={T.wholeWord} title={T.wholeWord} aria-pressed={wholeWord} disabled={searchable === false} onClick={() => { markSearchIntent(searchQuery); setWholeWord(value => !value); }}><WholeWord size={15} aria-hidden="true" /></button>
            <span className="pdfv-count mono" role="status" aria-live="polite" data-testid="pdfv-count">{countText}</span>
            <IconButton label={T.prevHit} onClick={() => stepHit(-1)} disabled={hits.length === 0}><ChevronUp size={15} aria-hidden="true" /></IconButton>
            <IconButton label={T.nextHit} onClick={() => stepHit(1)} disabled={hits.length === 0}><ChevronDown size={15} aria-hidden="true" /></IconButton>
          </div>
        </div>
      </div>
      {notices.length ? (
        <div className="pdfv-notices" role="status" aria-live="polite">
          {notices.map(notice => (
            <p key={notice.key} className={`pdfv-notice is-${notice.tone}`} data-notice={notice.key}>
              {notice.icon}<span>{notice.text}</span>
              {notice.progress !== undefined ? <span className="pdfv-progress" aria-hidden="true"><span style={{ width: `${Math.round(notice.progress * 100)}%` }} /></span> : null}
            </p>
          ))}
        </div>
      ) : null}
      <div className="pdfv-body">
        {sidebarOpen ? (
          <aside className="pdfv-sidebar" aria-label={T.sidebarTabs}>
            <div className="pdfv-tabs" role="tablist" aria-label={T.sidebarTabs} onKeyDown={onTabKey}>
              {tabs.map(item => (
                <button key={item.id} type="button" role="tab" id={`pdfv-tab-${item.id}`} data-tab={item.id} aria-selected={effectiveTab === item.id} aria-controls="pdfv-panel" tabIndex={effectiveTab === item.id ? 0 : -1} title={item.label} aria-label={item.label} className={effectiveTab === item.id ? 'pdfv-tab is-active' : 'pdfv-tab'} onClick={() => setTab(item.id)}>
                  {item.icon}{item.count ? <span className="pdfv-badge mono">{item.count > 99 ? '99+' : item.count}</span> : null}
                </button>
              ))}
            </div>
            <div className="pdfv-panel" id="pdfv-panel" role="tabpanel" aria-labelledby={`pdfv-tab-${effectiveTab}`}>
              {effectiveTab === 'pages' ? <ThumbList handle={handle} pageCount={pageCount} boxes={boxes} version={version} rotation={rotation} current={page} dpr={dpr} request={request} onJump={thumbJump} cache={thumbCache} queue={thumbQueue} /> : null}
              {effectiveTab === 'outline' ? <div className="pdfv-scroll"><OutlineList outline={snapshot.outline} current={page} onJump={target => jumpFromSidebar(target)} /></div> : null}
              {effectiveTab === 'bookmarks' ? (
                <div className="pdfv-scroll">
                  <BookmarkList
                    bookmarks={bookmarks} renaming={renaming} setRenaming={setRenaming} onAdd={addBookmark} canAdd={bookmarks.length < WORKSPACE_LIMITS.bookmarks}
                    onChange={props.onBookmarksChange}
                    onJump={bookmark => jumpFromSidebar(bookmark.page, bookmark.x !== undefined && bookmark.y !== undefined ? { point: { x: bookmark.x, y: bookmark.y } } : {})}
                  />
                </div>
              ) : null}
              {effectiveTab === 'notes' ? (
                <div className="pdfv-scroll">
                  <NoteList
                    annotations={annotations}
                    onOpen={note => { jumpFromSidebar(note.page, { rect: { x: note.x - 24, y: note.y - 24, width: 48, height: 48 } }); setOpenNote({ id: note.id }); }}
                    onDelete={note => { if (openNote?.id === note.id) setOpenNote(null); props.onAnnotationsChange(annotations.filter(item => item.id !== note.id)); }}
                  />
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}
        <div className="pdfv-main">
          <div
            ref={scrollerRef} className="pdfv-scroller" tabIndex={0} role="region" aria-label={T.pagesRegion} data-note-mode={noteArmed ? 'true' : undefined}
            onScroll={onScroll} onWheel={() => { lockRef.current = null; }} onPointerDown={() => { lockRef.current = null; }} onTouchStart={() => { lockRef.current = null; }}
          >
            <div className="pdfv-pages" style={{ width: layout.contentWidth, height: layout.total }}>{pageNodes}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
