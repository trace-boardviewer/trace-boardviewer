import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { f2bHook, parseF2b, sniffF2b } from '../../f2b';

export default defineBoardAdapter({
  capability: { id: 'unisoft-f2b', name: 'Unisoft F2B (native)', extensions: ['.f2b'], variants: ['Archive versions 6 and 8; component payloads 7, 8 and 9'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'estimated',
    units: 'header resolution in points per inch', sides: 'placed-pin flags; through-hole pins on both sides',
    notes: ['Versioned trace/pin lists, MFC object references and name dictionaries are validated through the end of the archive.', 'Pin coordinates, nets and top/bottom SMD flags were compared with the vendor’s paired F2B/FBA export. Local validation also covers archive version 6.', 'Component bodies and pad sizes are estimated. Tracks, vias, native outlines, BOM values and annotations are omitted.', 'Other archive/payload versions, Unicode strings and extended MFC references are recognized but refused; export GenCAD or a net-and-XY file from Unisoft.'] },
  listOrder: 165, family: 'ECAD design', detection: 'signature',
  sniff: ({ head }) => { const version = sniffF2b(head); return version ? sniffed(100, 'Versioned archive and fixed CTraceList class signature', { variant: String(version), meta: { version: String(version) } }) : NO_MATCH; },
  parse: parseF2b, structure: f2bHook,
});
