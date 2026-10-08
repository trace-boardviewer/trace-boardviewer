import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import { BoardFormatError, textInput, type FormatErrorCode } from './common';
import { EASYEDA_PRO_INFO, parseEasyedaPro, sniffEasyedaPro } from './easyeda-pro';
import { sniffEasyedaStd } from './easyeda-std';
import { crc32, openZip, ZIP_MAX_ENTRIES } from './easyeda-zip';
import { catching, expectBoundedWork, expectCostAtMost, expectScaling } from '../../test-support/timing';

// Every document here is an original synthetic one modelled on the documented EasyEDA Pro V2 structure (one JSON array per line); units are mil.
const root = fileURLToPath(new URL('../../../tests/fixtures/easyeda/', import.meta.url));
const fixtureText = (path: string): string => readFileSync(`${root}${path}`, 'utf8');
const fixtureFiles = (): Record<string, string> => {
  const files: Record<string, string> = { 'project.json': fixtureText('pro/project.json') };
  for (const dir of ['PCB', 'FOOTPRINT']) for (const name of readdirSync(`${root}pro/${dir}`)) files[`${dir}/${name}`] = fixtureText(`pro/${dir}/${name}`);
  return files;
};
const zip = (files: Record<string, string | Uint8Array>, level: 0 | 6 = 6): Uint8Array => zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, [typeof body === 'string' ? strToU8(body) : body, { level }] as [Uint8Array, { level: 0 | 6 }]])));
const parse = (data: Uint8Array | string, name = 'board.epro'): Board => {
  const result = parseEasyedaPro(typeof data === 'string' ? textInput(data, name) : { name, data });
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
const LAYERS: unknown[][] = [[1, 'TOP'], [2, 'BOTTOM'], [3, 'TOP_SILK'], [4, 'BOT_SILK'], [9, 'TOP_ASSEMBLY'], [10, 'BOT_ASSEMBLY'], [11, 'OUTLINE'], [12, 'MULTI'], [13, 'DOCUMENT']].map(([id, type]) => ['LAYER', id, type, `${type} layer`, 3, '#ff0000', 1, '#7f0000', 0.5]);
const lines = (records: unknown[][]): string => records.map(record => JSON.stringify(record)).join('\n');
const pcbText = (records: unknown[][], opts: { layers?: unknown[][]; version?: string } = {}): string => lines([['DOCTYPE', 'PCB', opts.version ?? '1.8'], ['HEAD', { editorVersion: '2.2.47.7' }], ...opts.layers ?? LAYERS, ...records]);
const footprintText = (records: unknown[][], layers = LAYERS): string => lines([['DOCTYPE', 'FOOTPRINT', '1.8'], ['HEAD', {}], ...layers, ...records]);
const padRecord = (id: string, number: string, x: number, y: number, shape: unknown[] | null, opts: { layer?: number; angle?: number; net?: string; hole?: unknown[] | null } = {}): unknown[] =>
  ['PAD', id, 0, opts.net ?? '', opts.layer ?? 1, number, x, y, opts.angle ?? 0, opts.hole ?? null, shape, [], 0, 0, 0, 1, 0, null, null, null, null, 0];
/** A footprint with an asymmetric pair of pads (so every rotation and mirror is visible): pad 1 at (30, 10), pad 2 at (-30, -10). */
const FP = footprintText([padRecord('e1', '1', 30, 10, ['RECT', 40, 20, 0]), padRecord('e2', '2', -30, -10, ['RECT', 40, 20, 0])]);
const FP_UUID = '11111111111111111111111111111111';
const component = (id: string, layer: number, x: number, y: number, angle: number, attrs: Record<string, string>, nets: Array<[string, string, string?]> = []): unknown[][] => [
  ['COMPONENT', id, 0, layer, x, y, angle, {}, 0, null],
  ...Object.entries(attrs).map(([key, value], index) => ['ATTR', `${id}a${index}`, 0, id, 3, null, null, key, value, 0, 0, 'default', 45, 6, 0, 0, 3, 0, 0, 0, 0, 0]),
  ...nets.map(([number, net, padId]) => ['PAD_NET', id, number, net, ...padId ? [padId] : []]),
];
const part = (id: string, layer: number, x: number, y: number, angle: number, designator: string, nets: Array<[string, string, string?]> = [['1', 'A', 'e1'], ['2', 'B', 'e2']]) => component(id, layer, x, y, angle, { Footprint: FP_UUID, Designator: designator }, nets);
const outlineLines = (x0: number, y0: number, x1: number, y1: number, layer = 11): unknown[][] => [['LINE', 'o1', 0, '', layer, x0, y0, x1, y0, 10, 0], ['LINE', 'o2', 0, '', layer, x1, y0, x1, y1, 10, 0], ['LINE', 'o3', 0, '', layer, x1, y1, x0, y1, 10, 0], ['LINE', 'o4', 0, '', layer, x0, y1, x0, y0, 10, 0]];
const project = (extra: Record<string, unknown> = {}) => JSON.stringify({ pcbs: { p1: 'PCB1' }, footprints: { [FP_UUID]: { title: 'TEST-FP', type: 4 } }, ...extra });
const epro = (records: unknown[][], opts: { footprints?: Record<string, string>; layers?: unknown[][]; projectJson?: string } = {}): Uint8Array => zip({
  'project.json': opts.projectJson ?? project(), 'PCB/p1.epcb': pcbText(records, { layers: opts.layers }), ...Object.fromEntries(Object.entries(opts.footprints ?? { [FP_UUID]: FP }).map(([uuid, text]) => [`FOOTPRINT/${uuid}.efoo`, text])),
});
const pinOf = (board: Board, ref: string, number: string) => {
  const component = board.components.find(c => c.ref === ref);
  const found = board.pins.find(p => p.componentId === component?.id && p.number === number);
  if (!found) throw new Error(`no pin ${ref}.${number}`);
  return found;
};
const MIL = 0.0254;

describe('EasyEDA Pro: recognition', () => {
  it('recognizes a bare document by its DOCTYPE header at 0.99', () => {
    expect(sniffEasyedaPro(strToU8(pcbText([])), 'a.epcb')).toMatchObject({ id: 'easyeda-pro', variant: 'epcb', kind: 'pcb', confidence: 0.99 });
    expect(sniffEasyedaPro(strToU8('\ufeff  \n["DOCTYPE", "PCB", "1.8"]\n["HEAD",{}]'))).toMatchObject({ kind: 'pcb', confidence: 0.99 });
    expect(sniffEasyedaPro(strToU8('["DOCTYPE","PCB"]'))?.kind).toBe('pcb');
  });
  it('reports the kind of every documented document type so a caller can route it', () => {
    for (const [type, kind] of [['FOOTPRINT', 'footprint'], ['SCH', 'schematic'], ['SCH_PAGE', 'schematic'], ['SYMBOL', 'schematic'], ['INSTANCE', 'schematic'], ['PANEL', 'unsupported'], ['POURED', 'unsupported']])
      expect(sniffEasyedaPro(strToU8(`["DOCTYPE","${type}","1.8"]\n["HEAD",{}]`))?.kind, type).toBe(kind);
    expect(sniffEasyedaPro(strToU8('["DOCTYPE","MYSTERY","1.8"]'))).toBeNull();
  });
  it('recognizes a project archive at 0.95 and a bare PCB/*.epcb archive at 0.8, reading only the directory', () => {
    expect(sniffEasyedaPro(zip(fixtureFiles()), 'p.epro')).toMatchObject({ variant: 'epro-zip', kind: 'pcb', confidence: 0.95 });
    expect(sniffEasyedaPro(zip({ 'PCB/x.epcb': pcbText([]) }))).toMatchObject({ variant: 'epro-zip', kind: 'pcb', confidence: 0.8 });
    expect(sniffEasyedaPro(zip({ 'project.json': '{}', 'SHEET/s1': '["DOCTYPE","SCH","1.1"]' }))).toMatchObject({ kind: 'project', confidence: 0.95 });
    expect(sniffEasyedaPro(zip({ 'project.json': '{}', 'FOOTPRINT/f.efoo': FP }))).toMatchObject({ kind: 'project' });
  });
  it('recognizes the V3 log header and the offline SQLite databases as unsupported (0.9) without claiming anything else', () => {
    expect(sniffEasyedaPro(strToU8('{"type":"DOCHEAD"}||{"docType":"PCB"}||\n'))).toMatchObject({ variant: 'log-v3', kind: 'unsupported', confidence: 0.9 });
    const sqlite = (sql: string) => { const out = new Uint8Array(4096); out.set(strToU8(`SQLite format 3\0${sql}`)); return out; };
    expect(sniffEasyedaPro(sqlite('CREATE TABLE "documents" ("docType" integer, "dataStr" text)'))).toMatchObject({ variant: 'eprj-sqlite', kind: 'unsupported', confidence: 0.9 });
    expect(sniffEasyedaPro(sqlite('CREATE TABLE "projects" ("cbb_project" integer)'))).toMatchObject({ variant: 'eprj-sqlite' });
    expect(sniffEasyedaPro(sqlite('CREATE TABLE notes (a, b)'))).toBeNull();
  });
  it('returns null for everything that is not EasyEDA Pro', () => {
    for (const text of ['', ' ', '{}', '[]', '["PCB"]', '[["DOCTYPE","PCB"]]', '(kicad_pcb (version 20240108))', '{"head":{"docType":"3"},"shape":["TRACK~1~10"]}', 'x'.repeat(50)]) expect(sniffEasyedaPro(strToU8(text)), text).toBeNull();
    expect(sniffEasyedaPro(new Uint8Array(0))).toBeNull();
    expect(sniffEasyedaPro(zip({ 'readme.txt': 'hello' }))).toBeNull();
    expect(sniffEasyedaPro(zip({ 'PCB/x.txt': 'hello' }))).toBeNull();
    expect(sniffEasyedaPro(zip({ 'src/main.c': 'int main(){}', 'project.json': '{}' }))).toBeNull();
    expect(sniffEasyedaPro(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]))).toBeNull();
  });
  it('does not overlap with the Standard sniffer', () => {
    expect(sniffEasyedaStd(strToU8(pcbText([])))).toBeNull();
    expect(sniffEasyedaPro(strToU8(JSON.stringify({ head: { docType: '3' }, canvas: 'CA~1', shape: ['TRACK~1~10~~1 1 2 2~g'] })))).toBeNull();
  });
  it('declares its registry facts', () => {
    expect(EASYEDA_PRO_INFO).toMatchObject({ id: 'easyeda-pro', status: 'supported', validation: 'real-files', electrical: 'nets', extensions: ['.epro', '.epcb', '.zip'] });
    expect(EASYEDA_PRO_INFO.notes.join(' ')).toMatch(/unverified/);
  });
  it('rejects, with a reason, what it recognizes but cannot read, and returns null for what is not a board', () => {
    expectFailure(() => parse('{"type":"DOCHEAD"}||{"docType":"PCB"}||\n'), 'UNSUPPORTED_VARIANT', /V3/);
    const sqlite = new Uint8Array(4096); sqlite.set(strToU8('SQLite format 3\0CREATE TABLE "documents" ("docType" integer)'));
    expectFailure(() => parseEasyedaPro({ name: 'p.eprj', data: sqlite }), 'UNSUPPORTED_VARIANT', /export it as an \.epro/);
    expectFailure(() => parse(footprintText([padRecord('e1', '1', 0, 0, ['RECT', 10, 10, 0])])), 'WRONG_KIND', /footprint/);
    expectFailure(() => parse('["DOCTYPE","PANEL","1.8"]\n["HEAD",{}]'), 'WRONG_KIND');
    expect(parseEasyedaPro(textInput('["DOCTYPE","SCH","1.1"]\n["HEAD",{}]'))).toBeNull();
    expect(parseEasyedaPro(textInput('(kicad_pcb)'))).toBeNull();
    expect(parseEasyedaPro({ name: 'x.zip', data: zip({ 'a.txt': 'x' }) })).toBeNull();
    expect(parseEasyedaPro(textInput(''))).toBeNull();
  });
  it('rejects a project archive that holds schematics and libraries only as the wrong kind', () => {
    expectFailure(() => parse(zip({ 'project.json': '{}', 'SHEET/s1': '["DOCTYPE","SCH","1.1"]', [`FOOTPRINT/${FP_UUID}.efoo`]: FP })), 'WRONG_KIND', /no PCB document/);
  });
});

describe('EasyEDA Pro: project archive fixture', () => {
  const board = parse(zip(fixtureFiles()), 'synthetic.epro');
  const part = (ref: string) => { const found = board.components.find(c => c.ref === ref); if (!found) throw new Error(`no ${ref}`); return found; };
  it('reads components in file order with designator, value, package title and sides', () => {
    expect(board.format).toBe('EasyEDA Pro PCB'); expect(board.units).toBe('mm'); expect(board.name).toBe('synthetic');
    expect(board.components.map(c => c.ref)).toEqual(['R1', 'R2', 'Q1', 'C1', 'J1', 'PAD1']);
    expect(part('R1')).toMatchObject({ value: '10k', package: 'R0603', side: 'top', rotation: 0 });
    expect(part('R2')).toMatchObject({ value: '4k7', side: 'top', rotation: 90 }); // Value falls back to the Name attribute
    expect(part('C1')).toMatchObject({ value: '100n', side: 'bottom', rotation: 90 });
    expect(part('J1').package).toBe('HDR-1x4'); expect(part('Q1').package).toBe('SOT-23-3'); // the footprint comes from the Device attribute through project.json
  });
  it('resolves "={Value}" templates against the same part', () => {
    expect(part('R1').value).toBe('10k'); // Name is "={Value}", Value is "10k"
  });
  it('converts mil to millimetres and keeps the Y-up plane', () => {
    expect(part('R1').position.x).toBeCloseTo(25.4, 9); expect(part('R1').position.y).toBeCloseTo(12.7, 9);
    expect(board.bounds).toMatchObject({ minX: 0, minY: 0 }); expect(board.bounds.maxX).toBeCloseTo(76.2, 9); expect(board.bounds.maxY).toBeCloseTo(50.8, 9);
    expect(board.outline).toHaveLength(4);
  });
  it('places pads of a top part by rotating the footprint pads about the part origin (counter-clockwise)', () => {
    const half = 27.56 * MIL; // the R0603 fixture footprint has its pads at +-27.56 mil
    expect(pinOf(board, 'R1', '1')).toMatchObject({ net: 'NET_A', side: 'top' }); expect(pinOf(board, 'R1', '1').x).toBeCloseTo(25.4 - half, 9); expect(pinOf(board, 'R1', '1').y).toBeCloseTo(12.7, 9);
    expect(pinOf(board, 'R1', '2').x).toBeCloseTo(25.4 + half, 9);
    expect(pinOf(board, 'R2', '1').x).toBeCloseTo(38.1, 9); expect(pinOf(board, 'R2', '1').y).toBeCloseTo(12.7 - half, 9); expect(pinOf(board, 'R2', '1').rotation).toBe(90);
    expect(pinOf(board, 'Q1', '1').x).toBeCloseTo(51.7525, 9); expect(pinOf(board, 'Q1', '1').y).toBeCloseTo(26.3398, 9);
    expect(pinOf(board, 'Q1', '3').x).toBeCloseTo(49.8475, 9); expect(pinOf(board, 'Q1', '3').rotation).toBe(270); // part 180 + pad angle 90
  });
  it('mirrors a bottom part in x before rotating it, puts its pads on the bottom and says the convention is unverified', () => {
    const half = 27.56 * MIL;
    expect(pinOf(board, 'C1', '1').side).toBe('bottom'); expect(pinOf(board, 'C1', '1').x).toBeCloseTo(30.48, 9); expect(pinOf(board, 'C1', '1').y).toBeCloseTo(38.1 + half, 9);
    expect(pinOf(board, 'C1', '2').y).toBeCloseTo(38.1 - half, 9); expect(pinOf(board, 'C1', '1').rotation).toBe(270);
    expect(notes(board).some(text => /1 bottom-side component is placed mirrored and rotated by the usual convention/.test(text))).toBe(true);
  });
  it('reads pad shapes: rect, square, round, oval and n-gon as bounding shapes, polygon pads by their box, and both-sides for MULTI pads', () => {
    expect(pinOf(board, 'J1', '1')).toMatchObject({ shape: 'square', side: 'both' }); expect(pinOf(board, 'J1', '1').width).toBeCloseTo(60 * MIL, 9);
    expect(pinOf(board, 'J1', '2')).toMatchObject({ shape: 'round', side: 'both' });
    expect(pinOf(board, 'J1', '3')).toMatchObject({ shape: 'rect' }); expect(pinOf(board, 'J1', '3').height).toBeCloseTo(90 * MIL, 9);
    expect(pinOf(board, 'J1', '4')).toMatchObject({ shape: 'round', net: '' });
    const poly = pinOf(board, 'J1', '~1'); // a pad without a number
    expect(poly).toMatchObject({ numberGenerated: true, side: 'top', shape: 'rect' }); expect(poly.x).toBeCloseTo(66.04 + 150 * MIL, 9);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 3 } });
  });
  it('opens the first PCB document with components and discloses the others, skipping the empty one', () => {
    expect(notes(board)).toContain('The project has 2 PCB documents; the first one with components was opened and the others were not.');
  });
  it('keeps free pads with a net as one-pad parts, drops the unnetted ones and ignores footprint pad overrides (all disclosed)', () => {
    expect(part('PAD1')).toMatchObject({ refGenerated: true }); expect(pinOf(board, 'PAD1', 'TP1')).toMatchObject({ net: 'TP_OUT' });
    expect(notes(board)).toContain('1 free pad without a net (mounting pads and the like) was not imported.');
    expect(notes(board)).toContain('1 footprint pad override was ignored.');
    expect(notes(board)).toContain('Tracks, vias, copper pours and text are not imported; nets come from the part pad assignments only.');
  });
  it('builds nets from the pad assignments and lists every pin of each', () => {
    expect(board.nets.map(n => n.name).sort()).toEqual(['GND', 'NET_A', 'NET_B', 'TP_OUT']);
    const gnd = board.nets.find(n => n.name === 'GND')!;
    expect(gnd.pinIds.map(id => board.pins.find(p => p.id === id)!).map(p => `${board.components.find(c => c.id === p.componentId)!.ref}.${p.number}`).sort()).toEqual(['C1.2', 'J1.1', 'Q1.3', 'R1.2', 'R2.2']);
  });
  it('uses the OUTLINE polygon of the document as the board outline', () => {
    expect(board.warnings.some(w => w.key === 'parse.warning.missingBoardOutline')).toBe(false);
  });
});

describe('EasyEDA Pro: placement, sides and rotation', () => {
  const at = (layer: number, angle: number) => parse(epro([...outlineLines(0, 0, 2000, 2000), ...part('c1', layer, 1000, 800, angle, 'U1')]));
  const rotate = (x: number, y: number, deg: number) => { const a = deg * Math.PI / 180; return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]; };
  it('rotates a top part counter-clockwise by 0, 90, 180, 270 and 33 degrees', () => {
    for (const angle of [0, 90, 180, 270, 33, -90, 450]) {
      const board = at(1, angle), [dx, dy] = rotate(30, 10, angle), pin = pinOf(board, 'U1', '1');
      expect(pin.x, `${angle}`).toBeCloseTo((1000 + dx) * MIL, 9); expect(pin.y, `${angle}`).toBeCloseTo((800 + dy) * MIL, 9);
      expect(board.components[0].rotation).toBe(((angle % 360) + 360) % 360);
    }
  });
  it('mirrors a bottom part in x before the rotation and turns the pad angle with it', () => {
    for (const angle of [0, 90, 180, 270, 33]) {
      const board = at(2, angle), [dx, dy] = rotate(-30, 10, angle), pin = pinOf(board, 'U1', '1');
      expect(pin.x, `${angle}`).toBeCloseTo((1000 + dx) * MIL, 9); expect(pin.y, `${angle}`).toBeCloseTo((800 + dy) * MIL, 9);
      expect(pin.side).toBe('bottom'); expect(board.components[0].side).toBe('bottom'); expect(pin.rotation).toBeCloseTo(((angle + 180) % 360 + 360) % 360, 9);
    }
  });
  it('keeps a pad of a top component on the top, MULTI on both, and flips a TOP pad of a bottom component to the bottom', () => {
    const fp = footprintText([padRecord('e1', '1', 0, 0, ['RECT', 40, 20, 0], { layer: 12, hole: ['ROUND', 20, 20] }), padRecord('e2', '2', 50, 0, ['RECT', 40, 20, 0], { layer: 1 }), padRecord('e3', '3', 100, 0, ['RECT', 40, 20, 0], { layer: 2 })]);
    const recs = [...outlineLines(0, 0, 2000, 2000), ...component('t', 1, 500, 500, 0, { Footprint: FP_UUID, Designator: 'T1' }), ...component('b', 2, 1500, 500, 0, { Footprint: FP_UUID, Designator: 'B1' })];
    const board = parse(epro(recs, { footprints: { [FP_UUID]: fp } }));
    expect(['1', '2', '3'].map(n => pinOf(board, 'T1', n).side)).toEqual(['both', 'top', 'bottom']);
    expect(['1', '2', '3'].map(n => pinOf(board, 'B1', n).side)).toEqual(['both', 'bottom', 'top']);
    expect(pinOf(board, 'B1', '2').x).toBeCloseTo((1500 - 50) * MIL, 9);
  });
  it('uses a hole-only pad (no copper shape) at the hole size', () => {
    const fp = footprintText([padRecord('e1', '1', 0, 0, null, { layer: 12, hole: ['ROUND', 32, 32] })]);
    const board = parse(epro([...outlineLines(0, 0, 2000, 2000), ...component('t', 1, 500, 500, 0, { Footprint: FP_UUID, Designator: 'H1' }, [['1', 'N', 'e1']])], { footprints: { [FP_UUID]: fp } }));
    expect(pinOf(board, 'H1', '1')).toMatchObject({ shape: 'round', net: 'N' }); expect(pinOf(board, 'H1', '1').width).toBeCloseTo(32 * MIL, 9);
  });
  it('reads the layer table instead of assuming the default layer numbers', () => {
    const layers = [['LAYER', 21, 'TOP'], ['LAYER', 22, 'BOTTOM'], ['LAYER', 30, 'OUTLINE'], ['LAYER', 31, 'MULTI']];
    const fp = footprintText([padRecord('e1', '1', 30, 10, ['RECT', 40, 20, 0], { layer: 21 }), padRecord('e2', '2', -30, -10, ['RECT', 40, 20, 0], { layer: 31 })], layers);
    const board = parse(epro([...outlineLines(0, 0, 2000, 2000, 30), ...component('c', 22, 1000, 800, 0, { Footprint: FP_UUID, Designator: 'L1' })], { footprints: { [FP_UUID]: fp }, layers }));
    expect(board.components[0].side).toBe('bottom'); expect(board.bounds.maxX).toBeCloseTo(2000 * MIL, 9);
    expect(pinOf(board, 'L1', '1').side).toBe('bottom'); expect(pinOf(board, 'L1', '2').side).toBe('both');
  });
  it('falls back to the default layer numbers when the document has no LAYER records', () => {
    const board = parse(epro([...outlineLines(0, 0, 2000, 2000), ...part('c1', 2, 1000, 800, 0, 'U1')], { layers: [] }));
    expect(board.components[0].side).toBe('bottom'); expect(board.bounds.maxX).toBeCloseTo(2000 * MIL, 9);
  });
  it('shows no bottom-side note for a board without bottom parts and counts several', () => {
    expect(notes(at(1, 0)).some(text => /bottom-side/.test(text))).toBe(false);
    const board = parse(epro([...outlineLines(0, 0, 2000, 2000), ...part('a', 2, 500, 500, 0, 'U1'), ...part('b', 2, 900, 500, 0, 'U2')]));
    expect(notes(board).some(text => /^2 bottom-side components are placed/.test(text))).toBe(true);
  });
});

describe('EasyEDA Pro: attributes and nets', () => {
  const run = (comp: unknown[][], opts: Parameters<typeof epro>[1] = {}) => parse(epro([...outlineLines(0, 0, 2000, 2000), ...comp], opts));
  it('resolves Designator, Value and Name, templates one level deep, and a missing designator becomes FP<n>', () => {
    const board = run([...component('a', 1, 100, 100, 0, { Footprint: FP_UUID, Designator: 'R5', Name: '={Value}', Value: '22k' }), ...component('b', 1, 400, 100, 0, { Footprint: FP_UUID, Name: '={Nothing}' }), ...component('c', 1, 700, 100, 0, { Footprint: FP_UUID, Designator: 'R7', Value: '={Name}', Name: '={Value}' })]);
    expect(board.components.map(c => [c.ref, c.value, c.refGenerated])).toEqual([['R5', '22k', undefined], ['FP2', '', true], ['R7', '', undefined]]);
  });
  it('lets the pad id assignment win over the pad number, and falls back to the number when no id is listed', () => {
    const byId = run(part('a', 1, 500, 500, 0, 'U1', [['1', 'ID_NET', 'e1'], ['2', '', 'e2'], ['2', 'NUM_ONLY']]));
    expect(pinOf(byId, 'U1', '1').net).toBe('ID_NET'); expect(pinOf(byId, 'U1', '2').net).toBe('');
    const byNumber = run(part('a', 1, 500, 500, 0, 'U1', [['1', 'ONE'], ['2', 'TWO']]));
    expect(pinOf(byNumber, 'U1', '1').net).toBe('ONE'); expect(pinOf(byNumber, 'U1', '2').net).toBe('TWO');
  });
  it('keeps the first of two contradicting assignments and says how many conflicted', () => {
    const board = run(part('a', 1, 500, 500, 0, 'U1', [['1', 'FIRST', 'e1'], ['1', 'SECOND', 'e1'], ['2', 'X', 'e2']]));
    expect(pinOf(board, 'U1', '1').net).toBe('FIRST'); expect(notes(board)).toContain('1 pad net assignment conflicted with earlier ones; the first was kept.');
  });
  it('takes the footprint from the Device attribute through project.json when the part names none', () => {
    const projectJson = project({ devices: { d1: { title: 'Dev', attributes: { Footprint: FP_UUID } } } });
    const board = run(component('a', 1, 500, 500, 0, { Device: 'd1', Designator: 'U9' }, [['1', 'N', 'e1']]), { projectJson });
    expect(board.pins).toHaveLength(2); expect(board.components[0].package).toBe('TEST-FP');
  });
  it('shows a component whose footprint is missing as a position-only part and discloses its pad assignments', () => {
    const board = run([...part('a', 1, 500, 500, 0, 'U1'), ...component('m', 1, 900, 500, 0, { Footprint: 'ffffffffffffffffffffffffffffffff', Designator: 'U2' }, [['1', 'N'], ['2', 'M']])]);
    expect(board.components.map(c => c.ref)).toEqual(['U1', 'U2']); expect(board.pins.every(p => board.components.find(c => c.id === p.componentId)?.ref === 'U1')).toBe(true);
    expect(notes(board).some(text => /1 component has no footprint in the file, so it has no pads \(2 pad-net assignments could not be placed\)\./.test(text))).toBe(true);
    expect(board.warnings.some(w => w.key === 'parse.warning.fallbackComponents')).toBe(true);
  });
  it('numbers pads without a number ~1, ~2, keeps generated numbers out of the real ones and still matches them to nets by pad id', () => {
    const fp = footprintText([padRecord('e1', '', 0, 0, ['RECT', 10, 10, 0]), padRecord('e2', '~1', 50, 0, ['RECT', 10, 10, 0]), padRecord('e3', '', 100, 0, ['RECT', 10, 10, 0])]);
    const board = run(component('a', 1, 500, 500, 0, { Footprint: FP_UUID, Designator: 'U1' }, [['~1', 'REAL', 'e2'], ['', 'BY_ID', 'e1'], ['', 'NO_ID']]), { footprints: { [FP_UUID]: fp } });
    expect(board.pins.map(p => [p.number, p.numberGenerated, p.net])).toEqual([['~2', true, 'BY_ID'], ['~1', undefined, 'REAL'], ['~3', true, '']]); // a generated number never picks up a number-only assignment
  });
  it('gives a duplicate component id, an id-less COMPONENT and a document without DOCTYPE first a precise failure', () => {
    expectFailure(() => run([...part('a', 1, 500, 500, 0, 'U1'), ...part('a', 1, 900, 500, 0, 'U2')]), 'INVALID_FORMAT', /places component "a" twice/);
    expectFailure(() => run([['COMPONENT', '', 0, 1, 0, 0, 0, {}, 0]]), 'INVALID_FORMAT', /no id/);
    expect(parseEasyedaPro(textInput(lines([['HEAD', {}], ...LAYERS, ...part('a', 1, 500, 500, 0, 'U1')]), 'x.epcb'))).toBeNull(); // no DOCTYPE header: not recognized
    expectFailure(() => parse(zip({ 'project.json': '{}', 'PCB/p1.epcb': lines([['HEAD', {}], ...LAYERS, ...part('a', 1, 500, 500, 0, 'U1')]) }), 'x.epro'), 'INVALID_FORMAT', /does not start with DOCTYPE/);
  });
});

describe('EasyEDA Pro: board outline and polygons', () => {
  const run = (records: unknown[][]) => parse(epro([...part('a', 1, 500, 500, 0, 'U1'), ...records]));
  it('stitches unordered and reversed LINE records into one closed contour', () => {
    const board = run([['LINE', 'o3', 0, '', 11, 2000, 1000, 0, 1000, 10, 0], ['LINE', 'o1', 0, '', 11, 0, 0, 2000, 0, 10, 0], ['LINE', 'o4', 0, '', 11, 0, 1000, 0, 0, 10, 0], ['LINE', 'o2', 0, '', 11, 2000, 0, 2000, 1000, 10, 0]]);
    expect(board.outline).toHaveLength(4); expect(board.bounds.maxX).toBeCloseTo(2000 * MIL, 9); expect(board.warnings.some(w => w.key === 'parse.warning.missingBoardOutline')).toBe(false);
  });
  it('reads POLY outlines in every documented single-polygon mode', () => {
    const rect = run([['POLY', 'o1', 0, '', 11, 10, ['R', 0, 1000, 2000, 1000, 0], 0]]);
    expect(rect.bounds.minY).toBeCloseTo(0, 6); expect(rect.bounds.maxY).toBeCloseTo(1000 * MIL, 9); expect(rect.bounds.maxX).toBeCloseTo(2000 * MIL, 9); // top-left corner, extends right and down
    const circle = run([['POLY', 'o1', 0, '', 11, 10, ['CIRCLE', 1000, 500, 400], 0]]);
    expect(circle.bounds.maxX - circle.bounds.minX).toBeCloseTo(800 * MIL, 9); expect(notes(circle).some(text => /approximated by straight segments/.test(text))).toBe(true);
    const arcs = run([['POLY', 'o1', 0, '', 11, 10, [0, 0, 'L', 1000, 0, 'ARC', 180, 1000, 1000, 'L', 0, 1000, 0, 0], 0]]);
    expect(arcs.bounds.maxX).toBeGreaterThan(1000 * MIL); expect(arcs.bounds.maxX).toBeLessThan(1500.1 * MIL + 1e-9);
    const curve = run([['POLY', 'o1', 0, '', 11, 10, [0, 0, 'L', 1000, 0, 'C', 1500, 0, 1500, 1000, 1000, 1000, 'L', 0, 1000, 0, 0], 0]]);
    expect(curve.outline.length).toBeGreaterThan(30);
  });
  it('reads ARC and CARC outline records: a positive sweep is counter-clockwise and a negative one clockwise, as the vendor documents define it', () => {
    // From (0,0) to (1000,0) a clockwise half-turn passes over the top (y > 0); a counter-clockwise one passes below.
    const clockwise = run([['ARC', 'o1', 0, '', 11, 0, 0, 1000, 0, -180, 10, 0], ['LINE', 'o2', 0, '', 11, 1000, 0, 0, 0, 10, 0]]);
    expect(clockwise.bounds.minY).toBeCloseTo(0, 9); expect(clockwise.bounds.maxY).toBeCloseTo(500 * MIL, 6);
    const counter = run([['CARC', 'o1', 0, '', 11, 0, 0, 1000, 0, 180, 10, 0], ['LINE', 'o2', 0, '', 11, 1000, 0, 0, 0, 10, 0]]);
    expect(counter.bounds.minY).toBeCloseTo(-500 * MIL, 6); expect(counter.bounds.maxY).toBeCloseTo(0, 9);
    // A clockwise quarter turn from (0,0) to (1000,1000) is centred on (1000,0): it passes through (293,707), above the diagonal.
    const quarter = run([['ARC', 'o1', 0, '', 11, 0, 0, 1000, 1000, -90, 10, 0], ['LINE', 'o2', 0, '', 11, 1000, 1000, 0, 0, 10, 0]]);
    expect(quarter.bounds.minX).toBeCloseTo(0, 9); expect(quarter.bounds.minY).toBeCloseTo(0, 9); expect(quarter.bounds.maxX).toBeCloseTo(1000 * MIL, 9); expect(quarter.bounds.maxY).toBeCloseTo(1000 * MIL, 9);
    expect(quarter.outline.some(p => p.y > p.x + 100 * MIL)).toBe(true); // a point well above the diagonal
    expect(quarter.outline.some(p => p.y < p.x - 100 * MIL)).toBe(false); // none below it
  });
  it('keeps the outer loop of a complex polygon and discloses the inner one as a cutout', () => {
    const board = run([['POLY', 'o1', 0, '', 11, 10, [[0, 0, 'L', 2000, 0, 2000, 1000, 0, 1000, 0, 0], [500, 300, 'L', 900, 300, 900, 600, 500, 600, 500, 300]], 0]]);
    expect(board.outline).toHaveLength(4); expect(board.bounds.maxX).toBeCloseTo(2000 * MIL, 9); expect(board.warnings.some(w => w.key === 'parse.warning.boardCutouts')).toBe(true);
  });
  it('ignores records on other layers, estimates the boundary when the outline is open or missing, and says so', () => {
    const other = run(outlineLines(0, 0, 2000, 1000, 1));
    expect(other.warnings.some(w => w.key === 'parse.warning.missingBoardOutline')).toBe(true);
    const open = run(outlineLines(0, 0, 2000, 1000).slice(0, 3));
    expect(notes(open).some(text => /does not form a closed contour/.test(text))).toBe(true); expect(open.warnings.some(w => w.key === 'parse.warning.missingBoardOutline')).toBe(true);
    const spur = run([...outlineLines(0, 0, 2000, 1000), ['LINE', 's', 0, '', 11, 2000, 1000, 3000, 2000, 10, 0]]);
    expect(spur.outline).toHaveLength(4); expect(notes(spur).some(text => /open EasyEDA outline chain/.test(text))).toBe(true);
  });
  it('rejects undocumented polygon modes and cut-short polygons', () => {
    expectFailure(() => run([['POLY', 'o1', 0, '', 11, 10, [0, 0, 'Q', 1, 2, 3, 4], 0]]), 'UNSUPPORTED_VARIANT', /"Q" mode/);
    expectFailure(() => run([['POLY', 'o1', 0, '', 11, 10, [0, 0, 'L', 1, 2, 3], 0]]), 'INVALID_FORMAT', /cut short/);
    expectFailure(() => run([['POLY', 'o1', 0, '', 11, 10, ['L', 1, 2], 0]]), 'INVALID_FORMAT', /coordinate pair/);
    expectFailure(() => run([['POLY', 'o1', 0, '', 11, 10, 'nope', 0]]), 'INVALID_FORMAT', /not a list/);
    expectFailure(() => run([['LINE', 'o1', 0, '', 11, 0, 0, 'x', 1, 10, 0]]), 'INVALID_FORMAT');
  });
});

describe('EasyEDA Pro: bare .epcb documents', () => {
  it('shows placed parts without pads and says why', () => {
    const board = parse(pcbText([...outlineLines(0, 0, 2000, 1000), ...part('a', 1, 500, 500, 0, 'U1'), ...part('b', 2, 900, 500, 90, 'U2')]), 'x.epcb');
    expect(board.components.map(c => [c.ref, c.side])).toEqual([['U1', 'top'], ['U2', 'bottom']]); expect(board.pins).toHaveLength(0);
    expect(notes(board)[0]).toMatch(/bare \.epcb document has no footprints/); expect(board.warnings.some(w => w.key === 'parse.warning.fallbackComponents')).toBe(true);
  });
  it('rejects an empty PCB document (no components)', () => {
    expectFailure(() => parse(pcbText([]), 'x.epcb'), 'INVALID_FORMAT', /no components/);
  });
  it('decodes UTF-8 designators and windows-1252 text and tolerates CRLF and blank lines', () => {
    const text = pcbText([...outlineLines(0, 0, 2000, 1000), ...part('a', 1, 500, 500, 0, 'Ü1')]).replace(/\n/g, '\r\n\r\n');
    expect(parse(text, 'x.epcb').components[0].ref).toBe('Ü1');
    const latin = Uint8Array.from(Array.from(pcbText([...outlineLines(0, 0, 2000, 1000), ...part('a', 1, 500, 500, 0, 'R\u00e9')]), ch => ch.charCodeAt(0)));
    expect(parse(latin, 'x.epcb').components[0].ref).toBe('R\u00e9');
  });
  it('skips lines of record types it does not read without parsing them, but still requires every line to be an array', () => {
    const base = pcbText([...outlineLines(0, 0, 2000, 1000), ...part('a', 1, 500, 500, 0, 'U1')]);
    expect(parse(`${base}\n["FONT", this is not json]\n["RULE", {"x": 1}]`, 'x.epcb').components).toHaveLength(1);
    expectFailure(() => parse(`${base}\n{"a":1}`, 'x.epcb'), 'INVALID_FORMAT', /not a JSON array/);
    expectFailure(() => parse(`${base}\nplain text`, 'x.epcb'), 'INVALID_FORMAT', /not a JSON array/);
  });
});

describe('EasyEDA Pro: malformed and hostile documents', () => {
  const good = (): unknown[][] => [...outlineLines(0, 0, 2000, 2000), ...part('a', 1, 500, 500, 0, 'U1')];
  const bare = (records: unknown[][], extra = '') => parse(`${pcbText(records)}${extra}`, 'x.epcb');
  it('rejects broken JSON in a record it reads, naming the line', () => {
    expectFailure(() => parse(`${pcbText(good())}\n["LINE", "x", 0,`, 'x.epcb'), 'INVALID_FORMAT', /(?:not a JSON array|not valid JSON)/);
    expectFailure(() => parse(`${pcbText(good())}\n["PAD", 1, 2,]`, 'x.epcb'), 'INVALID_FORMAT', /line \d+ of the PCB document is not valid JSON/);
  });
  it('rejects non-finite, non-numeric and oversized numbers and non-integer layer numbers', () => {
    for (const bad of ['"abc"', 'null', '{}', '"0x10"', '"1e999"', '"NaN"', '[]']) expectFailure(() => bare([...good(), ['COMPONENT', 'z', 0, 1, JSON.parse(bad), 0, 0, {}, 0]]), 'INVALID_FORMAT');
    expectFailure(() => bare([...good(), ['COMPONENT', 'z', 0, 1, 1e12, 0, 0, {}, 0]]), 'INVALID_FORMAT', /magnitude/);
    expectFailure(() => bare([...good(), ['COMPONENT', 'z', 0, 1.5, 0, 0, 0, {}, 0]]), 'INVALID_FORMAT', /layer/);
    expectFailure(() => bare([...good(), ['LINE', 'z', 0, '', -3, 0, 0, 1, 1, 10, 0]]), 'INVALID_FORMAT', /layer/);
  });
  it('rejects a format version that is not 1.x and a document that is not a PCB', () => {
    expectFailure(() => parse(pcbText(good(), { version: '2.0' }), 'x.epcb'), 'UNSUPPORTED_VARIANT', /version 2\.0/);
    expect(parse(pcbText(good(), { version: '1' }), 'x.epcb').components).toHaveLength(1);
  });
  it('rejects malformed PAD_NET records', () => {
    expectFailure(() => bare([...good(), ['PAD_NET', 'a', {}, 'N']]), 'INVALID_FORMAT', /PAD_NET/);
    expectFailure(() => bare([...good(), ['PAD_NET', 5, '1', 'N']]), 'INVALID_FORMAT', /PAD_NET/);
    expectFailure(() => bare([...good(), ['PAD_NET', 'a', '1']]), 'INVALID_FORMAT', /PAD_NET/);
  });
  it('rejects pads on layers other than TOP, BOTTOM and MULTI, undocumented shapes and pads without any shape', () => {
    const run = (pads: unknown[][]) => parse(epro(good(), { footprints: { [FP_UUID]: footprintText(pads) } }));
    expectFailure(() => run([padRecord('e1', '1', 0, 0, ['RECT', 10, 10, 0], { layer: 3 })]), 'UNSUPPORTED_VARIANT', /layer 3/);
    expectFailure(() => run([padRecord('e1', '1', 0, 0, ['STAR', 10, 10, 0])]), 'UNSUPPORTED_VARIANT', /STAR/);
    expectFailure(() => run([padRecord('e1', '1', 0, 0, null, { layer: 12 })]), 'UNSUPPORTED_VARIANT', /no shape definition/);
    expectFailure(() => run([padRecord('e1', '1', 0, 0, ['POLY', []])]), 'INVALID_FORMAT', /empty polygon/);
  });
  it('rejects a footprint document that is not a footprint, does not start with DOCTYPE or is empty', () => {
    const run = (text: string) => parse(epro(good(), { footprints: { [FP_UUID]: text } }));
    expectFailure(() => run(lines([['DOCTYPE', 'SYMBOL', '1.8']])), 'INVALID_FORMAT', /of type "SYMBOL"/);
    expectFailure(() => run(lines([['HEAD', {}], ['PAD']])), 'INVALID_FORMAT', /does not start with DOCTYPE/);
    expectFailure(() => run(''), 'INVALID_FORMAT', /footprint document is empty/);
  });
  it('rejects an unreadable project.json', () => {
    expectFailure(() => parse(epro(good(), { projectJson: '{ not json' })), 'INVALID_FORMAT', /project\.json is not valid JSON/);
    expectFailure(() => parse(epro(good(), { projectJson: '[1,2]' })), 'INVALID_FORMAT', /not an object/);
    expect(parse(epro(good(), { projectJson: '{"pcbs": 5, "footprints": [], "devices": 7}' })).components).toHaveLength(1);
  });
  it('bounds the line length, record count, component count and expanded pin count', () => {
    expectFailure(() => bare(good(), `\n["POLY","x",0,"",11,10,[${'1,'.repeat(9_000_000)}1],0]`), 'LIMIT_EXCEEDED', /longer than/);
    expectFailure(() => bare(good(), `\n${'[]\n'.repeat(3_000_001)}`), 'LIMIT_EXCEEDED', /more than 3000000 records/);
    expectFailure(() => bare(Array.from({ length: 250_001 }, (_, i) => ['COMPONENT', `c${i}`, 0, 1, 0, 0, 0, {}, 0])), 'LIMIT_EXCEEDED');
    const wide = footprintText(Array.from({ length: 1000 }, (_, i) => padRecord(`e${i}`, String(i + 1), i, 0, ['RECT', 1, 1, 0])));
    const parts = Array.from({ length: 1001 }, (_, i) => component(`c${i}`, 1, i, 0, 0, { Footprint: FP_UUID })).flat();
    expectFailure(() => parse(epro(parts, { footprints: { [FP_UUID]: wide } })), 'LIMIT_EXCEEDED', /more than 1000000 pins/);
  }, 300_000);
  it('bounds the sampled points of arcs and nested structures', () => {
    const arcs = Array.from({ length: 45_000 }, (_, i) => [270, i % 2 ? 0 : 10, 0]).flat(); // each arc has a real chord, so each one is sampled
    expectFailure(() => bare([...good(), ['POLY', 'x', 0, '', 11, 10, [0, 0, 'ARC', ...arcs], 0]]), 'LIMIT_EXCEEDED', /sampled points/);
    expectFailure(() => bare([...good(), ['POLY', 'x', 0, '', 11, 10, [0, 0, 'L', ...Array.from({ length: 200_002 }, () => 1)], 0]]), 'LIMIT_EXCEEDED', /more than 200000 elements/);
    const nested = `["LINE","x",0,"",11,0,0,${'['.repeat(100_000)}${']'.repeat(100_000)},1,10,0]`;
    try { expect(() => bare(good(), `\n${nested}`)).toThrow(BoardFormatError); } catch (error) { expect(error).toBeInstanceOf(BoardFormatError); }
  });
  it('does not let __proto__ or constructor attribute keys reach Object.prototype', () => {
    const board = parse(epro([...outlineLines(0, 0, 2000, 2000), ...component('a', 1, 500, 500, 0, { Footprint: FP_UUID, Designator: 'U1', __proto__x: 'y', constructor: 'z' }, [['1', 'N', 'e1']])]));
    expect(board.components[0].ref).toBe('U1'); expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const hostile = `{"pcbs":{"__proto__":"x","p1":"PCB"},"footprints":{"__proto__":{"title":"t"},"${FP_UUID}":{"title":"TEST"}},"devices":{"__proto__":{"attributes":{"Footprint":"q"}}}}`;
    expect(parse(epro(good(), { projectJson: hostile })).components).toHaveLength(1); expect(({} as Record<string, unknown>).title).toBeUndefined();
  });
});

describe('EasyEDA Pro: ZIP container', () => {
  const base = () => zip({ 'project.json': project(), 'PCB/p1.epcb': pcbText([...outlineLines(0, 0, 2000, 2000), ...part('a', 1, 500, 500, 0, 'U1')]), [`FOOTPRINT/${FP_UUID}.efoo`]: FP });
  const u32 = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
  /** Offsets of the central directory header and the local header of the entry called `name`. */
  const find = (data: Uint8Array, name: string): { central: number; local: number } => {
    const view = u32(data); let eocd = data.length - 22; while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
    let at = view.getUint32(eocd + 16, true);
    for (let index = 0; index < view.getUint16(eocd + 10, true); index++) {
      const nameLength = view.getUint16(at + 28, true), found = new TextDecoder().decode(data.subarray(at + 46, at + 46 + nameLength));
      if (found === name) return { central: at, local: view.getUint32(at + 42, true) };
      at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
    throw new Error(`no entry ${name}`);
  };
  const patched = (name: string, patch: (central: DataView, local: DataView) => void): Uint8Array => {
    const data = base().slice(), { central, local } = find(data, name);
    patch(new DataView(data.buffer, central), new DataView(data.buffer, local)); return data;
  };

  it('reads stored and deflated entries and entry names written with backslashes', () => {
    expect(parse(zip({ 'project.json': project(), 'PCB\\p1.epcb': pcbText([...outlineLines(0, 0, 2000, 2000), ...part('a', 1, 500, 500, 0, 'U1')]), [`FOOTPRINT\\${FP_UUID}.efoo`]: FP }, 0), 'x.epro').pins).toHaveLength(2);
    expect(parse(base(), 'x.epro').pins).toHaveLength(2);
    expect(parse(zip({ 'PCB/p1.epcb': pcbText([...outlineLines(0, 0, 2000, 2000), ...part('a', 1, 500, 500, 0, 'U1')]) }), 'x.zip').components).toHaveLength(1); // no project.json, no footprints
  });
  it('orders PCB documents by project.json and by name otherwise, taking the first that has parts', () => {
    const empty = pcbText([]), full = pcbText([...outlineLines(0, 0, 2000, 2000), ...part('a', 1, 500, 500, 0, 'U1')]);
    const files = { 'project.json': project({ pcbs: { zz: 'Second', aa: 'First' } }), 'PCB/aa.epcb': empty, 'PCB/zz.epcb': full, [`FOOTPRINT/${FP_UUID}.efoo`]: FP };
    expect(parse(zip(files), 'x.epro').components).toHaveLength(1);
  });
  it('rejects a PCB entry in the V3 log format', () => {
    expectFailure(() => parse(zip({ 'project.json': '{}', 'PCB/p1': '{"type":"DOCHEAD"}||{"docType":"PCB"}||\n{"type":"x"}' }), 'x.epro'), 'UNSUPPORTED_VARIANT', /V3/);
  });
  it('rejects a wrong CRC-32', () => {
    const data = patched('PCB/p1.epcb', central => central.setUint32(16, central.getUint32(16, true) ^ 1, true));
    expectFailure(() => parse(data, 'x.epro'), 'INVALID_FORMAT', /CRC-32/);
  });
  it('rejects a header that declares fewer or more bytes than the stream inflates to, and never inflates past the declared size', () => {
    expectFailure(() => parse(patched('PCB/p1.epcb', central => central.setUint32(24, 100, true)), 'x.epro'), 'INVALID_FORMAT', /expands beyond its declared 100 bytes/);
    expectFailure(() => parse(patched('PCB/p1.epcb', central => central.setUint32(24, central.getUint32(24, true) + 50, true)), 'x.epro'), 'INVALID_FORMAT', /holds \d+ bytes but declares/);
  });
  it('stops a deflate bomb that lies about its size after the declared bytes instead of inflating it', () => {
    const bomb = deflateSync(new Uint8Array(60_000_000)); expect(bomb.length).toBeLessThan(100_000);
    const name = strToU8('PCB/p1.epcb'), declared = 64;
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, 8, true); lv.setUint32(18, bomb.length, true); lv.setUint32(22, declared, true); lv.setUint16(26, name.length, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(10, 8, true); cv.setUint32(20, bomb.length, true); cv.setUint32(24, declared, true); cv.setUint16(28, name.length, true); central.set(name, 46);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, central.length, true); ev.setUint32(16, local.length + bomb.length, true);
    const archive = new Uint8Array(local.length + bomb.length + central.length + end.length);
    archive.set(local); archive.set(bomb, local.length); archive.set(central, local.length + bomb.length); archive.set(end, local.length + bomb.length + central.length);
    expectFailure(() => parse(archive, 'x.epcb.zip'), 'INVALID_FORMAT', /expands beyond its declared 64 bytes/);
    // The bomb inflates to 60 MB, the declaration says 64 bytes: refusing it costs a small fraction of inflating it (the inflater of the compression library is the reference).
    expectCostAtMost('refusing a deflate bomb', catching(() => parse(archive, 'x.epcb.zip')), () => inflateSync(bomb), 0.6);
  });
  it('rejects an entry that declares more than the per-entry limit without inflating it', () => {
    expectFailure(() => parse(patched('PCB/p1.epcb', central => central.setUint32(24, 200 * 1024 * 1024, true)), 'x.epro'), 'LIMIT_EXCEEDED', /declares \d+ bytes; the limit is/);
  });
  it('rejects encrypted entries, other compression methods and ZIP64 markers as unsupported', () => {
    expectFailure(() => parse(patched('PCB/p1.epcb', central => central.setUint16(8, central.getUint16(8, true) | 1, true)), 'x.epro'), 'UNSUPPORTED_VARIANT', /encrypted/);
    expectFailure(() => parse(patched('PCB/p1.epcb', central => central.setUint16(10, 12, true)), 'x.epro'), 'UNSUPPORTED_VARIANT', /compression method 12/);
    expectFailure(() => parse(patched('PCB/p1.epcb', central => central.setUint32(24, 0xffffffff, true)), 'x.epro'), 'UNSUPPORTED_VARIANT', /ZIP64/);
  });
  it('rejects two entries with one name and an entry whose data lies outside the archive', () => {
    const twice = zip({ 'project.json': project(), 'PCB/p1.epcb': pcbText([]), 'PCB/p2.epcb': pcbText([]) }).slice(), { central } = find(twice, 'PCB/p2.epcb');
    twice.set(strToU8('PCB/p1.epcb'), central + 46);
    expectFailure(() => parse(twice, 'x.epro'), 'INVALID_FORMAT', /lists "PCB\/p1\.epcb" twice/);
    expectFailure(() => parse(patched('PCB/p1.epcb', central => central.setUint32(20, 0x7fffffff, true)), 'x.epro'), 'INVALID_FORMAT', /extends beyond the archive/);
    expectFailure(() => parse(patched('PCB/p1.epcb', central => central.setUint32(42, 0x7fffff00, true)), 'x.epro'), 'INVALID_FORMAT', /no local header/);
  });
  it('rejects a damaged central directory and says the archive is unreadable for a file named .epro', () => {
    const data = base().slice(), eocd = data.length - 22;
    new DataView(data.buffer).setUint32(eocd + 16, 5, true); // central directory offset points into the first entry
    expectFailure(() => parse(data, 'x.epro'), 'INVALID_FORMAT', /central directory is damaged/);
    expect(parseEasyedaPro({ name: 'x.bin', data })).toBeNull(); // not named as a project: left to other readers
    expectFailure(() => parse(base().subarray(0, base().length - 10), 'x.epro'), 'INVALID_FORMAT', /not a readable ZIP archive/);
    expectFailure(() => parse(zip({ 'readme.txt': 'hello' }), 'x.epro'), 'INVALID_FORMAT', /holds no EasyEDA Pro project/);
  });
  it('limits the entry count and names that are too long, and never treats names as file system paths', () => {
    const many = base().slice(), eocd = many.length - 22;
    new DataView(many.buffer).setUint16(eocd + 10, ZIP_MAX_ENTRIES + 1, true); // the end record claims one entry too many
    expectFailure(() => parse(many, 'x.epro'), 'LIMIT_EXCEEDED', /entries/);
    expectFailure(() => parse(zip({ [`PCB/${'x'.repeat(2000)}`]: 'a' }), 'x.epro'), 'LIMIT_EXCEEDED', /name is too long/);
    const evil = zip({ 'project.json': project(), '../../PCB/p1.epcb': pcbText([...part('a', 1, 500, 500, 0, 'U1')]), '/PCB/p2.epcb': pcbText([]), 'C:\\PCB\\p3.epcb': pcbText([]) });
    expectFailure(() => parse(evil, 'x.epro'), 'INVALID_FORMAT', /no components/); // only "/PCB/p2.epcb" (leading slash dropped) counts as a PCB entry; the traversal and drive names are inert keys
  });
  it('does not follow nested archives and exposes a bounded zip reader', () => {
    const inner = base();
    expectFailure(() => parse(zip({ 'project.json': '{}', 'PCB/p1.epcb': inner }), 'x.epro'), 'INVALID_FORMAT');
    const archive = openZip(zip({ 'a.txt': 'hello world' }), 'test')!;
    const entry = archive.byName.get('a.txt')!;
    expect(new TextDecoder().decode(archive.read(entry))).toBe('hello world'); expect(archive.produced).toBe(11);
    expect(() => archive.read(entry, 5)).toThrow(/limit is 5/);
    expect(crc32(strToU8('123456789'))).toBe(0xcbf43926);
    expect(openZip(strToU8('not a zip at all, just text'), 'test')).toBeNull();
    expect(openZip(new Uint8Array(10), 'test')).toBeNull();
  });
});

describe('EasyEDA Pro: linear-time parsing', () => {
  const boardText = (parts: number): Uint8Array => {
    const records: unknown[][] = [...outlineLines(0, 0, 400_000, 400_000)];
    for (let i = 0; i < parts; i++) records.push(...component(`c${i}`, i % 5 === 0 ? 2 : 1, (i % 400) * 100, Math.floor(i / 400) * 100, i % 4 * 90, { Footprint: FP_UUID, Designator: `U${i}`, Value: `${i}` }, [['1', `N${i % 991}`, 'e1'], ['2', `N${(i + 1) % 991}`, 'e2']]));
    return epro(records);
  };
  it('parses a 20,000-part project in linear time', () => {
    // The time over the number of parts: a pass per part over all parts is quadratic, 16 times the time for 4 times the parts.
    expectScaling('parts of a project', [2500, 10_000, 40_000], parts => { const data = boardText(parts); return () => parse(data); });
    const board = parse(boardText(40_000));
    expect(board.components).toHaveLength(40_000); expect(board.pins).toHaveLength(80_000);
  }, 300_000);
  it('does not go quadratic on long runs of brackets, quotes, commas or blank lines', () => {
    const good = pcbText([...outlineLines(0, 0, 2000, 2000), ...part('a', 1, 500, 500, 0, 'U1')]);
    const unit = (text: string) => (size: number) => text.repeat(Math.ceil(size / text.length));
    const fillers: Array<[string, (size: number) => string]> = [['brackets', unit('[')], ['quotes', unit('"')], ['commas', unit(',')], ['blank lines', unit('\n')], ['blanks', unit(' ')], ['backslashes', unit('\\')], ['empty arrays', unit('[]\n')]];
    const after = (filler: string) => `${good}\n${filler}`;
    const inAttribute = (filler: string) => `${good}\n["ATTR","x",0,"${filler.replace(/["\\\n]/g, '')}"]`;
    const read = (text: string) => parseEasyedaPro({ name: 'x.epcb', data: strToU8(text) });
    // Ascending sizes: a pattern that retries every position of a run needs seconds for 500,000 characters, so a regression fails at the first pair.
    for (const [label, filler] of fillers) {
      expectScaling(`${label} after the board`, [20_000, 80_000, 500_000], size => { const text = after(filler(size)); return catching(() => read(text)); });
      expectScaling(`${label} inside an attribute`, [20_000, 80_000, 500_000], size => { const text = inAttribute(filler(size)); return catching(() => read(text)); });
    }
    // Whatever the run does, the reader refuses with its own error and never with another one.
    for (const [, filler] of fillers) for (const text of [after(filler(500_000)), inAttribute(filler(500_000))]) { try { read(text); } catch (error) { expect(error).toBeInstanceOf(BoardFormatError); } }
  }, 300_000);
  it('stitches a 100,000-segment board outline in linear time', () => {
    const ringOf = (segments: number) => Array.from({ length: segments }, (_, i): unknown[] => { const a = 2 * Math.PI * i / segments, b = 2 * Math.PI * (i + 1) / segments; return ['LINE', `o${i}`, 0, '', 11, 50_000 + 40_000 * Math.cos(a), 50_000 + 40_000 * Math.sin(a), 50_000 + 40_000 * Math.cos(b), 50_000 + 40_000 * Math.sin(b), 10, 0]; });
    expectScaling('outline segments', [6250, 25_000, 100_000], segments => { const data = epro([...part('a', 1, 50_000, 50_000, 0, 'U1'), ...ringOf(segments)]); return () => parse(data); });
    expect(parse(epro([...part('a', 1, 50_000, 50_000, 0, 'U1'), ...ringOf(100_000)])).outline.length).toBe(100_000);
  }, 300_000);
  it('sniffs a very large document and a large archive without reading past the head or the directory', () => {
    // The time does not depend on the size of the document or of the entry: only the head and the directory are read.
    const document = (size: number) => strToU8(`${pcbText([])}\n["FONT","${'x'.repeat(size)}"]`);
    const archive = (size: number) => zip({ 'project.json': '{}', 'PCB/p1.epcb': 'x'.repeat(size) });
    expectBoundedWork('large document', [1_000_000, 10_000_000, 40_000_000], size => { const data = document(size); return () => sniffEasyedaPro(data); });
    expectBoundedWork('large archive', [1_000_000, 10_000_000, 30_000_000], size => { const data = archive(size); return () => sniffEasyedaPro(data); });
    expect(sniffEasyedaPro(document(40_000_000))?.confidence).toBe(0.99);
    expect(sniffEasyedaPro(archive(30_000_000))?.confidence).toBe(0.95);
  });
});
