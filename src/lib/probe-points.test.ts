import { describe, expect, it } from 'vitest';
import { buildNetGraph } from './net-graph';
import { expectScaling } from '../test-support/timing';
import { kitBoard, largeBoard, seeded, two, type KitPart } from './net-testkit';
import { DEFAULT_LARGE_PART_PINS, pinAccess, rankProbePoints } from './probe-points';

const codes = (reasons: ReadonlyArray<{ code: string }>) => reasons.map(reason => reason.code);

/** A 40-ball BGA at (50, 50) on top, its balls on SIG and filler nets. */
const bga = (ref: string, net: string, x = 50, y = 50, side: 'top' | 'bottom' = 'top', packageName = 'BGA-40'): KitPart => ({
  ref, package: packageName, side, x, y, bounds: { minX: x - 5, minY: y - 5, maxX: x + 5, maxY: y + 5 },
  pins: Array.from({ length: 64 }, (_, k) => ({ net: k === 0 ? net : `${ref}_F${k}`, number: `${'ABCDEFGH'[k >> 3]}${(k & 7) + 1}`, x: x - 4 + (k & 7), y: y - 4 + (k >> 3) })),
});

describe('rankProbePoints: ranking and reasons', () => {
  const parts: KitPart[] = [
    bga('U1', 'SIG'),
    { ref: 'TP1', pins: [{ net: 'SIG', x: 10, y: 10, width: 1.5, height: 1.5, shape: 'round' }], x: 10, y: 10 },
    { ref: 'J1', pins: [{ net: 'SIG', x: 80, y: 10, side: 'both', width: 1.7, height: 1.7, shape: 'square' }, { net: 'GND', x: 82.54, y: 10, side: 'both' }], x: 81, y: 10 },
    { ref: 'C1', value: '100n', package: 'C_0402_1005Metric', pins: [{ net: 'SIG', x: 20, y: 20, width: 0.6, height: 0.5, shape: 'rect' }, { net: 'GND', x: 21, y: 20, width: 0.6, height: 0.5, shape: 'rect' }], x: 20.5, y: 20 },
    { ref: 'C2', value: '100n', package: 'C_0201_0603Metric', pins: [{ net: 'SIG', x: 30, y: 30, width: 0.3, height: 0.3, shape: 'rect' }, { net: 'GND', x: 30.6, y: 30, width: 0.3, height: 0.3, shape: 'rect' }], x: 30.3, y: 30 },
    // A resistor hidden under U1's body on the same side.
    { ref: 'R1', value: '10K', pins: [{ net: 'SIG', x: 49, y: 51, width: 0.6, height: 0.5, shape: 'rect' }, { net: 'X', x: 50, y: 51, width: 0.6, height: 0.5, shape: 'rect' }], x: 49.5, y: 51 },
    // The same under U1 but on the other side: reachable.
    { ref: 'R2', value: '10K', side: 'bottom', pins: [{ net: 'SIG', x: 51, y: 49, width: 0.6, height: 0.5, shape: 'rect' }, { net: 'Y', x: 52, y: 49, width: 0.6, height: 0.5, shape: 'rect' }], x: 51.5, y: 49 },
  ];
  const graph = buildNetGraph(kitBoard(parts));

  it('puts the test point first, then the through-hole connector pin, then the larger chip pad', () => {
    const result = rankProbePoints(graph, 'SIG', { limit: 10 });
    expect(result.status).toBe('ok');
    expect(result.total).toBe(7);
    expect(result.points.map(point => point.ref)).toEqual(['TP1', 'J1', 'C1', 'R2', 'C2', 'R1', 'U1']);
    expect(result.points.slice(0, 5).every(point => point.accessible)).toBe(true);
    expect(result.points.slice(5).every(point => !point.accessible)).toBe(true);
    expect(codes(result.points[0].reasons)).toEqual(['testpoint', 'pad-area']);
    expect(codes(result.points[1].reasons)).toEqual(['connector', 'through-hole', 'pad-area']);
    expect(codes(result.points[4].reasons)).toEqual(['tiny-pad', 'small-part']);
  });
  it('explains why a pad cannot be reached', () => {
    const result = rankProbePoints(graph, 'SIG', { limit: 10 });
    const r1 = result.points.find(point => point.ref === 'R1')!;
    expect(codes(r1.reasons)).toContain('under-part');
    expect(r1.reasons.find(reason => reason.code === 'under-part')!.params).toEqual({ ref: 'U1', pins: 64 });
    const u1 = result.points.find(point => point.ref === 'U1')!;
    expect(codes(u1.reasons)).toContain('ball-grid');
    expect(u1.pin).toBe('A1');
  });
  it('the score is the sum of the listed reasons', () => {
    for (const point of rankProbePoints(graph, 'SIG', { limit: 10, side: 'top', viewCenter: { x: 0, y: 0 } }).points) {
      const sum = point.reasons.reduce((total, reason) => total + reason.delta, 0);
      expect(point.score).toBeCloseTo(sum, 6);
    }
  });
  it('returns three points by default and honours the limit', () => {
    expect(rankProbePoints(graph, 'SIG').points.length).toBe(3);
    expect(rankProbePoints(graph, 'SIG', { limit: 1 }).points.map(point => point.ref)).toEqual(['TP1']);
    expect(rankProbePoints(graph, 'SIG', { limit: 0 }).points).toEqual([]);
  });
  it('penalises the side not in view and distance from the view centre', () => {
    const top = rankProbePoints(graph, 'SIG', { limit: 10, side: 'top' });
    expect(codes(top.points.find(point => point.ref === 'R2')!.reasons)).toContain('other-side');
    expect(codes(top.points.find(point => point.ref === 'J1')!.reasons)).not.toContain('other-side'); // through-hole
    const near = rankProbePoints(graph, 'SIG', { limit: 10, viewCenter: { x: 80, y: 10 } });
    expect(near.points[0].ref).toBe('TP1'); // 70 mm away, still a test point
    const distance = near.points.find(point => point.ref === 'TP1')!.reasons.find(reason => reason.code === 'distance')!;
    expect(distance.delta).toBe(-7);
    expect(distance.params).toEqual({ mm: 70 });
    expect(near.points.find(point => point.ref === 'J1')!.reasons.some(reason => reason.code === 'distance')).toBe(false);
  });
  it('keeps every pin of a part with onePerPart off', () => {
    const board = buildNetGraph(kitBoard([{ ref: 'U5', pins: ['A', 'A', 'A', 'A', 'B'] }, two('C1', '1u', 'A', 'GND')]));
    expect(rankProbePoints(board, 'A', { limit: 10 }).total).toBe(2);
    expect(rankProbePoints(board, 'A', { limit: 10, onePerPart: false }).total).toBe(5);
  });
  it('reports unknown and no-connect nets', () => {
    expect(rankProbePoints(graph, 'NOPE')).toMatchObject({ status: 'unknown-net', points: [] });
    const nc = buildNetGraph(kitBoard([two('R1', '0R', 'A', 'NC')]));
    expect(rankProbePoints(nc, 'NC').status).toBe('no-connect');
  });
});

describe('pinAccess: rules', () => {
  it('reads ball grids from the package or from ball names, and a QFN centre pad as under the body', () => {
    const graph = buildNetGraph(kitBoard([
      bga('U1', 'S', 50, 50, 'top', 'FBGA-64'),
      bga('U2', 'S', 150, 50, 'top', 'QFN-64'), // ball names on 64 pins: still a grid
      { ref: 'U3', package: 'QFN-16', x: 0, y: 0, bounds: { minX: -2, minY: -2, maxX: 2, maxY: 2 },
        pins: [...Array.from({ length: 16 }, (_, k) => ({ net: `Q${k}`, x: -1.8 + (k % 4) * 1.2, y: k < 8 ? -1.9 : 1.9 })), { net: 'S', x: 0, y: 0, width: 2, height: 2, shape: 'rect' as const }] },
    ]));
    const pin = (ref: string, net: string) => [...graph.netPins(graph.netIndex(net))].find(index => graph.component(graph.pinPart[index]).ref === ref)!;
    expect(codes(pinAccess(graph, pin('U1', 'S')).reasons)).toContain('ball-grid');
    expect(codes(pinAccess(graph, pin('U2', 'S')).reasons)).toContain('ball-grid');
    const centre = pinAccess(graph, pin('U3', 'S'));
    expect(codes(centre.reasons)).toContain('under-body');
    expect(centre.accessible).toBe(false);
  });
  it('uses the large-part limit', () => {
    const graph = buildNetGraph(kitBoard([
      { ref: 'U1', x: 0, y: 0, bounds: { minX: -5, minY: -5, maxX: 5, maxY: 5 }, pins: Array.from({ length: 30 }, (_, k) => ({ net: `F${k}`, x: -4.5 + k * 0.3, y: -4.8 })) },
      { ref: 'C1', pins: [{ net: 'S', x: 0, y: 0 }, { net: 'GND', x: 1, y: 0 }], x: 0.5, y: 0 },
    ]));
    const c1 = graph.netPins(graph.netIndex('S'))[0];
    expect(DEFAULT_LARGE_PART_PINS).toBe(50);
    expect(pinAccess(graph, c1).accessible).toBe(true);
    expect(pinAccess(graph, c1, { largePartPins: 20 }).accessible).toBe(false);
  });
  it('gives no size reason weight when the file has no pad size', () => {
    const graph = buildNetGraph(kitBoard([{ ref: 'C1', pins: [{ net: 'S', radius: 0 }, { net: 'GND', radius: 0 }] }]));
    const access = pinAccess(graph, 0);
    expect(access.reasons.find(reason => reason.code === 'pad-size-unknown')).toMatchObject({ delta: 0 });
  });
});

describe('rankProbePoints: the best few equal the head of the full ranking', () => {
  it('on 40 random nets, for limits 1, 3, 10, 64 and 65 and without one part per part', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = seeded(seed);
      const parts: KitPart[] = Array.from({ length: 5 + Math.floor(random() * 120) }, (_, i): KitPart => {
        const x = Math.floor(random() * 20) * 2.5, y = Math.floor(random() * 20) * 2.5;
        const pad = random() < 0.3 ? 0.4 : 1;
        return { ref: i % 9 === 0 ? `TP${i}` : `C${i}`, value: '100n', x, y, side: random() < 0.2 ? 'bottom' : 'top',
          pins: i % 9 === 0 ? [{ net: 'SIG', x, y, width: pad, height: pad }] : [{ net: 'SIG', x, y, width: pad, height: pad }, { net: 'GND', x: x + 1, y }] };
      });
      const graph = buildNetGraph(kitBoard(parts));
      for (const onePerPart of [true, false]) {
        const everything = rankProbePoints(graph, 'SIG', { limit: 100_000, onePerPart });
        for (const limit of [1, 3, 10, 64, 65]) {
          const few = rankProbePoints(graph, 'SIG', { limit, onePerPart });
          expect(few.points, `seed ${seed} limit ${limit}`).toEqual(everything.points.slice(0, limit));
          expect(few.total).toBe(everything.total);
        }
      }
    }
  });
});

describe('rankProbePoints: cost', () => {
  it('stays linear in the pins of the net (a ground net of a 100k-pin board)', () => {
    expect(rankProbePoints(buildNetGraph(largeBoard(100_000)), 'GND').points.length).toBe(3);
    // The ground net holds about 30 % of the pins; the large-part list is built on the first call and kept.
    expectScaling('rankProbePoints on GND', [10_000, 40_000, 160_000], size => { const graph = buildNetGraph(largeBoard(size)); return () => rankProbePoints(graph, 'GND'); });
  }, 60_000);
});
