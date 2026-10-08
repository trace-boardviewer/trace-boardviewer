import { type Bounds2, type Point2, SpatialIndex } from '../geometry';
import { RegistrationError } from './errors';
import { type Correspondence, type Registration, type RegistrationModel, registerBoardImage } from './registration';

/**
 * Is this the right board file for the board in the photo (F15)? The technician matches 3 or 4 places on the board view and on the photo; if the
 * file is the right one, all pairs obey ONE rigid placement of the board (a similarity: scale, rotation, shift) and the pairs disagree only by the
 * clicking precision. A wrong variant or revision moves parts relative to each other, which shows as a residual that clicking noise cannot explain.
 *
 * Why not just use the residual of the alignment? 3 pairs fit an affine map and 4 pairs a projective one exactly, whatever they are: the residual is
 * zero by construction. So the check measures the residual of the most rigid model that still leaves degrees of freedom (a similarity: 2n - 4 of
 * them). A photo taken at an angle, or through a lens with distortion, is not a rigid image of the board either, so the residual is compared with
 * the clicking noise on the photo and the board, converted to millimetres at the photo's own scale (a close-up is judged more strictly than a wide
 * shot), together with a tolerance of 0.4 % of the extent of the points for the model itself. Under the right file the sum of the squared
 * residuals over that noise follows a chi-square law with the degrees of freedom of the model, so the verdict is a probability, not a magic millimetre.
 *
 *  - consistent:   a rigid placement explains the points (probability of 1 % or more that noise alone gives a residual this large).
 *  - uncertain:    the check cannot tell: only a tilted camera (an affine or projective map) fits, or the photo or the pads are too coarse to tell neighbouring pads
 *                  apart, or the worst pair is off by half a pad pitch, or the side or the scale is doubtful.
 *  - inconsistent: nothing fits (probability of one in a million or less). A photo taken at an angle can cause this with only 3 or 4 pairs: the evidence says so.
 *  - insufficient: fewer than 3 usable pairs.
 *
 * A flexible model never confirms: a projective map has so much freedom that it absorbs a single misplaced pair (measured: a part 3 mm away from where the
 * file puts it, among 6 pairs, passes a projective fit with a 24 % probability). It only turns "inconsistent" into "uncertain".
 *
 * The result is information for a person, never a block: it names its evidence and its limits.
 */

export const RIGHT_FILE_THRESHOLDS = Object.freeze({
  /** The residual is called consistent when clicking noise explains a residual this large or larger with at least this probability. */
  consistentProbability: 0.01,
  /** ... and inconsistent when that probability is at most this. In between is uncertain. */
  inconsistentProbability: 1e-6,
  /** Expected 1-sigma error of a clicked photo point per coordinate, pixels (a person clicking on a photo shown smaller than its pixels). */
  noiseSigmaPx: 3,
  /** Expected 1-sigma error of a board pick per coordinate, millimetres (a pad centre picked on the boardview, and the file's own precision). */
  boardPickMm: 0.05,
  /** Error of the rigid model itself (lens distortion, a slight tilt, a board that is not flat) per coordinate, as a fraction of the extent of the matched points. */
  modelTolerance: 0.004,
  /** A worst residual of at least this fraction of the pad pitch means parts could land on the neighbouring pad: no confirmation. */
  pitchFraction: 0.5,
  /** Noise of at least this fraction of the pad pitch means the photo (or the picks) cannot tell neighbouring pads apart. */
  coarseFraction: 0.5,
  /** Without a pad pitch: noise of at least this fraction of the board diagonal is too coarse to confirm anything. */
  coarseDiagonalFraction: 0.1,
  /** A scale from the alignment that differs from the calibration of the photo by more than this is a caution, by more than the second one it prevents a confirmation. */
  scaleCaution: 0.05,
  scaleMismatch: 0.1,
  /** The points span less than this fraction of the board diagonal (twice the RMS radius over the diagonal): only a small area is checked. */
  narrowCoverage: 0.15,
});

export type RightFileVerdict = 'consistent' | 'uncertain' | 'inconsistent' | 'insufficient';
export type RightFileEvidenceCode =
  | 'TOO_FEW_POINTS' | 'BAD_POINTS' | 'RESIDUAL' | 'PERSPECTIVE' | 'ANGLE' | 'WORST_PAIR' | 'PITCH' | 'COARSE' | 'WRONG_SIDE' | 'SCALE' | 'COVERAGE' | 'FEW_POINTS';

export interface RightFileEvidence {
  readonly code: RightFileEvidenceCode;
  /** supports: speaks for the right file; against: for a wrong one; caution: limits what the check can say; info: neutral. */
  readonly effect: 'supports' | 'against' | 'caution' | 'info';
  readonly message: string;
  readonly value?: number;
  readonly threshold?: number;
  /** Zero-based pair indices the evidence is about. */
  readonly indices?: readonly number[];
}

/** What the check needs to know about the board: the area it covers and, for the pad pitch, the pad centres of the side that is photographed. */
export interface RightFileBoard {
  readonly bounds: Bounds2;
  /** Pad centres (a loaded Board's `pins` are accepted as they are); used for the typical pad pitch. */
  readonly pins?: readonly Point2[];
  /** The typical pad pitch when the caller knows it (millimetres); wins over `pins`. */
  readonly pitchMm?: number | null;
}

export interface RightFileOptions {
  /** The photo shows the bottom side. */
  mirrored?: boolean;
  /** Expected clicking noise on the photo, pixels per coordinate (default RIGHT_FILE_THRESHOLDS.noiseSigmaPx). */
  noiseSigmaPx?: number;
  /** Expected precision of the board picks, millimetres per coordinate (default RIGHT_FILE_THRESHOLDS.boardPickMm). */
  boardPickMm?: number;
  /** Error of the rigid model as a fraction of the extent of the points (default RIGHT_FILE_THRESHOLDS.modelTolerance). */
  modelTolerance?: number;
  /** Photo pixels per millimetre from the image viewer's calibration of the same photo: a second, independent check of the board's size. */
  calibrationPixelsPerMm?: number;
}

export interface RightFileCheck {
  readonly verdict: RightFileVerdict;
  /**
   * 0 to 1: how well the points agree with ONE placement of the file's board. A confirmation is at least 0.73; a fit that needs a tilted camera is
   * between 0.5 and 0.6; a pair of points nothing fits gives up to 0.3. Meaningless for 'insufficient' (0).
   */
  readonly agreement: number;
  readonly pointCount: number;
  /** The model the figures below belong to (the rigid one unless only a flexible one fits), null when there is none (insufficient). */
  readonly model: RegistrationModel | null;
  readonly degreesOfFreedom: number;
  /** Residual of that model: RMS and worst, millimetres. */
  readonly rmsMm: number | null;
  readonly maxMm: number | null;
  /** Zero-based pair with the largest residual of the rigid placement, for a verdict other than consistent and 4 or more pairs; otherwise null. */
  readonly worstIndex: number | null;
  /** RMS residual in photo pixels. */
  readonly rmsPx: number | null;
  readonly pixelsPerMm: number | null;
  /** The noise the residual is compared with, millimetres per coordinate: clicking noise on the photo and the board, and the tolerance of the model. */
  readonly expectedNoiseMm: number | null;
  /** The measured per-coordinate noise over the expected one: about 1 for the right file. */
  readonly noiseRatio: number | null;
  /** Probability that noise alone gives a residual at least this large (under the model named above). */
  readonly probability: number | null;
  readonly pitchMm: number | null;
  /** The size of the area the points span over the board diagonal. */
  readonly coverage: number | null;
  /** A rigid placement does not fit, but a tilted camera (an affine or projective map) does: the file is not contradicted and not confirmed. */
  readonly perspectiveNeeded: boolean;
  readonly evidence: readonly RightFileEvidence[];
  /** A few sentences in English for a log or a test; the interface builds its own text from `evidence` codes and values. */
  readonly explanation: string;
  /** The alignment the figures rest on. */
  readonly registration: Registration | null;
}

// ---------------------------------------------------------------------------------------------

/**
 * The probability that a chi-square variable with an EVEN number of degrees of freedom is at least `x` (a finite sum: exp(-x/2) * sum of (x/2)^i / i!
 * for i below dof / 2).
 */
export function chiSquareSurvivalEven(x: number, degreesOfFreedom: number): number {
  if (!(degreesOfFreedom >= 2) || degreesOfFreedom % 2 !== 0) throw new RangeError('Degrees of freedom must be an even number of at least 2.');
  if (!(x > 0)) return Number.isNaN(x) ? NaN : 1;
  const y = x / 2;
  let term = 1, sum = 1;
  for (let i = 1; i < degreesOfFreedom / 2; i++) { term *= y / i; sum += term; }
  return Math.min(1, Math.exp(-y) * sum);
}

/** The typical pad pitch: the median distance from a pad centre to the nearest other pad centre (coincident pads are ignored), millimetres; null when there are fewer than two distinct pads. */
export function typicalPitchMm(pins: readonly Point2[], maxSamples = 2000): number | null {
  const points = pins.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = points.length;
  if (n < 2) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const cell = Math.max(0.05, 2 * Math.sqrt(Math.max((maxX - minX) * (maxY - minY), 1e-6) / n));
  const index = new SpatialIndex<number>(cell);
  points.forEach((p, i) => index.add(i, { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }));
  const step = Math.max(1, Math.ceil(n / maxSamples));
  const nearest: number[] = [];
  for (let i = 0; i < n; i += step) {
    const p = points[i];
    let radius = cell, found = Infinity;
    for (let attempt = 0; attempt < 12 && !(found <= radius); attempt++) {
      found = Infinity;
      for (const j of index.query({ minX: p.x - radius, minY: p.y - radius, maxX: p.x + radius, maxY: p.y + radius })) {
        if (j === i) continue;
        const d = Math.hypot(points[j].x - p.x, points[j].y - p.y);
        if (d > 1e-6 && d < found) found = d;
      }
      if (!(found <= radius)) radius *= 2;
    }
    if (Number.isFinite(found)) nearest.push(found);
  }
  if (!nearest.length) return null;
  nearest.sort((a, b) => a - b);
  const mid = nearest.length >> 1;
  return nearest.length % 2 ? nearest[mid] : (nearest[mid - 1] + nearest[mid]) / 2;
}

const fmtMm = (value: number): string => `${value >= 0.1 ? value.toFixed(2) : value.toFixed(3)} mm`;
const fmtP = (p: number): string => (p >= 0.01 ? `${(p * 100).toFixed(0)} %` : p > 1e-6 ? `${(p * 100).toPrecision(1)} %` : 'under 0.0001 %');
const MODEL_NAME: Record<RegistrationModel, string> = { similarity: 'rigid (scale, rotation and shift)', affine: 'affine', homography: 'projective' };

interface Stat { registration: Registration; model: RegistrationModel; dof: number; rmsMm: number; maxMm: number; worstIndex: number; ratio: number; probability: number }

/** Residual statistics of a registration against the noise it should show: null for an exact fit (no degrees of freedom) or an unusable noise level. */
function statOf(registration: Registration, sigmaMm: number): Stat | null {
  const dof = registration.degreesOfFreedom;
  if (!(dof >= 2) || !(sigmaMm > 0)) return null;
  let sum = 0, max = 0, worstIndex = 0;
  registration.residuals.forEach((r, i) => { sum += r.board * r.board; if (r.board > max) { max = r.board; worstIndex = i; } });
  if (!Number.isFinite(sum)) return { registration, model: registration.model, dof, rmsMm: Infinity, maxMm: Infinity, worstIndex, ratio: Infinity, probability: 0 };
  const t = sum / (sigmaMm * sigmaMm);
  return { registration, model: registration.model, dof, rmsMm: registration.rmsBoard, maxMm: max, worstIndex, ratio: Math.sqrt(t / dof), probability: chiSquareSurvivalEven(t, dof) };
}

function tryRegister(points: readonly Correspondence[], model: RegistrationModel, mirrored: boolean, leaveOneOut: boolean): Registration | null {
  try { return registerBoardImage(points, { model, mirrored, leaveOneOut }); } catch (error) {
    if (error instanceof RegistrationError) return null;
    throw error;
  }
}

function insufficient(pointCount: number, code: 'TOO_FEW_POINTS' | 'BAD_POINTS', message: string, indices?: readonly number[]): RightFileCheck {
  return {
    verdict: 'insufficient', agreement: 0, pointCount, model: null, degreesOfFreedom: 0, rmsMm: null, maxMm: null, worstIndex: null, rmsPx: null, pixelsPerMm: null, expectedNoiseMm: null, noiseRatio: null, probability: null,
    pitchMm: null, coverage: null, perspectiveNeeded: false, evidence: [{ code, effect: 'info', message, ...(indices ? { indices } : {}) }], explanation: message, registration: null,
  };
}

/** 1 for a probability of 30 % or more, 0 at the inconsistency threshold, on a log scale between. */
const agreementOf = (probability: number): number => {
  const low = Math.log10(RIGHT_FILE_THRESHOLDS.inconsistentProbability), high = Math.log10(0.3);
  return Math.min(1, Math.max(0, (Math.log10(Math.max(probability, 1e-300)) - low) / (high - low)));
};

/**
 * Judges whether the matched points are consistent with the board file. `points` are the pairs the technician matched (board = the place on the
 * board view in millimetres, image = the same place on the photo in pixels); 3 are the minimum and 4 or more are better. Never throws for bad
 * points: it answers 'insufficient' and says which pair is the problem.
 */
export function checkRightFile(points: readonly Correspondence[], board: RightFileBoard, options: RightFileOptions = {}): RightFileCheck {
  const T = RIGHT_FILE_THRESHOLDS;
  const sigmaPx = options.noiseSigmaPx ?? T.noiseSigmaPx, pickMm = options.boardPickMm ?? T.boardPickMm, tolerance = options.modelTolerance ?? T.modelTolerance;
  if (!(sigmaPx > 0) || !(pickMm >= 0) || !(tolerance >= 0) || !Number.isFinite(sigmaPx) || !Number.isFinite(pickMm) || !Number.isFinite(tolerance)) throw new RangeError('The noise levels must be positive numbers.');
  const mirrored = options.mirrored === true;
  const count = Array.isArray(points) ? points.length : 0;
  if (count < 3) return insufficient(count, 'TOO_FEW_POINTS', `The check needs at least 3 matched points (4 are better); ${count} given.`);

  let rigid: Registration;
  try { rigid = registerBoardImage(points, { model: 'similarity', mirrored }); } catch (error) {
    if (error instanceof RegistrationError) return insufficient(count, 'BAD_POINTS', error.message, error.detail.indices);
    throw error;
  }
  const pixelsPerMm = rigid.linear.pixelsPerMm;
  const sigmaMm = Math.hypot(sigmaPx / pixelsPerMm, pickMm, tolerance * 2 * rigid.quality.board.spread);
  if (!(pixelsPerMm > 0) || !Number.isFinite(sigmaMm)) return insufficient(count, 'BAD_POINTS', 'The matched points are so close together on the photo that no scale can be found.');
  const diagonal = Math.hypot(board.bounds.maxX - board.bounds.minX, board.bounds.maxY - board.bounds.minY);
  const pitchMm = board.pitchMm !== undefined && board.pitchMm !== null ? (board.pitchMm > 0 ? board.pitchMm : null) : board.pins ? typicalPitchMm(board.pins) : null;
  const coverage = diagonal > 0 ? (2 * rigid.quality.board.spread) / diagonal : null;

  const rigidStat = statOf(rigid, sigmaMm) as Stat;
  // A reflection is not a tilt: a flexible fit that reverses the handedness is the wrong side (or two pairs swapped), not a camera angle.
  const flexible = count >= 5 ? tryRegister(points, 'homography', mirrored, false) : count === 4 ? tryRegister(points, 'affine', mirrored, false) : null;
  const flexStat = flexible && !flexible.orientation.reversed ? statOf(flexible, sigmaMm) : null;

  const evidence: RightFileEvidence[] = [];
  let verdict: RightFileVerdict, used: Stat = rigidStat, perspectiveNeeded = false;
  let agreement: number;
  if (rigidStat.probability >= T.consistentProbability) { verdict = 'consistent'; agreement = agreementOf(rigidStat.probability); }
  else if (flexStat && flexStat.probability >= T.consistentProbability) { verdict = 'uncertain'; used = flexStat; perspectiveNeeded = true; agreement = 0.3 + 0.3 * agreementOf(flexStat.probability); }
  else {
    const best = flexStat && flexStat.probability > rigidStat.probability ? flexStat : rigidStat;
    used = best;
    verdict = best.probability <= T.inconsistentProbability ? 'inconsistent' : 'uncertain';
    agreement = 0.3 * agreementOf(best.probability);
  }

  const rms = fmtMm(used.rmsMm), worst = fmtMm(used.maxMm), noise = fmtMm(sigmaMm), name = MODEL_NAME[used.model];
  if (verdict === 'consistent') {
    evidence.push({ code: 'RESIDUAL', effect: 'supports', value: used.ratio, threshold: T.consistentProbability, message: `The points agree with the file: ${rms} RMS (worst ${worst}) under a ${name} alignment, within the expected noise of about ${noise}. The chance that noise alone gives more is ${fmtP(used.probability)}.` });
  } else {
    evidence.push({ code: 'RESIDUAL', effect: verdict === 'inconsistent' ? 'against' : 'caution', value: used.ratio, threshold: T.consistentProbability, message: `The points disagree by ${rms} RMS (worst ${worst}) under a ${name} alignment: ${used.ratio.toFixed(1)} times the expected noise of about ${noise}. The chance that noise alone gives this much is ${fmtP(used.probability)}.` });
  }
  if (perspectiveNeeded) {
    evidence.push({ code: 'PERSPECTIVE', effect: 'caution', value: rigidStat.ratio, message: `A rigid placement does not fit (${rigidStat.ratio.toFixed(1)} times the expected noise), only a ${MODEL_NAME[used.model]} one does. That is what a photo taken at an angle looks like, but a part that is somewhere else in the board than in the file looks the same, so the file is neither confirmed nor ruled out. A photo straight above the board, or one more point, checks it better.` });
  } else if (verdict !== 'consistent') {
    evidence.push({ code: 'ANGLE', effect: 'info', message: 'A photo taken at an angle, or through a strongly distorting lens, breaks a rigid match too; a photo straight above the board checks the file more reliably.' });
  }
  if (verdict !== 'consistent' && count >= 4) {
    // The largest residual of the RIGID placement: with a moved part among 4 pairs it is that pair in 8 of 10 cases, with 5 or more in nearly all (the residuals of a
    // flexible fit and the leave-one-out errors name it no better than chance with so few pairs).
    evidence.push({ code: 'WORST_PAIR', effect: 'info', indices: [rigidStat.worstIndex], value: rigidStat.maxMm, message: `Pair ${rigidStat.worstIndex + 1} is off the most (${fmtMm(rigidStat.maxMm)}). Check that it is the same place on the board and on the photo; if it is, the file may be another variant or revision.` });
  }

  let capped = false;
  if (verdict !== 'consistent') {
    const opposite = tryRegister(points, 'similarity', !mirrored, false);
    const oppositeStat = opposite ? statOf(opposite, sigmaMm) : null;
    if (oppositeStat && oppositeStat.probability >= T.consistentProbability) {
      verdict = 'uncertain'; agreement = Math.min(agreement, 0.6);
      evidence.push({ code: 'WRONG_SIDE', effect: 'caution', value: oppositeStat.rmsMm, message: `The points agree with the file if the photo shows the ${mirrored ? 'top' : 'bottom'} side instead (${fmtMm(oppositeStat.rmsMm)} RMS). Check which side the photo shows before judging the file.` });
    }
  }
  if (pitchMm === null && diagonal > 0 && sigmaMm >= T.coarseDiagonalFraction * diagonal) {
    evidence.push({ code: 'COARSE', effect: 'caution', value: sigmaMm, threshold: T.coarseDiagonalFraction * diagonal, message: `The expected noise (${noise}) is a large part of the board (${fmtMm(diagonal)} across): this photo is too coarse to confirm the file.` });
    if (verdict === 'consistent') { verdict = 'uncertain'; capped = true; }
  }
  if (pitchMm !== null) {
    if (sigmaMm >= T.coarseFraction * pitchMm) {
      evidence.push({ code: 'COARSE', effect: 'caution', value: sigmaMm, threshold: T.coarseFraction * pitchMm, message: `The expected noise (${noise}) is a large part of the pad pitch (${fmtMm(pitchMm)}): this photo cannot tell neighbouring pads apart, so a match proves little.` });
      if (verdict === 'consistent') { verdict = 'uncertain'; capped = true; }
    } else if (used.maxMm >= T.pitchFraction * pitchMm) {
      evidence.push({ code: 'PITCH', effect: 'caution', value: used.maxMm, threshold: T.pitchFraction * pitchMm, message: `The worst pair is off by ${worst}, at least half of the pad pitch (${fmtMm(pitchMm)}): parts could land on the neighbouring pads.` });
      if (verdict === 'consistent') { verdict = 'uncertain'; capped = true; }
    }
  }
  const calibration = options.calibrationPixelsPerMm;
  if (calibration !== undefined && Number.isFinite(calibration) && calibration > 0) {
    const difference = Math.abs(pixelsPerMm - calibration) / calibration;
    if (difference >= T.scaleCaution) {
      evidence.push({ code: 'SCALE', effect: difference >= T.scaleMismatch ? 'against' : 'caution', value: difference, threshold: difference >= T.scaleMismatch ? T.scaleMismatch : T.scaleCaution, message: `The points imply ${pixelsPerMm.toFixed(1)} px/mm but the photo is calibrated at ${calibration.toFixed(1)} px/mm (${(difference * 100).toFixed(0)} % apart): the board in the photo has another size than the file, or the calibration or a point is off.` });
      if (difference >= T.scaleMismatch && verdict === 'consistent') { verdict = 'uncertain'; capped = true; }
    } else {
      evidence.push({ code: 'SCALE', effect: 'supports', value: difference, threshold: T.scaleCaution, message: `The scale of the alignment (${pixelsPerMm.toFixed(1)} px/mm) matches the calibration of the photo (${(difference * 100).toFixed(1)} % apart).` });
    }
  }
  if (coverage !== null && coverage < T.narrowCoverage) {
    evidence.push({ code: 'COVERAGE', effect: 'caution', value: coverage, threshold: T.narrowCoverage, message: `The points span only ${(coverage * 100).toFixed(0)} % of the board's diagonal: only that part of the board is checked, and the rest of the file may still differ.` });
  }
  if (count === 3) evidence.push({ code: 'FEW_POINTS', effect: 'info', message: 'Only 3 points were matched; a fourth point would make the check twice as sensitive.' });

  if (capped) agreement = Math.min(agreement, 0.6);
  if (count === 3) agreement = Math.min(agreement, 0.85);

  const lead = verdict === 'consistent'
    ? `The ${count} matched points are consistent with this board file.`
    : verdict === 'inconsistent' ? `The ${count} matched points do not fit this board file: they cannot all be the same places on one placement of it.`
    : `The ${count} matched points neither confirm nor rule out this board file.`;
  const detail = evidence.filter(e => e.effect !== 'info' || e.code === 'WORST_PAIR' || e.code === 'ANGLE').map(e => e.message).join(' ');
  return {
    verdict, agreement, pointCount: count, model: used.model, degreesOfFreedom: used.dof, rmsMm: used.rmsMm, maxMm: used.maxMm, worstIndex: count >= 4 && verdict !== 'consistent' ? rigidStat.worstIndex : null, rmsPx: used.registration.rmsImage,
    pixelsPerMm, expectedNoiseMm: sigmaMm, noiseRatio: used.ratio, probability: used.probability, pitchMm, coverage, perspectiveNeeded, evidence,
    explanation: `${lead} ${detail}${verdict === 'consistent' ? ' This does not prove the revision: it shows the matched places are laid out as in the file.' : ''}`.trim(), registration: used.registration,
  };
}
