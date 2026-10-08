import type { Bounds2, Point2 } from '../geometry';
import { type Matrix3, multiply, transform } from './matrix3';
import type { Correspondence } from './registration';

/**
 * Deterministic generators for the overlay tests (and for the thermal and photo demos): a seeded random source, a pinhole camera that looks at a
 * flat board, and noisy point pairs. Nothing here is used by the application; it is imported by tests only.
 */

/** mulberry32: a small seeded generator, so a failing random case can be replayed from its seed. */
export class Rng {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  next(): number {
    this.state = (this.state + 0x6D2B79F5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number { return min + (max - min) * this.next(); }
  int(min: number, maxInclusive: number): number { return Math.floor(this.range(min, maxInclusive + 1)); }
  /** Standard normal (Box-Muller). */
  gaussian(): number {
    const u = Math.max(this.next(), 1e-300), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  pick<T>(items: readonly T[]): T { return items[Math.floor(this.next() * items.length)]; }
  chance(probability: number): boolean { return this.next() < probability; }
}

/** Runs `property` for `runs` seeds derived from `seed`; on failure the message names the seed that reproduces it. */
export function forAll(runs: number, seed: number, property: (rng: Rng, run: number) => void): void {
  for (let run = 0; run < runs; run++) {
    const runSeed = (seed * 1_000_003 + run * 7919) >>> 0;
    try { property(new Rng(runSeed), run); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`property failed at run ${run} (seed ${runSeed}): ${message}`, { cause: error });
    }
  }
}

export interface CameraSpec {
  /** Focal length in pixels. */
  focalPx: number;
  width: number;
  height: number;
  /** Camera-to-board distance along the optical axis, mm. */
  distanceMm: number;
  /** Tilt about the image x axis, degrees (0 looks straight down). */
  tiltDeg?: number;
  /** Tilt about the image y axis, degrees. */
  panDeg?: number;
  /** Roll about the optical axis, degrees (clockwise on screen). */
  rollDeg?: number;
  /** Canonical board point at the middle of the photo (default the origin). */
  lookAt?: Point2;
  /** The photo shows the bottom side. */
  mirrored?: boolean;
  /** Optional radial lens distortion k1 applied to normalized image coordinates by `distortedProject`. */
  k1?: number;
}

const matMul3 = (a: number[][], b: number[][]) => a.map(row => b[0].map((_, j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const rx = (a: number) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const ry = (a: number) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const rz = (a: number) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];

/**
 * The exact board-to-image matrix (board mm, Y up, to photo px, Y down; mirroring included) of a pinhole camera that sees the board plane:
 * H = K [r1 r2 t] * orientation, where the oriented board frame is x right and y down like the photo.
 */
export function cameraMatrix(spec: CameraSpec): Matrix3 {
  const deg = Math.PI / 180;
  const r = matMul3(rz((spec.rollDeg ?? 0) * deg), matMul3(rx((spec.tiltDeg ?? 0) * deg), ry((spec.panDeg ?? 0) * deg)));
  const look = spec.lookAt ?? { x: 0, y: 0 };
  const u0 = spec.mirrored ? -look.x : look.x, v0 = -look.y;
  const t = [-r[0][0] * u0 - r[0][1] * v0, -r[1][0] * u0 - r[1][1] * v0, spec.distanceMm - r[2][0] * u0 - r[2][1] * v0];
  const f = spec.focalPx, cx = spec.width / 2, cy = spec.height / 2;
  const oriented: Matrix3 = [
    f * r[0][0] + cx * r[2][0], f * r[0][1] + cx * r[2][1], f * t[0] + cx * t[2],
    f * r[1][0] + cy * r[2][0], f * r[1][1] + cy * r[2][1], f * t[1] + cy * t[2],
    r[2][0], r[2][1], t[2],
  ];
  return multiply(oriented, [spec.mirrored ? -1 : 1, 0, 0, 0, -1, 0, 0, 0, 1]);
}

/** Projects with the exact camera and, when `k1` is set, radial distortion about the photo centre (normalized by the focal length). */
export function distortedProject(matrix: Matrix3, spec: CameraSpec, p: Point2): Point2 {
  const ideal = transform(matrix, p);
  if (!ideal) throw new Error('point behind the camera');
  if (!spec.k1) return ideal;
  const x = (ideal.x - spec.width / 2) / spec.focalPx, y = (ideal.y - spec.height / 2) / spec.focalPx;
  const factor = 1 + spec.k1 * (x * x + y * y);
  return { x: spec.width / 2 + x * factor * spec.focalPx, y: spec.height / 2 + y * factor * spec.focalPx };
}

export const randomPoint = (rng: Rng, bounds: Bounds2): Point2 => ({ x: rng.range(bounds.minX, bounds.maxX), y: rng.range(bounds.minY, bounds.maxY) });

/** `count` board points inside `bounds`, at least `minSeparation` apart and not nearly collinear (retries). */
export function spreadPoints(rng: Rng, count: number, bounds: Bounds2, minSeparation = 0): Point2[] {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const points: Point2[] = [];
    let guard = 0;
    while (points.length < count && guard++ < 10_000) {
      const p = randomPoint(rng, bounds);
      if (points.every(q => Math.hypot(p.x - q.x, p.y - q.y) >= minSeparation)) points.push(p);
    }
    if (points.length === count) return points;
  }
  throw new Error('could not place the points');
}

/** Pairs made with `project`, with Gaussian noise of `noisePx` on the photo side and `boardNoiseMm` on the board side. */
export function makePairs(rng: Rng, board: readonly Point2[], project: (p: Point2) => Point2, noisePx = 0, boardNoiseMm = 0): Correspondence[] {
  return board.map((p, i) => {
    const q = project(p);
    return {
      board: { x: p.x + boardNoiseMm * rng.gaussian(), y: p.y + boardNoiseMm * rng.gaussian() },
      image: { x: q.x + noisePx * rng.gaussian(), y: q.y + noisePx * rng.gaussian() },
      label: `P${i + 1}`,
    };
  });
}

export const BOARD_100x60: Bounds2 = { minX: -50, minY: -30, maxX: 50, maxY: 30 };
/** A 4K photo of a 100 x 60 mm board from 100 mm (focal length 3000 px): 30 px per mm, the board fills the frame. */
export const PHOTO_4K: CameraSpec = { focalPx: 3000, width: 3840, height: 2160, distanceMm: 100 };

/** `count` points as a technician would pick them: the first four near the four corners of `bounds` (jittered inside the outer 35 %), the rest anywhere. Never nearly collinear. */
export function wellSpreadPoints(rng: Rng, count: number, bounds: Bounds2): Point2[] {
  const w = bounds.maxX - bounds.minX, h = bounds.maxY - bounds.minY;
  const corners: Point2[] = [
    { x: bounds.minX + w * rng.range(0, 0.35), y: bounds.minY + h * rng.range(0, 0.35) },
    { x: bounds.maxX - w * rng.range(0, 0.35), y: bounds.minY + h * rng.range(0, 0.35) },
    { x: bounds.maxX - w * rng.range(0, 0.35), y: bounds.maxY - h * rng.range(0, 0.35) },
    { x: bounds.minX + w * rng.range(0, 0.35), y: bounds.maxY - h * rng.range(0, 0.35) },
  ];
  const points = corners.slice(0, Math.min(count, 4));
  while (points.length < count) points.push(randomPoint(rng, bounds));
  return points;
}
