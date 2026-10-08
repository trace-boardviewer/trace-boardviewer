import { describe, expect, it } from 'vitest';
import { buildNetGraph, type NetGraph } from './net-graph';
import { expectScaling } from '../test-support/timing';
import { kitBoard, seeded, two, type KitPart } from './net-testkit';
import { linkOf, normalizeLinkSettings } from './rail-links';
import { findShortSuspects, MAX_ISOLATION_POINTS, ratedVolts, type ShortSuspectReport } from './short-suspects';

const refs = (report: ShortSuspectReport) => report.suspects.map(suspect => suspect.ref);
const reasonsOf = (report: ShortSuspectReport, ref: string) => report.suspects.find(suspect => suspect.ref === ref)!.reasons.map(reason => [reason.code, reason.weight]);

describe('findShortSuspects: one shorted rail', () => {
  const parts: KitPart[] = [
    two('C1', '22uF 6.3V', 'PP3V3', 'GND', { package: 'C_1206_3216Metric' }),
    two('C2', '100n', 'PP3V3', 'GND', { package: 'C_0402_1005Metric' }),
    two('C3', '4u7 4V', 'PP3V3', 'GND', { package: 'C_0805_2012Metric' }),
    two('C10', '100uF', 'PP3V3', 'GND', { package: 'CP_Tantalum_Case-B_EIA-3528-21_Reflow' }),
    two('D1', 'PESD5V0S1BL', 'PP3V3', 'GND', { package: 'D_SOD-523' }),
    { ref: 'U1', value: 'SOC', pins: ['PP3V3', 'PP3V3', 'PP3V3', 'PP3V3', 'GND', 'GND', 'SDA'] },
    { ref: 'Q1', value: 'AO3401', package: 'SOT-23', pins: ['PP3V3', 'GND', 'GATE'] },
    two('R1', '10K', 'PP3V3', 'EN'),
    two('R2', '0R', 'PP3V3', 'GND'),
    { ref: 'J1', pins: ['PP3V3', 'GND', 'SDA'] },
    { ref: 'TP1', pins: ['PP3V3'] },
    two('L1', '2.2uH', 'PP3V3', 'PP3V3_L'),
    two('C4', '10u', 'PP3V3_L', 'GND', { package: 'C_0603_1608Metric' }),
  ];
  const graph = buildNetGraph(kitBoard(parts));

  it('ranks the parts on the rail and its sub-rails, each with the reasons of its score', () => {
    const report = findShortSuspects(graph, ['PP3V3']);
    expect(report.rails).toEqual([{ net: 'PP3V3', status: 'ok', expectedVolts: 3.3, resistanceOhms: null, domain: [{ net: 'PP3V3', hop: 0 }, { net: 'PP3V3_L', hop: 1 }] }]);
    expect(refs(report)).toEqual(['C10', 'C1', 'C3', 'C4', 'R2', 'C2', 'D1', 'Q1', 'U1', 'J1', 'R1']);
    expect(report.total).toBe(11);
    expect(reasonsOf(report, 'C10')).toEqual([['capacitor-to-ground', 40], ['large-package', 15], ['bulk-capacitance', 10], ['tantalum', 15]]);
    expect(reasonsOf(report, 'C1')).toEqual([['capacitor-to-ground', 40], ['large-package', 15], ['bulk-capacitance', 10]]);
    expect(reasonsOf(report, 'C3')).toEqual([['capacitor-to-ground', 40], ['large-package', 10], ['bulk-capacitance', 5], ['low-rating-margin', 10]]);
    expect(reasonsOf(report, 'C4')).toEqual([['capacitor-to-ground', 40], ['bulk-capacitance', 10], ['sub-rail', 0]]);
    expect(reasonsOf(report, 'R2')).toEqual([['ground-link', 45]]);
    expect(reasonsOf(report, 'D1')).toEqual([['tvs-to-ground', 35]]);
    expect(reasonsOf(report, 'U1')).toEqual([['ic-to-ground', 25], ['major-load', 5]]);
    expect(reasonsOf(report, 'R1')).toEqual([['no-ground-pin', 3]]);
    for (const suspect of report.suspects) expect(suspect.score).toBe(suspect.reasons.reduce((sum, reason) => sum + reason.weight, 0));
    expect(report.suspects.map(suspect => suspect.rank)).toEqual(report.suspects.map((_, index) => index + 1));
  });
  it('flags 0402 and smaller parts as easy to miss and says on which net and hop each suspect sits', () => {
    const report = findShortSuspects(graph, ['PP3V3']);
    const c2 = report.suspects.find(suspect => suspect.ref === 'C2')!;
    expect(c2.flags).toEqual(['easy-to-miss']);
    expect(c2).toMatchObject({ sizeCode: '0402', kind: 'capacitor', toGround: true, hop: 0, nets: ['PP3V3'], rails: ['PP3V3'] });
    expect(report.suspects.find(suspect => suspect.ref === 'C4')).toMatchObject({ hop: 1, nets: ['PP3V3_L'] });
  });
  it('never lists the rail\'s own link parts or test points as suspects; links are isolation points, ground links are listed', () => {
    const report = findShortSuspects(graph, ['PP3V3']);
    expect(refs(report)).not.toContain('L1');
    expect(refs(report)).not.toContain('TP1');
    expect(report.isolation.map(point => point.ref)).toEqual(['L1']);
    expect(report.isolation[0]).toMatchObject({
      linkClass: 'inductor', splits: true, action: 'lift-and-measure', balance: 0.1,
      sides: [{ nets: ['PP3V3'], netCount: 1, suspects: 9, pins: ['1'] }, { nets: ['PP3V3_L'], netCount: 1, suspects: 1, pins: ['2'] }],
    });
    expect(report.isolationTotal).toBe(1);
    expect(report.groundLinks).toEqual([{ componentId: graph.component(8).id, ref: 'R2', value: '0R', linkClass: 'jumper', net: 'PP3V3' }]);
  });
  it('uses a measured resistance: a dead short points at capacitors, tens of ohms at ICs', () => {
    const hard = findShortSuspects(graph, [{ net: 'PP3V3', resistanceOhms: 0.2 }]);
    expect(reasonsOf(hard, 'C2')).toContainEqual(['hard-short', 10]);
    expect(reasonsOf(hard, 'Q1')).toContainEqual(['hard-short', 10]);
    expect(reasonsOf(hard, 'U1')).not.toContainEqual(['hard-short', 10]);
    expect(hard.rails[0].resistanceOhms).toBe(0.2);
    const soft = findShortSuspects(graph, [{ net: 'PP3V3', resistanceOhms: 25 }]);
    expect(reasonsOf(soft, 'U1')).toContainEqual(['soft-short', 10]);
    expect(reasonsOf(soft, 'C2')).toContainEqual(['soft-short', -5]);
    expect(refs(soft).indexOf('U1')).toBeLessThan(refs(hard).indexOf('U1'));
  });
  it('honours the limit and the walk options', () => {
    expect(findShortSuspects(graph, ['PP3V3'], { limit: 3 })).toMatchObject({ total: 11 });
    expect(refs(findShortSuspects(graph, ['PP3V3'], { limit: 3 }))).toEqual(['C10', 'C1', 'C3']);
    const noHops = findShortSuspects(graph, ['PP3V3'], { hops: 0 });
    expect(refs(noHops)).not.toContain('C4');
    expect(refs(noHops)).toContain('L1'); // not walked: it is a part on the rail like any other
    expect(noHops.beyondHops).toBe(1);
  });
  it('reports unknown, ground and no-connect nets and walks a repeated rail once', () => {
    const board = buildNetGraph(kitBoard([...parts, two('R9', '0R', 'X', 'NC')]));
    const report = findShortSuspects(board, ['NOPE', 'GND', 'NC', 'PP3V3', 'PP3V3']);
    expect(report.rails.map(rail => [rail.net, rail.status])).toEqual([['NOPE', 'unknown-net'], ['GND', 'ground'], ['NC', 'no-connect'], ['PP3V3', 'ok']]);
    expect(report.common).toBeNull();
  });
  it('leaves out parts that are not fitted (a DNP value or listed) and counts them', () => {
    const board = kitBoard([...parts, two('C50', '10u DNP', 'PP3V3', 'GND', { package: 'C_1206_3216Metric' }), two('C51', '10u', 'PP3V3', 'GND', { package: 'C_1206_3216Metric' })]);
    const listed = buildNetGraph(board, { notFitted: new Set([board.components.find(component => component.ref === 'C51')!.id]) });
    const report = findShortSuspects(listed, ['PP3V3']);
    expect(refs(report)).not.toContain('C50');
    expect(refs(report)).not.toContain('C51');
    expect(report.notFitted).toBe(2);
    expect(report.total).toBe(11);
  });
  it('reads rated voltages from value texts', () => {
    expect(ratedVolts('22uF 6.3V')).toBe(6.3);
    expect(ratedVolts('C_4u7_0402_10V')).toBe(10);
    expect(ratedVolts('100nF/16V/X7R')).toBe(16);
    expect(ratedVolts('3V3')).toBeNull();
    expect(ratedVolts('100n')).toBeNull();
    expect(ratedVolts('')).toBeNull();
  });
});

describe('findShortSuspects: isolation points in bisection order', () => {
  const caps = (net: string, count: number, from: number): KitPart[] => Array.from({ length: count }, (_, i) => two(`C${from + i}`, '1u', net, 'GND'));
  const chain: KitPart[] = [two('F1', '2A', 'A', 'B'), two('L1', '1uH', 'B', 'C'), two('FB1', '600R@100MHz', 'C', 'D'), ...caps('A', 1, 1), ...caps('B', 4, 10), ...caps('C', 4, 20), ...caps('D', 1, 30)];
  it('lifts the link that halves the suspects first', () => {
    const report = findShortSuspects(buildNetGraph(kitBoard(chain)), ['A']);
    expect(report.isolation.map(point => [point.ref, point.splits, point.balance])).toEqual([['L1', true, 0.5], ['F1', true, 0.1], ['FB1', true, 0.1]]);
    expect(report.isolation[0].sides.map(side => [side.nets, side.suspects])).toEqual([[['A', 'B'], 5], [['C', 'D'], 5]]);
  });
  it('lists parallel links after the splitting ones', () => {
    const report = findShortSuspects(buildNetGraph(kitBoard([...chain, two('F2', '2A', 'A', 'B')])), ['A']);
    expect(report.isolation.map(point => [point.ref, point.splits])).toEqual([['L1', true], ['FB1', true], ['F1', false], ['F2', false]]);
    expect(report.isolation[2].sides.map(side => side.suspects)).toEqual([1, 4]);
  });
  it('equals a brute-force reference (remove the link, search what stays connected) on 300 random domains', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = seeded(seed);
      const netCount = 2 + Math.floor(random() * 9);
      const parts: KitPart[] = [];
      for (let i = 1; i < netCount; i++) parts.push(two(`R${i}`, '0R', `N${Math.floor(random() * i)}`, `N${i}`)); // a random tree
      for (let i = 0; i < Math.floor(random() * 4); i++) parts.push(two(`RX${i}`, '0R', `N${Math.floor(random() * netCount)}`, `N${Math.floor(random() * netCount)}`)); // loops
      for (let i = 0; i < netCount * 2; i++) if (random() < 0.5) parts.push(two(`C${i}`, '1u', `N${Math.floor(random() * netCount)}`, 'GND'));
      parts.push(two('CZ', '1u', 'Z', 'GND')); // GND by name on every board
      const graph = buildNetGraph(kitBoard(parts));
      const report = findShortSuspects(graph, ['N0'], { hops: 3 });
      const domain = new Set(report.rails[0].domain.map(entry => entry.net));
      // The domain's links and each suspect's net of lowest hop (ties: lower net index), as the report counts them.
      const settings = normalizeLinkSettings();
      const links = parts.flatMap((part, index) => {
        const link = linkOf(graph, index, settings);
        return link && link.type === 'link' && domain.has(graph.netName(link.nets[0])) && domain.has(graph.netName(link.nets[1])) && link.nets[0] !== link.nets[1]
          ? [{ ref: part.ref, a: graph.netName(link.nets[0]), b: graph.netName(link.nets[1]) }] : [];
      });
      const hopOf = new Map(report.rails[0].domain.map(entry => [entry.net, entry.hop]));
      const suspectNet = new Map<string, number>();
      for (const suspect of report.suspects) {
        if (!suspect.toGround) continue;
        const net = [...suspect.nets].sort((x, y) => hopOf.get(x)! - hopOf.get(y)! || graph.netIndex(x) - graph.netIndex(y))[0];
        suspectNet.set(net, (suspectNet.get(net) ?? 0) + 1);
      }
      const reachable = (from: string, without: string) => {
        const seen = new Set([from]);
        for (let changed = true; changed;) {
          changed = false;
          for (const link of links) {
            if (link.ref === without) continue;
            if (seen.has(link.a) && !seen.has(link.b)) { seen.add(link.b); changed = true; }
            if (seen.has(link.b) && !seen.has(link.a)) { seen.add(link.a); changed = true; }
          }
        }
        return seen;
      };
      expect(report.isolationTotal, `seed ${seed}`).toBe(links.length);
      for (const point of report.isolation) {
        const link = links.find(item => item.ref === point.ref)!;
        const sideA = reachable(link.a, link.ref);
        const splits = !sideA.has(link.b);
        expect(point.splits, `seed ${seed} ${point.ref}`).toBe(splits);
        if (!splits) continue;
        const sideB = reachable(link.b, link.ref);
        const count = (side: Set<string>) => [...side].reduce((sum, net) => sum + (suspectNet.get(net) ?? 0), 0);
        expect(point.sides.map(side => side.netCount), `seed ${seed} ${point.ref}`).toEqual([sideA.size, sideB.size]);
        expect(point.sides.map(side => side.suspects), `seed ${seed} ${point.ref}`).toEqual([count(sideA), count(sideB)]);
      }
      // Bisection order: splitting links first, by falling balance.
      const balances = report.isolation.map(point => (point.splits ? point.balance : -1));
      expect(balances, `seed ${seed}`).toEqual([...balances].sort((x, y) => y - x));
    }
  });
});

describe('findShortSuspects: several shorted rails', () => {
  const parts: KitPart[] = [
    { ref: 'U1', pins: ['P1V8', 'P3V3', 'GND', 'GND'] },
    two('C5', '100n', 'P1V8', 'P3V3'),
    two('C6', '1u', 'P1V8', 'GND'),
    two('C7', '1u', 'P3V3', 'GND'),
    { ref: 'U2', pins: ['P3V3', 'GND'] },
  ];
  it('names the parts on two or more rails and scores them higher', () => {
    const report = findShortSuspects(buildNetGraph(kitBoard(parts)), ['P1V8', 'P3V3']);
    expect(report.common!.joined).toEqual([]);
    expect(report.common!.sharedParts.map(part => [part.ref, part.rails])).toEqual([['U1', ['P1V8', 'P3V3']], ['C5', ['P1V8', 'P3V3']]]);
    const u1 = report.suspects.find(suspect => suspect.ref === 'U1')!;
    expect(u1.flags).toContain('common-element');
    expect(u1.reasons).toContainEqual(expect.objectContaining({ code: 'common-element', weight: 30 }));
    expect(refs(report)[0]).toBe('U1');
  });
  it('says when two rails are one node through link parts', () => {
    const report = findShortSuspects(buildNetGraph(kitBoard([...parts, two('R1', '0R', 'P1V8', 'P1V8_B'), two('R2', '0R', 'P1V8_B', 'P3V3')])), ['P1V8', 'P3V3']);
    expect(report.common!.joined).toEqual([{ rails: ['P1V8', 'P3V3'], nets: ['P1V8', 'P1V8_B', 'P3V3'] }]);
  });
});

describe('findShortSuspects: board-level facts', () => {
  it('treats every part as reaching ground when the board has no ground net, and says so', () => {
    // No net is named like ground and the two largest nets tie, so the largest-net fallback does not apply either.
    const graph = buildNetGraph(kitBoard([two('C1', '100n', 'A', 'B'), two('C2', '100n', 'A', 'C'), two('C3', '100n', 'B', 'C'), { ref: 'U1', pins: ['A', 'D'] }, two('R1', '1k', 'D', 'C')]));
    const report = findShortSuspects(graph, ['A']);
    expect(report.groundKnown).toBe(false);
    expect(report.suspects.find(suspect => suspect.ref === 'C1')!.reasons.map(reason => reason.code)).toEqual(['capacitor-to-ground', 'ground-unknown']);
  });
  it('groups capacitor suspects around the nearest IC', () => {
    const graph = buildNetGraph(kitBoard([
      { ref: 'U1', x: 0, y: 0, bounds: { minX: -3, minY: -3, maxX: 3, maxY: 3 }, pins: [{ net: 'VDD', x: -2, y: -2 }, { net: 'GND', x: 2, y: 2 }] },
      { ref: 'U2', x: 40, y: 0, bounds: { minX: 37, minY: -3, maxX: 43, maxY: 3 }, pins: [{ net: 'VDD', x: 38, y: 0 }, { net: 'GND', x: 42, y: 0 }] },
      ...[[5, 0], [0, 6], [-7, 1], [44, 2], [20, 0]].map(([x, y], i) => ({ ref: `C${i + 1}`, value: '100n', x, y, pins: [{ net: 'VDD', x, y }, { net: 'GND', x: x + 0.5, y }] })),
    ]));
    const report = findShortSuspects(graph, ['VDD']);
    expect(report.groups).toEqual([
      { anchor: { componentId: graph.component(0).id, ref: 'U1' }, capacitors: ['C1', 'C2', 'C3'], count: 3 },
      { anchor: { componentId: graph.component(1).id, ref: 'U2' }, capacitors: ['C4'], count: 1 },
    ]);
  });
  it('only ever names parts of the board that touch the shorted domain (300 random boards)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = seeded(seed);
      const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
      const nets = ['R0', 'R1', 'R2', 'S0', 'S1', 'GND', 'NC'];
      const kinds = [['C', '1u'], ['R', '0R'], ['R', '10K'], ['L', '1uH'], ['D', 'BAT54'], ['Q', ''], ['U', ''], ['TP', ''], ['J', '']] as const;
      const parts: KitPart[] = Array.from({ length: 5 + Math.floor(random() * 25) }, (_, i) => {
        const [prefix, value] = pick(kinds);
        return { ref: `${prefix}${i}`, value, pins: Array.from({ length: prefix === 'U' || prefix === 'J' ? 3 : prefix === 'TP' ? 1 : 2 }, () => pick(nets)) };
      });
      const graph = buildNetGraph(kitBoard([...parts, two('CG', '1u', 'S1', 'GND')]));
      const report = findShortSuspects(graph, ['R0', 'R1']);
      const domain = new Set(report.rails.flatMap(rail => rail.domain.map(entry => entry.net)));
      for (const suspect of report.suspects) {
        const component = graph.component(graph.partIndex(suspect.componentId));
        expect(component.ref).toBe(suspect.ref);
        expect(suspect.nets.every(net => domain.has(net)), `seed ${seed} ${suspect.ref}`).toBe(true);
        expect(suspect.kind).not.toBe('testpoint');
        expect(suspect.score).toBe(suspect.reasons.reduce((sum, reason) => sum + reason.weight, 0));
      }
      expect(report.suspects.map(suspect => suspect.score)).toEqual([...report.suspects.map(suspect => suspect.score)].sort((a, b) => b - a));
    }
  });
});

describe('findShortSuspects: cost', () => {
  const capacitorRail = (count: number): NetGraph => {
    const parts: KitPart[] = [{ ref: 'U1', x: 0, y: 0, pins: ['PP1V8', 'GND'] }];
    for (let i = 0; i < count; i++) parts.push(two(`C${i}`, i % 2 ? '100n' : '10uF 6.3V', i % 3 ? 'PP1V8' : `PP1V8_${i % 50}`, 'GND', { package: i % 2 ? 'C_0402_1005Metric' : 'C_0805_2012Metric' }));
    for (let i = 0; i < 50; i++) parts.push(two(`L${i}`, '1uH', 'PP1V8', `PP1V8_${i}`));
    return buildNetGraph(kitBoard(parts));
  };
  it('stays linear on a rail holding 50,000 capacitors behind 50 inductors', () => {
    const report = findShortSuspects(capacitorRail(50_000), ['PP1V8']);
    expect(report.total).toBe(50_001);
    expect(report.suspects.length).toBe(100);
    expect(report.isolationTotal).toBe(50);
    expectScaling('findShortSuspects on a rail of capacitors', [3125, 12_500, 50_000], count => { const graph = capacitorRail(count); return () => findShortSuspects(graph, ['PP1V8']); });
  }, 60_000);
  it('stays linear on a star of 40,000 links (returns the first 50 isolation points, counts all)', () => {
    const star = (leaves: number): NetGraph => {
      const parts: KitPart[] = [two('C0', '1u', 'HUB', 'GND')];
      for (let i = 0; i < leaves; i++) { parts.push(two(`R${i}`, '0R', 'HUB', `LEAF${i}`)); parts.push(two(`C${i + 1}`, '1u', `LEAF${i}`, 'GND')); }
      return buildNetGraph(kitBoard(parts));
    };
    const report = findShortSuspects(star(40_000), ['HUB'], { maxNetPins: Infinity });
    expect(report.isolationTotal).toBe(40_000);
    expect(report.isolation.length).toBe(MAX_ISOLATION_POINTS);
    expectScaling('findShortSuspects on a star', [2500, 10_000, 40_000], leaves => { const graph = star(leaves); return () => findShortSuspects(graph, ['HUB'], { maxNetPins: Infinity }); });
  }, 60_000);
});
