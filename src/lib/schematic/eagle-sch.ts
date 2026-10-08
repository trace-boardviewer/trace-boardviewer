/*
 * Original TRACE adapter, MIT. Format reference: the EAGLE XML DTD (eagle.dtd, shipped with EAGLE) and the Autodesk
 * Fusion ECAD ULP object reference (UL_INSTANCE, UL_PART, UL_GATE, UL_PIN, UL_WIRE, UL_SEGMENT, UL_TEXT),
 * https://help.autodesk.com/cloudhelp/ENU/Fusion-ECAD/files/ECD-ULP-OBJECT-TYPES.htm .
 * EAGLE XML coordinates are millimetres with Y up, angles are counter-clockwise degrees; the model is Y down.
 *
 * Connectivity is DECLARED by the file (nets/segment/pinref), never recomputed from geometry. A pin's `number` is the
 * board PAD name taken from the device `connects` (gate + pin -> pad), because cross-probing to the board needs it.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { boundText } from '../bounded-text';
import {
  SCHEMATIC_LIMITS, SchematicError,
  type SchBounds, type SchBus, type SchDeclaredNet, type SchDiagnostic, type SchField, type SchGraphic, type SchJunction, type SchLabel,
  type SchPin, type SchPinType, type SchPoint, type Schematic, type SchematicErrorCode, type SchematicParser, type SchSheetDef,
  type SchSheetInstance, type SchSeverity, type SchSymbol, type SchTextGraphic, type SchWire,
} from './model';

type Xml = Record<string, unknown>;
const FORMAT = 'eagle-sch' as const;
const REPEATED = new Set(['library', 'symbol', 'deviceset', 'gate', 'device', 'connect', 'technology', 'attribute', 'pin', 'wire', 'rectangle', 'circle', 'polygon',
  'vertex', 'text', 'frame', 'part', 'variant', 'variantdef', 'sheet', 'instance', 'bus', 'net', 'segment', 'pinref', 'portref', 'junction', 'label', 'probe',
  'moduleinst', 'module', 'package', 'dimension', 'hole']);
const MAX_DIAGNOSTICS = 2000;
const ARC_STEP = Math.PI / 32;
const PIN_LENGTH: Record<string, number> = { point: 0, short: 2.54, middle: 5.08, long: 7.62 };
const PIN_TYPE: Record<string, SchPinType> = { nc: 'no_connect', in: 'input', out: 'output', io: 'bidirectional', oc: 'open_collector', pwr: 'power_in', pas: 'passive', hiz: 'tri_state', sup: 'power_in' };

const fail = (message: string, code: SchematicErrorCode = 'INVALID_FORMAT') => new SchematicError(message, code, FORMAT);
const obj = (value: unknown): Xml | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Xml : undefined;
const list = (value: unknown): Xml[] => Array.isArray(value) ? value.map(obj).filter((item): item is Xml => !!item) : [];
const snap = (value: number) => Math.round(value * 1e6) / 1e6 + 0; // 1 nm grid; also turns -0 into 0
const norm = (degrees: number) => ((degrees % 360) + 360) % 360;

/** Only the five predefined XML entities and character references; DOCTYPE entities are never expanded (and are rejected). */
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] !== '#') return ENTITIES[body] ?? match;
    const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}
const attr = (node: Xml, name: string): string | undefined => { const value = node[`@${name}`]; return typeof value === 'string' ? decodeEntities(value) : undefined; };
const required = (node: Xml, name: string, context: string): string => {
  const value = attr(node, name);
  if (value === undefined || !value.trim()) throw fail(`EAGLE ${context} is missing its ${name} attribute.`);
  return value;
};
const content = (node: Xml): string => { const value = node['#text']; return typeof value === 'string' ? decodeEntities(value) : ''; };
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function parseNumber(value: string, context: string): number {
  const result = NUMBER.test(value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isFinite(result)) throw fail(`EAGLE ${context} is not a finite number ("${value.slice(0, 40)}").`);
  return result;
}
const num = (node: Xml, name: string, context: string): number => parseNumber(required(node, name, context), `${context} ${name}`);
const numOr = (node: Xml, name: string, context: string, fallback: number): number => attr(node, name) === undefined ? fallback : num(node, name, context);
function coord(node: Xml, name: string, context: string): number {
  const value = num(node, name, context);
  if (Math.abs(value) > SCHEMATIC_LIMITS.maxCoordinateMm) throw fail(`EAGLE ${context} ${name} exceeds the ${SCHEMATIC_LIMITS.maxCoordinateMm} mm coordinate limit.`);
  return value;
}

interface Rot { mirror: boolean; spin: boolean; degrees: number }
/** rot="[S][M]R<angle>": S = spin (text is not turned upside-down), M = mirrored about the vertical axis, R = counter-clockwise degrees. */
function rotation(value: string | undefined, context: string): Rot {
  if (value === undefined) return { mirror: false, spin: false, degrees: 0 };
  const match = /^(S?)(M?)R(-?\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) throw fail(`EAGLE ${context} has an invalid rot attribute "${value.slice(0, 40)}".`);
  return { spin: match[1] === 'S', mirror: match[2] === 'M', degrees: norm(parseNumber(match[3], `${context} rotation`)) };
}
const rightAngle = (degrees: number) => degrees % 90 === 0;
function cosSin(degrees: number): [number, number] {
  if (rightAngle(degrees)) { const quarter = ((degrees / 90) % 4 + 4) % 4; return [[1, 0, -1, 0][quarter], [0, 1, 0, -1][quarter]]; }
  const radians = degrees * Math.PI / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

/** Placement of a library-local Y-up point on the sheet: mirror about the vertical axis first (x -> -x), then rotate counter-clockwise, then translate; Y flips last. */
interface Xform { ox: number; oy: number; mirror: boolean; spin: boolean; degrees: number; cos: number; sin: number }
const IDENTITY: Xform = { ox: 0, oy: 0, mirror: false, spin: false, degrees: 0, cos: 1, sin: 0 };
const place = (xf: Xform, x: number, y: number): SchPoint => {
  const px = xf.mirror ? -x : x;
  return { x: snap(xf.ox + px * xf.cos - y * xf.sin), y: snap(-(xf.oy + px * xf.sin + y * xf.cos)) };
};

/** EAGLE wire curve: the arc spans `curve` degrees from a to b, positive = counter-clockwise. Null when it cannot be an arc. */
function arcPoints(a: SchPoint, b: SchPoint, curve: number): SchPoint[] | null {
  const chord = Math.hypot(b.x - a.x, b.y - a.y), sweep = curve * Math.PI / 180;
  if (!(chord > 0) || Math.abs(curve) >= 360) return null;
  if (Math.abs(sweep) < 1e-9) return [a, b];
  const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2)), offset = Math.sign(curve) * radius * Math.cos(Math.abs(sweep) / 2);
  const center = { x: (a.x + b.x) / 2 - (b.y - a.y) / chord * offset, y: (a.y + b.y) / 2 + (b.x - a.x) / chord * offset };
  const start = Math.atan2(a.y - center.y, a.x - center.x), steps = Math.max(2, Math.min(4096, Math.ceil(Math.abs(sweep) / ARC_STEP)));
  const middle = Array.from({ length: steps - 1 }, (_, i) => ({ x: center.x + radius * Math.cos(start + sweep * (i + 1) / steps), y: center.y + radius * Math.sin(start + sweep * (i + 1) / steps) }));
  return [a, ...middle, b];
}

// ---------------------------------------------------------------------------------------------------------------
// Input handling: decoding, prolog scan (root element, never an XML declaration), budgets
// ---------------------------------------------------------------------------------------------------------------

function decodeText(data: Uint8Array): string {
  let label = 'utf-8', start = 0;
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) start = 3;
  else if (data[0] === 0xff && data[1] === 0xfe) { label = 'utf-16le'; start = 2; }
  else if (data[0] === 0xfe && data[1] === 0xff) { label = 'utf-16be'; start = 2; }
  else {
    const declared = /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']/.exec(new TextDecoder('latin1').decode(data.subarray(0, 256)));
    if (declared && !/^(?:utf-?(?:16|32)|ucs)/i.test(declared[1])) label = declared[1].toLowerCase();
  }
  try { return new TextDecoder(label).decode(data.subarray(start)); } catch { return new TextDecoder().decode(data.subarray(start)); }
}

/** Skips declaration, comments, PIs and DOCTYPE (noting any internal-subset ENTITY declaration) and returns the root element name. */
function scanProlog(text: string): { root: string | null; entities: boolean } {
  let pos = 0, entities = false;
  const none = { root: null, entities };
  for (let guard = 0; guard < 100_000; guard++) {
    while (pos < text.length && /\s/.test(text[pos])) pos++;
    if (text.startsWith('<?', pos)) { const end = text.indexOf('?>', pos + 2); if (end < 0) return none; pos = end + 2; continue; }
    if (text.startsWith('<!--', pos)) { const end = text.indexOf('-->', pos + 4); if (end < 0) return none; pos = end + 3; continue; }
    if (text.startsWith('<!DOCTYPE', pos)) {
      let i = pos + 9, subset = false, closed = false;
      while (i < text.length) {
        const c = text[i];
        if (c === '"' || c === "'") { const end = text.indexOf(c, i + 1); if (end < 0) return { root: null, entities }; i = end + 1; continue; }
        if (subset && text.startsWith('<!--', i)) { const end = text.indexOf('-->', i + 4); if (end < 0) return { root: null, entities }; i = end + 3; continue; }
        if (subset && text.startsWith('<!ENTITY', i)) entities = true;
        if (c === '[') subset = true; else if (c === ']') subset = false; else if (c === '>' && !subset) { closed = true; break; }
        i++;
      }
      if (!closed) return { root: null, entities };
      pos = i + 1; continue;
    }
    const root = /<([A-Za-z_][\w.:-]*)/y; root.lastIndex = pos;
    const match = root.exec(text);
    return { root: match ? match[1] : null, entities };
  }
  return none;
}

/** One pass over the tag starts: bounds the expanded model before the parser allocates anything. */
function checkBudgets(text: string): void {
  const limits = SCHEMATIC_LIMITS, tag = /<([A-Za-z_][\w.:-]*)/g;
  let total = 0, sheets = 0, instances = 0, wires = 0;
  for (let match = tag.exec(text); match; match = tag.exec(text)) {
    if (++total > limits.maxExpression) throw fail(`EAGLE schematic exceeds the ${limits.maxExpression} element import limit.`, 'LIMIT_EXCEEDED');
    switch (match[1]) {
      case 'sheet': if (++sheets > limits.maxSheetDefs) throw fail(`EAGLE schematic exceeds the ${limits.maxSheetDefs} sheet import limit.`, 'LIMIT_EXCEEDED'); break;
      case 'instance': if (++instances > limits.maxSymbolsPerDef) throw fail(`EAGLE schematic exceeds the ${limits.maxSymbolsPerDef} placed gate import limit.`, 'LIMIT_EXCEEDED'); break;
      case 'wire': if (++wires > limits.maxWiresPerDef) throw fail(`EAGLE schematic exceeds the ${limits.maxWiresPerDef} wire import limit.`, 'LIMIT_EXCEEDED'); break;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Library primitives (symbol bodies and sheet `plain` share the same element kinds)
// ---------------------------------------------------------------------------------------------------------------

type Vertex = { x: number; y: number; curve: number };
type Prim =
  | { k: 'wire'; x1: number; y1: number; x2: number; y2: number; curve: number; width: number }
  | { k: 'rect'; x1: number; y1: number; x2: number; y2: number; rot: Rot }
  | { k: 'circle'; x: number; y: number; radius: number; width: number }
  | { k: 'poly'; vertices: Vertex[]; width: number }
  | { k: 'text'; x: number; y: number; text: string; size: number; rot: Rot; align: string }
  | { k: 'frame'; x1: number; y1: number; x2: number; y2: number };
interface LibPin { name: string; x: number; y: number; degrees: number; length: number; type: SchPinType; direction: string }
interface LibSymbol { prims: Prim[]; pins: LibPin[] }

function readPrims(node: Xml, context: string): Prim[] {
  const prims: Prim[] = [];
  for (const w of list(node.wire)) prims.push({ k: 'wire', x1: coord(w, 'x1', `${context} wire`), y1: coord(w, 'y1', `${context} wire`), x2: coord(w, 'x2', `${context} wire`), y2: coord(w, 'y2', `${context} wire`), curve: numOr(w, 'curve', `${context} wire`, 0), width: numOr(w, 'width', `${context} wire`, 0) });
  for (const r of list(node.rectangle)) prims.push({ k: 'rect', x1: coord(r, 'x1', `${context} rectangle`), y1: coord(r, 'y1', `${context} rectangle`), x2: coord(r, 'x2', `${context} rectangle`), y2: coord(r, 'y2', `${context} rectangle`), rot: rotation(attr(r, 'rot'), `${context} rectangle`) });
  for (const c of list(node.circle)) prims.push({ k: 'circle', x: coord(c, 'x', `${context} circle`), y: coord(c, 'y', `${context} circle`), radius: Math.abs(num(c, 'radius', `${context} circle`)), width: numOr(c, 'width', `${context} circle`, 0) });
  for (const p of list(node.polygon)) {
    const vertices = list(p.vertex).map(v => ({ x: coord(v, 'x', `${context} vertex`), y: coord(v, 'y', `${context} vertex`), curve: numOr(v, 'curve', `${context} vertex`, 0) }));
    if (vertices.length) prims.push({ k: 'poly', vertices, width: numOr(p, 'width', `${context} polygon`, 0) });
  }
  for (const t of list(node.text)) prims.push({ k: 'text', x: coord(t, 'x', `${context} text`), y: coord(t, 'y', `${context} text`), text: content(t), size: numOr(t, 'size', `${context} text`, 1.27), rot: rotation(attr(t, 'rot'), `${context} text`), align: attr(t, 'align') ?? 'bottom-left' });
  for (const f of list(node.frame)) prims.push({ k: 'frame', x1: coord(f, 'x1', `${context} frame`), y1: coord(f, 'y1', `${context} frame`), x2: coord(f, 'x2', `${context} frame`), y2: coord(f, 'y2', `${context} frame`) });
  return prims;
}

function readSymbol(node: Xml, context: string): LibSymbol {
  const pins = list(node.pin).map((pin): LibPin => {
    const name = required(pin, 'name', `${context} pin`), where = `${context} pin ${name}`, length = attr(pin, 'length') ?? 'long', direction = attr(pin, 'direction') ?? 'io';
    if (!(length in PIN_LENGTH)) throw fail(`EAGLE ${where} has an unknown length "${length.slice(0, 40)}".`);
    const turn = rotation(attr(pin, 'rot'), where);
    if (turn.mirror || !rightAngle(turn.degrees)) throw fail(`EAGLE ${where} must be rotated by a multiple of 90 degrees and not mirrored.`);
    return { name, x: coord(pin, 'x', where), y: coord(pin, 'y', where), degrees: turn.degrees, length: PIN_LENGTH[length], type: PIN_TYPE[direction] ?? 'unspecified', direction };
  });
  return { prims: readPrims(node, context), pins };
}

// ---------------------------------------------------------------------------------------------------------------
// Libraries: symbols, devicesets (gates), devices (connects)
// ---------------------------------------------------------------------------------------------------------------

interface Lib { name: string; urn: string; symbols: Map<string, Xml>; devicesets: Map<string, Xml>; parsed: Map<string, LibSymbol> }
interface GatePlan { name: string; unit: number; symbolName: string; symbol: LibSymbol | null; pads: Map<string, string[]> }
interface DevicePlan { libId: string; footprint: string; packaged: boolean; supply: boolean; unitCount: number; gates: Map<string, GatePlan> }
interface PartInfo { name: string; library: string; urn: string | undefined; deviceset: string; device: string; technology: string; value: string; dnp: boolean; attributes: SchField[] }
interface PlacedGate { defId: string; symbolId: string; byPin: Map<string, SchPin[]> }

class Diagnostics {
  readonly items: SchDiagnostic[] = [];
  private dropped = 0;
  add(severity: SchSeverity, code: string, message: string, defId?: string): void {
    if (this.items.length >= MAX_DIAGNOSTICS) { this.dropped++; return; }
    this.items.push({ severity, code, message: boundText(message), ...defId ? { defId, instancePath: defId } : {} });
  }
  finish(): SchDiagnostic[] {
    if (this.dropped) this.items.push({ severity: 'info', code: 'DIAGNOSTICS_TRUNCATED', message: `${this.dropped} further diagnostics were omitted.` });
    return this.items;
  }
}

class Box {
  private minX = Infinity; private minY = Infinity; private maxX = -Infinity; private maxY = -Infinity;
  add(p: SchPoint): void { this.minX = Math.min(this.minX, p.x); this.minY = Math.min(this.minY, p.y); this.maxX = Math.max(this.maxX, p.x); this.maxY = Math.max(this.maxY, p.y); }
  merge(b: SchBounds): void { this.add({ x: b.minX, y: b.minY }); this.add({ x: b.maxX, y: b.maxY }); }
  get empty(): boolean { return this.minX > this.maxX; }
  bounds(): SchBounds { return this.empty ? { minX: 0, minY: 0, maxX: 0, maxY: 0 } : { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY }; }
}

/**
 * Replaces every "<...>" span (up to the first ">" after a "<") with a space; a "<" with no ">" after it stays. One pass over the text:
 * the pattern `/<[^>]*>/g` rescans to the end from every "<" when no ">" follows, which is quadratic (a description of 100,000 "&lt;").
 */
function stripTags(text: string): string {
  let out = '', from = 0;
  for (;;) {
    const open = text.indexOf('<', from);
    if (open < 0) break;
    const close = text.indexOf('>', open + 1);
    if (close < 0) break;
    out += `${text.slice(from, open)} `;
    from = close + 1;
  }
  return out + text.slice(from);
}

const descriptionOf = (node: Xml | undefined): string => {
  const value = node?.description;
  const first = Array.isArray(value) ? value[0] : value;
  const text = typeof first === 'string' ? first : obj(first) ? content(obj(first) as Xml) : '';
  return stripTags(decodeEntities(text)).replace(/\s+/g, ' ').trim().slice(0, 200);
};

const ALIGN_H: Record<string, number> = { left: 0, center: 1, right: 2 }, ALIGN_V: Record<string, number> = { bottom: 0, center: 1, top: 2 };
function textGraphic(xf: Xform, x: number, y: number, text: string, size: number, rot: Rot, align: string): SchTextGraphic {
  // A mirrored placement reflects the text box: its reading direction becomes 180 - angle (before the placement rotation).
  let phi = norm((xf.mirror ? 180 - rot.degrees : rot.degrees) + xf.degrees);
  const parts = align === 'center' ? ['center', 'center'] : align.split('-');
  let h = ALIGN_H[parts[1] ?? 'left'] ?? 0, v = ALIGN_V[parts[0] ?? 'bottom'] ?? 0;
  // EAGLE keeps text readable from the bottom or the right unless it is spun: upside-down text is turned and its alignment mirrored.
  if (!xf.spin && !rot.spin && phi > 90 && phi <= 270) { phi = norm(phi - 180); h = 2 - h; v = 2 - v; }
  const at = place(xf, x, y), [c, s] = cosSin(phi), drop = v * size / 2; // vertical alignment is estimated from the text size
  return { kind: 'text', at: { x: snap(at.x + drop * s), y: snap(at.y + drop * c) }, text, angle: snap(phi), size, anchor: h === 0 ? 'start' : h === 1 ? 'middle' : 'end' };
}

/** Running totals that bound the EXPANDED drawing output: a symbol with many primitives placed many times multiplies, which the tag counts cannot see. */
interface Budget { sheet: number; total: number }
function spend(budget: Budget, count: number): void {
  budget.sheet += count; budget.total += count;
  if (budget.sheet > SCHEMATIC_LIMITS.maxWiresPerDef || budget.total > SCHEMATIC_LIMITS.maxPinsTotal) throw fail('EAGLE schematic exceeds the drawing primitive import limit.', 'LIMIT_EXCEEDED');
}

/** Graphics of `prims` placed with `xf`; arcs are sampled into polylines. `labelFor` maps text content (">NAME") to the shown string, undefined = drop. */
function placePrims(prims: Prim[], xf: Xform, labelFor: (text: string) => string | undefined, diag: Diagnostics, budget: Budget, defId: string): SchGraphic[] {
  spend(budget, prims.length);
  const out: SchGraphic[] = [];
  const through = (points: SchPoint[]) => points.map(p => place(xf, p.x, p.y));
  const arc = (a: SchPoint, b: SchPoint, curve: number): SchPoint[] => {
    if (!curve) return [a, b];
    const points = arcPoints(a, b, curve);
    if (!points) { diag.add('warning', 'ARC_DEGENERATE', `A curved EAGLE shape (curve ${curve}) has no valid arc geometry; it is drawn straight.`, defId); return [a, b]; }
    spend(budget, points.length);
    return points;
  };
  for (const prim of prims) {
    switch (prim.k) {
      case 'wire': out.push({ kind: 'poly', points: through(arc({ x: prim.x1, y: prim.y1 }, { x: prim.x2, y: prim.y2 }, prim.curve)), width: prim.width, filled: false }); break;
      case 'poly': {
        const points: SchPoint[] = [];
        prim.vertices.forEach((v, i) => {
          points.push({ x: v.x, y: v.y });
          if (v.curve) points.push(...arc(v, prim.vertices[(i + 1) % prim.vertices.length], v.curve).slice(1, -1)); // the curve belongs to the edge towards the next vertex
        });
        out.push({ kind: 'poly', points: through(points), width: prim.width, filled: true }); break;
      }
      case 'circle': out.push({ kind: 'circle', center: place(xf, prim.x, prim.y), radius: prim.radius, width: prim.width, fill: prim.width === 0 ? 'outline' : 'none' }); break;
      case 'rect': case 'frame': {
        const x1 = Math.min(prim.x1, prim.x2), x2 = Math.max(prim.x1, prim.x2), y1 = Math.min(prim.y1, prim.y2), y2 = Math.max(prim.y1, prim.y2), turn = prim.k === 'rect' ? prim.rot : undefined;
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, hx = (x2 - x1) / 2, hy = (y2 - y1) / 2, fill = prim.k === 'rect' ? 'outline' as const : 'none' as const;
        if (!turn || rightAngle(turn.degrees)) { // axis-aligned stays a rectangle under any right-angle placement
          const swap = !!turn && turn.degrees % 180 !== 0, ex = swap ? hy : hx, ey = swap ? hx : hy;
          const a = place(xf, cx - ex, cy - ey), b = place(xf, cx + ex, cy + ey);
          out.push({ kind: 'rect', min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }, width: 0, fill });
        } else {
          const [c, s] = cosSin(turn.degrees), corners = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([px, py]) => place(xf, cx + px * c - py * s, cy + px * s + py * c));
          out.push({ kind: 'poly', points: [...corners, corners[0]], width: 0, filled: fill === 'outline' });
        }
        break;
      }
      case 'text': { const shown = labelFor(prim.text); if (shown) out.push(textGraphic(xf, prim.x, prim.y, shown, prim.size, prim.rot, prim.align)); break; }
    }
  }
  return out;
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
// Parser
// ---------------------------------------------------------------------------------------------------------------

export const parseEagleSch: SchematicParser = input => {
  const text = decodeText(input.data), prolog = scanProlog(text);
  // Recognition is by the XML root only: a bare <eagle>, a comment- or DOCTYPE-prefixed document are all valid.
  if (prolog.root !== 'eagle' || !/<schematic[\s>/]/.test(text)) return null;
  if (prolog.entities) throw fail('EAGLE document declares DOCTYPE entities; entity declarations are never expanded.');
  checkBudgets(text);
  const verdict = XMLValidator.validate(text);
  if (verdict !== true) throw fail(`EAGLE XML is malformed: ${String(verdict.err.msg).slice(0, 200)} (line ${verdict.err.line}).`);
  let document: unknown;
  try {
    document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', ignoreDeclaration: true, ignorePiTags: true, processEntities: false,
      parseTagValue: false, parseAttributeValue: false, trimValues: true, maxNestedTags: SCHEMATIC_LIMITS.maxNestingDepth, isArray: name => REPEATED.has(name) }).parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unreadable document';
    throw fail(`EAGLE XML is malformed: ${message.slice(0, 200)}.`, /nested/i.test(message) ? 'LIMIT_EXCEEDED' : 'INVALID_FORMAT');
  }
  const root = obj(obj(document)?.eagle), schematic = obj(obj(root?.drawing)?.schematic);
  if (!root || !schematic) return null;
  return build(input.name, root, schematic);
};

interface PinRef { net: string; node: Xml; defId: string }
interface DeclaredNet extends SchDeclaredNet { wires: NonNullable<SchDeclaredNet['wires']> }

function build(fileName: string, root: Xml, schematic: Xml): Schematic {
  const limits = SCHEMATIC_LIMITS, diag = new Diagnostics(), budget: Budget = { sheet: 0, total: 0 };
  const stem = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '') || 'schematic';
  const version = attr(root, 'version')?.trim().slice(0, 24) ?? '';
  if (!version) diag.add('warning', 'VERSION_MISSING', 'The EAGLE document has no version attribute.');
  else if (!(Number.parseInt(version, 10) >= 6)) diag.add('warning', 'VERSION_UNKNOWN', `EAGLE XML version "${version}" is older than 6.0 and was not tested; the file is read as written.`);

  // Libraries are read lazily: only the symbols and devices that parts use, so unused library content can never fail the import.
  const libraries: Lib[] = [], libraryByName = new Map<string, Lib[]>();
  for (const library of list(obj(schematic.libraries)?.library)) {
    const name = required(library, 'name', 'library'), symbols = new Map<string, Xml>(), devicesets = new Map<string, Xml>();
    for (const symbol of list(obj(library.symbols)?.symbol)) { const symbolName = required(symbol, 'name', `library ${name} symbol`); if (!symbols.has(symbolName)) symbols.set(symbolName, symbol); }
    for (const set of list(obj(library.devicesets)?.deviceset)) { const setName = required(set, 'name', `library ${name} deviceset`); if (!devicesets.has(setName)) devicesets.set(setName, set); }
    const lib: Lib = { name, urn: attr(library, 'urn') ?? '', symbols, devicesets, parsed: new Map() };
    libraries.push(lib); libraryByName.set(name, [...libraryByName.get(name) ?? [], lib]);
  }
  const findLibrary = (name: string, urn: string | undefined): Lib | undefined => {
    const all = libraryByName.get(name);
    if (!all) return undefined;
    const exact = urn ? all.find(candidate => candidate.urn === urn) : undefined;
    if (!exact && all.length > 1) diag.add('warning', 'LIBRARY_AMBIGUOUS', `EAGLE library "${name}" is defined ${all.length} times and the part does not name a unique one; the first is used.`);
    return exact ?? all[0];
  };

  // The current assembly variant may mark parts as not populated or give them another value/technology.
  const variantName = list(obj(schematic.variantdefs)?.variantdef).find(def => attr(def, 'current') === 'yes');
  const currentVariant = variantName ? attr(variantName, 'name') : undefined;
  const parts = new Map<string, PartInfo>();
  for (const node of list(obj(schematic.parts)?.part)) {
    const name = required(node, 'name', 'part');
    if (parts.has(name)) { diag.add('error', 'PART_DUPLICATE', `EAGLE declares part "${name}" more than once; the first declaration is used.`); continue; }
    const variant = currentVariant === undefined ? undefined : list(node.variant).find(candidate => attr(candidate, 'name') === currentVariant);
    const attributes = list(node.attribute).map((a): SchField => ({ name: attr(a, 'name') ?? '', value: attr(a, 'value') ?? '', hidden: (attr(a, 'display') ?? 'value') === 'off' })).filter(a => a.name);
    parts.set(name, {
      name, library: required(node, 'library', `part ${name}`), urn: attr(node, 'library_urn'), deviceset: required(node, 'deviceset', `part ${name}`), device: attr(node, 'device') ?? '',
      technology: (variant && attr(variant, 'technology')) ?? attr(node, 'technology') ?? '', value: (variant && attr(variant, 'value')) ?? attr(node, 'value') ?? '',
      dnp: !!variant && attr(variant, 'populate') === 'no', attributes,
    });
  }

  const plans = new Map<string, DevicePlan>();
  const brokenPlan = (libId: string): DevicePlan => ({ libId, footprint: '', packaged: true, supply: false, unitCount: 1, gates: new Map() });
  const symbolOf = (lib: Lib, name: string): LibSymbol | null => {
    const cached = lib.parsed.get(name);
    if (cached) return cached;
    const node = lib.symbols.get(name);
    if (!node) return null;
    const read = readSymbol(node, `library ${lib.name} symbol ${name}`);
    // Pin names are unique in a symbol (EAGLE writes a repeated visible name as NAME@2). A later pin of an earlier name would get the ids of that pin.
    const seen = new Set<string>(), pins = read.pins.filter(pin => !seen.has(pin.name) && !!seen.add(pin.name));
    if (pins.length < read.pins.length) diag.add('warning', 'PIN_DUPLICATE', `Symbol "${name.slice(0, 80)}" of library "${lib.name.slice(0, 80)}" has ${read.pins.length - pins.length} pin(s) whose name repeats an earlier pin; they are ignored.`);
    const symbol = pins.length < read.pins.length ? { ...read, pins } : read;
    lib.parsed.set(name, symbol);
    return symbol;
  };
  const planFor = (part: PartInfo): DevicePlan => {
    const libId = `${part.library}:${part.deviceset}:${part.device}`, lib = findLibrary(part.library, part.urn);
    const key = `${lib ? libraries.indexOf(lib) : -1}\u0000${libId}`, known = plans.get(key);
    if (known) return known;
    const finish = (plan: DevicePlan) => { plans.set(key, plan); return plan; };
    if (!lib) { diag.add('error', 'LIBRARY_MISSING', `Part ${part.name} uses EAGLE library "${part.library}" which the schematic does not contain; its symbols have no pins.`); return finish(brokenPlan(libId)); }
    const set = lib.devicesets.get(part.deviceset);
    if (!set) { diag.add('error', 'DEVICESET_MISSING', `Part ${part.name} uses deviceset "${part.deviceset}" which library "${part.library}" does not define; its symbols have no pins.`); return finish(brokenPlan(libId)); }
    const device = list(obj(set.devices)?.device).find(candidate => (attr(candidate, 'name') ?? '') === part.device);
    if (!device) { diag.add('error', 'DEVICE_MISSING', `Part ${part.name} uses device "${part.device}" which deviceset "${part.deviceset}" does not define; its symbols have no pins.`); return finish(brokenPlan(libId)); }
    const packageName = attr(device, 'package') ?? '', packaged = packageName !== '', gates = new Map<string, GatePlan>();
    list(obj(set.gates)?.gate).forEach((node, index) => {
      const name = required(node, 'name', `deviceset ${part.deviceset} gate`), symbolName = required(node, 'symbol', `gate ${name}`);
      if (gates.has(name)) { diag.add('warning', 'GATE_DUPLICATE', `Deviceset "${part.deviceset}" declares gate "${name}" twice; the first is used.`); return; }
      const symbol = symbolOf(lib, symbolName);
      if (!symbol) diag.add('error', 'SYMBOL_MISSING', `Gate ${name} of deviceset "${part.deviceset}" uses symbol "${symbolName}" which library "${part.library}" does not define; it has no pins.`);
      gates.set(name, { name, unit: index + 1, symbolName, symbol, pads: new Map() });
    });
    // gate + pin -> pad(s). Pad names cannot contain blanks, so a blank-separated list is an explicit multi-pad pin.
    const owner = new Map<string, string>();
    for (const connect of list(obj(device.connects)?.connect)) {
      const gateName = required(connect, 'gate', 'connect'), pinName = required(connect, 'pin', 'connect'), gate = gates.get(gateName), who = `${gateName}\u0000${pinName}`;
      if (!gate) { diag.add('warning', 'CONNECT_UNKNOWN_GATE', `Device "${part.device}" of "${part.deviceset}" connects unknown gate "${gateName}".`); continue; }
      if (gate.symbol && !gate.symbol.pins.some(pin => pin.name === pinName)) { diag.add('warning', 'CONNECT_UNKNOWN_PIN', `Device "${part.device}" of "${part.deviceset}" connects pin ${gateName}.${pinName} which symbol "${gate.symbolName}" does not have.`); continue; }
      const pads: string[] = [], earlier = gate.pads.get(pinName);
      for (const pad of required(connect, 'pad', `connect ${gateName}.${pinName}`).trim().split(/\s+/)) {
        const claimed = owner.get(pad);
        if (claimed === who) { diag.add('info', 'CONNECT_DUPLICATE', `Device "${part.device}" of "${part.deviceset}" repeats the connection ${gateName}.${pinName} -> pad "${pad}"; the duplicate is ignored.`); continue; }
        if (claimed !== undefined) { diag.add('warning', 'PAD_DUPLICATE', `Pad "${pad}" of "${part.deviceset}" is connected to more than one pin; the later connection is ignored.`); continue; }
        owner.set(pad, who); pads.push(pad);
      }
      if (earlier && pads.length) diag.add('warning', 'CONNECT_REPEATED_PIN', `Device "${part.device}" of "${part.deviceset}" connects pin ${gateName}.${pinName} in several rows with different pads; the pads (${[...earlier, ...pads].join(', ')}) are merged.`);
      else if (pads.length > 1) diag.add('info', 'PIN_MULTI_PAD', `Pin ${gateName}.${pinName} of "${part.deviceset}" is connected to ${pads.length} pads (${pads.join(', ')}); one pin per pad is emitted.`);
      if (pads.length) gate.pads.set(pinName, [...earlier ?? [], ...pads]);
    }
    const only = gates.size === 1 ? [...gates.values()][0] : undefined;
    // A supply symbol (GND, VCC, +5V) is a gate of a package-less device whose only pin has direction "sup"; the pin name is the global net.
    const supply = !!only?.symbol && only.symbol.pins.length === 1 && only.symbol.pins[0].direction === 'sup';
    if (packaged) for (const gate of gates.values()) for (const pin of gate.symbol?.pins ?? []) {
      if (!gate.pads.has(pin.name)) diag.add('warning', 'PIN_NO_PAD', `Pin ${gate.name}.${pin.name} of "${part.deviceset}" (device "${part.device}") has no pad in the device connects; it is omitted.`);
    }
    return finish({ libId, footprint: packageName, packaged, supply, unitCount: Math.max(1, gates.size), gates });
  };

  let pinTotal = 0;
  const placeGate = (node: Xml, part: PartInfo, gateName: string, defId: string): { symbol: SchSymbol; byPin: Map<string, SchPin[]> } => {
    const where = `instance ${part.name}:${gateName}`, plan = planFor(part), gate = plan.gates.get(gateName);
    if (!gate && plan.gates.size) diag.add('error', 'GATE_MISSING', `Instance ${part.name}:${gateName} uses gate "${gateName}" which deviceset "${part.deviceset}" does not define; it has no pins.`, defId);
    const turn = rotation(attr(node, 'rot'), where);
    if (!rightAngle(turn.degrees)) throw fail(`EAGLE ${where} is rotated by ${turn.degrees} degrees; schematic instances turn in multiples of 90.`);
    const [cos, sin] = cosSin(turn.degrees);
    const xf: Xform = { ox: coord(node, 'x', where), oy: coord(node, 'y', where), mirror: turn.mirror, spin: turn.spin, degrees: turn.degrees, cos, sin };
    const id = `${part.name}:${gateName}`, origin = place(xf, 0, 0), box = new Box();
    box.add(origin);

    const smashed = attr(node, 'smashed') === 'yes', own = smashed ? list(node.attribute).filter(a => attr(a, 'x') !== undefined && attr(a, 'y') !== undefined) : [];
    const detached = new Set(own.map(a => (attr(a, 'name') ?? '').toUpperCase()));
    const resolve = (key: string): string | undefined => {
      switch (key) {
        case 'NAME': case 'PART': return part.name;
        case 'VALUE': return part.value;
        case 'GATE': return gateName;
        default: return part.attributes.find(a => a.name.toUpperCase() === key)?.value;
      }
    };
    const labelFor = (text: string): string | undefined => {
      if (!text.startsWith('>')) return text;
      const key = text.slice(1).trim().toUpperCase();
      return detached.has(key) ? undefined : resolve(key) || undefined;
    };
    const graphics: SchGraphic[] = gate?.symbol ? placePrims(gate.symbol.prims, xf, labelFor, diag, budget, defId) : [];
    for (const a of own) { // smashed NAME/VALUE/attribute texts carry their own absolute position
      const name = (attr(a, 'name') ?? '').toUpperCase(), display = attr(a, 'display') ?? 'value', standard = ['NAME', 'VALUE', 'PART', 'GATE'].includes(name);
      const value = standard ? resolve(name) : resolve(name) ?? '';
      const shown = display === 'off' ? '' : standard || display === 'value' ? value : display === 'name' ? attr(a, 'name') : `${attr(a, 'name')}: ${value}`;
      if (shown) graphics.push(textGraphic(IDENTITY, coord(a, 'x', where), coord(a, 'y', where), shown, numOr(a, 'size', where, 1.27), rotation(attr(a, 'rot'), where), attr(a, 'align') ?? 'bottom-left'));
    }
    graphics.forEach(g => graphicPoints(g).forEach(p => box.add(p)));

    const pins: SchPin[] = [], byPin = new Map<string, SchPin[]>();
    for (const libPin of gate?.symbol?.pins ?? []) {
      // Package-less devices (supply symbols, frames, net ties) have no pads and never reach the board: their pin is identified by its name.
      const pads = plan.packaged ? gate?.pads.get(libPin.name) : [libPin.name];
      if (!pads) continue;
      const [pc, ps] = cosSin(libPin.degrees), at = place(xf, libPin.x, libPin.y), body = place(xf, libPin.x + libPin.length * pc, libPin.y + libPin.length * ps);
      pads.forEach((pad, i) => {
        if (++pinTotal > limits.maxPinsTotal) throw fail(`EAGLE schematic exceeds the ${limits.maxPinsTotal} pin import limit.`, 'LIMIT_EXCEEDED');
        // Extra pads of one pin share its geometry: only the first is shown, so labels never overprint.
        const pin: SchPin = { id: `${id}#${pad}`, number: pad, name: libPin.name.replace(/@\d+$/, ''), at: { ...at }, body: { ...body }, type: libPin.type, hidden: i > 0, unit: gate?.unit ?? 1 };
        pins.push(pin);
        const sameName = byPin.get(libPin.name); // appended in place: a pin with many pads must not copy the list for every pad
        if (sameName) sameName.push(pin); else byPin.set(libPin.name, [pin]);
        box.add(pin.at); box.add(pin.body);
      });
    }
    const unit = gate?.unit ?? 1;
    const fields: SchField[] = [{ name: 'Reference', value: part.name, hidden: false }, { name: 'Value', value: part.value, hidden: false },
      ...part.technology ? [{ name: 'Technology', value: part.technology, hidden: true }] : [], ...part.attributes];
    const symbol: SchSymbol = {
      id, libId: plan.libId, refDefault: part.name, instances: { '': { ref: part.name, unit } }, value: part.value, footprint: plan.footprint, datasheet: '', unit, unitCount: plan.unitCount,
      at: origin, rotation: turn.degrees, mirror: turn.mirror ? 'y' : 'none', pins, graphics, fields,
      ...plan.supply && gate?.symbol ? { power: { net: gate.symbol.pins[0].name } } : {}, virtual: !plan.packaged, dnp: part.dnp, bounds: box.bounds(),
    };
    return { symbol, byPin };
  };

  // Sheets
  const sheetNodes = list(obj(schematic.sheets)?.sheet);
  if (!sheetNodes.length) throw fail('EAGLE schematic has no sheets.');
  if (sheetNodes.length > limits.maxSheetDefs || sheetNodes.length > limits.maxInstances) throw fail(`EAGLE schematic exceeds the ${limits.maxSheetDefs} sheet import limit.`, 'LIMIT_EXCEEDED');
  if (list(obj(schematic.modules)?.module).length) diag.add('warning', 'UNSUPPORTED_MODULES', 'EAGLE modules (hierarchical design) are not supported: module contents, instances and ports are ignored and no connectivity through modules is inferred.');

  const defs: SchSheetDef[] = [], instances: SchSheetInstance[] = [], placed = new Map<string, PlacedGate>(), placedGates = new Map<string, Set<string>>(), refs: PinRef[] = [];
  // EAGLE nets are global by name: one declared net per name, collecting the pins and wires of every segment on every sheet.
  const nets = new Map<string, DeclaredNet>(), members = new Map<string, Set<string>>();
  const declare = (name: string): DeclaredNet => {
    let net = nets.get(name);
    if (!net) { net = { name, pins: [], wires: [] }; nets.set(name, net); members.set(name, new Set()); }
    return net;
  };
  sheetNodes.forEach((sheet, index) => {
    const id = `sheet:${index + 1}`, title = descriptionOf(sheet), name = title || `Sheet ${index + 1}`, box = new Box(), symbols: SchSymbol[] = [];
    budget.sheet = 0;
    const instanceNodes = list(obj(sheet.instances)?.instance);
    if (instanceNodes.length > limits.maxSymbolsPerDef) throw fail(`EAGLE sheet ${index + 1} exceeds the ${limits.maxSymbolsPerDef} placed gate import limit.`, 'LIMIT_EXCEEDED');
    if (list(obj(sheet.moduleinsts)?.moduleinst).length) diag.add('warning', 'UNSUPPORTED_MODULES', `EAGLE sheet ${index + 1} contains module instances; they are not supported and are not drawn.`, id);
    const plainLabel = (text: string): string | undefined => {
      if (!text.startsWith('>')) return text;
      const key = text.slice(1).trim().toUpperCase();
      return key === 'DRAWING_NAME' ? stem : key === 'SHEET' ? `${index + 1}/${sheetNodes.length}` : undefined;
    };
    for (const node of instanceNodes) {
      const partName = required(node, 'part', 'instance'), gateName = required(node, 'gate', `instance ${partName}`), key = `${partName}\u0000${gateName}`, part = parts.get(partName);
      if (!part) { diag.add('error', 'INSTANCE_UNKNOWN_PART', `Instance ${partName}:${gateName} refers to a part the schematic does not declare; it is skipped.`, id); continue; }
      if (placed.has(key)) { diag.add('error', 'INSTANCE_DUPLICATE', `Gate ${partName}:${gateName} is placed more than once; the later placement is skipped.`, id); continue; }
      const { symbol, byPin } = placeGate(node, part, gateName, id);
      placed.set(key, { defId: id, symbolId: symbol.id, byPin });
      placedGates.set(partName, (placedGates.get(partName) ?? new Set()).add(gateName));
      symbols.push(symbol); box.merge(symbol.bounds);
    }
    const graphics: SchGraphic[] = [], plain = obj(sheet.plain);
    if (plain) for (const g of placePrims(readPrims(plain, `sheet ${index + 1} plain`), IDENTITY, plainLabel, diag, budget, id)) { graphics.push(g); graphicPoints(g).forEach(p => box.add(p)); }

    const wires: SchWire[] = [], buses: SchBus[] = [], junctions: SchJunction[] = [], labels: SchLabel[] = [];
    const lineWires = (segment: Xml, context: string, emit: (a: SchPoint, b: SchPoint) => void) => {
      for (const wire of list(segment.wire)) {
        const a = { x: coord(wire, 'x1', context), y: coord(wire, 'y1', context) }, b = { x: coord(wire, 'x2', context), y: coord(wire, 'y2', context) }, curve = numOr(wire, 'curve', context, 0);
        let path = curve ? arcPoints(a, b, curve) : [a, b];
        if (!path) { diag.add('warning', 'ARC_DEGENERATE', `A curved EAGLE ${context} (curve ${curve}) has no valid arc geometry; it is drawn straight.`, id); path = [a, b]; }
        const flipped = path.map(p => place(IDENTITY, p.x, p.y));
        for (let i = 1; i < flipped.length; i++) {
          if (wires.length + buses.length >= limits.maxWiresPerDef) throw fail(`EAGLE sheet ${index + 1} exceeds the ${limits.maxWiresPerDef} wire import limit.`, 'LIMIT_EXCEEDED');
          emit(flipped[i - 1], flipped[i]); box.add(flipped[i - 1]); box.add(flipped[i]);
        }
      }
    };
    // EAGLE labels carry no text of their own: they show the name of the net (or bus) they belong to.
    const label = (node: Xml, text: string, context: string) => {
      const turn = rotation(attr(node, 'rot'), context), at = place(IDENTITY, coord(node, 'x', context), coord(node, 'y', context));
      labels.push({ id: `l${labels.length + 1}`, kind: 'local', text, at, angle: snap(turn.mirror ? norm(180 - turn.degrees) : turn.degrees) });
      box.add(at);
    };
    for (const bus of list(obj(sheet.busses)?.bus)) {
      const busName = required(bus, 'name', 'bus');
      for (const segment of list(bus.segment)) {
        lineWires(segment, `bus ${busName} wire`, (a, b) => buses.push({ id: `b${buses.length + 1}`, a, b }));
        for (const l of list(segment.label)) label(l, busName, `bus ${busName} label`);
      }
    }
    for (const net of list(obj(sheet.nets)?.net)) {
      const netName = required(net, 'name', 'net'), segments = list(net.segment);
      if (!segments.length) continue; // a net element without segments declares nothing
      const declared = declare(netName);
      for (const segment of list(net.segment)) {
        lineWires(segment, `net ${netName} wire`, (a, b) => { const wireId = `w${wires.length + 1}`; wires.push({ id: wireId, a, b }); declared.wires.push({ instancePath: id, defId: id, wireId }); });
        for (const j of list(segment.junction)) { const at = place(IDENTITY, coord(j, 'x', `net ${netName} junction`), coord(j, 'y', `net ${netName} junction`)); junctions.push({ id: `j${junctions.length + 1}`, at }); box.add(at); }
        for (const l of list(segment.label)) label(l, netName, `net ${netName} label`);
        for (const ref of list(segment.pinref)) refs.push({ net: netName, node: ref, defId: id });
      }
    }
    defs.push({ id, name, file: fileName, title, titleBlock: {}, symbols, wires, buses, busEntries: [], junctions, noConnects: [], labels, sheetRefs: [], graphics, bounds: box.bounds() });
    instances.push({ path: id, defId: id, name, page: String(index + 1), parentPath: null, sheetRefId: null, childPaths: [], depth: 0 });
  });

  // Pins come only from resolved pinrefs; unknown references are reported, never guessed. Nets without any resolved pin stay (name + wires).
  const pinNet = new Map<string, string>();
  for (const ref of refs) {
    const partName = required(ref.node, 'part', `net ${ref.net} pinref`), gateName = required(ref.node, 'gate', `net ${ref.net} pinref`), pinName = required(ref.node, 'pin', `net ${ref.net} pinref`);
    const target = placed.get(`${partName}\u0000${gateName}`), pins = target?.byPin.get(pinName);
    if (!target || !pins?.length) {
      diag.add('warning', 'PINREF_UNRESOLVED', `Net "${ref.net}" references ${partName}.${gateName}.${pinName}, which is not a placed pin (unknown instance or pin, or the pin has no pad); it is skipped.`, ref.defId);
      continue;
    }
    const net = declare(ref.net), seen = members.get(ref.net) as Set<string>;
    for (const pin of pins) {
      const key = `${target.defId}\u0000${target.symbolId}\u0000${pin.id}`, other = pinNet.get(key);
      if (other !== undefined && other !== ref.net) diag.add('warning', 'PIN_MULTI_NET', `Pin ${partName}.${gateName}.${pinName} is declared in nets "${other}" and "${ref.net}".`, ref.defId);
      pinNet.set(key, other ?? ref.net);
      if (seen.has(key)) continue;
      seen.add(key);
      net.pins.push({ instancePath: target.defId, defId: target.defId, symbolId: target.symbolId, pinId: pin.id });
    }
  }

  // Parts without a placed gate, and gates whose invisible power pins EAGLE would tie by name: neither is in the declared nets.
  const implicit = new Map<string, number>();
  for (const part of parts.values()) {
    const done = placedGates.get(part.name);
    if (!done) { diag.add('info', 'PART_NOT_PLACED', `Part ${part.name} has no placed gate in the schematic.`); continue; }
    for (const gate of planFor(part).gates.values()) {
      if (done.has(gate.name) || !gate.symbol?.pins.some(pin => pin.direction === 'pwr')) continue;
      const key = `${part.library}:${part.deviceset}:${part.device}\u0000${gate.name}`;
      implicit.set(key, (implicit.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of implicit) {
    const [device, gate] = key.split('\u0000');
    diag.add('info', 'GATE_NOT_PLACED', `${count} part(s) of ${device} do not place gate ${gate}, which has power pins; EAGLE ties such pins by name, which is not part of the declared nets.`);
  }

  return {
    format: FORMAT, formatLabel: version ? `EAGLE schematic (version ${version})` : 'EAGLE schematic', sourceUnit: 'mm', name: stem, defs, rootDefId: defs[0].id, instances,
    declaredNets: [...nets.values()], diagnostics: diag.finish(),
  };
}
