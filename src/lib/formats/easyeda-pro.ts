/*
 * Original TRACE adapter (MIT). EasyEDA Pro PCB reader. Format reference: the official EasyEDA Pro file format V2 documentation
 * (github.com/easyeda/easyeda-file-format-v2: general/project-structure, general/file-header, pcb/*) and the V3 overview (prodocs.easyeda.com/en/format/).
 * No implementation source code was read or copied.
 *
 * Containers READ:
 *   .epro (also the project backups the client writes as .zip): a ZIP with project.json, PCB/<uuid>[.epcb] and FOOTPRINT/<uuid>[.efoo]; read with a bounded
 *       central-directory reader (easyeda-zip.ts). The first PCB document that has components is used and the others are disclosed.
 *   .epcb: one bare PCB document (no footprints, so components only; disclosed).
 * Document layout (format versions 1.x): one JSON array per line, the first element names the record:
 *   ["DOCTYPE","PCB","1.8"]  ["LAYER",n,"TOP"|"BOTTOM"|"OUTLINE"|"MULTI"|...,name,...]
 *   ["COMPONENT",id,group,layer,x,y,rotation,{props},locked]      a placed part (layer TOP or BOTTOM)
 *   ["ATTR",id,group,parentId,layer,x,y,key,value,...]            key Designator, Footprint (a FOOTPRINT uuid), Device, Value, Name of the part parentId
 *   ["PAD_NET",componentId,padNumber,net,footprintPadId?]         the net of one pad of one part
 *   ["LINE"|"ARC"|"CARC"|"POLY",id,group,net,layer,...]           outline items when the layer is OUTLINE
 *   ["PAD",id,group,net,layer,number,x,y,rotation,hole,shape,...] in FOOTPRINT documents (footprint-local) and as free pads of the board
 * Pad shapes read: ELLIPSE/ROUND (round), OVAL, RECT, NGON and POLY; polygons use the single-polygon modes L, ARC/CARC, C, R and CIRCLE.
 *
 * Coordinates are Y-up (library footprints named for a bottom-left pin 1 have pin 1 at negative x and y and number counter-clockwise), rotations are
 * counter-clockwise (vendor conventions chapter), and one unit is one mil (see PRO_UNIT_MM). A part is placed as: pad
 * point p, on the BOTTOM layer first mirrored (x -> -x), then rotated by the part's angle and moved to its position; a pad's own angle follows (bottom:
 * 180 - angle). Top-side placement was checked against real EasyEDA Pro project backups: every pad that has a same-net track or via end lies inside the
 * pad's rotated rectangle for all but one of more than 1,000 pads (the exception is a pad whose track ends beside it). The vendor documents do not say how a
 * BOTTOM component is mirrored or whether its angle is kept or negated, and the real files available hold bottom-side free pads only, so the bottom-side
 * transform above is the usual mirror-then-rotate convention and is UNVERIFIED; every import that has a bottom-side component says so.
 * Not read: tracks, vias, copper pours, text, panels, footprint pad overrides (disclosed), the V3 log format (rejected as unsupported) and the SQLite
 * project databases (.eprj/.elib), which are rejected with a hint to export an .epro.
 */
import type { Board, ParseIssue, Point } from '../types';
import { BoardFormatError, buildBoard, decodeText, stitchOutlines, type ParseInput, type RawBoard, type RawPart, type RawPin } from './common';
import {
  EASYEDA_PRO_FORMAT, MAX_PARTS, MAX_PINS, OUTLINE_CLOSURE_MM, PRO_UNIT_MM, PointBudget, arcBySweep, boxCorners, boxIsEmpty, circlePoints, edgesOf, emptyBox, fail, grow,
  headText, normalizeAngle, note, numeric, quantity, rotateAbout, type Box, type EasyedaKind, type EasyedaSniff,
} from './easyeda-common';
import { isZipSignature, openZip, type ZipArchive, type ZipEntry } from './easyeda-zip';

const FORMAT = EASYEDA_PRO_FORMAT;
const MAX_RECORDS = 3_000_000, MAX_LINE_CHARS = 16 * 1024 * 1024, MAX_POLYGON_ITEMS = 200_000, MAX_PROJECT_JSON = 16 * 1024 * 1024, MAX_FOOTPRINT_BYTES = 32 * 1024 * 1024;
const MAX_ATTRS_PER_PART = 256, MAX_ATTR_CHARS = 4096, BEZIER_STEPS = 32;

/** Static facts about the reader, for the registry that lists formats (the generated capability table is built from these). */
export const EASYEDA_PRO_INFO = {
  id: 'easyeda-pro', name: 'EasyEDA Pro PCB', extensions: ['.epro', '.epcb', '.zip'], variants: ['project archive (.epro, or the .zip backup the client writes: project.json + PCB/ + FOOTPRINT/, line-based JSON arrays, format 1.x)', 'bare PCB document (.epcb: components only, no pads)'],
  status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'mixed', units: 'mil (0.0254 mm); the vendor text says 0.01 inch, real files say mil',
  sides: 'COMPONENT layer TOP/BOTTOM (bottom parts are mirrored in x, unverified); pad layer MULTI is both',
  notes: [
    'Validated with real files: eight open-licence EasyEDA Pro projects (twelve .zip project backups plus the same projects exported from the offline .eprj databases); top-side pad positions agree with the routed tracks of the same nets.',
    'No real bottom-side component was available and the vendor documents are silent on the bottom mirror: the mirror-then-rotate convention is unverified and every import with a bottom-side part says so.',
    'Tracks, vias, copper pours and text are not read (nets come from the PAD_NET assignments); oval, polygon and n-gon pads are drawn as bounding rectangles and counted as approximated; footprint pad overrides are ignored and disclosed.',
    'Outline: OUTLINE-layer lines, arcs, polylines and circles stitched into the largest closed loop (arcs and curves are sampled); inner loops are disclosed as cutouts. A bare .epcb has no footprints, so it shows part positions only.',
    'The offline .eprj/.elib SQLite databases and the V3 log format are recognized and rejected with a hint (export an .epro); schematics and panels are not boards.',
  ],
} as const;

// --- Recognition ---------------------------------------------------------------------------------------------------------------------------------
const SNIFF_BYTES = 8192;
const SQLITE_MAGIC = 'SQLite format 3\0';
const DOC_KINDS: Record<string, EasyedaKind> = { PCB: 'pcb', FOOTPRINT: 'footprint', SCH: 'schematic', SCH_PAGE: 'schematic', SYMBOL: 'schematic', INSTANCE: 'schematic', PANEL: 'unsupported', POURED: 'unsupported' };
const headerOf = (text: string): { type: string; version: string } | undefined => {
  const match = /^\s*\[\s*"DOCTYPE"\s*,\s*"([A-Z_]{1,16})"\s*(?:,\s*"([0-9.]{1,12})")?\s*\]/.exec(text.slice(0, 256));
  return match ? { type: match[1], version: match[2] ?? '' } : undefined;
};

/**
 * Bounded look at the start of the file (and, for a ZIP, its central directory; nothing is inflated). 0.99: a document that opens with ["DOCTYPE","PCB"...];
 * 0.95: a ZIP holding project.json next to PCB/, SHEET/ or FOOTPRINT/ entries; 0.8: a ZIP with a bare PCB/ entry only; 0.9: the V3 log header and the EasyEDA
 * SQLite databases (both recognized but unsupported, kind "unsupported").
 */
export function sniffEasyedaPro(data: Uint8Array, name = ''): EasyedaSniff | null {
  if (data.length < 4) return null;
  if (isZipSignature(data)) {
    let archive: ZipArchive | null;
    try { archive = openZip(data, FORMAT); } catch { return null; }
    if (!archive) return null;
    const names = archive.entries.map(entry => entry.name.toLowerCase());
    const project = names.includes('project.json'), pcb = names.some(entry => /^pcb\/[^/]+$/.test(entry)), other = names.some(entry => /^(?:sheet|footprint|symbol)\//.test(entry));
    if (project && (pcb || other)) return { id: 'easyeda-pro', variant: 'epro-zip', kind: pcb ? 'pcb' : 'project', confidence: 0.95, reason: `ZIP with project.json${pcb ? ' and a PCB/ entry' : ' and schematic or library entries but no PCB/ entry'}` };
    if (pcb && names.some(entry => /^pcb\/[^/]+\.epcb$/.test(entry))) return { id: 'easyeda-pro', variant: 'epro-zip', kind: 'pcb', confidence: 0.8, reason: 'ZIP with a PCB/*.epcb entry and no project.json' };
    return null;
  }
  const head = asciiHead(data, SNIFF_BYTES);
  if (head.startsWith(SQLITE_MAGIC)) {
    if (head.includes('CREATE TABLE "documents"') && head.includes('"docType"') || head.includes('CREATE TABLE "projects"') && head.includes('"cbb_project"')) return { id: 'easyeda-pro', variant: 'eprj-sqlite', kind: 'unsupported', confidence: 0.9, reason: 'SQLite database with the EasyEDA Pro offline-project tables' };
    return null;
  }
  const text = headText(data, SNIFF_BYTES), header = headerOf(text);
  if (header) {
    const kind = DOC_KINDS[header.type];
    return kind ? { id: 'easyeda-pro', variant: 'epcb', kind, confidence: 0.99, reason: `["DOCTYPE","${header.type}"${header.version ? `,"${header.version}"` : ''}] header${/\.epcb$/i.test(name) ? ', .epcb name' : ''}` } : null;
  }
  const first = /^\s*\{\s*"type"\s*:\s*"DOCHEAD"\s*\}\s*\|\|/.exec(text);
  if (first) return { id: 'easyeda-pro', variant: 'log-v3', kind: 'unsupported', confidence: 0.9, reason: 'DOCHEAD||{...} log header (EasyEDA Pro V3 project log)' };
  return null;
}
const asciiHead = (data: Uint8Array, length: number): string => {
  let text = '';
  for (let index = 0; index < Math.min(data.length, length); index++) text += String.fromCharCode(data[index]);
  return text;
};

// --- Line scanner --------------------------------------------------------------------------------------------------------------------------------
const isBlank = (code: number): boolean => code === 32 || code === 9 || code === 13 || code === 0xfeff || code === 0xa0;
/**
 * Visits the lines of one document in order. Every line must look like a JSON array (starts with "[" and ends with "]"), but only lines whose first
 * element is in `wanted` are parsed; all other lines (rules, fonts, images, copper pour results, ...) are skipped after that check. Linear in the text.
 */
function scanRecords(text: string, wanted: ReadonlySet<string>, onRecord: (name: string, record: unknown[], line: number) => void, label: string): void {
  const n = text.length;
  let line = 0, start = 0, count = 0;
  while (start <= n) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = n;
    line++;
    let a = start, b = end;
    while (a < b && isBlank(text.charCodeAt(a))) a++;
    while (b > a && isBlank(text.charCodeAt(b - 1))) b--;
    if (b > a) {
      if (++count > MAX_RECORDS) fail(FORMAT, `${FORMAT}: the ${label} has more than ${MAX_RECORDS} records.`, 'LIMIT_EXCEEDED');
      if (text.charCodeAt(a) !== 91 || text.charCodeAt(b - 1) !== 93) fail(FORMAT, `${FORMAT}: line ${line} of the ${label} is not a JSON array.`);
      let name = '';
      if (text.charCodeAt(a + 1) === 34) {
        for (let q = a + 2; q < b && q < a + 2 + 48; q++) { if (text.charCodeAt(q) === 34) { name = text.slice(a + 2, q); break; } }
      }
      if (wanted.has(name)) {
        if (b - a > MAX_LINE_CHARS) fail(FORMAT, `${FORMAT}: line ${line} of the ${label} is longer than ${MAX_LINE_CHARS} characters.`, 'LIMIT_EXCEEDED');
        let value: unknown;
        try { value = JSON.parse(text.slice(a, b)); }
        catch (error) {
          if (error instanceof RangeError) fail(FORMAT, `${FORMAT}: line ${line} of the ${label} nests deeper than the import limit.`, 'LIMIT_EXCEEDED');
          fail(FORMAT, `${FORMAT}: line ${line} of the ${label} is not valid JSON.`);
        }
        if (!Array.isArray(value)) fail(FORMAT, `${FORMAT}: line ${line} of the ${label} is not a JSON array.`);
        onRecord(name, value as unknown[], line);
      }
    }
    start = end + 1;
  }
}

// --- Polygons ------------------------------------------------------------------------------------------------------------------------------------
const num = (value: unknown, label: string): number => numeric(value, label, FORMAT);
/** One single polygon (documented modes L, ARC/CARC, C, R, CIRCLE) as a polyline in source units. Closed shapes (R, CIRCLE) repeat their first point. */
function singlePolygon(path: unknown[], budget: PointBudget): Point[] {
  if (path.length > MAX_POLYGON_ITEMS) fail(FORMAT, `${FORMAT}: a polygon has more than ${MAX_POLYGON_ITEMS} elements.`, 'LIMIT_EXCEEDED');
  if (path[0] === 'R') {
    const x = num(path[1], 'rectangle x'), y = num(path[2], 'rectangle y'), w = num(path[3], 'rectangle width'), h = num(path[4], 'rectangle height'), rot = path[5] === undefined || path[5] === null ? 0 : num(path[5], 'rectangle rotation');
    // "X/Y: top-left coordinate" on a Y-up plane, so the rectangle extends right and down; the rotation turns it about that corner.
    const corners = [{ x, y }, { x: x + w, y }, { x: x + w, y: y - h }, { x, y: y - h }, { x, y }];
    return rot ? corners.map(corner => rotateAbout(corner, { x, y }, rot)) : corners;
  }
  if (path[0] === 'CIRCLE') return circlePoints({ x: num(path[1], 'circle x'), y: num(path[2], 'circle y') }, Math.abs(num(path[3], 'circle radius')), budget);
  if (path.length < 2 || typeof path[0] === 'string') return fail(FORMAT, `${FORMAT}: a polygon does not start with a coordinate pair.`);
  const points: Point[] = [{ x: num(path[0], 'polygon x'), y: num(path[1], 'polygon y') }];
  let mode = 'L', i = 2;
  const take = (count: number, what: string): number[] => {
    const values: number[] = [];
    for (let k = 0; k < count; k++) { const item = path[i++]; if (typeof item === 'string' || item === undefined) return fail(FORMAT, `${FORMAT}: a polygon is cut short (${what}).`); values.push(num(item, `polygon ${what}`)); }
    return values;
  };
  while (i < path.length) {
    const item = path[i];
    if (typeof item === 'string') {
      mode = item.toUpperCase(); i++;
      if (mode !== 'L' && mode !== 'ARC' && mode !== 'CARC' && mode !== 'C') return fail(FORMAT, `${FORMAT}: a polygon uses the "${item.slice(0, 12)}" mode, which is not documented.`, 'UNSUPPORTED_VARIANT');
      continue;
    }
    const last = points[points.length - 1];
    if (mode === 'L') { const [x, y] = take(2, 'x and y'); points.push({ x, y }); }
    else if (mode === 'ARC' || mode === 'CARC') { const [angle, x, y] = take(3, 'arc'); points.push(...arcBySweep(last, { x, y }, angle, budget).slice(1)); }
    else {
      const [x2, y2, x3, y3, x4, y4] = take(6, 'curve');
      budget.take(BEZIER_STEPS);
      for (let step = 1; step <= BEZIER_STEPS; step++) {
        const t = step / BEZIER_STEPS, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        points.push({ x: a * last.x + b * x2 + c * x3 + d * x4, y: a * last.y + b * y2 + c * y3 + d * y4 });
      }
    }
  }
  return points;
}
/** A single polygon or a complex polygon (a list of single polygons) as polylines. */
function polygons(value: unknown, budget: PointBudget): Point[][] {
  if (!Array.isArray(value)) return fail(FORMAT, `${FORMAT}: a polygon is not a list.`);
  if (!value.length) return [];
  if (Array.isArray(value[0])) return value.map(single => { if (!Array.isArray(single)) return fail(FORMAT, `${FORMAT}: a complex polygon holds a non-list.`); return singlePolygon(single, budget); });
  return [singlePolygon(value, budget)];
}

// --- Footprints ----------------------------------------------------------------------------------------------------------------------------------
const DEFAULT_LAYER_TYPES: Record<number, string> = { 1: 'TOP', 2: 'BOTTOM', 3: 'TOP_SILK', 4: 'BOT_SILK', 9: 'TOP_ASSEMBLY', 10: 'BOT_ASSEMBLY', 11: 'OUTLINE', 12: 'MULTI' };
class LayerTable {
  private readonly types = new Map<number, string>();
  set(id: number, type: string) { this.types.set(id, type); }
  get explicit() { return this.types.size > 0; }
  typeOf(id: number): string { return this.types.get(id) ?? (this.types.size ? '' : DEFAULT_LAYER_TYPES[id] ?? ''); }
}
function layerNumber(value: unknown, label: string): number {
  const id = num(value, `${label} layer`);
  if (!Number.isInteger(id) || id < 0) fail(FORMAT, `${FORMAT}: ${label} has an invalid layer number.`);
  return id;
}
interface ProPad { id: string; number: string; x: number; y: number; angle: number; kind: string; width: number; height: number; layer: string; spreadsPolygon: boolean }
interface Footprint { pads: ProPad[]; body: Box; cutouts: boolean }
const PAD_KINDS = new Set(['ELLIPSE', 'ROUND', 'OVAL', 'RECT', 'NGON', 'POLY']);

/** Pad geometry from a PAD record (footprint-local or board level). `shape` is the default pad definition; a hole-only pad falls back to the hole size. */
function readPad(record: unknown[], layers: LayerTable, budget: PointBudget, where: string): ProPad {
  const layerId = layerNumber(record[4], `${where} pad`), layer = layers.typeOf(layerId);
  if (layer !== 'TOP' && layer !== 'BOTTOM' && layer !== 'MULTI') fail(FORMAT, `${FORMAT}: ${where} pad is on layer ${layerId} (${layer || 'unknown'}); only TOP, BOTTOM and MULTI pads are supported.`, 'UNSUPPORTED_VARIANT');
  const x = num(record[6], `${where} pad x`), y = num(record[7], `${where} pad y`), angle = record[8] === undefined || record[8] === null ? 0 : num(record[8], `${where} pad angle`);
  let shape = record[10];
  if (!Array.isArray(shape) || typeof shape[0] !== 'string') {
    const hole = record[9];
    if (Array.isArray(hole) && typeof hole[0] === 'string') shape = ['ROUND', hole[1], hole[2] ?? hole[1]];
    else return fail(FORMAT, `${FORMAT}: ${where} pad has no shape definition.`, 'UNSUPPORTED_VARIANT');
  }
  const kind = String((shape as unknown[])[0]).toUpperCase();
  if (!PAD_KINDS.has(kind)) return fail(FORMAT, `${FORMAT}: ${where} pad has shape "${kind.slice(0, 20)}", which is not documented.`, 'UNSUPPORTED_VARIANT');
  const definition = shape as unknown[];
  let width = 0, height = 0, center = { x, y }, spreadsPolygon = false;
  if (kind === 'POLY') {
    const box = emptyBox();
    for (const loop of polygons(definition[1], budget)) for (const p of loop) grow(box, p.x, p.y);
    if (boxIsEmpty(box)) fail(FORMAT, `${FORMAT}: ${where} pad has an empty polygon.`);
    width = box.maxX - box.minX; height = box.maxY - box.minY; center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }; spreadsPolygon = true;
  } else if (kind === 'NGON') { width = height = Math.abs(num(definition[1], `${where} pad diameter`)); }
  else { width = Math.abs(num(definition[1], `${where} pad width`)); height = Math.abs(definition[2] === undefined || definition[2] === null ? width : num(definition[2], `${where} pad height`)); if (kind === 'RECT' && definition[2] === undefined) height = width; }
  return { id: typeof record[1] === 'string' ? record[1] : String(record[1] ?? ''), number: record[5] === undefined || record[5] === null ? '' : String(record[5]).trim(), x: center.x, y: center.y, angle, kind, width, height, layer, spreadsPolygon };
}

/** A FOOTPRINT document: its pads and the bounding box of its body drawing (assembly layer if used, otherwise silkscreen). */
function readFootprint(text: string, budget: PointBudget): Footprint {
  const layers = new LayerTable(), pads: ProPad[] = [], assembly = emptyBox(), silk = emptyBox();
  let cutouts = false, first = true;
  const grown = (box: Box, points: Point[]) => { for (const p of points) grow(box, p.x, p.y); };
  scanRecords(text, new Set(['DOCTYPE', 'LAYER', 'PAD', 'LINE', 'ARC', 'CARC', 'POLY', 'FILL']), (name, record) => {
    if (first) {
      first = false;
      if (name !== 'DOCTYPE') fail(FORMAT, `${FORMAT}: a footprint document does not start with DOCTYPE.`);
      if (record[1] !== 'FOOTPRINT') fail(FORMAT, `${FORMAT}: a footprint document is of type "${String(record[1]).slice(0, 20)}".`);
      return;
    }
    if (name === 'LAYER') { layers.set(layerNumber(record[1], 'a footprint LAYER'), String(record[2])); return; }
    if (name === 'PAD') { pads.push(readPad(record, layers, budget, 'a footprint')); return; }
    const layer = layers.typeOf(layerNumber(record[4], `a footprint ${name}`));
    if (layer === 'OUTLINE') { cutouts = true; return; }
    const target = layer === 'TOP_ASSEMBLY' ? assembly : layer === 'TOP_SILK' ? silk : undefined;
    if (!target) return;
    if (name === 'LINE') grown(target, [{ x: num(record[5], 'footprint line x'), y: num(record[6], 'footprint line y') }, { x: num(record[7], 'footprint line x'), y: num(record[8], 'footprint line y') }]);
    else if (name === 'ARC' || name === 'CARC') grown(target, arcBySweep({ x: num(record[5], 'footprint arc x'), y: num(record[6], 'footprint arc y') }, { x: num(record[7], 'footprint arc x'), y: num(record[8], 'footprint arc y') }, num(record[9], 'footprint arc angle'), budget));
    else if (name === 'POLY') for (const loop of polygons(record[6], budget)) grown(target, loop);
    else for (const loop of polygons(record[7], budget)) grown(target, loop);
  }, 'footprint document');
  if (first) fail(FORMAT, `${FORMAT}: a footprint document is empty.`);
  return { pads, body: boxIsEmpty(assembly) ? silk : assembly, cutouts };
}

// --- PCB document --------------------------------------------------------------------------------------------------------------------------------
interface ProComponent { id: string; layer: number; x: number; y: number; angle: number }
interface PadNets { byId: Map<string, string>; byNumber: Map<string, string> }
interface PcbDocument {
  layers: LayerTable; components: ProComponent[]; attrs: Map<string, Map<string, string>>; padNets: Map<string, PadNets>; freePads: unknown[][]; overrides: number;
  outline: unknown[][]; conflicts: number; version: string;
}
const OVERRIDE_ID = /^[a-z]+\d+[a-z]+\d+$/i;
const PCB_RECORDS = new Set(['DOCTYPE', 'LAYER', 'COMPONENT', 'ATTR', 'PAD_NET', 'PAD', 'LINE', 'ARC', 'CARC', 'POLY']);

function readPcb(text: string): PcbDocument {
  const doc: PcbDocument = { layers: new LayerTable(), components: [], attrs: new Map(), padNets: new Map(), freePads: [], overrides: 0, outline: [], conflicts: 0, version: '' };
  const ids = new Set<string>();
  let first = true, padNets = 0;
  scanRecords(text, PCB_RECORDS, (name, record) => {
    if (first) {
      first = false;
      if (name !== 'DOCTYPE') fail(FORMAT, `${FORMAT}: the PCB document does not start with DOCTYPE.`);
      if (record[1] !== 'PCB') fail(FORMAT, `${FORMAT}: the document is of type "${String(record[1]).slice(0, 20)}", not PCB.`, record[1] === 'FOOTPRINT' ? 'WRONG_KIND' : 'INVALID_FORMAT');
      doc.version = String(record[2] ?? '');
      if (doc.version && !/^1(?:\.|$)/.test(doc.version)) fail(FORMAT, `${FORMAT}: PCB format version ${doc.version.slice(0, 12)} is not supported; versions 1.x are documented.`, 'UNSUPPORTED_VARIANT');
      return;
    }
    switch (name) {
      case 'LAYER': doc.layers.set(layerNumber(record[1], 'a LAYER'), String(record[2])); break;
      case 'COMPONENT': {
        if (typeof record[1] !== 'string' || !record[1]) fail(FORMAT, `${FORMAT}: a COMPONENT has no id.`);
        const id = record[1] as string;
        if (ids.has(id)) fail(FORMAT, `${FORMAT}: the document places component "${id.slice(0, 40)}" twice.`);
        if (doc.components.length >= MAX_PARTS) fail(FORMAT, 'Board record count exceeds the import limit.', 'LIMIT_EXCEEDED');
        ids.add(id);
        doc.components.push({ id, layer: layerNumber(record[3], 'a COMPONENT'), x: num(record[4], 'component x'), y: num(record[5], 'component y'), angle: record[6] === undefined || record[6] === null ? 0 : num(record[6], 'component angle') });
        break;
      }
      case 'ATTR': {
        const parent = record[3], key = record[7], value = record[8];
        if (typeof parent !== 'string' || !parent || typeof key !== 'string' || !key || key.length > 256 || (typeof value !== 'string' && typeof value !== 'number') || String(value).length > MAX_ATTR_CHARS) break;
        let map = doc.attrs.get(parent);
        if (!map) { map = new Map(); doc.attrs.set(parent, map); }
        if (map.size < MAX_ATTRS_PER_PART && !map.has(key)) map.set(key, String(value));
        break;
      }
      case 'PAD_NET': {
        if (typeof record[1] !== 'string' || (typeof record[2] !== 'string' && typeof record[2] !== 'number') || typeof record[3] !== 'string') fail(FORMAT, `${FORMAT}: a PAD_NET record is malformed.`);
        if (++padNets > MAX_PINS) fail(FORMAT, 'Board record count exceeds the import limit.', 'LIMIT_EXCEEDED');
        let nets = doc.padNets.get(record[1] as string);
        if (!nets) { nets = { byId: new Map(), byNumber: new Map() }; doc.padNets.set(record[1] as string, nets); }
        const number = String(record[2]).trim(), net = record[3] as string, padId = typeof record[4] === 'string' ? record[4] : '';
        const table = padId ? nets.byId : nets.byNumber, key = padId || number, prior = table.get(key);
        if (prior === undefined) table.set(key, net); else if (prior !== net) doc.conflicts++;
        if (padId && !nets.byNumber.has(number)) nets.byNumber.set(number, net);
        break;
      }
      case 'PAD': {
        const id = typeof record[1] === 'string' ? record[1] : '';
        if (OVERRIDE_ID.test(id.slice(0, 64))) doc.overrides++;
        else if (doc.freePads.length < MAX_PINS) doc.freePads.push(record);
        break;
      }
      default: if (doc.layers.typeOf(layerNumber(record[4], `a ${name}`)) === 'OUTLINE') doc.outline.push(record);
    }
  }, 'PCB document');
  if (first) fail(FORMAT, `${FORMAT}: the PCB document is empty.`);
  return doc;
}

interface Project { footprints: Map<string, string>; devices: Map<string, string>; pcbOrder: string[] }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function readProject(text: string): Project {
  let json: unknown;
  try { json = JSON.parse(text); } catch (error) { return fail(FORMAT, error instanceof RangeError ? `${FORMAT}: project.json nests deeper than the import limit.` : `${FORMAT}: project.json is not valid JSON.`, error instanceof RangeError ? 'LIMIT_EXCEEDED' : 'INVALID_FORMAT'); }
  if (!isRecord(json)) return fail(FORMAT, `${FORMAT}: project.json is not an object.`);
  const project: Project = { footprints: new Map(), devices: new Map(), pcbOrder: [] };
  if (isRecord(json.footprints)) for (const [uuid, value] of Object.entries(json.footprints)) if (isRecord(value) && typeof value.title === 'string') project.footprints.set(uuid, value.title);
  if (isRecord(json.devices)) for (const [uuid, value] of Object.entries(json.devices)) {
    const attributes = isRecord(value) && isRecord(value.attributes) ? value.attributes : undefined;
    if (attributes && typeof attributes.Footprint === 'string') project.devices.set(uuid, attributes.Footprint);
  }
  if (isRecord(json.pcbs)) project.pcbOrder = Object.keys(json.pcbs);
  return project;
}

// --- Board assembly --------------------------------------------------------------------------------------------------------------------------
const base = (name: string): string => { const leaf = name.slice(name.lastIndexOf('/') + 1); const dot = leaf.lastIndexOf('.'); return dot > 0 ? leaf.slice(0, dot) : leaf; };
const TEMPLATE = /^=\{([^{}]{1,80})\}$/;
/** An attribute value; "={Other Key}" templates (the client writes them for Name and Value) are resolved against the same part, one level deep. */
function attribute(attrs: Map<string, string> | undefined, key: string): string {
  const raw = attrs?.get(key)?.trim() ?? '';
  const match = TEMPLATE.exec(raw);
  if (!match) return raw;
  const target = attrs?.get(match[1])?.trim() ?? '';
  return TEMPLATE.test(target) ? '' : target;
}
interface Resolved { footprint: Footprint | undefined; title: string }

function boardOf(doc: PcbDocument, project: Project | undefined, footprintText: (uuid: string) => string | undefined, input: ParseInput, extra: ParseIssue[]): Board {
  const budget = new PointBudget(FORMAT), cache = new Map<string, Footprint | null>();
  const footprintOf = (uuid: string): Footprint | undefined => {
    if (!uuid) return undefined;
    let cached = cache.get(uuid);
    if (cached === undefined) { const text = footprintText(uuid); cached = text === undefined ? null : readFootprint(text, budget); cache.set(uuid, cached); }
    return cached ?? undefined;
  };
  // Resolve every part first and sum the pads BEFORE any pin exists: the output grows as pads x parts.
  const resolved: Resolved[] = [];
  let planned = 0, unresolved = 0;
  for (const component of doc.components) {
    const attrs = doc.attrs.get(component.id);
    const uuid = attrs?.get('Footprint') || project?.devices.get(attrs?.get('Device') ?? '') || '';
    const footprint = footprintOf(uuid);
    if (!footprint) unresolved++;
    else planned += footprint.pads.length;
    if (planned > MAX_PINS) fail(FORMAT, `${FORMAT}: the board expands to more than ${MAX_PINS} pins; the import limit is ${MAX_PINS}.`, 'LIMIT_EXCEEDED');
    resolved.push({ footprint, title: project?.footprints.get(uuid) ?? '' });
  }
  const parts: RawPart[] = [], pins: RawPin[] = [], warnings: ParseIssue[] = [...extra];
  let approximated = 0, cutouts = false, unnetted = 0, orphanNets = 0, mirrored = 0;
  const geometry = (pad: ProPad, bottom: boolean, theta: number): Pick<RawPin, 'shape' | 'width' | 'height' | 'radius' | 'rotation'> & { approx: boolean } => {
    const circular = pad.kind === 'ELLIPSE' || pad.kind === 'ROUND' || pad.kind === 'OVAL' || pad.kind === 'NGON';
    const round = circular && Math.abs(pad.width - pad.height) < 1e-9 * Math.max(pad.width, pad.height, 1);
    const approx = pad.kind === 'NGON' || pad.kind === 'POLY' || circular && !round;
    // A polygon is stored in footprint coordinates already, so only the part's turn applies to it; other pads also carry their own angle.
    const rotation = pad.spreadsPolygon ? theta : bottom ? theta + 180 - pad.angle : theta + pad.angle;
    return { shape: round ? 'round' : pad.width === pad.height ? 'square' : 'rect', width: pad.width, height: pad.height, radius: Math.min(pad.width, pad.height) / 2, rotation: normalizeAngle(rotation), approx };
  };
  doc.components.forEach((component, index) => {
    const attrs = doc.attrs.get(component.id), { footprint, title } = resolved[index], key = component.id;
    const bottom = doc.layers.typeOf(component.layer) === 'BOTTOM', theta = component.angle, origin = { x: component.x, y: component.y };
    const place = (p: Point): Point => { const turned = rotateAbout({ x: bottom ? -p.x : p.x, y: p.y }, { x: 0, y: 0 }, theta); return { x: origin.x + turned.x, y: origin.y + turned.y }; };
    const reference = attribute(attrs, 'Designator'), value = attribute(attrs, 'Value') || attribute(attrs, 'Name');
    let outline: Point[] | undefined;
    if (footprint) {
      if (bottom && footprint.pads.length) mirrored++;
      const nets = doc.padNets.get(component.id), box = { ...footprint.body }, taken = new Set(footprint.pads.map(pad => pad.number));
      let spare = 0;
      if (footprint.cutouts) cutouts = true;
      for (const pad of footprint.pads) {
        const g = geometry(pad, bottom, theta);
        if (g.approx) approximated++;
        const reach = Math.max(pad.width, pad.height) / 2;
        grow(box, pad.x - reach, pad.y - reach); grow(box, pad.x + reach, pad.y + reach);
        let number = pad.number, generated = false;
        if (number === '') { let candidate: string; do candidate = `~${++spare}`; while (taken.has(candidate)); taken.add(candidate); number = candidate; generated = true; }
        // The assignment of the pad's own id wins (even an empty net); the pad number is the fallback for files that list numbers only.
        const net = pad.id && nets?.byId.has(pad.id) ? nets.byId.get(pad.id) ?? '' : generated ? '' : nets?.byNumber.get(number) ?? '';
        pins.push({ part: key, number, ...generated ? { numberGenerated: true } : {}, name: number, net, ...place(pad), side: pad.layer === 'MULTI' ? 'both' : (pad.layer === 'TOP') !== bottom ? 'top' : 'bottom',
          shape: g.shape, width: g.width, height: g.height, radius: g.radius, rotation: g.rotation });
      }
      if (!boxIsEmpty(box)) outline = boxCorners(box).map(place);
    } else orphanNets += doc.padNets.get(component.id)?.byNumber.size ?? 0;
    parts.push({ key, ref: reference || `FP${index + 1}`, ...reference ? {} : { refGenerated: true }, value, package: title, side: bottom ? 'bottom' : 'top',
      position: origin, rotation: normalizeAngle(theta), outline });
  });
  // Free pads of the board (test points, castellations): one part each, only when the pad carries a net.
  let free = 0;
  for (const record of doc.freePads) {
    const net = typeof record[3] === 'string' ? record[3].trim() : '';
    if (!net) { unnetted++; continue; }
    const pad = readPad(record, doc.layers, budget, 'a board'), g = geometry(pad, false, 0), key = `free:${free++}`;
    if (g.approx) approximated++;
    const reach = Math.max(pad.width, pad.height) / 2;
    parts.push({ key, ref: `PAD${free}`, refGenerated: true, value: '', package: '', side: pad.layer === 'BOTTOM' ? 'bottom' : 'top', position: { x: pad.x, y: pad.y },
      bounds: { minX: pad.x - reach, minY: pad.y - reach, maxX: pad.x + reach, maxY: pad.y + reach } });
    pins.push({ part: key, number: pad.number || '~1', ...pad.number ? {} : { numberGenerated: true }, name: pad.number || '~1', net, x: pad.x, y: pad.y, side: pad.layer === 'MULTI' ? 'both' : pad.layer === 'BOTTOM' ? 'bottom' : 'top',
      shape: g.shape, width: g.width, height: g.height, radius: g.radius, rotation: g.rotation });
  }
  // Board outline: OUTLINE-layer lines, arcs and polylines, stitched into closed loops.
  const segments: Array<[Point, Point]> = [];
  let arcs = 0;
  for (const record of doc.outline) {
    const name = record[0];
    if (name === 'LINE') segments.push([{ x: num(record[5], 'outline line x'), y: num(record[6], 'outline line y') }, { x: num(record[7], 'outline line x'), y: num(record[8], 'outline line y') }]);
    else if (name === 'ARC' || name === 'CARC') {
      const path = arcBySweep({ x: num(record[5], 'outline arc x'), y: num(record[6], 'outline arc y') }, { x: num(record[7], 'outline arc x'), y: num(record[8], 'outline arc y') }, num(record[9], 'outline arc angle'), budget);
      if (path.length > 2) arcs++;
      segments.push(...edgesOf(path));
    } else {
      const curved = Array.isArray(record[6]) && record[6].some(item => item === 'ARC' || item === 'CARC' || item === 'C' || item === 'CIRCLE');
      for (const loop of polygons(record[6], budget)) { if (curved) arcs++; segments.push(...edgesOf(loop)); }
    }
  }
  const { loops, openChains } = stitchOutlines(segments, OUTLINE_CLOSURE_MM / PRO_UNIT_MM);
  if (segments.length && !loops.length) warnings.push(note('EasyEDA board outline (OUTLINE layer) does not form a closed contour; an estimated boundary is shown.'));
  else if (openChains) warnings.push(note(`${openChains} open EasyEDA outline chain${openChains === 1 ? '' : 's'} (spurs, chords or gaps) are not part of a closed contour and were ignored.`));
  if (arcs && loops.length) warnings.push(note(`${arcs} EasyEDA outline arcs/curves/circles were approximated by straight segments.`));
  if (cutouts) warnings.push({ key: 'parse.warning.boardCutouts' });
  if (approximated) warnings.push({ key: 'parse.warning.approximatedPads', params: { count: approximated } });
  if (mirrored) warnings.push(note(`${quantity(mirrored, 'bottom-side component')} ${mirrored === 1 ? 'is' : 'are'} placed mirrored and rotated by the usual convention, which the EasyEDA Pro documents do not state and no real file has confirmed; check the pad positions of ${mirrored === 1 ? 'that part' : 'those parts'} before probing.`));
  if (unresolved) warnings.push(note(`${quantity(unresolved, 'component')} ${unresolved === 1 ? 'has' : 'have'} no footprint in the file, so ${unresolved === 1 ? 'it has' : 'they have'} no pads${orphanNets ? ` (${quantity(orphanNets, 'pad-net assignment')} could not be placed)` : ''}.`));
  if (unnetted) warnings.push(note(`${quantity(unnetted, 'free pad')} without a net (mounting pads and the like) ${unnetted === 1 ? 'was' : 'were'} not imported.`));
  if (doc.overrides) warnings.push(note(`${quantity(doc.overrides, 'footprint pad override')} ${doc.overrides === 1 ? 'was' : 'were'} ignored.`));
  if (doc.conflicts) warnings.push(note(`${quantity(doc.conflicts, 'pad net assignment')} conflicted with earlier ones; the first was kept.`));
  warnings.push(note('Tracks, vias, copper pours and text are not imported; nets come from the part pad assignments only.'));
  const raw: RawBoard = { format: FORMAT, unitsToMm: PRO_UNIT_MM, parts, pins, outline: loops[0] ?? [], outlines: loops, warnings };
  return buildBoard(input, raw);
}

// --- Containers --------------------------------------------------------------------------------------------------------------------------------
const textOf = (archive: ZipArchive, entry: ZipEntry, limit: number): string => decodeText(archive.read(entry, limit));

function fromArchive(data: Uint8Array, input: ParseInput): Board {
  const archive = openZip(data, FORMAT);
  if (!archive) throw new BoardFormatError(`${FORMAT}: the file is not a readable ZIP archive.`, 'INVALID_FORMAT', FORMAT);
  const entries = archive.entries, lower = (entry: ZipEntry) => entry.name.toLowerCase();
  const projectEntry = entries.find(entry => lower(entry) === 'project.json');
  const project = projectEntry ? readProject(textOf(archive, projectEntry, MAX_PROJECT_JSON)) : undefined;
  let pcbEntries = entries.filter(entry => /^pcb\/[^/]+$/i.test(entry.name));
  if (project?.pcbOrder.length) {
    const order = new Map(project.pcbOrder.map((uuid, index) => [uuid.toLowerCase(), index]));
    pcbEntries = [...pcbEntries].sort((a, b) => (order.get(base(a.name).toLowerCase()) ?? Infinity) - (order.get(base(b.name).toLowerCase()) ?? Infinity));
  }
  if (!pcbEntries.length) throw new BoardFormatError('This EasyEDA Pro project has no PCB document (it holds schematics and libraries only).', 'WRONG_KIND', FORMAT);
  // The first PCB that has parts; an empty PCB document is a few bytes long.
  let chosen = '', fallback: string | undefined;
  for (const entry of pcbEntries) {
    if (entry.size < 16) continue;
    const text = textOf(archive, entry, 96 * 1024 * 1024);
    if (/^\s*\{\s*"type"\s*:\s*"DOCHEAD"/.test(text.slice(0, 64))) throw new BoardFormatError('This EasyEDA Pro project uses the V3 log format, which is not supported.', 'UNSUPPORTED_VARIANT', FORMAT);
    if (text.includes('["COMPONENT"')) { chosen = text; break; }
    fallback ??= text;
  }
  chosen ||= fallback ?? '';
  if (!chosen) throw new BoardFormatError(`${FORMAT}: every PCB document in the project is empty.`, 'INVALID_FORMAT', FORMAT);
  const extra: ParseIssue[] = [];
  if (pcbEntries.length > 1) extra.push(note(`The project has ${pcbEntries.length} PCB documents; the first one with components was opened and the others were not.`));
  const footprintEntries = new Map<string, ZipEntry>();
  for (const entry of entries) if (/^footprint\/[^/]+$/i.test(entry.name)) footprintEntries.set(base(entry.name).toLowerCase(), entry);
  const footprintText = (uuid: string): string | undefined => {
    const entry = footprintEntries.get(uuid.toLowerCase());
    return entry ? textOf(archive, entry, MAX_FOOTPRINT_BYTES) : undefined;
  };
  return boardOf(readPcb(chosen), project, footprintText, input, extra);
}

export function parseEasyedaPro(input: ParseInput): Board | null {
  const sniff = sniffEasyedaPro(input.data, input.name);
  if ((!sniff || sniff.confidence < 0.5) && /\.epro$/i.test(input.name) && isZipSignature(input.data)) {
    // The name claims a project archive: say why it cannot be read (damaged directory, ZIP64, encryption, an entry limit) instead of "unrecognized".
    const archive = openZip(input.data, FORMAT);
    throw new BoardFormatError(archive ? `${FORMAT}: the archive holds no EasyEDA Pro project (no project.json next to PCB/ or FOOTPRINT/ entries).` : `${FORMAT}: the file is not a readable ZIP archive.`, 'INVALID_FORMAT', FORMAT);
  }
  if (!sniff || sniff.confidence < 0.5) return null;
  if (sniff.kind === 'schematic') return null;
  if (sniff.variant === 'eprj-sqlite') throw new BoardFormatError('This is an EasyEDA Pro offline project database (SQLite, .eprj/.elib). Open the project in EasyEDA Pro and export it as an .epro project file, which TRACE can read.', 'UNSUPPORTED_VARIANT', FORMAT);
  if (sniff.variant === 'log-v3') throw new BoardFormatError('This is an EasyEDA Pro V3 project log (DOCHEAD records); the V3 format is not supported yet. Export a V2 .epro from EasyEDA Pro if the editor offers it.', 'UNSUPPORTED_VARIANT', FORMAT);
  if (sniff.kind === 'footprint') throw new BoardFormatError('This is an EasyEDA Pro footprint document; it contains pads but no board placement.', 'WRONG_KIND', 'EasyEDA Pro footprint');
  if (sniff.kind === 'unsupported') throw new BoardFormatError('This EasyEDA Pro document is a panel or copper-pour result, not a board.', 'WRONG_KIND', FORMAT);
  if (sniff.variant === 'epro-zip') return fromArchive(input.data, input);
  const doc = readPcb(decodeText(input.data));
  const extra = [note('A bare .epcb document has no footprints: only the placed components are shown, without pads or nets. Open the .epro project to get pads.')];
  return boardOf(doc, undefined, () => undefined, input, extra);
}
