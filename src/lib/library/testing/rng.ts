/*
 * Seeded random numbers for the synthetic library (tests and generator only; the application never imports this folder).
 *
 * Everything in src/lib/library/testing/ is also loaded by plain Node (scripts/gen-synthetic-library.cjs uses Node's type
 * stripping), so these files follow three rules: relative imports spell the `.ts` extension, type-only imports use
 * `import type`, and only erasable TypeScript is used (no enums, namespaces or parameter properties).
 *
 * The generator is xoshiro128** over 32-bit integer arithmetic only, so the same seed gives the same numbers on every
 * platform. `fork(label)` derives an independent stream from the PATH of the parent and the label, never from how many
 * numbers the parent has drawn, so adding a feature that draws more numbers in one place does not reshuffle the rest.
 */

export interface Rng {
  /** Seed path, e.g. "7/family/12/board". */
  readonly path: string;
  /** Uniform 32-bit unsigned integer. */
  u32(): number;
  /** Uniform number in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both included. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** One item chosen with the given weights (weights need not add up to 1). */
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T;
  /** A shuffled copy. */
  shuffle<T>(items: readonly T[]): T[];
  /** `count` distinct items in random order (all of them when there are fewer). */
  sample<T>(items: readonly T[], count: number): T[];
  digits(count: number): string;
  /** Upper-case letters; I and O are left out because they read like 1 and 0 on a board. */
  letters(count: number): string;
  /** Digits and letters of `letters`. */
  alnum(count: number): string;
  /** Pseudo-random bytes. */
  bytes(count: number): Uint8Array;
  /** Fills a buffer with pseudo-random bytes and returns it. */
  fill(target: Uint8Array): Uint8Array;
  fork(label: string | number): Rng;
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ALNUM = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function hashPath(text: string, salt: number): number {
  let h = (0x811c9dc5 ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function createRng(seed: number | string): Rng {
  return fromPath(String(seed));
}

function fromPath(path: string): Rng {
  let s0 = hashPath(path, 1), s1 = hashPath(path, 2), s2 = hashPath(path, 3), s3 = hashPath(path, 4);
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
  const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;
  const u32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0; s3 = (s3 ^ s1) >>> 0; s1 = (s1 ^ s2) >>> 0; s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0; s3 = rotl(s3, 11);
    return result;
  };
  for (let i = 0; i < 8; i++) u32();
  const next = (): number => u32() / 4294967296;
  const int = (min: number, max: number): number => {
    if (max < min) throw new RangeError(`int(${min}, ${max}): empty range`);
    return min + Math.floor(next() * (max - min + 1));
  };
  const text = (count: number, alphabet: string): string => {
    let out = '';
    for (let i = 0; i < count; i++) out += alphabet[int(0, alphabet.length - 1)];
    return out;
  };
  const rng: Rng = {
    path, u32, next, int,
    chance: p => next() < p,
    pick: items => {
      if (!items.length) throw new RangeError('pick from an empty list');
      return items[int(0, items.length - 1)];
    },
    weighted: items => {
      let total = 0;
      for (const [, weight] of items) total += weight;
      let at = next() * total;
      for (const [item, weight] of items) { at -= weight; if (at < 0) return item; }
      return items[items.length - 1][0];
    },
    shuffle: items => {
      const copy = items.slice();
      for (let i = copy.length - 1; i > 0; i--) { const j = int(0, i); const keep = copy[i]; copy[i] = copy[j]; copy[j] = keep; }
      return copy;
    },
    sample: (items, count) => rng.shuffle(items).slice(0, Math.max(0, count)),
    digits: count => text(count, '0123456789'),
    letters: count => text(count, LETTERS),
    alnum: count => text(count, ALNUM),
    fill: target => {
      const whole = target.length >>> 2;
      const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
      for (let i = 0; i < whole; i++) view.setUint32(i * 4, u32(), true);
      for (let i = whole * 4; i < target.length; i++) target[i] = u32() & 255;
      return target;
    },
    bytes: count => rng.fill(new Uint8Array(count)),
    fork: label => fromPath(`${path}/${label}`),
  };
  return rng;
}
