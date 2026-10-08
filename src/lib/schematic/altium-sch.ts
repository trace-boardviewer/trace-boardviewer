/*
 * Original TRACE adapter (MIT): Altium Designer schematic documents (.SchDoc) into the structured schematic model.
 *
 * Provenance: the record layout is publicly documented (KiCad developer documentation on Altium import formats; the python-altium
 * format notes) and was checked against openly licensed real SchDoc files and, for connectivity, against the nets of the PcbDoc of
 * the same designs. No implementation source code was read or copied. Container and record framing: altium-sch-records.ts.
 *
 * Records read (RECORD=n): 31 sheet (size, frame, fonts, title block), 1 component (+ children 2 pin, 34 designator, 41 parameters,
 * 44/45 footprint, and the body drawing 4 6 7 8 10 11 12 13 14 5), 27 wire, 26 bus, 37 bus entry, 29 junction, 25 net label,
 * 17 power port, 18 port, 15 sheet symbol (+ 32 name, 33 file name, 16 sheet entries), 22 no-ERC marker, 4 28 209 free text.
 * Everything else is counted in one info diagnostic per record kind (nothing is guessed). Binary-flagged records and the
 * `Additional` stream (harness, blanket) are not read. The line-based "Ascii File" export of the same records is read as well: its
 * trailing `Icon storage` section (hex-encoded images) is skipped and its numbers may carry decimal commas (the exporting machine's
 * locale).
 *
 * Bounds: the container is read by the bounded compound-file reader (formats/altium-cfb.ts); records, record size, vertices, sheets,
 * instances, drawing primitives and pins are limited (ALTIUM_SCH_LIMITS and SCHEMATIC_LIMITS, failures are SchematicError with the code
 * LIMIT_EXCEEDED); a record's vertex loop is bounded by the keys the record really has, and the pin-to-wire and port-to-wire matching
 * keep a bounded number of candidates per cell, so the work stays linear in the size of the input.
 *
 * Geometry: sheet units are 10 mil (0.254 mm) with an optional `_Frac` of 1/100000 unit; the sheet is Y up and the model is Y down,
 * so Y is flipped about the sheet height (the paper is x 0..W, y 0..H). Child objects of a component already carry ABSOLUTE sheet
 * coordinates in the file. A pin's Location is its body end; its connection point (what wires attach to) lies `PinLength` away in the
 * pin direction (PinConglomerate bits 0-1: 0 right, 1 up, 2 left, 3 down), which real files confirm (tips meet wire ends).
 *
 * Components: a placed part carries ALL parts' pins; only pins of CurrentPartId (or of no part) in the current display mode are
 * kept, so a multi-part device placed several times is several symbols with one reference and one unit each. Designators and pin
 * numbers are the board's (cross-probe) identity.
 *
 * Connectivity is COMPUTED from geometry by connectivity.ts (the same engine as the KiCad readers). Scope follows Altium's net
 * identifier scope: from the project file (`HierarchyMode`: 0 automatic, 2 hierarchical, 3 global; 2 and 3 are read from real
 * projects, the others are reported) or, without a project file, the Automatic rule (sheet symbols present = hierarchical, else
 * global). Global: net labels and ports are global labels. Hierarchical: net labels are local, ports are hierarchical labels joined
 * to the sheet entry of the same name on the parent sheet symbol. Power ports are global by name. Hidden pins tie to the global
 * net of their `HiddenNetName`. Wires join only at ends/junctions (never by crossing), exactly as the engine reads them.
 *
 * Not modelled / limits (see diagnostics): multi-channel `Repeat(...)` sheets, harness records, variants, off-sheet connectors,
 * sheet symbols other than box shape, IEEE symbols, pie charts, images. Hierarchy (sheet symbols, entries, ports) is proven by
 * synthetic fixtures only: the openly licensed real files available are flat designs.
 */
import { boundText } from '../bounded-text';
import {
  SCHEMATIC_LIMITS,
  type SchBounds, type SchBus, type SchBusEntry, type SchDiagnostic, type SchField, type SchGraphic, type SchJunction, type SchLabel,
  type SchLabelKind, type SchNoConnect, type SchPin, type SchPinType, type SchPoint, type SchSeverity, type SchSheetDef, type SchSheetInstance,
  type SchSheetPin, type SchSheetRef, type SchSymbol, type SchTextGraphic, type SchWire, type Schematic, type SchematicInput, type SchematicParser,
} from './model';
import {
  ALTIUM_SCH_LIMITS, decodeAsciiDocument, decodeBinaryStream, fail, FORMAT_ID, parseProject, recordProps, schDocStream, sniffSchDoc,
  type AltiumDocument, type AltiumProject, type Props,
} from './altium-sch-records';

export { ALTIUM_SCH_FORMAT, ALTIUM_SCH_LIMITS } from './altium-sch-records';

const UNIT_MM = 0.254;
const DIAG_CAP = 200;
const ARC_STEP_DEG = 10;
const PT_MM = 25.4 / 72;
const TOLERANCE_MM = 1e-3;
/** A pin end this close to a wire end / junction is connected by Altium. */
const PIN_SNAP_MM = 0.05;

/** SheetStyle -> [width, height] in sheet units (landscape). */
const SHEET_STYLES: ReadonlyArray<readonly [number, number]> = [
  [1150, 760], [1550, 1110], [2230, 1570], [3150, 2230], [4460, 3150], [950, 750], [1500, 950], [2000, 1500], [3200, 2000], [4200, 3200],
  [1100, 850], [1400, 850], [1700, 1100], [990, 790], [1540, 990], [2060, 1560], [3260, 2060], [4280, 3280],
];

/** Pin ELECTRICAL codes. */
const PIN_TYPES: readonly SchPinType[] = ['input', 'bidirectional', 'output', 'open_collector', 'passive', 'tri_state', 'open_emitter', 'power_in'];
const IO_SHAPES: readonly SchSheetPin['shape'][] = ['passive', 'output', 'input', 'bidirectional'];
const DIR_X = [1, 0, -1, 0], DIR_Y = [0, 1, 0, -1];

const KNOWN_KINDS = new Set([1, 2, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 22, 25, 26, 27, 28, 29, 31, 32, 33, 34, 37, 41, 44, 45, 209]);
const BODY_KINDS = new Set([4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 28, 209]);

const snap = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;
const norm = (degrees: number): number => ((degrees % 360) + 360) % 360;

// ---------------------------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------------------------

class Diags {
  readonly list: SchDiagnostic[] = [];
  private readonly counts = new Map<string, number>();
  add(severity: SchSeverity, code: string, message: string, extra: { defId?: string; instancePath?: string; at?: SchPoint } = {}): void {
    const count = (this.counts.get(code) ?? 0) + 1;
    this.counts.set(code, count);
    if (count <= DIAG_CAP) this.list.push({ severity, code, message: boundText(message), ...extra });
  }
  finish(): SchDiagnostic[] {
    for (const [code, count] of this.counts) if (count > DIAG_CAP) this.list.push({ severity: 'info', code: 'DIAGNOSTICS_TRUNCATED', message: `${count - DIAG_CAP} further ${code} diagnostics were suppressed (${count} in total).` });
    return this.list;
  }
}

class Box {
  private minX = Infinity; private minY = Infinity; private maxX = -Infinity; private maxY = -Infinity;
  add(p: SchPoint): void { if (p.x < this.minX) this.minX = p.x; if (p.x > this.maxX) this.maxX = p.x; if (p.y < this.minY) this.minY = p.y; if (p.y > this.maxY) this.maxY = p.y; }
  merge(b: SchBounds): void { this.add({ x: b.minX, y: b.minY }); this.add({ x: b.maxX, y: b.maxY }); }
  get empty(): boolean { return this.minX > this.maxX; }
  bounds(): SchBounds { return this.empty ? { minX: 0, minY: 0, maxX: 0, maxY: 0 } : { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY }; }
}

function graphicPoints(graphic: SchGraphic): SchPoint[] {
  switch (graphic.kind) {
    case 'poly': return graphic.points;
    case 'rect': return [graphic.min, graphic.max];
    case 'circle': return [{ x: graphic.center.x - graphic.radius, y: graphic.center.y - graphic.radius }, { x: graphic.center.x + graphic.radius, y: graphic.center.y + graphic.radius }];
    case 'text': return [graphic.at];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Documents and the project they belong to
// ---------------------------------------------------------------------------------------------------------------

interface Loaded {
  key: string;
  file: string;
  stem: string;
  doc: AltiumDocument;
  /** File names (as written) of the sheet symbols of this document, by record index. */
  symbolFiles: Map<number, string>;
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
/** The key of a sheet (and the id of its definition) is its lower-case file name; a name without a file part (empty, or ending in a separator) still gives a non-empty id. */
const keyOf = (path: string): string => baseName(path).toLowerCase() || 'schematic';
const stemOf = (path: string): string => baseName(path).replace(/\.[^.]*$/, '') || 'schematic';

/** The decoded document of `data`; null when the bytes are not an Altium schematic (a PcbDoc, another file). Throws for a damaged one. */
function decodeSchematic(data: Uint8Array, label: string): AltiumDocument | null {
  if (isCompound(data)) {
    const container = schDocStream(data);
    if (!container) return null;
    if (container.kind === 'library') throw fail(`"${label}" is an Altium schematic symbol library (SchLib); it has no sheet to show.`, 'UNSUPPORTED_VARIANT');
    return decodeBinaryStream(container.stream);
  }
  switch (sniffSchDoc(data)) {
    case 'library': throw fail(`"${label}" is an Altium schematic symbol library (SchLib); it has no sheet to show.`, 'UNSUPPORTED_VARIANT');
    case 'ascii': return decodeAsciiDocument(data);
    default: return null;
  }
}

function isCompound(data: Uint8Array): boolean { return data.length >= 8 && data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0 && data[4] === 0xa1 && data[5] === 0xb1 && data[6] === 0x1a && data[7] === 0xe1; }

function scanSymbolFiles(doc: AltiumDocument): Map<number, string> {
  const out = new Map<number, string>();
  for (let i = 0; i < doc.count; i++) {
    if (doc.kind[i] !== 33) continue;
    const owner = doc.owner[i];
    if (owner < 0 || owner >= doc.count || doc.kind[owner] !== 15 || out.has(owner)) continue;
    out.set(owner, recordProps(doc, i).str('TEXT').trim());
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-sheet conversion
// ---------------------------------------------------------------------------------------------------------------

interface Context {
  netLabelKind: SchLabelKind;
  portKind: SchLabelKind;
  childDefId(file: string): string | null;
  diag: Diags;
  /** Running totals of expanded drawing output and pins, to bound hostile files. */
  drawn: { sheet: number; total: number; pins: number };
}

const spend = (ctx: Context, count: number): void => {
  ctx.drawn.sheet += count; ctx.drawn.total += count;
  if (ctx.drawn.sheet > SCHEMATIC_LIMITS.maxWiresPerDef || ctx.drawn.total > SCHEMATIC_LIMITS.maxPinsTotal) throw fail('The Altium schematic exceeds the drawing primitive import limit.', 'LIMIT_EXCEEDED');
};

interface Frame { width: number; height: number; x(units: number): number; y(units: number): number; point(ux: number, uy: number): SchPoint; length(units: number): number }

function makeFrame(height: number, width: number): Frame {
  const check = (mm: number): number => {
    if (!(Math.abs(mm) <= SCHEMATIC_LIMITS.maxCoordinateMm)) throw fail(`An Altium coordinate exceeds the ${SCHEMATIC_LIMITS.maxCoordinateMm} mm limit.`, 'LIMIT_EXCEEDED');
    return mm;
  };
  const x = (units: number): number => check(snap(units * UNIT_MM));
  const y = (units: number): number => check(snap((height - units) * UNIT_MM));
  /** A distance (a size, a radius) is held to the same limit as a coordinate, so that a corner computed from it stays finite. */
  const length = (units: number): number => check(snap(units * UNIT_MM));
  return { width, height, x, y, point: (ux, uy) => ({ x: x(ux), y: y(uy) }), length };
}

interface Fonts { size(id: number): number; bold(id: number): boolean; italic(id: number): boolean }
function readFonts(sheet: Props | undefined): Fonts {
  const count = Math.min(sheet?.int('FONTIDCOUNT', 0) ?? 0, 1000);
  const size = new Map<number, number>(), bold = new Set<number>(), italic = new Set<number>();
  for (let id = 1; id <= count && sheet; id++) {
    const pt = sheet.int(`SIZE${id}`, 10);
    size.set(id, pt > 0 ? pt : 10);
    if (sheet.bool(`BOLD${id}`)) bold.add(id);
    if (sheet.bool(`ITALIC${id}`)) italic.add(id);
  }
  return { size: id => (size.get(id) ?? 10) * PT_MM, bold: id => bold.has(id), italic: id => italic.has(id) };
}

const ANCHORS: ReadonlyArray<SchTextGraphic['anchor']> = ['start', 'middle', 'end'];

/** Closed spans between two sample angles, counter-clockwise, in degrees (a zero or negative span is a full turn). */
function sweepOf(start: number, end: number): { from: number; span: number } {
  const from = norm(start);
  let span = norm(end) - from;
  if (span <= 0) span += 360;
  return { from, span };
}

/** Sites kept per 1 mm cell: real sheets have a handful (wire ends sit on a 1.27 mm grid), a hostile file could stack thousands in one cell. */
const SNAP_CELL_CAP = 64;
/** Cell entries a long diagonal wire may add to the attach test (its ends are always kept), per wire and per sheet. */
const ATTACH_CELLS_PER_SEGMENT = 4096, ATTACH_CELLS_PER_SHEET = 4_000_000, ATTACH_SEGMENTS_PER_CELL = 256;

/** Points on a 1 mm grid for nearest-site queries within a radius far below the cell size. Bounded: a full cell drops further sites. */
class SnapIndex {
  private readonly cells = new Map<number, Array<[number, number]>>();
  size = 0;
  dropped = 0;
  private key(cx: number, cy: number): number { return cx * 67108864 + cy; }
  add(p: SchPoint): void {
    const k = this.key(Math.floor(p.x), Math.floor(p.y)), list = this.cells.get(k);
    if (!list) this.cells.set(k, [[p.x, p.y]]);
    else if (list.length >= SNAP_CELL_CAP) { this.dropped++; return; }
    else list.push([p.x, p.y]);
    this.size++;
  }
  nearest(p: SchPoint, radius: number): { x: number; y: number; d: number } | null {
    const cx = Math.floor(p.x), cy = Math.floor(p.y);
    let best: { x: number; y: number; d: number } | null = null;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const [x, y] of this.cells.get(this.key(cx + dx, cy + dy)) ?? []) {
        const d = Math.max(Math.abs(x - p.x), Math.abs(y - p.y));
        if (d <= radius && (!best || d < best.d)) { best = { x, y, d }; if (d === 0) return best; }
      }
    }
    return best;
  }
}

class AttachTest {
  private readonly ends = new Map<string, true>();
  private readonly cells = new Map<number, number[]>();
  private readonly segs: number[] = [];
  private readonly cell = 5.08;
  private budget = ATTACH_CELLS_PER_SHEET;
  private key(x: number, y: number): string { return `${Math.round(x / TOLERANCE_MM)},${Math.round(y / TOLERANCE_MM)}`; }
  addPoint(x: number, y: number): void { this.ends.set(this.key(x, y), true); }
  addSegment(ax: number, ay: number, bx: number, by: number): void {
    this.addPoint(ax, ay); this.addPoint(bx, by);
    const index = this.segs.length / 4;
    this.segs.push(ax, ay, bx, by);
    const x0 = Math.floor(Math.min(ax, bx) / this.cell), x1 = Math.floor(Math.max(ax, bx) / this.cell), y0 = Math.floor(Math.min(ay, by) / this.cell), y1 = Math.floor(Math.max(ay, by) / this.cell);
    const span = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (span > ATTACH_CELLS_PER_SEGMENT || span > this.budget) return; // a very long diagonal, or a sheet full of them: ends only
    this.budget -= span;
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const k = cx * 67108864 + cy, list = this.cells.get(k);
      if (!list) this.cells.set(k, [index]);
      else if (list.length < ATTACH_SEGMENTS_PER_CELL) list.push(index);
    }
  }
  hit(x: number, y: number): boolean {
    const qx = Math.round(x / TOLERANCE_MM), qy = Math.round(y / TOLERANCE_MM);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (this.ends.has(`${qx + dx},${qy + dy}`)) return true;
    const list = this.cells.get(Math.floor(x / this.cell) * 67108864 + Math.floor(y / this.cell));
    if (!list) return false;
    for (const index of list) {
      const ax = this.segs[4 * index], ay = this.segs[4 * index + 1], bx = this.segs[4 * index + 2], by = this.segs[4 * index + 3];
      const dxs = bx - ax, dys = by - ay, len2 = dxs * dxs + dys * dys;
      if (len2 <= 0) continue;
      const t = ((x - ax) * dxs + (y - ay) * dys) / len2;
      if (t < 0 || t > 1) continue;
      const cross = (x - ax) * dys - (y - ay) * dxs;
      if (cross * cross <= TOLERANCE_MM * TOLERANCE_MM * len2) return true;
    }
    return false;
  }
}

function convertSheet(loaded: Loaded, ctx: Context): SchSheetDef {
  const { doc, key: defId } = loaded;
  const diag = ctx.diag;
  ctx.drawn.sheet = 0;

  // children by owner (record order preserved)
  const first = new Int32Array(doc.count).fill(-1), last = new Int32Array(doc.count).fill(-1), next = new Int32Array(doc.count).fill(-1);
  for (let i = 0; i < doc.count; i++) {
    const owner = doc.owner[i];
    if (owner < 0 || owner >= doc.count || owner === i) continue;
    if (last[owner] < 0) first[owner] = i; else next[last[owner]] = i;
    last[owner] = i;
  }
  const childrenOf = (owner: number): number[] => { const out: number[] = []; for (let c = first[owner]; c >= 0; c = next[c]) out.push(c); return out; };
  const where = (index: number): string => `record ${index} (RECORD=${doc.kind[index]})`;
  const ownerIsSheetLevel = (i: number): boolean => doc.owner[i] < 0 || doc.owner[i] >= doc.count;

  // ---- sheet record: size, fonts, title block
  const sheetIndex = doc.kind.indexOf(31);
  const sheet = sheetIndex >= 0 ? recordProps(doc, sheetIndex) : undefined;
  if (!sheet) diag.add('warning', 'SHEET_RECORD_MISSING', 'The document has no sheet record (RECORD=31); the sheet size is unknown (A4 landscape assumed).', { defId });
  let width = SHEET_STYLES[0][0], height = SHEET_STYLES[0][1];
  if (sheet) {
    const style = sheet.int('SHEETSTYLE', 0);
    if (sheet.bool('USECUSTOMSHEET')) { width = sheet.units('CUSTOMX', width); height = sheet.units('CUSTOMY', height); }
    else if (style >= 0 && style < SHEET_STYLES.length) { width = SHEET_STYLES[style][0]; height = SHEET_STYLES[style][1]; }
    else diag.add('warning', 'SHEET_STYLE_UNKNOWN', `Sheet style ${style} is not known; A4 landscape is assumed.`, { defId });
    if (sheet.int('WORKSPACEORIENTATION', 0) === 1) [width, height] = [height, width];
  }
  if (!(width > 0 && height > 0) || width > 1e6 || height > 1e6) throw fail('The Altium sheet size is not valid.', 'INVALID_FORMAT');
  const frame = makeFrame(height, width);
  const fonts = readFonts(sheet);
  const paper = { width: snap(width * UNIT_MM), height: snap(height * UNIT_MM) };

  const textOf = (fontId: number): { size: number; bold?: boolean; italic?: boolean } => {
    const out: { size: number; bold?: boolean; italic?: boolean } = { size: snap(fonts.size(fontId)) };
    if (fonts.bold(fontId)) out.bold = true;
    if (fonts.italic(fontId)) out.italic = true;
    return out;
  };
  const textGraphic = (p: Props, text: string, hidden = false): SchTextGraphic => ({
    kind: 'text', at: frame.point(p.units('LOCATION.X'), p.units('LOCATION.Y')), text, angle: (p.int('ORIENTATION', 0) & 3) * 90,
    ...textOf(p.int('FONTID', 1)), anchor: ANCHORS[p.int('JUSTIFICATION', 0) % 3] ?? 'start', ...(hidden ? { hidden: true } : {}),
  });

  const titleBlock: Record<string, string> = {};
  const TITLE_KEYS: Record<string, string> = { TITLE: 'title', REVISION: 'rev', COMPANYNAME: 'company', AUTHOR: 'author', DRAWNBY: 'drawnBy', DOCUMENTNUMBER: 'number', APPROVEDBY: 'approvedBy', CHECKEDBY: 'checkedBy', ORGANIZATION: 'organization' };

  // ---- vertices of wires, buses, polylines
  const vertices = (index: number, p: Props, label: string): SchPoint[] => {
    const declared = p.int('LOCATIONCOUNT', 0);
    if (declared > ALTIUM_SCH_LIMITS.maxVertices) throw fail(`${label} has ${declared} vertices (limit ${ALTIUM_SCH_LIMITS.maxVertices}).`, 'LIMIT_EXCEEDED');
    const count = Math.min(declared, p.maxVertexKey, p.vertexKeys); // a vertex needs its own X<k> key: the loop is bounded by the record's size, not by its claim
    if (declared !== count) diag.add('warning', 'VERTEX_COUNT_MISMATCH', `${label} declares ${declared} vertices but defines ${count}; the defined ones are used.`, { defId });
    const out: SchPoint[] = [];
    for (let k = 1; k <= count; k++) out.push(frame.point(p.units(`X${k}`), p.units(`Y${k}`)));
    return out;
  };

  const symbols: SchSymbol[] = [], wires: SchWire[] = [], buses: SchBus[] = [], busEntries: SchBusEntry[] = [], junctions: SchJunction[] = [];
  const noConnects: SchNoConnect[] = [], labels: SchLabel[] = [], sheetRefs: SchSheetRef[] = [], graphics: SchGraphic[] = [];
  const box = new Box();
  const kindCounts = new Map<number, number>();
  let unownedDrawing = 0;
  /** Every pin of the sheet (power ports included); their connection points may be moved onto a wire end, see below. */
  const allPins: SchPin[] = [];
  const noErcMarkers: Array<{ id: string; at: SchPoint }> = [];
  const portRecords: number[] = [];
  const entryPoints: SchPoint[] = [];

  const polylineSegments = <T>(points: SchPoint[], make: (a: SchPoint, b: SchPoint, k: number) => T, sink: T[], limitLabel: string): void => {
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1], b = points[k];
      if (a.x === b.x && a.y === b.y) continue;
      if (sink.length >= SCHEMATIC_LIMITS.maxWiresPerDef) throw fail(`The sheet exceeds the ${SCHEMATIC_LIMITS.maxWiresPerDef} ${limitLabel} import limit.`, 'LIMIT_EXCEEDED');
      sink.push(make(a, b, k));
      box.add(a); box.add(b);
    }
  };

  // ---- graphics of one drawing record, in sheet units -> model
  const drawing = (index: number, p: Props, sink: SchGraphic[]): void => {
    const kind = doc.kind[index];
    const pt = (ux: number, uy: number): SchPoint => frame.point(ux, uy);
    const lineWidth = 0;
    const solid = p.bool('ISSOLID');
    switch (kind) {
      case 13: {
        spend(ctx, 1);
        sink.push({ kind: 'poly', points: [pt(p.units('LOCATION.X'), p.units('LOCATION.Y')), pt(p.units('CORNER.X'), p.units('CORNER.Y'))], width: lineWidth, filled: false });
        break;
      }
      case 14: case 10: {
        spend(ctx, 1);
        const a = pt(p.units('LOCATION.X'), p.units('LOCATION.Y')), b = pt(p.units('CORNER.X'), p.units('CORNER.Y'));
        sink.push({ kind: 'rect', min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }, width: lineWidth, fill: solid ? 'background' : 'none' });
        break;
      }
      case 6: case 7: {
        const points = vertices(index, p, `Altium ${where(index)}`);
        if (points.length < 2) break;
        spend(ctx, points.length);
        if (kind === 7 && !solid) points.push(points[0]);
        sink.push({ kind: 'poly', points, width: lineWidth, filled: kind === 7 && solid });
        break;
      }
      case 5: {
        const control = vertices(index, p, `Altium ${where(index)}`);
        if (control.length < 4) break;
        const points: SchPoint[] = [control[0]];
        for (let s = 0; s + 3 < control.length; s += 3) {
          for (let step = 1; step <= 8; step++) {
            const t = step / 8, u = 1 - t, c0 = control[s], c1 = control[s + 1], c2 = control[s + 2], c3 = control[s + 3];
            points.push({ x: snap(u * u * u * c0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * c3.x), y: snap(u * u * u * c0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * c3.y) });
          }
        }
        spend(ctx, points.length);
        sink.push({ kind: 'poly', points, width: lineWidth, filled: false });
        break;
      }
      case 8: case 11: case 12: {
        const cx = p.units('LOCATION.X'), cy = p.units('LOCATION.Y'), rx = Math.abs(p.units('RADIUS')), ry = kind === 12 ? rx : Math.abs(p.units('SECONDARYRADIUS', p.units('RADIUS')));
        if (!(rx > 0)) break;
        const full = kind === 8 || p.float('STARTANGLE', 0) === p.float('ENDANGLE', 360);
        if (kind === 8 && rx === ry) { spend(ctx, 1); sink.push({ kind: 'circle', center: pt(cx, cy), radius: frame.length(rx), width: lineWidth, fill: solid ? 'background' : 'none' }); break; }
        const { from, span } = full ? { from: 0, span: 360 } : sweepOf(p.float('STARTANGLE', 0), p.float('ENDANGLE', 360));
        const steps = Math.max(2, Math.ceil(span / ARC_STEP_DEG));
        spend(ctx, steps + 1);
        const points: SchPoint[] = [];
        for (let s = 0; s <= steps; s++) {
          const a = (from + span * s / steps) * Math.PI / 180;
          points.push(pt(cx + rx * Math.cos(a), cy + ry * Math.sin(a)));
        }
        sink.push({ kind: 'poly', points, width: lineWidth, filled: kind === 8 && solid });
        break;
      }
      case 4: {
        const text = p.str('TEXT');
        if (!text || p.bool('ISHIDDEN')) break;
        spend(ctx, 1);
        sink.push(textGraphic(p, text));
        break;
      }
      case 28: case 209: {
        const text = p.str('TEXT').replace(/~1/g, '\n');
        if (!text) break;
        spend(ctx, 1);
        const g = textGraphic(p, text);
        g.at = pt(p.units('LOCATION.X'), p.units('CORNER.Y', p.units('LOCATION.Y')));
        g.angle = 0; g.anchor = 'start';
        sink.push(g);
        break;
      }
    }
  };

  // ---- components
  const buildComponent = (index: number): SchSymbol => {
    const p = recordProps(doc, index);
    const unit = p.int('CURRENTPARTID', 1), mode = p.int('DISPLAYMODE', 0), unitCount = Math.max(1, p.int('PARTCOUNT', 2) - 1);
    const id = `c${index}`;
    let ref = '';
    const params: Array<{ name: string; text: string; hidden: boolean }> = [];
    let footprint = '', footprintAny = '';
    const body: SchGraphic[] = [], fields: SchField[] = [], pinProps: Array<{ props: Props; index: number }> = [];
    const designatorGraphics: SchGraphic[] = [];
    for (const c of childrenOf(index)) {
      const kind = doc.kind[c];
      if (kind === 2) {
        const pp = recordProps(doc, c);
        const part = pp.int('OWNERPARTID', -1);
        if ((part === -1 || part === unit) && pp.int('OWNERPARTDISPLAYMODE', 0) === mode) pinProps.push({ props: pp, index: c });
      } else if (kind === 34) {
        const dp = recordProps(doc, c), text = dp.str('TEXT').trim();
        if (!ref && text) {
          ref = text;
          fields.push({ name: 'Reference', value: text, at: frame.point(dp.units('LOCATION.X'), dp.units('LOCATION.Y')), angle: (dp.int('ORIENTATION', 0) & 3) * 90, hidden: dp.bool('ISHIDDEN') });
        }
        if (text && !dp.bool('ISHIDDEN')) designatorGraphics.push(textGraphic(dp, text));
      } else if (kind === 41) {
        if (params.length >= 512) continue;
        const pr = recordProps(doc, c), name = pr.str('NAME').trim();
        if (!name) continue;
        const text = pr.str('TEXT'), hidden = pr.bool('ISHIDDEN');
        params.push({ name, text, hidden });
        fields.push({ name, value: text, at: frame.point(pr.units('LOCATION.X'), pr.units('LOCATION.Y')), angle: (pr.int('ORIENTATION', 0) & 3) * 90, hidden });
        if (!hidden && text && name.toUpperCase() !== 'PINUNIQUEID') designatorGraphics.push(textGraphic(pr, pr.bool('SHOWNAME') ? `${name}=${text}` : text));
      } else if (kind === 44) {
        for (const impl of childrenOf(c)) {
          if (doc.kind[impl] !== 45) continue;
          const ip = recordProps(doc, impl);
          if ((ip.get('MODELTYPE') ?? '').trim().toUpperCase() !== 'PCBLIB') continue;
          const name = ip.str('MODELNAME').trim();
          if (!footprintAny) footprintAny = name;
          if (!footprint && ip.bool('ISCURRENT')) footprint = name;
        }
      } else if (BODY_KINDS.has(kind)) {
        const gp = recordProps(doc, c), part = gp.int('OWNERPARTID', -1);
        if ((part === -1 || part === unit) && gp.int('OWNERPARTDISPLAYMODE', 0) === mode) drawing(c, gp, body);
      } else kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
    }
    const lookup = (name: string): string | undefined => params.find(x => x.name.toUpperCase() === name.toUpperCase())?.text;
    const resolve = (text: string | undefined): string => {
      if (text === undefined) return '';
      const trimmed = text.trim();
      if (trimmed.startsWith('=') && trimmed.length > 1) return (lookup(trimmed.slice(1)) ?? trimmed).trim();
      return trimmed === '*' ? '' : trimmed;
    };
    const value = resolve(lookup('Value')) || resolve(lookup('Comment')) || p.str('COMPONENTDESCRIPTION').trim();

    const pins: SchPin[] = [], seen = new Map<string, number>();
    const symbolBox = new Box();
    const origin = frame.point(p.units('LOCATION.X'), p.units('LOCATION.Y'));
    symbolBox.add(origin);
    let unnumbered = 0, hiddenUnnamed = 0;
    for (const { props: pp } of pinProps) {
      if (++ctx.drawn.pins > SCHEMATIC_LIMITS.maxPinsTotal) throw fail(`The Altium schematic exceeds the ${SCHEMATIC_LIMITS.maxPinsTotal} pin import limit.`, 'LIMIT_EXCEEDED');
      let number = pp.str('DESIGNATOR').trim();
      if (!number) { number = `#${++unnumbered}`; }
      const conglomerate = pp.int('PINCONGLOMERATE', 0), turn = conglomerate & 3, hidden = (conglomerate & 4) !== 0;
      const length = pp.units('PINLENGTH'), bx = pp.units('LOCATION.X'), by = pp.units('LOCATION.Y');
      const bodyAt = frame.point(bx, by), at = frame.point(bx + length * DIR_X[turn], by + length * DIR_Y[turn]);
      const count = seen.get(number) ?? 0;
      seen.set(number, count + 1);
      const electrical = pp.int('ELECTRICAL', 0), part = pp.int('OWNERPARTID', -1);
      const pin: SchPin = { id: `${id}#${number}${count ? `@${count + 1}` : ''}`, number, name: pp.str('NAME').trim(), at, body: bodyAt, type: PIN_TYPES[electrical] ?? 'unspecified', hidden, unit: part === -1 ? 0 : part };
      const hiddenNet = hidden ? pp.str('HIDDENNETNAME').trim() : '';
      if (hiddenNet) pin.implicitNet = hiddenNet; else if (hidden) hiddenUnnamed++;
      pins.push(pin);
      allPins.push(pin);
      symbolBox.add(at); symbolBox.add(bodyAt);
    }
    if (unnumbered) diag.add('info', 'PIN_NUMBER_MISSING', `${unnumbered} pin(s) of ${ref || id} have no designator; placeholder numbers (#n) are used.`, { defId });
    if (hiddenUnnamed) diag.add('info', 'HIDDEN_PIN_NO_NET', `${hiddenUnnamed} hidden pin(s) of ${ref || id} name no net to connect to; they are not tied to any net.`, { defId });
    const symbolGraphics = [...body, ...designatorGraphics];
    for (const g of symbolGraphics) graphicPoints(g).forEach(point => symbolBox.add(point));
    const library = p.str('SOURCELIBRARYNAME').trim() || baseName(p.str('LIBRARYPATH')).trim(), libReference = p.str('LIBREFERENCE').trim() || p.str('DESIGNITEMID').trim();
    const symbol: SchSymbol = {
      id, libId: library ? `${library}:${libReference}` : libReference || 'unknown', refDefault: ref, instances: { '': { ref, unit } }, value, footprint: footprint || footprintAny,
      datasheet: resolve(lookup('Datasheet')), unit, unitCount, at: origin, rotation: (p.int('ORIENTATION', 0) & 3) * 90, mirror: p.bool('ISMIRRORED') ? 'y' : 'none',
      pins, graphics: symbolGraphics, fields, virtual: false, dnp: false, bounds: symbolBox.bounds(),
    };
    if (!ref) diag.add('warning', 'COMPONENT_NO_DESIGNATOR', `Component ${p.str('LIBREFERENCE') || index} has no designator.`, { defId });
    return symbol;
  };

  // ---- power ports
  const buildPowerPort = (index: number, p: Props): SchSymbol | null => {
    const net = p.str('TEXT').trim();
    if (!net) { diag.add('warning', 'POWER_PORT_UNNAMED', 'A power port has no net name and was ignored.', { defId }); return null; }
    const ux = p.units('LOCATION.X'), uy = p.units('LOCATION.Y'), turn = p.int('ORIENTATION', 0) & 3, style = p.int('STYLE', 0);
    const dx = DIR_X[turn], dy = DIR_Y[turn], nx = -dy, ny = dx;
    const along = (t: number, s = 0): SchPoint => frame.point(ux + dx * t + nx * s, uy + dy * t + ny * s);
    const line = (a: SchPoint, b: SchPoint): SchGraphic => ({ kind: 'poly', points: [a, b], width: 0, filled: false });
    const shape: SchGraphic[] = [line(along(0), along(10))];
    switch (style) {
      case 0: shape.push({ kind: 'circle', center: along(13), radius: snap(3 * UNIT_MM), width: 0, fill: 'none' }); break;
      case 1: shape.push({ kind: 'poly', points: [along(10, -5), along(15), along(10, 5)], width: 0, filled: false }); break;
      case 3: shape.push({ kind: 'poly', points: [along(10, -5), along(12, -2.5), along(10, 0), along(8, 2.5), along(10, 5)], width: 0, filled: false }); break;
      case 4: case 6: shape.push(line(along(10, -5), along(10, 5)), line(along(13, -3), along(13, 3)), line(along(16, -1), along(16, 1))); break;
      case 5: shape.push({ kind: 'poly', points: [along(10, -5), along(10, 5), along(16), along(10, -5)], width: 0, filled: false }); break;
      default: shape.push(line(along(10, -5), along(10, 5))); break;
    }
    const at = frame.point(ux, uy), id = `p${index}`;
    if (p.bool('SHOWNETNAME')) shape.push({ kind: 'text', at: along(18), text: net, angle: 0, size: snap(fonts.size(p.int('FONTID', 1))), anchor: 'middle' });
    const pin: SchPin = { id: `${id}#1`, number: '1', name: net, at, body: at, type: 'power_in', hidden: true, unit: 0 };
    const symbolBox = new Box();
    symbolBox.add(at);
    shape.forEach(g => graphicPoints(g).forEach(point => symbolBox.add(point)));
    return {
      id, libId: `power:${net}`, refDefault: '#PWR', instances: { '': { ref: `#PWR${index}`, unit: 1 } }, value: net, footprint: '', datasheet: '', unit: 1, unitCount: 1, at,
      rotation: turn * 90, mirror: 'none', pins: [pin], graphics: shape, fields: [{ name: 'Value', value: net, hidden: !p.bool('SHOWNETNAME') }], power: { net }, virtual: true, dnp: false, bounds: symbolBox.bounds(),
    };
  };

  // ---- sheet symbols
  const buildSheetSymbol = (index: number, p: Props): SchSheetRef => {
    const ux = p.units('LOCATION.X'), uy = p.units('LOCATION.Y'), w = Math.abs(p.units('XSIZE')), h = Math.abs(p.units('YSIZE'));
    let name = '', file = loaded.symbolFiles.get(index) ?? '';
    const pins: SchSheetPin[] = [];
    for (const c of childrenOf(index)) {
      const kind = doc.kind[c], cp = recordProps(doc, c);
      if (kind === 32) name = name || cp.str('TEXT').trim();
      else if (kind === 33) file = file || cp.str('TEXT').trim();
      else if (kind === 16) {
        const side = cp.int('SIDE', 0), entryName = cp.str('NAME').trim();
        if (!entryName) { diag.add('warning', 'SHEET_ENTRY_UNNAMED', 'A sheet entry has no name and was ignored.', { defId }); continue; }
        const distanceUnits = cp.units('DISTANCEFROMTOP') + cp.float('DISTANCEFROMTOP_FRAC1', 0) / 100000; // from the top edge (sides 0, 1) or the left edge (sides 2, 3)
        let ex = ux, ey = uy;
        switch (side) {
          case 1: ex = ux + w; ey = uy - distanceUnits; break;
          case 2: ex = ux + distanceUnits; ey = uy; break;
          case 3: ex = ux + distanceUnits; ey = uy - h; break;
          default: ex = ux; ey = uy - distanceUnits; break;
        }
        const at = frame.point(ex, ey);
        entryPoints.push(at);
        pins.push({ id: `s${index}.e${c}`, name: entryName, at, shape: IO_SHAPES[cp.int('IOTYPE', 0)] ?? 'passive' });
      } else kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
    }
    if (!file) diag.add('warning', 'SHEET_SYMBOL_NO_FILE', `Sheet symbol ${name || index} names no file.`, { defId });
    if (/^repeat\s*\(/i.test(name)) diag.add('warning', 'REPEAT_SHEET', `Sheet symbol "${name}" repeats its sheet (multi-channel design); it is shown once, with the designators of the file, and the channels are not expanded.`, { defId });
    const topLeft = frame.point(ux, uy);
    const ref: SchSheetRef = { id: `s${index}`, name: name || stemOf(file) || `Sheet ${index}`, file, defId: file ? ctx.childDefId(file) : null, at: topLeft, size: { x: frame.length(w), y: frame.length(h) }, pins };
    box.add(topLeft); box.add({ x: topLeft.x + ref.size.x, y: topLeft.y + ref.size.y });
    for (const entry of pins) box.add(entry.at);
    return ref;
  };

  // ---- one pass over the records
  for (let i = 0; i < doc.count; i++) {
    const kind = doc.kind[i];
    switch (kind) {
      case 1: {
        if (symbols.length >= SCHEMATIC_LIMITS.maxSymbolsPerDef) throw fail(`The sheet has more than ${SCHEMATIC_LIMITS.maxSymbolsPerDef} components.`, 'LIMIT_EXCEEDED');
        const symbol = buildComponent(i);
        symbols.push(symbol); box.merge(symbol.bounds);
        break;
      }
      case 27: {
        const p = recordProps(doc, i);
        polylineSegments(vertices(i, p, `Altium ${where(i)}`), (a, b, k) => ({ id: k === 1 ? `w${i}` : `w${i}.${k - 1}`, a, b }), wires, 'wire');
        break;
      }
      case 26: {
        const p = recordProps(doc, i);
        polylineSegments(vertices(i, p, `Altium ${where(i)}`), (a, b, k) => ({ id: k === 1 ? `b${i}` : `b${i}.${k - 1}`, a, b }), buses, 'bus');
        break;
      }
      case 37: {
        const p = recordProps(doc, i);
        const at = frame.point(p.units('LOCATION.X'), p.units('LOCATION.Y')), to = frame.point(p.units('CORNER.X'), p.units('CORNER.Y'));
        busEntries.push({ id: `e${i}`, at, to }); box.add(at); box.add(to);
        break;
      }
      case 29: {
        const p = recordProps(doc, i);
        const at = frame.point(p.units('LOCATION.X'), p.units('LOCATION.Y'));
        junctions.push({ id: `j${i}`, at }); box.add(at);
        break;
      }
      case 25: {
        const p = recordProps(doc, i), text = p.str('TEXT').trim();
        if (!text) { diag.add('warning', 'NET_LABEL_UNNAMED', 'A net label has no text and was ignored.', { defId }); break; }
        const at = frame.point(p.units('LOCATION.X'), p.units('LOCATION.Y'));
        labels.push({ id: `l${i}`, kind: ctx.netLabelKind, text, at, angle: (p.int('ORIENTATION', 0) & 3) * 90 }); box.add(at);
        break;
      }
      case 17: {
        const p = recordProps(doc, i);
        if (p.bool('ISCROSSSHEETCONNECTOR')) { portRecords.push(i); break; }
        if (symbols.length >= SCHEMATIC_LIMITS.maxSymbolsPerDef) throw fail(`The sheet has more than ${SCHEMATIC_LIMITS.maxSymbolsPerDef} components and power ports.`, 'LIMIT_EXCEEDED');
        const symbol = buildPowerPort(i, p);
        if (symbol) { symbols.push(symbol); allPins.push(symbol.pins[0]); box.merge(symbol.bounds); }
        break;
      }
      case 18: portRecords.push(i); break;
      case 15: {
        const ref = buildSheetSymbol(i, recordProps(doc, i));
        sheetRefs.push(ref);
        break;
      }
      case 22: {
        const p = recordProps(doc, i);
        if (p.has('ISACTIVE') && !p.bool('ISACTIVE')) break;
        noErcMarkers.push({ id: `nc${i}`, at: frame.point(p.units('LOCATION.X'), p.units('LOCATION.Y')) });
        break;
      }
      case 41: {
        if (!ownerIsSheetLevel(i)) break;
        const p = recordProps(doc, i), name = p.str('NAME').trim().toUpperCase(), text = p.str('TEXT').trim();
        if (TITLE_KEYS[name] && text && text !== '*' && !text.startsWith('=')) titleBlock[TITLE_KEYS[name]] = text;
        break;
      }
      case 31: case 32: case 33: case 34: case 2: case 16: case 44: case 45: break; // read through their owners
      default: {
        if (BODY_KINDS.has(kind)) {
          if (ownerIsSheetLevel(i)) drawing(i, recordProps(doc, i), graphics);
          else if (doc.kind[doc.owner[i]] !== 1) unownedDrawing++; // owned by a sheet symbol, template or harness
        } else if (!KNOWN_KINDS.has(kind)) kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
      }
    }
  }
  for (const g of graphics) graphicPoints(g).forEach(point => box.add(point));

  // ---- Altium joins a wire end that lies within a few hundredths of a millimetre of a pin end (the pin's hot spot is not a point). Real
  // files show 18 such pins in 17,938 (0.017 to 0.040 mm off, always a few thousandths of a unit from a fractional pin position) and
  // the board's nets confirm every one as connected; the next nearest wire end of an unconnected pin is more than 0.5 mm away. The
  // connection point of such a pin is moved onto that wire end / junction (the engine only joins points that coincide).
  const sites = new SnapIndex();
  for (const w of wires) { sites.add(w.a); sites.add(w.b); }
  for (const j of junctions) sites.add(j.at);
  for (const entry of entryPoints) sites.add(entry);
  let snapped = 0;
  if (allPins.length && sites.size) {
    for (const pin of allPins) {
      const target = sites.nearest(pin.at, PIN_SNAP_MM);
      if (!target || target.d <= TOLERANCE_MM) continue;
      pin.at = { x: target.x, y: target.y }; snapped++;
    }
  }
  if (sites.dropped) diag.add('info', 'SNAP_SITES_DROPPED', `${sites.dropped} wire end(s) were left out of the pin-to-wire matching because a 1 mm cell held more than ${SNAP_CELL_CAP}.`, { defId });
  if (snapped) diag.add('info', 'PIN_SNAPPED', `${snapped} pin end(s) lay within ${PIN_SNAP_MM} mm of a wire end and were joined to it, as Altium does.`, { defId });
  const pinTips = allPins.map(pin => pin.at);

  // ---- ports (and cross-sheet connectors): the end that touches a conductor carries the label
  if (portRecords.length) {
    const attach = new AttachTest();
    for (const w of wires) attach.addSegment(w.a.x, w.a.y, w.b.x, w.b.y);
    for (const tip of pinTips) attach.addPoint(tip.x, tip.y);
    for (const entry of entryPoints) attach.addPoint(entry.x, entry.y);
    for (const j of junctions) attach.addPoint(j.at.x, j.at.y);
    for (const index of portRecords) {
      const p = recordProps(doc, index), name = (doc.kind[index] === 17 ? p.str('TEXT') : p.str('NAME')).trim();
      if (!name) { diag.add('warning', 'PORT_UNNAMED', 'A port has no name and was ignored.', { defId }); continue; }
      const ux = p.units('LOCATION.X'), uy = p.units('LOCATION.Y'), span = doc.kind[index] === 17 ? 0 : Math.abs(p.units('WIDTH')), vertical = doc.kind[index] === 18 && p.int('STYLE', 0) >= 4;
      const candidates = [frame.point(ux, uy), ...(span > 0 ? [vertical ? frame.point(ux, uy + span) : frame.point(ux + span, uy)] : [])];
      const connected = candidates.filter(c => attach.hit(c.x, c.y));
      const ends = connected.length ? connected : [candidates[0]];
      const angle = vertical ? 90 : 0;
      ends.forEach((at, k) => { labels.push({ id: `l${index}${k ? `.${k}` : ''}`, kind: ctx.portKind, text: name, at, angle, shape: IO_SHAPES[p.int('IOTYPE', 0)] ?? 'passive' }); box.add(at); });
      if (!connected.length) diag.add('warning', 'PORT_UNATTACHED', `Port "${name}" touches no wire or pin with either end.`, { defId, at: candidates[0] });
    }
  }

  // ---- no-ERC markers: kept as no-connect flags only on pin tips that nothing else touches
  if (noErcMarkers.length) {
    const tips = new Map<string, number>(), wired = new Map<string, number>();
    const q = (point: SchPoint): string => `${Math.round(point.x / TOLERANCE_MM)},${Math.round(point.y / TOLERANCE_MM)}`;
    for (const tip of pinTips) tips.set(q(tip), (tips.get(q(tip)) ?? 0) + 1);
    for (const w of wires) { wired.set(q(w.a), 1); wired.set(q(w.b), 1); }
    for (const j of junctions) wired.set(q(j.at), 1);
    for (const entry of entryPoints) wired.set(q(entry), 1);
    let kept = 0;
    for (const marker of noErcMarkers) {
      const k = q(marker.at);
      if (tips.has(k) && !wired.has(k)) { noConnects.push({ id: marker.id, at: marker.at }); box.add(marker.at); kept++; }
    }
    if (noErcMarkers.length - kept) diag.add('info', 'NO_ERC_NOT_NO_CONNECT', `${noErcMarkers.length - kept} no-ERC marker(s) are not on an unconnected pin; they only suppress checks in Altium and are ignored.`, { defId });
  }

  for (const [kind, count] of kindCounts) diag.add('info', 'UNKNOWN_RECORD', `${count} record(s) of kind RECORD=${kind} are not read.`, { defId });
  if (unownedDrawing) diag.add('info', 'UNUSED_RECORD', `${unownedDrawing} drawing record(s) are owned by a sheet symbol, template or other object and are not drawn.`, { defId });
  if (doc.binaryRecords) diag.add('info', 'BINARY_RECORD_SKIPPED', `${doc.binaryRecords} binary-flagged record(s) are not read.`, { defId });
  if (doc.trailerBytes) diag.add('info', 'STORAGE_SKIPPED', `${doc.trailerBytes} byte(s) of embedded storage (images) after the records of the ASCII export are not read.`, { defId });
  for (const s of symbols) box.merge(s.bounds);
  const bounds = box.empty ? { minX: 0, minY: 0, maxX: paper.width, maxY: paper.height } : box.bounds();
  return {
    id: defId, name: loaded.stem, file: loaded.file, title: titleBlock.title ?? '', titleBlock, paper, symbols, wires, buses, busEntries, junctions, noConnects, labels, sheetRefs, graphics, bounds,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------------------------

/** Project scope numbers (`HierarchyMode` of a .PrjPcb): read from real projects, see the header. */
const SCOPE_AUTOMATIC = 0, SCOPE_HIERARCHICAL = 2, SCOPE_GLOBAL = 3;

export const parseAltiumSch: SchematicParser = (input: SchematicInput): Schematic | null => {
  const data = input.data;
  if (data.length < 16) return null;
  const primaryDoc = decodeSchematic(data, baseName(input.name));
  if (!primaryDoc) return null;
  return build(input, primaryDoc);
};

function build(input: SchematicInput, primaryDoc: AltiumDocument): Schematic {
  const diag = new Diags();
  const companions = input.companions ?? {};
  const primary: Loaded = { key: keyOf(input.name), file: baseName(input.name), stem: stemOf(input.name), doc: primaryDoc, symbolFiles: scanSymbolFiles(primaryDoc) };
  const loaded = new Map<string, Loaded>([[primary.key, primary]]);
  const failed = new Set<string>();
  const order: Loaded[] = [primary];

  const load = (file: string): Loaded | null => {
    const key = keyOf(file);
    const known = loaded.get(key);
    if (known) return known;
    const bytes = Object.hasOwn(companions, key) ? companions[key] : undefined; // never an inherited property such as __proto__
    if (!bytes || failed.has(key)) return null;
    if (loaded.size >= SCHEMATIC_LIMITS.maxSheetDefs) throw fail(`The design has more than ${SCHEMATIC_LIMITS.maxSheetDefs} sheets.`, 'LIMIT_EXCEEDED');
    let doc: AltiumDocument | null;
    try { doc = decodeSchematic(bytes, baseName(file)); }
    catch (error) {
      failed.add(key);
      diag.add('error', 'SHEET_FILE_INVALID', `Sheet file "${baseName(file)}" could not be read: ${error instanceof Error ? error.message : 'unreadable'}`);
      return null;
    }
    if (!doc) { failed.add(key); diag.add('error', 'SHEET_FILE_INVALID', `Sheet file "${baseName(file)}" is not an Altium schematic document.`); return null; }
    const entry: Loaded = { key, file: baseName(file), stem: stemOf(file), doc, symbolFiles: scanSymbolFiles(doc) };
    loaded.set(key, entry); order.push(entry);
    return entry;
  };

  // ---- project file: which companion project lists this sheet, its scope and its other sheets
  let project: AltiumProject | undefined;
  const projectKeys = Object.keys(companions).filter(name => name.endsWith('.prjpcb')).sort();
  for (const name of projectKeys) {
    let candidate: AltiumProject;
    try { candidate = parseProject(companions[name]); } catch (error) { diag.add('warning', 'PROJECT_UNREADABLE', `Project file "${name}" could not be read: ${error instanceof Error ? error.message : 'unreadable'}`); continue; }
    if (candidate.documents.some(doc => keyOf(doc) === primary.key)) { project = candidate; break; }
  }
  if (projectKeys.length && !project) diag.add('info', 'PROJECT_NOT_USED', 'No companion project file lists this sheet; the net identifier scope follows the Automatic rule.');
  const listed: Loaded[] = [], listedSet = new Set<Loaded>();
  if (project) {
    for (const path of project.documents) {
      if (!/\.schdoc$/i.test(path)) continue;
      const entry = load(path); // companions are keyed by base name, so a project in a parent directory finds the sheets the host supplied from below it
      if (entry && entry !== primary && !listedSet.has(entry)) { listed.push(entry); listedSet.add(entry); }
      else if (!entry && keyOf(path) !== primary.key) diag.add('info', 'PROJECT_SHEET_MISSING', `Project sheet "${path}" is not among the loaded files.`);
    }
  }

  // ---- sheet symbols: load every referenced sheet (breadth first, each file once)
  const queue = [...order];
  for (let q = 0; q < queue.length; q++) {
    for (const file of queue[q].symbolFiles.values()) {
      if (!file) continue;
      const before = loaded.has(keyOf(file));
      const entry = load(file);
      if (entry && !before) queue.push(entry);
    }
  }
  const hasSymbols = order.some(entry => entry.symbolFiles.size > 0 || entry.doc.kind.includes(15));

  // ---- scope
  let scope = hasSymbols ? SCOPE_HIERARCHICAL : SCOPE_GLOBAL;
  if (project?.hierarchyMode !== undefined) {
    if (project.hierarchyMode === SCOPE_AUTOMATIC) { /* automatic rule above */ }
    else if (project.hierarchyMode === SCOPE_HIERARCHICAL || project.hierarchyMode === SCOPE_GLOBAL) scope = project.hierarchyMode;
    else diag.add('warning', 'SCOPE_UNKNOWN', `The project's net identifier scope (HierarchyMode=${project.hierarchyMode}) is not understood; the Automatic rule is used.`);
  }
  const hierarchical = scope === SCOPE_HIERARCHICAL;
  const ctx: Context = {
    netLabelKind: hierarchical ? 'local' : 'global', portKind: hierarchical ? 'hierarchical' : 'global',
    childDefId: file => { const entry = loaded.get(keyOf(file)); if (!entry) { if (!failed.has(keyOf(file))) diag.add('warning', 'SHEET_FILE_MISSING', `Sheet file "${baseName(file)}" is not among the loaded files; its sheet pins dangle.`); return null; } return entry.key; },
    diag, drawn: { sheet: 0, total: 0, pins: 0 },
  };

  const defs: SchSheetDef[] = [];
  for (const entry of order) defs.push(convertSheet(entry, ctx));

  // ---- instances
  const defById = new Map(defs.map(def => [def.id, def]));
  const instances: SchSheetInstance[] = [];
  const addInstance = (instance: SchSheetInstance): void => {
    if (instances.length >= SCHEMATIC_LIMITS.maxInstances) throw fail(`The design expands to more than ${SCHEMATIC_LIMITS.maxInstances} sheet instances.`, 'LIMIT_EXCEEDED');
    instances.push(instance);
  };
  const walk = (defId: string, path: string, parent: SchSheetInstance | null, ref: SchSheetRef | null, chain: string[]): void => {
    const def = defById.get(defId);
    if (!def) return;
    const instance: SchSheetInstance = { path, defId, name: ref ? ref.name : def.name, page: String(instances.length + 1), parentPath: parent ? parent.path : null, sheetRefId: ref ? ref.id : null, childPaths: [], depth: chain.length };
    addInstance(instance);
    if (parent) parent.childPaths.push(path);
    if (chain.length >= SCHEMATIC_LIMITS.maxNestingDepth) { diag.add('error', 'SHEET_CYCLE', 'Sheet nesting is too deep; deeper sheets were ignored.', { defId }); return; }
    for (const r of def.sheetRefs) {
      if (!r.defId || !defById.has(r.defId)) continue;
      if (r.defId === defId || chain.includes(r.defId)) { diag.add('error', 'SHEET_CYCLE', `Sheet "${r.name}" includes one of its own ancestors; the recursive instance was ignored.`, { defId, instancePath: path }); continue; }
      walk(r.defId, `${path}/${r.id}`, instance, r, [...chain, defId]);
    }
  };
  walk(primary.key, '', null, null, []);
  if (hierarchical) {
    const reached = new Set(instances.map(instance => instance.defId));
    const stray = listed.filter(entry => !reached.has(entry.key));
    if (stray.length) diag.add('info', 'SHEETS_NOT_REACHED', `${stray.length} project sheet(s) are not below the opened sheet and are not shown: ${stray.slice(0, 5).map(entry => entry.file).join(', ')}${stray.length > 5 ? ', ...' : ''}.`);
  } else {
    for (const entry of listed) addInstance({ path: `sheet:${entry.key}`, defId: entry.key, name: entry.stem, page: String(instances.length + 1), parentPath: null, sheetRefId: null, childPaths: [], depth: 0 });
  }

  const header = primaryDoc.header, version = /File Version\s+([0-9.]+)/i.exec(header)?.[1];
  if (version && version !== '5.0') diag.add('warning', 'VERSION_UNTESTED', `Altium schematic file version ${version} is not covered by the tested layouts (5.0); it is read as written.`);
  return {
    format: FORMAT_ID, formatLabel: `Altium schematic (SchDoc${primaryDoc.ascii ? ', ASCII' : ''}${version ? `, version ${version}` : ''})`, sourceUnit: 'mil', name: primary.stem,
    defs, rootDefId: primary.key, instances, diagnostics: diag.finish(),
  };
}
