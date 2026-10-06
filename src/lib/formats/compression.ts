import { BoardFormatError, MAX_IMPORT_BYTES } from './common';

/**
 * Original bounded RFC 1950/1951 inflater. It reports exactly how many input bytes the deflate stream used, so a
 * zlib container with unused trailing bytes (even one ending in a copied checksum) is rejected instead of accepted.
 */
export interface InflateResult { output: Uint8Array; consumedBytes: number }

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Lookup table indexed by the next `bits` input bits (LSB first): entry = symbol << 4 | code length, 0 = no code. */
interface Huffman { table: Int32Array; bits: number }

const fail = (message: string, code: 'INVALID_FORMAT' | 'LIMIT_EXCEEDED' = 'INVALID_FORMAT'): never => {
  throw new BoardFormatError(`Compressed board data: ${message}`, code);
};

/** Canonical Huffman table (RFC 1951 3.2.2). Over-subscribed codes always fail; an incomplete code is only tolerated for a lone one-bit code, never for the code-length code. */
function huffman(lengths: ArrayLike<number>, codeLengthCode: boolean): Huffman {
  const counts = new Int32Array(16);
  let max = 0;
  for (let index = 0; index < lengths.length; index++) { counts[lengths[index]]++; if (lengths[index] > max) max = lengths[index]; }
  counts[0] = 0;
  let left = 1;
  for (let length = 1; length <= 15; length++) { left = (left << 1) - counts[length]; if (left < 0) fail('over-subscribed Huffman code.'); }
  if (left > 0 && max > 0 && (codeLengthCode || max !== 1)) fail('incomplete Huffman code.');
  const bits = Math.max(max, 1), table = new Int32Array(1 << bits), next = new Int32Array(16);
  let code = 0;
  for (let length = 1; length <= 15; length++) { code = (code + counts[length - 1]) << 1; next[length] = code; }
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol];
    if (!length) continue;
    let forward = next[length]++, reversed = 0;
    for (let bit = 0; bit < length; bit++) { reversed = reversed << 1 | forward & 1; forward >>>= 1; }
    for (let index = reversed; index < table.length; index += 1 << length) table[index] = symbol << 4 | length;
  }
  return { table, bits };
}

let fixed: { lengths: Huffman; distances: Huffman } | undefined;
function fixedTables() {
  if (!fixed) {
    const literal = new Uint8Array(288);
    literal.fill(8, 0, 144); literal.fill(9, 144, 256); literal.fill(7, 256, 280); literal.fill(8, 280, 288);
    fixed = { lengths: huffman(literal, false), distances: huffman(new Uint8Array(32).fill(5), false) };
  }
  return fixed;
}

/** Raw deflate (RFC 1951). The output bound is enforced while decoding, so an expansion bomb never allocates past it. */
export function inflateRaw(data: Uint8Array, maxOutput = MAX_IMPORT_BYTES): InflateResult {
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 0 || maxOutput > MAX_IMPORT_BYTES) throw new BoardFormatError('Invalid decompression limit.');
  if (data.length > MAX_IMPORT_BYTES) throw new BoardFormatError('Compressed board data exceeds the 64 MiB import limit.', 'LIMIT_EXCEEDED');
  let position = 0, bitBuffer = 0, bitCount = 0, written = 0;
  let output = new Uint8Array(Math.min(maxOutput, Math.max(4096, data.length * 4)));
  const peek = (count: number): number => {
    while (bitCount < count && position < data.length) { bitBuffer |= data[position++] << bitCount; bitCount += 8; }
    return bitBuffer & ((1 << count) - 1);
  };
  const bits = (count: number): number => {
    const value = peek(count);
    if (bitCount < count) fail('truncated deflate stream.');
    bitBuffer >>>= count; bitCount -= count;
    return value;
  };
  const decode = (code: Huffman): number => {
    const entry = code.table[peek(code.bits)], length = entry & 15;
    if (!length) fail('invalid Huffman code.');
    if (length > bitCount) fail('truncated deflate stream.');
    bitBuffer >>>= length; bitCount -= length;
    return entry >>> 4;
  };
  const reserve = (count: number) => {
    if (written + count > maxOutput) fail('decompressed size exceeds the import limit.', 'LIMIT_EXCEEDED');
    if (written + count > output.length) {
      let size = output.length * 2 || 4096;
      while (size < written + count) size *= 2;
      const grown = new Uint8Array(Math.min(size, maxOutput));
      grown.set(output.subarray(0, written)); output = grown;
    }
  };
  let final = 0;
  do {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      const padding = bitCount & 7;
      bitBuffer >>>= padding; bitCount -= padding;
      position -= bitCount >>> 3; bitBuffer = 0; bitCount = 0; // return whole prefetched bytes
      if (position + 4 > data.length) fail('truncated stored block.');
      const length = data[position] | data[position + 1] << 8, complement = data[position + 2] | data[position + 3] << 8;
      if (length !== (~complement & 0xffff)) fail('stored block length check failed.');
      position += 4;
      if (position + length > data.length) fail('truncated stored block.');
      reserve(length);
      output.set(data.subarray(position, position + length), written);
      written += length; position += length;
      continue;
    }
    if (type === 3) fail('reserved block type.');
    let lengths: Huffman, distances: Huffman;
    if (type === 1) ({ lengths, distances } = fixedTables());
    else {
      const literalCount = bits(5) + 257, distanceCount = bits(5) + 1, codeCount = bits(4) + 4;
      if (literalCount > 286 || distanceCount > 30) fail('too many literal/length or distance codes.');
      const codeLengths = new Uint8Array(19);
      for (let index = 0; index < codeCount; index++) codeLengths[CODE_LENGTH_ORDER[index]] = bits(3);
      const codeTable = huffman(codeLengths, true);
      const all = new Uint8Array(literalCount + distanceCount);
      for (let index = 0; index < all.length;) {
        const symbol = decode(codeTable);
        if (symbol < 16) { all[index++] = symbol; continue; }
        let repeat: number, value = 0;
        if (symbol === 16) { if (!index) fail('repeat code without a previous length.'); value = all[index - 1]; repeat = 3 + bits(2); }
        else if (symbol === 17) repeat = 3 + bits(3);
        else repeat = 11 + bits(7);
        if (index + repeat > all.length) fail('code lengths overflow their table.');
        all.fill(value, index, index + repeat); index += repeat;
      }
      if (!all[256]) fail('missing end-of-block code.');
      lengths = huffman(all.subarray(0, literalCount), false);
      distances = huffman(all.subarray(literalCount), false);
    }
    for (;;) {
      const symbol = decode(lengths);
      if (symbol < 256) {
        if (written === output.length) reserve(1);
        output[written++] = symbol;
        continue;
      }
      if (symbol === 256) break;
      if (symbol > 285) fail('invalid length code.');
      const length = LENGTH_BASE[symbol - 257] + bits(LENGTH_EXTRA[symbol - 257]);
      const distanceSymbol = decode(distances);
      if (distanceSymbol > 29) fail('invalid distance code.');
      const distance = DISTANCE_BASE[distanceSymbol] + bits(DISTANCE_EXTRA[distanceSymbol]);
      if (distance > written) fail('distance too far back.');
      if (written + length > output.length) reserve(length);
      if (distance >= length) output.copyWithin(written, written - distance, written - distance + length);
      else for (let index = 0; index < length; index++) output[written + index] = output[written - distance + index];
      written += length;
    }
  } while (!final);
  return { output: output.length === written ? output : output.slice(0, written), consumedBytes: position - (bitCount >>> 3) };
}

/** zlib container (RFC 1950): CM=8 header with a valid check, no preset dictionary, the deflate stream consumed exactly, then Adler-32. */
export function inflateZlib(data: Uint8Array, maxOutput = MAX_IMPORT_BYTES): Uint8Array {
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 0 || maxOutput > MAX_IMPORT_BYTES) throw new BoardFormatError('Invalid decompression limit.');
  if (data.length < 6) fail('zlib stream is too short.');
  const method = data[0], flags = data[1];
  if ((method & 15) !== 8 || method >>> 4 > 7 || ((method << 8) | flags) % 31) fail('invalid zlib header.');
  if (flags & 32) fail('preset-dictionary zlib streams are not supported.');
  const { output, consumedBytes } = inflateRaw(data.subarray(2), maxOutput);
  const streamBytes = data.length - 6;
  if (consumedBytes < streamBytes) fail(`${streamBytes - consumedBytes} unused byte(s) follow the compressed stream.`);
  if (consumedBytes > streamBytes) fail('the compressed stream overruns its checksum.');
  let a = 1, b = 0;
  for (let start = 0; start < output.length; start += 5552) {
    const end = Math.min(start + 5552, output.length);
    for (let index = start; index < end; index++) { a += output[index]; b += a; }
    a %= 65521; b %= 65521;
  }
  const expected = (data[data.length - 4] << 24 | data[data.length - 3] << 16 | data[data.length - 2] << 8 | data[data.length - 1]) >>> 0;
  if (((b << 16) | a) >>> 0 !== expected) fail('checksum mismatch.');
  return output;
}
