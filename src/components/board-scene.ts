import { boundsCenter, boundsCorners, padBounds, SpatialIndex } from '../lib/geometry';
import type { Bounds2, Point2 } from '../lib/geometry';
import { createGroundMatcher, DEFAULT_GROUND_PATTERNS, isNoConnectName } from '../lib/net-class';
import { boardIndexOf } from '../lib/board-index';
import type { BoardIndex, SideNetGroup } from '../lib/board-index';
import { canvasGroup } from '../lib/part-kind';
import type { CanvasGroup, PartKind } from '../lib/part-kind';
import type { Board, BoardComponent, BoardPin, ViewSide } from '../lib/types';
import type { HitSource } from './board-hit-test';

/**
 * The board as every view of it needs it, built once per board and never changed: per-side spatial indices, the pads of each side,
 * the net groups of each side, the colour group (part kind) of every part, the label anchors and the display flags. It holds no
 * view, no selection and nothing of a renderer (no Path2D): the main view, a second pane of the two-sided view, the overview and a
 * later GPU renderer all read the same scene. Pure: it runs in node tests.
 */

export const VIEW_SIDES: readonly ViewSide[] = ['top', 'bottom'];
/** Cell size (mm) of the per-side spatial indices. */
export const SCENE_CELL_MM = 8;
/** Display-only radius (mm) added around every pad in the pad index, so zero-size source pads stay findable. */
export const PIN_INDEX_MARKER_MM = 0.06;

/** A part or pad is drawn on a side when it is on that side or on both. */
export const onSide = (item: { side: string }, side: ViewSide): boolean => item.side === side || item.side === 'both';

/** One part with what drawing it needs, derived once. `index` is its position in `BoardScene.parts` (renderer caches are arrays by it). */
export interface ScenePart {
  readonly index: number;
  readonly component: BoardComponent;
  readonly kind: PartKind;
  /** Body colour group. */
  readonly group: CanvasGroup;
  /** Bounds width and height (mm). */
  readonly width: number;
  readonly height: number;
  /** The larger of width and height: the part's label is a candidate once this projects to the label threshold. */
  readonly extent: number;
  /** Bounds centre: the label anchor and the centre of the marker of a part too small to draw. */
  readonly center: Point2;
}

/** The pads of one net on one side and the parts they belong to. */
export type NetGroup = SideNetGroup;

export interface SceneSide {
  readonly side: ViewSide;
  /** Parts drawn on this side, by bounds. A query returns them in a fixed order (the draw and label order). */
  readonly parts: SpatialIndex<ScenePart>;
  /** The same parts as components, for hit testing. */
  readonly components: HitSource<BoardComponent>;
  /** Pads drawn on this side by `padBounds(pin, PIN_INDEX_MARKER_MM)`. */
  readonly pins: SpatialIndex<BoardPin>;
  /** Pads drawn on this side in board order (the pad layer plan's input). */
  readonly pinList: readonly BoardPin[];
  /** Net name to the pads of that net on this side. */
  readonly nets: ReadonlyMap<string, NetGroup>;
}

export interface BoardScene {
  readonly board: Board;
  /** Every part, in board order. */
  readonly parts: readonly ScenePart[];
  readonly partsById: ReadonlyMap<string, ScenePart>;
  readonly componentsById: ReadonlyMap<string, BoardComponent>;
  readonly pinsById: ReadonlyMap<string, BoardPin>;
  /** The board outline polygon, or the corners of the bounds when the file has no usable outline. */
  readonly outline: readonly Point2[];
  readonly sides: Readonly<Record<ViewSide, SceneSide>>;
}

export function buildBoardScene(board: Board, index: BoardIndex = boardIndexOf(board)): BoardScene {
  const parts: ScenePart[] = [];
  const partsById = new Map<string, ScenePart>();
  const componentsById = index.componentById;
  const partIndex = { top: new SpatialIndex<ScenePart>(SCENE_CELL_MM), bottom: new SpatialIndex<ScenePart>(SCENE_CELL_MM) };
  for (const component of board.components) {
    const b = component.bounds;
    const kind = index.kinds.get(component.id) ?? 'part';
    const width = b.maxX - b.minX, height = b.maxY - b.minY;
    const part: ScenePart = { index: parts.length, component, kind, group: canvasGroup(kind), width, height, extent: Math.max(width, height), center: boundsCenter(b) };
    parts.push(part);
    partsById.set(component.id, part);
    if (onSide(component, 'top')) partIndex.top.add(part, b);
    if (onSide(component, 'bottom')) partIndex.bottom.add(part, b);
  }
  const pinsById = index.pinById;
  const pinIndex = { top: new SpatialIndex<BoardPin>(SCENE_CELL_MM), bottom: new SpatialIndex<BoardPin>(SCENE_CELL_MM) };
  for (const side of VIEW_SIDES) {
    for (const pin of index.sides[side].pins) pinIndex[side].add(pin, padBounds(pin, PIN_INDEX_MARKER_MM));
  }
  const sideOf = (side: ViewSide): SceneSide => {
    const spatial = partIndex[side];
    return {
      side, parts: spatial, pins: pinIndex[side], pinList: index.sides[side].pins, nets: index.sides[side].netPins,
      components: { query: (bounds: Bounds2) => spatial.query(bounds).map(part => part.component) },
    };
  };
  return {
    board, parts, partsById, componentsById, pinsById,
    outline: board.outline.length >= 3 ? board.outline : boundsCorners(board.bounds),
    sides: { top: sideOf('top'), bottom: sideOf('bottom') },
  };
}

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

export interface SelectionInput { readonly componentId: string | null; readonly pinId: string | null; readonly net: string | null }
/** What a selection highlights on one side: the pads and parts of the selected net and the pad its connection lines start from. */
export interface SideSelection {
  readonly pins: readonly BoardPin[];
  readonly components: ReadonlySet<string>;
  /** The selected pad when it is on the net and on this side, else the net's first pad of the selected part, else its first pad. */
  readonly source: BoardPin | undefined;
}
const NO_PINS: readonly BoardPin[] = [];
const NO_COMPONENTS: ReadonlySet<string> = new Set();

export function sideSelection(scene: BoardScene, side: ViewSide, selection: SelectionInput): SideSelection {
  const group = selection.net ? scene.sides[side].nets.get(selection.net) : undefined;
  const pins = group?.pins ?? NO_PINS;
  const selectedPin = selection.pinId ? scene.pinsById.get(selection.pinId) : undefined;
  const source = (selectedPin && selectedPin.net === selection.net && onSide(selectedPin, side) ? selectedPin : undefined)
    ?? pins.find(pin => pin.componentId === selection.componentId) ?? pins[0];
  return { pins, components: group?.components ?? NO_COMPONENTS, source };
}

// ---------------------------------------------------------------------------------------------
// Display flags (read by display filters; computed on first use, then kept with the scene)
// ---------------------------------------------------------------------------------------------

export const PART_FLAG = {
  /** Every pad of the part is unconnected (no net or a no-connect name). */
  noConnect: 1,
  /** Every pad of the part is on a ground net. */
  ground: 2,
  /** The larger side of the part's bounds is below the small-part limit. */
  small: 4,
  /** A mounting hole, fiducial or other part without an electrical role. */
  mechanical: 8,
  testpoint: 16,
} as const;
/** Parts whose larger side is below this (mm) are small. */
export const SMALL_PART_MM = 1;

const flagCache = new WeakMap<BoardScene, Uint8Array>();

/** One byte of PART_FLAG bits per part (index = `ScenePart.index`), for the default ground names and small-part limit. */
export function partDisplayFlags(scene: BoardScene): Uint8Array {
  let flags = flagCache.get(scene);
  if (flags) return flags;
  flags = computePartFlags(scene, DEFAULT_GROUND_PATTERNS, SMALL_PART_MM);
  flagCache.set(scene, flags);
  return flags;
}

export function computePartFlags(scene: BoardScene, groundPatterns: readonly string[], smallPartMm: number): Uint8Array {
  const isGround = createGroundMatcher(groundPatterns);
  const netKind = new Map<string, number>();
  const kindOf = (net: string) => {
    let kind = netKind.get(net);
    if (kind === undefined) { kind = isNoConnectName(net) ? PART_FLAG.noConnect : isGround(net) ? PART_FLAG.ground : 0; netKind.set(net, kind); }
    return kind;
  };
  const flags = new Uint8Array(scene.parts.length);
  for (const part of scene.parts) {
    let flag = part.extent < smallPartMm ? PART_FLAG.small : 0;
    if (part.kind === 'mechanical') flag |= PART_FLAG.mechanical;
    if (part.kind === 'testpoint') flag |= PART_FLAG.testpoint;
    const pinIds = part.component.pinIds;
    if (pinIds.length) {
      let all = PART_FLAG.noConnect | PART_FLAG.ground;
      for (const id of pinIds) {
        const pin = scene.pinsById.get(id);
        all &= pin ? kindOf(pin.net) : PART_FLAG.noConnect;
        if (!all) break;
      }
      flag |= all;
    }
    flags[part.index] = flag;
  }
  return flags;
}
