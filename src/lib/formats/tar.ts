/*
 * Original TRACE module (MIT). Bounded streaming reader for tar archives: POSIX ustar (IEEE Std 1003.1 "ustar Interchange Format"),
 * pax extended headers ('x' per entry, 'g' global) and the GNU long-name extension ('L'), as described in the POSIX pax utility
 * specification and the GNU tar manual ("Basic Tar Format"). No tar implementation code was used.
 *
 * Nothing is extracted to disk: entry paths are handed to the caller as plain data, and only regular files are ever delivered.
 * Hard links, symbolic links, devices and FIFOs are skipped and counted, so a link can never make one entry stand for another.
 * Every count and size is bounded (entries, path length, metadata records, bytes kept per entry and in total); a damaged header or
 * an entry cut off by the end of the stream is an error, never a silently shorter archive. A stream that stops exactly at an entry
 * boundary without the end-of-archive block (some writers omit it) is accepted, and `summary.endMissing` says so.
 */
import { BoardFormatError } from './common';

export interface TarLimits {
  /** Headers of any kind (files, directories, links, metadata). */
  maxEntries: number;
  /** Largest single entry the caller may keep. */
  maxEntryBytes: number;
  /** Sum of all kept entries. */
  maxKeptBytes: number;
  /** Size of one pax or GNU long-name metadata record. */
  maxMetaBytes: number;
}
export const DEFAULT_TAR_LIMITS: Readonly<TarLimits> = Object.freeze({ maxEntries: 200_000, maxEntryBytes: 64 * 1024 * 1024, maxKeptBytes: 192 * 1024 * 1024, maxMetaBytes: 64 * 1024 });

export type TarEntryType = 'file' | 'directory' | 'link' | 'other';
export interface TarEntryInfo { path: string; size: number; type: TarEntryType }
export interface TarSummary {
  headers: number; files: number; links: number; other: number;
  /** The stream ended at an entry boundary without the end-of-archive block. */
  endMissing: boolean;
}

const BLOCK = 512;
const fail = (message: string, code: 'INVALID_FORMAT' | 'LIMIT_EXCEEDED' = 'INVALID_FORMAT'): never => { throw new BoardFormatError(`Tar archive: ${message}`, code); };
const utf8 = new TextDecoder('utf-8');
/** NUL-terminated header text field. Header names are decoded as UTF-8 (pax requires it; ASCII names are unaffected). */
function field(header: Uint8Array, from: number, length: number): string {
  let end = from;
  while (end < from + length && header[end] !== 0) end++;
  return utf8.decode(header.subarray(from, end));
}
/** Octal number field (leading blanks, trailing NUL or blanks), or the GNU base-256 form when the first byte has its high bit set. */
function numeric(header: Uint8Array, from: number, length: number, label: string): number {
  if (header[from] & 0x80) {
    if (header[from] !== 0x80) fail(`negative or oversized base-256 ${label}.`);
    let value = 0;
    for (let index = from + 1; index < from + length; index++) {
      value = value * 256 + header[index];
      if (value > Number.MAX_SAFE_INTEGER) fail(`${label} exceeds the supported range.`);
    }
    return value;
  }
  let index = from, end = from + length, value = 0, digits = 0;
  while (index < end && header[index] === 32) index++;
  for (; index < end; index++) {
    const byte = header[index];
    if (byte === 0 || byte === 32) break;
    if (byte < 48 || byte > 55) fail(`invalid octal ${label}.`);
    value = value * 8 + byte - 48; digits++;
  }
  for (; index < end; index++) if (header[index] !== 0 && header[index] !== 32) fail(`invalid octal ${label}.`);
  if (!digits) return label === 'size' ? fail('missing entry size.') : Number.NaN;
  return value;
}
function checksumValid(header: Uint8Array): boolean {
  const stored = numeric(header, 148, 8, 'checksum');
  let unsigned = 0, signed = 0;
  for (let index = 0; index < BLOCK; index++) {
    const byte = index >= 148 && index < 156 ? 32 : header[index];
    unsigned += byte; signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed; // some historic writers summed signed bytes
}
/** pax extended header records: "<length> <key>=<value>\n", where <length> counts the whole record. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    if (data[at] === 0) break; // NUL padding after the last record
    let length = 0, cursor = at;
    while (cursor < data.length && data[cursor] >= 48 && data[cursor] <= 57 && cursor - at < 10) length = length * 10 + data[cursor++] - 48;
    if (cursor === at || data[cursor] !== 32 || length <= cursor - at + 1 || at + length > data.length || data[at + length - 1] !== 10) fail('malformed pax extended header.');
    const record = utf8.decode(data.subarray(cursor + 1, at + length - 1)), equals = record.indexOf('=');
    if (equals <= 0) fail('malformed pax extended header.');
    records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}

/**
 * Feed decompressed tar bytes with push() in chunks of any size, then call finish(). `select` sees every header (paths exactly as
 * stored, already joined with the ustar prefix or replaced by a pax/GNU long name) and returns true to keep a regular file; kept files
 * arrive through `deliver` once complete. Unkept data is skipped without being copied.
 */
export class TarReader {
  private readonly limits: TarLimits;
  private readonly header = new Uint8Array(BLOCK);
  private headerFill = 0;
  /** Bytes still to consume for the current entry body (data, then the padding to the next block). */
  private dataLeft = 0;
  private padLeft = 0;
  private body: Uint8Array | null = null;
  private bodyFill = 0;
  private bodyPath = '';
  private bodyKind: 'keep' | 'skip' | 'pax' | 'global' | 'longname' = 'skip';
  private pendingPax: Map<string, string> | null = null;
  private pendingLongName: string | null = null;
  private kept = 0;
  private ended = false;
  readonly summary: TarSummary = { headers: 0, files: 0, links: 0, other: 0, endMissing: false };
  /** The end-of-archive block was read: further bytes are ignored, so a caller may stop producing them. */
  get done(): boolean { return this.ended; }

  constructor(private readonly select: (entry: TarEntryInfo) => boolean, private readonly deliver: (path: string, data: Uint8Array) => void, limits: Partial<TarLimits> = {}) {
    this.limits = { ...DEFAULT_TAR_LIMITS, ...limits };
  }

  push(chunk: Uint8Array): void {
    let at = 0;
    while (at < chunk.length) {
      if (this.ended) return; // bytes after the end-of-archive block (record padding, appended junk) are never read
      if (this.dataLeft > 0) {
        const take = Math.min(this.dataLeft, chunk.length - at);
        if (this.body) this.body.set(chunk.subarray(at, at + take), this.bodyFill);
        this.bodyFill += take; this.dataLeft -= take; at += take;
        if (this.dataLeft === 0) this.completeBody();
        continue;
      }
      if (this.padLeft > 0) {
        const take = Math.min(this.padLeft, chunk.length - at);
        this.padLeft -= take; at += take;
        continue;
      }
      const take = Math.min(BLOCK - this.headerFill, chunk.length - at);
      this.header.set(chunk.subarray(at, at + take), this.headerFill);
      this.headerFill += take; at += take;
      if (this.headerFill === BLOCK) { this.headerFill = 0; this.readHeader(); }
    }
  }

  /** Throws when the stream stopped inside a header, an entry or its padding, or between an extended header and its entry. */
  finish(): TarSummary {
    if (this.ended) return this.summary;
    if (this.dataLeft > 0 || this.headerFill > 0 || this.padLeft > 0) fail('the archive is truncated inside an entry.');
    if (this.pendingPax || this.pendingLongName !== null) fail('the archive ends after an extended header without its entry.');
    if (!this.summary.headers) fail('the archive is empty.');
    this.summary.endMissing = true;
    return this.summary;
  }

  private readHeader(): void {
    const header = this.header;
    let zero = true;
    for (let index = 0; index < BLOCK; index++) if (header[index]) { zero = false; break; }
    if (zero) {
      if (this.pendingPax || this.pendingLongName !== null) fail('an extended header is followed by the end of the archive.');
      this.ended = true; return;
    }
    if (++this.summary.headers > this.limits.maxEntries) fail(`more than ${this.limits.maxEntries} entries.`, 'LIMIT_EXCEEDED');
    if (!checksumValid(header)) fail(`header ${this.summary.headers} has an invalid checksum.`);
    const flag = String.fromCharCode(header[156] || 48);
    const ustar = header[257] === 0x75 && header[258] === 0x73 && header[259] === 0x74 && header[260] === 0x61 && header[261] === 0x72;
    // POSIX ustar ("ustar\0", version "00") has a 155-byte path prefix; the old GNU layout ("ustar  \0") uses those bytes for other data.
    const posix = ustar && header[262] === 0 && header[263] === 0x30 && header[264] === 0x30;
    let path = field(header, 0, 100);
    if (posix) { const prefix = field(header, 345, 155); if (prefix) path = `${prefix}/${path}`; }
    let size = numeric(header, 124, 12, 'size');
    const pax = this.pendingPax, longName = this.pendingLongName;
    if (flag !== 'x' && flag !== 'g' && flag !== 'L' && flag !== 'K') {
      this.pendingPax = null; this.pendingLongName = null;
      if (longName !== null) path = longName;
      const paxPath = pax?.get('path'), paxSize = pax?.get('size');
      if (paxPath !== undefined) path = paxPath;
      if (paxSize !== undefined) {
        if (!/^\d{1,16}$/.test(paxSize) || Number(paxSize) > Number.MAX_SAFE_INTEGER) fail('invalid pax size.');
        size = Number(paxSize);
      }
    }
    if (size > Number.MAX_SAFE_INTEGER) fail('entry size exceeds the supported range.');
    const meta = (kind: 'pax' | 'global' | 'longname') => {
      if (size > this.limits.maxMetaBytes) fail(`an extended header of ${size} bytes exceeds the ${this.limits.maxMetaBytes}-byte limit.`, 'LIMIT_EXCEEDED');
      this.begin(size, new Uint8Array(size), kind, path);
    };
    switch (flag) {
      case 'x': if (this.pendingPax) fail('two pax headers in a row.'); return meta('pax');
      case 'g': return meta('global');
      case 'L': if (this.pendingLongName !== null) fail('two GNU long-name headers in a row.'); return meta('longname');
      case 'K': return this.begin(size, null, 'skip', path); // GNU long link name: links are never followed
      case '0': case '7': {
        const info: TarEntryInfo = { path, size, type: 'file' };
        this.summary.files++;
        if (!this.select(info)) return this.begin(size, null, 'skip', path);
        if (size > this.limits.maxEntryBytes) fail(`entry ${path.slice(0, 120)} is ${size} bytes, over the ${this.limits.maxEntryBytes}-byte limit.`, 'LIMIT_EXCEEDED');
        if ((this.kept += size) > this.limits.maxKeptBytes) fail(`the selected entries exceed ${this.limits.maxKeptBytes} bytes.`, 'LIMIT_EXCEEDED');
        return this.begin(size, new Uint8Array(size), 'keep', path);
      }
      case '5': this.select({ path, size: 0, type: 'directory' }); return this.begin(size, null, 'skip', path);
      case '1': case '2': this.summary.links++; this.select({ path, size: 0, type: 'link' }); return this.begin(size, null, 'skip', path);
      default: this.summary.other++; this.select({ path, size: 0, type: 'other' }); return this.begin(size, null, 'skip', path);
    }
  }

  private begin(size: number, body: Uint8Array | null, kind: TarReader['bodyKind'], path: string): void {
    this.body = body; this.bodyFill = 0; this.bodyKind = kind; this.bodyPath = path;
    this.dataLeft = size; this.padLeft = (BLOCK - size % BLOCK) % BLOCK;
    if (size === 0) this.completeBody();
  }

  private completeBody(): void {
    const body = this.body ?? new Uint8Array(0);
    this.body = null;
    switch (this.bodyKind) {
      case 'keep': this.deliver(this.bodyPath, body); break;
      case 'pax': this.pendingPax = paxRecords(body); break;
      case 'global': paxRecords(body); break; // validated; global defaults (rare) are not applied to paths
      case 'longname': {
        let end = body.length;
        while (end > 0 && body[end - 1] === 0) end--;
        this.pendingLongName = utf8.decode(body.subarray(0, end));
        break;
      }
      default:
    }
  }
}
