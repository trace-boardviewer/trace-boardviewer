import { describe, expect, it } from 'vitest';
import { SCHEMATIC_LIMITS, SchematicError, symbolRef, type Schematic, type SchSymbol } from './model';
import { computeConnectivity } from './connectivity';
import { readSexpr } from './sexpr';
import { KICAD_SCH_MAX_VERSION, KICAD_SCH_MIN_VERSION, parseKicadSch, parseKicadSchWithLimits } from './kicad-sch';
import { expectCostAtMost } from '../../test-support/timing';

// ---------------------------------------------------------------------------------------------------------------
// Original synthetic fixtures (inline generators, no real KiCad project data).
// ---------------------------------------------------------------------------------------------------------------

const enc = (text: string) => new TextEncoder().encode(text);
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROOT = U(1);
const S1 = U(11);
const S2 = U(12);
const SYM1 = U(21);
const eff = '(effects (font (size 1.27 1.27)))';
const effHide = '(effects (font (size 1.27 1.27)) (hide yes))';

const file = (body: string, o: { version?: number; uuid?: string | null; lib?: string; paper?: string; tail?: string; head?: string } = {}) =>
  `(kicad_sch (version ${o.version ?? 20231120}) (generator "synthetic") (generator_version "8.0") ${o.uuid === null ? '' : `(uuid "${o.uuid ?? ROOT}")`} ${o.paper ?? '(paper "A4")'} ${o.head ?? ''} (lib_symbols ${o.lib ?? ''}) ${body} ${o.tail ?? ''})`;

const run = (text: string, companions: Record<string, string> = {}, name = 'main.kicad_sch', limits?: Partial<typeof SCHEMATIC_LIMITS>): Schematic => {
  const input = { name, data: enc(text), companions: Object.fromEntries(Object.entries(companions).map(([k, v]) => [k, enc(v)])) };
  const result = limits ? parseKicadSchWithLimits(input, limits) : parseKicadSch(input);
  if (!result) throw new Error('unexpectedly unrecognized');
  return result;
};

const fails = (fn: () => unknown, code: string, message?: RegExp): SchematicError => {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(SchematicError);
    const e = error as SchematicError;
    expect(e.code, e.message).toBe(code);
    expect(e.format).toBe('kicad-sch');
    if (message) expect(e.message).toMatch(message);
    return e;
  }
  throw new Error('expected a SchematicError');
};

const pin = (type: string, at: string, length: number, number: string, name = '~', extra = '') =>
  `(pin ${type} line (at ${at}) (length ${length}) ${extra} (name "${name}" ${eff}) (number "${number}" ${eff}))`;

const props = (ref: string, value: string) =>
  `(property "Reference" "${ref}" (at 0 6 0) ${eff}) (property "Value" "${value}" (at 0 -6 0) ${eff}) (property "Footprint" "" (at 0 0 0) ${effHide}) (property "Datasheet" "~" (at 0 0 0) ${effHide})`;

const R_LIB = `(symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  ${props('R', 'R')}
  (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "R_1_1" ${pin('passive', '0 3.81 270', 1.27, '1')} ${pin('passive', '0 -3.81 90', 1.27, '2')}))`;

const ASYM_LIB = `(symbol "Test:Asym" (in_bom yes) (on_board yes) ${props('U', 'Asym')}
  (symbol "Asym_0_1" (rectangle (start -2.54 -5.08) (end 2.54 5.08) (stroke (width 0.254) (type default)) (fill (type background))))
  (symbol "Asym_1_1" ${pin('input', '-5.08 2.54 0', 2.54, '1', 'A')} ${pin('output', '5.08 -2.54 180', 2.54, '2', 'B')}))`;

interface Placed {
  lib?: string; at?: string; mirror?: string; unit?: number; convert?: string; ref?: string; value?: string; uuid?: string;
  footprint?: string; inst?: string; extra?: string; dnp?: string; inBom?: string; onBoard?: string; hiddenFlags?: boolean;
}
const placed = (o: Placed = {}) =>
  `(symbol (lib_id "${o.lib ?? 'Device:R'}") (at ${o.at ?? '100 50 0'}) ${o.mirror ? `(mirror ${o.mirror})` : ''} (unit ${o.unit ?? 1}) ${o.convert ?? ''} (exclude_from_sim no) (in_bom ${o.inBom ?? 'yes'}) (on_board ${o.onBoard ?? 'yes'}) (dnp ${o.dnp ?? 'no'}) (uuid "${o.uuid ?? SYM1}")
  (property "Reference" "${o.ref ?? 'R1'}" (at 102 50 90) ${eff}) (property "Value" "${o.value ?? '10k'}" (at 98 50 90) ${eff})
  (property "Footprint" "${o.footprint ?? 'Resistor_SMD:R_0603_1608Metric'}" (at 98 50 90) ${effHide}) (property "Datasheet" "~" (at 100 50 0) ${effHide})
  ${o.extra ?? ''} ${o.inst ?? ''})`;

const instances = (entries: Array<[path: string, ref: string, unit?: number]>, project = 'demo') =>
  `(instances (project "${project}" ${entries.map(([p, r, u = 1]) => `(path "${p}" (reference "${r}") (unit ${u}))`).join(' ')}))`;

const sheet = (o: { uuid: string; name: string; file: string; at?: string; pins?: string; pages?: Array<[string, string]>; v6?: boolean }) =>
  `(sheet (at ${o.at ?? '50 50'}) (size 30 20) (fields_autoplaced yes) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0)) (uuid "${o.uuid}")
  (property "${o.v6 ? 'Sheet name' : 'Sheetname'}" "${o.name}" (at 50 49 0) ${eff}) (property "${o.v6 ? 'Sheet file' : 'Sheetfile'}" "${o.file}" (at 50 71 0) ${eff})
  ${o.pins ?? ''} ${o.pages ? `(instances (project "demo" ${o.pages.map(([p, n]) => `(path "${p}" (page "${n}"))`).join(' ')}))` : ''})`;

const wire = (a: string, b: string, id: string) => `(wire (pts (xy ${a}) (xy ${b})) (stroke (width 0) (type default)) (uuid "${id}"))`;

const single = (extra = '', placedOpts: Placed = {}) =>
  file(`${placed({ inst: instances([[`/${ROOT}`, 'R1']]), ...placedOpts })} ${extra}`, { lib: R_LIB, tail: `(sheet_instances (path "/" (page "1")))` });

const symbolsOf = (s: Schematic, defIndex = 0): SchSymbol[] => s.defs[defIndex]!.symbols;
const sorted = (o: object) => Object.keys(o).sort();

// ---------------------------------------------------------------------------------------------------------------

describe('recognition', () => {
  it('returns null for anything that is not a KiCad s-expression schematic', () => {
    const cases: Array<string | Uint8Array> = [
      '', '   \n', 'hello', '(kicad_pcb (version 20240108) (generator "x"))', '(kicad_symbol_lib (version 20231120))',
      'EESchema Schematic File Version 4\nEELAYER 30 0', '<?xml version="1.0"?><eagle version="9.6"></eagle>', '(kicad_sch_extra (version 1))',
      '(kicadsch)', '"(kicad_sch"', new Uint8Array([0, 1, 2, 3, 255, 254, 253]), new Uint8Array([0xff, 0xfe, 0x28, 0x00]),
    ];
    for (const sample of cases) expect(parseKicadSch({ name: 'x.kicad_sch', data: typeof sample === 'string' ? enc(sample) : sample })).toBeNull();
  });

  it('accepts a UTF-8 BOM and leading whitespace before "(kicad_sch"', () => {
    const text = single();
    for (const prefix of ['﻿', '  \r\n\t', '﻿ \n']) expect(run(prefix + text).defs).toHaveLength(1);
    expect(run(text.replace('(kicad_sch', '( kicad_sch')).defs).toHaveLength(1);
  });

  it('throws INVALID_FORMAT when the content is recognized but truncated', () => {
    fails(() => run('(kicad_sch'), 'INVALID_FORMAT');
    fails(() => run('(kicad_sch (version 20231120) (generator "x")'), 'INVALID_FORMAT', /unclosed/i);
  });
});

describe('versions', () => {
  it('declares the validated KiCad 6..9 range', () => {
    expect([KICAD_SCH_MIN_VERSION, KICAD_SCH_MAX_VERSION]).toEqual([20211123, 20250114]);
  });

  it('accepts every version inside the range and names it in the label', () => {
    for (const version of [20211123, 20220914, 20230121, 20231120, 20240608, 20250114]) {
      const s = run(file('', { version }));
      expect(s.formatLabel).toBe(`KiCad schematic (version ${version})`);
      expect(s.format).toBe('kicad-sch');
      expect(s.sourceUnit).toBe('mm');
    }
  });

  it('rejects older and newer versions with UNSUPPORTED_VARIANT carrying the exact version', () => {
    fails(() => run(file('', { version: 20211122 })), 'UNSUPPORTED_VARIANT', /20211122/);
    fails(() => run(file('', { version: 20200310 })), 'UNSUPPORTED_VARIANT', /20200310/);
    fails(() => run(file('', { version: 20250115 })), 'UNSUPPORTED_VARIANT', /20250115/);
    fails(() => run(file('', { version: 20991231 })), 'UNSUPPORTED_VARIANT', /20991231/);
  });

  it('rejects a missing or malformed (version)', () => {
    fails(() => run('(kicad_sch (generator "x") (uuid "a"))'), 'INVALID_FORMAT', /version/);
    fails(() => run('(kicad_sch (version "20231120") (generator "x"))'), 'INVALID_FORMAT', /version/);
    fails(() => run('(kicad_sch (version abc) (generator "x"))'), 'INVALID_FORMAT', /version/);
    fails(() => run('(kicad_sch (version 6) (generator "x"))'), 'INVALID_FORMAT', /version/);
    fails(() => run('(kicad_sch (version 20231120.5) (generator "x"))'), 'INVALID_FORMAT', /version/);
  });
});

describe('placed symbols', () => {
  it('resolves a resistor to absolute millimetre geometry with per-instance references', () => {
    const s = run(single());
    expect(s.name).toBe('main');
    expect(s.rootDefId).toBe('main.kicad_sch');
    expect(s.diagnostics).toEqual([]);
    const def = s.defs[0]!;
    expect(def).toMatchObject({ id: 'main.kicad_sch', name: 'main', file: 'main.kicad_sch', uuid: ROOT, title: '', paper: { width: 297, height: 210 } });
    const r = def.symbols[0]!;
    expect(r).toMatchObject({
      id: SYM1, libId: 'Device:R', refDefault: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0603_1608Metric', datasheet: '~',
      unit: 1, unitCount: 1, at: { x: 100, y: 50 }, rotation: 0, mirror: 'none', virtual: false, dnp: false,
    });
    expect(r.instances).toEqual({ '': { ref: 'R1', unit: 1 } });
    expect(symbolRef(r, '')).toBe('R1');
    expect(r.pins).toEqual([
      { id: `${SYM1}#1`, number: '1', name: '', at: { x: 100, y: 46.19 }, body: { x: 100, y: 47.46 }, type: 'passive', hidden: false, unit: 1 },
      { id: `${SYM1}#2`, number: '2', name: '', at: { x: 100, y: 53.81 }, body: { x: 100, y: 52.54 }, type: 'passive', hidden: false, unit: 1 },
    ]);
    expect(r.graphics).toEqual([{ kind: 'rect', min: { x: 98.984, y: 47.46 }, max: { x: 101.016, y: 52.54 }, width: 0.254, fill: 'none' }]);
    expect(r.bounds).toEqual({ minX: 98.984, minY: 46.19, maxX: 101.016, maxY: 53.81 });
    expect(r.fields.map((f) => [f.name, f.value, f.hidden])).toEqual([['Reference', 'R1', false], ['Value', '10k', false], ['Footprint', 'Resistor_SMD:R_0603_1608Metric', true], ['Datasheet', '~', true]]);
    expect(r.fields[0]).toMatchObject({ at: { x: 102, y: 50 }, angle: 90 });
    expect(def.bounds).toEqual(r.bounds);
  });

  // Hand-derived: library Y-up -> sheet Y-down, rotation counter-clockwise on screen, then mirror in the sheet frame.
  // Pin 1 sits at library (-5.08, 2.54) pointing +x (length 2.54); pin 2 is its point reflection through the origin.
  const MATRIX: Array<[mirror: string, rot: number, ax: number, ay: number, bx: number, by: number]> = [
    ['', 0, 94.92, 47.46, 97.46, 47.46], ['', 90, 97.46, 55.08, 97.46, 52.54], ['', 180, 105.08, 52.54, 102.54, 52.54], ['', 270, 102.54, 44.92, 102.54, 47.46],
    ['x', 0, 94.92, 52.54, 97.46, 52.54], ['x', 90, 97.46, 44.92, 97.46, 47.46], ['x', 180, 105.08, 47.46, 102.54, 47.46], ['x', 270, 102.54, 55.08, 102.54, 52.54],
    ['y', 0, 105.08, 47.46, 102.54, 47.46], ['y', 90, 102.54, 55.08, 102.54, 52.54], ['y', 180, 94.92, 52.54, 97.46, 52.54], ['y', 270, 97.46, 44.92, 97.46, 47.46],
  ];
  it.each(MATRIX)('places pins/body exactly for mirror=%j rotation=%i', (mirror, rot, ax, ay, bx, by) => {
    const s = run(file(placed({ lib: 'Test:Asym', ref: 'U1', at: `100 50 ${rot}`, mirror }), { lib: ASYM_LIB }));
    const u = symbolsOf(s)[0]!;
    expect(u.rotation).toBe(rot);
    expect(u.mirror).toBe(mirror || 'none');
    const [a, b] = u.pins;
    expect(a).toMatchObject({ number: '1', name: 'A', type: 'input', at: { x: ax, y: ay }, body: { x: bx, y: by } });
    expect(b).toMatchObject({ number: '2', name: 'B', type: 'output', at: { x: 200 - ax, y: 100 - ay }, body: { x: 200 - bx, y: 100 - by } });
    const rect = u.graphics[0]!;
    expect(rect).toMatchObject({ kind: 'rect', fill: 'background' });
    const quarter = rot === 90 || rot === 270;
    expect(rect).toMatchObject(quarter
      ? { min: { x: 94.92, y: 47.46 }, max: { x: 105.08, y: 52.54 } }
      : { min: { x: 97.46, y: 44.92 }, max: { x: 102.54, y: 55.08 } });
    expect(u.bounds).toEqual({ minX: 94.92, minY: 44.92, maxX: 105.08, maxY: 55.08 });
  });

  it('rejects symbol rotations that are not multiples of 90 and unknown mirrors', () => {
    fails(() => run(file(placed({ lib: 'Test:Asym', at: '100 50 45' }), { lib: ASYM_LIB })), 'INVALID_FORMAT', /rotation/);
    fails(() => run(file(placed({ lib: 'Test:Asym', mirror: 'z' }), { lib: ASYM_LIB })), 'INVALID_FORMAT', /mirror/);
    // negative and large angles are normalized
    const s = run(file(placed({ lib: 'Test:Asym', at: '100 50 -90' }), { lib: ASYM_LIB }));
    expect(symbolsOf(s)[0]!.rotation).toBe(270);
  });

  it('keeps pin numbers exactly as written and keeps pin ids unique for repeated numbers', () => {
    const lib = `(symbol "Test:Bga" ${props('U', 'Bga')}
      (symbol "Bga_1_1" ${pin('passive', '-5.08 0 0', 2.54, 'A12', 'X')} ${pin('passive', '-5.08 2.54 0', 2.54, '01', 'Y')} ${pin('power_in', '0 5.08 270', 2.54, '5', 'GND')}
        ${pin('power_in', '0 -5.08 90', 2.54, '5', 'GND')} ${pin('power_in', '2.54 -5.08 90', 2.54, '5', 'GND')} ${pin('passive', '5.08 0 180', 2.54, 'VCC', '~RESET')}))`;
    const u = symbolsOf(run(file(placed({ lib: 'Test:Bga', ref: 'U1' }), { lib })))[0]!;
    expect(u.pins.map((p) => p.number)).toEqual(['A12', '01', '5', '5', '5', 'VCC']);
    expect(u.pins.map((p) => p.name)).toEqual(['X', 'Y', 'GND', 'GND', 'GND', '~RESET']);
    expect(new Set(u.pins.map((p) => p.id)).size).toBe(6);
    expect(u.pins[0]!.id).toBe(`${SYM1}#A12`);
  });

  it('flags DNP, hides power/virtual references and keeps off-board parts out of cross-probing', () => {
    expect(symbolsOf(run(single('', { dnp: 'yes' })))[0]!.dnp).toBe(true);
    const virtual = (ref: string, extra: Placed = {}) => symbolsOf(run(file(placed({ ref, ...extra }), { lib: R_LIB })))[0]!.virtual;
    expect(virtual('R1')).toBe(false);
    expect(virtual('#PWR01')).toBe(true);
    expect(virtual('#FLG02')).toBe(true);
    expect(virtual('R1', { onBoard: 'no' })).toBe(true);
    expect(virtual('R1', { inBom: 'no' })).toBe(false);
  });

  it('reports symbols whose library definition is absent and gives them no pins or graphics', () => {
    const s = run(file(placed({ lib: 'Nope:Missing', ref: 'U9' }), { lib: R_LIB }));
    const u = symbolsOf(s)[0]!;
    expect(u).toMatchObject({ libId: 'Nope:Missing', refDefault: 'U9', pins: [], graphics: [], unitCount: 1 });
    expect(s.diagnostics).toEqual([expect.objectContaining({ code: 'LIB_SYMBOL_MISSING', severity: 'warning', defId: 'main.kicad_sch' })]);
    expect(s.diagnostics[0]!.message).toContain('Nope:Missing');
    // no lib_symbols section at all behaves the same
    const bare = run(`(kicad_sch (version 20231120) (generator "x") (uuid "${ROOT}") ${placed({ lib: 'Device:R' })})`);
    expect(symbolsOf(bare)[0]!.pins).toEqual([]);
    expect(bare.diagnostics.map((d) => d.code)).toEqual(['LIB_SYMBOL_MISSING']);
  });

  it('draws multi-unit parts as separate symbols sharing a reference, each with its own unit pins plus unit 0 pins', () => {
    const lib = `(symbol "Test:Dual" ${props('U', 'Dual')}
      (symbol "Dual_0_1" ${pin('power_in', '0 7.62 270', 2.54, '9', 'V+')} (rectangle (start -2 -2) (end 2 2) (stroke (width 0) (type default)) (fill (type none))))
      (symbol "Dual_1_1" ${pin('input', '-5.08 0 0', 2.54, '1', 'IN1')} ${pin('output', '5.08 0 180', 2.54, '2', 'OUT1')} (circle (center 0 0) (radius 1) (stroke (width 0) (type default)) (fill (type outline))))
      (symbol "Dual_2_1" ${pin('input', '-5.08 0 0', 2.54, '3', 'IN2')} ${pin('output', '5.08 0 180', 2.54, '4', 'OUT2')} (polyline (pts (xy -1 -1) (xy 1 1)) (stroke (width 0.2) (type default)) (fill (type none)))))`;
    const A = U(31);
    const B = U(32);
    const body = placed({ lib: 'Test:Dual', ref: 'U1', uuid: A, unit: 1, at: '100 50 0', inst: instances([[`/${ROOT}`, 'U1', 1]]) })
      + placed({ lib: 'Test:Dual', ref: 'U1', uuid: B, unit: 2, at: '100 80 0', inst: instances([[`/${ROOT}`, 'U1', 2]]) });
    const [u1, u2] = symbolsOf(run(file(body, { lib })));
    expect(u1).toMatchObject({ id: A, unit: 1, unitCount: 2, refDefault: 'U1' });
    expect(u2).toMatchObject({ id: B, unit: 2, unitCount: 2, refDefault: 'U1' });
    expect(u1!.pins.map((p) => [p.number, p.unit])).toEqual([['9', 0], ['1', 1], ['2', 1]]);
    expect(u2!.pins.map((p) => [p.number, p.unit])).toEqual([['9', 0], ['3', 2], ['4', 2]]);
    expect(u1!.graphics.map((g) => g.kind)).toEqual(['rect', 'circle']);
    expect(u2!.graphics.map((g) => g.kind)).toEqual(['rect', 'poly']);
    expect(u1!.instances['']).toEqual({ ref: 'U1', unit: 1 });
    expect(u2!.instances['']).toEqual({ ref: 'U1', unit: 2 });
    expect(u1!.pins[0]!.id).not.toBe(u2!.pins[0]!.id);
    expect(u2!.pins[1]!.at).toEqual({ x: 94.92, y: 80 });
  });

  it('selects the alternate body style from (convert N) and (body_style N)', () => {
    const lib = `(symbol "Test:Gate" ${props('U', 'Gate')}
      (symbol "Gate_1_1" (rectangle (start -2 -2) (end 2 2) (stroke (width 0) (type default)) (fill (type none))) ${pin('input', '-4 0 0', 2, '1')})
      (symbol "Gate_1_2" (circle (center 0 0) (radius 2) (stroke (width 0) (type default)) (fill (type none))) ${pin('input', '-4 1 0', 2, '1')}))`;
    const kinds = (convert: string) => symbolsOf(run(file(placed({ lib: 'Test:Gate', convert }), { lib })))[0]!;
    expect(kinds('').graphics.map((g) => g.kind)).toEqual(['rect']);
    expect(kinds('(convert 1)').graphics.map((g) => g.kind)).toEqual(['rect']);
    expect(kinds('(convert 2)').graphics.map((g) => g.kind)).toEqual(['circle']);
    expect(kinds('(body_style 2)').graphics.map((g) => g.kind)).toEqual(['circle']);
    expect(kinds('(convert 2)').pins[0]!.at).toEqual({ x: 96, y: 49 });
  });

  it('inherits the body of a base symbol through (extends) and uses (lib_name) when present', () => {
    const lib = `${R_LIB}
      (symbol "Device:R_Small" (extends "Device:R") ${props('R', 'R_Small')})`;
    const small = symbolsOf(run(file(placed({ lib: 'Device:R_Small' }), { lib })))[0]!;
    expect(small.pins.map((p) => p.number)).toEqual(['1', '2']);
    expect(small.graphics).toHaveLength(1);
    fails(() => run(file(placed({ lib: 'A:A' }), { lib: `(symbol "A:A" (extends "B:B") ${props('A', 'A')}) (symbol "B:B" (extends "A:A") ${props('B', 'B')})` })), 'INVALID_FORMAT', /extends/);
    const missing = run(file(placed({ lib: 'A:A' }), { lib: `(symbol "A:A" (extends "B:B") ${props('A', 'A')})` }));
    expect(missing.diagnostics.map((d) => d.code)).toEqual(['LIB_SYMBOL_MISSING']);
    const lib2 = `${R_LIB} (symbol "R_1" ${props('R', 'R')} (symbol "R_1_1" ${pin('passive', '1 0 0', 1, 'X')}))`;
    const named = symbolsOf(run(file(placed({ extra: '(lib_name "R_1")' }), { lib: lib2 })))[0]!;
    expect(named.pins.map((p) => p.number)).toEqual(['X']);
  });
});

describe('power symbols and implicit power pins', () => {
  const PWR_LIB = `(symbol "power:+5V" (power) (pin_names (offset 0)) (in_bom yes) (on_board yes) ${props('#PWR', '+5V')}
      (symbol "+5V_0_1" (polyline (pts (xy -0.762 1.27) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none))))
      (symbol "+5V_1_1" ${pin('power_in', '0 0 90', 0, '1', '+5V', 'hide')}))
    (symbol "power:GND" (power global) (pin_names (offset 0)) (in_bom yes) (on_board yes) ${props('#PWR', 'GND')}
      (symbol "GND_1_1" ${pin('power_in', '0 0 270', 0, '1', 'GND', '(hide yes)')}))
    (symbol "power:PWR_LOCAL" (power local) ${props('#PWR', 'LOC')} (symbol "PWR_LOCAL_1_1" ${pin('power_in', '0 0 270', 0, '1', 'LOC', '(hide yes)')}))
    (symbol "Test:Mcu" (in_bom yes) (on_board yes) ${props('U', 'Mcu')}
      (symbol "Mcu_1_1" ${pin('input', '-5.08 0 0', 2.54, '1', 'IO')} ${pin('power_in', '0 5.08 270', 2.54, '8', 'VDD', '(hide yes)')}
        ${pin('power_in', '0 -5.08 90', 2.54, '4', 'GND', 'hide')} ${pin('power_in', '5.08 0 180', 2.54, '7', 'VBAT')}
        ${pin('passive', '5.08 2.54 180', 2.54, '6', 'NC', 'hide')} ${pin('power_in', '5.08 -2.54 180', 2.54, '5', '~', 'hide')}))`;

  it('marks power symbols with the net named by their Value (not the library name) and keeps them virtual', () => {
    const body = placed({ lib: 'power:+5V', ref: '#PWR01', value: '+5V', uuid: U(41), at: '60 30 0' })
      + placed({ lib: 'power:GND', ref: '#PWR02', value: 'AGND', uuid: U(42), at: '60 80 0' });
    const s = run(file(body, { lib: PWR_LIB }));
    const [vcc, gnd] = symbolsOf(s);
    expect(vcc).toMatchObject({ power: { net: '+5V' }, virtual: true, refDefault: '#PWR01' });
    expect(gnd).toMatchObject({ power: { net: 'AGND' }, virtual: true });
    expect(vcc!.pins).toHaveLength(1);
    expect(vcc!.pins[0]).toMatchObject({ hidden: true, type: 'power_in', name: '+5V', at: { x: 60, y: 30 }, body: { x: 60, y: 30 } });
    expect(vcc!.pins[0]).not.toHaveProperty('implicitNet');
    expect(gnd!.pins[0]).not.toHaveProperty('implicitNet');
    expect(s.diagnostics).toEqual([]);
  });

  it('does not claim a global net for local power symbols (KiCad 9) and says so', () => {
    const s = run(file(placed({ lib: 'power:PWR_LOCAL', ref: '#PWR03', value: 'LOC' }), { lib: PWR_LIB }));
    expect(symbolsOf(s)[0]!.power).toBeUndefined();
    expect(symbolsOf(s)[0]!.virtual).toBe(true);
    expect(s.diagnostics).toEqual([expect.objectContaining({ code: 'POWER_LOCAL_UNSUPPORTED', severity: 'warning' })]);
  });

  it('gives hidden power-input pins an implicit global net named by the pin (bare hide and (hide yes))', () => {
    const s = run(file(placed({ lib: 'Test:Mcu', ref: 'U1' }), { lib: PWR_LIB }));
    const byNumber = Object.fromEntries(symbolsOf(s)[0]!.pins.map((p) => [p.number, p]));
    expect(byNumber['8']).toMatchObject({ hidden: true, implicitNet: 'VDD' });
    expect(byNumber['4']).toMatchObject({ hidden: true, implicitNet: 'GND' });
    expect(byNumber['7']).toMatchObject({ hidden: false });
    expect(byNumber['7']).not.toHaveProperty('implicitNet'); // visible power pin: wired explicitly
    expect(byNumber['1']).not.toHaveProperty('implicitNet');
    expect(byNumber['6']).toMatchObject({ hidden: true });
    expect(byNumber['6']).not.toHaveProperty('implicitNet'); // hidden but not a power input
    expect(byNumber['5']).toMatchObject({ hidden: true, name: '' });
    expect(byNumber['5']).not.toHaveProperty('implicitNet');
    expect(s.diagnostics).toEqual([expect.objectContaining({ code: 'HIDDEN_POWER_PIN_UNNAMED', severity: 'info' })]);
  });
});

describe('wires, buses, labels and markers', () => {
  const BODY = `
    ${wire('60 20', '80 20', U(51))}
    (bus (pts (xy 50 40) (xy 90 40)) (stroke (width 0) (type default)) (uuid "${U(52)}"))
    (bus_entry (at 60 40) (size 2.54 -2.54) (stroke (width 0) (type default)) (uuid "${U(53)}"))
    (junction (at 80 20) (diameter 0) (color 0 0 0 0) (uuid "${U(54)}"))
    (no_connect (at 70 30) (uuid "${U(55)}"))
    (label "NET_A" (at 70 20 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${U(56)}"))
    (global_label "VBUS" (shape input) (at 80 30 180) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify right)) (uuid "${U(57)}")
      (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 80 30 0) ${effHide}))
    (hierarchical_label "SCLK" (shape bidirectional) (at 90 20 90) ${eff} (uuid "${U(58)}"))
    (label "D[0..7]" (at 50 40 270) ${eff} (uuid "${U(59)}"))
    (global_label "{A B}" (shape tri_state) (at 40 40 0) ${eff} (uuid "${U(60)}"))
    (hierarchical_label "RST" (shape passive) (at 40 50 0) ${eff} (uuid "${U(61)}"))
    (hierarchical_label "OUT" (shape output) (at 40 60 0) ${eff} (uuid "${U(62)}"))`;

  it('reads wires, buses, bus entries, junctions and no-connects with their uuids', () => {
    const def = run(file(BODY)).defs[0]!;
    expect(def.wires).toEqual([{ id: U(51), a: { x: 60, y: 20 }, b: { x: 80, y: 20 } }]);
    expect(def.buses).toEqual([{ id: U(52), a: { x: 50, y: 40 }, b: { x: 90, y: 40 } }]);
    expect(def.busEntries).toEqual([{ id: U(53), at: { x: 60, y: 40 }, to: { x: 62.54, y: 37.46 } }]);
    expect(def.junctions).toEqual([{ id: U(54), at: { x: 80, y: 20 } }]);
    expect(def.noConnects).toEqual([{ id: U(55), at: { x: 70, y: 30 } }]);
  });

  it('keeps the three label kinds apart with text exactly as written, angle and shape', () => {
    const labels = run(file(BODY)).defs[0]!.labels;
    expect(labels.map((l) => [l.kind, l.text, l.angle, l.shape])).toEqual([
      ['local', 'NET_A', 0, undefined],
      ['global', 'VBUS', 180, 'input'],
      ['hierarchical', 'SCLK', 90, 'bidirectional'],
      ['local', 'D[0..7]', 270, undefined],
      ['global', '{A B}', 0, 'tri_state'],
      ['hierarchical', 'RST', 0, 'passive'],
      ['hierarchical', 'OUT', 0, 'output'],
    ]);
    expect(labels[0]).toEqual({ id: U(56), kind: 'local', text: 'NET_A', at: { x: 70, y: 20 }, angle: 0 });
    expect(labels[1]!.id).toBe(U(57));
  });

  it('rejects malformed electrical records instead of guessing', () => {
    fails(() => run(file('(wire (pts (xy 1 1)) (uuid "a"))')), 'INVALID_FORMAT', /wire.*2 points/);
    fails(() => run(file('(wire (pts (xy 1 1) (xy 2 2) (xy 3 3)) (uuid "a"))')), 'INVALID_FORMAT', /wire.*2 points/);
    fails(() => run(file('(wire (uuid "a"))')), 'INVALID_FORMAT', /wire/);
    fails(() => run(file('(junction (uuid "a"))')), 'INVALID_FORMAT', /junction.*\(at/);
    fails(() => run(file('(no_connect (at 1))')), 'INVALID_FORMAT', /no_connect/);
    fails(() => run(file('(global_label "X" (shape sideways) (at 1 1 0))')), 'INVALID_FORMAT', /shape/);
    fails(() => run(file('(bus_entry (at 1 1))')), 'INVALID_FORMAT', /size/);
    fails(() => run(file('(label (at 1 1 0))')), 'INVALID_FORMAT', /label/);
  });

  it('skips a label without text and says so', () => {
    const s = run(file('(label "" (at 1 1 0) (uuid "e"))'));
    expect(s.defs[0]!.labels).toEqual([]);
    expect(s.diagnostics).toEqual([expect.objectContaining({ code: 'LABEL_EMPTY', severity: 'warning' })]);
  });

  it('rejects absurd and non-finite numbers', () => {
    fails(() => run(file(wire('0 0', '1e30 0', 'w'))), 'LIMIT_EXCEEDED', /coordinate/i);
    fails(() => run(file(wire('0 0', '2000000 0', 'w'))), 'LIMIT_EXCEEDED', /1000000/);
    fails(() => run(file(wire('0 0', '1e999 0', 'w'))), 'INVALID_FORMAT', /finite|number/);
    fails(() => run(file(wire('0 0', 'abc 0', 'w'))), 'INVALID_FORMAT', /number/);
    fails(() => run(file(wire('0 0', 'nan 0', 'w'))), 'INVALID_FORMAT', /number/);
    fails(() => run(file('(junction (at "1" 2) (uuid "j"))')), 'INVALID_FORMAT', /quoted/);
    const ok = run(file(wire('-1000000 0', '1000000 0', 'w')));
    expect(ok.defs[0]!.wires[0]!.a.x).toBe(-1000000);
  });

  it('snaps coordinates to the 0.1 µm schematic grid so equal points compare equal', () => {
    const def = run(file(`${wire('10.123456 20.00004', '30.12344 40.00006', 'w')} (junction (at 10.1235 20) (uuid "j"))`)).defs[0]!;
    expect(def.wires[0]).toEqual({ id: 'w', a: { x: 10.1235, y: 20 }, b: { x: 30.1234, y: 40.0001 } });
    expect(def.junctions[0]!.at.x).toBe(def.wires[0]!.a.x);
  });
});

describe('graphics, text, title block and paper', () => {
  it('converts sheet-level graphics, sampling arcs into polylines through their midpoint', () => {
    const body = `
      (polyline (pts (xy 10 10) (xy 20 10) (xy 20 20)) (stroke (width 0.3) (type dash)) (uuid "${U(70)}"))
      (rectangle (start 30 30) (end 20 25) (stroke (width 0.1) (type default)) (fill (type background)) (uuid "${U(71)}"))
      (circle (center 40 40) (radius 3) (stroke (width 0) (type default)) (fill (type outline)) (uuid "${U(72)}"))
      (arc (start 10 10) (mid 15 5) (end 20 10) (stroke (width 0.2) (type default)) (fill (type none)) (uuid "${U(73)}"))
      (text "Note" (exclude_from_sim no) (at 10 12 90) (effects (font (size 2 2) (bold yes) italic) (justify left bottom)) (uuid "${U(74)}"))
      (text "Right" (at 10 14 0) (effects (font (size 1.5 1.5))) (uuid "${U(75)}"))`;
    const g = run(file(body)).defs[0]!.graphics;
    expect(g[0]).toEqual({ kind: 'poly', points: [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }], width: 0.3, filled: false });
    expect(g[1]).toEqual({ kind: 'rect', min: { x: 20, y: 25 }, max: { x: 30, y: 30 }, width: 0.1, fill: 'background' });
    expect(g[2]).toEqual({ kind: 'circle', center: { x: 40, y: 40 }, radius: 3, width: 0, fill: 'outline' });
    const arc = g[3]!;
    if (arc.kind !== 'poly') throw new Error('arc must be sampled to a polyline');
    expect(arc.width).toBe(0.2);
    expect(arc.filled).toBe(false);
    expect(arc.points[0]).toEqual({ x: 10, y: 10 });
    expect(arc.points[arc.points.length - 1]).toEqual({ x: 20, y: 10 });
    expect(arc.points.length).toBeGreaterThanOrEqual(8);
    for (const p of arc.points) {
      expect(Math.hypot(p.x - 15, p.y - 10)).toBeCloseTo(5, 3); // circle through the three points
      expect(p.y).toBeLessThanOrEqual(10.0001); // the arc passes through the midpoint above the chord (Y down)
    }
    expect(Math.min(...arc.points.map((p) => p.y))).toBeCloseTo(5, 2);
    for (let i = 1; i < arc.points.length; i++) expect(arc.points[i]!.x).toBeGreaterThan(arc.points[i - 1]!.x);
    expect(g[4]).toEqual({ kind: 'text', at: { x: 10, y: 12 }, text: 'Note', angle: 90, size: 2, anchor: 'start', bold: true, italic: true });
    expect(g[5]).toEqual({ kind: 'text', at: { x: 10, y: 14 }, text: 'Right', angle: 0, size: 1.5, anchor: 'middle' });
  });

  it('samples an arc the long way round when the midpoint is on the major side and in the reverse direction', () => {
    const g = run(file(`(arc (start 20 10) (mid 15 15) (end 10 10) (stroke (width 0) (type default)) (fill (type none)) (uuid "a"))
      (arc (start 10 10) (mid 15 15) (end 20 10) (stroke (width 0) (type default)) (fill (type none)) (uuid "b"))
      (arc (start 15 5) (mid 5 10) (end 15 15) (stroke (width 0) (type default)) (fill (type none)) (uuid "c"))`)).defs[0]!.graphics;
    const [a, b, c] = g.map((x) => (x.kind === 'poly' ? x.points : []));
    for (const pts of [a!, b!]) for (const p of pts) expect(p.y).toBeGreaterThanOrEqual(9.9999); // lower half
    expect(a![0]).toEqual({ x: 20, y: 10 });
    expect(b![0]).toEqual({ x: 10, y: 10 });
    // c: radius ~ 10 around (15+?, 10): its leftmost point is the mid
    expect(Math.min(...c!.map((p) => p.x))).toBeCloseTo(5, 2);
  });

  it('degrades a collinear arc to a straight polyline instead of dividing by zero', () => {
    const g = run(file(`(arc (start 0 0) (mid 5 0) (end 10 0) (stroke (width 0) (type default)) (fill (type none)) (uuid "a"))`)).defs[0]!.graphics;
    expect(g).toEqual([{ kind: 'poly', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }], width: 0, filled: false }]);
  });

  it('transforms library graphics (polyline, circle, bezier, arc, text) by rotation and mirror', () => {
    const lib = `(symbol "Test:Art" ${props('A', 'Art')}
      (symbol "Art_0_1"
        (polyline (pts (xy 0 0) (xy 2 0) (xy 2 1)) (stroke (width 0.1) (type default)) (fill (type background)))
        (circle (center 1 2) (radius 0.5) (stroke (width 0) (type default)) (fill (type none)))
        (arc (start -1 0) (mid 0 1) (end 1 0) (stroke (width 0) (type default)) (fill (type none)))
        (bezier (pts (xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0)) (stroke (width 0) (type default)) (fill (type none)))
        (text "Hi" (at 3 0 900) (effects (font (size 1 1)) (justify left)))))`;
    const place = (at: string, mirror = '') => symbolsOf(run(file(placed({ lib: 'Test:Art', at, mirror }), { lib })))[0]!.graphics;
    const base = place('100 50 0');
    expect(base[0]).toEqual({ kind: 'poly', points: [{ x: 100, y: 50 }, { x: 102, y: 50 }, { x: 102, y: 49 }], width: 0.1, filled: true });
    expect(base[1]).toEqual({ kind: 'circle', center: { x: 101, y: 48 }, radius: 0.5, width: 0, fill: 'none' });
    const arc = base[2] as { points: Array<{ x: number; y: number }> };
    expect(arc.points[0]).toEqual({ x: 99, y: 50 });
    expect(Math.min(...arc.points.map((p) => p.y))).toBeCloseTo(49, 2); // library +y is up on screen
    const bez = base[3] as { points: Array<{ x: number; y: number }> };
    expect(bez.points[0]).toEqual({ x: 100, y: 50 });
    expect(bez.points[bez.points.length - 1]).toEqual({ x: 103, y: 50 });
    expect(Math.min(...bez.points.map((p) => p.y))).toBeCloseTo(49.25, 2); // curve peak at library y = 0.75
    expect(base[4]).toEqual({ kind: 'text', at: { x: 103, y: 50 }, text: 'Hi', angle: 90, size: 1, anchor: 'start' });
    const rotated = place('100 50 90');
    expect(rotated[0]).toMatchObject({ points: [{ x: 100, y: 50 }, { x: 100, y: 48 }, { x: 99, y: 48 }] });
    expect(rotated[1]).toMatchObject({ center: { x: 98, y: 49 } });
    const mirrored = place('100 50 0', 'x');
    expect(mirrored[0]).toMatchObject({ points: [{ x: 100, y: 50 }, { x: 102, y: 50 }, { x: 102, y: 51 }] });
    const arcM = mirrored[2] as { points: Array<{ x: number; y: number }> };
    expect(Math.max(...arcM.points.map((p) => p.y))).toBeCloseTo(51, 2);
  });

  it('reads the title block and the paper (named, portrait and user sizes)', () => {
    const tb = '(title_block (title "Demo board") (date "2024-01-02") (rev "B") (company "Acme") (comment 1 "first") (comment 4 "fourth"))';
    const def = run(file('', { head: tb, paper: '(paper "A3")' })).defs[0]!;
    expect(def.title).toBe('Demo board');
    expect(def.titleBlock).toEqual({ title: 'Demo board', date: '2024-01-02', rev: 'B', company: 'Acme', comment1: 'first', comment4: 'fourth' });
    expect(def.paper).toEqual({ width: 420, height: 297 });
    expect(run(file('', { paper: '(paper "A4" portrait)' })).defs[0]!.paper).toEqual({ width: 210, height: 297 });
    expect(run(file('', { paper: '(paper "User" 200.5 100)' })).defs[0]!.paper).toEqual({ width: 200.5, height: 100 });
    expect(run(file('', { paper: '(paper A5)' })).defs[0]!.paper).toEqual({ width: 210, height: 148 });
    expect(run(file('', { paper: '(paper "A")' })).defs[0]!.paper).toEqual({ width: 279.4, height: 215.9 });
    const odd = run(file('', { paper: '(paper "Z9")' }));
    expect(odd.defs[0]!.paper).toBeUndefined();
    expect(odd.diagnostics.map((d) => d.code)).toEqual(['PAPER_UNKNOWN']);
  });

  it('computes sheet bounds from content and falls back to the paper when empty', () => {
    const def = run(single(`${wire('10 10', '200 10', 'w')} (no_connect (at 5 150) (uuid "n"))`)).defs[0]!;
    expect(def.bounds).toEqual({ minX: 5, minY: 10, maxX: 200, maxY: 150 });
    expect(run(file('')).defs[0]!.bounds).toEqual({ minX: 0, minY: 0, maxX: 297, maxY: 210 });
  });
});

describe('unknown records and ids', () => {
  it('reports unmodelled records once per kind and never invents geometry for them', () => {
    const s = run(file(`
      (image (at 10 10) (scale 1) (uuid "${U(80)}") (data "AAAA"))
      (image (at 20 10) (scale 1) (uuid "${U(81)}") (data "BBBB"))
      (rule_area (polyline (pts (xy 0 0) (xy 1 1))))
      (frobnicate 1 2 3)
      (bus_alias "DATA" (members "D0" "D1"))
      (embedded_fonts no)`));
    const unknown = s.diagnostics.filter((d) => d.code === 'UNKNOWN_RECORD');
    expect(unknown.map((d) => d.message.match(/"([a-z_]+)"/)![1])).toEqual(['image', 'rule_area', 'frobnicate', 'bus_alias']);
    expect(unknown[0]).toMatchObject({ severity: 'info', defId: 'main.kicad_sch' });
    expect(unknown[0]!.message).toMatch(/2 /);
    expect(unknown[3]).toMatchObject({ severity: 'warning' }); // bus aliases change connectivity
    const def = s.defs[0]!;
    expect(def.graphics).toEqual([]);
    expect(def.wires).toEqual([]);
  });

  it('uses uuids as ids, generates stable ids when they are absent and de-duplicates collisions', () => {
    const body = `(wire (pts (xy 0 0) (xy 1 0)) (stroke (width 0) (type default)))
      (wire (pts (xy 1 0) (xy 2 0)) (stroke (width 0) (type default)))
      (wire (pts (xy 2 0) (xy 3 0)) (stroke (width 0) (type default)) (uuid "dup"))
      (wire (pts (xy 3 0) (xy 4 0)) (stroke (width 0) (type default)) (uuid "dup"))
      (junction (at 1 0))`;
    const first = run(file(body));
    const ids = first.defs[0]!.wires.map((w) => w.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids[2]).toBe('dup');
    expect(run(file(body))).toEqual(first); // identical input, identical ids
    const all = [...ids, ...first.defs[0]!.junctions.map((j) => j.id)];
    expect(new Set(all).size).toBe(all.length);
    expect(first.diagnostics.map((d) => d.code)).toContain('DUPLICATE_ID');
  });

  it('treats a uuid that cannot be a path component as missing', () => {
    const s = run(file(`(wire (pts (xy 0 0) (xy 1 0)) (uuid "a/b"))`));
    expect(s.defs[0]!.wires[0]!.id).not.toContain('/');
    expect(s.diagnostics.map((d) => d.code)).toContain('INVALID_UUID');
  });

  it('produces structured-clone-safe, deterministic output', () => {
    const text = single(`${wire('1 1', '2 2', U(90))} (label "N" (at 1 1 0) ${eff} (uuid "${U(91)}"))`);
    const a = run(text);
    expect(structuredClone(a)).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(run(text)).toEqual(a);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------------------------------------------

const CH = U(2);
const pinIn = (id: string, at = '50 55 180') => `(pin "IN" input (at ${at}) ${eff} (uuid "${id}"))`;

const channel = (version = 20231120) => {
  const v6 = version < 20230121;
  const foreign = v6 ? '' : `(instances (project "demo" (path "/${ROOT}/${S1}" (reference "R1") (unit 1)) (path "/${ROOT}/${S2}" (reference "R7") (unit 1))) (project "other" (path "/${U(99)}/${S1}" (reference "X1") (unit 1))))`;
  return file(
    `${placed({ ref: v6 ? 'R?' : 'R9', inst: v6 ? '' : foreign })} ${wire('50 55', '99 50', U(61))} (hierarchical_label "IN" (shape input) (at 50 55 180) ${eff} (uuid "${U(62)}"))`,
    { version, uuid: CH, lib: R_LIB, tail: v6 ? `(sheet_instances (path "/" (page "1"))) (symbol_instances (path "/${SYM1}" (reference "R?") (unit 1) (value "10k") (footprint "")))` : '' },
  );
};

const mainTwo = (version = 20231120) => {
  const v6 = version < 20230121;
  return file(
    `${sheet({ uuid: S1, name: 'ChanA', file: 'channel.kicad_sch', pins: pinIn(U(71)), pages: v6 ? undefined : [[`/${ROOT}`, '2']], v6 })}
     ${sheet({ uuid: S2, name: 'ChanB', file: 'channel.kicad_sch', at: '50 90', pins: pinIn(U(72), '50 95 180'), pages: v6 ? undefined : [[`/${ROOT}`, '3']], v6 })}
     ${placed({ ref: 'R10', uuid: U(22), at: '20 20 0', inst: v6 ? '' : instances([[`/${ROOT}`, 'R10']]) })}`,
    {
      version, lib: R_LIB,
      tail: v6
        ? `(sheet_instances (path "/" (page "1")) (path "/${S1}" (page "2")) (path "/${S2}" (page "3")))
           (symbol_instances (path "/${S1}/${SYM1}" (reference "R1") (unit 1) (value "10k") (footprint "")) (path "/${S2}/${SYM1}" (reference "R7") (unit 1) (value "10k") (footprint "")) (path "/${U(22)}" (reference "R10") (unit 1) (value "10k") (footprint "")))`
        : `(sheet_instances (path "/" (page "1")))`,
    },
  );
};

describe('hierarchy', () => {
  const twoSheets = (version = 20231120) => run(mainTwo(version), { 'channel.kicad_sch': channel(version) });

  it('instantiates one sub-sheet file twice with distinct instance paths and per-instance references', () => {
    const s = twoSheets();
    expect(s.diagnostics).toEqual([]);
    expect(s.defs.map((d) => d.id)).toEqual(['main.kicad_sch', 'channel.kicad_sch']);
    expect(s.rootDefId).toBe('main.kicad_sch');
    expect(s.instances).toEqual([
      { path: '', defId: 'main.kicad_sch', name: 'main', page: '1', parentPath: null, sheetRefId: null, childPaths: [`/${S1}`, `/${S2}`], depth: 0 },
      { path: `/${S1}`, defId: 'channel.kicad_sch', name: 'ChanA', page: '2', parentPath: '', sheetRefId: S1, childPaths: [], depth: 1 },
      { path: `/${S2}`, defId: 'channel.kicad_sch', name: 'ChanB', page: '3', parentPath: '', sheetRefId: S2, childPaths: [], depth: 1 },
    ]);
    const [root, child] = s.defs;
    expect(child!.uuid).toBe(CH);
    expect(child!.name).toBe('channel');
    expect(child!.file).toBe('channel.kicad_sch');
    expect(root!.sheetRefs).toHaveLength(2);
    expect(root!.sheetRefs[0]).toEqual({
      id: S1, name: 'ChanA', file: 'channel.kicad_sch', defId: 'channel.kicad_sch', at: { x: 50, y: 50 }, size: { x: 30, y: 20 },
      pins: [{ id: U(71), name: 'IN', at: { x: 50, y: 55 }, shape: 'input' }],
    });
    expect(root!.sheetRefs[1]!.defId).toBe('channel.kicad_sch');
    const r = child!.symbols[0]!;
    expect(sorted(r.instances)).toEqual([`/${S1}`, `/${S2}`]); // foreign project path ignored
    expect(symbolRef(r, `/${S1}`)).toBe('R1');
    expect(symbolRef(r, `/${S2}`)).toBe('R7');
    expect(r.instances[`/${S1}`]).toEqual({ ref: 'R1', unit: 1 });
    expect(r.refDefault).toBe('R9');
    expect(sorted(root!.symbols[0]!.instances)).toEqual(['']);
    expect(symbolRef(root!.symbols[0]!, '')).toBe('R10');
  });

  it('reads the same hierarchy from KiCad 6 top-level symbol_instances / sheet_instances tables', () => {
    const v6 = twoSheets(20211123);
    const v8 = twoSheets(20231120);
    expect(v6.diagnostics).toEqual([]);
    expect(v6.instances.map((i) => [i.path, i.page, i.name, i.defId])).toEqual(v8.instances.map((i) => [i.path, i.page, i.name, i.defId]));
    const r = v6.defs[1]!.symbols[0]!;
    expect(r.refDefault).toBe('R?');
    expect(r.instances).toEqual({ [`/${S1}`]: { ref: 'R1', unit: 1 }, [`/${S2}`]: { ref: 'R7', unit: 1 } });
    expect(v6.defs[0]!.symbols[0]!.instances).toEqual({ '': { ref: 'R10', unit: 1 } });
    expect(v6.defs[0]!.sheetRefs.map((x) => [x.name, x.file])).toEqual([['ChanA', 'channel.kicad_sch'], ['ChanB', 'channel.kicad_sch']]);
  });

  it('builds deep hierarchies in preorder with full instance paths and per-instance data', () => {
    const M1 = U(13);
    const M2 = U(14);
    const L1 = U(15);
    const leaf = file(placed({ ref: 'C?', uuid: SYM1, inst: instances([[`/${ROOT}/${M1}/${L1}`, 'C1'], [`/${ROOT}/${M2}/${L1}`, 'C9']]) }), { uuid: U(3), lib: R_LIB });
    const mid = file(sheet({ uuid: L1, name: 'Leaf', file: 'leaf.kicad_sch', pages: [[`/${ROOT}/${M1}`, '3'], [`/${ROOT}/${M2}`, '5']] }), { uuid: U(4) });
    const main = file(`${sheet({ uuid: M1, name: 'MidA', file: 'mid.kicad_sch', pages: [[`/${ROOT}`, '2']] })} ${sheet({ uuid: M2, name: 'MidB', file: 'mid.kicad_sch', at: '50 90', pages: [[`/${ROOT}`, '4']] })}`);
    const s = run(main, { 'mid.kicad_sch': mid, 'leaf.kicad_sch': leaf });
    expect(s.diagnostics).toEqual([]);
    expect(s.defs.map((d) => d.id)).toEqual(['main.kicad_sch', 'mid.kicad_sch', 'leaf.kicad_sch']);
    expect(s.instances.map((i) => [i.path, i.depth, i.page, i.name, i.parentPath, i.sheetRefId])).toEqual([
      ['', 0, '1', 'main', null, null],
      [`/${M1}`, 1, '2', 'MidA', '', M1],
      [`/${M1}/${L1}`, 2, '3', 'Leaf', `/${M1}`, L1],
      [`/${M2}`, 1, '4', 'MidB', '', M2],
      [`/${M2}/${L1}`, 2, '5', 'Leaf', `/${M2}`, L1],
    ]);
    expect(s.instances[1]!.childPaths).toEqual([`/${M1}/${L1}`]);
    expect(s.instances[0]!.childPaths).toEqual([`/${M1}`, `/${M2}`]);
    const c = s.defs[2]!.symbols[0]!;
    expect(c.instances).toEqual({ [`/${M1}/${L1}`]: { ref: 'C1', unit: 1 }, [`/${M2}/${L1}`]: { ref: 'C9', unit: 1 } });
  });

  it('falls back to the preorder position when no page number is stored', () => {
    const s = run(file(sheet({ uuid: S1, name: 'A', file: 'a.kicad_sch' }) + sheet({ uuid: S2, name: 'B', file: 'a.kicad_sch', at: '50 90' })), { 'a.kicad_sch': file('', { uuid: U(5) }) });
    expect(s.instances.map((i) => i.page)).toEqual(['1', '2', '3']);
  });

  it('keeps going when a sub-sheet file is missing and leaves defId null', () => {
    const s = run(file(sheet({ uuid: S1, name: 'Gone', file: 'gone.kicad_sch' }) + placed({ ref: 'R1' }), { lib: R_LIB }));
    expect(s.defs).toHaveLength(1);
    expect(s.instances).toHaveLength(1);
    expect(s.instances[0]!.childPaths).toEqual([]);
    expect(s.defs[0]!.sheetRefs[0]).toMatchObject({ id: S1, name: 'Gone', file: 'gone.kicad_sch', defId: null });
    expect(s.defs[0]!.symbols).toHaveLength(1);
    expect(s.diagnostics).toEqual([expect.objectContaining({ code: 'SHEET_FILE_MISSING', severity: 'warning', defId: 'main.kicad_sch', at: { x: 50, y: 50 } })]);
    expect(s.diagnostics[0]!.message).toContain('gone.kicad_sch');
  });

  it('matches companion files by lowercase basename, including different letter case in the sheet property', () => {
    const s = run(file(sheet({ uuid: S1, name: 'A', file: 'Channel.KiCad_Sch' })), { 'channel.kicad_sch': file('', { uuid: CH }) });
    expect(s.defs.map((d) => d.id)).toEqual(['main.kicad_sch', 'channel.kicad_sch']);
    expect(s.diagnostics).toEqual([]);
    const upperPrimary = run(file(''), {}, 'MAIN.KICAD_SCH');
    expect(upperPrimary.rootDefId).toBe('main.kicad_sch');
    expect(upperPrimary.defs[0]!.file).toBe('MAIN.KICAD_SCH');
  });

  it('resolves a path with directories by basename only when that is unambiguous', () => {
    const ok = run(file(sheet({ uuid: S1, name: 'A', file: 'sub/channel.kicad_sch' }) + sheet({ uuid: S2, name: 'B', file: './sub\\channel.kicad_sch', at: '50 90' })), { 'channel.kicad_sch': file('', { uuid: CH }) });
    expect(ok.defs.map((d) => d.id)).toEqual(['main.kicad_sch', 'channel.kicad_sch']);
    expect(ok.instances).toHaveLength(3);
    expect(ok.diagnostics.map((d) => d.code)).toEqual(['SHEET_FILE_PATH_FLATTENED']);
    expect(ok.diagnostics[0]!.severity).toBe('info');

    const clash = run(file(sheet({ uuid: S1, name: 'A', file: 'a/channel.kicad_sch' }) + sheet({ uuid: S2, name: 'B', file: 'b/channel.kicad_sch', at: '50 90' })), { 'channel.kicad_sch': file('', { uuid: CH }) });
    expect(clash.defs).toHaveLength(1);
    expect(clash.instances).toHaveLength(1);
    expect(clash.defs[0]!.sheetRefs.map((r) => r.defId)).toEqual([null, null]);
    expect(clash.diagnostics.map((d) => d.code)).toEqual(['SHEET_FILE_AMBIGUOUS', 'SHEET_FILE_AMBIGUOUS']);

    const mixed = run(file(sheet({ uuid: S1, name: 'A', file: 'channel.kicad_sch' }) + sheet({ uuid: S2, name: 'B', file: 'b/channel.kicad_sch', at: '50 90' })), { 'channel.kicad_sch': file('', { uuid: CH }) });
    expect(mixed.defs).toHaveLength(1);
    expect(mixed.diagnostics.map((d) => d.code)).toEqual(['SHEET_FILE_AMBIGUOUS', 'SHEET_FILE_AMBIGUOUS']);
  });

  it('reports sub-sheets that are not readable KiCad schematics without aborting the parent', () => {
    const body = sheet({ uuid: S1, name: 'Bad', file: 'bad.kicad_sch' }) + sheet({ uuid: S2, name: 'Old', file: 'old.kicad_sch', at: '50 90' })
      + sheet({ uuid: U(13), name: 'Trunc', file: 'trunc.kicad_sch', at: '50 120' }) + sheet({ uuid: U(14), name: 'Future', file: 'future.kicad_sch', at: '50 150' })
      + placed({ ref: 'R1' });
    const s = run(file(body, { lib: R_LIB }), {
      'bad.kicad_sch': 'this is not a schematic', 'old.kicad_sch': 'EESchema Schematic File Version 4\n', 'trunc.kicad_sch': '(kicad_sch (version 20231120) (generator "x") (wire',
      'future.kicad_sch': file('', { version: 20991231 }),
    });
    expect(s.defs).toHaveLength(1);
    expect(s.defs[0]!.sheetRefs.map((r) => r.defId)).toEqual([null, null, null, null]);
    expect(s.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['SHEET_FILE_INVALID', 'error'], ['SHEET_FILE_INVALID', 'error'], ['SHEET_FILE_INVALID', 'error'], ['SHEET_FILE_UNSUPPORTED', 'error'],
    ]);
    expect(s.diagnostics[3]!.message).toContain('20991231');
    expect(s.defs[0]!.symbols).toHaveLength(1);
  });

  it('rejects reference cycles (self, mutual and through a longer chain)', () => {
    const ref = (name: string) => file(sheet({ uuid: S1, name, file: `${name}.kicad_sch` }), { uuid: U(100 + name.charCodeAt(0)) });
    fails(() => run(file(sheet({ uuid: S1, name: 'Self', file: 'main.kicad_sch' }))), 'INVALID_FORMAT', /cycle.*main\.kicad_sch/i);
    fails(() => run(file(sheet({ uuid: S1, name: 'A', file: 'a.kicad_sch' })), { 'a.kicad_sch': file(sheet({ uuid: S2, name: 'M', file: 'MAIN.kicad_sch' }), { uuid: U(3) }) }), 'INVALID_FORMAT', /cycle.*main\.kicad_sch.*a\.kicad_sch.*main\.kicad_sch/i);
    fails(() => run(file(sheet({ uuid: S1, name: 'A', file: 'a.kicad_sch' })), { 'a.kicad_sch': ref('b'), 'b.kicad_sch': ref('c'), 'c.kicad_sch': ref('b') }), 'INVALID_FORMAT', /cycle/i);
    // a diamond (same file twice, no cycle) is fine
    expect(run(file(sheet({ uuid: S1, name: 'A', file: 'a.kicad_sch' }) + sheet({ uuid: S2, name: 'B', file: 'b.kicad_sch', at: '50 90' })), {
      'a.kicad_sch': file(sheet({ uuid: U(13), name: 'L', file: 'leaf.kicad_sch' }), { uuid: U(3) }),
      'b.kicad_sch': file(sheet({ uuid: U(14), name: 'L', file: 'leaf.kicad_sch' }), { uuid: U(4) }),
      'leaf.kicad_sch': file('', { uuid: U(5) }),
    }).instances).toHaveLength(5);
  });

  it('reports a unit mismatch between a symbol and its instance data', () => {
    const lib = `(symbol "Test:Dual" ${props('U', 'Dual')} (symbol "Dual_1_1" ${pin('input', '-5.08 0 0', 2.54, '1')}) (symbol "Dual_2_1" ${pin('input', '-5.08 0 0', 2.54, '2')}))`;
    const s = run(file(placed({ lib: 'Test:Dual', unit: 1, inst: instances([[`/${ROOT}`, 'U1', 2]]) }), { lib }));
    expect(s.diagnostics).toEqual([expect.objectContaining({ code: 'INSTANCE_UNIT_MISMATCH', severity: 'warning' })]);
    const u = symbolsOf(s)[0]!;
    expect(u.unit).toBe(1);
    expect(u.pins.map((p) => p.number)).toEqual(['1']);
    expect(u.instances['']).toEqual({ ref: 'U1', unit: 2 });
  });

  it('uses the stored reference and says so when a repeated sheet carries no per-instance data', () => {
    const s = run(
      file(sheet({ uuid: S1, name: 'A', file: 'c.kicad_sch' }) + sheet({ uuid: S2, name: 'B', file: 'c.kicad_sch', at: '50 90' })),
      { 'c.kicad_sch': file(placed({ ref: 'R5' }), { uuid: CH, lib: R_LIB }) },
    );
    expect(s.defs[1]!.symbols[0]!.instances).toEqual({ [`/${S1}`]: { ref: 'R5', unit: 1 }, [`/${S2}`]: { ref: 'R5', unit: 1 } });
    expect(s.diagnostics).toEqual([expect.objectContaining({ code: 'INSTANCE_DATA_MISSING', severity: 'warning', defId: 'c.kicad_sch' })]);
    // a single-instance schematic without instance data is not worth a diagnostic
    expect(run(file(placed({ ref: 'R5' }), { lib: R_LIB })).diagnostics).toEqual([]);
  });

  it('ignores instance data that belongs to another project root', () => {
    const foreign = instances([[`/${U(99)}`, 'R77']], 'elsewhere');
    const s = run(file(placed({ ref: 'R1', inst: foreign }), { lib: R_LIB }));
    expect(symbolsOf(s)[0]!.instances).toEqual({ '': { ref: 'R1', unit: 1 } });
    expect(s.diagnostics.map((d) => d.code)).toEqual(['INSTANCE_DATA_MISSING']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Budgets and malformed input
// ---------------------------------------------------------------------------------------------------------------

describe('limits and hostile input', () => {
  const leaf = (id: number, body = '') => file(body, { uuid: U(1000 + id) });
  const refs = (count: number, fileName: (i: number) => string) => Array.from({ length: count }, (_, i) => sheet({ uuid: U(2000 + i), name: `S${i}`, file: fileName(i), at: `${10 + i} 10` })).join('\n');

  it('enforces the sheet definition budget exactly', () => {
    const make = (children: number) => {
      const companions: Record<string, string> = {};
      for (let i = 0; i < children; i++) companions[`c${i}.kicad_sch`] = leaf(i);
      return run(file(refs(children, (i) => `c${i}.kicad_sch`)), companions);
    };
    expect(make(SCHEMATIC_LIMITS.maxSheetDefs - 1).defs).toHaveLength(SCHEMATIC_LIMITS.maxSheetDefs);
    fails(() => make(SCHEMATIC_LIMITS.maxSheetDefs), 'LIMIT_EXCEEDED', /sheet definitions/i);
  });

  it('enforces the instance budget (repeated sub-sheets multiply instances, not definitions)', () => {
    const make = (outer: number, inner: number) => run(
      file(refs(outer, () => 'a.kicad_sch')),
      { 'a.kicad_sch': file(refs(inner, () => 'leaf.kicad_sch'), { uuid: U(3) }), 'leaf.kicad_sch': leaf(1) },
    );
    expect(make(63, 64).instances).toHaveLength(SCHEMATIC_LIMITS.maxInstances); // 1 + 63 + 63*64
    fails(() => make(64, 65), 'LIMIT_EXCEEDED', /instances/i);
  });

  it('enforces the hierarchy depth budget', () => {
    const chain = (length: number) => {
      const companions: Record<string, string> = {};
      for (let i = 1; i <= length; i++) companions[`f${i}.kicad_sch`] = i === length ? leaf(i) : file(sheet({ uuid: U(3000 + i), name: `N${i}`, file: `f${i + 1}.kicad_sch` }), { uuid: U(1000 + i) });
      return run(file(sheet({ uuid: U(3000), name: 'N0', file: 'f1.kicad_sch' })), companions);
    };
    const ok = chain(SCHEMATIC_LIMITS.maxNestingDepth);
    expect(ok.instances[ok.instances.length - 1]!.depth).toBe(SCHEMATIC_LIMITS.maxNestingDepth);
    fails(() => chain(SCHEMATIC_LIMITS.maxNestingDepth + 1), 'LIMIT_EXCEEDED', /depth|nest/i);
  });

  it('enforces per-definition and total element budgets (injected small limits)', () => {
    const three = single(`${wire('0 0', '1 0', 'a')} ${wire('1 0', '2 0', 'b')} ${wire('2 0', '3 0', 'c')}`);
    expect(run(three, {}, 'main.kicad_sch', { maxWiresPerDef: 3 }).defs[0]!.wires).toHaveLength(3);
    fails(() => run(three, {}, 'main.kicad_sch', { maxWiresPerDef: 2 }), 'LIMIT_EXCEEDED', /wires/i);
    const bus = file('(bus (pts (xy 0 0) (xy 1 0)) (uuid "a")) (bus (pts (xy 0 0) (xy 1 0)) (uuid "b"))');
    fails(() => run(bus, {}, 'main.kicad_sch', { maxWiresPerDef: 1 }), 'LIMIT_EXCEEDED', /buses/i);
    const symbols = file(placed({ uuid: U(1) }) + placed({ uuid: U(2) }) + placed({ uuid: U(3) }), { lib: R_LIB });
    fails(() => run(symbols, {}, 'main.kicad_sch', { maxSymbolsPerDef: 2 }), 'LIMIT_EXCEEDED', /symbols/i);
    // pins are counted over every instance: 1 symbol x 2 pins x 2 instances = 4
    const twice = [file(sheet({ uuid: S1, name: 'A', file: 'c.kicad_sch' }) + sheet({ uuid: S2, name: 'B', file: 'c.kicad_sch', at: '50 90' })), { 'c.kicad_sch': file(placed(), { uuid: CH, lib: R_LIB }) }] as const;
    expect(run(twice[0], twice[1], 'main.kicad_sch', { maxPinsTotal: 4 }).instances).toHaveLength(3);
    fails(() => run(twice[0], twice[1], 'main.kicad_sch', { maxPinsTotal: 3 }), 'LIMIT_EXCEEDED', /pins/i);
    fails(() => run(single(), {}, 'main.kicad_sch', { maxExpression: 50 }), 'LIMIT_EXCEEDED', /nodes/i);
    fails(() => run(single(), {}, 'main.kicad_sch', { maxNestingDepth: 3 }), 'LIMIT_EXCEEDED', /nest/i);
  });

  it('counts expression nodes over the whole hierarchy, not per file', () => {
    const child = file(wire('0 0', '1 0', 'a'), { uuid: CH });
    const main = file(sheet({ uuid: S1, name: 'A', file: 'c.kicad_sch' }));
    const total = readSexpr(main).nodes + readSexpr(child).nodes;
    expect(run(main, { 'c.kicad_sch': child }, 'main.kicad_sch', { maxExpression: total }).defs).toHaveLength(2);
    fails(() => run(main, { 'c.kicad_sch': child }, 'main.kicad_sch', { maxExpression: total - 1 }), 'LIMIT_EXCEEDED', /nodes/i);
  });

  it('rejects hostile nesting without overflowing the stack', () => {
    fails(() => run(`(kicad_sch (version 20231120) ${'('.repeat(100_000)}`), 'LIMIT_EXCEEDED', /nest/i);
    fails(() => run(`(kicad_sch (version 20231120) ${'(a '.repeat(70)}${')'.repeat(70)})`), 'LIMIT_EXCEEDED', /nest/i);
  });

  it('rejects malformed content precisely', () => {
    const good = single(wire('1 1', '2 2', 'w'));
    for (const cut of [10, 40, Math.floor(good.length / 2), good.length - 1]) fails(() => run(good.slice(0, cut)), 'INVALID_FORMAT');
    fails(() => run(`${good} trailing`), 'INVALID_FORMAT', /after the closing/);
    fails(() => run(`${good})`), 'INVALID_FORMAT', /unexpected "\)"/i);
    fails(() => run(file('(wire (pts (xy 1 1) (xy 2 2)) (uuid "x)')), 'INVALID_FORMAT', /unterminated string/i);
    fails(() => run(file(`(symbol (lib_id "Device:R") (at 1 2 3 4) (uuid "a"))`, { lib: R_LIB })), 'INVALID_FORMAT', /at/);
    fails(() => run(file(`(symbol (at 1 2 0) (uuid "a"))`)), 'INVALID_FORMAT', /lib_id/);
    fails(() => run(file(`(symbol (lib_id "Device:R") (uuid "a"))`, { lib: R_LIB })), 'INVALID_FORMAT', /\(at/);
    fails(() => run(file(`(symbol (lib_id "Device:R") (at 1 2 0) (unit 0) (uuid "a"))`, { lib: R_LIB })), 'INVALID_FORMAT', /unit/);
    fails(() => run(file(`(symbol (lib_id "Device:R") (at 1 2 0) (unit 1.5) (uuid "a"))`, { lib: R_LIB })), 'INVALID_FORMAT', /unit/);
    fails(() => run(file(sheet({ uuid: S1, name: 'A', file: '' }))), 'INVALID_FORMAT', /Sheetfile/);
    fails(() => run(file('(sheet (at 0 0) (size 10 10) (uuid "s") (property "Sheetname" "x"))')), 'INVALID_FORMAT', /Sheetfile/);
    fails(() => run(file(`(sheet (at 0 0) (size 10) (uuid "s") (property "Sheetfile" "x.kicad_sch"))`)), 'INVALID_FORMAT', /size/);
    fails(() => run(file(sheet({ uuid: S1, name: 'A', file: 'a.kicad_sch', pins: '(pin "X" sideways (at 1 1 0) (uuid "p"))' }))), 'INVALID_FORMAT', /pin/);
  });

  it('rejects malformed library symbols precisely', () => {
    const lib = (inner: string) => `(symbol "Device:R" ${props('R', 'R')} ${inner})`;
    fails(() => run(file(placed(), { lib: lib(`(symbol "R_1_1" (pin teleport line (at 0 0 0) (length 1) (name "A" ${eff}) (number "1" ${eff})))`) })), 'INVALID_FORMAT', /electrical type/);
    fails(() => run(file(placed(), { lib: lib(`(symbol "R_1_1" (pin passive line (at 0 0 45) (length 1) (name "A" ${eff}) (number "1" ${eff})))`) })), 'INVALID_FORMAT', /pin.*angle|orientation/i);
    fails(() => run(file(placed(), { lib: lib(`(symbol "R_1_1" (pin passive line (at 0 0 0) (name "A" ${eff}) (number "1" ${eff})))`) })), 'INVALID_FORMAT', /length/);
    fails(() => run(file(placed(), { lib: lib(`(symbol "R_1_1" (pin passive line (at 0 0 0) (length 1) (name "A" ${eff})))`) })), 'INVALID_FORMAT', /number/);
    fails(() => run(file(placed(), { lib: lib(`(symbol "R_x" )`) })), 'INVALID_FORMAT', /NAME_UNIT_STYLE|unit/);
    fails(() => run(file(placed(), { lib: lib(`(symbol "R_1_1" (pin passive line (at 1e9 0 0) (length 1) (name "A" ${eff}) (number "1" ${eff})))`) })), 'LIMIT_EXCEEDED', /coordinate/i);
    fails(() => run(file(placed(), { lib: lib(`(symbol "R_1_1" (polyline (pts (xy 1 1)) (stroke (width 0) (type default)) (fill (type none))))`) })), 'INVALID_FORMAT', /polyline/);
    fails(() => run(file(placed(), { lib: lib(`(symbol "R_1_1" (arc (start 0 0) (end 1 1) (stroke (width 0) (type default)) (fill (type none))))`) })), 'INVALID_FORMAT', /arc/);
    fails(() => run(file(placed(), { lib: lib(`(symbol "R_1_1" (rectangle (start 0 0) (stroke (width 0) (type default)) (fill (type none))))`) })), 'INVALID_FORMAT', /rectangle/);
    fails(() => run(file(placed(), { lib: lib(`(symbol "R_1_1" (circle (center 0 0) (radius -1) (stroke (width 0) (type default)) (fill (type none))))`) })), 'INVALID_FORMAT', /circle|radius/);
    fails(() => run(file(placed(), { lib: lib(`(symbol "R_5000_1" )`) })), 'LIMIT_EXCEEDED', /unit/);
  });

  it('degrades gracefully on an empty pin number by flagging it', () => {
    const lib = `(symbol "Device:R" ${props('R', 'R')} (symbol "R_1_1" ${pin('passive', '0 0 0', 1, '')}))`;
    const s = run(file(placed(), { lib }));
    expect(symbolsOf(s)[0]!.pins[0]!.number).not.toBe('');
    expect(s.diagnostics.map((d) => d.code)).toEqual(['PIN_NUMBER_EMPTY']);
  });

  it('refuses inputs above the native size bound', () => {
    const big = new Uint8Array(64 * 1024 * 1024 + 1);
    big.set(enc('(kicad_sch'));
    fails(() => parseKicadSch({ name: 'big.kicad_sch', data: big }), 'LIMIT_EXCEEDED', /bytes/i);
  });
});

// Real-file findings (S1 KiCad 9 demo "pic_programmer", S3 Antmicro Jetson Nano baseboard): every construct below is rebuilt as a
// small ORIGINAL synthetic fixture, never from real bytes.
describe('real-file findings (power flags, escape tokens in labels)', () => {
  const FLAG_LIB = `(symbol "power:PWR_FLAG" (power) (pin_numbers (hide yes)) (pin_names (offset 0) (hide yes)) (in_bom yes) (on_board yes) ${props('#FLG', 'PWR_FLAG')}
      (symbol "PWR_FLAG_0_0" ${pin('power_out', '0 0 90', 0, '1', 'pwr')}) (symbol "PWR_FLAG_0_1" (polyline (pts (xy 0 0) (xy 0 1.27)) (stroke (width 0) (type default)) (fill (type none)))))
    (symbol "power:GND" (power) (pin_numbers (hide yes)) (pin_names (offset 0) (hide yes)) (in_bom yes) (on_board yes) ${props('#PWR', 'GND')}
      (symbol "GND_1_1" ${pin('power_in', '0 0 270', 0, '1', 'GND', '(hide yes)')}))
    (symbol "power:+5V" (power) (pin_numbers (hide yes)) (pin_names (offset 0) (hide yes)) (in_bom yes) (on_board yes) ${props('#PWR', '+5V')}
      (symbol "+5V_1_1" ${pin('power_in', '0 0 90', 0, '1', '+5V', '(hide yes)')}))`;
  const rails = [
    placed({ lib: 'power:GND', ref: '#PWR01', value: 'GND', uuid: U(61), at: '60 30 0' }), placed({ lib: 'power:PWR_FLAG', ref: '#FLG01', value: 'PWR_FLAG', uuid: U(62), at: '60 30 0' }),
    placed({ lib: 'power:+5V', ref: '#PWR02', value: '+5V', uuid: U(63), at: '60 80 0' }), placed({ lib: 'power:PWR_FLAG', ref: '#FLG02', value: 'PWR_FLAG', uuid: U(64), at: '60 80 0' }),
    wire('60 30', '70 30', U(65)), wire('60 80', '70 80', U(66)), // each rail has a wire, so it is a net of its own
  ].join('\n');

  it('W-open-sch-01: a power flag (PWR_FLAG: (power) with one power-output pin) names no net and stays virtual', () => {
    const s = run(file(rails, { lib: FLAG_LIB }));
    const bySymbol = Object.fromEntries(symbolsOf(s).map((x) => [x.refDefault, x]));
    expect(bySymbol['#FLG01']).toMatchObject({ virtual: true }); expect(bySymbol['#FLG01']).not.toHaveProperty('power');
    expect(bySymbol['#FLG01']!.pins[0]).toMatchObject({ type: 'power_out' });
    expect(bySymbol['#PWR01']).toMatchObject({ power: { net: 'GND' } }); expect(bySymbol['#PWR02']).toMatchObject({ power: { net: '+5V' } });
  });

  it('W-open-sch-01: two rails that each carry a power flag stay two nets (no merge through a shared "PWR_FLAG" name)', () => {
    const s = run(file(rails, { lib: FLAG_LIB }));
    const c = computeConnectivity(s);
    expect(c.nets.map((n) => n.name).sort()).toEqual(['+5V', 'GND']);
    expect(c.nets.flatMap((n) => n.aliases).sort()).toEqual(['+5V', 'GND']);
    expect(c.diagnostics.map((d) => d.code)).not.toContain('NET_NAME_CONFLICT');
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('repeated ids', () => {
  const SAME = U(77);

  it('keeps 20 000 wires that share one uuid unique with "~n" suffixes in linear time', () => {
    const sheetWith = (count: number, id: (index: number) => string) => file(Array.from({ length: count }, (_, i) => wire(`${(i % 200) * 2} ${Math.floor(i / 200) * 2}`, `${(i % 200) * 2 + 1} ${Math.floor(i / 200) * 2}`, id(i))).join('\n'), { tail: '(sheet_instances (path "/" (page "1")))' });
    const sheetOf = (count: number) => sheetWith(count, () => SAME);
    // The same sheet with a distinct uuid on every wire is the work the repeats must not exceed by much more than the suffix bookkeeping: a suffix probe
    // that restarts at ~2 for every repeat costs 50 times that or more (1.5 s against 30 ms for 5,000 wires) and grows with the square of the count; a correct
    // run measures 0.4 to about 3 times it, because garbage collection decides much of a parse of 20,000 wires, so the factor of 10 sits between the two.
    // Both are parsed in this process one after the other, so a busy machine slows them alike; a size exponent over 4x steps is not used here, because
    // an object graph of 20,000 wires makes even a linear parse measure close to size^1.5 (garbage collection and caches).
    const repeated = enc(sheetOf(20_000)), distinct = enc(sheetWith(20_000, i => U(1000 + i)));
    expectCostAtMost('repeated ids', () => parseKicadSch({ name: 'main.kicad_sch', data: repeated, companions: {} }), () => parseKicadSch({ name: 'main.kicad_sch', data: distinct, companions: {} }), 10);
    const s = run(sheetOf(20_000));
    const ids = s.defs[0]!.wires.map((w) => w.id);
    expect(ids).toHaveLength(20_000);
    expect(new Set(ids).size).toBe(20_000);
    expect(ids.slice(0, 3)).toEqual([SAME, `${SAME}~2`, `${SAME}~3`]);
    expect(ids[19_999]).toBe(`${SAME}~20000`);
    expect(s.diagnostics.filter((d) => d.code === 'DUPLICATE_ID').map((d) => d.message)).toEqual(['19999 element id(s) occur more than once in the file; they were made unique with a "~n" suffix.']);
  });

  it('gives a repeated id the lowest free suffix, also around written "~n" ids (the ids a search from ~2 would find)', () => {
    const A = U(31), B = U(32);
    const uuids = [A, A, `${A}~2`, A, `${A}~5`, A, A, B, B];
    const s = run(file(uuids.map((id, i) => wire(`${i * 2} 0`, `${i * 2 + 1} 0`, id)).join('\n')));
    expect(s.defs[0]!.wires.map((w) => w.id)).toEqual([A, `${A}~2`, `${A}~2~2`, `${A}~3`, `${A}~5`, `${A}~4`, `${A}~6`, B, `${B}~2`]);
    expect(s.diagnostics.filter((d) => d.code === 'DUPLICATE_ID')).toHaveLength(1);
  });

  it('gives repeated pin numbers inside one symbol "@unit" and "~n" suffixes in pin order', () => {
    const lib = `(symbol "Test:Dup" (in_bom yes) (on_board yes) ${props('U', 'Dup')}
      (symbol "Dup_0_1" ${pin('passive', '0 5.08 270', 1.27, '1')})
      (symbol "Dup_1_1" ${pin('passive', '-5.08 0 0', 1.27, '1')} ${pin('passive', '5.08 0 180', 1.27, '1')} ${pin('passive', '0 -5.08 90', 1.27, '1')} ${pin('passive', '0 -7.62 90', 1.27, '2')}))`;
    const s = run(file(placed({ lib: 'Test:Dup', ref: 'U1', value: 'Dup', uuid: U(41) }), { lib }));
    expect(symbolsOf(s)[0]!.pins.map((p) => p.id)).toEqual([`${U(41)}#1`, `${U(41)}#1@1`, `${U(41)}#1@1~2`, `${U(41)}#1@1~3`, `${U(41)}#2`]);
  });
});
