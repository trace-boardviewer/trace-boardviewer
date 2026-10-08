import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, catalogs } from './i18n';
import { KIND_LABEL, PART_KINDS, canvasGroup, classifyComponent, classifyPart } from './part-kind';
import type { PartKind, PartKindInput } from './part-kind';
import { expectBoundedWork, expectScaling } from '../test-support/timing';

interface Extra { value?: string; pkg?: string; pins?: number; libId?: string }
type Row = readonly [ref: string, kind: PartKind, extra?: Extra];
const input = (ref: string, extra: Extra = {}): PartKindInput => ({ ref, value: extra.value, package: extra.pkg, pinCount: extra.pins, libId: extra.libId });

/** The designators and metadata the classifier must settle, grouped by what they test. References and values are made up. */
const TABLE: readonly Row[] = [
  // --- every case of the previous per-letter rule (IC was added to it by the first fix) ---
  ['IC7', 'ic'], ['IC1', 'ic'], ['IC12', 'ic'], ['ic3', 'ic'], ['Ic4', 'ic'], ['PMIC1', 'ic'], ['LIC2', 'ic'],
  ['U1', 'ic'], ['u22', 'ic'], ['MCU1', 'ic'],
  ['C1', 'capacitor'], ['C100', 'capacitor'], ['EC3', 'capacitor'], ['TC2', 'capacitor'],
  ['R1', 'resistor'], ['R0402', 'resistor'], ['L1', 'inductor'], ['FL2', 'inductor'],
  ['J1', 'connector'], ['P3', 'connector'], ['JP4', 'jumper'],
  ['D5', 'diode'], ['LED2', 'led'], ['Q1', 'transistor'], ['X1', 'crystal'], ['Y1', 'crystal'], ['F1', 'fuse'],
  ['FB1', 'ferrite'], ['S1', 'switch'], ['RV1', 'part'], ['M2', 'part'],
  ['', 'part'], ['12', 'part'], ['#PWR01', 'part'],
  // --- the designators that used to be wrong (the last letter of the prefix was read as the class) ---
  ['CN1', 'connector'], ['TP1', 'testpoint'], ['RP1', 'resistor-array'], ['MIC1', 'part'], ['OSC1', 'crystal'], ['LCD1', 'part'],
  ['SW1', 'switch'], ['TR2', 'part'], ['MIC3', 'part'], ['PCN4', 'connector'],
  // --- integrated circuits ---
  ['U12', 'ic'], ['U_MCU1', 'ic'], ['PU1', 'ic'], ['GPU1', 'ic'], ['CPU1', 'ic'], ['SOC1', 'ic'], ['FPGA1', 'ic'], ['VRAM3', 'ic'], ['DDR1', 'ic'],
  ['MPU2', 'ic'], ['NPU1', 'ic'], ['PMIC2', 'ic'], ['IC_A1', 'ic'], ['DPU3', 'ic'],
  // --- capacitors, resistors, arrays ---
  ['C12', 'capacitor'], ['PC4', 'capacitor'], ['CP1', 'capacitor'], ['CAP1', 'capacitor'], ['EC10', 'capacitor'], ['C_BULK1', 'capacitor'],
  ['R100', 'resistor'], ['PR2', 'resistor'], ['RES1', 'resistor'], ['R_FB1', 'resistor'], ['RS1', 'resistor'],
  ['RN1', 'resistor-array'], ['RA3', 'resistor-array'], ['RPACK1', 'resistor-array'], ['RNET2', 'resistor-array'], ['RP12', 'resistor-array'],
  // --- inductors and ferrite beads ---
  ['L12', 'inductor'], ['PL3', 'inductor'], ['IND1', 'inductor'], ['FL5', 'inductor'],
  ['FB2', 'ferrite'], ['FER1', 'ferrite'], ['BEAD1', 'ferrite'],
  ['L10', 'ferrite', { value: 'FB_120Z_3A_BLM18SG_0603', pkg: 'FB_0603_1608Metric' }],
  ['L3', 'ferrite', { value: '600R@100MHz' }], ['FL3', 'ferrite', { value: '120R/100M' }], ['L4', 'inductor', { value: '2.2uH' }],
  ['L6', 'inductor', { value: '2.2uH', pkg: 'L_1008_2520Metric' }],
  // --- fuses ---
  ['F2', 'fuse'], ['PF1', 'fuse'], ['FU1', 'fuse'], ['FUSE3', 'fuse'],
  // --- diodes and LEDs ---
  ['D12', 'diode'], ['PD1', 'diode'], ['ZD2', 'diode'], ['DZ1', 'diode'], ['BR1', 'diode'], ['TVS1', 'diode'],
  ['D1', 'led', { pkg: 'LED_0603_1608Metric' }], ['D7', 'led', { value: 'LED' }], ['D8', 'diode', { value: 'BAT43', pkg: 'D_DO-35_SOD27' }],
  ['ESD3', 'diode', { pkg: 'SOT-23', pins: 3 }], ['LED7', 'led'], ['LD1', 'led'],
  // --- transistors (T and TR mean a transistor or a transformer) ---
  ['Q12', 'transistor'], ['PQ3', 'transistor'], ['FET1', 'transistor'], ['MOSFET2', 'transistor'],
  ['T1', 'transistor', { value: 'BSS138PW', pkg: 'SC70-3', pins: 3 }], ['TR2', 'transistor', { pkg: 'SOT-23', pins: 3 }],
  ['TR5', 'transistor', { pins: 3 }], ['T4', 'part', { value: 'Transformer 1:1' }], ['T7', 'ic', { pkg: 'SOIC-8', pins: 8 }],
  ['T9', 'part', { pins: 4 }], ['Q4', 'transistor', { pkg: 'SOT-23', pins: 3 }],
  // --- crystals and oscillators ---
  ['X2', 'crystal'], ['Y2', 'crystal'], ['XTAL1', 'crystal'], ['XTL1', 'crystal'], ['XT1', 'crystal'], ['XO1', 'crystal'], ['CRYSTAL1', 'crystal'], ['OSC2', 'crystal'],
  // --- connectors ---
  ['J12', 'connector'], ['P12', 'connector'], ['CN12', 'connector'], ['CON3', 'connector'], ['CONN2', 'connector'], ['CONNECTOR1', 'connector'],
  ['JK1', 'connector'], ['JACK2', 'connector'], ['HDR1', 'connector'], ['HEADER1', 'connector'], ['SOCKET1', 'connector'], ['SKT1', 'connector'],
  ['RJ1', 'connector'], ['PJ1', 'connector'], ['PJP2', 'connector'], ['AJ1', 'connector'], ['USB1', 'connector'], ['ACN1', 'connector'],
  ['LCON2', 'connector'], ['J_USB1', 'connector'], ['H5', 'connector', { pkg: 'PinHeader_1x04_P2.54mm' }], ['H6', 'mechanical'],
  ['J3', 'jumper', { pkg: 'SolderJumper-2_P1.3mm_Open' }], ['LCD2', 'connector', { pkg: 'FPC_40P_0.5mm' }],
  // --- test points ---
  ['TP12', 'testpoint'], ['PP5', 'testpoint'], ['TPT1', 'testpoint'], ['TEST1', 'testpoint'], ['TESTPOINT2', 'testpoint'], ['TP_5V1', 'testpoint'],
  ['X7', 'testpoint', { pkg: 'TestPoint_Pad_1.5x1.5mm' }], ['PAD1', 'testpoint', { pins: 1, pkg: 'PAD.03X.05' }], ['W1', 'testpoint', { value: 'TP', pins: 1 }],
  // --- switches ---
  ['S2', 'switch'], ['BTN1', 'switch'], ['BUTTON1', 'switch'], ['PB1', 'switch'], ['SWITCH1', 'switch'],
  ['REC1', 'switch', { value: 'SW_TL3340AF160QG_SMD', pins: 5 }], ['KEY1', 'part'], ['USR1', 'switch', { pkg: 'SW_Push_SPST' }],
  // --- jumpers and headers (JP is decided by the pad count) ---
  ['JP1', 'jumper', { pins: 2 }], ['JP2', 'jumper', { pins: 3 }], ['JP3', 'connector', { pins: 6 }], ['JP6', 'connector', { pins: 4 }],
  ['JMP1', 'jumper'], ['JUMPER2', 'jumper'], ['SJ1', 'jumper'], ['LK1', 'jumper'],
  // --- mechanical parts (the package or value outranks a designator that says connector) ---
  ['MH1', 'mechanical'], ['H1', 'mechanical'], ['HOLE2', 'mechanical'], ['MTG3', 'mechanical'], ['FID1', 'mechanical'], ['FIDUCIAL1', 'mechanical'],
  ['SP5', 'mechanical'], ['STANDOFF1', 'mechanical'], ['SCREW1', 'mechanical'], ['NUT1', 'mechanical'], ['HS1', 'mechanical'], ['HEATSINK1', 'mechanical'],
  ['SH1', 'mechanical'], ['SHIELD2', 'mechanical'], ['LOGO1', 'mechanical'], ['FRAME2', 'mechanical'], ['MECH1', 'mechanical'],
  ['P101', 'mechanical', { value: 'CONN_1', pkg: 'MountingHole_4.3mm_M4', pins: 1 }], ['JP5', 'mechanical', { value: 'STAND-OFF', pkg: 'STAND-OFF', pins: 0 }],
  ['N1', 'mechanical', { value: 'brand_logo', pkg: 'brand-logo' }], ['kibuzzard-63D93CC5', 'mechanical', { value: 'G***', pins: 0 }],
  ['U$16', 'mechanical', { value: 'OSHW-LOGOS', pkg: 'OSHW-LOGO-S', pins: 0 }], ['M5', 'mechanical', { pkg: 'Mounting hole 3mm' }],
  ['R9', 'mechanical', { pkg: 'Fiducial_1mm_Mask2mm' }],
  ['AB11', 'mechanical', { pkg: 'Mounting-Hole_3mm' }], ['AB12', 'mechanical', { pkg: 'Spacer_Drill3.7mm_H6mm' }], ['AB13', 'mechanical', { value: 'Heat Sink 20mm' }],
  ['AB14', 'testpoint', { pkg: 'Test Point Pad' }],
  // A connector whose footprint name mentions mounting holes is still a connector (whole words only).
  ['J1', 'connector', { value: 'DB9-FEMALE', pkg: 'DSUB-9_Female_Horizontal_P2.77x2.84mm_EdgePinOffset7.70mm_Housed_MountingHolesOffset9.12mm', pins: 11 }],
  ['AB15', 'part', { pkg: 'DIRECTO92_STUDIO', pins: 2 }],
  // --- known to be none of the electrical classes ---
  ['RV2', 'part'], ['VR1', 'part'], ['POT1', 'part'], ['RT1', 'part'], ['TH1', 'part'], ['NTC1', 'part'], ['PTC1', 'part'], ['BT1', 'part'],
  ['BAT1', 'part'], ['BATT1', 'part'], ['K1', 'part'], ['RLY1', 'part'], ['M3', 'part'], ['SPK1', 'part'], ['BZ1', 'part'], ['BUZ1', 'part'],
  ['LS1', 'part'], ['ANT1', 'part'], ['MIC4', 'part', { pkg: 'LGA-4' }],
  // --- unknown designators: package and value words, then the pad count ---
  ['BOOT1', 'led', { value: 'LED_G_0603_LG_L29K', pkg: 'LED_0603_1608Metric_G' }], ['XYZ1', 'ic', { pkg: 'BGA256' }], ['AB1', 'ic', { pkg: 'QFN-32-1EP' }],
  ['AB2', 'ic', { pkg: 'VQFN-24-1EP_3.8x3.8mm' }], ['AB3', 'crystal', { value: 'Crystal 16MHz' }], ['AB4', 'connector', { pkg: 'USB_C_Receptacle' }],
  ['AB5', 'ferrite', { value: 'FERRITE 600R' }], ['AB6', 'transistor', { pkg: 'SOT-23', pins: 3 }], ['AB7', 'ic', { pkg: 'SOT-23-5', pins: 5 }],
  ['AB8', 'diode', { pkg: 'SOD-123F' }], ['AB9', 'mechanical', { pins: 0 }], ['ZZ1', 'part'], ['ZZ2', 'part', { pins: 2 }],
  ['BAT2', 'part', { value: 'Battery_Holder_MS621FE', pins: 2 }], ['NVME1', 'led', { pkg: 'LED_0603' }], ['AB10', 'fuse', { value: 'Polyfuse 0.5A' }],
  // --- the schematic library id outranks the designator and the package (the caller says the cross-probe is unique) ---
  ['X9', 'resistor', { libId: 'Device:R' }], ['FB1', 'resistor', { libId: 'Device:R_Small' }], ['L5', 'ferrite', { libId: 'Device:FerriteBead' }],
  ['R7', 'ferrite', { libId: 'Device:FerriteBead_Small' }], ['U3', 'capacitor', { libId: 'Device:C' }], ['A1', 'resistor-array', { libId: 'Device:R_Network04' }],
  ['A2', 'part', { libId: 'Device:R_Potentiometer' }], ['A3', 'capacitor', { libId: 'Device:C_Polarized' }], ['A4', 'capacitor', { libId: 'Device:CP_Small' }],
  ['A5', 'inductor', { libId: 'Device:L_Small' }], ['A6', 'fuse', { libId: 'Device:Fuse' }], ['A7', 'fuse', { libId: 'Device:Polyfuse' }],
  ['A8', 'led', { libId: 'Device:LED' }], ['A9', 'diode', { libId: 'Device:D_Zener' }], ['B1', 'transistor', { libId: 'Device:Q_NPN_BCE' }],
  ['B2', 'crystal', { libId: 'Device:Crystal_GND24' }], ['B3', 'jumper', { libId: 'Jumper:SolderJumper_2_Open' }],
  ['B4', 'connector', { libId: 'Connector_Generic:Conn_01x04' }], ['B5', 'connector', { libId: 'Connector:USB_B' }], ['B6', 'testpoint', { libId: 'TestPoint:TestPoint' }],
  ['B7', 'switch', { libId: 'Switch:SW_Push' }], ['B8', 'mechanical', { libId: 'Mechanical:MountingHole' }], ['B9', 'crystal', { libId: 'Oscillator:ASE-xxxMHz' }],
  ['C9', 'ic', { libId: 'MCU_ST_STM32F0:STM32F030F4Px' }], ['D9', 'ic', { libId: 'Regulator_Linear:AMS1117-3.3' }], ['E9', 'part', { libId: 'Device:Buzzer' }],
  ['F9', 'ic', { libId: 'Transistor_Array:ULN2003A' }], ['G9', 'transistor', { libId: 'Transistor_FET:2N7002' }], ['H9', 'led', { libId: 'LED:WS2812B' }],
  ['I9', 'diode', { libId: 'Diode:1N4148W' }], ['TP7', 'resistor', { libId: 'Device:R', pkg: 'TestPoint_Pad' }],
  // --- a library id the classifier does not know falls back to the designator ---
  ['R1', 'resistor', { libId: 'Custom:Foo' }], ['C2', 'capacitor', { libId: 'Device:' }], ['U2', 'ic', { libId: ':R' }], ['Q2', 'transistor', { libId: 'NoColon' }],
  ['J9', 'connector', { libId: 'rcl:R-US_:R0603' }], ['D3', 'diode', { libId: 'Device:SomethingNew' }], ['L2', 'inductor', { libId: '' }],
];

describe('part kind table', () => {
  it('holds at least 120 references, each once', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(120);
    const keys = TABLE.map(([ref, , extra]) => JSON.stringify([ref, extra ?? {}]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('covers every kind', () => {
    const seen = new Set(TABLE.map(row => row[1]));
    for (const kind of PART_KINDS) expect(seen.has(kind), kind).toBe(true);
  });

  it.each(TABLE.map(row => [JSON.stringify(row[0]) + (row[2] ? ' ' + JSON.stringify(row[2]) : ''), row] as const))('%s', (_label, [ref, kind, extra]) => {
    const result = classifyPart(input(ref, extra));
    expect(result.kind, result.reason).toBe(kind);
    expect(['high', 'medium', 'low']).toContain(result.confidence);
    expect(result.reason.length).toBeGreaterThan(3);
  });
});

describe('what changed against the previous per-letter rule', () => {
  /** The rule this classifier replaced (inspector, search rows, icons), kept here as a reference to compare against. */
  function previous(ref: string): string {
    const prefix = ref.match(/^[A-Za-z]+/)?.[0].toUpperCase() || '';
    if (prefix.endsWith('U') || prefix.endsWith('IC')) return 'ic';
    if (prefix.endsWith('C')) return 'capacitor';
    if (prefix.endsWith('R')) return 'resistor';
    if (prefix.endsWith('L')) return 'inductor';
    if (/[JP]$/.test(prefix)) return 'connector';
    if (prefix.endsWith('D')) return 'diode';
    if (prefix.endsWith('Q')) return 'transistor';
    if (/[XY]$/.test(prefix)) return 'crystal';
    if (prefix.endsWith('F')) return 'fuse';
    return 'part';
  }
  const KNOWN = ['IC7', 'IC1', 'IC12', 'ic3', 'Ic4', 'PMIC1', 'LIC2', 'U1', 'u22', 'MCU1', 'C1', 'C100', 'EC3', 'TC2', 'R1', 'R0402', 'L1', 'FL2', 'J1', 'P3', 'JP4', 'D5',
    'LED2', 'Q1', 'X1', 'Y1', 'F1', 'FB1', 'S1', 'RV1', 'M2', '', '12', '#PWR01'];
  /** The only cases that now read differently, and why: the kind exists as its own class (LED, jumper, switch) or was unknown (FB). */
  const CHANGED: Record<string, readonly [from: string, to: PartKind]> = {
    FB1: ['part', 'ferrite'], LED2: ['diode', 'led'], JP4: ['connector', 'jumper'], S1: ['part', 'switch'],
  };
  it('every other reference of the previous tests keeps its class', () => {
    for (const ref of KNOWN) {
      const now = classifyPart({ ref }).kind;
      const change = CHANGED[ref];
      if (change) { expect([ref, previous(ref), now]).toEqual([ref, change[0], change[1]]); continue; }
      expect([ref, now]).toEqual([ref, previous(ref)]);
    }
  });
  it('the last-letter rule was wrong for these, the table is right', () => {
    const wrong: Array<[string, string, PartKind]> = [
      ['CN1', 'part', 'connector'], ['TP1', 'connector', 'testpoint'], ['RP1', 'connector', 'resistor-array'], ['OSC1', 'capacitor', 'crystal'],
      ['LCD1', 'diode', 'part'], ['MIC1', 'ic', 'part'], ['TR2', 'resistor', 'part'], ['SW1', 'part', 'switch'],
    ];
    for (const [ref, before, after] of wrong) expect([ref, previous(ref), classifyPart({ ref }).kind]).toEqual([ref, before, after]);
  });
});

describe('rules and their order', () => {
  it('the schematic library id outranks everything else, with high confidence', () => {
    for (const [ref, libId, kind] of [['U1', 'Device:R', 'resistor'], ['TP1', 'Device:C', 'capacitor'], ['C1', 'Connector:Conn_01x02_Pin', 'connector']] as const) {
      const result = classifyPart({ ref, libId, package: 'TestPoint_Pad' });
      expect([ref, result.kind, result.confidence]).toEqual([ref, kind, 'high']);
      expect(result.reason).toContain(libId.split(':')[0]);
    }
  });

  it('a library id the classifier does not know or cannot read changes nothing', () => {
    const noId = classifyPart({ ref: 'CN4' });
    for (const libId of ['', 'x', ':', 'Device:', ':R', 'Unknown:Part', 'a:b:c', 'Device:Totally_New_Symbol', 'Device:'.repeat(50), 'D'.repeat(5000) + ':R']) {
      expect(classifyPart({ ref: 'CN4', libId }), libId.slice(0, 20)).toEqual(noId);
    }
  });

  it('words that cannot belong to anything else outrank the designator, then the designator outranks the other words', () => {
    expect(classifyPart({ ref: 'J1', package: 'MountingHole_3.2mm' }).kind).toBe('mechanical');
    expect(classifyPart({ ref: 'U1', value: 'logo' }).kind).toBe('mechanical');
    expect(classifyPart({ ref: 'R1', package: 'TestPoint_Pad_1mm' }).kind).toBe('testpoint');
    // The designator is a resistor; "SW" in the value does not make it a switch.
    expect(classifyPart({ ref: 'R1', value: 'SW_FEEDBACK' }).kind).toBe('resistor');
    expect(classifyPart({ ref: 'C1', package: 'QFN-32' }).kind).toBe('capacitor');
    expect(classifyPart({ ref: 'MIC1', package: 'LGA-4' }).kind).toBe('part');
    // Small outline packages are not chips on their own: the ESD diode array stays a diode.
    expect(classifyPart({ ref: 'ESD1', package: 'SOT-23', pinCount: 3 }).kind).toBe('diode');
  });

  it('the last letter of an unknown designator is never read as the class', () => {
    // These endings used to give capacitor, resistor, diode, connector, inductor, fuse, crystal.
    for (const ref of ['ZZC1', 'ZZR2', 'ZZD3', 'ZZJ4', 'ZZL5', 'ZZF6', 'ZZY7', 'ZZP8', 'ZZQ9', 'ZZX0']) expect([ref, classifyPart({ ref }).kind]).toEqual([ref, 'part']);
  });

  it('designators that end in U or IC are chips when the table does not know them', () => {
    for (const ref of ['EPU1', 'XXU2', 'VPU3', 'FOOIC4', 'SOCIC5']) expect([ref, classifyPart({ ref }).kind]).toEqual([ref, 'ic']);
    expect(classifyPart({ ref: 'XXU2' }).confidence).toBe('medium');
    expect(classifyPart({ ref: 'IC' }).kind).toBe('ic'); // the two-letter prefix itself
    expect(classifyPart({ ref: 'MIC9' }).kind).toBe('part'); // a table entry, not an ending
  });

  it('a JP header is told from a jumper by its pad count', () => {
    expect(classifyPart({ ref: 'JP1', pinCount: 3 })).toMatchObject({ kind: 'jumper', confidence: 'high' });
    expect(classifyPart({ ref: 'JP1', pinCount: 4 })).toMatchObject({ kind: 'connector', confidence: 'medium' });
    expect(classifyPart({ ref: 'JP1' })).toMatchObject({ kind: 'jumper', confidence: 'medium' });
  });

  it('confidence says how the kind was found', () => {
    expect(classifyPart({ ref: 'R1' }).confidence).toBe('high');
    expect(classifyPart({ ref: 'S1' }).confidence).toBe('medium');
    expect(classifyPart({ ref: 'ZZ1' }).confidence).toBe('low');
    expect(classifyPart({ ref: 'TR1' }).confidence).toBe('low');
    expect(classifyPart({ ref: 'X1', libId: 'Device:Crystal' }).confidence).toBe('high');
    expect(classifyPart({ ref: 'X1', libId: 'MCU_Foo:Bar' })).toMatchObject({ kind: 'ic', confidence: 'medium' });
  });

  it('reads the pad count from a board component and passes the library id on', () => {
    expect(classifyComponent({ ref: 'JP1', pinIds: ['a', 'b', 'c', 'd', 'e'] }).kind).toBe('connector');
    expect(classifyComponent({ ref: 'JP1', pinIds: ['a', 'b'] }).kind).toBe('jumper');
    expect(classifyComponent({ ref: 'ZZ1', pinIds: [] }).kind).toBe('mechanical');
    expect(classifyComponent({ ref: 'ZZ1' }).kind).toBe('part');
    expect(classifyComponent({ ref: 'ZZ1', value: '', package: '' }, 'Device:R').kind).toBe('resistor');
  });

  it('ignores a pad count that is not a count', () => {
    for (const pinCount of [NaN, -1, 1.5, Infinity, '3' as unknown as number]) expect(classifyPart({ ref: 'JP1', pinCount }).kind, String(pinCount)).toBe('jumper');
  });
});

describe('robustness', () => {
  it('survives missing, wrong and enormous input without throwing', () => {
    const weird = [
      { ref: undefined as unknown as string }, { ref: null as unknown as string }, { ref: 42 as unknown as string }, { ref: '   ' }, { ref: '\u0000\u0001' },
      { ref: 'ÅÄÖ1' }, { ref: 'Ω1', value: 'Ω', package: 'µ' }, { ref: 'R1', value: 12 as unknown as string, package: {} as unknown as string },
      { ref: 'A'.repeat(1_000_000) }, { ref: 'R1', value: 'x'.repeat(1_000_000), package: 'y'.repeat(1_000_000) }, { ref: 'L1', value: '1'.repeat(100_000) + '@' },
    ];
    for (const item of weird) {
      const result = classifyPart(item);
      expect(PART_KINDS).toContain(result.kind);
    }
    expect(classifyPart({ ref: '   ' }).kind).toBe('part');
    expect(classifyPart({ ref: 'R1', value: 12 as unknown as string }).kind).toBe('resistor');
    expect(classifyPart({ ref: ' r5 ' }).kind).toBe('resistor');
  });

  it('is fast on pathological text: only the first characters are read', () => {
    // The time does not depend on the length of the text: the same call on a text 100 times as long costs about the same.
    expectBoundedWork('long texts', [2000, 20_000, 200_000], length => {
      const long: PartKindInput[] = [{ ref: 'L1', value: '1'.repeat(length) + '@', package: 'FB_'.repeat(length / 4) }, { ref: 'Z'.repeat(length * 3 / 2) + '1', value: ' '.repeat(length) }];
      return () => { for (const part of long) classifyPart(part); };
    });
  });

  it('classifies 100,000 components in linear time', () => {
    const samples: PartKindInput[] = TABLE.map(([ref, , extra]) => input(ref, extra));
    const classifyAll = (count: number) => { const counts = new Map<PartKind, number>(); for (let i = 0; i < count; i++) { const kind = classifyPart(samples[i % samples.length]).kind; counts.set(kind, (counts.get(kind) ?? 0) + 1); } return counts; };
    expectScaling('classifying parts', [6250, 25_000, 100_000], count => () => classifyAll(count));
    expect(classifyAll(100_000).size).toBe(PART_KINDS.length);
  });
});

describe('the consumers of the classifier', () => {
  it('maps the kinds onto the three canvas colour groups', () => {
    const groups: Record<PartKind, 'chip' | 'connector' | 'passive'> = {
      ic: 'chip', connector: 'connector', capacitor: 'passive', resistor: 'passive', 'resistor-array': 'passive', inductor: 'passive', ferrite: 'passive',
      fuse: 'passive', diode: 'passive', led: 'passive', transistor: 'passive', crystal: 'passive', testpoint: 'passive', switch: 'passive',
      jumper: 'passive', mechanical: 'passive', part: 'passive',
    };
    for (const kind of PART_KINDS) expect([kind, canvasGroup(kind)]).toEqual([kind, groups[kind]]);
  });

  it('keeps what the canvas coloured as a chip or a connector (the cases its own rules handled)', () => {
    for (const [ref, group, extra] of [
      ['U3', 'chip'], ['IC7', 'chip'], ['PMIC1', 'chip'], ['VRAM2', 'chip'], ['MCU1', 'chip'], ['Z9', 'chip', { pkg: 'BGA256' }], ['Z8', 'chip', { pkg: 'TSSOP-20' }],
      ['CN1', 'connector'], ['CON2', 'connector'], ['ACN3', 'connector'], ['J4', 'connector'], ['P5', 'connector'], ['PJ6', 'connector'], ['RJ7', 'connector'], ['Z7', 'connector', { value: 'HDMI' }],
      ['R1', 'passive'], ['C2', 'passive'], ['TP1', 'passive'], ['JP4', 'passive'],
    ] as ReadonlyArray<readonly [string, 'chip' | 'connector' | 'passive', Extra?]>) {
      expect([ref, canvasGroup(classifyPart(input(ref, extra)).kind)]).toEqual([ref, group]);
    }
  });

  it('every kind has a label in all eight interface languages', () => {
    for (const kind of PART_KINDS) {
      const key = KIND_LABEL[kind];
      expect(key, kind).toMatch(/^kind\./);
      for (const language of LANGUAGES) {
        const text = (catalogs[language] as Record<string, unknown>)[key];
        expect(typeof text === 'string' && text.length > 1, `${language} ${key}`).toBe(true);
      }
    }
    expect(new Set(PART_KINDS.map(kind => KIND_LABEL[kind])).size).toBe(PART_KINDS.length);
  });

  it('the canvas and the inspector share this module: neither keeps rules of its own', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    // The canvas takes its part kinds from the board scene it draws.
    const scene = read('../components/board-scene.ts'), inspector = read('../components/workspace/ui.tsx');
    const canvas = [read('../components/BoardCanvas.tsx'), read('../components/board-render-2d.ts')].join('\n');
    expect(scene).toContain("from '../lib/part-kind'");
    expect(inspector).toContain("from '../../lib/part-kind'");
    for (const source of [scene, canvas, inspector]) {
      expect(source).not.toMatch(/endsWith\('(?:IC|U|C|R|L|D|Q|F)'\)/);
      expect(source).not.toMatch(/\[A-Z\]\*U\|IC/);
    }
  });
});
