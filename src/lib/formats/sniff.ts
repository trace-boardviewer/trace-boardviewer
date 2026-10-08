/*
 * Shared helpers for adapter sniffs (original TRACE module, MIT). Everything here works on the sniff head only
 * (at most SNIFF_BYTES) and runs in linear time; decoded views are cached per head, because the dispatcher hands the
 * same head to every adapter.
 */
import type { SniffInput } from './adapter';

/** Lowercase file name without its directories. */
export const baseName = (name: string): string => (name.split(/[\\/]/).pop() ?? '').toLowerCase();
/** Lowercase extension with its dot ('' when there is none). */
export const extensionOf = (name: string): string => /(\.[^.\\/]+)$/.exec(baseName(name))?.[1] ?? '';
/** The head is the whole file: nothing lies beyond the sniff window. */
export const isComplete = (input: SniffInput): boolean => input.head.length >= input.size;
/** The head may be only the start of a longer text file: it ends before the file and holds no NUL byte in its first KiB (a binary head is not waiting for text markers). */
export const mayContinueAsText = (input: SniffInput): boolean => !isComplete(input) && !input.head.subarray(0, 1024).includes(0);
/** A UTF-16 byte-order mark. The dispatcher converts valid UTF-16 to UTF-8 first, so a mark that is still there means undecodable text. */
export const hasUtf16Mark = (head: Uint8Array): boolean => head[0] === 0xff && head[1] === 0xfe || head[0] === 0xfe && head[1] === 0xff;
export const startsWith = (head: Uint8Array, bytes: ArrayLike<number>, at = 0): boolean => {
  if (head.length < at + bytes.length) return false;
  for (let index = 0; index < bytes.length; index++) if (head[at + index] !== bytes[index]) return false;
  return true;
};
export const hasNul = (head: Uint8Array, limit = head.length): boolean => head.subarray(0, limit).includes(0);

const latin1Views = new WeakMap<Uint8Array, string>();
/** One character per byte (Latin-1), for byte-level markers. */
export function latin1(head: Uint8Array): string {
  let text = latin1Views.get(head);
  if (text === undefined) {
    text = '';
    for (let index = 0; index < head.length; index += 8192) text += String.fromCharCode(...head.subarray(index, index + 8192));
    latin1Views.set(head, text);
  }
  return text;
}

interface Decoded { utf8?: string; windows1252: string; ascii: boolean }
const decodedViews = new WeakMap<Uint8Array, Decoded>();
/** Drops an incomplete UTF-8 sequence cut off at the end of a truncated head. */
function wholeSequences(head: Uint8Array): Uint8Array {
  let end = head.length, back = 0;
  while (back < 3 && end - back - 1 >= 0 && (head[end - back - 1] & 0xc0) === 0x80) back++;
  const lead = head[end - back - 1];
  if (lead === undefined || lead < 0xc0) return head;
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
  return back + 1 < needed ? head.subarray(0, end - back - 1) : head;
}
function decoded(input: SniffInput): Decoded {
  let views = decodedViews.get(input.head);
  if (!views) {
    const head = input.head, complete = isComplete(input);
    let ascii = true;
    for (let index = 0; index < head.length; index++) if (head[index] > 0x7f) { ascii = false; break; }
    const windows1252 = new TextDecoder('windows-1252').decode(head);
    let utf8: string | undefined;
    if (ascii) utf8 = windows1252;
    else {
      try { utf8 = new TextDecoder('utf-8', { fatal: true }).decode(complete ? head : wholeSequences(head)).replace(/^﻿/, ''); } catch { utf8 = undefined; }
    }
    views = { utf8, windows1252, ascii };
    decodedViews.set(head, views);
  }
  return views;
}
/**
 * The head as decodeText may read the whole file. A full read decodes UTF-8 when the WHOLE file is valid UTF-8, otherwise
 * windows-1252, so a truncated head with non-ASCII bytes has two possible readings; an ASCII head has one.
 */
export function textReadings(input: SniffInput): string[] {
  const views = decoded(input);
  if (views.ascii) return [views.windows1252];
  if (views.utf8 === undefined) return [views.windows1252];
  return isComplete(input) ? [views.utf8] : [views.utf8, views.windows1252];
}
/** The most likely reading (UTF-8 when the head is valid UTF-8). */
export const headText = (input: SniffInput): string => textReadings(input)[0];
/** Whether a rule holds in every possible reading of the head ('all'), in some ('some') or in none. */
export function ruleHolds(input: SniffInput, rule: (text: string) => boolean): 'all' | 'some' | 'none' {
  const results = textReadings(input).map(rule);
  return results.every(Boolean) ? 'all' : results.some(Boolean) ? 'some' : 'none';
}
/**
 * The complete lines of a reading: for a truncated head the last line may continue beyond the window, so it is cut off
 * before a line-anchored rule is applied (a marker line must be seen whole to count).
 */
export function completeLines(text: string, complete: boolean): string {
  if (complete) return text;
  for (let index = text.length - 1; index >= 0; index--) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) return text.slice(0, index + 1);
  }
  return '';
}
/** Byte search for an ASCII needle in the head. */
export function indexOfBytes(head: Uint8Array, needle: string, from = 0): number {
  const first = needle.charCodeAt(0), lastStart = head.length - needle.length;
  for (let at = head.indexOf(first, from); at >= 0 && at <= lastStart; at = head.indexOf(first, at + 1)) {
    let k = 1;
    while (k < needle.length && head[at + k] === needle.charCodeAt(k)) k++;
    if (k === needle.length) return at;
  }
  return -1;
}
