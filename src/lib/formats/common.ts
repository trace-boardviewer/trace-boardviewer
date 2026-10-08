import { boundText } from '../bounded-text';
import type { Board, BoardComponent, BoardPin, BoardSide, Bounds, Point, ParseIssue } from '../types';
import { markBuildStage } from './stage';

export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
/** Canonical-mm magnitude cap shared with GenCAD (parse.error.coordinateRangeMm); larger values break the renderer grid. */
export const MAX_MM = 1e9;
export type FormatErrorCode = 'INVALID_FORMAT' | 'UNRECOGNIZED' | 'LIMIT_EXCEEDED' | 'KEY_REQUIRED' | 'INVALID_KEY' | 'COMPANIONS_REQUIRED' | 'UNSUPPORTED_VARIANT' | 'WRONG_KIND' | 'AMBIGUOUS_FORMAT';
export interface ParseOptions { fzKey?: number[]; xzzKey?: string; ipc356?: import('./ipc356').Ipc356Options; pinList?: import('./pinlist-csv').PinListOptions; /** ODB++: the step to read when the product model has several (default: the board step, see odbpp.ts). */ odbpp?: { step?: string } }
export interface ParseInput {
  name: string;
  data: Uint8Array;
  companions?: Record<string, Uint8Array>;
  options?: ParseOptions;
}
/** null means "not this format"; a recognized but malformed file throws BoardFormatError. */
export type BoardParser = (input: ParseInput) => Board | null;
export class BoardFormatError extends Error {
  /** Set by the dispatcher and the archive reader: the same failure as a catalog message, shown in the active language instead of `message`. */
  issue?: ParseIssue;
  constructor(message: string, readonly code: FormatErrorCode = 'INVALID_FORMAT', readonly format?: string, readonly keyKind?: 'fz' | 'xzz') {
    super(boundText(message)); this.name = 'BoardFormatError';
  }
}
/** A BoardFormatError whose text is also a catalog message (`issue`); `message` stays the English developer text. */
export function localizedFormatError(message: string, code: FormatErrorCode, issue: ParseIssue, format?: string): BoardFormatError {
  const error = new BoardFormatError(message, code, format);
  error.issue = issue;
  return error;
}
export interface RawPart {
  key: string;
  ref?: string;
  /** The adapter made `ref` up because the file names this component by nothing usable: it is shown, but never an identity (notes do not key on it). */
  refGenerated?: boolean;
  value?: string;
  package?: string;
  side: BoardSide;
  position?: Point;
  rotation?: number;
  bounds?: Bounds;
  outline?: Point[];
}
export interface RawPin extends Point {
  part: string;
  number: string;
  /** The adapter made `number` up (an empty or missing number in the file): shown, never an identity. A number a format defines by position (BRD, CST) is not generated. */
  numberGenerated?: boolean;
  name?: string;
  net?: string;
  side?: BoardSide;
  radius?: number;
  width?: number;
  height?: number;
  shape?: BoardPin['shape'];
  rotation?: number;
}
export interface RawBoard {
  format: string;
  parts: RawPart[];
  pins: RawPin[];
  /** Multiplication factor for ALL source coordinates and dimensions. */
  unitsToMm: number;
  outline?: Point[];
  /** Every closed loop found; the largest becomes the outline and the rest are disclosed as cutouts. */
  outlines?: Point[][];
  warnings?: ParseIssue[];
}
/** English diagnostic passed through the catalogs verbatim (parse.warning.formatNote = "{message}"). */
export const note = (message: string): ParseIssue => ({ key: 'parse.warning.formatNote', params: { message: boundText(message) } });
/** Vendor boardview placeholders (UNCONNECTED, UNCONNECTED12, UNCONNECTED<123>, UNCONNECTED-5, UNCONNECTED_7), per OpenBoardView BRDBoard.cpp.
 *  For BRD/BRD2/BDV/BVR/ASC/FZ adapters only: ECAD user nets such as KiCad "unconnected-(R1-Pad2)" are real names. */
export const vendorDisconnected = (net: string): boolean => /^UNCONNECTED(?:$|\d|[<(_\-])/i.test(net);
/** Latin-1 view of the first bytes for signature sniffing (TextDecoder's "latin1" is windows-1252, so decode by hand). */
export function asciiPrefix(data: Uint8Array, length: number): string {
  const end = Math.min(data.length, Math.max(0, Math.floor(length) || 0));
  let result = '';
  for (let index = 0; index < end; index++) result += String.fromCharCode(data[index]);
  return result;
}
export const startsWithBytes = (data: Uint8Array, bytes: ArrayLike<number>): boolean =>
  data.length >= bytes.length && Array.prototype.every.call(bytes, (byte: number, index: number) => data[index] === byte);
/**
 * Undecodable text behind a UTF-16 byte-order mark. Deliberately not a BoardFormatError: sniffing adapters (BRD) treat
 * it as "not my format" while keyed adapters (FZ) turn it into a wrong-key diagnosis, and both keep their own catch
 * blocks, which rethrow every BoardFormatError. Callers that do not catch it get the dispatcher's INVALID_FORMAT wrapper.
 */
export class TextDecodeError extends Error {
  constructor(message: string) { super(message); this.name = 'TextDecodeError'; }
}
const decoded = new WeakMap<Uint8Array, string>();
/** UTF-8 (fatal) or BOM-marked UTF-16, otherwise windows-1252. Inputs are immutable: the dispatcher runs several text adapters over one buffer, so large decodes are memoized per array. */
export function decodeText(data: Uint8Array): string {
  if (data.length > MAX_IMPORT_BYTES) throw new BoardFormatError('Board data exceeds the 64 MiB import limit.', 'LIMIT_EXCEEDED');
  const cached = data.length >= 1024 ? decoded.get(data) : undefined;
  if (cached !== undefined) return cached;
  let text: string;
  const utf16 = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : undefined;
  if (utf16) {
    // A UTF-16 BOM promises UTF-16: an odd length or a lone surrogate is malformed input, not another encoding.
    try { text = new TextDecoder(utf16, { fatal: true }).decode(data); }
    catch { throw new TextDecodeError('Board text has a UTF-16 byte-order mark but is not valid UTF-16.'); }
  } else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, ''); }
    catch { text = new TextDecoder('windows-1252').decode(data); }
  }
  if (data.length >= 1024) decoded.set(data, text);
  return text;
}
export function textInput(text: string, name = 'board'): ParseInput { return { name, data: new TextEncoder().encode(text) }; }
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
export function number(value: string | number | undefined, context = 'coordinate'): number {
  if (value === undefined || typeof value === 'string' && !value.trim()) throw new BoardFormatError(`Missing ${context}.`);
  // Text must be a plain decimal (optionally with an exponent): Number() would also accept 0x10, 0b1, 0o7 and Infinity.
  const result = typeof value === 'number' ? value : DECIMAL.test(value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isFinite(result)) throw new BoardFormatError(`Invalid ${context}: ${String(value).slice(0, 80)}.`);
  return result;
}
export function tokens(line: string): string[] {
  const result: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of line.matchAll(pattern)) result.push(match[1]?.replace(/\\(["\\])/g, '$1') ?? match[2] ?? match[3]);
  return result;
}
function boundsOf(points: Point[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
}
const expand = (b: Bounds, amount: number): Bounds => ({ minX: b.minX - amount, minY: b.minY - amount, maxX: b.maxX + amount, maxY: b.maxY + amount });
export function corners(bounds: Bounds): Point[] {
  return [{ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY }];
}
function signedArea(points: Point[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index++) { const a = points[index], b = points[(index + 1) % points.length]; sum += a.x * b.y - b.x * a.y; }
  return sum / 2;
}
const polygonArea = (points: Point[]): number => Math.abs(signedArea(points));
/** Cosine/sine of a pad angle in degrees, exact at multiples of 90 so axis-aligned pads keep exact extents. */
function quadrant(degrees: number): [number, number] {
  const turns = degrees / 90;
  if (Number.isInteger(turns)) { const q = ((turns % 4) + 4) % 4; return [[1, 0, -1, 0][q], [0, 1, 0, -1][q]]; }
  const angle = degrees * Math.PI / 180;
  return [Math.cos(angle), Math.sin(angle)];
}
/**
 * Axis-aligned extent of a pad's known physical size; the bare centre when the size is unknown. A round pad is a
 * circle of its radius whatever its rotation; rotated half extents apply to rectangles, squares and to round pads
 * that only carry a non-square size (their true outline is unknown, so the enclosing rotated rectangle is used).
 */
export function padExtent(pin: BoardPin): Point[] {
  if (pin.shape === 'round' && pin.radius > 0) return corners({ minX: pin.x - pin.radius, minY: pin.y - pin.radius, maxX: pin.x + pin.radius, maxY: pin.y + pin.radius });
  const width = pin.width ?? pin.radius * 2, height = pin.height ?? pin.radius * 2;
  if (!(width > 0) && !(height > 0)) return [{ x: pin.x, y: pin.y }];
  if (pin.shape === 'round' && width === height) return corners({ minX: pin.x - width / 2, minY: pin.y - width / 2, maxX: pin.x + width / 2, maxY: pin.y + width / 2 });
  const [cosine, sine] = quadrant(pin.rotation ?? 0), cos = Math.abs(cosine), sin = Math.abs(sine);
  const halfW = width / 2 * cos + height / 2 * sin, halfH = width / 2 * sin + height / 2 * cos;
  return corners({ minX: pin.x - halfW, minY: pin.y - halfH, maxX: pin.x + halfW, maxY: pin.y + halfH });
}
export interface StitchedOutlines { loops: Point[][]; openChains: number }
/** Counter-clockwise, starting at the lowest-left vertex: the result does not depend on the order or direction of the input edges. */
function canonicalLoop(points: Point[]): Point[] {
  const ring = signedArea(points) < 0 ? [...points].reverse() : points;
  let first = 0;
  for (let index = 1; index < ring.length; index++) if (ring[index].x < ring[first].x || ring[index].x === ring[first].x && ring[index].y < ring[first].y) first = index;
  return [...ring.slice(first), ...ring.slice(0, first)];
}
/**
 * Joins outline edges into closed loops, largest area first, independent of edge order and direction.
 * Degree-1 vertices are pruned iteratively, then the outer face of the lowest-left remaining component is walked
 * (planar half-edge traversal) and split into simple cycles; its edges are removed and the process repeats, so a
 * rectangle with a diagonal chord yields the rectangle (never half of it), cutouts and nested loops are found in later
 * rounds, and a figure eight or a loop pair joined by a bridge yields both loops. Edges that end up in no loop
 * (spurs, chords, bridges, open polylines) are never closed; `openChains` counts their connected groups. Duplicate and
 * zero-length edges are ignored. Segments that cross without a shared vertex are not split. Collinear vertices are kept.
 */
export function stitchOutlines(segments: ReadonlyArray<readonly [Point, Point]>, tolerance = 1e-6): StitchedOutlines {
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) throw new BoardFormatError('Invalid outline tolerance.');
  const vertices: Point[] = [], cells = new Map<string, number[]>();
  const vertex = (p: Point) => {
    number(p.x); number(p.y);
    const x = Math.floor(p.x / tolerance), y = Math.floor(p.y / tolerance);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const index of cells.get(`${x + dx},${y + dy}`) ?? []) {
        const prior = vertices[index];
        if (Math.hypot(prior.x - p.x, prior.y - p.y) <= tolerance) return index;
      }
    }
    const index = vertices.length, key = `${x},${y}`;
    vertices.push({ x: p.x, y: p.y });
    const bucket = cells.get(key); if (bucket) bucket.push(index); else cells.set(key, [index]);
    return index;
  };
  const edges: Array<readonly [number, number]> = [], adjacency: number[][] = [], unique = new Set<string>();
  for (const [a, b] of segments) {
    const from = vertex(a), to = vertex(b);
    if (from === to) continue;
    const key = from < to ? `${from}:${to}` : `${to}:${from}`;
    if (unique.has(key)) continue;
    unique.add(key); const index = edges.length; edges.push([from, to]);
    (adjacency[from] ??= []).push(index); (adjacency[to] ??= []).push(index);
  }
  // Half-edge 2e leaves edges[e][0] and 2e+1 leaves edges[e][1]; `^ 1` is the twin. Each vertex keeps its outgoing
  // half-edges in a circular list ordered counter-clockwise, so deleting an edge is O(1) and a face walk is a permutation.
  const origin = (h: number) => edges[h >> 1][h & 1], target = (h: number) => edges[h >> 1][(h & 1) ^ 1];
  const angle = new Float64Array(edges.length * 2), length = new Float64Array(edges.length * 2);
  for (let h = 0; h < angle.length; h++) {
    const a = vertices[origin(h)], b = vertices[target(h)];
    angle[h] = Math.atan2(b.y - a.y + 0, b.x - a.x); length[h] = Math.hypot(b.x - a.x, b.y - a.y);
  }
  const ringNext = new Int32Array(angle.length), ringPrev = new Int32Array(angle.length), anyOut = new Int32Array(vertices.length).fill(-1);
  const order: number[][] = vertices.map((_, v) => (adjacency[v] ?? []).map(e => edges[e][0] === v ? 2 * e : 2 * e + 1).sort((a, b) => {
    const pa = vertices[target(a)], pb = vertices[target(b)];
    return angle[a] - angle[b] || length[a] - length[b] || pa.x - pb.x || pa.y - pb.y;
  }));
  order.forEach((ring, v) => {
    ring.forEach((h, i) => { ringNext[h] = ring[(i + 1) % ring.length]; ringPrev[h] = ring[(i + ring.length - 1) % ring.length]; });
    if (ring.length) anyOut[v] = ring[0];
  });
  const alive = new Uint8Array(edges.length).fill(1), inLoop = new Uint8Array(edges.length);
  const degree = Int32Array.from(vertices, (_, index) => adjacency[index]?.length ?? 0);
  const unlink = (h: number) => {
    const v = origin(h), next = ringNext[h], prev = ringPrev[h];
    if (next === h) { anyOut[v] = -1; return; }
    ringNext[prev] = next; ringPrev[next] = prev;
    if (anyOut[v] === h) anyOut[v] = next;
  };
  const kill = (edge: number) => { alive[edge] = 0; unlink(2 * edge); unlink(2 * edge + 1); degree[edges[edge][0]]--; degree[edges[edge][1]]--; };
  const prune = (queue: number[]) => {
    while (queue.length) {
      const at = queue.pop()!;
      if (degree[at] !== 1) continue;
      const h = anyOut[at], next = target(h);
      kill(h >> 1);
      if (degree[next] === 1) queue.push(next);
    }
  };
  prune(vertices.map((_, index) => index).filter(index => degree[index] === 1));
  const found: Array<{ points: Point[]; area: number }> = [], position = new Int32Array(vertices.length).fill(-1);
  const sweep = vertices.map((_, index) => index).sort((a, b) => vertices[a].x - vertices[b].x || vertices[a].y - vertices[b].y);
  const top = Int32Array.from(order, ring => ring.length);
  let cursor = 0;
  for (;;) {
    while (cursor < sweep.length && degree[sweep[cursor]] === 0) cursor++;
    if (cursor === sweep.length) break;
    // The lowest-left vertex is on the outer face of its component; its counter-clockwise-most edge has that face on its left.
    const v0 = sweep[cursor], ring = order[v0];
    while (top[v0] > 0 && !alive[ring[top[v0] - 1] >> 1]) top[v0]--;
    const start = ring[top[v0] - 1], walk: number[] = [];
    let h = start;
    do { walk.push(h); h = ringPrev[h ^ 1]; } while (h !== start && walk.length <= 2 * edges.length);
    // A closed walk revisits cut vertices; every revisit closes a simple cycle. A two-vertex cycle is a bridge walked both ways.
    const stackVertices: number[] = [], stackEdges: number[] = [];
    const close = (from: number) => {
      const cycleEdges = stackEdges.splice(from), cycleVertices = stackVertices.splice(from);
      for (const v of cycleVertices) position[v] = -1;
      if (cycleVertices.length < 3) return;
      const points = cycleVertices.map(v => vertices[v]), area = polygonArea(points);
      if (!(area > 0)) return;
      for (const h2 of cycleEdges) inLoop[h2 >> 1] = 1;
      found.push({ points: canonicalLoop(points), area });
    };
    for (const step of walk) {
      const v = origin(step);
      if (position[v] >= 0) close(position[v]);
      position[v] = stackVertices.length; stackVertices.push(v); stackEdges.push(step);
    }
    close(0);
    const touched: number[] = [];
    for (const step of walk) if (alive[step >> 1]) { touched.push(origin(step), target(step)); kill(step >> 1); }
    prune(touched);
  }
  const parent = Int32Array.from(vertices, (_, index) => index);
  const root = (at: number): number => { while (parent[at] !== at) at = parent[at] = parent[parent[at]]; return at; };
  for (let index = 0; index < edges.length; index++) if (!inLoop[index]) parent[root(edges[index][0])] = root(edges[index][1]);
  const chains = new Set<number>();
  for (let index = 0; index < edges.length; index++) if (!inLoop[index]) chains.add(root(edges[index][0]));
  found.sort((a, b) => b.area - a.area || a.points[0].x - b.points[0].x || a.points[0].y - b.points[0].y);
  return { loops: found.map(loop => loop.points), openChains: chains.size };
}
/** The largest closed loop; open chains are never silently closed. */
export function stitchOutline(segments: ReadonlyArray<readonly [Point, Point]>, tolerance = 1e-6): Point[] {
  return stitchOutlines(segments, tolerance).loops[0] ?? [];
}
/** Normalizes adapters to the renderer's canonical mm / Y-up / top-bottom model. Every BoardFormatError it throws carries `raw.format`. */
export function buildBoard(input: ParseInput, raw: RawBoard): Board {
  markBuildStage(); // the diagnostic report's 'build' stage (formats/stage.ts)
  try { return assemble(input, raw); }
  catch (error) {
    if (!(error instanceof BoardFormatError) || error.format) throw error;
    const tagged = new BoardFormatError(error.message, error.code, raw.format, error.keyKind);
    tagged.cause = error; throw tagged;
  }
}
function assemble(input: ParseInput, raw: RawBoard): Board {
  const scale = number(raw.unitsToMm, 'unit conversion');
  if (scale <= 0) throw new BoardFormatError('Invalid board units.');
  if (!raw.parts.length) throw new BoardFormatError(`${raw.format}: no components were found.`);
  if (raw.parts.length > 250_000 || raw.pins.length > 1_000_000) throw new BoardFormatError('Board record count exceeds the import limit.', 'LIMIT_EXCEEDED');
  const scaled = (value: number, label = 'coordinate') => {
    const result = number(number(value, label) * scale, label);
    if (Math.abs(result) > MAX_MM) throw new BoardFormatError(`${raw.format}: ${label} ${result} mm exceeds the supported range of ±${MAX_MM} mm.`);
    return result;
  };
  const point = (p: Point): Point => ({ x: scaled(p.x), y: scaled(p.y) });
  const validSide = (side: BoardSide) => {
    if (side !== 'top' && side !== 'bottom' && side !== 'both') throw new BoardFormatError(`Invalid board side: ${side}.`);
    return side;
  };
  const rawParts = new Map<string, { raw: RawPart; id: string; pins: BoardPin[] }>();
  raw.parts.forEach((part, index) => {
    if (!part.key || rawParts.has(part.key)) throw new BoardFormatError(`${raw.format}: duplicate or empty component identity.`);
    rawParts.set(part.key, { raw: part, id: `part:${index}`, pins: [] });
  });
  let fallbackPads = 0, fallbackComponents = 0;
  const pins: BoardPin[] = raw.pins.map((pin, index) => {
    const parent = rawParts.get(pin.part);
    if (!parent) throw new BoardFormatError(`${raw.format}: pin references a missing component (${pin.part}).`);
    const position = point(pin);
    const realRadius = pin.radius === undefined ? 0 : scaled(pin.radius, 'pad radius');
    if (realRadius < 0) throw new BoardFormatError('Negative pad radius.');
    if (!realRadius && pin.width === undefined && pin.height === undefined) fallbackPads++;
    // Only an empty string means "no net". Vendor sentinels (UNCONNECTED<n>) are normalized by their adapters via
    // vendorDisconnected(); an ECAD file that declares a net literally named UNCONNECTED keeps it.
    // Ids and the fallback number are positional: they are handles of this session, never identities (note-keys.ts keys on reference and pin number).
    const result: BoardPin = {
      id: `pin:${index}`, componentId: parent.id, number: String(pin.number || index + 1), ...(pin.numberGenerated || !pin.number ? { numberGenerated: true as const } : {}),
      name: pin.name ?? String(pin.number || index + 1),
      net: pin.net ?? '', side: validSide(pin.side ?? parent.raw.side), ...position,
      radius: realRadius, shape: pin.shape ?? 'round',
      ...(pin.width === undefined ? {} : { width: scaled(pin.width, 'pad width') }),
      ...(pin.height === undefined ? {} : { height: scaled(pin.height, 'pad height') }),
      ...(pin.rotation === undefined ? {} : { rotation: number(pin.rotation, 'pad rotation') }),
    };
    if ((result.width ?? 0) < 0 || (result.height ?? 0) < 0) throw new BoardFormatError('Negative pad dimensions.');
    parent.pins.push(result); return result;
  });
  // Known physical pad extents; a size-less pin only contributes its centre plus a 0.3 mm marker margin.
  const pinExtents = (partPins: BoardPin[]): Point[] => partPins.flatMap(pin => {
    const extent = padExtent(pin);
    return extent.length === 1 ? corners(expand(boundsOf(extent), 0.3)) : extent;
  });
  const components: BoardComponent[] = [...rawParts.values()].map(({ raw: part, id, pins: partPins }) => {
    let outline = part.outline?.map(point) ?? [];
    let bounds: Bounds;
    if (outline.length >= 3) bounds = boundsOf(outline);
    else if (part.bounds) {
      const lo = point({ x: part.bounds.minX, y: part.bounds.minY }), hi = point({ x: part.bounds.maxX, y: part.bounds.maxY });
      bounds = { minX: Math.min(lo.x, hi.x), minY: Math.min(lo.y, hi.y), maxX: Math.max(lo.x, hi.x), maxY: Math.max(lo.y, hi.y) };
    } else {
      fallbackComponents++;
      const points = partPins.length ? pinExtents(partPins) : part.position ? corners(expand(boundsOf([point(part.position)]), 0.3)) : [];
      if (!points.length) throw new BoardFormatError(`${raw.format}: component ${part.ref ?? part.key} has no position or pins.`);
      bounds = boundsOf(points);
    }
    if (outline.length < 3) outline = corners(bounds);
    const position = part.position ? point(part.position) : { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    return { id, ref: part.ref ?? part.key, ...(part.refGenerated || part.ref === undefined ? { refGenerated: true as const } : {}),
      value: part.value ?? '', package: part.package ?? '', side: validSide(part.side),
      position, rotation: number(part.rotation ?? 0, 'component rotation'), bounds, outline, pinIds: partPins.map(pin => pin.id) };
  });
  const netMap = new Map<string, string[]>();
  for (const pin of pins) {
    if (!pin.net) continue;
    const members = netMap.get(pin.net);
    if (members) members.push(pin.id); else netMap.set(pin.net, [pin.id]);
  }
  const warnings = [...raw.warnings ?? []];
  if (fallbackPads) warnings.push({ key: 'parse.warning.fallbackPads', params: { count: fallbackPads } });
  if (fallbackComponents) warnings.push({ key: 'parse.warning.fallbackComponents', params: { count: fallbackComponents } });
  if (!netMap.size) warnings.push({ key: 'parse.warning.noNets' });
  let loops = (raw.outlines ?? []).filter(loop => loop.length >= 3);
  if (!loops.length && raw.outline && raw.outline.length >= 3) loops = [raw.outline];
  let outline: Point[] = [];
  if (loops.length) {
    // Every loop is range-checked, not only the one kept: cutouts are disclosed, but unvalidated geometry never passes through.
    const checked = loops.map(loop => loop.map(point));
    outline = checked.reduce((best, loop) => polygonArea(loop) > polygonArea(best) ? loop : best);
    if (loops.length > 1 && !warnings.some(warning => warning.key === 'parse.warning.boardCutouts')) warnings.push({ key: 'parse.warning.boardCutouts' });
  }
  if (outline.length < 3) {
    warnings.push({ key: 'parse.warning.missingBoardOutline' });
    outline = corners(boundsOf([...components.flatMap(component => corners(component.bounds)), ...pins.flatMap(padExtent)]));
  }
  const bounds = boundsOf(outline);
  if (!Object.values(bounds).every(Number.isFinite)) throw new BoardFormatError('Invalid board bounds.');
  const name = input.name.split(/[\\/]/).pop()?.replace(/\.[^.]*$/, '') ?? input.name;
  return { name, format: raw.format, units: 'mm', components, pins, nets: [...netMap].map(([net, pinIds], index) => ({ id: `net:${index}`, name: net, pinIds })), outline, bounds, warnings };
}
