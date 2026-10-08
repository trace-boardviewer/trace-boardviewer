/**
 * KiCad legacy schematic parser: `.sch` files ("EESchema Schematic File Version 1..4") plus the symbol libraries
 * (`<name>-cache.lib` and other `.lib` companions, "EESchema-LIBRARY Version 2.x") that carry the symbol geometry.
 *
 * Provenance: written from the published legacy file-format description
 * (https://dev-docs.kicad.org/en/file-formats/legacy-4-to-6/legacy_file_format_documentation.pdf) and the conventions of
 * the files themselves; no KiCad source code was consulted. Things the published text does not cover (the `AR`
 * alternate-reference record, file versions above 1, label orientation codes, the `U` timestamp of `$Sheet`, the
 * `$EndSCHEMATC` terminator, the orientation-matrix reading) follow the task contract and are only proven by the
 * synthetic fixtures in kicad-legacy.test.ts.
 *
 * Units: file and library coordinates are mils; the schematic is Y down, the library Y up. Output is millimetres, Y
 * down, absolute on the sheet (see model.ts).
 */
import { boundText } from '../bounded-text';
import {
  SCHEMATIC_LIMITS, SchematicError,
  type SchBounds, type SchDiagnostic, type SchField, type SchGraphic, type SchLabel, type SchLabelKind, type SchPin, type SchPinType,
  type SchPoint, type SchSeverity, type SchSheetDef, type SchSheetInstance, type SchSheetPin, type SchSheetRef, type SchSymbol,
  type Schematic, type SchematicInput, type SchematicParser,
} from './model';

const FORMAT = 'kicad-legacy-sch' as const;
const HEADER = 'EESchema Schematic File Version';
const LIB_HEADER = 'EESchema-LIBRARY Version';
const MAX_VERSION = 4;
const MIL_MM = 0.0254;
const DIAG_CAP = 200;
const ARC_STEP_DEG = 10;

const invalid = (message: string) => new SchematicError(message, 'INVALID_FORMAT', FORMAT);
const exceeded = (message: string) => new SchematicError(message, 'LIMIT_EXCEEDED', FORMAT);

/** mils → mm, rounded to 1e-6 mm so exact mil inputs give clean decimals; `+ 0` folds -0 into 0. */
function mm(mil: number): number {
  const value = Math.round(mil * MIL_MM * 1e6) / 1e6;
  // Written so that NaN (0 times an infinite length) and infinity fail the test too.
  if (!(Math.abs(value) <= SCHEMATIC_LIMITS.maxCoordinateMm)) throw exceeded(`Coordinate ${mil} mil exceeds the ${SCHEMATIC_LIMITS.maxCoordinateMm} mm limit`);
  return value + 0;
}
const pt = (x: number, y: number): SchPoint => ({ x: mm(x), y: mm(y) });

// ---------------------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------------------

function startsWithHeader(data: Uint8Array, header: string): boolean {
  let i = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  while (i < data.length && (data[i] === 0x20 || data[i] === 0x09 || data[i] === 0x0a || data[i] === 0x0d)) i++;
  if (data.length - i < header.length) return false;
  for (let k = 0; k < header.length; k++) if (data[i + k] !== header.charCodeAt(k)) return false;
  return true;
}

/** UTF-8 first (KiCad writes UTF-8), Windows-1252 for older files; the BOM is dropped by the decoder. */
function decode(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}

const NUM = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
function num(token: string | undefined, what: string, where: string): number {
  if (token === undefined || !NUM.test(token)) throw invalid(`${where}: ${what} is not a number ("${(token ?? '').slice(0, 24)}")`);
  return Number(token);
}
function int(token: string | undefined, what: string, where: string, min: number, max = 1e9): number {
  const value = num(token, what, where);
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(`${where}: ${what} must be an integer from ${min} to ${max} ("${token}")`);
  return value;
}

/** Whitespace-separated tokens; a token that starts with `"` runs to the closing quote (`\"` and `\\` are escapes). */
function tokenize(line: string, where: string): string[] {
  const out: string[] = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '"') {
      let text = '';
      let closed = false;
      for (i++; i < n; i++) {
        const d = line[i];
        if (d === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) { text += line[i + 1]; i++; continue; }
        if (d === '"') { closed = true; i++; break; }
        text += d;
      }
      if (!closed) throw invalid(`${where}: unterminated quoted string`);
      out.push(text);
    } else {
      let j = i;
      while (j < n && line[j] !== ' ' && line[j] !== '\t') j++;
      out.push(line.slice(i, j));
      i = j;
    }
  }
  return out;
}

/** Text records escape a line break as `\n` and a backslash as `\\`. */
const unescapeText = (text: string) => text.replace(/\\([\\n])/g, (_, c: string) => (c === 'n' ? '\n' : '\\'));
const baseName = (name: string) => name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
const stem = (file: string) => (file.lastIndexOf('.') > 0 ? file.slice(0, file.lastIndexOf('.')) : file);

class Diags {
  private readonly list: SchDiagnostic[] = [];
  private readonly counts = new Map<string, number>();
  add(severity: SchSeverity, code: string, message: string, extra: { defId?: string; at?: SchPoint } = {}): void {
    const count = (this.counts.get(code) ?? 0) + 1;
    this.counts.set(code, count);
    if (count <= DIAG_CAP) this.list.push({ severity, code, message: boundText(message), ...extra });
  }
  finish(): SchDiagnostic[] {
    for (const [code, count] of this.counts) if (count > DIAG_CAP) this.list.push({ severity: 'info', code: 'DIAGNOSTICS_TRUNCATED', message: `${count - DIAG_CAP} further ${code} diagnostics were suppressed` });
    return this.list;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Schematic text → raw records (mils, nothing resolved)
// ---------------------------------------------------------------------------------------------------------------

interface RawField { n: number; text: string; vertical: boolean; x: number; y: number; hidden: boolean; name: string | null }
interface RawComp {
  libId: string; ref: string; unit: number; convert: number; ts: string; x: number; y: number;
  ar: Array<{ path: string; ref: string; part: number }>; fields: RawField[]; m: [number, number, number, number];
}
interface RawSheetPin { n: number; name: string; shape: SchSheetPin['shape']; x: number; y: number }
interface RawSheetBlock { ts: string; x: number; y: number; w: number; h: number; name: string; file: string; pins: RawSheetPin[] }
interface RawLabel { kind: SchLabelKind; x: number; y: number; orient: number; text: string; shape?: SchLabel['shape'] }
interface RawNote { x: number; y: number; orient: number; size: number; text: string; italic: boolean }
type Seg = [number, number, number, number];
interface RawSheet {
  version: number; paper?: { w: number; h: number }; titleBlock: Record<string, string>;
  comps: RawComp[]; wires: Seg[]; buses: Seg[]; notesLines: Seg[]; entries: Seg[]; junctions: Array<[number, number]>;
  noConnects: Array<[number, number]>; labels: RawLabel[]; notes: RawNote[]; sheets: RawSheetBlock[];
}

// Matrix `a b c d` maps library (x, y up) to sheet offsets: x' = a x + b y, y' = c x + d y (Y down). `1 0 0 -1` is the
// unrotated placement. With T = [[a, -b], [c, -d]] (library Y flipped to screen Y) the result is T = Rot(rotation) * Mirror.
const ORIENTATIONS: Record<string, [number, 'none' | 'x' | 'y']> = {
  '1,0,0,-1': [0, 'none'], '0,-1,-1,0': [90, 'none'], '-1,0,0,1': [180, 'none'], '0,1,1,0': [270, 'none'],
  '1,0,0,1': [0, 'x'], '-1,0,0,-1': [0, 'y'], '0,-1,1,0': [270, 'x'], '0,1,-1,0': [90, 'x'],
};
const LABEL_SHAPES: Record<string, NonNullable<SchLabel['shape']>> = { Input: 'input', Output: 'output', BiDi: 'bidirectional', '3State': 'tri_state', UnSpc: 'passive' };
const SHEET_PIN_SHAPES: Record<string, SchSheetPin['shape']> = { I: 'input', O: 'output', B: 'bidirectional', T: 'tri_state', U: 'passive' };
const TEXT_KINDS = new Set(['Label', 'GLabel', 'HLabel', 'Notes']);
const FIELD_NAMES = ['Reference', 'Value', 'Footprint', 'Datasheet'];

function parseSheetText(text: string, defId: string, diags: Diags): RawSheet {
  if (text.includes('\u0000')) throw invalid('The file contains binary data (NUL bytes)');
  const lines = text.split(/\r\n|\r|\n/);
  let first = 0;
  while (first < lines.length && lines[first].trim() === '') first++;
  const header = /^\s*EESchema Schematic File Version\s+(\S+)/.exec(lines[first] ?? '');
  if (!header || !/^\d+$/.test(header[1])) throw invalid('The EESchema header line has no version number');
  const version = Number(header[1]);
  if (version < 1) throw invalid(`Invalid legacy schematic version ${version}`);
  if (version > MAX_VERSION) throw new SchematicError(`Legacy schematic file version ${version} is not supported (versions 1 to ${MAX_VERSION} are)`, 'UNSUPPORTED_VARIANT', FORMAT);

  const raw: RawSheet = { version, titleBlock: {}, comps: [], wires: [], buses: [], notesLines: [], entries: [], junctions: [], noConnects: [], labels: [], notes: [], sheets: [] };
  const unknown = (n: number, what: string) => diags.add('info', 'UNKNOWN_RECORD', `Ignored unknown record at line ${n + 1}: ${what.slice(0, 60)}`, { defId });
  const segment = (n: number, what: string): Seg => {
    const row = lines[n + 1];
    const where = `line ${n + 2}`;
    const t = row === undefined ? [] : row.trim().split(/\s+/);
    if (t.length !== 4) throw invalid(`${where}: ${what} needs a line with four coordinates`);
    return [num(t[0], 'x1', where), num(t[1], 'y1', where), num(t[2], 'x2', where), num(t[3], 'y2', where)];
  };
  const point = (t: string[], n: number, what: string): [number, number] => {
    const where = `line ${n + 1}`;
    if (t.length < 4) throw invalid(`${where}: ${what} needs two coordinates`);
    return [num(t[2], 'x', where), num(t[3], 'y', where)];
  };

  let ended = false;
  scan: for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const space = line.search(/\s/);
    const head = space < 0 ? line : line.slice(0, space);
    switch (head) {
      case '$EndSCHEMATC': ended = true; break scan;
      case 'EELAYER': break;
      case '$Descr': {
        const t = line.split(/\s+/);
        if (t.length >= 4 && NUM.test(t[2]) && NUM.test(t[3]) && Number(t[2]) > 0 && Number(t[3]) > 0) raw.paper = { w: Number(t[2]), h: Number(t[3]) };
        let j = i + 1;
        for (; j < lines.length; j++) {
          const row = lines[j].trim();
          if (row === '$EndDescr') break;
          const k = tokenize(row, `line ${j + 1}`);
          const key = k[0] === 'Title' ? 'title' : k[0] === 'Date' ? 'date' : k[0] === 'Rev' ? 'rev' : k[0] === 'Comp' ? 'company' : /^Comment[1-9]$/.test(k[0] ?? '') ? k[0].toLowerCase() : '';
          if (key && k[1]) raw.titleBlock[key] = k[1];
        }
        if (j >= lines.length) throw invalid(`Unterminated $Descr block starting at line ${i + 1}`);
        i = j;
        break;
      }
      case '$Comp': {
        const parsed = parseComp(lines, i, defId, diags);
        raw.comps.push(parsed.comp);
        if (raw.comps.length > SCHEMATIC_LIMITS.maxSymbolsPerDef) throw exceeded(`A sheet has more than ${SCHEMATIC_LIMITS.maxSymbolsPerDef} symbols`);
        i = parsed.end;
        break;
      }
      case '$Sheet': {
        const parsed = parseSheetBlock(lines, i, defId, diags);
        raw.sheets.push(parsed.sheet);
        i = parsed.end;
        break;
      }
      case 'Wire': {
        const t = line.split(/\s+/);
        const target = t[1] === 'Wire' && t[2] === 'Line' ? raw.wires : t[1] === 'Bus' && t[2] === 'Line' ? raw.buses : t[1] === 'Notes' && t[2] === 'Line' ? raw.notesLines : null;
        if (!target) { unknown(i, line); i++; break; }
        target.push(segment(i, line));
        if (raw.wires.length > SCHEMATIC_LIMITS.maxWiresPerDef || raw.buses.length > SCHEMATIC_LIMITS.maxWiresPerDef) throw exceeded(`A sheet has more than ${SCHEMATIC_LIMITS.maxWiresPerDef} wires or buses`);
        i++;
        break;
      }
      case 'Entry': {
        const t = line.split(/\s+/);
        if (!/^(Wire|Bus)$/.test(t[1] ?? '') || !/^(Line|Bus)$/.test(t[2] ?? '')) { unknown(i, line); i++; break; }
        raw.entries.push(segment(i, line));
        i++;
        break;
      }
      case 'Connection': raw.junctions.push(point(line.split(/\s+/), i, 'Connection')); break;
      case 'NoConn': raw.noConnects.push(point(line.split(/\s+/), i, 'NoConn')); break;
      case 'Text': {
        const t = line.split(/\s+/);
        if (i + 1 >= lines.length) throw invalid(`line ${i + 1}: Text record has no text line`);
        if (!TEXT_KINDS.has(t[1] ?? '')) { unknown(i, line); i++; break; }
        const where = `line ${i + 1}`;
        if (t.length < 6) throw invalid(`${where}: Text record is incomplete`);
        const x = num(t[2], 'x', where);
        const y = num(t[3], 'y', where);
        const orient = int(t[4], 'orientation', where, 0, 3);
        const size = num(t[5], 'size', where);
        const body = unescapeText(lines[i + 1]);
        if (t[1] === 'Notes') raw.notes.push({ x, y, orient, size, text: body, italic: t[6] === 'Italic' });
        else {
          const label: RawLabel = { kind: t[1] === 'Label' ? 'local' : t[1] === 'GLabel' ? 'global' : 'hierarchical', x, y, orient, text: body };
          if (label.kind !== 'local') {
            const shape = LABEL_SHAPES[t[6] ?? ''];
            if (shape) label.shape = shape;
            else unknown(i, `${t[1]} shape "${t[6] ?? ''}"`);
          }
          raw.labels.push(label);
        }
        i++;
        break;
      }
      case '$Bitmap': {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() !== '$EndBitmap') j++;
        if (j >= lines.length) throw invalid(`Unterminated $Bitmap block starting at line ${i + 1}`);
        diags.add('info', 'UNKNOWN_RECORD', `Ignored $Bitmap image at line ${i + 1} (bitmaps are not rendered)`, { defId });
        i = j;
        break;
      }
      default: {
        if (head.startsWith('LIBS:')) break;
        if (head.startsWith('$')) {
          const end = `$End${head.slice(1)}`;
          let j = i + 1;
          while (j < lines.length && lines[j].trim() !== end) j++;
          if (j >= lines.length) throw invalid(`Unterminated ${head} block starting at line ${i + 1}`);
          unknown(i, `${head} block`);
          i = j;
        } else unknown(i, line);
      }
    }
  }
  if (!ended) throw invalid('The file is truncated: the $EndSCHEMATC terminator was not found');
  return raw;
}

function parseComp(lines: string[], start: number, defId: string, diags: Diags): { comp: RawComp; end: number } {
  const at = `$Comp block at line ${start + 1}`;
  let libId: string | null = null; let ref = '';
  let placement: { unit: number; convert: number; ts: string } | null = null;
  let position: [number, number] | null = null;
  let matrix: [number, number, number, number] | null = null;
  const fields: RawField[] = [];
  const ar: RawComp['ar'] = [];
  let j = start + 1;
  for (; j < lines.length; j++) {
    const row = lines[j].trim();
    if (row === '$EndComp') break;
    if (row === '') continue;
    const where = `line ${j + 1}`;
    if (row.startsWith('$')) throw invalid(`${where}: ${row.split(/\s/)[0]} inside a $Comp block (unterminated $Comp from line ${start + 1})`);
    const t = tokenize(row, where);
    const fieldMatch = /^F(\d*)$/.exec(t[0]);
    if (t[0] === 'L') {
      if (t.length < 3) throw invalid(`${where}: L record needs a library name and a reference`);
      libId = t[1]; ref = t[2];
    } else if (t[0] === 'U') {
      if (t.length < 3) throw invalid(`${where}: U record needs a unit and a body style`);
      placement = { unit: int(t[1], 'unit', where, 0), convert: int(t[2], 'body style', where, 0), ts: t[3] ?? '' };
    } else if (t[0] === 'P') {
      if (t.length < 3) throw invalid(`${where}: P record needs two coordinates`);
      position = [num(t[1], 'x', where), num(t[2], 'y', where)];
    } else if (t[0] === 'AR') {
      const attrs: Record<string, string> = {};
      // `\b`: a name starts at the start of a word. Without it every letter of a long run of word characters without `="` is tried as a start (quadratic); the matches are the same.
      for (const m of row.matchAll(/\b(\w+)="((?:[^"\\]|\\.)*)"/g)) attrs[m[1]] = m[2].replace(/\\(["\\])/g, '$1');
      if (attrs.Path === undefined) throw invalid(`${where}: AR record has no Path`);
      ar.push({ path: attrs.Path, ref: attrs.Ref ?? '', part: attrs.Part === undefined ? NaN : int(attrs.Part, 'AR Part', where, 0) });
    } else if (fieldMatch) {
      const offset = fieldMatch[1] === '' ? 2 : 1;
      const n = fieldMatch[1] === '' ? int(t[1], 'field number', where, 0) : Number(fieldMatch[1]);
      const f = t.slice(offset);
      if (f.length < 6) throw invalid(`${where}: field record is incomplete`);
      if (f[1] !== 'H' && f[1] !== 'V') throw invalid(`${where}: field orientation must be H or V`);
      if (!/^[0-9A-Fa-f]{1,8}$/.test(f[5])) throw invalid(`${where}: field flags are not hexadecimal ("${f[5]}")`);
      fields.push({ n, text: f[0], vertical: f[1] === 'V', x: num(f[2], 'field x', where), y: num(f[3], 'field y', where), hidden: (parseInt(f[5], 16) & 1) === 1, name: f[8] ?? null });
    } else if (/^[-+]?\d/.test(t[0]) && t.length === 3) {
      // "unit x y" repeats P; nothing to read.
    } else if (/^[-+]?\d/.test(t[0]) && t.length === 4) {
      const m = t.map((token, k) => int(token, `matrix entry ${k + 1}`, where, -1, 1)) as [number, number, number, number];
      if (!ORIENTATIONS[m.join(',')]) throw invalid(`${where}: "${row}" is not a rotation/mirror orientation matrix`);
      matrix = m;
    } else diags.add('info', 'UNKNOWN_RECORD', `Ignored unknown record at line ${j + 1} in a $Comp block: ${row.slice(0, 60)}`, { defId });
  }
  if (j >= lines.length) throw invalid(`Unterminated $Comp block starting at line ${start + 1}`);
  if (libId === null) throw invalid(`${at} lacks the L record (library name and reference)`);
  if (!placement) throw invalid(`${at} lacks the U record (unit, body style and timestamp)`);
  if (!position) throw invalid(`${at} lacks the P record (position)`);
  if (!matrix) throw invalid(`${at} lacks the orientation matrix line`);
  return { comp: { libId, ref, unit: placement.unit, convert: placement.convert, ts: placement.ts, x: position[0], y: position[1], ar, fields, m: matrix }, end: j };
}

function parseSheetBlock(lines: string[], start: number, defId: string, diags: Diags): { sheet: RawSheetBlock; end: number } {
  const at = `$Sheet block at line ${start + 1}`;
  let geometry: [number, number, number, number] | null = null;
  let ts = ''; let name: string | null = null; let file: string | null = null;
  const pins: RawSheetPin[] = [];
  let j = start + 1;
  for (; j < lines.length; j++) {
    const row = lines[j].trim();
    if (row === '$EndSheet') break;
    if (row === '') continue;
    const where = `line ${j + 1}`;
    if (row.startsWith('$')) throw invalid(`${where}: ${row.split(/\s/)[0]} inside a $Sheet block (unterminated $Sheet from line ${start + 1})`);
    const t = tokenize(row, where);
    const fieldMatch = /^F(\d+)$/.exec(t[0]);
    if (t[0] === 'S') {
      if (t.length < 5) throw invalid(`${where}: S record needs position and size`);
      geometry = [num(t[1], 'x', where), num(t[2], 'y', where), num(t[3], 'width', where), num(t[4], 'height', where)];
    } else if (t[0] === 'U') ts = t[1] ?? '';
    else if (fieldMatch) {
      const n = Number(fieldMatch[1]);
      if (n === 0) name = t[1] ?? '';
      else if (n === 1) file = t[1] ?? '';
      else {
        if (t.length < 6) throw invalid(`${where}: sheet pin record is incomplete`);
        const shape = SHEET_PIN_SHAPES[t[2]];
        if (!shape) diags.add('info', 'UNKNOWN_RECORD', `Sheet pin shape "${t[2]}" at line ${j + 1} is unknown; treated as unspecified`, { defId });
        pins.push({ n, name: t[1], shape: shape ?? 'passive', x: num(t[4], 'x', where), y: num(t[5], 'y', where) });
      }
    } else diags.add('info', 'UNKNOWN_RECORD', `Ignored unknown record at line ${j + 1} in a $Sheet block: ${row.slice(0, 60)}`, { defId });
  }
  if (j >= lines.length) throw invalid(`Unterminated $Sheet block starting at line ${start + 1}`);
  if (!geometry) throw invalid(`${at} lacks the S record (position and size)`);
  if (file === null) throw invalid(`${at} lacks the F1 record (file name)`);
  return { sheet: { ts, x: geometry[0], y: geometry[1], w: geometry[2], h: geometry[3], name: name ?? '', file, pins }, end: j };
}

// ---------------------------------------------------------------------------------------------------------------
// Libraries
// ---------------------------------------------------------------------------------------------------------------

interface LibPin { name: string; number: string; x: number; y: number; length: number; dir: [number, number]; unit: number; convert: number; type: SchPinType; hidden: boolean }
type LibShape = { unit: number; convert: number } & (
  | { kind: 'poly'; width: number; filled: boolean; pts: Array<[number, number]> }
  | { kind: 'rect'; width: number; fill: 'none' | 'outline' | 'background'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'circle'; width: number; fill: 'none' | 'outline' | 'background'; x: number; y: number; r: number }
  | { kind: 'text'; x: number; y: number; size: number; vertical: boolean; text: string; anchor: 'start' | 'middle' | 'end'; italic: boolean; bold: boolean }
);
interface LibNote { severity: SchSeverity; code: string; message: string }
interface LibDef { name: string; refPrefix: string; power: boolean; unitCount: number; hasConvert: boolean; pins: LibPin[]; shapes: LibShape[]; notes: LibNote[] }
interface LibEntry { name: string; start: number; end: number; aliases: string[] }

const PIN_DIRS: Record<string, [number, number]> = { R: [1, 0], L: [-1, 0], U: [0, 1], D: [0, -1] };
const PIN_TYPES: Record<string, SchPinType> = { I: 'input', O: 'output', B: 'bidirectional', T: 'tri_state', P: 'passive', U: 'unspecified', W: 'power_in', w: 'power_out', C: 'open_collector', E: 'open_emitter', N: 'no_connect' };
const fillOf = (cc: string | undefined): 'none' | 'outline' | 'background' => (cc === 'F' ? 'outline' : cc === 'f' ? 'background' : 'none');
const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

/**
 * Library arcs carry centre, radius, two angles (tenths of a degree) and, in newer files, both end points. Legacy arcs
 * are the shorter way round (CCW in the library's Y-up space); an exact half circle runs CCW from the first end point.
 */
function sampleArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number, ends: [number, number, number, number] | null): Array<[number, number]> {
  let from: number;
  let sweep: number;
  if (ends) {
    const p = Math.atan2(ends[1] - cy, ends[0] - cx) * 180 / Math.PI;
    const q = Math.atan2(ends[3] - cy, ends[2] - cx) * 180 / Math.PI;
    const ccw = norm360(q - p);
    if (ccw < 1e-6) { from = p; sweep = 360; } else if (ccw <= 180 + 1e-3) { from = p; sweep = ccw; } else { from = q; sweep = 360 - ccw; }
  } else {
    const a = startAngle / 10;
    const b = endAngle / 10;
    const ccw = norm360(b - a);
    if (ccw < 1e-6) { from = a; sweep = 360; } else if (ccw <= 180 + 1e-3) { from = a; sweep = ccw; } else { from = b; sweep = 360 - ccw; }
  }
  const steps = Math.max(2, Math.ceil(sweep / ARC_STEP_DEG));
  const points: Array<[number, number]> = [];
  for (let k = 0; k <= steps; k++) {
    const angle = (from + sweep * k / steps) * Math.PI / 180;
    points.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return points;
}

function parseLibDef(lines: string[], entry: LibEntry, label: string): LibDef {
  if (entry.end < 0) throw invalid(`${label}: entry ${entry.name} has no ENDDEF`);
  const whereOf = (n: number) => `${label} line ${n + 1}`;
  const head = tokenize(lines[entry.start], whereOf(entry.start));
  if (head.length < 9) throw invalid(`${whereOf(entry.start)}: DEF record is incomplete`);
  const def: LibDef = {
    name: entry.name, refPrefix: head[2], power: head[9] === 'P', unitCount: int(head[7], 'unit count', whereOf(entry.start), 1, 1000),
    hasConvert: false, pins: [], shapes: [], notes: [],
  };
  const note = (severity: SchSeverity, code: string, n: number, message: string) => def.notes.push({ severity, code, message: `${whereOf(n)} (${entry.name}): ${message}` });
  let drawing = false;
  let inFootprints = false;
  for (let n = entry.start + 1; n < entry.end; n++) {
    const row = lines[n].trim();
    if (row === '' || row.startsWith('#')) continue;
    if (inFootprints) { if (row === '$ENDFPLIST') inFootprints = false; continue; }
    if (row === '$FPLIST') { inFootprints = true; continue; }
    if (row === 'DRAW') { drawing = true; continue; }
    if (row === 'ENDDRAW') { drawing = false; continue; }
    const where = whereOf(n);
    const t = tokenize(row, where);
    const kind = t[0];
    if (!drawing) {
      if (!/^F\d*$/.test(kind) && kind !== 'ALIAS') note('info', 'UNKNOWN_RECORD', n, `ignored unknown record "${row.slice(0, 40)}"`);
      continue;
    }
    switch (kind) {
      case 'P': {
        const count = int(t[1], 'point count', where, 1, 100000);
        if (t.length < 5 + 2 * count) throw invalid(`${where}: polyline has fewer than ${count} points`);
        const pts: Array<[number, number]> = [];
        for (let k = 0; k < count; k++) pts.push([num(t[5 + 2 * k], 'x', where), num(t[6 + 2 * k], 'y', where)]);
        const cc = t[5 + 2 * count];
        def.shapes.push({ kind: 'poly', unit: int(t[2], 'unit', where, 0), convert: int(t[3], 'body style', where, 0), width: num(t[4], 'thickness', where), filled: cc === 'F' || cc === 'f', pts });
        break;
      }
      case 'S':
        if (t.length < 8) throw invalid(`${where}: rectangle is incomplete`);
        def.shapes.push({ kind: 'rect', unit: int(t[5], 'unit', where, 0), convert: int(t[6], 'body style', where, 0), width: num(t[7], 'thickness', where), fill: fillOf(t[8]), x1: num(t[1], 'x', where), y1: num(t[2], 'y', where), x2: num(t[3], 'x', where), y2: num(t[4], 'y', where) });
        break;
      case 'C':
        if (t.length < 7) throw invalid(`${where}: circle is incomplete`);
        def.shapes.push({ kind: 'circle', unit: int(t[4], 'unit', where, 0), convert: int(t[5], 'body style', where, 0), width: num(t[6], 'thickness', where), fill: fillOf(t[7]), x: num(t[1], 'x', where), y: num(t[2], 'y', where), r: num(t[3], 'radius', where) });
        break;
      case 'A': {
        if (t.length < 9) throw invalid(`${where}: arc is incomplete`);
        const ends = t.length >= 14 ? [num(t[10], 'x', where), num(t[11], 'y', where), num(t[12], 'x', where), num(t[13], 'y', where)] as [number, number, number, number] : null;
        const pts = sampleArc(num(t[1], 'x', where), num(t[2], 'y', where), num(t[3], 'radius', where), num(t[4], 'start angle', where), num(t[5], 'end angle', where), ends);
        const cc = t[9];
        def.shapes.push({ kind: 'poly', unit: int(t[6], 'unit', where, 0), convert: int(t[7], 'body style', where, 0), width: num(t[8], 'thickness', where), filled: cc === 'F' || cc === 'f', pts });
        break;
      }
      case 'T': {
        if (t.length < 9) throw invalid(`${where}: text is incomplete`);
        const orientation = int(t[1], 'orientation', where, 0, 3600);
        if (![0, 1, 900, 1800, 2700].includes(orientation)) throw invalid(`${where}: unsupported text orientation ${orientation}`);
        const hj = t[11];
        def.shapes.push({
          kind: 'text', unit: int(t[6], 'unit', where, 0), convert: int(t[7], 'body style', where, 0), x: num(t[2], 'x', where), y: num(t[3], 'y', where), size: num(t[4], 'size', where),
          vertical: orientation === 1 || orientation === 900 || orientation === 2700, text: t[8], anchor: hj === 'L' ? 'start' : hj === 'R' ? 'end' : 'middle', italic: t[9] === 'Italic', bold: t[10] === '1',
        });
        break;
      }
      case 'X': {
        if (t.length < 12) throw invalid(`${where}: pin is incomplete`);
        const dir = PIN_DIRS[t[6]];
        if (!dir) throw invalid(`${where}: pin orientation must be U, D, L or R ("${t[6]}")`);
        let type = PIN_TYPES[t[11]];
        if (!type) { note('warning', 'UNKNOWN_PIN_TYPE', n, `unknown electrical type "${t[11]}" treated as unspecified`); type = 'unspecified'; }
        def.pins.push({
          name: t[1] === '~' ? '' : t[1], number: t[2], x: num(t[3], 'x', where), y: num(t[4], 'y', where), length: num(t[5], 'length', where), dir,
          unit: int(t[9], 'unit', where, 0), convert: int(t[10], 'body style', where, 0), type, hidden: (t[12] ?? '').startsWith('N'),
        });
        break;
      }
      default:
        note('info', 'UNKNOWN_RECORD', n, `ignored unknown record "${row.slice(0, 40)}"`);
    }
  }
  def.hasConvert = def.pins.some(p => p.convert === 2) || def.shapes.some(s => s.convert === 2);
  return def;
}

class LibFile {
  private index: Map<string, LibEntry> | null = null;
  private lines: string[] = [];
  private readonly parsed = new Map<LibEntry, LibDef | { error: string }>();
  constructor(readonly key: string, private readonly data: Uint8Array) {}

  entries(diags: Diags): Map<string, LibEntry> {
    if (this.index) return this.index;
    const index = new Map<string, LibEntry>();
    this.index = index;
    const text = startsWithHeader(this.data, LIB_HEADER) ? decode(this.data) : '';
    if (!/^\s*EESchema-LIBRARY Version\s+2(?:\.|\s|$)/.test(text)) {
      diags.add('warning', 'LIB_FILE_INVALID', `${this.key} is not a legacy symbol library (EESchema-LIBRARY Version 2.x) and was ignored`);
      return index;
    }
    const lines = text.split(/\r\n|\r|\n/);
    this.lines = lines;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('DEF ')) continue;
      const name = lines[i].trim().split(/\s+/)[1];
      let end = -1;
      const aliases: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].startsWith('ENDDEF')) { end = j; break; }
        if (lines[j].startsWith('DEF ')) break;
        if (lines[j].startsWith('ALIAS ')) aliases.push(...lines[j].trim().split(/\s+/).slice(1));
      }
      if (name) {
        const entry: LibEntry = { name, start: i, end, aliases };
        for (const alias of [name, ...aliases]) if (!index.has(alias)) index.set(alias, entry);
      }
      i = end >= 0 ? end : j - 1;
    }
    return index;
  }

  definition(entry: LibEntry): LibDef | { error: string } {
    let result = this.parsed.get(entry);
    if (!result) {
      try { result = parseLibDef(this.lines, entry, this.key); } catch (error) {
        if (!(error instanceof SchematicError)) throw error;
        result = { error: error.message };
      }
      this.parsed.set(entry, result);
    }
    return result;
  }
}

/** Project cache first (it is the snapshot saved with the schematic), then the other libraries in name order. */
class Libraries {
  private readonly files: LibFile[];
  private readonly cacheKey: string;
  private readonly reported = new Set<LibDef>();
  constructor(companions: Record<string, Uint8Array>, rootKey: string, private readonly diags: Diags) {
    const cache = `${stem(rootKey)}-cache.lib`;
    const keys = Object.keys(companions).filter(key => key.endsWith('.lib')).sort((a, b) => (a === cache ? -1 : b === cache ? 1 : a < b ? -1 : a > b ? 1 : 0));
    this.files = keys.map(key => new LibFile(key, companions[key]));
    this.cacheKey = cache;
  }

  private lookup(files: LibFile[], name: string): { file: LibFile; entry: LibEntry } | null {
    for (const file of files) {
      const entry = file.entries(this.diags).get(name);
      if (entry) return { file, entry };
    }
    return null;
  }

  /** `Nick:Name` is looked up as the cache's `Nick_Name`, then `nick.lib`, then everywhere; a bare name only everywhere. */
  find(libId: string): LibDef | { error: string } | null {
    const colon = libId.indexOf(':');
    const nick = colon > 0 ? libId.slice(0, colon) : '';
    const part = colon > 0 ? libId.slice(colon + 1) : libId;
    const cacheFiles = this.files.filter(file => file.key === this.cacheKey);
    let hit: { file: LibFile; entry: LibEntry } | null = null;
    if (nick) {
      hit = this.lookup(cacheFiles, `${nick}_${part}`)
        ?? this.lookup(this.files.filter(file => file.key === `${nick.toLowerCase()}.lib`), part)
        ?? this.lookup(this.files, libId) ?? this.lookup(this.files, `${nick}_${part}`) ?? this.lookup(this.files, part);
    } else hit = this.lookup(this.files, libId);
    if (!hit) return null;
    const result = hit.file.definition(hit.entry);
    if ('error' in result) return result;
    if (!this.reported.has(result)) {
      this.reported.add(result);
      for (const note of result.notes) this.diags.add(note.severity, note.code, note.message);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------------------------

interface Xf { a: number; b: number; c: number; d: number; ox: number; oy: number }
const place = (t: Xf, x: number, y: number): SchPoint => pt(t.ox + t.a * x + t.b * y, t.oy + t.c * x + t.d * y);

class Extent {
  minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
  add(p: SchPoint): void {
    if (p.x < this.minX) this.minX = p.x;
    if (p.x > this.maxX) this.maxX = p.x;
    if (p.y < this.minY) this.minY = p.y;
    if (p.y > this.maxY) this.maxY = p.y;
  }
  get empty(): boolean { return this.minX > this.maxX; }
  bounds(): SchBounds { return { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY }; }
}

function addGraphic(extent: Extent, g: SchGraphic): void {
  switch (g.kind) {
    case 'poly': for (const p of g.points) extent.add(p); break;
    case 'rect': extent.add(g.min); extent.add(g.max); break;
    case 'circle': extent.add({ x: g.center.x - g.radius, y: g.center.y - g.radius }); extent.add({ x: g.center.x + g.radius, y: g.center.y + g.radius }); break;
    case 'text': extent.add(g.at); break;
  }
}

function assignIds(stamps: string[], prefix: string, what: string, defId: string, diags: Diags): string[] {
  const usable = (s: string) => s !== '' && !s.includes('/');
  const count = new Map<string, number>();
  for (const s of stamps) if (usable(s)) count.set(s, (count.get(s) ?? 0) + 1);
  const used = new Set<string>();
  for (const [s, c] of count) if (c === 1) used.add(s);
  const ids = stamps.map((s, index) => {
    if (usable(s) && count.get(s) === 1) return s;
    let candidate = `${prefix}${index}`;
    while (used.has(candidate)) candidate += '_';
    used.add(candidate);
    return candidate;
  });
  for (const [s, c] of count) if (c > 1) diags.add('warning', 'DUPLICATE_TIMESTAMP', `${c} ${what} share the timestamp ${s}; their ids fall back to ${prefix}<index>`, { defId });
  return ids;
}

/** Hierarchical sheets can only be taken from the same directory; a path component means another directory. */
const companionKey = (file: string): string | null => (file === '' || /[\\/]/.test(file) ? null : file.toLowerCase());
/** The page size from the $Descr line, held to the same coordinate limit as every point (a size of 300 digits is infinity: the sheet would have no bounds). */
function paperMm(mil: number): number {
  const value = Math.round(mil * MIL_MM * 10) / 10;
  if (!(value <= SCHEMATIC_LIMITS.maxCoordinateMm)) throw exceeded(`Page size ${mil} mil exceeds the ${SCHEMATIC_LIMITS.maxCoordinateMm} mm limit`);
  return value;
}

class Loader {
  private readonly diags = new Diags();
  private readonly defs: SchSheetDef[] = [];
  private readonly byKey = new Map<string, SchSheetDef>();
  private readonly pinCounts = new Map<string, number>();
  private readonly libs: Libraries;
  private readonly companions: Record<string, Uint8Array>;
  private rootVersion = 0;

  constructor(private readonly input: SchematicInput) {
    this.companions = input.companions ?? {};
    this.libs = new Libraries(this.companions, (baseName(input.name) || 'schematic.sch').toLowerCase(), this.diags);
  }

  run(): Schematic {
    const file = baseName(this.input.name) || 'schematic.sch';
    const root = this.load(file.toLowerCase(), file, this.input.data, true);
    const instances = this.expand(root);
    return {
      format: FORMAT, formatLabel: `KiCad legacy schematic (version ${this.rootVersion})`, sourceUnit: 'mil', name: stem(file),
      defs: this.defs, rootDefId: root.id, instances, diagnostics: this.diags.finish(),
    };
  }

  private load(key: string, file: string, data: Uint8Array, isRoot = false): SchSheetDef {
    if (this.defs.length >= SCHEMATIC_LIMITS.maxSheetDefs) throw exceeded(`The hierarchy has more than ${SCHEMATIC_LIMITS.maxSheetDefs} distinct sheet files`);
    const raw = parseSheetText(decode(data), key, this.diags);
    if (isRoot) this.rootVersion = raw.version;
    const { def, refs } = this.build(raw, key, file);
    this.defs.push(def);
    this.byKey.set(key, def);
    refs.forEach(ref => this.resolve(def, ref));
    return def;
  }

  private resolve(def: SchSheetDef, ref: SchSheetRef): void {
    const key = companionKey(ref.file);
    const missing = (why: string) => this.diags.add('warning', 'SHEET_FILE_MISSING', `Sheet "${ref.name}" refers to "${ref.file}", ${why}`, { defId: def.id });
    if (key === null) { missing('which is not a file name in the schematic\'s own directory; it was not loaded'); return; }
    const known = this.byKey.get(key);
    if (known) { ref.defId = known.id; return; }
    const bytes = this.companions[key];
    if (!bytes) { missing('which was not among the loaded files'); return; }
    if (!startsWithHeader(bytes, HEADER)) throw invalid(`Sub-sheet "${ref.file}" is not a KiCad legacy schematic`);
    ref.defId = this.load(key, ref.file, bytes).id;
  }

  private expand(root: SchSheetDef): SchSheetInstance[] {
    const out: SchSheetInstance[] = [];
    let pins = 0;
    const stack: string[] = [];
    const walk = (def: SchSheetDef, path: string, name: string, parentPath: string | null, sheetRefId: string | null, depth: number): void => {
      if (stack.includes(def.id)) throw invalid(`The sheet hierarchy contains a cycle: ${[...stack, def.id].join(' -> ')}`);
      if (depth > SCHEMATIC_LIMITS.maxNestingDepth) throw exceeded(`The sheet hierarchy is nested deeper than ${SCHEMATIC_LIMITS.maxNestingDepth} levels`);
      if (out.length >= SCHEMATIC_LIMITS.maxInstances) throw exceeded(`The sheet hierarchy has more than ${SCHEMATIC_LIMITS.maxInstances} sheet instances`);
      pins += this.pinCounts.get(def.id) ?? 0;
      if (pins > SCHEMATIC_LIMITS.maxPinsTotal) throw exceeded(`The expanded hierarchy has more than ${SCHEMATIC_LIMITS.maxPinsTotal} pins`);
      const instance: SchSheetInstance = { path, defId: def.id, name, page: String(out.length + 1), parentPath, sheetRefId, childPaths: [], depth };
      out.push(instance);
      stack.push(def.id);
      for (const ref of def.sheetRefs) {
        if (ref.defId === null) continue;
        const childPath = `${path}/${ref.id}`;
        instance.childPaths.push(childPath);
        walk(this.byKey.get(ref.defId)!, childPath, ref.name, path, ref.id, depth + 1);
      }
      stack.pop();
    };
    walk(root, '', stem(root.file), null, null, 0);
    return out;
  }

  private build(raw: RawSheet, id: string, file: string): { def: SchSheetDef; refs: SchSheetRef[] } {
    const extent = new Extent();
    const symbolIds = assignIds(raw.comps.map(c => c.ts), 'sym', 'symbols', id, this.diags);
    let pinTotal = 0;
    const symbols = raw.comps.map((comp, index) => {
      const symbol = this.placeSymbol(comp, symbolIds[index], id);
      pinTotal += symbol.pins.length;
      extent.add({ x: symbol.bounds.minX, y: symbol.bounds.minY }); extent.add({ x: symbol.bounds.maxX, y: symbol.bounds.maxY });
      return symbol;
    });
    this.pinCounts.set(id, pinTotal);

    const wires = raw.wires.map((s, n) => ({ id: `w${n}`, a: pt(s[0], s[1]), b: pt(s[2], s[3]) }));
    const buses = raw.buses.map((s, n) => ({ id: `b${n}`, a: pt(s[0], s[1]), b: pt(s[2], s[3]) }));
    const busEntries = raw.entries.map((s, n) => ({ id: `e${n}`, at: pt(s[0], s[1]), to: pt(s[2], s[3]) }));
    const junctions = raw.junctions.map((p, n) => ({ id: `j${n}`, at: pt(p[0], p[1]) }));
    const noConnects = raw.noConnects.map((p, n) => ({ id: `nc${n}`, at: pt(p[0], p[1]) }));
    const labels: SchLabel[] = raw.labels.map((l, n) => {
      const label: SchLabel = { id: `l${n}`, kind: l.kind, text: l.text, at: pt(l.x, l.y), angle: l.orient * 90 };
      if (l.shape) label.shape = l.shape;
      return label;
    });
    const graphics: SchGraphic[] = raw.notesLines.map(s => ({ kind: 'poly', points: [pt(s[0], s[1]), pt(s[2], s[3])], width: 0, filled: false }));
    for (const note of raw.notes) {
      // Orientation 0/1 extend right/up from the anchor, 2/3 left/down; text always reads left-to-right or bottom-to-top.
      graphics.push({ kind: 'text', at: pt(note.x, note.y), text: note.text, angle: note.orient % 2 === 1 ? 90 : 0, size: mm(note.size), anchor: note.orient >= 2 ? 'end' : 'start', italic: note.italic });
    }

    const sheetIds = assignIds(raw.sheets.map(s => s.ts), 'sheet', 'sheet symbols', id, this.diags);
    const sheetRefs: SchSheetRef[] = raw.sheets.map((s, n) => ({
      id: sheetIds[n], name: s.name || stem(s.file), file: s.file, defId: null, at: pt(s.x, s.y), size: pt(s.w, s.h),
      pins: s.pins.map(p => ({ id: `${sheetIds[n]}#${p.n}`, name: p.name, at: pt(p.x, p.y), shape: p.shape })),
    }));

    for (const w of [...wires, ...buses]) { extent.add(w.a); extent.add(w.b); }
    for (const e of busEntries) { extent.add(e.at); extent.add(e.to); }
    for (const j of junctions) extent.add(j.at);
    for (const c of noConnects) extent.add(c.at);
    for (const l of labels) extent.add(l.at);
    for (const g of graphics) addGraphic(extent, g);
    for (const s of sheetRefs) { extent.add(s.at); extent.add({ x: s.at.x + s.size.x, y: s.at.y + s.size.y }); for (const p of s.pins) extent.add(p.at); }

    const paper = raw.paper ? { width: paperMm(raw.paper.w), height: paperMm(raw.paper.h) } : undefined;
    const bounds = !extent.empty ? extent.bounds() : paper ? { minX: 0, minY: 0, maxX: paper.width, maxY: paper.height } : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const def: SchSheetDef = {
      id, name: stem(file), file, title: raw.titleBlock.title ?? '', titleBlock: raw.titleBlock, symbols, wires, buses, busEntries, junctions, noConnects, labels, sheetRefs, graphics, bounds,
    };
    if (paper) def.paper = paper;
    return { def, refs: sheetRefs };
  }

  private placeSymbol(comp: RawComp, id: string, defId: string): SchSymbol {
    const [a, b, c, d] = comp.m;
    const [rotation, mirror] = ORIENTATIONS[comp.m.join(',')];
    const xf: Xf = { a, b, c, d, ox: comp.x, oy: comp.y };
    const at = pt(comp.x, comp.y);
    const field = (n: number) => comp.fields.find(f => f.n === n);
    const value = field(1)?.text ?? '';
    const fields: SchField[] = comp.fields.map(f => ({ name: f.name ?? FIELD_NAMES[f.n] ?? `Field${f.n}`, value: f.text, at: pt(f.x, f.y), angle: f.vertical ? 90 : 0, hidden: f.hidden }));

    const instances: SchSymbol['instances'] = {};
    for (const entry of comp.ar) {
      const segments = entry.path.startsWith('/') ? entry.path.slice(1).split('/') : null;
      const last = segments?.pop();
      if (!segments || comp.ts === '' || last !== comp.ts) {
        this.diags.add('warning', 'AR_PATH_MISMATCH', `Alternate reference "${entry.path}" of ${comp.ref || comp.libId} does not end in the component timestamp "${comp.ts}" and was ignored`, { defId, at });
        continue;
      }
      instances[segments.length ? `/${segments.join('/')}` : ''] = { ref: entry.ref, unit: Number.isNaN(entry.part) ? comp.unit : entry.part };
    }
    if (Object.keys(instances).length === 0) instances[''] = { ref: comp.ref, unit: comp.unit };

    const found = this.libs.find(comp.libId);
    const def = found && !('error' in found) ? found : null;
    if (!found) this.diags.add('warning', 'LIB_SYMBOL_MISSING', `Library symbol "${comp.libId}" used by ${comp.ref} was not found in the loaded libraries; the symbol has no pins`, { defId, at });
    else if ('error' in found) this.diags.add('error', 'LIB_SYMBOL_INVALID', `Library symbol "${comp.libId}" used by ${comp.ref} is unreadable (${found.error}); the symbol has no pins`, { defId, at });
    if (def && (comp.unit < 1 || comp.unit > def.unitCount)) this.diags.add('warning', 'UNIT_OUT_OF_RANGE', `${comp.ref} uses unit ${comp.unit} but "${comp.libId}" has ${def.unitCount}`, { defId, at });

    // A power flag (PWR_FLAG: power-output pin only) names no net: only a symbol with a power-INPUT pin, or a #PWR reference, does (W-open-sch-01).
    const isPower = ((def?.power ?? false) && def!.pins.some(p => p.type === 'power_in')) || comp.ref.startsWith('#PWR');
    let power: SchSymbol['power'];
    if (isPower) {
      if (value !== '') power = { net: value };
      else this.diags.add('warning', 'POWER_VALUE_MISSING', `Power symbol ${comp.ref} has an empty value, so its net is unknown`, { defId, at });
    }

    const extent = new Extent();
    extent.add(at);
    const pins: SchPin[] = [];
    const graphics: SchGraphic[] = [];
    if (def) {
      // A library without a second body style ignores the placed style, as its pins would otherwise all disappear.
      const wantConvert = def.hasConvert && comp.convert === 2 ? 2 : 1;
      const selected = (unit: number, convert: number) => (unit === 0 || unit === comp.unit) && (convert === 0 || convert === wantConvert);
      for (const p of def.pins) {
        if (!selected(p.unit, p.convert)) continue;
        const pin: SchPin = {
          id: '', number: p.number, name: p.name, at: place(xf, p.x, p.y), body: place(xf, p.x + p.dir[0] * p.length, p.y + p.dir[1] * p.length),
          type: p.type, hidden: p.hidden, unit: p.unit,
        };
        if (p.hidden && p.type === 'power_in' && !power) {
          if (p.name !== '') pin.implicitNet = p.name;
          else this.diags.add('warning', 'IMPLICIT_NET_UNNAMED', `Hidden power pin ${p.number} of ${comp.ref} has no name, so its implicit net is unknown`, { defId, at });
        }
        pins.push(pin);
        extent.add(pin.at); extent.add(pin.body);
      }
      for (const s of def.shapes) {
        if (!selected(s.unit, s.convert)) continue;
        const g = this.placeShape(s, xf);
        graphics.push(g);
        addGraphic(extent, g);
      }
    }
    const perNumber = new Map<string, number>();
    for (const p of pins) perNumber.set(p.number, (perNumber.get(p.number) ?? 0) + 1);
    const used = new Set<string>();
    const nextSuffix = new Map<string, number>();
    for (const p of pins) {
      let pinId = `${id}#${p.number}`;
      if (perNumber.get(p.number)! > 1) pinId += `@${p.unit}`;
      if (used.has(pinId)) {
        // Ids are never released, so the probe resumes where the previous repeat of this id stopped; the result is the same lowest
        // free suffix a search from 1 would find, and a library that repeats one pin thousands of times stays linear.
        let k = nextSuffix.get(pinId) ?? 1;
        while (used.has(`${pinId}.${k}`)) k++;
        nextSuffix.set(pinId, k + 1);
        pinId += `.${k}`;
      }
      used.add(pinId);
      p.id = pinId;
    }

    const symbol: SchSymbol = {
      id, libId: comp.libId, refDefault: comp.ref, instances, value, footprint: field(2)?.text ?? '', datasheet: field(3)?.text === '~' ? '' : field(3)?.text ?? '',
      unit: comp.unit, unitCount: def ? def.unitCount : Math.max(1, comp.unit), at, rotation, mirror, pins, graphics, fields,
      virtual: comp.ref.startsWith('#') || (def?.refPrefix.startsWith('#') ?? false) || (def?.power ?? false), dnp: false, bounds: extent.bounds(),
    };
    if (power) symbol.power = power;
    return symbol;
  }

  private placeShape(s: LibShape, xf: Xf): SchGraphic {
    switch (s.kind) {
      case 'poly': return { kind: 'poly', points: s.pts.map(p => place(xf, p[0], p[1])), width: mm(s.width), filled: s.filled };
      case 'rect': {
        const p = place(xf, s.x1, s.y1);
        const q = place(xf, s.x2, s.y2);
        return { kind: 'rect', min: { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y) }, max: { x: Math.max(p.x, q.x), y: Math.max(p.y, q.y) }, width: mm(s.width), fill: s.fill };
      }
      case 'circle': return { kind: 'circle', center: place(xf, s.x, s.y), radius: mm(s.r), width: mm(s.width), fill: s.fill };
      case 'text': {
        // Reading direction in library space (+x, or +y for vertical text) after the placement; text stays upright, so
        // a direction that points left (or down for vertical text) swaps start and end.
        const dx = s.vertical ? xf.b : xf.a;
        const dy = s.vertical ? xf.d : xf.c;
        const horizontal = Math.abs(dx) >= Math.abs(dy);
        const flipped = horizontal ? dx < 0 : dy > 0;
        const anchor = flipped ? (s.anchor === 'start' ? 'end' : s.anchor === 'end' ? 'start' : 'middle') : s.anchor;
        return { kind: 'text', at: place(xf, s.x, s.y), text: s.text, angle: horizontal ? 0 : 90, size: mm(s.size), anchor, italic: s.italic, bold: s.bold };
      }
    }
  }
}

export const parseKicadLegacySch: SchematicParser = input => {
  if (!startsWithHeader(input.data, HEADER)) return null;
  return new Loader(input).run();
};
