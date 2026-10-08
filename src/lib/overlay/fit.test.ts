import { expectCostAtMost, pairwiseReference } from '../../test-support/timing';
import { describe, expect, it } from 'vitest';
import type { Point2 } from '../geometry';
import { RegistrationError, type RegistrationErrorCode } from './errors';
import { MAX_POINTS, MIN_THIN_RATIO, MODEL_MIN_POINTS, MODEL_PARAMETERS, type FitModel, fitTransform, leverageBlocks, pointSetQuality } from './fit';
import { type Matrix3, isAffine, transform, weight } from './matrix3';
import { BOARD_100x60, PHOTO_4K, Rng, cameraMatrix, forAll, randomPoint, wellSpreadPoints } from './testkit';

const MODELS: FitModel[] = ['similarity', 'affine', 'homography'];

function expectError(run: () => unknown, code: RegistrationErrorCode): RegistrationError {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(RegistrationError);
    expect((error as RegistrationError).code).toBe(code);
    return error as RegistrationError;
  }
  throw new Error(`expected RegistrationError ${code}`);
}

/** A random ground-truth map of the given model class (the homographies are cameras, mirrored half of the time: a reflection is a valid map for the plain fit). */
function truth(rng: Rng, model: FitModel): Matrix3 {
  if (model === 'similarity') {
    const s = 10 ** rng.range(-1, 1.7), a = rng.range(-Math.PI, Math.PI);
    return [s * Math.cos(a), -s * Math.sin(a), rng.range(-4000, 4000), s * Math.sin(a), s * Math.cos(a), rng.range(-4000, 4000), 0, 0, 1];
  }
  if (model === 'affine') {
    const a = rng.range(-Math.PI, Math.PI), sx = rng.range(5, 40), sy = rng.range(5, 40), shear = rng.range(-0.3, 0.3);
    const c = Math.cos(a), s = Math.sin(a);
    return [sx * c, sx * (c * shear - s), rng.range(-3000, 3000), sx * s, sx * (s * shear + c), rng.range(-3000, 3000), 0, 0, 1].map((v, i) => (i === 4 || i === 5 || i === 8 ? v : v)) as unknown as Matrix3;
  }
  return cameraMatrix({ ...PHOTO_4K, distanceMm: rng.range(80, 300), tiltDeg: rng.range(-25, 25), panDeg: rng.range(-25, 25), rollDeg: rng.range(-180, 180), mirrored: rng.chance(0.5), lookAt: randomPoint(rng, { minX: -10, minY: -10, maxX: 10, maxY: 10 }) });
}

const map = (m: Matrix3, p: Point2) => transform(m, p)!;

describe('pointSetQuality', () => {
  it('measures spread, thinness and the worst triangle', () => {
    const triangle = pointSetQuality([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }]);
    expect(triangle.count).toBe(3);
    expect(triangle.centroid.x).toBeCloseTo(5, 12);
    expect(triangle.minTriangle!.quality).toBeCloseTo(0.5, 12);
    expect(triangle.minTriangle!.indices).toEqual([0, 1, 2]);
    expect(pointSetQuality([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]).thinRatio).toBe(0);
    expect(pointSetQuality([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]).minTriangle!.quality).toBe(0);
    const square = pointSetQuality([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
    expect(square.thinRatio).toBeCloseTo(1, 12);
    expect(square.spread).toBeCloseTo(Math.SQRT1_2, 12);
    expect(pointSetQuality(Array.from({ length: 13 }, (_, i) => ({ x: i, y: i * i }))).minTriangle).toBeNull();
    expect(pointSetQuality([]).thinRatio).toBe(0);
    expect(pointSetQuality([{ x: 4, y: 4 }]).spread).toBe(0);
  });
  it('reads the height of the third point over the baseline as the triangle quality', () => {
    const q = pointSetQuality([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 40, y: 3 }]).minTriangle!.quality;
    expect(q).toBeCloseTo(3 / 100, 12);
  });
});

describe('fitTransform recovers a known map', () => {
  for (const model of MODELS) {
    it(`${model}: exact from the minimum number of pairs and from many, in 4K coordinates, to 1e-8 relative`, () => {
      forAll(150, 31 + MODELS.indexOf(model), rng => {
        const m = truth(rng, model);
        const n = MODEL_MIN_POINTS[model] + rng.int(0, 6);
        const src = wellSpreadPoints(rng, n, BOARD_100x60);
        const dst = src.map(p => map(m, p));
        const fitted = fitTransform(src, dst, model);
        for (const p of wellSpreadPoints(rng, 30, BOARD_100x60)) {
          const a = map(fitted, p), b = map(m, p);
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-8 * (1 + Math.hypot(b.x, b.y)));
        }
        // Normalized: W = 1 at the centroid of the source points, an affine model has no perspective row.
        expect(weight(fitted, pointSetQuality(src).centroid)).toBeCloseTo(1, 10);
        if (model !== 'homography') { expect(isAffine(fitted)).toBe(true); expect(fitted[8]).toBe(1); }
      });
    });
  }

  it('is not thrown off by far-away origins or by mixed units (millimetres on one side, 4K pixels on the other)', () => {
    forAll(100, 35, rng => {
      const m = cameraMatrix({ ...PHOTO_4K, tiltDeg: 10, panDeg: -6, rollDeg: 33 });
      const offset = { x: rng.range(-1e5, 1e5), y: rng.range(-1e5, 1e5) };
      const src = wellSpreadPoints(rng, 7, BOARD_100x60).map(p => ({ x: p.x + offset.x, y: p.y + offset.y }));
      const shifted = (p: Point2) => map(m, { x: p.x - offset.x, y: p.y - offset.y });
      const dst = src.map(shifted);
      const fitted = fitTransform(src, dst, 'homography');
      for (const p of src) {
        const a = map(fitted, p), b = shifted(p);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-4);
      }
    });
  });

  it('keeps similarity and affine exact for the same pairs when the data is perfectly consistent with a simpler model', () => {
    const rng = new Rng(36);
    const m = truth(rng, 'similarity');
    const src = wellSpreadPoints(rng, 6, BOARD_100x60), dst = src.map(p => map(m, p));
    const similarity = fitTransform(src, dst, 'similarity'), affine = fitTransform(src, dst, 'affine'), homography = fitTransform(src, dst, 'homography');
    for (const p of wellSpreadPoints(rng, 20, BOARD_100x60)) {
      for (const f of [similarity, affine, homography]) {
        const a = map(f, p), b = map(m, p);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
      }
    }
  });
});

describe('accuracy with clicking noise', () => {
  const heldOutRms = (model: FitModel, n: number, noisePx: number, runs: number, seed: number) => {
    const rng = new Rng(seed);
    const rmsList: number[] = [];
    for (let run = 0; run < runs; run++) {
      const spec = { ...PHOTO_4K, distanceMm: 250, tiltDeg: rng.range(-8, 8), panDeg: rng.range(-8, 8), rollDeg: rng.range(-180, 180), mirrored: rng.chance(0.5) };
      const m = cameraMatrix(spec);
      const src = wellSpreadPoints(rng, n, BOARD_100x60);
      const dst = src.map(p => { const q = map(m, p); return { x: q.x + noisePx * rng.gaussian(), y: q.y + noisePx * rng.gaussian() }; });
      const fitted = fitTransform(src, dst, model);
      let sum = 0;
      const test = wellSpreadPoints(rng, 20, BOARD_100x60);
      for (const p of test) { const a = map(fitted, p), b = map(m, p); sum += (a.x - b.x) ** 2 + (a.y - b.y) ** 2; }
      rmsList.push(Math.sqrt(sum / test.length / 2));
    }
    return rmsList.sort((a, b) => a - b);
  };
  const median = (values: number[]) => values[Math.floor(values.length / 2)];
  const p95 = (values: number[]) => values[Math.floor(values.length * 0.95)];

  it('projective: the error at unseen board points is about the click noise, and shrinks with more pairs', () => {
    const noise = 1;
    const four = heldOutRms('homography', 4, noise, 300, 41), eight = heldOutRms('homography', 8, noise, 300, 42), twelve = heldOutRms('homography', 12, noise, 300, 43);
    // Per coordinate, in photo pixels (at 30 px/mm every px is 0.033 mm): about 1.0 sigma for 4 pairs, 0.7 for 8 and 0.6 for 12.
    expect(median(four)).toBeLessThan(1.4 * noise);
    expect(p95(four)).toBeLessThan(3.2 * noise);
    expect(median(eight)).toBeLessThan(0.9 * noise);
    expect(median(twelve)).toBeLessThan(0.75 * noise);
    expect(median(twelve)).toBeLessThan(median(eight));
    expect(median(eight)).toBeLessThan(median(four));
  });

  it('scales linearly with the noise', () => {
    const a = median(heldOutRms('homography', 6, 0.5, 200, 44)), b = median(heldOutRms('homography', 6, 2, 200, 44));
    expect(b / a).toBeGreaterThan(3.7);
    expect(b / a).toBeLessThan(4.3);
  });

  it('a model that is too simple for a tilted camera shows it as a large error, and the projective model removes it', () => {
    const similarity = median(heldOutRms('similarity', 8, 0.5, 100, 45)), affine = median(heldOutRms('affine', 8, 0.5, 100, 45)), homography = median(heldOutRms('homography', 8, 0.5, 100, 45));
    expect(similarity).toBeGreaterThan(5);
    expect(affine).toBeGreaterThan(2);
    expect(homography).toBeLessThan(1);
  });

  it('Levenberg-Marquardt never raises the reprojection error of the DLT solution and usually lowers it', () => {
    const rng = new Rng(46);
    let lowered = 0;
    const runs = 200;
    for (let run = 0; run < runs; run++) {
      const spec = { ...PHOTO_4K, distanceMm: 120, tiltDeg: rng.range(-20, 20), panDeg: rng.range(-20, 20), rollDeg: rng.range(-180, 180) };
      const m = cameraMatrix(spec);
      const src = wellSpreadPoints(rng, rng.int(5, 12), BOARD_100x60);
      const dst = src.map(p => { const q = map(m, p); return { x: q.x + 3 * rng.gaussian(), y: q.y + 3 * rng.gaussian() }; });
      const cost = (f: Matrix3) => src.reduce((s, p, i) => { const q = transform(f, p)!; return s + (q.x - dst[i].x) ** 2 + (q.y - dst[i].y) ** 2; }, 0);
      const dlt = cost(fitTransform(src, dst, 'homography', { refine: false })), refined = cost(fitTransform(src, dst, 'homography'));
      expect(refined).toBeLessThanOrEqual(dlt * (1 + 1e-9));
      if (refined < dlt * (1 - 1e-6)) lowered++;
    }
    expect(lowered).toBeGreaterThan(runs * 0.5);
  });
});

describe('fitTransform rejects what cannot be fitted', () => {
  const sq = (): Point2[] => [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }];
  const shift = (points: Point2[]) => points.map(p => ({ x: p.x * 3 + 100, y: p.y * 3 + 50 }));

  it('counts the pairs, naming what the model needs', () => {
    for (const model of MODELS) {
      const needed = MODEL_MIN_POINTS[model];
      const e = expectError(() => fitTransform(sq().slice(0, needed - 1), shift(sq()).slice(0, needed - 1), model), 'TOO_FEW_POINTS');
      expect(e.detail).toMatchObject({ needed, given: needed - 1, model });
      expect(e.message).toContain(String(needed));
    }
    expectError(() => fitTransform([], [], 'similarity'), 'TOO_FEW_POINTS');
    expect(() => fitTransform(sq(), shift(sq()).slice(0, 3), 'affine')).toThrow(RangeError);
  });

  it('rejects coordinates that are not finite numbers, naming the point and the side', () => {
    const board = sq(), image = shift(sq());
    for (const bad of [NaN, Infinity, -Infinity, undefined as unknown as number, '3' as unknown as number]) {
      const a = expectError(() => fitTransform(board.map((p, i) => (i === 2 ? { x: bad, y: p.y } : p)), image, 'homography'), 'INVALID_POINT');
      expect(a.detail).toMatchObject({ indices: [2], side: 'board' });
      const b = expectError(() => fitTransform(board, image.map((p, i) => (i === 1 ? { x: p.x, y: bad } : p)), 'affine'), 'INVALID_POINT');
      expect(b.detail).toMatchObject({ indices: [1], side: 'image' });
    }
    expectError(() => fitTransform([board[0], undefined as unknown as Point2], image.slice(0, 2), 'similarity'), 'INVALID_POINT');
  });

  it('rejects a point entered twice, on either side', () => {
    const board = sq(), image = shift(sq());
    const doubleBoard = [board[0], board[1], board[2], { ...board[1] }];
    expect(expectError(() => fitTransform(doubleBoard, image, 'homography'), 'DUPLICATE_POINTS').detail).toMatchObject({ indices: [1, 3], side: 'board' });
    const doubleImage = [image[0], image[1], { ...image[0] }, image[3]];
    expect(expectError(() => fitTransform(board, doubleImage, 'homography'), 'DUPLICATE_POINTS').detail).toMatchObject({ indices: [0, 2], side: 'image' });
    expectError(() => fitTransform([board[0], board[0]], [image[0], image[1]], 'similarity'), 'DUPLICATE_POINTS');
    expectError(() => fitTransform([board[0], board[1]], [image[2], image[2]], 'similarity'), 'DUPLICATE_POINTS');
    // 1e-12 of the span is the same click.
    expectError(() => fitTransform([board[0], { x: board[0].x + 1e-12, y: board[0].y }, board[2]], image.slice(0, 3), 'affine'), 'DUPLICATE_POINTS');
  });

  it('rejects points on one line for the affine and projective models, on the board or on the photo', () => {
    const line = [0, 1, 2, 3].map(i => ({ x: i * 7, y: i * 7 * 0.5 + 2 }));
    expect(expectError(() => fitTransform(line.slice(0, 3), shift(sq()).slice(0, 3), 'affine'), 'COLLINEAR').detail).toMatchObject({ side: 'board' });
    expect(expectError(() => fitTransform(sq().slice(0, 3), line.slice(0, 3), 'affine'), 'COLLINEAR').detail).toMatchObject({ side: 'image' });
    expect(expectError(() => fitTransform(line, shift(sq()), 'homography'), 'COLLINEAR').detail).toMatchObject({ side: 'board' });
    expect(expectError(() => fitTransform(sq(), line, 'homography'), 'COLLINEAR').detail).toMatchObject({ side: 'image' });
    const e = expectError(() => fitTransform(line.slice(0, 3), shift(sq()).slice(0, 3), 'affine'), 'COLLINEAR');
    expect(e.message).toMatch(/one line/);
    expect(e.message).toMatch(/board/);
  });

  it('treats a third point barely off the line as collinear, and a clearly off one as fine (thresholds: 2 % error)', () => {
    const base = (h: number): Point2[] => [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: h }];
    const image = [{ x: 10, y: 10 }, { x: 600, y: 40 }, { x: 330, y: 400 }];
    expect(MIN_THIN_RATIO).toBe(0.02);
    expectError(() => fitTransform(base(0), image, 'affine'), 'COLLINEAR');
    expectError(() => fitTransform(base(0.5), image, 'affine'), 'COLLINEAR');
    expect(() => fitTransform(base(10), image, 'affine')).not.toThrow();
    expect(() => fitTransform(base(30), image, 'affine')).not.toThrow();
    // The threshold can be changed.
    expect(() => fitTransform(base(0.5), image, 'affine', { minThinRatio: 1e-6 })).not.toThrow();
  });

  it('finds the three of four points that are in a line for a projective fit, and says which', () => {
    const board = [{ x: 0, y: 0 }, { x: 50, y: 0.2 }, { x: 100, y: 0 }, { x: 40, y: 60 }];
    const image = [{ x: 100, y: 100 }, { x: 700, y: 120 }, { x: 1200, y: 90 }, { x: 500, y: 900 }];
    const e = expectError(() => fitTransform(board, image, 'homography'), 'COLLINEAR');
    expect(e.detail.indices).toEqual([0, 1, 2]);
    expect(e.message).toMatch(/1, 2, 3/);
    // The same points are fine for an affine fit (3 pairs make no such demand on a fourth).
    expect(() => fitTransform(board.slice(0, 4), image, 'affine')).not.toThrow();
  });

  it('rejects a projective fit whose pairs leave the system rank-deficient (four in a line and one off it)', () => {
    const board = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }, { x: 15, y: 18 }];
    const image = board.map(p => ({ x: 200 + p.x * 12 + p.y * 3, y: 300 + p.y * 11 }));
    expectError(() => fitTransform(board, image, 'homography'), 'DEGENERATE');
    // A similarity is determined by two of them.
    expect(() => fitTransform(board, image, 'similarity')).not.toThrow();
  });

  it('takes collinear points for a similarity (two points fix it)', () => {
    const line = [0, 1, 2, 3].map(i => ({ x: i * 5, y: 0 }));
    const m = fitTransform(line, line.map(p => ({ x: 2 * p.y + 100, y: 2 * p.x + 7 })), 'similarity');
    expect(map(m, { x: 2.5, y: 0 }).x).toBeCloseTo(100, 8);
  });

  it('limits the number of pairs and says so', () => {
    const rng = new Rng(51);
    const many = Array.from({ length: MAX_POINTS + 1 }, () => randomPoint(rng, BOARD_100x60));
    expectError(() => fitTransform(many, many, 'affine'), 'TOO_MANY_POINTS');
  });

  it('names the side in the message of an image-to-image fit', () => {
    const e = expectError(() => fitTransform(sq().slice(0, 3), [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], 'affine', { sides: { src: 'image', dst: 'image' } }), 'COLLINEAR');
    expect(e.message).toMatch(/photo/);
  });
});

describe('leverage', () => {
  for (const model of MODELS) {
    it(`${model}: the leverages sum to the number of fitted numbers and each block is a projection`, () => {
      forAll(80, 61 + MODELS.indexOf(model), rng => {
        const m = truth(rng, model);
        const n = MODEL_MIN_POINTS[model] + rng.int(0, 8);
        const src = wellSpreadPoints(rng, n, BOARD_100x60);
        const dst = src.map(p => { const q = map(m, p); return { x: q.x + rng.gaussian(), y: q.y + rng.gaussian() }; });
        const fitted = fitTransform(src, dst, model);
        const blocks = leverageBlocks(model, src, dst, fitted)!;
        expect(blocks.length).toBe(n);
        const trace = blocks.reduce((s, b) => s + b.a + b.d, 0);
        expect(trace).toBeCloseTo(MODEL_PARAMETERS[model], 5);
        for (const b of blocks) {
          expect(b.a).toBeGreaterThan(-1e-9); expect(b.d).toBeGreaterThan(-1e-9);
          expect(b.a).toBeLessThan(1 + 1e-9); expect(b.d).toBeLessThan(1 + 1e-9);
          expect(b.a * b.d - b.b * b.b).toBeGreaterThan(-1e-9);
        }
        if (n === MODEL_MIN_POINTS[model]) for (const b of blocks) { expect(b.a + b.d).toBeGreaterThan(MODEL_PARAMETERS[model] / n - 1e-6); }
      });
    });
  }
  it('an exactly determined fit has leverage 1 everywhere', () => {
    const src = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }], dst = src.map(p => ({ x: p.x * 20 + 5, y: p.y * 19 + p.x + 3 }));
    const blocks = leverageBlocks('homography', src, dst, fitTransform(src, dst, 'homography'))!;
    for (const b of blocks) { expect(b.a).toBeCloseTo(1, 8); expect(b.d).toBeCloseTo(1, 8); expect(b.b).toBeCloseTo(0, 8); }
  });
});

describe('fit cost', () => {
  it('fits 1000 pairs (the limit) with bounded work', () => {
    const rng = new Rng(71);
    const m = cameraMatrix({ ...PHOTO_4K, tiltDeg: 12 });
    const src = wellSpreadPoints(rng, MAX_POINTS, BOARD_100x60);
    const dst = src.map(p => { const q = map(m, p); return { x: q.x + rng.gaussian(), y: q.y + rng.gaussian() }; });
    // Duplicate detection intentionally compares every pair below MAX_POINTS.
    expectCostAtMost('homography fit at its point limit', () => fitTransform(src, dst, 'homography'), pairwiseReference(src), 10);
  });
});
