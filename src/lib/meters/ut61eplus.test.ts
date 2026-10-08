import { describe, expect, it } from 'vitest';
import {
  buildUt61Command, createUt61EplusDecoder, encodeUt61EplusFrame, ut61Checksum, UT61EPLUS_FRAME_LENGTH, UT61EPLUS_INFO, UT61EPLUS_REQUEST,
} from './ut61eplus';

const HEX = (text: string): number[] => text.trim().split(/\s+/).map(byte => parseInt(byte, 16));

// DC volts, range 0, display " 4.5120": magic, length 0x10, mode 2, range '0', seven display bytes, two bar graph bytes, three flag bytes, checksum 0x03F4.
const DC_4_512 = HEX('AB CD 10 02 30 20 34 2E 35 31 32 30 30 30 30 30 30 03 F4');
const at = 5000;
const decodeOne = (bytes: ArrayLike<number>) => createUt61EplusDecoder().push(bytes, at);

describe('UT61E+ request and checksum', () => {
  it('builds the poll request byte for byte', () => {
    expect([...UT61EPLUS_REQUEST]).toEqual(HEX('AB CD 03 5E 01 D9'));
    expect([...buildUt61Command(0x5e)]).toEqual(HEX('AB CD 03 5E 01 D9'));
    expect([...buildUt61Command(0x5a, [0x01, 0x02])]).toEqual([0xab, 0xcd, 0x05, 0x5a, 0x01, 0x02, 0x01, 0xda]);
    expect(ut61Checksum(DC_4_512, 17)).toBe(0x03f4);
  });

  it('builds a reply frame that matches the hand-written one', () => {
    expect([...encodeUt61EplusFrame({ mode: 2, range: 0, display: ' 4.5120' })]).toEqual(DC_4_512);
    expect(UT61EPLUS_FRAME_LENGTH).toBe(19);
  });
});

describe('UT61E+ frames', () => {
  it('decodes DC volts', () => {
    const [reading] = decodeOne(DC_4_512);
    expect(reading).toMatchObject({ family: 'ut61eplus', mode: 'dcVolts', unit: 'V', value: 4.512, display: '4.5120', at });
    expect(reading.resolution).toBeCloseTo(1e-4, 14);
    expect(reading.flags).toMatchObject({ ol: false, hold: false, rel: false, auto: true });
    expect(reading.caveat).toBeUndefined();
  });

  const frame = (mode: number, range: number, display: string, f1 = 0, f2 = 0, f3 = 0) => [...encodeUt61EplusFrame({ mode, range, display, f1, f2, f3 })];

  // mode, range, display text -> mode, unit, value
  const TABLE: Array<[string, number[], string, string, number]> = [
    ['AC volts', frame(0, 1, '230.56'), 'acVolts', 'V', 230.56],
    ['AC millivolts', frame(1, 0, '12.345'), 'acVolts', 'V', 0.012345],
    ['DC millivolts', frame(3, 0, ' 85.12'), 'dcVolts', 'V', 0.08512],
    ['negative millivolts', frame(3, 0, '-85.12'), 'dcVolts', 'V', -0.08512],
    ['sign from the flag byte', frame(2, 0, ' 1.2345', 0, 0, 1), 'dcVolts', 'V', -1.2345],
    ['ohm', frame(6, 0, '123.45'), 'resistance', 'Ω', 123.45],
    ['kilohm range 1', frame(6, 1, ' 1.2345'), 'resistance', 'Ω', 1234.5],
    ['kilohm range 3', frame(6, 3, '123.45'), 'resistance', 'Ω', 123450],
    ['megohm range 4', frame(6, 4, ' 1.2345'), 'resistance', 'Ω', 1234500],
    ['megohm range 6', frame(6, 6, '123.45'), 'resistance', 'Ω', 123450000],
    ['continuity', frame(7, 0, ' 12.34'), 'continuity', 'Ω', 12.34],
    ['diode', frame(8, 0, ' 0.5123'), 'diode', 'V', 0.5123],
    ['capacitance nF', frame(9, 0, '4.7000'), 'capacitance', 'F', 4.7e-9],
    ['capacitance uF', frame(9, 2, '4.7000'), 'capacitance', 'F', 4.7e-6],
    ['capacitance mF', frame(9, 5, '4.7000'), 'capacitance', 'F', 4.7e-3],
    ['celsius', frame(10, 0, '  23.5'), 'temperature', '°C', 23.5],
    ['fahrenheit', frame(11, 0, '  74.3'), 'temperature', '°F', 74.3],
    ['DC microamps', frame(12, 0, '123.45'), 'dcAmps', 'A', 123.45e-6],
    ['AC milliamps', frame(15, 0, ' 12.345'), 'acAmps', 'A', 12.345e-3],
    ['DC amps', frame(16, 0, ' 1.2345'), 'dcAmps', 'A', 1.2345],
    ['duty', frame(5, 0, ' 50.0'), 'duty', '%', 50],
    ['transistor gain', frame(18, 0, '  123.'), 'transistorGain', '', 123],
    ['AC volts, low impedance', frame(21, 1, '230.56'), 'acVolts', 'V', 230.56],
    ['DC volts with an AC channel: the DC frame', frame(25, 0, ' 4.5120'), 'dcVolts', 'V', 4.512],
    ['DC volts with an AC channel: the AC frame', frame(25, 0, ' 0.0123', 0, 0, 8), 'acVolts', 'V', 0.0123],
  ];
  it.each(TABLE)('maps %s', (_name, bytes, mode, unit, value) => {
    const [reading] = decodeOne(bytes);
    expect(reading.mode).toBe(mode);
    expect(reading.unit).toBe(unit);
    expect(reading.value! / value).toBeCloseTo(1, 12);
  });

  it('reports over-range and blank displays', () => {
    const [ol] = decodeOne(frame(6, 3, ' OL.   '));
    expect(ol).toMatchObject({ mode: 'resistance', value: null, display: 'OL' });
    expect(ol.flags.ol).toBe(true);
    const [zeroL] = decodeOne(frame(8, 0, '  0L   '));
    expect(zeroL.flags.ol).toBe(true);
    const [blank] = decodeOne(frame(2, 0, '       '));
    expect(blank.value).toBeNull();
    expect(blank.flags).toMatchObject({ invalid: true, ol: false });
    const [ncv] = decodeOne(frame(20, 0, '   EF  '));
    expect(ncv).toMatchObject({ mode: 'ncv', value: null });
    expect(ncv.flags.invalid).toBe(true);
  });

  it('reads the flag bytes', () => {
    const [reading] = decodeOne(frame(2, 0, ' 4.5120', 0b0011, 0b0110, 0b0100));
    expect(reading.flags).toMatchObject({ rel: true, hold: true, lowBattery: true, auto: false, max: true, min: false });
    const [extremes] = decodeOne(frame(2, 0, ' 4.5120', 0b1100, 0b0000, 0b0010));
    expect(extremes.flags).toMatchObject({ min: true, max: true, auto: true });
  });

  it('marks the frequency scale as assumed', () => {
    const [low] = decodeOne(frame(4, 0, '50.000'));
    expect(low).toMatchObject({ mode: 'frequency', unit: 'Hz', value: 50, caveat: 'scale-assumed' });
    const [mid] = decodeOne(frame(4, 3, '10.000'));
    expect(mid.value).toBe(10000);
    const [high] = decodeOne(frame(4, 6, ' 1.2500'));
    expect(high.value).toBe(1250000);
  });

  it('drops a frame with an unknown mode', () => {
    const decoder = createUt61EplusDecoder();
    expect(decoder.push(frame(19, 0, ' 4.5120'))).toEqual([]);
    expect(decoder.stats.badFrames).toBe(1);
  });
});

describe('UT61E+ stream', () => {
  const STREAM = [...DC_4_512, ...encodeUt61EplusFrame({ mode: 6, range: 3, display: ' OL.   ' }), ...encodeUt61EplusFrame({ mode: 8, range: 0, display: ' 0.5123' })];

  it('gives the same readings in any chunking', () => {
    const run = (size: number) => {
      const decoder = createUt61EplusDecoder();
      const out = [];
      for (let i = 0; i < STREAM.length; i += size) out.push(...decoder.push(STREAM.slice(i, i + size), i));
      return { modes: out.map(r => [r.mode, r.value, r.flags.ol]), stats: decoder.stats };
    };
    const whole = run(STREAM.length);
    expect(whole.modes).toEqual([['dcVolts', 4.512, false], ['resistance', null, true], ['diode', 0.5123, false]]);
    expect(whole.stats).toMatchObject({ frames: 3, badFrames: 0, skippedBytes: 0, resyncs: 0 });
    for (const size of [1, 2, 3, 6, 10, 18, 19, 20, 37]) expect(run(size).modes, `chunk ${size}`).toEqual(whole.modes);
  });

  it('rejects a bad checksum and finds the next frame', () => {
    const decoder = createUt61EplusDecoder();
    const corrupt = [...DC_4_512];
    corrupt[8] ^= 0x01;
    const readings = decoder.push([...corrupt, ...DC_4_512]);
    expect(readings.length).toBe(1);
    expect(decoder.stats.badFrames).toBe(1);
    expect(decoder.stats.frames).toBe(1);
  });

  it('resynchronises on garbage, a half frame and a wrong length byte', () => {
    const decoder = createUt61EplusDecoder();
    const junk = [0x00, 0xab, 0x00, 0xcd, 0xab, 0xcd, 0x07, 0xff];
    const stream = [...junk, ...DC_4_512.slice(0, 11), ...DC_4_512, ...junk, ...DC_4_512];
    const readings = decoder.push(stream);
    expect(readings.map(r => r.value)).toEqual([4.512, 4.512]);
    expect(decoder.stats.frames).toBe(2);
    expect(decoder.stats.resyncs).toBeGreaterThan(0);
  });

  it('ignores the request echo and survives random bytes', () => {
    const decoder = createUt61EplusDecoder();
    expect(decoder.push([...UT61EPLUS_REQUEST, ...DC_4_512]).length).toBe(1);
    let seed = 99;
    for (let i = 0; i < 300; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const bytes = Array.from({ length: 1 + (seed % 30) }, (_, k) => ((seed >>> (k % 24)) ^ (k * 37)) & 0xff);
      expect(() => decoder.push(bytes)).not.toThrow();
    }
  });

  it('describes itself as experimental over HID', () => {
    expect(UT61EPLUS_INFO).toMatchObject({ id: 'ut61eplus', status: 'experimental', link: 'hid' });
  });
});
