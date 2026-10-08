/**
 * Measurement text -> typed value, for the entry field, CSV cells, OpenBoardData fields and the values of old pin notes.
 *
 *   diode, voltage   "0.412"  "0,412"  "412m"  "412 mV"  "3V3"  "1V05"  "-12V"  "OL"
 *   resistance       "10"  "4k7"  "4.7k"  "4,7 kΩ"  "2M2"  "4R7"  "0R05"  "R005"  "10E"  "120 ohm"  "1.5mΩ"  "OL"
 *   continuity       "beep"  "yes"  "1"  "short"  -> connected;  "no"  "0"  "open"  "OL"  -> not connected
 *
 * The number is composed from its decimal text and the prefix exponent in ONE conversion ("412m" is Number("412e-3")), so 0.412 typed
 * in any form is the same double. Prefixes: p n u (µ μ) m k K M G meg; for V the letter M means milli (no one measures megavolts;
 * "412MV" is caps lock), for ohm it means mega. A unit that does not fit the kind ("3V3" as a resistance) is refused, never converted.
 * Between digits "e" is scientific notation ("1e3" is 1000); at the end "E" is the ohm sign ("10E" is 10 ohm).
 *
 * One assumption exists and it is reported, never silent: a bare whole diode number above 4 (and up to 4000) has no unit and is more
 * than any diode-mode reading in volts, so it is read as millivolts (`assumedMillivolts: true`); `bareDiodeMillivolts: false` refuses it.
 * Text is at most 64 characters; every pattern is anchored and linear.
 */
import { READINGS_LIMITS, UNIT_OF } from './schema';
import type { NumericKind, ReadingKind, ReadingUnit } from './schema';

export type ParsedValue =
  | { ok: true; value: number; unit: ReadingUnit; assumedMillivolts?: true }
  | { ok: true; ol: true }
  | { ok: true; connected: boolean }
  | { ok: false; reason: 'empty' | 'unrecognized' | 'unit-mismatch' | 'out-of-range' };

export interface ParseValueOptions {
  /** Read a bare diode number above 4 as millivolts (reported as `assumedMillivolts`). Default true. */
  bareDiodeMillivolts?: boolean;
}

/** Largest diode-mode value in volts (meters show OL above about 2 to 3 V). */
export const MAX_DIODE_VOLTS = 10;
const MAX_TEXT = 64;
const OL_WORDS: ReadonlySet<string> = new Set(['ol', 'o.l', 'o.l.', '0l', 'open', 'over', 'overload', 'inf', 'infinity', '∞', '-ol', 'ol.']);
const CONNECTED_WORDS: ReadonlySet<string> = new Set(['beep', 'yes', 'y', 'closed', 'connected', 'short', 'true', '1', 'on']);
const OPEN_WORDS: ReadonlySet<string> = new Set(['no', 'n', 'open', 'ol', 'o.l', 'o.l.', 'false', '0', 'none', 'off']);

const NUMBER = /^([+-])?(\d{1,15})?(?:[.,](\d{1,15}))?(?:[eE]([+-]?\d{1,3}))?\s?([A-Za-zµμΩΩ]{0,6})$/;
const INFIX = /^(\d{1,15})([kKMGRrVv])(\d{1,15})\s?(Ω|Ω|ohms?|Ohms?|OHMS?|V|v)?$/;
// "R005": a resistance below one ohm written with the R in front.
const LEADING_R = /^[Rr](\d{1,15})$/;

interface Suffix { exponent: number; unit: ReadingUnit | null }

/** Prefix and unit after a number, for a kind; null when the letters are not a prefix and unit that fit. */
function readSuffix(text: string, kind: NumericKind): Suffix | null | 'mismatch' {
  if (text === '') return { exponent: 0, unit: null };
  let prefix = '';
  let unitText = text;
  const lower = text.toLowerCase();
  const isOhm = (value: string): boolean => value === 'Ω' || value === 'Ω' || /^(ohms?|r|e)$/i.test(value);
  const isVolt = (value: string): boolean => value === 'V' || value === 'v';
  if (isOhm(text) || isVolt(text)) unitText = text;
  else if (lower.startsWith('meg') && (text.length === 3 || isOhm(text.slice(3)))) { prefix = 'meg'; unitText = text.slice(3); }
  else if ('pnuµμmkKMG'.includes(text[0])) { prefix = text[0]; unitText = text.slice(1); }
  else return null;
  let unit: ReadingUnit | null;
  if (unitText === '') unit = null;
  else if (isOhm(unitText)) unit = 'ohm';
  else if (isVolt(unitText)) unit = 'V';
  else return null;
  const wanted = UNIT_OF[kind];
  if (unit !== null && unit !== wanted) return 'mismatch';
  const volts = wanted === 'V';
  let exponent: number;
  switch (prefix) {
    case '': exponent = 0; break;
    case 'p': exponent = -12; break;
    case 'n': exponent = -9; break;
    case 'u': case 'µ': case 'μ': exponent = -6; break;
    case 'm': exponent = -3; break;
    case 'M': exponent = volts ? -3 : 6; break;
    case 'k': case 'K': exponent = 3; break;
    case 'G': exponent = 9; break;
    case 'meg': if (volts) return null; exponent = 6; break;
    default: return null;
  }
  return { exponent, unit };
}

function inRange(kind: NumericKind, value: number): boolean {
  if (!Number.isFinite(value) || Math.abs(value) > READINGS_LIMITS.value) return false;
  if (kind === 'diode') return value >= 0 && value <= MAX_DIODE_VOLTS;
  if (kind === 'resistance') return value >= 0;
  return true;
}

export function parseReadingValue(text: string, kind: ReadingKind, options: ParseValueOptions = {}): ParsedValue {
  if (typeof text !== 'string') return { ok: false, reason: 'empty' };
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_TEXT) return { ok: false, reason: 'unrecognized' };
  const word = trimmed.toLowerCase();
  if (kind === 'continuity') {
    if (CONNECTED_WORDS.has(word)) return { ok: true, connected: true };
    if (OPEN_WORDS.has(word) || OL_WORDS.has(word)) return { ok: true, connected: false };
    return { ok: false, reason: 'unrecognized' };
  }
  if (OL_WORDS.has(word)) return { ok: true, ol: true };
  const wanted = UNIT_OF[kind];
  const leading = LEADING_R.exec(trimmed);
  if (leading) return wanted === 'ohm' ? { ok: true, value: Number(`0.${leading[1]}`), unit: wanted } : { ok: false, reason: 'unit-mismatch' };
  const infix = INFIX.exec(trimmed);
  if (infix) {
    // 4k7, 2M2, 4R7, 0R05 (resistance); 3V3, 1V05 (voltage, diode). The letter stands where the decimal point would be.
    const [, whole, letter, fraction, unitText] = infix;
    const upper = letter.toUpperCase();
    const letterUnit: ReadingUnit = upper === 'V' ? 'V' : 'ohm';
    const unit: ReadingUnit | null = unitText === undefined ? null : unitText === 'V' || unitText === 'v' ? 'V' : 'ohm';
    if (letterUnit !== wanted || (unit !== null && unit !== wanted)) return { ok: false, reason: 'unit-mismatch' };
    const exponent = upper === 'K' ? 3 : upper === 'M' ? 6 : upper === 'G' ? 9 : 0;
    const value = Number(`${whole}.${fraction}e${exponent}`);
    return inRange(kind, value) ? { ok: true, value, unit: wanted } : { ok: false, reason: 'out-of-range' };
  }
  const match = NUMBER.exec(trimmed);
  if (!match) return { ok: false, reason: 'unrecognized' };
  const [, sign, whole, fraction, exponentText, suffixText] = match;
  if (whole === undefined && fraction === undefined) return { ok: false, reason: 'unrecognized' };
  const suffix = readSuffix(suffixText, kind);
  if (suffix === 'mismatch') return { ok: false, reason: 'unit-mismatch' };
  if (suffix === null) return { ok: false, reason: 'unrecognized' };
  const exponent = suffix.exponent + (exponentText === undefined ? 0 : Number(exponentText));
  let value = Number(`${sign === '-' ? '-' : ''}${whole ?? '0'}.${fraction ?? '0'}e${exponent}`) + 0;
  let assumed = false;
  if (kind === 'diode' && suffixText === '' && exponentText === undefined && fraction === undefined && value > 4 && value <= 4000) {
    if (options.bareDiodeMillivolts === false) return { ok: false, reason: 'out-of-range' };
    value = Number(`${whole ?? '0'}.${fraction ?? '0'}e-3`);
    assumed = true;
  }
  if (!inRange(kind, value)) return { ok: false, reason: 'out-of-range' };
  return assumed ? { ok: true, value, unit: wanted, assumedMillivolts: true } : { ok: true, value, unit: wanted };
}

const PREFIXES: ReadonlyArray<readonly [number, string]> = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ']];

/** Display text of a reading's value: "0.412 V", "4.7 kΩ", "OL", "beep" / "open". Three significant digits, SI prefixes. */
export function formatReadingValue(reading: { kind: ReadingKind; value?: number; ol?: true; connected?: boolean }): string {
  if (reading.kind === 'continuity') return reading.connected ? 'beep' : 'open';
  if (reading.ol || reading.value === undefined) return 'OL';
  const value = reading.value;
  const symbol = UNIT_OF[reading.kind] === 'V' ? 'V' : 'Ω';
  if (reading.kind === 'diode') return `${value.toFixed(3)} V`;
  if (value === 0) return `0 ${symbol}`;
  const magnitude = Math.abs(value);
  const [scale, prefix] = PREFIXES.find(([factor]) => magnitude >= factor) ?? PREFIXES[PREFIXES.length - 1];
  const scaled = value / scale;
  return `${Number(scaled.toPrecision(3))} ${prefix}${symbol}`;
}
