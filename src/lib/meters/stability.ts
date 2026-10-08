/**
 * Stability detector: decides when the value a meter shows is steady enough to be captured as a reading.
 *
 * The detector is fed readings one at a time, with the timestamps the decoders put on them (`MeterReading.at`); it has no clock
 * and no timers. It keeps a sliding window of the last N readings that are comparable with each other (same mode, same unit)
 * and calls the value stable when
 *
 *   - the window is full (default 5 readings),
 *   - it spans at least `minDurationMs` (default 300 ms), so a burst of readings that arrived together is never stable,
 *   - the spread (largest minus smallest value) is within the tolerance of the mode:
 *
 *       tolerance = max(counts x resolution, relative x largest magnitude, absolute floor of the mode)
 *
 *     `counts` defaults to 2 and `resolution` is the size of one count that the decoder reports (the coarsest one in the
 *     window, so an auto-range change inside the window is not read as noise); readings without a resolution (file bridge)
 *     rely on the relative tolerance and the absolute floor, which is what makes a nominal 0 V rail "stable" at +-0.3 mV,
 *   - the window does not creep: a run of steps in one direction that has moved the value by more than half the tolerance
 *     (a capacitor charging, a part warming up) is `settling`, however small each step is.
 *
 * What else decides whether a reading may be captured:
 *   - mode mismatch: with a capture mode set (diode, voltage, ...), a meter in another mode gives `mode-mismatch` and the
 *     window is emptied, so a diode capture with the meter in volts is reported instead of captured. A reading whose mode is
 *     only a guess (`caveat: 'mode-ambiguous'`) is not judged here but blocked by its caveat, unless `allowCaveats` is set;
 *   - over-range ("OL") is its own state; it is capturable only when `acceptOverload` is set (a floating probe shows OL
 *     all the time), and then only when the whole window shows OL;
 *   - relative (delta) mode, a displayed minimum or maximum, and readings whose mode or scale is only assumed
 *     (`MeterReading.caveat`) are `blocked`: they are not what the pad measures. `allowCaveats` lets the technician trust
 *     the assumption;
 *   - HOLD and a low battery do not block; they are listed as warnings.
 *
 * `fresh` is the edge a UI auto-commits on: it is true once per stable episode (and again after `rearm()`), so a probe that stays
 * on the pad does not commit the same value over and over. A gap in the readings longer than `maxGapMs`, or time running
 * backwards, empties the window.
 */
import type { CaptureMode, MeterMode, MeterReading, MeterUnit } from './types';
import { captureModeOf, modeCoupling } from './types';

export type StabilityState = 'idle' | 'no-number' | 'settling' | 'stable' | 'overload' | 'mode-mismatch' | 'blocked';
export type StabilityWarning = 'hold' | 'low-battery';
export type StabilityBlock = 'relative' | 'extreme' | 'caveat';
export type Coupling = 'dc' | 'ac' | 'acdc';

export interface ModeTolerance {
  /** Fraction of the largest magnitude in the window. */
  relative: number;
  /** Floor in the unit of the mode (V, A, ohm, F, Hz, degrees); it is what a reading without a resolution relies on near zero. */
  absolute: number;
}

/** Defaults per capture mode. The floors are a few counts of the usual 22000-count and 6000-count ranges at the low end. */
export const DEFAULT_MODE_TOLERANCES: Readonly<Record<CaptureMode, ModeTolerance>> = {
  voltage: { relative: 0.005, absolute: 0.0005 },
  diode: { relative: 0.005, absolute: 0.002 },
  resistance: { relative: 0.005, absolute: 0.05 },
  continuity: { relative: 0.01, absolute: 0.5 },
  current: { relative: 0.01, absolute: 0.000001 },
  frequency: { relative: 0.005, absolute: 0.05 },
  capacitance: { relative: 0.01, absolute: 1e-10 },
  temperature: { relative: 0.01, absolute: 0.5 },
  other: { relative: 0.01, absolute: 0 },
};

export interface StabilityOptions {
  /** Readings in the window. Default 5, at least 2. */
  windowSize?: number;
  /** The window must span at least this long. Default 300. */
  minDurationMs?: number;
  /** Counts of the display that count as no change. Default 2. */
  counts?: number;
  /** Per-mode overrides of `DEFAULT_MODE_TOLERANCES`. */
  tolerances?: Partial<Record<CaptureMode, Partial<ModeTolerance>>>;
  /** A silence longer than this empties the window. Default 2000. */
  maxGapMs?: number;
  /** The mode captures are made in; null accepts any. Default null. */
  captureMode?: CaptureMode | null;
  /** DC / AC expected for a voltage or current capture; null accepts any. Default null. */
  coupling?: Coupling | null;
  /** A window of OL readings is capturable. Default false. */
  acceptOverload?: boolean;
  /** Readings with a caveat are not blocked. Default false. */
  allowCaveats?: boolean;
}

export interface StabilityStatus {
  state: StabilityState;
  /** True when automatic capture may take the value (or the OL display) now. */
  capturable: boolean;
  /** `capturable`, and this is the first evaluation of the episode (or the first after `rearm()`): commit on this edge. */
  fresh: boolean;
  /** The latest value in the unit of `unit` (SI base unit); null for OL and for no number. */
  value: number | null;
  unit: MeterUnit;
  /** The meter's mode of the latest reading. */
  mode: MeterMode;
  overload: boolean;
  /** Mean of the window's numeric values, null when there are none. */
  mean: number | null;
  /** Largest minus smallest value of the window. */
  spread: number;
  /** The tolerance the spread was held against. */
  tolerance: number;
  /** Last minus first value of the window. */
  drift: number;
  samples: number;
  durationMs: number;
  /** Set with `mode-mismatch`. */
  expected?: CaptureMode;
  actual?: CaptureMode;
  /** Set with `mode-mismatch` when only the coupling differs. */
  expectedCoupling?: Coupling;
  /** Set with `blocked`. */
  block?: StabilityBlock;
  warnings: StabilityWarning[];
}

export interface StabilityDetector {
  push(reading: MeterReading): StabilityStatus;
  /** The status of the latest push (an idle status before the first). */
  readonly status: StabilityStatus;
  /** Change what captures are made in; empties the window and re-arms. */
  setTarget(captureMode: CaptureMode | null, coupling?: Coupling | null): void;
  /** The next stable evaluation is `fresh` again, even if the value has not moved. Call it when the queue advances. */
  rearm(): void;
  /** Empty the window (after a reconnect). */
  reset(): void;
  /** The mode and coupling captures are made in now. */
  readonly target: { readonly captureMode: CaptureMode | null; readonly coupling: Coupling | null };
}

interface Sample { value: number | null; at: number; resolution: number; mode: MeterMode; unit: MeterUnit; coupling: Coupling | null; }

const clampInt = (value: number | undefined, fallback: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value as number))) : fallback;
const clampNumber = (value: number | undefined, fallback: number, min: number): number =>
  Number.isFinite(value) ? Math.max(min, value as number) : fallback;

function resolveTolerances(overrides: StabilityOptions['tolerances']): Record<CaptureMode, ModeTolerance> {
  const out = { ...DEFAULT_MODE_TOLERANCES } as Record<CaptureMode, ModeTolerance>;
  if (!overrides) return out;
  for (const mode of Object.keys(out) as CaptureMode[]) {
    const own = overrides[mode];
    if (!own) continue;
    out[mode] = {
      relative: clampNumber(own.relative, out[mode].relative, 0),
      absolute: clampNumber(own.absolute, out[mode].absolute, 0),
    };
  }
  return out;
}

export function createStabilityDetector(input: StabilityOptions = {}): StabilityDetector {
  const options = {
    windowSize: clampInt(input.windowSize, 5, 2, 200),
    minDurationMs: clampNumber(input.minDurationMs, 300, 0),
    counts: clampNumber(input.counts, 2, 0),
    tolerances: resolveTolerances(input.tolerances),
    maxGapMs: clampNumber(input.maxGapMs, 2000, 1),
    acceptOverload: input.acceptOverload ?? false,
    allowCaveats: input.allowCaveats ?? false,
  };
  const target: { captureMode: CaptureMode | null; coupling: Coupling | null } = { captureMode: input.captureMode ?? null, coupling: input.coupling ?? null };
  let window: Sample[] = [];
  let lastAt: number | null = null;
  let armed = true;

  const blank = (state: StabilityState, extra: Partial<StabilityStatus> = {}): StabilityStatus => ({
    state, capturable: false, fresh: false, value: null, unit: '', mode: 'other', overload: false, mean: null, spread: 0, tolerance: 0,
    drift: 0, samples: window.length, durationMs: 0, warnings: [], ...extra,
  });
  let status: StabilityStatus = blank('idle');

  const finish = (next: StabilityStatus): StabilityStatus => {
    if (next.capturable) {
      next.fresh = armed;
      armed = false;
    } else armed = true;
    status = next;
    return next;
  };

  const detector: StabilityDetector = {
    target,
    get status() { return status; },
    push(reading: MeterReading): StabilityStatus {
      const at = Number.isFinite(reading.at) ? reading.at : 0;
      if (lastAt !== null && (at < lastAt || at - lastAt > options.maxGapMs)) window = [];
      lastAt = at;

      const actualMode = captureModeOf(reading.mode);
      const coupling = modeCoupling(reading.mode);
      const warnings: StabilityWarning[] = [];
      if (reading.flags.hold) warnings.push('hold');
      if (reading.flags.lowBattery) warnings.push('low-battery');
      const common = { unit: reading.unit, mode: reading.mode, warnings, overload: reading.flags.ol, value: reading.value };

      // 1. Is the meter in the mode the capture is made in? A reading whose mode is only guessed is judged by its caveat below.
      const guessed = reading.caveat === 'mode-ambiguous' && !options.allowCaveats;
      if (target.captureMode !== null && !guessed) {
        const modeDiffers = actualMode !== target.captureMode;
        const couplingDiffers = !modeDiffers && target.coupling !== null && coupling !== null && coupling !== target.coupling;
        if (modeDiffers || couplingDiffers) {
          window = [];
          return finish(blank('mode-mismatch', {
            ...common, expected: target.captureMode, actual: actualMode,
            ...(couplingDiffers ? { expectedCoupling: target.coupling as Coupling } : {}),
          }));
        }
      }

      // 2. Readings that are not what the pad measures.
      const flags = reading.flags;
      let block: StabilityBlock | undefined;
      if (flags.rel) block = 'relative';
      else if (flags.min || flags.max) block = 'extreme';
      else if (reading.caveat && !options.allowCaveats) block = 'caveat';
      if (block) {
        window = [];
        return finish(blank('blocked', { ...common, block }));
      }

      // 3. A display without a number (blank, discharge, non-contact voltage): nothing to compare, and the window restarts.
      if (reading.value === null && !flags.ol) {
        window = [];
        return finish(blank('no-number', common));
      }

      // 4. The window holds only readings that mean the same quantity.
      const sample: Sample = {
        value: flags.ol ? null : reading.value, at, resolution: reading.resolution ?? 0, mode: reading.mode, unit: reading.unit, coupling,
      };
      const first = window[0];
      if (first && (first.mode !== sample.mode || first.unit !== sample.unit)) window = [];
      window.push(sample);
      if (window.length > options.windowSize) window.shift();
      return finish(evaluate(sample, common));
    },
    setTarget(captureMode: CaptureMode | null, coupling: Coupling | null = null): void {
      target.captureMode = captureMode;
      target.coupling = coupling;
      window = [];
      armed = true;
      status = blank('idle');
    },
    rearm(): void { armed = true; },
    reset(): void {
      window = [];
      lastAt = null;
      armed = true;
      status = blank('idle');
    },
  };

  function evaluate(latest: Sample, common: { unit: MeterUnit; mode: MeterMode; warnings: StabilityWarning[]; overload: boolean; value: number | null }): StabilityStatus {
    const first = window[0];
    const durationMs = latest.at - first.at;
    const full = window.length >= options.windowSize && durationMs >= options.minDurationMs;
    const numeric = window.filter((s): s is Sample & { value: number } => s.value !== null);
    const overloads = window.length - numeric.length;

    if (latest.value === null) {
      // The latest display is OL. A window that is all OL, full and long enough is a steady over-range.
      const steady = overloads === window.length && full;
      return blank('overload', {
        ...common, capturable: steady && options.acceptOverload, samples: window.length, durationMs,
      });
    }

    const values = numeric.map(s => s.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min;
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const capture = captureModeOf(latest.mode);
    const table = options.tolerances[capture];
    const resolution = numeric.reduce((largest, s) => Math.max(largest, s.resolution), 0);
    const tolerance = Math.max(options.counts * resolution, table.relative * Math.max(Math.abs(min), Math.abs(max)), table.absolute);
    const drift = values[values.length - 1] - values[0];

    let creeping = false;
    if (values.length === window.length && values.length >= 3 && Math.abs(drift) > tolerance / 2) {
      const sign = Math.sign(drift);
      creeping = values.every((v, i) => i === 0 || (v - values[i - 1]) * sign >= 0);
    }
    const stable = full && overloads === 0 && spread <= tolerance && !creeping;
    return blank(stable ? 'stable' : 'settling', {
      ...common, value: latest.value, capturable: stable, mean, spread, tolerance, drift, samples: window.length, durationMs,
    });
  }

  return detector;
}

/** Run a fresh detector over a list of readings (an imported log, a test) and return every status. */
export function runStability(readings: readonly MeterReading[], options: StabilityOptions = {}): StabilityStatus[] {
  const detector = createStabilityDetector(options);
  return readings.map(reading => detector.push(reading));
}
