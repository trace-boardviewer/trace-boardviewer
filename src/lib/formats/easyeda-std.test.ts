import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Board } from '../types';
import { BoardFormatError, textInput, type FormatErrorCode } from './common';
import { EASYEDA_STD_INFO, parseEasyedaStd, sniffEasyedaStd } from './easyeda-std';
import { catching, expectScaling } from '../../test-support/timing';

// Every document here is an original synthetic one modelled on the vendor examples (docs.easyeda.com "EasyEDA File Format"); units are 10 mil.
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/easyeda/${name}`, import.meta.url))));
const encode = (text: string) => new TextEncoder().encode(text);
const parse = (data: Uint8Array | string, name = 'board.json'): Board => {
  const result = parseEasyedaStd(typeof data === 'string' ? textInput(data, name) : { name, data });
  if (!result) throw new Error('unexpectedly unrecognized');
  return result;
};
const failure = (work: () => unknown): BoardFormatError => {
  try { work(); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
};
const expectFailure = (work: () => unknown, code: FormatErrorCode, pattern?: RegExp) => {
  const error = failure(work);
  expect(error.code).toBe(code);
  if (pattern) expect(error.message).toMatch(pattern);
};
const notes = (board: Board): string[] => board.warnings.filter(w => w.key === 'parse.warning.formatNote').map(w => String(w.params?.message));

// --- builders ---------------------------------------------------------------------------------------------------------------------------------
const CANVAS = 'CA~1000~1000~#000000~yes~#FFFFFF~10~1200~1200~line~1~mil~1~45~visible~0.5~400~300';
const document = (shapes: unknown[], extra: Record<string, unknown> = {}, head: Record<string, unknown> = { docType: '3' }) => JSON.stringify({ head, canvas: CANVAS, shape: shapes, ...extra });
const track = (layer: number, points: string, width = 1, net = '') => `TRACK~${width}~${layer}~${net}~${points}~g1`;
const box = (x0: number, y0: number, x1: number, y1: number, layer = 10) => [track(layer, `${x0} ${y0} ${x1} ${y0}`), track(layer, `${x1} ${y0} ${x1} ${y1}`), track(layer, `${x1} ${y1} ${x0} ${y1}`), track(layer, `${x0} ${y1} ${x0} ${y0}`)];
const pad = (shape: string, x: number, y: number, w: number, h: number, layer: number, net: string, number: string, points = '', rotation = 0) =>
  ['PAD', shape, x, y, w, h, layer, net, number, '0', points, rotation, 'g2', '0', '', 'Y', '0'].join('~');
const designator = (text: string, layer = 3) => `TEXT~P~0~0~0.7~0~~${layer}~~4.5~${text}~M 0 0 L 1 1~~g3`;
const lib = (x: number, y: number, attrs: string, rotation: number, children: string[]) => `${['LIB', x, y, attrs, rotation, '', 'g4', '0'].join('~')}${children.map(child => `#@$${child}`).join('')}`;
const resistor = (x = 200, y = 200, rotation = 0, layer = 1, name = 'R1') => lib(x, y, 'package`R0603`value`10k`', rotation, [designator(name, layer === 2 ? 4 : 3), pad('RECT', x - 5, y, 3, 3, layer, 'A', '1'), pad('RECT', x + 5, y, 3, 3, layer, 'B', '2')]);

describe('EasyEDA Standard: recognition', () => {
  it('recognizes the shape-array PCB document with a CA~ canvas at 0.95', () => {
    expect(sniffEasyedaStd(fixture('std-board.json'), 'board.json')).toMatchObject({ id: 'easyeda-std', variant: 'shape-array', kind: 'pcb', confidence: 0.95 });
  });
  it('lowers the confidence without a canvas and when the head is the "3~version~..." text form', () => {
    expect(sniffEasyedaStd(encode(JSON.stringify({ head: { docType: '3' }, shape: [track(10, '1 1 2 2')] })))).toMatchObject({ kind: 'pcb', confidence: 0.85 });
    expect(sniffEasyedaStd(encode(JSON.stringify({ head: '3~1.7.5~1', canvas: CANVAS, shape: [track(10, '1 1 2 2')] })))).toMatchObject({ kind: 'pcb', confidence: 0.95 });
    expect(sniffEasyedaStd(encode(document([])))).toMatchObject({ kind: 'pcb' });
  });
  it('recognizes the object-model layout (0.6) and a document escaped inside a "dataStr" text (0.6)', () => {
    expect(sniffEasyedaStd(fixture('std-object-model.json'))).toMatchObject({ variant: 'object-model', kind: 'pcb', confidence: 0.6 });
    const wrapped = JSON.stringify({ success: true, result: { dataStr: document([track(10, '1 1 2 2')]) } });
    expect(sniffEasyedaStd(encode(wrapped))).toMatchObject({ variant: 'wrapped-text', kind: 'pcb', confidence: 0.6 });
  });
  it('reports the document kind so a caller can route schematics and footprints', () => {
    expect(sniffEasyedaStd(encode(JSON.stringify({ head: { docType: '1' }, canvas: 'CA~1000', shape: ['W~1 1 2 2~#000~1~0~none~g1'] })))).toMatchObject({ kind: 'schematic' });
    expect(sniffEasyedaStd(encode(JSON.stringify({ head: { docType: '4' }, canvas: CANVAS, shape: [pad('RECT', 1, 1, 1, 1, 1, '', '1')] })))).toMatchObject({ kind: 'footprint' });
  });
  it('tolerates a byte-order mark and leading white space', () => {
    const body = encode(document([track(10, '1 1 2 2')]));
    const data = new Uint8Array(body.length + 7); data.set([0xef, 0xbb, 0xbf, 0x20, 0x0a, 0x09, 0x20]); data.set(body, 7);
    expect(sniffEasyedaStd(data)?.confidence).toBe(0.95);
  });
  it('returns null for everything else', () => {
    for (const text of ['', '   ', '{}', '[]', '{"name":"x","version":"1.0.0"}', '{"head":{"docType":"3"}}', '{"head":{"docType":"3"},"shape":[["a"]]}', '{"head":{"docType":"3"},"shape":["WIRE~1~2"]}',
      '(kicad_pcb (version 20240108))', '["DOCTYPE","PCB","1.8"]', '{"PAD":{}}', '{"TRACK":{},"PAD":{}}', 'not json at all']) expect(sniffEasyedaStd(encode(text)), text).toBeNull();
    expect(sniffEasyedaStd(new Uint8Array(0))).toBeNull();
    expect(sniffEasyedaStd(new Uint8Array([0xff, 0xfe, 0x00, 0x80]))).toBeNull();
  });
  it('never reads more than the first 64 KiB', () => {
    const filler = ' '.repeat(70_000), data = encode(`{"head":{"docType":"3"},"x":"${filler}","canvas":"${CANVAS}","shape":["TRACK~1~10"]}`);
    expect(sniffEasyedaStd(data)).toBeNull();
  });
  it('parseEasyedaStd returns null for schematics, other JSON and non-JSON, and rejects a footprint document as the wrong kind', () => {
    expect(parseEasyedaStd(textInput(JSON.stringify({ head: { docType: '1' }, canvas: 'CA~1', shape: ['W~1 1 2 2~#000~1~0~none~g1'] })))).toBeNull();
    expect(parseEasyedaStd(textInput('{"hello":"world"}'))).toBeNull();
    expect(parseEasyedaStd(textInput('(kicad_pcb)'))).toBeNull();
    expect(parseEasyedaStd(textInput(''))).toBeNull();
    expectFailure(() => parseEasyedaStd(textInput(JSON.stringify({ head: { docType: '4' }, canvas: CANVAS, shape: [pad('RECT', 1, 1, 1, 1, 1, '', '1')] }))), 'WRONG_KIND', /footprint/);
  });
  it('declares its registry facts', () => {
    expect(EASYEDA_STD_INFO).toMatchObject({ id: 'easyeda-std', status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', extensions: ['.json'] });
    expect(EASYEDA_STD_INFO.notes.length).toBeGreaterThan(0); expect(EASYEDA_STD_INFO.variants.length).toBeGreaterThan(0);
  });
});

describe('EasyEDA Standard: shape-array documents', () => {
  const board = parse(fixture('std-board.json'), 'std-board.json');
  const part = (ref: string) => { const found = board.components.find(c => c.ref === ref); if (!found) throw new Error(`no ${ref}`); return found; };
  const pins = (ref: string) => board.pins.filter(p => p.componentId === part(ref).id);

  it('reads components with designator, package, value and the 10 mil unit (0.254 mm), flipped to Y-up', () => {
    expect(board.format).toBe('EasyEDA Standard PCB'); expect(board.units).toBe('mm'); expect(board.name).toBe('std-board');
    expect(board.components.map(c => c.ref)).toEqual(['R1', 'C1', 'U1', 'PAD1']);
    expect(part('R1')).toMatchObject({ package: 'R0603', value: '10k', side: 'top', rotation: 0 });
    expect(part('R1').position.x).toBeCloseTo(50.8, 9); expect(part('R1').position.y).toBeCloseTo(-50.8, 9);
    const r1 = pins('R1');
    expect(r1.map(p => [p.number, p.net, p.side])).toEqual([['1', 'NET_A', 'top'], ['2', 'GND', 'top']]);
    expect(r1[0].x).toBeCloseTo(49.53, 9); expect(r1[0].y).toBeCloseTo(-50.8, 9); expect(r1[1].x).toBeCloseTo(52.07, 9);
  });
  it('takes a rectangular pad exactly from its four corner points', () => {
    const p = pins('R1')[0];
    expect(p.shape).toBe('rect'); expect(p.width).toBeCloseTo(0.8128, 9); expect(p.height).toBeCloseTo(0.9144, 9); expect(p.rotation).toBe(0);
    const c = pins('C1')[0]; // the same pad written 3.6 wide and 3.2 tall
    expect(c.width).toBeCloseTo(0.9144, 9); expect(c.height).toBeCloseTo(0.8128, 9);
  });
  it('puts a part whose SMD pads are on layer 2 on the bottom, with the part angle read as clockwise on the canvas (270 after the flip)', () => {
    expect(part('C1').side).toBe('bottom'); expect(pins('C1').every(p => p.side === 'bottom')).toBe(true); expect(part('C1').rotation).toBe(270);
  });
  it('treats layer 11 pads as both sides and takes the part side from its silkscreen', () => {
    expect(pins('U1').every(p => p.side === 'both')).toBe(true); expect(part('U1').side).toBe('top');
    expect(pins('U1').map(p => p.shape)).toEqual(['square', 'round', 'rect', 'round']);
    expect(pins('U1')[3].net).toBe(''); expect(board.nets.map(n => n.name).sort()).toEqual(['GND', 'NET_A', 'TP_OUT', 'VCC']);
  });
  it('turns a free pad with a net into a one-pad part and drops a free pad without one (disclosed)', () => {
    expect(part('PAD1')).toMatchObject({ refGenerated: true }); expect(pins('PAD1')).toHaveLength(1); expect(pins('PAD1')[0].net).toBe('TP_OUT');
    expect(notes(board)).toContain('1 free pad without a net (mounting pads and the like) was not imported.');
  });
  it('uses the layer 10 tracks as the closed board outline and sizes the board from it', () => {
    expect(board.outline).toHaveLength(4);
    expect(board.bounds.minX).toBeCloseTo(25.4, 9); expect(board.bounds.maxX).toBeCloseTo(127, 9); expect(board.bounds.minY).toBeCloseTo(-101.6, 9); expect(board.bounds.maxY).toBeCloseTo(-25.4, 9);
    expect(board.warnings.some(w => w.key === 'parse.warning.missingBoardOutline')).toBe(false);
  });
  it('discloses what it does not read and the one approximated oval pad', () => {
    expect(board.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 1 } });
    expect(notes(board)).toContain('Not imported: 1 track, 1 via, 1 copper area, 1 text, dimension or image, 1 hole. Nets come from component pads only.');
  });
  it('keeps pin identities: ids are positional handles and every net lists its pins', () => {
    expect(new Set(board.pins.map(p => p.id)).size).toBe(board.pins.length);
    const gnd = board.nets.find(n => n.name === 'GND')!;
    expect(gnd.pinIds).toHaveLength(3);
    for (const id of gnd.pinIds) expect(board.pins.find(p => p.id === id)?.net).toBe('GND');
  });
});

describe('EasyEDA Standard: object-model documents', () => {
  const board = parse(fixture('std-object-model.json'), 'std-object-model.json');
  it('reads FOOTPRINT members: designator, package and value from c_para, pads with nets, free pads', () => {
    expect(board.components.map(c => c.ref)).toEqual(['Q1', 'PAD1']);
    expect(board.components[0]).toMatchObject({ package: 'TO-92', value: 'BC547', side: 'top' });
    expect(board.pins.map(p => [p.number, p.net])).toEqual([['1', 'VCC'], ['2', 'SIG'], ['3', 'GND'], ['1', 'TP']]);
    expect(board.pins[0].x).toBeCloseTo(104.902, 9); expect(board.pins[0].y).toBeCloseTo(-36.322, 9);
    expect(board.pins[0].shape).toBe('rect'); expect(board.pins[0].width).toBeCloseTo(0.8128, 9); expect(board.pins[0].height).toBeCloseTo(0.9652, 9);
  });
  it('samples the two outline arcs into one closed circle and says so', () => {
    expect(board.outline.length).toBe(64);
    expect(board.bounds.minX).toBeCloseTo(80.645, 3); expect(board.bounds.maxX).toBeCloseTo(135.255, 3);
    expect(board.bounds.maxY - board.bounds.minY).toBeCloseTo(2 * 107.5 * 0.254, 3);
    expect(notes(board)).toContain('2 EasyEDA outline arcs/circles were approximated by straight segments.');
  });
  it('reads the same document wrapped as a dataStr object or a result object, and a shape-array document wrapped as dataStr text', () => {
    const inner = JSON.parse(new TextDecoder().decode(fixture('std-object-model.json'))) as unknown;
    for (const wrapped of [{ dataStr: inner }, { success: true, result: { dataStr: inner } }, { result: inner }]) {
      const b = parse(JSON.stringify(wrapped));
      expect(b.components.map(c => c.ref), JSON.stringify(Object.keys(wrapped))).toEqual(['Q1', 'PAD1']);
    }
    const text = new TextDecoder().decode(fixture('std-board.json')), expected = parse(text).pins.map(p => [p.number, p.net, p.x, p.y]);
    for (const wrapped of [{ dataStr: text }, { success: true, result: { dataStr: text } }]) expect(parse(JSON.stringify(wrapped)).pins.map(p => [p.number, p.net, p.x, p.y])).toEqual(expected);
  });
  it('lets the footprint head layer decide the side of an object-model part', () => {
    const model = JSON.parse(new TextDecoder().decode(fixture('std-object-model.json'))) as { FOOTPRINT: Record<string, { head: { layerid: string } }> };
    model.FOOTPRINT.gge43.head.layerid = '2';
    expect(parse(JSON.stringify(model)).components[0].side).toBe('bottom');
  });
  it('rejects an object-model document that has no pads at all', () => {
    expectFailure(() => parse(JSON.stringify({ head: { docType: '3' }, TRACK: {}, PAD: {}, FOOTPRINT: {}, itemOrder: [], layers: { '1': { name: 'Top' } } })), 'INVALID_FORMAT', /no components/);
  });
});

describe('EasyEDA Standard: geometry, rotation and sides', () => {
  it('scales 10 mil units to millimetres and flips the canvas Y axis', () => {
    const b = parse(document([...box(0, 0, 400, 300), resistor(100, 100)]));
    const [one, two] = b.pins;
    expect(one.x).toBeCloseTo(95 * 0.254, 9); expect(one.y).toBeCloseTo(-100 * 0.254, 9); expect(two.x).toBeCloseTo(105 * 0.254, 9);
    expect(b.bounds).toMatchObject({ minX: 0, maxX: 400 * 0.254 }); expect(b.bounds.minY).toBeCloseTo(-300 * 0.254, 9);
  });
  it('reads a rectangular pad rotated by its corner points (not by the unspecified angle direction)', () => {
    const w = 4, h = 2, a = 30 * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const corner = (u: number, v: number) => `${(100 + u * c - v * s).toFixed(6)} ${(100 + u * s + v * c).toFixed(6)}`;
    const points = [corner(-w / 2, -h / 2), corner(w / 2, -h / 2), corner(w / 2, h / 2), corner(-w / 2, h / 2)].join(' ');
    const b = parse(document([...box(0, 0, 200, 200), lib(100, 100, 'package`X`', 0, [designator('X1'), pad('RECT', 100, 100, w, h, 1, 'N', '1', points, 30)])]));
    expect(b.pins[0].width).toBeCloseTo(w * 0.254, 5); expect(b.pins[0].height).toBeCloseTo(h * 0.254, 5);
    expect(b.pins[0].rotation).toBeCloseTo(330, 4); // 30 degrees clockwise on the canvas = 330 counter-clockwise on the Y-up board
  });
  it('flips the sense of the part angle for a part and the angle field of round and oval pads', () => {
    const b = parse(document([...box(0, 0, 400, 400), lib(200, 200, 'package`Q`', 90, [designator('Q1'), pad('OVAL', 200, 200, 6, 3, 1, 'N', '1', '', 90)])]));
    expect(b.components[0].rotation).toBe(270); expect(b.pins[0]).toMatchObject({ shape: 'rect', rotation: 270 });
    expect(b.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 1 } });
    const round = parse(document([...box(0, 0, 400, 400), lib(200, 200, 'package`Q`', -90, [designator('Q1'), pad('ELLIPSE', 200, 200, 3, 3, 1, 'N', '1')])]));
    expect(round.components[0].rotation).toBe(90); expect(round.pins[0].shape).toBe('round'); expect(round.pins[0].radius).toBeCloseTo(1.5 * 0.254, 9);
  });
  it('approximates a polygon pad by the box of its points and counts it', () => {
    const b = parse(document([...box(0, 0, 400, 400), lib(200, 200, 'package`P`', 0, [designator('P1'), pad('POLYGON', 200, 200, 0, 0, 1, 'N', '1', '190 190 210 190 205 210 195 210')])]));
    expect(b.pins[0].shape).toBe('rect'); expect(b.pins[0].width).toBeCloseTo(20 * 0.254, 9); expect(b.pins[0].height).toBeCloseTo(20 * 0.254, 9);
    expect(b.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 1 } });
  });
  it('decides the side by the majority of SMD pads, then the silkscreen, then top', () => {
    const mixed = lib(200, 200, 'package`M`', 0, [designator('M1'), pad('RECT', 195, 200, 3, 3, 2, 'A', '1'), pad('RECT', 205, 200, 3, 3, 2, 'B', '2'), pad('RECT', 200, 210, 3, 3, 1, 'C', '3')]);
    const silkBottom = lib(300, 200, 'package`S`', 0, [designator('M2', 4), pad('RECT', 295, 200, 3, 3, 11, 'A', '1')]);
    const none = lib(100, 100, 'package`N`', 0, [designator('M3', 1), pad('RECT', 95, 100, 3, 3, 11, 'A', '1')]);
    const b = parse(document([...box(0, 0, 400, 400), mixed, silkBottom, none]));
    expect(b.components.map(c => [c.ref, c.side])).toEqual([['M1', 'bottom'], ['M2', 'bottom'], ['M3', 'top']]);
  });
  it('numbers pads without a number as ~1, ~2 (marked generated) and names parts without a designator FP<n>', () => {
    const b = parse(document([...box(0, 0, 400, 400), lib(200, 200, 'package`X`', 0, [pad('RECT', 195, 200, 3, 3, 1, 'A', ''), pad('RECT', 205, 200, 3, 3, 1, 'B', '7'), pad('RECT', 215, 200, 3, 3, 1, 'C', '')])]));
    expect(b.pins.map(p => p.number)).toEqual(['~1', '7', '~2']); expect(b.pins.map(p => p.numberGenerated)).toEqual([true, undefined, true]);
    expect(b.components[0]).toMatchObject({ ref: 'FP1', refGenerated: true });
  });
  it('never lets a generated pad number collide with a real one in the object model', () => {
    const model = { head: { docType: '3' }, TRACK: {}, PAD: {}, itemOrder: [], layers: { '1': {} }, FOOTPRINT: { g1: { head: { x: '10', y: '10', c_para: 'package`P`' }, PAD: {
      a: { shape: 'RECT', layerid: '1', x: 10, y: 10, width: 2, height: 2, net: 'A', number: '~1', pointArr: [], rotation: '0' }, b: { shape: 'RECT', layerid: '1', x: 14, y: 10, width: 2, height: 2, net: 'B', number: '', pointArr: [], rotation: '0' } } } } };
    expect(parse(JSON.stringify(model)).pins.map(p => [p.number, p.numberGenerated])).toEqual([['~1', undefined], ['~2', true]]);
  });
  it('falls back to the designator attribute and BOM value keys, and reads attribute pairs case-insensitively', () => {
    const b = parse(document([...box(0, 0, 400, 400), lib(200, 200, 'Designator`U7`BOM_Value`TL431`Package`SOT-23`', 0, [pad('RECT', 195, 200, 3, 3, 1, 'A', '1')])]));
    expect(b.components[0]).toMatchObject({ ref: 'U7', value: 'TL431', package: 'SOT-23' });
  });
  it('includes the silkscreen drawing of a part in its body outline', () => {
    const b = parse(document([...box(0, 0, 400, 400), lib(200, 200, 'package`R`', 0, [designator('R1'), pad('RECT', 195, 200, 3, 3, 1, 'A', '1'), track(3, '170 180 230 180 230 220 170 220 170 180', 1)])]));
    expect(b.components[0].bounds.maxX - b.components[0].bounds.minX).toBeCloseTo(60 * 0.254, 9);
    expect(b.components[0].bounds.maxY - b.components[0].bounds.minY).toBeCloseTo(40 * 0.254, 9);
  });
});

describe('EasyEDA Standard: board outline', () => {
  const part = resistor();
  it('stitches unordered and reversed tracks into one closed contour', () => {
    const lines = [track(10, '400 300 100 300'), track(10, '100 100 400 100'), track(10, '100 100 100 300'), track(10, '400 100 400 300')];
    const b = parse(document([part, ...lines]));
    expect(b.outline).toHaveLength(4); expect(b.bounds.maxX).toBeCloseTo(400 * 0.254, 9);
    expect(b.warnings.some(w => w.key === 'parse.warning.missingBoardOutline')).toBe(false);
  });
  it('reads rectangle, circle and arc items of layer 10 and ignores the same items on other layers', () => {
    expect(parse(document([part, 'RECT~100~100~300~200~10~g5~0'])).bounds.maxX).toBeCloseTo(400 * 0.254, 9);
    const circle = parse(document([part, 'CIRCLE~250~250~100~1~10~g6~0']));
    expect(circle.outline).toHaveLength(64); expect(circle.bounds.maxX - circle.bounds.minX).toBeCloseTo(200 * 0.254, 6);
    const arcs = parse(document([part, 'ARC~1~10~~M 100,200 A 100,100 0 0,1 300,200~~g7~0', 'ARC~1~10~~M 300,200 A 100,100 0 0,1 100,200~~g8~0']));
    expect(arcs.outline.length).toBeGreaterThan(20); expect(arcs.bounds.maxX - arcs.bounds.minX).toBeCloseTo(200 * 0.254, 6);
    const other = parse(document([part, 'RECT~100~100~300~200~3~g5~0', 'CIRCLE~250~250~100~1~4~g6~0']));
    expect(other.warnings.some(w => w.key === 'parse.warning.missingBoardOutline')).toBe(true);
  });
  it('keeps the outer contour of two loops and discloses the inner one as a cutout', () => {
    const b = parse(document([part, ...box(0, 0, 400, 400), ...box(150, 150, 250, 250)]));
    expect(b.outline).toHaveLength(4); expect(b.bounds.maxX).toBeCloseTo(400 * 0.254, 9);
    expect(b.warnings.some(w => w.key === 'parse.warning.boardCutouts')).toBe(true);
  });
  it('estimates the boundary from the parts and says so when the outline is open or absent', () => {
    const open = parse(document([part, track(10, '0 0 400 0'), track(10, '400 0 400 300')]));
    expect(open.warnings.some(w => w.key === 'parse.warning.missingBoardOutline')).toBe(true);
    expect(notes(open).some(text => /does not form a closed contour/.test(text))).toBe(true);
    const none = parse(document([part]));
    expect(none.warnings.some(w => w.key === 'parse.warning.missingBoardOutline')).toBe(true);
  });
  it('ignores spurs and chords that are not part of a closed loop (disclosed)', () => {
    const b = parse(document([part, ...box(0, 0, 400, 400), track(10, '400 400 600 600')]));
    expect(b.outline).toHaveLength(4); expect(notes(b).some(text => /open EasyEDA outline chain/.test(text))).toBe(true);
  });
  it('does not fabricate a contour from tracks that only nearly meet beyond the tolerance', () => {
    const b = parse(document([part, track(10, '0 0 400 0'), track(10, '400 0.5 400 400'), track(10, '400 400 0 400'), track(10, '0 400 0 0')]));
    expect(b.warnings.some(w => w.key === 'parse.warning.missingBoardOutline')).toBe(true);
  });
});

describe('EasyEDA Standard: malformed and hostile input', () => {
  const ok = [...box(0, 0, 400, 400), resistor()];
  it('rejects JSON that does not parse (truncated, trailing garbage, NaN literal) as INVALID_FORMAT, never a raw SyntaxError', () => {
    const text = document(ok);
    expectFailure(() => parse(text.slice(0, -5)), 'INVALID_FORMAT', /not valid JSON/);
    expectFailure(() => parse(`${text} trailing`), 'INVALID_FORMAT');
    expectFailure(() => parse(text.replace('"shape":[', '"shape":["TRACK~1~10~~1 1 2 2~g",NaN,')), 'INVALID_FORMAT');
  });
  it('rejects a recognized document whose shape list is not text or holds a non-text entry', () => {
    expectFailure(() => parse(document([...ok, 5])), 'INVALID_FORMAT', /shape entry \d+ is not text/);
    expectFailure(() => parse(document([...ok, { a: 1 }])), 'INVALID_FORMAT');
  });
  it('rejects non-numeric, non-finite, hex and oversized numbers', () => {
    for (const bad of ['abc', 'NaN', 'Infinity', '0x10', '1e999', '--5', '1,5']) expectFailure(() => parse(document([...ok, pad('RECT', 1, 1, 1, 1, 1, 'N', '1').replace('~RECT~1~', `~RECT~${bad}~`)].map(s => s))), 'INVALID_FORMAT');
    expectFailure(() => parse(document([...ok, lib(1e9, 0, '', 0, [pad('RECT', 1, 1, 1, 1, 1, 'N', '1')])])), 'INVALID_FORMAT', /magnitude/);
    expectFailure(() => parse(document([...ok, lib(0, 0, '', 1e308, [pad('RECT', 1, 1, 1, 1, 1, 'N', '1')])])), 'INVALID_FORMAT', /magnitude/);
  });
  it('rejects undocumented pad shapes and pads on layers other than 1, 2 and 11 as unsupported variants', () => {
    expectFailure(() => parse(document([...ok, pad('STAR', 1, 1, 1, 1, 1, 'N', '1')])), 'UNSUPPORTED_VARIANT', /pad shape/);
    expectFailure(() => parse(document([...ok, pad('RECT', 1, 1, 1, 1, 21, 'N', '1')])), 'UNSUPPORTED_VARIANT', /layer 21/);
    expectFailure(() => parse(document([...ok, lib(10, 10, '', 0, [pad('RECT', 1, 1, 1, 1, 5, 'N', '1')])])), 'UNSUPPORTED_VARIANT', /layer 5/);
  });
  it('rejects a non-integer or negative layer id', () => {
    expectFailure(() => parse(document([...ok, track(1.5 as number, '1 1 2 2')])), 'INVALID_FORMAT', /layer/);
    expectFailure(() => parse(document([...ok, track(-1, '1 1 2 2')])), 'INVALID_FORMAT', /layer/);
  });
  it('rejects an odd coordinate count and absurdly long number lists', () => {
    expectFailure(() => parse(document([...ok, track(10, '1 1 2')])), 'INVALID_FORMAT', /odd number/);
    expectFailure(() => parse(document([...ok, track(10, Array.from({ length: 100_002 }, () => '1').join(' '))])), 'LIMIT_EXCEEDED');
  });
  it('rejects unsupported or cut-short arc paths and a path that is too long', () => {
    expectFailure(() => parse(document([...ok, 'ARC~1~10~~M 1,1 Q 2,2 3,3~~g1'])), 'UNSUPPORTED_VARIANT', /"Q"/);
    expectFailure(() => parse(document([...ok, 'ARC~1~10~~M 1,1 A 2,2 0 0 1 3~~g1'])), 'INVALID_FORMAT', /cut short/);
    expectFailure(() => parse(document([...ok, 'ARC~1~10~~A 2,2 0 0 1 3,3~~g1'])), 'INVALID_FORMAT', /starts with an arc/);
    expectFailure(() => parse(document([...ok, `ARC~1~10~~${'M 1,1 '.repeat(20_000)}~~g1`])), 'LIMIT_EXCEEDED', /arc path/);
  });
  it('bounds the shape count, part count, pad count and footprint size', () => {
    expectFailure(() => parse(document(Array.from({ length: 2_000_001 }, () => 'TRACK~1~1'))), 'LIMIT_EXCEEDED', /shape array has 2000001/);
    expectFailure(() => parse(document(Array.from({ length: 250_001 }, () => 'LIB~0~0~~0'))), 'LIMIT_EXCEEDED');
    expectFailure(() => parse(document(['LIB~0~0~~0', ...Array.from({ length: 1_000_001 }, () => 'PAD~RECT~0~0~1~1~1~N~1')])), 'LIMIT_EXCEEDED');
    expectFailure(() => parse(document([`LIB~0~0~~0${'#@$X'.repeat(200_001)}`])), 'LIMIT_EXCEEDED', /footprint has/);
  }, 300_000);
  it('keeps an attribute bomb and a deeply nested unrelated member harmless', () => {
    const bombed = (size: number) => document([...ok, lib(50, 50, '`'.repeat(size), 0, [designator('B1'), pad('RECT', 45, 50, 3, 3, 1, 'N', '1')])]);
    // A run of backticks in the attributes of a footprint must cost as much as any other text of that size.
    expectScaling('attribute bomb', [31_250, 125_000, 1_000_000], size => { const text = bombed(size); return () => parse(text); });
    const b = parse(bombed(1_000_000));
    expect(b.components.map(c => c.ref)).toContain('B1');
    const nested = `${'['.repeat(200_000)}${']'.repeat(200_000)}`;
    const text = `{"head":{"docType":"3"},"canvas":"${CANVAS}","shape":${JSON.stringify(ok)},"extra":${nested}}`;
    try { expect(parse(text).components).toHaveLength(1); } catch (error) { expect(error).toBeInstanceOf(BoardFormatError); }
  });
  it('does not let __proto__ or constructor keys reach Object.prototype', () => {
    const model = '{"head":{"docType":"3"},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"FOOTPRINT":{"__proto__":{"PAD":{}},"gge1":{"head":{"x":"1","y":"1","c_para":"package`P`"},"PAD":{"p":{"shape":"RECT","layerid":"1","x":1,"y":1,"width":2,"height":2,"net":"N","number":"1","pointArr":[],"rotation":"0"}}}},"TRACK":{},"PAD":{},"itemOrder":[],"layers":{"1":{}}}';
    const outcome = (() => { try { return parseEasyedaStd(textInput(model)); } catch (error) { return error; } })();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(outcome === null || outcome instanceof BoardFormatError || (outcome as Board).components.length >= 0).toBe(true);
  });
  it('rejects text that is not decodable as UTF-8 only when the bytes make JSON invalid, and decodes a Latin-1 package name', () => {
    const body = document([...ok, lib(60, 60, 'package`Rés`', 0, [designator('R9'), pad('RECT', 55, 60, 3, 3, 1, 'N', '1')])]);
    const bytes = Uint8Array.from(Array.from(body, ch => ch.charCodeAt(0)));
    expect(parse(bytes).components.find(c => c.ref === 'R9')?.package).toBe('Rés');
  });
});

describe('EasyEDA Standard: linear-time parsing', () => {
  const big = (parts: number): string => {
    const shapes: string[] = [...box(0, 0, 100_000, 100_000)];
    for (let i = 0; i < parts; i++) {
      const x = 100 + (i % 500) * 30, y = 100 + Math.floor(i / 500) * 30;
      shapes.push(lib(x, y, 'package`R0603`value`10k`', i % 4 * 90, [designator(`R${i + 1}`), pad('RECT', x - 5, y, 3, 3, 1, `N${i % 997}`, '1'), pad('ELLIPSE', x + 5, y, 3, 3, 1, `N${(i + 1) % 997}`, '2'), track(3, `${x - 8} ${y - 4} ${x + 8} ${y - 4} ${x + 8} ${y + 4} ${x - 8} ${y + 4} ${x - 8} ${y - 4}`)]));
    }
    return document(shapes);
  };
  it('parses a 20,000-part board in linear time', () => {
    // The time over the number of parts: a pass per part over all parts is quadratic, 16 times the time for 4 times the parts.
    expectScaling('parts of a board', [2500, 10_000, 40_000], parts => { const text = big(parts); return () => parse(text); });
    const board = parse(big(40_000));
    expect(board.components).toHaveLength(40_000); expect(board.pins).toHaveLength(80_000);
  }, 300_000);
  it('does not go quadratic on long runs of separators, quotes or open brackets', () => {
    const unit = (text: string) => (size: number) => text.repeat(Math.ceil(size / text.length));
    const fillers: Array<[string, (size: number) => string]> = [['separators', unit('~')], ['marker runs', unit('#@$')], ['blanks', unit(' ')], ['quotes', unit('"')], ['backticks', unit('`')], ['backslashes', unit('\\')]];
    const file = (filler: string) => document([...box(0, 0, 100, 100), `LIB~0~0~${filler}~0`, `TEXT~${filler}`, `PAD~RECT~${filler}`]);
    // Ascending sizes: a pattern that retries every position of a run needs seconds for 500,000 characters, so a regression fails at the first pair.
    for (const [label, filler] of fillers) expectScaling(label, [20_000, 80_000, 500_000], size => { const text = file(filler(size)); return catching(() => parseEasyedaStd(textInput(text))); });
    // Whatever the run does, the reader refuses with its own error and never with another one.
    for (const [, filler] of fillers) { try { parseEasyedaStd(textInput(file(filler(500_000)))); } catch (error) { expect(error).toBeInstanceOf(BoardFormatError); } }
  }, 300_000);
  it('stitches a 100,000-segment board outline in linear time', () => {
    const ringOf = (segments: number) => Array.from({ length: segments }, (_, i) => { const a = 2 * Math.PI * i / segments, b = 2 * Math.PI * (i + 1) / segments; return track(10, `${(5000 + 4000 * Math.cos(a)).toFixed(4)} ${(5000 + 4000 * Math.sin(a)).toFixed(4)} ${(5000 + 4000 * Math.cos(b)).toFixed(4)} ${(5000 + 4000 * Math.sin(b)).toFixed(4)}`); });
    expectScaling('outline segments', [6250, 25_000, 100_000], segments => { const text = document([resistor(), ...ringOf(segments)]); return () => parse(text); });
    expect(parse(document([resistor(), ...ringOf(100_000)])).outline.length).toBe(100_000);
  }, 300_000);
  it('sniffs a very large file without reading past the head', () => {
    const large = (size: number) => encode(`${document([track(10, '1 1 2 2')]).slice(0, -1)},"pad":"${'x'.repeat(size)}"}`);
    // Count decoded bytes: sub-millisecond timing ratios are noisy on shared runners.
    const decode = TextDecoder.prototype.decode;
    let decodedBytes = 0;
    const spy = vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (input, options) {
      decodedBytes += input?.byteLength ?? 0;
      return decode.call(this, input, options);
    });
    try {
      for (const size of [1_000_000, 10_000_000, 40_000_000]) {
        decodedBytes = 0;
        expect(sniffEasyedaStd(large(size))?.confidence).toBe(0.95);
        expect(decodedBytes).toBeGreaterThan(0);
        expect(decodedBytes).toBeLessThanOrEqual(64 * 1024);
      }
      decodedBytes = 0;
      const lateHeader = encode(' '.repeat(64 * 1024) + document([track(10, '1 1 2 2')]));
      expect(sniffEasyedaStd(lateHeader)).toBeNull();
      expect(decodedBytes).toBeLessThanOrEqual(64 * 1024);
    } finally { spy.mockRestore(); }
  });
});
