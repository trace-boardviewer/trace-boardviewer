import { describe, expect, it } from 'vitest';
import { parseGenCad } from './gencad';
import { textInput } from './formats/common';
import { parseBvr } from './formats/bvr';
import { parseKicad } from './formats/kicad';
import { parseSamsungCad } from './formats/samsung-cad';
import { parseBdv } from './formats/bdv';
import { parseAsc } from './formats/asc';
import { migrateNotes, noteForSubject, noteKeyIndex, unresolvedNotes } from './note-keys';
import type { Board, BoardNote, KeyedNote, LegacyNote } from './types';
import { noteTarget, upsertNote, validateNotes } from './workspace';

/**
 * Conformance of the note keys on boards read by the real importers: GenCAD (its own builder, ids made of the reference), KiCad PCB,
 * BVR raw and Samsung CAD (the shared builder, ids numbered by position). Every file is original synthetic text generated here.
 */
const T0 = '2026-10-05T10:00:00.000Z';
const bytes = (text: string) => new TextEncoder().encode(text);
const REFS = ['R1', 'R2', 'U1', 'J1', 'C7'];
const PAD_COUNT = 3;

const gencad = (refs: string[]) => parseGenCad(`$HEADER
GENCAD 1.4
UNITS MM
ORIGIN 0 0
$ENDHEADER
$BOARD
RECTANGLE 0 0 80 30
$ENDBOARD
$PADS
PAD P ROUND -1
CIRCLE 0 0 0.2
$ENDPADS
$PADSTACKS
PADSTACK PS 0
PAD P TOP 0 0
$ENDPADSTACKS
$SHAPES
SHAPE S
RECTANGLE -2 -1 4 2
PIN 1 PS -1 0 TOP 0 0
PIN 2 PS 0 0 TOP 0 0
PIN 3 PS 1 0 TOP 0 0
$ENDSHAPES
$COMPONENTS
${refs.map((ref, index) => `COMPONENT ${ref}\nPLACE ${10 * (index + 1)} 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D`).join('\n')}
$ENDCOMPONENTS
$DEVICES
DEVICE D
VALUE "1 k"
PACKAGE "0402"
$ENDDEVICES
$SIGNALS
SIGNAL GND
NODE ${refs[refs.length - 1]} 1
$ENDSIGNALS
`, 'a.cad');

const kicad = (refs: string[]) => parseKicad(textInput(`(kicad_pcb (version 20240108) (net 0 "") (net 1 "GND") ${refs.map((ref, index) =>
  `(footprint "T:X" (layer "F.Cu") (at ${10 * (index + 1)} 5) (property "Reference" "${ref}") ${Array.from({ length: PAD_COUNT }, (_, pad) => `(pad "${pad + 1}" smd rect (at ${pad} 0) (size 1 1) (layers "F.Cu") (net 1 "GND"))`).join(' ')})`).join(' ')})`, 'a.kicad_pcb'))!;

const bvr = (refs: string[]) => parseBvr({ name: 'a.bvr', data: bytes(['BVRAW_FORMAT_1', '<<Layout>>', 'X,Y', '0,0', '9,0', '9,3', '0,3', '<<Pin>>', 'PART SIDE ID NAME X Y LAYER NET',
  ...refs.flatMap((ref, index) => Array.from({ length: PAD_COUNT }, (_, pad) => `${ref} (T) ${pad + 1} ${pad + 1} ${index + 0.5 + pad * 0.1} 1 1 GND`))].join('\r\n') + '\r\n') })!;

const samsung = (refs: string[]) => parseSamsungCad({ name: 'a.cad', data: bytes(['###Panel Added: synthetic', ...refs.map((ref, index) => `COMP ${ref} PN 0 0 ${index + 0.5} 1.000 1 0`),
  ...refs.flatMap((ref, index) => Array.from({ length: PAD_COUNT }, (_, pad) => `C_PIN ${ref}-${pad + 1} ${index + 0.5 + pad * 0.1} 1.000 0 0 0 X GND`))].join('\n') + '\n') })!;

const FORMATS: Array<{ name: string; parse(refs: string[]): Board; positional: boolean }> = [
  { name: 'GenCAD', parse: gencad, positional: false }, { name: 'KiCad PCB', parse: kicad, positional: true },
  { name: 'BVR raw', parse: bvr, positional: true }, { name: 'Samsung CAD', parse: samsung, positional: true },
];
const part = (board: Board, ref: string) => board.components.find(component => component.ref === ref)!;
const pad = (board: Board, ref: string, number: string) => board.pins.find(pin => pin.componentId === part(board, ref).id && pin.number === number)!;
const subjects = (board: Board) => board.components.flatMap(component => [{ componentId: component.id }, ...component.pinIds.map(pinId => ({ componentId: component.id, pinId }))]);

describe.each(FORMATS)('note keys on a $name board', ({ parse, positional }) => {
  const full = () => parse(REFS);
  const notesFor = (board: Board): KeyedNote[] => {
    let notes: BoardNote[] = [];
    const index = noteKeyIndex(board);
    subjects(board).forEach((subject, i) => {
      const target = index.target(subject.componentId, 'pinId' in subject ? subject.pinId : undefined);
      if (!target.ok) throw new Error(`no key for ${JSON.stringify(subject)}: ${target.reason}`);
      expect(target.fallbacks).toEqual([]);
      notes = upsertNote(notes, noteTarget(target.key), { text: `note ${i}` }, T0, () => `id-${i}`);
    });
    return notes as KeyedNote[];
  };

  it('every part and every pin gets a key made of its reference and pin number only, and the key resolves back to it', () => {
    const board = full();
    expect(board.components.map(component => component.ref)).toEqual(REFS);
    const notes = notesFor(board);
    expect(notes).toHaveLength(REFS.length * (1 + PAD_COUNT));
    const json = JSON.stringify(notes);
    // GenCAD makes the part id out of the reference itself, so only an id that differs from its reference can be a leaked positional one
    for (const component of board.components) if (component.id !== component.ref) expect(json, component.id).not.toContain(`"${component.id}"`);
    for (const pin of board.pins) expect(json, pin.id).not.toContain(`"${pin.id}"`);
    expect(notes.map(note => note.target)).toContainEqual({ ref: 'U1' });
    expect(notes.map(note => note.target)).toContainEqual({ ref: 'U1', pin: '3' });
    const index = noteKeyIndex(board);
    for (const subject of subjects(board)) {
      const note = noteForSubject(board, notes, subject)!;
      expect(note, JSON.stringify(subject)).toBeDefined();
      const found = index.resolve(note.target);
      expect(found.ok && found.component.id).toBe(subject.componentId);
      if ('pinId' in subject) expect(found.ok && found.pins.map(pin => pin.id)).toEqual([subject.pinId]);
    }
    expect(unresolvedNotes(board, notes)).toEqual([]);
    expect(validateNotes(JSON.parse(json))).toEqual(notes);
  });

  it('a file read with one component omitted keeps every other note on the same reference and pin; the omitted one is listed, not moved', () => {
    const before = full(), after = parse(REFS.filter(ref => ref !== 'R1'));
    if (positional) {
      expect(part(before, 'U1').id).not.toBe(part(after, 'U1').id);
      expect(pad(before, 'U1', '2').id).not.toBe(pad(after, 'U1', '2').id);
    }
    const notes = notesFor(before);
    const lost = unresolvedNotes(after, notes);
    expect(lost.map(item => (item.note as KeyedNote).target)).toEqual([{ ref: 'R1' }, { ref: 'R1', pin: '1' }, { ref: 'R1', pin: '2' }, { ref: 'R1', pin: '3' }]);
    expect(lost.every(item => item.problem === 'component-missing')).toBe(true);
    for (const subject of subjects(after)) {
      const here = after.components.find(component => component.id === subject.componentId)!;
      const found = noteForSubject(after, notes, subject)!;
      expect(found, JSON.stringify(subject)).toBeDefined();
      expect(found.target.ref).toBe(here.ref);
      if ('pinId' in subject) expect(found.target.pin).toBe(after.pins.find(pin => pin.id === subject.pinId)!.number);
      else expect(found.target.pin).toBeUndefined();
    }
  });

  it('reading the same components in another order changes no key', () => {
    const board = full(), reversed = parse([...REFS].reverse());
    expect(notesFor(reversed).map(note => note.target).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(notesFor(board).map(note => note.target).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  });

  it('positional notes written against this parse become exactly the keys the parse gives, once', () => {
    const board = full();
    const legacy: LegacyNote[] = [
      { id: 'a', componentId: part(board, 'U1').id, text: 'U1', updatedAt: T0 },
      { id: 'b', componentId: part(board, 'U1').id, pinId: pad(board, 'U1', '3').id, text: 'U1 pin 3', updatedAt: T0 },
      { id: 'c', componentId: part(board, 'J1').id, pinId: pad(board, 'J1', '1').id, text: 'J1 pin 1', updatedAt: T0 },
      { id: 'd', componentId: 'part:99', text: 'a part this parse does not have', updatedAt: T0 },
    ];
    const result = migrateNotes(board, legacy, T0);
    expect(result).toMatchObject({ migrated: 3, unresolved: 1 });
    expect(result.notes.slice(0, 3).map(note => (note as KeyedNote).target)).toEqual([{ ref: 'U1' }, { ref: 'U1', pin: '3' }, { ref: 'J1', pin: '1' }]);
    expect(unresolvedNotes(board, result.notes).map(item => [item.note.id, item.note.text, item.problem])).toEqual([['d', 'a part this parse does not have', 'legacy-id-missing']]);
    expect(migrateNotes(board, result.notes, T0)).toEqual({ notes: result.notes, changed: false, migrated: 0, unresolved: 0 });
  });
});

describe('historical shortened BDV note migration', () => {
  it('preserves old component and pin ids instead of attaching them to a newly recovered first part', () => {
    const lines = [
      '<<format.asc>>', ...Array.from({ length: 8 }, (_, index) => `; format header ${index + 1}`),
      '0 0', '2 0', '2 1', '0 1',
      '<<pins.asc>>', ...Array.from({ length: 6 }, (_, index) => `; pins header ${index + 1}`),
      'Part U1 (T)', '1 1 0.1 0.2 1 N1 0', 'Part U2 (T)', '1 1 0.2 0.2 1 N2 0',
    ];
    const board = parseBdv({ name: 'short-header.bdv', data: bytes(lines.join('\n') + '\n') })!;
    expect(board.components.map(component => [component.id, component.ref])).toEqual([['part:0', 'U1'], ['part:1', 'U2']]);
    expect(board.legacyPositionalNotesUnsafe).toBe(true);
    // These are the exact output ids from the older fixed-eight-line reader: it skipped U1 and its pin, leaving U2 as part:0/pin:0.
    const original: LegacyNote[] = [
      { id: 'old-part', componentId: 'part:0', text: 'note about U2', measurements: { voltage: '1.8 V' }, updatedAt: T0 },
      { id: 'old-pin', componentId: 'part:0', pinId: 'pin:0', text: 'U2 pin note', measurements: { resistance: '0.4 Ω' }, updatedAt: T0 },
    ];
    const result = migrateNotes(board, original, T0);
    expect(result).toMatchObject({ migrated: 0, unresolved: 2 });
    expect(result.notes).toEqual(original.map(note => ({ ...note, unresolved: { reason: 'legacy-order-unknown', at: T0 } })));
    expect(unresolvedNotes(board, result.notes).map(item => [item.note.id, item.problem])).toEqual([['old-part', 'legacy-order-unknown'], ['old-pin', 'legacy-order-unknown']]);
  });

  it('keeps ordinary full-header BDV migration safe when component and pin order is explicit', () => {
    const lines = [
      '<<format.asc>>', ...Array.from({ length: 8 }, (_, index) => `; format header ${index + 1}`),
      '0 0', '2 0', '2 1', '0 1',
      '<<pins.asc>>', ...Array.from({ length: 8 }, (_, index) => `; pins header ${index + 1}`),
      'Part U1 (T)', '1 1 0.1 0.2 1 N1 0', 'Part U2 (T)', '1 1 0.2 0.2 1 N2 0',
    ];
    const board = parseBdv({ name: 'full-header.bdv', data: bytes(lines.join('\n') + '\n') })!;
    expect(board.legacyPositionalNotesUnsafe).toBeUndefined();
    const result = migrateNotes(board, [
      { id: 'old-part', componentId: 'part:0', text: 'U1', updatedAt: T0 },
      { id: 'old-pin', componentId: 'part:0', pinId: 'pin:0', text: 'U1 pin', updatedAt: T0 },
    ], T0);
    expect(result.notes).toEqual([
      { id: 'old-part', target: { ref: 'U1' }, text: 'U1', updatedAt: T0 },
      { id: 'old-pin', target: { ref: 'U1', pin: '1' }, text: 'U1 pin', updatedAt: T0 },
    ]);
  });

  it('does not block positional notes when only the outline header is shortened', () => {
    const lines = [
      '<<format.asc>>', '0 0', '2 0', '2 1', '0 1',
      '<<pins.asc>>', ...Array.from({ length: 8 }, (_, index) => `; pins header ${index + 1}`),
      'Part U1 (T)', '1 1 0.1 0.2 1 N1 0',
    ];
    const board = parseBdv({ name: 'short-outline-header.bdv', data: bytes(lines.join('\n') + '\n') })!;
    expect(board.legacyPositionalNotesUnsafe).toBeUndefined();
    expect(migrateNotes(board, [{ id: 'old-part', componentId: 'part:0', text: 'U1', updatedAt: T0 }], T0).notes).toEqual([
      { id: 'old-part', target: { ref: 'U1' }, text: 'U1', updatedAt: T0 },
    ]);
  });
});

describe('ASC companion note migration', () => {
  const open = (pinsHeader: number, nailsHeader: number, formatHeader = 8): Board => {
    const companions = {
      'pins.asc': bytes([...Array.from({ length: pinsHeader }, (_, index) => `; pins header ${index + 1}`), 'Part U1 (T)', '1 1 0.1 0.2 1 GND 0', 'Part U2 (T)', '1 1 0.2 0.2 1 GND 0'].join('\n') + '\n'),
      'nails.asc': bytes([...Array.from({ length: nailsHeader }, (_, index) => `; nails header ${index + 1}`), 'N1 0.1 0.2 1 0 (T) 0 GND', 'N2 0.2 0.2 1 0 (T) 0 GND'].join('\n') + '\n'),
    };
    const board = parseAsc({
      name: 'format.asc',
      data: bytes([...Array.from({ length: formatHeader }, (_, index) => `; format header ${index + 1}`), '0 0', '2 0', '2 1', '0 1'].join('\n') + '\n'),
      companions,
    });
    if (!board) throw new Error('synthetic ASC fixture was not recognized');
    return board;
  };

  it('leaves component and pin notes unresolved when a shortened pins header can shift the old ids', () => {
    const board = open(6, 7);
    expect(board.components.slice(0, 2).map(component => [component.id, component.ref])).toEqual([['part:0', 'U1'], ['part:1', 'U2']]);
    expect(board.legacyPositionalNotesUnsafe).toBe(true);
    const keyed: KeyedNote = { id: 'keyed', target: { ref: 'U1' }, text: 'already keyed', updatedAt: T0 };
    const notes: BoardNote[] = [keyed,
      { id: 'old-part', componentId: 'part:0', text: 'note about U2', measurements: { voltage: '1.8 V' }, updatedAt: T0 },
      { id: 'old-pin', componentId: 'part:0', pinId: 'pin:0', text: 'U2 pin note', measurements: { resistance: '0.4 Ω' }, updatedAt: T0 },
    ];
    const migrated = migrateNotes(board, notes, T0);
    expect(migrated).toMatchObject({ migrated: 0, unresolved: 2 });
    expect(migrated.notes).toEqual([keyed, ...notes.slice(1).map(note => ({ ...note, unresolved: { reason: 'legacy-order-unknown', at: T0 } }))]);
  });

  it('leaves notes unresolved when only a shortened nails header can shift old test-point ids', () => {
    const board = open(8, 6);
    expect(board.legacyPositionalNotesUnsafe).toBe(true);
    const migrated = migrateNotes(board, [{ id: 'old-pin', componentId: 'part:2', pinId: 'pin:2', text: 'test point', updatedAt: T0 }], T0);
    expect(migrated).toMatchObject({ migrated: 0, unresolved: 1 });
    expect(migrated.notes[0]).toMatchObject({ id: 'old-pin', text: 'test point', componentId: 'part:2', pinId: 'pin:2', unresolved: { reason: 'legacy-order-unknown' } });
  });

  it('keeps full component and test-point headers safe, and an outline-only shortening does not set the flag', () => {
    const full = open(8, 7);
    expect(full.legacyPositionalNotesUnsafe).toBeUndefined();
    expect(migrateNotes(full, [{ id: 'old-part', componentId: 'part:0', text: 'U1', updatedAt: T0 }], T0).notes).toEqual([
      { id: 'old-part', target: { ref: 'U1' }, text: 'U1', updatedAt: T0 },
    ]);
    const outlineOnly = open(8, 7, 4);
    expect(outlineOnly.legacyPositionalNotesUnsafe).toBeUndefined();
    expect(migrateNotes(outlineOnly, [{ id: 'old-part', componentId: 'part:0', text: 'U1', updatedAt: T0 }], T0).notes).toEqual([
      { id: 'old-part', target: { ref: 'U1' }, text: 'U1', updatedAt: T0 },
    ]);
  });
});
