import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertStorable, isKeyedNote, noteForSubject, noteKeyIndex, unresolvedNotes } from '../lib/note-keys';
import type { Board, BoardNote, KeyedNote, LegacyNote } from '../lib/types';
import { validateNotes } from '../lib/workspace';
import { createHarness, enc, hexKey, makeBoard, openNative } from './testing';
import type { Harness } from './testing';

const NOW = '2026-10-05T10:00:00.000Z';
const OLD = '2026-09-01T08:00:00.000Z';
const legacy = (id: string, componentId: string, pinId?: string, extra: Partial<LegacyNote> = {}): LegacyNote => ({ id, componentId, ...(pinId === undefined ? {} : { pinId }), text: `note ${id}`, updatedAt: OLD, ...extra });
const saves = (h: Harness) => h.desktop.log.filter(line => line.startsWith('saveNotes'));
const stored = (h: Harness, key = 1) => h.desktop.notes.get(hexKey(key)) ?? [];
const file = (name: string, bytes: Uint8Array) => new File([bytes as BlobPart], name);

// The harness board "divider": components r1, r2, u1 (references R1, R2, U1); pins r1.1.0 r1.2.1 / r2.1.2 r2.2.3 / u1.1.4 u1.2.5.

describe('opening a board converts positional notes once', () => {
  it('keeps old component and pin notes unresolved for an unsafe positional reader result, with an idempotent saved round trip', async () => {
    const h = createHarness();
    const board = makeBoard('short-header.bdv', [{ ref: 'U1', id: 'part:0', pins: [['1', 'N1']] }, { ref: 'U2', id: 'part:1', pins: [['1', 'N2']] }]);
    board.format = 'Honhan BDV'; board.legacyPositionalNotesUnsafe = true;
    const original = [
      legacy('part-note', 'part:0', undefined, { text: 'note about U2', measurements: { voltage: '1.8 V' } }),
      legacy('pin-note', 'part:0', 'pin:0', { text: 'U2 pin note', measurements: { resistance: '0.4 Ω' } }),
      { id: 'keyed', target: { ref: 'U2' }, text: 'stable identity', updatedAt: OLD } as KeyedNote,
    ];
    h.desktop.notes.set(hexKey(1), structuredClone(original));
    const payload = await openNative(h, 'short-header.bdv', 1, board);
    const expected = [
      { ...original[0], unresolved: { reason: 'legacy-order-unknown', at: NOW } },
      { ...original[1], unresolved: { reason: 'legacy-order-unknown', at: NOW } },
      original[2],
    ];
    expect(h.state().notes).toEqual(expected);
    expect(stored(h)).toEqual(expected);
    expect(saves(h)).toHaveLength(1);
    await h.controller.actions.openRecent(payload.path);
    await h.controller.idle();
    expect(h.state().notes).toEqual(expected);
    expect(saves(h)).toHaveLength(1);
  });

  it('leaves the original positional file untouched when saving unsafe notes fails', async () => {
    const h = createHarness();
    const board = makeBoard('short-header.bdv', [{ ref: 'U1', id: 'part:0', pins: [['1', 'N1']] }, { ref: 'U2', id: 'part:1', pins: [['1', 'N2']] }]);
    board.format = 'Honhan BDV'; board.legacyPositionalNotesUnsafe = true;
    const original = [legacy('part-note', 'part:0', undefined, { text: 'note about U2', measurements: { voltage: '1.8 V' } }), legacy('pin-note', 'part:0', 'pin:0', { text: 'U2 pin note', measurements: { resistance: '0.4 Ω' } })];
    h.desktop.notes.set(hexKey(1), structuredClone(original));
    h.desktop.failures.saveNotes = () => new Error("Error invoking remote method 'trace:save-notes': Error: [STORE_WRITE_FAILED] Disk full.");
    await openNative(h, 'short-header.bdv', 1, board);
    expect(h.state().notes.map(note => (note as LegacyNote).unresolved?.reason)).toEqual(['legacy-order-unknown', 'legacy-order-unknown']);
    expect(stored(h)).toEqual(original);
  });

  it('turns resolvable notes into keyed notes, writes them back, and keeps what could not be placed, marked and listed', async () => {
    const h = createHarness();
    h.desktop.notes.set(hexKey(1), [
      legacy('n1', 'r1'), legacy('n2', 'r1', 'r1.2.1', { measurements: { voltage: '1.8 V' }, text: 'low' }), legacy('n3', 'ghost', undefined, { text: 'about a part that is gone' }), legacy('n4', 'u1', 'pin:nope'),
    ]);
    await openNative(h, 'a.cad', 1);
    const notes = h.state().notes;
    expect(notes).toEqual([
      { id: 'n1', target: { ref: 'R1' }, text: 'note n1', updatedAt: OLD },
      { id: 'n2', target: { ref: 'R1', pin: '2' }, text: 'low', measurements: { voltage: '1.8 V' }, updatedAt: OLD },
      { ...legacy('n3', 'ghost', undefined, { text: 'about a part that is gone' }), unresolved: { reason: 'legacy-id-missing', at: NOW } },
      { ...legacy('n4', 'u1', 'pin:nope'), unresolved: { reason: 'legacy-id-missing', at: NOW } },
    ]);
    expect(stored(h)).toEqual(notes);
    expect(saves(h)).toHaveLength(1);
    expect(h.state().notesBlocked).toBeNull();
    expect(h.messages()).toEqual(['toast.loaded', 'toast.notesUnresolved']);
    expect(unresolvedNotes(h.state().board, notes).map(item => [item.note.id, item.problem])).toEqual([['n3', 'legacy-id-missing'], ['n4', 'legacy-id-missing']]);
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error', message: { key: 'toast.notesUnresolved' } });
  });

  it('is idempotent: opening the board again writes nothing, changes nothing and still lists what is unresolved', async () => {
    const h = createHarness();
    h.desktop.notes.set(hexKey(1), [legacy('n1', 'r2'), legacy('n3', 'ghost')]);
    const payload = await openNative(h, 'a.cad', 1);
    const first = h.state().notes;
    const written = structuredClone(stored(h));
    await h.controller.actions.openRecent(payload.path);
    await h.controller.idle();
    expect(saves(h)).toHaveLength(1);
    expect(stored(h)).toEqual(written);
    expect(h.state().notes).toEqual(first);
    expect(h.messages().filter(message => message === 'toast.notesUnresolved')).toHaveLength(2);
  });

  it('says nothing about notes when every one of them found its part', async () => {
    const h = createHarness();
    h.desktop.notes.set(hexKey(1), [legacy('n1', 'r1'), legacy('n2', 'u1', 'u1.2.5')]);
    await openNative(h, 'a.cad', 1);
    expect(h.state().notes.every(isKeyedNote)).toBe(true);
    expect(h.messages()).toEqual(['toast.loaded']);
    expect(saves(h)).toHaveLength(1);
  });

  it('writes nothing for a board without notes or with notes that are already keyed', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    expect(saves(h)).toEqual([]);
    h.desktop.notes.set(hexKey(2), [{ id: 'k', target: { ref: 'U1' }, text: 'keyed', updatedAt: OLD }]);
    await openNative(h, 'b.cad', 2);
    expect(saves(h)).toEqual([]);
    expect(h.state().notes).toHaveLength(1);
    expect(h.messages()).toEqual(['toast.loaded', 'toast.loaded']);
  });

  it('lists a keyed note whose part the board no longer has (a note is never silently moved or dropped)', async () => {
    const h = createHarness();
    h.desktop.notes.set(hexKey(1), [{ id: 'k1', target: { ref: 'U1', pin: '2' }, text: 'on U1', updatedAt: OLD }, { id: 'k2', target: { ref: 'C77' }, text: 'on a part this board lacks', updatedAt: OLD }]);
    await openNative(h, 'a.cad', 1);
    expect(unresolvedNotes(h.state().board, h.state().notes).map(item => [item.note.id, item.problem])).toEqual([['k2', 'component-missing']]);
    expect(h.messages()).toEqual(['toast.loaded', 'toast.notesUnresolved']);
    expect(saves(h)).toEqual([]);
    expect(stored(h)).toHaveLength(2);
  });

  it('a note store that cannot be read stays locked and untouched; retrying after the fix converts it', async () => {
    const h = createHarness();
    h.desktop.notes.set(hexKey(1), [legacy('n1', 'r1')]);
    h.desktop.failures.getNotes = () => new Error("Error invoking remote method 'trace:get-notes': Error: [NOTES_INVALID] The notes file is damaged.");
    await openNative(h, 'a.cad', 1);
    expect(h.state().notesBlocked).toEqual({ text: 'The notes file is damaged.' });
    expect(h.state().notes).toEqual([]);
    expect(saves(h)).toEqual([]);
    expect(stored(h)).toEqual([legacy('n1', 'r1')]);
    delete h.desktop.failures.getNotes;
    await h.controller.actions.retryNotes();
    expect(h.state().notesBlocked).toBeNull();
    expect(h.state().notes).toEqual([{ id: 'n1', target: { ref: 'R1' }, text: 'note n1', updatedAt: OLD }]);
    expect(stored(h)).toEqual(h.state().notes);
    expect(h.messages().at(-1)).toBe('toast.notesReloaded');
  });

  it('a damaged note file (a note that is neither kind) is rejected as a whole, as before', async () => {
    const h = createHarness();
    h.desktop.notes.set(hexKey(1), [{ id: 'bad', text: 'no target at all', updatedAt: OLD } as unknown as BoardNote]);
    await openNative(h, 'a.cad', 1);
    expect(h.state().notesBlocked).toEqual({ key: 'toast.notesUnreadable' });
    expect(saves(h)).toEqual([]);
    await h.controller.actions.upsertNote({ componentId: 'r1' }, { text: 'x' });
    expect(saves(h)).toEqual([]);
  });

  it('when the converted notes cannot be written they are still shown, the old file is kept and the next open tries again', async () => {
    const h = createHarness();
    const original = [legacy('n1', 'r1'), legacy('n2', 'u1', 'u1.1.4')];
    h.desktop.notes.set(hexKey(1), structuredClone(original));
    h.desktop.failures.saveNotes = () => new Error("Error invoking remote method 'trace:save-notes': Error: [STORE_WRITE_FAILED] Disk full.");
    const payload = await openNative(h, 'a.cad', 1);
    expect(h.state().notes.every(isKeyedNote)).toBe(true);
    expect(h.state().notesBlocked).toBeNull();
    expect(stored(h)).toEqual(original);
    expect(h.messages()).toEqual(['toast.loaded', 'toast.notesUpdateFailed']);
    delete h.desktop.failures.saveNotes;
    await h.controller.actions.openRecent(payload.path);
    await h.controller.idle();
    expect(stored(h)).toEqual(h.state().notes);
    expect(stored(h).every(isKeyedNote)).toBe(true);
  });

  it('a write refused because the application is quitting is not reported', async () => {
    const h = createHarness();
    h.desktop.notes.set(hexKey(1), [legacy('n1', 'r1')]);
    h.desktop.failures.saveNotes = () => new Error("Error invoking remote method 'trace:save-notes': Error: [STORE_CLOSING] The data store is shutting down.");
    await openNative(h, 'a.cad', 1);
    expect(h.messages()).toEqual(['toast.loaded']);
    expect(h.state().notes.every(isKeyedNote)).toBe(true);
  });

  it('the browser fallback converts the stored notes the same way', async () => {
    const h = createHarness({ browser: true });
    const bytes = enc('GENCAD a');
    const key = createHash('sha256').update(bytes).digest('hex');
    h.storage.set(`trace-notes-${key}`, JSON.stringify([legacy('n1', 'r1'), legacy('n2', 'gone')]));
    h.boardWorkers.replies['a.cad'] = makeBoard('a.cad', [{ ref: 'R1', id: 'r1', pins: [['1', 'N']] }]);
    await h.controller.actions.openDropped([file('a.cad', bytes)]);
    await h.controller.idle();
    expect(h.state().notes).toEqual([{ id: 'n1', target: { ref: 'R1' }, text: 'note n1', updatedAt: OLD }, { ...legacy('n2', 'gone'), unresolved: { reason: 'legacy-id-missing', at: NOW } }]);
    expect(JSON.parse(h.storage.get(`trace-notes-${key}`)!)).toEqual(h.state().notes);
  });
});

describe('a parser that no longer yields one component keeps every note on its own reference and pin', () => {
  it('notes follow the reference and the pin number when every positional id moves', async () => {
    const h = createHarness();
    const payload = await openNative(h, 'a.cad', 1);
    const first = h.state().board!;
    const u1 = first.components.find(c => c.ref === 'U1')!, r2 = first.components.find(c => c.ref === 'R2')!, r1 = first.components.find(c => c.ref === 'R1')!;
    const pinOf = (board: Board, ref: string, number: string) => board.pins.find(p => p.componentId === board.components.find(c => c.ref === ref)!.id && p.number === number)!.id;
    await h.controller.actions.upsertNote({ componentId: u1.id, pinId: pinOf(first, 'U1', '2') }, { text: 'U1 pin 2 is shorted' });
    await h.controller.actions.upsertNote({ componentId: r2.id }, { text: 'R2 is hot' });
    await h.controller.actions.upsertNote({ componentId: r1.id }, { text: 'R1 was replaced' });
    expect(stored(h).map(note => (note as KeyedNote).target)).toEqual([{ ref: 'U1', pin: '2' }, { ref: 'R2' }, { ref: 'R1' }]);
    // The same file, read by a parser that now omits R1: ids and pad ids are positional, so every one after R1 changes.
    h.boardWorkers.replies['a.cad'] = makeBoard('a.cad', [{ ref: 'R2', id: 'x0', pins: [['1', 'OUT'], ['2', 'GND']] }, { ref: 'U1', id: 'x1', pins: [['1', 'VCC'], ['2', 'GND']] }]);
    await h.controller.actions.openRecent(payload.path);
    await h.controller.idle();
    const second = h.state().board!;
    expect(second.components.map(c => c.id)).toEqual(['x0', 'x1']);
    expect(second.components.find(c => c.ref === 'U1')!.id).not.toBe(u1.id);
    // Every other note is on the same reference and pin as before ...
    expect(noteForSubject(second, h.state().notes, { componentId: 'x1', pinId: pinOf(second, 'U1', '2') })!.text).toBe('U1 pin 2 is shorted');
    expect(noteForSubject(second, h.state().notes, { componentId: 'x1', pinId: pinOf(second, 'U1', '1') })).toBeUndefined();
    expect(noteForSubject(second, h.state().notes, { componentId: 'x0' })!.text).toBe('R2 is hot');
    expect(noteForSubject(second, h.state().notes, { componentId: 'x1' })).toBeUndefined();
    // ... and the note of the omitted part is listed, with its text, instead of landing on a neighbour.
    expect(unresolvedNotes(second, h.state().notes).map(item => [item.note.text, item.problem])).toEqual([['R1 was replaced', 'component-missing']]);
    expect(stored(h)).toHaveLength(3);
    expect(h.messages().at(-1)).toBe('toast.notesUnresolved');
  });
});

describe('every note the application creates is keyed', () => {
  /** Unique, split-pad, duplicate-reference, unnamed, unnumbered and indistinguishable cases on one board (positional ids throughout). */
  function awkward(): Board {
    const board = makeBoard('awkward.cad', [
      { ref: 'R1', id: 'p0', pins: [['1', 'A'], ['2', 'B']] }, { ref: 'D1', id: 'p1', pins: [['1', 'A'], ['1', 'B']] },
      { ref: 'C5', id: 'p2', pins: [['1', 'A']] }, { ref: 'C5', id: 'p3', pins: [['1', 'A']] }, { ref: '', id: 'p4', pins: [['1', 'A']] },
      { ref: 'J1', id: 'p5', pins: [['', 'A'], ['', 'B'], ['', 'C']] }, { ref: 'TP', id: 'p6', pins: [] }, { ref: 'TP', id: 'p7', pins: [] },
    ]);
    board.components.find(c => c.id === 'p7')!.position = { ...board.components.find(c => c.id === 'p6')!.position };
    board.components.find(c => c.id === 'p4')!.refGenerated = true;
    const j1 = board.components.find(c => c.id === 'p5')!;
    const pads = j1.pinIds.map(id => board.pins.find(p => p.id === id)!);
    pads[0].x = 50; pads[1].x = 51; pads[2].x = 51;
    for (const pad of pads) pad.numberGenerated = true;
    return board;
  }

  it('creates a keyed note for every part and pin that can be told apart, refuses the others with a message, and stores no positional id', async () => {
    const h = createHarness();
    const board = awkward();
    await openNative(h, 'awkward.cad', 1, board);
    const index = noteKeyIndex(board);
    const subjects = board.components.flatMap(component => [{ componentId: component.id }, ...component.pinIds.map(pinId => ({ componentId: component.id, pinId }))]);
    const created: Array<{ subject: (typeof subjects)[number]; text: string }> = [], refused: Array<(typeof subjects)[number]> = [];
    for (const [i, subject] of subjects.entries()) {
      await h.controller.actions.upsertNote(subject, { text: `note ${i}` });
      if (index.target(subject.componentId, 'pinId' in subject ? subject.pinId : undefined).ok) { created.push({ subject, text: `note ${i}` }); expect(h.messages().at(-1)).toBe('toast.noteSaved'); }
      else { refused.push(subject); expect(h.messages().at(-1)).toBe('pinId' in subject ? 'notes.refusePin' : 'notes.refusePart'); }
    }
    expect(refused.length).toBeGreaterThan(0);
    expect(created.length).toBeGreaterThan(8);
    const notes = stored(h);
    // split pads of D1 share one pin, so two pad subjects are one note
    expect(notes).toHaveLength(created.length - 1);
    expect(notes.every(isKeyedNote)).toBe(true);
    const json = JSON.stringify(notes);
    expect(json).not.toMatch(/"componentId"|"pinId"|"unresolved"/);
    for (const id of [...board.components.map(c => c.id), ...board.pins.map(p => p.id)]) expect(json, id).not.toContain(`"${id}"`);
    for (const { subject, text } of created) {
      const note = noteForSubject(board, notes, subject);
      expect(note, JSON.stringify(subject)).toBeDefined();
      const found = index.resolve(note!.target);
      expect(found.ok).toBe(true);
      if (!found.ok) continue;
      expect(found.component.id).toBe(subject.componentId);
      if ('pinId' in subject) expect(found.pins.map(pin => pin.id)).toContain(subject.pinId);
      expect(created.map(item => item.text)).toContain(note!.text);
    }
    expect(validateNotes(JSON.parse(json))).toEqual(notes);
    expect(unresolvedNotes(board, notes)).toEqual([]);
    // the fallbacks are in the stored keys, so a later reader can see how each note is bound
    const keys = notes.map(note => (note as KeyedNote).target);
    expect(keys.filter(key => key.ref === 'C5').every(key => key.at !== undefined)).toBe(true);
    expect(keys.some(key => key.ref === undefined && key.at !== undefined)).toBe(true);
    expect(keys.some(key => key.pinAt !== undefined)).toBe(true);
    expect(keys.some(key => key.ref === 'R1' && key.at === undefined && key.pinAt === undefined)).toBe(true);
  });

  it('a stale id is a failed save, not a note on some other part', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    await h.controller.actions.upsertNote({ componentId: 'gone' }, { text: 'x' });
    await h.controller.actions.upsertNote({ componentId: 'r1', pinId: 'u1.1.4' }, { text: 'x' });
    expect(saves(h)).toEqual([]);
    expect(h.state().notes).toEqual([]);
    expect(h.messages()).toEqual(['toast.loaded', 'toast.noteSaveFailed', 'toast.noteSaveFailed']);
  });

  it('every list the application writes passes the guard: no positional note without a key or an unresolved record', async () => {
    const h = createHarness();
    h.desktop.notes.set(hexKey(1), [legacy('n1', 'r1'), legacy('n2', 'ghost')]);
    await openNative(h, 'a.cad', 1);
    await h.controller.actions.upsertNote({ componentId: 'u1' }, { text: 'new' });
    await h.controller.actions.removeNote('n2');
    expect(saves(h)).toHaveLength(3);
    for (const written of [stored(h), h.state().notes]) expect(() => assertStorable(written)).not.toThrow();
  });
});

describe('deleting an unresolved note', () => {
  async function withUnresolved(): Promise<Harness> {
    const h = createHarness();
    h.desktop.notes.set(hexKey(1), [legacy('n1', 'r1'), legacy('lost', 'ghost', undefined, { text: 'keep until I delete it' })]);
    await openNative(h, 'a.cad', 1);
    return h;
  }

  it('removes exactly the chosen note, persists the change and reports it', async () => {
    const h = await withUnresolved();
    expect(h.state().notes.map(note => note.id)).toEqual(['n1', 'lost']);
    await h.controller.actions.removeNote('lost');
    expect(h.state().notes.map(note => note.id)).toEqual(['n1']);
    expect(stored(h).map(note => note.id)).toEqual(['n1']);
    expect(h.messages().at(-1)).toBe('toast.noteDeleted');
    await h.controller.actions.removeNote('n1');
    expect(h.state().notes).toEqual([]);
    expect(stored(h)).toEqual([]);
  });

  it('an unknown id changes nothing and writes nothing', async () => {
    const h = await withUnresolved();
    const before = h.state().notes, writes = saves(h).length;
    await h.controller.actions.removeNote('nobody');
    expect(h.state().notes).toBe(before);
    expect(saves(h)).toHaveLength(writes);
  });

  it('is refused while the stored notes are locked, and a failing write leaves the list as stored', async () => {
    const h = await withUnresolved();
    const writes = saves(h).length;
    h.desktop.failures.saveNotes = () => new Error("Error invoking remote method 'trace:save-notes': Error: [STORE_WRITE_FAILED] Disk full.");
    await h.controller.actions.removeNote('lost');
    expect(h.state().notes.map(note => note.id)).toEqual(['n1', 'lost']);
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error', message: { text: 'Disk full.' } });
    delete h.desktop.failures.saveNotes;
    expect(saves(h).length).toBe(writes + 1);
    const locked = createHarness();
    locked.desktop.failures.getNotes = () => new Error("Error invoking remote method 'trace:get-notes': Error: [NOTES_INVALID] The notes file is damaged.");
    await openNative(locked, 'a.cad', 1);
    await locked.controller.actions.removeNote('lost');
    expect(saves(locked)).toEqual([]);
  });
});
