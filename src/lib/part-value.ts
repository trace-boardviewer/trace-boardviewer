/**
 * Part value text -> typed quantity.
 *
 * Boards carry the value of a part as free text: "4K7", "0R", "R005", "100n", "0.1uF", "2.2uH", "600R@100MHz",
 * "10K 1% 0402", "DNP". `parsePartValue` reads such text into
 *
 *   { quantity, si, notFitted }   (plus `frequencyHz`, `tolerance` and `unitless` when they apply)
 *
 * where `si` is in base units (ohm, farad, henry, volt, ampere). Nothing here is a measurement and nothing is guessed
 * silently: text that is not recognisably a value gives `quantity: null, si: null`.
 *
 * Reading rules
 * - Numbers are decimal text only (no hexadecimal, no exponent form). A comma between digits is a decimal mark
 *   ("4,7k", "0,1uF") when at most three digits stand before it, so "0402,10K" stays two fields. The decimal digits are
 *   composed into a decimal string and parsed once, so "100n", "0.1u", "100nF" and "0,1µF" are the identical number.
 * - IEC 60062 style codes put the unit or prefix letter where the decimal point would be: "2R2" 2.2 ohm, "4K7" 4.7 kohm,
 *   "1M5", "4n7", "2u2", "3V3", "0R05", and "R005" (leading R) 0.005 ohm. The letters E and R both mean ohm, so "2E2"
 *   is 2.2 ohm, never 2.2 times ten to the power 2. A designator ("R1") would read as 0.1 ohm: callers pass value fields.
 * - Prefixes p n u (also the micro signs) m k M G and "meg". Resistance reads M as mega and m as milli; with the units
 *   F, H, V and A both mean milli, because there is no mega-farad. A prefix with no unit reads by convention: k M G meg
 *   are resistance, p n u are capacitance (inductance when the caller says so), m is resistance (or what the caller says).
 * - Units: R, E, the ohm signs and "ohm(s)" for resistance, F, H, V, A. Hz appears only inside an impedance.
 * - Ferrite impedance: a resistance followed by a frequency, "600R@100MHz", "120R/100M", "600R 100MHz", "220R(100MHz)".
 *   Without Hz the frequency needs a k, M or G, and after "/" it needs the resistance to carry an explicit ohm unit.
 * - A bare number ("0", "0.01") is a resistance by convention, or the quantity the caller expects with `hint`
 *   (then `si` is null for capacitance and inductance, because the scale is unknown). It is accepted only when it is the
 *   one number of the text: "1/16W" or "TYPE-C-31" give nothing. Package sizes ("0402", also as R code: "R0603") and
 *   integers of more than eight digits (part numbers) never count as values.
 * - A percent sign gives `tolerance` (0.05 for 5 %); "1%" alone is a tolerance, not a value.
 * - Not-fitted markers: NC, N/C, DNP, DNI, DNF, DNS, NF, NOSTUFF, NOPOP, NOFIT, NOPLACE, "DO NOT PLACE", "NOT FITTED",
 *   "NO STUFF" and the like, anywhere in the text; OPEN only when it is the whole text. The value next to the marker is
 *   still read ("10K DNP" is 10000 ohm and not fitted). A lone "nF" is a marker: with a number in front it is a unit.
 * - Not read on purpose: SMD three/four digit codes ("103"), exponent notation, percent-less tolerance letters, power
 *   ratings, dielectrics and frequencies by themselves ("16MHz"). Part numbers shaped like 4N35 read as 4.35 nF without a hint
 *   (upper-case N, P and U accept one digit after the letter, which keeps 1N4148, 2N3904 and 4N35 out), a known limit.
 *
 * Linear time by construction: one pass cuts the text into fields, every field is read by hand-written scanning (no
 * regular expressions, no backtracking), fields longer than 64 characters are skipped without being copied, and a field
 * is looked at a constant number of times.
 */

export type PartQuantity = 'resistance' | 'capacitance' | 'inductance' | 'impedance@f' | 'voltage' | 'current';
/** The quantity the caller expects from the kind of the part; it settles texts that carry no unit. */
export type ValueHint = 'resistance' | 'capacitance' | 'inductance';

export interface PartValue {
  quantity: PartQuantity | null;
  /** Base unit: ohm, farad, henry, volt, ampere; for `impedance@f` the impedance in ohm. Null when the scale is unknown. */
  si: number | null;
  /** A not-fitted marker (DNP, NC, NF, ...) stands in the text; the value, if any, is still reported. */
  notFitted: boolean;
  /** `impedance@f` only: the frequency of the impedance, in hertz. */
  frequencyHz?: number;
  /** A percent tolerance stands in the text, as a fraction (0.05 for 5 %). */
  tolerance?: number;
  /** The text has no unit (a bare number, or p/n/u/m without F, H or ohm); `quantity` comes from the hint or the convention. */
  unitless?: true;
}

/** The gap in front of a field: only blanks (a unit word may then join the number before it), other punctuation, a slash, an at sign; the strongest wins. */
const WHITE = 0, OTHER = 1, SLASH = 2, AT = 3;
const MAX_FIELD = 64;
const NOT_A_BREAK = -1;

interface Field { text: string; sep: number }
interface Quantity { kind: 'quantity'; quantity: PartQuantity; si: number; unitless: boolean; ohm: boolean }
interface Bare { kind: 'bare'; si: number; packageLike: boolean }
interface Tolerance { kind: 'tolerance'; value: number }
interface Primary { quantity: PartQuantity; si: number; unitless: boolean; frequencyHz?: number }
type Parsed = Quantity | Bare | Tolerance;

const isDigit = (code: number): boolean => code >= 48 && code <= 57;
const isLetter = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isOhmSign = (code: number): boolean => code === 0x3a9 || code === 0x2126;
const isMicro = (code: number): boolean => code === 0xb5 || code === 0x3bc;

function isWhite(code: number): boolean {
  return code <= 32 || code === 0xa0 || code === 0xfeff || (code >= 0x2000 && code <= 0x200b) || code === 0x1680 || code === 0x202f || code === 0x205f || code === 0x3000;
}

/** How a character separates two fields (WHITE, OTHER, SLASH, AT), or NOT_A_BREAK. Signs are decided by the scanner. */
function breakKind(code: number): number {
  if (isWhite(code)) return WHITE;
  switch (code) {
    case 47: return SLASH; // /
    case 64: return AT; // @
    case 44: case 59: case 40: case 41: case 91: case 93: case 123: case 125: case 124: case 95: case 61: case 58: case 34: case 39: case 60: case 62: case 92: case 177: case 126: case 42: case 35: case 33: case 38: return OTHER;
    default: return NOT_A_BREAK;
  }
}

/** A comma between digits is a decimal mark when at most three digits precede it and a digit follows ("4,7k"; not "0402,10K"). */
function isDecimalComma(text: string, start: number, at: number): boolean {
  if (at + 1 >= text.length || !isDigit(text.charCodeAt(at + 1))) return false;
  let first = at;
  while (first > start && isDigit(text.charCodeAt(first - 1))) first--;
  const length = at - first;
  if (length < 1 || length > 3) return false;
  if (length > 1 && text.charCodeAt(first) === 48) return false;
  if (first > start) { const before = text.charCodeAt(first - 1); if (before === 46 || before === 44) return false; }
  return true;
}

/** One pass: fields separated by blanks and punctuation; a field longer than MAX_FIELD is kept as an empty (unreadable) field. */
function scan(text: string): Field[] {
  const fields: Field[] = [];
  const length = text.length;
  let sep = WHITE, index = 0;
  while (index < length) {
    const code = text.charCodeAt(index);
    let kind = breakKind(code);
    if (kind === NOT_A_BREAK && (code === 43 || code === 45)) {
      // A sign belongs to the field only in front of a number and after a break ("VEE_-5V", "(-12V)"); right behind text it is a
      // hyphen or plus between two fields ("DNP-10K", "0805-10K").
      const next = index + 1 < length ? text.charCodeAt(index + 1) : 0;
      const before = index === 0 ? 32 : text.charCodeAt(index - 1);
      const signPlace = breakKind(before) !== NOT_A_BREAK || before === 43 || before === 45;
      if (!signPlace || (!isDigit(next) && next !== 46)) kind = OTHER;
    }
    if (kind !== NOT_A_BREAK) { if (kind > sep) sep = kind; index++; continue; }
    let end = index + 1;
    while (end < length) {
      const next = text.charCodeAt(end);
      if (next === 44) { if (isDecimalComma(text, index, end)) { end++; continue; } break; }
      if (next === 43 || next === 45 || breakKind(next) !== NOT_A_BREAK) break;
      end++;
    }
    fields.push({ text: end - index > MAX_FIELD ? '' : text.slice(index, end), sep });
    sep = WHITE; index = end;
  }
  return fields;
}

/** Digits with at most one decimal mark (point or comma) and at least one digit. */
function isPureNumber(text: string): boolean {
  let digits = 0, marks = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (isDigit(code)) digits++;
    else if (code === 46 || code === 44) { if (++marks > 1) return false; }
    else return false;
  }
  return digits > 0;
}

/** A trailing unit or prefix word that may stand apart from its number: "k", "ohm", "uF", "MHz", "%". */
function joinable(field: Field | undefined): field is Field {
  if (!field || field.sep !== WHITE || field.text.length === 0 || field.text.length > 8) return false;
  const first = field.text.charCodeAt(0);
  if (!(isLetter(first) || isOhmSign(first) || isMicro(first) || first === 37)) return false;
  for (let index = 1; index < field.text.length; index++) if (isDigit(field.text.charCodeAt(index))) return false;
  return true;
}

type Unit = '' | 'ohm' | 'F' | 'H' | 'V' | 'A';
interface Tail { prefix: string; unit: Unit }
const PREFIX_LETTERS = 'pPnNuUmMkKGgµμ';

function unitOf(text: string): Unit | null {
  if (text.length === 0) return '';
  if (text.length === 1 && isOhmSign(text.charCodeAt(0))) return 'ohm';
  switch (text.toLowerCase()) {
    case 'r': case 'e': case 'ohm': case 'ohms': return 'ohm';
    case 'f': return 'F';
    case 'h': return 'H';
    case 'v': return 'V';
    case 'a': return 'A';
    default: return null;
  }
}

/** `[prefix][unit]` after the number, both optional; null when the letters are neither. */
function readTail(tail: string): Tail | null {
  if (tail.length === 0) return { prefix: '', unit: '' };
  if (tail.length >= 3 && tail.slice(0, 3).toLowerCase() === 'meg') {
    const unit = unitOf(tail.slice(3));
    if (unit !== null) return { prefix: 'meg', unit };
  }
  if (PREFIX_LETTERS.includes(tail[0])) {
    const unit = unitOf(tail.slice(1));
    if (unit !== null) return { prefix: tail[0], unit };
  }
  const unit = unitOf(tail);
  return unit ? { prefix: '', unit } : null;
}

const INFIX_CODES = 'RrEeKkMmGgpPnNuUVvµμ';
/** Package sizes: a bare number or an R code that spells one is a package, not a value ("0402", "R0603"). */
const PACKAGE_SIZES: ReadonlySet<string> = new Set(['0201', '0402', '0603', '0805', '1008', '1206', '1210', '1218', '1806', '1808', '1812', '2010', '2220', '2225', '2512']);
/** A bare integer longer than this is a part number, not a resistance in ohm. */
const MAX_BARE_DIGITS = 8;

/** The magnitude as one decimal string so the result is the correctly rounded double, not a product of two rounded ones. */
const compose = (int: string, frac: string, exponent: number): number => Number(`${int || '0'}.${frac || '0'}e${exponent}`);

function readTolerance(text: string): Tolerance | null {
  let start = 0;
  while (start < text.length && (text.charCodeAt(start) === 43 || text.charCodeAt(start) === 45)) start++;
  const body = text.slice(start, text.length - 1);
  if (!isPureNumber(body)) return null;
  const point = body.indexOf('.'), comma = body.indexOf(','), mark = point >= 0 ? point : comma;
  const value = mark < 0 ? compose(body, '', -2) : compose(body.slice(0, mark), body.slice(mark + 1), -2);
  return Number.isFinite(value) ? { kind: 'tolerance', value } : null;
}

function readField(text: string, hint: ValueHint | undefined): Parsed | null {
  const length = text.length;
  if (length === 0) return null;
  if (text.charCodeAt(length - 1) === 37) return readTolerance(text);
  let at = 0, signed = false, negative = false;
  const sign = text.charCodeAt(0);
  if (sign === 43 || sign === 45) { signed = true; negative = sign === 45; at = 1; }
  let int = '', frac = '', code = '', tail = '', fracLimit = 3;
  const first = at < length ? text.charCodeAt(at) : 0;
  if ((first === 82 || first === 114) && at + 1 < length && isDigit(text.charCodeAt(at + 1))) {
    // R005: the leading R stands for "0." and is the unit.
    let end = at + 1;
    while (end < length && isDigit(text.charCodeAt(end))) end++;
    int = '0'; frac = text.slice(at + 1, end); code = 'R'; tail = 'R' + text.slice(end); fracLimit = 4;
    if (PACKAGE_SIZES.has(frac)) return null;
  } else {
    let end = at;
    while (end < length && isDigit(text.charCodeAt(end))) end++;
    int = text.slice(at, end);
    const next = end < length ? text.charCodeAt(end) : 0;
    if (next === 46 || next === 44) {
      let stop = end + 1;
      while (stop < length && isDigit(text.charCodeAt(stop))) stop++;
      frac = text.slice(end + 1, stop); tail = text.slice(stop);
    } else if (int !== '' && INFIX_CODES.includes(text[end] ?? '\0') && end + 1 < length && isDigit(text.charCodeAt(end + 1))) {
      let stop = end + 1;
      while (stop < length && isDigit(text.charCodeAt(stop))) stop++;
      frac = text.slice(end + 1, stop); code = text[end]; tail = code + text.slice(stop);
      fracLimit = code === 'R' || code === 'r' || code === 'E' || code === 'e' ? 4 : 3;
    } else tail = text.slice(end);
    if (int === '' && frac === '') return null;
  }
  if (frac.length > fracLimit) return null;
  const read = readTail(tail);
  if (!read) return null;
  const { prefix, unit } = read;
  // Upper-case N, P and U as the decimal point of an unitless code take one digit: 4N7 is a capacitor, 4N35 and 1N4148 are part numbers.
  if (code && unit === '' && (code === 'N' || code === 'P' || code === 'U') && frac.length > 1) return null;
  if ((prefix === 'G' || prefix === 'g' || prefix === 'meg') && unit !== '' && unit !== 'ohm') return null;
  let exponent = 0;
  switch (prefix) {
    case 'p': case 'P': exponent = -12; break;
    case 'n': case 'N': exponent = -9; break;
    case 'u': case 'U': case 'µ': case 'μ': exponent = -6; break;
    case 'm': exponent = -3; break;
    case 'M': exponent = unit === '' || unit === 'ohm' ? 6 : -3; break;
    case 'k': case 'K': exponent = 3; break;
    case 'G': case 'g': exponent = 9; break;
    case 'meg': exponent = 6; break;
    default: break;
  }
  const magnitude = compose(int, frac, exponent);
  if (!Number.isFinite(magnitude)) return null;
  if (prefix === '' && unit === '') {
    if (signed) return null;
    let allZero = frac === '';
    for (let index = 0; allZero && index < int.length; index++) if (int.charCodeAt(index) !== 48) allZero = false;
    if (int.length > MAX_BARE_DIGITS) return null;
    const packageLike = frac === '' && !allZero && ((int.length >= 3 && int[0] === '0') || PACKAGE_SIZES.has(int));
    return { kind: 'bare', si: magnitude, packageLike };
  }
  let quantity: PartQuantity, unitless = false;
  switch (unit) {
    case 'ohm': quantity = 'resistance'; break;
    case 'F': quantity = 'capacitance'; break;
    case 'H': quantity = 'inductance'; break;
    case 'V': quantity = 'voltage'; break;
    case 'A': quantity = 'current'; break;
    default:
      switch (prefix) {
        case 'k': case 'K': case 'G': case 'g': case 'meg': case 'M': quantity = 'resistance'; break;
        case 'm': quantity = hint === 'capacitance' ? 'capacitance' : hint === 'inductance' ? 'inductance' : 'resistance'; unitless = true; break;
        default:
          if (hint === 'resistance') return null;
          quantity = hint === 'inductance' ? 'inductance' : 'capacitance'; unitless = true;
      }
  }
  if (signed && quantity !== 'voltage' && quantity !== 'current') return null;
  return { kind: 'quantity', quantity, si: negative && magnitude !== 0 ? -magnitude : magnitude, unitless, ohm: unit === 'ohm' };
}

/** A frequency in hertz: number, optional k, M (also m) or G, optional Hz. Without Hz a prefix is required. */
function readFrequency(text: string, needHz: boolean): number | null {
  let end = 0;
  while (end < text.length && isDigit(text.charCodeAt(end))) end++;
  const int = text.slice(0, end);
  let frac = '', stop = end;
  if (end < text.length && (text.charCodeAt(end) === 46 || text.charCodeAt(end) === 44)) {
    stop = end + 1;
    while (stop < text.length && isDigit(text.charCodeAt(stop))) stop++;
    frac = text.slice(end + 1, stop);
  }
  if (int === '' && frac === '') return null;
  const tail = text.slice(stop).toLowerCase();
  let exponent: number, hz = false;
  switch (tail) {
    case '': return null;
    case 'hz': exponent = 0; hz = true; break;
    case 'k': exponent = 3; break;
    case 'khz': exponent = 3; hz = true; break;
    case 'm': exponent = 6; break;
    case 'mhz': exponent = 6; hz = true; break;
    case 'g': exponent = 9; break;
    case 'ghz': exponent = 9; hz = true; break;
    default: return null;
  }
  if (needHz && !hz) return null;
  const value = compose(int, frac, exponent);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readFrequencyAt(fields: Field[], index: number, needHz: boolean): { hz: number; used: number } | null {
  const field = fields[index];
  if (!field || field.text === '') return null;
  const next = fields[index + 1];
  if (isPureNumber(field.text) && joinable(next)) {
    const joined = readFrequency(field.text + next.text, needHz);
    if (joined !== null) return { hz: joined, used: 2 };
  }
  const single = readFrequency(field.text, needHz);
  return single === null ? null : { hz: single, used: 1 };
}

const WORD_MARKERS: ReadonlySet<string> = new Set(['nc', 'dnp', 'dni', 'dnf', 'dns', 'nf', 'nostuff', 'nopop', 'nofit', 'noplace', 'unstuffed', 'unpopulated', 'dnpop']);
const AFTER_DO_NOT: ReadonlySet<string> = new Set(['place', 'populate', 'stuff', 'fit', 'mount', 'install', 'pop', 'load', 'use']);
const AFTER_NOT: ReadonlySet<string> = new Set(['fitted', 'placed', 'mounted', 'populated', 'stuffed', 'installed', 'used', 'loaded', 'assembled']);
const AFTER_NO: ReadonlySet<string> = new Set(['stuff', 'pop', 'fit', 'place', 'load', 'mount', 'populate', 'install']);

/** Lower-cased field without dots ("N.C." -> "nc"); long fields are never markers. */
function wordOf(field: Field | undefined): string {
  if (!field || field.text.length === 0 || field.text.length > 16) return '';
  return field.text.toLowerCase().replaceAll('.', '');
}

/** How many fields a not-fitted marker starting at `index` takes; 0 when none starts there. */
function markerLength(fields: Field[], index: number): number {
  const word = wordOf(fields[index]);
  if (word === '') return 0;
  if (WORD_MARKERS.has(word)) return 1;
  if (word === 'open') return fields.length === 1 ? 1 : 0;
  const second = wordOf(fields[index + 1]);
  if (word === 'n' && second === 'c' && fields[index + 1].sep === SLASH) return 2;
  if (word === 'not' && AFTER_NOT.has(second)) return 2;
  if (word === 'no' && AFTER_NO.has(second)) return 2;
  if (word === 'do' && second === 'not' && AFTER_DO_NOT.has(wordOf(fields[index + 2]))) return 3;
  return 0;
}

export function parsePartValue(text: string, hint?: ValueHint | null): PartValue {
  const result: PartValue = { quantity: null, si: null, notFitted: false };
  if (typeof text !== 'string' || text.length === 0) return result;
  const expected = hint ?? undefined;
  const fields = scan(text);
  let primary: Primary | null = null;
  let electrical: Quantity | null = null;
  let bare: Bare | null = null, bareCount = 0, garbage = 0;
  let tolerance: number | undefined;
  for (let index = 0; index < fields.length;) {
    const field = fields[index];
    if (field.text === '') { garbage++; index++; continue; }
    let parsed: Parsed | null = null, used = 1;
    if (isPureNumber(field.text)) {
      // "10 k", "100 n F", "5 %": a number followed by separate unit words (longest reading first).
      const second = fields[index + 1], third = fields[index + 2];
      if (joinable(second)) {
        if (joinable(third)) { parsed = readField(field.text + second.text + third.text, expected); if (parsed) used = 3; }
        if (!parsed) { parsed = readField(field.text + second.text, expected); if (parsed) used = 2; }
      }
    }
    if (!parsed) {
      const marker = markerLength(fields, index);
      if (marker > 0) { result.notFitted = true; index += marker; continue; }
      parsed = readField(field.text, expected);
    }
    if (!parsed) { garbage++; index += used; continue; }
    if (parsed.kind === 'tolerance') { tolerance ??= parsed.value; index += used; continue; }
    if (parsed.kind === 'bare') {
      if (!parsed.packageLike) { bareCount++; bare ??= parsed; }
      index += used; continue;
    }
    if (parsed.quantity === 'voltage' || parsed.quantity === 'current') { electrical ??= parsed; index += used; continue; }
    let found: Primary = { quantity: parsed.quantity, si: parsed.si, unitless: parsed.unitless };
    if (parsed.quantity === 'resistance') {
      const next = fields[index + used];
      if (next && next.text !== '') {
        const needHz = next.sep <= OTHER || (next.sep === SLASH && !parsed.ohm);
        const frequency = readFrequencyAt(fields, index + used, needHz);
        if (frequency) { found = { quantity: 'impedance@f', si: parsed.si, unitless: false, frequencyHz: frequency.hz }; used += frequency.used; }
      }
    }
    primary ??= found;
    index += used;
  }
  if (primary) {
    result.quantity = primary.quantity; result.si = primary.si;
    if (primary.frequencyHz !== undefined) result.frequencyHz = primary.frequencyHz;
    if (primary.unitless) result.unitless = true;
  } else if (bare && bareCount === 1 && garbage === 0) {
    result.unitless = true;
    if (expected === 'capacitance' || expected === 'inductance') result.quantity = expected;
    else { result.quantity = 'resistance'; result.si = bare.si; }
  } else if (electrical) {
    result.quantity = electrical.quantity; result.si = electrical.si;
  }
  if (tolerance !== undefined) result.tolerance = tolerance;
  return result;
}
