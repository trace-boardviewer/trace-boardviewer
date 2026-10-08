/*
 * A small ZIP writer for the synthetic library: stored and deflated entries, hostile entry names, the "encrypted" flag, a
 * truncated end of file and bounded ZIP bombs. Raw deflate comes from fflate (a dependency of the application); everything else
 * is written here so the flags and sizes a hostile archive needs can be set exactly.
 */
import { deflateSync } from 'fflate';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO 3309) of the bytes, continuing from `previous` (the value of an earlier call over the bytes before). */
export function crc32(data: Uint8Array, previous = 0): number {
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const GP_ENCRYPTED = 0x0001;
export const GP_UTF8_NAME = 0x0800;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 12 << 11;

export interface ZipEntry {
  /** Entry name exactly as it is stored (may be hostile: "../x", "/abs", "C:\\x"). A trailing "/" makes a directory entry. */
  name: string;
  /** Uncompressed bytes (the writer deflates them unless `method` says store). */
  data?: Uint8Array;
  method?: 'store' | 'deflate';
  /** Bytes that are already in the entry's final form (compressed, or encrypted garbage); needs `crc` and `size`. */
  raw?: { bytes: Uint8Array; crc: number; size: number; method: 0 | 8 };
  /** Sets the "encrypted" general-purpose bit; `data` then stands for the ciphertext and is stored as is. */
  encrypted?: boolean;
  dosDate?: number;
  dosTime?: number;
}

export interface ZipOptions {
  comment?: string;
  /** Leaves out the central directory and the end record: a download that stopped half way. */
  truncateTail?: boolean;
}

const encoder = new TextEncoder();
const isAscii = (text: string): boolean => /^[\x20-\x7e]*$/.test(text);

function u16(view: DataView, at: number, value: number): void { view.setUint16(at, value & 0xffff, true); }
function u32(view: DataView, at: number, value: number): void { view.setUint32(at, value >>> 0, true); }

export function dosDateOf(year: number, month: number, day: number): number { return ((year - 1980) << 9) | (month << 5) | day; }

export function buildZip(entries: readonly ZipEntry[], options: ZipOptions = {}): Uint8Array {
  if (entries.length > 0xffff) throw new RangeError('more than 65535 entries need ZIP64');
  const chunks: Uint8Array[] = [];
  const central: Array<{ name: Uint8Array; flags: number; method: number; crc: number; compressed: number; size: number; offset: number; time: number; date: number; directory: boolean }> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const directory = entry.name.endsWith('/') && !entry.data && !entry.raw;
    let flags = isAscii(entry.name) ? 0 : GP_UTF8_NAME;
    let bytes: Uint8Array, crc: number, size: number, method: number;
    if (entry.raw) { bytes = entry.raw.bytes; crc = entry.raw.crc; size = entry.raw.size; method = entry.raw.method; }
    else {
      const data = entry.data ?? new Uint8Array(0);
      crc = crc32(data); size = data.length;
      if (entry.encrypted || entry.method === 'store' || data.length < 64) { bytes = data; method = 0; }
      else { bytes = deflateSync(data, { level: 6 }); method = 8; }
    }
    if (entry.encrypted) flags |= GP_ENCRYPTED;
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    u32(view, 0, 0x04034b50); u16(view, 4, 20); u16(view, 6, flags); u16(view, 8, method);
    u16(view, 10, entry.dosTime ?? DOS_TIME); u16(view, 12, entry.dosDate ?? DOS_DATE);
    u32(view, 14, crc); u32(view, 18, bytes.length); u32(view, 22, size); u16(view, 26, name.length); u16(view, 28, 0);
    header.set(name, 30);
    central.push({ name, flags, method, crc, compressed: bytes.length, size, offset, time: entry.dosTime ?? DOS_TIME, date: entry.dosDate ?? DOS_DATE, directory });
    chunks.push(header, bytes);
    offset += header.length + bytes.length;
  }
  if (!options.truncateTail) {
    const directoryStart = offset;
    for (const item of central) {
      const record = new Uint8Array(46 + item.name.length);
      const view = new DataView(record.buffer);
      u32(view, 0, 0x02014b50); u16(view, 4, 20); u16(view, 6, 20); u16(view, 8, item.flags); u16(view, 10, item.method);
      u16(view, 12, item.time); u16(view, 14, item.date); u32(view, 16, item.crc); u32(view, 20, item.compressed); u32(view, 24, item.size);
      u16(view, 28, item.name.length); u16(view, 30, 0); u16(view, 32, 0); u16(view, 34, 0); u16(view, 36, 0);
      u32(view, 38, item.directory ? 0x10 : 0); u32(view, 42, item.offset);
      record.set(item.name, 46);
      chunks.push(record);
      offset += record.length;
    }
    const comment = encoder.encode(options.comment ?? '');
    const end = new Uint8Array(22 + comment.length);
    const view = new DataView(end.buffer);
    u32(view, 0, 0x06054b50); u16(view, 4, 0); u16(view, 6, 0); u16(view, 8, central.length); u16(view, 10, central.length);
    u32(view, 12, offset - directoryStart); u32(view, 16, directoryStart); u16(view, 20, comment.length);
    end.set(comment, 22);
    chunks.push(end);
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/** Limits that keep a generated bomb harmless: small on disk, a bounded amount of output, and no nesting beyond the list below. */
export const BOMB_LIMITS = Object.freeze({
  /** Largest uncompressed size of one bomb entry, in bytes. */
  maxEntryBytes: 64 * 1024 * 1024,
  /** Largest total uncompressed size of one bomb archive, in bytes. */
  maxTotalBytes: 192 * 1024 * 1024,
  /** Largest size of the archive file itself. */
  maxFileBytes: 512 * 1024,
  /** Smallest size/compressed ratio of a bomb entry (the Library design's per-entry limit is 200:1 above 1 MiB). */
  minRatio: 200,
  /** Archives inside archives: a bomb contains no archive. */
  maxDepth: 0,
});

const bombCache = new Map<number, { bytes: Uint8Array; crc: number; size: number }>();

/** A raw entry that inflates to `mib` MiB of zeros: about one thousand to one, computed once per size. */
export function zeroBombEntry(name: string, mib: number): ZipEntry {
  const size = mib * 1024 * 1024;
  if (size > BOMB_LIMITS.maxEntryBytes) throw new RangeError(`a bomb entry is limited to ${BOMB_LIMITS.maxEntryBytes} bytes`);
  let cached = bombCache.get(mib);
  if (!cached) {
    const zeros = new Uint8Array(size);
    let crc = 0;
    const slice = new Uint8Array(1024 * 1024);
    for (let i = 0; i < mib; i++) crc = crc32(slice, crc);
    cached = { bytes: deflateSync(zeros, { level: 9 }), crc, size };
    bombCache.set(mib, cached);
  }
  return { name, raw: { bytes: cached.bytes, crc: cached.crc, size: cached.size, method: 8 } };
}

/** Bytes that look like the start of a RAR 4, RAR 5 or 7z file and nothing more: the library must type them without reading further. */
export function signatureOnly(kind: 'rar4' | 'rar5' | '7z', rng: { bytes(n: number): Uint8Array }): Uint8Array {
  if (kind === 'rar4') return Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, ...rng.bytes(24));
  if (kind === 'rar5') return Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00, ...rng.bytes(24));
  return Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04, ...rng.bytes(24));
}

export interface ZipListing { name: string; flags: number; method: number; crc: number; compressedSize: number; size: number; offset: number; encrypted: boolean; directory: boolean }

/**
 * The central directory of a ZIP written by `buildZip` (or any plain ZIP): names, flags, methods and sizes, read from the end of the
 * file without inflating anything. Returns null when there is no end-of-central-directory record (a truncated download).
 */
export function listZip(bytes: Uint8Array): ZipListing[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const out: ZipListing[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null;
    const flags = view.getUint16(at + 8, true), nameLength = view.getUint16(at + 28, true), extraLength = view.getUint16(at + 30, true), commentLength = view.getUint16(at + 32, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    out.push({
      name, flags, method: view.getUint16(at + 10, true), crc: view.getUint32(at + 16, true), compressedSize: view.getUint32(at + 20, true), size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true), encrypted: (flags & GP_ENCRYPTED) !== 0, directory: name.endsWith('/'),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
