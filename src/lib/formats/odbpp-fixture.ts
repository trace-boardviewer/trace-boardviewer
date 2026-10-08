/*
 * Test-only writer of synthetic ODB++ product models (original, MIT). The layout follows the public ODB++ Design Format
 * Specification 8.1 structure (matrix/matrix, misc/info, steps/<step>/{stephdr,profile,eda/data,layers/comp_+_top|bot/components,
 * netlists/cadnet/netlist}); every design in it is invented. Also writes the containers the reader accepts (ustar/pax/GNU tar,
 * gzip, ZIP, UNIX compress) including deliberately hostile variants. Never imported by the application.
 */
import { gzipSync, zipSync, deflateSync } from 'fflate';

export type Units = 'MM' | 'INCH';
export interface Point { x: number; y: number }
export type FixtureOutline =
  | { rc: [number, number, number, number] }
  | { cr: [number, number, number] }
  | { sq: [number, number, number] }
  /** Raw contour records in mm (OB/OS/OC/OE lines, numbers converted to the file units). */
  | { ct: Array<[string, ...Array<number | string>]> };
export interface FixturePin {
  name: string; type: 'T' | 'S' | 'B'; x: number; y: number; outline: FixtureOutline;
  /**
   * What the toeprint's board features are (eda/data FID records): 'far' a surface pad on the copper of the other side (edge connectors),
   * 'paste' a paste aperture with no copper (written as PIN ... U S), 'hole' an unplated hole (PIN ... M H, mask openings only).
   */
  kind?: 'far' | 'paste' | 'hole';
}
export interface FixturePackage { name: string; pitch: number; bbox: [number, number, number, number]; body: FixtureOutline; pins: FixturePin[] }
export interface FixtureComponent {
  pkg: number; ref: string; part: string; x: number; y: number; rot: number; mirror: boolean;
  props: Array<[string, string]>; bom?: string[]; attributes?: string;
  /** Net name per package pin (index = pin index); '' or '$NONE$' for no net. */
  nets: string[];
}
export interface FixtureModel {
  packages: FixturePackage[];
  top: FixtureComponent[];
  bottom: FixtureComponent[];
  /** Profile polygons in mm: island first, then holes. Arcs as ['OC', xe, ye, xc, yc, 'Y'|'N']. */
  profile: Array<{ hole: boolean; records: Array<[string, ...Array<number | string>]> }>;
}

/**
 * The canonical board: five top and two bottom components, SMD and through-hole pins, every outline record type (a rotated rectangle and a
 * rounded one among the contours), an edge connector with a pad on the bottom copper, a paste aperture, an unplated hole, and an arc profile
 * with a hole.
 */
export const CANONICAL: FixtureModel = {
  packages: [
    { name: 'R0603', pitch: 1.6, bbox: [-1.5, -0.8, 1.5, 0.8], body: { rc: [-1.5, -0.8, 3, 1.6] }, pins: [
      { name: '1', type: 'S', x: -0.8, y: 0, outline: { rc: [-1.2, -0.45, 0.8, 0.9] } },
      { name: '2', type: 'S', x: 0.8, y: 0, outline: { rc: [0.4, -0.45, 0.8, 0.9] } },
    ] },
    { name: 'SOT-23', pitch: 0.95, bbox: [-1.5, -1.4, 1.5, 1.4], body: { ct: [['OB', -1.45, -0.65, 'I'], ['OS', 1.45, -0.65], ['OS', 1.45, 0.65], ['OS', -1.45, 0.65], ['OS', -1.45, -0.65], ['OE']] }, pins: [
      { name: '1', type: 'S', x: -0.95, y: -1.1, outline: { sq: [-0.95, -1.1, 0.3] } },
      { name: '2', type: 'S', x: 0.95, y: -1.1, outline: { sq: [0.95, -1.1, 0.3] } },
      { name: '3', type: 'S', x: 0, y: 1.1, outline: { ct: [['OB', -0.3, 0.7, 'I'], ['OS', 0.3, 0.7], ['OS', 0.3, 1.5], ['OS', -0.3, 1.5], ['OS', -0.3, 0.7], ['OE']] } },
    ] },
    { name: 'CONN-2', pitch: 2.54, bbox: [-1.27, -1.27, 3.81, 1.27], body: { ct: [['OB', 0, -1.27, 'I'], ['OS', 2.54, -1.27], ['OC', 2.54, 1.27, 2.54, 0, 'N'], ['OS', 0, 1.27], ['OC', 0, -1.27, 0, 0, 'N'], ['OE']] }, pins: [
      { name: 'A', type: 'T', x: 0, y: 0, outline: { cr: [0, 0, 0.8] } },
      { name: 'B', type: 'T', x: 2.54, y: 0, outline: { ct: [['OB', 3.34, 0, 'I'], ['OC', 3.34, 0, 2.54, 0, 'Y'], ['OE']] } },
      { name: 'NPTH0', type: 'T', x: 1.27, y: 2, outline: { cr: [1.27, 2, 0.5] }, kind: 'hole' },
    ] },
    { name: 'TP-2', pitch: 2, bbox: [-1.6, -1, 1.6, 1], body: { cr: [0, 0, 1.6] }, pins: [
      // A polygonized circle (16 vertices on the circle) and a triangle (approximated by its smallest enclosing rectangle).
      { name: '1', type: 'S', x: -1, y: 0, outline: { ct: [['OB', -0.5, 0, 'I'], ...Array.from({ length: 15 }, (_, i) => { const a = 2 * Math.PI * (i + 1) / 16; return ['OS', -1 + 0.5 * Math.cos(a), 0.5 * Math.sin(a)] as [string, number, number]; }), ['OS', -0.5, 0], ['OE']] } },
      { name: '2', type: 'S', x: 1, y: 0, outline: { ct: [['OB', 0.6, -0.4, 'I'], ['OS', 1.4, -0.4], ['OS', 1, 0.4], ['OS', 0.6, -0.4], ['OE']] } },
      { name: 'PAD0', type: 'S', x: -1, y: 0, outline: { rc: [-1.3, -0.3, 0.6, 0.6] }, kind: 'paste' },
    ] },
    { name: 'EDGE-3', pitch: 1, bbox: [-2, -1, 2, 1], body: { rc: [-2, -1, 4, 2] }, pins: [
      // A rectangle turned by 30° in the package and a rounded rectangle (four quarter arcs).
      { name: '1', type: 'S', x: -1, y: 0, outline: { ct: rotatedRectangle(-1, 0, 0.8, 0.4, 30) } },
      { name: 'B1', type: 'S', x: 1, y: 0, outline: { ct: [['OB', 0.8, -0.5, 'I'], ['OS', 1.2, -0.5], ['OC', 1.4, -0.3, 1.2, -0.3, 'N'], ['OS', 1.4, 0.3], ['OC', 1.2, 0.5, 1.2, 0.3, 'N'], ['OS', 0.8, 0.5], ['OC', 0.6, 0.3, 0.8, 0.3, 'N'], ['OS', 0.6, -0.3], ['OC', 0.8, -0.5, 0.8, -0.3, 'N'], ['OE']] }, kind: 'far' },
    ] },
  ],
  top: [
    { pkg: 0, ref: 'R1', part: 'RC0603FR-0710KL', x: 10, y: 10, rot: 0, mirror: false, props: [['Value', '10k'], ['PART_NUMBER', 'RC0603-10K']], attributes: '0=1,1', nets: ['VCC', 'SIG'] },
    { pkg: 1, ref: 'U1', part: 'BC847B', x: 20, y: 12, rot: 90, mirror: false, props: [['VALUE', 'BC847'], ['Note', 'it\'s quoted']], bom: ['CPN C-123', 'IPN 4711', 'DSC NPN 45V', 'VPL_VND NEXPERIA', 'VPL_MPN BC847B,215', 'VND NEXPERIA', 'MPN 0 Y BC847B'], nets: ['SIG', 'GND', 'OUT'] },
    { pkg: 2, ref: 'J1', part: 'HDR-1X2', x: 30, y: 15, rot: 270, mirror: false, props: [['Value', 'HDR']], nets: ['VCC', 'GND', ''] },
    { pkg: 3, ref: 'TP1', part: '???', x: 40, y: 5, rot: 45, mirror: false, props: [], nets: ['OUT', '$NONE$', ''] },
    { pkg: 4, ref: 'E1', part: 'EDGE', x: 44, y: 20, rot: 0, mirror: false, props: [], nets: ['SIG', 'GND'] },
  ],
  bottom: [
    { pkg: 0, ref: 'R2', part: 'R-1K', x: 12, y: 20, rot: 0, mirror: true, props: [['Value', '1k']], nets: ['OUT', 'GND'] },
    { pkg: 1, ref: 'U2', part: 'BC857B', x: 25, y: 22, rot: 90, mirror: true, props: [['Value', 'BC857']], nets: ['VCC', 'GND', 'SIG'] },
  ],
  profile: [
    { hole: false, records: [['OB', 0, 0, 'I'], ['OS', 50, 0], ['OS', 50, 25], ['OC', 45, 30, 45, 25, 'N'], ['OS', 0, 30], ['OS', 0, 0], ['OE']] },
    { hole: true, records: [['OB', 5, 5, 'H'], ['OS', 8, 5], ['OS', 8, 8], ['OS', 5, 8], ['OS', 5, 5], ['OE']] },
  ],
};
export const NET_ORDER = ['$NONE$', 'GND', 'VCC', 'SIG', 'OUT'];
/** NET_ORDER, then any other net name the model uses, in first-use order: the eda/data NET record order. */
export function netOrder(model: FixtureModel): string[] {
  const order = [...NET_ORDER];
  for (const side of ['top', 'bottom'] as const) for (const component of model[side]) for (const net of component.nets) if (net && !order.includes(net)) order.push(net);
  return order;
}

/** Contour records of a w × h rectangle centred on (x, y), its width turned `degrees` counter-clockwise. */
export function rotatedRectangle(x: number, y: number, w: number, h: number, degrees: number): Array<[string, ...Array<number | string>]> {
  const a = degrees * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const corner = (u: number, v: number): [number, number] => [x + u * cos - v * sin, y + u * sin + v * cos];
  const points = [corner(-w / 2, -h / 2), corner(w / 2, -h / 2), corner(w / 2, h / 2), corner(-w / 2, h / 2)];
  return [['OB', ...points[0], 'I'], ...points.slice(1).map(p => ['OS', ...p] as [string, number, number]), ['OS', ...points[0]], ['OE']];
}
/** Package point → board point with the specification's placement: rotate clockwise by `rot`, then mirror X when mirrored, then translate. */
export function specPlace(component: { x: number; y: number; rot: number; mirror: boolean }, p: Point): Point {
  const a = component.rot * Math.PI / 180, cos = Math.round(Math.cos(a) * 1e12) / 1e12, sin = Math.round(Math.sin(a) * 1e12) / 1e12;
  let x = p.x * cos + p.y * sin;
  const y = -p.x * sin + p.y * cos;
  if (component.mirror) x = -x;
  return { x: component.x + x, y: component.y + y };
}
/** An exporter that writes bottom packages already flipped top-to-bottom: rotate clockwise, mirror Y, no further mirror. */
export function flippedPlace(component: { x: number; y: number; rot: number; mirror: boolean }, p: Point): Point {
  return specPlace({ ...component, mirror: false }, { x: p.x, y: -p.y });
}

export interface WriteOptions {
  step?: string;
  units?: Partial<Record<'info' | 'components' | 'eda' | 'profile' | 'netlist' | 'stephdr', Units | null>>;
  /** Write SNT TOP subnet records (default true). */
  subnets?: boolean;
  /** Write FID records after the SNT TOP records (default true). */
  fids?: boolean;
  /** Write net numbers in TOP records (default true; false writes -1). */
  topNets?: boolean;
  eda?: boolean;
  netlist?: boolean | { negateY?: boolean };
  matrix?: boolean;
  place?: (component: FixtureComponent, p: Point, side: 'top' | 'bottom') => Point;
  extraSteps?: Record<string, string>;
  /** Raw matrix text replacing the generated one. */
  matrixText?: string;
  /** misc/info ODB_SOURCE and HDR text (default "TRACE fixture writer"). */
  writer?: string;
}
const f = (value: number, units: Units) => { const scaled = units === 'INCH' ? value / 25.4 : value; return Number(scaled.toFixed(units === 'INCH' ? 7 : 6)).toString(); };
const unitsLine = (units: Units | null | undefined) => units === null ? '' : `UNITS=${units ?? 'MM'}\n`;
function outlineLines(outline: FixtureOutline, units: Units): string[] {
  if ('rc' in outline) return [`RC ${outline.rc.map(v => f(v, units)).join(' ')}`];
  if ('cr' in outline) return [`CR ${outline.cr.map(v => f(v, units)).join(' ')}`];
  if ('sq' in outline) return [`SQ ${outline.sq.map(v => f(v, units)).join(' ')}`];
  return ['CT', ...outline.ct.map(([record, ...rest]) => [record, ...rest.map(v => typeof v === 'number' ? f(v, units) : v)].join(' ')), 'CE'];
}
/** Matrix layers of the fixture in row order: copper TOP (row 5), GND2 and BOTTOM. */
export const MATRIX_LAYERS: ReadonlyArray<readonly [string, string]> = [
  ['COMPONENT', 'COMP_+_TOP'], ['SILK_SCREEN', 'SST'], ['SOLDER_PASTE', 'SPT'], ['SOLDER_MASK', 'SMT'], ['SIGNAL', 'TOP'], ['POWER_GROUND', 'GND2'], ['SIGNAL', 'BOTTOM'],
  ['SOLDER_MASK', 'SMB'], ['SOLDER_PASTE', 'SPB'], ['COMPONENT', 'COMP_+_BOT'], ['DRILL', 'DRILL'],
];
/** eda/data LYR order, so FID layer numbers: 0 top, 1 gnd2, 2 bottom, 3 smt, 4 smb, 5 spt, 6 spb. */
const LYR = ['top', 'gnd2', 'bottom', 'smt', 'smb', 'spt', 'spb'];
/** FID layer numbers of a toeprint of `pin` on a component of `side`. */
function fidLayers(pin: FixturePin, side: 'top' | 'bottom'): number[] {
  const own = side === 'top' ? { copper: 0, mask: 3, paste: 5 } : { copper: 2, mask: 4, paste: 6 }, far = side === 'top' ? { copper: 2, mask: 4 } : { copper: 0, mask: 3 };
  if (pin.kind === 'paste') return [own.paste];
  if (pin.kind === 'hole') return [3, 4];
  if (pin.kind === 'far') return [far.copper, far.mask];
  return pin.type === 'T' ? [0, 1, 2, 3, 4] : [own.copper, own.mask, own.paste];
}
/** The pins a reader must produce for `model` (paste apertures are not pins), with their board side. */
export function pinPositions(model: FixtureModel, options: WriteOptions = {}): Array<{ side: 'top' | 'bottom'; ref: string; pin: string; x: number; y: number; net: string; through: boolean; padSide: 'top' | 'bottom' | 'both' }> {
  const place = options.place ?? ((component: FixtureComponent, p: Point) => specPlace(component, p));
  const rows: ReturnType<typeof pinPositions> = [];
  for (const side of ['top', 'bottom'] as const) for (const component of model[side]) {
    model.packages[component.pkg].pins.forEach((pin, index) => {
      if (pin.kind === 'paste') return;
      const at = place(component, pin, side), net = component.nets[index] ?? '';
      const padSide = pin.type === 'T' ? 'both' : pin.kind === 'far' ? (side === 'top' ? 'bottom' : 'top') : side;
      rows.push({ side, ref: component.ref, pin: pin.name, x: at.x, y: at.y, net: net === '$NONE$' ? '' : net, through: pin.type === 'T', padSide });
    });
  }
  return rows;
}
const mountType = (pin: FixturePin) => pin.kind === 'hole' ? 'M H' : pin.kind === 'paste' ? 'U S' : pin.type === 'T' ? 'E T' : 'E S';

/** Product-model files (paths relative to the product-model root) for `model`. */
export function writeJob(model: FixtureModel = CANONICAL, options: WriteOptions = {}): Record<string, string> {
  const step = options.step ?? 'pcb', u = options.units ?? {}, writer = options.writer ?? 'TRACE fixture writer', nets = netOrder(model);
  const cu = u.components === undefined ? 'MM' : u.components, eu = u.eda === undefined ? 'MM' : u.eda, pu = u.profile === undefined ? 'MM' : u.profile, nu = u.netlist === undefined ? 'MM' : u.netlist;
  // A file written without UNITS uses the reader's fallback: misc/info, else INCH.
  const fallback: Units = u.info === null ? 'INCH' : u.info ?? 'MM';
  const place = options.place ?? ((component: FixtureComponent, p: Point) => specPlace(component, p));
  const files: Record<string, string> = {};
  if (options.matrix !== false) files['matrix/matrix'] = options.matrixText ?? [
    `STEP {\n    COL=1\n    NAME=${step.toUpperCase()}\n}`,
    ...Object.keys(options.extraSteps ?? {}).map((name, index) => `STEP {\n    COL=${index + 2}\n    NAME=${name.toUpperCase()}\n}`),
    ...MATRIX_LAYERS.map(([type, name], index) => `LAYER {\n    ROW=${index + 1}\n    CONTEXT=BOARD\n    TYPE=${type}\n    NAME=${name}\n    OLD_NAME=\n    POLARITY=POSITIVE${type === 'DRILL' ? '\n    START_NAME=TOP\n    END_NAME=BOTTOM' : ''}\n}`),
  ].join('\n\n') + '\n';
  files['misc/info'] = `${u.info === null ? '' : `UNITS=${u.info ?? 'MM'}\n`}JOB_NAME=fixture\nODB_VERSION_MAJOR=8\nODB_VERSION_MINOR=1\nODB_SOURCE=${writer}\nCREATION_DATE=20261007.120000\nSAVE_APP=${writer}\n`;
  files[`steps/${step}/stephdr`] = `${unitsLine(u.stephdr)}X_DATUM=0\nY_DATUM=0\nX_ORIGIN=0\nY_ORIGIN=0\n`;
  const profile = [unitsLine(pu).trim(), '#', '#Num Features', '#', 'F 1', '#', '#Layer features', '#', 'S P 0'];
  for (const polygon of model.profile) for (const [record, ...rest] of polygon.records) profile.push([record, ...rest.map(v => typeof v === 'number' ? f(v, pu ?? fallback) : v)].join(' '));
  profile.push('SE');
  files[`steps/${step}/profile`] = profile.filter(line => line !== '').join('\n') + '\n';
  // eda/data
  if (options.eda !== false) {
    const units = eu ?? fallback;
    const eda: string[] = ['# fixture', `HDR ${writer}`, unitsLine(eu).trim(), `LYR ${LYR.join(' ')}`, '#', '#Net attribute names', '#', '@0 .critical_net', '&0 none', ''];
    let feature = 0;
    nets.forEach((name, index) => {
      eda.push(`#NET ${index}`, `NET ${name}${index === 1 ? ';0;ID=11' : ''}`);
      if (options.subnets === false) return;
      for (const [sideIndex, side] of (['top', 'bottom'] as const).entries()) model[side].forEach((component, compIndex) => component.nets.forEach((net, pinIndex) => {
        if ((net || '$NONE$') !== name) return;
        eda.push(`SNT TOP ${sideIndex ? 'B' : 'T'} ${compIndex} ${pinIndex}`);
        if (options.fids !== false) for (const layer of fidLayers(model.packages[component.pkg].pins[pinIndex], side)) eda.push(`FID C ${layer} ${feature++}`);
      }));
      eda.push('SNT VIA', 'FID C 0 99', 'FID H 1 7', 'SNT TRC', 'FID C 2 98');
    });
    model.packages.forEach((pkg, index) => {
      eda.push('#', `# PKG ${index}`, `PKG ${pkg.name} ${f(pkg.pitch, units)} ${pkg.bbox.map(v => f(v, units)).join(' ')};;ID=${100 + index}`, ...outlineLines(pkg.body, units), `PRP HEIGHT '1.2'`);
      for (const pin of pkg.pins) eda.push(`PIN ${pin.name} ${pin.type} ${f(pin.x, units)} ${f(pin.y, units)} 0 ${mountType(pin)} ID=${200 + index}`, ...outlineLines(pin.outline, units));
    });
    eda.push('# FGR 0', 'FGR TEXT', "PRP string 'R1'", 'FID C 0 500');
    files[`steps/${step}/eda/data`] = eda.filter(line => line !== '').join('\n') + '\n';
  }
  for (const side of ['top', 'bottom'] as const) {
    const units = cu ?? fallback;
    const lines = [unitsLine(cu).trim(), '#', '#Component attribute names', '#', '@0 .comp_mount_type', '@1 .no_pop', '#', '#Component attribute text strings', '#', '&0 unused'];
    model[side].forEach((component, index) => {
      lines.push(`# CMP ${index}`, `CMP ${component.pkg} ${f(component.x, units)} ${f(component.y, units)} ${component.rot} ${component.mirror ? 'M' : 'N'} ${component.ref} ${component.part} ;${component.attributes ?? ''};ID=${300 + index}`);
      for (const [name, value] of component.props) lines.push(`PRP ${name} '${value}'`);
      model.packages[component.pkg].pins.forEach((pin, pinIndex) => {
        const at = place(component, pin, side), net = nets.indexOf(component.nets[pinIndex] || '$NONE$');
        lines.push(`TOP ${pinIndex} ${f(at.x, units)} ${f(at.y, units)} ${component.rot} ${component.mirror ? 'M' : 'N'} ${options.topNets === false ? -1 : net} ${pinIndex} ${pin.name}`);
      });
      if (component.bom) lines.push('#', '# BOM DATA', ...component.bom);
    });
    files[`steps/${step}/layers/comp_+_${side === 'top' ? 'top' : 'bot'}/components`] = lines.filter(line => line !== '').join('\n') + '\n';
    files[`steps/${step}/layers/comp_+_${side === 'top' ? 'top' : 'bot'}/features`] = `${unitsLine(cu)}#\n#Num Features\n#\nF 0\n`;
  }
  files[`steps/${step}/layers/top/features`] = 'UNITS=MM\n#\n$0 r100\nF 1\nP 1 1 0 P 0 0\n';
  if (options.netlist) {
    const units = nu ?? fallback, negate = typeof options.netlist === 'object' && options.netlist.negateY;
    const names = nets.filter(name => name !== '$NONE$');
    const lines = [unitsLine(nu).trim(), 'H optimize n staggered n', ...names.map((name, index) => `$${index} ${name}`)];
    for (const row of pinPositions(model, options)) {
      if (!row.net) continue;
      lines.push(`${names.indexOf(row.net)} ${row.through ? '0.4' : '0.002'} ${f(row.x, units)} ${f(negate ? -row.y : row.y, units)} ${row.padSide === 'both' ? 'B' : row.padSide === 'top' ? 'T' : 'D'} e e staggered 0 0 0`);
    }
    files[`steps/${step}/netlists/cadnet/netlist`] = lines.filter(line => line !== '').join('\n') + '\n';
  }
  for (const [name, stephdr] of Object.entries(options.extraSteps ?? {})) files[`steps/${name}/stephdr`] = stephdr;
  files['fonts/standard'] = 'XSIZE 0.3\nYSIZE 0.3\n';
  return files;
}
export function rooted(files: Record<string, string | Uint8Array>, root: string): Record<string, string | Uint8Array> {
  return Object.fromEntries(Object.entries(files).map(([path, data]) => [`${root}${path}`, data]));
}
const encoder = new TextEncoder();
export const bytesOf = (data: string | Uint8Array) => typeof data === 'string' ? encoder.encode(data) : data;

// --- tar ---

export interface TarEntry { path: string; data?: string | Uint8Array; type?: string; link?: string; prefix?: string; longName?: 'gnu' | 'pax'; breakChecksum?: boolean; sizeOverride?: number; base256Size?: boolean; gnuMagic?: boolean }
function octal(value: number, width: number): string { return value.toString(8).padStart(width - 1, '0') + '\0'; }
function header(name: string, size: number, type: string, options: { link?: string; prefix?: string; gnu?: boolean; breakChecksum?: boolean; base256?: boolean } = {}): Uint8Array {
  const block = new Uint8Array(512);
  const put = (text: string, at: number, width: number) => { const bytes = encoder.encode(text); block.set(bytes.subarray(0, width), at); };
  put(name, 0, 100); put(octal(0o644, 8), 100, 8); put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8);
  if (options.base256) { block[124] = 0x80; let rest = size; for (let index = 135; index > 124; index--) { block[index] = rest % 256; rest = Math.floor(rest / 256); } }
  else put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12); put('        ', 148, 8); put(type, 156, 1);
  if (options.link) put(options.link, 157, 100);
  if (options.gnu) put('ustar  \0', 257, 8); else { put('ustar\0', 257, 6); put('00', 263, 2); }
  if (options.prefix) put(options.prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(octal(options.breakChecksum ? sum + 1 : sum, 7) + ' ', 148, 8);
  return block;
}
const pad = (data: Uint8Array) => { const out = new Uint8Array(Math.ceil(data.length / 512) * 512); out.set(data); return out; };
/** pax extended header record "<length> <key>=<value>\n" (the length counts the whole record). */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = encoder.encode(body).length + 1;
  while (String(length).length + encoder.encode(body).length !== length) length++;
  return `${length}${body}`;
}
export function tarEntries(entries: TarEntry[], options: { end?: boolean } = {}): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const data = entry.data === undefined ? new Uint8Array(0) : bytesOf(entry.data);
    let name = entry.path;
    if (entry.longName === 'gnu') { const long = encoder.encode(`${entry.path}\0`); blocks.push(header('././@LongLink', long.length, 'L', { gnu: true }), pad(long)); name = entry.path.slice(0, 99); }
    if (entry.longName === 'pax') {
      const pax = encoder.encode(paxRecord('path', entry.path));
      blocks.push(header('PaxHeader/x', pax.length, 'x'), pad(pax)); name = entry.path.slice(0, 99);
    }
    blocks.push(header(name, entry.sizeOverride ?? data.length, entry.type ?? '0', { link: entry.link, prefix: entry.prefix, breakChecksum: entry.breakChecksum, base256: entry.base256Size, gnu: entry.gnuMagic }), pad(data));
  }
  if (options.end !== false) blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let at = 0;
  for (const block of blocks) { out.set(block, at); at += block.length; }
  return out;
}
export const tarOf = (files: Record<string, string | Uint8Array>) => tarEntries(Object.entries(files).map(([path, data]) => ({ path, data })));
export const tgzOf = (files: Record<string, string | Uint8Array>) => gzipSync(tarOf(files));
export const zipOf = (files: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(files).map(([path, data]) => [path, bytesOf(data)])));

// --- raw ZIP writer for hostile variants ---

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc(data: Uint8Array): number { let c = 0xffffffff; for (const byte of data) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export interface RawZipEntry { name: string; data: string | Uint8Array; method?: number; flags?: number; crcOverride?: number; sizeOverride?: number; symlink?: boolean; zip64?: boolean }
export function rawZip(entries: RawZipEntry[], options: { omitDirectory?: boolean; disk?: number } = {}): Uint8Array {
  const parts: number[] = [], central: number[] = [];
  const u16 = (out: number[], v: number) => out.push(v & 0xff, v >>> 8 & 0xff);
  const u32 = (out: number[], v: number) => out.push(v & 0xff, v >>> 8 & 0xff, v >>> 16 & 0xff, v >>> 24 & 0xff);
  const u64 = (out: number[], v: number) => { u32(out, v % 0x1_0000_0000); u32(out, Math.floor(v / 0x1_0000_0000)); };
  for (const entry of entries) {
    const data = bytesOf(entry.data), method = entry.method ?? 8, body = method === 8 ? deflateSync(data) : data;
    const name = encoder.encode(entry.name), offset = parts.length, checksum = entry.crcOverride ?? crc(data), size = entry.sizeOverride ?? data.length;
    u32(parts, 0x04034b50); u16(parts, 20); u16(parts, entry.flags ?? 0); u16(parts, method); u16(parts, 0); u16(parts, 0);
    u32(parts, checksum); u32(parts, body.length); u32(parts, size); u16(parts, name.length); u16(parts, 0);
    for (const byte of name) parts.push(byte);
    for (const byte of body) parts.push(byte);
    const extra: number[] = [];
    if (entry.zip64) { u16(extra, 1); u16(extra, 24); u64(extra, size); u64(extra, body.length); u64(extra, offset); }
    u32(central, 0x02014b50); u16(central, entry.symlink ? 0x0314 : 20); u16(central, 20); u16(central, entry.flags ?? 0); u16(central, method); u16(central, 0); u16(central, 0);
    u32(central, checksum); u32(central, entry.zip64 ? 0xffffffff : body.length); u32(central, entry.zip64 ? 0xffffffff : size); u16(central, name.length); u16(central, extra.length); u16(central, 0);
    u16(central, 0); u16(central, 0); u32(central, entry.symlink ? (0o120777 << 16) >>> 0 : 0); u32(central, entry.zip64 ? 0xffffffff : offset);
    for (const byte of name) central.push(byte);
    central.push(...extra);
  }
  const directoryOffset = parts.length;
  if (!options.omitDirectory) {
    for (const byte of central) parts.push(byte);
    u32(parts, 0x06054b50); u16(parts, options.disk ?? 0); u16(parts, 0); u16(parts, entries.length); u16(parts, entries.length); u32(parts, central.length); u32(parts, directoryOffset); u16(parts, 0);
  }
  return Uint8Array.from(parts);
}

// --- UNIX compress (LZW) writer, classic compress(1) layout ---

/** LZW with 9..maxBits codes, block mode; emits CLEAR (and restarts the dictionary) when it is full if `clearWhenFull`. */
export function compressZ(input: Uint8Array, maxBits = 16, clearWhenFull = true): Uint8Array {
  const out: number[] = [0x1f, 0x9d, 0x80 | maxBits];
  let bitBuffer = 0, bitCount = 0, nBits = 9, maxCode = (1 << nBits) - 1, freeEnt = 257, segmentBits = 0;
  const maxMaxCode = 1 << maxBits;
  const flushPad = () => {
    // Pad to the end of the current group of eight codes (nBits bytes) counted from the segment start.
    const group = nBits * 8, rem = segmentBits % group;
    if (rem) { const padBits = group - rem; for (let i = 0; i < padBits; i++) { bitCount++; if (bitCount === 8) { out.push(bitBuffer & 0xff); bitBuffer = 0; bitCount = 0; } } }
    segmentBits = 0;
  };
  const output = (code: number, clear = false) => {
    bitBuffer |= code << bitCount; bitCount += nBits; segmentBits += nBits;
    while (bitCount >= 8) { out.push(bitBuffer & 0xff); bitBuffer >>>= 8; bitCount -= 8; }
    if (clear) { flushPad(); nBits = 9; maxCode = (1 << nBits) - 1; return; }
    if (freeEnt > maxCode) { flushPad(); nBits++; maxCode = nBits === maxBits ? maxMaxCode : (1 << nBits) - 1; }
  };
  if (!input.length) return Uint8Array.from(out);
  let dict = new Map<number, number>(), ent = input[0];
  for (let index = 1; index < input.length; index++) {
    const c = input[index], key = ent << 8 | c, hit = dict.get(key);
    if (hit !== undefined) { ent = hit; continue; }
    output(ent);
    if (freeEnt < maxMaxCode) dict.set(key, freeEnt++);
    else if (clearWhenFull) { output(256, true); dict = new Map(); freeEnt = 257; }
    ent = c;
  }
  output(ent);
  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return Uint8Array.from(out);
}
