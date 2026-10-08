import type { Board } from './types';

/**
 * Net classes: ground, power, no-connect, signal.
 *
 * The class of a net comes from its NAME (and, for the ground fallback, from how many pins it holds). It is a reading
 * aid, never a measurement: `expectedVoltage` is a hint taken from the text of the name ("PP3V3_S5" suggests 3.3 V) and
 * must be shown as a hint, never as a reading or a reference.
 *
 *  - no-connect: the empty name, `NC`, `N/C`, and the UNCONNECTED placeholders (UNCONNECTED, UNCONNECTED<n>, KiCad
 *    "unconnected-(R1-Pad2)").
 *  - ground: the name matches one of the ground patterns (case-insensitive; `*` matches any run of characters and a `#` at the
 *    end of a pattern the run of digits at the end of a name, so `GND#` is GND1, GND2 and GND12 but not GND or GNDX; the default
 *    list is `DEFAULT_GROUND_PATTERNS` and callers pass their own, for example from Settings). A hierarchical name such as
 *    "/power/GND" is also tested by its last segment. When no net of the board matches by name, the net holding the most
 *    pins is ground if it holds MORE than 15 % of all pins (and is not named like a power rail, not a no-connect and not
 *    tied with another net for the most pins).
 *  - power: the name carries a voltage ("+5V", "3V3", "VCC_1V8", "PP3V3_S5", "1V8", "12V", "-12V", "3P3V", "V3P3", "5VSB") or
 *    is a bare rail word (VCC, VDD, VBAT, VBUS, VSYS, VIN, DCIN, ...; USBVCC too). A trailing control word (EN, PG, PGOOD, FB,
 *    SW, PHASE, COMP, ...) or a data-line word anywhere (SDA, SCL, TACH, PWM, ...) turns it back into a signal: "5V_EN" is an
 *    enable line, "TMDS_SDA_5V0" an I2C line, not rails. Two different voltages in one name give no hint.
 *  - signal: everything else.
 *
 * Voltage digits without a V ("VDD33", "VCC18") are not read: they cannot be told from other numbers.
 * Names longer than 1024 characters are never ground, power or hinted. Matching is hand-written scanning with bounded
 * pattern sizes, so it is linear in the length of a name.
 */

/** Ground patterns used when the caller gives none. Case-insensitive; `*` matches any run of characters, a `#` at the end the digits at the end of a name. */
export const DEFAULT_GROUND_PATTERNS: readonly string[] = Object.freeze([
  'GND', 'GROUND', 'GND#', 'AGND', 'DGND', 'PGND', 'SGND', 'CGND', 'GNDA', 'GNDD', 'VSS', 'VSSA', 'VSSD', 'AVSS', 'DVSS', '0V', 'CHASSIS_GND', 'GND_*', '*_GND',
]);
/** The largest net is ground when it holds more than this share of all pins and no name matched. */
export const GROUND_FALLBACK_SHARE = 0.15;

const MAX_NAME = 1024;
const MAX_PATTERN = 128;
const MAX_PATTERNS = 512;

export type NetKind = 'ground' | 'power' | 'no-connect' | 'signal';
export type GroundBasis = 'name' | 'largest-net';

/** What a net name suggests about the rail voltage. A guess from text: never a reading, never a reference. */
export interface ExpectedVoltageHint {
  /** Volts the name suggests; negative for names like "-12V". */
  readonly volts: number;
  readonly source: 'net-name';
}

export interface NetClass {
  readonly kind: NetKind;
  /** Only for ground: matched by name, or the fallback "largest net". */
  readonly groundBasis?: GroundBasis;
  /** Only for power nets whose name carries a voltage. */
  readonly expectedVoltage?: ExpectedVoltageHint;
}

export interface NetClassOptions {
  /** Ground name patterns; default `DEFAULT_GROUND_PATTERNS`. */
  groundPatterns?: readonly string[];
  /** Share of all pins above which the largest net is ground when no name matched; default 0.15, `Infinity` turns the fallback off. */
  fallbackShare?: number;
}

const isDigit = (code: number): boolean => code >= 48 && code <= 57;
const isLetter = (code: number): boolean => code >= 65 && code <= 90;
const isAlnum = (code: number): boolean => isDigit(code) || isLetter(code);

// ---------------------------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------------------------

export type NameMatcher = (name: string) => boolean;

function globMatches(segments: readonly string[], text: string): boolean {
  const first = segments[0], last = segments[segments.length - 1];
  if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
  let position = first.length;
  const end = text.length - last.length;
  for (let index = 1; index < segments.length - 1; index++) {
    const segment = segments[index];
    if (segment === '') continue;
    const at = text.indexOf(segment, position);
    if (at < 0 || at + segment.length > end) return false;
    position = at + segment.length;
  }
  return true;
}

/** Compiles ground patterns once; use it when classifying many nets. Empty, over-long and bare "*" and "#" patterns are ignored. */
export function createGroundMatcher(patterns: readonly string[] = DEFAULT_GROUND_PATTERNS): NameMatcher {
  if (!Array.isArray(patterns)) patterns = DEFAULT_GROUND_PATTERNS;
  const exact = new Set<string>();
  const globs: string[][] = [];
  // Patterns that end with "#": the name must end with a run of digits, and what stands before that run is matched like any other pattern.
  const digitStems = new Set<string>();
  const digitGlobs: string[][] = [];
  let taken = 0;
  for (const raw of patterns) {
    if (typeof raw !== 'string' || taken >= MAX_PATTERNS) continue;
    let pattern = raw.trim().toUpperCase();
    if (pattern === '' || pattern.length > MAX_PATTERN) continue;
    taken++;
    const digits = pattern.endsWith('#');
    if (digits) pattern = pattern.slice(0, -1);
    if (!pattern.includes('*')) {
      if (pattern === '') continue;
      (digits ? digitStems : exact).add(pattern);
      continue;
    }
    const segments = pattern.split('*');
    if (segments.every(segment => segment === '')) continue;
    (digits ? digitGlobs : globs).push(segments);
  }
  const hasDigitPatterns = digitStems.size > 0 || digitGlobs.length > 0;
  const test = (text: string) => {
    if (exact.has(text) || globs.some(segments => globMatches(segments, text))) return true;
    if (!hasDigitPatterns) return false;
    let end = text.length;
    while (end > 0 && isDigit(text.charCodeAt(end - 1))) end--;
    if (end === text.length) return false;
    const stem = text.slice(0, end);
    return digitStems.has(stem) || digitGlobs.some(segments => globMatches(segments, stem));
  };
  return name => {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME) return false;
    const upper = name.trim().toUpperCase();
    if (test(upper)) return true;
    const slash = upper.lastIndexOf('/');
    return slash >= 0 && slash < upper.length - 1 && test(upper.slice(slash + 1));
  };
}

let defaultMatcher: NameMatcher | undefined;
const matcherFor = (patterns: readonly string[] | undefined): NameMatcher =>
  patterns === undefined || patterns === DEFAULT_GROUND_PATTERNS ? (defaultMatcher ??= createGroundMatcher()) : createGroundMatcher(patterns);

/** True when `name` matches a ground pattern (the default list unless one is given). Compile with `createGroundMatcher` for many names. */
export function isGroundName(name: string, patterns?: readonly string[]): boolean {
  return matcherFor(patterns)(name);
}

// ---------------------------------------------------------------------------------------------
// No-connect
// ---------------------------------------------------------------------------------------------

/**
 * The empty name (no net), `NC`, `N/C`, and the UNCONNECTED placeholders, case-insensitive. UNCONNECTED counts when it ends the
 * name or is followed by a digit, `<`, `(`, `_` or `-` ("UNCONNECTED", "UNCONNECTED12", "UNCONNECTED<7>", "unconnected-(R1-Pad2)"): the
 * rule of `vendorDisconnected` in the format adapters, which keep a real net called "UNCONNECTEDLY".
 */
export function isNoConnectName(name: string): boolean {
  if (typeof name !== 'string') return false;
  const text = name.trim();
  if (text === '') return true;
  if (text.length <= 3) { const upper = text.toUpperCase(); return upper === 'NC' || upper === 'N/C'; }
  if (text.length < 11 || text.slice(0, 11).toUpperCase() !== 'UNCONNECTED') return false;
  if (text.length === 11) return true;
  const next = text.charCodeAt(11);
  return isDigit(next) || next === 60 || next === 40 || next === 95 || next === 45;
}

// ---------------------------------------------------------------------------------------------
// Power rails
// ---------------------------------------------------------------------------------------------

/** Letters allowed directly in front of a voltage ("PP3V3", "VCC3V3"); any other letters make it part of a longer word ("USB3V3"). */
const RAIL_PREFIXES: ReadonlySet<string> = new Set(['PP', 'VCC', 'VDD', 'VDDQ', 'VDDIO', 'VCCIO', 'VIO', 'AVDD', 'DVDD', 'AVCC', 'DVCC', 'VCCA', 'VDDA', 'VBAT', 'VBUS', 'VIN', 'VOUT', 'VSYS', 'VPP', 'VREG', 'PWR', 'VMEM', 'VCORE', 'VLDO']);
/** A last word like these makes a voltage-named net a control, sense or regulator-internal line, not a rail. */
const SIGNAL_SUFFIXES: ReadonlySet<string> = new Set(['EN', 'ENABLE', 'PG', 'PGOOD', 'PWRGD', 'PGD', 'FB', 'SW', 'LX', 'SNS', 'SENSE', 'ILIM', 'ON', 'OFF', 'DET', 'CTRL', 'CTL', 'SEL',
  'COMP', 'MODE', 'SS', 'FSW', 'PHASE', 'BOOT', 'GATE', 'TRIP', 'UVLO', 'OVP', 'OCP', 'FAULT', 'FLT', 'ALERT', 'IRQ', 'RESET', 'RST', 'SYNC', 'SDA', 'SCL', 'CLK', 'TX', 'RX']);
/** Words that make a net a data or control line wherever they stand in the name ("TMDS_SDA_5V0", "FAN_TACH_5V"). */
const SIGNAL_ANYWHERE: ReadonlySet<string> = new Set(['SDA', 'SCL', 'SCLK', 'MOSI', 'MISO', 'TACH', 'PWM', 'PMW', 'CLK', 'TX', 'RX', 'TXD', 'RXD']);
/** Words that name a supply without saying its voltage. */
const POWER_SUFFIXES = ['VCC', 'VDD', 'VBUS', 'VBAT', 'VSYS'];
const POWER_WORDS: ReadonlySet<string> = new Set(['VCC', 'VDD', 'VEE', 'VBAT', 'VBATT', 'VBUS', 'VSYS', 'VIN', 'DCIN', 'VDDIO', 'VCCIO', 'VDDQ', 'AVDD', 'DVDD', 'AVCC', 'DVCC', 'VCCA', 'VDDA', 'VCORE', 'VPP']);
const MAX_SUFFIX = 6;
const MIN_VOLTS = 0.3, MAX_VOLTS = 100;

const codeAt = (text: string, index: number): number => (index >= 0 && index < text.length ? text.charCodeAt(index) : -1);

/** The runs of letters and digits of an upper-cased name, in order. */
function tokensOf(upper: string): string[] {
  const tokens: string[] = [];
  let start = -1;
  for (let index = 0; index <= upper.length; index++) {
    if (index < upper.length && isAlnum(upper.charCodeAt(index))) { if (start < 0) start = index; }
    else if (start >= 0) { tokens.push(upper.slice(start, index)); start = -1; }
  }
  return tokens;
}

/** The name ends in a control word, or contains a data-line word: not a rail whatever voltage it carries. */
const hasSignalWord = (tokens: readonly string[]): boolean => tokens.length > 0 && (SIGNAL_SUFFIXES.has(tokens[tokens.length - 1]) || tokens.some(token => SIGNAL_ANYWHERE.has(token)));

const isPowerToken = (token: string): boolean => POWER_WORDS.has(token)
  || POWER_SUFFIXES.some(suffix => token.length > suffix.length && token.endsWith(suffix) && isLetter(token.charCodeAt(token.length - suffix.length - 1)));

/** Letters directly before `at` that form a whole alphabetic word (nothing alphanumeric before them): "" when there are none, null when a digit or a longer word is attached. */
function wordBefore(upper: string, at: number): string | null {
  let start = at;
  while (start > 0 && isLetter(upper.charCodeAt(start - 1))) start--;
  if (start > 0 && isDigit(upper.charCodeAt(start - 1))) return null;
  return upper.slice(start, at);
}

interface Token { volts: number; end: number; /** The token includes the V in front of the number (V3P3). */ prefixV: boolean }

/** A voltage token whose number starts at `start`, or null. Shapes: 5V, 3.3V, 3V3, 1V05, 3P3V, V3P3 (no sign handling here). */
function voltageAt(upper: string, start: number): Token | null {
  const length = upper.length;
  let integerEnd = start;
  while (integerEnd < length && isDigit(upper.charCodeAt(integerEnd))) integerEnd++;
  let position = integerEnd, decimal = '';
  if (codeAt(upper, integerEnd) === 46 && isDigit(codeAt(upper, integerEnd + 1))) {
    position = integerEnd + 1;
    while (position < length && isDigit(upper.charCodeAt(position))) position++;
    decimal = upper.slice(integerEnd + 1, position);
  }
  const integer = upper.slice(start, integerEnd);
  const marker = codeAt(upper, position);
  if (marker === 86) { // V
    let stop = position + 1;
    while (stop < length && isDigit(upper.charCodeAt(stop))) stop++;
    const after = upper.slice(position + 1, stop);
    if (after !== '' && decimal !== '') return null;
    const volts = Number(`${integer}.${after || decimal || '0'}`);
    return { volts, end: stop, prefixV: false };
  }
  if (marker === 80 && decimal === '' && isDigit(codeAt(upper, position + 1))) { // P as the decimal point: 3P3V, V3P3
    let stop = position + 1;
    while (stop < length && isDigit(upper.charCodeAt(stop))) stop++;
    const fraction = upper.slice(position + 1, stop);
    const volts = Number(`${integer}.${fraction}`);
    if (codeAt(upper, stop) === 86) return { volts, end: stop + 1, prefixV: false };
    if (codeAt(upper, start - 1) === 86) return { volts, end: stop, prefixV: true };
  }
  return null;
}

/** Whether a voltage token spanning [from, end) stands alone in the name: allowed left neighbours and right neighbours only. */
function boundaryOk(upper: string, from: number, end: number): boolean {
  const before = codeAt(upper, from - 1);
  if (before >= 0 && isAlnum(before)) {
    const word = isLetter(before) ? wordBefore(upper, from) : null;
    if (word === null || !RAIL_PREFIXES.has(word)) return false;
  }
  const after = codeAt(upper, end);
  if (after < 0 || !isAlnum(after)) return true;
  if (!isLetter(after)) return false;
  let stop = end;
  while (stop < upper.length && isLetter(upper.charCodeAt(stop))) stop++;
  if (stop - end > MAX_SUFFIX || SIGNAL_SUFFIXES.has(upper.slice(end, stop))) return false;
  return !isDigit(codeAt(upper, stop));
}

/**
 * The voltage a rail name suggests, or null. "PP3V3_S5" 3.3, "+5V" 5, "-12V" -12, "VCC_1V8" 1.8, "1V05" 1.05, "3P3V" 3.3,
 * "5VSB" 5. Null for names without a voltage, with two different voltages, ending in a signal word ("5V_EN"), or with a
 * voltage outside 0.3 V to 100 V. Only a hint taken from the text.
 */
export function expectedVoltageFromName(name: string): ExpectedVoltageHint | null {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME) return null;
  const upper = name.toUpperCase();
  let found: number | null = null;
  let index = 0;
  while (index < upper.length) {
    if (!isDigit(upper.charCodeAt(index)) || (index > 0 && isDigit(upper.charCodeAt(index - 1)))) { index++; continue; }
    const token = voltageAt(upper, index);
    if (!token) { index++; continue; }
    const from = token.prefixV ? index - 1 : index;
    let volts = token.volts;
    if (boundaryOk(upper, from, token.end) && Number.isFinite(volts)) {
      const sign = codeAt(upper, from - 1);
      if (sign === 45 && (from - 1 === 0 || !isAlnum(upper.charCodeAt(from - 2)))) volts = -volts;
      if (Math.abs(volts) >= MIN_VOLTS && Math.abs(volts) <= MAX_VOLTS) {
        if (found !== null && found !== volts) return null;
        found = volts;
      }
    }
    index = Math.max(token.end, index + 1);
  }
  if (found === null || hasSignalWord(tokensOf(upper))) return null;
  return { volts: found, source: 'net-name' };
}

function isPowerWordName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME) return false;
  const tokens = tokensOf(name.toUpperCase());
  return !hasSignalWord(tokens) && tokens.some(isPowerToken);
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

const NO_CONNECT: NetClass = Object.freeze({ kind: 'no-connect' });
const SIGNAL: NetClass = Object.freeze({ kind: 'signal' });
const GROUND_BY_NAME: NetClass = Object.freeze({ kind: 'ground', groundBasis: 'name' });
const GROUND_BY_SIZE: NetClass = Object.freeze({ kind: 'ground', groundBasis: 'largest-net' });
const POWER: NetClass = Object.freeze({ kind: 'power' });

function classifyWith(name: string, matches: NameMatcher): NetClass {
  if (isNoConnectName(name)) return NO_CONNECT;
  if (matches(name)) return GROUND_BY_NAME;
  const hint = expectedVoltageFromName(name);
  if (hint) return Object.freeze({ kind: 'power', expectedVoltage: Object.freeze(hint) });
  return isPowerWordName(name) ? POWER : SIGNAL;
}

/** Class of one net name without the pin-count fallback (no-connect, then ground, then power, else signal). */
export function classifyNetName(name: string, options: NetClassOptions = {}): NetClass {
  return classifyWith(name, matcherFor(options.groundPatterns));
}

export interface NetPinCount { readonly name: string; readonly pinCount: number }

export interface NetClassification {
  /** The class of every net, keyed by net name. */
  readonly byName: ReadonlyMap<string, NetClass>;
  /** Names of the ground nets, in the order given. */
  readonly groundNets: readonly string[];
  /** How ground was found: by name, by the largest-net fallback, or not at all. */
  readonly groundBasis: GroundBasis | 'none';
  /** Class of any net name, also one that is not in the list (a pin without a net is the empty name: no-connect). Names outside the list never use the fallback. */
  classOf(name: string): NetClass;
}

/** Classifies a list of nets; `totalPins` is the pin count of the whole board, the denominator of the fallback share. */
export function classifyNets(nets: Iterable<NetPinCount>, totalPins: number, options: NetClassOptions = {}): NetClassification {
  const matches = matcherFor(options.groundPatterns);
  const byName = new Map<string, NetClass>();
  const groundNets: string[] = [];
  let largest: NetPinCount | null = null, tied = false;
  for (const net of nets) {
    const kind = classifyWith(net.name, matches);
    byName.set(net.name, kind);
    if (kind.kind === 'ground') groundNets.push(net.name);
    else if (kind.kind === 'signal') {
      if (!largest || net.pinCount > largest.pinCount) { largest = net; tied = false; }
      else if (net.pinCount === largest.pinCount) tied = true;
    }
  }
  let groundBasis: NetClassification['groundBasis'] = groundNets.length ? 'name' : 'none';
  const share = options.fallbackShare ?? GROUND_FALLBACK_SHARE;
  if (!groundNets.length && largest && !tied && totalPins > 0 && largest.pinCount / totalPins > share) {
    byName.set(largest.name, GROUND_BY_SIZE);
    groundNets.push(largest.name);
    groundBasis = 'largest-net';
  }
  return { byName, groundNets, groundBasis, classOf: name => byName.get(name) ?? classifyWith(name, matches) };
}

/** `classifyNets` for a board: each net's pin count is its `pinIds.length`, the share is taken of `board.pins.length`. */
export function classifyBoardNets(board: Pick<Board, 'nets' | 'pins'>, options: NetClassOptions = {}): NetClassification {
  return classifyNets(board.nets.map(net => ({ name: net.name, pinCount: net.pinIds.length })), board.pins.length, options);
}
