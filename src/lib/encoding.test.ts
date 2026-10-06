import { describe, expect, it } from 'vitest';
import { utf16ToUtf8, utf8Input } from './encoding';

const enc = (text: string) => new TextEncoder().encode(text);
const utf16 = (text: string, bigEndian = false): Uint8Array => {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = bigEndian ? 0xfe : 0xff; out[1] = bigEndian ? 0xff : 0xfe;
  for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i); out[2 + i * 2] = bigEndian ? code >>> 8 : code & 255; out[3 + i * 2] = bigEndian ? code & 255 : code >>> 8; }
  return out;
};

describe('utf16ToUtf8', () => {
  it('re-encodes byte-order-marked UTF-16 of either endianness as UTF-8 without a mark', () => {
    const text = 'BVRAW_FORMAT_3\r\nPART_NAME Ü1 Ω\r\n';
    expect(utf16ToUtf8(utf16(text))).toEqual(enc(text));
    expect(utf16ToUtf8(utf16(text, true))).toEqual(enc(text));
    expect(utf16ToUtf8(utf16(''))).toEqual(new Uint8Array(0));
  });
  it('returns any other input as it is: UTF-8, a UTF-8 mark, binary data, and UTF-16 that does not decode', () => {
    for (const data of [enc('plain'), Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]), Uint8Array.from([0xff, 0xfe, 0x41]), Uint8Array.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00]), Uint8Array.from([0xfe]), new Uint8Array(0)]) {
      expect(utf16ToUtf8(data)).toBe(data);
    }
  });
});

describe('utf8Input', () => {
  it('returns the same object when neither the file nor a companion is UTF-16, and converts every UTF-16 member otherwise', () => {
    const plain = { name: 'a.bvr', data: enc('x'), companions: { 'b.asc': enc('y') } };
    expect(utf8Input(plain)).toBe(plain);
    expect(utf8Input({ name: 'a.bvr', data: utf16('x') })).not.toHaveProperty('companions');
    const mixed = { name: 'a.asc', data: utf16('one'), companions: { 'b.asc': enc('two'), 'c.asc': utf16('three', true) }, options: { fzKey: [1] } };
    const converted = utf8Input(mixed);
    expect(converted).not.toBe(mixed);
    expect(converted).toEqual({ name: 'a.asc', data: enc('one'), companions: { 'b.asc': enc('two'), 'c.asc': enc('three') }, options: { fzKey: [1] } });
    expect(converted.companions!['b.asc']).toBe(mixed.companions['b.asc']);
    expect(mixed.data[0]).toBe(0xff); // the caller's input is never modified
    const onlyFile = utf8Input({ name: 'a', data: utf16('z'), companions: plain.companions });
    expect(onlyFile.companions).toBe(plain.companions);
  });
});
