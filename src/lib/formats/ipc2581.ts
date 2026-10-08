/*
 * Original TRACE adapter, MIT. IPC-2581 (revisions B and C) board reader.
 *
 * Format facts: IPC-2581 is a paid IPC standard; no specification text or third-party code is included here. The element
 * and attribute names follow the public tables of contents of IPC-2581B/C and IPC-2581 files written by open tools; the
 * transform reading (mirror x → −x first, then counter-clockwise rotation, then the offset) was checked against such files.
 *
 * What is read (one Step):
 *   Ecad/CadHeader units (MILLIMETER, MICRON, INCH) · Layer side and layerFunction · Step/Package (Outline polygon, Pin
 *   number/name/type, Location, Xform, pad primitive) · Step/Component (refDes, packageRef, layerRef, Xform, Location) ·
 *   Step/LogicalNet PinRef · Step/PhyNetGroup/PhyNet PhyNetPoint (coordinates) · Step/LayerFeature Set/Pad PinRef on
 *   conductor layers (net, placed position, side) · Step/Profile (Polygon outer contour, Cutout) or BOARD_OUTLINE layer
 *   features · Content dictionaries (standard and user primitives) · Bom/BomItem RefDes and Characteristics (part value).
 *   Everything else (traces, planes, silkscreen, assembly drawings, stackup, AVL, DFx) is skipped without being built.
 *
 * Streaming and bounds: the document is read once by the bounded scanner of ipc2581-xml.ts. Only small fragments that
 * are needed (one Package, one Component, one Set without its traces, ...) are captured, converted to compact numbers as
 * soon as they close and dropped. Entities are never expanded; every list the reader keeps has a budget.
 */
import type { Board, BoardSide, ParseIssue, Point } from '../types';
import { BoardFormatError, buildBoard, decodeText, note, number, stitchOutlines, TextDecodeError, type FormatErrorCode, type ParseInput, type RawPart, type RawPin } from './common';
import { attribute, localName, XmlScanner, type XmlAttributes, type XmlHandler } from './ipc2581-xml';

export const IPC2581_FORMAT = 'IPC-2581';
export const IPC2581_NAMESPACE = 'http://webstds.ipc.org/2581';
/** Bytes read by the sniffer: enough for any realistic prolog (declaration, comments, DOCTYPE) plus the root start tag. */
export const IPC2581_SNIFF_BYTES = 64 * 1024;

/** Budgets for what the reader keeps; all are far above the largest open-tool exports seen (about 60 MB of XML). */
export const IPC2581_LIMITS = Object.freeze({
  components: 250_000,
  /** Pins after placing every component's package (checked before any pin is created). */
  placedPins: 1_000_000,
  /** Pin definitions over all packages. */
  packagePins: 1_000_000,
  /** PinRef entries kept from LogicalNet and conductor-layer pads. */
  pinRefs: 4_000_000,
  /** Points kept for the profile, package bodies, pad contours and physical-net points (arcs count after sampling). */
  points: 4_000_000,
  /** Board-outline layer segments (used only without a Profile; arcs count after sampling). */
  outlineSegments: 500_000,
  /** Dictionary entries and padstack definitions. */
  entries: 1_000_000,
  /** Elements kept in one captured fragment (one Package, one Set without its traces, one LogicalNet, ...). */
  fragmentNodes: 1_000_000,
});

const fail = (message: string, code: FormatErrorCode = 'INVALID_FORMAT') => new BoardFormatError(message, code, IPC2581_FORMAT);
const limit = (what: string, max: number) => fail(`IPC-2581 ${what} exceed the import limit of ${max.toLocaleString('en-US')}.`, 'LIMIT_EXCEEDED');

// ---------------------------------------------------------------------------------------------------------------------
// Sniffing

export interface Ipc2581Sniff {
  format: 'ipc2581';
  /**
   * 1 = IPC-2581 root in the IPC-2581 namespace with revision B or C; 0.9 = revision B or C without that namespace;
   * 0.7 = namespace but another or no revision; 0.6 = an IPC-2581 root element only. Anything else is not claimed (null).
   */
  confidence: number;
  revision?: string;
  namespace: boolean;
  /** The DOCTYPE declares entities: the file is IPC-2581 but is refused (entities are never expanded). */
  entities: boolean;
}

function head(data: Uint8Array, bytes: number): string {
  const slice = data.subarray(0, Math.min(data.length, bytes));
  if (slice[0] === 0xff && slice[1] === 0xfe) return new TextDecoder('utf-16le').decode(slice.subarray(0, slice.length & ~1));
  if (slice[0] === 0xfe && slice[1] === 0xff) return new TextDecoder('utf-16be').decode(slice.subarray(0, slice.length & ~1));
  return new TextDecoder('utf-8').decode(slice);
}

/** Bounded content sniff (the first 64 KiB only, linear): is this an IPC-2581 XML document, and how sure is that? */
export function sniffIpc2581(data: Uint8Array): Ipc2581Sniff | null {
  if (!(data instanceof Uint8Array) || data.length < 10) return null;
  let root: { name: string; attributes: XmlAttributes } | undefined, entities = false;
  const scanner: XmlScanner = new XmlScanner({
    open(name, attributes) { root = { name, attributes }; scanner.stop(); },
    close() { /* the root start tag stops the scan */ },
    doctype(doctype) { entities = doctype.entities; return true; },
  }, 'IPC-2581 XML');
  try { scanner.write(head(data, IPC2581_SNIFF_BYTES)); } catch (error) { if (error instanceof BoardFormatError) return null; throw error; }
  if (!root || localName(root.name) !== 'IPC-2581') return null;
  const prefix = root.name.includes(':') ? root.name.slice(0, root.name.indexOf(':')) : '';
  const namespace = attribute(root.attributes, prefix ? `xmlns:${prefix}` : 'xmlns') === IPC2581_NAMESPACE;
  const revisionText = attribute(root.attributes, 'revision')?.trim();
  const revision = revisionText && /^[A-Za-z0-9._-]{1,16}$/.test(revisionText) ? revisionText : undefined;
  const supported = revision !== undefined && /^[BC]\d*$/i.test(revision);
  return { format: 'ipc2581', confidence: supported ? (namespace ? 1 : 0.9) : namespace ? 0.7 : 0.6, ...(revision ? { revision } : {}), namespace, entities };
}

// ---------------------------------------------------------------------------------------------------------------------
// Captured fragments

interface XNode { name: string; attrs: XmlAttributes; children: XNode[] }
const PRIMITIVES = new Set(['Butterfly', 'Circle', 'Contour', 'Diamond', 'Donut', 'Ellipse', 'Hexagon', 'Moire', 'Octagon', 'Oval', 'RectCenter', 'RectCham', 'RectCorner', 'RectRound', 'Thermal', 'Triangle']);
const POLY = ['Polygon', 'Polyline', 'PolyBegin', 'PolyStepSegment', 'PolyStepCurve', 'Cutout', 'Line', 'Arc'];
const SHAPE_REFS = ['StandardPrimitiveRef', 'UserPrimitiveRef'];
const SHAPE_NODES = [...PRIMITIVES, ...POLY, 'UserSpecial', ...SHAPE_REFS];
const ALLOW = {
  entry: new Set(SHAPE_NODES),
  padstack: new Set(['PadstackPadDef', 'Location', 'Xform', ...SHAPE_NODES]),
  profile: new Set(['Polygon', 'Cutout', 'PolyBegin', 'PolyStepSegment', 'PolyStepCurve']),
  package: new Set(['Outline', 'Pin', 'Location', 'Xform', ...SHAPE_NODES]),
  component: new Set(['Xform', 'Location']),
  logical: new Set(['PinRef']),
  physical: new Set(['PhyNetPoint']),
  copper: new Set(['Pad', 'Xform', 'Location', 'PinRef', ...SHAPE_NODES]),
  outline: new Set(['Features', 'Location', 'UserSpecial', 'Line', 'Arc', 'Polyline', 'Polygon', 'PolyBegin', 'PolyStepSegment', 'PolyStepCurve', 'Circle']),
  bom: new Set(['RefDes', 'Characteristics', 'Textual', 'Measured']),
} as const;
type CaptureKind = 'std' | 'user' | 'padstack' | 'profile' | 'package' | 'component' | 'logical' | 'physical' | 'copper' | 'outline' | 'bom';

class Capture {
  readonly root: XNode;
  private readonly stack: XNode[];
  private skip = 0;
  private nodes = 1;
  constructor(readonly kind: CaptureKind, name: string, attrs: XmlAttributes, private readonly allow: ReadonlySet<string>, readonly context: string | undefined) {
    this.root = { name, attrs, children: [] };
    this.stack = [this.root];
  }
  open(name: string, attrs: XmlAttributes): void {
    if (this.skip) { this.skip++; return; }
    if (!this.allow.has(name)) { this.skip = 1; return; }
    if (++this.nodes > IPC2581_LIMITS.fragmentNodes) throw limit(`elements in one <${this.root.name}>`, IPC2581_LIMITS.fragmentNodes);
    const node: XNode = { name, attrs, children: [] };
    this.stack[this.stack.length - 1].children.push(node);
    this.stack.push(node);
  }
  /** True when the captured element itself closed. */
  close(): boolean {
    if (this.skip) { this.skip--; return false; }
    this.stack.pop();
    return this.stack.length === 0;
  }
}

const text = (node: XNode, name: string): string | undefined => attribute(node.attrs, name);
const child = (node: XNode, name: string): XNode | undefined => node.children.find(item => item.name === name);
const num = (node: XNode, name: string, context: string): number => number(text(node, name), `IPC-2581 ${context} ${name}`);
const optional = (node: XNode, name: string, context: string, fallback: number): number => text(node, name) === undefined ? fallback : num(node, name, context);
const flag = (value: string | undefined): boolean => value === 'true' || value === '1';

// ---------------------------------------------------------------------------------------------------------------------
// Geometry helpers (raw file units until assembly)

interface Extents { minX: number; minY: number; maxX: number; maxY: number }
interface PadShape { kind: 'round' | 'rect' | 'square'; width: number; height: number; exact: boolean }
interface ShapeRef { std?: string; user?: string; inline?: PadShape }
interface Xf { rotation: number; mirror: boolean; scale: number; dx: number; dy: number }
const IDENTITY: Xf = { rotation: 0, mirror: false, scale: 1, dx: 0, dy: 0 };
const ARC_STEP = Math.PI / 32;
const angle = (value: number) => { const result = ((value % 360) + 360) % 360; return result === 0 ? 0 : result; };

/** Cosine and sine of an angle in degrees, exact at multiples of 90°. */
function cosSin(degrees: number): [number, number] {
  const turns = degrees / 90;
  if (Number.isInteger(turns)) { const q = ((turns % 4) + 4) % 4; return [[1, 0, -1, 0][q], [0, 1, 0, -1][q]]; }
  const radians = degrees * Math.PI / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

function xform(node: XNode | undefined, context: string): Xf {
  if (!node) return IDENTITY;
  const scale = optional(node, 'scale', `${context} Xform`, 1);
  if (!(scale > 0)) throw fail(`IPC-2581 ${context} Xform scale must be positive.`);
  return { rotation: optional(node, 'rotation', `${context} Xform`, 0), mirror: flag(text(node, 'mirror')), scale, dx: optional(node, 'xOffset', `${context} Xform`, 0), dy: optional(node, 'yOffset', `${context} Xform`, 0) };
}
/** Local → parent: scale, mirror (x → −x), counter-clockwise rotation, offset, then the element's location. */
function place(local: Point, xf: Xf, at: Point): Point {
  const [c, s] = cosSin(xf.rotation);
  const x = (xf.mirror ? -local.x : local.x) * xf.scale, y = local.y * xf.scale;
  return { x: at.x + xf.dx + x * c - y * s, y: at.y + xf.dy + x * s + y * c };
}

/** Points after `from` up to `to` along an arc around `center`; a closed arc (from = to) is a full circle. */
function arcPoints(from: Point, to: Point, center: Point, clockwise: boolean): Point[] {
  const r0 = Math.hypot(from.x - center.x, from.y - center.y), r1 = Math.hypot(to.x - center.x, to.y - center.y);
  if (!(r0 > 0) || !(r1 > 0)) return [to];
  const start = Math.atan2(from.y - center.y, from.x - center.x);
  let sweep = Math.atan2(to.y - center.y, to.x - center.x) - start;
  if (Math.hypot(to.x - from.x, to.y - from.y) <= 1e-9 * Math.max(1, r0)) sweep = clockwise ? -2 * Math.PI : 2 * Math.PI;
  else if (clockwise) { if (sweep >= 0) sweep -= 2 * Math.PI; }
  else if (sweep <= 0) sweep += 2 * Math.PI;
  const steps = Math.max(2, Math.min(4096, Math.ceil(Math.abs(sweep) / ARC_STEP))), points: Point[] = [];
  for (let index = 1; index < steps; index++) {
    const t = index / steps, a = start + sweep * t, r = r0 + (r1 - r0) * t;
    points.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  points.push(to);
  return points;
}

const point = (node: XNode, context: string, xName = 'x', yName = 'y'): Point => ({ x: num(node, xName, context), y: num(node, yName, context) });

type BudgetKind = 'points' | 'outlineSegments' | 'pinRefs' | 'entries' | 'packagePins' | 'components';
class Budget {
  points = 0; outlineSegments = 0; pinRefs = 0; entries = 0; packagePins = 0; components = 0;
  spend(kind: BudgetKind, amount: number, what: string): void {
    this[kind] += amount;
    if (this[kind] > IPC2581_LIMITS[kind]) throw limit(what, IPC2581_LIMITS[kind]);
  }
  /** Throws as soon as `pending` more items would break the budget, so a list is never built far past its bound before the check. */
  check(kind: BudgetKind, pending: number, what: string): void {
    if (this[kind] + pending > IPC2581_LIMITS[kind]) throw limit(what, IPC2581_LIMITS[kind]);
  }
}

/** PolyBegin then PolyStepSegment / PolyStepCurve steps, as points (curves sampled). */
function polyPoints(node: XNode, context: string, budget: Budget, arcs: { count: number }): Point[] {
  const points: Point[] = [], what = 'outline and contour points';
  let current: Point | undefined;
  for (const step of node.children) {
    if (step.name === 'PolyBegin') {
      if (current) throw fail(`IPC-2581 ${context} has a second PolyBegin.`);
      current = point(step, `${context} PolyBegin`); points.push(current);
    } else if (step.name === 'PolyStepSegment' || step.name === 'PolyStepCurve') {
      if (!current) throw fail(`IPC-2581 ${context} has a step before its PolyBegin.`);
      const next = point(step, `${context} ${step.name}`);
      if (step.name === 'PolyStepSegment') points.push(next);
      else { arcs.count++; for (const sample of arcPoints(current, next, point(step, `${context} PolyStepCurve`, 'centerX', 'centerY'), flag(text(step, 'clockwise')))) points.push(sample); }
      current = next;
      budget.check('points', points.length, what);
    }
  }
  budget.spend('points', points.length, what);
  return points;
}
/** A closed loop without its repeated closing vertex. */
function loop(points: Point[]): Point[] {
  const last = points[points.length - 1];
  return points.length > 1 && last.x === points[0].x && last.y === points[0].y ? points.slice(0, -1) : points;
}
const grow = (e: Extents, p: Point) => { e.minX = Math.min(e.minX, p.x); e.minY = Math.min(e.minY, p.y); e.maxX = Math.max(e.maxX, p.x); e.maxY = Math.max(e.maxY, p.y); };
const centered = (w: number, h: number): Extents => ({ minX: -w / 2, minY: -h / 2, maxX: w / 2, maxY: h / 2 });
const positive = (node: XNode, name: string, context: string): number => {
  const value = num(node, name, context);
  if (value < 0) throw fail(`IPC-2581 ${context} ${name} must not be negative.`);
  return value;
};

/** The extent and drawing kind of one standard primitive or user shape, in its own units. */
function primitive(node: XNode, context: string, budget: Budget): { extents: Extents; kind: PadShape['kind']; exact: boolean } {
  const ctx = `${context} ${node.name}`;
  switch (node.name) {
    case 'Circle': { const d = positive(node, 'diameter', ctx); return { extents: centered(d, d), kind: 'round', exact: true }; }
    case 'RectCenter': { const w = positive(node, 'width', ctx), h = positive(node, 'height', ctx); return { extents: centered(w, h), kind: w === h ? 'square' : 'rect', exact: true }; }
    case 'RectRound': { const w = positive(node, 'width', ctx), h = positive(node, 'height', ctx), r = optional(node, 'radius', ctx, 0); return { extents: centered(w, h), kind: w === h ? 'square' : 'rect', exact: !(r > 0) }; }
    case 'RectCham': case 'Diamond': { const w = positive(node, 'width', ctx), h = positive(node, 'height', ctx); return { extents: centered(w, h), kind: 'rect', exact: false }; }
    case 'Oval': case 'Ellipse': { const w = positive(node, 'width', ctx), h = positive(node, 'height', ctx); return { extents: centered(w, h), kind: w === h ? 'round' : 'rect', exact: w === h }; }
    case 'RectCorner': {
      const lo = point(node, ctx, 'lowerLeftX', 'lowerLeftY'), hi = point(node, ctx, 'upperRightX', 'upperRightY');
      const extents = { minX: Math.min(lo.x, hi.x), minY: Math.min(lo.y, hi.y), maxX: Math.max(lo.x, hi.x), maxY: Math.max(lo.y, hi.y) };
      return { extents, kind: 'rect', exact: Math.abs(extents.minX + extents.maxX) < 1e-12 && Math.abs(extents.minY + extents.maxY) < 1e-12 };
    }
    case 'Donut': case 'Thermal': { const d = positive(node, 'outerDiameter', ctx); return { extents: centered(d, d), kind: text(node, 'shape') === 'SQUARE' ? 'square' : 'round', exact: false }; }
    case 'Butterfly': { const square = text(node, 'shape') === 'SQUARE', d = positive(node, square ? 'side' : 'diameter', ctx); return { extents: centered(d, d), kind: square ? 'square' : 'round', exact: false }; }
    case 'Moire': { const d = positive(node, 'diameter', ctx); return { extents: centered(d, d), kind: 'round', exact: false }; }
    case 'Hexagon': case 'Octagon': { const d = positive(node, 'length', ctx); return { extents: centered(d, d), kind: 'square', exact: false }; }
    case 'Triangle': { const w = positive(node, 'base', ctx), h = positive(node, 'height', ctx); return { extents: centered(w, h), kind: 'rect', exact: false }; }
    case 'Contour': {
      const polygon = child(node, 'Polygon');
      if (!polygon) throw fail(`IPC-2581 ${ctx} has no Polygon.`);
      const extents = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const p of polyPoints(polygon, ctx, budget, { count: 0 })) grow(extents, p);
      if (!Number.isFinite(extents.minX)) throw fail(`IPC-2581 ${ctx} has an empty Polygon.`);
      return { extents, kind: 'rect', exact: false };
    }
    case 'UserSpecial': {
      const extents = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      const visit = (container: XNode) => {
        for (const item of container.children) {
          if (PRIMITIVES.has(item.name) || item.name === 'UserSpecial') { const inner = primitive(item, context, budget).extents; grow(extents, { x: inner.minX, y: inner.minY }); grow(extents, { x: inner.maxX, y: inner.maxY }); }
          else if (item.name === 'Line') { grow(extents, point(item, `${ctx} Line`, 'startX', 'startY')); grow(extents, point(item, `${ctx} Line`, 'endX', 'endY')); }
          else if (item.name === 'Arc') {
            const from = point(item, `${ctx} Arc`, 'startX', 'startY'), to = point(item, `${ctx} Arc`, 'endX', 'endY');
            grow(extents, from);
            for (const p of arcPoints(from, to, point(item, `${ctx} Arc`, 'centerX', 'centerY'), flag(text(item, 'clockwise')))) grow(extents, p);
          } else if (item.name === 'Polyline' || item.name === 'Polygon') for (const p of polyPoints(item, ctx, budget, { count: 0 })) grow(extents, p);
        }
      };
      visit(node);
      if (!Number.isFinite(extents.minX)) throw fail(`IPC-2581 ${ctx} has no geometry.`);
      return { extents, kind: 'rect', exact: false };
    }
    default: throw fail(`IPC-2581 ${ctx} is not a supported pad primitive.`);
  }
}
/** Drawn around the pad origin: an off-centre shape is covered by a rectangle symmetric about the origin (approximated). */
function padShape(node: XNode, context: string, budget: Budget): PadShape {
  const { extents, kind, exact } = primitive(node, context, budget);
  const halfW = Math.max(Math.abs(extents.minX), Math.abs(extents.maxX)), halfH = Math.max(Math.abs(extents.minY), Math.abs(extents.maxY));
  const offCentre = Math.abs(extents.minX + extents.maxX) > 1e-9 * Math.max(1, halfW) || Math.abs(extents.minY + extents.maxY) > 1e-9 * Math.max(1, halfH);
  const drawn = offCentre ? (halfW === halfH ? 'square' : 'rect') : kind === 'round' && halfW !== halfH ? 'rect' : kind;
  return { kind: drawn, width: 2 * halfW, height: 2 * halfH, exact: exact && !offCentre };
}
/** The pad shape a Pin, Pad or PadstackPadDef names (reference) or carries (inline primitive). */
function shapeOf(node: XNode, context: string, budget: Budget): ShapeRef | undefined {
  for (const item of node.children) {
    if (item.name === 'StandardPrimitiveRef') return { std: text(item, 'id') ?? '' };
    if (item.name === 'UserPrimitiveRef') return { user: text(item, 'id') ?? '' };
    if (PRIMITIVES.has(item.name) || item.name === 'UserSpecial') return { inline: padShape(item, context, budget) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reader state

/** `electrical`: the pin's electricalType is ELECTRICAL or absent (MECHANICAL and UNDEFINED pins are holes, tabs, fiducials, apertures). */
interface PackagePin { number: string; name?: string; type: string; electrical: boolean; at: Point; xf: Xf; shape?: ShapeRef }
interface PackageDef { outline: Point[]; pins: PackagePin[] }
interface ComponentDef { refDes: string; packageRef: string; layerRef: string; mountType: string; at: Point; xf: Xf }
interface CopperPad { layerRef: string; net: string; at: Point; xf: Xf; shape?: ShapeRef; padstack: string; refs: string[] }
interface PadstackPad { at: Point; xf: Xf; shape?: ShapeRef }
interface StepData {
  name: string; type: string;
  packages: Map<string, PackageDef>; components: ComponentDef[];
  logical: Array<{ name: string; refs: string[] }>; physical: Array<{ name: string; points: Point[] }>;
  pads: CopperPad[]; padstacks: Map<string, Map<string, PadstackPad>>;
  profile: Point[][]; outlineSegments: Array<[Point, Point]>; outlineArcs: number; profileArcs: number;
}
interface Layer { side: string; fn: string }
interface BomEntry { value: string; packageRef: string; populate: boolean }
const CONDUCTOR = new Set(['CONDUCTOR', 'SIGNAL', 'PLANE', 'MIXED', 'CONDFILM', 'CONDFOIL']);
const UNIT_MM: Readonly<Record<string, number>> = { MILLIMETER: 1, MICRON: 0.001, INCH: 25.4 };
/** Lookup key of one component pin: the reference designator (outer blanks removed) and the pin number as written. */
const pinKey = (ref: string | undefined, pin: string | undefined): string => `${(ref ?? '').trim()}\u0000${pin ?? ''}`;

class Reader implements XmlHandler {
  private readonly path: string[] = [];
  private capture: Capture | null = null;
  private dictionaryUnits: string | undefined;
  private step: StepData | null = null;
  private layerFeature: { layerRef: string; kind: 'copper' | 'outline' | 'other' } | null = null;
  readonly budget = new Budget();
  functionMode?: string;
  cadUnits?: string;
  cadHeaders = 0;
  readonly stepRefs = new Set<string>();
  readonly std = new Map<string, { shape: PadShape; units?: string }>();
  readonly user = new Map<string, { shape: PadShape; units?: string }>();
  readonly layers = new Map<string, Layer>();
  readonly bom = new Map<string, BomEntry>();
  readonly steps: StepData[] = [];
  private readonly stepNames = new Set<string>();

  open(raw: string, attrs: XmlAttributes): void {
    const name = raw.indexOf(':') < 0 ? raw : localName(raw);
    if (this.capture) { this.capture.open(name, attrs); return; }
    const parent = this.path[this.path.length - 1];
    this.path.push(name);
    const step = this.step;
    switch (name) {
      case 'FunctionMode': if (parent === 'Content') this.functionMode = attribute(attrs, 'mode'); return;
      case 'StepRef': if (parent === 'Content') { const ref = attribute(attrs, 'name'); if (ref !== undefined) this.stepRefs.add(ref); } return;
      case 'DictionaryStandard': case 'DictionaryUser': if (parent === 'Content') this.dictionaryUnits = attribute(attrs, 'units'); return;
      case 'EntryStandard': if (parent === 'DictionaryStandard') this.begin('std', name, attrs, ALLOW.entry, this.dictionaryUnits); return;
      case 'EntryUser': if (parent === 'DictionaryUser') this.begin('user', name, attrs, ALLOW.entry, this.dictionaryUnits); return;
      case 'BomItem': if (parent === 'Bom') this.begin('bom', name, attrs, ALLOW.bom); return;
      case 'CadHeader': if (parent === 'Ecad') { this.cadUnits = attribute(attrs, 'units'); this.cadHeaders++; } return;
      case 'Layer': if (parent === 'CadData') { const layerName = attribute(attrs, 'name'); if (layerName !== undefined && !this.layers.has(layerName)) this.layers.set(layerName, { side: (attribute(attrs, 'side') ?? '').toUpperCase(), fn: (attribute(attrs, 'layerFunction') ?? '').toUpperCase() }); } return;
      case 'Step':
        if (parent === 'CadData') {
          const stepName = attribute(attrs, 'name') ?? '';
          if (this.stepNames.has(stepName)) throw fail(`IPC-2581 declares the step "${stepName.slice(0, 80)}" twice.`);
          this.step = { name: stepName, type: (attribute(attrs, 'type') ?? '').toUpperCase(), packages: new Map(), components: [], logical: [], physical: [], pads: [], padstacks: new Map(), profile: [], outlineSegments: [], outlineArcs: 0, profileArcs: 0 };
          this.steps.push(this.step);
          this.stepNames.add(stepName);
        }
        return;
      default: break;
    }
    if (!step) return;
    if (parent === 'Step') {
      switch (name) {
        case 'PadStackDef': this.begin('padstack', name, attrs, ALLOW.padstack); return;
        case 'Profile': this.begin('profile', name, attrs, ALLOW.profile); return;
        case 'Package': this.begin('package', name, attrs, ALLOW.package); return;
        case 'Component': this.begin('component', name, attrs, ALLOW.component); return;
        case 'LogicalNet': this.begin('logical', name, attrs, ALLOW.logical); return;
        case 'LayerFeature': {
          const layerRef = attribute(attrs, 'layerRef') ?? '', layer = this.layers.get(layerRef);
          // A layer missing from the layer table may still carry nets: its pads are read, but they give no side.
          const kind = !layer || CONDUCTOR.has(layer.fn) ? 'copper' : layer.fn === 'BOARD_OUTLINE' ? 'outline' : 'other';
          this.layerFeature = { layerRef, kind };
          return;
        }
        default: return;
      }
    }
    if (name === 'PhyNet' && parent === 'PhyNetGroup' && this.path[this.path.length - 3] === 'Step') this.begin('physical', name, attrs, ALLOW.physical);
    else if (name === 'Set' && parent === 'LayerFeature' && this.layerFeature && this.layerFeature.kind !== 'other') {
      // The board-outline layer is only a fallback: once the step has a Profile its features are not built.
      if (this.layerFeature.kind === 'outline' && step.profile.length) return;
      this.begin(this.layerFeature.kind, name, attrs, this.layerFeature.kind === 'copper' ? ALLOW.copper : ALLOW.outline, this.layerFeature.layerRef);
    }
  }

  close(): void {
    if (this.capture) {
      if (this.capture.close()) { const done = this.capture; this.capture = null; this.finishCapture(done); }
      return;
    }
    const name = this.path.pop();
    if (name === 'Step') this.step = null;
    else if (name === 'LayerFeature') this.layerFeature = null;
    else if (name === 'DictionaryStandard' || name === 'DictionaryUser') this.dictionaryUnits = undefined;
  }

  private begin(kind: CaptureKind, name: string, attrs: XmlAttributes, allow: ReadonlySet<string>, context?: string): void {
    this.path.pop(); // a captured element is tracked by its capture, not by the path
    this.capture = new Capture(kind, name, attrs, allow, context);
  }

  private finishCapture(capture: Capture): void {
    const node = capture.root, step = this.step, budget = this.budget;
    switch (capture.kind) {
      case 'std': case 'user': {
        const id = text(node, 'id') ?? '', target = capture.kind === 'std' ? this.std : this.user;
        budget.spend('entries', 1, 'dictionary entries');
        const shapeNode = node.children.find(item => PRIMITIVES.has(item.name) || item.name === 'UserSpecial');
        if (!shapeNode || target.has(id)) return; // an entry without a pad primitive (line or fill descriptions) is not a pad shape
        target.set(id, { shape: padShape(shapeNode, `dictionary entry ${id.slice(0, 40)}`, budget), units: capture.context });
        return;
      }
      case 'bom': {
        let value = '';
        for (const characteristics of node.children) {
          if (characteristics.name !== 'Characteristics') continue;
          for (const item of characteristics.children) {
            if (item.name === 'Textual' && !value && /^value$/i.test(text(item, 'textualCharacteristicName') ?? '')) value = (text(item, 'textualCharacteristicValue') ?? '').trim();
          }
          if (!value) {
            const measured = characteristics.children.find(item => item.name === 'Measured' && text(item, 'measuredCharacteristicValue'));
            if (measured) value = `${text(measured, 'measuredCharacteristicValue')!.trim()} ${(text(measured, 'engineeringUnitOfMeasure') ?? '').trim()}`.trim();
          }
        }
        for (const ref of node.children) {
          if (ref.name !== 'RefDes') continue;
          const refName = text(ref, 'name')?.trim();
          if (!refName || this.bom.has(refName)) continue;
          this.bom.set(refName, { value, packageRef: text(ref, 'packageRef') ?? '', populate: text(ref, 'populate') !== 'false' });
        }
        return;
      }
      default: break;
    }
    if (!step) return;
    switch (capture.kind) {
      case 'padstack': {
        const name = text(node, 'name') ?? '', layers = new Map<string, PadstackPad>();
        budget.spend('entries', 1, 'padstack definitions');
        for (const pad of node.children) {
          if (pad.name !== 'PadstackPadDef') continue;
          // Anti-pads (plane clearances) and thermal reliefs are not the pad; only the regular pad of each layer is kept.
          const use = (text(pad, 'padUse') ?? 'REGULAR').trim().toUpperCase();
          if (use !== 'REGULAR' && use !== '') continue;
          const layerRef = text(pad, 'layerRef') ?? '', location = child(pad, 'Location');
          if (!layers.has(layerRef)) layers.set(layerRef, { at: location ? point(location, `padstack ${name.slice(0, 40)} Location`) : { x: 0, y: 0 }, xf: xform(child(pad, 'Xform'), `padstack ${name.slice(0, 40)}`), shape: shapeOf(pad, `padstack ${name.slice(0, 40)}`, budget) });
        }
        if (!step.padstacks.has(name)) step.padstacks.set(name, layers);
        return;
      }
      case 'profile': {
        const arcs = { count: 0 };
        for (const item of node.children) {
          if (item.name !== 'Polygon' && item.name !== 'Cutout') continue;
          const points = loop(polyPoints(item, `Profile ${item.name}`, budget, arcs));
          if (points.length >= 3) step.profile.push(points);
        }
        step.profileArcs += arcs.count;
        return;
      }
      case 'package': {
        const name = text(node, 'name') ?? '';
        if (step.packages.has(name)) throw fail(`IPC-2581 step declares the package "${name.slice(0, 80)}" twice.`);
        const context = `package ${name.slice(0, 40)}`, outlineNode = child(node, 'Outline'), polygon = outlineNode && child(outlineNode, 'Polygon');
        const outline = polygon ? loop(polyPoints(polygon, `${context} Outline`, budget, { count: 0 })) : [];
        const pins: PackagePin[] = [];
        for (const pin of node.children) {
          if (pin.name !== 'Pin') continue;
          const location = child(pin, 'Location'), number = text(pin, 'number') ?? '';
          const pinContext = `${context} pin ${number.slice(0, 20)}`;
          if (!location) throw fail(`IPC-2581 ${pinContext} has no Location.`);
          const electricalType = (text(pin, 'electricalType') ?? '').trim().toUpperCase();
          pins.push({ number, name: text(pin, 'name'), type: (text(pin, 'type') ?? '').toUpperCase(), electrical: electricalType === '' || electricalType === 'ELECTRICAL',
            at: point(location, `${pinContext} Location`), xf: xform(child(pin, 'Xform'), pinContext), shape: shapeOf(pin, pinContext, budget) });
        }
        budget.spend('packagePins', pins.length, 'package pin definitions');
        step.packages.set(name, { outline, pins });
        return;
      }
      case 'component': {
        const refDes = text(node, 'refDes') ?? '', location = child(node, 'Location'), context = `component ${refDes.slice(0, 40)}`;
        if (!location) throw fail(`IPC-2581 ${context} has no Location.`);
        budget.spend('components', 1, 'components');
        step.components.push({ refDes, packageRef: text(node, 'packageRef') ?? '', layerRef: text(node, 'layerRef') ?? '', mountType: (text(node, 'mountType') ?? '').toUpperCase(), at: point(location, `${context} Location`), xf: xform(child(node, 'Xform'), context) });
        return;
      }
      case 'logical': {
        const refs: string[] = [];
        for (const ref of node.children) refs.push(pinKey(text(ref, 'componentRef'), text(ref, 'pin')));
        budget.spend('pinRefs', refs.length, 'pin references');
        step.logical.push({ name: text(node, 'name') ?? '', refs });
        return;
      }
      case 'physical': {
        const points = node.children.map(item => point(item, 'PhyNetPoint'));
        budget.spend('points', points.length, 'physical net points');
        step.physical.push({ name: text(node, 'name') ?? '', points });
        return;
      }
      case 'copper': {
        const net = text(node, 'net') ?? '', layerRef = capture.context ?? '';
        for (const pad of node.children) {
          if (pad.name !== 'Pad') continue;
          const refs: string[] = [];
          for (const ref of pad.children) if (ref.name === 'PinRef') refs.push(pinKey(text(ref, 'componentRef'), text(ref, 'pin')));
          if (!refs.length) continue; // vias and free pads belong to no component pin
          const location = child(pad, 'Location');
          if (!location) throw fail(`IPC-2581 pad on layer ${layerRef.slice(0, 40)} has no Location.`);
          budget.spend('pinRefs', refs.length, 'pin references');
          step.pads.push({ layerRef, net, at: point(location, 'Pad Location'), xf: xform(child(pad, 'Xform'), 'Pad'), shape: shapeOf(pad, `pad on layer ${layerRef.slice(0, 40)}`, budget), padstack: text(pad, 'padstackDefRef') ?? '', refs });
        }
        return;
      }
      case 'outline': {
        const arcs = { count: 0 }, segments = step.outlineSegments, before = segments.length;
        const addPath = (points: Point[], offset: Point) => {
          for (let index = 1; index < points.length; index++) segments.push([{ x: points[index - 1].x + offset.x, y: points[index - 1].y + offset.y }, { x: points[index].x + offset.x, y: points[index].y + offset.y }]);
          budget.check('outlineSegments', segments.length - before, 'board-outline segments');
        };
        const visit = (container: XNode, offset: Point) => {
          for (const item of container.children) {
            const ctx = `outline ${item.name}`;
            if (item.name === 'UserSpecial') visit(item, offset);
            else if (item.name === 'Line') addPath([point(item, ctx, 'startX', 'startY'), point(item, ctx, 'endX', 'endY')], offset);
            else if (item.name === 'Arc') {
              const from = point(item, ctx, 'startX', 'startY');
              arcs.count++; addPath([from, ...arcPoints(from, point(item, ctx, 'endX', 'endY'), point(item, ctx, 'centerX', 'centerY'), flag(text(item, 'clockwise')))], offset);
            } else if (item.name === 'Polyline') addPath(polyPoints(item, ctx, budget, arcs), offset);
            else if (item.name === 'Polygon') { const points = loop(polyPoints(item, ctx, budget, arcs)); addPath([...points, points[0]], offset); }
            else if (item.name === 'Circle') {
              const radius = positive(item, 'diameter', ctx) / 2, start = { x: radius, y: 0 };
              arcs.count++; addPath([start, ...arcPoints(start, start, { x: 0, y: 0 }, false)], offset);
            }
          }
        };
        for (const features of node.children) {
          if (features.name !== 'Features') continue;
          const location = child(features, 'Location');
          visit(features, location ? point(location, 'outline Features Location') : { x: 0, y: 0 });
        }
        budget.spend('outlineSegments', segments.length - before, 'board-outline segments');
        step.outlineArcs += arcs.count;
        return;
      }
      default: return;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Assembly

/** KiCad's single-pad no-connect names; its IPC-2581 export writes the parentheses as underscores ("unconnected-_R1-Pad2_"). */
const PLACEHOLDER_NET = /^unconnected-[(_].+[)_](?:_\d+)?$/;
const POSITION_TOLERANCE_MM = 0.01;
const PHYSICAL_TOLERANCE_MM = 0.005;
const OUTLINE_CLOSURE_MM = 0.01;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;


/** The pins of one pin key (reference designator and pin number): slots in `work`, a grid of their positions, the first slot that may still lack a conductor pad, and whether the key names pins of several components. */
interface PinSlots { slots: number[]; cells: Map<string, number[]>; free: number; ambiguous: boolean }
/** Entries looked at per grid cell, and candidates per nearest-pin search (bounds for degenerate files, see the binding passes). */
const CELL_SCAN = 32, NEAREST_SCAN = 64;

interface WorkPin {
  raw: RawPin; component: number; placed: Point; approximated: boolean; top: boolean; bottom: boolean; electrical: boolean;
  copperAt?: Point; copperShape?: { shape: PadShape; rotation: number };
  logical?: string; copper?: string; physical?: string;
}

/** Drawing fields of a pad shape in millimetres; none for a zero-size shape (the pad is then drawn as a marker). */
function shapeFields(shape: PadShape, rotation: number): Partial<RawPin> {
  if (!(shape.width > 0) && !(shape.height > 0)) return {};
  return { shape: shape.kind, width: shape.width, height: shape.height, radius: shape.kind === 'round' ? shape.width / 2 : Math.min(shape.width, shape.height) / 2, rotation };
}

function chooseStep(reader: Reader, warnings: ParseIssue[]): StepData {
  const candidates = reader.steps.filter(step => step.components.length);
  if (!candidates.length) {
    throw fail(`IPC-2581 file contains no placed components${reader.functionMode ? ` (FunctionMode ${reader.functionMode.slice(0, 40)})` : ''}; only files with assembly data (Component elements) can be shown as a board.`);
  }
  const chosen = candidates.find(step => reader.stepRefs.has(step.name) && step.type !== 'PANEL') ?? candidates.find(step => step.type === 'BOARD')
    ?? candidates.reduce((best, step) => step.components.length > best.components.length ? step : best);
  if (candidates.length > 1) warnings.push(note(`${plural(candidates.length - 1, 'other IPC-2581 step')} with components ${candidates.length === 2 ? 'was' : 'were'} not read; step "${chosen.name.slice(0, 80)}" is shown.`));
  return chosen;
}

function finish(reader: Reader, input: ParseInput, sniff: Ipc2581Sniff): Board {
  const warnings: ParseIssue[] = [];
  const revision = sniff.revision;
  if (!revision || !/^[BC]\d*$/i.test(revision)) warnings.push(note(`IPC-2581 ${revision ? `revision ${revision}` : 'without a revision attribute'} was read with the revision B/C rules; only revisions B and C are verified.`));
  const format = revision ? `${IPC2581_FORMAT} rev. ${revision}` : IPC2581_FORMAT;
  if (reader.cadUnits === undefined) throw fail(reader.cadHeaders ? 'IPC-2581 CadHeader has no units attribute.' : 'IPC-2581 file has no Ecad/CadHeader, so its units are unknown.');
  const scale = UNIT_MM[reader.cadUnits.trim().toUpperCase()];
  if (scale === undefined) throw fail(`IPC-2581 units "${reader.cadUnits.slice(0, 40)}" are not supported (MILLIMETER, MICRON or INCH).`, 'UNSUPPORTED_VARIANT');
  if (reader.cadHeaders > 1) warnings.push(note('IPC-2581 file has more than one CadHeader; the units of the last one are used.'));
  const step = chooseStep(reader, warnings);
  const mm = (p: Point): Point => ({ x: p.x * scale, y: p.y * scale });
  const unitScale = (units: string | undefined): number => {
    if (units === undefined || !units.trim()) return scale;
    const factor = UNIT_MM[units.trim().toUpperCase()];
    if (factor === undefined) throw fail(`IPC-2581 dictionary units "${units.slice(0, 40)}" are not supported (MILLIMETER, MICRON or INCH).`, 'UNSUPPORTED_VARIANT');
    return factor;
  };
  let unresolvedShapes = 0;
  /** A pad shape in millimetres (local dimensions), or undefined when there is none or the reference cannot be resolved. */
  const resolve = (ref: ShapeRef | undefined, factor: number): PadShape | undefined => {
    if (!ref) return undefined;
    let shape: PadShape, units: number;
    if (ref.inline) { shape = ref.inline; units = scale; }
    else {
      const entry = ref.std !== undefined ? reader.std.get(ref.std) : reader.user.get(ref.user ?? '');
      if (!entry) { unresolvedShapes++; return undefined; }
      shape = entry.shape; units = unitScale(entry.units);
    }
    return { ...shape, width: shape.width * units * factor, height: shape.height * units * factor };
  };
  /** Component side and the side of conductor pads, from the layer table. */
  const layerSide = (layerRef: string): 'top' | 'bottom' | 'inner' | undefined => {
    const layer = reader.layers.get(layerRef);
    if (!layer) return undefined;
    if (layer.side === 'TOP' || layer.fn === 'COMPONENT_TOP') return 'top';
    if (layer.side === 'BOTTOM' || layer.fn === 'COMPONENT_BOTTOM') return 'bottom';
    return layer.side === 'INTERNAL' ? 'inner' : undefined;
  };

  // Preflight: the placed pin count grows as components × package pins, so it is summed before any pin is created.
  let planned = 0;
  for (const component of step.components) planned += step.packages.get(component.packageRef)?.pins.length ?? 0;
  if (planned > IPC2581_LIMITS.placedPins) throw fail(`IPC-2581 board expands to ${planned} pins; the import limit is ${IPC2581_LIMITS.placedPins}.`, 'LIMIT_EXCEEDED');

  const parts: RawPart[] = [], work: WorkPin[] = [], byRef = new Map<string, PinSlots>(), refCounts = new Map<string, number>();
  let missingPackages = 0, sideFromMirror = 0, sideConflicts = 0, generatedRefs = 0, transformExtras = 0, unpopulated = 0;
  step.components.forEach((component, index) => {
    const pkg = step.packages.get(component.packageRef), xf = component.xf, at = component.at;
    if (!pkg) missingPackages++;
    if (xf.scale !== 1 || xf.dx !== 0 || xf.dy !== 0) transformExtras++;
    const fromLayer = layerSide(component.layerRef);
    let side: BoardSide;
    if (fromLayer === 'top' || fromLayer === 'bottom') { side = fromLayer; if ((fromLayer === 'bottom') !== xf.mirror) sideConflicts++; }
    else { side = xf.mirror ? 'bottom' : 'top'; sideFromMirror++; }
    const key = String(index), ref = component.refDes.trim();
    if (!ref) generatedRefs++;
    else refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
    const bom = ref ? reader.bom.get(ref) : undefined;
    if (bom && !bom.populate) unpopulated++;
    // The rotation is the Xform rotation as written: for a mirrored (bottom) part it applies after the x → −x mirror, as in
    // EAGLE's MR<angle>; KiCad states the same placement of a bottom footprint with the opposite angle.
    parts.push({
      key, ...(ref ? { ref } : { ref: `COMP${index + 1}`, refGenerated: true }), value: bom?.value ?? '', package: bom?.packageRef || component.packageRef,
      side, position: mm(place({ x: 0, y: 0 }, xf, at)), rotation: angle(xf.rotation),
      ...(pkg && pkg.outline.length >= 3 ? { outline: pkg.outline.map(p => mm(place(p, xf, at))) } : {}),
    });
    if (!pkg) return;
    // Pins without a number get "~n" placeholders that no pin of the package uses (shown, never an identity).
    const taken = new Set(pkg.pins.map(pin => pin.number));
    let spare = 0;
    for (const pin of pkg.pins) {
      let pinNumber = pin.number, generated = false;
      if (!pinNumber) { do pinNumber = `~${++spare}`; while (taken.has(pinNumber)); taken.add(pinNumber); generated = true; }
      const placed = mm(place(place({ x: 0, y: 0 }, pin.xf, pin.at), xf, at));
      const shape = resolve(pin.shape, xf.scale * pin.xf.scale);
      const through = pin.type === 'THRU' || !pin.type && component.mountType === 'THMT';
      const fields = shape ? shapeFields(shape, angle(xf.rotation + (xf.mirror ? -pin.xf.rotation : pin.xf.rotation))) : {};
      const raw: RawPin = { part: key, number: pinNumber, ...(generated ? { numberGenerated: true } : {}), name: pin.name || pinNumber, net: '', x: placed.x, y: placed.y, side: through ? 'both' : side, ...fields };
      const slot = work.length;
      work.push({ raw, component: index, placed, approximated: fields.width !== undefined && !shape!.exact, top: false, bottom: false, electrical: pin.electrical });
      if (ref) {
        const lookup = pinKey(ref, pin.number), entry = byRef.get(lookup);
        if (!entry) byRef.set(lookup, { slots: [slot], cells: new Map(), free: 0, ambiguous: false });
        else { if (work[entry.slots[0]].component !== index) entry.ambiguous = true; entry.slots.push(slot); }
      }
    }
  });

  // Conductor-layer pads: net, placed position, side and (when the package gives none) the pad shape. A pin number may own
  // several physical pads (a switch with two pads per contact, shield tabs): writers may list it once in the package and once
  // per pad on the conductor layers, so a pad far from every package pin of that number becomes an extra pin of the component.
  let unresolvedRefs = 0, ambiguousRefs = 0, netConflicts = 0, moved = 0, physicalMatches = 0, extraPins = 0;
  const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= POSITION_TOLERANCE_MM;
  // Each pin key has a grid of its slots (cells of the position tolerance): a slot is entered at its placed position and, once
  // bound, at its conductor pad. Entries are never removed; a lookup re-checks the slot's current position and looks at a
  // bounded number of entries per cell, and the nearest-pin search a bounded window, so a degenerate file (thousands of
  // coincident pins or pads of one number) stays linear. Real boards have a handful of pins per number.
  const cellOf = (p: Point) => `${Math.floor(p.x / POSITION_TOLERANCE_MM)},${Math.floor(p.y / POSITION_TOLERANCE_MM)}`;
  const enter = (entry: PinSlots, slot: number, p: Point) => { const cell = cellOf(p), list = entry.cells.get(cell); if (list) list.push(slot); else entry.cells.set(cell, [slot]); };
  for (const entry of byRef.values()) for (const slot of entry.slots) enter(entry, slot, work[slot].placed);
  const findNear = (entry: PinSlots, at: Point, boundOnly: boolean): number | undefined => {
    const cx = Math.floor(at.x / POSITION_TOLERANCE_MM), cy = Math.floor(at.y / POSITION_TOLERANCE_MM);
    let found: number | undefined;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const list = entry.cells.get(`${cx + dx},${cy + dy}`);
      if (!list) continue;
      for (let index = 0, end = Math.min(list.length, CELL_SCAN); index < end; index++) {
        const slot = list[index], pin = work[slot];
        if (boundOnly && !pin.copperAt) continue;
        if ((found === undefined || slot < found) && near(pin.copperAt ?? pin.placed, at)) found = slot;
      }
    }
    return found;
  };
  const bind = (entry: PinSlots, slot: number, pad: CopperPad, at: Point, side: ReturnType<typeof layerSide>) => {
    const pin = work[slot];
    if (side === 'top') pin.top = true;
    else if (side === 'bottom') pin.bottom = true;
    if (side !== 'inner') {
      if (!pin.copperAt) { pin.copperAt = at; if (cellOf(at) !== cellOf(pin.placed)) enter(entry, slot, at); }
      if (!pin.copperShape) {
        const padstack = pad.shape ? undefined : step.padstacks.get(pad.padstack)?.get(pad.layerRef);
        const shape = pad.shape ? resolve(pad.shape, pad.xf.scale) : resolve(padstack?.shape, pad.xf.scale * (padstack?.xf.scale ?? 1));
        if (shape) pin.copperShape = { shape, rotation: angle(pad.xf.rotation + (padstack?.xf.rotation ?? 0)) };
      }
    }
    if (pad.net) { if (pin.copper !== undefined && pin.copper !== pad.net) netConflicts++; else pin.copper = pad.net; }
  };
  const deferred: Array<{ pad: CopperPad; entry: PinSlots; at: Point; side: ReturnType<typeof layerSide> }> = [];
  // First pass: pads that sit on a package pin of their number (or on a pad already bound to one).
  for (const pad of step.pads) {
    const at = mm({ x: pad.at.x + pad.xf.dx, y: pad.at.y + pad.xf.dy }), side = layerSide(pad.layerRef);
    for (const ref of pad.refs) {
      const entry = byRef.get(ref);
      if (!entry) { unresolvedRefs++; continue; }
      const slot = findNear(entry, at, false);
      if (slot === undefined) deferred.push({ pad, entry, at, side }); else bind(entry, slot, pad, at, side);
    }
  }
  // Second pass: the rest go to the nearest pin of their number without a pad yet, else become extra pins.
  for (const { pad, entry, at, side } of deferred) {
    let slot = findNear(entry, at, true);
    if (slot === undefined) {
      const slots = entry.slots;
      while (entry.free < slots.length && work[slots[entry.free]].copperAt) entry.free++;
      let best = Infinity;
      for (let index = entry.free, end = Math.min(slots.length, entry.free + NEAREST_SCAN); index < end; index++) {
        const candidate = work[slots[index]];
        if (candidate.copperAt) continue;
        const distance = Math.hypot(candidate.placed.x - at.x, candidate.placed.y - at.y);
        if (distance < best) { best = distance; slot = slots[index]; }
      }
      if (slot !== undefined) moved++;
    }
    if (slot === undefined) {
      // The extra pin copies its number, name and side from the package pin; its shape comes from its own conductor pad.
      const model = work[entry.slots[0]], { shape: _shape, width: _width, height: _height, radius: _radius, rotation: _rotation, ...identity } = model.raw;
      const raw: RawPin = { ...identity, x: at.x, y: at.y };
      slot = work.length; extraPins++;
      work.push({ raw, component: model.component, placed: at, approximated: false, top: false, bottom: false, electrical: model.electrical });
      entry.slots.push(slot);
      enter(entry, slot, at);
    }
    bind(entry, slot, pad, at, side);
  }
  // LogicalNet: the declared netlist. A pin number shared by several pads of one component names all of them. Each pin key is
  // assigned once; a repeated reference only checks for a conflicting name.
  const assigned = new Map<string, string>();
  for (const net of step.logical) {
    for (const ref of net.refs) {
      const entry = byRef.get(ref);
      if (!entry) { unresolvedRefs++; continue; }
      if (entry.ambiguous) { ambiguousRefs++; continue; }
      const prior = assigned.get(ref);
      if (prior !== undefined) { if (prior !== net.name) netConflicts++; continue; }
      assigned.set(ref, net.name);
      for (const candidate of entry.slots) work[candidate].logical = net.name;
    }
  }
  // A package pin with no conductor pad, on a component whose other pins have conductor pads, is a paste or mask aperture or
  // a bare mechanical hole when it is not an electrical pin or when another pad of its number carries the copper: it is left
  // out like the copper-less pads of other readers. An electrical pin whose number has no conductor pad at all is kept.
  const withCopper = new Set<number>(), numbersWithCopper = new Set<string>();
  for (const pin of work) if (pin.copperAt) { withCopper.add(pin.component); numbersWithCopper.add(`${pin.component}\u0000${pin.raw.number}`); }
  let keptPins = 0;
  for (const pin of work) {
    if (pin.copperAt || !withCopper.has(pin.component) || pin.electrical && !numbersWithCopper.has(`${pin.component}\u0000${pin.raw.number}`)) work[keptPins++] = pin;
  }
  const apertures = work.length - keptPins;
  work.length = keptPins; // compacted in place: a spread of a million pins would overflow the call stack
  for (const pin of work) {
    if (pin.copperAt) { pin.raw.x = pin.copperAt.x; pin.raw.y = pin.copperAt.y; }
    if (pin.top || pin.bottom) pin.raw.side = pin.top && pin.bottom ? 'both' : pin.top ? 'top' : 'bottom';
    if (pin.raw.width === undefined && pin.copperShape) {
      const fields = shapeFields(pin.copperShape.shape, pin.copperShape.rotation);
      Object.assign(pin.raw, fields);
      pin.approximated = fields.width !== undefined && !pin.copperShape.shape.exact;
    }
    if (pin.logical !== undefined && pin.copper !== undefined && pin.logical !== pin.copper) netConflicts++;
  }
  // PhyNet points carry coordinates only: they name a pin that no PinRef reached when exactly one net has a point on it. The
  // distance checks have a budget proportional to the input, so crowded coordinates cannot make this quadratic; when it runs
  // out no point is used at all (a partial pass could miss the second net that makes a pin ambiguous).
  let physicalStopped = false;
  if (step.physical.length) {
    const cell = (value: number) => Math.floor(value / PHYSICAL_TOLERANCE_MM), grid = new Map<string, number[]>();
    work.forEach((pin, index) => {
      if (pin.logical !== undefined || pin.copper !== undefined) return;
      const key = `${cell(pin.raw.x)},${cell(pin.raw.y)}`, list = grid.get(key);
      if (list) list.push(index); else grid.set(key, [index]);
    });
    if (grid.size) {
      const found = new Map<number, string | null>();
      let checks = 0;
      for (const net of step.physical) checks += net.points.length;
      checks = 16 * (checks + work.length) + 100_000;
      scan: for (const net of step.physical) {
        if (!net.name) continue;
        for (const raw of net.points) {
          const p = mm(raw), cx = cell(p.x), cy = cell(p.y);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            for (const index of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
              if (--checks < 0) { physicalStopped = true; break scan; }
              const pin = work[index].raw;
              if (Math.hypot(pin.x - p.x, pin.y - p.y) > PHYSICAL_TOLERANCE_MM) continue;
              const prior = found.get(index);
              found.set(index, prior === undefined || prior === net.name ? net.name : null);
            }
          }
        }
      }
      if (!physicalStopped) for (const [index, net] of found) if (net) { work[index].physical = net; physicalMatches++; }
    }
  }
  const pins: RawPin[] = work.map(pin => { pin.raw.net = pin.logical ?? pin.copper ?? pin.physical ?? ''; return pin.raw; });
  const members = new Map<string, number>();
  for (const pin of pins) if (pin.net) members.set(pin.net, (members.get(pin.net) ?? 0) + 1);
  let placeholders = 0;
  for (const pin of pins) if (pin.net && PLACEHOLDER_NET.test(pin.net) && members.get(pin.net) === 1) { pin.net = ''; placeholders++; }
  const approximated = work.reduce((count, pin) => count + (pin.approximated ? 1 : 0), 0);

  // Board outline: the Profile, else the BOARD_OUTLINE layer features.
  let loops: Point[][] = step.profile.map(points => points.map(mm));
  if (loops.length) {
    if (step.profileArcs) warnings.push(note(`${plural(step.profileArcs, 'IPC-2581 profile arc')} ${step.profileArcs === 1 ? 'was' : 'were'} approximated by straight segments.`));
  } else if (step.outlineSegments.length) {
    const { loops: stitched, openChains } = stitchOutlines(step.outlineSegments.map(([a, b]): [Point, Point] => [mm(a), mm(b)]), OUTLINE_CLOSURE_MM);
    loops = stitched;
    if (!loops.length) warnings.push(note('IPC-2581 has no Profile and its board-outline layer does not form a closed contour; an estimated boundary is shown.'));
    else {
      warnings.push(note('IPC-2581 has no Profile; the board outline was taken from the board-outline layer.'));
      if (openChains) warnings.push(note(`${plural(openChains, 'open board-outline chain')} (spurs, chords or gaps) ${openChains === 1 ? 'is' : 'are'} not part of a closed contour and ${openChains === 1 ? 'was' : 'were'} ignored.`));
      if (step.outlineArcs) warnings.push(note(`${plural(step.outlineArcs, 'IPC-2581 outline arc')} ${step.outlineArcs === 1 ? 'was' : 'were'} approximated by straight segments.`));
    }
  }

  const duplicates = [...refCounts.values()].filter(count => count > 1).length;
  if (missingPackages) warnings.push(note(`${plural(missingPackages, 'IPC-2581 component')} ${missingPackages === 1 ? 'references a package' : 'reference packages'} the step does not define; ${missingPackages === 1 ? 'it is' : 'they are'} shown without pins.`));
  if (duplicates) warnings.push(note(`${plural(duplicates, 'reference designator')} ${duplicates === 1 ? 'is' : 'are'} used by more than one component.`));
  if (generatedRefs) warnings.push(note(`${plural(generatedRefs, 'IPC-2581 component')} ${generatedRefs === 1 ? 'has' : 'have'} no reference designator; a placeholder name is shown.`));
  if (sideFromMirror) warnings.push(note(`${plural(sideFromMirror, 'component')} ${sideFromMirror === 1 ? 'names a layer' : 'name layers'} without a top or bottom side; the side was taken from the Xform mirror flag.`));
  if (sideConflicts) warnings.push(note(`${plural(sideConflicts, 'component')}: the layer side and the Xform mirror flag disagree; the side follows the layer, the package is placed as written and conductor pad positions are used where the file has them.`));
  if (transformExtras) warnings.push(note(`${plural(transformExtras, 'component')} ${transformExtras === 1 ? 'uses' : 'use'} an Xform scale or offset; this reading (offset added after the rotation) is not verified with real files.`));
  if (unresolvedRefs) warnings.push(note(`${plural(unresolvedRefs, 'IPC-2581 pin reference')} (PinRef) ${unresolvedRefs === 1 ? 'names a component pin that does not exist and was' : 'name component pins that do not exist and were'} ignored.`));
  if (ambiguousRefs) warnings.push(note(`${plural(ambiguousRefs, 'LogicalNet pin reference')} ${ambiguousRefs === 1 ? 'names a reference designator that several components use and was' : 'name reference designators that several components use and were'} not assigned.`));
  if (netConflicts) warnings.push(note(`${plural(netConflicts, 'conflicting net assignment')} ${netConflicts === 1 ? 'was' : 'were'} found; the LogicalNet name is used, otherwise the first conductor pad.`));
  if (moved) warnings.push(note(`${plural(moved, 'pin')}: the placed package pin and its conductor pad are more than ${POSITION_TOLERANCE_MM} mm apart; the conductor pad position is shown.`));
  if (extraPins) warnings.push(note(`${plural(extraPins, 'conductor pad')} share${extraPins === 1 ? 's' : ''} a pin number with another pad of ${extraPins === 1 ? 'its' : 'their'} component and ${extraPins === 1 ? 'is' : 'are'} shown as ${extraPins === 1 ? 'an extra pin' : 'extra pins'} of that number.`));
  if (apertures) warnings.push(note(`${plural(apertures, 'package pin')} without a conductor pad (paste or mask apertures, mechanical pads) ${apertures === 1 ? 'was' : 'were'} left out.`));
  if (physicalStopped) warnings.push(note('IPC-2581 PhyNet points crowd too closely around the pins to be matched in bounded time; no net was taken from them.'));
  if (physicalMatches) warnings.push(note(`${plural(physicalMatches, 'pin')} got ${physicalMatches === 1 ? 'its net' : 'their nets'} from PhyNet point coordinates.`));
  if (placeholders) warnings.push(note(`${plural(placeholders, 'single-pad "unconnected-(…)" placeholder net')} ${placeholders === 1 ? 'was' : 'were'} treated as no-connects.`));
  if (unresolvedShapes) warnings.push(note(`${plural(unresolvedShapes, 'pad shape reference')} ${unresolvedShapes === 1 ? 'names' : 'name'} no dictionary entry; ${unresolvedShapes === 1 ? 'that pad is' : 'those pads are'} drawn without a size.`));
  if (unpopulated) warnings.push(note(`${plural(unpopulated, 'component')} ${unpopulated === 1 ? 'is' : 'are'} marked not populated in the BOM (populate="false").`));
  if (approximated) warnings.push({ key: 'parse.warning.approximatedPads', params: { count: approximated } });
  return buildBoard(input, { format, unitsToMm: 1, parts, pins, outline: loops[0] ?? [], outlines: loops, warnings });
}

/** IPC-2581 revision B/C XML → Board; null when the bytes are not an IPC-2581 document. */
export function parseIpc2581(input: ParseInput): Board | null {
  const sniff = sniffIpc2581(input.data);
  if (!sniff) return null;
  if (sniff.entities) throw fail('IPC-2581 XML declares entities (<!ENTITY>); entity declarations are not supported and are never expanded.');
  try {
    const reader = new Reader(), scanner = new XmlScanner(reader, 'IPC-2581 XML');
    scanner.write(decodeText(input.data));
    scanner.end();
    return finish(reader, input, sniff);
  } catch (error) {
    // Errors of the scanner and of the shared helpers (number, decodeText) name no format; the file is known to be IPC-2581.
    if (error instanceof TextDecodeError) throw fail(`IPC-2581 XML cannot be decoded: ${error.message}`);
    if (!(error instanceof BoardFormatError) || error.format) throw error;
    const tagged = new BoardFormatError(error.message, error.code, IPC2581_FORMAT);
    tagged.cause = error;
    throw tagged;
  }
}
