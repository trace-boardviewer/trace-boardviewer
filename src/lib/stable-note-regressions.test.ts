import { describe, expect, it } from 'vitest';
import { parseAsc } from './formats/asc';
import { parseBdv } from './formats/bdv';
import type { Board, BoardNote, KeyedNote, LegacyNote } from './types';
import { migrateNotes, unresolvedNotes } from './note-keys';
import { validateNotes } from './workspace';

const SAVED_AT = '2026-09-19T14:23:51.000Z';
const FIRST_OPEN = '2026-10-08T20:00:00.000Z';
const bytes = (text: string) => new TextEncoder().encode(text);

function shortenedBdv(): Board {
  const lines = [
    '<<format.asc>>', ...Array.from({ length: 8 }, (_, i) => `; format header ${i + 1}`),
    '0 0', '2 0', '2 1', '0 1',
    '<<pins.asc>>', ...Array.from({ length: 6 }, (_, i) => `; pins header ${i + 1}`),
    'Part U1 (T)', '1 1 0.1 0.2 1 N1 0', 'Part U2 (T)', '1 1 0.2 0.2 1 N2 0',
  ];
  const board = parseBdv({ name: 'short-header.bdv', data: bytes(`${lines.join('\n')}\n`) });
  if (!board) throw new Error('synthetic shortened BDV was not recognized');
  return board;
}

function shortenedAsc(): Board {
  const companions = {
    'pins.asc': bytes(['; pins header 1', '; pins header 2', '; pins header 3', '; pins header 4', '; pins header 5', '; pins header 6',
      'Part U1 (T)', '1 1 0.1 0.2 1 GND 0', 'Part U2 (T)', '1 1 0.2 0.2 1 GND 0'].join('\n') + '\n'),
    'nails.asc': bytes([...Array.from({ length: 7 }, (_, i) => `; nails header ${i + 1}`), 'N1 0.1 0.2 1 0 (T) 0 GND'].join('\n') + '\n'),
  };
  const board = parseAsc({
    name: 'format.asc',
    data: bytes([...Array.from({ length: 8 }, (_, i) => `; format header ${i + 1}`), '0 0', '2 0', '2 1', '0 1'].join('\n') + '\n'),
    companions,
  });
  if (!board) throw new Error('synthetic shortened ASC was not recognized');
  return board;
}

const keyed = (overrides: Partial<KeyedNote> = {}): KeyedNote => ({
  id: 'keyed-u1', target: { ref: 'U1' }, text: 'old U2 note incorrectly saved to U1 in RC2', updatedAt: SAVED_AT, ...overrides,
});

const oldPart: LegacyNote = {
  id: 'legacy-u2-part', componentId: 'part:0', text: 'about U2',
  measurements: { voltage: '1.8 V', other: 'scope run 14' }, updatedAt: SAVED_AT,
};
const oldPin: LegacyNote = {
  id: 'legacy-u2-pin', componentId: 'part:0', pinId: 'pin:0', text: 'U2 pin 1',
  measurements: { resistance: '0.4 Ω' }, updatedAt: SAVED_AT,
};

describe('stable audit: recovery of pre-key positional notes', () => {
  it.each([
    ['shortened BDV', shortenedBdv],
    ['shortened ASC companions', shortenedAsc],
  ] as const)('%s preserves historical positional notes without attaching them to the current first component', (_name, open) => {
    const board = open();
    expect(board.legacyPositionalNotesUnsafe).toBe(true);
    expect(board.components.slice(0, 2).map(component => [component.id, component.ref])).toEqual([['part:0', 'U1'], ['part:1', 'U2']]);

    // In the historical fixed-header reader, six pins header rows consumed the U1 record and its pin.
    // Its first surviving component and pin were therefore both numbered zero and belonged to U2.
    const savedBeforeUpgrade: BoardNote[] = [oldPart, oldPin];
    const backup = JSON.stringify(savedBeforeUpgrade);
    const migrated = migrateNotes(board, savedBeforeUpgrade, FIRST_OPEN);

    expect(migrated).toMatchObject({ changed: true, migrated: 0, unresolved: 2 });
    expect(migrated.notes).toEqual([
      { ...oldPart, unresolved: { reason: 'legacy-order-unknown', at: FIRST_OPEN } },
      { ...oldPin, unresolved: { reason: 'legacy-order-unknown', at: FIRST_OPEN } },
    ]);
    expect(unresolvedNotes(board, migrated.notes).map(item => [item.note.id, item.problem])).toEqual([
      [oldPart.id, 'legacy-order-unknown'], [oldPin.id, 'legacy-order-unknown'],
    ]);
    expect(validateNotes(JSON.parse(JSON.stringify(migrated.notes)))).toEqual(migrated.notes);
    expect(JSON.stringify(savedBeforeUpgrade)).toBe(backup);

    // The unresolved marker is the retry fence: a later parse or open cannot reinterpret those old ids.
    const second = migrateNotes(board, migrated.notes, '2026-10-09T09:00:00.000Z');
    expect(second).toEqual({ notes: migrated.notes, changed: false, migrated: 0, unresolved: 0 });
  });

  it('leaves previously keyed notes untouched, even if a user may already have received a wrong key in an earlier release', () => {
    const board = shortenedBdv();
    const keyedNote = keyed({ target: { ref: 'U1', pin: '1' }, measurements: { voltage: '3.3 V' } });
    const notes: BoardNote[] = [keyedNote, oldPart, oldPin];
    const result = migrateNotes(board, notes, FIRST_OPEN);

    expect(result.notes[0]).toBe(keyedNote);
    expect(result.notes[0]).toEqual(keyedNote);
    expect(result.notes.slice(1)).toEqual([
      { ...oldPart, unresolved: { reason: 'legacy-order-unknown', at: FIRST_OPEN } },
      { ...oldPin, unresolved: { reason: 'legacy-order-unknown', at: FIRST_OPEN } },
    ]);
    // Once wrongly keyed, the stored record contains no evidence that the intended target was U2.
    // The importer can only resolve the saved U1 key, so it must preserve the record without guessing.
    expect(unresolvedNotes(board, result.notes).map(item => item.note.id)).toEqual([oldPart.id, oldPin.id]);
    expect(result.notes[0]).toMatchObject({ target: { ref: 'U1' }, text: 'old U2 note incorrectly saved to U1 in RC2' });
  });

  it('does not flag a shortened outline header or change migration when component and pin headers are complete', () => {
    const lines = [
      '<<format.asc>>', '0 0', '2 0', '2 1', '0 1',
      '<<pins.asc>>', ...Array.from({ length: 8 }, (_, i) => `; pins header ${i + 1}`),
      'Part U1 (T)', '1 1 0.1 0.2 1 N1 0',
    ];
    const board = parseBdv({ name: 'outline-only-short.bdv', data: bytes(`${lines.join('\n')}\n`) });
    if (!board) throw new Error('synthetic outline-only shortened BDV was not recognized');
    expect(board.legacyPositionalNotesUnsafe).toBeUndefined();
    expect(migrateNotes(board, [{ id: 'safe', componentId: 'part:0', text: 'U1', updatedAt: SAVED_AT }], FIRST_OPEN).notes).toEqual([
      { id: 'safe', target: { ref: 'U1' }, text: 'U1', updatedAt: SAVED_AT },
    ]);
  });
});
