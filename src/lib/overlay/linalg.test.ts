import { describe, expect, it } from 'vitest';
import { solveLinear, svd } from './linalg';
import { Rng, forAll } from './testkit';

const multiplyVector = (a: Float64Array, rows: number, cols: number, x: ArrayLike<number>) => {
  const out = new Float64Array(rows);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) out[i] += a[i * cols + j] * x[j];
  return out;
};
const norm = (v: ArrayLike<number>) => Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));

describe('svd', () => {
  it('finds the singular values of a diagonal matrix, sorted, and their vectors', () => {
    const a = new Float64Array([3, 0, 0, 0, 0, -5, 0, 0, 0, 0, 1, 0]);
    const { s, v } = svd(a, 3, 4);
    expect([...s].map(x => Number(x.toFixed(12)))).toEqual([5, 3, 1, 0]);
    expect(Math.abs(v[0][1])).toBeCloseTo(1, 12);
    expect(Math.abs(v[1][0])).toBeCloseTo(1, 12);
    expect(Math.abs(v[3][3])).toBeCloseTo(1, 12);
  });

  it('satisfies A v = sigma u and A^T A v = sigma^2 v with orthonormal v, for random matrices of 4 to 80 rows', () => {
    forAll(120, 21, rng => {
      const rows = rng.int(4, 80), cols = 9;
      const a = new Float64Array(rows * cols).map(() => rng.gaussian() * 10 ** rng.range(-2, 3));
      const { s, v } = svd(a, rows, cols);
      for (let j = 0; j < cols; j++) {
        expect(norm(v[j])).toBeCloseTo(1, 10);
        if (j) expect(s[j]).toBeLessThanOrEqual(s[j - 1] * (1 + 1e-12));
        const av = multiplyVector(a, rows, cols, v[j]);
        expect(norm(av)).toBeCloseTo(s[j], 7 - Math.round(Math.log10(s[0] + 1)) + 4);
        for (let k = j + 1; k < cols; k++) expect(Math.abs(v[j].reduce((sum, x, i) => sum + x * v[k][i], 0))).toBeLessThan(1e-10);
      }
      // sum of squares of the singular values = squared Frobenius norm
      expect(Array.from(s).reduce((x, y) => x + y * y, 0)).toBeCloseTo(Array.from(a).reduce((x, y) => x + y * y, 0), 4);
    });
  });

  it('exposes a rank deficiency as a vanishing last singular value and a null vector', () => {
    forAll(60, 22, rng => {
      const rows = rng.int(10, 30), cols = 9;
      const a = new Float64Array(rows * cols).map(() => rng.gaussian());
      // make column 8 a combination of columns 0 and 3
      for (let i = 0; i < rows; i++) a[i * cols + 8] = 2 * a[i * cols] - 0.5 * a[i * cols + 3];
      const { s, v } = svd(a, rows, cols);
      expect(s[8] / s[0]).toBeLessThan(1e-12);
      expect(s[7] / s[0]).toBeGreaterThan(1e-3);
      expect(norm(multiplyVector(a, rows, cols, v[8]))).toBeLessThan(1e-9 * s[0]);
    });
  });

  it('pads a matrix with fewer rows than columns (8 equations, 9 unknowns)', () => {
    const rng = new Rng(5);
    const a = new Float64Array(8 * 9).map(() => rng.gaussian());
    const { s, v } = svd(a, 8, 9);
    expect(s.length).toBe(9);
    expect(s[8]).toBeLessThan(1e-12);
    expect(norm(multiplyVector(a, 8, 9, v[8]))).toBeLessThan(1e-12);
  });

  it('copes with zero matrices and zero columns', () => {
    const zero = svd(new Float64Array(18), 2, 9);
    expect([...zero.s].every(x => x === 0)).toBe(true);
    const a = new Float64Array(5 * 3);
    for (let i = 0; i < 5; i++) { a[i * 3] = i + 1; a[i * 3 + 2] = (i % 2) - 0.5; }
    const { s } = svd(a, 5, 3);
    expect(s[2]).toBe(0);
    expect(s[0]).toBeGreaterThan(s[1]);
  });
});

describe('solveLinear', () => {
  it('solves random well-conditioned systems', () => {
    forAll(100, 23, rng => {
      const n = rng.int(2, 8);
      const a = new Float64Array(n * n).map(() => rng.gaussian());
      for (let i = 0; i < n; i++) a[i * n + i] += 4;
      const x = Float64Array.from({ length: n }, () => rng.gaussian());
      const b = multiplyVector(a, n, n, x);
      const solved = solveLinear(Float64Array.from(a), Float64Array.from(b), n)!;
      for (let i = 0; i < n; i++) expect(solved[i]).toBeCloseTo(x[i], 8);
    });
  });

  it('needs pivoting and reports singular systems as null', () => {
    expect([...solveLinear(new Float64Array([0, 1, 1, 0]), new Float64Array([2, 3]), 2)!]).toEqual([3, 2]);
    expect(solveLinear(new Float64Array([1, 2, 2, 4]), new Float64Array([1, 2]), 2)).toBeNull();
    expect(solveLinear(new Float64Array(4), new Float64Array(2), 2)).toBeNull();
    expect(solveLinear(new Float64Array([1, 0, 0, NaN]), new Float64Array([1, 1]), 2)).toBeNull();
  });
});
