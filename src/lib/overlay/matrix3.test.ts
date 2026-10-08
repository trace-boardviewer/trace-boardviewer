import { expectScaling } from '../../test-support/timing';
import { describe, expect, it } from 'vitest';
import {
  IDENTITY, type Matrix3, determinant, invert, isAffine, isFiniteMatrix, jacobian, multiply, multiplyAll, normalizeAt, rotation, scaling, toCssMatrix, toCssMatrix3d, toCssMatrix3dValues,
  transform, transformPoints, translation, weight, W_MIN,
} from './matrix3';
import { Rng, forAll } from './testkit';

const applyCss3d = (v: number[], x: number, y: number) => {
  const w = v[3] * x + v[7] * y + v[15];
  return { x: (v[0] * x + v[4] * y + v[12]) / w, y: (v[1] * x + v[5] * y + v[13]) / w };
};

function randomMatrix(rng: Rng, projective: boolean): Matrix3 {
  for (;;) {
    const m: Matrix3 = [rng.range(-3, 3), rng.range(-3, 3), rng.range(-500, 500), rng.range(-3, 3), rng.range(-3, 3), rng.range(-500, 500), projective ? rng.range(-1e-3, 1e-3) : 0, projective ? rng.range(-1e-3, 1e-3) : 0, 1];
    if (Math.abs(determinant(m)) > 0.5 && invert(m)) return m;
  }
}

describe('matrix helpers', () => {
  it('multiplies like composition: the rightmost matrix is applied first', () => {
    const m = multiplyAll(translation(10, 20), rotation(Math.PI / 2), scaling(2));
    const p = transform(m, { x: 1, y: 0 })!;
    expect(p.x).toBeCloseTo(10, 12);
    expect(p.y).toBeCloseTo(22, 12);
    expect(multiply(IDENTITY, m)).toEqual(m);
    expect(multiply(m, IDENTITY)).toEqual(m);
  });

  it('round-trips random affine and projective matrices through the inverse', () => {
    forAll(300, 11, rng => {
      const m = randomMatrix(rng, rng.chance(0.5));
      const inverse = invert(m)!;
      for (let k = 0; k < 5; k++) {
        const p = { x: rng.range(-100, 100), y: rng.range(-100, 100) };
        const q = transform(m, p);
        if (!q) continue;
        const back = transform(inverse, q);
        // The inverse of a map normalized to W = 1 at some point has W of either sign elsewhere: only compare where both exist.
        if (!back) continue;
        expect(Math.hypot(back.x - p.x, back.y - p.y)).toBeLessThan(1e-6 * (1 + Math.hypot(p.x, p.y)));
      }
    });
  });

  it('refuses singular, non-finite and wrongly sized matrices', () => {
    expect(invert([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeNull();
    expect(invert([0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(invert([1, 0, 0, 0, NaN, 0, 0, 0, 1])).toBeNull();
    expect(invert([1, 0, 0, 0, Infinity, 0, 0, 0, 1])).toBeNull();
    // Nearly singular: the identity check rejects what the determinant alone would let through.
    expect(invert([1, 1, 0, 1, 1 + 1e-14, 0, 0, 0, 1])).toBeNull();
    expect(isFiniteMatrix([1, 2, 3])).toBe(false);
    expect(isFiniteMatrix(new Array(9).fill(1))).toBe(true);
    expect(isFiniteMatrix([1, 0, 0, 0, 1, 0, 0, 0, '1' as unknown as number])).toBe(false);
  });

  it('has no image where W is not positive (the horizon of a perspective map)', () => {
    const m: Matrix3 = [1, 0, 0, 0, 1, 0, 0.01, 0, 1];
    expect(transform(m, { x: 10, y: 0 })).toEqual({ x: 10 / 1.1, y: 0 });
    expect(transform(m, { x: -100, y: 0 })).toBeNull();
    expect(transform(m, { x: -200, y: 0 })).toBeNull();
    expect(weight(m, { x: -100, y: 0 })).toBe(0);
    expect(transform(m, { x: NaN, y: 0 })).toBeNull();
    expect(W_MIN).toBeGreaterThan(0);
  });

  it('transformPoints equals transform point by point, counts the points without an image and takes the affine fast path', () => {
    forAll(50, 12, rng => {
      const m = randomMatrix(rng, rng.chance(0.5));
      const count = 40;
      const input = new Float64Array(count * 2).map(() => rng.range(-2000, 2000));
      const out = new Float64Array(count * 2);
      const missing = transformPoints(m, input, out);
      let expected = 0;
      for (let i = 0; i < count; i++) {
        const p = transform(m, { x: input[2 * i], y: input[2 * i + 1] });
        if (!p) { expected++; expect(Number.isNaN(out[2 * i])).toBe(true); expect(Number.isNaN(out[2 * i + 1])).toBe(true); } else {
          expect(out[2 * i]).toBeCloseTo(p.x, 8); expect(out[2 * i + 1]).toBeCloseTo(p.y, 8);
        }
      }
      expect(missing).toBe(expected);
    });
    expect(() => transformPoints(IDENTITY, [1, 2, 3, 4], new Float64Array(2))).toThrow(RangeError);
    const half = new Float32Array(4);
    expect(transformPoints(translation(1, 2), [0, 0, 1, 1], half)).toBe(0);
    expect([...half]).toEqual([1, 2, 2, 3]);
  });

  it('normalizeAt fixes the sign and size of W at a point', () => {
    const m: Matrix3 = [-2, 0, 0, 0, -2, 0, 0, 0, -4];
    const n = normalizeAt(m, { x: 1, y: 1 })!;
    expect(weight(n, { x: 1, y: 1 })).toBeCloseTo(1, 12);
    expect(transform(n, { x: 4, y: 2 })).toEqual(transform(multiply(scaling(1), [2, 0, 0, 0, 2, 0, 0, 0, 4]), { x: 4, y: 2 }));
    expect(normalizeAt([1, 0, 0, 0, 1, 0, 1, 0, 0], { x: 0, y: 5 })).toBeNull();
  });

  it('computes the Jacobian of the point map (checked against central differences)', () => {
    forAll(100, 13, rng => {
      const m = randomMatrix(rng, true);
      const p = { x: rng.range(-50, 50), y: rng.range(-50, 50) };
      const j = jacobian(m, p);
      if (!j) return;
      const h = 1e-5;
      const fx1 = transform(m, { x: p.x + h, y: p.y }), fx0 = transform(m, { x: p.x - h, y: p.y }), fy1 = transform(m, { x: p.x, y: p.y + h }), fy0 = transform(m, { x: p.x, y: p.y - h });
      if (!fx1 || !fx0 || !fy1 || !fy0) return;
      const scale = 1 + Math.hypot(...j);
      expect(Math.abs(j[0] - (fx1.x - fx0.x) / (2 * h))).toBeLessThan(1e-5 * scale);
      expect(Math.abs(j[2] - (fx1.y - fx0.y) / (2 * h))).toBeLessThan(1e-5 * scale);
      expect(Math.abs(j[1] - (fy1.x - fy0.x) / (2 * h))).toBeLessThan(1e-5 * scale);
      expect(Math.abs(j[3] - (fy1.y - fy0.y) / (2 * h))).toBeLessThan(1e-5 * scale);
    });
    expect(jacobian([1, 0, 0, 0, 1, 0, 0.01, 0, 1], { x: -500, y: 0 })).toBeNull();
  });

  it('produces CSS matrices that act like the matrix (affine matrix(), any matrix3d())', () => {
    const affine = multiplyAll(translation(30, -12), rotation(0.4), scaling(1.7, 1.2));
    expect(isAffine(affine)).toBe(true);
    const css = toCssMatrix(affine)!;
    const [a, b, c, d, e, f] = css.match(/matrix\((.*)\)/)![1].split(',').map(Number);
    const p = transform(affine, { x: 5, y: 7 })!;
    expect(a * 5 + c * 7 + e).toBeCloseTo(p.x, 9);
    expect(b * 5 + d * 7 + f).toBeCloseTo(p.y, 9);
    expect(toCssMatrix([1, 0, 0, 0, 1, 0, 0.001, 0, 1])).toBeNull();
    forAll(60, 14, rng => {
      const m = randomMatrix(rng, true);
      const q = { x: rng.range(0, 800), y: rng.range(0, 600) };
      const expected = transform(m, q);
      if (!expected) return;
      const got = applyCss3d(toCssMatrix3dValues(m), q.x, q.y);
      expect(got.x).toBeCloseTo(expected.x, 6);
      expect(got.y).toBeCloseTo(expected.y, 6);
    });
    expect(toCssMatrix3d(IDENTITY)).toBe('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)');
    expect(toCssMatrix([NaN, 0, 0, 0, 1, 0, 0, 0, 1])).toBeNull();
  });
});

describe('matrix helpers at scale', () => {
  it('maps two million points (a 4K frame of coordinates) quickly', () => {
    const m: Matrix3 = [1.01, 0.02, 3, -0.02, 0.99, 7, 1e-6, 2e-6, 1];
    const input = new Float64Array(2 * 3840 * 2160);
    for (let y = 0, i = 0; y < 2160; y++) for (let x = 0; x < 3840; x++, i += 2) { input[i] = x + 0.5; input[i + 1] = y + 0.5; }
    const output = new Float64Array(input.length);
    expectScaling('transformed points', [input.length / 16, input.length / 4, input.length], n => { const a = input.slice(0, n), b = new Float64Array(n); return () => transformPoints(m, a, b); });
    const missing = transformPoints(m, input, output);
    expect(missing).toBe(0);
  });
});
