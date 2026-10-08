/*
 * Column vocabulary of the pin-list importer (pinlist-csv.ts): which header means which column, how a number or a side is
 * written, and what unit a set of coordinates is probably in. Original TRACE module (MIT). The header words are the ones
 * that CAD reports, assembly exports and test-fixture exports commonly use (reference designator, pin, net, X, Y, side,
 * layer); nothing is copied from any tool's source.
 *
 * Everything here is a pure function of short strings; header matching is a table lookup and number parsing is two anchored
 * patterns, so no input can make it slow.
 */
import type { BoardSide } from '../types';

export type PinListRole = 'refdes' | 'pin' | 'net' | 'x' | 'y' | 'side' | 'value' | 'package';
export const PINLIST_ROLES: readonly PinListRole[] = ['refdes', 'pin', 'net', 'x', 'y', 'side', 'value', 'package'];
/** A pin list cannot become a board without these. */
export const PINLIST_REQUIRED: readonly PinListRole[] = ['refdes', 'pin', 'x', 'y'];
export type PinListUnit = 'mm' | 'mil' | 'inch' | 'um';
/** Millimetres per unit. */
export const PINLIST_UNIT_MM: Readonly<Record<PinListUnit, number>> = { mm: 1, mil: 0.0254, inch: 25.4, um: 0.001 };

const fold = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Header or value reduced to letters, digits and CJK characters: "Ref. Des." and "ref_des" are the same word. */
export const wordKey = (text: string): string => fold(text).replace(/[^a-z0-9\u3400-\u9fff]/g, '');

const UNIT_WORDS: Readonly<Record<string, PinListUnit>> = {
  mm: 'mm', millimeter: 'mm', millimeters: 'mm', millimetre: 'mm', millimetres: 'mm',
  mil: 'mil', mils: 'mil', thou: 'mil', thousandth: 'mil', in: 'inch', inch: 'inch', inches: 'inch', '"': 'inch',
  um: 'um', 'µm': 'um', 'μm': 'um', micron: 'um', microns: 'um', micrometer: 'um', micrometre: 'um',
};
/** The unit named by a word such as "mm", "mils" or "inch" (null for anything else). */
export function unitOfWord(word: string): PinListUnit | undefined { return UNIT_WORDS[word.trim().toLowerCase()]; }

// "(mm)", "[mil]", "{in}" or a last word "mm" / "_mil" in a coordinate header.
const UNIT_IN_HEADER = /[([{<]\s*([a-zµμ"]{1,12})\s*[)\]}>]|(?:^|[\s_\-/])(mm|mils?|thou|inch|inches|in|um|µm|μm)\s*$/i;

interface Alias { role: PinListRole; weight: number }
const ALIASES = new Map<string, Alias>();
function alias(role: PinListRole, weight: number, words: string[]): void { for (const word of words) if (!ALIASES.has(word)) ALIASES.set(word, { role, weight }); }
alias('refdes', 1, ['refdes', 'ref', 'refdesignator', 'refdesig', 'referencedesignator', 'reference', 'designator', 'component', 'componentname', 'componentref', 'componentdesignator', 'comp', 'compname', 'compref', 'partref', 'partreference', 'partdesignator', 'refdez',
  'bauteil', 'bezugskennzeichen', 'alkatresz', 'repere', 'referencia', '位号', '元件位号', '元件', '器件', '位号名']);
alias('refdes', 0.6, ['part', 'partname', 'device']);
alias('pin', 1, ['pin', 'pinnumber', 'pinno', 'pinnum', 'pinnr', 'pinid', 'pinref', 'pad', 'padnumber', 'padno', 'padnum', 'padname', 'padid', 'terminal', 'terminalnumber', 'lab', 'broche', 'anschluss', '管脚', '引脚', '脚位', '管脚号', '引脚号']);
alias('pin', 0.7, ['pinname', 'term']);
alias('net', 1, ['net', 'netname', 'netlabel', 'netid', 'nets', 'signal', 'signalname', 'signalnet', 'connection', 'netz', 'netzname', 'halozat', 'reseau', '网络', '网络名', '网络名称', '信号', '信号名']);
alias('x', 1, ['x', 'xpos', 'xposition', 'xcoord', 'xcoordinate', 'xloc', 'xlocation', 'posx', 'positionx', 'coordx', 'locx', 'centerx', 'centrex', 'xcenter', 'xcentre', 'midx', 'xmid', 'padx', 'pinx', 'refx', 'x坐标', 'x座标']);
alias('y', 1, ['y', 'ypos', 'yposition', 'ycoord', 'ycoordinate', 'yloc', 'ylocation', 'posy', 'positiony', 'coordy', 'locy', 'centery', 'centrey', 'ycenter', 'ycentre', 'midy', 'ymid', 'pady', 'piny', 'refy', 'y坐标', 'y座标']);
alias('side', 1, ['side', 'boardside', 'pcbside', 'mountside', 'placementside', 'componentside', 'topbottom', 'tb', 'seite', 'oldal', 'cote', 'lado', '面', '层别', '板面']);
alias('side', 0.8, ['layer', 'mount', 'face', 'placement', 'layers', '层', 'lage']);
alias('value', 1, ['value', 'val', 'partvalue', 'componentvalue', 'comment', 'wert', 'ertek']);
alias('package', 1, ['package', 'footprint', 'pattern', 'pkg', 'packagename', 'footprintname', 'gehause', '封装']);

export interface HeaderMatch { role: PinListRole; weight: number; unit?: PinListUnit }
/** The role a header cell names, with a unit when the header carries one ("X (mm)", "Y [mil]", "X_in"); undefined for anything else. */
export function headerRole(cell: string): HeaderMatch | undefined {
  if (!cell || cell.length > 64) return undefined;
  const direct = ALIASES.get(wordKey(cell));
  let unit: PinListUnit | undefined;
  const hint = UNIT_IN_HEADER.exec(cell);
  if (hint) unit = unitOfWord(hint[1] ?? hint[2]);
  if (direct) return { ...direct, ...(unit && (direct.role === 'x' || direct.role === 'y') ? { unit } : {}) };
  if (hint && unit) {
    const stripped = ALIASES.get(wordKey(cell.slice(0, hint.index)));
    if (stripped && (stripped.role === 'x' || stripped.role === 'y')) return { ...stripped, unit };
  }
  // "xmm", "ymil": the unit glued to the axis word.
  const key = wordKey(cell), glued = /^(.*?)(mm|mils?|thou|inch|in|um)$/.exec(key);
  if (glued) {
    const stem = ALIASES.get(glued[1]);
    if (stem && (stem.role === 'x' || stem.role === 'y')) return { ...stem, unit: unitOfWord(glued[2]) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// numbers

export type Decimal = '.' | ',';
const DOT_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/, COMMA_NUMBER = /^[+-]?(?:\d+,?\d*|,\d+)(?:[eE][+-]?\d+)?$/;
const DOT_THOUSANDS = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/, COMMA_THOUSANDS = /^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d*)?$/;
const GROUP_SPACES = /[ \u00a0\u2009\u202f']/g, GROUPED = /^[+-]?\d{1,3}(?:[ \u00a0\u2009\u202f']\d{3})+(?:[.,]\d*)?$/;
const UNIT_SUFFIX = /\s*(mm|mils?|thou|inch|inches|in|"|um|µm|μm)$/i;
export interface ParsedNumber { value: number; unit?: PinListUnit }
/** Largest magnitude accepted from a file, before the unit is applied (the board builder checks the millimetre range). */
const MAX_RAW = 1e15;

/**
 * One number as written in a pin list: a plain decimal in the stated decimal convention, with an optional exponent, optional
 * digit grouping (spaces, apostrophes, or the other separator in groups of three) and an optional unit word after it ("12.5 mm",
 * "100mil", 0.5"). Anything else, including hexadecimal, "Infinity" and "NaN", is undefined.
 */
export function parseNumber(text: string, decimal: Decimal = '.'): ParsedNumber | undefined {
  let source = text.trim();
  if (!source || source.length > 48) return undefined;
  if (decimal === '.' ? DOT_NUMBER.test(source) : COMMA_NUMBER.test(source)) {
    const value = Number(decimal === ',' ? source.replace(',', '.') : source);
    return Number.isFinite(value) && Math.abs(value) <= MAX_RAW ? { value } : undefined;
  }
  let unit: PinListUnit | undefined;
  source = source.replace(/\u2212/g, '-');
  const suffix = UNIT_SUFFIX.exec(source);
  if (suffix) { unit = unitOfWord(suffix[1]); source = source.slice(0, suffix.index); }
  if (GROUPED.test(source)) source = source.replace(GROUP_SPACES, ''); // digits in threes, as 1 234,5 or 1'234.5
  let canonical: string;
  if (decimal === '.' ? DOT_NUMBER.test(source) : COMMA_NUMBER.test(source)) canonical = decimal === ',' ? source.replace(',', '.') : source;
  else if (decimal === '.' && DOT_THOUSANDS.test(source)) canonical = source.replace(/,/g, '');
  else if (decimal === ',' && COMMA_THOUSANDS.test(source)) canonical = source.replace(/\./g, '').replace(',', '.');
  else return undefined;
  const value = Number(canonical);
  if (!Number.isFinite(value) || Math.abs(value) > MAX_RAW) return undefined;
  return unit ? { value, unit } : { value };
}

export interface DecimalGuess { decimal: Decimal; source: 'detected' | 'default'; dot: number; comma: number }
const DOT_FRACTION = /^[+-]?\d*\.\d+(?:[eE][+-]?\d+)?\s*(?:[a-zµμ"]{1,8})?$/i, COMMA_FRACTION = /^[+-]?\d*,\d+(?:[eE][+-]?\d+)?\s*(?:[a-zµμ"]{1,8})?$/i;
/**
 * Which decimal separator the coordinate cells use: a cell with a fraction written with "," votes for the comma, one with "."
 * for the dot; the larger vote wins and a tie, or no fraction at all, is the dot. (A comma inside a number is a decimal comma:
 * coordinate exports do not group thousands, and a cell with both separators is read by `parseNumber` as grouped.)
 */
export function guessDecimal(cells: readonly string[]): DecimalGuess {
  let dot = 0, comma = 0;
  for (const cell of cells) {
    const text = cell.trim();
    if (text.length > 48) continue;
    if (DOT_FRACTION.test(text)) dot++;
    else if (COMMA_FRACTION.test(text)) comma++;
  }
  return { decimal: comma > dot ? ',' : '.', source: dot || comma ? 'detected' : 'default', dot, comma };
}

// ---------------------------------------------------------------------------------------------------------------------
// units

export interface UnitGuess { unit: PinListUnit; candidates: PinListUnit[]; confidence: number }
const PLAUSIBLE_MIN_MM = 8, PLAUSIBLE_MAX_MM = 1000;
/**
 * The unit a set of coordinates is probably in, from the larger extent of the pins: a board is between 8 and 1000 mm across.
 * Every unit that gives such a size is a candidate; integer coordinates prefer mil and micrometres (CAD writers use them), others
 * prefer millimetres and inches. Nothing plausible falls back to millimetres with a confidence near zero.
 */
export function guessUnit(extent: number, integers: boolean): UnitGuess {
  const order: PinListUnit[] = integers ? ['mil', 'um', 'mm', 'inch'] : ['mm', 'inch', 'mil', 'um'];
  const candidates = order.filter(unit => { const mm = extent * PINLIST_UNIT_MM[unit]; return mm >= PLAUSIBLE_MIN_MM && mm <= PLAUSIBLE_MAX_MM; });
  if (!candidates.length) return { unit: 'mm', candidates: [], confidence: 0.1 };
  return { unit: candidates[0], candidates, confidence: candidates.length === 1 ? 0.9 : candidates.length === 2 ? 0.5 : 0.3 };
}

// ---------------------------------------------------------------------------------------------------------------------
// sides

const SIDE_WORDS = new Map<string, BoardSide>();
function sideWords(side: BoardSide, words: string[]): void { for (const word of words) SIDE_WORDS.set(word, side); }
sideWords('top', ['t', 'top', 'topside', 'toplayer', 'topcomponent', 'f', 'front', 'frontside', 'fcu', 'component', 'componentside', 'comp', 'compside', 'primary', 'ts', 'oben', 'felso', 'dessus', 'arriba', '顶层', '顶面', '正面', '元件面', '顶']);
sideWords('bottom', ['b', 'bot', 'bottom', 'bottomside', 'bottomlayer', 'botlayer', 'back', 'backside', 'bcu', 'solder', 'solderside', 'secondary', 'bs', 'unten', 'also', 'dessous', 'abajo', '底层', '底面', '反面', '背面', '焊接面', '底']);
sideWords('both', ['both', 'bothsides', 'all', 'th', 'tht', 'thru', 'thruhole', 'through', 'throughhole', 'multi', 'multilayer', 'midlayer', 'topbottom', 'beide', '双面', '全部']);
/** The side a cell names, or undefined when it is not one of the known words ("Top", "F.Cu", "BOTTOM LAYER", "T", "Thru"). */
export function sideOfWord(cell: string): BoardSide | undefined { return cell.length > 32 ? undefined : SIDE_WORDS.get(wordKey(cell)); }

// ---------------------------------------------------------------------------------------------------------------------
// nets and reference designators

/** A reference designator written the usual way: letters, then digits, then anything alphanumeric ("R12", "U3A", "TP_5", "J1.2"). */
export const looksLikeRefdes = (text: string): boolean => text.length <= 24 && /^[A-Za-z]{1,6}_?\d{1,6}[A-Za-z0-9_.\-/]*$/.test(text);
/** Net names that mean "no net": empty, N/C and Altium's "No Net". */
export const isNoNet = (net: string): boolean => !net || /^(?:n\/c|no net|<no net>)$/i.test(net);
