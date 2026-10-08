/**
 * Simulated meter: deterministic readings for tests, demos and for working on the capture flow without hardware.
 *
 * A scenario is a list of steps. Each step holds one mode for `durationMs` and gives the display a steady target value, an
 * optional exponential approach from another value (a capacitor charging, a junction warming), noise in counts of the display,
 * and OL. `simulateReadings` turns a scenario into the whole timeline of readings; `createSimulatedMeter` wraps it as a
 * `MeterSource`. The same scenario and seed always give the same readings, bit for bit: the noise comes from a seeded
 * generator and every value is a whole number of display counts, scaled once.
 *
 * No clocks and no timers here except the default pacing of `createSimulatedMeter`, which takes a `sleep` for tests.
 */
import { formatCount, scaleCount } from './numeric';
import type { MeterFamilyInfo, MeterFlags, MeterMode, MeterReading, MeterSource, MeterUnit } from './types';
import { makeFlags } from './types';

export interface SimulatedStep {
  mode: MeterMode;
  unit: MeterUnit;
  durationMs: number;
  /** The value the display settles on, in `unit`; null shows OL. */
  value: number | null;
  /** Power of ten of one count of the display (-3: millivolt steps on a volt display). */
  exp: number;
  /** Noise (one standard deviation) in counts once settled. Default 0.5; 0 is a perfectly steady display. */
  noiseCounts?: number;
  /** The display starts here and approaches `value` with time constant `tauMs`. */
  from?: number;
  tauMs?: number;
  /** Extra noise, in counts, that is present at the start of the step and decays with `tauMs` (a noisy settling). */
  startNoiseCounts?: number;
  flags?: Partial<MeterFlags>;
  caveat?: MeterReading['caveat'];
}

export type SimulatedScenario = readonly SimulatedStep[];

export interface SimulationOptions {
  seed?: number;
  /** Time between readings. Default 200 (a typical handheld meter updates two to five times a second). */
  intervalMs?: number;
  /** Timestamp of the first reading. Default 0. */
  startAt?: number;
}

export const SIMULATED_INFO: MeterFamilyInfo = {
  id: 'simulated',
  models: ['Simulated meter'],
  status: 'simulated',
  link: 'none',
  documents: [],
  limits: ['Scripted values only; no frame is produced.'],
};

/** mulberry32: a small seeded generator, enough for scripted noise. Returns numbers in [0, 1). */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** The readings of a scenario, one per interval from the start of the first step to the end of the last. */
export function simulateReadings(scenario: SimulatedScenario, options: SimulationOptions = {}): MeterReading[] {
  const interval = Math.max(1, options.intervalMs ?? 200);
  const startAt = options.startAt ?? 0;
  const random = createRandom(options.seed ?? 1);
  const out: MeterReading[] = [];
  let stepStart = 0;
  for (const step of scenario) {
    const duration = Math.max(0, step.durationMs);
    const decimals = Math.max(0, -step.exp);
    const resolution = 10 ** step.exp;
    // Samples at the interval grid that fall inside [stepStart, stepStart + duration).
    for (let t = Math.ceil(stepStart / interval) * interval; t < stepStart + duration; t += interval) {
      const local = t - stepStart;
      const flags = makeFlags({ auto: true, ...step.flags });
      const reading: MeterReading = { family: 'simulated', value: null, unit: step.unit, mode: step.mode, flags, at: startAt + t, resolution };
      if (step.caveat) reading.caveat = step.caveat;
      if (step.value === null) {
        flags.ol = true;
        reading.display = 'OL';
        out.push(reading);
        continue;
      }
      const decay = step.tauMs && step.tauMs > 0 ? Math.exp(-local / step.tauMs) : 0;
      const ideal = step.from !== undefined && step.tauMs && step.tauMs > 0 ? step.value + (step.from - step.value) * decay : step.value;
      const noise = ((step.noiseCounts ?? 0.5) + (step.startNoiseCounts ?? 0) * decay) * gaussian(random);
      const count = Math.round(ideal / resolution + noise);
      const negative = count < 0;
      reading.value = negative ? -scaleCount(-count, step.exp) : scaleCount(count, step.exp);
      reading.display = formatCount(Math.abs(count), decimals, negative);
      out.push(reading);
    }
    stepStart += duration;
  }
  return out;
}

/** Named scenarios for the capture flow. Durations are long enough for a 5-reading, 300 ms window at the default interval. */
export type SimulatedScenarioName = 'stable' | 'settling' | 'overload' | 'modeSwitch' | 'probing' | 'drifting';

export const SIMULATED_SCENARIOS: Readonly<Record<SimulatedScenarioName, SimulatedScenario>> = {
  /** 3.3 V rail, steady to the last digit. */
  stable: [{ mode: 'dcVolts', unit: 'V', durationMs: 4000, value: 3.3, exp: -4, noiseCounts: 0.4 }],
  /** A resistance that creeps down to 4.7 kohm with noise on the way (the probe settles on the pad). */
  settling: [
    { mode: 'resistance', unit: 'Ω', durationMs: 5000, value: 4700, from: 5200, tauMs: 900, exp: -1, noiseCounts: 0.6, startNoiseCounts: 40 },
  ],
  /** An open circuit, a part, and open again: the probes lifted before and after. */
  overload: [
    { mode: 'resistance', unit: 'Ω', durationMs: 1200, value: null, exp: -1 },
    { mode: 'resistance', unit: 'Ω', durationMs: 2600, value: 47000, exp: 0, noiseCounts: 0.5 },
    { mode: 'resistance', unit: 'Ω', durationMs: 1200, value: null, exp: -1 },
  ],
  /** Volts, then the technician turns the dial to ohms, then to diode test. */
  modeSwitch: [
    { mode: 'dcVolts', unit: 'V', durationMs: 2000, value: 1.8, exp: -4, noiseCounts: 0.4 },
    { mode: 'resistance', unit: 'Ω', durationMs: 2000, value: 220, exp: -2, noiseCounts: 0.4 },
    { mode: 'diode', unit: 'V', durationMs: 2000, value: 0.512, exp: -4, noiseCounts: 0.4 },
  ],
  /** Probing four pads of a diode-mode board: each a steady drop, with open readings while the probe moves. */
  probing: [
    { mode: 'diode', unit: 'V', durationMs: 800, value: null, exp: -4 },
    { mode: 'diode', unit: 'V', durationMs: 2400, value: 0.4821, exp: -4, noiseCounts: 0.6 },
    { mode: 'diode', unit: 'V', durationMs: 600, value: null, exp: -4 },
    { mode: 'diode', unit: 'V', durationMs: 2400, value: 0.4903, exp: -4, noiseCounts: 0.6, from: 0.46, tauMs: 300, startNoiseCounts: 20 },
    { mode: 'diode', unit: 'V', durationMs: 600, value: null, exp: -4 },
    { mode: 'diode', unit: 'V', durationMs: 2400, value: 0.0012, exp: -4, noiseCounts: 0.6 },
  ],
  /** A rail that keeps climbing (a slow exponential): never steady for 5 readings within its 0.5 % tolerance. */
  drifting: [{ mode: 'dcVolts', unit: 'V', durationMs: 6000, value: 3.3, from: 2.5, tauMs: 20000, exp: -4, noiseCounts: 0.3 }],
};

export interface SimulatedMeterOptions extends SimulationOptions {
  /** Pause between readings; default a real timer. Pass `() => Promise.resolve()` to run flat out. */
  sleep?: (ms: number) => Promise<void>;
  /** Start over when the scenario ends instead of finishing. Default false. */
  loop?: boolean;
}

export type SimulatedMeter = MeterSource & {
  /** Readings produced since `connect()`. */
  readonly produced: number;
};

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** A `MeterSource` that plays a scenario. `connect()` rewinds it; `close()` ends the stream. */
export function createSimulatedMeter(scenario: SimulatedScenario | SimulatedScenarioName, options: SimulatedMeterOptions = {}): SimulatedMeter {
  const steps = typeof scenario === 'string' ? SIMULATED_SCENARIOS[scenario] : scenario;
  if (!steps) throw new RangeError(`unknown scenario ${String(scenario)}`);
  const sleep = options.sleep ?? realSleep;
  const interval = Math.max(1, options.intervalMs ?? 200);
  let generation = 0;
  let connected = false;
  let produced = 0;

  async function* run(token: number): AsyncGenerator<MeterReading> {
    let round = 0;
    do {
      const length = steps.reduce((sum, step) => sum + Math.max(0, step.durationMs), 0);
      const readings = simulateReadings(steps, { ...options, seed: (options.seed ?? 1) + round, startAt: (options.startAt ?? 0) + round * Math.ceil(length / interval) * interval });
      for (const reading of readings) {
        if (token !== generation || !connected) return;
        await sleep(interval);
        if (token !== generation || !connected) return;
        produced++;
        yield reading;
      }
      round++;
    } while (options.loop && token === generation && connected);
  }

  return {
    family: 'simulated',
    get produced() { return produced; },
    async connect(): Promise<void> {
      generation++;
      connected = true;
      produced = 0;
    },
    get samples(): AsyncIterable<MeterReading> {
      const token = generation;
      return { [Symbol.asyncIterator]: () => run(token) };
    },
    close(): void {
      connected = false;
      generation++;
    },
  };
}
