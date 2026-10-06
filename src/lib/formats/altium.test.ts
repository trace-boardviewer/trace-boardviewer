import CFB from 'cfb';
import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import { BoardFormatError, textInput, type FormatErrorCode } from './common';
import { ALTIUM_ASCII, ALTIUM_BINARY, parseAltium } from './altium';

// --- Original synthetic fixture builders -------------------------------------------------------------------------------------
const MIL = 10_000; // internal units per mil
const MM = (mil: number) => mil * 0.0254;
const enc = new TextEncoder();
const u32 = (value: number) => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
function concat(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
const block = (payload: Uint8Array | number[]) => concat(u32(payload.length), payload);
const propText = (record: Record<string, string>) => '|' + Object.entries(record).map(([key, value]) => `${key}=${value}`).join('|') + '|';
const textBlock = (record: Record<string, string> | string) => block([...enc.encode(typeof record === 'string' ? record : propText(record)), 0]);
const pascal = (text: string) => block([text.length, ...enc.encode(text)]);

interface Pad { name?: string; layer?: number; net?: number; component?: number; x?: number; y?: number; top?: [number, number]; bottom?: [number, number]; shape?: number; bottomShape?: number; rotation?: number; mode?: number; size?: number }
/** Record type 2 followed by six length-prefixed sub-records; sub-record 5 follows the documented byte offsets. */
function padRecord(pad: Pad = {}): Uint8Array {
  const main = new Uint8Array(pad.size ?? 110), view = new DataView(main.buffer);
  const [topW, topH] = pad.top ?? [60 * MIL, 40 * MIL], [botW, botH] = pad.bottom ?? [topW, topH];
  if (main.length >= 63) {
    main[0] = pad.layer ?? 1; view.setUint16(1, 0, true); view.setUint16(3, pad.net ?? 0xffff, true); view.setUint16(5, 0xffff, true); view.setUint16(7, pad.component ?? 0, true);
    view.setInt32(13, pad.x ?? 0, true); view.setInt32(17, pad.y ?? 0, true);
    view.setInt32(21, topW, true); view.setInt32(25, topH, true); view.setInt32(29, topW, true); view.setInt32(33, topH, true); view.setInt32(37, botW, true); view.setInt32(41, botH, true);
    view.setInt32(45, 0, true); main[49] = pad.shape ?? 2; main[50] = pad.shape ?? 2; main[51] = pad.bottomShape ?? pad.shape ?? 2;
    view.setFloat64(52, pad.rotation ?? 0, true); main[60] = 1; main[62] = pad.mode ?? 0;
  }
  return concat([2], pascal(pad.name ?? '1'), block([]), block([]), block([]), block(main), block([]));
}

const COMPONENTS = [
  { SOURCEDESIGNATOR: 'U1', PATTERN: 'QFN16', LAYER: 'TOP', X: '1000mil', Y: '2000mil', ROTATION: '90.000' },
  { SOURCEDESIGNATOR: 'R1', PATTERN: '0402', LAYER: 'BOTTOM', X: '-500mil', Y: '250.5mil', ROTATION: '-90' },
];
const BOARD = { KIND: 'Protel_Advanced_PCB', VERSION: '5.01', VX0: '0mil', VY0: '0mil', KIND0: '0', VX1: '3000mil', VY1: '0mil', KIND1: '0', VX2: '3000mil', VY2: '2000mil', KIND2: '0', VX3: '0mil', VY3: '2000mil', KIND3: '0' };
const PADS: Pad[] = [
  { name: '1', layer: 74, net: 1, component: 0, x: 950 * MIL, y: 2000 * MIL },
  { name: '2', layer: 1, net: 0, component: 0, x: 1050 * MIL, y: 2000 * MIL, top: [50 * MIL, 50 * MIL], shape: 1, rotation: 45 },
  { name: '1', layer: 32, net: 1, component: 1, x: -520 * MIL, y: 250 * MIL, top: [30 * MIL, 30 * MIL] },
  { name: '2', layer: 32, component: 1, x: -480 * MIL, y: 250 * MIL, top: [30 * MIL, 30 * MIL] },
];
interface Spec { nets?: string[]; components?: Array<Record<string, string>>; pads?: Pad[]; board?: Record<string, string> | null; headers?: boolean; streams?: Record<string, Uint8Array | null> }
/** Default streams of a synthetic board; `streams` replaces (or with null removes) any of them by path. */
function streamsOf(spec: Spec = {}): Record<string, Uint8Array> {
  const nets = spec.nets ?? ['GND', 'VCC'], components = spec.components ?? COMPONENTS, pads = (spec.pads ?? PADS).map(pad => padRecord(pad));
  const out: Record<string, Uint8Array> = {
    '/Nets6/Data': concat(...nets.map(name => textBlock({ NAME: name }))),
    '/Components6/Data': concat(...components.map(record => textBlock(record))),
    '/Pads6/Data': concat(...pads),
  };
  if (spec.headers !== false) { out['/Nets6/Header'] = Uint8Array.from(u32(nets.length)); out['/Components6/Header'] = Uint8Array.from(u32(components.length)); out['/Pads6/Header'] = Uint8Array.from(u32(pads.length)); }
  if (spec.board !== null) out['/Board6/Data'] = textBlock(spec.board ?? BOARD);
  for (const [path, content] of Object.entries(spec.streams ?? {})) { if (content === null) delete out[path]; else out[path] = content; }
  return out;
}
function container(streams: Record<string, Uint8Array>, bulk = false): Uint8Array {
  const cfb = CFB.utils.cfb_new();
  for (const [path, content] of Object.entries(streams)) CFB.utils.cfb_add(cfb, path, content, bulk ? { unsafe: true } : undefined);
  return Uint8Array.from(CFB.write(cfb, { type: 'buffer' }) as Uint8Array);
}
const pcbDoc = (spec: Spec = {}) => container(streamsOf(spec));
const parse = (data: Uint8Array, name = 'synthetic.PcbDoc') => parseAltium({ name, data });
const parseText = (text: string, name = 'synthetic.PcbDoc') => parseAltium(textInput(text, name));
const ALLOWED: FormatErrorCode[] = ['INVALID_FORMAT', 'UNSUPPORTED_VARIANT', 'LIMIT_EXCEEDED', 'WRONG_KIND'];
function failure(run: () => unknown, code?: FormatErrorCode): BoardFormatError {
  try { run(); } catch (caught) {
    expect(caught).toBeInstanceOf(BoardFormatError);
    if (code) expect((caught as BoardFormatError).code).toBe(code);
    else expect(ALLOWED).toContain((caught as BoardFormatError).code);
    return caught as BoardFormatError;
  }
  throw new Error('expected a BoardFormatError');
}
const board = (data: Uint8Array) => parse(data) as Board;
const messages = (result: Board) => result.warnings.map(warning => (warning.params as { message?: string } | undefined)?.message ?? warning.key);

// --- Low-level container helpers used to damage valid files -------------------------------------------------------------------
const u32at = (data: Uint8Array, at: number) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);
const setU32 = (data: Uint8Array, at: number, value: number) => new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(at, value, true);
const sectorAt = (sector: number) => (sector + 1) * 512;
const fatAt = (data: Uint8Array, sector: number) => sectorAt(u32at(data, 76 + 4 * (sector >> 7))) + (sector & 127) * 4;
/** Byte offset of the 128-byte directory entry named `name`. */
function entryOf(data: Uint8Array, name: string): number {
  for (let sector = u32at(data, 48); sector < 0xfffffff0; sector = u32at(data, fatAt(data, sector))) {
    for (let offset = sectorAt(sector); offset < sectorAt(sector) + 512; offset += 128) {
      const length = (data[offset + 64] | data[offset + 65] << 8) / 2 - 1;
      let text = '';
      for (let i = 0; i < length; i++) text += String.fromCharCode(data[offset + i * 2] | data[offset + i * 2 + 1] << 8);
      if (text === name) return offset;
    }
  }
  throw new Error(`no directory entry ${name}`);
}
const bigPads = (count: number): Pad[] => Array.from({ length: count }, (_, index) => ({ name: String(index + 1), layer: 1, net: index % 2, component: 0, x: index * 10 * MIL, y: 0 }));
function prng(seed: number) { let state = seed >>> 0 || 1; return () => (state = (state ^ state << 13) >>> 0, state = (state ^ state >>> 17) >>> 0, state = (state ^ state << 5) >>> 0, state / 2 ** 32); }

describe('parseAltium binary PcbDoc (OLE compound file)', () => {
  it('imports components, pads, nets and the outline with 1/10000 mil fixed point, sides and rotations', () => {
    const result = board(pcbDoc());
    expect(result.format).toBe(ALTIUM_BINARY); expect(result.name).toBe('synthetic'); expect(result.units).toBe('mm');
    expect(result.components.map(part => [part.ref, part.package, part.side])).toEqual([['U1', 'QFN16', 'top'], ['R1', '0402', 'bottom']]);
    expect(result.components[0].position.x).toBeCloseTo(25.4, 9); expect(result.components[0].position.y).toBeCloseTo(50.8, 9);
    expect(result.components[1].position.x).toBeCloseTo(-12.7, 9); expect(result.components[1].position.y).toBeCloseTo(MM(250.5), 9);
    expect(result.components.map(part => part.rotation)).toEqual([90, 270]);
    expect(result.pins).toHaveLength(4);
    const [u1p1, u1p2, r1p1, r1p2] = result.pins;
    expect(u1p1).toMatchObject({ number: '1', net: 'VCC', side: 'both', shape: 'rect', componentId: result.components[0].id });
    expect(u1p1.x).toBeCloseTo(MM(950), 9); expect(u1p1.y).toBeCloseTo(MM(2000), 9);
    expect(u1p1.width).toBeCloseTo(MM(60), 9); expect(u1p1.height).toBeCloseTo(MM(40), 9); expect(u1p1.radius).toBeCloseTo(MM(20), 9);
    expect(u1p2).toMatchObject({ number: '2', net: 'GND', side: 'top', shape: 'round', rotation: 45 });
    expect(r1p1).toMatchObject({ net: 'VCC', side: 'bottom', componentId: result.components[1].id }); expect(r1p1.shape).toBe('square');
    expect(r1p2).toMatchObject({ net: '', side: 'bottom' });
    expect(result.nets.map(net => [net.name, net.pinIds.length])).toEqual([['VCC', 2], ['GND', 1]]);
    expect(result.bounds).toEqual({ minX: 0, minY: 0, maxX: MM(3000), maxY: MM(2000) });
    expect(result.warnings.map(warning => warning.key)).not.toContain('parse.warning.missingBoardOutline');
    expect(messages(result)[0]).toMatch(/tracks, vias, copper pours/);
  });

  it('converts one internal unit to 2.54e-6 mm and keeps negative Y-up coordinates', () => {
    const result = board(pcbDoc({ pads: [{ name: '1', layer: 1, component: 0, x: -1, y: 10 * MIL, top: [MIL, MIL] }] }));
    expect(result.pins[0].x).toBeCloseTo(-2.54e-6, 15); expect(result.pins[0].y).toBeCloseTo(0.0254 * 10, 12); expect(result.pins[0].width).toBeCloseTo(0.0254, 12);
  });

  it('normalizes component and pad rotations, including Delphi scientific notation', () => {
    const result = board(pcbDoc({ components: [{ ...COMPONENTS[0], ROTATION: '9.00000000000000E+0001' }, { ...COMPONENTS[1], ROTATION: '450' }, { SOURCEDESIGNATOR: 'C1', LAYER: 'TOP', X: '0', Y: '0mil' }],
      pads: [{ component: 0, rotation: -30 }, { component: 0, rotation: 720.5, name: '2' }] }));
    expect(result.components.map(part => part.rotation)).toEqual([90, 90, 0]);
    expect(result.pins.map(pin => pin.rotation)).toEqual([330, 0.5]);
    for (const rotation of ['abc', '1,5', '1e999', '0x10']) failure(() => parse(pcbDoc({ components: [{ ...COMPONENTS[0], ROTATION: rotation }] })), 'INVALID_FORMAT');
    failure(() => parse(pcbDoc({ pads: [{ component: 0, rotation: Number.NaN }] })), 'INVALID_FORMAT');
    failure(() => parse(pcbDoc({ pads: [{ component: 0, rotation: Infinity }] })), 'INVALID_FORMAT');
  });

  it('accepts mil, mm and in suffixes, and rejects bare non-zero numbers and unknown suffixes', () => {
    const result = board(pcbDoc({ components: [{ ...COMPONENTS[0], X: '25.4mm', Y: '1in' }, { ...COMPONENTS[1], X: '1e2mil', Y: '+3.5MIL' }] }));
    expect(result.components[0].position).toEqual({ x: 25.4, y: 25.4 });
    expect(result.components[1].position.x).toBeCloseTo(2.54, 12); expect(result.components[1].position.y).toBeCloseTo(MM(3.5), 12);
    failure(() => parse(pcbDoc({ components: [{ ...COMPONENTS[0], X: '1000' }] })), 'UNSUPPORTED_VARIANT');
    for (const bad of ['1000cm', 'mil', '', '1 000mil', '1e999mil', '--5mil', '5mils']) failure(() => parse(pcbDoc({ components: [{ ...COMPONENTS[0], X: bad }] })), 'INVALID_FORMAT');
    failure(() => parse(pcbDoc({ components: [{ ...COMPONENTS[0], X: '1e300mm' }] })), 'INVALID_FORMAT');
    const { X: _x, ...withoutX } = COMPONENTS[0];
    expect(failure(() => parse(pcbDoc({ components: [withoutX] })), 'INVALID_FORMAT').message).toMatch(/X is missing/);
  });

  it('maps pad layers: Top 1, Bottom 32, Multi-Layer 74; other layers are an unsupported variant', () => {
    const sides = board(pcbDoc({ pads: [1, 32, 74].map((layer, index) => ({ name: String(index + 1), layer, component: 0 })) })).pins.map(pin => pin.side);
    expect(sides).toEqual(['top', 'bottom', 'both']);
    for (const layer of [0, 2, 31, 33, 57, 73, 75, 255]) expect(failure(() => parse(pcbDoc({ pads: [{ component: 0, layer }] })), 'UNSUPPORTED_VARIANT').message).toMatch(new RegExp(`layer id ${layer}`));
  });

  it('keeps the pad side independent of the component side', () => {
    const result = board(pcbDoc({ pads: [{ name: '1', layer: 32, component: 0 }, { name: '2', layer: 1, component: 1 }] }));
    expect([result.components[0].side, result.pins[0].side, result.components[1].side, result.pins[1].side]).toEqual(['top', 'bottom', 'bottom', 'top']);
  });

  it('component LAYER accepts TOP/BOTTOM only', () => {
    expect(board(pcbDoc({ components: [{ ...COMPONENTS[0], LAYER: 'top' }, { ...COMPONENTS[1], LAYER: 'Bottom' }] })).components.map(part => part.side)).toEqual(['top', 'bottom']);
    for (const layer of ['MULTILAYER', 'MID1', 'TOPOVERLAY', '1']) failure(() => parse(pcbDoc({ components: [{ ...COMPONENTS[0], LAYER: layer }] })), 'UNSUPPORTED_VARIANT');
    const { LAYER: _layer, ...withoutLayer } = COMPONENTS[0];
    failure(() => parse(pcbDoc({ components: [withoutLayer] })), 'INVALID_FORMAT');
  });

  it('rejects pads that reference a missing component or net instead of guessing', () => {
    expect(failure(() => parse(pcbDoc({ pads: [{ component: 2 }] })), 'INVALID_FORMAT').message).toMatch(/references component 2 of 2/);
    expect(failure(() => parse(pcbDoc({ pads: [{ component: 0, net: 2 }] })), 'INVALID_FORMAT').message).toMatch(/references net 2 of 2/);
    expect(failure(() => parse(pcbDoc({ pads: [{ component: 0, net: 0xfffd }] })), 'INVALID_FORMAT').message).toMatch(/references net 65533 of 2/);
    // The net index is validated even for free pads that are not imported.
    failure(() => parse(pcbDoc({ pads: [{ component: 0xffff, net: 7 }] })), 'INVALID_FORMAT');
    failure(() => parse(pcbDoc({ nets: [''], pads: [{ component: 0, net: 0 }] })), 'INVALID_FORMAT');
  });

  it('skips and discloses free pads (no component) and unnamed pads', () => {
    const result = board(pcbDoc({ pads: [{ name: '1', component: 0 }, { name: 'TP1', component: 0xffff, net: 0 }, { name: '', component: 0 }, { name: '', component: 0 }] }));
    expect(result.pins.map(pin => pin.number)).toEqual(['1', '#2', '#3']);
    expect(messages(result)).toEqual(expect.arrayContaining([expect.stringMatching(/1 free pads/), expect.stringMatching(/2 pads have an empty designator/)]));
    expect(result.nets).toEqual([]);
  });

  it('draws exact round/rectangle pads and discloses approximated shapes', () => {
    const result = board(pcbDoc({ pads: [
      { name: '1', component: 0, shape: 1, top: [40 * MIL, 40 * MIL] }, { name: '2', component: 0, shape: 1, top: [60 * MIL, 40 * MIL] }, { name: '3', component: 0, shape: 2, top: [40 * MIL, 40 * MIL] },
      { name: '4', component: 0, shape: 3, top: [40 * MIL, 40 * MIL] }, { name: '5', component: 0, shape: 9, top: [50 * MIL, 30 * MIL] },
    ] }));
    expect(result.pins.map(pin => pin.shape)).toEqual(['round', 'rect', 'square', 'square', 'rect']);
    expect(result.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 3 } });
    for (const shape of [0, 4, 5, 8, 10, 255]) expect(failure(() => parse(pcbDoc({ pads: [{ component: 0, shape }] })), 'UNSUPPORTED_VARIANT').message).toMatch(/shape code/);
  });

  it('sizes stacked pads from the layer they are drawn on and discloses differing multi-layer stacks', () => {
    const result = board(pcbDoc({ pads: [
      { name: '1', layer: 32, component: 0, mode: 1, top: [60 * MIL, 60 * MIL], bottom: [30 * MIL, 20 * MIL], shape: 2, bottomShape: 1 },
      { name: '2', layer: 74, component: 0, mode: 2, top: [60 * MIL, 60 * MIL], bottom: [30 * MIL, 20 * MIL] },
      { name: '3', layer: 74, component: 0, mode: 0, top: [60 * MIL, 60 * MIL], bottom: [30 * MIL, 20 * MIL] },
    ] }));
    expect(result.pins[0].width).toBeCloseTo(MM(30), 12); expect(result.pins[0].height).toBeCloseTo(MM(20), 12); expect(result.pins[0].shape).toBe('rect');
    expect(result.pins[1].width).toBeCloseTo(MM(60), 12);
    expect(messages(result)).toEqual(expect.arrayContaining([expect.stringMatching(/1 multi-layer pads have different top and bottom sizes/)]));
    expect(failure(() => parse(pcbDoc({ pads: [{ component: 0, mode: 3 }] })), 'UNSUPPORTED_VARIANT').message).toMatch(/pad mode 3/);
  });

  it('rejects non-positive pad sizes', () => {
    for (const top of [[0, 10 * MIL], [10 * MIL, 0], [-MIL, MIL]] as Array<[number, number]>) failure(() => parse(pcbDoc({ pads: [{ component: 0, top }] })), 'INVALID_FORMAT');
  });

  it('uses the Board6 outline; chords replace arcs with a disclosure; a repeated first vertex is dropped', () => {
    const closed = board(pcbDoc({ board: { ...BOARD, VX4: '0mil', VY4: '0mil', KIND4: '0' } }));
    expect(closed.outline).toHaveLength(4);
    const arcs = board(pcbDoc({ board: { ...BOARD, KIND1: '1', CX1: '2900mil', CY1: '100mil', R1: '100mil', SA1: '270', EA1: '360' } }));
    expect(arcs.outline).toHaveLength(4); expect(messages(arcs)).toContainEqual(expect.stringMatching(/1 board-outline arcs are drawn as straight chords/));
    const mm = board(pcbDoc({ board: { KIND: 'Protel_Advanced_PCB', VX0: '0mm', VY0: '0mm', VX1: '100mm', VY1: '0mm', VX2: '100mm', VY2: '50mm' } }));
    expect(mm.bounds).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
  });

  it('falls back to the pad extents when Board6 is missing, empty, too short or has fewer than three vertices', () => {
    for (const spec of [{ board: null }, { streams: { '/Board6/Data': new Uint8Array(0) } }, { board: { KIND: 'Protel_Advanced_PCB', VX0: '0mil', VY0: '0mil', VX1: '1mil', VY1: '0mil' } }, { board: { KIND: 'Protel_Advanced_PCB' } }] as Spec[]) {
      const result = board(pcbDoc(spec));
      expect(result.warnings.map(warning => warning.key)).toContain('parse.warning.missingBoardOutline');
      for (const pin of result.pins) { expect(result.bounds.minX).toBeLessThanOrEqual(pin.x - (pin.width ?? 0) / 2 + 1e-9); expect(result.bounds.maxX).toBeGreaterThanOrEqual(pin.x + (pin.width ?? 0) / 2 - 1e-9); }
    }
  });

  it('rejects malformed outlines instead of truncating them', () => {
    expect(failure(() => parse(pcbDoc({ board: { ...BOARD, VX5: '1mil', VY5: '1mil' } })), 'UNSUPPORTED_VARIANT').message).toMatch(/not contiguous/);
    expect(failure(() => parse(pcbDoc({ board: { ...BOARD, VY2: '' } })), 'INVALID_FORMAT').message).toMatch(/outline VY2 is missing/);
    failure(() => parse(pcbDoc({ board: { ...BOARD, VX0: '1000' } })), 'UNSUPPORTED_VARIANT');
    failure(() => parse(pcbDoc({ board: { ...BOARD, KIND2: 'x' } })), 'INVALID_FORMAT');
    const vertices: Record<string, string> = { KIND: 'Protel_Advanced_PCB' };
    for (let i = 0; i <= 20_000; i++) { vertices[`VX${i}`] = `${i}mil`; vertices[`VY${i}`] = `${i % 7}mil`; }
    failure(() => parse(pcbDoc({ board: vertices })), 'LIMIT_EXCEEDED');
  });

  it('discloses placeholder and repeated designators without dropping components', () => {
    const { SOURCEDESIGNATOR: _ref, ...unnamed } = COMPONENTS[0];
    const result = board(pcbDoc({ components: [unnamed, { ...COMPONENTS[1], SOURCEDESIGNATOR: 'R1' }, { ...COMPONENTS[1] }, { ...COMPONENTS[1], SOURCEDESIGNATOR: 'r1' }], pads: [{ component: 0 }] }));
    expect(result.components.map(part => part.ref)).toEqual(['#1', 'R1', 'R1', 'r1']);
    expect(messages(result)).toEqual(expect.arrayContaining([expect.stringMatching(/1 components carry no designator/), expect.stringMatching(/1 component designators occur more than once \(R1\)/)]));
  });

  it('rejects ambiguous text properties: %UTF8% twins and conflicting repeated keys', () => {
    failure(() => parse(pcbDoc({ components: [{ ...COMPONENTS[0], '%UTF8%SOURCEDESIGNATOR': 'Ü1' }] })), 'UNSUPPORTED_VARIANT');
    failure(() => parse(pcbDoc({ streams: { '/Nets6/Data': concat(textBlock('|NAME=GND|%UTF8%NAME=GÑD|'), textBlock({ NAME: 'VCC' })) } })), 'UNSUPPORTED_VARIANT');
    expect(failure(() => parse(pcbDoc({ streams: { '/Components6/Data': concat(textBlock(propText(COMPONENTS[0]) + 'X=5mil|'), textBlock(COMPONENTS[1])) } })), 'INVALID_FORMAT').message).toMatch(/X appears twice/);
    // The same value repeated is not a conflict, and unrelated duplicate keys are ignored.
    expect(board(pcbDoc({ streams: { '/Components6/Data': concat(textBlock(propText(COMPONENTS[0]) + 'X=1000mil|HEIGHT=1|HEIGHT=2|'), textBlock(COMPONENTS[1])) } })).components).toHaveLength(2);
  });

  it('rejects duplicate or missing net names and a net referenced with an empty name', () => {
    failure(() => parse(pcbDoc({ nets: ['GND', 'GND'] })), 'INVALID_FORMAT');
    failure(() => parse(pcbDoc({ streams: { '/Nets6/Data': concat(textBlock({ NAME: 'GND' }), textBlock({ X: '1' })) } })), 'INVALID_FORMAT');
    expect(board(pcbDoc({ nets: ['GND', '', 'VCC'], pads: [{ component: 0, net: 2 }] })).pins[0].net).toBe('VCC');
  });

  it('validates the Header record counts of every record stream', () => {
    for (const [path, count] of [['/Nets6/Header', 5], ['/Components6/Header', 1], ['/Pads6/Header', 9]] as const) {
      expect(failure(() => parse(pcbDoc({ streams: { [path]: Uint8Array.from(u32(count)) } })), 'INVALID_FORMAT').message).toMatch(new RegExp(`${path.slice(1, -7)}/Header declares ${count}`));
    }
    failure(() => parse(pcbDoc({ streams: { '/Pads6/Header': Uint8Array.from([4, 0]) } })), 'INVALID_FORMAT');
    expect(board(pcbDoc({ headers: false })).pins).toHaveLength(4);
  });

  it('names containers that are not a PcbDoc and requires the three record streams', () => {
    const other = container({ '/Foo/Data': Uint8Array.from([1, 2, 3]) });
    expect(failure(() => parse(other), 'UNSUPPORTED_VARIANT').message).toMatch(/not an Altium PCB document \(entries: .*Foo/);
    for (const path of ['/Nets6/Data', '/Components6/Data', '/Pads6/Data']) expect(failure(() => parse(pcbDoc({ streams: { [path]: null } })), 'UNSUPPORTED_VARIANT').message).toMatch(new RegExp(`missing the ${path.slice(1)} stream`));
    const header = (text: string) => concat([text.length + 1, 0, 0, 0, text.length], enc.encode(text));
    expect(failure(() => parse(container({ '/FileHeader': header('|HEADER=Protel for Windows - Schematic Capture Binary File Version 5.0') })), 'WRONG_KIND')).toMatchObject({ format: 'Altium SchDoc' });
    expect(failure(() => parse(container({ '/FileHeader': header('Protel for Windows - Schematic Library Editor Binary File Version 5.0'), '/Foo/Data': Uint8Array.from([1]) })), 'UNSUPPORTED_VARIANT')).toMatchObject({ format: 'Altium SchLib' });
    expect(failure(() => parse(container({ '/FileHeader': header('PCB 6.0 Binary Library File') })), 'UNSUPPORTED_VARIANT')).toMatchObject({ format: 'Altium PcbLib' });
    expect(failure(() => parse(container({ '/Library/Data': Uint8Array.from([1, 0, 0, 0, 0]) })), 'UNSUPPORTED_VARIANT')).toMatchObject({ format: 'Altium PcbLib' });
  });

  it('reads record streams larger than a mini-sector container (regular FAT chains)', () => {
    const result = board(pcbDoc({ pads: bigPads(400) }));
    expect(result.pins).toHaveLength(400); expect(result.pins[399].x).toBeCloseTo(MM(3990), 9);
  });

  it('follows DIFAT sectors in files with more than 109 FAT sectors', () => {
    const filler = new Uint8Array(8 * 1024 * 1024).fill(0x5a), data = pcbDoc({ streams: { '/Filler/Data': filler } });
    expect(u32at(data, 44)).toBeGreaterThan(109); expect(u32at(data, 72)).toBeGreaterThan(0);
    expect(board(data).pins).toHaveLength(4);
  });

  it('rejects framing damage with INVALID_FORMAT or UNSUPPORTED_VARIANT and never another exception', () => {
    const base = (pads: Uint8Array, extra: Record<string, Uint8Array | null> = {}) => pcbDoc({ headers: false, streams: { '/Pads6/Data': pads, ...extra } });
    const pad = padRecord({ component: 0 });
    expect(failure(() => parse(base(concat(pad, [3]))), 'UNSUPPORTED_VARIANT').message).toMatch(/record type 3/);
    expect(failure(() => parse(base(concat(pad, [2, 1, 0]))), 'INVALID_FORMAT').message).toMatch(/truncated/);
    expect(failure(() => parse(base(concat([2], block([9, 65])))), 'INVALID_FORMAT').message).toMatch(/Pascal string longer than its block/);
    expect(failure(() => parse(base(concat([2], u32(0x01000000 | 4), [4, 65, 66, 67]))), 'UNSUPPORTED_VARIANT').message).toMatch(/flag byte 0x1/);
    expect(failure(() => parse(base(concat([2], u32(5000), [1]))), 'INVALID_FORMAT').message).toMatch(/truncated \(block of 5000 bytes declared/);
    expect(failure(() => parse(base(padRecord({ component: 0, size: 109 }))), 'UNSUPPORTED_VARIANT').message).toMatch(/109 bytes; the documented layout needs 110/);
    expect(failure(() => parse(base(padRecord({ component: 0, size: 20 }))), 'UNSUPPORTED_VARIANT').message).toMatch(/needs 110/);
    // A pad whose sub-record 6 is missing is truncated, not silently accepted.
    expect(failure(() => parse(base(pad.subarray(0, pad.length - 4))), 'INVALID_FORMAT').message).toMatch(/truncated/);
    expect(failure(() => parse(base(pad, { '/Components6/Data': concat(textBlock(COMPONENTS[0]), [9, 0, 0, 0, 65]) })), 'INVALID_FORMAT').message).toMatch(/Components6 stream is truncated/);
    expect(failure(() => parse(base(pad, { '/Nets6/Data': Uint8Array.from([1, 0]) })), 'INVALID_FORMAT').message).toMatch(/Nets6 stream is truncated/);
    expect(failure(() => parse(base(pad, { '/Board6/Data': Uint8Array.from([7, 0, 0, 0, 1]) })), 'INVALID_FORMAT').message).toMatch(/Board6 stream is truncated/);
  });

  it('every truncation of a pad stream is either a shorter valid board or a BoardFormatError', () => {
    const pads = concat(...PADS.map(pad => padRecord(pad)));
    let accepted = 0;
    for (let length = 1; length < pads.length; length++) {
      try { board(pcbDoc({ headers: false, streams: { '/Pads6/Data': pads.subarray(0, length) } })); accepted++; }
      catch (caught) { expect(caught).toBeInstanceOf(BoardFormatError); expect(ALLOWED).toContain((caught as BoardFormatError).code); }
    }
    expect(accepted).toBeLessThanOrEqual(PADS.length); // only exact record boundaries (and an empty tail) can parse
    failure(() => parse(pcbDoc({ pads: PADS, streams: { '/Pads6/Data': pads.subarray(0, pads.length - 30) } })));
  });

  it('survives randomly damaged record streams without throwing anything but BoardFormatError', () => {
    const random = prng(0xa17);
    const sources = [concat(...PADS.map(pad => padRecord(pad))), concat(...COMPONENTS.map(record => textBlock(record))), textBlock(BOARD)];
    const paths = ['/Pads6/Data', '/Components6/Data', '/Board6/Data'];
    let boards = 0, errors = 0;
    for (let round = 0; round < 600; round++) {
      const which = round % 3, damaged = sources[which].slice();
      for (let hit = 0; hit < 1 + Math.floor(random() * 4); hit++) damaged[Math.floor(random() * damaged.length)] = Math.floor(random() * 256);
      try { board(pcbDoc({ headers: false, streams: { [paths[which]]: damaged } })); boards++; }
      catch (caught) { expect(caught).toBeInstanceOf(BoardFormatError); expect(ALLOWED).toContain((caught as BoardFormatError).code); errors++; }
    }
    expect(errors).toBeGreaterThan(50); expect(boards).toBeGreaterThan(0);
  });

  it('rejects hostile compound-file structure: bad header, reserved values, loops and out-of-file links', () => {
    const valid = pcbDoc({ pads: bigPads(400) });
    const mutate = (change: (data: Uint8Array) => void) => { const copy = valid.slice(); change(copy); return copy; };
    const code = (data: Uint8Array, expected: FormatErrorCode) => failure(() => parse(data), expected);
    expect(code(mutate(data => { data[28] = 0; }), 'INVALID_FORMAT').message).toMatch(/byte-order/);
    expect(code(mutate(data => { data[30] = 12; data[26] = 4; }), 'UNSUPPORTED_VARIANT').message).toMatch(/version 4/);
    expect(code(mutate(data => { data[30] = 10; }), 'INVALID_FORMAT').message).toMatch(/unsupported layout/);
    expect(code(mutate(data => { data[32] = 7; }), 'INVALID_FORMAT').message).toMatch(/unsupported layout/);
    expect(code(mutate(data => setU32(data, 56, 8192)), 'INVALID_FORMAT').message).toMatch(/unsupported layout/);
    expect(code(mutate(data => setU32(data, 44, 0xffffffff)), 'INVALID_FORMAT').message).toMatch(/declares 4294967295 FAT/);
    expect(code(mutate(data => setU32(data, 44, 0)), 'INVALID_FORMAT').message).toMatch(/declares 0 FAT/);
    expect(code(mutate(data => setU32(data, 72, 0x7fffffff)), 'INVALID_FORMAT').message).toMatch(/DIFAT/);
    expect(code(mutate(data => setU32(data, 44, 2)), 'INVALID_FORMAT').message).toMatch(/reserved id|outside the file|fewer FAT/);
    expect(code(mutate(data => setU32(data, 76, 0xfffffffe)), 'INVALID_FORMAT').message).toMatch(/outside the file/);
    expect(code(mutate(data => setU32(data, 48, 0xfffffffe)), 'INVALID_FORMAT').message).toMatch(/no directory/);
    expect(code(mutate(data => setU32(data, 48, 9999)), 'INVALID_FORMAT').message).toMatch(/leaves the file/);
    expect(code(mutate(data => { const first = u32at(data, 48); setU32(data, fatAt(data, first), first); }), 'INVALID_FORMAT').message).toMatch(/looping directory chain/);
    expect(code(valid.subarray(0, 700), 'INVALID_FORMAT').message).toMatch(/outside the file|fewer FAT|declares/);
    expect(code(valid.subarray(0, 511), 'INVALID_FORMAT').message).toMatch(/shorter than its 512-byte header/);
    expect(code(valid.subarray(0, valid.length - 700), 'INVALID_FORMAT').message).toMatch(/outside the file|ends after/);
  });

  it('rejects stream chains that loop, end early or claim more data than the file holds', () => {
    const valid = pcbDoc({ pads: bigPads(400) });
    let at = -1; // the directory entry of the regular-FAT stream (Pads6/Data, over 20 kB)
    for (let sector = u32at(valid, 48); sector < 0xfffffff0; sector = u32at(valid, fatAt(valid, sector))) for (let offset = sectorAt(sector); offset < sectorAt(sector) + 512; offset += 128) if (valid[offset + 66] === 2 && u32at(valid, offset + 120) > 20_000) at = offset;
    expect(at).toBeGreaterThan(0);
    const first = u32at(valid, at + 116), mutate = (change: (data: Uint8Array) => void) => { const copy = valid.slice(); change(copy); return copy; };
    expect(failure(() => parse(mutate(data => setU32(data, fatAt(data, first), first))), 'INVALID_FORMAT').message).toMatch(/loops back to sector/);
    expect(failure(() => parse(mutate(data => setU32(data, fatAt(data, first), 0xfffffffe))), 'INVALID_FORMAT').message).toMatch(/ends after 1 of \d+ sectors/);
    expect(failure(() => parse(mutate(data => setU32(data, fatAt(data, first), 0xffffffff))), 'INVALID_FORMAT').message).toMatch(/ends after 1 of/);
    expect(failure(() => parse(mutate(data => setU32(data, at + 120, valid.length + 4000))), 'INVALID_FORMAT').message).toMatch(/needs \d+ sectors|claims/);
    expect(failure(() => parse(mutate(data => setU32(data, at + 120, 0x7fffffff))), 'LIMIT_EXCEEDED').message).toMatch(/extraction budget/);
    expect(failure(() => parse(mutate(data => setU32(data, at + 116, 0x00ffffff))), 'INVALID_FORMAT').message).toMatch(/ends after 0 of/);
  });

  it('rejects mini-stream chains that loop or leave the mini FAT', () => {
    const valid = pcbDoc({ components: COMPONENTS.map(record => ({ ...record, PATTERN: 'P'.repeat(300) })), headers: false });
    let victim = -1;
    for (let sector = u32at(valid, 48); sector < 0xfffffff0; sector = u32at(valid, fatAt(valid, sector))) for (let offset = sectorAt(sector); offset < sectorAt(sector) + 512; offset += 128) {
      const size = u32at(valid, offset + 120);
      if (valid[offset + 66] === 2 && size > 600 && size < 4096 && String.fromCharCode(valid[offset]) === 'D') victim = offset;
    }
    expect(victim).toBeGreaterThan(0);
    const start = u32at(valid, victim + 116), miniFat = sectorAt(u32at(valid, 60));
    const loop = valid.slice(); setU32(loop, miniFat + start * 4, start);
    expect(failure(() => parse(loop), 'INVALID_FORMAT').message).toMatch(/invalid mini-sector chain/);
    const lost = valid.slice(); setU32(lost, miniFat + start * 4, 0xfffffffe);
    expect(failure(() => parse(lost), 'INVALID_FORMAT').message).toMatch(/invalid mini-sector chain/);
    const outside = valid.slice(); setU32(outside, victim + 116, 0x7fffff);
    expect(failure(() => parse(outside), 'INVALID_FORMAT').message).toMatch(/invalid mini-sector chain/);
    const huge = valid.slice(); setU32(huge, victim + 120, 4000);
    failure(() => parse(huge));
  });

  it('rejects directory trees that revisit entries, link to free entries or use the root as a child', () => {
    const valid = pcbDoc();
    const stream = entryOf(valid, 'Data');
    const sibling = valid.slice(); setU32(sibling, stream + 68, 0); // left sibling = root
    expect(failure(() => parse(sibling), 'INVALID_FORMAT').message).toMatch(/type 5|linked twice/);
    const self = valid.slice(); const index = (stream - sectorAt(u32at(valid, 48))) / 128; setU32(self, stream + 72, index);
    expect(failure(() => parse(self), 'INVALID_FORMAT').message).toMatch(/linked twice|two entries/);
    const rootless = valid.slice(); rootless[sectorAt(u32at(valid, 48)) + 66] = 1;
    expect(failure(() => parse(rootless), 'INVALID_FORMAT').message).toMatch(/no root entry/);
    const kind = valid.slice(); kind[stream + 66] = 9;
    expect(failure(() => parse(kind), 'INVALID_FORMAT').message).toMatch(/unknown type 9/);
    const name = valid.slice(); name[stream + 64] = 1;
    expect(failure(() => parse(name), 'INVALID_FORMAT').message).toMatch(/invalid name length/);
    const outside = valid.slice(); setU32(outside, stream + 76, 100000); outside[stream + 66] = 1;
    expect(failure(() => parse(outside), 'INVALID_FORMAT').message).toMatch(/outside the directory/);
  });

  it('bounds storage nesting and the number of directory entries', () => {
    const deep = pcbDoc({ streams: { '/a/b/c/d/e/f/g/h/i/Data': Uint8Array.from([1]) } });
    expect(failure(() => parse(deep), 'LIMIT_EXCEEDED').message).toMatch(/deeper than 8 levels/);
    expect(board(pcbDoc({ streams: { '/a/b/c/d/e/f/g/Data': Uint8Array.from([1]) } })).pins).toHaveLength(4);
    const streams = streamsOf();
    for (let index = 0; index < 100_100; index++) streams[`/Models/${index.toString(36)}`] = Uint8Array.from([index & 255]);
    expect(failure(() => parse(container(streams, true)), 'LIMIT_EXCEEDED').message).toMatch(/more than 100000 directory entries/);
  });

  it('limits records per stream and the size of one text record', () => {
    const tiny = textBlock('|X=0|');
    const many = concat(...Array.from({ length: 65_535 }, () => tiny));
    expect(failure(() => parse(pcbDoc({ streams: { '/Components6/Data': many } })), 'LIMIT_EXCEEDED').message).toMatch(/Components6 record count/);
    expect(failure(() => parse(pcbDoc({ streams: { '/Nets6/Data': many } })), 'LIMIT_EXCEEDED').message).toMatch(/Nets6 record count/);
    const huge = textBlock(`|SOURCEDESIGNATOR=${'U'.repeat((1 << 20) + 16)}|`);
    expect(failure(() => parse(pcbDoc({ streams: { '/Components6/Data': huge } })), 'LIMIT_EXCEEDED').message).toMatch(/over the 1048576 byte limit/);
  });

  it('survives randomly damaged container bytes (header, FAT and directory) without hanging or throwing foreign errors', () => {
    const valid = pcbDoc({ pads: bigPads(60) }), random = prng(0xc0ffee), started = Date.now();
    let boards = 0, errors = 0;
    for (let round = 0; round < 800; round++) {
      const damaged = valid.slice(), span = round % 2 ? 1536 : damaged.length;
      for (let hit = 0; hit < 1 + Math.floor(random() * 5); hit++) damaged[Math.floor(random() * span)] = random() < 0.4 ? 0xff : Math.floor(random() * 256);
      try { parse(damaged); boards++; }
      catch (caught) { expect(caught).toBeInstanceOf(BoardFormatError); expect(ALLOWED).toContain((caught as BoardFormatError).code); errors++; }
    }
    expect(errors).toBeGreaterThan(100); expect(boards + errors).toBe(800); expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('turns an unexpected internal failure into a BoardFormatError', () => {
    expect(failure(() => parseAltium({ name: 'x.PcbDoc', data: undefined as unknown as Uint8Array }), 'INVALID_FORMAT').message).toMatch(/failed unexpectedly/);
  });
});

// --- ASCII variant ---------------------------------------------------------------------------------------------------------------
const ASCII_LINES = [
  '|RECORD=Board|FILENAME=synthetic.PcbDoc|KIND=Protel_Advanced_PCB|VERSION=5.01|VX0=0mil|VY0=0mil|KIND0=0|VX1=3000mil|VY1=0mil|KIND1=0|VX2=3000mil|VY2=2000mil|KIND2=0|VX3=0mil|VY3=2000mil|KIND3=0',
  '|RECORD=Net|NAME=GND', '|RECORD=Net|NAME=VCC',
  '|RECORD=Component|LAYER=TOP|X=1000mil|Y=2000mil|ROTATION=90.000|PATTERN=QFN16|SOURCEDESIGNATOR=U1',
  '|RECORD=Component|LAYER=BOTTOM|X=-500mil|Y=250.5mil|ROTATION=-90|PATTERN=0402|SOURCEDESIGNATOR=R1',
  '|RECORD=Pad|NAME=1|COMPONENT=0|NET=1|LAYER=MULTILAYER|X=950mil|Y=2000mil|XSIZE=60mil|YSIZE=40mil|SHAPE=RECTANGLE|ROTATION=0',
  '|RECORD=Pad|NAME=2|COMPONENT=0|NET=0|LAYER=TOP|X=1050mil|Y=2000mil|XSIZE=50mil|YSIZE=50mil|SHAPE=ROUND|ROTATION=45',
  '|RECORD=Pad|NAME=1|COMPONENT=1|NET=1|LAYER=BOTTOM|X=-520mil|Y=250mil|XSIZE=30mil|YSIZE=30mil|SHAPE=RECTANGLE',
  '|RECORD=Pad|NAME=2|COMPONENT=1|NET=-1|LAYER=BOTTOM|X=-480mil|Y=250mil|XSIZE=30mil|YSIZE=30mil|SHAPE=RECTANGLE',
  '|RECORD=Track|LAYER=TOP|X1=0mil|Y1=0mil|X2=10mil|Y2=0mil|WIDTH=8mil',
];
const asciiDoc = (replace: (lines: string[]) => string[] = lines => lines) => replace([...ASCII_LINES]).join('\r\n') + '\r\n';
const withLine = (index: number, line: string | null) => (lines: string[]) => { if (line === null) lines.splice(index, 1); else lines[index] = line; return lines; };

describe('parseAltium ASCII PcbDoc (|RECORD= lines)', () => {
  it('imports the same board as the binary variant from mil-suffixed records', () => {
    const result = parseText(asciiDoc()) as Board;
    expect(result.format).toBe(ALTIUM_ASCII); expect(result.name).toBe('synthetic');
    expect(result.components.map(part => [part.ref, part.package, part.side, part.rotation])).toEqual([['U1', 'QFN16', 'top', 90], ['R1', '0402', 'bottom', 270]]);
    expect(result.components[0].position.x).toBeCloseTo(25.4, 9);
    expect(result.pins.map(pin => [pin.number, pin.net, pin.side, pin.shape])).toEqual([['1', 'VCC', 'both', 'rect'], ['2', 'GND', 'top', 'round'], ['1', 'VCC', 'bottom', 'square'], ['2', '', 'bottom', 'square']]);
    expect(result.pins[0].width).toBeCloseTo(MM(60), 9); expect(result.pins[1].rotation).toBe(45);
    expect(result.nets.map(net => [net.name, net.pinIds.length])).toEqual([['VCC', 2], ['GND', 1]]);
    expect(result.bounds).toEqual({ minX: 0, minY: 0, maxX: MM(3000), maxY: MM(2000) });
    expect(messages(result)[0]).toMatch(/not imported/);
  });

  it('accepts LF, a UTF-8 BOM, UTF-16 with a BOM, a |HEADER= preamble and blank lines', () => {
    const lf = ASCII_LINES.join('\n');
    expect(parseText(lf)!.components).toHaveLength(2);
    expect(parseText('﻿' + lf)!.components).toHaveLength(2);
    expect(parseText(`|HEADER=Protel for Windows - PCB 6.0 Ascii File\n\n${lf}\n\n`)!.components).toHaveLength(2);
    const utf16 = new Uint8Array(2 + lf.length * 2); utf16[0] = 0xff; utf16[1] = 0xfe;
    for (let i = 0; i < lf.length; i++) { utf16[2 + i * 2] = lf.charCodeAt(i) & 255; utf16[3 + i * 2] = lf.charCodeAt(i) >> 8; }
    expect(parse(utf16)!.components).toHaveLength(2);
  });

  it('applies unit suffixes and refuses bare numbers', () => {
    const result = parseText(asciiDoc(withLine(3, '|RECORD=Component|LAYER=TOP|X=25.4mm|Y=1in|ROTATION=0|SOURCEDESIGNATOR=U1'))) as Board;
    expect(result.components[0].position).toEqual({ x: 25.4, y: 25.4 });
    failure(() => parseText(asciiDoc(withLine(3, '|RECORD=Component|LAYER=TOP|X=1000|Y=0|SOURCEDESIGNATOR=U1'))), 'UNSUPPORTED_VARIANT');
    expect((parseText(asciiDoc(withLine(3, '|RECORD=Component|LAYER=TOP|X=0|Y=0.0|SOURCEDESIGNATOR=U1'))) as Board).components[0].position).toEqual({ x: 0, y: 0 });
    failure(() => parseText(asciiDoc(withLine(5, '|RECORD=Pad|NAME=1|COMPONENT=0|LAYER=TOP|X=0mil|Y=0mil|XSIZE=60|YSIZE=40mil|SHAPE=RECTANGLE'))), 'UNSUPPORTED_VARIANT');
  });

  it('validates sides, shapes, references and free pads like the binary variant', () => {
    const base: Record<string, string> = { NAME: '1', COMPONENT: '0', NET: '0', LAYER: 'TOP', X: '0mil', Y: '0mil', XSIZE: '60mil', YSIZE: '40mil', SHAPE: 'RECTANGLE' };
    const pad = (changes: Record<string, string>) => '|RECORD=Pad' + propText({ ...base, ...changes });
    const doc = (line: string) => asciiDoc(withLine(5, line));
    failure(() => parseText(doc(pad({ LAYER: 'MID1' }))), 'UNSUPPORTED_VARIANT');
    expect(failure(() => parseText(doc(pad({ COMPONENT: '9' }))), 'INVALID_FORMAT').message).toMatch(/COMPONENT index 9 is out of range \(2 records\)/);
    expect(failure(() => parseText(doc(pad({ NET: '5' }))), 'INVALID_FORMAT').message).toMatch(/NET index 5/);
    failure(() => parseText(doc(pad({ NET: '0x1' }))), 'INVALID_FORMAT');
    failure(() => parseText(doc(pad({ COMPONENT: '1.5' }))), 'INVALID_FORMAT');
    failure(() => parseText(doc(pad({ SHAPE: 'STAR' }))), 'UNSUPPORTED_VARIANT');
    failure(() => parseText(doc(pad({ XSIZE: '0mil' }))), 'INVALID_FORMAT');
    expect(failure(() => parseText(doc('|RECORD=Pad|NAME=1|COMPONENT=0|LAYER=TOP|X=0mil|Y=0mil|TOPXSIZE=60mil|TOPYSIZE=40mil')), 'UNSUPPORTED_VARIANT').message).toMatch(/lacks XSIZE, YSIZE/);
    const free = parseText(doc(pad({ COMPONENT: '-1' }))) as Board;
    expect(free.pins).toHaveLength(3); expect(messages(free)).toContainEqual(expect.stringMatching(/1 free pads/));
    expect((parseText(doc(pad({ SHAPE: 'OCTAGONAL' }))) as Board).warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 1 } });
    expect((parseText(doc(pad({ SHAPE: '1', XSIZE: '10mil', YSIZE: '10mil' }))) as Board).pins[0].shape).toBe('round');
  });

  it('requires exactly one Board record of KIND=Protel_Advanced_PCB', () => {
    failure(() => parseText(asciiDoc(withLine(0, null))), 'UNSUPPORTED_VARIANT');
    expect(failure(() => parseText(asciiDoc(withLine(0, '|RECORD=Board|KIND=Other'))), 'UNSUPPORTED_VARIANT').message).toMatch(/KIND=Other/);
    failure(() => parseText(asciiDoc(withLine(0, '|RECORD=Board|VX0=0mil'))), 'UNSUPPORTED_VARIANT');
    failure(() => parseText(asciiDoc(lines => [...lines, lines[0]])), 'UNSUPPORTED_VARIANT');
    expect((parseText(asciiDoc(withLine(0, '|RECORD=Board|KIND=PROTEL_ADVANCED_PCB'))) as Board).warnings.map(warning => warning.key)).toContain('parse.warning.missingBoardOutline');
  });

  it('names schematic ASCII documents and rejects non-record lines', () => {
    expect(failure(() => parseText('|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=3\n|RECORD=1|LIBREFERENCE=x\n'), 'WRONG_KIND')).toMatchObject({ format: 'Altium SchDoc' });
    expect(failure(() => parseText('|RECORD=31|FONTIDCOUNT=1\n|RECORD=1|X=0\n'), 'WRONG_KIND')).toMatchObject({ format: 'Altium SchDoc' });
    expect(failure(() => parseText(asciiDoc(lines => [...lines, 'garbage line'])), 'INVALID_FORMAT').message).toMatch(/line 11 is not a \|RECORD= record/);
    expect(failure(() => parseText(asciiDoc(lines => [...lines, '|NAME=x|RECORD=Pad'])), 'INVALID_FORMAT').message).toMatch(/not a \|RECORD= record/);
  });

  it('rejects ambiguous ASCII fields like the binary text records', () => {
    failure(() => parseText(asciiDoc(withLine(1, '|RECORD=Net|NAME=GND|%UTF8%NAME=GÑD'))), 'UNSUPPORTED_VARIANT');
    failure(() => parseText(asciiDoc(withLine(1, '|RECORD=Net|NAME=GND|NAME=OTHER'))), 'INVALID_FORMAT');
    failure(() => parseText(asciiDoc(withLine(1, '|RECORD=Net|NAME='))), 'INVALID_FORMAT');
    failure(() => parseText(asciiDoc(withLine(2, '|RECORD=Net|NAME=GND'))), 'INVALID_FORMAT');
    failure(() => parseText(asciiDoc(withLine(3, '|RECORD=Component|LAYER=TOP|X=0mil|Y=0mil|ROTATION=x|SOURCEDESIGNATOR=U1'))), 'INVALID_FORMAT');
  });

  it('applies record, line and component budgets', () => {
    const manyRecords = ASCII_LINES[0] + '\n' + '|RECORD=T\n'.repeat(1_500_000);
    expect(failure(() => parseText(manyRecords), 'LIMIT_EXCEEDED').message).toMatch(/record count/);
    const manyComponents = ASCII_LINES[0] + '\n' + '|RECORD=Component\n'.repeat(250_001);
    expect(failure(() => parseText(manyComponents), 'LIMIT_EXCEEDED').message).toMatch(/component count/);
    const manyNets = ASCII_LINES[0] + '\n' + Array.from({ length: 250_001 }, (_, index) => `|RECORD=Net|NAME=n${index}`).join('\n');
    expect(failure(() => parseText(manyNets), 'LIMIT_EXCEEDED').message).toMatch(/net count/);
    expect(failure(() => parseText(ASCII_LINES[0] + '|X=' + 'a'.repeat((4 << 20) + 1) + '\n'), 'LIMIT_EXCEEDED').message).toMatch(/line 1 is longer/);
  });

  it('survives randomly damaged ASCII text without throwing anything but BoardFormatError', () => {
    const random = prng(0xbeef), source = asciiDoc();
    let errors = 0;
    for (let round = 0; round < 500; round++) {
      const chars = source.split('');
      for (let hit = 0; hit < 1 + Math.floor(random() * 4); hit++) chars[Math.floor(random() * chars.length)] = String.fromCharCode(32 + Math.floor(random() * 95));
      try { parseText(chars.join('')); } catch (caught) { expect(caught).toBeInstanceOf(BoardFormatError); expect(ALLOWED).toContain((caught as BoardFormatError).code); errors++; }
    }
    expect(errors).toBeGreaterThan(50);
  });
});

describe('parseAltium recognition', () => {
  const GENCAD = '$HEADER\nGENCAD 1.4\nUNITS INCH\n$ENDHEADER\n$SIGNALS\n$ENDSIGNALS\n';
  const KICAD = '(kicad_pcb (version 20221018) (generator pcbnew)\n  (general (thickness 1.6))\n)\n';
  const EAGLE = '<?xml version="1.0"?>\n<!DOCTYPE eagle SYSTEM "eagle.dtd">\n<eagle version="9.6.2"><drawing><board/></drawing></eagle>\n';
  it('returns null for everything that is not an Altium PCB, however it is named', () => {
    const noise = Uint8Array.from({ length: 4096 }, (_, index) => (index * 131 + 17) & 255);
    for (const [name, data] of [['empty', new Uint8Array(0)], ['one byte', Uint8Array.from([0x7c])], ['gencad', enc.encode(GENCAD)], ['kicad', enc.encode(KICAD)], ['eagle', enc.encode(EAGLE)], ['plain', enc.encode('hello world\n')],
      ['pipe text', enc.encode('| not a record |\n')], ['noise', noise], ['almost magic', Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a])], ['pdf', enc.encode('%PDF-1.7\n')], ['utf16 other', Uint8Array.from([0xff, 0xfe, 0x41, 0])]] as const) {
      expect(parse(data, 'board.PcbDoc'), name).toBeNull();
    }
  });
  it('treats a compound-file magic as a PcbDoc attempt and fails clearly when it is not one', () => {
    failure(() => parse(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'INVALID_FORMAT');
    failure(() => parse(concat([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], new Uint8Array(600))), 'INVALID_FORMAT');
  });
  it('recognizes by content: the same bytes parse under any file name', () => {
    expect(parse(pcbDoc(), 'renamed.bin')).not.toBeNull();
    expect(parseText(asciiDoc(), 'renamed.txt')).not.toBeNull();
  });
});
