import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Board, BoardComponent, BoardPin, CanvasStatus, Language, ViewCommand, ViewSide } from '../lib/types';
import { createFormatters, createTranslator } from '../lib/i18n';
import {
  boardToScreen, boundsCenter, boundsCorners, clamp, distance, expandBounds,
  fitView, orientPoint, padBounds, panBy, screenToBoard, SpatialIndex, viewportBounds, zoomAt,
} from '../lib/geometry';
import type { Bounds2, Point2, ViewTransform } from '../lib/geometry';
import { clipSegmentToBounds } from '../lib/render-geometry';
import { cameraToView, sameCamera, viewShowsBoard, viewToCamera } from './board-camera';
import type { BoardCamera } from './board-camera';
import { hitTestBoard } from './board-hit-test';
import { strokeMeasurementLine } from './board-measure-line';
import { anyContextLost, bindCanvasRecovery } from './board-canvas-recovery';
import type { CanvasRecovery } from './board-canvas-recovery';
import { boundsCover, buildPadLayers, PAD_REGION_SLACK, PAD_VIEW_MARGIN_PX, planPadLayers, samePadPlan } from './board-pad-layers';
import type { PadLayerPlan, PadLayers } from './board-pad-layers';

export interface BoardCanvasProps {
  board: Board;
  side: ViewSide;
  selectedComponentId: string | null;
  selectedPinId: string | null;
  selectedNet: string | null;
  showLabels: boolean;
  showConnections: boolean;
  measureMode: boolean;
  /** `automatic` = issued by the shell on its own (initial fit after a load): applied, but it is not a user change and is never persisted. */
  viewCommand: (ViewCommand & { automatic?: boolean }) | null;
  /**
   * Stored view of THIS board (the shell derives it from the workspace manifest). It replaces the automatic fit: applied once per
   * board, only while the user has not moved the view yet and only when it shows part of the board; it may arrive after the board
   * because the workspace loads asynchronously. Absent or rejected → the board stays fitted.
   */
  initialCamera?: BoardCamera | null;
  /** Called when a stored camera was applied, so the shell can show the stored side (a mirrored bottom view needs the matching `side` prop). */
  onCameraRestore?(camera: BoardCamera): void;
  /** Idle-debounced (CAMERA_IDLE_MS, flushed on unmount/hide) view after a USER change; never for the automatic fit or the restore itself. */
  onCameraChange?(camera: BoardCamera): void;
  theme: 'dark' | 'light';
  motion: boolean;
  /** Only the language code is passed (never a translator function), so the memoized canvas keeps stable props. */
  language: Language;
  onSelectComponent(id: string | null): void;
  onSelectPin(id: string): void;
  onStatusChange?(status: CanvasStatus): void;
}

/** The view is reported once it stopped changing for this long: a pan/zoom gesture never reaches the shell at pointer rate. */
const CAMERA_IDLE_MS = 350;
/** Backstop for a missed contextrestored event: the (draw-free) lost-context check runs this often. Idle stays at 0 draws. */
const CONTEXT_CHECK_MS = 1000;

interface HoverTarget { component: BoardComponent; pin?: BoardPin; screen: Point2 }
interface DragState { id: number; start: Point2; last: Point2; moved: boolean }
interface CanvasDimensions { width: number; height: number; dpr: number }
interface NetGroup { pins: BoardPin[]; components: Set<string> }
/** Display paths of the pads of the viewport region (plus a pan margin) at one zoom and selection; rebuilt when any of them or the region changes. */
interface PinLayerCache {
  board: Board; side: ViewSide; scale: number; net: string | null; component: string | null; region: Bounds2; paths: PadLayers<Path2D>;
}
interface ConnectionCache {
  pins: readonly BoardPin[]; source: BoardPin; path: Path2D;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  clipped?: { bounds: ConnectionCache['bounds']; path: Path2D };
}
const emptyPins: BoardPin[] = [];
const emptyComponents = new Set<string>();
const denseNetThreshold = 192;

function buildConnections(pins: readonly BoardPin[], source: BoardPin): ConnectionCache {
  const path = new Path2D();
  const bounds = { minX: source.x, minY: source.y, maxX: source.x, maxY: source.y };
  for (const pin of pins) {
    if (pin.id === source.id) continue;
    path.moveTo(source.x, source.y); path.lineTo(pin.x, pin.y);
    bounds.minX = Math.min(bounds.minX, pin.x); bounds.maxX = Math.max(bounds.maxX, pin.x);
    bounds.minY = Math.min(bounds.minY, pin.y); bounds.maxY = Math.max(bounds.maxY, pin.y);
  }
  return { pins, source, path, bounds };
}

function visibleConnections(cache: ConnectionCache, bounds: ConnectionCache['bounds']): Path2D {
  const all = cache.bounds;
  if (bounds.minX <= all.minX && bounds.maxX >= all.maxX && bounds.minY <= all.minY && bounds.maxY >= all.maxY) return cache.path;
  const previous = cache.clipped;
  if (previous && previous.bounds.minX === bounds.minX && previous.bounds.maxX === bounds.maxX
    && previous.bounds.minY === bounds.minY && previous.bounds.maxY === bounds.maxY) return previous.path;
  const path = new Path2D();
  for (const pin of cache.pins) {
    if (pin.id === cache.source.id) continue;
    const segment = clipSegmentToBounds(cache.source, pin, bounds);
    if (segment) { path.moveTo(segment.from.x, segment.from.y); path.lineTo(segment.to.x, segment.to.y); }
  }
  cache.clipped = { bounds, path };
  return path;
}

const palettes = {
  dark: {
    background: '#0d131b', grid: '#263644', board: '#142a28', boardLine: '#659487',
    body: '#475b56', bodyLine: '#a2b5a6', chip: '#354b5d', chipLine: '#96b3c7',
    connector: '#5e5a49', connectorLine: '#bcb69a', chipInset: '#6e8799',
    pad: '#d6ddc8', label: '#e4eadf', labelBacking: '#0e191ed9', labelHalo: '#0e191e',
    hoverLine: '#e4ead7', hoverGlow: '#dde7cb4d', amberGlow: '#efb75170', netFill: '#285157',
    amber: '#efb751', amberFill: '#66502e', cyan: '#56d4cf', text: '#e8eff5', card: '#141d28', muted: '#8fa3b3',
  },
  light: {
    background: '#edf1ed', grid: '#cad4cc', board: '#e0e9df', boardLine: '#6d8879',
    body: '#a8b9ac', bodyLine: '#536f60', chip: '#a5b7c2', chipLine: '#4d6a80',
    connector: '#c8bda0', connectorLine: '#837653', chipInset: '#70899b',
    pad: '#365b4a', label: '#263f39', labelBacking: '#f6f9f0ed', labelHalo: '#f6f9f0',
    hoverLine: '#304f47', hoverGlow: '#365b4a45', amberGlow: '#a9752460', netFill: '#badfd9',
    amber: '#9b650d', amberFill: '#f3d79a', cyan: '#008a89', text: '#1b2b32', card: '#fcfcf8', muted: '#586b73',
  },
};

type ComponentKind = 'chip' | 'connector' | 'passive';
function componentKind(component: BoardComponent): ComponentKind {
  const metadata = `${component.package} ${component.value}`;
  if (/^(?:[A-Z]*U|IC|VRAM)\d/i.test(component.ref) || /\b(?:[A-Z]*BGA|QFN|QFP|SOIC|TSSOP|LQFP)\b/i.test(metadata)) return 'chip';
  if (/^(?:[APLHSK]?(?:CN|CON)[\d_-]|(?:J|P|PJ|PJP|JP|AJ|RJ)\d)/i.test(component.ref) || /\b(?:CONNECTOR|CONN|HEADER|SOCKET|USB|HDMI|SATA|RJ45|FPC|FFC)\b/i.test(metadata)) return 'connector';
  return 'passive';
}

function componentPath(component: BoardComponent): Path2D {
  const path = new Path2D();
  if (component.outline.length >= 3) {
    path.moveTo(component.outline[0].x, component.outline[0].y);
    for (let i = 1; i < component.outline.length; i++) path.lineTo(component.outline[i].x, component.outline[i].y);
    path.closePath();
  } else {
    const b = component.bounds;
    path.rect(b.minX, b.minY, Math.max(0.08, b.maxX - b.minX), Math.max(0.08, b.maxY - b.minY));
  }
  return path;
}

const onSide = (item: { side: string }, side: ViewSide) => item.side === side || item.side === 'both';

function BoardCanvas(props: BoardCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const baseDirtyRef = useRef(true);
  const pinLayersRef = useRef<PinLayerCache | null>(null);
  const padPlanRef = useRef<PadLayerPlan | null>(null);
  const connectionsRef = useRef<ConnectionCache | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const dimensionsRef = useRef<CanvasDimensions>({ width: 1, height: 1, dpr: 1 });
  const viewRef = useRef<ViewTransform>({ center: boundsCenter(props.board.bounds), scale: 1, rotation: 0, mirrored: props.side === 'bottom' });
  const fitScaleRef = useRef(1);
  const drawRef = useRef<() => void>(() => {});
  const frameRef = useRef<number | null>(null);
  const animationRef = useRef<number | null>(null);
  const selectionTimeRef = useRef(0);
  const cursorRef = useRef<Point2 | null>(null);
  const measurementRef = useRef<Point2[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const lastStatusRef = useRef(0);
  const lastHoverKeyRef = useRef('');
  const touchedRef = useRef(false);
  const restoredBoardRef = useRef<Board | null>(null);
  const cameraTimerRef = useRef<number | null>(null);
  const cameraBoardRef = useRef<Board | null>(null);
  const lastCameraRef = useRef<BoardCamera | null>(null);
  const targetViewRef = useRef<ViewTransform | null>(null);
  const recoveryRef = useRef<CanvasRecovery | null>(null);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const [dragging, setDragging] = useState(false);

  const data = useMemo(() => {
    const components = new Map(props.board.components.map(component => [component.id, component]));
    const pins = new Map(props.board.pins.map(pin => [pin.id, pin]));
    const paths = new Map(props.board.components.map(component => [component.id, componentPath(component)]));
    const kinds = new Map(props.board.components.map(component => [component.id, componentKind(component)]));
    const componentIndices = { top: new SpatialIndex<BoardComponent>(8), bottom: new SpatialIndex<BoardComponent>(8) };
    const pinIndices = { top: new SpatialIndex<BoardPin>(8), bottom: new SpatialIndex<BoardPin>(8) };
    const netPins = { top: new Map<string, NetGroup>(), bottom: new Map<string, NetGroup>() };
    const sidePins: Record<ViewSide, BoardPin[]> = { top: [], bottom: [] };
    for (const component of props.board.components) {
      if (onSide(component, 'top')) componentIndices.top.add(component, component.bounds);
      if (onSide(component, 'bottom')) componentIndices.bottom.add(component, component.bounds);
    }
    for (const pin of props.board.pins) {
      const bounds = padBounds(pin, 0.06);
      for (const side of ['top', 'bottom'] as const) {
        if (!onSide(pin, side)) continue;
        pinIndices[side].add(pin, bounds);
        sidePins[side].push(pin);
        let group = netPins[side].get(pin.net);
        if (!group) { group = { pins: [], components: new Set() }; netPins[side].set(pin.net, group); }
        group.pins.push(pin); group.components.add(pin.componentId);
      }
    }
    const boardPath = new Path2D();
    const outline = props.board.outline.length >= 3 ? props.board.outline : boundsCorners(props.board.bounds);
    boardPath.moveTo(outline[0].x, outline[0].y);
    for (let i = 1; i < outline.length; i++) boardPath.lineTo(outline[i].x, outline[i].y);
    boardPath.closePath();
    return { components, pins, paths, kinds, componentIndices, pinIndices, netPins, sidePins, boardPath };
  }, [props.board]);

  const selection = useMemo(() => {
    const group = props.selectedNet ? data.netPins[props.side].get(props.selectedNet) : undefined;
    const pins = group?.pins ?? emptyPins;
    const selectedPin = props.selectedPinId ? data.pins.get(props.selectedPinId) : undefined;
    const source = (selectedPin && selectedPin.net === props.selectedNet && onSide(selectedPin, props.side) ? selectedPin : undefined)
      ?? pins.find(pin => pin.componentId === props.selectedComponentId) ?? pins[0];
    return { pins, components: group?.components ?? emptyComponents, source };
  }, [data, props.side, props.selectedNet, props.selectedPinId, props.selectedComponentId]);

  const clearHover = useCallback(() => {
    lastHoverKeyRef.current = '';
    setHover(null);
  }, []);

  const requestOverlay = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      drawRef.current();
    });
  }, []);

  const requestDraw = useCallback(() => {
    baseDirtyRef.current = true;
    requestOverlay();
  }, [requestOverlay]);

  const reportStatus = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - lastStatusRef.current < 50) return;
    lastStatusRef.current = now;
    const view = viewRef.current;
    const cursor = cursorRef.current ?? view.center;
    const measured = measurementRef.current;
    propsRef.current.onStatusChange?.({
      zoom: Math.round(view.scale / Math.max(0.001, fitScaleRef.current) * 100),
      x: cursor.x, y: cursor.y, rotation: view.rotation,
      measurement: measured.length === 2 ? distance(measured[0], measured[1]) : null,
    });
  }, []);

  const stopAnimation = useCallback(() => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
  }, []);

  const emitCamera = useCallback(() => {
    const board = cameraBoardRef.current;
    if (!board || propsRef.current.board !== board) return; // a camera of the previous board must never reach the new one
    const camera = viewToCamera(animationRef.current !== null && targetViewRef.current ? targetViewRef.current : viewRef.current);
    if (sameCamera(camera, lastCameraRef.current)) return;
    lastCameraRef.current = camera;
    propsRef.current.onCameraChange?.(camera);
  }, []);
  const flushCamera = useCallback(() => {
    if (cameraTimerRef.current === null) return;
    window.clearTimeout(cameraTimerRef.current); cameraTimerRef.current = null;
    emitCamera();
  }, [emitCamera]);
  /** Marks a user-driven view change; the view is reported after it has been idle for CAMERA_IDLE_MS. */
  const touchCamera = useCallback(() => {
    touchedRef.current = true;
    cameraBoardRef.current = propsRef.current.board;
    if (cameraTimerRef.current !== null) window.clearTimeout(cameraTimerRef.current);
    cameraTimerRef.current = window.setTimeout(() => { cameraTimerRef.current = null; emitCamera(); }, CAMERA_IDLE_MS);
  }, [emitCamera]);

  const moveView = useCallback((next: ViewTransform, animate = false, user = true) => {
    stopAnimation();
    clearHover();
    const previous = viewRef.current;
    if (user) { targetViewRef.current = next; touchCamera(); }
    if (!animate || !propsRef.current.motion || previous.rotation !== next.rotation || previous.mirrored !== next.mirrored) {
      viewRef.current = next;
      requestDraw();
      reportStatus(true);
      return;
    }
    const start = performance.now();
    const animateFrame = (now: number) => {
      clearHover();
      const progress = clamp((now - start) / 190, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      viewRef.current = {
        ...next,
        center: { x: previous.center.x + (next.center.x - previous.center.x) * eased, y: previous.center.y + (next.center.y - previous.center.y) * eased },
        scale: previous.scale * Math.pow(next.scale / previous.scale, eased),
      };
      requestDraw();
      reportStatus(progress === 1);
      animationRef.current = progress < 1 ? requestAnimationFrame(animateFrame) : null;
    };
    animationRef.current = requestAnimationFrame(animateFrame);
  }, [clearHover, reportStatus, requestDraw, stopAnimation, touchCamera]);

  drawRef.current = () => {
    const canvas = canvasRef.current;
    const base = canvas?.getContext('2d', { alpha: false });
    const overlay = overlayRef.current?.getContext('2d');
    if (!canvas || !base || !overlay) return;
    // W-fix2-portable-02: while a context is lost (GPU process gone) every draw call is a no-op; skip, keep the frame dirty and let the
    // contextrestored event (or the visible/focus/timer check) repaint everything once the contexts are usable again.
    if (anyContextLost([base, overlay])) { baseDirtyRef.current = true; recoveryRef.current?.invalidate(); return; }
    let ctx = base;
    const { width, height, dpr } = dimensionsRef.current;
    const view = viewRef.current;
    const current = propsRef.current;
    const palette = palettes[current.theme];
    const screenPoint = (point: Point2) => boardToScreen(point, view, width, height);
    const netPins = selection.pins;
    const netComponents = selection.components;
    const animationProgress = current.motion ? clamp((performance.now() - selectionTimeRef.current) / 360, 0, 1) : 1;
    const basisX = orientPoint({ x: 1, y: 0 }, view.rotation, view.mirrored);
    const basisY = orientPoint({ x: 0, y: 1 }, view.rotation, view.mirrored);
    const screenOrigin = screenPoint({ x: 0, y: 0 });
    const boardTransform = () => ctx.setTransform(
      basisX.x * view.scale * dpr, basisX.y * view.scale * dpr,
      basisY.x * view.scale * dpr, basisY.y * view.scale * dpr,
      screenOrigin.x * dpr, screenOrigin.y * dpr,
    );

    if (baseDirtyRef.current) {
      baseDirtyRef.current = false;
      const components = data.componentIndices[current.side].query(viewportBounds(view, width, height, 30));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = palette.background;
      ctx.fillRect(0, 0, width, height);
      // The grid follows the board during panning; spacing changes by powers of ten.
      const gridUnit = Math.pow(10, Math.floor(Math.log10(28 / view.scale)));
      let spacing = gridUnit * view.scale;
      if (spacing < 14) spacing *= 5;
      const origin = screenPoint({ x: 0, y: 0 });
      const startX = ((origin.x % spacing) + spacing) % spacing;
      const startY = ((origin.y % spacing) + spacing) % spacing;
      ctx.fillStyle = palette.grid;
      for (let x = startX; x < width; x += spacing) for (let y = startY; y < height; y += spacing) {
        ctx.fillRect(x, y, 1.2, 1.2);
      }

      boardTransform();
      ctx.fillStyle = palette.board;
      ctx.strokeStyle = palette.boardLine;
      ctx.lineWidth = 1.2 / view.scale;
      ctx.fill(data.boardPath);
      ctx.stroke(data.boardPath);

      // Every straight link is an exact logical relation, never a copper trace. Dense
      // nets use thin solid lines: thousands of dashes cost much more to rasterize.
      if (current.showConnections && netPins.length > 1 && selection.source) {
        let cache = connectionsRef.current;
        if (!cache || cache.pins !== netPins || cache.source !== selection.source) {
          cache = buildConnections(netPins, selection.source);
          connectionsRef.current = cache;
        }
        const dense = netPins.length - 1 > denseNetThreshold;
        ctx.strokeStyle = palette.cyan;
        ctx.globalAlpha = dense ? 0.13 : 0.22;
        ctx.lineWidth = (dense ? 0.65 : 0.9) / view.scale;
        ctx.setLineDash(dense ? [] : [4 / view.scale, 5 / view.scale]);
        ctx.stroke(visibleConnections(cache, viewportBounds(view, width, height, 1)));
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }

      for (const component of components) {
        const selected = component.id === current.selectedComponentId;
        const linked = netComponents.has(component.id);
        const b = component.bounds;
        const projectedWidth = (b.maxX - b.minX) * view.scale;
        const projectedHeight = (b.maxY - b.minY) * view.scale;
        const projectedSize = Math.max(projectedWidth, projectedHeight);
        const outline = data.paths.get(component.id)!;
        const kind = data.kinds.get(component.id);
        const fill = kind === 'chip' ? palette.chip : kind === 'connector' ? palette.connector : palette.body;
        const line = kind === 'chip' ? palette.chipLine : kind === 'connector' ? palette.connectorLine : palette.bodyLine;
        ctx.globalAlpha = current.selectedNet && !linked && !selected ? 0.48 : 1;
        ctx.fillStyle = selected ? palette.amberFill : linked ? palette.netFill : fill;
        ctx.strokeStyle = selected ? palette.amber : linked ? palette.cyan : line;
        ctx.lineWidth = (selected ? 2 : linked ? 1.4 : 0.95) / view.scale;
        if (projectedSize < 3) {
          // Display-only footprint markers keep tiny parts visible without changing geometry.
          const center = boundsCenter(b);
          const markerWidth = Math.max(b.maxX - b.minX, 2.6 / view.scale);
          const markerHeight = Math.max(b.maxY - b.minY, 2.6 / view.scale);
          ctx.fillRect(center.x - markerWidth / 2, center.y - markerHeight / 2, markerWidth, markerHeight);
        } else {
          ctx.fill(outline);
          ctx.stroke(outline);
        }
        if (selected) {
          ctx.save();
          ctx.shadowColor = palette.amberGlow;
          ctx.shadowBlur = 14 * dpr;
          ctx.stroke(outline);
          ctx.restore();
        }
        // A quiet inset gives larger IC bodies depth; these are styling details, not pins.
        if (kind === 'chip' && Math.min(projectedWidth, projectedHeight) > 24) {
          const inset = Math.max(2.5 / view.scale, Math.min(b.maxX - b.minX, b.maxY - b.minY) * 0.13);
          ctx.save(); ctx.clip(outline);
          ctx.strokeStyle = selected ? palette.amber : linked ? palette.cyan : palette.chipInset;
          ctx.lineWidth = 0.7 / view.scale;
          ctx.strokeRect(b.minX + inset, b.minY + inset, b.maxX - b.minX - inset * 2, b.maxY - b.minY - inset * 2);
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;

      // Each pad keeps its physical shape plus the same screen-size fallback marker.
      // Cached batches replace thousands of fill/rotate/save calls during panning.
      // P04: only the pads of the viewport (plus a pan margin) get display paths, so a zoom step costs nothing for pads far outside the view;
      // the layer/batch assignment is per selection and zoom-independent (board-pad-layers.ts), which keeps every batch's members as before.
      let pinCache = pinLayersRef.current;
      const sidePins = data.sidePins[current.side];
      const needed = viewportBounds(view, width, height, PAD_VIEW_MARGIN_PX);
      if (!pinCache || pinCache.board !== current.board || pinCache.side !== current.side || pinCache.scale !== view.scale
        || pinCache.net !== current.selectedNet || pinCache.component !== current.selectedComponentId || !boundsCover(pinCache.region, needed)) {
        let plan = padPlanRef.current;
        if (!samePadPlan(plan, sidePins, current.selectedNet, current.selectedComponentId)) {
          plan = planPadLayers(sidePins, current.selectedNet, current.selectedComponentId);
          padPlanRef.current = plan;
        }
        const region = viewportBounds(view, width, height, PAD_VIEW_MARGIN_PX + Math.max(width, height) * PAD_REGION_SLACK);
        pinCache = {
          board: current.board, side: current.side, scale: view.scale, net: current.selectedNet, component: current.selectedComponentId, region,
          paths: buildPadLayers(plan, region, view.scale, () => new Path2D()),
        };
        pinLayersRef.current = pinCache;
      }
      ctx.globalAlpha = current.selectedNet ? 0.44 : 1;
      ctx.fillStyle = palette.pad;
      for (const path of pinCache.paths.ordinary) ctx.fill(path);
      ctx.globalAlpha = 1;
      ctx.fillStyle = palette.amber;
      for (const path of pinCache.paths.selectedComponent) ctx.fill(path);
      ctx.fillStyle = palette.cyan;
      for (const path of pinCache.paths.net) ctx.fill(path);
      ctx.globalAlpha = 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (current.showLabels || current.selectedComponentId) {
        const occupied = new Set<string>();
        const sorted = [...components].sort((a, b) => (a.id === current.selectedComponentId ? -1 : b.id === current.selectedComponentId ? 1 : 0));
        let drawn = 0;
        for (const component of sorted) {
          const selected = component.id === current.selectedComponentId;
          if (!selected && (!current.showLabels || drawn >= 650)) continue;
          const b = component.bounds;
          const projectedSize = Math.max(b.maxX - b.minX, b.maxY - b.minY) * view.scale;
          if (!selected && projectedSize < 23) continue;
          const screen = screenPoint(boundsCenter(b));
          if (screen.x < -50 || screen.x > width + 50 || screen.y < -20 || screen.y > height + 20) continue;
          const cellKey = `${Math.floor(screen.x / 44)}:${Math.floor(screen.y / 17)}`;
          if (!selected && occupied.has(cellKey)) continue;
          occupied.add(cellKey);
          ctx.font = `600 ${selected ? 13 : 11}px 'IBM Plex Mono', Consolas, monospace`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.globalAlpha = current.selectedNet && !netComponents.has(component.id) && !selected ? 0.62 : 1;
          const labelWidth = ctx.measureText(component.ref).width;
          ctx.fillStyle = palette.labelBacking;
          ctx.beginPath(); ctx.roundRect(screen.x - labelWidth / 2 - 4, screen.y - (selected ? 10 : 8), labelWidth + 8, selected ? 20 : 16, 3); ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = palette.labelHalo; ctx.strokeText(component.ref, screen.x, screen.y);
          ctx.fillStyle = selected ? palette.amber : palette.label; ctx.fillText(component.ref, screen.x, screen.y);
          drawn++;
        }
      }
      ctx.globalAlpha = 1;
    }

    // Hover, measurement and the selection pulse never repaint the board or net.
    ctx = overlay;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    boardTransform();
    if (hover && onSide(hover.component, current.side) && !current.measureMode && !dragRef.current && hover.component.id !== current.selectedComponentId) {
      ctx.strokeStyle = netComponents.has(hover.component.id) ? palette.cyan : palette.hoverLine;
      ctx.lineWidth = 1.4 / view.scale;
      ctx.save(); ctx.shadowColor = palette.hoverGlow; ctx.shadowBlur = 9 * dpr;
      ctx.stroke(data.paths.get(hover.component.id)!); ctx.restore();
    }
    const selectedComponent = current.selectedComponentId ? data.components.get(current.selectedComponentId) : undefined;
    if (selectedComponent && onSide(selectedComponent, current.side)) {
      const marker = expandBounds(selectedComponent.bounds, (4 + (1 - animationProgress) * 5) / view.scale);
      ctx.strokeStyle = palette.amber; ctx.lineWidth = 2 / view.scale;
      ctx.globalAlpha = 0.7 * animationProgress;
      ctx.setLineDash([4 / view.scale, 4 / view.scale]);
      ctx.strokeRect(marker.minX, marker.minY, marker.maxX - marker.minX, marker.maxY - marker.minY);
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    const selectedPin = current.selectedPinId ? data.pins.get(current.selectedPinId) : undefined;
    if (selectedPin && onSide(selectedPin, current.side)) {
      const linked = !!current.selectedNet && selectedPin.net === current.selectedNet;
      const markerPixels = linked ? 2.2 : selectedPin.componentId === current.selectedComponentId ? 1.8 : 1;
      const radius = Math.max(selectedPin.radius, markerPixels / view.scale);
      ctx.beginPath(); ctx.arc(selectedPin.x, selectedPin.y, radius + 3.3 / view.scale, 0, Math.PI * 2);
      ctx.lineWidth = 1.6 / view.scale; ctx.strokeStyle = palette.cyan; ctx.stroke();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const measured = measurementRef.current;
    if (measured.length) {
      const a = screenPoint(measured[0]);
      const b = measured[1] ? screenPoint(measured[1]) : cursorRef.current && current.measureMode ? screenPoint(cursorRef.current) : a;
      ctx.strokeStyle = palette.amber; ctx.fillStyle = palette.amber;
      ctx.lineWidth = 1.5;
      // P03: only the visible part of the dashed line is rasterized (a measurement at high zoom has endpoints far offscreen); dash phase is kept.
      strokeMeasurementLine(ctx, a, b, width, height);
      for (const point of measured.length === 2 ? [a, b] : [a]) {
        ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(point.x, point.y, 8, 0, Math.PI * 2); ctx.stroke();
      }
      const endpoint = measured[1] ?? cursorRef.current;
      if (endpoint) {
        // The number follows the UI language; the unit stays "mm" in every language.
        const text = `${createFormatters(current.language).mm(distance(measured[0], endpoint))} mm`;
        const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 17 };
        ctx.font = "500 12px 'IBM Plex Mono', Consolas, monospace";
        const textWidth = ctx.measureText(text).width;
        ctx.fillStyle = palette.card; ctx.strokeStyle = palette.amber; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(middle.x - textWidth / 2 - 9, middle.y - 12, textWidth + 18, 24, 6); ctx.fill(); ctx.stroke();
        ctx.fillStyle = palette.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, middle.x, middle.y);
      }
    }

    // Compact orientation compass stays readable even when the board is mirrored.
    const compass = { x: width - 43, y: height - 44 };
    const axisX = orientPoint({ x: 1, y: 0 }, view.rotation, view.mirrored);
    const axisY = orientPoint({ x: 0, y: 1 }, view.rotation, view.mirrored);
    ctx.globalAlpha = 0.85;
    for (const [axis, color, text] of [[axisX, palette.amber, 'X'], [axisY, palette.cyan, 'Y']] as const) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(compass.x, compass.y);
      ctx.lineTo(compass.x + axis.x * 20, compass.y + axis.y * 20); ctx.stroke();
      ctx.fillStyle = color; ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, compass.x + axis.x * 29, compass.y + axis.y * 29);
    }
    ctx.globalAlpha = 1;
    if (animationProgress < 1 && current.selectedComponentId) requestOverlay();
  };

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!container || !canvas || !overlay) return;
    let initialized = false;
    let resolutionQuery: MediaQueryList | null = null;
    let observedDpr = window.devicePixelRatio || 1;
    const resize = () => {
      clearHover();
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      dimensionsRef.current = { width, height, dpr };
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      overlay.width = canvas.width; overlay.height = canvas.height;
      const fit = fitView(propsRef.current.board.bounds, width, height, viewRef.current.rotation, propsRef.current.side === 'bottom');
      fitScaleRef.current = fit.scale;
      if (!initialized) { viewRef.current = fit; initialized = true; }
      requestDraw(); reportStatus(true);
    };
    const onResolutionChange = () => {
      resize();
      watchResolution();
    };
    const watchResolution = () => {
      resolutionQuery?.removeEventListener('change', onResolutionChange);
      observedDpr = window.devicePixelRatio || 1;
      resolutionQuery = window.matchMedia(`(resolution: ${observedDpr}dppx)`);
      resolutionQuery.addEventListener('change', onResolutionChange);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.addEventListener('resize', resize);
    // Moving between monitors can change DPR while the CSS dimensions stay fixed.
    watchResolution();
    // Some Chromium display/emulation transitions update DPR without any event.
    // Check only the ratio; an unchanged board never redraws because of this timer.
    const resolutionTimer = window.setInterval(() => {
      if ((window.devicePixelRatio || 1) !== observedDpr) onResolutionChange();
    }, 1000);
    resize();
    return () => {
      observer.disconnect(); window.removeEventListener('resize', resize);
      resolutionQuery?.removeEventListener('change', onResolutionChange);
      window.clearInterval(resolutionTimer);
    };
  }, [clearHover, requestDraw, reportStatus]);

  useEffect(() => {
    const { width, height } = dimensionsRef.current;
    const fit = fitView(props.board.bounds, width, height, 0, props.side === 'bottom');
    fitScaleRef.current = fit.scale;
    const previousDrag = dragRef.current;
    const canvas = canvasRef.current;
    if (previousDrag && canvas?.hasPointerCapture(previousDrag.id)) canvas.releasePointerCapture(previousDrag.id);
    dragRef.current = null;
    setDragging(false);
    measurementRef.current = [];
    pinLayersRef.current = null;
    padPlanRef.current = null;
    connectionsRef.current = null;
    cursorRef.current = null;
    clearHover();
    // A new board starts untouched: its own stored camera (initialCamera) or the fit decides the view; nothing of the previous board is reported.
    if (cameraTimerRef.current !== null) { window.clearTimeout(cameraTimerRef.current); cameraTimerRef.current = null; }
    touchedRef.current = false; restoredBoardRef.current = null; lastCameraRef.current = null; cameraBoardRef.current = null; targetViewRef.current = null;
    moveView(fit, false, false);
    // A new file gets a fresh view. Switching sides preserves the location and scale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.board, moveView]);

  useEffect(() => {
    const flipped = viewRef.current.mirrored !== (props.side === 'bottom');
    viewRef.current = { ...viewRef.current, mirrored: props.side === 'bottom' };
    if (flipped) touchCamera(); // the viewed side is part of the stored camera; a restore or a new board already carries its own
    const { width, height } = dimensionsRef.current;
    fitScaleRef.current = fitView(props.board.bounds, width, height, viewRef.current.rotation, props.side === 'bottom').scale;
    clearHover();
    requestDraw(); reportStatus(true);
  }, [props.side, props.board, clearHover, requestDraw, reportStatus, touchCamera]);

  useEffect(() => {
    selectionTimeRef.current = performance.now();
    requestDraw();
  }, [props.selectedComponentId, props.selectedNet, props.selectedPinId, requestDraw]);

  useEffect(() => {
    if (!props.measureMode) measurementRef.current = [];
    requestOverlay(); reportStatus(true);
  }, [props.measureMode, requestOverlay, reportStatus]);

  useEffect(() => { requestDraw(); }, [props.showLabels, props.showConnections, props.theme, props.motion, requestDraw]);
  // A language change only needs the localized measurement label repainted: overlay only, no camera or base redraw.
  useEffect(() => { requestOverlay(); }, [props.language, requestOverlay]);

  useEffect(() => { requestOverlay(); }, [hover, requestOverlay]);

  // Only a command issued after this canvas mounted runs: a remount (tab switch) must not replay the last one over the restored view.
  const commandSeenRef = useRef(props.viewCommand?.nonce);
  useEffect(() => {
    const command = props.viewCommand;
    if (!command || command.nonce === commandSeenRef.current) return;
    commandSeenRef.current = command.nonce;
    const { width, height } = dimensionsRef.current;
    const view = viewRef.current;
    switch (command.type) {
      case 'fit': {
        const fit = fitView(props.board.bounds, width, height, view.rotation, view.mirrored);
        fitScaleRef.current = fit.scale; moveView(fit, true, !command.automatic); break;
      }
      case 'rotate': {
        const next = { ...view, rotation: (view.rotation + 90) % 360 };
        fitScaleRef.current = fitView(props.board.bounds, width, height, next.rotation, next.mirrored).scale;
        moveView(next); break;
      }
      case 'zoom-in':
      case 'zoom-out':
        moveView(zoomAt(view, { x: width / 2, y: height / 2 }, view.scale * (command.type === 'zoom-in' ? 1.35 : 1 / 1.35), width, height), true);
        break;
      case 'center-selection': {
        const selected = props.selectedComponentId ? data.components.get(props.selectedComponentId) : undefined;
        if (!selected) break;
        const b = selected.bounds;
        const target = Math.min(width * 0.42 / Math.max(b.maxX - b.minX + 4, 1), height * 0.42 / Math.max(b.maxY - b.minY + 4, 1));
        moveView({ ...view, center: boundsCenter(b), scale: Math.min(60, Math.max(view.scale, target)) }, true);
        break;
      }
    }
    // nonce makes a command repeatable; selection changes must not re-run an old command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.viewCommand?.nonce, moveView]);

  // Restore the stored view of this board instead of the automatic fit (declared after the fit effects so it wins within one commit).
  const initialCamera = props.initialCamera ?? null;
  useEffect(() => {
    if (!initialCamera || touchedRef.current || restoredBoardRef.current === props.board) return;
    restoredBoardRef.current = props.board; // decided once per board: a later value must not jump a view the user is looking at
    const { width, height } = dimensionsRef.current;
    const view = cameraToView(initialCamera);
    if (!viewShowsBoard(view, props.board.bounds, width, height)) return;
    fitScaleRef.current = fitView(props.board.bounds, width, height, view.rotation, view.mirrored).scale;
    lastCameraRef.current = viewToCamera(view);
    moveView(view, false, false);
    propsRef.current.onCameraRestore?.(initialCamera);
  }, [initialCamera, props.board, moveView]);

  useEffect(() => {
    window.addEventListener('pagehide', flushCamera);
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushCamera(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.removeEventListener('pagehide', flushCamera); document.removeEventListener('visibilitychange', onVisibility); flushCamera(); };
  }, [flushCamera]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const { width, height } = dimensionsRef.current;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
      const view = viewRef.current;
      moveView(zoomAt(view, anchor, view.scale * Math.exp(-clamp(delta, -350, 350) * 0.0016), width, height));
      cursorRef.current = screenToBoard(anchor, viewRef.current, width, height);
      reportStatus(true);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [moveView, reportStatus]);

  // W-fix2-portable-02: a lost 2D context (GPU process killed/reset) comes back with a cleared bitmap and nothing else repaints an idle canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const recovery = bindCanvasRecovery({
      canvases: [canvas, overlay],
      contexts: () => [canvas.getContext('2d', { alpha: false }), overlay.getContext('2d')],
      redraw: requestDraw, doc: document, win: window,
    });
    recoveryRef.current = recovery;
    const timer = window.setInterval(recovery.check, CONTEXT_CHECK_MS);
    return () => {
      window.clearInterval(timer); recovery.dispose();
      if (recoveryRef.current === recovery) recoveryRef.current = null;
    };
  }, [requestDraw]);

  useEffect(() => () => {
    stopAnimation();
    // Release the redraw gate after cancellation, including StrictMode effect replay.
    if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
  }, [stopAnimation]);

  const localPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point2 => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const hitTest = (screen: Point2, pinTolerance = 5.5): HoverTarget | null => {
    const { width, height } = dimensionsRef.current;
    // Pad ranking and component containment live in board-hit-test.ts (B17, B23), where they are unit-tested.
    const target = hitTestBoard(
      { pins: data.pinIndices[props.side], components: data.componentIndices[props.side], componentsById: data.components },
      screen, viewRef.current, width, height, { selectedComponentId: props.selectedComponentId, pinTolerance },
    );
    return target ? { ...target, screen } : null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    stopAnimation();
    const screen = localPoint(event);
    dragRef.current = { id: event.pointerId, start: screen, last: screen, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    clearHover();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const screen = localPoint(event);
    const { width, height } = dimensionsRef.current;
    const drag = dragRef.current;
    if (drag && drag.id === event.pointerId) {
      const delta = { x: screen.x - drag.last.x, y: screen.y - drag.last.y };
      if (distance(screen, drag.start) > 4) drag.moved = true;
      if (drag.moved) {
        clearHover();
        viewRef.current = panBy(viewRef.current, delta);
        touchCamera();
        requestDraw();
      }
      drag.last = screen;
    } else if (!props.measureMode) {
      const target = hitTest(screen);
      const key = target ? `${target.component.id}:${target.pin?.id ?? ''}` : '';
      if (key !== lastHoverKeyRef.current) { lastHoverKeyRef.current = key; setHover(target); }
    }
    cursorRef.current = screenToBoard(screen, viewRef.current, width, height);
    if (props.measureMode && measurementRef.current.length === 1) requestOverlay();
    reportStatus();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const screen = localPoint(event);
    if (!drag.moved && event.button === 0) {
      if (props.measureMode) {
        const { width, height } = dimensionsRef.current;
        const canonical = screenToBoard(screen, viewRef.current, width, height);
        // Measuring can snap to zero-size source pads without fabricating a physical diameter.
        const radius = 9 / viewRef.current.scale;
        const candidates = data.pinIndices[props.side].query(expandBounds({ minX: canonical.x, minY: canonical.y, maxX: canonical.x, maxY: canonical.y }, radius));
        let point = canonical, nearest = radius;
        for (const pin of candidates) {
          const d = distance(canonical, pin);
          if (d < nearest) { point = { x: pin.x, y: pin.y }; nearest = d; }
        }
        measurementRef.current = measurementRef.current.length === 1 ? [measurementRef.current[0], point] : [point];
        requestOverlay();
      } else {
        const target = hitTest(screen);
        if (target?.pin) props.onSelectPin(target.pin.id);
        else props.onSelectComponent(target?.component.id ?? null);
      }
    }
    reportStatus(true);
  };

  const cancelPointer = () => { dragRef.current = null; setDragging(false); };
  const palette = palettes[props.theme];
  const t = createTranslator(props.language); // Cached per language: a stable function, no memo or effect depends on it.

  return (
    <div ref={containerRef} className="board-canvas-container" style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden', background: palette.background }}>
      <canvas
        ref={canvasRef}
        className="board-canvas"
        tabIndex={0}
        aria-label={t(props.side === 'top' ? (props.measureMode ? 'canvas.ariaTopMeasure' : 'canvas.ariaTopSelect') : (props.measureMode ? 'canvas.ariaBottomMeasure' : 'canvas.ariaBottomSelect'))}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none', outline: 'none', cursor: dragging ? 'grabbing' : props.measureMode ? 'crosshair' : hover ? 'pointer' : 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelPointer}
        onLostPointerCapture={cancelPointer}
        onPointerLeave={() => { if (!dragRef.current) clearHover(); }}
        onDoubleClick={event => {
          if (props.measureMode) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
          const { width, height } = dimensionsRef.current;
          moveView(zoomAt(viewRef.current, screen, viewRef.current.scale * 1.6, width, height), true);
        }}
        onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            moveView(panBy(viewRef.current, { x: event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0, y: event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0 }));
          }
        }}
      />
      <canvas ref={overlayRef} className="board-canvas-overlay" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
      {hover && !dragging && !props.measureMode && (
        <div className="canvas-hover-card" style={{
          position: 'absolute', left: clamp(hover.screen.x + 16, 12, Math.max(12, dimensionsRef.current.width - 220)),
          top: clamp(hover.screen.y + 16, 12, Math.max(12, dimensionsRef.current.height - 66)),
          maxWidth: 208, padding: '9px 12px', pointerEvents: 'none', border: `1px solid ${palette.boardLine}`,
          borderRadius: 9, background: palette.card, boxShadow: '0 5px 20px #0003', color: palette.text,
          fontSize: 11, lineHeight: 1.5, zIndex: 3,
        }}>
          <div style={{ fontFamily: "'IBM Plex Mono', Consolas, monospace", fontWeight: 600, color: hover.pin ? palette.cyan : palette.amber }}>
            {hover.component.ref}{hover.pin ? ` · ${hover.pin.number}` : ''}
          </div>
          <div style={{ color: palette.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {hover.pin ? hover.pin.net || t('canvas.noNet') : hover.component.value || hover.component.package || t('unit.pins', { count: hover.component.pinIds.length })}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(BoardCanvas);
