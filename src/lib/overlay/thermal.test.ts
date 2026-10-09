import { expectScaling } from '../../test-support/timing';
import { describe, expect, it } from 'vitest';
import { ThermalError, type ThermalErrorCode } from './errors';
import { type Matrix3, transform } from './matrix3';
import { registerBoardImage } from './registration';
import {
  type ThermalGrid, differenceGrid, gridCellCentersToBoard, gridFootprintOnBoard, gridFromRgba, gridStats, makeGrid, parseThermalCsv, resampleToBoard, resizeMatrix, sampleGrid,
  sampleGridAtBoard, statsOfValues,
} from './thermal';
import { BOARD_100x60, Rng, cameraMatrix, forAll, makePairs, wellSpreadPoints } from './testkit';

function expectThermalError(run: () => unknown, code: ThermalErrorCode): ThermalError {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(ThermalError);
    expect((error as ThermalError).code).toBe(code);
    return error as ThermalError;
  }
  throw new Error(`expected ThermalError ${code}`);
}

const rows = (grid: ThermalGrid): number[][] => Array.from({ length: grid.height }, (_, j) => Array.from(grid.values.subarray(j * grid.width, (j + 1) * grid.width)));

describe('parseThermalCsv', () => {
  it('reads comma separated rows', () => {
    const grid = parseThermalCsv('20.5,21,22\n23,24.25,25\n');
    expect(grid.width).toBe(3);
    expect(grid.height).toBe(2);
    expect(rows(grid)).toEqual([[20.5, 21, 22], [23, 24.25, 25]]);
    expect(grid.unit).toBe('unknown');
  });

  it('reads the semicolon and decimal comma of a Hungarian export, with a header that names the unit', () => {
    const text = 'Hőkép export\r\nEmisszivitás;0,95\r\nTemperature unit: °C\r\n\r\n36,5;37,25;38\r\n35;36,125;37,5\r\n';
    const grid = parseThermalCsv(text);
    expect(grid.unit).toBe('celsius');
    expect(rows(grid)).toEqual([[36.5, 37.25, 38], [35, 36.125, 37.5]]);
  });

  it('reads tabs and white space, a byte order mark, old Mac line ends and a trailing delimiter', () => {
    expect(rows(parseThermalCsv('﻿1\t2\t3\n4\t5\t6'))).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(rows(parseThermalCsv('  1   2   3 \n 4 5 6 \n'))).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(rows(parseThermalCsv('1,2,3,\r4,5,6,\r'))).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(rows(parseThermalCsv('1,5 2,5\n3,5 4,5', { decimal: ',' }))).toEqual([[1.5, 2.5], [3.5, 4.5]]);
  });

  it('reads signs, exponents and cells without a reading', () => {
    const grid = parseThermalCsv('-1.5e1,+2E0,.5\n1,,NaN\nnan,3,4');
    expect(rows(grid).map(r => r.map(v => (Number.isNaN(v) ? 'nan' : v)))).toEqual([[-15, 2, 0.5], [1, 'nan', 'nan'], ['nan', 3, 4]]);
    expect(gridStats(grid)!.count).toBe(6);
  });

  it('reads one column and one row', () => {
    expect(parseThermalCsv('1\n2\n3').width).toBe(1);
    expect(parseThermalCsv('1\n2\n3').height).toBe(3);
    expect(parseThermalCsv('7,8,9')).toMatchObject({ width: 3, height: 1 });
  });

  it('recognizes the other units', () => {
    expect(parseThermalCsv('Temperature (Fahrenheit)\n1,2').unit).toBe('fahrenheit');
    expect(parseThermalCsv('Unit: [K]\n300,301').unit).toBe('kelvin');
    expect(parseThermalCsv('Unit: [C]\n30,31').unit).toBe('celsius');
    expect(parseThermalCsv('1,2', { unit: 'celsius' }).unit).toBe('celsius');
    expect(parseThermalCsv('Celsius\n1,2', { unit: 'kelvin' }).unit).toBe('kelvin');
  });

  it('skips a stray number line before the grid and stops at text after it', () => {
    const grid = parseThermalCsv('Frame\n1\nImage:\n10,11,12\n13,14,15\n\nMax: 15\nAnother,9,9\n');
    expect(rows(grid)).toEqual([[10, 11, 12], [13, 14, 15]]);
  });

  it('refuses ragged rows and names the line', () => {
    const e = expectThermalError(() => parseThermalCsv('title\n1,2,3\n4,5,6\n7,8\n9,10,11'), 'RAGGED');
    expect(e.line).toBe(4);
    expect(e.message).toMatch(/Line 4/);
  });

  it('refuses text without numbers and too large grids', () => {
    expectThermalError(() => parseThermalCsv(''), 'NO_NUMBERS');
    expectThermalError(() => parseThermalCsv('just words\nand more words'), 'NO_NUMBERS');
    expectThermalError(() => parseThermalCsv('\n\n  \n'), 'NO_NUMBERS');
    expectThermalError(() => parseThermalCsv(undefined as unknown as string), 'NO_NUMBERS');
    expectThermalError(() => parseThermalCsv('1,2,3\n4,5,6\n7,8,9', { maxCells: 8 }), 'TOO_LARGE');
    expect(() => parseThermalCsv('1,2,3\n4,5,6\n7,8,9', { maxCells: 9 })).not.toThrow();
  });

  it('reads a 640 x 480 export (about 2 MB of text) in under a second and reproduces every value', () => {
    const rng = new Rng(301);
    const width = 640, height = 480;
    const values = new Float32Array(width * height).map(() => Math.round((20 + 30 * rng.next()) * 100) / 100);
    const lines: string[] = ['Thermal export', 'Unit: °C'];
    for (let j = 0; j < height; j++) lines.push(Array.from(values.subarray(j * width, (j + 1) * width)).join(','));
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(1_500_000);
    expectScaling('thermal CSV rows', [30, 120, 480], n => { const csv = lines.slice(0, n + 2).join('\n'); return () => parseThermalCsv(csv); });
    const grid = parseThermalCsv(text);
    expect(grid.width).toBe(width);
    expect(grid.height).toBe(height);
    expect(grid.unit).toBe('celsius');
    for (let i = 0; i < values.length; i += 997) expect(grid.values[i]).toBe(values[i]);
  });
});

describe('gridFromRgba', () => {
  const rgba = (pixels: number[][]) => Uint8ClampedArray.from(pixels.flat());

  it('turns grey levels and colour channels into numbers (white hot by default, black hot with invert)', () => {
    const data = rgba([[255, 255, 255, 255], [0, 0, 0, 255], [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [10, 200, 30, 255]]);
    const luma = gridFromRgba(data, 3, 2);
    expect(luma.unit).toBe('intensity');
    expect(luma.values[0]).toBeCloseTo(255, 3);
    expect(luma.values[1]).toBe(0);
    expect(luma.values[2]).toBeCloseTo(0.2126 * 255, 3);
    expect(luma.values[3]).toBeCloseTo(0.7152 * 255, 3);
    expect(gridFromRgba(data, 3, 2, { channel: 'red' }).values[2]).toBe(255);
    expect(gridFromRgba(data, 3, 2, { channel: 'green' }).values[5]).toBe(200);
    expect(gridFromRgba(data, 3, 2, { channel: 'blue' }).values[4]).toBe(255);
    expect(gridFromRgba(data, 3, 2, { channel: 'max' }).values[5]).toBe(200);
    expect(gridFromRgba(data, 3, 2, { invert: true }).values[0]).toBeCloseTo(0, 3);
    expect(gridFromRgba(data, 3, 2, { invert: true }).values[1]).toBe(255);
  });

  it('marks transparent pixels as cells without a reading', () => {
    const grid = gridFromRgba(rgba([[100, 100, 100, 255], [100, 100, 100, 0]]), 2, 1);
    expect(grid.values[0]).toBeGreaterThan(0);
    expect(Number.isNaN(grid.values[1])).toBe(true);
    expect(Number.isNaN(gridFromRgba(rgba([[1, 1, 1, 100]]), 1, 1, { minAlpha: 128 }).values[0])).toBe(true);
  });

  it('reads the colours of a scale back into the values it stands for', () => {
    const palette = [{ r: 0, g: 0, b: 128, value: 20 }, { r: 255, g: 255, b: 0, value: 50 }, { r: 255, g: 0, b: 0, value: 80 }];
    const grid = gridFromRgba(rgba([[2, 0, 120, 255], [250, 250, 4, 255], [255, 10, 10, 255], [128, 128, 128, 255]]), 4, 1, { palette, unit: 'celsius' });
    expect(Array.from(grid.values.subarray(0, 3))).toEqual([20, 50, 80]);
    expect([20, 50, 80]).toContain(grid.values[3]);
    expect(grid.unit).toBe('celsius');
    // The same colour twice gives the same value (the lookup is by the cell of the colour cube, not by the first pixel seen).
    const twice = gridFromRgba(rgba([[130, 129, 0, 255], [131, 128, 3, 255]]), 2, 1, { palette });
    expect(twice.values[0]).toBe(twice.values[1]);
  });

  it('checks its input', () => {
    expectThermalError(() => gridFromRgba(new Uint8Array(15), 2, 2), 'INVALID_GRID');
    expectThermalError(() => gridFromRgba(new Uint8Array(16), 0, 2), 'INVALID_GRID');
    expectThermalError(() => gridFromRgba(new Uint8Array(16), 1.5, 2), 'INVALID_GRID');
    expectThermalError(() => gridFromRgba(new Uint8Array(4), 1, 1, { palette: [{ r: NaN, g: 0, b: 0, value: 1 }] }), 'INVALID_GRID');
    expectThermalError(() => gridFromRgba(new Uint8Array(4), 5000, 5000), 'TOO_LARGE');
  });

  it('reads a 4K frame with bounded work', () => {
    const data = new Uint8ClampedArray(3840 * 2160 * 4).fill(200);
    expectScaling('RGBA pixels', [135, 540, 2160], height => { const rgba = data.slice(0, 3840 * height * 4); return () => gridFromRgba(rgba, 3840, height); });
    const grid = gridFromRgba(data, 3840, 2160);
    expect(grid.values[12345]).toBeCloseTo(200, 3);
  });
});

describe('makeGrid', () => {
  it('validates the shape', () => {
    expect(makeGrid(2, 2, new Float32Array(4), 'celsius').unit).toBe('celsius');
    expectThermalError(() => makeGrid(2, 2, new Float32Array(3)), 'INVALID_GRID');
    expectThermalError(() => makeGrid(0, 2, new Float32Array(0)), 'INVALID_GRID');
    expectThermalError(() => makeGrid(2, 2, [1, 2, 3, 4] as unknown as Float32Array), 'INVALID_GRID');
    expectThermalError(() => makeGrid(5000, 5000, new Float32Array(1)), 'TOO_LARGE');
  });
});

describe('gridStats', () => {
  const sortedMedian = (values: number[]) => { const v = [...values].sort((a, b) => a - b); return v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; };

  it('is exact for the median and the extremes, odd and even counts, with NaN skipped', () => {
    expect(statsOfValues([3, 1, 2])).toMatchObject({ count: 3, min: 1, max: 3, median: 2, mean: 2 });
    expect(statsOfValues([4, 1, 3, 2])).toMatchObject({ count: 4, median: 2.5 });
    expect(statsOfValues([NaN, 5, Infinity, -Infinity, 7])).toMatchObject({ count: 2, min: 5, max: 7, median: 6 });
    expect(statsOfValues([NaN, NaN])).toBeNull();
    expect(statsOfValues([])).toBeNull();
    expect(statsOfValues([9])).toMatchObject({ median: 9, robustSigma: 0 });
  });

  it('agrees with sorting on random data (property), and does not reorder the grid', () => {
    forAll(120, 311, rng => {
      const n = rng.int(1, 400);
      const values = Float32Array.from({ length: n }, () => (rng.chance(0.1) ? Math.round(rng.range(0, 5)) : rng.range(-50, 90)));
      const copy = Float32Array.from(values);
      const stats = statsOfValues(values)!;
      const reference = Array.from(copy);
      expect(stats.median).toBeCloseTo(sortedMedian(reference), 5);
      expect(stats.min).toBe(Math.min(...reference));
      expect(stats.max).toBe(Math.max(...reference));
      const m = sortedMedian(reference);
      expect(stats.robustSigma).toBeCloseTo(1.4826 * sortedMedian(reference.map(v => Math.abs(v - m))), 4);
      expect(values).toEqual(copy);
    });
  });

  it('estimates the standard deviation of the noise, not of the hot spot', () => {
    const rng = new Rng(312);
    const values = new Float32Array(100_000).map(() => 30 + 0.5 * rng.gaussian());
    for (let i = 0; i < 2000; i++) values[i] = 90;
    const stats = gridStats(makeGrid(400, 250, values))!;
    expect(stats.robustSigma).toBeGreaterThan(0.47);
    expect(stats.robustSigma).toBeLessThan(0.53);
    expect(stats.median).toBeCloseTo(30, 1);
    expect(stats.mean).toBeGreaterThan(31);
  });

  it('takes a 640 x 480 grid with bounded work', () => {
    const rng = new Rng(313);
    const grid = makeGrid(640, 480, new Float32Array(640 * 480).map(() => 20 + 10 * rng.next()));
    expectScaling('grid statistics cells', [19_200, 76_800, 307_200], n => { const g = makeGrid(640, n / 640, grid.values.slice(0, n)); return () => gridStats(g); });
  });
});

describe('differenceGrid', () => {
  it('subtracts cell by cell and refuses pictures of different sizes', () => {
    const before = makeGrid(2, 2, Float32Array.from([20, 21, 22, NaN]), 'celsius'), after = makeGrid(2, 2, Float32Array.from([25, 21, 20, 30]), 'celsius');
    const diff = differenceGrid(after, before);
    expect(Array.from(diff.values).map(v => (Number.isNaN(v) ? 'nan' : v))).toEqual([5, 0, -2, 'nan']);
    expect(diff.unit).toBe('celsius');
    expect(differenceGrid(after, makeGrid(2, 2, new Float32Array(4), 'kelvin')).unit).toBe('unknown');
    expectThermalError(() => differenceGrid(after, makeGrid(4, 1, new Float32Array(4))), 'INVALID_GRID');
  });
});

describe('sampleGrid', () => {
  const ramp = makeGrid(4, 3, Float32Array.from({ length: 12 }, (_, k) => (k % 4) * 10 + Math.floor(k / 4) * 100));

  it('returns the cell value at a cell centre and interpolates between centres', () => {
    expect(sampleGrid(ramp, 0.5, 0.5)).toBe(0);
    expect(sampleGrid(ramp, 3.5, 2.5)).toBe(230);
    expect(sampleGrid(ramp, 1.5, 1.5)).toBe(110);
    expect(sampleGrid(ramp, 2, 1.5)).toBeCloseTo(115, 9);
    expect(sampleGrid(ramp, 1.5, 2)).toBeCloseTo(160, 9);
    expect(sampleGrid(ramp, 2, 2)).toBeCloseTo(165, 9);
  });

  it('is linear in the ramp everywhere inside, and repeats the edge value in the outer half cell', () => {
    forAll(100, 321, rng => {
      const x = rng.range(0.5, 3.5), y = rng.range(0.5, 2.5);
      expect(sampleGrid(ramp, x, y)).toBeCloseTo((x - 0.5) * 10 + (y - 0.5) * 100, 5);
    });
    expect(sampleGrid(ramp, 0.1, 0.1)).toBe(0);
    expect(sampleGrid(ramp, 3.9, 2.9)).toBe(230);
    expect(sampleGrid(ramp, 4, 3)).toBe(230);
  });

  it('is NaN outside the picture and next to a cell without a reading, but not for a cell whose weight is zero', () => {
    expect(Number.isNaN(sampleGrid(ramp, -0.01, 1))).toBe(true);
    expect(Number.isNaN(sampleGrid(ramp, 4.01, 1))).toBe(true);
    expect(Number.isNaN(sampleGrid(ramp, NaN, 1))).toBe(true);
    const hole = makeGrid(2, 1, Float32Array.from([10, NaN]));
    expect(sampleGrid(hole, 0.5, 0.5)).toBe(10);
    expect(Number.isNaN(sampleGrid(hole, 1, 0.5))).toBe(true);
    expect(Number.isNaN(sampleGrid(hole, 1.5, 0.5))).toBe(true);
  });
});

/** A registration of a 320 x 240 thermal camera over a 100 x 60 mm board. */
function thermalRegistration(rng: Rng, tilt = 0, mirrored = false, width = 320, height = 240) {
  const spec = { focalPx: 400, width, height, distanceMm: 100, tiltDeg: tilt, panDeg: tilt / 2, rollDeg: rng.range(-30, 30), mirrored };
  const truth = cameraMatrix(spec);
  const registration = registerBoardImage(makePairs(rng, wellSpreadPoints(rng, 6, { minX: -35, minY: -25, maxX: 35, maxY: 25 }), p => transform(truth, p)!, 0.2), { mirrored });
  return { spec, truth, registration };
}

describe('mapping a grid to the board', () => {
  it('gives the board position of every cell centre, equal to mapping the points one by one', () => {
    const rng = new Rng(331);
    for (const tilt of [0, 20]) {
      const { registration } = thermalRegistration(rng, tilt);
      const size = { width: 64, height: 48 };
      const { points, missing } = gridCellCentersToBoard(size, registration);
      expect(missing).toBe(0);
      expect(points.length).toBe(64 * 48 * 2);
      for (let j = 0; j < 48; j += 7) for (let i = 0; i < 64; i += 5) {
        const expected = transform(registration.imageToBoard, { x: i + 0.5, y: j + 0.5 })!;
        const k = 2 * (j * 64 + i);
        expect(points[k]).toBeCloseTo(expected.x, 9);
        expect(points[k + 1]).toBeCloseTo(expected.y, 9);
      }
    }
  });

  it('puts the cells where the camera looks: a cell goes to the board point that projects into it', () => {
    const rng = new Rng(332);
    for (const mirrored of [false, true]) {
      const { registration, truth } = thermalRegistration(rng, 12, mirrored);
      const { points } = gridCellCentersToBoard({ width: 320, height: 240 }, registration);
      for (let k = 0; k < 40; k++) {
        const i = rng.int(0, 319), j = rng.int(0, 239);
        const p = { x: points[2 * (j * 320 + i)], y: points[2 * (j * 320 + i) + 1] };
        const back = transform(truth, p)!;
        // 0.2 px of clicking noise in the registration is about 0.05 mm; allow half a cell.
        expect(Math.hypot(back.x - (i + 0.5), back.y - (j + 0.5))).toBeLessThan(0.5);
      }
    }
  });

  it('marks cells that are behind the horizon of the map and reuses the buffer it is given', () => {
    const registration = { imageToBoard: [1, 0, 0, 0, 1, 0, 0.1, 0, -0.5] as Matrix3 };
    const out = new Float64Array(8 * 4 * 2);
    const { points, missing } = gridCellCentersToBoard({ width: 8, height: 4 }, registration, out);
    expect(points).toBe(out);
    // W = 0.1 x - 0.5 is positive from x = 5 on: columns 5, 6, 7 (centres 5.5 to 7.5).
    expect(missing).toBe(5 * 4);
    expect(Number.isNaN(points[0])).toBe(true);
    expect(Number.isNaN(points[2 * 5])).toBe(false);
    expect(() => gridCellCentersToBoard({ width: 0, height: 4 }, registration)).toThrow(ThermalError);
  });

  it('maps a 640 x 480 grid (307 200 cells) to the board with bounded work', () => {
    const rng = new Rng(333);
    const { registration } = thermalRegistration(rng, 15, false, 640, 480);
    const out = new Float64Array(640 * 480 * 2);
    expectScaling('mapped cells', [30, 120, 480], height => { const output = new Float64Array(640 * height * 2); return () => gridCellCentersToBoard({ width: 640, height }, registration, output); });
  });

  it('reports the board area a picture covers', () => {
    const rng = new Rng(334);
    const { registration, spec } = thermalRegistration(rng, 0);
    const footprint = gridFootprintOnBoard({ width: 320, height: 240 }, registration)!;
    // 4 px/mm: 80 x 60 mm, turned by the roll.
    const side = Math.hypot(footprint.corners[1].x - footprint.corners[0].x, footprint.corners[1].y - footprint.corners[0].y);
    expect(side).toBeGreaterThan(79);
    expect(side).toBeLessThan(81);
    expect(spec.width).toBe(320);
    expect(gridFootprintOnBoard({ width: 4, height: 4 }, { imageToBoard: [1, 0, 0, 0, 1, 0, 0.1, 0, -5] as Matrix3 })).toBeNull();
  });
});

describe('sampling at board points and resampling onto the board', () => {
  it('reads the picture where the board point is, whatever the side', () => {
    const rng = new Rng(341);
    for (const mirrored of [false, true]) {
      const { registration, truth } = thermalRegistration(rng, 8, mirrored);
      // A grid that is a linear function of the photo pixel: the value under a board point is that function of where the camera sees it.
      const grid = makeGrid(320, 240, Float32Array.from({ length: 320 * 240 }, (_, k) => 0.1 * ((k % 320) + 0.5) + 0.3 * (Math.floor(k / 320) + 0.5)));
      for (let k = 0; k < 30; k++) {
        const p = { x: rng.range(-25, 25), y: rng.range(-15, 15) };
        const at = transform(truth, p)!;
        if (at.x < 1 || at.x > 319 || at.y < 1 || at.y > 239) continue;
        expect(Math.abs(sampleGridAtBoard(grid, registration, p) - (0.1 * at.x + 0.3 * at.y))).toBeLessThan(0.2);
      }
      expect(Number.isNaN(sampleGridAtBoard(grid, registration, { x: 1e4, y: 1e4 }))).toBe(true);
    }
  });

  it('resamples onto a board raster: a ramp stays a ramp, uncovered cells are NaN', () => {
    const rng = new Rng(342);
    const { registration, truth } = thermalRegistration(rng, 0);
    const grid = makeGrid(320, 240, Float32Array.from({ length: 320 * 240 }, (_, k) => 0.1 * ((k % 320) + 0.5) + 0.3 * (Math.floor(k / 320) + 0.5)));
    const bounds = { minX: -45, minY: -30, maxX: 45, maxY: 30 };
    const raster = resampleToBoard(grid, registration, bounds, 0.5);
    expect(raster.width).toBe(180);
    expect(raster.height).toBe(120);
    expect(raster.values.length).toBe(180 * 120);
    expect(raster.unit).toBe(grid.unit);
    let covered = 0, nan = 0;
    for (let j = 0; j < raster.height; j += 3) for (let i = 0; i < raster.width; i += 3) {
      const v = raster.values[j * raster.width + i];
      const p = { x: raster.bounds.minX + (i + 0.5) * raster.cellMm, y: raster.bounds.maxY - (j + 0.5) * raster.cellMm };
      const at = transform(truth, p)!;
      if (at.x > 1 && at.x < 319 && at.y > 1 && at.y < 239) { covered++; expect(Math.abs(v - (0.1 * at.x + 0.3 * at.y))).toBeLessThan(0.25); }
      else if (at.x < -3 || at.x > 323 || at.y < -3 || at.y > 243) { nan++; expect(Number.isNaN(v)).toBe(true); }
    }
    expect(covered).toBeGreaterThan(200);
    expect(nan).toBeGreaterThan(50);
    expect(() => resampleToBoard(grid, registration, bounds, 0)).toThrow(RangeError);
    expectThermalError(() => resampleToBoard(grid, registration, bounds, 0.001), 'TOO_LARGE');
  });

  it('resamples a 640 x 480 grid onto a 0.1 mm raster of 100 x 60 mm (600 000 cells) with bounded work', () => {
    const rng = new Rng(343);
    const { registration } = thermalRegistration(rng, 10, false, 640, 480);
    const grid = makeGrid(640, 480, new Float32Array(640 * 480).map(() => 20 + rng.next()));
    expectScaling('resampled cells', [0.4, 0.2, 0.1].map(step => 1 / (step * step)), n => () => resampleToBoard(grid, registration, BOARD_100x60, 1 / Math.sqrt(n)));
  });
});

describe('resizeMatrix', () => {
  it('keeps cell centres on cell centres between pictures of different sizes', () => {
    const m = resizeMatrix({ width: 640, height: 480 }, { width: 32, height: 24 });
    expect(transform(m, { x: 10, y: 10 })).toEqual({ x: 0.5, y: 0.5 });
    expect(transform(m, { x: 640, y: 480 })).toEqual({ x: 32, y: 24 });
    expect(() => resizeMatrix({ width: 0, height: 1 }, { width: 1, height: 1 })).toThrow(ThermalError);
  });
});

