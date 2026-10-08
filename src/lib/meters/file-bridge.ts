/**
 * File bridge: readings from a text or CSV file that another program appends to (sigrok-cli redirected to a file, a meter's own
 * logger, a script). Pure: the bridge never opens a file. A transport polls the file (a few times a second at most) and
 *
 *     const plan = bridge.plan({ size, mtimeMs, fileId });        // what to read next, bounded
 *     if (plan.kind === 'read') readings = bridge.consume(await readRange(plan.offset, plan.length), Date.now());
 *
 * Tailing:
 *   - the first plan starts near the end (`startBacklog` bytes back, on a line boundary), because only the latest values matter;
 *   - bytes are decoded as UTF-8 (a BOM is dropped; a UTF-16 LE BOM at the start of the file switches to UTF-16 LE, which only
 *     works when the file is read from byte 0), and a line without its newline yet is held until the newline arrives
 *     (`flush()` gives it up after the file has been quiet);
 *   - a file that gets smaller, or whose `fileId` (inode, file index) changes, was truncated or rotated: the cursor goes back
 *     to the start and any half line is dropped (`resets`);
 *   - reading is bounded: at most `maxRead` bytes per plan, and a cursor more than `maxLag` bytes behind skips ahead
 *     (`skippedBytes`), so a fast logger cannot make the poll fall behind for good; a line longer than `maxLine` is discarded.
 *   - `mode: 'snapshot'` is for programs that rewrite one file with the current value: any change of size or modification time
 *     reads the whole (small) file, and the last line is the reading, with or without a final newline.
 *
 * Line formats, recognised per line (comments start with #, ; or //, blank lines are skipped):
 *   - free text, optionally behind a channel label:  `P1: 1.2345 V DC AUTO`   `-0.085V`   `4.7 kOhm`   `OL`   `12.5 mV AC HOLD`
 *   - CSV with , ; or tab, with or without a header row. A header names columns (value, unit, mode, flags; time columns are
 *     ignored); without one the first field that holds a number or OL is the value, the following fields give unit and flags.
 *     A field may hold value and unit together (`1.234 V`).
 *   - decimal comma in ; and tab separated lines (`decimal: 'auto'`), or everywhere with `decimal: ','` (then a comma never
 *     separates fields).
 *   - over-range: OL, O.L, 0L, OVERLOAD, OPEN, INF, or any |value| of 9e37 or more (the display value some meters' queries give).
 *   - a number followed by words that are neither a unit nor a known mode or flag word is not a measurement line (a log message
 *     such as "3 samples dropped" gives no reading); a number followed by a unit may have any words after it.
 *
 * The mode comes from the unit and the words next to it (DC, AC, DIODE, CONT, ...). A volt or ampere line without DC or AC, a
 * unit-less line, and a unit-less CSV column give `caveat: 'mode-ambiguous'` unless the caller declared what the file holds with
 * `assume`. File readings carry no `resolution` (a logger's number of decimals says nothing about the meter's counts), so the
 * stability detector uses its relative tolerance and absolute floors for them. Every reading of one `consume` call gets the same
 * `at`: the arrival time the transport gives. CR, LF and CRLF all end a line.
 */
import type { MeterDecoder, MeterDecoderStats, MeterFamilyInfo, MeterMode, MeterReading, MeterUnit } from './types';
import { DEG_C, DEG_F, makeFlags, OHM } from './types';

export const FILE_BRIDGE_INFO: MeterFamilyInfo = {
  id: 'file-bridge',
  models: ['Text or CSV file written by another program (sigrok-cli output, a meter logger)'],
  status: 'tool',
  link: 'file',
  documents: ['sigrok-cli manual page (output formats)'],
  limits: [
    'No resolution is known, so the stability detector falls back on relative tolerance and absolute floors.',
    'Time columns are ignored; readings get the time the file was polled.',
    'A file larger than the start backlog must be UTF-8 (UTF-16 only works when read from byte 0).',
    'A headerless CSV with a numeric timestamp as its first column needs `valueColumn`.',
    'A decimal comma needs semicolon or tab separated lines, or the `decimal` option.',
  ],
};

// ---------------------------------------------------------------------------------------------------------------------------
// Line parsing

export type DecimalSeparator = 'auto' | '.' | ',';

export interface LineParseOptions {
  decimal?: DecimalSeparator;
  /** What a file without unit or mode words holds. Fills gaps only; a unit in the line wins. */
  assume?: { mode: MeterMode; unit: MeterUnit };
  /** 0-based value column of CSV lines without a header. */
  valueColumn?: number;
}

const PREFIX_EXP: Readonly<Record<string, number>> = { p: -12, n: -9, u: -6, 'µ': -6, 'μ': -6, m: -3, k: 3, K: 3, M: 6, G: 9 };

type UnitKind = 'V' | 'A' | 'ohm' | 'F' | 'Hz' | '%' | 'degC' | 'degF' | 'S' | 's' | 'dB';
export interface UnitInfo { kind: UnitKind; unit: MeterUnit; exp: number; }

const BASE_UNITS: ReadonlyArray<readonly [RegExp, UnitKind, MeterUnit]> = [
  [/^[Vv]$/, 'V', 'V'],
  [/^[Aa]$/, 'A', 'A'],
  [/^(?:[Oo][Hh][Mm][Ss]?|Ω|Ω|ω)$/, 'ohm', OHM],
  [/^[Ff]$/, 'F', 'F'],
  [/^[Hh][Zz]$/, 'Hz', 'Hz'],
  [/^S$/, 'S', 'S'],
  [/^s$/, 's', 's'],
];

/** `mV`, `kOhm`, `µF`, `°C`, `%`, `dB`: the unit and the power of ten of its prefix; null for anything else. */
export function parseUnitToken(token: string): UnitInfo | null {
  const t = token.trim().replace(/[.,;:]+$/, '');
  if (t === '') return null;
  if (t === '%') return { kind: '%', unit: '%', exp: 0 };
  const temperature = /^(?:°|º|deg\.?|degrees?)\s*([CcFf])$/.exec(t);
  if (temperature) return temperature[1].toUpperCase() === 'C' ? { kind: 'degC', unit: DEG_C, exp: 0 } : { kind: 'degF', unit: DEG_F, exp: 0 };
  if (t === 'C') return { kind: 'degC', unit: DEG_C, exp: 0 };
  if (/^dB[A-Za-z]{0,2}$/.test(t)) return { kind: 'dB', unit: 'dB', exp: 0 };
  for (const [pattern, kind, unit] of BASE_UNITS) {
    if (pattern.test(t)) return { kind, unit, exp: 0 };
    const prefix = PREFIX_EXP[t[0]];
    if (prefix !== undefined && t.length > 1 && pattern.test(t.slice(1))) return { kind, unit, exp: prefix };
  }
  return null;
}

// Words that name a mode outright (a CSV mode column, or a sigrok-style flag), and the unit that goes with it.
const MODE_WORDS: Readonly<Record<string, readonly [MeterMode, MeterUnit]>> = {
  dcv: ['dcVolts', 'V'], vdc: ['dcVolts', 'V'], acv: ['acVolts', 'V'], vac: ['acVolts', 'V'], acdcv: ['acdcVolts', 'V'],
  dca: ['dcAmps', 'A'], adc: ['dcAmps', 'A'], aca: ['acAmps', 'A'], aac: ['acAmps', 'A'],
  ohm: ['resistance', OHM], ohms: ['resistance', OHM], res: ['resistance', OHM], resistance: ['resistance', OHM],
  cont: ['continuity', OHM], continuity: ['continuity', OHM], beep: ['continuity', OHM],
  diode: ['diode', 'V'], diod: ['diode', 'V'],
  cap: ['capacitance', 'F'], capacitance: ['capacitance', 'F'],
  freq: ['frequency', 'Hz'], frequency: ['frequency', 'Hz'], hz: ['frequency', 'Hz'],
  duty: ['duty', '%'], temp: ['temperature', DEG_C], temperature: ['temperature', DEG_C],
  conductance: ['conductance', 'S'],
};
type FlagName = 'hold' | 'rel' | 'auto' | 'min' | 'max' | 'lowBattery' | 'ol';
const WORD_FLAGS: Readonly<Record<string, FlagName>> = {
  hold: 'hold', rel: 'rel', relative: 'rel', delta: 'rel', auto: 'auto', autorange: 'auto', 'auto-range': 'auto', min: 'min', max: 'max',
  lowbat: 'lowBattery', 'low-battery': 'lowBattery', lowbatt: 'lowBattery', battery: 'lowBattery', ol: 'ol', overload: 'ol',
};
const OTHER_KNOWN_WORDS: ReadonlySet<string> = new Set(['dc', 'ac', 'acdc', 'ac+dc', 'ac/dc', 'dc+ac', 'rms', 'avg', 'true-rms', 'trms', 'manual', 'ok', 'normal']);
const isKnownWord = (word: string): boolean => word in MODE_WORDS || word in WORD_FLAGS || OTHER_KNOWN_WORDS.has(word);

const OVERLOAD_START = /^[+-]?(?:O\.?L\.?|0L|OVLD|OVERLOAD|OPEN|INF(?:INITY)?)(?![A-Za-z0-9])/i;
// A number must be followed by the end, a space, or the start of a unit: that keeps times (12:00:01) and dates (2026-10-07) out.
const NUMBER_START = /^([+-]?)(\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE]([+-]?\d+))?(?=$|[\s°ºA-Za-zµμΩω%])/;
const CHANNEL_LABEL = /^[A-Za-z_][\w .\-]{0,31}:\s+(?=\S)|^[A-Za-z_][\w.\-]{0,31}:(?=[+\-.\d])/;
const OVERLOAD_MAGNITUDE = 9e37;

export interface ValueCell {
  overload: boolean;
  negative: boolean;
  /** Digits with a decimal point, as written (decimal comma already turned into a point). */
  mantissa: string;
  exponent: number;
  /** The number as written. */
  text: string;
  /** The unit that followed the number in the same cell. */
  unit: UnitInfo | null;
  /** Lower-case words that followed the number (and its unit) in the same cell. */
  words: string[];
}

/** One cell or free-text line: a number or over-range, then an optional unit, then words. Null when the text is not that. */
export function parseValueCell(raw: string, decimalComma: boolean): ValueCell | null {
  let text = raw.trim();
  const label = CHANNEL_LABEL.exec(text);
  if (label) text = text.slice(label[0].length);
  if (text === '') return null;

  let cell: Omit<ValueCell, 'unit' | 'words'>;
  let rest: string;
  const overload = OVERLOAD_START.exec(text);
  if (overload) {
    cell = { overload: true, negative: false, mantissa: '0', exponent: 0, text: 'OL' };
    rest = text.slice(overload[0].length);
  } else {
    const match = NUMBER_START.exec(text);
    if (!match) return null;
    if (!decimalComma && match[2].includes(',')) return null;
    let mantissa = match[2].replace(',', '.');
    if (mantissa.startsWith('.')) mantissa = `0${mantissa}`;
    if (mantissa.endsWith('.')) mantissa = mantissa.slice(0, -1);
    const exponent = match[3] === undefined ? 0 : Number(match[3]);
    const magnitude = Number(`${mantissa}e${exponent}`);
    cell = { overload: !Number.isFinite(magnitude) || magnitude >= OVERLOAD_MAGNITUDE, negative: match[1] === '-', mantissa, exponent, text: match[0] };
    rest = text.slice(match[0].length);
  }

  const tokens = rest.split(/[\s,;|]+/).filter(token => token !== '');
  let unit: UnitInfo | null = null;
  let wordTokens = tokens;
  if (tokens.length > 0) {
    // The degree sign may stand alone ("° C").
    let candidate = tokens[0];
    let used = 1;
    if (/^(?:°|º)$/.test(candidate) && tokens.length > 1) { candidate += tokens[1]; used = 2; }
    unit = parseUnitToken(candidate);
    if (unit) wordTokens = tokens.slice(used);
  }
  const words = wordTokens.map(word => word.toLowerCase());
  if (!unit && words.some(word => !isKnownWord(word))) return null;
  return { ...cell, unit, words };
}

function buildReading(cell: ValueCell, unitCell: UnitInfo | null, extraWords: readonly string[], options: LineParseOptions, at: number): MeterReading {
  const unitInfo = cell.unit ?? unitCell;
  const words = [...cell.words, ...extraWords];
  const set = new Set(words);
  const has = (...names: string[]): boolean => names.some(name => set.has(name));
  const coupling = has('acdc', 'ac+dc', 'ac/dc', 'dc+ac') ? 'acdc' : has('ac') ? 'ac' : has('dc') ? 'dc' : null;
  const explicit = words.map(word => MODE_WORDS[word]).find(entry => entry !== undefined);
  const assume = options.assume;

  let mode: MeterMode = 'other';
  let unit: MeterUnit = unitInfo?.unit ?? '';
  let ambiguous = false;
  const volts = (): MeterMode => (coupling === 'ac' ? 'acVolts' : coupling === 'acdc' ? 'acdcVolts' : 'dcVolts');
  const amps = (): MeterMode => (coupling === 'ac' ? 'acAmps' : coupling === 'acdc' ? 'acdcAmps' : 'dcAmps');

  if (explicit) {
    mode = explicit[0];
    if (!unitInfo) unit = explicit[1];
    if ((mode === 'dcVolts' || mode === 'acVolts') && coupling) mode = volts();
    if ((mode === 'dcAmps' || mode === 'acAmps') && coupling) mode = amps();
  } else if (unitInfo) {
    switch (unitInfo.kind) {
      case 'V':
        if (has('diode', 'diod')) mode = 'diode';
        else if (coupling) mode = volts();
        else if (assume && assume.unit === 'V') mode = assume.mode;
        else { mode = 'dcVolts'; ambiguous = true; }
        break;
      case 'A':
        if (coupling) mode = amps();
        else if (assume && assume.unit === 'A') mode = assume.mode;
        else { mode = 'dcAmps'; ambiguous = true; }
        break;
      case 'ohm': mode = has('cont', 'continuity', 'beep') ? 'continuity' : 'resistance'; break;
      case 'F': mode = 'capacitance'; break;
      case 'Hz': mode = 'frequency'; break;
      case '%': mode = 'duty'; break;
      case 'degC': case 'degF': mode = 'temperature'; break;
      case 'S': mode = 'conductance'; break;
      default: mode = 'other';
    }
  } else if (assume) {
    mode = assume.mode;
    unit = assume.unit;
  } else ambiguous = true;

  const flags = makeFlags();
  for (const word of words) {
    const flag = WORD_FLAGS[word];
    if (flag) flags[flag] = true;
  }
  const reading: MeterReading = { family: 'file-bridge', value: null, unit, mode, flags, at, display: cell.text };
  if (cell.overload || flags.ol) {
    flags.ol = true;
    reading.display = 'OL';
  } else {
    const number = Number(`${cell.negative ? '-' : ''}${cell.mantissa}e${cell.exponent + (unitInfo?.exp ?? 0)}`);
    reading.value = number + 0;
  }
  if (ambiguous) reading.caveat = 'mode-ambiguous';
  return reading;
}

// ---------------------------------------------------------------------------------------------------------------------------
// CSV

function splitDelimited(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"' && field.trim() === '') { quoted = true; field = ''; }
    else if (ch === delimiter) { fields.push(field); field = ''; }
    else field += ch;
  }
  fields.push(field);
  return fields.map(value => value.trim());
}

interface Columns { value: number; unit: number; mode: number; flags: number; }

const HEADER_NAMES: Readonly<Record<keyof Columns, readonly string[]>> = {
  value: ['value', 'reading', 'measurement', 'val', 'display', 'primary', 'main', 'result'],
  unit: ['unit', 'units', 'uom'],
  mode: ['mode', 'function', 'func', 'type', 'measure'],
  flags: ['flags', 'status', 'state', 'attributes', 'attribute'],
};

/** The columns a header row names; null when the row has no value column. Time and index columns need no name: they are skipped. */
function asHeader(fields: readonly string[]): Columns | null {
  const columns: Columns = { value: -1, unit: -1, mode: -1, flags: -1 };
  for (let index = 0; index < fields.length; index++) {
    const name = fields[index].toLowerCase().replace(/[\s_\-]+/g, '');
    for (const key of ['value', 'unit', 'mode', 'flags'] as const) {
      if (columns[key] < 0 && HEADER_NAMES[key].includes(name)) { columns[key] = index; break; }
    }
  }
  return columns.value < 0 ? null : columns;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The bridge

export interface FileStat {
  size: number;
  mtimeMs?: number;
  /** Anything that changes when the file is replaced (inode and device, or the file index on Windows). */
  fileId?: string;
}

export type TailPlan = { kind: 'idle' } | { kind: 'read'; offset: number; length: number };

export interface FileBridgeOptions extends LineParseOptions {
  /** `tail` appends (default), `snapshot` rewrites one small file. */
  mode?: 'tail' | 'snapshot';
  startBacklog?: number;
  maxRead?: number;
  maxLag?: number;
  maxLine?: number;
  now?: () => number;
}

export interface FileBridgeStats {
  /** Lines that held no reading and were not comments, blanks or headers. */
  badLines: number;
  /** Comments, blank lines and header rows. */
  ignoredLines: number;
  /** Truncations and rotations seen by `plan`. */
  resets: number;
  /** Lines longer than `maxLine`. */
  overlongLines: number;
}

export interface FileBridge extends MeterDecoder {
  /** What to read next. Stateful: it moves the cursor on a reset or a skip-ahead, never on a normal read (`consume` does that). */
  plan(stat: FileStat): TailPlan;
  /** The bytes that were read at the planned offset. The cursor moves by their length. */
  consume(bytes: ArrayLike<number>, at?: number): MeterReading[];
  /** The line still waiting for its newline, as a reading when it is one. */
  flush(at?: number): MeterReading[];
  /** Offset of the next byte to read. */
  readonly cursor: number;
  readonly detail: Readonly<FileBridgeStats>;
}

const DEFAULT_START_BACKLOG = 8192;
const DEFAULT_MAX_READ = 65536;
const DEFAULT_MAX_LAG = 1 << 20;
const DEFAULT_MAX_LINE = 4096;

export function createFileBridge(options: FileBridgeOptions = {}): FileBridge {
  const tail = (options.mode ?? 'tail') === 'tail';
  const startBacklog = Math.max(64, options.startBacklog ?? DEFAULT_START_BACKLOG);
  const maxRead = Math.max(64, options.maxRead ?? DEFAULT_MAX_READ);
  const maxLag = Math.max(maxRead, startBacklog + 2, options.maxLag ?? DEFAULT_MAX_LAG);
  const maxLine = Math.max(64, options.maxLine ?? DEFAULT_MAX_LINE);
  const now = options.now ?? Date.now;

  const stats: MeterDecoderStats = { bytes: 0, frames: 0, readings: 0, badFrames: 0, skippedBytes: 0, resyncs: 0 };
  const detail: FileBridgeStats = { badLines: 0, ignoredLines: 0, resets: 0, overlongLines: 0 };

  let cursor = 0;
  let attached = false;
  let fileId: string | undefined;
  let lastStamp = '';
  let skipPartial = false;
  let discarding = false;
  let carry = '';
  let fileStart = true;
  let pending = new Uint8Array(0);
  let decoder = new TextDecoder('utf-8');
  let header: Columns | null = null;

  const restartText = (): void => {
    carry = '';
    discarding = false;
    fileStart = true;
    pending = new Uint8Array(0);
    decoder = new TextDecoder('utf-8');
  };

  /** One complete line. Returns a reading, or null (and counts why). */
  const parseLine = (line: string, at: number): MeterReading | null => {
    const text = line.trim();
    if (text === '' || /^(?:#|;|\/\/)/.test(text)) { detail.ignoredLines++; return null; }
    if (text.length > maxLine) { detail.overlongLines++; detail.badLines++; stats.badFrames++; return null; }
    const decimalSetting = options.decimal ?? 'auto';
    // "1,234 V DC": one comma between digits, followed by a unit, is a decimal comma and not a field separator.
    const european = decimalSetting === 'auto' ? /^([+-]?\d+),(\d+)(\s+(\S+).*)$/.exec(text) : null;
    if (european && !/[;\t,]/.test(european[3]) && parseUnitToken(european[4])) return parseLine(`${european[1]}.${european[2]}${european[3]}`, at);
    const delimiter =text.includes('\t') ? '\t' : text.includes(';') ? ';' : text.includes(',') && decimalSetting !== ',' ? ',' : null;
    const decimalComma = decimalSetting === ',' || (decimalSetting === 'auto' && (delimiter === ';' || delimiter === '\t'));
    let reading: MeterReading | null = null;

    if (delimiter === null) {
      const cell = parseValueCell(text, decimalComma);
      if (cell) reading = buildReading(cell, null, [], options, at);
    } else {
      const fields = splitDelimited(text, delimiter);
      const named = asHeader(fields);
      if (named && fields.every(field => parseValueCell(field, decimalComma) === null)) {
        header = named;
        detail.ignoredLines++;
        return null;
      }
      if (header) {
        const cell = header.value < fields.length ? parseValueCell(fields[header.value], decimalComma) : null;
        if (cell) {
          const unitCell = header.unit >= 0 && header.unit < fields.length ? parseUnitToken(fields[header.unit]) : null;
          const words: string[] = [];
          if (header.mode >= 0 && header.mode < fields.length) words.push(...fields[header.mode].toLowerCase().split(/[\s,;|]+/).filter(word => word !== ''));
          if (header.flags >= 0 && header.flags < fields.length) words.push(...fields[header.flags].toLowerCase().split(/[\s,;|]+/).filter(word => word !== ''));
          reading = buildReading(cell, unitCell, words, options, at);
        }
      } else {
        const pinned = options.valueColumn;
        for (let i = pinned ?? 0; i < fields.length; i++) {
          const cell = parseValueCell(fields[i], decimalComma);
          if (!cell) { if (pinned !== undefined) break; continue; }
          let unitCell: UnitInfo | null = null;
          const words: string[] = [];
          for (let j = i + 1; j < fields.length; j++) {
            const asUnit: UnitInfo | null = unitCell || cell.unit ? null : parseUnitToken(fields[j]);
            if (asUnit) unitCell = asUnit;
            else words.push(...fields[j].toLowerCase().split(/[\s,;|]+/).filter(word => word !== ''));
          }
          reading = buildReading(cell, unitCell, words, options, at);
          break;
        }
      }
    }
    if (!reading) {
      stats.badFrames++;
      detail.badLines++;
      return null;
    }
    stats.frames++;
    stats.readings++;
    return reading;
  };

  /** Decode bytes and parse the lines they complete. In `snapshot` mode the bytes are a whole file and only the last reading is kept. */
  const feed = (bytes: ArrayLike<number>, at: number, snapshot: boolean): MeterReading[] => {
    if (bytes.length === 0) return [];
    let view = Uint8Array.from(bytes, value => value & 0xff);
    stats.bytes += view.length;
    if (fileStart) {
      // A byte order mark may arrive in pieces: wait for the rest of it, but never for a first byte that cannot start one.
      if (pending.length) { const joined = new Uint8Array(pending.length + view.length); joined.set(pending); joined.set(view, pending.length); view = joined; }
      const need = view[0] === 0xef ? 3 : view[0] === 0xff || view[0] === 0xfe ? 2 : 0;
      if (view.length < need && !snapshot) { pending = view; return []; }
      pending = new Uint8Array(0);
      fileStart = false;
      if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) view = view.subarray(3);
      else if (view.length >= 2 && view[0] === 0xff && view[1] === 0xfe) { decoder = new TextDecoder('utf-16le'); view = view.subarray(2); }
    }
    let text = decoder.decode(view, { stream: !snapshot });
    if (skipPartial) {
      const newline = text.search(/[\r\n]/);
      if (newline < 0) { stats.skippedBytes += view.length; return []; }
      text = text.slice(newline + 1);
      skipPartial = false;
    }
    const pieces = (carry + text).split(/\r\n|\n|\r/);
    carry = pieces.pop() ?? '';
    if (snapshot) { pieces.push(carry); carry = ''; }
    if (discarding) {
      // What is left of a line that was too long, up to its newline.
      if (pieces.length === 0) { carry = ''; stats.skippedBytes += view.length; return []; }
      pieces.shift();
      discarding = false;
    }
    const out: MeterReading[] = [];
    for (const piece of pieces) {
      const reading = parseLine(piece, at);
      if (reading) out.push(reading);
    }
    if (carry.length > maxLine) {
      carry = '';
      discarding = true;
      detail.overlongLines++;
      detail.badLines++;
      stats.badFrames++;
    }
    return snapshot ? out.slice(-1) : out;
  };

  /** Start over at the (new) end of file: from the beginning when it is small, else `startBacklog` bytes back. */
  const reposition = (size: number): void => {
    restartText();
    skipPartial = false;
    if (size > startBacklog) { cursor = size - startBacklog - 1; skipPartial = true; } else cursor = 0;
  };

  const bridge: FileBridge = {
    family: 'file-bridge',
    stats,
    detail,
    get cursor() { return cursor; },
    push(chunk: ArrayLike<number>, at?: number): MeterReading[] {
      if (!tail) restartText();
      return feed(chunk, at ?? now(), !tail);
    },
    reset(): void {
      restartText();
      skipPartial = false;
    },
    plan(stat: FileStat): TailPlan {
      if (!Number.isFinite(stat.size) || stat.size < 0) return { kind: 'idle' };
      const size = Math.floor(stat.size);
      if (!tail) {
        const stamp = `${size}:${stat.mtimeMs ?? ''}:${stat.fileId ?? ''}`;
        const unchanged = stamp === lastStamp;
        lastStamp = stamp;
        if (unchanged || size === 0) return { kind: 'idle' };
        return { kind: 'read', offset: 0, length: Math.min(size, maxRead) };
      }
      if (!attached) {
        attached = true;
        fileId = stat.fileId;
        reposition(size);
      } else if (size < cursor || (stat.fileId !== undefined && fileId !== undefined && stat.fileId !== fileId)) {
        detail.resets++;
        stats.resyncs++;
        fileId = stat.fileId ?? fileId;
        reposition(size);
      } else if (stat.fileId !== undefined) fileId = stat.fileId;
      if (size - cursor > maxLag) {
        stats.skippedBytes += size - startBacklog - 1 - cursor;
        stats.resyncs++;
        restartText();
        cursor = size - startBacklog - 1;
        skipPartial = true;
      }
      if (cursor >= size) return { kind: 'idle' };
      return { kind: 'read', offset: cursor, length: Math.min(size - cursor, maxRead) };
    },
    consume(bytes: ArrayLike<number>, at?: number): MeterReading[] {
      const when = at ?? now();
      if (!tail) {
        restartText();
        return feed(bytes, when, true);
      }
      cursor += bytes.length;
      return feed(bytes, when, false);
    },
    flush(at?: number): MeterReading[] {
      const line = carry;
      carry = '';
      const reading = line.trim() === '' ? null : parseLine(line, at ?? now());
      return reading ? [reading] : [];
    },
  };
  return bridge;
}

/** One line to one reading, for callers that already have lines (a pasted log). Null when the line holds no reading. */
export function parseMeterLine(line: string, at: number, options: LineParseOptions = {}): MeterReading | null {
  const bridge = createFileBridge({ ...options, mode: 'snapshot' });
  return bridge.consume(new TextEncoder().encode(line), at)[0] ?? null;
}
