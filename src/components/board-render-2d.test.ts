import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFormatters } from '../lib/i18n';
import {
  boardToScreen, boundsCenter, boundsCorners, boundsFromPoints, clamp, distance, expandBounds, orientPoint, padBounds, panBy, SpatialIndex, viewportBounds, zoomAt,
} from '../lib/geometry';
import type { Bounds2, Point2, ViewTransform } from '../lib/geometry';
import { canvasGroup, classifyComponent } from '../lib/part-kind';
import type { CanvasGroup } from '../lib/part-kind';
import { clipSegmentToBounds } from '../lib/render-geometry';
import type { Board, BoardComponent, BoardPin, BoardSide, Language, ViewSide } from '../lib/types';
import { strokeMeasurementLine } from './board-measure-line';
import { boundsCover, buildPadLayers, PAD_REGION_SLACK, PAD_VIEW_MARGIN_PX, planPadLayers, samePadPlan } from './board-pad-layers';
import type { PadLayerPlan, PadLayers } from './board-pad-layers';
import { Canvas2DBoardRenderer } from './board-render-2d';
import type { Frame2D, Layer2D } from './board-render-2d';
import { LAYER_ORDER } from './board-renderer';
import type { BoardRenderState } from './board-renderer';
import { buildBoardScene } from './board-scene';
import { fullPane } from './board-view';
import type { BoardPane } from './board-view';

/*
 * The renderer draws what the board canvas drew before the split. The canvas' drawing code of that time is kept below verbatim
 * (only its inputs are injected); both draw into recording contexts that resolve the context state, and every drawing operation
 * (with the transform, colours, alpha, line width, dash, shadow, font and clip it is drawn with) and every path must be the same.
 * Pixel captures of real boards (scripts/qa-board-render.cjs) check the same in a browser.
 */

// ---------------------------------------------------------------------------------------------
// Recording context and path
// ---------------------------------------------------------------------------------------------

class RecordingPath {
  readonly ops: string[] = [];
  moveTo(x: number, y: number) { this.ops.push(`M${x},${y}`); }
  lineTo(x: number, y: number) { this.ops.push(`L${x},${y}`); }
  arc(x: number, y: number, r: number, a: number, b: number) { this.ops.push(`A${x},${y},${r},${a},${b}`); }
  rect(x: number, y: number, w: number, h: number) { this.ops.push(`R${x},${y},${w},${h}`); }
  closePath() { this.ops.push('Z'); }
  toString() { return this.ops.join(' '); }
}

interface ContextState {
  transform: number[]; fillStyle: string; strokeStyle: string; lineWidth: number; globalAlpha: number; lineDash: number[]; lineDashOffset: number;
  shadowColor: string; shadowBlur: number; font: string; textAlign: string; textBaseline: string; clips: string[];
}
const initialState = (): ContextState => ({
  transform: [1, 0, 0, 1, 0, 0], fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, globalAlpha: 1, lineDash: [], lineDashOffset: 0,
  shadowColor: 'rgba(0, 0, 0, 0)', shadowBlur: 0, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', clips: [],
});
const copyState = (state: ContextState): ContextState => ({ ...state, transform: [...state.transform], lineDash: [...state.lineDash], clips: [...state.clips] });
const n = (value: number) => String(value + 0); // -0 and 0 draw the same

/** A 2D context that logs every drawing operation with the state it is drawn with; setters, save and restore only change that state. */
class RecordingContext {
  log: string[] = [];
  lost = false;
  private state = initialState();
  private stack: ContextState[] = [];
  private path: string[] = [];
  isContextLost() { return this.lost; }
  take() { const log = this.log; this.log = []; return log; }

  get fillStyle() { return this.state.fillStyle; } set fillStyle(value: string) { this.state.fillStyle = value; }
  get strokeStyle() { return this.state.strokeStyle; } set strokeStyle(value: string) { this.state.strokeStyle = value; }
  get lineWidth() { return this.state.lineWidth; } set lineWidth(value: number) { this.state.lineWidth = value; }
  get globalAlpha() { return this.state.globalAlpha; } set globalAlpha(value: number) { this.state.globalAlpha = value; }
  get lineDashOffset() { return this.state.lineDashOffset; } set lineDashOffset(value: number) { this.state.lineDashOffset = value; }
  get shadowColor() { return this.state.shadowColor; } set shadowColor(value: string) { this.state.shadowColor = value; }
  get shadowBlur() { return this.state.shadowBlur; } set shadowBlur(value: number) { this.state.shadowBlur = value; }
  get font() { return this.state.font; } set font(value: string) { this.state.font = value; }
  get textAlign() { return this.state.textAlign; } set textAlign(value: string) { this.state.textAlign = value; }
  get textBaseline() { return this.state.textBaseline; } set textBaseline(value: string) { this.state.textBaseline = value; }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { this.state.transform = [a, b, c, d, e, f]; }
  save() { this.stack.push(copyState(this.state)); }
  restore() { const state = this.stack.pop(); if (state) this.state = state; }
  setLineDash(segments: number[]) { this.state.lineDash = [...segments]; }
  getLineDash() { return [...this.state.lineDash]; }

  private get t() { return this.state.transform.map(n).join(','); }
  beginPath() { this.path = []; }
  moveTo(x: number, y: number) { this.path.push(`M${x},${y}@${this.t}`); }
  lineTo(x: number, y: number) { this.path.push(`L${x},${y}@${this.t}`); }
  arc(x: number, y: number, r: number, a: number, b: number) { this.path.push(`A${x},${y},${r},${a},${b}@${this.t}`); }
  rect(x: number, y: number, w: number, h: number) { this.path.push(`R${x},${y},${w},${h}@${this.t}`); }
  roundRect(x: number, y: number, w: number, h: number, r: number) { this.path.push(`RR${x},${y},${w},${h},${r}@${this.t}`); }
  measureText(text: string) { return { width: text.length * Number(/(\d+)px/.exec(this.state.font)?.[1] ?? 10) * 0.6 }; }

  private common() { const s = this.state; return `T=${this.t} a=${n(s.globalAlpha)} sh=${s.shadowColor}/${n(s.shadowBlur)} clip=${s.clips.join(';')}`; }
  private fillState() { return `fs=${this.state.fillStyle} ${this.common()}`; }
  private strokeState() { const s = this.state; return `ss=${s.strokeStyle} lw=${n(s.lineWidth)} dash=${s.lineDash.map(n).join(',')}+${n(s.lineDashOffset)} ${this.common()}`; }
  private textState() { const s = this.state; return `font=${s.font} align=${s.textAlign}/${s.textBaseline}`; }
  private shape(path?: unknown) { return path === undefined ? `[${this.path.join(' ')}]` : `{${String(path)}}`; }

  fillRect(x: number, y: number, w: number, h: number) { this.log.push(`fillRect ${x},${y},${w},${h} ${this.fillState()}`); }
  strokeRect(x: number, y: number, w: number, h: number) { this.log.push(`strokeRect ${x},${y},${w},${h} ${this.strokeState()}`); }
  clearRect(x: number, y: number, w: number, h: number) { this.log.push(`clearRect ${x},${y},${w},${h} T=${this.t} clip=${this.state.clips.join(';')}`); }
  fill(path?: unknown) { this.log.push(`fill ${this.shape(path)} ${this.fillState()}`); }
  stroke(path?: unknown) { this.log.push(`stroke ${this.shape(path)} ${this.strokeState()}`); }
  clip(path?: unknown) { this.state.clips.push(`${this.shape(path)}@${this.t}`); }
  fillText(text: string, x: number, y: number) { this.log.push(`fillText ${text} ${x},${y} ${this.textState()} ${this.fillState()}`); }
  strokeText(text: string, x: number, y: number) { this.log.push(`strokeText ${text} ${x},${y} ${this.textState()} ${this.strokeState()}`); }
}

const canvasOf = (context: RecordingContext | null) => ({ getContext: () => context }) as unknown as HTMLCanvasElement;
const asContext = (context: RecordingContext) => context as unknown as CanvasRenderingContext2D;

function expectSameLog(actual: readonly string[], expected: readonly string[], label: string) {
  const length = Math.max(actual.length, expected.length);
  for (let i = 0; i < length; i++) {
    if (actual[i] !== expected[i]) {
      expect.fail(`${label}: operation ${i} of ${expected.length} differs (renderer has ${actual.length})\n  expected ${expected[i]?.slice(0, 600)}\n  actual   ${actual[i]?.slice(0, 600)}`);
    }
  }
}

beforeAll(() => { vi.stubGlobal('Path2D', RecordingPath); });
afterAll(() => { vi.unstubAllGlobals(); });

// ---------------------------------------------------------------------------------------------
// The board canvas drawing code before the split (BoardCanvas.tsx), verbatim; refs and props are injected
// ---------------------------------------------------------------------------------------------

interface NetGroup { pins: BoardPin[]; components: Set<string> }
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

const componentKind = (component: BoardComponent): CanvasGroup => canvasGroup(classifyComponent(component).kind);

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

interface LegacyProps {
  board: Board; side: ViewSide; selectedComponentId: string | null; selectedPinId: string | null; selectedNet: string | null;
  showLabels: boolean; showConnections: boolean; measureMode: boolean; theme: 'dark' | 'light'; motion: boolean; language: Language;
}
interface LegacyFrame {
  props: LegacyProps; dimensions: { width: number; height: number; dpr: number }; view: ViewTransform;
  hover: { component: BoardComponent } | null; dragging: boolean; measurement: Point2[]; cursor: Point2 | null; animationProgress: number; base: boolean;
}

/** The canvas' memoized `data` and `selection`, its caches and its draw function. */
class LegacyCanvas {
  baseDirty = true;
  pinLayers: PinLayerCache | null = null;
  padPlan: PadLayerPlan | null = null;
  connections: ConnectionCache | null = null;
  readonly data;
  constructor(board: Board) {
    const props = { board };
    this.data = (() => {
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
    })();
  }

  selection(props: LegacyProps) {
    const data = this.data;
    const group = props.selectedNet ? data.netPins[props.side].get(props.selectedNet) : undefined;
    const pins = group?.pins ?? emptyPins;
    const selectedPin = props.selectedPinId ? data.pins.get(props.selectedPinId) : undefined;
    const source = (selectedPin && selectedPin.net === props.selectedNet && onSide(selectedPin, props.side) ? selectedPin : undefined)
      ?? pins.find(pin => pin.componentId === props.selectedComponentId) ?? pins[0];
    return { pins, components: group?.components ?? emptyComponents, source };
  }

  draw(base: CanvasRenderingContext2D, overlay: CanvasRenderingContext2D, frame: LegacyFrame) {
    const data = this.data;
    const selection = this.selection(frame.props);
    const hover = frame.hover;
    const dragRef = { current: frame.dragging ? {} : null };
    const cursorRef = { current: frame.cursor };
    const measurementRef = { current: frame.measurement };
    this.baseDirty = frame.base;
    // ---- verbatim from here (refs renamed: baseDirtyRef -> this.baseDirty, pinLayersRef -> this.pinLayers, padPlanRef -> this.padPlan, connectionsRef -> this.connections)
    let ctx = base;
    const { width, height, dpr } = frame.dimensions;
    const view = frame.view;
    const current = frame.props;
    const palette = palettes[current.theme];
    const screenPoint = (point: Point2) => boardToScreen(point, view, width, height);
    const netPins = selection.pins;
    const netComponents = selection.components;
    const animationProgress = frame.animationProgress;
    const basisX = orientPoint({ x: 1, y: 0 }, view.rotation, view.mirrored);
    const basisY = orientPoint({ x: 0, y: 1 }, view.rotation, view.mirrored);
    const screenOrigin = screenPoint({ x: 0, y: 0 });
    const boardTransform = () => ctx.setTransform(
      basisX.x * view.scale * dpr, basisX.y * view.scale * dpr,
      basisY.x * view.scale * dpr, basisY.y * view.scale * dpr,
      screenOrigin.x * dpr, screenOrigin.y * dpr,
    );

    if (this.baseDirty) {
      this.baseDirty = false;
      const components = data.componentIndices[current.side].query(viewportBounds(view, width, height, 30));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = palette.background;
      ctx.fillRect(0, 0, width, height);
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

      if (current.showConnections && netPins.length > 1 && selection.source) {
        let cache = this.connections;
        if (!cache || cache.pins !== netPins || cache.source !== selection.source) {
          cache = buildConnections(netPins, selection.source);
          this.connections = cache;
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

      let pinCache = this.pinLayers;
      const sidePins = data.sidePins[current.side];
      const needed = viewportBounds(view, width, height, PAD_VIEW_MARGIN_PX);
      if (!pinCache || pinCache.board !== current.board || pinCache.side !== current.side || pinCache.scale !== view.scale
        || pinCache.net !== current.selectedNet || pinCache.component !== current.selectedComponentId || !boundsCover(pinCache.region, needed)) {
        let plan = this.padPlan;
        if (!samePadPlan(plan, sidePins, current.selectedNet, current.selectedComponentId)) {
          plan = planPadLayers(sidePins, current.selectedNet, current.selectedComponentId);
          this.padPlan = plan;
        }
        const region = viewportBounds(view, width, height, PAD_VIEW_MARGIN_PX + Math.max(width, height) * PAD_REGION_SLACK);
        pinCache = {
          board: current.board, side: current.side, scale: view.scale, net: current.selectedNet, component: current.selectedComponentId, region,
          paths: buildPadLayers(plan, region, view.scale, () => new Path2D()),
        };
        this.pinLayers = pinCache;
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
      strokeMeasurementLine(ctx, a, b, width, height);
      for (const point of measured.length === 2 ? [a, b] : [a]) {
        ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(point.x, point.y, 8, 0, Math.PI * 2); ctx.stroke();
      }
      const endpoint = measured[1] ?? cursorRef.current;
      if (endpoint) {
        const text = `${createFormatters(current.language).mm(distance(measured[0], endpoint))} mm`;
        const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 17 };
        ctx.font = "500 12px 'IBM Plex Mono', Consolas, monospace";
        const textWidth = ctx.measureText(text).width;
        ctx.fillStyle = palette.card; ctx.strokeStyle = palette.amber; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(middle.x - textWidth / 2 - 9, middle.y - 12, textWidth + 18, 24, 6); ctx.fill(); ctx.stroke();
        ctx.fillStyle = palette.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, middle.x, middle.y);
      }
    }

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
  }
}

// ---------------------------------------------------------------------------------------------
// A board with every case the draw code distinguishes
// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/**
 * Chips (polygon outlines, large enough for the inset), connectors, passives down to tiny markers, parts without a usable outline,
 * parts and pads on both sides, round/rect/square/zero-size pads, a ground net dense enough for solid lines and a small dashed net.
 */
function testBoard(seed = 5): Board {
  const random = mulberry32(seed);
  const components: BoardComponent[] = [];
  const pins: BoardPin[] = [];
  const addPart = (ref: string, side: BoardSide, x: number, y: number, w: number, h: number, padCount: number, outline: 'polygon' | 'none' | 'octagon' = 'polygon') => {
    const id = `c${components.length}`;
    const bounds = { minX: x, minY: y, maxX: x + w, maxY: y + h };
    const corners = outline === 'none' ? [] : outline === 'octagon'
      ? [{ x: x + w * 0.3, y }, { x: x + w * 0.7, y }, { x: x + w, y: y + h * 0.3 }, { x: x + w, y: y + h * 0.7 }, { x: x + w * 0.7, y: y + h }, { x: x + w * 0.3, y: y + h }, { x, y: y + h * 0.7 }, { x, y: y + h * 0.3 }]
      : boundsCorners(bounds);
    const pinIds: string[] = [];
    for (let k = 0; k < padCount; k++) {
      const pinId = `${id}p${k}`;
      const kind = Math.floor(random() * 4);
      const net = random() < 0.6 ? 'GND' : random() < 0.08 ? 'SIG1' : random() < 0.1 ? '' : `N${Math.floor(random() * 40)}`;
      const at = { x: x + random() * w, y: y + random() * h };
      const shape = kind === 0 ? { radius: 0, shape: 'round' as const } : kind === 1 ? { radius: 0.1 + random() * 0.3, shape: 'round' as const }
        : kind === 2 ? { radius: 0.3, shape: 'rect' as const, width: 0.2 + random() * 1.5, height: 0.2 + random(), rotation: [0, 90, 45][Math.floor(random() * 3)] }
          : { radius: 0.25, shape: 'square' as const, width: 0.5, rotation: random() * 360 };
      const padSide: BoardSide = side === 'both' || random() < 0.03 ? 'both' : side;
      pins.push({ id: pinId, componentId: id, number: String(k + 1), name: String(k + 1), net, side: padSide, ...at, ...shape });
      pinIds.push(pinId);
    }
    components.push({ id, ref, value: random() < 0.5 ? '10k' : '', package: '', side, bounds, position: boundsCenter(bounds), rotation: 0, pinIds, outline: corners });
  };
  for (let i = 0; i < 6; i++) addPart(`U${i + 1}`, i % 3 === 2 ? 'bottom' : 'top', 10 + i * 22, 10 + (i % 2) * 30, 12 + i, 10 + (i % 3) * 2, 80, i === 3 ? 'octagon' : 'polygon');
  for (let i = 0; i < 4; i++) addPart(`J${i + 1}`, i === 3 ? 'both' : 'top', 5 + i * 35, 70, 18, 5, 12);
  for (let i = 0; i < 70; i++) {
    const tiny = i % 5 === 0;
    addPart(`${['R', 'C', 'L', 'FB'][i % 4]}${i + 1}`, i % 4 === 3 ? 'bottom' : 'top', 2 + random() * 150, 2 + random() * 85, tiny ? 0.3 : 0.6 + random() * 2, tiny ? 0.15 : 0.3 + random(), 2, i % 9 === 0 ? 'none' : 'polygon');
  }
  addPart('TP1', 'top', 120, 50, 0.8, 0.8, 1);
  addPart('MH1', 'both', 150, 80, 3, 3, 0, 'none');
  const outline = [{ x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 95 }, { x: 80, y: 100 }, { x: 0, y: 95 }];
  const bounds = boundsFromPoints([...outline, ...components.flatMap(component => boundsCorners(component.bounds))]);
  return { name: 'render-test', format: 'test', units: 'mm', components, pins, nets: [], outline, bounds, warnings: [] };
}

// ---------------------------------------------------------------------------------------------
// Scenarios: a sequence of frames per scenario, drawn by both and compared operation by operation
// ---------------------------------------------------------------------------------------------

interface Step {
  /** View change from the previous frame (the first frame starts at the scenario's view). */
  move?: { pan?: Point2; zoom?: number };
  base?: boolean;
  hover?: string | null; dragging?: boolean; measurement?: Point2[]; cursor?: Point2 | null; pulse?: number;
  props?: Partial<LegacyProps>;
}
interface Scenario { name: string; props: Partial<LegacyProps>; view: { scale: number; rotation: number; center?: Point2 }; dpr: number; steps: Step[] }

const board = testBoard();
const WIDTH = 1000, HEIGHT = 700;
const gndPins = board.pins.filter(pin => pin.net === 'GND' && onSide(pin, 'top'));
const sigPins = board.pins.filter(pin => pin.net === 'SIG1' && onSide(pin, 'top'));
const chip = board.components.find(component => component.ref === 'U2')!;
const bottomChip = board.components.find(component => component.ref === 'U3')!;
const passive = board.components.find(component => component.ref === 'R5')!;
const pan: Step[] = [{ move: { pan: { x: 37, y: -23 } } }, { move: { pan: { x: 640, y: 410 } } }, { move: { zoom: 1.35 } }, { move: { pan: { x: -11, y: 5 } }, base: false, hover: passive.id }];

const scenarios: Scenario[] = [
  { name: 'dark, labels and lines, nothing selected', props: {}, view: { scale: 7, rotation: 0 }, dpr: 1, steps: pan },
  { name: 'light, bottom side mirrored, rotated 90, no labels', props: { theme: 'light', side: 'bottom', showLabels: false }, view: { scale: 3, rotation: 90 }, dpr: 2, steps: pan },
  { name: 'tiny markers at a small zoom', props: {}, view: { scale: 1.1, rotation: 0 }, dpr: 1, steps: pan },
  { name: 'selected chip at a deep zoom, rotated 180, selection pulse running', props: { selectedComponentId: chip.id, motion: true }, view: { scale: 40, rotation: 180, center: boundsCenter(chip.bounds) }, dpr: 2,
    steps: [{ pulse: 0.3 }, { pulse: 0.7, base: false }, { pulse: 1, move: { zoom: 1.35 } }, { move: { pan: { x: 300, y: 0 } } }] },
  { name: 'pad, its net (dashed lines) and its part selected, rotated 270', props: { selectedComponentId: sigPins[1].componentId, selectedPinId: sigPins[1].id, selectedNet: 'SIG1' }, view: { scale: 9, rotation: 270 }, dpr: 1.25, steps: pan },
  { name: 'dense ground net (solid lines) from a pad of another part', props: { selectedComponentId: chip.id, selectedPinId: gndPins[3].id, selectedNet: 'GND' }, view: { scale: 4, rotation: 0 }, dpr: 2, steps: pan },
  { name: 'net only, light, no connection lines', props: { theme: 'light', selectedNet: 'GND', showConnections: false }, view: { scale: 12, rotation: 90 }, dpr: 1, steps: pan },
  { name: 'net only with lines clipped to a zoomed view', props: { selectedNet: 'SIG1' }, view: { scale: 30, rotation: 0 }, dpr: 1, steps: pan },
  { name: 'selected part on the other side, selected pad on the other side', props: { selectedComponentId: bottomChip.id, selectedPinId: bottomChip.pinIds[0], selectedNet: null }, view: { scale: 8, rotation: 0 }, dpr: 1, steps: pan },
  { name: 'selected bottom chip seen from the bottom, net selected', props: { side: 'bottom', selectedComponentId: bottomChip.id, selectedPinId: bottomChip.pinIds[2], selectedNet: board.pins.find(pin => pin.id === bottomChip.pinIds[2])!.net }, view: { scale: 14, rotation: 270 }, dpr: 2, steps: pan },
  { name: 'hover: plain, on a linked part, on the selected part, while dragging', props: { selectedNet: 'GND', selectedComponentId: passive.id }, view: { scale: 10, rotation: 0 }, dpr: 1,
    steps: [{ hover: chip.id }, { hover: chip.id, base: false, props: { selectedNet: null } }, { hover: passive.id, base: false }, { hover: chip.id, dragging: true, move: { pan: { x: 20, y: 0 } } }] },
  { name: 'measurement: first point and cursor, German number format', props: { measureMode: true, language: 'de' }, view: { scale: 10, rotation: 90 }, dpr: 2,
    steps: [{ measurement: [{ x: 20, y: 20 }], cursor: { x: 45.25, y: 31.5 } }, { measurement: [{ x: 20, y: 20 }], cursor: { x: 60, y: 10 }, base: false, hover: chip.id }, { measurement: [{ x: 20, y: 20 }], cursor: null, base: false }] },
  { name: 'measurement: two points, one far outside the view, after leaving measure mode', props: {}, view: { scale: 60, rotation: 0 }, dpr: 1,
    steps: [{ measurement: [{ x: 20, y: 20 }, { x: 140, y: 90 }], cursor: { x: 1, y: 1 } }, { measurement: [{ x: 20, y: 20 }, { x: 21, y: 21 }], base: false, props: { measureMode: true, language: 'hu' } }] },
];

function frameState(props: LegacyProps, step: Step, hover: string | null): BoardRenderState {
  return {
    theme: props.theme, selectedComponentId: props.selectedComponentId, selectedPinId: props.selectedPinId, selectedNet: props.selectedNet,
    showLabels: props.showLabels, showConnections: props.showConnections, measureMode: props.measureMode, language: props.language,
    hoverComponentId: hover, dragging: !!step.dragging, measurement: step.measurement ?? [], cursor: step.cursor ?? null, selectionPulse: step.pulse ?? 1,
  };
}

describe('Canvas2D board renderer draws exactly what the board canvas drew before the split', () => {
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const legacy = new LegacyCanvas(board);
      const scene = buildBoardScene(board);
      const contexts = { legacyBase: new RecordingContext(), legacyOverlay: new RecordingContext(), base: new RecordingContext(), overlay: new RecordingContext() };
      const renderer = new Canvas2DBoardRenderer(canvasOf(contexts.base), canvasOf(contexts.overlay));
      let props: LegacyProps = {
        board, side: 'top', selectedComponentId: null, selectedPinId: null, selectedNet: null, showLabels: true, showConnections: true, measureMode: false,
        theme: 'dark', motion: false, language: 'en', ...scenario.props,
      };
      const dimensions = { width: WIDTH, height: HEIGHT, dpr: scenario.dpr };
      let view: ViewTransform = { center: scenario.view.center ?? boundsCenter(board.bounds), scale: scenario.view.scale, rotation: scenario.view.rotation, mirrored: props.side === 'bottom' };
      for (const [index, step] of [{}, ...scenario.steps].entries()) {
        if (step.props) props = { ...props, ...step.props };
        if (step.move?.pan) view = panBy(view, step.move.pan);
        if (step.move?.zoom) view = zoomAt(view, { x: WIDTH * 0.4, y: HEIGHT * 0.6 }, view.scale * step.move.zoom, WIDTH, HEIGHT);
        const hover = step.hover ?? null;
        const base = step.base ?? true;
        const hoverComponent = hover ? board.components.find(component => component.id === hover)! : null;
        legacy.draw(asContext(contexts.legacyBase), asContext(contexts.legacyOverlay), {
          props, dimensions, view, hover: hoverComponent && { component: hoverComponent }, dragging: !!step.dragging,
          measurement: step.measurement ?? [], cursor: step.cursor ?? null, animationProgress: props.motion ? clamp(step.pulse ?? 1, 0, 1) : 1, base,
        });
        renderer.setScene(scene); renderer.setSize(dimensions); renderer.setLayers([]);
        const panes = [fullPane(view, props.side, WIDTH, HEIGHT)];
        const state = frameState(props, step, hover);
        if (base) expect(renderer.render('base', panes, state)).not.toBeNull();
        expect(renderer.render('overlay', panes, state)).not.toBeNull();
        const expectedBase = contexts.legacyBase.take();
        expect(expectedBase.length > 0).toBe(base);
        expectSameLog(contexts.base.take(), expectedBase, `frame ${index} base`);
        expectSameLog(contexts.overlay.take(), contexts.legacyOverlay.take(), `frame ${index} overlay`);
      }
    });
  }

  it('covers every case of the draw code in these scenarios (markers, outlines, insets, glow, both line styles, labels, measurement)', () => {
    const seen = new Set<string>();
    for (const scenario of scenarios) {
      const legacy = new LegacyCanvas(board);
      const base = new RecordingContext(), overlay = new RecordingContext();
      const props: LegacyProps = { board, side: 'top', selectedComponentId: null, selectedPinId: null, selectedNet: null, showLabels: true, showConnections: true, measureMode: false, theme: 'dark', motion: false, language: 'en', ...scenario.props };
      const view = { center: scenario.view.center ?? boundsCenter(board.bounds), scale: scenario.view.scale, rotation: scenario.view.rotation, mirrored: props.side === 'bottom' };
      const step = scenario.steps.find(item => item.measurement) ?? scenario.steps[0];
      legacy.draw(asContext(base), asContext(overlay), {
        props, dimensions: { width: WIDTH, height: HEIGHT, dpr: 1 }, view, hover: null, dragging: false, measurement: step.measurement ?? [], cursor: step.cursor ?? null, animationProgress: 1, base: true,
      });
      for (const line of [...base.take(), ...overlay.take()]) {
        if (line.startsWith('fillRect') && !line.includes(',1.2,1.2 ') && !line.includes(`${WIDTH},${HEIGHT}`)) seen.add('marker');
        if (line.startsWith('strokeRect') && line.includes('clip={')) seen.add('inset');
        if (line.startsWith('stroke {') && line.includes('sh=#efb75170')) seen.add('glow');
        if (line.startsWith('stroke {') && /dash=[\d.e-]+,/.test(line)) seen.add('dashed lines');
        if (line.startsWith('stroke {') && line.includes('ss=#56d4cf') && line.includes('a=0.13')) seen.add('solid lines');
        if (line.startsWith('fillText') && !/fillText [XY] /.test(line)) seen.add('label');
        if (line.includes('fillText') && line.includes(' mm ')) seen.add('measurement');
      }
    }
    expect([...seen].sort()).toEqual(['dashed lines', 'glow', 'inset', 'label', 'marker', 'measurement', 'solid lines']);
  });
});

// ---------------------------------------------------------------------------------------------
// Feature layers and panes
// ---------------------------------------------------------------------------------------------

describe('Canvas2D board renderer: feature layers and panes', () => {
  const scene = buildBoardScene(board);
  const view: ViewTransform = { center: boundsCenter(board.bounds), scale: 7, rotation: 0, mirrored: false };
  const state: BoardRenderState = {
    theme: 'dark', selectedComponentId: null, selectedPinId: null, selectedNet: 'GND', showLabels: true, showConnections: true, measureMode: false, language: 'en',
    hoverComponentId: null, dragging: false, measurement: [], cursor: null, selectionPulse: 1,
  };
  const setup = (layers: Layer2D[] = []) => {
    const base = new RecordingContext(), overlay = new RecordingContext();
    const renderer = new Canvas2DBoardRenderer(canvasOf(base), canvasOf(overlay));
    renderer.setScene(scene); renderer.setSize({ width: WIDTH, height: HEIGHT, dpr: 1 }); renderer.setLayers(layers);
    return { base, overlay, renderer };
  };
  const main = () => [fullPane(view, 'top', WIDTH, HEIGHT)];

  it('stacks the built-in layers in their order and puts a feature layer where its order says', () => {
    const fan: Layer2D = { id: 'fan', surface: 'base', order: LAYER_ORDER.bodies + 50, draw: () => {} };
    const marker: Layer2D = { id: 'marker', surface: 'overlay', order: LAYER_ORDER.compass + 1, draw: () => {} };
    const { renderer } = setup([marker, fan]);
    expect(renderer.layerIds('base')).toEqual(['background', 'outline', 'connections', 'bodies', 'fan', 'pads', 'labels']);
    expect(renderer.layerIds('overlay')).toEqual(['hover', 'selection', 'measurement', 'compass', 'marker']);
    renderer.setLayers([]);
    expect(renderer.layerIds('base')).toEqual(['background', 'outline', 'connections', 'bodies', 'pads', 'labels']);
  });

  it('draws a feature layer between the built-in ones, once per pane, with the frame of that pane, in its own context state', () => {
    const frames: Frame2D[] = [];
    const fan: Layer2D = {
      id: 'fan', surface: 'base', order: LAYER_ORDER.bodies + 50,
      draw: frame => {
        frames.push(frame);
        frame.toBoardSpace();
        frame.ctx.beginPath(); frame.ctx.rect(0, 0, 10, 10); frame.ctx.clip(); // must not leak into the pads
        frame.ctx.globalAlpha = 0.25; frame.ctx.fillStyle = '#ff00ff';
        frame.ctx.fillRect(1, 2, 3, 4);
      },
    };
    const plain = setup();
    plain.renderer.render('base', main(), state);
    const withFan = setup([fan]);
    const stats = withFan.renderer.render('base', main(), state);
    const expected = plain.base.take(), actual = withFan.base.take();
    const at = actual.findIndex(line => line.startsWith('fillRect 1,2,3,4 fs=#ff00ff'));
    expect(at).toBeGreaterThan(0);
    expect(actual.filter((_, index) => index !== at)).toEqual(expected); // everything else is drawn as without the layer
    expect(actual[at + 1]).toMatch(/^fill \{.*fs=#d6ddc8 .*clip= *$/); // the first pad batch: pad colour and no clip
    expect(frames).toHaveLength(1);
    expect(frames[0].pane.id).toBe('main');
    expect(frames[0].surface).toBe('base');
    expect(frames[0].selection.pins.length).toBe(gndPins.length);
    expect(frames[0].visibleParts.length).toBe(stats!.parts);
    expect(frames[0].partPath(scene.parts[0])).toBe(frames[0].partPath(scene.parts[0]));
  });

  it('keeps drawing the other layers when a feature layer throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: Layer2D = { id: 'broken', surface: 'overlay', order: LAYER_ORDER.hover + 1, draw: frame => { frame.ctx.fillStyle = '#123456'; throw new Error('layer failed'); } };
    const plain = setup();
    plain.renderer.render('overlay', main(), state);
    const withBroken = setup([broken]);
    withBroken.renderer.render('overlay', main(), state);
    expect(withBroken.overlay.take()).toEqual(plain.overlay.take());
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('draws each pane clipped to its rectangle with its own view and side; the overlay is cleared once', () => {
    const top: BoardPane = { id: 'top', rect: { x: 0, y: 0, width: WIDTH / 2, height: HEIGHT }, view, side: 'top' };
    const bottom: BoardPane = { id: 'bottom', rect: { x: WIDTH / 2, y: 0, width: WIDTH / 2, height: HEIGHT }, view: { ...view, mirrored: true }, side: 'bottom' };
    const { base, overlay, renderer } = setup();
    const stats = renderer.render('base', [top, bottom], state)!;
    expect(stats.panes).toBe(2);
    const log = base.take();
    const backgrounds = log.filter(line => line.startsWith(`fillRect 0,0,${WIDTH / 2},${HEIGHT} fs=#0d131b`));
    expect(backgrounds).toHaveLength(2);
    expect(backgrounds[0]).toContain(`R0,0,${WIDTH / 2},${HEIGHT}@1,0,0,1,0,0`);
    expect(backgrounds[1]).toContain(`T=1,0,0,1,${WIDTH / 2},0`);
    expect(backgrounds[1]).toContain(`R${WIDTH / 2},0,${WIDTH / 2},${HEIGHT}@1,0,0,1,0,0`);
    for (const line of log) expect(line).toMatch(/clip=\[R/); // nothing is drawn outside a pane
    renderer.render('overlay', [top, bottom], state);
    expect(overlay.take().filter(line => line.startsWith('clearRect'))).toEqual([`clearRect 0,0,${WIDTH},${HEIGHT} T=1,0,0,1,0,0 clip=`]);
  });

  it('reports the time of every layer it drew', () => {
    const fan: Layer2D = { id: 'fan', surface: 'base', order: LAYER_ORDER.pads + 1, draw: () => {} };
    const { renderer } = setup([fan]);
    const base = renderer.render('base', main(), state)!;
    expect(Object.keys(base.layers)).toEqual(['background', 'outline', 'connections', 'bodies', 'pads', 'fan', 'labels']);
    for (const ms of Object.values(base.layers)) expect(ms).toBeGreaterThanOrEqual(0);
    expect(base).toMatchObject({ backend: 'canvas2d', surface: 'base', panes: 1 });
    expect(base.labels).toBeGreaterThan(0);
    const overlay = renderer.render('overlay', main(), state)!;
    expect(Object.keys(overlay.layers)).toEqual(['hover', 'selection', 'measurement', 'compass']);
    expect(overlay).toMatchObject({ surface: 'overlay', parts: 0, labels: 0 });
  });

  it('leaves out the layers a pane hides (an overview without labels and compass)', () => {
    const fit: ViewTransform = { ...view, scale: 1.2 };
    const overview: BoardPane = { id: 'overview', rect: { x: WIDTH - 220, y: HEIGHT - 150, width: 200, height: 130 }, view: fit, side: 'top', hiddenLayers: new Set(['labels', 'compass']) };
    const { base, overlay, renderer } = setup();
    renderer.render('base', [...main(), overview], { ...state, showLabels: true });
    renderer.render('overlay', [...main(), overview], state);
    const inOverview = (line: string) => line.includes(`R${WIDTH - 220},${HEIGHT - 150},200,130@`);
    const baseLog = base.take(), overlayLog = overlay.take();
    expect(baseLog.some(line => inOverview(line) && line.startsWith('fill {'))).toBe(true); // pads and parts are drawn
    expect(baseLog.some(line => inOverview(line) && line.startsWith('fillText'))).toBe(false);
    expect(baseLog.some(line => !inOverview(line) && line.startsWith('fillText'))).toBe(true);
    expect(overlayLog.filter(line => line.startsWith('fillText X'))).toHaveLength(1); // the main pane's compass only
  });

  it('reports a lost context and draws nothing without one', () => {
    const { base, renderer } = setup();
    expect(renderer.status()).toBe('ready');
    base.lost = true;
    expect(renderer.status()).toBe('lost');
    const none = new Canvas2DBoardRenderer(canvasOf(null), canvasOf(new RecordingContext()));
    expect(none.status()).toBe('unavailable');
    expect(none.render('base', main(), state)).toBeNull();
    const sceneless = new Canvas2DBoardRenderer(canvasOf(new RecordingContext()), canvasOf(new RecordingContext()));
    expect(sceneless.render('base', main(), state)).toBeNull();
  });

  it('reuses the pad paths while a pan stays inside the built region and rebuilds them after invalidate()', () => {
    const { renderer } = setup();
    const plain = { ...state, selectedNet: null };
    let created = 0;
    class CountingPath extends RecordingPath { constructor() { super(); created++; } }
    vi.stubGlobal('Path2D', CountingPath);
    try {
      renderer.render('base', main(), plain);
      const first = created;
      expect(first).toBeGreaterThan(0);
      renderer.render('base', [fullPane(panBy(view, { x: 30, y: 10 }), 'top', WIDTH, HEIGHT)], plain);
      expect(created).toBe(first); // the same pad batches and part outlines: nothing new
      renderer.invalidate();
      renderer.render('base', main(), plain);
      expect(created).toBe(first * 2);
    } finally { vi.stubGlobal('Path2D', RecordingPath); }
  });
});
