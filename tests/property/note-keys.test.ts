import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeKey } from '../../src/lib/crossprobe';
import {
  anchorText, annotatedComponentIds, escapeKeyName, isKeyedNote, migrateNotes, NOTE_NAME_MAX, noteForSubject, noteKeyIndex, noteKeyText, normalizeName, partKeyText, pinKeyText, sameNoteKey,
  unescapeKeyName, unresolvedNotes,
} from '../../src/lib/note-keys';
import type { Board, BoardNote, KeyedNote, LegacyNote, NoteAnchor, NoteKey } from '../../src/lib/types';
import { makeBoard } from './builders';
import type { BoardPartSpec } from './builders';
import { params, shuffled, shuffleKeys } from './support';

// ---------------------------------------------------------------------------------------------------------------
// Text form
// ---------------------------------------------------------------------------------------------------------------

/** Every UTF-16 code unit is fair game: reserved characters, controls, lone surrogates, astral pairs, compatibility forms. */
const unit = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('%', '/', '@', '\u0000', '\u001f', '\u007f', '\u0080', '\ud800', '\udfff', 'é', 'Å', 'Ａ', ' ', '0', 'A', 'z', '-', ',') },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 0xffff }).map(code => String.fromCharCode(code)) },
  { weight: 1, arbitrary: fc.constantFrom('𝄞', '😀') },
);
const anyName = fc.array(unit, { maxLength: 24 }).map(units => units.join(''));
/** A normalized name that a key may hold (1 to 256 characters after NFKC and trim). */
const keyName = fc.array(unit, { minLength: 1, maxLength: 24 }).map(units => normalizeName(units.join(''))).filter(name => name.length >= 1 && name.length <= NOTE_NAME_MAX);

const micrometre = fc.oneof(fc.integer({ min: -2_000_000, max: 2_000_000 }), fc.integer({ min: -1e12, max: 1e12 }));
const anchor: fc.Arbitrary<NoteAnchor> = fc.record({ side: fc.constantFrom('top' as const, 'bottom' as const, 'both' as const), x: micrometre.map(n => n / 1000 + 0), y: micrometre.map(n => n / 1000 + 0) });
/** A canonical key: a reference or an anchor, at most one of pin and pinAt, anchors already at whole micrometres. */
const canonicalKey: fc.Arbitrary<NoteKey> = fc.record({ ref: fc.option(keyName, { nil: undefined }), at: fc.option(anchor, { nil: undefined }), pin: fc.option(keyName, { nil: undefined }), pinAt: fc.option(anchor, { nil: undefined }) })
  .filter(key => (key.ref !== undefined || key.at !== undefined) && !(key.pin !== undefined && key.pinAt !== undefined))
  .map(key => Object.fromEntries(Object.entries(key).filter(([, value]) => value !== undefined)) as NoteKey);

const SIDE = { t: 'top', b: 'bottom', a: 'both' } as const;
/** An independent reader of the text grammar documented in note-keys.ts: key = part ["/" pin], part = name | name "@" anchor | "@" anchor, pin = name | "@" anchor. */
function parseKeyText(text: string): NoteKey | null {
  const halves = text.split('/');
  if (halves.length > 2) return null;
  const readAnchor = (piece: string): NoteAnchor | null => {
    const match = /^([tba])(-?\d+),(-?\d+)$/.exec(piece);
    return match ? { side: SIDE[match[1] as 't' | 'b' | 'a'], x: Number(match[2]) / 1000 + 0, y: Number(match[3]) / 1000 + 0 } : null;
  };
  const key: NoteKey = {};
  const [part, pin] = halves;
  const at = part.indexOf('@');
  const name = at < 0 ? part : part.slice(0, at);
  if (name !== '') { const ref = unescapeKeyName(name); if (ref === null) return null; key.ref = ref; }
  if (at >= 0) { const anchorPiece = readAnchor(part.slice(at + 1)); if (!anchorPiece) return null; key.at = anchorPiece; }
  if (pin !== undefined) {
    if (pin.startsWith('@')) { const anchorPiece = readAnchor(pin.slice(1)); if (!anchorPiece) return null; key.pinAt = anchorPiece; }
    else { const number = unescapeKeyName(pin); if (number === null) return null; key.pin = number; }
  }
  return key;
}

describe('key text: escaping and grammar', () => {
  it('escapeKeyName and unescapeKeyName are exact inverses, and the escaped text holds no reserved character', () => {
    fc.assert(fc.property(anyName, name => {
      const escaped = escapeKeyName(name);
      expect(unescapeKeyName(escaped)).toBe(name);
      // Nothing that would split or confuse a key remains: no raw /, @, control character or surrogate; every % opens four uppercase hex digits.
      expect(/[/@\u0000-\u001f\u007f\ud800-\udfff]/.test(escaped)).toBe(false);
      expect(escaped.replace(/%[0-9A-F]{4}/g, '').includes('%')).toBe(false);
    }), params(500));
  });

  it('unescapeKeyName accepts only text that escapeKeyName can have produced (canonical), and returns null for everything else', () => {
    const text = fc.oneof(anyName, fc.array(fc.constantFrom('%', '0', '1', '2', '5', 'F', 'f', 'A', '/', '@', 'x', 'é', '\ud800'), { maxLength: 14 }).map(parts => parts.join('')), anyName.map(escapeKeyName));
    fc.assert(fc.property(text, candidate => {
      const name = unescapeKeyName(candidate);
      if (name !== null) expect(escapeKeyName(name)).toBe(candidate);
    }), params(800));
    expect(unescapeKeyName('%0041')).toBeNull(); // "A" is never escaped
    expect(unescapeKeyName('%002f')).toBeNull(); // lower-case hexadecimal is not canonical
    expect(unescapeKeyName('%2F')).toBeNull(); // too short
    expect(unescapeKeyName('a/b')).toBeNull(); // a raw reserved character
    expect(unescapeKeyName('R%002F1')).toBe('R/1');
  });

  it('escaping is injective and composes: the escape of a concatenation is the concatenation of the escapes', () => {
    fc.assert(fc.property(anyName, anyName, (a, b) => {
      expect(escapeKeyName(a + b)).toBe(escapeKeyName(a) + escapeKeyName(b));
      expect(escapeKeyName(a) === escapeKeyName(b)).toBe(a === b);
    }), params(300));
  });

  it('the text form of a canonical key reads back to the same key (the grammar is unambiguous), and different keys have different texts', () => {
    fc.assert(fc.property(canonicalKey, canonicalKey, (a, b) => {
      expect(parseKeyText(noteKeyText(a))).toEqual(a);
      expect(noteKeyText(a) === noteKeyText(b)).toBe(sameNoteKey(a, b));
      expect(sameNoteKey(a, a)).toBe(true);
      expect(sameNoteKey(a, b)).toBe(sameNoteKey(b, a));
    }), params(600));
  });

  it('an anchor is micrometres, rounded and never "-0"', () => {
    fc.assert(fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.constantFrom('top' as const, 'bottom' as const, 'both' as const), (x, y, side) => {
      const text = anchorText({ side, x, y });
      expect(/^[tba]-?\d+,-?\d+$/.test(text)).toBe(true);
      expect(text.includes('-0,') || text.endsWith('-0')).toBe(false);
      const parsed = /^[tba](-?\d+),(-?\d+)$/.exec(text)!;
      expect(Math.abs(Number(parsed[1]) - x * 1000)).toBeLessThanOrEqual(0.5000001);
      expect(Math.abs(Number(parsed[2]) - y * 1000)).toBeLessThanOrEqual(0.5000001);
    }), params(300));
  });

  it('partKeyText and pinKeyText are the text of the part and pin keys of the normalized names; normalizeName equals the cross-probe identity key', () => {
    fc.assert(fc.property(anyName, anyName, (ref, pin) => {
      expect(normalizeName(ref)).toBe(normalizeKey(ref));
      expect(partKeyText(ref)).toBe(noteKeyText({ ref: normalizeName(ref) }));
      expect(pinKeyText(ref, pin)).toBe(noteKeyText({ ref: normalizeName(ref), pin: normalizeName(pin) }));
      expect(pinKeyText(ref, pin).startsWith(`${partKeyText(ref)}/`)).toBe(true);
    }), params(300));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Keys on a board
// ---------------------------------------------------------------------------------------------------------------

/** Parts on a coarse grid with few references: duplicates, unnamed parts, unnumbered pads and pads on one spot are all common. */
const spec: fc.Arbitrary<BoardPartSpec> = fc.record({
  ref: fc.constantFrom('R1', 'R1', 'R2', 'U1', '', 'FP5', 'Ｒ１', ' R1 '),
  refGenerated: fc.boolean(),
  at: fc.record({ x: fc.integer({ min: 0, max: 2 }), y: fc.integer({ min: 0, max: 1 }) }),
  side: fc.constantFrom('top' as const, 'bottom' as const, 'both' as const),
  pins: fc.array(fc.tuple(fc.constantFrom('1', '2', '2', '3', 'A1', '', ' 3 '), fc.constant(''), fc.boolean()), { maxLength: 4 }),
  pitch: fc.constantFrom(0, 1, 1),
});
const specs = fc.array(spec, { minLength: 1, maxLength: 7 });

const keyTexts = (board: Board) => {
  const index = noteKeyIndex(board);
  const result: string[] = [];
  for (const component of board.components) {
    const part = index.target(component.id);
    result.push(part.ok ? noteKeyText(part.key) : `X:${part.reason}`);
    for (const id of component.pinIds) { const pin = index.target(component.id, id); result.push(pin.ok ? noteKeyText(pin.key) : `X:${pin.reason}`); }
  }
  return result;
};

describe('note keys on a board', () => {
  it('a key resolves back to the very part (and pads) it was made for, or the object cannot be told apart from another one', () => {
    fc.assert(fc.property(specs, list => {
      const board = makeBoard(list), index = noteKeyIndex(board);
      const here = (c: Board['components'][number]) => `${c.side}|${Math.round(c.position.x * 1000)}|${Math.round(c.position.y * 1000)}`;
      for (const component of board.components) {
        const target = index.target(component.id);
        const named = !component.refGenerated && normalizeName(component.ref).length >= 1;
        const rivals = board.components.filter(other => other !== component && (named ? !other.refGenerated && normalizeName(other.ref) === normalizeName(component.ref) : (other.refGenerated || normalizeName(other.ref).length < 1)) && here(other) === here(component));
        if (!target.ok) { expect(target.reason).toBe('part-indistinguishable'); expect(rivals.length).toBeGreaterThan(0); continue; }
        expect(rivals).toHaveLength(0);
        const found = index.resolve(target.key);
        expect(found).toMatchObject({ ok: true, pins: [] });
        expect(found.ok && found.component).toBe(component);
        // The key says what it relies on.
        const duplicates = named && board.components.filter(other => !other.refGenerated && normalizeName(other.ref) === normalizeName(component.ref)).length > 1;
        expect(target.fallbacks.includes('duplicate-reference')).toBe(duplicates);
        expect(target.fallbacks.includes('unnamed-part')).toBe(!named);
        expect(target.key.at !== undefined).toBe(duplicates || !named);
        for (const id of component.pinIds) {
          const pin = board.pins.find(p => p.id === id)!;
          const padTarget = index.target(component.id, id);
          if (!padTarget.ok) { expect(padTarget.reason).toBe('pin-indistinguishable'); continue; }
          const padFound = index.resolve(padTarget.key);
          expect(padFound.ok).toBe(true);
          if (!padFound.ok) continue;
          expect(padFound.component).toBe(component);
          expect(padFound.pins).toContain(pin);
          const numbered = !pin.numberGenerated && normalizeName(pin.number).length >= 1;
          if (numbered) for (const sibling of padFound.pins) expect(normalizeName(sibling.number)).toBe(normalizeName(pin.number));
          else expect(padFound.pins).toEqual([pin]);
        }
      }
    }), params(400));
  });

  it('two different objects never share a key text; pads sharing a number are one pin with one key', () => {
    fc.assert(fc.property(specs, list => {
      const board = makeBoard(list), index = noteKeyIndex(board);
      const partTexts = new Map<string, string>();
      for (const component of board.components) {
        const target = index.target(component.id);
        if (!target.ok) continue;
        const text = noteKeyText(target.key);
        expect(partTexts.has(text)).toBe(false);
        partTexts.set(text, component.id);
        const byNumber = new Map<string, string>();
        for (const id of component.pinIds) {
          const pin = board.pins.find(p => p.id === id)!;
          const padTarget = index.target(component.id, id);
          if (!padTarget.ok) continue;
          const padText = noteKeyText(padTarget.key);
          expect(padText.startsWith(text)).toBe(true);
          if (!pin.numberGenerated && normalizeName(pin.number)) {
            const number = normalizeName(pin.number);
            if (byNumber.has(number)) expect(padText).toBe(byNumber.get(number));
            else byNumber.set(number, padText);
          }
        }
        // Different numbers, different keys.
        expect(new Set(byNumber.values()).size).toBe(byNumber.size);
      }
    }), params(400));
  });

  it('keys do not depend on how the importer numbered or ordered the parts: reordering the board gives the same set of keys', () => {
    fc.assert(fc.property(specs, shuffleKeys, shuffleKeys, (list, keysParts, keysPins) => {
      const original = makeBoard(list);
      // Other parts first: every part gets another session id.
      expect(keyTexts(makeBoard(shuffled(list, keysParts))).slice().sort()).toEqual(keyTexts(original).slice().sort());
      // Same ids, but the pads (and each part's list of them) in another order; every pad keeps its place on the board.
      const scrambled: Board = { ...original, components: shuffled(original.components, keysParts).map(c => ({ ...c, pinIds: shuffled(c.pinIds, keysPins) })), pins: shuffled(original.pins, keysPins) };
      expect(keyTexts(scrambled).slice().sort()).toEqual(keyTexts(original).slice().sort());
    }), params(300));
  });

  it('removing a part never moves another part\'s note: every other key still resolves to the same part', () => {
    fc.assert(fc.property(specs, fc.integer({ min: 0, max: 100 }), (list, pick) => {
      const board = makeBoard(list), index = noteKeyIndex(board);
      const gone = board.components[pick % board.components.length];
      const reduced: Board = { ...board, components: board.components.filter(c => c !== gone), pins: board.pins.filter(p => p.componentId !== gone.id) };
      const after = noteKeyIndex(reduced);
      for (const component of reduced.components) {
        const target = index.target(component.id);
        if (!target.ok) continue;
        const found = after.resolve(target.key);
        expect(found.ok).toBe(true);
        expect(found.ok && found.component).toBe(component);
        for (const id of component.pinIds) {
          const padTarget = index.target(component.id, id);
          if (!padTarget.ok) continue;
          const padFound = after.resolve(padTarget.key);
          expect(padFound.ok && padFound.component === component && padFound.pins.some(p => p.id === id)).toBe(true);
        }
      }
    }), params(300));
  });

  it('a key for a part that is not in the board is "missing", never attached to another part', () => {
    fc.assert(fc.property(specs, keyName, (list, name) => {
      const board = makeBoard(list), index = noteKeyIndex(board);
      const exists = board.components.some(c => !c.refGenerated && normalizeName(c.ref) === name);
      const found = index.resolve({ ref: name });
      if (!exists) expect(found).toEqual({ ok: false, problem: 'component-missing' });
      else expect(found.ok || found.problem === 'component-ambiguous').toBe(true);
    }), params(300));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Notes: lookup and migration
// ---------------------------------------------------------------------------------------------------------------

const NOW = '2026-10-07T10:00:00.000Z';
const legacyFor = (board: Board, picks: ReadonlyArray<readonly [number, number, boolean]>): LegacyNote[] => picks.map(([c, p, missing], i) => {
  const component = board.components[c % board.components.length];
  const pinId = component.pinIds.length ? component.pinIds[p % component.pinIds.length] : undefined;
  return { id: `n${i}`, componentId: missing ? `part:${900 + i}` : component.id, ...(pinId !== undefined && p % 2 === 0 ? { pinId: missing ? `pin:${900 + i}` : pinId } : {}), text: `note ${i}`, updatedAt: NOW };
});
const picks = fc.array(fc.tuple(fc.integer({ min: 0, max: 50 }), fc.integer({ min: 0, max: 50 }), fc.boolean()), { maxLength: 8 });

describe('note migration and lookup', () => {
  it('migrateNotes converts what the board can name, marks the rest unresolved with the right reason, and a second run changes nothing', () => {
    fc.assert(fc.property(specs, picks, (list, chosen) => {
      const board = makeBoard(list), index = noteKeyIndex(board);
      const notes = legacyFor(board, chosen);
      const result = migrateNotes(board, notes, NOW);
      expect(result.notes).toHaveLength(notes.length);
      expect(result.changed).toBe(notes.length > 0);
      expect(result.migrated + result.unresolved).toBe(notes.length);
      const taken = new Set<string>();
      result.notes.forEach((note, i) => {
        const before = notes[i];
        expect(note.id).toBe(before.id); expect(note.text).toBe(before.text); expect(note.updatedAt).toBe(before.updatedAt);
        const target = index.target(before.componentId, before.pinId);
        if (isKeyedNote(note)) {
          expect(target.ok).toBe(true);
          if (target.ok) { expect(note.target).toEqual(target.key); expect(taken.has(noteKeyText(target.key))).toBe(false); taken.add(noteKeyText(target.key)); }
          return;
        }
        // Not converted: it keeps its positional ids and says why, once.
        expect(note).toMatchObject({ componentId: before.componentId, unresolved: { at: NOW } });
        const reason = (note as LegacyNote).unresolved!.reason;
        if (!target.ok) expect(reason).toBe(target.reason === 'unknown-component' || target.reason === 'unknown-pin' ? 'legacy-id-missing' : 'legacy-indistinguishable');
        else { expect(reason).toBe('duplicate-target'); expect(taken.has(noteKeyText(target.key))).toBe(true); }
      });
      const again = migrateNotes(board, result.notes, '2030-01-01T00:00:00.000Z');
      expect(again.changed).toBe(false);
      expect(again.notes).toBe(result.notes);
      expect(again.migrated + again.unresolved).toBe(0);
    }), params(300));
  });

  it('unresolved notes are exactly the ones whose key (or positional id) the board no longer has', () => {
    fc.assert(fc.property(specs, specs, picks, (listA, listB, chosen) => {
      const first = makeBoard(listA), second = makeBoard(listB);
      const migrated = migrateNotes(first, legacyFor(first, chosen), NOW).notes;
      const open = unresolvedNotes(second, migrated);
      const index = noteKeyIndex(second);
      for (const note of migrated) {
        const listed = open.find(entry => entry.note === note);
        if (!isKeyedNote(note)) { expect(listed).toBeDefined(); continue; }
        const found = index.resolve(note.target);
        expect(listed === undefined).toBe(found.ok);
        if (listed && !found.ok) expect(listed.problem).toBe(found.problem);
      }
      const attached = annotatedComponentIds(second, migrated);
      for (const note of migrated) if (isKeyedNote(note)) { const found = index.resolve(note.target); if (found.ok) expect(attached.has(found.component.id)).toBe(true); }
      for (const id of attached) expect(second.components.some(c => c.id === id)).toBe(true);
      expect(unresolvedNotes(null, migrated).every(entry => !isKeyedNote(entry.note))).toBe(true);
    }), params(250));
  });

  it('noteForSubject answers with the note of exactly that part or pin: a part note never answers for a pin, nor the reverse', () => {
    fc.assert(fc.property(specs, fc.array(fc.tuple(fc.integer({ min: 0, max: 50 }), fc.integer({ min: 0, max: 50 }), fc.boolean()), { maxLength: 8 }), (list, chosen) => {
      const board = makeBoard(list), index = noteKeyIndex(board);
      const notes: BoardNote[] = [];
      const seen = new Set<string>();
      chosen.forEach(([c, p, onPin], i) => {
        const component = board.components[c % board.components.length];
        const pinId = onPin && component.pinIds.length ? component.pinIds[p % component.pinIds.length] : undefined;
        const target = index.target(component.id, pinId);
        if (!target.ok || seen.has(noteKeyText(target.key))) return;
        seen.add(noteKeyText(target.key));
        notes.push({ id: `k${i}`, target: target.key, text: `t${i}`, updatedAt: NOW } satisfies KeyedNote);
      });
      for (const component of board.components) {
        const target = index.target(component.id);
        const found = noteForSubject(board, notes, { componentId: component.id });
        if (!target.ok) { expect(found).toBeUndefined(); continue; }
        expect(found === undefined).toBe(!notes.some(n => isKeyedNote(n) && noteKeyText(n.target) === noteKeyText(target.key)));
        for (const id of component.pinIds) {
          const pinTarget = index.target(component.id, id);
          const pinFound = noteForSubject(board, notes, { componentId: component.id, pinId: id });
          if (!pinTarget.ok) { expect(pinFound).toBeUndefined(); continue; }
          if (pinFound) { expect(isKeyedNote(pinFound) && pinFound.target.pin !== undefined || isKeyedNote(pinFound) && pinFound.target.pinAt !== undefined).toBe(true); expect(noteKeyText(pinFound.target)).toBe(noteKeyText(pinTarget.key)); }
        }
      }
      expect(noteForSubject(null, notes, { componentId: 'c0' })).toBeUndefined();
    }), params(250));
  });
});
