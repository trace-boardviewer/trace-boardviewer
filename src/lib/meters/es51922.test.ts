import { describe, expect, it } from 'vitest';
import { createEs51922Decoder, decodeEs51922Frame, encodeEs51922Frame, ES51922_FRAME_LENGTH, ES51922_INFO, type Es51922FrameSpec } from './es51922';

/** Frames as the datasheet lays them out, written out by hand: range, five digits, function, four option nibbles, CR LF. */
const HEX = (text: string): number[] => text.trim().split(/\s+/).map(byte => parseInt(byte, 16));

// 12.345 V on the 22.000 V range, DC, auto range: option 3 is 0b1010 (DC, AUTO).
const DC_12_345 = HEX('31 31 32 33 34 35 3b 30 30 30 3a 30 0d 0a');
// -85.12 mV on the 220.00 mV range: status carries the sign bit (0b0100).
const DC_MINUS_85_12_MV = HEX('34 30 38 35 31 32 3b 34 30 30 3a 30 0d 0a');
// 1.2345 kohm on the 2.2000 kohm range, resistance function 0x3 (0b0011), no flags.
const OHM_1_2345K = HEX('31 31 32 33 34 35 33 30 30 30 30 30 0d 0a');
// Resistance over range: the overload bit (status 0b0001).
const OHM_OL = HEX('36 30 30 30 30 30 33 31 30 30 30 30 0d 0a');

const at = 1000;
function decode(bytes: number[]) {
  const decoder = createEs51922Decoder();
  return decoder.push(bytes, at);
}

describe('ES51922 frames from the datasheet layout', () => {
  it('has 14 bytes and a frame builder that agrees with the hand-written frames', () => {
    expect(ES51922_FRAME_LENGTH).toBe(14);
    expect([...encodeEs51922Frame({ range: 1, count: 12345, func: 0x0b, dc: true, auto: true })]).toEqual(DC_12_345);
    expect([...encodeEs51922Frame({ range: 4, count: 8512, func: 0x0b, negative: true, dc: true, auto: true })]).toEqual(DC_MINUS_85_12_MV);
    expect([...encodeEs51922Frame({ range: 1, count: 12345, func: 0x03 })]).toEqual(OHM_1_2345K);
    expect([...encodeEs51922Frame({ range: 6, count: 0, func: 0x03, overload: true })]).toEqual(OHM_OL);
  });

  it('decodes DC volts with the scale of the range', () => {
    const [reading] = decode(DC_12_345);
    expect(reading).toMatchObject({ family: 'ut61e', mode: 'dcVolts', unit: 'V', value: 12.345, resolution: 0.001, display: '12.345', at });
    expect(reading.flags).toMatchObject({ auto: true, ol: false, hold: false, rel: false, lowBattery: false, invalid: false });
    expect(reading.caveat).toBeUndefined();
  });

  it('decodes a negative millivolt reading', () => {
    const [reading] = decode(DC_MINUS_85_12_MV);
    expect(reading.value).toBe(-0.08512);
    expect(reading.display).toBe('-85.12'); // the number on the LCD, which shows millivolts
    expect(reading.resolution).toBeCloseTo(1e-5, 12);
    expect(reading.mode).toBe('dcVolts');
  });

  it('decodes resistance and its over-range display', () => {
    const [ohm] = decode(OHM_1_2345K);
    expect(ohm).toMatchObject({ mode: 'resistance', unit: 'Ω', value: 1234.5, display: '1.2345' });
    expect(ohm.resolution).toBeCloseTo(0.1, 12);
    const [ol] = decode(OHM_OL);
    expect(ol).toMatchObject({ mode: 'resistance', unit: 'Ω', value: null, display: 'OL' });
    expect(ol.flags.ol).toBe(true);
    expect(ol.flags.invalid).toBe(false);
  });

  // range, count, function, extra flags -> mode, unit, value
  const FUNCTIONS: Array<[string, Es51922FrameSpec, string, string, number]> = [
    ['AC volts', { range: 2, count: 23056, func: 0x0b, ac: true, auto: true }, 'acVolts', 'V', 230.56],
    ['AC+DC volts', { range: 1, count: 1250, func: 0x0b, ac: true, dc: true }, 'acdcVolts', 'V', 1.25],
    ['1000 V range', { range: 3, count: 10005, func: 0x0b, dc: true }, 'dcVolts', 'V', 1000.5],
    ['220 mV range', { range: 4, count: 12000, func: 0x0b, dc: true }, 'dcVolts', 'V', 0.12],
    ['2.2 V range', { range: 0, count: 15000, func: 0x0b, dc: true }, 'dcVolts', 'V', 1.5],
    ['microamps', { range: 0, count: 15025, func: 0x0d, dc: true }, 'dcAmps', 'A', 0.00015025],
    ['microamps range 1', { range: 1, count: 12345, func: 0x0d, dc: true }, 'dcAmps', 'A', 0.0012345],
    ['milliamps', { range: 0, count: 12345, func: 0x0f, dc: true }, 'dcAmps', 'A', 0.012345],
    ['milliamps range 1', { range: 1, count: 12345, func: 0x0f, ac: true }, 'acAmps', 'A', 0.12345],
    ['22 A', { range: 0, count: 10500, func: 0x00, dc: true }, 'dcAmps', 'A', 10.5],
    ['diode', { range: 0, count: 5123, func: 0x01 }, 'diode', 'V', 0.5123],
    ['continuity', { range: 0, count: 3120, func: 0x05 }, 'continuity', 'Ω', 31.2],
    ['capacitance nF', { range: 0, count: 4700, func: 0x06 }, 'capacitance', 'F', 4.7e-9],
    ['capacitance uF', { range: 3, count: 10000, func: 0x06 }, 'capacitance', 'F', 1e-5],
    ['capacitance mF', { range: 7, count: 12000, func: 0x06 }, 'capacitance', 'F', 0.12],
    ['frequency Hz', { range: 0, count: 5000, func: 0x02, judge: true }, 'frequency', 'Hz', 5],
    ['frequency kHz', { range: 3, count: 10000, func: 0x02, judge: true }, 'frequency', 'Hz', 10000],
    ['frequency MHz', { range: 5, count: 12500, func: 0x02, judge: true }, 'frequency', 'Hz', 1250000],
    ['frequency top range', { range: 7, count: 12000, func: 0x02, judge: true }, 'frequency', 'Hz', 1.2e8],
    ['duty cycle', { range: 0, count: 500, func: 0x02 }, 'duty', '%', 50],
    ['resistance 220 ohm range', { range: 0, count: 10025, func: 0x03 }, 'resistance', 'Ω', 100.25],
    ['resistance 22 Mohm range', { range: 5, count: 12345, func: 0x03 }, 'resistance', 'Ω', 12345000],
    ['resistance 220 Mohm range', { range: 6, count: 12000, func: 0x03 }, 'resistance', 'Ω', 120000000],
  ];
  it.each(FUNCTIONS)('maps %s', (_name, spec, mode, unit, value) => {
    const [reading] = decode([...encodeEs51922Frame(spec)]);
    expect(reading.mode).toBe(mode);
    expect(reading.unit).toBe(unit);
    expect(reading.value).toBeCloseTo(value, 12);
    expect(reading.value! / value).toBeCloseTo(1, 12);
  });

  it('reads the status and option bits as flags', () => {
    const [reading] = decode([...encodeEs51922Frame({
      range: 1, count: 100, func: 0x0b, dc: true, battery: true, hold: true, rel: true, max: true, min: true,
    })]);
    expect(reading.flags).toMatchObject({ hold: true, rel: true, max: true, min: true, lowBattery: true, auto: false });
    const [peaks] = decode([...encodeEs51922Frame({ range: 1, count: 100, func: 0x0b, ac: true, pmax: true })]);
    expect(peaks.flags.max).toBe(true);
    expect(peaks.flags.min).toBe(false);
    const [low] = decode([...encodeEs51922Frame({ range: 1, count: 100, func: 0x0b, ac: true, pmin: true })]);
    expect(low.flags.min).toBe(true);
  });

  it('marks volts without DC or AC as ambiguous and the assumed scales as such', () => {
    const [bare] = decode([...encodeEs51922Frame({ range: 1, count: 100, func: 0x0b })]);
    expect(bare.caveat).toBe('mode-ambiguous');
    const [duty] = decode([...encodeEs51922Frame({ range: 0, count: 500, func: 0x02 })]);
    expect(duty.caveat).toBe('scale-assumed');
    const [manual] = decode([...encodeEs51922Frame({ range: 0, count: 12000, func: 0x09, dc: true })]);
    expect(manual).toMatchObject({ mode: 'dcAmps', unit: 'A', value: 12, caveat: 'scale-assumed' });
  });

  it('gives an invalid reading for the functions a UT61E does not have', () => {
    const [temperature] = decode([...encodeEs51922Frame({ range: 0, count: 250, func: 0x04 })]);
    expect(temperature).toMatchObject({ mode: 'temperature', value: null });
    expect(temperature.flags.invalid).toBe(true);
    const [adp] = decode([...encodeEs51922Frame({ range: 0, count: 250, func: 0x0e })]);
    expect(adp.flags.invalid).toBe(true);
  });

  it('drops frames that name a function or range the datasheet does not define', () => {
    const decoder = createEs51922Decoder();
    expect(decoder.push([...encodeEs51922Frame({ range: 0, count: 1, func: 0x07 })])).toEqual([]);
    expect(decoder.push([...encodeEs51922Frame({ range: 5, count: 1, func: 0x0b, dc: true })])).toEqual([]);
    expect(decoder.stats.badFrames).toBe(2);
    expect(decodeEs51922Frame(encodeEs51922Frame({ range: 7, count: 1, func: 0x0d }), 0)).toBeNull();
    // A digit nibble above 9 is not a number.
    const broken = [...DC_12_345];
    broken[3] = 0x3c;
    expect(decoder.push(broken)).toEqual([]);
    expect(decoder.stats.badFrames).toBe(3);
  });
});

describe('ES51922 stream', () => {
  const MODE_SWITCH = [
    ...encodeEs51922Frame({ range: 1, count: 33000, func: 0x0b, dc: true, auto: true }),
    ...encodeEs51922Frame({ range: 3, count: 4700, func: 0x03, auto: true }),
    ...encodeEs51922Frame({ range: 0, count: 5123, func: 0x01 }),
    ...encodeEs51922Frame({ range: 6, count: 0, func: 0x03, overload: true }),
    ...encodeEs51922Frame({ range: 1, count: 33010, func: 0x0b, dc: true, auto: true }),
  ];
  const summary = (bytes: number[], chunk: number) => {
    const decoder = createEs51922Decoder();
    const readings = [];
    for (let i = 0; i < bytes.length; i += chunk) readings.push(...decoder.push(bytes.slice(i, i + chunk), i));
    return { readings: readings.map(r => ({ mode: r.mode, value: r.value, ol: r.flags.ol })), stats: { ...decoder.stats } };
  };

  it('follows mode changes, over-range and back', () => {
    const { readings } = summary(MODE_SWITCH, MODE_SWITCH.length);
    expect(readings).toEqual([
      { mode: 'dcVolts', value: 33, ol: false },
      { mode: 'resistance', value: 47000, ol: false },
      { mode: 'diode', value: 0.5123, ol: false },
      { mode: 'resistance', value: null, ol: true },
      { mode: 'dcVolts', value: 33.01, ol: false },
    ]);
  });

  it('gives the same readings whatever the chunk size', () => {
    const whole = summary(MODE_SWITCH, MODE_SWITCH.length);
    for (const chunk of [1, 2, 3, 5, 7, 13, 14, 15, 27, 29]) {
      const split = summary(MODE_SWITCH, chunk);
      expect(split.readings, `chunk ${chunk}`).toEqual(whole.readings);
      expect(split.stats.frames).toBe(5);
      expect(split.stats.skippedBytes).toBe(0);
    }
    expect(whole.stats).toMatchObject({ bytes: 70, frames: 5, readings: 5, badFrames: 0, skippedBytes: 0, resyncs: 0 });
  });

  it('stamps readings with the arrival time of their chunk, or the decoder clock', () => {
    let clock = 500;
    const decoder = createEs51922Decoder({ now: () => clock++ });
    expect(decoder.push(DC_12_345)[0].at).toBe(500);
    expect(decoder.push(DC_12_345)[0].at).toBe(501);
    expect(decoder.push(DC_12_345, 9999)[0].at).toBe(9999);
  });

  it('resynchronises after garbage and counts it', () => {
    const noise = [0x00, 0xff, 0x41, 0x0d, 0x0a, 0x7f, 0x31, 0x32];
    const stream = [...noise, ...DC_12_345, ...noise, ...noise, ...OHM_1_2345K, 0xaa];
    const decoder = createEs51922Decoder();
    const readings = decoder.push(stream);
    expect(readings.map(r => r.mode)).toEqual(['dcVolts', 'resistance']);
    expect(decoder.stats.frames).toBe(2);
    // Three runs of garbage: before the first frame, between the frames, and the byte after the last one.
    expect(decoder.stats.resyncs).toBe(3);
    expect(decoder.stats.skippedBytes).toBe(noise.length * 3 + 1);
  });

  it('drops a truncated frame and still finds the next one', () => {
    const decoder = createEs51922Decoder();
    const cut = DC_12_345.slice(0, 9);
    const readings = decoder.push([...cut, ...OHM_1_2345K, ...DC_12_345]);
    expect(readings.map(r => r.mode)).toEqual(['resistance', 'dcVolts']);
    expect(decoder.stats.frames).toBe(2);
  });

  it('drops a frame whose end is not CR LF', () => {
    const decoder = createEs51922Decoder();
    const broken = [...DC_12_345];
    broken[12] = 0x30;
    expect(decoder.push([...broken, ...DC_12_345]).length).toBe(1);
    const noLf = [...DC_12_345];
    noLf[13] = 0x0d;
    expect(decoder.push([...noLf, ...OHM_1_2345K]).map(r => r.mode)).toEqual(['resistance']);
  });

  it('reads 7O1 bytes with or without the parity bit left in', () => {
    const odd = (byte: number): number => {
      let ones = 0;
      for (let b = byte & 0x7f; b; b >>= 1) ones += b & 1;
      return ones % 2 === 0 ? byte | 0x80 : byte;
    };
    const withParity = DC_12_345.map(odd);
    expect(withParity.some(byte => byte & 0x80)).toBe(true);
    expect(createEs51922Decoder().push(withParity)[0].value).toBe(12.345);
    expect(createEs51922Decoder({ stripParity: false }).push(withParity)).toEqual([]);
    expect(createEs51922Decoder({ stripParity: false }).push(DC_12_345)[0].value).toBe(12.345);
  });

  it('survives random bytes, huge chunks and reset', () => {
    let seed = 12345;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
    const decoder = createEs51922Decoder();
    for (let round = 0; round < 200; round++) {
      const bytes = Array.from({ length: 1 + (random() % 40) }, () => random() & 0xff);
      expect(() => decoder.push(bytes)).not.toThrow();
    }
    const big = new Uint8Array(50000).fill(0x31);
    expect(decoder.push(big)).toEqual([]);
    expect(decoder.push(DC_12_345)[0].value).toBe(12.345);
    decoder.push(DC_12_345.slice(0, 6));
    decoder.reset();
    expect(decoder.push(DC_12_345.slice(6)).length).toBe(0);
    expect(decoder.push(OHM_1_2345K)[0].mode).toBe('resistance');
  });

  it('describes itself as experimental', () => {
    expect(ES51922_INFO).toMatchObject({ id: 'ut61e', status: 'experimental', link: 'serial' });
    expect(ES51922_INFO.documents.join(' ')).toMatch(/ES51922/);
  });
});
