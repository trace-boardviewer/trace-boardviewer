import { describe, expect, it } from 'vitest';
import { connectionPath, connectionPaths, DEFAULT_MAX_LINKS, MAX_PATH_PARTS, type ConnectionPathOptions, type ConnectionPathResult } from './connection-path';
import { buildNetGraph, type NetGraph } from './net-graph';
import { expectCostAtMost, expectScaling } from '../test-support/timing';
import { kitBoard, largeBoard, seeded, two, type KitPart } from './net-testkit';
import { linkOf, normalizeLinkSettings } from './rail-links';

/** "J1 -> VIN_CONN -F1-> VIN_F -L1-> VSYS": the path as text. */
const text = (result: ConnectionPathResult) => result.steps.map(step => (step.next ? `${step.net} -${step.next.ref}->` : step.net)).join(' ');

function board(parts: KitPart[]): { graph: NetGraph; id: (ref: string) => string } {
  const graph = buildNetGraph(kitBoard([...parts, two('CZ', '1u', 'ZZ_SUPPORT', 'GND')]));
  return { graph, id: ref => graph.component(parts.findIndex(part => part.ref === ref)).id };
}

describe('connectionPath: fixtures', () => {
  const feed: KitPart[] = [
    { ref: 'J1', pins: ['VIN_CONN', 'GND', 'GND'] },
    two('F1', '2A', 'VIN_CONN', 'VIN_F'),
    two('L1', '2.2uH', 'VIN_F', 'VSYS'),
    { ref: 'U7', pins: ['VSYS', 'GND', 'EN'] },
    two('C1', '10u', 'VSYS', 'GND'),
    two('R9', '10K', 'VIN_CONN', 'EN'),
  ];
  it('finds how J1 feeds U7 through a fuse and an inductor', () => {
    const { graph, id } = board(feed);
    const result = connectionPath(graph, id('J1'), id('U7'));
    expect(result.status).toBe('path');
    expect(text(result)).toBe('VIN_CONN -F1-> VIN_F -L1-> VSYS');
    expect(result.links).toBe(2);
    expect(result.steps[0].next).toMatchObject({ ref: 'F1', linkClass: 'fuse', certainty: 'definite', value: '2A' });
    expect(result.shared).toEqual([]);
  });
  it('crosses any two-net passive only on opt-in (here the 10K pull-up is shorter)', () => {
    const { graph, id } = board(feed);
    const result = connectionPath(graph, id('J1'), id('U7'), { anyPassive: true });
    expect(text(result)).toBe('VIN_CONN -R9-> EN');
    expect(result.steps[0].next).toMatchObject({ linkClass: 'passive', certainty: 'opt-in' });
  });
  it('reports nets two parts share directly; ground does not count', () => {
    const { graph, id } = board(feed);
    const direct = connectionPath(graph, id('U7'), id('C1'));
    expect(direct).toMatchObject({ status: 'direct', shared: ['VSYS'], links: 0 });
    expect(text(direct)).toBe('VSYS');
    // J1 and C1 share only GND: not a connection; the path runs through the links.
    expect(connectionPath(graph, id('J1'), id('C1'))).toMatchObject({ status: 'path', links: 2 });
  });
  it('never crosses ground (a 0 Ω strap to ground is not a path)', () => {
    const { graph, id } = board([{ ref: 'U1', pins: ['A'] }, two('R1', '0R', 'A', 'GND'), two('R2', '0R', 'GND', 'B'), { ref: 'U2', pins: ['B'] }]);
    expect(connectionPath(graph, id('U1'), id('U2')).status).toBe('none');
  });
  it('crosses possible links only on opt-in', () => {
    const { graph, id } = board([{ ref: 'U1', pins: ['A'] }, two('R1', '', 'A', 'B'), { ref: 'U2', pins: ['B'] }]);
    expect(connectionPath(graph, id('U1'), id('U2')).status).toBe('none');
    const result = connectionPath(graph, id('U1'), id('U2'), { includePossible: true });
    expect(result.status).toBe('path');
    expect(result.steps[0].next).toMatchObject({ ref: 'R1', certainty: 'possible' });
  });
  it('crosses a one-way diode from anode to cathode only', () => {
    const parts: KitPart[] = [{ ref: 'U1', pins: ['VBAT'] }, { ref: 'D1', value: 'BAT54', pins: [{ net: 'VBAT', name: 'A' }, { net: 'VSYS', name: 'K' }] }, { ref: 'U2', pins: ['VSYS'] }];
    const { graph, id } = board(parts);
    expect(connectionPath(graph, id('U1'), id('U2'), { diodes: true, includePossible: true })).toMatchObject({ status: 'path', links: 1 });
    expect(connectionPath(graph, id('U2'), id('U1'), { diodes: true, includePossible: true }).status).toBe('none');
    expect(connectionPath(graph, id('U1'), id('U2')).status).toBe('none'); // diodes are off by default
  });
  it('stops at maxLinks parts', () => {
    const chain: KitPart[] = [{ ref: 'U1', pins: ['N0'] }, ...Array.from({ length: 5 }, (_, i) => two(`R${i + 1}`, '0R', `N${i}`, `N${i + 1}`)), { ref: 'U2', pins: ['N5'] }];
    const { graph, id } = board(chain);
    expect(connectionPath(graph, id('U1'), id('U2'))).toMatchObject({ status: 'path', links: 5 });
    expect(connectionPath(graph, id('U1'), id('U2'), { maxLinks: 4 }).status).toBe('none');
    expect(connectionPath(graph, id('U1'), id('U2'), { maxLinks: 5 }).status).toBe('path');
    expect(DEFAULT_MAX_LINKS).toBe(16);
  });
  it('does not cross a large net, but may start or end on one', () => {
    const parts: KitPart[] = [
      { ref: 'U1', pins: ['A'] }, two('R1', '0R', 'A', 'BIG'), two('R2', '0R', 'BIG', 'B'), { ref: 'U2', pins: ['B'] },
      ...Array.from({ length: 10 }, (_, i) => two(`C${i}`, '1u', 'BIG', 'GND')), { ref: 'U3', pins: ['BIG'] },
    ];
    const { graph, id } = board(parts);
    expect(connectionPath(graph, id('U1'), id('U2'), { maxNetPins: 5 }).status).toBe('none');
    expect(connectionPath(graph, id('U1'), id('U2')).status).toBe('path');
    expect(connectionPath(graph, id('U3'), id('U2'), { maxNetPins: 5 })).toMatchObject({ status: 'path', links: 1 });
    expect(connectionPath(graph, id('U1'), id('U3'), { maxNetPins: 5 })).toMatchObject({ status: 'path', links: 1 });
  });
  it('never crosses a part that is not fitted, even on opt-in', () => {
    const parts: KitPart[] = [{ ref: 'U1', pins: ['A'] }, two('R1', '0R', 'A', 'B'), two('R2', '10K DNP', 'A', 'B'), { ref: 'U2', pins: ['B'] }];
    const kit = kitBoard([...parts, two('CZ', '1u', 'ZZ_SUPPORT', 'GND')]);
    const graph = buildNetGraph(kit, { notFitted: new Set([kit.components[1].id]) });
    expect(connectionPath(graph, kit.components[0].id, kit.components[3].id, { anyPassive: true, includePossible: true }).status).toBe('none');
  });
  it('reports unknown parts and the same part', () => {
    const { graph, id } = board(feed);
    expect(connectionPath(graph, 'nope', id('U7')).status).toBe('unknown-part');
    expect(connectionPath(graph, id('U7'), id('U7')).status).toBe('same-part');
  });
  it('gives every pair of up to eight parts', () => {
    const { graph, id } = board(feed);
    const results = connectionPaths(graph, [id('J1'), id('U7'), id('C1'), id('J1')]);
    expect(results.map(result => [result.from, result.to, result.status])).toEqual([
      [id('J1'), id('U7'), 'path'], [id('J1'), id('C1'), 'path'], [id('U7'), id('C1'), 'direct'],
    ]);
    expect(MAX_PATH_PARTS).toBe(8);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Brute-force reference on random boards
// ---------------------------------------------------------------------------------------------------------------

const PASSIVE = new Set(['resistor', 'capacitor', 'inductor', 'ferrite', 'fuse', 'jumper']);

/** Fewest parts between the two parts, by relaxing every part of the board until nothing changes; null when unreachable. */
function referenceLinks(graph: NetGraph, from: number, to: number, options: ConnectionPathOptions): number | null {
  const settings = normalizeLinkSettings(options);
  const maxNetPins = options.maxNetPins ?? 2000, maxLinks = options.maxLinks ?? DEFAULT_MAX_LINKS;
  const usable = (net: number) => net >= 0 && !graph.isGround(net) && !graph.isNoConnect(net);
  const targets = new Set([...graph.partNets(to)].filter(usable));
  const dist = new Map<number, number>();
  for (const net of graph.partNets(from)) if (usable(net)) { if (targets.has(net)) return 0; dist.set(net, 0); }
  const steps = (part: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    const link = linkOf(graph, part, settings);
    if (link && link.type === 'link' && (link.certainty === 'definite' || options.includePossible)) {
      out.push([link.nets[0], link.nets[1]]);
      if (!link.oneWay) out.push([link.nets[1], link.nets[0]]);
    }
    if (options.anyPassive && PASSIVE.has(graph.kindOf(part).kind) && !graph.valueOf(part).notFitted) {
      const nets = [...graph.partNets(part)].filter(net => !graph.isNoConnect(net));
      if (nets.length === 2) out.push([nets[0], nets[1]], [nets[1], nets[0]]);
    }
    return out;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let part = 0; part < graph.partCount; part++) {
      if (part === from || part === to) continue;
      for (const [near, far] of steps(part)) {
        const d = dist.get(near);
        if (d === undefined || d >= maxLinks || !usable(far)) continue;
        if (!targets.has(far) && graph.netPinCount(far) > maxNetPins) continue;
        if (targets.has(near) && dist.get(near)! > 0) continue; // a path ends at the first net of the target
        if ((dist.get(far) ?? Infinity) > d + 1) { dist.set(far, d + 1); changed = true; }
      }
    }
  }
  let best: number | null = null;
  for (const net of targets) { const d = dist.get(net); if (d !== undefined && (best === null || d < best)) best = d; }
  return best;
}

describe('connectionPath: equals a brute-force reference on 400 random boards', () => {
  it('finds a path exactly when the reference does, of the same length, and every step is real', () => {
    let paths = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const random = seeded(seed);
      const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
      const nets = [...Array.from({ length: 4 + Math.floor(random() * 10) }, (_, i) => `N${i}`), 'GND', 'NC', 'BIG'];
      const kinds = [['R', ['0R', '10K', '', '0R5', 'DNP']], ['L', ['1uH', '10nH']], ['FB', ['600R@100MHz']], ['C', ['1u']], ['JP', ['']], ['D', ['BAT54']]] as const;
      const parts: KitPart[] = [];
      for (let i = 0; i < 6 + Math.floor(random() * 30); i++) {
        const [prefix, values] = pick(kinds);
        parts.push(prefix === 'D' ? { ref: `D${i}`, value: 'BAT54', pins: [{ net: pick(nets), name: 'A' }, { net: pick(nets), name: 'K' }] } : two(`${prefix}${i}`, pick(values), pick(nets), pick(nets)));
      }
      for (let i = 0; i < 4; i++) parts.push({ ref: `U${i}`, pins: [pick(nets), pick(nets)] });
      for (let i = 0; i < 8; i++) parts.push(two(`CB${i}`, '1u', 'BIG', 'GND'));
      const graph = buildNetGraph(kitBoard(parts));
      const options: ConnectionPathOptions = { includePossible: random() < 0.4, anyPassive: random() < 0.3, diodes: random() < 0.4, maxNetPins: random() < 0.5 ? 6 : undefined, maxLinks: random() < 0.2 ? 2 : undefined };
      const from = Math.floor(random() * graph.partCount), to = Math.floor(random() * graph.partCount);
      if (from === to) continue;
      const result = connectionPath(graph, graph.component(from).id, graph.component(to).id, options);
      const expected = referenceLinks(graph, from, to, options);
      const message = `seed ${seed}`;
      if (expected === null) { expect(result.status, message).toBe('none'); continue; }
      expect(result.status, message).toBe(expected === 0 ? 'direct' : 'path');
      expect(result.links, message).toBe(expected);
      if (expected === 0) continue;
      paths++;
      // The path is a chain of real parts between real nets.
      expect([...graph.partNets(from)].map(net => graph.netName(net))).toContain(result.steps[0].net);
      expect([...graph.partNets(to)].map(net => graph.netName(net))).toContain(result.steps[result.steps.length - 1].net);
      for (let k = 0; k + 1 < result.steps.length; k++) {
        const part = graph.partIndex(result.steps[k].next!.componentId);
        const partNets = [...graph.partNets(part)].map(net => graph.netName(net));
        expect(partNets, message).toContain(result.steps[k].net);
        expect(partNets, message).toContain(result.steps[k + 1].net);
        expect(graph.isGround(graph.netIndex(result.steps[k + 1].net))).toBe(false);
      }
    }
    expect(paths).toBeGreaterThan(40);
  });
});

describe('connectionPath: cost', () => {
  it('stays linear when the search has to cover the whole board', () => {
    // Two parts at the ends of one long chain of 0 Ω parts: the search visits every net.
    const chain = (length: number) => {
      const parts: KitPart[] = [{ ref: 'U1', pins: ['N0'] }, ...Array.from({ length }, (_, i) => two(`R${i}`, '0R', `N${i}`, `N${i + 1}`)), { ref: 'U2', pins: [`N${length}`] }, two('C0', '1u', 'N0', 'GND')];
      const graph = buildNetGraph(kitBoard(parts));
      return { graph, from: graph.component(0).id, to: graph.component(length + 1).id };
    };
    const large = chain(50_000);
    expect(connectionPath(large.graph, large.from, large.to, { maxLinks: Infinity })).toMatchObject({ status: 'path', links: 50_000 });
    expectScaling('connectionPath along a chain', [1250, 5000, 20_000], length => { const { graph, from, to } = chain(length); return () => connectionPath(graph, from, to, { maxLinks: Infinity }); });
  }, 60_000);
  it('answers on a 100k-pin board', () => {
    const board100k = largeBoard(100_000);
    const graph = buildNetGraph(board100k);
    const ic = board100k.components.findIndex(component => component.ref === 'U1');
    const other = board100k.components.findIndex(component => component.ref === 'U2');
    const from = graph.component(ic).id, to = graph.component(other).id;
    expect(['direct', 'path', 'none']).toContain(connectionPath(graph, from, to).status);
    // A search that covers every net of the board costs about as much as building the graph, so it must stay below that.
    expectCostAtMost('connectionPath on a 100k-pin board', () => connectionPath(graph, from, to), () => buildNetGraph(board100k), 1);
  });
});
