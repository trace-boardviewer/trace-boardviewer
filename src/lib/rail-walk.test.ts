import { describe, expect, it } from 'vitest';
import { buildNetGraph } from './net-graph';
import { expectBoundedWork, expectCostAtMost, expectScaling } from '../test-support/timing';
import { kitBoard, largeBoard, seeded, two, type KitPart } from './net-testkit';
import { linkOf, normalizeLinkSettings } from './rail-links';
import { normalizeWalkOptions, railPartList, railWalk, walkFrom, type RailWalkOptions, type RailWalkResult } from './rail-walk';

const hops = (result: RailWalkResult) => Object.fromEntries(result.nets.map(net => [net.net, net.hop]));
const statuses = (result: RailWalkResult) => Object.fromEntries(result.links.map(link => [link.ref, link.status]));

interface Case {
  name: string;
  parts: KitPart[];
  start: string;
  options?: RailWalkOptions;
  nets: Record<string, number>;
  links: Record<string, string>;
  notFitted?: string[];
  status?: RailWalkResult['status'];
}

// Every board also has caps to GND so that GND is a real ground net by name.
const caps = (...nets: string[]): KitPart[] => nets.map((net, i) => two(`C${900 + i}`, '100n', net, 'GND'));
const chain: KitPart[] = [two('R1', '0R', 'N0', 'N1'), two('L1', '2.2uH', 'N1', 'N2'), two('FB1', '600R@100MHz', 'N2', 'N3'), two('F1', '2A', 'N3', 'N4'), ...caps('N0', 'N1', 'N2', 'N3', 'N4')];

const CASES: Case[] = [
  { name: 'chain, 2 hops (default)', parts: chain, start: 'N0', nets: { N0: 0, N1: 1, N2: 2 }, links: { R1: 'walked', L1: 'walked', FB1: 'beyond-hops' } },
  { name: 'chain, 3 hops', parts: chain, start: 'N0', options: { hops: 3 }, nets: { N0: 0, N1: 1, N2: 2, N3: 3 }, links: { R1: 'walked', L1: 'walked', FB1: 'walked', F1: 'beyond-hops' } },
  { name: 'chain, 0 hops', parts: chain, start: 'N0', options: { hops: 0 }, nets: { N0: 0 }, links: { R1: 'beyond-hops' } },
  { name: 'chain from the middle', parts: chain, start: 'N2', options: { hops: 1 }, nets: { N2: 0, N1: 1, N3: 1 }, links: { L1: 'walked', FB1: 'walked', R1: 'beyond-hops', F1: 'beyond-hops' } },
  { name: 'hops above 3 are clamped to 3', parts: chain, start: 'N0', options: { hops: 9 }, nets: { N0: 0, N1: 1, N2: 2, N3: 3 }, links: { R1: 'walked', L1: 'walked', FB1: 'walked', F1: 'beyond-hops' } },
  {
    name: 'triangle loop',
    parts: [two('R1', '0R', 'N0', 'N1'), two('R2', '0R', 'N1', 'N2'), two('R3', '0R', 'N2', 'N0'), ...caps('N0', 'N1', 'N2')],
    start: 'N0', options: { hops: 3 }, nets: { N0: 0, N1: 1, N2: 1 }, links: { R1: 'walked', R3: 'walked', R2: 'loop' },
  },
  {
    name: 'parallel fuses',
    parts: [two('F1', '1A', 'VIN', 'VSYS'), two('F2', '1A', 'VIN', 'VSYS'), ...caps('VIN', 'VSYS')],
    start: 'VIN', nets: { VIN: 0, VSYS: 1 }, links: { F1: 'walked', F2: 'loop' },
  },
  {
    name: 'square ring reaches the far corner once',
    parts: [two('R1', '0R', 'A', 'B'), two('R2', '0R', 'B', 'C'), two('R3', '0R', 'C', 'D'), two('R4', '0R', 'D', 'A'), ...caps('A', 'B', 'C', 'D')],
    start: 'A', options: { hops: 3 }, nets: { A: 0, B: 1, D: 1, C: 2 }, links: { R1: 'walked', R4: 'walked', R2: 'walked', R3: 'loop' },
  },
  {
    name: 'ground bridge is never crossed',
    parts: [two('R1', '0R', 'VCC', 'GND'), two('R2', '0R', 'GND', 'OTHER'), two('L1', '1uH', 'VCC', 'VCC_F'), ...caps('VCC', 'OTHER', 'VCC_F')],
    start: 'VCC', options: { hops: 3 }, nets: { VCC: 0, VCC_F: 1 }, links: { L1: 'walked', R1: 'ground' },
  },
  {
    name: 'ground named by a custom-free fallback pattern (GND_*) is never crossed',
    parts: [two('R1', '0R', 'P5V', 'GND_PWR'), ...caps('P5V'), two('C1', '1u', 'P5V', 'GND_PWR')],
    start: 'P5V', options: { hops: 3 }, nets: { P5V: 0 }, links: { R1: 'ground' },
  },
  {
    name: 'not-fitted links are listed apart and not walked',
    parts: [two('R1', '0R DNP', 'A', 'B'), two('R2', 'NC', 'A', 'C'), two('FB1', 'DNP', 'A', 'D'), two('R3', '0R', 'A', 'E'), ...caps('A', 'B', 'C', 'D', 'E')],
    start: 'A', nets: { A: 0, E: 1 }, links: { R3: 'walked' }, notFitted: ['FB1', 'R1', 'R2'],
  },
  {
    name: 'unknown values are possible links only',
    parts: [two('R1', '', 'A', 'B'), two('R2', '0R', 'B', 'C'), two('L1', '10nH', 'A', 'D'), ...caps('A', 'B', 'C', 'D')],
    start: 'A', options: { hops: 3 }, nets: { A: 0 }, links: { R1: 'possible', L1: 'possible' },
  },
  {
    name: 'unknown values walked on opt-in',
    parts: [two('R1', '', 'A', 'B'), two('R2', '0R', 'B', 'C'), two('L1', '10nH', 'A', 'D'), ...caps('A', 'B', 'C', 'D')],
    start: 'A', options: { hops: 3, includePossible: true }, nets: { A: 0, B: 1, D: 1, C: 2 }, links: { R1: 'walked', L1: 'walked', R2: 'walked' },
  },
  {
    name: 'a possible link between two walked nets is a loop',
    parts: [two('R1', '0R', 'A', 'B'), two('R2', '', 'A', 'B'), ...caps('A', 'B')],
    start: 'A', nets: { A: 0, B: 1 }, links: { R1: 'walked', R2: 'loop' },
  },
  {
    name: 'resistors above the threshold are not links',
    parts: [two('R1', '0R5', 'A', 'B'), two('R2', '1R5', 'A', 'C'), two('R3', '4K7', 'A', 'D'), ...caps('A', 'B', 'C', 'D')],
    start: 'A', nets: { A: 0, B: 1 }, links: { R1: 'walked' },
  },
  {
    name: 'a lower threshold drops low-ohm links',
    parts: [two('R1', '0R5', 'A', 'B'), two('R2', '0R', 'A', 'C'), ...caps('A', 'B', 'C')],
    start: 'A', options: { thresholdOhms: 0 }, nets: { A: 0, C: 1 }, links: { R2: 'walked' },
  },
  {
    name: 'a higher threshold adds them',
    parts: [two('R1', '4R7', 'A', 'B'), ...caps('A', 'B')],
    start: 'A', options: { thresholdOhms: 5 }, nets: { A: 0, B: 1 }, links: { R1: 'walked' },
  },
  {
    name: 'no-connect pins never link',
    parts: [two('R1', '0R', 'A', 'NC'), two('R2', '0R', 'A', ''), ...caps('A')],
    start: 'A', nets: { A: 0 }, links: {},
  },
  {
    name: 'a large net is not entered',
    parts: [two('R1', '0R', 'A', 'BIG'), ...Array.from({ length: 30 }, (_, i) => two(`C${i}`, '1u', 'BIG', 'GND')), ...caps('A')],
    start: 'A', options: { maxNetPins: 20 }, nets: { A: 0 }, links: { R1: 'large-net' },
  },
  {
    name: 'a large start net is still walked from',
    parts: [two('R1', '0R', 'A', 'BIG'), ...Array.from({ length: 30 }, (_, i) => two(`C${i}`, '1u', 'BIG', 'GND')), ...caps('A')],
    start: 'BIG', options: { maxNetPins: 20 }, nets: { BIG: 0, A: 1 }, links: { R1: 'walked' },
  },
  {
    name: 'a walk that starts on ground is not expanded',
    parts: chain.concat([two('R7', '0R', 'GND', 'X')]), start: 'GND', nets: { GND: 0 }, links: {}, status: 'ground',
  },
  {
    name: 'a walk that starts on a no-connect net is not expanded',
    parts: [two('R1', '0R', 'NC', 'A'), ...caps('A')], start: 'NC', nets: { NC: 0 }, links: {}, status: 'no-connect',
  },
  {
    name: 'one-way diodes are walked anode to cathode only',
    parts: [{ ref: 'D1', value: 'BAT54', pins: [{ net: 'VBAT', name: 'A' }, { net: 'VSYS', name: 'K' }] }, ...caps('VBAT', 'VSYS')],
    start: 'VBAT', options: { diodes: true, includePossible: true }, nets: { VBAT: 0, VSYS: 1 }, links: { D1: 'walked' },
  },
  {
    name: 'one-way diodes are not walked backwards',
    parts: [{ ref: 'D1', value: 'BAT54', pins: [{ net: 'VBAT', name: 'A' }, { net: 'VSYS', name: 'K' }] }, ...caps('VBAT', 'VSYS')],
    start: 'VSYS', options: { diodes: true, includePossible: true }, nets: { VSYS: 0 }, links: { D1: 'possible' },
  },
  {
    name: 'Kelvin shunt walked through its force nets only',
    parts: [{ ref: 'R1', value: 'R002', pins: ['VIN', 'SNS_P', 'SNS_N', 'VOUT'] }, { ref: 'U1', pins: ['SNS_P', 'SNS_N', 'GND'] }, ...caps('VIN', 'VIN', 'VOUT', 'VOUT')],
    start: 'VIN', options: { hops: 3 }, nets: { VIN: 0, VOUT: 1 }, links: { R1: 'walked' },
  },
];

describe('railWalk: synthetic graphs give exactly the expected nets, hops and link statuses', () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const graph = buildNetGraph(kitBoard(testCase.parts));
      const result = railWalk(graph, testCase.start, testCase.options);
      expect(result.status).toBe(testCase.status ?? 'ok');
      expect(hops(result)).toEqual(testCase.nets);
      expect(statuses(result)).toEqual(testCase.links);
      expect(result.notFitted.map(item => item.ref)).toEqual(testCase.notFitted ?? []);
      // byHop holds the same sets.
      result.byHop.forEach((names, hop) => expect(names.sort()).toEqual(Object.entries(testCase.nets).filter(([, h]) => h === hop).map(([n]) => n).sort()));
    });
  }
});

describe('railWalk: details', () => {
  it('says through which part and from which net each net was reached', () => {
    const graph = buildNetGraph(kitBoard(chain));
    const result = railWalk(graph, 'N0');
    const n2 = result.nets.find(net => net.net === 'N2')!;
    expect(n2.via).toMatchObject({ ref: 'L1', fromNet: 'N1', linkClass: 'inductor' });
    expect(result.nets[0].via).toBeNull();
    const l1 = result.links.find(link => link.ref === 'L1')!;
    expect(l1).toMatchObject({ from: 'N1', to: 'N2', fromHop: 1, toHop: 2, linkClass: 'inductor', certainty: 'definite', code: 'inductor-value' });
    expect(result.links.find(link => link.ref === 'FB1')).toMatchObject({ from: 'N2', to: 'N3', toHop: null });
  });
  it('does not walk through parts listed as not fitted and lists them apart', () => {
    const board = kitBoard(chain);
    const graph = buildNetGraph(board, { notFitted: new Set([board.components.find(component => component.ref === 'L1')!.id]) });
    const result = railWalk(graph, 'N0', { hops: 3 });
    expect(hops(result)).toEqual({ N0: 0, N1: 1 });
    expect(result.notFitted.map(item => [item.ref, item.linkClass, item.nets])).toEqual([['L1', 'inductor', ['N1', 'N2']]]);
    const rows = railPartList(graph, walkFrom(graph, [graph.netIndex('N0')], normalizeWalkOptions({ hops: 3 })));
    expect(rows.find(row => row.ref === 'L1')).toMatchObject({ notFitted: true, linkClass: null });
    expect(rows.find(row => row.ref === 'R1')).toMatchObject({ notFitted: false, linkClass: 'jumper' });
  });
  it('lists test points on each walked net as leaf markers', () => {
    const graph = buildNetGraph(kitBoard([two('R1', '0R', 'A', 'B'), { ref: 'TP2', pins: ['B'] }, { ref: 'TP1', pins: ['B'] }, { ref: 'TP3', pins: ['GND'] }, ...caps('A', 'B')]));
    const result = railWalk(graph, 'A');
    expect(result.nets.find(net => net.net === 'B')!.testPoints.map(tp => tp.ref)).toEqual(['TP1', 'TP2']);
    expect(result.nets.find(net => net.net === 'A')!.testPoints).toEqual([]);
  });
  it('gives the expected voltage of rail names as a hint and the net class', () => {
    const graph = buildNetGraph(kitBoard([two('L1', '2.2uH', 'PP3V3_S5', 'PP3V3_S5_L'), ...caps('PP3V3_S5', 'PP3V3_S5_L')]));
    const result = railWalk(graph, 'PP3V3_S5');
    expect(result.nets.map(net => [net.net, net.expectedVolts, net.kind])).toEqual([['PP3V3_S5', 3.3, 'power'], ['PP3V3_S5_L', 3.3, 'power']]);
  });
  it('reports an unknown net', () => {
    const graph = buildNetGraph(kitBoard(chain));
    expect(railWalk(graph, 'NOPE')).toMatchObject({ status: 'unknown-net', nets: [], links: [] });
  });
  it('counts the parts on the walked nets (ground excluded)', () => {
    const graph = buildNetGraph(kitBoard(chain));
    // N0..N2 walked: R1, L1, FB1, and the caps of N0, N1, N2.
    expect(railWalk(graph, 'N0').partCount).toBe(6);
  });
  it('normalises the options', () => {
    expect(normalizeWalkOptions()).toEqual({ thresholdOhms: 1, diodes: false, hops: 2, includePossible: false, maxNetPins: 2000 });
    expect(normalizeWalkOptions({ hops: -1, maxNetPins: 0 })).toMatchObject({ hops: 0, maxNetPins: 1 });
    expect(normalizeWalkOptions({ hops: 2.7 }).hops).toBe(2);
    expect(normalizeWalkOptions({ maxNetPins: Infinity }).maxNetPins).toBe(Infinity);
  });
  it('gives the same result whatever the part order of the file', () => {
    const parts = [two('R1', '0R', 'A', 'B'), two('R2', '0R', 'B', 'C'), two('R3', '0R', 'C', 'A'), two('L1', '1uH', 'C', 'D'), two('F1', '1A', 'D', 'E'), ...caps('A', 'B', 'C', 'D', 'E')];
    const reference = railWalk(buildNetGraph(kitBoard(parts)), 'A', { hops: 3 });
    const random = seeded(7);
    for (let round = 0; round < 10; round++) {
      const shuffled = [...parts].sort(() => random() - 0.5);
      const result = railWalk(buildNetGraph(kitBoard(shuffled)), 'A', { hops: 3 });
      expect(hops(result)).toEqual(hops(reference));
      expect(result.links.map(link => [link.ref, link.from, link.to])).toEqual(reference.links.map(link => [link.ref, link.from, link.to]));
      expect(result.byHop).toEqual(reference.byHop);
    }
  });
  it('lists every part of the rail for fault finding: capacitors first, larger packages first', () => {
    const parts = [
      two('L1', '2.2uH', 'VCC', 'VCC_L'),
      two('C1', '100n', 'VCC', 'GND', { package: 'C_0402_1005Metric' }), two('C2', '22u', 'VCC_L', 'GND', { package: 'C_1206_3216Metric' }), two('C3', '1u', 'VCC', 'GND', { package: 'C_0603_1608Metric' }),
      { ref: 'U1', pins: ['VCC', 'GND', 'X'] }, two('R1', '10K', 'VCC', 'EN'),
    ];
    const graph = buildNetGraph(kitBoard(parts));
    const core = walkFrom(graph, [graph.netIndex('VCC')], normalizeWalkOptions());
    const rows = railPartList(graph, core);
    expect(rows.map(row => row.ref)).toEqual(['C2', 'C3', 'C1', 'U1', 'L1', 'R1']);
    expect(rows[0]).toMatchObject({ kind: 'capacitor', sizeCode: '1206', hop: 1, toGround: true, linkClass: null, nets: ['VCC_L'] });
    expect(rows.find(row => row.ref === 'L1')).toMatchObject({ linkClass: 'inductor', hop: 0, nets: ['VCC', 'VCC_L'] });
  });
});

describe('railWalk: cost on large and pathological boards', () => {
  it('walks a 100k-pin board for less than it costs to build the graph of that board', () => {
    const board = largeBoard(100_000);
    const rail = board.nets.find(net => net.name.startsWith('PP1V0'))!.name;
    const graph = buildNetGraph(board);
    const result = railWalk(graph, rail, { hops: 3 });
    expect(result.status).toBe('ok');
    expect(result.nets.length).toBeGreaterThan(1);
    // A walk that scanned the parts of the board would cost the graph build or more; this one reads the walked nets only.
    expectCostAtMost('rail walk on a 100k-pin board', () => railWalk(graph, rail, { hops: 3 }), () => buildNetGraph(board), 1);
    expectCostAtMost('rail walk with possible links', () => railWalk(graph, rail, { hops: 3, includePossible: true }), () => buildNetGraph(board), 1);
    // The first walk on a fresh graph classifies the parts it meets: graph build plus walk is still the same order of cost.
    expectCostAtMost('first rail walk on a fresh graph', () => railWalk(buildNetGraph(board), rail, { hops: 3 }), () => buildNetGraph(board), 3);
  }, 60_000);
  const mesh = (side: number) => {
    const parts: KitPart[] = [two('C0', '1u', 'M0_0', 'GND')];
    const name = (x: number, y: number) => `M${x}_${y}`;
    let r = 1;
    for (let x = 0; x < side; x++) for (let y = 0; y < side; y++) {
      if (x + 1 < side) parts.push(two(`R${r++}`, '0R', name(x, y), name(x + 1, y)));
      if (y + 1 < side) parts.push(two(`R${r++}`, '0R', name(x, y), name(x, y + 1)));
    }
    return { board: kitBoard(parts), centre: name(side >> 1, side >> 1) };
  };
  it('costs the same on a mesh of 0 Ω parts whatever its size (every net linked to four others)', () => {
    const large = mesh(160); // 25,600 nets, about 100k pins
    expect(railWalk(buildNetGraph(large.board), large.centre, { hops: 3 }).nets.length).toBe(25); // a diamond of radius 3: 1 + 4 + 8 + 12
    // 400, 6,400 and 25,600 nets; a walk that scanned the board would grow with them.
    expectBoundedWork('rail walk on a mesh', [400, 6400, 25_600], nets => {
      const { board, centre } = mesh(Math.round(Math.sqrt(nets))), graph = buildNetGraph(board);
      return () => railWalk(graph, centre, { hops: 3 });
    });
  }, 60_000);
  const star = (leaves: number) => {
    const parts: KitPart[] = [two('C0', '1u', 'HUB', 'GND')];
    for (let i = 0; i < leaves; i++) { parts.push(two(`R${i}`, '0R', 'HUB', `LEAF${i}`)); parts.push(two(`L${i}`, '1uH', `LEAF${i}`, `TIP${i}`)); }
    return kitBoard(parts);
  };
  it('stays linear on a star: one rail with 40,000 links to separate nets', () => {
    expect(railWalk(buildNetGraph(star(40_000)), 'HUB', { hops: 3, maxNetPins: Infinity }).nets.length).toBe(80_001);
    expectScaling('rail walk on a star', [2500, 10_000, 40_000], leaves => { const graph = buildNetGraph(star(leaves)); return () => railWalk(graph, 'HUB', { hops: 3, maxNetPins: Infinity }); });
  }, 60_000);
  const capacitorRail = (count: number) => {
    const parts: KitPart[] = [];
    for (let i = 0; i < count; i++) parts.push(two(`C${i}`, '100n', 'PP1V8', 'GND'));
    for (let i = 0; i < 1000; i++) parts.push(two(`R${i}`, '0R', i === 0 ? 'PP1V8' : `CH${i}`, `CH${i + 1}`));
    return kitBoard(parts);
  };
  it('stays linear on a rail holding 50,000 capacitors and a long link chain', () => {
    expect(railWalk(buildNetGraph(capacitorRail(50_000)), 'PP1V8', { hops: 3, maxNetPins: Infinity }).nets.map(net => net.net)).toEqual(['PP1V8', 'CH1', 'CH2', 'CH3']);
    expectScaling('rail walk on a rail of capacitors', [3125, 12_500, 50_000], count => { const graph = buildNetGraph(capacitorRail(count)); return () => railWalk(graph, 'PP1V8', { hops: 3, maxNetPins: Infinity }); });
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------
// Brute-force reference on random boards
// ---------------------------------------------------------------------------------------------------------------

/** A random small board: link parts of every class and certainty, non-links, diodes with A/K pins, ground, NC and a large net. */
function randomBoard(seed: number): { board: ReturnType<typeof kitBoard>; nets: string[] } {
  const random = seeded(seed);
  const pickOf = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const nets = Array.from({ length: 5 + Math.floor(random() * 12) }, (_, i) => `N${i}`);
  const all = [...nets, 'GND', 'NC', 'BIG'];
  const kinds: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['R', ['0R', '0R5', '2R2', '10K', '', 'DNP', 'R005', '4R7']], ['L', ['2.2uH', '10nH', '', 'DNP']], ['FB', ['600R@100MHz']], ['F', ['2A', 'DNP']],
    ['JP', ['', 'SolderJumper_2_Open']], ['C', ['100n']], ['D', ['BAT54']], ['ZZ', ['0R', '1R']],
  ];
  const parts: KitPart[] = [];
  const count = 4 + Math.floor(random() * 30);
  for (let i = 0; i < count; i++) {
    const [prefix, values] = pickOf(kinds);
    const a = pickOf(all), b = pickOf(all);
    if (prefix === 'D') parts.push({ ref: `D${i}`, value: 'BAT54', pins: random() < 0.7 ? [{ net: a, name: 'A' }, { net: b, name: 'K' }] : [a, b] });
    else parts.push(two(`${prefix}${i}`, pickOf(values), a, b));
  }
  for (let i = 0; i < 12; i++) parts.push(two(`CB${i}`, '1u', 'BIG', 'GND'));
  for (const net of nets) parts.push(two(`CG_${net}`, '100n', net, 'GND'));
  return { board: kitBoard(parts), nets: [...nets, 'BIG', 'GND', 'NC'] };
}

/** Hop of every net by layered relaxation over all parts of the board (no adjacency lists, no queue). */
function referenceHops(graph: ReturnType<typeof buildNetGraph>, start: number, options: RailWalkOptions): Map<number, number> {
  const o = normalizeWalkOptions(options);
  const settings = normalizeLinkSettings(options);
  const hop = new Map<number, number>([[start, 0]]);
  for (let round = 0; round < o.hops; round++) {
    const snapshot = new Map(hop);
    for (let part = 0; part < graph.partCount; part++) {
      const link = linkOf(graph, part, settings);
      if (!link || link.type !== 'link') continue;
      for (const [near, far] of [[link.nets[0], link.nets[1]], [link.nets[1], link.nets[0]]] as const) {
        if (snapshot.get(near) !== round || graph.isGround(near) || graph.isNoConnect(near)) continue;
        if (graph.isGround(far) || graph.isNoConnect(far) || graph.netPinCount(far) > o.maxNetPins) continue;
        if (link.certainty === 'possible' && !o.includePossible) continue;
        if (link.oneWay && link.nets[1] !== far) continue;
        if (!hop.has(far)) hop.set(far, round + 1);
      }
    }
  }
  return hop;
}

describe('railWalk: equals a brute-force reference on 400 random boards', () => {
  it('gives the same nets and hops, lists every link part once with a status that fits, and lists the not-fitted ones', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { board, nets } = randomBoard(seed);
      const graph = buildNetGraph(board);
      const random = seeded(seed * 7919);
      const options: RailWalkOptions = {
        hops: Math.floor(random() * 4), includePossible: random() < 0.4, diodes: random() < 0.4,
        thresholdOhms: [0, 1, 5][Math.floor(random() * 3)], maxNetPins: random() < 0.5 ? 10 : undefined,
      };
      const startName = nets[Math.floor(random() * nets.length)];
      const start = graph.netIndex(startName);
      if (start < 0) continue;
      const result = railWalk(graph, startName, options);
      const o = normalizeWalkOptions(options);
      const reference = referenceHops(graph, start, options);
      const expected = Object.fromEntries([...reference].map(([net, hop]) => [graph.netName(net), hop]));
      expect(hops(result), `seed ${seed}`).toEqual(expected);

      // Every link part with an end on a walked, non-ground net appears once; every not-fitted one likewise.
      const settings = normalizeLinkSettings(options);
      const expectLinks: string[] = [], expectNotFitted: string[] = [];
      for (let part = 0; part < graph.partCount; part++) {
        const link = linkOf(graph, part, settings);
        if (!link) continue;
        const touches = link.nets.some(net => reference.has(net) && !graph.isGround(net) && !graph.isNoConnect(net));
        if (touches) (link.type === 'link' ? expectLinks : expectNotFitted).push(graph.component(part).ref);
      }
      expect(result.links.map(link => link.ref).sort(), `seed ${seed}`).toEqual(expectLinks.sort());
      expect(result.notFitted.map(item => item.ref).sort(), `seed ${seed}`).toEqual(expectNotFitted.sort());

      for (const link of result.links) {
        expect(reference.has(graph.netIndex(link.from)), `seed ${seed} ${link.ref}`).toBe(true);
        const far = graph.netIndex(link.to);
        switch (link.status) {
          case 'walked': expect(link.toHop).toBe(link.fromHop + 1); expect(result.nets.find(net => net.net === link.to)!.via!.ref).toBe(link.ref); break;
          case 'loop': expect(link.toHop).not.toBeNull(); break;
          case 'ground': expect(graph.isGround(far)).toBe(true); break;
          case 'possible': expect(link.toHop).toBeNull(); expect((link.certainty === 'possible' && !o.includePossible) || link.oneWay).toBe(true); break;
          case 'large-net': expect(graph.netPinCount(far)).toBeGreaterThan(o.maxNetPins); break;
          case 'beyond-hops': expect(link.fromHop).toBe(o.hops); expect(link.toHop).toBeNull(); break;
        }
      }
      // Each net reached through a link has exactly one walked link into it.
      for (const net of result.nets) {
        const into = result.links.filter(link => link.status === 'walked' && link.to === net.net);
        expect(into.length, `seed ${seed} ${net.net}`).toBe(net.hop === 0 ? 0 : 1);
      }
    }
  });
});
