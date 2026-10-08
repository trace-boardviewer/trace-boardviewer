import { describe, expect, it } from 'vitest';
import { expectScaling } from '../test-support/timing';
import { buildNetGraph } from './net-graph';
import { kitBoard, seeded, two, type KitPart } from './net-testkit';
import { minimumSpanningTree, netFan, netTree, pinOnSide } from './net-tree';

/** Brute-force reference: Kruskal over every pair (O(n² log n)), independent of the code under test. */
function referenceLength(xs: number[], ys: number[]): number {
  const n = xs.length;
  const edges: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) edges.push([Math.hypot(xs[i] - xs[j], ys[i] - ys[j]), i, j]);
  edges.sort((a, b) => a[0] - b[0]);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  let length = 0;
  for (const [d, a, b] of edges) { const ra = find(a), rb = find(b); if (ra !== rb) { parent[ra] = rb; length += d; } }
  return length;
}

/** The edges form one spanning tree: n - 1 edges, every point reached, and the reported length matches. */
function checkTree(xs: ArrayLike<number>, ys: ArrayLike<number>, tree: ReturnType<typeof minimumSpanningTree>): void {
  const n = xs.length;
  expect(tree.edges.length).toBe(2 * Math.max(0, n - 1));
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  let length = 0, problems = 0;
  for (let e = 0; e < tree.edges.length; e += 2) {
    const a = tree.edges[e], b = tree.edges[e + 1];
    if (!(a >= 0 && a < n && b >= 0 && b < n && a !== b)) { problems++; continue; }
    const ra = find(a), rb = find(b);
    if (ra === rb) { problems++; continue; } // a cycle
    parent[ra] = rb;
    length += Math.hypot(xs[a] - xs[b], ys[a] - ys[b]);
  }
  expect(problems).toBe(0);
  expect(length).toBeCloseTo(tree.length, 6);
}

const randomPoints = (n: number, seed: number, size = 100) => {
  const random = seeded(seed);
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < n; i++) { xs.push(random() * size); ys.push(random() * size); }
  return { xs, ys };
};
const clusteredPoints = (clusters: number, perCluster: number, seed: number) => {
  const random = seeded(seed);
  const xs: number[] = [], ys: number[] = [];
  for (let c = 0; c < clusters; c++) {
    const cx = random() * 10_000, cy = random() * 10_000;
    for (let i = 0; i < perCluster; i++) { xs.push(cx + random() * 2); ys.push(cy + random() * 2); }
  }
  return { xs, ys };
};

describe('minimumSpanningTree: exact method', () => {
  it('handles no point, one point and two points', () => {
    expect(minimumSpanningTree([], [])).toMatchObject({ length: 0, exact: true, method: 'trivial' });
    expect(minimumSpanningTree([1], [1]).edges.length).toBe(0);
    const two = minimumSpanningTree([0, 3], [0, 4]);
    expect(two.length).toBe(5);
    expect([...two.edges]).toEqual([0, 1]);
  });
  it('matches the brute-force reference on 60 random sets of 2 to 200 points', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const n = 2 + ((seed * 37) % 199);
      const { xs, ys } = randomPoints(n, seed);
      const tree = minimumSpanningTree(xs, ys);
      expect(tree.exact).toBe(true);
      expect(tree.method).toBe('prim');
      checkTree(xs, ys, tree);
      expect(tree.length).toBeCloseTo(referenceLength(xs, ys), 9);
    }
  });
  it('matches the reference on clustered sets, duplicates and collinear points', () => {
    const clustered = clusteredPoints(12, 15, 3);
    expect(minimumSpanningTree(clustered.xs, clustered.ys).length).toBeCloseTo(referenceLength(clustered.xs, clustered.ys), 9);
    const xs = [0, 0, 0, 1, 1, 5], ys = [0, 0, 0, 0, 0, 0];
    const tree = minimumSpanningTree(xs, ys);
    checkTree(xs, ys, tree);
    expect(tree.length).toBe(5);
  });
  it('is exact up to 3,000 points', () => {
    const { xs, ys } = randomPoints(3000, 11);
    const tree = minimumSpanningTree(xs, ys);
    expect(tree).toMatchObject({ exact: true, method: 'prim' });
    checkTree(xs, ys, tree);
    expect(minimumSpanningTree(...Object.values(randomPoints(3001, 11)) as [number[], number[]]).method).toBe('knn-kruskal');
  });
});

describe('minimumSpanningTree: approximate method', () => {
  it('equals the exact tree on random sets when forced (exactLimit 1)', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { xs, ys } = randomPoints(50 + seed * 40, seed + 100);
      const approx = minimumSpanningTree(xs, ys, { exactLimit: 1 });
      const exact = minimumSpanningTree(xs, ys);
      expect(approx.method).toBe('knn-kruskal');
      expect(approx.exact).toBe(false);
      checkTree(xs, ys, approx);
      expect(approx.length / exact.length).toBeLessThan(1.05);
      expect(approx.length).toBeGreaterThanOrEqual(exact.length - 1e-6);
    }
  });
  it('joins far-apart clusters with their true shortest bridges', () => {
    for (const [clusters, per] of [[40, 25], [300, 9], [5, 400]] as const) {
      const { xs, ys } = clusteredPoints(clusters, per, clusters);
      const approx = minimumSpanningTree(xs, ys, { exactLimit: 1 });
      const exact = minimumSpanningTree(xs, ys);
      checkTree(xs, ys, approx);
      expect(approx.length / exact.length).toBeLessThan(1.05);
    }
  });
  it('stays within 5 % of exact at 10,000 random points', () => {
    const { xs, ys } = randomPoints(10_000, 5);
    const approx = minimumSpanningTree(xs, ys);
    const exact = minimumSpanningTree(xs, ys, { exactLimit: 20_000 });
    checkTree(xs, ys, approx);
    expect(approx.length / exact.length).toBeLessThan(1.05);
  });
  it('stays within 5 % of exact at 50,000 random points', () => {
    const { xs, ys } = randomPoints(50_000, 9, 300);
    const approx = minimumSpanningTree(xs, ys);
    expect(approx.method).toBe('knn-kruskal');
    checkTree(xs, ys, approx);
    const exact = minimumSpanningTree(xs, ys, { exactLimit: 60_000 }); // O(n²): a few seconds
    expect(approx.length / exact.length).toBeLessThan(1.05);
    expect(approx.length).toBeGreaterThanOrEqual(exact.length - 1e-6);
  }, 60_000);
  it('grows like n log n from 3,000 to 50,000 points (the 150 ms budget at 50,000 follows from the work counters below)', () => {
    // Constant density: the side grows with the square root of the count.
    expectScaling('Net tree, approximate', [3125, 12_500, 50_000], count => {
      const { xs, ys } = randomPoints(count, 9, Math.sqrt(count) * 1.34);
      return () => minimumSpanningTree(xs, ys);
    });
  }, 60_000);
  it('gives the exact length on a 224 x 224 lattice (all edges tie)', () => {
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < 224; i++) for (let j = 0; j < 224; j++) { xs.push(i); ys.push(j); }
    const tree = minimumSpanningTree(xs, ys);
    checkTree(xs, ys, tree);
    expect(tree.length).toBeCloseTo(224 * 224 - 1, 6);
  });
  it('gives the exact length for 50,000 collinear points', () => {
    const random = seeded(4);
    const xs = Array.from({ length: 50_000 }, () => random() * 1000), ys = xs.map(() => 7);
    const tree = minimumSpanningTree(xs, ys);
    checkTree(xs, ys, tree);
    expect(tree.length).toBeCloseTo(Math.max(...xs) - Math.min(...xs), 6);
  });
  it('gives length 0 when 50,000 points coincide', () => {
    const xs = new Array(50_000).fill(3), ys = new Array(50_000).fill(-2);
    const tree = minimumSpanningTree(xs, ys);
    checkTree(xs, ys, tree);
    expect(tree.length).toBe(0);
  });
  it('joins 2,000 tight clusters far apart into one tree', () => {
    const { xs, ys } = clusteredPoints(2000, 25, 77);
    const tree = minimumSpanningTree(xs, ys);
    checkTree(xs, ys, tree);
    expect(tree.work.rounds).toBeGreaterThan(0);
  });
});

describe('minimumSpanningTree: work stays O(n log n) on pathological sets', () => {
  // The counters do not depend on the speed or load of the machine. Measured: 0.7 to 5.5 distances and 1.7 to 5.5 tree nodes per
  // n·log2(n) on these sets at 5,000 and 50,000 points; a quadratic search would need n / log2(n), about 3,000 at 50,000.
  const n = 50_000;
  const random = seeded(31);
  const sets: Record<string, () => { xs: number[]; ys: number[] }> = {
    random: () => randomPoints(n, 9, 300),
    lattice: () => { const xs: number[] = [], ys: number[] = []; for (let i = 0; i < 224; i++) for (let j = 0; j < 224; j++) { xs.push(i); ys.push(j); } return { xs, ys }; },
    collinear: () => { const xs = Array.from({ length: n }, () => random() * 1000); return { xs, ys: xs.map(() => 7) }; },
    coincident: () => ({ xs: new Array(n).fill(3), ys: new Array(n).fill(-2) }),
    clusters: () => clusteredPoints(2000, 25, 77),
    'two scales': () => { const xs: number[] = [], ys: number[] = []; for (let i = 0; i < n; i++) { const big = random() < 0.5; xs.push(big ? random() * 1e6 : random() * 1e-3); ys.push(big ? random() * 1e6 : random() * 1e-3); } return { xs, ys }; },
    spiral: () => { const xs: number[] = [], ys: number[] = []; for (let i = 0; i < n; i++) { const a = i * 0.1; xs.push(a * Math.cos(a)); ys.push(a * Math.sin(a)); } return { xs, ys }; },
  };
  for (const [name, make] of Object.entries(sets)) {
    it(name, () => {
      const { xs, ys } = make();
      const tree = minimumSpanningTree(xs, ys);
      checkTree(xs, ys, tree);
      const nlogn = xs.length * Math.log2(xs.length);
      expect(tree.work.distances).toBeLessThan(10 * nlogn);
      expect(tree.work.nodes).toBeLessThan(10 * nlogn);
      expect(tree.work.rounds).toBeLessThanOrEqual(Math.ceil(Math.log2(xs.length)));
    });
  }
  it('Prim reports its quadratic work', () => {
    const { xs, ys } = randomPoints(1000, 3);
    expect(minimumSpanningTree(xs, ys).work).toEqual({ distances: (1000 * 999) / 2, nodes: 0, rounds: 0 });
  });
  it('is deterministic', () => {
    const { xs, ys } = randomPoints(8000, 21);
    const a = minimumSpanningTree(xs, ys), b = minimumSpanningTree(xs, ys);
    expect([...a.edges]).toEqual([...b.edges]);
    expect(a.length).toBe(b.length);
  });
});

describe('netTree on a board', () => {
  const parts: KitPart[] = [
    { ref: 'U1', pins: [{ net: 'SIG', x: 0, y: 0 }, { net: 'SIG', x: 10, y: 0 }, { net: 'X', x: 5, y: 5 }], x: 5, y: 0 },
    { ref: 'U2', side: 'bottom', pins: [{ net: 'SIG', x: 0, y: 20 }, { net: 'SIG', x: 3, y: 20 }], x: 0, y: 20 },
    { ref: 'J1', pins: [{ net: 'SIG', x: 20, y: 0, side: 'both' }], x: 20, y: 0 },
    two('C1', '1u', 'SIG', 'GND'),
  ];
  const graph = buildNetGraph(kitBoard(parts));
  it('builds the tree of one side; through-hole pins belong to both', () => {
    const top = netTree(graph, 'SIG', { side: 'top' });
    expect(top.status).toBe('ok');
    expect(top.pins.length).toBe(4); // U1 twice, J1 (through-hole), C1; nothing from U2
    expect(top.edgeIds.length).toBe(3);
    const bottom = netTree(graph, 'SIG', { side: 'bottom' });
    expect([...bottom.pins].map(pin => graph.pin(pin).componentId).sort()).toEqual(['part:1', 'part:1', 'part:2']);
    expect(netTree(graph, 'SIG').pins.length).toBe(6);
  });
  it('collapses each part to one node on request', () => {
    expect(netTree(graph, 'SIG', { perPart: true }).pins.length).toBe(4);
  });
  it('reports unknown, no-connect and ground nets', () => {
    expect(netTree(graph, 'NOPE').status).toBe('unknown-net');
    expect(netTree(graph, 'GND').status).toBe('ground');
  });
  it('skips pins with broken coordinates', () => {
    const board = kitBoard([two('R1', '1k', 'A', 'B'), two('R2', '1k', 'A', 'C'), two('R3', '1k', 'A', 'D')]);
    board.pins[0].x = Number.NaN;
    const tree = netTree(buildNetGraph(board), 'A');
    expect(tree.skipped).toBe(1);
    expect(tree.pins.length).toBe(2);
  });
  it('places pins on sides', () => {
    expect(pinOnSide('both', 'top')).toBe(true);
    expect(pinOnSide('bottom', 'top')).toBe(false);
    expect(pinOnSide('bottom', 'all')).toBe(true);
  });
});

describe('netFan', () => {
  const parts: KitPart[] = [
    { ref: 'U1', pins: [{ net: 'SIG', x: 0, y: 0 }, { net: 'SIG', x: 50, y: 0 }], x: 25, y: 0 },
    { ref: 'TP1', pins: [{ net: 'SIG', x: 40, y: 40 }], x: 40, y: 40 },
    { ref: 'TP2', pins: [{ net: 'SIG', x: 5, y: 5 }], x: 5, y: 5 },
    { ref: 'U2', side: 'bottom', pins: [{ net: 'SIG', x: 30, y: 30 }, { net: 'SIG', x: 31, y: 30 }], x: 30, y: 30 },
    { ref: 'J1', pins: [{ net: 'SIG', x: 60, y: 0, side: 'both' }], x: 60, y: 0 },
    two('C1', '1u', 'VCC', 'GND'), two('C2', '1u', 'VCC', 'GND'),
  ];
  const graph = buildNetGraph(kitBoard(parts));
  it('fans from the selected pin when it is on the net and in view', () => {
    const fan = netFan(graph, 'SIG', { side: 'top', selectedPinId: 'pin:1' });
    expect(fan).toMatchObject({ mode: 'fan', source: { pinId: 'pin:1', basis: 'selected' }, inView: 5, otherSide: 2, perSide: { top: 4, bottom: 2, both: 1 } });
    expect(fan.targets).toEqual(['pin:0', 'pin:2', 'pin:3', 'pin:6']);
  });
  it('falls back to the test point nearest the view centre', () => {
    expect(netFan(graph, 'SIG', { side: 'top', viewCenter: { x: 0, y: 0 } }).source).toEqual({ pinId: 'pin:3', basis: 'testpoint' });
    expect(netFan(graph, 'SIG', { side: 'top', viewCenter: { x: 45, y: 45 } }).source).toEqual({ pinId: 'pin:2', basis: 'testpoint' });
    // A selected pin on the other side is not in view.
    expect(netFan(graph, 'SIG', { side: 'top', selectedPinId: 'pin:4', viewCenter: { x: 0, y: 0 } }).source?.basis).toBe('testpoint');
  });
  it('falls back to the pin nearest the view centre, then the first pin', () => {
    expect(netFan(graph, 'SIG', { side: 'bottom', viewCenter: { x: 31, y: 31 } }).source).toEqual({ pinId: 'pin:5', basis: 'nearest-view' });
    expect(netFan(graph, 'SIG', { side: 'bottom' }).source).toEqual({ pinId: 'pin:4', basis: 'first' });
  });
  it('gives ground no lines and large nets a tree', () => {
    expect(netFan(graph, 'GND', { side: 'top' })).toMatchObject({ mode: 'highlight', source: null, targets: [] });
    expect(netFan(graph, 'SIG', { side: 'top', treeAbove: 4 })).toMatchObject({ mode: 'tree', source: null, targets: [], inView: 5 });
  });
  it('gives nothing for unknown nets and nets without pins in view', () => {
    expect(netFan(graph, 'NOPE').mode).toBe('none');
    expect(netFan(graph, 'VCC', { side: 'bottom' })).toMatchObject({ mode: 'none', otherSide: 2 });
  });
});
