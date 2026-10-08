import { describe, expect, it } from 'vitest';
import { createOwonB35Decoder, decodeOwonB35Notification, encodeOwonB35Frame, OWON_B35_BLE, OWON_B35_FRAME_LENGTH, OWON_B35_INFO } from './owon-b35';

const HEX = (text: string): number[] => text.trim().split(/\s+/).map(byte => parseInt(byte, 16));
const at = 7000;
const decodeOne = (bytes: ArrayLike<number>) => createOwonB35Decoder().push(bytes, at);

// Notifications written out by hand from the word layout: word 0 = 0xF000 | function << 6 | scale << 3 | decimals,
// word 1 = flags, word 2 = count with the sign in bit 15; all little endian.
const DC_1_234 = HEX('23 F0 04 00 D2 04'); // DC volts, no prefix, 3 decimals, auto range, count 1234
const DC_MINUS_1_234 = HEX('23 F0 04 00 D2 84');
const OHM_4_7K = HEX('2B F1 04 00 5C 12'); // ohm, kilo, 3 decimals, count 4700
const OHM_OL = HEX('2C F1 04 00 00 00'); // 4 decimals is the over-range display

describe('OWON B35T+ notifications', () => {
  it('has six bytes and the documented GATT ids', () => {
    expect(OWON_B35_FRAME_LENGTH).toBe(6);
    expect(OWON_B35_BLE).toEqual({ service: 0xfff0, notifyCharacteristic: 0xfff4, controlCharacteristic: 0xfff3 });
  });

  it('builds frames that match the hand-written ones', () => {
    expect([...encodeOwonB35Frame({ func: 0, scale: 4, decimals: 3, count: 1234, flags: 4 })]).toEqual(DC_1_234);
    expect([...encodeOwonB35Frame({ func: 0, scale: 4, decimals: 3, count: 1234, flags: 4, negative: true })]).toEqual(DC_MINUS_1_234);
    expect([...encodeOwonB35Frame({ func: 4, scale: 5, decimals: 3, count: 4700, flags: 4 })]).toEqual(OHM_4_7K);
    expect([...encodeOwonB35Frame({ func: 4, scale: 5, decimals: 4, count: 0, flags: 4 })]).toEqual(OHM_OL);
  });

  it('decodes DC volts, positive and negative', () => {
    const [reading] = decodeOne(DC_1_234);
    expect(reading).toMatchObject({ family: 'owon-b35', mode: 'dcVolts', unit: 'V', value: 1.234, display: '1.234', at });
    expect(reading.resolution).toBeCloseTo(0.001, 12);
    expect(reading.flags).toMatchObject({ auto: true, hold: false, ol: false });
    const [negative] = decodeOne(DC_MINUS_1_234);
    expect(negative.value).toBe(-1.234);
    expect(negative.display).toBe('-1.234');
  });

  it('applies the unit prefix', () => {
    expect(decodeOne(OHM_4_7K)[0]).toMatchObject({ mode: 'resistance', unit: 'Ω', value: 4700 });
    const [cap] = decodeOne(encodeOwonB35Frame({ func: 5, scale: 1, decimals: 2, count: 4712 }));
    expect(cap).toMatchObject({ mode: 'capacitance', unit: 'F' });
    expect(cap.value! / 4.712e-8).toBeCloseTo(1, 12);
    expect(decodeOne(encodeOwonB35Frame({ func: 0, scale: 3, decimals: 2, count: 1234 }))[0].value).toBe(0.01234);
    expect(decodeOne(encodeOwonB35Frame({ func: 4, scale: 6, decimals: 1, count: 1234 }))[0].value).toBe(123400000);
    expect(decodeOne(encodeOwonB35Frame({ func: 5, scale: 2, decimals: 3, count: 1000 }))[0].value! / 1e-6).toBeCloseTo(1, 12);
    // Scale code 0 and 4 both mean "no prefix".
    expect(decodeOne(encodeOwonB35Frame({ func: 0, scale: 0, decimals: 1, count: 33 }))[0].value).toBe(3.3);
  });

  const FUNCTIONS: Array<[number, string, string, number]> = [
    [0, 'dcVolts', 'V', 1.5], [1, 'acVolts', 'V', 1.5], [2, 'dcAmps', 'A', 1.5], [3, 'acAmps', 'A', 1.5], [4, 'resistance', 'Ω', 1.5],
    [5, 'capacitance', 'F', 1.5], [6, 'frequency', 'Hz', 1.5], [7, 'duty', '%', 1.5], [8, 'temperature', '°C', 1.5],
    [9, 'temperature', '°F', 1.5], [10, 'diode', 'V', 1.5], [11, 'continuity', 'Ω', 1.5], [12, 'transistorGain', '', 1.5],
  ];
  it.each(FUNCTIONS)('maps function %i to %s', (func, mode, unit, value) => {
    const [reading] = decodeOne(encodeOwonB35Frame({ func, scale: 4, decimals: 1, count: 15 }));
    expect(reading).toMatchObject({ mode, unit });
    expect(reading.value).toBe(value);
  });

  it('gives no number for non-contact voltage and reports over-range', () => {
    const [ncv] = decodeOne(encodeOwonB35Frame({ func: 13, scale: 4, decimals: 0, count: 2 }));
    expect(ncv).toMatchObject({ mode: 'ncv', value: null });
    expect(ncv.flags.invalid).toBe(true);
    const [ol] = decodeOne(OHM_OL);
    expect(ol).toMatchObject({ mode: 'resistance', unit: 'Ω', value: null, display: 'OL' });
    expect(ol.flags.ol).toBe(true);
    // A count of 32767 cannot be shown by a 6000-count display either.
    const [full] = decodeOne(encodeOwonB35Frame({ func: 0, scale: 4, decimals: 3, count: 0x7fff }));
    expect(full.flags.ol).toBe(true);
    expect(full.value).toBeNull();
  });

  it('reads the flag word', () => {
    const [reading] = decodeOne(encodeOwonB35Frame({ func: 0, scale: 4, decimals: 3, count: 1, flags: 0b001011 }));
    expect(reading.flags).toMatchObject({ hold: true, rel: true, auto: false, lowBattery: true, min: false, max: false });
    const [extremes] = decodeOne(encodeOwonB35Frame({ func: 0, scale: 4, decimals: 3, count: 1, flags: 0b110100 }));
    expect(extremes.flags).toMatchObject({ auto: true, min: true, max: true, hold: false });
  });

  it('decodes a whole notification without a buffer, and only a whole one', () => {
    expect(decodeOwonB35Notification(DC_1_234, at)?.value).toBe(1.234);
    expect(decodeOwonB35Notification(DC_1_234.slice(0, 5), at)).toBeNull();
    expect(decodeOwonB35Notification([...DC_1_234, 0], at)).toBeNull();
    expect(decodeOwonB35Notification(HEX('23 0F 04 00 D2 04'), at)).toBeNull();
    expect(decodeOwonB35Notification(encodeOwonB35Frame({ func: 14, scale: 4, decimals: 1, count: 1 }), at)).toBeNull();
    expect(decodeOwonB35Notification(encodeOwonB35Frame({ func: 0, scale: 7, decimals: 1, count: 1 }), at)).toBeNull();
  });
});

describe('OWON B35T+ stream', () => {
  const STREAM = [
    ...DC_1_234, ...encodeOwonB35Frame({ func: 4, scale: 5, decimals: 3, count: 4700 }), ...OHM_OL,
    ...encodeOwonB35Frame({ func: 10, scale: 4, decimals: 3, count: 512 }), ...DC_MINUS_1_234,
  ];
  const run = (size: number) => {
    const decoder = createOwonB35Decoder();
    const out = [];
    for (let i = 0; i < STREAM.length; i += size) out.push(...decoder.push(STREAM.slice(i, i + size), i));
    return { values: out.map(r => [r.mode, r.value, r.flags.ol]), stats: { ...decoder.stats } };
  };

  it('follows mode changes and over-range in any chunking', () => {
    const whole = run(STREAM.length);
    expect(whole.values).toEqual([
      ['dcVolts', 1.234, false], ['resistance', 4700, false], ['resistance', null, true], ['diode', 0.512, false], ['dcVolts', -1.234, false],
    ]);
    expect(whole.stats).toMatchObject({ bytes: 30, frames: 5, readings: 5, badFrames: 0, skippedBytes: 0, resyncs: 0 });
    for (const size of [1, 2, 3, 4, 5, 6, 7, 11, 29]) expect(run(size).values, `chunk ${size}`).toEqual(whole.values);
  });

  it('skips garbage in front of a frame and counts it', () => {
    const decoder = createOwonB35Decoder();
    const readings = decoder.push([0x00, 0x12, 0x34, 0xff, 0x7f, ...DC_1_234, 0x01, 0x02, ...OHM_4_7K]);
    expect(readings.map(r => r.value)).toEqual([1.234, 4700]);
    expect(decoder.stats.frames).toBe(2);
    expect(decoder.stats.resyncs).toBe(2);
  });

  it('drops frames whose function or scale is outside the tables and looks for the next one', () => {
    const decoder = createOwonB35Decoder();
    const badFunction = encodeOwonB35Frame({ func: 15, scale: 4, decimals: 1, count: 1 });
    const badScale = encodeOwonB35Frame({ func: 0, scale: 7, decimals: 1, count: 1 });
    const readings = decoder.push([...badFunction, ...badScale, ...DC_1_234]);
    expect(readings.map(r => r.value)).toEqual([1.234]);
    expect(decoder.stats.badFrames).toBeGreaterThanOrEqual(2);
  });

  it('finds the next frame after a truncated one', () => {
    const decoder = createOwonB35Decoder();
    const readings = decoder.push([...DC_1_234.slice(0, 3), ...OHM_4_7K, ...DC_1_234, ...OHM_4_7K]);
    // The cut frame and the byte shift it causes are skipped; the frame right behind it is found again.
    expect(readings.map(r => r.value)).toEqual([4700, 1.234, 4700]);
    expect(decoder.stats.resyncs).toBe(1);
  });

  it('survives random bytes, an oversized chunk and reset', () => {
    const decoder = createOwonB35Decoder();
    let seed = 7;
    for (let i = 0; i < 300; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      expect(() => decoder.push(Array.from({ length: 1 + (seed % 25) }, (_, k) => (seed >>> (k % 20)) & 0xff))).not.toThrow();
    }
    expect(() => decoder.push(new Uint8Array(100000).fill(0xf0))).not.toThrow();
    decoder.reset();
    expect(decoder.push(DC_1_234)[0].value).toBe(1.234);
    decoder.push(DC_1_234.slice(0, 4));
    decoder.reset();
    expect(decoder.push(DC_1_234.slice(4)).length).toBe(0);
  });

  it('describes itself as experimental over Bluetooth LE', () => {
    expect(OWON_B35_INFO).toMatchObject({ id: 'owon-b35', status: 'experimental', link: 'ble' });
  });
});
