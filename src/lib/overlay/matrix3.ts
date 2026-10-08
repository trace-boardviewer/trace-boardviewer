import type { Point2 } from '../geometry';

/**
 * 3x3 homogeneous matrices for the plane, row-major: [m0 m1 m2 / m3 m4 m5 / m6 m7 m8] maps (x, y, 1) to (X, Y, W) and the point is
 * (X / W, Y / W). Affine maps have the last row (0, 0, 1).
 *
 * Convention used throughout src/lib/overlay: a matrix is normalized so that W is POSITIVE over the region it is meant for (the
 * registration code scales it that way at fit time). `transform` returns null where W is not safely positive, which for a photo
 * is the part of the board plane that lies behind the camera or on the horizon: such a point has no image.
 */
export type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Matrix3 = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]) as unknown as Matrix3;
/** A point whose W is not above this has no image (it is at or beyond the horizon of a perspective map). */
export const W_MIN = 1e-12;

export const translation = (tx: number, ty: number): Matrix3 => [1, 0, tx, 0, 1, ty, 0, 0, 1];
export const scaling = (sx: number, sy: number = sx): Matrix3 => [sx, 0, 0, 0, sy, 0, 0, 0, 1];
/** Counter-clockwise for a y-up frame, clockwise on a y-down screen: (x, y) -> (x c - y s, x s + y c). */
export const rotation = (radians: number): Matrix3 => { const c = Math.cos(radians), s = Math.sin(radians); return [c, -s, 0, s, c, 0, 0, 0, 1]; };

export function multiply(a: Matrix3, b: Matrix3): Matrix3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

/** `multiplyAll(a, b, c)` is a * b * c: the rightmost matrix is applied to a point first. */
export function multiplyAll(first: Matrix3, ...rest: Matrix3[]): Matrix3 {
  let result = first;
  for (const m of rest) result = multiply(result, m);
  return result;
}

export const determinant = (m: Matrix3): number =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

export const isFiniteMatrix = (m: ArrayLike<number>): boolean => {
  if (!m || m.length !== 9) return false;
  for (let i = 0; i < 9; i++) if (typeof m[i] !== 'number' || !Number.isFinite(m[i])) return false;
  return true;
};

/** True when the last row is (0, 0, w): the map has no perspective part. */
export const isAffine = (m: Matrix3, tolerance = 1e-12): boolean => Math.abs(m[6]) <= tolerance * (Math.abs(m[0]) + Math.abs(m[1]) + 1) && Math.abs(m[7]) <= tolerance * (Math.abs(m[3]) + Math.abs(m[4]) + 1);

/**
 * Inverse by the adjugate, or null when the matrix is not finite, singular, so ill-conditioned that max|M| * max|M^-1| exceeds 1e13 (a map that would
 * send everything to the far end of the plane) or M * M^-1 is not the identity to 1e-8.
 */
export function invert(m: Matrix3): Matrix3 | null {
  if (!isFiniteMatrix(m)) return null;
  const c00 = m[4] * m[8] - m[5] * m[7], c01 = m[5] * m[6] - m[3] * m[8], c02 = m[3] * m[7] - m[4] * m[6];
  const det = m[0] * c00 + m[1] * c01 + m[2] * c02;
  if (!Number.isFinite(det) || det === 0) return null;
  const inverse: Matrix3 = [
    c00 / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
    c01 / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
    c02 / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det,
  ];
  if (!isFiniteMatrix(inverse)) return null;
  let maxM = 0, maxInverse = 0;
  for (let i = 0; i < 9; i++) { maxM = Math.max(maxM, Math.abs(m[i])); maxInverse = Math.max(maxInverse, Math.abs(inverse[i])); }
  if (!(maxM * maxInverse <= 1e13)) return null;
  const check = multiply(m, inverse);
  const identity = IDENTITY;
  for (let i = 0; i < 9; i++) if (!(Math.abs(check[i] - identity[i]) <= 1e-8)) return null;
  return inverse;
}

/** Applies the map to a point; null when W is not above W_MIN or the result is not finite. */
export function transform(m: Matrix3, p: Point2): Point2 | null {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  if (!(w > W_MIN)) return null;
  const x = (m[0] * p.x + m[1] * p.y + m[2]) / w, y = (m[3] * p.x + m[4] * p.y + m[5]) / w;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** W of a point under the map (the denominator of the perspective division). */
export const weight = (m: Matrix3, p: Point2): number => m[6] * p.x + m[7] * p.y + m[8];

/**
 * Maps interleaved (x, y) pairs from `input` into `output` (same layout, at least as long). A point without an image becomes
 * (NaN, NaN). Returns how many points had none. Affine maps take a division-free fast path; this is the call for whole grids.
 */
export function transformPoints(m: Matrix3, input: ArrayLike<number>, output: Float64Array | Float32Array): number {
  const count = Math.floor(input.length / 2);
  if (output.length < count * 2) throw new RangeError('The output array is shorter than the input.');
  let missing = 0;
  if (m[6] === 0 && m[7] === 0 && m[8] > W_MIN) {
    const k = 1 / m[8];
    for (let i = 0; i < count; i++) {
      const x = input[2 * i], y = input[2 * i + 1];
      const px = (m[0] * x + m[1] * y + m[2]) * k, py = (m[3] * x + m[4] * y + m[5]) * k;
      if (Number.isFinite(px) && Number.isFinite(py)) { output[2 * i] = px; output[2 * i + 1] = py; } else { output[2 * i] = NaN; output[2 * i + 1] = NaN; missing++; }
    }
    return missing;
  }
  for (let i = 0; i < count; i++) {
    const x = input[2 * i], y = input[2 * i + 1];
    const w = m[6] * x + m[7] * y + m[8];
    const px = (m[0] * x + m[1] * y + m[2]) / w, py = (m[3] * x + m[4] * y + m[5]) / w;
    if (w > W_MIN && Number.isFinite(px) && Number.isFinite(py)) { output[2 * i] = px; output[2 * i + 1] = py; } else { output[2 * i] = NaN; output[2 * i + 1] = NaN; missing++; }
  }
  return missing;
}

/** Scales the matrix so that W is 1 at `p` (fixing its sign and size); null when W at `p` is not positive after the sign choice, i.e. it is zero. */
export function normalizeAt(m: Matrix3, p: Point2): Matrix3 | null {
  const w = weight(m, p);
  if (!Number.isFinite(w) || Math.abs(w) <= W_MIN) return null;
  const k = 1 / w;
  const result: Matrix3 = [m[0] * k, m[1] * k, m[2] * k, m[3] * k, m[4] * k, m[5] * k, m[6] * k, m[7] * k, m[8] * k];
  return isFiniteMatrix(result) ? result : null;
}

/** The 2x2 Jacobian [a b / c d] of the point map at `p` (row-major), or null where the point has no image. */
export function jacobian(m: Matrix3, p: Point2): readonly [number, number, number, number] | null {
  const w = weight(m, p);
  if (!(w > W_MIN)) return null;
  const x = m[0] * p.x + m[1] * p.y + m[2], y = m[3] * p.x + m[4] * p.y + m[5];
  const w2 = w * w;
  const result = [(m[0] * w - x * m[6]) / w2, (m[1] * w - x * m[7]) / w2, (m[3] * w - y * m[6]) / w2, (m[4] * w - y * m[7]) / w2] as const;
  return result.every(Number.isFinite) ? result : null;
}

/** CSS `matrix(a, b, c, d, e, f)` for an affine map (CSS applies it to the element's pixels with `transform-origin: 0 0`); null when the map has perspective. */
export function toCssMatrix(m: Matrix3): string | null {
  if (!isAffine(m) || !isFiniteMatrix(m)) return null;
  const k = 1 / m[8];
  return `matrix(${num(m[0] * k)}, ${num(m[3] * k)}, ${num(m[1] * k)}, ${num(m[4] * k)}, ${num(m[2] * k)}, ${num(m[5] * k)})`;
}

/** The 16 values of CSS `matrix3d(...)` (column-major) for any plane map: the element's z is untouched. */
export function toCssMatrix3dValues(m: Matrix3): number[] {
  return [m[0], m[3], 0, m[6], m[1], m[4], 0, m[7], 0, 0, 1, 0, m[2], m[5], 0, m[8]];
}
export const toCssMatrix3d = (m: Matrix3): string => `matrix3d(${toCssMatrix3dValues(m).map(num).join(', ')})`;
const num = (value: number) => (Number.isFinite(value) ? String(Number(value.toPrecision(12))) : '0');
