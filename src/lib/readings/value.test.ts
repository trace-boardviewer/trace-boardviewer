import { describe, expect, it } from 'vitest';
import type { ReadingKind } from './schema';
import { formatReadingValue, parseReadingValue } from './value';

type Expected = number | 'OL' | boolean | 'empty' | 'unrecognized' | 'unit-mismatch' | 'out-of-range' | { mv: number };
const CASES: ReadonlyArray<readonly [ReadingKind, string, Expected]> = [
  // diode
  ['diode', '0.412', 0.412], ['diode', '0,412', 0.412], ['diode', '412m', 0.412], ['diode', '412 mV', 0.412], ['diode', '412mV', 0.412],
  ['diode', '.412', 0.412], ['diode', '0.412V', 0.412], ['diode', '0.412 v', 0.412], ['diode', '412MV', 0.412], ['diode', ' 0.412 ', 0.412],
  ['diode', '0', 0], ['diode', '1', 1], ['diode', '4', 4], ['diode', '0V4', 0.4], ['diode', '412', { mv: 0.412 }], ['diode', '4000', { mv: 4 }], ['diode', '0.65V', 0.65],
  ['diode', '4001', 'out-of-range'], ['diode', '12.5', 'out-of-range'], ['diode', '-0.1', 'out-of-range'], ['diode', 'OL', 'OL'], ['diode', 'ol', 'OL'],
  ['diode', 'O.L', 'OL'], ['diode', '0L', 'OL'], ['diode', '∞', 'OL'], ['diode', '0.5 ohm', 'unit-mismatch'], ['diode', '4k7', 'unit-mismatch'],
  ['diode', '', 'empty'], ['diode', '   ', 'empty'], ['diode', 'abc', 'unrecognized'], ['diode', '0.4.1', 'unrecognized'], ['diode', '1..2', 'unrecognized'],
  // voltage
  ['voltage', '3.3', 3.3], ['voltage', '3V3', 3.3], ['voltage', '1V05', 1.05], ['voltage', '-12V', -12], ['voltage', '+5', 5], ['voltage', '12 V', 12],
  ['voltage', '5v', 5], ['voltage', '18mV', 0.018], ['voltage', '3,3', 3.3], ['voltage', '1e-3', 0.001], ['voltage', '2.5e3', 2500], ['voltage', '1e3', 1000],
  ['voltage', '1.8μV', 1.8e-6], ['voltage', '1.8µV', 1.8e-6], ['voltage', '1.8uV', 1.8e-6], ['voltage', '-0', 0], ['voltage', '400', 400], ['voltage', '0.95', 0.95], ['voltage', '5.0V', 5],
  ['voltage', '3k3', 'unit-mismatch'], ['voltage', '5 ohm', 'unit-mismatch'], ['voltage', '1meg', 'unrecognized'], ['voltage', 'R005', 'unit-mismatch'],
  ['voltage', 'OL', 'OL'], ['voltage', '3.3 volts', 'unrecognized'], ['voltage', '3.3VV', 'unrecognized'],
  // resistance
  ['resistance', '10', 10], ['resistance', '22K', 22000], ['resistance', '0.1', 0.1], ['resistance', '4k7', 4700], ['resistance', '4K7', 4700], ['resistance', '4.7k', 4700], ['resistance', '4,7 kΩ', 4700],
  ['resistance', '4,7 kΩ', 4700], ['resistance', '2M2', 2.2e6], ['resistance', '2.2M', 2.2e6], ['resistance', '4R7', 4.7], ['resistance', '0R05', 0.05],
  ['resistance', 'R005', 0.005], ['resistance', '0R', 0], ['resistance', '10E', 10], ['resistance', '4E7', 4e7], ['resistance', '120 ohm', 120],
  ['resistance', '120ohms', 120], ['resistance', '120 Ohm', 120], ['resistance', '1.5mΩ', 0.0015], ['resistance', '1meg', 1e6], ['resistance', '1Meg', 1e6],
  ['resistance', '1megohm', 1e6], ['resistance', '10G', 1e10], ['resistance', '470n', 4.7e-7], ['resistance', 'OL', 'OL'], ['resistance', '-5', 'out-of-range'],
  ['resistance', '3V3', 'unit-mismatch'], ['resistance', '5 V', 'unit-mismatch'], ['resistance', '1e13', 'out-of-range'], ['resistance', '4k7k', 'unrecognized'],
  // continuity
  ['continuity', 'beep', true], ['continuity', 'yes', true], ['continuity', '1', true], ['continuity', 'short', true], ['continuity', 'Closed', true],
  ['continuity', 'no', false], ['continuity', '0', false], ['continuity', 'open', false], ['continuity', 'OL', false], ['continuity', 'maybe', 'unrecognized'], ['continuity', 'Y', true],
];

describe('parseReadingValue', () => {
  it.each(CASES)('%s %j', (kind, text, expected) => {
    const parsed = parseReadingValue(text, kind);
    if (typeof expected === 'number') expect(parsed).toEqual({ ok: true, value: expected, unit: kind === 'resistance' ? 'ohm' : 'V' });
    else if (typeof expected === 'object') expect(parsed).toEqual({ ok: true, value: expected.mv, unit: 'V', assumedMillivolts: true });
    else if (expected === 'OL') expect(parsed).toEqual({ ok: true, ol: true });
    else if (typeof expected === 'boolean') expect(parsed).toEqual({ ok: true, connected: expected });
    else expect(parsed).toEqual({ ok: false, reason: expected });
  });

  it('holds at least 100 table cases', () => expect(CASES.length).toBeGreaterThanOrEqual(100));

  it('composes the number in one conversion: 0.412 in any form is the same double', () => {
    const forms = ['0.412', '412m', '412 mV', '0,412', '.412', '412e-3', '0V412'];
    for (const form of forms) expect(parseReadingValue(form, 'diode')).toEqual({ ok: true, value: 0.412, unit: 'V' });
    expect(parseReadingValue('4.7k', 'resistance')).toEqual(parseReadingValue('4k7', 'resistance'));
  });

  it('refuses a bare millivolt diode number when asked to', () => {
    expect(parseReadingValue('412', 'diode', { bareDiodeMillivolts: false })).toEqual({ ok: false, reason: 'out-of-range' });
  });

  it('takes linear time: long and pathological texts are decided at once', () => {
    const inputs = ['1'.repeat(64), '1'.repeat(65), `${'1'.repeat(15)}.${'1'.repeat(15)}e999`, `${'9'.repeat(15)}k${'9'.repeat(15)}ohms`, '1'.repeat(1_000_000), `${'1,'.repeat(30)}x`, 'm'.repeat(63)];
    const started = performance.now();
    for (let round = 0; round < 2000; round++) for (const input of inputs) for (const kind of ['diode', 'voltage', 'resistance'] as const) parseReadingValue(input, kind);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(parseReadingValue('1'.repeat(1_000_000), 'voltage')).toEqual({ ok: false, reason: 'unrecognized' });
  });
});

describe('formatReadingValue', () => {
  it('writes three significant digits with SI prefixes; diode in volts with three decimals', () => {
    expect(formatReadingValue({ kind: 'diode', value: 0.412 })).toBe('0.412 V');
    expect(formatReadingValue({ kind: 'diode', ol: true })).toBe('OL');
    expect(formatReadingValue({ kind: 'voltage', value: 3.3 })).toBe('3.3 V');
    expect(formatReadingValue({ kind: 'voltage', value: 0.018 })).toBe('18 mV');
    expect(formatReadingValue({ kind: 'voltage', value: -12 })).toBe('-12 V');
    expect(formatReadingValue({ kind: 'resistance', value: 4700 })).toBe('4.7 kΩ');
    expect(formatReadingValue({ kind: 'resistance', value: 2.2e6 })).toBe('2.2 MΩ');
    expect(formatReadingValue({ kind: 'resistance', value: 0.0015 })).toBe('1.5 mΩ');
    expect(formatReadingValue({ kind: 'resistance', value: 0 })).toBe('0 Ω');
    expect(formatReadingValue({ kind: 'continuity', connected: true })).toBe('beep');
    expect(formatReadingValue({ kind: 'continuity', connected: false })).toBe('open');
  });
});
