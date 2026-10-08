import { describe, expect, it } from 'vitest';
import { createStreamDecoder, type Scanner } from './stream';
import type { MeterReading } from './types';
import { makeFlags } from './types';

/** A toy protocol: 0x7e, a length byte (1..4), that many payload bytes, and a checksum byte (their sum). */
const reading = (value: number, at: number): MeterReading => ({ family: 'simulated', value, unit: 'V', mode: 'dcVolts', flags: makeFlags(), at });

const scan: Scanner = (front, at) => {
  if (front[0] !== 0x7e) return { kind: 'garbage', length: 1 };
  if (front.length < 2) return { kind: 'need-more' };
  const size = front[1];
  if (size < 1 || size > 4) return { kind: 'garbage', length: 1 };
  if (front.length < size + 3) return { kind: 'need-more' };
  let sum = 0;
  for (let i = 0; i < size; i++) sum += front[2 + i];
  if ((sum & 0xff) !== front[2 + size]) return { kind: 'garbage', length: 1, bad: true };
  return { kind: 'frame', length: size + 3, readings: size === 1 && front[2] === 0 ? [] : [reading(sum, at)] };
};

const frame = (...payload: number[]): number[] => [0x7e, payload.length, ...payload, payload.reduce((a, b) => a + b, 0) & 0xff];

describe('stream decoder scaffolding', () => {
  it('turns frames into readings and counts them', () => {
    const decoder = createStreamDecoder({ family: 'simulated', scan });
    const out = decoder.push([...frame(1, 2), ...frame(5)], 99);
    expect(out.map(r => [r.value, r.at])).toEqual([[3, 99], [5, 99]]);
    expect(decoder.stats).toEqual({ bytes: 9, frames: 2, readings: 2, badFrames: 0, skippedBytes: 0, resyncs: 0 });
    expect(decoder.family).toBe('simulated');
  });

  it('counts a frame that gives no reading as a frame', () => {
    const decoder = createStreamDecoder({ family: 'simulated', scan });
    expect(decoder.push(frame(0))).toEqual([]);
    expect(decoder.stats).toMatchObject({ frames: 1, readings: 0 });
  });

  it('holds a partial frame until the rest arrives, byte by byte', () => {
    const decoder = createStreamDecoder({ family: 'simulated', scan });
    const bytes = [...frame(1, 2, 3, 4), ...frame(9)];
    const out: MeterReading[] = [];
    bytes.forEach((byte, i) => out.push(...decoder.push([byte], i)));
    expect(out.map(r => r.value)).toEqual([10, 9]);
    expect(decoder.stats.resyncs).toBe(0);
  });

  it('counts a run of garbage as one resync however long it is, and a bad frame as bad', () => {
    const decoder = createStreamDecoder({ family: 'simulated', scan });
    const bad = frame(1, 2);
    bad[bad.length - 1] ^= 0xff;
    const out = decoder.push([1, 2, 3, 4, 5, ...frame(7), 0xaa, 0xbb, ...bad, ...frame(8)]);
    expect(out.map(r => r.value)).toEqual([7, 8]);
    expect(decoder.stats.frames).toBe(2);
    expect(decoder.stats.badFrames).toBe(1);
    expect(decoder.stats.resyncs).toBe(2);
    expect(decoder.stats.skippedBytes).toBe(5 + 2 + bad.length);
  });

  it('uses the clock it is given for chunks without a time', () => {
    let clock = 10;
    const decoder = createStreamDecoder({ family: 'simulated', scan, now: () => clock++ });
    expect(decoder.push(frame(1))[0].at).toBe(10);
    expect(decoder.push(frame(1))[0].at).toBe(11);
    expect(decoder.push(frame(1), 0)[0].at).toBe(0);
  });

  it('bounds its buffer: a partial frame that grows past the limit is trimmed, and a huge chunk keeps only its tail', () => {
    const lazy: Scanner = front => (front[0] === 0x7e ? { kind: 'need-more' } : { kind: 'garbage', length: 1 });
    const decoder = createStreamDecoder({ family: 'simulated', scan: lazy, maxBuffer: 64 });
    for (let i = 0; i < 100; i++) decoder.push(new Array(40).fill(0x7e));
    expect(decoder.stats.bytes).toBe(4000);
    expect(decoder.stats.skippedBytes).toBeGreaterThan(3000);

    const framed = createStreamDecoder({ family: 'simulated', scan, maxBuffer: 64 });
    const out = framed.push([...new Array(5000).fill(0x11), ...frame(1, 2)]);
    expect(out.map(r => r.value)).toEqual([3]);
    expect(framed.stats.bytes).toBe(5000 + 5);
    expect(framed.stats.skippedBytes).toBeGreaterThanOrEqual(5000);
  });

  it('takes any array-like and masks to bytes', () => {
    const decoder = createStreamDecoder({ family: 'simulated', scan });
    expect(decoder.push(Uint8Array.from(frame(1, 2)))[0].value).toBe(3);
    expect(decoder.push(frame(1, 2).map(byte => byte + 256))[0].value).toBe(3);
    expect(decoder.push({ length: 4, 0: 0x7e, 1: 1, 2: 7, 3: 7 })[0].value).toBe(7);
  });

  it('forgets the partial frame on reset and keeps the counters', () => {
    const decoder = createStreamDecoder({ family: 'simulated', scan });
    decoder.push(frame(1, 2).slice(0, 3));
    decoder.reset();
    expect(decoder.push(frame(1, 2).slice(3))).toEqual([]);
    expect(decoder.stats.bytes).toBe(5 + 0);
    expect(decoder.push(frame(4))[0].value).toBe(4);
  });
});
