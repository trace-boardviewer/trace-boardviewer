/**
 * Timing checks for tests that guard the running time of an operation.
 *
 * An absolute budget ("under 250 ms") measures the machine as much as the code: it fails when the host is busy and
 * says nothing about how the cost grows. These checks never compare a time with a number of milliseconds. They compare
 * measurements taken in the same test, one right after the other, so a busy machine slows every measurement alike:
 *
 *  - `expectScaling` runs the same operation on inputs of growing size and fails when the running time grows faster
 *    than size^maxExponent (1.7 by default). Linear time has exponent 1, n log n about 1.1, a quadratic scan 2. Tables
 *    and object graphs that outgrow the processor caches, and the garbage collector, make a linear operation measure
 *    up to about 1.5 over a step of four times the size, so 1.7 sits between that and a quadratic one. This is the
 *    check for text and flat data. A bounded operation (one that reads only a prefix, or stops at a budget) is
 *    `expectBoundedWork`: exponent 0.5 at most.
 *  - `expectCostAtMost` compares an operation with a reference operation on the same data and fails above a factor.
 *    The reference is a plain pass over the same data (for operations that are bound by memory, where the exponent
 *    between two sizes is too noisy: the factor sits well above what a correct run costs and far below what a scan per
 *    element costs), or the work the operation must avoid (an expansion it has to refuse, a stream it has to cut off).
 *
 * How the numbers are taken: an operation that is faster than a window is repeated inside it, so the timer resolution
 * does not matter; each size is sampled several times, the samples of the sizes being compared alternate, and the
 * smallest sample counts (other processes and the garbage collector only ever add time). A comparison that fails is
 * measured again, up to `attempts` times, and only fails when every attempt does.
 *
 * Sizes are checked in ascending order and the first pair that grows too fast fails the test, so a catastrophic
 * regression stops at the small sizes instead of at the large one (a regression that never finishes ends at the time
 * limit of the test instead). Pick the sizes so that a regression shows at the first pair and put work that is not
 * under test, such as building the input, into `make`, outside of the timed function. Steps of a factor of four or
 * more between the sizes keep the exponent from being decided by noise.
 *
 * With TIMING_REPORT=1 in the environment every comparison writes what it measured to stderr, so that sizes and
 * factors can be chosen from numbers.
 */

const now = (): number => performance.now();

const host = (globalThis as { process?: { env?: Record<string, string | undefined>; stderr?: { write(text: string): unknown } } }).process;
const report = (text: string): void => { if (host?.env?.TIMING_REPORT === '1') host.stderr?.write(`[timing] ${text}\n`); };

export interface TimingOptions {
  /** Wall time one sample should cover in ms. A faster operation is repeated within it. Default 5. */
  windowMs?: number;
  /** How often a failing comparison is measured again before the test fails. Default 5. */
  attempts?: number;
}

export interface ScalingOptions extends TimingOptions {
  /** The largest accepted growth exponent: time ~ size^exponent. Linear is 1, quadratic 2. Default 1.7. */
  maxExponent?: number;
}

export interface ScalingStep { from: number; to: number; fromMs: number; toMs: number; exponent: number }

const DEFAULT_WINDOW_MS = 5;
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_MAX_EXPONENT = 1.7;
const BOUNDED_MAX_EXPONENT = 0.5;
const MAX_REPETITIONS = 50_000;
/** One call that takes at least this long (ms) is measured fewer times: the noise matters less and the run would be long. */
const SLOW_CALL_MS = 100;

interface Prepared { work: () => unknown; repetitions: number; samples: number; best: number }

/** Compiles and warms the operation, times one call and decides how often a sample repeats it. */
function prepare(work: () => unknown, windowMs: number): Prepared {
  work();
  let started = now();
  work();
  let once = now() - started;
  if (once < windowMs) {
    // A fast operation needs many calls before the engine has compiled it for good: run it for a window, then time it again.
    const settled = now() + windowMs;
    do work(); while (now() < settled);
    started = now();
    work();
    once = now() - started;
  }
  const repetitions = once >= windowMs ? 1 : Math.min(MAX_REPETITIONS, Math.ceil(windowMs / Math.max(once, 0.0002)));
  const samples = once >= 4 * SLOW_CALL_MS ? 2 : once >= SLOW_CALL_MS ? 3 : once >= windowMs ? 5 : 9;
  return { work, repetitions, samples, best: Number.POSITIVE_INFINITY };
}

/** Takes the samples of several prepared operations in turn and keeps the smallest time per call of each. */
function measure(group: Prepared[]): number[] {
  for (const item of group) item.best = Number.POSITIVE_INFINITY;
  const rounds = Math.max(...group.map(item => item.samples));
  for (let round = 0; round < rounds; round++) {
    for (const item of group) {
      if (round >= item.samples) continue;
      const started = now();
      for (let count = 0; count < item.repetitions; count++) item.work();
      item.best = Math.min(item.best, (now() - started) / item.repetitions);
    }
  }
  return group.map(item => item.best);
}

const growth = (from: number, to: number, fromMs: number, toMs: number): number => Math.log(Math.max(toMs, 1e-6) / Math.max(fromMs, 1e-6)) / Math.log(to / from);

/** The best time of one call of `work` in ms, taken the way the checks take it. For logging; the checks never compare it with a constant. */
export function measureMs(work: () => unknown, options: TimingOptions = {}): number {
  return measure([prepare(work, options.windowMs ?? DEFAULT_WINDOW_MS)])[0];
}

/**
 * Fails when the running time of the operation grows faster than size^maxExponent. `make(size)` builds the input and
 * returns the operation to time; it is called once per size. The sizes must be ascending and are compared pair by pair.
 */
export function expectScaling(label: string, sizes: readonly number[], make: (size: number) => () => unknown, options: ScalingOptions = {}): ScalingStep[] {
  if (sizes.length < 2 || sizes.some((size, index) => !(size > 0) || (index > 0 && size <= sizes[index - 1]))) throw new Error(`${label}: expectScaling needs at least two ascending positive sizes, got ${sizes.join(', ')}`);
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS, attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS), maxExponent = options.maxExponent ?? DEFAULT_MAX_EXPONENT;
  const steps: ScalingStep[] = [];
  let previous = prepare(make(sizes[0]), windowMs);
  for (let index = 1; index < sizes.length; index++) {
    const from = sizes[index - 1], to = sizes[index], current = prepare(make(to), windowMs);
    let lowest = Number.POSITIVE_INFINITY, step: ScalingStep | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const [fromMs, toMs] = measure([previous, current]);
      const exponent = growth(from, to, fromMs, toMs);
      if (exponent < lowest) { lowest = exponent; step = { from, to, fromMs, toMs, exponent }; }
      if (exponent <= maxExponent) break;
    }
    if (lowest > maxExponent) {
      const s = step!;
      throw new Error(`${label}: the running time grows like size^${s.exponent.toFixed(2)} from ${s.from} to ${s.to} (${s.fromMs.toPrecision(3)} ms to ${s.toMs.toPrecision(3)} ms per call, best of ${attempts} measurements); at most size^${maxExponent} is accepted`);
    }
    report(`${label}: size^${step!.exponent.toFixed(2)} from ${from} to ${to} (${step!.fromMs.toPrecision(3)} ms to ${step!.toMs.toPrecision(3)} ms)`);
    steps.push(step!);
    previous = current;
  }
  return steps;
}

/** An operation that must not depend on the size of its input beyond a plain pass: exponent 0.5 or less. */
export function expectBoundedWork(label: string, sizes: readonly number[], make: (size: number) => () => unknown, options: TimingOptions = {}): ScalingStep[] {
  return expectScaling(label, sizes, make, { ...options, maxExponent: BOUNDED_MAX_EXPONENT });
}

/**
 * Fails when `work` costs more than `factor` times `reference` on the same machine at the same moment. The reference is
 * either the cost of a plain pass over the same data (a bound on the constant) or the work `work` has to avoid (a bound
 * on how early it stops). Both are measured alternately.
 */
export function expectCostAtMost(label: string, work: () => unknown, reference: () => unknown, factor: number, options: TimingOptions = {}): { workMs: number; referenceMs: number; ratio: number } {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS, attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const subject = prepare(work, windowMs), baseline = prepare(reference, windowMs);
  let lowest = { workMs: 0, referenceMs: 0, ratio: Number.POSITIVE_INFINITY };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const [workMs, referenceMs] = measure([subject, baseline]);
    const ratio = workMs / Math.max(referenceMs, 1e-6);
    if (ratio < lowest.ratio) lowest = { workMs, referenceMs, ratio };
    if (ratio <= factor) break;
  }
  if (lowest.ratio > factor) throw new Error(`${label}: costs ${lowest.ratio.toFixed(1)} times the reference (${lowest.workMs.toPrecision(3)} ms against ${lowest.referenceMs.toPrecision(3)} ms per call, best of ${attempts} measurements); at most ${factor} times is accepted`);
  report(`${label}: ${lowest.ratio.toFixed(2)} times the reference (${lowest.workMs.toPrecision(3)} ms against ${lowest.referenceMs.toPrecision(3)} ms)`);
  return lowest;
}

/** Wraps an operation that throws on purpose (a rejected input), so that the rejection is part of what is timed and not checked. */
export const catching = (work: () => unknown) => (): void => { try { work(); } catch { /* the failure is what is measured */ } };

let referenceSink = 0;
/** A plain numeric pass for calibrating fixed-size or budgeted operations. The sum escapes so it cannot be removed. */
export function linearReference(size: number): () => void {
  const data = new Float64Array(size).fill(1);
  return () => {
    let sum = 0;
    for (let index = 0; index < data.length; index++) sum += data[index] * (index & 3);
    referenceSink += sum;
  };
}

/** Pairwise geometry is intentionally bounded by a small point limit; calibrate against its required distance pass. */
export function pairwiseReference(points: readonly { x: number; y: number }[]): () => void {
  return () => {
    let sum = 0;
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      sum += Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
    }
    referenceSink += sum;
  };
}
