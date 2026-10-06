/**
 * Dev harness of SchematicViewer: ORIGINAL SYNTHETIC designs written here by hand (no parser, no connectivity engine),
 * a shell-like controlled host, and a `window.__harness` API that scripts/qa-schematic-viewer.cjs drives.
 */
import React, { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '../src/styles.css';
import SchematicViewer from '../src/components/SchematicViewer';
import type { SchematicSelection, ViewerCamera } from '../src/components/viewer-contracts';
import { pinKey, symbolKey, symbolRef, wireKey } from '../src/lib/schematic/model';
import type {
  SchConnectivity, SchGraphic, SchLabel, SchNet, SchPin, SchPinType, SchPoint, SchSheetDef, SchSheetInstance, SchSheetRef, SchSymbol, SchWire, SchematicDesign,
} from '../src/lib/schematic/model';

// ---------------------------------------------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------------------------------------------

const P = (x: number, y: number): SchPoint => ({ x, y });
const round = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
/** Local symbol coordinates -> sheet: rotate counter-clockwise on screen (Y down), then translate. */
function place(at: SchPoint, rotation: number, lx: number, ly: number): SchPoint {
  const a = rotation * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return P(round(at.x + lx * c + ly * s), round(at.y - lx * s + ly * c));
}

interface PinSpec { number: string; name?: string; type?: SchPinType; at: [number, number]; body: [number, number]; hidden?: boolean; implicitNet?: string }
interface SymbolSpec {
  id: string; libId: string; refs: Record<string, string>; value: string; at: SchPoint; rotation?: number;
  pins: PinSpec[]; graphics: (p: (lx: number, ly: number) => SchPoint) => SchGraphic[];
  fields?: Array<{ name: string; value: string; at: [number, number]; hidden?: boolean }>;
  power?: string; dnp?: boolean; refDefault?: string;
}
function makeSymbol(spec: SymbolSpec): SchSymbol {
  const rotation = spec.rotation ?? 0;
  const p = (lx: number, ly: number) => place(spec.at, rotation, lx, ly);
  const pins: SchPin[] = spec.pins.map(pin => ({
    id: `${spec.id}#${pin.number}`, number: pin.number, name: pin.name ?? '', at: p(...pin.at), body: p(...pin.body), type: pin.type ?? 'passive',
    hidden: !!pin.hidden, unit: 1, ...(pin.implicitNet ? { implicitNet: pin.implicitNet } : {}),
  }));
  return {
    id: spec.id, libId: spec.libId, refDefault: spec.refDefault ?? 'R?', instances: Object.fromEntries(Object.entries(spec.refs).map(([path, ref]) => [path, { ref, unit: 1 }])),
    value: spec.value, footprint: '', datasheet: '', unit: 1, unitCount: 1, at: spec.at, rotation, mirror: 'none', pins,
    graphics: spec.graphics(p),
    fields: (spec.fields ?? []).map(f => ({ name: f.name, value: f.value, at: p(...f.at), angle: 0, hidden: !!f.hidden })),
    power: spec.power ? { net: spec.power } : undefined, virtual: !!spec.power, dnp: !!spec.dnp,
    // Deliberately loose, like some real parsers: the viewer must select by real geometry.
    bounds: { minX: spec.at.x - 9, minY: spec.at.y - 9, maxX: spec.at.x + 9, maxY: spec.at.y + 9 },
  };
}
const rectG = (p: (x: number, y: number) => SchPoint, x0: number, y0: number, x1: number, y1: number, fill: 'none' | 'outline' | 'background' = 'background'): SchGraphic => {
  const a = p(x0, y0), b = p(x1, y1);
  return { kind: 'rect', min: P(Math.min(a.x, b.x), Math.min(a.y, b.y)), max: P(Math.max(a.x, b.x), Math.max(a.y, b.y)), width: 0.254, fill };
};
const polyG = (p: (x: number, y: number) => SchPoint, pts: Array<[number, number]>, filled = false, width = 0.254): SchGraphic => ({ kind: 'poly', points: pts.map(([x, y]) => p(x, y)), width, filled });
const textW = (s: string) => s.length * 1.27 * 0.6;

const RES_PINS: PinSpec[] = [{ number: '1', at: [0, -3.81], body: [0, -2.54] }, { number: '2', at: [0, 3.81], body: [0, 2.54] }];
const resistor = (id: string, refs: Record<string, string>, at: SchPoint, rotation = 0, value = '10k', extra: Partial<SymbolSpec> = {}) => makeSymbol({
  id, libId: 'Device:R', refs, value, at, rotation, pins: RES_PINS, graphics: p => [rectG(p, -1.016, -2.54, 1.016, 2.54)],
  fields: [{ name: 'Reference', value: refs[''] ?? Object.values(refs)[0], at: [2.2, -1] }, { name: 'Value', value, at: [2.2, 1.2] }], ...extra,
});
const capacitor = (id: string, refs: Record<string, string>, at: SchPoint, rotation = 0, value = '100n') => makeSymbol({
  id, libId: 'Device:C', refs, value, at, rotation, refDefault: 'C?', pins: [{ number: '1', at: [0, -3.81], body: [0, -0.6] }, { number: '2', at: [0, 3.81], body: [0, 0.6] }],
  graphics: p => [polyG(p, [[-1.9, -0.6], [1.9, -0.6]], false, 0.4), polyG(p, [[-1.9, 0.6], [1.9, 0.6]], false, 0.4)],
  fields: [{ name: 'Reference', value: refs[''] ?? Object.values(refs)[0], at: [2.6, -1] }, { name: 'Value', value, at: [2.6, 1.2] }],
});
const diode = (id: string, refs: Record<string, string>, at: SchPoint, rotation = 0) => makeSymbol({
  id, libId: 'Device:D', refs, value: '1N4148', at, rotation, refDefault: 'D?',
  pins: [{ number: '1', name: 'A', at: [0, -3.81], body: [0, -1.27] }, { number: '2', name: 'K', at: [0, 3.81], body: [0, 1.27] }],
  graphics: p => [polyG(p, [[-1.27, -1.27], [1.27, -1.27], [0, 1.27]], true), polyG(p, [[-1.27, 1.27], [1.27, 1.27]])],
  fields: [{ name: 'Reference', value: refs[''] ?? Object.values(refs)[0], at: [2.2, -1] }, { name: 'Value', value: '1N4148', at: [2.2, 1.2] }],
});
const power = (id: string, net: string, at: SchPoint, up: boolean) => makeSymbol({
  id, libId: `power:${net}`, refs: { '': '#PWR' }, value: net, at, refDefault: '#PWR', power: net,
  // The single pin is invisible and implicitly tied to the global net named like the symbol (KiCad convention).
  pins: [{ number: '1', name: net, type: 'power_in', at: [0, 0], body: [0, 0], hidden: true, implicitNet: net }],
  graphics: p => (up
    ? [polyG(p, [[0, 0], [0, -1.6]]), polyG(p, [[-1.1, -1.6], [1.1, -1.6], [0, -3]], true)]
    : [polyG(p, [[0, 0], [0, 1.4]]), polyG(p, [[-1.6, 1.4], [1.6, 1.4]]), polyG(p, [[-1, 2.2], [1, 2.2]]), polyG(p, [[-0.4, 3], [0.4, 3]])]),
  fields: [{ name: 'Value', value: net, at: [-textW(net) / 2, up ? -4.4 : 4.9] }],
});
const ic = (id: string, refs: Record<string, string>, at: SchPoint, value: string, left: Array<[string, string, PinSpec['type']?]>, right: Array<[string, string, PinSpec['type']?]>, extra: PinSpec[] = []) => {
  const pitch = 5.08, half = Math.max(left.length, right.length) / 2 * pitch;
  const pins: PinSpec[] = [
    ...left.map(([number, name, type], i) => ({ number, name, type, at: [-13.81, -half + pitch / 2 + i * pitch] as [number, number], body: [-10, -half + pitch / 2 + i * pitch] as [number, number] })),
    ...right.map(([number, name, type], i) => ({ number, name, type, at: [13.81, -half + pitch / 2 + i * pitch] as [number, number], body: [10, -half + pitch / 2 + i * pitch] as [number, number] })),
    ...extra,
  ];
  return makeSymbol({
    id, libId: 'Regulator:TPS-ish', refs, value, at, refDefault: 'U?', pins, graphics: p => [rectG(p, -10, -half, 10, half)],
    fields: [{ name: 'Reference', value: refs[''] ?? Object.values(refs)[0], at: [-10, -half - 1.6] }, { name: 'Value', value, at: [-10, half + 1.8] }],
  });
};
const opamp = (id: string, refs: Record<string, string>, at: SchPoint) => makeSymbol({
  id, libId: 'Amplifier:Op', refs, value: 'OPA-ish', at, refDefault: 'U?',
  pins: [{ number: '3', name: '+', type: 'input', at: [-8.81, -2.54], body: [-5, -2.54] }, { number: '2', name: '-', type: 'input', at: [-8.81, 2.54], body: [-5, 2.54] }, { number: '1', name: 'OUT', type: 'output', at: [8.81, 0], body: [5, 0] }],
  // SchPolyline has no "closed but unfilled" flag, so the outline repeats its first point.
  graphics: p => [polyG(p, [[-5, -5], [-5, 5], [5, 0], [-5, -5]], false)],
  fields: [{ name: 'Reference', value: refs[''] ?? Object.values(refs)[0], at: [-4, -6.6] }, { name: 'Value', value: 'OPA-ish', at: [-4, 6.8] }],
});

let wireCounter = 0;
const wire = (def: SchSheetDef, a: SchPoint, b: SchPoint, id?: string): SchWire => {
  const w = { id: id ?? `w${++wireCounter}`, a, b };
  def.wires.push(w);
  return w;
};
const route = (def: SchSheetDef, ...pts: SchPoint[]): SchWire[] => pts.slice(1).map((pt, i) => wire(def, pts[i], pt));
const pinOf = (s: SchSymbol, number: string) => s.pins.find(p => p.number === number)!;
const emptyDef = (id: string, name: string, extra: Partial<SchSheetDef> = {}): SchSheetDef => ({
  id, name, file: `${name}.kicad_sch`, title: name, titleBlock: {}, paper: { width: 297, height: 210 }, symbols: [], wires: [], buses: [], busEntries: [], junctions: [], noConnects: [],
  labels: [], sheetRefs: [], graphics: [], bounds: { minX: 10, minY: 10, maxX: 287, maxY: 200 }, ...extra,
});
const lab = (def: SchSheetDef, kind: SchLabel['kind'], text: string, at: SchPoint, angle = 0, shape?: SchLabel['shape']) => def.labels.push({ id: `l${def.labels.length + 1}`, kind, text, at, angle, shape });
const junction = (def: SchSheetDef, at: SchPoint) => def.junctions.push({ id: `j${def.junctions.length + 1}`, at });
const sheetRef = (id: string, name: string, file: string, defId: string | null, at: SchPoint, size: SchPoint, pins: Array<[string, SchPoint, SchSheetRef['pins'][number]['shape']]>): SchSheetRef =>
  ({ id, name, file, defId, at, size, pins: pins.map(([n, pAt, shape]) => ({ id: `${id}:${n}`, name: n, at: pAt, shape })) });

class Connectivity {
  nets: SchNet[] = [];
  private readonly byId = new Map<string, SchNet>();
  pinNet: Record<string, string> = {};
  wireNet: Record<string, string> = {};
  noConnectPins: string[] = [];
  floatingPins: string[] = [];
  /**
   * Hand-declared net: the author lists exactly which pins and wires belong to it (nothing is computed from geometry).
   * Declaring an id again (a global net seen from another sheet instance) adds to the existing net.
   */
  net(spec: { id: string; name: string; auto?: boolean; scope: SchNet['scope']; scopePath?: string; aliases?: string[]; path: string; def: SchSheetDef; pins?: Array<[SchSymbol, string]>; wires?: SchWire[] }) {
    let net = this.byId.get(spec.id);
    if (!net) {
      net = { id: spec.id, name: spec.name, auto: !!spec.auto, scope: spec.scope, scopePath: spec.scopePath, aliases: [], members: [], wires: [] };
      this.byId.set(spec.id, net); this.nets.push(net);
    }
    net.aliases = [...new Set([...net.aliases, ...(spec.aliases ?? [spec.name])])].sort();
    for (const [symbol, number] of spec.pins ?? []) {
      const pin = pinOf(symbol, number);
      this.pinNet[pinKey(spec.path, symbol.id, pin.id)] = spec.id;
      net.members.push({ instancePath: spec.path, defId: spec.def.id, symbolId: symbol.id, pinId: pin.id, ref: symbolRef(symbol, spec.path), unit: symbol.unit, pinNumber: pin.number, pinName: pin.name });
    }
    for (const w of spec.wires ?? []) { this.wireNet[wireKey(spec.path, w.id)] = spec.id; net.wires.push({ instancePath: spec.path, wireId: w.id }); }
  }
  result(): SchConnectivity {
    return { nets: this.nets, pinNet: this.pinNet, wireNet: this.wireNet, noConnectPins: this.noConnectPins, floatingPins: this.floatingPins, diagnostics: [] };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Demo design: root + Power + two instances of Channel (each with a nested Filter) + a sheet whose file is missing
// ---------------------------------------------------------------------------------------------------------------

const PATH = { power: 'sh-pwr', chA: 'sh-cha', chB: 'sh-chb', filterA: 'sh-cha/sh-flt', filterB: 'sh-chb/sh-flt' };

function buildDemo(): { design: SchematicDesign; named: Record<string, SchWire> } {
  wireCounter = 0;
  const conn = new Connectivity();

  // ----- Filter (RC low-pass), instantiated under both channels -----
  const filter = emptyDef('filter.kicad_sch', 'filter', { title: 'RC filter' });
  const filterRefs = { [PATH.filterA]: 'R12', [PATH.filterB]: 'R22' }, filterCRefs = { [PATH.filterA]: 'C12', [PATH.filterB]: 'C22' };
  const fr = resistor('f-r', filterRefs, P(80, 80), 90, '1k'), fc = capacitor('f-c', filterCRefs, P(100, 90), 0, '10n');
  const fg = power('f-gnd', 'GND', P(100, 101), false);
  filter.symbols.push(fr, fc, fg);
  const fw = [
    ...route(filter, P(50, 80), pinOf(fr, '1').at), ...route(filter, pinOf(fr, '2').at, P(100, 80)), ...route(filter, P(100, 80), P(130, 80)),
    ...route(filter, P(100, 80), pinOf(fc, '1').at), ...route(filter, pinOf(fc, '2').at, P(100, 101)),
  ];
  junction(filter, P(100, 80));
  lab(filter, 'hierarchical', 'IN', P(50, 80), 180, 'input'); lab(filter, 'hierarchical', 'OUT', P(130, 80), 0, 'output');
  for (const path of [PATH.filterA, PATH.filterB]) {
    conn.net({ id: `net:local:${path}:IN`, name: 'IN', scope: 'hierarchical', scopePath: path, path, def: filter, pins: [[fr, '1']], wires: [fw[0]] });
    conn.net({ id: `net:local:${path}:OUT`, name: 'OUT', scope: 'hierarchical', scopePath: path, path, def: filter, pins: [[fr, '2'], [fc, '1']], wires: [fw[1], fw[2], fw[3]] });
    conn.net({ id: 'net:global:GND', name: 'GND', scope: 'global', path, def: filter, pins: [[fc, '2'], [fg, '1']], wires: [fw[4]] });
  }

  // ----- Channel (op-amp stage + Filter sub-sheet), instantiated twice -----
  const channel = emptyDef('channel.kicad_sch', 'channel', { title: 'Amplifier channel' });
  const chRefs = (a: string, b: string) => ({ [PATH.chA]: a, [PATH.chB]: b });
  const rin = resistor('c-rin', chRefs('R10', 'R20'), P(90, 77.46), 90, '4.7k');
  const rf = resistor('c-rf', chRefs('R11', 'R21'), P(120, 95), 90, '47k');
  const op = opamp('c-op', chRefs('U2', 'U3'), P(120, 80));
  channel.symbols.push(rin, rf, op);
  const cw = [
    ...route(channel, P(60, 77.46), pinOf(rin, '1').at), ...route(channel, pinOf(rin, '2').at, pinOf(op, '3').at),
    ...route(channel, pinOf(op, '1').at, P(135, 80)), ...route(channel, P(135, 80), P(150, 80)),
    ...route(channel, P(135, 80), P(135, 95), pinOf(rf, '2').at),
    ...route(channel, pinOf(rf, '1').at, P(105, 95), P(105, 82.54), pinOf(op, '2').at),
    ...route(channel, P(185, 80), P(200, 80)),
  ];
  junction(channel, P(135, 80));
  lab(channel, 'hierarchical', 'IN', P(60, 77.46), 180, 'input'); lab(channel, 'hierarchical', 'OUT', P(200, 80), 0, 'output');
  lab(channel, 'local', 'FB', P(105, 90), 90);
  channel.sheetRefs.push(sheetRef('sh-flt', 'Filter', 'filter.kicad_sch', 'filter.kicad_sch', P(150, 70), P(35, 20), [['IN', P(150, 80), 'input'], ['OUT', P(185, 80), 'output']]));
  channel.graphics.push({ kind: 'text', at: P(40, 30), text: 'Non-inverting stage', angle: 0, size: 2.5, anchor: 'start', bold: true });
  for (const path of [PATH.chA, PATH.chB]) {
    const refOf = (s: SchSymbol) => symbolRef(s, path);
    conn.net({ id: `net:local:${path}:IN`, name: 'IN', scope: 'hierarchical', scopePath: path, path, def: channel, pins: [[rin, '1']], wires: [cw[0]] });
    conn.net({ id: `net:auto:${path}:1`, name: `Net-(${refOf(rin)}-Pad2)`, auto: true, scope: 'local', scopePath: path, path, def: channel, pins: [[rin, '2'], [op, '3']], wires: [cw[1]] });
    conn.net({ id: `net:auto:${path}:2`, name: `Net-(${refOf(rf)}-Pad2)`, auto: true, scope: 'local', scopePath: path, path, def: channel, pins: [[op, '1'], [rf, '2']], wires: [cw[2], cw[3], cw[4], cw[5]] });
    conn.net({ id: `net:local:${path}:FB`, name: 'FB', scope: 'local', scopePath: path, path, def: channel, pins: [[rf, '1'], [op, '2']], wires: [cw[6], cw[7], cw[8]] });
    conn.net({ id: `net:local:${path}:OUT`, name: 'OUT', scope: 'hierarchical', scopePath: path, path, def: channel, wires: [cw[9]] });
  }

  // ----- Power (regulator) -----
  const pwr = emptyDef('power.kicad_sch', 'power', { title: 'Regulator' });
  const reg = ic('p-u', { [PATH.power]: 'U10' }, P(100, 80), 'LDO-3V3', [['1', 'VIN', 'power_in'], ['2', 'EN', 'input']], [['3', 'VOUT', 'power_out'], ['4', 'NC', 'no_connect']], [{ number: '5', name: 'GND', type: 'power_in', at: [0, 8.89], body: [0, 5.08] }]);
  const pgnd = power('p-gnd', 'GND', P(100, 105), false), cin = capacitor('p-cin', { [PATH.power]: 'C10' }, P(75, 90), 0, '10u');
  pwr.symbols.push(reg, pgnd, cin);
  const pw = [
    ...route(pwr, P(60, 77.46), pinOf(reg, '1').at), ...route(pwr, pinOf(reg, '3').at, P(140, 77.46)), ...route(pwr, pinOf(reg, '5').at, P(100, 105)),
    ...route(pwr, P(75, 77.46), pinOf(cin, '1').at), ...route(pwr, pinOf(cin, '2').at, P(75, 105), P(100, 105)), ...route(pwr, pinOf(reg, '2').at, P(60, 82.54), P(60, 77.46)),
  ];
  junction(pwr, P(75, 77.46)); junction(pwr, P(60, 77.46)); junction(pwr, P(100, 105));
  pwr.noConnects.push({ id: 'nc1', at: pinOf(reg, '4').at });
  lab(pwr, 'hierarchical', 'VIN', P(60, 77.46), 180, 'input'); lab(pwr, 'hierarchical', 'VOUT', P(140, 77.46), 0, 'output');
  conn.net({ id: `net:local:${PATH.power}:VIN`, name: 'VIN', scope: 'hierarchical', scopePath: PATH.power, path: PATH.power, def: pwr, pins: [[reg, '1'], [reg, '2'], [cin, '1']], wires: [pw[0], pw[3], pw[6], pw[7]] });
  conn.net({ id: `net:local:${PATH.power}:VOUT`, name: 'VOUT', scope: 'hierarchical', scopePath: PATH.power, path: PATH.power, def: pwr, pins: [[reg, '3']], wires: [pw[1]] });
  conn.net({ id: 'net:global:GND', name: 'GND', scope: 'global', path: PATH.power, def: pwr, pins: [[reg, '5'], [pgnd, '1'], [cin, '2']], wires: [pw[2], pw[4], pw[5]] });
  conn.noConnectPins.push(pinKey(PATH.power, reg.id, pinOf(reg, '4').id));

  // ----- Root -----
  const root = emptyDef('main.kicad_sch', 'main', { title: 'TRACE demo board', titleBlock: { company: 'Synthetic fixtures', rev: 'A', date: '2026-10-05' } });
  const refsR = (ref: string) => ({ '': ref });
  const pwr1 = power('pwr1', '+3V3', P(60, 34), true), r1 = resistor('r1', refsR('R1'), P(60, 50), 0, '10k');
  const r2 = resistor('r2', refsR('R2'), P(60, 88), 0, '4.7k'), c1 = capacitor('c1', refsR('C1'), P(80, 88), 0, '100n');
  const gnd1 = power('gnd1', 'GND', P(60, 106), false), pwr2 = power('pwr2', '+3V3', P(130, 52), true), gnd2 = power('gnd2', 'GND', P(135, 95), false);
  const u1 = ic('u1', refsR('U1'), P(160, 70.54), 'TPS-ish', [['1', 'VIN', 'power_in'], ['2', 'EN', 'input'], ['3', 'SS', 'passive'], ['4', 'GND', 'power_in']], [['8', 'SW', 'output'], ['7', 'BST', 'passive'], ['6', 'FB', 'input'], ['5', 'PG', 'open_collector']],
    [{ number: '9', name: 'GND', type: 'power_in', at: [0, 0], body: [0, 0], hidden: true, implicitNet: 'GND' }]);
  const r3 = resistor('r3', refsR('R3'), P(40, 165), 90, '220'), d1 = diode('d1', refsR('D1'), P(62, 165), 90);
  const c2 = capacitor('c2', refsR('C2'), P(84, 165), 270, '1u'), r4 = resistor('r4', refsR('R4'), P(100, 150), 180, '1M');
  const r5 = resistor('r5', refsR('R5'), P(130, 165), 0, '0R', { dnp: true });
  root.symbols.push(pwr1, r1, r2, c1, gnd1, pwr2, gnd2, u1, r3, d1, c2, r4, r5);
  const w = {
    pwr1: wire(root, pinOf(pwr1, '1').at, pinOf(r1, '1').at), r1r2a: wire(root, pinOf(r1, '2').at, P(60, 68)), r1r2b: wire(root, P(60, 68), pinOf(r2, '1').at),
    gnd: wire(root, pinOf(r2, '2').at, P(60, 106)), n1: wire(root, P(60, 68), P(80, 68)), n2: wire(root, P(80, 68), pinOf(c1, '1').at), cg: wire(root, pinOf(c1, '2').at, P(80, 106)),
    rail: wire(root, P(80, 106), P(60, 106)), out: wire(root, P(80, 68), P(100, 68)), toU: wire(root, P(100, 68), pinOf(u1, '2').at),
    p2a: wire(root, pinOf(pwr2, '1').at, P(130, pinOf(u1, '1').at.y)), p2b: wire(root, P(130, pinOf(u1, '1').at.y), pinOf(u1, '1').at),
    g4a: wire(root, pinOf(u1, '4').at, P(135, pinOf(u1, '4').at.y)), g4b: wire(root, P(135, pinOf(u1, '4').at.y), pinOf(gnd2, '1').at),
    swA: wire(root, pinOf(u1, '8').at, P(190, pinOf(u1, '8').at.y)), swB: wire(root, P(190, pinOf(u1, '8').at.y), P(190, 38)), swC: wire(root, P(190, 38), P(205, 38)),
    fbA: wire(root, pinOf(u1, '6').at, P(185, pinOf(u1, '6').at.y)), fbB: wire(root, P(185, pinOf(u1, '6').at.y), P(185, 76)), fbC: wire(root, P(185, 76), P(205, 76)),
    bst: wire(root, pinOf(u1, '7').at, P(180, pinOf(u1, '7').at.y)),
    pout: wire(root, P(250, 114), P(270, 114)),
    chain1: wire(root, pinOf(r3, '2').at, pinOf(d1, '1').at), chain2: wire(root, pinOf(d1, '2').at, pinOf(c2, '2').at), chain3: wire(root, pinOf(c2, '1').at, P(100, 165)), chain4: wire(root, P(100, 165), pinOf(r4, '1').at),
    tail: wire(root, pinOf(r4, '2').at, P(100, 140)),
  };
  junction(root, P(60, 68)); junction(root, P(80, 68)); junction(root, P(60, 106));
  root.noConnects.push({ id: 'nc-pg', at: pinOf(u1, '5').at });
  lab(root, 'local', 'VSENSE', P(70, 68), 0); lab(root, 'global', 'VSENSE_OUT', P(100, 68), 0, 'output');
  lab(root, 'local', 'BST', P(180, pinOf(u1, '7').at.y), 0); lab(root, 'local', 'TAIL', P(100, 140), 90);
  lab(root, 'global', '+3V3', P(270, 114), 0, 'output');
  // Bus with four members and entries (the entries are NOT conductors between members).
  root.buses.push({ id: 'bus1', a: P(30, 132), b: P(90, 132) });
  const dnets: Array<[SchWire, string]> = [];
  for (let i = 0; i < 4; i++) {
    const x = 40 + i * 12;
    root.busEntries.push({ id: `be${i}`, at: P(x, 132), to: P(x + 2.54, 129.46) });
    dnets.push([wire(root, P(x + 2.54, 129.46), P(x + 2.54, 120)), `D${i}`]);
    lab(root, 'local', `D${i}`, P(x + 2.54, 120), 90);
  }
  lab(root, 'local', 'D[0..3]', P(30, 132), 180);
  root.graphics.push(
    { kind: 'text', at: P(45, 25), text: 'Voltage divider', angle: 0, size: 2.2, anchor: 'start', bold: true },
    { kind: 'rect', min: P(40, 22), max: P(112, 114), width: 0.15, fill: 'none' },
    { kind: 'text', at: P(30, 140), text: 'D0..D3: data lines (bus demo)', angle: 0, size: 1.27, anchor: 'start', italic: true },
    { kind: 'poly', points: [P(25, 185), P(60, 185), P(60, 195)], width: 0.15, filled: false },
  );
  root.sheetRefs.push(
    sheetRef(PATH.chA, 'Channel A', 'channel.kicad_sch', 'channel.kicad_sch', P(205, 28), P(45, 22), [['IN', P(205, 38), 'input'], ['OUT', P(250, 38), 'output']]),
    sheetRef(PATH.chB, 'Channel B', 'channel.kicad_sch', 'channel.kicad_sch', P(205, 66), P(45, 22), [['IN', P(205, 76), 'input'], ['OUT', P(250, 76), 'output']]),
    sheetRef(PATH.power, 'Power', 'power.kicad_sch', 'power.kicad_sch', P(205, 104), P(45, 22), [['VIN', P(205, 114), 'input'], ['VOUT', P(250, 114), 'output']]),
    sheetRef('sh-miss', 'Legacy IO', 'legacy_io.kicad_sch', null, P(205, 142), P(45, 18), [['IO', P(205, 151), 'bidirectional']]),
  );
  const rootNet = (spec: Omit<Parameters<Connectivity['net']>[0], 'path' | 'def'>) => conn.net({ ...spec, path: '', def: root });
  rootNet({ id: 'net:global:+3V3', name: '+3V3', scope: 'global', pins: [[pwr1, '1'], [r1, '1'], [pwr2, '1'], [u1, '1']], wires: [w.pwr1, w.p2a, w.p2b, w.pout] });
  rootNet({ id: 'net:global:VSENSE_OUT', name: 'VSENSE_OUT', scope: 'global', aliases: ['VSENSE', 'VSENSE_OUT'], pins: [[r1, '2'], [r2, '1'], [c1, '1'], [u1, '2']], wires: [w.r1r2a, w.r1r2b, w.n1, w.n2, w.out, w.toU] });
  rootNet({ id: 'net:global:GND', name: 'GND', scope: 'global', pins: [[r2, '2'], [c1, '2'], [gnd1, '1'], [gnd2, '1'], [u1, '4'], [u1, '9']], wires: [w.gnd, w.cg, w.rail, w.g4a, w.g4b] });
  rootNet({ id: 'net:auto:1', name: 'Net-(U1-SW)', auto: true, scope: 'local', scopePath: '', pins: [[u1, '8']], wires: [w.swA, w.swB, w.swC] });
  rootNet({ id: 'net:auto:2', name: 'Net-(U1-FB)', auto: true, scope: 'local', scopePath: '', pins: [[u1, '6']], wires: [w.fbA, w.fbB, w.fbC] });
  rootNet({ id: 'net:local::BST', name: 'BST', scope: 'local', scopePath: '', pins: [[u1, '7']], wires: [w.bst] });
  rootNet({ id: 'net:local::TAIL', name: 'TAIL', scope: 'local', scopePath: '', pins: [[r4, '2']], wires: [w.tail] });
  rootNet({ id: 'net:auto:3', name: 'Net-(D1-A)', auto: true, scope: 'local', scopePath: '', pins: [[r3, '2'], [d1, '1']], wires: [w.chain1] });
  rootNet({ id: 'net:auto:4', name: 'Net-(C2-Pad2)', auto: true, scope: 'local', scopePath: '', pins: [[d1, '2'], [c2, '2']], wires: [w.chain2] });
  rootNet({ id: 'net:auto:5', name: 'Net-(C2-Pad1)', auto: true, scope: 'local', scopePath: '', pins: [[c2, '1'], [r4, '1']], wires: [w.chain3, w.chain4] });
  for (const [wr, name] of dnets) rootNet({ id: `net:local::${name}`, name, scope: 'local', scopePath: '', wires: [wr] });
  conn.noConnectPins.push(pinKey('', u1.id, pinOf(u1, '5').id));
  for (const [s, n] of [[r3, '1'], [r5, '1'], [r5, '2']] as const) conn.floatingPins.push(pinKey('', s.id, pinOf(s, n).id));

  const inst = (path: string, defId: string, name: string, page: string, parentPath: string | null, sheetRefId: string | null, depth: number, childPaths: string[]): SchSheetInstance =>
    ({ path, defId, name, page, parentPath, sheetRefId, childPaths, depth });
  const instances: SchSheetInstance[] = [
    inst('', root.id, 'main', '1', null, null, 0, [PATH.power, PATH.chA, PATH.chB]),
    inst(PATH.power, pwr.id, 'Power', '2', '', PATH.power, 1, []),
    inst(PATH.chA, channel.id, 'Channel A', '3', '', PATH.chA, 1, [PATH.filterA]),
    inst(PATH.filterA, filter.id, 'Filter', '4', PATH.chA, 'sh-flt', 2, []),
    inst(PATH.chB, channel.id, 'Channel B', '5', '', PATH.chB, 1, [PATH.filterB]),
    inst(PATH.filterB, filter.id, 'Filter', '6', PATH.chB, 'sh-flt', 2, []),
  ];
  const design: SchematicDesign = {
    schematic: {
      format: 'kicad-sch', formatLabel: 'Synthetic demo (harness)', sourceUnit: 'mm', name: 'demo', defs: [root, pwr, channel, filter], rootDefId: root.id, instances,
      diagnostics: [{ severity: 'warning', code: 'SHEET_FILE_MISSING', message: 'legacy_io.kicad_sch was not provided', defId: root.id, instancePath: '' }],
    },
    connectivity: conn.result(),
  };
  return { design, named: w };
}

// ---------------------------------------------------------------------------------------------------------------
// Stress design: one A0 sheet with 5,000 symbols, ~5,000 wires, labels and 100 nets
// ---------------------------------------------------------------------------------------------------------------

function buildStress(): SchematicDesign {
  wireCounter = 0;
  const cols = 100, rows = 50, conn = new Connectivity();
  const def = emptyDef('stress.kicad_sch', 'stress', { title: 'Stress sheet', paper: { width: 1189, height: 841 }, bounds: { minX: 0, minY: 0, maxX: 1189, maxY: 841 } });
  const grid: SchSymbol[][] = [];
  for (let c = 0; c < cols; c++) {
    grid.push([]);
    for (let r = 0; r < rows; r++) {
      const s = resistor(`s${c}_${r}`, { '': `R${c * rows + r + 1}` }, P(40 + c * 11, 50 + r * 15), 0, r % 2 ? '10k' : '4.7k');
      grid[c].push(s); def.symbols.push(s);
    }
  }
  for (let c = 0; c < cols; c++) {
    const x = 40 + c * 11;
    const top = wire(def, P(x, 30), pinOf(grid[c][0], '1').at);
    lab(def, 'local', `COL${c}`, P(x, 30), 90);
    conn.net({ id: `net:local::COL${c}`, name: `COL${c}`, scope: 'local', scopePath: '', path: '', def, pins: [[grid[c][0], '1']], wires: [top] });
    for (let r = 0; r < rows - 1; r++) {
      const link = wire(def, pinOf(grid[c][r], '2').at, pinOf(grid[c][r + 1], '1').at);
      conn.net({ id: `net:auto:${c * rows + r}`, name: `Net-(R${c * rows + r + 1}-Pad2)`, auto: true, scope: 'local', scopePath: '', path: '', def, pins: [[grid[c][r], '2'], [grid[c][r + 1], '1']], wires: [link] });
    }
    if (c % 10 === 0) def.noConnects.push({ id: `nc${c}`, at: pinOf(grid[c][rows - 1], '2').at });
  }
  // A few board-wide rails: long wires exercise the "oversized element" path of the culling grid.
  for (let r = 0; r < rows; r += 10) wire(def, P(20, 50 + r * 15 - 6), P(1130, 50 + r * 15 - 6));
  def.graphics.push({ kind: 'text', at: P(40, 18), text: 'Stress sheet: 5000 symbols', angle: 0, size: 5, anchor: 'start', bold: true });
  return {
    schematic: {
      format: 'kicad-sch', formatLabel: 'Synthetic stress (harness)', sourceUnit: 'mm', name: 'stress', defs: [def], rootDefId: def.id, diagnostics: [],
      instances: [{ path: '', defId: def.id, name: 'stress', page: '1', parentPath: null, sheetRefId: null, childPaths: [], depth: 0 }],
    },
    connectivity: conn.result(),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Shell-like host
// ---------------------------------------------------------------------------------------------------------------

interface LogEntry { n: number; type: string; detail: unknown }
interface HarnessApi {
  log: LogEntry[];
  counters: { commits: number; cameraEvents: number };
  state(): { design: string; instancePath: string; selection: SchematicSelection; camera: ViewerCamera; theme: string; compact: boolean };
  setTheme(t: 'dark' | 'light'): void; setCompact(v: boolean): void; setMotion(v: boolean): void; setDesign(d: 'demo' | 'stress'): void;
  setInstance(p: string): void; setCamera(c: ViewerCamera): void; setSelection(s: SchematicSelection): void; setWidth(px: number | null): void;
  setHighlights(on: boolean): void; setVisible(v: boolean): void;
  geometry: {
    pin(instancePath: string, symbolId: string, number: string): { x: number; y: number; bx: number; by: number } | null;
    symbol(instancePath: string, symbolId: string): { x: number; y: number } | null;
    wire(instancePath: string, wireId: string): { ax: number; ay: number; bx: number; by: number } | null;
    sheet(instancePath: string, refId: string): { x: number; y: number; w: number; h: number } | null;
    /** Root-sheet wire of the demo design by its fixture name (r1r2a, n1, out, ...). */
    named(name: string): { id: string; ax: number; ay: number; bx: number; by: number } | null;
    keys: { symbolKey: typeof symbolKey; pinKey: typeof pinKey; wireKey: typeof wireKey };
  };
}
declare global { interface Window { __harness: HarnessApi } }

function Harness() {
  const demo = useMemo(buildDemo, []);
  const stress = useMemo(buildStress, []);
  const [which, setWhich] = useState<'demo' | 'stress'>('demo');
  const [instancePath, setInstancePath] = useState('');
  const [selection, setSelection] = useState<SchematicSelection>({});
  const [camera, setCamera] = useState<ViewerCamera>({ fit: 'page' });
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [compact, setCompact] = useState(false);
  const [motion, setMotion] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const [highlightsOn, setHighlightsOn] = useState(false);
  const [visible, setVisible] = useState(true);
  const [tail, setTail] = useState<string[]>([]);
  const log = useRef<LogEntry[]>([]);
  const counters = useRef({ commits: 0, cameraEvents: 0 });
  const design = which === 'demo' ? demo.design : stress;

  const record = useCallback((type: string, detail: unknown) => {
    const entry = { n: log.current.length + 1, type, detail };
    log.current.push(entry);
    setTail(previous => [...previous.slice(-5), `${entry.n} ${type} ${JSON.stringify(detail)}`]);
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { document.documentElement.dataset.motion = motion ? 'on' : 'off'; }, [motion]);

  const highlights = useMemo(() => highlightsOn && which === 'demo' ? [
    { id: 'h1', kind: 'search' as const, instancePath: '', rect: { x: 52, y: 44, width: 16, height: 12 }, label: 'R1', active: true },
    { id: 'h2', kind: 'probe' as const, instancePath: '', rect: { x: 148, y: 56, width: 24, height: 30 } },
    { id: 'h3', kind: 'selection' as const, instancePath: PATH.chA, rect: { x: 108, y: 70, width: 26, height: 20 } },
  ] : [], [highlightsOn, which]);

  const apiRef = useRef<HarnessApi | null>(null);
  apiRef.current = {
    log: log.current, counters: counters.current,
    state: () => ({ design: which, instancePath, selection, camera, theme, compact }),
    setTheme, setCompact, setMotion, setDesign: d => { setWhich(d); setInstancePath(''); setSelection({}); setCamera({ fit: 'page' }); }, setInstance: setInstancePath, setCamera, setSelection, setWidth,
    setHighlights: setHighlightsOn, setVisible,
    geometry: {
      pin: (path, symbolId, number) => {
        const def = design.schematic.defs.find(d => d.symbols.some(s => s.id === symbolId)); const pin = def?.symbols.find(s => s.id === symbolId)?.pins.find(p => p.number === number);
        void path; return pin ? { x: pin.at.x, y: pin.at.y, bx: pin.body.x, by: pin.body.y } : null;
      },
      symbol: (path, symbolId) => {
        const s = design.schematic.defs.flatMap(d => d.symbols).find(item => item.id === symbolId); void path;
        return s ? { x: s.at.x, y: s.at.y } : null;
      },
      wire: (path, wireId) => {
        const wr = design.schematic.defs.flatMap(d => d.wires).find(item => item.id === wireId); void path;
        return wr ? { ax: wr.a.x, ay: wr.a.y, bx: wr.b.x, by: wr.b.y } : null;
      },
      sheet: (path, refId) => {
        const r = design.schematic.defs.flatMap(d => d.sheetRefs).find(item => item.id === refId); void path;
        return r ? { x: r.at.x, y: r.at.y, w: r.size.x, h: r.size.y } : null;
      },
      named: name => { const wr = demo.named[name]; return wr ? { id: wr.id, ax: wr.a.x, ay: wr.a.y, bx: wr.b.x, by: wr.b.y } : null; },
      keys: { symbolKey, pinKey, wireKey },
    },
  };
  useEffect(() => { window.__harness = apiRef.current!; });

  return (
    <div className="h-root">
      <div className="h-bar" role="group" aria-label="Harness controls">
        <button id="h-theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>Theme: {theme}</button>
        <label><input type="checkbox" checked={compact} onChange={e => setCompact(e.target.checked)} /> compact</label>
        <label><input type="checkbox" checked={motion} onChange={e => setMotion(e.target.checked)} /> motion</label>
        <label><input type="checkbox" checked={highlightsOn} onChange={e => setHighlightsOn(e.target.checked)} /> highlights</label>
        <button id="h-design" onClick={() => { setWhich(which === 'demo' ? 'stress' : 'demo'); setInstancePath(''); setSelection({}); setCamera({ fit: 'page' }); }}>Design: {which}</button>
        <button onClick={() => setSelection({})}>Clear selection</button>
        <span className="mono muted">sel: {JSON.stringify(selection).replaceAll('\u0000', '|')} · path: "{instancePath}"</span>
      </div>
      <div className={`h-main${width ? ' h-narrow' : ''}`}>
        <div className="h-viewer" style={width ? { flexBasis: width, flexGrow: 0 } : undefined}>
          {visible && <Profiler id="schv" onRender={() => { counters.current.commits++; }}>
            <SchematicViewer
              design={design} instancePath={instancePath}
              onInstanceChange={path => { record('instance', path); setInstancePath(path); setSelection({}); }}
              camera={camera} onCameraChange={next => { counters.current.cameraEvents++; setCamera(next); }}
              theme={theme} motion={motion} compact={compact}
              selection={selection}
              onSelectSymbol={target => { record('symbol', target); setSelection({ symbolKey: symbolKey(target.instancePath, target.symbolId) }); }}
              onSelectPin={target => {
                record('pin', target);
                const key = pinKey(target.instancePath, target.symbolId, target.pinId);
                setSelection({ symbolKey: symbolKey(target.instancePath, target.symbolId), pinKey: key, netId: design.connectivity.pinNet[key] });
              }}
              onSelectNet={netId => { record('net', netId); setSelection(netId ? { netId } : {}); }}
              highlights={highlights}
            />
          </Profiler>}
        </div>
      </div>
      <div className="h-log mono" id="h-log" aria-label="Callback log">{tail.map(line => <div key={line}>{line}</div>)}</div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>);
