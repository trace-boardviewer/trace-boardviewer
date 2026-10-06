import { describe, expect, it } from 'vitest';
import { boardToScreen, boundsFromPoints, padBounds, SpatialIndex } from '../lib/geometry';
import type { Point2, ViewTransform } from '../lib/geometry';
import type { BoardComponent, BoardPin, BoardSide } from '../lib/types';
import { COMPONENT_EDGE_TOLERANCE_PX, hitTestBoard, pickComponent, pickPad } from './board-hit-test';

const WIDTH = 800, HEIGHT = 600;
const sides = ['top', 'bottom'] as const;
const rotations = [0, 90, 180, 270] as const;

function viewOf(side: 'top' | 'bottom', rotation: number, scale = 6.8): ViewTransform {
  return { center: { x: 50, y: 50 }, scale, rotation, mirrored: side === 'bottom' };
}

function component(id: string, outline: Point2[], side: BoardSide, extra: Partial<BoardComponent> = {}): BoardComponent {
  const bounds = extra.bounds ?? boundsFromPoints(outline);
  return { id, ref: id, value: '', package: '', side, bounds, position: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }, rotation: 0, pinIds: [], outline, ...extra };
}

function pad(id: string, componentId: string, x: number, y: number, side: BoardSide, extra: Partial<BoardPin> = {}): BoardPin {
  return { id, componentId, number: '1', name: '1', net: 'N', side, x, y, radius: 0.2, shape: 'round', ...extra };
}

/** The same indexes BoardCanvas builds per side (components by bounds, pads by `padBounds(pin, 0.06)`). */
function indicesOf(components: BoardComponent[], pins: BoardPin[]) {
  const index = { pins: new SpatialIndex<BoardPin>(8), components: new SpatialIndex<BoardComponent>(8) };
  for (const item of components) index.components.add(item, item.bounds);
  for (const item of pins) index.pins.add(item, padBounds(item, 0.06));
  return { ...index, componentsById: new Map(components.map(item => [item.id, item])) };
}

const triangle = (side: BoardSide) => component('U1', [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 20, y: 80 }], side);

describe('B17 component hit uses the real outline, not its bounding rectangle', () => {
  for (const side of sides) for (const rotation of rotations) {
    const view = viewOf(side, rotation);
    const click = (board: Point2, options = { selectedComponentId: null as string | null }, indices = indicesOf([triangle(side)], [])) =>
      hitTestBoard(indices, boardToScreen(board, view, WIDTH, HEIGHT), view, WIDTH, HEIGHT, options);

    it(`does not select a triangle for a click inside its bounding box but outside the polygon (${side}, ${rotation} deg)`, () => {
      expect(click({ x: 75, y: 75 })).toBeNull();
      expect(click({ x: 60, y: 60 })).toBeNull(); // clearly beyond the hypotenuse x + y = 100 but inside the bounds
    });

    it(`selects the triangle inside its polygon and not outside its bounds (${side}, ${rotation} deg)`, () => {
      expect(click({ x: 30, y: 30 })?.component.id).toBe('U1');
      expect(click({ x: 22, y: 22 })?.component.id).toBe('U1');
      expect(click({ x: 93, y: 93 })).toBeNull();
      expect(click({ x: 10, y: 10 })).toBeNull();
    });

    it(`keeps a bounded pixel tolerance at the polygon edge (${side}, ${rotation} deg)`, () => {
      const normal = { x: Math.SQRT1_2, y: Math.SQRT1_2 }; // outward normal of the hypotenuse
      const onEdge = { x: 50, y: 50 };
      const at = (pixels: number) => ({ x: onEdge.x + normal.x * pixels / view.scale, y: onEdge.y + normal.y * pixels / view.scale });
      expect(click(at(1))?.component.id).toBe('U1');
      expect(click(at(COMPONENT_EDGE_TOLERANCE_PX - 0.1))?.component.id).toBe('U1');
      expect(click(at(COMPONENT_EDGE_TOLERANCE_PX + 1))).toBeNull();
      expect(click(at(8))).toBeNull();
    });
  }

  it('respects a concave outline: the notch of an L shaped part is not part of it', () => {
    const l = component('L1', [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 40 }, { x: 0, y: 40 }], 'top');
    expect(pickComponent([l], { x: 25, y: 25 }, 6.8)).toBeUndefined(); // inside the AABB, in the notch
    expect(pickComponent([l], { x: 5, y: 25 }, 6.8)?.id).toBe('L1');
    expect(pickComponent([l], { x: 25, y: 5 }, 6.8)?.id).toBe('L1');
  });

  it('falls back to the bounding box (plus the pixel tolerance) only when there is no usable outline', () => {
    const bounds = { minX: 10, minY: 10, maxX: 20, maxY: 14 };
    for (const outline of [[], [{ x: 10, y: 10 }, { x: 20, y: 10 }]] as Point2[][]) {
      const bare = component('J1', outline, 'top', { bounds });
      expect(pickComponent([bare], { x: 15, y: 12 }, 6.8)?.id).toBe('J1');
      expect(pickComponent([bare], { x: 20 + 1.5 / 6.8, y: 12 }, 6.8)?.id).toBe('J1');
      expect(pickComponent([bare], { x: 20 + 3 / 6.8, y: 12 }, 6.8)).toBeUndefined();
    }
  });

  it('still prefers the smallest part among several hits, and a part sitting in the empty corner of a larger bounding box', () => {
    const big = triangle('top');
    const small = component('R1', [{ x: 74, y: 74 }, { x: 76, y: 74 }, { x: 76, y: 76 }, { x: 74, y: 76 }], 'top');
    const inner = component('C1', [{ x: 28, y: 28 }, { x: 32, y: 28 }, { x: 32, y: 32 }, { x: 28, y: 32 }], 'top');
    const view = viewOf('top', 0);
    const indices = indicesOf([big, small, inner], []);
    const hit = (p: Point2) => hitTestBoard(indices, boardToScreen(p, view, WIDTH, HEIGHT), view, WIDTH, HEIGHT, { selectedComponentId: null })?.component.id;
    expect(hit({ x: 75, y: 75 })).toBe('R1'); // only R1 is there, U1's polygon is not
    expect(hit({ x: 30, y: 30 })).toBe('C1'); // inside C1 and U1: the smaller bounds win
    expect(hit({ x: 40, y: 40 })).toBe('U1');
    expect(hit({ x: 65, y: 65 })).toBeUndefined();
  });
});

describe('B23 a pad containing the pointer wins over a nearer-centred small pad', () => {
  const local = (centre: Point2, rotationDeg: number, offset: Point2): Point2 => {
    const a = rotationDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: centre.x + offset.x * c - offset.y * s, y: centre.y + offset.x * s + offset.y * c };
  };

  for (const side of sides) for (const view of rotations.map(rotation => viewOf(side, rotation))) for (const padRotation of [0, 90, 45, 270]) {
    it(`selects the 4x2 mm pad that contains the pointer (${side}, view ${view.rotation} deg, pad ${padRotation} deg)`, () => {
      const centre = { x: 50, y: 30 };
      const big = pad('P-big', 'U1', centre.x, centre.y, side, { shape: 'rect', width: 4, height: 2, radius: 1, rotation: padRotation });
      const smallCentre = local(centre, padRotation, { x: 1.85, y: 1.5 });
      const small = pad('P-small', 'U1', smallCentre.x, smallCentre.y, side, { radius: 0.2 });
      const owner = component('U1', [{ x: 40, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 40 }, { x: 40, y: 40 }], side);
      const indices = indicesOf([owner], [big, small]);
      const click = local(centre, padRotation, { x: 1.85, y: 0.8 }); // inside the big pad (edge distance 0), 0.5 mm outside the small one
      const target = hitTestBoard(indices, boardToScreen(click, view, WIDTH, HEIGHT), view, WIDTH, HEIGHT, { selectedComponentId: null });
      expect(target?.pin?.id).toBe('P-big');
      expect(target?.component.id).toBe('U1');
      // controls: inside the small pad selects it; the centre of the big pad selects the big pad
      const onSmall = hitTestBoard(indices, boardToScreen(smallCentre, view, WIDTH, HEIGHT), view, WIDTH, HEIGHT, { selectedComponentId: null });
      expect(onSmall?.pin?.id).toBe('P-small');
      const onBig = hitTestBoard(indices, boardToScreen(centre, view, WIDTH, HEIGHT), view, WIDTH, HEIGHT, { selectedComponentId: null });
      expect(onBig?.pin?.id).toBe('P-big');
    });
  }

  it('ranks by physical edge distance when no pad contains the pointer, whatever the centre distances are', () => {
    const big = pad('P-big', 'U1', 50, 30, 'top', { shape: 'rect', width: 4, height: 2, radius: 1 });
    const small = pad('P-small', 'U1', 52.3, 30.7, 'top', { radius: 0.2 });
    const click = { x: 52.3, y: 30 }; // big: edge 0.3 mm, centre 2.3 mm; small: edge 0.5 mm, centre 0.7 mm; tolerance 5.5 px / 6.8 = 0.81 mm
    expect(pickPad([small, big], click, 6.8, null)?.id).toBe('P-big');
    expect(pickPad([big, small], click, 6.8, null)?.id).toBe('P-big');
  });

  it('breaks a tie by centre distance (two containing pads, equal edge distance 0)', () => {
    const a = pad('P-a', 'U1', 50, 30, 'top', { shape: 'rect', width: 4, height: 2, radius: 1 });
    const b = pad('P-b', 'U1', 51, 30, 'top', { shape: 'rect', width: 4, height: 2, radius: 1 });
    expect(pickPad([a, b], { x: 50.8, y: 30 }, 6.8, null)?.id).toBe('P-b');
    expect(pickPad([b, a], { x: 50.2, y: 30 }, 6.8, null)?.id).toBe('P-a');
  });

  it('keeps the screen-size tolerance for unknown-size (zero radius) and tiny pads', () => {
    const marker = pad('P-marker', 'U1', 50, 30, 'top', { radius: 0 });
    expect(pickPad([marker], { x: 50 + 5 / 6.8, y: 30 }, 6.8, null)?.id).toBe('P-marker');
    expect(pickPad([marker], { x: 50 + 6 / 6.8, y: 30 }, 6.8, null)).toBeUndefined();
    expect(pickPad([marker], { x: 50 + 5 / 20, y: 30 }, 20, null)?.id).toBe('P-marker');
    expect(pickPad([marker], { x: 50 + 6 / 20, y: 30 }, 20, null)).toBeUndefined();
  });

  it('only picks the pads of the selected component below the pad pick zoom (unchanged)', () => {
    const other = pad('P-other', 'U2', 50, 30, 'top', { radius: 0.5 });
    const mine = pad('P-mine', 'U1', 50.5, 30, 'top', { radius: 0.2 });
    expect(pickPad([other, mine], { x: 50, y: 30 }, 5, 'U1')?.id).toBe('P-mine');
    expect(pickPad([other, mine], { x: 50, y: 30 }, 5, null)).toBeUndefined();
    expect(pickPad([other, mine], { x: 50, y: 30 }, 6, null)?.id).toBe('P-other');
  });

  it('falls back to the component when the pad owner is unknown or no pad is hit', () => {
    const owner = component('U1', [{ x: 40, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 40 }, { x: 40, y: 40 }], 'top');
    const orphan = pad('P-orphan', 'GONE', 50, 30, 'top');
    const indices = indicesOf([owner], [orphan]);
    const view = viewOf('top', 0);
    expect(hitTestBoard(indices, boardToScreen({ x: 50, y: 30 }, view, WIDTH, HEIGHT), view, WIDTH, HEIGHT, { selectedComponentId: null })).toEqual({ component: owner });
    expect(hitTestBoard(indices, boardToScreen({ x: 45, y: 25 }, view, WIDTH, HEIGHT), view, WIDTH, HEIGHT, { selectedComponentId: null })).toEqual({ component: owner });
    expect(hitTestBoard(indices, boardToScreen({ x: 70, y: 70 }, view, WIDTH, HEIGHT), view, WIDTH, HEIGHT, { selectedComponentId: null })).toBeNull();
  });
});
