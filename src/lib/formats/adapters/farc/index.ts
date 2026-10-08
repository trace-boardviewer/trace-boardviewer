import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { farcHook, isFarc, isFarcZip, parseFarc } from '../../farc';
import { startsWith } from '../../sniff';
export default defineBoardAdapter({
  capability: { id: 'farc', name: 'Fabmaster FARC / FAZ', extensions: ['.far', '.farc', '.faz'], variants: ['FARC ASCII section revision 1', 'FAZ ZIP containing one FAR job'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'estimated', units: 'mil (×0.0254)', sides: 'TOP/BOTTOM placements; TPIN top, BPIN bottom, DPIN both; vias carry their own side', notes: ['Absolute FABXYDATA positions are cross-checked against NETS membership and PACKAGE pin identities; complete counts and archive boundaries are mandatory.', 'Pad sizes are estimated; vias are generated one-pin components. Straight TRACK outlines are imported; routing and tester settings are omitted. Unknown revisions or record layouts are refused.'] },
  evidence: { status: 'validated with selected real job exports', validatedWith: '69 FAZ paths / 49 distinct jobs; source counts, all pin positions, identities, nets, sides and placement positions/angles checked independently', rewrites: [], extra: ['451,164 components and 911,179 pins across the distinct jobs. ZIP extraction was compared with fflate, independently of the shipped ZIP reader. All observed job metadata declares MILS. No private board files are distributed.'] },
  listOrder: 212, family: 'ECAD design', detection: 'signature',
  structure: farcHook,
  sniff(input) { if (isFarc(input.head)) return sniffed(98, 'FARC ASCII FABMASTER header'); if (isFarcZip(input.head) || /\.faz$/i.test(input.name) && startsWith(input.head, [0x50, 0x4b, 3, 4])) return sniffed(85, 'FAZ ZIP job archive'); return NO_MATCH; },
  parse: parseFarc,
});
