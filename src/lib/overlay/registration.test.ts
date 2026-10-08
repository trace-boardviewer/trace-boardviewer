import { expectCostAtMost, linearReference } from '../../test-support/timing';
import { describe, expect, it } from 'vitest';
import type { Point2 } from '../geometry';
import { RegistrationError, type RegistrationErrorCode } from './errors';
import { fitTransform, MODEL_MIN_POINTS, MODEL_PARAMETERS } from './fit';
import { type Matrix3, multiply, scaling, transform } from './matrix3';
import {
  type Correspondence, OUTLIER_MIN_DOF, type Registration, type RegistrationModel, deriveRegistration, linearizeAt, mapBoardPointsToImage, mapBoardRectToImage, mapBoardToImage,
  mapImagePointsToBoard, mapImageRectToBoard, mapImageToBoard, mirroredForSide, modelForCount, orientBoardPoint, rankPhotosForBoardPoint, registerBoardImage, registrationFromRecord,
  registrationToRecord, suggestOrientation,
} from './registration';
import { BOARD_100x60, PHOTO_4K, Rng, cameraMatrix, distortedProject, forAll, makePairs, randomPoint, wellSpreadPoints } from './testkit';

function expectError(run: () => unknown, code: RegistrationErrorCode): RegistrationError {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(RegistrationError);
    expect((error as RegistrationError).code).toBe(code);
    return error as RegistrationError;
  }
  throw new Error(`expected RegistrationError ${code}`);
}

const map = (m: Matrix3, p: Point2) => transform(m, p)!;
const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y);
const norm180 = (degrees: number) => { let d = degrees % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; };

type Kind = 'similarity' | 'affine' | 'homography';
/** A ground-truth board-to-photo matrix of the class the model can fit exactly, bottom side or top side. */
function truthFor(rng: Rng, kind: Kind, mirrored: boolean): Matrix3 {
  const tilt = kind === 'homography' ? 22 : 0;
  const camera = cameraMatrix({ ...PHOTO_4K, distanceMm: rng.range(120, 300), rollDeg: rng.range(-180, 180), tiltDeg: rng.range(-tilt, tilt), panDeg: rng.range(-tilt, tilt), mirrored, lookAt: randomPoint(rng, { minX: -8, minY: -8, maxX: 8, maxY: 8 }) });
  return kind === 'affine' ? multiply([1, rng.range(-0.2, 0.2), 0, 0, rng.range(0.8, 1.2), 0, 0, 0, 1], camera) : camera;
}

/** A noisy photo of the board: the camera matrix and the pairs a technician could pick. */
function photo(rng: Rng, n: number, noisePx: number, tweak: Partial<typeof PHOTO_4K> & { mirrored?: boolean; tiltDeg?: number; panDeg?: number; rollDeg?: number } = {}) {
  const spec = { ...PHOTO_4K, distanceMm: 250, tiltDeg: rng.range(-10, 10), panDeg: rng.range(-10, 10), rollDeg: rng.range(-180, 180), mirrored: rng.chance(0.5), ...tweak };
  const matrix = cameraMatrix(spec);
  const board = wellSpreadPoints(rng, n, BOARD_100x60);
  return { spec, matrix, pairs: makePairs(rng, board, p => distortedProject(matrix, spec, p), noisePx) };
}

describe('registerBoardImage recovers a known map', () => {
  it('picks the model from the number of pairs and reproduces the camera to 1e-5 px and 1e-6 mm, top and bottom side', () => {
    forAll(150, 101, rng => {
      const mirrored = rng.chance(0.5);
      const n = rng.int(2, 9);
      const model: Kind = modelForCount(n);
      const truth = truthFor(rng, model, mirrored);
      const board = wellSpreadPoints(rng, n, BOARD_100x60);
      const pairs: Correspondence[] = board.map(p => ({ board: p, image: map(truth, p) }));
      const registration = registerBoardImage(pairs, { mirrored });
      expect(registration.model).toBe(model);
      expect(registration.mirrored).toBe(mirrored);
      expect(registration.pointCount).toBe(n);
      expect(registration.degreesOfFreedom).toBe(Math.max(0, 2 * n - MODEL_PARAMETERS[model]));
      for (const p of wellSpreadPoints(rng, 25, BOARD_100x60)) {
        const image = mapBoardToImage(registration, p)!, expected = map(truth, p);
        expect(dist(image, expected)).toBeLessThan(1e-5);
        expect(dist(mapImageToBoard(registration, expected)!, p)).toBeLessThan(1e-6);
      }
      expect(registration.rmsBoard).toBeLessThan(1e-6);
      expect(registration.rmsImage).toBeLessThan(1e-5);
      expect(registration.warnings.some(w => w.code === 'EXACT_FIT')).toBe(registration.degreesOfFreedom === 0);
      expect(registration.derived).toBe(false);
    });
  });

  it('applies the requested model whatever the number of pairs allows', () => {
    const rng = new Rng(102);
    const { pairs, spec } = photo(rng, 8, 0, { tiltDeg: 0, panDeg: 0 });
    for (const model of ['similarity', 'affine', 'homography'] as RegistrationModel[]) {
      const r = registerBoardImage(pairs, { model, mirrored: spec.mirrored });
      expect(r.model).toBe(model);
      expect(r.degreesOfFreedom).toBe(16 - MODEL_PARAMETERS[model]);
      expect(r.rmsBoard).toBeLessThan(1e-6);
    }
    for (const model of ['similarity', 'affine', 'homography'] as const) {
      const e = expectError(() => registerBoardImage(pairs.slice(0, MODEL_MIN_POINTS[model] - 1), { model, mirrored: spec.mirrored }), 'TOO_FEW_POINTS');
      expect(e.detail).toMatchObject({ needed: MODEL_MIN_POINTS[model], given: MODEL_MIN_POINTS[model] - 1 });
    }
  });

  it('reads scale and rotation off the map, for both sides', () => {
    forAll(100, 103, rng => {
      const mirrored = rng.chance(0.5);
      const roll = rng.range(-179, 179), distanceMm = rng.range(60, 400);
      const { pairs } = photo(rng, 5, 0, { tiltDeg: 0, panDeg: 0, rollDeg: roll, mirrored, distanceMm });
      const r = registerBoardImage(pairs, { mirrored });
      expect(r.linear.pixelsPerMm).toBeCloseTo(3000 / distanceMm, 6);
      expect(Math.abs(norm180(r.linear.rotationDegrees - roll))).toBeLessThan(1e-6);
      expect(r.linear.handedness).toBe(1);
      expect(r.linear.anisotropy).toBeCloseTo(1, 8);
    });
  });

  it('is exact far from the origin and at very different scales (a 4K photo and a 20 mm close-up)', () => {
    forAll(60, 104, rng => {
      const distanceMm = rng.pick([30, 100, 600]);
      const offset = { x: rng.range(-500, 500), y: rng.range(-500, 500) };
      const spec = { ...PHOTO_4K, distanceMm, tiltDeg: 8, rollDeg: rng.range(-180, 180), lookAt: offset, mirrored: rng.chance(0.5) };
      const truth = cameraMatrix(spec);
      const board = wellSpreadPoints(rng, 6, { minX: offset.x - 12, minY: offset.y - 8, maxX: offset.x + 12, maxY: offset.y + 8 });
      const r = registerBoardImage(board.map(p => ({ board: p, image: map(truth, p) })), { mirrored: spec.mirrored });
      for (const p of board) expect(dist(mapBoardToImage(r, p)!, map(truth, p))).toBeLessThan(1e-5);
      expect(r.rmsBoard).toBeLessThan(1e-6);
    });
  });
});

describe('bottom side and the wrong side', () => {
  it('maps the side to the flag', () => {
    expect(mirroredForSide('bottom')).toBe(true);
    expect(mirroredForSide('top')).toBe(false);
    expect(orientBoardPoint({ x: 3, y: 4 }, true)).toEqual({ x: -3, y: -4 });
    expect(orientBoardPoint({ x: 3, y: 4 }, false)).toEqual({ x: 3, y: -4 });
  });

  it('a photo of the bottom side fits with mirroring and keeps handedness; the fit never silently mirrors', () => {
    forAll(100, 111, rng => {
      const { pairs, matrix } = photo(rng, rng.int(3, 8), 0.5, { mirrored: true, tiltDeg: 0, panDeg: 0 });
      const right = registerBoardImage(pairs, { mirrored: true });
      expect(right.linear.handedness).toBe(1);
      expect(right.orientation.reversed).toBe(false);
      expect(right.orientation.suspectMirrored).toBe(false);
      expect(right.rmsImage).toBeLessThan(2);
      const probe = { x: 12.5, y: -7.25 };
      expect(dist(mapBoardToImage(right, probe)!, map(matrix, probe))).toBeLessThan(3);
    });
  });

  it('declaring the wrong side is caught: the handedness reverses or the opposite side fits better (3 or more pairs)', () => {
    let caught = 0, runs = 0;
    forAll(200, 112, rng => {
      const mirrored = rng.chance(0.5);
      const { pairs } = photo(rng, rng.int(3, 8), 1, { mirrored });
      const wrong = registerBoardImage(pairs, { mirrored: !mirrored });
      runs++;
      if (wrong.orientation.suspectMirrored && wrong.warnings.some(w => w.code === 'MIRROR_SUSPECTED')) caught++;
      // The map is always orientation-preserving in the oriented frame; the wrong side shows as a large residual or a reversed linearization, never as a good fit.
      expect(wrong.orientation.reversed || wrong.rmsImage > 3 || wrong.degreesOfFreedom === 0).toBe(true);
    });
    expect(caught / runs).toBeGreaterThan(0.97);
  });

  it('a correct side is not accused (tilted photos, 1 px clicking noise)', () => {
    let accused = 0;
    forAll(300, 113, rng => {
      const { pairs, spec } = photo(rng, rng.int(3, 9), 1);
      if (registerBoardImage(pairs, { mirrored: spec.mirrored }).orientation.suspectMirrored) accused++;
    });
    expect(accused).toBeLessThanOrEqual(1);
  });

  it('suggestOrientation compares the two sides and needs 3 pairs', () => {
    const rng = new Rng(114);
    const { pairs, spec } = photo(rng, 5, 0.5, { tiltDeg: 0, panDeg: 0 });
    const fit = suggestOrientation(pairs, spec.mirrored)!;
    expect(fit.declared).toBeLessThan(0.1);
    expect(fit.opposite).toBeGreaterThan(5 * fit.declared);
    expect(suggestOrientation(pairs.slice(0, 2), spec.mirrored)).toBeNull();
    expect(suggestOrientation([pairs[0], pairs[0], pairs[1]], spec.mirrored)).toBeNull();
  });

  it('two points cannot reveal the side, and the record says so: no accusation', () => {
    const rng = new Rng(115);
    const { pairs, spec } = photo(rng, 2, 0, { tiltDeg: 0, panDeg: 0 });
    expect(registerBoardImage(pairs, { mirrored: !spec.mirrored }).orientation.suspectMirrored).toBe(false);
    expect(registerBoardImage(pairs, { mirrored: !spec.mirrored }).orientation.similarityRms).toBeNull();
  });

  it('two pairs matched in the wrong order are flagged, as an error or as a warning', () => {
    let flagged = 0, runs = 0;
    forAll(240, 116, rng => {
      const n = rng.int(4, 8);
      const { pairs, spec } = photo(rng, n, 1);
      const swapped = pairs.map(p => ({ ...p }));
      const a = rng.int(0, n - 1), b = (a + rng.int(1, n - 1)) % n;
      [swapped[a].image, swapped[b].image] = [swapped[b].image, swapped[a].image];
      runs++;
      try {
        const r = registerBoardImage(swapped, { mirrored: spec.mirrored });
        if (r.warnings.some(w => w.code !== 'EXACT_FIT' && w.code !== 'NEAR_COLLINEAR')) flagged++;
      } catch (error) {
        expect(error).toBeInstanceOf(RegistrationError);
        flagged++;
      }
    });
    expect(flagged / runs).toBeGreaterThan(0.97);
  });
});

describe('residuals and accuracy', () => {
  const sigmaHat = (r: Registration) => Math.sqrt(r.rmsImage * r.rmsImage * r.pointCount / r.degreesOfFreedom);
  for (const model of ['similarity', 'affine', 'homography'] as const) {
    it(`${model}: the residuals estimate the clicking noise without bias (mean of the variance estimate within 12 % of 1 px squared)`, () => {
      const rng = new Rng(121 + MODEL_MIN_POINTS[model]);
      let sum = 0;
      const runs = 300;
      for (let run = 0; run < runs; run++) {
        const { pairs, spec } = photo(rng, MODEL_MIN_POINTS[model] + 4, 1, model === 'homography' ? {} : { tiltDeg: 0, panDeg: 0 });
        const r = registerBoardImage(pairs, { model, mirrored: spec.mirrored });
        sum += sigmaHat(r) ** 2;
      }
      expect(sum / runs).toBeGreaterThan(0.88);
      expect(sum / runs).toBeLessThan(1.12);
    });
  }

  it('reports the residuals per point in board millimetres and in pixels, consistent with each other', () => {
    const rng = new Rng(122);
    const { pairs, spec } = photo(rng, 8, 2, { tiltDeg: 0, panDeg: 0, distanceMm: 100 });
    const r = registerBoardImage(pairs, { mirrored: spec.mirrored });
    expect(r.residuals).toHaveLength(8);
    r.residuals.forEach((res, i) => {
      expect(res.index).toBe(i);
      expect(res.board).toBeCloseTo(Math.hypot(res.dx, res.dy), 12);
      // At 30 px/mm of a straight photo a pixel is 1/30 mm.
      expect(res.board).toBeGreaterThan(0);
      expect(res.board * 30).toBeGreaterThan(res.image * 0.5);
      expect(res.board * 30).toBeLessThan(res.image * 2);
      expect(res.leaveOneOut).not.toBeNull();
      expect(res.leaveOneOut!).toBeGreaterThanOrEqual(res.board - 1e-12);
    });
    expect(r.rmsBoard).toBeCloseTo(Math.sqrt(r.residuals.reduce((s, x) => s + x.board ** 2, 0) / 8), 12);
    expect(r.maxBoard).toBeCloseTo(Math.max(...r.residuals.map(x => x.board)), 12);
    expect(r.rmsImage).toBeGreaterThan(0.5);
    expect(r.rmsImage).toBeLessThan(5);
    expect(r.rmsBoard * 30).toBeGreaterThan(r.rmsImage * 0.6);
  });

  it('a pair that is used for the fit pulls its own residual down: the leave-one-out error is the honest one', () => {
    const rng = new Rng(123);
    let larger = 0, total = 0;
    for (let run = 0; run < 100; run++) {
      const { pairs, spec } = photo(rng, 7, 2);
      const r = registerBoardImage(pairs, { mirrored: spec.mirrored });
      for (const res of r.residuals) { total++; if (res.leaveOneOut! > res.board) larger++; }
    }
    expect(larger / total).toBeGreaterThan(0.98);
  });

  it('with the model that matches the camera the held-out error is about the click noise; a model that is too simple shows up as a large residual', () => {
    const rng = new Rng(124);
    const projective: number[] = [], rigid: number[] = [];
    for (let run = 0; run < 120; run++) {
      const { pairs, spec, matrix } = photo(rng, 8, 0.5, { tiltDeg: rng.range(15, 30), panDeg: rng.range(-30, 30) });
      const good = registerBoardImage(pairs, { mirrored: spec.mirrored });
      const rigidFit = registerBoardImage(pairs, { model: 'similarity', mirrored: spec.mirrored });
      const probes = wellSpreadPoints(rng, 20, BOARD_100x60);
      projective.push(Math.sqrt(probes.reduce((s, p) => s + dist(mapBoardToImage(good, p)!, map(matrix, p)) ** 2, 0) / 20));
      rigid.push(rigidFit.rmsImage);
      expect(good.warnings.some(w => w.code === 'POOR_FIT')).toBe(false);
      expect(rigidFit.warnings.some(w => w.code === 'POOR_FIT' || w.code === 'OUTLIER_SUSPECTED' || w.code === 'MIRROR_SUSPECTED')).toBe(true);
    }
    projective.sort((a, b) => a - b); rigid.sort((a, b) => a - b);
    expect(projective[60]).toBeLessThan(1.2);
    expect(rigid[60]).toBeGreaterThan(5);
  });

  it('shows radial lens distortion as a residual and warns when it is strong', () => {
    const rng = new Rng(125);
    const spec = { ...PHOTO_4K, distanceMm: 100, k1: 0.12, tiltDeg: 0, panDeg: 0 };
    const matrix = cameraMatrix(spec);
    const board = wellSpreadPoints(rng, 10, BOARD_100x60);
    const pairs = makePairs(rng, board, p => distortedProject(matrix, spec, p), 0);
    const r = registerBoardImage(pairs);
    // 0.12 of the normalized radius cubed at the frame corners is tens of pixels: the 8-number model cannot follow it.
    expect(r.rmsImage).toBeGreaterThan(2);
    expect(r.warnings.some(w => w.code === 'POOR_FIT' || w.code === 'OUTLIER_SUSPECTED')).toBe(true);
  });

  it('the residual figures follow the map when the board points are noisy instead of the photo points', () => {
    const rng = new Rng(126);
    const spec = { ...PHOTO_4K, distanceMm: 100, tiltDeg: 0, panDeg: 0 };
    const matrix = cameraMatrix(spec);
    const board = wellSpreadPoints(rng, 12, BOARD_100x60);
    const r = registerBoardImage(makePairs(rng, board, p => map(matrix, p), 0, 0.1));
    // 0.1 mm of board noise is 3 px at 30 px/mm.
    expect(r.rmsImage).toBeGreaterThan(1.5);
    expect(r.rmsImage).toBeLessThan(6);
  });
});

describe('what cannot be registered', () => {
  const sq = (): Correspondence[] => [
    { board: { x: 0, y: 0 }, image: { x: 100, y: 100 } }, { board: { x: 10, y: 0 }, image: { x: 400, y: 120 } },
    { board: { x: 10, y: 8 }, image: { x: 420, y: 400 } }, { board: { x: 0, y: 8 }, image: { x: 90, y: 380 } },
  ];

  it('has too few pairs', () => {
    expectError(() => registerBoardImage([]), 'TOO_FEW_POINTS');
    expectError(() => registerBoardImage(sq().slice(0, 1)), 'TOO_FEW_POINTS');
    expectError(() => registerBoardImage(undefined as unknown as Correspondence[]), 'TOO_FEW_POINTS');
    expectError(() => registerBoardImage(sq().slice(0, 3), { model: 'homography' }), 'TOO_FEW_POINTS');
  });

  it('has coordinates that are not numbers, naming the pair and the side', () => {
    for (const bad of [NaN, Infinity, undefined as unknown as number, null as unknown as number]) {
      const a = sq(); a[2] = { board: { x: bad, y: 8 }, image: a[2].image };
      expect(expectError(() => registerBoardImage(a), 'INVALID_POINT').detail).toMatchObject({ indices: [2], side: 'board' });
      const b = sq(); b[1] = { board: b[1].board, image: { x: 400, y: bad } };
      expect(expectError(() => registerBoardImage(b), 'INVALID_POINT').detail).toMatchObject({ indices: [1], side: 'image' });
    }
    const missing = sq(); missing[3] = { board: { x: 0, y: 8 } } as unknown as Correspondence;
    expectError(() => registerBoardImage(missing), 'INVALID_POINT');
    const hole = sq(); (hole as unknown[])[0] = null;
    expectError(() => registerBoardImage(hole), 'INVALID_POINT');
  });

  it('has a place entered twice, on the board or on the photo', () => {
    const a = sq(); a[3] = { board: { ...a[1].board }, image: a[3].image };
    expect(expectError(() => registerBoardImage(a), 'DUPLICATE_POINTS').detail).toMatchObject({ indices: [1, 3], side: 'board' });
    const b = sq(); b[2] = { board: b[2].board, image: { ...b[0].image } };
    expect(expectError(() => registerBoardImage(b), 'DUPLICATE_POINTS').detail).toMatchObject({ indices: [0, 2], side: 'image' });
    expectError(() => registerBoardImage([sq()[0], { board: sq()[1].board, image: sq()[0].image }]), 'DUPLICATE_POINTS');
  });

  it('has points on a line, on the board or on the photo, and names the three that are', () => {
    const line = [0, 1, 2, 3].map(i => ({ x: i * 7, y: 2 + i * 3.5 }));
    const photoPoints = sq().map(p => p.image);
    const onBoardLine = line.map((p, i) => ({ board: p, image: photoPoints[i] }));
    expect(expectError(() => registerBoardImage(onBoardLine), 'COLLINEAR').detail).toMatchObject({ side: 'board' });
    expect(expectError(() => registerBoardImage(onBoardLine.slice(0, 3)), 'COLLINEAR').detail).toMatchObject({ side: 'board' });
    const onPhotoLine = sq().map((p, i) => ({ board: p.board, image: { x: 100 + i * 50, y: 200 + i * 30 } }));
    expect(expectError(() => registerBoardImage(onPhotoLine), 'COLLINEAR').detail).toMatchObject({ side: 'image' });
    const three = sq(); three[1] = { board: { x: 5, y: 0.1 }, image: three[1].image }; three[2] = { board: { x: 10, y: 0 }, image: three[2].image };
    const e = expectError(() => registerBoardImage(three), 'COLLINEAR');
    expect(e.detail.indices).toEqual([0, 1, 2]);
    expect(e.message).toMatch(/1, 2, 3/);
    // Two points on a line are all a similarity needs.
    expect(() => registerBoardImage(onBoardLine.slice(0, 2))).not.toThrow();
  });

  it('refuses a perspective map that folds over the points (pairs in a crossing order)', () => {
    const crossing = sq();
    [crossing[1].image, crossing[2].image] = [crossing[2].image, crossing[1].image];
    const e = expectError(() => registerBoardImage(crossing), 'FOLDED');
    expect(e.detail.indices!.length).toBeGreaterThan(0);
    expect(e.message).toMatch(/order/);
  });

  it('limits the number of pairs', () => {
    const rng = new Rng(131);
    const many = Array.from({ length: 1001 }, () => ({ board: randomPoint(rng, BOARD_100x60), image: randomPoint(rng, { minX: 0, minY: 0, maxX: 3840, maxY: 2160 }) }));
    expectError(() => registerBoardImage(many), 'TOO_MANY_POINTS');
  });

  it('never returns a registration with a non-finite number', () => {
    forAll(400, 132, rng => {
      const n = rng.int(2, 7);
      const pairs: Correspondence[] = Array.from({ length: n }, () => ({
        board: randomPoint(rng, rng.chance(0.5) ? BOARD_100x60 : { minX: 0, minY: 0, maxX: 1e-3, maxY: 1e-3 }),
        image: randomPoint(rng, rng.chance(0.5) ? { minX: 0, minY: 0, maxX: 3840, maxY: 2160 } : { minX: 0, minY: 0, maxX: 1e-6, maxY: 1e-6 }),
      }));
      try {
        const r = registerBoardImage(pairs, { mirrored: rng.chance(0.5) });
        for (const v of [...r.boardToImage, ...r.imageToBoard, r.rmsBoard, r.rmsImage, r.linear.pixelsPerMm]) expect(Number.isFinite(v)).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(RegistrationError);
      }
    });
  });
});

describe('the outlier hint (leave-one-out, studentized)', () => {
  const bump = (pairs: Correspondence[], k: number, magnitude: number, rng: Rng): Correspondence[] => {
    const copy = pairs.map(p => ({ ...p })), angle = rng.range(0, 2 * Math.PI);
    copy[k] = { ...copy[k], image: { x: copy[k].image.x + magnitude * Math.cos(angle), y: copy[k].image.y + magnitude * Math.sin(angle) } };
    return copy;
  };

  it('names the mistaken pair of 10 (a 40 px = 1.3 mm slip), almost always, and never another pair', () => {
    let found = 0, wrong = 0;
    const runs = 200;
    forAll(runs, 141, rng => {
      const n = 10, { pairs, spec } = photo(rng, n, 1);
      const k = rng.int(0, n - 1);
      const hint = registerBoardImage(bump(pairs, k, 40, rng), { mirrored: spec.mirrored }).outlierHint;
      if (hint) { if (hint.index === k) found++; else wrong++; }
    });
    expect(found / runs).toBeGreaterThan(0.92);
    expect(wrong).toBeLessThanOrEqual(1);
  }, 300_000);

  it('does the same with 14 pairs for a 20 px slip, and reports the evidence', () => {
    let found = 0;
    const runs = 120;
    forAll(runs, 142, rng => {
      const n = 14, { pairs, spec } = photo(rng, n, 1);
      const k = rng.int(0, n - 1);
      const r = registerBoardImage(bump(pairs, k, 20, rng), { mirrored: spec.mirrored });
      if (r.outlierHint?.index === k) {
        found++;
        const h = r.outlierHint;
        expect(h.score).toBeGreaterThanOrEqual(5);
        expect(h.leaveOneOutPx).toBeGreaterThan(10);
        expect(h.leaveOneOut).toBeGreaterThan(h.rmsWithout);
        expect(h.sigmaPx).toBeGreaterThanOrEqual(2);
        const warning = r.warnings.find(w => w.code === 'OUTLIER_SUSPECTED')!;
        expect(warning.indices).toEqual([k]);
        expect(r.warnings.some(w => w.code === 'POOR_FIT')).toBe(false);
      }
    });
    expect(found / runs).toBeGreaterThan(0.8);
  }, 300_000);

  it('raises no hint on clean data at the assumed click noise (7 to 14 pairs, 2 px)', () => {
    let hints = 0, runs = 0;
    forAll(200, 143, rng => {
      const n = rng.int(7, 14), { pairs, spec } = photo(rng, n, 2);
      runs++;
      if (registerBoardImage(pairs, { mirrored: spec.mirrored }).outlierHint) hints++;
    });
    expect(hints / runs).toBeLessThanOrEqual(0.01);
  }, 300_000);

  it('names no pair below 6 degrees of freedom, but says that the pairs disagree', () => {
    expect(OUTLIER_MIN_DOF).toBe(6);
    let warned = 0, runs = 0;
    forAll(150, 144, rng => {
      const n = 6, { pairs, spec } = photo(rng, n, 1);
      const r = registerBoardImage(bump(pairs, rng.int(0, n - 1), 80, rng), { mirrored: spec.mirrored });
      expect(r.degreesOfFreedom).toBe(4);
      expect(r.outlierHint).toBeNull();
      runs++;
      if (r.warnings.some(w => w.code === 'POOR_FIT')) warned++;
    });
    expect(warned / runs).toBeGreaterThan(0.75);
  }, 300_000);

  it('names a pair for the simpler models too (similarity 5 pairs, affine 6 pairs)', () => {
    for (const [model, n] of [['similarity', 5], ['affine', 6]] as const) {
      let found = 0, runs = 0;
      forAll(120, 145, rng => {
        const { pairs, spec } = photo(rng, n, 1, { tiltDeg: 0, panDeg: 0 });
        const k = rng.int(0, n - 1);
        const r = registerBoardImage(bump(pairs, k, 60, rng), { model, mirrored: spec.mirrored });
        expect(r.degreesOfFreedom).toBe(2 * n - MODEL_PARAMETERS[model]);
        runs++;
        if (r.outlierHint?.index === k) found++;
        else expect(r.outlierHint === null || r.outlierHint.index !== k).toBe(true);
      });
      expect(found / runs).toBeGreaterThan(0.7);
    }
  }, 300_000);

  it('can be switched off, tightened or relaxed', () => {
    const rng = new Rng(146);
    const { pairs, spec } = photo(rng, 12, 1);
    const bad = bump(pairs, 4, 60, rng);
    expect(registerBoardImage(bad, { mirrored: spec.mirrored }).outlierHint?.index).toBe(4);
    const off = registerBoardImage(bad, { mirrored: spec.mirrored, leaveOneOut: false });
    expect(off.outlierHint).toBeNull();
    expect(off.residuals.every(r => r.leaveOneOut === null)).toBe(true);
    expect(registerBoardImage(bad, { mirrored: spec.mirrored, outlierScore: 1e6 }).outlierHint).toBeNull();
    // A noisy clicker (10 px) gets no hint for a 40 px slip because the score is measured in multiples of the stated noise.
    expect(registerBoardImage(bump(pairs, 4, 25, rng), { mirrored: spec.mirrored, noiseSigmaPx: 12 }).outlierHint).toBeNull();
  });

  it('skips the refits for more than 40 pairs and for exact fits', () => {
    const rng = new Rng(147);
    const { pairs, spec } = photo(rng, 41, 1);
    const r = registerBoardImage(pairs, { mirrored: spec.mirrored });
    expect(r.outlierHint).toBeNull();
    expect(r.residuals.every(x => x.leaveOneOut === null)).toBe(true);
    const exact = registerBoardImage(photo(rng, 4, 1).pairs);
    expect(exact.degreesOfFreedom).toBe(0);
    expect(exact.residuals.every(x => x.leaveOneOut === null)).toBe(true);
  });
});

describe('warnings', () => {
  it('says when a fit is exact and its error figure therefore means nothing', () => {
    const rng = new Rng(151);
    for (const n of [2, 3, 4]) {
      const { pairs, spec } = photo(rng, n, 1, { tiltDeg: 0, panDeg: 0 });
      const r = registerBoardImage(pairs, { mirrored: spec.mirrored });
      expect(r.degreesOfFreedom).toBe(0);
      expect(r.warnings.map(w => w.code)).toContain('EXACT_FIT');
      expect(r.rmsBoard).toBeLessThan(1e-6);
      const spare = registerBoardImage(photo(rng, n + 1, 1, { tiltDeg: 0, panDeg: 0 }).pairs, { model: modelForCount(n) });
      expect(spare.warnings.map(w => w.code)).not.toContain('EXACT_FIT');
    }
  });

  it('warns about points that nearly lie on a line, and says which side', () => {
    const board = [{ x: 0, y: 0 }, { x: 40, y: 5 }, { x: 80, y: 0 }, { x: 40, y: 50 }];
    const spec = { ...PHOTO_4K, distanceMm: 100 };
    const matrix = cameraMatrix(spec);
    const r = registerBoardImage(board.slice(0, 3).map(p => ({ board: p, image: map(matrix, p) })), { model: 'affine' });
    const warning = r.warnings.find(w => w.code === 'NEAR_COLLINEAR')!;
    expect(warning.side).toBe('board');
    expect(warning.message).toMatch(/line/);
    const fine = registerBoardImage([board[0], board[2], board[3]].map(p => ({ board: p, image: map(matrix, p) })));
    expect(fine.warnings.map(w => w.code)).not.toContain('NEAR_COLLINEAR');
  });

  it('warns about a strong stretch', () => {
    const rng = new Rng(152);
    const { pairs, spec } = photo(rng, 6, 0.3, { tiltDeg: 50, panDeg: 0, rollDeg: 0, mirrored: false, distanceMm: 400 });
    const r = registerBoardImage(pairs, { mirrored: spec.mirrored });
    expect(r.linear.anisotropy).toBeGreaterThan(1.35);
    expect(r.warnings.map(w => w.code)).toContain('STRONG_DISTORTION');
  });
});

describe('mapping points and rectangles', () => {
  it('round-trips random points through the inverse (forward then inverse, and inverse then forward) to 1e-6', () => {
    forAll(200, 161, rng => {
      const { pairs, spec } = photo(rng, rng.int(2, 9), rng.pick([0, 0.5, 2]), rng.chance(0.5) ? {} : { tiltDeg: 0, panDeg: 0 });
      const r = registerBoardImage(pairs, { mirrored: spec.mirrored });
      for (let k = 0; k < 20; k++) {
        const p = randomPoint(rng, { minX: -80, minY: -60, maxX: 80, maxY: 60 });
        const image = mapBoardToImage(r, p)!;
        expect(dist(mapImageToBoard(r, image)!, p)).toBeLessThan(1e-6);
        const q = randomPoint(rng, { minX: -500, minY: -500, maxX: 4500, maxY: 2700 });
        const board = mapImageToBoard(r, q);
        if (board) expect(dist(mapBoardToImage(r, board)!, q)).toBeLessThan(1e-5);
      }
    });
  });

  it('maps the corners of a rectangle and returns their bounds; a corner behind the horizon gives null', () => {
    const rng = new Rng(162);
    const { pairs, spec } = photo(rng, 6, 0.3, { tiltDeg: 30, panDeg: 10, distanceMm: 150 });
    const r = registerBoardImage(pairs, { mirrored: spec.mirrored });
    const rect = { minX: -20, minY: -10, maxX: 30, maxY: 25 };
    const quad = mapBoardRectToImage(r, rect)!;
    const corners = [{ x: -20, y: -10 }, { x: 30, y: -10 }, { x: 30, y: 25 }, { x: -20, y: 25 }].map(p => mapBoardToImage(r, p)!);
    quad.corners.forEach((c, i) => expect(dist(c, corners[i])).toBeLessThan(1e-9));
    expect(quad.bounds.minX).toBeCloseTo(Math.min(...corners.map(c => c.x)), 9);
    expect(quad.bounds.maxY).toBeCloseTo(Math.max(...corners.map(c => c.y)), 9);
    const back = mapImageRectToBoard(r, { minX: 0, minY: 0, maxX: 3840, maxY: 2160 })!;
    expect(back.corners).toHaveLength(4);
    expect(back.bounds.minX).toBeLessThan(back.bounds.maxX);
    // A board rectangle that reaches the horizon of the map has corners without an image.
    const far = mapBoardRectToImage(r, { minX: -1e7, minY: -1e7, maxX: 1e7, maxY: 1e7 });
    expect(far === null || far.corners.every(c => Number.isFinite(c.x))).toBe(true);
  });

  it('maps whole arrays like single points, in place, and counts the points without an image', () => {
    const rng = new Rng(163);
    const { pairs, spec } = photo(rng, 6, 0.3, { tiltDeg: 35, panDeg: 0, rollDeg: 0, distanceMm: 120 });
    const r = registerBoardImage(pairs, { mirrored: spec.mirrored });
    const count = 500;
    const input = new Float64Array(count * 2);
    for (let i = 0; i < count; i++) { const p = randomPoint(rng, { minX: -300, minY: -300, maxX: 300, maxY: 300 }); input[2 * i] = p.x; input[2 * i + 1] = p.y; }
    const out = new Float64Array(count * 2), out32 = new Float32Array(count * 2);
    const missing = mapBoardPointsToImage(r, input, out);
    expect(mapBoardPointsToImage(r, input, out32)).toBe(missing);
    let expectedMissing = 0;
    for (let i = 0; i < count; i++) {
      const single = mapBoardToImage(r, { x: input[2 * i], y: input[2 * i + 1] });
      if (!single) { expectedMissing++; expect(Number.isNaN(out[2 * i])).toBe(true); continue; }
      expect(out[2 * i]).toBe(single.x);
      expect(out[2 * i + 1]).toBe(single.y);
      expect(out32[2 * i]).toBeCloseTo(single.x, -1);
    }
    expect(missing).toBe(expectedMissing);
    expect(() => mapBoardPointsToImage(r, input, new Float64Array(10))).toThrow(RangeError);
    const back = new Float64Array(count * 2);
    mapImagePointsToBoard(r, out, back);
    for (let i = 0; i < count; i++) if (!Number.isNaN(out[2 * i])) expect(Math.hypot(back[2 * i] - input[2 * i], back[2 * i + 1] - input[2 * i + 1])).toBeLessThan(1e-6);
  });

  it('linearizes the map at any board point: scale falls toward the far side of a tilted photo', () => {
    const rng = new Rng(164);
    const { pairs, spec } = photo(rng, 6, 0, { tiltDeg: 30, panDeg: 0, rollDeg: 0, mirrored: false, distanceMm: 150 });
    const r = registerBoardImage(pairs, { mirrored: spec.mirrored });
    const near = linearizeAt(r, { x: 0, y: -25 })!, far = linearizeAt(r, { x: 0, y: 25 })!;
    expect(near.pixelsPerMm).not.toBeCloseTo(far.pixelsPerMm, 1);
    expect(linearizeAt(r, { x: 1e9, y: 1e9 })).toBeNull();
    expect(near.handedness).toBe(1);
  });
});

describe('saved alignments', () => {
  it('survive a JSON round trip with the same map, residuals and warnings', () => {
    forAll(60, 171, rng => {
      const { pairs, spec } = photo(rng, rng.int(2, 9), 1);
      const r = registerBoardImage(pairs, { mirrored: spec.mirrored });
      const json = JSON.parse(JSON.stringify(registrationToRecord(r, pairs)));
      const loaded = registrationFromRecord(json)!;
      expect(loaded).not.toBeNull();
      expect(loaded.model).toBe(r.model);
      expect(loaded.mirrored).toBe(r.mirrored);
      for (const p of wellSpreadPoints(rng, 10, BOARD_100x60)) expect(dist(mapBoardToImage(loaded, p)!, mapBoardToImage(r, p)!)).toBeLessThan(1e-6);
      expect(loaded.rmsBoard).toBeCloseTo(r.rmsBoard, 9);
      expect(loaded.pointCount).toBe(r.pointCount);
      expect(loaded.warnings.map(w => w.code)).toEqual(r.warnings.map(w => w.code));
    });
  });

  it('are valid without the pairs, and keep the map', () => {
    const rng = new Rng(172);
    const { pairs, spec } = photo(rng, 6, 1);
    const r = registerBoardImage(pairs, { mirrored: spec.mirrored });
    const record = registrationToRecord(r);
    expect(record.points).toBeUndefined();
    const loaded = registrationFromRecord(JSON.parse(JSON.stringify(record)))!;
    expect(loaded.pointCount).toBe(0);
    expect(loaded.residuals).toEqual([]);
    expect(dist(mapBoardToImage(loaded, { x: 3, y: 4 })!, mapBoardToImage(r, { x: 3, y: 4 })!)).toBeLessThan(1e-6);
    expect(dist(mapImageToBoard(loaded, { x: 1000, y: 900 })!, mapImageToBoard(r, { x: 1000, y: 900 })!)).toBeLessThan(1e-6);
    expect(loaded.linear.pixelsPerMm).toBeCloseTo(r.linear.pixelsPerMm, 6);
  });

  it('restores the sign convention of a matrix saved with the opposite sign', () => {
    const rng = new Rng(173);
    const r = registerBoardImage(photo(rng, 5, 0.5).pairs);
    const record = registrationToRecord(r);
    const negated = { ...record, matrix: record.matrix.map(v => -v) };
    const loaded = registrationFromRecord(negated)!;
    expect(dist(mapBoardToImage(loaded, { x: 5, y: 5 })!, mapBoardToImage(r, { x: 5, y: 5 })!)).toBeLessThan(1e-6);
  });

  it('are rejected when they are not what this version wrote', () => {
    const rng = new Rng(174);
    const r = registerBoardImage(photo(rng, 5, 0.5).pairs);
    const good = JSON.parse(JSON.stringify(registrationToRecord(r))) as Record<string, unknown>;
    expect(registrationFromRecord(good)).not.toBeNull();
    const bad: unknown[] = [
      null, undefined, 3, 'x', [], {}, { ...good, version: 2 }, { ...good, version: undefined }, { ...good, model: 'rigid' }, { ...good, mirrored: 'yes' }, { ...good, matrix: [1, 2, 3] },
      { ...good, matrix: [...(good.matrix as number[]).slice(0, 8), NaN] }, { ...good, matrix: [...(good.matrix as number[]).slice(0, 8), null] }, { ...good, matrix: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { ...good, matrix: [1, 2, 3, 2, 4, 6, 0, 0, 1] }, { ...good, matrix: (good.matrix as number[]).map(() => 1e300) }, { ...good, reference: { x: NaN, y: 0 } }, { ...good, reference: null },
      { ...good, points: 'none' }, { ...good, points: [{ board: { x: 0, y: 0 }, image: { x: NaN, y: 0 } }] }, { ...good, points: [null] },
      { ...good, points: Array.from({ length: 1001 }, (_, i) => ({ board: { x: i, y: i * i }, image: { x: i, y: i } })) },
    ];
    for (const record of bad) expect(registrationFromRecord(record)).toBeNull();
  });

  it('refuses a record whose matrix has no image at its own reference point', () => {
    const rng = new Rng(175);
    const r = registerBoardImage(photo(rng, 5, 0.5).pairs);
    const record = registrationToRecord(r);
    const m = record.matrix.slice();
    // W = 0 at the reference: the point sits on the horizon of the map.
    m[8] = -(m[6] * r.reference.x + m[7] * r.reference.y);
    expect(registrationFromRecord({ ...record, matrix: m })).toBeNull();
  });
});

describe('another image of the same board (dual sensor cameras, close-ups)', () => {
  it('derives the registration of a smaller thermal grid from the visible picture', () => {
    const rng = new Rng(181);
    const { pairs, spec } = photo(rng, 8, 0.5, { tiltDeg: 12 });
    const visible = registerBoardImage(pairs, { mirrored: spec.mirrored });
    const thermal = deriveRegistration(visible, scaling(320 / 3840, 240 / 2160));
    expect(thermal.derived).toBe(true);
    expect(thermal.residuals).toEqual([]);
    expect(thermal.pointCount).toBe(0);
    expect(thermal.rmsBoard).toBe(visible.rmsBoard);
    for (const p of wellSpreadPoints(rng, 20, BOARD_100x60)) {
      const v = mapBoardToImage(visible, p)!, t = mapBoardToImage(thermal, p)!;
      expect(t.x).toBeCloseTo(v.x * 320 / 3840, 6);
      expect(t.y).toBeCloseTo(v.y * 240 / 2160, 6);
      expect(dist(mapImageToBoard(thermal, t)!, p)).toBeLessThan(1e-6);
    }
    // 12x fewer pixels along x: a pixel of error is 12 times bigger on the board.
    expect(thermal.rmsImage).toBeCloseTo(visible.rmsImage * thermal.linear.pixelsPerMm / visible.linear.pixelsPerMm, 9);
    expect(thermal.linear.pixelsPerMm).toBeLessThan(visible.linear.pixelsPerMm / 8);
    // Derivation also composes: derive the derived.
    const again = deriveRegistration(thermal, [2, 0, 0, 0, 2, 0, 0, 0, 1]);
    expect(mapBoardToImage(again, { x: 5, y: 5 })!.x).toBeCloseTo(2 * mapBoardToImage(thermal, { x: 5, y: 5 })!.x, 9);
  });

  it('refuses a map that cannot be inverted', () => {
    const rng = new Rng(182);
    const r = registerBoardImage(photo(rng, 5, 0.5).pairs);
    expectError(() => deriveRegistration(r, [1, 2, 0, 2, 4, 0, 0, 0, 1]), 'SINGULAR');
    expectError(() => deriveRegistration(r, [NaN, 0, 0, 0, 1, 0, 0, 0, 1]), 'SINGULAR');
  });

  it('ranks several photos of one place: the one that shows most detail at the point first', () => {
    const board = BOARD_100x60;
    const overview = cameraMatrix({ ...PHOTO_4K, distanceMm: 300, rollDeg: 0 });
    const closeSpec = { ...PHOTO_4K, distanceMm: 60, lookAt: { x: 30, y: 10 } };
    const closeUp = cameraMatrix(closeSpec);
    const rng = new Rng(183);
    const make = (id: string, m: Matrix3, area: typeof BOARD_100x60) => ({ id, width: 3840, height: 2160, registration: registerBoardImage(wellSpreadPoints(rng, 5, area).map(p => ({ board: p, image: map(m, p) }))) });
    const candidates = [make('overview', overview, board), make('close', closeUp, { minX: 22, minY: 4, maxX: 38, maxY: 16 })];
    const inClose = rankPhotosForBoardPoint(candidates, { x: 30, y: 10 });
    expect(inClose.map(c => c.id)).toEqual(['close', 'overview']);
    expect(inClose[0].pixelsPerMm).toBeCloseTo(50, 3);
    expect(inClose[1].pixelsPerMm).toBeCloseTo(10, 3);
    expect(inClose[0].imagePoint.x).toBeCloseTo(1920, 2);
    expect(rankPhotosForBoardPoint(candidates, { x: -40, y: -20 }).map(c => c.id)).toEqual(['overview']);
    expect(rankPhotosForBoardPoint(candidates, { x: 30, y: 10 }, { minMarginPx: 5000 })).toEqual([]);
    // Equal detail: the point farther from the edge first, then the id.
    const same = [{ ...candidates[0], id: 'b' }, { ...candidates[0], id: 'a' }];
    expect(rankPhotosForBoardPoint(same, { x: 0, y: 0 }).map(c => c.id)).toEqual(['a', 'b']);
  });
});

describe('cost', () => {
  it('maps every pixel of a 4K photo (8.3 million points) to the board with bounded work', () => {
    const rng = new Rng(191);
    const { pairs, spec } = photo(rng, 6, 0.5);
    const r = registerBoardImage(pairs, { mirrored: spec.mirrored });
    const width = 3840, height = 2160, chunkRows = 120;
    const input = new Float64Array(width * chunkRows * 2), output = new Float64Array(width * chunkRows * 2);
    let missing = 0, checksum = 0;
    const mapFrame = () => {
      missing = 0; checksum = 0;
      for (let row = 0; row < height; row += chunkRows) {
        for (let j = 0; j < chunkRows; j++) for (let i = 0; i < width; i++) { const k = (j * width + i) * 2; input[k] = i + 0.5; input[k + 1] = row + j + 0.5; }
        missing += mapImagePointsToBoard(r, input, output);
        checksum += output[0] + output[output.length - 1];
      }
    };
    expectCostAtMost('4K frame mapping', mapFrame, linearReference(width * height), 100);
    mapFrame();
    expect(Number.isFinite(checksum)).toBe(true);
    expect(missing).toBe(0);
  });

  it('registers 40 pairs with all leave-one-out refits with bounded work', () => {
    const rng = new Rng(192);
    const { pairs, spec } = photo(rng, 40, 1);
    const source = pairs.map(pair => pair.board), target = pairs.map(pair => pair.image);
    // Leave-one-out refits deliberately perform one linear fit per pair below the fixed cutoff.
    const refits = () => { for (let index = 0; index < pairs.length; index++) fitTransform(source, target, 'homography'); };
    expectCostAtMost('registration with bounded refits', () => registerBoardImage(pairs, { mirrored: spec.mirrored }), refits, 10);
  });

  it('registers 1000 pairs without refits with bounded work', () => {
    const rng = new Rng(193);
    const { pairs, spec } = photo(rng, 1000, 1);
    // Duplicate detection is a bounded pairwise pass even when leave-one-out refits are disabled. The reference is the work that must stay off: a
    // leave-one-out refit of every pair would be 1000 fits of 1000 points; a fiftieth of them (20 fits, about a second) already costs several times the registration,
    // so the registration must cost less than those 20 fits (it costs about a tenth of them).
    const source = pairs.map(pair => pair.board), target = pairs.map(pair => pair.image);
    const someRefits = () => { for (let index = 0; index < 20; index++) fitTransform(source, target, 'homography'); };
    expectCostAtMost('registration without refits', () => registerBoardImage(pairs, { mirrored: spec.mirrored }), someRefits, 1);
  });
});
