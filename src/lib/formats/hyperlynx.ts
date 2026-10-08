/*
 * Original TRACE adapter, MIT. HyperLynx BoardSim (.hyp) text reader.
 *
 * Format references (public documentation only; no code of any importer is used):
 *   - IBIS Open Forum BIRD 33 (https://www.ibis.org/birds/bird33.txt), the rejected 1995 proposal by the HyperLynx authors that
 *     the .hyp layout descends from: brace records {KEYWORD ...}, one parenthesised subrecord per line, keyword=value
 *     fields, SIGNAL/PLANE/DIELECTRIC stackup listed top to bottom, DEVICES with REF/NAME/L, PADSTACK=name[, drill] with
 *     (layer, shape, sx, sy, angle[, M|A|T]) elements (shape 0 oval/round, 1 rectangle/square, 2 oblong, angle counter-clockwise),
 *     NET=name with PIN X= Y= R=<ref>.<pin> P=<padstack>, perimeter arcs drawn clockwise from end 1 to end 2.
 *   - KiCad's developer documentation of its HyperLynx exporter (record spellings it writes, Y is already up, inches).
 *   - hyp2mat's documentation (GPL, read for behaviour only): optional record parameters, MDEF/ADEF default layers,
 *     "-1" for an empty shape, unquoted values that contain blanks, `*` comment lines.
 * Public descriptions found for this format are partial, so every guess is listed in `notes`/warnings or here:
 *   - {UNITS=ENGLISH ...} is inches and {UNITS=METRIC ...} millimetres (the second word is the metal-thickness unit only).
 *   - A component's side is the position of its L= layer in the stackup (first metal layer top, last bottom, EDGE both);
 *     names that are not in the stackup fall back to TOP/BOT words and are disclosed.
 *   - A pad's side is the PIN record's own L= layer when it has one, else the one outer layer its padstack lists (an edge-connector
 *     finger on the far side of its part), else the side of its component; a component whose every pad names the other side is read by
 *     its own layer (generic padstacks), and a padstack with a default (MDEF) element does not decide a side. A drilled padstack is both.
 *   - The file has no component origin, rotation or body: a part is rebuilt from the pads of the PIN records that name it
 *     (pads of unconnected pins are not in the file, so such a part shows fewer pins than the board has).
 *   - Every PIN record is one pad; the same pin name at several places or with several padstacks (thermal pads, a via in a pad) stays
 *     several pads, and only an exact repeat (pin, place, padstack) is merged. A repeated device reference is one component.
 * Bounded and linear: the text is scanned once, a number token is limited to 128 characters, a reference.pin value to 256, and
 * record counts have the same budgets as buildBoard.
 */
import type { Board, BoardSide, ParseIssue, Point } from '../types';
import { asciiPrefix, BoardFormatError, buildBoard, decodeText, note, stitchOutlines, type ParseInput, type RawBoard, type RawPart, type RawPin } from './common';

export const HYPERLYNX_FORMAT = 'HyperLynx (.hyp)';
/** Stable id for the format registry (the registry lists the reader; nothing here registers itself). */
export const HYPERLYNX_ID = 'hyperlynx';
const fail = (message: string, code: 'INVALID_FORMAT' | 'LIMIT_EXCEEDED' = 'INVALID_FORMAT') => new BoardFormatError(`HyperLynx: ${message}`, code, HYPERLYNX_FORMAT);

const MAX_PARTS = 250_000, MAX_PINS = 1_000_000, MAX_PADSTACKS = 500_000, MAX_PAD_ELEMENTS = 2_000_000, MAX_PADS_PER_STACK = 512;
const MAX_PERIMETER = 1_000_000, MAX_STACKUP = 4096, MAX_TOKEN = 128, MAX_REFERENCE = 256;
const SNIFF_BYTES = 16 * 1024;

export interface HyperlynxSniff {
  /** 0 = not this format, 1 = certain; adapters claim a file from 0.8 (0.5 when its extension also matches). */
  confidence: number;
  reason: string;
}

const KNOWN_FIRST = new Set(['VERSION', 'BOARD_FILE', 'DATA_MODE', 'UNITS', 'PLANE_SEP', 'BOARD', 'STACKUP', 'DEVICES', 'SUPPLIES', 'PADSTACK', 'NET', 'NET_CLASS', 'KEY', 'DATE', 'VENDOR']);
const UNITS_LINE = /^\{UNITS\s*=\s*(ENGLISH|METRIC)\b/i, BODY_LINE = /^\{(?:DEVICES|STACKUP|PADSTACK|NET|BOARD)\b/i, FIRST_RECORD = /^\{([A-Za-z_]+)/;
/** Pure text sniff over at most the first 16 KiB; linear (every line is tested with anchored, non-nested patterns). */
export function sniffHyperlynxText(head: string): HyperlynxSniff {
  const lines = head.slice(0, SNIFF_BYTES).replace(/^\uFEFF|^\xEF\xBB\xBF/, '').split(/\r\n|\n|\r/);
  let first: string | undefined, units = false, body = false;
  for (const raw of lines) {
    if (raw.charCodeAt(0) === 42) continue; // '*' in column 1 starts a comment line
    const line = raw.trim();
    if (!line) continue;
    if (first === undefined) {
      const match = FIRST_RECORD.exec(line);
      if (!match || !KNOWN_FIRST.has(match[1].toUpperCase())) return { confidence: 0, reason: 'the first record is not a HyperLynx {KEYWORD} record' };
      first = match[1].toUpperCase();
    }
    if (UNITS_LINE.test(line)) units = true;
    else if (BODY_LINE.test(line)) body = true;
  }
  if (first === undefined) return { confidence: 0, reason: 'no record found' };
  const base = first === 'VERSION' || first === 'BOARD_FILE' ? 0.5 : 0.3;
  const confidence = Math.min(1, base + (units ? 0.3 : 0) + (body ? 0.15 : 0));
  return { confidence, reason: `first record {${first}}${units ? ', {UNITS=ENGLISH|METRIC}' : ''}${body ? ', board records' : ''}` };
}
/** Byte-level sniff for a dispatcher: text only (a NUL in the first KiB is never HyperLynx); UTF-16 files arrive re-encoded as UTF-8. */
export function sniffHyperlynx(data: Uint8Array): HyperlynxSniff {
  if (!(data instanceof Uint8Array) || data.length < 8) return { confidence: 0, reason: 'too short' };
  const head = asciiPrefix(data, SNIFF_BYTES);
  if (head.slice(0, 1024).includes('\0')) return { confidence: 0, reason: 'binary data' };
  return sniffHyperlynxText(head);
}
const claimed = (sniff: HyperlynxSniff, name: string) => sniff.confidence >= 0.8 || sniff.confidence >= 0.5 && /\.hyp$/i.test(name);

const isSpace = (code: number) => code === 32 || code === 9 || code === 11 || code === 12;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const SUFFIX: Readonly<Record<string, number>> = { k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 };
function num(value: string | undefined, label: string, no: number): number {
  if (value === undefined || !value.trim()) throw fail(`line ${no}: missing ${label}.`);
  const text = value.trim();
  if (text.length > MAX_TOKEN) throw fail(`line ${no}: ${label} is longer than ${MAX_TOKEN} characters.`);
  let body = text, factor = 1;
  const last = text[text.length - 1];
  if (Object.hasOwn(SUFFIX, last)) { body = text.slice(0, -1); factor = SUFFIX[last]; } // the SI suffixes of the format's number syntax
  const result = DECIMAL.test(body) ? Number(body) * factor : Number.NaN;
  if (!Number.isFinite(result)) throw fail(`line ${no}: invalid ${label} "${text.slice(0, 40)}".`);
  return result;
}

/**
 * Quote-aware index of the unquoted `close` that ends the group opened just before `from`; a doubled quote inside a string toggles
 * twice, which is the same as an escape. With `open`, nested pairs are counted ("NAME=CAP(0402)" does not end a subrecord).
 */
function findClose(text: string, from: number, close: string, open?: string): number {
  let quoted = false, depth = 0;
  for (let index = from; index < text.length; index++) {
    const c = text[index];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (open !== undefined && c === open) depth++;
    else if (c === close) { if (depth === 0) return index; depth--; }
  }
  return -1;
}
const unquote = (value: string): string => value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"' ? value.slice(1, -1).replace(/""/g, '"') : value;
/** Comma separated positional fields, quote-aware; fields are trimmed and unquoted. */
function splitCommas(text: string): string[] {
  const out: string[] = [];
  let quoted = false, start = 0;
  for (let index = 0; index <= text.length; index++) {
    const c = index < text.length ? text[index] : ',';
    if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { out.push(unquote(text.slice(start, index).trim())); start = index + 1; }
  }
  return out;
}

interface Pairs { head: string; values: Map<string, string> }
/**
 * `HEAD KEY=value KEY="quoted value" KEY=value with blanks` -> head and uppercase keys. An unquoted value runs to the next
 * `<blank> WORD=` boundary (exporters write unquoted names with blanks); a blank run is examined once, so the scan is linear.
 */
function pairs(body: string, withHead: boolean): Pairs {
  const n = body.length, values = new Map<string, string>();
  let at = 0, head = '';
  const skip = () => { while (at < n && (isSpace(body.charCodeAt(at)) || body[at] === ',')) at++; };
  skip();
  if (withHead) {
    const start = at;
    while (at < n && !isSpace(body.charCodeAt(at)) && body[at] !== '=') at++;
    head = body.slice(start, at).toUpperCase();
  }
  while (at < n) {
    skip();
    const start = at;
    while (at < n && !isSpace(body.charCodeAt(at)) && body[at] !== '=') at++;
    if (at >= n || body[at] !== '=') continue; // a stray word without a value
    const key = body.slice(start, at).toUpperCase();
    at++;
    let value: string;
    if (body[at] === '"') {
      let end = at + 1;
      for (; end < n; end++) {
        if (body[end] !== '"') continue;
        if (body[end + 1] === '"') { end++; continue; }
        break;
      }
      value = body.slice(at + 1, end).replace(/""/g, '"');
      at = Math.min(n, end + 1);
    } else {
      let end = at;
      while (end < n) {
        if (isSpace(body.charCodeAt(end))) {
          let next = end;
          while (next < n && isSpace(body.charCodeAt(next))) next++;
          let word = next;
          while (word < n && !isSpace(body.charCodeAt(word)) && body[word] !== '=') word++;
          if (word < n && body[word] === '=' && word > next) break; // the next KEY=
          end = next; // keep the blank run as part of the value
        } else end++;
      }
      value = body.slice(at, end).trim();
      at = end;
    }
    if (!values.has(key)) values.set(key, value);
  }
  return { head, values };
}

interface Pad { layer: string; shape: number; sx: number; sy: number; angle: number }
interface Padstack { drill: number; pads: Pad[] }
interface Device { ref: string; name: string; value: string; layer: string; pkg: string }
interface PinRecord { ref: string; pin: string; x: number; y: number; stack: string; layer: string; net: string; no: number }
type Block = 'board' | 'stackup' | 'devices' | 'padstack' | 'net' | 'polygon' | 'other';
const LINE_RECORDS = new Set(['VERSION', 'DATE', 'VENDOR', 'BOARD_FILE', 'DATA_MODE', 'UNITS', 'PLANE_SEP', 'KEY', 'END']);
const BLOCKS = new Map<string, Block>([['BOARD', 'board'], ['STACKUP', 'stackup'], ['DEVICES', 'devices'], ['SUPPLIES', 'other'], ['PADSTACK', 'padstack'], ['NET', 'net'], ['NET_CLASS', 'other'], ['POLYGON', 'polygon'], ['POLYVOID', 'polygon'], ['POLYLINE', 'polygon']]);

const ARC_STEP = Math.PI / 32;
/** Clockwise from `a` to `b` around `center` (BIRD 33: "drawn clockwise from X1,Y1 to X2,Y2"); equal endpoints are a full circle. */
function clockwiseArc(a: Point, b: Point, center: Point): Point[] {
  const radius = Math.hypot(a.x - center.x, a.y - center.y), endRadius = Math.hypot(b.x - center.x, b.y - center.y);
  if (!(radius > 0)) return [a, b];
  const start = Math.atan2(a.y - center.y, a.x - center.x), end = Math.atan2(b.y - center.y, b.x - center.x);
  let sweep = start - end; // positive = clockwise
  sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (sweep < 1e-12) sweep = 2 * Math.PI;
  const steps = Math.max(2, Math.min(4096, Math.ceil(sweep / ARC_STEP))), points: Point[] = [a];
  for (let step = 1; step < steps; step++) {
    const angle = start - sweep * step / steps, r = radius + (endRadius - radius) * step / steps;
    points.push({ x: center.x + r * Math.cos(angle), y: center.y + r * Math.sin(angle) });
  }
  points.push(b);
  return points;
}

interface Model {
  unitsToMm: number;
  metal: string[];
  devices: Map<string, Device>;
  padstacks: Map<string, Padstack>;
  pins: PinRecord[];
  segments: Array<[Point, Point]>;
  arcs: number;
  ignored: { segments: number; vias: number; polygons: number };
  duplicates: number;
  repeatedDevices: number;
}

function readModel(text: string): Model {
  const devices = new Map<string, Device>(), padstacks = new Map<string, Padstack>(), pins: PinRecord[] = [], segments: Array<[Point, Point]> = [], metal: string[] = [];
  const ignored = { segments: 0, vias: 0, polygons: 0 }, seen = new Map<string, string>();
  let unitsToMm: number | undefined, ended = false, arcs = 0, padElements = 0, duplicates = 0, repeatedDevices = 0;
  let mode: Block | undefined, parent: Block | undefined, net = '', stack: Padstack | undefined;

  const closeBlock = () => { mode = mode === 'polygon' ? parent : undefined; if (mode !== 'padstack') stack = undefined; };
  const header = (block: Block, rest: string, no: number): void => {
    if (block === 'polygon') { ignored.polygons++; parent = mode; mode = 'polygon'; return; }
    mode = block; parent = undefined;
    if (block === 'net') {
      net = pairs(`NET${rest}`, false).values.get('NET') ?? '';
    } else if (block === 'padstack') {
      const fields = splitCommas(rest.replace(/^\s*=\s*/, ''));
      const name = fields[0] ?? '';
      if (!name) throw fail(`line ${no}: a PADSTACK record has no name.`);
      if (padstacks.has(name)) throw fail(`line ${no}: padstack "${name.slice(0, 40)}" is defined twice.`);
      if (padstacks.size >= MAX_PADSTACKS) throw fail('padstack count exceeds the import limit.', 'LIMIT_EXCEEDED');
      const drill = fields[1] ? num(fields[1], 'padstack drill size', no) : 0;
      stack = { drill, pads: [] }; padstacks.set(name, stack);
    }
  };
  const lineRecord = (keyword: string, content: string, no: number): void => {
    if (keyword === 'UNITS') {
      const words = content.replace(/^\s*=\s*/, '').trim().toUpperCase().split(/\s+/);
      const system = words[0], scale = system === 'ENGLISH' ? 25.4 : system === 'METRIC' ? 1 : undefined;
      if (scale === undefined) throw fail(`line ${no}: {UNITS} must be ENGLISH or METRIC, not "${(words[0] ?? '').slice(0, 20)}".`);
      if (unitsToMm !== undefined && unitsToMm !== scale) throw fail(`line ${no}: the file declares two different {UNITS}.`);
      unitsToMm = scale;
    } else if (keyword === 'END') ended = true;
  };
  const subrecord = (body: string, no: number): void => {
    if (mode === 'padstack') {
      if (!stack) return;
      const fields = splitCommas(body), type = (fields[5] ?? 'M').toUpperCase();
      if (type === 'A' || !fields[0]) return; // anti-pads open holes in planes: no copper
      if (stack.pads.length >= MAX_PADS_PER_STACK || ++padElements > MAX_PAD_ELEMENTS) throw fail('padstack elements exceed the import limit.', 'LIMIT_EXCEEDED');
      const sx = fields[2] ? num(fields[2], 'pad width', no) : 0, sy = fields[3] ? num(fields[3], 'pad height', no) : 0;
      stack.pads.push({ layer: fields[0], shape: fields[1] ? num(fields[1], 'pad shape', no) : -1, sx, sy, angle: fields[4] ? num(fields[4], 'pad angle', no) : 0 });
      return;
    }
    if (!mode || mode === 'polygon') return;
    const { head, values } = pairs(body, true);
    const need = (key: string, label: string) => num(values.get(key), label, no);
    if (mode === 'board') {
      if (head === 'PERIMETER_SEGMENT') {
        if (segments.length >= MAX_PERIMETER) throw fail('perimeter record count exceeds the import limit.', 'LIMIT_EXCEEDED');
        segments.push([{ x: need('X1', 'perimeter X1'), y: need('Y1', 'perimeter Y1') }, { x: need('X2', 'perimeter X2'), y: need('Y2', 'perimeter Y2') }]);
      } else if (head === 'PERIMETER_ARC') {
        const a = { x: need('X1', 'arc X1'), y: need('Y1', 'arc Y1') }, b = { x: need('X2', 'arc X2'), y: need('Y2', 'arc Y2') }, center = { x: need('XC', 'arc XC'), y: need('YC', 'arc YC') };
        if (segments.length >= MAX_PERIMETER) throw fail('perimeter record count exceeds the import limit.', 'LIMIT_EXCEEDED');
        const path = clockwiseArc(a, b, center); arcs++;
        for (let index = 1; index < path.length; index++) segments.push([path[index - 1], path[index]]);
      }
    } else if (mode === 'stackup') {
      if (head === 'SIGNAL' || head === 'PLANE') {
        if (metal.length >= MAX_STACKUP) throw fail('stackup layer count exceeds the import limit.', 'LIMIT_EXCEEDED');
        metal.push((values.get('L') ?? String(metal.length + 1)).trim());
      }
    } else if (mode === 'devices') {
      const ref = values.get('REF');
      if (!ref) throw fail(`line ${no}: a device record has no REF.`);
      if (devices.has(ref)) { repeatedDevices++; return; } // exporters write library parts such as logos with one shared reference: the first record wins
      if (devices.size >= MAX_PARTS) throw fail('component count exceeds the import limit.', 'LIMIT_EXCEEDED');
      devices.set(ref, { ref, name: values.get('NAME') ?? '', value: values.get('VAL') ?? '', layer: values.get('L') ?? '', pkg: values.get('PKG') ?? '' });
    } else if (mode === 'net') {
      if (head === 'PIN') {
        const reference = values.get('R');
        if (!reference) throw fail(`line ${no}: a PIN record has no R= reference.`);
        if (reference.length > MAX_REFERENCE) throw fail(`line ${no}: a pin reference is longer than ${MAX_REFERENCE} characters.`);
        const x = need('X', 'pin X'), y = need('Y', 'pin Y'), stackName = values.get('P') ?? '';
        const key = `${reference}\u0000${x}\u0000${y}\u0000${stackName}`, prior = seen.get(key);
        if (prior !== undefined) { if (prior !== net) duplicates++; return; } // the same pad (pin, place and padstack) listed again: one pad
        if (pins.length >= MAX_PINS) throw fail('pin count exceeds the import limit.', 'LIMIT_EXCEEDED');
        seen.set(key, net);
        // The reference designator ends at the last dot that follows a declared device, otherwise at the first dot.
        const last = reference.lastIndexOf('.'), first = reference.indexOf('.');
        if (first < 0) throw fail(`line ${no}: pin reference "${reference.slice(0, 40)}" has no ".pin" part.`);
        const cut = devices.has(reference.slice(0, last)) ? last : first;
        if (cut === 0) throw fail(`line ${no}: pin reference "${reference.slice(0, 40)}" has no component name.`);
        pins.push({ ref: reference.slice(0, cut), pin: reference.slice(cut + 1), x, y, stack: stackName, layer: values.get('L') ?? '', net, no });
      } else if (head === 'SEG' || head === 'ARC' || head === 'USEG') ignored.segments++;
      else if (head === 'VIA' || head === 'PAD') ignored.vias++;
    }
  };

  const lineCount = { value: 1 };
  let lf = text.indexOf('\n'), cr = text.indexOf('\r');
  for (let pos = 0; pos < text.length && !ended; lineCount.value++) {
    if (lf >= 0 && lf < pos) lf = text.indexOf('\n', pos);
    if (cr >= 0 && cr < pos) cr = text.indexOf('\r', pos);
    const stop = lf < 0 ? (cr < 0 ? text.length : cr) : cr < 0 ? lf : Math.min(lf, cr);
    const raw = text.slice(pos, stop), no = lineCount.value;
    pos = text[stop] === '\r' && text[stop + 1] === '\n' ? stop + 2 : stop + 1;
    if (raw.charCodeAt(0) === 42) continue; // '*' in column 1: a comment line
    const n = raw.length;
    let at = 0;
    while (at < n && !ended) {
      while (at < n && isSpace(raw.charCodeAt(at))) at++;
      if (at >= n) break;
      const c = raw[at];
      if (c === '(') {
        const close = findClose(raw, at + 1, ')', '(');
        if (close < 0) throw fail(`line ${no}: a subrecord is not closed with ")" on its line.`);
        subrecord(raw.slice(at + 1, close), no);
        at = close + 1;
      } else if (c === '}') { closeBlock(); at++; }
      else if (c === '{') {
        let k = at + 1;
        while (k < n && (raw.charCodeAt(k) >= 65 && raw.charCodeAt(k) <= 90 || raw.charCodeAt(k) >= 97 && raw.charCodeAt(k) <= 122 || raw[k] === '_')) k++;
        const keyword = raw.slice(at + 1, k).toUpperCase();
        if (!keyword) { at = n; break; }
        const close = findClose(raw, k, '}'), block = BLOCKS.get(keyword);
        if (LINE_RECORDS.has(keyword) || block === undefined && close >= 0) {
          lineRecord(keyword, raw.slice(k, close < 0 ? n : close), no);
          at = close < 0 ? n : close + 1;
        } else {
          if (block === undefined) { mode = 'other'; at = n; continue; }
          const trimmed = raw.slice(k).trimEnd(), closed = close >= 0 && trimmed.endsWith('}');
          header(block, closed ? trimmed.slice(0, -1) : trimmed, no);
          if (closed) closeBlock();
          at = n;
        }
      } else at = n; // free text after a subrecord is a comment
    }
  }
  if (!ended) throw fail('the file has no {END} record: it is truncated or not a complete HyperLynx file.');
  if (unitsToMm === undefined) throw fail('the file has no {UNITS} record, so lengths cannot be scaled.');
  return { unitsToMm, metal, devices, padstacks, pins, segments, arcs, ignored, duplicates, repeatedDevices };
}

const normal = (name: string) => name.trim().toUpperCase();
function readBoard(model: Model): RawBoard {
  const { metal, devices, padstacks } = model, warnings: ParseIssue[] = [];
  const top = metal.length ? normal(metal[0]) : '', bottom = metal.length > 1 ? normal(metal[metal.length - 1]) : '';
  let unknownLayers = 0;
  const sideOf = (layer: string | undefined): { side: BoardSide; known: boolean } => {
    const key = normal(layer ?? '');
    if (!key) return { side: 'top', known: false };
    if (key === 'EDGE') return { side: 'both', known: true };
    if (key === top) return { side: 'top', known: true };
    if (key === bottom) return { side: 'bottom', known: true };
    if (metal.length && metal.some(entry => normal(entry) === key)) return { side: 'top', known: false }; // an inner layer
    if (/(?<![A-Z])TOP(?![A-Z])|^F[._]|FRONT/.test(key)) return { side: 'top', known: true };
    if (/(?<![A-Z])BOT(?:TOM)?(?![A-Z])|^B[._]|BACK/.test(key)) return { side: 'bottom', known: true };
    return { side: 'top', known: false };
  };
  /** top or bottom when the layer name is the first or last metal layer of the stackup (or says so by name); undefined for inner, default and unknown layers. */
  const outerSide = (layer: string | undefined): 'top' | 'bottom' | undefined => {
    if (!layer) return undefined;
    const resolved = sideOf(layer);
    return resolved.known && resolved.side !== 'both' ? resolved.side : undefined;
  };
  /** The one outer side every outer-layer element of a padstack is on; undefined when it has a default (MDEF) element, no outer element, or elements on both sides. */
  const padstackSide = (stack: Padstack | undefined): 'top' | 'bottom' | undefined => {
    let found: 'top' | 'bottom' | undefined;
    for (const pad of stack?.pads ?? []) {
      if (normal(pad.layer) === 'MDEF') return undefined;
      const side = outerSide(pad.layer);
      if (!side) continue;
      if (found && found !== side) return undefined;
      found = side;
    }
    return found;
  };
  const owners = new Map<string, { part: RawPart; layer: string; pins: number }>(), parts: RawPart[] = [];
  const addPart = (ref: string, device: Device | undefined, fallbackSide: BoardSide): { part: RawPart; layer: string; pins: number } => {
    const found = owners.get(ref);
    if (found) return found;
    const resolved = device ? sideOf(device.layer) : { side: fallbackSide, known: true };
    if (!resolved.known && device?.layer) unknownLayers++;
    const label = device?.value || device?.name;
    const part: RawPart = { key: ref, ref, side: resolved.side, ...(label ? { value: label } : {}), ...(device?.pkg ? { package: device.pkg } : {}) };
    const entry = { part, layer: normal(device?.layer ?? ''), pins: 0 };
    owners.set(ref, entry); parts.push(part);
    return entry;
  };
  for (const device of devices.values()) addPart(device.ref, device, 'top');
  const declared = devices.size;
  const pins: RawPin[] = [];
  let approximated = 0, missingStack = 0, unsized = 0, unknownShapes = 0;
  // The side a pad is on: its own L= layer when the record has one, else the one outer layer its padstack lists (an edge-connector finger on the
  // far side of a part), else the side of the component. A declared component whose every such pad lies opposite to its own layer is read by its
  // own layer instead: its padstacks then name a generic layer, not the side the part is on.
  const stackOf = (record: PinRecord) => record.stack ? padstacks.get(record.stack) : undefined;
  const padSides = model.pins.map(record => { const stack = stackOf(record); return stack && stack.drill > 0 ? undefined : outerSide(record.layer) ?? padstackSide(stack); });
  const agree = new Set<string>(), oppose = new Set<string>();
  model.pins.forEach((record, index) => {
    const own = outerSide(devices.get(record.ref)?.layer), decided = padSides[index];
    if (own && decided) (decided === own ? agree : oppose).add(record.ref);
  });
  const generic = new Set([...oppose].filter(ref => !agree.has(ref)));
  for (const [index, record] of model.pins.entries()) {
    const stack = stackOf(record);
    if (record.stack && !stack) missingStack++;
    const through = !!stack && stack.drill > 0;
    const decided = generic.has(record.ref) ? undefined : padSides[index];
    // A part the DEVICES section does not list is placed on the side its padstack implies.
    const owner = addPart(record.ref, devices.get(record.ref), decided ?? 'top');
    owner.pins++;
    // The pad on the pin's own side, else on the component's own layer, else the default metal pad, else the first metal pad.
    const pad = !stack ? undefined : (decided ? stack.pads.find(candidate => outerSide(candidate.layer) === decided) : undefined)
      ?? stack.pads.find(candidate => !!owner.layer && normal(candidate.layer) === owner.layer) ?? stack.pads.find(candidate => normal(candidate.layer) === 'MDEF') ?? stack.pads[0];
    const pin: RawPin = { part: record.ref, number: record.pin, name: record.pin, net: record.net, x: record.x, y: record.y, side: through ? 'both' : decided ?? owner.part.side };
    if (pad && pad.sx > 0 && pad.sy > 0) {
      const equal = pad.sx === pad.sy;
      let shape: RawPin['shape'];
      if (pad.shape === 1) shape = equal ? 'square' : 'rect';
      else if (pad.shape === 0 || pad.shape === -1 || pad.shape === 2) shape = equal ? 'round' : 'rect';
      else { shape = equal ? 'square' : 'rect'; unknownShapes++; }
      // Oval and oblong pads that are not circles are drawn as their bounding rectangle.
      if (!equal && (pad.shape === 0 || pad.shape === -1 || pad.shape === 2)) approximated++;
      Object.assign(pin, { shape, width: pad.sx, height: pad.sy, radius: Math.min(pad.sx, pad.sy) / 2, rotation: ((pad.angle % 360) + 360) % 360 });
    } else if (stack) unsized++;
    pins.push(pin);
  }
  const drawable = parts.filter(part => owners.get(part.key)!.pins > 0), omitted = parts.length - drawable.length;
  const undeclared = parts.length - declared;
  // English format diagnostics through the formatNote catalog entry, like the other boardview adapters.
  warnings.push(note('HyperLynx: the file stores no component origin, rotation or body; each component is placed at the centre of its pads, and only pins that belong to a net are listed.'));
  if (omitted) warnings.push(note(`${omitted} ${omitted === 1 ? 'component' : 'components'} without pins ${omitted === 1 ? 'was' : 'were'} omitted because the file gives no position for ${omitted === 1 ? 'it' : 'them'}.`));
  if (undeclared) warnings.push(note(`${undeclared} ${undeclared === 1 ? 'component is' : 'components are'} named by pins but not listed in {DEVICES}; ${undeclared === 1 ? 'its' : 'their'} side is inferred from the pad layers.`));
  if (unknownLayers) warnings.push(note(`${unknownLayers} ${unknownLayers === 1 ? 'component is' : 'components are'} on a layer that is not the first or last metal layer of the stackup and ${unknownLayers === 1 ? 'is' : 'are'} shown on the top side.`));
  if (generic.size) warnings.push(note(`${generic.size} ${generic.size === 1 ? 'component has' : 'components have'} pads that all lie on the other side than ${generic.size === 1 ? 'its' : 'their'} L= layer; ${generic.size === 1 ? 'it is' : 'they are'} shown on that layer.`));
  if (missingStack) warnings.push(note(`${missingStack} pin ${missingStack === 1 ? 'record names' : 'records name'} a padstack that the file does not define; ${missingStack === 1 ? 'it has' : 'they have'} no pad size.`));
  if (unsized) warnings.push(note(`${unsized} ${unsized === 1 ? 'pin has' : 'pins have'} a padstack without a usable metal pad size.`));
  if (unknownShapes) warnings.push(note(`${unknownShapes} ${unknownShapes === 1 ? 'pad uses' : 'pads use'} an unknown HyperLynx pad shape code and ${unknownShapes === 1 ? 'is' : 'are'} drawn as a rectangle.`));
  if (model.repeatedDevices) warnings.push(note(`${model.repeatedDevices} ${model.repeatedDevices === 1 ? 'device record repeats' : 'device records repeat'} a reference that is already declared; the pins of one reference are one component and the first record gives its side and value.`));
  if (model.duplicates) warnings.push(note(`${model.duplicates} ${model.duplicates === 1 ? 'pad is' : 'pads are'} listed in two nets at the same place; the first net was kept.`));
  const { segments: segmentCount, vias, polygons } = model.ignored;
  if (segmentCount || vias || polygons) warnings.push(note(`HyperLynx traces, vias and copper polygons are not shown (${segmentCount} trace ${segmentCount === 1 ? 'record' : 'records'}, ${vias} via or pad ${vias === 1 ? 'record' : 'records'}, ${polygons} polygon ${polygons === 1 ? 'block' : 'blocks'}).`));
  if (approximated) warnings.push({ key: 'parse.warning.approximatedPads', params: { count: approximated } });
  const { loops, openChains } = stitchOutlines(model.segments, 1e-5);
  if (model.segments.length && !loops.length) warnings.push(note('HyperLynx board perimeter records do not form a closed contour; an estimated boundary is shown.'));
  else if (openChains) warnings.push(note(`${openChains} open HyperLynx perimeter ${openChains === 1 ? 'chain' : 'chains'} (spurs, chords or gaps) ${openChains === 1 ? 'is' : 'are'} not part of a closed contour and ${openChains === 1 ? 'was' : 'were'} ignored.`));
  if (model.arcs && loops.length) warnings.push(note(`${model.arcs} HyperLynx perimeter ${model.arcs === 1 ? 'arc was' : 'arcs were'} approximated by straight segments.`));
  return { format: HYPERLYNX_FORMAT, parts: drawable, pins, unitsToMm: model.unitsToMm, outline: loops[0] ?? [], outlines: loops, warnings };
}

/** null when the bytes are not a HyperLynx file; a recognized but malformed or truncated file throws BoardFormatError. */
export function parseHyperlynx(input: ParseInput): Board | null {
  const text = decodeText(input.data);
  if (!claimed(sniffHyperlynxText(text.slice(0, SNIFF_BYTES)), input.name)) return null;
  const model = readModel(text);
  return buildBoard(input, readBoard(model));
}
