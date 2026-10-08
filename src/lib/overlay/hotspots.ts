import { type Bounds2, type Point2, SpatialIndex, expandBounds, padBounds } from '../geometry';
import type { Board, BoardSide } from '../types';
import { jacobian, transform } from './matrix3';
import { type Registration, mapBoardRectToImage, mapImageRectToBoard } from './registration';
import { type ThermalGrid, statsOfValues, validateGrid } from './thermal';

/**
 * Hot regions of a thermal grid and the parts and pins under them (F12), and the same list for any painted area (F14: a damage mask is a grid of
 * 0 and 1 and `{ mode: 'absolute', value: 0.5 }` picks it out).
 *
 * The board is reached only through `FeatureQuery`, a callback that returns the features (parts, pins) whose bounds touch a board rectangle, so the
 * code works with the SpatialIndex of the board canvas, with `buildFeatureIndex` below, or with a hand-made list in a test.
 */

// ---------------------------------------------------------------------------------------------
// Hot regions
// ---------------------------------------------------------------------------------------------

export type HotThreshold =
  /** median + fraction * (max - median): `fraction` in (0, 1], default 0.5, so a region is whatever rises more than half way to the hottest cell. */
  | { readonly mode: 'fraction'; readonly fraction: number }
  /** median + delta, in the units of the grid (for example 5 degrees above the board's typical temperature). */
  | { readonly mode: 'delta'; readonly delta: number }
  /** median + sigma * robust standard deviation (1.4826 MAD) of the picture. */
  | { readonly mode: 'sigma'; readonly sigma: number }
  /** A fixed value (a temperature, a grey level): hot cells are at or above it, cold cells at or below. */
  | { readonly mode: 'absolute'; readonly value: number };

export interface HotRegionOptions {
  /** Default { mode: 'fraction', fraction: 0.5 }. */
  threshold?: HotThreshold;
  /** 'cold' finds the regions that are colder than the rest (a difference picture of something that cooled). Default 'hot'. */
  polarity?: 'hot' | 'cold';
  /** Cells touch by edge (4) or by edge and corner (8, default). */
  connectivity?: 4 | 8;
  /** Regions of fewer cells are noise (default 3). */
  minCells?: number;
  /** The hottest this many regions are kept (default 16); `truncated` says that more existed. */
  maxRegions?: number;
}

export interface HotRegion {
  /** 1 for the region with the hottest peak, 2 for the next, ... The same number labels its cells in `HotRegionResult.labels`. */
  readonly id: number;
  readonly cellCount: number;
  /** The hottest value of the region (the coldest for polarity 'cold'), in the units of the grid. */
  readonly peak: number;
  /** Column and row of the cell with the peak. */
  readonly peakCell: { readonly x: number; readonly y: number };
  readonly mean: number;
  /** Mean of the cell centres, image pixels. */
  readonly centroid: Point2;
  /** Centroid weighted by how far each cell is above the threshold: lies toward the heat source. */
  readonly heatCentroid: Point2;
  /** Outer edges of the cells, image pixels. */
  readonly bounds: Bounds2;
  /** Linear cell indices (row * width + column) of the region. */
  readonly cells: Int32Array;
}

export interface HotRegionResult {
  readonly width: number;
  readonly height: number;
  readonly polarity: 'hot' | 'cold';
  /** The value a cell has to reach (in the units of the grid). */
  readonly threshold: number;
  /** Median of the picture: what a typical cell reads. */
  readonly baseline: number;
  /** Robust standard deviation of the picture (1.4826 MAD). */
  readonly sigma: number;
  /** Hottest (coldest for 'cold') value of the picture. */
  readonly extreme: number;
  /** How far the extreme is from the baseline, in the units of the grid (never negative). Small next to `sigma`: nothing stands out, and any region is background texture. */
  readonly contrast: number;
  /** contrast / sigma: how many noise levels the hottest cell stands out (Infinity for a picture without noise). */
  readonly contrastSigma: number;
  readonly regions: readonly HotRegion[];
  readonly truncated: boolean;
  /** Region id (1-based) of every cell, 0 for cells in no region. */
  readonly labels: Int32Array;
}

const DEFAULT_THRESHOLD: HotThreshold = { mode: 'fraction', fraction: 0.5 };

function checkOptions(options: HotRegionOptions): { threshold: HotThreshold; sign: 1 | -1; eight: boolean; minCells: number; maxRegions: number } {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const bad = (what: string) => new RangeError(`Invalid hot region option: ${what}.`);
  if (threshold.mode === 'fraction' && !(threshold.fraction > 0 && threshold.fraction <= 1)) throw bad('fraction must be in (0, 1]');
  if (threshold.mode === 'delta' && !(threshold.delta >= 0 && Number.isFinite(threshold.delta))) throw bad('delta must be zero or more');
  if (threshold.mode === 'sigma' && !(threshold.sigma >= 0 && Number.isFinite(threshold.sigma))) throw bad('sigma must be zero or more');
  if (threshold.mode === 'absolute' && !Number.isFinite(threshold.value)) throw bad('the absolute value must be finite');
  if (options.polarity !== undefined && options.polarity !== 'hot' && options.polarity !== 'cold') throw bad('polarity');
  if (options.connectivity !== undefined && options.connectivity !== 4 && options.connectivity !== 8) throw bad('connectivity must be 4 or 8');
  const minCells = options.minCells ?? 3, maxRegions = options.maxRegions ?? 16;
  if (!Number.isInteger(minCells) || minCells < 1) throw bad('minCells must be a whole number of at least 1');
  if (!Number.isInteger(maxRegions) || maxRegions < 1) throw bad('maxRegions must be a whole number of at least 1');
  return { threshold, sign: options.polarity === 'cold' ? -1 : 1, eight: options.connectivity !== 4, minCells, maxRegions };
}

interface RawRegion { start: number; end: number; peak: number; peakIndex: number; sum: number; sumX: number; sumY: number; weight: number; weightX: number; weightY: number; minX: number; minY: number; maxX: number; maxY: number }

/**
 * Connected regions of cells above a threshold that is relative to the picture itself (median and maximum), so one setting works for a 25 degree
 * board and a 60 degree one. Cells without a reading are never in a region. Linear in the number of cells (a flood fill with an index queue, no recursion).
 */
export function findHotRegions(grid: ThermalGrid, options: HotRegionOptions = {}): HotRegionResult {
  validateGrid(grid);
  const { threshold: rule, sign, eight, minCells, maxRegions } = checkOptions(options);
  const { width, height } = grid, count = width * height;
  const polarity = sign < 0 ? 'cold' : 'hot';
  // Everything below is done on `signed` (the grid for 'hot', its negative for 'cold'), so that "hot" always means "large".
  const signed = new Float32Array(count);
  for (let i = 0; i < count; i++) { const v = grid.values[i]; signed[i] = Number.isFinite(v) ? sign * v : NaN; }
  const stats = statsOfValues(signed);
  const contrastOf = (extreme: number, baseline: number, sigma: number) => { const contrast = Math.max(0, extreme - baseline); return { contrast, contrastSigma: sigma > 0 ? contrast / sigma : contrast > 0 ? Infinity : 0 }; };
  const empty = (threshold: number, baseline: number, sigma: number, extreme: number): HotRegionResult => ({ width, height, polarity, threshold: sign * threshold, baseline: sign * baseline, sigma, extreme: sign * extreme, ...contrastOf(extreme, baseline, sigma), regions: [], truncated: false, labels: new Int32Array(count) });
  if (!stats) return empty(NaN, NaN, NaN, NaN);
  const { median, max, robustSigma } = stats;
  const threshold = rule.mode === 'fraction' ? median + rule.fraction * (max - median)
    : rule.mode === 'delta' ? median + rule.delta
    : rule.mode === 'sigma' ? median + rule.sigma * robustSigma
    : sign * rule.value;
  const aboveMedian = rule.mode !== 'absolute';
  let maskCount = 0;
  for (let i = 0; i < count; i++) { const v = signed[i]; if (v >= threshold && (!aboveMedian || v > median)) maskCount++; }
  if (!maskCount) return empty(threshold, median, robustSigma, max);

  const labels = new Int32Array(count);
  const queue = new Int32Array(maskCount);
  const raw: RawRegion[] = [];
  const base = Math.min(threshold, median), epsilon = 1e-9 * (1 + Math.abs(max));
  let tail = 0;
  for (let seed = 0; seed < count; seed++) {
    const sv = signed[seed];
    if (labels[seed] !== 0 || !(sv >= threshold && (!aboveMedian || sv > median))) continue;
    const label = raw.length + 1;
    const region: RawRegion = { start: tail, end: tail, peak: -Infinity, peakIndex: seed, sum: 0, sumX: 0, sumY: 0, weight: 0, weightX: 0, weightY: 0, minX: width, minY: height, maxX: -1, maxY: -1 };
    labels[seed] = label; queue[tail++] = seed;
    for (let head = tail - 1; head < tail; head++) {
      const index = queue[head], y = Math.floor(index / width), x = index - y * width, v = signed[index];
      region.sum += v; region.sumX += x + 0.5; region.sumY += y + 0.5;
      const weight = v - base + epsilon;
      region.weight += weight; region.weightX += weight * (x + 0.5); region.weightY += weight * (y + 0.5);
      if (v > region.peak) { region.peak = v; region.peakIndex = index; }
      if (x < region.minX) region.minX = x;
      if (x > region.maxX) region.maxX = x;
      if (y < region.minY) region.minY = y;
      if (y > region.maxY) region.maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx === 0 && dy === 0) || (!eight && dx !== 0 && dy !== 0)) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const next = ny * width + nx, nv = signed[next];
          if (labels[next] === 0 && nv >= threshold && (!aboveMedian || nv > median)) { labels[next] = label; queue[tail++] = next; }
        }
      }
    }
    region.end = tail;
    raw.push(region);
  }

  const kept = raw.map((region, i) => ({ region, label: i + 1 })).filter(({ region }) => region.end - region.start >= minCells)
    .sort((a, b) => b.region.peak - a.region.peak || (b.region.end - b.region.start) - (a.region.end - a.region.start) || a.label - b.label);
  const truncated = kept.length > maxRegions;
  const chosen = kept.slice(0, maxRegions);
  const remap = new Int32Array(raw.length + 1);
  chosen.forEach(({ label }, i) => { remap[label] = i + 1; });
  for (let i = 0; i < count; i++) if (labels[i]) labels[i] = remap[labels[i]];
  const regions: HotRegion[] = chosen.map(({ region }, i) => {
    const n = region.end - region.start, peakY = Math.floor(region.peakIndex / width);
    return {
      id: i + 1, cellCount: n, peak: sign * region.peak, peakCell: { x: region.peakIndex - peakY * width, y: peakY }, mean: sign * region.sum / n,
      centroid: { x: region.sumX / n, y: region.sumY / n }, heatCentroid: { x: region.weightX / region.weight, y: region.weightY / region.weight },
      bounds: { minX: region.minX, minY: region.minY, maxX: region.maxX + 1, maxY: region.maxY + 1 }, cells: queue.slice(region.start, region.end),
    };
  });
  return { width, height, polarity, threshold: sign * threshold, baseline: sign * median, sigma: robustSigma, extreme: sign * max, ...contrastOf(max, median, robustSigma), regions, truncated, labels };
}

// ---------------------------------------------------------------------------------------------
// What is under a region
// ---------------------------------------------------------------------------------------------

/** A part or a pin of the board as the overlay sees it. Bounds are canonical board millimetres. */
export interface BoardFeature {
  /** Unique within one query result. */
  readonly id: string;
  readonly kind: 'part' | 'pin';
  /** Reference designator of the part (of the part the pin belongs to, for a pin). */
  readonly ref: string;
  /** Pin number (pins only; absent when the file gives the pad none). */
  readonly pin?: string;
  /** Net of the pin (pins only). */
  readonly net?: string;
  /** The nets of all pins of the part (parts only). */
  readonly nets?: readonly string[];
  readonly side?: BoardSide;
  readonly bounds: Bounds2;
}

/** Features whose bounds touch the board rectangle (they may also lie a little outside it). */
export type FeatureQuery = (bounds: Bounds2) => readonly BoardFeature[];

export interface FeatureHit {
  readonly feature: BoardFeature;
  /** Cells with a reading under the footprint of the feature (at least 1 when the footprint is on the picture: a pad is smaller than a thermal pixel). */
  readonly cellsUnder: number;
  /** How many of them belong to the region. */
  readonly hotCells: number;
  /** hotCells / cellsUnder: how much of the part is hot. */
  readonly overlap: number;
  /** hotCells / region.cellCount: how much of the region the part explains. */
  readonly coverage: number;
  /** The hottest value of the region's cells under the part (coldest for polarity 'cold'). */
  readonly peak: number;
  /** How close that is to the region's own peak: 1 when the part holds the peak cell's temperature, near 0 when it only touches the edge of the region. */
  readonly peakRelative: number;
  /** True when the region's peak cell is under the part. */
  readonly containsPeak: boolean;
  /** overlap * peakRelative, 0 to 1; hits are ranked by it. */
  readonly score: number;
}

export interface RegionReport {
  readonly region: HotRegion;
  /** The region on the board: centroid, peak, bounds (null when it has no board position) and area. */
  readonly boardCentroid: Point2 | null;
  readonly boardPeak: Point2 | null;
  readonly boardBounds: Bounds2 | null;
  readonly areaMm2: number | null;
  /** Ranked best first. */
  readonly parts: readonly FeatureHit[];
  readonly pins: readonly FeatureHit[];
}

export interface AnalyzeOptions {
  /** The side the picture shows: features that are only on the other side are ignored. Default: all. */
  side?: 'top' | 'bottom';
  /** At most this many parts and this many pins per region (default 25). */
  maxHits?: number;
  /** Hits with a smaller overlap are dropped (default 0: any hot cell under the part counts). */
  minOverlap?: number;
  /** How far outside the region the board is searched for features, millimetres (default 0.5). */
  marginMm?: number;
}

interface Footprint { cells: number[]; }

/** Indices of the cells with a reading whose centres are inside the quad (or, when none are, the one cell that contains the quad's centre: a pad is smaller than a pixel). */
function cellsUnderQuad(corners: readonly Point2[], grid: ThermalGrid): Footprint {
  const { width, height, values } = grid;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, cx = 0, cy = 0;
  for (const p of corners) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); cx += p.x / 4; cy += p.y / 4; }
  const cells: number[] = [];
  if (maxX < 0 || maxY < 0 || minX > width || minY > height) return { cells };
  let area = 0;
  for (let i = 0; i < 4; i++) { const a = corners[i], b = corners[(i + 1) % 4]; area += a.x * b.y - b.x * a.y; }
  const orient = area < 0 ? -1 : 1;
  const i0 = Math.max(0, Math.ceil(minX - 0.5)), i1 = Math.min(width - 1, Math.floor(maxX - 0.5));
  const j0 = Math.max(0, Math.ceil(minY - 0.5)), j1 = Math.min(height - 1, Math.floor(maxY - 0.5));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const px = i + 0.5, py = j + 0.5;
    let inside = true;
    for (let k = 0; k < 4 && inside; k++) {
      const a = corners[k], b = corners[(k + 1) % 4];
      if (orient * ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x)) < 0) inside = false;
    }
    if (inside && Number.isFinite(values[j * width + i])) cells.push(j * width + i);
  }
  if (!cells.length && cx >= 0 && cx < width && cy >= 0 && cy < height) {
    const index = Math.floor(cy) * width + Math.floor(cx);
    if (Number.isFinite(values[index])) cells.push(index);
  }
  return { cells };
}

const byScore = (a: FeatureHit, b: FeatureHit, sign: 1 | -1): number =>
  b.score - a.score || sign * (b.peak - a.peak) || b.overlap - a.overlap || (a.feature.id < b.feature.id ? -1 : a.feature.id > b.feature.id ? 1 : 0);

function sideAllows(feature: BoardFeature, side: 'top' | 'bottom' | undefined): boolean {
  return !side || !feature.side || feature.side === 'both' || feature.side === side;
}

/**
 * For every region: where it is on the board and the parts and pins under it, ranked by how much of the feature is hot (overlap) and how close its
 * hottest cell is to the region's peak. The grid must be the one `findHotRegions` was given and `registration` the alignment of that grid (image
 * coordinates = grid coordinates, see thermal.ts).
 */
export function analyzeHotRegions(grid: ThermalGrid, result: HotRegionResult, registration: Pick<Registration, 'boardToImage' | 'imageToBoard'>, query: FeatureQuery, options: AnalyzeOptions = {}): RegionReport[] {
  validateGrid(grid);
  if (grid.width !== result.width || grid.height !== result.height) throw new RangeError('The hot regions were found on a grid of another size.');
  const maxHits = options.maxHits ?? 25, minOverlap = options.minOverlap ?? 0, margin = options.marginMm ?? 0.5;
  const sign = result.polarity === 'cold' ? -1 : 1;
  const reports: RegionReport[] = [];
  for (const region of result.regions) {
    const footprint = mapImageRectToBoard(registration, region.bounds);
    const boardCentroid = transform(registration.imageToBoard, region.heatCentroid);
    const boardPeak = transform(registration.imageToBoard, { x: region.peakCell.x + 0.5, y: region.peakCell.y + 0.5 });
    const j = jacobian(registration.imageToBoard, region.centroid);
    const areaMm2 = j ? region.cellCount * Math.abs(j[0] * j[3] - j[1] * j[2]) : null;
    const parts: FeatureHit[] = [], pins: FeatureHit[] = [];
    if (footprint) {
      const peakSigned = sign * region.peak, baselineSigned = sign * result.baseline, span = peakSigned - baselineSigned;
      for (const feature of query(expandBounds(footprint.bounds, margin))) {
        if (!sideAllows(feature, options.side)) continue;
        const quad = mapBoardRectToImage(registration, feature.bounds);
        if (!quad) continue;
        const { cells } = cellsUnderQuad(quad.corners, grid);
        if (!cells.length) continue;
        let hot = 0, best = -Infinity, containsPeak = false;
        const peakIndex = region.peakCell.y * grid.width + region.peakCell.x;
        for (const index of cells) {
          if (result.labels[index] !== region.id) continue;
          hot++;
          const value = sign * grid.values[index];
          if (value > best) best = value;
          if (index === peakIndex) containsPeak = true;
        }
        if (!hot) continue;
        const overlap = hot / cells.length;
        if (overlap < minOverlap) continue;
        const peakRelative = span > 0 ? Math.min(1, Math.max(0, (best - baselineSigned) / span)) : 1;
        const hit: FeatureHit = { feature, cellsUnder: cells.length, hotCells: hot, overlap, coverage: hot / region.cellCount, peak: sign * best, peakRelative, containsPeak, score: overlap * peakRelative };
        (feature.kind === 'pin' ? pins : parts).push(hit);
      }
    }
    parts.sort((a, b) => byScore(a, b, sign)); pins.sort((a, b) => byScore(a, b, sign));
    reports.push({ region, boardCentroid, boardPeak, boardBounds: footprint ? footprint.bounds : null, areaMm2, parts: parts.slice(0, maxHits), pins: pins.slice(0, maxHits) });
  }
  return reports;
}

/** The whole pipeline from a grid to the ranked reports: `findHotRegions` then `analyzeHotRegions`. */
export function analyzeThermal(grid: ThermalGrid, registration: Pick<Registration, 'boardToImage' | 'imageToBoard'>, query: FeatureQuery, options: HotRegionOptions & AnalyzeOptions = {}): { result: HotRegionResult; reports: RegionReport[] } {
  const result = findHotRegions(grid, options);
  return { result, reports: analyzeHotRegions(grid, result, registration, query, options) };
}

// ---------------------------------------------------------------------------------------------
// Nets
// ---------------------------------------------------------------------------------------------

export interface NetPartHit {
  readonly hit: FeatureHit;
  /** Which of the requested nets the part touches. */
  readonly matchedNets: readonly string[];
  /** Hot pins of this part that are on one of the nets: the strongest evidence. */
  readonly hotPins: readonly FeatureHit[];
}

export interface NetIntersection {
  /** The requested nets as compared (normalized). */
  readonly nets: readonly string[];
  /** Hot parts that have a pin on one of the nets: those with a hot pin on it first, then by score. */
  readonly parts: readonly NetPartHit[];
  /** Hot pins that are on one of the nets, ranked. */
  readonly pins: readonly FeatureHit[];
}

const defaultNormalize = (name: string) => name.trim().toUpperCase();

/**
 * Narrows a region's parts and pins to those on given nets: the rail that measures as a short, or the nets of a suspect. The hot part with a hot pin
 * on the shorted rail is the best candidate; a hot part that only has some other pin on it ranks below.
 */
export function intersectWithNets(report: Pick<RegionReport, 'parts' | 'pins'>, nets: Iterable<string>, options: { normalize?: (name: string) => string } = {}): NetIntersection {
  const normalize = options.normalize ?? defaultNormalize;
  const wanted = new Set<string>();
  for (const name of nets) if (typeof name === 'string' && normalize(name) !== '') wanted.add(normalize(name));
  const onNet = (name: string | undefined) => name !== undefined && wanted.has(normalize(name));
  const pins = report.pins.filter(hit => onNet(hit.feature.net));
  const parts: NetPartHit[] = [];
  for (const hit of report.parts) {
    const matchedNets = new Set<string>();
    for (const net of hit.feature.nets ?? []) if (onNet(net)) matchedNets.add(normalize(net));
    const hotPins = pins.filter(pin => pin.feature.ref === hit.feature.ref);
    for (const pin of hotPins) if (pin.feature.net !== undefined) matchedNets.add(normalize(pin.feature.net));
    if (matchedNets.size) parts.push({ hit, matchedNets: [...matchedNets].sort(), hotPins });
  }
  parts.sort((a, b) => (b.hotPins.length > 0 ? 1 : 0) - (a.hotPins.length > 0 ? 1 : 0) || b.hit.score - a.hit.score || (a.hit.feature.id < b.hit.feature.id ? -1 : 1));
  return { nets: [...wanted].sort(), parts, pins };
}

// ---------------------------------------------------------------------------------------------
// The loaded board as a FeatureQuery
// ---------------------------------------------------------------------------------------------

export interface FeatureIndexOptions {
  /** Only features on this side (parts and pins on both sides always stay). */
  side?: 'top' | 'bottom';
  /** Default true. */
  includePins?: boolean;
  /** Grid cell of the spatial index, millimetres (default 5). */
  cellMm?: number;
}

/** The parts and pins of a loaded board as features and a spatial index over them. */
export function buildFeatureIndex(board: Pick<Board, 'components' | 'pins'>, options: FeatureIndexOptions = {}): { features: readonly BoardFeature[]; query: FeatureQuery } {
  const index = new SpatialIndex<BoardFeature>(options.cellMm ?? 5);
  const features: BoardFeature[] = [];
  const refs = new Map<string, string>();
  const finite = (b: Bounds2) => Number.isFinite(b.minX) && Number.isFinite(b.minY) && Number.isFinite(b.maxX) && Number.isFinite(b.maxY) && b.maxX >= b.minX && b.maxY >= b.minY;
  const pinsOf = new Map<string, string[]>();
  for (const pin of board.pins) {
    const nets = pinsOf.get(pin.componentId);
    if (pin.net) { if (nets) nets.push(pin.net); else pinsOf.set(pin.componentId, [pin.net]); }
  }
  const keep = (side: BoardSide) => !options.side || side === 'both' || side === options.side;
  for (const component of board.components) {
    refs.set(component.id, component.ref);
    if (!keep(component.side) || !finite(component.bounds)) continue;
    const feature: BoardFeature = { id: `part:${component.id}`, kind: 'part', ref: component.ref, nets: [...new Set(pinsOf.get(component.id) ?? [])].sort(), side: component.side, bounds: component.bounds };
    features.push(feature); index.add(feature, feature.bounds);
  }
  if (options.includePins !== false) {
    for (const pin of board.pins) {
      const ref = refs.get(pin.componentId);
      if (ref === undefined || !keep(pin.side) || !Number.isFinite(pin.x) || !Number.isFinite(pin.y)) continue;
      const bounds = padBounds(pin);
      if (!finite(bounds)) continue;
      const feature: BoardFeature = { id: `pin:${pin.id}`, kind: 'pin', ref, ...(pin.numberGenerated ? {} : { pin: pin.number }), ...(pin.net ? { net: pin.net } : {}), side: pin.side, bounds };
      features.push(feature); index.add(feature, feature.bounds);
    }
  }
  return { features, query: bounds => index.query(bounds) };
}
