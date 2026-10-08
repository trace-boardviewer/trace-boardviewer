import { expectScaling, expectCostAtMost, pairwiseReference } from '../../test-support/timing';
import { describe, expect, it } from 'vitest';
import type { Bounds2 } from '../geometry';
import { transform } from './matrix3';
import type { Correspondence } from './registration';
import { RIGHT_FILE_THRESHOLDS, type RightFileCheck, type RightFileEvidenceCode, checkRightFile, chiSquareSurvivalEven, typicalPitchMm } from './rightfile';
import { Rng, cameraMatrix, forAll, makePairs, wellSpreadPoints } from './testkit';
import { makeToyBoard } from './testkit-board';

const toy = makeToyBoard();
const BOARD = { bounds: toy.bounds, pins: toy.pins };
const codes = (check: RightFileCheck): RightFileEvidenceCode[] => check.evidence.map(e => e.code);

/** A top-down or tilted photo of the toy board and the pairs a technician picks on it: `noisePx` of clicking noise on the photo side. */
function pick(rng: Rng, count: number, noisePx: number, options: { tilt?: number; mirrored?: boolean; distanceMm?: number } = {}) {
  const mirrored = options.mirrored ?? false, tilt = options.tilt ?? 0;
  const spec = { focalPx: 3000, width: 3840, height: 2160, distanceMm: options.distanceMm ?? 100, tiltDeg: tilt ? rng.range(-tilt, tilt) : 0, panDeg: tilt ? rng.range(-tilt, tilt) : 0, rollDeg: rng.range(-180, 180), mirrored };
  const matrix = cameraMatrix(spec);
  const board = wellSpreadPoints(rng, count, { minX: -34, minY: -19, maxX: 34, maxY: 19 });
  return { spec, matrix, pairs: makePairs(rng, board, p => transform(matrix, p)!, noisePx) };
}

/** Displaces the photo point of one pair, as if the file placed that part somewhere else than the real board. */
function moved(pairs: readonly Correspondence[], index: number, mm: number, pixelsPerMm: number, rng: Rng): Correspondence[] {
  const angle = rng.range(0, 2 * Math.PI);
  return pairs.map((p, i) => (i === index ? { ...p, image: { x: p.image.x + mm * pixelsPerMm * Math.cos(angle), y: p.image.y + mm * pixelsPerMm * Math.sin(angle) } } : p));
}

describe('chiSquareSurvivalEven', () => {
  it('reproduces the tabulated tail probabilities', () => {
    expect(chiSquareSurvivalEven(2, 2)).toBeCloseTo(Math.exp(-1), 12);
    expect(chiSquareSurvivalEven(9.2103, 2)).toBeCloseTo(0.01, 5);
    expect(chiSquareSurvivalEven(9.4877, 4)).toBeCloseTo(0.05, 5);
    expect(chiSquareSurvivalEven(13.2767, 4)).toBeCloseTo(0.01, 5);
    expect(chiSquareSurvivalEven(12.5916, 6)).toBeCloseTo(0.05, 5);
    expect(chiSquareSurvivalEven(18.307, 10)).toBeCloseTo(0.05, 5);
    expect(chiSquareSurvivalEven(31.41, 20)).toBeCloseTo(0.05, 4);
    expect(chiSquareSurvivalEven(4, 4)).toBeCloseTo(3 * Math.exp(-2), 12);
  });

  it('is 1 at zero, 0 far out, decreasing, and refuses odd or tiny degrees of freedom', () => {
    expect(chiSquareSurvivalEven(0, 4)).toBe(1);
    expect(chiSquareSurvivalEven(-3, 4)).toBe(1);
    expect(chiSquareSurvivalEven(1e6, 8)).toBe(0);
    expect(chiSquareSurvivalEven(Infinity, 2)).toBe(0);
    expect(Number.isNaN(chiSquareSurvivalEven(NaN, 2))).toBe(true);
    for (const dof of [2, 4, 8, 16]) {
      let previous = 1;
      for (let x = 0.5; x < 80; x += 0.5) { const p = chiSquareSurvivalEven(x, dof); expect(p).toBeLessThanOrEqual(previous + 1e-15); expect(p).toBeGreaterThanOrEqual(0); previous = p; }
    }
    expect(() => chiSquareSurvivalEven(1, 3)).toThrow(RangeError);
    expect(() => chiSquareSurvivalEven(1, 0)).toThrow(RangeError);
  });
});

describe('typicalPitchMm', () => {
  it('is the median distance to the nearest other pad', () => {
    const grid = Array.from({ length: 400 }, (_, i) => ({ x: (i % 20) * 1.27, y: Math.floor(i / 20) * 2.54 }));
    expect(typicalPitchMm(grid)).toBeCloseTo(1.27, 9);
    expect(typicalPitchMm(toy.pins)).toBeCloseTo(3, 9);
    expect(typicalPitchMm([{ x: 0, y: 0 }, { x: 0.5, y: 0 }])).toBeCloseTo(0.5, 12);
  });

  it('ignores coincident pads and bad points, and gives null for fewer than two distinct pads', () => {
    expect(typicalPitchMm([])).toBeNull();
    expect(typicalPitchMm([{ x: 1, y: 1 }])).toBeNull();
    expect(typicalPitchMm([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toBeNull();
    expect(typicalPitchMm([{ x: 1, y: 1 }, { x: NaN, y: 1 }, { x: 2, y: 1 }])).toBeCloseTo(1, 12);
    // Stacked pads (a via on a pad) do not make the pitch zero.
    expect(typicalPitchMm([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }])).toBeCloseTo(2, 12);
  });

  it('works for a random scatter and for a very large board with bounded work', () => {
    const rng = new Rng(501);
    const pins = Array.from({ length: 200_000 }, () => ({ x: rng.range(0, 150), y: rng.range(0, 100) }));
    expectScaling('pitch estimation pins', [12_500, 50_000, 200_000], n => { const p = pins.slice(0, n); return () => typicalPitchMm(p); });
    const pitch = typicalPitchMm(pins)!;
    // About 0.5 / sqrt(density) for a Poisson scatter: density 13.3 per mm squared.
    expect(pitch).toBeGreaterThan(0.1);
    expect(pitch).toBeLessThan(0.2);
    const far = [{ x: 0, y: 0 }, { x: 1e6, y: 1e6 }];
    expect(typicalPitchMm(far)).toBeCloseTo(Math.hypot(1e6, 1e6), 0);
  });
});

describe('checkRightFile with the right file', () => {
  for (const [count, tilt] of [[3, 0], [4, 0], [5, 0], [7, 0]] as const) {
    it(`${count} points on a photo taken straight above, clicking noise as expected: confirmed, never contradicted`, () => {
      const counts = { consistent: 0, uncertain: 0, inconsistent: 0, insufficient: 0 };
      forAll(300, 510 + count, rng => {
        const { pairs } = pick(rng, count, 3, { tilt });
        const check = checkRightFile(pairs, BOARD);
        counts[check.verdict]++;
        expect(check.model).toBe('similarity');
        expect(check.degreesOfFreedom).toBe(2 * count - 4);
        expect(check.pixelsPerMm).toBeCloseTo(30, 0);
        expect(check.pitchMm).toBeCloseTo(3, 9);
      });
      expect(counts.consistent / 300).toBeGreaterThan(0.97);
      expect(counts.inconsistent).toBe(0);
      expect(counts.insufficient).toBe(0);
    });
  }

  it('is confirmed with less clicking noise than assumed, with perfect pairs, and says what it rests on', () => {
    const rng = new Rng(520);
    const { pairs } = pick(rng, 4, 0);
    const check = checkRightFile(pairs, BOARD, { mirrored: false });
    expect(check.verdict).toBe('consistent');
    expect(check.rmsMm).toBeLessThan(1e-6);
    expect(check.probability).toBe(1);
    expect(check.agreement).toBe(1);
    expect(check.perspectiveNeeded).toBe(false);
    expect(check.registration!.model).toBe('similarity');
    expect(check.explanation).toMatch(/consistent with this board file/);
    expect(check.explanation).toMatch(/does not prove the revision/);
    expect(codes(check)).toContain('RESIDUAL');
    expect(check.evidence.find(e => e.code === 'RESIDUAL')!.effect).toBe('supports');
    expect(check.coverage).toBeGreaterThan(0.5);
    // Clicking noise on the photo (3 px at 30 px/mm), the board pick, and 0.4 % of the extent of the points for the model.
    expect(check.expectedNoiseMm).toBeCloseTo(Math.hypot(3 / 30, 0.05, 0.004 * 2 * check.registration!.quality.board.spread), 9);
  });

  it('says that 3 points are a weak check, and caps the agreement', () => {
    const { pairs } = pick(new Rng(521), 3, 1);
    const check = checkRightFile(pairs, BOARD);
    expect(check.verdict).toBe('consistent');
    expect(codes(check)).toContain('FEW_POINTS');
    expect(check.agreement).toBeLessThanOrEqual(0.85);
    expect(codes(checkRightFile(pick(new Rng(522), 4, 1).pairs, BOARD))).not.toContain('FEW_POINTS');
  });

  it('accepts a bottom side photo when it is declared, and warns of the wrong side when it is not', () => {
    let right = 0, caught = 0, runs = 0;
    forAll(200, 523, rng => {
      const { pairs } = pick(rng, rng.int(4, 6), 2, { mirrored: true });
      runs++;
      if (checkRightFile(pairs, BOARD, { mirrored: true }).verdict === 'consistent') right++;
      const wrong = checkRightFile(pairs, BOARD, { mirrored: false });
      expect(wrong.verdict).not.toBe('consistent');
      if (wrong.verdict === 'uncertain' && codes(wrong).includes('WRONG_SIDE')) caught++;
    });
    expect(right / runs).toBeGreaterThan(0.97);
    expect(caught / runs).toBeGreaterThan(0.9);
  });

  it('a photo taken at an angle is never contradicted by a flexible model, and never confirmed by one: only a rigid fit confirms', () => {
    const outcome = { consistent: 0, uncertain: 0, inconsistent: 0, perspective: 0 };
    forAll(300, 524, rng => {
      const { pairs } = pick(rng, 6, 2, { tilt: 20, distanceMm: 150 });
      const check = checkRightFile(pairs, BOARD);
      outcome[check.verdict as 'consistent' | 'uncertain' | 'inconsistent']++;
      if (check.perspectiveNeeded) {
        outcome.perspective++;
        expect(check.verdict).toBe('uncertain');
        expect(check.model).toBe('homography');
        expect(codes(check)).toContain('PERSPECTIVE');
        expect(check.agreement).toBeGreaterThanOrEqual(0.5);
        expect(check.agreement).toBeLessThanOrEqual(0.6);
      } else if (check.verdict === 'consistent') {
        expect(check.model).toBe('similarity');
      }
    });
    // Small tilts pass the rigid check (the model tolerance), large ones need the tilted camera, none is called wrong.
    expect(outcome.consistent).toBeGreaterThan(30);
    expect(outcome.perspective).toBeGreaterThan(60);
    expect(outcome.inconsistent / 300).toBeLessThan(0.03);
  });

  it('with 4 points a tilt can show as a mismatch, and the evidence says that the angle may be the reason', () => {
    let notConsistent = 0;
    forAll(100, 525, rng => {
      const check = checkRightFile(pick(rng, 4, 1, { tilt: 20, distanceMm: 120 }).pairs, BOARD);
      if (check.verdict !== 'consistent') { notConsistent++; expect(codes(check).some(c => c === 'ANGLE' || c === 'PERSPECTIVE')).toBe(true); }
      expect(check.verdict).not.toBe('insufficient');
    });
    expect(notConsistent).toBeGreaterThan(10);
  });
});

describe('checkRightFile with the wrong file', () => {
  it('does not confirm a part that sits 3 mm elsewhere than in the file: 4 points call it inconsistent, 6 points at least uncertain with the tilted-camera caution', () => {
    for (const count of [4, 6]) {
      const outcome = { inconsistent: 0, uncertain: 0, named: 0, runs: 0 };
      forAll(200, 530 + count, rng => {
        const { pairs } = pick(rng, count, 2);
        const k = rng.int(0, count - 1);
        const check = checkRightFile(moved(pairs, k, 3, 30, rng), BOARD);
        outcome.runs++;
        expect(check.verdict === 'inconsistent' || check.verdict === 'uncertain').toBe(true);
        outcome[check.verdict as 'inconsistent' | 'uncertain']++;
        expect(codes(check).some(c => c === 'ANGLE' || c === 'PERSPECTIVE')).toBe(true);
        if (check.worstIndex === k) outcome.named++;
        expect(check.evidence.find(e => e.code === 'WORST_PAIR')!.indices).toEqual([check.worstIndex]);
        expect(check.agreement).toBeLessThan(0.65);
      });
      // Four points and a part 3 mm away (4 % of the span): a clear mismatch in three of four cases, a doubtful one in the rest, never a confirmation.
      if (count === 4) expect(outcome.inconsistent / outcome.runs).toBeGreaterThan(0.6);
      // The pair named as the one that is off the most is the moved one in about 8 of 10 cases with 4 pairs and nearly always with 6 (chance: 1 in 4, 1 in 6).
      expect(outcome.named / outcome.runs).toBeGreaterThan(count === 4 ? 0.6 : 0.85);
    }
  });

  it('three points and a 3 mm shift of one of them are not accepted either', () => {
    let notConsistent = 0;
    forAll(200, 533, rng => {
      const { pairs } = pick(rng, 3, 2);
      if (checkRightFile(moved(pairs, rng.int(0, 2), 3, 30, rng), BOARD).verdict !== 'consistent') notConsistent++;
    });
    expect(notConsistent / 200).toBeGreaterThan(0.97);
  });

  it('a board of another size is caught by the scale of the photo calibration', () => {
    const { pairs } = pick(new Rng(534), 5, 2);
    const same = checkRightFile(pairs, BOARD, { calibrationPixelsPerMm: 30 });
    expect(same.verdict).toBe('consistent');
    expect(same.evidence.find(e => e.code === 'SCALE')!.effect).toBe('supports');
    const bigger = checkRightFile(pairs, BOARD, { calibrationPixelsPerMm: 30 * 1.12 });
    expect(bigger.verdict).toBe('uncertain');
    expect(bigger.evidence.find(e => e.code === 'SCALE')!.effect).toBe('against');
    expect(bigger.explanation).toMatch(/px\/mm/);
    const slightly = checkRightFile(pairs, BOARD, { calibrationPixelsPerMm: 30 * 1.07 });
    expect(slightly.verdict).toBe('consistent');
    expect(slightly.evidence.find(e => e.code === 'SCALE')!.effect).toBe('caution');
    expect(checkRightFile(pairs, BOARD, { calibrationPixelsPerMm: -1 }).evidence.some(e => e.code === 'SCALE')).toBe(false);
  });

  it('the agreement falls as one part is moved farther', () => {
    const rng = new Rng(535);
    const { pairs } = pick(rng, 4, 0);
    const shifts = [0, 0.05, 0.1, 0.2, 0.4, 1, 3];
    const agreements = shifts.map(mm => checkRightFile(moved(pairs, 2, mm, 30, new Rng(1)), BOARD).agreement);
    for (let i = 1; i < agreements.length; i++) expect(agreements[i]).toBeLessThanOrEqual(agreements[i - 1] + 1e-12);
    expect(agreements[0]).toBe(1);
    expect(agreements[agreements.length - 1]).toBeLessThan(0.05);
    const verdicts = shifts.map(mm => checkRightFile(moved(pairs, 2, mm, 30, new Rng(1)), BOARD).verdict);
    expect(verdicts[0]).toBe('consistent');
    expect(verdicts[verdicts.length - 1]).toBe('inconsistent');
  });
});

describe('what the check cannot tell', () => {
  /** Points of a rigid placement (turned by 37 degrees, board Y up, photo Y down) at a given scale, with a clicking noise of `sigmaPx`. */
  const rigid = (rng: Rng, count: number, pixelsPerMm: number, sigmaPx: number): Correspondence[] => {
    const board = wellSpreadPoints(rng, count, { minX: -30, minY: -18, maxX: 30, maxY: 18 });
    return board.map(p => ({ board: p, image: { x: 1000 + pixelsPerMm * (0.8 * p.x + 0.6 * p.y) + sigmaPx * rng.gaussian(), y: 800 + pixelsPerMm * (0.6 * p.x - 0.8 * p.y) + sigmaPx * rng.gaussian() } }));
  };

  it('a photo too coarse to tell neighbouring pads apart confirms nothing', () => {
    const rng = new Rng(540);
    // 3 px/mm and 3 px of noise is 1 mm; pads 1 mm apart.
    const pairs = rigid(rng, 5, 3, 3);
    const check = checkRightFile(pairs, { bounds: toy.bounds, pitchMm: 1 });
    expect(check.verdict).toBe('uncertain');
    expect(codes(check)).toContain('COARSE');
    expect(check.agreement).toBeLessThanOrEqual(0.6);
    // The same photo is fine for a board of 10 mm pads.
    expect(checkRightFile(pairs, { bounds: toy.bounds, pitchMm: 10 }).verdict).toBe('consistent');
  });

  it('a worst pair at half a pad pitch means parts could land on the neighbour: no confirmation', () => {
    let capped = 0, confirmed = 0, runs = 0;
    forAll(300, 541, rng => {
      // 10 px/mm and 3 px of noise is 0.3 mm per coordinate; pads 1 mm apart: the worst of 5 pairs is sometimes beyond half a pitch although the probability is fine.
      const check = checkRightFile(rigid(rng, 5, 10, 3), { bounds: toy.bounds, pitchMm: 1 });
      runs++;
      if (check.verdict === 'consistent') { confirmed++; expect(check.maxMm!).toBeLessThan(0.5); expect(codes(check)).not.toContain('PITCH'); }
      if (codes(check).includes('PITCH')) { capped++; expect(check.verdict).not.toBe('consistent'); expect(check.agreement).toBeLessThanOrEqual(0.6); }
    });
    expect(capped / runs).toBeGreaterThan(0.05);
    expect(confirmed / runs).toBeGreaterThan(0.3);
  });

  it('without a pad pitch, noise that is a tenth of the board is too coarse', () => {
    const rng = new Rng(542);
    // 3 px/mm and a stated clicking noise of 30 px: 10 mm per coordinate on a board that is 87 mm across.
    const pairs = rigid(rng, 5, 3, 3);
    const check = checkRightFile(pairs, { bounds: toy.bounds }, { noiseSigmaPx: 30 });
    expect(check.pitchMm).toBeNull();
    expect(check.verdict).toBe('uncertain');
    expect(codes(check)).toContain('COARSE');
  });

  it('notes that the points cover only a small part of the board', () => {
    const rng = new Rng(543);
    const board = wellSpreadPoints(rng, 4, { minX: -4, minY: -3, maxX: 4, maxY: 3 });
    const pairs = board.map(p => ({ board: p, image: { x: 2000 + 100 * p.x + 2 * rng.gaussian(), y: 1000 - 100 * p.y + 2 * rng.gaussian() } }));
    const check = checkRightFile(pairs, BOARD);
    expect(check.coverage!).toBeLessThan(RIGHT_FILE_THRESHOLDS.narrowCoverage);
    expect(codes(check)).toContain('COVERAGE');
    expect(checkRightFile(pick(rng, 4, 2).pairs, BOARD).evidence.some(e => e.code === 'COVERAGE')).toBe(false);
  });

  it('answers insufficient, never throws, for points that cannot be judged', () => {
    const rng = new Rng(544);
    const { pairs } = pick(rng, 4, 1);
    const none = checkRightFile([], BOARD);
    expect(none.verdict).toBe('insufficient');
    expect(none.model).toBeNull();
    expect(none.registration).toBeNull();
    expect(none.explanation).toMatch(/at least 3/);
    expect(codes(none)).toEqual(['TOO_FEW_POINTS']);
    expect(checkRightFile(pairs.slice(0, 2), BOARD).verdict).toBe('insufficient');
    expect(checkRightFile(undefined as unknown as Correspondence[], BOARD).verdict).toBe('insufficient');
    const duplicate = checkRightFile([pairs[0], pairs[1], { ...pairs[2], board: { ...pairs[0].board } }, pairs[3]], BOARD);
    expect(duplicate.verdict).toBe('insufficient');
    expect(duplicate.evidence[0].code).toBe('BAD_POINTS');
    expect(duplicate.evidence[0].indices).toEqual([0, 2]);
    const nan = checkRightFile([pairs[0], pairs[1], { ...pairs[2], image: { x: NaN, y: 1 } }], BOARD);
    expect(nan.verdict).toBe('insufficient');
    expect(nan.evidence[0].indices).toEqual([2]);
    const together = checkRightFile(pairs.map((p, i) => ({ board: p.board, image: { x: 100 + 1e-9 * i, y: 100 + 2e-9 * i * i } })), BOARD);
    expect(['insufficient', 'consistent', 'uncertain', 'inconsistent']).toContain(together.verdict);
  });

  it('judges points that lie on one line with the rigid model (which needs no spread) and rejects unusable settings', () => {
    const line = [0, 1, 2, 3].map(i => ({ board: { x: i * 10, y: 0 }, image: { x: 500 + i * 300 + 0.5 * (i % 2), y: 700 } }));
    expect(checkRightFile(line, BOARD).verdict).toBe('consistent');
    expect(() => checkRightFile(line, BOARD, { noiseSigmaPx: 0 })).toThrow(RangeError);
    expect(() => checkRightFile(line, BOARD, { boardPickMm: -1 })).toThrow(RangeError);
    expect(() => checkRightFile(line, BOARD, { noiseSigmaPx: Infinity })).toThrow(RangeError);
    const flat: Bounds2 = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    expect(checkRightFile(line, { bounds: flat }).coverage).toBeNull();
  });

  it('takes the pad pitch from the caller before the pins, and no pitch when neither is given', () => {
    const { pairs } = pick(new Rng(545), 4, 1);
    expect(checkRightFile(pairs, { bounds: toy.bounds, pins: toy.pins, pitchMm: 0.8 }).pitchMm).toBe(0.8);
    // Null means unknown: the pins are used.
    expect(checkRightFile(pairs, { bounds: toy.bounds, pins: toy.pins, pitchMm: null }).pitchMm).toBeCloseTo(3, 9);
    expect(checkRightFile(pairs, { bounds: toy.bounds, pins: toy.pins }).pitchMm).toBeCloseTo(3, 9);
    expect(checkRightFile(pairs, { bounds: toy.bounds }).pitchMm).toBeNull();
    expect(checkRightFile(pairs, { bounds: toy.bounds, pitchMm: -2 }).pitchMm).toBeNull();
  });

  it('is cheap: 12 points on a board of 120 pins with bounded work', () => {
    const { pairs } = pick(new Rng(546), 12, 2, { tilt: 10 });
    expectCostAtMost('right-file check', () => checkRightFile(pairs, BOARD), pairwiseReference(BOARD.pins), 10);
  });
});
