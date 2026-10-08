import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { validateIndexSummary } from '../validate';
import { PART_FAMILIES } from './part-families';
import { MAX_IDENTIFIERS, cleanRaw, partTermKeys, pathIdentifiers, textIdentifiers, type IdentifierSource } from './identifiers';
import type { Identifier } from '../model';

const documentWith = (identifiers: Identifier[], terms: unknown[] = []) => ({
  kind: 'document', identity: { identifiers }, refs: [], rails: [], terms, format: 'pdf', role: 'schematic', pages: 2, textLayer: 'yes', ocr: 'none', pageHashes: ['b'.repeat(64), 'c'.repeat(64)],
});

describe('identifiers: from a text and its source', () => {
  const rows: Array<[text: string, source: IdentifierSource, expected: Array<[kind: Identifier['kind'], norm: string, pattern?: string]>]> = [
    ['820-01234-A', 'name', [['board-number', '820-01234', 'logic-board-820'], ['revision', 'A', 'letter']]],
    ['MacBook Pro 820-00875', 'name', [['board-number', '820-00875', 'logic-board-820'], ['vendor', 'apple'], ['device-type', 'laptop']]],
    ['LA-Z123P', 'title-block', [['board-number', 'LA-Z123P', 'la-code']]],
    ['DWG NO 051-9876  REV B', 'title-block', [['board-number', '051-9876', 'schematic-051'], ['revision', 'B', 'letter']]],
    ['SM-G991B', 'name', [['model', 'SM-G991B', 'model-sm']]],
    ['Galaxy SM-A525F', 'folder', [['model', 'SM-A525F', 'model-sm'], ['vendor', 'samsung']]],
    ['CUH-1215A PlayStation', 'name', [['model', 'CUH-1215A', 'sony-console'], ['vendor', 'sony'], ['device-type', 'console']]],
    ['MacBook A1706', 'name', [['model', 'A1706', 'model-a4'], ['vendor', 'apple'], ['device-type', 'laptop']]],
    ['Dell Latitude E7470 laptop', 'folder', [['vendor', 'dell'], ['device-type', 'laptop']]],
    ['EVT2 build', 'header', [['revision', 'EVT2', 'stage']]],
    ['rev 02', 'ocr', [['revision', '2', 'number']]],
    ['MS-17Z9', 'schematic', [['board-number', 'MS-17Z9', 'ms-code']]],
    ['plain words only', 'name', []],
    ['', 'name', []],
  ];
  it.each(rows)('%j from %s', (text, source, expected) => {
    const got = textIdentifiers(text, source);
    const keys = (items: Identifier[]) => items.map(item => [item.kind, item.norm, ...(item.pattern !== undefined ? [item.pattern] : [])].join('|')).sort();
    const want = expected.map(([kind, norm, pattern]) => [kind, norm, ...(pattern !== undefined ? [pattern] : [])].join('|')).sort();
    // The vendor and device rows carry no pattern; compare on kind and norm for them.
    const strip = (list: string[]) => list.map(item => (item.startsWith('vendor|') || item.startsWith('device-type|') ? item.split('|').slice(0, 2).join('|') : item));
    expect(strip(keys(got))).toEqual(strip(want));
    for (const item of got) expect(item.source).toBe(source);
  });

  it('puts the page on every row when it is a page of a PDF', () => {
    for (const row of textIdentifiers('820-01234-A Dell laptop', 'title-block', { page: 3 })) expect(row.page).toBe(3);
    for (const row of textIdentifiers('820-01234-A', 'title-block', { page: 0 })) expect(row.page).toBeUndefined();
    for (const row of textIdentifiers('820-01234-A', 'title-block', { page: 2001 })) expect(row.page).toBeUndefined();
    for (const row of textIdentifiers('820-01234-A', 'title-block', { page: 1.5 })) expect(row.page).toBeUndefined();
    for (const row of textIdentifiers('820-01234-A', 'title-block')) expect(row.page).toBeUndefined();
  });

  it('reads running text in the scope the caller names', () => {
    expect(textIdentifiers('see MS-17Z9 here', 'schematic', { scope: 'body' })).toEqual([]);
    expect(textIdentifiers('see MS-17Z9 here', 'schematic').map(row => row.norm)).toEqual(['MS-17Z9']);
  });

  it('gives each distinct row once and the strongest confidence', () => {
    const rows2 = textIdentifiers('820-01234 and again 820-01234 and Board 820-01234', 'name');
    expect(rows2.filter(row => row.kind === 'board-number')).toHaveLength(1);
    expect(rows2.find(row => row.kind === 'board-number')!.confidence).toBe(90);
  });

  it('lists the strongest rows first and caps their number', () => {
    const many = Array.from({ length: 600 }, (_value, index) => `820-${String(10000 + index)}`).join(' ');
    const rows3 = textIdentifiers(many, 'title-block');
    expect(rows3.length).toBeLessThanOrEqual(MAX_IDENTIFIERS);
    for (let index = 1; index < rows3.length; index++) expect(rows3[index - 1].confidence).toBeGreaterThanOrEqual(rows3[index].confidence);
  });

  it('returns nothing for input that is not text', () => {
    for (const value of [undefined, null, 5, {}, []] as unknown[]) expect(textIdentifiers(value as string, 'name')).toEqual([]);
  });

  it('turns control characters into blanks so that the contract validators accept the row', () => {
    const rows4 = textIdentifiers('820\u000101234', 'name');
    expect(rows4).toHaveLength(1);
    expect(rows4[0].raw).toBe('820 01234');
    expect(validateIndexSummary(documentWith(rows4))).toBe(true);
    expect(cleanRaw('a\u0000b\u001fc\u007fd')).toBe('a b c d');
    expect(cleanRaw('  x  ')).toBe('x');
    expect(cleanRaw('y'.repeat(400))).toHaveLength(256);
  });
});

describe('identifiers: from a relative path', () => {
  it('reads folders, archive and file name with their sources', () => {
    const rows = pathIdentifiers('Lenovo/ThinkPad/NM-A481/NM-A481 schematic REV B.pdf');
    const byKind = (kind: Identifier['kind']) => rows.filter(row => row.kind === kind).map(row => [row.norm, row.source]);
    expect(byKind('board-number').map(row => row.join('|')).sort()).toEqual(['NM-A481|folder', 'NM-A481|name']);
    expect(byKind('revision')).toEqual([['B', 'name']]);
    expect(byKind('vendor').map(row => row[0])).toEqual(['lenovo']);
    expect(byKind('device-type').map(row => row[0])).toEqual(['laptop']);
  });
  it('reads an archive name as an archive', () => {
    const rows = pathIdentifiers('Boards/820-01234.zip/x.brd');
    expect(rows.map(row => [row.kind, row.norm, row.source])).toEqual([['board-number', '820-01234', 'archive']]);
  });
  it('returns nothing for a plain path or for input that is not text', () => {
    expect(pathIdentifiers('misc/notes.txt')).toEqual([]);
    for (const value of [undefined, null, 5, {}] as unknown[]) expect(pathIdentifiers(value as string)).toEqual([]);
  });
});

describe('identifiers: the contract validators accept them', () => {
  const texts = [
    'MacBook Pro 15 820-00875-A rev B', 'Dell Latitude E7470 LA-C281P REV 02', 'iPhone A2111 820-02021', 'SM-G991B Galaxy', 'CUH-1215A', 'DA0X83MB6D0 EVT2', '6050A2423701-MB-A02', 'ＬＡ－Ｚ１２３Ｐ',
    '820‑01234', 'a\u0000820-01234', 'ThinkPad T480 NM-A481 v2.5', 'Quanta Compal Wistron', '', 'lorem ipsum', '48.4ZZ01.011 rev 1.0',
  ];
  it.each(texts)('%j', text => {
    for (const source of ['name', 'folder', 'archive', 'header', 'pdf-metadata', 'outline', 'title-block', 'schematic', 'ocr'] as IdentifierSource[]) {
      const rows = textIdentifiers(text, source, { page: 2 });
      expect(validateIndexSummary(documentWith(rows)), `${source} ${JSON.stringify(rows)}`).toBe(true);
    }
    expect(validateIndexSummary(documentWith(pathIdentifiers(`Folder/${text}/${text}.brd`)))).toBe(true);
  });
  it('holds for any text', () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 200 }).map(codes => String.fromCharCode(...codes)), fc.constantFrom('name', 'folder', 'title-block', 'ocr') as fc.Arbitrary<IdentifierSource>, (text, source) => {
      expect(validateIndexSummary(documentWith(textIdentifiers(text, source, { page: 1 })))).toBe(true);
      expect(validateIndexSummary(documentWith(pathIdentifiers(text)))).toBe(true);
    }), { seed: 20261007, numRuns: 300 });
  });
});

describe('identifiers: part-term keys', () => {
  it('gives the exact form, base, family and category', () => {
    expect(partTermKeys('U7100_ISL95857HRTZ-T')).toEqual({ norm: 'ISL95857HRTZ-T', base: 'ISL95857', family: 'renesas-isl9585x', category: 'vrm-controller' });
    expect(partTermKeys('ABC123')).toEqual({ norm: 'ABC123' });
    expect(partTermKeys('MT41K256M16HA-125:E')).toEqual({ norm: 'MT41K256M16HA-125:E', family: 'micron-mt41k', category: 'dram' });
    expect(partTermKeys('10K 1% 0402')).toBeNull();
  });
  it('builds terms the validators accept for every family example', () => {
    const terms = PART_FAMILIES.flatMap(family => family.examples.slice(0, 1)).slice(0, 200).map(example => {
      const keys = partTermKeys(example)!;
      return { ...keys, tier: 'known', source: 'schematic', refs: [], additionalRefs: 0, pages: [1] };
    });
    expect(validateIndexSummary(documentWith([], terms))).toBe(true);
  });
  it('uses ids of the contract for every family and category', () => {
    for (const family of PART_FAMILIES) {
      expect(/^[A-Za-z0-9_-]{1,64}$/.test(family.id), family.id).toBe(true);
      expect(/^[A-Za-z0-9_-]{1,64}$/.test(family.category), family.category).toBe(true);
    }
  });
});
