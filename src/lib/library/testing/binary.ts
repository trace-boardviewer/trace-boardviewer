/*
 * Binary files of the synthetic library: photos (tiny PNG and JPEG that carry an optional padding chunk so their size can follow the
 * byte budget), firmware images (random bytes in power-of-two sizes) and the look-alikes of encrypted boardview files.
 * The padding is private data inside a valid file; nothing here comes from a real photo, so there is no EXIF and no location.
 */
import { zlibSync } from 'fflate';
import { crc32 } from './zip.ts';
import type { Rng } from './rng.ts';

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
};
const be32 = (value: number): Uint8Array => Uint8Array.of(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const name = Uint8Array.of(type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3));
  return concat([be32(data.length), name, data, be32(crc32(data, crc32(name)))]);
}

export interface ImageOptions { width: number; height: number; /** Extra bytes of private padding chunks, so the file reaches about this size. */ padBytes?: number }

/** An 8-bit grey PNG (smooth gradient plus a little noise) with optional private padding chunks before the image data. */
export function buildPng(rng: Rng, options: ImageOptions): Uint8Array {
  const { width, height } = options;
  const rows = new Uint8Array((width + 1) * height);
  const phase = rng.int(0, 255);
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = 0;
    for (let x = 0; x < width; x++) rows[y * (width + 1) + 1 + x] = (phase + x * 3 + y * 2 + rng.int(0, 15)) & 255;
  }
  const header = concat([be32(width), be32(height), Uint8Array.of(8, 0, 0, 0, 0)]);
  const chunks = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), pngChunk('IHDR', header)];
  let pad = Math.max(0, Math.floor(options.padBytes ?? 0));
  while (pad > 0) {
    const part = Math.min(pad, 1 << 20);
    chunks.push(pngChunk('prVt', rng.bytes(part)));
    pad -= part;
  }
  chunks.push(pngChunk('IDAT', zlibSync(rows)), pngChunk('IEND', new Uint8Array(0)));
  return concat(chunks);
}

/** A baseline grey JPEG of mid-grey blocks (every block is "DC 0, end of block": two zero bits), with optional comment segments as padding. */
export function buildJpeg(rng: Rng, options: ImageOptions): Uint8Array {
  const { width, height } = options;
  const segment = (marker: number, body: Uint8Array): Uint8Array => concat([Uint8Array.of(0xff, marker, (body.length + 2) >>> 8, (body.length + 2) & 255), body]);
  const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8), segment(0xe0, Uint8Array.of(0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0))];
  let pad = Math.max(0, Math.floor(options.padBytes ?? 0));
  while (pad > 0) {
    const part = Math.min(pad, 65_000);
    parts.push(segment(0xfe, rng.bytes(part)));
    pad -= part;
  }
  parts.push(segment(0xdb, Uint8Array.of(0, ...new Array<number>(64).fill(1))));
  parts.push(segment(0xc0, Uint8Array.of(8, height >>> 8, height & 255, width >>> 8, width & 255, 1, 1, 0x11, 0)));
  parts.push(segment(0xc4, Uint8Array.of(0x00, 1, ...new Array<number>(15).fill(0), 0x00)));
  parts.push(segment(0xc4, Uint8Array.of(0x10, 1, ...new Array<number>(15).fill(0), 0x00)));
  parts.push(segment(0xda, Uint8Array.of(1, 1, 0x00, 0, 63, 0)));
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const bits = blocks * 2;
  const data = new Uint8Array(Math.ceil(bits / 8)).fill(0);
  if (bits % 8) data[data.length - 1] = 0xff >>> (bits % 8);
  parts.push(data, Uint8Array.of(0xff, 0xd9));
  return concat(parts);
}

/** A power-of-two size class. */
export const FIRMWARE_SIZES: readonly number[] = [64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024, 1024 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024, 16 * 1024 * 1024];

/** Random bytes with blank (0xFF) flash regions at both ends and in a few places, like a flash dump. */
export function buildFirmware(rng: Rng, size: number): Uint8Array {
  const out = rng.bytes(size);
  out.fill(0xff, 0, Math.min(size, 16));
  out.fill(0xff, Math.max(0, size - 64));
  for (let i = 0; i < 4; i++) {
    const length = Math.min(size >> 3, 1024 * rng.int(1, 8));
    const from = rng.int(0, Math.max(0, size - length));
    out.fill(0xff, from, from + length);
  }
  return out;
}

/**
 * Bulk bytes that no tool can compress: one block of random bytes repeated with a changing stamp every 4 KiB. Much faster than
 * random bytes all the way through, which matters for the multi-megabyte filler files that use up a byte budget.
 */
export function buildFiller(rng: Rng, size: number): Uint8Array {
  const out = new Uint8Array(size);
  const block = rng.bytes(Math.min(size, 1 << 18));
  let chunk = 0;
  for (let at = 0; at < size; at += block.length, chunk++) {
    const length = Math.min(block.length, size - at);
    out.set(length === block.length ? block : block.subarray(0, length), at);
    for (let p = at; p < at + length; p += 4096) out[p] = (out[p] + chunk * 31 + (p >> 12)) & 255;
  }
  return out;
}

export type EncryptedBoardKind = 'fz' | 'cae' | 'xzz';

/** What an encrypted boardview file looks like from outside: no signature, high entropy; the XZZ look-alike also carries the plain marker the format keeps near the end. */
export function buildEncryptedLookalike(rng: Rng, kind: EncryptedBoardKind, size: number): Uint8Array {
  const out = rng.bytes(size);
  if (kind === 'xzz') {
    const marker = new TextEncoder().encode('v6v6555v6v6');
    out.set(marker, Math.max(0, size - marker.length - 3));
  }
  return out;
}
