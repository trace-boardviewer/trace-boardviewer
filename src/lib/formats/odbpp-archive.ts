/*
 * Original TRACE module (MIT). Bounded containers for ODB++ product models: gzip tar (.tgz/.tar.gz), plain tar, UNIX compress
 * (.tar.Z and single .Z members), ZIP (.zip, also one nested .tgz/.tar/.zip inside a ZIP) and an extracted directory given as a file set.
 *
 * Sources: RFC 1952 (gzip), PKWARE APPNOTE.TXT 6.3 (ZIP, ZIP64), the POSIX ustar/pax interchange formats (see tar.ts) and the
 * ODB++ Design Format Specification 8.1 (file system, optional .Z compression). The LZW decoder follows the published behaviour of
 * the compress(1) format (9..16-bit codes, block-mode CLEAR, code groups padded at each width change); no implementation code was used.
 * gzip streams are inflated with fflate (MIT, already a dependency); ZIP members with the bounded inflater in compression.ts.
 *
 * Safety model: nothing is written to disk and only the few ODB++ files the reader needs are kept. Every entry path is normalized
 * (backslashes to slashes, "." dropped, case folded) and an absolute, drive-letter or ".." path is never used (it is counted and
 * disclosed). Links are never followed. Decompressed bytes are counted while they are produced, so a bomb stops at the stream budget;
 * kept bytes, entry counts and metadata sizes have their own budgets. ZIP members are checked against their declared size and CRC-32.
 */
import { Gunzip } from 'fflate';
import { BoardFormatError, MAX_IMPORT_BYTES } from './common';
import { inflateRaw } from './compression';
import { TarReader } from './tar';

export interface OdbppLimits {
  /** Largest archive accepted (the import dispatcher applies its own 64 MiB file cap before this). */
  maxArchiveBytes: number;
  /** Decompressed bytes a tar stream may produce in total, kept or not. */
  maxStreamBytes: number;
  maxEntries: number;
  /** Largest single kept file (at most the 64 MiB text limit). */
  maxEntryBytes: number;
  maxKeptBytes: number;
  maxMetaBytes: number;
  maxPathLength: number;
  /** Decompressed prefix of a gzip/compress stream that sniffing inspects. */
  sniffBytes: number;
}
export const DEFAULT_ODBPP_LIMITS: Readonly<OdbppLimits> = Object.freeze({
  maxArchiveBytes: 1024 * 1024 * 1024, maxStreamBytes: 1024 * 1024 * 1024, maxEntries: 200_000, maxEntryBytes: MAX_IMPORT_BYTES,
  maxKeptBytes: 192 * 1024 * 1024, maxMetaBytes: 64 * 1024, maxPathLength: 1024, sniffBytes: 16 * 1024 * 1024,
});
export function resolveLimits(limits: Partial<OdbppLimits> = {}): OdbppLimits {
  const merged = { ...DEFAULT_ODBPP_LIMITS, ...limits };
  for (const [key, value] of Object.entries(merged)) if (!Number.isSafeInteger(value) || value < 1) throw new BoardFormatError(`Invalid ODB++ limit ${key}.`);
  merged.maxEntryBytes = Math.min(merged.maxEntryBytes, MAX_IMPORT_BYTES);
  return merged;
}

export type OdbppContainer = 'tgz' | 'tar' | 'tar.Z' | 'zip' | 'files';
export interface OdbppTree {
  container: OdbppContainer;
  /** Kept ODB++ files by normalized (lowercase, slash-separated) path, .Z members already decompressed. */
  files: Map<string, Uint8Array>;
  /** Every normalized path seen (files only), for structure checks. Bounded by maxEntries. */
  seen: number;
  unsafePaths: number;
  links: number;
  duplicates: number;
  compressedMembers: number;
  /** A tar stream ended at an entry boundary without its end-of-archive block. */
  endMissing: boolean;
  /** Name of the nested archive that was opened, when the ODB++ model sat inside another archive. */
  nested?: string;
}

const fail = (message: string, code: 'INVALID_FORMAT' | 'LIMIT_EXCEEDED' | 'UNSUPPORTED_VARIANT' = 'INVALID_FORMAT'): never => { throw new BoardFormatError(`ODB++ archive: ${message}`, code); };

/** CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) as used by ZIP and gzip. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  return table;
})();
export function crc32(data: Uint8Array): number {
  let crc = -1;
  for (let index = 0; index < data.length; index++) crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * A relative archive path in canonical form: slashes, no empty or "." segments, lowercase (ODB++ entity names are lowercase; the
 * matrix may spell them in capitals). Returns null for anything that could point outside the archive root: an absolute path, a drive
 * letter, a ".." segment, a NUL byte, or a path longer than the limit.
 */
export function normalizeEntryPath(raw: string, maxLength = DEFAULT_ODBPP_LIMITS.maxPathLength): string | null {
  if (raw.length > maxLength || raw.includes('\0')) return null;
  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) return null;
  const parts: string[] = [];
  for (const part of unified.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.join('/').toLowerCase();
}

/** The ODB++ files a board needs, below at most two leading directories (the product model directory and one wrapper). */
const ODB_TAIL = /^(?:matrix\/matrix|misc\/info|steps\/[^/]+\/(?:stephdr|profile|eda\/data|layers\/[^/]+\/components|netlists\/cadnet\/netlist))(?:\.z)?$/;
/** Shallowest split of `path` into a product-model root ("" or "job/" or "wrap/job/") and an ODB++ tail; null when it is not a needed file. */
export function odbTail(path: string): { root: string; tail: string } | null {
  let root = '', rest = path;
  for (let depth = 0; depth <= 2; depth++) {
    if (ODB_TAIL.test(rest)) return { root, tail: rest };
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    root += rest.slice(0, slash + 1); rest = rest.slice(slash + 1);
  }
  return null;
}
/** Paths that only show an ODB++ layout (directories, other step files): used by sniffing, never kept. */
const ODB_HINT = /^(?:(?:[^/]+\/){0,2})(?:matrix\/matrix(?:\.z)?$|steps\/[^/]+\/(?:stephdr|profile|eda\/|layers\/|netlists\/))/;
const NESTED = /^(?:[^/]+\/){0,2}[^/]+\.(?:tgz|tar\.gz|tar|tar\.z|zip)$/;

class Collector {
  readonly files = new Map<string, Uint8Array>();
  seen = 0; unsafePaths = 0; links = 0; duplicates = 0; endMissing = false;
  constructor(readonly limits: OdbppLimits) {}
  /** Normalized path to keep, or null. Counts unsafe names and links. */
  select(raw: string, type: 'file' | 'directory' | 'link' | 'other'): string | null {
    const path = normalizeEntryPath(raw, this.limits.maxPathLength);
    if (path === null) { this.unsafePaths++; return null; }
    if (type === 'link') { this.links++; return null; }
    if (type !== 'file') return null;
    this.seen++;
    return odbTail(path) ? path : null;
  }
  keep(path: string, data: Uint8Array): void {
    if (this.files.has(path)) this.duplicates++; // tar semantics: a later member replaces an earlier one
    this.files.set(path, data);
  }
  tree(container: OdbppContainer, nested?: string): OdbppTree {
    let compressedMembers = 0, budget = this.limits.maxKeptBytes - [...this.files.values()].reduce((sum, data) => sum + data.length, 0);
    for (const [path, data] of [...this.files]) {
      if (!path.endsWith('.z')) continue;
      this.files.delete(path);
      const plain = path.slice(0, -2);
      if (this.files.has(plain)) { this.duplicates++; continue; }
      const chunks: Uint8Array[] = [];
      const limit = Math.min(this.limits.maxEntryBytes, Math.max(0, budget));
      const size = unlzw(data, chunk => chunks.push(chunk.slice()), limit);
      budget -= size;
      this.files.set(plain, concat(chunks, size)); compressedMembers++;
    }
    return { container, files: this.files, seen: this.seen, unsafePaths: this.unsafePaths, links: this.links, duplicates: this.duplicates, compressedMembers, endMissing: this.endMissing, ...(nested ? { nested } : {}) };
  }
}
function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1 && chunks[0].length === size) return chunks[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

// --- UNIX compress (.Z) ---

/**
 * Streaming LZW decoder for compress(1) data (magic 1F 9D). Output arrives at `sink` in chunks of up to 64 KiB (each chunk is
 * reused after the call returns) and stops with LIMIT_EXCEEDED at `maxOutput`. Returns the number of bytes produced.
 */
export function unlzw(data: Uint8Array, sink: (chunk: Uint8Array) => void, maxOutput: number): number {
  if (data.length < 3 || data[0] !== 0x1f || data[1] !== 0x9d) fail('a .Z member lacks the compress signature.');
  const maxBits = data[2] & 0x1f, block = (data[2] & 0x80) !== 0;
  if (maxBits < 9 || maxBits > 16) fail(`a .Z member uses ${maxBits}-bit codes (9 to 16 are defined).`);
  const maxMaxCode = 1 << maxBits, total = data.length * 8;
  const prefix = new Uint16Array(1 << 16), suffix = new Uint8Array(1 << 16), stack = new Uint8Array(1 << 16);
  for (let index = 0; index < 256; index++) suffix[index] = index;
  const out = new Uint8Array(64 * 1024);
  let fill = 0, written = 0;
  const emit = (byte: number) => {
    out[fill++] = byte;
    if (fill === out.length) { sink(out); fill = 0; }
  };
  let nBits = 9, maxCode = (1 << nBits) - 1, freeEnt = block ? 257 : 256, oldCode = -1, finChar = 0;
  let pos = 24, segment = 24;
  // At a width change or CLEAR the writer pads the current group of eight codes (nBits bytes) counted from the segment start.
  const align = () => { const group = nBits * 8; pos = segment + Math.ceil((pos - segment) / group) * group; segment = pos; };
  for (;;) {
    if (freeEnt > maxCode) { align(); nBits++; maxCode = nBits === maxBits ? maxMaxCode : (1 << nBits) - 1; if (nBits > 16) fail('a .Z member has an invalid code width.'); continue; }
    if (pos + nBits > total) break;
    const byte = pos >>> 3;
    const word = data[byte] | (byte + 1 < data.length ? data[byte + 1] << 8 : 0) | (byte + 2 < data.length ? data[byte + 2] << 16 : 0);
    let code = (word >>> (pos & 7)) & ((1 << nBits) - 1);
    pos += nBits;
    if (oldCode === -1) {
      if (code >= 256) fail('a .Z member starts with an invalid code.');
      oldCode = finChar = code;
      if (++written > maxOutput) fail('a .Z member expands beyond the size limit.', 'LIMIT_EXCEEDED');
      emit(code); continue;
    }
    if (code === 256 && block) { align(); nBits = 9; maxCode = (1 << nBits) - 1; freeEnt = 256; continue; }
    const incoming = code;
    let top = 0;
    if (code >= freeEnt) {
      if (code > freeEnt) fail('a .Z member is corrupt (code out of sequence).');
      stack[top++] = finChar; code = oldCode;
    }
    while (code >= 256) { stack[top++] = suffix[code]; code = prefix[code]; if (top >= stack.length) fail('a .Z member is corrupt (string too long).'); }
    finChar = suffix[code]; stack[top++] = finChar;
    if ((written += top) > maxOutput) fail('a .Z member expands beyond the size limit.', 'LIMIT_EXCEEDED');
    while (top > 0) emit(stack[--top]);
    if (freeEnt < maxMaxCode) { prefix[freeEnt] = oldCode; suffix[freeEnt] = finChar; freeEnt++; }
    oldCode = incoming;
  }
  if (fill) sink(out.subarray(0, fill));
  return written;
}

// --- gzip ---

class Stop extends Error {}
/**
 * Inflates a gzip stream in 4 KiB input steps (one step expands to at most about 4 MiB), counting output as it is produced; the sink never
 * sees a byte past the budget. With `stopAt` the stream is abandoned once that many bytes were produced (sniffing); otherwise the stream
 * must decode completely (or until the sink stops it) and, for a single-member file read to its end, its ISIZE trailer must match.
 */
function gunzip(data: Uint8Array, sink: (chunk: Uint8Array) => void, maxOutput: number, stopAt?: number): void {
  let produced = 0, members = 1;
  const cap = stopAt ?? maxOutput;
  const stream = new Gunzip(chunk => {
    const room = cap - produced;
    produced += chunk.length;
    if (chunk.length > room) {
      if (room > 0) sink(chunk.subarray(0, room));
      if (stopAt !== undefined) throw new Stop();
      fail(`the decompressed archive exceeds ${maxOutput} bytes.`, 'LIMIT_EXCEEDED');
    }
    sink(chunk);
    if (stopAt !== undefined && produced >= stopAt) throw new Stop();
  });
  stream.onmember = () => { members++; };
  const STEP = 4 * 1024;
  try {
    for (let at = 0; at < data.length; at += STEP) stream.push(data.subarray(at, at + STEP), at + STEP >= data.length);
  } catch (error) {
    if (error instanceof Stop) return;
    if (error instanceof BoardFormatError) throw error;
    fail(`damaged gzip stream (${error instanceof Error ? error.message.slice(0, 80) : 'error'}).`);
  }
  if (stopAt !== undefined) return;
  if (members === 1 && data.length >= 18) {
    const isize = (data[data.length - 4] | data[data.length - 3] << 8 | data[data.length - 2] << 16 | data[data.length - 1] << 24) >>> 0;
    if (isize !== produced % 0x1_0000_0000) fail('the gzip stream is truncated or damaged (length trailer mismatch).');
  }
}

// --- ZIP ---

interface ZipEntry { name: string; method: number; flags: number; crc: number; compressedSize: number; size: number; localOffset: number; link: boolean }
const u16 = (data: Uint8Array, at: number) => data[at] | data[at + 1] << 8;
const u32 = (data: Uint8Array, at: number) => (data[at] | data[at + 1] << 8 | data[at + 2] << 16 | data[at + 3] << 24) >>> 0;
function u64(data: Uint8Array, at: number): number {
  const value = u32(data, at) + u32(data, at + 4) * 0x1_0000_0000;
  if (!Number.isSafeInteger(value)) fail('a ZIP64 field exceeds the supported range.');
  return value;
}
const isZip = (data: Uint8Array) => data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 3 && data[3] === 4 || data[2] === 5 && data[3] === 6);
const utf8 = new TextDecoder('utf-8');

/** Central directory (with ZIP64 records), or null when the end-of-central-directory record is missing. */
function zipDirectory(data: Uint8Array, limits: OdbppLimits): ZipEntry[] | null {
  let eocd = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 0xffff); at--) {
    if (data[at] === 0x50 && data[at + 1] === 0x4b && data[at + 2] === 5 && data[at + 3] === 6 && at + 22 + u16(data, at + 20) <= data.length) { eocd = at; break; }
  }
  if (eocd < 0) return null;
  if (u16(data, eocd + 4) !== 0 || u16(data, eocd + 6) !== 0) fail('multi-volume ZIP archives are not supported.', 'UNSUPPORTED_VARIANT');
  let count = u16(data, eocd + 10), size = u32(data, eocd + 12), offset = u32(data, eocd + 16), end = eocd;
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(data, locator) !== 0x07064b50) fail('the ZIP64 locator is missing.');
    const record = u64(data, locator + 8);
    if (record + 56 > locator || u32(data, record) !== 0x06064b50) fail('the ZIP64 end record is missing.');
    count = u64(data, record + 32); size = u64(data, record + 40); offset = u64(data, record + 48); end = record;
  }
  if (count > limits.maxEntries) fail(`more than ${limits.maxEntries} entries.`, 'LIMIT_EXCEEDED');
  if (offset + size > end) fail('the central directory lies outside the file.');
  const entries: ZipEntry[] = [];
  let at = offset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > offset + size || u32(data, at) !== 0x02014b50) fail('the central directory is damaged.');
    const madeBy = u16(data, at + 4), flags = u16(data, at + 8), method = u16(data, at + 10), crc = u32(data, at + 16);
    // A Unix-made entry whose mode says symbolic link (S_IFLNK) is never read: its data is a link target, not a file.
    const link = madeBy >>> 8 === 3 && (u32(data, at + 38) >>> 16 & 0xf000) === 0xa000;
    let compressedSize = u32(data, at + 20), uncompressed = u32(data, at + 24);
    const nameLength = u16(data, at + 28), extraLength = u16(data, at + 30), commentLength = u16(data, at + 32);
    let localOffset = u32(data, at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > offset + size) fail('the central directory is damaged.');
    const name = utf8.decode(data.subarray(at + 46, at + 46 + nameLength));
    if (uncompressed === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let extra = at + 46 + nameLength, found = false;
      while (extra + 4 <= at + 46 + nameLength + extraLength) {
        const id = u16(data, extra), length = u16(data, extra + 2);
        if (id === 1) {
          let field = extra + 4;
          const take = () => { if (field + 8 > extra + 4 + length) fail('a ZIP64 extra field is too short.'); const value = u64(data, field); field += 8; return value; };
          if (uncompressed === 0xffffffff) uncompressed = take();
          if (compressedSize === 0xffffffff) compressedSize = take();
          if (localOffset === 0xffffffff) localOffset = take();
          found = true; break;
        }
        extra += 4 + length;
      }
      if (!found) fail('a ZIP64 entry lacks its extra field.');
    }
    entries.push({ name, method, flags, crc, compressedSize, size: uncompressed, localOffset, link });
    at = next;
  }
  return entries;
}
function zipData(data: Uint8Array, entry: ZipEntry, maxOutput: number): Uint8Array {
  const label = entry.name.slice(0, 120);
  if (entry.flags & 1) fail(`entry ${label} is encrypted; encrypted ZIP archives are not supported.`, 'UNSUPPORTED_VARIANT');
  if (entry.size > maxOutput) fail(`entry ${label} declares ${entry.size} bytes, over the ${maxOutput}-byte limit.`, 'LIMIT_EXCEEDED');
  const at = entry.localOffset;
  if (at + 30 > data.length || u32(data, at) !== 0x04034b50) fail(`the local header of ${label} is missing.`);
  const start = at + 30 + u16(data, at + 26) + u16(data, at + 28), end = start + entry.compressedSize;
  if (end > data.length) fail(`entry ${label} is truncated.`);
  const raw = data.subarray(start, end);
  let output: Uint8Array;
  if (entry.method === 0) output = raw;
  else if (entry.method === 8) {
    if (raw.length > MAX_IMPORT_BYTES) fail(`entry ${label} has more than ${MAX_IMPORT_BYTES} compressed bytes.`, 'LIMIT_EXCEEDED');
    // Inflation stops at the declared size, so a member that lies about its size cannot expand past it.
    try { output = inflateRaw(raw, entry.size).output; }
    catch (error) {
      if (error instanceof BoardFormatError && error.code === 'LIMIT_EXCEEDED') return fail(`entry ${label} expands beyond its declared size.`);
      if (error instanceof BoardFormatError) return fail(`entry ${label} is damaged: ${error.message.replace(/^Compressed board data: /, '')}`);
      throw error;
    }
  } else return fail(`entry ${label} uses compression method ${entry.method}; only stored and deflate are supported.`, 'UNSUPPORTED_VARIANT');
  if (output.length !== entry.size) fail(`entry ${label} does not match its declared size.`);
  if (crc32(output) !== entry.crc) fail(`entry ${label} fails its CRC-32 check.`);
  return output;
}
/** Names from the local headers of a ZIP without a usable central directory (bounded walk; stops at a data descriptor). */
function zipLocalNames(data: Uint8Array, limit: number): string[] {
  const names: string[] = [];
  let at = 0;
  while (names.length < limit && at + 30 <= data.length && u32(data, at) === 0x04034b50) {
    const flags = u16(data, at + 6), size = u32(data, at + 18), nameLength = u16(data, at + 26), extraLength = u16(data, at + 28);
    names.push(utf8.decode(data.subarray(at + 30, Math.min(data.length, at + 30 + nameLength))));
    if (flags & 8) break;
    at += 30 + nameLength + extraLength + size;
  }
  return names;
}

// --- tar helpers ---

const isTarHeader = (data: Uint8Array): boolean => {
  if (data.length < 512) return false;
  const magic = data[257] === 0x75 && data[258] === 0x73 && data[259] === 0x74 && data[260] === 0x61 && data[261] === 0x72;
  let sum = 0, stored = 0, digits = 0;
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : data[index];
  for (let index = 148; index < 156; index++) {
    const byte = data[index];
    if (byte >= 48 && byte <= 55) { stored = stored * 8 + byte - 48; digits++; } else if (digits && (byte === 0 || byte === 32)) break; else if (byte !== 32) return false;
  }
  return digits > 0 && stored === sum && (magic || data[156] === 0 || data[156] >= 48 && data[156] <= 55);
};
/** Streams tar bytes through `feed` (a decompressor or the bytes themselves) into a collector. */
function readTar(feed: (sink: (chunk: Uint8Array) => void) => void, collector: Collector): void {
  const { limits } = collector;
  let pending = '';
  const reader = new TarReader(entry => {
    const path = collector.select(entry.path, entry.type);
    if (path === null) return false;
    pending = path; return true;
  }, (_raw, data) => { collector.keep(pending, data); }, { maxEntries: limits.maxEntries, maxEntryBytes: limits.maxEntryBytes, maxKeptBytes: limits.maxKeptBytes, maxMetaBytes: limits.maxMetaBytes });
  // Decompression stops at the end-of-archive block: whatever follows it (padding, or a flood of zeros) is never inflated.
  try { feed(chunk => { reader.push(chunk); if (reader.done) throw new Stop(); }); }
  catch (error) { if (!(error instanceof Stop)) throw error; }
  if (reader.finish().endMissing) collector.endMissing = true;
}
/** Entry paths in a decompressed tar prefix (headers only; stops quietly at the end of the prefix, the end-of-archive block or a damaged header). */
function tarPrefixPaths(feed: (sink: (chunk: Uint8Array) => void) => void, limits: OdbppLimits): string[] {
  const paths: string[] = [];
  const reader = new TarReader(entry => { if (paths.length < limits.maxEntries) paths.push(entry.path); return false; }, () => {}, { maxEntries: limits.maxEntries, maxMetaBytes: limits.maxMetaBytes });
  try { feed(chunk => { reader.push(chunk); if (reader.done) throw new Stop(); }); }
  catch (error) { if (!(error instanceof BoardFormatError) && !(error instanceof Stop)) throw error; }
  return paths;
}

export type ContainerKind = 'gzip' | 'compress' | 'zip' | 'tar';
export function containerKind(data: Uint8Array): ContainerKind | null {
  if (data.length >= 18 && data[0] === 0x1f && data[1] === 0x8b && data[2] === 8) return 'gzip';
  if (data.length >= 3 && data[0] === 0x1f && data[1] === 0x9d) return 'compress';
  if (isZip(data)) return 'zip';
  return isTarHeader(data) ? 'tar' : null;
}

export interface ContainerSniff {
  container: OdbppContainer;
  paths: string[];
  nested?: string;
  /** For a compressed stream: whether its first block is a tar header (true), certainly is not one (false) or the stream ended before a whole block (null). */
  tar?: boolean | null;
}
/** Remembers the first 512 bytes of a stream to tell whether it starts like a tar archive. */
function blockProbe() {
  const block = new Uint8Array(512);
  let filled = 0;
  return {
    take(chunk: Uint8Array): void { if (filled < block.length) { const count = Math.min(block.length - filled, chunk.length); block.set(chunk.subarray(0, count), filled); filled += count; } },
    get tar(): boolean | null { return filled < block.length ? null : isTarHeader(block); },
  };
}
/**
 * Bounded look at an archive: the entry paths of a ZIP central directory (or, for a damaged ZIP, its local headers), of a plain tar, or
 * of the first `sniffBytes` of a gzip/compress tar. A ZIP that holds no ODB++ paths but exactly one archive is looked into once.
 */
export function sniffContainer(data: Uint8Array, limits: OdbppLimits, depth = 0): ContainerSniff | null {
  const kind = containerKind(data);
  if (!kind) return null;
  const cap = Math.min(limits.sniffBytes, limits.maxStreamBytes);
  try {
    switch (kind) {
      case 'gzip': {
        const probe = blockProbe();
        const paths = tarPrefixPaths(sink => gunzip(data, chunk => { probe.take(chunk); sink(chunk); }, cap, cap), limits);
        return { container: 'tgz', paths, tar: probe.tar };
      }
      case 'compress': {
        const probe = blockProbe();
        const paths = tarPrefixPaths(sink => { try { unlzw(data, chunk => { probe.take(chunk); sink(chunk); }, cap); } catch (error) { if (!(error instanceof BoardFormatError) || error.code !== 'LIMIT_EXCEEDED') throw error; } }, limits);
        return { container: 'tar.Z', paths, tar: probe.tar };
      }
      case 'tar': return { container: 'tar', paths: tarPrefixPaths(sink => sink(data.subarray(0, Math.min(data.length, cap))), limits) };
      case 'zip': {
        const entries = zipDirectory(data, limits);
        const paths = entries ? entries.map(entry => entry.name) : zipLocalNames(data, Math.min(limits.maxEntries, 4096));
        if (entries && depth === 0 && !paths.some(path => looksOdb(path, limits))) {
          const nested = nestedArchive(entries, limits);
          if (nested) {
            const inner = sniffContainer(zipData(data, nested, limits.maxEntryBytes), limits, 1);
            if (inner?.paths.some(path => looksOdb(path, limits))) return { container: 'zip', paths: inner.paths, nested: nested.name };
          }
        }
        return { container: 'zip', paths };
      }
    }
  } catch (error) {
    if (error instanceof BoardFormatError) return { container: kind === 'gzip' ? 'tgz' : kind === 'compress' ? 'tar.Z' : kind, paths: [] };
    throw error;
  }
}
export function looksOdb(raw: string, limits: OdbppLimits = DEFAULT_ODBPP_LIMITS): boolean {
  const path = normalizeEntryPath(raw, limits.maxPathLength);
  return path !== null && (odbTail(path) !== null || ODB_HINT.test(path) || ODB_HINT.test(`${path}/`));
}
/**
 * An unsafe entry path (absolute, drive letter, "..") that would show an ODB++ layout once its unsafe parts were dropped. Such entries are
 * never read; this only lets the reader say why an archive of them yields nothing instead of calling it "not ODB++".
 */
export function looksOdbUnsafe(raw: string, limits: OdbppLimits = DEFAULT_ODBPP_LIMITS): boolean {
  if (raw.length > limits.maxPathLength || normalizeEntryPath(raw, limits.maxPathLength) !== null) return false;
  const stripped = raw.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').split('/').filter(part => part && part !== '.' && part !== '..' && !part.includes('\0')).join('/');
  return looksOdb(stripped, limits);
}
function nestedArchive(entries: ZipEntry[], limits: OdbppLimits): ZipEntry | undefined {
  const candidates = entries.filter(entry => { const path = normalizeEntryPath(entry.name, limits.maxPathLength); return path !== null && NESTED.test(path); });
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Opens an archive and keeps the ODB++ files a board needs. Returns null when the bytes are not an archive this module reads;
 * throws BoardFormatError for a damaged archive or an exceeded budget.
 */
export function readContainer(data: Uint8Array, limits: OdbppLimits, depth = 0): OdbppTree | null {
  if (data.length > limits.maxArchiveBytes) fail(`the archive exceeds ${limits.maxArchiveBytes} bytes.`, 'LIMIT_EXCEEDED');
  const kind = containerKind(data);
  if (!kind) return null;
  const collector = new Collector(limits);
  switch (kind) {
    case 'gzip': readTar(sink => gunzip(data, sink, limits.maxStreamBytes), collector); return collector.tree('tgz');
    case 'compress': readTar(sink => unlzw(data, sink, limits.maxStreamBytes), collector); return collector.tree('tar.Z');
    case 'tar': readTar(sink => sink(data), collector); return collector.tree('tar');
    case 'zip': {
      const entries = zipDirectory(data, limits);
      if (!entries) {
        if (zipLocalNames(data, Math.min(limits.maxEntries, 4096)).some(path => looksOdb(path, limits))) fail('the ZIP archive is truncated or damaged (its central directory is missing).');
        return null;
      }
      let kept = 0;
      for (const entry of entries) {
        const type = entry.link ? 'link' : entry.name.endsWith('/') ? 'directory' : 'file';
        const path = collector.select(entry.name, type);
        if (path === null) continue;
        const output = zipData(data, entry, Math.min(limits.maxEntryBytes, limits.maxKeptBytes - kept));
        kept += output.length;
        collector.keep(path, output);
      }
      if (!collector.files.size && depth === 0) {
        const nested = nestedArchive(entries, limits);
        if (nested) {
          const inner = readContainer(zipData(data, nested, limits.maxEntryBytes), limits, 1);
          if (inner && inner.files.size) return { ...inner, unsafePaths: inner.unsafePaths + collector.unsafePaths, nested: nested.name };
        }
      }
      return collector.tree('zip');
    }
  }
}

/** An extracted product-model directory handed over as relative path → bytes (any depth; the same path rules and budgets apply). */
export function treeFromFiles(files: Readonly<Record<string, Uint8Array>> | ReadonlyMap<string, Uint8Array>, limits: OdbppLimits): OdbppTree {
  const collector = new Collector(limits);
  const list = files instanceof Map ? [...files] : Object.entries(files);
  if (list.length > limits.maxEntries) fail(`more than ${limits.maxEntries} files.`, 'LIMIT_EXCEEDED');
  let kept = 0;
  for (const [raw, data] of list) {
    if (!(data instanceof Uint8Array)) fail('every file of a file set must be a byte array.');
    const path = collector.select(raw, 'file');
    if (path === null) continue;
    if (data.length > limits.maxEntryBytes) fail(`file ${path.slice(0, 120)} exceeds ${limits.maxEntryBytes} bytes.`, 'LIMIT_EXCEEDED');
    if ((kept += data.length) > limits.maxKeptBytes) fail(`the selected files exceed ${limits.maxKeptBytes} bytes.`, 'LIMIT_EXCEEDED');
    collector.keep(path, data);
  }
  return collector.tree('files');
}
