import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parsePartValue } from '../../src/lib/part-value';
import type { PartQuantity, PartValue, ValueHint } from '../../src/lib/part-value';
import { expectScaling } from '../../src/test-support/timing';
import { params } from './support';

// ---------------------------------------------------------------------------------------------------------------
// Text generators
// ---------------------------------------------------------------------------------------------------------------

const digit = fc.constantFrom(...'0123456789'.split(''));
const digits = (min: number, max: number) => fc.array(digit, { minLength: min, maxLength: max }).map(list => list.join(''));
/** A whole part without leading zeros ("0" itself allowed): the shape of "4", "47", "100". */
const wholePart = fc.oneof(fc.constant('0'), fc.tuple(fc.constantFrom(...'123456789'.split('')), digits(0, 5)).map(([first, rest]) => first + rest));
const fraction = digits(0, 3);

interface Number3 { int: string; frac: string }
const mantissa: fc.Arbitrary<Number3> = fc.record({ int: wholePart, frac: fraction });
/** What the reader promises for decimal digits: one correctly rounded double of the decimal string. */
const exact = (n: Number3, exponent: number): number => Number(`${n.int}.${n.frac || '0'}e${exponent}`);
const decimal = (n: Number3): string => (n.frac ? `${n.int}.${n.frac}` : n.int);

/** Characters that all count as the blank between two fields. */
const BLANKS = [' ', '\t', ' ', ' ', '　', ' '];
const blank = fc.constantFrom(...BLANKS);

type Spelling = { text: string };
const spellings = (candidates: fc.Arbitrary<string>): fc.Arbitrary<Spelling> => candidates.map(text => ({ text }));

// A resistance: prefix letters (any case the reader accepts) and ohm spellings.
const R_PREFIXES: ReadonlyArray<readonly [exponent: number, letters: readonly string[]]> = [[-3, ['m']], [0, ['']], [3, ['k', 'K']], [6, ['M', 'meg', 'Meg', 'MEG']], [9, ['G']]];
const OHM_UNITS = ['', 'R', 'r', 'E', 'e', 'ohm', 'Ohm', 'OHM', 'ohms', 'Ω', 'Ω'];
const resistance = fc.record({ n: mantissa, p: fc.constantFrom(...R_PREFIXES), unit: fc.constantFrom(...OHM_UNITS), gap: fc.option(blank, { nil: '' }) }).filter(({ p, unit, gap }) => !(p[0] === 0 && unit === '') && !(gap && p[1][0] === '' && unit === ''))
  .chain(({ n, p, unit, gap }) => fc.constantFrom(...p[1]).map(letters => ({ n, exponent: p[0], text: `${decimal(n)}${gap ?? ''}${letters}${unit}` })));
const iecResistance = fc.record({ whole: wholePart, frac: digits(1, 3), code: fc.constantFrom<readonly [string, number]>(['R', 0], ['r', 0], ['E', 0], ['e', 0], ['K', 3], ['k', 3], ['M', 6], ['m', -3], ['G', 9], ['g', 9]) })
  .map(({ whole, frac, code }) => ({ n: { int: whole, frac }, exponent: code[1], text: `${whole}${code[0]}${frac}` }));
const leadingR = digits(1, 4).filter(frac => !['0201', '0402', '0603', '0805', '1008', '1206', '1210', '1218', '1806', '1808', '1812', '2010', '2220', '2225', '2512'].includes(frac))
  .chain(frac => fc.constantFrom('R', 'r').map(letter => ({ n: { int: '0', frac }, exponent: 0, text: `${letter}${frac}` })));
const commaResistance = fc.record({ int: fc.constantFrom('1', '2', '4', '10', '47', '100', '470', '999'), frac: digits(1, 3), p: fc.constantFrom<readonly [string, number]>(['k', 3], ['K', 3], ['M', 6], ['R', 0], ['m', -3]) })
  .map(({ int, frac, p }) => ({ n: { int, frac }, exponent: p[1], text: `${int},${frac}${p[0]}` }));
const anyResistance = fc.oneof({ weight: 4, arbitrary: resistance }, { weight: 2, arbitrary: iecResistance }, { weight: 1, arbitrary: leadingR }, { weight: 1, arbitrary: commaResistance });

const C_PREFIXES: ReadonlyArray<readonly [number, readonly string[]]> = [[-12, ['p', 'P']], [-9, ['n', 'N']], [-6, ['u', 'U', 'µ', 'μ']]];
const capacitance = fc.record({ n: mantissa, p: fc.constantFrom(...C_PREFIXES), unit: fc.constantFrom('', 'F', 'f') })
  .chain(({ n, p, unit }) => fc.constantFrom(...p[1]).map(letters => ({ n, exponent: p[0], text: `${decimal(n)}${letters}${unit}` })));
const iecCapacitance = fc.record({ whole: wholePart, p: fc.constantFrom<readonly [string, number]>(['p', -12], ['n', -9], ['u', -6], ['µ', -6], ['μ', -6]), frac: digits(1, 3), unit: fc.constantFrom('', 'F') })
  .map(({ whole, p, frac, unit }) => ({ n: { int: whole, frac }, exponent: p[1], text: `${whole}${p[0]}${frac}${unit}` }));
const anyCapacitance = fc.oneof(capacitance, iecCapacitance);

const inductance = fc.record({ n: mantissa, p: fc.constantFrom<readonly [string, number]>(['n', -9], ['u', -6], ['µ', -6], ['m', -3], ['', 0]), unit: fc.constantFrom('H', 'h') })
  .map(({ n, p, unit }) => ({ n, exponent: p[1], text: `${decimal(n)}${p[0]}${unit}` }));
const voltage = fc.record({ n: mantissa, sign: fc.constantFrom('', '+', '-'), style: fc.constantFrom('point', 'infix') })
  .filter(({ n, style }) => style === 'point' || n.frac !== '')
  .map(({ n, sign, style }) => ({ n, sign, text: style === 'point' ? `${sign}${decimal(n)}V` : `${sign}${n.int}V${n.frac}` }));

// Text that does not change what a value means: a tolerance, a package, a dielectric, a rating, other words.
const NEUTRAL = ['', ' 1%', ' 5%', ' +/-1%', ' 0402', ' 0603', ' X7R', ' C0G', ' 1/16W', ' 50V', ' ceramic', ' SMD'];

// ---------------------------------------------------------------------------------------------------------------
// Reading one number in many spellings
// ---------------------------------------------------------------------------------------------------------------

describe('part value: one number in every spelling', () => {
  it('reads every spelling of a resistance to the same correctly rounded double, whatever the prefix case, ohm sign, IEC code or decimal mark', () => {
    fc.assert(fc.property(anyResistance, fc.constantFrom(...NEUTRAL), ({ n, exponent, text }, extra) => {
      const value = parsePartValue(text + extra);
      expect(value.quantity).toBe('resistance');
      expect(Object.is(value.si, exact(n, exponent))).toBe(true);
      expect(value.notFitted).toBe(false);
    }), params(800));
  });

  it('reads capacitances and inductances the same way, and a bare prefix by the hint', () => {
    fc.assert(fc.property(anyCapacitance, ({ n, exponent, text }) => {
      expect(parsePartValue(text)).toMatchObject({ quantity: 'capacitance', si: exact(n, exponent) });
      expect(parsePartValue(text, 'capacitance')).toMatchObject({ quantity: 'capacitance', si: exact(n, exponent) });
    }), params(500));
    fc.assert(fc.property(inductance, ({ n, exponent, text }) => {
      expect(parsePartValue(text)).toMatchObject({ quantity: 'inductance', si: exact(n, exponent) });
    }), params(300));
    // A capacitor-style prefix without a unit is an inductor for an inductor and nothing for a resistor.
    fc.assert(fc.property(mantissa, fc.constantFrom<readonly [string, number]>(['n', -9], ['u', -6], ['p', -12]), (n, p) => {
      const text = `${decimal(n)}${p[0]}`;
      expect(parsePartValue(text, 'inductance')).toMatchObject({ quantity: 'inductance', si: exact(n, p[1]), unitless: true });
      expect(parsePartValue(text, 'resistance')).toMatchObject({ quantity: null, si: null });
    }), params(200));
  });

  it('reads voltages with their sign', () => {
    fc.assert(fc.property(voltage, ({ n, sign, text }) => {
      const value = parsePartValue(text);
      expect(value.quantity).toBe('voltage');
      const magnitude = exact(n, 0);
      expect(Object.is(value.si, sign === '-' && magnitude !== 0 ? -magnitude : magnitude)).toBe(true);
    }), params(300));
  });

  it('ignores the blanks that separate fields: every Unicode space gives the result of the plain space', () => {
    const fragments = ['4K7', '100n', '10 k', '2.2uH', 'DNP', '1%', '0402', '600R@100MHz', '3V3', 'NC', 'do not place', '/', '120R/100M', 'X7R'];
    fc.assert(fc.property(fc.array(fc.constantFrom(...fragments), { minLength: 1, maxLength: 5 }), fc.array(blank, { minLength: 1, maxLength: 6 }), fc.constantFrom<ValueHint | undefined>(undefined, 'resistance', 'capacitance', 'inductance'), (parts, blanks, hint) => {
      const plain = parts.join(' ');
      let index = 0;
      const mixed = plain.replace(/ /g, () => blanks[index++ % blanks.length]);
      expect(parsePartValue(mixed, hint)).toEqual(parsePartValue(plain, hint));
      expect(parsePartValue(`${blanks[0]}${mixed}${blanks[0]}`, hint)).toEqual(parsePartValue(plain, hint));
    }), params(400));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Markers, tolerance and neighbours do not disturb the value
// ---------------------------------------------------------------------------------------------------------------

describe('part value: markers and tolerances', () => {
  const MARKERS = ['DNP', 'dnp', 'Dnp', 'DNI', 'NC', 'nc', 'N/C', 'n/c', 'N.C.', 'NF', 'DNF', 'DNS', 'NOSTUFF', 'NO STUFF', 'not fitted', 'NOT FITTED', 'do not place', 'DO NOT POPULATE', 'nofit', 'noplace', 'nopop'];

  it('reads the value next to a not-fitted marker unchanged and reports the marker, in front, behind or between', () => {
    fc.assert(fc.property(anyResistance, fc.constantFrom(...MARKERS), fc.constantFrom('before', 'after'), fc.constantFrom(' ', '  ', '\t', ' - ', ', ', '; '), ({ n, exponent, text }, marker, where, glue) => {
      const joined = where === 'before' ? `${marker}${glue}${text}` : `${text}${glue}${marker}`;
      const value = parsePartValue(joined);
      expect(value.notFitted).toBe(true);
      expect(value.quantity).toBe('resistance');
      expect(Object.is(value.si, exact(n, exponent))).toBe(true);
    }), params(500));
  });

  it('a marker without a value is a marker only; text without a marker is never one', () => {
    fc.assert(fc.property(fc.constantFrom(...MARKERS), marker => {
      expect(parsePartValue(marker)).toEqual({ quantity: null, si: null, notFitted: true });
    }), params(40));
    fc.assert(fc.property(anyResistance, anyCapacitance, ({ text: r }, { text: c }) => {
      expect(parsePartValue(`${r} ${c}`).notFitted).toBe(false);
      expect(parsePartValue(c).notFitted).toBe(false);
    }), params(300));
  });

  it('a tolerance is read once and the first one wins; it never changes the value', () => {
    fc.assert(fc.property(anyResistance, fc.double({ min: 0, max: 99, noNaN: true }).map(v => Number(v.toFixed(2))), fc.double({ min: 0, max: 99, noNaN: true }).map(v => Number(v.toFixed(2))), ({ text }, first, second) => {
      const plain = parsePartValue(text);
      const withOne = parsePartValue(`${text} ${first}%`);
      expect(withOne.quantity).toBe(plain.quantity);
      expect(Object.is(withOne.si, plain.si)).toBe(true);
      expect(withOne.tolerance).toBeCloseTo(first / 100, 12);
      const withTwo = parsePartValue(`${text} ${first}% ${second}%`);
      expect(withTwo.tolerance).toBe(withOne.tolerance);
      expect(Object.is(withTwo.si, plain.si)).toBe(true);
    }), params(300));
  });

  it('a lone percentage is a tolerance and no value', () => {
    fc.assert(fc.property(mantissa, n => {
      expect(parsePartValue(`${decimal(n)}%`)).toMatchObject({ quantity: null, si: null, notFitted: false });
      expect(parsePartValue(`${decimal(n)}%`).tolerance).toBeGreaterThanOrEqual(0);
    }), params(150));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Never throws, results are well formed
// ---------------------------------------------------------------------------------------------------------------

const QUANTITIES: ReadonlySet<PartQuantity | null> = new Set([null, 'resistance', 'capacitance', 'inductance', 'impedance@f', 'voltage', 'current']);
const FRAGMENTS = ['4K7', '4k7', '0R', 'R005', '100n', '0.1uF', '0,1µF', '2.2uH', '600R@100MHz', '120R/100M', '220R(100MHz)', '10K', '10 k', '1%', '5 %', '0402', 'DNP', 'NC', 'N/C', 'do not place', 'OPEN', 'nF', '3V3', '+5V', '-12V', 'meg', 'ohm', 'Ω', '1M5', '2E2', '1/16W', 'TYPE-C-31', '1N4148', '4N35', '@', '/', ',', '.', '-', '+', '%', '(', ')', ' ', '  ', '\t', ' ', 'x', 'R', 'K', 'M', 'm', 'u', 'p', 'H', 'F', 'V', 'A', 'G', '0', '1', '9', '65536', '123456789', '00012'];
const soup = fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 12 }).map(parts => parts.join(''));
const anyText = fc.oneof(soup, soup.chain(text => fc.constantFrom(' ', ' ', '').map(glue => `${text}${glue}${text}`)), fc.string({ maxLength: 40 }), fc.string({ unit: 'grapheme', maxLength: 30 }), fc.string({ unit: 'binary', maxLength: 30 }));
const hint = fc.constantFrom<ValueHint | null | undefined>(undefined, null, 'resistance', 'capacitance', 'inductance');

/** What every result must satisfy, whatever the text. */
function wellFormed(value: PartValue, label: string): void {
  expect(QUANTITIES.has(value.quantity), label).toBe(true);
  expect(typeof value.notFitted, label).toBe('boolean');
  if (value.quantity === null) expect(value.si, label).toBeNull();
  if (value.si !== null) { expect(Number.isFinite(value.si), label).toBe(true); expect(value.quantity, label).not.toBeNull(); }
  if (value.quantity === 'impedance@f') { expect(Number.isFinite(value.frequencyHz), label).toBe(true); expect(value.frequencyHz as number, label).toBeGreaterThan(0); expect(value.si as number, label).toBeGreaterThanOrEqual(0); } else expect(value.frequencyHz, label).toBeUndefined();
  if (value.quantity === 'resistance' || value.quantity === 'capacitance' || value.quantity === 'inductance') expect(value.si === null || value.si >= 0, label).toBe(true);
  if (value.tolerance !== undefined) { expect(Number.isFinite(value.tolerance), label).toBe(true); expect(value.tolerance, label).toBeGreaterThanOrEqual(0); }
  if (value.unitless !== undefined) expect(value.unitless, label).toBe(true);
  expect(Object.keys(value).every(key => ['quantity', 'si', 'notFitted', 'frequencyHz', 'tolerance', 'unitless'].includes(key)), label).toBe(true);
}

describe('part value: no throw, well formed, deterministic', () => {
  it('returns a well-formed result for any text and any hint, the same one every time, and never reads its input twice differently', () => {
    fc.assert(fc.property(anyText, hint, (text, expected) => {
      const first = parsePartValue(text, expected);
      wellFormed(first, JSON.stringify(text));
      expect(parsePartValue(text, expected)).toEqual(first);
    }), params(1500));
  });

  it('survives values that are not text', () => {
    fc.assert(fc.property(fc.anything(), hint, (value, expected) => {
      const result = parsePartValue(value as string, expected);
      if (typeof value !== 'string') expect(result).toEqual({ quantity: null, si: null, notFitted: false });
      else wellFormed(result, String(value));
    }), params(300));
  });

  it('the hint only settles what the text leaves open: a text that names its quantity reads the same with every hint', () => {
    fc.assert(fc.property(fc.oneof(anyResistance, anyCapacitance, inductance, voltage), hint, ({ text }, expected) => {
      const plain = parsePartValue(text);
      if (plain.unitless) return;
      expect(parsePartValue(text, expected)).toEqual(plain);
    }), params(400));
  });

  it('a value in the middle of other words is found wherever it stands, and words around a single value do not change it', () => {
    const words = fc.constantFrom('RES', 'CAP', 'FERRITE', 'THICK FILM', 'X7R', '0402', '1/16W', '1%', '5%', 'TYPE-C-31', 'ceramic', 'SMD');
    fc.assert(fc.property(anyResistance, fc.array(words, { maxLength: 3 }), fc.array(words, { maxLength: 3 }), ({ n, exponent, text }, before, after) => {
      const value = parsePartValue([...before, text, ...after].join(' '));
      expect(value.quantity).toBe('resistance');
      expect(Object.is(value.si, exact(n, exponent))).toBe(true);
    }), params(300));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Normalization: read, write in canonical text, read again
// ---------------------------------------------------------------------------------------------------------------

/** Engineering prefixes the reader accepts per base unit (a mega farad, a giga volt do not exist and are not read). */
const PREFIXES: Record<'R' | 'F' | 'H' | 'V' | 'A', ReadonlyArray<readonly [exponent: number, letter: string]>> = {
  R: [[9, 'G'], [6, 'M'], [3, 'k'], [0, ''], [-3, 'm']],
  F: [[3, 'k'], [0, ''], [-3, 'm'], [-6, 'u'], [-9, 'n'], [-12, 'p']],
  H: [[3, 'k'], [0, ''], [-3, 'm'], [-6, 'u'], [-9, 'n'], [-12, 'p']],
  V: [[3, 'k'], [0, ''], [-3, 'm'], [-6, 'u'], [-9, 'n'], [-12, 'p']],
  A: [[3, 'k'], [0, ''], [-3, 'm'], [-6, 'u'], [-9, 'n'], [-12, 'p']],
};
const UNIT_OF: Partial<Record<PartQuantity, 'R' | 'F' | 'H' | 'V' | 'A'>> = { resistance: 'R', capacitance: 'F', inductance: 'H', voltage: 'V', current: 'A', 'impedance@f': 'R' };

/** Significant digits and decimal exponent of a finite non-negative double: value = digits x 10^exponent. */
function decimalDigits(value: number): { digits: string; exponent: number } {
  const [mantissaText, exponentText] = value.toExponential().split('e');
  const digits = mantissaText.replace('.', '');
  return { digits, exponent: Number(exponentText) - (digits.length - 1) };
}
/** The reader's own spelling of a magnitude: at most three decimals after one engineering prefix, or null when none fits. */
function spell(magnitude: number, unit: 'R' | 'F' | 'H' | 'V' | 'A'): string | null {
  if (magnitude === 0) return `0${unit}`;
  const { digits, exponent } = decimalDigits(magnitude);
  for (const [power, letter] of PREFIXES[unit]) {
    const shift = exponent - power;
    if (shift < -3) continue;
    let int: string, frac: string;
    if (shift >= 0) { int = digits + '0'.repeat(shift); frac = ''; }
    else if (digits.length + shift > 0) { int = digits.slice(0, digits.length + shift); frac = digits.slice(digits.length + shift); }
    else { int = '0'; frac = '0'.repeat(-(digits.length + shift)) + digits; }
    if (frac.length > 3) continue;
    const text = `${int}${frac ? `.${frac}` : ''}${letter}${unit}`;
    return text.length <= 60 ? text : null;
  }
  return null;
}
function plainDecimal(value: number): string | null {
  const { digits, exponent } = decimalDigits(value);
  const text = exponent >= 0 ? digits + '0'.repeat(exponent) : digits.length + exponent > 0 ? `${digits.slice(0, digits.length + exponent)}.${digits.slice(digits.length + exponent)}` : `0.${'0'.repeat(-(digits.length + exponent))}${digits}`;
  return text.length <= 60 ? text : null;
}
/** Canonical text of a read value, or null when it has none (no number, or one the reader could not read back). */
function canonical(value: PartValue): string | null {
  if (value.quantity === null || value.si === null) return null;
  const unit = UNIT_OF[value.quantity];
  if (!unit) return null;
  const magnitude = Math.abs(value.si), sign = value.si < 0 ? '-' : '';
  const text = spell(magnitude, unit);
  if (text === null) return null;
  if (value.quantity === 'impedance@f') {
    const frequency = plainDecimal(value.frequencyHz as number);
    return frequency === null ? null : `${text}@${frequency}Hz`;
  }
  return `${sign}${text}`;
}

/** Readable values, alone or with neighbours, so that most draws reach the writer. */
const impedance = fc.tuple(anyResistance, mantissa, fc.constantFrom<readonly [string, string]>(['@', 'MHz'], ['@', 'kHz'], ['/', 'M'], [' ', 'GHz'], ['@', 'Hz']))
  .map(([{ text }, n, [glue, unit]]) => `${text.replace(/[RrEeΩΩ]$/, '')}R${glue}${decimal(n)}${unit}`);
const valueText = fc.tuple(fc.oneof(anyResistance.map(r => r.text), anyCapacitance.map(c => c.text), inductance.map(l => l.text), voltage.map(v => v.text), impedance), fc.constantFrom(...NEUTRAL), fc.constantFrom('', '', ' DNP'))
  .map(([text, extra, marker]) => text + extra + marker);

describe('part value: normalization is idempotent', () => {
  it('canonical text reads back to the very same quantity and number, and writing it again gives the same text', () => {
    let covered = 0;
    fc.assert(fc.property(fc.oneof(anyText, valueText, valueText), hint, (text, expected) => {
      const value = parsePartValue(text, expected);
      const written = canonical(value);
      if (written === null) return;
      covered++;
      const again = parsePartValue(written);
      expect(again.quantity, `${JSON.stringify(text)} -> ${written}`).toBe(value.quantity);
      expect(Object.is(again.si, value.si), `${JSON.stringify(text)} -> ${written}`).toBe(true);
      expect(again.frequencyHz).toBe(value.frequencyHz);
      expect(again.notFitted).toBe(false);
      expect(canonical(again)).toBe(written);
    }), params(1500));
    expect(covered).toBeGreaterThan(200);
  });

  it('every generated spelling of a number has the same canonical text', () => {
    fc.assert(fc.property(mantissa, fc.constantFrom(-3, 0, 3, 6), fc.integer({ min: 0, max: 2 }), (n, exponent, style) => {
      const letters = { '-3': 'm', '0': '', '3': 'k', '6': 'M' }[String(exponent) as '-3' | '0' | '3' | '6'];
      const base = `${decimal(n)}${letters}R`;
      const variants = [base, `${decimal(n)} ${letters}ohm`, `${decimal(n)}${letters}`, ...(letters === '' ? [] : [`${decimal(n)}${letters}Ω`])].filter(text => text !== decimal(n));
      const wanted = canonical(parsePartValue(variants[style % variants.length]));
      for (const variant of variants) expect(canonical(parsePartValue(variant))).toBe(wanted);
    }), params(300));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Linear time
// ---------------------------------------------------------------------------------------------------------------

describe('part value: time grows linearly with the length of the text', () => {
  // The running time is compared with itself at other sizes in the same test (src/test-support/timing.ts), never with a number of milliseconds:
  // a linear reader grows by 4 per step of four times the text, a quadratic one by 16.
  it('four times the text takes far less than sixteen times as long, for any repetition of any fragments', () => {
    const unitOf = fc.array(fc.constantFrom(...FRAGMENTS, '0'.repeat(7), '1,', '12,5', 'R', 'K7', ' k ', '5%'), { minLength: 1, maxLength: 4 }).map(parts => parts.join(''));
    fc.assert(fc.property(unitOf, unit => {
      expectScaling(JSON.stringify(unit), [4_000, 16_000, 64_000], size => { const text = unit.repeat(Math.max(1, Math.ceil(size / unit.length))); return () => parsePartValue(text); });
    }), params(6));
  });

  it('a text of a million characters of any shape is read to a well-formed value, in time that grows with its length', () => {
    const shapes = fc.constantFrom('1', ',', '.', ' ', 'R', 'k', '@', '/', '-', '%', '1 k ', '4K7 ', 'DO NOT ', '5%', '600R@', '0'.repeat(63) + ' ', 'x');
    fc.assert(fc.property(shapes, shape => {
      const text = shape.repeat(Math.ceil(1_000_000 / shape.length));
      wellFormed(parsePartValue(text), JSON.stringify(shape));
      expectScaling(JSON.stringify(shape), [25_000, 100_000, 400_000], size => { const part = shape.repeat(Math.ceil(size / shape.length)); return () => parsePartValue(part); });
    }), params(5));
  });
});
