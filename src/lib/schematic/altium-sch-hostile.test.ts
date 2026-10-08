import { expectScaling, expectCostAtMost, linearReference } from '../../test-support/timing';
import { describe, expect, it } from 'vitest';
import { ALTIUM_SCH_LIMITS, parseAltiumSch } from './altium-sch';
import { computeConnectivity } from './connectivity';
import {
  ASCII_HEADER, concat, container, def, divider, enc, framed, lower, must, parse, prng, recordText, Sheet, symbolOf, thrown, codes, HEADER,
} from './altium-sch-fixtures';
import { SchematicError, SCHEMATIC_LIMITS, type Schematic, type SchematicErrorCode } from './model';

// Malformed and hostile input: every failure is a structured SchematicError, nothing hangs, and the work stays linear in the input.

const u32at = (data: Uint8Array, at: number): number => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);
const setU32 = (data: Uint8Array, at: number, value: number): void => new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(at, value, true);
const sectorAt = (index: number): number => (index + 1) * 512;
/** Sector chain entry of the regular FAT. */
const fatAt = (data: Uint8Array, sector: number): number => sectorAt(u32at(data, 76 + 4 * Math.floor(sector / 128))) + 4 * (sector % 128);
/** Offset of the directory entry called `name` (the first directory sector holds the root and both streams of these fixtures). */
function entryOf(data: Uint8Array, name: string): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength), first = sectorAt(u32at(data, 48));
  for (let offset = first; offset < first + 512; offset += 128) {
    let text = '';
    for (let k = 0; k < view.getUint16(offset + 64, true) / 2 - 1; k++) text += String.fromCharCode(view.getUint16(offset + 2 * k, true));
    if (text === name) return offset;
  }
  throw new Error(`no directory entry ${name}`);
}

/** A sheet whose FileHeader stream is large enough for the regular FAT (over 4096 bytes). */
function bigSheet(parts = 60): Sheet {
  const s = new Sheet({ SheetStyle: 0 });
  for (let k = 0; k < parts; k++) { s.res(`R${k + 1}`, 100 + 50 * (k % 20), 500 - 30 * Math.floor(k / 20)); s.wire([120 + 50 * (k % 20), 500 - 30 * Math.floor(k / 20)], [130 + 50 * (k % 20), 500 - 30 * Math.floor(k / 20)]); }
  return s;
}

const ALLOWED: SchematicErrorCode[] = ['INVALID_FORMAT', 'LIMIT_EXCEEDED', 'UNSUPPORTED_VARIANT'];

/** Structural invariants every parse result must satisfy, whatever the input was. */
function invariants(s: Schematic): void {
  expect(s.defs.length).toBeGreaterThan(0);
  expect(new Set(s.defs.map(d => d.id)).size).toBe(s.defs.length);
  expect(new Set(s.instances.map(i => i.path)).size).toBe(s.instances.length);
  for (const d of s.defs) {
    for (const list of [d.symbols.map(x => x.id), d.wires.map(x => x.id), d.labels.map(x => x.id), d.junctions.map(x => x.id), d.noConnects.map(x => x.id), d.sheetRefs.map(x => x.id)]) expect(new Set(list).size).toBe(list.length);
    for (const symbol of d.symbols) expect(new Set(symbol.pins.map(p => p.id)).size).toBe(symbol.pins.length);
    const points = [...d.wires.flatMap(w => [w.a, w.b]), ...d.junctions.map(j => j.at), ...d.symbols.flatMap(x => x.pins.map(p => p.at)), ...d.labels.map(l => l.at)];
    for (const p of points) { expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true); expect(Math.abs(p.x) <= SCHEMATIC_LIMITS.maxCoordinateMm && Math.abs(p.y) <= SCHEMATIC_LIMITS.maxCoordinateMm).toBe(true); }
    for (const v of [d.bounds.minX, d.bounds.minY, d.bounds.maxX, d.bounds.maxY]) expect(Number.isFinite(v)).toBe(true);
  }
}
/** Runs the parser and the engine: a SchematicError, a null or a sane result; any other exception fails the test. */
function outcome(data: Uint8Array, companions?: Record<string, Uint8Array>): 'error' | 'null' | 'ok' {
  let result: Schematic | null;
  try { result = parseAltiumSch({ name: 'Fuzz.SchDoc', data, ...(companions ? { companions } : {}) }); }
  catch (error) {
    expect(error).toBeInstanceOf(SchematicError);
    expect(ALLOWED).toContain((error as SchematicError).code);
    expect((error as SchematicError).format).toBe('altium-sch');
    return 'error';
  }
  if (!result) return 'null';
  invariants(result);
  try { computeConnectivity(result); }
  catch (error) { expect(error).toBeInstanceOf(SchematicError); }
  return 'ok';
}

describe('damaged OLE containers', () => {
  const valid = bigSheet().file();
  const mutate = (change: (data: Uint8Array) => void): Uint8Array => { const copy = valid.slice(); change(copy); return copy; };
  const fails = (data: Uint8Array, code: SchematicErrorCode, message: RegExp): void => { expect(thrown(() => parse(data), code).message).toMatch(message); };

  it('reads the undamaged file', () => { expect(def(must(valid)).symbols).toHaveLength(60); });

  it('rejects header damage with a precise reason', () => {
    fails(mutate(d => { d[28] = 0; }), 'INVALID_FORMAT', /byte-order/);
    fails(mutate(d => { d[30] = 12; d[26] = 4; }), 'UNSUPPORTED_VARIANT', /version 4/);
    fails(mutate(d => { d[30] = 10; }), 'INVALID_FORMAT', /unsupported layout/);
    fails(mutate(d => { d[32] = 7; }), 'INVALID_FORMAT', /unsupported layout/);
    fails(mutate(d => setU32(d, 56, 8192)), 'INVALID_FORMAT', /unsupported layout/);
    fails(mutate(d => setU32(d, 44, 0xffffffff)), 'INVALID_FORMAT', /declares 4294967295 FAT/);
    fails(mutate(d => setU32(d, 44, 0)), 'INVALID_FORMAT', /declares 0 FAT/);
    fails(mutate(d => setU32(d, 72, 0x7fffffff)), 'INVALID_FORMAT', /DIFAT/);
    fails(mutate(d => setU32(d, 76, 0xfffffffe)), 'INVALID_FORMAT', /outside the file/);
    fails(mutate(d => setU32(d, 48, 0xfffffffe)), 'INVALID_FORMAT', /no directory/);
    fails(mutate(d => setU32(d, 48, 9999)), 'INVALID_FORMAT', /leaves the file/);
    fails(mutate(d => { const first = u32at(d, 48); setU32(d, fatAt(d, first), first); }), 'INVALID_FORMAT', /looping directory chain/);
  });

  it('rejects truncated files', () => {
    fails(valid.subarray(0, 511), 'INVALID_FORMAT', /shorter than its 512-byte header/);
    fails(valid.subarray(0, 700), 'INVALID_FORMAT', /outside the file|fewer FAT|declares/);
    fails(valid.subarray(0, valid.length - 700), 'INVALID_FORMAT', /outside the file|ends after/);
  });

  it('rejects stream chains that loop, end early or claim more than the file holds', () => {
    const at = entryOf(valid, 'FileHeader');
    expect(u32at(valid, at + 120)).toBeGreaterThan(4096); // regular FAT chain
    const first = u32at(valid, at + 116);
    fails(mutate(d => setU32(d, fatAt(d, first), first)), 'INVALID_FORMAT', /loops back to sector/);
    fails(mutate(d => setU32(d, fatAt(d, first), 0xfffffffe)), 'INVALID_FORMAT', /ends after 1 of \d+ sectors/);
    fails(mutate(d => setU32(d, at + 120, valid.length + 4000)), 'INVALID_FORMAT', /needs \d+ sectors|claims/);
    fails(mutate(d => setU32(d, at + 120, 0x7fffffff)), 'LIMIT_EXCEEDED', /extraction budget/);
    fails(mutate(d => setU32(d, at + 116, 0x00ffffff)), 'INVALID_FORMAT', /ends after 0 of/);
  });

  it('rejects mini-stream chains that loop or leave the mini FAT', () => {
    const small = divider().file();
    const at = entryOf(small, 'FileHeader');
    expect(u32at(small, at + 120)).toBeLessThan(4096);
    const start = u32at(small, at + 116), miniFat = sectorAt(u32at(small, 60));
    const loop = small.slice(); setU32(loop, miniFat + start * 4, start);
    expect(thrown(() => parse(loop), 'INVALID_FORMAT').message).toMatch(/invalid mini-sector chain/);
    const lost = small.slice(); setU32(lost, miniFat + start * 4, 0xfffffffe);
    expect(thrown(() => parse(lost), 'INVALID_FORMAT').message).toMatch(/invalid mini-sector chain/);
    const outside = small.slice(); setU32(outside, at + 116, 0x7fffff);
    expect(thrown(() => parse(outside), 'INVALID_FORMAT').message).toMatch(/invalid mini-sector chain/);
  });

  it('rejects directory trees that revisit entries or use the root as a child', () => {
    const small = divider().file();
    const stream = entryOf(small, 'FileHeader');
    const sibling = small.slice(); setU32(sibling, stream + 68, 0);
    expect(thrown(() => parse(sibling), 'INVALID_FORMAT').message).toMatch(/type 5|linked twice/);
    const rootless = small.slice(); rootless[sectorAt(u32at(small, 48)) + 66] = 1;
    expect(thrown(() => parse(rootless), 'INVALID_FORMAT').message).toMatch(/no root entry/);
    const kind = small.slice(); kind[stream + 66] = 9;
    expect(thrown(() => parse(kind), 'INVALID_FORMAT').message).toMatch(/unknown type 9/);
  });
});

describe('damaged record streams', () => {
  const doc = (...tail: Uint8Array[]): Uint8Array => container({ FileHeader: concat(framed(HEADER), ...tail) });

  it('rejects a stream that stops inside a record length or a record', () => {
    const sheet = divider(), full = sheet.stream();
    const starts: number[] = [];
    for (let at = framed(HEADER).length, k = 0; k < sheet.items.length; k++) { starts.push(at); const item = sheet.items[k]; at += 'raw' in item ? item.raw.length : framed(recordText(item.rec)).length; }
    expect(starts.at(-1)).toBeLessThan(full.length);
    for (const start of [starts[0], starts[3], starts[10], starts.at(-1)!]) for (const inside of [1, 3, 9]) thrown(() => parse(container({ FileHeader: full.subarray(0, start + inside) })), 'INVALID_FORMAT');
    expect(def(must(container({ FileHeader: full.subarray(0, starts[5]) }))).symbols.length).toBeGreaterThanOrEqual(0); // cut exactly between two records: a shorter, valid document
    expect(thrown(() => parse(container({ FileHeader: concat(framed(HEADER), [1, 2]) })), 'INVALID_FORMAT').message).toMatch(/length is incomplete/);
    expect(thrown(() => parse(container({ FileHeader: concat(framed(HEADER), [200, 0, 0, 0, 65]) })), 'INVALID_FORMAT').message).toMatch(/200 bytes is declared/);
  });

  it('rejects a binary first record and an oversized record', () => {
    expect(parse(container({ FileHeader: framed(HEADER, 1) }))).toBeNull(); // not a text header: not a SchDoc at all
    const big = enc.encode(`|RECORD=4|Text=${'a'.repeat(ALTIUM_SCH_LIMITS.maxRecordBytes)}`);
    const err = thrown(() => parse(container({ FileHeader: concat(framed(HEADER), [big.length & 255, big.length >>> 8 & 255, big.length >>> 16 & 255, 0], big) })), 'LIMIT_EXCEEDED');
    expect(err.message).toMatch(/exceeds the \d+ byte limit/);
    expect(err.format).toBe('altium-sch');
  });

  it('counts binary-flagged records as records (so OwnerIndex stays right) and reports them', () => {
    const s = new Sheet({ SheetStyle: 0 });
    s.binary(); s.binary([9, 9]);
    s.res('R1', 200, 500);
    s.wire([220, 500], [240, 500]); s.label('N', 240, 500);
    const r = must(s.file());
    expect(symbolOf(def(r), 'R1').pins).toHaveLength(2);
    expect(r.diagnostics.find(d => d.code === 'BINARY_RECORD_SKIPPED')?.message).toMatch(/^2 binary-flagged/);
    expect(computeConnectivity(r).nets.map(n => n.name)).toEqual(['N']);
  });

  it('survives OwnerIndex values that point at themselves, forward, nowhere or in a loop', () => {
    const s = new Sheet({ SheetStyle: 0 });
    const part = s.res('R1', 200, 500);
    s.add(2, { OwnerIndex: 999999, Designator: '9', 'Location.X': 1, 'Location.Y': 1 });
    s.add(2, { OwnerIndex: s.count + 1, Designator: '8', 'Location.X': 1, 'Location.Y': 1 }); // owned by the next record
    s.add(34, { OwnerIndex: s.count, Text: 'SELF' }); // its own owner
    s.add(2, { OwnerIndex: -5, Designator: '7' });
    const a = s.add(13, { OwnerIndex: s.count + 1, 'Location.X': 1, 'Location.Y': 1, 'Corner.X': 2, 'Corner.Y': 2 });
    s.add(13, { OwnerIndex: a, 'Location.X': 1, 'Location.Y': 1, 'Corner.X': 2, 'Corner.Y': 2 }); // a and this one own each other
    const r = must(s.file());
    expect(symbolOf(def(r), 'R1').pins.map(p => p.number)).toEqual(['1', '2']);
    expect(part).toBeGreaterThan(0);
    expect(() => computeConnectivity(r)).not.toThrow();
  });

  it('rejects numbers that are not numbers, with the record and key in the message', () => {
    const bad = (rec: Record<string, string | number>, record = 27) => { const s = new Sheet({ SheetStyle: 0 }); s.add(record, rec); return thrown(() => parse(s.file()), 'INVALID_FORMAT'); };
    expect(bad({ LocationCount: 'abc' }).message).toMatch(/LOCATIONCOUNT is not an integer/);
    expect(bad({ LocationCount: 2, X1: '1e999', Y1: 0 }).message).toMatch(/X1 is not a number/);
    expect(bad({ LocationCount: 2, X1: 'NaN', Y1: 0 }).message).toMatch(/X1 is not a number/);
    expect(bad({ LocationCount: 2, X1: '0x10', Y1: 0 }).message).toMatch(/not a number/);
    expect(bad({ 'Location.X': 1, 'Location.Y': 2, Orientation: '1.5', Text: 'x' }, 25).message).toMatch(/ORIENTATION is not an integer/);
    expect(bad({ 'Location.X': 1, 'Location.Y': 2, 'Location.X_Frac': 'x', Text: 'x' }, 25).message).toMatch(/is not a number/);
  });

  it('rejects coordinates beyond the import limit and vertex counts beyond the vertex limit', () => {
    const far = new Sheet({ SheetStyle: 0 }); far.wire([0, 0], [99999999999, 0]);
    expect(thrown(() => parse(far.file()), 'LIMIT_EXCEEDED').message).toMatch(/coordinate exceeds/);
    const many = new Sheet({ SheetStyle: 0 }); many.add(27, { LocationCount: ALTIUM_SCH_LIMITS.maxVertices + 1, X1: 1, Y1: 1 });
    expect(thrown(() => parse(many.file()), 'LIMIT_EXCEEDED').message).toMatch(/vertices \(limit/);
    const edge = new Sheet({ SheetStyle: 0 }); edge.add(27, { LocationCount: ALTIUM_SCH_LIMITS.maxVertices, X1: 1, Y1: 1 });
    expect(codes(must(edge.file()))).toContain('VERTEX_COUNT_MISMATCH');
  });

  it('holds sizes and radii to the coordinate limit too: a corner computed from them must stay finite', () => {
    // A sheet symbol 1e308 units wide used to give an infinite size (the rounding multiplies by a million) and infinite sheet bounds.
    for (const size of [1e308, 1e12, 3e9]) {
      const wide = new Sheet({ SheetStyle: 0 }); wide.sheetSymbol({ name: 'S', file: 'child.SchDoc', x: 100, y: 600, w: size, h: 20 });
      expect(thrown(() => parse(wide.file()), 'LIMIT_EXCEEDED').message, `symbol ${size}`).toMatch(/coordinate exceeds/);
      const round = new Sheet({ SheetStyle: 0 }); round.add(8, { 'Location.X': 100, 'Location.Y': 100, Radius: size, OwnerPartId: -1 });
      expect(thrown(() => parse(round.file()), 'LIMIT_EXCEEDED').message, `circle ${size}`).toMatch(/coordinate exceeds/);
    }
    const fine = new Sheet({ SheetStyle: 0 }); fine.sheetSymbol({ name: 'S', file: 'child.SchDoc', x: 100, y: 600, w: 200, h: 100 });
    fine.add(8, { 'Location.X': 300, 'Location.Y': 300, Radius: 40, OwnerPartId: -1 });
    const sheet = def(must(fine.file()));
    expect(sheet.sheetRefs[0].size).toEqual({ x: 50.8, y: 25.4 });
    expect(Number.isFinite(sheet.bounds.maxX) && Number.isFinite(sheet.bounds.maxY)).toBe(true);
  });

  it('does not loop over the vertices a record only claims', () => {
    const s = new Sheet({ SheetStyle: 0 });
    for (let k = 0; k < 3000; k++) s.add(27, { LocationCount: ALTIUM_SCH_LIMITS.maxVertices, X1: 1 + k, Y1: 1, X2: 2 + k, Y2: 1, X99999: 5 });
    const data = s.ascii();
    expectCostAtMost('bounded schematic matching', () => must(data), linearReference(data.length), 300);
    const r = must(data);

    expect(def(r).wires.length).toBeGreaterThanOrEqual(3000);
    expect(def(r).wires.length).toBeLessThanOrEqual(6000); // only the keys the record really has are read: v1, v2 and the claimed-but-absent vertices at the origin
  }, 300_000);

  it('takes the first of a duplicated key and ignores keys without a value and records it does not know', () => {
    const text = enc.encode(`${ASCII_HEADER}

|RECORD=31|SheetStyle=0|

|RECORD=27|LocationCount=2|LocationCount=9|X1=100|X1=500|Y1=100|X2=200|Y2=100|NoValue|=empty|

|RECORD=999|Foo=bar|

|RECORD=-4|

|RECORD=1000000|OwnerIndex=-1|

`);
    const r = must(text);
    expect(def(r).wires).toHaveLength(1);
    expect(def(r).wires[0].a.x).toBeCloseTo(100 * 0.254, 6);
    expect(r.diagnostics.filter(d => d.code === 'UNKNOWN_RECORD').map(d => d.message)).toEqual(expect.arrayContaining([expect.stringContaining('RECORD=999')]));
  });
});

describe('line-based export', () => {
  const header = '|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=0';
  const lines = (...rest: string[]): Uint8Array => enc.encode([header, ...rest].join('\r\n') + '\r\n');

  it('rejects a record line that does not start with a bar, and an export without records', () => {
    expect(thrown(() => parse(lines('|RECORD=31|', 'garbage')), 'INVALID_FORMAT').message).toMatch(/does not start with/);
    const empty = must(enc.encode(header));
    expect(def(empty).symbols).toEqual([]);
    expect(codes(empty)).toContain('SHEET_RECORD_MISSING');
    expect(def(must(lines())).symbols).toEqual([]);
  });

  it('stops at the second header and reads nothing after it', () => {
    const r = must(lines('|RECORD=31|SheetStyle=0|', '|HEADER=Icon storage|WEIGHT=2', 'this is not even a record', '|RECORD=1|LibReference=X|'));
    expect(def(r).symbols).toEqual([]);
    expect(codes(r)).toContain('STORAGE_SKIPPED');
  });

  it('rejects a record line over the record size limit and a document over the record count limit', () => {
    expect(thrown(() => parse(lines(`|RECORD=4|Text=${'x'.repeat(ALTIUM_SCH_LIMITS.maxRecordBytes + 10)}|`)), 'LIMIT_EXCEEDED').message).toMatch(/ASCII record of \d+ bytes exceeds/);
    const unit = enc.encode('|RECORD=9|\n'), count = ALTIUM_SCH_LIMITS.maxRecords + 1;
    const big = new Uint8Array(header.length + 1 + unit.length * count);
    big.set(enc.encode(`${header}\n`)); for (let k = 0; k < count; k++) big.set(unit, header.length + 1 + k * unit.length);
    expect(thrown(() => parse(big), 'LIMIT_EXCEEDED').message).toMatch(/more than 1000000 records/);
  });
});

describe('projects and hierarchy limits', () => {
  /** An ASCII sheet that names `children` sheet symbols, each pointing at `prefix + k`. */
  const parent = (files: string[]): Sheet => { const s = new Sheet({ SheetStyle: 0 }); files.forEach((file, k) => s.sheetSymbol({ name: `S${k}`, file, x: 100 + (k % 30) * 30, y: 600 - Math.floor(k / 30) * 30, w: 20, h: 20 })); return s; };
  const leaf = (): Uint8Array => new Sheet({ SheetStyle: 0 }).ascii();

  it('never reads an inherited object property as a sheet file', () => {
    const r = must(parent(['__proto__', 'constructor', 'toString', 'hasOwnProperty.SchDoc']).ascii(), 'Top.SchDoc', {});
    expect(r.defs).toHaveLength(1);
    expect(r.diagnostics.filter(d => d.code === 'SHEET_FILE_MISSING')).toHaveLength(4);
    expect(def(r).sheetRefs.map(x => x.defId)).toEqual([null, null, null, null]);
  });

  it('stops at the sheet count limit', () => {
    const names = Array.from({ length: SCHEMATIC_LIMITS.maxSheetDefs + 5 }, (_, k) => `c${k}.SchDoc`);
    const files = lower(Object.fromEntries(names.map(n => [n, leaf()])));
    expect(thrown(() => parse(parent(names).ascii(), 'Top.SchDoc', files), 'LIMIT_EXCEEDED').message).toMatch(/more than 256 sheets/);
  });

  it('stops a hierarchy that expands past the instance limit', () => {
    const wide = Array.from({ length: 70 }, (_, k) => `leaf${k}.SchDoc`);
    const mid = parent(wide).ascii();
    const files: Record<string, Uint8Array> = { 'mid.schdoc': mid };
    for (const n of wide) files[n.toLowerCase()] = leaf();
    const top = parent(Array.from({ length: 70 }, () => 'Mid.SchDoc'));
    expect(thrown(() => parse(top.ascii(), 'Top.SchDoc', files), 'LIMIT_EXCEEDED').message).toMatch(/more than 4096 sheet instances/);
  });

  it('stops a very deep chain of sheets with a diagnostic instead of recursing without end', () => {
    const files: Record<string, Uint8Array> = {};
    const depth = SCHEMATIC_LIMITS.maxNestingDepth + 20;
    for (let k = 1; k < depth; k++) files[`level${k}.schdoc`] = parent([`Level${k + 1}.SchDoc`]).ascii();
    const r = must(parent(['Level1.SchDoc']).ascii(), 'Top.SchDoc', files);
    expect(r.instances.length).toBeLessThanOrEqual(SCHEMATIC_LIMITS.maxNestingDepth + 1);
    expect(r.diagnostics.some(d => d.code === 'SHEET_CYCLE' && d.severity === 'error')).toBe(true);
  });

  it('ignores a project file that is not a project, is too large or lists too many documents', () => {
    const s = divider();
    const withProject = (bytes: Uint8Array) => must(s.file(), 'Test.SchDoc', lower({ 'Bad.PrjPcb': bytes }));
    expect(codes(withProject(new Uint8Array([0xff, 0xfe, 0, 1])))).toContain('PROJECT_NOT_USED');
    expect(codes(withProject(enc.encode('[Design]\nHierarchyMode=banana\n')))).toContain('PROJECT_NOT_USED');
    expect(codes(withProject(new Uint8Array(ALTIUM_SCH_LIMITS.maxProjectBytes + 1).fill(0x41)))).toContain('PROJECT_UNREADABLE');
    const docs = Array.from({ length: ALTIUM_SCH_LIMITS.maxProjectDocuments + 1 }, (_, k) => `[Document${k + 1}]\nDocumentPath=D${k}.SchDoc\n`).join('');
    expect(codes(withProject(enc.encode(docs)))).toContain('PROJECT_UNREADABLE');
  });
});

describe('mutation fuzz (seeded)', () => {
  const sources = { container: divider().file(), stream: divider().stream(), ascii: divider().ascii() };
  const mutated = (random: () => number, bytes: Uint8Array): Uint8Array => {
    const out = bytes.slice();
    const edits = 1 + Math.floor(random() * 6);
    for (let k = 0; k < edits; k++) {
      const at = Math.floor(random() * out.length);
      switch (Math.floor(random() * 4)) {
        case 0: out[at] = Math.floor(random() * 256); break;
        case 1: out[at] ^= 1 << Math.floor(random() * 8); break;
        case 2: out.fill(Math.floor(random() * 256), at, Math.min(out.length, at + 1 + Math.floor(random() * 16))); break;
        default: out.copyWithin(at, Math.floor(random() * out.length), Math.min(out.length, Math.floor(random() * out.length) + 24)); break;
      }
    }
    return random() < 0.1 ? out.subarray(0, Math.floor(random() * out.length)) : out;
  };

  it('answers every damaged container with a result or a SchematicError', () => {
    const random = prng(20261007), tally = { error: 0, null: 0, ok: 0 };
    for (let k = 0; k < 400; k++) tally[outcome(mutated(random, sources.container))]++;
    expect(tally.error).toBeGreaterThan(20);
    expect(tally.error + tally.null + tally.ok).toBe(400);
  }, 300_000);

  it('answers every damaged record stream (re-wrapped in a valid container) with a result or a SchematicError', () => {
    const random = prng(7), tally = { error: 0, null: 0, ok: 0 };
    for (let k = 0; k < 600; k++) tally[outcome(container({ FileHeader: mutated(random, sources.stream) }))]++;
    expect(tally.ok).toBeGreaterThan(20);
    expect(tally.error).toBeGreaterThan(20);
  }, 300_000);

  it('answers every damaged line-based export with a result or a SchematicError', () => {
    const random = prng(99), tally = { error: 0, null: 0, ok: 0 };
    for (let k = 0; k < 600; k++) tally[outcome(mutated(random, sources.ascii))]++;
    expect(tally.ok + tally.null).toBeGreaterThan(20);
    expect(tally.ok + tally.error + tally.null).toBe(600);
  }, 300_000);

  it('is not confused by random bytes behind a valid header', () => {
    const random = prng(5);
    for (let k = 0; k < 100; k++) {
      const noise = new Uint8Array(200 + Math.floor(random() * 2000)).map(() => Math.floor(random() * 256));
      outcome(container({ FileHeader: concat(framed(HEADER), noise) }));
      outcome(concat(enc.encode(`${HEADER.replace('Binary', 'Ascii')}\r\n`), noise));
    }
  });
});

describe('scaling', () => {
  /** n resistors in rows of 200, chained by wires, with a net label on every seventh. */
  function ladder(n: number): Sheet {
    const s = new Sheet({ SheetStyle: 4 });
    for (let k = 0; k < n; k++) {
      const x = 100 + (k % 200) * 60, y = 200 + Math.floor(k / 200) * 40;
      s.res(`R${k + 1}`, x, y);
      if (k % 200 !== 199) s.wire([x + 20, y], [x + 40, y]);
      if (k % 7 === 0) s.label(`N${k}`, x + 30, y);
    }
    return s;
  }

  it('parses and connects in time proportional to the size of the sheet', () => {
    expectScaling('schematic records and connectivity', [750, 3000, 12000], n => { const data = ladder(n).ascii(); return () => computeConnectivity(must(data)); });
  }, 300_000);

  it('reads the same sheet from a compound file in comparable time', () => {
    const sheet = ladder(3000);
    const compound = sheet.file(), ascii = sheet.ascii();
    expectCostAtMost('compound schematic', () => must(compound), () => must(ascii), 10);
    const r = must(compound);
    expect(def(r).symbols).toHaveLength(3000);
    expect(def(r).wires).toHaveLength(3000 - 15);
  }, 300_000);

  it('keeps pin matching bounded when thousands of pin and wire ends share one spot', () => {
    const s = new Sheet({ SheetStyle: 0 });
    const N = 20000;
    s.part({ ref: 'U1', x: 500, y: 500, pins: Array.from({ length: N }, (_, k) => ({ n: String(k + 1), x: 500, y: 500, dir: 0 as const, len: 10 })) });
    s.items.forEach((item, k) => { if ('rec' in item && item.rec.RECORD === 2) item.rec['Location.X_Frac'] = (k * 3) % 99999; });
    for (let k = 0; k < N; k++) s.add(27, { LocationCount: 2, X1: 510, X1_Frac: (k * 3 + 1) % 99999, Y1: 500, X2: 600, Y2: 600 + (k % 100) });
    const data = s.ascii();
    expectCostAtMost('bounded schematic matching', () => must(data), linearReference(data.length), 300);
    const r = must(data);

    expect(r.diagnostics.some(d => d.code === 'SNAP_SITES_DROPPED')).toBe(true);
    expect(def(r).symbols[0].pins).toHaveLength(N);
  }, 300_000);

  it('bounds the work for diagonal wires and ports stacked on one spot', () => {
    const s = new Sheet({ SheetStyle: 4 });
    for (let k = 0; k < 4000; k++) s.wire([100, 100 + (k % 5)], [3000 + (k % 7), 2800]);
    for (let k = 0; k < 4000; k++) s.port({ name: `P${k}`, x: 1500, y: 1500 + (k % 3), width: 20 });
    const data = s.ascii();
    expectCostAtMost('bounded schematic matching', () => must(data), linearReference(data.length), 300);
    const r = must(data);

    expect(def(r).wires).toHaveLength(4000);
    expect(def(r).labels.length).toBeGreaterThanOrEqual(4000);
  }, 300_000);
});
