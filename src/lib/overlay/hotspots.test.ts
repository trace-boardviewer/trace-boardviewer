import { expectCostAtMost, linearReference } from '../../test-support/timing';
import { describe, expect, it } from 'vitest';
import type { Bounds2, Point2 } from '../geometry';
import { clipPolygonToRect, featuresUnderPolygon, imagePolygonToBoard, polygonArea } from './damage';
import {
  type BoardFeature, type FeatureQuery, analyzeHotRegions, analyzeThermal, buildFeatureIndex, findHotRegions, intersectWithNets,
} from './hotspots';
import { type Matrix3, invert, transform } from './matrix3';
import { registerBoardImage } from './registration';
import { type ThermalGrid, makeGrid } from './thermal';
import { Rng, cameraMatrix, forAll, makePairs } from './testkit';
import { type HeatSource, type ToyBoardOptions, makeThermalGrid, makeToyBoard } from './testkit-board';

const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y);

/** A grid from rows of numbers. */
const gridOf = (rows: number[][]): ThermalGrid => makeGrid(rows[0].length, rows.length, Float32Array.from(rows.flat()), 'celsius');
/** A grid of `width` x `height` cells of `background` with `set(x, y)` overriding the cells it returns a number for. */
function paint(width: number, height: number, background: number, set: (x: number, y: number) => number | undefined): ThermalGrid {
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) values[y * width + x] = set(x, y) ?? background;
  return makeGrid(width, height, values, 'celsius');
}
const gaussian = (cx: number, cy: number, sigma: number, rise: number) => (x: number, y: number) => rise * Math.exp(-((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) / (2 * sigma * sigma));

describe('findHotRegions', () => {
  it('finds one blob: its peak, its cells, its centre, and labels every cell', () => {
    const blob = gaussian(40.5, 30.5, 4, 30);
    const grid = paint(100, 80, 25, (x, y) => 25 + blob(x, y));
    const result = findHotRegions(grid);
    expect(result.regions).toHaveLength(1);
    const region = result.regions[0];
    expect(result.baseline).toBeCloseTo(25, 4);
    expect(result.extreme).toBeCloseTo(region.peak, 6);
    expect(result.threshold).toBeCloseTo(result.baseline + 0.5 * (result.extreme - result.baseline), 5);
    expect(region.id).toBe(1);
    expect(region.peakCell).toEqual({ x: 40, y: 30 });
    expect(region.centroid.x).toBeCloseTo(40.5, 6);
    expect(region.centroid.y).toBeCloseTo(30.5, 6);
    expect(region.heatCentroid.x).toBeCloseTo(40.5, 4);
    expect(region.heatCentroid.y).toBeCloseTo(30.5, 4);
    // Half the maximum: a disc of radius sigma * sqrt(2 ln 2) = 4.7 cells, about 70 cells.
    expect(region.cellCount).toBeGreaterThan(60);
    expect(region.cellCount).toBeLessThan(80);
    expect(region.cells).toHaveLength(region.cellCount);
    expect(region.bounds.minX).toBeCloseTo(36, 0);
    expect(region.bounds.maxX).toBeCloseTo(45, 0);
    for (const index of region.cells) expect(result.labels[index]).toBe(1);
    expect(result.labels.reduce((n, id) => n + (id ? 1 : 0), 0)).toBe(region.cellCount);
    expect(result.contrast).toBeCloseTo(result.extreme - result.baseline, 6);
    expect(result.contrastSigma).toBeGreaterThan(50);
    expect(region.mean).toBeGreaterThan(result.threshold);
    expect(region.mean).toBeLessThan(region.peak);
    expect(result.truncated).toBe(false);
    expect(result.polarity).toBe('hot');
  });

  it('orders regions by their peak, keeps the hottest ones and says when it dropped some', () => {
    const a = gaussian(20, 20, 3, 40), b = gaussian(60, 20, 3, 50), c = gaussian(40, 55, 3, 45);
    const grid = paint(90, 80, 20, (x, y) => 20 + a(x, y) + b(x, y) + c(x, y));
    const result = findHotRegions(grid, { threshold: { mode: 'delta', delta: 10 } });
    expect(result.regions.map(r => Math.round(r.centroid.x))).toEqual([60, 40, 20]);
    expect(result.regions.map(r => r.id)).toEqual([1, 2, 3]);
    expect(result.regions[0].peak).toBeGreaterThan(result.regions[1].peak);
    const two = findHotRegions(grid, { threshold: { mode: 'delta', delta: 10 }, maxRegions: 2 });
    expect(two.regions.map(r => Math.round(r.centroid.x))).toEqual([60, 40]);
    expect(two.truncated).toBe(true);
    expect(two.labels.reduce((n, id) => Math.max(n, id), 0)).toBe(2);
    // The cells of the dropped region are unlabeled.
    expect(two.labels[20 * 90 + 20]).toBe(0);
    expect(findHotRegions(grid, { threshold: { mode: 'delta', delta: 10 }, maxRegions: 3 }).truncated).toBe(false);
  });

  it('applies the four kinds of threshold to the median, the maximum and the noise of the picture', () => {
    const rng = new Rng(401);
    const blob = gaussian(30, 30, 5, 40);
    const grid = paint(64, 64, 20, (x, y) => 20 + blob(x, y) + 0.1 * rng.gaussian());
    const stats = findHotRegions(grid);
    const base = stats.baseline, top = stats.extreme;
    expect(base).toBeCloseTo(20, 1);
    expect(findHotRegions(grid, { threshold: { mode: 'fraction', fraction: 0.25 } }).threshold).toBeCloseTo(base + 0.25 * (top - base), 4);
    expect(findHotRegions(grid, { threshold: { mode: 'fraction', fraction: 1 }, minCells: 1 }).regions[0].cellCount).toBeLessThanOrEqual(2);
    expect(findHotRegions(grid, { threshold: { mode: 'delta', delta: 15 } }).threshold).toBeCloseTo(base + 15, 4);
    const sigma = findHotRegions(grid, { threshold: { mode: 'sigma', sigma: 8 } });
    expect(sigma.threshold).toBeCloseTo(base + 8 * sigma.sigma, 4);
    expect(sigma.sigma).toBeGreaterThan(0.05);
    expect(sigma.sigma).toBeLessThan(2);
    const absolute = findHotRegions(grid, { threshold: { mode: 'absolute', value: 45 } });
    expect(absolute.threshold).toBe(45);
    expect(absolute.regions[0].cellCount).toBeGreaterThan(5);
    // A lower fraction grows the region; a higher one shrinks it.
    const sizes = [0.2, 0.5, 0.8].map(fraction => findHotRegions(grid, { threshold: { mode: 'fraction', fraction } }).regions[0].cellCount);
    expect(sizes[0]).toBeGreaterThan(sizes[1]);
    expect(sizes[1]).toBeGreaterThan(sizes[2]);
  });

  it('finds nothing in a flat or an empty picture, and nothing hot above an absolute value that is never reached', () => {
    const flat = findHotRegions(paint(10, 10, 30, () => undefined));
    expect(flat.regions).toEqual([]);
    expect(flat.baseline).toBe(30);
    expect(flat.contrast).toBe(0);
    expect(flat.contrastSigma).toBe(0);
    expect(findHotRegions(paint(10, 10, 30, (x, y) => (x === 3 && y === 3 ? 31 : undefined)), { threshold: { mode: 'absolute', value: 99 } }).regions).toEqual([]);
    const empty = findHotRegions(makeGrid(4, 4, new Float32Array(16).fill(NaN)));
    expect(empty.regions).toEqual([]);
    expect(Number.isNaN(empty.threshold)).toBe(true);
  });

  it('drops regions smaller than minCells, and 4 or 8 connectivity decides whether a diagonal pair is one region', () => {
    const grid = paint(8, 8, 20, (x, y) => ((x === 2 && y === 2) || (x === 3 && y === 3) ? 50 : x === 6 && y === 6 ? 60 : undefined));
    expect(findHotRegions(grid).regions).toEqual([]);
    const lone = findHotRegions(grid, { minCells: 1, connectivity: 8 });
    expect(lone.regions.map(r => r.cellCount)).toEqual([1, 2]);
    expect(lone.regions[0].peak).toBe(60);
    const four = findHotRegions(grid, { minCells: 1, connectivity: 4, threshold: { mode: 'delta', delta: 10 } });
    expect(four.regions.map(r => r.cellCount)).toEqual([1, 1, 1]);
    expect(findHotRegions(grid, { minCells: 2, connectivity: 8, threshold: { mode: 'delta', delta: 10 } }).regions.map(r => r.cellCount)).toEqual([2]);
  });

  it('finds cold regions with polarity cold: the coldest value is the peak', () => {
    const dip = gaussian(30, 20, 4, -15);
    const grid = paint(60, 40, 30, (x, y) => 30 + dip(x, y));
    const result = findHotRegions(grid, { polarity: 'cold' });
    expect(result.polarity).toBe('cold');
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].peak).toBeCloseTo(15, 0);
    expect(result.baseline).toBeCloseTo(30, 3);
    expect(result.threshold).toBeLessThan(result.baseline);
    expect(result.threshold).toBeCloseTo(30 - 0.5 * (30 - result.extreme), 4);
    expect(result.regions[0].centroid.x).toBeCloseTo(30, 4);
    // Looked at as heat there is nothing: the hottest cell is the background itself, which the contrast says.
    const asHeat = findHotRegions(grid);
    expect(asHeat.contrast).toBeLessThan(0.01);
    expect(result.contrast).toBeCloseTo(15, 0);
    expect(result.contrastSigma).toBeGreaterThan(100);
    // A cold absolute threshold: everything at or below 20.
    expect(findHotRegions(grid, { polarity: 'cold', threshold: { mode: 'absolute', value: 20 } }).regions[0].peak).toBeCloseTo(15, 0);
  });

  it('never puts a cell without a reading into a region', () => {
    const blob = gaussian(20, 20, 6, 40);
    const base = paint(40, 40, 20, (x, y) => 20 + blob(x, y));
    for (let y = 18; y < 23; y++) for (let x = 18; x < 23; x++) base.values[y * 40 + x] = NaN;
    const result = findHotRegions(base);
    expect(result.regions).toHaveLength(1);
    for (const index of result.regions[0].cells) expect(Number.isNaN(base.values[index])).toBe(false);
    expect(result.regions[0].cellCount).toBeGreaterThan(30);
    expect(result.labels[20 * 40 + 20]).toBe(0);
  });

  it('is exactly the connected components of the cells above the threshold (property, against a plain flood fill)', () => {
    forAll(120, 411, rng => {
      const width = rng.int(2, 30), height = rng.int(2, 30), density = rng.range(0.1, 0.7);
      const mask = Uint8Array.from({ length: width * height }, () => (rng.chance(density) ? 1 : 0));
      const grid = makeGrid(width, height, Float32Array.from(mask, v => v * 10 + 0.001 * rng.next()));
      for (const connectivity of [4, 8] as const) {
        const reference: number[] = [], seen = new Uint8Array(mask.length);
        for (let start = 0; start < mask.length; start++) {
          if (!mask[start] || seen[start]) continue;
          const stack = [start]; seen[start] = 1; let size = 0;
          while (stack.length) {
            const i = stack.pop()!, x = i % width, y = (i - x) / width; size++;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              if ((!dx && !dy) || (connectivity === 4 && dx && dy)) continue;
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              const j = ny * width + nx;
              if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
            }
          }
          reference.push(size);
        }
        const result = findHotRegions(grid, { threshold: { mode: 'absolute', value: 5 }, connectivity, minCells: 1, maxRegions: 100000 });
        expect(result.regions.map(r => r.cellCount).sort((a, b) => a - b)).toEqual(reference.sort((a, b) => a - b));
        expect(result.regions.reduce((n, r) => n + r.cellCount, 0)).toBe(mask.reduce((n, v) => n + v, 0));
        for (const region of result.regions) for (const index of region.cells) expect(result.labels[index]).toBe(region.id);
      }
    });
  });

  it('rejects options that make no sense', () => {
    const grid = paint(5, 5, 1, () => undefined);
    for (const options of [
      { threshold: { mode: 'fraction' as const, fraction: 0 } }, { threshold: { mode: 'fraction' as const, fraction: 1.5 } }, { threshold: { mode: 'delta' as const, delta: -1 } },
      { threshold: { mode: 'sigma' as const, sigma: NaN } }, { threshold: { mode: 'absolute' as const, value: Infinity } }, { connectivity: 6 as unknown as 4 }, { minCells: 0 }, { minCells: 1.5 },
      { maxRegions: 0 }, { polarity: 'warm' as unknown as 'hot' },
    ]) expect(() => findHotRegions(grid, options)).toThrow(RangeError);
  });

  it('takes a 640 x 480 picture with 30 blobs with bounded work', () => {
    const rng = new Rng(412);
    for (const [width, height] of [[640, 480], [1280, 1024]] as const) {
      const blobs = Array.from({ length: 30 }, () => gaussian(rng.range(20, width - 20), rng.range(20, height - 20), rng.range(3, 9), rng.range(15, 50)));
      const grid = paint(width, height, 25, (x, y) => 25 + blobs.reduce((s, b) => s + b(x, y), 0) + 0.05 * rng.gaussian());
      expectCostAtMost('hot region cells', () => findHotRegions(grid, { threshold: { mode: 'delta', delta: 8 } }), linearReference(width * height), 300);
      const result = findHotRegions(grid, { threshold: { mode: 'delta', delta: 8 } });
      expect(result.regions.length).toBeGreaterThan(10);
    }
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------

interface Scene {
  board: ReturnType<typeof makeToyBoard>;
  truthImageToBoard: Matrix3;
  registration: ReturnType<typeof registerBoardImage>;
  query: FeatureQuery;
  grid: (sources: readonly HeatSource[], noise?: number) => ThermalGrid;
}

/** A 320 x 240 thermal camera (4 px/mm) over the toy board, and a registration made from six picked pads. */
function scene(seed: number, options: { tilt?: number; mirrored?: boolean; board?: ToyBoardOptions; width?: number; height?: number; side?: 'top' | 'bottom' } = {}): Scene {
  const rng = new Rng(seed);
  const mirrored = options.mirrored ?? false, width = options.width ?? 320, height = options.height ?? 240;
  const board = makeToyBoard({ side: mirrored ? 'bottom' : 'top', ...options.board });
  const tilt = options.tilt ?? 0;
  const spec = { focalPx: (400 * width) / 320, width, height, distanceMm: 100, tiltDeg: tilt, panDeg: tilt / 2, rollDeg: rng.range(-20, 20), mirrored };
  const truth = cameraMatrix(spec);
  // Six parts spread over the board: the four corners and two inner ones.
  const picks = [0, 9, 59, 50, 24, 36].map(i => board.components[i].position);
  const registration = registerBoardImage(makePairs(rng, picks, p => transform(truth, p)!, 0.2), { mirrored });
  const { query } = buildFeatureIndex(board);
  return { board, truthImageToBoard: invert(truth)!, registration, query, grid: (sources, noise = 0.05) => makeThermalGrid(width, height, invert(truth)!, sources, rng, { noise }) };
}

describe('the parts and pins under a hot region', () => {
  it('puts the hottest part first, with its pins, and locates the region on the board', () => {
    const { board, registration, query, grid } = scene(421);
    const at = board.centre(3, 2);
    const g = grid([{ at, rise: 30, sigmaMm: 1.2 }]);
    const { result, reports } = analyzeThermal(g, registration, query, { side: 'top' });
    expect(result.regions).toHaveLength(1);
    const report = reports[0];
    expect(dist(report.boardCentroid!, at)).toBeLessThan(0.3);
    expect(dist(report.boardPeak!, at)).toBeLessThan(0.6);
    // Half the maximum of a spot of sigma 1.2 mm is a disc of radius 1.41 mm.
    expect(report.areaMm2!).toBeGreaterThan(0.8 * Math.PI * 1.41 ** 2);
    expect(report.areaMm2!).toBeLessThan(1.2 * Math.PI * 1.41 ** 2);
    expect(report.boardBounds!.minX).toBeLessThan(at.x - 1);
    expect(report.boardBounds!.maxX).toBeGreaterThan(at.x + 1);
    expect(report.parts.map(h => h.feature.ref)).toEqual(['R3_2']);
    const top = report.parts[0];
    expect(top.feature.kind).toBe('part');
    expect(top.containsPeak).toBe(true);
    expect(top.peakRelative).toBeGreaterThan(0.95);
    expect(top.overlap).toBeGreaterThan(0.5);
    expect(top.coverage).toBeGreaterThan(0.5);
    expect(top.score).toBeCloseTo(top.overlap * top.peakRelative, 12);
    expect(top.hotCells).toBeLessThanOrEqual(top.cellsUnder);
    expect(top.peak).toBeCloseTo(result.regions[0].peak, 3);
    expect(report.pins.every(h => h.feature.ref === 'R3_2')).toBe(true);
    expect(report.pins.length).toBeGreaterThan(0);
  });

  it('ranks neighbours of a wide hot spot below the part at its centre, by score', () => {
    const { board, registration, query, grid } = scene(422);
    const at = board.centre(4, 3);
    const { reports } = analyzeThermal(grid([{ at, rise: 30, sigmaMm: 9 }]), registration, query);
    const parts = reports[0].parts;
    expect(parts.length).toBeGreaterThan(3);
    expect(parts[0].feature.ref).toBe('R4_3');
    expect(parts[0].containsPeak).toBe(true);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i - 1].score).toBeGreaterThanOrEqual(parts[i].score - 1e-12);
      expect(parts[i].containsPeak).toBe(false);
    }
    // The part at the edge of the region reads cooler than the region's peak.
    expect(parts[parts.length - 1].peakRelative).toBeLessThan(parts[0].peakRelative);
    expect(Math.min(...parts.map(p => p.overlap))).toBeGreaterThan(0);
    const limited = analyzeThermal(grid([{ at, rise: 30, sigmaMm: 9 }]), registration, query, { maxHits: 2 }).reports[0];
    expect(limited.parts).toHaveLength(2);
    expect(limited.pins.length).toBeLessThanOrEqual(2);
    const strict = analyzeThermal(grid([{ at, rise: 30, sigmaMm: 9 }]), registration, query, { minOverlap: 0.9 }).reports[0];
    expect(strict.parts.every(h => h.overlap >= 0.9)).toBe(true);
  });

  it('finds two sources as two regions, the hotter one first, each with its own part', () => {
    const { board, registration, query, grid } = scene(423);
    const hot = board.centre(1, 1), warm = board.centre(8, 4);
    const { result, reports } = analyzeThermal(grid([{ at: hot, rise: 40, sigmaMm: 1.2 }, { at: warm, rise: 28, sigmaMm: 1.2 }]), registration, query);
    expect(result.regions).toHaveLength(2);
    expect(reports.map(r => r.parts[0].feature.ref)).toEqual(['R1_1', 'R8_4']);
    expect(reports[0].region.peak).toBeGreaterThan(reports[1].region.peak);
  });

  it('reads a bottom side photo (mirrored board) and a tilted camera the same way', () => {
    for (const options of [{ mirrored: true }, { tilt: 18 }, { mirrored: true, tilt: 12 }]) {
      const { board, registration, query, grid } = scene(424, options);
      const at = board.centre(6, 1);
      const { reports } = analyzeThermal(grid([{ at, rise: 30, sigmaMm: 1.3 }]), registration, query, { side: options.mirrored ? 'bottom' : 'top' });
      expect(reports).toHaveLength(1);
      expect(reports[0].parts[0].feature.ref).toBe('R6_1');
      expect(dist(reports[0].boardCentroid!, at)).toBeLessThan(0.5);
    }
  });

  it('ignores features of the other side, and accepts those on both', () => {
    const { board, registration, grid } = scene(425, { mirrored: true });
    const at = board.centre(2, 2);
    const g = grid([{ at, rise: 30, sigmaMm: 1.3 }]);
    const withBoth = buildFeatureIndex({ components: [...board.components, { ...board.components[0], id: 'tb', ref: 'FID1', side: 'both', bounds: { minX: at.x - 1, minY: at.y - 1, maxX: at.x + 1, maxY: at.y + 1 }, pinIds: [] }], pins: board.pins }).query;
    const bottom = analyzeThermal(g, registration, withBoth, { side: 'bottom' }).reports[0];
    expect(bottom.parts.map(h => h.feature.ref).sort()).toEqual(['FID1', 'R2_2']);
    // The picture shows the top side: the toy board is on the bottom, so only the feature on both sides is listed.
    const top = analyzeThermal(g, registration, withBoth, { side: 'top' }).reports[0];
    expect(top.parts.map(h => h.feature.ref)).toEqual(['FID1']);
    expect(top.pins).toEqual([]);
  });

  it('finds a pad that is smaller than a thermal pixel through the pixel it is in', () => {
    const { board, registration, grid } = scene(426, { width: 80, height: 60 });
    const pin = board.pins.find(p => p.componentId === 'c20' && p.number === '1')!;
    const query = buildFeatureIndex(board).query;
    const g = grid([{ at: { x: pin.x, y: pin.y }, rise: 30, sigmaMm: 2 }], 0.02);
    const { reports } = analyzeThermal(g, registration, query);
    // 1 px/mm: a pad of 0.8 mm is within one cell.
    const hit = reports[0].pins.find(h => h.feature.pin === '1' && h.feature.ref === 'R0_2')!;
    expect(hit).toBeDefined();
    expect(hit.cellsUnder).toBeGreaterThanOrEqual(1);
    expect(hit.cellsUnder).toBeLessThanOrEqual(4);
    expect(hit.overlap).toBeGreaterThan(0.5);
  });

  it('returns reports without parts when the region is off the board or the query finds nothing', () => {
    const { board, registration, grid } = scene(427);
    const g = grid([{ at: board.centre(2, 2), rise: 30, sigmaMm: 1.3 }]);
    const none = analyzeThermal(g, registration, () => []).reports[0];
    expect(none.parts).toEqual([]);
    expect(none.pins).toEqual([]);
    expect(none.boardCentroid).not.toBeNull();
    const result = findHotRegions(g);
    expect(() => analyzeHotRegions(makeGrid(10, 10, new Float32Array(100)), result, registration, () => [])).toThrow(RangeError);
    const beyond: Matrix3 = [1, 0, 0, 0, 1, 0, 0.1, 0, -100];
    const horizon = analyzeHotRegions(g, result, { boardToImage: registration.boardToImage, imageToBoard: beyond }, () => [{ id: 'x', kind: 'part', ref: 'X', bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } }]);
    expect(horizon[0].boardBounds).toBeNull();
    expect(horizon[0].parts).toEqual([]);
  });

  it('works through a hot region of cold polarity (what cooled between two pictures)', () => {
    const { board, registration, query, grid } = scene(428);
    const at = board.centre(5, 3);
    const { result, reports } = analyzeThermal(grid([{ at, rise: -20, sigmaMm: 1.3 }]), registration, query, { polarity: 'cold' });
    expect(result.polarity).toBe('cold');
    expect(reports[0].parts[0].feature.ref).toBe('R5_3');
    expect(reports[0].parts[0].peak).toBeLessThan(result.baseline);
    expect(reports[0].parts[0].peakRelative).toBeGreaterThan(0.9);
  });

  it('finds the heated part on random scenes: 256 x 192 camera (3.2 px/mm), tilts to 15 degrees, both sides, noise to 0.6 degrees', () => {
    const rng = new Rng(430);
    let first = 0;
    const errors: number[] = [];
    const runs = 120;
    for (let run = 0; run < runs; run++) {
      const mirrored = rng.chance(0.5);
      const board = makeToyBoard({ side: mirrored ? 'bottom' : 'top' });
      const spec = { focalPx: 320, width: 256, height: 192, distanceMm: 100, tiltDeg: rng.range(-15, 15), panDeg: rng.range(-15, 15), rollDeg: rng.range(-180, 180), mirrored };
      const truth = cameraMatrix(spec);
      const picks = [0, 9, 59, 50, 24, 36].map(i => board.components[i].position);
      const registration = registerBoardImage(makePairs(rng, picks, p => transform(truth, p)!, 0.5), { mirrored });
      const column = rng.int(1, 8), row = rng.int(1, 4), at = board.centre(column, row);
      const grid = makeThermalGrid(256, 192, invert(truth)!, [{ at, rise: rng.range(15, 40), sigmaMm: rng.range(1, 1.8) }], rng, { noise: rng.range(0.05, 0.6) });
      const { reports } = analyzeThermal(grid, registration, buildFeatureIndex(board).query, { side: mirrored ? 'bottom' : 'top' });
      expect(reports).toHaveLength(1);
      if (reports[0].parts[0]?.feature.ref === board.refOf(column, row)) first++;
      errors.push(dist(reports[0].boardCentroid!, at));
    }
    errors.sort((a, b) => a - b);
    expect(first / runs).toBeGreaterThan(0.98);
    expect(errors[runs >> 1]).toBeLessThan(0.2);
    expect(errors[Math.floor(runs * 0.95)]).toBeLessThan(0.5);
  });

  it('analyzes a 640 x 480 picture with a 60 part board with bounded work', () => {
    const { board, registration, query, grid } = scene(429, { width: 640, height: 480, tilt: 10 });
    const g = grid([{ at: board.centre(3, 2), rise: 30, sigmaMm: 1.5 }, { at: board.centre(7, 4), rise: 20, sigmaMm: 2 }], 0.05);
    expectCostAtMost('thermal analysis cells', () => analyzeThermal(g, registration, query), linearReference(g.width * g.height), 300);
    const ranked = analyzeThermal(g, registration, query).reports.map(r => r.parts[0].feature.ref).join(',');
    expect(ranked).toBe('R3_2,R7_4');
  });
});

describe('nets', () => {
  const vdd = (column: number, row: number) => ((column === 3 && row === 2) || (column === 4 && row === 2) ? 'VDD_MAIN' : `S${column}_${row}`);

  it('keeps the hot parts and pins that are on the shorted rail, hot pin first', () => {
    const { board, registration, grid } = scene(431, { board: { netOf: vdd } });
    const query = buildFeatureIndex(board).query;
    // A wide spot over R3_2 and R4_2, both on the rail, and R2_2 and R5_2 next to them which are not.
    const { reports } = analyzeThermal(grid([{ at: { x: (board.centre(3, 2).x + board.centre(4, 2).x) / 2, y: board.centre(3, 2).y }, rise: 30, sigmaMm: 6.5 }]), registration, query);
    const refs = reports[0].parts.map(h => h.feature.ref);
    expect(refs).toEqual(expect.arrayContaining(['R3_2', 'R4_2']));
    const onRail = intersectWithNets(reports[0], ['vdd_main']);
    expect(onRail.nets).toEqual(['VDD_MAIN']);
    expect(onRail.parts.map(p => p.hit.feature.ref).sort()).toEqual(['R3_2', 'R4_2']);
    expect(onRail.parts.every(p => p.matchedNets.includes('VDD_MAIN'))).toBe(true);
    expect(onRail.pins.every(h => h.feature.net === 'VDD_MAIN')).toBe(true);
    for (const part of onRail.parts) for (const pin of part.hotPins) expect(pin.feature.ref).toBe(part.hit.feature.ref);
    expect(onRail.pins.length).toBeGreaterThanOrEqual(2);
    // Every part has a ground pin: GND selects them all.
    const ground = intersectWithNets(reports[0], ['GND']);
    expect(ground.parts.map(p => p.hit.feature.ref).sort()).toEqual([...refs].sort());
    // Nothing on a rail that is not under the spot.
    expect(intersectWithNets(reports[0], ['S0_0', 'NOPE', '', '  ']).parts).toEqual([]);
    expect(intersectWithNets(reports[0], []).nets).toEqual([]);
  });

  it('ranks a part with a hot pin on the net above a hotter part that merely has another pin on it', () => {
    const hit = (ref: string, score: number, kind: 'part' | 'pin', extra: Partial<BoardFeature> = {}) => ({
      feature: { id: `${kind}:${ref}`, kind, ref, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, ...extra } as BoardFeature, cellsUnder: 4, hotCells: 4, overlap: 1, coverage: 0.5, peak: 50, peakRelative: score, containsPeak: false, score,
    });
    const report = {
      parts: [hit('U1', 0.9, 'part', { nets: ['VDD', 'GND'] }), hit('C7', 0.4, 'part', { nets: ['VDD', 'GND'] }), hit('R1', 0.8, 'part', { nets: ['GND'] })],
      pins: [hit('C7', 0.4, 'pin', { net: 'VDD', pin: '1' })],
    };
    const result = intersectWithNets(report, ['VDD']);
    expect(result.parts.map(p => p.hit.feature.ref)).toEqual(['C7', 'U1']);
    expect(result.parts[0].hotPins).toHaveLength(1);
    expect(result.parts[1].hotPins).toHaveLength(0);
    expect(intersectWithNets(report, ['vdd'], { normalize: s => s }).parts).toEqual([]);
  });
});

describe('the loaded board as a feature index', () => {
  it('lists parts with their nets and pins with theirs, and answers rectangle queries', () => {
    const board = makeToyBoard({ netOf: (c, r) => (c === 0 && r === 0 ? 'VCC' : `S${c}_${r}`) });
    const { features, query } = buildFeatureIndex(board);
    expect(features).toHaveLength(60 + 120);
    const parts = features.filter(f => f.kind === 'part'), pins = features.filter(f => f.kind === 'pin');
    expect(parts).toHaveLength(60);
    expect(parts.find(f => f.ref === 'R0_0')!.nets).toEqual(['GND', 'VCC']);
    const pin = pins.find(f => f.ref === 'R0_0' && f.pin === '1')!;
    expect(pin.net).toBe('VCC');
    expect(pin.bounds.maxX - pin.bounds.minX).toBeCloseTo(0.8, 12);
    const hits = query({ minX: board.centre(2, 2).x - 0.1, minY: board.centre(2, 2).y - 0.1, maxX: board.centre(2, 2).x + 0.1, maxY: board.centre(2, 2).y + 0.1 });
    expect(hits.map(h => h.id).sort()).toEqual(['part:c22']);
    expect(query({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 })).toHaveLength(180);
    expect(query({ minX: 1e3, minY: 1e3, maxX: 1e3 + 1, maxY: 1e3 + 1 })).toEqual([]);
    expect(buildFeatureIndex(board, { includePins: false }).features).toHaveLength(60);
  });

  it('keeps one side, skips what has no usable geometry, and does not invent pin numbers', () => {
    const board = makeToyBoard();
    const components = [...board.components.slice(0, 3), { ...board.components[3], side: 'bottom' as const }, { ...board.components[4], side: 'both' as const }, { ...board.components[5], bounds: { minX: NaN, minY: 0, maxX: 1, maxY: 1 } }];
    const pins = board.pins.slice(0, 12).map((p, i) => (i === 0 ? { ...p, numberGenerated: true as const } : i === 6 || i === 7 ? { ...p, side: 'bottom' as const } : p));
    const top = buildFeatureIndex({ components, pins }, { side: 'top' });
    expect(top.features.filter(f => f.kind === 'part').map(f => f.ref).sort()).toEqual(['R0_0', 'R1_0', 'R2_0', 'R4_0']);
    expect(top.features.find(f => f.id === 'pin:c0p1')!.pin).toBeUndefined();
    expect(top.features.find(f => f.id === 'pin:c0p2')!.pin).toBe('2');
    expect(top.features.some(f => f.id.startsWith('pin:c3'))).toBe(false);
    const bottom = buildFeatureIndex({ components, pins }, { side: 'bottom' });
    expect(bottom.features.filter(f => f.kind === 'part').map(f => f.ref).sort()).toEqual(['R3_0', 'R4_0']);
  });
});

describe('damage and rework map (painted areas)', () => {
  const rect = (b: Bounds2): Point2[] => [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];

  it('clips a polygon to a rectangle with exact areas', () => {
    const unit = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(polygonArea(clipPolygonToRect(rect({ minX: -5, minY: -5, maxX: 15, maxY: 15 }), unit))).toBeCloseTo(100, 12);
    expect(polygonArea(clipPolygonToRect(rect({ minX: 2, minY: 3, maxX: 6, maxY: 5 }), unit))).toBeCloseTo(8, 12);
    expect(polygonArea(clipPolygonToRect(rect({ minX: 5, minY: 5, maxX: 15, maxY: 15 }), unit))).toBeCloseTo(25, 12);
    expect(clipPolygonToRect(rect({ minX: 20, minY: 20, maxX: 30, maxY: 30 }), unit)).toEqual([]);
    // A triangle with a corner outside.
    expect(polygonArea(clipPolygonToRect([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }], unit))).toBeCloseTo(100 - 0, 12);
    expect(polygonArea(clipPolygonToRect([{ x: 5, y: 5 }, { x: 25, y: 5 }, { x: 5, y: 25 }], unit))).toBeCloseTo(25, 12);
    // A concave L: its area inside the rectangle is the area of the L cut by the window.
    const ell = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 20 }, { x: 0, y: 20 }];
    expect(polygonArea(ell)).toBeCloseTo(175, 12);
    expect(polygonArea(clipPolygonToRect(ell, unit))).toBeCloseTo(10 * 5 + 5 * 5, 12);
  });

  it('matches the analytic overlap of two random rectangles (property)', () => {
    forAll(300, 441, rng => {
      const a: Bounds2 = { minX: rng.range(-10, 10), minY: rng.range(-10, 10), maxX: 0, maxY: 0 };
      a.maxX = a.minX + rng.range(0.1, 15); a.maxY = a.minY + rng.range(0.1, 15);
      const b: Bounds2 = { minX: rng.range(-10, 10), minY: rng.range(-10, 10), maxX: 0, maxY: 0 };
      b.maxX = b.minX + rng.range(0.1, 15); b.maxY = b.minY + rng.range(0.1, 15);
      const expected = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
      // Either orientation of the polygon gives the same area.
      expect(polygonArea(clipPolygonToRect(rect(a), b))).toBeCloseTo(expected, 9);
      expect(polygonArea(clipPolygonToRect(rect(a).reverse(), b))).toBeCloseTo(expected, 9);
    });
  });

  it('lists the parts, pins and nets under a painted area, with the share of each that is covered', () => {
    const board = makeToyBoard({ netOf: (c, r) => (r === 2 ? 'RAIL' : `S${c}_${r}`) });
    const { query } = buildFeatureIndex(board);
    const a = board.centre(2, 2), b = board.centre(3, 2);
    // Covers part R2_2 entirely and the left half of R3_2.
    const area = rect({ minX: a.x - 3, minY: a.y - 3, maxX: b.x, maxY: a.y + 3 });
    const report = featuresUnderPolygon(area, query);
    expect(report.areaMm2).toBeCloseTo(polygonArea(area), 12);
    expect(report.parts.map(h => h.feature.ref)).toEqual(['R2_2', 'R3_2']);
    expect(report.parts[0].fraction).toBeCloseTo(1, 9);
    expect(report.parts[1].fraction).toBeCloseTo(0.5, 9);
    expect(report.parts[0].areaMm2).toBeCloseTo(8, 9);
    expect(report.pins.map(h => `${h.feature.ref}.${h.feature.pin}`)).toEqual(['R2_2.1', 'R2_2.2', 'R3_2.1']);
    expect(report.nets.map(n => [n.net, n.pins])).toEqual([['RAIL', 2], ['GND', 1]]);
    expect(report.nets[0]).toEqual({ net: 'RAIL', pins: 2, refs: ['R2_2', 'R3_2'] });
    // A small scratch over a pad only.
    const pad = board.pins.find(p => p.componentId === 'c22' && p.number === '2')!;
    const scratch = featuresUnderPolygon(rect({ minX: pad.x - 0.2, minY: pad.y - 0.2, maxX: pad.x + 0.2, maxY: pad.y + 0.2 }), query);
    expect(scratch.pins.map(h => h.feature.id)).toEqual(['pin:c22p2']);
    expect(scratch.pins[0].fraction).toBeCloseTo(0.25, 9);
    // The scratch is 2 % of the part, below the default 5 %.
    expect(scratch.parts).toEqual([]);
    const fine = featuresUnderPolygon(rect({ minX: pad.x - 0.2, minY: pad.y - 0.2, maxX: pad.x + 0.2, maxY: pad.y + 0.2 }), query, { minFraction: 0.01 });
    expect(fine.parts.map(h => h.feature.ref)).toEqual(['R2_2']);
    expect(fine.parts[0].fraction).toBeCloseTo(0.02, 9);
  });

  it('filters by side, and treats a feature without extent as covered or not', () => {
    const point = (id: string, x: number, y: number, side?: 'top' | 'bottom'): BoardFeature => ({ id, kind: 'pin', ref: id, net: 'N', side, bounds: { minX: x, minY: y, maxX: x, maxY: y } });
    const all = [point('inside', 5, 5), point('outside', 50, 50), point('bottom', 6, 6, 'bottom')];
    const query: FeatureQuery = () => all;
    const area = rect({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(featuresUnderPolygon(area, query).pins.map(h => h.feature.id)).toEqual(['bottom', 'inside']);
    expect(featuresUnderPolygon(area, query, { side: 'top' }).pins.map(h => h.feature.id)).toEqual(['inside']);
    expect(featuresUnderPolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }], query).pins).toEqual([]);
    expect(featuresUnderPolygon([{ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 1, y: 3 }], query).pins).toEqual([]);
  });

  it('maps a polygon painted on the photo to the board, or reports that it cannot', () => {
    const { registration } = scene(443);
    const target = rect({ minX: -10, minY: -5, maxX: 10, maxY: 5 });
    const painted = target.map(p => transform(registration.boardToImage, p)!);
    const back = imagePolygonToBoard(registration, painted)!;
    back.forEach((p, i) => expect(dist(p, target[i])).toBeLessThan(1e-6));
    expect(imagePolygonToBoard(registration, painted.slice(0, 2))).toBeNull();
    expect(imagePolygonToBoard({ imageToBoard: [1, 0, 0, 0, 1, 0, 0.1, 0, -100] }, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }])).toBeNull();
  });

  it('gives the same parts from a painted mask (a grid of 0 and 1) as from the polygon', () => {
    const { board, registration, query } = scene(444);
    const target = board.centre(5, 3);
    const area = rect({ minX: target.x - 1.5, minY: target.y - 0.8, maxX: target.x + 1.5, maxY: target.y + 0.8 });
    const polygonHits = featuresUnderPolygon(area, query);
    // The same area as pixels of the photo.
    const image = area.map(p => transform(registration.boardToImage, p)!);
    const xs = image.map(p => p.x), ys = image.map(p => p.y);
    const mask = paint(320, 240, 0, (x, y) => (x + 0.5 >= Math.min(...xs) && x + 0.5 <= Math.max(...xs) && y + 0.5 >= Math.min(...ys) && y + 0.5 <= Math.max(...ys) ? 1 : undefined));
    const { reports } = analyzeThermal(mask, registration, query, { threshold: { mode: 'absolute', value: 0.5 }, minCells: 1 });
    expect(reports).toHaveLength(1);
    expect(reports[0].parts.map(h => h.feature.ref)).toEqual(polygonHits.parts.map(h => h.feature.ref));
    expect(reports[0].parts[0].feature.ref).toBe('R5_3');
  });
});
