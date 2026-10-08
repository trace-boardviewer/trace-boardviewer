import { describe, expect, it } from 'vitest';
import { CONFIDENCE_RADIUS_MM, locateShort, MAX_READINGS, type DropLocatorOptions, type DropReading } from './drop-locator';
import { buildNetGraph, type NetGraph } from './net-graph';
import { expectScaling } from '../test-support/timing';
import { kitBoard, seeded, type KitPart } from './net-testkit';

/**
 * Potentials of a square grid of unit resistors (nodes 1 mm apart, insulating edges): current 1 goes in at `source` and out at
 * `sink`, which is held at 0. Successive over-relaxation until no node moves by more than 1e-10.
 */
function solveGrid(size: number, source: readonly [number, number], sink: readonly [number, number]): (x: number, y: number) => number {
  const n = size + 1;
  const v = new Float64Array(n * n);
  const at = (x: number, y: number) => y * n + x;
  for (let iteration = 0; iteration < 20_000; iteration++) {
    let change = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (x === sink[0] && y === sink[1]) continue;
      let sum = 0, degree = 0;
      if (x > 0) { sum += v[at(x - 1, y)]; degree++; }
      if (x < size) { sum += v[at(x + 1, y)]; degree++; }
      if (y > 0) { sum += v[at(x, y - 1)]; degree++; }
      if (y < size) { sum += v[at(x, y + 1)]; degree++; }
      const next = (sum + (x === source[0] && y === source[1] ? 1 : 0)) / degree;
      const updated = v[at(x, y)] + 1.9 * (next - v[at(x, y)]);
      change = Math.max(change, Math.abs(updated - v[at(x, y)]));
      v[at(x, y)] = updated;
    }
    if (change < 1e-10) break;
  }
  return (x, y) => v[at(Math.round(x), Math.round(y))];
}

interface PlaneCase { graph: NetGraph; caps: Array<[number, number]>; short: number; j1Rail: string; j1Ground: string; railField: (x: number, y: number) => number }

/** A 40 x 40 mm plane with 40 capacitors on random grid nodes (rail pad on the node, ground pad 0.5 mm right), J1 at the corner. */
function planeCase(seed: number): PlaneCase {
  const random = seeded(seed);
  const size = 40;
  const spots = new Set<string>();
  const caps: Array<[number, number]> = [];
  while (caps.length < 40) {
    const x = 2 + Math.floor(random() * (size - 4)), y = 2 + Math.floor(random() * (size - 4));
    if (spots.has(`${x},${y}`)) continue;
    spots.add(`${x},${y}`); caps.push([x, y]);
  }
  const parts: KitPart[] = caps.map(([x, y], i) => ({ ref: `C${i + 1}`, value: '1u', x, y, pins: [{ net: 'PP3V3', x, y }, { net: 'GND', x: x + 0.5, y }] }));
  parts.push({ ref: 'J1', x: 0, y: 0, pins: [{ net: 'PP3V3', x: 0, y: 0 }, { net: 'GND', x: 0, y: 1 }] });
  const graph = buildNetGraph(kitBoard(parts));
  const short = Math.floor(random() * caps.length);
  return {
    graph, caps, short, j1Rail: graph.pin(graph.partPins(caps.length)[0]).id, j1Ground: graph.pin(graph.partPins(caps.length)[1]).id,
    railField: solveGrid(size, [0, 0], caps[short]),
  };
}

const railPin = (c: PlaneCase, k: number) => c.graph.pin(c.graph.partPins(k)[0]).id;
const reading = (c: PlaneCase, k: number): DropReading => ({ pinId: railPin(c, k), value: c.railField(c.caps[k][0], c.caps[k][1]) * 1000 });
/** Ten capacitors other than the shorted one, in a seeded order. */
function measuredSet(c: PlaneCase, seed: number, count = 10): number[] {
  const random = seeded(seed * 31 + 7);
  const chosen: number[] = [];
  while (chosen.length < count) { const k = Math.floor(random() * c.caps.length); if (k !== c.short && !chosen.includes(k)) chosen.push(k); }
  return chosen;
}
const distanceToShort = (c: PlaneCase, x: number, y: number) => Math.hypot(x - c.caps[c.short][0], y - c.caps[c.short][1]);

describe('locateShort: a copper plane (resistor-grid simulation)', () => {
  it('puts the best location within 3 mm of the short from ten readings, and is never wrong when it says high', () => {
    let close = 0, high = 0, highWrong = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const c = planeCase(seed);
      const result = locateShort(c.graph, 'PP3V3', measuredSet(c, seed).map(k => reading(c, k)), { injection: { pinId: c.j1Rail } });
      expect(result.status).toBe('ok');
      const d = distanceToShort(c, result.best!.x, result.best!.y);
      if (d <= CONFIDENCE_RADIUS_MM) close++;
      if (result.confidence === 'high') { high++; if (d > CONFIDENCE_RADIUS_MM) highWrong++; }
      expect(result.injection).toEqual({ x: 0, y: 0, basis: 'given' });
    }
    // Measured: 18 close, 11 high (all right).
    expect(close).toBeGreaterThanOrEqual(17);
    expect(high).toBeGreaterThanOrEqual(9);
    expect(highWrong).toBe(0);
  });
  it('finds the shorted part by following the suggested next probes from three readings', () => {
    let found = 0, extra = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const c = planeCase(seed);
      const options: DropLocatorOptions = { injection: { pinId: c.j1Rail } };
      let readings = measuredSet(c, seed).slice(0, 3).map(k => reading(c, k));
      let steps = 0;
      for (; steps < 8; steps++) {
        const result = locateShort(c.graph, 'PP3V3', readings, options);
        if (result.best!.ref === `C${c.short + 1}` && result.nearProbability >= 0.6) break;
        const probe = result.nextProbes[0];
        // Suggestions are unmeasured pins of the net, one per part.
        expect(readings.some(r => r.pinId === probe.pinId)).toBe(false);
        const pin = c.graph.pin(c.graph.pinIndex(probe.pinId));
        readings = [...readings, { pinId: probe.pinId, value: c.railField(pin.x, pin.y) * 1000 }];
      }
      if (locateShort(c.graph, 'PP3V3', readings, options).best!.ref === `C${c.short + 1}`) { found++; extra += steps; }
    }
    // Measured: all 20, with 3.85 readings more on average.
    expect(found).toBe(20);
    expect(extra / found).toBeLessThan(6);
  });
  it('without the injection point assumes it at the highest reading and never says high', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const c = planeCase(seed);
      const result = locateShort(c.graph, 'PP3V3', measuredSet(c, seed).map(k => reading(c, k)));
      expect(result.confidence).not.toBe('high');
      expect(result.injection!.basis).toBe('highest-reading');
      expect(result.reasoning.map(reason => reason.code)).toContain('injection-assumed');
    }
  });
  it('reads drops measured the other way round and resistances to ground alike', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const c = planeCase(seed);
      const readings = measuredSet(c, seed).map(k => reading(c, k));
      const options: DropLocatorOptions = { injection: { pinId: c.j1Rail } };
      const plain = locateShort(c.graph, 'PP3V3', readings, options);
      const reversed = locateShort(c.graph, 'PP3V3', readings.map(r => ({ ...r, value: 50 - r.value })), { ...options, polarity: 'highest-at-short' });
      const ohms = locateShort(c.graph, 'PP3V3', readings.map(r => ({ ...r, value: 0.12 + r.value / 1000 })), options); // 0.12 Ω short plus copper
      expect(reversed.best!.ref).toBe(plain.best!.ref);
      expect(ohms.best!.ref).toBe(plain.best!.ref);
      expect(reversed.confidence).toBe(plain.confidence);
    }
  });
  it('works on the ground side: readings on GND pads, candidates on the shorted rail, highest at the short', () => {
    let close = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const c = planeCase(seed);
      // Ground plane: current enters at the shorted capacitor's ground pad and leaves at J1's ground pin (the supply clamp).
      const groundField = solveGrid(40, [Math.round(c.caps[c.short][0] + 0.5), c.caps[c.short][1]], [0, 1]);
      const readings = measuredSet(c, seed).map(k => ({ pinId: c.graph.pin(c.graph.partPins(k)[1]).id, value: groundField(c.caps[k][0] + 0.5, c.caps[k][1]) * 1000 }));
      expect(locateShort(c.graph, 'GND', readings).status).toBe('ground'); // the shorted rail is needed
      const result = locateShort(c.graph, 'GND', readings, { rail: 'PP3V3', injection: { pinId: c.j1Ground } });
      expect(result.status).toBe('ok');
      if (distanceToShort(c, result.best!.x - 0.5, result.best!.y) <= CONFIDENCE_RADIUS_MM) close++;
    }
    expect(close).toBeGreaterThanOrEqual(8); // measured 9 of 10
  });
  it('is deterministic', () => {
    const c = planeCase(3);
    const readings = measuredSet(c, 3).map(k => reading(c, k));
    expect(locateShort(c.graph, 'PP3V3', readings, { injection: { pinId: c.j1Rail } })).toEqual(locateShort(c.graph, 'PP3V3', readings, { injection: { pinId: c.j1Rail } }));
  });
});

describe('locateShort: a straight trace', () => {
  // Capacitors every 3 mm along y = 0 from x = 3 to 60; current in at x = 0, short at the capacitor at x = 33.
  const xs = Array.from({ length: 20 }, (_, i) => 3 + 3 * i);
  const parts: KitPart[] = xs.map((x, i) => ({ ref: `C${i + 1}`, value: '1u', x, y: 0, pins: [{ net: 'PP1V8', x, y: 0 }, { net: 'GND', x, y: 1 }] }));
  parts.push({ ref: 'J1', pins: [{ net: 'PP1V8', x: 0, y: 0 }, { net: 'GND', x: 0, y: 1 }] });
  const graph = buildNetGraph(kitBoard(parts));
  const potential = (x: number) => Math.max(0, 33 - x) * 2; // 2 mV per mm toward the short, flat beyond it
  const at = (i: number): DropReading => ({ pinId: graph.pin(graph.partPins(i)[0]).id, value: potential(xs[i]) });
  it('finds the part at the end of the falling readings', () => {
    // Readings at x = 3, 12, 21, 30 (falling) and 42 (beyond the short, at its level).
    const result = locateShort(graph, 'PP1V8', [0, 3, 6, 9, 13].map(at), { injection: { x: 0, y: 0 } });
    expect(result.best!.ref).toBe('C11');
    expect(result.best!.model).toBe('linear');
    expect(result.reasoning[0]).toMatchObject({ code: 'lowest-reading', params: { value: 0, at: 'C14.1' } });
  });
  it('says when readings beyond the short form a plateau and does not claim high confidence then', () => {
    const result = locateShort(graph, 'PP1V8', [0, 3, 6, 12, 15, 18].map(at), { injection: { x: 0, y: 0 } });
    expect(result.reasoning.map(reason => reason.code)).toContain('plateau');
    expect(result.confidence).not.toBe('high');
    expect(Math.abs(result.best!.x - 33)).toBeLessThanOrEqual(6);
  });
  it('says to measure further when all readings fall the same way (the short lies beyond them)', () => {
    const result = locateShort(graph, 'PP1V8', [0, 1, 2, 3, 4].map(at), { injection: { x: 0, y: 0 } });
    expect(result.outside).toBe(true);
    expect(result.estimate!.x).toBeGreaterThan(15);
    expect(result.reasoning.map(reason => reason.code)).toContain('beyond-readings');
    expect(result.confidence).not.toBe('high');
  });
});

describe('locateShort: a branched trace with bends (the weak case, characterised)', () => {
  it('locates some shorts, finds more by following the probes, and rarely claims high confidence wrongly', () => {
    // J1 at (0, 0) -> (40, 0) -> (40, 30), a branch from (20, 0) up to (20, 16); copper nodes every 1 mm, a capacitor on every third.
    const nodes: Array<[number, number]> = [];
    const adjacency: number[][] = [];
    const add = (x: number, y: number, from: number) => { nodes.push([x, y]); adjacency.push([]); const node = nodes.length - 1; if (from >= 0) { adjacency[from].push(node); adjacency[node].push(from); } return node; };
    let last = add(0, 0, -1), junction = -1;
    for (let x = 1; x <= 40; x++) { last = add(x, 0, last); if (x === 20) junction = last; }
    for (let y = 1; y <= 30; y++) last = add(40, y, last);
    for (let y = 1, node = junction; y <= 16; y++) node = add(20, y, node);
    const hops = (from: number) => { const d = new Array<number>(nodes.length).fill(-1); d[from] = 0; const queue = [from]; for (let h = 0; h < queue.length; h++) for (const m of adjacency[queue[h]]) if (d[m] < 0) { d[m] = d[queue[h]] + 1; queue.push(m); } return d; };
    const capNodes = nodes.map((_, node) => node).filter(node => node >= 2 && (node - 2) % 3 === 0);
    const parts: KitPart[] = capNodes.map((node, i) => ({ ref: `C${i + 1}`, value: '1u', x: nodes[node][0], y: nodes[node][1], pins: [{ net: 'PP1V8', x: nodes[node][0], y: nodes[node][1] }, { net: 'GND', x: nodes[node][0] + 0.5, y: nodes[node][1] + 0.5 }] }));
    parts.push({ ref: 'J1', pins: [{ net: 'PP1V8', x: 0, y: 0 }, { net: 'GND', x: 0, y: -1 }] });
    const graph = buildNetGraph(kitBoard(parts));
    const nodeAt = new Map(nodes.map(([x, y], node) => [`${x},${y}`, node]));
    let cases = 0, close = 0, found = 0, highWrong = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const random = seeded(seed);
      const s = Math.floor(random() * capNodes.length), sink = capNodes[s];
      // 10 mV per mm of copper from the short to where a pad's branch leaves the J1-to-short path.
      const fromSink = hops(sink), fromSource = hops(0);
      const potential = (node: number) => (fromSink[node] - (fromSink[node] + fromSource[node] - fromSink[0]) / 2) * 10;
      const chosen: number[] = [];
      while (chosen.length < 8) { const k = Math.floor(random() * capNodes.length); if (k !== s && !chosen.includes(k)) chosen.push(k); }
      const readingAt = (pinId: string): DropReading => { const pin = graph.pin(graph.pinIndex(pinId)); return { pinId, value: potential(nodeAt.get(`${pin.x},${pin.y}`)!) }; };
      const readings = chosen.map(k => readingAt(graph.pin(graph.partPins(k)[0]).id));
      const options: DropLocatorOptions = { injection: { x: 0, y: 0 } };
      const result = locateShort(graph, 'PP1V8', readings, options);
      if (!result.best) continue; // every reading beyond the short: flat
      cases++;
      const near = (x: number, y: number) => Math.hypot(x - nodes[sink][0], y - nodes[sink][1]) <= CONFIDENCE_RADIUS_MM;
      if (near(result.best.x, result.best.y)) close++; else if (result.confidence === 'high') highWrong++;
      let current = readings.slice(0, 3);
      for (let step = 0; step < 8; step++) {
        const next = locateShort(graph, 'PP1V8', current, options);
        if (next.best && near(next.best.x, next.best.y) && next.nearProbability >= 0.6) break;
        if (!next.nextProbes[0]) break;
        current = [...current, readingAt(next.nextProbes[0].pinId)];
      }
      const final = locateShort(graph, 'PP1V8', current, options);
      if (final.best && near(final.best.x, final.best.y)) found++;
    }
    // Measured: 36 cases, 10 close, 20 found by following the probes, 1 wrong answer said high.
    expect(cases).toBe(36);
    expect(close).toBeGreaterThanOrEqual(8);
    expect(found).toBeGreaterThanOrEqual(18);
    expect(highWrong).toBeLessThanOrEqual(2);
  });
});

describe('locateShort: inputs and edge cases', () => {
  const parts: KitPart[] = [
    ...Array.from({ length: 6 }, (_, i): KitPart => ({ ref: `C${i + 1}`, value: '1u', x: i * 5, y: 0, pins: [{ net: 'VCC', x: i * 5, y: 0 }, { net: 'GND', x: i * 5, y: 1 }] })),
    { ref: 'TP1', pins: [{ net: 'VCC', x: 50, y: 0 }] },
    { ref: 'TP2', pins: [{ net: 'ONLY_TP', x: 0, y: 5 }] }, { ref: 'TP3', pins: [{ net: 'ONLY_TP', x: 5, y: 5 }] }, { ref: 'TP4', pins: [{ net: 'ONLY_TP', x: 9, y: 5 }] },
    { ref: 'R1', value: '0R', pins: [{ net: 'X', x: 0, y: 9 }, { net: 'NC', x: 1, y: 9 }] },
  ];
  const graph = buildNetGraph(kitBoard(parts));
  const pinOf = (ref: string) => graph.pin(graph.partPins(parts.findIndex(part => part.ref === ref))[0]).id;
  const line = (values: number[]) => values.map((value, i): DropReading => ({ pinId: pinOf(`C${i + 1}`), value }));

  it('rejects readings it cannot place and says why', () => {
    const result = locateShort(graph, 'VCC', [
      ...line([50, 40, 30, 20]), { pinId: 'nope', value: 1 }, { pinId: graph.pin(graph.partPins(0)[1]).id, value: 1 }, { pinId: pinOf('C5'), value: Number.NaN }, { x: Number.NaN, y: 0, value: 3 },
    ]);
    expect(result.rejected).toEqual([{ index: 4, reason: 'unknown-pin' }, { index: 5, reason: 'not-on-net' }, { index: 6, reason: 'not-finite' }, { index: 7, reason: 'not-finite' }]);
    expect(result.readingsUsed).toBe(4);
  });
  it('takes board positions as well as pins', () => {
    const result = locateShort(graph, 'VCC', [{ x: 0, y: 0, value: 50 }, { x: 5, y: 0, value: 40 }, { x: 10, y: 0, value: 30 }, { x: 15, y: 0, value: 20 }]);
    expect(result.status).toBe('ok');
    expect(result.reasoning[0].detail).toContain('(15.0, 0.0)');
  });
  it('needs three readings and a gradient', () => {
    expect(locateShort(graph, 'VCC', line([5, 3]))).toMatchObject({ status: 'too-few-readings', readingsUsed: 2, best: null, confidence: 'none' });
    expect(locateShort(graph, 'VCC', line([7, 7, 7, 7])).status).toBe('flat-readings');
    expect(locateShort(graph, 'VCC', line([7, 7.5, 7, 7]), { noise: 1 }).status).toBe('flat-readings');
  });
  it('caps the number of readings', () => {
    const many = Array.from({ length: MAX_READINGS + 3 }, (_, i): DropReading => ({ x: i % 30, y: Math.floor(i / 30), value: i }));
    const result = locateShort(graph, 'VCC', many);
    expect(result.readingsUsed).toBe(MAX_READINGS);
    expect(result.rejected.map(r => r.reason)).toEqual(['over-limit', 'over-limit', 'over-limit']);
  });
  it('reports unknown, no-connect and ground nets and nets without candidates', () => {
    expect(locateShort(graph, 'NOPE', line([3, 2, 1])).status).toBe('unknown-net');
    expect(locateShort(graph, 'NC', line([3, 2, 1])).status).toBe('no-connect');
    expect(locateShort(graph, 'GND', line([3, 2, 1])).status).toBe('ground');
    expect(locateShort(graph, 'ONLY_TP', [{ pinId: pinOf('TP2'), value: 3 }, { pinId: pinOf('TP3'), value: 2 }, { pinId: pinOf('TP4'), value: 1 }]).status).toBe('no-candidates');
  });
  it('never names a test point and weighs parts by the prior (0 removes one)', () => {
    const readings = line([50, 40, 30, 20, 10]);
    const result = locateShort(graph, 'VCC', readings);
    expect(result.candidates.map(candidate => candidate.ref)).not.toContain('TP1');
    const without = locateShort(graph, 'VCC', readings, { prior: new Map([[result.best!.componentId, 0]]) });
    expect(without.candidates.map(candidate => candidate.ref)).not.toContain(result.best!.ref);
    const favoured = locateShort(graph, 'VCC', readings, { prior: new Map([[without.best!.componentId, 1000]]) });
    expect(favoured.best!.ref).toBe(without.best!.ref);
  });
  it('never names a part that is not fitted', () => {
    const readings = line([50, 40, 30, 20, 10]);
    const best = locateShort(graph, 'VCC', readings).best!;
    const listed = buildNetGraph(kitBoard(parts), { notFitted: new Set([best.componentId]) });
    expect(locateShort(listed, 'VCC', readings).candidates.map(candidate => candidate.ref)).not.toContain(best.ref);
  });
  it('limits candidates and next probes; suggests distinct, unmeasured parts', () => {
    const readings = line([50, 40, 30]);
    const result = locateShort(graph, 'VCC', readings, { limit: 2, suggest: 2 });
    expect(result.candidates.length).toBe(2);
    expect(result.nextProbes.length).toBeLessThanOrEqual(2);
    const refs = result.nextProbes.map(probe => probe.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs.some(ref => ['C1', 'C2', 'C3'].includes(ref))).toBe(false);
    expect(locateShort(graph, 'VCC', readings, { suggest: 0 }).nextProbes).toEqual([]);
  });
  it('probabilities add up to at most one and always state the stand-in geometry', () => {
    const result = locateShort(graph, 'VCC', line([50, 40, 30, 20, 10, 12]), { limit: 100 });
    const sum = result.candidates.reduce((total, candidate) => total + candidate.probability, 0);
    expect(sum).toBeCloseTo(1, 9);
    expect(result.reasoning.map(reason => reason.code)).toContain('proxy-geometry');
    expect(result.stability).toBeGreaterThanOrEqual(0);
    expect(result.stability).toBeLessThanOrEqual(1);
  });
});

describe('locateShort: cost', () => {
  it('grows linearly with the readings (a rail of 2,000 pins)', () => {
    const random = seeded(5);
    const parts: KitPart[] = Array.from({ length: 1000 }, (_, i): KitPart => {
      const x = random() * 100, y = random() * 100;
      return { ref: `C${i + 1}`, value: '1u', x, y, pins: [{ net: 'PP1V0', x, y }, { net: 'GND', x: x + 0.5, y }] };
    });
    for (let i = 0; i < 1000; i++) parts.push({ ref: `TP${i + 1}`, pins: [{ net: 'PP1V0', x: random() * 100, y: random() * 100 }] });
    const graph = buildNetGraph(kitBoard(parts));
    const readingsOf = (count: number) => Array.from({ length: count }, (_, i): DropReading => {
      const x = (i * 37) % 100, y = (i * 61) % 100;
      return { x, y, value: Math.log(Math.hypot(x - 40, y - 60) + 1) };
    });
    expect(locateShort(graph, 'PP1V0', readingsOf(MAX_READINGS), { injection: { x: 0, y: 0 } }).status).toBe('ok');
    expectScaling('locateShort', [25, 100, 400], count => { const readings = readingsOf(count); return () => locateShort(graph, 'PP1V0', readings, { injection: { x: 0, y: 0 } }); });
  }, 60_000);
});
