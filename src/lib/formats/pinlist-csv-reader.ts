/*
 * Streaming delimited-text reader for the pin-list importer (pinlist-csv.ts). Original TRACE module (MIT).
 *
 * Text is decoded and tokenized in chunks, so a 60 MiB list never exists as one string and never as one array of lines:
 *   - detectEncoding / decodeChunks: byte-order marks, UTF-8 (validated without keeping the text), otherwise windows-1252;
 *   - CsvTokenizer: RFC 4180 records ("" inside a quoted field is a quote, quoted fields may hold the delimiter and line
 *     breaks), tolerant where real exports are not strict (a quote inside an unquoted field is plain text, text after a
 *     closing quote is kept and flagged, LF, CRLF and a lone CR all end a record, a missing last line break is fine).
 * Everything is linear: the scan for the next delimiter is a sticky regular expression over a character class, a quoted field
 * is found with indexOf, and the only carry-over between chunks is one unfinished record, capped at CSV_MAX_RECORD_CHARS
 * (a record cut by a chunk is re-read from its start when more text arrives, so the repeated scan is bounded by that cap).
 */
import { BoardFormatError } from './common';

export type CsvDelimiter = ',' | ';' | '\t' | '|';
export const CSV_DELIMITERS: readonly CsvDelimiter[] = ['\t', ';', ',', '|'];
export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/** The record had text after a closing quote (kept as part of the field). */
export const CSV_FLAG_STRAY_QUOTE = 1;
/** A quote was opened and the file ended before it was closed (the rest of the file is that field). */
export const CSV_FLAG_UNTERMINATED_QUOTE = 2;
/** A field was longer than the limit and was cut. */
export const CSV_FLAG_FIELD_CUT = 4;
/** The record had more fields than the limit; the extra fields were dropped. */
export const CSV_FLAG_TOO_MANY_FIELDS = 8;

export interface CsvRecord {
  fields: string[];
  /** 1-based physical line the record starts on. */
  line: number;
  flags: number;
}
export interface CsvLimits {
  /** Characters kept per field (a longer field is cut). */
  maxFieldChars: number;
  /** Characters of one unfinished record that are carried between chunks; a longer record is refused. */
  maxRecordChars: number;
  /** Fields kept per record. */
  maxFields: number;
}
export const CSV_MAX_RECORD_CHARS = 1 << 20;
export const DEFAULT_CSV_LIMITS: CsvLimits = { maxFieldChars: 4096, maxRecordChars: CSV_MAX_RECORD_CHARS, maxFields: 512 };
/** Characters decoded and tokenized per step. */
export const CSV_CHUNK_CHARS = 1 << 18;

export interface EncodingGuess {
  encoding: CsvEncoding;
  /** Bytes of the byte-order mark to skip. */
  bomLength: number;
}
/** Valid UTF-8 up to `until` (a character cut by that limit is not an error; the rest of the data is then not looked at). */
function utf8Valid(data: Uint8Array, from: number, until: number): boolean {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const step = 1 << 20, limit = Math.min(data.length, until);
  try {
    for (let at = from; at < limit; at += step) decoder.decode(data.subarray(at, Math.min(limit, at + step)), { stream: at + step < limit || limit < data.length });
    return true;
  } catch { return false; }
}
/**
 * null for binary data. A byte-order mark decides; UTF-16 without one is recognized by NUL bytes on every other position;
 * otherwise valid UTF-8 (the whole input is checked, streaming, unless `validateBytes` limits the check to a prefix: a quick
 * look for a sniffer) or else windows-1252.
 */
export function detectEncoding(data: Uint8Array, validateBytes = Number.POSITIVE_INFINITY): EncodingGuess | null {
  if (data[0] === 0xff && data[1] === 0xfe) return { encoding: 'utf-16le', bomLength: 2 };
  if (data[0] === 0xfe && data[1] === 0xff) return { encoding: 'utf-16be', bomLength: 2 };
  const head = Math.min(data.length, 4096);
  let even = 0, odd = 0, other = 0;
  for (let index = 0; index < head; index++) {
    if (data[index] !== 0) continue;
    if (index % 2) odd++; else even++;
    if (index > 0 && data[index] === 0 && data[index - 1] === 0) other++;
  }
  if (even + odd) {
    if (other === 0 && odd >= head / 8 && even === 0) return { encoding: 'utf-16le', bomLength: 0 };
    if (other === 0 && even >= head / 8 && odd === 0) return { encoding: 'utf-16be', bomLength: 0 };
    return null;
  }
  const bom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  return { encoding: utf8Valid(data, bom, validateBytes) ? 'utf-8' : 'windows-1252', bomLength: bom };
}
/** The text of `data` in pieces of at most about `chunkChars` characters, never splitting a character. */
export function* decodeChunks(data: Uint8Array, guess: EncodingGuess, chunkChars = CSV_CHUNK_CHARS): Generator<string> {
  const decoder = new TextDecoder(guess.encoding);
  // UTF-16 units are two bytes; UTF-8 characters up to three per BMP char: a byte budget of chunkChars keeps pieces near the target.
  const bytes = guess.encoding === 'utf-16le' || guess.encoding === 'utf-16be' ? chunkChars * 2 : chunkChars;
  for (let at = guess.bomLength; at < data.length; at += bytes) {
    const end = Math.min(data.length, at + bytes), text = decoder.decode(data.subarray(at, end), { stream: end < data.length });
    if (text) yield text;
  }
}

const breaks = (text: string): number => {
  let count = 0;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) count++;
  if (!count && text.includes('\r')) for (let at = text.indexOf('\r'); at >= 0; at = text.indexOf('\r', at + 1)) count++;
  return count;
};

const stops = new Map<string, RegExp>();
function stopPattern(delimiter: string): RegExp {
  let pattern = stops.get(delimiter);
  if (!pattern) { pattern = new RegExp(`[${delimiter === '\t' ? '\\t' : delimiter === '|' ? '\\|' : delimiter}\\r\\n]`, 'g'); stops.set(delimiter, pattern); }
  return pattern;
}

/**
 * Pushes decoded text in; every complete record goes to `onRecord`, which may return false to stop. A record that is not
 * finished at the end of the pushed text is kept (as text) and read again when more text arrives; `push(text, true)` finishes
 * the last record. Blank lines produce no record. Throws BoardFormatError('LIMIT_EXCEEDED') when an unfinished record
 * grows past the limit (typically a quote that is never closed).
 */
export class CsvTokenizer {
  private pending = '';
  private line = 1;
  private stopped = false;
  private readonly stop: RegExp;
  constructor(readonly delimiter: CsvDelimiter, private readonly onRecord: (record: CsvRecord) => boolean | void, readonly limits: CsvLimits = DEFAULT_CSV_LIMITS) {
    this.stop = new RegExp(stopPattern(delimiter).source, 'g');
  }
  /** True after `onRecord` asked to stop; further text is ignored. */
  get done(): boolean { return this.stopped; }
  /** The 1-based line the next record starts on. */
  get nextLine(): number { return this.line; }

  push(text: string, final = false): void {
    if (this.stopped) return;
    const buffer = this.pending ? this.pending + text : text;
    const length = buffer.length, { maxFieldChars, maxFields } = this.limits, stop = this.stop;
    let position = 0;
    while (position < length) {
      // A blank line is skipped without allocating a record: a file of nothing but line breaks stays cheap.
      const lead = buffer.charCodeAt(position);
      if (lead === 10) { position++; this.line++; continue; }
      if (lead === 13) {
        if (position + 1 >= length && !final) { this.pending = buffer.slice(position); return; }
        position += buffer.charCodeAt(position + 1) === 10 ? 2 : 1; this.line++; continue;
      }
      const start = position, fields: string[] = [];
      let flags = 0, embedded = 0, incomplete = false, ended = false;
      while (!ended) {
        let value: string;
        if (buffer.charCodeAt(position) === 34) {
          let from = position + 1, parts = '';
          for (;;) {
            const quote = buffer.indexOf('"', from);
            if (quote < 0) {
              if (!final) { incomplete = true; break; }
              parts += buffer.slice(from); position = length; flags |= CSV_FLAG_UNTERMINATED_QUOTE; break;
            }
            if (quote + 1 >= length && !final) { incomplete = true; break; }
            if (buffer.charCodeAt(quote + 1) === 34) { parts += buffer.slice(from, quote + 1); from = quote + 2; continue; }
            parts += buffer.slice(from, quote); position = quote + 1; break;
          }
          if (incomplete) break;
          embedded += breaks(parts);
          value = parts;
          if (position < length) {
            const next = buffer.charCodeAt(position);
            if (next !== 10 && next !== 13 && next !== this.delimiter.charCodeAt(0)) {
              // text after the closing quote: keep it, flag it
              stop.lastIndex = position;
              const hit = stop.exec(buffer);
              if (!hit && !final) { incomplete = true; break; }
              const end = hit ? hit.index : length;
              value += buffer.slice(position, end); position = end; flags |= CSV_FLAG_STRAY_QUOTE;
            }
          }
        } else {
          stop.lastIndex = position;
          const hit = stop.exec(buffer);
          if (!hit && !final) { incomplete = true; break; }
          const end = hit ? hit.index : length;
          value = buffer.slice(position, end); position = end;
        }
        if (value.length > maxFieldChars) { value = value.slice(0, maxFieldChars); flags |= CSV_FLAG_FIELD_CUT; }
        if (fields.length < maxFields) fields.push(value); else flags |= CSV_FLAG_TOO_MANY_FIELDS;
        if (position >= length) { ended = true; break; }
        const code = buffer.charCodeAt(position);
        if (code === 10) { position++; ended = true; }
        else if (code === 13) {
          if (position + 1 >= length && !final) { incomplete = true; break; }
          position += buffer.charCodeAt(position + 1) === 10 ? 2 : 1; ended = true;
        } else position++; // the delimiter: another field follows (an empty one when the text ends here)
        if (!ended && position >= length) {
          if (!final) { incomplete = true; break; }
          if (fields.length < maxFields) fields.push(''); else flags |= CSV_FLAG_TOO_MANY_FIELDS; // the empty field after a delimiter at the end of the text counts like any other
          ended = true;
        }
      }
      if (incomplete) {
        this.pending = buffer.slice(start);
        if (this.pending.length > this.limits.maxRecordChars) {
          throw new BoardFormatError(`A record is longer than ${this.limits.maxRecordChars} characters (line ${this.line}): a quoted field is probably never closed.`, 'LIMIT_EXCEEDED');
        }
        return;
      }
      const startLine = this.line;
      this.line += 1 + embedded;
      if (fields.length === 1 && !fields[0] && !flags) continue; // a blank line
      if (this.onRecord({ fields, line: startLine, flags }) === false) { this.stopped = true; this.pending = ''; return; }
    }
    this.pending = '';
  }
}

/** Feeds the whole input through a tokenizer, chunk by chunk, and finishes it. Returns false when `onRecord` stopped early. */
export function tokenizeAll(data: Uint8Array, guess: EncodingGuess, delimiter: CsvDelimiter, onRecord: (record: CsvRecord) => boolean | void, limits: CsvLimits = DEFAULT_CSV_LIMITS): boolean {
  const tokenizer = new CsvTokenizer(delimiter, onRecord, limits);
  for (const chunk of decodeChunks(data, guess)) {
    tokenizer.push(chunk);
    if (tokenizer.done) return false;
  }
  tokenizer.push('', true);
  return !tokenizer.done;
}
