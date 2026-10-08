/**
 * Shared scaffolding of the byte-stream decoders: a bounded buffer, a loop that asks the family's scanner what the front of the
 * buffer is, and the counters. A scanner looks only at the front of the buffer and answers one of
 *
 *   need-more  the front is a plausible start of a frame that is not complete yet
 *   frame      `length` bytes are one valid frame (readings may be empty: an acknowledgement, an identity line)
 *   garbage    the first `length` bytes cannot start a frame; `bad` marks frame-shaped data that failed validation
 *
 * so resynchronising is the scanner's decision made one front at a time, and a garbage run of any length counts as one resync.
 */
import type { MeterDecoder, MeterDecoderStats, MeterFamilyId, MeterReading } from './types';

export type ScanResult =
  | { kind: 'need-more' }
  | { kind: 'frame'; length: number; readings: MeterReading[] }
  | { kind: 'garbage'; length: number; bad?: boolean };

export type Scanner = (front: Uint8Array, at: number) => ScanResult;

export interface StreamDecoderOptions {
  family: MeterFamilyId;
  scan: Scanner;
  /** Longest frame the family has, plus slack; a buffer that grows past it without a frame is trimmed. Default 512. */
  maxBuffer?: number;
  /** Clock for chunks pushed without a time. Default: Date.now. */
  now?: () => number;
}

export function createStreamDecoder(options: StreamDecoderOptions): MeterDecoder {
  const maxBuffer = Math.max(16, options.maxBuffer ?? 512);
  const now = options.now ?? Date.now;
  let buffer = new Uint8Array(Math.min(maxBuffer * 2, 1024));
  let length = 0;
  let inGarbage = false;
  const stats: MeterDecoderStats = { bytes: 0, frames: 0, readings: 0, badFrames: 0, skippedBytes: 0, resyncs: 0 };

  const drop = (count: number): void => {
    buffer.copyWithin(0, count, length);
    length -= count;
  };
  const skip = (count: number, bad: boolean | undefined): void => {
    if (!inGarbage) { stats.resyncs++; inGarbage = true; }
    stats.skippedBytes += count;
    if (bad) stats.badFrames++;
    drop(count);
  };

  return {
    family: options.family,
    stats,
    push(chunk: ArrayLike<number>, at?: number): MeterReading[] {
      const when = at ?? now();
      const out: MeterReading[] = [];
      let offset = 0;
      // A chunk larger than the buffer can ever need is cut: only its tail can still belong to a frame.
      if (chunk.length > maxBuffer) {
        const cut = chunk.length - maxBuffer;
        stats.bytes += cut;
        stats.skippedBytes += cut;
        if (!inGarbage) { stats.resyncs++; inGarbage = true; }
        length = 0;
        offset = cut;
      }
      const incoming = chunk.length - offset;
      if (length + incoming > buffer.length) {
        const grown = new Uint8Array(Math.max(buffer.length * 2, length + incoming));
        grown.set(buffer.subarray(0, length));
        buffer = grown;
      }
      for (let i = 0; i < incoming; i++) buffer[length + i] = chunk[offset + i] & 0xff;
      length += incoming;
      stats.bytes += incoming;

      while (length > 0) {
        const result = options.scan(buffer.subarray(0, length), when);
        if (result.kind === 'need-more') {
          if (length > maxBuffer) skip(length - Math.floor(maxBuffer / 2), false);
          break;
        }
        if (result.kind === 'garbage') {
          skip(Math.max(1, Math.min(result.length, length)), result.bad);
          continue;
        }
        const taken = Math.max(1, Math.min(result.length, length));
        inGarbage = false;
        stats.frames++;
        stats.readings += result.readings.length;
        for (const reading of result.readings) out.push(reading);
        drop(taken);
      }
      return out;
    },
    reset(): void {
      length = 0;
      inGarbage = false;
    },
  };
}
