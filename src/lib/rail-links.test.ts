import { describe, expect, it } from 'vitest';
import { buildNetGraph } from './net-graph';
import { kitBoard, two, type KitPart } from './net-testkit';
import { linkOf, normalizeLinkSettings, otherNet, type LinkSettings } from './rail-links';

/** The link of the single part of a one-part board (plus filler so nets exist). */
function linkFor(part: KitPart, settings: LinkSettings = {}) {
  const board = kitBoard([part, two('C99', '100n', 'A', 'GND'), two('C98', '100n', 'B', 'GND')]);
  const graph = buildNetGraph(board);
  return { graph, link: linkOf(graph, 0, normalizeLinkSettings(settings)) };
}

describe('linkOf: link classes from kind and value', () => {
  // ref, value, package, expected [type, class, certainty, code] or null
  const cases: Array<[string, string, string, [string, string, string, string] | ['not-fitted', string] | null]> = [
    ['R1', '0R', '', ['link', 'jumper', 'definite', 'zero-ohm']],
    ['R2', '0', '', ['link', 'jumper', 'definite', 'zero-ohm']],
    ['R3', '0Ω', '', ['link', 'jumper', 'definite', 'zero-ohm']],
    ['R4', 'R005', '', ['link', 'shunt', 'definite', 'shunt-value']],
    ['R5', '0.01', '', ['link', 'shunt', 'definite', 'shunt-value']],
    ['R6', '10mR', '', ['link', 'shunt', 'definite', 'shunt-value']],
    ['R7', '0R47', '', ['link', 'low-ohm', 'definite', 'low-ohm-value']],
    ['R8', '1R', '', ['link', 'low-ohm', 'definite', 'low-ohm-value']],
    ['R9', '1R1', '', null],
    ['R10', '4K7', '', null],
    ['R11', '', '', ['link', 'low-ohm', 'possible', 'unknown-value']],
    ['R12', 'RES_VALUE', '', ['link', 'low-ohm', 'possible', 'unknown-value']],
    ['R13', '0R DNP', '', ['not-fitted', 'low-ohm']],
    ['R16', '10K DNP', '', null], // not a link fitted or not
    ['R14', 'NC', '', ['not-fitted', 'low-ohm']],
    ['R15', 'R_0R_0402', '', ['link', 'jumper', 'definite', 'zero-ohm']],
    ['JP1', '', '', ['link', 'jumper', 'definite', 'jumper-kind']],
    ['JP2', 'SolderJumper_2_Open', '', ['link', 'jumper', 'possible', 'open-jumper']],
    ['JP3', 'SolderJumper_2_Bridged', '', ['link', 'jumper', 'definite', 'jumper-kind']],
    ['JP4', 'Jumper_NC_Small', '', ['link', 'jumper', 'definite', 'jumper-kind']],
    ['JP5', 'Jumper_NO_Small', '', ['link', 'jumper', 'possible', 'open-jumper']],
    ['JP6', 'DNP', '', ['not-fitted', 'jumper']],
    ['F1', '2A', '', ['link', 'fuse', 'definite', 'fuse-kind']],
    ['F2', 'DNP', '', ['not-fitted', 'fuse']],
    ['FB1', '600R@100MHz', '', ['link', 'ferrite', 'definite', 'ferrite-kind']],
    ['L1', '2.2uH', '', ['link', 'inductor', 'definite', 'inductor-value']],
    ['L2', '2u2', '', ['link', 'inductor', 'definite', 'inductor-value']],
    ['L3', '100nH', '', ['link', 'inductor', 'definite', 'inductor-value']],
    ['L4', '10nH', '', ['link', 'inductor', 'possible', 'small-inductance']],
    ['L5', '', 'L_0402_1005Metric', ['link', 'inductor', 'possible', 'small-inductor-package']],
    ['L6', '', 'L_1210_3225Metric', ['link', 'inductor', 'definite', 'inductor-package']],
    ['L7', '', '', ['link', 'inductor', 'possible', 'unknown-inductor']], // a 2 x 1 mm outline says nothing
    ['L10', '', 'SOT-23', ['link', 'inductor', 'possible', 'unknown-inductor']],
    ['L8', '600R@100MHz', '', ['link', 'ferrite', 'definite', 'ferrite-kind']], // an L whose value is a ferrite impedance
    ['L9', 'DNP', '', ['not-fitted', 'inductor']],
    ['C1', '0R', '', null], // a capacitor never links
    ['D1', 'BAT54', '', null], // diodes only on request
    ['LED1', 'RED', '', null],
    ['X1', '0R', '', null], // crystal kind
    ['ZZ1', '0R', '', ['link', 'jumper', 'possible', 'unknown-kind-low-ohm']],
    ['ZZ2', '0.5R', '', ['link', 'low-ohm', 'possible', 'unknown-kind-low-ohm']],
    ['ZZ3', '0.5', '', null], // unit-less: no evidence it is a resistance
    ['ZZ4', '4K7', '', null],
    ['RN1', '0R', '', null], // arrays: the pin pairing is unknown
  ];
  for (const [ref, value, pkg, expected] of cases) {
    it(`${ref} ${JSON.stringify(value)} ${pkg}`, () => {
      const { link } = linkFor({ ref, value, package: pkg, pins: ['A', 'B'] });
      if (expected === null) { expect(link).toBeNull(); return; }
      expect(link).not.toBeNull();
      if (expected[0] === 'not-fitted') { expect(link).toMatchObject({ type: 'not-fitted', linkClass: expected[1] }); return; }
      expect(link).toMatchObject({ type: 'link', linkClass: expected[1], certainty: expected[2], code: expected[3] });
    });
  }
});

describe('linkOf: nets', () => {
  it('needs exactly two named nets (no-connect pins do not count)', () => {
    expect(linkFor({ ref: 'R1', value: '0R', pins: ['A', 'A'] }).link).toBeNull();
    expect(linkFor({ ref: 'R1', value: '0R', pins: ['A', ''] }).link).toBeNull();
    expect(linkFor({ ref: 'R1', value: '0R', pins: ['A', 'NC'] }).link).toBeNull();
    expect(linkFor({ ref: 'R1', value: '0R', pins: ['A', 'unconnected-(R1-Pad2)'] }).link).toBeNull();
    expect(linkFor({ ref: 'R1', value: '0R', pins: ['A', 'B', 'C'] }).link).toBeNull();
    expect(linkFor({ ref: 'F1', value: '', pins: ['A', 'B', 'C'] }).link).toBeNull();
  });
  it('takes an inductor of unknown value and package with a large outline as a power inductor', () => {
    const big = linkFor({ ref: 'L1', value: '', pins: ['A', 'B'], bounds: { minX: 0, minY: 0, maxX: 4, maxY: 4 } }).link;
    expect(big).toMatchObject({ linkClass: 'inductor', certainty: 'definite', code: 'inductor-outline' });
    const small = linkFor({ ref: 'L1', value: '', pins: ['A', 'B'], bounds: { minX: 0, minY: 0, maxX: 3, maxY: 2 } }).link;
    expect(small).toMatchObject({ linkClass: 'inductor', certainty: 'possible', code: 'unknown-inductor' });
  });
  it('joins two pins on the same pair of nets (a power inductor with four pads)', () => {
    const { graph, link } = linkFor({ ref: 'L1', value: '4.7uH', pins: ['A', 'A', 'B', 'B'] });
    expect(link).toMatchObject({ type: 'link', linkClass: 'inductor' });
    expect([graph.netName(link!.nets[0]), graph.netName(link!.nets[1])]).toEqual(['A', 'B']);
  });
  it('reduces a 4-pad Kelvin resistor to its force nets', () => {
    const board = kitBoard([
      { ref: 'R1', value: 'R002', pins: ['VIN', 'SNS_P', 'SNS_N', 'VOUT'] },
      two('C1', '10u', 'VIN', 'GND'), two('C2', '10u', 'VIN', 'GND'), two('C3', '10u', 'VOUT', 'GND'), two('C4', '10u', 'VOUT', 'GND'),
      { ref: 'U1', pins: ['SNS_P', 'SNS_N', 'GND'] },
    ]);
    const graph = buildNetGraph(board);
    const link = linkOf(graph, 0, normalizeLinkSettings());
    expect(link).toMatchObject({ type: 'link', linkClass: 'shunt', certainty: 'definite', code: 'kelvin-shunt' });
    expect([graph.netName(link!.nets[0]), graph.netName(link!.nets[1])].sort()).toEqual(['VIN', 'VOUT']);
    expect(otherNet(link as { nets: readonly [number, number] }, graph.netIndex('SNS_P'))).toBe(-1);
  });
  it('treats a 4-pad resistor whose pads reach only two nets as a Kelvin shunt, and a 0 Ω one as a jumper', () => {
    const shunt = linkFor({ ref: 'R1', value: 'R002', pins: ['A', 'A', 'B', 'B'] });
    expect(shunt.link).toMatchObject({ type: 'link', linkClass: 'shunt', certainty: 'definite', code: 'kelvin-shunt' });
    expect([shunt.graph.netName(shunt.link!.nets[0]), shunt.graph.netName(shunt.link!.nets[1])]).toEqual(['A', 'B']);
    expect(linkFor({ ref: 'R1', value: '0R', pins: ['A', 'A', 'B', 'B'] }).link).toMatchObject({ linkClass: 'jumper', code: 'zero-ohm' });
    expect(linkFor({ ref: 'R1', value: '10K', pins: ['A', 'A', 'B', 'B'] }).link).toBeNull();
    // Three pads on two nets are an ordinary low-ohm link; five pads on three nets are no resistor of this kind.
    expect(linkFor({ ref: 'R1', value: '0R5', pins: ['A', 'A', 'B'] }).link).toMatchObject({ linkClass: 'low-ohm', code: 'low-ohm-value' });
    expect(linkFor({ ref: 'R1', value: '0R5', pins: ['A', 'B', 'C', 'A', 'B'] }).link).toBeNull();
  });
  it('makes a Kelvin resistor of unknown value a possible shunt', () => {
    const board = kitBoard([{ ref: 'R1', value: '', pins: ['VIN', 'S1', 'S2', 'VOUT'] }, two('C1', '1u', 'VIN', 'GND'), two('C2', '1u', 'VOUT', 'GND')]);
    const graph = buildNetGraph(board);
    expect(linkOf(graph, 0, normalizeLinkSettings())).toMatchObject({ linkClass: 'shunt', certainty: 'possible', code: 'unknown-value' });
  });
});

describe('linkOf: parts listed as not fitted', () => {
  it('makes a listed part a not-fitted link whatever its value says (a do-not-populate attribute, a lifted part)', () => {
    const board = kitBoard([two('R1', '0R', 'A', 'B'), { ref: 'JP1', value: 'Jumper_NC_Small', pins: ['A', 'C'] }, two('FB1', '600R@100MHz', 'A', 'D'), two('C1', '1u', 'A', 'GND')]);
    const graph = buildNetGraph(board, { notFitted: new Set(['part:0', 'part:1', 'part:2']) });
    const settings = normalizeLinkSettings();
    expect(linkOf(graph, 0, settings)).toMatchObject({ type: 'not-fitted', linkClass: 'low-ohm', reason: 'low-ohm not fitted (listed as not populated)' });
    expect(linkOf(graph, 1, settings)).toMatchObject({ type: 'not-fitted', linkClass: 'jumper' });
    expect(linkOf(graph, 2, settings)).toMatchObject({ type: 'not-fitted', linkClass: 'ferrite' });
    expect(linkOf(buildNetGraph(board), 0, settings)).toMatchObject({ type: 'link', linkClass: 'jumper' });
  });
});

describe('linkOf: threshold and diodes', () => {
  it('uses 1 Ω by default and clamps the threshold to 0..10 Ω', () => {
    expect(normalizeLinkSettings()).toEqual({ thresholdOhms: 1, diodes: false });
    expect(normalizeLinkSettings({ thresholdOhms: -3 }).thresholdOhms).toBe(0);
    expect(normalizeLinkSettings({ thresholdOhms: 50 }).thresholdOhms).toBe(10);
    expect(normalizeLinkSettings({ thresholdOhms: Number.NaN }).thresholdOhms).toBe(1);
    expect(normalizeLinkSettings({ thresholdOhms: Infinity }).thresholdOhms).toBe(1);
  });
  it('applies the threshold inclusively', () => {
    expect(linkFor(two('R1', '0R5', 'A', 'B'), { thresholdOhms: 0.5 }).link).toMatchObject({ linkClass: 'low-ohm' });
    expect(linkFor(two('R1', '0R5', 'A', 'B'), { thresholdOhms: 0.49 }).link).toBeNull();
    expect(linkFor(two('R1', '0R', 'A', 'B'), { thresholdOhms: 0 }).link).toMatchObject({ linkClass: 'jumper' });
    expect(linkFor(two('R1', '10R', 'A', 'B'), { thresholdOhms: 10 }).link).toMatchObject({ linkClass: 'low-ohm' });
    expect(linkFor(two('R1', '10R', 'A', 'B'), { thresholdOhms: 20 }).link).toMatchObject({ linkClass: 'low-ohm' });
    expect(linkFor(two('R1', '11R', 'A', 'B'), { thresholdOhms: 20 }).link).toBeNull();
  });
  it('makes diodes possible one-way links only on request', () => {
    const anodeFirst = { ref: 'D1', value: 'BAT54', pins: [{ net: 'A', name: 'A' }, { net: 'B', name: 'K' }] };
    expect(linkFor(anodeFirst).link).toBeNull();
    const { graph, link } = linkFor(anodeFirst, { diodes: true });
    expect(link).toMatchObject({ linkClass: 'diode', certainty: 'possible', oneWay: true });
    expect(graph.netName(link!.nets[0])).toBe('A');
    const reversed = linkFor({ ref: 'D1', value: 'BAT54', pins: [{ net: 'A', name: 'K' }, { net: 'B', name: 'A' }] }, { diodes: true });
    expect(reversed.graph.netName(reversed.link!.nets[0])).toBe('B');
    expect(linkFor({ ref: 'D1', value: 'BAT54', pins: ['A', 'B'] }, { diodes: true }).link).toMatchObject({ linkClass: 'diode', oneWay: false });
  });
  it('caches per settings', () => {
    const board = kitBoard([two('R1', '0R5', 'A', 'B')]);
    const graph = buildNetGraph(board);
    const loose = normalizeLinkSettings({ thresholdOhms: 1 }), strict = normalizeLinkSettings({ thresholdOhms: 0.1 });
    expect(linkOf(graph, 0, loose)).not.toBeNull();
    expect(linkOf(graph, 0, strict)).toBeNull();
    expect(linkOf(graph, 0, loose)).toBe(linkOf(graph, 0, loose));
    expect(linkOf(graph, -1, loose)).toBeNull();
    expect(linkOf(graph, 5, loose)).toBeNull();
  });
  it('keeps the answers for a few settings only, and every setting still gets the right answer', () => {
    const graph = buildNetGraph(kitBoard([two('R1', '0R5', 'A', 'B'), two('C1', '1u', 'A', 'GND')]));
    for (let round = 0; round < 3; round++) {
      for (let threshold = 0; threshold <= 10; threshold += 0.25) {
        const link = linkOf(graph, 0, normalizeLinkSettings({ thresholdOhms: threshold }));
        expect(link === null, `threshold ${threshold}`).toBe(threshold < 0.5);
      }
    }
  });
});
