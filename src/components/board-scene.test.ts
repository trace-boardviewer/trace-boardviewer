import { boardIndexOf } from '../lib/board-index';
import { describe, expect, it } from 'vitest';
import { boundsCorners, boundsFromPoints, padBounds, SpatialIndex } from '../lib/geometry';
import type { Bounds2, Point2 } from '../lib/geometry';
import { canvasGroup, classifyComponent } from '../lib/part-kind';
import type { Board, BoardComponent, BoardPin, BoardSide } from '../lib/types';
import { buildBoardScene, computePartFlags, onSide, PART_FLAG, partDisplayFlags, sideSelection, SMALL_PART_MM } from './board-scene';

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function part(id: string, ref: string, side: BoardSide, bounds: Bounds2, extra: Partial<BoardComponent> = {}): BoardComponent {
  return {
    id, ref, value: '', package: '', side, bounds, position: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }, rotation: 0,
    pinIds: [], outline: boundsCorners(bounds), ...extra,
  };
}
function pad(id: string, componentId: string, net: string, side: BoardSide, at: Point2, extra: Partial<BoardPin> = {}): BoardPin {
  return { id, componentId, number: id, name: id, net, side, x: at.x, y: at.y, radius: 0.3, shape: 'round', ...extra };
}
function boardOf(components: BoardComponent[], pins: BoardPin[], outline: Point2[] = []): Board {
  for (const component of components) component.pinIds = pins.filter(pin => pin.componentId === component.id).map(pin => pin.id);
  const points = [...components.flatMap(component => boundsCorners(component.bounds)), ...pins];
  return { name: 'test', format: 'test', units: 'mm', components, pins, nets: [], outline, bounds: boundsFromPoints(points), warnings: [] };
}

/** A small board with every case: both-sided parts and pads, three kinds, unconnected and ground pads, a part without pads. */
function sampleBoard(): Board {
  const components = [
    part('c1', 'U1', 'top', { minX: 0, minY: 0, maxX: 10, maxY: 8 }),
    part('c2', 'R1', 'top', { minX: 12, minY: 0, maxX: 13, maxY: 0.5 }),
    part('c3', 'J1', 'bottom', { minX: 20, minY: 20, maxX: 30, maxY: 24 }),
    part('c4', 'TP1', 'both', { minX: 40, minY: 40, maxX: 40.8, maxY: 40.8 }),
    part('c5', 'MH1', 'top', { minX: 50, minY: 0, maxX: 53, maxY: 3 }, { package: 'MOUNTINGHOLE' }),
    part('c6', 'C1', 'bottom', { minX: 60, minY: 0, maxX: 61, maxY: 0.5 }),
  ];
  const pins = [
    pad('p1', 'c1', 'GND', 'top', { x: 1, y: 1 }),
    pad('p2', 'c1', 'VCC', 'top', { x: 9, y: 1 }),
    pad('p3', 'c1', '', 'top', { x: 9, y: 7 }),
    pad('p4', 'c2', 'GND', 'top', { x: 12.2, y: 0.25 }),
    pad('p5', 'c2', 'GND', 'top', { x: 12.8, y: 0.25 }),
    pad('p6', 'c3', 'VCC', 'bottom', { x: 21, y: 22 }),
    pad('p7', 'c3', 'NC', 'bottom', { x: 29, y: 22 }),
    pad('p8', 'c4', 'VCC', 'both', { x: 40.4, y: 40.4 }),
    pad('p9', 'c6', '', 'bottom', { x: 60.2, y: 0.25 }),
    pad('p10', 'c6', 'N/C', 'bottom', { x: 60.8, y: 0.25 }),
  ];
  return boardOf(components, pins);
}

/** A random board: parts and pads in random places and sizes on random sides, with a few nets. */
function randomBoard(seed: number, parts = 300): Board {
  const random = mulberry32(seed);
  const sides: BoardSide[] = ['top', 'top', 'bottom', 'both'];
  const refs = ['U', 'R', 'C', 'J', 'L', 'Q', 'TP', 'FB'];
  const components: BoardComponent[] = [];
  const pins: BoardPin[] = [];
  for (let i = 0; i < parts; i++) {
    const x = random() * 300, y = random() * 200, w = 0.2 + random() * (random() < 0.1 ? 60 : 4), h = 0.2 + random() * 4;
    const side = sides[Math.floor(random() * sides.length)];
    components.push(part(`c${i}`, `${refs[i % refs.length]}${i}`, side, { minX: x, minY: y, maxX: x + w, maxY: y + h }));
    const count = 1 + Math.floor(random() * 6);
    for (let k = 0; k < count; k++) {
      pins.push(pad(`c${i}p${k}`, `c${i}`, ['GND', 'VCC', `N${i % 17}`, ''][Math.floor(random() * 4)], side, { x: x + random() * w, y: y + random() * h }, { radius: random() < 0.2 ? 0 : 0.1 + random() }));
    }
  }
  return boardOf(components, pins);
}

describe('board scene: what the canvas builds once per board', () => {
  it('reuses shared id maps, kinds and side buckets without opening the search layer', () => {
    const board = sampleBoard();
    const shared = boardIndexOf(board);
    const kinds = new Map(shared.kinds);
    const index = Object.create(shared) as typeof shared;
    Object.defineProperty(index, 'kinds', { value: kinds });
    for (const key of ['components', 'byRef', 'nets', 'search']) {
      Object.defineProperty(index, key, { get() { throw new Error('Search layer accessed'); } });
    }
    kinds.set('c1', 'connector');
    kinds.delete('c2');
    const scene = buildBoardScene(board, index);
    expect(scene.componentsById).toBe(shared.componentById);
    expect(scene.pinsById).toBe(shared.pinById);
    for (const side of ['top', 'bottom'] as const) {
      expect(scene.sides[side].pinList).toBe(shared.sides[side].pins);
      expect(scene.sides[side].nets).toBe(shared.sides[side].netPins);
    }
    expect(scene.partsById.get('c1')?.group).toBe('connector');
    expect(scene.partsById.get('c2')?.group).toBe(canvasGroup('part'));
    expect(buildBoardScene(board).pinsById).toBe(shared.pinById);
  });
  it('indexes every part and pad on the sides it shows on (a part or pad on both sides is on both)', () => {
    const scene = buildBoardScene(sampleBoard());
    const everything = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 };
    const refs = (side: 'top' | 'bottom') => scene.sides[side].parts.query(everything).map(entry => entry.component.ref);
    expect(refs('top')).toEqual(['U1', 'R1', 'TP1', 'MH1']);
    expect(refs('bottom')).toEqual(['J1', 'TP1', 'C1']);
    expect(scene.sides.top.pinList.map(pin => pin.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p8']);
    expect(scene.sides.bottom.pinList.map(pin => pin.id)).toEqual(['p6', 'p7', 'p8', 'p9', 'p10']);
    expect(scene.sides.bottom.components.query(everything).map(component => component.id)).toEqual(['c3', 'c4', 'c6']);
    for (const side of ['top', 'bottom'] as const) {
      for (const pin of scene.sides[side].pinList) expect(onSide(pin, side)).toBe(true);
    }
  });

  it('groups the pads of each net per side, with the parts they belong to (the unconnected net "" too)', () => {
    const scene = buildBoardScene(sampleBoard());
    const group = (side: 'top' | 'bottom', net: string) => {
      const value = scene.sides[side].nets.get(net);
      return value && { pins: value.pins.map(pin => pin.id), components: [...value.components] };
    };
    expect(group('top', 'GND')).toEqual({ pins: ['p1', 'p4', 'p5'], components: ['c1', 'c2'] });
    expect(group('top', 'VCC')).toEqual({ pins: ['p2', 'p8'], components: ['c1', 'c4'] });
    expect(group('bottom', 'VCC')).toEqual({ pins: ['p6', 'p8'], components: ['c3', 'c4'] });
    expect(group('top', '')).toEqual({ pins: ['p3'], components: ['c1'] });
    expect(group('bottom', 'GND')).toBeUndefined();
  });

  it('takes the part kind from the shared classifier and keeps the derived sizes and the label anchor', () => {
    const board = sampleBoard();
    const scene = buildBoardScene(board);
    expect(scene.parts.map(entry => entry.index)).toEqual(board.components.map((_, index) => index));
    for (const entry of scene.parts) {
      const kind = classifyComponent(entry.component).kind;
      expect(entry.kind).toBe(kind);
      expect(entry.group).toBe(canvasGroup(kind));
      const b = entry.component.bounds;
      expect([entry.width, entry.height, entry.extent]).toEqual([b.maxX - b.minX, b.maxY - b.minY, Math.max(b.maxX - b.minX, b.maxY - b.minY)]);
      expect(entry.center).toEqual({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
      expect(scene.partsById.get(entry.component.id)).toBe(entry);
      expect(scene.componentsById.get(entry.component.id)).toBe(entry.component);
    }
    expect(scene.parts.map(entry => entry.group)).toEqual(['chip', 'passive', 'connector', 'passive', 'passive', 'passive']);
    for (const pin of board.pins) expect(scene.pinsById.get(pin.id)).toBe(pin);
  });

  it('uses the board outline when it has three or more points, else the corners of the board bounds', () => {
    const board = sampleBoard();
    expect(buildBoardScene(board).outline).toEqual(boundsCorners(board.bounds));
    const outline = [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 50 }];
    expect(buildBoardScene({ ...board, outline }).outline).toBe(outline);
    expect(buildBoardScene({ ...board, outline: outline.slice(0, 2) }).outline).toEqual(boundsCorners(board.bounds));
  });

  it('answers every query in the order of the per-side indices the canvas built before the scene existed', () => {
    for (const seed of [1, 2, 3]) {
      const board = randomBoard(seed);
      const scene = buildBoardScene(board);
      // The canvas used to build these itself: components by bounds and pads by padBounds(pin, 0.06) in 8 mm cells, in board order.
      const legacy = {
        top: { components: new SpatialIndex<BoardComponent>(8), pins: new SpatialIndex<BoardPin>(8) },
        bottom: { components: new SpatialIndex<BoardComponent>(8), pins: new SpatialIndex<BoardPin>(8) },
      };
      for (const component of board.components) for (const side of ['top', 'bottom'] as const) if (onSide(component, side)) legacy[side].components.add(component, component.bounds);
      for (const pin of board.pins) for (const side of ['top', 'bottom'] as const) if (onSide(pin, side)) legacy[side].pins.add(pin, padBounds(pin, 0.06));
      const random = mulberry32(seed * 7);
      for (let i = 0; i < 200; i++) {
        const x = random() * 340 - 20, y = random() * 240 - 20, size = random() < 0.2 ? random() * 400 : random() * 30;
        const query = { minX: x, minY: y, maxX: x + size, maxY: y + size * (0.3 + random()) };
        for (const side of ['top', 'bottom'] as const) {
          expect(scene.sides[side].parts.query(query).map(entry => entry.component)).toEqual(legacy[side].components.query(query));
          expect(scene.sides[side].components.query(query)).toEqual(legacy[side].components.query(query));
          expect(scene.sides[side].pins.query(query)).toEqual(legacy[side].pins.query(query));
        }
      }
    }
  });
});

describe('board scene: the selection of one side', () => {
  const board = sampleBoard();
  const scene = buildBoardScene(board);
  const select = (side: 'top' | 'bottom', componentId: string | null, pinId: string | null, net: string | null) => sideSelection(scene, side, { componentId, pinId, net });

  it('highlights the pads and parts of the selected net on that side only', () => {
    const top = select('top', null, null, 'VCC');
    expect(top.pins.map(pin => pin.id)).toEqual(['p2', 'p8']);
    expect([...top.components]).toEqual(['c1', 'c4']);
    expect(select('bottom', null, null, 'GND').pins).toEqual([]);
    expect(select('top', 'c1', null, null)).toMatchObject({ pins: [], source: undefined });
    expect(select('top', 'c1', null, null).components.size).toBe(0);
  });

  it('starts the connection lines at the selected pad, else at the selected part, else at the first pad of the net', () => {
    expect(select('top', 'c1', 'p8', 'VCC').source?.id).toBe('p8'); // the selected pad, on the net and on this side
    expect(select('top', 'c4', 'p6', 'VCC').source?.id).toBe('p8'); // p6 is on the bottom: the selected part's pad on the net
    expect(select('top', 'c1', 'p1', 'VCC').source?.id).toBe('p2'); // p1 is not on the net: the selected part's pad on the net
    expect(select('top', null, null, 'VCC').source?.id).toBe('p2'); // no part: the first pad of the net
    expect(select('top', 'c2', null, 'VCC').source?.id).toBe('p2'); // the part has no pad on the net
  });
});

describe('board scene: display flags', () => {
  it('marks parts whose pads are all ground or all unconnected, small parts, mechanical parts and test points', () => {
    const scene = buildBoardScene(sampleBoard());
    const flags = partDisplayFlags(scene);
    expect(partDisplayFlags(scene)).toBe(flags); // computed once per scene
    const of = (ref: string) => flags[scene.parts.find(entry => entry.component.ref === ref)!.index];
    expect(of('U1')).toBe(0); // GND, VCC and an unconnected pad: neither
    expect(of('R1')).toBe(PART_FLAG.ground); // 1 mm long: not below the small-part limit
    expect(of('J1')).toBe(0);
    expect(of('TP1') & PART_FLAG.small).toBe(PART_FLAG.small);
    expect(of('TP1') & PART_FLAG.testpoint).toBe(PART_FLAG.testpoint);
    expect(of('MH1') & PART_FLAG.mechanical).toBe(PART_FLAG.mechanical);
    expect(of('MH1') & (PART_FLAG.ground | PART_FLAG.noConnect)).toBe(0); // no pads: no electrical flag
    expect(of('C1')).toBe(PART_FLAG.noConnect); // '' and N/C
  });

  it('takes the ground names and the small-part limit as options', () => {
    const scene = buildBoardScene(sampleBoard());
    const flags = computePartFlags(scene, ['VCC'], 2);
    const of = (ref: string) => flags[scene.parts.find(entry => entry.component.ref === ref)!.index];
    expect(of('R1')).toBe(PART_FLAG.small);
    expect(of('U1')).toBe(0);
    expect(SMALL_PART_MM).toBe(1);
  });
});
