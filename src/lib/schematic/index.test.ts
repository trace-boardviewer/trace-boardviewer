import { describe, expect, it } from 'vitest';
import { loadSchematicDesign, parseSchematic, SCHEMATIC_CAPABILITIES, SCHEMATIC_PARSERS, SchematicError } from './index';
import { pinKey } from './model';
import type { SchematicDesign } from './model';

const enc = (text: string) => new TextEncoder().encode(text);
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROOT = U(1), CH = U(2), S1 = U(11), S2 = U(12), SYM = U(21), R10 = U(22);
const eff = '(effects (font (size 1.27 1.27)))';
const effHide = '(effects (font (size 1.27 1.27)) (hide yes))';
const pin = (at: string, number: string) => `(pin passive line (at ${at}) (length 1.27) (name "~" ${eff}) (number "${number}" ${eff}))`;
const R_LIB = `(symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (in_bom yes) (on_board yes)
  (property "Reference" "R" (at 0 6 0) ${eff}) (property "Value" "R" (at 0 -6 0) ${eff})
  (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "R_1_1" ${pin('0 3.81 270', '1')} ${pin('0 -3.81 90', '2')}))`;
const placed = (ref: string, uuid: string, at: string, inst: string) =>
  `(symbol (lib_id "Device:R") (at ${at} 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "${uuid}")
  (property "Reference" "${ref}" (at 0 0 0) ${eff}) (property "Value" "10k" (at 0 0 0) ${eff}) (property "Footprint" "" (at 0 0 0) ${effHide}) (property "Datasheet" "~" (at 0 0 0) ${effHide}) ${inst})`;
const wire = (a: string, b: string, id: number) => `(wire (pts (xy ${a}) (xy ${b})) (stroke (width 0) (type default)) (uuid "${U(id)}"))`;
const file = (uuid: string, body: string, tail = '') => `(kicad_sch (version 20231120) (generator "synthetic") (uuid "${uuid}") (paper "A4") (lib_symbols ${R_LIB}) ${body} ${tail})`;
const sheet = (uuid: string, name: string, at: string, pinAt: string) =>
  `(sheet (at ${at}) (size 30 20) (uuid "${uuid}") (property "Sheetname" "${name}" (at 0 0 0) ${eff}) (property "Sheetfile" "channel.kicad_sch" (at 0 0 0) ${eff})
  (pin "IN" input (at ${pinAt} 180) ${eff} (uuid "${U(Number(uuid.slice(-2)) + 60)}")))`;

/** The tips of an R at (x, y): pin 1 above, pin 2 below (library Y up flipped to schematic Y down). */
const tips = (x: number, y: number) => ({ one: `${x} ${y - 3.81 - 0}`, two: `${x} ${y + 3.81}` });

/**
 * Channel sheet: R (reference per instance R1 / R7) with pin 1 wired to a hierarchical label "IN" and pin 2 to a local label "MID".
 * Root: R10 whose pin 2 is wired to the sheet pin IN of ChanA only; ChanB's sheet pin is left open.
 */
function build(): { main: string; channel: string } {
  const channelR = tips(100, 50), rootR = tips(20, 20);
  const channel = file(CH,
    `${placed('R9', SYM, '100 50', `(instances (project "demo" (path "/${ROOT}/${S1}" (reference "R1") (unit 1)) (path "/${ROOT}/${S2}" (reference "R7") (unit 1))))`)}
     ${wire(channelR.one, '50 46.19', 61)} (hierarchical_label "IN" (shape input) (at 50 46.19 180) ${eff} (uuid "${U(62)}"))
     ${wire(channelR.two, '60 53.81', 63)} (label "MID" (at 60 53.81 0) ${eff} (uuid "${U(64)}"))`);
  const main = file(ROOT,
    `${sheet(S1, 'ChanA', '50 40', '50 46.19')} ${sheet(S2, 'ChanB', '50 80', '50 86.19')}
     ${placed('R10', R10, '20 20', `(instances (project "demo" (path "/${ROOT}" (reference "R10") (unit 1))))`)}
     ${wire(rootR.two, '20 46.19', 65)} ${wire('20 46.19', '50 46.19', 66)}`,
    '(sheet_instances (path "/" (page "1")))');
  return { main, channel };
}

describe('schematic dispatcher', () => {
  const GENERIC_XML = '<?xml version="1.0"?><eagle version="9.6.2"><drawing><board/></drawing></eagle>';

  it('registers the three parsers and publishes an exact capability table', () => {
    expect(SCHEMATIC_PARSERS.map(entry => entry.id)).toEqual(['kicad-sch', 'kicad-legacy-sch', 'eagle-sch']);
    expect(SCHEMATIC_CAPABILITIES.map(entry => entry.id)).toEqual(['kicad-sch', 'kicad-legacy-sch', 'eagle-sch']);
    expect(SCHEMATIC_CAPABILITIES.find(entry => entry.id === 'eagle-sch')?.connectivity).toBe('declared-nets');
  });

  it('recognizes by content, never by extension, and reports unrecognized input with its name', () => {
    const { main, channel } = build();
    expect(parseSchematic({ name: 'anything.txt', data: enc(main), companions: { 'channel.kicad_sch': enc(channel) } }).format).toBe('kicad-sch');
    for (const [name, data] of [['x.pdf', enc('%PDF-1.7\n1 0 obj\n')], ['board.brd', enc(GENERIC_XML)], ['empty.sch', new Uint8Array()], ['random.sch', Uint8Array.from([0, 1, 2, 255, 7])]] as const) {
      let error: unknown;
      try { parseSchematic({ name, data }); } catch (caught) { error = caught; }
      expect(error, name).toBeInstanceOf(SchematicError);
      expect((error as SchematicError).code).toBe('UNRECOGNIZED');
      expect((error as SchematicError).message).toContain(name);
    }
  });

  it('rejects oversized input and non-byte data before any parser runs', () => {
    const run = (input: Parameters<typeof parseSchematic>[0]) => { try { parseSchematic(input); } catch (error) { return error as SchematicError; } throw new Error('expected failure'); };
    expect(run({ name: 'x.sch', data: 'text' as unknown as Uint8Array }).code).toBe('INVALID_FORMAT');
    expect(run({ name: 'x.sch', data: new Uint8Array(64 * 1024 * 1024 + 1) }).code).toBe('LIMIT_EXCEEDED');
    expect(run({ name: 'x.sch', data: new Uint8Array(4), companions: { 'a.lib': 'x' as unknown as Uint8Array } }).code).toBe('INVALID_FORMAT');
  });

  it('passes recognized-but-malformed input through as a structured error with its format', () => {
    let error: unknown;
    try { parseSchematic({ name: 'broken.kicad_sch', data: enc('(kicad_sch (version 20231120) (uuid "x"') }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SchematicError);
    expect((error as SchematicError).format).toBe('kicad-sch');
  });
});

describe('parser output feeds the connectivity engine (repeated sub-sheet, hierarchical pins)', () => {
  const { main, channel } = build();
  const design: SchematicDesign = loadSchematicDesign({ name: 'main.kicad_sch', data: enc(main), companions: { 'channel.kicad_sch': enc(channel) } });
  const { schematic, connectivity } = design;
  const A = `/${S1}`, B = `/${S2}`;

  it('uses one canonical instance-path form between parser and engine', () => {
    expect(schematic.instances.map(instance => instance.path)).toEqual(['', A, B]);
    expect(schematic.diagnostics.filter(d => d.severity !== 'info')).toEqual([]);
    expect(connectivity.diagnostics.filter(d => ['SHEET_CHILD_MISSING', 'SHEET_INSTANCE_MISSING', 'SHEET_DEF_MISMATCH', 'INSTANCES_MISSING'].includes(d.code))).toEqual([]);
  });

  const memberOf = (ref: string, number: string) => {
    const hits = connectivity.nets.flatMap(net => net.members.filter(member => member.ref === ref && member.pinNumber === number).map(member => ({ net, member })));
    expect(hits, `${ref}.${number}`).toHaveLength(1);
    return hits[0]!;
  };

  it('keeps the repeated sheet instances apart and joins only the wired sheet pin through the hierarchy', () => {
    const r1 = memberOf('R1', '1'), r7 = memberOf('R7', '1'), r10 = memberOf('R10', '2');
    expect(r1.net.id).toBe(r10.net.id); // ChanA.IN is wired to R10.2 on the parent
    expect(r7.net.id).not.toBe(r10.net.id); // ChanB.IN is open: R7.1 must not collide with R1.1
    expect(r1.net.members.map(member => `${member.ref}.${member.pinNumber}`).sort()).toEqual(['R1.1', 'R10.2']);
    expect(r7.net.members.map(member => `${member.ref}.${member.pinNumber}`)).toEqual(['R7.1']);
    expect(r1.member.instancePath).toBe(A);
    expect(r7.member.instancePath).toBe(B);
  });

  it('scopes the local label MID to each sheet instance', () => {
    const mids = connectivity.nets.filter(net => net.name === 'MID');
    expect(mids).toHaveLength(2);
    expect(new Set(mids.map(net => net.id)).size).toBe(2);
    expect(mids.map(net => net.scopePath).sort()).toEqual([A, B].sort());
    expect(mids.every(net => net.scope === 'local' && net.members.length === 1)).toBe(true);
  });

  it('answers pin lookups through model pin keys', () => {
    const def = schematic.defs.find(d => d.id === 'channel.kicad_sch')!;
    const symbol = def.symbols[0]!;
    const pin1 = symbol.pins.find(pin => pin.number === '1')!;
    expect(connectivity.pinNet[pinKey(A, symbol.id, pin1.id)]).toBe(memberOf('R1', '1').net.id);
    expect(connectivity.pinNet[pinKey(B, symbol.id, pin1.id)]).toBe(memberOf('R7', '1').net.id);
  });
});

describe('byte-order-marked UTF-16 input', () => {
  const utf16 = (text: string, bigEndian = false): Uint8Array => {
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = bigEndian ? 0xfe : 0xff; out[1] = bigEndian ? 0xff : 0xfe;
    for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i); out[2 + i * 2] = bigEndian ? code >>> 8 : code & 255; out[3 + i * 2] = bigEndian ? code & 255 : code >>> 8; }
    return out;
  };
  const LEGACY = 'EESchema Schematic File Version 4\nEELAYER 30 0\nEELAYER END\n$Descr A4 11693 8268\n$EndDescr\nText Label 1000 1000 0 50 ~ 0\nNET1\n$EndSCHEMATC\n';

  it('is decoded once at the entry, so the readers that sniff their header on bytes open it, companions included', () => {
    const { main, channel } = build();
    const expected = parseSchematic({ name: 'main.kicad_sch', data: enc(main), companions: { 'channel.kicad_sch': enc(channel) } });
    expect(expected.format).toBe('kicad-sch');
    expect(expected.instances).toHaveLength(3);
    expect(parseSchematic({ name: 'main.kicad_sch', data: utf16(main), companions: { 'channel.kicad_sch': utf16(channel, true) } })).toEqual(expected);
    expect(parseSchematic({ name: 'main.kicad_sch', data: utf16(main, true), companions: { 'channel.kicad_sch': enc(channel) } })).toEqual(expected);
    const legacy = parseSchematic({ name: 'old.sch', data: enc(LEGACY) });
    expect(legacy.format).toBe('kicad-legacy-sch');
    expect(parseSchematic({ name: 'old.sch', data: utf16(LEGACY) })).toEqual(legacy);
    expect(parseSchematic({ name: 'old.sch', data: utf16(LEGACY, true) })).toEqual(legacy);
  });

  it('leaves a byte-order mark followed by undecodable data unrecognized', () => {
    let error: unknown;
    try { parseSchematic({ name: 'odd.kicad_sch', data: Uint8Array.from([0xff, 0xfe, 0x28, 0x00, 0x00, 0xd8, 0x41]) }); } catch (caught) { error = caught; }
    expect((error as SchematicError).code).toBe('UNRECOGNIZED');
  });
});
