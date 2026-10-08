import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PART_CATEGORIES, PART_FAMILIES, partFamilyById } from './part-families';
import { normalizePartNumber } from './part-numbers';

describe('part family table: data integrity', () => {
  it('is a small table: between 150 and 400 rows', () => {
    expect(PART_FAMILIES.length).toBeGreaterThanOrEqual(150);
    expect(PART_FAMILIES.length).toBeLessThanOrEqual(400);
  });
  it('has unique ids and a lookup by id', () => {
    const ids = PART_FAMILIES.map(family => family.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const family of PART_FAMILIES) expect(partFamilyById(family.id)).toBe(family);
    expect(partFamilyById('no-such-family')).toBeUndefined();
  });
  it('gives every row a source note', () => {
    for (const family of PART_FAMILIES) {
      expect(family.note.trim().split(/\s+/).length, `${family.id} has no source note`).toBeGreaterThanOrEqual(2);
      expect(family.maker.trim().length, `${family.id} has no maker`).toBeGreaterThan(1);
    }
  });
  it('uses upper-case stems of two or more characters from the characters of a part number', () => {
    for (const family of PART_FAMILIES) {
      expect(family.stem, family.id).toBe(family.stem.toUpperCase());
      expect(family.stem.length, family.id).toBeGreaterThanOrEqual(2);
      expect(/^[A-Z0-9]+$/.test(family.stem), family.id).toBe(true);
    }
  });
  it('uses only the declared categories and fills most of them', () => {
    const used = new Set(PART_FAMILIES.map(family => family.category));
    for (const family of PART_FAMILIES) expect(PART_CATEGORIES, family.id).toContain(family.category);
    // connector and unknown-ic are assigned by structure rules, not by a part number.
    const unused = PART_CATEGORIES.filter(category => !used.has(category));
    expect(unused.sort()).toEqual(['connector', 'unknown-ic']);
  });
  it('covers the repair function categories of the plan', () => {
    const used = new Set(PART_FAMILIES.map(family => family.category));
    for (const category of ['pmic', 'charger', 'ec-sio', 'vrm-controller', 'usb-pd', 'load-switch', 'mosfet-n', 'mosfet-p', 'mosfet-dual', 'level-shifter', 'audio-codec', 'spi-flash', 'ldo', 'buck-boost', 'power-stage', 'dram', 'display-bridge', 'backlight', 'ethernet-phy', 'tvs-esd', 'fuel-gauge'] as const) {
      expect(used.has(category), category).toBe(true);
    }
  });
  it('has digit ranges that make sense', () => {
    for (const family of PART_FAMILIES) {
      expect(family.minDigits, family.id).toBeGreaterThanOrEqual(0);
      expect(family.maxDigits, family.id).toBeGreaterThanOrEqual(family.minDigits);
      expect(family.maxDigits, family.id).toBeLessThanOrEqual(6);
      if (family.prefixOnly) expect([family.minDigits, family.maxDigits], family.id).toEqual([0, 0]);
    }
  });
  it('has no two rows with the same stem and digit range', () => {
    const keys = PART_FAMILIES.map(family => `${family.stem}|${family.minDigits}|${family.maxDigits}|${family.prefixOnly}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('lists the longest stem first, so the most specific family wins', () => {
    for (let index = 1; index < PART_FAMILIES.length; index++) expect(PART_FAMILIES[index - 1].stem.length).toBeGreaterThanOrEqual(PART_FAMILIES[index].stem.length);
  });
  it('is marked CC0 in the header and states that nothing is scraped', () => {
    const source = readFileSync(new URL('./part-families.ts', import.meta.url), 'utf8');
    const header = source.slice(0, source.indexOf('export const PART_CATEGORIES'));
    expect(header).toContain('CC0 1.0');
    expect(header).toMatch(/no row comes from a[\s*]+scraped catalogue/);
    expect(header).toContain('note');
  });
  it('states the licence of the other data tables', () => {
    for (const file of ['./board-number-shapes.ts', './lexicon.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source.slice(0, 1500), file).toContain('CC0 1.0');
    }
  });
});

describe('part family table: every example resolves to its own row', () => {
  const rows = PART_FAMILIES.flatMap(family => family.examples.map(example => [family.id, example] as const));
  it('has at least one example per row and many examples in all', () => {
    for (const family of PART_FAMILIES) expect(family.examples.length, family.id).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeGreaterThanOrEqual(300);
  });
  it.each(rows)('%s: %s', (id, example) => {
    const family = partFamilyById(id)!;
    const keys = normalizePartNumber(example);
    expect(keys, example).not.toBeNull();
    expect(keys!.family).toBe(id);
    expect(keys!.category).toBe(family.category);
    expect(keys!.maker).toBe(family.maker);
    expect(keys!.exact).toBe(example.toUpperCase());
    expect(keys!.exact.startsWith(family.stem)).toBe(true);
    if (family.prefixOnly) {
      expect(keys!.base).toBeUndefined();
    } else {
      const digits = /^[0-9]*/.exec(example.toUpperCase().slice(family.stem.length))![0];
      expect(keys!.base).toBe(family.stem + digits);
      expect(digits.length).toBeGreaterThanOrEqual(family.minDigits);
      expect(digits.length).toBeLessThanOrEqual(family.maxDigits);
    }
  });
});
