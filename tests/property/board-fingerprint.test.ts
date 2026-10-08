import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  boardFingerprint, boardPinSet, describeBoard, diffPinSets, FINGERPRINT_PREFIX, FINGERPRINT_VERSION, matchBoard, normalizePinSet, pinSetFingerprint, pinSetSimilarity, pinSetSize, SIMILAR_THRESHOLD, UNNUMBERED_PIN_PREFIX,
} from '../../src/lib/board-fingerprint';
import type { BoardRecord, PinSet } from '../../src/lib/board-fingerprint';
import type { Board } from '../../src/lib/types';
import { makeBoard } from './builders';
import type { BoardPartSpec } from './builders';
import { params, shuffled, shuffleKeys } from './support';

// ---------------------------------------------------------------------------------------------------------------
// Boards: references and pin numbers from a small pool, so that duplicates, spelling variants and unnumbered pads are common
// ---------------------------------------------------------------------------------------------------------------

const REFS = ['R1', 'r1', ' R1 ', 'R2', 'U1', 'u1', 'C10', 'C1', 'TP1', 'Ｒ１', 'J1', '', '  '];
const NUMBERS = ['1', '2', '3', 'A1', 'a1', ' 3 ', 'B2', '10', '~1', '~2', '', '  '];
const part: fc.Arbitrary<BoardPartSpec> = fc.record({
  ref: fc.constantFrom(...REFS),
  pins: fc.array(fc.tuple(fc.constantFrom(...NUMBERS), fc.constantFrom('', 'GND', 'VCC', 'NET1', 'N$2'), fc.boolean()), { maxLength: 6 }),
  side: fc.constantFrom('top' as const, 'bottom' as const, 'both' as const),
  value: fc.constantFrom('', '10k', '100n'),
  pkg: fc.constantFrom('', '0402', 'SOIC8'),
  at: fc.record({ x: fc.integer({ min: -50, max: 50 }), y: fc.integer({ min: -50, max: 50 }) }),
});
const parts = fc.array(part, { maxLength: 8 });

/** The (ref, pin) pairs of the specs by the rule written in the module header, computed independently. */
function expectedPairs(specs: readonly BoardPartSpec[]): PinSet {
  const byRef = new Map<string, Set<string>>();
  for (const spec of specs) {
    const ref = spec.ref.trim().toUpperCase();
    if (ref === '') continue;
    for (const [number] of spec.pins) {
      const pin = number.trim().toUpperCase();
      if (pin === '' || pin.startsWith('~')) continue;
      const pins = byRef.get(ref) ?? new Set<string>();
      pins.add(pin); byRef.set(ref, pins);
    }
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...byRef.keys()].sort(compare).map(ref => [ref, [...byRef.get(ref)!].sort(compare)] as const);
}

const pairsOf = (set: PinSet): Set<string> => new Set(set.flatMap(([ref, pins]) => pins.map(pin => `${ref}\u0000${pin}`)));
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('board pin set', () => {
  it('is the trimmed, upper-cased, de-duplicated and sorted (ref, pin) set, without unnumbered pads and unnamed parts', () => {
    fc.assert(fc.property(parts, list => {
      expect(boardPinSet(makeBoard(list))).toEqual(expectedPairs(list));
    }), params(500));
  });

  it('is canonical: sorted and unique at both levels, no empty text, nothing numbered with the unnumbered prefix, and a fixed point of normalization and JSON', () => {
    fc.assert(fc.property(parts, list => {
      const set = boardPinSet(makeBoard(list));
      const refs = set.map(([ref]) => ref);
      expect(refs).toEqual([...new Set(refs)].sort());
      for (const [ref, pins] of set) {
        expect(ref).toBe(ref.trim().toUpperCase()); expect(ref).not.toBe('');
        expect(pins.length).toBeGreaterThan(0);
        expect(pins).toEqual([...new Set(pins)].sort());
        for (const pin of pins) { expect(pin).toBe(pin.trim().toUpperCase()); expect(pin).not.toBe(''); expect(pin.startsWith(UNNUMBERED_PIN_PREFIX)).toBe(false); }
      }
      expect(normalizePinSet(set)).toEqual(set);
      expect(normalizePinSet(JSON.parse(JSON.stringify(set)))).toEqual(set);
      expect(pinSetSize(set)).toBe(pairsOf(set).size);
    }), params(400));
  });

  it('does not depend on what the format does not carry: order of parts and pads, ids, nets, sides, values, packages and positions', () => {
    fc.assert(fc.property(parts, shuffleKeys, shuffleKeys, fc.integer({ min: 0, max: 1000 }), (list, keysParts, keysPins, nudge) => {
      const original = boardPinSet(makeBoard(list));
      expect(boardPinSet(makeBoard(shuffled(list, keysParts)))).toEqual(original);
      const rebuilt = makeBoard(list.map(spec => ({ ...spec, pins: shuffled(spec.pins, keysPins).map(([number]) => [number, 'OTHER', false] as const), side: 'bottom', value: 'x', pkg: 'y', at: { x: nudge, y: -nudge } })));
      expect(boardPinSet(rebuilt)).toEqual(original);
      // Same board, other session handles for every part and pad.
      const board = makeBoard(list);
      const renamed: Board = { ...board, components: board.components.map(c => ({ ...c, id: `X${c.id}` })), pins: board.pins.map(p => ({ ...p, id: `X${p.id}`, componentId: `X${p.componentId}` })) };
      expect(boardPinSet(renamed)).toEqual(original);
    }), params(300));
  });

  it('merges parts that share a reference and treats spelling variants of one reference as one', () => {
    fc.assert(fc.property(fc.constantFrom('R1', 'u2', 'C10'), fc.array(fc.constantFrom('1', '2', '3', 'a'), { minLength: 1, maxLength: 3 }), fc.array(fc.constantFrom('1', '2', '3', 'b'), { minLength: 1, maxLength: 3 }), (ref, first, second) => {
      const together = boardPinSet(makeBoard([{ ref, pins: first.map(n => [n, '']) }, { ref: ` ${ref.toLowerCase()} `, pins: second.map(n => [n, '']) }]));
      expect(together).toHaveLength(1);
      expect(new Set(together[0][1])).toEqual(new Set([...first, ...second].map(n => n.toUpperCase())));
    }), params(150));
  });
});

describe('normalizePinSet', () => {
  it('never throws; answers null or a canonical set that normalizes to itself', () => {
    fc.assert(fc.property(fc.oneof(fc.jsonValue(), fc.anything()), value => {
      const set = normalizePinSet(value);
      if (set === null) return;
      expect(normalizePinSet(set)).toEqual(set);
      for (const [ref, pins] of set) { expect(ref).toBe(ref.trim().toUpperCase()); expect(pins.length).toBeGreaterThan(0); }
    }), params(800));
  });

  it('canonicalizes any list of pairs the same way as a board does, and rejects texts over 256 characters', () => {
    const entry = fc.tuple(fc.constantFrom(...REFS), fc.array(fc.constantFrom(...NUMBERS), { maxLength: 5 }));
    fc.assert(fc.property(fc.array(entry, { maxLength: 6 }), entries => {
      const set = normalizePinSet(entries)!;
      const specs: BoardPartSpec[] = entries.map(([ref, pins]) => ({ ref, pins: pins.map(n => [n, ''] as const) }));
      expect(set).toEqual(boardPinSet(makeBoard(specs)));
      // Another order of the entries and of each entry's pins gives the same set.
      expect(normalizePinSet([...entries].reverse().map(([ref, pins]) => [ref, [...pins].reverse()]))).toEqual(set);
    }), params(400));
    fc.assert(fc.property(fc.integer({ min: 257, max: 400 }), tooLong => {
      expect(normalizePinSet([['R'.repeat(tooLong), ['1']]])).toBeNull();
      expect(normalizePinSet([['R1', ['1'.repeat(tooLong)]]])).toBeNull();
      expect(normalizePinSet([['R'.repeat(256), ['1'.repeat(256)]]])).not.toBeNull();
    }), params(20));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------------------------------------------

describe('board fingerprint', () => {
  it('is the version prefix and the SHA-256 of the versioned header and the JSON of the pin set, as written in the module header, and is never taken for a file key', async () => {
    await fc.assert(fc.asyncProperty(parts, async list => {
      const board = makeBoard(list);
      const set = boardPinSet(board);
      const fingerprint = await boardFingerprint(board);
      expect(fingerprint).toBe(`${FINGERPRINT_PREFIX}${sha256(`trace-board-fingerprint/${FINGERPRINT_VERSION}\n${JSON.stringify(set)}`)}`);
      expect(await pinSetFingerprint(set)).toBe(fingerprint);
      expect(FINGERPRINT_PREFIX).toBe(`fp${FINGERPRINT_VERSION}:`);
      expect(fingerprint).toMatch(/^fp1:[0-9a-f]{64}$/);
      // A file key is bare hex (the SHA-256 of the file bytes): the two are never equal.
      expect(fingerprint).not.toMatch(/^[0-9a-f]{64}$/);
    }), params(150));
  });

  it('two boards have the same fingerprint exactly when their pin sets are equal', async () => {
    await fc.assert(fc.asyncProperty(parts, parts, shuffleKeys, async (a, b, keys) => {
      const boardA = makeBoard(a), boardB = makeBoard(b);
      const same = JSON.stringify(boardPinSet(boardA)) === JSON.stringify(boardPinSet(boardB));
      expect((await boardFingerprint(boardA)) === (await boardFingerprint(boardB))).toBe(same);
      expect(await boardFingerprint(makeBoard(shuffled(a, keys)))).toBe(await boardFingerprint(boardA));
    }), params(200));
  });

  it('changes when one pair is added or removed, and when the version line would change', async () => {
    await fc.assert(fc.asyncProperty(parts.filter(list => boardPinSet(makeBoard(list)).length > 0), fc.nat(), async (list, pick) => {
      const board = makeBoard(list), set = boardPinSet(board);
      const [ref, pins] = set[pick % set.length];
      const without: PinSet = pins.length === 1 ? set.filter(([r]) => r !== ref) : set.map(([r, p]) => (r === ref ? [r, p.slice(1)] as const : [r, p] as const));
      expect(await pinSetFingerprint(without)).not.toBe(await pinSetFingerprint(set));
      const extra: PinSet = [...set, ['ZZ_NEW', ['1']] as const];
      expect(await pinSetFingerprint(extra)).not.toBe(await pinSetFingerprint(set));
    }), params(120));
  });

  it('describeBoard carries the file key only when there is one', async () => {
    await fc.assert(fc.asyncProperty(parts, fc.option(fc.stringMatching(/^[0-9a-f]{64}$/), { nil: undefined }), async (list, key) => {
      const board = makeBoard(list);
      const record = await describeBoard(board, key);
      expect(record.fingerprint).toBe(await boardFingerprint(board));
      expect(record.pinSet).toEqual(boardPinSet(board));
      expect('fileKey' in record).toBe(key !== undefined);
    }), params(60));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------------------------------------------

const set = parts.map(list => boardPinSet(makeBoard(list)));
/** Jaccard of the plain sets of pairs, the definition. */
function jaccard(a: PinSet, b: PinSet): number {
  const x = pairsOf(a), y = pairsOf(b);
  let shared = 0;
  for (const pair of x) if (y.has(pair)) shared++;
  const union = x.size + y.size - shared;
  return union === 0 ? 1 : shared / union;
}

describe('pin set similarity', () => {
  it('is the Jaccard similarity of the sets of pairs: symmetric, between 0 and 1, 1 for equal sets, 0 for disjoint ones', () => {
    fc.assert(fc.property(set, set, (a, b) => {
      const similarity = pinSetSimilarity(a, b);
      expect(similarity).toBeCloseTo(jaccard(a, b), 12);
      expect(pinSetSimilarity(b, a)).toBe(similarity);
      expect(similarity).toBeGreaterThanOrEqual(0); expect(similarity).toBeLessThanOrEqual(1);
      expect(pinSetSimilarity(a, a)).toBe(1);
      const x = pairsOf(a), y = pairsOf(b);
      if (x.size && y.size && ![...x].some(pair => y.has(pair))) expect(similarity).toBe(0);
      if (similarity === 1) expect(pairsOf(a)).toEqual(pairsOf(b));
    }), params(600));
  });

  it('the distance 1 - similarity obeys the triangle inequality', () => {
    fc.assert(fc.property(set, set, set, (a, b, c) => {
      const d = (x: PinSet, y: PinSet) => 1 - pinSetSimilarity(x, y);
      expect(d(a, c)).toBeLessThanOrEqual(d(a, b) + d(b, c) + 1e-12);
    }), params(500));
  });

  it('diffPinSets lists exactly the pairs on one side only, sorted, and agrees with the similarity', () => {
    fc.assert(fc.property(set, set, (a, b) => {
      const diff = diffPinSets(a, b);
      const x = pairsOf(a), y = pairsOf(b);
      const only = (side: Set<string>, other: Set<string>) => [...side].filter(pair => !other.has(pair)).map(pair => { const [ref, pin] = pair.split('\u0000'); return { ref, pin }; });
      const key = (r: { ref: string; pin: string }) => `${r.ref}\u0000${r.pin}`;
      expect(new Set(diff.onlyA.map(key))).toEqual(new Set(only(x, y).map(key)));
      expect(new Set(diff.onlyB.map(key))).toEqual(new Set(only(y, x).map(key)));
      expect(diff.onlyA).toHaveLength(only(x, y).length);
      expect(diff.shared + diff.onlyA.length).toBe(x.size);
      expect(diff.shared + diff.onlyB.length).toBe(y.size);
      expect(diff.similarity).toBe(pinSetSimilarity(a, b));
      for (const list of [diff.onlyA, diff.onlyB]) {
        const keys = list.map(entry => `${entry.ref}\u0000${entry.pin}`);
        expect(keys).toEqual([...keys].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0)));
      }
      const swapped = diffPinSets(b, a);
      expect(swapped.onlyA).toEqual(diff.onlyB); expect(swapped.onlyB).toEqual(diff.onlyA);
    }), params(500));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Matching a saved record with an open board
// ---------------------------------------------------------------------------------------------------------------

const hex = fc.stringMatching(/^[0-9a-f]{64}$/);
const record = (list: BoardPartSpec[], fileKey?: string) => describeBoard(makeBoard(list), fileKey);

describe('matching a saved record', () => {
  it('the same file key wins; otherwise equal fingerprints; otherwise a similarity of at least the threshold is only offered', async () => {
    await fc.assert(fc.asyncProperty(parts, parts, fc.option(hex, { nil: undefined }), fc.option(hex, { nil: undefined }), async (a, b, keyA, keyB) => {
      const saved = await record(a, keyA), open = await record(b, keyB);
      const match = matchBoard(saved, open);
      if (keyA !== undefined && keyA === keyB) { expect(match).toEqual({ kind: 'same-file' }); return; }
      if (pinSetSize(open.pinSet) === 0) { expect(match).toEqual({ kind: 'different', similarity: null }); return; }
      if (saved.fingerprint === open.fingerprint) { expect(match).toEqual({ kind: 'same-fingerprint' }); return; }
      const similarity = pinSetSimilarity(saved.pinSet, open.pinSet);
      if (similarity >= SIMILAR_THRESHOLD && pinSetSize(saved.pinSet) > 0) {
        expect(match.kind).toBe('similar');
        if (match.kind === 'similar') {
          expect(match.similarity).toBe(similarity);
          expect(match.unmatchedRecorded).toEqual(diffPinSets(saved.pinSet, open.pinSet).onlyA);
          expect(match.unmatchedOpen).toEqual(diffPinSets(saved.pinSet, open.pinSet).onlyB);
        }
      } else expect(match).toEqual({ kind: 'different', similarity });
    }), params(300));
  });

  it('a board always matches itself and a spelling variant of itself; a record without a pin set can only reach the file key, the fingerprint and different', async () => {
    await fc.assert(fc.asyncProperty(parts.filter(list => pinSetSize(boardPinSet(makeBoard(list))) > 0), shuffleKeys, hex, async (list, keys, fileKey) => {
      const saved = await record(list, fileKey), same = await record(shuffled(list, keys).map(spec => ({ ...spec, ref: ` ${spec.ref.toLowerCase()} ` })));
      expect(matchBoard(saved, same)).toEqual({ kind: 'same-fingerprint' });
      expect(matchBoard(saved, { ...same, fileKey })).toEqual({ kind: 'same-file' });
      const bare: BoardRecord = { fingerprint: saved.fingerprint };
      expect(matchBoard(bare, same).kind).toBe('same-fingerprint');
      expect(matchBoard({ fingerprint: '0'.repeat(64) }, same)).toEqual({ kind: 'different', similarity: null });
    }), params(150));
  });

  it('one extra pad on a board of at least twenty pairs is offered as similar with exactly that pad listed, and many differences are not', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 20, max: 40 }), fc.integer({ min: 1, max: 3 }), async (count, parts_) => {
      const pins = Array.from({ length: count }, (_, i) => String(i + 1));
      const base: BoardPartSpec[] = [{ ref: 'U1', pins: pins.map(n => [n, ''] as const) }];
      const more: BoardPartSpec[] = [{ ref: 'U1', pins: [...pins, '999'].map(n => [n, ''] as const) }];
      const saved = await record(base), open = await record(more);
      const match = matchBoard(saved, open);
      expect(match.kind).toBe('similar');
      if (match.kind === 'similar') { expect(match.unmatchedRecorded).toEqual([]); expect(match.unmatchedOpen).toEqual([{ ref: 'U1', pin: '999' }]); expect(match.similarity).toBeCloseTo(count / (count + 1), 12); }
      const far: BoardPartSpec[] = [{ ref: 'U1', pins: [...pins.slice(0, Math.floor(count / 2)), ...Array.from({ length: parts_ * 10 }, (_, i) => `X${i}`)].map(n => [n, ''] as const) }];
      expect(matchBoard(saved, await record(far)).kind).toBe('different');
    }), params(40));
  });
});
