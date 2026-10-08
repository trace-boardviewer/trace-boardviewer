import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_BYTES } from './common';
import { genCadStorageText, hasGenCadStorageHeader } from './gencad-framing';
import { parseBoardDetailed } from './dispatch';
import fixtures from './adapters/gencad/fixtures';

const text = new TextDecoder().decode(fixtures[0].data).replace(/\r?\n/g, '\r\n');
const wrap = (value = text): Uint8Array => {
  const body = new TextEncoder().encode(value), length = Math.ceil((32 + body.length + 1) / 4096) * 4096;
  const data = new Uint8Array(length), view = new DataView(data.buffer);
  data[0] = 0x9c; data[2] = 1; data[31] = 4;
  view.setUint32(16, length, true); view.setUint32(20, length + 4096, true);
  data.set(body, 32); return data;
};

describe('bounded GenCAD CAD storage framing', () => {
  it('retains the entire model and byte-exact text after its fixed header', () => {
    const data = wrap(), raw = parseBoardDetailed({ name: 'plain.cad', data: new TextEncoder().encode(text) }).board;
    expect(hasGenCadStorageHeader(data.subarray(0, 64))).toBe(true);
    expect(new TextDecoder().decode(genCadStorageText(data)!)).toBe(text);
    const board = parseBoardDetailed({ name: 'wrapped.cad', data }).board;
    expect(board.pins).toEqual(raw.pins); expect(board.components).toEqual(raw.components); expect(board.outline).toEqual(raw.outline);
    expect(board.warnings.at(-1)?.params?.message).toContain('length-checked 32-byte CAD storage wrapper');
  });
  it('rejects inconsistent source and allocation lengths before text parsing', () => {
    const bad = wrap(); new DataView(bad.buffer).setUint32(16, bad.length - 1, true);
    expect(() => parseBoardDetailed({ name: 'bad.cad', data: bad })).toThrow(/declared source length/);
    const allocated = wrap(); new DataView(allocated.buffer).setUint32(20, 4095, true);
    expect(() => genCadStorageText(allocated)).toThrow(/secondary page length/);
    expect(() => genCadStorageText(wrap().subarray(0, 4095))).toThrow(/declared source length/);
  });
  it('does not remove arbitrary prefixes, foreign suffixes or embedded bytes', () => {
    const reserved = wrap(); reserved[8] = 1; expect(genCadStorageText(reserved)).toBeNull();
    const shifted = new Uint8Array(4097); shifted.set(wrap(), 1); expect(genCadStorageText(shifted)).toBeNull();
    expect(() => parseBoardDetailed({ name: 'bad.cad', data: wrap(text + '<html>FOREIGN</html>\r\n') })).toThrow(/outside/);
    expect(() => genCadStorageText(wrap(text + '\x07'))).toThrow(/complete line/);
    expect(() => parseBoardDetailed({ name: 'bad.cad', data: wrap(text.replace('UNITS MM', 'UNITS MM\0')) })).toThrow();
  });
  it('retains the GenCAD version guard and full source byte budget', () => {
    expect(() => parseBoardDetailed({ name: 'bad.cad', data: wrap(text.replace('GENCAD 1.4', 'GENCAD 1.3')) })).toThrow(/1.4/);
    const huge = new Uint8Array(MAX_IMPORT_BYTES + 4096); huge.set(wrap().subarray(0, 64));
    expect(() => genCadStorageText(huge)).toThrow(/import limit/);
  });
});
