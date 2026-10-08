import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, CornerLeftUp, Maximize2, Minus, PanelLeft, Plus } from 'lucide-react';
import { pinKey, symbolRef, wireKey } from '../lib/schematic/model';
import type { SchSheetInstance, Schematic } from '../lib/schematic/model';
import type { SchematicViewerProps, ViewerCamera } from './viewer-contracts';
import { useSchematicOverlay } from './SchematicOverlay';
import {
  BASE_SCALE, FALLBACK_TOKENS, K, SheetCache, buildNavRows, buildNetHighlight, buildPalette, cameraToView, clampView, drawOverlay, drawSheet,
  fitView, hitTest, instanceChain, netIndex, panBy, queryData, resolveChildPath, resolveSelection, sameCamera, screenToSheet, segmentDistance, viewToCamera, zoomAt,
} from './schematic-render';
import type { FitMode, NavRow, ResolvedSelection, SchHit, SchPalette, SchTokens, SchView, SheetData } from './schematic-render';
import './schematic-viewer.css';

// i18n: pending (English constants)
const T = {
  sheets: 'Sheets',
  sheetList: 'Schematic sheets',
  toolbar: 'Schematic sheet navigation',
  path: 'Sheet path',
  parent: 'Parent sheet (Backspace)',
  previous: 'Previous sheet (Page Up)',
  next: 'Next sheet (Page Down)',
  view: 'Schematic view',
  fit: 'Fit sheet to window (0)',
  zoomIn: 'Zoom in (+)',
  zoomOut: 'Zoom out (-)',
  expand: 'Expand',
  collapse: 'Collapse',
  repeated: 'repeated sheet',
  current: 'current sheet',
  fileMissing: 'file missing',
  openHint: 'Double-click or press Enter to open',
  noInstance: 'This sheet instance is not part of the schematic.',
  noDef: 'The definition of this sheet is not available.',
  gotoRoot: 'Go to the root sheet',
  keys: 'Arrow keys pan, plus and minus zoom, 0 fits the sheet, S cycles the sub-sheets, Enter opens the focused sub-sheet, Backspace goes to the parent sheet, Page Up and Page Down switch sheets, Escape clears the selection.',
  noNet: 'No net',
  wire: 'Wire',
  bus: 'Bus',
  sheetPin: 'Sheet pin',
};

const NARROW_PX = 640;
const ROW_H = 40;
const OVERSCAN = 6;
const MAX_DPR = 2.5;
const FIT_MS = 180;
const EMPTY_SELECTION: ResolvedSelection = { symbol: -1, pin: null };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

interface Model {
  byPath: Map<string, SchSheetInstance>;
  defs: Map<string, Schematic['defs'][number]>;
  index: Map<string, number>;
  repeats: Map<string, number>;
}
function buildModel(schematic: Schematic): Model {
  const repeats = new Map<string, number>();
  for (const instance of schematic.instances) repeats.set(instance.defId, (repeats.get(instance.defId) ?? 0) + 1);
  return {
    byPath: new Map(schematic.instances.map(instance => [instance.path, instance])),
    defs: new Map(schematic.defs.map(def => [def.id, def])),
    index: new Map(schematic.instances.map((instance, n) => [instance.path, n])),
    repeats,
  };
}

/** Reads the product theme tokens once per theme change; falls back to the built-in values when the DOM theme lags the prop. */
function readTokens(element: HTMLElement, theme: 'dark' | 'light'): SchTokens {
  const fallback = FALLBACK_TOKENS[theme];
  const declared = document.documentElement.dataset.theme;
  if ((declared === undefined ? 'dark' : declared) !== theme) return fallback;
  const style = getComputedStyle(element);
  const read = (name: string, value: string) => style.getPropertyValue(name).trim() || value;
  return {
    bg: read('--bg', fallback.bg), panel: read('--panel', fallback.panel), text: read('--text', fallback.text), muted: read('--muted', fallback.muted),
    subtle: read('--subtle', fallback.subtle), line: read('--line', fallback.line), accent: read('--accent', fallback.accent), net: read('--net', fallback.net),
    danger: read('--danger', fallback.danger),
  };
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off';

// ---------------------------------------------------------------------------------------------------------------
// Sheet navigator (virtualized tree of sheet instances)
// ---------------------------------------------------------------------------------------------------------------

interface NavigatorProps {
  id: string;
  instances: readonly SchSheetInstance[];
  defFile: (defId: string) => string;
  repeats: ReadonlyMap<string, number>;
  current: string;
  collapsed: ReadonlySet<string>;
  popover: boolean;
  onToggle(path: string): void;
  onNavigate(path: string): void;
  onClose(): void;
}

const SheetNavigator = memo(function SheetNavigator(props: NavigatorProps) {
  const { instances, current, collapsed, onToggle, onNavigate } = props;
  const rows = useMemo(() => buildNavRows(instances, collapsed), [instances, collapsed]);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(320);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const activeIndex = rows.findIndex(row => row.instance.path === current);
  const rover = clamp(focusIndex ?? Math.max(0, activeIndex), 0, Math.max(0, rows.length - 1));

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => setHeight(list.clientHeight));
    observer.observe(list);
    setHeight(list.clientHeight);
    return () => observer.disconnect();
  }, []);

  const reveal = (index: number) => {
    const list = listRef.current;
    if (!list || index < 0) return;
    const top = index * ROW_H, bottom = top + ROW_H;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    setScrollTop(list.scrollTop);
  };
  // Keep the displayed sheet visible; in the popover also move focus into the list when it opens.
  useEffect(() => {
    reveal(activeIndex);
    setFocusIndex(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, rows.length]);
  useEffect(() => {
    if (!props.popover) return;
    listRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.popover]);
  useEffect(() => {
    if (pendingFocus.current === null) return;
    const target = listRef.current?.querySelector<HTMLButtonElement>(`button[data-row="${pendingFocus.current}"]`);
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = null; }
  });

  const move = (next: number) => {
    const index = clamp(next, 0, rows.length - 1);
    pendingFocus.current = index;
    setFocusIndex(index);
    reveal(index);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const row = rows[rover];
    if (event.key === 'Escape' && props.popover) { event.preventDefault(); props.onClose(); return; }
    if (event.altKey || event.ctrlKey || event.metaKey || !row) return;
    const page = Math.max(1, Math.floor(height / ROW_H) - 1);
    switch (event.key) {
      case 'ArrowDown': move(rover + 1); break;
      case 'ArrowUp': move(rover - 1); break;
      case 'PageDown': move(rover + page); break;
      case 'PageUp': move(rover - page); break;
      case 'Home': move(0); break;
      case 'End': move(rows.length - 1); break;
      case 'ArrowRight': if (row.hasChildren && row.collapsed) onToggle(row.instance.path); else if (row.hasChildren) move(rover + 1); break;
      case 'ArrowLeft': {
        if (row.hasChildren && !row.collapsed) { onToggle(row.instance.path); break; }
        const parent = rows.findIndex(r => r.instance.path === row.instance.parentPath);
        if (parent >= 0) move(parent);
        break;
      }
      default: return;
    }
    event.preventDefault();
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const visible: NavRow[] = rows.slice(first, last);
  return (
    <nav className={`schv-nav${props.popover ? ' schv-nav-popover' : ''}`} id={props.id} aria-label={T.sheetList}>
      <div className="schv-nav-head"><span>{T.sheets}</span><span className="mono schv-nav-count">{instances.length}</span></div>
      <div className="schv-nav-list" ref={listRef} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} onKeyDown={onKeyDown}>
        <ul className="schv-rows" style={{ height: rows.length * ROW_H }}>
          {visible.map((row, offset) => {
            const i = first + offset, instance = row.instance, active = instance.path === current;
            const repeat = props.repeats.get(instance.defId) ?? 1;
            return (
              <li key={instance.path || '(root)'} className={`schv-row${active ? ' active' : ''}`} style={{ top: i * ROW_H, height: ROW_H, paddingLeft: 6 + Math.min(instance.depth, 8) * 12 }}
                aria-setsize={rows.length} aria-posinset={i + 1}>
                {row.hasChildren
                  ? <button type="button" className="schv-twisty" tabIndex={-1} aria-expanded={!row.collapsed} aria-label={`${row.collapsed ? T.expand : T.collapse} ${instance.name}`} onClick={() => onToggle(instance.path)}>
                    {row.collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                  </button>
                  : <span className="schv-twisty-gap" aria-hidden="true" />}
                <button type="button" className="schv-row-main" data-row={i} tabIndex={i === rover ? 0 : -1} aria-current={active ? 'page' : undefined}
                  aria-label={`Page ${instance.page}, ${instance.name}, ${props.defFile(instance.defId)}${repeat > 1 ? `, ${T.repeated}` : ''}${active ? `, ${T.current}` : ''}`}
                  onFocus={() => setFocusIndex(i)} onClick={() => onNavigate(instance.path)} title={`${instance.name} (${props.defFile(instance.defId)})`}>
                  <span className="schv-page mono" aria-hidden="true">{instance.page}</span>
                  <span className="schv-row-text" aria-hidden="true">
                    <span className="schv-row-name">{instance.name || '(unnamed)'}</span>
                    <span className="schv-row-file mono">{props.defFile(instance.defId)}{repeat > 1 ? ` ×${repeat}` : ''}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------------------------------------------

interface Scene {
  sheet: SheetData | null;
  instancePath: string;
  page: string;
  refs: readonly string[];
  sheetResolved: readonly boolean[];
  selection: ResolvedSelection;
  netHighlight: ReturnType<typeof buildNetHighlight>;
  highlights: Array<{ kind: 'search' | 'probe' | 'selection'; rect: { x: number; y: number; width: number; height: number }; label?: string; active?: boolean }>;
}
const emptyScene: Scene = { sheet: null, instancePath: '', page: '', refs: [], sheetResolved: [], selection: EMPTY_SELECTION, netHighlight: null, highlights: [] };

interface DragState { id: number; start: { x: number; y: number }; last: { x: number; y: number }; moved: boolean }

function SchematicViewer(props: SchematicViewerProps) {
  const { design, instancePath, theme, compact } = props;
  const { schematic, connectivity } = design;
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const sceneRef = useRef<Scene>(emptyScene);
  const dimsRef = useRef({ width: 0, height: 0, dpr: 1 });
  const viewRef = useRef<SchView>({ x: 0, y: 0, scale: BASE_SCALE });
  const fitRef = useRef<FitMode>('page');
  const frameRef = useRef<number | null>(null);
  const animationRef = useRef<number | null>(null);
  const dirtyRef = useRef({ base: true, overlay: true, camera: false, hover: false });
  const emittedRef = useRef<ViewerCamera | null>(null);
  const initializedRef = useRef(false);
  const pendingRestoreRef = useRef<'restore' | 'page' | null>(null);
  const paletteRef = useRef<{ theme: string; palette: SchPalette; stale: boolean } | null>(null);
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null);
  const hoverHitRef = useRef<SchHit | null>(null);
  const hoverKeyRef = useRef('');
  const focusedSheetRef = useRef(-1);
  const dragRef = useRef<DragState | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<number | null>(null);
  const cursorRef = useRef('');
  const cacheRef = useRef<SheetCache | null>(null);
  const apiRef = useRef<{ frame(): void; measure(): void; wheel(event: WheelEvent): void }>({ frame() {}, measure() {}, wheel() {} });
  const [narrow, setNarrow] = useState(false);
  const [navPreference, setNavPreference] = useState<boolean | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const listId = useRef(`schv-nav-${Math.random().toString(36).slice(2, 8)}`).current;
  const hintId = `${listId}-hint`;
  const hostOverlay = useSchematicOverlay();

  // ---- derived, memoized data (rebuilt only when its inputs change; never on pointer events) ----
  const model = useMemo(() => buildModel(schematic), [schematic]);
  const instance = model.byPath.get(instancePath);
  const def = instance ? model.defs.get(instance.defId) : undefined;
  if (!cacheRef.current) cacheRef.current = new SheetCache(6);
  const sheet = useMemo(() => (def ? cacheRef.current!.get(def) : null), [def]);
  const refs = useMemo(() => (sheet ? sheet.def.symbols.map(symbol => symbolRef(symbol, instancePath)) : []), [sheet, instancePath]);
  const sheetResolved = useMemo(() => (sheet ? sheet.def.sheetRefs.map(ref => ref.defId !== null && model.defs.has(ref.defId)) : []), [sheet, model]);
  const { symbolKey: selSymbolKey, pinKey: selPinKey, netId: selNetId } = props.selection;
  const selection = useMemo(() => (sheet ? resolveSelection(sheet, instancePath, { symbolKey: selSymbolKey, pinKey: selPinKey }) : EMPTY_SELECTION), [sheet, instancePath, selSymbolKey, selPinKey]);
  const netHighlight = useMemo(() => (sheet ? buildNetHighlight(sheet, instancePath, connectivity, selNetId) : null), [sheet, instancePath, connectivity, selNetId]);
  const highlights = useMemo(
    () => (props.highlights ?? []).filter(h => h.instancePath === instancePath).map(h => ({ kind: h.kind, rect: h.rect, label: h.label, active: h.active })),
    [props.highlights, instancePath],
  );
  sceneRef.current = { sheet, instancePath, page: instance?.page ?? '', refs, sheetResolved, selection, netHighlight, highlights };

  const chain = useMemo(() => instanceChain(schematic.instances, instancePath), [schematic.instances, instancePath]);
  const position = model.index.get(instancePath) ?? -1;
  const parentPath = instance?.parentPath ?? null;
  const previous = position > 0 ? schematic.instances[position - 1] : undefined;
  const next = position >= 0 && position < schematic.instances.length - 1 ? schematic.instances[position + 1] : undefined;
  const navOpen = navPreference ?? !(narrow || compact);
  const popover = !!(narrow || compact);
  const defFile = (defId: string) => model.defs.get(defId)?.file ?? '';

  const summary = useMemo(() => {
    if (!sheet) return 'Schematic sheet is not available';
    const d = sheet.def;
    return `Schematic sheet “${instance?.name ?? d.name}”, page ${instance?.page ?? '?'} of ${schematic.instances.length}: ${d.symbols.length} symbols, ${d.wires.length} wires, ${d.labels.length} labels, ${d.sheetRefs.length} sub-sheets.`;
  }, [sheet, instance, schematic.instances.length]);
  const announcement = useMemo(() => {
    const parts: string[] = [];
    if (instance) parts.push(`Sheet ${instance.name}, page ${instance.page}`);
    if (sheet && selection.pin) parts.push(`Pin ${refs[selection.pin.symbol]} ${sheet.def.symbols[selection.pin.symbol].pins[selection.pin.pin].number} selected`);
    else if (sheet && selection.symbol >= 0) parts.push(`${refs[selection.symbol]} selected`);
    if (netHighlight) parts.push(`Net ${netHighlight.name} highlighted`);
    return parts.join('. ');
  }, [instance, sheet, selection, refs, netHighlight]);

  // ---- scheduling ----
  const schedule = () => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => { frameRef.current = null; apiRef.current.frame(); });
  };
  const markDirty = (flags: Partial<typeof dirtyRef.current>) => { Object.assign(dirtyRef.current, flags); schedule(); };

  const stopAnimation = () => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
  };
  const commitView = (target: SchView, fit: FitMode) => {
    stopAnimation();
    const scene = sceneRef.current, { width, height } = dimsRef.current;
    viewRef.current = scene.sheet ? clampView(target, scene.sheet.extent, width, height) : target;
    fitRef.current = fit;
    markDirty({ base: true, camera: true, hover: true });
  };
  const animateTo = (target: SchView, fit: FitMode) => {
    const from = viewRef.current;
    if (!propsRef.current.motion || reducedMotion() || (from.x === target.x && from.y === target.y && from.scale === target.scale)) { commitView(target, fit); return; }
    stopAnimation();
    const t0 = performance.now();
    const step = (now: number) => {
      const p = clamp((now - t0) / FIT_MS, 0, 1), e = 1 - Math.pow(1 - p, 3);
      if (p >= 1) { animationRef.current = null; commitView(target, fit); return; }
      viewRef.current = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, scale: from.scale * Math.pow(target.scale / from.scale, e) };
      fitRef.current = 'none';
      markDirty({ base: true, camera: true, hover: true });
      animationRef.current = requestAnimationFrame(step);
    };
    animationRef.current = requestAnimationFrame(step);
  };
  const fitSheet = (mode: 'page' | 'width' = 'page', animate = false) => {
    const scene = sceneRef.current, { width, height } = dimsRef.current;
    if (!scene.sheet || width < 2) return;
    // Fit the sheet (its paper), not every item: a stray note far off the page must not shrink the sheet. It stays reachable by panning (clampView uses the extent).
    const target = fitView(scene.sheet.fitBounds, width, height, mode);
    if (animate) animateTo(target, mode); else commitView(target, mode);
  };
  const zoomBy = (factor: number, animate = true, anchor?: { x: number; y: number }) => {
    const { width, height } = dimsRef.current, view = viewRef.current;
    const target = zoomAt(view, anchor ?? { x: width / 2, y: height / 2 }, view.scale * factor, width, height);
    if (animate) animateTo(target, 'none'); else commitView(target, 'none');
  };

  // ---- navigation ----
  const navigate = (path: string | null | undefined) => { if (path !== null && path !== undefined && path !== instancePath) props.onInstanceChange(path); };
  const descend = (refIndex: number) => {
    const scene = sceneRef.current;
    const ref = scene.sheet?.def.sheetRefs[refIndex];
    if (!ref || !scene.sheetResolved[refIndex]) return false;
    const path = resolveChildPath(propsRef.current.design.schematic, scene.instancePath, ref.id);
    if (path === null) return false;
    propsRef.current.onInstanceChange(path);
    return true;
  };

  // ---- hit helpers ----
  const netAt = (sheetData: SheetData, point: { x: number; y: number }): string | null => {
    const wireNet = propsRef.current.design.connectivity.wireNet;
    const eps = 0.06;
    for (const id of queryData(sheetData, point.x - eps, point.y - eps, point.x + eps, point.y + eps, [])) {
      if (sheetData.kind[id] !== K.wire) continue;
      const wire = sheetData.def.wires[id - sheetData.offsets[K.wire]];
      if (segmentDistance(point, wire.a, wire.b) <= eps) { const net = wireNet[wireKey(sceneRef.current.instancePath, wire.id)]; if (net) return net; }
    }
    return null;
  };
  const describe = (hit: SchHit): { title: string; sub: string; tone: 'net' | 'accent' | 'muted' } | null => {
    const scene = sceneRef.current, sheetData = scene.sheet;
    if (!sheetData) return null;
    const c = propsRef.current.design.connectivity, nets = netIndex(c), d = sheetData.def;
    const netName = (id: string | undefined) => (id ? nets.get(id)?.name : undefined);
    switch (hit.kind) {
      case 'pin': {
        const symbol = d.symbols[hit.symbol], pin = symbol.pins[hit.pin];
        return { title: `${scene.refs[hit.symbol]} · ${pin.number}${pin.name && pin.name !== '~' ? ` · ${pin.name}` : ''}`, sub: netName(c.pinNet[pinKey(scene.instancePath, symbol.id, pin.id)]) ?? T.noNet, tone: 'net' };
      }
      case 'symbol': {
        const symbol = d.symbols[hit.symbol];
        return { title: scene.refs[hit.symbol] || symbol.libId, sub: [symbol.value, symbol.libId, symbol.dnp ? 'DNP' : ''].filter(Boolean).join(' · '), tone: 'accent' };
      }
      case 'wire': return { title: netName(c.wireNet[wireKey(scene.instancePath, d.wires[hit.wire].id)]) ?? T.wire, sub: T.wire, tone: 'net' };
      case 'bus': return { title: T.bus, sub: '', tone: 'muted' };
      case 'label': { const label = d.labels[hit.label]; return { title: label.text, sub: `${label.kind} label`, tone: 'net' }; }
      case 'sheetPin': { const ref = d.sheetRefs[hit.ref]; return { title: `${ref.name} · ${ref.pins[hit.pin].name}`, sub: T.sheetPin, tone: 'net' }; }
      case 'sheet': { const ref = d.sheetRefs[hit.ref]; return { title: ref.name, sub: scene.sheetResolved[hit.ref] ? `${ref.file} · ${T.openHint}` : `${ref.file} · ${T.fileMissing}`, tone: 'muted' }; }
    }
  };
  const hitAt = (screen: { x: number; y: number }): SchHit | null => {
    const sheetData = sceneRef.current.sheet, { width, height } = dimsRef.current;
    return sheetData ? hitTest(sheetData, screenToSheet(viewRef.current, width, height, screen), viewRef.current.scale) : null;
  };
  const hitKey = (hit: SchHit | null) => (hit ? `${hit.kind}:${Object.values(hit).slice(1).join(':')}` : '');

  const setCursor = (value: string) => {
    if (cursorRef.current === value || !canvasRef.current) return;
    cursorRef.current = value; canvasRef.current.style.cursor = value;
  };
  const hideTip = () => { if (tipRef.current) tipRef.current.hidden = true; };

  const updateHover = () => {
    const point = hoverPointRef.current;
    const hit = point && !dragRef.current ? hitAt(point) : null;
    const key = hitKey(hit);
    const tip = tipRef.current, { width, height } = dimsRef.current;
    if (key !== hoverKeyRef.current) {
      hoverKeyRef.current = key;
      hoverHitRef.current = hit;
      dirtyRef.current.overlay = true;
      setCursor(hit ? 'pointer' : 'grab');
      const info = hit ? describe(hit) : null;
      if (tip) {
        if (info) {
          (tip.firstElementChild as HTMLElement).textContent = info.title;
          (tip.lastElementChild as HTMLElement).textContent = info.sub;
          (tip.lastElementChild as HTMLElement).hidden = !info.sub;
          tip.dataset.tone = info.tone;
        }
        tip.hidden = !info;
      }
    }
    if (tip && !tip.hidden && point) {
      tip.style.transform = `translate(${clamp(point.x + 14, 8, Math.max(8, width - 232))}px, ${clamp(point.y + 16, 8, Math.max(8, height - 62))}px)`;
    }
  };

  // ---- frame ----
  const getPalette = (): SchPalette => {
    const cached = paletteRef.current;
    if (cached && !cached.stale && cached.theme === theme) return cached.palette;
    const palette = buildPalette(readTokens(rootRef.current ?? document.documentElement, theme), theme);
    paletteRef.current = { theme, palette, stale: false };
    return palette;
  };

  const frame = () => {
    const canvas = canvasRef.current, overlay = overlayRef.current, root = rootRef.current;
    const { width, height, dpr } = dimsRef.current;
    if (!canvas || !overlay || !root || width < 2 || height < 2) return;
    const base = canvas.getContext('2d', { alpha: false }), top = overlay.getContext('2d');
    if (!base || !top) return;
    const dirty = dirtyRef.current, scene = sceneRef.current, palette = getPalette();
    const sheetData = scene.sheet, view = viewRef.current;
    if (!sheetData) {
      base.setTransform(dpr, 0, 0, dpr, 0, 0); base.fillStyle = palette.bg; base.fillRect(0, 0, width, height);
      top.setTransform(dpr, 0, 0, dpr, 0, 0); top.clearRect(0, 0, width, height);
      dirty.base = dirty.overlay = dirty.hover = false;
      return;
    }
    if (dirty.hover) { dirty.hover = false; updateHover(); }
    if (dirty.base) {
      dirty.base = false;
      const stats = drawSheet(base, {
        data: sheetData, instancePath: scene.instancePath, view, width, height, dpr, palette, refs: scene.refs,
        sheetResolved: scene.sheetResolved, netHighlight: scene.netHighlight, page: scene.page,
      });
      root.dataset.drawMs = stats.ms.toFixed(2);
      root.dataset.drawn = `${stats.symbols}/${stats.wires}/${stats.labels}`;
      dirty.overlay = true;
    }
    if (dirty.overlay) {
      dirty.overlay = false;
      drawOverlay(top, {
        data: sheetData, instancePath: scene.instancePath, view, width, height, dpr, palette, selection: scene.selection,
        hover: hoverHitRef.current, focusedSheet: focusedSheetRef.current, highlights: scene.highlights,
      });
    }
    root.dataset.view = `${view.x.toFixed(3)},${view.y.toFixed(3)},${view.scale.toFixed(4)}`;
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(view.scale / BASE_SCALE * 100)}%`;
    if (dirty.camera) {
      dirty.camera = false;
      const camera = viewToCamera(view, fitRef.current);
      if (!sameCamera(camera, emittedRef.current)) { emittedRef.current = camera; propsRef.current.onCameraChange(camera); }
    }
  };

  const measure = () => {
    const stage = stageRef.current, canvas = canvasRef.current, overlay = overlayRef.current;
    if (!stage || !canvas || !overlay) return;
    const rect = stage.getBoundingClientRect();
    const width = Math.max(0, rect.width), height = Math.max(0, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const dims = dimsRef.current;
    if (Math.abs(dims.width - width) < 0.01 && Math.abs(dims.height - height) < 0.01 && dims.dpr === dpr) return;
    dimsRef.current = { width, height, dpr };
    canvas.width = Math.max(1, Math.round(width * dpr)); canvas.height = Math.max(1, Math.round(height * dpr));
    overlay.width = canvas.width; overlay.height = canvas.height;
    const scene = sceneRef.current;
    if (width >= 2 && height >= 2 && scene.sheet) {
      if (pendingRestoreRef.current) {
        const how = pendingRestoreRef.current;
        pendingRestoreRef.current = null;
        if (how === 'restore') restoreCamera(); else fitSheet('page');
      } else if (fitRef.current !== 'none') fitSheet(fitRef.current);
      else commitView(viewRef.current, 'none');
    }
    markDirty({ base: true, camera: true, hover: true });
  };

  /** Applies the controlled camera: persisted pan/zoom verbatim, or a fresh fit when it asks for one (or is unusable). */
  const restoreCamera = () => {
    const scene = sceneRef.current, { width, height } = dimsRef.current, camera = propsRef.current.camera;
    if (!scene.sheet || width < 2) return;
    const restored = cameraToView(camera, scene.sheet.extent, width, height, scene.sheet.fitBounds);
    stopAnimation();
    viewRef.current = restored.view; fitRef.current = restored.fit;
    emittedRef.current = restored.fit === 'none' && sameCamera(viewToCamera(restored.view, 'none'), camera) ? camera : null;
    markDirty({ base: true, camera: true, hover: true });
  };

  const handleWheel = (event: WheelEvent) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas || !sceneRef.current.sheet) return;
    const rect = canvas.getBoundingClientRect(), { height } = dimsRef.current;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
    zoomBy(Math.exp(-clamp(delta, -400, 400) * (event.ctrlKey ? 0.01 : 0.0016)), false, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };
  apiRef.current = { frame, measure, wheel: handleWheel };

  // ---- lifecycle ----
  useEffect(() => {
    const stage = stageRef.current, root = rootRef.current, canvas = canvasRef.current, overlay = overlayRef.current;
    if (!stage || !root || !canvas || !overlay) return;
    const measureNow = () => apiRef.current.measure();
    const resizeObserver = new ResizeObserver(() => {
      measureNow();
      setNarrow(root.getBoundingClientRect().width < NARROW_PX);
    });
    resizeObserver.observe(stage);
    resizeObserver.observe(root);
    let resolution: MediaQueryList | null = null;
    const watchResolution = () => {
      resolution?.removeEventListener('change', onResolution);
      resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      resolution.addEventListener('change', onResolution);
    };
    function onResolution() { measureNow(); watchResolution(); }
    watchResolution();
    const onWheel = (event: WheelEvent) => apiRef.current.wheel(event);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    // The shell flips `data-theme` on <html>, possibly after this component rendered: repaint with the new tokens.
    const themeObserver = new MutationObserver(() => {
      if (paletteRef.current) paletteRef.current.stale = true;
      dirtyRef.current.base = true;
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(() => { frameRef.current = null; apiRef.current.frame(); });
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    measureNow();
    setNarrow(root.getBoundingClientRect().width < NARROW_PX);
    return () => {
      resizeObserver.disconnect(); themeObserver.disconnect();
      resolution?.removeEventListener('change', onResolution);
      canvas.removeEventListener('wheel', onWheel);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      frameRef.current = null; animationRef.current = null;
      // Releases the backing stores right away instead of waiting for garbage collection.
      canvas.width = 0; canvas.height = 0; overlay.width = 0; overlay.height = 0;
      dimsRef.current = { width: 0, height: 0, dpr: 1 };
      cacheRef.current?.clear();
    };
  }, []);

  // A new sheet instance: reset transient interaction state, then fit it (or restore the persisted camera on first show).
  useLayoutEffect(() => {
    hoverHitRef.current = null; hoverKeyRef.current = ''; hoverPointRef.current = null; focusedSheetRef.current = -1;
    hideTip(); stopAnimation();
    const first = !initializedRef.current;
    initializedRef.current = true;
    if (!sheet) { markDirty({ base: true, overlay: true }); return; }
    if (dimsRef.current.width < 2) { pendingRestoreRef.current = pendingRestoreRef.current ?? (first ? 'restore' : 'page'); return; }
    if (first) restoreCamera(); else fitSheet('page');
    markDirty({ base: true, overlay: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, instancePath]);

  // The shell changed the camera (restored a bookmark, reset the view...): follow it unless it is our own echo.
  const { zoom: camZoom, x: camX, y: camY, fit: camFit } = props.camera;
  useEffect(() => {
    if (!initializedRef.current || sameCamera(propsRef.current.camera, emittedRef.current)) return;
    if (!sceneRef.current.sheet || dimsRef.current.width < 2) return;
    restoreCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camZoom, camX, camY, camFit]);

  useLayoutEffect(() => {
    markDirty({ base: true, overlay: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, netHighlight, highlights, refs, sheetResolved, theme]);
  useEffect(() => { if (paletteRef.current) paletteRef.current.stale = true; markDirty({ base: true }); }, [theme]);

  // ---- pointer interaction (refs only: no React state is touched at pointer rate) ----
  const local = (event: { clientX: number; clientY: number; currentTarget: Element }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const click = (screen: { x: number; y: number }) => {
    const scene = sceneRef.current, sheetData = scene.sheet, current = propsRef.current;
    if (!sheetData) return;
    const hit = hitAt(screen);
    const d = sheetData.def;
    focusedSheetRef.current = -1;
    const clear = () => { current.onSelectNet(null); markDirty({ overlay: true }); };
    if (!hit) { clear(); return; }
    switch (hit.kind) {
      case 'pin': {
        const symbol = d.symbols[hit.symbol], pin = symbol.pins[hit.pin];
        current.onSelectPin({ instancePath: scene.instancePath, symbolId: symbol.id, pinId: pin.id, ref: scene.refs[hit.symbol], pinNumber: pin.number });
        break;
      }
      case 'symbol': current.onSelectSymbol({ instancePath: scene.instancePath, symbolId: d.symbols[hit.symbol].id, ref: scene.refs[hit.symbol] }); break;
      case 'wire': current.onSelectNet(current.design.connectivity.wireNet[wireKey(scene.instancePath, d.wires[hit.wire].id)] ?? null); break;
      case 'label': {
        const label = d.labels[hit.label];
        current.onSelectNet(netAt(sheetData, label.at) ?? (label.kind === 'global' && netIndex(current.design.connectivity).has(`net:global:${label.text}`) ? `net:global:${label.text}` : null));
        break;
      }
      case 'sheetPin': {
        const net = netAt(sheetData, d.sheetRefs[hit.ref].pins[hit.pin].at);
        focusedSheetRef.current = hit.ref;
        current.onSelectNet(net); markDirty({ overlay: true });
        break;
      }
      case 'sheet': focusedSheetRef.current = hit.ref; clear(); break;
      default: clear();
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    stopAnimation();
    const point = local(event);
    pointersRef.current.set(event.pointerId, point);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointers cannot be captured */ }
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = Math.hypot(a.x - b.x, a.y - b.y);
      dragRef.current = null;
    } else {
      dragRef.current = { id: event.pointerId, start: point, last: point, moved: false };
    }
    hideTip(); hoverKeyRef.current = ''; hoverHitRef.current = null;
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = local(event);
    if (pointersRef.current.has(event.pointerId)) pointersRef.current.set(event.pointerId, point);
    if (pointersRef.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointersRef.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance > 4) { zoomBy(distance / pinchRef.current, false, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); pinchRef.current = distance; }
      return;
    }
    const drag = dragRef.current;
    if (drag && drag.id === event.pointerId) {
      if (!drag.moved && Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 4) { drag.moved = true; setCursor('grabbing'); }
      if (drag.moved) commitView(panBy(viewRef.current, point.x - drag.last.x, point.y - drag.last.y), 'none');
      drag.last = point;
      return;
    }
    if (event.pointerType === 'touch') return;
    hoverPointRef.current = point;
    markDirty({ hover: true });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setCursor(drag.moved ? 'grab' : cursorRef.current);
    if (!drag.moved && event.button === 0) click(local(event));
    hoverPointRef.current = event.pointerType === 'touch' ? null : local(event);
    markDirty({ hover: true });
  };
  const onPointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(event.pointerId);
    pinchRef.current = null;
    dragRef.current = null;
  };
  const onPointerLeave = () => {
    if (dragRef.current) return;
    hoverPointRef.current = null; hideTip();
    markDirty({ hover: true });
  };
  const onDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const hit = hitAt(local(event));
    if (hit && (hit.kind === 'sheet' || hit.kind === 'sheetPin')) { descend(hit.ref); return; }
    if (!hit) zoomBy(1.6, true, local(event));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (event.ctrlKey || event.metaKey) return;
    const scene = sceneRef.current, step = event.shiftKey ? 160 : 48;
    const pan = (dx: number, dy: number) => commitView(panBy(viewRef.current, dx, dy), 'none');
    switch (event.key) {
      case 'ArrowLeft': pan(step, 0); break;
      case 'ArrowRight': pan(-step, 0); break;
      case 'ArrowUp':
        if (event.altKey) navigate(parentPath); else pan(0, step);
        break;
      case 'ArrowDown': pan(0, -step); break;
      case '+': case '=': zoomBy(1.35); break;
      case '-': case '_': zoomBy(1 / 1.35); break;
      case '0': case 'f': case 'F': fitSheet('page', true); break;
      case 'Backspace': navigate(parentPath); break;
      case 'PageDown': case ']': navigate(next?.path); break;
      case 'PageUp': case '[': navigate(previous?.path); break;
      case 's': case 'S': {
        const count = scene.sheet?.def.sheetRefs.length ?? 0;
        if (!count) return;
        const current = focusedSheetRef.current;
        focusedSheetRef.current = event.shiftKey ? (current <= 0 ? count - 1 : current - 1) : (current + 1) % count;
        const ref = scene.sheet!.def.sheetRefs[focusedSheetRef.current];
        const { width, height } = dimsRef.current, view = viewRef.current;
        const screen = { x: width / 2 + (ref.at.x + ref.size.x / 2 - view.x) * view.scale, y: height / 2 + (ref.at.y + ref.size.y / 2 - view.y) * view.scale };
        if (screen.x < 0 || screen.y < 0 || screen.x > width || screen.y > height) commitView({ ...view, x: ref.at.x + ref.size.x / 2, y: ref.at.y + ref.size.y / 2 }, 'none');
        markDirty({ overlay: true });
        break;
      }
      case 'Enter': if (!(focusedSheetRef.current >= 0 && descend(focusedSheetRef.current))) return; break;
      case 'Escape':
        focusedSheetRef.current = -1; propsRef.current.onSelectNet(null); markDirty({ overlay: true });
        break;
      default: return;
    }
    event.preventDefault();
  };

  const toggleCollapsed = (path: string) => setCollapsed(previousSet => {
    const nextSet = new Set(previousSet);
    if (!nextSet.delete(path)) nextSet.add(path);
    return nextSet;
  });
  // A displayed sheet is never hidden inside a collapsed branch.
  useEffect(() => {
    setCollapsed(previousSet => {
      let changed = false;
      const nextSet = new Set(previousSet);
      for (const ancestor of chain.slice(0, -1)) if (nextSet.delete(ancestor.path)) changed = true;
      return changed ? nextSet : previousSet;
    });
  }, [chain]);

  const closeNav = () => { setNavPreference(false); toggleRef.current?.focus(); };
  const choose = (path: string) => {
    navigate(path);
    if (popover) setNavPreference(false);
  };

  const rootPath = schematic.instances[0]?.path ?? '';
  const crumbs = popover ? chain.slice(-2) : chain;
  const state = !instance ? 'noInstance' : !sheet ? 'noDef' : null;

  return (
    <div ref={rootRef} className={`schv${compact || narrow ? ' schv-compact' : ''}`}>
      <div className="schv-toolbar" role="toolbar" aria-label={T.toolbar}>
        <button type="button" ref={toggleRef} className={`schv-btn${navOpen ? ' on' : ''}`} aria-label={T.sheets} aria-expanded={navOpen} aria-controls={listId} onClick={() => setNavPreference(!navOpen)} title={T.sheets}>
          <PanelLeft size={16} aria-hidden="true" /><span className="schv-btn-text">{T.sheets}</span>
        </button>
        <span className="schv-sep" aria-hidden="true" />
        <button type="button" className="schv-btn schv-icon" aria-label={T.parent} title={T.parent} disabled={parentPath === null} onClick={() => navigate(parentPath)}><CornerLeftUp size={16} aria-hidden="true" /></button>
        <button type="button" className="schv-btn schv-icon" aria-label={T.previous} title={T.previous} disabled={!previous} onClick={() => navigate(previous?.path)}><ChevronLeft size={16} aria-hidden="true" /></button>
        <button type="button" className="schv-btn schv-icon" aria-label={T.next} title={T.next} disabled={!next} onClick={() => navigate(next?.path)}><ChevronRight size={16} aria-hidden="true" /></button>
        <nav className="schv-crumbs" aria-label={T.path}>
          <ol>
            {popover && chain.length > 2 && <li aria-hidden="true" className="schv-crumb-gap">{'…'}</li>}
            {crumbs.map((item, i) => {
              const last = i === crumbs.length - 1;
              return (
                <li key={item.path || '(root)'}>
                  {last
                    ? <span className="schv-crumb-current" aria-current="page" title={item.name}>{item.name || '(unnamed)'}</span>
                    : <button type="button" className="schv-crumb" onClick={() => navigate(item.path)} title={item.name}>{item.name || '(unnamed)'}</button>}
                  {!last && <ChevronRight size={12} className="schv-crumb-sep" aria-hidden="true" />}
                </li>
              );
            })}
          </ol>
        </nav>
        <span className="schv-position mono" aria-hidden="true">{position >= 0 ? `${position + 1}/${schematic.instances.length}` : ''}</span>
      </div>
      <div className="schv-body">
        {navOpen && (
          <SheetNavigator id={listId} instances={schematic.instances} defFile={defFile} repeats={model.repeats} current={instancePath} collapsed={collapsed}
            popover={popover} onToggle={toggleCollapsed} onNavigate={choose} onClose={closeNav} />
        )}
        {navOpen && popover && <div className="schv-scrim" aria-hidden="true" onClick={closeNav} />}
        <div className="schv-stage" ref={stageRef}>
          <canvas
            ref={canvasRef} className="schv-canvas" role="img" tabIndex={0} aria-label={summary} aria-describedby={hintId}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onPointerLeave={onPointerLeave}
            onDoubleClick={onDoubleClick} onKeyDown={onKeyDown}
          />
          <canvas ref={overlayRef} className="schv-overlay" aria-hidden="true" />
          <div className="schv-tip" ref={tipRef} hidden aria-hidden="true"><strong className="mono" /><span /></div>
          {hostOverlay ? <div className="schv-host-overlay" data-testid="schematic-overlay">{hostOverlay}</div> : null}
          <div className="schv-tools" role="group" aria-label={T.view}>
            <button type="button" className="schv-btn schv-icon" aria-label={T.zoomOut} title={T.zoomOut} onClick={() => zoomBy(1 / 1.35)}><Minus size={16} aria-hidden="true" /></button>
            <span className="schv-zoom mono" ref={zoomLabelRef} aria-hidden="true">100%</span>
            <button type="button" className="schv-btn schv-icon" aria-label={T.zoomIn} title={T.zoomIn} onClick={() => zoomBy(1.35)}><Plus size={16} aria-hidden="true" /></button>
            <span className="schv-sep" aria-hidden="true" />
            <button type="button" className="schv-btn schv-icon" aria-label={T.fit} title={T.fit} onClick={() => fitSheet('page', true)}><Maximize2 size={15} aria-hidden="true" /></button>
          </div>
          {state && (
            <div className="schv-empty" role="alert">
              <p>{state === 'noInstance' ? T.noInstance : T.noDef}</p>
              <button type="button" className="schv-action" onClick={() => props.onInstanceChange(rootPath)}>{T.gotoRoot}</button>
            </div>
          )}
          <p id={hintId} className="schv-sr">{T.keys}</p>
          <div className="schv-sr" role="status" aria-live="polite">{announcement}</div>
        </div>
      </div>
    </div>
  );
}

const MemoizedSchematicViewer = memo(SchematicViewer);
export { MemoizedSchematicViewer as SchematicViewer };
export default MemoizedSchematicViewer;
