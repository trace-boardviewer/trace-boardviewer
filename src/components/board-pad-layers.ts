import { padBounds } from '../lib/geometry';
import type { Bounds2 } from '../lib/geometry';
import { appendPadPath } from '../lib/render-geometry';
import type { BoardPin } from '../lib/types';

type PadPath = Parameters<typeof appendPadPath>[0];

/** Pads per native compound path: bounds the cost of closing contours and the number of fills (unchanged from the original renderer). */
export const PAD_BATCH_SIZE = 64;
/** Screen-pixel margin around the viewport that is always built: a display-only pad marker is at most 2.2 px around the pad centre. */
export const PAD_VIEW_MARGIN_PX = 16;
/** Extra margin (fraction of the larger canvas side) built beyond the viewport so panning does not rebuild paths on every frame. */
export const PAD_REGION_SLACK = 0.25;

export interface PadLayers<P> { ordinary: P[]; selectedComponent: P[]; net: P[] }

/** Physical bounds of every pad of one side (canonical mm), cached per pin array: independent of the zoom. */
interface PadBoundsTable { minX: Float64Array; minY: Float64Array; maxX: Float64Array; maxY: Float64Array }
const boundsTables = new WeakMap<readonly BoardPin[], PadBoundsTable>();
function boundsTableOf(pins: readonly BoardPin[]): PadBoundsTable {
  let table = boundsTables.get(pins);
  if (table) return table;
  const count = pins.length;
  table = { minX: new Float64Array(count), minY: new Float64Array(count), maxX: new Float64Array(count), maxY: new Float64Array(count) };
  for (let i = 0; i < count; i++) {
    const b = padBounds(pins[i]);
    table.minX[i] = b.minX; table.minY[i] = b.minY; table.maxX[i] = b.maxX; table.maxY[i] = b.maxY;
  }
  boundsTables.set(pins, table);
  return table;
}

const LAYER_ORDINARY = 0, LAYER_COMPONENT = 1, LAYER_NET = 2;
/** The marker size (screen px) of each layer — the same values the renderer always used. */
const MARKER_PIXELS = [1, 1.8, 2.2] as const;

/**
 * Which layer and which 64-pad batch every pad belongs to. It depends on the selection only (not on the zoom or the viewport), so a zoom
 * step reuses it and every batch keeps exactly the members it always had — even when only the visible batches are built.
 */
export interface PadLayerPlan {
  readonly pins: readonly BoardPin[];
  readonly net: string | null;
  readonly component: string | null;
  readonly layer: Uint8Array;
  readonly batch: Uint32Array;
}

export function planPadLayers(pins: readonly BoardPin[], selectedNet: string | null, selectedComponent: string | null): PadLayerPlan {
  const layer = new Uint8Array(pins.length), batch = new Uint32Array(pins.length);
  const counts = [0, 0, 0];
  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i];
    const kind = selectedNet && pin.net === selectedNet ? LAYER_NET : pin.componentId === selectedComponent ? LAYER_COMPONENT : LAYER_ORDINARY;
    layer[i] = kind;
    batch[i] = Math.floor(counts[kind]++ / PAD_BATCH_SIZE);
  }
  return { pins, net: selectedNet, component: selectedComponent, layer, batch };
}

export const samePadPlan = (plan: PadLayerPlan | null, pins: readonly BoardPin[], net: string | null, component: string | null): plan is PadLayerPlan =>
  !!plan && plan.pins === pins && plan.net === net && plan.component === component;

/** True when `inner` lies completely inside `outer`. */
export const boundsCover = (outer: Bounds2, inner: Bounds2) =>
  outer.minX <= inner.minX && outer.maxX >= inner.maxX && outer.minY <= inner.minY && outer.maxY >= inner.maxY;

/**
 * P04: the display paths of the pads whose physical bounds touch `region` (canonical mm), batched exactly as a full build would batch
 * them. Pads outside the region are neither visited by the path builder nor filled: 100k pads outside the view cost one linear pass over
 * cached numbers instead of 300k lineTo + 100k moveTo + 100k closePath and 1563 batch fills on every zoom step. The visible pads keep
 * their original order and their `appendPadPath` geometry, so the pixels inside the region are unchanged.
 */
export function buildPadLayers<P extends PadPath>(plan: PadLayerPlan, region: Bounds2, scale: number, createPath: () => P): PadLayers<P> {
  const table = boundsTableOf(plan.pins);
  const result: PadLayers<P> = { ordinary: [], selectedComponent: [], net: [] };
  const lists = [result.ordinary, result.selectedComponent, result.net];
  const currentBatch = [-1, -1, -1];
  const currentPath: Array<P | null> = [null, null, null];
  const { minX, minY, maxX, maxY } = table;
  for (let i = 0; i < plan.pins.length; i++) {
    if (maxX[i] < region.minX || minX[i] > region.maxX || maxY[i] < region.minY || minY[i] > region.maxY) continue;
    const kind = plan.layer[i];
    let path = currentPath[kind];
    if (!path || currentBatch[kind] !== plan.batch[i]) {
      path = createPath();
      currentPath[kind] = path; currentBatch[kind] = plan.batch[i];
      lists[kind].push(path);
    }
    appendPadPath(path, plan.pins[i], scale, MARKER_PIXELS[kind]);
  }
  return result;
}
