/**
 * Net tree and Net fan: how the pins of one net are drawn as lines.
 *
 * Net tree: the Euclidean minimum spanning tree over the net's pins (shortest total length of straight lines that connect them
 * all). `minimumSpanningTree` picks the method by size:
 *  - n <= `exactLimit` (default 3,000): Prim on the complete graph, O(n²) time and O(n) memory, exact. Ties go to the lower index.
 *  - larger: approximate in O(n log n). A k-d tree (leaves of at most 8 points, median splits) gives each point its k = 8 nearest
 *    neighbours; Kruskal (edges ordered by an exact radix sort of the squared lengths, union-find) builds a spanning forest of that
 *    graph; the forest's trees are then joined by Borůvka rounds that each add, for every tree, its shortest edge to any other
 *    tree (exact nearest-point queries on the k-d tree that skip subtrees lying wholly inside the asking tree). Those joining edges
 *    are true minimum-spanning-tree edges (cut property); only an edge missing from the 8-neighbour graph can make the result
 *    longer than exact, which is rare: on random and clustered sets the measured excess is far below the 5 % bound.
 *    All searches run on the points in k-d order (a leaf is a contiguous run, consecutive queries are neighbours), which keeps
 *    them in cache: on shuffled input that is about three times faster than working in input order.
 * Coincident points (a pad drawn twice) give zero-length edges; pathological sets (all points equal, all on a line, tight clusters
 * far apart) stay O(n log n) because every search prunes with `>=` against the current bound. `work` counts the distances and
 * tree nodes a run looked at, a measure of cost that does not depend on the speed or load of the machine.
 *
 * Net fan: lines from one source pin to every other pin of the net on the side in view. The source is the selected pin, else the
 * test point of the net nearest the view centre, else the pin nearest the view centre, else the first pin in file order. A ground
 * net gets no lines (only its pads are highlighted) and a net with more pins in view than `treeAbove` (default 400) should be drawn
 * as a Net tree instead; both are reported in `mode`.
 *
 * Pure and deterministic; coordinates are millimetres in board space. Pins with non-finite coordinates are skipped.
 */
import type { Point, ViewSide } from './types';
import type { NetGraph } from './net-graph';

export const DEFAULT_EXACT_LIMIT = 3000;
export const KNN = 8;
const LEAF = 8;

/** What one run looked at: a cost measure independent of the machine. */
export interface SpanningTreeWork {
  /** Squared point-to-point distances computed. */
  readonly distances: number;
  /** k-d tree nodes visited by the neighbour and joining searches. */
  readonly nodes: number;
  /** Borůvka rounds that joined the trees Kruskal left on the neighbour graph. */
  readonly rounds: number;
}

export interface SpanningTree {
  /** Pairs of point indices: edge e joins edges[2e] and edges[2e + 1]. n - 1 edges for n points. */
  readonly edges: Int32Array;
  /** Total Euclidean length. */
  readonly length: number;
  /** True when the tree is a proven minimum (the exact method). */
  readonly exact: boolean;
  readonly method: 'trivial' | 'prim' | 'knn-kruskal';
  readonly work: SpanningTreeWork;
}

export interface SpanningTreeOptions {
  /** Largest point count solved exactly; default 3,000. */
  exactLimit?: number;
}

const NO_WORK: SpanningTreeWork = Object.freeze({ distances: 0, nodes: 0, rounds: 0 });

/** Minimum spanning tree over points (xs[i], ys[i]); coordinates must be finite. */
export function minimumSpanningTree(xs: ArrayLike<number>, ys: ArrayLike<number>, options: SpanningTreeOptions = {}): SpanningTree {
  const n = Math.min(xs.length, ys.length);
  if (n <= 1) return { edges: new Int32Array(0), length: 0, exact: true, method: 'trivial', work: NO_WORK };
  const limit = typeof options.exactLimit === 'number' && Number.isFinite(options.exactLimit) ? Math.max(1, Math.floor(options.exactLimit)) : DEFAULT_EXACT_LIMIT;
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = xs[i]; y[i] = ys[i]; }
  return n <= limit ? prim(x, y) : approximate(x, y);
}

function prim(x: Float64Array, y: Float64Array): SpanningTree {
  const n = x.length;
  const best = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const edges = new Int32Array(2 * (n - 1));
  let length = 0, current = 0, count = 0;
  done[0] = 1;
  for (let step = 1; step < n; step++) {
    const cx = x[current], cy = y[current];
    let next = -1, nextDistance = Infinity;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      const dx = x[i] - cx, dy = y[i] - cy, d = dx * dx + dy * dy;
      if (d < best[i]) { best[i] = d; parent[i] = current; }
      if (best[i] < nextDistance) { nextDistance = best[i]; next = i; }
    }
    done[next] = 1;
    edges[count++] = parent[next]; edges[count++] = next;
    length += Math.sqrt(nextDistance);
    current = next;
  }
  // Step s looks at the n - s points not yet in the tree.
  return { edges, length, exact: true, method: 'prim', work: { distances: (n * (n - 1)) / 2, nodes: 0, rounds: 0 } };
}

// ---------------------------------------------------------------------------------------------------------------
// k-d tree
// ---------------------------------------------------------------------------------------------------------------

interface KdTree {
  /** perm[p]: the input index of the point at k-d position p. Node ranges are positions. */
  readonly perm: Int32Array;
  readonly start: Int32Array; readonly end: Int32Array; readonly left: Int32Array; readonly right: Int32Array;
  readonly minX: Float64Array; readonly minY: Float64Array; readonly maxX: Float64Array; readonly maxY: Float64Array;
  /** Nodes in use; children are numbered after their parent. */
  readonly count: number;
}

/** Puts the k-th smallest (by key) of perm[lo..hi] at position k, smaller ones before it, larger after (Hoare partition, median of three). */
function select(perm: Int32Array, key: Float64Array, lo: number, hi: number, k: number): void {
  while (hi > lo) {
    const mid = (lo + hi) >>> 1;
    const a = key[perm[lo]], b = key[perm[mid]], c = key[perm[hi]];
    const pivot = a < b ? (b < c ? b : a < c ? c : a) : (a < c ? a : b < c ? c : b);
    let i = lo, j = hi;
    while (i <= j) {
      while (key[perm[i]] < pivot) i++;
      while (key[perm[j]] > pivot) j--;
      if (i <= j) { const t = perm[i]; perm[i] = perm[j]; perm[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return;
  }
}

function buildKdTree(x: Float64Array, y: Float64Array): KdTree {
  const n = x.length;
  // Leaves hold at least 4 points, so fewer than n / 2 nodes are ever used.
  const capacity = Math.max(1, n);
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  const start = new Int32Array(capacity), end = new Int32Array(capacity), left = new Int32Array(capacity).fill(-1), right = new Int32Array(capacity).fill(-1);
  const minX = new Float64Array(capacity), minY = new Float64Array(capacity), maxX = new Float64Array(capacity), maxY = new Float64Array(capacity);
  let count = 1;
  start[0] = 0; end[0] = n;
  const stack: number[] = [0];
  while (stack.length) {
    const node = stack.pop()!;
    const s = start[node], e = end[node];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = s; k < e; k++) {
      const p = perm[k], px = x[p], py = y[p];
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
    minX[node] = x0; minY[node] = y0; maxX[node] = x1; maxY[node] = y1;
    if (e - s <= LEAF) continue;
    const mid = (s + e) >>> 1;
    select(perm, x1 - x0 >= y1 - y0 ? x : y, s, e - 1, mid);
    const l = count++, r = count++;
    start[l] = s; end[l] = mid; start[r] = mid; end[r] = e;
    left[node] = l; right[node] = r;
    stack.push(r, l);
  }
  return { perm, start, end, left, right, minX, minY, maxX, maxY, count };
}

const boxDistance2 = (tree: KdTree, node: number, px: number, py: number): number => {
  const dx = px < tree.minX[node] ? tree.minX[node] - px : px > tree.maxX[node] ? px - tree.maxX[node] : 0;
  const dy = py < tree.minY[node] ? tree.minY[node] - py : py > tree.maxY[node] ? py - tree.maxY[node] : 0;
  return dx * dx + dy * dy;
};

/** Squared distance between the boxes of two nodes (0 when they overlap). */
const boxBoxDistance2 = (tree: KdTree, a: number, b: number): number => {
  const dx = tree.minX[b] > tree.maxX[a] ? tree.minX[b] - tree.maxX[a] : tree.minX[a] > tree.maxX[b] ? tree.minX[a] - tree.maxX[b] : 0;
  const dy = tree.minY[b] > tree.maxY[a] ? tree.minY[b] - tree.maxY[a] : tree.minY[a] > tree.maxY[b] ? tree.minY[a] - tree.maxY[b] : 0;
  return dx * dx + dy * dy;
};

/** A depth-first search keeps at most one pending sibling per level. */
const stackSize = (n: number): number => Math.max(64, 4 * Math.ceil(Math.log2(n + 1)) + 8);

interface Counters { distances: number; nodes: number; rounds: number }

/** For every position its k nearest other positions (fewer when n - 1 < k), as rows of k (-1 fills a short row). */
function nearestNeighbours(tree: KdTree, x: Float64Array, y: Float64Array, k: number, work: Counters): Int32Array {
  const n = x.length;
  const neighbours = new Int32Array(n * k).fill(-1);
  const heapD = new Float64Array(k), heapI = new Int32Array(k);
  const stack = new Int32Array(stackSize(n));
  let distances = 0, nodes = 0;
  for (let q = 0; q < n; q++) {
    const qx = x[q], qy = y[q];
    let size = 0;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top];
      nodes++;
      if (size === k && boxDistance2(tree, node, qx, qy) >= heapD[0]) continue;
      const l = tree.left[node];
      if (l < 0) {
        const last = tree.end[node];
        for (let p = tree.start[node]; p < last; p++) {
          if (p === q) continue;
          distances++;
          const dx = x[p] - qx, dy = y[p] - qy, d = dx * dx + dy * dy;
          if (size < k) {
            // Sift up in a max-heap.
            let i = size++;
            while (i > 0) { const parent = (i - 1) >> 1; if (heapD[parent] >= d) break; heapD[i] = heapD[parent]; heapI[i] = heapI[parent]; i = parent; }
            heapD[i] = d; heapI[i] = p;
          } else if (d < heapD[0]) {
            let i = 0;
            for (;;) {
              const a = 2 * i + 1, b = a + 1;
              let largest = i, largestD = d;
              if (a < size && heapD[a] > largestD) { largest = a; largestD = heapD[a]; }
              if (b < size && heapD[b] > largestD) { largest = b; largestD = heapD[b]; }
              if (largest === i) break;
              heapD[i] = heapD[largest]; heapI[i] = heapI[largest]; i = largest;
            }
            heapD[i] = d; heapI[i] = p;
          }
        }
        continue;
      }
      const r = tree.right[node];
      const dl = boxDistance2(tree, l, qx, qy), dr = boxDistance2(tree, r, qx, qy);
      // Nearer child last, so it is searched first.
      if (dl <= dr) { stack[top++] = r; stack[top++] = l; } else { stack[top++] = l; stack[top++] = r; }
    }
    for (let m = 0; m < size; m++) neighbours[q * k + m] = heapI[m];
  }
  work.distances += distances; work.nodes += nodes;
  return neighbours;
}

// ---------------------------------------------------------------------------------------------------------------
// Approximate method
// ---------------------------------------------------------------------------------------------------------------

/** Indices 0..m-1 ordered by the non-negative doubles `keys` (exact LSD radix sort on the IEEE bits, four 16-bit passes, stable). */
function radixOrder(keys: Float64Array): Int32Array {
  const m = keys.length;
  const words = new Uint32Array(keys.buffer, keys.byteOffset, m * 2);
  let order = new Int32Array(m), spare = new Int32Array(m);
  for (let i = 0; i < m; i++) order[i] = i;
  const counts = new Int32Array(65536);
  const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const lowWord = littleEndian ? 0 : 1, highWord = 1 - lowWord;
  for (const [word, shift] of [[lowWord, 0], [lowWord, 16], [highWord, 0], [highWord, 16]] as const) {
    counts.fill(0);
    for (let i = 0; i < m; i++) counts[(words[2 * order[i] + word] >>> shift) & 0xffff]++;
    let sum = 0;
    for (let b = 0; b < 65536; b++) { const c = counts[b]; counts[b] = sum; sum += c; }
    for (let i = 0; i < m; i++) { const e = order[i]; spare[counts[(words[2 * e + word] >>> shift) & 0xffff]++] = e; }
    const t = order; order = spare; spare = t;
  }
  return order;
}

function approximate(x: Float64Array, y: Float64Array): SpanningTree {
  const n = x.length;
  const tree = buildKdTree(x, y);
  const perm = tree.perm;
  // Everything below works on k-d positions; the edges are mapped back to input indices at the end.
  const px = new Float64Array(n), py = new Float64Array(n);
  for (let p = 0; p < n; p++) { px[p] = x[perm[p]]; py[p] = y[perm[p]]; }
  const work: Counters = { distances: 0, nodes: 0, rounds: 0 };
  const k = Math.min(KNN, n - 1);
  const neighbours = nearestNeighbours(tree, px, py, k, work);

  // Candidate edges: each unordered pair once.
  const edgeA = new Int32Array(n * k), edgeB = new Int32Array(n * k);
  let m = 0;
  for (let i = 0; i < n; i++) {
    for (let t = 0; t < k; t++) {
      const j = neighbours[i * k + t];
      if (j < 0) continue;
      if (i > j) {
        let mutual = false;
        for (let s = 0; s < k; s++) if (neighbours[j * k + s] === i) { mutual = true; break; }
        if (mutual) continue;
      }
      edgeA[m] = i; edgeB[m] = j; m++;
    }
  }
  const weights = new Float64Array(m);
  for (let e = 0; e < m; e++) { const dx = px[edgeA[e]] - px[edgeB[e]], dy = py[edgeA[e]] - py[edgeB[e]]; weights[e] = dx * dx + dy * dy; }
  const order = radixOrder(weights);

  const parent = new Int32Array(n), rank = new Uint8Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number): boolean => {
    let ra = find(a), rb = find(b);
    if (ra === rb) return false;
    if (rank[ra] < rank[rb]) { const t = ra; ra = rb; rb = t; }
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra]++;
    return true;
  };
  const edges = new Int32Array(2 * (n - 1));
  let count = 0, length = 0, trees = n;
  for (let o = 0; o < m && trees > 1; o++) {
    const e = order[o];
    if (union(edgeA[e], edgeB[e])) { edges[count++] = edgeA[e]; edges[count++] = edgeB[e]; length += Math.sqrt(weights[e]); trees--; }
  }

  // Borůvka rounds join the remaining trees with their shortest outgoing edges.
  if (trees > 1) {
    const comp = new Int32Array(n);
    const nodeComp = new Int32Array(tree.count);
    const bestD = new Float64Array(n), bestA = new Int32Array(n), bestB = new Int32Array(n);
    const stack = new Int32Array(stackSize(n));
    const leaves: number[] = [];
    for (let node = 0; node < tree.count; node++) if (tree.left[node] < 0) leaves.push(node);
    let distances = 0, nodes = 0;
    while (trees > 1) {
      work.rounds++;
      for (let i = 0; i < n; i++) comp[i] = find(i);
      // The tree of every node, or -1 when it holds points of several trees; children come after parents, so a reverse pass is bottom-up.
      for (let node = tree.count - 1; node >= 0; node--) {
        const l = tree.left[node];
        if (l < 0) {
          const last = tree.end[node];
          let c = comp[tree.start[node]];
          for (let p = tree.start[node] + 1; p < last; p++) if (comp[p] !== c) { c = -1; break; }
          nodeComp[node] = c;
        } else {
          const a = nodeComp[l], b = nodeComp[tree.right[node]];
          nodeComp[node] = a === b ? a : -1;
        }
      }
      bestD.fill(Infinity); bestA.fill(-1); bestB.fill(-1);
      for (const leaf of leaves) {
        const c = nodeComp[leaf];
        const s = tree.start[leaf], e = tree.end[leaf];
        if (c >= 0) {
          // All points of the leaf are in tree c: one search with the leaf's box serves them all.
          let top = 0;
          stack[top++] = 0;
          while (top > 0) {
            const node = stack[--top];
            nodes++;
            if (nodeComp[node] === c || boxBoxDistance2(tree, leaf, node) >= bestD[c]) continue;
            const l = tree.left[node];
            if (l < 0) {
              const last = tree.end[node];
              for (let p = tree.start[node]; p < last; p++) {
                if (comp[p] === c) continue;
                const fx = px[p], fy = py[p];
                for (let q = s; q < e; q++) {
                  distances++;
                  const dx = fx - px[q], dy = fy - py[q], d = dx * dx + dy * dy;
                  if (d < bestD[c]) { bestD[c] = d; bestA[c] = q; bestB[c] = p; }
                }
              }
              continue;
            }
            const r = tree.right[node];
            const dl = boxBoxDistance2(tree, leaf, l), dr = boxBoxDistance2(tree, leaf, r);
            if (dl <= dr) { stack[top++] = r; stack[top++] = l; } else { stack[top++] = l; stack[top++] = r; }
          }
          continue;
        }
        // A leaf shared by several trees: one search per point.
        for (let q = s; q < e; q++) {
          const cq = comp[q], qx = px[q], qy = py[q];
          let top = 0;
          stack[top++] = 0;
          while (top > 0) {
            const node = stack[--top];
            nodes++;
            if (nodeComp[node] === cq || boxDistance2(tree, node, qx, qy) >= bestD[cq]) continue;
            const l = tree.left[node];
            if (l < 0) {
              const last = tree.end[node];
              for (let p = tree.start[node]; p < last; p++) {
                if (comp[p] === cq) continue;
                distances++;
                const dx = px[p] - qx, dy = py[p] - qy, d = dx * dx + dy * dy;
                if (d < bestD[cq]) { bestD[cq] = d; bestA[cq] = q; bestB[cq] = p; }
              }
              continue;
            }
            const r = tree.right[node];
            const dl = boxDistance2(tree, l, qx, qy), dr = boxDistance2(tree, r, qx, qy);
            if (dl <= dr) { stack[top++] = r; stack[top++] = l; } else { stack[top++] = l; stack[top++] = r; }
          }
        }
      }
      let joined = 0;
      for (let c = 0; c < n; c++) {
        if (comp[c] !== c || bestA[c] < 0) continue;
        if (union(bestA[c], bestB[c])) { edges[count++] = bestA[c]; edges[count++] = bestB[c]; length += Math.sqrt(bestD[c]); trees--; joined++; }
      }
      if (joined === 0) break; // cannot happen with finite coordinates; guards an endless loop on broken input
    }
    work.distances += distances; work.nodes += nodes;
  }
  for (let e = 0; e < count; e++) edges[e] = perm[edges[e]];
  return { edges: count === edges.length ? edges : edges.slice(0, count), length, exact: false, method: 'knn-kruskal', work };
}

// ---------------------------------------------------------------------------------------------------------------
// Net tree and Net fan on a board
// ---------------------------------------------------------------------------------------------------------------

export type TreeSide = ViewSide | 'all';

/** Whether a pin is drawn on a side: through-hole (`both`) pins are on both. */
export const pinOnSide = (pinSide: string, side: TreeSide): boolean => side === 'all' || pinSide === side || pinSide === 'both';

export interface NetTreeOptions extends SpanningTreeOptions {
  /** Side in view; through-hole pins belong to both. Default 'all'. */
  side?: TreeSide;
  /** One node per part (its pin on the net nearest the part's position) instead of one per pin: for dense ball-grid nets. */
  perPart?: boolean;
}

export interface NetTree {
  readonly net: string;
  readonly side: TreeSide;
  readonly status: 'ok' | 'unknown-net' | 'ground' | 'no-connect';
  /** Graph pin indices of the tree nodes. */
  readonly pins: Int32Array;
  /** Pairs of graph pin indices. */
  readonly edges: Int32Array;
  /** The same edges as pin ids. */
  readonly edgeIds: ReadonlyArray<readonly [string, string]>;
  readonly length: number;
  readonly exact: boolean;
  readonly method: SpanningTree['method'];
  /** Pins left out because their coordinates are not finite. */
  readonly skipped: number;
}

/**
 * Net tree of a net on one side. A ground net is reported (`status: 'ground'`) with its tree still built when asked, because the
 * caller decides whether to draw it; a no-connect net gets none.
 */
export function netTree(graph: NetGraph, netName: string, options: NetTreeOptions = {}): NetTree {
  const side: TreeSide = options.side ?? 'all';
  const net = graph.netIndex(netName);
  const none = (status: NetTree['status']): NetTree => ({ net: netName, side, status, pins: new Int32Array(0), edges: new Int32Array(0), edgeIds: [], length: 0, exact: true, method: 'trivial', skipped: 0 });
  if (net < 0) return none('unknown-net');
  if (graph.isNoConnect(net)) return none('no-connect');
  const chosen: number[] = [];
  let skipped = 0;
  const byPart = options.perPart ? new Map<number, { pin: number; distance: number }>() : null;
  for (const pin of graph.netPins(net)) {
    const record = graph.pin(pin);
    if (!pinOnSide(record.side, side)) continue;
    if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) { skipped++; continue; }
    if (byPart) {
      const part = graph.pinPart[pin];
      if (part >= 0) {
        const position = graph.component(part).position;
        const distance = position && Number.isFinite(position.x) && Number.isFinite(position.y) ? Math.hypot(record.x - position.x, record.y - position.y) : 0;
        const current = byPart.get(part);
        if (!current || distance < current.distance) byPart.set(part, { pin, distance });
        continue;
      }
    }
    chosen.push(pin);
  }
  if (byPart) { for (const { pin } of byPart.values()) chosen.push(pin); chosen.sort((a, b) => a - b); }
  const xs = new Float64Array(chosen.length), ys = new Float64Array(chosen.length);
  chosen.forEach((pin, i) => { xs[i] = graph.pin(pin).x; ys[i] = graph.pin(pin).y; });
  const tree = minimumSpanningTree(xs, ys, options);
  const edges = new Int32Array(tree.edges.length);
  const edgeIds: Array<readonly [string, string]> = [];
  for (let e = 0; e < tree.edges.length; e += 2) {
    const a = chosen[tree.edges[e]], b = chosen[tree.edges[e + 1]];
    edges[e] = a; edges[e + 1] = b;
    edgeIds.push([graph.pin(a).id, graph.pin(b).id]);
  }
  return { net: netName, side, status: graph.isGround(net) ? 'ground' : 'ok', pins: Int32Array.from(chosen), edges, edgeIds, length: tree.length, exact: tree.exact, method: tree.method, skipped };
}

export interface NetFanOptions {
  /** Side in view; default 'top'. */
  side?: ViewSide;
  /** The selected pin (id); it is the source when it lies on the net and on the side in view. */
  selectedPinId?: string;
  /** Centre of the view in board millimetres; picks the source when no pin is selected. */
  viewCenter?: Point;
  /** Pins in view above which the net should be drawn as a Net tree; default 400. */
  treeAbove?: number;
}

export const DEFAULT_TREE_ABOVE = 400;

export interface NetFan {
  readonly net: string;
  /** fan: draw `targets` from `source`; tree: too many pins, draw a Net tree; highlight: ground, pads only; none: unknown or no-connect net, or no pin in view. */
  readonly mode: 'fan' | 'tree' | 'highlight' | 'none';
  readonly source: { readonly pinId: string; readonly basis: 'selected' | 'testpoint' | 'nearest-view' | 'first' } | null;
  /** The other pins in view (ids, file order); empty unless `mode` is 'fan'. */
  readonly targets: readonly string[];
  /** Pins of the net by side: only top, only bottom, through-hole. */
  readonly perSide: { readonly top: number; readonly bottom: number; readonly both: number };
  /** Pins in view (this side plus through-hole). */
  readonly inView: number;
  /** Pins only on the other side: "+N pins on the other side". */
  readonly otherSide: number;
}

export function netFan(graph: NetGraph, netName: string, options: NetFanOptions = {}): NetFan {
  const side: ViewSide = options.side === 'bottom' ? 'bottom' : 'top';
  const net = graph.netIndex(netName);
  const perSide = { top: 0, bottom: 0, both: 0 };
  const empty: NetFan = { net: netName, mode: 'none', source: null, targets: [], perSide, inView: 0, otherSide: 0 };
  if (net < 0 || graph.isNoConnect(net)) return empty;
  const visible: number[] = [];
  for (const pin of graph.netPins(net)) {
    const record = graph.pin(pin);
    if (record.side === 'both') perSide.both++; else if (record.side === 'bottom') perSide.bottom++; else perSide.top++;
    if (pinOnSide(record.side, side) && Number.isFinite(record.x) && Number.isFinite(record.y)) visible.push(pin);
  }
  const otherSide = side === 'top' ? perSide.bottom : perSide.top;
  const base = { net: netName, perSide, inView: visible.length, otherSide };
  if (graph.isGround(net)) return { ...base, mode: 'highlight', source: null, targets: [] };
  if (visible.length === 0) return { ...base, mode: 'none', source: null, targets: [] };
  const limit = typeof options.treeAbove === 'number' && Number.isFinite(options.treeAbove) ? Math.max(1, Math.floor(options.treeAbove)) : DEFAULT_TREE_ABOVE;
  if (visible.length > limit) return { ...base, mode: 'tree', source: null, targets: [] };

  let source = -1;
  let basis: NonNullable<NetFan['source']>['basis'] = 'first';
  if (options.selectedPinId !== undefined) {
    const selected = graph.pinIndex(options.selectedPinId);
    if (selected >= 0 && visible.includes(selected)) { source = selected; basis = 'selected'; }
  }
  const center = options.viewCenter && Number.isFinite(options.viewCenter.x) && Number.isFinite(options.viewCenter.y) ? options.viewCenter : null;
  const nearest = (candidates: readonly number[]): number => {
    if (!center) return candidates[0] ?? -1;
    let best = -1, bestDistance = Infinity;
    for (const pin of candidates) {
      const record = graph.pin(pin), d = (record.x - center.x) ** 2 + (record.y - center.y) ** 2;
      if (d < bestDistance) { bestDistance = d; best = pin; }
    }
    return best;
  };
  if (source < 0) {
    const testPoints = visible.filter(pin => graph.pinPart[pin] >= 0 && graph.kindOf(graph.pinPart[pin]).kind === 'testpoint');
    if (testPoints.length) { source = nearest(testPoints); basis = 'testpoint'; }
  }
  if (source < 0) { source = nearest(visible); basis = center ? 'nearest-view' : 'first'; }
  const targets = visible.filter(pin => pin !== source).map(pin => graph.pin(pin).id);
  return { ...base, mode: 'fan', source: { pinId: graph.pin(source).id, basis }, targets };
}
