/*
 * Original TRACE adapter, MIT. Format reference: KiCad's official S-expression
 * PCB specification, https://dev-docs.kicad.org/en/file-formats/sexpr-pcb/ , and the
 * common definitions, https://dev-docs.kicad.org/en/file-formats/sexpr-intro/ .
 * No KiCad/GPL implementation code is included.
 */
import type { Board, BoardSide, ParseIssue, Point } from '../types';
import { BoardFormatError, MAX_MM, buildBoard, decodeText, note, number, stitchOutlines, type ParseInput, type RawBoard, type RawPart, type RawPin } from './common';

type Expr = string | Expr[];
type Node = Expr[];
/** Source values beyond this (mm) are not board geometry; they would also overflow the renderer grid (B16). */
const MAX_SOURCE_MM = MAX_MM;
/** A three-point arc whose circle is wider than this is numerically a straight line: its centre cannot be computed without noise. */
const MAX_ARC_RADIUS_MM = 1e6;
const BEZIER_STEPS = 32;
const children = (node: Node, key: string): Node[] => node.filter((item): item is Node => Array.isArray(item) && item[0] === key);
const child = (node: Node, key: string): Node | undefined => children(node, key)[0];
const atom = (node: Node | undefined, index = 1, fallback = ''): string => typeof node?.[index] === 'string' ? node[index] as string : fallback;
const angle = (value: number) => ((value % 360) + 360) % 360;
function bounded(value: string | undefined, label: string): number {
  const result = number(value, label);
  if (Math.abs(result) > MAX_SOURCE_MM) throw new BoardFormatError(`KiCad ${label} ${value} exceeds the ${MAX_SOURCE_MM} mm limit.`);
  return result;
}

/**
 * Expressions one KEPT top-level element (a footprint, a net, an Edge.Cuts graphic) may hold. The file as a whole is not
 * bounded by expression count: tracks, vias, zones and text are only checked for syntax and never built, and each footprint is
 * reduced to compact data the moment it is complete, so memory follows the largest single element, not the file (a real 28 MB
 * board holds 3.6 million expressions, 3.0 million of them in footprint graphics). The 64 MiB file cap still bounds the work.
 */
const MAX_ELEMENT_EXPRESSIONS = 2_000_000;
const MAX_NESTING = 128;
/** Top-level elements the adapter reads; every other one (segment, via, zone, gr_text, setup, ...) is validated but never built. */
const KEPT_TOP = new Set(['footprint', 'module', 'net', 'gr_line', 'gr_rect', 'gr_poly', 'gr_arc', 'gr_circle', 'gr_curve']);
const nestingError = () => new BoardFormatError('KiCad nesting exceeds the import limit.', 'LIMIT_EXCEEDED');
const malformedError = () => new BoardFormatError('Malformed KiCad PCB document.');
/** Same set as the regular expression \s, without allocating a one-character string per input character. */
const isSpace = (code: number): boolean => code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(String.fromCharCode(code)));
const isDelimiter = (code: number): boolean => code === 40 || code === 41 || code === 59 || isSpace(code);

/** Reads the quoted string that opens at text[at]; `next` is the index after the closing quote. */
function readString(text: string, at: number): { value: string; next: number } {
  let i = at + 1, value = '';
  while (i < text.length) {
    const next = text[i++];
    if (next === '"') return { value, next: i };
    if (next === '\\') {
      if (i === text.length) throw new BoardFormatError('KiCad has an incomplete string escape.');
      const escaped = text[i++]; value += escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped;
    } else value += next;
  }
  throw new BoardFormatError('KiCad has an unterminated quoted string.');
}
/** Index after the closing quote of the string that opens at text[at], validating it without building the value. */
function skipString(text: string, at: number): number {
  let i = at + 1;
  while (i < text.length) {
    const next = text.charCodeAt(i++);
    if (next === 34) return i;
    if (next === 92) {
      if (i === text.length) throw new BoardFormatError('KiCad has an incomplete string escape.');
      i++;
    }
  }
  throw new BoardFormatError('KiCad has an unterminated quoted string.');
}
/** Index after the list that opens at text[start], with the same tokenization, nesting bound and string checks as a built list. */
function skipList(text: string, start: number, outerDepth: number): number {
  let depth = 0, i = start;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 40) { if (outerDepth + depth >= MAX_NESTING) throw nestingError(); depth++; i++; }
    else if (c === 41) { i++; if (--depth === 0) return i; }
    else if (c === 34) i = skipString(text, i);
    else if (c === 59) { while (i < text.length && text.charCodeAt(i) !== 10) i++; }
    else if (isSpace(c)) i++;
    else { i++; while (i < text.length && !isDelimiter(text.charCodeAt(i))) i++; } // an atom: a quote inside it does not end it
  }
  throw malformedError();
}
/** The head symbol of the list that opens at text[open], or undefined when it does not start with a plain symbol. */
function headOf(text: string, open: number): string | undefined {
  let i = open + 1;
  while (i < text.length && isSpace(text.charCodeAt(i))) i++;
  if (i >= text.length) return undefined;
  const c = text.charCodeAt(i);
  if (c === 40 || c === 41 || c === 34 || c === 59) return undefined;
  const start = i;
  while (i < text.length && !isDelimiter(text.charCodeAt(i))) i++;
  return text.slice(start, i);
}

/**
 * Walks the single (kicad_pcb ...) list and hands every kept top-level element to `onElement` as soon as it is complete,
 * in document order, without retaining it. Syntax (parentheses, strings, escapes, nesting) of the WHOLE document is
 * still validated; everything that is skipped is skipped with the same tokenization.
 */
function scanPcb(text: string, onElement: (element: Node) => void): void {
  const stack: Node[] = [];
  let rootSeen = false, rootHead: Expr | undefined, count = 0;
  const append = (value: Expr) => {
    if (stack.length === 0) throw malformedError(); // anything outside the one root list
    if (stack.length === 1) { rootHead ??= value; return; } // atoms of the root list itself are not needed
    if (++count > MAX_ELEMENT_EXPRESSIONS) throw new BoardFormatError('KiCad expression count exceeds the import limit.', 'LIMIT_EXCEEDED');
    stack[stack.length - 1].push(value);
  };
  const n = text.length;
  for (let i = 0; i < n;) {
    const c = text.charCodeAt(i);
    if (isSpace(c)) { i++; continue; }
    if (c === 59) { while (i < n && text.charCodeAt(i) !== 10) i++; continue; }
    if (c === 40) {
      if (stack.length === 0) {
        if (rootSeen) throw malformedError();
        rootSeen = true; stack.push([]); i++; continue;
      }
      if (stack.length === 1) {
        const head = headOf(text, i);
        if (head !== undefined && !KEPT_TOP.has(head)) { i = skipList(text, i, stack.length); continue; }
        count = 1; // the element itself
      }
      if (stack.length >= MAX_NESTING) throw nestingError();
      const node: Node = [];
      if (stack.length > 1) append(node);
      stack.push(node); i++; continue;
    }
    if (c === 41) {
      const closed = stack.pop();
      if (!closed) throw new BoardFormatError('KiCad has an unmatched closing parenthesis.');
      if (stack.length === 1) onElement(closed); // a top-level element is complete
      i++; continue;
    }
    if (c === 34) { const { value, next } = readString(text, i); append(value); i = next; continue; }
    const start = i++;
    while (i < n && !isDelimiter(text.charCodeAt(i))) i++;
    append(text.slice(start, i));
  }
  if (stack.length || !rootSeen || rootHead !== 'kicad_pcb') throw malformedError();
}

function xy(node: Node | undefined): Point {
  return { x: bounded(atom(node), 'X coordinate'), y: bounded(atom(node, 2), 'Y coordinate') };
}
function rotateSource(p: Point, position: Point, degrees: number): Point {
  const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  // Source Y points down; positive KiCad angles are counter-clockwise on screen.
  return { x: position.x + p.x * c + p.y * s, y: position.y - p.x * s + p.y * c };
}
const canonical = (p: Point): Point => ({ x: p.x, y: -p.y });
function sampleCircle(center: Point, radius: number, start: number, sweep: number): Point[] {
  const steps = Math.max(2, Math.min(4096, Math.ceil(Math.abs(sweep) / (Math.PI / 32))));
  return Array.from({ length: steps + 1 }, (_, i) => ({ x: center.x + radius * Math.cos(start + sweep * i / steps), y: center.y + radius * Math.sin(start + sweep * i / steps) }));
}
function graphic(node: Node): Point[] {
  const type = String(node[0]).replace(/^(?:gr|fp)_/, '');
  if (type === 'line') return [xy(child(node, 'start')), xy(child(node, 'end'))];
  if (type === 'rect') {
    const a = xy(child(node, 'start')), b = xy(child(node, 'end'));
    return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
  }
  if (type === 'poly') {
    const points = children(child(node, 'pts') ?? [], 'xy').map(xy);
    return points.length ? [...points, points[0]] : [];
  }
  if (type === 'circle') {
    const a = xy(child(node, 'center')), b = xy(child(node, 'end'));
    return sampleCircle(a, Math.hypot(b.x - a.x, b.y - a.y), 0, 2 * Math.PI);
  }
  if (type === 'arc') {
    const start = xy(child(node, 'start')), end = xy(child(node, 'end')), midNode = child(node, 'mid');
    if (!midNode) { // KiCad 4/5: start is the center, end is the first point.
      const sweep = -number(atom(child(node, 'angle')), 'KiCad arc angle') * Math.PI / 180;
      return sampleCircle(start, Math.hypot(end.x - start.x, end.y - start.y), Math.atan2(end.y - start.y, end.x - start.x), sweep);
    }
    const mid = xy(midNode), d = 2 * (start.x * (mid.y - end.y) + mid.x * (end.y - start.y) + end.x * (start.y - mid.y));
    if (Math.abs(d) < 1e-12) return [start, mid, end];
    const aa = start.x ** 2 + start.y ** 2, bb = mid.x ** 2 + mid.y ** 2, cc = end.x ** 2 + end.y ** 2;
    const center = { x: (aa * (mid.y - end.y) + bb * (end.y - start.y) + cc * (start.y - mid.y)) / d, y: (aa * (end.x - mid.x) + bb * (start.x - end.x) + cc * (mid.x - start.x)) / d };
    const radius = Math.hypot(start.x - center.x, start.y - center.y);
    if (!(radius <= MAX_ARC_RADIUS_MM)) return [start, mid, end];
    const from = Math.atan2(start.y - center.y, start.x - center.x), to = Math.atan2(end.y - center.y, end.x - center.x), middle = Math.atan2(mid.y - center.y, mid.x - center.x);
    const positive = (n: number) => (n + 2 * Math.PI) % (2 * Math.PI);
    let sweep = positive(to - from); if (positive(middle - from) > sweep + 1e-8) sweep -= 2 * Math.PI;
    return sampleCircle(center, radius, from, sweep);
  }
  if (type === 'curve') {
    const control = children(child(node, 'pts') ?? [], 'xy').map(xy);
    if (control.length !== 4) throw new BoardFormatError('KiCad Bezier curve needs exactly four control points.');
    const [p0, p1, p2, p3] = control;
    return Array.from({ length: BEZIER_STEPS + 1 }, (_, i) => {
      const t = i / BEZIER_STEPS, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
    });
  }
  return [];
}
/**
 * KiCad 6+ writes one single-pad placeholder net per unconnected pad; user nets named "UNCONNECTED" are real nets. A second pad that carries the same
 * number gets the same name with a "_1", "_2", ... suffix (real board: "unconnected-(D8-Pad5)" and "unconnected-(D8-Pad5)_1"), also a placeholder.
 */
const PLACEHOLDER_NET = /^unconnected-\(.+\)(?:_\d+)?$/;
const MAX_PARTS = 250_000, MAX_PINS = 1_000_000;
/**
 * End points of board-edge graphics that differ by less than this are the same corner. Real boards carry such noise (a 100 x 55 mm
 * board whose left edge ends 0.00002 mm off the next edge's start has no exactly closed contour); 0.01 mm is far below any
 * feature of a printed circuit board, so corners that close within it are one corner. Larger gaps stay open and are disclosed, never closed.
 */
const OUTLINE_CLOSURE_MM = 0.01;

/** One pad as read from its footprint; the net is resolved later, once the whole net table is known. */
interface PadRead { number: string; name: string; at: Point; width: number; height: number; side: BoardSide; shape: string; netNode: Node | undefined; angleText: string }
/**
 * A footprint reduced to what the board needs, so the (very large) footprint expression can be discarded as soon as it is
 * read. A failure while reading is kept in `error` and thrown later, at the position where whole-tree processing used to throw it
 * (after the net table and after the pads that precede the failing one), so error precedence is unchanged.
 */
interface FootprintRead { name: string; ref: string; value: string; side: BoardSide; position: Point; rotation: number; outline?: Point[]; edgeCuts: boolean; pads: PadRead[]; error?: unknown }

function readFootprint(footprint: Node): FootprintRead {
  const read: FootprintRead = { name: atom(footprint), ref: '', value: '', side: 'top', position: { x: 0, y: 0 }, rotation: 0, edgeCuts: false, pads: [] };
  try {
    const at = child(footprint, 'at'), position = at ? xy(at) : { x: 0, y: 0 }, rotation = number(atom(at, 3, '0'), 'KiCad footprint rotation');
    const layer = atom(child(footprint, 'layer')); if (!['F.Cu', 'B.Cu'].includes(layer)) throw new BoardFormatError(`KiCad footprint has unsupported layer ${layer}.`);
    // B.Cu footprints are serialized already mirrored (board view from the top); no second reflection here.
    const side: BoardSide = layer === 'B.Cu' ? 'bottom' : 'top';
    const property = (name: string) => atom(children(footprint, 'property').find(node => atom(node).toLowerCase() === name.toLowerCase()), 2);
    const textField = (name: string) => atom(children(footprint, 'fp_text').find(node => atom(node) === name), 2);
    read.ref = property('Reference') || textField('reference'); read.value = property('Value') || textField('value');
    const graphics = footprint.filter((node): node is Node => Array.isArray(node) && /^fp_(?:line|rect|poly|arc|circle|curve)$/.test(String(node[0])));
    if (graphics.some(node => atom(child(node, 'layer')) === 'Edge.Cuts')) read.edgeCuts = true;
    let shapePoints: Point[] = [];
    for (const suffix of ['CrtYd', 'Fab', 'SilkS']) {
      shapePoints = graphics.filter(node => atom(child(node, 'layer')).endsWith(`.${suffix}`)).flatMap(graphic);
      if (shapePoints.length) break;
    }
    let outline: Point[] | undefined;
    if (shapePoints.length) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of shapePoints) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
      outline = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }].map(p => canonical(rotateSource(p, position, rotation)));
    }
    Object.assign(read, { side, position: canonical(position), rotation: angle(rotation), outline });
    for (const pad of children(footprint, 'pad')) {
      const localAt = child(pad, 'at'), size = child(pad, 'size');
      // Pad X/Y are footprint-local ("all coordinates are relative to the origin of their containing object");
      // the pad angle is serialized board-absolute, so it is used as-is.
      const local = localAt ? xy(localAt) : { x: 0, y: 0 }, at = canonical(rotateSource(local, position, rotation));
      const width = bounded(atom(size), 'pad width'), height = bounded(atom(size, 2), 'pad height');
      if (width <= 0 || height <= 0) throw new BoardFormatError('KiCad pad has non-positive dimensions.');
      const layers = child(pad, 'layers')?.slice(1) ?? [], front = layers.includes('F.Cu'), back = layers.includes('B.Cu');
      const both = layers.includes('*.Cu') || layers.includes('F&B.Cu') || front && back;
      if (!both && !front && !back) continue; // Mask/paste-only objects are not electrical pads.
      read.pads.push({ number: atom(pad), name: atom(child(pad, 'pinfunction')) || atom(pad), at, width, height, side: both ? 'both' : back ? 'bottom' : 'top',
        shape: atom(pad, 3), netNode: child(pad, 'net'), angleText: atom(localAt, 3, '0') });
    }
    // Mounting holes, fiducials and thermal vias carry no pad number. The board model would number them after their position in the whole
    // board, which can equal a real pad number of the same part (a real 40-pin socket got two extra "11" and "12" pads, W-open-kicad-04):
    // give each one a number of its own that no pad of this footprint uses.
    const taken = new Set(read.pads.map(pad => pad.number));
    let spare = 0;
    for (const pad of read.pads) {
      if (pad.number !== '') continue;
      let candidate: string;
      do candidate = `~${++spare}`; while (taken.has(candidate));
      taken.add(candidate); pad.number = candidate;
    }
  } catch (error) { read.error = error; }
  return read;
}

export function parseKicad(input: ParseInput): Board | null {
  const text = decodeText(input.data);
  if (!/^\s*(?:;[^\n]*\n\s*)*\(kicad_pcb(?:\s|\))/.test(text)) return null;
  const netNodes: Node[] = [], edgeNodes: Node[] = [], footprintReads: FootprintRead[] = [], moduleReads: FootprintRead[] = [], warnings: ParseIssue[] = [];
  let padCount = 0;
  scanPcb(text, element => {
    const key = String(element[0]);
    if (key === 'net') netNodes.push(element);
    else if (key === 'footprint' || key === 'module') {
      const read = readFootprint(element);
      padCount += read.pads.length;
      if (footprintReads.length + moduleReads.length >= MAX_PARTS || padCount > MAX_PINS) throw new BoardFormatError('Board record count exceeds the import limit.', 'LIMIT_EXCEEDED');
      (key === 'footprint' ? footprintReads : moduleReads).push(read);
    } else if (atom(child(element, 'layer')) === 'Edge.Cuts') edgeNodes.push(element); // other graphics are not board geometry
  });
  const parts: RawPart[] = [], pins: RawPin[] = [];
  const nets = new Map<string, string>(), declaredNames = new Map<string, string>(); let approximated = 0, footprintEdgeCuts = false;
  for (const net of netNodes) {
    const id = atom(net), name = atom(net, 2);
    if (!/^\d+$/.test(id)) throw new BoardFormatError(`KiCad net table has an invalid identifier "${id.slice(0, 40)}".`);
    if (nets.has(id)) throw new BoardFormatError('KiCad contains duplicate net identities.');
    const sameName = name ? declaredNames.get(name) : undefined;
    if (sameName !== undefined) throw new BoardFormatError(`KiCad net identifiers ${sameName} and ${id} have the same name "${name.slice(0, 80)}".`);
    nets.set(id, name); if (name) declaredNames.set(name, id);
  }
  // Without a net table the pads are the only declaration, so they must not contradict each other.
  const inferred = new Map<string, string>(), inferredNames = new Map<string, string>();
  const resolveNet = (netNode: Node): string => {
    const id = atom(netNode), inline = atom(netNode, 2), declared = nets.get(id);
    if (!/^\d+$/.test(id)) throw new BoardFormatError(`KiCad pad net has an invalid identifier "${id.slice(0, 40)}".`);
    if (declared !== undefined) {
      if (inline && inline !== declared) throw new BoardFormatError(`KiCad pad net ${id} is named "${inline.slice(0, 80)}" but the net table declares "${declared.slice(0, 80)}".`);
      if (!declared && id !== '0') throw new BoardFormatError(`KiCad net ${id} has no name, so its pads cannot be grouped.`);
      return declared;
    }
    if (id === '0') { if (inline) throw new BoardFormatError(`KiCad pad net 0 (unconnected) is named "${inline.slice(0, 80)}".`); return ''; }
    if (!inline) throw new BoardFormatError(`KiCad pad references missing net ${id}.`);
    if (nets.size) throw new BoardFormatError(`KiCad pad net ${id} ("${inline.slice(0, 80)}") is not declared in the net table.`);
    const prior = inferred.get(id), other = inferredNames.get(inline);
    if (prior !== undefined && prior !== inline) throw new BoardFormatError(`KiCad pads name net ${id} both "${prior.slice(0, 80)}" and "${inline.slice(0, 80)}".`);
    if (other !== undefined && other !== id) throw new BoardFormatError(`KiCad net identifiers ${other} and ${id} have the same name "${inline.slice(0, 80)}".`);
    inferred.set(id, inline); inferredNames.set(inline, id);
    return inline;
  };
  for (const [index, read] of [...footprintReads, ...moduleReads].entries()) {
    const key = String(index);
    if (read.edgeCuts) footprintEdgeCuts = true;
    for (const pad of read.pads) {
      const round = pad.shape === 'circle' && Math.abs(pad.width - pad.height) < 1e-9;
      if (!round && pad.shape !== 'rect') approximated++;
      const netName = pad.netNode ? resolveNet(pad.netNode) : '';
      pins.push({ part: key, number: pad.number, name: pad.name, net: netName, ...pad.at, side: pad.side, width: pad.width, height: pad.height,
        radius: Math.min(pad.width, pad.height) / 2, shape: round ? 'round' : pad.width === pad.height ? 'square' : 'rect', rotation: angle(number(pad.angleText, 'KiCad pad rotation')) });
    }
    if (read.error) throw read.error;
    parts.push({ key, ref: read.ref || `FP${index + 1}`, value: read.value, package: read.name, side: read.side, position: read.position, rotation: read.rotation, outline: read.outline });
  }
  const members = new Map<string, number>();
  for (const pin of pins) if (pin.net) members.set(pin.net, (members.get(pin.net) ?? 0) + 1);
  let placeholders = 0;
  for (const pin of pins) if (pin.net && PLACEHOLDER_NET.test(pin.net) && members.get(pin.net) === 1) { pin.net = ''; placeholders++; }
  if (placeholders) warnings.push(note(`${placeholders} KiCad "unconnected-(…)" single-pad placeholder nets were treated as no-connects.`));
  const paths = edgeNodes.map(graphic);
  const segments: [Point, Point][] = paths.flatMap(path => path.slice(1).map((point, i): [Point, Point] => [path[i], point]));
  const { loops: canonicalLoops, openChains } = stitchOutlines(segments, OUTLINE_CLOSURE_MM), loops = canonicalLoops.map(loop => loop.map(canonical));
  if (segments.length && !loops.length) warnings.push(note('KiCad Edge.Cuts graphics do not form a closed contour; an estimated boundary is shown.'));
  else if (openChains) warnings.push(note(`${openChains} open Edge.Cuts chain${openChains === 1 ? '' : 's'} (spurs, chords or gaps) are not part of a closed contour and were ignored.`));
  // Footprint-local board-edge graphics (slots, mounting cutouts) are not placed on the board outline; the user is told.
  if (footprintEdgeCuts) warnings.push({ key: 'parse.warning.boardCutouts' });
  if (approximated) warnings.push({ key: 'parse.warning.approximatedPads', params: { count: approximated } });
  const raw: RawBoard = { format: 'KiCad PCB', unitsToMm: 1, parts, pins, outline: loops[0] ?? [], outlines: loops, warnings };
  return buildBoard(input, raw);
}
