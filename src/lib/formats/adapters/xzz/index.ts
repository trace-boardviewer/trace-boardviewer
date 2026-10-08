import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseXzz } from '../../xzz';
import { xzzHook } from '../../../diagnostics/hooks-binary';

const MAGIC = 'XZZPCB';
const matches = (data: Uint8Array, xor: number) => {
  for (let index = 0; index < MAGIC.length; index++) if ((data[index] ^ xor) !== MAGIC.charCodeAt(index)) return false;
  return true;
};

export default defineBoardAdapter({
  capability: {
    id: 'xzz', name: 'XZZ PCB', extensions: ['.pcb'], variants: ['plain XZZPCB header', 'XOR-obfuscated header (marker v6v6555v6v6)', 'DES-ECB encrypted part/pin records (16 hex-digit key)'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'mixed',
    units: 'raw ÷ 10000 mil, then ×0.0254', sides: 'component side is not decoded: every part is placed on top and this is disclosed',
    notes: ['The DES key is only needed for encrypted records (kept for the session only).', 'Pin and test-pad positions are real; pad sizes are unknown (estimated). The outline comes from layer 28 (arcs as nine chords); cutouts and open chains are disclosed.', 'Vias and text blocks are skipped; unknown block types are disclosed.', 'A component block without pins is omitted with a note; an unknown component sub-record type is rejected, where OpenBoardView skips byte by byte.', 'Remaining gap to supported: no real XZZ file was available.'],
  },
  listOrder: 90,
  family: 'Boardview',
  detection: 'signature',
  keys: ['xzz'],
  // xzz.ts: "XZZPCB" at offset 0, in clear or XOR-ed with the byte at 0x10.
  sniff(input) {
    const { head } = input;
    if (head.length < MAGIC.length) return NO_MATCH;
    if (matches(head, 0)) return sniffed(100, 'XZZPCB header', { meta: { obfuscated: false } });
    const key = input.size > 0x10 ? head[0x10] : 0;
    return key !== 0 && matches(head, key) ? sniffed(100, 'XOR-obfuscated XZZPCB header', { meta: { obfuscated: true } }) : NO_MATCH;
  },
  structure: xzzHook,
  parse: parseXzz,
});
