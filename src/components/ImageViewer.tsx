import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import {
  Bookmark as BookmarkIcon, Check, Eraser, Hand, ImageOff, LoaderCircle, Maximize2, MapPin, MoveHorizontal, PanelRight, Pencil, Ruler,
  RulerDimensionLine, RotateCcw, RotateCw, ShieldAlert, Trash2, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { WORKSPACE_LIMITS } from '../lib/documents';
import type { DocumentAnnotation, DocumentBookmark } from '../lib/documents';
import {
  calibrate, cameraToView, clamp, clampCenter, fitViewMode, formatMeasurement, hitTestMarker, ImageError, imageToScreen, isValidCalibration, loadImageDocument,
  nextRotation, panBy, parseKnownDistanceMm, pixelDistance, sameCamera, screenToImage, viewToCamera, visibleImageRect, zoomAt,
} from '../lib/images';
import type { CameraState, ImageDocument, ImageErrorCode, ImageKind, Point, ViewState } from '../lib/images';
import type { ImageViewerProps } from './viewer-contracts';
import './image-viewer.css';

// i18n: pending (English constants)
const TEXT = {
  region: 'Image viewer',
  toolbar: 'Image tools',
  pan: 'Select and pan (V)',
  calibrate: 'Calibrate scale (C)',
  measure: 'Measure distance (M)',
  note: 'Add note (N)',
  zoomIn: 'Zoom in (+)',
  zoomOut: 'Zoom out (-)',
  actualSize: 'Actual size, 100% (0)',
  fit: 'Fit image to view (F)',
  fitWidth: 'Fit to width (W)',
  rotateLeft: 'Rotate counter-clockwise (Shift+R)',
  rotateRight: 'Rotate clockwise (R)',
  addBookmark: 'Add bookmark at the view centre (B)',
  clearCalibration: 'Clear calibration',
  panel: 'Bookmarks and notes',
  keys: 'Image. Plus and minus zoom, 0 shows 100 percent, F fits the image, R rotates, arrow keys pan. V, C, M and N choose a tool, Enter picks a point at the cursor or the view centre, Escape cancels the tool.',
  loading: 'Decoding image',
  notCalibrated: 'Not calibrated: distances are in image pixels only',
  outside: 'Pick a point inside the image.',
  samePoint: 'The two points are less than one image pixel apart. Pick points farther apart.',
  shortReference: 'Short reference: a longer known distance gives a more accurate scale.',
  distanceLabel: 'Real distance between the two points',
  distanceHint: 'Enter the real distance in millimetres, for example 25.4.',
  noteEmpty: 'Enter some text, or cancel.',
  limitBookmarks: 'The bookmark limit for this document has been reached.',
  limitNotes: 'The note limit for this document has been reached.',
  sanitized: 'Nothing in this file was run or loaded from the network.',
} as const;

const ERROR_TITLES: Record<ImageErrorCode, string> = {
  UNSUPPORTED: 'Unsupported image format', LIMIT_EXCEEDED: 'Image too large to open safely', DECODE_FAILED: 'This image could not be decoded',
  ABORTED: 'Loading was cancelled', INVALID_CALIBRATION: 'Invalid calibration', SVG_REJECTED: 'This SVG was rejected',
};
const KIND_LABELS: Record<ImageKind, string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', svg: 'SVG' };

type Tool = 'pan' | 'calibrate' | 'measure' | 'note';
type Selection = { kind: 'annotation' | 'bookmark'; id: string } | null;
type Editor = { mode: 'new'; x: number; y: number } | { mode: 'edit'; id: string } | null;
type Notice = { tone: 'info' | 'ok' | 'error'; text: string } | null;
type Segment = { a: Point; b: Point };
type Phase =
  | { phase: 'loading' }
  | { phase: 'error'; code: ImageErrorCode; message: string }
  | { phase: 'ready'; kind: ImageKind; width: number; height: number; removed: string[] };

const LOADING: Phase = { phase: 'loading' };
interface Palette { bg: string; panel: string; raised: string; hover: string; line: string; text: string; muted: string; accent: string; net: string }
interface Drag { id: number; sx: number; sy: number; lx: number; ly: number; moved: boolean; button: number }
/** Everything that changes at pointer rate lives here, outside React, and is painted straight to the canvas. */
interface Live {
  doc: ImageDocument | null;
  view: ViewState;
  w: number;
  h: number;
  rect: DOMRect | null;
  hover: Point | null;
  drag: Drag | null;
  frame: number;
  emit: boolean;
  anim: number;
  initialized: boolean;
  pendingSync: boolean;
  emitted: CameraState[];
  palette: Palette | null;
  checker: { key: string; pattern: CanvasPattern } | null;
}

const REMOVED_PREVIEW = 8;
const MARKER_RADIUS = 10;
const DRAG_THRESHOLD = 4;
const PAN_STEP = 48;
const ZOOM_STEP = 1.25;
const ROW_HEIGHT = 44;
const EDITOR_WIDTH = 272;
const EDITOR_HEIGHT = 196;
const round2 = (value: number) => Math.round(value * 100) / 100;
const formatMm = (mm: number) => (mm >= 100 ? mm.toFixed(1) : mm >= 1 ? mm.toFixed(2) : mm.toFixed(3));
const formatZoom = (scale: number) => `${(scale * 100).toFixed(scale < 0.1 ? 1 : 0)}%`;
const newId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const reducedMotion = () => typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off');
const isEditable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

function readPalette(element: Element): Palette {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    bg: token('--bg', '#0d131b'), panel: token('--panel', '#141d28'), raised: token('--raised', '#1d2937'), hover: token('--hover', '#233144'), line: token('--line', '#283748'),
    text: token('--text', '#e8eff5'), muted: token('--muted', '#96a8b9'), accent: token('--accent', '#efb751'), net: token('--net', '#56d4cf'),
  };
}

/** React state whose latest value is also readable synchronously from event handlers and the canvas painter. */
function useStateRef<T>(initial: T) {
  const [state, setState] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T | ((previous: T) => T)) => {
    const value = typeof next === 'function' ? (next as (previous: T) => T)(ref.current) : next;
    ref.current = value;
    setState(value);
  }, []);
  return [state, set, ref] as const;
}

export function ImageViewer(props: ImageViewerProps) {
  const { name, data, calibration, bookmarks, annotations, theme, motion, compact } = props;
  // The result is tagged with the bytes it belongs to, so the previous document is never shown (or its banner kept) for even one frame after `data` changes.
  const [result, setResult] = useState<{ data: Uint8Array; phase: Phase }>({ data, phase: LOADING });
  const loaded = result.data === data ? result.phase : LOADING;
  const [tool, setTool, toolRef] = useStateRef<Tool>('pan');
  const [pending, setPending, pendingRef] = useStateRef<Point[]>([]);
  const [calibPoints, setCalibPoints, calibPointsRef] = useStateRef<Point[]>([]);
  const [measurement, setMeasurement, measurementRef] = useStateRef<Segment | null>(null);
  const [selection, setSelection, selectionRef] = useStateRef<Selection>(null);
  const [editor, setEditor, editorRef] = useStateRef<Editor>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [distanceText, setDistanceText] = useState('');
  const [distanceError, setDistanceError] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(!compact);
  const [bannerOpen, setBannerOpen] = useState(true);
  const [showAllRemoved, setShowAllRemoved] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  const rootRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const editorBoxRef = useRef<HTMLDivElement>(null);
  const zoomTextRef = useRef<HTMLSpanElement>(null);
  const rotationTextRef = useRef<HTMLSpanElement>(null);
  const cursorTextRef = useRef<HTMLSpanElement>(null);
  const distanceInputRef = useRef<HTMLInputElement>(null);
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const panelId = useId();
  const hintId = useId();

  const live = useRef<Live>({
    doc: null, view: { center: { x: 0, y: 0 }, scale: 1, rotation: 0, fit: 'page' }, w: 0, h: 0, rect: null, hover: null, drag: null, frame: 0, emit: false, anim: 0,
    initialized: false, pendingSync: false, emitted: [], palette: null, checker: null,
  });
  // A calibration is only trusted when the user confirmed it and it is a usable number; a damaged manifest value never yields millimetres.
  const activeCalibration = calibration && calibration.confirmed === true && isValidCalibration(calibration) ? calibration : null;
  const latest = useRef(props);
  const calibrationRef = useRef(activeCalibration);
  // The painter and the native listeners read the newest props through refs, so they never close over stale ones.
  useLayoutEffect(() => { latest.current = props; calibrationRef.current = activeCalibration; });

  const ready = loaded.phase === 'ready';

  // ---------------------------------------------------------------------------------------------
  // Painting (canvas only; never touches React state)
  // ---------------------------------------------------------------------------------------------

  const paint = () => {
    const L = live.current;
    L.frame = 0;
    const canvas = canvasRef.current, root = rootRef.current;
    if (!canvas || !root || L.w < 1 || L.h < 1) return;
    const bw = Math.max(1, Math.round(L.w * (window.devicePixelRatio || 1))), bh = Math.max(1, Math.round(L.h * (window.devicePixelRatio || 1)));
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const palette = L.palette ?? (L.palette = readPalette(root));
    const sx = bw / L.w, sy = bh / L.h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    const doc = L.doc, view = L.view;
    if (doc) {
      ctx.save();
      ctx.setTransform(sx, 0, 0, sy, 0, 0);
      ctx.translate(L.w / 2, L.h / 2);
      ctx.rotate(view.rotation * Math.PI / 180);
      ctx.scale(view.scale, view.scale);
      ctx.translate(-view.center.x, -view.center.y);
      if (doc.kind !== 'jpeg') {
        // Transparency shows a screen-space checker; the clip path is built in image space and applied after resetting the transform.
        ctx.beginPath();
        ctx.rect(0, 0, doc.width, doc.height);
        ctx.save();
        ctx.setTransform(sx, 0, 0, sy, 0, 0);
        ctx.clip();
        const key = `${palette.raised}${palette.hover}`;
        if (L.checker?.key !== key) {
          const tile = document.createElement('canvas');
          tile.width = tile.height = 16;
          const tctx = tile.getContext('2d')!;
          tctx.fillStyle = palette.raised; tctx.fillRect(0, 0, 16, 16);
          tctx.fillStyle = palette.hover; tctx.fillRect(0, 0, 8, 8); tctx.fillRect(8, 8, 8, 8);
          L.checker = { key, pattern: ctx.createPattern(tile, 'repeat')! };
        }
        ctx.fillStyle = L.checker.pattern;
        ctx.fillRect(0, 0, L.w, L.h);
        ctx.restore();
      }
      ctx.imageSmoothingEnabled = view.scale * sx < 3;
      ctx.imageSmoothingQuality = 'high';
      if (doc.kind === 'svg') {
        ctx.drawImage(doc.source, 0, 0, doc.width, doc.height);
      } else {
        const region = visibleImageRect(view, L.w, L.h, doc.width, doc.height);
        if (region) ctx.drawImage(doc.source, region.x, region.y, region.width, region.height, region.x, region.y, region.width, region.height);
      }
      ctx.restore();
      ctx.setTransform(sx, 0, 0, sy, 0, 0);
      paintOverlay(ctx, palette, doc, view);
    }
    if (zoomTextRef.current) zoomTextRef.current.textContent = formatZoom(view.scale);
    if (rotationTextRef.current) rotationTextRef.current.textContent = `${view.rotation}°`;
    if (cursorTextRef.current) {
      const p = L.hover && doc ? screenToImage(L.hover, view, L.w, L.h) : null;
      cursorTextRef.current.textContent = p && p.x >= 0 && p.y >= 0 && p.x <= doc!.width && p.y <= doc!.height ? `x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)} px` : '';
    }
    positionEditor();
  };

  const toScreen = (p: Point) => imageToScreen(p, live.current.view, live.current.w, live.current.h);

  const paintOverlay = (ctx: CanvasRenderingContext2D, palette: Palette, doc: ImageDocument, view: ViewState) => {
    const L = live.current;
    const P = latest.current;
    // Image border keeps the edge visible against a similar background.
    ctx.lineWidth = 1;
    ctx.strokeStyle = palette.line;
    ctx.beginPath();
    [{ x: 0, y: 0 }, { x: doc.width, y: 0 }, { x: doc.width, y: doc.height }, { x: 0, y: doc.height }].forEach((corner, index) => {
      const s = toScreen(corner);
      if (index === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.stroke();

    const onScreen = (s: Point) => s.x > -24 && s.y > -24 && s.x < L.w + 24 && s.y < L.h + 24;
    ctx.font = '600 11px Manrope, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const bookmark of P.bookmarks) {
      if (bookmark.x === undefined || bookmark.y === undefined || !Number.isFinite(bookmark.x) || !Number.isFinite(bookmark.y)) continue;
      const s = toScreen({ x: bookmark.x, y: bookmark.y });
      if (!onScreen(s)) continue;
      const selected = selectionRef.current?.kind === 'bookmark' && selectionRef.current.id === bookmark.id;
      ctx.beginPath();
      ctx.moveTo(s.x - 5, s.y - 13); ctx.lineTo(s.x + 5, s.y - 13); ctx.lineTo(s.x + 5, s.y); ctx.lineTo(s.x, s.y - 4); ctx.lineTo(s.x - 5, s.y); ctx.closePath();
      ctx.fillStyle = palette.panel; ctx.fill();
      ctx.lineWidth = selected ? 2.5 : 1.5; ctx.strokeStyle = selected ? palette.net : palette.accent; ctx.stroke();
    }
    P.annotations.forEach((note, index) => {
      if (!Number.isFinite(note.x) || !Number.isFinite(note.y)) return;
      const s = toScreen({ x: note.x, y: note.y });
      if (!onScreen(s)) return;
      const selected = selectionRef.current?.kind === 'annotation' && selectionRef.current.id === note.id;
      ctx.beginPath();
      ctx.arc(s.x, s.y, MARKER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = selected ? palette.net : palette.accent; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = palette.bg; ctx.stroke();
      ctx.fillStyle = palette.bg;
      ctx.fillText(String(index + 1), s.x, s.y + 0.5);
    });

    const calibratedNow = calibrationRef.current;
    const segment = (a: Point, b: Point, colour: string, dashed: boolean, label: string) => {
      const p = toScreen(a), q = toScreen(b);
      ctx.save();
      ctx.lineCap = 'round';
      for (const [width, style] of [[4, 'rgba(0,0,0,0.55)'], [1.75, colour]] as const) {
        ctx.lineWidth = width; ctx.strokeStyle = style; ctx.setLineDash(dashed && width < 4 ? [7, 5] : []);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
      ctx.setLineDash([]);
      const angle = Math.atan2(q.y - p.y, q.x - p.x) + Math.PI / 2;
      for (const end of [p, q]) {
        for (const [width, style] of [[4, 'rgba(0,0,0,0.55)'], [1.75, colour]] as const) {
          ctx.lineWidth = width; ctx.strokeStyle = style;
          ctx.beginPath(); ctx.moveTo(end.x - Math.cos(angle) * 6, end.y - Math.sin(angle) * 6); ctx.lineTo(end.x + Math.cos(angle) * 6, end.y + Math.sin(angle) * 6); ctx.stroke();
        }
      }
      ctx.restore();
      if (label) {
        ctx.font = '500 12px "IBM Plex Mono", Consolas, monospace';
        const width = ctx.measureText(label).width + 14;
        const mx = clamp((p.x + q.x) / 2, width / 2 + 4, L.w - width / 2 - 4), my = clamp((p.y + q.y) / 2 - 16, 14, L.h - 14);
        ctx.fillStyle = palette.panel; ctx.globalAlpha = 0.94;
        ctx.beginPath(); ctx.roundRect(mx - width / 2, my - 10, width, 20, 6); ctx.fill();
        ctx.globalAlpha = 1; ctx.lineWidth = 1; ctx.strokeStyle = colour; ctx.stroke();
        ctx.fillStyle = palette.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, mx, my + 0.5);
      }
    };
    const measured = measurementRef.current;
    if (measured) segment(measured.a, measured.b, palette.net, false, formatMeasurement(pixelDistance(measured.a, measured.b), calibratedNow, formatMm));
    const calibPts = calibPointsRef.current;
    if (calibPts.length === 2) segment(calibPts[0], calibPts[1], palette.accent, true, `${pixelDistance(calibPts[0], calibPts[1]).toFixed(1)} px`);
    const first = toolRef.current === 'calibrate' ? calibPts[0] : toolRef.current === 'measure' ? pendingRef.current[0] : undefined;
    if (first && (toolRef.current === 'measure' ? pendingRef.current.length === 1 : calibPts.length === 1)) {
      const colour = toolRef.current === 'calibrate' ? palette.accent : palette.net;
      const target = L.hover ? screenToImage(L.hover, view, L.w, L.h) : null;
      if (target) segment(first, target, colour, true, toolRef.current === 'measure' ? formatMeasurement(pixelDistance(first, target), calibratedNow, formatMm) : `${pixelDistance(first, target).toFixed(1)} px`);
      else segment(first, first, colour, false, '');
    }
    // Keyboard users pick points at the view centre, so show where that is while a tool is active and the pointer is away.
    if (toolRef.current !== 'pan' && !L.hover) {
      ctx.lineWidth = 1.5; ctx.strokeStyle = palette.accent;
      ctx.beginPath(); ctx.moveTo(L.w / 2 - 10, L.h / 2); ctx.lineTo(L.w / 2 + 10, L.h / 2); ctx.moveTo(L.w / 2, L.h / 2 - 10); ctx.lineTo(L.w / 2, L.h / 2 + 10); ctx.stroke();
    }
  };

  const positionEditor = () => {
    const box = editorBoxRef.current, current = editorRef.current;
    if (!box || !current) return;
    const L = live.current;
    const anchor = current.mode === 'new' ? { x: current.x, y: current.y } : latest.current.annotations.find(a => a.id === current.id);
    if (!anchor) return;
    const s = toScreen({ x: anchor.x, y: anchor.y });
    const left = clamp(s.x + 16, 8, Math.max(8, L.w - EDITOR_WIDTH - 8));
    const top = s.y + 16 + EDITOR_HEIGHT > L.h ? Math.max(8, s.y - 16 - EDITOR_HEIGHT) : s.y + 16;
    box.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };

  // One animation frame serves painting and the throttled camera callback.
  const tick = () => {
    const L = live.current;
    paint();
    if (L.emit) {
      L.emit = false;
      const camera = viewToCamera(L.view);
      L.emitted.push(camera);
      if (L.emitted.length > 8) L.emitted.shift();
      latest.current.onCameraChange(camera);
    }
  };
  const schedule = (emit = false) => {
    const L = live.current;
    if (emit) L.emit = true;
    if (!L.frame) L.frame = requestAnimationFrame(tick);
  };
  const schedulePaint = () => schedule(false);

  // ---------------------------------------------------------------------------------------------
  // View operations
  // ---------------------------------------------------------------------------------------------

  const cancelAnimation = () => { const L = live.current; if (L.anim) { cancelAnimationFrame(L.anim); L.anim = 0; } };
  const commitView = (next: ViewState) => { live.current.view = next; schedule(true); };
  const animateTo = (target: ViewState) => {
    const L = live.current;
    cancelAnimation();
    const from = L.view;
    if (!latest.current.motion || reducedMotion() || from.rotation !== target.rotation) { commitView(target); return; }
    const start = performance.now(), duration = 170;
    const step = (now: number) => {
      const t = clamp((now - start) / duration, 0, 1), e = 1 - (1 - t) ** 3;
      commitView(t >= 1 ? target : {
        center: { x: from.center.x + (target.center.x - from.center.x) * e, y: from.center.y + (target.center.y - from.center.y) * e },
        scale: from.scale * (target.scale / from.scale) ** e, rotation: target.rotation, fit: target.fit,
      });
      L.anim = t >= 1 ? 0 : requestAnimationFrame(step);
    };
    L.anim = requestAnimationFrame(step);
  };

  const imageSize = () => { const doc = live.current.doc; return doc ? { width: doc.width, height: doc.height } : null; };
  const fitTo = (mode: 'page' | 'width') => {
    const size = imageSize(), L = live.current;
    if (size) animateTo({ ...fitViewMode(mode, size.width, size.height, L.view.rotation, L.w, L.h), fit: mode });
  };
  const zoomTo = (scale: number, anchor?: Point) => {
    const L = live.current;
    if (!L.doc) return;
    cancelAnimation();
    const target = zoomAt(L.view, anchor ?? { x: L.w / 2, y: L.h / 2 }, scale, L.w, L.h);
    commitView({ ...target, center: clampCenter(target.center, L.doc.width, L.doc.height), fit: 'none' });
  };
  const rotate = (delta: 90 | -90) => {
    const size = imageSize(), L = live.current;
    if (!size) return;
    cancelAnimation();
    const rotation = nextRotation(L.view.rotation, delta);
    commitView(L.view.fit === 'none' ? { ...L.view, rotation } : { ...fitViewMode(L.view.fit, size.width, size.height, rotation, L.w, L.h), fit: L.view.fit });
  };
  const panScreen = (dx: number, dy: number) => {
    const L = live.current;
    if (!L.doc) return;
    const next = panBy(L.view, { x: dx, y: dy });
    commitView({ ...next, center: clampCenter(next.center, L.doc.width, L.doc.height), fit: 'none' });
  };
  const goTo = (x: number, y: number) => {
    const L = live.current;
    if (!L.doc) return;
    animateTo({ center: clampCenter({ x, y }, L.doc.width, L.doc.height), scale: Math.max(L.view.scale, 1), rotation: L.view.rotation, fit: 'none' });
  };

  /** Applies the camera the shell passes in, unless it is the echo of what this viewer just emitted. */
  const syncCamera = () => {
    const L = live.current;
    if (!L.doc) return;
    if (L.w < 1 || L.h < 1) { L.pendingSync = true; return; }
    L.pendingSync = false;
    const camera = latest.current.camera;
    if (L.initialized && L.emitted.some(emitted => sameCamera(emitted, camera))) return;
    L.initialized = true;
    cancelAnimation();
    L.view = cameraToView(camera, L.doc.width, L.doc.height, L.w, L.h);
    // A shell that has no camera yet (first open) is told which one was chosen; a stored camera is restored silently.
    const complete = [camera.zoom, camera.x, camera.y].every(value => typeof value === 'number' && Number.isFinite(value));
    schedule(!complete);
  };

  const stopTool = () => {
    setPending([]); setCalibPoints([]); setDistanceError(null);
  };
  const chooseTool = (next: Tool) => {
    stopTool();
    setNotice(null);
    if (next !== 'pan') setSelection(null);
    if (next === 'measure') setMeasurement(null);
    setTool(next);
    schedulePaint();
    surfaceRef.current?.focus({ preventScroll: true });
  };
  const closeEditor = () => { setEditor(null); setNoteError(null); setNoteText(''); schedulePaint(); surfaceRef.current?.focus({ preventScroll: true }); };

  // ---------------------------------------------------------------------------------------------
  // Clicks: calibration, measurement, notes
  // ---------------------------------------------------------------------------------------------

  const markers = () => [
    ...latest.current.bookmarks.filter(b => b.x !== undefined && b.y !== undefined).map(b => ({ id: `b:${b.id}`, x: b.x!, y: b.y! })),
    ...latest.current.annotations.map(a => ({ id: `a:${a.id}`, x: a.x, y: a.y })),
  ];

  const handleClick = (screen: Point) => {
    const L = live.current, doc = L.doc;
    if (!doc) return;
    const point = screenToImage(screen, L.view, L.w, L.h);
    const inside = point.x >= 0 && point.y >= 0 && point.x <= doc.width && point.y <= doc.height;
    const current = toolRef.current;
    if (current === 'pan' || current === 'note') {
      const hit = hitTestMarker(markers(), screen, L.view, L.w, L.h, MARKER_RADIUS + 3);
      if (hit) {
        const id = hit.slice(2), isNote = hit.startsWith('a:');
        setSelection({ kind: isNote ? 'annotation' : 'bookmark', id });
        if (isNote) openEditor({ mode: 'edit', id });
        schedulePaint();
        return;
      }
      if (current === 'pan') { setSelection(null); setNotice(null); schedulePaint(); return; }
      if (!inside) { setNotice({ tone: 'error', text: TEXT.outside }); return; }
      setNotice(null);
      openEditor({ mode: 'new', x: round2(point.x), y: round2(point.y) });
      return;
    }
    if (!inside) { setNotice({ tone: 'error', text: TEXT.outside }); return; }
    setNotice(null);
    if (current === 'calibrate') {
      const points = calibPointsRef.current;
      if (points.length === 1) {
        if (pixelDistance(points[0], point) < 1) { setNotice({ tone: 'error', text: TEXT.samePoint }); return; }
        setCalibPoints([points[0], point]);
        setDistanceText(''); setDistanceError(null);
      } else {
        setCalibPoints([point]);
      }
    } else {
      const points = pendingRef.current;
      if (points.length === 1) {
        setMeasurement({ a: points[0], b: point });
        setPending([]);
      } else {
        setMeasurement(null);
        setPending([point]);
      }
    }
    schedulePaint();
  };

  const openEditor = (next: NonNullable<Editor>) => {
    setEditor(next);
    setNoteError(null);
    setNoteText(next.mode === 'edit' ? latest.current.annotations.find(a => a.id === next.id)?.text ?? '' : '');
    schedulePaint();
  };

  const applyCalibration = () => {
    const points = calibPointsRef.current;
    if (points.length !== 2) return;
    const parsed = parseKnownDistanceMm(distanceText);
    if (!parsed.ok) { setDistanceError(parsed.message); distanceInputRef.current?.focus(); return; }
    try {
      const result = calibrate(points[0], points[1], parsed.value);
      latest.current.onCalibrationChange({ pixelsPerMm: result.pixelsPerMm, confirmed: true });
      setNotice({ tone: 'ok', text: `Calibrated: ${result.pixelsPerMm.toFixed(3)} px per mm (1 mm = ${result.pixelsPerMm.toFixed(2)} px). Measurements now report millimetres.` });
      stopTool();
      setTool('pan');
      surfaceRef.current?.focus({ preventScroll: true });
    } catch (error) {
      setDistanceError(error instanceof ImageError ? error.message : 'The calibration could not be computed.');
      distanceInputRef.current?.focus();
    }
    schedulePaint();
  };

  const clearCalibration = () => {
    latest.current.onCalibrationChange(undefined);
    setNotice({ tone: 'info', text: 'Calibration cleared. Distances are reported in image pixels only.' });
    schedulePaint();
  };

  // ---------------------------------------------------------------------------------------------
  // Bookmarks and annotations (controlled)
  // ---------------------------------------------------------------------------------------------

  const addBookmark = () => {
    const L = live.current;
    if (!L.doc) return;
    if (latest.current.bookmarks.length >= WORKSPACE_LIMITS.bookmarks) { setNotice({ tone: 'error', text: TEXT.limitBookmarks }); return; }
    const used = new Set(latest.current.bookmarks.map(b => b.label));
    let n = latest.current.bookmarks.length + 1;
    while (used.has(`Bookmark ${n}`)) n++;
    const bookmark: DocumentBookmark = { id: newId(), page: 1, label: `Bookmark ${n}`, x: round2(L.view.center.x), y: round2(L.view.center.y) };
    latest.current.onBookmarksChange([...latest.current.bookmarks, bookmark]);
    setSelection({ kind: 'bookmark', id: bookmark.id });
    setPanelOpen(true);
    setRenamingId(bookmark.id); setRenameText(bookmark.label);
    schedulePaint();
  };
  const commitRename = () => {
    const id = renamingId;
    setRenamingId(null);
    const label = renameText.trim().slice(0, 120);
    if (!id || !label) return;
    latest.current.onBookmarksChange(latest.current.bookmarks.map(b => (b.id === id ? { ...b, label } : b)));
  };
  const removeBookmark = (id: string) => {
    latest.current.onBookmarksChange(latest.current.bookmarks.filter(b => b.id !== id));
    if (selectionRef.current?.id === id) setSelection(null);
    schedulePaint();
  };
  const saveNote = () => {
    const current = editorRef.current;
    if (!current) return;
    const text = noteText.trim();
    if (!text) { setNoteError(TEXT.noteEmpty); noteInputRef.current?.focus(); return; }
    const now = new Date().toISOString();
    if (current.mode === 'new') {
      if (latest.current.annotations.length >= WORKSPACE_LIMITS.annotations) { setNoteError(TEXT.limitNotes); return; }
      const note: DocumentAnnotation = { id: newId(), page: 1, x: current.x, y: current.y, text, updatedAt: now };
      latest.current.onAnnotationsChange([...latest.current.annotations, note]);
      setSelection({ kind: 'annotation', id: note.id });
    } else {
      latest.current.onAnnotationsChange(latest.current.annotations.map(a => (a.id === current.id ? { ...a, text, updatedAt: now } : a)));
    }
    closeEditor();
  };
  const removeNote = (id: string) => {
    latest.current.onAnnotationsChange(latest.current.annotations.filter(a => a.id !== id));
    if (selectionRef.current?.id === id) setSelection(null);
    if (editorRef.current?.mode === 'edit' && editorRef.current.id === id) closeEditor();
    schedulePaint();
  };

  // ---------------------------------------------------------------------------------------------
  // Pointer and keyboard
  // ---------------------------------------------------------------------------------------------

  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = live.current.rect ?? (live.current.rect = surfaceRef.current!.getBoundingClientRect());
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 1) event.preventDefault();
    const L = live.current;
    L.rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    cancelAnimation();
    L.drag = { id: event.pointerId, sx: event.clientX, sy: event.clientY, lx: event.clientX, ly: event.clientY, moved: false, button: event.button };
    L.hover = localPoint(event);
    event.currentTarget.focus({ preventScroll: true });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const L = live.current, drag = L.drag;
    L.hover = localPoint(event);
    if (drag && drag.id === event.pointerId && (drag.moved || Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) >= DRAG_THRESHOLD)) {
      if (!drag.moved) { drag.moved = true; event.currentTarget.dataset.dragging = 'true'; }
      panScreen(event.clientX - drag.lx, event.clientY - drag.ly);
      drag.lx = event.clientX; drag.ly = event.clientY;
    }
    schedulePaint();
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, click: boolean) => {
    const L = live.current, drag = L.drag;
    if (!drag || drag.id !== event.pointerId) return;
    L.drag = null;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (click && !drag.moved && drag.button === 0) handleClick(localPoint(event));
  };
  const onPointerLeave = () => { const L = live.current; if (!L.drag) { L.hover = null; schedulePaint(); } };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return;
    const L = live.current;
    const key = event.key;
    let handled = true;
    switch (key) {
      case '+': case '=': zoomTo(L.view.scale * ZOOM_STEP); break;
      case '-': case '_': zoomTo(L.view.scale / ZOOM_STEP); break;
      case '0': zoomTo(1); break;
      case 'f': case 'F': fitTo('page'); break;
      case 'w': case 'W': fitTo('width'); break;
      case 'r': case 'R': rotate(event.shiftKey ? -90 : 90); break;
      case 'ArrowLeft': panScreen(PAN_STEP * (event.shiftKey ? 4 : 1), 0); break;
      case 'ArrowRight': panScreen(-PAN_STEP * (event.shiftKey ? 4 : 1), 0); break;
      case 'ArrowUp': panScreen(0, PAN_STEP * (event.shiftKey ? 4 : 1)); break;
      case 'ArrowDown': panScreen(0, -PAN_STEP * (event.shiftKey ? 4 : 1)); break;
      case 'v': case 'V': chooseTool('pan'); break;
      case 'c': case 'C': chooseTool('calibrate'); break;
      case 'm': case 'M': chooseTool('measure'); break;
      case 'n': case 'N': chooseTool('note'); break;
      case 'b': case 'B': addBookmark(); break;
      case 'Enter': case ' ':
        if (toolRef.current === 'pan') handled = false; else handleClick(L.hover ?? { x: L.w / 2, y: L.h / 2 });
        break;
      case 'Escape':
        if (editorRef.current) closeEditor();
        else if (pendingRef.current.length || calibPointsRef.current.length) { stopTool(); schedulePaint(); }
        else if (toolRef.current !== 'pan') chooseTool('pan');
        else if (measurementRef.current || selectionRef.current) { setMeasurement(null); setSelection(null); setNotice(null); schedulePaint(); }
        else handled = false;
        break;
      default: handled = false;
    }
    if (handled) event.preventDefault();
  };

  // ---------------------------------------------------------------------------------------------
  // Effects: load, size, wheel, camera sync, theme
  // ---------------------------------------------------------------------------------------------

  useEffect(() => {
    const controller = new AbortController();
    const L = live.current;
    L.doc = null; L.initialized = false; L.emitted = [];
    setResult({ data, phase: LOADING });
    setTool('pan'); setPending([]); setCalibPoints([]); setMeasurement(null); setSelection(null); setEditor(null); setNotice(null); setRenamingId(null); setBannerOpen(true); setShowAllRemoved(false);
    schedulePaint();
    let current: ImageDocument | null = null;
    loadImageDocument(data, controller.signal).then(loadedDoc => {
      if (controller.signal.aborted) { loadedDoc.dispose(); return; }
      current = loadedDoc;
      L.doc = loadedDoc;
      setResult({ data, phase: { phase: 'ready', kind: loadedDoc.kind, width: loadedDoc.width, height: loadedDoc.height, removed: loadedDoc.removed } });
    }, (error: unknown) => {
      if (controller.signal.aborted || (error instanceof ImageError && error.code === 'ABORTED')) return;
      const known = error instanceof ImageError;
      setResult({ data, phase: { phase: 'error', code: known ? error.code : 'DECODE_FAILED', message: known ? error.message : 'The image could not be opened.' } });
    });
    return () => {
      controller.abort();
      // The painter must stop using the source before it is closed; a closed ImageBitmap throws when drawn.
      L.doc = null;
      cancelAnimation();
      current?.dispose();
    };
  }, [data]); // the loader depends only on the bytes; everything else is read through refs

  useLayoutEffect(() => {
    if (ready) syncCamera();
  }, [ready, loaded, props.camera.zoom, props.camera.x, props.camera.y, props.camera.rotation, props.camera.fit]);

  useEffect(() => {
    const surface = surfaceRef.current!;
    const L = live.current;
    const measure = () => {
      const rect = surface.getBoundingClientRect();
      L.rect = rect;
      const w = Math.floor(surface.clientWidth), h = Math.floor(surface.clientHeight);
      if (w === L.w && h === L.h) return;
      L.w = w; L.h = h;
      if (!L.doc) { schedulePaint(); return; }
      if (L.pendingSync || !L.initialized) syncCamera();
      else if (L.view.fit !== 'none') {
        const size = L.doc;
        L.view = { ...fitViewMode(L.view.fit, size.width, size.height, L.view.rotation, w, h), fit: L.view.fit };
        schedule(true);
      } else schedulePaint();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    measure();
    const onWheel = (event: WheelEvent) => {
      if (!L.doc) return;
      event.preventDefault();
      L.rect = surface.getBoundingClientRect();
      let delta = event.deltaY;
      if (event.deltaMode === 1) delta *= 16; else if (event.deltaMode === 2) delta *= L.h;
      delta = clamp(delta, -240, 240);
      zoomTo(L.view.scale * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015)), { x: event.clientX - L.rect.left, y: event.clientY - L.rect.top });
    };
    surface.addEventListener('wheel', onWheel, { passive: false });
    const onWindowResize = () => schedulePaint();
    window.addEventListener('resize', onWindowResize);
    void document.fonts?.ready.then(() => schedulePaint());
    return () => {
      observer.disconnect();
      surface.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onWindowResize);
      if (L.frame) { cancelAnimationFrame(L.frame); L.frame = 0; }
      cancelAnimation();
    };
  }, []); // mounted once; everything it calls reads refs

  useLayoutEffect(() => {
    if (rootRef.current) live.current.palette = readPalette(rootRef.current);
    live.current.checker = null;
    schedulePaint();
  }, [theme]);
  // Props that only the painter reads: repaint once per commit instead of tracking each of them.
  useEffect(() => { schedulePaint(); });

  useEffect(() => {
    if (calibPoints.length === 2) distanceInputRef.current?.focus();
  }, [calibPoints.length]);
  useLayoutEffect(() => {
    positionEditor();
    if (editor) noteInputRef.current?.focus();
  }, [editor]);
  useEffect(() => {
    if (notice?.tone !== 'ok') return;
    const timer = setTimeout(() => setNotice(null), 9000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (editor?.mode === 'edit' && !annotations.some(a => a.id === editor.id)) closeEditor();
    if (selection && !(selection.kind === 'annotation' ? annotations : bookmarks).some(item => item.id === selection.id)) setSelection(null);
  }, [annotations, bookmarks]);

  // ---------------------------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------------------------

  const view = loaded.phase === 'ready' ? loaded : null;
  const toolButton = (id: Tool, label: string, icon: ReactNode, text: string) => (
    <button type="button" className="imgv-btn" aria-pressed={tool === id} aria-label={label} title={label} disabled={!ready} onClick={() => chooseTool(id)}>
      {icon}<span className="imgv-btn__label">{text}</span>
    </button>
  );
  const iconButton = (label: string, icon: ReactNode, onClick: () => void, extra?: { pressed?: boolean; disabled?: boolean; text?: string; count?: number; controls?: string }) => (
    <button type="button" className="imgv-btn" aria-label={label} title={label} disabled={extra?.disabled ?? !ready} aria-controls={extra?.controls}
      aria-expanded={extra?.controls ? extra.pressed : undefined} onClick={onClick}>
      {icon}
      {extra?.text ? <span className="imgv-btn__label">{extra.text}</span> : null}
      {extra?.count !== undefined ? <span className="imgv-count mono">{extra.count}</span> : null}
    </button>
  );

  const hint = (() => {
    if (!ready) return null;
    if (tool === 'calibrate') return calibPoints.length === 0 ? 'Calibrate: click the first end of a distance you know, for example a ruler in the photo.' : calibPoints.length === 1 ? 'Click the second end of the known distance.' : null;
    if (tool === 'measure') {
      if (pending.length === 0 && !measurement) return activeCalibration ? 'Measure: click the first point.' : 'Measure: click the first point. Not calibrated, so distances are in pixels only.';
      if (pending.length === 1) return 'Click the second point.';
      return null;
    }
    if (tool === 'note') return 'Add note: click the image where the note belongs.';
    return null;
  })();
  const measuredText = measurement ? formatMeasurement(pixelDistance(measurement.a, measurement.b), activeCalibration, formatMm) : null;
  const measuredPixels = measurement ? pixelDistance(measurement.a, measurement.b) : 0;

  return (
    <section ref={rootRef} className="imgv" data-theme-mode={theme} data-motion={motion ? 'on' : 'off'} data-compact={compact ? 'true' : 'false'} data-phase={loaded.phase} aria-label={`${TEXT.region}: ${name}`}>
      <div className="imgv-toolbar" role="toolbar" aria-label={TEXT.toolbar}>
        <div className="imgv-group">
          {toolButton('pan', TEXT.pan, <Hand size={16} aria-hidden />, 'Select')}
          {toolButton('calibrate', TEXT.calibrate, <RulerDimensionLine size={16} aria-hidden />, 'Calibrate')}
          {toolButton('measure', TEXT.measure, <Ruler size={16} aria-hidden />, 'Measure')}
          {toolButton('note', TEXT.note, <MapPin size={16} aria-hidden />, 'Note')}
        </div>
        <div className="imgv-group">
          {iconButton(TEXT.zoomOut, <ZoomOut size={16} aria-hidden />, () => zoomTo(live.current.view.scale / ZOOM_STEP))}
          {iconButton(TEXT.actualSize, <span className="imgv-glyph" aria-hidden>1:1</span>, () => zoomTo(1))}
          {iconButton(TEXT.zoomIn, <ZoomIn size={16} aria-hidden />, () => zoomTo(live.current.view.scale * ZOOM_STEP))}
          {iconButton(TEXT.fit, <Maximize2 size={16} aria-hidden />, () => fitTo('page'))}
          {iconButton(TEXT.fitWidth, <MoveHorizontal size={16} aria-hidden />, () => fitTo('width'))}
          {iconButton(TEXT.rotateLeft, <RotateCcw size={16} aria-hidden />, () => rotate(-90))}
          {iconButton(TEXT.rotateRight, <RotateCw size={16} aria-hidden />, () => rotate(90))}
        </div>
        <div className="imgv-group imgv-group--end">
          {iconButton(TEXT.addBookmark, <BookmarkIcon size={16} aria-hidden />, addBookmark, { text: 'Bookmark' })}
          {activeCalibration ? iconButton(TEXT.clearCalibration, <Eraser size={16} aria-hidden />, clearCalibration, { text: 'Clear scale' }) : null}
          {iconButton(TEXT.panel, <PanelRight size={16} aria-hidden />, () => setPanelOpen(open => !open), { pressed: panelOpen, controls: panelId, disabled: false, count: bookmarks.length + annotations.length })}
        </div>
      </div>

      <div className="imgv-main">
        <div className="imgv-stage">
          <div
            ref={surfaceRef}
            className="imgv-surface"
            data-tool={tool}
            tabIndex={0}
            role="application"
            aria-roledescription="image viewer"
            aria-label={`${name}. ${view ? `${view.width} by ${view.height} pixels` : 'not loaded'}`}
            aria-describedby={hintId}
            aria-keyshortcuts="+ - 0 F W R V C M N B"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={event => endDrag(event, true)}
            onPointerCancel={event => endDrag(event, false)}
            onLostPointerCapture={event => endDrag(event, false)}
            onPointerLeave={onPointerLeave}
            onKeyDown={onKeyDown}
          >
            <canvas ref={canvasRef} className="imgv-canvas" aria-hidden />
          </div>
          <span id={hintId} className="imgv-sr">{TEXT.keys}</span>

          {loaded.phase === 'loading' ? <div className="imgv-state" role="status"><LoaderCircle className="imgv-spin" size={22} aria-hidden /><span>{TEXT.loading}…</span></div> : null}
          {loaded.phase === 'error' ? (
            <div className="imgv-state imgv-state--error" role="alert">
              {loaded.code === 'LIMIT_EXCEEDED' || loaded.code === 'SVG_REJECTED' ? <ShieldAlert size={26} aria-hidden /> : <ImageOff size={26} aria-hidden />}
              <strong>{ERROR_TITLES[loaded.code]}</strong>
              <span className="imgv-state__detail">{loaded.message}</span>
              <span className="imgv-state__file mono">{name} · {data.byteLength.toLocaleString('en')} bytes</span>
            </div>
          ) : null}

          <div className="imgv-overlay">
            {view && view.kind === 'svg' && view.removed.length > 0 && bannerOpen ? (
              <div className="imgv-banner" role="status">
                <ShieldAlert size={16} aria-hidden />
                <div className="imgv-banner__body">
                  <strong>{view.removed.length} unsafe {view.removed.length === 1 ? 'item was' : 'items were'} removed from this SVG.</strong>{' '}
                  <span>{TEXT.sanitized}</span>
                  <ul className="imgv-removed" aria-label="Removed SVG content">
                    {(showAllRemoved ? view.removed : view.removed.slice(0, REMOVED_PREVIEW)).map(item => <li key={item}>{describeRemoval(item)}</li>)}
                  </ul>
                  {view.removed.length > REMOVED_PREVIEW ? (
                    <button type="button" className="imgv-status__link" aria-expanded={showAllRemoved} onClick={() => setShowAllRemoved(open => !open)}>
                      {showAllRemoved ? 'Show fewer' : `Show all ${view.removed.length}`}
                    </button>
                  ) : null}
                </div>
                <button type="button" className="imgv-btn imgv-btn--small" aria-label="Hide the removed-content notice" title="Hide" onClick={() => setBannerOpen(false)}><X size={14} aria-hidden /></button>
              </div>
            ) : null}
            {hint || notice || measuredText ? (
              <div className="imgv-dock" role="status" data-tone={notice?.tone ?? 'info'}>
                {hint ? <span>{hint}</span> : null}
                {!hint && measuredText && measurement ? (
                  <span className="imgv-dock__result">
                    <span className="mono imgv-dock__value">{measuredText}</span>
                    {activeCalibration ? <span className="muted"> ({Math.round(measuredPixels)} px)</span> : <span className="muted"> — {TEXT.notCalibrated}. Use Calibrate to measure in millimetres.</span>}
                  </span>
                ) : null}
                {notice ? <span className="imgv-dock__notice">{notice.text}</span> : null}
              </div>
            ) : null}
            {tool === 'calibrate' && calibPoints.length === 2 ? (
              <form className="imgv-dock imgv-form" onSubmit={event => { event.preventDefault(); applyCalibration(); }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); stopTool(); schedulePaint(); surfaceRef.current?.focus({ preventScroll: true }); } }}>
                <label htmlFor={`${panelId}-distance`}>{TEXT.distanceLabel}</label>
                <span className="imgv-form__field">
                  <input
                    id={`${panelId}-distance`} ref={distanceInputRef} className="imgv-input mono" inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="25.4"
                    value={distanceText} aria-invalid={distanceError ? true : undefined} aria-describedby={`${panelId}-distance-help`}
                    onChange={event => { setDistanceText(event.target.value); setDistanceError(null); }}
                  />
                  <span className="muted">mm</span>
                </span>
                <button type="submit" className="imgv-btn imgv-btn--primary"><Check size={15} aria-hidden /><span>Set scale</span></button>
                <button type="button" className="imgv-btn" onClick={() => { stopTool(); schedulePaint(); surfaceRef.current?.focus({ preventScroll: true }); }}><X size={15} aria-hidden /><span>Cancel</span></button>
                <span id={`${panelId}-distance-help`} className={distanceError ? 'imgv-form__help imgv-form__help--error' : 'imgv-form__help'} role={distanceError ? 'alert' : undefined}>
                  {distanceError ?? `${pixelDistance(calibPoints[0], calibPoints[1]).toFixed(1)} px between the points. ${TEXT.distanceHint}${pixelDistance(calibPoints[0], calibPoints[1]) < 50 ? ` ${TEXT.shortReference}` : ''}`}
                </span>
              </form>
            ) : null}
          </div>

          {editor ? (
            <div ref={editorBoxRef} className="imgv-editor" role="dialog" aria-label={editor.mode === 'new' ? 'New note' : 'Edit note'} style={{ width: EDITOR_WIDTH }}
              onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeEditor(); } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); saveNote(); } }}>
              <label htmlFor={`${panelId}-note`} className="imgv-editor__title">{editor.mode === 'new' ? 'New note' : 'Edit note'}</label>
              <textarea id={`${panelId}-note`} ref={noteInputRef} className="imgv-input imgv-input--area" rows={4} maxLength={WORKSPACE_LIMITS.text} value={noteText} placeholder="Describe what is at this point"
                aria-invalid={noteError ? true : undefined} onChange={event => { setNoteText(event.target.value); setNoteError(null); }} />
              {noteError ? <span className="imgv-form__help imgv-form__help--error" role="alert">{noteError}</span> : null}
              <div className="imgv-editor__actions">
                {editor.mode === 'edit' ? <button type="button" className="imgv-btn" onClick={() => removeNote(editor.id)}><Trash2 size={15} aria-hidden /><span>Delete</span></button> : <span />}
                <span className="imgv-editor__spacer" />
                <button type="button" className="imgv-btn" onClick={closeEditor}><X size={15} aria-hidden /><span>Cancel</span></button>
                <button type="button" className="imgv-btn imgv-btn--primary" onClick={saveNote} title="Save (Ctrl+Enter)"><Check size={15} aria-hidden /><span>Save</span></button>
              </div>
            </div>
          ) : null}
        </div>

        {panelOpen ? (
          <aside id={panelId} className="imgv-panel" aria-label={TEXT.panel}>
            <h3 className="imgv-panel__title">Bookmarks <span className="muted">{bookmarks.length}</span></h3>
            {bookmarks.length === 0 ? <p className="imgv-empty">No bookmarks yet. Press B to save the current view centre.</p> : (
              <VirtualList items={bookmarks} label="Bookmarks" selectedId={selection?.kind === 'bookmark' ? selection.id : null} render={bookmark => (
                renamingId === bookmark.id ? (
                  <input className="imgv-input" autoFocus aria-label={`Rename ${bookmark.label}`} maxLength={120} value={renameText} onChange={event => setRenameText(event.target.value)}
                    onBlur={commitRename} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitRename(); } else if (event.key === 'Escape') { event.stopPropagation(); setRenamingId(null); } }} />
                ) : (
                  <>
                    <button type="button" className="imgv-row__main" title={`Go to ${bookmark.label}`} onClick={() => { setSelection({ kind: 'bookmark', id: bookmark.id }); if (bookmark.x !== undefined && bookmark.y !== undefined) goTo(bookmark.x, bookmark.y); else fitTo('page'); schedulePaint(); }}>
                      <BookmarkIcon size={14} aria-hidden /><span className="imgv-row__text">{bookmark.label}</span>
                      {bookmark.x !== undefined && bookmark.y !== undefined ? <span className="imgv-row__meta mono">{Math.round(bookmark.x)}, {Math.round(bookmark.y)}</span> : null}
                    </button>
                    <button type="button" className="imgv-btn imgv-btn--small" aria-label={`Rename ${bookmark.label}`} title="Rename" onClick={() => { setRenamingId(bookmark.id); setRenameText(bookmark.label); }}><Pencil size={13} aria-hidden /></button>
                    <button type="button" className="imgv-btn imgv-btn--small" aria-label={`Delete ${bookmark.label}`} title="Delete" onClick={() => removeBookmark(bookmark.id)}><Trash2 size={13} aria-hidden /></button>
                  </>
                )
              )} />
            )}
            <h3 className="imgv-panel__title">Notes <span className="muted">{annotations.length}</span></h3>
            {annotations.length === 0 ? <p className="imgv-empty">No notes yet. Choose the note tool (N) and click the image.</p> : (
              <VirtualList items={annotations} label="Notes" selectedId={selection?.kind === 'annotation' ? selection.id : null} render={(note, index) => (
                <>
                  <button type="button" className="imgv-row__main" title={note.text} onClick={() => { setSelection({ kind: 'annotation', id: note.id }); goTo(note.x, note.y); openEditor({ mode: 'edit', id: note.id }); }}>
                    <span className="imgv-badge" aria-hidden>{index + 1}</span><span className="imgv-row__text">{note.text}</span>
                  </button>
                  <button type="button" className="imgv-btn imgv-btn--small" aria-label={`Delete note ${index + 1}`} title="Delete" onClick={() => removeNote(note.id)}><Trash2 size={13} aria-hidden /></button>
                </>
              )} />
            )}
          </aside>
        ) : null}
      </div>

      <div className="imgv-status mono" role="group" aria-label="Image status">
        <span>Zoom <span ref={zoomTextRef}>100%</span></span>
        <span>Rotation <span ref={rotationTextRef}>0°</span></span>
        {view ? <span>{view.width} × {view.height} px · {KIND_LABELS[view.kind]}</span> : <span>{loaded.phase === 'loading' ? 'Loading' : 'No image'}</span>}
        <span className={activeCalibration ? 'imgv-status__cal imgv-status__cal--on' : 'imgv-status__cal'}>
          {activeCalibration ? `Calibrated ${activeCalibration.pixelsPerMm.toFixed(2)} px/mm (set by you)` : 'Not calibrated: pixels only'}
        </span>
        {view && view.kind === 'svg' && view.removed.length > 0 ? (
          <button type="button" className="imgv-status__link" aria-expanded={bannerOpen} onClick={() => setBannerOpen(open => !open)}>{view.removed.length} removed</button>
        ) : null}
        <span className="imgv-status__cursor" ref={cursorTextRef} aria-hidden />
      </div>
    </section>
  );
}

/** `svg onload` becomes `onload on <svg>`, `script` becomes `<script> element`; the sanitizer's own text, never the file's markup, is shown. */
function describeRemoval(item: string): ReactNode {
  if (/^\d+ more$/.test(item)) return `and ${item}`;
  const space = item.indexOf(' ');
  if (space > 0) return <><code>{item.slice(space + 1)}</code> on <code>&lt;{item.slice(0, space)}&gt;</code></>;
  return <><code>&lt;{item}&gt;</code> element</>;
}

function VirtualList<T extends { id: string }>({ items, label, selectedId, render }: { items: readonly T[]; label: string; selectedId: string | null; render: (item: T, index: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ top: 0, height: 220 });
  useEffect(() => {
    const element = ref.current!;
    const update = () => setFrame(previous => (previous.top === element.scrollTop && previous.height === element.clientHeight ? previous : { top: element.scrollTop, height: element.clientHeight }));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener('scroll', update, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener('scroll', update); };
  }, []);
  useEffect(() => {
    const element = ref.current;
    const index = selectedId ? items.findIndex(item => item.id === selectedId) : -1;
    if (!element || index < 0) return;
    if (index * ROW_HEIGHT < element.scrollTop) element.scrollTop = index * ROW_HEIGHT;
    else if ((index + 1) * ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = (index + 1) * ROW_HEIGHT - element.clientHeight;
  }, [selectedId, items]);
  const start = Math.max(0, Math.floor(frame.top / ROW_HEIGHT) - 3), end = Math.min(items.length, Math.ceil((frame.top + frame.height) / ROW_HEIGHT) + 3);
  return (
    <div ref={ref} className="imgv-list" role="list" aria-label={label} style={{ maxHeight: Math.min(items.length, 6) * ROW_HEIGHT + 2 }}>
      <div className="imgv-list__inner" style={{ height: items.length * ROW_HEIGHT }}>
        {items.slice(start, end).map((item, offset) => (
          <div key={item.id} role="listitem" className="imgv-row" data-selected={item.id === selectedId ? 'true' : undefined} aria-posinset={start + offset + 1} aria-setsize={items.length} style={{ top: (start + offset) * ROW_HEIGHT, height: ROW_HEIGHT }}>
            {render(item, start + offset)}
          </div>
        ))}
      </div>
    </div>
  );
}
