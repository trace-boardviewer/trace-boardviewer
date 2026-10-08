/*
 * Original TRACE module (MIT). Line-record parsers for the ODB++ files a boardview needs: matrix/matrix, misc/info and stephdr
 * (key = value with blocks), the step profile (surface contours), eda/data (nets, toeprint subnets with the layer kinds of their FID
 * feature records, packages, pins, outlines), comp_+_top / comp_+_bot components (CMP, PRP, TOP and BOM records) and
 * netlists/cadnet/netlist. Record layouts are facts from the ODB++ Design Format Specification 8.1 (Siemens); no specification text or
 * third-party code is reproduced. A PRP value whose closing quote is on a later line (writers keep line breaks of descriptions) is read
 * across those lines, never across a record line.
 *
 * Every parser walks the text once, line by line; each line is split at most once on blanks and never matched with a pattern that can
 * backtrack, so the work is linear in the file size. Coordinates stay in the file's units (the caller converts with `units`).
 */
import type { Point } from '../types';
import { BoardFormatError } from './common';

export type OdbUnits = 'MM' | 'INCH';
export const MM_PER_UNIT: Readonly<Record<OdbUnits, number>> = { MM: 1, INCH: 25.4 };

export const RECORD_LIMITS = Object.freeze({
  components: 250_000, toeprints: 1_000_000, packages: 250_000, packagePins: 2_000_000, nets: 1_000_000,
  subnetToeprints: 2_000_000, shapePoints: 4_000_000, netPoints: 2_000_000, matrixEntries: 10_000, properties: 2_000_000,
});

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d{1,10}$/;
export class Lines {
  constructor(readonly file: string) {}
  fail(no: number | undefined, message: string, code: 'INVALID_FORMAT' | 'LIMIT_EXCEEDED' = 'INVALID_FORMAT'): never {
    throw new BoardFormatError(`ODB++ ${this.file}${no ? ` line ${no}` : ''}: ${message}`, code, 'ODB++');
  }
  decimal(no: number, token: string | undefined, label: string): number {
    if (token === undefined || !DECIMAL.test(token)) return this.fail(no, `invalid ${label}${token === undefined ? ' (missing)' : `: ${token.slice(0, 40)}`}.`);
    const value = Number(token);
    if (!Number.isFinite(value)) this.fail(no, `invalid ${label}.`);
    return value;
  }
  integer(no: number, token: string | undefined, label: string): number {
    if (token === undefined || !INTEGER.test(token)) return this.fail(no, `invalid ${label}${token === undefined ? ' (missing)' : `: ${token.slice(0, 40)}`}.`);
    return Number(token);
  }
}
/** Calls `visit(line, lineNumber)` for every line with CR, LF or CRLF endings removed; one pass, no regular expression. */
export function eachLine(text: string, visit: (line: string, no: number) => void): void {
  let start = 0, no = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const stop = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    no++;
    visit(text.slice(start, stop), no);
    start = end + 1;
  }
}
/** Blank-separated fields (spaces and tabs); a single linear scan. */
export function fields(line: string): string[] {
  const out: string[] = [];
  let index = 0;
  const n = line.length;
  while (index < n) {
    while (index < n && (line.charCodeAt(index) === 32 || line.charCodeAt(index) === 9)) index++;
    if (index >= n) break;
    const begin = index;
    while (index < n && line.charCodeAt(index) !== 32 && line.charCodeAt(index) !== 9) index++;
    out.push(line.slice(begin, index));
  }
  return out;
}
/** `UNITS=MM|INCH` (any file) or the older `U MM|INCH` feature-file form; undefined when the line is not a units directive. */
function unitsDirective(line: string): OdbUnits | 'invalid' | undefined {
  const upper = line.toUpperCase();
  let value: string;
  if (upper.startsWith('UNITS')) {
    const rest = upper.slice(5).trim();
    if (!rest.startsWith('=')) return undefined;
    value = rest.slice(1).trim();
  } else if (upper.startsWith('U ') || upper.startsWith('U\t')) value = upper.slice(2).trim();
  else return undefined;
  return value === 'MM' || value === 'INCH' ? value : 'invalid';
}
class UnitsTracker {
  units?: OdbUnits;
  constructor(private readonly lines: Lines) {}
  /** True when the line was a units directive. A second directive must agree with the first (the specification allows only one). */
  take(line: string, no: number): boolean {
    const found = unitsDirective(line);
    if (found === undefined) return false;
    if (found === 'invalid') this.lines.fail(no, 'UNITS must be MM or INCH.');
    if (this.units && this.units !== found) this.lines.fail(no, `conflicting UNITS directives (${this.units} and ${found}).`);
    this.units = found;
    return true;
  }
}

// --- matrix, misc/info, stephdr ---

export interface MatrixStep { col: number; name: string }
export interface MatrixLayer { row: number; name: string; type: string; context: string; polarity: string; startName?: string; endName?: string }
export interface Matrix {
  steps: MatrixStep[]; layers: MatrixLayer[]; ignored: number;
  /** STEP or LAYER blocks whose NAME is not a legal entity name: they are left out. `examples` holds at most 16 of the names. */
  illegalNames: { count: number; examples: string[] };
}
export interface KeyValues { values: Map<string, string>; blocks: Array<{ name: string; values: Map<string, string> }>; ignored: number }

/** `KEY=VALUE` lines plus `NAME {` ... `}` blocks (matrix STEP/LAYER, stephdr STEP-REPEAT). Keys are upper-cased; values trimmed. */
export function parseKeyValues(text: string, file: string): KeyValues {
  const lines: Lines = new Lines(file);
  const result: KeyValues = { values: new Map(), blocks: [], ignored: 0 };
  let block: { name: string; values: Map<string, string> } | null = null, openedAt = 0;
  eachLine(text, (raw, no) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (line.endsWith('{')) {
      if (block) lines.fail(no, 'a block opens inside another block.');
      const name = line.slice(0, -1).trim().toUpperCase();
      if (!name || name.includes('=')) lines.fail(no, 'a block needs a name.');
      if (result.blocks.length >= RECORD_LIMITS.matrixEntries) lines.fail(no, 'too many blocks.', 'LIMIT_EXCEEDED');
      block = { name, values: new Map() }; openedAt = no;
      return;
    }
    if (line === '}') {
      if (!block) lines.fail(no, 'a closing brace has no block.');
      result.blocks.push(block); block = null;
      return;
    }
    const equals = line.indexOf('=');
    if (equals <= 0) { result.ignored++; return; }
    const key = line.slice(0, equals).trim().toUpperCase(), value = line.slice(equals + 1).trim();
    (block ? block.values : result.values).set(key, value);
  });
  if (block) lines.fail(openedAt, `block ${(block as { name: string }).name} is not closed.`);
  return result;
}
const LEGAL_NAME = /^[a-z0-9_+.\-]{1,64}$/;
export function parseMatrix(text: string, file = 'matrix/matrix'): Matrix {
  const parsed = parseKeyValues(text, file);
  const steps: MatrixStep[] = [], layers: MatrixLayer[] = [], illegalNames = { count: 0, examples: [] as string[] };
  let ignored = parsed.ignored;
  // Names select directories of the product model; a name outside the entity-name alphabet cannot name one, so its block is skipped.
  const name = (values: Map<string, string>): string | null => {
    const value = (values.get('NAME') ?? '').toLowerCase();
    if (LEGAL_NAME.test(value)) return value;
    if (illegalNames.count++ < 16) illegalNames.examples.push(value.slice(0, 40));
    return null;
  };
  for (const block of parsed.blocks) {
    if (block.name === 'STEP') {
      const stepName = name(block.values);
      if (stepName === null) continue;
      const col = Number(block.values.get('COL') ?? steps.length + 1);
      steps.push({ col: Number.isFinite(col) ? col : steps.length + 1, name: stepName });
    } else if (block.name === 'LAYER') {
      const layerName = name(block.values);
      if (layerName === null) continue;
      const row = Number(block.values.get('ROW') ?? layers.length + 1);
      layers.push({
        row: Number.isFinite(row) ? row : layers.length + 1, name: layerName,
        type: (block.values.get('TYPE') ?? '').toUpperCase(), context: (block.values.get('CONTEXT') ?? '').toUpperCase(),
        polarity: (block.values.get('POLARITY') ?? 'POSITIVE').toUpperCase(),
        ...(block.values.get('START_NAME') ? { startName: block.values.get('START_NAME')!.toLowerCase() } : {}),
        ...(block.values.get('END_NAME') ? { endName: block.values.get('END_NAME')!.toLowerCase() } : {}),
      });
    } else ignored++;
  }
  steps.sort((a, b) => a.col - b.col);
  layers.sort((a, b) => a.row - b.row);
  return { steps, layers, ignored, illegalNames };
}

// --- contours (profile surfaces and eda/data outlines) ---

export interface Polygon { hole: boolean; points: Point[]; circle?: { x: number; y: number; r: number } }
const ARC_STEP = Math.PI / 18;
/** Appends the arc from `start` to `end` around `centre` (excluding `start`, ending exactly at `end`); start == end is a full circle. */
export function arcPoints(start: Point, end: Point, centre: Point, clockwise: boolean, out: Point[]): void {
  const r0 = Math.hypot(start.x - centre.x, start.y - centre.y), r1 = Math.hypot(end.x - centre.x, end.y - centre.y);
  if (!(r0 > 0) || !(r1 > 0)) { out.push({ x: end.x, y: end.y }); return; }
  const a0 = Math.atan2(start.y - centre.y, start.x - centre.x);
  let sweep = Math.atan2(end.y - centre.y, end.x - centre.x) - a0;
  if (clockwise) { if (sweep >= 0) sweep -= 2 * Math.PI; } else if (sweep <= 0) sweep += 2 * Math.PI;
  const steps = Math.min(36, Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP)));
  for (let step = 1; step < steps; step++) {
    const t = step / steps, angle = a0 + sweep * t, r = r0 + (r1 - r0) * t;
    out.push({ x: centre.x + r * Math.cos(angle), y: centre.y + r * Math.sin(angle) });
  }
  out.push({ x: end.x, y: end.y });
}
/** OB / OS / OC / OE polygon state shared by profile surfaces and eda/data contours, with a per-file point budget. */
class ContourBuilder {
  private current: { polygon: Polygon; last: Point; arcsOnly: boolean; centre?: Point; radius?: number } | null = null;
  points = 0;
  constructor(private readonly lines: Lines) {}
  get open(): boolean { return this.current !== null; }
  private count(no: number, added: number) {
    if ((this.points += added) > RECORD_LIMITS.shapePoints) this.lines.fail(no, 'contour point count exceeds the import limit.', 'LIMIT_EXCEEDED');
  }
  begin(no: number, parts: string[]): void {
    if (this.current) this.lines.fail(no, 'OB starts a polygon before the previous one ended (OE).');
    const start = { x: this.lines.decimal(no, parts[1], 'polygon X'), y: this.lines.decimal(no, parts[2], 'polygon Y') };
    const type = (parts[3] ?? 'I').toUpperCase();
    if (type !== 'I' && type !== 'H') this.lines.fail(no, 'OB polygon type must be I (island) or H (hole).');
    this.count(no, 1);
    this.current = { polygon: { hole: type === 'H', points: [start] }, last: start, arcsOnly: true };
  }
  segment(no: number, parts: string[]): void {
    const current = this.current ?? this.lines.fail(no, 'OS outside a polygon (missing OB).');
    const end = { x: this.lines.decimal(no, parts[1], 'segment X'), y: this.lines.decimal(no, parts[2], 'segment Y') };
    this.count(no, 1);
    // A repeated vertex (some writers repeat the OB point as the first OS) adds nothing to the polygon.
    if (end.x !== current.last.x || end.y !== current.last.y) current.polygon.points.push(end);
    current.last = end; current.arcsOnly = false;
  }
  arc(no: number, parts: string[]): void {
    const current = this.current ?? this.lines.fail(no, 'OC outside a polygon (missing OB).');
    const end = { x: this.lines.decimal(no, parts[1], 'arc end X'), y: this.lines.decimal(no, parts[2], 'arc end Y') };
    const centre = { x: this.lines.decimal(no, parts[3], 'arc centre X'), y: this.lines.decimal(no, parts[4], 'arc centre Y') };
    const direction = (parts[5] ?? '').toUpperCase();
    if (direction !== 'Y' && direction !== 'N') this.lines.fail(no, 'OC direction must be Y (clockwise) or N.');
    const before = current.polygon.points.length;
    arcPoints(current.last, end, centre, direction === 'Y', current.polygon.points);
    this.count(no, current.polygon.points.length - before);
    const radius = Math.hypot(current.last.x - centre.x, current.last.y - centre.y);
    if (current.arcsOnly) {
      if (!current.centre) { current.centre = centre; current.radius = radius; }
      else if (Math.hypot(centre.x - current.centre.x, centre.y - current.centre.y) > 1e-6 * Math.max(1, radius) || Math.abs(radius - current.radius!) > 1e-6 * Math.max(1, radius)) current.arcsOnly = false;
    }
    current.last = end;
  }
  end(no: number): Polygon {
    const current = this.current ?? this.lines.fail(no, 'OE without a polygon (missing OB).');
    this.current = null;
    const { polygon } = current;
    const first = polygon.points[0], last = polygon.points[polygon.points.length - 1];
    if (polygon.points.length > 1 && Math.abs(first.x - last.x) < 1e-12 && Math.abs(first.y - last.y) < 1e-12) polygon.points.pop();
    if (current.arcsOnly && current.centre && current.radius! > 0) polygon.circle = { x: current.centre.x, y: current.centre.y, r: current.radius! };
    return polygon;
  }
}

export interface Surfaces { units?: OdbUnits; polygons: Polygon[]; otherFeatures: number }
/** Surface features (S ... SE with OB/OS/OC/OE polygons) of a features-format file such as the step profile. */
export function parseSurfaces(text: string, file: string): Surfaces {
  const lines: Lines = new Lines(file), units = new UnitsTracker(lines), contour = new ContourBuilder(lines);
  const polygons: Polygon[] = [];
  let inSurface = false, otherFeatures = 0, surfaceLine = 0;
  eachLine(text, (raw, no) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || units.take(line, no)) return;
    const parts = fields(line), record = parts[0].toUpperCase();
    switch (record) {
      case 'S': if (inSurface) lines.fail(no, 'a surface starts inside another surface.'); inSurface = true; surfaceLine = no; return;
      case 'SE': if (!inSurface) lines.fail(no, 'SE without a surface.'); if (contour.open) lines.fail(no, 'SE inside an open polygon (missing OE).'); inSurface = false; return;
      case 'OB': if (!inSurface) lines.fail(no, 'OB outside a surface.'); contour.begin(no, parts); return;
      case 'OS': contour.segment(no, parts); return;
      case 'OC': contour.arc(no, parts); return;
      case 'OE': polygons.push(contour.end(no)); return;
      case 'L': case 'P': case 'A': case 'T': case 'B': otherFeatures++; return;
      default: // $n symbol names, @n / &n attribute tables, F feature count, ID records
    }
  });
  if (inSurface) lines.fail(surfaceLine, 'the surface is not closed (missing SE).');
  return { units: units.units, polygons, otherFeatures };
}

// --- eda/data ---

export type Outline =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'circle'; x: number; y: number; r: number }
  | { kind: 'square'; x: number; y: number; half: number }
  | { kind: 'contour'; polygons: Polygon[] };
export interface EdaPin { name: string; type: string; x: number; y: number; etype: string; mtype: string; outlines: Outline[] }
export interface EdaPackage { name: string; pitch: number; bbox: { minX: number; minY: number; maxX: number; maxY: number } | null; outlines: Outline[]; pins: EdaPin[] }
/** Where a layer named by the eda/data LYR record sits, as the caller knows it from the matrix (undefined: not in the matrix). */
export type LayerKind = 'top' | 'bottom' | 'inner' | 'copper' | 'other';
/** Bits of the FID mask of an SNT TOP subnet: the kinds of layer its board features lie on. COPPER is copper of a single-layer stack (no side). */
export const FID = Object.freeze({ TOP: 1, BOTTOM: 2, INNER: 4, OTHER: 8, UNKNOWN: 16, COPPER: 32 });
const FID_BIT: Readonly<Record<LayerKind, number>> = { top: FID.TOP, bottom: FID.BOTTOM, inner: FID.INNER, copper: FID.COPPER, other: FID.OTHER };
export interface EdaData {
  units?: OdbUnits;
  source?: string;
  netNames: string[];
  /** LYR record: the layer names FID records index (lowercase). */
  layers: string[];
  /**
   * Flat quintuples per SNT TOP record: net index, side (0 top, 1 bottom), component index, toeprint index, and the FID mask (bits of FID)
   * of the feature records that follow it (0: none).
   */
  toeprintNets: Int32Array;
  packages: EdaPackage[];
  ignored: number;
}
const outlineRecord = (lines: Lines, no: number, parts: string[], kind: string): Outline => {
  const value = (index: number, label: string) => lines.decimal(no, parts[index], label);
  if (kind === 'RC') {
    const outline = { kind: 'rect' as const, x: value(1, 'RC lower-left X'), y: value(2, 'RC lower-left Y'), w: value(3, 'RC width'), h: value(4, 'RC height') };
    if (outline.w < 0 || outline.h < 0) lines.fail(no, 'negative RC size.');
    return outline;
  }
  if (kind === 'CR') {
    const outline = { kind: 'circle' as const, x: value(1, 'CR centre X'), y: value(2, 'CR centre Y'), r: value(3, 'CR radius') };
    if (outline.r < 0) lines.fail(no, 'negative CR radius.');
    return outline;
  }
  const outline = { kind: 'square' as const, x: value(1, 'SQ centre X'), y: value(2, 'SQ centre Y'), half: value(3, 'SQ half side') };
  if (outline.half < 0) lines.fail(no, 'negative SQ size.');
  return outline;
};
const EDA_RECORDS = new Set(['HDR', 'LYR', 'NET', 'SNT', 'FID', 'PKG', 'PIN', 'RC', 'CR', 'SQ', 'CT', 'OB', 'OS', 'OC', 'OE', 'CE', 'PRP', 'FGR']);
/** The record name and its fields before the first semicolon (attributes and ID follow it). */
function headFields(line: string): string[] { const semi = line.indexOf(';'); return fields(semi < 0 ? line : line.slice(0, semi)); }

/** `layerKind` classifies LYR layer names for the FID masks; without it every FID counts as UNKNOWN. */
export function parseEdaData(text: string, file: string, layerKind?: (name: string) => LayerKind | undefined): EdaData {
  const lines: Lines = new Lines(file), units = new UnitsTracker(lines), contour = new ContourBuilder(lines);
  const netNames: string[] = [], packages: EdaPackage[] = [], layers: string[] = [], layerBits: number[] = [];
  let toeprintNets = new Int32Array(5 * 1024), toeprintFill = 0, ignored = 0, source: string | undefined, packagePins = 0;
  /** Position of the FID mask of the SNT TOP record that FID records currently follow (-1: none). */
  let maskAt = -1;
  let pkg: EdaPackage | null = null, pin: EdaPin | null = null, polygons: Polygon[] | null = null, contourLine = 0, inNet = false;
  const owner = (no: number) => {
    if (pin) return pin.outlines;
    if (pkg) return pkg.outlines;
    return lines.fail(no, 'an outline record appears outside a package or pin.');
  };
  const closeContour = (no: number) => { if (polygons) lines.fail(no, 'a contour (CT) is not closed with CE.'); };
  let continuation: Continuation | null = null;
  eachLine(text, (raw, no) => {
    if (continuation) {
      const taken = continuation.take(raw);
      if (continuation.closed || !taken) continuation = null;
      if (taken) return;
    }
    const line = raw.trim();
    if (!line || line.startsWith('#') || units.take(line, no)) return;
    const space = line.search(/[ \t]/), record = (space < 0 ? line : line.slice(0, space)).toUpperCase();
    if (polygons) {
      switch (record) {
        case 'OB': contour.begin(no, fields(line)); return;
        case 'OS': contour.segment(no, fields(line)); return;
        case 'OC': contour.arc(no, fields(line)); return;
        case 'OE': polygons.push(contour.end(no)); return;
        case 'CE':
          if (contour.open) lines.fail(no, 'CE inside an open polygon (missing OE).');
          if (!polygons.length) lines.fail(no, 'an empty contour (CT ... CE).');
          owner(no).push({ kind: 'contour', polygons }); polygons = null; return;
        default: return lines.fail(contourLine, 'a contour (CT) is not closed with CE.');
      }
    }
    switch (record) {
      case 'HDR': source = line.slice(3).trim().slice(0, 200); return;
      case 'NET': {
        closeContour(no);
        if (netNames.length >= RECORD_LIMITS.nets) lines.fail(no, 'net count exceeds the import limit.', 'LIMIT_EXCEEDED');
        const semi = line.indexOf(';');
        netNames.push((semi < 0 ? line.slice(3) : line.slice(3, semi)).trim());
        pkg = null; pin = null; inNet = true; maskAt = -1;
        return;
      }
      case 'SNT': {
        if (!inNet) lines.fail(no, 'SNT appears outside a net.');
        maskAt = -1;
        const parts = fields(line);
        if ((parts[1] ?? '').toUpperCase() !== 'TOP') return; // via, trace and plane subnets carry no pin
        const side = (parts[2] ?? '').toUpperCase();
        if (side !== 'T' && side !== 'B') lines.fail(no, 'SNT TOP side must be T or B.');
        const comp = lines.integer(no, parts[3], 'SNT component number'), toeprint = lines.integer(no, parts[4], 'SNT toeprint number');
        if (comp < 0 || toeprint < 0) lines.fail(no, 'negative SNT component or toeprint number.');
        if (toeprintFill / 5 >= RECORD_LIMITS.subnetToeprints) lines.fail(no, 'subnet count exceeds the import limit.', 'LIMIT_EXCEEDED');
        if (toeprintFill + 5 > toeprintNets.length) { const grown = new Int32Array(toeprintNets.length * 2); grown.set(toeprintNets); toeprintNets = grown; }
        toeprintNets[toeprintFill++] = netNames.length - 1; toeprintNets[toeprintFill++] = side === 'T' ? 0 : 1;
        toeprintNets[toeprintFill++] = comp; toeprintNets[toeprintFill++] = toeprint;
        maskAt = toeprintFill; toeprintNets[toeprintFill++] = 0;
        return;
      }
      case 'FID': {
        if (maskAt < 0) return; // features of via, trace and plane subnets and of feature groups
        // FID <type> <lyr_num> <f_num>: only the layer matters (some writers mark mask and paste features as copper, C).
        const parts = fields(line), layer = parts[2] !== undefined && /^\d{1,6}$/.test(parts[2]) ? Number(parts[2]) : -1;
        toeprintNets[maskAt] |= layer >= 0 && layer < layerBits.length ? layerBits[layer] : FID.UNKNOWN;
        return;
      }
      case 'LYR':
        for (const name of fields(line).slice(1)) {
          if (layers.length >= RECORD_LIMITS.matrixEntries) break;
          const kind = layerKind?.(name.toLowerCase());
          layers.push(name.toLowerCase()); layerBits.push(kind ? FID_BIT[kind] : FID.UNKNOWN);
        }
        return;
      case 'PKG': {
        closeContour(no);
        if (packages.length >= RECORD_LIMITS.packages) lines.fail(no, 'package count exceeds the import limit.', 'LIMIT_EXCEEDED');
        const parts = headFields(line);
        if (parts.length < 2) lines.fail(no, 'PKG needs a name.');
        let bbox: EdaPackage['bbox'] = null, pitch = 0;
        if (parts.length >= 7) {
          pitch = lines.decimal(no, parts[2], 'package pitch');
          bbox = { minX: lines.decimal(no, parts[3], 'package xmin'), minY: lines.decimal(no, parts[4], 'package ymin'), maxX: lines.decimal(no, parts[5], 'package xmax'), maxY: lines.decimal(no, parts[6], 'package ymax') };
          if (!(bbox.maxX >= bbox.minX && bbox.maxY >= bbox.minY)) bbox = null;
        }
        pkg = { name: parts[1], pitch, bbox, outlines: [], pins: [] }; pin = null; inNet = false; maskAt = -1;
        packages.push(pkg);
        return;
      }
      case 'PIN': {
        closeContour(no);
        if (!pkg) lines.fail(no, 'PIN appears outside a package.');
        if (++packagePins > RECORD_LIMITS.packagePins) lines.fail(no, 'package pin count exceeds the import limit.', 'LIMIT_EXCEEDED');
        const parts = fields(line);
        if (parts.length < 5) lines.fail(no, 'PIN needs a name, type and centre.');
        pin = { name: parts[1], type: parts[2].toUpperCase(), x: lines.decimal(no, parts[3], 'pin X'), y: lines.decimal(no, parts[4], 'pin Y'), etype: (parts[6] ?? 'U').toUpperCase(), mtype: (parts[7] ?? 'U').toUpperCase(), outlines: [] };
        pkg.pins.push(pin);
        return;
      }
      case 'RC': case 'CR': case 'SQ': owner(no).push(outlineRecord(lines, no, fields(line), record)); return;
      case 'CT': owner(no); polygons = []; contourLine = no; return;
      case 'OB': case 'OS': case 'OC': case 'OE': case 'CE': return lines.fail(no, `${record} appears outside a contour (CT).`);
      case 'FGR': maskAt = -1; return;
      case 'PRP': if (property(line).open) continuation = new Continuation(EDA_RECORDS, () => {}); return;
      default:
        if (record.startsWith('@') || record.startsWith('&')) return;
        ignored++;
    }
  });
  if (polygons) lines.fail(contourLine, 'a contour (CT) is not closed with CE.');
  return { units: units.units, ...(source ? { source } : {}), netNames, layers, toeprintNets: toeprintNets.subarray(0, toeprintFill), packages, ignored };
}

// --- components ---

export interface Toeprint { pin: number; x: number; y: number; rot: number; mirror: boolean; net: number; subnet: number; name: string }
export interface ComponentRecord {
  pkgRef: number; x: number; y: number; rot: number; mirror: boolean; name: string; partName: string;
  /** Raw attribute assignments after the first semicolon ("0,2=0,3=1"), resolved by the caller with the lookup tables. */
  attributes: string;
  properties: Array<[string, string]>;
  /** BOM DATA records (CPN, IPN, MPN, VND, DSC, ...) in file order, keyword and the rest of the line. */
  bom: Array<[string, string]>;
  toeprints: Toeprint[];
  line: number;
}
export interface Components { units?: OdbUnits; attributeNames: Map<number, string>; attributeTexts: Map<number, string>; components: ComponentRecord[]; ignored: number }
const BOM_RECORDS = new Set(['CPN', 'PKG', 'IPN', 'DSC', 'VPL_VND', 'VPL_MPN', 'VND', 'MPN', 'QLF', 'CHS', 'PRIORITY', 'LNFILE']);
const mirrorFlag = (lines: Lines, no: number, token: string | undefined): boolean => {
  const value = (token ?? '').toUpperCase();
  if (value !== 'N' && value !== 'M') lines.fail(no, `mirror must be N or M, not "${(token ?? '').slice(0, 10)}".`);
  return value === 'M';
};
/**
 * `PRP <name> '<value>' n1 n2 ...`: the value is everything between the first and the last single quote. A value with a single quote on
 * its line continues on the next lines (some writers keep line breaks of descriptions): `open` is then true.
 */
function property(line: string): { name: string; value: string; open: boolean } {
  const parts = fields(line), name = parts[1] ?? '';
  const afterName = line.indexOf(name, 3) + name.length;
  const open = line.indexOf("'", afterName), close = line.lastIndexOf("'");
  if (open >= 0 && close === open) return { name, value: line.slice(open + 1), open: true };
  return { name, value: open >= 0 && close > open ? line.slice(open + 1, close) : line.slice(afterName).trim(), open: false };
}
/** The record keyword of a trimmed line (upper case; '' for a blank line). */
const keyword = (line: string) => { const space = line.search(/[ \t]/); return (space < 0 ? line : line.slice(0, space)).toUpperCase(); };
/**
 * Lines of a multi-line PRP value, up to the line holding the closing quote. A line that starts with one of `records` (or a comment or
 * attribute table) ends the value without being consumed, so a value whose closing quote is missing never swallows records; at most
 * 64 lines and 64 KiB are taken.
 */
class Continuation {
  private text = '';
  private lines = 0;
  /** The value is complete (closing quote, a record line, a budget or finish()); `done` has run once. */
  closed = false;
  constructor(private readonly records: ReadonlySet<string>, private readonly done: (text: string) => void) {}
  /** True when the line belonged to the value; a record line closes the value and is left to the caller. */
  take(raw: string): boolean {
    const trimmed = raw.trim(), record = keyword(trimmed);
    if (this.records.has(record) || trimmed.startsWith('#') || trimmed.startsWith('@') || trimmed.startsWith('&') || /^UNITS\s*=/i.test(trimmed)) { this.finish(); return false; }
    const close = raw.lastIndexOf("'");
    this.text += `\n${close >= 0 ? raw.slice(0, close) : raw}`;
    if (close >= 0 || ++this.lines >= 64 || this.text.length > 65536) this.finish();
    return true;
  }
  finish(): void { if (!this.closed) { this.closed = true; this.done(this.text); } }
}
const COMPONENT_RECORDS = new Set(['CMP', 'TOP', 'PRP', 'BOM']);
export function parseComponents(text: string, file: string): Components {
  const lines: Lines = new Lines(file), units = new UnitsTracker(lines);
  const components: ComponentRecord[] = [], attributeNames = new Map<number, string>(), attributeTexts = new Map<number, string>();
  let current: ComponentRecord | null = null, toeprints = 0, properties = 0, ignored = 0, continuation: Continuation | null = null;
  const table = (line: string, map: Map<number, string>) => {
    const space = line.search(/[ \t]/), index = Number(space < 0 ? line.slice(1) : line.slice(1, space));
    if (Number.isSafeInteger(index) && index >= 0 && map.size < RECORD_LIMITS.properties) map.set(index, space < 0 ? '' : line.slice(space + 1).trim());
  };
  const records = new Set([...COMPONENT_RECORDS, ...BOM_RECORDS]);
  eachLine(text, (raw, no) => {
    if (continuation) {
      const taken = continuation.take(raw);
      if (continuation.closed || !taken) continuation = null;
      if (taken) return;
    }
    const line = raw.trim();
    if (!line || line.startsWith('#') || units.take(line, no)) return;
    const space = line.search(/[ \t]/), record = (space < 0 ? line : line.slice(0, space)).toUpperCase();
    switch (record) {
      case 'CMP': {
        if (components.length >= RECORD_LIMITS.components) lines.fail(no, 'component count exceeds the import limit.', 'LIMIT_EXCEEDED');
        const semi = line.indexOf(';'), parts = fields(semi < 0 ? line : line.slice(0, semi));
        if (parts.length < 7) lines.fail(no, 'CMP needs a package reference, X, Y, rotation, mirror and a reference designator.');
        current = {
          pkgRef: lines.integer(no, parts[1], 'package reference'), x: lines.decimal(no, parts[2], 'component X'), y: lines.decimal(no, parts[3], 'component Y'),
          rot: lines.decimal(no, parts[4], 'component rotation'), mirror: mirrorFlag(lines, no, parts[5]), name: parts[6], partName: parts.slice(7).join(' '),
          attributes: semi < 0 ? '' : line.slice(semi + 1).split(';')[0].trim(), properties: [], bom: [], toeprints: [], line: no,
        };
        components.push(current);
        return;
      }
      case 'TOP': {
        if (!current) lines.fail(no, 'TOP appears before any CMP record.');
        if (++toeprints > RECORD_LIMITS.toeprints) lines.fail(no, 'toeprint count exceeds the import limit.', 'LIMIT_EXCEEDED');
        let parts = fields(line);
        // Some writers glue the mirror flag to the net number ("N12"), as the specification's own syntax line does. A separate
        // mirror field is exactly one letter, so a longer token of that shape can only be the glued form.
        if (parts.length >= 6 && parts[5].length > 1 && /^[NMnm]-?\d{1,10}$/.test(parts[5])) parts = [...parts.slice(0, 5), parts[5][0], parts[5].slice(1), ...parts.slice(6)];
        if (parts.length < 8) lines.fail(no, 'TOP needs a pin index, X, Y, rotation, mirror, net and subnet number.');
        current.toeprints.push({
          pin: lines.integer(no, parts[1], 'toeprint pin index'), x: lines.decimal(no, parts[2], 'toeprint X'), y: lines.decimal(no, parts[3], 'toeprint Y'),
          rot: lines.decimal(no, parts[4], 'toeprint rotation'), mirror: mirrorFlag(lines, no, parts[5]),
          net: lines.integer(no, parts[6], 'toeprint net number'), subnet: lines.integer(no, parts[7], 'toeprint subnet number'), name: parts.slice(8).join(' '),
        });
        return;
      }
      case 'PRP':
        if (!current) { ignored++; return; }
        if (++properties > RECORD_LIMITS.properties) lines.fail(no, 'property count exceeds the import limit.', 'LIMIT_EXCEEDED');
        {
          const read = property(line), entry: [string, string] = [read.name, read.value];
          current.properties.push(entry);
          if (read.open) continuation = new Continuation(records, rest => { entry[1] = (entry[1] + rest).replace(/\n$/, ''); });
        }
        return;
      default:
        if (record.startsWith('@')) { table(line, attributeNames); return; }
        if (record.startsWith('&')) { table(line, attributeTexts); return; }
        if (BOM_RECORDS.has(record)) {
          if (!current) { ignored++; return; }
          if (++properties > RECORD_LIMITS.properties) lines.fail(no, 'property count exceeds the import limit.', 'LIMIT_EXCEEDED');
          current.bom.push([record, space < 0 ? '' : line.slice(space + 1).trim()]);
          return;
        }
        ignored++;
    }
  });
  (continuation as Continuation | null)?.finish(); // assigned inside the line callback
  return { units: units.units, attributeNames, attributeTexts, components, ignored };
}

// --- netlists/cadnet/netlist ---

export interface CadNetlist { units?: OdbUnits; names: Map<number, string>; /** Flat triples x, y, side (0 top, 1 bottom, 2 both) parallel to `nets`. */ points: Float64Array; nets: Int32Array; ignored: number }
export function parseCadNetlist(text: string, file: string): CadNetlist {
  const lines: Lines = new Lines(file), units = new UnitsTracker(lines);
  const names = new Map<number, string>();
  let points = new Float64Array(3 * 1024), nets = new Int32Array(1024), count = 0, ignored = 0;
  eachLine(text, (raw, no) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || units.take(line, no)) return;
    const first = line.charCodeAt(0);
    if (first === 36) { // $<serial> <name>
      const space = line.search(/[ \t]/), serial = lines.integer(no, space < 0 ? line.slice(1) : line.slice(1, space), 'net serial number');
      if (names.size >= RECORD_LIMITS.nets) lines.fail(no, 'net count exceeds the import limit.', 'LIMIT_EXCEEDED');
      names.set(serial, space < 0 ? '' : line.slice(space + 1).trim());
      return;
    }
    if (first === 72 || first === 104) return; // H optimize ... header
    const parts = fields(line);
    if (!INTEGER.test(parts[0])) { ignored++; return; }
    if (count >= RECORD_LIMITS.netPoints) lines.fail(no, 'net point count exceeds the import limit.', 'LIMIT_EXCEEDED');
    const side = (parts[4] ?? '').toUpperCase();
    if (side !== 'T' && side !== 'D' && side !== 'B') lines.fail(no, 'net point side must be T, D or B.');
    if (count === nets.length) { const n = new Int32Array(count * 2); n.set(nets); nets = n; const p = new Float64Array(count * 6); p.set(points); points = p; }
    nets[count] = lines.integer(no, parts[0], 'net number');
    points[3 * count] = lines.decimal(no, parts[2], 'net point X'); points[3 * count + 1] = lines.decimal(no, parts[3], 'net point Y');
    points[3 * count + 2] = side === 'T' ? 0 : side === 'D' ? 1 : 2;
    lines.decimal(no, parts[1], 'net point radius');
    count++;
  });
  return { units: units.units, names, points: points.subarray(0, 3 * count), nets: nets.subarray(0, count), ignored };
}
