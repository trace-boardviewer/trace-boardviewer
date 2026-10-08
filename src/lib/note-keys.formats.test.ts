import { describe, expect, it } from 'vitest';
import { parseGenCad } from './gencad';
import { textInput } from './formats/common';
import { parseBvr } from './formats/bvr';
import { parseKicad } from './formats/kicad';
import { parseSamsungCad } from './formats/samsung-cad';
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
