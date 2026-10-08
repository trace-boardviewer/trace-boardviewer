import { describe, expect, it } from 'vitest';
import { SNIFF_BYTES } from './adapter';
import type { AdapterFixture } from './fixture';
import { lines, utf8 } from './fixture';
import { sniffBoard } from './index';

const FIXTURES = Object.entries(import.meta.glob<AdapterFixture[]>('./adapters/*/fixtures.ts', { eager: true, import: 'default' }))
  .flatMap(([file, list]) => list.map(fixture => ({ owner: /adapters\/([^/]+)\/fixtures\.ts$/.exec(file)![1], fixture })));
const of = (owner: string, index = 0) => FIXTURES.filter(item => item.owner === owner)[index].fixture;
const sniff = (fixture: AdapterFixture) => sniffBoard(fixture.data.subarray(0, SNIFF_BYTES), fixture.name, fixture.data.length);

describe('sniffBoard: sniff-only identification for listings', () => {
  it.each(FIXTURES.map(({ owner, fixture }) => [`${owner}: ${fixture.label}`, owner, fixture] as const))('%s', (_label, owner, fixture) => {
    const result = sniff(fixture);
    expect(result.best?.id).toBe(owner);
    expect(result.ambiguous).toBe(false);
    expect(result.candidates[0]).toBe(result.best);
    // Plain frozen data: it crosses a worker boundary unchanged and cannot be altered by a caller.
    expect(structuredClone(result)).toEqual(result);
    expect(Object.isFrozen(result) && Object.isFrozen(result.candidates) && Object.isFrozen(result.best)).toBe(true);
  });
  it('reports the facts the head states outright', () => {
    expect(sniff(of('kicad')).best).toMatchObject({ format: 'KiCad PCB', status: 'supported', meta: { fileVersion: 20240108, generator: 'synthetic' } });
    expect(sniff(of('gencad')).best?.meta).toEqual({ version: '1.4', units: 'MM' });
    expect(sniff(of('eagle')).best?.meta).toEqual({ version: '9.6.2' });
    expect(sniff(of('bvr')).best).toMatchObject({ variant: 'BVRAW_FORMAT_3', meta: { version: 3 }, status: 'open-tool-validated' });
    expect(sniff(of('xzz', 1)).best?.meta).toEqual({ obfuscated: true });
    expect(sniff(of('brd', 1)).best?.meta).toEqual({ encoded: true });
    expect(sniff(of('ipc2581')).best).toMatchObject({ status: 'open-tool-validated', meta: { revision: 'C' } });
    expect(sniff(of('gerber')).best?.meta).toEqual({ units: 'inch' });
    expect(sniff(of('zip')).best).toMatchObject({ kind: 'container', meta: { firstEntry: 'job/board.cad' } });
    const encrypted = sniffBoard(Uint8Array.from({ length: 256 }, (_, index) => (index * 151 + 7) & 255), 'board.fz', 4096);
    expect(encrypted.best).toMatchObject({ id: 'fz', needsKey: 'fz', meta: { encrypted: true } });
  });
  it('knows when the head is only the start of the file, and reads UTF-16 heads like the dispatcher', () => {
    const text = 'x\n'.repeat(SNIFF_BYTES), head = utf8(text).subarray(0, SNIFF_BYTES);
    expect(sniffBoard(head, 'big.cad', head.length).best).toBeUndefined();
    expect(sniffBoard(head, 'big.cad', 10 * SNIFF_BYTES).best).toMatchObject({ id: 'samsung-cad', confidence: 9 });
    const bvr = new TextDecoder().decode(of('bvr').data), units = new Uint8Array(2 + bvr.length * 2);
    units[0] = 0xfe; units[1] = 0xff;
    for (let index = 0; index < bvr.length; index++) { units[2 + index * 2] = bvr.charCodeAt(index) >>> 8; units[3 + index * 2] = bvr.charCodeAt(index) & 255; }
    expect(sniffBoard(units, 'board.bvr').best?.id).toBe('bvr');
  });
  it('flags a head that two readers are certain about, and stays total on any input', () => {
    expect(sniffBoard(lines(['(kicad_pcb (version 20240108)', '$HEADER']), 'x.kicad_pcb').ambiguous).toBe(true);
    for (const [head, name] of [[new Uint8Array(0), ''], [new Uint8Array(SNIFF_BYTES * 2), 'x.brd'], [Uint8Array.from([0xff, 0xfe, 0x00]), 'x.cad']] as const) {
      expect(() => sniffBoard(head, name, Number.NaN)).not.toThrow();
    }
    expect(() => sniffBoard('text' as unknown as Uint8Array, 'x')).toThrow(TypeError);
  });
});
