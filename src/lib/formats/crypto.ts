/**
 * Boardview cipher adapters. RC6 feedback and the key parity tables follow OpenBoardView FZFile.cpp / CAEFile.cpp / XZZPCBFile.cpp:
 * Copyright (c) 2016 Chloridite and OpenBoardView contributors, MIT.
 * DES tables/algorithm follow dhuertas/DES:
 * Copyright (c) 2020 Dani Huertas, MIT. See assets/licenses for full notices.
 * These legacy ciphers decode vendor files; they are not used for application security.
 */
import { BoardFormatError } from './common';

const rotate = (value: number, shift: number) => (value << (shift & 31) | value >>> (32 - (shift & 31))) >>> 0;
/** 1 when the value has an even number of set bits (the upstream parity tables use this sense). */
const evenParity = (value: number) => { let t = value >>> 0; t ^= t >>> 16; t ^= t >>> 8; t ^= t >>> 4; t ^= t >>> 2; t ^= t >>> 1; return ~t & 1; };
const validKeyWord = (word: number) => Number.isInteger(word) && word >= 0 && word <= 0xffffffff;
function requireRc6Key(key: readonly number[]) {
  if (key.length !== 44 || !key.every(validKeyWord)) throw new BoardFormatError('The FZ/CAE key must contain 44 unsigned 32-bit words.', 'INVALID_KEY', 'FZ/CAE', 'fz');
}

/* Expected per-word parity of the vendor keys (FZFile::getKeyParity, CAEFile::getKeyParity); the keys themselves are not shipped. */
const FZ_KEY_PARITY = [0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1];
const CAE_KEY_PARITY = [1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 0];
/* Expected parity of the eight XZZ key bytes, index 0 = least significant byte (XZZPCBFile::getKeyParity). */
const XZZ_KEY_PARITY = [1, 1, 1, 1, 1, 1, 1, 0];

/** True when a 44-word key has the per-word parity pattern of the real FZ (ASUS) or CAE (ASRock) key; rejects mistyped keys early. */
export function fzKeyParityValid(key: readonly number[], variant: 'fz' | 'cae' = 'fz'): boolean {
  const table = variant === 'cae' ? CAE_KEY_PARITY : FZ_KEY_PARITY;
  return key.length === 44 && key.every((word, index) => validKeyWord(word) && evenParity(word) === table[index]);
}
/** True when a 16-hex-digit XZZ key has the per-byte parity pattern of the real key. */
export function xzzKeyParityValid(keyText: string): boolean {
  const key = /^(?:0x)?([0-9a-f]{16})$/i.exec(keyText.trim())?.[1];
  if (!key) return false;
  return XZZ_KEY_PARITY.every((bit, index) => evenParity(Number.parseInt(key.slice(14 - index * 2, 16 - index * 2), 16)) === bit);
}

const words = new Uint32Array(4);
/** Standard RC6-32/20 rounds on four little-endian words with a pre-expanded 44-word schedule; the result lands in `words`. */
function rc6Rounds(a: number, b: number, c: number, d: number, key: readonly number[]) {
  b = (b + key[0]) >>> 0; d = (d + key[1]) >>> 0;
  for (let round = 1; round <= 20; round++) {
    const t = rotate(Math.imul(b, (Math.imul(2, b) + 1) >>> 0), 5);
    const u = rotate(Math.imul(d, (Math.imul(2, d) + 1) >>> 0), 5);
    a = (rotate(a ^ t, u) + key[round * 2]) >>> 0;
    c = (rotate(c ^ u, t) + key[round * 2 + 1]) >>> 0;
    const previousA = a; a = b; b = c; c = d; d = previousA;
  }
  words[0] = (a + key[42]) >>> 0; words[1] = b; words[2] = (c + key[43]) >>> 0; words[3] = d;
}
/** RC6 block encryption (w=32, r=20) of one 16-byte block with an already expanded key schedule. */
export function rc6EncryptBlock(block: Uint8Array, key: readonly number[]): Uint8Array {
  if (block.length !== 16) throw new BoardFormatError('RC6 blocks must contain exactly 16 bytes.', 'INVALID_FORMAT', 'FZ/CAE');
  requireRc6Key(key);
  const view = new DataView(block.buffer, block.byteOffset, 16);
  rc6Rounds(view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true), view.getUint32(12, true), key);
  const result = new Uint8Array(16), out = new DataView(result.buffer);
  for (let index = 0; index < 4; index++) out.setUint32(index * 4, words[index], true);
  return result;
}

/** RC6-20 with 128-bit, initially zero, ciphertext byte feedback (upstream-specific stream mode: one block per input byte). */
export function rc6Feedback(data: Uint8Array, key: readonly number[], encrypt = false): Uint8Array {
  requireRc6Key(key);
  const result = new Uint8Array(data.length);
  const feedback = new Uint8Array(16);
  const view = new DataView(feedback.buffer);
  for (let index = 0; index < data.length; index++) {
    rc6Rounds(view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true), view.getUint32(12, true), key);
    result[index] = data[index] ^ (words[0] & 255);
    feedback.copyWithin(0, 1);
    feedback[15] = encrypt ? result[index] : data[index];
  }
  return result;
}

const IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
const FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
const P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
const shifts = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const S = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];
const SP = S.map((table, box) => Array.from({ length: 64 }, (_, value) => {
  const row = (value & 32) >>> 4 | value & 1;
  const column = value >>> 1 & 15;
  const bits = table[row * 16 + column] << (28 - box * 4);
  let result = 0;
  for (const position of P) result = result << 1 | bits >>> (32 - position) & 1;
  return result >>> 0;
}));
function permute(high: number, low: number, table: readonly number[]): [number, number] {
  let left = 0, right = 0;
  for (let i = 0; i < table.length; i++) {
    const position = table[i];
    const bit = position <= 32 ? high >>> (32 - position) & 1 : low >>> (64 - position) & 1;
    if (i < 32) left = left << 1 | bit; else right = right << 1 | bit;
  }
  return [left >>> 0, right >>> 0];
}

/** DES ECB over complete 8-byte records, using network byte order as in XZZPCB. */
export function createDes(keyText: string): (data: Uint8Array, decrypt?: boolean) => Uint8Array {
  if (!/^(?:0x)?[0-9a-f]{16}$/i.test(keyText.trim())) throw new BoardFormatError('The XZZ key must contain exactly 16 hexadecimal digits.', 'INVALID_KEY', 'XZZPCB', 'xzz');
  const key = keyText.trim().replace(/^0x/i, '');
  const high = Number.parseInt(key.slice(0, 8), 16), low = Number.parseInt(key.slice(8), 16);
  const bits = PC1.map(position => position <= 32 ? high >>> (32 - position) & 1 : low >>> (64 - position) & 1);
  let c = 0, d = 0;
  for (let i = 0; i < 28; i++) { c = c << 1 | bits[i]; d = d << 1 | bits[i + 28]; }
  const keys: number[][] = [];
  for (const shift of shifts) {
    c = (c << shift | c >>> (28 - shift)) & 0xfffffff;
    d = (d << shift | d >>> (28 - shift)) & 0xfffffff;
    const round = Array<number>(8).fill(0);
    PC2.forEach((position, i) => { round[Math.floor(i / 6)] = round[Math.floor(i / 6)] << 1 | (position <= 28 ? c >>> (28 - position) : d >>> (56 - position)) & 1; });
    keys.push(round);
  }
  return (data, decrypt = true) => {
    if (data.length % 8) throw new BoardFormatError('Truncated XZZ DES record.', 'INVALID_FORMAT', 'XZZPCB');
    const output = new Uint8Array(data.length);
    const input = new DataView(data.buffer, data.byteOffset, data.byteLength), result = new DataView(output.buffer);
    for (let offset = 0; offset < data.length; offset += 8) {
      let [left, right] = permute(input.getUint32(offset), input.getUint32(offset + 4), IP);
      for (let round = 0; round < 16; round++) {
        const k = keys[decrypt ? 15 - round : round];
        const f = SP[0][((right & 1) << 5 | right >>> 27) ^ k[0]]
          ^ SP[1][(right >>> 23 & 63) ^ k[1]] ^ SP[2][(right >>> 19 & 63) ^ k[2]]
          ^ SP[3][(right >>> 15 & 63) ^ k[3]] ^ SP[4][(right >>> 11 & 63) ^ k[4]]
          ^ SP[5][(right >>> 7 & 63) ^ k[5]] ^ SP[6][(right >>> 3 & 63) ^ k[6]]
          ^ SP[7][((right & 31) << 1 | right >>> 31) ^ k[7]];
        const next = (left ^ f) >>> 0; left = right; right = next;
      }
      const [a, b] = permute(right, left, FP);
      result.setUint32(offset, a); result.setUint32(offset + 4, b);
    }
    return output;
  };
}
