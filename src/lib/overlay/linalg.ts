/**
 * Small dense linear algebra for the alignment fits: a one-sided Jacobi SVD (Hestenes) and a pivoting solver.
 * Both are written for matrices with at most a few thousand rows and about ten columns.
 */

export interface Svd {
  /** Singular values, descending (always `cols` of them; a matrix with fewer rows than columns is padded with zero rows, which adds zero singular values). */
  readonly s: Float64Array;
  /** `v[j]` is the right singular vector of `s[j]` (unit length). The last one is the null vector of a rank-deficient system. */
  readonly v: readonly Float64Array[];
}

/**
 * SVD of the row-major `rows` x `cols` matrix `a` by one-sided Jacobi rotations of its columns. The rotations are applied until every
 * pair of columns is orthogonal to working precision (at most 60 sweeps; for 9 columns it takes 5 to 10). Unlike the eigen decomposition
 * of A^T A it does not square the condition number, which matters for the small singular values that tell a degenerate point set.
 */
export function svd(a: ArrayLike<number>, rows: number, cols: number): Svd {
  const height = Math.max(rows, cols);
  const u: Float64Array[] = Array.from({ length: cols }, () => new Float64Array(height));
  const v: Float64Array[] = Array.from({ length: cols }, (_, j) => { const column = new Float64Array(cols); column[j] = 1; return column; });
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) u[j][i] = a[i * cols + j];
  for (let sweep = 0; sweep < 60; sweep++) {
    let rotated = false;
    for (let p = 0; p < cols - 1; p++) for (let q = p + 1; q < cols; q++) {
      const up = u[p], uq = u[q];
      let alpha = 0, beta = 0, gamma = 0;
      for (let i = 0; i < height; i++) { alpha += up[i] * up[i]; beta += uq[i] * uq[i]; gamma += up[i] * uq[i]; }
      if (gamma === 0 || Math.abs(gamma) <= 1e-15 * Math.sqrt(alpha * beta)) continue;
      rotated = true;
      const zeta = (beta - alpha) / (2 * gamma);
      const t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
      const c = 1 / Math.sqrt(1 + t * t), s = c * t;
      for (let i = 0; i < height; i++) { const x = up[i], y = uq[i]; up[i] = c * x - s * y; uq[i] = s * x + c * y; }
      const vp = v[p], vq = v[q];
      for (let i = 0; i < cols; i++) { const x = vp[i], y = vq[i]; vp[i] = c * x - s * y; vq[i] = s * x + c * y; }
    }
    if (!rotated) break;
  }
  const norms = u.map(column => { let sum = 0; for (let i = 0; i < height; i++) sum += column[i] * column[i]; return Math.sqrt(sum); });
  const order = norms.map((_, j) => j).sort((x, y) => norms[y] - norms[x]);
  return { s: Float64Array.from(order, j => norms[j]), v: order.map(j => v[j]) };
}

/**
 * Solves the n x n system `a x = b` (row-major `a`, destroyed) by Gaussian elimination with partial pivoting.
 * Returns null when a pivot is below `1e-13` of the largest entry (singular or numerically rank-deficient).
 */
export function solveLinear(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
  let scale = 0;
  for (let i = 0; i < n * n; i++) scale = Math.max(scale, Math.abs(a[i]));
  if (!(scale > 0)) return null;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row * n + col]) > Math.abs(a[pivot * n + col])) pivot = row;
    if (!(Math.abs(a[pivot * n + col]) > 1e-13 * scale)) return null;
    if (pivot !== col) {
      for (let k = 0; k < n; k++) { const t = a[col * n + k]; a[col * n + k] = a[pivot * n + k]; a[pivot * n + k] = t; }
      const t = b[col]; b[col] = b[pivot]; b[pivot] = t;
    }
    for (let row = col + 1; row < n; row++) {
      const factor = a[row * n + col] / a[col * n + col];
      if (factor === 0) continue;
      for (let k = col; k < n; k++) a[row * n + k] -= factor * a[col * n + k];
      b[row] -= factor * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row];
    for (let k = row + 1; k < n; k++) sum -= a[row * n + k] * x[k];
    x[row] = sum / a[row * n + row];
  }
  return x.every(Number.isFinite) ? x : null;
}
