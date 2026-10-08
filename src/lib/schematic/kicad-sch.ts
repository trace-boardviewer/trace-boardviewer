/**
 * KiCad `.kicad_sch` (s-expression, KiCad 6 to 9) -> structured schematic model.
 *
 * Written from the published format description (https://dev-docs.kicad.org/en/file-formats/sexpr-schematic/ and
 * .../sexpr-intro/). Library symbols are Y-up with pins that point INTO the body; the placed symbol's rotation
 * (counter-clockwise on screen) is applied first, then the mirror in the sheet frame, then the position. Everything
 * the model contains is absolute millimetres, Y down, snapped to the 0.0001 mm schematic grid.
 */
import { boundText } from '../bounded-text';
import {
  SCHEMATIC_LIMITS, SchematicError,
  type SchBounds, type SchDiagnostic, type SchField, type SchGraphic, type SchLabel, type SchPin, type SchPinType, type SchPoint,
  type SchSeverity, type SchSheetDef, type SchSheetInstance, type SchSheetPin, type SchSheetRef, type SchSymbol, type Schematic,
  type SchematicErrorCode, type SchematicInput, type SchematicParser,
} from './model';
import { childList, childLists, listHead, parseNumber, readSexpr, sexprError, type SexprList, type SexprNode } from './sexpr';

/** Oldest and newest `(version)` this reader accepts: KiCad 6.0.0 (20211123) to KiCad 9.0.x (20250114). */
export const KICAD_SCH_MIN_VERSION = 20211123;
export const KICAD_SCH_MAX_VERSION = 20250114;

/** Same per-file bound the native layer applies when it reads documents. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_UNIT = 1000;
const MAX_BODY_STYLE = 255;

export type SchematicLimits = { -readonly [K in keyof typeof SCHEMATIC_LIMITS]: number };

const fail = sexprError;

// ---------------------------------------------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------------------------------------------

/** KiCad stores schematic coordinates as integers of 0.0001 mm; snapping keeps equal points bit-identical. */
const snap = (v: number): number => { const r = Math.round(v * 1e4) / 1e4; return r === 0 ? 0 : r; };
const mod360 = (a: number): number => snap(((a % 360) + 360) % 360);
const str = (node: SexprNode | undefined): string | undefined => (node && node.kind === 'atom' ? node.value : undefined);
const bareAtom = (node: SexprNode | undefined): string | undefined => (node && node.kind === 'atom' && !node.quoted ? node.value : undefined);

/** Presence flag written either as a bare token (`hide`) or as `(hide yes|no)`; undefined when absent. */
function flag(list: SexprList | undefined, name: string): boolean | undefined {
  if (!list) return undefined;
  let found: boolean | undefined;
  for (let i = 1; i < list.items.length; i++) {
    const item = list.items[i]!;
    if (item.kind === 'atom') { if (!item.quoted && item.value === name) found = true; } else if (listHead(item) === name) found = bareAtom(item.items[1]) !== 'no';
  }
  return found;
}

const PIN_TYPES: ReadonlySet<string> = new Set(['input', 'output', 'bidirectional', 'tri_state', 'passive', 'free', 'unspecified', 'power_in', 'power_out', 'open_collector', 'open_emitter', 'no_connect']);
const LABEL_SHAPES: ReadonlySet<string> = new Set(['input', 'output', 'bidirectional', 'tri_state', 'passive']);
type LabelShape = NonNullable<SchLabel['shape']>;

/** Paper sizes in mm (landscape: width, height); `A`..`E` are the ANSI sizes. */
const PAPER_MM: Readonly<Record<string, readonly [number, number]>> = {
  A5: [210, 148], A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
};

const EMPTY: SexprList = { kind: 'list', items: [], line: 0 };
const UUID_OK = /^[0-9A-Za-z_.:~-]{1,128}$/;

// ---------------------------------------------------------------------------------------------------------------
// Diagnostics (inline and aggregated per file so a repeated condition reports once)
// ---------------------------------------------------------------------------------------------------------------

class DiagSink {
  readonly list: SchDiagnostic[] = [];
  private readonly groups = new Map<string, { count: number; severity: SchSeverity; code: string; text: (n: number) => string; at?: SchPoint }>();
  constructor(private readonly defId: string) {}
  add(severity: SchSeverity, code: string, message: string, at?: SchPoint): void {
    this.list.push({ severity, code, message: boundText(message), defId: this.defId, ...(at ? { at } : {}) });
  }
  count(severity: SchSeverity, code: string, key: string, text: (n: number) => string, at?: SchPoint): void {
    const id = `${code}\u0000${key}`;
    const group = this.groups.get(id);
    if (group) group.count++;
    else this.groups.set(id, { count: 1, severity, code, text, at });
  }
  flush(): void {
    for (const g of this.groups.values()) this.add(g.severity, g.code, g.text(g.count), g.at);
    this.groups.clear();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry: placement transform, arc/bezier sampling, bounds
// ---------------------------------------------------------------------------------------------------------------

type Pt = SchPoint;
type Fill = 'none' | 'outline' | 'background';
type Matrix = readonly [number, number, number, number];

const mul = (m: Matrix, n: Matrix): Matrix => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3]];
/** Counter-clockwise rotation on screen in a Y-down frame. */
const ROTATION: Readonly<Record<number, Matrix>> = { 0: [1, 0, 0, 1], 90: [0, 1, -1, 0], 180: [-1, 0, 0, -1], 270: [0, -1, 1, 0] };
const FLIP_Y: Matrix = [1, 0, 0, -1]; // library Y-up -> sheet Y-down
const MIRROR: Readonly<Record<'none' | 'x' | 'y', Matrix>> = { none: [1, 0, 0, 1], x: [1, 0, 0, -1], y: [-1, 0, 0, 1] };

interface Xf {
  pt(x: number, y: number): Pt;
  /** Direction angle (degrees, counter-clockwise on screen) of a library direction angle. */
  angle(degrees: number): number;
  swapsAnchor(degrees: number): boolean;
}

function makeXf(at: Pt, rotation: number, mirror: 'none' | 'x' | 'y'): Xf {
  const [a, b, c, d] = mul(MIRROR[mirror], mul(ROTATION[rotation]!, FLIP_Y));
  const direction = (degrees: number): number => {
    const r = (degrees * Math.PI) / 180;
    const vx = a * Math.cos(r) + b * Math.sin(r);
    const vy = c * Math.cos(r) + d * Math.sin(r);
    return mod360((Math.atan2(-vy, vx) * 180) / Math.PI);
  };
  return {
    pt: (x, y) => ({ x: snap(at.x + a * x + b * y), y: snap(at.y + c * x + d * y) }),
    // KiCad keeps text readable: a text that would read upside down is turned back and its justification swapped.
    angle: (degrees) => { const v = direction(degrees); return v >= 180 ? snap(v - 180) : v; },
    swapsAnchor: (degrees) => direction(degrees) >= 180,
  };
}
const IDENTITY: Xf = { pt: (x, y) => ({ x: snap(x), y: snap(y) }), angle: (degrees) => mod360(degrees), swapsAnchor: () => false };

/** Circle through three points sampled from `s` through `m` to `e`; a degenerate (collinear) arc stays a polyline. */
function sampleArc(s: Pt, m: Pt, e: Pt): Pt[] {
  const bx = m.x - s.x, by = m.y - s.y, cx = e.x - s.x, cy = e.y - s.y;
  const d = 2 * (bx * cy - by * cx);
  const b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  if (Math.abs(d) <= 1e-12 * (b2 + c2)) return [s, m, e];
  const ux = (cy * b2 - by * c2) / d, uy = (bx * c2 - cx * b2) / d;
  const centre = { x: s.x + ux, y: s.y + uy };
  const radius = Math.hypot(ux, uy);
  const a0 = Math.atan2(-uy, -ux), ae = Math.atan2(cy - uy, cx - ux);
  const twoPi = Math.PI * 2;
  const wrap = (v: number): number => ((v % twoPi) + twoPi) % twoPi;
  const turn = bx * (cy - by) - by * (cx - bx);
  const sweep = turn > 0 ? wrap(ae - a0) : -wrap(a0 - ae);
  if (Math.abs(sweep) < 1e-9) return [s, m, e];
  const steps = Math.max(2, Math.min(180, Math.ceil(Math.abs(sweep) / (Math.PI / 18))));
  const out: Pt[] = [s];
  for (let i = 1; i < steps; i++) {
    const t = a0 + (sweep * i) / steps;
    out.push({ x: snap(centre.x + radius * Math.cos(t)), y: snap(centre.y + radius * Math.sin(t)) });
  }
  out.push(e);
  return out;
}

function sampleBezier(p: Pt[]): Pt[] {
  const [p0, p1, p2, p3] = p as [Pt, Pt, Pt, Pt];
  const steps = 16;
  const out: Pt[] = [p0];
  for (let i = 1; i < steps; i++) {
    const t = i / steps, u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    out.push({ x: snap(w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x), y: snap(w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y) });
  }
  out.push(p3);
  return out;
}

class Box {
  private minX = Infinity; private minY = Infinity; private maxX = -Infinity; private maxY = -Infinity;
  add(p: Pt): void { this.addXY(p.x, p.y); }
  addXY(x: number, y: number): void {
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }
  merge(b: SchBounds): void { this.addXY(b.minX, b.minY); this.addXY(b.maxX, b.maxY); }
  graphic(g: SchGraphic): void {
    if (g.kind === 'poly') for (const p of g.points) this.add(p);
    else if (g.kind === 'rect') { this.add(g.min); this.add(g.max); } else if (g.kind === 'circle') {
      this.addXY(g.center.x - g.radius, g.center.y - g.radius); this.addXY(g.center.x + g.radius, g.center.y + g.radius);
    } else this.add(g.at);
  }
  get empty(): boolean { return this.minX > this.maxX; }
  bounds(fallback: SchBounds): SchBounds { return this.empty ? fallback : { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY }; }
}

// ---------------------------------------------------------------------------------------------------------------
// Library symbols (Y-up, relative to the symbol origin)
// ---------------------------------------------------------------------------------------------------------------

type Shape =
  | { kind: 'poly'; points: Pt[]; width: number; filled: boolean }
  | { kind: 'rect'; a: Pt; b: Pt; width: number; fill: Fill }
  | { kind: 'circle'; c: Pt; r: number; width: number; fill: Fill }
  | { kind: 'text'; at: Pt; text: string; angle: number; size: number; anchor: 'start' | 'middle' | 'end'; bold: boolean; italic: boolean; hidden: boolean };

interface LibPin { number: string; name: string; type: SchPinType; hidden: boolean; at: Pt; angle: number; length: number }
interface LibUnit { unit: number; style: number; shapes: Shape[]; pins: LibPin[] }
interface LibSymbol { name: string; power: false | 'global' | 'local'; parent: string | null; subs: LibUnit[] }

type ResolvedLib = { subs: LibUnit[]; power: false | 'global' | 'local'; unitCount: number } | { missing: string; via: string };

function resolveLib(libs: Map<string, LibSymbol>, start: LibSymbol): ResolvedLib {
  const seen: string[] = [];
  let cur = start;
  let subs = start.subs;
  let power = start.power;
  for (;;) {
    seen.push(cur.name);
    if (!cur.parent || (subs.length > 0 && power !== false)) break;
    if (seen.includes(cur.parent)) throw fail(`Library symbol extends chain is cyclic: ${[...seen, cur.parent].join(' -> ')}.`);
    const parent = libs.get(cur.parent);
    if (!parent) return { missing: cur.parent, via: start.name };
    if (subs.length === 0) subs = parent.subs;
    if (power === false) power = parent.power;
    cur = parent;
  }
  let unitCount = 1;
  for (const s of subs) if (s.unit > unitCount) unitCount = s.unit;
  return { subs, power, unitCount };
}

// ---------------------------------------------------------------------------------------------------------------
// One .kicad_sch file
// ---------------------------------------------------------------------------------------------------------------

interface InstRec { project: string; path: string; ref: string; unit: number | null }
interface PageRec { project: string; path: string; page: string }

interface ParsedFile {
  key: string;
  version: number;
  def: SchSheetDef;
  diags: DiagSink;
  /** Raw (KiCad >= 7) per-symbol instance records, parallel to `def.symbols`. */
  symInst: InstRec[][];
  /** Uuid as written for each symbol (v6 `symbol_instances` paths end with it), parallel to `def.symbols`. */
  symUuid: Array<string | null>;
  /** Raw per-sheet-symbol page records, parallel to `def.sheetRefs`. */
  refPages: PageRec[][];
  /** KiCad 6/7 top-level tables (meaningful in the root file only). */
  v6Symbols: Map<string, { ref: string; unit: number | null }>;
  v6Sheets: Map<string, string>;
  /** Resolved child key per `def.sheetRefs` entry (null: unresolved), filled while resolving the hierarchy. */
  children: Array<string | null>;
}

interface Budget { nodes: number }

class FileParser {
  private readonly diags: DiagSink;
  private readonly ids = new Set<string>();
  /** Next `~n` suffix to try per repeated base id, so k repeats of one uuid cost k probes rather than k^2. */
  private readonly nextSuffix = new Map<string, number>();
  private readonly generated = new Map<string, number>();
  private readonly unknown = new Map<string, { count: number; at?: Pt; severity: SchSeverity; note: string }>();
  private readonly libs = new Map<string, LibSymbol>();

  constructor(private readonly lim: SchematicLimits, private readonly key: string, private readonly fileName: string, private readonly budget: Budget) {
    this.diags = new DiagSink(key);
  }

  // ---- numbers ----------------------------------------------------------------------------------------------

  private coord(node: SexprNode | undefined, what: string, parent: SexprList): number {
    if (!node) throw fail(`${what} is missing a value (line ${parent.line}).`);
    const v = parseNumber(node, what);
    if (Math.abs(v) > this.lim.maxCoordinateMm) throw fail(`${what} ${v} exceeds the ${this.lim.maxCoordinateMm} mm coordinate limit (line ${node.line}).`, 'LIMIT_EXCEEDED');
    return snap(v);
  }

  private length(node: SexprNode | undefined, what: string, parent: SexprList): number {
    const v = this.coord(node, what, parent);
    if (v < 0) throw fail(`${what} must not be negative (line ${parent.line}).`);
    return v;
  }

  private integer(node: SexprNode | undefined, what: string, parent: SexprList, min: number, max: number): number {
    if (!node) throw fail(`${what} is missing a value (line ${parent.line}).`);
    const v = parseNumber(node, what);
    if (!Number.isInteger(v) || v < min) throw fail(`${what} must be an integer of at least ${min} but is ${v} (line ${node.line}).`);
    if (v > max) throw fail(`${what} ${v} is above the supported maximum ${max} (line ${node.line}).`, 'LIMIT_EXCEEDED');
    return v;
  }

  private rawAngle(node: SexprNode, what: string): number {
    const v = parseNumber(node, what);
    if (Math.abs(v) > 1e9) throw fail(`${what} ${v} is not a plausible angle (line ${node.line}).`);
    return v;
  }

  private at(list: SexprList, what: string): { x: number; y: number; angle: number; raw: number } {
    const at = childList(list, 'at');
    if (!at) throw fail(`${what} is missing (at x y) (line ${list.line}).`);
    const n = at.items.length;
    if (n < 3 || n > 4) throw fail(`${what} (at ...) needs x, y and an optional angle (line ${at.line}).`);
    const raw = n === 4 ? this.rawAngle(at.items[3]!, `${what} angle`) : 0;
    return { x: this.coord(at.items[1], `${what} x`, at), y: this.coord(at.items[2], `${what} y`, at), angle: mod360(raw), raw };
  }

  private point(list: SexprList, name: string, what: string): Pt {
    const p = childList(list, name);
    if (!p || p.items.length !== 3) throw fail(`${what} needs (${name} x y) (line ${list.line}).`);
    return { x: this.coord(p.items[1], `${what} ${name} x`, p), y: this.coord(p.items[2], `${what} ${name} y`, p) };
  }

  // ---- ids --------------------------------------------------------------------------------------------------

  /** Unique, deterministic id: the uuid when it is usable, else `${kind}#${n}`; collisions get a `~n` suffix. */
  private takeId(list: SexprList, kind: string): { id: string; uuid: string | null } {
    const written = str(childList(list, 'uuid')?.items[1]);
    let uuid: string | null = null;
    let base: string;
    if (written !== undefined && UUID_OK.test(written)) { uuid = written; base = written; } else {
      if (written !== undefined) this.diags.count('warning', 'INVALID_UUID', '', (n) => `${n} element uuid(s) are not usable identifiers (empty, too long or containing "/"); generated ids were used instead.`);
      const n = (this.generated.get(kind) ?? 0) + 1;
      this.generated.set(kind, n);
      base = `${kind}#${n}`;
    }
    let id = base;
    if (this.ids.has(id)) {
      this.diags.count('warning', 'DUPLICATE_ID', '', (n) => `${n} element id(s) occur more than once in the file; they were made unique with a "~n" suffix.`);
      // Ids are never released, so the probe can resume where the previous repeat of this base stopped; the result is
      // the same lowest free suffix a search from ~2 would find.
      let n = this.nextSuffix.get(base) ?? 2;
      while (this.ids.has(`${base}~${n}`)) n++;
      this.nextSuffix.set(base, n + 1);
      id = `${base}~${n}`;
    }
    this.ids.add(id);
    return { id, uuid };
  }

  // ---- styling ----------------------------------------------------------------------------------------------

  private strokeWidth(list: SexprList): number {
    const width = childList(childList(list, 'stroke') ?? EMPTY, 'width');
    if (!width) return 0;
    return this.length(width.items[1], 'stroke width', width);
  }

  private fill(list: SexprList): Fill {
    const type = bareAtom(childList(childList(list, 'fill') ?? EMPTY, 'type')?.items[1]);
    // `color` (KiCad 8+) is a user-coloured fill; the colour itself is not part of the model.
    return type === 'outline' ? 'outline' : type === 'background' || type === 'color' ? 'background' : 'none';
  }

  private effects(list: SexprList): { size: number; anchor: 'start' | 'middle' | 'end'; bold: boolean; italic: boolean; hidden: boolean } {
    const eff = childList(list, 'effects');
    const font = eff ? childList(eff, 'font') : undefined;
    const sizeNode = font ? childList(font, 'size')?.items[1] : undefined;
    let size = 1.27;
    if (sizeNode && sizeNode.kind === 'atom' && !sizeNode.quoted) {
      const v = Number(sizeNode.value);
      if (Number.isFinite(v) && v > 0 && v < 1000) size = v;
    }
    let anchor: 'start' | 'middle' | 'end' = 'middle';
    const justify = eff ? childList(eff, 'justify') : undefined;
    if (justify) for (const item of justify.items) { const v = bareAtom(item); if (v === 'left') anchor = 'start'; else if (v === 'right') anchor = 'end'; }
    return { size, anchor, bold: flag(font, 'bold') === true, italic: flag(font, 'italic') === true, hidden: flag(eff, 'hide') === true };
  }

  private pts(list: SexprList, what: string, min: number, max = Infinity): Pt[] {
    const pts = childList(list, 'pts');
    const out: Pt[] = [];
    if (pts) {
      for (const item of pts.items) {
        if (item.kind !== 'list' || listHead(item) !== 'xy') continue;
        if (item.items.length !== 3) throw fail(`${what} point needs x and y (line ${item.line}).`);
        out.push({ x: this.coord(item.items[1], `${what} x`, item), y: this.coord(item.items[2], `${what} y`, item) });
      }
    }
    if (out.length < min || out.length > max) throw fail(`${what} needs ${max === min ? `exactly ${min}` : `at least ${min}`} points but has ${out.length} (line ${list.line}).`);
    return out;
  }

  // ---- graphics ---------------------------------------------------------------------------------------------

  /** Reads a drawing item in its own frame; arcs and Beziers are sampled into polylines. */
  private shape(list: SexprList, head: string, tenths: boolean): Shape {
    const width = this.strokeWidth(list);
    const fill = this.fill(list);
    switch (head) {
      case 'polyline': return { kind: 'poly', points: this.pts(list, 'polyline', 2), width, filled: fill !== 'none' };
      case 'bezier': return { kind: 'poly', points: sampleBezier(this.pts(list, 'bezier', 4, 4)), width, filled: fill !== 'none' };
      case 'rectangle': return { kind: 'rect', a: this.point(list, 'start', 'rectangle'), b: this.point(list, 'end', 'rectangle'), width, fill };
      case 'circle': {
        const radius = childList(list, 'radius');
        if (!radius) throw fail(`circle needs (radius r) (line ${list.line}).`);
        return { kind: 'circle', c: this.point(list, 'center', 'circle'), r: this.length(radius.items[1], 'circle radius', radius), width, fill };
      }
      case 'arc': {
        const points = sampleArc(this.point(list, 'start', 'arc'), this.point(list, 'mid', 'arc'), this.point(list, 'end', 'arc'));
        return { kind: 'poly', points, width, filled: fill !== 'none' };
      }
      default: { // text
        const text = str(list.items[1]);
        if (text === undefined) throw fail(`text needs a quoted string (line ${list.line}).`);
        const at = this.at(list, 'text');
        const e = this.effects(list);
        // Symbol-library text angles are stored in tenths of a degree, schematic text angles in degrees.
        const degrees = tenths ? mod360(at.raw / 10) : at.angle;
        return { kind: 'text', at: { x: at.x, y: at.y }, text, angle: degrees, size: e.size, anchor: e.anchor, bold: e.bold, italic: e.italic, hidden: e.hidden };
      }
    }
  }

  private place(s: Shape, xf: Xf): SchGraphic {
    switch (s.kind) {
      case 'poly': return { kind: 'poly', points: s.points.map((p) => xf.pt(p.x, p.y)), width: s.width, filled: s.filled };
      case 'rect': {
        const p = xf.pt(s.a.x, s.a.y), q = xf.pt(s.b.x, s.b.y);
        return { kind: 'rect', min: { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y) }, max: { x: Math.max(p.x, q.x), y: Math.max(p.y, q.y) }, width: s.width, fill: s.fill };
      }
      case 'circle': return { kind: 'circle', center: xf.pt(s.c.x, s.c.y), radius: s.r, width: s.width, fill: s.fill };
      case 'text': {
        const swap = xf.swapsAnchor(s.angle);
        const anchor = swap ? (s.anchor === 'start' ? 'end' : s.anchor === 'end' ? 'start' : 'middle') : s.anchor;
        const g: SchGraphic = { kind: 'text', at: xf.pt(s.at.x, s.at.y), text: s.text, angle: xf.angle(s.angle), size: s.size, anchor };
        if (s.bold) g.bold = true;
        if (s.italic) g.italic = true;
        if (s.hidden) g.hidden = true;
        return g;
      }
    }
  }

  // ---- library symbols --------------------------------------------------------------------------------------

  private libPin(list: SexprList): LibPin {
    const type = bareAtom(list.items[1]);
    if (type === undefined || !PIN_TYPES.has(type)) throw fail(`pin electrical type "${str(list.items[1]) ?? ''}" is not one of ${[...PIN_TYPES].join(', ')} (line ${list.line}).`);
    const at = this.at(list, 'pin');
    if (at.angle % 90 !== 0) throw fail(`pin orientation ${at.angle} must be 0, 90, 180 or 270 (line ${list.line}).`);
    const length = childList(list, 'length');
    if (!length) throw fail(`pin needs (length n) (line ${list.line}).`);
    const numberList = childList(list, 'number');
    const number = str(numberList?.items[1]);
    if (number === undefined) throw fail(`pin needs (number "n" ...) (line ${list.line}).`);
    const name = str(childList(list, 'name')?.items[1]) ?? '';
    return {
      number, name: name === '~' ? '' : name, type: type as SchPinType, hidden: flag(list, 'hide') === true,
      at: { x: at.x, y: at.y }, angle: at.angle, length: this.length(length.items[1], 'pin length', length),
    };
  }

  private libSymbol(list: SexprList): LibSymbol {
    const name = str(list.items[1]);
    if (name === undefined) throw fail(`lib_symbols entry needs a name (line ${list.line}).`);
    const lib: LibSymbol = { name, power: false, parent: null, subs: [] };
    const loose: LibUnit = { unit: 0, style: 0, shapes: [], pins: [] };
    for (let i = 2; i < list.items.length; i++) {
      const item = list.items[i]!;
      if (item.kind !== 'list') continue;
      const head = listHead(item);
      if (head === 'power') {
        const scope = bareAtom(item.items[1]) ?? 'global';
        if (scope !== 'global' && scope !== 'local') throw fail(`power scope "${scope}" must be global or local (line ${item.line}).`);
        lib.power = scope;
      } else if (head === 'extends') lib.parent = str(item.items[1]) ?? null;
      else if (head === 'symbol') lib.subs.push(this.libUnit(item));
      else if (head === 'pin') this.pinInto(loose, item, name);
      else if (head && ['polyline', 'rectangle', 'circle', 'arc', 'bezier', 'text'].includes(head)) loose.shapes.push(this.shape(item, head, true));
    }
    if (loose.shapes.length > 0 || loose.pins.length > 0) lib.subs.unshift(loose);
    return lib;
  }

  private pinInto(unit: LibUnit, list: SexprList, libName: string): void {
    const pin = this.libPin(list);
    if (pin.number === '') {
      this.diags.count('warning', 'PIN_NUMBER_EMPTY', libName, (n) => `Library symbol "${libName}" has ${n} pin(s) with an empty number; placeholder numbers "?n" were assigned.`);
      pin.number = `?${unit.pins.length + 1}`;
    }
    unit.pins.push(pin);
  }

  private libUnit(list: SexprList): LibUnit {
    const name = str(list.items[1]) ?? '';
    const m = /_(\d+)_(\d+)$/.exec(name);
    if (!m) throw fail(`unit symbol "${name}" must be named NAME_UNIT_STYLE with integer UNIT and STYLE (line ${list.line}).`);
    const unit = Number(m[1]), style = Number(m[2]);
    if (unit > MAX_UNIT) throw fail(`unit number ${unit} of "${name}" is above the supported maximum ${MAX_UNIT} (line ${list.line}).`, 'LIMIT_EXCEEDED');
    if (style > MAX_BODY_STYLE) throw fail(`body style ${style} of "${name}" is above the supported maximum ${MAX_BODY_STYLE} (line ${list.line}).`, 'LIMIT_EXCEEDED');
    const out: LibUnit = { unit, style, shapes: [], pins: [] };
    for (const item of list.items) {
      if (item.kind !== 'list') continue;
      const head = listHead(item);
      if (head === 'pin') this.pinInto(out, item, name);
      else if (head && ['polyline', 'rectangle', 'circle', 'arc', 'bezier', 'text'].includes(head)) out.shapes.push(this.shape(item, head, true));
    }
    return out;
  }

  // ---- placed symbol ----------------------------------------------------------------------------------------

  private instanceRecords(list: SexprList): Array<{ project: string; path: string; entry: SexprList }> {
    const out: Array<{ project: string; path: string; entry: SexprList }> = [];
    const inst = childList(list, 'instances');
    if (!inst) return out;
    for (const project of childLists(inst, 'project')) {
      const projectName = str(project.items[1]) ?? '';
      for (const path of childLists(project, 'path')) {
        const p = str(path.items[1]);
        if (p !== undefined) out.push({ project: projectName, path: p, entry: path });
      }
    }
    return out;
  }

  private symbol(list: SexprList, libs: Map<string, LibSymbol>): { symbol: SchSymbol; records: InstRec[]; uuid: string | null } {
    const libId = str(childList(list, 'lib_id')?.items[1]);
    if (libId === undefined) throw fail(`symbol is missing (lib_id "...") (line ${list.line}).`);
    const libName = str(childList(list, 'lib_name')?.items[1]);
    const at = this.at(list, 'symbol');
    if (at.angle % 90 !== 0) throw fail(`symbol rotation ${at.angle} must be 0, 90, 180 or 270 (line ${list.line}).`);
    const rotation = at.angle;
    const mirrorList = childList(list, 'mirror');
    let mirror: 'none' | 'x' | 'y' = 'none';
    if (mirrorList) {
      const m = bareAtom(mirrorList.items[1]);
      if ((m !== 'x' && m !== 'y') || mirrorList.items.length !== 2) throw fail(`symbol (mirror ...) must be x or y (line ${mirrorList.line}).`);
      mirror = m;
    }
    const unitList = childList(list, 'unit');
    const unit = unitList ? this.integer(unitList.items[1], 'symbol unit', unitList, 1, MAX_UNIT) : 1;
    const styleList = childList(list, 'body_style') ?? childList(list, 'convert');
    const style = styleList ? this.integer(styleList.items[1], 'symbol body style', styleList, 1, MAX_BODY_STYLE) : 1;
    const { id, uuid } = this.takeId(list, 'symbol');

    const fields: SchField[] = [];
    for (const prop of childLists(list, 'property')) {
      const name = str(prop.items[1]), value = str(prop.items[2]);
      if (name === undefined || value === undefined) throw fail(`property needs a name and a value (line ${prop.line}).`);
      const field: SchField = { name, value, hidden: flag(prop, 'hide') === true || flag(childList(prop, 'effects'), 'hide') === true };
      const fieldAt = childList(prop, 'at');
      if (fieldAt && fieldAt.items.length >= 3) {
        field.at = { x: this.coord(fieldAt.items[1], `property ${name} x`, fieldAt), y: this.coord(fieldAt.items[2], `property ${name} y`, fieldAt) };
        if (fieldAt.items.length >= 4) field.angle = mod360(this.rawAngle(fieldAt.items[3]!, `property ${name} angle`));
      }
      fields.push(field);
    }
    const field = (name: string): string => fields.find((f) => f.name === name)?.value ?? '';
    const refDefault = field('Reference');
    if (!fields.some((f) => f.name === 'Reference')) this.diags.count('warning', 'SYMBOL_REFERENCE_MISSING', '', (n) => `${n} placed symbol(s) have no Reference property.`);
    const value = field('Value');

    const xf = makeXf({ x: at.x, y: at.y }, rotation, mirror);
    const pins: SchPin[] = [];
    const graphics: SchGraphic[] = [];
    let power: SchSymbol['power'];
    let powerFlagged = false;
    let unitCount = 1;
    const lib = (libName !== undefined ? libs.get(libName) : undefined) ?? libs.get(libId);
    const where = { x: at.x, y: at.y };
    if (!lib) {
      this.diags.count('warning', 'LIB_SYMBOL_MISSING', libId, (n) => `Library symbol "${libId}" is not defined in lib_symbols; ${n} placed symbol(s) have no pins or graphics.`, where);
    } else {
      const res = resolveLib(libs, lib);
      if ('missing' in res) {
        this.diags.count('warning', 'LIB_SYMBOL_MISSING', `${libId}>${res.missing}`, (n) => `Library symbol "${res.via}" extends "${res.missing}", which is not defined in lib_symbols; ${n} placed symbol(s) have no pins or graphics.`, where);
      } else {
        unitCount = res.unitCount;
        if (unit > unitCount) this.diags.count('warning', 'UNIT_OUT_OF_RANGE', libId, (n) => `${n} placed symbol(s) of "${libId}" use a unit above the library's ${unitCount}; they have no unit pins.`, where);
        powerFlagged = res.power !== false;
        if (res.power === 'global') {
          // Only a power-INPUT pin makes a power symbol drive the global net named by its Value. A power flag (PWR_FLAG: (power) with a
          // single power-output pin) names nothing: treating its Value as a net would merge every rail that carries a flag (W-open-sch-01).
          if (!res.subs.some((sub) => sub.pins.some((p) => p.type === 'power_in'))) { /* flag only: no net */ }
          else if (value) power = { net: value };
          else this.diags.count('warning', 'POWER_VALUE_EMPTY', '', (n) => `${n} power symbol(s) have an empty Value, so no net name could be taken from them.`, where);
        } else if (res.power === 'local') {
          this.diags.count('warning', 'POWER_LOCAL_UNSUPPORTED', '', (n) => `${n} local power symbol(s) (KiCad 9) were not given a global net: the model has no sheet-local power nets.`, where);
        }
        const used = new Set<string>();
        const nextSuffix = new Map<string, number>();
        for (const sub of res.subs) {
          if ((sub.unit !== 0 && sub.unit !== unit) || (sub.style !== 0 && sub.style !== style)) continue;
          for (const s of sub.shapes) graphics.push(this.place(s, xf));
          for (const p of sub.pins) {
            const rad = (p.angle * Math.PI) / 180;
            const base = `${id}#${p.number}`;
            let pinId = base;
            if (used.has(pinId)) pinId = `${base}@${sub.unit}`;
            if (used.has(pinId)) {
              // Same resumed probe as takeId: repeated pin numbers within one symbol stay linear.
              let n = nextSuffix.get(pinId) ?? 2;
              while (used.has(`${pinId}~${n}`)) n++;
              nextSuffix.set(pinId, n + 1);
              pinId = `${pinId}~${n}`;
            }
            used.add(pinId);
            const pin: SchPin = {
              id: pinId, number: p.number, name: p.name,
              at: xf.pt(p.at.x, p.at.y), body: xf.pt(p.at.x + p.length * Math.cos(rad), p.at.y + p.length * Math.sin(rad)),
              type: p.type, hidden: p.hidden, unit: sub.unit,
            };
            // KiCad ties an invisible power-input pin to the global net of the same name; power symbols use their Value.
            if (p.hidden && p.type === 'power_in' && res.power === false) {
              if (p.name) pin.implicitNet = p.name;
              else this.diags.count('info', 'HIDDEN_POWER_PIN_UNNAMED', '', (n) => `${n} hidden power-input pin(s) have no name and cannot be tied to a net.`, where);
            }
            pins.push(pin);
          }
        }
      }
    }

    const box = new Box();
    for (const g of graphics) box.graphic(g);
    for (const p of pins) { box.add(p.at); box.add(p.body); }
    const bounds = box.bounds({ minX: at.x, minY: at.y, maxX: at.x, maxY: at.y });

    const symbol: SchSymbol = {
      id, libId, refDefault, instances: {}, value, footprint: field('Footprint'), datasheet: field('Datasheet'),
      unit, unitCount, at: { x: at.x, y: at.y }, rotation, mirror, pins, graphics, fields,
      virtual: refDefault.startsWith('#') || power !== undefined || powerFlagged || flag(list, 'on_board') === false,
      dnp: flag(list, 'dnp') === true, bounds,
    };
    if (power) symbol.power = power;
    const records: InstRec[] = [];
    for (const r of this.instanceRecords(list)) {
      const ref = str(childList(r.entry, 'reference')?.items[1]);
      if (ref === undefined) continue;
      const u = childList(r.entry, 'unit')?.items[1];
      const unitNum = u && u.kind === 'atom' && !u.quoted && /^\d+$/.test(u.value) ? Number(u.value) : null;
      records.push({ project: r.project, path: r.path, ref, unit: unitNum });
    }
    return { symbol, records, uuid };
  }

  // ---- sheet symbols, labels, headers -----------------------------------------------------------------------

  private sheet(list: SexprList): { ref: SchSheetRef; pages: PageRec[] } {
    const at = this.at(list, 'sheet');
    const size = childList(list, 'size');
    if (!size || size.items.length !== 3) throw fail(`sheet needs (size width height) (line ${list.line}).`);
    const w = this.length(size.items[1], 'sheet width', size), h = this.length(size.items[2], 'sheet height', size);
    let name: string | undefined, file: string | undefined;
    for (const prop of childLists(list, 'property')) {
      const key = (str(prop.items[1]) ?? '').toLowerCase().replace(/[\s_]/g, '');
      if (key === 'sheetname') name = str(prop.items[2]); else if (key === 'sheetfile') file = str(prop.items[2]);
    }
    if (!file) throw fail(`sheet needs a non-empty Sheetfile property (line ${list.line}).`);
    const { id } = this.takeId(list, 'sheet');
    const pins: SchSheetPin[] = [];
    for (const p of childLists(list, 'pin')) {
      const pinName = str(p.items[1]);
      const shape = bareAtom(p.items[2]);
      if (pinName === undefined) throw fail(`sheet pin needs a quoted name (line ${p.line}).`);
      if (shape === undefined || !LABEL_SHAPES.has(shape)) throw fail(`sheet pin "${pinName}" has unknown shape "${str(p.items[2]) ?? ''}" (line ${p.line}).`);
      const pa = this.at(p, `sheet pin "${pinName}"`);
      pins.push({ id: this.takeId(p, 'sheetpin').id, name: pinName, at: { x: pa.x, y: pa.y }, shape: shape as LabelShape });
    }
    const pages: PageRec[] = [];
    for (const r of this.instanceRecords(list)) {
      const page = str(childList(r.entry, 'page')?.items[1]);
      if (page !== undefined) pages.push({ project: r.project, path: r.path, page });
    }
    const stem = fileStem(file);
    return { ref: { id, name: name || stem, file, defId: null, at: { x: at.x, y: at.y }, size: { x: w, y: h }, pins }, pages };
  }

  private label(list: SexprList, kind: SchLabel['kind']): SchLabel | null {
    const text = str(list.items[1]);
    if (text === undefined) throw fail(`${kind === 'local' ? 'label' : `${kind}_label`} needs a quoted text (line ${list.line}).`);
    const at = this.at(list, 'label');
    let shape: LabelShape | undefined;
    const shapeList = kind === 'local' ? undefined : childList(list, 'shape');
    if (shapeList) {
      const s = bareAtom(shapeList.items[1]);
      if (s === undefined || !LABEL_SHAPES.has(s)) throw fail(`label shape "${str(shapeList.items[1]) ?? ''}" is not one of ${[...LABEL_SHAPES].join(', ')} (line ${shapeList.line}).`);
      shape = s as LabelShape;
    }
    if (text === '') { this.diags.count('warning', 'LABEL_EMPTY', '', (n) => `${n} label(s) without text were skipped.`, { x: at.x, y: at.y }); return null; }
    const out: SchLabel = { id: this.takeId(list, 'label').id, kind, text, at: { x: at.x, y: at.y }, angle: at.angle };
    if (shape) out.shape = shape;
    return out;
  }

  private noteUnknown(list: SexprList, head: string, severity: SchSeverity = 'info', note = 'not represented in the schematic model'): void {
    const known = this.unknown.get(head);
    if (known) { known.count++; return; }
    let at: Pt | undefined;
    const a = childList(list, 'at');
    if (a && a.items.length >= 3) {
      const x = Number(str(a.items[1])), y = Number(str(a.items[2]));
      if (Number.isFinite(x) && Number.isFinite(y)) at = { x: snap(x), y: snap(y) };
    }
    this.unknown.set(head, { count: 1, at, severity, note });
  }

  // ---- whole file -------------------------------------------------------------------------------------------

  parse(text: string): ParsedFile {
    const { root, nodes } = readSexpr(text, { maxNodes: this.budget.nodes, maxDepth: this.lim.maxNestingDepth, maxChars: MAX_FILE_BYTES });
    this.budget.nodes -= nodes;
    if (listHead(root) !== 'kicad_sch') throw fail('The top-level expression is not (kicad_sch ...).');

    const versionNode = childList(root, 'version')?.items[1];
    const versionText = bareAtom(versionNode);
    if (versionText === undefined || !/^\d{8}$/.test(versionText)) throw fail('The file has no valid (version YYYYMMDD) header; it is not a readable KiCad schematic.');
    const version = Number(versionText);
    if (version < KICAD_SCH_MIN_VERSION || version > KICAD_SCH_MAX_VERSION) {
      throw fail(`KiCad schematic version ${version} is not supported: this reader is validated for versions ${KICAD_SCH_MIN_VERSION} (KiCad 6.0) to ${KICAD_SCH_MAX_VERSION} (KiCad 9.0).`, 'UNSUPPORTED_VARIANT');
    }

    let uuid: string | undefined;
    const written = str(childList(root, 'uuid')?.items[1]);
    if (written !== undefined && UUID_OK.test(written)) uuid = written;

    const titleBlock: Record<string, string> = {};
    const tb = childList(root, 'title_block');
    if (tb) {
      for (const item of tb.items) {
        if (item.kind !== 'list') continue;
        const head = listHead(item);
        if (head === 'title' || head === 'date' || head === 'rev' || head === 'company') { const v = str(item.items[1]); if (v !== undefined) titleBlock[head] = v; } else if (head === 'comment') {
          const n = bareAtom(item.items[1]), v = str(item.items[2]);
          if (n !== undefined && /^[1-9]$/.test(n) && v !== undefined) titleBlock[`comment${n}`] = v;
        }
      }
    }

    let paper: SchSheetDef['paper'];
    const paperList = childList(root, 'paper');
    if (paperList) {
      const first = str(paperList.items[1]) ?? '';
      let size: readonly [number, number] | undefined = PAPER_MM[first];
      if (!size) {
        const dim = (n: SexprNode | undefined): number => { const v = Number(str(n)); return Number.isFinite(v) && v > 0 && v <= this.lim.maxCoordinateMm ? v : 0; };
        const user = first.toLowerCase() === 'user';
        const w = dim(paperList.items[user ? 2 : 1]), h = dim(paperList.items[user ? 3 : 2]);
        if (w > 0 && h > 0) size = [w, h];
      }
      if (size) paper = flag(paperList, 'portrait') ? { width: Math.min(size[0], size[1]), height: Math.max(size[0], size[1]) } : { width: size[0], height: size[1] };
      else this.diags.add('info', 'PAPER_UNKNOWN', `Paper size "${first}" is not a known KiCad size; the sheet has no paper dimensions.`);
    }

    for (const item of root.items) {
      if (item.kind !== 'list' || listHead(item) !== 'lib_symbols') continue;
      for (const sym of childLists(item, 'symbol')) {
        const lib = this.libSymbol(sym);
        if (this.libs.has(lib.name)) this.diags.count('warning', 'LIB_SYMBOL_DUPLICATE', lib.name, (n) => `Library symbol "${lib.name}" is defined ${n + 1} times in lib_symbols; the first definition is used.`);
        else this.libs.set(lib.name, lib);
      }
    }

    const def: SchSheetDef = {
      id: this.key, name: fileStem(this.fileName), file: this.fileName, title: titleBlock.title ?? '', titleBlock,
      symbols: [], wires: [], buses: [], busEntries: [], junctions: [], noConnects: [], labels: [], sheetRefs: [], graphics: [],
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    };
    if (uuid !== undefined) def.uuid = uuid;
    if (paper) def.paper = paper;
    const out: ParsedFile = {
      key: this.key, version, def, diags: this.diags, symInst: [], symUuid: [], refPages: [],
      v6Symbols: new Map(), v6Sheets: new Map(), children: [],
    };
    const box = new Box();
    const lim = this.lim;

    for (const item of root.items) {
      if (item.kind !== 'list') continue;
      const head = listHead(item);
      switch (head) {
        case 'version': case 'generator': case 'generator_version': case 'uuid': case 'paper': case 'title_block': case 'lib_symbols':
        case 'embedded_fonts': case 'embedded_files': case undefined: break;
        case 'symbol_instances':
          for (const p of childLists(item, 'path')) {
            const path = str(p.items[1]), ref = str(childList(p, 'reference')?.items[1]);
            if (path === undefined || ref === undefined) continue;
            const u = bareAtom(childList(p, 'unit')?.items[1]);
            out.v6Symbols.set(path, { ref, unit: u !== undefined && /^\d+$/.test(u) ? Number(u) : null });
          }
          break;
        case 'sheet_instances':
          for (const p of childLists(item, 'path')) { const path = str(p.items[1]), page = str(childList(p, 'page')?.items[1]); if (path !== undefined && page !== undefined) out.v6Sheets.set(path, page); }
          break;
        case 'wire': case 'bus': {
          const pts = this.pts(item, head, 2, 2);
          const target = head === 'wire' ? def.wires : def.buses;
          if (target.length >= lim.maxWiresPerDef) throw fail(`The sheet has more than ${lim.maxWiresPerDef} ${head === 'wire' ? 'wires' : 'buses'}.`, 'LIMIT_EXCEEDED');
          target.push({ id: this.takeId(item, head).id, a: pts[0]!, b: pts[1]! });
          box.add(pts[0]!); box.add(pts[1]!);
          break;
        }
        case 'bus_entry': {
          const at = this.at(item, 'bus_entry');
          const size = childList(item, 'size');
          if (!size || size.items.length !== 3) throw fail(`bus_entry needs (size dx dy) (line ${item.line}).`);
          const to = { x: snap(at.x + this.coord(size.items[1], 'bus_entry size x', size)), y: snap(at.y + this.coord(size.items[2], 'bus_entry size y', size)) };
          def.busEntries.push({ id: this.takeId(item, 'bus_entry').id, at: { x: at.x, y: at.y }, to });
          box.addXY(at.x, at.y); box.add(to);
          break;
        }
        case 'junction': case 'no_connect': {
          const at = this.at(item, head);
          const p = { x: at.x, y: at.y };
          (head === 'junction' ? def.junctions : def.noConnects).push({ id: this.takeId(item, head).id, at: p });
          box.add(p);
          break;
        }
        case 'label': case 'global_label': case 'hierarchical_label': {
          const label = this.label(item, head === 'label' ? 'local' : head === 'global_label' ? 'global' : 'hierarchical');
          if (label) { def.labels.push(label); box.add(label.at); }
          break;
        }
        case 'symbol': {
          if (def.symbols.length >= lim.maxSymbolsPerDef) throw fail(`The sheet has more than ${lim.maxSymbolsPerDef} symbols.`, 'LIMIT_EXCEEDED');
          const { symbol, records, uuid: raw } = this.symbol(item, this.libs);
          def.symbols.push(symbol); out.symInst.push(records); out.symUuid.push(raw);
          box.merge(symbol.bounds);
          break;
        }
        case 'sheet': {
          if (def.sheetRefs.length >= lim.maxInstances) throw fail(`The sheet has more than ${lim.maxInstances} sheet symbols.`, 'LIMIT_EXCEEDED');
          const { ref, pages } = this.sheet(item);
          def.sheetRefs.push(ref); out.refPages.push(pages); out.children.push(null);
          box.add(ref.at); box.addXY(ref.at.x + ref.size.x, ref.at.y + ref.size.y);
          for (const p of ref.pins) box.add(p.at);
          break;
        }
        case 'polyline': case 'rectangle': case 'circle': case 'arc': case 'text': {
          const g = this.place(this.shape(item, head, false), IDENTITY);
          def.graphics.push(g); box.graphic(g);
          break;
        }
        default: this.noteUnknown(item, head, head === 'bus_alias' ? 'warning' : 'info', head === 'bus_alias' ? 'bus aliases are not expanded, so bus members named by an alias are not connected' : 'not represented in the schematic model');
      }
    }
    for (const [head, u] of this.unknown) {
      this.diags.add(u.severity, 'UNKNOWN_RECORD', `Ignored ${u.count} "${head}" record${u.count === 1 ? '' : 's'} (${u.note}).`, u.at);
    }
    this.diags.flush();
    const fallback = def.paper ? { minX: 0, minY: 0, maxX: def.paper.width, maxY: def.paper.height } : def.bounds;
    def.bounds = box.bounds(fallback);
    return out;
  }
}

const baseName = (file: string): string => file.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.').pop() ?? '';
function fileStem(file: string): string {
  const base = baseName(file);
  return base.replace(/\.kicad_sch$/i, '') || base;
}

// ---------------------------------------------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------------------------------------------

/** True when the bytes, after an optional UTF-8 BOM and whitespace, start with `(kicad_sch` followed by a delimiter. */
export function sniffKicadSch(data: Uint8Array): boolean {
  let i = 0;
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) i = 3;
  const space = (): void => { while (i < data.length && (data[i] === 32 || (data[i]! >= 9 && data[i]! <= 13))) i++; };
  space();
  if (data[i] !== 40) return false;
  i++;
  space();
  for (const ch of 'kicad_sch') if (data[i++] !== ch.charCodeAt(0)) return false;
  return i >= data.length || data[i]! <= 32 || data[i] === 40 || data[i] === 41;
}

// ---------------------------------------------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------------------------------------------

function normalizeRef(file: string): { base: string; norm: string; hasDir: boolean } {
  const parts = file.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  return { base: (parts[parts.length - 1] ?? '').toLowerCase(), norm: parts.join('/').toLowerCase(), hasDir: parts.length > 1 };
}

const has = (record: Record<string, Uint8Array> | undefined, key: string): boolean => !!record && Object.prototype.hasOwnProperty.call(record, key);

export function parseKicadSchWithLimits(input: SchematicInput, overrides: Partial<SchematicLimits> = {}): Schematic | null {
  if (!sniffKicadSch(input.data)) return null;
  const lim: SchematicLimits = { ...SCHEMATIC_LIMITS, ...overrides };
  const budget: Budget = { nodes: lim.maxExpression };
  const decoder = new TextDecoder('utf-8');

  const load = (bytes: Uint8Array, key: string, fileName: string): ParsedFile => {
    if (bytes.length > MAX_FILE_BYTES) throw fail(`Schematic file "${fileName}" is ${bytes.length} bytes; the limit is ${MAX_FILE_BYTES} bytes.`, 'LIMIT_EXCEEDED');
    return new FileParser(lim, key, fileName, budget).parse(decoder.decode(bytes));
  };

  const rootKey = baseName(input.name).toLowerCase() || 'schematic.kicad_sch';
  const root = load(input.data, rootKey, input.name);
  const parsed = new Map<string, ParsedFile>([[rootKey, root]]);
  const failed = new Map<string, { code: SchematicErrorCode; message: string }>();
  const refPaths = new Map<string, Set<string>>();

  // Discovery: parse every companion reachable by basename; ambiguity can only be judged once all references are known.
  const queue = [root];
  for (let q = 0; q < queue.length; q++) {
    for (const ref of queue[q]!.def.sheetRefs) {
      const { base, norm } = normalizeRef(ref.file);
      let set = refPaths.get(base);
      if (!set) refPaths.set(base, (set = new Set()));
      set.add(norm);
      if (!base || parsed.has(base) || failed.has(base) || !has(input.companions, base)) continue;
      const bytes = input.companions![base]!;
      try {
        if (!sniffKicadSch(bytes)) throw new SchematicError('The file is not a KiCad s-expression schematic (it does not start with "(kicad_sch").', 'INVALID_FORMAT', 'kicad-sch');
        const child = load(bytes, base, ref.file);
        parsed.set(base, child);
        if (parsed.size > lim.maxSheetDefs) throw fail(`The hierarchy has more than ${lim.maxSheetDefs} sheet definitions (files).`, 'LIMIT_EXCEEDED');
        queue.push(child);
      } catch (error) {
        if (!(error instanceof SchematicError)) throw error;
        if (error.code === 'LIMIT_EXCEEDED' || error.code === 'ABORTED') throw new SchematicError(`${ref.file}: ${error.message}`, error.code, 'kicad-sch');
        failed.set(base, { code: error.code, message: error.message });
      }
    }
  }

  // Resolution and cycle detection (iterative DFS; first visit defines the definition order).
  const order: string[] = [rootKey];
  const state = new Map<string, 1 | 2>([[rootKey, 1]]);
  const stack: Array<{ key: string; next: number }> = [{ key: rootKey, next: 0 }];
  const flattened = new Set<string>();
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const pf = parsed.get(frame.key)!;
    if (frame.next >= pf.def.sheetRefs.length) { state.set(frame.key, 2); stack.pop(); continue; }
    const index = frame.next++;
    const ref = pf.def.sheetRefs[index]!;
    const { base, norm, hasDir } = normalizeRef(ref.file);
    let child: string | null = null;
    if (!base || !refPaths.has(base)) pf.diags.add('warning', 'SHEET_FILE_MISSING', `Sheet "${ref.name}" refers to "${ref.file}", which is not a usable file name.`, ref.at);
    else if ((refPaths.get(base)?.size ?? 0) > 1) {
      pf.diags.add('warning', 'SHEET_FILE_AMBIGUOUS', `Sheet "${ref.name}" refers to "${ref.file}", but the hierarchy uses several paths ending in "${base}" (${[...refPaths.get(base)!].sort().join(', ')}) and only same-directory companions are loaded; the sheet was not loaded.`, ref.at);
    } else if (parsed.has(base)) {
      child = base;
      if (hasDir && !flattened.has(`${frame.key}\u0000${norm}`)) {
        flattened.add(`${frame.key}\u0000${norm}`);
        pf.diags.add('info', 'SHEET_FILE_PATH_FLATTENED', `Sheet file "${ref.file}" was resolved by its basename "${base}" (the directory part is ignored).`, ref.at);
      }
    } else if (failed.has(base)) {
      const f = failed.get(base)!;
      pf.diags.add('error', f.code === 'UNSUPPORTED_VARIANT' ? 'SHEET_FILE_UNSUPPORTED' : 'SHEET_FILE_INVALID', `Sheet file "${ref.file}" could not be read: ${f.message}`, ref.at);
    } else pf.diags.add('warning', 'SHEET_FILE_MISSING', `Sheet "${ref.name}" refers to "${ref.file}", which was not provided with the schematic.`, ref.at);
    pf.children[index] = child;
    if (!child) continue;
    ref.defId = child;
    const st = state.get(child);
    if (st === 1) {
      const chain = [...stack.map((f) => f.key), child];
      throw fail(`The sheet hierarchy contains a cycle: ${chain.slice(chain.indexOf(child)).join(' -> ')}.`);
    }
    if (st === 2) continue;
    if (stack.length > lim.maxNestingDepth) throw fail(`The sheet hierarchy is nested deeper than ${lim.maxNestingDepth} levels.`, 'LIMIT_EXCEEDED');
    state.set(child, 1);
    order.push(child);
    stack.push({ key: child, next: 0 });
  }
  if (order.length > lim.maxSheetDefs) throw fail(`The hierarchy has more than ${lim.maxSheetDefs} sheet definitions (files).`, 'LIMIT_EXCEEDED');

  // Expansion into instances, preorder.
  const instances: SchSheetInstance[] = [];
  const byPath = new Map<string, SchSheetInstance>();
  const pathsByKey = new Map<string, string[]>();
  const meta = new Map<string, { key: string; refIndex: number }>();
  const todo: Array<{ key: string; path: string; parent: string | null; refIndex: number; name: string; depth: number }> = [{ key: rootKey, path: '', parent: null, refIndex: -1, name: root.def.name, depth: 0 }];
  while (todo.length > 0) {
    const t = todo.pop()!;
    if (instances.length >= lim.maxInstances) throw fail(`The expanded hierarchy has more than ${lim.maxInstances} sheet instances.`, 'LIMIT_EXCEEDED');
    if (t.depth > lim.maxNestingDepth) throw fail(`The sheet hierarchy is nested deeper than ${lim.maxNestingDepth} levels.`, 'LIMIT_EXCEEDED');
    const pf = parsed.get(t.key)!;
    const parentRef = t.parent === null ? null : parsed.get(meta.get(t.parent)!.key)!.def.sheetRefs[t.refIndex]!;
    const inst: SchSheetInstance = { path: t.path, defId: t.key, name: t.name, page: '', parentPath: t.parent, sheetRefId: parentRef ? parentRef.id : null, childPaths: [], depth: t.depth };
    instances.push(inst);
    byPath.set(t.path, inst);
    meta.set(t.path, { key: t.key, refIndex: t.refIndex });
    if (t.parent !== null) byPath.get(t.parent)!.childPaths.push(t.path);
    const list = pathsByKey.get(t.key);
    if (list) list.push(t.path); else pathsByKey.set(t.key, [t.path]);
    for (let i = pf.def.sheetRefs.length - 1; i >= 0; i--) {
      const child = pf.children[i];
      if (!child) continue;
      const r = pf.def.sheetRefs[i]!;
      todo.push({ key: child, path: `${t.path}/${r.id}`, parent: t.path, refIndex: i, name: r.name, depth: t.depth + 1 });
    }
  }

  // Budget on the expanded output: pins and symbol placements over every instance.
  let pinTotal = 0;
  let placements = 0;
  for (const key of order) {
    const pf = parsed.get(key)!;
    const n = pathsByKey.get(key)?.length ?? 0;
    let pins = 0;
    for (const s of pf.def.symbols) pins += s.pins.length;
    pinTotal += pins * n;
    placements += pf.def.symbols.length * n;
    if (pinTotal > lim.maxPinsTotal || placements > lim.maxPinsTotal) throw fail(`The expanded hierarchy has more than ${lim.maxPinsTotal} symbol pins or placements across all sheet instances.`, 'LIMIT_EXCEEDED');
  }

  // Per-instance references and pages.
  const rootUuid = root.def.uuid;
  const project = root.def.name;
  const pick = <T extends { project: string }>(records: T[], match: (r: T) => boolean): T | undefined => {
    let first: T | undefined;
    for (const r of records) { if (!match(r)) continue; if (r.project === project) return r; first ??= r; }
    return first;
  };
  for (const key of order) {
    const pf = parsed.get(key)!;
    const paths = pathsByKey.get(key) ?? [];
    let missing = 0, mismatch = 0;
    for (let i = 0; i < pf.def.symbols.length; i++) {
      const sym = pf.def.symbols[i]!;
      const recs = pf.symInst[i]!;
      const uuid = pf.symUuid[i];
      let byTarget: Map<string, InstRec> | null = null;
      if (recs.length > 8) {
        byTarget = new Map();
        for (const r of recs) { const prev = byTarget.get(r.path); if (!prev || (r.project === project && prev.project !== project)) byTarget.set(r.path, r); }
      }
      const hasData = recs.length > 0 || root.v6Symbols.size > 0;
      for (const p of paths) {
        let found: { ref: string; unit: number | null } | undefined;
        if (rootUuid !== undefined) found = byTarget ? byTarget.get(`/${rootUuid}${p}`) : pick(recs, (r) => r.path === `/${rootUuid}${p}`);
        if (!found && uuid) found = root.v6Symbols.get(`${p}/${uuid}`);
        if (found) {
          sym.instances[p] = { ref: found.ref, unit: found.unit ?? sym.unit };
          if (found.unit !== null && found.unit !== sym.unit) mismatch++;
          if (found.ref.startsWith('#')) sym.virtual = true;
        } else {
          sym.instances[p] = { ref: sym.refDefault, unit: sym.unit };
          if (hasData || paths.length > 1) missing++;
        }
      }
    }
    if (missing > 0) pf.diags.add('warning', 'INSTANCE_DATA_MISSING', `${missing} symbol placement(s) have no instance data for their sheet path; the stored reference was used (repeated sheets would show identical references).`);
    if (mismatch > 0) pf.diags.add('warning', 'INSTANCE_UNIT_MISMATCH', `${mismatch} symbol placement(s) have an instance unit that differs from the placed unit; pins and graphics follow the placed unit.`);
  }

  instances.forEach((inst, index) => {
    const m = meta.get(inst.path)!;
    let page: string | undefined;
    if (inst.path === '') page = root.v6Sheets.get('/');
    else if (rootUuid !== undefined) {
      const parentPf = parsed.get(meta.get(inst.parentPath!)!.key)!;
      const records = parentPf.refPages[m.refIndex]!;
      const parentTarget = `/${rootUuid}${inst.parentPath}`;
      page = (pick(records, (r) => r.path === parentTarget) ?? pick(records, (r) => r.path === `${parentTarget}/${inst.sheetRefId}`))?.page;
    }
    page ??= root.v6Sheets.get(inst.path === '' ? '/' : inst.path);
    inst.page = page ?? String(index + 1);
  });

  const defs = order.map((key) => parsed.get(key)!.def);
  return {
    format: 'kicad-sch',
    formatLabel: `KiCad schematic (version ${root.version})`,
    sourceUnit: 'mm',
    name: root.def.name,
    defs,
    rootDefId: rootKey,
    instances,
    diagnostics: order.flatMap((key) => parsed.get(key)!.diags.list),
  };
}

export const parseKicadSch: SchematicParser = (input) => parseKicadSchWithLimits(input);
