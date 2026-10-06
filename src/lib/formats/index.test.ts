import { describe, expect, it } from 'vitest';
import formats from '../../../electron/formats.json';
import { GenCadParseError } from '../gencad';
import type { Board } from '../types';
import { BoardFormatError as CommonError, MAX_IMPORT_BYTES, textInput } from './common';
import { BoardFormatError, FORMAT_CAPABILITIES, PARSERS, SUPPORTED_EXTENSIONS, companionNames, parseBoard } from './index';

const GENCAD = `$HEADER
GENCAD 1.4
UNITS MM
ORIGIN 0 0
$ENDHEADER
$BOARD
RECTANGLE 0 0 40 30
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
PIN 2 PS 1 0 TOP 0 0
$ENDSHAPES
$COMPONENTS
COMPONENT R1
PLACE 10 20
LAYER TOP
ROTATION 0
SHAPE S 0 0
DEVICE D
$ENDCOMPONENTS
$DEVICES
DEVICE D
VALUE "10 kOhm"
$ENDDEVICES
$SIGNALS
SIGNAL GND
NODE R1 1
$ENDSIGNALS
`;
const LANDREX = `str_length:
123
var_data:
4 1 2 0
Format:
0 0
1000 0
1000 1000
0 1000
Parts:
U1 1 2
Pins:
100 100 0 1 GND
200 100 0 1 VCC
Nails:
`;
const BRD2 = `BRDOUT: 4 1000 1000
0 0
1000 0
1000 1000
0 1000
NETS: 2
1 GND
2 VCC
PARTS: 1
U1 100 100 300 200 0 1
PINS: 2
150 150 1 1
250 150 2 1
NAILS: 0
`;
const KICAD = `(kicad_pcb (version 20240108) (generator "synthetic") (net 0 "") (net 1 "GND")
 (footprint "Test:Package" (layer "F.Cu") (at 10 20 90) (property "Reference" "U1") (property "Value" "v")
  (fp_rect (start -3 -2) (end 3 2) (layer "F.Fab"))
  (pad "1" smd rect (at 2 3 90) (size 2 1) (layers "F.Cu") (net 1 "GND")))
 (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts")))`;
const failure = (action: () => unknown): BoardFormatError => {
  try { action(); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
};

describe('capability matrix and extension list', () => {
  it('every capability extension is in electron/formats.json and vice versa, all lowercase with a leading dot', () => {
    const declared = new Set(FORMAT_CAPABILITIES.flatMap(capability => capability.extensions));
    const listed = new Set(formats.extensions);
    expect([...declared].sort()).toEqual([...listed].sort());
    expect([...SUPPORTED_EXTENSIONS].sort()).toEqual([...listed].sort());
    expect(new Set(formats.extensions).size).toBe(formats.extensions.length);
    for (const extension of SUPPORTED_EXTENSIONS) expect(extension).toMatch(/^\.[a-z0-9_]+$/);
    expect(Object.isFrozen(SUPPORTED_EXTENSIONS)).toBe(true);
  });
  it('capabilities are unique, honestly labelled and only GenCAD, the real-file validated BVR3, KiCad PCB and EAGLE board XML are marked supported', () => {
    const ids = FORMAT_CAPABILITIES.map(capability => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const capability of FORMAT_CAPABILITIES) {
      expect(['supported', 'draft', 'recognized-unsupported', 'extension-only']).toContain(capability.status);
      expect(['real-files', 'synthetic-fixtures', 'none']).toContain(capability.validation);
      if (capability.status === 'supported') expect(capability.validation).toBe('real-files');
      if (capability.status === 'draft') expect(capability.validation).toBe('synthetic-fixtures');
      expect(['nets', 'none']).toContain(capability.electrical);
      expect(['real', 'estimated', 'mixed']).toContain(capability.geometry);
      expect(capability.variants.length).toBeGreaterThan(0);
      expect(capability.notes.length).toBeGreaterThan(0);
      expect(capability.units.length).toBeGreaterThan(0);
      for (const requirement of capability.requires ?? []) expect(['key', 'companions']).toContain(requirement);
      if (capability.status === 'recognized-unsupported' || capability.status === 'extension-only') expect(capability.electrical).toBe('none');
    }
    expect(FORMAT_CAPABILITIES.filter(capability => capability.status === 'supported').map(capability => capability.id)).toEqual(['gencad', 'bvr', 'kicad', 'eagle']);
    expect(FORMAT_CAPABILITIES.find(capability => capability.id === 'asc')?.requires).toEqual(['companions']);
    expect(FORMAT_CAPABILITIES.find(capability => capability.id === 'fz')?.requires).toEqual(['key']);
    expect(FORMAT_CAPABILITIES.find(capability => capability.id === 'xzz')?.requires).toBeUndefined();
    for (const id of ['gencad', 'brd', 'brd2', 'bdv', 'bvr', 'bvr1', 'asc', 'fz', 'xzz', 'cst', 'kicad', 'eagle', 'altium', 'samsung-cad', 'mentor-neutral', 'allegro-brd', 'tvw', 'gerber', 'odbpp', 'ipc2581']) {
      expect(ids, id).toContain(id);
    }
  });
  it('companionNames returns the ASC trio sidecars by lowercase basename and nothing for other files', () => {
    expect(companionNames('format.asc')).toEqual(['pins.asc', 'nails.asc']);
    expect(companionNames('C:\\boards\\PINS.ASC')).toEqual(['format.asc', 'nails.asc']);
    expect(companionNames('/x/y/Nails.Asc')).toEqual(['format.asc', 'pins.asc']);
    for (const name of ['board.asc', 'board.brd', 'format.asc.bak', '', 'format', 'constructor', '__proto__']) expect(companionNames(name)).toEqual([]);
    const first = companionNames('format.asc'); first.push('x');
    expect(companionNames('format.asc')).toEqual(['pins.asc', 'nails.asc']);
    expect(formats.companions).toEqual({ 'format.asc': ['pins.asc', 'nails.asc'], 'pins.asc': ['format.asc', 'nails.asc'], 'nails.asc': ['format.asc', 'pins.asc'] });
  });
  it('registers GenCAD first, with unique parser ids, and re-exports the shared error class', () => {
    expect(PARSERS[0].id).toBe('gencad');
    const ids = PARSERS.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['brd', 'cst', 'kicad']) expect(ids).toContain(id);
    expect(ids.indexOf('gencad')).toBeLessThan(ids.indexOf('brd'));
    expect(BoardFormatError).toBe(CommonError);
  });
  it('registers the Samsung CAD reader before the recognizers, as a draft family with nets (it used to be recognized-unsupported)', () => {
    expect(FORMAT_CAPABILITIES.find(capability => capability.id === 'samsung-cad')).toMatchObject({ status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', extensions: ['.cad'] });
    const ids = PARSERS.map(entry => entry.id);
    expect(ids).toContain('samsung-cad');
    expect(ids.indexOf('samsung-cad')).toBeGreaterThan(ids.indexOf('gencad'));
    expect(ids.indexOf('samsung-cad')).toBeLessThan(ids.indexOf('recognizers'));
  });
  it('splits the BVR family: BVRAW_FORMAT_3 is validated with real files, BVRAW_FORMAT_1 stays a synthetic-fixture draft', () => {
    expect(FORMAT_CAPABILITIES.find(capability => capability.id === 'bvr')).toMatchObject({ status: 'supported', validation: 'real-files' });
    expect(FORMAT_CAPABILITIES.find(capability => capability.id === 'bvr1')).toMatchObject({ status: 'draft', validation: 'synthetic-fixtures' });
    expect(FORMAT_CAPABILITIES.find(capability => capability.id === 'bvr')?.notes.join(' ')).toMatch(/Raspberry Pi Pico/);
  });
});

describe('parseBoard dispatcher', () => {
  it('routes GenCAD text to the GenCAD parser', () => {
    const board = parseBoard(textInput(GENCAD, 'C:\\boards\\demo.cad'));
    expect(board.format).toBe('GENCAD 1.4');
    expect(board.name).toBe('demo');
    expect(board.components.map(component => component.ref)).toEqual(['R1']);
    expect(parseBoard(textInput(`\uFEFF  ${GENCAD}`, 'demo.gcd')).format).toBe('GENCAD 1.4');
    expect(parseBoard(textInput(GENCAD.replace('$HEADER\n', '# comment\n$HEADER\n'), 'demo.cad')).format).toBe('GENCAD 1.4');
  });
  it('propagates GenCAD errors unchanged with their structured issue', () => {
    let caught: unknown;
    try { parseBoard(textInput(GENCAD.replace('GENCAD 1.4', 'GENCAD 1.3'), 'old.cad')); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GenCadParseError);
    expect((caught as GenCadParseError).issue).toEqual({ key: 'parse.error.requiresGencad14' });
    try { parseBoard(textInput('$HEADER\nGENCAD 1.4\nUNITS MM\n', 'cut.cad')); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GenCadParseError);
    expect((caught as GenCadParseError).issue.key).toBe('parse.error.missingSectionEnd');
  });
  it('routes Landrex BRD and TOPTEST BRD2 content by signature regardless of the extension', () => {
    const landrex = parseBoard(textInput(LANDREX, 'board.brd'));
    expect(landrex.format).toMatch(/BRD/);
    expect(landrex.components.map(component => component.ref)).toContain('U1');
    expect(landrex.pins).toHaveLength(2);
    const brd2 = parseBoard(textInput(BRD2, 'other.dat'));
    expect(brd2.format).toMatch(/BRD2/);
    expect(brd2.nets.map(net => net.name).sort()).toEqual(['GND', 'VCC']);
  });
  it('routes KiCad PCB content', () => {
    const board = parseBoard(textInput(KICAD, 'demo.kicad_pcb'));
    expect(board.format).toBe('KiCad PCB');
    expect(board.components[0].ref).toBe('U1');
  });
  it('reports unrecognized content with the extension and code UNRECOGNIZED', () => {
    const bytes = Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0x10, 0x20, 0x30, 0x7a, 0x7a]);
    const error = failure(() => parseBoard({ name: 'C:\\boards\\mystery.XYZ', data: bytes }));
    expect(error.code).toBe('UNRECOGNIZED');
    expect(error.message).toContain('.xyz'); expect(error.message).toContain('mystery.XYZ'); expect(error.message).toMatch(/matched none of the supported/);
    expect(failure(() => parseBoard({ name: 'noext', data: bytes })).message).toContain('no extension');
    expect(failure(() => parseBoard(textInput('just some text\n', 'notes.txt'))).code).toBe('UNRECOGNIZED');
    expect(failure(() => parseBoard(textInput('', 'empty.cad'))).code).toBe('UNRECOGNIZED');
  });
  it('reports a UTF-16 byte-order mark followed by undecodable data as UNRECOGNIZED, not as a parser failure', () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00, 0x00, 0xdc]);
    for (const name of ['board.cad', 'board.brd', 'board.kicad_pcb', 'board.bin']) expect(failure(() => parseBoard({ name, data: bytes })).code, name).toBe('UNRECOGNIZED');
  });
  it('rejects oversized input and companions with LIMIT_EXCEEDED before any parser runs', () => {
    const huge = new Uint8Array(MAX_IMPORT_BYTES + 1);
    expect(failure(() => parseBoard({ name: 'big.cad', data: huge })).code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => parseBoard({ name: 'format.asc', data: new Uint8Array(4), companions: { 'pins.asc': huge } })).code).toBe('LIMIT_EXCEEDED');
    expect(failure(() => parseBoard({ name: 'x.cad', data: 'text' as unknown as Uint8Array })).code).toBe('INVALID_FORMAT');
  });
  it('passes BoardFormatError through and wraps unexpected adapter failures with the parser id', () => {
    const boom = { id: 'boom', parse: () => { throw new RangeError('index out of range'); } };
    const strict = { id: 'strict', parse: () => { throw new BoardFormatError('needs a key', 'KEY_REQUIRED', 'FZ/CAE', 'fz'); } };
    PARSERS.unshift(boom);
    try {
      const error = failure(() => parseBoard(textInput(GENCAD, 'x.cad')));
      expect(error.message).toMatch(/^boom: unexpected parser failure: index out of range/);
      expect(error.format).toBe('boom'); expect(error.cause).toBeInstanceOf(RangeError);
    } finally { PARSERS.shift(); }
    PARSERS.unshift(strict);
    try {
      const error = failure(() => parseBoard(textInput(GENCAD, 'x.fz')));
      expect(error).toMatchObject({ code: 'KEY_REQUIRED', format: 'FZ/CAE', keyKind: 'fz', message: 'needs a key' });
    } finally { PARSERS.shift(); }
    expect(parseBoard(textInput(GENCAD, 'x.cad')).format).toBe('GENCAD 1.4');
  });
});

describe('GenCAD detection precedence', () => {
  // A valid BVR3 file that happens to carry a "GENCAD 1.4" line (an unknown keyword the BVR reader ignores).
  const BVR3_WITH_KEYWORD = ['BVRAW_FORMAT_3', '  GENCAD 1.4', 'PART_NAME U1', 'PART_SIDE T', 'PART_ORIGIN 100 100', 'PIN_NUMBER 1', 'PIN_SIDE T', 'PIN_ORIGIN 0 0', 'PIN_RADIUS 5', 'PIN_NET GND', 'PIN_END', 'PART_END'].join('\n') + '\n';
  it('claims a file by its $HEADER section marker, never by a loose GENCAD keyword, so other text formats keep their files', () => {
    const board = parseBoard(textInput(BVR3_WITH_KEYWORD, 'other.bvr'));
    expect(board.format).toBe('BVR raw boardview (BVRAW_FORMAT_3)');
    expect(board.components.map(component => component.ref)).toEqual(['U1']);
    expect(failure(() => parseBoard(textInput('GENCAD 1.4\nUNITS MM\n', 'loose.cad'))).code).toBe('UNRECOGNIZED');
    expect(failure(() => parseBoard(textInput(BVR3_WITH_KEYWORD.replace('BVRAW_FORMAT_3', 'BVRAW_FORMAT_2'), 'v2.bvr'))).code).toBe('UNSUPPORTED_VARIANT');
  });
  it('keeps the precise GenCAD errors once $HEADER is present, wherever it is in the first 16 KiB', () => {
    for (const [name, text] of [['junk-first.cad', 'LINE 0 0 1 1\n' + GENCAD], ['indented.cad', GENCAD.replace('$HEADER', '\t $HEADER \t')], ['crlf.cad', GENCAD.replace(/\n/g, '\r\n')], ['comments.cad', '# a\n; b\n// c\n' + GENCAD]]) {
      let caught: unknown;
      try { caught = parseBoard(textInput(text, name)); } catch (error) { caught = error; }
      if (name === 'junk-first.cad') { expect(caught).toBeInstanceOf(GenCadParseError); expect((caught as GenCadParseError).issue.key).toBe('parse.error.dataOutsideSection'); }
      else expect((caught as { format: string }).format, name).toBe('GENCAD 1.4');
    }
    expect(failure(() => parseBoard(textInput('$HEADERS\nGENCAD 1.4\n', 'marker.cad'))).code).toBe('UNRECOGNIZED');
  });
});

describe('byte-order-marked UTF-16 input', () => {
  /** UTF-16 with a byte-order mark, little- or big-endian (BMP text only). */
  const utf16 = (text: string, bigEndian = false): Uint8Array => {
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = bigEndian ? 0xfe : 0xff; out[1] = bigEndian ? 0xff : 0xfe;
    for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i); out[2 + i * 2] = bigEndian ? code >>> 8 : code & 255; out[3 + i * 2] = bigEndian ? code & 255 : code >>> 8; }
    return out;
  };
  const BVR3 = ['BVRAW_FORMAT_3', 'PART_NAME U1', 'PART_SIDE T', 'PART_ORIGIN 100 100', 'PIN_NUMBER 1', 'PIN_SIDE T', 'PIN_ORIGIN 0 0', 'PIN_RADIUS 5', 'PIN_NET GND', 'PIN_END', 'PART_END'].join('\r\n') + '\r\n';
  const header = (count: number, tag: string) => Array.from({ length: count }, (_, index) => `; ${tag} header ${index + 1}`);
  const BDV = ['<<format.asc>>', ...header(8, 'format'), '0.000 0.000', '2.000 0.000', '2.000 1.000', '0.000 1.000', '<<pins.asc>>', ...header(8, 'pins'), 'Part U1 (T)', '1  1  0.100 0.200  1  VCC  5', '<<nails.asc>>', ...header(7, 'nails')].join('\r\n') + '\r\n';
  const SAMSUNG = ['###Panel Added: synthetic sample', 'COMP  U1   PN-100  0  0  1.000  2.000  1  0', 'C_PIN  U1-1    1.000   2.000  0  0  0  X  /VCC'].join('\n') + '\n';
  const FZ = 'UNIT:thou\nA!REFDES!COMP_INSERTION_CODE!SYM_NAME!SYM_MIRROR!SYM_ROTATE!\nS!U1!!SOIC8!NO!0!\nA!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!TEST_POINT!RADIUS!\nS!GND!U1!1!VSS!1000!2000!!6!\n';
  const shape = (board: Board) => ({ format: board.format, components: board.components.map(component => [component.ref, component.side]), pins: board.pins.map(pin => [pin.number, pin.net, pin.x, pin.y, pin.side]) });

  it('is decoded once at the entry, so the adapters that sniff bytes open it like the ones that decode text', () => {
    for (const [name, text, format] of [['b.bvr', BVR3, 'BVR raw boardview (BVRAW_FORMAT_3)'], ['b.bdv', BDV, 'Honhan BDV'], ['b.cad', SAMSUNG, 'Samsung CAD'], ['b.fz', FZ, 'FZ (RC6)'], ['b.cad', GENCAD, 'GENCAD 1.4'], ['b.kicad_pcb', KICAD, 'KiCad PCB']] as const) {
      const expected = shape(parseBoard(textInput(text, name)));
      expect(expected.format, name).toBe(format);
      expect(shape(parseBoard({ name, data: utf16(text) })), `${name} little-endian`).toEqual(expected);
      expect(shape(parseBoard({ name, data: utf16(text, true) })), `${name} big-endian`).toEqual(expected);
    }
  });
  it('never mistakes plain UTF-16 FZ content for an encrypted container', () => {
    expect(parseBoard({ name: 'content.fz', data: utf16(FZ) }).format).toBe('FZ (RC6)');
    expect(failure(() => parseBoard({ name: 'notes.fz', data: utf16('hello world\nthis is text\n') })).code).toBe('UNRECOGNIZED');
  });
  it('decodes UTF-16 companions as well', () => {
    const format = [...header(8, 'format'), '0.000 0.000', '2.000 0.000', '2.000 1.000', '0.000 1.000'].join('\n') + '\n';
    const pins = [...header(8, 'pins'), 'Part U1 (T)', '1  1  0.100 0.200  1  VCC  5'].join('\n') + '\n';
    const nails = header(7, 'nails').join('\n') + '\n';
    const expected = shape(parseBoard({ name: 'format.asc', data: textInput(format).data, companions: { 'pins.asc': textInput(pins).data, 'nails.asc': textInput(nails).data } }));
    expect(expected.format).toBe('ASC companion trio');
    expect(shape(parseBoard({ name: 'format.asc', data: utf16(format), companions: { 'pins.asc': utf16(pins, true), 'nails.asc': textInput(nails).data } }))).toEqual(expected);
  });
});
