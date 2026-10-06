import { describe, expect, it } from 'vitest';
import { SCHEMATIC_LIMITS, SchematicError, symbolRef, type SchDiagnostic, type SchPin, type Schematic, type SchSheetDef, type SchSymbol } from './model';
import { parseKicadLegacySch } from './kicad-legacy';

// ---------------------------------------------------------------------------------------------------------------
// Synthetic fixtures (original, written for these tests). Coordinates in the text are mils, Y down; the library is Y up.
// ---------------------------------------------------------------------------------------------------------------

const enc = (text: string) => new TextEncoder().encode(text);
const files = (companions: Record<string, string>) => Object.fromEntries(Object.entries(companions).map(([name, text]) => [name.toLowerCase(), enc(text)]));
const parse = (text: string, companions: Record<string, string> = {}, name = 'demo.sch') => parseKicadLegacySch({ name, data: enc(text), companions: files(companions) });
function must(text: string, companions: Record<string, string> = {}, name?: string): Schematic {
  const result = parse(text, companions, name);
  if (!result) throw new Error('fixture was not recognized');
  return result;
}
function thrown(text: string, companions: Record<string, string> = {}, name?: string): SchematicError {
  try { parse(text, companions, name); } catch (error) { if (error instanceof SchematicError) return error; throw error; }
  throw new Error('expected a SchematicError');
}
const codes = (s: Schematic) => s.diagnostics.map(d => d.code);
const diag = (s: Schematic, code: string): SchDiagnostic[] => s.diagnostics.filter(d => d.code === code);
const root = (s: Schematic): SchSheetDef => s.defs.find(d => d.id === s.rootDefId)!;
const sym = (s: Schematic, ref: string, defId?: string): SchSymbol => {
  const def = defId ? s.defs.find(d => d.id === defId)! : root(s);
  const found = def.symbols.find(symbol => symbol.refDefault === ref);
  if (!found) throw new Error(`no symbol ${ref}`);
  return found;
};
const pinRow = (pin: SchPin) => [pin.number, pin.at.x, pin.at.y, pin.body.x, pin.body.y] as const;

const sheet = (body: string, version = 4) => `EESchema Schematic File Version ${version}
EELAYER 30 0
EELAYER END
$Descr A4 11693 8268
encoding utf-8
Sheet 1 1
Title "Synthetic"
Date "2024-01-02"
Rev "B"
Comp "Acme"
Comment1 "first"
Comment2 ""
$EndDescr
${body}
$EndSCHEMATC
`;

interface CompSpec { lib: string; ref: string; ts?: string; unit?: number; convert?: number; x: number; y: number; m?: string; value?: string; ar?: string[] }
const comp = (c: CompSpec) => `$Comp
L ${c.lib} ${c.ref}
U ${c.unit ?? 1} ${c.convert ?? 1} ${c.ts ?? '5F000001'}
P ${c.x} ${c.y}
${(c.ar ?? []).map(entry => `AR ${entry}`).join('\n')}
F 0 "${c.ref}" H ${c.x + 100} ${c.y - 100} 50  0000 L CNN
F 1 "${c.value ?? c.lib}" H ${c.x + 100} ${c.y + 100} 50  0000 L CNN
F 2 "" H ${c.x} ${c.y} 50  0001 C CNN
F 3 "~" H ${c.x} ${c.y} 50  0001 C CNN
	${c.unit ?? 1}    ${c.x}  ${c.y}
	${c.m ?? '1    0    0    -1'}
$EndComp`;

const NORMAL = '1    0    0    -1';
const lib = (...defs: string[]) => `EESchema-LIBRARY Version 2.3\n#encoding utf-8\n${defs.join('\n')}\n#\n#End Library\n`;

const R_DEF = `#
# Device_R
#
DEF Device_R R 0 0 N Y 1 F N
F0 "R" 80 0 50 V V C CNN
F1 "Device_R" 0 0 50 V V C CNN
F2 "" -70 0 50 V V C CNN
F3 "~" 0 0 50 H I C CNN
$FPLIST
 R_*
$ENDFPLIST
DRAW
S -40 -100 40 100 0 1 10 N
X ~ 1 0 150 50 D 50 50 1 1 P
X ~ 2 0 -150 50 U 50 50 1 1 P
ENDDRAW
ENDDEF`;

// An asymmetric one-pin part: every rotation/mirror moves its pin to a different place.
const PROBE_DEF = `DEF PROBE X 0 0 Y Y 1 F N
F0 "X" 0 0 50 H V C CNN
F1 "PROBE" 0 0 50 H V C CNN
DRAW
X P 1 100 50 40 R 50 50 1 1 I
ENDDRAW
ENDDEF`;

const MULTI_DEF = `DEF U_MULTI U 0 40 Y Y 2 L N
F0 "U" 0 100 50 H V C CNN
F1 "U_MULTI" 0 -100 50 H V C CNN
DRAW
S -200 -100 200 100 1 1 10 f
S -100 -100 100 100 2 1 10 f
X IN1 1 -300 50 100 R 50 50 1 1 I
X OUT1 2 300 50 100 L 50 50 1 1 O
X IN2 3 -200 0 100 R 50 50 2 1 I
X ALT 5 -300 -50 100 R 50 50 1 2 B
X VCC 14 0 200 100 D 50 50 0 0 W N
X GND 7 0 -200 100 U 50 50 0 0 W N
ENDDRAW
ENDDEF`;

const PWR_5V_DEF = `DEF power_+5V #PWR 0 0 Y Y 1 F P
F0 "#PWR" 0 -150 50 H I C CNN
F1 "+5V" 0 140 50 H V C CNN
DRAW
P 2 0 1 0 0 0 0 100 N
X +5V 1 0 0 0 U 50 50 1 1 W N
ENDDRAW
ENDDEF`;

// Same shape but without the P flag: only the #PWR reference marks it as a power symbol.
const NOFLAG_DEF = `DEF NOFLAG #PWR 0 0 Y Y 1 F N
F0 "#PWR" 0 -150 50 H I C CNN
F1 "NOFLAG" 0 140 50 H V C CNN
DRAW
X GND 1 0 0 0 U 50 50 1 1 W N
ENDDRAW
ENDDEF`;

const FLAG_DEF = `DEF PWR_FLAG #FLG 0 0 N N 1 F N
F0 "#FLG" 0 75 50 H I C CNN
F1 "PWR_FLAG" 0 150 50 H V C CNN
DRAW
X pwr 1 0 0 0 R 50 50 1 1 w
ENDDRAW
ENDDEF`;

const GFX_DEF = `DEF GFX G 0 0 N N 1 F N
F0 "G" 0 0 50 H V C CNN
F1 "GFX" 0 0 50 H V C CNN
DRAW
P 3 0 1 6 -100 -100 100 -100 100 100 F
S 300 200 100 100 0 1 10 N
C 0 0 50 0 1 0 f
A 0 0 100 0 900 0 1 0 N 100 0 0 100
T 0 -50 150 100 0 0 1 NAME Normal 0 L C
T 1 50 150 100 0 0 1 VERT Italic 1 R C
ENDDRAW
ENDDEF`;

const CACHE = lib(R_DEF, PROBE_DEF, MULTI_DEF, PWR_5V_DEF, NOFLAG_DEF, FLAG_DEF, GFX_DEF);
const withCache = (extra: Record<string, string> = {}) => ({ 'demo-cache.lib': CACHE, ...extra });

// ---------------------------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------------------------

describe('detection', () => {
  it('returns null for anything that is not a legacy schematic', () => {
    expect(parse('(kicad_sch (version 20231120) (generator "eeschema") (uuid "00000000-0000-0000-0000-000000000000"))', {}, 'x.kicad_sch')).toBeNull();
    expect(parse(CACHE)).toBeNull();
    expect(parse('')).toBeNull();
    expect(parse('<?xml version="1.0"?><eagle version="9.6"></eagle>')).toBeNull();
    expect(parse('EESchema Schematic Spins Version 1\n$EndSCHEMATC\n')).toBeNull();
    expect(parseKicadLegacySch({ name: 'x.sch', data: new Uint8Array([0, 1, 2, 3]) })).toBeNull();
  });

  it('accepts a UTF-8 BOM and leading whitespace before the header', () => {
    const body = enc(sheet(''));
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x20, 0x0a, ...body]);
    const result = parseKicadLegacySch({ name: 'demo.sch', data: bom });
    expect(result?.format).toBe('kicad-legacy-sch');
    expect(result?.sourceUnit).toBe('mil');
  });

  it('decodes non-UTF-8 text as Windows-1252 instead of failing', () => {
    const latin = new Uint8Array([...enc('EESchema Schematic File Version 4\n$Descr A4 11693 8268\n$EndDescr\nText Label 1000 1000 0 50 ~ 0\nCAF'), 0xc9, ...enc('\n$EndSCHEMATC\n')]);
    const result = parseKicadLegacySch({ name: 'demo.sch', data: latin });
    expect(root(result!).labels[0].text).toBe('CAFÉ');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------------------------

describe('file versions', () => {
  const minimal = (version: number) => sheet(`Wire Wire Line\n\t1000 1000 2000 1000\nText Label 1500 1000 0 50 ~ 0\nN${version}`, version);

  it.each([1, 2, 3, 4])('reads version %i', version => {
    const result = must(minimal(version));
    expect(result.formatLabel).toContain(`version ${version}`);
    expect(root(result).wires).toHaveLength(1);
    expect(root(result).labels[0].text).toBe(`N${version}`);
  });

  it('rejects versions newer than the legacy format and unreadable version numbers', () => {
    expect(thrown(minimal(5)).code).toBe('UNSUPPORTED_VARIANT');
    expect(thrown(minimal(0)).code).toBe('INVALID_FORMAT');
    expect(thrown('EESchema Schematic File Version\n$EndSCHEMATC\n').code).toBe('INVALID_FORMAT');
    expect(thrown('EESchema Schematic File Version x4\n$EndSCHEMATC\n').code).toBe('INVALID_FORMAT');
  });

  it('reads the examples of the published version-1 description', () => {
    const text = `EESchema Schematic File Version 1
LIBS:brooktre, cypress, ttl, power, linear, memory, xilinx, idiot, aaci, INTEL, special, device, dsp
EELAYER 20 0
EELAYER END
$Descr A3 16535 11700
Sheet 1 4
""
Date "28 DEC 1996"
Rev ""
Comp ""
Comment1 ""
$EndDescr
$Sheet
S 1800 1600 1500 1500
F0 "PROGALIM.SCH" 60
F1 "PROGALIM.SCH" 60
F2 "CLK" O R 3300 1800 60
F6 "TRANSF1" I L 1800 1900 60
$EndSheet
NoConn ~ 13400 5500
Connection ~ 13300 6500
Wire Wire Line
3300 1800 3900 1800
Wire Bus Line
3900 5300 4500 5300
Wire Notes Line
2850 3350 2850 3050
Entry Wire Bus
4100 2300 4200 2400
Entry Bus Bus
4400 2600 4500 2700
Text Notes 2100 3250 1 60 ~
TOTO
Text GLabel 3100 2500 2 60 UnSpc
TITI
Text GLabel 2750 2650 0 60 Output
GLABELOUT
Text HLabel 3400 2000 0 60 Input
/RESET
Text Label 3400 2100 0 60 ~
/RESET2
$EndSCHEMATC
`;
    // The published text shows fragments only; the terminator that real files end with is added.
    const result = must(text);
    const def = root(result);
    expect(def.titleBlock).toEqual({ date: '28 DEC 1996' });
    expect(def.paper).toEqual({ width: 420, height: 297.2 });
    expect(def.sheetRefs).toHaveLength(1);
    expect(def.sheetRefs[0]).toMatchObject({ id: 'sheet0', name: 'PROGALIM.SCH', file: 'PROGALIM.SCH', defId: null });
    expect(def.sheetRefs[0].pins.map(p => [p.name, p.shape, p.at.x, p.at.y])).toEqual([['CLK', 'output', 83.82, 45.72], ['TRANSF1', 'input', 45.72, 48.26]]);
    expect(diag(result, 'SHEET_FILE_MISSING')).toHaveLength(1);
    expect(def.noConnects).toEqual([{ id: 'nc0', at: { x: 340.36, y: 139.7 } }]);
    expect(def.junctions).toEqual([{ id: 'j0', at: { x: 337.82, y: 165.1 } }]);
    expect(def.wires).toHaveLength(1);
    expect(def.buses).toHaveLength(1);
    expect(def.busEntries).toHaveLength(2);
    expect(def.labels.map(l => [l.kind, l.text, l.shape])).toEqual([['global', 'TITI', 'passive'], ['global', 'GLABELOUT', 'output'], ['hierarchical', '/RESET', 'input'], ['local', '/RESET2', undefined]]);
    expect(def.graphics.filter(g => g.kind === 'text')).toHaveLength(1);
    expect(codes(result)).not.toContain('UNKNOWN_RECORD');
  });
});

describe('version 2 style records', () => {
  it('reads components, labels and sheets written without the newer trailing tokens', () => {
    const text = `EESchema Schematic File Version 2
LIBS:power,device
EELAYER 25 0
EELAYER END
$Descr A4 11693 8268
encoding utf-8
Sheet 1 1
Title ""
Date ""
Rev ""
Comp ""
Comment1 ""
Comment2 ""
Comment3 ""
Comment4 ""
$EndDescr
$Comp
L R R1
U 1 1 4F1E2D3C
P 4000 3000
F 0 "R1" H 4100 2900 60 0000 C C
F 1 "4k7" H 4100 3100 60 0000 C C
F 2 "R3" V 3930 3000 30 0000 C C
F 3 "" H 4000 3000 60 0001 C C
	1    4000 3000
	1    0    0    -1
$EndComp
Text Label 3000 3000 0 60 ~
SIG
Text GLabel 2000 3000 2 60 Input
GSIG
Wire Wire Line
	3000 3000 4000 2850
$EndSCHEMATC
`;
    const result = must(text, { 'demo-cache.lib': lib(R_DEF.replace('DEF Device_R', 'DEF R')) });
    const r1 = sym(result, 'R1');
    expect(result.formatLabel).toContain('version 2');
    expect(r1.pins.map(pinRow)).toEqual([['1', 101.6, 72.39, 101.6, 73.66], ['2', 101.6, 80.01, 101.6, 78.74]]);
    expect(r1).toMatchObject({ value: '4k7', footprint: 'R3', libId: 'R', id: '4F1E2D3C' });
    expect(r1.fields.map(f => f.hidden)).toEqual([false, false, false, true]);
    expect(root(result).labels.map(l => [l.kind, l.text, l.shape])).toEqual([['local', 'SIG', undefined], ['global', 'GSIG', 'input']]);
    expect(result.diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Title block, paper
// ---------------------------------------------------------------------------------------------------------------

describe('title block and paper', () => {
  it('reads the title block and converts the paper size to millimetres', () => {
    const def = root(must(sheet('')));
    expect(def.title).toBe('Synthetic');
    expect(def.titleBlock).toEqual({ title: 'Synthetic', date: '2024-01-02', rev: 'B', company: 'Acme', comment1: 'first' });
    expect(def.paper).toEqual({ width: 297, height: 210 });
    expect(def.name).toBe('demo');
    expect(def.file).toBe('demo.sch');
    expect(def.id).toBe('demo.sch');
  });

  it('uses the paper rectangle as the bounds of an empty sheet', () => {
    expect(root(must(sheet(''))).bounds).toEqual({ minX: 0, minY: 0, maxX: 297, maxY: 210 });
  });

  it('rejects an unterminated $Descr block', () => {
    expect(thrown('EESchema Schematic File Version 4\n$Descr A4 11693 8268\nTitle "x"\n').code).toBe('INVALID_FORMAT');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------------------------------------------

describe('resistor placement', () => {
  const R = (ref: string, ts: string, m: string) => comp({ lib: 'Device:R', ref, ts, x: 4000, y: 3000, m, value: '10k' });
  const result = must(sheet([R('R1', 'AAAA0001', NORMAL), R('R2', 'AAAA0002', '0    -1   -1   0'), R('R3', 'AAAA0003', '-1   0    0    1'), R('R4', 'AAAA0004', '0    1    1    0')].join('\n')), withCache());

  it('places the pins of all four orientations at exact millimetre coordinates (Y down)', () => {
    expect(sym(result, 'R1').pins.map(pinRow)).toEqual([['1', 101.6, 72.39, 101.6, 73.66], ['2', 101.6, 80.01, 101.6, 78.74]]);
    expect(sym(result, 'R2').pins.map(pinRow)).toEqual([['1', 97.79, 76.2, 99.06, 76.2], ['2', 105.41, 76.2, 104.14, 76.2]]);
    expect(sym(result, 'R3').pins.map(pinRow)).toEqual([['1', 101.6, 80.01, 101.6, 78.74], ['2', 101.6, 72.39, 101.6, 73.66]]);
    expect(sym(result, 'R4').pins.map(pinRow)).toEqual([['1', 105.41, 76.2, 104.14, 76.2], ['2', 97.79, 76.2, 99.06, 76.2]]);
  });

  it('decodes rotation and keeps the symbol data', () => {
    expect(['R1', 'R2', 'R3', 'R4'].map(ref => [sym(result, ref).rotation, sym(result, ref).mirror])).toEqual([[0, 'none'], [90, 'none'], [180, 'none'], [270, 'none']]);
    const r1 = sym(result, 'R1');
    expect(r1).toMatchObject({ id: 'AAAA0001', libId: 'Device:R', refDefault: 'R1', value: '10k', footprint: '', datasheet: '', unit: 1, unitCount: 1, virtual: false, dnp: false, at: { x: 101.6, y: 76.2 } });
    expect(r1.power).toBeUndefined();
    expect(r1.instances).toEqual({ '': { ref: 'R1', unit: 1 } });
    expect(r1.pins.map(p => [p.id, p.name, p.type, p.hidden, p.unit, p.implicitNet])).toEqual([['AAAA0001#1', '', 'passive', false, 1, undefined], ['AAAA0001#2', '', 'passive', false, 1, undefined]]);
  });

  it('draws the body rectangle in absolute coordinates and bounds the symbol by body and pins', () => {
    const r2 = sym(result, 'R2');
    expect(r2.graphics).toEqual([{ kind: 'rect', min: { x: 99.06, y: 75.184 }, max: { x: 104.14, y: 77.216 }, width: 0.254, fill: 'none' }]);
    expect(r2.bounds).toEqual({ minX: 97.79, minY: 75.184, maxX: 105.41, maxY: 77.216 });
  });
});

describe('rotation and mirror matrices', () => {
  const cases: Array<[string, number, 'none' | 'x' | 'y', number, number, number, number]> = [
    ['1 0 0 -1', 0, 'none', 27.94, 24.13, 28.956, 24.13],
    ['0 -1 -1 0', 90, 'none', 24.13, 22.86, 24.13, 21.844],
    ['-1 0 0 1', 180, 'none', 22.86, 26.67, 21.844, 26.67],
    ['0 1 1 0', 270, 'none', 26.67, 27.94, 26.67, 28.956],
    ['1 0 0 1', 0, 'x', 27.94, 26.67, 28.956, 26.67],
    ['-1 0 0 -1', 0, 'y', 22.86, 24.13, 21.844, 24.13],
    ['0 -1 1 0', 270, 'x', 24.13, 27.94, 24.13, 28.956],
    ['0 1 -1 0', 90, 'x', 26.67, 22.86, 26.67, 21.844],
  ];
  it.each(cases)('matrix %s', (matrix, rotation, mirror, ax, ay, bx, by) => {
    const result = must(sheet(comp({ lib: 'PROBE', ref: 'X1', x: 1000, y: 1000, m: matrix })), withCache());
    const x1 = sym(result, 'X1');
    expect([x1.rotation, x1.mirror]).toEqual([rotation, mirror]);
    expect(x1.pins.map(pinRow)).toEqual([['1', ax, ay, bx, by]]);
    expect(x1.pins[0]).toMatchObject({ name: 'P', type: 'input' });
  });

  it('rejects matrices that are not rotations or mirrors, and a missing matrix', () => {
    expect(thrown(sheet(comp({ lib: 'PROBE', ref: 'X1', x: 0, y: 0, m: '1 1 0 -1' })), withCache()).code).toBe('INVALID_FORMAT');
    expect(thrown(sheet(comp({ lib: 'PROBE', ref: 'X1', x: 0, y: 0, m: '0 0 0 0' })), withCache()).code).toBe('INVALID_FORMAT');
    expect(thrown(sheet(comp({ lib: 'PROBE', ref: 'X1', x: 0, y: 0, m: '1 0 0 two' })), withCache()).code).toBe('INVALID_FORMAT');
    const noMatrix = comp({ lib: 'PROBE', ref: 'X1', x: 0, y: 0 }).split('\n').filter(line => !line.includes(NORMAL)).join('\n');
    expect(thrown(sheet(noMatrix), withCache()).message).toMatch(/orientation matrix/i);
  });
});

describe('multi-unit part with body styles', () => {
  const result = must(sheet([
    comp({ lib: 'U_MULTI', ref: 'U1', ts: '00000A01', unit: 1, x: 6000, y: 4000 }),
    comp({ lib: 'U_MULTI', ref: 'U1', ts: '00000A02', unit: 2, x: 6000, y: 6000 }),
    comp({ lib: 'U_MULTI', ref: 'U1', ts: '00000A03', unit: 1, convert: 2, x: 6000, y: 8000 }),
  ].join('\n')), withCache());
  const [a, b, c] = root(result).symbols;

  it('selects unit-specific, body-style-specific and common pins', () => {
    expect(a.pins.map(p => p.number)).toEqual(['1', '2', '14', '7']);
    expect(b.pins.map(p => p.number)).toEqual(['3', '14', '7']);
    expect(c.pins.map(p => p.number)).toEqual(['5', '14', '7']);
    expect(a.pins.map(p => p.unit)).toEqual([1, 1, 0, 0]);
    expect(b.pins.map(p => p.unit)).toEqual([2, 0, 0]);
    expect(a.unit).toBe(1);
    expect(b.unit).toBe(2);
    expect([a.unitCount, b.unitCount, c.unitCount]).toEqual([2, 2, 2]);
    expect(a.instances).toEqual({ '': { ref: 'U1', unit: 1 } });
    expect(b.instances).toEqual({ '': { ref: 'U1', unit: 2 } });
  });

  it('positions pins and draws only the placed unit body', () => {
    expect(a.pins.slice(0, 2).map(pinRow)).toEqual([['1', 144.78, 100.33, 147.32, 100.33], ['2', 160.02, 100.33, 157.48, 100.33]]);
    expect(b.pins[0].at).toEqual({ x: 147.32, y: 152.4 });
    expect(c.pins[0].at).toEqual({ x: 144.78, y: 204.47 });
    expect(a.graphics).toEqual([{ kind: 'rect', min: { x: 147.32, y: 99.06 }, max: { x: 157.48, y: 104.14 }, width: 0.254, fill: 'background' }]);
    expect(b.graphics).toHaveLength(1);
    expect(a.bounds).toEqual({ minX: 144.78, minY: 96.52, maxX: 160.02, maxY: 106.68 });
  });

  it('marks hidden power-input pins with their implicit global net', () => {
    const vcc = a.pins.find(p => p.number === '14')!;
    expect(vcc).toMatchObject({ name: 'VCC', type: 'power_in', hidden: true, implicitNet: 'VCC', unit: 0 });
    expect(vcc.at).toEqual({ x: 152.4, y: 96.52 });
    expect(a.pins.find(p => p.number === '7')).toMatchObject({ implicitNet: 'GND', hidden: true });
    expect(a.pins.find(p => p.number === '1')!.implicitNet).toBeUndefined();
    expect(a.pins.find(p => p.number === '1')).toMatchObject({ type: 'input', hidden: false, name: 'IN1' });
  });

  it('keeps pin ids unique even when numbers repeat across units', () => {
    const lib2 = lib(`DEF DUALPIN D 0 0 Y Y 2 F N
DRAW
X A 1 0 0 100 R 50 50 1 1 P
X B 1 0 100 100 R 50 50 2 1 P
X C 2 0 200 100 R 50 50 0 1 P
X D 2 0 300 100 R 50 50 0 1 P
ENDDRAW
ENDDEF`);
    const dual = must(sheet(comp({ lib: 'DUALPIN', ref: 'D1', x: 0, y: 0 })), { 'demo-cache.lib': lib2 });
    const ids = sym(dual, 'D1').pins.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['5F000001#1', '5F000001#2@0', '5F000001#2@0.1']);
  });
});

describe('nameless hidden power pins', () => {
  it('does not invent an implicit net from a pin without a name', () => {
    const nameless = lib(`DEF NAMELESS U 0 0 Y Y 1 F N
DRAW
X ~ 1 0 0 0 R 50 50 1 1 W N
ENDDRAW
ENDDEF`);
    const result = must(sheet(comp({ lib: 'NAMELESS', ref: 'U1', x: 0, y: 0 })), { 'demo-cache.lib': nameless });
    expect(sym(result, 'U1').pins[0]).toMatchObject({ hidden: true, type: 'power_in', name: '' });
    expect(sym(result, 'U1').pins[0].implicitNet).toBeUndefined();
    expect(codes(result)).toEqual(['IMPLICIT_NET_UNNAMED']);
  });
});

describe('power symbols', () => {
  const result = must(sheet([
    comp({ lib: 'power:+5V', ref: '#PWR01', ts: '00000B01', x: 1000, y: 1000, value: '+5V' }),
    comp({ lib: 'power:+5V', ref: '#PWR02', ts: '00000B02', x: 2000, y: 1000, value: 'VCC_RENAMED' }),
    comp({ lib: 'NOFLAG', ref: '#PWR03', ts: '00000B03', x: 3000, y: 1000, value: 'GND' }),
    comp({ lib: 'PWR_FLAG', ref: '#FLG04', ts: '00000B04', x: 4000, y: 1000, value: 'PWR_FLAG' }),
    comp({ lib: 'power:+5V', ref: '#PWR05', ts: '00000B05', x: 5000, y: 1000, value: '' }),
  ].join('\n')), withCache());

  it('ties a library power symbol to the net named by its value field', () => {
    const p1 = sym(result, '#PWR01');
    expect(p1.power).toEqual({ net: '+5V' });
    expect(p1.virtual).toBe(true);
    expect(p1.pins).toHaveLength(1);
    expect(p1.pins[0]).toMatchObject({ number: '1', name: '+5V', type: 'power_in', hidden: true });
    expect(p1.pins[0].at).toEqual(p1.pins[0].body);
    expect(p1.pins[0].implicitNet).toBeUndefined();
    expect(sym(result, '#PWR02').power).toEqual({ net: 'VCC_RENAMED' });
  });

  it('recognises power symbols by their #PWR reference and keeps power flags out of the nets', () => {
    expect(sym(result, '#PWR03').power).toEqual({ net: 'GND' });
    const flag = sym(result, '#FLG04');
    expect(flag.virtual).toBe(true);
    expect(flag.power).toBeUndefined();
    expect(flag.pins[0].type).toBe('power_out');
  });

  it('does not invent a net for a power symbol without a value', () => {
    const empty = sym(result, '#PWR05');
    expect(empty.power).toBeUndefined();
    expect(empty.pins[0].implicitNet).toBe('+5V');
    expect(diag(result, 'POWER_VALUE_MISSING')).toHaveLength(1);
  });
});

describe('symbol graphics', () => {
  const result = must(sheet([
    comp({ lib: 'GFX', ref: 'G1', ts: '00000C01', x: 2000, y: 2000 }),
    comp({ lib: 'GFX', ref: 'G2', ts: '00000C02', x: 2000, y: 2000, m: '-1 0 0 1' }),
  ].join('\n')), withCache());
  const g1 = sym(result, 'G1');

  it('converts polylines, rectangles, circles and text with the placement transform', () => {
    expect(g1.graphics).toHaveLength(6);
    expect(g1.graphics[0]).toEqual({ kind: 'poly', points: [{ x: 48.26, y: 53.34 }, { x: 53.34, y: 53.34 }, { x: 53.34, y: 48.26 }], width: 0.1524, filled: true });
    expect(g1.graphics[1]).toEqual({ kind: 'rect', min: { x: 53.34, y: 45.72 }, max: { x: 58.42, y: 48.26 }, width: 0.254, fill: 'none' });
    expect(g1.graphics[2]).toEqual({ kind: 'circle', center: { x: 50.8, y: 50.8 }, radius: 1.27, width: 0, fill: 'background' });
    expect(g1.graphics[4]).toEqual({ kind: 'text', at: { x: 49.53, y: 46.99 }, text: 'NAME', angle: 0, size: 2.54, anchor: 'start', italic: false, bold: false });
    expect(g1.graphics[5]).toEqual({ kind: 'text', at: { x: 52.07, y: 46.99 }, text: 'VERT', angle: 90, size: 2.54, anchor: 'end', italic: true, bold: true });
  });

  it('samples arcs into a polyline between the given end points', () => {
    const arc = g1.graphics[3];
    if (arc.kind !== 'poly') throw new Error('arc must be a polyline');
    expect(arc.points).toHaveLength(10);
    expect(arc.points[0]).toEqual({ x: 53.34, y: 50.8 });
    expect(arc.points[9]).toEqual({ x: 50.8, y: 48.26 });
    expect(arc.filled).toBe(false);
    for (const point of arc.points) expect(Math.hypot(point.x - 50.8, point.y - 50.8)).toBeCloseTo(2.54, 4);
    expect(arc.points[4].x).toBeGreaterThan(arc.points[9].x);
    expect(arc.points[4].y).toBeLessThan(50.8);
  });

  it('keeps text readable and swaps its anchor when the placement flips the reading direction', () => {
    const g2 = sym(result, 'G2');
    expect(g2.graphics[4]).toMatchObject({ kind: 'text', at: { x: 52.07, y: 54.61 }, angle: 0, anchor: 'end' });
    expect(g2.graphics[5]).toMatchObject({ kind: 'text', angle: 90, anchor: 'start' });
  });

  it('draws the shorter arc when the library gives end points, and from the angles otherwise', () => {
    const arcLib = lib(`DEF ARCS A 0 0 N N 1 F N
DRAW
A 0 0 100 100 1000 0 1 0 N 0 100 -100 0
A 0 0 100 0 900 0 1 0 N
A 0 0 100 900 0 0 1 0 N
ENDDRAW
ENDDEF`);
    const arcs = must(sheet(comp({ lib: 'ARCS', ref: 'A1', x: 0, y: 0 })), { 'demo-cache.lib': arcLib });
    const [one, two, three] = sym(arcs, 'A1').graphics.map(g => (g.kind === 'poly' ? g.points : []));
    expect(one[0]).toEqual({ x: 0, y: -2.54 });
    expect(one[one.length - 1]).toEqual({ x: -2.54, y: 0 });
    expect(one.every(p => p.x <= 0 && p.y <= 0)).toBe(true);
    expect(two[0]).toEqual({ x: 2.54, y: 0 });
    expect(two[two.length - 1]).toEqual({ x: 0, y: -2.54 });
    expect(three[0]).toEqual({ x: 2.54, y: 0 });
    expect(three[three.length - 1]).toEqual({ x: 0, y: -2.54 });
  });
});

describe('fields', () => {
  const text = sheet(`$Comp
L Device:R R7
U 1 1 5F3A1B2C
P 4000 3000
F 0 "R7" V 3800 3000 50  0000 C CNN
F 1 "10k \\"1%\\"" V 4000 3000 50  0000 C CNN
F 2 "Resistor_SMD:R_0603" V 3930 3000 50  0001 C CNN
F 3 "~" H 4000 3000 50  0001 C CNN
F 4 "Murata" H 4000 3000 50  0001 C CNN "MPN"
F 5 "x y" H 4100 3100 60  0000 L CIB
	1    4000 3000
	0    -1   -1   0
$EndComp`);
  const result = must(text, withCache());
  const r7 = sym(result, 'R7');

  it('reads field text, position, orientation, visibility and names', () => {
    expect(r7.fields).toEqual([
      { name: 'Reference', value: 'R7', at: { x: 96.52, y: 76.2 }, angle: 90, hidden: false },
      { name: 'Value', value: '10k "1%"', at: { x: 101.6, y: 76.2 }, angle: 90, hidden: false },
      { name: 'Footprint', value: 'Resistor_SMD:R_0603', at: { x: 99.822, y: 76.2 }, angle: 90, hidden: true },
      { name: 'Datasheet', value: '~', at: { x: 101.6, y: 76.2 }, angle: 0, hidden: true },
      { name: 'MPN', value: 'Murata', at: { x: 101.6, y: 76.2 }, angle: 0, hidden: true },
      { name: 'Field5', value: 'x y', at: { x: 104.14, y: 78.74 }, angle: 0, hidden: false },
    ]);
    expect(r7).toMatchObject({ value: '10k "1%"', footprint: 'Resistor_SMD:R_0603', datasheet: '', refDefault: 'R7' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Wires, labels and the other sheet records
// ---------------------------------------------------------------------------------------------------------------

describe('wires, buses, entries, junctions and no-connects', () => {
  const result = must(sheet(`Wire Wire Line
	1000 1000 2000 1000
Wire Wire Line
	2000 1000 2000 1500
Wire Bus Line
	3000 1000 3000 2000
Wire Notes Line
	4000 1000 4500 1000
Entry Wire Line
	3000 1200 3100 1300
Entry Bus Bus
	3000 1500 3100 1600
Connection ~ 2000 1000
Connection ~ 3000 1700
NoConn ~ 2500 1500`));
  const def = root(result);

  it('converts every record with deterministic ids', () => {
    expect(def.wires).toEqual([{ id: 'w0', a: { x: 25.4, y: 25.4 }, b: { x: 50.8, y: 25.4 } }, { id: 'w1', a: { x: 50.8, y: 25.4 }, b: { x: 50.8, y: 38.1 } }]);
    expect(def.buses).toEqual([{ id: 'b0', a: { x: 76.2, y: 25.4 }, b: { x: 76.2, y: 50.8 } }]);
    expect(def.busEntries).toEqual([{ id: 'e0', at: { x: 76.2, y: 30.48 }, to: { x: 78.74, y: 33.02 } }, { id: 'e1', at: { x: 76.2, y: 38.1 }, to: { x: 78.74, y: 40.64 } }]);
    expect(def.junctions).toEqual([{ id: 'j0', at: { x: 50.8, y: 25.4 } }, { id: 'j1', at: { x: 76.2, y: 43.18 } }]);
    expect(def.noConnects).toEqual([{ id: 'nc0', at: { x: 63.5, y: 38.1 } }]);
  });

  it('keeps Notes lines as electrically meaningless graphics', () => {
    expect(def.graphics).toEqual([{ kind: 'poly', points: [{ x: 101.6, y: 25.4 }, { x: 114.3, y: 25.4 }], width: 0, filled: false }]);
    expect(def.bounds).toEqual({ minX: 25.4, minY: 25.4, maxX: 114.3, maxY: 50.8 });
  });

  it('rejects a record that lacks its coordinate line', () => {
    expect(thrown(sheet('Wire Wire Line')).code).toBe('INVALID_FORMAT');
    expect(thrown(sheet('Wire Wire Line\n\t1000 1000 2000')).code).toBe('INVALID_FORMAT');
    expect(thrown(sheet('Connection ~ 1000')).code).toBe('INVALID_FORMAT');
    expect(thrown(sheet('NoConn ~ a b')).code).toBe('INVALID_FORMAT');
  });
});

describe('labels', () => {
  const result = must(sheet(`Text Label 1000 2000 0 50 ~ 0
NET_A
Text Label 1000 2100 1 60 ~ 0
NET_B
Text Label 1000 2200 2 50 Italic 0
NET_C
Text Label 1000 2300 3 50 ~ 0
NET_D
Text GLabel 3000 2000 0 50 Input ~ 0
GIN
Text GLabel 3000 2100 2 50 Output ~ 0
GOUT
Text GLabel 3000 2200 0 50 BiDi ~ 0
GBI
Text GLabel 3000 2300 0 50 3State ~ 0
G3S
Text GLabel 3000 2400 0 50 UnSpc ~ 0
GUN
Text HLabel 5000 2000 0 50 Output ~ 0
H_OUT
Text Notes 7000 7000 1 60 Italic 12
First line\\nSecond
Text Notes 7000 7100 2 50 ~ 0
Right aligned`));
  const def = root(result);

  it('reads local, global and hierarchical labels with orientation and shape', () => {
    expect(def.labels.map(l => [l.id, l.kind, l.text, l.at.x, l.at.y, l.angle, l.shape])).toEqual([
      ['l0', 'local', 'NET_A', 25.4, 50.8, 0, undefined],
      ['l1', 'local', 'NET_B', 25.4, 53.34, 90, undefined],
      ['l2', 'local', 'NET_C', 25.4, 55.88, 180, undefined],
      ['l3', 'local', 'NET_D', 25.4, 58.42, 270, undefined],
      ['l4', 'global', 'GIN', 76.2, 50.8, 0, 'input'],
      ['l5', 'global', 'GOUT', 76.2, 53.34, 180, 'output'],
      ['l6', 'global', 'GBI', 76.2, 55.88, 0, 'bidirectional'],
      ['l7', 'global', 'G3S', 76.2, 58.42, 0, 'tri_state'],
      ['l8', 'global', 'GUN', 76.2, 60.96, 0, 'passive'],
      ['l9', 'hierarchical', 'H_OUT', 127, 50.8, 0, 'output'],
    ]);
  });

  it('turns text notes into drawing text with unescaped line breaks', () => {
    const texts = def.graphics.filter(g => g.kind === 'text');
    expect(texts).toEqual([
      { kind: 'text', at: { x: 177.8, y: 177.8 }, text: 'First line\nSecond', angle: 90, size: 1.524, anchor: 'start', italic: true },
      { kind: 'text', at: { x: 177.8, y: 180.34 }, text: 'Right aligned', angle: 0, size: 1.27, anchor: 'end', italic: false },
    ]);
  });

  it('rejects a label without its text line', () => {
    expect(thrown('EESchema Schematic File Version 4\nText Label 1000 2000 0 50 ~ 0').code).toBe('INVALID_FORMAT');
  });
});

describe('unknown records', () => {
  it('reports them as info diagnostics and carries on', () => {
    const result = must(sheet(`Frobnicate 1 2 3
$Weird
inner line
$EndWeird
$Bitmap
Pos 100 100
Scale 1,000000
Data
89 50 4E 47
EndData
$EndBitmap
Entry Wire Weird
	1 2 3 4
Wire Dashed Line
	1 2 3 4
NoConn ~ 1000 1000`));
    const unknown = diag(result, 'UNKNOWN_RECORD');
    expect(unknown).toHaveLength(5);
    expect(unknown.every(d => d.severity === 'info' && d.defId === 'demo.sch')).toBe(true);
    expect(unknown[0].message).toContain('Frobnicate');
    expect(unknown[1].message).toContain('$Weird');
    expect(unknown[2].message).toMatch(/bitmap/i);
    expect(root(result).noConnects).toHaveLength(1);
    expect(root(result).busEntries).toHaveLength(0);
    expect(root(result).wires).toHaveLength(0);
  });

  it('caps repeated diagnostics of one kind', () => {
    const result = must(sheet('Bogus 1\n'.repeat(500)));
    expect(diag(result, 'UNKNOWN_RECORD')).toHaveLength(200);
    expect(diag(result, 'DIAGNOSTICS_TRUNCATED')[0].message).toContain('300');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Libraries
// ---------------------------------------------------------------------------------------------------------------

describe('library resolution', () => {
  const dupCache = `DEF DUP D 0 0 Y Y 1 F N
DRAW
X cache C1 0 0 50 R 50 50 1 1 P
ENDDRAW
ENDDEF`;
  const extraLib = `EESchema-LIBRARY Version 2.0 24/1/1997-18:9:6
DEF DUP D 0 0 Y Y 1 F N
DRAW
X extra E1 0 0 50 R 50 50 1 1 P
ENDDRAW
ENDDEF
DEF ZED Z 0 0 Y Y 1 F N
ALIAS ZEDALIAS ZEDTWO
DRAW
X zed Z1 0 0 50 L 50 50 1 1 P
ENDDRAW
ENDDEF
# End Library
`;
  const result = must(sheet([
    comp({ lib: 'DUP', ref: 'D1', ts: '00000D01', x: 0, y: 0 }),
    comp({ lib: 'extra:DUP', ref: 'D2', ts: '00000D02', x: 1000, y: 0 }),
    comp({ lib: 'extra:ZED', ref: 'Z1', ts: '00000D03', x: 2000, y: 0 }),
    comp({ lib: 'ZEDALIAS', ref: 'Z2', ts: '00000D04', x: 3000, y: 0 }),
    comp({ lib: 'Device:R', ref: 'R1', ts: '00000D05', x: 4000, y: 0 }),
  ].join('\n')), { 'demo-cache.lib': lib(dupCache, R_DEF), 'extra.lib': extraLib });

  it('prefers the project cache, honours the library nickname and resolves aliases', () => {
    expect(sym(result, 'D1').pins.map(p => p.number)).toEqual(['C1']);
    expect(sym(result, 'D2').pins.map(p => p.number)).toEqual(['E1']);
    expect(sym(result, 'Z1').pins.map(p => p.number)).toEqual(['Z1']);
    expect(sym(result, 'Z2').pins.map(p => [p.number, p.at.x])).toEqual([['Z1', 76.2]]);
    expect(sym(result, 'R1').pins).toHaveLength(2);
    expect(result.diagnostics).toEqual([]);
  });

  it('finds the cache entry of a nickname-qualified symbol under its underscore name', () => {
    expect(sym(must(sheet(comp({ lib: 'Device:R', ref: 'R1', x: 0, y: 0 })), { 'demo-cache.lib': lib(R_DEF) }), 'R1').pins).toHaveLength(2);
  });

  it('reads a symbol from any companion library when no cache is present', () => {
    expect(sym(must(sheet(comp({ lib: 'ZED', ref: 'Z9', x: 0, y: 0 })), { 'other.lib': extraLib }), 'Z9').pins).toHaveLength(1);
  });
});

describe('missing and invalid library symbols', () => {
  it('reports LIB_SYMBOL_MISSING and invents no pins', () => {
    const result = must(sheet(comp({ lib: 'Missing:Foo', ref: 'U9', ts: '00000E01', unit: 3, x: 1000, y: 2000 })), withCache());
    const u9 = sym(result, 'U9');
    expect(u9.pins).toEqual([]);
    expect(u9.graphics).toEqual([]);
    expect(u9).toMatchObject({ libId: 'Missing:Foo', unit: 3, unitCount: 3, at: { x: 25.4, y: 50.8 } });
    expect(u9.bounds).toEqual({ minX: 25.4, minY: 50.8, maxX: 25.4, maxY: 50.8 });
    const missing = diag(result, 'LIB_SYMBOL_MISSING');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ severity: 'warning', defId: 'demo.sch', at: { x: 25.4, y: 50.8 } });
    expect(missing[0].message).toContain('Missing:Foo');
  });

  it('works without any library file at all', () => {
    const result = must(sheet(comp({ lib: 'Device:R', ref: 'R1', x: 0, y: 0 })));
    expect(codes(result)).toEqual(['LIB_SYMBOL_MISSING']);
  });

  it('ignores companion .lib files that are not legacy libraries, with a warning', () => {
    const result = must(sheet(comp({ lib: 'Nope', ref: 'U1', x: 0, y: 0 })), withCache({ 'junk.lib': 'hello' }));
    expect(codes(result)).toEqual(['LIB_FILE_INVALID', 'LIB_SYMBOL_MISSING']);
  });

  it('reports a malformed or truncated library entry instead of guessing', () => {
    const broken = lib(`DEF BROKEN B 0 0 Y Y 1 F N
DRAW
X onlyname
ENDDRAW
ENDDEF`, `DEF CUT C 0 0 Y Y 1 F N
DRAW
X A 1 0 0 50 R 50 50 1 1 P`);
    const result = must(sheet([comp({ lib: 'BROKEN', ref: 'B1', ts: '00000F01', x: 0, y: 0 }), comp({ lib: 'CUT', ref: 'C1', ts: '00000F02', x: 0, y: 0 })].join('\n')), { 'demo-cache.lib': broken });
    expect(sym(result, 'B1').pins).toEqual([]);
    expect(sym(result, 'C1').pins).toEqual([]);
    expect(diag(result, 'LIB_SYMBOL_INVALID')).toHaveLength(2);
    expect(diag(result, 'LIB_SYMBOL_INVALID')[0].severity).toBe('error');
  });

  it('warns when the placed unit does not exist in the library entry', () => {
    const result = must(sheet(comp({ lib: 'U_MULTI', ref: 'U1', unit: 4, x: 0, y: 0 })), withCache());
    expect(diag(result, 'UNIT_OUT_OF_RANGE')).toHaveLength(1);
    expect(sym(result, 'U1').pins.map(p => p.number)).toEqual(['14', '7']);
  });

  it('reports library records it does not understand', () => {
    const odd = lib(`DEF ODD O 0 0 Y Y 1 F N
DRAW
Z 1 2 3
X A 1 0 0 50 R 50 50 1 1 Q
ENDDRAW
ENDDEF`);
    const result = must(sheet(comp({ lib: 'ODD', ref: 'O1', x: 0, y: 0 })), { 'demo-cache.lib': odd });
    expect(codes(result).sort()).toEqual(['UNKNOWN_PIN_TYPE', 'UNKNOWN_RECORD']);
    expect(sym(result, 'O1').pins[0].type).toBe('unspecified');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------------------------------------------

const rootHier = sheet(`${comp({ lib: 'Device:R', ref: 'R10', ts: '00C0FFEE', x: 1000, y: 1000, ar: ['Path="/00C0FFEE" Ref="R10" Part="1"'] })}
$Sheet
S 3000 2000 1000 800
U AAAA0001
F0 "Left" 60
F1 "child.sch" 60
F2 "IN" I L 3000 2200 60
F3 "OUT" O R 4000 2200 60
$EndSheet
$Sheet
S 5000 2000 1000 800
U BBBB0002
F0 "Right" 60
F1 "Child.SCH" 60
$EndSheet`);
const childHier = sheet(`${comp({ lib: 'Device:R', ref: 'R?', ts: 'C0C0C0C0', x: 1000, y: 1000, ar: ['Path="/AAAA0001/C0C0C0C0" Ref="R1" Part="1"', 'Path="/BBBB0002/C0C0C0C0" Ref="R2" Part="1"'] })}
Text HLabel 800 1200 2 50 Input ~ 0
IN
$Sheet
S 3000 3000 800 600
U 0000AA77
F0 "Deep" 50
F1 "grand.sch" 50
$EndSheet`);
const grandHier = sheet(comp({ lib: 'Device:R', ref: 'R?', ts: 'D0D0D0D0', x: 500, y: 500, ar: ['Path="/AAAA0001/0000AA77/D0D0D0D0" Ref="R3" Part="1"', 'Path="/BBBB0002/0000AA77/D0D0D0D0" Ref="R4" Part="1"'] }));
const hierFiles = withCache({ 'child.sch': childHier, 'grand.sch': grandHier });

describe('hierarchical sheets', () => {
  const result = must(rootHier, hierFiles);

  it('resolves sheet files from the companions and expands repeated sheets into instances', () => {
    expect(result.defs.map(d => d.id)).toEqual(['demo.sch', 'child.sch', 'grand.sch']);
    expect(result.rootDefId).toBe('demo.sch');
    expect(result.instances.map(i => [i.path, i.defId, i.name, i.page, i.parentPath, i.sheetRefId, i.depth])).toEqual([
      ['', 'demo.sch', 'demo', '1', null, null, 0],
      ['/AAAA0001', 'child.sch', 'Left', '2', '', 'AAAA0001', 1],
      ['/AAAA0001/0000AA77', 'grand.sch', 'Deep', '3', '/AAAA0001', '0000AA77', 2],
      ['/BBBB0002', 'child.sch', 'Right', '4', '', 'BBBB0002', 1],
      ['/BBBB0002/0000AA77', 'grand.sch', 'Deep', '5', '/BBBB0002', '0000AA77', 2],
    ]);
    expect(result.instances.map(i => i.childPaths)).toEqual([['/AAAA0001', '/BBBB0002'], ['/AAAA0001/0000AA77'], [], ['/BBBB0002/0000AA77'], []]);
    expect(root(result).sheetRefs.map(r => [r.id, r.name, r.file, r.defId])).toEqual([['AAAA0001', 'Left', 'child.sch', 'child.sch'], ['BBBB0002', 'Right', 'Child.SCH', 'child.sch']]);
    expect(result.diagnostics).toEqual([]);
  });

  it('reads sheet symbols and sheet pins', () => {
    const [left] = root(result).sheetRefs;
    expect(left.at).toEqual({ x: 76.2, y: 50.8 });
    expect(left.size).toEqual({ x: 25.4, y: 20.32 });
    expect(left.pins).toEqual([{ id: 'AAAA0001#2', name: 'IN', at: { x: 76.2, y: 55.88 }, shape: 'input' }, { id: 'AAAA0001#3', name: 'OUT', at: { x: 101.6, y: 55.88 }, shape: 'output' }]);
  });

  it('keys the alternate references by our instance path', () => {
    const child = result.defs[1].symbols[0];
    expect(child.refDefault).toBe('R?');
    expect(child.instances).toEqual({ '/AAAA0001': { ref: 'R1', unit: 1 }, '/BBBB0002': { ref: 'R2', unit: 1 } });
    expect(symbolRef(child, '/AAAA0001')).toBe('R1');
    expect(symbolRef(child, '/BBBB0002')).toBe('R2');
    const grand = result.defs[2].symbols[0];
    expect(symbolRef(grand, '/AAAA0001/0000AA77')).toBe('R3');
    expect(symbolRef(grand, '/BBBB0002/0000AA77')).toBe('R4');
    expect(root(result).symbols[0].instances).toEqual({ '': { ref: 'R10', unit: 1 } });
  });

  it('is deterministic and structured-clone safe', () => {
    const again = must(rootHier, hierFiles);
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
    expect(structuredClone(result)).toEqual(result);
  });

  it('ignores an alternate reference whose component timestamp is stale', () => {
    const stale = sheet(comp({ lib: 'Device:R', ref: 'R5', ts: '5F000009', x: 0, y: 0, ar: ['Path="/AAAA0001/DEADBEEF" Ref="R99" Part="1"'] }));
    const result2 = must(stale, withCache());
    expect(sym(result2, 'R5').instances).toEqual({ '': { ref: 'R5', unit: 1 } });
    expect(diag(result2, 'AR_PATH_MISMATCH')).toHaveLength(1);
  });

  it('reports a missing sub-sheet file and leaves defId null', () => {
    const missing = must(sheet(`$Sheet
S 3000 2000 1000 800
U AAAA0001
F0 "Gone" 60
F1 "gone.sch" 60
$EndSheet
$Sheet
S 5000 2000 1000 800
U AAAA0002
F0 "Elsewhere" 60
F1 "sub/other.sch" 60
$EndSheet`), { 'other.sch': sheet('') });
    expect(root(missing).sheetRefs.map(r => r.defId)).toEqual([null, null]);
    expect(missing.instances).toHaveLength(1);
    expect(missing.defs).toHaveLength(1);
    const found = diag(missing, 'SHEET_FILE_MISSING');
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ severity: 'warning', defId: 'demo.sch' });
    expect(found[0].message).toContain('gone.sch');
    expect(found[1].message).toContain('sub/other.sch');
  });

  it('rejects a companion sheet that is not a legacy schematic', () => {
    expect(thrown(rootHier, { ...hierFiles, 'child.sch': '(kicad_sch (version 20231120))' }).code).toBe('INVALID_FORMAT');
  });

  it('gives sheet symbols with duplicate timestamps distinct ids', () => {
    const dup = must(sheet(`$Sheet
S 0 0 100 100
U AAAA0001
F0 "A" 60
F1 "child.sch" 60
$EndSheet
$Sheet
S 200 0 100 100
U AAAA0001
F0 "B" 60
F1 "child.sch" 60
$EndSheet`), { 'child.sch': sheet('') });
    expect(root(dup).sheetRefs.map(r => r.id)).toEqual(['sheet0', 'sheet1']);
    expect(dup.instances.map(i => i.path)).toEqual(['', '/sheet0', '/sheet1']);
    expect(diag(dup, 'DUPLICATE_TIMESTAMP')).toHaveLength(1);
  });

  it('rejects a sheet block without geometry or file', () => {
    expect(thrown(sheet('$Sheet\nU AAAA0001\nF0 "A" 60\nF1 "x.sch" 60\n$EndSheet')).code).toBe('INVALID_FORMAT');
    expect(thrown(sheet('$Sheet\nS 0 0 100 100\nU AAAA0001\nF0 "A" 60\n$EndSheet')).code).toBe('INVALID_FORMAT');
    expect(thrown(sheet('$Sheet\nS 0 0 100 100\nF0 "A" 60\nF1 "x.sch" 60')).code).toBe('INVALID_FORMAT');
  });

  it('rejects hierarchy cycles, including a sheet that includes itself or the root', () => {
    const include = (file: string) => sheet(`$Sheet\nS 0 0 100 100\nU AAAA0001\nF0 "X" 60\nF1 "${file}" 60\n$EndSheet`);
    const loop = thrown(include('b.sch'), { 'b.sch': include('DEMO.sch') });
    expect(loop.code).toBe('INVALID_FORMAT');
    expect(loop.message).toMatch(/cycle/i);
    expect(thrown(include('b.sch'), { 'b.sch': include('b.sch') }).message).toMatch(/cycle/i);
    expect(thrown(include('demo.sch')).message).toMatch(/cycle/i);
  });

  it('allows the same file twice without calling it a cycle', () => {
    const diamond = must(sheet(`$Sheet\nS 0 0 100 100\nU AAAA0001\nF0 "X" 60\nF1 "m.sch" 60\n$EndSheet\n$Sheet\nS 0 0 100 100\nU BBBB0002\nF0 "Y" 60\nF1 "m.sch" 60\n$EndSheet`), {
      'm.sch': sheet(`$Sheet\nS 0 0 100 100\nU CCCC0003\nF0 "Z" 60\nF1 "leaf.sch" 60\n$EndSheet`), 'leaf.sch': sheet(''),
    });
    expect(diamond.instances.map(i => i.path)).toEqual(['', '/AAAA0001', '/AAAA0001/CCCC0003', '/BBBB0002', '/BBBB0002/CCCC0003']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------------------------

describe('symbol ids', () => {
  it('uses the timestamp when unique and sym<index> when duplicated or absent, without collisions', () => {
    const noStamp = comp({ lib: 'Device:R', ref: 'R3', ts: 'X', x: 2000, y: 0 }).replace('U 1 1 X', 'U 1 1');
    const result = must(sheet([
      comp({ lib: 'Device:R', ref: 'R1', ts: '5F000001', x: 0, y: 0 }),
      comp({ lib: 'Device:R', ref: 'R2', ts: '5F000001', x: 1000, y: 0 }),
      noStamp,
      comp({ lib: 'Device:R', ref: 'R4', ts: 'sym0', x: 3000, y: 0 }),
      comp({ lib: 'Device:R', ref: 'R5', ts: '5F000005', x: 4000, y: 0 }),
    ].join('\n')), withCache());
    const ids = root(result).symbols.map(s => s.id);
    expect(ids).toEqual(['sym0_', 'sym1', 'sym2', 'sym0', '5F000005']);
    expect(new Set(ids).size).toBe(ids.length);
    const pinIds = root(result).symbols.flatMap(s => s.pins.map(p => p.id));
    expect(new Set(pinIds).size).toBe(pinIds.length);
    expect(diag(result, 'DUPLICATE_TIMESTAMP')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------------------------------------------

describe('malformed input', () => {
  const full = sheet(comp({ lib: 'Device:R', ref: 'R1', x: 4000, y: 3000 }) + '\nWire Wire Line\n\t1000 1000 2000 1000');

  it('rejects a file that is cut off anywhere', () => {
    expect(thrown('EESchema Schematic File Version 4\n').message).toMatch(/\$EndSCHEMATC/);
    expect(thrown(full.slice(0, full.indexOf('$EndSCHEMATC')), withCache()).message).toMatch(/\$EndSCHEMATC/);
    expect(thrown(full.slice(0, full.indexOf('F 1 ')), withCache()).message).toMatch(/\$Comp/);
    expect(thrown(full.slice(0, full.indexOf('1000 1000 2000')), withCache()).code).toBe('INVALID_FORMAT');
    expect(thrown(full.replace('$EndComp', '$Comp'), withCache()).code).toBe('INVALID_FORMAT');
  });

  it('rejects binary garbage after the header', () => {
    const bytes = new Uint8Array(400);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 73 + 11) & 0xff;
    const garbage = new Uint8Array([...enc('EESchema Schematic File Version 4\n'), ...bytes]);
    expect(() => parseKicadLegacySch({ name: 'demo.sch', data: garbage })).toThrow(SchematicError);
  });

  it('rejects text garbage and incomplete component records', () => {
    expect(thrown('EESchema Schematic File Version 4\nthis is not a schematic\nat all\n').code).toBe('INVALID_FORMAT');
    const noLine = (needle: string) => thrown(full.split('\n').filter(line => !line.startsWith(needle)).join('\n'), withCache());
    expect(noLine('L ').message).toMatch(/L record|reference/i);
    expect(noLine('U ').message).toMatch(/U record|unit/i);
    expect(noLine('P ').message).toMatch(/P record|position/i);
    expect(thrown(full.replace('P 4000 3000', 'P 4000'), withCache()).code).toBe('INVALID_FORMAT');
    expect(thrown(full.replace('F 1 "Device:R"', 'F 1 "Device:R'), withCache()).code).toBe('INVALID_FORMAT');
    expect(thrown(full.replace('U 1 1', 'U x 1'), withCache()).code).toBe('INVALID_FORMAT');
  });

  it('throws SchematicError values that carry the format', () => {
    const error = thrown('EESchema Schematic File Version 4\n');
    expect(error).toBeInstanceOf(SchematicError);
    expect(error.format).toBe('kicad-legacy-sch');
  });
});

describe('robustness', () => {
  it('turns every cut or corrupted input into a result or a SchematicError, never another exception', () => {
    let seed = 20240607;
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const mutate = (text: string, n: number) => {
      let out = n % 3 === 0 ? text.slice(0, Math.floor(random() * text.length)) : text;
      for (let k = 0; k < n % 6; k++) {
        const at = Math.floor(random() * out.length);
        out = out.slice(0, at) + String.fromCharCode(32 + Math.floor(random() * 95)) + out.slice(at + 1);
      }
      return out;
    };
    let accepted = 0;
    let rejected = 0;
    for (let n = 0; n < 600; n++) {
      const target = n % 3;
      const companions = { 'demo-cache.lib': target === 2 ? mutate(CACHE, n) : CACHE, 'child.sch': target === 1 ? mutate(childHier, n) : childHier, 'grand.sch': grandHier };
      try { parse(target === 0 ? mutate(rootHier, n) : rootHier, companions); accepted++; } catch (error) { expect(error).toBeInstanceOf(SchematicError); rejected++; }
    }
    expect(accepted).toBeGreaterThan(50);
    expect(rejected).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------------------------

describe('limits', () => {
  const ref = (n: number, file: string, id = `S${String(n).padStart(7, '0')}`) => `$Sheet\nS 0 0 100 100\nU ${id}\nF0 "N${n}" 60\nF1 "${file}" 60\n$EndSheet`;

  it('bounds the number of sheet instances', () => {
    const many = (count: number, file: string) => Array.from({ length: count }, (_, n) => ref(n, file)).join('\n');
    const error = thrown(sheet(many(70, 'mid.sch')), { 'mid.sch': sheet(many(70, 'leaf.sch')), 'leaf.sch': sheet('') });
    expect(error.code).toBe('LIMIT_EXCEEDED');
    expect(error.message).toContain(String(SCHEMATIC_LIMITS.maxInstances));
  });

  it('bounds the nesting depth', () => {
    const chain: Record<string, string> = {};
    for (let n = 1; n <= 70; n++) chain[`c${n}.sch`] = sheet(n < 70 ? ref(n, `c${n + 1}.sch`) : '');
    expect(thrown(sheet(ref(0, 'c1.sch')), chain).code).toBe('LIMIT_EXCEEDED');
    const ok: Record<string, string> = {};
    for (let n = 1; n <= SCHEMATIC_LIMITS.maxNestingDepth; n++) ok[`c${n}.sch`] = sheet(n < SCHEMATIC_LIMITS.maxNestingDepth ? ref(n, `c${n + 1}.sch`) : '');
    expect(must(sheet(ref(0, 'c1.sch')), ok).instances).toHaveLength(SCHEMATIC_LIMITS.maxNestingDepth + 1);
  });

  it('bounds the number of distinct sheet definitions', () => {
    const flat: Record<string, string> = {};
    const blocks: string[] = [];
    for (let n = 0; n <= SCHEMATIC_LIMITS.maxSheetDefs; n++) { flat[`s${n}.sch`] = sheet(''); blocks.push(ref(n, `s${n}.sch`)); }
    expect(thrown(sheet(blocks.join('\n')), flat).code).toBe('LIMIT_EXCEEDED');
  });

  it('bounds the pins of the expanded hierarchy', () => {
    const pins = Array.from({ length: 1000 }, (_, n) => `X P${n} ${n + 1} 0 0 10 R 50 50 1 1 P`).join('\n');
    const big = lib(`DEF BIG U 0 0 Y Y 1 F N\nDRAW\n${pins}\nENDDRAW\nENDDEF`);
    const blocks = Array.from({ length: 2001 }, (_, n) => ref(n, 'leaf.sch')).join('\n');
    const error = thrown(sheet(blocks), { 'demo-cache.lib': big, 'leaf.sch': sheet(comp({ lib: 'BIG', ref: 'U1', x: 0, y: 0 })) });
    expect(error.code).toBe('LIMIT_EXCEEDED');
    expect(error.message).toMatch(/pins/);
  });

  it('bounds symbols and wires per sheet', () => {
    expect(thrown(sheet('$Comp\nL X U1\nU 1 1 00000001\nP 0 0\n\t1 0 0\n\t1 0 0 -1\n$EndComp\n'.repeat(SCHEMATIC_LIMITS.maxSymbolsPerDef + 1))).code).toBe('LIMIT_EXCEEDED');
    expect(thrown(sheet('Wire Wire Line\n1 1 2 2\n'.repeat(SCHEMATIC_LIMITS.maxWiresPerDef + 1))).code).toBe('LIMIT_EXCEEDED');
  });

  it('bounds coordinates', () => {
    expect(thrown(sheet('Wire Wire Line\n\t0 0 50000000 0')).code).toBe('LIMIT_EXCEEDED');
    expect(thrown(sheet('NoConn ~ 1e9 5')).code).toBe('INVALID_FORMAT');
  });
});

// Real-file finding W-open-sch-01 (S1 KiCad 9 demo, new-format sibling of this bug): KiCad's own power library flags PWR_FLAG as a
// power symbol ("P") whose only pin is a power OUTPUT. It must not name a net, or every rail that carries a flag is merged.
describe('power flags written with the P flag (W-open-sch-01)', () => {
  const FLAG_P_DEF = `DEF PWR_FLAG #FLG 0 0 N N 1 F P
F0 "#FLG" 0 75 50 H I C CNN
F1 "PWR_FLAG" 0 150 50 H V C CNN
DRAW
X pwr 1 0 0 0 R 50 50 1 1 w
ENDDRAW
ENDDEF`;
  it('keeps a P-flagged power flag virtual and net-less, and leaves real power symbols alone', () => {
    const result = must(sheet([
      comp({ lib: 'PWR_FLAG', ref: '#FLG01', ts: '00000C01', x: 1000, y: 1000, value: 'PWR_FLAG' }),
      comp({ lib: 'power_+5V', ref: '#PWR02', ts: '00000C02', x: 2000, y: 1000, value: '+5V' }),
    ].join('\n')), { 'flag-cache.lib': lib(FLAG_P_DEF, PWR_5V_DEF) });
    const flag = sym(result, '#FLG01');
    expect(flag.virtual).toBe(true);
    expect(flag.power).toBeUndefined();
    expect(flag.pins[0].type).toBe('power_out');
    expect(sym(result, '#PWR02').power).toEqual({ net: '+5V' });
  });
});
