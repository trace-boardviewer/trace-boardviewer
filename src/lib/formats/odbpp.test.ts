import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import { expectCostAtMost, expectScaling } from '../../test-support/timing';
import { BoardFormatError } from './common';
import { listOdbppSteps, openOdbpp, openOdbppFiles, parseOdbpp, parseOdbppFiles, readOdbpp, sniffOdbpp } from './odbpp';
import {
  bytesOf, CANONICAL, compressZ, flippedPlace, MATRIX_LAYERS, pinPositions, rooted, tarEntries, tarOf, tgzOf, writeJob, zipOf,
  type FixtureComponent, type FixtureModel, type WriteOptions,
} from './odbpp-fixture';

const failure = (action: () => unknown): BoardFormatError => {
  try { action(); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
};
const tgz = (files: Record<string, string | Uint8Array>, name = 'fixture.tgz') => ({ name, data: tgzOf(files) });
const board = (files: Record<string, string | Uint8Array>, step?: string) => parseOdbpp(tgz(files), step === undefined ? {} : { step })!;
const notes = (b: Board) => b.warnings.filter(warning => warning.key === 'parse.warning.formatNote').map(warning => String(warning.params?.message));
const note = (b: Board, pattern: RegExp) => notes(b).find(message => pattern.test(message));
const part = (b: Board, ref: string) => b.components.find(component => component.ref === ref)!;
const pin = (b: Board, ref: string, number: string) => { const component = part(b, ref); return b.pins.find(p => p.componentId === component.id && p.number === number)!; };
/** Geometry and connectivity without warnings or session ids: what must not depend on the container or the units. */
function shape(b: Board, digits = 6) {
  const round = (value: number) => Number(value.toFixed(digits));
  const point = (p: { x: number; y: number }) => [round(p.x), round(p.y)];
  return {
    components: b.components.map(c => [c.ref, c.side, c.value, c.package, point(c.position), round(c.rotation), c.outline.map(point), c.pinIds.length]),
    pins: b.pins.map(p => [part(b, b.components.find(c => c.id === p.componentId)!.ref).ref, p.number, p.side, p.net, point(p), p.shape, round(p.radius), p.width === undefined ? null : round(p.width), p.height === undefined ? null : round(p.height), p.rotation === undefined ? null : round(p.rotation)]),
    nets: b.nets.map(net => [net.name, net.pinIds.length]).sort(),
    outline: b.outline.map(point),
  };
}
/** Deep equality with numbers compared within `tolerance`. */
function close(actual: unknown, expected: unknown, tolerance: number, path = ''): void {
  if (typeof expected === 'number' && typeof actual === 'number') { expect(Math.abs(actual - expected), `${path}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance); return; }
  if (Array.isArray(expected) && Array.isArray(actual)) { expect(actual.length, `${path} length`).toBe(expected.length); expected.forEach((item, index) => close(actual[index], item, tolerance, `${path}[${index}]`)); return; }
  if (expected && typeof expected === 'object' && actual && typeof actual === 'object') { for (const key of Object.keys(expected)) close((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], tolerance, `${path}.${key}`); return; }
  expect(actual, path).toEqual(expected);
}
/** The model without the special pins (paste aperture, far-side pad): what a reader without eda/data feature records can reproduce. */
function plain(model: FixtureModel): FixtureModel {
  const keep = model.packages.map(pkg => pkg.pins.map(p => p.kind !== 'paste'));
  const packages = model.packages.map(pkg => ({ ...pkg, pins: pkg.pins.filter(p => p.kind !== 'paste').map(p => ({ ...p, kind: p.kind === 'far' ? undefined : p.kind })) }));
  const strip = (component: FixtureComponent) => ({ ...component, nets: component.nets.filter((_, index) => keep[component.pkg][index] !== false) });
  return { ...model, packages, top: model.top.map(strip), bottom: model.bottom.map(strip) };
}
const toCrLf = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([path, text]) => [path, text.replace(/\n/g, '\r\n')]));
const merge = (...sets: Array<Record<string, string>>) => Object.assign({}, ...sets) as Record<string, string>;
const matrixOf = (steps: string[]) => [
  ...steps.map((name, index) => `STEP {\nCOL=${index + 1}\nNAME=${name.toUpperCase()}\n}`),
  ...MATRIX_LAYERS.map(([type, name], index) => `LAYER {\nROW=${index + 1}\nCONTEXT=BOARD\nTYPE=${type}\nNAME=${name}\n}`),
].join('\n') + '\n';
const ONE: FixtureModel = { ...CANONICAL, top: [CANONICAL.top[0]], bottom: [] };

describe('ODB++ product model', () => {
  const files = writeJob();
  const model = readOdbpp(tgz(files))!;
  const b = model.board;

  it('reads components with reference, side, position, rotation, value and package', () => {
    expect(b).toMatchObject({ name: 'fixture', format: 'ODB++', units: 'mm' });
    expect(b.components.map(c => [c.ref, c.side, c.position.x, c.position.y, c.rotation, c.value, c.package])).toEqual([
      ['R1', 'top', 10, 10, 0, '10k', 'R0603'], ['U1', 'top', 20, 12, 270, 'BC847', 'SOT-23'], ['J1', 'top', 30, 15, 90, 'HDR', 'CONN-2'],
      ['TP1', 'top', 40, 5, 315, '', 'TP-2'], ['E1', 'top', 44, 20, 0, '', 'EDGE-3'],
      // Bottom parts keep the file's rotation (clockwise 90 = counter-clockwise 270); the mirror is the side.
      ['R2', 'bottom', 12, 20, 0, '1k', 'R0603'], ['U2', 'bottom', 25, 22, 270, 'BC857', 'SOT-23'],
    ]);
    expect(b.components.every(c => !c.refGenerated)).toBe(true);
  });

  it('places every pin at its TOP record with its net and the side of the copper it touches', () => {
    const expected = pinPositions(CANONICAL);
    expect(b.pins).toHaveLength(expected.length);
    for (const row of expected) {
      const found = pin(b, row.ref, row.pin);
      expect(found, `${row.ref}.${row.pin}`).toBeDefined();
      expect([found.x, found.y], `${row.ref}.${row.pin}`).toEqual([expect.closeTo(row.x, 6), expect.closeTo(row.y, 6)]);
      expect([found.net, found.side], `${row.ref}.${row.pin}`).toEqual([row.net, row.padSide]);
    }
    expect(b.nets.map(net => net.name).sort()).toEqual(['GND', 'OUT', 'SIG', 'VCC']);
    expect(pin(b, 'E1', 'B1').side).toBe('bottom'); // a top part's pad on the bottom copper (edge connector)
    expect(pin(b, 'J1', 'A').side).toBe('both');
    expect(pin(b, 'J1', 'NPTH0')).toMatchObject({ net: '', side: 'both', shape: 'round', radius: 0.5 }); // an unplated hole stays, without a net
    expect(part(b, 'TP1').pinIds).toHaveLength(2); // the paste aperture PAD0 is not a pin
    expect(note(b, /1 toeprint\(s\) without a net whose features lie only on mask or paste layers/)).toBeDefined();
    expect(note(b, /1 pin\(s\) were placed on the side of the copper they touch/)).toBeDefined();
  });

  it('turns package pin outlines into pad shapes in board orientation', () => {
    const pad = (ref: string, number: string) => { const p = pin(b, ref, number); return [p.shape, p.width ?? null, p.height ?? null, p.radius, p.rotation ?? null]; };
    expect(pad('R1', '1')).toEqual(['rect', 0.8, 0.9, 0.4, 0]);
    expect(pad('U1', '1')).toEqual(['square', 0.6, 0.6, 0.3, 270]);
    expect(pad('U1', '3')).toEqual(['rect', expect.closeTo(0.6, 9), expect.closeTo(0.8, 9), expect.closeTo(0.3, 9), 270]); // an axis-aligned contour
    expect(pad('J1', 'A')).toEqual(['round', null, null, 0.8, null]);
    expect(pad('J1', 'B')).toEqual(['round', null, null, expect.closeTo(0.8, 9), null]); // a contour of arcs around one centre
    expect(pad('TP1', '1')).toEqual(['round', null, null, expect.closeTo(0.5, 6), null]); // a polygonized circle
    expect(pad('TP1', '2')).toEqual(['rect', expect.closeTo(0.8, 6), expect.closeTo(0.8, 6), expect.closeTo(0.4, 6), 315]); // a triangle, approximated
    expect(pad('E1', '1')).toEqual(['rect', expect.closeTo(0.8, 5), expect.closeTo(0.4, 5), expect.closeTo(0.2, 5), expect.closeTo(30, 3)]); // a rectangle turned 30°
    expect(pad('E1', 'B1')).toEqual(['rect', expect.closeTo(0.8, 6), expect.closeTo(1, 6), expect.closeTo(0.4, 6), 0]); // rounded corners, approximated
    expect(pad('U2', '1')).toEqual(['square', 0.6, 0.6, 0.3, 90]); // mirrored bottom part: rotation then mirror
    expect(note(b, /2 pad\(s\) whose contour is neither a circle nor a rectangle/)).toBeDefined();
  });

  it('places package bodies with the component rotation and mirror', () => {
    const bounds = (ref: string) => { const { minX, minY, maxX, maxY } = part(b, ref).bounds; return [minX, minY, maxX, maxY].map(v => Number(v.toFixed(6))); };
    expect(bounds('R1')).toEqual([8.5, 9.2, 11.5, 10.8]);
    expect(bounds('U1')).toEqual([19.35, 10.55, 20.65, 13.45]); // 2.9 × 1.3 body turned 90° clockwise
    expect(bounds('R2')).toEqual([10.5, 19.2, 13.5, 20.8]);
    expect(part(b, 'J1').outline.length).toBeGreaterThan(20); // the body contour has two arcs
    expect(part(b, 'TP1').outline).toHaveLength(24); // a CR body becomes a 24-gon
    for (const ref of ['R1', 'R2', 'TP1', 'E1']) for (const id of part(b, ref).pinIds) { // parts whose pads lie inside their body
      const p = b.pins.find(candidate => candidate.id === id)!, { minX, minY, maxX, maxY } = part(b, ref).bounds;
      expect(p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY, `${ref}.${p.number}`).toBe(true);
    }
  });

  it('reads the profile with its arc and discloses the cutout', () => {
    expect(b.bounds).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 30 });
    expect(b.outline.length).toBeGreaterThan(8);
    expect(b.outline.some(p => p.x > 45.1 && p.y > 25.1)).toBe(true); // points on the corner arc
    expect(b.warnings.some(warning => warning.key === 'parse.warning.boardCutouts')).toBe(true);
    expect(b.warnings.some(warning => warning.key === 'parse.warning.missingBoardOutline')).toBe(false);
  });

  it('reports part numbers, values, mount types, attributes, properties and BOM data per component', () => {
    const info = Object.fromEntries(model.components.map(component => [component.ref, component]));
    expect(info.R1).toMatchObject({ partName: 'RC0603FR-0710KL', partNumber: 'RC0603-10K', value: '10k', mountType: 'SMT', attributes: { '.comp_mount_type': 'SMT', '.no_pop': 'true' }, layer: 'comp_+_top' });
    expect(info.U1).toMatchObject({ partNumber: 'BC847B', properties: { VALUE: 'BC847', Note: "it's quoted" } });
    expect(info.U1.bom).toContainEqual(['VPL_MPN', 'BC847B,215']);
    expect(info.J1.partNumber).toBe('HDR-1X2'); // the CMP part name when nothing better exists
    expect(info.TP1.partNumber).toBe(''); // "???" is no part name
    expect(info.U2).toMatchObject({ side: 'bottom', layer: 'comp_+_bot', value: 'BC857' });
    expect(model.components).toHaveLength(b.components.length);
  });

  it('describes the product model: step, layers, units, writer and version', () => {
    expect(model).toMatchObject({ step: 'pcb', container: 'tgz', root: '', source: 'TRACE fixture writer', version: '8.1' });
    expect(model.steps).toEqual([{ name: 'pcb', inMatrix: true, components: 7, toeprints: 18, hasEda: true, hasProfile: true, hasNetlist: false, childSteps: [] }]);
    expect(model.layers.map(layer => layer.name)).toEqual(MATRIX_LAYERS.map(([, name]) => name.toLowerCase()));
    expect(model.units).toEqual({ 'steps/pcb/layers/comp_+_bot/components': 'MM', 'steps/pcb/layers/comp_+_top/components': 'MM', 'steps/pcb/eda/data': 'MM', 'steps/pcb/profile': 'MM' });
    expect(notes(b)[0]).toBe('ODB++ step "pcb", ODB++ 8.1, written by TRACE fixture writer: components, pins, packages, nets and the profile are read; copper features, drills and other layers are not drawn.');
  });
});

describe('containers and layouts', () => {
  const files = writeJob(), reference = shape(board(files));
  it('gives the same board from gzip tar, plain tar, tar.Z, ZIP, a nested archive, deeper roots, .Z members, CRLF files and a file set', () => {
    const z = Object.fromEntries(Object.entries(files).map(([path, text]) => /eda\/data$|components$|profile$/.test(path) ? [`${path}.Z`, compressZ(bytesOf(text))] : [path, text]));
    const variants: Array<[string, Board]> = [
      ['tar', parseOdbpp({ name: 'b.tar', data: tarOf(files) })!],
      ['tar.Z', parseOdbpp({ name: 'b.tar.Z', data: compressZ(tarOf(files)) })!],
      ['zip', parseOdbpp({ name: 'b.zip', data: zipOf(files) })!],
      ['nested', parseOdbpp({ name: 'b.zip', data: zipOf({ 'export/board.tgz': tgzOf(rooted(files, 'board/')), 'notes.txt': 'x' }) })!],
      ['job root', board(rooted(files, 'job/'))],
      ['two roots deep', board(rooted(files, 'export/odb/'))],
      ['.Z members', board(z)],
      ['CRLF', board(toCrLf(files))],
      ['file set', parseOdbppFiles({ name: 'job', files: Object.fromEntries(Object.entries(rooted(files, 'job/')).map(([path, data]) => [path, bytesOf(data)])) })],
      ['map file set', openOdbppFiles({ name: 'job', files: new Map(Object.entries(files).map(([path, data]) => [path, bytesOf(data)])) }).board()],
    ];
    for (const [label, variant] of variants) expect(shape(variant), label).toEqual(reference);
    expect(note(variants[3][1], /read from board\.tgz inside the archive/)).toBeDefined();
    expect(readOdbpp({ name: 'b.zip', data: zipOf(rooted(files, 'job/')) })!.root).toBe('job');
  });

  it('reads inch files, mixed units and fallback units to the same millimetres', () => {
    const inch = board(writeJob(CANONICAL, { units: { components: 'INCH', eda: 'INCH', profile: 'INCH', info: 'INCH' } }));
    close(shape(inch, 9), reference, 1e-4);
    const mixed = readOdbpp(tgz(writeJob(CANONICAL, { units: { components: 'MM', eda: 'INCH', profile: 'INCH' } })))!;
    close(shape(mixed.board, 9), reference, 1e-4);
    expect(mixed.units).toMatchObject({ 'steps/pcb/eda/data': 'INCH', 'steps/pcb/profile': 'INCH', 'steps/pcb/layers/comp_+_top/components': 'MM' });
    // Files without UNITS: misc/info decides, else the specification's default (inch).
    const fromInfo = board(writeJob(CANONICAL, { units: { components: null, eda: null, profile: null, info: 'MM' } }));
    expect(shape(fromInfo)).toEqual(reference);
    expect(note(fromInfo, /4 file\(s\) have no UNITS directive and were read in MM \(misc\/info\)/)).toBeDefined();
    const fromDefault = board(writeJob(CANONICAL, { units: { components: null, eda: null, profile: null, info: null } }));
    close(shape(fromDefault, 9), reference, 1e-4);
    expect(note(fromDefault, /read in INCH \(the specification default\)/)).toBeDefined();
  });
});

describe('nets', () => {
  const reference = board(writeJob());
  const netsOf = (b: Board) => Object.fromEntries(b.pins.map(p => [`${part(b, b.components.find(c => c.id === p.componentId)!.ref).ref}.${p.number}`, p.net]));
  it('takes nets from the SNT TOP subnets, else from the TOP net numbers', () => {
    expect(netsOf(board(writeJob(CANONICAL, { topNets: false })))).toEqual(netsOf(reference));
    const fromTop = board(writeJob(CANONICAL, { subnets: false }));
    // Without subnets there are no feature records: sides come from pin types and parts, and the paste aperture is kept.
    expect(netsOf(fromTop)).toEqual({ ...netsOf(reference), 'TP1.PAD0': '' });
    expect(pin(fromTop, 'E1', 'B1').side).toBe('top');
    const wrong = writeJob();
    wrong['steps/pcb/layers/comp_+_top/components'] = wrong['steps/pcb/layers/comp_+_top/components'].replace(/^(TOP 0 \S+ \S+ \S+ N) \d+/m, '$1 4');
    const disagreeing = board(wrong);
    expect(netsOf(disagreeing)).toEqual(netsOf(reference));
    expect(note(disagreeing, /1 TOP record net number\(s\) disagree with the eda\/data subnet records/)).toBeDefined();
  });

  it('falls back to the cadnet netlist, matched by position and side, when eda/data has no nets', () => {
    const simple = plain(CANONICAL), expected = netsOf(board(writeJob(simple)));
    const fromNetlist = board(writeJob(simple, { eda: false, netlist: true }));
    expect(netsOf(fromNetlist)).toEqual(expected);
    expect(note(fromNetlist, /Nets come from netlists\/cadnet\/netlist, matched to 15 pins by position; 0 net points matched no pin\./)).toBeDefined();
    expect(note(fromNetlist, /eda\/data is missing/)).toBeDefined();
    expect(part(fromNetlist, 'U1').package).toBe('BC847B'); // the CMP part name without packages
    const negated = board(writeJob(simple, { eda: false, netlist: { negateY: true } }));
    expect(netsOf(negated)).toEqual(expected);
    expect(note(negated, /with the Y axis negated/)).toBeDefined();
    // An eda/data whose only net is $NONE$ has no connectivity either.
    const files = writeJob(simple, { netlist: true });
    files['steps/pcb/eda/data'] = files['steps/pcb/eda/data'].split('\n').filter(line => !/^(NET (?!\$NONE\$)|SNT|FID)/.test(line)).join('\n');
    const noneOnly = board(files);
    expect(netsOf(noneOnly)).toEqual(expected);
    expect(note(noneOnly, /TOP record\(s\) name a net number that eda\/data does not have/)).toBeDefined();
    expect(board(writeJob(simple, { eda: false })).warnings.some(warning => warning.key === 'parse.warning.noNets')).toBe(true);
  });

  it('treats single-pin KiCad placeholder nets as no-connects only in KiCad-written models', () => {
    const model: FixtureModel = { ...CANONICAL, top: CANONICAL.top.map(c => c.ref === 'R1' ? { ...c, nets: ['VCC', 'unconnected-(R1-Pad2)'] } : c) };
    const kicad = board(writeJob(model, { writer: 'KiCad EDA 9.0.9' }));
    expect(pin(kicad, 'R1', '2').net).toBe('');
    expect(note(kicad, /1 KiCad "unconnected-\(…\)" single-pad placeholder nets were treated as no-connects/)).toBeDefined();
    expect(pin(board(writeJob(model)), 'R1', '2').net).toBe('unconnected-(R1-Pad2)');
  });
});

describe('placement of package geometry', () => {
  it('follows the specification (rotate clockwise, then mirror X) without a note', () => {
    expect(note(board(writeJob()), /rotation and mirror flag/)).toBeUndefined();
  });
  it('uses the combination that reproduces the pins when a writer stores bottom packages already flipped', () => {
    const options: WriteOptions = { place: (component, p, side) => side === 'bottom' ? flippedPlace(component, p) : flippedPlace({ ...component, mirror: false }, { x: p.x, y: -p.y }) };
    const flipped = board(writeJob(CANONICAL, options));
    // R2 (0°) needs the other combination; for U2 (90°) mirroring X after the turn equals flipping Y before it, so it fits as it is.
    expect(note(flipped, /^1 component\(s\): the file's rotation and mirror flag did not reproduce the pin positions/)).toBeDefined();
    for (const row of pinPositions(CANONICAL, options)) expect(pin(flipped, row.ref, row.pin).x, `${row.ref}.${row.pin}`).toBeCloseTo(row.x, 6);
    for (const ref of ['R2', 'U2']) {
      const component = part(flipped, ref);
      for (const id of component.pinIds) { const p = flipped.pins.find(candidate => candidate.id === id)!; expect(p.y >= component.bounds.minY - 1e-9 && p.y <= component.bounds.maxY + 1e-9, `${ref}.${p.number}`).toBe(true); }
    }
  });
  it('keeps the specification placement and says so when no combination fits', () => {
    const scrambled = board(writeJob(CANONICAL, { place: (component, p) => ({ x: component.x + p.y * 3, y: component.y + p.x * 2 }) }));
    expect(note(scrambled, /component\(s\): no rotation\/mirror combination reproduces the pin positions/)).toBeDefined();
  });
});

describe('part numbers', () => {
  const partNumberOf = (bom: string[], props: Array<[string, string]> = []) => {
    const model: FixtureModel = { ...ONE, top: [{ ...ONE.top[0], props, bom }] };
    return readOdbpp(tgz(writeJob(model)))!.components[0].partNumber;
  };
  it('prefers a part-number property, then the chosen MPN, the first MPN, VPL_MPN, CPN and IPN', () => {
    expect(partNumberOf(['MPN 0 1 OTHER'], [['MPN', 'FROM-PROPERTY']])).toBe('FROM-PROPERTY');
    expect(partNumberOf(['CPN C1', 'MPN 0 0 FIRST', 'MPN 1 Y CHOSEN'])).toBe('CHOSEN');
    expect(partNumberOf(['CPN C1', 'MPN FIRST', 'LNFILE 1 bom.txt', 'QLF 0', 'CHS 0', 'CPN C1', 'MPN SECOND', 'QLF 1', 'CHS 1'])).toBe('SECOND');
    expect(partNumberOf(['CPN C1', 'MPN ONLY ONE'])).toBe('ONLY ONE');
    expect(partNumberOf(['IPN I1', 'VPL_MPN V1', 'CPN C1'])).toBe('V1');
    expect(partNumberOf(['IPN I1', 'CPN C1'])).toBe('C1');
    expect(partNumberOf(['IPN I1'])).toBe('I1');
    expect(partNumberOf([])).toBe('RC0603FR-0710KL');
  });
});

describe('steps', () => {
  const panel = 'X_DATUM=0\nSTEP-REPEAT {\nNAME=PCB\nX=0\nY=0\nDX=60\nDY=0\nNX=2\nNY=1\nANGLE=0\nMIRROR=NO\n}\n';
  const multi = () => {
    const files = merge(writeJob(CANONICAL, { step: 'pcb' }), writeJob(ONE, { step: 'coupon' }), writeJob({ ...ONE, top: [ONE.top[0], { ...ONE.top[0], ref: 'FID1', x: 3 }, { ...ONE.top[0], ref: 'FID2', x: 6 }, { ...ONE.top[0], ref: 'FID3', x: 9 }, { ...ONE.top[0], ref: 'FID4', x: 12 }, { ...ONE.top[0], ref: 'FID5', x: 15 }, { ...ONE.top[0], ref: 'FID6', x: 18 }, { ...ONE.top[0], ref: 'FID7', x: 21 }] }, { step: 'panel' }));
    files['steps/panel/stephdr'] = panel;
    files['matrix/matrix'] = matrixOf(['panel', 'pcb', 'coupon']);
    return files;
  };
  it('reads the board step by default, prefers steps that nest no others, and lets another step be chosen', () => {
    const source = openOdbpp(tgz(multi()))!;
    expect(source.steps.map(step => [step.name, step.components, step.childSteps])).toEqual([['panel', 8, ['pcb']], ['pcb', 7, []], ['coupon', 1, []]]);
    expect(source.defaultStep).toBe('pcb');
    const chosen = source.board();
    expect(chosen.components).toHaveLength(7);
    expect(note(chosen, /The product model has 2 steps with components \(pcb, coupon\); "pcb" \(the most components\) was read/)).toBeDefined();
    expect(source.board('COUPON').components.map(c => c.ref)).toEqual(['R1']);
    const nested = source.read('panel').board;
    expect(note(nested, /Step "panel" nests other steps \(pcb\); only its own components are shown/)).toBeDefined();
    expect(failure(() => source.read('nope')).message).toMatch(/step "nope" does not exist; the product model has panel, pcb, coupon/);
    expect(listOdbppSteps(tgz(multi()))?.map(step => step.name)).toEqual(['panel', 'pcb', 'coupon']);
    expect(parseOdbpp(tgz(multi()), { step: 'coupon' })!.components).toHaveLength(1);
  });

  it('finds steps and component layers by directory when the matrix is missing or unreadable', () => {
    const missing = board(writeJob(CANONICAL, { matrix: false }));
    expect(note(missing, /matrix\/matrix is missing; steps and component layers were taken from directory names/)).toBeDefined();
    expect(missing.components).toHaveLength(7);
    // Without matrix rows there is no copper order, so feature records cannot place pads: sides come from pin types and parts.
    expect(pin(missing, 'E1', 'B1').side).toBe('top');
    const broken = board(writeJob(CANONICAL, { matrixText: 'STEP {\nNAME=PCB\n' }));
    expect(note(broken, /matrix\/matrix could not be read \(matrix\/matrix line 1: block STEP is not closed\.\)/)).toBeDefined();
    expect(note(broken, /matrix\/matrix is unreadable/)).toBeDefined();
    const illegal = writeJob();
    illegal['matrix/matrix'] += 'LAYER {\nROW=99\nTYPE=DOCUMENT\nNAME=My Notes\n}\n';
    expect(note(board(illegal), /1 STEP\/LAYER block\(s\) in matrix\/matrix have names that are not legal ODB\+\+ entity names and were skipped: "my notes"/)).toBeDefined();
  });

  it('does not let a damaged step hide the others, but reports it when it is chosen', () => {
    const files = multi();
    files['steps/coupon/layers/comp_+_top/components'] = 'CMP zero 0 0 0 N R1 X\n';
    const source = openOdbpp(tgz(files))!;
    expect(source.steps.find(step => step.name === 'coupon')).toMatchObject({ components: 0, error: expect.stringMatching(/invalid package reference: zero/) });
    expect(note(source.board(), /1 other step\(s\) could not be read: coupon \(/)).toBeDefined();
    expect(failure(() => source.board('coupon')).message).toMatch(/comp_\+_top\/components line 1: invalid package reference/);
    const only = writeJob(); only['steps/pcb/layers/comp_+_top/components'] = 'CMP zero\n';
    expect(failure(() => board(only)).message).toMatch(/CMP needs/);
  });

  it('refuses a product model without components', () => {
    const files = writeJob();
    delete files['steps/pcb/layers/comp_+_top/components']; delete files['steps/pcb/layers/comp_+_bot/components'];
    expect(failure(() => board(files)).message).toMatch(/no step holds components \(comp_\+_top \/ comp_\+_bot\); steps: pcb/);
    expect(failure(() => board(files)).format).toBe('ODB++');
  });

  it('skips embedded component layers and reads other outer COMPONENT layers by matrix row', () => {
    const files = writeJob();
    const layers = [...MATRIX_LAYERS.slice(0, 5), ['COMPONENT', 'COMP_+_INNER'] as const, ...MATRIX_LAYERS.slice(5), ['COMPONENT', 'ASSY_BOTTOM'] as const];
    files['matrix/matrix'] = [`STEP {\nNAME=PCB\n}`, ...layers.map(([type, name], index) => `LAYER {\nROW=${index + 1}\nTYPE=${type}\nNAME=${name}\n}`)].join('\n') + '\n';
    files['steps/pcb/layers/comp_+_inner/components'] = 'UNITS=MM\nCMP 0 1 1 0 N EMB1 X\n';
    files['steps/pcb/layers/assy_bottom/components'] = 'UNITS=MM\nCMP 0 1 1 0 M EXTRA1 X\n';
    const b = board(files);
    expect(note(b, /Component layers that are not on an outer side were skipped \(embedded or unknown\): comp_\+_inner/)).toBeDefined();
    expect(part(b, 'EXTRA1').side).toBe('bottom');
    expect(b.components.some(c => c.ref === 'EMB1')).toBe(false);
  });
});

describe('robustness', () => {
  it('tolerates a damaged misc/info and multi-line property values', () => {
    const files = writeJob();
    files['misc/info'] = 'UNITS=MM\nBROKEN {\n';
    files['steps/pcb/layers/comp_+_top/components'] = files['steps/pcb/layers/comp_+_top/components'].replace("PRP Value '10k'", "PRP Value '10k\nsecond line\n'");
    const model = readOdbpp(tgz(files))!;
    expect(note(model.board, /misc\/info could not be read \(misc\/info line 2: block BROKEN is not closed\.\)/)).toBeDefined();
    expect(model.components[0].properties.Value).toBe('10k\nsecond line');
    expect(note(model.board, /unrecognized records/)).toBeUndefined();
  });

  it('takes the value from the property named Value even when a weaker value-like property sorts before it', () => {
    const top = 'steps/pcb/layers/comp_+_top/components';
    const files = writeJob();
    const original = files[top];
    files[top] = original.replace("PRP Value '10k'", "PRP Val '4k7'\nPRP Value 'RC0603-10K-1%'");
    const model = readOdbpp(tgz(files))!;
    expect(model.components[0].value).toBe('RC0603-10K-1%');
    expect(model.board.components[0].value).toBe('RC0603-10K-1%');
    files[top] = original.replace("PRP Value '10k'", "PRP Val '4k7'");
    expect(readOdbpp(tgz(files))!.components[0].value).toBe('4k7');
  });

  it('discloses dangling references between component layers and eda/data', () => {
    const files = writeJob();
    files['steps/pcb/layers/comp_+_top/components'] = files['steps/pcb/layers/comp_+_top/components'].replace(/^CMP 0 /m, 'CMP 42 ');
    files['steps/pcb/layers/comp_+_bot/components'] = files['steps/pcb/layers/comp_+_bot/components'].replace(/^TOP 1 /m, 'TOP 7 ');
    files['steps/pcb/eda/data'] = files['steps/pcb/eda/data'].replace('NET GND;0;ID=11', 'NET GND;0;ID=11\nSNT TOP T 99 0\nSNT TOP B 0 77');
    const b = board(files);
    expect(note(b, /1 component\(s\) reference a package that eda\/data does not define/)).toBeDefined();
    expect(note(b, /2 SNT TOP record\(s\) point to a component or toeprint that does not exist/)).toBeDefined();
    expect(note(b, /1 toeprint\(s\) reference a package pin that does not exist/)).toBeDefined();
    expect(part(b, 'R1').pinIds).toHaveLength(2);
  });

  it('rejects text that is not text, coordinates out of range and malformed records with the file and line', () => {
    const utf16 = writeJob() as Record<string, string | Uint8Array>;
    utf16['steps/pcb/eda/data'] = Uint8Array.of(0xff, 0xfe, 0x41);
    expect(failure(() => board(utf16)).message).toMatch(/steps\/pcb\/eda\/data is not a text file/);
    const far = writeJob(); far['steps/pcb/layers/comp_+_top/components'] = far['steps/pcb/layers/comp_+_top/components'].replace(/^TOP 0 \S+/m, 'TOP 0 1e12');
    expect(failure(() => board(far)).message).toMatch(/exceeds the supported range/);
    const bad = writeJob(); bad['steps/pcb/profile'] = 'UNITS=MM\nS P 0\nOB 0 0 I\nOS 1 1\n';
    expect(failure(() => board(bad)).message).toMatch(/^ODB\+\+ steps\/pcb\/profile line 2: the surface is not closed/);
  });

  it('reports archives whose ODB++ entries hide behind unsafe paths instead of calling them unrecognized', () => {
    const files = writeJob();
    const unsafe = tarEntries(Object.entries(files).map(([path, data]) => ({ path: `../${path}`, data })));
    expect(sniffOdbpp(unsafe)).toMatchObject({ confidence: 0.6, detail: expect.stringMatching(/unsafe/) });
    expect(failure(() => parseOdbpp({ name: 'x.tar', data: unsafe })).message).toMatch(/none of the files a board needs .*\(\d+ unsafe paths were ignored\)/);
    const mixed = tarEntries([...Object.entries(files).map(([path, data]) => ({ path, data })), { path: '/etc/matrix/matrix', data: 'STEP {\nNAME=EVIL\n}\n' }]);
    expect(note(parseOdbpp({ name: 'x.tar', data: mixed })!, /1 archive entries with absolute, drive-letter or parent-directory \(\.\.\) paths were ignored/)).toBeDefined();
  });

  it('survives truncation at every 1/64 of a tar and random corruption with a board, null or a BoardFormatError only', () => {
    const tar = tarOf(writeJob());
    let boards = 0, errors = 0;
    for (let index = 1; index < 64; index++) {
      try { if (parseOdbpp({ name: 'b.tar', data: tar.subarray(0, Math.floor(tar.length * index / 64)) })) boards++; }
      catch (error) { expect(error, `1/64 × ${index}`).toBeInstanceOf(BoardFormatError); errors++; }
    }
    expect(boards + errors).toBeGreaterThan(50);
    let state = 0x5eed;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
    for (let round = 0; round < 250; round++) {
      const bytes = tar.slice();
      for (let flip = 0; flip < 1 + Math.floor(random() * 6); flip++) bytes[Math.floor(random() * bytes.length)] = [0x20, 0x0a, 0x2d, 0x3b, 0x27, 0x39, 0x00, 0xff][Math.floor(random() * 8)];
      try { parseOdbpp({ name: 'b.tar', data: bytes }); } catch (error) { expect(error, `round ${round}`).toBeInstanceOf(BoardFormatError); }
    }
  });

  it('returns null for everything that is not an ODB++ archive', () => {
    for (const data of [bytesOf('just text\n'), new Uint8Array(0), Uint8Array.of(0x1f, 0x8b), tgzOf({ 'readme.md': '# hello' }), zipOf({ 'board.kicad_pcb': '(kicad_pcb)' }), tarOf({ 'fonts/standard': 'X\n' })]) {
      expect(parseOdbpp({ name: 'x', data })).toBeNull();
      expect(sniffOdbpp(data)).toBeNull();
    }
    expect(parseOdbpp({ name: 'x', data: 'text' as unknown as Uint8Array })).toBeNull();
  });
});

describe('sniffing', () => {
  it('gives a confidence that grows with the evidence', () => {
    const files = writeJob();
    expect(sniffOdbpp(tgzOf(files))).toMatchObject({ id: 'odbpp', confidence: 0.98, container: 'tgz', detail: expect.stringMatching(/matrix\/matrix present/) });
    expect(sniffOdbpp(tarOf({ 'job/matrix/matrix': files['matrix/matrix'] }))).toMatchObject({ confidence: 0.9, container: 'tar' });
    expect(sniffOdbpp(zipOf({ 'steps/pcb/layers/comp_+_top/components': 'CMP\n' }))).toMatchObject({ confidence: 0.8, container: 'zip' });
    expect(sniffOdbpp(tgzOf({ 'job/steps/pcb/layers/top/features': 'F 0\n' }))).toMatchObject({ confidence: 0.6 });
    expect(sniffOdbpp(zipOf({ 'board.tgz': tgzOf(files) }))).toMatchObject({ confidence: 0.98, container: 'zip', nested: 'board.tgz' });
    expect(sniffOdbpp(compressZ(tarOf(files)))).toMatchObject({ confidence: 0.98, container: 'tar.Z' });
  });
});

describe('timing', () => {
  /** A synthetic board of `count` two-pin parts in a grid, nets shared by neighbours. */
  function grid(count: number): FixtureModel {
    const top = Array.from({ length: count }, (_, index): FixtureComponent => ({
      pkg: 0, ref: `R${index + 1}`, part: 'R', x: 2 + (index % 200) * 4, y: 2 + Math.floor(index / 200) * 3, rot: (index % 4) * 90, mirror: false, props: [['Value', '1k']],
      nets: [`N${index % 997}`, `N${(index + 1) % 997}`],
    }));
    return { ...CANONICAL, top, bottom: [], profile: [{ hole: false, records: [['OB', 0, 0, 'I'], ['OS', 900, 0], ['OS', 900, 900], ['OS', 0, 900], ['OE']] }] };
  }
  const read = (data: Uint8Array) => parseOdbpp({ name: 'g.tgz', data })!;

  it('reads boards in time linear in their size', () => {
    expect(read(tgzOf(writeJob(grid(2000)))).pins).toHaveLength(4000);
    expectScaling('board size', [500, 2000, 8000], count => { const data = tgzOf(writeJob(grid(count))); return () => read(data); });
  });

  it('works out a shared package shape once, however many parts use it', () => {
    const ring = Array.from({ length: 50_000 }, (_, i) => { const a = 2 * Math.PI * i / 50_000; return ['OS', -0.8 + 0.3 * Math.cos(a), 0.3 * Math.sin(a)] as [string, number, number]; });
    const heavy = (count: number): FixtureModel => {
      const base = grid(count);
      return { ...base, packages: [{ ...base.packages[0], pins: [{ ...base.packages[0].pins[0], outline: { ct: [['OB', -0.5, 0, 'I'], ...ring, ['OE']] } }, base.packages[0].pins[1]] }, ...base.packages.slice(1)] };
    };
    const shared = tgzOf(writeJob(heavy(2000))), plain = tgzOf(writeJob(grid(2000)));
    expect(pin(read(shared), 'R1', '1')).toMatchObject({ shape: 'round', radius: expect.closeTo(0.3, 6) });
    // The 50,000-vertex ring is read once; analysing it for each of the 2,000 toeprints would cost about 100 million vertex visits.
    expectCostAtMost('shared package shape', () => read(shared), () => read(plain), 6);
  });

  it('bounds netlist matching when hostile input stacks every pin on one spot', () => {
    const stacked = (count: number): FixtureModel => ({ ...grid(count), top: grid(count).top.map(component => ({ ...component, x: 10, y: 10, rot: 0 })) });
    const archive = (count: number) => tgzOf(writeJob(stacked(count), { eda: false, netlist: true }));
    expect(note(read(archive(1000)), /pins stacked more than 64 to a 0\.05 mm cell were not matched/)).toBeDefined();
    expectScaling('stacked pins', [250, 1000, 4000], count => { const data = archive(count); return () => read(data); });
  });
});
