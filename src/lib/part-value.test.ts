import { describe, expect, it } from 'vitest';
import { parsePartValue, type PartQuantity, type PartValue, type ValueHint } from './part-value';
import { expectScaling } from '../test-support/timing';

const R: PartQuantity = 'resistance', C: PartQuantity = 'capacitance', L: PartQuantity = 'inductance';
const Z: PartQuantity = 'impedance@f', V: PartQuantity = 'voltage', I: PartQuantity = 'current';
type Extra = Partial<Pick<PartValue, 'frequencyHz' | 'tolerance' | 'unitless' | 'notFitted'>>;
type Row = [text: string, quantity: PartQuantity | null, si: number | null, extra?: Extra];
const unitless: Extra = { unitless: true };
const nf: Extra = { notFitted: true };
const expected = ([, quantity, si, extra]: Row): PartValue => ({ quantity, si, notFitted: false, ...extra });

// The number of the text in base units, written as the literal the parser must produce exactly.
const TABLE: Row[] = [
  // Resistance: zero ohm and the IEC code forms
  ['0', R, 0, unitless], ['0R', R, 0], ['0r', R, 0], ['0Ω', R, 0], ['0Ω', R, 0], ['0E', R, 0], ['0 ohm', R, 0], ['0 OHM 1%', R, 0, { tolerance: 0.01 }],
  ['000', R, 0, unitless], ['R005', R, 0.005], ['R010', R, 0.01], ['r47', R, 0.47], ['R0025', R, 0.0025], ['0R05', R, 0.05],
  ['2R2', R, 2.2], ['2r2', R, 2.2], ['2E2', R, 2.2], ['4K7', R, 4700], ['4k7', R, 4700], ['1M5', R, 1.5e6], ['2M2', R, 2.2e6], ['1G5', R, 1.5e9],
  ['1R', R, 1], ['100R', R, 100], ['100E', R, 100], ['10K', R, 10000], ['10k', R, 10000], ['10KR', R, 10000], ['1M', R, 1e6], ['1G', R, 1e9],
  // Resistance: decimals, prefixes, units, spelled out
  ['4.7K', R, 4700], ['4.7kΩ', R, 4700], ['4.7 kOhm', R, 4700], ['10 k', R, 10000], ['10K OHM', R, 10000], ['1MΩ', R, 1e6], ['1MEG', R, 1e6],
  ['1meg', R, 1e6], ['2.2Meg', R, 2.2e6], ['1MOhm', R, 1e6], ['1Mohm', R, 1e6], ['1mΩ', R, 0.001], ['10mR', R, 0.01], ['10m', R, 0.01, unitless],
  ['0.5R', R, 0.5], ['.5k', R, 500], ['0.01', R, 0.01, unitless], ['1', R, 1, unitless], ['22', R, 22, unitless], ['1000', R, 1000, unitless],
  ['103', R, 103, unitless], ['1e3', R, 1.3], ['0 0402', R, 0, unitless],
  // Resistance with tolerance and company
  ['47K 1%', R, 47000, { tolerance: 0.01 }], ['10k 5%', R, 10000, { tolerance: 0.05 }], ['10K ±1%', R, 10000, { tolerance: 0.01 }],
  ['10K +/-1%', R, 10000, { tolerance: 0.01 }], ['10K-1%', R, 10000, { tolerance: 0.01 }], ['10K,1%', R, 10000, { tolerance: 0.01 }],
  ['100R 0.1%', R, 100, { tolerance: 0.001 }], ['10K 0402 1%', R, 10000, { tolerance: 0.01 }], ['RES 10K 0402', R, 10000], ['0402 10K', R, 10000],
  ['10K/0402/1%', R, 10000, { tolerance: 0.01 }], ['10K 1/16W', R, 10000], ['  4K7  ', R, 4700], ['10K 1 %', R, 10000, { tolerance: 0.01 }],
  ['RESISTOR 4K7 1% THICK FILM', R, 4700, { tolerance: 0.01 }],
  // Decimal comma
  ['4,7k', R, 4700], ['0,1uF', C, 1e-7], ['1,5M', R, 1.5e6], ['2,2uF 10%', C, 2.2e-6, { tolerance: 0.1 }], ['0402,10K', R, 10000],
  // Capacitance
  ['100n', C, 1e-7, unitless], ['100nF', C, 1e-7], ['100NF', C, 1e-7], ['0.1uF', C, 1e-7], ['0.1µF', C, 1e-7], ['0.1μF', C, 1e-7],
  ['0.1u', C, 1e-7, unitless], ['100 nF', C, 1e-7], ['100 n F', C, 1e-7], ['4n7', C, 4.7e-9, unitless], ['4N7', C, 4.7e-9, unitless],
  ['4n7F', C, 4.7e-9], ['2u2', C, 2.2e-6, unitless], ['2U2', C, 2.2e-6, unitless], ['2u2F', C, 2.2e-6], ['10uF', C, 1e-5], ['10UF', C, 1e-5],
  ['10U', C, 1e-5, unitless], ['22pF', C, 2.2e-11], ['22p', C, 2.2e-11, unitless], ['22P', C, 2.2e-11, unitless], ['4p7', C, 4.7e-12, unitless],
  ['0.5pF', C, 5e-13], ['1mF', C, 1e-3], ['1MF', C, 1e-3], ['1F', C, 1], ['100uF 16V', C, 1e-4], ['10uF/16V/X5R', C, 1e-5],
  ['22uF 6.3V 20%', C, 2.2e-5, { tolerance: 0.2 }], ['CAP CER 0.1UF 50V X7R 0603', C, 1e-7], ['100nF 10% 0402', C, 1e-7, { tolerance: 0.1 }],
  ['100nF_16V', C, 1e-7], ['0.1UF-50V', C, 1e-7], ['100nF-16V', C, 1e-7], ['DNP-10K', R, 10000, nf], ['0805-10K', R, 10000], ['10K-DNP', R, 10000, nf], ['~10K', R, 10000], ['10K*', R, 10000], ['#4K7!', R, 4700], ['10K&1%', R, 10000, { tolerance: 0.01 }], ['(-12V)', V, -12], [' -12V', V, -12],
  // Inductance
  ['2.2uH', L, 2.2e-6], ['1UH', L, 1e-6], ['10nH', L, 1e-8], ['1mH', L, 1e-3], ['1MH', L, 1e-3], ['4u7H', L, 4.7e-6], ['4.7 uH', L, 4.7e-6],
  ['22uH 20%', L, 2.2e-5, { tolerance: 0.2 }], ['100uH/2A', L, 1e-4], ['1H', L, 1], ['10 u H', L, 1e-5],
  // Ferrite impedance at a frequency
  ['600R@100MHz', Z, 600, { frequencyHz: 1e8 }], ['120R/100M', Z, 120, { frequencyHz: 1e8 }], ['600 ohm @ 100 MHz', Z, 600, { frequencyHz: 1e8 }],
  ['600R 100MHz', Z, 600, { frequencyHz: 1e8 }], ['220R(100MHz)', Z, 220, { frequencyHz: 1e8 }], ['1K@100MHz', Z, 1000, { frequencyHz: 1e8 }],
  ['120R/100MHz', Z, 120, { frequencyHz: 1e8 }], ['600Ω@100MHz', Z, 600, { frequencyHz: 1e8 }], ['470R@1GHz', Z, 470, { frequencyHz: 1e9 }],
  ['100R/1.5GHz', Z, 100, { frequencyHz: 1.5e9 }], ['600R@100MHz 25% 3A', Z, 600, { frequencyHz: 1e8, tolerance: 0.25 }],
  ['600R/100MHz, 2A', Z, 600, { frequencyHz: 1e8 }], ['600r@100mhz', Z, 600, { frequencyHz: 1e8 }], ['30R@100M', Z, 30, { frequencyHz: 1e8 }],
  ['120R/200mA', R, 120], ['10K/1M', R, 10000], ['600R@100', R, 600],
  // Voltage and current
  ['3V3', V, 3.3], ['5V', V, 5], ['12V', V, 12], ['+5V', V, 5], ['-12V', V, -12], ['1V8', V, 1.8], ['1.8V', V, 1.8], ['5V1', V, 5.1],
  ['500mV', V, 0.5], ['0V', V, 0], ['3.3 V', V, 3.3], ['1.5A', I, 1.5], ['500mA', I, 0.5], ['2A/32V', I, 2], ['1A', I, 1], ['100uA', I, 1e-4],
  ['32V 2A', V, 32],
  // Not-fitted markers
  ['NC', null, null, nf], ['N/C', null, null, nf], ['N.C.', null, null, nf], ['DNP', null, null, nf], ['dnp', null, null, nf], ['DNI', null, null, nf],
  ['DNF', null, null, nf], ['DNS', null, null, nf], ['NF', null, null, nf], ['NOSTUFF', null, null, nf], ['NO STUFF', null, null, nf], ['NO_STUFF', null, null, nf],
  ['DO NOT PLACE', null, null, nf], ['DO NOT POPULATE', null, null, nf], ['NOT FITTED', null, null, nf], ['NOPOP', null, null, nf], ['(DNP)', null, null, nf],
  ['OPEN', null, null, nf], ['10K DNP', R, 10000, nf], ['DNP 10K', R, 10000, nf], ['100nF NC', C, 1e-7, nf], ['0R NF', R, 0, nf], ['4K7 (DNP)', R, 4700, nf],
  ['10uF/16V/DNP', C, 1e-5, nf], ['100 DNP', R, 100, { ...unitless, notFitted: true }],
  // A percent alone is a tolerance, not a value
  ['1%', null, null, { tolerance: 0.01 }], ['±5%', null, null, { tolerance: 0.05 }], ['0.1%', null, null, { tolerance: 0.001 }],
  // Not values
  ['', null, null], ['   ', null, null], ['1N4148', null, null], ['2N3904', null, null], ['2N7002', null, null], ['4N35', null, null], ['BC547', null, null],
  ['74HC595', null, null], ['LM358', null, null], ['TPS62130RGTR', null, null], ['ESP32-WROOM', null, null], ['X7R', null, null], ['C0G', null, null],
  ['NP0', null, null], ['16MHz', null, null], ['32.768kHz', null, null], ['1/16W', null, null], ['0402', null, null], ['0603', null, null], ['0805', null, null],
  ['1206', null, null], ['SOT-23', null, null], ['MOUNTINGHOLE', null, null], ['M3', null, null], ['E24', null, null], ['R', null, null], ['K47', null, null],
  ['0x10', null, null], ['1.2.3', null, null], ['1 2', null, null], ['10 20', null, null], ['abc', null, null], ['Infinity', null, null], ['NaN', null, null],
  ['OPEN DRAIN', null, null], ['R0402', null, null], ['R0603 10K', R, 10000], ['R0805 4K7', R, 4700], ['HRO TYPE-C-31-M-12', null, null], ['10-k', null, null], ['10,k', null, null], ['10-M', null, null], ['10 M', R, 1e7], ['744043101', null, null], ['12345678', R, 12345678, unitless], ['123456789', null, null], ['AP2112K-3.3', null, null], ['RC0402FR-0710KL', null, null], ['SDR0805-100KL', null, null], ['100 NF 100 NF', C, 1e-7], ['--5', null, null], ['5V5V', null, null],
];

describe('parsePartValue: table', () => {
  it('has at least 100 cases', () => { expect(TABLE.length).toBeGreaterThanOrEqual(100); });
  it.each(TABLE.map(row => [row[0], row] as const))('%j', (_text, row) => {
    expect(parsePartValue(row[0])).toEqual(expected(row));
  });
});

describe('parsePartValue: one number, however it is written', () => {
  const same = (texts: string[], quantity: PartQuantity, si: number) => {
    for (const text of texts) expect(parsePartValue(text), text).toMatchObject({ quantity, si });
  };
  it('100 nF', () => same(['100n', '100nF', '100NF', '0.1u', '0.1uF', '0.1µF', '0.1μF', '.1u', '100 nF', '0,1uF', '100nF/16V', 'CAP 100nF X7R 0402', '0u1'], C, 1e-7));
  it('4.7 kohm', () => same(['4K7', '4k7', '4.7K', '4.7k', '4,7k', '4.7 kOhm', '4700', '4700R', '4K7R', '4.7kE', '4k7 1%'], R, 4700));
  it('0.01 ohm', () => same(['R010', '0R01', '10mR', '10m', '0.01', '0.01R', '10 mohm', '0,01'], R, 0.01));
  it('2.2 microhenry', () => same(['2.2uH', '2.2UH', '2u2H', '2U2H', '2.2µH', '2.2 uH', '2,2uH'], L, 2.2e-6));
  it('3.3 volt', () => same(['3V3', '3v3', '3.3V', '3.3 V', '+3V3', '3,3V'], V, 3.3));
  it('bit-for-bit equal numbers', () => {
    expect(parsePartValue('100n').si).toBe(parsePartValue('0.1u').si);
    expect(parsePartValue('4n7').si).toBe(parsePartValue('4.7nF').si);
    expect(parsePartValue('2u2').si).toBe(parsePartValue('2.2uF').si);
    expect(parsePartValue('1M5').si).toBe(parsePartValue('1500k').si);
  });
});

describe('parsePartValue: the hint settles unitless text', () => {
  it('reads p, n and u as inductance when the part is an inductor', () => {
    expect(parsePartValue('100n', 'inductance')).toEqual({ quantity: L, si: 1e-7, notFitted: false, unitless: true });
    expect(parsePartValue('4u7', 'inductance')).toMatchObject({ quantity: L, si: 4.7e-6 });
  });
  it('rejects a capacitor-style prefix on a resistor', () => {
    expect(parsePartValue('100n', 'resistance')).toEqual({ quantity: null, si: null, notFitted: false });
    expect(parsePartValue('4N7', 'resistance').quantity).toBeNull();
    expect(parsePartValue('10K', 'resistance')).toMatchObject({ quantity: R, si: 10000 });
  });
  it('names the quantity of a bare number but not its scale for capacitors and inductors', () => {
    expect(parsePartValue('0.1', 'capacitance')).toEqual({ quantity: C, si: null, notFitted: false, unitless: true });
    expect(parsePartValue('10', 'inductance')).toEqual({ quantity: L, si: null, notFitted: false, unitless: true });
    expect(parsePartValue('0.1', 'resistance')).toMatchObject({ quantity: R, si: 0.1 });
    expect(parsePartValue('0.1')).toMatchObject({ quantity: R, si: 0.1 });
  });
  it('reads a bare m as the hinted quantity', () => {
    expect(parsePartValue('10m', 'capacitance')).toMatchObject({ quantity: C, si: 0.01, unitless: true });
    expect(parsePartValue('10m', 'inductance')).toMatchObject({ quantity: L, si: 0.01, unitless: true });
    expect(parsePartValue('10m')).toMatchObject({ quantity: R, si: 0.01, unitless: true });
  });
  it('lets the text win over the hint when the text says what it is', () => {
    expect(parsePartValue('10K', 'capacitance')).toMatchObject({ quantity: R, si: 10000 });
    expect(parsePartValue('4.7uH', 'capacitance')).toMatchObject({ quantity: L, si: 4.7e-6 });
    expect(parsePartValue('100nF', 'resistance')).toMatchObject({ quantity: C, si: 1e-7 });
    expect(parsePartValue('600R@100MHz', 'inductance')).toMatchObject({ quantity: Z, si: 600, frequencyHz: 1e8 });
  });
  it('accepts null and undefined hints', () => {
    const hints: Array<ValueHint | null | undefined> = [undefined, null];
    for (const hint of hints) expect(parsePartValue('4K7', hint)).toMatchObject({ quantity: R, si: 4700 });
  });
});

describe('parsePartValue: robustness', () => {
  it('returns the empty result for text that is not a string', () => {
    for (const value of [undefined, null, 5, {}, []] as unknown[]) expect(parsePartValue(value as string)).toEqual({ quantity: null, si: null, notFitted: false });
  });
  it('treats non-breaking and unusual spaces as spaces', () => {
    expect(parsePartValue('10 k')).toMatchObject({ quantity: R, si: 10000 });
    expect(parsePartValue('﻿4K7 ')).toMatchObject({ quantity: R, si: 4700 });
    expect(parsePartValue('10K　DNP')).toMatchObject({ quantity: R, si: 10000, notFitted: true });
  });
  it('does not mistake a unit for a marker or a marker for a unit', () => {
    expect(parsePartValue('100 nF')).toMatchObject({ quantity: C, notFitted: false });
    expect(parsePartValue('100nF')).toMatchObject({ notFitted: false });
    expect(parsePartValue('nF').notFitted).toBe(true);
    expect(parsePartValue('NC 10K')).toMatchObject({ quantity: R, notFitted: true });
    expect(parsePartValue('OPEN 10K').notFitted).toBe(false);
  });
  it('never throws and keeps its invariants on random text', () => {
    let seed = 0x2545f491;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    const alphabet = ['0', '1', '2', '4', '7', '9', '.', ',', ' ', '/', '@', '%', '-', '+', '(', ')', '_', 'R', 'E', 'K', 'M', 'm', 'k', 'u', 'U', 'n', 'N', 'p', 'P', 'F', 'H', 'V', 'A', 'G', 'z', 'N', 'C', 'D', 'O', 'Ω', 'µ', '±', 'meg', 'ohm', 'DNP', 'NC', 'OPEN'];
    const quantities = new Set<string | null>([null, R, C, L, Z, V, I]);
    for (let n = 0; n < 20_000; n++) {
      const text = Array.from({ length: Math.floor(random() * 14) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
      const value = parsePartValue(text);
      expect(quantities.has(value.quantity), text).toBe(true);
      expect(typeof value.notFitted, text).toBe('boolean');
      if (value.si !== null) { expect(Number.isFinite(value.si), text).toBe(true); expect(value.quantity, text).not.toBeNull(); }
      if (value.quantity === null) expect(value.si, text).toBeNull();
      if (value.quantity === Z) expect(value.frequencyHz, text).toBeGreaterThan(0);
      else expect(value.frequencyHz, text).toBeUndefined();
      if (value.quantity === R || value.quantity === C || value.quantity === L) expect(value.si === null || value.si >= 0, text).toBe(true);
      if (value.tolerance !== undefined) expect(value.tolerance, text).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('parsePartValue: linear time on pathological text', () => {
  it('reads 200,000 characters of every shape that could make a backtracking reader quadratic', () => {
    const shapes: Array<[string, (count: number) => string]> = [
      ['one long digit run', count => '0'.repeat(count)],
      ['digit run and a unit', count => '9'.repeat(count) + 'k'],
      ['digits with decimal points', count => '1.'.repeat(count / 2)],
      ['digits with decimal commas', count => '1,'.repeat(count / 2)],
      ['comma digit groups', count => '12,5'.repeat(count / 4)],
      ['numbers apart', count => '1 '.repeat(count / 2)],
      ['numbers and unit words apart', count => '1 k '.repeat(count / 4)],
      ['numbers and units to be joined', count => '10 u H '.repeat(count / 7)],
      ['letters only', count => 'K'.repeat(count)],
      ['leading R codes', count => 'R'.repeat(count)],
      ['the same IEC code, no break', count => '4K7'.repeat(count / 3)],
      ['the same IEC code, with blanks', count => '4K7 '.repeat(count / 4)],
      ['spaces', count => ' '.repeat(count)],
      ['signs', count => '-'.repeat(count)],
      ['signs before digits', count => '+1'.repeat(count / 2)],
      ['signs and decimal points', count => '-.'.repeat(count / 2)],
      ['frequency separators', count => '600R@'.repeat(count / 5)],
      ['impedance repeats', count => '600R/100M '.repeat(count / 10)],
      ['slashes', count => '/'.repeat(count)],
      ['at signs', count => '@'.repeat(count)],
      ['markers', count => 'NC '.repeat(count / 3)],
      ['marker phrases', count => 'DO NOT '.repeat(count / 7)],
      ['N slash C', count => 'N/C'.repeat(count / 3)],
      ['unit words', count => 'nF '.repeat(count / 3)],
      ['percent', count => '5%'.repeat(count / 2)],
      ['percent apart', count => '5 % '.repeat(count / 4)],
      ['brackets', count => '('.repeat(count)],
      ['mixed units', count => '1 ohm 2 uF 3 mH '.repeat(count / 16)],
      ['dots', count => '.'.repeat(count)],
      ['a marker at the very end', count => 'x'.repeat(count) + ' DNP'],
      ['a value at the very end', count => 'x'.repeat(count) + ' 4K7'],
    ];
    // Ascending sizes: a reader that retries every position of a run needs seconds at 200,000 characters, so a regression fails at the first pair.
    for (const [label, text] of shapes) expectScaling(label, [1000, 40_000, 200_000], count => { const input = text(count); return () => parsePartValue(input); });
    for (const count of [1000, 40_000, 200_000]) for (const [label, text] of shapes) expect(typeof parsePartValue(text(count)).notFitted, `${count}: ${label}`).toBe('boolean');
  });
  it('still reads the value or marker at the end of a very long text', () => {
    const long = 'x'.repeat(200_000);
    expect(parsePartValue(`${long} DNP`)).toMatchObject({ notFitted: true });
    expect(parsePartValue(`${long} 4K7`)).toMatchObject({ quantity: R, si: 4700 });
    expect(parsePartValue(`4K7 ${long}`)).toMatchObject({ quantity: R, si: 4700 });
    expect(parsePartValue(long)).toEqual({ quantity: null, si: null, notFitted: false });
  });
  it('rejects an over-long number instead of reading a prefix of it', () => {
    expect(parsePartValue('9'.repeat(200_000) + 'k').quantity).toBeNull();
    expect(parsePartValue('0'.repeat(65) + '1').quantity).toBeNull();
    expect(parsePartValue('1' + '0'.repeat(40) + 'k')).toMatchObject({ quantity: R, si: 1e43 });
    expect(parsePartValue('1' + '0'.repeat(40)).quantity).toBeNull(); // a bare integer of more than eight digits is a part number
    expect(parsePartValue('0'.repeat(40) + '1').quantity).toBeNull(); // a leading-zero run of three or more digits is a package size
  });
});
