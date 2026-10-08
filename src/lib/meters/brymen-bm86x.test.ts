import { describe, expect, it } from 'vitest';
import {
  BM86X_BARE_FRAME_LENGTH, BM86X_FRAME_LENGTH, BM86X_INFO, BM86X_MODEL_ID, BM86X_REQUEST_REPORT, createBm86xDecoder, decodeBm86xFrame,
  encodeBm86xFrame, glyphOf, normaliseBm86xFrame, segmentsOf, type Bm86xFrameSpec,
} from './brymen-bm86x';

const at = 11000;

/** A 27-byte frame built from the segment table by hand: index = the sheet's byte number minus one. */
function literal(bytes: Record<number, number>): number[] {
  const frame = new Array<number>(BM86X_FRAME_LENGTH).fill(0);
  frame[22] = BM86X_MODEL_ID;
  for (const [index, value] of Object.entries(bytes)) frame[Number(index)] = value;
  return frame;
}

// Segments b g c d a f e in bits 7..1: '1' = b c = 0xA0, '2' = a b d e g = 0xDA, '3' = a b c d g = 0xF8, '4' = b c f g = 0xE4,
// '0' = a b c d e f = 0xBE. Bit 0 of the next byte is the decimal point or an annunciator.
// " 123.40" on the main display: digits (space)(1)(2)(3)(4)(0), the point after the fourth digit (bit 0 of sheet byte 9), V (11.0),
// DC (3.4) and AUTO (3.0).
const DC_123_40_V = literal({ 2: 0x11, 5: 0xa0, 6: 0xda, 7: 0xf8, 8: 0xe5, 10: 0xbf });

const decode = (frame: ArrayLike<number>) => decodeBm86xFrame(frame, at);
const lit = (main: string, point: Bm86xFrameSpec['mainPoint'], ...annunciators: string[]): Uint8Array =>
  encodeBm86xFrame({ main, mainPoint: point, lit: annunciators });

describe('BM86x segment table', () => {
  it('maps the digit segments of the sheet', () => {
    expect(segmentsOf('1')).toBe(0xa0);
    expect(segmentsOf('2')).toBe(0xda);
    expect(segmentsOf('3')).toBe(0xf8);
    expect(segmentsOf('4')).toBe(0xe4);
    expect(segmentsOf('0')).toBe(0xbe);
    expect(segmentsOf('8')).toBe(0xfe);
    expect(segmentsOf('-')).toBe(0x40);
    expect(segmentsOf(' ')).toBe(0);
    for (const ch of '0123456789 -LCFEPHodinruA') expect(glyphOf(segmentsOf(ch) | 1), ch).toBe(ch === 'i' ? 'i' : ch);
    expect(glyphOf(0xff & ~0x80 & ~0x40 & ~0x20 & ~0x10 & ~0x08 & ~0x04 & ~0x02)).toBe(' ');
    expect(glyphOf(0xaa)).toBe('?');
    expect(() => segmentsOf('Q')).toThrow(RangeError);
  });
});

describe('BM86x frames', () => {
  it('has the 27-byte and the 24-byte form and a request report', () => {
    expect(BM86X_FRAME_LENGTH).toBe(27);
    expect(BM86X_BARE_FRAME_LENGTH).toBe(24);
    expect(BM86X_MODEL_ID).toBe(0x86);
    expect(BM86X_REQUEST_REPORT.reportId).toBe(0);
    expect([...BM86X_REQUEST_REPORT.data]).toEqual([0x00, 0x86, 0x66]);
  });

  it('decodes a hand-built DC volts frame', () => {
    const reading = decode(DC_123_40_V)!;
    expect(reading).toMatchObject({ family: 'brymen-bm86x', mode: 'dcVolts', unit: 'V', value: 123.4, display: '123.40', at });
    expect(reading.resolution).toBeCloseTo(0.01, 12);
    expect(reading.flags).toMatchObject({ auto: true, ol: false, hold: false, rel: false, invalid: false });
    expect(reading.caveat).toBeUndefined();
    expect(reading.secondary).toBeUndefined();
  });

  it('builds the same frame from fields and strips report ids for the 24-byte form', () => {
    const built = encodeBm86xFrame({ main: ' 12340', mainPoint: 4, lit: ['3.4', '3.0', '11.0'] });
    expect([...built]).toEqual(DC_123_40_V);
    const bare = encodeBm86xFrame({ main: ' 12340', mainPoint: 4, lit: ['3.4', '3.0', '11.0'] }, true);
    expect(bare.length).toBe(24);
    expect([...normaliseBm86xFrame(bare)!]).toEqual(DC_123_40_V);
    expect(decode(bare)).toEqual(decode(DC_123_40_V));
    expect(normaliseBm86xFrame(new Array(25).fill(0))).toBeNull();
  });

  it('rejects frames with wrong report ids, model id or length', () => {
    const noModel = [...DC_123_40_V];
    noModel[22] = 0x69;
    expect(decode(noModel)).toBeNull();
    const badId = [...DC_123_40_V];
    badId[9] = 0x01;
    expect(decode(badId)).toBeNull();
    expect(decode(DC_123_40_V.slice(0, 20))).toBeNull();
    expect(decode([])).toBeNull();
  });

  it('decodes AC volts, a minus sign and DC+AC', () => {
    expect(decode(lit(' 31217', 4, '4.0', '11.0'))).toMatchObject({ mode: 'acVolts', unit: 'V', value: 312.17 });
    expect(decode(lit(' 31217', 4, '3.4', '4.0', '11.0'))).toMatchObject({ mode: 'acdcVolts', value: 312.17 });
    const negative = decode(encodeBm86xFrame({ main: '  8512', mainPoint: 3, mainMinus: true, lit: ['3.4', '11.0'] }))!;
    expect(negative).toMatchObject({ mode: 'dcVolts', value: -8.512, display: '-8.512' });
    // Negative zero is zero.
    expect(decode(encodeBm86xFrame({ main: '     0', mainMinus: true, lit: ['3.4', '11.0'] }))!.value).toBe(0);
  });

  it('marks a volt reading without DC or AC as ambiguous', () => {
    const reading = decode(lit(' 12340', 4, '11.0'))!;
    expect(reading).toMatchObject({ mode: 'dcVolts', caveat: 'mode-ambiguous' });
  });

  it('applies the unit prefix annunciators', () => {
    expect(decode(lit('  4700', 3, '18.4', '18.6'))).toMatchObject({ mode: 'resistance', unit: 'Ω', value: 4700 });
    expect(decode(lit('  4700', 3, '18.4', '18.5'))).toMatchObject({ mode: 'resistance', value: 4.7e6 });
    expect(decode(lit(' 12340', 4, '18.4'))).toMatchObject({ mode: 'resistance', value: 123.4 });
    expect(decode(lit('  4712', 3, '17.5', '17.6'))!.value! / 4.712e-9).toBeCloseTo(1, 12);
    expect(decode(lit('  4712', 3, '17.5', '18.3'))!.value! / 4.712e-6).toBeCloseTo(1, 12);
    expect(decode(lit('  4712', 3, '17.5', '18.2'))!.value! / 4.712e-3).toBeCloseTo(1, 12);
    expect(decode(lit('  1234', 3, '17.7', '18.2', '3.4'))).toMatchObject({ mode: 'dcAmps', unit: 'A', value: 1.234 * 1e-3 });
    expect(decode(lit('  1234', 3, '17.7', '4.0'))).toMatchObject({ mode: 'acAmps', unit: 'A' });
    expect(decode(lit('  1000', 3, '18.0', '18.6'))).toMatchObject({ mode: 'frequency', unit: 'Hz', value: 1000 });
    expect(decode(lit('  5000', 4, '18.7'))).toMatchObject({ mode: 'duty', unit: '%', value: 50 });
    expect(decode(lit('  2000', 3, '17.4'))).toMatchObject({ mode: 'conductance', unit: 'S', value: 2 });
    expect(decode(lit('  1234', 3, '18.1'))).toMatchObject({ unit: 'dB', mode: 'other' });
  });

  it('tells continuity and diode test from ohms and volts', () => {
    expect(decode(lit('  1234', 3, '18.4', '13.0'))).toMatchObject({ mode: 'continuity', unit: 'Ω' });
    const diode = decode(encodeBm86xFrame({ main: ' 05123', mainPoint: 2, second: 'diod', lit: ['11.0'] }))!;
    expect(diode).toMatchObject({ mode: 'diode', unit: 'V', value: 0.5123, display: '0.5123' });
    expect(diode.secondary).toBeUndefined();
  });

  it('reads temperature from the C or F character in the sixth digit', () => {
    const celsius = decode(encodeBm86xFrame({ main: '  235C', mainPoint: 4 }))!;
    expect(celsius).toMatchObject({ mode: 'temperature', unit: '°C', value: 23.5 });
    const fahrenheit = decode(encodeBm86xFrame({ main: '  743F', mainPoint: 4 }))!;
    expect(fahrenheit).toMatchObject({ mode: 'temperature', unit: '°F', value: 74.3 });
    expect(decode(encodeBm86xFrame({ main: '  235C', mainPoint: 4, mainMinus: true }))!.value).toBe(-23.5);
  });

  it('reads over-range and a blank main display', () => {
    const ol = decode(lit('    0L', 0, '18.4'))!;
    expect(ol).toMatchObject({ mode: 'resistance', value: null });
    expect(ol.flags.ol).toBe(true);
    const dcOl = decode(lit('    0L', 0, '3.4', '11.0'))!;
    expect(dcOl.flags.ol).toBe(true);
    expect(dcOl.mode).toBe('dcVolts');
    const blank = decode(lit('      ', 0, '11.0'))!;
    expect(blank.value).toBeNull();
    expect(blank.flags).toMatchObject({ invalid: true, ol: false });
  });

  it('reads the secondary display with its unit and over-range', () => {
    const reading = decode(encodeBm86xFrame({ main: ' 31217', mainPoint: 4, second: '6011', secondPoint: 8, lit: ['4.0', '11.0', '17.2'] }))!;
    expect(reading).toMatchObject({ mode: 'acVolts', value: 312.17, secondary: { value: 60.11, unit: 'Hz', display: '60.11' } });
    const volts = decode(encodeBm86xFrame({ main: ' 31217', mainPoint: 4, second: ' 123', secondPoint: 9, lit: ['4.0', '11.0', '17.3'] }))!;
    expect(volts.secondary).toMatchObject({ unit: 'V', value: 12.3 });
    const kilo = decode(encodeBm86xFrame({ main: ' 31217', mainPoint: 4, second: '1000', secondPoint: 7, lit: ['4.0', '11.0', '17.2', '17.1'] }))!;
    expect(kilo.secondary).toMatchObject({ unit: 'Hz', value: 1000 });
    const minus = decode(encodeBm86xFrame({ main: ' 31217', mainPoint: 4, second: ' 123', secondMinus: true, lit: ['4.0', '11.0', '17.3'] }))!;
    expect(minus.secondary?.value).toBe(-123);
    const over = decode(encodeBm86xFrame({ main: ' 31217', mainPoint: 4, second: '  0L', lit: ['4.0', '11.0', '17.3'] }))!;
    expect(over.secondary).toMatchObject({ value: null, ol: true });
  });

  it('reads the status annunciators', () => {
    const reading = decode(encodeBm86xFrame({ main: ' 12340', mainPoint: 4, lit: ['3.4', '11.0', '3.3', '3.5', '12.7', '5.0'] }))!;
    expect(reading.flags).toMatchObject({ hold: true, max: true, min: false, lowBattery: true, rel: true, auto: false });
    expect(decode(encodeBm86xFrame({ main: ' 12340', mainPoint: 4, lit: ['3.4', '11.0', '3.6'] }))!.flags).toMatchObject({ min: true, max: false });
  });
});

describe('BM86x stream', () => {
  const FRAMES = [
    [...DC_123_40_V],
    [...lit('  4700', 3, '18.4', '18.6')],
    [...lit('    0L', 0, '18.4')],
    [...encodeBm86xFrame({ main: ' 05123', mainPoint: 2, second: 'diod', lit: ['11.0'] })],
    [...lit(' 31217', 4, '4.0', '11.0')],
  ];
  const summary = (size: number, bare = false) => {
    const source = bare ? FRAMES.map(frame => [...normaliseBm86xFrame(frame)!].filter((_, i) => i % 9 !== 0 && i !== 0).slice(0, 24)) : FRAMES;
    const stream = source.flat();
    const decoder = createBm86xDecoder();
    const out = [];
    for (let i = 0; i < stream.length; i += size) out.push(...decoder.push(stream.slice(i, i + size), i));
    return { out: out.map(r => [r.mode, r.value, r.flags.ol]), stats: { ...decoder.stats } };
  };

  it('follows mode changes and over-range in any chunking', () => {
    const whole = summary(1000);
    expect(whole.out).toEqual([['dcVolts', 123.4, false], ['resistance', 4700, false], ['resistance', null, true], ['diode', 0.5123, false], ['acVolts', 312.17, false]]);
    expect(whole.stats).toMatchObject({ frames: 5, readings: 5, badFrames: 0, skippedBytes: 0, resyncs: 0, bytes: 135 });
    for (const size of [1, 2, 5, 9, 13, 24, 26, 27, 28, 50]) expect(summary(size).out, `chunk ${size}`).toEqual(whole.out);
  });

  it('decodes frames whose report ids the host stripped', () => {
    const bare = summary(1000, true);
    expect(bare.out.length).toBe(5);
    expect(bare.out[0]).toEqual(['dcVolts', 123.4, false]);
    expect(summary(7, true).out).toEqual(bare.out);
  });

  it('skips garbage and a cut frame, then finds the next one', () => {
    const decoder = createBm86xDecoder();
    const noise = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77];
    const stream = [...noise, ...DC_123_40_V, ...noise, ...DC_123_40_V.slice(0, 15), ...DC_123_40_V];
    const readings = decoder.push(stream);
    expect(readings.map(r => r.value)).toEqual([123.4, 123.4]);
    expect(decoder.stats.frames).toBe(2);
    expect(decoder.stats.resyncs).toBeGreaterThanOrEqual(2);
  });

  it('survives random bytes, an oversized chunk and reset', () => {
    const decoder = createBm86xDecoder();
    let seed = 3;
    for (let i = 0; i < 300; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      expect(() => decoder.push(Array.from({ length: 1 + (seed % 60) }, (_, k) => (seed >>> (k % 24)) & 0xff))).not.toThrow();
    }
    expect(() => decoder.push(new Uint8Array(100000))).not.toThrow();
    expect(decoder.push(DC_123_40_V)[0].value).toBe(123.4);
    decoder.push(DC_123_40_V.slice(0, 12));
    decoder.reset();
    expect(decoder.push(DC_123_40_V)[0].value).toBe(123.4);
  });

  it('describes itself as experimental over HID', () => {
    expect(BM86X_INFO).toMatchObject({ id: 'brymen-bm86x', status: 'experimental', link: 'hid' });
  });
});
