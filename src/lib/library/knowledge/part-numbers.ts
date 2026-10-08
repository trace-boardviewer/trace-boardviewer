/**
 * Part-number normalisation: from the text a board, a BOM or a schematic carries to the keys the Library searches by.
 *
 * `normalizePartNumber("U7100_ISL95857HRTZ-T")` gives
 *   exact   "ISL95857HRTZ-T"   the cleaned text (display keeps the original)
 *   base    "ISL95857"         exact minus package, reel, temperature and lead-free suffixes, only by a family rule
 *   family  "renesas-isl9585x" the family row of the CC0 table (`part-families.ts`)
 *   category "vrm-controller"  the repair function category of the family
 *
 * Steps, in order:
 *  1. Clean: letters to upper case, full-width and dash look-alikes to ASCII, outer punctuation and blanks off.
 *  2. Drop what is not part of the number: a leading own reference designator that a boardview value carries ("U7100_",
 *     only when the prefix is a known designator), a BOM class prefix ("IC-", "IC_"), and a maker prefix ("TI-", "ST_", "ON-")
 *     when the rest resolves to a family. One blank inside the text is closed ("TPS 51225"); two or more blanks make it a
 *     description, not a part number, and the result is null.
 *  3. Family: the longest family stem the text starts with, followed by the family's digits and then a suffix that starts with
 *     a letter or one of "-/#+._:". A suffix that starts with a digit means the number is longer than the family's: no family.
 *  4. Base: stem + core digits of the family. Families that carry density or organisation text have no base.
 *  Unknown families keep only the exact form (precision first); nothing is merged silently.
 *
 * Tiers (best first): exact, base, prefix (a query feature: at least five characters of the candidate's exact form), family.
 * `matchTier` tells which one two keys share.
 *
 * Linear time: every step scans at most `MAX_INPUT` units once; the family step looks at the few families whose stem shares
 * the first two characters of the text.
 */
import { foldCode, scanLength, tick, type WorkMeter } from './chars';
import { PART_FAMILIES, type PartCategory, type PartFamily } from './part-families';
import { classifyPart } from '../../part-kind';
import { parsePartValue } from '../../part-value';

/** The longest text read; longer input is a description or junk. */
export const MAX_INPUT = 160;
const MAX_EXACT = 48;
const MIN_EXACT = 3;
const MAX_TAIL = 24;
export const MIN_PREFIX_QUERY = 5;

export type PartMarker = 'lead-free' | 'reel' | 'automotive' | 'industrial' | 'extended-temperature';

export interface PartNumberKeys {
  /** The text as given, cut to 64 characters. */
  original: string;
  /** Cleaned text: the key of the exact tier. */
  exact: string;
  /** Family base (stem and core digits); absent when the family is unknown or carries no base. */
  base?: string;
  /** Family id from the table. */
  family?: string;
  category?: PartCategory;
  maker?: string;
  /** What follows the core in the exact form (package, reel, temperature, lead-free text). */
  suffix?: string;
  markers: PartMarker[];
  /** What was dropped from the front of the text. */
  stripped: { refdes?: string; bomClass?: string; maker?: string };
}

export interface PartNumberOptions { meter?: WorkMeter }

// --------------------------------------------------------------------------------------------------------------------
// Tables
// --------------------------------------------------------------------------------------------------------------------

/** BOM class prefixes (the part class written in front of the number). */
const BOM_CLASS_PREFIXES: readonly string[] = ['IC-', 'IC_', 'IC:', 'IC '];
/** Maker names and abbreviations that may stand in front of a part number. Taken off only when the rest is a known family. */
const MAKER_PREFIXES: ReadonlySet<string> = new Set([
  'TI', 'TEXAS', 'ST', 'NXP', 'ONSEMI', 'ON', 'ADI', 'ANALOG', 'MAXIM', 'LT', 'LINEAR', 'MICROCHIP', 'MCHP', 'INFINEON', 'IR', 'RENESAS', 'INTERSIL',
  'REALTEK', 'RICHTEK', 'MPS', 'WINBOND', 'MACRONIX', 'MICRON', 'SAMSUNG', 'HYNIX', 'ITE', 'NUVOTON', 'ENE', 'VISHAY', 'DIODES', 'AOS', 'FAIRCHILD',
  'ROHM', 'TOSHIBA', 'NEXPERIA', 'CIRRUS', 'CONEXANT', 'PARADE', 'ANALOGIX', 'CHRONTEL', 'LONTIUM', 'QUALCOMM', 'MEDIATEK', 'BROADCOM', 'CYPRESS', 'SILERGY',
  'GIGADEVICE', 'ISSI', 'NANYA', 'SK', 'PERICOM', 'ATMEL',
]);

const INDEX: Map<string, PartFamily[]> = (() => {
  const map = new Map<string, PartFamily[]>();
  for (const family of PART_FAMILIES) {
    const key = family.stem.slice(0, 2);
    const bucket = map.get(key);
    if (bucket) bucket.push(family); else map.set(key, [family]);
  }
  return map;
})();

// --------------------------------------------------------------------------------------------------------------------
// Cleaning
// --------------------------------------------------------------------------------------------------------------------

const isDigit = (code: number): boolean => code >= 48 && code <= 57;
const isLetter = (code: number): boolean => code >= 65 && code <= 90;

/** Characters that may stand in a part number after folding. */
function isNumberChar(code: number): boolean {
  return isDigit(code) || isLetter(code) || code === 45 || code === 47 || code === 35 || code === 43 || code === 46 || code === 95 || code === 58;
}
/** Punctuation that wraps a part number in running text and is cut off at both ends. */
function isWrapper(code: number): boolean {
  return code === 32 || code === 34 || code === 39 || code === 40 || code === 41 || code === 91 || code === 93 || code === 123 || code === 125 || code === 60 || code === 62 || code === 44 || code === 59 || code === 42 || code === 126 || code === 33 || code === 63 || code === 124 || code === 96 || code === 0x2018 || code === 0x2019 || code === 0x201c || code === 0x201d || code === 0xab || code === 0xbb || code === 0x2122 || code === 0xae;
}

/** Folds up to MAX_INPUT units and cuts the wrapper punctuation at both ends. */
function foldTrim(text: string, meter: WorkMeter | undefined): string {
  const length = Math.min(scanLength(text), MAX_INPUT + 1);
  let start = 0, end = length;
  while (start < end && isWrapper(foldCode(text.charCodeAt(start)))) start++;
  while (end > start && isWrapper(foldCode(text.charCodeAt(end - 1)))) end--;
  tick(meter, length);
  let out = '';
  for (let index = start; index < end; index++) out += String.fromCharCode(foldCode(text.charCodeAt(index)));
  return out;
}

/** Splits at the first blank or underscore within the first `limit` characters: [head, separator, rest] or null. */
function splitHead(text: string, limit: number): [string, string, string] | null {
  const cap = Math.min(text.length, limit + 1);
  for (let index = 1; index < cap; index++) {
    const code = text.charCodeAt(index);
    if (code === 32 || code === 95) return [text.slice(0, index), text[index], text.slice(index + 1)];
  }
  return null;
}

interface Cleaned { exact: string; stripped: PartNumberKeys['stripped'] }

function hasLetterAndDigit(text: string): boolean {
  let letter = false, digit = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (isDigit(code)) digit = true; else if (isLetter(code)) letter = true;
    if (letter && digit) return true;
  }
  return false;
}

/** The cleaned form of a text that may hold a part number, or null. Own reference designators and BOM class prefixes are dropped. */
function clean(folded: string): Cleaned | null {
  const stripped: PartNumberKeys['stripped'] = {};
  let text = folded.replace(/^[\s\-_.:/#+]+/, '');
  // A BOM class prefix.
  for (const prefix of BOM_CLASS_PREFIXES) {
    if (text.length > prefix.length + 3 && text.startsWith(prefix) && hasLetterAndDigit(text.slice(prefix.length))) {
      stripped.bomClass = prefix.slice(0, -1);
      text = text.slice(prefix.length).replace(/^[\s\-_:]+/, '');
      break;
    }
  }
  // An own reference designator in front ("U7100_ISL95857", "U7100 ISL95857"): only a designator with a known letter prefix.
  const head = splitHead(text, 8);
  if (head) {
    const [first, , rest] = head;
    if (/^[A-Z]{1,3}[0-9]{1,5}$/.test(first) && rest.length >= 4 && hasLetterAndDigit(rest) && classifyPart({ ref: first }).confidence !== 'low') {
      stripped.refdes = first;
      text = rest.replace(/^[\s\-_:]+/, '');
    }
  }
  // At most one blank inside the number.
  let blanks = 0, joined = '';
  let inBlank = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 32) {
      if (!inBlank) { blanks++; inBlank = true; }
      continue;
    }
    inBlank = false;
    if (!isNumberChar(code)) return null;
    joined += text[index];
  }
  if (blanks > 1) return null;
  // Two fields where one is a component value ("100NF 16V", "10K 1%") are a description, not a part number.
  if (blanks === 1) {
    for (const field of text.trim().split(/\s+/)) {
      const value = parsePartValue(field);
      if (value.quantity !== null && !(value.unitless === true && /^[0-9.,]+$/.test(field))) return null;
    }
  }
  // Leading and trailing separators that belong to no part number.
  let from = 0, to = joined.length;
  while (from < to && /[-_.:/#+]/.test(joined[from])) from++;
  while (to > from && /[-_.:/#]/.test(joined[to - 1])) to--;
  const exact = joined.slice(from, to);
  if (exact.length < MIN_EXACT || exact.length > MAX_EXACT || !hasLetterAndDigit(exact)) return null;
  return { exact, stripped };
}

// --------------------------------------------------------------------------------------------------------------------
// Families
// --------------------------------------------------------------------------------------------------------------------

interface Resolved { family: PartFamily; core?: string; tail: string }

function validTail(tail: string): boolean {
  if (tail.length > MAX_TAIL) return false;
  for (let index = 0; index < tail.length; index++) if (!isNumberChar(tail.charCodeAt(index))) return false;
  return true;
}

/** The family a cleaned part number belongs to, or undefined. */
function resolveFamily(exact: string): Resolved | undefined {
  const bucket = INDEX.get(exact.slice(0, 2));
  if (!bucket) return undefined;
  for (const family of bucket) {
    if (!exact.startsWith(family.stem)) continue;
    const rest = exact.slice(family.stem.length);
    if (family.prefixOnly) {
      if (validTail(rest)) return { family, tail: rest };
      continue;
    }
    let digits = 0;
    while (digits < rest.length && isDigit(rest.charCodeAt(digits))) digits++;
    if (digits < family.minDigits || digits > family.maxDigits) continue;
    const tail = rest.slice(digits);
    if (tail !== '' && !(isLetter(tail.charCodeAt(0)) || '-/#+._:'.includes(tail[0]))) continue;
    if (!validTail(tail)) continue;
    return { family, core: family.stem + rest.slice(0, digits), tail };
  }
  return undefined;
}

function markersOf(tail: string, maker: string): PartMarker[] {
  const out: PartMarker[] = [];
  if (tail === '') return out;
  if (tail.includes('/NOPB') || tail.includes('PBF') || tail.includes('-LF') || tail.includes('-HF') || tail.includes('+') || tail.includes('-GE3') || tail.includes('-E3')) out.push('lead-free');
  const reel = tail.includes('#TR') || tail.includes('/TR') || tail.includes('-TR') || tail.includes('-REEL') || /-T[0-9]{1,2}(?:-|$)/.test(tail) || /-(?:7|13)(?:-|$)/.test(tail) || /\+T[0-9]*$/.test(tail)
    || (maker === 'Texas Instruments' && /^[A-Z]{2,5}[RT]$/.test(tail));
  if (reel) out.push('reel');
  if (/(?:^|-)Q1(?:-|$)/.test(tail)) out.push('automotive');
  if (tail.includes('-I/')) out.push('industrial');
  if (tail.includes('-E/')) out.push('extended-temperature');
  return out;
}

function build(original: string, cleaned: Cleaned, options: { maker?: string } = {}): PartNumberKeys {
  const stripped = options.maker !== undefined ? { ...cleaned.stripped, maker: options.maker } : cleaned.stripped;
  const resolved = resolveFamily(cleaned.exact);
  if (!resolved) return { original, exact: cleaned.exact, markers: [], stripped };
  const { family, core, tail } = resolved;
  return {
    original,
    exact: cleaned.exact,
    ...(core !== undefined ? { base: core } : {}),
    family: family.id,
    category: family.category,
    maker: family.maker,
    ...(tail !== '' ? { suffix: tail } : {}),
    markers: markersOf(tail, family.maker),
    stripped,
  };
}

/**
 * The keys of a part number. Returns null when the text cannot be a part number (empty, over-long, a description with several
 * blanks, characters that no part number carries, no letter or no digit). Total: any input gives a result or null.
 */
export function normalizePartNumber(text: string, options: PartNumberOptions = {}): PartNumberKeys | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const original = text.length > 64 ? text.slice(0, 64) : text;
  const folded = foldTrim(text, options.meter);
  if (folded.length === 0 || folded.length > MAX_INPUT) return null;
  let keys = normalizeOnce(original, folded);
  // Prefixes can be stacked or hidden behind separators ("IC-U1_LM358", ".IC-LM358"): read the exact form again until nothing more
  // comes off, so that normalising an exact form gives the same keys. Every round shortens the text, so the loop is short.
  for (let round = 0; keys !== null && round < 8; round++) {
    const next = normalizeOnce(original, keys.exact);
    if (next === null || next.exact === keys.exact) {
      if (next !== null && next.exact === keys.exact && keys.family === undefined && next.family !== undefined) keys = { ...next, stripped: keys.stripped };
      break;
    }
    keys = { ...next, stripped: { ...keys.stripped, ...next.stripped } };
  }
  return keys;
}

function normalizeOnce(original: string, folded: string): PartNumberKeys | null {
  // A maker prefix, only when the rest resolves to a family.
  const maker = splitMaker(folded);
  if (maker) {
    const cleaned = clean(maker.rest);
    if (cleaned) {
      const keys = build(original, cleaned, { maker: maker.head });
      if (keys.family !== undefined) return keys;
    }
  }
  const cleaned = clean(folded);
  if (!cleaned) return null;
  const keys = build(original, cleaned);
  // A text that reads as a component value ("100NF", "4K7") and belongs to no family is not a part number.
  if (keys.family === undefined && parsePartValue(keys.exact).quantity !== null) return null;
  return keys;
}

/** "TI-TPS51225", "ST_STM32F103", "ON TPS...": the maker word and the rest. */
function splitMaker(text: string): { head: string; rest: string } | null {
  const cap = Math.min(text.length, 12);
  for (let index = 1; index < cap; index++) {
    const code = text.charCodeAt(index);
    if (code === 45 || code === 95 || code === 32 || code === 58) {
      const head = text.slice(0, index);
      return MAKER_PREFIXES.has(head) && text.length - index - 1 >= 4 ? { head, rest: text.slice(index + 1) } : null;
    }
    if (!isLetter(code) && !isDigit(code)) return null;
  }
  return null;
}

export type MatchTier = 'exact' | 'base' | 'prefix' | 'family';

/** Ranking of the tiers: higher is better. */
export const TIER_RANK: Readonly<Record<MatchTier, number>> = { exact: 4, base: 3, prefix: 2, family: 1 };

/**
 * The best tier two keys share: exact when the cleaned forms are equal, base when both have the same base, prefix when the
 * query is at least five characters and starts the candidate, family when both belong to the same family. Null for no match.
 * The tiers are always reported; nothing is merged without saying so.
 */
export function matchTier(query: PartNumberKeys, candidate: PartNumberKeys): MatchTier | null {
  if (query.exact === candidate.exact) return 'exact';
  if (query.base !== undefined && query.base === candidate.base) return 'base';
  if (query.exact.length >= MIN_PREFIX_QUERY && candidate.exact.startsWith(query.exact)) return 'prefix';
  if (query.family !== undefined && query.family === candidate.family) return 'family';
  return null;
}

/** The family row a keys object belongs to. */
export function familyOf(keys: Pick<PartNumberKeys, 'family'>): PartFamily | undefined {
  return keys.family === undefined ? undefined : PART_FAMILIES.find(family => family.id === keys.family);
}
