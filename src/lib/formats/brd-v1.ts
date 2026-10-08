/* Original TRACE module, MIT. The body encoding is unidentified; no encryption-key type is inferred. */
import { BoardFormatError, MAX_IMPORT_BYTES, startsWithBytes, type BoardParser } from './common';
import type { StructureHook } from './structure-hook';

const HEADER = [0x42, 0x52, 0x44, 0x5f, 0x56, 0x31, 0x2e, 0x30, 0, 0, 0, 0, 0, 0, 0, 0] as const;
export const brdV1Signature = (data: Uint8Array): boolean => startsWithBytes(data, HEADER);

export const parseBrdV1: BoardParser = input => {
  if (!brdV1Signature(input.data)) return null;
  if (input.data.length > MAX_IMPORT_BYTES) throw new BoardFormatError('BRD_V1.0 data exceeds the 64 MiB import limit.', 'LIMIT_EXCEEDED', 'brd-v1');
  if (input.data.length === HEADER.length) throw new BoardFormatError('BRD_V1.0 header has no encoded board payload.', 'INVALID_FORMAT', 'brd-v1');
  throw new BoardFormatError('BRD_V1.0 encoded boardview detected. TRACE has no validated decoder for this payload; an FZ or XZZ key cannot decode it. Open it in the program that produced this BRD_V1.0 export and request a readable GenCAD or supported boardview export. The writer and encoding specification are needed to add native support.', 'UNSUPPORTED_VARIANT', 'brd-v1');
};

export const brdV1Hook: StructureHook = {
  id: 'brd-v1', kind: 'binary', keywords: [], steps: ['header'],
  collect({ data }, sink) {
    if (!brdV1Signature(data)) return;
    sink.variant('brd-v1-opaque');
    sink.code('version', 1);
    sink.block(0, HEADER.length, 8);
    if (data.length > HEADER.length) sink.block(1, data.length - HEADER.length, 8);
    sink.reached('header');
  },
};
