import { describe, expect, it } from 'vitest';
import { isTinyChip, outlineSize, packageSize, partSize } from './part-size';

describe('packageSize', () => {
  const cases: Array<[string, string, string | null, number | null, string | null]> = [
    // package, value, code, area mm², basis
    ['C_0402_1005Metric', '', '0402', 0.5, 'metric-code'],
    ['R_0805_2012Metric', '', '0805', 2.5, 'metric-code'],
    ['L_1210_3225Metric', '', '1210', 8, 'metric-code'],
    ['C_01005_0402Metric', '', '01005', 0.08, 'metric-code'],
    ['CP_Tantalum_Case-B_EIA-3528-21_Reflow', '', null, 9.8, 'metric-code'],
    ['CP_Tantalum_Case-A_EIA-3216-18_Reflow', '', '1206', 5.12, 'metric-code'],
    ['0603', '', '0603', 1.28, 'imperial-code'],
    ['C0402', '', '0402', 0.5, 'imperial-code'],
    ['RC0201', '', '0201', 0.18, 'imperial-code'],
    ['SMD-1206', '', '1206', 5.12, 'imperial-code'],
    ['CAPC1608X90N', '', null, null, null], // IPC names are not read
    ['', 'R_10k_0402', '0402', 0.5, 'imperial-code'],
    ['', 'C_4u7_0402', '0402', 0.5, 'imperial-code'],
    ['SOT-23', '', null, null, null],
    ['QFN-32', '', null, null, null],
    ['ABC0402', '', null, null, null], // three letters glued: a part number, not a size
    ['0402', '0805', '0402', 0.5, 'imperial-code'], // the package wins over the value
    ['', '', null, null, null],
  ];
  for (const [pkg, value, code, area, basis] of cases) {
    it(`reads ${JSON.stringify(pkg)} / ${JSON.stringify(value)}`, () => {
      const size = packageSize({ package: pkg, value });
      if (basis === null) { expect(size).toBeNull(); return; }
      expect(size).not.toBeNull();
      expect(size!.code).toBe(code);
      expect(size!.areaMm2).toBeCloseTo(area!, 6);
      expect(size!.basis).toBe(basis);
    });
  }
});

describe('outlineSize and partSize', () => {
  it('measures the bounds when no code is given', () => {
    const size = partSize({ package: 'SOT-23', value: '', bounds: { minX: 0, minY: 0, maxX: 3, maxY: 1.5 } });
    expect(size).toMatchObject({ code: null, lengthMm: 3, widthMm: 1.5, areaMm2: 4.5, basis: 'outline' });
  });
  it('prefers the code', () => {
    expect(partSize({ package: '0402', value: '', bounds: { minX: 0, minY: 0, maxX: 9, maxY: 9 } })?.basis).toBe('imperial-code');
  });
  it('rejects broken bounds', () => {
    expect(outlineSize({ bounds: { minX: 0, minY: 0, maxX: Number.NaN, maxY: 1 } })).toBeNull();
    expect(outlineSize({ bounds: { minX: 2, minY: 0, maxX: 1, maxY: 1 } })).toBeNull();
  });
  it('flags 0402 and smaller as tiny, never an outline', () => {
    expect(isTinyChip(packageSize({ package: '0402', value: '' }))).toBe(true);
    expect(isTinyChip(packageSize({ package: '0201', value: '' }))).toBe(true);
    expect(isTinyChip(packageSize({ package: '0603', value: '' }))).toBe(false);
    expect(isTinyChip(outlineSize({ bounds: { minX: 0, minY: 0, maxX: 0.1, maxY: 0.1 } }))).toBe(false);
    expect(isTinyChip(null)).toBe(false);
  });
});
