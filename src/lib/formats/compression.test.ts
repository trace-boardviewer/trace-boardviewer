import { Buffer } from 'node:buffer';
import { deflateSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BoardFormatError, MAX_IMPORT_BYTES } from './common';
import { inflateRaw, inflateZlib } from './compression';

/** Deterministic xorshift32 bytes so every run inflates the same streams. */
function randomBytes(length: number, seed = 0x9e3779b9): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < length; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; out[index] = state & 255; }
  return out;
}
const WORDS = ['GND', 'VCC', 'U1', 'R12', 'C7', 'PIN', 'NET_', 'TOP', 'BOTTOM', '0.254', '12.7', 'Q3', 'SIGNAL', 'NODE', '\n'];
function compressible(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0, position = 0;
  while (position < length) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const word = WORDS[(state >>> 3) % WORDS.length];
    for (let index = 0; index < word.length && position < length; index++) out[position++] = word.charCodeAt(index);
    if (position < length) out[position++] = 32;
  }
  return out;
}
/** Long back-references crossing the 32 KiB window boundary plus overlapping copies (distance < length). */
function windowCrossing(): Uint8Array {
  const block = randomBytes(30_000, 42), runs = new Uint8Array(3000).fill(0x61), period = Uint8Array.from({ length: 3000 }, (_, index) => 65 + index % 3);
  const out = new Uint8Array(block.length * 4 + runs.length + period.length);
  for (let repeat = 0; repeat < 4; repeat++) out.set(block, repeat * block.length);
  out.set(runs, block.length * 4); out.set(period, block.length * 4 + runs.length);
  return out;
}
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
const failure = (action: () => unknown): BoardFormatError => {
  try { action(); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
};

/** LSB-first bit writer; Huffman codes are packed MSB-first as RFC 1951 requires. */
class BitWriter {
  private readonly bytes: number[] = [];
  private buffer = 0;
  private count = 0;
  bits(value: number, length: number): this {
    for (let index = 0; index < length; index++) {
      this.buffer |= ((value >>> index) & 1) << this.count;
      if (++this.count === 8) { this.bytes.push(this.buffer); this.buffer = 0; this.count = 0; }
    }
    return this;
  }
  code(code: number, length: number): this { for (let index = length - 1; index >= 0; index--) this.bits((code >>> index) & 1, 1); return this; }
  literal(symbol: number): this {
    return symbol < 144 ? this.code(0x30 + symbol, 8) : symbol < 256 ? this.code(0x190 + symbol - 144, 9) : symbol < 280 ? this.code(symbol - 256, 7) : this.code(0xc0 + symbol - 280, 8);
  }
  finish(): Uint8Array { if (this.count) { this.bytes.push(this.buffer); this.buffer = 0; this.count = 0; } return Uint8Array.from(this.bytes); }
}
const fixedBlock = () => new BitWriter().bits(1, 1).bits(1, 2);
/** Final dynamic block header whose code-length code has 2-bit codes for symbols 0, 1, 17 and 18 (HCLEN = 18 entries). */
function dynamicHeader(literalCount = 0, distanceCount = 0): BitWriter {
  const writer = new BitWriter().bits(1, 1).bits(2, 2).bits(literalCount, 5).bits(distanceCount, 5).bits(14, 4);
  const lengths = [0, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]; // order 16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1
  for (const length of lengths) writer.bits(length, 3);
  return writer;
}
// Canonical 2-bit codes of that code-length code: symbol 0 = 00, 1 = 01, 17 = 10, 18 = 11.
const CL0 = 0, CL1 = 1, CL18 = 3;

const datasets: Array<[string, Uint8Array]> = [
  ['empty', new Uint8Array(0)], ['one byte', Uint8Array.from([0x5a])], ['100 KiB random', randomBytes(100 * 1024)],
  ['2 MiB compressible', compressible(2 * 1024 * 1024)], ['window-crossing back-references', windowCrossing()],
];

describe('inflateZlib / inflateRaw agree with fflate', () => {
  for (const level of [0, 1, 6, 9] as const) {
    it.each(datasets)(`level ${level}: %s round-trips through zlib and raw deflate with exact consumption`, (_, data) => {
      const zlib = zlibSync(data, { level });
      expect(same(inflateZlib(zlib), data)).toBe(true);
      const deflated = deflateSync(data, { level });
      const result = inflateRaw(deflated);
      expect(same(result.output, data)).toBe(true);
      expect(result.consumedBytes).toBe(deflated.length);
      const padded = new Uint8Array(deflated.length + 9); padded.set(deflated); padded.fill(0xa5, deflated.length);
      const trailing = inflateRaw(padded);
      expect(same(trailing.output, data)).toBe(true);
      expect(trailing.consumedBytes).toBe(deflated.length);
    });
  }
  it('accepts a zlib stream whose output exactly meets the cap', () => {
    const data = compressible(10_000);
    expect(same(inflateZlib(zlibSync(data), 10_000), data)).toBe(true);
    expect(inflateZlib(zlibSync(new Uint8Array(0)), 0)).toHaveLength(0);
  });
});

describe('zlib container negatives (B02)', () => {
  const data = new TextEncoder().encode('known compressed board record');
  const original = zlibSync(data);
  it('rejects trailing garbage followed by a copied Adler-32 (inbox repro)', () => {
    const trailing = new Uint8Array(original.length + 8);
    trailing.set(original); trailing.set([9, 8, 7, 6], original.length); trailing.set(original.subarray(-4), original.length + 4);
    const error = failure(() => inflateZlib(trailing));
    expect(error.message).toMatch(/8 unused byte\(s\) follow the compressed stream/);
    expect(error.code).toBe('INVALID_FORMAT');
    const oneByte = new Uint8Array(original.length + 1); oneByte.set(original); oneByte[original.length] = 0;
    expect(() => inflateZlib(oneByte)).toThrow(/unused byte/);
  });
  it('rejects a bare repeated Adler-32 trailer and a zlib stream concatenated with a second one', () => {
    const repeated = new Uint8Array(original.length + 4); repeated.set(original); repeated.set(original.subarray(-4), original.length);
    expect(failure(() => inflateZlib(repeated)).message).toMatch(/4 unused byte\(s\) follow the compressed stream/);
    const twice = new Uint8Array(original.length * 2); twice.set(original); twice.set(original, original.length);
    expect(failure(() => inflateZlib(twice)).message).toMatch(/unused byte/);
    expect(inflateZlib(original)).toEqual(data); // the exact stream is still accepted
  });
  it('rejects a single zero-byte trailer after stored blocks too', () => {
    const stored = zlibSync(randomBytes(70_000), { level: 0 });
    expect(inflateZlib(stored)).toHaveLength(70_000);
    const padded = new Uint8Array(stored.length + 1); padded.set(stored);
    expect(() => inflateZlib(padded)).toThrow(/unused byte/);
  });
  it('rejects truncated streams', () => {
    expect(failure(() => inflateZlib(original.subarray(0, original.length - 1))).message).toMatch(/overruns its checksum/);
    expect(failure(() => inflateZlib(original.subarray(0, original.length - 5))).message).toMatch(/overruns its checksum|truncated/);
    expect(() => inflateZlib(original.subarray(0, Math.floor(original.length / 2)))).toThrow(BoardFormatError);
    expect(failure(() => inflateZlib(original.subarray(0, 5))).message).toMatch(/too short/);
    const large = zlibSync(compressible(50_000));
    expect(() => inflateZlib(large.subarray(0, large.length - 100))).toThrow(/truncated|overruns/);
  });
  it('rejects a wrong checksum, a preset dictionary and bad headers', () => {
    const wrong = Uint8Array.from(original); wrong[wrong.length - 1] ^= 1;
    expect(failure(() => inflateZlib(wrong)).message).toMatch(/checksum mismatch/);
    const dictionary = Uint8Array.from(original);
    dictionary[1] = (dictionary[1] & 0xc0) | 0x20; // FDICT set, FLEVEL kept, FCHECK recomputed
    dictionary[1] |= (31 - (((dictionary[0] << 8) | dictionary[1]) % 31)) % 31;
    expect(((dictionary[0] << 8) | dictionary[1]) % 31).toBe(0);
    expect(failure(() => inflateZlib(dictionary)).message).toMatch(/preset-dictionary/);
    for (const [cmf, flg] of [[0x79, 0x9c], [0x88, 0x9c], [0x78, 0x9d], [0x00, 0x00]]) {
      const bad = Uint8Array.from(original); bad[0] = cmf; bad[1] = flg;
      expect(failure(() => inflateZlib(bad)).message).toMatch(/invalid zlib header/);
    }
  });
  it('enforces the output cap before, at and in the middle of a stream with LIMIT_EXCEEDED', () => {
    const capped = failure(() => inflateZlib(zlibSync(new Uint8Array(2048)), 1024));
    expect(capped.code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => inflateZlib(zlibSync(randomBytes(200_000), { level: 0 }), 100_000)).code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => inflateZlib(zlibSync(compressible(1024 * 1024), { level: 6 }), 512 * 1024)).code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => inflateZlib(zlibSync(new Uint8Array(1)), 0)).code).toBe('LIMIT_EXCEEDED');
    for (const limit of [-1, 1.5, MAX_IMPORT_BYTES + 1, Number.NaN]) {
      expect(() => inflateZlib(original, limit)).toThrow(/Invalid decompression limit/);
      expect(() => inflateRaw(original.subarray(2), limit)).toThrow(/Invalid decompression limit/);
    }
  });
  it('caps an expansion bomb at the 64 MiB import limit by default (LIMIT_EXCEEDED, no unbounded allocation)', { timeout: 120_000 }, () => {
    const bomb = zlibSync(new Uint8Array(MAX_IMPORT_BYTES + 1), { level: 1 });
    expect(bomb.length).toBeLessThan(MAX_IMPORT_BYTES / 100);
    expect(failure(() => inflateZlib(bomb)).code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => inflateRaw(bomb.subarray(2))).code).toBe('LIMIT_EXCEEDED');
  });
  it('rejects data larger than the import limit without decoding', () => {
    expect(failure(() => inflateRaw({ length: MAX_IMPORT_BYTES + 1 } as unknown as Uint8Array)).code).toBe('LIMIT_EXCEEDED');
  });
});

describe('raw deflate stream negatives', () => {
  it('decodes a hand-written fixed block (writer sanity check)', () => {
    const stream = fixedBlock().literal(65).literal(66).literal(200).literal(256).finish();
    const result = inflateRaw(stream);
    expect([...result.output]).toEqual([65, 66, 200]);
    expect(result.consumedBytes).toBe(stream.length);
  });
  it('rejects invalid length and distance codes and distances before the start', () => {
    expect(failure(() => inflateRaw(fixedBlock().literal(65).literal(257).code(30, 5).finish())).message).toMatch(/invalid distance code/);
    expect(failure(() => inflateRaw(fixedBlock().literal(65).literal(257).code(1, 5).finish())).message).toMatch(/distance too far back/);
    expect(failure(() => inflateRaw(fixedBlock().literal(286).finish())).message).toMatch(/invalid length code/);
    expect(failure(() => inflateRaw(fixedBlock().literal(287).finish())).message).toMatch(/invalid length code/);
    const copy = inflateRaw(fixedBlock().literal(65).literal(257).code(0, 5).literal(256).finish());
    expect([...copy.output]).toEqual([65, 65, 65, 65]);
  });
  it('rejects reserved block types and malformed stored blocks', () => {
    expect(failure(() => inflateRaw(new BitWriter().bits(1, 1).bits(3, 2).finish())).message).toMatch(/reserved block type/);
    expect(failure(() => inflateRaw(Uint8Array.from([0x01, 2, 0, 0, 0, 65, 66]))).message).toMatch(/length check failed/);
    expect(failure(() => inflateRaw(Uint8Array.from([0x01, 5, 0, 0xfa, 0xff, 65]))).message).toMatch(/truncated stored block/);
    expect(failure(() => inflateRaw(Uint8Array.from([0x01, 5, 0]))).message).toMatch(/truncated stored block/);
    expect([...inflateRaw(Uint8Array.from([0x01, 2, 0, 0xfd, 0xff, 65, 66])).output]).toEqual([65, 66]);
    expect(inflateRaw(Uint8Array.from([0x01, 2, 0, 0xfd, 0xff, 65, 66, 9, 9])).consumedBytes).toBe(7);
  });
  it('rejects truncated streams at every stage', () => {
    expect(failure(() => inflateRaw(new Uint8Array(0))).message).toMatch(/truncated/);
    expect(failure(() => inflateRaw(fixedBlock().literal(65).finish())).message).toMatch(/truncated|invalid/);
    const stream = deflateSync(compressible(20_000), { level: 9 });
    expect(() => inflateRaw(stream.subarray(0, stream.length - 50))).toThrow(/truncated|invalid/);
  });
  it('rejects over-subscribed, incomplete and overflowing dynamic code tables', () => {
    const base = () => new BitWriter().bits(1, 1).bits(2, 2).bits(0, 5).bits(0, 5).bits(0, 4);
    expect(failure(() => inflateRaw(base().bits(1, 3).bits(1, 3).bits(1, 3).bits(1, 3).finish())).message).toMatch(/over-subscribed/);
    expect(failure(() => inflateRaw(base().bits(1, 3).bits(0, 3).bits(0, 3).bits(0, 3).finish())).message).toMatch(/incomplete Huffman code/);
    expect(failure(() => inflateRaw(new BitWriter().bits(1, 1).bits(2, 2).bits(30, 5).bits(0, 5).bits(0, 4).finish())).message).toMatch(/too many/);
    expect(failure(() => inflateRaw(new BitWriter().bits(1, 1).bits(2, 2).bits(0, 5).bits(30, 5).bits(0, 4).finish())).message).toMatch(/too many/);
    expect(failure(() => inflateRaw(dynamicHeader().code(CL18, 2).bits(127, 7).code(CL18, 2).bits(127, 7).finish())).message).toMatch(/overflow/);
    const repeatFirst = new BitWriter().bits(1, 1).bits(2, 2).bits(0, 5).bits(0, 5).bits(0, 4).bits(2, 3).bits(2, 3).bits(2, 3).bits(2, 3).code(1, 2).finish();
    expect(failure(() => inflateRaw(repeatFirst)).message).toMatch(/repeat code without a previous length/);
  });
  it('rejects a missing end-of-block code and an invalid code under a lone one-bit literal code', () => {
    const missingEob = dynamicHeader().code(CL1, 2).code(CL18, 2).bits(127, 7).code(CL18, 2).bits(107, 7).code(CL1, 2).finish();
    expect(failure(() => inflateRaw(missingEob)).message).toMatch(/missing end-of-block/);
    const loneCode = () => dynamicHeader().code(CL18, 2).bits(127, 7).code(CL18, 2).bits(107, 7).code(CL1, 2).code(CL1, 2);
    expect(inflateRaw(loneCode().bits(0, 1).finish()).output).toHaveLength(0);
    expect(failure(() => inflateRaw(loneCode().bits(1, 1).finish())).message).toMatch(/invalid Huffman code/);
    expect(CL0).toBe(0);
  });
});

describe('performance', () => {
  it('inflates 16 MiB of compressible board text comfortably under two seconds', { timeout: 120_000 }, () => {
    const data = compressible(16 * 1024 * 1024, 99);
    const zlib = zlibSync(data, { level: 6 });
    const start = performance.now();
    const output = inflateZlib(zlib);
    const elapsed = performance.now() - start;
    expect(same(output, data)).toBe(true);
    console.info(`inflateZlib: ${(zlib.length / 1024 / 1024).toFixed(2)} MiB -> 16 MiB in ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('malformed streams never escape as a non-format exception', () => {
  const sample = zlibSync(compressible(3000, 5), { level: 6 });
  it('every strict prefix of a valid zlib stream is rejected with BoardFormatError', () => {
    for (let length = 0; length < sample.length; length++) expect(() => inflateZlib(sample.subarray(0, length)), `length ${length}`).toThrow(BoardFormatError);
  });
  it('every single-bit flip either inflates (stored literals) or throws BoardFormatError, and a flipped checksum never passes', () => {
    for (let index = 0; index < sample.length; index++) {
      for (let bit = 0; bit < 8; bit++) {
        const damaged = Uint8Array.from(sample); damaged[index] ^= 1 << bit;
        try { inflateZlib(damaged); } catch (error) { expect(error, `byte ${index} bit ${bit}`).toBeInstanceOf(BoardFormatError); }
      }
    }
    for (let index = sample.length - 4; index < sample.length; index++) {
      const damaged = Uint8Array.from(sample); damaged[index] ^= 1;
      expect(() => inflateZlib(damaged)).toThrow(/checksum mismatch/);
    }
  });
  it('arbitrary byte soup behind a valid zlib header is a format error, never a RangeError', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const soup = Uint8Array.from([0x78, 0x9c, ...randomBytes(40 + seed % 50, seed)]);
      try { inflateZlib(soup); } catch (error) { expect(error, `seed ${seed}`).toBeInstanceOf(BoardFormatError); }
    }
  });
});
