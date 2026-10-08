import type { Bounds2, Point2 } from '../geometry';
import { ThermalError } from './errors';
import { type Matrix3, W_MIN, transform } from './matrix3';
import { type MappedQuad, type Registration, mapImageRectToBoard } from './registration';

/**
 * Thermal (and any other single-channel) images as a grid of numbers, and what can be done with the grid before it is looked at as hot regions
 * (hotspots.ts): reading a radiometric CSV export or decoded pixels, robust statistics, differences, sampling, and the mapping of the cells to board
 * coordinates through a Registration.
 *
 * Coordinates: cell (column i, row j) covers the square [i, i + 1] x [j, j + 1] of the image and its centre is (i + 0.5, j + 0.5). These are the
 * image pixel coordinates a Registration is made in, so a grid at the native resolution of the file the technician clicked on is registered directly;
 * a grid with fewer pixels than the visible picture it belongs to is registered through `deriveRegistration(base, resizeMatrix(visible, grid))`.
 */
export type ThermalUnit = 'celsius' | 'fahrenheit' | 'kelvin' | 'intensity' | 'unknown';

export interface ThermalGrid {
  readonly width: number;
  readonly height: number;
  /** Row-major, `width * height` numbers; NaN marks a cell without a reading. */
  readonly values: Float32Array | Float64Array;
  readonly unit: ThermalUnit;
}

/** The largest grid accepted (4096 x 4096; thermal cameras go up to about 1280 x 1024). */
export const MAX_GRID_CELLS = 4096 * 4096;
/** The longest CSV text accepted, characters. */
export const MAX_CSV_CHARS = 128 * 1024 * 1024;

export interface Size { readonly width: number; readonly height: number }

function checkSize(width: number, height: number, maxCells: number = MAX_GRID_CELLS): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new ThermalError('INVALID_GRID', `The grid size ${width} x ${height} is not a positive whole number of cells.`);
  if (width * height > maxCells) throw new ThermalError('TOO_LARGE', `A grid of ${width} x ${height} cells is larger than the ${maxCells} cells accepted.`);
}

/** A grid from numbers already in memory. `values` is used as it is (not copied) and must hold exactly `width * height` numbers. */
export function makeGrid(width: number, height: number, values: Float32Array | Float64Array, unit: ThermalUnit = 'unknown'): ThermalGrid {
  checkSize(width, height);
  if (!(values instanceof Float32Array) && !(values instanceof Float64Array)) throw new ThermalError('INVALID_GRID', 'The grid values must be a Float32Array or Float64Array.');
  if (values.length !== width * height) throw new ThermalError('INVALID_GRID', `A ${width} x ${height} grid needs ${width * height} values, ${values.length} given.`);
  return { width, height, values, unit };
}

export function validateGrid(grid: ThermalGrid): void {
  if (!grid || typeof grid !== 'object') throw new ThermalError('INVALID_GRID', 'No grid was given.');
  checkSize(grid.width, grid.height);
  if (!grid.values || grid.values.length !== grid.width * grid.height) throw new ThermalError('INVALID_GRID', `A ${grid.width} x ${grid.height} grid needs ${grid.width * grid.height} values.`);
}

// ---------------------------------------------------------------------------------------------
// Reading numbers: decoded pixels and CSV
// ---------------------------------------------------------------------------------------------

export type PixelChannel = 'luma' | 'red' | 'green' | 'blue' | 'max';
/** One colour of a colour scale and the number it stands for: a pixel gets the value of the nearest stop (squared RGB distance). */
export interface PaletteStop { readonly r: number; readonly g: number; readonly b: number; readonly value: number }

export interface PixelOptions {
  /** Which number a pixel is (default 'luma', Rec. 709 weights: the grey level of a white-hot or black-hot picture). */
  channel?: PixelChannel;
  /** Black-hot pictures: hot is dark, so the value is 255 minus the level (default false; ignored with a palette). */
  invert?: boolean;
  /** Reads the colours of a scale (iron, rainbow, ...) back into the numbers they stand for; wins over `channel`. */
  palette?: readonly PaletteStop[];
  /** Pixels whose alpha is below this (default 1) are cells without a reading. */
  minAlpha?: number;
  unit?: ThermalUnit;
}

/**
 * The grid of a decoded RGBA image (`data` as `ImageData.data`: 4 bytes a pixel, row-major). Without a palette the values are grey levels 0..255
 * (unit 'intensity'): all that can be known from a picture some other tool already coloured. A palette turns the colours back into the temperatures
 * of the scale next to the picture, which the technician types in or reads off its legend.
 */
export function gridFromRgba(data: ArrayLike<number>, width: number, height: number, options: PixelOptions = {}): ThermalGrid {
  checkSize(width, height);
  const count = width * height;
  if (data.length < count * 4) throw new ThermalError('INVALID_GRID', `A ${width} x ${height} image has ${count * 4} bytes of pixels, ${data.length} given.`);
  const values = new Float32Array(count);
  const channel = options.channel ?? 'luma', minAlpha = options.minAlpha ?? 1;
  const palette = options.palette && options.palette.length ? options.palette : null;
  let lookup: Int32Array | null = null;
  if (palette) {
    for (const stop of palette) if (![stop.r, stop.g, stop.b, stop.value].every(Number.isFinite)) throw new ThermalError('INVALID_GRID', 'A palette stop has a number that is not finite.');
    lookup = new Int32Array(1 << 18).fill(-1);
  }
  for (let i = 0; i < count; i++) {
    const r = data[4 * i], g = data[4 * i + 1], b = data[4 * i + 2];
    if (data[4 * i + 3] < minAlpha) { values[i] = NaN; continue; }
    if (palette && lookup) {
      const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      let stop = lookup[key];
      if (stop < 0) {
        // The centre of the quantization cell, so every pixel of the cell gets the same answer whichever came first.
        const cr = (r & 0xFC) + 2, cg = (g & 0xFC) + 2, cb = (b & 0xFC) + 2;
        let best = Infinity;
        for (let k = 0; k < palette.length; k++) {
          const dr = palette[k].r - cr, dg = palette[k].g - cg, db = palette[k].b - cb;
          const d = dr * dr + dg * dg + db * db;
          if (d < best) { best = d; stop = k; }
        }
        lookup[key] = stop;
      }
      values[i] = palette[stop].value;
      continue;
    }
    let level = channel === 'luma' ? 0.2126 * r + 0.7152 * g + 0.0722 * b : channel === 'red' ? r : channel === 'green' ? g : channel === 'blue' ? b : Math.max(r, g, b);
    if (options.invert) level = 255 - level;
    values[i] = level;
  }
  return { width, height, values, unit: palette ? options.unit ?? 'unknown' : options.unit ?? 'intensity' };
}

export interface CsvOptions {
  /** Cells accepted (default MAX_GRID_CELLS). */
  maxCells?: number;
  /** Decimal separator; default 'auto' (a comma is the decimal mark when the delimiter is a semicolon, a tab or white space). */
  decimal?: '.' | ',' | 'auto';
  /** The unit when the file does not say (default 'unknown'). */
  unit?: ThermalUnit;
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const NUMERIC_LINE = /^[\s\d.,;+\-eEnNaA/]*$/;
const EMPTY_CELL = /^(?:nan|n\/a|na|-+)?$/i;

/** True for a line that can only be cells of numbers (digits, signs, separators, exponents, NaN); text lines and header lines are not. */
const looksNumeric = (line: string): boolean => NUMERIC_LINE.test(line) && /\d|nan/i.test(line);

function detectUnit(header: readonly string[]): ThermalUnit | null {
  const text = header.join('\n').toLowerCase();
  if (/fahrenheit|°\s*f\b|\bdeg\s*f\b/.test(text)) return 'fahrenheit';
  if (/celsius|°\s*c\b|\bdeg\s*c\b|\[c\]|\(c\)/.test(text)) return 'celsius';
  if (/kelvin|\[k\]|\(k\)/.test(text)) return 'kelvin';
  return null;
}

interface RowPlan { delimiter: '\t' | ';' | ',' | ' '; decimal: '.' | ',' }

/** The ways the lines can be split into cells, most likely first: the delimiter follows from the characters used, the decimal mark from the delimiter. */
function plansFor(lines: readonly string[], decimalOption: 'auto' | '.' | ','): RowPlan[] {
  const sample = lines.filter(looksNumeric).slice(0, 200);
  const has = (ch: string) => sample.some(line => line.includes(ch));
  const commaInNumber = sample.some(line => /\d,\d/.test(line));
  const decimal = (delimiter: RowPlan['delimiter']): '.' | ',' => (decimalOption !== 'auto' ? decimalOption : delimiter !== ',' && commaInNumber ? ',' : '.');
  if (has('\t')) return [{ delimiter: '\t', decimal: decimal('\t') }];
  if (has(';')) return [{ delimiter: ';', decimal: decimal(';') }];
  if (has(',')) return decimalOption === ',' ? [{ delimiter: ' ', decimal: ',' }] : [{ delimiter: ',', decimal: '.' }, { delimiter: ' ', decimal: ',' }];
  return [{ delimiter: ' ', decimal: decimal(' ') }];
}

function parseRow(line: string, plan: RowPlan): Float64Array | null {
  const parts = plan.delimiter === ' ' ? line.trim().split(/\s+/) : line.split(plan.delimiter).map(token => token.trim());
  // A delimiter at the end of the line does not start a cell.
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  const row = new Float64Array(parts.length);
  let filled = 0;
  for (let i = 0; i < parts.length; i++) {
    const token = plan.decimal === ',' && plan.delimiter !== ',' ? parts[i].replace(',', '.') : parts[i];
    if (NUMBER.test(token)) { row[i] = Number(token); filled++; }
    else if (EMPTY_CELL.test(token)) { row[i] = NaN; if (token !== '') filled++; }
    else return null;
  }
  return filled > 0 ? row : null;
}

interface NumberBlock { rows: { line: number; values: Float64Array }[]; cells: number }

/** The maximal runs of consecutive numeric lines, and the header lines (text) before the first of them. A blank or a text line ends a run. */
function readBlocks(lines: readonly string[], plan: RowPlan): { blocks: NumberBlock[]; header: string[] } {
  const blocks: NumberBlock[] = [], header: string[] = [];
  let current: NumberBlock | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const values = line.trim() !== '' && looksNumeric(line) ? parseRow(line, plan) : null;
    if (values) {
      if (!current) { current = { rows: [], cells: 0 }; blocks.push(current); }
      current.rows.push({ line: i + 1, values }); current.cells += values.length;
    } else {
      current = null;
      if (!blocks.length && line.trim() !== '') header.push(line);
    }
  }
  return { blocks, header };
}

/**
 * A grid from the text of a radiometric export (FLIR Tools, Seek, InfiRay, plain numbers from a script): one image row per line, cells separated by
 * a comma, a semicolon, a tab or white space; a comma is a decimal mark when the cells are separated by something else. The grid is the longest
 * run of lines that are only numbers: a title, the emissivity, a unit, a stray number or a footer around it are skipped, and a unit written in a
 * line before it is recognized. Empty cells and NaN are cells without a reading. Rows of another length than most that come before the first
 * full row are skipped as header; any other row of another length is an error that names the line.
 */
export function parseThermalCsv(text: string, options: CsvOptions = {}): ThermalGrid {
  if (typeof text !== 'string') throw new ThermalError('NO_NUMBERS', 'The file has no text.');
  if (text.length > MAX_CSV_CHARS) throw new ThermalError('TOO_LARGE', `The file is ${text.length} characters long; at most ${MAX_CSV_CHARS} are accepted.`);
  const maxCells = options.maxCells ?? MAX_GRID_CELLS;
  const lines = (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text).split(/\r\n|\n|\r/);
  let found: { blocks: NumberBlock[]; header: string[] } = { blocks: [], header: [] };
  for (const plan of plansFor(lines, options.decimal ?? 'auto')) {
    found = readBlocks(lines, plan);
    if (found.blocks.length) break;
  }
  if (!found.blocks.length) throw new ThermalError('NO_NUMBERS', 'The text holds no row of numbers.');
  const block = found.blocks.reduce((best, candidate) => (candidate.cells > best.cells ? candidate : best));
  const widths = new Map<number, number>();
  for (const row of block.rows) widths.set(row.values.length, (widths.get(row.values.length) ?? 0) + 1);
  let width = block.rows[0].values.length, best = 0;
  for (const [candidate, count] of widths) if (count > best || (count === best && candidate > width)) { width = candidate; best = count; }
  const grid = block.rows.slice(block.rows.findIndex(row => row.values.length === width));
  for (const row of grid) {
    if (row.values.length !== width) throw new ThermalError('RAGGED', `Line ${row.line} has ${row.values.length} numbers, the rows before it ${width}.`, row.line);
  }
  checkSize(width, grid.length, maxCells);
  const values = new Float32Array(width * grid.length);
  for (let j = 0; j < grid.length; j++) values.set(grid[j].values, j * width);
  return { width, height: grid.length, values, unit: options.unit ?? detectUnit(found.header) ?? 'unknown' };
}

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

/** Moves the k-th smallest of `a` (zero-based) to index k, smaller or equal ones before it, and returns it. Works in place; no NaN in `a`. */
function selectKth(a: Float32Array | Float64Array, k: number): number {
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
  }
  return a[k];
}

function medianOf(copy: Float32Array | Float64Array): number {
  const n = copy.length, k = n >> 1;
  const upper = selectKth(copy, k);
  if (n % 2) return upper;
  let lower = -Infinity;
  for (let i = 0; i < k; i++) if (copy[i] > lower) lower = copy[i];
  return (lower + upper) / 2;
}

export interface GridStats {
  /** Cells with a reading. */
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly median: number;
  readonly mean: number;
  /** Median absolute deviation from the median, scaled by 1.4826 to equal the standard deviation of normal noise. */
  readonly robustSigma: number;
}

/** Statistics of the numbers that are finite (NaN and infinities are cells without a reading); null when there is none. Median and MAD are exact (selection, not a histogram). */
export function statsOfValues(values: ArrayLike<number>): GridStats | null {
  const finite = new Float32Array(values.length);
  let count = 0, min = Infinity, max = -Infinity, sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    finite[count++] = v; sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!count) return null;
  const used = finite.subarray(0, count);
  const median = medianOf(used);
  // The selection reordered `used`; the deviations do not depend on the order.
  for (let i = 0; i < count; i++) used[i] = Math.abs(used[i] - median);
  return { count, min, max, median, mean: sum / count, robustSigma: 1.4826 * medianOf(used) };
}

export function gridStats(grid: ThermalGrid): GridStats | null {
  validateGrid(grid);
  return statsOfValues(grid.values);
}

/** after - before, cell by cell (the picture of what a fault heated while the board was powered). Cells without a reading in either stay without. */
export function differenceGrid(after: ThermalGrid, before: ThermalGrid): ThermalGrid {
  validateGrid(after); validateGrid(before);
  if (after.width !== before.width || after.height !== before.height) throw new ThermalError('INVALID_GRID', `The pictures differ in size: ${after.width} x ${after.height} and ${before.width} x ${before.height}.`);
  const values = new Float32Array(after.values.length);
  for (let i = 0; i < values.length; i++) values[i] = after.values[i] - before.values[i];
  return { width: after.width, height: after.height, values, unit: after.unit === before.unit ? after.unit : 'unknown' };
}

// ---------------------------------------------------------------------------------------------
// Sampling and the mapping to the board
// ---------------------------------------------------------------------------------------------

/**
 * Bilinear value of the grid at an image point (cell centres are the sample points; the outermost half cell repeats the edge value). NaN outside the
 * grid or when one of the four cells has no reading.
 */
export function sampleGrid(grid: ThermalGrid, x: number, y: number): number {
  const { width, height, values } = grid;
  if (!(x >= 0 && x <= width && y >= 0 && y <= height)) return NaN;
  const fx = Math.min(Math.max(x - 0.5, 0), width - 1), fy = Math.min(Math.max(y - 0.5, 0), height - 1);
  const x0 = Math.min(Math.floor(fx), width - 1), y0 = Math.min(Math.floor(fy), height - 1);
  const x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
  const tx = fx - x0, ty = fy - y0;
  // A neighbour with weight zero does not matter, even when it has no reading.
  const mix = (a: number, b: number, t: number) => (t === 0 ? a : t === 1 ? b : a * (1 - t) + b * t);
  const top = mix(values[y0 * width + x0], values[y0 * width + x1], tx);
  return ty === 0 ? top : mix(top, mix(values[y1 * width + x0], values[y1 * width + x1], tx), ty);
}

/** The value of the grid under a board point, or NaN where the point is off the picture. */
export function sampleGridAtBoard(grid: ThermalGrid, registration: Pick<Registration, 'boardToImage'>, boardPoint: Point2): number {
  const at = transform(registration.boardToImage, boardPoint);
  return at ? sampleGrid(grid, at.x, at.y) : NaN;
}

/**
 * Board coordinates of the centres of all cells, interleaved (x, y) row by row; cells that have no board position (behind the horizon of a perspective
 * map) are (NaN, NaN). `out` is reused when it is long enough. Returns the points and how many have none.
 */
export function gridCellCentersToBoard(size: Size, registration: Pick<Registration, 'imageToBoard'>, out?: Float64Array | Float32Array): { points: Float64Array | Float32Array; missing: number } {
  checkSize(size.width, size.height);
  const m = registration.imageToBoard, count = size.width * size.height;
  const points = out && out.length >= count * 2 ? out : new Float64Array(count * 2);
  let missing = 0, k = 0;
  const affine = m[6] === 0 && m[7] === 0 && m[8] > W_MIN;
  for (let j = 0; j < size.height; j++) {
    const y = j + 0.5;
    // The parts of the numerators and the denominator that depend on the row only.
    const bx = m[1] * y + m[2], by = m[4] * y + m[5], bw = m[7] * y + m[8];
    for (let i = 0; i < size.width; i++, k += 2) {
      const x = i + 0.5;
      const w = affine ? m[8] : m[6] * x + bw;
      const px = (m[0] * x + bx) / w, py = (m[3] * x + by) / w;
      if (w > W_MIN && Number.isFinite(px) && Number.isFinite(py)) { points[k] = px; points[k + 1] = py; } else { points[k] = NaN; points[k + 1] = NaN; missing++; }
    }
  }
  return { points, missing };
}

/** The board area a picture of this size covers: its four corners on the board (min/min, max/min, max/max, min/max of the picture) and their bounds. Null when a corner has no board position. */
export function gridFootprintOnBoard(size: Size, registration: Pick<Registration, 'imageToBoard'>): MappedQuad | null {
  return mapImageRectToBoard(registration, { minX: 0, minY: 0, maxX: size.width, maxY: size.height });
}

/** A scale from the pixels of one picture to those of another that shows the same view at another size (a thermal grid beside its visible picture): centres stay centres. */
export function resizeMatrix(from: Size, to: Size): Matrix3 {
  checkSize(from.width, from.height); checkSize(to.width, to.height);
  return [to.width / from.width, 0, 0, 0, to.height / from.height, 0, 0, 0, 1];
}

export interface BoardRaster {
  readonly width: number;
  readonly height: number;
  /** The board area the raster covers: cell (i, j) is centred at (minX + (i + 0.5) * cellMm, maxY - (j + 0.5) * cellMm) (rows from the top, Y up). */
  readonly bounds: Bounds2;
  readonly cellMm: number;
  readonly values: Float32Array;
  readonly unit: ThermalUnit;
}

/**
 * The picture resampled onto a regular board grid (bilinear), for a heat map drawn in board coordinates, for export, or to compare two pictures taken
 * from different places. Board cells the picture does not cover are NaN. Refuses rasters of more than `maxCells` cells (default 4 million).
 */
export function resampleToBoard(grid: ThermalGrid, registration: Pick<Registration, 'boardToImage'>, bounds: Bounds2, cellMm: number, maxCells = 4_000_000): BoardRaster {
  validateGrid(grid);
  if (!(cellMm > 0) || !Number.isFinite(cellMm)) throw new RangeError('The raster cell size must be positive.');
  const width = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellMm)), height = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cellMm));
  if (!Number.isFinite(width * height) || width * height > maxCells) throw new ThermalError('TOO_LARGE', `A raster of ${width} x ${height} cells is larger than the ${maxCells} cells allowed.`);
  const m = registration.boardToImage, values = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    const y = bounds.maxY - (j + 0.5) * cellMm;
    for (let i = 0; i < width; i++) {
      const x = bounds.minX + (i + 0.5) * cellMm;
      const w = m[6] * x + m[7] * y + m[8];
      if (!(w > W_MIN)) { values[j * width + i] = NaN; continue; }
      const u = (m[0] * x + m[1] * y + m[2]) / w, v = (m[3] * x + m[4] * y + m[5]) / w;
      values[j * width + i] = sampleGrid(grid, u, v);
    }
  }
  return { width, height, bounds: { minX: bounds.minX, minY: bounds.maxY - height * cellMm, maxX: bounds.minX + width * cellMm, maxY: bounds.maxY }, cellMm, values, unit: grid.unit };
}
