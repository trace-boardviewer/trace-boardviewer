import type { SniffInput } from '../../adapter';
import { indexOfBytes, isComplete } from '../../sniff';

const SIGNATURE = 'BVRAW_FORMAT_';
const WORD = /[A-Za-z0-9_]/;
export interface BvrHeader {
  readonly version: number;
  /** The header is the first line of the file (after an optional UTF-8 BOM and indentation), where every BVR file has it. */
  readonly firstLine: boolean;
}
/**
 * The first "BVRAW_FORMAT_<n>" line in the head, read as bvr.ts reads it (optionally indented, after an optional UTF-8
 * BOM, digits followed by a non-word character or the end of the file). 'open' means the head ends inside a candidate, so
 * only the full file can tell; undefined means no such line in the head.
 */
export function bvrHeader(input: SniffInput): BvrHeader | 'open' | undefined {
  const data = input.head, complete = isComplete(input);
  for (let at = indexOfBytes(data, SIGNATURE); at >= 0; at = indexOfBytes(data, SIGNATURE, at + 1)) {
    let back = at - 1;
    while (back >= 0 && (data[back] === 32 || data[back] === 9)) back--;
    const bom = back === 2 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
    const lineStart = back < 0 || data[back] === 10 || data[back] === 13 || bom;
    let end = at + SIGNATURE.length, digits = '';
    while (end < data.length && data[end] >= 48 && data[end] <= 57 && digits.length < 9) digits += String.fromCharCode(data[end++]);
    if (end >= data.length && !complete) return lineStart ? 'open' : undefined;
    const boundary = end >= data.length || !WORD.test(String.fromCharCode(data[end]));
    if (lineStart && digits && boundary) return { version: Number(digits), firstLine: back < 0 || bom };
  }
  return undefined;
}
