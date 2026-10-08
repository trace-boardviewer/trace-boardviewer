/*
 * Original TRACE adapter (MIT). EasyEDA Standard PCB reader. Format reference: the official EasyEDA Standard document format,
 * docs.easyeda.com/en/DocumentFormat/ ("EasyEDA PCB File Format" and "EasyEDA PCB File Object" pages, including the object-model example they link).
 * No implementation source code was read or copied.
 *
 * Two layouts of the documented PCB document are read, both after JSON.parse (the file is strict JSON):
 *   shape array  {"head":{"docType":"3"|"3~ver~..."},"canvas":"CA~...","shape":["LIB~x~y~attrs~rot~~id~lock#@$PAD~...#@$TEXT~P~...","TRACK~...","PAD~..."],...}
 *   object model {"TRACK":{id:{...}},"PAD":{...},"FOOTPRINT":{id:{"PAD":{...},"TEXT":{...},"head":{"x","y","c_para"}}},...} (also wrapped in "dataStr")
 *
 * Units: every coordinate and size is in units of 10 mil (0.254 mm). The canvas is Y-down like SVG; the board is flipped to the viewer's Y-up.
 * Footprints (LIB) carry absolute canvas coordinates for their pads, so no placement transform is applied; a bottom-side part is simply a part whose
 * pads sit on layer 2. Layer ids used: 1 top copper, 2 bottom copper, 3/4 top/bottom silkscreen (component body), 10 board outline, 11 multi-layer
 * (through-hole pads). Components come from LIB shapes (designator = the TEXT of type P, package = the "package" attribute, value = a "value" attribute);
 * nets come from the net field of each pad. A free PAD with a net becomes a one-pad part; tracks, vias, copper areas, holes, text and images are not read.
 *
 * Rotation: the documents do not say which way a positive angle turns. The editor draws with SVG transforms, where positive is clockwise on screen,
 * so a component or pad angle is taken as clockwise on the canvas (= counter-clockwise after the Y flip: angle -> -angle). A rectangular pad that lists its
 * four corner points is read from those points instead (they are absolute geometry), so only round, oval and polygon pads, whose orientation cannot be
 * seen from their size, depend on that assumption. No real EasyEDA Standard file was available: everything is proven on synthetic documents modelled on the
 * vendor examples.
 */
import type { Board, BoardSide, ParseIssue, Point } from '../types';
import { BoardFormatError, buildBoard, decodeText, type ParseInput, type RawBoard, type RawPart, type RawPin, stitchOutlines } from './common';
import {
  EASYEDA_STD_FORMAT, MAX_PARTS, MAX_PINS, OUTLINE_CLOSURE_MM, STD_UNIT_MM, PointBudget, arcBySvg, boxCorners, boxIsEmpty, circlePoints, edgesOf, emptyBox, fail, grow,
  headText, normalizeAngle, note, numberList, numeric, numericOr, pointsOf, quantity, splitFields, type Box, type EasyedaKind, type EasyedaSniff,
} from './easyeda-common';

const FORMAT = EASYEDA_STD_FORMAT;
const MAX_SHAPES = 2_000_000, MAX_CHILDREN = 200_000, MAX_PATH_CHARS = 65_536, MAX_CPARA_FIELDS = 4_000;
const OUTLINE_LAYER = 10;
const NEWLINE = '#@$';
const PAD_SHAPES = new Set(['ELLIPSE', 'RECT', 'OVAL', 'POLYGON']);

/** Static facts about the reader, for the registry that lists formats (the generated capability table is built from these). */
export const EASYEDA_STD_INFO = {
  id: 'easyeda-std', name: 'EasyEDA Standard PCB', extensions: ['.json'], variants: ['shape-array PCB document (head docType 3, "shape" list of LIB/PAD/TRACK strings)', 'object-model PCB document (TRACK/PAD/FOOTPRINT keys), also inside a "dataStr" wrapper'],
  status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'mixed', units: '10 mil (0.254 mm)',
  sides: 'pad layer 1 top, 2 bottom, 11 both; a component is on the side of its SMD pads, otherwise of its silkscreen',
  notes: [
    'Fixtures are original synthetic documents modelled on the vendor examples; no real EasyEDA Standard file was available. The angle direction of a footprint or a round pad is not stated by the vendor (read as clockwise on the canvas, like the editor\'s SVG), so only rectangular pads that list their four corner points are exact.',
    'Footprints (LIB) carry absolute canvas coordinates, so a bottom-side part is simply a part whose pads sit on layer 2; designator, package and value come from the P text and the footprint attributes.',
    'Tracks, vias, copper areas, holes, text and images are not read (nets come from the pads); free pads with a net become one-pad parts; oval and polygon pads are drawn as bounding rectangles and counted as approximated.',
    'Outline: layer 10 tracks, arcs, rectangles and circles stitched into the largest closed loop (arcs sampled as segments); inner loops are disclosed as cutouts. Schematic documents are not boards; a footprint document is rejected as the wrong kind.',
  ],
} as const;

// --- Recognition ---------------------------------------------------------------------------------------------------------------------------------
const SHAPE_COMMANDS = new Set(['LIB', 'PAD', 'TRACK', 'VIA', 'ARC', 'RECT', 'CIRCLE', 'HOLE', 'TEXT', 'SOLIDREGION', 'COPPERAREA', 'DIMENSION', 'SVGNODE', 'IMAGE']);
const KINDS: Record<string, EasyedaKind> = { '3': 'pcb', '4': 'footprint', '1': 'schematic', '2': 'schematic', '5': 'project' };
const SNIFF_BYTES = 64 * 1024;
/** Skips white space and the backslash-n, backslash-r and backslash-t escape sequences of a pretty-printed document held inside a JSON string. */
const skipSpace = (text: string, at: number): number => {
  for (;;) {
    const code = text.charCodeAt(at);
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 0xa0 || code === 0xfeff) at++;
    else if (code === 92 && (text[at + 1] === 'n' || text[at + 1] === 'r' || text[at + 1] === 't')) at += 2;
    else return at;
  }
};

/** True when `"name": {` occurs (an object-valued member), whatever the spacing. */
function hasObjectMember(text: string, name: string): boolean {
  const key = `"${name}"`;
  for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + key.length)) {
    const colon = skipSpace(text, at + key.length);
    if (text[colon] === ':' && text[skipSpace(text, colon + 1)] === '{') return true;
  }
  return false;
}
/** The head's document type ("3" PCB, "4" footprint, "1" schematic) from the object or the "3~1.7.5~..." text form, searched after `"head"`. */
function documentType(text: string, escaped: boolean): string | undefined {
  const key = escaped ? '\\"head\\"' : '"head"', quote = escaped ? '\\"' : '"';
  const head = text.indexOf(key);
  if (head < 0) return undefined;
  let at = skipSpace(text, head + key.length);
  if (text[at] !== ':') return undefined;
  at = skipSpace(text, at + 1);
  if (text.startsWith(quote, at)) { const value = text.slice(at + quote.length, at + quote.length + 8); const end = value.indexOf('~'); return end > 0 ? value.slice(0, end) : undefined; }
  if (text[at] !== '{') return undefined;
  const docKey = escaped ? '\\"docType\\"' : '"docType"', found = text.indexOf(docKey, at);
  if (found < 0 || found > at + 4096) return undefined;
  let valueAt = skipSpace(text, found + docKey.length);
  if (text[valueAt] !== ':') return undefined;
  valueAt = skipSpace(text, valueAt + 1);
  if (text.startsWith(quote, valueAt)) valueAt += quote.length;
  const match = /^\d{1,2}/.exec(text.slice(valueAt, valueAt + 4));
  return match?.[0];
}
/** First command of the shape array, e.g. "LIB" from `"shape":["LIB~...`; undefined when the array is empty, absent or not text. */
function firstShape(text: string, escaped: boolean): string | undefined {
  const key = escaped ? '\\"shape\\"' : '"shape"', quote = escaped ? '\\"' : '"';
  const at = text.indexOf(key);
  if (at < 0) return undefined;
  let i = skipSpace(text, at + key.length);
  if (text[i] !== ':') return undefined;
  i = skipSpace(text, i + 1);
  if (text[i] !== '[') return undefined;
  i = skipSpace(text, i + 1);
  if (!text.startsWith(quote, i)) return text[i] === ']' ? '' : undefined;
  const value = text.slice(i + quote.length, i + quote.length + 16), end = value.indexOf('~');
  return end > 0 ? value.slice(0, end) : undefined;
}

/**
 * Bounded look (first 64 KiB, no JSON parse) at a JSON document. 0.95: a PCB document with head docType 3, a "CA~" canvas string and a shape array of
 * known commands; 0.85 when the canvas is missing; 0.6: object-model keys or a document wrapped in a "dataStr" text. Schematic and footprint documents are
 * reported with their kind so the caller can route them (the reader itself returns null for a schematic and throws WRONG_KIND for a footprint).
 */
export function sniffEasyedaStd(data: Uint8Array, name = ''): EasyedaSniff | null {
  if (!data.length) return null;
  const text = headText(data, SNIFF_BYTES);
  const first = skipSpace(text, 0);
  if (text[first] !== '{') return null;
  const jsonName = /\.json$/i.test(name);
  const escaped = text.indexOf('\\"shape\\"') >= 0 && text.indexOf('"shape"') < 0;
  const type = documentType(text, escaped), kind = type ? KINDS[type] : undefined;
  const command = firstShape(text, escaped);
  if (command !== undefined && (command === '' || SHAPE_COMMANDS.has(command) || kind === 'schematic')) {
    if (!kind) return null;
    const canvas = text.includes(escaped ? 'CA~' : '"CA~');
    if (escaped) return { id: 'easyeda-std', variant: 'wrapped-text', kind, confidence: 0.6, reason: 'JSON text holding an escaped EasyEDA head and shape array' };
    return { id: 'easyeda-std', variant: 'shape-array', kind, confidence: canvas ? 0.95 : 0.85, reason: `head docType ${type}, shape array starting with ${command || 'nothing'}${canvas ? ', CA~ canvas' : ''}${jsonName ? ', .json name' : ''}` };
  }
  // Object model: documented keys, at least two of them as object members, plus the layer table or item order.
  const present = ['TRACK', 'PAD', 'FOOTPRINT', 'VIA', 'COPPERAREA'].filter(key => hasObjectMember(text, key)).length;
  const marker = text.includes('"itemOrder"') || hasObjectMember(text, 'layers') || text.includes('"SIGNALS"');
  if (present >= 2 && marker) return { id: 'easyeda-std', variant: 'object-model', kind: 'pcb', confidence: 0.6, reason: 'documented object-model keys (TRACK/PAD/FOOTPRINT ...) with layer or item-order tables' };
  return null;
}

// --- Document model ----------------------------------------------------------------------------------------------------------------------------
interface StdPad { shape: string; x: number; y: number; width: number; height: number; layer: number; net: string; number: string; points: Point[]; rotation: number }
interface StdPart {
  x: number; y: number; rotation: number; attrs: Map<string, string>; designator: string; pads: StdPad[]; silk: Box; silkTop: number; silkBottom: number;
  declaredSide?: BoardSide; cutouts: number;
}
interface OutlineItem { kind: 'track' | 'arc' | 'rect' | 'circle'; layer: number; points?: Point[]; path?: string; x?: number; y?: number; width?: number; height?: number; r?: number }
interface Document { parts: StdPart[]; freePads: StdPad[]; outline: OutlineItem[]; skipped: Map<string, number> }

/** Singular and plural of each kind of content the reader does not import. */
const SKIPPED: Record<string, [string, string]> = {
  tracks: ['track', 'tracks'], arcs: ['arc', 'arcs'], vias: ['via', 'vias'], holes: ['hole', 'holes'], 'copper areas': ['copper area', 'copper areas'],
  'circles and rectangles': ['circle or rectangle', 'circles and rectangles'], 'text, dimensions and images': ['text, dimension or image', 'text, dimension and image items'], 'other shapes': ['other shape', 'other shapes'],
};
const count = (skipped: Map<string, number>, key: string) => skipped.set(key, (skipped.get(key) ?? 0) + 1);
const layerOf = (value: unknown, label: string): number => {
  const layer = numeric(value, `${label} layer`, FORMAT);
  if (!Number.isInteger(layer) || layer < 0) fail(FORMAT, `${FORMAT}: ${label} has an invalid layer id.`);
  return layer;
};
/** Backtick-separated key/value pairs ("package`R0603`Contributor`x`"). */
function attributes(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const parts = splitFields(text, '`', MAX_CPARA_FIELDS);
  for (let i = 0; i + 1 < parts.length; i += 2) { const key = parts[i].trim().toLowerCase(); if (key && !map.has(key)) map.set(key, parts[i + 1]); }
  return map;
}
function pathPoints(path: string, budget: PointBudget): Point[] {
  if (path.length > MAX_PATH_CHARS) fail(FORMAT, `${FORMAT}: an arc path is longer than ${MAX_PATH_CHARS} characters.`, 'LIMIT_EXCEEDED');
  const tokens = path.match(/[A-Za-z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
  const points: Point[] = [];
  let command = '', i = 0;
  const take = (n: number, what: string): number[] => {
    const values: number[] = [];
    for (let k = 0; k < n; k++) { const token = tokens[i++]; if (token === undefined || /^[A-Za-z]$/.test(token)) return fail(FORMAT, `${FORMAT}: an arc path is cut short (${what}).`); values.push(numeric(token, `arc path ${what}`, FORMAT)); }
    return values;
  };
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) { command = tokens[i++]; if (command === 'Z' || command === 'z') { if (points.length) points.push(points[0]); command = ''; } continue; }
    if (command === 'M' || command === 'L') { const [x, y] = take(2, command); points.push({ x, y }); if (command === 'M') command = 'L'; }
    else if (command === 'A') {
      const [rx, ry, , large, sweep, x, y] = take(7, 'A');
      if (!points.length) fail(FORMAT, `${FORMAT}: an arc path starts with an arc.`);
      points.push(...arcBySvg(points[points.length - 1], { x, y }, Math.max(rx, ry), large !== 0, sweep !== 0, budget).slice(1));
    } else fail(FORMAT, `${FORMAT}: an arc path uses the "${command || 'missing'}" command, which is not supported.`, 'UNSUPPORTED_VARIANT');
  }
  return points;
}

function padOf(fields: string[], where: string): StdPad {
  const shape = fields[1]?.trim().toUpperCase();
  if (!shape || !PAD_SHAPES.has(shape)) return fail(FORMAT, `${FORMAT}: ${where} has pad shape "${(fields[1] ?? '').slice(0, 20)}", which is not documented.`, 'UNSUPPORTED_VARIANT');
  const layer = layerOf(fields[6], `${where} pad`);
  if (layer !== 1 && layer !== 2 && layer !== 11) fail(FORMAT, `${FORMAT}: ${where} pad is on layer ${layer}; only top (1), bottom (2) and multi-layer (11) pads are supported.`, 'UNSUPPORTED_VARIANT');
  return {
    shape, x: numeric(fields[2], `${where} pad x`, FORMAT), y: numeric(fields[3], `${where} pad y`, FORMAT),
    width: numericOr(fields[4], 0, `${where} pad width`, FORMAT), height: numericOr(fields[5], 0, `${where} pad height`, FORMAT), layer,
    net: (fields[7] ?? '').trim(), number: (fields[8] ?? '').trim(), points: fields[10] ? pointsOf(numberList(fields[10], `${where} pad points`, FORMAT, 10_000), `${where} pad points`, FORMAT) : [],
    rotation: numericOr(fields[11], 0, `${where} pad rotation`, FORMAT),
  };
}
const newPart = (x: number, y: number, rotation: number, attrs: Map<string, string>): StdPart =>
  ({ x, y, rotation, attrs, designator: '', pads: [], silk: emptyBox(), silkTop: 0, silkBottom: 0, cutouts: 0 });
function silkSide(part: StdPart, layer: number): void { if (layer === 3) part.silkTop++; else if (layer === 4) part.silkBottom++; }

/** One shape of a footprint (shape-array layout). */
function readChild(part: StdPart, text: string, doc: Document, budget: PointBudget): void {
  const end = text.indexOf('~'), command = end < 0 ? text : text.slice(0, end);
  switch (command) {
    case 'PAD': part.pads.push(padOf(splitFields(text, '~', 17), 'a footprint')); return;
    case 'TRACK': {
      const f = splitFields(text, '~', 6), layer = layerOf(f[2], 'a footprint track');
      if (layer === 3 || layer === 4) { silkSide(part, layer); for (const p of pointsOf(numberList(f[4] ?? '', 'track points', FORMAT, 100_000), 'track points', FORMAT)) grow(part.silk, p.x, p.y); }
      else if (layer === OUTLINE_LAYER) part.cutouts++; else count(doc.skipped, 'tracks');
      return;
    }
    case 'CIRCLE': {
      const f = splitFields(text, '~', 7), layer = layerOf(f[5], 'a footprint circle');
      if (layer === 3 || layer === 4) { const cx = numeric(f[1], 'circle x', FORMAT), cy = numeric(f[2], 'circle y', FORMAT), r = Math.abs(numeric(f[3], 'circle radius', FORMAT)); silkSide(part, layer); grow(part.silk, cx - r, cy - r); grow(part.silk, cx + r, cy + r); }
      else if (layer === OUTLINE_LAYER) part.cutouts++; else count(doc.skipped, 'circles and rectangles');
      return;
    }
    case 'RECT': {
      const f = splitFields(text, '~', 7), layer = layerOf(f[5], 'a footprint rectangle');
      if (layer === 3 || layer === 4) { const x = numeric(f[1], 'rectangle x', FORMAT), y = numeric(f[2], 'rectangle y', FORMAT); silkSide(part, layer); grow(part.silk, x, y); grow(part.silk, x + numeric(f[3], 'rectangle width', FORMAT), y + numeric(f[4], 'rectangle height', FORMAT)); }
      else if (layer === OUTLINE_LAYER) part.cutouts++; else count(doc.skipped, 'circles and rectangles');
      return;
    }
    case 'ARC': {
      const f = splitFields(text, '~', 7), layer = layerOf(f[2], 'a footprint arc');
      if (layer === 3 || layer === 4) { silkSide(part, layer); for (const p of pathPoints(f[4] ?? '', budget)) grow(part.silk, p.x, p.y); }
      else if (layer === OUTLINE_LAYER) part.cutouts++; else count(doc.skipped, 'arcs');
      return;
    }
    case 'TEXT': {
      const f = splitFields(text, '~', 12);
      if ((f[1] ?? '') === 'P') { const layer = layerOf(f[7], 'a footprint text'); silkSide(part, layer); if (!part.designator) part.designator = (f[10] ?? '').trim(); }
      return;
    }
    case 'VIA': count(doc.skipped, 'vias'); return;
    case 'HOLE': count(doc.skipped, 'holes'); return;
    case 'SOLIDREGION': case 'COPPERAREA': count(doc.skipped, 'copper areas'); return;
    default: count(doc.skipped, 'other shapes');
  }
}

function readShapeArray(shapes: unknown[], doc: Document, budget: PointBudget): void {
  if (shapes.length > MAX_SHAPES) fail(FORMAT, `${FORMAT}: the shape array has ${shapes.length} entries; the import limit is ${MAX_SHAPES}.`, 'LIMIT_EXCEEDED');
  let parts = 0, pads = 0;
  shapes.forEach((shape, index) => {
    if (typeof shape !== 'string') return fail(FORMAT, `${FORMAT}: shape entry ${index} is not text.`);
    const end = shape.indexOf('~'), command = end < 0 ? shape : shape.slice(0, end);
    if (command === 'LIB') {
      if (++parts > MAX_PARTS) fail(FORMAT, 'Board record count exceeds the import limit.', 'LIMIT_EXCEEDED');
      const children = shape.split(NEWLINE);
      if (children.length > MAX_CHILDREN) fail(FORMAT, `${FORMAT}: a footprint has ${children.length} shapes; the import limit is ${MAX_CHILDREN}.`, 'LIMIT_EXCEEDED');
      const head = splitFields(children[0], '~', 8), part = newPart(numeric(head[1], 'footprint x', FORMAT), numeric(head[2], 'footprint y', FORMAT), numericOr(head[4], 0, 'footprint rotation', FORMAT), attributes(head[3] ?? ''));
      for (let c = 1; c < children.length; c++) readChild(part, children[c], doc, budget);
      pads += part.pads.length;
      if (pads > MAX_PINS) fail(FORMAT, 'Board record count exceeds the import limit.', 'LIMIT_EXCEEDED');
      doc.parts.push(part);
    } else if (command === 'PAD') {
      if (++pads > MAX_PINS) fail(FORMAT, 'Board record count exceeds the import limit.', 'LIMIT_EXCEEDED');
      doc.freePads.push(padOf(splitFields(shape, '~', 17), 'a board'));
    } else if (command === 'TRACK') {
      const f = splitFields(shape, '~', 6), layer = layerOf(f[2], 'a track');
      if (layer === OUTLINE_LAYER) doc.outline.push({ kind: 'track', layer, points: pointsOf(numberList(f[4] ?? '', 'outline track points', FORMAT, 100_000), 'outline track points', FORMAT) }); else count(doc.skipped, 'tracks');
    } else if (command === 'ARC') {
      const f = splitFields(shape, '~', 7), layer = layerOf(f[2], 'an arc');
      if (layer === OUTLINE_LAYER) doc.outline.push({ kind: 'arc', layer, path: f[4] ?? '' }); else count(doc.skipped, 'arcs');
    } else if (command === 'RECT') {
      const f = splitFields(shape, '~', 7), layer = layerOf(f[5], 'a rectangle');
      if (layer === OUTLINE_LAYER) doc.outline.push({ kind: 'rect', layer, x: numeric(f[1], 'outline rectangle x', FORMAT), y: numeric(f[2], 'outline rectangle y', FORMAT), width: numeric(f[3], 'outline rectangle width', FORMAT), height: numeric(f[4], 'outline rectangle height', FORMAT) });
      else count(doc.skipped, 'circles and rectangles');
    } else if (command === 'CIRCLE') {
      const f = splitFields(shape, '~', 7), layer = layerOf(f[5], 'a circle');
      if (layer === OUTLINE_LAYER) doc.outline.push({ kind: 'circle', layer, x: numeric(f[1], 'outline circle x', FORMAT), y: numeric(f[2], 'outline circle y', FORMAT), r: Math.abs(numeric(f[3], 'outline circle radius', FORMAT)) });
      else count(doc.skipped, 'circles and rectangles');
    } else if (command === 'VIA') count(doc.skipped, 'vias');
    else if (command === 'HOLE') count(doc.skipped, 'holes');
    else if (command === 'SOLIDREGION' || command === 'COPPERAREA') count(doc.skipped, 'copper areas');
    else if (command === 'TEXT' || command === 'DIMENSION' || command === 'SVGNODE' || command === 'IMAGE') count(doc.skipped, 'text, dimensions and images');
    else count(doc.skipped, 'other shapes');
  });
}

// --- Object-model layout ----------------------------------------------------------------------------------------------------------------------
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const members = (value: unknown, what: string): Record<string, unknown>[] => {
  if (value === undefined || value === null) return [];
  const table = record(value);
  if (!table) return fail(FORMAT, `${FORMAT}: "${what}" is not an object.`);
  const keys = Object.keys(table);
  if (keys.length > MAX_CHILDREN) fail(FORMAT, `${FORMAT}: "${what}" lists ${keys.length} items; the import limit is ${MAX_CHILDREN}.`, 'LIMIT_EXCEEDED');
  return keys.map(key => record(table[key]) ?? fail(FORMAT, `${FORMAT}: an item of "${what}" is not an object.`));
};
const pointArray = (value: unknown, what: string): Point[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return fail(FORMAT, `${FORMAT}: ${what} is not a list.`);
  if (value.length > 100_000) fail(FORMAT, `${FORMAT}: ${what} has more than 100000 points.`, 'LIMIT_EXCEEDED');
  return value.map(item => { const p = record(item); return { x: numeric(p?.x, `${what} x`, FORMAT), y: numeric(p?.y, `${what} y`, FORMAT) }; });
};
function padOfObject(item: Record<string, unknown>, where: string): StdPad {
  const shape = String(item.shape ?? '').trim().toUpperCase();
  if (!PAD_SHAPES.has(shape)) return fail(FORMAT, `${FORMAT}: ${where} has pad shape "${shape.slice(0, 20)}", which is not documented.`, 'UNSUPPORTED_VARIANT');
  const layer = layerOf(item.layerid, `${where} pad`);
  if (layer !== 1 && layer !== 2 && layer !== 11) fail(FORMAT, `${FORMAT}: ${where} pad is on layer ${layer}; only top (1), bottom (2) and multi-layer (11) pads are supported.`, 'UNSUPPORTED_VARIANT');
  return {
    shape, x: numeric(item.x, `${where} pad x`, FORMAT), y: numeric(item.y, `${where} pad y`, FORMAT), width: numericOr(item.width, 0, `${where} pad width`, FORMAT), height: numericOr(item.height, 0, `${where} pad height`, FORMAT),
    layer, net: String(item.net ?? '').trim(), number: String(item.number ?? '').trim(), points: pointArray(item.pointArr, `${where} pad points`), rotation: numericOr(item.rotation, 0, `${where} pad rotation`, FORMAT),
  };
}
function readObjectModel(root: Record<string, unknown>, doc: Document, budget: PointBudget): void {
  let pads = 0;
  for (const fp of members(root.FOOTPRINT, 'FOOTPRINT')) {
    if (doc.parts.length >= MAX_PARTS) fail(FORMAT, 'Board record count exceeds the import limit.', 'LIMIT_EXCEEDED');
    const head = record(fp.head) ?? {}, cpara = head.c_para;
    const part = newPart(numeric(head.x, 'footprint x', FORMAT), numeric(head.y, 'footprint y', FORMAT), numericOr(head.rotation, 0, 'footprint rotation', FORMAT), attributes(typeof cpara === 'string' ? cpara : ''));
    if (head.layerid !== undefined && head.layerid !== null && String(head.layerid) !== '') part.declaredSide = layerOf(head.layerid, 'a footprint') === 2 ? 'bottom' : 'top';
    for (const item of members(fp.PAD, 'FOOTPRINT PAD')) part.pads.push(padOfObject(item, 'a footprint'));
    for (const item of members(fp.TEXT, 'FOOTPRINT TEXT')) {
      if (String(item.type ?? '') === 'P') { silkSide(part, layerOf(item.layerid, 'a footprint text')); if (!part.designator) part.designator = String(item.text ?? '').trim(); }
    }
    for (const item of members(fp.TRACK, 'FOOTPRINT TRACK')) {
      const layer = layerOf(item.layerid, 'a footprint track');
      if (layer === 3 || layer === 4) { silkSide(part, layer); for (const p of pointArray(item.pointArr, 'track points')) grow(part.silk, p.x, p.y); } else if (layer === OUTLINE_LAYER) part.cutouts++;
    }
    for (const item of members(fp.ARC, 'FOOTPRINT ARC')) {
      const layer = layerOf(item.layerid, 'a footprint arc');
      if (layer === 3 || layer === 4) { silkSide(part, layer); for (const p of pathPoints(String(item.d ?? ''), budget)) grow(part.silk, p.x, p.y); } else if (layer === OUTLINE_LAYER) part.cutouts++;
    }
    for (const item of members(fp.RECT, 'FOOTPRINT RECT')) {
      const layer = layerOf(item.layerid, 'a footprint rectangle');
      if (layer === 3 || layer === 4) { const x = numeric(item.x, 'rectangle x', FORMAT), y = numeric(item.y, 'rectangle y', FORMAT); silkSide(part, layer); grow(part.silk, x, y); grow(part.silk, x + numeric(item.width, 'rectangle width', FORMAT), y + numeric(item.height, 'rectangle height', FORMAT)); } else if (layer === OUTLINE_LAYER) part.cutouts++;
    }
    for (const item of members(fp.CIRCLE, 'FOOTPRINT CIRCLE')) {
      const layer = layerOf(item.layerid, 'a footprint circle');
      if (layer === 3 || layer === 4) { const cx = numeric(item.cx ?? item.x, 'circle x', FORMAT), cy = numeric(item.cy ?? item.y, 'circle y', FORMAT), r = Math.abs(numeric(item.r, 'circle radius', FORMAT)); silkSide(part, layer); grow(part.silk, cx - r, cy - r); grow(part.silk, cx + r, cy + r); } else if (layer === OUTLINE_LAYER) part.cutouts++;
    }
    pads += part.pads.length;
    if (pads > MAX_PINS) fail(FORMAT, 'Board record count exceeds the import limit.', 'LIMIT_EXCEEDED');
    doc.parts.push(part);
  }
  for (const item of members(root.PAD, 'PAD')) { if (++pads > MAX_PINS) fail(FORMAT, 'Board record count exceeds the import limit.', 'LIMIT_EXCEEDED'); doc.freePads.push(padOfObject(item, 'a board')); }
  for (const item of members(root.TRACK, 'TRACK')) { if (layerOf(item.layerid, 'a track') === OUTLINE_LAYER) doc.outline.push({ kind: 'track', layer: OUTLINE_LAYER, points: pointArray(item.pointArr, 'outline track points') }); else count(doc.skipped, 'tracks'); }
  for (const item of members(root.ARC, 'ARC')) { if (layerOf(item.layerid, 'an arc') === OUTLINE_LAYER) doc.outline.push({ kind: 'arc', layer: OUTLINE_LAYER, path: String(item.d ?? '') }); else count(doc.skipped, 'arcs'); }
  for (const item of members(root.RECT, 'RECT')) {
    if (layerOf(item.layerid, 'a rectangle') === OUTLINE_LAYER) doc.outline.push({ kind: 'rect', layer: OUTLINE_LAYER, x: numeric(item.x, 'outline rectangle x', FORMAT), y: numeric(item.y, 'outline rectangle y', FORMAT), width: numeric(item.width, 'outline rectangle width', FORMAT), height: numeric(item.height, 'outline rectangle height', FORMAT) });
    else count(doc.skipped, 'circles and rectangles');
  }
  for (const item of members(root.CIRCLE, 'CIRCLE')) {
    if (layerOf(item.layerid, 'a circle') === OUTLINE_LAYER) doc.outline.push({ kind: 'circle', layer: OUTLINE_LAYER, x: numeric(item.cx ?? item.x, 'outline circle x', FORMAT), y: numeric(item.cy ?? item.y, 'outline circle y', FORMAT), r: Math.abs(numeric(item.r, 'outline circle radius', FORMAT)) });
    else count(doc.skipped, 'circles and rectangles');
  }
  const tally = (key: string, label: string) => { for (let n = members(root[key], key).length; n > 0; n--) count(doc.skipped, label); };
  tally('VIA', 'vias'); tally('HOLE', 'holes'); tally('COPPERAREA', 'copper areas'); tally('SOLIDREGION', 'copper areas'); tally('TEXT', 'text, dimensions and images');
}

// --- Board assembly ----------------------------------------------------------------------------------------------------------------------------
const flip = (p: Point): Point => ({ x: p.x, y: -p.y });
interface PinGeometry { shape: RawPin['shape']; width: number; height: number; radius: number; rotation: number; approximated: boolean }
/** Size, shape and orientation of one pad in canonical (Y-up, counter-clockwise) terms. */
function padGeometry(pad: StdPad): PinGeometry {
  const fieldRotation = normalizeAngle(-pad.rotation);
  if (pad.shape === 'RECT' && pad.points.length === 4) {
    const [p0, p1, p2] = pad.points, width = Math.hypot(p1.x - p0.x, p1.y - p0.y), height = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (width > 0 && height > 0) {
      const rotation = normalizeAngle(-Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180 / Math.PI);
      return { shape: Math.abs(width - height) < 1e-9 * Math.max(width, height) ? 'square' : 'rect', width, height, radius: Math.min(width, height) / 2, rotation: Math.abs(rotation - 360) < 1e-9 ? 0 : rotation, approximated: false };
    }
  }
  if (pad.shape === 'POLYGON') {
    const box = emptyBox();
    for (const p of pad.points) grow(box, p.x, p.y);
    if (!boxIsEmpty(box)) { const width = box.maxX - box.minX, height = box.maxY - box.minY; return { shape: 'rect', width, height, radius: Math.min(width, height) / 2, rotation: 0, approximated: true }; }
  }
  const width = Math.abs(pad.width), height = Math.abs(pad.height);
  const round = (pad.shape === 'ELLIPSE' || pad.shape === 'OVAL') && Math.abs(width - height) < 1e-9 * Math.max(width, height, 1);
  if (round) return { shape: 'round', width, height, radius: width / 2, rotation: fieldRotation, approximated: false };
  const oval = pad.shape === 'ELLIPSE' || pad.shape === 'OVAL';
  return { shape: pad.shape === 'RECT' && width === height ? 'square' : 'rect', width, height, radius: Math.min(width, height) / 2, rotation: fieldRotation, approximated: oval || pad.shape === 'POLYGON' };
}
const padSide = (layer: number): BoardSide => layer === 1 ? 'top' : layer === 2 ? 'bottom' : 'both';

function boardOf(doc: Document, input: ParseInput): Board {
  const parts: RawPart[] = [], pins: RawPin[] = [], warnings: ParseIssue[] = [];
  let approximated = 0, cutouts = false;
  doc.parts.forEach((source, index) => {
    const key = `lib:${index}`;
    let top = 0, bottom = 0;
    for (const pad of source.pads) { if (pad.layer === 1) top++; else if (pad.layer === 2) bottom++; }
    const side: BoardSide = source.declaredSide ?? (top !== bottom ? top > bottom ? 'top' : 'bottom' : source.silkTop !== source.silkBottom ? source.silkTop > source.silkBottom ? 'top' : 'bottom' : 'top');
    const box = { ...source.silk };
    const taken = new Set(source.pads.map(pad => pad.number));
    let spare = 0;
    for (const pad of source.pads) {
      const geometry = padGeometry(pad);
      if (geometry.approximated) approximated++;
      const reach = Math.max(geometry.width, geometry.height) / 2;
      grow(box, pad.x - reach, pad.y - reach); grow(box, pad.x + reach, pad.y + reach);
      let number = pad.number, generated = false;
      if (number === '') { let candidate: string; do candidate = `~${++spare}`; while (taken.has(candidate)); taken.add(candidate); number = candidate; generated = true; }
      pins.push({ part: key, number, ...generated ? { numberGenerated: true } : {}, name: number, net: pad.net, ...flip(pad), side: padSide(pad.layer), shape: geometry.shape,
        width: geometry.width, height: geometry.height, radius: geometry.radius, rotation: geometry.rotation });
    }
    if (source.cutouts) cutouts = true;
    const reference = source.designator || source.attrs.get('designator') || '';
    parts.push({ key, ref: reference || `FP${index + 1}`, ...reference ? {} : { refGenerated: true }, value: source.attrs.get('value') ?? source.attrs.get('bom_value') ?? '', package: source.attrs.get('package') ?? '',
      side, position: flip(source), rotation: normalizeAngle(-source.rotation), outline: boxIsEmpty(box) ? undefined : boxCorners(box).map(flip) });
  });
  let free = 0, unnetted = 0;
  for (const pad of doc.freePads) {
    if (!pad.net) { unnetted++; continue; }
    const key = `pad:${free++}`, geometry = padGeometry(pad);
    if (geometry.approximated) approximated++;
    const reach = Math.max(geometry.width, geometry.height) / 2, centre = flip(pad);
    parts.push({ key, ref: `PAD${free}`, refGenerated: true, value: '', package: '', side: pad.layer === 2 ? 'bottom' : 'top', position: centre,
      bounds: { minX: centre.x - reach, minY: centre.y - reach, maxX: centre.x + reach, maxY: centre.y + reach } });
    pins.push({ part: key, number: pad.number || '~1', ...pad.number ? {} : { numberGenerated: true }, name: pad.number || '~1', net: pad.net, ...flip(pad), side: padSide(pad.layer), shape: geometry.shape,
      width: geometry.width, height: geometry.height, radius: geometry.radius, rotation: geometry.rotation });
  }
  // Board outline: layer-10 tracks, arcs, rectangles and circles, stitched into closed loops.
  const budget = new PointBudget(FORMAT), segments: Array<[Point, Point]> = [];
  let arcs = 0;
  for (const item of doc.outline) {
    if (item.kind === 'track') segments.push(...edgesOf(item.points ?? []));
    else if (item.kind === 'arc') { const path = pathPoints(item.path ?? '', budget); if (path.length > 2) arcs++; segments.push(...edgesOf(path)); }
    else if (item.kind === 'circle') { arcs++; segments.push(...edgesOf(circlePoints({ x: item.x ?? 0, y: item.y ?? 0 }, item.r ?? 0, budget))); }
    else {
      const x = item.x ?? 0, y = item.y ?? 0, w = item.width ?? 0, h = item.height ?? 0;
      segments.push(...edgesOf([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }]));
    }
  }
  const flipped = segments.map(([a, b]): [Point, Point] => [flip(a), flip(b)]);
  const { loops, openChains } = stitchOutlines(flipped, OUTLINE_CLOSURE_MM / STD_UNIT_MM);
  if (flipped.length && !loops.length) warnings.push(note('EasyEDA board outline (layer 10) does not form a closed contour; an estimated boundary is shown.'));
  else if (openChains) warnings.push(note(`${openChains} open EasyEDA outline chain${openChains === 1 ? '' : 's'} (spurs, chords or gaps) are not part of a closed contour and were ignored.`));
  if (arcs && loops.length) warnings.push(note(`${arcs} EasyEDA outline arcs/circles were approximated by straight segments.`));
  if (cutouts) warnings.push({ key: 'parse.warning.boardCutouts' });
  if (approximated) warnings.push({ key: 'parse.warning.approximatedPads', params: { count: approximated } });
  if (unnetted) warnings.push(note(`${quantity(unnetted, 'free pad')} without a net (mounting pads and the like) ${unnetted === 1 ? 'was' : 'were'} not imported.`));
  const skipped = [...doc.skipped].map(([what, n]) => { const label = SKIPPED[what] ?? [what, what]; return quantity(n, label[0], label[1]); });
  if (skipped.length) warnings.push(note(`Not imported: ${skipped.join(', ')}. Nets come from component pads only.`));
  const raw: RawBoard = { format: FORMAT, unitsToMm: STD_UNIT_MM, parts, pins, outline: loops[0] ?? [], outlines: loops, warnings };
  return buildBoard(input, raw);
}

// --- Entry point -------------------------------------------------------------------------------------------------------------------------------
function unwrap(root: unknown): Record<string, unknown> {
  let value = root;
  for (let depth = 0; depth < 4; depth++) {
    const table = record(value);
    if (!table) break;
    if (Array.isArray(table.shape) || table.FOOTPRINT !== undefined || table.PAD !== undefined || table.TRACK !== undefined) return table;
    const inner = table.dataStr ?? table.result;
    if (typeof inner === 'string') {
      try { value = JSON.parse(inner); } catch { return fail(FORMAT, `${FORMAT}: the "dataStr" text is not valid JSON.`); }
    } else if (inner !== undefined) value = inner;
    else break;
  }
  return fail(FORMAT, `${FORMAT}: the JSON document has no shape array or object-model PCB sections.`);
}

export function parseEasyedaStd(input: ParseInput): Board | null {
  const sniff = sniffEasyedaStd(input.data, input.name);
  if (!sniff || sniff.confidence < 0.5) return null;
  if (sniff.kind === 'schematic' || sniff.kind === 'project' || sniff.kind === 'unsupported') return null;
  if (sniff.kind === 'footprint') throw new BoardFormatError('This is an EasyEDA Standard footprint document; it contains pads but no board placement.', 'WRONG_KIND', 'EasyEDA Standard footprint');
  const text = decodeText(input.data);
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) {
    if (error instanceof RangeError) throw new BoardFormatError(`${FORMAT}: JSON nesting exceeds the import limit.`, 'LIMIT_EXCEEDED', FORMAT);
    throw new BoardFormatError(`${FORMAT}: the document is not valid JSON.`, 'INVALID_FORMAT', FORMAT);
  }
  const root = unwrap(parsed);
  const head = root.head, type = typeof head === 'string' ? splitFields(head, '~', 2)[0] : String(record(head)?.docType ?? '');
  if (type === '4') throw new BoardFormatError('This is an EasyEDA Standard footprint document; it contains pads but no board placement.', 'WRONG_KIND', 'EasyEDA Standard footprint');
  if (type === '1' || type === '2') return null;
  const doc: Document = { parts: [], freePads: [], outline: [], skipped: new Map() }, budget = new PointBudget(FORMAT);
  if (Array.isArray(root.shape)) readShapeArray(root.shape, doc, budget); else readObjectModel(root, doc, budget);
  return boardOf(doc, input);
}
