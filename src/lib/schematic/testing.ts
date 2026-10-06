/**
 * Test support for schematic code: small builders for `Schematic` literals and original synthetic golden fixtures.
 * Pure data, no I/O; exported for the connectivity tests and for related tests (viewer, cross-probe).
 *
 * Conventions of the builders: millimetres, Y down; ids are explicit or generated per sheet; a pin id is
 * `${symbolId}#${number}` (+ `@${unit}` for a repeated number inside one symbol, like parsers produce).
 */
import type {
  Schematic, SchBounds, SchConnectivity, SchDeclaredNet, SchLabelKind, SchNet, SchPin, SchPinType, SchPoint, SchSheetDef,
  SchSheetInstance, SchSheetPin, SchSheetRef, SchSymbol, SchematicFormat,
} from './model';
import { pinKey } from './model';

export interface PinSpec {
  /** Pin number. */
  n: string; x: number; y: number;
  name?: string; type?: SchPinType; hidden?: boolean; unit?: number; implicitNet?: string;
}
export interface PartOptions {
  id?: string; libId?: string; unit?: number; unitCount?: number; value?: string;
  virtual?: boolean; dnp?: boolean;
  /** Power symbol: ties its pins to the global net of that name. */
  power?: string;
  /** Per-instance references, keyed by instance path. The key '' is always filled with `ref`. */
  instances?: Record<string, { ref: string; unit: number }>;
}
export interface SubSheetOptions { file?: string; at?: SchPoint; size?: SchPoint; defId?: string | null }

const EMPTY_BOUNDS: SchBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

function boundsOf(points: SchPoint[]): SchBounds {
  if (!points.length) return { ...EMPTY_BOUNDS };
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** Fluent builder of one sheet definition. */
export class SheetBuilder {
  readonly def: SchSheetDef;
  private counter = 0;
  constructor(id: string, name = id, file = `${id}.kicad_sch`) {
    this.def = {
      id, name, file, title: name, titleBlock: {}, symbols: [], wires: [], buses: [], busEntries: [], junctions: [], noConnects: [],
      labels: [], sheetRefs: [], graphics: [], bounds: { ...EMPTY_BOUNDS },
    };
  }
  private next(prefix: string): string { return `${prefix}${++this.counter}`; }

  wire(x1: number, y1: number, x2: number, y2: number, id = this.next('w')): this { this.def.wires.push({ id, a: { x: x1, y: y1 }, b: { x: x2, y: y2 } }); return this; }
  /** Polyline of wires through the given points. */
  path(...points: Array<[number, number]>): this { for (let i = 1; i < points.length; i++) this.wire(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]); return this; }
  bus(x1: number, y1: number, x2: number, y2: number, id = this.next('b')): this { this.def.buses.push({ id, a: { x: x1, y: y1 }, b: { x: x2, y: y2 } }); return this; }
  entry(x: number, y: number, toX: number, toY: number, id = this.next('e')): this { this.def.busEntries.push({ id, at: { x, y }, to: { x: toX, y: toY } }); return this; }
  junction(x: number, y: number, id = this.next('j')): this { this.def.junctions.push({ id, at: { x, y } }); return this; }
  noConnect(x: number, y: number, id = this.next('nc')): this { this.def.noConnects.push({ id, at: { x, y } }); return this; }
  label(kind: SchLabelKind, text: string, x: number, y: number, id = this.next('l')): this { this.def.labels.push({ id, kind, text, at: { x, y }, angle: 0 }); return this; }
  local(text: string, x: number, y: number): this { return this.label('local', text, x, y); }
  global(text: string, x: number, y: number): this { return this.label('global', text, x, y); }
  hier(text: string, x: number, y: number): this { return this.label('hierarchical', text, x, y); }

  /** Placed part. `ref` is the reference stored for the single-instance key ''. */
  part(ref: string, pins: PinSpec[], options: PartOptions = {}): this {
    const id = options.id ?? ref;
    const unit = options.unit ?? 1;
    const seen = new Map<string, number>();
    const symPins: SchPin[] = pins.map(p => {
      const count = seen.get(p.n) ?? 0;
      seen.set(p.n, count + 1);
      return {
        id: `${id}#${p.n}${count ? `@${count + 1}` : ''}`, number: p.n, name: p.name ?? '', at: { x: p.x, y: p.y }, body: { x: p.x, y: p.y },
        type: p.type ?? 'passive', hidden: p.hidden ?? false, unit: p.unit ?? 0, ...(p.implicitNet ? { implicitNet: p.implicitNet } : {}),
      };
    });
    const symbol: SchSymbol = {
      id, libId: options.libId ?? `Test:${ref.replace(/\d+$/, '')}`, refDefault: ref,
      instances: { '': { ref, unit }, ...(options.instances ?? {}) },
      value: options.value ?? '', footprint: '', datasheet: '', unit, unitCount: options.unitCount ?? 1,
      at: { x: pins[0]?.x ?? 0, y: pins[0]?.y ?? 0 }, rotation: 0, mirror: 'none', pins: symPins, graphics: [], fields: [],
      virtual: options.virtual ?? false, dnp: options.dnp ?? false, bounds: boundsOf(symPins.map(p => p.at)),
    };
    if (options.power !== undefined) symbol.power = { net: options.power };
    this.def.symbols.push(symbol);
    return this;
  }
  /** Power symbol (virtual, one hidden pin) whose pin sits at (x, y). */
  power(net: string, x: number, y: number, id = this.next('#PWR')): this {
    return this.part(id, [{ n: '1', x, y, name: net, type: 'power_in', hidden: true }], { id, power: net, virtual: true, libId: 'power:' + net });
  }
  /** Sheet symbol (hierarchical sheet) with sheet pins; `defId` defaults to the definition id given. */
  sheet(id: string, defId: string | null, name: string, pins: Array<{ name: string; x: number; y: number; shape?: SchSheetPin['shape'] }>, options: SubSheetOptions = {}): this {
    const ref: SchSheetRef = {
      id, name, file: options.file ?? (defId ? `${defId}.kicad_sch` : `${name}.kicad_sch`), defId: options.defId !== undefined ? options.defId : defId,
      at: options.at ?? { x: 0, y: 0 }, size: options.size ?? { x: 10, y: 10 },
      pins: pins.map((p, i) => ({ id: `${id}.pin${i + 1}`, name: p.name, at: { x: p.x, y: p.y }, shape: p.shape ?? 'bidirectional' })),
    };
    this.def.sheetRefs.push(ref);
    return this;
  }
  build(): SchSheetDef { return this.def; }
}

export interface BuildOptions {
  format?: SchematicFormat;
  name?: string;
  declaredNets?: SchDeclaredNet[];
  /** 'slash' (default): child path = parent + '/' + sheet id (root '' -> '/id'); 'joined': ids joined without a leading slash. */
  pathStyle?: 'slash' | 'joined';
}

/** Expanded hierarchy of `defs` from the root definition (preorder; a repeated sub-sheet repeats its definition). */
export function buildInstances(defs: SchSheetDef[], rootId: string, pathStyle: 'slash' | 'joined' = 'slash'): SchSheetInstance[] {
  const byId = new Map(defs.map(d => [d.id, d]));
  const out: SchSheetInstance[] = [];
  const walk = (defId: string, path: string, parent: SchSheetInstance | null, ref: SchSheetRef | null, depth: number): void => {
    const def = byId.get(defId);
    if (!def) return;
    const inst: SchSheetInstance = { path, defId, name: ref ? ref.name : def.name, page: String(out.length + 1), parentPath: parent ? parent.path : null, sheetRefId: ref ? ref.id : null, childPaths: [], depth };
    out.push(inst);
    if (parent) parent.childPaths.push(path);
    for (const r of def.sheetRefs) {
      if (r.defId === null || !byId.has(r.defId)) continue;
      const childPath = pathStyle === 'joined' && path === '' ? r.id : `${path}/${r.id}`;
      walk(r.defId, childPath, inst, r, depth + 1);
    }
  };
  walk(rootId, '', null, null, 0);
  return out;
}

/** Assembles a `Schematic` from builders; the first sheet is the root. */
export function buildSchematic(sheets: Array<SheetBuilder | SchSheetDef>, options: BuildOptions = {}): Schematic {
  const defs = sheets.map(s => (s instanceof SheetBuilder ? s.build() : s));
  const root = defs[0];
  return {
    format: options.format ?? 'kicad-sch', formatLabel: 'Synthetic test schematic', sourceUnit: 'mm', name: options.name ?? root.name,
    defs, rootDefId: root.id, instances: buildInstances(defs, root.id, options.pathStyle), ...(options.declaredNets ? { declaredNets: options.declaredNets } : {}), diagnostics: [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------------------------------------------

/** `ref.pinNumber` of every member, e.g. ["R1.2", "R2.1"] (already sorted by the engine). */
export const memberLabels = (net: SchNet): string[] => net.members.map(m => `${m.ref}.${m.pinNumber}`);
export const netByName = (c: SchConnectivity, name: string): SchNet | undefined => c.nets.find(n => n.name === name);
/** The net a pin `${symbolId}#${number}` belongs to (undefined when floating / no-connect). */
export function netOfPin(c: SchConnectivity, symbolId: string, number: string, instancePath = ''): SchNet | undefined {
  const id = c.pinNet[pinKey(instancePath, symbolId, `${symbolId}#${number}`)];
  return id === undefined ? undefined : c.nets.find(n => n.id === id);
}
/** Net-name view of a result for compact assertions: "name: R1.1 R2.1" lines, sorted. */
export const summarize = (c: SchConnectivity): string[] => c.nets.map(n => `${n.name}: ${memberLabels(n).join(' ')}`.trim()).sort();

// ---------------------------------------------------------------------------------------------------------------
// Golden fixtures (original, synthetic)
// ---------------------------------------------------------------------------------------------------------------

export interface GoldenFixture {
  schematic: Schematic;
  /** Expected `summarize()` lines of the connectivity result. */
  expected: string[];
}

/** Flat sheet: VCC -> R1 -> OUT -> R2 -> GND with a local label on the divider tap. */
export function fixtureDivider(): GoldenFixture {
  const s = new SheetBuilder('root', 'divider')
    .power('VCC', 20, 0).wire(20, 0, 20, 10)
    .part('R1', [{ n: '1', x: 20, y: 10 }, { n: '2', x: 20, y: 20 }])
    .wire(20, 20, 20, 30).local('OUT', 20, 25)
    .part('R2', [{ n: '1', x: 20, y: 30 }, { n: '2', x: 20, y: 40 }])
    .wire(20, 40, 20, 50).power('GND', 20, 50);
  return { schematic: buildSchematic([s]), expected: ['GND: R2.2', 'OUT: R1.2 R2.1', 'VCC: R1.1'] };
}

/**
 * One definition ("amp": R1 between hierarchical labels IN and OUT) instantiated twice under the root, which wires
 * U1.1 -> amp1 -> U1.2 and U1.3 -> amp2 -> U1.4. The two instances annotate R1 / R2.
 */
export function fixtureRepeatedSheet(): GoldenFixture {
  const amp = new SheetBuilder('amp', 'amp')
    .hier('IN', 0, 0).wire(0, 0, 10, 0)
    .part('R?', [{ n: '1', x: 10, y: 0 }, { n: '2', x: 20, y: 0 }], { id: 'r', instances: { '/amp1': { ref: 'R1', unit: 1 }, '/amp2': { ref: 'R2', unit: 1 } } })
    .wire(20, 0, 30, 0).hier('OUT', 30, 0);
  const root = new SheetBuilder('root', 'top')
    .part('U1', [{ n: '1', x: 0, y: 0 }, { n: '2', x: 0, y: 20 }, { n: '3', x: 0, y: 40 }, { n: '4', x: 0, y: 60 }])
    .sheet('amp1', 'amp', 'amp1', [{ name: 'IN', x: 50, y: 0 }, { name: 'OUT', x: 60, y: 0 }])
    .sheet('amp2', 'amp', 'amp2', [{ name: 'IN', x: 50, y: 40 }, { name: 'OUT', x: 60, y: 40 }])
    .path([0, 0], [50, 0]).path([60, 0], [70, 0], [70, 20], [0, 20])
    .path([0, 40], [50, 40]).path([60, 40], [70, 40], [70, 60], [0, 60]);
  return { schematic: buildSchematic([root, amp]), expected: ['IN: R1.1 U1.1', 'IN: R2.1 U1.3', 'OUT: R1.2 U1.2', 'OUT: R2.2 U1.4'] };
}

/** An 8-bit bus D[0..7] with two taps (D0, D1) into two resistors; entries never short the members. */
export function fixtureBus(): GoldenFixture {
  const s = new SheetBuilder('root', 'bus')
    .bus(0, 0, 40, 0).local('D[0..7]', 20, 0)
    .entry(10, 0, 12.54, 2.54).wire(12.54, 2.54, 12.54, 10).local('D0', 12.54, 5)
    .entry(20, 0, 22.54, 2.54).wire(22.54, 2.54, 22.54, 10).local('D1', 22.54, 5)
    .part('R1', [{ n: '1', x: 12.54, y: 10 }, { n: '2', x: 12.54, y: 20 }])
    .part('R2', [{ n: '1', x: 22.54, y: 10 }, { n: '2', x: 22.54, y: 20 }]);
  return { schematic: buildSchematic([s]), expected: ['D0: R1.1', 'D1: R2.1'] };
}

/** EAGLE-style declared connectivity over two sheets: GND is one net across both, wires may touch without joining nets. */
export function fixtureDeclared(): GoldenFixture {
  const s1 = new SheetBuilder('sheet:1', '1').part('R1', [{ n: '1', x: 0, y: 0 }, { n: '2', x: 10, y: 0 }]).part('C1', [{ n: '1', x: 10, y: 0 }, { n: '2', x: 20, y: 0 }]).wire(0, 0, 10, 0).wire(10, 0, 20, 0);
  const s2 = new SheetBuilder('sheet:2', '2').part('R2', [{ n: '1', x: 0, y: 0 }, { n: '2', x: 10, y: 0 }]);
  const base = buildSchematic([s1, s2], { format: 'eagle-sch' });
  base.instances = [
    { path: '', defId: 'sheet:1', name: '1', page: '1', parentPath: null, sheetRefId: null, childPaths: [], depth: 0 },
    { path: 'sheet:2', defId: 'sheet:2', name: '2', page: '2', parentPath: null, sheetRefId: null, childPaths: [], depth: 0 },
  ];
  const ref = (path: string, defId: string, symbolId: string, n: string): SchDeclaredNet['pins'][number] => ({ instancePath: path, defId, symbolId, pinId: `${symbolId}#${n}` });
  base.declaredNets = [
    { name: 'GND', pins: [ref('', 'sheet:1', 'R1', '1'), ref('', 'sheet:1', 'C1', '2')] },
    { name: 'GND', pins: [ref('sheet:2', 'sheet:2', 'R2', '1')] },
    { name: 'N$1', pins: [ref('', 'sheet:1', 'R1', '2'), ref('', 'sheet:1', 'C1', '1')] },
  ];
  return { schematic: base, expected: ['GND: C1.2 R1.1 R2.1', 'N$1: C1.1 R1.2'] };
}

export interface StressOptions { symbols: number; wiresPerSymbol?: number }
/**
 * Generator for performance tests: `symbols` two-pin parts on a grid; each part's right pin is wired to the next
 * part's left pin, plus T-connected stubs (wire ends on the interior of the main wire) and crossing decoy wires.
 * Default 5 wires per part, i.e. 100k wires for 20k parts. Nets: one per adjacent part pair (T stubs join, decoys do not).
 */
export function fixtureStress(options: StressOptions): Schematic {
  const per = options.wiresPerSymbol ?? 5;
  const columns = 100;
  const b = new SheetBuilder('root', 'stress');
  for (let k = 0; k < options.symbols; k++) {
    const col = k % columns, row = Math.floor(k / columns);
    const x = col * 20, y = row * 20;
    b.part(`R${k + 1}`, [{ n: '1', x, y }, { n: '2', x: x + 5, y }]);
    if (col < columns - 1) b.wire(x + 5, y, x + 20, y);
    for (let s = 1; s < per; s++) {
      if (s === 1) b.wire(x + 10, y, x + 10, y + 3);
      else if (s === 2) b.wire(x + 12, y + 1, x + 12, y - 1);
      else if (s === 3) b.wire(x + 14, y + 2, x + 16, y + 2);
      else b.wire(x + 16, y + 2, x + 16, y + 5 + s);
    }
    if (k % 50 === 0) b.local(`N${k}`, x + 7, y);
  }
  return buildSchematic([b]);
}
