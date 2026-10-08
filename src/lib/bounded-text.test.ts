import { describe, expect, it } from 'vitest';
import { boundText, MAX_MESSAGE_CHARS, MAX_QUOTED_CHARS } from './bounded-text';
import { BoardFormatError, note } from './formats/common';
import { GenCadParseError, parseGenCad } from './gencad';
import { computeConnectivity } from './schematic/connectivity';
import { parseAltiumSch } from './schematic/altium-sch';
import { Sheet } from './schematic/altium-sch-fixtures';
import { parseKicadLegacySch } from './schematic/kicad-legacy';
import { parseKicadSch } from './schematic/kicad-sch';
import { SchematicError } from './schematic/model';
import { buildSchematic, SheetBuilder } from './schematic/testing';

// Text of an input file that an error, a warning or a diagnostic quotes is cut: found by the parser fuzzer, which got error messages of
// up to 190,000 characters from one token of a file.

const enc = (text: string) => new TextEncoder().encode(text);
const HUGE = 'x'.repeat(75_000);

describe('boundText', () => {
  it('keeps short text and cuts long text to the limit with an ellipsis', () => {
    expect(boundText('short')).toBe('short');
    expect(boundText('a'.repeat(MAX_MESSAGE_CHARS))).toHaveLength(MAX_MESSAGE_CHARS);
    const cut = boundText('a'.repeat(MAX_MESSAGE_CHARS + 1));
    expect(cut).toHaveLength(MAX_MESSAGE_CHARS);
    expect(cut.endsWith('…')).toBe(true);
    expect(boundText('abcdef', 4)).toBe('abc…');
    expect(boundText('', 4)).toBe('');
    expect(boundText(cut)).toBe(cut);
  });

  it('never splits a surrogate pair', () => {
    const pair = '\u{1F600}';
    for (let length = 3; length < 8; length++) {
      const cut = boundText(pair.repeat(10), length);
      expect(cut.length).toBeLessThanOrEqual(length);
      expect(/[\ud800-\udbff]$/.test(cut.slice(0, -1))).toBe(false);
      expect(cut.endsWith('…')).toBe(true);
    }
  });
});

describe('error and warning text of the importers is bounded', () => {
  it('BoardFormatError and a format note cut a long message', () => {
    expect(new BoardFormatError(`bad token ${HUGE}`).message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(new BoardFormatError('short').message).toBe('short');
    expect(String(note(`value ${HUGE}`).params?.message).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(note('short').params?.message).toBe('short');
  });

  it('SchematicError cuts a long message', () => {
    expect(new SchematicError(`bad token ${HUGE}`).message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });

  it('GenCAD quotes a long token in a short form, in the structured issue and in the message', () => {
    const text = ['$HEADER', 'GENCAD 1.4', 'UNITS MM', '$ENDHEADER', '$BOARD', '$ENDBOARD', '$SHAPES', 'SHAPE S', 'PIN 1 S 1 0 TOP', '$ENDSHAPES', '$COMPONENTS', 'COMPONENT R', 'PLACE 0 0', `SHAPE S ${HUGE} 0`, '$ENDCOMPONENTS', '$SIGNALS', '$ENDSIGNALS'].join('\n');
    let caught: unknown;
    try { parseGenCad(text, 'x.cad'); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GenCadParseError);
    const error = caught as GenCadParseError;
    expect(error.issue.key).toBe('parse.error.unknownMirror');
    expect(String(error.issue.params?.value).length).toBeLessThanOrEqual(MAX_QUOTED_CHARS);
    expect(String(error.issue.params?.value).startsWith('XXXX')).toBe(true);
    expect(error.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });

  it('GenCAD cuts the examples of a signal node that names a missing part', () => {
    const text = ['$HEADER', 'GENCAD 1.4', 'UNITS MM', '$ENDHEADER', '$BOARD', '$ENDBOARD', '$SHAPES', 'SHAPE S', 'PIN 1 S 1 0 TOP', '$ENDSHAPES', '$COMPONENTS', 'COMPONENT R', 'PLACE 0 0', 'SHAPE S', '$ENDCOMPONENTS', '$SIGNALS', 'SIGNAL N1', `NODE ${HUGE} ${HUGE}`, '$ENDSIGNALS'].join('\n');
    const board = parseGenCad(text, 'x.cad');
    const dangling = board.warnings.find(warning => warning.key === 'parse.warning.danglingNodes');
    expect(dangling).toBeDefined();
    expect(String(dangling?.params?.examples).length).toBeLessThanOrEqual(3 * MAX_QUOTED_CHARS + 4);
  });

  it('a legacy KiCad schematic quotes a long field flag in a bounded message', () => {
    const text = `EESchema Schematic File Version 4\nEELAYER 30 0\nEELAYER END\n$Descr A4 11693 8268\n$EndDescr\n$Comp\nL Device:R R1\nU 1 1 5F000001\nP 100 100\nF 0 "R1" H 200 0 50  ${HUGE} L CNN\n$EndComp\n$EndSCHEMATC\n`;
    let caught: unknown;
    try { parseKicadLegacySch({ name: 'demo.sch', data: enc(text) }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(SchematicError);
    expect((caught as SchematicError).message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect((caught as SchematicError).message).toContain('not hexadecimal');
  });

  it('a KiCad schematic diagnostic about a long record name is bounded', () => {
    const text = `(kicad_sch (version 20231120) (generator "synthetic") (uuid "00000000-0000-4000-8000-000000000001") (paper "A4") (lib_symbols) (${HUGE} (a b)))`;
    const schematic = parseKicadSch({ name: 'main.kicad_sch', data: enc(text) });
    const unknown = schematic?.diagnostics.find(diagnostic => diagnostic.code === 'UNKNOWN_RECORD');
    expect(unknown).toBeDefined();
    expect(unknown?.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(unknown?.message).toContain('xxxx');
  });

  it('an Altium schematic diagnostic about a long port name is bounded', () => {
    const sheet = new Sheet({ SheetStyle: 0 });
    sheet.port({ name: HUGE, x: 100, y: 100 });
    const schematic = parseAltiumSch({ name: 'main.SchDoc', data: sheet.file() });
    const unattached = schematic?.diagnostics.find(diagnostic => diagnostic.code === 'PORT_UNATTACHED');
    expect(unattached).toBeDefined();
    expect(unattached?.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(unattached?.message).toContain('Port "xxxx');
  });

  it('a connectivity diagnostic about a long label is bounded', () => {
    const sheet = new SheetBuilder('root', 'root').part('R1', [{ n: '1', x: 0, y: 0 }, { n: '2', x: 10, y: 0 }]).wire(0, 0, 5, 0).local(`{${HUGE}`, 5, 0);
    const connectivity = computeConnectivity(buildSchematic([sheet]));
    const invalid = connectivity.diagnostics.find(diagnostic => diagnostic.code === 'BUS_LABEL_INVALID');
    expect(invalid).toBeDefined();
    expect(invalid?.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(invalid?.message).toContain('{xxxx');
  });
});
