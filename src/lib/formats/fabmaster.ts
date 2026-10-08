/*
 * Original TRACE adapter, MIT. Fabmaster FATF text reader (the Allegro "extracta" style extract: `!`-delimited A/J/S rows).
 *
 * Format references (public documentation only; no code of any importer is used):
 *   - KiCad developer documentation of the Fabmaster format (https://dev-docs.kicad.org/en/import-formats/fabmaster/): row types
 *     A (column names), J (units), S (data); one A row, one J row, then S rows per section; the section kinds EXTRACT_REFDES,
 *     EXTRACT_PINS, EXTRACT_NETS, EXTRACT_PADSTACKS, EXTRACT_PAD_SHAPES, EXTRACT_GRAPHICS/TRACES, EXTRACT_VIAS and their columns;
 *     the units MILS (default), MILLIMETERS, MICRONS, INCHES; graphics primitives (LINE, ARC with a direction column,
 *     CIRCLE, RECTANGLE, ...); board edge on the OUTLINE or DESIGN_OUTLINE subclass; the pad shape names.
 *   - the decoded content of the ASUS FZ container, which is the same extract style (see fz.ts).
 * What the public descriptions do not settle, and what this reader assumes (each assumption is in the notes below):
 *   - Columns are found by name (underscores, case and blanks ignored), never by position, so exporters that reorder or add columns still read.
 *   - The J row is searched for a unit word; a unit word in a column of its own applies to that column only.
 *   - Allegro Y points up, angles are counter-clockwise: no flip. SYM_MIRROR=YES is the bottom side.
 *   - PIN_X/PIN_Y are absolute board coordinates. A pad's angle is the symbol angle plus PIN_ROTATION (mirrored: minus); an
 *     angle is only visible on a pad that is not square or round, and it is unverified.
 *   - A pad's size is the first copper record of its padstack; a drill record with a positive size makes it a through-hole pad (both sides).
 *     A padstack is defined for an unmirrored symbol: when its copper records name exactly one outer layer (TOP or BOTTOM) the pad is on that
 *     side, turned over for a mirrored symbol (an edge-connector finger on the far side of its part); otherwise it is on its component's side.
 *   - A repeated REFDES is one component (pin rows name a part by REFDES alone): the first row gives its position, side and value.
 *   - Pad offsets (PAD_X_OFF/PAD_Y_OFF) are not applied, custom (SHAPE) pads use the bounding box of their shape primitives.
 * Bounded and linear: the text is scanned once, a number token is limited to 64 characters, and record counts have the same
 * budgets as buildBoard (plus 8 million data rows in total).
 */
import type { Board, BoardSide, ParseIssue, Point } from '../types';
import { asciiPrefix, BoardFormatError, buildBoard, decodeText, note, stitchOutlines, type ParseInput, type RawBoard, type RawPart, type RawPin } from './common';

export const FABMASTER_FORMAT = 'Fabmaster (FATF)';
/** Stable id for the format registry (the registry lists the reader; nothing here registers itself). */
export const FABMASTER_ID = 'fabmaster';
const fail = (message: string, code: 'INVALID_FORMAT' | 'LIMIT_EXCEEDED' = 'INVALID_FORMAT') => new BoardFormatError(`Fabmaster: ${message}`, code, FABMASTER_FORMAT);

const MAX_PARTS = 250_000, MAX_PINS = 1_000_000, MAX_ROWS = 8_000_000, MAX_PADSTACKS = 500_000, MAX_PADSTACK_ROWS = 2_000_000, MAX_ROWS_PER_PADSTACK = 4096;
const MAX_OUTLINE_PRIMITIVES = 1_000_000, MAX_SHAPE_NAMES = 200_000, MAX_COLUMNS = 512, MAX_TOKEN = 64, SNIFF_BYTES = 16 * 1024;

export interface FabmasterSniff {
  /** 0 = not this format, 1 = certain; adapters claim a file from 0.7 (0.5 when its extension also matches). */
  confidence: number;
  reason: string;
}

const MM_PER_UNIT: Readonly<Record<string, number>> = {
  MILS: 0.0254, MIL: 0.0254, THOU: 0.0254, INCHES: 25.4, INCH: 25.4, MILLIMETERS: 1, MILLIMETER: 1, MM: 1, MICRONS: 0.001, MICRON: 0.001, CENTIMETERS: 10, CENTIMETER: 10, CM: 10,
};
const unitOf = (word: string): number | undefined => { const key = word.trim().toUpperCase(); return Object.hasOwn(MM_PER_UNIT, key) ? MM_PER_UNIT[key] : undefined; };
/** Column names compare without case, underscores and blanks (EXTRACT_PINS spells PIN_X where older extracts spell PINX). */
const normalize = (name: string) => name.replace(/[\s_]+/g, '').toUpperCase();

type Kind = 'components' | 'pins' | 'nets' | 'padstacks' | 'padshapes' | 'graphics' | 'vias' | 'other';
function kindOf(names: ReadonlySet<string>): Kind {
  const has = (...columns: string[]) => columns.every(column => names.has(column));
  if (has('PINX', 'PINY')) return 'pins';
  if (has('PADNAME', 'LAYER')) return 'padstacks';
  if (has('PADSHAPENAME', 'GRAPHICDATANAME')) return 'padshapes';
  if (has('GRAPHICDATANAME', 'SUBCLASS')) return 'graphics';
  if (has('VIAX', 'VIAY')) return 'vias';
  if (has('NETNAME', 'REFDES') && (names.has('PINNUMBER') || names.has('PINNAME'))) return 'nets';
  if (has('REFDES') && !names.has('NETNAME') && (names.has('SYMX') || names.has('COMPCLASS') || names.has('SYMNAME') || names.has('SYMMIRROR') || names.has('COMPINSERTIONCODE'))) return 'components';
  return 'other';
}

/** Splits an A/J/S row at `!`; a field that starts with `"` may hold `!` and `""`; the final `!` terminates the last field. */
function rowFields(line: string): string[] {
  const out: string[] = [], n = line.length;
  let at = 0;
  for (;;) {
    let value: string, next: number;
    // A quoted field needs a closing quote on the same line; without one the opening quote is dropped and the field ends at the next `!`.
    if (line.charCodeAt(at) === 34 && line.indexOf('"', at + 1) >= 0) {
      const parts: string[] = [];
      let i = at + 1;
      for (;;) {
        const quote = line.indexOf('"', i);
        if (quote < 0) { parts.push(line.slice(i)); i = n; break; } // only after a doubled quote at the very end of the line
        parts.push(line.slice(i, quote));
        if (line.charCodeAt(quote + 1) === 34) { parts.push('"'); i = quote + 2; continue; }
        i = quote + 1; break;
      }
      const bang = line.indexOf('!', i);
      parts.push(bang < 0 ? line.slice(i) : line.slice(i, bang));
      value = parts.join(''); next = bang < 0 ? -1 : bang + 1;
    } else {
      if (line.charCodeAt(at) === 34) at++;
      const bang = line.indexOf('!', at);
      value = bang < 0 ? line.slice(at) : line.slice(at, bang); next = bang < 0 ? -1 : bang + 1;
    }
    out.push(value);
    if (next < 0 || next >= n) break; // the final `!` terminates the last field: it does not start another
    at = next;
  }
  return out;
}

const outerSideOf = (layer: string): 'top' | 'bottom' | undefined => { const key = layer.trim().toUpperCase(); return key === 'TOP' ? 'top' : key === 'BOTTOM' ? 'bottom' : undefined; };
const HEAD_ROW = /^[ \t]*[AJSajs]!/;
/** Pure text sniff over at most the first 16 KiB; linear. A FATF file has a J (units) row after each A row; plain A/S text without one (the FZ payload) never reaches 0.7 by content alone. */
export function sniffFabmasterText(head: string): FabmasterSniff {
  const lines = head.slice(0, SNIFF_BYTES).replace(/^\uFEFF|^\xEF\xBB\xBF/, '').split(/\r\n|\n|\r/);
  let first = true, signatures = 0, units = false, data = false, afterHeader = false, banner = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    // A few leading non-row lines (a banner, a `UNIT:` line) may precede the first A row.
    if (!HEAD_ROW.test(line)) { if (first && ++banner > 8) return { confidence: 0, reason: 'no A row near the top of the file' }; afterHeader = false; continue; }
    const type = line.trimStart()[0].toUpperCase();
    if (first && type !== 'A') return { confidence: 0, reason: 'the first row is not an A row' };
    first = false;
    if (type === 'A') {
      const kind = kindOf(new Set(rowFields(line.trimStart()).slice(1).map(normalize)));
      if (kind !== 'other') signatures++;
      afterHeader = true;
    } else if (type === 'J' && afterHeader) { units = true; afterHeader = false; }
    else if (type === 'S') { data = true; afterHeader = false; }
  }
  if (first) return { confidence: 0, reason: 'no row found' };
  if (!signatures) return { confidence: 0.1, reason: 'A/S rows without a known section signature' };
  const confidence = Math.min(1, 0.3 + 0.2 * Math.min(signatures, 2) + (units ? 0.3 : 0) + (data ? 0.1 : 0));
  return { confidence: units ? confidence : Math.min(confidence, 0.6), reason: `${signatures} known section header${signatures === 1 ? '' : 's'}${units ? ', J unit rows' : ', no J unit row'}${data ? ', S rows' : ''}` };
}
/** Byte-level sniff for a dispatcher: text only (a NUL in the first KiB is never Fabmaster); UTF-16 files arrive re-encoded as UTF-8. */
export function sniffFabmaster(data: Uint8Array): FabmasterSniff {
  if (!(data instanceof Uint8Array) || data.length < 6) return { confidence: 0, reason: 'too short' };
  const head = asciiPrefix(data, SNIFF_BYTES);
  if (head.slice(0, 1024).includes('\0')) return { confidence: 0, reason: 'binary data' };
  return sniffFabmasterText(head);
}
const claimed = (sniff: FabmasterSniff, name: string) => sniff.confidence >= 0.7 || sniff.confidence >= 0.5 && /\.(?:fab|fatf)$/i.test(name);

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
interface PadRow { layer: string; shape: string; width: number; height: number; shapeName: string; drill: number; offsets: boolean }
interface Padstack { rows: PadRow[]; via: boolean }
interface Component { ref: string; symbol: string; side: BoardSide; rotation: number; position?: Point; value: string; type: string }
interface PinRow { ref: string; symbol: string; mirror: boolean | undefined; number: string; name: string; x: number; y: number; stack: string; rotation: number; net: string }
interface Primitive { name: string; values: number[]; direction: string }
interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

const ARC_STEP = Math.PI / 32;
function arcPoints(a: Point, b: Point, center: Point, counterClockwise: boolean): Point[] {
  const radius = Math.hypot(a.x - center.x, a.y - center.y), endRadius = Math.hypot(b.x - center.x, b.y - center.y);
  if (!(radius > 0)) return [a, b];
  const start = Math.atan2(a.y - center.y, a.x - center.x), end = Math.atan2(b.y - center.y, b.x - center.x);
  let sweep = counterClockwise ? end - start : start - end;
  sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (sweep < 1e-12) sweep = 2 * Math.PI;
  const steps = Math.max(2, Math.min(4096, Math.ceil(sweep / ARC_STEP))), points: Point[] = [a], sign = counterClockwise ? 1 : -1;
  for (let step = 1; step < steps; step++) {
    const angle = start + sign * sweep * step / steps, r = radius + (endRadius - radius) * step / steps;
    points.push({ x: center.x + r * Math.cos(angle), y: center.y + r * Math.sin(angle) });
  }
  points.push(b);
  return points;
}
const circlePoints = (center: Point, radius: number): Point[] => Array.from({ length: 65 }, (_, i) => i === 64 ? { x: center.x + radius, y: center.y } : { x: center.x + radius * Math.cos(2 * Math.PI * i / 64), y: center.y + radius * Math.sin(2 * Math.PI * i / 64) });

interface Section {
  kind: Kind;
  index: Map<string, number>;
  unit?: number;
  columnUnit: Map<number, number>;
  unitAssumed: boolean;
  mixedUnits: boolean;
  fellBack: boolean;
}

function readFabmaster(text: string): RawBoard {
  const components = new Map<string, Component>(), pins: PinRow[] = [], nets = new Map<string, string>(), padstacks = new Map<string, Padstack>();
  const shapes = new Map<string, Bounds>(), outline = new Map<string, Primitive[]>([['OUTLINE', []], ['DESIGNOUTLINE', []]]);
  let rows = 0, padRows = 0, outlinePrimitives = 0, ignoredOutlineGraphics = 0, strayLines = 0, anonymous = 0, repeated = 0, vias = 0, unitless = 0, mixed = 0, noPosition = 0, netRows = 0;
  let fileUnit: number | undefined, sections = 0, section: Section | undefined, no = 0;

  const unitFor = (current: Section, column: number): number => {
    const exact = current.columnUnit.get(column);
    if (exact !== undefined) return exact;
    // A J row that names several units leaves a column without its own word ambiguous: the first unit is used, once per section noted.
    if (current.mixedUnits && !current.fellBack) { current.fellBack = true; mixed++; }
    const own = current.unit ?? fileUnit;
    if (own !== undefined) return own;
    if (!current.unitAssumed) { current.unitAssumed = true; unitless++; }
    return MM_PER_UNIT.MILS;
  };
  const cell = (fields: string[], column: number | undefined): string => column === undefined ? '' : (fields[column + 1] ?? '').trim();
  const numberAt = (fields: string[], column: number | undefined, label: string): number | undefined => {
    const value = cell(fields, column);
    if (!value) return undefined;
    if (value.length > MAX_TOKEN || !DECIMAL.test(value)) throw fail(`line ${no}: invalid ${label} "${value.slice(0, 40)}".`);
    return Number(value);
  };
  const lengthAt = (current: Section, fields: string[], column: number | undefined, label: string): number | undefined => {
    const value = numberAt(fields, column, label);
    return value === undefined ? undefined : value * unitFor(current, column!);
  };
  const need = (value: number | undefined, label: string): number => { if (value === undefined) throw fail(`line ${no}: missing ${label}.`); return value; };

  const openSection = (fields: string[]): void => {
    if (fields.length - 1 > MAX_COLUMNS) throw fail(`line ${no}: a section has more than ${MAX_COLUMNS} columns.`, 'LIMIT_EXCEEDED');
    const index = new Map<string, number>();
    fields.slice(1).forEach((name, column) => { const key = normalize(name); if (key && !index.has(key)) index.set(key, column); });
    section = { kind: kindOf(new Set(index.keys())), index, columnUnit: new Map(), unitAssumed: false, mixedUnits: false, fellBack: false };
    sections++;
  };
  const readUnits = (fields: string[]): void => {
    if (!section) return;
    const found = new Set<number>();
    fields.slice(1).forEach((word, column) => {
      const unit = unitOf(word);
      if (unit === undefined) return;
      found.add(unit); section!.columnUnit.set(column, unit); section!.unit ??= unit;
    });
    section.mixedUnits = found.size > 1;
  };

  const addComponent = (current: Section, fields: string[]): void => {
    const col = (name: string) => current.index.get(name);
    const ref = cell(fields, col('REFDES'));
    if (!ref) { anonymous++; return; }
    if (components.has(ref)) { repeated++; return; } // the pin rows name a part by REFDES alone, so a repeated one is the same part: the first row wins
    if (components.size >= MAX_PARTS) throw fail('component count exceeds the import limit.', 'LIMIT_EXCEEDED');
    const x = lengthAt(current, fields, col('SYMX'), 'SYM_X'), y = lengthAt(current, fields, col('SYMY'), 'SYM_Y');
    const rotation = numberAt(fields, col('SYMROTATE'), 'SYM_ROTATE') ?? 0;
    if (x === undefined || y === undefined) noPosition++;
    components.set(ref, {
      ref, symbol: cell(fields, col('SYMNAME')), side: cell(fields, col('SYMMIRROR')).toUpperCase() === 'YES' ? 'bottom' : 'top', rotation: ((rotation % 360) + 360) % 360,
      ...(x !== undefined && y !== undefined ? { position: { x, y } } : {}),
      value: cell(fields, col('COMPVALUE')) || cell(fields, col('COMPPARTNUMBER')) || cell(fields, col('COMPDEVICELABEL')), type: cell(fields, col('SYMTYPE')).toUpperCase(),
    });
  };
  const addPin = (current: Section, fields: string[]): void => {
    const col = (name: string) => current.index.get(name);
    if (pins.length >= MAX_PINS) throw fail('pin count exceeds the import limit.', 'LIMIT_EXCEEDED');
    const x = need(lengthAt(current, fields, col('PINX'), 'PIN_X'), 'PIN_X'), y = need(lengthAt(current, fields, col('PINY'), 'PIN_Y'), 'PIN_Y');
    const mirrorText = cell(fields, col('SYMMIRROR')).toUpperCase(), name = cell(fields, col('PINNAME')), number = cell(fields, col('PINNUMBER'));
    pins.push({
      ref: cell(fields, col('REFDES')), symbol: cell(fields, col('SYMNAME')), mirror: col('SYMMIRROR') === undefined ? undefined : mirrorText === 'YES',
      number: number || name, name: name || number, x, y, stack: cell(fields, col('PADSTACKNAME')), rotation: numberAt(fields, col('PINROTATION'), 'PIN_ROTATION') ?? 0, net: cell(fields, col('NETNAME')),
    });
  };
  const addNet = (current: Section, fields: string[]): void => {
    const col = (name: string) => current.index.get(name);
    const net = cell(fields, col('NETNAME')), ref = cell(fields, col('REFDES')), pin = cell(fields, col('PINNUMBER')) || cell(fields, col('PINNAME'));
    if (!net || !ref) return;
    if (++netRows > MAX_PINS * 2) throw fail('net record count exceeds the import limit.', 'LIMIT_EXCEEDED');
    const key = `${ref}\u0000${pin}`;
    if (!nets.has(key)) nets.set(key, net);
  };
  const addPadstackRow = (current: Section, fields: string[]): void => {
    const col = (name: string) => current.index.get(name);
    const name = cell(fields, col('PADNAME'));
    if (!name) return;
    if (++padRows > MAX_PADSTACK_ROWS) throw fail('padstack record count exceeds the import limit.', 'LIMIT_EXCEEDED');
    let stack = padstacks.get(name);
    if (!stack) {
      if (padstacks.size >= MAX_PADSTACKS) throw fail('padstack count exceeds the import limit.', 'LIMIT_EXCEEDED');
      stack = { rows: [], via: false }; padstacks.set(name, stack);
    }
    if (stack.rows.length >= MAX_ROWS_PER_PADSTACK) throw fail('a padstack has too many records.', 'LIMIT_EXCEEDED');
    if (cell(fields, col('VIAFLAG')).toUpperCase() === 'V') stack.via = true;
    const layer = cell(fields, col('LAYER')), shape = cell(fields, col('PADSHAPE1')).toUpperCase();
    const width = lengthAt(current, fields, col('PADWIDTH'), 'PAD_WIDTH') ?? 0, height = lengthAt(current, fields, col('PADHGHT'), 'PAD_HEIGHT') ?? 0;
    const xOffset = lengthAt(current, fields, col('PADXOFF'), 'PAD_X_OFF') ?? 0, yOffset = lengthAt(current, fields, col('PADYOFF'), 'PAD_Y_OFF') ?? 0;
    // A ~DRILL record carries the hole: its width, or (some extracts) a numeric shape column, is the diameter.
    let drill = 0;
    if (layer.toUpperCase() === '~DRILL') drill = width > 0 ? width : DECIMAL.test(shape) && shape.length <= MAX_TOKEN ? Number(shape) * unitFor(current, col('PADSHAPE1')!) : 0;
    stack.rows.push({ layer, shape, width, height, shapeName: cell(fields, col('PADSHAPENAME')).toUpperCase(), drill, offsets: xOffset !== 0 || yOffset !== 0 });
  };
  const addPadShape = (current: Section, fields: string[]): void => {
    const col = (name: string) => current.index.get(name);
    const name = cell(fields, col('PADSHAPENAME')).toUpperCase(), primitive = cell(fields, col('GRAPHICDATANAME')).toUpperCase();
    if (!name) return;
    const value = (i: number) => lengthAt(current, fields, col(`GRAPHICDATA${i}`), `GRAPHIC_DATA_${i}`);
    const points: Point[] = [];
    if (primitive === 'LINE' || primitive === 'RECTANGLE') {
      const a = [value(1), value(2), value(3), value(4)];
      if (a.every(item => item !== undefined)) points.push({ x: a[0]!, y: a[1]! }, { x: a[2]!, y: a[3]! });
    } else if (primitive === 'CIRCLE') {
      const cx = value(1), cy = value(2), d = value(3);
      if (cx !== undefined && cy !== undefined && d !== undefined) points.push({ x: cx - d / 2, y: cy - d / 2 }, { x: cx + d / 2, y: cy + d / 2 });
    } else if (primitive === 'FIG_RECTANGLE' || primitive === 'SQUARE') {
      const cx = value(1), cy = value(2), w = value(3), h = value(4);
      if (cx !== undefined && cy !== undefined && w !== undefined && h !== undefined) points.push({ x: cx - w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy + h / 2 });
    }
    if (!points.length) return;
    let box = shapes.get(name);
    if (!box) {
      if (shapes.size >= MAX_SHAPE_NAMES) throw fail('pad shape count exceeds the import limit.', 'LIMIT_EXCEEDED');
      box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }; shapes.set(name, box);
    }
    for (const p of points) { box.minX = Math.min(box.minX, p.x); box.minY = Math.min(box.minY, p.y); box.maxX = Math.max(box.maxX, p.x); box.maxY = Math.max(box.maxY, p.y); }
  };
  const addGraphic = (current: Section, fields: string[]): void => {
    const col = (name: string) => current.index.get(name);
    const key = cell(fields, col('SUBCLASS')).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const bucket = outline.get(key);
    if (!bucket) return;
    const klass = cell(fields, col('CLASS')).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cell(fields, col('REFDES')) || klass && klass !== 'BOARDGEOMETRY') return; // symbol-level graphics and other classes are not the board edge
    if (++outlinePrimitives > MAX_OUTLINE_PRIMITIVES) throw fail('board outline record count exceeds the import limit.', 'LIMIT_EXCEEDED');
    const name = cell(fields, col('GRAPHICDATANAME')).toUpperCase();
    // GRAPHIC_DATA columns are primitive-specific. In particular TEXT's DATA_4
    // is YES/NO, DATA_5 alignment and DATA_6 font metadata, not edge coordinates.
    // Read only the coordinates used by supported edge primitives; annotations
    // cannot turn an otherwise valid contour into malformed numeric geometry.
    const coordinateFields = name === 'ARC' ? 6 : name === 'LINE' || name === 'RECTANGLE' ? 4 : name === 'CIRCLE' ? 3 : 0;
    if (!coordinateFields) { ignoredOutlineGraphics++; return; }
    const values: number[] = [];
    for (let i = 1; i <= coordinateFields; i++) values.push(lengthAt(current, fields, col(`GRAPHICDATA${i}`), `GRAPHIC_DATA_${i}`) ?? Number.NaN);
    bucket.push({ name, values, direction: cell(fields, col('GRAPHICDATA9')).toUpperCase() });
  };

  let lf = text.indexOf('\n'), cr = text.indexOf('\r');
  for (let pos = 0; pos < text.length;) {
    no++;
    if (lf >= 0 && lf < pos) lf = text.indexOf('\n', pos);
    if (cr >= 0 && cr < pos) cr = text.indexOf('\r', pos);
    const stop = lf < 0 ? (cr < 0 ? text.length : cr) : cr < 0 ? lf : Math.min(lf, cr);
    const line = text.slice(pos, stop);
    pos = text[stop] === '\r' && text[stop + 1] === '\n' ? stop + 2 : stop + 1;
    if (!line.trim()) continue;
    if (!HEAD_ROW.test(line)) {
      const unit = /^\s*UNIT:\s*(\w+)/i.exec(line);
      if (unit && unitOf(unit[1]) !== undefined) fileUnit = unitOf(unit[1]); else strayLines++;
      continue;
    }
    const fields = rowFields(line.trimStart()), type = fields[0].toUpperCase();
    if (type === 'A') openSection(fields);
    else if (type === 'J') readUnits(fields);
    else {
      if (!section) { strayLines++; continue; }
      if (++rows > MAX_ROWS) throw fail('data row count exceeds the import limit.', 'LIMIT_EXCEEDED');
      switch (section.kind) {
        case 'components': addComponent(section, fields); break;
        case 'pins': addPin(section, fields); break;
        case 'nets': addNet(section, fields); break;
        case 'padstacks': addPadstackRow(section, fields); break;
        case 'padshapes': addPadShape(section, fields); break;
        case 'graphics': addGraphic(section, fields); break;
        case 'vias': vias++; break;
        default: break;
      }
    }
  }
  if (!sections) throw fail('no A row (section header) was found.');
  if (!pins.length) throw fail('no pin section with PIN_X/PIN_Y columns was found, so no pad has a position.');

  // Pins name their component by REFDES; without one, by the symbol name when exactly one placed component uses it.
  interface Owner { part: RawPart; component?: Component; pins: number }
  const owners = new Map<string, Owner>(), implicitOwners: Owner[] = [], bySymbol = new Map<string, Component[]>();
  for (const component of components.values()) { const list = bySymbol.get(component.symbol); if (list) list.push(component); else bySymbol.set(component.symbol, [component]); }
  const ownerOf = (row: PinRow): Owner => {
    let component = row.ref ? components.get(row.ref) : undefined;
    if (!component && !row.ref && row.symbol) { const list = bySymbol.get(row.symbol); if (list?.length === 1) component = list[0]; }
    const key = component?.ref ?? (row.ref || row.symbol || '(unnamed)');
    let owner = owners.get(key);
    if (!owner) {
      const symbol = component?.symbol || row.symbol;
      const part: RawPart = { key, ref: key, side: component ? component.side : row.mirror ? 'bottom' : 'top', ...(symbol ? { package: symbol } : {}), ...(component?.value ? { value: component.value } : {}),
        ...(component?.position ? { position: component.position } : {}), ...(component ? { rotation: component.rotation } : {}) };
      owner = { part, ...(component ? { component } : {}), pins: 0 };
      owners.set(key, owner);
      if (!component) implicitOwners.push(owner);
    }
    return owner;
  };
  const rawPins: RawPin[] = [], matched = new Set<string>();
  let missingStack = 0, unsized = 0, approximated = 0, unknownShapes = 0, offsets = 0;
  for (const row of pins) {
    const owner = ownerOf(row);
    owner.pins++;
    const stack = row.stack ? padstacks.get(row.stack) : undefined;
    if (row.stack && !stack) missingStack++;
    const copper = stack?.rows.filter(item => !item.layer.startsWith('~')) ?? [];
    const through = !!stack && stack.rows.some(item => item.drill > 0);
    const mirrored = owner.component ? owner.component.side === 'bottom' : row.mirror === true, base = owner.component?.rotation ?? 0;
    // A padstack is defined for an unmirrored symbol: its one outer layer (an edge-connector finger on the far side of a part) is the pad's side,
    // turned over when the symbol is mirrored. Several outer layers, or none, leave the pad on the side of its component.
    const outerSides = new Set(copper.map(item => outerSideOf(item.layer)).filter((side): side is 'top' | 'bottom' => side !== undefined));
    const stackSide = outerSides.size === 1 ? [...outerSides][0] : undefined;
    const physical = through || !stackSide ? undefined : mirrored === (stackSide === 'bottom') ? 'top' : 'bottom';
    const sized = (item: PadRow) => item.width > 0 || item.height > 0 || !!item.shapeName;
    const primary = (stackSide ? copper.find(item => outerSideOf(item.layer) === stackSide && sized(item)) : undefined) ?? copper.find(sized) ?? copper[0];
    const angle = (((base + (mirrored ? -row.rotation : row.rotation)) % 360) + 360) % 360;
    const key = `${owner.part.ref}\u0000${row.number}`, listed = nets.get(key);
    if (listed !== undefined) matched.add(key);
    const pin: RawPin = { part: owner.part.key, number: row.number, name: row.name, net: row.net || listed || '', x: row.x, y: row.y, side: through ? 'both' : physical ?? owner.part.side };
    if (primary) {
      let width = primary.width, height = primary.height, shape: RawPin['shape'];
      const kind = primary.shape, oblong = kind === 'OBLONG' || kind === 'OBLONG_X' || kind === 'OBLONG_Y';
      if (kind === 'SHAPE') {
        const box = shapes.get(primary.shapeName);
        if (box && box.maxX >= box.minX) { width = box.maxX - box.minX; height = box.maxY - box.minY; }
        approximated++; shape = 'rect';
      } else if (kind === 'CIRCLE' || kind === 'ROUND') { width = height = width > 0 ? width : height; shape = 'round'; }
      else if (kind === 'SQUARE') { width = height = width > 0 ? width : height; shape = 'square'; }
      else if (kind === 'RECTANGLE' || kind === 'RECT') shape = width === height ? 'square' : 'rect';
      else if (kind === 'ROUNDED_RECT' || kind === 'ROUNDEDRECT' || kind === 'OCTAGON' || oblong) {
        // Only an equal-sided oblong is exact (a circle); every other rounded, chamfered or stadium pad is drawn as its bounding rectangle.
        shape = width === height ? (oblong ? 'round' : 'square') : 'rect';
        if (!(width === height && oblong)) approximated++;
      } else { shape = width === height ? 'square' : 'rect'; unknownShapes++; }
      if (width > 0 && height > 0) {
        if (primary.offsets) offsets++;
        Object.assign(pin, { shape, width, height, radius: Math.min(width, height) / 2, rotation: angle });
      } else unsized++;
    } else if (stack) unsized++;
    rawPins.push(pin);
  }
  const unmatchedNets = nets.size - matched.size;

  // Components in file order. A package symbol that owns no pin is still a placed part (it has a position); other symbol kinds
  // (mechanical, format, drafting) only count when they own pins. Parts that only pin rows name come last.
  const parts: RawPart[] = [];
  let omitted = 0;
  for (const component of components.values()) {
    const owner = owners.get(component.ref);
    if (owner) parts.push(owner.part);
    else if (component.position && (!component.type || component.type === 'PACKAGE')) {
      parts.push({ key: component.ref, ref: component.ref, side: component.side, position: component.position, rotation: component.rotation, ...(component.symbol ? { package: component.symbol } : {}), ...(component.value ? { value: component.value } : {}) });
    } else omitted++;
  }
  for (const owner of implicitOwners) parts.push(owner.part);
  const implicit = implicitOwners.length;

  const warnings: ParseIssue[] = [];
  // English format diagnostics through the formatNote catalog entry, like the other boardview adapters.
  warnings.push(note('Fabmaster: pad angles (symbol angle plus PIN_ROTATION) and pad offsets are not verified against a vendor file; only copper pad sizes are read, and vias, traces, zones and text are not shown.'));
  if (unitless) warnings.push(note(`${unitless} ${unitless === 1 ? 'section has' : 'sections have'} no unit row; coordinates are read as mils.`));
  if (mixed) warnings.push(note(`${mixed} unit ${mixed === 1 ? 'row names' : 'rows name'} more than one unit; the first is used for columns without their own.`));
  if (repeated) warnings.push(note(`${repeated} component ${repeated === 1 ? 'row repeats' : 'rows repeat'} a REFDES that is already listed; pin rows name a component by REFDES, so the first row gives its position, side and value.`));
  if (anonymous) warnings.push(note(`${anonymous} ${anonymous === 1 ? 'component row has' : 'component rows have'} no REFDES and ${anonymous === 1 ? 'was' : 'were'} skipped.`));
  if (omitted) warnings.push(note(`${omitted} non-package ${omitted === 1 ? 'symbol' : 'symbols'} without pins (mounting holes, frames) ${omitted === 1 ? 'was' : 'were'} omitted.`));
  if (implicit) warnings.push(note(`${implicit} ${implicit === 1 ? 'component is' : 'components are'} named by pins only (no REFDES row); the name comes from the pin rows.`));
  if (missingStack) warnings.push(note(`${missingStack} pin ${missingStack === 1 ? 'row names' : 'rows name'} a padstack that the file does not define; ${missingStack === 1 ? 'it has' : 'they have'} no pad size.`));
  if (unsized) warnings.push(note(`${unsized} ${unsized === 1 ? 'pin has' : 'pins have'} a padstack without a usable copper pad size.`));
  if (unknownShapes) warnings.push(note(`${unknownShapes} ${unknownShapes === 1 ? 'pad uses' : 'pads use'} an unknown Fabmaster pad shape and ${unknownShapes === 1 ? 'is' : 'are'} drawn as a rectangle.`));
  if (offsets) warnings.push(note(`${offsets} ${offsets === 1 ? 'pad has' : 'pads have'} an offset from the pin origin that is not applied.`));
  if (unmatchedNets > 0) warnings.push(note(`${unmatchedNets} net ${unmatchedNets === 1 ? 'record names' : 'records name'} a component pin that no pin row lists.`));
  if (noPosition) warnings.push(note(`${noPosition} ${noPosition === 1 ? 'component has' : 'components have'} no SYM_X/SYM_Y; ${noPosition === 1 ? 'it is' : 'they are'} placed at the centre of ${noPosition === 1 ? 'its' : 'their'} pads.`));
  if (strayLines) warnings.push(note(`${strayLines} ${strayLines === 1 ? 'line is' : 'lines are'} not part of any section and ${strayLines === 1 ? 'was' : 'were'} ignored.`));
  if (vias) warnings.push(note(`${vias} ${vias === 1 ? 'via is' : 'vias are'} not shown.`));
  if (approximated) warnings.push({ key: 'parse.warning.approximatedPads', params: { count: approximated } });

  // Board edge: OUTLINE, else DESIGN_OUTLINE; arcs and circles are sampled.
  const primitives = outline.get('OUTLINE')!.length ? outline.get('OUTLINE')! : outline.get('DESIGNOUTLINE')!;
  const segments: Array<[Point, Point]> = [];
  let arcs = 0, unreadable = ignoredOutlineGraphics, directionless = 0;
  const addPath = (path: Point[]) => { for (let i = 1; i < path.length; i++) segments.push([path[i - 1], path[i]]); };
  for (const item of primitives) {
    const v = item.values;
    const finite = (count: number) => v.slice(0, count).every(Number.isFinite);
    if (item.name === 'LINE' && finite(4)) addPath([{ x: v[0], y: v[1] }, { x: v[2], y: v[3] }]);
    else if (item.name === 'ARC' && finite(6)) {
      if (!['COUNTERCLOCKWISE', 'CLOCKWISE', 'CCW', 'CW'].includes(item.direction)) directionless++;
      addPath(arcPoints({ x: v[0], y: v[1] }, { x: v[2], y: v[3] }, { x: v[4], y: v[5] }, item.direction === 'COUNTERCLOCKWISE' || item.direction === 'CCW')); arcs++;
    } else if (item.name === 'RECTANGLE' && finite(4)) addPath([{ x: v[0], y: v[1] }, { x: v[2], y: v[1] }, { x: v[2], y: v[3] }, { x: v[0], y: v[3] }, { x: v[0], y: v[1] }]);
    else if (item.name === 'CIRCLE' && finite(3) && v[2] > 0) { addPath(circlePoints({ x: v[0], y: v[1] }, v[2] / 2)); arcs++; }
    else unreadable++;
  }
  const { loops, openChains } = stitchOutlines(segments, 1e-3);
  if (segments.length && !loops.length) warnings.push(note('Fabmaster OUTLINE records do not form a closed contour; an estimated boundary is shown.'));
  else if (openChains) warnings.push(note(`${openChains} open Fabmaster outline ${openChains === 1 ? 'chain' : 'chains'} (spurs, chords or gaps) ${openChains === 1 ? 'is' : 'are'} not part of a closed contour and ${openChains === 1 ? 'was' : 'were'} ignored.`));
  if (arcs && loops.length) warnings.push(note(`${arcs} Fabmaster outline ${arcs === 1 ? 'arc or circle was' : 'arcs and circles were'} approximated by straight segments.`));
  if (directionless) warnings.push(note(`${directionless} outline ${directionless === 1 ? 'arc has' : 'arcs have'} no clockwise/counter-clockwise word and ${directionless === 1 ? 'is' : 'are'} read as clockwise.`));
  if (unreadable) warnings.push(note(`${unreadable} outline ${unreadable === 1 ? 'record is' : 'records are'} not a line, arc, rectangle or circle and ${unreadable === 1 ? 'was' : 'were'} ignored.`));
  return { format: FABMASTER_FORMAT, parts, pins: rawPins, unitsToMm: 1, outline: loops[0] ?? [], outlines: loops, warnings };
}

/** null when the bytes are not a Fabmaster extract; a recognized but malformed file throws BoardFormatError. */
export function parseFabmaster(input: ParseInput): Board | null {
  const text = decodeText(input.data);
  if (!claimed(sniffFabmasterText(text.slice(0, SNIFF_BYTES)), input.name)) return null;
  return buildBoard(input, readFabmaster(text));
}
