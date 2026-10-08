import { describe, expect, it } from 'vitest';
import { MAX_TOKEN_LENGTH, type RecognitionScope } from './chars';
import { DEFAULT_TOKEN_LIMIT, TOKEN_CLASSES, classifyToken, countTokenClasses, tokenizeText, trimToken, type TokenClass } from './tokens';

type Row = [token: string, cls: TokenClass, reason?: string];

const REFDES: Row[] = [
  ...['U1', 'U7000', 'U100', 'U7000A', 'R1', 'R12', 'R123', 'R1234', 'C1', 'C100', 'C5001', 'C5001A', 'L1', 'L100', 'D1', 'D300', 'Q1', 'Q5000', 'J1', 'J4100', 'P1', 'FB1', 'FB301', 'TP1', 'TP500',
    'SW1', 'X1', 'Y1', 'F1', 'IC1', 'PU3', 'PC12', 'PR5', 'PL2', 'PQ9', 'PD1', 'PJ4', 'CN1', 'JP1', 'LED1', 'RN1', 'RP4', 'VR1', 'ZD1', 'BT1', 'K1', 'T1', 'H1', 'M1', 'LS1', 'EC1', 'FL1', 'R100', 'C100', 'U12345']
    .map((token): Row => [token, 'refdes', 'refdes']),
];

const NETS: Row[] = [
  ...['GND', 'AGND', 'DGND', 'PGND', 'VSS', 'GND1', 'GND_PLANE', 'PP3V3_S0', 'PP5V_S5', 'PP1V8_S3', 'PP1V05_S0', 'PPVCORE_S0', '+3V3', '+5V', '+12V', '-12V', '+3.3V', '+1V8', 'VCC', 'VDD', 'VBAT', 'VBUS', 'VSYS', 'VIN', 'DCIN',
    'VCC_3V3', 'VDD_CORE', 'VCCIO', '5VSB', '3V3_AUX', 'USB_VBUS'].map((token): Row => [token, 'net']),
  ...['3V3', '1V8', '5V0', '1V05', '2V5'].map((token): Row => [token, 'net', 'rail-voltage']),
  ...['PCH_PWROK', 'CLK_100M', 'SMB_CLK', 'DDR_CKE', 'PCIE_TX0', 'PPBUS_G3H', 'SLP_S3_L', 'BATT_PRES_N', 'EC_RSMRST_N', 'LCD_BKLT_EN'].map((token): Row => [token, 'net', 'net-name']),
  ...['RESET#', 'PWRBTN#', 'SLP_S3#', 'PLTRST#', '/RESET', '/CLK', '/PWRGD'].map((token): Row => [token, 'net', 'active-low']),
  ...['GPIO12', 'USB3', 'DDR4', 'HDMI1', 'I2C1', 'SPI0', 'UART2', 'PCIE0', 'SATA1', 'ADC0', 'PA5', 'PB3', 'PE12', 'GPU1', 'CC1', 'CC2', 'SBU1', 'DP0', 'RX1', 'TX1', 'SDA1', 'SCL0', 'PCI2', 'LVDS1', 'EDP0'].map((token): Row => [token, 'net', 'signal-label']),
];

const PARTS: Row[] = [
  ...['TPS51225RUKR', 'TPS51225', 'LM358', 'LM358DR', '2N7002', 'W25Q128JVSQ', 'ISL95857HRTZ', 'IT8987E-128', 'BQ24780SRUYR', 'PM8998', 'ALC269', 'RTL8111H', 'MX25L6406E', 'AO3400A', 'BSS138', '1N4148',
    'SN74LVC1G08DBVR', '74HC595', 'STM32F407VGT6', 'MT41K256M16HA-125', 'RK3399', 'CD3217B12', 'FUSB302BMPX', 'TPD4E004', 'TL431', 'LM1117', 'AMS1117', 'MBR0520', 'BC847B', 'ESP32-S3', 'W25Q64FVSSIG'].map((token): Row => [token, 'part-number', 'known-part']),
  ...['XYZ-1234-AB', 'MC74HC595ADG', 'ADS1115IDGSR', 'XC7A35T-1FGG484C', 'CY8C4245AXI-483', 'ZZ99PLURAL-AB', 'QWERTY-1234', 'ABC-123-XYZ-99'].map((token): Row => [token, 'part-number', 'part-like']),
];

const VALUES: Row[] = [
  ...['4K7', '10K', '100K', '1M', '0R', '0R05', '2R2', '100R', '47K', '4.7K', '100nF', '0.1uF', '10uF', '22pF', '4n7', '2u2', '1uH', '2.2uH', '600R@100MHz', '120R/100M', '1A', '500mA', 'R005', 'R010', '100NF', '10UF',
    '22UF/16V', '1K5', '3K3', '1R', '4.7UH', '1MEG', '220R'].map((token): Row => [token, 'value', 'value']),
  ...['50V', '16V', '6.3V', '25V', '35V'].map((token): Row => [token, 'value', 'value']),
];

const PACKAGES: Row[] = [
  ...['0402', '0603', '0805', '1206', '0201', '1210', '1005', '2512'].map((token): Row => [token, 'package', 'package-size']),
  ...['SOT-23', 'SOT23', 'SOT-23-5', 'SOT-223', 'SOT-89', 'SC-70', 'SOD-123', 'SOD-323', 'QFN32', 'QFN-32', 'VQFN-48', 'TQFP-100', 'LQFP-48', 'TSSOP-16', 'SOIC-8', 'MSOP-8', 'BGA256', 'WLCSP-12', 'DFN2020-6',
    'DPAK', 'D2PAK', 'SMA', 'SMB', 'SMC', 'TO-220', 'TO-252', 'TO92', 'DIP-8', 'PLCC-44', 'LGA1151', 'QFN-32-5X5'].map((token): Row => [token, 'package', 'package-name']),
];

const BOARD_NUMBERS: Row[] = [
  ...['820-01234', '820-3115', 'LA-Z123P', 'NM-A481', 'DA0ZZ1MB6E0', '6050A2999901', 'BA41-01234A', '109-Z12345-00', '48.4ZZ01.011', 'la-z123p', '820_01234'].map((token): Row => [token, 'board-number', 'board-number']),
];

const NOISE: Row[] = [
  ...['hello', 'Resistor', 'voltage', 'Notes', 'the', 'and', 'Title', 'Drawn', 'Approved', 'Date', 'Sheet', 'of'].map((token): Row => [token, 'noise', 'word']),
  ...['SHEET', 'PAGE', 'OF', 'THE', 'AND', 'NOTES', 'REV', 'DATE', 'TITLE', 'DRAWN', 'APPROVED', 'MLB', 'DOCUMENT'].map((token): Row => [token, 'noise', 'word']),
  ...['1', '12', '100', '12345', '0', '00', '999', '12345678', '123456789012'].map((token): Row => [token, 'noise', 'number']),
  ...['2024-10-07', '07.10.2024', '10/07/2024', '20241007', '2024.10.07', '31.12.1999', '1/2/2024', '07.10.24'].map((token): Row => [token, 'noise', 'date']),
  ...['3/12', '12/40', '1/2', '99/100'].map((token): Row => [token, 'noise', 'page-number']),
  ...['SHEET3', 'PAGE12', 'SHT2', 'SHEET10'].map((token): Row => [token, 'noise', 'page-number']),
  ...['DNP', 'DNI', 'NF', 'NC', 'N/C', 'DNS', 'NOSTUFF', 'OPEN'].map((token): Row => [token, 'noise', 'marker']),
  ...['---', '...', '###', '@@', '&&', '__', '//'].map((token): Row => [token, 'noise', 'no-alnum']),
  ['', 'noise', 'empty'],
  ['A'.repeat(MAX_TOKEN_LENGTH + 1), 'noise', 'too-long'],
  ['PP3V3_S0_'.repeat(20), 'noise', 'too-long'],
  ['x'.repeat(5000), 'noise', 'too-long'],
  ...['u7000', 'tps51225', 'pp3v3s0', 'lm358dr', 'q1a2'].map((token): Row => [token, 'noise', 'lowercase']),
  ...['gnd', 'vcc', 'r', 'ab'].map((token): Row => [token, 'noise', 'word']),
];

const ALL: Row[] = [...REFDES, ...NETS, ...PARTS, ...VALUES, ...PACKAGES, ...BOARD_NUMBERS, ...NOISE];

describe('token classes: a table of tokens', () => {
  it('has at least two hundred and fifty tokens', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(250);
  });
  it('covers every class', () => {
    const covered = new Set(ALL.map(([, cls]) => cls));
    for (const cls of TOKEN_CLASSES) expect(covered.has(cls), cls).toBe(true);
  });
  it.each(ALL.map(([token, cls, reason]) => [token.length > 40 ? `${token.slice(0, 12)}...(${token.length})` : token, token, cls, reason] as [string, string, TokenClass, string | undefined]))('%j', (_label, token, cls, reason) => {
    const result = classifyToken(token);
    expect(result.class).toBe(cls);
    if (reason !== undefined) expect(result.reason).toBe(reason);
    expect(result.confidence).toBeGreaterThanOrEqual(1);
    expect(result.confidence).toBeLessThanOrEqual(99);
    expect(result.text.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);
  });
});

describe('token classes: details by class', () => {
  it('gives known part numbers a family, a base and a category', () => {
    const result = classifyToken('TPS51225RUKR');
    expect(result).toMatchObject({ class: 'part-number', partTier: 'known', family: 'ti-tps5122x', base: 'TPS51225', category: 'pmic', text: 'TPS51225RUKR' });
    expect(classifyToken('LM358DR')).toMatchObject({ category: 'opamp-comparator', base: 'LM358' });
    expect(classifyToken('MT41K256M16HA-125')).toMatchObject({ category: 'dram', family: 'micron-mt41k' });
    expect(classifyToken('MT41K256M16HA-125').base).toBeUndefined();
  });
  it('marks a part number that only looks like one as text', () => {
    expect(classifyToken('XYZ-1234-AB')).toMatchObject({ class: 'part-number', partTier: 'text', reason: 'part-like' });
    expect(classifyToken('XYZ-1234-AB').family).toBeUndefined();
  });
  it('gives rails their voltage and kind', () => {
    expect(classifyToken('PP3V3_S0')).toMatchObject({ class: 'net', netKind: 'power', volts: 3.3, reason: 'rail' });
    expect(classifyToken('+5V')).toMatchObject({ netKind: 'power', volts: 5, reason: 'rail-voltage' });
    expect(classifyToken('-12V')).toMatchObject({ netKind: 'power', volts: -12 });
    expect(classifyToken('3V3')).toMatchObject({ netKind: 'power', volts: 3.3 });
    expect(classifyToken('GND')).toMatchObject({ netKind: 'ground', reason: 'ground' });
    expect(classifyToken('PCH_PWROK')).toMatchObject({ netKind: 'signal' });
  });
  it('gives board numbers their shape and normal form', () => {
    expect(classifyToken('820-01234')).toMatchObject({ class: 'board-number', shape: 'logic-board-820', normalized: '820-01234' });
    expect(classifyToken('la-z123p')).toMatchObject({ class: 'board-number', shape: 'la-code', normalized: 'LA-Z123P' });
    expect(classifyToken('820-01234').confidence).toBe(75);
    expect(classifyToken('820-01234', { scope: 'title-block' }).confidence).toBe(85);
  });
  it('reads a value that is not a bare number as a value and a bare number as noise', () => {
    expect(classifyToken('4K7').class).toBe('value');
    expect(classifyToken('100').class).toBe('noise');
    expect(classifyToken('0.01').class).toBe('noise');
    expect(classifyToken('50V').confidence).toBe(50);
    expect(classifyToken('4K7').confidence).toBe(80);
  });
  it('rates a reference designator by its prefix', () => {
    expect(classifyToken('U7000').confidence).toBe(90);
    expect(classifyToken('R12').confidence).toBe(90);
    expect(classifyToken('ABCD12345').confidence).toBe(55);
    expect(classifyToken('ABCD12345').class).toBe('refdes');
  });
});

describe('token classes: the scope decides which board numbers are read', () => {
  const rows: Array<[token: string, scope: RecognitionScope, cls: TokenClass]> = [
    ['MS-17Z9', 'body', 'part-number'], ['MS-17Z9', 'title-block', 'board-number'], ['MS-17Z9', 'name', 'board-number'], ['MS-17Z9', 'schematic', 'board-number'], ['MS-17Z9', 'ocr', 'board-number'],
    ['CN-0ZZ123', 'body', 'part-number'], ['CN-0ZZ123', 'title-block', 'board-number'], ['051-9876', 'body', 'noise'], ['820-3115', 'body', 'board-number'], ['051-9876', 'title-block', 'board-number'],
    ['820-01234', 'body', 'board-number'], ['820-01234', 'ocr', 'board-number'], ['A1706', 'body', 'refdes'], ['A1706', 'title-block', 'refdes'], ['A1706', 'name', 'refdes'],
    ['LA-Z123P', 'body', 'board-number'], ['SM-G991B', 'body', 'part-number'], ['SM-G991B', 'header', 'board-number'],
  ];
  it.each(rows)('%s in %s is %s', (token, scope, cls) => {
    expect(classifyToken(token, { scope }).class).toBe(cls);
  });
});

describe('token classes: page and sheet numbers need their word', () => {
  const rows: Array<[token: string, previous: string | undefined, cls: TokenClass, reason: string]> = [
    ['12', 'SHEET', 'noise', 'page-number'], ['3', 'PAGE', 'noise', 'page-number'], ['A3', 'SHEET', 'noise', 'page-number'], ['12', 'OF', 'noise', 'page-number'], ['5', 'PG', 'noise', 'page-number'],
    ['2', 'SH', 'noise', 'page-number'], ['7', 'SHT', 'noise', 'page-number'], ['12', 'P', 'noise', 'page-number'], ['3', 'NO', 'noise', 'page-number'],
    ['12', undefined, 'noise', 'number'], ['12', 'U7000', 'noise', 'number'], ['U7000', 'SHEET', 'refdes', 'refdes'], ['TPS51225', 'PAGE', 'part-number', 'known-part'], ['4K7', 'SHEET', 'noise', 'page-number'],
    ['C12', 'PAGE', 'noise', 'page-number'], ['C12', 'VALUE', 'refdes', 'refdes'], ['12', 'RESISTOR', 'noise', 'number'],
  ];
  it.each(rows)('%s after %s', (token, previous, cls, reason) => {
    const result = classifyToken(token, { previous });
    expect([result.class, result.reason]).toEqual([cls, reason]);
  });
});

describe('token classes: trimming and odd input', () => {
  const rows: Array<[string, string]> = [
    ['(U7000)', 'U7000'], ['[U7000]', 'U7000'], ['"U7000"', 'U7000'], ["'U7000'", 'U7000'], ['U7000,', 'U7000'], ['U7000;', 'U7000'], ['U7000:', 'U7000'], ['U7000.', 'U7000'], ['..U7000', 'U7000'], ['<U7000>', 'U7000'],
    ['TPS51225RUKR.', 'TPS51225RUKR'], ['*GND*', 'GND'], ['U7000-', 'U7000'], ['U7000_', 'U7000'],
  ];
  it.each(rows)('trims %j to %j', (raw, expected) => {
    expect(trimToken(raw)).toBe(expected);
    expect(classifyToken(raw).text).toBe(expected);
  });
  it('keeps the marks of a net or a rail', () => {
    expect(trimToken('+5V')).toBe('+5V');
    expect(trimToken('-12V')).toBe('-12V');
    expect(trimToken('/RESET')).toBe('/RESET');
    expect(trimToken('RESET#')).toBe('RESET#');
  });
  it('gives noise for input that is not text', () => {
    for (const value of [undefined, null, 5, {}, [], Symbol('x')] as unknown[]) expect(classifyToken(value as string).class).toBe('noise');
  });
  it('treats upper and lower case alike for values, board numbers and nets with an underscore', () => {
    expect(classifyToken('4k7').class).toBe('value');
    expect(classifyToken('100nf').class).toBe('value');
    expect(classifyToken('la-z123p').class).toBe('board-number');
    expect(classifyToken('pch_pwrok').class).toBe('net');
  });
});

describe('token classes: whole texts', () => {
  const sample = 'Sheet 3 of 12  U7000 TPS51225RUKR PP3V3_S0 4K7 100nF SOT-23-5 820-01234 hello 2024-10-07 DNP';
  it('classifies each token of a text, with spans', () => {
    const { tokens, truncated } = tokenizeText(sample);
    expect(truncated).toBe(false);
    expect(tokens.map(token => [token.raw, token.class])).toEqual([
      ['Sheet', 'noise'], ['3', 'noise'], ['of', 'noise'], ['12', 'noise'], ['U7000', 'refdes'], ['TPS51225RUKR', 'part-number'], ['PP3V3_S0', 'net'], ['4K7', 'value'], ['100nF', 'value'],
      ['SOT-23-5', 'package'], ['820-01234', 'board-number'], ['hello', 'noise'], ['2024-10-07', 'noise'], ['DNP', 'noise'],
    ]);
    for (const token of tokens) expect(sample.slice(token.start, token.end)).toBe(token.raw);
    expect(tokens.find(token => token.raw === '3')?.reason).toBe('page-number');
    expect(tokens.find(token => token.raw === '12')?.reason).toBe('page-number');
  });
  it('counts the classes', () => {
    const counts = countTokenClasses(tokenizeText(sample).tokens);
    expect(counts).toEqual({ refdes: 1, net: 1, 'part-number': 1, value: 2, package: 1, 'board-number': 1, noise: 7 });
  });
  it('splits a title block line', () => {
    const { tokens } = tokenizeText('TITLE: MAIN BOARD  DWG NO 820-01234-A  REV: A  SHEET 5 OF 60  DATE 2024-10-07');
    expect(tokens.filter(token => token.class === 'board-number').map(token => token.raw)).toEqual(['820-01234-A']);
    expect(tokens.filter(token => token.reason === 'page-number').map(token => token.raw)).toEqual(['5', '60']);
    expect(tokens.filter(token => token.reason === 'date').map(token => token.raw)).toEqual(['2024-10-07']);
  });
  it('reads units and the micro and ohm signs as part of a value', () => {
    const { tokens } = tokenizeText('4.7kΩ 10µF 22μH 0Ω');
    expect(tokens.map(token => [token.raw, token.class])).toEqual([['4.7kΩ', 'value'], ['10µF', 'value'], ['22μH', 'value'], ['0Ω', 'value']]);
  });
  it('stops at the token limit and says so', () => {
    const text = Array.from({ length: DEFAULT_TOKEN_LIMIT + 50 }, () => 'R1').join(' ');
    const result = tokenizeText(text);
    expect(result.truncated).toBe(true);
    expect(result.tokens).toHaveLength(DEFAULT_TOKEN_LIMIT);
    expect(tokenizeText(text, { limit: 10 }).tokens).toHaveLength(10);
    expect(tokenizeText(text, { limit: 10 }).truncated).toBe(true);
    expect(tokenizeText('R1 R2', { limit: 10 }).truncated).toBe(false);
  });
  it('skips a very long run without copying it', () => {
    const result = tokenizeText(`U1 ${'x'.repeat(50000)} U2`);
    expect(result.tokens.map(token => token.class)).toEqual(['refdes', 'noise', 'refdes']);
    expect(result.tokens[1].raw).toBe('');
    expect(result.tokens[1].reason).toBe('too-long');
  });
  it('gives nothing for empty or non-text input', () => {
    expect(tokenizeText('').tokens).toEqual([]);
    for (const value of [undefined, null, 5, {}] as unknown[]) expect(tokenizeText(value as string)).toEqual({ tokens: [], truncated: false });
  });
});

describe('token classes: work is counted per character', () => {
  it('counts a bounded number of steps per character', () => {
    const meter = { steps: 0 };
    const text = 'U7000 TPS51225RUKR PP3V3_S0 4K7 100nF SOT-23-5 820-01234 hello 2024-10-07 DNP '.repeat(50);
    tokenizeText(text, { meter });
    expect(meter.steps).toBeGreaterThan(0);
    expect(meter.steps).toBeLessThanOrEqual(40 * text.length);
  });
});
