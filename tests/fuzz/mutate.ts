/**
 * Mutations of a seed file: byte level, text level (lines, numbers, tokens) and structure-hostile ones (floods, deep nesting, boundary
 * numbers, truncation, byte-order marks). Every mutator is a pure function of the data and the random stream, so a mutated input is
 * reproduced from its seed.
 */
import type { Rng } from './prng';

export interface MutationContext {
  rng: Rng;
  /** Words of the format (keywords and record names harvested from its seeds). */
  dictionary: readonly Uint8Array[];
  /** Other inputs to take pieces from. */
  donors: readonly Uint8Array[];
  /** The result is cut to this many bytes. */
  maxBytes: number;
}

const enc = new TextEncoder();
const text = (value: string) => enc.encode(value);
const latin1 = (data: Uint8Array): string => Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1');
const fromLatin1 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'latin1'));

/** Numbers that sit on the edge of what a reader may assume. */
export const BOUNDARY_NUMBERS = [
  '0', '-0', '1', '-1', '2', '3', '7', '8', '15', '16', '31', '32', '63', '64', '127', '128', '255', '256', '1023', '1024', '4095', '65535', '65536', '-32768', '2147483647', '2147483648', '-2147483648', '4294967295', '4294967296',
  '9007199254740991', '9007199254740993', '99999999999999999999', '1e9', '1e10', '1e300', '1e308', '1e309', '-1e308', '1e-300', '1e-320', '5e-324', 'NaN', 'Infinity', '-Infinity', '0.0000001', '1000000000', '-1000000000', '0x10', '1,5', '1.5.5', '--1', '+1', '1e', '.', '-', '',
];
const BOUNDARY_INTS = [0, 1, 2, 3, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x10000, 0x00ffffff, 0x7fffffff, 0x80000000, 0xffffffff, 0x0fffffff, 0x1000000, 0x40000000, 0xfffffffe];
const INTERESTING_BYTES = [0, 1, 2, 0x0a, 0x0d, 0x20, 0x22, 0x27, 0x28, 0x29, 0x2d, 0x2e, 0x2f, 0x3c, 0x3e, 0x40, 0x5c, 0x7f, 0x80, 0xc0, 0xff];

const clamp = (data: Uint8Array, maxBytes: number): Uint8Array => (data.length > maxBytes ? data.subarray(0, maxBytes) : data);
function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const result = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}
function repeat(piece: Uint8Array, times: number, limit: number): Uint8Array {
  if (piece.length === 0) return piece;
  const count = Math.max(1, Math.min(times, Math.floor(limit / piece.length)));
  const result = new Uint8Array(piece.length * count);
  for (let index = 0; index < count; index++) result.set(piece, index * piece.length);
  return result;
}
const position = (data: Uint8Array, rng: Rng) => rng.int(data.length + 1);

type Mutator = (data: Uint8Array, context: MutationContext) => Uint8Array;

/** Mutators that keep the length of the data: a binary format keeps its offsets and sizes and reaches deeper than after an insertion. */
const PRESERVING = new Set(['flip-bit', 'set-byte', 'binary-int', 'case-flip', 'fill']);
const mutators: ReadonlyArray<readonly [name: string, weight: number, apply: Mutator]> = [
  ['flip-bit', 6, (data, { rng }) => { if (!data.length) return data; const result = data.slice(); result[rng.int(data.length)] ^= 1 << rng.int(8); return result; }],
  ['set-byte', 6, (data, { rng }) => { if (!data.length) return data; const result = data.slice(); result[rng.int(data.length)] = rng.chance(0.6) ? rng.pick(INTERESTING_BYTES) : rng.int(256); return result; }],
  ['insert-bytes', 4, (data, { rng }) => { const at = position(data, rng); return concat(data.subarray(0, at), rng.chance(0.5) ? rng.bytes(rng.range(1, 8)) : Uint8Array.of(rng.pick(INTERESTING_BYTES)), data.subarray(at)); }],
  ['delete-range', 6, (data, { rng }) => {
    if (!data.length) return data;
    const length = rng.chance(0.7) ? rng.range(1, Math.min(data.length, 32)) : rng.range(1, Math.max(1, Math.floor(data.length / 4)));
    const at = rng.int(data.length - length + 1);
    return concat(data.subarray(0, at), data.subarray(at + length));
  }],
  ['duplicate-range', 4, (data, { rng, maxBytes }) => {
    if (!data.length) return data;
    const length = rng.range(1, Math.min(data.length, 256)), from = rng.int(data.length - length + 1), at = position(data, rng);
    return clamp(concat(data.subarray(0, at), data.subarray(from, from + length), data.subarray(at)), maxBytes);
  }],
  ['repeat-range', 3, (data, { rng, maxBytes }) => {
    if (!data.length) return data;
    const length = rng.range(1, Math.min(data.length, 128)), from = rng.int(data.length - length + 1), at = position(data, rng);
    const times = rng.chance(0.5) ? rng.range(2, 64) : rng.range(64, 4096);
    return clamp(concat(data.subarray(0, at), repeat(data.subarray(from, from + length), times, Math.max(0, maxBytes - data.length)), data.subarray(at)), maxBytes);
  }],
  ['swap-ranges', 2, (data, { rng }) => {
    if (data.length < 4) return data;
    const length = rng.range(1, Math.min(32, Math.floor(data.length / 2)));
    const a = rng.int(data.length - length + 1), b = rng.int(data.length - length + 1);
    if (Math.abs(a - b) < length) return data;
    const result = data.slice();
    result.set(data.subarray(b, b + length), a); result.set(data.subarray(a, a + length), b);
    return result;
  }],
  ['insert-token', 7, (data, { rng, dictionary }) => {
    if (!dictionary.length) return data;
    const at = position(data, rng), token = rng.pick(dictionary);
    return concat(data.subarray(0, at), rng.chance(0.5) ? text(' ') : new Uint8Array(0), token, rng.chance(0.5) ? text(' ') : new Uint8Array(0), data.subarray(at));
  }],
  ['replace-word', 6, (data, { rng, dictionary }) => {
    if (!data.length || !dictionary.length) return data;
    // Overwrite the run of non-blank bytes around a random place with a word of the format.
    let from = rng.int(data.length), to = from;
    const blank = (byte: number) => byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x28 || byte === 0x29;
    while (from > 0 && !blank(data[from - 1])) from--;
    while (to < data.length && !blank(data[to])) to++;
    return concat(data.subarray(0, from), rng.pick(dictionary), data.subarray(to));
  }],
  ['numeric-field', 10, (data, { rng }) => {
    const view = latin1(data.length > 400_000 ? data.subarray(0, 400_000) : data);
    const matches: RegExpMatchArray[] = [];
    for (const match of view.matchAll(/[-+]?\d+(?:\.\d+)?/g)) { matches.push(match); if (matches.length >= 4000) break; }
    if (!matches.length) return data;
    const match = rng.pick(matches), start = match.index ?? 0;
    const replacement = rng.chance(0.75) ? rng.pick(BOUNDARY_NUMBERS) : String(Number(match[0]) * rng.pick([-1, 2, 10, 1000, 1e6, 0.001]));
    return concat(data.subarray(0, start), fromLatin1(replacement), data.subarray(start + match[0].length));
  }],
  ['count-field', 3, (data, { rng }) => {
    // The first small integer on a line of its own or after a colon: counts and lengths are what readers allocate by.
    const view = latin1(data.length > 400_000 ? data.subarray(0, 400_000) : data);
    const matches: RegExpMatchArray[] = [];
    for (const match of view.matchAll(/(?:^|[:\s])(\d{1,4})(?=\r?\n|\s|$)/gm)) { matches.push(match); if (matches.length >= 2000) break; }
    if (!matches.length) return data;
    const match = rng.pick(matches), digits = match[1], start = (match.index ?? 0) + match[0].length - digits.length;
    const value = Number(digits);
    const replacement = String(rng.pick([value + 1, Math.max(0, value - 1), value * 1000, value * 100, 0, 65536, 2147483647, 1_000_000]));
    return concat(data.subarray(0, start), fromLatin1(replacement), data.subarray(start + digits.length));
  }],
  ['binary-int', 8, (data, { rng }) => {
    if (data.length < 4) return data;
    const width = rng.pick([1, 2, 4, 4, 8]), at = rng.chance(0.6) ? (rng.int(Math.floor((data.length - width) / width) + 1)) * width : rng.int(data.length - width + 1);
    if (at + width > data.length) return data;
    const result = data.slice(), view = new DataView(result.buffer);
    const value = rng.pick(BOUNDARY_INTS), little = rng.chance(0.7);
    if (width === 1) view.setUint8(at, value & 0xff);
    else if (width === 2) view.setUint16(at, value & 0xffff, little);
    else if (width === 4) view.setUint32(at, value >>> 0, little);
    else { view.setUint32(at, value >>> 0, little); view.setUint32(at + 4, rng.chance(0.5) ? 0 : value >>> 0, little); }
    return result;
  }],
  ['truncate', 5, (data, { rng }) => (data.length ? data.subarray(0, rng.chance(0.5) ? Math.floor((data.length * rng.int(65)) / 64) : rng.int(data.length)) : data)],
  ['drop-head', 2, (data, { rng }) => (data.length ? data.subarray(rng.int(data.length)) : data)],
  ['line-delete', 4, (data, { rng }) => lineEdit(data, rng, lines => { lines.splice(rng.int(lines.length), 1); })],
  ['line-duplicate', 4, (data, { rng, maxBytes }) => clamp(lineEdit(data, rng, lines => { const at = rng.int(lines.length); lines.splice(rng.int(lines.length + 1), 0, lines[at]); }), maxBytes)],
  ['line-swap', 3, (data, { rng }) => lineEdit(data, rng, lines => { const a = rng.int(lines.length), b = rng.int(lines.length); [lines[a], lines[b]] = [lines[b], lines[a]]; })],
  ['line-flood', 3, (data, { rng, maxBytes }) => clamp(lineEdit(data, rng, lines => {
    const at = rng.int(lines.length), count = rng.chance(0.7) ? rng.range(2, 200) : rng.range(200, 20_000);
    lines.splice(at, 0, ...Array.from({ length: Math.min(count, Math.max(1, Math.floor(maxBytes / Math.max(1, lines[at].length + 1)))) }, () => lines[at]));
  }), maxBytes)],
  ['eol', 2, (data, { rng }) => {
    const view = latin1(data);
    const mode = rng.int(4);
    return fromLatin1(mode === 0 ? view.replace(/\r?\n/g, '\r\n') : mode === 1 ? view.replace(/\r\n/g, '\n') : mode === 2 ? view.replace(/\r?\n/g, ' ') : view.replace(/\r?\n/g, '\r'));
  }],
  ['byte-order-mark', 3, (data, { rng }) => {
    const mode = rng.int(5);
    if (mode === 0) return concat(Uint8Array.of(0xef, 0xbb, 0xbf), data);
    if (mode === 1) return concat(Uint8Array.of(0xff, 0xfe), data);
    if (mode === 2) return concat(Uint8Array.of(0xfe, 0xff), data);
    const decoded = new TextDecoder('windows-1252').decode(data);
    const units = Array.from(decoded, character => character.charCodeAt(0));
    const little = mode === 3, result = new Uint8Array(2 + units.length * 2);
    result[0] = little ? 0xff : 0xfe; result[1] = little ? 0xfe : 0xff;
    units.forEach((unit, index) => { result[2 + index * 2] = little ? unit & 0xff : unit >> 8; result[3 + index * 2] = little ? unit >> 8 : unit & 0xff; });
    return result;
  }],
  ['case-flip', 2, (data, { rng }) => {
    if (!data.length) return data;
    const from = rng.int(data.length), length = rng.range(1, Math.min(64, data.length - from)), result = data.slice();
    for (let index = from; index < from + length; index++) { const byte = result[index]; if ((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) result[index] = byte ^ 0x20; }
    return result;
  }],
  ['fill', 3, (data, { rng }) => {
    if (!data.length) return data;
    const from = rng.int(data.length), length = rng.range(1, Math.min(256, data.length - from)), result = data.slice();
    result.fill(rng.pick([0, 0xff, 0x20, 0x41, 0x30, 0x0a]), from, from + length);
    return result;
  }],
  ['splice-donor', 4, (data, { rng, donors, maxBytes }) => {
    if (!donors.length) return data;
    const donor = rng.pick(donors);
    const cut = position(data, rng), take = donor.length ? rng.int(donor.length) : 0;
    return clamp(rng.chance(0.5) ? concat(data.subarray(0, cut), donor.subarray(take)) : concat(donor.subarray(0, take), data.subarray(cut)), maxBytes);
  }],
  ['long-run', 4, (data, { rng, maxBytes }) => {
    const at = position(data, rng);
    const unit = rng.pick(['(', ')', '"', '9', '0', ' ', '-', '.', 'A', '<', '/', '\n', '\u0000', '%', '1,', '(a ', '<a>']);
    const length = rng.chance(0.7) ? rng.range(64, 4096) : rng.range(4096, 200_000);
    return clamp(concat(data.subarray(0, at), repeat(text(unit), Math.ceil(length / unit.length), Math.max(0, maxBytes - data.length)), data.subarray(at)), maxBytes);
  }],
  ['nesting', 2, (data, { rng, maxBytes }) => {
    const at = position(data, rng), depth = rng.pick([40, 70, 200, 1000, 20_000]);
    const open = rng.pick(['(', '(a ', '<a>', '[', '{', '(x (']);
    return clamp(concat(data.subarray(0, at), repeat(text(open), depth, Math.max(0, maxBytes - data.length)), data.subarray(at)), maxBytes);
  }],
  ['random-tail', 2, (data, { rng, maxBytes }) => clamp(concat(data, rng.bytes(rng.range(1, 64))), maxBytes)],
];
const WEIGHTS = mutators.map(entry => entry[1]);
const PRESERVING_WEIGHTS = mutators.map(entry => (PRESERVING.has(entry[0]) ? entry[1] : 0));

function lineEdit(data: Uint8Array, rng: Rng, edit: (lines: string[]) => void): Uint8Array {
  if (!data.length) return data;
  const lines = latin1(data).split('\n');
  if (!lines.length) return data;
  edit(lines);
  return fromLatin1(lines.join('\n'));
}

export const MUTATOR_NAMES: readonly string[] = mutators.map(entry => entry[0]);

/** Applies `rounds` mutations drawn by weight; with `preserving` only those that keep the length of the data. */
export function mutateBytes(data: Uint8Array, context: MutationContext, rounds: number, preserving = false): Uint8Array {
  let current = data;
  for (let round = 0; round < rounds; round++) {
    const [, , apply] = mutators[context.rng.weighted(preserving ? PRESERVING_WEIGHTS : WEIGHTS)];
    current = clamp(apply(current, context), context.maxBytes);
  }
  return current;
}

/** Words of a text input: runs of letters, digits and a few signs, short enough to be keywords, most common first. */
export function harvestDictionary(inputs: readonly Uint8Array[], limit = 160): Uint8Array[] {
  const counts = new Map<string, number>();
  for (const data of inputs) {
    if (data.length > 200_000) continue;
    for (const match of latin1(data).matchAll(/[A-Za-z_$#%<>/][A-Za-z0-9_$#%<>/.:-]{1,23}/g)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit).map(([word]) => text(word));
}
