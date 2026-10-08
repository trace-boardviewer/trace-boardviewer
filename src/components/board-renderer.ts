import type { Point2 } from '../lib/geometry';
import type { Language } from '../lib/types';
import type { BoardTheme } from './board-palette';
import type { BoardScene } from './board-scene';
import type { BoardPane } from './board-view';

/**
 * The contract between the board canvas (input, camera, panes) and a backend that draws a board scene. The canvas keeps two surfaces:
 * `base` (the board: redrawn only when it changed) and `overlay` (hover, selection markers, measurement, compass: cheap, redrawn on
 * every pointer change). Each surface is a stack of layers, drawn per pane in `order`. Canvas2D is the backend today
 * (board-render-2d.ts); a WebGL2 backend would implement the same interface for the base surface and keep the overlay on Canvas2D.
 */

export type RenderSurface = 'base' | 'overlay';
export type RendererBackend = 'canvas2d' | 'webgl2';

/** Built-in layers and their place in the stack. A feature layer goes between two of them by taking an `order` in between. */
export const LAYER_ORDER = {
  // base surface
  background: 100,
  outline: 200,
  /** Logical connection lines of the selected net, under the parts. */
  connections: 300,
  bodies: 400,
  pads: 500,
  labels: 600,
  // overlay surface
  hover: 100,
  selection: 200,
  measurement: 300,
  compass: 900,
} as const;
export type BuiltInLayerId = keyof typeof LAYER_ORDER;

/** Everything a frame depends on besides the scene and the panes. */
export interface BoardRenderState {
  readonly theme: BoardTheme;
  readonly selectedComponentId: string | null;
  readonly selectedPinId: string | null;
  readonly selectedNet: string | null;
  readonly showLabels: boolean;
  readonly showConnections: boolean;
  readonly measureMode: boolean;
  /** UI language of the measurement number. */
  readonly language: Language;
  /** The part under the pointer, if any. */
  readonly hoverComponentId: string | null;
  /** A pointer drag is in progress (hover is not shown). */
  readonly dragging: boolean;
  /** Measurement points (canonical mm): none, the first, or both. */
  readonly measurement: readonly Point2[];
  /** Canonical point under the pointer, if known. */
  readonly cursor: Point2 | null;
  /** Progress of the selection marker animation, 0 to 1 (1: settled). */
  readonly selectionPulse: number;
}

export interface CanvasSize { readonly width: number; readonly height: number; readonly dpr: number }

export interface RenderStats {
  readonly backend: RendererBackend;
  readonly surface: RenderSurface;
  /** Time spent in `render` (ms). */
  readonly ms: number;
  /** Time spent in each layer (ms, summed over the panes), by layer id. */
  readonly layers: Readonly<Record<string, number>>;
  readonly panes: number;
  /** Parts within the panes' viewports (base surface). */
  readonly parts: number;
  /** Labels drawn (base surface). */
  readonly labels: number;
}

/** `ready`: draw; `unavailable`: a surface has no context (nothing to draw); `lost`: a context is lost (GPU reset), draw after it is restored. */
export type RendererStatus = 'ready' | 'unavailable' | 'lost';

/**
 * A feature layer (net fan lines, rail walk colours, image overlays, readings, ...) plugged into a surface without touching the
 * built-in layers. `draw` runs once per pane and frame between `save()` and `restore()`; the frame tells it where it is. The
 * renderer redraws when the list of layers changes (give a new layer object or array when a layer's data changes).
 */
export interface BoardLayer<Frame = unknown> {
  readonly id: string;
  readonly surface: RenderSurface;
  readonly order: number;
  draw(frame: Frame): void;
}

export interface BoardRenderer<Frame = unknown> {
  readonly backend: RendererBackend;
  setScene(scene: BoardScene): void;
  setSize(size: CanvasSize): void;
  /** Feature layers of both surfaces; built-in layers are always present. */
  setLayers(layers: readonly BoardLayer<Frame>[]): void;
  status(): RendererStatus;
  /** Draws one surface for every pane (in list order). Null when the renderer is not ready. */
  render(surface: RenderSurface, panes: readonly BoardPane[], state: BoardRenderState): RenderStats | null;
  /** Drops every cached path and plan (after a lost context, or to measure a cold frame). */
  invalidate(): void;
  dispose(): void;
}
