import { distance, expandBounds, orientPoint } from '../lib/geometry';
import type { Bounds2, Point2, ViewTransform } from '../lib/geometry';
import { createFormatters } from '../lib/i18n';
import { clipSegmentToBounds } from '../lib/render-geometry';
import type { BoardPin, ViewSide } from '../lib/types';
import { anyContextLost } from './board-canvas-recovery';
import { strokeMeasurementLine } from './board-measure-line';
import { boundsCover, buildPadLayers, PAD_REGION_SLACK, PAD_VIEW_MARGIN_PX, planPadLayers, samePadPlan } from './board-pad-layers';
import type { PadLayerPlan, PadLayers } from './board-pad-layers';
import { BOARD_PALETTES } from './board-palette';
import type { BoardPalette } from './board-palette';
import { LAYER_ORDER } from './board-renderer';
import type { BoardLayer, BoardRenderer, BoardRenderState, CanvasSize, RenderStats, RenderSurface, RendererStatus } from './board-renderer';
import { onSide, sideSelection } from './board-scene';
import type { BoardScene, ScenePart, SceneSide, SelectionInput, SideSelection } from './board-scene';
import { boardMatrix, coversCanvas, paneToScreen, paneViewport, screenMatrix } from './board-view';
import type { BoardPane } from './board-view';

/**
 * Canvas2D backend of the board renderer. Each surface is a stack of layers drawn per pane; the built-in layers below draw exactly
 * what the single draw function of the board canvas drew (same calls in the same order), feature layers plug in between them.
 */

/** What a layer of the Canvas2D backend draws with: one pane of one surface in one frame. */
export interface Frame2D {
  readonly ctx: CanvasRenderingContext2D;
  readonly surface: RenderSurface;
  readonly pane: BoardPane;
  readonly view: ViewTransform;
  /** Pane size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly scene: BoardScene;
  /** The scene side the pane shows. */
  readonly side: SceneSide;
  readonly state: BoardRenderState;
  readonly palette: BoardPalette;
  /** The selected net on this side (pads, parts, source pad of the connection lines). */
  readonly selection: SideSelection;
  /** Parts of the pane's side within its viewport plus 30 px, in the scene's query order (computed on first use). */
  readonly visibleParts: readonly ScenePart[];
  /** Sets the context transform to board millimetres of this pane. */
  toBoardSpace(): void;
  /** Sets the context transform to CSS pixels of this pane (origin at its top left corner). */
  toScreenSpace(): void;
  /** A canonical point in pane CSS pixels. */
  boardToScreen(point: Point2): Point2;
  /** The canonical bounds the pane shows, grown by `marginPx` screen pixels. */
  viewport(marginPx?: number): Bounds2;
  /** The outline path of a part in board space (built on first use, kept with the scene). */
  partPath(part: ScenePart): Path2D;
  /** The board outline path in board space. */
  outlinePath(): Path2D;
}
export type Layer2D = BoardLayer<Frame2D>;

/** Nets with more connection lines than this get thin solid lines: thousands of dashes cost much more to rasterize. */
export const DENSE_NET_THRESHOLD = 192;
/** Label limit per frame, the pixel size from which a part gets its label, and the label occupancy cell (CSS px). */
export const LABEL_LIMIT = 650;
export const LABEL_MIN_PX = 23;
const LABEL_CELL_WIDTH = 44, LABEL_CELL_HEIGHT = 17;
/** Parts that project smaller than this (CSS px) are drawn as a fixed-size marker instead of their outline. */
export const TINY_PART_PX = 3;

// ---------------------------------------------------------------------------------------------
// Renderer caches (per scene; pads per pane, plans and connection paths per side)
// ---------------------------------------------------------------------------------------------

interface ConnectionCache {
  pins: readonly BoardPin[]; source: BoardPin; path: Path2D;
  bounds: Bounds2;
  clipped?: { bounds: Bounds2; path: Path2D };
}
/** Display paths of the pads of the viewport region (plus a pan margin) at one zoom and selection; rebuilt when any of them or the region changes. */
interface PadPathCache {
  side: ViewSide; scale: number; net: string | null; component: string | null; region: Bounds2; paths: PadLayers<Path2D>;
}
interface SceneCaches {
  readonly scene: BoardScene;
  readonly partPaths: Array<Path2D | undefined>;
  outline: Path2D | null;
  readonly pads: Map<string, PadPathCache>;
  readonly plans: Partial<Record<ViewSide, PadLayerPlan>>;
  readonly connections: Partial<Record<ViewSide, ConnectionCache>>;
  readonly selections: Partial<Record<ViewSide, { input: SelectionInput; value: SideSelection }>>;
}
const newCaches = (scene: BoardScene): SceneCaches => ({ scene, partPaths: [], outline: null, pads: new Map(), plans: {}, connections: {}, selections: {} });

export function buildConnections(pins: readonly BoardPin[], source: BoardPin): ConnectionCache {
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

function visibleConnections(cache: ConnectionCache, bounds: Bounds2): Path2D {
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

function polygonPath(points: readonly Point2[]): Path2D {
  const path = new Path2D();
  path.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
  path.closePath();
  return path;
}

/** The drawn outline of a part: its polygon, or its bounds (at least 0.08 mm per side) when it has fewer than three points. */
function partOutlinePath(part: ScenePart): Path2D {
  const outline = part.component.outline;
  if (outline.length >= 3) return polygonPath(outline);
  const path = new Path2D();
  const b = part.component.bounds;
  path.rect(b.minX, b.minY, Math.max(0.08, b.maxX - b.minX), Math.max(0.08, b.maxY - b.minY));
  return path;
}

// ---------------------------------------------------------------------------------------------
// Built-in layers: base surface
// ---------------------------------------------------------------------------------------------

function drawBackground(f: Frame2D): void {
  const { ctx, view, width, height, palette } = f;
  f.toScreenSpace();
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);
  // The grid follows the board during panning; spacing changes by powers of ten.
  const gridUnit = Math.pow(10, Math.floor(Math.log10(28 / view.scale)));
  let spacing = gridUnit * view.scale;
  if (spacing < 14) spacing *= 5;
  const origin = f.boardToScreen({ x: 0, y: 0 });
  const startX = ((origin.x % spacing) + spacing) % spacing;
  const startY = ((origin.y % spacing) + spacing) % spacing;
  ctx.fillStyle = palette.grid;
  for (let x = startX; x < width; x += spacing) for (let y = startY; y < height; y += spacing) {
    ctx.fillRect(x, y, 1.2, 1.2);
  }
}

function drawOutline(f: Frame2D): void {
  const { ctx, view, palette } = f;
  f.toBoardSpace();
  ctx.fillStyle = palette.board;
  ctx.strokeStyle = palette.boardLine;
  ctx.lineWidth = 1.2 / view.scale;
  const path = f.outlinePath();
  ctx.fill(path);
  ctx.stroke(path);
}

/** Every straight link is an exact logical relation, never a copper trace. Dense nets use thin solid lines. */
function drawConnections(f: Frame2D, caches: SceneCaches): void {
  const { ctx, view, state, palette, selection } = f;
  const netPins = selection.pins;
  if (!state.showConnections || netPins.length <= 1 || !selection.source) return;
  f.toBoardSpace();
  let cache = caches.connections[f.pane.side];
  if (!cache || cache.pins !== netPins || cache.source !== selection.source) {
    cache = buildConnections(netPins, selection.source);
    caches.connections[f.pane.side] = cache;
  }
  const dense = netPins.length - 1 > DENSE_NET_THRESHOLD;
  ctx.strokeStyle = palette.cyan;
  ctx.globalAlpha = dense ? 0.13 : 0.22;
  ctx.lineWidth = (dense ? 0.65 : 0.9) / view.scale;
  ctx.setLineDash(dense ? [] : [4 / view.scale, 5 / view.scale]);
  ctx.stroke(visibleConnections(cache, f.viewport(1)));
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

function drawBodies(f: Frame2D): void {
  const { ctx, view, state, palette, dpr } = f;
  const netComponents = f.selection.components;
  f.toBoardSpace();
  for (const part of f.visibleParts) {
    const component = part.component;
    const selected = component.id === state.selectedComponentId;
    const linked = netComponents.has(component.id);
    const b = component.bounds;
    const projectedWidth = part.width * view.scale;
    const projectedHeight = part.height * view.scale;
    const projectedSize = Math.max(projectedWidth, projectedHeight);
    const kind = part.group;
    const fill = kind === 'chip' ? palette.chip : kind === 'connector' ? palette.connector : palette.body;
    const line = kind === 'chip' ? palette.chipLine : kind === 'connector' ? palette.connectorLine : palette.bodyLine;
    ctx.globalAlpha = state.selectedNet && !linked && !selected ? 0.48 : 1;
    ctx.fillStyle = selected ? palette.amberFill : linked ? palette.netFill : fill;
    ctx.strokeStyle = selected ? palette.amber : linked ? palette.cyan : line;
    ctx.lineWidth = (selected ? 2 : linked ? 1.4 : 0.95) / view.scale;
    if (projectedSize < TINY_PART_PX) {
      // Display-only footprint markers keep tiny parts visible without changing geometry.
      const center = part.center;
      const markerWidth = Math.max(part.width, 2.6 / view.scale);
      const markerHeight = Math.max(part.height, 2.6 / view.scale);
      ctx.fillRect(center.x - markerWidth / 2, center.y - markerHeight / 2, markerWidth, markerHeight);
    } else {
      const outline = f.partPath(part);
      ctx.fill(outline);
      ctx.stroke(outline);
    }
    if (selected) {
      ctx.save();
      ctx.shadowColor = palette.amberGlow;
      ctx.shadowBlur = 14 * dpr;
      ctx.stroke(f.partPath(part));
      ctx.restore();
    }
    // A quiet inset gives larger IC bodies depth; these are styling details, not pins.
    if (kind === 'chip' && Math.min(projectedWidth, projectedHeight) > 24) {
      const inset = Math.max(2.5 / view.scale, Math.min(part.width, part.height) * 0.13);
      ctx.save(); ctx.clip(f.partPath(part));
      ctx.strokeStyle = selected ? palette.amber : linked ? palette.cyan : palette.chipInset;
      ctx.lineWidth = 0.7 / view.scale;
      ctx.strokeRect(b.minX + inset, b.minY + inset, part.width - inset * 2, part.height - inset * 2);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Each pad keeps its physical shape plus the same screen-size fallback marker. Cached batches replace thousands of fill calls during
 * panning; only the pads of the viewport (plus a pan margin) get display paths (P04), and the layer/batch assignment is per selection
 * and zoom-independent (board-pad-layers.ts).
 */
function drawPads(f: Frame2D, caches: SceneCaches): void {
  const { ctx, view, state, palette, pane, width, height } = f;
  f.toBoardSpace();
  let pinCache = caches.pads.get(pane.id);
  const sidePins = f.side.pinList;
  const needed = f.viewport(PAD_VIEW_MARGIN_PX);
  if (!pinCache || pinCache.side !== pane.side || pinCache.scale !== view.scale
    || pinCache.net !== state.selectedNet || pinCache.component !== state.selectedComponentId || !boundsCover(pinCache.region, needed)) {
    let plan = caches.plans[pane.side] ?? null;
    if (!samePadPlan(plan, sidePins, state.selectedNet, state.selectedComponentId)) {
      plan = planPadLayers(sidePins, state.selectedNet, state.selectedComponentId);
      caches.plans[pane.side] = plan;
    }
    const region = f.viewport(PAD_VIEW_MARGIN_PX + Math.max(width, height) * PAD_REGION_SLACK);
    pinCache = {
      side: pane.side, scale: view.scale, net: state.selectedNet, component: state.selectedComponentId, region,
      paths: buildPadLayers(plan, region, view.scale, () => new Path2D()),
    };
    caches.pads.set(pane.id, pinCache);
  }
  ctx.globalAlpha = state.selectedNet ? 0.44 : 1;
  ctx.fillStyle = palette.pad;
  for (const path of pinCache.paths.ordinary) ctx.fill(path);
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.amber;
  for (const path of pinCache.paths.selectedComponent) ctx.fill(path);
  ctx.fillStyle = palette.cyan;
  for (const path of pinCache.paths.net) ctx.fill(path);
  ctx.globalAlpha = 1;
}

/** Part references in screen space, upright at any rotation. The selected part's label comes first and is always drawn. */
function drawLabels(f: Frame2D, stats: { labels: number }): void {
  const { ctx, view, state, palette, width, height } = f;
  if (!state.showLabels && !state.selectedComponentId) return;
  f.toScreenSpace();
  const netComponents = f.selection.components;
  const occupied = new Set<string>();
  let drawn = 0;
  const visit = (part: ScenePart) => {
    const component = part.component;
    const selected = component.id === state.selectedComponentId;
    if (!selected && (!state.showLabels || drawn >= LABEL_LIMIT)) return;
    const projectedSize = part.extent * view.scale;
    if (!selected && projectedSize < LABEL_MIN_PX) return;
    const screen = f.boardToScreen(part.center);
    if (screen.x < -50 || screen.x > width + 50 || screen.y < -20 || screen.y > height + 20) return;
    const cellKey = `${Math.floor(screen.x / LABEL_CELL_WIDTH)}:${Math.floor(screen.y / LABEL_CELL_HEIGHT)}`;
    if (!selected && occupied.has(cellKey)) return;
    occupied.add(cellKey);
    ctx.font = `600 ${selected ? 13 : 11}px 'IBM Plex Mono', Consolas, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.globalAlpha = state.selectedNet && !netComponents.has(component.id) && !selected ? 0.62 : 1;
    const labelWidth = ctx.measureText(component.ref).width;
    ctx.fillStyle = palette.labelBacking;
    ctx.beginPath(); ctx.roundRect(screen.x - labelWidth / 2 - 4, screen.y - (selected ? 10 : 8), labelWidth + 8, selected ? 20 : 16, 3); ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = palette.labelHalo; ctx.strokeText(component.ref, screen.x, screen.y);
    ctx.fillStyle = selected ? palette.amber : palette.label; ctx.fillText(component.ref, screen.x, screen.y);
    drawn++;
  };
  const parts = f.visibleParts;
  const selectedId = state.selectedComponentId;
  // The selected part first (it may take a cell another label wants), then every other part in query order.
  if (selectedId) for (const part of parts) if (part.component.id === selectedId) visit(part);
  for (const part of parts) if (part.component.id !== selectedId) visit(part);
  ctx.globalAlpha = 1;
  stats.labels += drawn;
}

// ---------------------------------------------------------------------------------------------
// Built-in layers: overlay surface (hover, the selection markers and the measurement never repaint the board)
// ---------------------------------------------------------------------------------------------

function drawHover(f: Frame2D): void {
  const { ctx, view, state, palette, scene, dpr } = f;
  f.toBoardSpace();
  const part = state.hoverComponentId ? scene.partsById.get(state.hoverComponentId) : undefined;
  if (!part || !onSide(part.component, f.pane.side) || state.measureMode || state.dragging || part.component.id === state.selectedComponentId) return;
  ctx.strokeStyle = f.selection.components.has(part.component.id) ? palette.cyan : palette.hoverLine;
  ctx.lineWidth = 1.4 / view.scale;
  ctx.save(); ctx.shadowColor = palette.hoverGlow; ctx.shadowBlur = 9 * dpr;
  ctx.stroke(f.partPath(part)); ctx.restore();
}

function drawSelectionMarkers(f: Frame2D): void {
  const { ctx, view, state, palette, scene } = f;
  f.toBoardSpace();
  const side = f.pane.side;
  const selectedComponent = state.selectedComponentId ? scene.componentsById.get(state.selectedComponentId) : undefined;
  if (selectedComponent && onSide(selectedComponent, side)) {
    const progress = state.selectionPulse;
    const marker = expandBounds(selectedComponent.bounds, (4 + (1 - progress) * 5) / view.scale);
    ctx.strokeStyle = palette.amber; ctx.lineWidth = 2 / view.scale;
    ctx.globalAlpha = 0.7 * progress;
    ctx.setLineDash([4 / view.scale, 4 / view.scale]);
    ctx.strokeRect(marker.minX, marker.minY, marker.maxX - marker.minX, marker.maxY - marker.minY);
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  const selectedPin = state.selectedPinId ? scene.pinsById.get(state.selectedPinId) : undefined;
  if (selectedPin && onSide(selectedPin, side)) {
    const linked = !!state.selectedNet && selectedPin.net === state.selectedNet;
    const markerPixels = linked ? 2.2 : selectedPin.componentId === state.selectedComponentId ? 1.8 : 1;
    const radius = Math.max(selectedPin.radius, markerPixels / view.scale);
    ctx.beginPath(); ctx.arc(selectedPin.x, selectedPin.y, radius + 3.3 / view.scale, 0, Math.PI * 2);
    ctx.lineWidth = 1.6 / view.scale; ctx.strokeStyle = palette.cyan; ctx.stroke();
  }
}

function drawMeasurement(f: Frame2D): void {
  const { ctx, state, palette, width, height } = f;
  f.toScreenSpace();
  const measured = state.measurement;
  if (!measured.length) return;
  const a = f.boardToScreen(measured[0]);
  const b = measured[1] ? f.boardToScreen(measured[1]) : state.cursor && state.measureMode ? f.boardToScreen(state.cursor) : a;
  ctx.strokeStyle = palette.amber; ctx.fillStyle = palette.amber;
  ctx.lineWidth = 1.5;
  // P03: only the visible part of the dashed line is rasterized (a measurement at high zoom has endpoints far offscreen); dash phase is kept.
  strokeMeasurementLine(ctx, a, b, width, height);
  for (const point of measured.length === 2 ? [a, b] : [a]) {
    ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(point.x, point.y, 8, 0, Math.PI * 2); ctx.stroke();
  }
  const endpoint = measured[1] ?? state.cursor;
  if (endpoint) {
    // The number follows the UI language; the unit stays "mm" in every language.
    const text = `${createFormatters(state.language).mm(distance(measured[0], endpoint))} mm`;
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 17 };
    ctx.font = "500 12px 'IBM Plex Mono', Consolas, monospace";
    const textWidth = ctx.measureText(text).width;
    ctx.fillStyle = palette.card; ctx.strokeStyle = palette.amber; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(middle.x - textWidth / 2 - 9, middle.y - 12, textWidth + 18, 24, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = palette.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, middle.x, middle.y);
  }
}

/** Compact orientation compass; stays readable even when the board is mirrored. */
function drawCompass(f: Frame2D): void {
  const { ctx, view, palette, width, height } = f;
  f.toScreenSpace();
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

// ---------------------------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------------------------

interface StackEntry { layer: Layer2D; builtIn: boolean }

export class Canvas2DBoardRenderer implements BoardRenderer<Frame2D> {
  readonly backend = 'canvas2d' as const;
  private caches: SceneCaches | null = null;
  private size: CanvasSize = { width: 1, height: 1, dpr: 1 };
  private features: readonly Layer2D[] = [];
  private stacks: Record<RenderSurface, StackEntry[]> = { base: [], overlay: [] };
  private readonly builtIns: readonly Layer2D[];
  private readonly frameStats = { labels: 0 };

  constructor(private readonly baseCanvas: HTMLCanvasElement, private readonly overlayCanvas: HTMLCanvasElement) {
    const caches = () => this.caches!;
    const stats = this.frameStats;
    this.builtIns = [
      { id: 'background', surface: 'base', order: LAYER_ORDER.background, draw: drawBackground },
      { id: 'outline', surface: 'base', order: LAYER_ORDER.outline, draw: drawOutline },
      { id: 'connections', surface: 'base', order: LAYER_ORDER.connections, draw: f => drawConnections(f, caches()) },
      { id: 'bodies', surface: 'base', order: LAYER_ORDER.bodies, draw: drawBodies },
      { id: 'pads', surface: 'base', order: LAYER_ORDER.pads, draw: f => drawPads(f, caches()) },
      { id: 'labels', surface: 'base', order: LAYER_ORDER.labels, draw: f => drawLabels(f, stats) },
      { id: 'hover', surface: 'overlay', order: LAYER_ORDER.hover, draw: drawHover },
      { id: 'selection', surface: 'overlay', order: LAYER_ORDER.selection, draw: drawSelectionMarkers },
      { id: 'measurement', surface: 'overlay', order: LAYER_ORDER.measurement, draw: drawMeasurement },
      { id: 'compass', surface: 'overlay', order: LAYER_ORDER.compass, draw: drawCompass },
    ];
    this.restack();
  }

  setScene(scene: BoardScene): void {
    if (this.caches?.scene !== scene) this.caches = newCaches(scene);
  }

  setSize(size: CanvasSize): void { this.size = size; }

  setLayers(layers: readonly Layer2D[]): void {
    if (layers === this.features) return;
    this.features = layers;
    this.restack();
  }

  /** The layer ids of a surface in draw order (built-in and feature layers). */
  layerIds(surface: RenderSurface): string[] { return this.stacks[surface].map(entry => entry.layer.id); }

  private restack(): void {
    for (const surface of ['base', 'overlay'] as const) {
      const entries: StackEntry[] = [
        ...this.builtIns.filter(layer => layer.surface === surface).map(layer => ({ layer, builtIn: true })),
        ...this.features.filter(layer => layer.surface === surface).map(layer => ({ layer, builtIn: false })),
      ];
      // Stable: a feature layer with the order of a built-in one draws after it.
      this.stacks[surface] = entries.sort((a, b) => a.layer.order - b.layer.order);
    }
  }

  private context(surface: RenderSurface): CanvasRenderingContext2D | null {
    return surface === 'base' ? this.baseCanvas.getContext('2d', { alpha: false }) : this.overlayCanvas.getContext('2d');
  }

  status(): RendererStatus {
    const base = this.context('base'), overlay = this.context('overlay');
    if (!base || !overlay) return 'unavailable';
    return anyContextLost([base, overlay]) ? 'lost' : 'ready';
  }

  invalidate(): void {
    if (this.caches) this.caches = newCaches(this.caches.scene);
  }

  dispose(): void {
    this.caches = null;
    this.features = [];
    this.restack();
  }

  private selectionFor(side: ViewSide, state: BoardRenderState): SideSelection {
    const caches = this.caches!;
    const previous = caches.selections[side];
    if (previous && previous.input.componentId === state.selectedComponentId && previous.input.pinId === state.selectedPinId && previous.input.net === state.selectedNet) return previous.value;
    const input = { componentId: state.selectedComponentId, pinId: state.selectedPinId, net: state.selectedNet };
    const value = sideSelection(caches.scene, side, input);
    caches.selections[side] = { input, value };
    return value;
  }

  private frame(ctx: CanvasRenderingContext2D, surface: RenderSurface, pane: BoardPane, state: BoardRenderState): Frame2D {
    const caches = this.caches!;
    const { dpr } = this.size;
    const scene = caches.scene;
    const side = scene.sides[pane.side];
    let visible: ScenePart[] | null = null;
    let board: readonly number[] | null = null;
    const screen = screenMatrix(pane, dpr);
    return {
      ctx, surface, pane, view: pane.view, width: pane.rect.width, height: pane.rect.height, dpr, scene, side, state,
      palette: BOARD_PALETTES[state.theme],
      selection: this.selectionFor(pane.side, state),
      get visibleParts() { return (visible ??= side.parts.query(paneViewport(pane, 30))); },
      toBoardSpace() { const m = (board ??= boardMatrix(pane, dpr)); ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]); },
      toScreenSpace() { ctx.setTransform(screen[0], screen[1], screen[2], screen[3], screen[4], screen[5]); },
      boardToScreen: point => paneToScreen(pane, point),
      viewport: (marginPx = 0) => paneViewport(pane, marginPx),
      partPath: part => (caches.partPaths[part.index] ??= partOutlinePath(part)),
      outlinePath: () => (caches.outline ??= polygonPath(scene.outline)),
    };
  }

  render(surface: RenderSurface, panes: readonly BoardPane[], state: BoardRenderState): RenderStats | null {
    const ctx = this.context(surface);
    if (!ctx || !this.caches) return null;
    const start = performance.now();
    const { width, height, dpr } = this.size;
    this.frameStats.labels = 0;
    let parts = 0;
    const layers: Record<string, number> = {};
    if (surface === 'overlay') {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
    }
    for (const pane of panes) {
      const frame = this.frame(ctx, surface, pane, state);
      const clip = !coversCanvas(pane, width, height);
      if (clip) {
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.beginPath(); ctx.rect(pane.rect.x, pane.rect.y, pane.rect.width, pane.rect.height); ctx.clip();
      }
      for (const { layer, builtIn } of this.stacks[surface]) {
        if (pane.hiddenLayers?.has(layer.id)) continue;
        const layerStart = performance.now();
        if (builtIn) layer.draw(frame);
        else {
          ctx.save();
          try { layer.draw(frame); } catch (error) { console.error(`Board layer "${layer.id}" failed`, error); } finally { ctx.restore(); }
        }
        layers[layer.id] = (layers[layer.id] ?? 0) + performance.now() - layerStart;
      }
      if (clip) ctx.restore();
      if (surface === 'base') parts += frame.visibleParts.length;
    }
    return { backend: this.backend, surface, ms: performance.now() - start, layers, panes: panes.length, parts, labels: this.frameStats.labels };
  }
}
