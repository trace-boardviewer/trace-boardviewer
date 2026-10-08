/**
 * Deterministic random numbers for the parser fuzzer. Every input is derived from (seed, target, iteration) alone, so a finding is
 * replayed by those three values, runs can be split over workers in any way and the CI run is the same on every machine.
 */

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, n). */
  int(n: number): number;
  /** An integer in [low, high], both included. */
  range(low: number, high: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Index drawn with the given weights. */
  weighted(weights: readonly number[]): number;
  bytes(length: number): Uint8Array;
}

/** FNV-1a over the text of the parts, with a salt so that several independent words can be taken from one list. */
export function hashParts(parts: ReadonlyArray<string | number>, salt: number): number {
  let hash = (0x811c9dc5 ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  for (const part of parts) {
    const text = `${part}\u0000`;
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  hash ^= hash >>> 15; hash = Math.imul(hash, 0x2c1b3c6d) >>> 0; hash ^= hash >>> 12; hash = Math.imul(hash, 0x297a2d39) >>> 0; hash ^= hash >>> 15;
  return hash >>> 0;
}

/** Small fast generator with a 128-bit state (sfc32), seeded from four hashes of the parts. */
export function createRng(...parts: ReadonlyArray<string | number>): Rng {
  let a = hashParts(parts, 0), b = hashParts(parts, 1), c = hashParts(parts, 2), d = hashParts(parts, 3);
  const raw = (): number => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0; a = b ^ (b >>> 9); b = (c + (c << 3)) >>> 0; c = ((c << 21) | (c >>> 11)) >>> 0; c = (c + t) >>> 0;
    return t >>> 0;
  };
  for (let warm = 0; warm < 12; warm++) raw();
  const next = () => raw() / 4294967296;
  const int = (n: number) => (n <= 1 ? 0 : Math.floor(next() * n));
  return {
    next, int,
    range: (low, high) => low + int(high - low + 1),
    chance: probability => next() < probability,
    pick: items => items[int(items.length)],
    weighted: weights => {
      let total = 0;
      for (const weight of weights) total += weight;
      let at = next() * total;
      for (let index = 0; index < weights.length; index++) { at -= weights[index]; if (at < 0) return index; }
      return weights.length - 1;
    },
    bytes: length => { const result = new Uint8Array(length); for (let index = 0; index < length; index++) result[index] = raw() & 0xff; return result; },
  };
}
