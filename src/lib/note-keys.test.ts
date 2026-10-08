import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { normalizeKey } from './crossprobe';
import {
  NOTE_ANCHOR_LIMIT, NOTE_NAME_MAX, annotatedComponentIds, anchorText, assertStorable, escapeKeyName, isKeyedNote, isPendingLegacyNote, migrateNotes, noteForSubject, noteKeyIndex, noteKeyText,
  normalizeName, partKeyText, pinKeyText, sameNoteKey, unescapeKeyName, unresolvedNotes,
} from './note-keys';
import type { Board, BoardComponent, BoardNote, BoardPin, BoardSide, KeyedNote, LegacyNote, NoteKey } from './types';
import { WORKSPACE_MODEL_LIMITS, noteFor, noteTarget, upsertNote, validateNotes } from './workspace';

const nodeRequire = createRequire(import.meta.url);
const T0 = '2026-10-05T10:00:00.000Z';
const T1 = '2026-10-06T09:30:00.000Z';

// ---------------------------------------------------------------------------------------------------------------
// Original synthetic boards. Ids are positional on purpose (like the shared importer): part:<n>, pin:<n>.
// ---------------------------------------------------------------------------------------------------------------

interface PadSpec { number: string; at?: [x: number, y: number]; side?: BoardSide; generated?: boolean }
interface PartSpec { ref: string; at: [x: number, y: number]; side?: BoardSide; generated?: boolean; pads?: Array<PadSpec | string> }
function board(specs: PartSpec[]): Board {
  const components: BoardComponent[] = [], pins: BoardPin[] = [];
  specs.forEach((spec, index) => {
    const id = `part:${index}`, side = spec.side ?? 'top';
    const pinIds: string[] = [];
    (spec.pads ?? []).forEach((raw, padIndex) => {
      const pad: PadSpec = typeof raw === 'string' ? { number: raw } : raw;
      const pinId = `pin:${pins.length}`;
      pinIds.push(pinId);
      pins.push({ id: pinId, componentId: id, number: pad.number, ...(pad.generated ? { numberGenerated: true as const } : {}), name: pad.number, net: '', side: pad.side ?? side, radius: 0.2, shape: 'round',
        x: pad.at?.[0] ?? spec.at[0] + padIndex, y: pad.at?.[1] ?? spec.at[1] });
    });
    components.push({ id, ref: spec.ref, ...(spec.generated ? { refGenerated: true as const } : {}), value: '', package: '', side, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, position: { x: spec.at[0], y: spec.at[1] }, rotation: 0, pinIds, outline: [] });
  });
  return { name: 'synthetic', format: 'test', units: 'mm', components, pins, nets: [], outline: [], bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, warnings: [] };
}
const idOf = (b: Board, ref: string, nth = 0) => b.components.filter(component => component.ref === ref)[nth].id;
/** The nth pad numbered `number` of the nth part named `ref`. */
const pinOf = (b: Board, ref: string, number: string, nth = 0, partNth = 0) => b.pins.filter(pin => pin.componentId === idOf(b, ref, partNth) && pin.number === number)[nth].id;
const keyed = (id: string, target: NoteKey, text = `note ${id}`, extra: Partial<KeyedNote> = {}): KeyedNote => ({ id, target, text, updatedAt: T0, ...extra });
const legacy = (id: string, componentId: string, pinId?: string, extra: Partial<LegacyNote> = {}): LegacyNote => ({ id, componentId, ...(pinId === undefined ? {} : { pinId }), text: `note ${id}`, updatedAt: T0, ...extra });

// ---------------------------------------------------------------------------------------------------------------
// Text form and escaping
// ---------------------------------------------------------------------------------------------------------------

describe('text form of a key', () => {
  it('writes the documented examples', () => {
    expect(noteKeyText({ ref: 'U7' })).toBe('U7');
    expect(noteKeyText({ ref: 'U7', pin: '3' })).toBe('U7/3');
    expect(noteKeyText({ ref: 'R1', at: { side: 'top', x: 12.5, y: -8.25 } })).toBe('R1@t12500,-8250');
    expect(noteKeyText({ at: { side: 'bottom', x: 0, y: 9 }, pinAt: { side: 'bottom', x: 0.1, y: 9.05 } })).toBe('@b0,9000/@b100,9050');
    expect(noteKeyText({ ref: 'U7', pin: 'A@1' })).toBe('U7/A%00401');
    expect(noteKeyText({ ref: 'U7', pinAt: { side: 'both', x: 1, y: 2 } })).toBe('U7/@a1000,2000');
    expect(noteKeyText({ ref: 'R/1' })).toBe('R%002F1');
    expect(anchorText({ side: 'top', x: -0.0004, y: 0.0005 })).toBe('t0,1');
  });

  it('escapes exactly the reserved characters, controls and surrogates, as % and four uppercase hex digits', () => {
    expect(escapeKeyName('R1')).toBe('R1');
    expect(escapeKeyName('a%b/c@d')).toBe('a%0025b%002Fc%0040d');
    expect(escapeKeyName('\u0000\u001f\u007f')).toBe('%0000%001F%007F');
    expect(escapeKeyName(' ~\u0080é漢,:#')).toBe(' ~\u0080é漢,:#');
    expect(escapeKeyName('😀')).toBe('%D83D%DE00');
    expect(escapeKeyName('\ud800x')).toBe('%D800x');
  });

  it('unescape is the exact inverse and rejects text escape cannot have produced', () => {
    const samples = ['', 'R1', 'a%b/c@d', '%', '%%', '%0025', '/@', '\u0000', '😀', '\ud800', '\udfff', 'é漢', 'U1 A', '~1', '%zz'];
    for (const sample of samples) expect(unescapeKeyName(escapeKeyName(sample)), JSON.stringify(sample)).toBe(sample);
    for (const bad of ['/', '@', '\u0000', '\u007f', '\ud800', '%', '%12', '%00zz', '%002f', '%0041', '%00251', 'R%', 'R%00']) {
      // %00251 is "%0025" followed by "1": the only text that is rejected is the one that is not a canonical escape sequence
      if (bad === '%00251') expect(unescapeKeyName(bad)).toBe('%1'); else expect(unescapeKeyName(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('round-trips random strings over every kind of character (a fixed pseudo-random sequence)', () => {
    let seed = 0x2f6e2b1;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const pool = ['%', '/', '@', ',', ':', '\u0000', '\u001f', '\u007f', '\u0080', '\ud800', '\udfff', '\ud83d', '\ude00', ' ', 'A', 'z', '0', '~', '#', '漢', 'é', '-'];
    for (let i = 0; i < 2000; i++) {
      const length = next() % 12;
      let text = '';
      for (let k = 0; k < length; k++) text += pool[next() % pool.length];
      const escaped = escapeKeyName(text);
      expect(escaped).not.toMatch(/[/@\u0000-\u001f\u007f\ud800-\udfff]/);
      expect(unescapeKeyName(escaped)).toBe(text);
    }
  });

  it('is injective: keys that differ in any field have different texts, equal keys have equal texts', () => {
    const top = (x: number, y: number) => ({ side: 'top' as const, x, y });
    const keys: NoteKey[] = [
      { ref: 'U1' }, { ref: 'U1', pin: '1' }, { ref: 'U1', pin: '2' }, { ref: 'U/1' }, { ref: 'U', pin: '1' }, { ref: 'U1@t1000,2000' }, { ref: 'U1', at: top(1, 2) }, { at: top(1, 2) },
      { ref: 'U1', at: top(1, 2), pin: '1' }, { ref: 'U1', at: top(1, 2), pinAt: top(3, 4) }, { ref: 'U1', pinAt: top(3, 4) }, { ref: 'U1', pin: '@t3000,4000' }, { ref: 'U1', at: { side: 'bottom', x: 1, y: 2 } },
      { ref: 'U1', at: { side: 'both', x: 1, y: 2 } }, { ref: 'U1', at: top(1, -2) }, { ref: 'U1', at: top(-1, 2) }, { ref: 'U1', at: top(12, 0) }, { ref: 'U1', at: top(1, 20) }, { at: top(1, 2), pinAt: top(1, 2) },
      { ref: 'U1', pin: '' }, { ref: 'U%1' }, { ref: 'U%00251' }, { ref: 'u1' }, { ref: '1' }, { ref: '1', pin: 'U1' },
    ];
    const texts = new Map<string, NoteKey>();
    for (const key of keys) {
      const text = noteKeyText(key);
      const same = texts.get(text);
      if (same) throw new Error(`${JSON.stringify(key)} and ${JSON.stringify(same)} share the text ${text}`);
      texts.set(text, key);
    }
    for (const a of keys) for (const b of keys) expect(sameNoteKey(a, b) === (noteKeyText(a) === noteKeyText(b)), `${noteKeyText(a)} / ${noteKeyText(b)}`).toBe(true);
    expect(sameNoteKey({ ref: 'R1', at: top(1, 2) }, { ref: 'R1', at: top(1.0004, 2) })).toBe(true);
    expect(noteKeyText({ ref: 'R1', at: top(1, 2) })).toBe(noteKeyText({ ref: 'R1', at: top(1.0004, 2) }));
  });

  it('partKeyText and pinKeyText are the text forms of a part and a pin key, with the names normalized (what readings will reuse)', () => {
    expect(partKeyText(' Ｕ７ ')).toBe('U7');
    expect(partKeyText('U7')).toBe(noteKeyText({ ref: 'U7' }));
    expect(pinKeyText('U7', ' 3 ')).toBe(noteKeyText({ ref: 'U7', pin: '3' }));
    expect(pinKeyText('R/1', 'A@1')).toBe('R%002F1/A%00401');
    expect(partKeyText('R1')).not.toBe(partKeyText('r1'));
  });

  it('normalizes names exactly like the cross-probe keys do', () => {
    for (const value of ['R1', ' R1 ', 'Ｒ１', 'Å', 'Å', '①', 'ﬁ', '  ', '', 'r1', ' X ', 'a\tb', 'Å']) expect(normalizeName(value), JSON.stringify(value)).toBe(normalizeKey(value));
  });

  it('shares its bounds with both validators', () => {
    const native = nodeRequire('../../electron/workspace.cjs');
    expect(NOTE_NAME_MAX).toBe(WORKSPACE_MODEL_LIMITS.componentId);
    expect(NOTE_NAME_MAX).toBe(native.LIMITS.componentId);
    expect(NOTE_ANCHOR_LIMIT).toBe(WORKSPACE_MODEL_LIMITS.anchor);
    expect(NOTE_ANCHOR_LIMIT).toBe(native.LIMITS.anchor);
  });

  it('the text form is the same in the native validator (a parity corpus of keys)', () => {
    const native = nodeRequire('../../electron/workspace.cjs');
    const keys: NoteKey[] = [
      { ref: 'U1' }, { ref: 'U1', pin: '3' }, { ref: 'R/1', pin: 'A@1' }, { ref: 'a%b\u0000😀' }, { ref: 'R1', at: { side: 'top', x: 12.5, y: -8.25 } },
      { at: { side: 'bottom', x: 0, y: 9 }, pinAt: { side: 'both', x: 0.1, y: 9.05 } }, { ref: 'U1', pinAt: { side: 'top', x: -0.0004, y: 123456.789 } },
    ];
    for (const key of keys) expect(native.noteKeyText(key), JSON.stringify(key)).toBe(noteKeyText(key));
    for (const text of ['', 'U1', ' Ｕ１ ', 'a%b/c@d', '\u0000', '\ud800']) {
      expect(native.escapeKeyName(text)).toBe(escapeKeyName(text));
      expect(native.normalizeName(text)).toBe(normalizeName(text));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Targets and resolution
// ---------------------------------------------------------------------------------------------------------------

describe('keys for parts and pins', () => {
  const a = () => board([
    { ref: 'R1', at: [1, 1], pads: ['1', '2'] }, { ref: 'R2', at: [3, 1], pads: ['1', '2'] }, { ref: 'U1', at: [6, 1], pads: ['1', '2', '3'] },
  ]);

  it('a part is its reference and a pin is the reference plus the pin number, without any fallback', () => {
    const b = a(), index = noteKeyIndex(b);
    expect(index.target(idOf(b, 'U1'))).toEqual({ ok: true, key: { ref: 'U1' }, fallbacks: [] });
    expect(index.target(idOf(b, 'U1'), pinOf(b, 'U1', '2'))).toEqual({ ok: true, key: { ref: 'U1', pin: '2' }, fallbacks: [] });
    for (const component of b.components) expect(index.target(component.id)).toMatchObject({ ok: true, key: { ref: component.ref } });
  });

  it('resolves a key back to the same part and pin', () => {
    const b = a(), index = noteKeyIndex(b);
    for (const component of b.components) {
      const found = index.resolve({ ref: component.ref });
      expect(found).toMatchObject({ ok: true, pins: [] });
      expect(found.ok && found.component.id).toBe(component.id);
      for (const id of component.pinIds) {
        const pin = b.pins.find(candidate => candidate.id === id)!;
        const pad = index.resolve({ ref: component.ref, pin: pin.number });
        expect(pad.ok && pad.pins.map(item => item.id)).toEqual([id]);
      }
    }
  });

  it('a board parsed with one component omitted keeps every other note on the same reference and pin (the positional ids all move)', () => {
    const full = a();
    // A parser fix drops R1: every id after it moves (R2 was part:1 and is now part:0, U1 was part:2 and is part:1, the pads renumber).
    const without = board([{ ref: 'R2', at: [3, 1], pads: ['1', '2'] }, { ref: 'U1', at: [6, 1], pads: ['1', '2', '3'] }]);
    expect(idOf(full, 'U1')).toBe('part:2');
    expect(idOf(without, 'U1')).toBe('part:1');
    expect(pinOf(full, 'U1', '3')).not.toBe(pinOf(without, 'U1', '3'));
    const stored: KeyedNote[] = [];
    for (const ref of ['R1', 'R2', 'U1']) {
      const result = noteKeyIndex(full).target(idOf(full, ref));
      if (result.ok) stored.push(keyed(`part-${ref}`, result.key, `about ${ref}`));
    }
    for (const [ref, number] of [['R2', '2'], ['U1', '1'], ['U1', '3']]) {
      const result = noteKeyIndex(full).target(idOf(full, ref), pinOf(full, ref, number));
      if (result.ok) stored.push(keyed(`pin-${ref}-${number}`, result.key, `about ${ref} ${number}`));
    }
    const after = noteKeyIndex(without);
    for (const note of stored) {
      const found = after.resolve(note.target);
      const { ref, pin } = note.target;
      if (ref === 'R1') { expect(found, note.id).toEqual({ ok: false, problem: 'component-missing' }); continue; }
      expect(found.ok, note.id).toBe(true);
      if (!found.ok) continue;
      expect(found.component.ref, note.id).toBe(ref);
      if (pin !== undefined) expect(found.pins.map(item => item.number), note.id).toEqual([pin]);
    }
    // The note on the omitted part is not re-targeted: it is listed as unresolved with its text.
    const lost = unresolvedNotes(without, stored);
    expect(lost.map(item => [item.note.id, item.problem])).toEqual([['part-R1', 'component-missing']]);
    expect(lost[0].note.text).toBe('about R1');
    // The same notes found through the positional ids of the full board point at other parts on the reduced one.
    const positional = full.components.map(component => component.id).map(id => without.components.find(component => component.id === id)?.ref);
    expect(positional).toEqual(['R2', 'U1', undefined]);
  });

  it('reordering the components changes no key and no resolution', () => {
    const full = a();
    const reordered = board([{ ref: 'U1', at: [6, 1], pads: ['3', '1', '2'] }, { ref: 'R2', at: [3, 1], pads: ['2', '1'] }, { ref: 'R1', at: [1, 1], pads: ['1', '2'] }]);
    for (const [ref, number] of [['R1', undefined], ['U1', '2'], ['R2', '1']] as const) {
      const before = noteKeyIndex(full).target(idOf(full, ref), number === undefined ? undefined : pinOf(full, ref, number));
      const now = noteKeyIndex(reordered).target(idOf(reordered, ref), number === undefined ? undefined : pinOf(reordered, ref, number));
      expect(now).toEqual(before);
    }
  });

  it('case is kept (R1 and r1 are two parts) and names are NFKC-normalized', () => {
    const b = board([{ ref: 'R1', at: [1, 1], pads: ['1'] }, { ref: 'r1', at: [2, 1], pads: ['1'] }, { ref: 'Ｕ１', at: [3, 1], pads: ['Ａ１'] }]);
    const index = noteKeyIndex(b);
    expect(index.target(idOf(b, 'R1'))).toMatchObject({ key: { ref: 'R1' } });
    expect(index.target(idOf(b, 'r1'))).toMatchObject({ key: { ref: 'r1' } });
    expect(index.target(idOf(b, 'Ｕ１'), pinOf(b, 'Ｕ１', 'Ａ１'))).toMatchObject({ ok: true, key: { ref: 'U1', pin: 'A1' } });
    expect(index.resolve({ ref: 'u1' })).toEqual({ ok: false, problem: 'component-missing' });
  });

  it('pads that share a pin number are one pin: the note belongs to the number, whichever pad was selected', () => {
    const b = board([{ ref: 'U2', at: [1, 1], pads: [{ number: '9', at: [0, 0] }, { number: '9', at: [4, 4] }, { number: '1', at: [2, 2] }] }]);
    const index = noteKeyIndex(b);
    const first = index.target('part:0', 'pin:0'), second = index.target('part:0', 'pin:1');
    expect(first).toEqual({ ok: true, key: { ref: 'U2', pin: '9' }, fallbacks: [] });
    expect(second).toEqual(first);
    const found = index.resolve({ ref: 'U2', pin: '9' });
    expect(found.ok && found.pins.map(pin => pin.id)).toEqual(['pin:0', 'pin:1']);
    const note = keyed('n', { ref: 'U2', pin: '9' });
    expect(noteForSubject(b, [note], { componentId: 'part:0', pinId: 'pin:1' })).toBe(note);
    expect(noteForSubject(b, [note], { componentId: 'part:0', pinId: 'pin:2' })).toBeUndefined();
  });

  it('a pin of another part, an unknown pin and an unknown part are refused, never guessed', () => {
    const b = a(), index = noteKeyIndex(b);
    expect(index.target('part:99')).toEqual({ ok: false, reason: 'unknown-component' });
    expect(index.target(idOf(b, 'U1'), 'pin:999')).toEqual({ ok: false, reason: 'unknown-pin' });
    expect(index.target(idOf(b, 'U1'), pinOf(b, 'R1', '1'))).toEqual({ ok: false, reason: 'unknown-pin' });
  });

  it('a pin that is missing from the part, or that the part does not list, has no key', () => {
    const b = a();
    b.components[2].pinIds = b.components[2].pinIds.slice(1);
    expect(noteKeyIndex(b).target(idOf(b, 'U1'), pinOf(b, 'U1', '1'))).toEqual({ ok: false, reason: 'unknown-pin' });
    expect(noteKeyIndex(b).resolve({ ref: 'U1', pin: '1' })).toEqual({ ok: false, problem: 'pin-missing' });
  });

  it('is built once per board object', () => {
    const b = a();
    expect(noteKeyIndex(b)).toBe(noteKeyIndex(b));
    expect(noteKeyIndex(a())).not.toBe(noteKeyIndex(b));
  });
});

describe('duplicate references (explicit, visible fallback; never a guess)', () => {
  const dup = () => board([
    { ref: 'R1', at: [1, 1], pads: ['1', '2'] }, { ref: 'R1', at: [5, 1], pads: ['1', '2'] }, { ref: 'R1', at: [5, 1], side: 'bottom', pads: ['1', '2'] }, { ref: 'U1', at: [9, 1], pads: ['1'] },
  ]);

  it('each part that shares a reference is keyed by reference plus its position, and says so', () => {
    const b = dup(), index = noteKeyIndex(b);
    expect(index.target(idOf(b, 'R1', 0))).toEqual({ ok: true, key: { ref: 'R1', at: { side: 'top', x: 1, y: 1 } }, fallbacks: ['duplicate-reference'] });
    expect(index.target(idOf(b, 'R1', 1))).toEqual({ ok: true, key: { ref: 'R1', at: { side: 'top', x: 5, y: 1 } }, fallbacks: ['duplicate-reference'] });
    expect(index.target(idOf(b, 'R1', 2))).toEqual({ ok: true, key: { ref: 'R1', at: { side: 'bottom', x: 5, y: 1 } }, fallbacks: ['duplicate-reference'] });
    expect(index.target(idOf(b, 'R1', 0), pinOf(b, 'R1', '2', 0, 0))).toEqual({ ok: true, key: { ref: 'R1', at: { side: 'top', x: 1, y: 1 }, pin: '2' }, fallbacks: ['duplicate-reference'] });
    expect(index.target(idOf(b, 'U1'))).toEqual({ ok: true, key: { ref: 'U1' }, fallbacks: [] });
  });

  it('every anchored key resolves to exactly its own part and pin', () => {
    const b = dup(), index = noteKeyIndex(b);
    for (const nth of [0, 1, 2]) {
      const target = index.target(idOf(b, 'R1', nth), pinOf(b, 'R1', '2', 0, nth));
      expect(target.ok).toBe(true);
      if (!target.ok) continue;
      const found = index.resolve(target.key);
      expect(found.ok && found.component.id).toBe(idOf(b, 'R1', nth));
      expect(found.ok && found.pins.map(pin => pin.id)).toEqual([pinOf(b, 'R1', '2', 0, nth)]);
    }
  });

  it('the plain reference does not pick one of several: it is ambiguous, and its note is listed as unresolved', () => {
    const b = dup();
    expect(noteKeyIndex(b).resolve({ ref: 'R1' })).toEqual({ ok: false, problem: 'component-ambiguous' });
    const note = keyed('older', { ref: 'R1' }, 'written when R1 was unique');
    expect(unresolvedNotes(b, [note])).toEqual([{ note, problem: 'component-ambiguous' }]);
    expect(noteForSubject(b, [note], { componentId: idOf(b, 'R1', 0) })).toBeUndefined();
    expect(annotatedComponentIds(b, [note]).size).toBe(0);
  });

  it('an anchored note stays on its part when another part of the same name disappears, and is unresolved when its own part moved', () => {
    const b = dup(), index = noteKeyIndex(b);
    const target = index.target(idOf(b, 'R1', 1));
    if (!target.ok) throw new Error('no target');
    const alone = board([{ ref: 'R1', at: [5, 1], pads: ['1', '2'] }, { ref: 'U1', at: [9, 1], pads: ['1'] }]);
    const found = noteKeyIndex(alone).resolve(target.key);
    expect(found.ok && found.component.ref).toBe('R1');
    const moved = board([{ ref: 'R1', at: [1, 1], pads: ['1'] }, { ref: 'R1', at: [5.01, 1], pads: ['1'] }]);
    expect(noteKeyIndex(moved).resolve(target.key)).toEqual({ ok: false, problem: 'component-missing' });
    const sameSpot = board([{ ref: 'R1', at: [5.0004, 1], pads: ['1'] }, { ref: 'R1', at: [7, 1], pads: ['1'] }]);
    expect(noteKeyIndex(sameSpot).resolve(target.key).ok).toBe(true);
  });

  it('two parts with the same reference at exactly the same place cannot be told apart: no note can be made for either', () => {
    const b = board([{ ref: 'TP', at: [2, 2], pads: ['1'] }, { ref: 'TP', at: [2, 2], pads: ['1'] }, { ref: 'TP', at: [2, 2], side: 'bottom', pads: ['1'] }]);
    const index = noteKeyIndex(b);
    expect(index.target('part:0')).toEqual({ ok: false, reason: 'part-indistinguishable' });
    expect(index.target('part:1', 'pin:1')).toEqual({ ok: false, reason: 'part-indistinguishable' });
    expect(index.target('part:2')).toMatchObject({ ok: true, key: { ref: 'TP', at: { side: 'bottom', x: 2, y: 2 } } });
    expect(index.resolve({ ref: 'TP', at: { side: 'top', x: 2, y: 2 } })).toEqual({ ok: false, problem: 'component-ambiguous' });
  });
});

describe('parts without a usable reference', () => {
  it('a part whose reference the importer made up is keyed by position only; the made-up name is never an identity', () => {
    const b = board([{ ref: '#1', at: [1, 1], generated: true, pads: ['1'] }, { ref: '#1', at: [4, 1], pads: ['1'] }, { ref: 'FP3', at: [8, 1], generated: true, pads: ['1'] }]);
    const index = noteKeyIndex(b);
    expect(index.target('part:0')).toEqual({ ok: true, key: { at: { side: 'top', x: 1, y: 1 } }, fallbacks: ['unnamed-part'] });
    expect(index.target('part:2', 'pin:2')).toEqual({ ok: true, key: { at: { side: 'top', x: 8, y: 1 }, pin: '1' }, fallbacks: ['unnamed-part'] });
    // the part that really is named "#1" is the only one the reference "#1" designates
    expect(index.target('part:1')).toEqual({ ok: true, key: { ref: '#1' }, fallbacks: [] });
    const found = index.resolve({ ref: '#1' });
    expect(found.ok && found.component.id).toBe('part:1');
    const placed = index.resolve({ at: { side: 'top', x: 1, y: 1 } });
    expect(placed.ok && placed.component.id).toBe('part:0');
    expect(index.resolve({ ref: 'FP3' })).toEqual({ ok: false, problem: 'component-missing' });
  });

  it('an empty, blank or over-long reference is treated as no reference', () => {
    const b = board([{ ref: '', at: [1, 1] }, { ref: '   ', at: [2, 1] }, { ref: 'x'.repeat(257), at: [3, 1] }, { ref: 'x'.repeat(256), at: [4, 1] }]);
    const index = noteKeyIndex(b);
    for (const id of ['part:0', 'part:1', 'part:2']) expect(index.target(id), id).toMatchObject({ ok: true, fallbacks: ['unnamed-part'] });
    expect(index.target('part:3')).toEqual({ ok: true, key: { ref: 'x'.repeat(256) }, fallbacks: [] });
  });

  it('two unnamed parts at the same place are refused; on different sides they are told apart', () => {
    const b = board([{ ref: '', at: [1, 1] }, { ref: '', at: [1, 1] }, { ref: '', at: [1, 1], side: 'bottom' }]);
    const index = noteKeyIndex(b);
    expect(index.target('part:0')).toEqual({ ok: false, reason: 'part-indistinguishable' });
    expect(index.target('part:2')).toMatchObject({ ok: true, key: { at: { side: 'bottom' } } });
    expect(index.resolve({ at: { side: 'top', x: 1, y: 1 } })).toEqual({ ok: false, problem: 'component-ambiguous' });
  });
});

describe('pads without a number', () => {
  it('a pad whose number the importer made up, or that has none, is keyed by position and says so', () => {
    const b = board([{ ref: 'J1', at: [0, 0], pads: [{ number: '1' }, { number: '~1', at: [5, 5], generated: true }, { number: '', at: [7, 7] }, { number: '  ', at: [8, 8] }] }]);
    const index = noteKeyIndex(b);
    expect(index.target('part:0', 'pin:0')).toEqual({ ok: true, key: { ref: 'J1', pin: '1' }, fallbacks: [] });
    expect(index.target('part:0', 'pin:1')).toEqual({ ok: true, key: { ref: 'J1', pinAt: { side: 'top', x: 5, y: 5 } }, fallbacks: ['unnamed-pin'] });
    expect(index.target('part:0', 'pin:2')).toMatchObject({ ok: true, key: { ref: 'J1', pinAt: { x: 7, y: 7 } }, fallbacks: ['unnamed-pin'] });
    expect(index.target('part:0', 'pin:3')).toMatchObject({ ok: true, key: { pinAt: { x: 8, y: 8 } }, fallbacks: ['unnamed-pin'] });
    const found = index.resolve({ ref: 'J1', pinAt: { side: 'top', x: 5, y: 5 } });
    expect(found.ok && found.pins.map(pin => pin.id)).toEqual(['pin:1']);
    // the made-up number is not an identity: "~1" designates nothing
    expect(index.resolve({ ref: 'J1', pin: '~1' })).toEqual({ ok: false, problem: 'pin-missing' });
    expect(index.resolve({ ref: 'J1', pinAt: { side: 'top', x: 99, y: 5 } })).toEqual({ ok: false, problem: 'pin-missing' });
  });

  it('two unnumbered pads at the same place cannot be told apart', () => {
    const b = board([{ ref: 'J1', at: [0, 0], pads: [{ number: '', at: [5, 5] }, { number: '', at: [5, 5] }, { number: '', at: [5, 5], side: 'bottom' }] }]);
    const index = noteKeyIndex(b);
    expect(index.target('part:0', 'pin:0')).toEqual({ ok: false, reason: 'pin-indistinguishable' });
    expect(index.target('part:0', 'pin:2')).toMatchObject({ ok: true, key: { pinAt: { side: 'bottom' } } });
    expect(index.resolve({ ref: 'J1', pinAt: { side: 'top', x: 5, y: 5 } })).toEqual({ ok: false, problem: 'pin-ambiguous' });
  });

  it('a duplicate-reference part with an unnumbered pad carries both fallbacks', () => {
    const b = board([{ ref: 'J1', at: [0, 0], pads: [{ number: '', at: [1, 1] }] }, { ref: 'J1', at: [9, 0], pads: [{ number: '', at: [10, 1] }] }]);
    expect(noteKeyIndex(b).target('part:1', 'pin:1')).toEqual({
      ok: true, key: { ref: 'J1', at: { side: 'top', x: 9, y: 0 }, pinAt: { side: 'top', x: 10, y: 1 } }, fallbacks: ['duplicate-reference', 'unnamed-pin'],
    });
  });
});

describe('looking notes up on a board', () => {
  const b = board([{ ref: 'R1', at: [1, 1], pads: ['1', '2'] }, { ref: 'U1', at: [4, 1], pads: ['1', '2'] }, { ref: 'R1', at: [8, 1], pads: ['1'] }]);

  it('noteForSubject finds the note of exactly that part or pin', () => {
    const partNote = keyed('p', { ref: 'U1' }), pinNote = keyed('q', { ref: 'U1', pin: '2' }), otherR1 = keyed('r', { ref: 'R1', at: { side: 'top', x: 8, y: 1 } });
    const notes: BoardNote[] = [partNote, pinNote, otherR1, legacy('old', 'part:1')];
    expect(noteForSubject(b, notes, { componentId: 'part:1' })).toBe(partNote);
    expect(noteForSubject(b, notes, { componentId: 'part:1', pinId: pinOf(b, 'U1', '2') })).toBe(pinNote);
    expect(noteForSubject(b, notes, { componentId: 'part:1', pinId: pinOf(b, 'U1', '1') })).toBeUndefined();
    expect(noteForSubject(b, notes, { componentId: 'part:2' })).toBe(otherR1);
    expect(noteForSubject(b, notes, { componentId: 'part:0' })).toBeUndefined();
    expect(noteForSubject(b, [], { componentId: 'part:1' })).toBeUndefined();
    expect(noteForSubject(null, notes, { componentId: 'part:1' })).toBeUndefined();
    expect(noteForSubject(b, notes, { componentId: 'nope' })).toBeUndefined();
  });

  it('annotatedComponentIds marks the part of a part note and of a pin note, and nothing for unresolved notes', () => {
    const notes: BoardNote[] = [keyed('p', { ref: 'U1', pin: '1' }), keyed('q', { ref: 'R1', at: { side: 'top', x: 8, y: 1 } }), keyed('lost', { ref: 'C9' }), legacy('old', 'part:0')];
    expect([...annotatedComponentIds(b, notes)].sort()).toEqual(['part:1', 'part:2']);
    expect(annotatedComponentIds(null, notes).size).toBe(0);
    expect(annotatedComponentIds(b, []).size).toBe(0);
  });

  it('unresolvedNotes lists positional leftovers and keyed notes the board no longer has, with the reason, in list order', () => {
    const marked = legacy('old1', 'part:77', undefined, { unresolved: { reason: 'legacy-id-missing', at: T0 } });
    const clash = legacy('old2', 'part:1', 'pin:3', { unresolved: { reason: 'duplicate-target', at: T0 } });
    const notes: BoardNote[] = [
      keyed('ok', { ref: 'U1' }), marked, keyed('gone', { ref: 'C9' }), keyed('amb', { ref: 'R1' }), clash, keyed('nopin', { ref: 'U1', pin: '9' }),
      keyed('padamb', { ref: 'U1', pinAt: { side: 'top', x: 0, y: 0 } }), legacy('pending', 'part:1'),
    ];
    expect(unresolvedNotes(b, notes).map(item => [item.note.id, item.problem])).toEqual([
      ['old1', 'legacy-id-missing'], ['gone', 'component-missing'], ['amb', 'component-ambiguous'], ['old2', 'duplicate-target'], ['nopin', 'pin-missing'], ['padamb', 'pin-missing'], ['pending', 'legacy-id-missing'],
    ]);
    expect(unresolvedNotes(null, notes).map(item => item.note.id)).toEqual(['old1', 'old2', 'pending']);
    expect(unresolvedNotes(b, [])).toEqual([]);
  });

  it('assertStorable lets keyed notes and notes marked unresolved through, and names the first positional note that was not converted', () => {
    const marked = legacy('m', 'part:1', undefined, { unresolved: { reason: 'pin-missing', at: T0 } });
    expect(() => assertStorable([])).not.toThrow();
    expect(() => assertStorable([keyed('k', { ref: 'U1' }), marked])).not.toThrow();
    expect(() => assertStorable([keyed('k', { ref: 'U1' }), legacy('pending', 'part:1'), legacy('later', 'part:2')])).toThrow('Note pending still names a positional id');
  });

  it('isKeyedNote and isPendingLegacyNote tell the three states of a stored note apart', () => {
    const marked = legacy('m', 'part:1', undefined, { unresolved: { reason: 'pin-missing', at: T0 } });
    expect([keyed('k', { ref: 'U1' }), legacy('l', 'part:1'), marked].map(note => [isKeyedNote(note), isPendingLegacyNote(note)])).toEqual([[true, false], [false, true], [false, false]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Migration of positional notes
// ---------------------------------------------------------------------------------------------------------------

describe('migrating positional notes', () => {
  const b = () => board([
    { ref: 'R1', at: [1, 1], pads: ['1', '2'] }, { ref: 'U1', at: [4, 1], pads: ['1', '2', '3'] }, { ref: 'D1', at: [8, 1], pads: [{ number: '', at: [9, 9] }, { number: '1', at: [9, 10] }] },
    { ref: 'J1', at: [0, 5], pads: [{ number: '7', at: [0, 6] }, { number: '7', at: [0, 7] }] }, { ref: 'TP', at: [3, 3] }, { ref: 'TP', at: [3, 3] }, { ref: '', at: [6, 6], pads: ['1'] },
  ]);

  it('turns each positional id into the key of the part or pin the id names on this board, keeping id, text, measurements and time', () => {
    const board1 = b();
    const notes: BoardNote[] = [
      legacy('a', 'part:1'), legacy('b', 'part:1', pinOf(board1, 'U1', '3'), { measurements: { voltage: '1.8 V', other: 'hot' }, text: 'low', updatedAt: T1 }),
      legacy('c', 'part:0', pinOf(board1, 'R1', '2')), legacy('d', 'part:2', 'pin:5'), legacy('e', 'part:6'),
    ];
    const result = migrateNotes(board1, notes, T1);
    expect(result).toMatchObject({ changed: true, migrated: 5, unresolved: 0 });
    expect(result.notes).toEqual([
      { id: 'a', target: { ref: 'U1' }, text: 'note a', updatedAt: T0 },
      { id: 'b', target: { ref: 'U1', pin: '3' }, text: 'low', measurements: { voltage: '1.8 V', other: 'hot' }, updatedAt: T1 },
      { id: 'c', target: { ref: 'R1', pin: '2' }, text: 'note c', updatedAt: T0 },
      { id: 'd', target: { ref: 'D1', pinAt: { side: 'top', x: 9, y: 9 } }, text: 'note d', updatedAt: T0 },
      { id: 'e', target: { at: { side: 'top', x: 6, y: 6 } }, text: 'note e', updatedAt: T0 },
    ]);
    expect(result.notes.every(isKeyedNote)).toBe(true);
    expect(JSON.stringify(result.notes)).not.toMatch(/part:|pin:/);
  });

  it('is idempotent: a second run changes nothing, and the same input always gives the same result', () => {
    const board1 = b();
    const notes: BoardNote[] = [legacy('a', 'part:1'), legacy('b', 'part:99'), legacy('c', 'part:0', pinOf(board1, 'R1', '1')), keyed('k', { ref: 'D1' })];
    const first = migrateNotes(board1, notes, T1);
    expect(first.changed).toBe(true);
    const second = migrateNotes(board1, first.notes, '2030-01-01T00:00:00.000Z');
    expect(second).toEqual({ notes: first.notes, changed: false, migrated: 0, unresolved: 0 });
    expect(second.notes).toBe(first.notes);
    expect(migrateNotes(board1, notes, T1)).toEqual(first);
    // after the round trip through the store the second run is still a no-op
    const stored = validateNotes(JSON.parse(JSON.stringify(first.notes)));
    expect(stored).toEqual(first.notes);
    expect(migrateNotes(board1, stored, T1).changed).toBe(false);
    // a list with nothing to migrate comes back as the very same array
    const plain = [keyed('k', { ref: 'D1' })];
    expect(migrateNotes(board1, plain, T1).notes).toBe(plain);
    expect(migrateNotes(board1, [], T1).notes).toEqual([]);
  });

  it('records what cannot be resolved instead of dropping or guessing it', () => {
    const board1 = b();
    const notes: BoardNote[] = [
      legacy('gone', 'part:42', undefined, { text: 'about a part that is no longer there' }),
      legacy('nopin', 'part:1', 'pin:999'),
      legacy('wrongpart', 'part:0', pinOf(board1, 'U1', '1')),
      legacy('same-spot', 'part:4'),
      legacy('ok', 'part:1'),
    ];
    const result = migrateNotes(board1, notes, T1);
    expect(result).toMatchObject({ changed: true, migrated: 1, unresolved: 4 });
    expect(result.notes).toHaveLength(notes.length);
    expect(result.notes.map(note => note.id)).toEqual(notes.map(note => note.id));
    expect(result.notes.map(note => note.text)).toEqual(notes.map(note => note.text));
    const marks = Object.fromEntries(result.notes.filter((note): note is LegacyNote => !isKeyedNote(note)).map(note => [note.id, [note.componentId, note.pinId, note.unresolved]]));
    expect(marks).toEqual({
      gone: ['part:42', undefined, { reason: 'legacy-id-missing', at: T1 }],
      nopin: ['part:1', 'pin:999', { reason: 'legacy-id-missing', at: T1 }],
      wrongpart: ['part:0', pinOf(board1, 'U1', '1'), { reason: 'legacy-id-missing', at: T1 }],
      'same-spot': ['part:4', undefined, { reason: 'legacy-indistinguishable', at: T1 }],
    });
    expect(unresolvedNotes(board1, result.notes).map(item => [item.note.id, item.problem])).toEqual([
      ['gone', 'legacy-id-missing'], ['nopin', 'legacy-id-missing'], ['wrongpart', 'legacy-id-missing'], ['same-spot', 'legacy-indistinguishable'],
    ]);
    expect(validateNotes(JSON.parse(JSON.stringify(result.notes)))).toEqual(result.notes);
  });

  it('two positional notes that map to one key: the first keeps it, the other stays as it was, marked, with its text', () => {
    const board1 = b();
    const notes: BoardNote[] = [legacy('first', 'part:3', pinOf(board1, 'J1', '7', 0), { text: 'pad A' }), legacy('second', 'part:3', pinOf(board1, 'J1', '7', 1), { text: 'pad B' })];
    const result = migrateNotes(board1, notes, T1);
    expect(result).toMatchObject({ migrated: 1, unresolved: 1 });
    expect(result.notes[0]).toEqual({ id: 'first', target: { ref: 'J1', pin: '7' }, text: 'pad A', updatedAt: T0 });
    expect(result.notes[1]).toEqual({ ...notes[1], unresolved: { reason: 'duplicate-target', at: T1 } });
    // an already keyed note on that target wins, whatever the order
    const existing = migrateNotes(board1, [legacy('late', 'part:3', pinOf(board1, 'J1', '7', 1)), keyed('kept', { ref: 'J1', pin: '7' })], T1);
    expect(existing.notes[0]).toMatchObject({ id: 'late', unresolved: { reason: 'duplicate-target' } });
    expect(existing.notes[1]).toEqual(keyed('kept', { ref: 'J1', pin: '7' }));
  });

  it('an unresolved note is frozen: a later board in which its id exists does not resolve it (a positional id means nothing against another parse)', () => {
    const before = b();
    const marked = migrateNotes(before, [legacy('x', 'part:42')], T0).notes;
    expect(marked[0]).toMatchObject({ unresolved: { reason: 'legacy-id-missing' } });
    const later = board(Array.from({ length: 50 }, (_, i) => ({ ref: `Q${i}`, at: [i, 0] as [number, number], pads: ['1'] })));
    expect(later.components.some(component => component.id === 'part:42')).toBe(true);
    const again = migrateNotes(later, marked, T1);
    expect(again.changed).toBe(false);
    expect(again.notes).toBe(marked);
    expect(unresolvedNotes(later, marked).map(item => item.note.id)).toEqual(['x']);
  });

  it('the migrated notes work with the note helpers: found by the part, edited in place, removed on request', () => {
    const board1 = b();
    const migrated = migrateNotes(board1, [legacy('a', 'part:1'), legacy('b', 'part:1', pinOf(board1, 'U1', '2'))], T1).notes;
    const target = noteTarget({ ref: 'U1' });
    expect(noteFor(migrated, target)!.id).toBe('a');
    const edited = upsertNote(migrated, target, { text: 'edited' }, T1, () => 'unused');
    expect(edited.map(note => [note.id, note.text])).toEqual([['a', 'edited'], ['b', 'note b']]);
    expect(noteForSubject(board1, edited, { componentId: 'part:1', pinId: pinOf(board1, 'U1', '2') })!.id).toBe('b');
  });
});
