import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseCst } from '../../cst';
import { cstHook } from '../../../diagnostics/hooks-binary';

export default defineBoardAdapter({
  capability: {
    id: 'cst', name: 'CAST CST', extensions: ['.cst'], variants: ['LE int16 binary, CDev/CPad sections'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated',
    units: 'mil (×0.0254)', sides: 'layer 0x0C top, 0x01 bottom; every other layer code is rejected; a negative part id creates one ICT part on both sides',
    notes: ['Pin positions are real; pad size, body and outline are absent (a missing-outline warning is shown).', 'Pin numbers are file-order ordinals, not physical pin names; components with no pins are omitted with a note.', 'An unknown layer code is rejected on purpose (OpenBoardView places such a component on both sides; finding B04).', 'Remaining gap to supported: no real CAST file was available.'],
  },
  listOrder: 100,
  family: 'Boardview',
  detection: 'signature',
  // cst.ts: the fixed "u16 4, CDev" section header at offset 6 is the de-facto signature.
  sniff: ({ head }) => head.length >= 12 && head[6] === 4 && head[7] === 0 && head[8] === 0x43 && head[9] === 0x44 && head[10] === 0x65 && head[11] === 0x76
    ? sniffed(100, 'CDev section header at offset 6') : NO_MATCH,
  structure: cstHook,
  parse: parseCst,
});
