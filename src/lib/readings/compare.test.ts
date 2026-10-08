import { describe, expect, it } from 'vitest';
import { DEFAULT_TOLERANCES, compareAll, compareReading, indexReferences, isShortSuspect, latestMeasured, summarizeByNet } from './compare';
import { validateReading } from './schema';
import type { Reading, ReadingKind } from './schema';

let counter = 0;
/** A reading: kind, value (number, 'OL' or a boolean for continuity), and overrides. */
function r(kind: ReadingKind, value: number | 'OL' | boolean, extra: Record<string, unknown> = {}): Reading {
  const raw: Record<string, unknown> = { id: `x${++counter}`, kind, target: { net: 'PP3V3_S5' }, conditions: { power: kind === 'voltage' ? 'powered' : 'unpowered' }, source: 'measured' };
  if (typeof value === 'boolean') raw.connected = value;
  else if (value === 'OL') raw.ol = true;
  else { raw.value = value; raw.unit = kind === 'resistance' ? 'ohm' : 'V'; }
  return validateReading({ ...raw, ...extra });
}
const good = (kind: ReadingKind, value: number | 'OL' | boolean, extra: Record<string, unknown> = {}) => r(kind, value, { source: 'known-good', ...extra });

describe('compareReading: tolerance, OL, near zero and edges', () => {
  it.each([
    // kind, reference, measured, status
    ['diode', 0.412, 0.432, 'pass'], ['diode', 0.412, 0.392, 'pass'], ['diode', 0.412, 0.4327, 'fail'], ['diode', 0.1, 0.12, 'pass'], ['diode', 0.1, 0.1201, 'fail'],
    ['diode', 0.6, 0.63, 'pass'], ['diode', 0.6, 0.6301, 'fail'],
    ['voltage', 1, 1.05, 'pass'], ['voltage', 1, 0.95, 'pass'], ['voltage', 1, 1.0500001, 'fail'], ['voltage', 0, 0.05, 'pass'], ['voltage', 0, 0.0501, 'fail'],
    ['voltage', 12, 12.6, 'pass'], ['voltage', 12, 12.61, 'fail'], ['voltage', -12, -12.6, 'pass'], ['voltage', 3.3, 0, 'fail'],
    ['resistance', 100, 110, 'pass'], ['resistance', 100, 110.01, 'fail'], ['resistance', 100, 90, 'pass'], ['resistance', 0, 0.5, 'pass'], ['resistance', 0, 0.51, 'fail'],
    ['resistance', 4, 4.5, 'pass'], ['resistance', 4, 4.51, 'fail'], ['resistance', 0, 0, 'pass'],
  ] as const)('%s reference %d, measured %d: %s', (kind, reference, measured, status) => {
    expect(compareReading(r(kind, measured), good(kind, reference)).status).toBe(status);
  });

  it('uses max(abs, rel x |reference|) with the defaults of the kind, and the reference\'s own tolerance instead when it has one', () => {
    expect(DEFAULT_TOLERANCES).toEqual({ diode: { abs: 0.02, rel: 0.05 }, voltage: { abs: 0.05, rel: 0.05 }, resistance: { abs: 0.5, rel: 0.1 } });
    const result = compareReading(r('voltage', 3.4), good('voltage', 3.3));
    expect(result.deviation).toBeCloseTo(0.1, 12);
    expect(result.allowed).toBeCloseTo(0.165, 12);
    expect(result.score).toBeCloseTo(0.1 / 0.165, 12);
    expect(compareReading(r('voltage', 3.4), good('voltage', 3.3, { tolerance: { rel: 0.01 } })).status).toBe('fail');
    expect(compareReading(r('voltage', 3.4), good('voltage', 3.3, { tolerance: { abs: 0.2 } })).status).toBe('pass');
    expect(compareReading(r('voltage', 3.4), good('voltage', 3.3), { tolerances: { voltage: { abs: 0, rel: 0.01 } } }).status).toBe('fail');
  });

  it('OL: OL against OL passes, OL against a number and a number against OL fail with an infinite score', () => {
    expect(compareReading(r('diode', 'OL'), good('diode', 'OL'))).toEqual({ status: 'pass', flags: [], deviation: null, allowed: null, score: 0 });
    expect(compareReading(r('diode', 'OL'), good('diode', 0.4))).toEqual({ status: 'fail', flags: ['unexpected-open'], deviation: null, allowed: null, score: Infinity });
    expect(compareReading(r('diode', 0.45), good('diode', 'OL'))).toEqual({ status: 'fail', flags: ['unexpected-value'], deviation: null, allowed: null, score: Infinity });
    expect(compareReading(r('diode', 0.002), good('diode', 'OL')).flags).toEqual(['unexpected-value', 'short-suspect']);
  });

  it('near zero: a failing diode value under 50 mV or resistance under 1 ohm against a reference at least twice that is a short suspect', () => {
    expect(compareReading(r('diode', 0.002), good('diode', 0.4)).flags).toEqual(['short-suspect']);
    expect(compareReading(r('diode', 0.002), good('diode', 0.06)).flags).toEqual([]);
    expect(compareReading(r('diode', 0.049), good('diode', 0.1)).flags).toEqual(['short-suspect']);
    expect(compareReading(r('diode', 0.05), good('diode', 0.3)).flags).toEqual([]);
    expect(compareReading(r('resistance', 0.3), good('resistance', 50)).flags).toEqual(['short-suspect']);
    expect(compareReading(r('resistance', 0.3), good('resistance', 0.4)).status).toBe('pass');
    expect(compareReading(r('voltage', 0.001), good('voltage', 3.3)).flags).toEqual([]);
    expect(compareReading(r('diode', 0), good('diode', 0)).score).toBe(0);
  });

  it('continuity passes when connected is equal; different kinds are incomparable', () => {
    expect(compareReading(r('continuity', true), good('continuity', true)).status).toBe('pass');
    expect(compareReading(r('continuity', false), good('continuity', true))).toMatchObject({ status: 'fail', score: Infinity });
    expect(compareReading(r('diode', 0.4), good('voltage', 0.4)).status).toBe('incomparable');
  });
});

describe('pairing', () => {
  const pin = (extra: Record<string, unknown> = {}) => ({ target: { ref: 'U7', pin: '3', net: 'PP3V3_S5' }, ...extra });
  it('pairs the same target, kind and conditions; a pin reading also pairs with a net reference on its net', () => {
    const netRef = good('diode', 0.4);
    const index = indexReferences([netRef]);
    expect(index.find(r('diode', 0.41, pin()))).toEqual({ reference: netRef, viaNet: true, candidates: 1 });
    expect(index.find(r('diode', 0.41, { target: { ref: 'U7', pin: '3' } }))).toBeNull();
    expect(indexReferences([netRef], { netOf: () => 'PP3V3_S5' }).find(r('diode', 0.41, { target: { ref: 'U7', pin: '3' } }))?.viaNet).toBe(true);
    expect(indexReferences([netRef], { netOf: () => 'OTHER' }).find(r('diode', 0.41, pin()))).toBeNull();
    expect(index.find(r('voltage', 0.41))).toBeNull();
    expect(index.find(r('diode', 0.41, { conditions: { power: 'powered' } }))).toBeNull();
  });

  it('conditions: state ignoring case; ground named or absent is the same reference point; dc is the default meter mode; polarity loosely', () => {
    const reference = good('voltage', 1.8, { conditions: { power: 'powered', state: 'S0', reference: { net: 'GND' }, meterMode: 'dc' } });
    const index = indexReferences([reference]);
    expect(index.find(r('voltage', 1.8, { conditions: { power: 'powered', state: 's0' } }))?.reference).toBe(reference);
    expect(index.find(r('voltage', 1.8, { conditions: { power: 'powered', state: 'S3' } }))).toBeNull();
    expect(index.find(r('voltage', 1.8, { conditions: { power: 'powered', state: 'S0', reference: { net: 'PP1V8' } } }))).toBeNull();
    expect(index.find(r('voltage', 1.8, { conditions: { power: 'powered', state: 'S0', meterMode: 'ac' } }))).toBeNull();
    const diode = good('diode', 0.4, { conditions: { power: 'unpowered', polarity: 'red-on-reference' } });
    const diodes = indexReferences([diode]);
    expect(diodes.find(r('diode', 0.4, { conditions: { power: 'unpowered', polarity: 'black-on-reference' } }))).toBeNull();
    const loose = r('diode', 0.4);
    expect(diodes.find(loose)?.reference).toBe(diode);
    expect(compareReading(loose, diode).flags).toEqual(['polarity-assumed']);
  });

  it('prefers known-good over imported, a pin reference over a net reference, then the later time, then the smaller id', () => {
    const imported = r('diode', 0.5, { source: 'imported', license: 'ODbL-1.0', provenance: { origin: 'openboarddata' }, target: { ref: 'U7', pin: '3' } });
    const netGood = good('diode', 0.4);
    const pinGood = good('diode', 0.45, { target: { ref: 'U7', pin: '3' }, takenAt: '2026-01-01T00:00Z' });
    const pinLater = good('diode', 0.46, { target: { ref: 'U7', pin: '3' }, takenAt: '2026-06-01T00:00Z' });
    const measured = r('diode', 0.45, pin());
    expect(indexReferences([imported, netGood]).find(measured)?.reference).toBe(netGood);
    expect(indexReferences([netGood, pinGood]).find(measured)?.reference).toBe(pinGood);
    expect(indexReferences([pinGood, pinLater, netGood, imported]).find(measured)).toMatchObject({ reference: pinLater, candidates: 4 });
  });

  it('only the latest measured reading of a target and condition set counts', () => {
    const early = r('voltage', 1, { takenAt: '2026-10-07T10:00Z' });
    const late = r('voltage', 2, { takenAt: '2026-10-07T11:00Z' });
    expect(latestMeasured([late, early])).toEqual([late]);
    expect(latestMeasured([early, late])).toEqual([late]);
    const other = r('voltage', 3, { conditions: { power: 'powered', state: 'S5' } });
    expect(latestMeasured([early, other]).length).toBe(2);
  });
});

describe('compareAll and summarizeByNet', () => {
  it('lists every current measured reading, the out-of-tolerance ones worst first, the ones without a reference and the short suspects', () => {
    const readings = [
      good('diode', 0.4), good('diode', 0.5, { target: { net: 'PP1V8' } }), good('diode', 0.3, { target: { net: 'PP5V' } }),
      r('diode', 0.41), r('diode', 0.002, { target: { net: 'PP1V8' } }), r('diode', 0.36, { target: { net: 'PP5V' } }),
      r('diode', 0.01, { target: { net: 'PP_NEW' } }), r('diode', 0.01, { target: { net: 'GND' } }), r('voltage', 3.3, { target: { net: 'PP3V3' } }),
    ];
    const report = compareAll(readings);
    expect(report.counts).toEqual({ pass: 1, fail: 2, incomparable: 0, missing: 3 });
    expect(report.outOfTolerance.map(row => row.measured.target.net)).toEqual(['PP1V8', 'PP5V']);
    expect(report.outOfTolerance[0].result!.score).toBeGreaterThan(report.outOfTolerance[1].result!.score);
    expect(report.missingReference.map(reading => reading.target.net)).toEqual(['PP_NEW', 'GND', 'PP3V3']);
    expect(report.shortSuspects.map(reading => reading.target.net)).toEqual(['PP1V8', 'PP_NEW']);
    const nets = summarizeByNet(report.rows);
    expect(nets.get('PP3V3_S5')).toEqual({ status: 'pass', worstScore: 0, rows: 1 });
    expect(nets.get('PP1V8')?.status).toBe('fail');
  });

  it('a net fails when any pin on it fails', () => {
    const readings = [good('diode', 0.4), r('diode', 0.41, { target: { ref: 'U1', pin: '1', net: 'PP3V3_S5' } }), r('diode', 0.9, { target: { ref: 'U2', pin: '4', net: 'PP3V3_S5' } })];
    const nets = summarizeByNet(compareAll(readings).rows);
    expect(nets.get('PP3V3_S5')).toMatchObject({ status: 'fail', rows: 2 });
  });

  it('isShortSuspect: low diode or resistance against ground on a net that is not ground; never OL, voltage or continuity', () => {
    expect(isShortSuspect(r('diode', 0.01))).toBe(true);
    expect(isShortSuspect(r('resistance', 0.4))).toBe(true);
    expect(isShortSuspect(r('resistance', 1))).toBe(false);
    expect(isShortSuspect(r('diode', 0.01, { target: { net: 'GND' } }))).toBe(false);
    expect(isShortSuspect(r('diode', 0.01, { conditions: { power: 'unpowered', reference: { net: 'PP1V8' } } }))).toBe(false);
    expect(isShortSuspect(r('diode', 0.01, { conditions: { power: 'unpowered', reference: { net: 'AGND' } } }))).toBe(true);
    expect(isShortSuspect(r('diode', 'OL'))).toBe(false);
    expect(isShortSuspect(r('voltage', 0))).toBe(false);
    expect(isShortSuspect(r('continuity', true))).toBe(false);
  });
});
