import { describe, expect, it } from 'vitest';
import {
  createRandom, createSimulatedMeter, SIMULATED_INFO, SIMULATED_SCENARIOS, simulateReadings, type SimulatedScenario, type SimulatedScenarioName,
} from './simulator';
import type { MeterReading } from './types';

const NAMES = Object.keys(SIMULATED_SCENARIOS) as SimulatedScenarioName[];

async function collect(source: AsyncIterable<MeterReading>, limit = Infinity): Promise<MeterReading[]> {
  const out: MeterReading[] = [];
  for await (const reading of source) {
    out.push(reading);
    if (out.length >= limit) break;
  }
  return out;
}

describe('seeded generator', () => {
  it('is deterministic, in [0, 1) and different for another seed', () => {
    const a = createRandom(42), b = createRandom(42), c = createRandom(43);
    const first = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(first);
    expect(Array.from({ length: 50 }, () => c())).not.toEqual(first);
    for (const value of first) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThan(1); }
    expect(new Set(first).size).toBe(50);
  });
});

describe('simulateReadings', () => {
  it('gives the same readings for the same scenario and seed, and other noise for another seed', () => {
    for (const name of NAMES) {
      const one = simulateReadings(SIMULATED_SCENARIOS[name], { seed: 5 });
      expect(simulateReadings(SIMULATED_SCENARIOS[name], { seed: 5 })).toEqual(one);
      expect(one.length).toBeGreaterThan(10);
    }
    const a = simulateReadings(SIMULATED_SCENARIOS.stable, { seed: 1 }).map(r => r.value);
    const b = simulateReadings(SIMULATED_SCENARIOS.stable, { seed: 2 }).map(r => r.value);
    expect(a).not.toEqual(b);
  });

  it('puts one reading on every interval from the start time', () => {
    const readings = simulateReadings(SIMULATED_SCENARIOS.stable, { startAt: 1000, intervalMs: 250 });
    expect(readings.length).toBe(16);
    expect(readings.map(r => r.at)).toEqual(Array.from({ length: 16 }, (_, i) => 1000 + i * 250));
    expect(simulateReadings(SIMULATED_SCENARIOS.stable, { intervalMs: 1000 }).length).toBe(4);
  });

  it('holds a steady value exactly when there is no noise, and rounds to whole counts otherwise', () => {
    const steady = simulateReadings([{ mode: 'dcVolts', unit: 'V', durationMs: 1000, value: 3.3, exp: -4, noiseCounts: 0 }]);
    expect(steady.map(r => r.value)).toEqual([3.3, 3.3, 3.3, 3.3, 3.3]);
    expect(steady[0]).toMatchObject({ family: 'simulated', mode: 'dcVolts', unit: 'V', display: '3.3000' });
    expect(steady[0].resolution).toBeCloseTo(1e-4, 14);
    for (const reading of simulateReadings(SIMULATED_SCENARIOS.stable)) {
      const counts = reading.value! / 1e-4;
      expect(Math.abs(counts - Math.round(counts))).toBeLessThan(1e-6);
      expect(Math.abs(reading.value! - 3.3)).toBeLessThan(0.002);
    }
  });

  it('shows negative values with a sign and OL as a flag with no value', () => {
    const negative = simulateReadings([{ mode: 'dcVolts', unit: 'V', durationMs: 400, value: -0.0852, exp: -4, noiseCounts: 0 }]);
    expect(negative.map(r => r.value)).toEqual([-0.0852, -0.0852]);
    expect(negative[0].display).toBe('-0.0852');
    const ol = simulateReadings([{ mode: 'resistance', unit: 'Ω', durationMs: 400, value: null, exp: -1 }]);
    expect(ol.every(r => r.value === null && r.flags.ol && r.display === 'OL')).toBe(true);
  });

  it('settles on its target after a noisy start', () => {
    const readings = simulateReadings(SIMULATED_SCENARIOS.settling, { seed: 1 });
    const values = readings.map(r => r.value!);
    expect(values[0]).toBeGreaterThan(5100);
    expect(Math.abs(values[values.length - 1] - 4700)).toBeLessThan(15);
    // Noisy at the start, quiet at the end.
    const jitter = (slice: number[]) => slice.slice(1).reduce((sum, v, i) => sum + Math.abs(v - slice[i]), 0) / (slice.length - 1);
    expect(jitter(values.slice(0, 5))).toBeGreaterThan(jitter(values.slice(-5)));
  });

  it('includes over-range stretches and mode switches', () => {
    const modes = (name: SimulatedScenarioName) => simulateReadings(SIMULATED_SCENARIOS[name]).map(r => (r.flags.ol ? 'OL' : r.mode));
    const compress = (items: string[]) => items.filter((item, i) => item !== items[i - 1]);
    expect(compress(modes('overload'))).toEqual(['OL', 'resistance', 'OL']);
    expect(compress(modes('modeSwitch'))).toEqual(['dcVolts', 'resistance', 'diode']);
    expect(compress(modes('probing'))).toEqual(['OL', 'diode', 'OL', 'diode', 'OL', 'diode']);
  });

  it('handles empty scenarios, zero-length steps and flags', () => {
    expect(simulateReadings([])).toEqual([]);
    expect(simulateReadings([{ mode: 'dcVolts', unit: 'V', durationMs: 0, value: 1, exp: -3 }])).toEqual([]);
    const held = simulateReadings([{ mode: 'dcVolts', unit: 'V', durationMs: 200, value: 1, exp: -3, flags: { hold: true, auto: false }, caveat: 'mode-ambiguous' }]);
    expect(held[0].flags).toMatchObject({ hold: true, auto: false });
    expect(held[0].caveat).toBe('mode-ambiguous');
    const defaults = simulateReadings([{ mode: 'dcVolts', unit: 'V', durationMs: 200, value: 1, exp: -3 }]);
    expect(defaults[0].flags.auto).toBe(true);
  });
});

describe('createSimulatedMeter', () => {
  const instant = () => Promise.resolve();

  it('plays a scenario as a stream of readings', async () => {
    const meter = createSimulatedMeter('stable', { sleep: instant });
    await meter.connect();
    const readings = await collect(meter.samples);
    expect(readings).toEqual(simulateReadings(SIMULATED_SCENARIOS.stable));
    expect(meter.produced).toBe(20);
    expect(meter.family).toBe('simulated');
    meter.close();
  });

  it('paces readings with the sleep it is given', async () => {
    const pauses: number[] = [];
    const meter = createSimulatedMeter('stable', { intervalMs: 500, sleep: ms => { pauses.push(ms); return Promise.resolve(); } });
    await meter.connect();
    await collect(meter.samples, 3);
    expect(pauses).toEqual([500, 500, 500]);
  });

  it('accepts a scenario of its own and rewinds on connect', async () => {
    const own: SimulatedScenario = [{ mode: 'diode', unit: 'V', durationMs: 600, value: 0.5, exp: -4, noiseCounts: 0 }];
    const meter = createSimulatedMeter(own, { sleep: instant });
    await meter.connect();
    expect((await collect(meter.samples)).map(r => r.value)).toEqual([0.5, 0.5, 0.5]);
    await meter.connect();
    expect(meter.produced).toBe(0);
    expect((await collect(meter.samples)).length).toBe(3);
  });

  it('stops at close, also in the middle of a stream', async () => {
    const meter = createSimulatedMeter('stable', { sleep: instant });
    await meter.connect();
    const seen: MeterReading[] = [];
    for await (const reading of meter.samples) {
      seen.push(reading);
      if (seen.length === 4) meter.close();
    }
    expect(seen.length).toBe(4);
    expect((await collect(meter.samples)).length).toBe(0);
  });

  it('does not produce before it is connected', async () => {
    const meter = createSimulatedMeter('stable', { sleep: instant });
    expect((await collect(meter.samples)).length).toBe(0);
  });

  it('loops with fresh noise and continuing timestamps', async () => {
    const own: SimulatedScenario = [{ mode: 'dcVolts', unit: 'V', durationMs: 1000, value: 1, exp: -4, noiseCounts: 2 }];
    const meter = createSimulatedMeter(own, { sleep: instant, loop: true });
    await meter.connect();
    const readings = await collect(meter.samples, 15);
    expect(readings.map(r => r.at)).toEqual(Array.from({ length: 15 }, (_, i) => i * 200));
    expect(readings.slice(0, 5).map(r => r.value)).not.toEqual(readings.slice(5, 10).map(r => r.value));
  });

  it('refuses an unknown scenario name and describes itself', () => {
    expect(() => createSimulatedMeter('nope' as SimulatedScenarioName)).toThrow(RangeError);
    expect(SIMULATED_INFO).toMatchObject({ id: 'simulated', status: 'simulated', link: 'none' });
  });
});
