import type { Board } from './types';

/**
 * Board fingerprint: an identity of a board that does not depend on the file format.
 *
 * Saved data (readings, job logs, shared sets) belongs to a board. The SHA-256 of the file bytes (`FilePayload.key`) names
 * one file; the same board exported by KiCad and by a boardview exporter is two files. The fingerprint is taken from what
 * every format has to carry: the references of the parts and the pin numbers of each. Net names (formats name nets
 * differently), coordinates and units, sides, values, packages, outlines and part order are left out.
 *
 *   fingerprint = "fp1:" + hex of the SHA-256 of  "trace-board-fingerprint/1\n" + JSON of [[ref, [pin, ...]], ...]
 *
 * The `fp1:` prefix names the recipe, so a fingerprint is never taken for a file key (64 hex digits and nothing else) and
 * a later recipe can be told from this one in stored data. With references and pin numbers trimmed and upper-cased, the
 * pin numbers of a reference de-duplicated (a thermal pad drawn as several pads, an exporter that drops overlapping
 * same-numbered pads) and both levels sorted by UTF-16 code unit.
 * Parts without a numbered pin are not part of it (some formats omit pinless parts), and neither are pins without a real
 * number: a pad that has none (fiducial, mounting hole, shield tab) is numbered by the adapter, and that number depends on
 * the format. An adapter marks such a pad by a number starting with `~` (the KiCad and BVR adapters write ~1, ~2, ...; see
 * `UNNUMBERED_PIN_PREFIX`); those are skipped. An adapter that numbers an unnumbered pad like a real one leaves a pair that
 * only that format has: the boards then match as `similar`, not as `same-fingerprint`. The version line and the prefix
 * change when this recipe ever changes.
 *
 * Matching a saved record against the board that is open now has four outcomes (`matchBoard`):
 *  1. `same-file`: the file keys are equal. Applied automatically.
 *  2. `same-fingerprint`: the fingerprints are equal. Applied automatically, with a notice.
 *  3. `similar`: the (ref, pin) sets have a Jaccard similarity of at least 0.95. Only OFFERED, with the lists of pins that
 *     exist on one side only; applied on explicit confirmation.
 *  4. `different`.
 * Step 3 needs the (ref, pin) set of the saved record next to its fingerprint; a record that kept only the fingerprint can
 * only reach steps 1, 2 and 4.
 *
 * Hashing uses Web Crypto (`crypto.subtle`), like the file keys, so everything here runs in the renderer and in workers.
 */

export const FINGERPRINT_VERSION = 1;
/** Starts every fingerprint: names the recipe and keeps a fingerprint from being taken for a file key, which is bare hex. */
export const FINGERPRINT_PREFIX = `fp${FINGERPRINT_VERSION}:`;
/** Jaccard similarity from which two boards are offered as the same board. */
export const SIMILAR_THRESHOLD = 0.95;

/** References and their pin numbers in canonical form: trimmed, upper-cased, sorted, without duplicates. JSON friendly. */
export type PinSet = ReadonlyArray<readonly [ref: string, pins: readonly string[]]>;
export interface PinRef { readonly ref: string; readonly pin: string }

/** Pin numbers starting with this are adapter-made numbers of unnumbered pads and take no part in the identity. */
export const UNNUMBERED_PIN_PREFIX = '~';
const PREIMAGE_HEAD = `trace-board-fingerprint/${FINGERPRINT_VERSION}\n`;
const MAX_TEXT = 256;
const MAX_PAIRS = 2_000_000;

const canonical = (text: string): string => text.trim().toUpperCase();
const isIdentityPin = (number: string): boolean => number !== '' && !number.startsWith(UNNUMBERED_PIN_PREFIX);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function toPinSet(byRef: Map<string, Set<string>>): PinSet {
  return [...byRef.keys()].sort(compare).map(ref => [ref, [...byRef.get(ref)!].sort(compare)] as const);
}

/** The canonical (ref, pin) set of a board. Pins of parts with the same reference are merged. */
export function boardPinSet(board: Pick<Board, 'components' | 'pins'>): PinSet {
  const refOf = new Map<string, string>();
  for (const component of board.components) {
    const ref = canonical(String(component.ref));
    if (ref !== '') refOf.set(component.id, ref);
  }
  const byRef = new Map<string, Set<string>>();
  for (const pin of board.pins) {
    const ref = refOf.get(pin.componentId);
    if (ref === undefined) continue;
    const number = canonical(String(pin.number));
    if (!isIdentityPin(number)) continue;
    const pins = byRef.get(ref);
    if (pins) pins.add(number); else byRef.set(ref, new Set([number]));
  }
  return toPinSet(byRef);
}

/**
 * Validates and canonicalizes a (ref, pin) set read from storage or from a shared file: an array of [ref, [pin, ...]].
 * Null when the shape is wrong, a text is longer than 256 characters or there are more than 2,000,000 pairs.
 */
export function normalizePinSet(value: unknown): PinSet | null {
  if (!Array.isArray(value)) return null;
  const byRef = new Map<string, Set<string>>();
  let pairs = 0;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) return null;
    if (entry[0].length > MAX_TEXT) return null;
    const ref = canonical(entry[0]);
    let pins = byRef.get(ref);
    for (const pin of entry[1]) {
      if (typeof pin !== 'string' || pin.length > MAX_TEXT || ++pairs > MAX_PAIRS) return null;
      const number = canonical(pin);
      if (!isIdentityPin(number) || ref === '') continue;
      if (!pins) byRef.set(ref, pins = new Set());
      pins.add(number);
    }
  }
  return toPinSet(byRef);
}

/** Number of (ref, pin) pairs. */
export function pinSetSize(set: PinSet): number {
  let size = 0;
  for (const [, pins] of set) size += pins.length;
  return size;
}

const toHex = (digest: ArrayBuffer): string => Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');

/** `fp1:` and the SHA-256 (lower-case hex) of a canonical (ref, pin) set: the input must come from `boardPinSet` or `normalizePinSet`. */
export async function pinSetFingerprint(set: PinSet): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto is not available, so a board fingerprint cannot be computed.');
  const bytes = new TextEncoder().encode(PREIMAGE_HEAD + JSON.stringify(set));
  return FINGERPRINT_PREFIX + toHex(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}

/** The fingerprint of a board: the same board gives the same value whichever file format it was read from. */
export async function boardFingerprint(board: Pick<Board, 'components' | 'pins'>): Promise<string> {
  return pinSetFingerprint(boardPinSet(board));
}

interface Counts { shared: number; onlyA: number; onlyB: number }

/** Merge join of two canonical sets; `visit` is called for every pair that exists on one side only. */
function walk(a: PinSet, b: PinSet, visit?: (side: 'a' | 'b', ref: string, pin: string) => void): Counts {
  const counts: Counts = { shared: 0, onlyA: 0, onlyB: 0 };
  const one = (side: 'a' | 'b', ref: string, pins: readonly string[]) => {
    if (side === 'a') counts.onlyA += pins.length; else counts.onlyB += pins.length;
    if (visit) for (const pin of pins) visit(side, ref, pin);
  };
  let x = 0, y = 0;
  while (x < a.length && y < b.length) {
    const order = compare(a[x][0], b[y][0]);
    if (order < 0) { one('a', a[x][0], a[x][1]); x++; continue; }
    if (order > 0) { one('b', b[y][0], b[y][1]); y++; continue; }
    const left = a[x][1], right = b[y][1], ref = a[x][0];
    let i = 0, j = 0;
    while (i < left.length && j < right.length) {
      const pins = compare(left[i], right[j]);
      if (pins === 0) { counts.shared++; i++; j++; }
      else if (pins < 0) { counts.onlyA++; visit?.('a', ref, left[i]); i++; }
      else { counts.onlyB++; visit?.('b', ref, right[j]); j++; }
    }
    for (; i < left.length; i++) { counts.onlyA++; visit?.('a', ref, left[i]); }
    for (; j < right.length; j++) { counts.onlyB++; visit?.('b', ref, right[j]); }
    x++; y++;
  }
  for (; x < a.length; x++) one('a', a[x][0], a[x][1]);
  for (; y < b.length; y++) one('b', b[y][0], b[y][1]);
  return counts;
}

/** Jaccard similarity of two canonical (ref, pin) sets: shared pairs over all distinct pairs; 1 when both are empty. */
export function pinSetSimilarity(a: PinSet, b: PinSet): number {
  const { shared, onlyA, onlyB } = walk(a, b);
  const union = shared + onlyA + onlyB;
  return union === 0 ? 1 : shared / union;
}

export interface PinSetDifference {
  /** Pairs on both sides. */
  shared: number;
  similarity: number;
  /** Pairs only in `a`, then only in `b`, in sorted order. */
  onlyA: PinRef[];
  onlyB: PinRef[];
}

/** Similarity plus the lists of pairs that exist on one side only. */
export function diffPinSets(a: PinSet, b: PinSet): PinSetDifference {
  const onlyA: PinRef[] = [], onlyB: PinRef[] = [];
  const { shared } = walk(a, b, (side, ref, pin) => { (side === 'a' ? onlyA : onlyB).push({ ref, pin }); });
  const union = shared + onlyA.length + onlyB.length;
  return { shared, similarity: union === 0 ? 1 : shared / union, onlyA, onlyB };
}

/** What a saved record knows about the board it belongs to. */
export interface BoardRecord {
  /** SHA-256 hex of the file bytes (`FilePayload.key`), when known. */
  fileKey?: string;
  /** The board fingerprint: `fp1:` and 64 hex digits (`pinSetFingerprint`). */
  fingerprint: string;
  /** The (ref, pin) set; without it a record can never match as `similar`. */
  pinSet?: PinSet;
}

/** The record of an open board: file key, fingerprint and its (ref, pin) set. */
export async function describeBoard(board: Pick<Board, 'components' | 'pins'>, fileKey?: string): Promise<BoardRecord & { pinSet: PinSet }> {
  const pinSet = boardPinSet(board);
  const record: BoardRecord & { pinSet: PinSet } = { fingerprint: await pinSetFingerprint(pinSet), pinSet };
  if (fileKey) record.fileKey = fileKey;
  return record;
}

export type BoardMatch =
  | { kind: 'same-file' }
  | { kind: 'same-fingerprint' }
  /** Offer only: the lists hold the pairs that exist on one side only (saved record, open board). */
  | { kind: 'similar'; similarity: number; unmatchedRecorded: PinRef[]; unmatchedOpen: PinRef[] }
  /** `similarity` is null when it could not be computed (a side has no pin set). */
  | { kind: 'different'; similarity: number | null };

/**
 * Compares a saved record with the open board. An open board without any numbered pin has no identity: it only matches by
 * file key. The pin set of the open board is what the offered `similar` match is computed from.
 */
export function matchBoard(recorded: BoardRecord, open: BoardRecord, threshold: number = SIMILAR_THRESHOLD): BoardMatch {
  if (recorded.fileKey && open.fileKey && recorded.fileKey === open.fileKey) return { kind: 'same-file' };
  const openEmpty = open.pinSet !== undefined && pinSetSize(open.pinSet) === 0;
  if (openEmpty) return { kind: 'different', similarity: null };
  if (recorded.fingerprint === open.fingerprint) return { kind: 'same-fingerprint' };
  if (!recorded.pinSet || !open.pinSet) return { kind: 'different', similarity: null };
  const similarity = pinSetSimilarity(recorded.pinSet, open.pinSet);
  if (!(similarity >= threshold) || pinSetSize(recorded.pinSet) === 0) return { kind: 'different', similarity };
  const { onlyA, onlyB } = diffPinSets(recorded.pinSet, open.pinSet);
  return { kind: 'similar', similarity, unmatchedRecorded: onlyA, unmatchedOpen: onlyB };
}
