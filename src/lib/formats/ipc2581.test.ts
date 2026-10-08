import { catching, expectBoundedWork, expectScaling, expectCostAtMost, linearReference } from '../../test-support/timing';
import { describe, expect, it } from 'vitest';
import type { Board, BoardPin, Point } from '../types';
import { BoardFormatError, textInput } from './common';
import { IPC2581_LIMITS, IPC2581_SNIFF_BYTES, parseIpc2581, sniffIpc2581 } from './ipc2581';
import { canonicalBoard, gridBoard, ipc2581Xml, type FixtureBoard, type FixtureStep } from './ipc2581-fixtures';

// Original synthetic IPC-2581 documents written by ipc2581-fixtures.ts; no vendor file and no specification text is used.
const enc = new TextEncoder();
const xmlOf = (board: FixtureBoard | string) => typeof board === 'string' ? board : ipc2581Xml(board);
const read = (board: FixtureBoard | string, name = 'synthetic.xml'): Board => {
  const result = parseIpc2581(textInput(xmlOf(board), name));
  if (!result) throw new Error('unexpectedly unrecognized');
  return result;
};
const failure = (action: () => unknown): BoardFormatError => {
  try { action(); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
};
const notes = (board: Board) => board.warnings.filter(issue => issue.key === 'parse.warning.formatNote').map(issue => String(issue.params?.message));
const keys = (board: Board) => board.warnings.map(issue => issue.key);
const part = (board: Board, ref: string) => { const found = board.components.find(component => component.ref === ref); if (!found) throw new Error(`no component ${ref}`); return found; };
const pinsOf = (board: Board, ref: string) => board.pins.filter(pin => pin.componentId === part(board, ref).id);
const pin = (board: Board, ref: string, number: string): BoardPin => { const found = pinsOf(board, ref).find(item => item.number === number); if (!found) throw new Error(`no pin ${ref}.${number}`); return found; };
const at = (point: Point, x: number, y: number) => { expect(point.x, 'x').toBeCloseTo(x, 9); expect(point.y, 'y').toBeCloseTo(y, 9); };
const netMembers = (board: Board) => Object.fromEntries(board.nets.map(net => [net.name, net.pinIds.map(id => { const p = board.pins.find(item => item.id === id)!; return `${board.components.find(c => c.id === p.componentId)!.ref}.${p.number}`; }).sort()]));
/** The canonical board with one step override. */
const board = (step: Partial<FixtureStep> = {}, overrides: Partial<FixtureBoard> = {}) => canonicalBoard(overrides, step);
const CANONICAL_NETS = { GND: ['C1.2', 'J1.2', 'R2.2'], MID: ['R1.2', 'R2.1'], VCC: ['C1.1', 'J1.1', 'R1.1'] };
/** Conductor-layer pads of the canonical board at their placed positions. */
const CANONICAL_COPPER: FixtureStep['copper'] = [
  { layer: 'TOP', net: 'VCC', pads: [{ x: 9.2, y: 10, ref: 'R1', pin: '1' }, { x: 5, y: 30, ref: 'J1', pin: '1', shape: 'SQUARE_1' }] },
  { layer: 'BOTTOM', net: 'VCC', pads: [{ x: 5, y: 30, ref: 'J1', pin: '1', shape: 'SQUARE_1' }, { x: 30, y: 20.5, ref: 'C1', pin: '1' }] },
  { layer: 'TOP', net: 'MID', pads: [{ x: 10.8, y: 10, ref: 'R1', pin: '2' }, { x: 20, y: 9.2, ref: 'R2', pin: '1' }], traces: 3 },
  { layer: 'TOP', net: 'GND', pads: [{ x: 20, y: 10.8, ref: 'R2', pin: '2' }, { x: 7.54, y: 30, ref: 'J1', pin: '2', shape: 'CIRCLE_1' }] },
  { layer: 'BOTTOM', net: 'GND', pads: [{ x: 7.54, y: 30, ref: 'J1', pin: '2', shape: 'CIRCLE_1' }, { x: 29.75, y: 19.5, ref: 'C1', pin: '2' }] },
];

describe('IPC-2581: recognition (content, not extension)', () => {
  it('sniffs the root element with a confidence: namespace and revision B or C give 1', () => {
    expect(sniffIpc2581(enc.encode(ipc2581Xml(canonicalBoard())))).toEqual({ format: 'ipc2581', confidence: 1, revision: 'C', namespace: true, entities: false });
    expect(sniffIpc2581(enc.encode(ipc2581Xml(canonicalBoard({ revision: 'B' }))))).toMatchObject({ confidence: 1, revision: 'B' });
    expect(sniffIpc2581(enc.encode(ipc2581Xml(canonicalBoard({ prefix: 'ipc' }))))).toMatchObject({ confidence: 1, namespace: true });
    expect(sniffIpc2581(enc.encode(ipc2581Xml(canonicalBoard({ namespace: false }))))).toMatchObject({ confidence: 0.9, namespace: false });
    expect(sniffIpc2581(enc.encode(ipc2581Xml(canonicalBoard({ revision: 'A' }))))).toMatchObject({ confidence: 0.7, revision: 'A' });
    expect(sniffIpc2581(enc.encode(ipc2581Xml(canonicalBoard({ revision: null, namespace: false }))))).toEqual({ format: 'ipc2581', confidence: 0.6, namespace: false, entities: false });
    expect(sniffIpc2581(enc.encode('<IPC-2581 revision="<script>"/>'))).toBeNull(); // not well-formed: "<" in an attribute value
    expect(sniffIpc2581(enc.encode('<IPC-2581 revision="C; drop"/>'))).toMatchObject({ confidence: 0.6 }); // an implausible revision is not reported
    expect(sniffIpc2581(enc.encode('<IPC-2581 revision="C; drop"/>'))?.revision).toBeUndefined();
  });
  it('reads documents with a byte-order mark, comments, processing instructions, a DOCTYPE without entities, a prefix, and UTF-16', () => {
    const prologs = ['', '﻿', '<?xml version="1.0"?>\n<!-- exported -->\n<?pi x?>\n', '<!DOCTYPE IPC-2581 SYSTEM "http://example.invalid/IPC-2581.dtd">\n', '<!-- a --><!DOCTYPE IPC-2581 [ <!ELEMENT IPC-2581 ANY> ]><!-- b -->'];
    for (const prolog of prologs) expect(read(canonicalBoard({ prolog })).pins, JSON.stringify(prolog)).toHaveLength(8);
    expect(read(canonicalBoard({ prefix: 'ipc' })).pins).toHaveLength(8);
    const text = ipc2581Xml(canonicalBoard({ prolog: '' }));
    const le = Uint8Array.from([0xff, 0xfe, ...[...text].flatMap(char => [char.charCodeAt(0) & 255, char.charCodeAt(0) >> 8])]);
    const be = Uint8Array.from([0xfe, 0xff, ...[...text].flatMap(char => [char.charCodeAt(0) >> 8, char.charCodeAt(0) & 255])]);
    expect(parseIpc2581({ name: 'le.xml', data: le })?.pins).toHaveLength(8);
    expect(parseIpc2581({ name: 'be.xml', data: be })?.pins).toHaveLength(8);
  });
  it('returns null (not this format) for other XML, IPC-2581 mentions, other roots, text and binary data', () => {
    const others = ['<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><!-- <IPC-2581> --></svg>', '<eagle version="9.6.2"><drawing/></eagle>', 'This document discusses <IPC-2581 revision="B"> files.',
      '<?xml version="1.0"?>\n<project><IPC-2581 revision="C"/></project>', '<IPC-2581x revision="C"/>', '<ipc-2581 revision="C"/>', '', '          ', '<IPC-2581', '<!-- unterminated', '(kicad_pcb (version 20240108))', '$HEADER\nGENCAD 1.4', '{"IPC-2581":1}'];
    for (const text of others) {
      expect(sniffIpc2581(enc.encode(text)), text).toBeNull();
      expect(parseIpc2581(textInput(text)), text).toBeNull();
    }
    expect(sniffIpc2581(Uint8Array.from({ length: 4096 }, (_, index) => (index * 37) & 255))).toBeNull();
    expect(sniffIpc2581(new Uint8Array(0))).toBeNull();
  });
  it('sniffs only the first 64 KiB: a prolog longer than that is not claimed, a huge body is not read', () => {
    const xml = ipc2581Xml(canonicalBoard({ prolog: '' }));
    expect(sniffIpc2581(enc.encode(`<!--${'x'.repeat(IPC2581_SNIFF_BYTES)}-->${xml}`))).toBeNull();
    const huge = enc.encode(`${xml.slice(0, 200)}${'<!-- filler -->'.repeat(2_000_000)}`);
    expect(sniffIpc2581(huge)).toMatchObject({ confidence: 1 });
    expectBoundedWork('IPC sniff prefix', [125_000, 500_000, 2_000_000], n => { const data = enc.encode(`${xml.slice(0, 200)}${'<!-- filler -->'.repeat(n)}`); return () => sniffIpc2581(data); });
  });
});

describe('IPC-2581: revisions B and C', () => {
  for (const revision of ['C', 'B']) {
    it(`reads the canonical two-sided board, revision ${revision}: parts, values, packages, sides, transforms, pads, nets, outline`, () => {
      const b = read(canonicalBoard({ revision }));
      expect(b.format).toBe(`IPC-2581 rev. ${revision}`); expect(b.units).toBe('mm'); expect(b.name).toBe('synthetic');
      expect(b.components.map(c => [c.ref, c.value, c.package, c.side, c.rotation])).toEqual([
        ['R1', '10k', 'R0603', 'top', 0], ['R2', '10k', 'R0603', 'top', 90], ['C1', '100nF', 'C0402', 'bottom', 90], ['J1', 'CONN_2', 'HDR2', 'top', 0]]);
      at(part(b, 'R2').position, 20, 10);
      // Top parts: rotation counter-clockwise about the origin. R2 at 90°: local (−0.8, 0) → (0, −0.8).
      at(pin(b, 'R1', '1'), 9.2, 10); at(pin(b, 'R1', '2'), 10.8, 10); at(pin(b, 'R2', '1'), 20, 9.2); at(pin(b, 'R2', '2'), 20, 10.8);
      // Bottom part: mirror x → −x first, then rotate. C1 local (0.5, 0.25) → (−0.5, 0.25) → 90° → (−0.25, −0.5).
      at(pin(b, 'C1', '1'), 30, 20.5); at(pin(b, 'C1', '2'), 29.75, 19.5);
      expect(pinsOf(b, 'C1').map(p => p.side)).toEqual(['bottom', 'bottom']);
      expect(pinsOf(b, 'J1').map(p => p.side)).toEqual(['both', 'both']); // THRU pins
      expect(pinsOf(b, 'R1').map(p => p.side)).toEqual(['top', 'top']);
      // Exact pad shapes from the dictionary; pad rotation follows the component.
      expect(pin(b, 'R1', '1')).toMatchObject({ shape: 'rect', width: 1, height: 0.6, radius: 0.3, rotation: 0 });
      expect(pin(b, 'R2', '1')).toMatchObject({ shape: 'rect', width: 1, height: 0.6, rotation: 90 });
      expect(pin(b, 'C1', '1')).toMatchObject({ shape: 'rect', rotation: 90 });
      expect(pin(b, 'J1', '1')).toMatchObject({ shape: 'square', width: 1.6, height: 1.6 });
      expect(pin(b, 'J1', '2')).toMatchObject({ shape: 'round', width: 1.6, radius: 0.8 });
      expect(netMembers(b)).toEqual(CANONICAL_NETS);
      // Package outlines are placed with the component transform.
      expect(part(b, 'R2').bounds).toEqual({ minX: 19.2, minY: 8.5, maxX: 20.8, maxY: 11.5 });
      expect(b.outline).toEqual([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 0, y: 40 }]);
      expect(b.bounds).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 40 });
      expect(b.warnings).toEqual([]);
    });
  }
  it('reads revision A or a missing revision with the B/C rules and says so', () => {
    expect(notes(read(canonicalBoard({ revision: 'A' })))).toEqual(['IPC-2581 revision A was read with the revision B/C rules; only revisions B and C are verified.']);
    const bare = read(canonicalBoard({ revision: null }));
    expect(bare.format).toBe('IPC-2581'); expect(notes(bare)[0]).toMatch(/without a revision attribute/);
  });
});

describe('IPC-2581: units and transforms', () => {
  it('converts INCH and MICRON coordinates and dictionary sizes to millimetres', () => {
    const inch = read(canonicalBoard({ units: 'INCH' }));
    at(pin(inch, 'R1', '1'), 9.2 * 25.4, 10 * 25.4);
    expect(pin(inch, 'R1', '1').width).toBeCloseTo(25.4, 9); expect(inch.bounds.maxX).toBeCloseTo(1270, 9);
    const micron = read(canonicalBoard({ units: 'MICRON' }));
    at(pin(micron, 'C1', '2'), 0.02975, 0.0195); expect(pin(micron, 'R1', '1').height).toBeCloseTo(0.0006, 12);
  });
  it('scales dictionary entries by their own units when they differ from the CAD header', () => {
    const b = read(canonicalBoard({ dictionaryUnits: 'MICRON', dictionary: { RECT_1: '<RectCenter width="1000" height="600"/>', CIRCLE_1: '<Circle diameter="1600"/>', SQUARE_1: '<RectCenter width="1600" height="1600"/>' } }));
    expect(pin(b, 'R1', '1')).toMatchObject({ width: 1, height: 0.6 }); expect(pin(b, 'J1', '2').radius).toBeCloseTo(0.8, 12);
    expect(failure(() => read(canonicalBoard({ dictionaryUnits: 'FURLONG' })))).toMatchObject({ code: 'UNSUPPORTED_VARIANT', format: 'IPC-2581' });
  });
  it('rejects unsupported or missing units', () => {
    expect(failure(() => read(canonicalBoard({ units: 'FOOT' })))).toMatchObject({ code: 'UNSUPPORTED_VARIANT', message: expect.stringMatching(/units "FOOT" are not supported/) });
    expect(failure(() => read(canonicalBoard({ units: null, dictionaryUnits: 'MILLIMETER' }))).message).toMatch(/no Ecad\/CadHeader/);
    expect(failure(() => read(ipc2581Xml(canonicalBoard()).replace(/<CadHeader units="MILLIMETER">/, '<CadHeader>'))).message).toMatch(/CadHeader has no units/);
  });
  it('places arbitrary rotations and combines pin and component rotations (sign flipped on a mirrored part)', () => {
    const b = read(board({
      packages: [{ name: 'P', pins: [{ number: '1', x: 1, y: 0, rotation: 20 }, { number: '2', x: 0, y: 1 }] }],
      components: [{ ref: 'U1', pkg: 'P', x: 10, y: 10, rotation: 45 }, { ref: 'U2', pkg: 'P', x: 20, y: 10, rotation: 30, mirror: true }],
      logicalNets: [{ name: 'N', pins: [['U1', '1'], ['U2', '1']] }],
    }, { bom: null }));
    const s = Math.SQRT1_2;
    at(pin(b, 'U1', '1'), 10 + s, 10 + s); at(pin(b, 'U1', '2'), 10 - s, 10 + s);
    expect(pin(b, 'U1', '1').rotation).toBeCloseTo(65, 9); expect(pin(b, 'U2', '1').rotation).toBeCloseTo(10, 9);
    // U2 mirrored: (1, 0) → (−1, 0) → 30° → (−cos 30°, −sin 30°).
    at(pin(b, 'U2', '1'), 20 - Math.cos(Math.PI / 6), 10 - 0.5);
    expect(part(b, 'U2').side).toBe('bottom'); expect(part(b, 'U2').rotation).toBe(30);
  });
  it('applies an Xform scale and offset and discloses that this reading is unverified', () => {
    const b = read(board({ components: [{ ref: 'R1', pkg: 'R0603_1', x: 10, y: 10, scale: 2, xOffset: 1, yOffset: 2 }], logicalNets: [] }, { bom: null }));
    at(part(b, 'R1').position, 11, 12); at(pin(b, 'R1', '1'), 9.4, 12); expect(pin(b, 'R1', '1')).toMatchObject({ width: 2, height: 1.2 });
    expect(notes(b)).toContain('1 component uses an Xform scale or offset; this reading (offset added after the rotation) is not verified with real files.');
    expect(failure(() => read(board({ components: [{ ref: 'R1', pkg: 'R0603_1', x: 1, y: 1, scale: 0 }] }))).message).toMatch(/scale must be positive/);
  });
  it('takes the side from the layer table, notes a disagreeing mirror flag and falls back to the flag when the layer has no side', () => {
    const conflict = read(board({ components: [{ ref: 'R1', pkg: 'R0603_1', x: 10, y: 10, mirror: true, layer: 'TOP' }], logicalNets: [] }));
    expect(part(conflict, 'R1').side).toBe('top'); expect(notes(conflict)[0]).toMatch(/1 component: the layer side and the Xform mirror flag disagree/);
    const unknown = read(board({ components: [{ ref: 'R1', pkg: 'R0603_1', x: 10, y: 10, mirror: true, layer: 'NOT_A_LAYER' }, { ref: 'R2', pkg: 'R0603_1', x: 20, y: 10, layer: 'NOT_A_LAYER' }], logicalNets: [] }));
    expect([part(unknown, 'R1').side, part(unknown, 'R2').side]).toEqual(['bottom', 'top']);
    expect(notes(unknown)).toContain('2 components name layers without a top or bottom side; the side was taken from the Xform mirror flag.');
    const noTable = read(canonicalBoard({ layers: null }));
    expect(noTable.components.map(c => c.side)).toEqual(['top', 'top', 'bottom', 'top']); expect(notes(noTable)[0]).toMatch(/^4 components name layers without a top or bottom side/);
    const functions = read(canonicalBoard({ layers: [{ name: 'TOP', fn: 'COMPONENT_TOP' }, { name: 'BOTTOM', fn: 'COMPONENT_BOTTOM' }] }));
    expect(functions.components.map(c => c.side)).toEqual(['top', 'top', 'bottom', 'top']); expect(notes(functions)).toEqual([]);
  });
});

describe('IPC-2581: pins and nets from conductor layers, physical nets and placeholders', () => {
  it('reads nets, positions and sides from conductor-layer pads when there is no LogicalNet; vias and traces are skipped', () => {
    const via = '<LayerFeature layerRef="TOP"><Set net="VCC"><Pad padstackDefRef="VIA"><Location x="1.0" y="1.0"/><StandardPrimitiveRef id="CIRCLE_1"/></Pad><Features><Line startX="0" startY="0" endX="1" endY="1"><LineDesc lineWidth="0.2"/></Line></Features></Set></LayerFeature>';
    const b = read(board({ logicalNets: [], copper: CANONICAL_COPPER, extra: via }));
    expect(netMembers(b)).toEqual(CANONICAL_NETS); expect(b.pins).toHaveLength(8); expect(b.warnings).toEqual([]);
    expect(pinsOf(b, 'J1').map(p => p.side)).toEqual(['both', 'both']); expect(pinsOf(b, 'C1').map(p => p.side)).toEqual(['bottom', 'bottom']);
  });
  it('takes the side from the conductor layers that carry a pin (an SMD pad on both layers is on both sides, a THRU pin with one pad on one side)', () => {
    const b = read(board({ logicalNets: [], copper: [
      { layer: 'TOP', net: 'A', pads: [{ x: 9.2, y: 10, ref: 'R1', pin: '1' }, { x: 5, y: 30, ref: 'J1', pin: '1' }] },
      { layer: 'BOTTOM', net: 'A', pads: [{ x: 9.2, y: 10, ref: 'R1', pin: '1' }] },
    ] }));
    expect(pin(b, 'R1', '1').side).toBe('both'); expect(pin(b, 'J1', '1').side).toBe('top');
  });
  it('lets the LogicalNet win over a conflicting conductor net and says so', () => {
    const b = read(board({ copper: [{ layer: 'TOP', net: 'OTHER', pads: [{ x: 9.2, y: 10, ref: 'R1', pin: '1' }] }] }));
    expect(pin(b, 'R1', '1').net).toBe('VCC'); expect(notes(b)).toEqual(['1 conflicting net assignment was found; the LogicalNet name is used, otherwise the first conductor pad.']);
  });
  it('uses the conductor pad position when the placed package pin is elsewhere, and adds pads that share a pin number as extra pins', () => {
    const moved = read(board({ copper: [{ layer: 'TOP', net: 'VCC', pads: [{ x: 9.0, y: 10, ref: 'R1', pin: '1' }] }] }));
    at(pin(moved, 'R1', '1'), 9.0, 10); expect(notes(moved)[0]).toMatch(/^1 pin: the placed package pin and its conductor pad are more than 0.01 mm apart/);
    const extra = read(board({ copper: [{ layer: 'TOP', net: 'VCC', pads: [{ x: 9.2, y: 10, ref: 'R1', pin: '1' }, { x: 9.2, y: 14, ref: 'R1', pin: '1' }] }, { layer: 'BOTTOM', net: 'VCC', pads: [{ x: 9.2, y: 14, ref: 'R1', pin: '1' }] }] }));
    const ones = pinsOf(extra, 'R1').filter(p => p.number === '1');
    expect(ones.map(p => [p.x, p.y, p.side, p.net])).toEqual([[9.2, 10, 'top', 'VCC'], [9.2, 14, 'both', 'VCC']]);
    expect(notes(extra)).toEqual(['1 conductor pad shares a pin number with another pad of its component and is shown as an extra pin of that number.']);
  });
  it('leaves out non-electrical package pins without a conductor pad (apertures, bare holes) but keeps electrical ones', () => {
    const b = read(board({
      packages: [{ name: 'Q', pins: [{ number: '1', x: -1, y: 0 }, { number: '2', x: 1, y: 0 }, { number: '1', x: -1, y: 0.3, electricalType: 'UNDEFINED' }, { x: 0, y: 2, electricalType: 'MECHANICAL', type: 'THRU' }, { number: '3', x: 0, y: -2 }] }],
      components: [{ ref: 'Q1', pkg: 'Q', x: 10, y: 10 }],
      logicalNets: [{ name: 'S', pins: [['Q1', '3']] }],
      copper: [{ layer: 'TOP', net: 'A', pads: [{ x: 9, y: 10, ref: 'Q1', pin: '1' }, { x: 11, y: 10, ref: 'Q1', pin: '2' }] }],
    }, { bom: null }));
    expect(pinsOf(b, 'Q1').map(p => [p.number, p.net])).toEqual([['1', 'A'], ['2', 'A'], ['3', 'S']]);
    expect(notes(b)).toEqual(['2 package pins without a conductor pad (paste or mask apertures, mechanical pads) were left out.']);
    // Without any conductor pads the package pins are all kept.
    expect(read(board({ packages: [{ name: 'Q', pins: [{ number: '1', x: 0, y: 0, electricalType: 'MECHANICAL' }] }], components: [{ ref: 'Q1', pkg: 'Q', x: 1, y: 1 }], logicalNets: [] }, { bom: null })).pins).toHaveLength(1);
  });
  it('takes a pad shape from the conductor pad or its padstack when the package pin has none (regular pad, not the anti-pad)', () => {
    const padstacks = '<PadStackDef name="PS1"><PadstackHoleDef name="H" diameter="0.3" platingStatus="PLATED" plusTol="0" minusTol="0" x="0" y="0"/>'
      + '<PadstackPadDef layerRef="TOP" padUse="ANTIPAD"><Location x="0" y="0"/><Circle diameter="3.0"/></PadstackPadDef>'
      + '<PadstackPadDef layerRef="TOP" padUse="REGULAR"><Xform rotation="90"/><Location x="0" y="0"/><RectCenter width="1.2" height="0.8"/></PadstackPadDef></PadStackDef>';
    const b = read(board({
      packages: [{ name: 'P', pins: [{ number: '1', x: 0, y: 0, shape: '' }, { number: '2', x: 2, y: 0, shape: '' }, { number: '3', x: 4, y: 0, shape: '' }] }],
      components: [{ ref: 'U1', pkg: 'P', x: 10, y: 10 }], logicalNets: [], padstacks,
      copper: [{ layer: 'TOP', net: 'A', pads: [{ x: 10, y: 10, ref: 'U1', pin: '1', shape: 'CIRCLE_1' }, { x: 12, y: 10, ref: 'U1', pin: '2', shape: '', padstack: 'PS1' }, { x: 14, y: 10, ref: 'U1', pin: '3', shape: '' }] }],
    }, { bom: null }));
    expect(pin(b, 'U1', '1')).toMatchObject({ shape: 'round', radius: 0.8 });
    expect(pin(b, 'U1', '2')).toMatchObject({ shape: 'rect', width: 1.2, height: 0.8, rotation: 90 });
    expect(pin(b, 'U1', '3')).toMatchObject({ radius: 0 }); expect(pin(b, 'U1', '3').width).toBeUndefined();
    expect(b.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 1 } });
  });
  it('names pins that no PinRef reaches from PhyNet point coordinates, only when exactly one net has a point there', () => {
    const b = read(board({ logicalNets: [{ name: 'MID', pins: [['R1', '2']] }], physicalNets: [
      { name: 'VCC', points: [[9.2, 10], [5, 30], [30, 20.5]] }, { name: 'MID', points: [[20, 9.2]] }, { name: 'GND', points: [[20, 10.8], [9.2, 10.002]] },
    ] }));
    expect(pin(b, 'R1', '1').net).toBe(''); // two nets have a point within 5 µm
    expect([pin(b, 'J1', '1').net, pin(b, 'C1', '1').net, pin(b, 'R2', '1').net, pin(b, 'R2', '2').net, pin(b, 'R1', '2').net]).toEqual(['VCC', 'VCC', 'MID', 'GND', 'MID']);
    expect(notes(b)).toEqual(['4 pins got their nets from PhyNet point coordinates.']);
  });
  it('treats single-pad "unconnected-(…)" placeholder nets (both spellings) as no-connects and keeps every other net', () => {
    const b = read(board({ logicalNets: [
      { name: 'unconnected-(R1-Pad1)', pins: [['R1', '1']] }, { name: 'unconnected-_R1-Pad2_', pins: [['R1', '2']] }, { name: 'unconnected-(R2-Pad1)_1', pins: [['R2', '1']] },
      { name: 'unconnected-(J1-Pad1)', pins: [['J1', '1'], ['C1', '1']] }, { name: 'UNCONNECTED', pins: [['R2', '2']] },
    ] }));
    expect([pin(b, 'R1', '1').net, pin(b, 'R1', '2').net, pin(b, 'R2', '1').net]).toEqual(['', '', '']);
    expect(Object.keys(netMembers(b)).sort()).toEqual(['UNCONNECTED', 'unconnected-(J1-Pad1)']);
    expect(notes(b)).toEqual(['3 single-pad "unconnected-(…)" placeholder nets were treated as no-connects.']);
  });
});

describe('IPC-2581: missing optional sections', () => {
  it('reads a board without BOM: no values, the package names of the step', () => {
    const b = read(canonicalBoard({ bom: null }));
    expect(b.components.map(c => [c.value, c.package])).toEqual([['', 'R0603_1'], ['', 'R0603_1'], ['', 'C0402_2'], ['', 'HDR2_3']]);
    expect(b.warnings).toEqual([]);
  });
  it('takes the outline from the board-outline layer when there is no Profile, else estimates it', () => {
    const lines = '<Polyline><PolyBegin x="0" y="0"/><PolyStepSegment x="60" y="0"/><PolyStepSegment x="60" y="45"/></Polyline><Line startX="60" startY="45" endX="0" endY="45"/><Line startX="0" startY="45" endX="0" endY="0"/><Line startX="70" startY="0" endX="80" endY="0"/>';
    const layer = read(board({ profile: null, outlineFeatures: lines }));
    expect(layer.bounds).toEqual({ minX: 0, minY: 0, maxX: 60, maxY: 45 });
    expect(notes(layer)).toEqual(['IPC-2581 has no Profile; the board outline was taken from the board-outline layer.', '1 open board-outline chain (spurs, chords or gaps) is not part of a closed contour and was ignored.']);
    const circle = read(board({ profile: null, outlineFeatures: '<Location x="25" y="20"/><Circle diameter="60"/>' }));
    expect(circle.bounds.minX).toBeCloseTo(-5, 6); expect(circle.bounds.maxY).toBeCloseTo(50, 6); expect(notes(circle)).toContain('1 IPC-2581 outline arc was approximated by straight segments.');
    const open = read(board({ profile: null, outlineFeatures: '<Line startX="0" startY="0" endX="10" endY="0"/>' }));
    expect(notes(open)).toEqual(['IPC-2581 has no Profile and its board-outline layer does not form a closed contour; an estimated boundary is shown.']);
    expect(keys(open)).toContain('parse.warning.missingBoardOutline');
    const none = read(board({ profile: null }));
    expect(keys(none)).toEqual(['parse.warning.missingBoardOutline']); expect(notes(none)).toEqual([]);
  });
  it('reads profile arcs and discloses cutouts while drawing the outer contour', () => {
    const arc = read(board({ profile: [[0, 0], [40, 0], [50, 10, 40, 10, false], [50, 40], [0, 40], [0, 0]] }));
    expect(arc.bounds.maxX).toBeCloseTo(50, 9); expect(arc.outline.length).toBeGreaterThan(10);
    expect(notes(arc)).toEqual(['1 IPC-2581 profile arc was approximated by straight segments.']);
    const holes = read(board({ cutouts: [[[35, 30], [45, 30], [45, 35], [35, 35]]] }));
    expect(holes.outline).toHaveLength(4); expect(holes.bounds).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 40 }); expect(keys(holes)).toContain('parse.warning.boardCutouts');
  });
  it('reads a board with neither LogicalNet nor conductor pads (no nets), without a dictionary (pads without size) and without a layer table', () => {
    expect(keys(read(board({ logicalNets: [] })))).toEqual(['parse.warning.noNets']);
    const bare = read(canonicalBoard({ dictionary: {} }));
    expect(bare.pins.every(p => p.radius === 0 && p.width === undefined)).toBe(true);
    expect(notes(bare)).toEqual(['8 pad shape references name no dictionary entry; those pads are drawn without a size.']);
    expect(bare.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 8 } });
  });
  it('reads part values from Measured characteristics, trims BOM references and reports parts that are not populated', () => {
    const b = read(canonicalBoard({ bom: [{ refs: [' R1 ', 'R2'], measured: ['10000', 'OHM'], packageRef: 'R0603' }, { refs: ['C1'], value: '100nF', populate: false }] }));
    expect(b.components.map(c => c.value)).toEqual(['10000 OHM', '10000 OHM', '100nF', '']);
    expect(notes(b)).toEqual(['1 component is marked not populated in the BOM (populate="false").']);
  });
});

describe('IPC-2581: steps, references and pad shapes', () => {
  it('reads the step named by StepRef (not a panel) and says that other steps were not read', () => {
    const step = canonicalBoard().steps[0];
    const b = read(canonicalBoard({ steps: [{ ...step, name: 'panel', type: 'PANEL', components: [step.components[0]] }, step], stepRefs: ['panel', 'board'] }));
    expect(b.components).toHaveLength(4); expect(notes(b)).toEqual(['1 other IPC-2581 step with components was not read; step "board" is shown.']);
  });
  it('rejects files without placed components, duplicate steps and duplicate packages', () => {
    expect(failure(() => read(canonicalBoard({ functionMode: 'FABRICATION' }, { components: [] }))).message).toMatch(/no placed components \(FunctionMode FABRICATION\)/);
    const step = canonicalBoard().steps[0];
    expect(failure(() => read(canonicalBoard({ steps: [step, step] }))).message).toMatch(/declares the step "board" twice/);
    expect(failure(() => read(board({ packages: [...step.packages, step.packages[0]] }))).message).toMatch(/declares the package "R0603_1" twice/);
  });
  it('reports pin references to missing parts, duplicate reference designators, parts without a reference and pins without a number', () => {
    const b = read(board({
      packages: [{ name: 'P', pins: [{ number: '1', x: 0, y: 0 }, { x: 1, y: 0 }, { number: '', x: 2, y: 0 }] }],
      components: [{ ref: 'U1', pkg: 'P', x: 0, y: 0 }, { ref: 'U1', pkg: 'P', x: 10, y: 0 }, { pkg: 'P', x: 20, y: 0 }, { ref: 'U9', pkg: 'MISSING', x: 30, y: 0 }],
      logicalNets: [{ name: 'N', pins: [['U1', '1'], ['X9', '1'], ['U9', '1']] }],
    }, { bom: null }));
    expect(b.components.map(c => [c.ref, c.refGenerated ?? false])).toEqual([['U1', false], ['U1', false], ['COMP3', true], ['U9', false]]);
    expect(pinsOf(b, 'COMP3').map(p => [p.number, p.numberGenerated ?? false])).toEqual([['1', false], ['~1', true], ['~2', true]]);
    expect(b.nets).toEqual([]);
    expect(notes(b)).toEqual([
      '1 IPC-2581 component references a package the step does not define; it is shown without pins.',
      '1 reference designator is used by more than one component.',
      '1 IPC-2581 component has no reference designator; a placeholder name is shown.',
      '2 IPC-2581 pin references (PinRef) name component pins that do not exist and were ignored.',
      '1 LogicalNet pin reference names a reference designator that several components use and was not assigned.',
    ]);
  });
  it('keeps exact shapes where they are simple and bounds the others (approximated pads are counted)', () => {
    const dictionary = {
      RR0: '<RectRound width="1" height="0.5" radius="0"/>', RR: '<RectRound width="1" height="0.5" radius="0.1"/>', RC: '<RectCorner lowerLeftX="-0.5" lowerLeftY="-0.25" upperRightX="0.5" upperRightY="0.25"/>',
      RCO: '<RectCorner lowerLeftX="0" lowerLeftY="0" upperRightX="1" upperRightY="0.5"/>', OV: '<Oval width="2" height="1"/>', OVC: '<Oval width="1" height="1"/>', EL: '<Ellipse width="1" height="3"/>',
      DN: '<Donut shape="ROUND" outerDiameter="2" innerDiameter="1"/>', OCT: '<Octagon length="1.5"/>', CH: '<RectCham width="2" height="1" chamfer="0.1"/>', TR: '<Triangle base="1" height="2"/>',
      CT: '<Contour><Polygon><PolyBegin x="-1" y="-1"/><PolyStepSegment x="2" y="-1"/><PolyStepSegment x="2" y="1"/><PolyStepSegment x="-1" y="1"/><PolyStepSegment x="-1" y="-1"/></Polygon></Contour>',
    };
    const ids = Object.keys(dictionary);
    const b = read(board({
      packages: [{ name: 'P', pins: [...ids.map((id, index) => ({ number: String(index + 1), x: index * 5, y: 0, shape: id })), { number: 'U', x: 0, y: 5, user: 'USER_1' }, { number: 'I', x: 5, y: 5, inline: '<Circle diameter="0.5"/>' }, { number: 'X', x: 10, y: 5, shape: 'NOPE' }] }],
      components: [{ ref: 'U1', pkg: 'P', x: 0, y: 0 }], logicalNets: [],
    }, { bom: null, dictionary, userDictionary: { USER_1: '<UserSpecial><Circle diameter="2"/><Line startX="0" startY="0" endX="3" endY="0"/></UserSpecial>' } }));
    const shape = (number: string) => { const p = pin(b, 'U1', number); return [p.shape, p.width, p.height]; };
    expect(ids.map((_, index) => shape(String(index + 1)))).toEqual([
      ['rect', 1, 0.5], ['rect', 1, 0.5], ['rect', 1, 0.5], ['rect', 2, 1], ['rect', 2, 1], ['round', 1, 1], ['rect', 1, 3],
      ['round', 2, 2], ['square', 1.5, 1.5], ['rect', 2, 1], ['rect', 1, 2], ['rect', 4, 2]]);
    expect(shape('U')).toEqual(['rect', 6, 2]); expect(shape('I')).toEqual(['round', 0.5, 0.5]); expect(shape('X')).toEqual(['round', undefined, undefined]);
    // Exact: RR0, RC, OVC and the inline circle; everything else (9 dictionary shapes and the user shape) is approximated.
    expect(b.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 10 } });
    expect(notes(b)).toContain('1 pad shape reference names no dictionary entry; that pad is drawn without a size.');
  });
});

describe('IPC-2581: malformed and hostile input', () => {
  const xml = ipc2581Xml(canonicalBoard());
  it('reports truncated and malformed documents as INVALID_FORMAT errors of the IPC-2581 format', () => {
    for (const text of [xml.slice(0, Math.floor(xml.length / 2)), xml.replace('</Ecad>', '</ecad>'), `${xml}<IPC-2581/>`, `${xml}text`, xml.replace('<Component ', '<Component refDes="X" ')]) {
      const error = failure(() => read(text));
      expect(error).toMatchObject({ code: 'INVALID_FORMAT', format: 'IPC-2581' }); expect(error.message).toMatch(/malformed/);
    }
  });
  it('rejects invalid numbers and structural errors with a message naming the element', () => {
    const cases: Array<[string, RegExp]> = [
      [xml.replace('<Location x="10.0" y="10.0"/></Component>', '<Location x="ten" y="10.0"/></Component>'), /Invalid IPC-2581 component R1 Location x: ten/],
      [xml.replace('<Location x="10.0" y="10.0"/></Component>', '<Location x="0x10" y="10.0"/></Component>'), /Invalid IPC-2581 component R1 Location x: 0x10/],
      [xml.replace('<Location x="10.0" y="10.0"/></Component>', '</Component>'), /component R1 has no Location/],
      [xml.replace(/<Location x="-0.8" y="0.0"\/>/, ''), /package R0603_1 pin 1 has no Location/],
      [xml.replace('<Circle diameter="1.6"/>', '<Circle diameter="-1.6"/>'), /Circle diameter must not be negative/],
      [xml.replace(/<Profile><Polygon><PolyBegin x="0.0" y="0.0"\/>/, '<Profile><Polygon><PolyStepSegment x="1.0" y="0.0"/><PolyBegin x="0.0" y="0.0"/>'), /step before its PolyBegin/],
      [xml.replace(/<Profile><Polygon><PolyBegin x="0.0" y="0.0"\/>/, '<Profile><Polygon><PolyBegin x="0.0" y="0.0"/><PolyBegin x="0.0" y="0.0"/>'), /second PolyBegin/],
      [xml.replace('<Location x="10.0" y="10.0"/></Component>', '<Location x="1e300" y="10.0"/></Component>'), /exceeds the supported range/],
    ];
    for (const [text, message] of cases) {
      const error = failure(() => read(text));
      expect(error.message, String(message)).toMatch(message); expect(error.format).toMatch(/^IPC-2581/); // errors of the board builder name the revision
    }
  });
  it('refuses entity declarations (billion laughs, external and parameter entities) without expanding them', () => {
    for (const subset of ['<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">', '<!ENTITY x SYSTEM "file:///etc/passwd">', '<!ENTITY % p SYSTEM "http://example.invalid/p.dtd">']) {
      const text = ipc2581Xml(canonicalBoard({ prolog: `<?xml version="1.0"?>\n<!DOCTYPE IPC-2581 [${subset}]>\n` })).replace('textualCharacteristicValue="10k"', 'textualCharacteristicValue="&c;"');
      expect(sniffIpc2581(enc.encode(text))).toMatchObject({ entities: true });
      const error = failure(() => read(text));
      expect(error).toMatchObject({ code: 'INVALID_FORMAT', format: 'IPC-2581' }); expect(error.message).toMatch(/declares entities .*never expanded/);
    }
  });
  it('decodes the predefined entities and character references, and keeps undeclared references literal', () => {
    const text = xml.replace('textualCharacteristicValue="10k"', 'textualCharacteristicValue="&lt;10k &amp; 1%&gt; &#x3A9;&#937; &foo; &amp;lt;"');
    expect(part(read(text), 'R1').value).toBe('<10k & 1%> ΩΩ &foo; &lt;');
  });
  it('bounds attribute size, nesting depth, attribute count and name length (LIMIT_EXCEEDED)', () => {
    const tails = [`<Extra v="${'x'.repeat(300_000)}"/>`, `${'<X>'.repeat(300)}${'</X>'.repeat(300)}`, `<Extra ${Array.from({ length: 200 }, (_, index) => `a${index}="1"`).join(' ')}/>`, `<${'N'.repeat(300)}/>`];
    for (const tail of tails) {
      const error = failure(() => read(canonicalBoard({ tail })));
      expect(error, tail.slice(0, 30)).toMatchObject({ code: 'LIMIT_EXCEEDED', format: 'IPC-2581' });
    }
  });
  it('preflights the placed pin count before creating pins', () => {
    const packages = [{ name: 'BIG', pins: Array.from({ length: 1001 }, (_, index) => ({ number: String(index + 1), x: index * 0.01, y: 0 })) }];
    const components = Array.from({ length: 1000 }, (_, index) => ({ ref: `U${index}`, pkg: 'BIG', x: index, y: 0 }));
    const error = failure(() => read(board({ packages, components, logicalNets: [] }, { bom: null })));
    expect(error).toMatchObject({ code: 'LIMIT_EXCEEDED', format: 'IPC-2581' }); expect(error.message).toMatch(/expands to 1001000 pins; the import limit is 1000000/);
    const input = textInput(ipc2581Xml(board({ packages, components, logicalNets: [] }, { bom: null })));
    expectCostAtMost('placed pin preflight', catching(() => parseIpc2581(input)), linearReference(input.data.length), 300);
  });
  it('stops building outline and contour geometry as soon as a point budget is exceeded (arcs count after sampling)', { timeout: 300_000 }, () => {
    const circles = Math.ceil(IPC2581_LIMITS.outlineSegments / 64) + 10;
    const outline = failure(() => read(board({ profile: null, outlineFeatures: '<Circle diameter="1"/>'.repeat(circles) })));
    expect(outline).toMatchObject({ code: 'LIMIT_EXCEEDED', format: 'IPC-2581' }); expect(outline.message).toMatch(/board-outline segments exceed the import limit of 500,000/);
    // A Profile of full-circle steps: 64 sampled points each.
    const curves = Math.ceil(IPC2581_LIMITS.points / 64) + 10;
    const profileOf = (steps: number) => ipc2581Xml(board()).replace(/<Profile>.*?<\/Profile>/, `<Profile><Polygon><PolyBegin x="0" y="0"/>${'<PolyStepCurve x="0" y="0" centerX="1" centerY="0" clockwise="false"/>'.repeat(steps)}</Polygon></Profile>`);
    const profile = profileOf(curves);
    const points = failure(() => read(profile));
    expect(points).toMatchObject({ code: 'LIMIT_EXCEEDED' }); expect(points.message).toMatch(/outline and contour points exceed the import limit of 4,000,000/);
    // With a Profile present, the board-outline layer is not built at all.
    expect(read(board({ outlineFeatures: '<Circle diameter="1"/>'.repeat(circles) })).bounds).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 40 });
    // The time of a Profile grows at most linearly with its steps, up to and including the one that is refused at the budget. The sizes are compared with
    // each other in the same process, so a busy machine does not decide the outcome (a fixed multiple of a plain pass over the text did). A step of four
    // times the size, from a quarter of the budget to the refusal, is measured at about size^0.5; a quadratic step would measure 2.
    const sizes = [Math.ceil(curves / 4), curves];
    expect(() => read(profileOf(sizes[0])), 'a Profile below the budget is read').not.toThrow();
    expectScaling('outline point refusal', sizes, steps => { const text = profileOf(steps); return catching(() => read(text)); });
  });
});

describe('IPC-2581: size and timing', () => {
  it('reads a 128,000-pin synthetic board (19 MB) with every pin on a conductor pad, linear in its size', { timeout: 300_000 }, () => {
    const data = enc.encode(ipc2581Xml(gridBoard(8000, 16, 0)));
    const b = parseIpc2581({ name: 'grid.xml', data })!;

    expect(b.components).toHaveLength(8000); expect(b.pins).toHaveLength(128_000); expect(b.nets).toHaveLength(42_666); expect(b.warnings).toEqual([]);
    expectScaling('placed IPC pins', [500, 2000, 8000], n => { const input = textInput(ipc2581Xml(gridBoard(n, 16, 0))); return () => parseIpc2581(input); });
  });
  it('skips trace features and other unread sections quickly', { timeout: 300_000 }, () => {
    const data = enc.encode(ipc2581Xml(gridBoard(500, 16, 100)));
    expect(parseIpc2581({ name: 'traces.xml', data })!.pins).toHaveLength(8000);
    const unread = enc.encode(ipc2581Xml(canonicalBoard({ tail: `<Avl name="AVL">${'<AvlItem OEMDesignNumber="X"><AvlVmpn qualified="true" chosen="true"><AvlMpn name="M" rank="1"/></AvlVmpn></AvlItem>'.repeat(100_000)}</Avl>` })));
    expect(parseIpc2581({ name: 'avl.xml', data: unread })!.pins).toHaveLength(8);
    expectCostAtMost('unread XML sections', () => parseIpc2581({ name: 'avl.xml', data: unread }), linearReference(unread.length), 300);
    expectScaling('trace features', [6, 25, 100], n => { const input = textInput(ipc2581Xml(gridBoard(500, 16, n))); return () => parseIpc2581(input); });
  });
  it('stays linear when one pin number owns tens of thousands of conductor pads and LogicalNet references', { timeout: 300_000 }, () => {
    const fixture = (count: number) => board({
      packages: [{ name: 'P', pins: [{ number: '1', x: 0, y: 0 }] }], components: [{ ref: 'U1', pkg: 'P', x: 0, y: 0 }],
      copper: [{ layer: 'TOP', net: 'N', pads: Array.from({ length: count }, (_, index) => ({ x: (index % 300) * 0.1, y: Math.floor(index / 300) * 0.1, ref: 'U1', pin: '1' })) }],
      logicalNets: [{ name: 'N', pins: Array.from({ length: count }, (): [string, string] => ['U1', '1']) }],
    }, { bom: null });
    expectScaling('duplicate conductor pads', [3750, 15_000, 60_000], n => { const input = textInput(ipc2581Xml(fixture(n))); return () => parseIpc2581(input); });
    const count = 60_000, b = read(fixture(count));
    expect(b.pins).toHaveLength(count); expect(b.nets).toEqual([expect.objectContaining({ name: 'N', pinIds: expect.any(Array) })]); expect(b.nets[0].pinIds).toHaveLength(count);
    expect(notes(b)).toEqual([`${count - 1} conductor pads share a pin number with another pad of their component and are shown as extra pins of that number.`]);
    // Many package pins of one number, each pad far from all of them: the nearest-pin search looks at a bounded window.
    const crowded = (count: number) => board({
      packages: [{ name: 'P', pins: Array.from({ length: count }, (_, index) => ({ number: '1', x: index * 0.1, y: 0 })) }], components: [{ ref: 'U1', pkg: 'P', x: 0, y: 0 }], logicalNets: [],
      copper: [{ layer: 'TOP', net: 'N', pads: Array.from({ length: count }, (_, index) => ({ x: index * 0.1, y: 5, ref: 'U1', pin: '1' })) }],
    }, { bom: null });
    expectScaling('nearest package pin', [1250, 5000, 20_000], n => { const input = textInput(ipc2581Xml(crowded(n))); return () => parseIpc2581(input); });
    const many = read(crowded(20_000));
    expect(many.pins).toHaveLength(20_000); expect(many.pins.every(p => p.y === 5 && p.net === 'N')).toBe(true);
  });
  it('gives up PhyNet matching with a note instead of comparing crowded coordinates quadratically', { timeout: 300_000 }, () => {
    const crowded = (count: number) => board({
      packages: [{ name: 'P', pins: Array.from({ length: count }, (_, index) => ({ number: String(index + 1), x: 0, y: 0 })) }], components: [{ ref: 'U1', pkg: 'P', x: 1, y: 1 }], logicalNets: [],
      physicalNets: Array.from({ length: 2 }, (_, net) => ({ name: `P${net}`, points: Array.from({ length: count }, (): [number, number] => [1, 1]) })),
    }, { bom: null });
    expectScaling('crowded physical nets', [1250, 5000, 20_000], n => { const input = textInput(ipc2581Xml(crowded(n))); return () => parseIpc2581(input); });
    const b = read(crowded(20_000));
    expect(b.nets).toEqual([]);
    expect(notes(b)).toEqual(['IPC-2581 PhyNet points crowd too closely around the pins to be matched in bounded time; no net was taken from them.']);
  });
  it('stays linear on hostile shapes: long attribute values, a long placeholder-like net name, many comments and empty elements', { timeout: 300_000 }, () => {
    const value = `${'&amp;'.repeat(50_000)}`;
    expect(read(canonicalBoard({ tail: `<Extra a="${value}" b="${value}"/>`.repeat(20) })).pins).toHaveLength(8);
    const name = `unconnected-(${'_1'.repeat(100_000)}`;
    expect(pin(read(board({ logicalNets: [{ name, pins: [['R1', '1']] }] })), 'R1', '1').net).toBe(name);
    expect(read(canonicalBoard({ prolog: `${'<!---->'.repeat(5000)}`, tail: '<!-- c --><Z/>'.repeat(200_000) })).pins).toHaveLength(8);
    expectScaling('hostile IPC text', [12_500, 50_000, 200_000], n => { const input = textInput(ipc2581Xml(canonicalBoard({ tail: '<!-- c --><Z/>'.repeat(n) }))); return () => parseIpc2581(input); });
    expectCostAtMost('long attribute entities', () => read(canonicalBoard({ tail: `<Extra a="${value}" b="${value}"/>`.repeat(20) })), linearReference(value.length * 40), 300);
  });
});
