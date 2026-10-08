import type { Point2 } from '../geometry';
import { RegistrationError } from './errors';
import { solveLinear, svd } from './linalg';
import { type Matrix3, invert, isFiniteMatrix, multiplyAll, normalizeAt, weight } from './matrix3';

/**
 * Plane-to-plane fits from point pairs, in whatever coordinates the caller uses (the board registration orients the board points first).
 *
 *  - similarity: uniform scale, rotation and translation (4 numbers, 2 pairs). Closed-form complex least squares on the centred points.
 *  - affine: any linear map and translation (6 numbers, 3 pairs). Least squares on the centred points.
 *  - homography: the projective map of a flat photo (8 numbers, 4 pairs). Normalized DLT (Hartley): both sets are moved to their centroid
 *    and scaled to a mean distance of sqrt(2), the 2n x 9 system is solved by SVD, and with more than 4 pairs the algebraic solution is
 *    polished by Levenberg-Marquardt on the reprojection error (never accepted if it does not lower it).
 *
 * Every fit minimizes error in the DESTINATION (the photo), which is where the clicking noise is: board points are picked on pad centres,
 * photo points are picked by eye. Degenerate input is a RegistrationError, never a matrix of garbage.
 */
export type FitModel = 'similarity' | 'affine' | 'homography';
export const MODEL_MIN_POINTS: Readonly<Record<FitModel, number>> = Object.freeze({ similarity: 2, affine: 3, homography: 4 });
/** Free numbers of each model: the residual has 2n - this many degrees of freedom. */
export const MODEL_PARAMETERS: Readonly<Record<FitModel, number>> = Object.freeze({ similarity: 4, affine: 6, homography: 8 });
export const MAX_POINTS = 1000;
/** thinRatio below this on either side is a COLLINEAR error for affine and projective fits. */
export const MIN_THIN_RATIO = 0.02;
/** thinRatio below this is a warning ("nearly in a line, add a point away from it"). */
export const WARN_THIN_RATIO = 0.1;

export interface FitOptions {
  /** Polish a projective fit of 5 or more pairs by Levenberg-Marquardt (default true). */
  refine?: boolean;
  /** Override MIN_THIN_RATIO. */
  minThinRatio?: number;
}

export interface PointSetQuality {
  readonly count: number;
  readonly centroid: Point2;
  /** Root-mean-square distance of the points from their centroid, in the units of the points. */
  readonly spread: number;
  /** sqrt(lambda2 / lambda1) of the covariance: 0 when the points lie on a line, 1 for an isotropic cloud. */
  readonly thinRatio: number;
  /**
   * With up to 12 points: the smallest height-over-baseline of any triple (the distance of the third point from the line through the other two,
   * divided by the longest side; 0 when three are collinear) and which triple it is. Null for more points.
   */
  readonly minTriangle: { readonly quality: number; readonly indices: readonly [number, number, number] } | null;
}

export function pointSetQuality(points: readonly Point2[]): PointSetQuality {
  const n = points.length;
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  if (n) { cx /= n; cy /= n; }
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) { const dx = p.x - cx, dy = p.y - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  if (n) { sxx /= n; sxy /= n; syy /= n; }
  const mean = (sxx + syy) / 2, radius = Math.hypot((sxx - syy) / 2, sxy);
  const l1 = mean + radius, l2 = Math.max(0, mean - radius);
  const thinRatio = l1 > 0 ? Math.sqrt(l2 / l1) : 0;
  let minTriangle: PointSetQuality['minTriangle'] = null;
  if (n >= 3 && n <= 12) {
    let best = Infinity, at: [number, number, number] = [0, 1, 2];
    for (let i = 0; i < n - 2; i++) for (let j = i + 1; j < n - 1; j++) for (let k = j + 1; k < n; k++) {
      const a = points[i], b = points[j], c = points[k];
      const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
      const longest = Math.max((b.x - a.x) ** 2 + (b.y - a.y) ** 2, (c.x - a.x) ** 2 + (c.y - a.y) ** 2, (c.x - b.x) ** 2 + (c.y - b.y) ** 2);
      const quality = longest > 0 ? cross / longest : 0;
      if (quality < best) { best = quality; at = [i, j, k]; }
    }
    minTriangle = { quality: best, indices: at };
  }
  return { count: n, centroid: { x: cx, y: cy }, spread: Math.sqrt(sxx + syy), thinRatio, minTriangle };
}

const SIDE_NAME = { board: 'board', image: 'photo' } as const;
const MODEL_NAME: Record<FitModel, string> = { similarity: 'similarity', affine: 'affine', homography: 'projective' };

/** Validates the pairs of one fit; every failure is a RegistrationError naming the offending points. */
function checkPairs(src: readonly Point2[], dst: readonly Point2[], model: FitModel, minThin: number, sides: { src: 'board' | 'image'; dst: 'board' | 'image' }): void {
  if (src.length !== dst.length) throw new RangeError('The two point lists differ in length.');
  const n = src.length, needed = MODEL_MIN_POINTS[model];
  if (n < needed) throw new RegistrationError('TOO_FEW_POINTS', `A ${MODEL_NAME[model]} alignment needs ${needed} point pairs; ${n} given.`, { model, needed, given: n });
  if (n > MAX_POINTS) throw new RegistrationError('TOO_MANY_POINTS', `At most ${MAX_POINTS} point pairs are supported; ${n} given.`, { model, given: n });
  for (const [list, side] of [[src, sides.src], [dst, sides.dst]] as const) {
    for (let i = 0; i < n; i++) {
      const p = list[i];
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        throw new RegistrationError('INVALID_POINT', `Point ${i + 1} on the ${SIDE_NAME[side]} has no finite coordinates.`, { indices: [i], side, model });
      }
    }
  }
  for (const [list, side] of [[src, sides.src], [dst, sides.dst]] as const) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of list) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const tolerance = 1e-9 * Math.hypot(maxX - minX, maxY - minY);
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
      if (Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y) <= tolerance) {
        throw new RegistrationError('DUPLICATE_POINTS', `Points ${i + 1} and ${j + 1} are at the same place on the ${SIDE_NAME[side]}.`, { indices: [i, j], side, model });
      }
    }
  }
  if (model === 'similarity') return;
  for (const [list, side] of [[src, sides.src], [dst, sides.dst]] as const) {
    const quality = pointSetQuality(list);
    if (quality.thinRatio < minThin) {
      throw new RegistrationError('COLLINEAR', `The ${SIDE_NAME[side]} points lie on one line (${(quality.thinRatio * 100).toFixed(2)} % across it); a ${MODEL_NAME[model]} alignment needs points spread over an area.`, { side, model });
    }
    if (model === 'homography' && quality.minTriangle && n === 4 && quality.minTriangle.quality < minThin) {
      const indices = quality.minTriangle.indices;
      throw new RegistrationError('COLLINEAR', `Points ${indices.map(i => i + 1).join(', ')} are on one line on the ${SIDE_NAME[side]}; a projective alignment of 4 pairs needs no three in a line.`, { indices, side, model });
    }
  }
}

/** Hartley normalization: translation to the centroid, scale to a mean distance of sqrt(2). */
function normalization(points: readonly Point2[]): { matrix: Matrix3; inverse: Matrix3 } {
  const n = points.length;
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  let mean = 0;
  for (const p of points) mean += Math.hypot(p.x - cx, p.y - cy);
  mean /= n;
  const s = Math.SQRT2 / mean;
  return { matrix: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], inverse: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1] };
}

function fitSimilarity(src: readonly Point2[], dst: readonly Point2[]): Matrix3 {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i].x; sy += src[i].y; dx += dst[i].x; dy += dst[i].y; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let norm = 0, re = 0, im = 0;
  for (let i = 0; i < n; i++) {
    const zx = src[i].x - sx, zy = src[i].y - sy, wx = dst[i].x - dx, wy = dst[i].y - dy;
    norm += zx * zx + zy * zy; re += zx * wx + zy * wy; im += zx * wy - zy * wx;
  }
  const a = re / norm, b = im / norm;
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.hypot(a, b) === 0) throw new RegistrationError('SINGULAR', 'The photo points coincide, so no scale can be found.', { side: 'image', model: 'similarity' });
  return [a, -b, dx - (a * sx - b * sy), b, a, dy - (b * sx + a * sy), 0, 0, 1];
}

function fitAffine(src: readonly Point2[], dst: readonly Point2[]): Matrix3 {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i].x; sy += src[i].y; dx += dst[i].x; dy += dst[i].y; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let mxx = 0, mxy = 0, myy = 0, cxx = 0, cxy = 0, cyx = 0, cyy = 0;
  for (let i = 0; i < n; i++) {
    const zx = src[i].x - sx, zy = src[i].y - sy, wx = dst[i].x - dx, wy = dst[i].y - dy;
    mxx += zx * zx; mxy += zx * zy; myy += zy * zy;
    cxx += wx * zx; cxy += wx * zy; cyx += wy * zx; cyy += wy * zy;
  }
  const det = mxx * myy - mxy * mxy;
  if (!(det > 0)) throw new RegistrationError('COLLINEAR', 'The board points lie on one line; an affine alignment needs points spread over an area.', { side: 'board', model: 'affine' });
  // [a b] = [cxx cxy] M^-1 and [c d] = [cyx cyy] M^-1 with M = [mxx mxy / mxy myy].
  const a = (cxx * myy - cxy * mxy) / det, b = (cxy * mxx - cxx * mxy) / det;
  const c = (cyx * myy - cyy * mxy) / det, d = (cyy * mxx - cyx * mxy) / det;
  const linearDet = a * d - b * c, norm = a * a + b * b + c * c + d * d;
  if (!Number.isFinite(linearDet) || !(Math.abs(linearDet) > 1e-9 * norm)) throw new RegistrationError('COLLINEAR', 'The photo points lie on one line, so the map is not invertible.', { side: 'image', model: 'affine' });
  return [a, b, dx - (a * sx + b * sy), c, d, dy - (c * sx + d * sy), 0, 0, 1];
}

/** Reprojection cost of the normalized homography `p` (h22 = 1); Infinity if any point leaves the half-plane W > 0. */
function homographyCost(p: ArrayLike<number>, src: readonly Point2[], dst: readonly Point2[]): number {
  let cost = 0;
  for (let i = 0; i < src.length; i++) {
    const { x, y } = src[i];
    const w = p[6] * x + p[7] * y + 1;
    if (!(w > 1e-6)) return Infinity;
    const ex = (p[0] * x + p[1] * y + p[2]) / w - dst[i].x, ey = (p[3] * x + p[4] * y + p[5]) / w - dst[i].y;
    cost += ex * ex + ey * ey;
  }
  return cost;
}

/** Levenberg-Marquardt on the 8 free numbers of a homography with h22 fixed at 1, in normalized coordinates. Returns the improved numbers or the input. */
function refineHomography(start: ArrayLike<number>, src: readonly Point2[], dst: readonly Point2[]): Float64Array {
  let p = Float64Array.from(start);
  let cost = homographyCost(p, src, dst);
  if (!Number.isFinite(cost) || cost === 0) return p;
  let lambda = 1e-3;
  const n = src.length;
  for (let iteration = 0; iteration < 60; iteration++) {
    const jtj = new Float64Array(64), jte = new Float64Array(8);
    for (let i = 0; i < n; i++) {
      const { x, y } = src[i];
      const w = p[6] * x + p[7] * y + 1;
      const px = (p[0] * x + p[1] * y + p[2]) / w, py = (p[3] * x + p[4] * y + p[5]) / w;
      const rx = px - dst[i].x, ry = py - dst[i].y;
      const jx = [x / w, y / w, 1 / w, 0, 0, 0, -x * px / w, -y * px / w];
      const jy = [0, 0, 0, x / w, y / w, 1 / w, -x * py / w, -y * py / w];
      for (let a = 0; a < 8; a++) {
        jte[a] += jx[a] * rx + jy[a] * ry;
        for (let b = 0; b < 8; b++) jtj[a * 8 + b] += jx[a] * jx[b] + jy[a] * jy[b];
      }
    }
    let improved = false;
    for (let attempt = 0; attempt < 12 && !improved; attempt++) {
      const damped = Float64Array.from(jtj);
      for (let a = 0; a < 8; a++) damped[a * 9] += lambda * (jtj[a * 9] + 1e-12);
      const step = solveLinear(damped, Float64Array.from(jte, v => -v), 8);
      if (step) {
        const next = Float64Array.from(p, (v, a) => v + step[a]);
        const nextCost = homographyCost(next, src, dst);
        if (nextCost < cost) {
          const gain = cost - nextCost;
          p = next; cost = nextCost; lambda = Math.max(lambda / 10, 1e-12); improved = true;
          if (gain <= 1e-15 * (cost + 1e-300)) return p;
        }
      }
      if (!improved) lambda *= 10;
    }
    if (!improved) break;
  }
  return p;
}

function fitHomography(src: readonly Point2[], dst: readonly Point2[], refine: boolean): Matrix3 {
  const n = src.length;
  const ns = normalization(src), nd = normalization(dst);
  const a = new Float64Array(2 * n * 9);
  const sourceN: Point2[] = [], targetN: Point2[] = [];
  for (let i = 0; i < n; i++) {
    const x = ns.matrix[0] * src[i].x + ns.matrix[2], y = ns.matrix[4] * src[i].y + ns.matrix[5];
    const u = nd.matrix[0] * dst[i].x + nd.matrix[2], v = nd.matrix[4] * dst[i].y + nd.matrix[5];
    sourceN.push({ x, y }); targetN.push({ x: u, y: v });
    a.set([-x, -y, -1, 0, 0, 0, u * x, u * y, u], 2 * i * 9);
    a.set([0, 0, 0, -x, -y, -1, v * x, v * y, v], (2 * i + 1) * 9);
  }
  const { s, v } = svd(a, 2 * n, 9);
  // 8 independent equations determine h up to scale: the 8th singular value must be clearly above zero.
  if (!(s[7] > 1e-7 * s[0])) throw new RegistrationError('DEGENERATE', 'These points do not determine a projective alignment (three of them are nearly in a line on the board or on the photo).', { model: 'homography' });
  let h = Float64Array.from(v[8]);
  if (refine && n > 4 && Math.abs(h[8]) > 1e-9 * Math.hypot(...h)) {
    const k = 1 / h[8];
    h = Float64Array.from(refineHomography(Float64Array.from(h.subarray(0, 8), value => value * k), sourceN, targetN));
    h = Float64Array.from([...h, 1]);
  }
  const normalized: Matrix3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8]];
  const result = multiplyAll(nd.inverse, normalized, ns.matrix);
  return result;
}

/**
 * Fits `model` so that `transform(matrix, src[i]) ~ dst[i]`. The matrix is scaled so that W is 1 at the centroid of `src`. Throws RegistrationError.
 * `sides` names what each list is in error messages (default: src is the board, dst is the photo).
 */
export function fitTransform(src: readonly Point2[], dst: readonly Point2[], model: FitModel, options: FitOptions & { sides?: { src: 'board' | 'image'; dst: 'board' | 'image' } } = {}): Matrix3 {
  const sides = options.sides ?? { src: 'board' as const, dst: 'image' as const };
  checkPairs(src, dst, model, options.minThinRatio ?? MIN_THIN_RATIO, sides);
  const raw = model === 'similarity' ? fitSimilarity(src, dst) : model === 'affine' ? fitAffine(src, dst) : fitHomography(src, dst, options.refine !== false);
  if (!isFiniteMatrix(raw)) throw new RegistrationError('DEGENERATE', 'The alignment could not be computed from these points.', { model });
  const centroid = pointSetQuality(src).centroid;
  const matrix = normalizeAt(raw, centroid);
  if (!matrix || !(weight(matrix, centroid) > 0)) throw new RegistrationError('DEGENERATE', 'The alignment could not be computed from these points.', { model });
  if (!invert(matrix)) throw new RegistrationError('SINGULAR', 'The alignment found from these points is not invertible.', { model });
  return matrix;
}

/** A 2x2 symmetric block [a b / b d] of the hat matrix: how strongly the observation of one pair pulls the fit toward itself. */
export interface LeverageBlock { readonly a: number; readonly b: number; readonly d: number }

/**
 * Leverage of every pair under a fitted model: the 2x2 diagonal blocks of the hat matrix H = J (J^T J)^-1 J^T of the linearized fit (J is the
 * Jacobian of the predicted photo points with respect to the model's numbers, in Hartley-normalized coordinates, where the answer is the same as in
 * any other frame). 2n - trace(H) is the residual's degrees of freedom; a block near the identity means the pair alone fixes the fit. Used
 * to turn a leave-one-out error into a multiple of the click noise. Null when J^T J is singular.
 */
export function leverageBlocks(model: FitModel, src: readonly Point2[], dst: readonly Point2[], solved: Matrix3): LeverageBlock[] | null {
  const n = src.length, p = MODEL_PARAMETERS[model];
  const ns = normalization(src), nd = normalization(dst);
  const pts = src.map(q => ({ x: ns.matrix[0] * q.x + ns.matrix[2], y: ns.matrix[4] * q.y + ns.matrix[5] }));
  let h: Matrix3 | null = null;
  if (model === 'homography') {
    const hh = multiplyAll(nd.matrix, solved, ns.inverse);
    if (!(Math.abs(hh[8]) > 1e-12)) return null;
    h = [hh[0] / hh[8], hh[1] / hh[8], hh[2] / hh[8], hh[3] / hh[8], hh[4] / hh[8], hh[5] / hh[8], hh[6] / hh[8], hh[7] / hh[8], 1];
  }
  const jacobian = new Float64Array(2 * n * p);
  for (let i = 0; i < n; i++) {
    const { x, y } = pts[i];
    const rowX = jacobian.subarray(2 * i * p, (2 * i + 1) * p), rowY = jacobian.subarray((2 * i + 1) * p, (2 * i + 2) * p);
    if (model === 'similarity') { rowX.set([x, -y, 1, 0]); rowY.set([y, x, 0, 1]); }
    else if (model === 'affine') { rowX.set([x, y, 1, 0, 0, 0]); rowY.set([0, 0, 0, x, y, 1]); }
    else if (h) {
      const w = h[6] * x + h[7] * y + 1;
      if (!(w > 1e-9)) return null;
      const px = (h[0] * x + h[1] * y + h[2]) / w, py = (h[3] * x + h[4] * y + h[5]) / w;
      rowX.set([x / w, y / w, 1 / w, 0, 0, 0, -x * px / w, -y * px / w]);
      rowY.set([0, 0, 0, x / w, y / w, 1 / w, -x * py / w, -y * py / w]);
    }
  }
  const jtj = new Float64Array(p * p);
  for (let r = 0; r < 2 * n; r++) for (let a = 0; a < p; a++) { const ja = jacobian[r * p + a]; if (ja !== 0) for (let b = 0; b < p; b++) jtj[a * p + b] += ja * jacobian[r * p + b]; }
  const inverse = new Float64Array(p * p);
  for (let column = 0; column < p; column++) {
    const rhs = new Float64Array(p); rhs[column] = 1;
    const solution = solveLinear(Float64Array.from(jtj), rhs, p);
    if (!solution) return null;
    for (let row = 0; row < p; row++) inverse[row * p + column] = solution[row];
  }
  const blocks: LeverageBlock[] = [];
  for (let i = 0; i < n; i++) {
    const rx = jacobian.subarray(2 * i * p, (2 * i + 1) * p), ry = jacobian.subarray((2 * i + 1) * p, (2 * i + 2) * p);
    let a = 0, b = 0, d = 0;
    for (let k = 0; k < p; k++) for (let l = 0; l < p; l++) { const g = inverse[k * p + l]; a += rx[k] * g * rx[l]; b += rx[k] * g * ry[l]; d += ry[k] * g * ry[l]; }
    blocks.push({ a, b, d });
  }
  return blocks;
}
