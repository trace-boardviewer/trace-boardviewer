import { describe, expect, it } from 'vitest';
import { createDes, fzKeyParityValid, rc6EncryptBlock, rc6Feedback, xzzKeyParityValid } from './crypto';

const bytes = (hex: string) => Uint8Array.from(hex.replace(/\s+/g, '').match(/../g) ?? [], pair => Number.parseInt(pair, 16));
const hex = (data: Uint8Array) => [...data].map(value => value.toString(16).padStart(2, '0')).join('');
const rotl = (value: number, shift: number) => (value << (shift & 31) | value >>> (32 - (shift & 31))) >>> 0;

/** RC6 key schedule from Rivest/Robshaw/Sidney/Yin, "The RC6 Block Cipher" (1998), section 2.3: w=32, r=20, P32/Q32 constants. */
function rc6KeySchedule(key: Uint8Array): number[] {
  const c = Math.max(1, Math.ceil(key.length / 4));
  const L = new Array<number>(c).fill(0);
  for (let i = key.length - 1; i >= 0; i--) L[i >> 2] = ((L[i >> 2] << 8) + key[i]) >>> 0;
  const S = [0xb7e15163];
  for (let i = 1; i < 44; i++) S[i] = (S[i - 1] + 0x9e3779b9) >>> 0;
  let A = 0, B = 0, i = 0, j = 0;
  for (let step = 0; step < 3 * Math.max(c, 44); step++) {
    A = S[i] = rotl((S[i] + A + B) >>> 0, 3);
    B = L[j] = rotl((L[j] + A + B) >>> 0, (A + B) >>> 0);
    i = (i + 1) % 44; j = (j + 1) % c;
  }
  return S;
}
/** FZ key parity is a property of the real vendor key; synthetic test keys get their low bit adjusted to satisfy the table. */
function parityKey(seed: number, variant: 'fz' | 'cae' = 'fz'): number[] {
  const key = Array.from({ length: 44 }, (_, index) => (Math.imul(seed + index, 0x9e3779b1) ^ (seed * 7919)) >>> 0);
  // Flipping the low bit of a word toggles its parity, so each word is fixed independently against the upstream table.
  const bits = (word: number) => { let count = 0; for (let w = word >>> 0; w; w >>>= 1) count += w & 1; return count; };
  const table = variant === 'cae'
    ? [1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 0]
    : [0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1];
  return key.map((word, index) => (bits(word) % 2 === 0 ? 1 : 0) === table[index] ? word : (word ^ 1) >>> 0);
}

describe('boardview legacy crypto', () => {
  it('matches the standard DES known-answer vector in both directions', () => {
    const des = createDes('133457799BBCDFF1');
    expect(hex(des(bytes('0123456789abcdef'), false))).toBe('85e813540f0ab405');
    expect(hex(des(bytes('85e813540f0ab405')))).toBe('0123456789abcdef');
  });
  it('matches the independent dhuertas/DES zero-key known answer', () => {
    expect(hex(createDes('0000000000000000')(bytes('0000000000000000'), false))).toBe('8ca64de9c1b123a7');
  });
  it('matches the FIPS PUB 81 ECB example (key 0123456789ABCDEF, "Now is the time for all ") across three chained records', () => {
    // FIPS PUB 81 Appendix B, Table B1 (also Schneier, Applied Cryptography, 2nd ed., DES test vectors).
    const des = createDes('0123456789ABCDEF');
    const plain = bytes('4E6F772069732074 68652074696D6520 666F7220616C6C20');
    const cipher = '3fa40e8a984d4815' + '6a271787ab8883f9' + '893d51ec4b563b53';
    expect(hex(des(plain, false))).toBe(cipher);
    expect(hex(des(bytes(cipher)))).toBe(hex(plain));
  });
  it('matches the Grabbe "DES Algorithm Illustrated" vector (key 0E329232EA6D0D73, plaintext 8787878787878787 -> all zero)', () => {
    expect(hex(createDes('0E329232EA6D0D73')(bytes('8787878787878787'), false))).toBe('0000000000000000');
    expect(hex(createDes('0x0e329232ea6d0d73')(bytes('0000000000000000')))).toBe('8787878787878787');
  });
  it('rc6EncryptBlock reproduces the published RC6-32/20/16 test vectors with a standard key schedule', () => {
    // Vector 1: RC6 paper / AES submission, all-zero key and plaintext.
    const zeroKey = rc6KeySchedule(new Uint8Array(16));
    expect(hex(rc6EncryptBlock(new Uint8Array(16), zeroKey))).toBe('8fc3a53656b1f778c129df4e9848a41e');
    // Vector 2: RC6 paper, Appendix "Test vectors", 128-bit key.
    const key = rc6KeySchedule(bytes('0123456789abcdef0112233445566778'));
    expect(hex(rc6EncryptBlock(bytes('02132435465768798a9bacbdcedfe0f1'), key))).toBe('524e192f4715c6231f51f6367ea43f18');
    expect(key).toHaveLength(44);
  });
  it('rc6Feedback XORs each byte with the low byte of the first output word of the shifted ciphertext window', () => {
    const key = rc6KeySchedule(bytes('0123456789abcdef0112233445566778'));
    const data = Uint8Array.from({ length: 40 }, (_, index) => (index * 37 + 11) & 255);
    const encrypted = rc6Feedback(data, key, true);
    const window = new Uint8Array(16);
    for (let index = 0; index < data.length; index++) {
      expect(encrypted[index]).toBe(data[index] ^ rc6EncryptBlock(window, key)[0]);
      window.copyWithin(0, 1); window[15] = encrypted[index];
    }
    expect(rc6Feedback(encrypted, key)).toEqual(data);
  });
  it('does not share RC6 feedback between calls and accepts high unsigned key words', () => {
    const key = Array.from({ length: 44 }, (_, index) => (0xfedcba98 + index * 0x1020304) >>> 0);
    const data = Uint8Array.from({ length: 333 }, (_, index) => index * 17 & 255);
    const encrypted = rc6Feedback(data, key, true);
    expect(encrypted).not.toEqual(data);
    expect(rc6Feedback(encrypted, key)).toEqual(data);
    expect(rc6Feedback(data, key, true)).toEqual(encrypted);
    expect(data[15]).toBe(255);
  });
  it('validates FZ and CAE key parity against the upstream tables', () => {
    const fz = parityKey(1), cae = parityKey(2, 'cae');
    expect(fzKeyParityValid(fz)).toBe(true);
    expect(fzKeyParityValid(cae, 'cae')).toBe(true);
    expect(fzKeyParityValid(fz, 'cae')).toBe(false);
    expect(fzKeyParityValid(fz.map((word, index) => index === 17 ? word ^ 0x100 : word))).toBe(false);
    expect(fzKeyParityValid(fz.slice(0, 43))).toBe(false);
    expect(fzKeyParityValid([...fz.slice(0, 43), -1])).toBe(false);
    expect(fzKeyParityValid([...fz.slice(0, 43), 1.5])).toBe(false);
    // The all-zero key (upstream's empty built-in key) has even parity everywhere, so it fails on the table's zero entries.
    expect(fzKeyParityValid(Array(44).fill(0))).toBe(false);
    // The FZ table from FZFile.cpp: a word with parity bit 0 at index 0 must have an odd number of set bits.
    expect(fz[0].toString(2).replace(/0/g, '').length % 2).toBe(1);
  });
  it('validates XZZ key parity per byte from the least significant byte', () => {
    // Bytes 0..6 (LSB first) need an even bit count, byte 7 (the leading hex pair) an odd one.
    expect(xzzKeyParityValid('0100000000000000')).toBe(true);
    expect(xzzKeyParityValid('0x0103030303030303')).toBe(true);
    expect(xzzKeyParityValid('0000000000000000')).toBe(false);
    expect(xzzKeyParityValid('0100000000000001')).toBe(false);
    expect(xzzKeyParityValid('010000000000000')).toBe(false);
    expect(xzzKeyParityValid('zz00000000000000')).toBe(false);
  });
  it('rejects malformed keys and incomplete DES blocks', () => {
    expect(() => createDes('1234')).toThrow(/16 hexadecimal/);
    expect(() => createDes('133457799BBCDFF1')(new Uint8Array(7))).toThrow(/Truncated/);
    expect(() => rc6Feedback(new Uint8Array(1), Array(43).fill(0))).toThrow(/44/);
    expect(() => rc6Feedback(new Uint8Array(1), Array(44).fill(-1))).toThrow(/unsigned/);
    expect(() => rc6EncryptBlock(new Uint8Array(15), Array(44).fill(0))).toThrow(/16 bytes/);
    expect(() => rc6EncryptBlock(new Uint8Array(16), Array(44).fill(2 ** 32))).toThrow(/unsigned/);
  });
  it('decrypting a prefix equals the prefix of the full decryption (the FZ adapter relies on it to reject a wrong key cheaply)', () => {
    const key = parityKey(5);
    const plain = Uint8Array.from({ length: 200 }, (_, index) => index * 29 + 3 & 255);
    const cipher = rc6Feedback(plain, key, true);
    for (const length of [0, 1, 10, 16, 17, 199]) expect(rc6Feedback(cipher.subarray(0, length), key)).toEqual(plain.subarray(0, length));
  });
  it('works on offset views (subarray / Node buffers) without reading the neighbouring bytes', () => {
    const key = parityKey(6);
    const backing = new Uint8Array(100).map((_, index) => index * 7 & 255);
    const view = backing.subarray(13, 61), copy = Uint8Array.from(view);
    expect(rc6Feedback(view, key, true)).toEqual(rc6Feedback(copy, key, true));
    expect(rc6EncryptBlock(backing.subarray(5, 21), key)).toEqual(rc6EncryptBlock(Uint8Array.from(backing.subarray(5, 21)), key));
    const des = createDes('0103030505060909');
    expect(des(backing.subarray(8, 40), false)).toEqual(des(Uint8Array.from(backing.subarray(8, 40)), false));
  });
  it('DES and RC6 round-trip arbitrary data with the synthetic keys used by the adapter tests (encrypt then decrypt)', () => {
    const des = createDes('0103030505060909'), data = Uint8Array.from({ length: 64 }, (_, index) => index * 11 + 1 & 255);
    expect(des(des(data, false))).toEqual(data);
    expect(des(data, false)).not.toEqual(data);
    expect(xzzKeyParityValid('0103030505060909')).toBe(true);
    expect(rc6Feedback(rc6Feedback(data, parityKey(7), true), parityKey(7))).toEqual(data);
    expect(rc6Feedback(rc6Feedback(data, parityKey(7), true), parityKey(8))).not.toEqual(data);
  });
});

