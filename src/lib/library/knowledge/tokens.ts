/**
 * Token classes for text taken from PDFs and board files.
 *
 * The Library reads text that nobody wrote for it: PDF pages, title blocks, board-file values. Each token is put in exactly
 * one of seven classes, precision first (a doubtful token is `noise`, never promoted):
 *
 *   refdes        a reference designator (U7000, R12, C5001A, FB301)
 *   net           a net or rail name (PP3V3_S0, +5V, GND, PCH_PWROK, RESET#, USB3)
 *   part-number   a manufacturer part number: `known` when it belongs to a family of the CC0 table, `text` when it only looks
 *                 like one (5 to 24 characters, two or more letters and digits, never a value, net, reference or date)
 *   value         a component value (4K7, 100nF, 2.2uH, 600R@100MHz, 50V)
 *   package       a package or footprint name (0402, SOT-23-5, QFN32, TSSOP-16, DPAK)
 *   board-number  a board number of the shape table (820-01234, LA-Z123P)
 *   noise         everything else: words, page and sheet numbers, dates, bare numbers, punctuation, long runs
 *
 * Rules, in the order they are tried (the first that decides wins):
 *  1. no letter or digit, or longer than 64 characters: noise;
 *  2. after SHEET, PAGE, SH, SHT, PG, P, OF, NO: a short number is a page or sheet number: noise;
 *  3. only digits: a package size (0402, 0603, ...) or noise; dates and `3/12` page fractions are noise;
 *  4. a board number that spans the whole token (the scope decides which shapes may be read);
 *  5. a known part-number family (`TPS51225RUKR`, `LM358`, `2N7002`) wins over the reference-designator shape;
 *  6. a package name;
 *  7. a reference designator `[A-Z]{1,4}[0-9]{1,5}[A-Z]?` in upper case, except signal stems (USB3, DDR4, GPIO12) which are
 *     nets, and except leading-zero value codes such as R005;
 *  8. a value (`parsePartValue`) that is not a bare number; "3V3" and signed or prefixed voltages are rails, a plain "50V" is a value;
 *  9. a net: ground or power by `classifyNetName`, an underscore name, an active-low name (RESET#, /RESET);
 * 10. an unknown part-number-like token;
 * 11. noise.
 * Reference designators, part numbers and nets are read in upper case only: lower-case running text ("see u1") is prose.
 *
 * Linear time: the text is cut into tokens in one pass, each token is at most 64 characters long and is looked at a constant
 * number of times; longer runs are skipped without being copied. `tokenizeText` reads at most `MAX_TEXT_LENGTH` units and
 * returns at most `limit` tokens (default 20,000) and says when it stopped early.
 */
import { MAX_TOKEN_LENGTH, foldCode, isAlnumCode, isDigitCode, isLetterCode, scanLength, tick, type RecognitionScope, type WorkMeter } from './chars';
import { recognizeBoardNumbers } from './board-numbers';
import { normalizePartNumber } from './part-numbers';
import { classifyPart } from '../../part-kind';
import { parsePartValue } from '../../part-value';
import { classifyNetName } from '../../net-class';
import type { PartCategory } from './part-families';

export type TokenClass = 'refdes' | 'net' | 'part-number' | 'value' | 'package' | 'board-number' | 'noise';
export const TOKEN_CLASSES: readonly TokenClass[] = ['refdes', 'net', 'part-number', 'value', 'package', 'board-number', 'noise'];

export type TokenReason =
  | 'empty' | 'no-alnum' | 'too-long' | 'page-number' | 'date' | 'number' | 'package-size' | 'board-number' | 'known-part' | 'package-name'
  | 'refdes' | 'signal-label' | 'value' | 'rail-voltage' | 'rail' | 'ground' | 'net-name' | 'active-low' | 'part-like' | 'marker' | 'word' | 'lowercase' | 'other';

export interface TokenClassification {
  class: TokenClass;
  reason: TokenReason;
  /** The token, cut of outer punctuation and in upper case (at most 64 characters). */
  text: string;
  /** 0..100 */
  confidence: number;
  /** Part numbers only: `known` (a family of the table) or `text` (looks like one). */
  partTier?: 'known' | 'text';
  /** Known part numbers: the family id, the base and the repair function category. */
  family?: string;
  base?: string;
  category?: PartCategory;
  /** Board numbers: the shape id and the normalised number. */
  shape?: string;
  normalized?: string;
  /** Nets: what the name says. */
  netKind?: 'power' | 'ground' | 'signal';
  volts?: number;
}

export interface ClassifyOptions {
  /** Where the token comes from; default 'body' (running text), which reads the shapes of the `all` scope. */
  scope?: RecognitionScope;
  /** The token before this one, in upper case; "SHEET", "PAGE" ... make a following short number a page number. */
  previous?: string;
  meter?: WorkMeter;
}

export interface ClassifiedToken extends TokenClassification {
  /** The token as written. */
  raw: string;
  /** Span `[start, end)` of the token in the text. */
  start: number;
  end: number;
}

// --------------------------------------------------------------------------------------------------------------------
// Tables
// --------------------------------------------------------------------------------------------------------------------

const PAGE_WORDS: ReadonlySet<string> = new Set(['SHEET', 'SHEETS', 'SHT', 'SH', 'PAGE', 'PAGES', 'PG', 'P', 'OF', 'NO', 'NO.', 'PAGE:', 'SHEET:']);
const PAGE_PREFIXES: readonly string[] = ['SHEET', 'PAGE', 'SHT'];
const PACKAGE_SIZES: ReadonlySet<string> = new Set(['01005', '0201', '0402', '0603', '0805', '1005', '1206', '1210', '1812', '2010', '2220', '2512']);
const PACKAGE_STEMS: ReadonlySet<string> = new Set([
  'SOT', 'SC', 'SOD', 'SOIC', 'SOP', 'SSOP', 'TSSOP', 'MSOP', 'QFN', 'DFN', 'SON', 'WSON', 'UQFN', 'VQFN', 'TQFN', 'WQFN', 'LQFP', 'TQFP', 'QFP', 'BGA', 'FBGA', 'LFBGA',
  'WLCSP', 'CSP', 'TO', 'LGA', 'DIP', 'PDIP', 'SIP', 'HVSON', 'VSON', 'PQFN', 'HSOP', 'SOT', 'TSOT', 'USON', 'XSON', 'XFBGA', 'VFBGA', 'TFBGA', 'WLP', 'PLCC',
]);
const PACKAGE_NAMES: ReadonlySet<string> = new Set(['DPAK', 'D2PAK', 'D3PAK', 'SMA', 'SMB', 'SMC', 'SOD123', 'SOT23', 'MELF', 'POWERPAK']);
const SIGNAL_STEMS: ReadonlySet<string> = new Set([
  'USB', 'PCIE', 'PCI', 'DDR', 'LPDDR', 'HDMI', 'SATA', 'SPI', 'I2C', 'I2S', 'UART', 'GPIO', 'ADC', 'DAC', 'PWM', 'CAN', 'JTAG', 'SWD', 'LVDS', 'EDP', 'DP', 'HPD',
  'SMB', 'SMBUS', 'LPC', 'ESPI', 'SDIO', 'MIPI', 'CSI', 'DSI', 'TMDS', 'AUX', 'CC', 'SBU', 'VBUS', 'IRQ', 'INT', 'RST', 'CLK', 'GPU', 'DQ', 'DQS', 'CKE', 'CS',
  'RX', 'TX', 'SDA', 'SCL', 'MISO', 'MOSI', 'SCK', 'AD', 'PA', 'PB', 'PE',
]);
const DAY_MONTH_RANGE = (value: number, max: number): boolean => value >= 1 && value <= max;

// --------------------------------------------------------------------------------------------------------------------
// Small recognisers
// --------------------------------------------------------------------------------------------------------------------

function isAllDigits(text: string): boolean {
  if (text.length === 0) return false;
  for (let index = 0; index < text.length; index++) if (!isDigitCode(text.charCodeAt(index))) return false;
  return true;
}

/** Digit groups separated by one of "-", ".", "/" (at most three), as numbers with their lengths; null when the text is another shape. */
function digitGroups(text: string): Array<{ value: number; length: number }> | null {
  const groups: Array<{ value: number; length: number }> = [];
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    const code = index < text.length ? text.charCodeAt(index) : 0;
    if (index === text.length || code === 45 || code === 46 || code === 47) {
      const part = text.slice(start, index);
      if (part === '' || part.length > 4 || !isAllDigits(part) || groups.length >= 3) return null;
      groups.push({ value: Number(part), length: part.length });
      start = index + 1;
    } else if (!isDigitCode(code)) return null;
  }
  return groups;
}

/** yyyy-mm-dd, dd.mm.yyyy, mm/dd/yyyy, dd.mm.yy and yyyymmdd with valid month and day. */
function isDateToken(text: string): boolean {
  if (text.length === 8 && isAllDigits(text)) {
    const year = Number(text.slice(0, 4)), month = Number(text.slice(4, 6)), day = Number(text.slice(6, 8));
    return year >= 1900 && year <= 2100 && DAY_MONTH_RANGE(month, 12) && DAY_MONTH_RANGE(day, 31);
  }
  const groups = digitGroups(text);
  if (!groups || groups.length !== 3) return false;
  const [a, b, c] = groups;
  if (a.length === 4 && b.length <= 2 && c.length <= 2) return a.value >= 1900 && a.value <= 2100 && DAY_MONTH_RANGE(b.value, 12) && DAY_MONTH_RANGE(c.value, 31);
  if (c.length === 4 && a.length <= 2 && b.length <= 2) return c.value >= 1900 && c.value <= 2100 && ((DAY_MONTH_RANGE(a.value, 31) && DAY_MONTH_RANGE(b.value, 12)) || (DAY_MONTH_RANGE(a.value, 12) && DAY_MONTH_RANGE(b.value, 31)));
  if (a.length <= 2 && b.length <= 2 && c.length === 2) return ((DAY_MONTH_RANGE(a.value, 31) && DAY_MONTH_RANGE(b.value, 12)) || (DAY_MONTH_RANGE(a.value, 12) && DAY_MONTH_RANGE(b.value, 31)));
  return false;
}

/** `3/12`, `12/40`: a page fraction. */
function isPageFraction(text: string): boolean {
  const slash = text.indexOf('/');
  return slash > 0 && slash === text.lastIndexOf('/') && slash <= 3 && text.length - slash <= 4 && isAllDigits(text.slice(0, slash)) && isAllDigits(text.slice(slash + 1));
}

/** The letters at the start of a token. */
function leadingLetters(text: string): string {
  let end = 0;
  while (end < text.length && isLetterCode(text.charCodeAt(end))) end++;
  return text.slice(0, end);
}

/** A package name: a known stem with a size ("SOT-23-5", "QFN32", "DFN2020-6", "TO-220") or a bare name ("DPAK"). */
function isPackageName(text: string): boolean {
  if (PACKAGE_NAMES.has(text)) return true;
  const stem = leadingLetters(text);
  if (stem === '' || !PACKAGE_STEMS.has(stem)) return false;
  let index = stem.length;
  if (text.charCodeAt(index) === 45 || text.charCodeAt(index) === 95) index++;
  const digitsFrom = index;
  while (index < text.length && isDigitCode(text.charCodeAt(index))) index++;
  const digits = index - digitsFrom;
  if (digits < 1 || digits > 4) return false;
  // Further groups: "-5", "-5X5", ".5", "X3".
  let groups = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 45 || code === 46 || code === 88 || code === 95) index++; else return false;
    const from = index;
    while (index < text.length && isAlnumCode(text.charCodeAt(index))) index++;
    if (index === from || index - from > 4 || ++groups > 3) return false;
  }
  return true;
}

const TOKEN_REFDES_MAX_LETTERS = 4;
const TOKEN_REFDES_MAX_DIGITS = 5;

/** `[A-Z]{1,4}[0-9]{1,5}[A-Z]?`; returns the letters when it fits. */
function refdesLetters(text: string): string | null {
  let index = 0;
  while (index < text.length && isLetterCode(text.charCodeAt(index))) index++;
  if (index < 1 || index > TOKEN_REFDES_MAX_LETTERS) return null;
  const letters = index;
  while (index < text.length && isDigitCode(text.charCodeAt(index))) index++;
  const digits = index - letters;
  if (digits < 1 || digits > TOKEN_REFDES_MAX_DIGITS) return null;
  if (index < text.length && !(index === text.length - 1 && isLetterCode(text.charCodeAt(index)))) return null;
  return text.slice(0, letters);
}

/** A name with an underscore whose field is a word ("VCC_3V3", "3V3_AUX", "CLK_100M"): a net, not a value. */
function hasWordField(text: string): boolean {
  if (!text.includes('_')) return false;
  for (const field of text.split('_')) {
    let letters = 0;
    for (let index = 0; index < field.length; index++) { if (isLetterCode(field.charCodeAt(index))) letters++; else { letters = -1; break; } }
    if (letters >= 2) return true;
  }
  return false;
}

function hasLowercase(text: string): boolean {
  for (let index = 0; index < text.length; index++) { const code = text.charCodeAt(index); if (code >= 97 && code <= 122) return true; }
  return false;
}

function upperCase(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index++) out += String.fromCharCode(foldCode(text.charCodeAt(index)));
  return out;
}

const NET_CHARS_OK = (code: number): boolean => isAlnumCode(code) || code === 95 || code === 43 || code === 45 || code === 47 || code === 46 || code === 35;

// --------------------------------------------------------------------------------------------------------------------
// The classifier
// --------------------------------------------------------------------------------------------------------------------

const make = (cls: TokenClass, reason: TokenReason, text: string, confidence: number, extra: Partial<TokenClassification> = {}): TokenClassification => ({ class: cls, reason, text, confidence, ...extra });
const noise = (reason: TokenReason, text: string, confidence = 90): TokenClassification => make('noise', reason, text, confidence);

/** Cuts wrapper punctuation off both ends of a token; a trailing dot goes, a leading "+", "-", "/" or "#" stays (rail and net marks). */
export function trimToken(token: string): string {
  let start = 0, end = Math.min(token.length, MAX_TOKEN_LENGTH + 8);
  const wrap = (code: number): boolean => code === 40 || code === 41 || code === 91 || code === 93 || code === 123 || code === 125 || code === 60 || code === 62 || code === 34 || code === 39 || code === 44 || code === 59 || code === 58 || code === 33 || code === 63 || code === 42 || code === 126 || code === 124 || code === 96;
  while (start < end && (wrap(token.charCodeAt(start)) || token.charCodeAt(start) === 46)) start++;
  while (end > start && (wrap(token.charCodeAt(end - 1)) || token.charCodeAt(end - 1) === 46 || token.charCodeAt(end - 1) === 45 || token.charCodeAt(end - 1) === 95 || token.charCodeAt(end - 1) === 47)) end--;
  return token.slice(start, end);
}

/** Classifies one token. Total: any input gives a classification. */
export function classifyToken(token: string, options: ClassifyOptions = {}): TokenClassification {
  if (typeof token !== 'string' || token.length === 0) return noise('empty', '');
  const meter = options.meter;
  tick(meter, Math.min(token.length, MAX_TOKEN_LENGTH + 8));
  if (token.length > MAX_TOKEN_LENGTH + 16) return noise('too-long', '');
  const trimmed = trimToken(token);
  if (trimmed.length === 0) return noise('no-alnum', '');
  if (trimmed.length > MAX_TOKEN_LENGTH) return noise('too-long', '');
  const lower = hasLowercase(trimmed);
  const text = upperCase(trimmed);
  let hasAlnum = false;
  for (let index = 0; index < text.length; index++) if (isAlnumCode(text.charCodeAt(index))) { hasAlnum = true; break; }
  if (!hasAlnum) return noise('no-alnum', text);

  // 2. a page or sheet number after its word, or the word and its number joined
  const previous = options.previous;
  if (previous !== undefined && PAGE_WORDS.has(previous) && text.length <= 4 && /[0-9]/.test(text) && /^[0-9A-Z]+$/.test(text)) return noise('page-number', text, 80);
  for (const prefix of PAGE_PREFIXES) if (text.length > prefix.length && text.length <= prefix.length + 3 && text.startsWith(prefix) && isAllDigits(text.slice(prefix.length))) return noise('page-number', text, 75);

  // 3. numbers, dates, page fractions
  if (isAllDigits(text)) {
    if (PACKAGE_SIZES.has(text)) return make('package', 'package-size', text, 55);
    if (isDateToken(text)) return noise('date', text);
    return noise('number', text);
  }
  if (isDateToken(text)) return noise('date', text);
  if (isPageFraction(text)) return noise('page-number', text, 80);

  // 4. board number across the whole token
  const boards = recognizeBoardNumbers(trimmed, { scope: options.scope ?? 'body', meter });
  if (boards.length === 1 && boards[0].start === 0 && boards[0].end === trimmed.length) {
    return make('board-number', 'board-number', text, boards[0].confidence, { shape: boards[0].shape, normalized: boards[0].normalized });
  }

  const upperOnly = !lower;
  // 5. known part-number family
  if (upperOnly) {
    const keys = normalizePartNumber(text, { meter });
    if (keys && keys.family !== undefined) {
      return make('part-number', 'known-part', keys.exact, 85, { partTier: 'known', family: keys.family, ...(keys.base !== undefined ? { base: keys.base } : {}), ...(keys.category !== undefined ? { category: keys.category } : {}) });
    }
  }

  // 6. package name
  if (upperOnly && isPackageName(text)) return make('package', 'package-name', text, 80);

  // 7. reference designator
  if (upperOnly) {
    const letters = refdesLetters(text);
    if (/^(?:I2C|I2S)[0-9]{1,2}$/.test(text)) return make('net', 'signal-label', text, 50, { netKind: 'signal' });
    if (letters !== null) {
      if (SIGNAL_STEMS.has(letters)) return make('net', 'signal-label', text, 50, { netKind: 'signal' });
      if (classifyNetName(text).kind === 'ground') return make('net', 'ground', text, 85, { netKind: 'ground' });
      const leadingZeroValue = (letters === 'R' || letters === 'C' || letters === 'L') && text.charCodeAt(1) === 48 && text.length >= 4;
      if (!leadingZeroValue) {
        const kind = classifyPart({ ref: text });
        return make('refdes', 'refdes', text, kind.confidence === 'high' ? 90 : kind.confidence === 'medium' ? 75 : 55);
      }
    }
  }

  // 8. value
  const value = parsePartValue(text);
  if (value.quantity !== null && !value.notFitted && !hasWordField(text)) {
    const bareNumber = value.unitless === true && /^[0-9.,+\-/_]+$/.test(text);
    if (!bareNumber) {
      if (value.quantity === 'voltage') {
        const rail = /^[+-]/.test(text) || /^[0-9]+V[0-9]+$/.test(text);
        if (rail) return make('net', 'rail-voltage', text, 65, { netKind: 'power', ...(value.si !== null ? { volts: value.si } : {}) });
      }
      return make('value', 'value', text, value.quantity === 'voltage' ? 50 : 80);
    }
  }
  if (value.notFitted) return noise('marker', text, 80);

  // 9. nets
  if (upperOnly || trimmed.includes('_') || trimmed.charCodeAt(0) === 47) {
    let netOk = true;
    for (let index = 0; index < text.length; index++) if (!NET_CHARS_OK(text.charCodeAt(index))) { netOk = false; break; }
    if (netOk) {
      const cls = classifyNetName(text);
      if (cls.kind === 'ground') return make('net', 'ground', text, 85, { netKind: 'ground' });
      if (cls.kind === 'power') return make('net', 'rail', text, 80, { netKind: 'power', ...(cls.expectedVoltage ? { volts: cls.expectedVoltage.volts } : {}) });
      if (cls.kind === 'no-connect') return noise('marker', text, 80);
      let letters = 0;
      for (let index = 0; index < text.length; index++) if (isLetterCode(text.charCodeAt(index))) letters++;
      if (letters >= 2) {
        if (text.charCodeAt(text.length - 1) === 35 && text.length >= 3) return make('net', 'active-low', text, 65, { netKind: 'signal' });
        if (text.includes('_') && text.charCodeAt(0) !== 95 && text.charCodeAt(text.length - 1) !== 95) return make('net', 'net-name', text, 70, { netKind: 'signal' });
        if (text.charCodeAt(0) === 47 && text.length >= 3) return make('net', 'active-low', text, 60, { netKind: 'signal' });
      }
    }
  }

  // 10. a token that only looks like a part number
  if (upperOnly && text.length >= 5 && text.length <= 24) {
    let letters = 0, digits = 0, ok = true;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (isLetterCode(code)) letters++;
      else if (isDigitCode(code)) digits++;
      else if (!(code === 45 || code === 47 || code === 46 || code === 35 || code === 43)) { ok = false; break; }
    }
    const edge = text.charCodeAt(0), last = text.charCodeAt(text.length - 1);
    if (ok && letters >= 2 && digits >= 2 && isAlnumCode(edge) && (isAlnumCode(last) || last === 43)) return make('part-number', 'part-like', text, 40, { partTier: 'text' });
  }

  // 11. noise
  if (lower && /^[A-Za-z]+$/.test(trimmed)) return noise('word', text, 80);
  if (/^[A-Z]+$/.test(text)) return noise('word', text, 70);
  return noise(lower ? 'lowercase' : 'other', text, 60);
}

// --------------------------------------------------------------------------------------------------------------------
// Tokenising
// --------------------------------------------------------------------------------------------------------------------

/** Characters that stay inside a token: letters, digits, the net and value marks, and the units Ω and µ. */
function isTokenCode(code: number): boolean {
  if (code < 128) return isAlnumCode(foldCode(code)) || code === 95 || code === 43 || code === 45 || code === 46 || code === 47 || code === 35 || code === 38 || code === 37 || code === 64 || code === 36;
  return code === 0x3a9 || code === 0x2126 || code === 0xb5 || code === 0x3bc || code === 0xb1;
}

export interface TokenizeOptions {
  scope?: RecognitionScope;
  /** The most tokens returned; default 20,000. */
  limit?: number;
  meter?: WorkMeter;
}

export interface TokenizeResult { tokens: ClassifiedToken[]; truncated: boolean }

export const DEFAULT_TOKEN_LIMIT = 20_000;

/**
 * Cuts a text into tokens and classifies each one, with the previous token as context for page numbers. Total: any input gives
 * a result. Tokens longer than 64 characters are classified as noise without being copied.
 */
export function tokenizeText(text: string, options: TokenizeOptions = {}): TokenizeResult {
  const length = scanLength(text);
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_TOKEN_LIMIT, DEFAULT_TOKEN_LIMIT));
  const tokens: ClassifiedToken[] = [];
  if (length === 0) return { tokens, truncated: false };
  const meter = options.meter;
  let index = 0, previous: string | undefined;
  while (index < length) {
    const code = text.charCodeAt(index);
    if (!isTokenCode(code)) { index++; tick(meter); continue; }
    const start = index;
    while (index < length && isTokenCode(text.charCodeAt(index))) index++;
    tick(meter, index - start + 1);
    if (tokens.length >= limit) return { tokens, truncated: true };
    const classification = index - start > MAX_TOKEN_LENGTH + 16
      ? noise('too-long', '')
      : classifyToken(text.slice(start, index), { scope: options.scope, previous, meter });
    tokens.push({ ...classification, raw: index - start > MAX_TOKEN_LENGTH + 16 ? '' : text.slice(start, index), start, end: index });
    previous = classification.text === '' ? undefined : classification.text;
  }
  return { tokens, truncated: false };
}

/** How many tokens of each class. */
export function countTokenClasses(tokens: ReadonlyArray<Pick<TokenClassification, 'class'>>): Record<TokenClass, number> {
  const counts: Record<TokenClass, number> = { refdes: 0, net: 0, 'part-number': 0, value: 0, package: 0, 'board-number': 0, noise: 0 };
  for (const token of tokens) counts[token.class]++;
  return counts;
}
