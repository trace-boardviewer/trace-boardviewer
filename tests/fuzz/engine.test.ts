/** The fuzzer's own checks: it is deterministic, it recognizes each kind of finding and it shrinks a crashing input to its core. */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOARD_ADAPTERS, CONTAINER_ADAPTERS } from '../../src/lib/formats';
import { defineBoardAdapter, sniffed } from '../../src/lib/formats/adapter';
import type { FuzzInput } from './corpus';
import { packInput, unpackInput } from './corpus';
import { buildPool, CI_CONFIG, cutsOf, ddmin, generate, inProcessProbe, runCase, shrink, sweepInput, sweepSize } from './engine';
import type { Finding } from './engine';
import { MUTATOR_NAMES, mutateBytes } from './mutate';
import { createRng } from './prng';
import { loadSeeds } from './seeds';
import { ALL_TARGETS } from './targets';
import type { FuzzTarget } from './targets';
import { checkSniffResult } from './targets-registry';

const bytes = (text: string) => new TextEncoder().encode(text);
const input = (text: string): FuzzInput => ({ name: 'sample.bin', data: bytes(text) });
const isDocumented = (error: unknown) => error instanceof RangeError;

/** A function under test with a controllable set of faults. */
function fake(overrides: Partial<FuzzTarget> & { run: FuzzTarget['run'] }): FuzzTarget {
  return { id: 'fake', family: 'util', seeds: ['fake'], allowed: isDocumented, ...overrides };
}
const contains = (data: Uint8Array, text: string) => Buffer.from(data).includes(text);

describe('random numbers and inputs are reproducible', () => {
  it('gives the same stream for the same parts and another for another', () => {
    const draw = (...parts: Array<string | number>) => { const rng = createRng(...parts); return Array.from({ length: 8 }, () => rng.int(1_000_000)); };
    expect(draw('a', 1)).toEqual(draw('a', 1));
    expect(draw('a', 1)).not.toEqual(draw('a', 2));
    expect(draw('a', 1)).not.toEqual(draw('b', 1));
    const rng = createRng('x');
    for (let i = 0; i < 2000; i++) { const value = rng.next(); expect(value >= 0 && value < 1).toBe(true); expect(rng.range(3, 5)).toBeGreaterThanOrEqual(3); }
  });

  it('derives every input from (seed, target, iteration) alone', () => {
    const target = fake({ run: () => null });
    const pool = buildPool(target, [{ adapter: 'fake', id: 's', kind: 'valid', input: { name: 'a.bin', data: bytes('(board (part R1 10 20) (part R2 30 40))\n1 2 3\n') } }]);
    const again = (iteration: number) => Buffer.from(generate(target, pool, CI_CONFIG, iteration).data).toString('hex');
    for (let iteration = 0; iteration < 60; iteration++) expect(again(iteration)).toBe(again(iteration));
    const distinct = new Set(Array.from({ length: 60 }, (_, iteration) => again(iteration)));
    expect(distinct.size).toBeGreaterThan(40);
    expect(Buffer.from(generate(target, pool, { ...CI_CONFIG, seed: 'other' }, 3).data).toString('hex')).not.toBe(again(3));
  });

  it('every mutator keeps the result within the limit and never throws, on empty, short and long data', () => {
    const rng = createRng('mutators');
    const samples = [new Uint8Array(0), bytes('a'), bytes('1 2 3\n4 5 6\n(x (y z))\n'), new Uint8Array(5000).map((_, i) => (i * 31) & 0xff)];
    for (let round = 0; round < 3000; round++) {
      const data = samples[round % samples.length];
      const result = mutateBytes(data, { rng, dictionary: [bytes('part'), bytes('net')], donors: samples, maxBytes: 4096 }, 1 + (round % 5));
      expect(result.length).toBeLessThanOrEqual(4096);
    }
    expect(MUTATOR_NAMES.length).toBeGreaterThan(20);
  });

  it('packs an input as JSON and reads it back byte for byte, text or binary', () => {
    const samples: FuzzInput[] = [
      input('plain text\n'), { name: 'b.bin', data: Uint8Array.of(0, 1, 2, 255, 254) }, { name: 'bom.txt', data: Uint8Array.of(0xef, 0xbb, 0xbf, 0x41) },
      { name: 'c.asc', data: bytes('x'), companions: { 'pins.asc': Uint8Array.of(1, 2), 'nails.asc': bytes('n') }, options: { fzKey: [1, 2, 3] } },
    ];
    for (const sample of samples) {
      const restored = unpackInput(JSON.parse(JSON.stringify(packInput(sample))));
      expect(restored.name).toBe(sample.name);
      expect(Buffer.from(restored.data).equals(Buffer.from(sample.data))).toBe(true);
      expect(Object.keys(restored.companions ?? {}).sort()).toEqual(Object.keys(sample.companions ?? {}).sort());
      expect(restored.options).toEqual(sample.options);
    }
  });

  it('cuts every seed at every 1/64 of its length in the sweep', () => {
    const data = bytes('0123456789'.repeat(20));
    const pool = { own: [{ adapter: 'f', id: 'one', kind: 'valid', input: { name: 'n', data } }], all: [], donors: [], dictionary: [] };
    expect(sweepSize(pool)).toBe(65);
    const sizes = Array.from({ length: 65 }, (_, index) => sweepInput(pool, index).input.data.length);
    expect(sizes[0]).toBe(0); expect(sizes[64]).toBe(data.length); expect(sizes[32]).toBe(100);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it('cuts the seeds of a target with hundreds of them at fewer points, so that a sweep stays small', () => {
    const data = bytes('0123456789'.repeat(20));
    const own = Array.from({ length: 400 }, (_, index) => ({ adapter: 'f', id: `s${index}`, kind: 'valid', input: { name: 'n', data } }));
    const pool = { own, all: [], donors: [], dictionary: [] };
    expect(sweepSize(pool)).toBeLessThan(3000);
    const first = Array.from({ length: cutsOf(pool) + 1 }, (_, index) => sweepInput(pool, index).input.data.length);
    expect(first[0]).toBe(0); expect(first[first.length - 1]).toBe(data.length);
    expect(sweepInput(pool, sweepSize(pool) - 1).input.data.length).toBe(data.length);
    expect(cutsOf({ ...pool, own: own.slice(0, 20) })).toBe(64);
  });
});

describe('the contract checks', () => {
  const config = CI_CONFIG;

  it('lets the documented failure through and reports anything else', () => {
    const target = fake({ run: item => { if (contains(item.data, 'DOC')) throw new RangeError('documented'); if (contains(item.data, 'BUG')) throw new TypeError('x is undefined at index 7'); return null; } });
    expect(runCase(target, input('fine'), config)).toMatchObject({ outcome: 'null' });
    expect(runCase(target, input('DOC'), config)).toMatchObject({ outcome: 'error', errorCode: 'RangeError' });
    expect(runCase(target, input('DOC'), config).finding).toBeUndefined();
    const bug = runCase(target, input('BUG'), config).finding as Finding;
    expect(bug.kind).toBe('unexpected-exception');
    expect(bug.message).toContain('TypeError');
    // The same defect found by two inputs has one signature, whatever numbers the message holds.
    const other = fake({ run: item => { if (contains(item.data, 'BUG')) throw new TypeError('x is undefined at index 91'); return null; } });
    expect(runCase(other, input('BUG'), config).finding?.signature).toBe(bug.signature);
  });

  it('reports a result that breaks the model, an unbounded one and an error without a message', () => {
    const broken = fake({ run: () => ({ ok: true }), check: () => 'a pin points at a missing part' });
    expect(runCase(broken, input('x'), config).finding).toMatchObject({ kind: 'invariant', message: 'a pin points at a missing part' });
    const huge = fake({ run: () => ({}), units: () => 5_000_000 });
    expect(runCase(huge, input('x'), config).finding?.kind).toBe('unbounded-output');
    const silent = fake({ run: () => { throw new RangeError(''); } });
    expect(runCase(silent, input('x'), config).finding?.kind).toBe('malformed-error');
  });

  it('reports a parser that changes its input, one that is not repeatable, and one that is too slow', () => {
    const writer = fake({ run: item => { item.data[0] ^= 1; return null; } });
    expect(runCase(writer, input('abc'), config).finding?.kind).toBe('input-modified');
    let calls = 0;
    const drifting = fake({ run: () => ({ calls: ++calls }), digest: output => JSON.stringify(output) });
    expect(runCase(drifting, input('abc'), config).finding?.kind).toBe('nondeterministic');
    const slow = fake({ run: () => { const until = performance.now() + 40; while (performance.now() < until) { /* busy */ } return null; } });
    expect(runCase(slow, input('abc'), { ...config, timeScale: 0.01 }).finding?.kind).toBe('slow');
    expect(runCase(slow, input('abc'), config).finding).toBeUndefined();
  });

  it('does not put a path into a finding', () => {
    const target = fake({ run: () => { throw new TypeError('cannot read C:\\Users\\someone\\file.txt and /home/someone/x'); } });
    const found = runCase(target, input('x'), config).finding as Finding;
    expect(found.message).not.toMatch(/Users|someone|home/);
    expect(found.signature).not.toMatch(/Users|someone|home/);
  });
});

describe('shrinking', () => {
  it('ddmin finds the smallest list that keeps a property', async () => {
    const items = Array.from({ length: 200 }, (_, index) => index);
    const kept = await ddmin(items, candidate => candidate.includes(17) && candidate.includes(142), 2000);
    expect(kept).toEqual([17, 142]);
  });

  it('shrinks a crashing input to the bytes that cause the crash, and drops what is not needed', async () => {
    const target = fake({ run: item => { if (contains(item.data, 'crash=') && contains(item.data, '-1')) throw new TypeError('bad'); return null; } });
    const noise = Array.from({ length: 300 }, (_, index) => `line ${index} with some padding text`).join('\n');
    const start: FuzzInput = { name: 'x.bin', data: bytes(`${noise}\nsetting crash=-1 now\n${noise}\n`), companions: { 'a.txt': bytes('not needed'), 'b.txt': bytes('nor this') }, options: { xzzKey: '0123456789abcdef' } };
    const found = runCase(target, start, CI_CONFIG).finding as Finding;
    const smaller = await shrink(start, inProcessProbe(target, found, CI_CONFIG, 0), { maxTests: 4000, deadlineMs: 20_000 });
    expect(Buffer.from(smaller.data).toString()).toBe('crash=-1');
    expect(smaller.companions).toBeUndefined();
    expect(smaller.options).toBeUndefined();
    expect(runCase(target, smaller, CI_CONFIG).finding?.signature).toBe(found.signature);
  });
});

describe('the targets that come from the registry', () => {
  const ids = ALL_TARGETS().map(target => target.id);

  it('has a parse target for every board adapter, a sniff target for every adapter and a container target for every container, each id once', () => {
    for (const adapter of BOARD_ADAPTERS) { expect(ids, adapter.id).toContain(`board:${adapter.id}`); expect(ids, adapter.id).toContain(`sniff:${adapter.id}`); }
    for (const container of CONTAINER_ADAPTERS) { expect(ids, container.id).toContain(`container:${container.id}`); expect(ids, container.id).toContain(`sniff:${container.id}`); }
    for (const id of ['board:dispatch', 'util:sniff-board', 'schematic:altium-sch', 'schematic:design', 'util:xml-scanner', 'util:csv-tokenizer', 'util:ipc356-text', 'util:compound-file', 'util:zip', 'util:pinlist-analysis', 'readings:csv', 'readings:openboarddata', 'readings:pack', 'readings:detect', 'readings:value']) expect(ids, id).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('takes the seeds of an adapter without a corpus file from the fixtures of its folder', () => {
    const seeds = loadSeeds(fileURLToPath(new URL('./corpus/', import.meta.url)));
    const adapters = new Set(seeds.map(seed => seed.adapter));
    for (const id of ['zip', 'gerber', 'odbpp', 'brd2', 'hyperlynx', 'fabmaster']) expect(adapters.has(id), id).toBe(true);
    // A corpus file wins: the fixtures of an adapter that has one are not added a second time.
    expect(seeds.filter(seed => seed.adapter === 'hyperlynx').every(seed => !seed.id.startsWith('fixture '))).toBe(true);
  });

  it('judges a sniff result by the contract of the interface', () => {
    expect(checkSniffResult(sniffed(0, ''))).toBeNull();
    expect(checkSniffResult(sniffed(75, 'a header line', { meta: { version: 2, units: 'mm', metric: true } }))).toBeNull();
    expect(checkSniffResult({ confidence: 101, reason: 'x' })).toMatch(/confidence/);
    expect(checkSniffResult({ confidence: 50.5, reason: 'x' })).toMatch(/confidence/);
    expect(checkSniffResult({ confidence: NaN, reason: 'x' })).toMatch(/confidence/);
    expect(checkSniffResult({ confidence: 50, reason: '' })).toMatch(/reason/);
    expect(checkSniffResult({ confidence: 0, reason: 'something' })).toMatch(/reason/);
    expect(checkSniffResult({ confidence: 50, reason: 'x'.repeat(2000) })).toMatch(/reason/);
    expect(checkSniffResult({ confidence: 50, reason: 'x', meta: { Bad_key: 1 } })).toMatch(/metadata key/);
    expect(checkSniffResult({ confidence: 50, reason: 'x', meta: { size: Infinity } })).toMatch(/finite/);
    expect(checkSniffResult({ confidence: 50, reason: 'x', meta: { text: 'y'.repeat(500) } })).toMatch(/bounded/);
    expect(checkSniffResult({ confidence: 50, reason: 'x', meta: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`k${index}`, index])) })).toMatch(/entries/);
    expect(checkSniffResult({ confidence: 50, reason: 'x', needsKey: 'rsa' as 'fz' })).toMatch(/key kind/);
  });

  it('finds a sniff that throws, as a finding of that sniff (the dispatcher would hide it)', () => {
    const broken = defineBoardAdapter({
      capability: { id: 'broken', name: 'Broken', extensions: ['.brk'], variants: ['v'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated', units: 'mm', sides: 's', notes: ['n'] },
      listOrder: 1, family: 'Boardview', detection: 'name',
      sniff: input => { if (input.head.length > 3) throw new RangeError('oops'); return sniffed(0, ''); },
      parse: () => null,
    });
    const target = fake({ id: 'sniff:broken', seeds: ['x'], allowed: () => false, run: input => broken.sniff({ head: input.data, name: input.name, size: input.data.length }) });
    expect(runCase(target, input('abcdef'), CI_CONFIG).finding?.kind).toBe('unexpected-exception');
    expect(runCase(target, input('ab'), CI_CONFIG).finding).toBeUndefined();
  });

  it('draws reader options only for the readers that take some, always the same ones for the same iteration', () => {
    const corpus = [{ adapter: 'x', id: 's', kind: 'valid', input: { name: 'a.csv', data: bytes('Ref,Pin,X,Y\nR1,1,0,0\n') } }];
    const optionsOf = (id: string, iteration: number) => {
      const target = fake({ id, seeds: ['x'], run: () => null });
      return generate(target, buildPool(target, corpus), CI_CONFIG, iteration).options;
    };
    const drawn = (id: string, key: 'pinList' | 'ipc356') => Array.from({ length: 200 }, (_, iteration) => optionsOf(id, iteration)?.[key]).filter(Boolean);
    expect(drawn('board:pinlist', 'pinList').length).toBeGreaterThan(20);
    expect(drawn('board:ipc356', 'ipc356').length).toBeGreaterThan(20);
    expect(drawn('board:kicad', 'pinList')).toEqual([]);
    expect(drawn('board:kicad', 'ipc356')).toEqual([]);
    expect(JSON.stringify(drawn('board:pinlist', 'pinList'))).toBe(JSON.stringify(drawn('board:pinlist', 'pinList')));
  });
});
