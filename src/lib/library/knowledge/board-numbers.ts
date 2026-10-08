/**
 * Board-number recognition: finds the numbers that identify a board in a file name, a folder name, an archive name, a PDF
 * title block, a PDF's title or outline, or the header text of a board file.
 *
 * What it returns: for each number a shape id (`BOARD_NUMBER_SHAPES`), the normalised form (upper case, "-" as the
 * separator, a trailing revision letter split off), a confidence (0..100), the evidence span `[start, end)` in the original
 * text, and the vendor the shape belongs to. Nothing is guessed from a number's digits; a shape is a published convention
 * for the layout of a number, not a database of numbers.
 *
 * Precision comes first. A candidate is dropped when
 *  - it does not stand alone: a letter or digit touches it on either side (`X820-01234`, `820-012345`);
 *  - its shape may not be read in this scope (`scopes` of the shape: a shape that collides with reference designators is only
 *    read in names, and only when a device word stands in the same text);
 *  - a numeric shape continues into more digit groups (`820-01234-56`, `051-9876.5`): a date, a version or a phone number;
 *  - a numeric shape was written with a blank or an underscore and its last group reads as a year (`051 2019`);
 *  - it looks like a phone number: a "+" in front, a word like tel or fax just before it, or the last group of four digits or
 *    fewer joined by dashes or dots to other short groups so that ten or more digits run on.
 * Reference designators (`U7000`), page and sheet numbers (`Sheet 3 of 12`, `p. 12`), dates (`2024-10-07`) and ordinary part
 * numbers (`TPS51225`) match no shape at all.
 *
 * Confidence = the shape's base confidence, +5 when a label word (board, PCB, P/N, DWG, MLB ...) stands within 24 characters
 * before the number, -10 for a blank or underscore in place of the dash, -15 in OCR text, -10 in running text. When two shapes
 * claim overlapping text the one with the higher confidence, then the longer one, wins.
 *
 * Linear time: the text is scanned once; a candidate starts only at the beginning of an alphanumeric run and is tried against
 * the (constant number of) shapes whose first character fits, each attempt reading at most 32 characters. At most
 * `MAX_TEXT_LENGTH` units are read and at most `MAX_MATCHES` numbers returned.
 */
import { BOARD_NUMBER_SHAPES, scopeAllows, type BoardNumberShape, type SegmentSpec } from './board-number-shapes';
import { MAX_MATCHES, RECOGNITION_SCOPES, foldCode, foldedAt, isAlnumCode, isDigitCode, isLetterCode, scanLength, tick, type RecognitionScope, type WorkMeter } from './chars';
import { deviceTypeHints, vendorHints } from './hints';
import type { DeviceType } from './lexicon';

export interface BoardNumberMatch {
  /** Shape id from `BOARD_NUMBER_SHAPES`. */
  shape: string;
  /** Upper case, "-" between groups, the trailing revision letter removed. */
  normalized: string;
  /** The text as written. */
  raw: string;
  /** Span `[start, end)` in UTF-16 units of the input text. */
  start: number;
  end: number;
  /** 0..100 */
  confidence: number;
  /** English description of the shape, for diagnostics (not for the interface). */
  description: string;
  /** Vendor lexicon id of the shape. */
  vendor?: string;
  device?: DeviceType;
  /** A revision written as part of the number ("820-01234-A" gives "A"). */
  revision?: string;
  scope: RecognitionScope;
  /** A blank or an underscore stands where the dash belongs. */
  loose: boolean;
  /** A label word stands just before the number. */
  labelled: boolean;
  provisional: boolean;
}

export interface BoardNumberOptions {
  /** Where the text comes from; default 'name'. Decides which shapes may be read. */
  scope?: RecognitionScope;
  /** Counts the characters examined (for tests). */
  meter?: WorkMeter;
}

// --------------------------------------------------------------------------------------------------------------------
// Matching one shape at one position
// --------------------------------------------------------------------------------------------------------------------

interface State { out: string; revision: string | undefined; lastRun: string; loose: boolean; /** Match the shape without its optional trailing groups. */ skipOptional: boolean }

function matchSegments(segments: readonly SegmentSpec[], text: string, length: number, from: number, state: State): number {
  let pos = from;
  for (const segment of segments) {
    switch (segment.t) {
      case 'lit': {
        const value = segment.v;
        for (let k = 0; k < value.length; k++) if (foldedAt(text, pos + k, length) !== value.charCodeAt(k)) return -1;
        state.out += value;
        pos += value.length;
        break;
      }
      case 'alt': {
        let taken = '';
        for (const option of segment.v) {
          let ok = true;
          for (let k = 0; k < option.length; k++) if (foldedAt(text, pos + k, length) !== option.charCodeAt(k)) { ok = false; break; }
          if (ok) { taken = option; break; }
        }
        if (taken === '') return -1;
        state.out += taken;
        pos += taken.length;
        break;
      }
      case 'D': case 'A': case 'X': {
        let count = 0, digits = 0, letters = 0, run = '';
        while (count < segment.max) {
          const code = foldedAt(text, pos + count, length);
          const isDigit = isDigitCode(code), isLetter = isLetterCode(code);
          if (segment.t === 'D' ? !isDigit : segment.t === 'A' ? !isLetter : !(isDigit || isLetter)) break;
          if (isDigit) digits++; else letters++;
          run += String.fromCharCode(code);
          count++;
        }
        if (count < segment.min) return -1;
        if (segment.digits !== undefined && digits < segment.digits) return -1;
        if (segment.letters !== undefined && letters < segment.letters) return -1;
        if (segment.first !== undefined && (segment.first === 'D' ? !isDigitCode(run.charCodeAt(0)) : !isLetterCode(run.charCodeAt(0)))) return -1;
        state.out += run;
        state.lastRun = run;
        pos += count;
        break;
      }
      case 'S': {
        const code = foldedAt(text, pos, length);
        if (code === 45) { /* the dash */ }
        else if (segment.loose >= 1 && code === 95) state.loose = true;
        else if (segment.loose === 2 && code === 32) state.loose = true;
        else return -1;
        state.out += '-';
        pos++;
        break;
      }
      case 'dot': {
        if (foldedAt(text, pos, length) !== 46) return -1;
        state.out += '.';
        pos++;
        break;
      }
      case 'opt': {
        if (state.skipOptional) break;
        const saved: State = { ...state };
        const end = matchSegments(segment.segs, text, length, pos, state);
        if (end < 0) { Object.assign(state, saved); break; }
        if (segment.revision) {
          state.revision = state.lastRun;
          state.out = saved.out;
          state.lastRun = saved.lastRun;
          state.loose = saved.loose;
        }
        pos = end;
        break;
      }
    }
  }
  return pos;
}

const NO_FIRST: Uint8Array = new Uint8Array(128);
const FIRST_CODES: Map<string, Uint8Array> = new Map(BOARD_NUMBER_SHAPES.map(item => {
  const table = new Uint8Array(128);
  const first = item.segments[0];
  const mark = (code: number): void => { if (code < 128) table[code] = 1; };
  if (first.t === 'lit') mark(first.v.charCodeAt(0));
  else if (first.t === 'alt') for (const option of first.v) mark(option.charCodeAt(0));
  else if (first.t === 'D' || first.t === 'X') for (let code = 48; code <= 57; code++) mark(code);
  if (first.t === 'A' || first.t === 'X') for (let code = 65; code <= 90; code++) mark(code);
  return [item.id, table] as const;
}));

/** Shapes with an optional trailing group. */
const HAS_OPTIONAL: ReadonlySet<string> = new Set(BOARD_NUMBER_SHAPES.filter(item => item.segments.some(segment => segment.t === 'opt')).map(item => item.id));

/** True when the shape consists of digits and separators only (a number a date or a phone number could imitate). */
const NUMERIC_SHAPE: ReadonlySet<string> = new Set(BOARD_NUMBER_SHAPES.filter(item => item.segments.every(segment => segment.t === 'S' || segment.t === 'D' || segment.t === 'dot' || segment.t === 'opt' || (segment.t === 'lit' && /^[0-9]+$/.test(segment.v)))).map(item => item.id));

// --------------------------------------------------------------------------------------------------------------------
// Context checks
// --------------------------------------------------------------------------------------------------------------------

const LABEL_WORDS: ReadonlySet<string> = new Set(['BOARD', 'PCB', 'PN', 'P/N', 'DWG', 'MLB', 'MB', 'MAINBOARD', 'MOTHERBOARD', 'LOGIC', 'SCHEMATIC', 'SCH', 'MODEL', 'ASSY', 'BRD', 'NUMBER', 'NO', 'REF']);
const PHONE_WORDS: ReadonlySet<string> = new Set(['TEL', 'PHONE', 'FAX', 'CALL', 'GSM', 'HOTLINE', 'TELEFON', 'TELEFONE', 'MOB']);
const LABEL_WINDOW = 24;
const PHONE_WINDOW = 14;

/** Words (runs of letters, digits and "/") in the `window` folded units before `start`. */
function wordsBefore(text: string, length: number, start: number, window: number): string[] {
  const words: string[] = [];
  let current = '';
  for (let index = Math.max(0, start - window); index < start; index++) {
    const code = foldedAt(text, index, length);
    if (isAlnumCode(code) || code === 47) current += String.fromCharCode(code);
    else if (current !== '') { words.push(current); current = ''; }
  }
  if (current !== '') words.push(current);
  return words;
}

function hasLabel(text: string, length: number, start: number): boolean {
  for (const word of wordsBefore(text, length, start, LABEL_WINDOW)) if (LABEL_WORDS.has(word)) return true;
  return false;
}

/** Groups of up to four digits joined to the match by dashes or dots, counted to the left and to the right. */
function neighbourDigits(text: string, length: number, start: number, end: number): number {
  let total = 0, groups = 0;
  // to the left
  let pos = start;
  while (groups < 4) {
    const separator = foldedAt(text, pos - 1, length);
    if (separator !== 45 && separator !== 46) break;
    let from = pos - 1;
    while (from > 0 && isDigitCode(foldedAt(text, from - 1, length)) && pos - 1 - from < 5) from--;
    const size = pos - 1 - from;
    if (size < 1 || size > 4 || (from > 0 && isAlnumCode(foldedAt(text, from - 1, length)))) break;
    total += size; groups++; pos = from;
  }
  pos = end;
  while (groups < 8) {
    const separator = foldedAt(text, pos, length);
    if (separator !== 45 && separator !== 46) break;
    let to = pos + 1;
    while (to < length && isDigitCode(foldedAt(text, to, length)) && to - pos - 1 < 5) to++;
    const size = to - pos - 1;
    if (size < 1 || size > 4 || isAlnumCode(foldedAt(text, to, length))) break;
    total += size; groups++; pos = to;
  }
  return total;
}

function looksLikePhone(text: string, length: number, start: number, end: number, digitsInMatch: number, lastGroupSize: number): boolean {
  // An international prefix ("+") at the start of the run of digits, blanks, dashes, dots and brackets before the number.
  for (let at = start - 1, steps = 0; at >= 0 && steps < 24; at--, steps++) {
    const code = foldedAt(text, at, length);
    if (code === 43 && isDigitCode(foldedAt(text, at + 1, length))) return true;
    if (!(isDigitCode(code) || code === 32 || code === 45 || code === 46 || code === 40 || code === 41)) break;
  }
  // An area code in brackets just before the number: "(555) 051-9876".
  let bracket = start - 1;
  if (foldedAt(text, bracket, length) === 32) bracket--;
  if (foldedAt(text, bracket, length) === 41) {
    let digits = 0;
    while (digits < 5 && isDigitCode(foldedAt(text, bracket - 1 - digits, length))) digits++;
    if (digits >= 1 && digits <= 4 && foldedAt(text, bracket - 1 - digits, length) === 40) return true;
  }
  for (const word of wordsBefore(text, length, start, PHONE_WINDOW)) if (PHONE_WORDS.has(word)) return true;
  // Short groups run on to ten digits or more; a last group of five digits is not a phone number's.
  return lastGroupSize <= 4 && digitsInMatch + neighbourDigits(text, length, start, end) >= 10;
}

function isYearLike(value: string): boolean {
  if (value.length !== 4) return false;
  const year = Number(value);
  return year >= 1990 && year <= 2039;
}

function lastDigitGroup(text: string): string {
  let end = text.length;
  while (end > 0 && !isDigitCode(text.charCodeAt(end - 1))) end--;
  let start = end;
  while (start > 0 && isDigitCode(text.charCodeAt(start - 1))) start--;
  return text.slice(start, end);
}

// --------------------------------------------------------------------------------------------------------------------
// The recogniser
// --------------------------------------------------------------------------------------------------------------------

interface Candidate { shape: BoardNumberShape; start: number; end: number; normalized: string; revision?: string; loose: boolean; labelled: boolean; confidence: number }

const SCOPE_ADJUST: Readonly<Partial<Record<RecognitionScope, number>>> = { ocr: -15, body: -10 };
const LOOSE_PENALTY = 10;
const LABEL_BONUS = 5;

function clamp(value: number): number { return Math.max(1, Math.min(99, Math.round(value))); }

/**
 * Finds the board numbers in `text`. Total: any input (also a non-string) gives an array. At most `MAX_MATCHES` results,
 * sorted by position, none overlapping.
 */
export function recognizeBoardNumbers(text: string, options: BoardNumberOptions = {}): BoardNumberMatch[] {
  const length = scanLength(text);
  if (length === 0) return [];
  const scope: RecognitionScope = options.scope !== undefined && RECOGNITION_SCOPES.includes(options.scope) ? options.scope : 'name';
  const meter = options.meter;
  const shapes = BOARD_NUMBER_SHAPES.filter(item => scopeAllows(item.scopes, scope));
  if (shapes.length === 0) return [];
  const candidates: Candidate[] = [];
  // The device and vendor words of the whole text, looked up once and only when a shape needs them.
  let words: { device: boolean; vendors: Set<string> } | undefined;
  const hasDeviceWord = (vendor: string | undefined): boolean => {
    words ??= { device: deviceTypeHints(text, { meter }).some(hint => hint.confidence >= 50), vendors: new Set(vendorHints(text, { meter }).map(hint => hint.id)) };
    return words.device || (vendor !== undefined && words.vendors.has(vendor));
  };

  const accept = (item: BoardNumberShape, state: State, index: number, end: number): Candidate | null => {
    // Stands alone on the right.
    const next = foldedAt(text, end, length);
    if (isAlnumCode(next)) return null;
    const numeric = NUMERIC_SHAPE.has(item.id);
    const last = foldedAt(text, end - 1, length);
    if (numeric && isDigitCode(last) && (next === 45 || next === 46) && isDigitCode(foldedAt(text, end + 1, length))) return null;
    const group = lastDigitGroup(state.out);
    if (numeric && state.loose && isYearLike(group)) return null;
    if (numeric && looksLikePhone(text, length, index, end, state.out.replace(/[^0-9]/g, '').length, group.length)) return null;
    if (item.needsDeviceWord && !hasDeviceWord(item.vendor)) return null;
    const labelled = hasLabel(text, length, index);
    return {
      shape: item, start: index, end, normalized: state.out, revision: state.revision, loose: state.loose, labelled,
      confidence: clamp(item.confidence + (labelled ? LABEL_BONUS : 0) - (state.loose ? LOOSE_PENALTY : 0) + (SCOPE_ADJUST[scope] ?? 0)),
    };
  };

  let previousAlnum = false;
  for (let index = 0; index < length && candidates.length < MAX_MATCHES * 4; index++) {
    tick(meter);
    const code = foldCode(text.charCodeAt(index));
    const alnum = isAlnumCode(code);
    const atStart = alnum && !previousAlnum;
    previousAlnum = alnum;
    if (!atStart) continue;
    for (const item of shapes) {
      if ((FIRST_CODES.get(item.id) ?? NO_FIRST)[code] !== 1) continue;
      // An optional trailing group is tried first; when what it takes makes the number run into more letters or digits, the number is read without it.
      for (const skipOptional of HAS_OPTIONAL.has(item.id) ? [false, true] : [true]) {
        const state: State = { out: '', revision: undefined, lastRun: '', loose: false, skipOptional };
        const end = matchSegments(item.segments, text, length, index, state);
        tick(meter, end < 0 ? 1 : end - index);
        if (end < 0) continue;
        const candidate = accept(item, state, index, end);
        if (candidate) { candidates.push(candidate); break; }
      }
    }
  }

  // Overlaps: the more confident, then the longer, then the earlier one wins.
  const ranked = candidates.slice().sort((a, b) => b.confidence - a.confidence || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const chosen: Candidate[] = [];
  for (const candidate of ranked) {
    if (chosen.length >= MAX_MATCHES) break;
    if (chosen.every(other => candidate.end <= other.start || candidate.start >= other.end)) chosen.push(candidate);
  }
  chosen.sort((a, b) => a.start - b.start);
  return chosen.map(candidate => ({
    shape: candidate.shape.id,
    normalized: candidate.normalized,
    raw: text.slice(candidate.start, candidate.end),
    start: candidate.start,
    end: candidate.end,
    confidence: candidate.confidence,
    description: candidate.shape.description,
    ...(candidate.shape.vendor !== undefined ? { vendor: candidate.shape.vendor } : {}),
    ...(candidate.shape.device !== undefined ? { device: candidate.shape.device } : {}),
    ...(candidate.revision !== undefined ? { revision: candidate.revision } : {}),
    scope,
    loose: candidate.loose,
    labelled: candidate.labelled,
    provisional: candidate.shape.provisional === true,
  }));
}

/** The most confident match (then the longest, then the first), or undefined. */
export function bestBoardNumber(matches: readonly BoardNumberMatch[]): BoardNumberMatch | undefined {
  let best: BoardNumberMatch | undefined;
  for (const match of matches) {
    if (!best || match.confidence > best.confidence || (match.confidence === best.confidence && match.end - match.start > best.end - best.start)) best = match;
  }
  return best;
}

/** The confidence band of a score: high 80 and above, medium 55 to 79, low below. */
export function confidenceBand(confidence: number): 'high' | 'medium' | 'low' {
  return confidence >= 80 ? 'high' : confidence >= 55 ? 'medium' : 'low';
}
