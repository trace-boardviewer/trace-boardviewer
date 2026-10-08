import { describe, expect, it } from 'vitest';
import { createEs51922Decoder, encodeEs51922Frame } from './es51922';
import { SIMULATED_SCENARIOS, simulateReadings } from './simulator';
import { createStabilityDetector, DEFAULT_MODE_TOLERANCES, runStability, type StabilityOptions } from './stability';
import type { MeterFlags, MeterMode, MeterReading, MeterUnit } from './types';
import { makeFlags } from './types';

interface Spec {
  value: number | null;
  at: number;
  mode?: MeterMode;
  unit?: MeterUnit;
  resolution?: number;
  flags?: Partial<MeterFlags>;
  caveat?: MeterReading['caveat'];
}
const reading = (spec: Spec): MeterReading => ({
  family: 'simulated', value: spec.value, unit: spec.unit ?? 'V', mode: spec.mode ?? 'dcVolts', at: spec.at,
  flags: makeFlags({ ol: spec.value === null && !spec.flags?.invalid, ...spec.flags }),
  ...(spec.resolution !== undefined ? { resolution: spec.resolution } : {}),
  ...(spec.caveat ? { caveat: spec.caveat } : {}),
});

/** Values spaced `step` ms apart from `start`. */
const series = (values: Array<number | null>, extra: Omit<Spec, 'value' | 'at'> = {}, step = 100, start = 0): MeterReading[] =>
  values.map((value, i) => reading({ value, at: start + i * step, ...extra }));

const last = <T,>(items: T[]): T => items[items.length - 1];
const states = (readings: MeterReading[], options?: StabilityOptions) => runStability(readings, options).map(s => s.state);

describe('window and duration', () => {
  it('needs a full window', () => {
    const result = runStability(series([3.3, 3.3, 3.3, 3.3, 3.3]));
    expect(result.map(s => s.state)).toEqual(['settling', 'settling', 'settling', 'settling', 'stable']);
    expect(result.map(s => s.samples)).toEqual([1, 2, 3, 4, 5]);
    expect(last(result)).toMatchObject({ capturable: true, fresh: true, value: 3.3, mean: 3.3, spread: 0, durationMs: 400, unit: 'V', mode: 'dcVolts' });
  });

  it('needs the window to span 300 ms: a burst of readings is not stable', () => {
    expect(last(runStability(series([3.3, 3.3, 3.3, 3.3, 3.3], {}, 0))).state).toBe('settling');
    expect(last(runStability(series([3.3, 3.3, 3.3, 3.3, 3.3], {}, 50))).state).toBe('settling'); // 200 ms
    expect(last(runStability(series([3.3, 3.3, 3.3, 3.3, 3.3], {}, 75))).state).toBe('stable'); // exactly 300 ms
    expect(last(runStability(series([3.3, 3.3, 3.3, 3.3, 3.3], {}, 2))).capturable).toBe(false);
  });

  it('slides: old readings leave the window and the status follows the latest ones', () => {
    const result = runStability(series([1, 1, 1, 1, 1, 5, 5, 5, 5, 5, 5]));
    expect(result.map(s => s.state)).toEqual([
      'settling', 'settling', 'settling', 'settling', 'stable', 'settling', 'settling', 'settling', 'settling', 'stable', 'stable',
    ]);
    expect(last(result).value).toBe(5);
  });

  it('takes its window size, duration and counts from the options, clamped', () => {
    expect(states(series([2, 2, 2], {}, 200), { windowSize: 3 })).toEqual(['settling', 'settling', 'stable']);
    expect(states(series([2, 2], {}, 400), { windowSize: 1 })).toEqual(['settling', 'stable']);
    expect(states(series([2, 2, 2], {}, 200), { windowSize: Number.NaN })).toEqual(['settling', 'settling', 'settling']);
    expect(last(runStability(series([2, 2, 2], {}, 10), { windowSize: 3, minDurationMs: 0 })).state).toBe('stable');
    expect(last(runStability(series([2, 2, 2], {}, 10), { windowSize: 3, minDurationMs: -50 })).state).toBe('stable');
    expect(createStabilityDetector({ windowSize: 1000 }).push(reading({ value: 1, at: 0 })).samples).toBe(1);
  });

  it('empties the window after a gap or when time runs backwards', () => {
    const detector = createStabilityDetector();
    for (const r of series([3.3, 3.3, 3.3, 3.3, 3.3])) detector.push(r);
    expect(detector.status.state).toBe('stable');
    expect(detector.push(reading({ value: 3.3, at: 400 + 2500 })).samples).toBe(1);
    const back = createStabilityDetector();
    for (const r of series([3.3, 3.3, 3.3, 3.3, 3.3], {}, 100, 10000)) back.push(r);
    expect(back.push(reading({ value: 3.3, at: 100 })).samples).toBe(1);
    expect(back.status.state).toBe('settling');
    // A gap just under the limit keeps the window.
    const edge = createStabilityDetector({ maxGapMs: 500 });
    for (const r of series([3.3, 3.3, 3.3], {}, 500)) edge.push(r);
    expect(edge.status.samples).toBe(3);
  });
});

describe('noise', () => {
  it('accepts noise inside the relative tolerance of 0.5 percent', () => {
    // 3.3 V: 0.5 % is 16.5 mV.
    const quiet = series([3.3, 3.305, 3.296, 3.302, 3.299]);
    expect(last(runStability(quiet))).toMatchObject({ state: 'stable' });
    expect(last(runStability(quiet)).tolerance).toBeCloseTo(0.016525, 12); // 0.5 % of the largest magnitude, 3.305
    expect(last(runStability(quiet)).spread).toBeCloseTo(0.009, 12);
  });

  it('refuses noise outside it', () => {
    expect(states(series([3.3, 3.4, 3.2, 3.35, 3.28])).pop()).toBe('settling');
    expect(states(series([3.3, 3.3, 3.3, 3.3, 3.32])).pop()).toBe('settling'); // 20 mV spread
  });

  it('uses 2 counts of the display when that is looser than 0.5 percent', () => {
    // 100.0 ohm with 1 ohm counts: 0.5 % is 0.5 ohm, 2 counts is 2 ohm.
    const jitter = series([100, 101, 100, 101, 100], { mode: 'resistance', unit: 'Ω', resolution: 1 });
    expect(last(runStability(jitter))).toMatchObject({ state: 'stable', tolerance: 2 });
    const noResolution = series([100, 101, 100, 101, 100], { mode: 'resistance', unit: 'Ω' });
    expect(last(runStability(noResolution)).state).toBe('settling');
    // Three counts apart is too much.
    expect(last(runStability(series([100, 103, 100, 103, 100], { mode: 'resistance', unit: 'Ω', resolution: 1 }))).state).toBe('settling');
    expect(last(runStability(series([100, 103, 100, 103, 100], { mode: 'resistance', unit: 'Ω', resolution: 1 }), { counts: 4 })).state).toBe('stable');
  });

  it('takes the coarsest resolution in the window, so an auto-range change is not noise', () => {
    // 0.9990 V on the fine range, 1.000 V on the next: one count of the coarse range apart.
    const mixed = [
      reading({ value: 0.999, at: 0, resolution: 1e-4 }), reading({ value: 0.9991, at: 100, resolution: 1e-4 }),
      reading({ value: 0.999, at: 200, resolution: 1e-4 }), reading({ value: 1.0, at: 300, resolution: 1e-3 }),
      reading({ value: 1.0, at: 400, resolution: 1e-3 }),
    ];
    expect(last(runStability(mixed, { tolerances: { voltage: { relative: 0, absolute: 0 } } }))).toMatchObject({ state: 'stable', tolerance: 0.002 });
  });

  it('has an absolute floor per mode, which is what a value near zero relies on', () => {
    // 0 V rail: 0.5 mV floor.
    expect(last(runStability(series([0.0003, 0.0001, -0.0002, 0.0002, 0]))).state).toBe('stable');
    expect(last(runStability(series([0.0003, 0.0001, -0.0002, 0.0002, 0.001]))).state).toBe('settling');
    // Diode drop near a short: 2 mV floor.
    expect(last(runStability(series([0.0012, 0.0013, 0.0012, 0.0019, 0.0011], { mode: 'diode' }))).state).toBe('stable');
    expect(last(runStability(series([0.0012, 0.0013, 0.0012, 0.0039, 0.0011], { mode: 'diode' }))).state).toBe('settling');
    // Resistance near zero (a short): 50 mohm floor.
    expect(last(runStability(series([0.02, 0.03, 0.02, 0.04, 0.03], { mode: 'resistance', unit: 'Ω' }))).state).toBe('stable');
    expect(DEFAULT_MODE_TOLERANCES.diode.absolute).toBe(0.002);
  });

  it('lets the caller change the tolerance of a mode', () => {
    const wide = series([100, 101.5, 100, 101, 100], { mode: 'resistance', unit: 'Ω' });
    expect(last(runStability(wide)).state).toBe('settling');
    expect(last(runStability(wide, { tolerances: { resistance: { relative: 0.02 } } })).state).toBe('stable');
    expect(last(runStability(wide, { tolerances: { resistance: { absolute: 2 } } })).state).toBe('stable');
    // A tolerance override for one mode leaves the others alone.
    expect(last(runStability(series([3.3, 3.4, 3.3, 3.4, 3.3]), { tolerances: { resistance: { relative: 0.5 } } })).state).toBe('settling');
  });

  it('judges each mode by its own table', () => {
    // 1 percent for capacitance, 0.5 for volts: a 0.8 percent spread passes in one and not in the other.
    const values = [100, 100.8, 100.2, 100.6, 100.4];
    expect(last(runStability(series(values, { mode: 'capacitance', unit: 'F' }))).state).toBe('stable');
    expect(last(runStability(series(values, { mode: 'dcVolts' }))).state).toBe('settling');
    expect(last(runStability(series(values, { mode: 'acVolts' }))).state).toBe('settling');
  });
});

describe('drift', () => {
  it('does not call a steady creep stable even when each step is small', () => {
    // 100.0 to 100.4: the spread (0.4) is inside 0.5 %, but the value is walking one way.
    const creeping = series([100, 100.1, 100.2, 100.3, 100.4], { mode: 'resistance', unit: 'Ω' });
    const result = last(runStability(creeping));
    expect(result.state).toBe('settling');
    expect(result.spread).toBeCloseTo(0.4, 12);
    expect(result.drift).toBeCloseTo(0.4, 12);
    const falling = series([100.4, 100.3, 100.2, 100.1, 100], { mode: 'resistance', unit: 'Ω' });
    expect(last(runStability(falling)).state).toBe('settling');
    expect(last(runStability(falling)).drift).toBeCloseTo(-0.4, 12);
  });

  it('accepts the same spread when it wanders instead of walking', () => {
    const wander = series([100, 100.4, 100.1, 100.3, 100.2], { mode: 'resistance', unit: 'Ω' });
    expect(last(runStability(wander))).toMatchObject({ state: 'stable' });
    // A creep that is smaller than half the tolerance is just a slow settle.
    const tiny = series([100, 100.05, 100.1, 100.15, 100.2], { mode: 'resistance', unit: 'Ω' });
    expect(last(runStability(tiny)).state).toBe('stable');
  });

  it('does not let one flat step hide a climb', () => {
    const stalled = series([100, 100.1, 100.1, 100.3, 100.4], { mode: 'resistance', unit: 'Ω' });
    expect(last(runStability(stalled)).state).toBe('settling');
  });

  it('settles a charging value only once it has levelled off', () => {
    const readings: MeterReading[] = [];
    let value = 10;
    // Each reading closes 30 % of the gap to 100 ohm.
    for (let i = 0; i < 40; i++) {
      readings.push(reading({ value, at: i * 200, mode: 'resistance', unit: 'Ω' }));
      value += (100 - value) * 0.3;
    }
    const result = runStability(readings);
    const firstStable = result.findIndex(s => s.state === 'stable');
    expect(firstStable).toBeGreaterThan(5);
    expect(readings[firstStable].value!).toBeGreaterThan(99);
    expect(result.slice(0, firstStable).every(s => !s.capturable)).toBe(true);
  });

  it('runs the simulated drifting rail without ever capturing it', () => {
    const result = runStability(simulateReadings(SIMULATED_SCENARIOS.drifting, { seed: 4 }));
    expect(result.some(s => s.capturable)).toBe(false);
  });
});

describe('over-range', () => {
  it('reports OL as its own state and does not capture it by default', () => {
    const result = runStability(series([null, null, null, null, null, null]));
    expect(result.every(s => s.state === 'overload' && !s.capturable && s.value === null && s.overload)).toBe(true);
  });

  it('captures a steady OL on request, once', () => {
    const result = runStability(series([null, null, null, null, null, null, null]), { acceptOverload: true });
    expect(result.map(s => s.capturable)).toEqual([false, false, false, false, true, true, true]);
    expect(result.map(s => s.fresh)).toEqual([false, false, false, false, true, false, false]);
    expect(result[4]).toMatchObject({ state: 'overload', value: null, overload: true });
  });

  it('is not steady when OL and numbers mix', () => {
    const mixed = runStability(series([3.3, 3.3, null, 3.3, 3.3, 3.3, 3.3, 3.3]));
    expect(mixed.map(s => s.state)).toEqual(['settling', 'settling', 'overload', 'settling', 'settling', 'settling', 'settling', 'stable']);
    const lifted = runStability(series([null, null, null, null, 3.3, 3.3, 3.3, 3.3, 3.3]));
    expect(lifted.map(s => s.state).slice(4)).toEqual(['settling', 'settling', 'settling', 'settling', 'stable']);
    // The first valid reading after OL is not stable on the strength of the readings before it.
    const dropped = runStability(series([3.3, 3.3, 3.3, 3.3, 3.3, null, 3.3]), { acceptOverload: true });
    expect(dropped[5]).toMatchObject({ state: 'overload', capturable: false });
    expect(dropped[6].capturable).toBe(false);
  });

  it('treats a display with no number as no reading and starts over', () => {
    const detector = createStabilityDetector();
    for (const r of series([3.3, 3.3, 3.3, 3.3, 3.3])) detector.push(r);
    const blank = detector.push(reading({ value: null, at: 500, flags: { invalid: true, ol: false } }));
    expect(blank).toMatchObject({ state: 'no-number', capturable: false, value: null, overload: false });
    expect(detector.push(reading({ value: 3.3, at: 600 })).samples).toBe(1);
  });
});

describe('mode mismatch', () => {
  it('warns when a diode capture meets a meter in volts, and does not capture', () => {
    const result = runStability(series([0.55, 0.55, 0.55, 0.55, 0.55, 0.55]), { captureMode: 'diode' });
    expect(result.every(s => s.state === 'mode-mismatch' && !s.capturable)).toBe(true);
    expect(last(result)).toMatchObject({ expected: 'diode', actual: 'voltage', value: 0.55, samples: 0 });
  });

  it('captures once the meter is in the right mode, with a fresh window', () => {
    const volts = series([0.55, 0.55, 0.55], {}, 100, 0);
    const diode = series([0.55, 0.55, 0.55, 0.55, 0.55], { mode: 'diode' }, 100, 300);
    const result = runStability([...volts, ...diode], { captureMode: 'diode' });
    expect(result.map(s => s.state)).toEqual([
      'mode-mismatch', 'mode-mismatch', 'mode-mismatch', 'settling', 'settling', 'settling', 'settling', 'stable',
    ]);
  });

  it('keeps continuity apart from resistance and DC apart from AC when asked', () => {
    expect(last(runStability(series([10, 10, 10, 10, 10], { mode: 'continuity', unit: 'Ω' }), { captureMode: 'resistance' }))).toMatchObject({
      state: 'mode-mismatch', expected: 'resistance', actual: 'continuity',
    });
    expect(last(runStability(series([10, 10, 10, 10, 10], { mode: 'resistance', unit: 'Ω' }), { captureMode: 'resistance' })).state).toBe('stable');
    const ac = last(runStability(series([5, 5, 5, 5, 5], { mode: 'acVolts' }), { captureMode: 'voltage', coupling: 'dc' }));
    expect(ac).toMatchObject({ state: 'mode-mismatch', expected: 'voltage', actual: 'voltage', expectedCoupling: 'dc' });
    expect(last(runStability(series([5, 5, 5, 5, 5], { mode: 'dcVolts' }), { captureMode: 'voltage', coupling: 'dc' })).state).toBe('stable');
    expect(last(runStability(series([5, 5, 5, 5, 5], { mode: 'acVolts' }), { captureMode: 'voltage' })).state).toBe('stable');
    expect(last(runStability(series([5, 5, 5, 5, 5], { mode: 'dcAmps', unit: 'A' }), { captureMode: 'voltage' })).state).toBe('mode-mismatch');
  });

  it('judges a mode it cannot name as a mismatch, and a guessed mode by its caveat', () => {
    expect(last(runStability(series([5, 5, 5, 5, 5], { mode: 'other', unit: 'dB' }), { captureMode: 'voltage' })).state).toBe('mode-mismatch');
    const guessed = series([0.5, 0.5, 0.5, 0.5, 0.5], { caveat: 'mode-ambiguous' });
    expect(last(runStability(guessed, { captureMode: 'diode' }))).toMatchObject({ state: 'blocked', block: 'caveat' });
    // Trusting the guess makes the mismatch a mismatch again.
    expect(last(runStability(guessed, { captureMode: 'diode', allowCaveats: true })).state).toBe('mode-mismatch');
    expect(last(runStability(guessed, { captureMode: 'voltage', allowCaveats: true })).state).toBe('stable');
  });

  it('restarts the window when the mode changes and nothing is expected', () => {
    const readings = [
      ...series([5, 5, 5, 5], {}, 100, 0),
      ...series([220, 220, 220], { mode: 'resistance', unit: 'Ω' }, 100, 400),
    ];
    const result = runStability(readings);
    expect(result.map(s => s.samples)).toEqual([1, 2, 3, 4, 1, 2, 3]);
    expect(states(series([20, 20, 20, 20, 20, 68, 68], { unit: '°C', mode: 'temperature' }).map((r, i) => (i >= 5 ? { ...r, unit: '°F' as MeterUnit } : r)))).toEqual([
      'settling', 'settling', 'settling', 'settling', 'stable', 'settling', 'settling',
    ]);
  });

  it('changes the target on the fly, emptying the window and re-arming', () => {
    const detector = createStabilityDetector({ captureMode: 'voltage' });
    for (const r of series([5, 5, 5, 5, 5])) detector.push(r);
    expect(detector.status.state).toBe('stable');
    detector.setTarget('diode');
    expect(detector.target).toEqual({ captureMode: 'diode', coupling: null });
    expect(detector.status.state).toBe('idle');
    expect(detector.push(reading({ value: 5, at: 600 })).state).toBe('mode-mismatch');
    detector.setTarget(null);
    for (const r of series([5, 5, 5, 5, 5], {}, 100, 700)) detector.push(r);
    expect(detector.status).toMatchObject({ state: 'stable', fresh: true });
  });
});

describe('readings that are not what the pad measures', () => {
  it('blocks relative mode, displayed minimum or maximum, and assumed modes or scales', () => {
    expect(last(runStability(series([5, 5, 5, 5, 5], { flags: { rel: true } })))).toMatchObject({ state: 'blocked', block: 'relative', capturable: false });
    expect(last(runStability(series([5, 5, 5, 5, 5], { flags: { max: true } })))).toMatchObject({ state: 'blocked', block: 'extreme' });
    expect(last(runStability(series([5, 5, 5, 5, 5], { flags: { min: true } })))).toMatchObject({ state: 'blocked', block: 'extreme' });
    expect(last(runStability(series([5, 5, 5, 5, 5], { caveat: 'scale-assumed' })))).toMatchObject({ state: 'blocked', block: 'caveat' });
    expect(last(runStability(series([5, 5, 5, 5, 5], { caveat: 'mode-ambiguous' })))).toMatchObject({ state: 'blocked', block: 'caveat' });
  });

  it('lets the caller trust an assumed scale', () => {
    expect(last(runStability(series([5, 5, 5, 5, 5], { caveat: 'scale-assumed' }), { allowCaveats: true })).state).toBe('stable');
    // Relative and extremes stay blocked whatever is allowed.
    expect(last(runStability(series([5, 5, 5, 5, 5], { flags: { rel: true } }), { allowCaveats: true })).state).toBe('blocked');
  });

  it('needs a fresh window after the block is gone', () => {
    const readings = [...series([5, 5, 5, 5], { flags: { rel: true } }), ...series([5, 5, 5, 5, 5], {}, 100, 400)];
    const result = runStability(readings);
    expect(result.slice(0, 4).every(s => s.state === 'blocked')).toBe(true);
    expect(result.slice(4).map(s => s.state)).toEqual(['settling', 'settling', 'settling', 'settling', 'stable']);
  });

  it('warns about HOLD and a low battery but still captures', () => {
    const result = last(runStability(series([5, 5, 5, 5, 5], { flags: { hold: true, lowBattery: true } })));
    expect(result).toMatchObject({ state: 'stable', capturable: true, warnings: ['hold', 'low-battery'] });
    expect(last(runStability(series([5, 5, 5, 5, 5]))).warnings).toEqual([]);
  });
});

describe('the capture edge', () => {
  it('is fresh once per stable episode', () => {
    const result = runStability(series(Array.from({ length: 12 }, () => 3.3)));
    expect(result.filter(s => s.fresh).length).toBe(1);
    expect(result.findIndex(s => s.fresh)).toBe(4);
    expect(result.slice(4).every(s => s.capturable)).toBe(true);
  });

  it('is fresh again after the value moved on and settled', () => {
    const readings = [...series([3.3, 3.3, 3.3, 3.3, 3.3, 3.3]), ...series([1.8, 1.8, 1.8, 1.8, 1.8, 1.8], {}, 100, 600)];
    const result = runStability(readings);
    expect(result.map((s, i) => (s.fresh ? i : -1)).filter(i => i >= 0)).toEqual([4, 10]);
    expect(result[10].value).toBe(1.8);
  });

  it('is fresh again after the probe was lifted (OL) even for the same value', () => {
    const readings = [...series([3.3, 3.3, 3.3, 3.3, 3.3]), ...series([null, null], {}, 100, 500), ...series([3.3, 3.3, 3.3, 3.3, 3.3], {}, 100, 700)];
    const result = runStability(readings);
    expect(result.filter(s => s.fresh).length).toBe(2);
  });

  it('rearm() makes the next stable evaluation fresh without the value moving', () => {
    const detector = createStabilityDetector();
    const feed = series(Array.from({ length: 10 }, () => 3.3));
    for (const r of feed.slice(0, 6)) detector.push(r);
    expect(detector.status).toMatchObject({ capturable: true, fresh: false });
    detector.rearm();
    expect(detector.push(feed[6])).toMatchObject({ capturable: true, fresh: true });
    expect(detector.push(feed[7]).fresh).toBe(false);
  });

  it('starts over on reset()', () => {
    const detector = createStabilityDetector();
    for (const r of series([3.3, 3.3, 3.3, 3.3, 3.3])) detector.push(r);
    detector.reset();
    expect(detector.status.state).toBe('idle');
    expect(detector.push(reading({ value: 3.3, at: 10 })).samples).toBe(1);
  });

  it('ignores non-finite timestamps instead of throwing', () => {
    const detector = createStabilityDetector();
    expect(() => detector.push(reading({ value: 3.3, at: Number.NaN }))).not.toThrow();
    expect(() => detector.push(reading({ value: 3.3, at: Infinity }))).not.toThrow();
  });
});

describe('with the simulated meter', () => {
  it('captures a stable rail once, a settling resistance late, and every pad of a probing run', () => {
    const rail = runStability(simulateReadings(SIMULATED_SCENARIOS.stable, { seed: 1 }));
    expect(rail.filter(s => s.fresh).length).toBe(1);

    const settling = simulateReadings(SIMULATED_SCENARIOS.settling, { seed: 1 });
    const settled = runStability(settling);
    const firstStable = settled.findIndex(s => s.fresh);
    expect(firstStable).toBeGreaterThan(10);
    expect(Math.abs(settling[firstStable].value! - 4700)).toBeLessThan(25);

    const probing = simulateReadings(SIMULATED_SCENARIOS.probing, { seed: 1 });
    const pads = runStability(probing, { captureMode: 'diode' }).filter(s => s.fresh).map(s => s.value!);
    expect(pads.length).toBe(3);
    expect(pads[0]).toBeCloseTo(0.4821, 3);
    expect(pads[1]).toBeCloseTo(0.4903, 3);
    expect(pads[2]).toBeCloseTo(0.0012, 3);
  });

  it('reports the mode mismatch of the mode-switch run until the meter reaches diode', () => {
    const readings = simulateReadings(SIMULATED_SCENARIOS.modeSwitch, { seed: 1 });
    const result = runStability(readings, { captureMode: 'diode' });
    const kinds = result.map((s, i) => (readings[i].mode === 'diode' ? s.state : 'mismatch:' + s.state));
    expect(kinds.filter(k => k.startsWith('mismatch')).every(k => k === 'mismatch:mode-mismatch')).toBe(true);
    expect(result.filter(s => s.fresh).length).toBe(1);
    expect(last(result)).toMatchObject({ state: 'stable', mode: 'diode' });
    // With no capture mode set, each mode captures in turn.
    expect(runStability(readings).filter(s => s.fresh).length).toBe(3);
  });

  it('captures a rail from UT61E bytes decoded with their arrival times', () => {
    const decoder = createEs51922Decoder();
    const detector = createStabilityDetector({ captureMode: 'voltage', coupling: 'dc' });
    const counts = [33001, 32999, 33000, 33002, 33000, 33001, 33000];
    const outcomes = counts.map((count, i) => {
      const frame = encodeEs51922Frame({ range: 1, count, func: 0x0b, dc: true, auto: true });
      const [decoded] = decoder.push(frame, 1000 + i * 400);
      return detector.push(decoded);
    });
    expect(outcomes.map(s => s.state)).toEqual(['settling', 'settling', 'settling', 'settling', 'stable', 'stable', 'stable']);
    expect(outcomes[4]).toMatchObject({ fresh: true, value: 33, unit: 'V' });
    expect(outcomes.filter(s => s.fresh).length).toBe(1);

    // The same bytes with the meter switched to AC volts are a mismatch for a DC capture.
    const ac = decoder.push(encodeEs51922Frame({ range: 1, count: 33000, func: 0x0b, ac: true, auto: true }), 5000);
    expect(detector.push(ac[0])).toMatchObject({ state: 'mode-mismatch', expectedCoupling: 'dc' });
  });
});
