import { describe, expect, it } from 'vitest';
import { catalogs } from '../../lib/i18n';
import { KIND_LABEL, PART_KINDS, classifyComponent } from '../../lib/part-kind';
import { kindKey } from './ui';

/**
 * The inspector, the search rows and the icons name a part by `kindKey`, which is the shared classifier (src/lib/part-kind.ts, with its
 * own table in part-kind.test.ts of src/lib) plus the catalog key of each kind. These are the cases the per-letter rule it replaced was
 * tested with, plus the ones it got wrong.
 */
const part = (ref: string) => ({ ref });

describe('part kind labels from the reference designator', () => {
  it('labels IC designators as integrated circuits: the C of "IC" is not a capacitor', () => {
    for (const ref of ['IC7', 'IC1', 'IC12', 'ic3', 'Ic4']) expect(kindKey(part(ref)), ref).toBe('kind.ic');
  });

  it('labels compound designators that end in IC (power-management and similar ICs) as integrated circuits', () => {
    expect(kindKey(part('PMIC1'))).toBe('kind.ic');
    expect(kindKey(part('LIC2'))).toBe('kind.ic');
  });

  it('keeps U designators, including ones that end in U, as integrated circuits', () => {
    expect(kindKey(part('U1'))).toBe('kind.ic');
    expect(kindKey(part('u22'))).toBe('kind.ic');
    expect(kindKey(part('MCU1'))).toBe('kind.ic');
  });

  it('does not turn real capacitors, resistors and the other classes into integrated circuits', () => {
    const expected: Record<string, string> = {
      C1: 'kind.capacitor', C100: 'kind.capacitor', EC3: 'kind.capacitor', TC2: 'kind.capacitor',
      R1: 'kind.resistor', R0402: 'kind.resistor', L1: 'kind.inductor', FL2: 'kind.inductor',
      J1: 'kind.connector', P3: 'kind.connector',
      D5: 'kind.diode', Q1: 'kind.transistor',
      X1: 'kind.crystal', Y1: 'kind.crystal', F1: 'kind.fuse',
      RV1: 'kind.part', M2: 'kind.part',
    };
    for (const [ref, kind] of Object.entries(expected)) expect([ref, kindKey(part(ref))]).toEqual([ref, kind]);
  });

  it('names the classes that used to read as something else: ferrite bead, LED, jumper, switch', () => {
    // Before: FB1 and S1 were "Component", LED2 a "Diode", JP4 a "Connector".
    expect(kindKey(part('FB1'))).toBe('kind.ferrite');
    expect(kindKey(part('LED2'))).toBe('kind.led');
    expect(kindKey(part('JP4'))).toBe('kind.jumper');
    expect(kindKey(part('S1'))).toBe('kind.switch');
  });

  it('no longer reads the class from the last letter: connectors, test points, resistor arrays, oscillators, displays, microphones', () => {
    const expected: Record<string, string> = {
      CN1: 'kind.connector', TP1: 'kind.testpoint', RP1: 'kind.resistorArray', OSC1: 'kind.crystal', SW1: 'kind.switch',
      LCD1: 'kind.part', MIC1: 'kind.part', TR2: 'kind.part', FID1: 'kind.mechanical', MH2: 'kind.mechanical',
    };
    for (const [ref, kind] of Object.entries(expected)) expect([ref, kindKey(part(ref))]).toEqual([ref, kind]);
  });

  it('falls back to a generic part for references without a designator', () => {
    expect(kindKey(part(''))).toBe('kind.part');
    expect(kindKey(part('12'))).toBe('kind.part');
    expect(kindKey(part('#PWR01'))).toBe('kind.part');
  });

  it('uses the pad count, package and value of a board component, and the schematic library id when it is given', () => {
    expect(kindKey({ ref: 'JP1', pinIds: ['1', '2', '3', '4', '5', '6'] })).toBe('kind.connector');
    expect(kindKey({ ref: 'L7', value: '600R@100MHz', package: '0603' })).toBe('kind.ferrite');
    expect(kindKey({ ref: 'P9', value: 'CONN_1', package: 'MountingHole_4.3mm_M4' })).toBe('kind.mechanical');
    expect(kindKey({ ref: 'X9' }, 'Device:R')).toBe('kind.resistor');
    expect(kindKey({ ref: 'X9' }, undefined)).toBe('kind.crystal');
  });

  it('every label key of the classifier exists in the interface catalogs', () => {
    for (const kind of PART_KINDS) expect(Object.keys(catalogs.en)).toContain(KIND_LABEL[kind]);
    expect(kindKey(part('IC7'))).toBe(KIND_LABEL[classifyComponent(part('IC7')).kind]);
  });
});
