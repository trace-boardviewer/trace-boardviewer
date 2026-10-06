/*
 * Original TRACE adapter (MIT). Provenance: record layouts come from PUBLIC DOCUMENTATION only: the KiCad developer
 * documentation "Altium import formats" (dev-docs.kicad.org/en/import-formats/altium: directory/stream names, Header record
 * count, binary record framing, pad sub-record 5 offsets, layer ids 1/32/74, pad shape and pad-mode codes, Board6 VXn/VYn/KINDn
 * keys) and the generated API reference of its ACOMPONENT6/ANET6/APAD6 structures (property names SOURCEDESIGNATOR, PATTERN, LAYER,
 * X, Y, ROTATION, NAME). The container follows [MS-CFB]. No implementation source code was read or copied.
 *
 * Binary PcbDoc (OLE compound file) streams READ, everything else is ignored:
 *   /Components6/Data (+ /Header count)  one text-property block per component: SOURCEDESIGNATOR, PATTERN, LAYER, X, Y, ROTATION
 *   /Nets6/Data       (+ /Header count)  one text-property block per net: NAME
 *   /Pads6/Data       (+ /Header count)  binary pad records (type 2, six length-prefixed sub-records; sizes/positions in sub-record 5)
 *   /Board6/Data      (optional)         first text-property block: outline vertices VXn/VYn/KINDn
 *   /FileHeader       (only to name SchDoc/SchLib/PcbLib containers that are not a PcbDoc)
 * NOT read (disclosed as a warning on every import): Tracks6, Vias6, Arcs6, Fills6, Regions6, Polygons6, Texts6/WideStrings6,
 * Models, rules, classes. Net membership therefore covers component pads only; free pads (no component) are skipped.
 * Untested against real Altium files: every layout is verified only with original synthetic containers. Versions are unknown;
 * pad sub-records shorter than the documented 110 bytes, block flag bytes, %UTF8% text keys, non-contiguous outline vertices,
 * unknown shape/pad-mode codes and pads on inner layers are rejected as UNSUPPORTED_VARIANT instead of being interpreted.
 *
 * ASCII PcbDoc (`|RECORD=Board|KIND=Protel_Advanced_PCB|...` lines): Board/Component/Net property names are the ones documented
 * for the binary text records; the Pad record keys (NAME, COMPONENT, NET, LAYER, X, Y, XSIZE, YSIZE, SHAPE, ROTATION) and 0-based
 * record-index references are NOT documented publicly and are covered by synthetic tests only. A pad lacking those keys is rejected.
 *
 * Coordinates are Y-up; binary values are int32 in 1/10000 mil (1 unit = 2.54e-6 mm); text values need a mil/mm/in suffix
 * (a bare 0 is accepted, any other bare number is rejected because its unit is undocumented). Rotations are counter-clockwise degrees.
 */
import type { Board, BoardSide, ParseIssue, Point } from '../types';
import { asciiPrefix, BoardFormatError, buildBoard, decodeText, MAX_MM, note, startsWithBytes, type FormatErrorCode, type ParseInput, type RawBoard, type RawPart, type RawPin } from './common';

export const ALTIUM_ASCII = 'Altium ASCII PcbDoc';
export const ALTIUM_BINARY = 'Altium binary PcbDoc';
const MIL_MM = 0.0254;
const INTERNAL_UNIT_MM = MIL_MM / 10000;
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ABSENT = 0xffff; // "no net" / "no component" in u16 pad references.
const MAX_BINARY_REFERENCES = 0xfffe; // Pad net/component references are u16 and 0xFFFF is the sentinel.
const MAX_PADS = 1_000_000, MAX_ASCII_RECORDS = 1_500_000, MAX_ASCII_COMPONENTS = 250_000, MAX_ASCII_NETS = 250_000;
const MAX_TEXT_RECORD_BYTES = 1 << 20, MAX_BOARD_RECORD_BYTES = 16 << 20, MAX_ASCII_LINE = 4 << 20, MAX_RECORD_KEYS = 500_000;
const MAX_OUTLINE_VERTICES = 20_000, MAX_RECORD_KEYS_SCAN = 4_000_000;
const MAX_DIRECTORY_ENTRIES = 100_000, MAX_STORAGE_DEPTH = 8;
const PAD_RECORD_MIN = 110; // Documented minimum size of pad sub-record 5.
const latin1 = new TextDecoder('windows-1252');

const fail = (format: string, message: string, code: FormatErrorCode = 'INVALID_FORMAT'): never => { throw new BoardFormatError(message, code, format); };

// --- Text property records: |KEY=VALUE|KEY=VALUE| ---------------------------------------------------------------------------
const UTF8_PREFIX = '%UTF8%';
/** Only wanted keys are retained, so a hostile record cannot allocate more than the adapter uses. */
class Props {
  private readonly values = new Map<string, string>();
  private readonly conflicts = new Set<string>();
  constructor(text: string, keep: (key: string) => boolean, readonly format: string) {
    let seen = 0;
    for (const field of text.split('|')) {
      if (++seen > MAX_RECORD_KEYS_SCAN) fail(format, 'Altium record has too many fields.', 'LIMIT_EXCEEDED');
      const eq = field.indexOf('=');
      if (eq <= 0) continue;
      const key = field.slice(0, eq).trim().toUpperCase(), bare = key.startsWith(UTF8_PREFIX) ? key.slice(UTF8_PREFIX.length) : key;
      if (!keep(bare)) continue;
      if (this.values.size >= MAX_RECORD_KEYS) fail(format, 'Altium record keeps too many fields.', 'LIMIT_EXCEEDED');
      const value = field.slice(eq + 1), prior = this.values.get(key);
      if (prior === undefined) this.values.set(key, value); else if (prior !== value) this.conflicts.add(key);
    }
  }
  has(key: string) { return this.values.has(key); }
  keys() { return [...this.values.keys()]; }
  /** A %UTF8% twin carries text the ANSI value may have mangled (two different names could collapse into one), and a repeated key with a different value is ambiguous. */
  get(key: string): string | undefined {
    if (this.values.has(UTF8_PREFIX + key)) fail(this.format, `Altium field ${key} is stored as %UTF8% text, which TRACE does not decode.`, 'UNSUPPORTED_VARIANT');
    if (this.conflicts.has(key)) fail(this.format, `Altium field ${key} appears twice with different values.`);
    return this.values.get(key);
  }
}
const COMPONENT_KEYS = new Set(['SOURCEDESIGNATOR', 'PATTERN', 'LAYER', 'X', 'Y', 'ROTATION']);
const NET_KEYS = new Set(['NAME']);
const BOARD_KEY = /^(?:KIND|(?:VX|VY|KIND|CX|CY|R|SA|EA)\d+)$/;
const ASCII_PAD_KEYS = new Set(['NAME', 'COMPONENT', 'NET', 'LAYER', 'X', 'Y', 'XSIZE', 'YSIZE', 'SHAPE', 'ROTATION']);

const COORDINATE = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(mil|mm|in)?$/i;
/** "1000mil" / "25.4mm" / "1in" → mm. A bare number is only accepted when it is zero (unit independent). */
function coordMm(value: string | undefined, label: string, format: string): number {
  if (value === undefined || !value.trim()) return fail(format, `Altium ${label} is missing.`);
  const match = COORDINATE.exec(value.trim());
  if (!match) return fail(format, `Invalid Altium ${label}: ${value.slice(0, 40)}.`);
  const magnitude = Number(match[1]), unit = match[2]?.toLowerCase();
  if (!unit) {
    if (magnitude !== 0) fail(format, `Altium ${label} "${value.slice(0, 40)}" has no unit suffix (mil, mm or in); bare numbers are not interpreted.`, 'UNSUPPORTED_VARIANT');
    return 0;
  }
  return finite(magnitude * (unit === 'mil' ? MIL_MM : unit === 'mm' ? 1 : 25.4), label, format);
}
function finite(value: number, label: string, format: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_MM) fail(format, `Altium ${label} is out of range.`);
  return value;
}
const DECIMAL = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
function degrees(value: string | undefined, label: string, format: string): number {
  if (value === undefined || !value.trim()) return 0; // Altium omits a zero rotation.
  if (!DECIMAL.test(value.trim())) return fail(format, `Invalid Altium ${label} rotation: ${value.slice(0, 40)}.`);
  return angle(finite(Number(value), `${label} rotation`, format));
}
const angle = (value: number) => ((value % 360) + 360) % 360;

/** Layer names of text records: TOP / BOTTOM, and MULTILAYER for pads. */
function textLayerSide(value: string | undefined, label: string, format: string, multi: boolean): BoardSide {
  const layer = (value ?? '').trim().toUpperCase();
  if (!layer) return fail(format, `Altium ${label} has no LAYER.`);
  if (layer === 'TOP') return 'top';
  if (layer === 'BOTTOM') return 'bottom';
  if (multi && layer === 'MULTILAYER') return 'both';
  return fail(format, `Altium ${label} is on layer "${layer.slice(0, 40)}", which cannot be shown in a top/bottom view.`, 'UNSUPPORTED_VARIANT');
}
function idLayerSide(layer: number, label: string, format: string): BoardSide {
  if (layer === 1) return 'top';
  if (layer === 32) return 'bottom';
  if (layer === 74) return 'both';
  return fail(format, `Altium ${label} is on layer id ${layer}; only Top (1), Bottom (32) and Multi-Layer (74) pads are supported.`, 'UNSUPPORTED_VARIANT');
}
type PadShape = { shape: NonNullable<RawPin['shape']>; approximated: boolean };
/** Shape codes 1 round, 2 rectangle, 3 octagonal, 9 rounded rectangle; only exact round/rectangle keep their form. */
function padShape(code: number | undefined, width: number, height: number, label: string, format: string): PadShape {
  if (code === 1) return Math.abs(width - height) < 1e-9 ? { shape: 'round', approximated: false } : { shape: 'rect', approximated: true };
  if (code === 2) return { shape: Math.abs(width - height) < 1e-9 ? 'square' : 'rect', approximated: false };
  if (code === 3 || code === 9) return { shape: Math.abs(width - height) < 1e-9 ? 'square' : 'rect', approximated: true };
  return fail(format, `Altium ${label} has pad shape code ${code ?? '(missing)'}, which is not documented.`, 'UNSUPPORTED_VARIANT');
}
const ASCII_SHAPES: Record<string, number> = { '1': 1, ROUND: 1, '2': 2, RECTANGLE: 2, RECTANGULAR: 2, '3': 3, OCTAGONAL: 3, '9': 9, ROUNDEDRECTANGLE: 9 };

interface Stats { approximated: number; free: number; unnamed: number; stackDiffers: number; arcs: number; emptyPads: number }
const newStats = (): Stats => ({ approximated: 0, free: 0, unnamed: 0, stackDiffers: 0, arcs: 0, emptyPads: 0 });

/** Board outline vertices VXn/VYn (KINDn nonzero marks an arc to the next vertex); arcs are replaced by chords because arc direction is not publicly documented. */
function outlineFromProps(props: Props, format: string, stats: Stats): Point[] {
  const vertices: Point[] = [];
  for (let i = 0; props.has(`VX${i}`) || props.has(`VY${i}`); i++) {
    if (i >= MAX_OUTLINE_VERTICES) fail(format, 'Altium board outline exceeds the vertex limit.', 'LIMIT_EXCEEDED');
    vertices.push({ x: coordMm(props.get(`VX${i}`), `outline VX${i}`, format), y: coordMm(props.get(`VY${i}`), `outline VY${i}`, format) });
    const kind = (props.get(`KIND${i}`) ?? '0').trim();
    if (!/^\d+$/.test(kind)) fail(format, `Altium outline KIND${i} "${kind.slice(0, 20)}" is not a number.`);
    if (kind !== '0') stats.arcs++;
  }
  const indexed = props.keys().filter(key => /^V[XY]\d+$/.test(key)).length;
  if (indexed !== vertices.length * 2) fail(format, 'Altium board outline vertex numbers are not contiguous from 0.', 'UNSUPPORTED_VARIANT');
  if (vertices.length >= 2 && Math.hypot(vertices[0].x - vertices.at(-1)!.x, vertices[0].y - vertices.at(-1)!.y) < 1e-6) vertices.pop();
  return vertices.length >= 3 ? vertices : [];
}

function componentPart(index: number, props: Props, format: string, stats: Stats): RawPart {
  const ref = props.get('SOURCEDESIGNATOR')?.trim() ?? '';
  if (!ref) stats.unnamed++;
  const label = `component ${ref || index + 1}`;
  return { key: String(index), ref: ref || `#${index + 1}`, value: '', package: props.get('PATTERN')?.trim() ?? '', side: textLayerSide(props.get('LAYER'), label, format, false),
    position: { x: coordMm(props.get('X'), `${label} X`, format), y: coordMm(props.get('Y'), `${label} Y`, format) }, rotation: degrees(props.get('ROTATION'), label, format) };
}
function assemble(input: ParseInput, format: string, parts: RawPart[], pins: RawPin[], outline: Point[], stats: Stats): Board {
  const warnings: ParseIssue[] = [note('Altium import reads components, pads, nets and the board outline only; tracks, vias, copper pours, board cutouts, text and component bodies are not imported (bodies are estimated from pad extents).')];
  if (stats.unnamed) warnings.push(note(`${stats.unnamed} components carry no designator in their component record; placeholder references (#n) are shown.`));
  const seen = new Set<string>(), repeated = new Set<string>();
  for (const part of parts) if (part.ref && !part.ref.startsWith('#')) { if (seen.has(part.ref)) repeated.add(part.ref); seen.add(part.ref); }
  if (repeated.size) warnings.push(note(`${repeated.size} component designators occur more than once (${[...repeated].slice(0, 5).join(', ')}${repeated.size > 5 ? ', …' : ''}); they stay separate components.`));
  if (stats.free) warnings.push(note(`${stats.free} free pads that belong to no component were not imported.`));
  if (stats.emptyPads) warnings.push(note(`${stats.emptyPads} pads have an empty designator; placeholder pin numbers (#n) are shown.`));
  if (stats.stackDiffers) warnings.push(note(`${stats.stackDiffers} multi-layer pads have different top and bottom sizes; the top size is drawn on both sides.`));
  if (stats.arcs) warnings.push(note(`${stats.arcs} board-outline arcs are drawn as straight chords between their vertices; the true curved edge is not rendered.`));
  if (stats.approximated) warnings.push({ key: 'parse.warning.approximatedPads', params: { count: stats.approximated } });
  const raw: RawBoard = { format, unitsToMm: 1, parts, pins, outline, warnings };
  return buildBoard(input, raw);
}
function padNumbers(pins: RawPin[]) {
  const ordinal = new Map<string, number>();
  for (const pin of pins) { const next = (ordinal.get(pin.part) ?? 0) + 1; ordinal.set(pin.part, next); if (!pin.number) pin.number = `#${next}`; }
}

// --- ASCII variant -----------------------------------------------------------------------------------------------------------
function asciiIndex(value: string | undefined, limit: number, label: string, format: string): number | undefined {
  if (value === undefined || value.trim() === '' || value.trim() === '-1') return undefined;
  if (!/^\d+$/.test(value.trim()) || Number(value) >= limit) return fail(format, `Altium pad ${label} index ${value.slice(0, 20)} is out of range (${limit} records).`);
  return Number(value);
}
function parseAscii(input: ParseInput): Board {
  const format = ALTIUM_ASCII, text = decodeText(input.data);
  const records: Array<{ kind: string; line: string; at: number }> = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    if (line.length > MAX_ASCII_LINE) fail(format, `Altium ASCII line ${index + 1} is longer than the import limit.`, 'LIMIT_EXCEEDED');
    if (!records.length && /^\s*\|HEADER=/i.test(line)) {
      if (/schematic/i.test(line)) fail('Altium SchDoc', 'This is an Altium schematic document (SchDoc); open it as a schematic document.', 'WRONG_KIND');
      continue;
    }
    const match = /^\s*\|RECORD=([^|]*)/i.exec(line);
    if (!match) fail(format, `Altium ASCII line ${index + 1} is not a |RECORD= record.`);
    if (records.length >= MAX_ASCII_RECORDS) fail(format, 'Altium ASCII record count exceeds the import limit.', 'LIMIT_EXCEEDED');
    records.push({ kind: match![1].trim().toUpperCase(), line, at: index + 1 });
  }
  if (records.length && /^\d+$/.test(records[0].kind)) fail('Altium SchDoc', 'This is an Altium schematic document (SchDoc); open it as a schematic document.', 'WRONG_KIND');
  const boards = records.filter(record => record.kind === 'BOARD');
  if (boards.length !== 1) fail(format, boards.length ? 'Altium ASCII file has more than one Board record.' : 'Altium ASCII file has no |RECORD=Board record, so it is not a recognized ASCII PcbDoc export.', 'UNSUPPORTED_VARIANT');
  const board = new Props(boards[0].line, key => BOARD_KEY.test(key) || key === 'RECORD', format);
  const kind = board.get('KIND') ?? '';
  if (kind.toLowerCase() !== 'protel_advanced_pcb') fail(format, `Altium ASCII Board record has KIND=${kind.slice(0, 40) || '(missing)'}; only Protel_Advanced_PCB is understood.`, 'UNSUPPORTED_VARIANT');
  const stats = newStats(), nets: string[] = [], netNames = new Set<string>(), parts: RawPart[] = [], pins: RawPin[] = [];
  const componentProps: Props[] = [], padLines: Array<{ line: string; at: number }> = [];
  for (const record of records) {
    if (record.kind === 'NET') {
      if (nets.length >= MAX_ASCII_NETS) fail(format, 'Altium ASCII net count exceeds the import limit.', 'LIMIT_EXCEEDED');
      const name = new Props(record.line, key => NET_KEYS.has(key), format).get('NAME');
      if (!name) fail(format, `Altium Net record on line ${record.at} has no NAME.`);
      if (netNames.has(name!)) fail(format, `Altium net name "${name!.slice(0, 40)}" is declared twice.`);
      netNames.add(name!); nets.push(name!);
    } else if (record.kind === 'COMPONENT') {
      if (componentProps.length >= MAX_ASCII_COMPONENTS) fail(format, 'Altium ASCII component count exceeds the import limit.', 'LIMIT_EXCEEDED');
      componentProps.push(new Props(record.line, key => COMPONENT_KEYS.has(key), format));
    } else if (record.kind === 'PAD') {
      if (padLines.length >= MAX_PADS) fail(format, 'Altium ASCII pad count exceeds the import limit.', 'LIMIT_EXCEEDED');
      padLines.push(record);
    }
  }
  componentProps.forEach((props, index) => parts.push(componentPart(index, props, format, stats)));
  for (const { line, at } of padLines) {
    const props = new Props(line, key => ASCII_PAD_KEYS.has(key), format);
    const component = asciiIndex(props.get('COMPONENT'), parts.length, 'COMPONENT', format);
    const net = asciiIndex(props.get('NET'), nets.length, 'NET', format);
    if (component === undefined) { stats.free++; continue; }
    const name = (props.get('NAME') ?? '').trim(), label = `pad ${parts[component].ref}.${name || `(line ${at})`}`;
    const missing = ['X', 'Y', 'XSIZE', 'YSIZE', 'LAYER'].filter(key => !props.has(key));
    if (missing.length) fail(format, `Altium ASCII ${label} lacks ${missing.join(', ')}; this pad record layout is not understood.`, 'UNSUPPORTED_VARIANT');
    const width = coordMm(props.get('XSIZE'), `${label} XSIZE`, format), height = coordMm(props.get('YSIZE'), `${label} YSIZE`, format);
    if (width <= 0 || height <= 0) fail(format, `Altium ${label} has non-positive dimensions.`);
    const shapeText = (props.get('SHAPE') ?? '').trim().toUpperCase(), shape = padShape(ASCII_SHAPES[shapeText], width, height, label, format);
    if (shape.approximated) stats.approximated++;
    if (net !== undefined && !nets[net]) fail(format, `Altium ${label} references net ${net}, which has no name.`);
    if (!name) stats.emptyPads++;
    pins.push({ part: String(component), number: name, name, net: net === undefined ? '' : nets[net], side: textLayerSide(props.get('LAYER'), label, format, true),
      x: coordMm(props.get('X'), `${label} X`, format), y: coordMm(props.get('Y'), `${label} Y`, format), width, height, radius: Math.min(width, height) / 2, shape: shape.shape,
      rotation: degrees(props.get('ROTATION'), label, format) });
  }
  padNumbers(pins);
  return assemble(input, format, parts, pins, outlineFromProps(board, format, stats), stats);
}

// --- OLE compound file reader (bounded; the `cfb` package follows FAT chains without cycle detection) ----------------------------
interface Compound { paths: string[]; stream(path: string): Uint8Array | undefined }
interface DirEntry { name: string; type: number; left: number; right: number; child: number; start: number; size: number }
const MAXREGSECT = 0xfffffffa, ENDOFCHAIN = 0xfffffffe, NOSTREAM = 0xffffffff;

function readCompound(data: Uint8Array, format: string): Compound {
  const bad = (message: string): never => fail(format, `Altium compound file ${message}.`);
  if (data.length < 512) bad('is shorter than its 512-byte header');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (at: number) => view.getUint16(at, true), u32 = (at: number) => view.getUint32(at, true);
  const version = u16(26), shift = u16(30);
  if (u16(28) !== 0xfffe) bad('has an invalid byte-order mark');
  if (version === 4 && shift === 12) fail(format, 'Altium compound file uses 4096-byte sectors (version 4), which is untested and not supported.', 'UNSUPPORTED_VARIANT');
  if (version !== 3 || shift !== 9 || u16(32) !== 6 || u32(56) !== 4096) bad(`uses an unsupported layout (version ${version}, sector shift ${shift})`);
  const sectorSize = 1 << shift, sectorCount = Math.floor(data.length / sectorSize) - 1, perSector = sectorSize / 4;
  const sector = (index: number): Uint8Array => {
    if (index >= sectorCount) bad(`references sector ${index > MAXREGSECT ? 'with a reserved id' : index} outside the file (${sectorCount} sectors)`);
    return data.subarray((index + 1) * sectorSize, (index + 2) * sectorSize);
  };
  const dataView = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fatCount = u32(44), difatCount = u32(72);
  if (fatCount < 1 || fatCount > sectorCount || difatCount > sectorCount) bad(`declares ${fatCount} FAT and ${difatCount} DIFAT sectors for a file of ${sectorCount} sectors`);
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < fatCount; i++) fatSectors.push(u32(76 + i * 4));
  for (let next = u32(68), used = 0; fatSectors.length < fatCount; used++) {
    if (used >= difatCount) bad('lists fewer FAT sectors than it declares');
    const content = dataView(sector(next));
    for (let i = 0; i < perSector - 1 && fatSectors.length < fatCount; i++) fatSectors.push(content.getUint32(i * 4, true));
    next = content.getUint32((perSector - 1) * 4, true);
  }
  const fatViews = fatSectors.map(index => dataView(sector(index)));
  const fat = (index: number): number => {
    const owner = fatViews[Math.floor(index / perSector)];
    if (!owner) bad(`references allocation entry ${index} outside the FAT`);
    return owner.getUint32((index % perSector) * 4, true);
  };
  /** The first `count` sectors of a chain; ending early or revisiting a sector is corruption. */
  const chain = (start: number, count: number, label: string): number[] => {
    if (count > sectorCount) bad(`${label} needs ${count} sectors but the file has ${sectorCount}`);
    const out: number[] = [], seen = new Set<number>();
    for (let at = start; out.length < count;) {
      if (at >= sectorCount) bad(`${label} ends after ${out.length} of ${count} sectors`);
      if (seen.has(at)) bad(`${label} loops back to sector ${at}`);
      seen.add(at); out.push(at);
      if (out.length < count) at = fat(at);
    }
    return out;
  };
  let spent = 0;
  const spend = (size: number, label: string) => {
    spent += size;
    if (spent > data.length * 2) fail(format, `Altium compound file ${label} exceeds the extraction budget.`, 'LIMIT_EXCEEDED');
  };
  const readChain = (start: number, size: number, label: string): Uint8Array => {
    spend(size, label);
    if (size > sectorCount * sectorSize) bad(`${label} claims ${size} bytes in a file of ${data.length}`);
    const out = new Uint8Array(size);
    chain(start, Math.ceil(size / sectorSize), label).forEach((index, order) => out.set(sector(index).subarray(0, Math.min(sectorSize, size - order * sectorSize)), order * sectorSize));
    return out;
  };

  const directory: number[] = [];
  for (let at = u32(48), seen = new Set<number>(); at !== ENDOFCHAIN; at = fat(at)) {
    if (at >= sectorCount) bad('has a directory chain that leaves the file');
    if (seen.has(at)) bad('has a looping directory chain');
    seen.add(at); directory.push(at);
    if (directory.length * (sectorSize / 128) > MAX_DIRECTORY_ENTRIES) fail(format, `Altium compound file has more than ${MAX_DIRECTORY_ENTRIES} directory entries.`, 'LIMIT_EXCEEDED');
  }
  if (!directory.length) bad('has no directory');
  const entries: DirEntry[] = [];
  for (const index of directory) {
    const content = dataView(sector(index));
    for (let offset = 0; offset < sectorSize; offset += 128) {
      const type = content.getUint8(offset + 66), nameBytes = content.getUint16(offset + 64, true);
      if (type !== 0 && ![1, 2, 5].includes(type)) bad(`has directory entry ${entries.length} with unknown type ${type}`);
      if (type !== 0 && (nameBytes < 2 || nameBytes > 64 || nameBytes % 2)) bad(`has directory entry ${entries.length} with an invalid name length`);
      let name = '';
      if (type !== 0) for (let unit = 0; unit < nameBytes / 2 - 1; unit++) name += String.fromCharCode(content.getUint16(offset + unit * 2, true));
      entries.push({ name, type, left: content.getUint32(offset + 68, true), right: content.getUint32(offset + 72, true), child: content.getUint32(offset + 76, true),
        start: content.getUint32(offset + 116, true), size: content.getUint32(offset + 120, true) }); // Version 3 uses only the low 32 bits of the size.
    }
  }
  if (entries[0].type !== 5) bad('has no root entry');
  const byPath = new Map<string, DirEntry>(), paths: string[] = [], visited = new Uint8Array(entries.length);
  visited[0] = 1;
  const pending: Array<{ node: number; prefix: string; depth: number }> = [{ node: entries[0].child, prefix: '', depth: 1 }];
  while (pending.length) {
    const { node, prefix, depth } = pending.pop()!;
    if (node === NOSTREAM) continue;
    if (node >= entries.length) bad('has a directory link outside the directory');
    if (visited[node]) bad('has a directory entry that is linked twice');
    visited[node] = 1;
    const entry = entries[node];
    if (entry.type !== 1 && entry.type !== 2) bad(`has a directory link to an entry of type ${entry.type}`);
    if (depth > MAX_STORAGE_DEPTH) fail(format, `Altium compound file nests storages deeper than ${MAX_STORAGE_DEPTH} levels.`, 'LIMIT_EXCEEDED');
    const path = `${prefix}/${entry.name}`;
    if (byPath.has(path.toUpperCase())) bad(`has two entries named ${path.slice(0, 80)}`);
    byPath.set(path.toUpperCase(), entry); paths.push(path);
    pending.push({ node: entry.left, prefix, depth }, { node: entry.right, prefix, depth });
    if (entry.type === 1) pending.push({ node: entry.child, prefix: path, depth: depth + 1 });
  }

  let mini: { container: Uint8Array; table: DataView } | undefined;
  const miniStore = () => mini ??= {
    container: readChain(entries[0].start, entries[0].size, 'mini-stream container'),
    table: dataView(u32(64) ? readChain(u32(60), u32(64) * sectorSize, 'mini FAT') : new Uint8Array(0)),
  };
  const readMini = (entry: DirEntry, label: string): Uint8Array => {
    const { container, table } = miniStore(), count = Math.ceil(entry.size / 64);
    spend(entry.size, label);
    if (count * 64 > container.length + 63) bad(`${label} is larger than the mini-stream`);
    const out = new Uint8Array(entry.size), seen = new Set<number>();
    for (let at = entry.start, done = 0; done < count; done++) {
      if (at >= container.length / 64 || seen.has(at)) bad(`${label} has an invalid mini-sector chain`);
      seen.add(at);
      out.set(container.subarray(at * 64, at * 64 + Math.min(64, entry.size - done * 64)), done * 64);
      if (done + 1 < count) { if ((at + 1) * 4 > table.byteLength) bad(`${label} leaves the mini FAT`); at = table.getUint32(at * 4, true); }
    }
    return out;
  };
  return {
    paths,
    stream(path) {
      const entry = byPath.get(path.toUpperCase());
      if (!entry || entry.type !== 2) return undefined;
      if (!entry.size) return new Uint8Array(0);
      return entry.size < 4096 ? readMini(entry, `stream ${path}`) : readChain(entry.start, entry.size, `stream ${path}`);
    },
  };
}

// --- Binary record framing -------------------------------------------------------------------------------------------------
class Reader {
  offset = 0;
  constructor(readonly data: Uint8Array, readonly label: string, readonly format: string) {}
  get remaining() { return this.data.length - this.offset; }
  fail(reason: string, code: FormatErrorCode = 'INVALID_FORMAT'): never { return fail(this.format, `Altium ${this.label} stream is ${reason} at byte ${this.offset}.`, code); }
  u8() { if (this.remaining < 1) this.fail('truncated'); return this.data[this.offset++]; }
  /** [u32 size][size bytes]. The size word is a plain byte count; a flag in its high byte is an undocumented variant. */
  block(maxBytes = MAX_TEXT_RECORD_BYTES): Uint8Array {
    if (this.remaining < 4) this.fail('truncated');
    const word = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4).getUint32(0, true);
    if (word >>> 24) this.fail(`using a block size word with flag byte 0x${(word >>> 24).toString(16)}`, 'UNSUPPORTED_VARIANT');
    this.offset += 4;
    if (word > this.remaining) this.fail(`truncated (block of ${word} bytes declared, ${this.remaining} left)`);
    if (word > maxBytes) this.fail(`using a block of ${word} bytes, over the ${maxBytes} byte limit`, 'LIMIT_EXCEEDED');
    const view = this.data.subarray(this.offset, this.offset + word); this.offset += word; return view;
  }
  /** [u32 size][u8 length][length bytes][padding to size]. */
  pascalBlock(): string {
    const payload = this.block(256);
    if (!payload.length) return '';
    if (payload[0] + 1 > payload.length) this.fail('malformed (Pascal string longer than its block)');
    return latin1.decode(payload.subarray(1, 1 + payload[0]));
  }
  /** [u32 size][|KEY=VALUE| text, usually NUL terminated]. */
  props(keep: (key: string) => boolean, maxBytes = MAX_TEXT_RECORD_BYTES): Props {
    const payload = this.block(maxBytes), end = payload.indexOf(0);
    return new Props(latin1.decode(payload.subarray(0, end < 0 ? payload.length : end)), keep, this.format);
  }
}
function propRecords(data: Uint8Array, label: string, format: string, keep: (key: string) => boolean): Props[] {
  const reader = new Reader(data, label, format), records: Props[] = [];
  while (reader.remaining > 0) {
    if (records.length >= MAX_BINARY_REFERENCES) fail(format, `Altium ${label} record count exceeds the ${MAX_BINARY_REFERENCES} records a pad can reference.`, 'LIMIT_EXCEEDED');
    records.push(reader.props(keep));
  }
  return records;
}
function checkHeader(header: Uint8Array | undefined, count: number, label: string, format: string) {
  if (!header) return;
  if (header.length < 4) fail(format, `Altium ${label}/Header stream is truncated.`);
  const declared = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, true);
  if (declared !== count) fail(format, `Altium ${label}/Header declares ${declared} records but ${count} were found.`);
}

function parseBinary(input: ParseInput): Board {
  const format = ALTIUM_BINARY, container = readCompound(input.data, format);
  const stamp = latin1.decode(container.stream('/FileHeader')?.subarray(0, 512).filter(byte => byte !== 0) ?? new Uint8Array());
  if (/Schematic Capture/i.test(stamp)) fail('Altium SchDoc', 'This is an Altium schematic document (SchDoc); open it as a schematic document.', 'WRONG_KIND');
  if (/Schematic Library/i.test(stamp)) fail('Altium SchLib', 'Altium schematic symbol library (SchLib) detected; it has no board placement.', 'UNSUPPORTED_VARIANT');
  if (/Binary Library File/i.test(stamp) || container.stream('/Library/Data')) fail('Altium PcbLib', 'Altium PCB footprint library (PcbLib) detected; it has no board placement.', 'UNSUPPORTED_VARIANT');
  const found = container.paths.slice(0, 12).join(', ') + (container.paths.length > 12 ? ', …' : '');
  const required = ['Nets6/Data', 'Components6/Data', 'Pads6/Data'], missing = required.filter(path => !container.stream(`/${path}`));
  if (missing.length === required.length) fail(format, `OLE compound file is not an Altium PCB document (entries: ${found || 'none'}).`, 'UNSUPPORTED_VARIANT');
  if (missing.length) fail(format, `Altium binary PcbDoc is missing the ${missing.join(' and ')} stream${missing.length > 1 ? 's' : ''} (entries: ${found}).`, 'UNSUPPORTED_VARIANT');
  const stats = newStats();
  const netRecords = propRecords(container.stream('/Nets6/Data')!, 'Nets6', format, key => NET_KEYS.has(key));
  checkHeader(container.stream('/Nets6/Header'), netRecords.length, 'Nets6', format);
  const names = new Set<string>(), nets = netRecords.map((record, index) => {
    const name = record.get('NAME');
    if (name === undefined) fail(format, `Altium Nets6 record ${index} has no NAME.`);
    if (name && names.has(name)) fail(format, `Altium net name "${name.slice(0, 40)}" is declared twice (Nets6 record ${index}).`);
    names.add(name!); return name!;
  });
  const componentRecords = propRecords(container.stream('/Components6/Data')!, 'Components6', format, key => COMPONENT_KEYS.has(key));
  checkHeader(container.stream('/Components6/Header'), componentRecords.length, 'Components6', format);
  const parts = componentRecords.map((record, index) => componentPart(index, record, format, stats));

  const pins: RawPin[] = [], reader = new Reader(container.stream('/Pads6/Data')!, 'Pads6', format);
  let padCount = 0;
  while (reader.remaining > 0) {
    if (++padCount > MAX_PADS) fail(format, 'Altium Pads6 record count exceeds the import limit.', 'LIMIT_EXCEEDED');
    const type = reader.u8();
    if (type !== 2) reader.fail(`holding record type ${type}; only pad records (type 2) are understood`, 'UNSUPPORTED_VARIANT');
    const designator = reader.pascalBlock().trim();
    reader.block(); reader.block(); reader.block(); // sub-records 2-4 carry no geometry
    const main = reader.block();
    reader.block(); // sub-record 6: per-layer size/shape stack
    if (main.length < PAD_RECORD_MIN) fail(format, `Altium pad "${designator}" main record is ${main.length} bytes; the documented layout needs ${PAD_RECORD_MIN}.`, 'UNSUPPORTED_VARIANT');
    // Sub-record 5: layer u8 @0, net u16 @3, component u16 @7, X i32 @13, Y i32 @17, top size @21/@25, middle @29/@33, bottom @37/@41,
    // hole i32 @45, top/middle/bottom shape u8 @49/@50/@51, direction f64 @52, plated u8 @60, pad mode u8 @62.
    const fields = new DataView(main.buffer, main.byteOffset, main.byteLength);
    const layer = fields.getUint8(0), netIndex = fields.getUint16(3, true), componentIndex = fields.getUint16(7, true);
    if (netIndex !== ABSENT && netIndex >= nets.length) fail(format, `Altium pad "${designator}" references net ${netIndex} of ${nets.length}.`);
    if (componentIndex === ABSENT) { stats.free++; continue; }
    if (componentIndex >= parts.length) fail(format, `Altium pad "${designator}" references component ${componentIndex} of ${parts.length}.`);
    const label = `pad ${parts[componentIndex].ref}.${designator || `#${padCount}`}`, side = idLayerSide(layer, label, format);
    const mode = fields.getUint8(62);
    if (mode > 2) fail(format, `Altium ${label} has pad mode ${mode}, which is not documented.`, 'UNSUPPORTED_VARIANT');
    const topW = fields.getInt32(21, true), topH = fields.getInt32(25, true), botW = fields.getInt32(37, true), botH = fields.getInt32(41, true);
    const useBottom = layer === 32 && mode !== 0;
    const width = (useBottom ? botW : topW) * INTERNAL_UNIT_MM, height = (useBottom ? botH : topH) * INTERNAL_UNIT_MM;
    if (width <= 0 || height <= 0) fail(format, `Altium ${label} has non-positive dimensions.`);
    if (layer === 74 && mode !== 0 && (topW !== botW || topH !== botH || fields.getUint8(49) !== fields.getUint8(51))) stats.stackDiffers++;
    const shape = padShape(fields.getUint8(useBottom ? 51 : 49), width, height, label, format); if (shape.approximated) stats.approximated++;
    const rotation = fields.getFloat64(52, true);
    if (!Number.isFinite(rotation)) fail(format, `Altium ${label} has an invalid rotation.`);
    if (netIndex !== ABSENT && !nets[netIndex]) fail(format, `Altium ${label} references net ${netIndex}, which has no name.`);
    if (!designator) stats.emptyPads++;
    pins.push({ part: String(componentIndex), number: designator, name: designator, net: netIndex === ABSENT ? '' : nets[netIndex], side,
      x: finite(fields.getInt32(13, true) * INTERNAL_UNIT_MM, `${label} X`, format), y: finite(fields.getInt32(17, true) * INTERNAL_UNIT_MM, `${label} Y`, format),
      width, height, radius: Math.min(width, height) / 2, shape: shape.shape, rotation: angle(rotation) });
  }
  checkHeader(container.stream('/Pads6/Header'), padCount, 'Pads6', format);
  padNumbers(pins);
  const boardData = container.stream('/Board6/Data');
  const outline = boardData?.length ? outlineFromProps(new Reader(boardData, 'Board6', format).props(key => BOARD_KEY.test(key), MAX_BOARD_RECORD_BYTES), format, stats) : [];
  return assemble(input, format, parts, pins, outline, stats);
}

/** ASCII PcbDoc starts with a |HEADER= or |RECORD= line; sniffed on a short prefix so unrelated 64 MiB inputs are not decoded. */
function looksAscii(data: Uint8Array): boolean {
  const slice = data.subarray(0, 256);
  const head = startsWithBytes(slice, [0xff, 0xfe]) ? new TextDecoder('utf-16le').decode(slice) : startsWithBytes(slice, [0xfe, 0xff]) ? new TextDecoder('utf-16be').decode(slice) : asciiPrefix(slice, 256);
  return /^(?:﻿|\xEF\xBB\xBF)?\s*\|(?:RECORD|HEADER)=/i.test(head);
}

/** Altium Designer PCB documents: the ASCII export (|RECORD= lines) and the native OLE compound file. */
export function parseAltium(input: ParseInput): Board | null {
  try {
    if (startsWithBytes(input.data, CFB_MAGIC)) return parseBinary(input);
    return looksAscii(input.data) ? parseAscii(input) : null;
  } catch (error) {
    if (error instanceof BoardFormatError) throw error;
    const wrapped = new BoardFormatError(`Altium PcbDoc import failed unexpectedly: ${error instanceof Error ? error.message.slice(0, 160) : 'unknown error'}.`, 'INVALID_FORMAT', 'Altium PcbDoc');
    wrapped.cause = error; throw wrapped;
  }
}
