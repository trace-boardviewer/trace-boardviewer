/*
 * Bounded ZIP reader for board imports (original TRACE module, MIT; layout facts from the PKWARE APPNOTE).
 * Only the central directory is trusted for sizes; every offset and length is checked against the archive before use,
 * entries are inflated in small input chunks (fflate's streaming Inflate) with a hard output budget, so a decompression
 * bomb never allocates more than one chunk's expansion past its budget, and every extracted entry must match its
 * declared size and CRC-32. Nothing is written to disk: entry names are labels only.
 */
import { Inflate } from 'fflate';
import type { ContainerEntry, ContainerLimits } from './adapter';
import { localizedFormatError } from './common';

const EOCD = 0x06054b50, ZIP64_LOCATOR = 0x07064b50, ZIP64_EOCD = 0x06064b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const EOCD_SIZE = 22, MAX_COMMENT = 0xffff, CENTRAL_SIZE = 46, LOCAL_SIZE = 30;
/** Compressed bytes per inflate push: bounds the output one push can produce (deflate expands at most about 1032:1). */
const INPUT_CHUNK = 4096;
/** Entries above this declared size must stay within the ratio limit. */
const RATIO_FLOOR = 1 << 20;
const FORMAT = 'ZIP archive';

const damaged = (detail: string) => localizedFormatError(`ZIP archive: ${detail}`, 'INVALID_FORMAT', { key: 'parse.error.archiveDamaged' }, FORMAT);

const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
/** Entry names are UTF-8 when general-purpose bit 11 says so (or when they decode as UTF-8), otherwise IBM code page 437. */
function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag || bytes.every(byte => byte < 0x80)) return new TextDecoder('utf-8').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { let text = ''; for (const byte of bytes) text += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80]; return text; }
}
/** A relative path with '/' separators, or null for names that could escape a folder (absolute, drive, '..', NUL). */
function normalizePath(name: string): string | null {
  const path = name.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (!path || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  if (path.split('/').some(segment => segment === '..')) return null;
  return path;
}

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

export interface ZipEntry extends ContainerEntry {
  /** Normalized relative path; '' for an entry whose name was refused (see `skipped`). */
  readonly path: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly method: number;
  readonly encrypted: boolean;
  readonly directory: boolean;
  /** Why the entry is never offered as a board or companion: an unsafe name, a directory, or operating-system metadata. */
  readonly skipped?: 'unsafe-name' | 'directory' | 'metadata';
}

/**
 * Reads the central directory of a ZIP archive (single disk; ZIP64 sizes and offsets supported) and returns its entries.
 * Throws BoardFormatError (INVALID_FORMAT, LIMIT_EXCEEDED, UNSUPPORTED_VARIANT) with a catalog `issue` for every refusal.
 */
export function readZip(data: Uint8Array, limits: ContainerLimits): ZipEntry[] {
  if (data.length > limits.maxArchiveBytes) throw localizedFormatError('ZIP archive exceeds the import limit.', 'LIMIT_EXCEEDED', { key: 'parse.error.archiveTooLarge', params: { max: Math.floor(limits.maxArchiveBytes / 1048576) } }, FORMAT);
  if (data.length < EOCD_SIZE) throw damaged('the file is shorter than an end-of-central-directory record.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (at: number) => view.getUint16(at, true), u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => { const value = view.getBigUint64(at, true); if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw damaged('a ZIP64 field is out of range.'); return Number(value); };

  let eocd = -1;
  for (let at = data.length - EOCD_SIZE, stop = Math.max(0, data.length - EOCD_SIZE - MAX_COMMENT); at >= stop; at--) {
    if (u32(at) === EOCD && at + EOCD_SIZE + u16(at + 20) === data.length) { eocd = at; break; }
  }
  if (eocd < 0) throw damaged('no end-of-central-directory record was found.');
  let disk = u16(eocd + 4), cdDisk = u16(eocd + 6), diskEntries = u16(eocd + 8), entries = u16(eocd + 10), cdSize = u32(eocd + 12), cdOffset = u32(eocd + 16);
  let cdEnd = eocd;
  if (entries === 0xffff || diskEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(locator) !== ZIP64_LOCATOR) throw damaged('the ZIP64 end-of-central-directory locator is missing.');
    const record = u64(locator + 8);
    if (record + 56 > locator || u32(record) !== ZIP64_EOCD) throw damaged('the ZIP64 end-of-central-directory record is missing.');
    disk = u32(record + 16); cdDisk = u32(record + 20); diskEntries = u64(record + 24); entries = u64(record + 32); cdSize = u64(record + 40); cdOffset = u64(record + 48);
    cdEnd = record;
  }
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== entries) {
    throw localizedFormatError('ZIP archive: split (multi-disk) archives are not supported.', 'UNSUPPORTED_VARIANT', { key: 'parse.error.archiveSplit' }, FORMAT);
  }
  if (entries > limits.maxEntries) throw localizedFormatError(`ZIP archive lists ${entries} entries; at most ${limits.maxEntries} are read.`, 'LIMIT_EXCEEDED', { key: 'parse.error.archiveTooManyEntries', params: { max: limits.maxEntries } }, FORMAT);
  // Data in front of the archive (a self-extractor stub) shifts every stored offset by the same amount.
  const shift = cdEnd - cdSize - cdOffset;
  if (shift < 0 || cdOffset + shift + cdSize > cdEnd) throw damaged('the central directory lies outside the archive.');
  if (entries * CENTRAL_SIZE > cdSize) throw damaged('the central directory is shorter than its entry count.');

  const list: ZipEntry[] = [], seen = new Set<string>();
  let at = cdOffset + shift;
  const end = at + cdSize;
  for (let index = 0; index < entries; index++) {
    if (at + CENTRAL_SIZE > end || u32(at) !== CENTRAL) throw damaged(`central directory record ${index + 1} is missing or damaged.`);
    const flags = u16(at + 8), method = u16(at + 10), crc = u32(at + 16);
    let compressedSize = u32(at + 20), size = u32(at + 24), localOffset = u32(at + 42);
    const nameLength = u16(at + 28), extraLength = u16(at + 30), commentLength = u16(at + 32);
    const nameAt = at + CENTRAL_SIZE, extraAt = nameAt + nameLength, next = extraAt + extraLength + commentLength;
    if (next > end) throw damaged(`central directory record ${index + 1} runs past the directory.`);
    // ZIP64 extended information: the 64-bit values follow in this order, each present only where the 32-bit field is saturated.
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let field = extraAt, found = false;
      while (field + 4 <= extraAt + extraLength) {
        const id = u16(field), length = u16(field + 2), body = field + 4;
        if (body + length > extraAt + extraLength) break;
        if (id === 0x0001) {
          let cursor = body;
          const take = () => { if (cursor + 8 > body + length) throw damaged('a ZIP64 extra field is truncated.'); const value = u64(cursor); cursor += 8; return value; };
          if (size === 0xffffffff) size = take();
          if (compressedSize === 0xffffffff) compressedSize = take();
          if (localOffset === 0xffffffff) localOffset = take();
          found = true; break;
        }
        field = body + length;
      }
      if (!found) throw damaged('a ZIP64 entry lacks its extended size field.');
    }
    const raw = decodeName(data.subarray(nameAt, extraAt), (flags & 0x0800) !== 0);
    const normalized = normalizePath(raw);
    const directory = raw.endsWith('/') || raw.endsWith('\\');
    const skipped = normalized === null ? 'unsafe-name' as const : directory ? 'directory' as const
      : /(?:^|\/)__MACOSX\//.test(normalized) || /(?:^|\/)\._[^/]*$/.test(normalized) ? 'metadata' as const : undefined;
    const path = normalized ?? '';
    if (!skipped) {
      const folded = path.toLowerCase();
      if (seen.has(folded)) throw damaged(`the entry ${path.slice(0, 120)} is listed twice.`);
      seen.add(folded);
    }
    list.push(makeEntry(data, view, { path, size, compressedSize, method, crc, flags, localOffset: localOffset + shift, directory, skipped, cdStart: cdOffset + shift, limits }));
    at = next;
  }
  return list;
}

interface EntrySpec {
  path: string; size: number; compressedSize: number; method: number; crc: number; flags: number; localOffset: number;
  directory: boolean; skipped?: ZipEntry['skipped']; cdStart: number; limits: ContainerLimits;
}
function makeEntry(data: Uint8Array, view: DataView, spec: EntrySpec): ZipEntry {
  const { path, size, compressedSize, method } = spec, encrypted = (spec.flags & 0x0001) !== 0;
  const label = path.slice(0, 200);
  /** Start of the compressed bytes, after the local header (whose own size fields may be zero when a data descriptor follows). */
  const payload = (): Uint8Array => {
    if (encrypted) throw localizedFormatError(`ZIP archive: ${label} is encrypted.`, 'UNSUPPORTED_VARIANT', { key: 'parse.error.archiveEncrypted', params: { entry: label } }, FORMAT);
    if (method !== 0 && method !== 8) throw localizedFormatError(`ZIP archive: ${label} uses compression method ${method}.`, 'UNSUPPORTED_VARIANT', { key: 'parse.error.archiveMethod', params: { entry: label, method } }, FORMAT);
    const local = spec.localOffset;
    if (local + LOCAL_SIZE > spec.cdStart || view.getUint32(local, true) !== LOCAL) throw damaged(`the local header of ${label} is missing.`);
    const start = local + LOCAL_SIZE + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + compressedSize > spec.cdStart) throw damaged(`the data of ${label} runs past the archive.`);
    if (method === 0 && compressedSize !== size) throw damaged(`the stored entry ${label} has inconsistent sizes.`);
    if (method === 8 && size > RATIO_FLOOR && size / Math.max(1, compressedSize) > spec.limits.maxRatio) {
      throw localizedFormatError(`ZIP archive: ${label} declares a ${Math.round(size / Math.max(1, compressedSize))}:1 expansion.`, 'LIMIT_EXCEEDED', { key: 'parse.error.archiveRatio', params: { entry: label, ratio: spec.limits.maxRatio } }, FORMAT);
    }
    return data.subarray(start, start + compressedSize);
  };
  /** Inflates at most `limit` bytes; `whole` also requires the stream to end exactly at the declared size. */
  const inflate = (limit: number, whole: boolean): Uint8Array => {
    const input = payload();
    if (method === 0) return input.subarray(0, Math.min(limit, input.length));
    const out = new Uint8Array(Math.min(limit, size));
    let filled = 0, ended = false, over = false;
    const stream = new Inflate((chunk, final) => {
      const room = out.length - filled;
      if (chunk.length > room) { over = true; out.set(chunk.subarray(0, room), filled); filled += room; }
      else { out.set(chunk, filled); filled += chunk.length; }
      if (final) ended = true;
    });
    try {
      for (let offset = 0; offset < input.length && !over && !(filled >= out.length && !whole); offset += INPUT_CHUNK) {
        stream.push(input.subarray(offset, offset + INPUT_CHUNK), offset + INPUT_CHUNK >= input.length);
      }
    } catch { throw damaged(`the compressed data of ${label} is damaged.`); }
    if (whole) {
      if (over) throw damaged(`${label} holds more data than its declared size.`);
      if (!ended || filled !== size) throw damaged(`${label} holds less data than its declared size.`);
    }
    return filled === out.length ? out : out.subarray(0, filled);
  };
  return Object.freeze({
    path, size, compressedSize, method, encrypted, directory: spec.directory, ...(spec.skipped ? { skipped: spec.skipped } : {}),
    head: (limit: number) => inflate(Math.max(0, Math.min(limit, size)), false),
    read(budget: number): Uint8Array {
      if (size > budget) throw localizedFormatError(`ZIP archive: ${label} is larger than the remaining unpack budget.`, 'LIMIT_EXCEEDED', { key: 'parse.error.archiveTooLarge', params: { max: Math.floor(spec.limits.maxExtractedBytes / 1048576) } }, FORMAT);
      const bytes = inflate(size, true);
      if (crc32(bytes) !== spec.crc) throw damaged(`the CRC-32 of ${label} does not match.`);
      return bytes;
    },
  });
}

