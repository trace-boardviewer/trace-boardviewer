/*
 * Original TRACE adapter, MIT. Format reference: the EAGLE XML DTD (eagle.dtd, shipped with
 * EAGLE) and the Autodesk Fusion ECAD ULP object reference,
 * https://help.autodesk.com/cloudhelp/ENU/Fusion-ECAD/files/ECD-ULP-OBJECT-TYPES.htm .
 * EAGLE XML coordinates are millimetres with Y up, angles are counter-clockwise degrees.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Board, BoardSide, ParseIssue, Point } from '../types';
import { BoardFormatError, buildBoard, decodeText, note, number, stitchOutlines, type FormatErrorCode, type ParseInput, type RawBoard, type RawPart, type RawPin } from './common';

type Xml = Record<string, unknown>;
const FORMAT = 'EAGLE board (XML)';
const fail = (message: string, code: FormatErrorCode = 'INVALID_FORMAT', format = FORMAT) => new BoardFormatError(message, code, format);
const MAX_ELEMENTS = 250_000, MAX_PINS = 1_000_000;
/** Real 64 MiB boards hold at most ~1.4M tags; far more '<' characters can only be a degenerate or hostile document. */
const MAX_XML_MARKUP = 3_000_000;
const REPEATED = new Set(['library', 'package', 'smd', 'pad', 'wire', 'circle', 'rectangle', 'polygon', 'vertex', 'hole', 'element', 'signal', 'contactref', 'via', 'attribute', 'text']);
const obj = (value: unknown): Xml | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Xml : undefined;
const list = (value: unknown): Xml[] => Array.isArray(value) ? value.map(obj).filter((item): item is Xml => !!item) : [];
/** A container that EAGLE allows once; fast-xml-parser turns a repeat into an array, which must not be dropped silently. */
function section(node: Xml | undefined, name: string): Xml | undefined {
  const value = node?.[name];
  if (Array.isArray(value)) throw fail(`EAGLE has more than one <${name}> section.`, 'INVALID_FORMAT', FORMAT);
  return obj(value);
}
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
/** Only the five predefined XML entities and character references; DOCTYPE entities are never expanded. */
function decodeEntities(value: string): string {
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
const num = (node: Xml, name: string, context: string) => number(required(node, name, context), `EAGLE ${context} ${name}`);
const optionalNum = (node: Xml, name: string, context: string, fallback: number) => attr(node, name) === undefined ? fallback : num(node, name, context);
const angle = (value: number) => ((value % 360) + 360) % 360;

interface Rotation { mirror: boolean; spin: boolean; degrees: number }
/** rot="[S][M]R<angle>": S = spin, M = mirror (bottom side), R = counter-clockwise degrees. */
function rotation(value: string | undefined, context: string): Rotation {
  if (value === undefined) return { mirror: false, spin: false, degrees: 0 };
  const match = /^(S?M?|MS?)R(-?\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) throw fail(`EAGLE ${context} has an invalid rot attribute "${value.slice(0, 40)}".`);
  return { mirror: match[1].includes('M'), spin: match[1].includes('S'), degrees: number(match[2], `EAGLE ${context} rotation`) };
}
/**
 * Places a package-local point on the board: a mirrored (bottom) element is reflected about the
 * package's vertical axis first (x → −x), then the whole element is rotated counter-clockwise by the
 * element angle as seen from the top ("angle defines how many degrees the element is rotated
 * counterclockwise around its origin"), then translated.
 */
function place(local: Point, origin: Point, rot: Rotation): Point {
  const x = rot.mirror ? -local.x : local.x, y = local.y, a = rot.degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: origin.x + x * c - y * s, y: origin.y + x * s + y * c };
}
const placeAngle = (localDegrees: number, rot: Rotation) => angle((rot.mirror ? -localDegrees : localDegrees) + rot.degrees);

const ARC_STEP = Math.PI / 32;
/** EAGLE limits a wire curve to ±359.9°; a full turn or more cannot be drawn from two endpoints. */
function curveOf(node: Xml, context: string): number {
  const curve = optionalNum(node, 'curve', context, 0);
  if (Math.abs(curve) >= 360) throw fail(`EAGLE ${context} curve ${curve} must be between -360 and 360 degrees.`, 'INVALID_FORMAT', FORMAT);
  return curve;
}
/** EAGLE wire curve: the arc spans `curve` degrees from (x1,y1) to (x2,y2), positive = counter-clockwise. */
function arcPoints(a: Point, b: Point, curve: number): Point[] {
  const chord = Math.hypot(b.x - a.x, b.y - a.y), sweep = curve * Math.PI / 180;
  if (!(chord > 0) || Math.abs(sweep) < 1e-9) return [a, b];
  const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2)), offset = radius * Math.cos(sweep / 2) * Math.sign(curve);
  const center = { x: (a.x + b.x) / 2 - (b.y - a.y) / chord * offset, y: (a.y + b.y) / 2 + (b.x - a.x) / chord * offset };
  const start = Math.atan2(a.y - center.y, a.x - center.x), span = Math.abs(sweep), steps = Math.max(2, Math.min(4096, Math.ceil(span / ARC_STEP)));
  const inner: Array<{ at: number; point: Point }> = [];
  for (let i = 1; i < steps; i++) inner.push({ at: i / steps, point: { x: center.x + radius * Math.cos(start + sweep * i / steps), y: center.y + radius * Math.sin(start + sweep * i / steps) } });
  // The four axis extrema inside the sweep are added exactly, so bounds never fall short of the true arc between samples.
  for (let quarter = 0; quarter < 4; quarter++) {
    const along = (((sweep > 0 ? quarter * Math.PI / 2 - start : start - quarter * Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (along > 1e-9 && along < span - 1e-9) inner.push({ at: along / span, point: { x: center.x + radius * [1, 0, -1, 0][quarter], y: center.y + radius * [0, 1, 0, -1][quarter] } });
  }
  return [a, ...inner.sort((p, q) => p.at - q.at).map(item => item.point), b];
}
function circlePoints(center: Point, radius: number): Point[] {
  const steps = 64;
  return Array.from({ length: steps + 1 }, (_, i) => i === steps ? { x: center.x + radius, y: center.y } : { x: center.x + radius * Math.cos(2 * Math.PI * i / steps), y: center.y + radius * Math.sin(2 * Math.PI * i / steps) });
}

interface PackagePad { name: string; local: Point; width?: number; height?: number; radius?: number; shape: RawPin['shape']; approximated: boolean; through: boolean; layer: string; degrees: number }
interface Package { pads: Map<string, PackagePad>; body?: Point[] }

function readPackage(node: Xml, context: string): Package {
  const pads = new Map<string, PackagePad>();
  const add = (pad: PackagePad) => { if (pads.has(pad.name)) throw fail(`EAGLE ${context} declares pad "${pad.name}" twice.`); pads.set(pad.name, pad); };
  for (const smd of list(node.smd)) {
    const name = required(smd, 'name', `${context} smd`), layer = required(smd, 'layer', `${context} smd ${name}`);
    if (layer !== '1' && layer !== '16') throw fail(`EAGLE ${context} smd ${name} is on layer ${layer}; only Top (1) and Bottom (16) are supported.`);
    const width = num(smd, 'dx', `smd ${name}`), height = num(smd, 'dy', `smd ${name}`);
    if (width <= 0 || height <= 0) throw fail(`EAGLE ${context} smd ${name} has non-positive dimensions.`);
    const rot = rotation(attr(smd, 'rot'), `smd ${name}`); if (rot.mirror) throw fail(`EAGLE ${context} smd ${name} must not be mirrored inside a package.`);
    const roundness = optionalNum(smd, 'roundness', `smd ${name}`, 0);
    if (roundness < 0 || roundness > 100) throw fail(`EAGLE ${context} smd ${name} has roundness ${roundness}; it must be between 0 and 100.`);
    // Only roundness 0 (rectangle) and a fully round square (circle) are exact: a pill (100 %, non-square) and every
    // partial rounding are drawn as their bounding rectangle, and counted as approximated.
    const circle = roundness >= 100 && width === height;
    add({ name, local: { x: num(smd, 'x', `smd ${name}`), y: num(smd, 'y', `smd ${name}`) }, width, height, radius: Math.min(width, height) / 2,
      shape: circle ? 'round' : width === height ? 'square' : 'rect', approximated: roundness > 0 && !circle, through: false, layer, degrees: rot.degrees });
  }
  for (const pad of list(node.pad)) {
    const name = required(pad, 'name', `${context} pad`), shape = attr(pad, 'shape') ?? 'round', diameter = optionalNum(pad, 'diameter', `pad ${name}`, 0);
    const drill = num(pad, 'drill', `pad ${name}`); if (drill <= 0 || diameter < 0) throw fail(`EAGLE ${context} pad ${name} has invalid drill or diameter.`);
    if (!['round', 'square', 'octagon', 'long', 'offset'].includes(shape)) throw fail(`EAGLE ${context} pad ${name} has unknown shape "${shape.slice(0, 40)}".`);
    const rot = rotation(attr(pad, 'rot'), `pad ${name}`);
    // diameter="0" or absent means "from design rules": the real size is not in the file, so none is invented.
    const size = diameter > 0 ? { width: diameter, height: diameter, radius: diameter / 2 } : {};
    add({ name, local: { x: num(pad, 'x', `pad ${name}`), y: num(pad, 'y', `pad ${name}`) }, ...size,
      shape: shape === 'square' ? 'square' : shape === 'round' ? 'round' : 'rect', approximated: shape !== 'round' && shape !== 'square', through: true, layer: 'both', degrees: rot.degrees });
  }
  let body: Point[] | undefined;
  for (const layers of [['21', '22'], ['51', '52'], ['39', '40']]) { // tPlace/bPlace, tDocu/bDocu, tKeepout/bKeepout
    const points: Point[] = [];
    const onLayer = (item: Xml) => layers.includes(attr(item, 'layer') ?? '');
    for (const wire of list(node.wire).filter(onLayer)) points.push(...arcPoints({ x: num(wire, 'x1', 'wire'), y: num(wire, 'y1', 'wire') }, { x: num(wire, 'x2', 'wire'), y: num(wire, 'y2', 'wire') }, curveOf(wire, 'wire')));
    for (const rect of list(node.rectangle).filter(onLayer)) {
      const a = { x: num(rect, 'x1', 'rectangle'), y: num(rect, 'y1', 'rectangle') }, b = { x: num(rect, 'x2', 'rectangle'), y: num(rect, 'y2', 'rectangle') };
      const turn = rotation(attr(rect, 'rot'), 'rectangle').degrees * Math.PI / 180, cos = Math.cos(turn), sin = Math.sin(turn), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      for (const corner of [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]) points.push({ x: cx + (corner.x - cx) * cos - (corner.y - cy) * sin, y: cy + (corner.x - cx) * sin + (corner.y - cy) * cos });
    }
    for (const circle of list(node.circle).filter(onLayer)) {
      const x = num(circle, 'x', 'circle'), y = num(circle, 'y', 'circle'), r = num(circle, 'radius', 'circle');
      points.push({ x: x - r, y: y - r }, { x: x + r, y: y + r });
    }
    for (const polygon of list(node.polygon).filter(onLayer)) {
      const vertices = list(polygon.vertex);
      vertices.forEach((vertex, index) => {
        const next = vertices[(index + 1) % vertices.length];
        points.push(...arcPoints({ x: num(vertex, 'x', 'vertex'), y: num(vertex, 'y', 'vertex') }, { x: num(next, 'x', 'vertex'), y: num(next, 'y', 'vertex') }, curveOf(vertex, 'vertex')));
      });
    }
    if (!points.length) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    body = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }]; break;
  }
  return { pads, body };
}

interface Prolog { root: string; entities: boolean; /** Index just after the root element name. */ rootEnd: number }
/**
 * Walks the XML declaration, comments, processing instructions and DOCTYPE up to the first start tag, so recognition
 * does not depend on a declaration being present and a non-EAGLE document is rejected without being parsed. Reports
 * whether the DOCTYPE declares entities (never expanded: such a document is refused). 'open' means the text ended inside
 * the prologue, so a longer text may still reach a root element (the sniff of a truncated head needs that); undefined
 * means the text is not XML.
 */
export function prologWalk(text: string): Prolog | 'open' | undefined {
  let at = 0, entities = false;
  const end = text.length;
  for (;;) {
    while (at < end && (text.charCodeAt(at) <= 0x20 || text.charCodeAt(at) === 0xfeff)) at++;
    if (at >= end) return 'open';
    if (text[at] !== '<') return undefined;
    if (text.startsWith('<?', at)) { const close = text.indexOf('?>', at + 2); if (close < 0) return 'open'; at = close + 2; continue; }
    if (text.startsWith('<!--', at)) { const close = text.indexOf('-->', at + 4); if (close < 0) return 'open'; at = close + 3; continue; }
    if (text.startsWith('<!DOCTYPE', at)) {
      let depth = 0, quote = '', index = at + 9;
      for (; index < end; index++) {
        const c = text[index];
        if (quote) { if (c === quote) quote = ''; continue; }
        if (text.startsWith('<!--', index)) { const close = text.indexOf('-->', index + 4); if (close < 0) return 'open'; index = close + 2; continue; }
        if (c === '"' || c === "'") quote = c;
        else if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (index >= end) return 'open';
      if (text.slice(at, index).includes('<!ENTITY')) entities = true;
      at = index + 1; continue;
    }
    const rest = text.slice(at, at + 256);
    if (rest.length < 9 && ('<!DOCTYPE'.startsWith(rest) || '<!--'.startsWith(rest))) return 'open';
    const root = /^<([A-Za-z_][\w.:-]*)/.exec(rest);
    return root ? { root: root[1], entities, rootEnd: at + 1 + root[1].length } : undefined;
  }
}
function prolog(text: string): Prolog | undefined {
  const walk = prologWalk(text);
  return typeof walk === 'object' ? walk : undefined;
}

export function parseEagle(input: ParseInput): Board | null {
  const text = decodeText(input.data), head = prolog(text);
  if (head?.root !== 'eagle') return null;
  if (head.entities) throw fail('EAGLE XML declares entities (<!ENTITY>); entity declarations are not supported and are never expanded.');
  // A schematic belongs to the schematic reader: leave it unclaimed without paying for a full parse.
  if (/<schematic[\s>]/.test(text) && !/<board[\s>]/.test(text)) return null;
  const elementCount = (text.match(/<element[\s/>]/g) ?? []).length;
  if (elementCount > MAX_ELEMENTS) throw fail('EAGLE board exceeds the 250,000 component import limit.', 'LIMIT_EXCEEDED');
  let markup = 0;
  for (let at = text.indexOf('<'); at >= 0; at = text.indexOf('<', at + 1)) if (++markup > MAX_XML_MARKUP) throw fail('EAGLE document exceeds the XML markup import limit.', 'LIMIT_EXCEEDED');
  // The parser alone tolerates unclosed and mismatched tags, which would silently load a truncated file as a smaller board.
  const wellFormed = XMLValidator.validate(text);
  if (wellFormed !== true) throw fail(`EAGLE XML is malformed: ${wellFormed.err.msg.slice(0, 200)} (line ${wellFormed.err.line}).`);
  let document: unknown;
  try {
    document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', ignoreDeclaration: true, ignorePiTags: true, processEntities: false,
      parseTagValue: false, parseAttributeValue: false, trimValues: true, maxNestedTags: 64, isArray: name => REPEATED.has(name) }).parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/nested tags/i.test(message)) throw fail('EAGLE XML nesting exceeds the import limit.', 'LIMIT_EXCEEDED');
    throw fail(`EAGLE XML is malformed: ${message.slice(0, 200) || 'unreadable document'}.`);
  }
  const root = obj(obj(document)?.eagle); if (!root) throw fail('EAGLE document has no <eagle> root element.');
  const drawing = section(root, 'drawing'); if (!drawing) throw fail('EAGLE document has no <drawing> element.');
  if (drawing.schematic !== undefined) return null;
  if (drawing.library !== undefined) throw fail('This is an EAGLE library; it contains packages but no board placement.', 'WRONG_KIND', 'EAGLE library');
  const board = section(drawing, 'board'); if (!board) throw fail('EAGLE drawing has no <board> element.');

  const packages = new Map<string, Package>();
  for (const library of list(section(board, 'libraries')?.library)) {
    const libraryName = required(library, 'name', 'library'), urn = attr(library, 'urn') ?? '';
    for (const pkg of list(section(library, 'packages')?.package)) {
      const name = required(pkg, 'name', `library ${libraryName} package`), parsed = readPackage(pkg, `package ${libraryName}/${name}`);
      for (const key of [`${libraryName}\u0000${urn}\u0000${name}`, ...urn ? [] : [`${libraryName}\u0000\u0000${name}`]]) if (!packages.has(key)) packages.set(key, parsed);
      if (!packages.has(`${libraryName}\u0000*\u0000${name}`)) packages.set(`${libraryName}\u0000*\u0000${name}`, parsed);
    }
  }
  // Resolve every element and sum the pads of the packages it references BEFORE any pin is created: the output grows
  // as pads x elements, so a few hundred KB of XML can plan billions of pins.
  const elements: Array<{ node: Xml; name: string; packageName: string; pkg: Package }> = [], names = new Set<string>();
  let planned = 0;
  for (const element of list(section(board, 'elements')?.element)) {
    const name = required(element, 'name', 'element'), libraryName = required(element, 'library', `element ${name}`), packageName = required(element, 'package', `element ${name}`);
    const urn = attr(element, 'library_urn') ?? '';
    const pkg = packages.get(`${libraryName}\u0000${urn}\u0000${packageName}`) ?? (urn ? undefined : packages.get(`${libraryName}\u0000*\u0000${packageName}`));
    if (!pkg) {
      const known = [...packages.keys()].some(key => key.startsWith(`${libraryName}\u0000`));
      throw fail(known ? `EAGLE element ${name} uses package "${packageName}" which library "${libraryName}" does not define.` : `EAGLE element ${name} references unknown library "${libraryName}".`);
    }
    if (names.has(name)) throw fail(`EAGLE declares element "${name}" twice.`);
    names.add(name); planned += pkg.pads.size; elements.push({ node: element, name, packageName, pkg });
  }
  if (planned > MAX_PINS) throw fail(`EAGLE board expands to ${planned} pins; the import limit is ${MAX_PINS}.`, 'LIMIT_EXCEEDED');
  const parts: RawPart[] = [], pins: RawPin[] = [], warnings: ParseIssue[] = [], placed = new Map<string, Map<string, RawPin>>();
  let approximated = 0;
  for (const { node: element, name, packageName, pkg } of elements) {
    const origin = { x: num(element, 'x', `element ${name}`), y: num(element, 'y', `element ${name}`) }, rot = rotation(attr(element, 'rot'), `element ${name}`);
    const side: BoardSide = rot.mirror ? 'bottom' : 'top', key = name, padMap = new Map<string, RawPin>();
    parts.push({ key, ref: name, value: attr(element, 'value') ?? '', package: packageName, side, position: origin, rotation: angle(rot.degrees), outline: pkg.body?.map(p => place(p, origin, rot)) });
    for (const pad of pkg.pads.values()) {
      const position = place(pad.local, origin, rot);
      // SMD layer 1 is the package top; a mirrored element puts it on the bottom (and layer 16 on top).
      const padSide: BoardSide = pad.through ? 'both' : (pad.layer === '1') !== rot.mirror ? 'top' : 'bottom';
      if (pad.approximated) approximated++;
      const pin: RawPin = { part: key, number: pad.name, name: pad.name, net: '', ...position, side: padSide, shape: pad.shape, rotation: placeAngle(pad.degrees, rot),
        ...(pad.width === undefined ? {} : { width: pad.width, height: pad.height, radius: pad.radius }) };
      pins.push(pin); padMap.set(pad.name, pin);
    }
    placed.set(name, padMap);
  }
  if (pins.length > MAX_PINS) throw fail('EAGLE board exceeds the 1,000,000 pin import limit.', 'LIMIT_EXCEEDED');
  for (const signal of list(section(board, 'signals')?.signal)) {
    const net = required(signal, 'name', 'signal');
    for (const ref of list(signal.contactref)) {
      const elementName = required(ref, 'element', `signal ${net} contactref`), padName = required(ref, 'pad', `signal ${net} contactref`);
      const pin = placed.get(elementName)?.get(padName);
      if (!pin) throw fail(`EAGLE signal "${net}" references ${placed.has(elementName) ? `missing pad "${padName}" of element` : 'unknown element'} "${elementName}".`);
      if (pin.net && pin.net !== net) throw fail(`EAGLE pad ${elementName}.${padName} is listed in signals "${pin.net}" and "${net}".`);
      pin.net = net;
    }
  }
  const plain = section(board, 'plain'), segments: [Point, Point][] = []; let arcs = 0;
  for (const wire of list(plain?.wire).filter(item => attr(item, 'layer') === '20')) { // layer 20 = Dimension
    const a = { x: num(wire, 'x1', 'dimension wire'), y: num(wire, 'y1', 'dimension wire') }, b = { x: num(wire, 'x2', 'dimension wire'), y: num(wire, 'y2', 'dimension wire') };
    const path = arcPoints(a, b, curveOf(wire, 'dimension wire'));
    if (path.length > 2) arcs++;
    segments.push(...path.slice(1).map((point, i): [Point, Point] => [path[i], point]));
  }
  for (const circle of list(plain?.circle).filter(item => attr(item, 'layer') === '20')) {
    const path = circlePoints({ x: num(circle, 'x', 'dimension circle'), y: num(circle, 'y', 'dimension circle') }, num(circle, 'radius', 'dimension circle'));
    arcs++; segments.push(...path.slice(1).map((point, i): [Point, Point] => [path[i], point]));
  }
  const { loops, openChains } = stitchOutlines(segments);
  if (segments.length && !loops.length) warnings.push(note('EAGLE Dimension (layer 20) wires do not form a closed contour; an estimated boundary is shown.'));
  else if (openChains) warnings.push(note(`${openChains} open EAGLE Dimension chain${openChains === 1 ? '' : 's'} (spurs, chords or gaps) are not part of a closed contour and were ignored.`));
  if (arcs && loops.length) warnings.push(note(`${arcs} EAGLE outline arcs/circles were approximated by straight segments.`));
  if (approximated) warnings.push({ key: 'parse.warning.approximatedPads', params: { count: approximated } });
  const raw: RawBoard = { format: FORMAT, unitsToMm: 1, parts, pins, outline: loops[0] ?? [], outlines: loops, warnings };
  return buildBoard(input, raw);
}
