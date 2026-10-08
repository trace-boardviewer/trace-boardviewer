import { describe, expect, it } from 'vitest';
import { buildBoard, textInput } from './formats/common';
import {
  DEFAULT_GROUND_PATTERNS, GROUND_FALLBACK_SHARE, classifyBoardNets, classifyNetName, classifyNets, createGroundMatcher, expectedVoltageFromName, isGroundName, isNoConnectName,
} from './net-class';
import { expectScaling } from '../test-support/timing';

describe('ground names', () => {
  it('lists the default patterns', () => {
    expect([...DEFAULT_GROUND_PATTERNS]).toEqual([
      'GND', 'GROUND', 'GND#', 'AGND', 'DGND', 'PGND', 'SGND', 'CGND', 'GNDA', 'GNDD', 'VSS', 'VSSA', 'VSSD', 'AVSS', 'DVSS', '0V', 'CHASSIS_GND', 'GND_*', '*_GND',
    ]);
    expect(GROUND_FALLBACK_SHARE).toBe(0.15);
  });
  const ground = ['GND', 'gnd', 'Gnd', 'AGND', 'DGND', 'PGND', 'SGND', 'GNDA', 'GNDD', 'VSS', 'vss', '0V', '0v', 'GND_USB', 'GND_1', 'gnd_shield', 'GND_', 'USB_GND', 'SHIELD_GND',
    'A_GND', '_GND', 'ANA_GND', ' GND ', '/GND', '/power/GND', '/Sheet1/Sub/AGND', '/p/GND_X', '/p/USB_GND', 'GND_5V', 'GND_GND',
    // GROUND, GND and a number, the analogue and digital supply returns, the case and chassis grounds
    'GROUND', 'Ground', 'ground', 'GND1', 'GND2', 'gnd3', 'Gnd9', 'GND10', 'GND12', 'GND007', ' GND4 ', '/power/GND2', '/Sheet1/Sub/gnd12', 'CGND', 'cgnd', '/io/CGND',
    'VSSA', 'VSSD', 'vssa', 'Vssd', 'AVSS', 'DVSS', 'avss', 'dvss', '/analog/AVSS', 'CHASSIS_GND', 'chassis_gnd', 'Chassis_Gnd', '/io/CHASSIS_GND'];
  const other = ['GNDX', 'VSS1', 'AGND1', 'PGND2', 'GNDGND', 'NOGND', 'G ND', '+5V', '5V', 'VCC', 'SDA', 'NC', '', ' ', '/', '/power/', 'GN', 'ND', '0V5', 'V0V', 'EGND',
    // digits count only at the end of GND, and only for GND itself; no other name is guessed
    'GND1X', 'GND1_X', 'GND-1', 'GND 1', 'GND#', 'G1ND', '1GND', 'GNDA1', 'GROUND1', 'GROUNDED', 'CGND1', 'VSSA1', 'AVSS2', 'DVSS3', 'DVSSA', 'AVSSA', 'CHASSIS', 'CHASSIS_GND1', 'CHASSIS_GROUND', 'CHASSISGND', 'SGND1', 'GNDD2'];
  it.each(ground)('%j is ground', name => { expect(isGroundName(name)).toBe(true); });
  it.each(other)('%j is not ground', name => { expect(isGroundName(name)).toBe(false); });
  it('classifies the ground names as ground, never as power or signal', () => {
    for (const name of ['GROUND', 'GND1', 'GND12', 'CGND', 'VSSA', 'VSSD', 'AVSS', 'DVSS', 'CHASSIS_GND']) expect(classifyNetName(name), name).toEqual({ kind: 'ground', groundBasis: 'name' });
  });

  it('takes a configurable list (case-insensitive, trimmed, * for any run and a trailing # for the digits at the end)', () => {
    const custom = ['signal_ground', ' Earth ', 'GNDX*', '*CHASSIS*', 'A*B*C'];
    for (const name of ['SIGNAL_GROUND', 'signal_ground', 'EARTH', 'earth', 'GNDX', 'GNDX_1', 'gndxyz', 'CHASSIS', 'MY_CHASSIS_1', 'ABC', 'A1B2C', 'a_b_c', '/sub/EARTH']) expect(isGroundName(name, custom), name).toBe(true);
    // The defaults do not leak into a custom list.
    for (const name of ['GND', 'AGND', 'VSS', 'GND_1', 'AB', 'ACB', 'SIGNAL_GROUND_2', 'EARTH2']) expect(isGroundName(name, custom), name).toBe(false);
    expect(isGroundName('GND', [])).toBe(false);
    expect(isGroundName('GND', ['GND'])).toBe(true);
  });
  it('reads a trailing # as the run of digits at the end of a name: one digit or more, after whatever the rest of the pattern matches', () => {
    const matches = createGroundMatcher([' earth# ', '*_rtn#', 'A#B', 'RET_*_#']);
    for (const name of ['EARTH1', 'earth02', 'Earth123456', '/sub/EARTH7', 'SIG_RTN3', 'x_rtn10', 'A#B', 'RET_X_1', 'RET__22']) expect(matches(name), name).toBe(true);
    // No digit, a digit before the end, the stem alone, '#' itself and a '#' in the middle are no match (a middle '#' stands for itself).
    for (const name of ['EARTH', 'EARTH1X', 'EARTH_1', 'EART1', 'SIG_RTN', 'SIG_RTN3X', 'RTN3', 'A1B', 'A#', 'AB', 'RET_X_', 'RET_X1', '5', '#', 'EARTH#']) expect(matches(name), name).toBe(false);
    // The digits are the whole run at the end: a stem that itself ends in a digit is not reached by shortening the run.
    expect(createGroundMatcher(['A1#'])('A12')).toBe(false);
    expect(createGroundMatcher(['A1#'])('A1')).toBe(false);
    // A name is never ground by digits alone, and a bare # or a star with a # is no pattern.
    for (const pattern of ['#', '*#', '**#', ' # ']) { const bare = createGroundMatcher([pattern]); expect(bare('5'), pattern).toBe(false); expect(bare('X5'), pattern).toBe(false); expect(bare('#'), pattern).toBe(false); }
    // The default list reaches GND1 but a custom list without the pattern does not.
    expect(isGroundName('GND1')).toBe(true);
    expect(isGroundName('GND1', ['GND'])).toBe(false);
    expect(isGroundName('GND1', ['GND#'])).toBe(true);
    expect(isGroundName('GND', ['GND#'])).toBe(false);
  });
  it('ignores empty, over-long and bare-wildcard patterns, and a list that is not an array', () => {
    const matches = createGroundMatcher(['', '   ', '*', '***', 'X'.repeat(200) + '*', 'GND']);
    expect(matches('GND')).toBe(true);
    expect(matches('ANYTHING')).toBe(false);
    expect(matches('X'.repeat(210))).toBe(false);
    expect(createGroundMatcher(undefined as unknown as string[])('GND')).toBe(true);
    expect(createGroundMatcher(null as unknown as string[])('AGND')).toBe(true);
    expect(createGroundMatcher([5 as unknown as string, 'GND'])('GND')).toBe(true);
  });
  it('treats * as any run of characters, including none, and anchors both ends', () => {
    const matches = createGroundMatcher(['A*B', '*C', 'D*', 'E*F*G']);
    for (const name of ['AB', 'AxB', 'AxxxB', 'C', 'xC', 'D', 'Dx', 'EFG', 'ExFxG', 'EFxG', 'ExFG']) expect(matches(name), name).toBe(true);
    for (const name of ['A', 'B', 'BA', 'ABx', 'xAB', 'Cx', 'xD', 'EF', 'EG', 'FG', 'GFE', 'EFGx']) expect(matches(name), name).toBe(false);
  });
  it('is not fooled by names that only look like patterns', () => {
    expect(isGroundName('GND*')).toBe(false);
    expect(isGroundName('*_GND_')).toBe(false);
    expect(isGroundName('GND_*')).toBe(true); // the text GND_* itself starts with GND_
  });
  it('does not classify non-string input as ground', () => {
    for (const value of [undefined, null, 5, {}] as unknown[]) expect(isGroundName(value as string)).toBe(false);
  });
});

describe('no-connect names', () => {
  it.each(['', ' ', '   ', 'NC', 'nc', 'Nc', ' NC ', 'N/C', 'n/c', 'UNCONNECTED', 'unconnected', 'UNCONNECTED1', 'UNCONNECTED12', 'UNCONNECTED<5>', 'UNCONNECTED(3)', 'UNCONNECTED_7', 'UNCONNECTED-5',
    'unconnected-(R1-Pad2)', 'Unconnected-(U1-NC)_1'])('%j is no-connect', name => { expect(isNoConnectName(name)).toBe(true); });
  it.each(['N', 'N/', 'NC1', 'NC_1', 'N.C.', 'NCX', 'UNCONNECTEDLY', 'UNCONNECTE', 'UNCONNECTED+', 'MY_UNCONNECTED', 'GND', 'N/C/', 'NET1'])('%j is a real name', name => { expect(isNoConnectName(name)).toBe(false); });
  it('does not classify non-string input as no-connect', () => {
    for (const value of [undefined, null, 5] as unknown[]) expect(isNoConnectName(value as string)).toBe(false);
  });
});

describe('expected voltage from the name (a hint, never a reading)', () => {
  const volts: Array<[string, number]> = [
    ['PP3V3_S5', 3.3], ['PP5V_S0', 5], ['PP1V8_S2', 1.8], ['PP1V05_S0', 1.05], ['PP0V9_SOC', 0.9], ['PP12V_G3H', 12], ['PP3V3_S5_AWAKE', 3.3], ['PP3V3-S5', 3.3],
    ['+5V', 5], ['+3V3', 3.3], ['+3.3V', 3.3], ['+1V8', 1.8], ['+12V', 12], ['-12V', -12], ['-5V', -5], ['+5V0', 5], ['VEE_-5V', -5],
    ['5V', 5], ['3V3', 3.3], ['1V8', 1.8], ['12V', 12], ['1V2', 1.2], ['1V05', 1.05], ['24V', 24], ['48V', 48], ['19V', 19], ['3.3V', 3.3], ['1.8V', 1.8], ['5V0', 5], ['0V9', 0.9],
    ['VCC_1V8', 1.8], ['VDD_3V3', 3.3], ['VCC3V3', 3.3], ['VDD1V8', 1.8], ['AVDD_1V8', 1.8], ['VCC_3.3V', 3.3], ['VOUT_3V3', 3.3], ['VCC_5V_USB', 5],
    ['3V3_AUX', 3.3], ['3V3A', 3.3], ['5VSB', 5], ['5V_STBY', 5], ['USB_5V', 5], ['VBUS_5V', 5], ['DDR_1V2', 1.2], ['DDR4_1V2', 1.2], ['LDO_OUT_1V8', 1.8], ['3V3_S0', 3.3], ['1V', 1],
    ['3P3V', 3.3], ['V3P3', 3.3], ['V1P8', 1.8], ['/power/+3V3', 3.3], ['/Sheet1/3V3', 3.3], ['/Sheet1/Sub/PP5V_S0', 5], ['5v', 5], ['pp3v3_s5', 3.3], ['3V3_3V3', 3.3],
  ];
  it.each(volts)('%j suggests %f V', (name, expected) => {
    expect(expectedVoltageFromName(name)).toEqual({ volts: expected, source: 'net-name' });
  });
  const none = ['', 'GND', 'VCC', 'VDD', 'SDA', 'I2C_SDA', 'NET1', 'USB3V3', 'DATA3V3', 'A3V3B', 'U3V3', 'V5', 'V12', '12', '3.3', '3V3EN', '3V3S5', '5V_EN', 'PP3V3_S5_EN', 'VCC_1V8_PG', 'PP3V3_PGOOD',
    '3V3_FB', '1V8_SW', '3V3_5V', '5V_TO_3V3', '0V', '0V0', '1000V', '0V1', 'DDR4', '+', '-', 'PP', 'V', 'VBAT', 'VDD33', 'VCC18', '2PP3V3', 'X5V', 'Net-(IC7-5V_EN)', '~{OTG_5V_DET}', '5V_PHASE', '5V_COMP', '5V_MODE', '5V_SS', '5V_FSW', '5V_BOOT', 'FAN_TACH_5V', 'FAN_PMW_5V', '/Display/TMDS_SDA_5V0', 'TMDS_SCL_5V0', '3V3_SDA', 'USB_TX_3V3', 'PP3V3_S5_RESET', '1V8_FAULT'];
  it.each(none)('%j suggests nothing', name => { expect(expectedVoltageFromName(name)).toBeNull(); });
  it('is typed as a hint with its source', () => {
    const hint = expectedVoltageFromName('PP3V3_S5');
    expect(hint).not.toBeNull();
    expect(Object.keys(hint!).sort()).toEqual(['source', 'volts']);
    expect(hint!.source).toBe('net-name');
  });
  it('ignores non-string input and very long names', () => {
    for (const value of [undefined, null, 5] as unknown[]) expect(expectedVoltageFromName(value as string)).toBeNull();
    expect(expectedVoltageFromName('3V3_' + 'X'.repeat(2000))).toBeNull();
    expect(expectedVoltageFromName('3V3_' + 'X'.repeat(500))).toEqual({ volts: 3.3, source: 'net-name' });
  });
});

describe('classifyNetName', () => {
  it('orders no-connect, ground, power, signal', () => {
    expect(classifyNetName('')).toEqual({ kind: 'no-connect' });
    expect(classifyNetName('NC')).toEqual({ kind: 'no-connect' });
    expect(classifyNetName('unconnected-(R1-Pad2)')).toEqual({ kind: 'no-connect' });
    expect(classifyNetName('GND')).toEqual({ kind: 'ground', groundBasis: 'name' });
    expect(classifyNetName('0V')).toEqual({ kind: 'ground', groundBasis: 'name' }); // not a 0 V rail
    expect(classifyNetName('GND_5V')).toEqual({ kind: 'ground', groundBasis: 'name' });
    expect(classifyNetName('+5V')).toEqual({ kind: 'power', expectedVoltage: { volts: 5, source: 'net-name' } });
    expect(classifyNetName('PP3V3_S5')).toEqual({ kind: 'power', expectedVoltage: { volts: 3.3, source: 'net-name' } });
    expect(classifyNetName('SDA')).toEqual({ kind: 'signal' });
    expect(classifyNetName('3V3_EN')).toEqual({ kind: 'signal' });
  });
  it('knows rail words that carry no voltage', () => {
    for (const name of ['VCC', 'VDD', 'VBAT', 'VBUS', 'USB_VBUS', 'VIN', 'DCIN', 'VSYS', 'VDD_CORE', 'vcc', 'AVDD', 'DVDD', 'VEE']) expect(classifyNetName(name), name).toEqual({ kind: 'power' });
    for (const name of ['VBUS_DET', 'VIN_SENSE', 'VCC_EN', 'VDD_PG', 'VCCQ', 'VBATT_FB', 'DATA', 'Net-(IC7-VBUS_DET)', '~{OTG_USB_VBUS_DET}', '5V_PHASE', 'VCC_SDA', 'VDD_TACH']) expect(classifyNetName(name).kind, name).toBe('signal');
    for (const name of ['USBVCC', 'BT_PAVDD', 'PAVDD', 'XVDD', 'MY_VBAT', 'USBVBUS']) expect(classifyNetName(name), name).toEqual({ kind: 'power' });
    for (const name of ['VCC', 'VDDX', 'VCCQ', 'SVCCX', 'VBU']) expect(classifyNetName(name).kind === 'power', name).toBe(name === 'VCC');
  });
  it('uses the given ground patterns', () => {
    expect(classifyNetName('EARTH', { groundPatterns: ['EARTH'] })).toEqual({ kind: 'ground', groundBasis: 'name' });
    expect(classifyNetName('GND', { groundPatterns: ['EARTH'] })).toEqual({ kind: 'signal' });
  });
  it('returns frozen results', () => {
    expect(Object.isFrozen(classifyNetName('GND'))).toBe(true);
    expect(Object.isFrozen(classifyNetName('+5V'))).toBe(true);
    expect(Object.isFrozen(classifyNetName('+5V').expectedVoltage)).toBe(true);
  });
});

const nets = (...entries: Array<[string, number]>) => entries.map(([name, pinCount]) => ({ name, pinCount }));

describe('classifyNets: ground by name and the largest-net fallback', () => {
  it('classifies every net and lists all ground nets found by name', () => {
    const result = classifyNets(nets(['GND', 40], ['AGND', 10], ['+3V3', 20], ['SDA', 3], ['NC', 1], ['VBUS', 4]), 100);
    expect(result.groundBasis).toBe('name');
    expect(result.groundNets).toEqual(['GND', 'AGND']);
    expect([...result.byName].map(([name, net]) => [name, net.kind])).toEqual([['GND', 'ground'], ['AGND', 'ground'], ['+3V3', 'power'], ['SDA', 'signal'], ['NC', 'no-connect'], ['VBUS', 'power']]);
  });
  it('falls back to the largest net when it holds more than 15 % of all pins', () => {
    const result = classifyNets(nets(['EARTH', 20], ['A', 8], ['B', 8], ['+3V3', 30]), 100);
    expect(result.groundBasis).toBe('largest-net');
    expect(result.groundNets).toEqual(['EARTH']);
    expect(result.byName.get('EARTH')).toEqual({ kind: 'ground', groundBasis: 'largest-net' });
    expect(result.byName.get('+3V3')?.kind).toBe('power');
  });
  it('needs strictly more than the share, a single largest net and a positive pin total', () => {
    expect(classifyNets(nets(['G', 15], ['A', 5]), 100).groundBasis).toBe('none'); // exactly 15 %
    expect(classifyNets(nets(['G', 16], ['A', 5]), 100).groundBasis).toBe('largest-net');
    expect(classifyNets(nets(['G', 20], ['H', 20]), 100).groundNets).toEqual([]); // tied
    expect(classifyNets(nets(['G', 20], ['H', 19]), 100).groundNets).toEqual(['G']);
    expect(classifyNets(nets(['G', 20]), 0).groundBasis).toBe('none');
    expect(classifyNets(nets(['G', 20]), -5).groundBasis).toBe('none');
    expect(classifyNets([], 100)).toMatchObject({ groundNets: [], groundBasis: 'none' });
  });
  it('never takes a name match away from the fallback order: a named ground suppresses the fallback', () => {
    const result = classifyNets(nets(['GND', 1], ['BIG', 60]), 100);
    expect(result.groundNets).toEqual(['GND']);
    expect(result.byName.get('BIG')).toEqual({ kind: 'signal' });
  });
  it('skips power rails and no-connects as fallback candidates', () => {
    expect(classifyNets(nets(['+3V3', 40], ['NC', 30], ['A', 10]), 100).groundBasis).toBe('none');
    expect(classifyNets(nets(['+3V3', 40], ['NC', 30], ['A', 16]), 100).groundNets).toEqual(['A']);
    expect(classifyNets(nets(['VCC', 40], ['A', 5]), 100).groundBasis).toBe('none');
  });
  it('takes the share as an option', () => {
    expect(classifyNets(nets(['G', 30], ['A', 5]), 100, { fallbackShare: 0.5 }).groundBasis).toBe('none');
    expect(classifyNets(nets(['G', 60], ['A', 5]), 100, { fallbackShare: 0.5 }).groundBasis).toBe('largest-net');
    expect(classifyNets(nets(['G', 90]), 100, { fallbackShare: Infinity }).groundBasis).toBe('none');
    expect(classifyNets(nets(['G', 3]), 100, { fallbackShare: 0 }).groundBasis).toBe('largest-net');
  });
  it('uses custom patterns for ground by name', () => {
    const result = classifyNets(nets(['EARTH', 3], ['GND', 50]), 100, { groundPatterns: ['EARTH'] });
    expect(result.groundNets).toEqual(['EARTH']);
    expect(result.groundBasis).toBe('name');
    expect(result.byName.get('GND')).toEqual({ kind: 'signal' });
  });
  it('classOf answers for nets that are not in the list, never with the fallback', () => {
    const result = classifyNets(nets(['EARTH', 40], ['A', 5]), 100);
    expect(result.classOf('EARTH')).toEqual({ kind: 'ground', groundBasis: 'largest-net' });
    expect(result.classOf('')).toEqual({ kind: 'no-connect' });
    expect(result.classOf('GND')).toEqual({ kind: 'ground', groundBasis: 'name' });
    expect(result.classOf('+5V').kind).toBe('power');
    expect(result.classOf('A')).toEqual({ kind: 'signal' });
    expect(result.classOf('NOT_ON_THE_BOARD')).toEqual({ kind: 'signal' });
  });
  it('accepts any iterable', () => {
    const result = classifyNets(new Set([{ name: 'GND', pinCount: 4 }]), 10);
    expect(result.groundNets).toEqual(['GND']);
  });
});

describe('classifyBoardNets', () => {
  const board = (rows: Array<[ref: string, number: string, net: string]>) => {
    const refs = [...new Set(rows.map(row => row[0]))];
    return buildBoard(textInput('', 'synthetic.board'), {
      format: 'synthetic', unitsToMm: 1,
      parts: refs.map(ref => ({ key: ref, ref, side: 'top' as const, position: { x: refs.indexOf(ref) * 10, y: 0 } })),
      pins: rows.map(([part, number, net], index) => ({ part, number, net, x: index, y: 0 })),
      outline: [{ x: -5, y: -5 }, { x: 200, y: -5 }, { x: 200, y: 20 }, { x: -5, y: 20 }],
    });
  };
  it('counts pins per net from the board and uses all pins as the denominator', () => {
    const synthetic = board([['U1', '1', 'GND'], ['U1', '2', '+3V3'], ['U1', '3', 'SDA'], ['R1', '1', 'SDA'], ['R1', '2', ''], ['C1', '1', 'GND'], ['C1', '2', '+3V3']]);
    const result = classifyBoardNets(synthetic);
    expect(result.groundNets).toEqual(['GND']);
    expect(result.groundBasis).toBe('name');
    expect(result.classOf('+3V3')).toEqual({ kind: 'power', expectedVoltage: { volts: 3.3, source: 'net-name' } });
    expect(result.classOf('SDA')).toEqual({ kind: 'signal' });
    expect(result.classOf('')).toEqual({ kind: 'no-connect' });
  });
  it('falls back to the biggest net of a board whose ground has an unusual name', () => {
    const rows: Array<[string, string, string]> = [];
    for (let pin = 1; pin <= 6; pin++) rows.push(['J1', String(pin), 'EARTHING']);
    for (let pin = 1; pin <= 4; pin++) rows.push(['U1', String(pin), `S${pin}`]);
    for (let pin = 1; pin <= 10; pin++) rows.push(['U2', String(pin), '']);
    const result = classifyBoardNets(board(rows));
    expect(result.groundBasis).toBe('largest-net');
    expect(result.groundNets).toEqual(['EARTHING']);
    // 6 of 20 pins is 30 %; with a stricter share it is not ground.
    expect(classifyBoardNets(board(rows), { fallbackShare: 0.4 }).groundBasis).toBe('none');
  });
});

describe('linear time', () => {
  it('classifies 200,000-character names and adversarial patterns without slowing down', () => {
    const stars = createGroundMatcher(['A*A*A*A*A*A*A*A*A*A*A*A*B', '*' + 'AAAB*'.repeat(25)]);
    const shapes: Array<[string, (count: number) => string]> = [
      ['G', count => 'G'.repeat(count)], ['GND_ prefix', count => 'GND_' + 'X'.repeat(count)], ['_GND suffix', count => 'X'.repeat(count) + '_GND'], ['3V3_ prefix', count => '3V3_' + 'X'.repeat(count)],
      ['5V repeated', count => '5V'.repeat(count / 2)], ['digits', count => '1'.repeat(count)], ['V', count => 'V'.repeat(count)], ['P', count => 'P'.repeat(count)], ['slashes', count => '/'.repeat(count)],
      ['plus signs', count => '+'.repeat(count)], ['3V3_ repeated', count => '3V3_'.repeat(count / 4)], ['UNCONNECTED prefix', count => 'UNCONNECTED' + '1'.repeat(count)], ['spaces', count => ' '.repeat(count)],
      ['A', count => 'A'.repeat(count)], ['3. repeated', count => '3.'.repeat(count / 2)],
    ];
    // A pattern that retries every position of a run is quadratic: 16 times the time for 4 times the characters.
    for (const [label, name] of shapes) {
      expectScaling(label, [1000, 40_000, 200_000], count => { const text = name(count); return () => [isGroundName(text), isNoConnectName(text), expectedVoltageFromName(text), classifyNetName(text), stars(text)]; });
    }
    // Names that nearly match a many-segment pattern: a matcher that tries every split of the stars grows with a power of the length.
    expectScaling('nearly matching names', [250, 500, 1000, 2000], length => { const text = 'A'.repeat(length) + 'C'; return () => stars(text); });
  });
  it('classifies 100,000 nets in linear time', () => {
    const netList = (count: number) => Array.from({ length: count }, (_, index) => ({ name: index % 50 === 0 ? `PP${3 + index % 3}V3_S${index % 5}_${index}` : `NET_${index}_SIGNAL_NAME`, pinCount: 2 }));
    expectScaling('classifying nets', [25_000, 100_000], count => { const list = netList(count); return () => classifyNets(list, 200_000); });
    expect(classifyNets(netList(100_000), 200_000).byName.size).toBe(100_000);
  });
});
