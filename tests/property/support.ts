/**
 * Shared settings and small helpers of the property-based tests (fast-check).
 *
 * Every property runs with a FIXED seed by default, so the suite is deterministic in CI: a failure is the same failure on
 * every machine and fast-check prints the seed, the path and the shrunk counterexample to replay it. To explore more:
 *
 *   FC_RUNS_FACTOR=20 pnpm test tests/property        twenty times as many cases per property
 *   FC_SEED=1234 pnpm test tests/property             another fixed seed
 *   FC_SEED=random pnpm test tests/property           a fresh seed every run (printed on failure)
 *
 * `FC_SEED` and `FC_RUNS_FACTOR` change only how many and which cases are drawn, never what a property asserts.
 */
import fc from 'fast-check';
import { vi } from 'vitest';

const DEFAULT_SEED = 20261007;

function seedOf(): number {
  const text = process.env.FC_SEED;
  if (text === undefined || text === '') return DEFAULT_SEED;
  if (text === 'random') return Math.floor(Math.random() * 0x7fffffff);
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : DEFAULT_SEED;
}
const SEED = seedOf();
const FACTOR = (() => { const value = Number(process.env.FC_RUNS_FACTOR); return Number.isFinite(value) && value > 0 ? value : 1; })();

// A property that draws many times as many cases needs more than the five seconds a unit test gets by default, and a loaded machine
// (several jobs at once) makes even the normal run slower than that: the limit only catches a hang, it is not a speed check.
vi.setConfig({ testTimeout: Math.max(120_000, Math.ceil(5000 * FACTOR)) });

/** Parameters for `fc.assert`: `runs` cases (scaled by FC_RUNS_FACTOR), the fixed seed, shrinking on. */
export function params(runs = 100): { seed: number; numRuns: number } {
  return { seed: SEED, numRuns: Math.max(1, Math.ceil(runs * FACTOR)) };
}

/** Relative-plus-absolute closeness: |a - b| <= abs + rel * max(|a|, |b|). */
export function near(a: number, b: number, rel = 1e-9, abs = 1e-9): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= abs + rel * Math.max(Math.abs(a), Math.abs(b));
}

// --- arbitraries shared by several files ----------------------------------------------------------------------------

/**
 * Doubles without the subnormal range: arithmetic on numbers below 1e-9 (down to 5e-324) loses all precision and says nothing about the
 * code under test (a segment of length 5e-324 is "zero" for one formula and not for another). Zero itself stays.
 */
export const tame = (arbitrary: fc.Arbitrary<number>): fc.Arbitrary<number> => arbitrary.map(value => (Math.abs(value) < 1e-9 ? 0 : value));
/** A finite double in [min, max], without subnormals. */
export const real = (min: number, max: number): fc.Arbitrary<number> => tame(fc.double({ min, max, noNaN: true, noDefaultInfinity: true }));

/** A finite coordinate: mostly arbitrary doubles in range, sometimes "nice" integers that hit boundaries exactly. */
export const coordinate = (limit = 1e4): fc.Arbitrary<number> =>
  fc.oneof({ weight: 3, arbitrary: real(-limit, limit) }, { weight: 1, arbitrary: fc.integer({ min: -Math.min(limit, 50), max: Math.min(limit, 50) }) });

export const point = (limit = 1e4): fc.Arbitrary<{ x: number; y: number }> => fc.record({ x: coordinate(limit), y: coordinate(limit) });

/** Non-degenerate or degenerate (zero size) bounds. */
export const bounds = (limit = 1e4, maxSize = 1e4): fc.Arbitrary<{ minX: number; minY: number; maxX: number; maxY: number }> =>
  fc.record({ x: coordinate(limit), y: coordinate(limit), w: real(0, maxSize), h: real(0, maxSize) })
    .map(({ x, y, w, h }) => ({ minX: x, minY: y, maxX: x + w, maxY: y + h }));

/** Degrees: the four quarter turns, other whole degrees and arbitrary doubles, negative and beyond one turn. */
export const rotation = fc.oneof(fc.constantFrom(0, 90, 180, 270, -90, 360, 720), fc.integer({ min: -720, max: 720 }), real(-720, 720));

export const viewScale = fc.oneof(real(0.1, 1000), fc.constantFrom(0.1, 1, 6, 8, 1000));

export const view = (centerLimit = 1e4) => fc.record({ center: point(centerLimit), scale: viewScale, rotation, mirrored: fc.boolean() });

export const viewport = fc.record({ width: fc.integer({ min: 120, max: 4000 }), height: fc.integer({ min: 120, max: 3000 }) });

/** Deterministic Fisher-Yates shuffle driven by fast-check integers, so a failing order shrinks and replays. */
export function shuffled<T>(items: readonly T[], keys: readonly number[]): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.abs(keys[i % Math.max(1, keys.length)] ?? 0) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export const shuffleKeys = fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 64 });
