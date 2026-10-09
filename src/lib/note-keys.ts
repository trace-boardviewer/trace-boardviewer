/**
 * Stable identity of what a note is about. Pure TypeScript (no DOM, no Electron), so it runs in node and in a worker.
 *
 * Why: the importers number components and pins by position (`part:12`, `pin:341`). A parser fix that drops or reorders one component
 * would silently move every later note to another part. A note therefore never stores those ids; it stores the NAMES the board file
 * itself uses: a part is its reference designator, a pin is the reference plus the pin number.
 *
 * KEYS (stored form: `NoteKey` in types.ts; every name is NFKC-normalized and trimmed, case is kept, 1 to 256 characters):
 *   part        { ref: "U7" }
 *   pin         { ref: "U7", pin: "3" }          all pads of the part that carry that number are ONE pin (thermal and split pads)
 *
 * FALLBACKS (explicit, visible in the UI, never a guess). The file may not name an object uniquely; then the note is bound to the
 * object's POSITION on the board, as `{ side, x, y }` in millimetres rounded to 1 um:
 *   several parts share a reference       { ref: "R1", at: anchor }   `at` tells them apart
 *   a part without a (usable) reference   { at: anchor }              the importer's placeholder (`#5`, `FP5`) is not an identity
 *   a pad without a number                { ref: "U7", pinAt: anchor } (or `at` + `pinAt` when the part is anchored too)
 * Two objects that cannot be told apart even by position (same reference, same side, same spot) get no note at all: `target()` refuses.
 *
 * TEXT FORM (`noteKeyText`; unique per target, used to compare keys, as the Map key and by readings later):
 *     key    = part [ "/" pin ]
 *     part   = name | name "@" anchor | "@" anchor
 *     pin    = name | "@" anchor
 *     anchor = side x "," y             side: t (top) b (bottom) a (both); x and y are integer micrometres, "-" for negative
 *     name   = every character of the normalized name, except that each UTF-16 code unit of  %  /  @  U+0000-U+001F  U+007F  and the
 *              surrogate range U+D800-U+DFFF is written as "%" and its four uppercase hexadecimal digits (so "R/1" is "R%002F1").
 *   Examples:  U7   U7/3   R1@t12500,-8250   @b0,9000/@b100,9050   U7/A%00401
 *   `escapeKeyName` / `unescapeKeyName` are exact inverses; `unescapeKeyName` rejects any text `escapeKeyName` cannot produce.
 *
 * RESOLUTION (`NoteKeyIndex.resolve`): the key is looked up in the board as it is parsed NOW. Exactly one part must match, else the
 * note is unresolved ("missing" or "ambiguous"); a pin key must find a pad with that number (or the one unnumbered pad at the anchor).
 * Nothing is ever picked among several candidates. Unresolved notes stay in the store and are listed (see `unresolvedNotes`).
 *
 * MIGRATION (`migrateNotes`): a note written before keys existed (`LegacyNote`) names a positional id. When a board is opened, that id is
 * looked up in the board as the current importer read it and the note becomes a key; what cannot be resolved (id absent, part not
 * addressable, or another note already holds the key) stays a LegacyNote with `unresolved` filled in and is never re-resolved, because a
 * positional id means nothing against a later parse. The step is idempotent: a second run changes nothing.
 */
import { boardIndexOf } from './board-index';
import type { Board, BoardComponent, BoardNote, BoardPin, BoardSide, KeyedNote, LegacyNote, NoteAnchor, NoteKey, NoteProblem } from './types';

/** Longest reference or pin number a key can hold (the same bound as the stored note validators). */
export const NOTE_NAME_MAX = 256;
/** Largest anchor coordinate in millimetres (the importers' own range limit). */
export const NOTE_ANCHOR_LIMIT = 1e9;

/** The identity form of a reference or pin number: NFKC and trim, case preserved (the same rule as normalizeKey in crossprobe.ts, which a test keeps equal). */
export const normalizeName = (value: string): string => value.normalize('NFKC').trim();
const usableName = (value: string): string => { const name = normalizeName(value); return name.length >= 1 && name.length <= NOTE_NAME_MAX ? name : ''; };

// ---------------------------------------------------------------------------------------------------------------
// Text form
// ---------------------------------------------------------------------------------------------------------------

const ESCAPED = /[%/@\u0000-\u001f\u007f\ud800-\udfff]/g;
const NEEDS_ESCAPE = /[%/@\u0000-\u001f\u007f\ud800-\udfff]/;
export const escapeKeyName = (name: string): string => name.replace(ESCAPED, unit => `%${unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
/** The exact inverse of `escapeKeyName`; null for text it cannot have produced (a raw reserved character, a bad or non-canonical escape). */
export function unescapeKeyName(text: string): string | null {
  let name = '';
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char !== '%') { if (NEEDS_ESCAPE.test(char)) return null; name += char; continue; }
    const digits = text.slice(at + 1, at + 5);
    if (!/^[0-9A-F]{4}$/.test(digits)) return null;
    const decoded = String.fromCharCode(parseInt(digits, 16));
    if (!NEEDS_ESCAPE.test(decoded)) return null;
    name += decoded; at += 4;
  }
  return name;
}

const SIDE_LETTER: Readonly<Record<BoardSide, string>> = { top: 't', bottom: 'b', both: 'a' };
const micrometres = (mm: number): number => Math.round(mm * 1000);
const roundMm = (mm: number): number => micrometres(mm) / 1000 + 0; // `+ 0`: never -0
export const anchorText = (anchor: NoteAnchor): string => `${SIDE_LETTER[anchor.side]}${micrometres(anchor.x)},${micrometres(anchor.y)}`;

/** The text form of a key whose names are already normalized (what the validators and `target()` produce). */
export function noteKeyText(key: NoteKey): string {
  let text = key.ref === undefined ? '' : escapeKeyName(key.ref);
  if (key.at) text += `@${anchorText(key.at)}`;
  if (key.pin !== undefined) text += `/${escapeKeyName(key.pin)}`;
  else if (key.pinAt) text += `/@${anchorText(key.pinAt)}`;
  return text;
}
/** Part key of a reference designator, for features that attach data to parts (readings): the text form of `{ ref }`. */
export const partKeyText = (ref: string): string => escapeKeyName(normalizeName(ref));
/** Pin key of a reference designator and a pin number: the text form of `{ ref, pin }`. */
export const pinKeyText = (ref: string, pin: string): string => `${partKeyText(ref)}/${escapeKeyName(normalizeName(pin))}`;

const sameAnchor = (a: NoteAnchor | undefined, b: NoteAnchor | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.side === b.side && micrometres(a.x) === micrometres(b.x) && micrometres(a.y) === micrometres(b.y));
/** Field-wise equality of two keys, equal exactly when their text forms are equal. */
export const sameNoteKey = (a: NoteKey, b: NoteKey): boolean => a.ref === b.ref && a.pin === b.pin && sameAnchor(a.at, b.at) && sameAnchor(a.pinAt, b.pinAt);

export const isKeyedNote = (note: BoardNote): note is KeyedNote => 'target' in note;
/** A positional note nobody has tried to migrate yet (one that was tried carries `unresolved`). */
export const isPendingLegacyNote = (note: BoardNote): note is LegacyNote => !isKeyedNote(note) && note.unresolved === undefined;

/**
 * Conformance guard of every write: the application stores no note that still names a positional id without having been through the conversion
 * (it is keyed, or it carries `unresolved`). Throws for the first one that does.
 */
export function assertStorable(notes: readonly BoardNote[]): void {
  const pending = notes.find(isPendingLegacyNote);
  if (pending) throw new Error(`Note ${pending.id} still names a positional id and was not converted to a key.`);
}

// ---------------------------------------------------------------------------------------------------------------
// Index of one board
// ---------------------------------------------------------------------------------------------------------------

/** The part or pad the technician selected, as the board knows it in this session (the importer's ids; never stored). */
export interface NoteSubject { componentId: string; pinId?: string }
/** What a note on this target is bound by when the board file does not name it uniquely (shown to the technician). */
export type NoteFallback = 'duplicate-reference' | 'unnamed-part' | 'unnamed-pin';
export type NoteTargetFailure = 'unknown-component' | 'unknown-pin' | 'part-indistinguishable' | 'pin-indistinguishable';
export type NoteTargetResult = { ok: true; key: NoteKey; fallbacks: readonly NoteFallback[] } | { ok: false; reason: NoteTargetFailure };
export type NoteResolution =
  | { ok: true; component: BoardComponent; /** The pads of the pin (several for thermal or split pads); empty for a part note. */ pins: readonly BoardPin[] }
  | { ok: false; problem: Extract<NoteProblem, 'component-missing' | 'component-ambiguous' | 'pin-missing' | 'pin-ambiguous'> };

export interface NoteKeyIndex {
  /** The key for a note on this part (or pad), or why none can be made. Never throws. */
  target(componentId: string, pinId?: string): NoteTargetResult;
  /** The part and pads a key designates in this board, or why it designates none. Never picks among several candidates. */
  resolve(key: NoteKey): NoteResolution;
}

interface PinGroups { byNumber: Map<string, BoardPin[]>; unnumbered: Map<string, BoardPin[]> }
const push = <V>(map: Map<string, V[]>, key: string, value: V): void => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
const componentAnchor = (component: BoardComponent): NoteAnchor => ({ side: component.side, x: roundMm(component.position.x), y: roundMm(component.position.y) });
const padAnchor = (pin: BoardPin): NoteAnchor => ({ side: pin.side, x: roundMm(pin.x), y: roundMm(pin.y) });
const partName = (component: BoardComponent): string => component.refGenerated ? '' : usableName(component.ref);
const pinName = (pin: BoardPin): string => pin.numberGenerated ? '' : usableName(pin.number);

const indexes = new WeakMap<Board, NoteKeyIndex>();
/** The key index of a board, built once per board object (O(components); pads are grouped per part on first use). */
export function noteKeyIndex(board: Board): NoteKeyIndex {
  let index = indexes.get(board);
  if (!index) { index = buildIndex(board); indexes.set(board, index); }
  return index;
}

function buildIndex(board: Board): NoteKeyIndex {
  // The id maps are the board's shared index (the first component or pad of an id wins, as here before).
  const { componentById: components, pinById: pins } = boardIndexOf(board);
  const named = new Map<string, BoardComponent[]>(), unnamed = new Map<string, BoardComponent[]>();
  for (const component of components.values()) {
    const name = partName(component);
    if (name) push(named, name, component); else push(unnamed, anchorText(componentAnchor(component)), component);
  }
  const groups = new Map<BoardComponent, PinGroups>();
  const groupsOf = (component: BoardComponent): PinGroups => {
    let found = groups.get(component);
    if (!found) {
      found = { byNumber: new Map(), unnumbered: new Map() };
      for (const id of component.pinIds) {
        const pin = pins.get(id);
        if (!pin) continue;
        const name = pinName(pin);
        if (name) push(found.byNumber, name, pin); else push(found.unnumbered, anchorText(padAnchor(pin)), pin);
      }
      groups.set(component, found);
    }
    return found;
  };

  return {
    target(componentId, pinId) {
      const component = components.get(componentId);
      if (!component) return { ok: false, reason: 'unknown-component' };
      const fallbacks: NoteFallback[] = [];
      const name = partName(component), here = anchorText(componentAnchor(component));
      let key: NoteKey;
      if (name) {
        const same = named.get(name)!;
        if (same.length === 1) key = { ref: name };
        else {
          if (same.filter(other => anchorText(componentAnchor(other)) === here).length > 1) return { ok: false, reason: 'part-indistinguishable' };
          key = { ref: name, at: componentAnchor(component) };
          fallbacks.push('duplicate-reference');
        }
      } else {
        if (unnamed.get(here)!.length > 1) return { ok: false, reason: 'part-indistinguishable' };
        key = { at: componentAnchor(component) };
        fallbacks.push('unnamed-part');
      }
      if (pinId !== undefined) {
        const pin = pins.get(pinId);
        if (!pin || pin.componentId !== componentId) return { ok: false, reason: 'unknown-pin' };
        const number = pinName(pin), found = groupsOf(component);
        if (number) {
          if (!found.byNumber.get(number)?.includes(pin)) return { ok: false, reason: 'unknown-pin' };
          key = { ...key, pin: number };
        } else {
          const sameSpot = found.unnumbered.get(anchorText(padAnchor(pin)));
          if (!sameSpot?.includes(pin)) return { ok: false, reason: 'unknown-pin' };
          if (sameSpot.length > 1) return { ok: false, reason: 'pin-indistinguishable' };
          key = { ...key, pinAt: padAnchor(pin) };
          fallbacks.push('unnamed-pin');
        }
      }
      return { ok: true, key, fallbacks };
    },
    resolve(key) {
      let candidates: readonly BoardComponent[];
      if (key.ref !== undefined) {
        candidates = named.get(key.ref) ?? [];
        if (key.at) { const spot = anchorText(key.at); candidates = candidates.filter(component => anchorText(componentAnchor(component)) === spot); }
      } else candidates = key.at ? unnamed.get(anchorText(key.at)) ?? [] : [];
      if (candidates.length === 0) return { ok: false, problem: 'component-missing' };
      if (candidates.length > 1) return { ok: false, problem: 'component-ambiguous' };
      const component = candidates[0];
      if (key.pin === undefined && !key.pinAt) return { ok: true, component, pins: [] };
      const found = groupsOf(component);
      const pads = key.pin !== undefined ? found.byNumber.get(key.pin) : found.unnumbered.get(anchorText(key.pinAt!));
      if (!pads) return { ok: false, problem: 'pin-missing' };
      if (key.pin === undefined && pads.length > 1) return { ok: false, problem: 'pin-ambiguous' };
      return { ok: true, component, pins: pads };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Looking notes up
// ---------------------------------------------------------------------------------------------------------------

/** The note of exactly this part or pin (a part note never answers for one of its pins, nor the reverse). */
export function noteForSubject(board: Board | null, notes: readonly BoardNote[], subject: NoteSubject): KeyedNote | undefined {
  if (!board || notes.length === 0) return undefined;
  const result = noteKeyIndex(board).target(subject.componentId, subject.pinId);
  if (!result.ok) return undefined;
  const key = result.key;
  return notes.find((note): note is KeyedNote => isKeyedNote(note) && sameNoteKey(note.target, key));
}

/** Ids of the parts that carry at least one note (a pin note counts for its part). */
export function annotatedComponentIds(board: Board | null, notes: readonly BoardNote[]): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!board || notes.length === 0) return ids;
  const index = noteKeyIndex(board);
  for (const note of notes) {
    if (!isKeyedNote(note)) continue;
    const found = index.resolve(note.target);
    if (found.ok) ids.add(found.component.id);
  }
  return ids;
}

export interface UnresolvedNote { note: BoardNote; problem: NoteProblem }
/** Every note that is not attached to a part of this board: positional notes that could not be migrated, and keyed notes whose target the board no longer has. */
export function unresolvedNotes(board: Board | null, notes: readonly BoardNote[]): UnresolvedNote[] {
  const list: UnresolvedNote[] = [];
  let index: NoteKeyIndex | undefined;
  for (const note of notes) {
    if (!isKeyedNote(note)) { list.push({ note, problem: note.unresolved?.reason ?? 'legacy-id-missing' }); continue; }
    if (!board) continue;
    const found = (index ??= noteKeyIndex(board)).resolve(note.target);
    if (!found.ok) list.push({ note, problem: found.problem });
  }
  return list;
}

// ---------------------------------------------------------------------------------------------------------------
// Migration of positional notes
// ---------------------------------------------------------------------------------------------------------------

export interface NoteMigration {
  /** The same array (and objects) when nothing needed migrating. */
  notes: BoardNote[];
  changed: boolean;
  /** Notes that became keyed in this run. */
  migrated: number;
  /** Notes that were marked unresolved in this run. */
  unresolved: number;
}

/**
 * Turns the positional notes of a board that have not been tried yet into keyed notes, resolving each id against `board` (as the current
 * importer parsed it). If the reader marks positional identity unsafe, every pending positional note is preserved unresolved. Otherwise a note whose id is missing, whose part or pin cannot be addressed, or whose key another note already holds is kept
 * as it is with `unresolved: { reason, at: now }` (the first of two notes that map to the same key wins, in list order). Already keyed notes and
 * notes already marked unresolved are left alone, so a second run returns `changed: false`.
 */
export function migrateNotes(board: Board, notes: readonly BoardNote[], now: string): NoteMigration {
  if (!notes.some(isPendingLegacyNote)) return { notes: notes as BoardNote[], changed: false, migrated: 0, unresolved: 0 };
  const index = noteKeyIndex(board);
  const taken = new Set(notes.filter(isKeyedNote).map(note => noteKeyText(note.target)));
  let migrated = 0, unresolved = 0;
  const next = notes.map((note): BoardNote => {
    if (!isPendingLegacyNote(note)) return note;
    if (board.legacyPositionalNotesUnsafe) {
      unresolved++;
      return { ...note, unresolved: { reason: 'legacy-order-unknown', at: now } };
    }
    const result = index.target(note.componentId, note.pinId);
    let reason: NoteProblem;
    if (result.ok) {
      const text = noteKeyText(result.key);
      if (!taken.has(text)) {
        taken.add(text); migrated++;
        return { id: note.id, target: result.key, text: note.text, ...(note.measurements ? { measurements: note.measurements } : {}), updatedAt: note.updatedAt };
      }
      reason = 'duplicate-target';
    } else reason = result.reason === 'unknown-component' || result.reason === 'unknown-pin' ? 'legacy-id-missing' : 'legacy-indistinguishable';
    unresolved++;
    return { ...note, unresolved: { reason, at: now } };
  });
  return { notes: next, changed: true, migrated, unresolved };
}
