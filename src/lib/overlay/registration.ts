import type { Bounds2, Point2 } from '../geometry';
import { RegistrationError } from './errors';
import { type FitModel, type LeverageBlock, MAX_POINTS, MIN_THIN_RATIO, MODEL_MIN_POINTS, MODEL_PARAMETERS, WARN_THIN_RATIO, fitTransform, leverageBlocks, pointSetQuality, type PointSetQuality } from './fit';
import { type Matrix3, invert, isFiniteMatrix, jacobian, multiply, normalizeAt, transform, transformPoints, weight } from './matrix3';

/**
 * Registration of a photo, microscope image or thermal image with the boardview: the map between BOARD coordinates (canonical millimetres,
 * Y up, the numbers of Board and of the board camera) and IMAGE coordinates (source pixels of the photo, x right, y down, (0, 0) the top-left
 * corner of the top-left pixel: the numbers the image viewer reports, never display-rotated ones).
 *
 * The user matches 2 to 4 (or more) points: a pad or part corner on the board and the same place on the photo. From those pairs:
 *
 *  - 2 pairs: similarity (scale, rotation, shift), 3 pairs: affine, 4 or more: projective (the homography of a flat board seen by a camera).
 *    A model can be chosen explicitly; `degreesOfFreedom` (2n minus the model's numbers) says whether the residuals mean anything:
 *    0 is an exact fit and its residuals are zero by construction, so the UI should ask for one more pair before it shows an error figure.
 *  - A photo of the bottom side is a mirror image of the canonical board. `mirrored` flips the board's X BEFORE the fit (as the boardview's
 *    mirrored bottom view does), so the fitted map is always orientation-preserving and a wrong side shows up as a reversed handedness or
 *    a better fit of the opposite hypothesis (`orientation.suspectMirrored`) instead of silently fitting a mirror.
 *  - Residuals are reported per point in BOARD millimetres (the photo point mapped back onto the board, minus the board point) and in
 *    image pixels, with the RMS and maximum. They are what the UI shows as "alignment error".
 *  - With at least one pair beyond what the model needs, a leave-one-out refit (up to 40 pairs) reports for every pair where the others put it. A pair is
 *    NAMED as the likely mistake only with 6 or more degrees of freedom (5 pairs of a similarity, 6 of an affine map, 7 of a projective map): below that a bad
 *    pair drags the fit so far that the wrong one is named as often as the right one. Without a named pair a POOR_FIT warning says that the pairs disagree.
 */
export type RegistrationModel = FitModel;

/** One matched pair: a place on the board (mm) and the same place on the photo (px). `label` is free text ("U7 pin 3") for messages. */
export interface Correspondence { board: Point2; image: Point2; label?: string }

export interface PointResidual {
  readonly index: number;
  /** Board millimetres between the board point and the photo point mapped back to the board. Infinity when it cannot be mapped. */
  readonly board: number;
  /** Mapped-back photo point minus the board point, board millimetres. */
  readonly dx: number;
  readonly dy: number;
  /** Image pixels between the photo point and the board point mapped to the photo. */
  readonly image: number;
  /** Board millimetres between this board point and where a fit WITHOUT this pair puts it; null when the fit has no spare pair or the refit was degenerate. */
  readonly leaveOneOut: number | null;
}

export interface OutlierHint {
  /** Zero-based index of the pair that is probably wrong. */
  readonly index: number;
  /** Where the fit without it puts it, board millimetres. */
  readonly leaveOneOut: number;
  /** The same in photo pixels. */
  readonly leaveOneOutPx: number;
  /**
   * The leave-one-out error as a multiple of the click noise: sqrt(e' (I - H) e) / sigma, where e is the error vector in photo pixels, H the pair's
   * leverage block and sigma the larger of the expected click noise and the noise the other pairs show (about 1.4 for a pure click error, so 5 or more is a mistake).
   */
  readonly score: number;
  /** The noise level (photo pixels per coordinate) the score is measured against. */
  readonly sigmaPx: number;
  /** RMS board residual of the other pairs under a refit without this one (0 when that refit is exact). */
  readonly rmsWithout: number;
}

export interface OrientationCheck {
  readonly declaredMirrored: boolean;
  /** RMS board residual (mm) of the best similarity fit with the declared side and with the opposite side; null with fewer than 3 pairs or when a fit is degenerate. */
  readonly similarityRms: { readonly declared: number; readonly opposite: number } | null;
  /** The fitted affine or projective map reverses handedness for the declared side. */
  readonly reversed: boolean;
  /** The pairs look like the other side of the board (or two pairs were matched in the wrong order). */
  readonly suspectMirrored: boolean;
}

export type RegistrationWarningCode = 'EXACT_FIT' | 'NEAR_COLLINEAR' | 'MIRROR_SUSPECTED' | 'OUTLIER_SUSPECTED' | 'POOR_FIT' | 'STRONG_DISTORTION';
export interface RegistrationWarning {
  readonly code: RegistrationWarningCode;
  readonly severity: 'info' | 'warning';
  readonly message: string;
  readonly indices?: readonly number[];
  readonly side?: 'board' | 'image';
  readonly value?: number;
}

/** The map linearized at one board point: what a technician reads off the photo. */
export interface Linearization {
  /** Photo pixels per board millimetre here (the square root of the area scale). */
  readonly pixelsPerMm: number;
  /**
   * Degrees (-180, 180] the oriented board is rotated on the photo, clockwise on screen: the `rotation` a boardview camera needs (with the same
   * `mirrored`) to show the board turned the way the photo shows it.
   */
  readonly rotationDegrees: number;
  /** Ratio of the largest to the smallest local scale (1: no shear, no tilt). */
  readonly anisotropy: number;
  /** 1 when the map keeps the handedness of the oriented board, -1 when it reverses it. */
  readonly handedness: 1 | -1;
}

export interface Registration {
  readonly model: RegistrationModel;
  readonly mirrored: boolean;
  /** Board (mm, Y up) to image (px, Y down), orientation (mirroring and the Y flip) included. W is positive where the map is valid. */
  readonly boardToImage: Matrix3;
  /** The inverse, normalized the same way. */
  readonly imageToBoard: Matrix3;
  /** Centroid of the board points the map was fitted to (where W is 1); kept to restore the sign convention. */
  readonly reference: Point2;
  readonly pointCount: number;
  /** 2n minus the model's numbers (4, 6 or 8). 0 means an exact fit: the residuals carry no information. */
  readonly degreesOfFreedom: number;
  readonly residuals: readonly PointResidual[];
  /** Root-mean-square of the per-point board distances, millimetres. */
  readonly rmsBoard: number;
  readonly maxBoard: number;
  readonly rmsImage: number;
  readonly maxImage: number;
  /** Linearization at the centroid of the board points. */
  readonly linear: Linearization;
  readonly outlierHint: OutlierHint | null;
  readonly orientation: OrientationCheck;
  readonly quality: { readonly board: PointSetQuality; readonly image: PointSetQuality };
  readonly warnings: readonly RegistrationWarning[];
  /** True for a map composed from another registration (deriveRegistration): it has no pairs of its own. */
  readonly derived: boolean;
}

export interface RegisterOptions {
  /** Default 'auto': 2 pairs similarity, 3 affine, 4 or more projective. */
  model?: RegistrationModel | 'auto';
  /** The photo shows the bottom side (the board is mirrored). Default false. */
  mirrored?: boolean;
  /** Polish projective fits of 5+ pairs by Levenberg-Marquardt (default true). */
  refine?: boolean;
  /** Leave-one-out refits (default true up to LEAVE_ONE_OUT_MAX pairs; false skips them). */
  leaveOneOut?: boolean;
  /** Expected 1-sigma error of a clicked photo point per coordinate, pixels (default 2). Pairs are never called mistakes within a few multiples of it. */
  noiseSigmaPx?: number;
  /** A leave-one-out score at or above this names a pair as the likely mistake (default OUTLIER_SCORE = 5). */
  outlierScore?: number;
  /** Overrides MIN_THIN_RATIO (the collinearity error threshold). */
  minThinRatio?: number;
}

export const LEAVE_ONE_OUT_MAX = 40;
/**
 * Default leave-one-out score from which a pair is named as a likely mistake. The noise is estimated from the other pairs, so the score is a t-like statistic:
 * measured on synthetic 4K photos with the click noise at the assumed 2 px, a clean set got a false name in under 0.5 % of the runs (2.7 % at 3 px, 1.5 times the
 * assumed noise); 4 gave 6 to 9 % there.
 */
export const OUTLIER_SCORE = 5;
/** A pair can be named as a mistake only with at least this many degrees of freedom (see the header of this file). */
export const OUTLIER_MIN_DOF = 6;
/** The best leave-one-out score must be at least this many times the next one before a single pair is named. */
export const OUTLIER_DOMINANCE = 1.5;
/** Default expected click noise, photo pixels per coordinate. */
export const DEFAULT_NOISE_SIGMA_PX = 2;
/** W below this fraction of its value at the centroid means a point is next to the horizon of the perspective map: the pairs are folded. */
export const MIN_RELATIVE_W = 0.05;
export const STRONG_DISTORTION_ANISOTROPY = 1.35;
/** The residual of the fit, per degree of freedom, as a multiple of the expected click noise from which the fit is called poor. */
export const POOR_FIT_RATIO = 3;
/** The opposite side must fit this much better (RMS ratio) before the side is called wrong. */
const MIRROR_RMS_RATIO = 0.5;
const MIRROR_MIN_RELATIVE_RMS = 0.003;

export const modelForCount = (count: number): RegistrationModel => (count >= 4 ? 'homography' : count === 3 ? 'affine' : 'similarity');
export const mirroredForSide = (side: 'top' | 'bottom'): boolean => side === 'bottom';

/** Canonical board point to the oriented frame the fits work in: X mirrored for the bottom side, then Y flipped to the photo's y-down (the boardview's `orientPoint` with rotation 0). */
export const orientBoardPoint = (p: Point2, mirrored: boolean): Point2 => ({ x: mirrored ? -p.x : p.x, y: -p.y });
const orientationMatrix = (mirrored: boolean): Matrix3 => [mirrored ? -1 : 1, 0, 0, 0, -1, 0, 0, 0, 1];

const distance = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y);
const rms = (values: readonly number[]) => (values.length ? Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length) : 0);

function linearizeMatrix(matrix: Matrix3, at: Point2, mirrored: boolean): Linearization | null {
  const j = jacobian(matrix, at);
  if (!j) return null;
  // Remove the orientation (J_oriented = J * diag(+-1, -1)) so that a plain top-down photo has rotation 0 and handedness 1.
  const sx = mirrored ? -1 : 1;
  const a = j[0] * sx, b = -j[1], c = j[2] * sx, d = -j[3];
  const det = a * d - b * c;
  const e = (a + d) / 2, f = (a - d) / 2, g = (c + b) / 2, h = (c - b) / 2;
  const q = Math.hypot(e, h), r = Math.hypot(f, g);
  const largest = q + r, smallest = Math.abs(q - r);
  const rotationDegrees = Math.atan2(h, e) * 180 / Math.PI;
  return {
    pixelsPerMm: Math.sqrt(Math.abs(det)),
    rotationDegrees: rotationDegrees <= -180 ? 180 : rotationDegrees,
    anisotropy: smallest > 0 ? largest / smallest : Infinity,
    handedness: det < 0 ? -1 : 1,
  };
}

/** RMS board residual of the similarity fit of these pairs on the given side hypothesis, or null when it cannot be fitted. */
function similarityRms(board: readonly Point2[], image: readonly Point2[], mirrored: boolean): number | null {
  try {
    const oriented = board.map(p => orientBoardPoint(p, mirrored));
    const forward = fitTransform(oriented, image, 'similarity');
    const inverse = invert(forward);
    if (!inverse) return null;
    const distances = oriented.map((p, i) => { const back = transform(inverse, image[i]); return back ? distance(back, p) : Infinity; });
    return rms(distances);
  } catch (error) {
    if (error instanceof RegistrationError) return null;
    throw error;
  }
}

/** How well the pairs fit as a similarity on the declared side and on the opposite one. Null with fewer than 3 pairs. Never throws on degenerate input. */
export function suggestOrientation(points: readonly Correspondence[], mirrored: boolean): { declared: number; opposite: number } | null {
  if (points.length < 3) return null;
  const board = points.map(p => p.board), image = points.map(p => p.image);
  const declared = similarityRms(board, image, mirrored), opposite = similarityRms(board, image, !mirrored);
  return declared === null || opposite === null ? null : { declared, opposite };
}

interface LeaveOneOutResult { readonly errors: (number | null)[]; readonly vectorsPx: (Point2 | null)[]; readonly rmsWithout: (number | null)[] }

function leaveOneOut(oriented: readonly Point2[], image: readonly Point2[], model: RegistrationModel, refine: boolean | undefined, minThinRatio: number | undefined): LeaveOneOutResult {
  const n = oriented.length;
  const errors: (number | null)[] = [], vectorsPx: (Point2 | null)[] = [], rmsWithout: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const subOriented = oriented.filter((_, j) => j !== i), subImage = image.filter((_, j) => j !== i);
    try {
      const forward = fitTransform(subOriented, subImage, model, { refine, minThinRatio });
      const raw = invert(forward);
      const inverse = raw && normalizeAt(raw, pointSetQuality(subImage).centroid);
      if (!inverse) throw new RegistrationError('SINGULAR', 'refit');
      const back = transform(inverse, image[i]), ahead = transform(forward, oriented[i]);
      errors.push(back ? distance(back, oriented[i]) : Infinity);
      vectorsPx.push(ahead ? { x: ahead.x - image[i].x, y: ahead.y - image[i].y } : null);
      const others: number[] = [];
      for (let j = 0; j < n; j++) if (j !== i) { const p = transform(inverse, image[j]); others.push(p ? distance(p, oriented[j]) : Infinity); }
      rmsWithout.push(rms(others));
    } catch (error) {
      if (!(error instanceof RegistrationError)) throw error;
      errors.push(null); vectorsPx.push(null); rmsWithout.push(null);
    }
  }
  return { errors, vectorsPx, rmsWithout };
}

/**
 * Names the pair whose leave-one-out error is the largest multiple of the click noise, if that multiple reaches `threshold`. The error vectors are the real
 * refit errors; the weights come from the leverage of each pair (for a linear fit the leave-one-out error is exactly the residual divided by 1 - leverage,
 * which is what makes the multiple comparable between a corner pair and a pair near the middle). The noise level is the expected click noise, raised to
 * the noise the other pairs show (a deleted-variance estimate that the suspect cannot inflate). A pair is named only with at least OUTLIER_MIN_DOF degrees of freedom.
 */
function outlierFrom(loo: LeaveOneOutResult, leverage: readonly LeverageBlock[] | null, residualsPx: readonly Point2[], degreesOfFreedom: number, noiseSigmaPx: number, threshold: number): OutlierHint | null {
  // With few degrees of freedom the fit through the other pairs is exact or nearly so whichever pair is left out, and the outlier itself pulls the others'
  // leave-one-out errors up: the pair with the largest score is then often the wrong one (measured: 1 to 4 % of the runs with 4 degrees of freedom).
  if (!leverage || degreesOfFreedom < OUTLIER_MIN_DOF) return null;
  const n = residualsPx.length;
  let ssr = 0;
  for (const r of residualsPx) ssr += r.x * r.x + r.y * r.y;
  if (!Number.isFinite(ssr)) return null;
  let best: OutlierHint | null = null, second = 0;
  for (let i = 0; i < n; i++) {
    const e = loo.vectorsPx[i], boardError = loo.errors[i], without = loo.rmsWithout[i];
    if (!e || boardError === null || without === null || !Number.isFinite(boardError)) continue;
    const { a, b, d } = leverage[i];
    // M = I - H_ii (symmetric); q = r' M^-1 r is the part of the sum of squares that belongs to this pair.
    const ma = 1 - a, mb = -b, md = 1 - d, det = ma * md - mb * mb;
    if (!(det > 1e-9)) continue;
    const r = residualsPx[i];
    const q = (md * r.x * r.x - 2 * mb * r.x * r.y + ma * r.y * r.y) / det;
    const deleted = Math.max(0, ssr - q) / (degreesOfFreedom - 2);
    const sigma = Math.max(noiseSigmaPx, Math.sqrt(deleted / 2));
    const score = Math.sqrt(Math.max(0, ma * e.x * e.x + 2 * mb * e.x * e.y + md * e.y * e.y)) / sigma;
    if (!best || score > best.score) {
      if (best) second = Math.max(second, best.score);
      best = { index: i, leaveOneOut: boardError, leaveOneOutPx: Math.hypot(e.x, e.y), score, sigmaPx: sigma, rmsWithout: without };
    } else second = Math.max(second, score);
  }
  return best && best.score >= threshold && best.score >= OUTLIER_DOMINANCE * second ? best : null;
}

function foldingProblem(forward: Matrix3, inverse: Matrix3, board: readonly Point2[], image: readonly Point2[]): number[] {
  const bad: number[] = [];
  for (let i = 0; i < board.length; i++) if (!(weight(forward, board[i]) > MIN_RELATIVE_W) || !(weight(inverse, image[i]) > MIN_RELATIVE_W)) bad.push(i);
  return bad;
}

interface AssembleContext { model: RegistrationModel; mirrored: boolean; options: RegisterOptions }

/** Everything that is derived from a solved map and the pairs it was solved from. `forward` maps the ORIENTED board to the image. */
function assemble(boardToImage: Matrix3, points: readonly Correspondence[], context: AssembleContext): Registration {
  const { model, mirrored, options } = context;
  const n = points.length;
  const board = points.map(p => p.board), image = points.map(p => p.image);
  const boardQuality = pointSetQuality(board), imageQuality = pointSetQuality(image);
  const reference = boardQuality.centroid;
  const normalized = normalizeAt(boardToImage, reference);
  const rawInverse = normalized && invert(normalized);
  if (!normalized || !rawInverse) throw new RegistrationError('SINGULAR', 'The alignment is not invertible.', { model });
  const imageToBoard = normalizeAt(rawInverse, transform(normalized, reference) ?? imageQuality.centroid);
  if (!imageToBoard) throw new RegistrationError('SINGULAR', 'The alignment is not invertible.', { model });
  if (n > 0) {
    const bad = foldingProblem(normalized, imageToBoard, board, image);
    if (bad.length) throw new RegistrationError('FOLDED', `The perspective map folds over point${bad.length > 1 ? 's' : ''} ${bad.map(i => i + 1).join(', ')}: the pairs are matched in a crossing order, or the photo is not of a flat board.`, { indices: bad, model });
  }

  const residuals: PointResidual[] = [];
  const boardDistances: number[] = [], imageDistances: number[] = [];
  for (let i = 0; i < n; i++) {
    const back = transform(imageToBoard, image[i]), ahead = transform(normalized, board[i]);
    const dx = back ? back.x - board[i].x : Infinity, dy = back ? back.y - board[i].y : Infinity;
    const boardDistance = back ? Math.hypot(dx, dy) : Infinity;
    const imageDistance = ahead ? distance(ahead, image[i]) : Infinity;
    boardDistances.push(boardDistance); imageDistances.push(imageDistance);
    residuals.push({ index: i, board: boardDistance, dx, dy, image: imageDistance, leaveOneOut: null });
  }

  const oriented = board.map(p => orientBoardPoint(p, mirrored));
  const parameters = MODEL_PARAMETERS[model];
  const degreesOfFreedom = Math.max(0, 2 * n - parameters);
  let looResult: LeaveOneOutResult | null = null;
  if (options.leaveOneOut !== false && n > MODEL_MIN_POINTS[model] && n <= LEAVE_ONE_OUT_MAX) looResult = leaveOneOut(oriented, image, model, options.refine, options.minThinRatio);
  const withLoo = looResult ? residuals.map((r, i) => ({ ...r, leaveOneOut: looResult.errors[i] })) : residuals;
  let outlierHint: OutlierHint | null = null;
  if (looResult) {
    const leverage = leverageBlocks(model, oriented, image, multiply(normalized, orientationMatrix(mirrored)));
    const residualsPx = points.map((_, i) => { const ahead = transform(normalized, board[i]); return ahead ? { x: ahead.x - image[i].x, y: ahead.y - image[i].y } : { x: Infinity, y: Infinity }; });
    outlierHint = outlierFrom(looResult, leverage, residualsPx, degreesOfFreedom, options.noiseSigmaPx ?? DEFAULT_NOISE_SIGMA_PX, options.outlierScore ?? OUTLIER_SCORE);
  }

  const linear = linearizeMatrix(normalized, reference, mirrored) ?? { pixelsPerMm: 0, rotationDegrees: 0, anisotropy: Infinity, handedness: 1 as const };
  const reversed = model !== 'similarity' && linear.handedness < 0;
  const similarity = n >= 3 ? suggestOrientation(points, mirrored) : null;
  const mirrorByFit = !!similarity && similarity.opposite <= MIRROR_RMS_RATIO * similarity.declared && similarity.declared >= MIRROR_MIN_RELATIVE_RMS * boardQuality.spread;
  const orientation: OrientationCheck = { declaredMirrored: mirrored, similarityRms: similarity, reversed, suspectMirrored: reversed || mirrorByFit };

  const warnings: RegistrationWarning[] = [];
  if (n > 0 && degreesOfFreedom === 0) warnings.push({ code: 'EXACT_FIT', severity: 'info', message: `${n} point pairs determine the ${model} map exactly, so the error shown is zero by construction. Add one more pair to see how well the photo matches.` });
  if (model !== 'similarity' && n > 0) {
    for (const [side, q] of [['board', boardQuality], ['image', imageQuality]] as const) {
      const worstTriangle = model === 'homography' && n === 4 && q.minTriangle ? q.minTriangle.quality : Infinity;
      if (Math.min(q.thinRatio, worstTriangle) < WARN_THIN_RATIO) {
        warnings.push({ code: 'NEAR_COLLINEAR', severity: 'warning', side, value: Math.min(q.thinRatio, worstTriangle), indices: worstTriangle < q.thinRatio && q.minTriangle ? q.minTriangle.indices : undefined,
          message: `The ${side === 'board' ? 'board' : 'photo'} points are nearly in a line, so small clicking errors are amplified across it. Add a point away from the line.` });
      }
    }
  }
  if (orientation.suspectMirrored) warnings.push({ code: 'MIRROR_SUSPECTED', severity: 'warning', message: 'The points fit better with the other side of the board (or two pairs were matched in the wrong order). Check which side the photo shows.' });
  if (outlierHint) warnings.push({ code: 'OUTLIER_SUSPECTED', severity: 'warning', indices: [outlierHint.index], value: outlierHint.leaveOneOut, message: `Pair ${outlierHint.index + 1} is far from where the other pairs put it (${outlierHint.leaveOneOut.toFixed(2)} mm, ${outlierHint.score.toFixed(1)} times the click noise). It may be a mis-click.` });
  if (!outlierHint && degreesOfFreedom > 0) {
    const sigma = options.noiseSigmaPx ?? DEFAULT_NOISE_SIGMA_PX;
    const noiseRatio = Math.sqrt(imageDistances.reduce((sum, v) => sum + v * v, 0) / degreesOfFreedom) / sigma;
    if (noiseRatio >= POOR_FIT_RATIO) warnings.push({ code: 'POOR_FIT', severity: 'warning', value: noiseRatio, message: `The pairs disagree by about ${noiseRatio.toFixed(1)} times the expected click noise, so one of them may be wrong, or the photo is distorted. Add a pair to see which one.` });
  }
  if (model !== 'similarity' && linear.anisotropy > STRONG_DISTORTION_ANISOTROPY && Number.isFinite(linear.anisotropy)) warnings.push({ code: 'STRONG_DISTORTION', severity: 'warning', value: linear.anisotropy, message: 'The map stretches the board strongly in one direction (steep camera angle or a mis-matched pair).' });

  return {
    model, mirrored, boardToImage: normalized, imageToBoard, reference, pointCount: n, degreesOfFreedom, residuals: withLoo,
    rmsBoard: rms(boardDistances), maxBoard: boardDistances.length ? Math.max(...boardDistances) : 0, rmsImage: rms(imageDistances), maxImage: imageDistances.length ? Math.max(...imageDistances) : 0,
    linear, outlierHint, orientation, quality: { board: boardQuality, image: imageQuality }, warnings, derived: false,
  };
}

/**
 * Registers a photo with the board from matched pairs. Throws RegistrationError (TOO_FEW_POINTS, INVALID_POINT, DUPLICATE_POINTS,
 * COLLINEAR, DEGENERATE, SINGULAR, FOLDED) with the offending pair indices in `detail`.
 */
export function registerBoardImage(points: readonly Correspondence[], options: RegisterOptions = {}): Registration {
  if (!Array.isArray(points)) throw new RegistrationError('TOO_FEW_POINTS', 'No point pairs were given.', { needed: 2, given: 0 });
  const mirrored = options.mirrored === true;
  const model = !options.model || options.model === 'auto' ? modelForCount(points.length) : options.model;
  for (let i = 0; i < points.length; i++) {
    if (!points[i] || typeof points[i] !== 'object') throw new RegistrationError('INVALID_POINT', `Pair ${i + 1} is missing.`, { indices: [i], model });
  }
  const oriented = points.map(p => (p.board ? orientBoardPoint(p.board, mirrored) : (p.board as unknown as Point2)));
  const image = points.map(p => p.image);
  const solved = fitTransform(oriented, image, model, { refine: options.refine, minThinRatio: options.minThinRatio });
  return assemble(multiply(solved, orientationMatrix(mirrored)), points, { model, mirrored, options });
}

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

type ToImage = Pick<Registration, 'boardToImage'>;
type ToBoard = Pick<Registration, 'imageToBoard'>;

/** A board point to its place on the photo (px), or null when it has no image (behind the horizon of a perspective map). */
export const mapBoardToImage = (registration: ToImage, point: Point2): Point2 | null => transform(registration.boardToImage, point);
/** A photo point (px) to the board (mm), or null when it has no image. */
export const mapImageToBoard = (registration: ToBoard, point: Point2): Point2 | null => transform(registration.imageToBoard, point);

/** The image of a rectangle under a map: its four mapped corners (in the order min/min, max/min, max/max, min/max) and their bounding box. */
export interface MappedQuad { readonly corners: readonly [Point2, Point2, Point2, Point2]; readonly bounds: Bounds2 }

function mapRect(matrix: Matrix3, rect: Bounds2): MappedQuad | null {
  const corners = [{ x: rect.minX, y: rect.minY }, { x: rect.maxX, y: rect.minY }, { x: rect.maxX, y: rect.maxY }, { x: rect.minX, y: rect.maxY }].map(p => transform(matrix, p));
  // W is linear in the plane, so W > 0 at the four corners means W > 0 over the whole rectangle and the image is exactly the convex quad of the corners.
  if (corners.some(c => c === null)) return null;
  const quad = corners as [Point2, Point2, Point2, Point2];
  return { corners: quad, bounds: { minX: Math.min(...quad.map(p => p.x)), minY: Math.min(...quad.map(p => p.y)), maxX: Math.max(...quad.map(p => p.x)), maxY: Math.max(...quad.map(p => p.y)) } };
}
/** A board rectangle (mm) as drawn on the photo. Null when any corner has no image. */
export const mapBoardRectToImage = (registration: ToImage, rect: Bounds2): MappedQuad | null => mapRect(registration.boardToImage, rect);
/** A photo rectangle (px) as a board quad (for example the board area a whole photo covers). Null when any corner has no image. */
export const mapImageRectToBoard = (registration: ToBoard, rect: Bounds2): MappedQuad | null => mapRect(registration.imageToBoard, rect);

/** Maps interleaved board (x, y) pairs to photo pixels in place of allocating points; unmappable points become NaN. Returns how many. */
export const mapBoardPointsToImage = (registration: ToImage, input: ArrayLike<number>, output: Float64Array | Float32Array): number => transformPoints(registration.boardToImage, input, output);
export const mapImagePointsToBoard = (registration: ToBoard, input: ArrayLike<number>, output: Float64Array | Float32Array): number => transformPoints(registration.imageToBoard, input, output);

/** The map linearized at a board point: local scale, rotation and anisotropy. Null where the point has no image. */
export function linearizeAt(registration: Pick<Registration, 'boardToImage' | 'mirrored'>, boardPoint: Point2): Linearization | null {
  return linearizeMatrix(registration.boardToImage, boardPoint, registration.mirrored);
}

// ---------------------------------------------------------------------------------------------
// Derived maps and several photos
// ---------------------------------------------------------------------------------------------

/**
 * The registration of ANOTHER image whose relation to an already registered one is known: `toNew` maps pixels of the registered image to
 * pixels of the new image (for example a dual-sensor camera's fixed visible-to-thermal map, fitted once with `fitTransform`, or a pure scale when the
 * thermal grid is the visible image at lower resolution). The result has no pairs of its own, so its per-point residuals are empty; its RMS
 * figures are those of the registered image (millimetres unchanged, pixels scaled to the new image).
 */
export function deriveRegistration(base: Registration, toNew: Matrix3): Registration {
  const composed = multiply(toNew, base.boardToImage);
  const forward = normalizeAt(composed, base.reference);
  const raw = forward && invert(forward);
  const mapped = forward && transform(forward, base.reference);
  const inverse = raw && mapped && normalizeAt(raw, mapped);
  if (!forward || !inverse) throw new RegistrationError('SINGULAR', 'The composed alignment is not invertible.', { model: base.model });
  const linear = linearizeMatrix(forward, base.reference, base.mirrored) ?? base.linear;
  // The residuals in board millimetres stay true; those in pixels are in the pixels of the NEW image, which are as many times larger as the scale changed.
  const pixelRatio = base.linear.pixelsPerMm > 0 ? linear.pixelsPerMm / base.linear.pixelsPerMm : 1;
  return { ...base, boardToImage: forward, imageToBoard: inverse, residuals: [], pointCount: 0, linear, rmsImage: base.rmsImage * pixelRatio, maxImage: base.maxImage * pixelRatio, outlierHint: null, warnings: [], derived: true };
}

export interface PhotoCandidate { readonly id: string; readonly registration: Registration; readonly width: number; readonly height: number }
export interface PhotoChoice {
  readonly id: string;
  /** Where the board point is on this photo, px. */
  readonly imagePoint: Point2;
  /** Detail at that place: photo pixels per board millimetre. */
  readonly pixelsPerMm: number;
  /** Distance from the point to the nearest photo edge, px. */
  readonly marginPx: number;
  readonly rmsBoard: number;
}

/**
 * Photos (each aligned on its own, for example a close-up microscope shot beside the overview) that show a board point, best first: the one
 * with the most detail at that point (pixels per millimetre), then the one that has it farthest from its edge. Photos that do not show the point,
 * or show it closer than `minMarginPx` to an edge, are left out.
 */
export function rankPhotosForBoardPoint(candidates: readonly PhotoCandidate[], boardPoint: Point2, options: { minMarginPx?: number } = {}): PhotoChoice[] {
  const margin = options.minMarginPx ?? 0;
  const choices: PhotoChoice[] = [];
  for (const candidate of candidates) {
    const at = mapBoardToImage(candidate.registration, boardPoint);
    const linear = linearizeAt(candidate.registration, boardPoint);
    if (!at || !linear) continue;
    const marginPx = Math.min(at.x, at.y, candidate.width - at.x, candidate.height - at.y);
    if (!(marginPx >= margin)) continue;
    choices.push({ id: candidate.id, imagePoint: at, pixelsPerMm: linear.pixelsPerMm, marginPx, rmsBoard: candidate.registration.rmsBoard });
  }
  return choices.sort((a, b) => b.pixelsPerMm - a.pixelsPerMm || b.marginPx - a.marginPx || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Saved alignments (the workspace stores one per photo)
// ---------------------------------------------------------------------------------------------

export interface RegistrationRecord {
  readonly version: 1;
  readonly model: RegistrationModel;
  readonly mirrored: boolean;
  /** Board to image, row-major, as `Registration.boardToImage`. */
  readonly matrix: readonly number[];
  readonly reference: Point2;
  /** The pairs the user matched, so the alignment can be edited later; the matrix stays the truth if they are absent. */
  readonly points?: readonly Correspondence[];
}

export function registrationToRecord(registration: Registration, points?: readonly Correspondence[]): RegistrationRecord {
  return {
    version: 1, model: registration.model, mirrored: registration.mirrored, matrix: [...registration.boardToImage], reference: { x: registration.reference.x, y: registration.reference.y },
    ...(points && points.length ? { points: points.map(p => ({ board: { x: p.board.x, y: p.board.y }, image: { x: p.image.x, y: p.image.y }, ...(p.label ? { label: p.label } : {}) })) } : {}),
  };
}

const MAX_VALUE = 1e12;
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_VALUE;
const finitePoint = (value: unknown): value is Point2 => !!value && typeof value === 'object' && finiteNumber((value as Point2).x) && finiteNumber((value as Point2).y);

/** Validates a stored alignment. Anything unusable (wrong shape, non-finite or non-invertible matrix, a map that has no image at its own reference) is null. */
export function registrationFromRecord(raw: unknown): Registration | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return null;
  const { model, mirrored, matrix, reference, points } = record;
  if (model !== 'similarity' && model !== 'affine' && model !== 'homography') return null;
  if (typeof mirrored !== 'boolean' || !Array.isArray(matrix) || matrix.length !== 9 || !matrix.every(finiteNumber) || !finitePoint(reference)) return null;
  const pairs: Correspondence[] = [];
  if (points !== undefined) {
    if (!Array.isArray(points) || points.length > MAX_POINTS) return null;
    for (const p of points) {
      if (!p || typeof p !== 'object' || !finitePoint((p as Correspondence).board) || !finitePoint((p as Correspondence).image)) return null;
      pairs.push({ board: { x: (p as Correspondence).board.x, y: (p as Correspondence).board.y }, image: { x: (p as Correspondence).image.x, y: (p as Correspondence).image.y }, ...(typeof (p as Correspondence).label === 'string' ? { label: (p as Correspondence).label!.slice(0, 200) } : {}) });
    }
  }
  const m = matrix as unknown as Matrix3;
  if (!isFiniteMatrix(m) || !invert(m) || !(weight(m, reference as Point2) !== 0)) return null;
  const sign = weight(m, reference as Point2) < 0 ? -1 : 1;
  const signed: Matrix3 = sign < 0 ? [-m[0], -m[1], -m[2], -m[3], -m[4], -m[5], -m[6], -m[7], -m[8]] : m;
  try {
    if (pairs.length) return assemble(signed, pairs, { model, mirrored, options: {} });
    const normalized = normalizeAt(signed, reference as Point2);
    const rawInverse = normalized && invert(normalized);
    const mapped = normalized && transform(normalized, reference as Point2);
    const inverse = rawInverse && mapped && normalizeAt(rawInverse, mapped);
    if (!normalized || !inverse) return null;
    const linear = linearizeMatrix(normalized, reference as Point2, mirrored);
    if (!linear) return null;
    const empty = pointSetQuality([]);
    return {
      model, mirrored, boardToImage: normalized, imageToBoard: inverse, reference: { x: (reference as Point2).x, y: (reference as Point2).y }, pointCount: 0, degreesOfFreedom: 0, residuals: [], rmsBoard: 0, maxBoard: 0, rmsImage: 0, maxImage: 0, linear,
      outlierHint: null, orientation: { declaredMirrored: mirrored, similarityRms: null, reversed: false, suspectMirrored: false }, quality: { board: empty, image: empty }, warnings: [], derived: false,
    };
  } catch (error) {
    if (error instanceof RegistrationError) return null;
    throw error;
  }
}

export { MIN_THIN_RATIO, WARN_THIN_RATIO };
