import { describe, expect, it } from 'vitest';
import { BoardFormatError } from './common';
import { parseF2b, sniffF2b } from './f2b';
import { makeF2b } from './f2b-fixture';
import { parseBoard } from './index';
import { collectDiagnostic } from '../diagnostics/collect';

const parse = (data: Uint8Array) => parseF2b({ name: 'synthetic.f2b', data })!;
function failure(data: Uint8Array): BoardFormatError {
  try { parse(data); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected format failure');
}
const mutate = (record: string, value: number, size: 2 | 4 = 2, relative = 0) => {
  const fixture = makeF2b(); new DataView(fixture.data.buffer)[size === 2 ? 'setUint16' : 'setUint32'](fixture.offsets[record] + relative, value, true); return fixture.data;
};

describe('Unisoft F2B archive', () => {
  it.each([[6, 7], [8, 8], [8, 9]] as const)('reads archive %s with component payload %s', (version, payloadVersion) => {
    const board = parse(makeF2b({ version, payloadVersion }).data);
    expect(board.components).toHaveLength(1); expect(board.pins).toHaveLength(2);
    expect(board.components[0]).toMatchObject({ ref: 'U1', side: 'top' });
    expect(board.warnings.some(w => w.key === 'parse.warning.fallbackComponents')).toBe(true);
    expect(board.pins[0]).toMatchObject({ number: 'A1', net: 'GND', side: 'top' });
    expect(board.pins[0].x).toBeCloseTo(25.4); expect(board.pins[0].y).toBeCloseTo(25.4);
    expect(board.pins[1].x).toBeCloseTo(38.1); expect(board.nets.map(net => net.name)).toEqual(['GND', 'SIGNAL_A']);
    expect(board.warnings.some(w => w.key === 'parse.warning.missingBoardOutline')).toBe(true);
  });

  it('scales lower-resolution archives and preserves bottom and through-hole pin sides', () => {
    const board = parse(makeF2b({ bottom: true, through: true, resolution: 200 }).data);
    expect(board.components[0].side).toBe('bottom'); expect(board.pins[0].side).toBe('both');
    expect(board.pins[0].x).toBeCloseTo(127);
  });

  it('preserves the known full-stack through-hole layer field', () => {
    const fixture = makeF2b({ through: true }), view = new DataView(fixture.data.buffer);
    for (const n of [0, 1]) view.setUint16(fixture.offsets[`pin${n}`] + 6, 0x650, true);
    const board = parse(fixture.data);
    expect(board.components[0].side).toBe('top'); expect(board.pins.every(pin => pin.side === 'both')).toBe(true);
  });

  it('detects the native signature independently of the filename', () => {
    const data = makeF2b().data;
    expect(sniffF2b(data)).toBe(8); expect(parseBoard({ name: 'renamed.bin', data }).format).toBe('Unisoft F2B');
    expect(parseF2b({ name: 'fake.f2b', data: new Uint8Array(100) })).toBeNull();
  });

  it.each([
    ['missing owner', () => mutate('owner1', 99)],
    ['wrong class reference', () => mutate('owner1', 0x8007)],
    ['dictionary owner disagreement', () => mutate('dictionaryOwner', 0)],
    ['missing net', () => mutate('nameKey2', 3)],
    ['missing alphabetic label', () => mutate('nameKey65535', 0xfffe)],
    ['duplicate name key', () => mutate('nameKey2', 1)],
    ['pin count disagreement', () => mutate('componentTail', 1)],
    ['pin sides disagree', () => mutate('pin1', 44, 2, 6)],
    ['unexpected suffix', () => { const f = makeF2b(); return Uint8Array.from([...f.data, 0]); }],
  ] as const)('rejects %s', (_name, data) => {
    expect(failure(data())).toMatchObject({ code: 'INVALID_FORMAT', format: 'unisoft-f2b' });
  });

  it.each([
    ['new archive', () => { const f = makeF2b(); new DataView(f.data.buffer).setUint32(0, 13, true); return f.data; }],
    ['new component payload', () => mutate('componentVersion', 10)],
    ['new part-number payload', () => mutate('partVersion', 4)],
    ['extended MFC reference', () => mutate('owner1', 0x7fff)],
    ['unknown pin flags', () => mutate('pin1', 12, 2, 6)],
    ['unknown pin layer flags', () => mutate('pin1', 0xff18, 2, 6)],
    ['new runtime schema', () => mutate('componentClass', 2, 2, 2)],
  ] as const)('refuses %s as an unsupported variant', (_name, data) => {
    expect(failure(data()).code).toBe('UNSUPPORTED_VARIANT');
  });

  it('bounds lengths and counts before allocation and rejects truncated records', () => {
    expect(failure(mutate('partReferences', 250_001, 4)).code).toBe('LIMIT_EXCEEDED');
    expect(failure(mutate('settings', 257, 4)).code).toBe('LIMIT_EXCEEDED');
    const fixture = makeF2b();
    for (const end of [38, fixture.offsets.pinCount + 2, fixture.offsets.componentTail + 10, fixture.data.length - 1]) expect(failure(fixture.data.subarray(0, end)).code).toBe('INVALID_FORMAT');
    new DataView(fixture.data.buffer).setFloat32(13, Number.NaN, true); expect(failure(fixture.data).code).toBe('INVALID_FORMAT');
  });

  it('bounds extended MFC strings and refuses Unicode framing', () => {
    const unicode = makeF2b(), extended = makeF2b();
    unicode.data.set([255, 254, 255], unicode.offsets.metadata);
    expect(failure(unicode.data).code).toBe('UNSUPPORTED_VARIANT');
    extended.data.set([255, 255, 255, 1, 0, 1, 0], extended.offsets.metadata);
    expect(failure(extended.data).code).toBe('LIMIT_EXCEEDED');
  });

  it('reports class framing and counts without strings, coordinates or metadata', async () => {
    const report = await collectDiagnostic({ name: 'synthetic.f2b', data: makeF2b().data }, { os: 'win32' });
    expect(report.detection).toMatchObject({ selected: 'unisoft-f2b', outcome: 'opened' });
    expect(report.structure).toMatchObject({ hook: 'unisoft-f2b', headerOk: true, header: { codes: { version: 8 } } });
    expect(report.structure!.blocks!.tagBits).toBe(8);
    expect(JSON.stringify(report.structure)).not.toMatch(/U1|GND|SIGNAL_A|PN-DEMO|synthetic|25\.4|38\.1/);
    const unsupported = makeF2b(); new DataView(unsupported.data.buffer).setUint16(unsupported.offsets.componentVersion, 10, true);
    const failed = await collectDiagnostic({ name: 'synthetic.f2b', data: unsupported.data }, { os: 'win32' });
    expect(failed.detection.adapters.find(entry => entry.id === 'unisoft-f2b')).toMatchObject({ code: 'UNSUPPORTED_VARIANT', stage: 'records' });
  });
});
