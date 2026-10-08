import { describe, expect, it } from 'vitest';
import { readTvwComponents } from './tvw-components';

const join = (...chunks: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let at = 0; for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
  return result;
};
const words = (...values: number[]): Uint8Array => {
  const result = new Uint8Array(values.length * 4), view = new DataView(result.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value >>> 0, true)); return result;
};
const text = (value: string): Uint8Array => join(Uint8Array.of(value.length), new TextEncoder().encode(value));
interface Options {
  ref?: string; package?: string; value?: string; extras?: boolean; old?: boolean;
  flag?: number; classification?: number; kind?: number; names?: string[]; ordinals?: number[];
  coords?: number[]; reserved?: number; unknown?: number; uids?: number[];
}
function component(options: Options = {}): Uint8Array {
  const flag = options.flag ?? 1, names = options.names ?? ['1'];
  return join(text(options.ref ?? 'U1'),
    words(...(options.coords ?? [-1000, -2000, 1000, 2000, 0, 0]), 0, 3, options.classification ?? 0, 0, 0),
    ...(options.old ? [words(0)] : []), Uint8Array.of(flag),
    ...(flag === 0 ? [] : [text(options.value ?? 'VALUE'), ...(options.extras ? [text('1'), text('1')] : [new Uint8Array(2)]), text(options.package ?? 'SYNTHETIC'), text('')]),
    words(options.unknown ?? 0, names.length, options.kind ?? 2),
    ...(options.old ? [] : [words(options.reserved ?? 0)]),
    ...names.map((name, i) => join(words(options.uids?.[i] ?? 100 + i, 0, options.ordinals?.[i] ?? i + 1), text(name), words(0))));
}
const table = (parts: Uint8Array[], count = parts.length): Uint8Array => join(new Uint8Array(13), words(count, 12), ...parts);

describe('TVW declared component table', () => {
  it('reads exactly the declared sequential entries and stops before a trailing record', () => {
    const first = component(), data = join(table([first]), component({ ref: 'TRAILING' }));
    const result = readTvwComponents(data, 0);
    expect(result.start).toBe(13); expect(result.count).toBe(1); expect(result.end).toBe(21 + first.length);
    expect(result.parts.map(part => part.raw.ref)).toEqual(['U1']);
  });
  it('reads both pin groups and resumes at the exact next component without a second terminator', () => {
    const first = component({ names: ['A1'], ordinals: [1], uids: [24] });
    const secondGroup = join(words(1, 5, 0, 8, 0, 2), text('B2'));
    const dual = join(first.subarray(0, first.length - 4), secondGroup);
    const result = readTvwComponents(table([dual, component({ ref: 'NEXT' })]), 0);
    expect(result.parts.map(part => part.raw.ref)).toEqual(['U1', 'NEXT']);
    expect(result.parts[0].pinGroups).toEqual([
      { kind: 2, pins: [{ number: 'A1', ordinal: 1, uid: 24 }] },
      { kind: 5, pins: [{ number: 'B2', ordinal: 2, uid: 8 }] },
    ]);
    expect(result.parts[0].end).toBe(21 + dual.length);
    expect(readTvwComponents(table([dual]), 0).end).toBe(21 + dual.length);
    expect(() => readTvwComponents(table([dual.subarray(0, dual.length - 1), component({ ref: 'NEXT' })]), 0)).toThrow(/component 1 of 2/);
  });
  it('keeps the true BOM value when two extra Pascal fields are present', () => {
    const result = readTvwComponents(table([component({ value: '130', extras: true })]), 0);
    expect(result.parts[0].raw.value).toBe('130'); expect(result.parts[0].raw.package).toBe('SYNTHETIC');
  });
  it('reads the documented height-word layout with no compact reserved word', () => {
    expect(readTvwComponents(table([component({ old: true })]), 0).parts[0].pins).toEqual([{ number: '1', ordinal: 1, uid: 100 }]);
  });
  it('accepts numeric-leading mechanical references, placeholder package names and origins outside body bounds', () => {
    const result = readTvwComponents(table([component({ ref: '80A', package: '?', coords: [-100, -100, 100, 100, 500, -500] })]), 0);
    expect(result.parts[0].raw.ref).toBe('80A'); expect(result.parts[0].raw.package).toBe('?');
    expect(result.parts[0].raw.position).toEqual({ x: -500, y: 500 });
  });
  it.each([0, 1])('reads an unnamed class-18 test point with metadata flag %i', flag => {
    const result = readTvwComponents(table([component({ ref: 'TP1', classification: 18, flag, package: '', value: '', names: [''], kind: flag ? 2 : 5, uids: [456] })]), 0);
    expect(result.parts[0].testPoint).toBe(true); expect(result.parts[0].raw.package).toBe('');
    expect(result.parts[0].pins).toEqual([{ number: '', ordinal: 1, uid: 456 }]);
  });
  it.each([2, 5, 7])('preserves explicit physical-pad references and sparse labels for pin kind %i', kind => {
    const result = readTvwComponents(table([component({ kind, names: ['A1', 'Y26'], ordinals: [3, 676], uids: [464, 456] })]), 0);
    expect(result.parts[0].pinKind).toBe(kind);
    expect(result.parts[0].pins).toEqual([
      { number: 'A1', ordinal: 3, uid: 464 }, { number: 'Y26', ordinal: 676, uid: 456 },
    ]);
  });
  it('accepts only the layer references the caller can resolve and names a refused one', () => {
    const data = table([component({ kind: 13 })]);
    expect(() => readTvwComponents(data, 0)).toThrow(/names layer 13, which is not a top or bottom layer of this file/);
    expect(readTvwComponents(data, 0, reference => reference === 13).parts[0].pinKind).toBe(13);
    expect(() => readTvwComponents(table([component({ kind: 2 })]), 0, () => false)).toThrow(/names layer 2/);
  });
  it('refuses unnamed ordinary pins and unnamed multi-pin packages', () => {
    expect(() => readTvwComponents(table([component({ names: [''] })]), 0)).toThrow(/unsupported or incomplete/);
    expect(() => readTvwComponents(table([component({ classification: 18, package: '', names: ['', ''] })]), 0)).toThrow(/unsupported or incomplete/);
  });
  it('refuses invalid flags, reserved words, unknown tail words and duplicate ordinals', () => {
    for (const options of [{ flag: 2 }, { reserved: 0xffffffff }, { unknown: 1 }, { names: ['1', '2'], ordinals: [1, 1] }]) {
      expect(() => readTvwComponents(table([component(options)]), 0)).toThrow(/unsupported or incomplete/);
    }
  });
  it('fails at an incomplete declared entry instead of finding a later valid record', () => {
    const damaged = component({ ref: 'BROKEN', reserved: 1 }), later = component({ ref: 'LATER' });
    expect(() => readTvwComponents(table([component(), damaged, later], 2), 0)).toThrow(/component 2 of 2/);
    const truncated = table([component(), later]);
    expect(() => readTvwComponents(truncated.subarray(0, truncated.length - 1), 0)).toThrow(/component 2 of 2/);
  });
  it('enforces declared count and coordinate bounds', () => {
    expect(() => readTvwComponents(table([component()], 250_001), 0)).toThrow(/count exceeds/);
    expect(() => readTvwComponents(table([component({ coords: [2_000_001, 0, 2_000_002, 1, 0, 0] })]), 0)).toThrow(/no complete component-table/);
    expect(() => readTvwComponents(table([component({ coords: [100, 0, -100, 1, 0, 0] })]), 0)).toThrow(/no complete component-table/);
  });
  it('honors the bounded header search and Uint8Array byteOffset', () => {
    const original = table([component()]), padded = join(new Uint8Array(7), original, new Uint8Array(7));
    expect(readTvwComponents(padded.subarray(7, padded.length - 7), 0).count).toBe(1);
    const distant = join(new Uint8Array(256 * 1024 + 1), words(1, 12), component());
    expect(() => readTvwComponents(distant, 0)).toThrow(/no complete component-table/);
  });
});
