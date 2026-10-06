/**
 * Schematic connectivity engine: `Schematic` (model.ts) in, `SchConnectivity` out. Pure and deterministic (identical
 * input gives identical ids and ordering; the result is plain JSON-like data, no Maps/classes).
 *
 * Every rule below cites the published KiCad 9 user manual, chapter "Schematic Editor"
 * (https://docs.kicad.org/9.0/en/eeschema/eeschema.html). The manual is the only source of these semantics: no
 * implementation of any EDA tool was consulted. Where the manual is silent the choice is conservative ("reject, don't
 * guess": an unproven connection is NOT made and a diagnostic says so) and is stated next to the rule.
 *
 * GEOMETRY (formats without `declaredNets`; computed once per sheet DEFINITION, then expanded per sheet INSTANCE)
 *  - Tolerance: points closer than 1e-3 mm (1 um, Chebyshev) coincide. Points are quantised to a 1e-3 mm grid and the
 *    9 neighbouring cells are searched, so a pair 1 um apart is never missed because of a cell boundary. The manual
 *    requires exact coincidence ("#wires": "Wires connect with other wires or pins only if their ends coincide
 *    exactly"); 1 um only absorbs float noise from mil/rotation conversion, far below any real grid (1 mil = 25.4 um).
 *    Pairs between 1 and 2 um apart are unspecified; anything >= 2 um apart never connects.
 *  - Wire end / wire end, wire end / pin tip, pin tip / pin tip, wire end / sheet-pin tip at one point: connected
 *    ("#wires"). Pins of different symbols whose tips coincide are therefore connected (same rule as the manual's
 *    stacked pins, "#no-connection-symbols": "symbol pins that are stacked on top of each other are normally
 *    connected to the same net"); an info diagnostic PINS_COINCIDE reports the sites because it is often a layout slip.
 *  - Wires crossing at interior points WITHOUT a junction: NOT connected ("#wires": "if a wire crosses the middle of
 *    another wire, a connection will not be made"; "#wire-junctions": "Wires that cross are not implicitly connected").
 *  - A junction joins everything at its point, including wires that only pass through it ("#wire-junctions": "explicitly
 *    adding a junction dot"; toolbar text: a junction "connects two crossing wires or a wire and a pin").
 *  - A wire END landing on another wire's interior (T): connected ("#wire-junctions": "Junction dots will be
 *    automatically added to wires that start or end on top of an existing wire", i.e. the editor treats it as a join).
 *    Collinear overlapping wires connect through the same rule (an end of one lies inside the other).
 *  - A pin / sheet-pin TIP on a wire interior needs a junction (toolbar text: junction "connects ... a wire and a pin,
 *    which can sometimes be ambiguous without a junction"). Without one it is NOT connected and PIN_ON_WIRE_NO_JUNCTION
 *    is reported (a silent short would be worse than a visible gap).
 *  - Labels attach to the conductor at their anchor (end, interior, or pin tip). A label whose anchor touches two
 *    wires that are not otherwise connected (a crossing) attaches to NEITHER and LABEL_AMBIGUOUS is reported (ERC
 *    "Label connects more than one wire": "it is not possible to determine which net the label should connect to").
 *  - Bus ENTRIES carry no connectivity at all ("#connections-between-bus-members": "Bus entries ... are graphical only,
 *    and are not necessary to form logical connections"; toolbar text: "do not create a connection"). A wire never
 *    connects to a bus ("It is not possible to connect a pin directly to a bus; this type of connection will be ignored").
 *  - No-connect flags ("#no-connection-symbols") keep a pin on its own: a pin at a flag (or of electrical type
 *    no_connect, which the manual says behaves the same for stacked pins) is not joined to anything sharing its point,
 *    unless a wire end / sheet pin / junction also sits there: then it stays connected (the wire is physically
 *    attached) and NO_CONNECT_CONFLICT is reported (ERC "A pin with a 'no connection' flag is connected").
 *
 * NAMES
 *  - Local labels connect only inside one sheet INSTANCE ("#labels": "only make connections within a sheet"). Equal
 *    names of any label type connect inside one sheet ("Labels that have the same name will connect, regardless of the
 *    label type, if they are in the same sheet"; ERC "Local and global labels have the same name" confirms a local and
 *    a global label of equal name connect on the same sheet and not across sheets).
 *  - Global labels are design-wide ("Global labels make connections anywhere in a schematic, regardless of sheet").
 *    Power symbols are design-wide by their net name ("#power-symbols": "two power symbols with the Value connect to
 *    each other anywhere in the schematic, regardless of sheet"); they do NOT join a local label of equal name
 *    (the manual lists no such rule). Hidden power-input pins (`SchPin.implicitNet`) tie to the global net of their
 *    name ("#hidden-power-pins"); on a symbol that has `power` the symbol value wins and the pin name is ignored
 *    ("Beginning in KiCad 8 ... the global connection is made based on the power symbol's value").
 *  - Hierarchy ("#hierarchical-labels", "#hierarchical-sheet-pins"): a sheet pin joins the hierarchical label of the
 *    same name inside the sheet it belongs to, at THAT instance only (child path = parent path + '/' + sheetRef.id).
 *    A repeated sub-sheet therefore yields separate local nets and separate pin keys per instance. Missing child file
 *    (`defId` null): the sheet pin dangles, SHEET_CHILD_MISSING. Unmatched pin/label pairs: SHEET_PIN_UNMATCHED /
 *    HIER_LABEL_UNMATCHED (ERC "Mismatch between hierarchical labels and sheet pins").
 *  - Net name priority ("#net-name-assignment-rules"): global labels > power symbols > local labels > hierarchical labels
 *    > sheet pins; several names of one type: sorted alphabetically (UTF-16 code-unit order), the first wins; a net
 *    crossing sheets takes its name from the highest level of the hierarchy that has a local or hierarchical label
 *    (local before hierarchical at equal level). All names stay in `aliases`. Two different names among the global
 *    labels/power symbols of one net, or among the labels of one sheet instance, give NET_NAME_CONFLICT (ERC "More than
 *    one name given to this bus or net"); nothing is dropped.
 *  - Names are not qualified with the sheet path (the manual's "/NAME" prefix is a netlist presentation): `name` is the
 *    bare label text, `scope`/`scopePath` carry the sheet. Automatic names follow the usual `Net-(R1-Pad2)` style
 *    (documented by users; the manual only says "automatically generated based on the connected symbol pins"); the pin
 *    chosen is the first member in natural order of (reference, pin number).
 *
 * BUSES ("#buses", "#bus-members", "#connections-between-bus-members", "#bus-aliases")
 *  - Vector `PREFIX[M..N]` (either order, both >= 0), group `NAME{A B C[0..3]}` with `NAME.` prefix on every member,
 *    aliases through `options.busAliases` (the model carries no alias table; an unknown `{USB}` is read as the signal
 *    "USB"). `~{...}` overbar spans are not groups. Bus segments connect to bus segments and bus labels by the same
 *    geometry rules as wires, in a separate domain from wires.
 *  - A bus does not short its members: member nets are joined only by NAME (a wire labelled D3 and the bus member D3
 *    of the same scope). The bus matters at a sheet pin: the members of the parent bus join the members of the sheet
 *    pin's bus name position by position, which are the child's hierarchical bus-label members ("#bus-aliases" example
 *    with parent prefix `USB1.` and child prefix `UB.`).
 *
 * MULTI-UNIT / IDENTITY (ERC "Different net assigned to a shared pin in another unit", "Duplicate pins with different nets")
 *  - Pins with the same number on the same annotated reference are ONE physical pin: one net member per (ref, pin
 *    number), and their nets are merged (MULTI_UNIT_PIN_MISMATCH warns when that merge joins nets that were different).
 *    A reference shared by different parts, or by the same unit twice, gives DUPLICATE_REFERENCE and no identity merge;
 *    unannotated references (empty or containing '?') are never merged. Virtual symbols (power, flags) are never members.
 *
 * DECLARED CONNECTIVITY (EAGLE): nets = declared names (same name on several sheets = one net), members from the
 * declared pins; geometry is never used to merge them. A declared net with zero pins is kept when it has wires (a
 * labelled stub is a net). Wires listed by the source in `SchDeclaredNet.wires` are attributed as declared (a wire listed
 * in two nets: first wins, WIRE_IN_MULTIPLE_NETS). Wires the source does not list are attributed only when every declared
 * pin touching their wire group, or else every label naming the group, agrees on one net; otherwise they stay unattributed.
 *
 * Budgets: SCHEMATIC_LIMITS are enforced (SchematicError 'LIMIT_EXCEEDED'); `options.signal` aborts with SchematicError
 * 'ABORTED'. Work is near-linear: spatial hashing for point coincidence, a coarse segment grid for interior tests.
 */
import { SCHEMATIC_LIMITS, SchematicError, pinKey, symbolRef, wireKey } from './model';
import type {
  SchConnectivity, SchDiagnostic, SchLabel, SchLabelKind, SchNet, SchNetMember, SchPoint, SchSheetDef, SchSheetInstance,
  SchSheetRef, SchSymbol, Schematic,
} from './model';

export interface ConnectivityOptions {
  signal?: AbortSignal;
  /** KiCad bus aliases ("#bus-aliases"): alias name -> member tokens (signals or vector buses). The model does not carry them. */
  busAliases?: Record<string, readonly string[]>;
}

/** Points closer than this (mm, Chebyshev) coincide. */
export const CONNECTIVITY_TOLERANCE_MM = 1e-3;

const TOL = CONNECTIVITY_TOLERANCE_MM;
const NEAR = TOL + 1e-9;
const GRID = 1 / TOL;
const SEG_CELL = 5.08;
const KEY_RANGE = 2 ** 25;
const KEY_SPAN = 2 ** 26;
const WIRE_SHIFT = 2 ** 20;
const MAX_BUS_MEMBERS = 8192;
const DIAG_CAP = 100;

// ---------------------------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------------------------

/** Natural order: digit runs compare by value ("R2" < "R10"), everything else by UTF-16 code unit. Locale independent. */
export function naturalCompare(a: string, b: string): number {
  const la = a.length, lb = b.length;
  let i = 0, j = 0;
  while (i < la && j < lb) {
    const ca = a.charCodeAt(i), cb = b.charCodeAt(j);
    if (ca >= 48 && ca <= 57 && cb >= 48 && cb <= 57) {
      const si = i, sj = j;
      while (i < la && a.charCodeAt(i) >= 48 && a.charCodeAt(i) <= 57) i++;
      while (j < lb && b.charCodeAt(j) >= 48 && b.charCodeAt(j) <= 57) j++;
      let zi = si, zj = sj;
      while (zi < i - 1 && a.charCodeAt(zi) === 48) zi++;
      while (zj < j - 1 && b.charCodeAt(zj) === 48) zj++;
      if (i - zi !== j - zj) return i - zi < j - zj ? -1 : 1;
      for (let k = 0; k < i - zi; k++) {
        const da = a.charCodeAt(zi + k), db = b.charCodeAt(zj + k);
        if (da !== db) return da < db ? -1 : 1;
      }
      continue;
    }
    if (ca !== cb) return ca < cb ? -1 : 1;
    i++; j++;
  }
  if (la - i !== lb - j) return la - i < lb - j ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function cellKey(cx: number, cy: number): number | string {
  return cx > -KEY_RANGE && cx < KEY_RANGE && cy > -KEY_RANGE && cy < KEY_RANGE ? (cx + KEY_RANGE) * KEY_SPAN + (cy + KEY_RANGE) : `${cx},${cy}`;
}

const validPoint = (p: SchPoint | undefined | null): p is SchPoint =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= SCHEMATIC_LIMITS.maxCoordinateMm && Math.abs(p.y) <= SCHEMATIC_LIMITS.maxCoordinateMm;

class Dsu {
  readonly parent: Int32Array;
  constructor(n: number) { this.parent = new Int32Array(n); for (let i = 0; i < n; i++) this.parent[i] = i; }
  find(x: number): number {
    const p = this.parent;
    while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent[rb] = ra; else this.parent[ra] = rb;
  }
}

/** Collects diagnostics with a per-code cap so a pathological sheet cannot flood the result. */
class Diagnostics {
  readonly list: SchDiagnostic[] = [];
  private readonly counts = new Map<string, number>();
  constructor(private readonly discard = false) {}
  add(d: SchDiagnostic): void {
    const n = this.counts.get(d.code) ?? 0;
    this.counts.set(d.code, n + 1);
    if (!this.discard && n < DIAG_CAP) this.list.push(d);
  }
  finish(): SchDiagnostic[] {
    const out = this.list.slice();
    for (const [code, n] of this.counts) {
      if (n > DIAG_CAP) out.push({ severity: 'info', code: 'DIAGNOSTICS_SUPPRESSED', message: `${n - DIAG_CAP} further ${code} diagnostics were suppressed (${n} in total).` });
    }
    return out;
  }
}

class Env {
  readonly diag = new Diagnostics();
  private ticks = 0;
  constructor(readonly signal: AbortSignal | undefined, readonly aliases: Record<string, readonly string[]> | undefined) {}
  check(): void {
    if (this.signal?.aborted) throw new SchematicError('Connectivity computation was aborted.', 'ABORTED');
  }
  tick(): void { if ((++this.ticks & 8191) === 0) this.check(); }
}

// ---------------------------------------------------------------------------------------------------------------
// Bus label syntax ("#bus-members")
// ---------------------------------------------------------------------------------------------------------------

export type BusLabelParse = { kind: 'plain' } | { kind: 'bus'; members: string[] } | { kind: 'invalid'; reason: string };

const BAR = '~\\{[^{}]*\\}';
/**
 * KiCad's escape tokens for characters a net name cannot hold raw (the label VPP/MCLR is stored as "VPP{slash}MCLR", exactly as the
 * board's net name carries it): literal text like an overbar span, never group syntax (W-open-sch-02).
 */
const ESCAPE = '\\{(?:dblquote|quote|lt|gt|backslash|slash|bar|comma|colon|space|dollar|tab|return|brace)\\}';
const OPAQUE = `${BAR}|${ESCAPE}`;
const VECTOR_RE = /^([^\s[\]{}]+)\[(\d{1,9})\.\.(\d{1,9})\]$/;
/**
 * Inside the group pattern an escape token directly after "~" is not offered again: the "~{...}" span in front of it already covers
 * it, and reading the same text as "~" followed by the token gave every such pair two parses, so a long run of "~{slash}" took
 * exponential time to reject. The accepted texts and the captured groups are unchanged; each text now has one parse per split point.
 */
const GROUP_OPAQUE = `${BAR}|(?<!~)${ESCAPE}`;
const GROUP_RE = new RegExp(`^((?:${GROUP_OPAQUE}|[^\\s{}])*)\\{((?:${GROUP_OPAQUE}|[^{}])*)\\}$`);
const OPAQUE_RE = new RegExp(OPAQUE, 'g');
/**
 * Connection identity of a net name. KiCad treats "{slash}" and "/" as the same character: one real design carries the label VPP/MCLR written
 * both ways on one sheet, and the board holds a single net "/VPP{slash}MCLR" with the pins of both (W-open-sch-02). Only this token is folded,
 * because it is the one the real files show; the displayed name and the aliases keep the text as written.
 */
const connectionName = (text: string): string => text.replace(/\{slash\}/g, '/');

function expandVector(prefix: string, a: number, b: number, out: string[]): boolean {
  if (out.length + Math.abs(a - b) + 1 > MAX_BUS_MEMBERS) return false;
  const step = a <= b ? 1 : -1;
  for (let k = a; ; k += step) { out.push(`${prefix}${k}`); if (k === b) break; }
  return true;
}

function expandToken(token: string, aliases: Record<string, readonly string[]> | undefined, depth: number, out: string[]): string | null {
  const alias = aliases && Object.prototype.hasOwnProperty.call(aliases, token) ? aliases[token] : undefined;
  if (alias) {
    if (depth >= 8) return 'bus alias nesting is too deep';
    for (const inner of alias) { const e = expandToken(inner, aliases, depth + 1, out); if (e) return e; }
    return null;
  }
  const v = VECTOR_RE.exec(token);
  if (v) return expandVector(v[1], Number(v[2]), Number(v[3]), out) ? null : 'bus is too large';
  if (/[[\]{}]/.test(token.replace(OPAQUE_RE, ''))) return `unsupported bus member "${token}"`;
  out.push(token);
  return out.length > MAX_BUS_MEMBERS ? 'bus is too large' : null;
}

/**
 * Interprets label text per the manual ("#bus-members"): `D[0..7]` / `D[7..0]` (vector), `NAME{A B C[0..3]}` (group,
 * members prefixed `NAME.`), anything else is a plain net name. Returns the expanded member names in written order.
 */
export function parseBusLabel(text: string, aliases?: Record<string, readonly string[]>): BusLabelParse {
  const t = text.trim();
  if (/[{}]/.test(t.replace(OPAQUE_RE, ''))) {
    const m = GROUP_RE.exec(t);
    if (!m) return { kind: 'invalid', reason: 'malformed group bus label' };
    const tokens = m[2].split(/\s+/).filter(Boolean);
    const raw: string[] = [];
    for (const token of tokens) { const e = expandToken(token, aliases, 0, raw); if (e) return { kind: 'invalid', reason: e }; }
    const members = [...new Set(raw)].map(x => (m[1] ? `${m[1]}.${x}` : x));
    return members.length ? { kind: 'bus', members } : { kind: 'invalid', reason: 'empty group bus' };
  }
  const v = VECTOR_RE.exec(t);
  if (!v) return { kind: 'plain' };
  const members: string[] = [];
  return expandVector(v[1], Number(v[2]), Number(v[3]), members) ? { kind: 'bus', members } : { kind: 'invalid', reason: 'bus is too large' };
}

// ---------------------------------------------------------------------------------------------------------------
// Spatial structures
// ---------------------------------------------------------------------------------------------------------------

/** Points -> sites (1 um grid, 3x3 neighbour search, near sites merged). */
class SiteIndex {
  private xs: number[] = [];
  private ys: number[] = [];
  private parent: number[] = [];
  private readonly cells = new Map<number | string, number>();
  private find(a: number): number {
    const p = this.parent;
    while (p[a] !== a) { p[a] = p[p[a]]; a = p[a]; }
    return a;
  }
  add(x: number, y: number): number {
    const qx = Math.round(x * GRID), qy = Math.round(y * GRID);
    const own = cellKey(qx, qy);
    let id = -1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const s = this.cells.get(dx === 0 && dy === 0 ? own : cellKey(qx + dx, qy + dy));
        if (s === undefined) continue;
        if ((dx !== 0 || dy !== 0) && (Math.abs(this.xs[s] - x) > NEAR || Math.abs(this.ys[s] - y) > NEAR)) continue;
        if (id < 0) id = s;
        else {
          const ra = this.find(id), rb = this.find(s);
          if (ra !== rb) { if (ra < rb) this.parent[rb] = ra; else this.parent[ra] = rb; }
          id = Math.min(ra, rb);
        }
      }
    }
    if (id < 0) { id = this.xs.length; this.xs.push(x); this.ys.push(y); this.parent.push(id); }
    if (!this.cells.has(own)) this.cells.set(own, id);
    return id;
  }
  /** Raw ids -> dense site numbers (first appearance order) with one representative coordinate per site. */
  dense(): { map: Int32Array; count: number; x: Float64Array; y: Float64Array } {
    const n = this.xs.length;
    const map = new Int32Array(n), rootDense = new Int32Array(n).fill(-1);
    const x: number[] = [], y: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = this.find(i);
      if (rootDense[r] < 0) { rootDense[r] = x.length; x.push(this.xs[r]); y.push(this.ys[r]); }
      map[i] = rootDense[r];
    }
    return { map, count: x.length, x: Float64Array.from(x), y: Float64Array.from(y) };
  }
}

/** Coarse grid over segments for "which segments pass through this point" (interior hits). */
class SegIndex {
  private readonly cells = new Map<number | string, number[]>();
  private readonly long: number[] = [];
  size = 0;
  private put(cx: number, cy: number, i: number): void {
    const k = cellKey(cx, cy);
    const list = this.cells.get(k);
    if (!list) this.cells.set(k, [i]);
    else if (list[list.length - 1] !== i) list.push(i);
  }
  private box(ax: number, ay: number, bx: number, by: number, i: number): void {
    const x0 = Math.floor((Math.min(ax, bx) - TOL) / SEG_CELL), x1 = Math.floor((Math.max(ax, bx) + TOL) / SEG_CELL);
    const y0 = Math.floor((Math.min(ay, by) - TOL) / SEG_CELL), y1 = Math.floor((Math.max(ay, by) + TOL) / SEG_CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) this.put(cx, cy, i);
  }
  add(i: number, ax: number, ay: number, bx: number, by: number): void {
    this.size++;
    const w = Math.floor((Math.max(ax, bx) + TOL) / SEG_CELL) - Math.floor((Math.min(ax, bx) - TOL) / SEG_CELL) + 1;
    const h = Math.floor((Math.max(ay, by) + TOL) / SEG_CELL) - Math.floor((Math.min(ay, by) - TOL) / SEG_CELL) + 1;
    if (w * h <= 64) { this.box(ax, ay, bx, by, i); return; }
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / (SEG_CELL / 2));
    if (steps > 4096) { this.long.push(i); return; }
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps, t1 = (k + 1) / steps;
      this.box(ax + (bx - ax) * t0, ay + (by - ay) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1, i);
    }
  }
  /** Segments whose INTERIOR contains (x, y); segments having `site` as an end are excluded. */
  hits(x: number, y: number, site: number, ea: Int32Array, eb: Int32Array, xy: Float64Array, out: number[]): void {
    out.length = 0;
    const list = this.cells.get(cellKey(Math.floor(x / SEG_CELL), Math.floor(y / SEG_CELL)));
    if (list) for (const i of list) this.test(i, x, y, site, ea, eb, xy, out);
    for (const i of this.long) this.test(i, x, y, site, ea, eb, xy, out);
  }
  private test(i: number, px: number, py: number, site: number, ea: Int32Array, eb: Int32Array, xy: Float64Array, out: number[]): void {
    if (ea[i] === site || eb[i] === site || out.includes(i)) return;
    const ax = xy[4 * i], ay = xy[4 * i + 1], bx = xy[4 * i + 2], by = xy[4 * i + 3];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    if (len2 <= 0) return;
    if ((Math.abs(px - ax) <= NEAR && Math.abs(py - ay) <= NEAR) || (Math.abs(px - bx) <= NEAR && Math.abs(py - by) <= NEAR)) return;
    const t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t <= 0 || t >= 1) return;
    const cross = (px - ax) * dy - (py - ay) * dx;
    if (cross * cross <= TOL * TOL * len2) out.push(i);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Per-definition geometry
// ---------------------------------------------------------------------------------------------------------------

interface LabelItem { label: SchLabel; text: string; comps: number[] }
interface BusLabelItem { label: SchLabel; text: string; members: string[]; comps: number[] }
interface SheetPinItem {
  ref: number; name: string; at: SchPoint;
  /** Wire-domain component (plain names), -1 when the anchor is invalid or the name is a bus. */
  comp: number;
  bus: { members: string[]; comps: number[] } | null;
}
interface BusMembers { kind: SchLabelKind; members: string[] }

interface DefGeom {
  def: SchSheetDef;
  nComp: number;
  /** Conductor elements (wires, pins, sheet pins) per component. */
  compSize: Uint32Array;
  wireComp: Int32Array;
  symStart: Int32Array;
  pinSym: Int32Array;
  pinCount: number;
  pinComp: Int32Array;
  /** 1 = pin carries a no-connect flag / is of electrical type no_connect. */
  pinNc: Uint8Array;
  labels: LabelItem[];
  busLabels: BusLabelItem[];
  busCompMembers: Array<BusMembers | null>;
  sheetPins: SheetPinItem[];
  hierTexts: Set<string>;
}

const BAD_KINDS = ['wire', 'bus', 'pin', 'label', 'junction', 'no-connect flag', 'sheet pin'] as const;

function buildDefGeom(def: SchSheetDef, env: Env, diag: Diagnostics): DefGeom {
  const defId = def.id;
  const bad: Record<(typeof BAD_KINDS)[number], number> = { wire: 0, bus: 0, pin: 0, label: 0, junction: 0, 'no-connect flag': 0, 'sheet pin': 0 };
  const W = def.wires.length, S = def.symbols.length;

  const wok = new Uint8Array(W), wxy = new Float64Array(W * 4);
  for (let w = 0; w < W; w++) {
    const { a, b } = def.wires[w];
    if (validPoint(a) && validPoint(b)) { wok[w] = 1; wxy[4 * w] = a.x; wxy[4 * w + 1] = a.y; wxy[4 * w + 2] = b.x; wxy[4 * w + 3] = b.y; } else bad.wire++;
  }

  const symStart = new Int32Array(S + 1);
  let P = 0;
  for (let s = 0; s < S; s++) { symStart[s] = P; P += def.symbols[s].pins.length; }
  symStart[S] = P;
  const pinSym = new Int32Array(P), px = new Float64Array(P), py = new Float64Array(P);
  const pok = new Uint8Array(P), pinNc = new Uint8Array(P), pinTypeNc = new Uint8Array(P);
  for (let s = 0; s < S; s++) {
    const pins = def.symbols[s].pins;
    for (let k = 0; k < pins.length; k++) {
      const p = symStart[s] + k, pin = pins[k];
      pinSym[p] = s;
      if (validPoint(pin.at)) { pok[p] = 1; px[p] = pin.at.x; py[p] = pin.at.y; } else bad.pin++;
      if (pin.type === 'no_connect') pinTypeNc[p] = 1;
    }
  }

  // Classify labels and sheet pins: plain names live in the wire domain, bus syntax in the bus domain.
  const plainLabels: SchLabel[] = [], busLabelsRaw: Array<{ label: SchLabel; members: string[] }> = [];
  const hierTexts = new Set<string>();
  for (const label of def.labels) {
    const text = (label.text ?? '').trim();
    if (!text || !validPoint(label.at)) { bad.label++; continue; }
    if (label.kind === 'hierarchical') hierTexts.add(connectionName(text));
    const parsed = parseBusLabel(text, env.aliases);
    if (parsed.kind === 'plain') plainLabels.push(label);
    else if (parsed.kind === 'bus') busLabelsRaw.push({ label, members: parsed.members });
    else diag.add({ severity: 'warning', code: 'BUS_LABEL_INVALID', message: `Label "${text}" is not valid bus syntax (${parsed.reason}) and was ignored.`, defId, at: label.at });
  }
  const shRaw: Array<{ ref: number; name: string; at: SchPoint; bus: string[] | null; ok: boolean }> = [];
  for (let r = 0; r < def.sheetRefs.length; r++) {
    for (const sp of def.sheetRefs[r].pins) {
      const name = (sp.name ?? '').trim();
      const ok = !!name && validPoint(sp.at);
      if (!ok) { bad['sheet pin']++; continue; }
      const parsed = parseBusLabel(name, env.aliases);
      if (parsed.kind === 'invalid') { diag.add({ severity: 'warning', code: 'BUS_LABEL_INVALID', message: `Sheet pin "${name}" is not valid bus syntax (${parsed.reason}) and was ignored.`, defId, at: sp.at }); continue; }
      shRaw.push({ ref: r, name, at: sp.at, bus: parsed.kind === 'bus' ? parsed.members : null, ok });
    }
  }

  // ---- wire domain: sites
  const sites = new SiteIndex();
  const wa = new Int32Array(W).fill(-1), wb = new Int32Array(W).fill(-1);
  for (let w = 0; w < W; w++) if (wok[w]) { wa[w] = sites.add(wxy[4 * w], wxy[4 * w + 1]); wb[w] = sites.add(wxy[4 * w + 2], wxy[4 * w + 3]); }
  env.tick();
  const pSite = new Int32Array(P).fill(-1);
  for (let p = 0; p < P; p++) if (pok[p]) pSite[p] = sites.add(px[p], py[p]);
  const wireSheetPins = shRaw.filter(sp => !sp.bus);
  const spSite = wireSheetPins.map(sp => sites.add(sp.at.x, sp.at.y));
  const jSite: number[] = [], ncSite: number[] = [];
  for (const j of def.junctions) { if (validPoint(j.at)) jSite.push(sites.add(j.at.x, j.at.y)); else bad.junction++; }
  for (const n of def.noConnects) { if (validPoint(n.at)) ncSite.push(sites.add(n.at.x, n.at.y)); else bad['no-connect flag']++; }
  const lSite = plainLabels.map(l => sites.add(l.at.x, l.at.y));
  const dn = sites.dense();
  const SC = dn.count;
  for (let w = 0; w < W; w++) if (wok[w]) { wa[w] = dn.map[wa[w]]; wb[w] = dn.map[wb[w]]; }
  for (let p = 0; p < P; p++) if (pok[p]) pSite[p] = dn.map[pSite[p]];
  for (let q = 0; q < spSite.length; q++) spSite[q] = dn.map[spSite[q]];

  const wireEnds = new Uint32Array(SC), shConn = new Uint32Array(SC), junc = new Uint32Array(SC), nc = new Uint32Array(SC), pinsAt = new Uint32Array(SC);
  for (let w = 0; w < W; w++) if (wok[w]) { wireEnds[wa[w]]++; wireEnds[wb[w]]++; }
  for (const s of spSite) shConn[s]++;
  for (const j of jSite) junc[dn.map[j]]++;
  for (const n of ncSite) nc[dn.map[n]]++;
  for (let p = 0; p < P; p++) if (pok[p]) pinsAt[pSite[p]]++;
  const wired = (s: number): boolean => wireEnds[s] > 0 || shConn[s] > 0 || junc[s] > 0;

  const connPins = new Uint32Array(SC), firstSym = new Int32Array(SC).fill(-1), coincide = new Uint8Array(SC);
  const isolated = new Uint8Array(P);
  const reportedConflict = new Set<number>();
  for (let p = 0; p < P; p++) {
    if (!pok[p]) continue;
    env.tick();
    const s = pSite[p];
    pinNc[p] = nc[s] > 0 || pinTypeNc[p] ? 1 : 0;
    if (pinNc[p] && !wired(s)) { isolated[p] = 1; continue; }
    if (pinNc[p] && !reportedConflict.has(p)) {
      reportedConflict.add(p);
      const sym = def.symbols[pinSym[p]], pin = sym.pins[p - symStart[pinSym[p]]];
      diag.add({ severity: 'warning', code: 'NO_CONNECT_CONFLICT', message: `Pin ${sym.refDefault || sym.id}:${pin.number} is marked no-connect but a wire, sheet pin or junction is attached to it; it stays connected.`, defId, at: pin.at });
    }
    connPins[s]++;
    if (firstSym[s] < 0) firstSym[s] = pinSym[p]; else if (firstSym[s] !== pinSym[p]) coincide[s] = 1;
  }
  for (const n of ncSite) {
    const s = dn.map[n];
    if (pinsAt[s] === 0) diag.add({ severity: 'info', code: 'NO_CONNECT_UNATTACHED', message: 'A no-connect flag is not on any pin.', defId, at: { x: dn.x[s], y: dn.y[s] } });
  }
  let coincideCount = 0, coincideAt: SchPoint | undefined;
  for (let s = 0; s < SC; s++) if (coincide[s]) { coincideCount++; coincideAt ??= { x: dn.x[s], y: dn.y[s] }; }
  if (coincideCount) diag.add({ severity: 'info', code: 'PINS_COINCIDE', message: `Pins of different symbols share their connection point at ${coincideCount} site(s); they are treated as connected.`, defId, at: coincideAt });

  // ---- wire domain: union-find over wires, pins, sheet pins and sites
  const SP = wireSheetPins.length;
  const siteEl = (s: number): number => W + P + SP + s;
  const dsu = new Dsu(W + P + SP + SC);
  for (let w = 0; w < W; w++) if (wok[w]) { dsu.union(w, siteEl(wa[w])); dsu.union(w, siteEl(wb[w])); }
  for (let p = 0; p < P; p++) if (pok[p] && !isolated[p]) dsu.union(W + p, siteEl(pSite[p]));
  for (let q = 0; q < SP; q++) dsu.union(W + P + q, siteEl(spSite[q]));

  const segs = new SegIndex();
  for (let w = 0; w < W; w++) if (wok[w] && (wxy[4 * w] !== wxy[4 * w + 2] || wxy[4 * w + 1] !== wxy[4 * w + 3])) segs.add(w, wxy[4 * w], wxy[4 * w + 1], wxy[4 * w + 2], wxy[4 * w + 3]);
  const hits: number[] = [];
  if (segs.size) {
    for (let s = 0; s < SC; s++) {
      env.tick();
      segs.hits(dn.x[s], dn.y[s], s, wa, wb, wxy, hits);
      if (!hits.length) continue;
      if (wireEnds[s] > 0 || junc[s] > 0) for (const w of hits) dsu.union(w, siteEl(s));
      else if (connPins[s] > 0 || shConn[s] > 0) {
        diag.add({ severity: 'warning', code: 'PIN_ON_WIRE_NO_JUNCTION', message: 'A pin or sheet pin ends on the interior of a wire without a junction; it is NOT connected to that wire.', defId, at: { x: dn.x[s], y: dn.y[s] } });
      }
    }
  }

  const rootComp = new Int32Array(W + P + SP + SC).fill(-1);
  let nComp = 0;
  const comp = (el: number): number => { const r = dsu.find(el); let c = rootComp[r]; if (c < 0) c = rootComp[r] = nComp++; return c; };
  const wireComp = new Int32Array(W).fill(-1);
  for (let w = 0; w < W; w++) if (wok[w]) wireComp[w] = comp(w);
  const pinComp = new Int32Array(P).fill(-1);
  for (let p = 0; p < P; p++) if (pok[p]) pinComp[p] = comp(W + p);
  const spComp = new Int32Array(SP);
  for (let q = 0; q < SP; q++) spComp[q] = comp(W + P + q);
  const siteComp = (s: number): number => rootComp[dsu.find(siteEl(s))];
  const compSize = new Uint32Array(nComp);
  for (let w = 0; w < W; w++) if (wireComp[w] >= 0) compSize[wireComp[w]]++;
  for (let p = 0; p < P; p++) if (pinComp[p] >= 0) compSize[pinComp[p]]++;
  for (let q = 0; q < SP; q++) compSize[spComp[q]]++;

  /** Components a point attaches to; ambiguity (a crossing) attaches to none. */
  const attach = (s: number, kind: string, at: SchPoint): number[] => {
    const cands: number[] = [];
    const c0 = siteComp(s);
    if (c0 >= 0) cands.push(c0);
    if (segs.size) { segs.hits(dn.x[s], dn.y[s], s, wa, wb, wxy, hits); for (const w of hits) { const c = wireComp[w]; if (!cands.includes(c)) cands.push(c); } }
    if (cands.length === 0) { diag.add({ severity: 'warning', code: 'LABEL_UNATTACHED', message: `${kind} is not attached to any wire or pin.`, defId, at }); return []; }
    if (cands.length > 1) { diag.add({ severity: 'warning', code: 'LABEL_AMBIGUOUS', message: `${kind} touches ${cands.length} wires that are not connected to each other (a crossing); it is attached to none of them.`, defId, at }); return []; }
    return cands;
  };
  const labels: LabelItem[] = [];
  for (let l = 0; l < plainLabels.length; l++) {
    env.tick();
    const label = plainLabels[l];
    const comps = attach(dn.map[lSite[l]], `Label "${label.text.trim()}"`, label.at);
    if (comps.length) labels.push({ label, text: label.text.trim(), comps });
  }

  // ---- bus domain
  const busRaw = def.buses;
  const B = busRaw.length;
  const bok = new Uint8Array(B), bxy = new Float64Array(B * 4);
  for (let b = 0; b < B; b++) {
    const { a, b: e } = busRaw[b];
    if (validPoint(a) && validPoint(e)) { bok[b] = 1; bxy[4 * b] = a.x; bxy[4 * b + 1] = a.y; bxy[4 * b + 2] = e.x; bxy[4 * b + 3] = e.y; } else bad.bus++;
  }
  const busLabels: BusLabelItem[] = [];
  const sheetPins: SheetPinItem[] = [];
  let busCompMembers: Array<BusMembers | null> = [];
  if (B > 0 || busLabelsRaw.length || shRaw.some(sp => sp.bus)) {
    const bs = new SiteIndex();
    const ba = new Int32Array(B).fill(-1), bb = new Int32Array(B).fill(-1);
    for (let b = 0; b < B; b++) if (bok[b]) { ba[b] = bs.add(bxy[4 * b], bxy[4 * b + 1]); bb[b] = bs.add(bxy[4 * b + 2], bxy[4 * b + 3]); }
    const bj: number[] = [];
    if (B) for (const j of def.junctions) if (validPoint(j.at)) bj.push(bs.add(j.at.x, j.at.y));
    const blSite = busLabelsRaw.map(l => bs.add(l.label.at.x, l.label.at.y));
    const busSheetPinsRaw = shRaw.filter(sp => sp.bus);
    const bpSite = busSheetPinsRaw.map(sp => bs.add(sp.at.x, sp.at.y));
    const bd = bs.dense();
    for (let b = 0; b < B; b++) if (bok[b]) { ba[b] = bd.map[ba[b]]; bb[b] = bd.map[bb[b]]; }
    const bEnds = new Uint32Array(bd.count), bJunc = new Uint32Array(bd.count);
    for (let b = 0; b < B; b++) if (bok[b]) { bEnds[ba[b]]++; bEnds[bb[b]]++; }
    for (const j of bj) bJunc[bd.map[j]]++;
    const bdsu = new Dsu(B + bd.count);
    for (let b = 0; b < B; b++) if (bok[b]) { bdsu.union(b, B + ba[b]); bdsu.union(b, B + bb[b]); }
    const bsegs = new SegIndex();
    for (let b = 0; b < B; b++) if (bok[b] && (bxy[4 * b] !== bxy[4 * b + 2] || bxy[4 * b + 1] !== bxy[4 * b + 3])) bsegs.add(b, bxy[4 * b], bxy[4 * b + 1], bxy[4 * b + 2], bxy[4 * b + 3]);
    const bhits: number[] = [];
    if (bsegs.size) {
      for (let s = 0; s < bd.count; s++) {
        bsegs.hits(bd.x[s], bd.y[s], s, ba, bb, bxy, bhits);
        if (bhits.length && (bEnds[s] > 0 || bJunc[s] > 0)) for (const b of bhits) bdsu.union(b, B + s);
      }
    }
    const bRootComp = new Int32Array(B + bd.count).fill(-1);
    let bn = 0;
    const busComp = new Int32Array(B).fill(-1);
    for (let b = 0; b < B; b++) if (bok[b]) { const r = bdsu.find(b); if (bRootComp[r] < 0) bRootComp[r] = bn++; busComp[b] = bRootComp[r]; }
    const bAttach = (s: number, kind: string, at: SchPoint): number[] => {
      const cands: number[] = [];
      const c0 = bRootComp[bdsu.find(B + s)];
      if (c0 >= 0) cands.push(c0);
      if (bsegs.size) { bsegs.hits(bd.x[s], bd.y[s], s, ba, bb, bxy, bhits); for (const b of bhits) { const c = busComp[b]; if (!cands.includes(c)) cands.push(c); } }
      if (cands.length === 0) { diag.add({ severity: 'warning', code: 'LABEL_UNATTACHED', message: `${kind} is not attached to any bus.`, defId, at }); return []; }
      if (cands.length > 1) { diag.add({ severity: 'warning', code: 'LABEL_AMBIGUOUS', message: `${kind} touches ${cands.length} buses that are not connected to each other; it is attached to none of them.`, defId, at }); return []; }
      return cands;
    };
    busCompMembers = new Array<BusMembers | null>(bn).fill(null);
    const textOf: Array<string | null> = new Array<string | null>(bn).fill(null);
    for (let l = 0; l < busLabelsRaw.length; l++) {
      const { label, members } = busLabelsRaw[l];
      const text = label.text.trim();
      const comps = bAttach(bd.map[blSite[l]], `Bus label "${text}"`, label.at);
      if (!comps.length) continue;
      busLabels.push({ label, text, members, comps });
      const c = comps[0], prev = textOf[c];
      if (prev === null || text < prev) {
        if (prev !== null && prev !== text) diag.add({ severity: 'warning', code: 'BUS_LABEL_CONFLICT', message: `A bus carries two different names ("${prev}" and "${text}"); "${text < prev ? text : prev}" is used.`, defId, at: label.at });
        textOf[c] = text; busCompMembers[c] = { kind: label.kind, members };
      } else if (prev !== text) diag.add({ severity: 'warning', code: 'BUS_LABEL_CONFLICT', message: `A bus carries two different names ("${prev}" and "${text}"); "${prev}" is used.`, defId, at: label.at });
    }
    let bq = 0;
    for (const sp of shRaw) {
      if (sp.bus) {
        const comps = bAttach(bd.map[bpSite[bq++]], `Sheet pin "${sp.name}"`, sp.at);
        sheetPins.push({ ref: sp.ref, name: sp.name, at: sp.at, comp: -1, bus: { members: sp.bus, comps } });
      }
    }
  }
  let wq = 0;
  for (const sp of shRaw) if (!sp.bus) sheetPins.push({ ref: sp.ref, name: sp.name, at: sp.at, comp: spComp[wq++], bus: null });
  sheetPins.sort((a, b) => a.ref - b.ref);

  for (const kind of BAD_KINDS) {
    if (bad[kind]) diag.add({ severity: 'error', code: 'COORDINATE_INVALID', message: `${bad[kind]} ${kind} element(s) with a missing, non-finite or out-of-range coordinate (limit ${SCHEMATIC_LIMITS.maxCoordinateMm} mm) were ignored.`, defId });
  }
  return { def, nComp, compSize, wireComp, symStart, pinSym, pinCount: P, pinComp, pinNc, labels, busLabels, busCompMembers, sheetPins, hierTexts };
}

// ---------------------------------------------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------------------------------------------

interface Resolved { inst: SchSheetInstance; def: SchSheetDef }

function synthesizeInstances(schematic: Schematic, defs: Map<string, SchSheetDef>, env: Env): SchSheetInstance[] {
  env.diag.add({ severity: 'warning', code: 'INSTANCES_MISSING', message: 'The schematic lists no sheet instances; the hierarchy was reconstructed from the sheet symbols.' });
  const out: SchSheetInstance[] = [];
  const walk = (defId: string, path: string, parent: SchSheetInstance | null, ref: SchSheetRef | null, chain: string[]): void => {
    const def = defs.get(defId);
    if (!def) return;
    const inst: SchSheetInstance = { path, defId, name: ref?.name ?? def.name, page: String(out.length + 1), parentPath: parent ? parent.path : null, sheetRefId: ref ? ref.id : null, childPaths: [], depth: chain.length };
    out.push(inst);
    if (parent) parent.childPaths.push(path);
    if (chain.length >= SCHEMATIC_LIMITS.maxNestingDepth) { env.diag.add({ severity: 'error', code: 'SHEET_CYCLE', message: 'Sheet nesting is too deep; deeper sheets were ignored.', defId }); return; }
    for (const r of def.sheetRefs) {
      if (!r.defId || !defs.has(r.defId)) continue;
      if (chain.includes(r.defId) || r.defId === defId) { env.diag.add({ severity: 'error', code: 'SHEET_CYCLE', message: `Sheet "${r.name}" includes one of its own ancestors; the recursive instance was ignored.`, defId, instancePath: path }); continue; }
      walk(r.defId, `${path}/${r.id}`, inst, r, [...chain, defId]);
    }
  };
  walk(schematic.rootDefId, '', null, null, []);
  return out;
}

function resolveInstances(schematic: Schematic, defs: Map<string, SchSheetDef>, env: Env): Resolved[] {
  if (schematic.defs.length > SCHEMATIC_LIMITS.maxSheetDefs) throw new SchematicError(`Too many sheet definitions (${schematic.defs.length} > ${SCHEMATIC_LIMITS.maxSheetDefs}).`, 'LIMIT_EXCEEDED', schematic.format);
  if (schematic.instances.length > SCHEMATIC_LIMITS.maxInstances) throw new SchematicError(`Too many sheet instances (${schematic.instances.length} > ${SCHEMATIC_LIMITS.maxInstances}).`, 'LIMIT_EXCEEDED', schematic.format);
  for (const def of schematic.defs) {
    if (def.symbols.length > SCHEMATIC_LIMITS.maxSymbolsPerDef) throw new SchematicError(`Sheet "${def.name}" has too many symbols (${def.symbols.length}).`, 'LIMIT_EXCEEDED', schematic.format);
    if (def.wires.length > SCHEMATIC_LIMITS.maxWiresPerDef) throw new SchematicError(`Sheet "${def.name}" has too many wires (${def.wires.length}).`, 'LIMIT_EXCEEDED', schematic.format);
  }
  const list = schematic.instances.length ? schematic.instances : synthesizeInstances(schematic, defs, env);
  const seen = new Set<string>();
  const out: Resolved[] = [];
  for (const inst of list) {
    if (inst.depth > SCHEMATIC_LIMITS.maxNestingDepth) throw new SchematicError(`Sheet nesting depth ${inst.depth} exceeds ${SCHEMATIC_LIMITS.maxNestingDepth}.`, 'LIMIT_EXCEEDED', schematic.format);
    const def = defs.get(inst.defId);
    if (!def) { env.diag.add({ severity: 'error', code: 'DEF_MISSING', message: `Sheet instance "${inst.path}" refers to the unknown sheet definition "${inst.defId}".`, instancePath: inst.path }); continue; }
    if (seen.has(inst.path)) { env.diag.add({ severity: 'error', code: 'INSTANCE_DUPLICATE', message: `Sheet instance path "${inst.path}" occurs more than once; the repeat was ignored.`, instancePath: inst.path, defId: def.id }); continue; }
    seen.add(inst.path);
    out.push({ inst, def });
  }
  let pins = 0;
  for (const { def } of out) { for (const s of def.symbols) pins += s.pins.length; if (pins > SCHEMATIC_LIMITS.maxPinsTotal) throw new SchematicError(`The expanded schematic has more than ${SCHEMATIC_LIMITS.maxPinsTotal} pins.`, 'LIMIT_EXCEEDED', schematic.format); }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Result building blocks
// ---------------------------------------------------------------------------------------------------------------

const symbolUnit = (symbol: SchSymbol, path: string): number => symbol.instances[path]?.unit ?? symbol.instances['']?.unit ?? symbol.unit;
const isVirtual = (symbol: SchSymbol): boolean => symbol.virtual || !!symbol.power;
const annotated = (ref: string): boolean => ref !== '' && !ref.includes('?');

function compareMembers(a: SchNetMember, b: SchNetMember): number {
  return naturalCompare(a.ref, b.ref) || naturalCompare(a.pinNumber, b.pinNumber) || cmp(a.instancePath, b.instancePath) || cmp(a.symbolId, b.symbolId) || cmp(a.pinId, b.pinId);
}

/** Members sorted; copies of one physical pin (same annotated ref + pin number) collapse to the first. */
function dedupeMembers(items: Array<{ m: SchNetMember; mergeable: boolean }>): SchNetMember[] {
  items.sort((a, b) => compareMembers(a.m, b.m));
  const out: SchNetMember[] = [];
  let last: { m: SchNetMember; mergeable: boolean } | null = null;
  for (const item of items) {
    if (last && item.mergeable && last.mergeable && last.m.ref === item.m.ref && last.m.pinNumber === item.m.pinNumber) continue;
    out.push(item.m);
    last = item;
  }
  return out;
}

const autoName = (m: SchNetMember): string => `Net-(${m.ref}-Pad${m.pinNumber})`;

function finishResult(nets: SchNet[], pinNet: Record<string, string>, wireNet: Record<string, string>, noConnectPins: string[], floatingPins: string[], env: Env): SchConnectivity {
  nets.sort((a, b) => naturalCompare(a.name, b.name) || cmp(a.id, b.id));
  return { nets, pinNet, wireNet, noConnectPins, floatingPins, diagnostics: env.diag.finish() };
}

// ---------------------------------------------------------------------------------------------------------------
// Geometric connectivity
// ---------------------------------------------------------------------------------------------------------------

/** Name kinds by priority rank ("#net-name-assignment-rules"). */
const K_GLOBAL = 0, K_POWER = 1, K_LOCAL = 2, K_HIER = 3, K_SHEETPIN = 4;
const kindRank = (k: SchLabelKind): number => (k === 'global' ? K_GLOBAL : k === 'local' ? K_LOCAL : K_HIER);

interface Group { pins: number[]; wires: number[]; entries: number[]; first: number; top: number; multi: boolean }

function computeGeometric(schematic: Schematic, resolved: Resolved[], env: Env): SchConnectivity {
  const n = resolved.length;
  const geoCache = new Map<string, DefGeom>();
  const geoOf = (def: SchSheetDef): DefGeom => {
    let g = geoCache.get(def.id);
    if (!g) { g = buildDefGeom(def, env, env.diag); geoCache.set(def.id, g); }
    return g;
  };
  const geos = resolved.map(r => geoOf(r.def));
  const base = new Int32Array(n + 1), pinBase = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) { base[i + 1] = base[i] + geos[i].nComp; pinBase[i + 1] = pinBase[i] + geos[i].pinCount; }
  const totalComps = base[n], totalPins = pinBase[n];
  const paths = resolved.map(r => r.inst.path);
  const depth = resolved.map(r => r.inst.depth);
  const instIndex = new Map<string, number>(); resolved.forEach((r, i) => instIndex.set(r.inst.path, i));
  const byParentRef = new Map<string, number>();
  resolved.forEach((r, i) => { if (r.inst.parentPath !== null && r.inst.sheetRefId !== null) byParentRef.set(`${r.inst.parentPath}\0${r.inst.sheetRefId}`, i); });
  const childOf = (i: number, ref: SchSheetRef): number => byParentRef.get(`${paths[i]}\0${ref.id}`) ?? instIndex.get(`${paths[i]}/${ref.id}`) ?? -1;

  // ---- names, keys, unions
  const keyIds = new Map<string, number>();
  const keyNode = (k: string): number => { let id = keyIds.get(k); if (id === undefined) { id = totalComps + keyIds.size; keyIds.set(k, id); } return id; };
  const localKey = (path: string, name: string): string => `L\0${path}\0${connectionName(name)}`;
  const globalKey = (name: string): string => `G\0${connectionName(name)}`;
  const ua: number[] = [], ub: number[] = [];
  const join = (a: number, b: number): void => { ua.push(a); ub.push(b); };
  const entNode: number[] = [], entName: string[] = [], entKind: number[] = [], entInst: number[] = [], entAt: Array<SchPoint | undefined> = [];
  const entry = (node: number, name: string, kind: number, inst: number, at?: SchPoint): void => { entNode.push(node); entName.push(name); entKind.push(kind); entInst.push(inst); entAt.push(at); };
  const memberKey = (kind: SchLabelKind, path: string, name: string): number => keyNode(kind === 'global' ? globalKey(name) : localKey(path, name));
  const defIds = new Set(schematic.defs.map(d => d.id));
  const parentRefOf = new Map<number, SchSheetRef>();
  for (let i = 0; i < n; i++) {
    for (const ref of resolved[i].def.sheetRefs) { const c = childOf(i, ref); if (c >= 0) parentRefOf.set(c, ref); }
  }

  const unannotated = new Map<number, number>();
  const refs: string[][] = [];
  const refGroups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const { inst, def } = resolved[i];
    const geo = geos[i], b = base[i];
    env.tick();
    // plain labels
    for (const item of geo.labels) {
      const kind = item.label.kind;
      for (const c of item.comps) {
        const node = b + c;
        entry(node, item.text, kindRank(kind), i, item.label.at);
        if (kind === 'global') join(node, keyNode(globalKey(item.text)));
        join(node, keyNode(localKey(inst.path, item.text)));
      }
    }
    // bus labels: their members are names of the same scope (they join nothing by themselves)
    for (const item of geo.busLabels) {
      for (const m of item.members) {
        if (item.label.kind === 'global') { const g = keyNode(globalKey(m)); join(g, keyNode(localKey(inst.path, m))); entry(g, m, K_GLOBAL, i, item.label.at); }
        else entry(keyNode(localKey(inst.path, m)), m, kindRank(item.label.kind), i, item.label.at);
      }
    }
    // symbols: power ties, hidden power pins, references
    const symRefs: string[] = new Array<string>(def.symbols.length);
    let unann = 0;
    for (let s = 0; s < def.symbols.length; s++) {
      const sym = def.symbols[s];
      const ref = (symbolRef(sym, inst.path) ?? '').trim();
      symRefs[s] = ref;
      if (sym.power) {
        const name = (sym.power.net ?? '').trim();
        if (name) for (let p = geo.symStart[s]; p < geo.symStart[s + 1]; p++) { const c = geo.pinComp[p]; if (c >= 0) { entry(b + c, name, K_POWER, i); join(b + c, keyNode(globalKey(name))); } }
        continue;
      }
      // A hidden power-input pin ties to the global net of its name on ANY symbol, virtual ones included: KiCad 4/5 era power symbols
      // ("#PWR123", library symbol without a (power) flag, one hidden power_in pin named "VPP") are virtual but still name their net (W-open-sch-03).
      for (let k = 0; k < sym.pins.length; k++) {
        const name = sym.pins[k].implicitNet?.trim();
        if (!name) continue;
        const c = geo.pinComp[geo.symStart[s] + k];
        if (c >= 0) { entry(b + c, name, K_POWER, i); join(b + c, keyNode(globalKey(name))); }
      }
      if (sym.virtual) continue;
      if (!annotated(ref)) unann++;
      else { let g = refGroups.get(ref); if (!g) refGroups.set(ref, g = []); g.push(i * WIRE_SHIFT + s); }
    }
    refs.push(symRefs);
    if (unann) unannotated.set(i, unann);
    // sheet pins of this instance
    for (const ref of def.sheetRefs) {
      if (childOf(i, ref) >= 0) continue;
      if (ref.defId === null || !defIds.has(ref.defId)) env.diag.add({ severity: 'warning', code: 'SHEET_CHILD_MISSING', message: `Sheet "${ref.name}" (${ref.file}) is not loaded; its sheet pins dangle.`, defId: def.id, instancePath: inst.path, at: ref.at });
      else env.diag.add({ severity: 'warning', code: 'SHEET_INSTANCE_MISSING', message: `Sheet "${ref.name}" has no instance in the hierarchy; its sheet pins dangle.`, defId: def.id, instancePath: inst.path, at: ref.at });
    }
    for (const sp of geo.sheetPins) {
      const ref = def.sheetRefs[sp.ref];
      const ci = childOf(i, ref);
      if (ci >= 0 && ref.defId !== null && resolved[ci].def.id !== ref.defId) {
        env.diag.add({ severity: 'error', code: 'SHEET_DEF_MISMATCH', message: `Sheet "${ref.name}" points at definition "${ref.defId}" but its instance uses "${resolved[ci].def.id}"; its sheet pins were not joined.`, defId: def.id, instancePath: inst.path, at: sp.at });
        continue;
      }
      // A sheet pin joins only a hierarchical label of exactly its name inside the child ("#hierarchical-sheet-pins").
      const matched = ci >= 0 && geos[ci].hierTexts.has(connectionName(sp.name));
      if (ci >= 0 && !matched) env.diag.add({ severity: 'warning', code: 'SHEET_PIN_UNMATCHED', message: `Sheet pin "${sp.name}" of sheet "${ref.name}" has no hierarchical label of that name inside the sheet; it is not joined.`, defId: def.id, instancePath: inst.path, at: sp.at });
      if (!sp.bus) {
        if (sp.comp < 0) continue;
        const node = b + sp.comp;
        entry(node, sp.name, K_SHEETPIN, i, sp.at);
        if (matched) join(node, keyNode(localKey(paths[ci], sp.name)));
      } else if (matched) {
        const parent = sp.bus.comps.length ? geo.busCompMembers[sp.bus.comps[0]] : null;
        if (!parent) { env.diag.add({ severity: 'warning', code: 'BUS_UNNAMED', message: `Sheet pin "${sp.name}" is not attached to a named bus; its members were not joined.`, defId: def.id, instancePath: inst.path, at: sp.at }); continue; }
        if (parent.members.length !== sp.bus.members.length) { env.diag.add({ severity: 'warning', code: 'BUS_MEMBER_MISMATCH', message: `Bus on sheet pin "${sp.name}" has ${parent.members.length} members but the pin names ${sp.bus.members.length}; members were not joined.`, defId: def.id, instancePath: inst.path, at: sp.at }); continue; }
        for (let k = 0; k < parent.members.length; k++) join(memberKey(parent.kind, inst.path, parent.members[k]), keyNode(localKey(paths[ci], sp.bus.members[k])));
      }
    }
  }
  // hierarchical labels without a sheet pin
  for (let i = 0; i < n; i++) {
    const { inst } = resolved[i];
    if (!geos[i].hierTexts.size) continue;
    if (inst.parentPath === null) { env.diag.add({ severity: 'info', code: 'HIER_LABEL_AT_ROOT', message: 'The root sheet has hierarchical labels; they have no parent sheet pin.', defId: resolved[i].def.id, instancePath: inst.path }); continue; }
    const ref = parentRefOf.get(i);
    if (!ref) continue;
    const pins = new Set(ref.pins.map(p => connectionName((p.name ?? '').trim())));
    for (const text of geos[i].hierTexts) if (!pins.has(text)) env.diag.add({ severity: 'warning', code: 'HIER_LABEL_UNMATCHED', message: `Hierarchical label "${text}" has no sheet pin of that name on the parent sheet symbol "${ref.name}".`, defId: resolved[i].def.id, instancePath: inst.path });
  }
  for (const [i, count] of unannotated) env.diag.add({ severity: 'info', code: 'UNANNOTATED_REFERENCE', message: `${count} symbol(s) have no annotated reference (empty or containing "?"); their pins are never merged by reference.`, defId: resolved[i].def.id, instancePath: paths[i] });

  // ---- reference identity (multi-unit)
  const blocked = new Set<number>();
  for (const [ref, list] of refGroups) {
    if (list.length < 2) continue;
    let ok = true;
    const units = new Set<number>();
    let lib: string | null = null;
    for (const code of list) {
      const i = Math.floor(code / WIRE_SHIFT), s = code % WIRE_SHIFT;
      const sym = resolved[i].def.symbols[s];
      lib ??= sym.libId;
      const unit = symbolUnit(sym, paths[i]);
      if (sym.libId !== lib || units.has(unit)) ok = false;
      units.add(unit);
    }
    if (!ok) {
      for (const code of list) blocked.add(code);
      const i0 = Math.floor(list[0] / WIRE_SHIFT);
      env.diag.add({ severity: 'warning', code: 'DUPLICATE_REFERENCE', message: `Reference "${ref}" is used by ${list.length} different parts or by the same unit more than once; their pins are not merged by reference.`, defId: resolved[i0].def.id, instancePath: paths[i0] });
    }
  }

  // ---- union-find over components and name keys
  const N = totalComps + keyIds.size;
  const dsu = new Dsu(N);
  for (let k = 0; k < ua.length; k++) dsu.union(ua[k], ub[k]);
  env.check();

  // identity merges (one physical pin = one node); warns when that joins nets that were different
  const identity = new Map<string, number[]>();
  const gpInst = new Int32Array(totalPins);
  for (let i = 0; i < n; i++) gpInst.fill(i, pinBase[i], pinBase[i + 1]);
  const mergeablePlacement = (i: number, s: number): boolean => {
    const sym = resolved[i].def.symbols[s];
    return !isVirtual(sym) && annotated(refs[i][s]) && !blocked.has(i * WIRE_SHIFT + s);
  };
  for (let i = 0; i < n; i++) {
    const { def } = resolved[i], geo = geos[i];
    for (let s = 0; s < def.symbols.length; s++) {
      if (!mergeablePlacement(i, s)) continue;
      const sym = def.symbols[s];
      const multi = (refGroups.get(refs[i][s])?.length ?? 0) > 1;
      if (!multi && sym.pins.length < 2) continue;
      const firstOf = multi ? null : new Map<string, number>();
      for (let k = 0; k < sym.pins.length; k++) {
        const p = geo.symStart[s] + k;
        if (geo.pinComp[p] < 0) continue;
        const key = `${refs[i][s]}\0${sym.pins[k].number}`;
        const gp = pinBase[i] + p;
        if (firstOf) {
          const prev = firstOf.get(key);
          if (prev === undefined) { firstOf.set(key, gp); continue; }
          const list = identity.get(key);
          if (list) list.push(gp); else identity.set(key, [prev, gp]);
        } else {
          const list = identity.get(key);
          if (list) list.push(gp); else identity.set(key, [gp]);
        }
      }
    }
  }
  const weight = new Uint32Array(N);
  for (let i = 0; i < n; i++) for (let c = 0; c < geos[i].nComp; c++) weight[dsu.find(base[i] + c)] += geos[i].compSize[c];
  for (let e = 0; e < entNode.length; e++) weight[dsu.find(entNode[e])]++;
  for (const [key, list] of identity) {
    if (list.length < 2) continue;
    const roots = new Set<number>();
    for (const gp of list) { const i = gpInst[gp]; roots.add(dsu.find(base[i] + geos[i].pinComp[gp - pinBase[i]])); }
    let busy = 0;
    for (const r of roots) if (weight[r] > 1) busy++;
    if (busy > 1) {
      const i0 = gpInst[list[0]], [ref, number] = key.split('\0');
      env.diag.add({ severity: 'warning', code: 'MULTI_UNIT_PIN_MISMATCH', message: `Pin ${number} of ${ref} appears on several units connected to different nets; the nets were merged because it is one physical pin.`, defId: resolved[i0].def.id, instancePath: paths[i0] });
    }
  }
  for (const list of identity.values()) {
    for (let k = 1; k < list.length; k++) {
      const a = gpInst[list[0]], c = gpInst[list[k]];
      dsu.union(base[a] + geos[a].pinComp[list[0] - pinBase[a]], base[c] + geos[c].pinComp[list[k] - pinBase[c]]);
    }
  }

  // ---- groups (= electrical nets before naming)
  const groupOf = new Int32Array(N).fill(-1);
  const groups: Group[] = [];
  for (let i = 0; i < n; i++) {
    env.tick();
    for (let c = 0; c < geos[i].nComp; c++) {
      const r = dsu.find(base[i] + c);
      let gi = groupOf[r];
      if (gi < 0) { gi = groupOf[r] = groups.length; groups.push({ pins: [], wires: [], entries: [], first: i, top: i, multi: false }); }
      const g = groups[gi];
      if (g.first !== i) g.multi = true;
      if (depth[i] < depth[g.top]) g.top = i;
    }
  }
  for (let i = 0; i < n; i++) {
    const geo = geos[i], b = base[i];
    const wc = geo.wireComp;
    for (let w = 0; w < wc.length; w++) if (wc[w] >= 0) groups[groupOf[dsu.find(b + wc[w])]].wires.push(i * WIRE_SHIFT + w);
    const pc = geo.pinComp;
    for (let p = 0; p < pc.length; p++) if (pc[p] >= 0) groups[groupOf[dsu.find(b + pc[p])]].pins.push(pinBase[i] + p);
  }
  for (let e = 0; e < entNode.length; e++) { const gi = groupOf[dsu.find(entNode[e])]; if (gi >= 0) groups[gi].entries.push(e); }

  // ---- nets
  const nets: SchNet[] = [];
  const pinNet: Record<string, string> = {};
  const wireNet: Record<string, string> = {};
  const netted = new Uint8Array(totalPins);
  const usedIds = new Set<string>();
  let autoCount = 0;
  for (const g of groups) {
    env.tick();
    const items: Array<{ m: SchNetMember; mergeable: boolean }> = [];
    for (const gp of g.pins) {
      const i = gpInst[gp], p = gp - pinBase[i], geo = geos[i];
      const s = geo.pinSym[p];
      const sym = geo.def.symbols[s];
      if (isVirtual(sym)) continue;
      const pin = sym.pins[p - geo.symStart[s]];
      items.push({ m: { instancePath: paths[i], defId: geo.def.id, symbolId: sym.id, pinId: pin.id, ref: refs[i][s], unit: symbolUnit(sym, paths[i]), pinNumber: pin.number, pinName: pin.name }, mergeable: mergeablePlacement(i, s) });
    }
    const named = g.entries.length > 0;
    const members = dedupeMembers(items);
    if (g.wires.length + members.length === 0 || (members.length < 2 && !named)) continue;

    const chosen = chooseName(g, entName, entKind, entInst, depth);
    const aliases = [...new Set(g.entries.map(e => entName[e]))].sort(cmp);
    checkConflicts(g, entName, entKind, entInst, entAt, paths, resolved, env.diag);
    let id: string, name: string, auto = false, scope: SchNet['scope'], scopePath: string | undefined;
    if (chosen) {
      name = chosen.name;
      if (chosen.kind <= K_POWER) { scope = 'global'; id = `net:global:${name}`; }
      else { scope = g.multi ? 'hierarchical' : 'local'; scopePath = paths[chosen.inst]; id = `net:local:${scopePath}:${name}`; }
    } else {
      auto = true; name = autoName(members[0]);
      scope = g.multi ? 'hierarchical' : 'local'; scopePath = paths[g.top]; id = `net:auto:${++autoCount}`;
    }
    if (usedIds.has(id)) { let k = 2; while (usedIds.has(`${id}~${k}`)) k++; id = `${id}~${k}`; }
    usedIds.add(id);
    const wires = g.wires.map(code => { const i = Math.floor(code / WIRE_SHIFT), w = code % WIRE_SHIFT; return { instancePath: paths[i], wireId: resolved[i].def.wires[w].id }; });
    const net: SchNet = { id, name, auto, scope, aliases: auto ? [] : aliases, members, wires };
    if (scopePath !== undefined) net.scopePath = scopePath;
    nets.push(net);
    for (const code of g.wires) { const i = Math.floor(code / WIRE_SHIFT), w = code % WIRE_SHIFT; wireNet[wireKey(paths[i], resolved[i].def.wires[w].id)] = id; }
    for (const gp of g.pins) {
      const i = gpInst[gp], p = gp - pinBase[i], geo = geos[i], s = geo.pinSym[p];
      const sym = geo.def.symbols[s];
      pinNet[pinKey(paths[i], sym.id, sym.pins[p - geo.symStart[s]].id)] = id;
      netted[gp] = 1;
    }
  }
  const noConnectPins: string[] = [], floatingPins: string[] = [];
  for (let i = 0; i < n; i++) {
    const geo = geos[i], def = geo.def;
    for (let s = 0; s < def.symbols.length; s++) {
      const sym = def.symbols[s];
      if (isVirtual(sym)) continue;
      for (let k = 0; k < sym.pins.length; k++) {
        const p = geo.symStart[s] + k;
        if (geo.pinNc[p]) noConnectPins.push(pinKey(paths[i], sym.id, sym.pins[k].id));
        else if (!netted[pinBase[i] + p]) floatingPins.push(pinKey(paths[i], sym.id, sym.pins[k].id));
      }
    }
  }
  return finishResult(nets, pinNet, wireNet, noConnectPins, floatingPins, env);

}

function chooseName(g: Group, entName: string[], entKind: number[], entInst: number[], depth: number[]): { name: string; kind: number; inst: number } | null {
  let best: { name: string; kind: number; inst: number } | null = null;
  const better = (kind: number, name: string, inst: number): boolean => {
    if (!best) return true;
    if (kind <= K_POWER || best.kind <= K_POWER) {
      if (kind !== best.kind) return kind < best.kind;
      return name < best.name || (name === best.name && inst < best.inst);
    }
    const lk = (k: number): number => (k === K_SHEETPIN ? 1 : 0);
    if (lk(kind) !== lk(best.kind)) return lk(kind) < lk(best.kind);
    if (depth[inst] !== depth[best.inst]) return depth[inst] < depth[best.inst];
    if (kind !== best.kind) return kind < best.kind;
    return name < best.name || (name === best.name && inst < best.inst);
  };
  for (const e of g.entries) {
    const name = entName[e];
    if (name && better(entKind[e], name, entInst[e])) best = { name, kind: entKind[e], inst: entInst[e] };
  }
  return best;
}

function checkConflicts(g: Group, entName: string[], entKind: number[], entInst: number[], entAt: Array<SchPoint | undefined>, paths: string[], resolved: Resolved[], diag: Diagnostics): void {
  if (g.entries.length < 2) return;
  const globals = new Set<string>();
  const perInst = new Map<number, Set<string>>();
  for (const e of g.entries) {
    const k = entKind[e];
    if (k > K_HIER) continue;
    if (k <= K_POWER) globals.add(connectionName(entName[e]));
    let s = perInst.get(entInst[e]);
    if (!s) perInst.set(entInst[e], s = new Set());
    s.add(connectionName(entName[e]));
  }
  const report = (names: Set<string>, inst: number): void => {
    const list = [...names].sort(cmp);
    const e = g.entries.find(x => entInst[x] === inst && entAt[x]);
    diag.add({ severity: 'warning', code: 'NET_NAME_CONFLICT', message: `One net carries different names (${list.map(x => `"${x}"`).join(', ')}); all are kept as aliases.`, defId: resolved[inst].def.id, instancePath: paths[inst], at: e === undefined ? undefined : entAt[e] });
  };
  if (globals.size > 1) { const first = g.entries.find(e => entKind[e] <= K_POWER)!; report(globals, entInst[first]); return; }
  for (const [inst, names] of perInst) if (names.size > 1) { report(names, inst); return; }
}

// ---------------------------------------------------------------------------------------------------------------
// Declared connectivity (EAGLE)
// ---------------------------------------------------------------------------------------------------------------

interface Placement { inst: number; sym: number; pin: number }

function computeDeclared(schematic: Schematic, resolved: Resolved[], env: Env): SchConnectivity {
  const n = resolved.length;
  const paths = resolved.map(r => r.inst.path);
  const instIndex = new Map<string, number>(); resolved.forEach((r, i) => instIndex.set(r.inst.path, i));
  const quiet = new Diagnostics(true);
  const geoCache = new Map<string, DefGeom>();
  const geos = resolved.map(r => { let g = geoCache.get(r.def.id); if (!g) { g = buildDefGeom(r.def, env, quiet); geoCache.set(r.def.id, g); } return g; });
  const symIndex = new Map<string, Map<string, { s: number; pins: Map<string, number> }>>();
  const lookup = (defId: string, def: SchSheetDef, symbolId: string, pinId: string): { s: number; k: number } | null => {
    let m = symIndex.get(defId);
    if (!m) {
      m = new Map();
      def.symbols.forEach((sym, s) => { if (!m!.has(sym.id)) m!.set(sym.id, { s, pins: new Map(sym.pins.map((p, k) => [p.id, k] as [string, number]).reverse()) }); });
      symIndex.set(defId, m);
    }
    const e = m.get(symbolId);
    const k = e?.pins.get(pinId);
    return e && k !== undefined ? { s: e.s, k } : null;
  };

  const declared = new Map<string, { placements: Placement[]; seen: Set<string> }>();
  const owner = new Map<string, string>();
  const place = (name: string, pl: Placement): void => {
    const path = paths[pl.inst], def = resolved[pl.inst].def;
    const key = pinKey(path, def.symbols[pl.sym].id, def.symbols[pl.sym].pins[pl.pin].id);
    let net = declared.get(name);
    if (!net) declared.set(name, net = { placements: [], seen: new Set() });
    const prev = owner.get(key);
    if (prev !== undefined && prev !== name) { env.diag.add({ severity: 'warning', code: 'PIN_IN_MULTIPLE_NETS', message: `Pin ${key.replace(/\0/g, '/')} is declared in nets "${prev}" and "${name}"; the first is used.`, instancePath: path, defId: def.id }); return; }
    if (net.seen.has(key)) return;
    net.seen.add(key); net.placements.push(pl); owner.set(key, name);
  };
  let unknownPins = 0, emptyNames = 0;
  const declWires: Array<{ name: string; ref: { instancePath: string; defId: string; wireId: string } }> = [];
  for (const d of schematic.declaredNets ?? []) {
    env.tick();
    const name = (d.name ?? '').trim();
    if (!name) { emptyNames++; continue; }
    if (!declared.has(name)) declared.set(name, { placements: [], seen: new Set() });
    for (const ref of d.wires ?? []) declWires.push({ name, ref });
    for (const ref of d.pins) {
      const i = instIndex.get(ref.instancePath);
      const found = i === undefined || resolved[i].def.id !== ref.defId ? null : lookup(ref.defId, resolved[i].def, ref.symbolId, ref.pinId);
      if (i === undefined || !found) { unknownPins++; continue; }
      place(name, { inst: i, sym: found.s, pin: found.k });
    }
  }
  if (emptyNames) env.diag.add({ severity: 'warning', code: 'DECLARED_NET_UNNAMED', message: `${emptyNames} declared net(s) without a name were ignored.` });
  if (unknownPins) env.diag.add({ severity: 'warning', code: 'DECLARED_PIN_UNKNOWN', message: `${unknownPins} declared pin reference(s) point at an unknown sheet instance, symbol or pin and were ignored.` });
  // Power / supply ties of pins that no declared net lists: the model says they tie to the global net of that name.
  for (let i = 0; i < n; i++) {
    const def = resolved[i].def;
    for (let s = 0; s < def.symbols.length; s++) {
      const sym = def.symbols[s];
      for (let k = 0; k < sym.pins.length; k++) {
        const name = (sym.power ? sym.power.net : sym.pins[k].implicitNet)?.trim();
        if (name && !owner.has(pinKey(paths[i], sym.id, sym.pins[k].id))) place(name, { inst: i, sym: s, pin: k });
      }
    }
  }

  const nets: SchNet[] = [];
  const pinNet: Record<string, string> = {};
  const wireNet: Record<string, string> = {};
  const placed = new Map<SchNet, number>();
  const netByName = new Map<string, SchNet>();
  for (const [name, d] of declared) {
    const items: Array<{ m: SchNetMember; mergeable: boolean }> = [];
    for (const pl of d.placements) {
      const def = resolved[pl.inst].def, sym = def.symbols[pl.sym], pin = sym.pins[pl.pin];
      const key = pinKey(paths[pl.inst], sym.id, pin.id);
      pinNet[key] = `net:global:${name}`;
      if (isVirtual(sym)) continue;
      const ref = (symbolRef(sym, paths[pl.inst]) ?? '').trim();
      items.push({ m: { instancePath: paths[pl.inst], defId: def.id, symbolId: sym.id, pinId: pin.id, ref, unit: symbolUnit(sym, paths[pl.inst]), pinNumber: pin.number, pinName: pin.name }, mergeable: annotated(ref) });
    }
    const net: SchNet = { id: `net:global:${name}`, name, auto: /^N\$\d+$/.test(name), scope: 'global', aliases: [name], members: dedupeMembers(items), wires: [] };
    placed.set(net, d.placements.length); netByName.set(name, net);
    nets.push(net);
  }

  // Wires the source lists per net are taken as declared (first listing wins); nothing is inferred for them.
  const wireIds = new Map<string, Set<string>>();
  let unknownWires = 0;
  for (const { name, ref } of declWires) {
    const i = instIndex.get(ref.instancePath);
    const def = i === undefined ? undefined : resolved[i].def;
    let ids = def ? wireIds.get(def.id) : undefined;
    if (def && !ids) wireIds.set(def.id, ids = new Set(def.wires.map(w => w.id)));
    const net = netByName.get(name);
    if (i === undefined || !def || def.id !== ref.defId || !ids || !ids.has(ref.wireId) || !net) { unknownWires++; continue; }
    const key = wireKey(paths[i], ref.wireId);
    const prev = wireNet[key];
    if (prev !== undefined) {
      if (prev !== net.id) env.diag.add({ severity: 'warning', code: 'WIRE_IN_MULTIPLE_NETS', message: `Wire "${ref.wireId}" is declared in nets "${prev.slice('net:global:'.length)}" and "${name}"; the first is used.`, defId: def.id, instancePath: paths[i] });
      continue;
    }
    wireNet[key] = net.id;
    net.wires.push({ instancePath: paths[i], wireId: ref.wireId });
  }
  if (unknownWires) env.diag.add({ severity: 'warning', code: 'DECLARED_WIRE_UNKNOWN', message: `${unknownWires} declared wire reference(s) point at an unknown sheet instance or wire and were ignored.` });

  // Remaining wires (not listed by the source): attributed only when the evidence agrees, never merged by geometry.
  for (let i = 0; i < n; i++) {
    env.tick();
    const geo = geos[i], def = resolved[i].def;
    const compNet = new Map<number, string | null>();
    const note = (c: number, name: string): void => { const prev = compNet.get(c); compNet.set(c, prev === undefined || prev === name ? name : null); };
    for (let s = 0; s < def.symbols.length; s++) {
      for (let k = 0; k < def.symbols[s].pins.length; k++) {
        const c = geo.pinComp[geo.symStart[s] + k];
        const name = c >= 0 ? owner.get(pinKey(paths[i], def.symbols[s].id, def.symbols[s].pins[k].id)) : undefined;
        if (name !== undefined) note(c, name);
      }
    }
    const labelNet = new Map<number, string | null>();
    for (const item of geo.labels) if (declared.has(item.text)) for (const c of item.comps) { const prev = labelNet.get(c); labelNet.set(c, prev === undefined || prev === item.text ? item.text : null); }
    let ambiguous = 0;
    for (let w = 0; w < geo.wireComp.length; w++) {
      const c = geo.wireComp[w];
      if (c < 0 || wireNet[wireKey(paths[i], def.wires[w].id)] !== undefined) continue;
      let name = compNet.get(c);
      if (name === undefined) name = labelNet.get(c);
      if (name === null) { ambiguous++; continue; }
      if (name === undefined) continue;
      const net = netByName.get(name);
      if (!net) continue;
      net.wires.push({ instancePath: paths[i], wireId: def.wires[w].id });
      wireNet[wireKey(paths[i], def.wires[w].id)] = net.id;
    }
    if (ambiguous) env.diag.add({ severity: 'info', code: 'DECLARED_WIRE_AMBIGUOUS', message: `${ambiguous} wire(s) touch pins of different declared nets or labels of different names; they are not attributed to any net.`, defId: def.id, instancePath: paths[i] });
  }

  const noConnectPins: string[] = [], floatingPins: string[] = [];
  for (let i = 0; i < n; i++) {
    const geo = geos[i], def = resolved[i].def;
    for (let s = 0; s < def.symbols.length; s++) {
      const sym = def.symbols[s];
      if (isVirtual(sym)) continue;
      for (let k = 0; k < sym.pins.length; k++) {
        const key = pinKey(paths[i], sym.id, sym.pins[k].id);
        if (geo.pinNc[geo.symStart[s] + k]) {
          noConnectPins.push(key);
          if (owner.has(key)) env.diag.add({ severity: 'warning', code: 'NO_CONNECT_CONFLICT', message: `Pin ${sym.refDefault || sym.id}:${sym.pins[k].number} carries a no-connect flag but is declared in net "${owner.get(key)}".`, defId: def.id, instancePath: paths[i], at: sym.pins[k].at });
        } else if (!owner.has(key)) floatingPins.push(key);
      }
    }
  }
  const kept = nets.filter(net => (placed.get(net) ?? 0) + net.wires.length > 0);
  return finishResult(kept, pinNet, wireNet, noConnectPins, floatingPins, env);
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------

/**
 * Computes nets for one schematic document. Throws `SchematicError` with code 'LIMIT_EXCEEDED' when SCHEMATIC_LIMITS are
 * exceeded and 'ABORTED' when `options.signal` fires; every other irregularity becomes a diagnostic.
 */
export function computeConnectivity(schematic: Schematic, options: ConnectivityOptions = {}): SchConnectivity {
  const env = new Env(options.signal, options.busAliases);
  env.check();
  const defs = new Map<string, SchSheetDef>();
  for (const def of schematic.defs) if (!defs.has(def.id)) defs.set(def.id, def); else env.diag.add({ severity: 'error', code: 'DEF_DUPLICATE', message: `Sheet definition id "${def.id}" occurs more than once; the repeat was ignored.`, defId: def.id });
  const resolved = resolveInstances(schematic, defs, env);
  if (schematic.declaredNets) return computeDeclared(schematic, resolved, env);
  if (schematic.format === 'eagle-sch') env.diag.add({ severity: 'warning', code: 'DECLARED_NETS_MISSING', message: 'An EAGLE schematic without declared nets: connectivity was derived from geometry, which EAGLE does not define.' });
  return computeGeometric(schematic, resolved, env);
}
