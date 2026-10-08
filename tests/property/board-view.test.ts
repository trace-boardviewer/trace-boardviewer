import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { boardToScreen, boundsFromPoints, distance, fitView, intersects, padBounds, padHitDistance, pointInPolygon, pointToSegmentDistance, screenToBoard, SpatialIndex } from '../../src/lib/geometry';
import type { Bounds2, Point2, ViewTransform } from '../../src/lib/geometry';
import type { BoardComponent, BoardPin } from '../../src/lib/types';
import {
  cameraToView, MAX_BOARD_ZOOM, MIN_BOARD_ZOOM, normalizeRotation, parseBoardCamera, sameCamera, viewShowsBoard, viewToCamera,
} from '../../src/components/board-camera';
import type { BoardCamera } from '../../src/components/board-camera';
import {
  COMPONENT_EDGE_TOLERANCE_PX, componentContainsPoint, DEFAULT_PIN_TOLERANCE_PX, hitTestBoard, PAD_PICK_MIN_SCALE, pickComponent, pickPad,
} from '../../src/components/board-hit-test';
import { bounds, coordinate, params, point, real, rotation, shuffled, shuffleKeys, view, viewport } from './support';

const magnitudeOf = (...values: number[]) => Math.max(1, ...values.map(Math.abs));

// ---------------------------------------------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------------------------------------------

describe('board camera', () => {
  const camera: fc.Arbitrary<BoardCamera> = fc.record({ zoom: real(MIN_BOARD_ZOOM, MAX_BOARD_ZOOM), x: coordinate(1e6), y: coordinate(1e6), rotation: real(0, 359.999).map(normalizeRotation), side: fc.constantFrom('top' as const, 'bottom' as const) });

  it('normalizeRotation lands in [0, 360), keeps the angle modulo a full turn and is idempotent', () => {
    fc.assert(fc.property(fc.oneof(real(-1e7, 1e7), fc.integer({ min: -100000, max: 100000 })), degrees => {
      const turned = normalizeRotation(degrees);
      expect(turned).toBeGreaterThanOrEqual(0); expect(turned).toBeLessThan(360);
      // Whole degrees (what the rotate command produces) are fixed points. For other angles the second pass may differ by a rounding error:
      // a negative angle gets 360 added in the first pass, and that sum is rounded to a coarser grid in the second (about 1e-13 degrees).
      if (Number.isInteger(degrees)) expect(normalizeRotation(turned)).toBe(turned);
      expect(Math.abs(normalizeRotation(turned) - turned)).toBeLessThan(1e-9);
      const diff = (degrees - turned) / 360;
      expect(Math.abs(diff - Math.round(diff))).toBeLessThanOrEqual(1e-6 * magnitudeOf(diff) + 1e-9);
    }), params(300));
  });

  /** The documented contract of the validator, restated: finite numbers, zoom within the clamp, |x| and |y| within a million millimetres, an optional finite rotation and an optional side. */
  const acceptable = (raw: unknown): boolean => {
    if (!raw || typeof raw !== 'object') return false;
    const c = raw as Record<string, unknown>;
    const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    return finite(c.zoom) && finite(c.x) && finite(c.y) && c.zoom >= 0.1 && c.zoom <= 1000 && Math.abs(c.x) <= 1e6 && Math.abs(c.y) <= 1e6
      && (c.rotation === undefined || finite(c.rotation)) && (c.side === undefined || c.side === 'top' || c.side === 'bottom');
  };
  const nearValid = fc.record({
    zoom: fc.oneof(real(0.01, 3000), fc.constantFrom(0.1, 0.0999999, 1000, 1000.0001, 0, -1, NaN, Infinity, '1', null)),
    x: fc.oneof(real(-1.2e6, 1.2e6), fc.constantFrom(1e6, -1e6, 1e6 + 1, NaN, 0, '0')),
    y: fc.oneof(real(-1.2e6, 1.2e6), fc.constantFrom(1e6, -1e6, -1e6 - 1, Infinity, 0)),
    rotation: fc.oneof(real(-1e4, 1e4), fc.constantFrom(undefined, 0, 360, -360, NaN, Infinity, '90', null)),
    side: fc.constantFrom('top', 'bottom', undefined, 'both', '', 3, null),
  }, { requiredKeys: ['zoom', 'x', 'y'] });

  it('parseBoardCamera never throws, accepts exactly what the viewer can show and returns it normalized', () => {
    fc.assert(fc.property(fc.oneof({ weight: 1, arbitrary: fc.anything() }, { weight: 6, arbitrary: nearValid }), raw => {
      const parsed = parseBoardCamera(raw);
      expect(parsed !== null).toBe(acceptable(raw));
      if (parsed === null) return;
      expect(parsed.zoom).toBeGreaterThanOrEqual(MIN_BOARD_ZOOM); expect(parsed.zoom).toBeLessThanOrEqual(MAX_BOARD_ZOOM);
      expect(parsed.rotation).toBeGreaterThanOrEqual(0); expect(parsed.rotation).toBeLessThan(360);
      expect(['top', 'bottom']).toContain(parsed.side);
      // Parsing what was parsed changes nothing, except that the rotation may move by a rounding error: normalizeRotation adds 360 to a negative
      // angle, and that sum is rounded to a coarser grid the second time (about 1e-13 degrees, never visible).
      const again = parseBoardCamera(parsed);
      expect(again).not.toBeNull();
      expect({ ...again, rotation: 0 }).toEqual({ ...parsed, rotation: 0 });
      expect(Math.abs((again as BoardCamera).rotation - parsed.rotation)).toBeLessThan(1e-9);
    }), params(600));
  });

  it('a normalized camera parses to itself, survives JSON, and view <-> camera conversion is stable', () => {
    fc.assert(fc.property(camera, c => {
      expect(parseBoardCamera(c)).toEqual(c);
      expect(parseBoardCamera(JSON.parse(JSON.stringify(c)))).toEqual(c);
      const v = cameraToView(c);
      expect(v.mirrored).toBe(c.side === 'bottom');
      expect(v.center).toEqual({ x: c.x, y: c.y });
      expect(v.scale).toBe(c.zoom);
      // Rounding happens once: converting what the view reports again changes nothing.
      const stored = viewToCamera(v);
      expect(viewToCamera(cameraToView(stored))).toEqual(stored);
      expect(sameCamera(stored, viewToCamera(cameraToView(stored)))).toBe(true);
    }), params(300));
  });

  it('viewToCamera gives a camera the parser accepts, whichever view the canvas holds (zoom within its clamp)', () => {
    fc.assert(fc.property(view(1e5), v => {
      const stored = viewToCamera(v);
      const parsed = parseBoardCamera(stored);
      expect(parsed).not.toBeNull();
      expect({ ...parsed, rotation: 0 }).toEqual({ ...stored, rotation: 0 });
      expect(Math.abs((parsed as BoardCamera).rotation - stored.rotation)).toBeLessThan(1e-9);
      expect(stored.side).toBe(v.mirrored ? 'bottom' : 'top');
    }), params(300));
  });

  it('sameCamera is an equivalence on cameras and treats null like itself only', () => {
    fc.assert(fc.property(camera, camera, (a, b) => {
      expect(sameCamera(a, a)).toBe(true);
      expect(sameCamera(a, b)).toBe(sameCamera(b, a));
      expect(sameCamera(a, null)).toBe(false); expect(sameCamera(null, a)).toBe(false); expect(sameCamera(null, null)).toBe(true);
      expect(sameCamera(a, { ...a })).toBe(true);
    }), params(150));
  });

  it('a fitted view always shows the board, and a view moved a whole board away from it does not', () => {
    fc.assert(fc.property(bounds(1e4, 1e4), viewport, rotation, fc.boolean(), (b, size, degrees, mirrored) => {
      const fitted = fitView(b, size.width, size.height, degrees, mirrored);
      expect(viewShowsBoard(fitted, b, size.width, size.height)).toBe(true);
      const reach = Math.hypot(size.width, size.height) / fitted.scale + Math.hypot(b.maxX - b.minX, b.maxY - b.minY) + 1;
      const away: ViewTransform = { ...fitted, center: { x: b.maxX + 2 * reach, y: b.maxY + 2 * reach } };
      expect(viewShowsBoard(away, b, size.width, size.height)).toBe(false);
    }), params(200));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Hit test
// ---------------------------------------------------------------------------------------------------------------

interface Scene { components: BoardComponent[]; pins: BoardPin[] }

const pinArb = fc.record({
  at: point(6), shape: fc.constantFrom('round' as const, 'rect' as const, 'square' as const), radius: fc.oneof(real(0, 1.2), fc.constant(0)),
  width: fc.option(real(0.05, 3), { nil: undefined }), height: fc.option(real(0.05, 3), { nil: undefined }), rotation: fc.option(rotation, { nil: undefined }), owner: fc.integer({ min: 0, max: 3 }),
});
const componentArb = fc.record({ centre: point(6), half: fc.record({ w: real(0.2, 4), h: real(0.2, 4) }), sides: fc.integer({ min: 0, max: 7 }), turn: rotation, side: fc.constantFrom('top' as const, 'bottom' as const) });

/** A small board: up to 4 parts (rectangle or polygon outlines, some without a usable outline) and a few pads around them. */
const scene: fc.Arbitrary<Scene> = fc.record({ parts: fc.array(componentArb, { minLength: 1, maxLength: 4 }), pads: fc.array(pinArb, { maxLength: 10 }) }).map(({ parts, pads }) => {
  const components: BoardComponent[] = parts.map((p, i) => {
    let outline: Point2[];
    if (p.sides < 3) outline = p.sides === 0 ? [] : [{ x: p.centre.x, y: p.centre.y }, { x: p.centre.x + p.half.w, y: p.centre.y }]; // no usable outline: the bounds stand in
    else outline = Array.from({ length: p.sides }, (_, k) => ({ x: p.centre.x + p.half.w * Math.cos(p.turn * Math.PI / 180 + k * 2 * Math.PI / p.sides), y: p.centre.y + p.half.h * Math.sin(p.turn * Math.PI / 180 + k * 2 * Math.PI / p.sides) }));
    const box = outline.length >= 3 ? boundsFromPoints(outline) : { minX: p.centre.x - p.half.w, maxX: p.centre.x + p.half.w, minY: p.centre.y - p.half.h, maxY: p.centre.y + p.half.h };
    return { id: `c${i}`, ref: `U${i}`, value: '', package: '', side: p.side, bounds: box, position: p.centre, rotation: 0, pinIds: [], outline };
  });
  const pins: BoardPin[] = pads.map((p, i) => ({ id: `p${i}`, componentId: `c${p.owner % components.length}`, number: String(i), name: '', net: '', side: 'top', x: p.at.x, y: p.at.y, radius: p.radius, shape: p.shape, width: p.width, height: p.height, rotation: p.rotation }));
  for (const pin of pins) { if (pin.width === undefined) delete pin.width; if (pin.height === undefined) delete pin.height; if (pin.rotation === undefined) delete pin.rotation; }
  return { components, pins };
});

/** The pointer: on or near a pad or a part with decent probability, so that hits are common. */
function pointerNear(s: Scene, pick: number, dx: number, dy: number, reach: number): Point2 {
  const pins = s.pins;
  if (pins.length && pick % 3 !== 2) { const p = pins[pick % pins.length]; return { x: p.x + dx * (Math.max(p.radius, p.width ?? 0, p.height ?? 0) + reach), y: p.y + dy * (Math.max(p.radius, p.width ?? 0, p.height ?? 0) + reach) }; }
  const c = s.components[pick % s.components.length];
  return { x: c.position.x + dx * (c.bounds.maxX - c.bounds.minX + reach), y: c.position.y + dy * (c.bounds.maxY - c.bounds.minY + reach) };
}
const pointer = fc.record({ pick: fc.integer({ min: 0, max: 1000 }), dx: real(-1.3, 1.3), dy: real(-1.3, 1.3), reach: real(0, 0.3) });
const zoom = fc.oneof(real(0.1, 1000), fc.constantFrom(0.1, 1, PAD_PICK_MIN_SCALE - 1e-9, PAD_PICK_MIN_SCALE, 12, 40));
const tolerance = fc.oneof(fc.constant(DEFAULT_PIN_TOLERANCE_PX), real(2, 20));
const selectedOf = (s: Scene, pick: number) => (pick % 4 === 0 ? null : s.components[pick % s.components.length].id);

describe('pickPad', () => {
  it('never returns a pad farther than the tolerance, ranks containing pads first, then the nearer edge, then the nearer centre', () => {
    fc.assert(fc.property(scene, pointer, zoom, tolerance, fc.integer({ min: 0, max: 20 }), (s, ptr, scale, tolerancePx, selectedPick) => {
      const p = pointerNear(s, ptr.pick, ptr.dx, ptr.dy, ptr.reach);
      const selected = selectedOf(s, selectedPick);
      const picked = pickPad(s.pins, p, scale, selected, tolerancePx);
      const eligible = s.pins.filter(pin => scale >= PAD_PICK_MIN_SCALE || pin.componentId === selected);
      const within = eligible.filter(pin => padHitDistance(p, pin) <= tolerancePx / scale);
      if (!picked) { expect(within).toHaveLength(0); return; }
      expect(s.pins).toContain(picked);
      expect(scale >= PAD_PICK_MIN_SCALE || picked.componentId === selected).toBe(true);
      const edge = padHitDistance(p, picked);
      expect(edge).toBeLessThanOrEqual(tolerancePx / scale);
      // A containing pad beats any pad that does not contain the pointer.
      if (within.some(pin => padHitDistance(p, pin) === 0)) expect(edge).toBe(0);
      // Nothing eligible and within tolerance ranks ahead of the pick (edge distance, then centre distance).
      for (const other of within) {
        const e = padHitDistance(p, other);
        expect(e > edge || (e === edge && distance(p, other) >= distance(p, picked))).toBe(true);
      }
    }), params(400));
  });

  it('does not depend on the order of the candidates (up to exact ties)', () => {
    fc.assert(fc.property(scene, pointer, zoom, shuffleKeys, (s, ptr, scale, keys) => {
      const p = pointerNear(s, ptr.pick, ptr.dx, ptr.dy, ptr.reach);
      const a = pickPad(s.pins, p, scale, null), b = pickPad(shuffled(s.pins, keys), p, scale, null);
      expect(a === undefined).toBe(b === undefined);
      if (a && b) {
        expect(padHitDistance(p, a)).toBe(padHitDistance(p, b));
        expect(distance(p, a)).toBe(distance(p, b));
      }
    }), params(200));
  });

  it('below the pick zoom only the selected part\'s pads can be picked, from that zoom on all of them', () => {
    fc.assert(fc.property(scene, pointer, (s, ptr) => {
      const p = pointerNear(s, ptr.pick, ptr.dx, ptr.dy, ptr.reach);
      const low = pickPad(s.pins, p, PAD_PICK_MIN_SCALE - 0.5, null);
      expect(low).toBeUndefined();
      const only = s.components[0].id;
      const some = pickPad(s.pins, p, PAD_PICK_MIN_SCALE - 0.5, only);
      if (some) expect(some.componentId).toBe(only);
    }), params(150));
  });
});

describe('component hits', () => {
  it('componentContainsPoint: inside the real outline is a hit, farther than the edge tolerance outside is not, and the bounds only stand in for a missing outline', () => {
    fc.assert(fc.property(scene, pointer, zoom, (s, ptr, scale) => {
      const p = pointerNear(s, ptr.pick, ptr.dx, ptr.dy, ptr.reach);
      for (const c of s.components) {
        const hit = componentContainsPoint(c, p, scale);
        const tol = COMPONENT_EDGE_TOLERANCE_PX / scale;
        if (c.outline.length < 3) {
          const inflated = { minX: c.bounds.minX - tol, maxX: c.bounds.maxX + tol, minY: c.bounds.minY - tol, maxY: c.bounds.maxY + tol };
          expect(hit).toBe(p.x >= inflated.minX && p.x <= inflated.maxX && p.y >= inflated.minY && p.y <= inflated.maxY);
          continue;
        }
        let edge = Infinity;
        for (let i = 0, j = c.outline.length - 1; i < c.outline.length; j = i++) edge = Math.min(edge, pointToSegmentDistance(p, c.outline[j], c.outline[i]));
        const slack = 1e-9 * magnitudeOf(p.x, p.y);
        if (edge > tol + slack) expect(hit).toBe(pointInPolygon(p, c.outline));
        if (edge < tol - slack) expect(hit).toBe(true);
      }
    }), params(300));
  });

  it('pickComponent returns a containing part of the smallest area, and nothing when no part contains the pointer', () => {
    fc.assert(fc.property(scene, pointer, zoom, (s, ptr, scale) => {
      const p = pointerNear(s, ptr.pick, ptr.dx, ptr.dy, ptr.reach);
      const picked = pickComponent(s.components, p, scale);
      const hits = s.components.filter(c => componentContainsPoint(c, p, scale));
      expect(picked === undefined).toBe(hits.length === 0);
      if (!picked) return;
      const area = (c: BoardComponent) => Math.max(0.05, c.bounds.maxX - c.bounds.minX) * Math.max(0.05, c.bounds.maxY - c.bounds.minY);
      expect(hits).toContain(picked);
      for (const other of hits) expect(area(other)).toBeGreaterThanOrEqual(area(picked));
    }), params(300));
  });
});

describe('hitTestBoard', () => {
  /** The broad phase of BoardCanvas (components by bounds, pads by padBounds(pin, 0.06)), once as the real grid and once as a plain scan. */
  function indices(s: Scene, grid: boolean) {
    const byId = new Map(s.components.map(c => [c.id, c]));
    if (grid) {
      const pins = new SpatialIndex<BoardPin>(8), components = new SpatialIndex<BoardComponent>(8);
      for (const c of s.components) components.add(c, c.bounds);
      for (const pin of s.pins) pins.add(pin, padBounds(pin, 0.06));
      return { pins, components, componentsById: byId };
    }
    return { pins: { query: (b: Bounds2) => s.pins.filter(pin => intersects(padBounds(pin, 0.06), b)) }, components: { query: (b: Bounds2) => s.components.filter(c => intersects(c.bounds, b)) }, componentsById: byId };
  }

  it('is the pad pick over ALL pads, then the component pick over ALL parts, whatever the broad phase (pad first, no hit lost)', () => {
    fc.assert(fc.property(scene, pointer, view(60), viewport, fc.constantFrom(true, false), fc.integer({ min: 0, max: 9 }), fc.constantFrom(DEFAULT_PIN_TOLERANCE_PX, 2, 9), (s, ptr, v, size, grid, selectedPick, tolPx) => {
      const view2: ViewTransform = { ...v, scale: Math.max(v.scale, 0.1) };
      const board = pointerNear(s, ptr.pick, ptr.dx, ptr.dy, ptr.reach);
      const screen = boardToScreen(board, view2, size.width, size.height);
      fc.pre(Number.isFinite(screen.x) && Number.isFinite(screen.y));
      const at = screenToBoard(screen, view2, size.width, size.height);
      const selected = selectedOf(s, selectedPick);
      const target = hitTestBoard(indices(s, grid), screen, view2, size.width, size.height, { selectedComponentId: selected, pinTolerance: tolPx });
      const padPick = pickPad(s.pins, at, view2.scale, selected, tolPx);
      const owner = padPick ? s.components.find(c => c.id === padPick.componentId) : undefined;
      if (padPick && owner) { expect(target).toEqual({ component: owner, pin: padPick }); return; }
      const componentPick = pickComponent(s.components, at, view2.scale);
      expect(target).toEqual(componentPick ? { component: componentPick } : null);
    }), params(300));
  });

  it('prefers a pad that contains the pointer over a nearer-centred pad that does not', () => {
    fc.assert(fc.property(point(100), real(1, 5), real(0.05, 0.5), real(0.6, 0.95), rotation, (c, big, small, offsetFraction, turn) => {
      // A large pad around c and a small one inside it but with its centre closer to the pointer than the large pad's centre is.
      const pointerAt = { x: c.x + big * offsetFraction, y: c.y };
      const pads: BoardPin[] = [
        { id: 'small', componentId: 'a', number: '2', name: '', net: '', side: 'top', x: pointerAt.x + small * 1.5, y: pointerAt.y, radius: small, shape: 'round' },
        { id: 'big', componentId: 'a', number: '1', name: '', net: '', side: 'top', x: c.x, y: c.y, radius: big, shape: 'round', rotation: turn },
      ];
      expect(padHitDistance(pointerAt, pads[1])).toBe(0);
      expect(pickPad(pads, pointerAt, 20, 'a')?.id).toBe('big');
      expect(pickPad([pads[1], pads[0]], pointerAt, 20, 'a')?.id).toBe('big');
    }), params(150));
  });
});
