/*
 * Original TRACE code (MIT). Bounded ZIP reader for EasyEDA Pro project archives (".epro", also the project backups the EasyEDA Pro client writes as
 * ".zip"). Container reference: PKWARE APPNOTE.TXT (end of central directory 4.3.16, central directory file header 4.3.12, local file header 4.3.7).
 *
 * The central directory is read first (entry names and declared sizes, no inflation); an entry is inflated only when the caller asks for it, in
 * 16 KiB input slices of a streaming fflate Inflate, and the running output is checked against the caller's limit after every slice. A
 * deflate stream cannot expand by more than about 1032:1, so a slice never allocates more than about 17 MB before the check, whatever size the
 * header declares. The declared size is also verified (a lying header is an error) and so is the CRC-32. Entry names are only map keys: nothing
 * here touches a file system.
 */
import { Inflate } from 'fflate';
import { BoardFormatError, MAX_IMPORT_BYTES, type FormatErrorCode } from './common';

export const ZIP_MAX_ENTRIES = 50_000;
/** Largest single decompressed entry (a PCB document is the biggest thing in a project). */
export const ZIP_MAX_ENTRY_BYTES = 96 * 1024 * 1024;
/** Everything inflated from one archive together. */
export const ZIP_MAX_TOTAL_BYTES = 192 * 1024 * 1024;
const SLICE = 16 * 1024;
const MAX_NAME_BYTES = 1024;

export interface ZipEntry {
  /** Normalized: forward slashes, no leading "./" or "/". */
  name: string;
  method: 0 | 8;
  compressedSize: number;
  size: number;
  crc: number;
  /** Offset of the compressed data in the archive (already past the local header). */
  start: number;
}
export interface ZipArchive {
  entries: ZipEntry[];
  byName: Map<string, ZipEntry>;
  /** Inflates one entry; `limit` is the largest acceptable decompressed size for it. */
  read(entry: ZipEntry, limit?: number): Uint8Array;
  /** Decompressed bytes handed out so far. */
  readonly produced: number;
}

export const isZipSignature = (data: Uint8Array): boolean => data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4;

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index++) crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* fall through */ } }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}
const normalizeName = (name: string): string => name.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');

/**
 * Lists the archive without inflating anything. Returns null when `data` is not a ZIP at all (no end-of-central-directory record in the last
 * 64 KiB); a ZIP with an unreadable directory throws BoardFormatError(format).
 */
export function openZip(data: Uint8Array, format: string): ZipArchive | null {
  if (data.length > MAX_IMPORT_BYTES) throw new BoardFormatError('Board data exceeds the 64 MiB import limit.', 'LIMIT_EXCEEDED', format);
  const fail = (message: string, code: FormatErrorCode = 'INVALID_FORMAT'): never => { throw new BoardFormatError(`${format}: ${message}`, code, format); };
  if (data.length < 22) return null;
  const dv = view(data);
  let eocd = -1;
  const floor = Math.max(0, data.length - 22 - 0xffff);
  for (let at = data.length - 22; at >= floor; at--) {
    if (dv.getUint32(at, true) !== 0x06054b50) continue;
    const commentLength = dv.getUint16(at + 20, true);
    if (at + 22 + commentLength === data.length) { eocd = at; break; }
    if (eocd < 0 && at + 22 + commentLength <= data.length) eocd = at; // trailing junk after the comment: accept the nearest record, but keep looking for an exact one
  }
  if (eocd < 0) return null;
  const total = dv.getUint16(eocd + 10, true), directorySize = dv.getUint32(eocd + 12, true), directoryOffset = dv.getUint32(eocd + 16, true);
  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) fail('ZIP64 archives are not supported.', 'UNSUPPORTED_VARIANT');
  if (dv.getUint16(eocd + 4, true) !== 0 || dv.getUint16(eocd + 6, true) !== 0) fail('multi-disk archives are not supported.', 'UNSUPPORTED_VARIANT');
  if (total > ZIP_MAX_ENTRIES) fail(`the archive has ${total} entries; the import limit is ${ZIP_MAX_ENTRIES}.`, 'LIMIT_EXCEEDED');
  if (directoryOffset + directorySize > eocd) fail('the central directory lies outside the archive.');
  const entries: ZipEntry[] = [], byName = new Map<string, ZipEntry>();
  let at = directoryOffset;
  for (let index = 0; index < total; index++) {
    if (at + 46 > directoryOffset + directorySize || dv.getUint32(at, true) !== 0x02014b50) fail('the central directory is damaged.');
    const flags = dv.getUint16(at + 8, true), method = dv.getUint16(at + 10, true), crc = dv.getUint32(at + 16, true);
    const compressedSize = dv.getUint32(at + 20, true), size = dv.getUint32(at + 24, true);
    const nameLength = dv.getUint16(at + 28, true), extraLength = dv.getUint16(at + 30, true), commentLength = dv.getUint16(at + 32, true), localOffset = dv.getUint32(at + 42, true);
    if (nameLength > MAX_NAME_BYTES) fail('an entry name is too long.', 'LIMIT_EXCEEDED');
    if (at + 46 + nameLength + extraLength + commentLength > directoryOffset + directorySize) fail('the central directory is damaged.');
    const name = normalizeName(decodeName(data.subarray(at + 46, at + 46 + nameLength), (flags & 0x800) !== 0));
    at += 46 + nameLength + extraLength + commentLength;
    if (!name || name.endsWith('/')) continue; // directories carry no data
    if (flags & 1) fail(`entry "${name.slice(0, 80)}" is encrypted, which is not supported.`, 'UNSUPPORTED_VARIANT');
    if (method !== 0 && method !== 8) fail(`entry "${name.slice(0, 80)}" uses compression method ${method}; only stored and deflate are supported.`, 'UNSUPPORTED_VARIANT');
    if (compressedSize === 0xffffffff || size === 0xffffffff) fail('ZIP64 archives are not supported.', 'UNSUPPORTED_VARIANT');
    if (localOffset + 30 > data.length || dv.getUint32(localOffset, true) !== 0x04034b50) fail(`entry "${name.slice(0, 80)}" has no local header.`);
    const start = localOffset + 30 + dv.getUint16(localOffset + 26, true) + dv.getUint16(localOffset + 28, true);
    if (start + compressedSize > directoryOffset) fail(`entry "${name.slice(0, 80)}" extends beyond the archive.`);
    if (method === 0 && compressedSize !== size) fail(`stored entry "${name.slice(0, 80)}" declares two different sizes.`);
    if (byName.has(name)) fail(`the archive lists "${name.slice(0, 80)}" twice.`);
    const entry: ZipEntry = { name, method: method === 0 ? 0 : 8, compressedSize, size, crc, start };
    entries.push(entry); byName.set(name, entry);
  }
  let produced = 0;
  const read = (entry: ZipEntry, limit = ZIP_MAX_ENTRY_BYTES): Uint8Array => {
    if (entry.size > limit) fail(`entry "${entry.name.slice(0, 80)}" declares ${entry.size} bytes; the limit is ${limit}.`, 'LIMIT_EXCEEDED');
    if (produced + entry.size > ZIP_MAX_TOTAL_BYTES) fail('the archive would expand beyond the total import limit.', 'LIMIT_EXCEEDED');
    const compressed = data.subarray(entry.start, entry.start + entry.compressedSize);
    let output: Uint8Array;
    if (entry.method === 0) output = compressed.slice();
    else {
      output = new Uint8Array(entry.size);
      let written = 0;
      const inflate = new Inflate((chunk: Uint8Array) => {
        if (written + chunk.length > entry.size) throw new BoardFormatError(`${format}: entry "${entry.name.slice(0, 80)}" expands beyond its declared ${entry.size} bytes.`, 'INVALID_FORMAT', format);
        output.set(chunk, written); written += chunk.length;
      });
      try {
        if (!compressed.length) inflate.push(new Uint8Array(0), true);
        for (let offset = 0; offset < compressed.length; offset += SLICE) inflate.push(compressed.subarray(offset, Math.min(compressed.length, offset + SLICE)), offset + SLICE >= compressed.length);
      } catch (error) {
        if (error instanceof BoardFormatError) throw error;
        throw new BoardFormatError(`${format}: entry "${entry.name.slice(0, 80)}" is not valid deflate data.`, 'INVALID_FORMAT', format);
      }
      if (written !== entry.size) fail(`entry "${entry.name.slice(0, 80)}" holds ${written} bytes but declares ${entry.size}.`);
    }
    if (crc32(output) !== entry.crc) fail(`entry "${entry.name.slice(0, 80)}" fails its CRC-32 check.`);
    produced += output.length;
    return output;
  };
  return { entries, byName, read, get produced() { return produced; } };
}
