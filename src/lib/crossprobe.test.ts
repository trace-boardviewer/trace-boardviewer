import { describe, expect, it, vi } from 'vitest';
import type { Board, BoardSide } from './types';
import type { Hit, RefCandidate } from './pdf/search';
import type { RefCandidateResult } from './pdf/session-contract';
import { pinKey, symbolKey, symbolRef } from './schematic/model';
import type { SchNet, SchNetMember, SchPin, SchSheetDef, SchSheetInstance, SchSymbol, SchematicDesign } from './schematic/model';
import {
  buildBoardIndex, buildSchematicIndex, boardComponentsByRef, boardNetsByName, boardPinsByNumber, compileAliases, linkBoardSchematic, mapBoardNetToSchematic, mapBoardSelectionToSchematic,
  mapSchematicNetToBoard, mapSchematicSelectionToBoard, naturalCompare, normalizeKey, resolvePdfDocuments, resolvePdfRefHits, searchAll,
} from './crossprobe';
import type { BoardIndex, SchematicIndex } from './crossprobe';

// ---------------------------------------------------------------------------------------------------------------
// Original synthetic builders (nothing shared with the parsers)
// ---------------------------------------------------------------------------------------------------------------

interface BoardSpec { ref: string; id?: string; value?: string; pkg?: string; side?: BoardSide; pins: Array<[string, string]> }
function makeBoard(specs: BoardSpec[]): Board {
  const components: Board['components'] = [], pins: Board['pins'] = [];
  const netPins = new Map<string, string[]>();
  specs.forEach((spec, i) => {
    const id = spec.id ?? `c${i}`, side = spec.side ?? 'top';
    const pinIds: string[] = [];
    for (const [number, net] of spec.pins) {
      const pinId = `${id}.${number}.${pins.length}`;
      pins.push({ id: pinId, componentId: id, number, name: '', net, side, radius: 0.2, shape: 'round', x: i, y: 0 });
      pinIds.push(pinId);
      if (net) { const list = netPins.get(net); if (list) list.push(pinId); else netPins.set(net, [pinId]); }
    }
    components.push({ id, ref: spec.ref, value: spec.value ?? '', package: spec.pkg ?? '', side, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, position: { x: i, y: 0 }, rotation: 0, pinIds, outline: [] });
  });
  const nets = [...netPins].map(([name, pinIds], k) => ({ id: `n${k}`, name, pinIds }));
  return { name: 'synthetic', format: 'test', units: 'mm', components, pins, nets, outline: [], bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, warnings: [] };
}

interface SymSpec { id: string; ref: string | Record<string, string>; unit?: number; unitCount?: number; libId?: string; value?: string; footprint?: string; virtual?: boolean; dnp?: boolean; pins: string[] }
interface DefSpec { id: string; symbols: SymSpec[] }
interface InstSpec { path: string; defId: string; name?: string; parent?: string | null }
type PinRef = [instancePath: string, symbolId: string, pinNumber: string];
interface NetSpec { name: string; auto?: boolean; scope?: SchNet['scope']; scopePath?: string; aliases?: string[]; pins: PinRef[] }
interface DesignSpec { name?: string; defs: DefSpec[]; instances: InstSpec[]; nets: NetSpec[]; noConnect?: PinRef[] }

function makeDesign(spec: DesignSpec): SchematicDesign {
  const point = { x: 0, y: 0 }, bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const specById = new Map<string, SymSpec>(), symbols = new Map<string, SchSymbol>();
  const defs: SchSheetDef[] = spec.defs.map(def => ({
    id: def.id, name: def.id, file: `${def.id}.kicad_sch`, title: '', titleBlock: {}, wires: [], buses: [], busEntries: [], junctions: [], noConnects: [], labels: [], sheetRefs: [], graphics: [], bounds,
    symbols: def.symbols.map(s => {
      const unit = s.unit ?? 1;
      const instances = typeof s.ref === 'string' ? { '': { ref: s.ref, unit } } : Object.fromEntries(Object.entries(s.ref).map(([path, ref]) => [path, { ref, unit }]));
      const pins: SchPin[] = s.pins.map(number => ({ id: `${s.id}#${number}`, number, name: `P${number}`, at: point, body: point, type: 'passive' as const, hidden: false, unit }));
      const symbol: SchSymbol = {
        id: s.id, libId: s.libId ?? 'Device:X', refDefault: typeof s.ref === 'string' ? s.ref : '?', instances, value: s.value ?? '', footprint: s.footprint ?? '', datasheet: '', unit, unitCount: s.unitCount ?? 1, at: point, rotation: 0, mirror: 'none',
        pins, graphics: [], fields: [], virtual: s.virtual ?? false, dnp: s.dnp ?? false, bounds,
      };
      specById.set(def.id + '\u0000' + s.id, s); symbols.set(def.id + '\u0000' + s.id, symbol);
      return symbol;
    }),
  }));
  const instances: SchSheetInstance[] = spec.instances.map((inst, i) => ({
    path: inst.path, defId: inst.defId, name: inst.name ?? (inst.path || 'root'), page: String(i + 1), parentPath: inst.parent === undefined ? (inst.path ? '' : null) : inst.parent, sheetRefId: inst.path ? inst.path.split('/').pop()! : null,
    childPaths: spec.instances.filter(other => (other.parent === undefined ? (other.path ? '' : null) : other.parent) === inst.path && other.path !== inst.path).map(other => other.path), depth: inst.path ? inst.path.split('/').length : 0,
  }));
  const defOf = (path: string) => spec.instances.find(i => i.path === path)!.defId;
  const resolve = ([path, symbolId, number]: PinRef) => {
    const defId = defOf(path), symbol = symbols.get(defId + '\u0000' + symbolId)!;
    const pin = symbol.pins.find(p => p.number === number)!;
    return { path, defId, symbol, pin };
  };
  const pinNet: Record<string, string> = {};
  const counters = { auto: 0 };
  const nets: SchNet[] = spec.nets.map(n => {
    const scope = n.scope ?? 'global';
    const id = n.auto ? `net:auto:${counters.auto++}` : scope === 'global' ? `net:global:${n.name}` : `net:local:${n.scopePath ?? ''}:${n.name}`;
    const members: SchNetMember[] = n.pins.map(ref => {
      const { path, defId, symbol, pin } = resolve(ref);
      pinNet[pinKey(path, symbol.id, pin.id)] = id;
      return { instancePath: path, defId, symbolId: symbol.id, pinId: pin.id, ref: symbolRef(symbol, path), unit: symbol.unit, pinNumber: pin.number, pinName: pin.name };
    });
    return { id, name: n.name, auto: n.auto ?? false, scope, scopePath: n.scopePath, aliases: n.aliases ?? [n.name], members, wires: [] };
  });
  const noConnectPins = (spec.noConnect ?? []).map(ref => { const { path, symbol, pin } = resolve(ref); return pinKey(path, symbol.id, pin.id); });
  const floatingPins: string[] = [];
  for (const inst of spec.instances) for (const symbol of symbols.values()) {
    if (![...spec.defs.find(d => d.id === inst.defId)!.symbols].some(s => s.id === symbol.id)) continue;
    for (const pin of symbol.pins) { const key = pinKey(inst.path, symbol.id, pin.id); if (!(key in pinNet) && !noConnectPins.includes(key)) floatingPins.push(key); }
  }
  return {
    schematic: { format: 'kicad-sch', formatLabel: 'synthetic', sourceUnit: 'mm', name: spec.name ?? 'golden', defs, rootDefId: spec.defs[0].id, instances, diagnostics: [] },
    connectivity: { nets, pinNet, wireNet: {}, noConnectPins, floatingPins, diagnostics: [] },
  };
}

const hit = (page: number, itemIndex: number, context: string): Hit => ({ page, itemIndex, x: 10 * itemIndex, y: 20, width: 30, height: 8, context });

// ---------------------------------------------------------------------------------------------------------------
// The golden pair
// ---------------------------------------------------------------------------------------------------------------

const goldenBoard = (): Board => makeBoard([
  { ref: 'U1', value: 'MCU', pkg: 'QFN-5', pins: [['1', 'VCC'], ['2', 'GND'], ['3', 'SDA'], ['4', 'SCL'], ['5', '']] },
  { ref: 'R1', value: '10k', pkg: '0402', pins: [['1', 'SDA'], ['2', 'VCC']] },
  { ref: 'r1', value: '1k', pkg: '0402', side: 'bottom', pins: [['1', 'LED_A'], ['2', 'GND']] },
  { ref: 'C1', value: '100n', pkg: '0402', pins: [['1', 'VCC'], ['2', 'GND']] },
  { ref: 'C9', value: '1u', pins: [['1', 'VCC'], ['2', 'GND']] },
  { ref: 'C9', value: '1u', side: 'bottom', pins: [['1', 'VCC'], ['2', 'GND']] },
  { ref: 'TP1', pins: [['1', 'SDA']] },
  { ref: 'U2', value: 'OPAMP', pins: [['1', 'A_IN'], ['2', 'MID'], ['3', 'GND'], ['4', 'B_IN'], ['5', 'NC_B'], ['6', 'VCC'], ['7', 'GND']] },
  { ref: 'R20', pins: [['1', 'CH1'], ['2', 'GND']] },
  { ref: 'R30', pins: [['1', 'CH'], ['2', 'GND']] },
  { ref: 'R21', pins: [['1', 'CH2'], ['2', 'GND']] },
]);
// ids: U1=c0 R1=c1 r1=c2 C1=c3 C9=c4,c5 TP1=c6 U2=c7 R20=c8 R30=c9 R21=c10

const goldenDesign = (): SchematicDesign => makeDesign({
  defs: [
    { id: 'root', symbols: [
      { id: 'sU1', ref: 'U1', libId: 'MCU:X', value: 'MCU', pins: ['1', '2', '3', '4', '5'] },
      { id: 'sR1', ref: 'R1', value: '10k', footprint: 'R_0402', pins: ['1', '2'] },
      { id: 'sC1', ref: 'C1', value: '100n', pins: ['1', '2'] },
      { id: 'sC9', ref: 'C9', pins: ['1', '2'] },
      { id: 'sU2A', ref: 'U2', unit: 1, unitCount: 2, libId: 'Amp:Dual', value: 'OPAMP', pins: ['1', '2', '3', '6'] },
      { id: 'sU2B', ref: 'U2', unit: 2, unitCount: 2, libId: 'Amp:Dual', value: 'OPAMP', pins: ['3', '4', '5', '6', '8'] },
      { id: 'sP1', ref: '#PWR01', virtual: true, pins: ['1'] },
      { id: 'sP2', ref: '#PWR02', virtual: true, pins: ['1'] },
      { id: 'sR9', ref: 'R9', pins: ['1', '2'] },
      { id: 'sD1', ref: 'D1', dnp: true, pins: ['1', '2'] },
    ] },
    { id: 'channel', symbols: [
      { id: 'sRA', ref: { a1: 'R20', a2: 'R21' }, pins: ['1', '2'] },
      { id: 'sRB', ref: 'R30', pins: ['1', '2'] },
    ] },
  ],
  instances: [{ path: '', defId: 'root', name: 'golden' }, { path: 'a1', defId: 'channel', name: 'channel A' }, { path: 'a2', defId: 'channel', name: 'channel B' }],
  nets: [
    { name: 'VCC', pins: [['', 'sU1', '1'], ['', 'sR1', '2'], ['', 'sC1', '1'], ['', 'sC9', '1'], ['', 'sU2A', '6'], ['', 'sU2B', '6'], ['', 'sP1', '1']] },
    { name: 'GND', pins: [['', 'sU1', '2'], ['', 'sC1', '2'], ['', 'sC9', '2'], ['', 'sU2A', '3'], ['', 'sU2B', '3'], ['', 'sP2', '1'], ['a1', 'sRA', '2'], ['a1', 'sRB', '2'], ['a2', 'sRA', '2'], ['a2', 'sRB', '2']] },
    { name: 'SDA', pins: [['', 'sU1', '3'], ['', 'sR1', '1']] },
    { name: 'SCL_MCU', pins: [['', 'sU1', '4']] },
    { name: 'A_IN', pins: [['', 'sU2A', '1']] },
    { name: 'Net-(U2-Pad2)', auto: true, scope: 'local', scopePath: '', pins: [['', 'sU2A', '2'], ['', 'sU2B', '4']] },
    { name: 'CH1', scope: 'local', scopePath: 'a1', pins: [['a1', 'sRA', '1']] },
    { name: 'CH2', scope: 'local', scopePath: 'a2', pins: [['a2', 'sRA', '1']] },
    { name: 'CH', scope: 'local', scopePath: 'a1', pins: [['a1', 'sRB', '1']] },
    { name: 'CH', scope: 'local', scopePath: 'a2', pins: [['a2', 'sRB', '1']] },
  ],
  noConnect: [['', 'sU2B', '5']],
});

let cache: { board: BoardIndex; sch: SchematicIndex } | undefined;
const golden = () => cache ??= { board: buildBoardIndex(goldenBoard()), sch: buildSchematicIndex([goldenDesign()]) };

// ---------------------------------------------------------------------------------------------------------------

describe('ordering and normalization', () => {
  it('orders natural-numeric with a deterministic tie-break and never calls localeCompare (P02)', () => {
    const spy = vi.spyOn(String.prototype, 'localeCompare');
    try {
      expect(['R10', 'R2', 'R1', 'R100', 'R20'].sort(naturalCompare)).toEqual(['R1', 'R2', 'R10', 'R20', 'R100']);
      expect(naturalCompare('R01', 'R1')).not.toBe(0);
      expect(naturalCompare('R1', 'R1')).toBe(0);
      const board = makeBoard(Array.from({ length: 500 }, (_, i) => ({ ref: `R${(i * 37) % 500}`, pins: [['1', `N${i % 20}`] as [string, string]] })));
      const index = buildBoardIndex(board);
      searchAll({ query: 'r1', board: index });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('normalizes NFKC and trims but keeps case', () => {
    expect(normalizeKey('  Ｒ１ ')).toBe('R1');
    expect(normalizeKey('r1')).toBe('r1');
  });
});

describe('board index', () => {
  it('keeps duplicate and case-distinct refs distinct (B18) and answers ref, pin and net lookups', () => {
    const { board } = golden();
    expect(boardComponentsByRef(board, 'R1').map(c => c.id)).toEqual(['c1']);
    expect(boardComponentsByRef(board, 'r1').map(c => c.id)).toEqual(['c2']);
    expect(boardComponentsByRef(board, 'C9').map(c => c.id)).toEqual(['c4', 'c5']);
    expect(boardComponentsByRef(board, 'R10')).toEqual([]);
    expect(board.refsByFold.get('r1')).toEqual(['r1', 'R1'].sort(naturalCompare));
    expect(board.stats.duplicateRefKeys).toBe(1);
    expect(board.stats.caseDistinctRefGroups).toBe(1);
    expect(boardPinsByNumber(board, 'c7', '3').map(p => p.net)).toEqual(['GND']);
    expect(boardPinsByNumber(board, 'c7', '99')).toEqual([]);
    expect(boardNetsByName(board, 'SDA')[0].pins.map(p => p.componentId)).toEqual(['c1', 'c6', 'c0']);
    expect(boardNetsByName(board, 'sda')).toEqual([]);
    expect([...board.pinGroups.get('c7')!.keys()]).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });
  it('groups pads that share a pin number and exposes conflicting nets', () => {
    const index = buildBoardIndex(makeBoard([{ ref: 'U3', pins: [['EP', 'GND'], ['EP', 'GND'], ['1', 'A'], ['1', 'B']] }]));
    const groups = index.pinGroups.get('c0')!;
    expect(groups.get('EP')!.pins).toHaveLength(2);
    expect(groups.get('EP')!.nets).toEqual(['GND']);
    expect(groups.get('1')!.nets).toEqual(['A', 'B']);
  });
  it('adds a pin-only net and ignores empty refs for ref lookups', () => {
    const board = makeBoard([{ ref: '', pins: [['1', 'ORPHAN']] }, { ref: 'R1', pins: [['1', 'ORPHAN']] }]);
    board.nets = [];
    const index = buildBoardIndex(board);
    expect(boardNetsByName(index, 'ORPHAN')[0].id).toBeNull();
    expect(boardNetsByName(index, 'ORPHAN')[0].pins).toHaveLength(2);
    expect(index.byRef.has('')).toBe(false);
    expect(index.stats.componentsWithoutRef).toBe(1);
  });
});

describe('schematic index', () => {
  it('groups the units of a multi-unit part, keeps repeated sheet instances distinct and excludes virtual symbols', () => {
    const { sch } = golden();
    const u2 = sch.partsByRef.get('U2')!;
    expect(u2).toHaveLength(1);
    expect(u2[0].units.map(u => [u.unit, u.symbolId])).toEqual([[1, 'sU2A'], [2, 'sU2B']]);
    expect([...u2[0].pins.keys()]).toEqual(['1', '2', '3', '4', '5', '6', '8']);
    expect(u2[0].pins.get('3')!.placements).toHaveLength(2);
    expect(u2[0].pins.get('3')!.net!.name).toBe('GND');
    expect(u2[0].pins.get('5')!.noConnect).toBe(true);
    expect(u2[0].pins.get('5')!.state).toBe('unconnected');
    expect(u2[0].pins.get('2')!.net!.auto).toBe(true);
    const r30 = sch.partsByRef.get('R30')!;
    expect(r30.map(p => p.units[0].instancePath).sort()).toEqual(['a1', 'a2']);
    expect(sch.partsByRef.get('R20')![0].units[0].instancePath).toBe('a1');
    expect(sch.partsByRef.get('R21')![0].units[0].instancePath).toBe('a2');
    expect(sch.partsByRef.has('#PWR01')).toBe(false);
    expect(sch.virtualSymbols.has('schematic:0\u0000' + symbolKey('', 'sP1'))).toBe(true);
    expect(sch.netsByName.get('VCC')![0].members.map(m => m.ref)).toContain('#PWR01');
    expect(sch.parts.map(p => p.ref)).toEqual(['C1', 'C9', 'D1', 'R1', 'R9', 'R20', 'R21', 'R30', 'R30', 'U1', 'U2']);
    expect(sch.stats.virtualSymbols).toBe(2);
  });
  it('merges a multi-unit part across sheets only when no unit repeats, and splits duplicated annotation', () => {
    const across = buildSchematicIndex([makeDesign({
      defs: [{ id: 'a', symbols: [{ id: 'u1', ref: 'U7', unit: 1, libId: 'L:Q', pins: ['1'] }] }, { id: 'b', symbols: [{ id: 'u2', ref: 'U7', unit: 2, libId: 'L:Q', pins: ['2'] }] }],
      instances: [{ path: '', defId: 'a' }, { path: 'x', defId: 'b' }], nets: [],
    })]);
    expect(across.partsByRef.get('U7')).toHaveLength(1);
    expect(across.partsByRef.get('U7')![0].instancePaths).toEqual(['', 'x']);
    const dup = buildSchematicIndex([makeDesign({
      defs: [{ id: 'a', symbols: [{ id: 'u1', ref: 'U7', unit: 1, pins: ['1'] }, { id: 'u2', ref: 'U7', unit: 1, pins: ['1'] }] }],
      instances: [{ path: '', defId: 'a' }], nets: [],
    })]);
    expect(dup.partsByRef.get('U7')).toHaveLength(2);
    expect(dup.partsByRef.get('U7')!.every(p => p.duplicateAnnotation)).toBe(true);
  });
  it('flags a pin whose copies sit on different nets as a conflict and tolerates an unconnected copy', () => {
    const index = buildSchematicIndex([makeDesign({
      defs: [{ id: 'a', symbols: [
        { id: 'u1', ref: 'U7', unit: 1, unitCount: 3, libId: 'L:Q', pins: ['1', '9'] }, { id: 'u2', ref: 'U7', unit: 2, unitCount: 3, libId: 'L:Q', pins: ['2', '9'] }, { id: 'u3', ref: 'U7', unit: 3, unitCount: 3, libId: 'L:Q', pins: ['3', '9'] },
      ] }],
      instances: [{ path: '', defId: 'a' }],
      nets: [{ name: 'X', pins: [['', 'u1', '9']] }, { name: 'Y', pins: [['', 'u2', '9']] }, { name: 'Z', pins: [['', 'u1', '1']] }],
    })]);
    expect(index.partsByRef.get('U7')![0].pins.get('9')!.state).toBe('conflict');
    expect(index.partsByRef.get('U7')![0].pins.get('9')!.net).toBeNull();
    const ok = buildSchematicIndex([makeDesign({
      defs: [{ id: 'a', symbols: [{ id: 'u1', ref: 'U7', unit: 1, unitCount: 2, libId: 'L:Q', pins: ['9'] }, { id: 'u2', ref: 'U7', unit: 2, unitCount: 2, libId: 'L:Q', pins: ['9'] }] }],
      instances: [{ path: '', defId: 'a' }], nets: [{ name: 'X', pins: [['', 'u1', '9']] }],
    })]);
    expect(ok.partsByRef.get('U7')![0].pins.get('9')!.state).toBe('connected');
    expect(ok.partsByRef.get('U7')![0].pins.get('9')!.net!.name).toBe('X');
  });
  it('keeps identical refs of two schematic documents separate and makes repeated document ids unique', () => {
    const one = makeDesign({ defs: [{ id: 'a', symbols: [{ id: 's', ref: 'R1', pins: ['1'] }] }], instances: [{ path: '', defId: 'a' }], nets: [] });
    const index = buildSchematicIndex([{ documentId: 'doc', design: one }, { documentId: 'doc', design: one }]);
    expect(index.documents.map(d => d.documentId)).toEqual(['doc', 'doc~2']);
    expect(index.partsByRef.get('R1')!.map(p => p.documentId).sort()).toEqual(['doc', 'doc~2']);
  });
});

describe('board <-> schematic link report', () => {
  it('classifies every reference of the golden pair', () => {
    const { board, sch } = golden();
    const report = linkBoardSchematic(board, sch);
    const byRef = (ref: string) => report.refs.rows.find(row => row.ref === ref)!;
    for (const ref of ['U1', 'R1', 'C1', 'U2', 'R20', 'R21']) expect(byRef(ref).status, ref).toBe('unique');
    expect(byRef('C9').status).toBe('ambiguous');
    expect(byRef('C9').reasons).toContain('several-board-parts');
    expect(byRef('C9').boardComponentIds).toEqual(['c4', 'c5']);
    expect(byRef('R30').status).toBe('ambiguous');
    expect(byRef('R30').reasons).toContain('several-schematic-placements');
    expect(byRef('R30').schematicPartsTotal).toBe(2);
    expect(byRef('R30').schematicParts.map(p => p.instancePath).sort()).toEqual(['a1', 'a2']);
    expect(byRef('R9').status).toBe('schematic-only');
    expect(byRef('D1').status).toBe('schematic-only');
    expect(byRef('D1').reasons).toContain('schematic-dnp');
    expect(byRef('TP1').status).toBe('board-only');
    expect(byRef('r1').status).toBe('board-only');
    expect(byRef('r1').caseInsensitive.schematicRefs).toEqual(['R1']);
    expect(byRef('R1').caseInsensitive.schematicRefs).toEqual([]);
    expect(report.refs.rows.some(row => row.ref.startsWith('#PWR'))).toBe(false);
    expect(report.refs.rows.map(r => r.status)).toEqual([...report.refs.rows.map(r => r.status)].sort((a, b) => ['ambiguous', 'schematic-only', 'board-only', 'alias', 'unique'].indexOf(a) - ['ambiguous', 'schematic-only', 'board-only', 'alias', 'unique'].indexOf(b)));
  });
  it('compares pins, nets and reports disagreement counts', () => {
    const { board, sch } = golden();
    const report = linkBoardSchematic(board, sch, undefined, { includeMatches: true });
    expect(report.summary.refs).toEqual({ unique: 6, ambiguous: 2, boardOnly: 2, schematicOnly: 2, alias: 0, unkeyedBoardComponents: 0 });
    expect(report.summary.pins).toEqual({ compared: 21, match: 15, netDiffers: 2, pinMissingOnBoard: 1, pinMissingOnSchematic: 1, ambiguous: 0, netUnknown: 2 });
    expect(report.summary.nets).toEqual({ compared: 10, sameName: 6, aliasConfirmed: 0, differs: 2, unknown: 2, schematicOnly: 1 });
    expect(report.summary.disagreements).toEqual({ refs: 6, pins: 4, nets: 2, total: 12 });
    const pin = (ref: string, number: string) => report.pins.rows.find(row => row.ref === ref && row.pinNumber === number)!;
    expect(pin('U1', '4')).toMatchObject({ status: 'net-differs', reason: 'net-name-differs', boardNet: 'SCL', netRelation: 'differs', schematic: { netName: 'SCL_MCU', netAuto: false } });
    expect(pin('U1', '5')).toMatchObject({ status: 'match', reason: 'both-unconnected', boardNet: '' });
    expect(pin('U1', '3')).toMatchObject({ status: 'match', netRelation: 'same-name' });
    expect(pin('U2', '2')).toMatchObject({ status: 'net-unknown', reason: 'schematic-net-auto-named', netRelation: 'unknown', boardNet: 'MID' });
    expect(pin('U2', '5')).toMatchObject({ status: 'net-differs', reason: 'schematic-no-connect', boardNet: 'NC_B' });
    expect(pin('U2', '7')).toMatchObject({ status: 'pin-missing-on-schematic', boardNet: 'GND', schematic: null });
    expect(pin('U2', '8')).toMatchObject({ status: 'pin-missing-on-board', boardNet: '' });
    expect(pin('U2', '3')).toMatchObject({ status: 'match', netRelation: 'same-name' });
    expect(pin('R21', '1')).toMatchObject({ status: 'match', schematic: { netName: 'CH2' } });
    expect(report.pins.rows.some(row => row.ref === 'C9' || row.ref === 'R30')).toBe(false);
    const net = (name: string) => report.nets.rows.find(row => row.boardNet === name)!;
    expect(net('SCL')).toMatchObject({ relation: 'differs', pinsDiffer: 1 });
    expect(net('NC_B').relation).toBe('differs');
    expect(net('MID').relation).toBe('unknown');
    expect(net('GND')).toMatchObject({ relation: 'same-name', comparedPins: 5, schematicNetsTotal: 1 });
    expect(report.nets.rows.slice(0, 2).map(r => r.relation)).toEqual(['differs', 'differs']);
    expect(report.schematicOnlyNets.rows.map(r => r.name)).toEqual(['SCL_MCU']);
    expect(report.refs.rows.find(r => r.ref === 'U2')!.pins).toEqual({ match: 3, netDiffers: 1, missingOnBoard: 1, missingOnSchematic: 1, ambiguous: 0, unknown: 2 });
  });
  it('lists only disagreements by default, problems first, and is JSON-serializable', () => {
    const { board, sch } = golden();
    const report = linkBoardSchematic(board, sch);
    expect(report.pins.total).toBe(6);
    expect(report.pins.rows.map(r => r.status)).toEqual(['net-differs', 'net-differs', 'pin-missing-on-board', 'pin-missing-on-schematic', 'net-unknown', 'net-unknown']);
    expect(report.pins.rows.every(r => r.status !== 'match')).toBe(true);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(structuredClone(report)).toEqual(report);
    expect(linkBoardSchematic(board, sch)).toEqual(report);
  });
  it('confirms a net alias only when the user supplied it and reports a pointless one', () => {
    const { board, sch } = golden();
    const without = linkBoardSchematic(board, sch);
    expect(without.summary.pins.netDiffers).toBe(2);
    const confirmed = linkBoardSchematic(board, sch, { refs: {}, nets: { SCL_MCU: 'SCL' } }, { includeMatches: true });
    expect(confirmed.summary.pins.netDiffers).toBe(1);
    expect(confirmed.summary.pins.match).toBe(16);
    expect(confirmed.pins.rows.find(r => r.ref === 'U1' && r.pinNumber === '4')).toMatchObject({ status: 'match', netRelation: 'alias-confirmed' });
    expect(confirmed.nets.rows.find(r => r.boardNet === 'SCL')!.relation).toBe('alias-confirmed');
    expect(confirmed.summary.nets).toMatchObject({ aliasConfirmed: 1, differs: 1, schematicOnly: 0 });
    expect(confirmed.aliasIssues.total).toBe(0);
    const wrong = linkBoardSchematic(board, sch, { refs: {}, nets: { SCL_MCU: 'NOPE', GHOST: 'GND' } });
    expect(wrong.summary.pins.netDiffers).toBe(2);
    expect(wrong.aliasIssues.rows).toEqual([{ kind: 'net', from: 'GHOST', to: 'GND', problem: 'source-missing' }, { kind: 'net', from: 'SCL_MCU', to: 'NOPE', problem: 'target-missing' }]);
    expect(linkBoardSchematic(board, sch, compileAliases({ refs: {}, nets: { SCL_MCU: 'SCL' } })).summary).toEqual(linkBoardSchematic(board, sch, { refs: {}, nets: { SCL_MCU: 'SCL' } }).summary);
  });
  it('equates net names only by exact string, including a merged alias name of the schematic net', () => {
    const board = buildBoardIndex(makeBoard([{ ref: 'R1', pins: [['1', 'GND'], ['2', 'gnd']] }, { ref: 'R2', pins: [['1', 'VBUS']] }]));
    const sch = buildSchematicIndex([makeDesign({
      defs: [{ id: 'a', symbols: [{ id: 'r1', ref: 'R1', pins: ['1', '2'] }, { id: 'r2', ref: 'R2', pins: ['1'] }] }], instances: [{ path: '', defId: 'a' }],
      nets: [{ name: 'GND', pins: [['', 'r1', '1'], ['', 'r1', '2']] }, { name: '+5V', aliases: ['+5V', 'VBUS'], pins: [['', 'r2', '1']] }],
    })]);
    const report = linkBoardSchematic(board, sch, undefined, { includeMatches: true });
    const rows = report.pins.rows;
    expect(rows.find(r => r.pinNumber === '1' && r.ref === 'R1')).toMatchObject({ status: 'match', netRelation: 'same-name' });
    expect(rows.find(r => r.pinNumber === '2' && r.ref === 'R1')).toMatchObject({ status: 'net-differs', netRelation: 'differs', boardNet: 'gnd' });
    expect(rows.find(r => r.ref === 'R2')).toMatchObject({ status: 'match', reason: 'matches-net-alias-name' });
  });
  it('links explicit ref aliases (multi-gate refs), and a rejected alias falls back to exact matching only', () => {
    const board = buildBoardIndex(makeBoard([{ ref: 'U1', pins: [['1', 'A'], ['2', 'B'], ['3', 'C'], ['4', 'D']] }, { ref: 'R2', pins: [['1', 'A']] }, { ref: 'R3', pins: [['1', 'A']] }]));
    const sch = buildSchematicIndex([makeDesign({
      defs: [{ id: 'a', symbols: [
        { id: 'ua', ref: 'U1A', pins: ['1', '2'] }, { id: 'ub', ref: 'U1B', pins: ['3', '4'] }, { id: 'r1', ref: 'R1', pins: ['1'] },
      ] }], instances: [{ path: '', defId: 'a' }],
      nets: [{ name: 'A', pins: [['', 'ua', '1'], ['', 'r1', '1']] }, { name: 'B', pins: [['', 'ua', '2']] }, { name: 'C', pins: [['', 'ub', '3']] }, { name: 'D', pins: [['', 'ub', '4']] }],
    })]);
    const none = linkBoardSchematic(board, sch);
    expect(none.summary.refs).toMatchObject({ unique: 0, schematicOnly: 3, boardOnly: 3, alias: 0 });
    const linked = linkBoardSchematic(board, sch, { refs: { U1A: 'U1', U1B: 'U1' }, nets: {} }, { includeMatches: true });
    expect(linked.summary.refs).toMatchObject({ alias: 1, schematicOnly: 1, boardOnly: 2, ambiguous: 0, unique: 0 });
    const row = linked.refs.rows.find(r => r.ref === 'U1')!;
    expect(row).toMatchObject({ status: 'alias', schematicRefs: ['U1A', 'U1B'], schematicPartsTotal: 2 });
    expect(row.schematicParts.map(p => p.via)).toEqual(['alias', 'alias']);
    expect(linked.summary.pins).toMatchObject({ compared: 4, match: 4 });
    expect(mapBoardSelectionToSchematic(board, sch, { componentId: 'c0' }, { refs: { U1A: 'U1', U1B: 'U1' }, nets: {} })).toMatchObject({ status: 'ambiguous', reasons: ['alias-merged-parts'] });
    expect(mapBoardSelectionToSchematic(board, sch, { componentId: 'c0', pinId: board.pinGroups.get('c0')!.get('3')!.pins[0].id }, { refs: { U1A: 'U1', U1B: 'U1' }, nets: {} })).toMatchObject({ status: 'unique', candidates: [{ ref: 'U1B', via: 'alias' }] });
    const missingTarget = linkBoardSchematic(board, sch, { refs: { U1A: 'U9', GHOST: 'U1' }, nets: {} });
    expect(missingTarget.refs.rows.find(r => r.ref === 'U9')).toMatchObject({ status: 'schematic-only', reasons: expect.arrayContaining(['alias-target-missing']) });
    expect(missingTarget.aliasIssues.rows).toEqual([{ kind: 'ref', from: 'GHOST', to: 'U1', problem: 'source-missing' }, { kind: 'ref', from: 'U1A', to: 'U9', problem: 'target-missing' }]);
    const withR1 = buildBoardIndex(makeBoard([{ ref: 'R1', pins: [['1', 'A']] }, { ref: 'R2', pins: [['1', 'A']] }, { ref: 'R3', pins: [['1', 'A']] }]));
    const override = linkBoardSchematic(withR1, sch, { refs: { R1: 'R2' }, nets: {} });
    expect(override.refs.rows.find(r => r.ref === 'R2')).toMatchObject({ status: 'alias', reasons: ['alias-overrides-exact-match'], schematicRefs: ['R1'] });
    expect(override.refs.rows.find(r => r.ref === 'R1')!.status).toBe('board-only');
    expect(override.refs.rows.find(r => r.ref === 'R3')!.status).toBe('board-only');
    expect(linkBoardSchematic(withR1, sch).refs.rows.find(r => r.ref === 'R1')!.status).toBe('unique');
  });
  it('lists case-distinct alternates on both sides without ever linking them (B18)', () => {
    const board = buildBoardIndex(makeBoard([{ ref: 'r5', pins: [['1', 'N']] }, { ref: 'U8', pins: [['1', 'N']] }]));
    const sch = buildSchematicIndex([makeDesign({ defs: [{ id: 'a', symbols: [{ id: 's', ref: 'R5', pins: ['1'] }, { id: 't', ref: 'u8', pins: ['1'] }] }], instances: [{ path: '', defId: 'a' }], nets: [] })]);
    const report = linkBoardSchematic(board, sch);
    expect(report.summary.refs).toMatchObject({ unique: 0, boardOnly: 2, schematicOnly: 2 });
    expect(report.refs.rows.find(r => r.status === 'schematic-only' && r.ref === 'R5')!.caseInsensitive.boardRefs).toEqual(['r5']);
    expect(report.refs.rows.find(r => r.status === 'board-only' && r.ref === 'r5')!.caseInsensitive.schematicRefs).toEqual(['R5']);
    expect(mapBoardSelectionToSchematic(board, sch, { componentId: 'c0' })).toMatchObject({ status: 'missing', candidates: [], caseInsensitive: [{ ref: 'R5', via: 'case-insensitive' }] });
  });
  it('reports conflicting nets on one pin number as ambiguous', () => {
    const board = buildBoardIndex(makeBoard([{ ref: 'U3', pins: [['1', 'A'], ['1', 'B'], ['2', 'A']] }]));
    const sch = buildSchematicIndex([makeDesign({
      defs: [{ id: 'a', symbols: [{ id: 'u1', ref: 'U3', unit: 1, unitCount: 2, libId: 'L', pins: ['1', '2', '9'] }, { id: 'u2', ref: 'U3', unit: 2, unitCount: 2, libId: 'L', pins: ['9'] }] }],
      instances: [{ path: '', defId: 'a' }], nets: [{ name: 'A', pins: [['', 'u1', '1'], ['', 'u1', '2'], ['', 'u1', '9']] }, { name: 'B', pins: [['', 'u2', '9']] }],
    })]);
    const report = linkBoardSchematic(board, sch);
    expect(report.pins.rows.find(r => r.pinNumber === '1')).toMatchObject({ status: 'ambiguous', reason: 'board-pin-nets-conflict' });
    expect(report.pins.rows.find(r => r.pinNumber === '9')).toMatchObject({ status: 'pin-missing-on-board' });
    const conflict = buildBoardIndex(makeBoard([{ ref: 'U3', pins: [['9', 'A']] }]));
    expect(linkBoardSchematic(conflict, sch).pins.rows.find(r => r.pinNumber === '9')).toMatchObject({ status: 'ambiguous', reason: 'schematic-pin-nets-conflict' });
  });
  it('treats unannotated and duplicate-annotated schematic references as ambiguous', () => {
    const board = buildBoardIndex(makeBoard([{ ref: 'R?', pins: [['1', 'N']] }, { ref: 'R4', pins: [['1', 'N']] }]));
    const sch = buildSchematicIndex([makeDesign({
      defs: [{ id: 'a', symbols: [{ id: 's1', ref: 'R?', pins: ['1'] }, { id: 's2', ref: 'R4', pins: ['1'] }, { id: 's3', ref: 'R4', pins: ['1'] }] }], instances: [{ path: '', defId: 'a' }], nets: [],
    })]);
    const report = linkBoardSchematic(board, sch);
    expect(report.refs.rows.find(r => r.ref === 'R4')).toMatchObject({ status: 'ambiguous', reasons: expect.arrayContaining(['several-schematic-placements', 'duplicate-annotation']) });
    expect(report.refs.rows.find(r => r.ref === 'R?')!.status).toBe('ambiguous');
    expect(report.refs.rows.find(r => r.ref === 'R?')!.reasons).toContain('unannotated-schematic-reference');
  });
  it('bounds the listed rows while keeping exact totals', () => {
    const board = buildBoardIndex(makeBoard(Array.from({ length: 60 }, (_, i) => ({ ref: `R${i + 1}`, pins: [['1', `NB${i}`] as [string, string]] }))));
    const sch = buildSchematicIndex([makeDesign({
      defs: [{ id: 'a', symbols: Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, ref: `R${i + 1}`, pins: ['1'] })) }], instances: [{ path: '', defId: 'a' }],
      nets: Array.from({ length: 60 }, (_, i) => ({ name: `NS${i}`, pins: [['', `s${i}`, '1'] as PinRef] })),
    })]);
    const report = linkBoardSchematic(board, sch, undefined, { maxRefRows: 10, maxPinRows: 7, maxNetRows: 5, maxSchematicOnlyNets: 3 });
    expect(report.refs).toMatchObject({ total: 60, truncated: true });
    expect(report.refs.rows).toHaveLength(10);
    expect(report.pins).toMatchObject({ total: 60, truncated: true });
    expect(report.pins.rows).toHaveLength(7);
    expect(report.pins.rows[0].ref).toBe('R1');
    expect(report.nets).toMatchObject({ total: 60, truncated: true });
    expect(report.nets.rows).toHaveLength(5);
    expect(report.schematicOnlyNets).toMatchObject({ total: 60, truncated: true });
    expect(report.schematicOnlyNets.rows).toHaveLength(3);
    expect(report.summary.pins).toMatchObject({ compared: 60, netDiffers: 60 });
    expect(report.summary.disagreements.total).toBe(60 + 60);
  });
  it('is deterministic whatever the order of the input arrays', () => {
    const base = goldenBoard();
    const shuffled: Board = { ...base, components: [...base.components].reverse(), pins: [...base.pins].reverse(), nets: [...base.nets].reverse() };
    const design = goldenDesign();
    const reversed: SchematicDesign = {
      schematic: { ...design.schematic, defs: design.schematic.defs.map(d => ({ ...d, symbols: [...d.symbols].reverse() })), instances: [...design.schematic.instances].reverse() },
      connectivity: { ...design.connectivity, nets: [...design.connectivity.nets].reverse() },
    };
    const a = linkBoardSchematic(buildBoardIndex(base), buildSchematicIndex([design]), undefined, { includeMatches: true });
    const b = linkBoardSchematic(buildBoardIndex(shuffled), buildSchematicIndex([reversed]), undefined, { includeMatches: true });
    const strip = (r: typeof a) => ({ ...r, pins: { ...r.pins, rows: r.pins.rows.map(p => ({ ...p, boardPinIds: [] })) } });
    expect(strip(b).summary).toEqual(strip(a).summary);
    expect(b.refs.rows.map(r => [r.status, r.ref])).toEqual(a.refs.rows.map(r => [r.status, r.ref]));
    expect(b.pins.rows.map(r => [r.status, r.ref, r.pinNumber])).toEqual(a.pins.rows.map(r => [r.status, r.ref, r.pinNumber]));
    expect(b.nets.rows.map(r => [r.relation, r.boardNet])).toEqual(a.nets.rows.map(r => [r.relation, r.boardNet]));
  });
});

describe('selection mapping', () => {
  const pinId = (index: BoardIndex, componentId: string, number: string) => index.pinGroups.get(componentId)!.get(number)!.pins[0].id;
  it('maps a board component and pin to the exact schematic placement, pin key and net', () => {
    const { board, sch } = golden();
    const part = mapBoardSelectionToSchematic(board, sch, { componentId: 'c0' });
    expect(part).toMatchObject({ status: 'unique', reasons: [], candidates: [{ ref: 'U1', via: 'exact', documentId: 'schematic:0', sheets: [{ instancePath: '', name: 'golden' }], pin: null }] });
    const pin = mapBoardSelectionToSchematic(board, sch, { componentId: 'c1', pinId: pinId(board, 'c1', '1') });
    expect(pin.status).toBe('unique');
    expect(pin.candidates[0].pin).toMatchObject({ number: '1', netName: 'SDA', netId: 'net:global:SDA', netAuto: false, netConflict: false });
    expect(pin.candidates[0].pin!.placements[0]).toEqual({ instancePath: '', defId: 'root', symbolId: 'sR1', pinId: 'sR1#1', unit: 1, pinKey: pinKey('', 'sR1', 'sR1#1') });
    const multi = mapBoardSelectionToSchematic(board, sch, { componentId: 'c7', pinId: pinId(board, 'c7', '3') });
    expect(multi.status).toBe('unique');
    expect(multi.candidates[0].units.map(u => u.unit)).toEqual([1, 2]);
    expect(multi.candidates[0].pin!.placements.map(p => p.symbolId)).toEqual(['sU2A', 'sU2B']);
    const hierarchical = mapBoardSelectionToSchematic(board, sch, { componentId: 'c8', pinId: pinId(board, 'c8', '1') });
    expect(hierarchical.candidates[0].sheets[0]).toMatchObject({ instancePath: 'a1', name: 'channel A', label: 'golden / channel A' });
  });
  it('demands an explicit choice for duplicates and reports missing items', () => {
    const { board, sch } = golden();
    expect(mapBoardSelectionToSchematic(board, sch, { componentId: 'c4' })).toMatchObject({ status: 'ambiguous', reasons: ['several-board-parts'] });
    expect(mapBoardSelectionToSchematic(board, sch, { componentId: 'c5' })).toMatchObject({ status: 'ambiguous', reasons: ['several-board-parts'] });
    const repeated = mapBoardSelectionToSchematic(board, sch, { componentId: 'c9' });
    expect(repeated.status).toBe('ambiguous');
    expect(repeated.reasons).toEqual(['several-schematic-placements']);
    expect(repeated.candidates.map(c => c.sheets[0].instancePath).sort()).toEqual(['a1', 'a2']);
    expect(mapBoardSelectionToSchematic(board, sch, { componentId: 'c6' })).toMatchObject({ status: 'missing', reasons: ['no-schematic-part'] });
    expect(mapBoardSelectionToSchematic(board, sch, { componentId: 'c7', pinId: pinId(board, 'c7', '7') })).toMatchObject({ status: 'missing', reasons: ['pin-missing-on-schematic'] });
    expect(mapBoardSelectionToSchematic(board, sch, { componentId: 'nope' })).toMatchObject({ status: 'missing', reasons: ['unknown-component'] });
    expect(mapBoardSelectionToSchematic(board, sch, { componentId: 'c0', pinId: pinId(board, 'c1', '1') })).toMatchObject({ status: 'missing', reasons: ['unknown-pin'] });
    const r1 = mapBoardSelectionToSchematic(board, sch, { componentId: 'c2' });
    expect(r1).toMatchObject({ status: 'missing', caseInsensitive: [{ ref: 'R1', via: 'case-insensitive' }] });
  });
  it('never links partial names (R1 is not R10)', () => {
    const board = buildBoardIndex(makeBoard([{ ref: 'R1', pins: [['1', 'N']] }, { ref: 'R10', pins: [['1', 'N']] }]));
    const sch = buildSchematicIndex([makeDesign({ defs: [{ id: 'a', symbols: [{ id: 's', ref: 'R10', pins: ['1'] }, { id: 't', ref: 'R100', pins: ['1'] }] }], instances: [{ path: '', defId: 'a' }], nets: [] })]);
    expect(mapBoardSelectionToSchematic(board, sch, { componentId: 'c0' }).status).toBe('missing');
    expect(mapBoardSelectionToSchematic(board, sch, { componentId: 'c1' })).toMatchObject({ status: 'unique', candidates: [{ ref: 'R10' }] });
    expect(mapSchematicSelectionToBoard(board, sch, { instancePath: '', symbolId: 't' }).status).toBe('missing');
  });
  it('maps a schematic symbol and pin back to the board', () => {
    const { board, sch } = golden();
    const symbol = mapSchematicSelectionToBoard(board, sch, { instancePath: '', symbolId: 'sU1' });
    expect(symbol).toMatchObject({ status: 'unique', candidates: [{ componentId: 'c0', ref: 'U1', side: 'top', via: 'exact', pin: null }] });
    const pin = mapSchematicSelectionToBoard(board, sch, { instancePath: '', symbolId: 'sU1', pinId: 'sU1#3' });
    expect(pin.candidates[0].pin).toMatchObject({ number: '3', net: 'SDA', pinIds: [pinId(board, 'c0', '3')] });
    const unit2 = mapSchematicSelectionToBoard(board, sch, { documentId: 'schematic:0', instancePath: '', symbolId: 'sU2B', pinId: 'sU2B#4' });
    expect(unit2).toMatchObject({ status: 'unique', candidates: [{ componentId: 'c7', pin: { number: '4', net: 'B_IN' } }] });
    expect(mapSchematicSelectionToBoard(board, sch, { instancePath: '', symbolId: 'sC9' })).toMatchObject({ status: 'ambiguous', reasons: ['several-board-parts'] });
    expect(mapSchematicSelectionToBoard(board, sch, { instancePath: 'a1', symbolId: 'sRB' })).toMatchObject({ status: 'ambiguous', reasons: ['several-schematic-placements'] });
    expect(mapSchematicSelectionToBoard(board, sch, { instancePath: 'a1', symbolId: 'sRA' })).toMatchObject({ status: 'unique', candidates: [{ componentId: 'c8' }] });
    expect(mapSchematicSelectionToBoard(board, sch, { instancePath: 'a2', symbolId: 'sRA' })).toMatchObject({ status: 'unique', candidates: [{ componentId: 'c10' }] });
    expect(mapSchematicSelectionToBoard(board, sch, { instancePath: '', symbolId: 'sR9' })).toMatchObject({ status: 'missing', reasons: ['no-board-component'] });
    expect(mapSchematicSelectionToBoard(board, sch, { instancePath: '', symbolId: 'sP1' })).toMatchObject({ status: 'missing', reasons: ['virtual-symbol'] });
    expect(mapSchematicSelectionToBoard(board, sch, { instancePath: '', symbolId: 'ghost' })).toMatchObject({ status: 'missing', reasons: ['unknown-symbol'] });
    expect(mapSchematicSelectionToBoard(board, sch, { instancePath: '', symbolId: 'sU2B', pinId: 'sU2B#8' })).toMatchObject({ status: 'missing', reasons: ['pin-missing-on-board'] });
    expect(mapSchematicSelectionToBoard(board, sch, { instancePath: '', symbolId: 'sU1', pinId: 'nope' })).toMatchObject({ status: 'missing', reasons: ['unknown-pin'] });
    const two = buildSchematicIndex([goldenDesign(), goldenDesign()]);
    expect(mapSchematicSelectionToBoard(board, two, { instancePath: '', symbolId: 'sU1' }).status).toBe('missing');
    expect(mapSchematicSelectionToBoard(board, two, { documentId: 'schematic:1', instancePath: '', symbolId: 'sU1' })).toMatchObject({ status: 'ambiguous', reasons: ['several-schematic-placements'] });
  });
  it('maps nets by exact name or confirmed alias only', () => {
    const { board, sch } = golden();
    expect(mapBoardNetToSchematic(board, sch, 'SDA')).toMatchObject({ status: 'unique', candidates: [{ netId: 'net:global:SDA', via: 'exact', scope: 'global' }] });
    expect(mapBoardNetToSchematic(board, sch, 'CH')).toMatchObject({ status: 'ambiguous', reasons: ['several-schematic-nets'] });
    expect(mapBoardNetToSchematic(board, sch, 'CH').candidates.map(c => c.scopePath).sort()).toEqual(['a1', 'a2']);
    expect(mapBoardNetToSchematic(board, sch, 'SCL')).toMatchObject({ status: 'missing', reasons: ['no-schematic-net'] });
    expect(mapBoardNetToSchematic(board, sch, 'SCL', { refs: {}, nets: { SCL_MCU: 'SCL' } })).toMatchObject({ status: 'unique', candidates: [{ name: 'SCL_MCU', via: 'alias' }] });
    expect(mapBoardNetToSchematic(board, sch, 'NOT_A_NET')).toMatchObject({ status: 'missing', reasons: ['unknown-net'] });
    expect(mapBoardNetToSchematic(board, sch, 'LED_A').status).toBe('missing');
    expect(mapSchematicNetToBoard(board, sch, { netId: 'net:global:GND' })).toMatchObject({ status: 'unique', candidates: [{ name: 'GND' }] });
    expect(mapSchematicNetToBoard(board, sch, { netId: 'net:global:SCL_MCU' })).toMatchObject({ status: 'missing', reasons: ['no-board-net'] });
    expect(mapSchematicNetToBoard(board, sch, { netId: 'net:global:SCL_MCU' }, { refs: {}, nets: { SCL_MCU: 'SCL' } })).toMatchObject({ status: 'unique', candidates: [{ name: 'SCL', via: 'alias' }] });
    expect(mapSchematicNetToBoard(board, sch, { netId: 'net:auto:0' })).toMatchObject({ status: 'missing' });
    expect(mapSchematicNetToBoard(board, sch, { netId: 'ghost' })).toMatchObject({ status: 'missing', reasons: ['unknown-net'] });
    const dup = buildBoardIndex({ ...makeBoard([{ ref: 'R1', pins: [['1', 'X']] }]), nets: [{ id: 'a', name: 'X', pinIds: [] }, { id: 'b', name: 'X', pinIds: [] }] });
    expect(boardNetsByName(dup, 'X')).toHaveLength(2);
  });
});

describe('bounds, hierarchy and degenerate input', () => {
  it('caps the candidates of a mapping and reports the exact total', () => {
    const board = buildBoardIndex(makeBoard([{ ref: 'R?', pins: [['1', 'N']] }]));
    const sch = buildSchematicIndex([makeDesign({
      defs: [{ id: 'a', symbols: Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, ref: 'R?', pins: ['1'] })) }], instances: [{ path: '', defId: 'a' }], nets: [],
    })]);
    const mapped = mapBoardSelectionToSchematic(board, sch, { componentId: 'c0' });
    expect(mapped).toMatchObject({ status: 'ambiguous', total: 200, truncated: true });
    expect(mapped.candidates).toHaveLength(64);
    expect(mapped.reasons).toEqual(expect.arrayContaining(['several-schematic-placements', 'unannotated-schematic-reference']));
    expect(mapBoardSelectionToSchematic(golden().board, golden().sch, { componentId: 'c0' })).toMatchObject({ total: 1, truncated: false });
  });
  it('labels nested sheet instances and keeps the same symbol on two instance paths distinct', () => {
    const index = buildSchematicIndex([makeDesign({
      defs: [{ id: 'top', symbols: [] }, { id: 'mid', symbols: [] }, { id: 'leaf', symbols: [{ id: 'r', ref: { 'p1/q1': 'R1', 'p1/q2': 'R2' }, pins: ['1', '2'] }] }],
      instances: [{ path: '', defId: 'top', name: 'main' }, { path: 'p1', defId: 'mid', name: 'power' }, { path: 'p1/q1', defId: 'leaf', name: 'buck A', parent: 'p1' }, { path: 'p1/q2', defId: 'leaf', name: 'buck B', parent: 'p1' }],
      nets: [{ name: 'SW', scope: 'hierarchical', scopePath: 'p1/q1', pins: [['p1/q1', 'r', '1']] }, { name: 'SW', scope: 'hierarchical', scopePath: 'p1/q2', pins: [['p1/q2', 'r', '1']] }],
    })]);
    expect(index.partsByRef.get('R1')![0].sheets[0]).toMatchObject({ instancePath: 'p1/q1', label: 'main / power / buck A', page: '3' });
    expect(index.partsByRef.get('R2')![0].sheets[0].label).toBe('main / power / buck B');
    expect(index.partBySymbol.get('schematic:0\u0000' + symbolKey('p1/q1', 'r'))!.ref).toBe('R1');
    expect(index.partBySymbol.get('schematic:0\u0000' + symbolKey('p1/q2', 'r'))!.ref).toBe('R2');
    expect(index.netsByName.get('SW')).toHaveLength(2);
    const nets = searchAll({ query: 'sw', schematic: index }).groups[3];
    expect(nets.rows.map(r => r.sheetLabel)).toEqual(['main / power / buck A', 'main / power / buck B']);
  });
  it('treats identical refs of two schematic documents as several placements', () => {
    const one = () => makeDesign({ defs: [{ id: 'a', symbols: [{ id: 's', ref: 'R1', pins: ['1'] }] }], instances: [{ path: '', defId: 'a' }], nets: [] });
    const board = buildBoardIndex(makeBoard([{ ref: 'R1', pins: [['1', 'N']] }]));
    const two = buildSchematicIndex([{ documentId: 'power.sch', design: one() }, { documentId: 'cpu.sch', design: one() }]);
    expect(linkBoardSchematic(board, two).refs.rows[0]).toMatchObject({ status: 'ambiguous', reasons: ['several-schematic-placements'], schematicPartsTotal: 2 });
    expect(mapBoardSelectionToSchematic(board, two, { componentId: 'c0' }).candidates.map(c => c.documentId).sort()).toEqual(['cpu.sch', 'power.sch']);
    const rows = searchAll({ query: 'R1', schematic: two }).groups[2].rows;
    expect(rows.map(r => r.documentId).sort()).toEqual(['cpu.sch', 'power.sch']);
  });
  it('survives empty and hostile input', () => {
    const board = buildBoardIndex(makeBoard([]));
    const sch = buildSchematicIndex([]);
    const report = linkBoardSchematic(board, sch);
    expect(report.summary.disagreements.total).toBe(0);
    expect(report.refs).toEqual({ rows: [], total: 0, truncated: false });
    expect(searchAll({ query: 'R1', board, schematic: sch }).total).toBe(0);
    expect(resolvePdfRefHits([], board).links).toEqual([]);
    const hostile = JSON.parse('{"__proto__": "X", "constructor": "Y", "": "Z", "A": ""}') as Record<string, string>;
    const compiled = compileAliases({ refs: hostile, nets: hostile });
    expect([...compiled.refs.keys()].sort()).toEqual(['__proto__', 'constructor']);
    expect(() => linkBoardSchematic(golden().board, golden().sch, { refs: hostile, nets: hostile })).not.toThrow();
    expect(() => searchAll({ query: '\ud800' + 'x'.repeat(300), board: golden().board })).not.toThrow();
    expect(searchAll({ query: '\u200b \ufeff', board: golden().board }).total).toBe(0);
    expect(searchAll({ query: 'R\u200b1', board: golden().board }).groups[0].rows[0]).toMatchObject({ ref: 'R1', match: { tier: 'exact' } });
  });
});

describe('PDF hits -> board', () => {
  const board = buildBoardIndex(makeBoard([
    { ref: 'U1', pins: [['1', 'GND']] }, { ref: 'R1', pins: [['1', 'GND']] }, { ref: 'r1', pins: [['1', 'VDD']] }, { ref: 'C9', pins: [['1', 'GND']] }, { ref: 'C9', pins: [['1', 'GND']] }, { ref: 'R2', pins: [['1', 'GND']] }, { ref: 'x7', pins: [] },
  ]));
  const cand = (kind: 'ref' | 'net', name: string, hits: Hit[]): RefCandidate => ({ kind, name, hits });
  it('classifies unique, duplicate-hits, ambiguous-board-ref and missing', () => {
    const report = resolvePdfRefHits([
      cand('ref', 'U1', [hit(2, 4, 'U1 MCU')]),
      cand('ref', 'R2', [hit(1, 1, 'R2 1k'), hit(3, 9, 'see R2.')]),
      cand('ref', 'C9', [hit(1, 5, 'C9')]),
      cand('ref', 'Q5', [hit(1, 6, 'Q5')]),
      cand('net', 'GND', [hit(1, 7, 'GND')]),
      cand('net', 'VCC', [hit(1, 8, 'VCC')]),
    ], board, { documentId: 'pdf-1' });
    const link = (name: string) => report.links.find(l => l.name === name)!;
    expect(link('U1')).toMatchObject({ status: 'unique', documentId: 'pdf-1', targets: [{ kind: 'component', componentId: 'c0' }], hitsTotal: 1, needsHitChoice: false, needsTargetChoice: false });
    expect(link('R2')).toMatchObject({ status: 'duplicate-hits', needsHitChoice: true, hitsTotal: 2, pages: [1, 3] });
    expect(link('C9')).toMatchObject({ status: 'ambiguous-board-ref', needsTargetChoice: true, targetsTotal: 2 });
    expect(link('Q5')).toMatchObject({ status: 'missing', reasons: ['no-exact-board-target'], targets: [] });
    expect(link('GND')).toMatchObject({ status: 'unique', targets: [{ kind: 'net', name: 'GND' }] });
    expect(link('VCC')).toMatchObject({ status: 'missing', targets: [] });
    expect(report.counts).toEqual({ unique: 2, duplicateHits: 1, ambiguousBoardRef: 1, missing: 2 });
    expect(report.links.map(l => l.name)).toEqual(['C9', 'Q5', 'R2', 'U1', 'GND', 'VCC']);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
  it('separates case-only hits and targets and never links them (B18)', () => {
    const report = resolvePdfRefHits([
      cand('ref', 'R1', [hit(1, 1, 'R1 10k'), hit(1, 2, 'r1 spare'), hit(2, 3, 'x R1/r1')]),
      cand('ref', 'r1', [hit(1, 1, 'R1 10k'), hit(1, 2, 'r1 spare'), hit(2, 3, 'x R1/r1')]),
      cand('ref', 'R2', [hit(5, 1, 'r2 only lowercase in the PDF')]),
      cand('ref', 'X7', [hit(1, 1, 'X7')]),
    ], board);
    const link = (name: string) => report.links.find(l => l.name === name)!;
    expect(link('R1').targets).toMatchObject([{ componentId: 'c1', ref: 'R1' }]);
    expect(link('R1').hits.map(h => h.itemIndex)).toEqual([1, 3]);
    expect(link('R1').caseInsensitiveHits.map(h => [h.itemIndex, h.literal])).toEqual([[2, 'case-differs']]);
    expect(link('R1').caseInsensitiveTargets).toMatchObject([{ ref: 'r1', via: 'case-insensitive' }]);
    expect(link('R1').status).toBe('duplicate-hits');
    expect(link('r1').targets).toMatchObject([{ componentId: 'c2', ref: 'r1' }]);
    expect(link('r1').hits.map(h => h.itemIndex)).toEqual([2, 3]);
    expect(link('R2')).toMatchObject({ status: 'missing', reasons: ['only-case-differing-hits'], hitsTotal: 0, caseInsensitiveHitsTotal: 1 });
    expect(link('R2').targets).toHaveLength(1);
    expect(link('X7')).toMatchObject({ status: 'missing', targets: [], caseInsensitiveTargets: [{ ref: 'x7', via: 'case-insensitive' }] });
  });
  it('passes truncation through and bounds links and hits with exact totals', () => {
    const many = Array.from({ length: 40 }, (_, i) => hit(1 + (i % 4), i, 'U1'));
    const result: RefCandidateResult = { candidates: [cand('ref', 'U1', many), ...Array.from({ length: 12 }, (_, i) => cand('ref', `Z${i}`, [hit(1, 100 + i, `Z${i}`)]))], truncated: true, totalHits: 52 };
    const report = resolvePdfRefHits(result, board, { maxLinks: 5, maxHitsPerLink: 6 });
    expect(report.truncated).toBe(true);
    expect(report.totalHits).toBe(52);
    expect(report.totalLinks).toBe(13);
    expect(report.linksTruncated).toBe(true);
    expect(report.links).toHaveLength(5);
    expect(report.links.map(l => l.name)).toEqual(['U1', 'Z0', 'Z1', 'Z2', 'Z3']);
    const full = resolvePdfRefHits(result, board, { maxLinks: 100, maxHitsPerLink: 6 });
    const link = full.links.find(l => l.name === 'U1')!;
    expect(link.hits).toHaveLength(6);
    expect(link.hitsTotal).toBe(40);
    expect(link.pages).toEqual([1, 2, 3, 4]);
    expect(link.status).toBe('duplicate-hits');
    expect(resolvePdfRefHits([], board)).toMatchObject({ truncated: false, totalHits: 0, links: [] });
    expect(resolvePdfRefHits([], board, { truncated: true }).truncated).toBe(true);
  });
  it('reads the literal token from the hit text and marks unverifiable hits', () => {
    const report = resolvePdfRefHits([cand('ref', 'U1', [hit(1, 1, '…(U1),'), hit(1, 2, 'completely unrelated text')])], board);
    const link = report.links[0];
    expect(link.hits.map(h => h.literal)).toEqual(['exact', 'unknown']);
    expect(link.reasons).toEqual(expect.arrayContaining(['duplicate-hits', 'unverified-hit-text']));
  });
  it('resolves several documents independently', () => {
    const reports = resolvePdfDocuments([
      { documentId: 'a', result: [cand('ref', 'U1', [hit(1, 1, 'U1')])] },
      { documentId: 'b', result: { candidates: [cand('ref', 'U1', [hit(1, 1, 'U1'), hit(2, 2, 'U1')])], truncated: true, totalHits: 2 } },
    ], board);
    expect(reports.map(r => [r.documentId, r.links[0].status, r.truncated])).toEqual([['a', 'unique', false], ['b', 'duplicate-hits', true]]);
  });
});

describe('unified search', () => {
  const searchBoard = buildBoardIndex(makeBoard([
    { ref: 'R1', value: '10k', pkg: '0402', pins: [['1', 'VDD_CORE'], ['2', 'GND']] },
    { ref: 'r1', value: '4k7', pkg: '0603', side: 'bottom', pins: [['1', 'SCL'], ['2', 'GND']] },
    { ref: 'R10', value: '100n', pkg: '0402', pins: [['1', 'GND']] },
    { ref: 'R2', value: 'R1X', pins: [['1', 'GND']] },
    { ref: 'R100', pins: [['1', 'GND']] },
    { ref: 'C5', value: '10µF', pins: [['1', 'VDD_CORE']] },
    { ref: 'U9', value: '', pkg: 'BGA R1', pins: [['A1', 'NET_R1']] },
  ]));
  const refs = (result: ReturnType<typeof searchAll>) => result.groups[0].rows.map(r => `${r.ref}:${r.match.tier}`);
  it('ranks the exact literal ref before case-insensitive alternatives, then prefix, then substring (B18)', () => {
    expect(refs(searchAll({ query: 'R1', board: searchBoard }))).toEqual(['R1:exact', 'r1:exact-insensitive', 'R10:prefix', 'R100:prefix', 'R2:field', 'U9:field']);
    expect(refs(searchAll({ query: 'r1', board: searchBoard }))).toEqual(['r1:exact', 'R1:exact-insensitive', 'R10:prefix-insensitive', 'R100:prefix-insensitive', 'R2:field', 'U9:field']);
    const result = searchAll({ query: 'R1', board: searchBoard });
    expect(result.groups[0].rows[1].match).toMatchObject({ caseInsensitive: true, rank: 1 });
    expect(result.groups[0].rows[0].match).toMatchObject({ caseInsensitive: false, rank: 0 });
    expect(refs(searchAll({ query: '0', board: searchBoard }))[0]).toMatch(/^R10:substring$/);
  });
  it('keeps the legacy value / package / net / concatenation matching', () => {
    const byField = (query: string) => searchAll({ query, board: searchBoard }).groups[0].rows.map(r => [r.ref, r.match.tier, r.match.field]);
    expect(byField('4k7')).toEqual([['r1', 'field', 'value']]);
    expect(byField('0603')).toEqual([['r1', 'field', 'package']]);
    expect(byField('vdd_core')).toEqual([['C5', 'pin-net', 'net'], ['R1', 'pin-net', 'net']]);
    expect(byField('r1 10k')).toEqual([['R1', 'field', 'fields']]);
    expect(byField('10µf')).toEqual([['C5', 'field', 'value']]);
    expect(byField('10μF')).toEqual([['C5', 'field', 'value']]);
  });
  it('searches board nets with the same ranking', () => {
    const result = searchAll({ query: 'gnd', board: searchBoard });
    expect(result.groups[1].rows.map(r => [r.name, r.match.tier, r.pinCount])).toEqual([['GND', 'exact-insensitive', 5]]);
    expect(searchAll({ query: 'VDD', board: searchBoard }).groups[1].rows.map(r => [r.name, r.match.tier])).toEqual([['VDD_CORE', 'prefix']]);
    expect(searchAll({ query: 'CORE', board: searchBoard }).groups[1].rows.map(r => [r.name, r.match.tier])).toEqual([['VDD_CORE', 'substring']]);
  });
  it('normalizes Unicode and whitespace, is pure, and returns nothing for an empty query', () => {
    const base = searchAll({ query: 'R1', board: searchBoard });
    expect(searchAll({ query: '  Ｒ１ ', board: searchBoard })).toEqual({ ...base, query: 'R1' });
    expect(searchAll({ query: 'R1', board: searchBoard })).toEqual(base);
    expect(searchAll({ query: 'r1 10k', board: searchBoard }).groups[0].rows.map(r => r.ref)).toEqual(['R1']);
    const empty = searchAll({ query: '   ', board: searchBoard });
    expect(empty.total).toBe(0);
    expect(empty.groups.every(g => g.rows.length === 0 && !g.truncated)).toBe(true);
    expect(searchAll({ query: 'x' }).total).toBe(0);
    expect(searchAll({ query: 'a'.repeat(1000), board: searchBoard }).query).toHaveLength(256);
  });
  it('orders naturally and deterministically whatever the board order', () => {
    const specs = Array.from({ length: 30 }, (_, i) => ({ ref: `R${(i * 7) % 30 + 1}`, pins: [['1', 'N'] as [string, string]] }));
    const a = searchAll({ query: 'R', board: buildBoardIndex(makeBoard(specs)) });
    const b = searchAll({ query: 'R', board: buildBoardIndex(makeBoard([...specs].reverse())) });
    expect(a.groups[0].rows.map(r => r.ref)).toEqual(Array.from({ length: 30 }, (_, i) => `R${i + 1}`));
    expect(b.groups[0].rows.map(r => r.ref)).toEqual(a.groups[0].rows.map(r => r.ref));
  });
  it('caps every group with exact totals and a truncated flag', () => {
    const big = buildBoardIndex(makeBoard(Array.from({ length: 80 }, (_, i) => ({ ref: `R${i + 1}`, pins: [['1', `NET${i}`] as [string, string]] }))));
    const result = searchAll({ query: 'R', board: big, limits: { boardComponents: 10, boardNets: 5 } });
    expect(result.groups[0]).toMatchObject({ source: 'board-components', total: 80, truncated: true });
    expect(result.groups[0].rows).toHaveLength(10);
    expect(result.groups[0].rows.map(r => r.ref)).toEqual(Array.from({ length: 10 }, (_, i) => `R${i + 1}`));
    expect(result.groups[1]).toMatchObject({ total: 0 });
    const nets = searchAll({ query: 'NET', board: big, limits: { boardNets: 5 } });
    expect(nets.groups[1]).toMatchObject({ total: 80, truncated: true });
    expect(nets.groups[1].rows.map(r => r.name)).toEqual(['NET0', 'NET1', 'NET2', 'NET3', 'NET4']);
    expect(nets.total).toBe(80 + 80);
    expect(nets.truncated).toBe(true);
    const exactOnTop = searchAll({ query: 'R80', board: big, limits: { boardComponents: 1 } });
    expect(exactOnTop.groups[0].rows.map(r => r.ref)).toEqual(['R80']);
    expect(searchAll({ query: 'R', board: big, limits: { boardComponents: 0 } }).groups[0]).toMatchObject({ rows: [], total: 80, truncated: true });
  });
  it('searches schematic symbols and nets with sheet identity, and keeps repeated instances distinct', () => {
    const { board, sch } = golden();
    const result = searchAll({ query: 'R3', board, schematic: sch });
    expect(result.groups[2].rows.map(r => [r.ref, r.instancePath, r.sheetLabel, r.page])).toEqual([['R30', 'a1', 'golden / channel A', '2'], ['R30', 'a2', 'golden / channel B', '3']]);
    expect(result.groups[2].rows.every(r => r.documentId === 'schematic:0')).toBe(true);
    expect(result.groups[0].rows.map(r => r.ref)).toEqual(['R30']);
    const u2 = searchAll({ query: 'U2', schematic: sch }).groups[2].rows;
    expect(u2).toHaveLength(1);
    expect(u2[0]).toMatchObject({ ref: 'U2', units: [1, 2], symbolId: 'sU2A', match: { tier: 'exact' } });
    expect(searchAll({ query: '#PWR', schematic: sch }).groups[2].total).toBe(0);
    const nets = searchAll({ query: 'CH', schematic: sch }).groups[3];
    expect(nets.rows.map(r => [r.name, r.netId, r.sheetLabel])).toEqual([
      ['CH', 'net:local:a1:CH', 'golden / channel A'], ['CH', 'net:local:a2:CH', 'golden / channel B'], ['CH1', 'net:local:a1:CH1', 'golden / channel A'], ['CH2', 'net:local:a2:CH2', 'golden / channel B'],
    ]);
    expect(nets.rows.map(r => r.match.tier)).toEqual(['exact', 'exact', 'prefix', 'prefix']);
    expect(searchAll({ query: 'net-(u2', schematic: sch }).groups[3].rows.map(r => [r.name, r.auto, r.match.tier])).toEqual([['Net-(U2-Pad2)', true, 'prefix-insensitive']]);
    expect(searchAll({ query: '10k', schematic: sch }).groups[2].rows.map(r => [r.ref, r.match.field])).toEqual([['R1', 'value']]);
    expect(searchAll({ query: 'R_0402', schematic: sch }).groups[2].rows.map(r => [r.ref, r.match.field])).toEqual([['R1', 'package']]);
  });
  it('groups document hits by document and page with per-document and total caps', () => {
    const a = Array.from({ length: 8 }, (_, i) => hit(1 + Math.floor(i / 2), i, `PU301 ${i}`));
    const shuffled = [...a].reverse();
    const result = searchAll({ query: 'PU301', documents: [{ documentId: 'd1', name: 'main.pdf', hits: shuffled }, { documentId: 'd2', name: 'aux.pdf', hits: [hit(7, 1, 'PU301')], total: 40, truncated: true }], limits: { documentsPerDocument: 3, documents: 10 } });
    const group = result.groups[4];
    expect(group.source).toBe('documents');
    expect(group.rows.map(r => [r.documentId, r.documentName, r.page, r.itemIndex])).toEqual([['d1', 'main.pdf', 1, 0], ['d1', 'main.pdf', 1, 1], ['d1', 'main.pdf', 2, 2], ['d2', 'aux.pdf', 7, 1]]);
    expect(group.total).toBe(8 + 40);
    expect(group.truncated).toBe(true);
    const capped = searchAll({ query: 'PU301', documents: [{ documentId: 'd1', name: 'main.pdf', hits: a }], limits: { documents: 2 } }).groups[4];
    expect(capped).toMatchObject({ total: 8, truncated: true });
    expect(capped.rows).toHaveLength(2);
    const exact = searchAll({ query: 'PU301', documents: [{ documentId: 'd1', name: 'main.pdf', hits: [hit(1, 1, 'PU301')] }] }).groups[4];
    expect(exact).toMatchObject({ total: 1, truncated: false });
  });
});

describe('scale: 5,000 components', () => {
  it('builds, links and searches within generous bounds', () => {
    const count = 5000, netPool = 700;
    const board = makeBoard(Array.from({ length: count }, (_, i) => ({ ref: `R${i + 1}`, value: `${(i % 97) + 1}k`, pkg: i % 2 ? '0402' : '0603', side: (i % 2 ? 'top' : 'bottom') as BoardSide, pins: [['1', `N${i % netPool}`], ['2', 'GND']] as Array<[string, string]> })));
    const design = makeDesign({
      defs: [{ id: 'root', symbols: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, ref: `R${i + 1}`, value: `${(i % 97) + 1}k`, pins: ['1', '2'] })) }],
      instances: [{ path: '', defId: 'root' }],
      nets: [
        ...Array.from({ length: netPool }, (_, k) => ({ name: `N${k}`, pins: Array.from({ length: Math.ceil((count - k) / netPool) }, (_, j) => ['', `s${k + j * netPool}`, '1'] as PinRef) })),
        { name: 'GND', pins: Array.from({ length: count }, (_, i) => ['', `s${i}`, '2'] as PinRef) },
      ],
    });
    const time = <T>(fn: () => T): [T, number] => { const t = performance.now(); const value = fn(); return [value, performance.now() - t]; };
    const [boardIndex, tBoard] = time(() => buildBoardIndex(board));
    const [schIndex, tSch] = time(() => buildSchematicIndex([design]));
    const [report, tLink] = time(() => linkBoardSchematic(boardIndex, schIndex));
    const [search, tSearch] = time(() => searchAll({ query: 'R1', board: boardIndex, schematic: schIndex }));
    const [, tSearch2] = time(() => { for (let i = 0; i < 20; i++) searchAll({ query: `r${i}`, board: boardIndex, schematic: schIndex }); });
    const [map, tMap] = time(() => mapBoardSelectionToSchematic(boardIndex, schIndex, { componentId: 'c2500' }));
    // eslint-disable-next-line no-console
    console.log(`crossprobe 5000 components: board index ${tBoard.toFixed(1)} ms, schematic index ${tSch.toFixed(1)} ms, link ${tLink.toFixed(1)} ms, search ${tSearch.toFixed(2)} ms (20 more: ${tSearch2.toFixed(1)} ms), mapping ${tMap.toFixed(2)} ms`);
    expect(report.summary.refs.unique).toBe(count);
    expect(report.summary.pins).toMatchObject({ compared: count * 2, match: count * 2 });
    expect(report.summary.disagreements.total).toBe(0);
    expect(report.pins.rows).toHaveLength(0);
    expect(search.groups[0].total).toBeGreaterThan(1000);
    expect(search.groups[0].rows[0]).toMatchObject({ ref: 'R1', match: { tier: 'exact' } });
    expect(map.status).toBe('unique');
    expect(tBoard + tSch + tLink).toBeLessThan(5000);
    expect(tSearch).toBeLessThan(500);
    expect(tMap).toBeLessThan(100);
  });
});

// Real-file finding W-open-cross-01 (S1 KiCad demo, S3 Antmicro Jetson Nano baseboard): KiCad writes the net of a local/hierarchical label
// into the board qualified by its sheet path and spells "/" as "{slash}". Original synthetic design and board, nothing real.
describe('KiCad netlist names of local nets (W-open-cross-01)', () => {
  const design = (format: 'kicad-sch' | 'eagle-sch' = 'kicad-sch'): SchematicDesign => {
    const d = makeDesign({
      defs: [
        { id: 'root', symbols: [{ id: 'sR1', ref: 'R1', pins: ['1', '2'] }, { id: 'sU1', ref: 'U1', pins: ['1'] }] },
        { id: 'amp', symbols: [{ id: 'sRA', ref: { a1: 'R2', a2: 'R3' }, pins: ['1'] }] },
      ],
      instances: [{ path: '', defId: 'root', name: 'top' }, { path: 'a1', defId: 'amp', name: 'amp one' }, { path: 'a2', defId: 'amp', name: 'amp2' }],
      nets: [
        { name: 'SIG', scope: 'local', scopePath: '', pins: [['', 'sR1', '1']] },
        { name: 'GND', pins: [['', 'sR1', '2']] },
        { name: 'CLK/EN', scope: 'local', scopePath: '', pins: [['', 'sU1', '1']] },
        { name: 'OUT', scope: 'hierarchical', scopePath: 'a1', pins: [['a1', 'sRA', '1']] },
        { name: 'OUT', scope: 'hierarchical', scopePath: 'a2', pins: [['a2', 'sRA', '1']] },
      ],
    });
    d.schematic.format = format;
    return d;
  };
  const board = () => makeBoard([
    { ref: 'R1', pins: [['1', '/SIG'], ['2', 'GND']] }, { ref: 'U1', pins: [['1', '/CLK{slash}EN']] },
    { ref: 'R2', pins: [['1', '/amp one/OUT']] }, { ref: 'R3', pins: [['1', '/amp2/OUT']] },
  ]);
  const link = (d: SchematicDesign) => linkBoardSchematic(buildBoardIndex(board()), buildSchematicIndex([d]), null, { includeMatches: true });

  it('matches the sheet-qualified and slash-escaped names exactly, per sheet instance', () => {
    const report = link(design());
    expect(report.summary.pins).toMatchObject({ compared: 5, match: 5, netDiffers: 0, netUnknown: 0 });
    expect(report.summary.nets).toMatchObject({ compared: 5, sameName: 5, differs: 0 });
    expect(report.pins.rows.every(row => row.reason === 'matches-net-alias-name' || row.reason === undefined)).toBe(true);
    expect(report.schematicOnlyNets.total).toBe(0);
  });

  it('keeps the bare name as the displayed name and never matches another instance or a source that has no sheet paths', () => {
    const index = buildSchematicIndex([design()]);
    expect(index.nets.filter(net => net.name === 'OUT').map(net => net.aliasKeys)).toEqual([['OUT', '/amp one/OUT'], ['OUT', '/amp2/OUT']]);
    expect(index.nets.find(net => net.name === 'GND')!.aliasKeys).toEqual(['GND']); // global names stay bare
    const swapped = linkBoardSchematic(buildBoardIndex(makeBoard([{ ref: 'R2', pins: [['1', '/amp2/OUT']] }, { ref: 'R3', pins: [['1', '/amp one/OUT']] }])), index);
    expect(swapped.summary.pins.netDiffers).toBe(2);
    const eagle = link(design('eagle-sch'));
    expect(eagle.summary.pins.netDiffers).toBe(4); // an EAGLE source has no sheet-path convention: only exact names match
    expect(mapBoardNetToSchematic(buildBoardIndex(board()), index, '/amp2/OUT').status).toBe('unique');
    expect(mapSchematicNetToBoard(buildBoardIndex(board()), index, { netId: index.nets.find(net => net.name === 'CLK/EN')!.id }).candidates.map(t => t.name)).toEqual(['/CLK{slash}EN']);
  });
});

// Real-file finding W-open-cross-02 (S1 KiCad 9 demo, S3, S8; 142 of 142 automatic nets of five real boards): KiCad 8/9 names a net that no label names
// "Net-(<ref>-<pin>)" after ONE member pin, not "Net-(R1-Pad2)". Original synthetic design; the rule is offered as one more exact name of an automatic net.
describe('KiCad 8/9 automatic net names (W-open-cross-02)', () => {
  /** Auto nets over parts whose pins carry the given names ('' = unnamed). */
  const build = (format: 'kicad-sch' | 'kicad-legacy-sch' | 'eagle-sch' = 'kicad-sch') => {
    const d = makeDesign({
      defs: [{ id: 'root', symbols: [
        { id: 'sU1', ref: 'U1', pins: ['4', '7'] }, { id: 'sR5', ref: 'R5', pins: ['1'] },
        { id: 'sC4', ref: 'C4', pins: ['1'] }, { id: 'sR6', ref: 'R6', pins: ['2'] },
        { id: 'sJ1', ref: 'J1', pins: ['5'] }, { id: 'sR7', ref: 'R7', pins: ['1'] },
        { id: 'sU2B', ref: 'U2', unit: 2, unitCount: 2, pins: ['3'] },
        { id: 'sU3', ref: 'U3', pins: ['1', '2'] },
      ] }],
      instances: [{ path: '', defId: 'root', name: 'top' }],
      nets: [
        { name: 'Net-(R5-Pad1)', auto: true, aliases: [], scope: 'local', scopePath: '', pins: [['', 'sU1', '4'], ['', 'sR5', '1']] }, // U1 pin 4 is named FB
        { name: 'Net-(C4-Pad1)', auto: true, aliases: [], scope: 'local', scopePath: '', pins: [['', 'sR6', '2'], ['', 'sC4', '1']] }, // nothing is named
        { name: 'Net-(J1-Pad5)', auto: true, aliases: [], scope: 'local', scopePath: '', pins: [['', 'sJ1', '5'], ['', 'sR7', '1']] }, // J1 pin 5 is named "5", its own number
        { name: 'Net-(U2-Pad3)', auto: true, aliases: [], scope: 'local', scopePath: '', pins: [['', 'sU2B', '3']] }, // unit 2 of a two-unit part, pin named A/B
        { name: 'Net-(U3-Pad1)', auto: true, aliases: [], scope: 'local', scopePath: '', pins: [['', 'sU3', '1'], ['', 'sU3', '2']] }, // two pins of one symbol named IO
        { name: 'Net-(U1-Pad7)', auto: true, aliases: [], scope: 'local', scopePath: '', pins: [['', 'sU1', '7']] },
      ],
    });
    const names: Record<string, string> = { 'sU1#4': 'FB', 'sU1#7': 'EN', 'sR5#1': '', 'sC4#1': '', 'sR6#2': '', 'sJ1#5': '5', 'sR7#1': '', 'sU2B#3': 'A/B', 'sU3#1': 'IO', 'sU3#2': 'IO' };
    for (const def of d.schematic.defs) for (const symbol of def.symbols) for (const pin of symbol.pins) { const name = names[`${symbol.id}#${pin.number}`]; if (name !== undefined) pin.name = name; }
    for (const net of d.connectivity.nets) for (const member of net.members) { const name = names[`${member.symbolId}#${member.pinNumber}`]; if (name !== undefined) member.pinName = name; }
    d.schematic.format = format;
    return d;
  };
  const autoKeys = (d: SchematicDesign) => Object.fromEntries(buildSchematicIndex([d]).nets.map(net => [net.name, net.aliasKeys]));

  it('names a net after its named pin, "Pad<n>" otherwise, with the unit letter and "{slash}", and disambiguates repeated pin names', () => {
    const keys = autoKeys(build());
    expect(keys['Net-(R5-Pad1)']).toEqual(['Net-(U1-FB)']); // a named pin wins over R5 even though R5 would not sort after U1 here
    expect(keys['Net-(C4-Pad1)']).toEqual(['Net-(C4-Pad1)']); // no named pin: the smallest "Net-(ref-Pad<n>)"
    expect(keys['Net-(J1-Pad5)']).toEqual(['Net-(J1-Pad5)']); // a name equal to the pin number is no name
    expect(keys['Net-(U2-Pad3)']).toEqual(['Net-(U2B-A{slash}B)']);
    expect(keys['Net-(U3-Pad1)']).toEqual(['Net-(U3-IO-Pad1)']); // the name is used twice in this symbol, so the pin number is added; "Pad1" sorts before "Pad2"
    expect(keys['Net-(U1-Pad7)']).toEqual(['Net-(U1-EN)']);
  });

  it('links a board net carrying the KiCad 8/9 name, and leaves an automatic net with another name "unknown", never "differs"', () => {
    const board = makeBoard([
      { ref: 'U1', pins: [['4', 'Net-(U1-FB)'], ['7', 'Net-(U1-EN)']] }, { ref: 'R5', pins: [['1', 'Net-(U1-FB)']] },
      { ref: 'C4', pins: [['1', 'Net-(C4-Pad1)']] }, { ref: 'R6', pins: [['2', 'Net-(C4-Pad1)']] },
      { ref: 'J1', pins: [['5', 'Net-(SOMETHING-ELSE)']] }, { ref: 'R7', pins: [['1', 'Net-(SOMETHING-ELSE)']] },
    ]);
    const report = linkBoardSchematic(buildBoardIndex(board), buildSchematicIndex([build()]), null, { includeMatches: true });
    const byPin = new Map(report.pins.rows.map(row => [`${row.ref}.${row.pinNumber}`, row]));
    expect(byPin.get('U1.4')).toMatchObject({ status: 'match', reason: 'matches-net-alias-name' });
    expect(byPin.get('R5.1')).toMatchObject({ status: 'match', reason: 'matches-net-alias-name' });
    expect(byPin.get('C4.1')).toMatchObject({ status: 'match' }); expect(byPin.get('R6.2')).toMatchObject({ status: 'match' });
    expect(byPin.get('J1.5')).toMatchObject({ status: 'net-unknown', reason: 'schematic-net-auto-named' });
    expect(report.summary.pins.netDiffers).toBe(0);
    // KiCad 5 files and EAGLE keep their own convention: no extra name is offered
    expect(autoKeys(build('kicad-legacy-sch'))['Net-(R5-Pad1)']).toEqual([]);
    expect(autoKeys(build('eagle-sch'))['Net-(R5-Pad1)']).toEqual([]);
  });
});
