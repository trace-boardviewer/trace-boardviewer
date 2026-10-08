/* Original bounded framing reader. The private checked CAD exports store a complete
 * GenCAD text after a fixed 32-byte header; source length is uint32LE at offset 16. */
import { BoardFormatError, MAX_IMPORT_BYTES } from './common';

export function hasGenCadStorageHeader(data: Uint8Array): boolean {
  if (data.length < 47 || data[0] !== 0x9c || data[1] !== 0 || data[4] !== 0 || data[31] !== 4) return false;
  for (const i of [8, 9, 10, 11, 12, 13, 14, 15, 28, 29, 30]) if (data[i] !== 0) return false;
  const marker = '$HEADER\r\nGENCAD';
  for (let i = 0; i < marker.length; i++) if (data[32 + i] !== marker.charCodeAt(i)) return false;
  return true;
}

/** Return the unchanged text bytes only for the exact length-delimited storage variant. */
export function genCadStorageText(data: Uint8Array): Uint8Array | null {
  if (!hasGenCadStorageHeader(data)) return null;
  const fail = (message: string, code: 'INVALID_FORMAT' | 'LIMIT_EXCEEDED' = 'INVALID_FORMAT'): never => {
    throw new BoardFormatError(`GenCAD storage wrapper: ${message}`, code, 'GenCAD 1.4');
  };
  if (data.length > MAX_IMPORT_BYTES) fail('source exceeds the import limit.', 'LIMIT_EXCEEDED');
  const header = new DataView(data.buffer, data.byteOffset, 32);
  if (data.length % 4096 !== 0 || header.getUint32(16, true) !== data.length) fail('declared source length does not match a complete 4096-byte storage page set.');
  const secondaryLength = header.getUint32(20, true);
  if (secondaryLength < data.length || secondaryLength % 4096 !== 0) fail('invalid secondary page length.');
  // No separate text-length field has been verified. Only trailing zero storage
  // padding can be removed; all other payload bytes reach the strict GenCAD parser.
  let end = data.length;
  while (end > 32 && data[end - 1] === 0) end--;
  if (end === data.length || (data[end - 1] !== 10 && data[end - 1] !== 13)) fail('text must end at a complete line followed by zero storage padding.');
  return data.subarray(32, end);
}
