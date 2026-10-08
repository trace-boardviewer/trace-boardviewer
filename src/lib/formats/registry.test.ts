import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GenCadParseError } from '../gencad';
import { CERTAIN, defineBoardAdapter, LIKELY, NO_MATCH, SNIFF_BYTES, sniffed, STATUS_VALIDATION, type BoardAdapter, type FormatAdapter } from './adapter';
import { BoardFormatError, TextDecodeError, type ParseInput } from './common';
import { detectFormat, parseBoardDetailed, rankAdapters, sniffInputOf } from './dispatch';
import type { AdapterFixture } from './fixture';
import { parseWith } from './index';
import { BOARD_ADAPTERS, buildFormatsManifest, companionNames, CONTAINER_ADAPTERS, FORMAT_CAPABILITIES, formatsManifestText, SUPPORTED_EXTENSIONS, validateAdapters } from './registry';

const MANIFEST = path.join(process.cwd(), 'electron', 'formats.json');
const FIXTURES = Object.entries(import.meta.glob<AdapterFixture[]>('./adapters/*/fixtures.ts', { eager: true, import: 'default' }))
  .map(([file, list]) => [/adapters\/([^/]+)\/fixtures\.ts$/.exec(file)![1], list] as const);
const fixturesOf = (id: string): readonly AdapterFixture[] => FIXTURES.find(([owner]) => owner === id)?.[1] ?? [];
const ALL_FIXTURES = FIXTURES.flatMap(([owner, list]) => list.map(fixture => ({ owner, fixture })));
const inputOf = (fixture: AdapterFixture): ParseInput => ({ name: fixture.name, data: fixture.data, ...(fixture.companions ? { companions: { ...fixture.companions } } : {}), ...(fixture.options ? { options: fixture.options } : {}) });
const extensionOf = (name: string) => /(\.[^.\\/]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';

/** Which adapter the dispatcher settles on: the container that held the board, the reader that returned it, or the family that refused the bytes. */
function verdict(input: ParseInput, adapters?: readonly BoardAdapter[]): string {
  try { const result = parseBoardDetailed(input, adapters ? { adapters } : {}); return result.container ?? result.adapter; }
  catch (error) {
    if (error instanceof BoardFormatError && (error.code === 'UNSUPPORTED_VARIANT' || error.code === 'AMBIGUOUS_FORMAT' || error.code === 'UNRECOGNIZED')) return error.code === 'UNSUPPORTED_VARIANT' ? `refused:${error.format}` : error.code;
    throw error;
  }
}
/** Whether an adapter's own parse claims the input (a board, or a recognized-but-malformed error). */
function claims(adapter: BoardAdapter, input: ParseInput): boolean {
  try { return parseWith(adapter, input) !== null; }
  catch (error) {
    if (error instanceof TextDecodeError) return false;
    if (error instanceof BoardFormatError || error instanceof GenCadParseError) return true;
    throw error;
  }
}

describe('format registry: one source for every derived table', () => {
  it('electron/formats.json is generated from the registry (regenerate with UPDATE_FORMATS=1)', () => {
    const generated = formatsManifestText();
    if (process.env.UPDATE_FORMATS === '1') writeFileSync(MANIFEST, generated);
    expect(readFileSync(MANIFEST, 'utf8').replace(/\r\n/g, '\n')).toBe(generated);
  });
  it('lists every extension once, in one dialog family, with the companion sets of the adapters', () => {
    const manifest = buildFormatsManifest();
    expect(manifest.extensions).toEqual([...SUPPORTED_EXTENSIONS]);
    expect(new Set(manifest.extensions).size).toBe(manifest.extensions.length);
    const familyExtensions = manifest.families.flatMap(family => family.extensions);
    expect([...familyExtensions].sort()).toEqual([...manifest.extensions].sort());
    for (const family of manifest.families) expect(family.name).toMatch(/^[\x20-\x7e]+$/);
    for (const [member, others] of Object.entries(manifest.companions)) expect(companionNames(member)).toEqual(others);
    expect(Object.isFrozen(SUPPORTED_EXTENSIONS)).toBe(true);
  });
  it('lists the archives after the boards and gives them their own dialog family', () => {
    expect(CONTAINER_ADAPTERS.map(adapter => adapter.id)).toEqual(['zip']);
    expect(SUPPORTED_EXTENSIONS).toContain('.zip');
    expect(buildFormatsManifest().families.find(family => family.name === 'ECAD design')?.extensions).toContain('.zip');
    expect(companionNames('board.zip')).toEqual([]);
  });
  it('orders the tables by listOrder only, and the capability id is the adapter id and folder name', () => {
    expect(BOARD_ADAPTERS.map(adapter => adapter.listOrder)).toEqual([...BOARD_ADAPTERS.map(adapter => adapter.listOrder)].sort((a, b) => a - b));
    expect(FORMAT_CAPABILITIES.map(capability => capability.id)).toEqual(BOARD_ADAPTERS.map(adapter => adapter.id));
    for (const adapter of BOARD_ADAPTERS) {
      expect(adapter.capability.extensions).toEqual(adapter.extensions);
      expect(Object.isFrozen(adapter) && Object.isFrozen(adapter.capability) && Object.isFrozen(adapter.limits), adapter.id).toBe(true);
    }
  });
  it('refuses a malformed registration when the application starts', () => {
    const ok = BOARD_ADAPTERS[0];
    const fake = (overrides: Partial<BoardAdapter>): FormatAdapter => ({ ...ok, ...overrides }) as BoardAdapter;
    const at = (id: string) => `./adapters/${id}/index.ts`;
    expect(() => validateAdapters([[at('x'), undefined as unknown as FormatAdapter]])).toThrow(/must default-export/);
    expect(() => validateAdapters([[at('other'), ok]])).toThrow(/equal its folder name/);
    expect(() => validateAdapters([[at(ok.id), ok], [`./adapters/${ok.id}/index.ts`, ok]])).toThrow(/duplicate adapter id/);
    expect(() => validateAdapters([[at(ok.id), fake({ extensions: ['.CAD'] })]])).toThrow(/extensions/);
    expect(() => validateAdapters([[at(ok.id), fake({ extensions: [] })]])).toThrow(/extensions/);
    expect(() => validateAdapters([[at(ok.id), fake({ family: 'Other' as BoardAdapter['family'] })]])).toThrow(/dialog family/);
    expect(() => validateAdapters([[at(ok.id), fake({ sniff: undefined as unknown as BoardAdapter['sniff'] })]])).toThrow(/sniff/);
    expect(() => validateAdapters([[at(ok.id), fake({ parse: undefined as unknown as BoardAdapter['parse'] })]])).toThrow(/parse/);
    expect(() => validateAdapters([[at(ok.id), fake({ companions: { sets: [['format.asc']] } })]])).toThrow(/companion/);
    expect(() => validateAdapters([[at(ok.id), fake({ apiVersion: 1 as unknown as 2 })]])).toThrow(/must default-export/);
  });
});

describe('capability records: status moves only with evidence', () => {
  it('pairs every status with its validation level and keeps the declared needs consistent', () => {
    for (const adapter of BOARD_ADAPTERS) {
      const c = adapter.capability;
      expect(c.validation, c.id).toBe(STATUS_VALIDATION[c.status]);
      if (c.validation === 'open-tool-files') expect(c.openTool?.tool && c.openTool.designs, c.id).toBeTruthy();
      else expect(c.openTool, c.id).toBeUndefined();
      if (c.status === 'recognized-unsupported' || c.status === 'extension-only') expect(c.electrical, c.id).toBe('none');
      expect(c.requires?.includes('companions') ?? false, `${c.id} companions`).toBe(Boolean(adapter.companions?.sets.length));
      if (c.requires?.includes('key')) expect(adapter.keys?.length, `${c.id} keys`).toBeGreaterThan(0);
      expect(adapter.detection === 'none', `${c.id}: only extension-only families are never detected`).toBe(c.status === 'extension-only');
      expect(c.variants.length && c.notes.length && c.units.length && c.sides.length, c.id).toBeTruthy();
    }
  });
  it('declares budgets no larger than the import limit of the native side', () => {
    for (const adapter of BOARD_ADAPTERS) {
      expect(adapter.limits.maxInputBytes, adapter.id).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(adapter.limits.maxTotalBytes, adapter.id).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(adapter.limits.maxComponents > 0 && adapter.limits.maxPins > 0, adapter.id).toBe(true);
    }
  });
});

describe('extension collisions are resolved by content', () => {
  const owners = new Map<string, BoardAdapter[]>();
  for (const adapter of BOARD_ADAPTERS) for (const extension of adapter.extensions) owners.set(extension, [...owners.get(extension) ?? [], adapter]);
  const shared = [...owners].filter(([, list]) => list.length > 1);

  it('documents the shared extensions (.brd has four owners, .cad two, .bvr two)', () => {
    const ids = (extension: string) => (owners.get(extension) ?? []).map(adapter => adapter.id).sort();
    expect(ids('.brd')).toEqual(['allegro-brd', 'brd', 'brd2', 'eagle']);
    expect(ids('.cad')).toEqual(['gencad', 'samsung-cad']);
    expect(ids('.bvr')).toEqual(['bvr', 'bvr1']);
  });
  it('lets at most one adapter of a shared extension rely on the name, and gives every content rule a fixture', () => {
    for (const [extension, list] of shared) {
      expect(list.filter(adapter => adapter.detection === 'name').length, `${extension}: name-only detectors`).toBeLessThanOrEqual(1);
      for (const adapter of list) if (adapter.detection !== 'none') expect(fixturesOf(adapter.id).length, `${extension}: ${adapter.id} has no fixture`).toBeGreaterThan(0);
    }
  });
  it('gives every detectable adapter at least one fixture with its own extension', () => {
    for (const adapter of [...BOARD_ADAPTERS, ...CONTAINER_ADAPTERS]) {
      if (adapter.detection === 'none') continue;
      const list = fixturesOf(adapter.id);
      expect(list.length, adapter.id).toBeGreaterThan(0);
      for (const fixture of list) expect(adapter.extensions, `${adapter.id}: ${fixture.label}`).toContain(extensionOf(fixture.name));
    }
  });
});

describe('claim-collision matrix: every fixture is read by its own adapter', () => {
  it.each(ALL_FIXTURES.map(({ owner, fixture }) => [`${owner}: ${fixture.label}`, owner, fixture] as const))('%s', (_label, owner, fixture) => {
    const input = inputOf(fixture);
    const expected = fixture.expect === 'refused' ? `refused:${owner}` : owner;
    expect(verdict(input)).toBe(expected);
    const ranked = detectFormat(input);
    expect(ranked[0]?.adapter.id, 'strongest candidate').toBe(owner);
    expect(ranked.filter(candidate => candidate.confidence >= CERTAIN && candidate.adapter.id !== owner).map(candidate => candidate.adapter.id), 'other certain adapters').toEqual([]);
    // The same verdict under any registration order: detection never depends on the order of the folders.
    for (const order of [[...BOARD_ADAPTERS].reverse(), [...BOARD_ADAPTERS].sort((a, b) => (a.id < b.id ? 1 : -1))]) expect(verdict(input, order)).toBe(expected);
  });
  it('a sniff never misses a file its parse would claim (checked against every fixture of every adapter)', () => {
    // Adapters that share one reader (BRD and BRD2, BVR3 and BVR1) split its claim between their sniffs: one of them must see it.
    const siblings = (adapter: BoardAdapter) => BOARD_ADAPTERS.filter(other => other.parse === adapter.parse);
    for (const adapter of BOARD_ADAPTERS) {
      for (const { owner, fixture } of ALL_FIXTURES) {
        const input = inputOf(fixture);
        if (!claims(adapter, input)) continue;
        const seen = Math.max(...siblings(adapter).map(sibling => sibling.sniff(sniffInputOf(input)).confidence));
        expect(seen, `${adapter.id} claims the ${owner} fixture "${fixture.label}" but no sniff of its reader sees it`).toBeGreaterThan(0);
      }
    }
  });
});

describe('known overlaps keep a pinned verdict', () => {
  const text = (rows: readonly string[]) => new TextEncoder().encode(rows.join('\n') + '\n');
  const gencad = fixturesOf('gencad')[0], kicad = fixturesOf('kicad')[0], eagle = fixturesOf('eagle')[1], bvr3 = fixturesOf('bvr')[0], samsung = fixturesOf('samsung-cad')[0], bdv = fixturesOf('bdv')[0];
  const decode = (fixture: AdapterFixture) => new TextDecoder().decode(fixture.data).replace(/\r\n/g, '\n').trimEnd().split('\n');
  const cases: Array<[label: string, input: ParseInput, expected: string]> = [
    ['GenCAD whose $TEXT section mentions the Samsung markers stays GenCAD (GenCAD header outranks markers anywhere)',
      { name: 'board.cad', data: text([...decode(gencad), '$TEXT', '###Panel Added', 'C_PIN', '$ENDTEXT']) }, 'gencad'],
    ['a BVR3 file with a loose "GENCAD 1.4" keyword stays BVR3', { name: 'other.bvr', data: text(['BVRAW_FORMAT_3', '  GENCAD 1.4', ...decode(bvr3).slice(1)]) }, 'bvr'],
    ['a KiCad board whose text holds a BRDOUT: line stays KiCad', { name: 'board.kicad_pcb', data: text([...decode(kicad).slice(0, -1), 'BRDOUT: 4 1000 1000', ...decode(kicad).slice(-1)]) }, 'kicad'],
    ['an EAGLE board with str_length:/var_data: lines in its text stays EAGLE', { name: 'board.brd', data: text([decode(eagle)[0].replace('<drawing>', '<!--\nstr_length:\nvar_data:\n--><drawing>')]) }, 'eagle'],
    ['Samsung markers outrank BDV markers (both found anywhere)', { name: 'mixed.txt', data: text([...decode(samsung), ...decode(bdv)]) }, 'samsung-cad'],
    ['a BRDOUT: line outranks Landrex section lines (one reader for both dialects)', { name: 'board.brd', data: text(['str_length:', 'var_data:', ...decode(fixturesOf('brd2')[0])]) }, 'brd2'],
    ['a KiCad root and a GenCAD $HEADER line are both certain: refused as ambiguous', { name: 'board.kicad_pcb', data: text([...decode(kicad), '$HEADER']) }, 'AMBIGUOUS_FORMAT'],
    ['an XZZ header with the CST section signature at offset 6 is refused as ambiguous', { name: 'board.pcb', data: Uint8Array.from([...new TextEncoder().encode('XZZPCB'), 4, 0, 0x43, 0x44, 0x65, 0x76, ...new Uint8Array(64)]) }, 'AMBIGUOUS_FORMAT'],
  ];
  it.each(cases)('%s', (_label, input, expected) => expect(verdict(input)).toBe(expected));
});

describe('a sniff does not overclaim a signature that other kinds of file share', () => {
  const strength = (name: string, data: Uint8Array, id: string) => detectFormat({ name, data }).find(candidate => candidate.adapter.id === id)?.confidence ?? 0;
  const eagleDocument = (kind: 'schematic' | 'board' | 'library') => new TextEncoder().encode(`<?xml version="1.0"?><eagle version="9.6.2"><drawing><settings/><layers/><${kind}></${kind}></drawing></eagle>`);
  const compound = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Uint8Array(600)]);
  it('keeps an EAGLE schematic below LIKELY (it is not a board) while an EAGLE board and library stay CERTAIN', () => {
    expect(strength('board.sch', eagleDocument('schematic'), 'eagle')).toBeGreaterThan(0);
    expect(strength('board.sch', eagleDocument('schematic'), 'eagle')).toBeLessThan(LIKELY);
    expect(strength('board.brd', eagleDocument('schematic'), 'eagle')).toBeLessThan(LIKELY);
    expect(strength('board.brd', eagleDocument('board'), 'eagle')).toBeGreaterThanOrEqual(CERTAIN);
    expect(strength('parts.lbr', eagleDocument('library'), 'eagle')).toBeGreaterThanOrEqual(CERTAIN); // refused with a precise message, never passed over
    expect(verdict({ name: 'board.sch', data: eagleDocument('schematic') })).toBe('UNRECOGNIZED');
  });
  it('lets a text reader wait for markers beyond the window only behind a head without NUL bytes: random binary bytes of a large file match no reader', () => {
    let seed = 7;
    const binary = Uint8Array.from({ length: SNIFF_BYTES }, () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 24);
    const blanks = new TextEncoder().encode(' '.repeat(SNIFF_BYTES));
    const everyone = [...BOARD_ADAPTERS, ...CONTAINER_ADAPTERS];
    for (const name of ['data.bin', 'export 16.img', 'system.old', 'notes.txt']) {
      expect(rankAdapters({ head: binary, name, size: 64 * SNIFF_BYTES }, everyone).map(candidate => candidate.adapter.id), name).toEqual([]);
    }
    // The same size behind a text head keeps the readers that may still find their markers further down.
    expect(rankAdapters({ head: blanks, name: 'data.txt', size: 64 * SNIFF_BYTES }, everyone).map(candidate => candidate.adapter.id)).toEqual(expect.arrayContaining(['samsung-cad', 'bdv', 'bvr', 'brd', 'hyperlynx']));
  });
  it('is CERTAIN about an OLE compound file only under an Altium PCB name, and POSSIBLE under any other (spreadsheets, schematics)', () => {
    for (const name of ['board.pcbdoc', 'BOARD.PCBDOC', 'panel.cmpcbdoc', 'panel.cspcbdoc']) expect(strength(name, compound, 'altium'), name).toBeGreaterThanOrEqual(CERTAIN);
    for (const name of ['bom.xls', 'sheet.schdoc', 'notes', 'file.dat']) {
      expect(strength(name, compound, 'altium'), name).toBeGreaterThan(0); // still claimed by its parse, which names what the file is
      expect(strength(name, compound, 'altium'), name).toBeLessThan(LIKELY);
    }
  });
});

describe('the dispatcher', () => {
  const board = (name: string) => ({ name, units: 'mm' as const, format: name, components: [], pins: [], nets: [], outline: [], bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, warnings: [] });
  const adapter = (id: string, confidence: number, result: 'board' | 'null' | 'throw' = 'board') => defineBoardAdapter({
    capability: { id, name: `Test ${id}`, extensions: ['.tst'], variants: ['v'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated', units: 'mm', sides: 's', notes: ['n'] },
    listOrder: 1, family: 'Boardview', detection: 'signature',
    sniff: () => confidence ? sniffed(confidence, `${id} evidence`) : NO_MATCH,
    parse: () => { if (result === 'throw') throw new RangeError('boom'); return result === 'null' ? null : board(id); },
  });
  const input = { name: 'x.tst', data: new Uint8Array([1, 2, 3]) };
  it('parses the strongest candidate, falls through a declining one, and never calls a sniff of 0', () => {
    expect(parseBoardDetailed(input, { adapters: [adapter('weak', 20), adapter('strong', 80)] }).adapter).toBe('strong');
    expect(parseBoardDetailed(input, { adapters: [adapter('weak', 20), adapter('strong', 80, 'null')] })).toMatchObject({ adapter: 'weak', confidence: 20, reason: 'weak evidence' });
    expect(() => parseBoardDetailed(input, { adapters: [adapter('zero', 0, 'throw')] })).toThrow(expect.objectContaining({ code: 'UNRECOGNIZED' }));
  });
  it('refuses two certain board adapters instead of letting either win, with a catalog message', () => {
    let caught: unknown;
    try { parseBoardDetailed(input, { adapters: [adapter('one', 95), adapter('two', CERTAIN)] }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(BoardFormatError);
    expect(caught).toMatchObject({ code: 'AMBIGUOUS_FORMAT', issue: { key: 'parse.error.ambiguousFormat', params: { file: 'x.tst', formats: 'Test one, Test two' } } });
  });
  it('wraps an unexpected failure with the adapter id and checks the declared record budgets', () => {
    expect(() => parseBoardDetailed(input, { adapters: [adapter('boom', 60, 'throw')] })).toThrow(/^boom: unexpected parser failure: boom/);
    const many = defineBoardAdapter({ ...adapter('many', 60), limits: { maxPins: 0, maxComponents: 0 }, parse: () => ({ ...board('many'), components: [{} as never] }) });
    expect(() => parseBoardDetailed(input, { adapters: [many] })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    const small = defineBoardAdapter({ ...adapter('small', 60), limits: { maxInputBytes: 2 } });
    expect(() => parseBoardDetailed(input, { adapters: [small] })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });
});
