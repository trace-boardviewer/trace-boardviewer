import { describe, expect, it } from 'vitest';
import { boardIndexOf, buildBoardIndex } from './board-index';
import type { BoardIndex } from './board-index';
import { buildBoardIndex as crossprobeBuildBoardIndex, naturalCompare, normalizeKey } from './crossprobe';
import { classifyComponent } from './part-kind';
import type { Board, BoardComponent, BoardPin, BoardSide } from './types';

// ---------------------------------------------------------------------------------------------------------------
// Original synthetic builders (nothing shared with the parsers)
// ---------------------------------------------------------------------------------------------------------------

interface PadSpec { number: string; net: string; side?: BoardSide; id?: string }
interface PartSpec { ref: string; id?: string; value?: string; pkg?: string; side?: BoardSide; pads: PadSpec[]; extraPinIds?: string[] }
function makeBoard(specs: PartSpec[], extraNets: Array<{ id: string; name: string; pinIds: string[] }> = []): Board {
  const components: BoardComponent[] = [], pins: BoardPin[] = [];
  const netPins = new Map<string, string[]>();
  specs.forEach((spec, i) => {
    const id = spec.id ?? `c${i}`, side = spec.side ?? 'top';
    const pinIds: string[] = [];
    for (const pad of spec.pads) {
      const pinId = pad.id ?? `${id}.${pad.number}.${pins.length}`;
      pins.push({ id: pinId, componentId: id, number: pad.number, name: '', net: pad.net, side: pad.side ?? side, radius: 0.2, shape: 'round', x: i, y: pins.length });
      pinIds.push(pinId);
      if (pad.net) { const list = netPins.get(pad.net); if (list) list.push(pinId); else netPins.set(pad.net, [pinId]); }
    }
    pinIds.push(...(spec.extraPinIds ?? []));
    components.push({ id, ref: spec.ref, value: spec.value ?? '', package: spec.pkg ?? '', side, bounds: { minX: i, minY: 0, maxX: i + 1, maxY: 1 }, position: { x: i, y: 0 }, rotation: 0, pinIds, outline: [] });
  });
  const nets = [...[...netPins].map(([name, pinIds], k) => ({ id: `n${k}`, name, pinIds })), ...extraNets];
  return { name: 'synthetic', format: 'Synthetic board', units: 'mm', components, pins, nets, outline: [], bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, warnings: [] };
}

/** Deterministic PRNG (mulberry32) so that a failing case can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const FULLWIDTH_R = String.fromCharCode(0xff32); // NFKC folds it to "R"
/** A messy board: duplicate and case-distinct references, NFKC variants, empty refs and numbers, both-side pads, nets only in `nets`. */
function messyBoard(seed: number, parts = 60): Board {
  const next = rng(seed);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)];
  const refs = ['R1', 'r1', 'R2', 'R10', `${FULLWIDTH_R}3`, 'R3', ' C1 ', 'C1', 'U1', 'U2', 'J1', 'TP1', '', 'Q1', 'L1', 'FB1', 'D1', 'LED1', 'IC7'];
  const nets = ['GND', 'gnd', 'VCC', ' VCC', '+3V3', 'NET_A', 'NET_B', '', '', 'UNCONNECTED-1'];
  const sides: BoardSide[] = ['top', 'bottom', 'both'];
  const specs: PartSpec[] = [];
  for (let i = 0; i < parts; i++) {
    const pads: PadSpec[] = [];
    const count = Math.floor(next() * 5);
    for (let p = 0; p < count; p++) pads.push({ number: pick(['1', '2', '2', '10', ' 3', '', 'A1']), net: pick(nets), ...(next() < 0.2 ? { side: pick(sides) } : {}) });
    specs.push({ ref: pick(refs), id: next() < 0.05 && i > 0 ? `c${i - 1}` : `c${i}`, value: pick(['10k', '100nF', 'ESP32', '']), pkg: pick(['0402', 'QFN-32', 'SOT-23', 'Header']), side: pick(sides), pads, ...(next() < 0.1 ? { extraPinIds: ['missing-pin'] } : {}) });
  }
  return makeBoard(specs, [{ id: 'nx', name: 'ONLY_IN_NETS', pinIds: [] }, { id: 'ny', name: 'GND', pinIds: [] }]);
}

const onSide = (item: { side: string }, side: 'top' | 'bottom') => item.side === side || item.side === 'both';

describe('BoardIndex core: one O(1) lookup structure per board', () => {
  const board = makeBoard([
    { ref: 'R1', id: 'r1', pads: [{ number: '1', net: 'VCC' }, { number: '2', net: 'OUT' }] },
    { ref: 'U1', id: 'u1', value: 'MCU', pkg: 'QFN-32', side: 'bottom', pads: [{ number: '1', net: 'VCC' }, { number: '2', net: 'GND' }] },
    { ref: 'J1', id: 'j1', pkg: 'Header', side: 'both', pads: [{ number: '1', net: 'GND', side: 'both' }, { number: '2', net: '' , side: 'both' }], extraPinIds: ['nope'] },
  ]);
  const index = buildBoardIndex(board);

  it('maps ids to the exact objects of the board, and an unknown id to nothing', () => {
    for (const component of board.components) expect(index.componentById.get(component.id)).toBe(component);
    for (const pin of board.pins) expect(index.pinById.get(pin.id)).toBe(pin);
    expect(index.componentById.get('missing')).toBeUndefined();
    expect(index.board).toBe(board);
    expect(index.kind).toBe('board');
  });

  it('keeps the part kinds of the shared classifier', () => {
    for (const component of board.components) expect(index.kinds.get(component.id)).toBe(classifyComponent(component).kind);
    expect(index.kinds.get('u1')).toBe('ic');
  });

  it('lists the pads of a part in pinIds order, skipping ids without a pad; unknown parts have none', () => {
    expect(index.pinsOf('j1').map(pin => pin.number)).toEqual(['1', '2']);
    expect(index.pinsOf('r1').map(pin => pin.net)).toEqual(['VCC', 'OUT']);
    expect(index.pinsOf('missing')).toEqual([]);
    expect(index.pinsOf('r1')).toBe(index.pinsOf('r1'));
  });

  it('lists every pad of a net name over both sides in board order (exact text)', () => {
    expect(index.pinsOfNet('VCC').map(pin => pin.componentId)).toEqual(['r1', 'u1']);
    expect(index.pinsOfNet('GND').map(pin => pin.componentId)).toEqual(['u1', 'j1']);
    expect(index.pinsOfNet('gnd')).toEqual([]);
    expect(index.pinsOfNet('').map(pin => pin.id)).toEqual([board.pins[5].id]);
  });

  it('answers whether a net exists the way the cross-probe net map does', () => {
    expect(index.hasNet('VCC')).toBe(true);
    expect(index.hasNet(' VCC ')).toBe(true); // NFKC + trim, like netByName
    expect(index.hasNet('vcc')).toBe(false); // case-sensitive
    expect(index.hasNet('')).toBe(false);
    expect(index.hasNet('   ')).toBe(false);
    expect(index.hasNet('NOPE')).toBe(false);
  });

  it('buckets parts and pads per side; both-side items are in both buckets, in board order', () => {
    expect(index.sides.top.components.map(c => c.id)).toEqual(['r1', 'j1']);
    expect(index.sides.bottom.components.map(c => c.id)).toEqual(['u1', 'j1']);
    expect(index.sides.top.pins.map(p => p.id)).toEqual(board.pins.filter(p => onSide(p, 'top')).map(p => p.id));
    expect(index.sides.bottom.pins.map(p => p.id)).toEqual(board.pins.filter(p => onSide(p, 'bottom')).map(p => p.id));
    const topGnd = index.sides.top.netPins.get('GND')!;
    expect(topGnd.pins.map(p => p.componentId)).toEqual(['j1']);
    expect([...topGnd.components]).toEqual(['j1']);
    expect([...index.sides.bottom.netPins.get('GND')!.components]).toEqual(['u1', 'j1']);
    expect(index.sides.top.netPins.get('')!.pins).toHaveLength(1);
  });

  it('orders the component list as the panel did (natural reference order, then id), per side and memoized', () => {
    for (const side of ['top', 'bottom'] as const) expect(index.componentsInOrder(side)).toBe(index.componentsInOrder(side));
    expect(index.componentsInOrder('top').map(c => c.ref)).toEqual(['J1', 'R1']);
    expect(index.componentsInOrder('bottom').map(c => c.ref)).toEqual(['J1', 'U1']);
    expect(index.componentsInOrder().map(c => c.ref)).toEqual(['J1', 'R1', 'U1']);
  });

  it('sorts references naturally (R2 before R10), lists a part on both sides in both lists, and breaks ties by id', () => {
    const numbered = buildBoardIndex(makeBoard([
      { ref: 'R10', id: '1', pads: [] }, { ref: 'R2', id: 'b', pads: [] }, { ref: 'R3', id: '3', side: 'bottom', pads: [] }, { ref: 'J1', id: '4', side: 'both', pads: [] }, { ref: 'R2', id: 'a', side: 'bottom', pads: [] },
    ]));
    expect(numbered.componentsInOrder('top').map(c => c.id)).toEqual(['4', 'b', '1']);
    expect(numbered.componentsInOrder('bottom').map(c => c.id)).toEqual(['4', 'a', '3']);
    expect(numbered.componentsInOrder().map(c => c.id)).toEqual(['4', 'a', 'b', '3', '1']);
  });

  it('is immutable to its users', () => {
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(index.sides)).toBe(true);
    expect(Object.isFrozen(index.sides.top)).toBe(true);
    expect(Object.isFrozen(index.sides.top.pins)).toBe(true);
    expect(Object.isFrozen(index.pinsOf('r1'))).toBe(true);
    expect(Object.isFrozen(index.componentsInOrder())).toBe(true);
    expect(Object.isFrozen(index.components)).toBe(true);
    expect(Object.isFrozen(index.nets)).toBe(true);
    expect(Object.isFrozen(index.search)).toBe(true);
    expect(Object.isFrozen(index.stats)).toBe(true);
    expect(() => { (index as { board: unknown }).board = null; }).toThrow();
  });
});

describe('boardIndexOf: the one shared index of a board object', () => {
  it('returns the same index for the same board object and a new one for another object', () => {
    const a = makeBoard([{ ref: 'R1', pads: [{ number: '1', net: 'N' }] }]);
    const b = structuredClone(a);
    expect(boardIndexOf(a)).toBe(boardIndexOf(a));
    expect(boardIndexOf(b)).not.toBe(boardIndexOf(a));
    expect(boardIndexOf(b).board).toBe(b);
    expect(buildBoardIndex(a)).not.toBe(boardIndexOf(a));
  });

  it('is the index the cross-probe module builds (crossprobe.ts re-exports the builder)', () => {
    expect(crossprobeBuildBoardIndex).toBe(buildBoardIndex);
  });
});

describe('cross-probe layer: built on first use, never on the core path', () => {
  /** A board whose components array counts `slice` calls (every natural-order list starts with one). */
  function counted(board: Board): { board: Board; slices: () => number } {
    let slices = 0;
    const components = board.components;
    const proxy = new Proxy(components, { get(target, key, receiver) { if (key === 'slice') slices++; return Reflect.get(target, key, receiver); } });
    return { board: { ...board, components: proxy }, slices: () => slices };
  }

  it('builds no reference, net or search structure until one of them is read', () => {
    const { board, slices } = counted(messyBoard(7));
    const index = buildBoardIndex(board);
    void index.componentById; void index.pinById; void index.kinds; void index.sides; index.pinsOf('c1'); index.pinsOfNet('GND');
    expect(slices()).toBe(0);
    void index.byRef;
    expect(slices()).toBe(1);
    void index.components; void index.refsByFold; void index.nets; void index.netByName; void index.search; void index.stats;
    expect(slices()).toBe(1);
  });

  it('answers hasNet for a pad-carried name without building the net map', () => {
    const { board, slices } = counted(messyBoard(8));
    const index = buildBoardIndex(board);
    const carried = board.pins.find(pin => pin.net.trim() !== '')!;
    expect(index.hasNet(carried.net)).toBe(true);
    expect(slices()).toBe(0);
    expect(index.hasNet('ONLY_IN_NETS')).toBe(true); // only board.nets names it: the full map answers
  });

  it('gives the same answers whatever is read first (lazy layers do not depend on access order)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const board = messyBoard(seed);
      const a = buildBoardIndex(board), b = buildBoardIndex(board);
      // a: stats first (builds everything through the statistics); b: field by field, pin groups before references.
      const statsA = a.stats;
      const groupsB = new Map([...b.pinGroups].map(([id, groups]) => [id, [...groups.values()]]));
      const snapshot = (index: BoardIndex) => ({
        components: index.components.map(c => c.id), byRef: [...index.byRef].map(([k, v]) => [k, v.map(c => c.id)]), refsByFold: [...index.refsByFold],
        nets: index.nets.map(n => [n.name, n.key, n.folded, n.id, n.pins.map(p => p.id)]), netByName: [...index.netByName].map(([k, v]) => [k, v.length]), netsByFold: [...index.netsByFold],
        search: index.search,
      });
      expect(snapshot(b)).toEqual(snapshot(a));
      expect(b.stats).toEqual(statsA);
      expect(new Map([...a.pinGroups].map(([id, groups]) => [id, [...groups.values()]]))).toEqual(groupsB);
    }
  });

  it('keeps the cross-probe identity rules on messy boards', () => {
    for (let seed = 100; seed < 120; seed++) {
      const board = messyBoard(seed);
      const index = buildBoardIndex(board);
      // Every non-empty normalized reference is one key; duplicates stay together, R1 and r1 stay apart.
      const expected = new Map<string, string[]>();
      for (const component of index.components) { const key = normalizeKey(component.ref); if (key) expected.set(key, [...(expected.get(key) ?? []), component.id]); }
      expect(new Map([...index.byRef].map(([k, v]) => [k, v.map(c => c.id)]))).toEqual(expected);
      for (const [folded, keys] of index.refsByFold) for (const key of keys) expect(key.toLowerCase()).toBe(folded);
      // The first component (and pad) of an id wins, everywhere.
      const firstComponent = new Map<string, BoardComponent>();
      for (const component of board.components) if (!firstComponent.has(component.id)) firstComponent.set(component.id, component);
      expect([...index.componentById.values()]).toEqual([...firstComponent.values()]);
      expect(index.stats.duplicateComponentIds).toBe(board.components.length - firstComponent.size);
      expect(index.pinGroups.size).toBe(firstComponent.size);
      expect([...index.pinGroups.keys()]).toEqual([...firstComponent.keys()]);
      // Nets: natural order, every pad with a net text belongs to a net of its key when that key is unique.
      const names = index.nets.map(n => n.name);
      expect([...names].sort((x, y) => naturalCompare(x, y))).toEqual(names);
      expect(index.stats.components).toBe(board.components.length);
      expect(index.stats.pins).toBe(board.pins.length);
      expect(index.stats.nets).toBe(index.nets.length);
      // Pin groups: the pads of a group share one normalized number, and the groups of a part are in natural order.
      for (const [id, groups] of index.pinGroups) {
        const numbers = [...groups.keys()];
        expect([...numbers].sort(naturalCompare)).toEqual(numbers);
        for (const [number, group] of groups) for (const pin of group.pins) { expect(normalizeKey(pin.number)).toBe(number); expect(pin.componentId).toBe(id); }
      }
    }
  });

  it('builds a part’s pin groups on its first lookup and reuses them', () => {
    const board = messyBoard(3);
    const index = buildBoardIndex(board);
    const id = board.components.find(c => c.pinIds.length > 0)!.id;
    const first = index.pinGroups.get(id);
    expect(first).toBeDefined();
    expect(index.pinGroups.get(id)).toBe(first);
    expect(index.pinGroups.has(id)).toBe(true);
    expect(index.pinGroups.get('missing')).toBeUndefined();
    expect(index.pinGroups.has('missing')).toBe(false);
    // Iteration after single lookups still yields every part once, in board order, with the groups already handed out.
    const all = [...index.pinGroups];
    expect(all.find(([key]) => key === id)?.[1]).toBe(first);
    let visited = 0;
    index.pinGroups.forEach(() => { visited++; });
    expect(visited).toBe(all.length);
  });
});
