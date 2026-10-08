import { describe, expect, it } from 'vitest';
import { BOARD_NUMBER_SHAPES, boardNumberShape, scopeAllows } from './board-number-shapes';
import { bestBoardNumber, confidenceBand, recognizeBoardNumbers } from './board-numbers';
import { MAX_MATCHES, RECOGNITION_SCOPES, type RecognitionScope } from './chars';

// All numbers below are invented: they follow the published layout of a shape and carry made-up digits.

type Sample = [raw: string, normalized: string, revision?: string, loose?: true];

/** Per shape: written forms and what they must normalise to. */
const SAMPLES: Readonly<Record<string, Sample[]>> = {
  'logic-board-820': [['820-01234', '820-01234'], ['820-3115', '820-3115'], ['820-00875-A', '820-00875', 'A'], ['820_02021', '820-02021', undefined, true], ['820 00239', '820-00239', undefined, true], ['820-2536-B', '820-2536', 'B'], ['820-00001_C', '820-00001', 'C']],
  'schematic-051': [['051-9876', '051-9876'], ['051-02345', '051-02345'], ['051_7654', '051-7654', undefined, true], ['051 12345', '051-12345', undefined, true]],
  'la-code': [['LA-Z123P', 'LA-Z123P'], ['LA-C281P', 'LA-C281P'], ['LA_9911P', 'LA-9911P', undefined, true], ['la-e841p', 'LA-E841P'], ['LA-A9B1P', 'LA-A9B1P']],
  'la-code-nop': [['LA-1234', 'LA-1234'], ['LA-C128', 'LA-C128'], ['LA-7B77', 'LA-7B77'], ['la-9x90', 'LA-9X90']],
  'nm-code': [['NM-A123', 'NM-A123'], ['NM-B481', 'NM-B481'], ['NM_C291', 'NM-C291', undefined, true], ['nm-d051', 'NM-D051']],
  'da0-code': [['DA0ZZ1MB6E0', 'DA0ZZ1MB6E0'], ['DA0X83MB6D0', 'DA0X83MB6D0'], ['DA0ABCMB8F0', 'DA0ABCMB8F0'], ['da0q91mb6c0', 'DA0Q91MB6C0']],
  'da0-sub': [['DA0ZZ1HB6E0', 'DA0ZZ1HB6E0'], ['DA0X83AB6D0', 'DA0X83AB6D0'], ['DA0ABCTB8F0', 'DA0ABCTB8F0']],
  'dotted-48': [['48.4ZZ01.011', '48.4ZZ01.011'], ['48.4YE02.021', '48.4YE02.021'], ['55.3AB01.0D1', '55.3AB01.0D1'], ['48.4qq01.0011', '48.4QQ01.0011']],
  'inventec-6050a': [['6050A2999901', '6050A2999901'], ['6050A2423701-MB-A02', '6050A2423701', 'A02'], ['6050A2370101-MB-A01', '6050A2370101', 'A01'], ['6050a2111101', '6050A2111101']],
  'ms-code': [['MS-17Z9', 'MS-17Z9'], ['MS-7C02', 'MS-7C02'], ['MS-16R1', 'MS-16R1'], ['MS-17B30', 'MS-17B30'], ['ms_14c3', 'MS-14C3', undefined, true]],
  'samsung-ba': [['BA41-01234A', 'BA41-01234A'], ['BA92-12345A', 'BA92-12345A'], ['BA59-03722', 'BA59-03722'], ['BA94_00123B', 'BA94-00123B', undefined, true], ['ba41-09999a', 'BA41-09999A']],
  'samsung-bn': [['BN44-00123A', 'BN44-00123A'], ['BN41-02345', 'BN41-02345'], ['BN94-12345B', 'BN94-12345B']],
  'amd-109': [['109-Z12345-00', '109-Z12345-00'], ['109-C88531-01', '109-C88531-01'], ['109 A12345-00', '109-A12345-00', undefined, true]],
  'nvidia-699': [['699-1Z123-0123-456', '699-1Z123-0123-456'], ['600-1G145-0502-200', '600-1G145-0502-200']],
  'cn-dell': [['CN-0ZZ123', 'CN-0ZZ123'], ['CN-0A1B2C', 'CN-0A1B2C'], ['TW-0X7Y9Z', 'TW-0X7Y9Z'], ['mx-0q9w8e', 'MX-0Q9W8E']],
  'model-sm': [['SM-Z999F', 'SM-Z999F'], ['SM-G991B', 'SM-G991B'], ['SM-A525F', 'SM-A525F'], ['SM-S908U1', 'SM-S908U1'], ['sm-t870n', 'SM-T870N']],
  'model-gt': [['GT-Z9999', 'GT-Z9999'], ['GT-I9300', 'GT-I9300'], ['GT-N7100A', 'GT-N7100A']],
  'generic-mb': [['MB-ZQ12', 'MB-ZQ12'], ['M/B-AB1234', 'M/B-AB1234'], ['MAINBOARD_XY99', 'MAINBOARD-XY99', undefined, true]],
  'asus-60n': [['60NB0ZZ0-MB1201', '60NB0ZZ0-MB1201'], ['60NB0AB0-MB1710', '60NB0AB0-MB1710']],
  'lenovo-fru': [['5B20Z12345', '5B20Z12345'], ['5B21A98765', '5B21A98765']],
  'hp-spare': [['L12345-601', 'L12345-601'], ['N98765-001', 'N98765-001'], ['P24362-601', 'P24362-601']],
  'sony-console': [['CUH-1234A', 'CUH-1234A'], ['CFI-1000A', 'CFI-1000A'], ['CECH-2001A', 'CECH-2001A'], ['SCPH-1000', 'SCPH-1000']],
};

/** Texts around a number. The number must be found at the same place whatever stands around it. */
const WRAPS: ReadonlyArray<[name: string, wrap: (raw: string) => string]> = [
  ['alone', raw => raw],
  ['with an extension', raw => `${raw}.brd`],
  ['in a sentence', raw => `Main board ${raw} final`],
  ['before a document word', raw => `${raw}_schematic.pdf`],
  ['in brackets', raw => `(${raw})`],
  ['after a folder', raw => `Repair/${raw}`],
  ['after a dash', raw => `Model-X ${raw}`],
];

describe('board numbers: every shape in several written forms', () => {
  const cases: Array<[string, string, string, string, string | undefined, boolean]> = [];
  for (const [shape, samples] of Object.entries(SAMPLES)) {
    for (const [raw, , revision, loose] of samples) {
      for (const [wrapName, wrap] of WRAPS) cases.push([`${shape} ${raw} ${wrapName}`, shape, raw, wrap(raw), revision, loose === true]);
    }
  }
  const expectedNormal = new Map<string, string>();
  for (const [shape, samples] of Object.entries(SAMPLES)) for (const [raw, normalized] of samples) expectedNormal.set(`${shape}|${raw}`, normalized);

  it('has at least two hundred written forms', () => {
    expect(cases.length).toBeGreaterThanOrEqual(200);
  });

  it.each(cases)('%s', (_title, shape, raw, text, revision, loose) => {
    const matches = recognizeBoardNumbers(text, { scope: 'name' });
    expect(matches).toHaveLength(1);
    const [match] = matches;
    expect(match.shape).toBe(shape);
    expect(match.normalized).toBe(expectedNormal.get(`${shape}|${raw}`));
    expect(match.raw).toBe(raw);
    expect(text.slice(match.start, match.end)).toBe(raw);
    expect(match.revision).toBe(revision);
    expect(match.loose).toBe(loose);
    expect(match.confidence).toBeGreaterThanOrEqual(1);
    expect(match.confidence).toBeLessThanOrEqual(99);
  });

  it('covers every shape of the table', () => {
    expect(Object.keys(SAMPLES).filter(id => !BOARD_NUMBER_SHAPES.some(shape => shape.id === id))).toEqual([]);
    expect(BOARD_NUMBER_SHAPES.map(shape => shape.id).filter(id => !(id in SAMPLES) && id !== 'model-a4')).toEqual([]);
  });
});

describe('board numbers: the Apple model number needs a device word', () => {
  const positive: Array<[string, string]> = [
    ['MacBook Pro A1706', 'A1706'], ['MacBook Air A2337 820-02016', 'A2337'], ['iPhone A2111', 'A2111'], ['A1990 laptop', 'A1990'], ['iPad A2200', 'A2200'],
    ['notebook A1534', 'A1534'], ['Apple A1707', 'A1707'], ['tablet A1893', 'A1893'], ['phone_A2341', 'A2341'], ['mac a1466 board', 'A1466'],
  ];
  it.each(positive)('reads %s', (text, normalized) => {
    const found = recognizeBoardNumbers(text).filter(match => match.shape === 'model-a4');
    expect(found.map(match => match.normalized)).toEqual([normalized]);
  });
  const negative = ['A1706', 'A1706 board', 'U7000 A1706', 'resistor A1234', 'see A2001', 'A12345', 'A123', 'XA1706 laptop', 'A1706A laptop', 'laptop A17066'];
  it.each(negative)('does not read %s', text => {
    expect(recognizeBoardNumbers(text).filter(match => match.shape === 'model-a4')).toEqual([]);
  });
  it('is never read in a title block, a header or running text', () => {
    for (const scope of ['title-block', 'header', 'body', 'schematic', 'ocr', 'pdf-metadata', 'outline'] as RecognitionScope[]) {
      expect(recognizeBoardNumbers('MacBook A1706', { scope }).filter(match => match.shape === 'model-a4')).toEqual([]);
    }
    for (const scope of ['name', 'folder', 'archive'] as RecognitionScope[]) {
      expect(recognizeBoardNumbers('MacBook A1706', { scope }).filter(match => match.shape === 'model-a4')).toHaveLength(1);
    }
  });
});

describe('board numbers: text that is not a board number', () => {
  const groups: Record<string, string[]> = {
    'reference designators': ['U7000', 'R12', 'C5001A', 'FB301', 'Q1', 'L2', 'D3', 'J1', 'TP5', 'PU3', 'PC1', 'PL2', 'U7000 U7100 R5', 'C1234 C1235', 'NM1', 'LA1', 'MS1', 'BA41'],
    'page and sheet numbers': ['page 12', 'p. 12', 'Sheet 3 of 12', 'sheet 12', '12/40', '3/12', 'Page 1 of 120', 'pg 5', 'SHEET 051 OF 120', 'Seite 3 von 12'],
    dates: ['2024-10-07', '07.10.2024', '10/07/2024', '20241007', '2024.10.07', '07-10-24', 'Oct 2024', '2019_10_07', '2024-10-07T12:00', 'Created 2023-05-17'],
    'part numbers': ['TPS51225', 'LM358', 'ISL95857', 'W25Q128', 'AO3400', '74HC595', 'SN74LVC1G08', 'STM32F103', 'BQ24780S', 'MX25L6406E', 'TPS51225RUKR', '1N4148', '2N7002', 'BSS138', 'IT8987E', 'NCT6791D', 'RTL8111H', 'ALC269', 'CS42L51', 'PM8998', 'MT41K256M16', 'KLMAG1JETD', 'H5TC4G63CFR'],
    'phone-like': ['+36 30 123 4567', '+1 555-051-9876', 'tel 051-9876', 'Tel: 820-01234', 'fax 051-9876', 'call 820-01234', '(555) 051-9876', '555-051-9876', '555.051.9876', '+820-01234', '+36 1 820-01234', 'phone: 051-9876', 'GSM 820 01234', '1-800-051-9876', 'hotline 051-1234'],
    'a digit group continues': ['820-01234-56', '051-9876-12', '820-01234.5', '051-9876.2', '820-01234-2024', '820-01234-10-07'],
    'a year after a blank': ['820 2019', '051 1999', '820_2024', '051 2030'],
    'not standing alone': ['X820-01234', '820-012345', '1820-01234', 'AB051-9876', 'LA-Z123PX', 'NM-A1234', 'NM-AB123', 'DA0ZZ1MB6E00', 'BA41-012345', 'SM-Z9999F', '109-Z12345-000', '6050A29999012', 'CN-0ZZ1234', 'MS-17Z9XYZ', 'xLA-Z123P', 'NM-A123x', '820-0123456', '820-012'],
    'incomplete shapes': ['laptop', 'mainboard', 'MB', 'mb-1', 'M/B', 'LA', 'NM', 'DA0', 'BA41', '820', '051', '109', 'CN', 'LA-', 'NM-A', 'DA0ZZ1MB', '6050A', '6050A123', 'SM-', 'SM-G99', 'GT-I93', '60NB0', '5B20', 'CUH-12', 'L12345', 'L12345-60'],
    'wrong letters or digits': ['NM-123A', 'NM-1234', 'LA-ABCD', 'LA-ABCDP', 'DA0ZZ1AA6E0X', 'MS-ABCD', 'MS-1AB', 'CN-0123456', 'CN-0ABCDE', 'XX-0ZZ123', 'SM-12345', 'SM-GG991B', 'BA11-01234A', 'BA41-0123A', '109-123456-00', '109-Z1234-00', '6050B2999901', '60NB1ZZ0-MB1201', 'MB-1234', 'MB-ABCD', 'MB-AB', 'hp-12345-601', 'L12345-6011'],
    'running text': ['The board was repaired yesterday', 'Please see section 8.2 for details', 'Rev A of the document', 'Total 1.2.3.4', 'IP address 192.168.0.1', 'version 2.5.1', 'The quick brown fox 123', 'A-1234-B', 'ISBN 978-3-16-148410-0', 'WGS84 48.4 11.2'],
    'empty or junk': ['', ' ', '---', '....', '____', '\u0000', '\n\n', '№', '🙂', '820-', '-820-', '.820.', '[]'],
  };
  const cases: Array<[string, string]> = [];
  for (const [group, texts] of Object.entries(groups)) for (const text of texts) cases.push([group, text]);
  it('has at least one hundred and twenty negatives', () => {
    expect(cases.length).toBeGreaterThanOrEqual(120);
  });
  it.each(cases)('%s: %j gives nothing', (_group, text) => {
    const matches = recognizeBoardNumbers(text, { scope: 'name' });
    expect(matches.map(match => `${match.shape} ${match.raw}`)).toEqual([]);
  });
  it('reads nothing inside a long alphanumeric run', () => {
    expect(recognizeBoardNumbers(`${'a'.repeat(3000)}820-01234`)).toEqual([]);
    expect(recognizeBoardNumbers(`820-01234${'a'.repeat(3000)}`)).toEqual([]);
  });
  it('gives an empty array for input that is not text', () => {
    for (const value of [undefined, null, 5, {}, [], Symbol('x'), () => 1] as unknown[]) expect(recognizeBoardNumbers(value as string)).toEqual([]);
  });
});

describe('board numbers: normal forms and spelling variants', () => {
  const rows: Array<[string, string, string]> = [
    ['８２０－０１２３４', 'logic-board-820', '820-01234'],
    ['820‐01234', 'logic-board-820', '820-01234'],
    ['820‑01234', 'logic-board-820', '820-01234'],
    ['820‒01234', 'logic-board-820', '820-01234'],
    ['820–01234', 'logic-board-820', '820-01234'],
    ['820—01234', 'logic-board-820', '820-01234'],
    ['820−01234', 'logic-board-820', '820-01234'],
    [' 820-01234 ', 'logic-board-820', '820-01234'],
    ['\t820-01234\n', 'logic-board-820', '820-01234'],
    ['ＬＡ－Ｚ１２３Ｐ', 'la-code', 'LA-Z123P'],
    ['la-z123p', 'la-code', 'LA-Z123P'],
    ['La-Z123p', 'la-code', 'LA-Z123P'],
    ['sm-g991b', 'model-sm', 'SM-G991B'],
    ['Da0Zz1Mb6E0', 'da0-code', 'DA0ZZ1MB6E0'],
    ['ba41‑01234a', 'samsung-ba', 'BA41-01234A'],
    ['[820-01234]', 'logic-board-820', '820-01234'],
    ['{051-9876}', 'schematic-051', '051-9876'],
    ['"NM-B481"', 'nm-code', 'NM-B481'],
    ['<LA-C281P>', 'la-code', 'LA-C281P'],
    ['820-01234;', 'logic-board-820', '820-01234'],
    ['820-01234,', 'logic-board-820', '820-01234'],
    ['820-01234:', 'logic-board-820', '820-01234'],
    ['820-01234!', 'logic-board-820', '820-01234'],
    ['820-01234?', 'logic-board-820', '820-01234'],
    ['820-01234/', 'logic-board-820', '820-01234'],
    ['820-01234 ', 'logic-board-820', '820-01234'],
  ];
  it.each(rows)('%j reads as %s %s', (text, shape, normalized) => {
    const matches = recognizeBoardNumbers(text);
    expect(matches.map(match => [match.shape, match.normalized])).toEqual([[shape, normalized]]);
  });
});

describe('board numbers: several numbers in one text', () => {
  it('returns each number once, in text order', () => {
    const text = 'MacBook Pro 820-00875-A 051-9876 and LA-Z123P';
    const found = recognizeBoardNumbers(text);
    expect(found.map(match => match.normalized)).toEqual(['820-00875', '051-9876', 'LA-Z123P']);
    expect(found.map(match => match.start)).toEqual([...found.map(match => match.start)].sort((a, b) => a - b));
  });
  it('keeps numbers that repeat', () => {
    expect(recognizeBoardNumbers('820-01234 820-01234 820-01234')).toHaveLength(3);
  });
  it('separates two numbers by a slash, a comma or a plus', () => {
    for (const glue of ['/', ',', ' + ', ' & ', ' _ ', ' ; ', ' | ']) {
      const found = recognizeBoardNumbers(`820-01234${glue}051-9876`);
      expect(found.map(match => match.normalized)).toEqual(['820-01234', '051-9876']);
    }
  });
  it('does not return overlapping spans', () => {
    const found = recognizeBoardNumbers('DA0ZZ1MB6E0 DA0ZZ1HB6E0 6050A2999901-MB-A02 48.4ZZ01.011 109-Z12345-00 CN-0ZZ123');
    for (let index = 1; index < found.length; index++) expect(found[index].start).toBeGreaterThanOrEqual(found[index - 1].end);
  });
  it('prefers the more confident shape when two claim the same text', () => {
    const found = recognizeBoardNumbers('DA0ZZ1MB6E0');
    expect(found.map(match => match.shape)).toEqual(['da0-code']);
  });
  it('returns at most MAX_MATCHES numbers', () => {
    const text = Array.from({ length: 2000 }, (_value, index) => `820-${String(10000 + index)}`).join(' ');
    expect(recognizeBoardNumbers(text).length).toBeLessThanOrEqual(MAX_MATCHES);
  });
});

describe('board numbers: confidence', () => {
  const at = (text: string, scope: RecognitionScope = 'name') => recognizeBoardNumbers(text, { scope })[0];
  it('starts from the base confidence of the shape', () => {
    expect(at('820-01234').confidence).toBe(85);
    expect(at('DA0ZZ1MB6E0').confidence).toBe(90);
    expect(at('LA-Z123P').confidence).toBe(85);
    expect(at('MS-17Z9').confidence).toBe(55);
    expect(at('CN-0ZZ123').confidence).toBe(55);
    expect(at('48.4ZZ01.011').confidence).toBe(60);
  });
  it('rises by five behind a label word', () => {
    for (const label of ['Board', 'PCB', 'P/N', 'DWG', 'MLB', 'Logic board', 'Schematic', 'Model', 'PN:']) {
      expect(at(`${label} 820-01234`).confidence).toBe(90);
      expect(at(`${label} 820-01234`).labelled).toBe(true);
    }
    expect(at('Photo 820-01234').labelled).toBe(false);
    expect(at('Boardwalk 820-01234').labelled).toBe(false);
  });
  it('falls by ten for a blank or an underscore in place of the dash', () => {
    expect(at('820_01234').confidence).toBe(75);
    expect(at('820 01234').confidence).toBe(75);
    expect(at('LA_Z123P').confidence).toBe(75);
  });
  it('falls in OCR text and in running text', () => {
    expect(at('820-01234', 'ocr').confidence).toBe(70);
    expect(at('820-01234', 'body').confidence).toBe(75);
    expect(at('820-01234', 'title-block').confidence).toBe(85);
    expect(at('820-01234', 'header').confidence).toBe(85);
  });
  it('stays within 1 and 99 and in a band', () => {
    for (const shape of BOARD_NUMBER_SHAPES) {
      const match = at(`Board ${shape.example}`, 'title-block') ?? at(`MacBook Board ${shape.example}`);
      expect(match, shape.id).toBeDefined();
      expect(match.confidence).toBeGreaterThanOrEqual(1);
      expect(match.confidence).toBeLessThanOrEqual(99);
    }
  });
  it('maps a score to a band', () => {
    expect(confidenceBand(99)).toBe('high');
    expect(confidenceBand(80)).toBe('high');
    expect(confidenceBand(79)).toBe('medium');
    expect(confidenceBand(55)).toBe('medium');
    expect(confidenceBand(54)).toBe('low');
    expect(confidenceBand(1)).toBe('low');
  });
  it('picks the best match', () => {
    const found = recognizeBoardNumbers('MS-17Z9 and 820-01234 and LA-1234');
    expect(bestBoardNumber(found)?.shape).toBe('logic-board-820');
    expect(bestBoardNumber([])).toBeUndefined();
  });
});

describe('board numbers: where a shape may be read', () => {
  const rows: Array<[shape: string, text: string]> = BOARD_NUMBER_SHAPES.filter(shape => !shape.needsDeviceWord).map(shape => [shape.id, `Board ${shape.example}`]);
  const read = (text: string, scope: RecognitionScope, shape: string) => recognizeBoardNumbers(text, { scope }).some(match => match.shape === shape);
  it.each(rows)('%s follows its scope group', (shape, text) => {
    const group = boardNumberShape(shape)!.scopes;
    for (const scope of RECOGNITION_SCOPES) expect(read(text, scope, shape), `${shape} in ${scope}`).toBe(scopeAllows(group, scope));
  });
  it('lets "all" shapes in every scope, "names-title" shapes in everything but running text, "names" shapes in names only', () => {
    expect(RECOGNITION_SCOPES.every(scope => scopeAllows('all', scope))).toBe(true);
    expect(RECOGNITION_SCOPES.filter(scope => scopeAllows('names-title', scope))).toEqual(RECOGNITION_SCOPES.filter(scope => scope !== 'body'));
    expect(RECOGNITION_SCOPES.filter(scope => scopeAllows('names', scope))).toEqual(['name', 'folder', 'archive']);
  });
  it('treats an unknown scope as a name', () => {
    expect(recognizeBoardNumbers('MS-17Z9', { scope: 'nonsense' as RecognitionScope })).toHaveLength(1);
  });
  it('reads the Apple 820 number in running text and the Apple 051 schematic number only in titles', () => {
    expect(recognizeBoardNumbers('see 820-01234 here', { scope: 'body' })).toHaveLength(1);
    expect(recognizeBoardNumbers('see 051-9876 here', { scope: 'body' })).toEqual([]);
    expect(recognizeBoardNumbers('see 051-9876 here', { scope: 'title-block' })).toHaveLength(1);
  });
});

describe('board numbers: the shape table', () => {
  it('has unique ids and a description for every shape', () => {
    const ids = BOARD_NUMBER_SHAPES.map(shape => shape.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const shape of BOARD_NUMBER_SHAPES) expect(shape.description.length, shape.id).toBeGreaterThan(10);
  });
  it('matches its own example and normalises it as documented', () => {
    for (const shape of BOARD_NUMBER_SHAPES) {
      const text = shape.needsDeviceWord ? `MacBook ${shape.example}` : shape.example;
      const found = recognizeBoardNumbers(text, { scope: 'name' }).filter(match => match.shape === shape.id);
      expect(found.map(match => match.normalized), shape.id).toEqual([shape.normalizedExample]);
    }
  });
  it('carries base confidences in 1..99, high ones for the distinctive shapes', () => {
    for (const shape of BOARD_NUMBER_SHAPES) {
      expect(shape.confidence).toBeGreaterThan(0);
      expect(shape.confidence).toBeLessThan(100);
    }
    for (const id of ['logic-board-820', 'la-code', 'nm-code', 'da0-code', 'inventec-6050a', 'samsung-ba']) expect(boardNumberShape(id)!.confidence, id).toBeGreaterThanOrEqual(80);
    for (const id of ['model-a4', 'generic-mb']) expect(boardNumberShape(id)!.confidence, id).toBeLessThan(55);
  });
  it('marks shapes that are conventions without a confirming public example as provisional', () => {
    for (const id of ['nvidia-699', 'asus-60n', 'lenovo-fru', 'hp-spare', 'sony-console', 'model-gt', 'da0-sub', 'samsung-bn']) expect(boardNumberShape(id)!.provisional, id).toBe(true);
    expect(recognizeBoardNumbers('hp-spare L12345-601')[0].provisional).toBe(true);
    expect(recognizeBoardNumbers('820-01234')[0].provisional).toBe(false);
  });
  it('names the vendor and device of a shape where the convention gives one', () => {
    const vendors: Array<[string, string]> = [['820-01234', 'apple'], ['LA-Z123P', 'compal'], ['NM-A123', 'lcfc'], ['DA0ZZ1MB6E0', 'quanta'], ['48.4ZZ01.011', 'wistron'], ['6050A2999901', 'inventec'], ['MS-17Z9', 'msi'], ['BA41-01234A', 'samsung'], ['109-Z12345-00', 'amd'], ['CN-0ZZ123', 'dell'], ['SM-Z999F', 'samsung']];
    for (const [text, vendor] of vendors) expect(recognizeBoardNumbers(text)[0].vendor, text).toBe(vendor);
    expect(recognizeBoardNumbers('MB-ZQ12')[0].vendor).toBeUndefined();
    expect(recognizeBoardNumbers('109-Z12345-00')[0].device).toBe('gpu');
    expect(recognizeBoardNumbers('CUH-1234A')[0].device).toBe('console');
  });
});

describe('board numbers: work is counted per character', () => {
  it('counts a bounded number of steps per character', () => {
    const meter = { steps: 0 };
    const text = 'MacBook Pro 15 820-00875-A rev B 051-9876 LA-Z123P schematic.pdf '.repeat(40);
    recognizeBoardNumbers(text, { meter });
    expect(meter.steps).toBeGreaterThan(0);
    expect(meter.steps).toBeLessThanOrEqual(24 * text.length);
  });
});
