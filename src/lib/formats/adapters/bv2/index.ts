import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { hasBv2Header, parseBv2 } from '../../bv2';

export default defineBoardAdapter({
  capability: { id: 'bv2', name: 'BV2 text boardview', extensions: ['.bv2'], variants: ['#Layout# / #Nail# / #Pin# comma-separated tables', 'optional Layout Group column'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'estimated',
    units: 'inch (×25.4)', sides: 'explicit (T) / (B) fields; component sides follow all their pins; nails carry their own side',
    notes: ['Every CSV section, header, field count and scalar field is checked; quoted names retain commas, quotes and line breaks. No database dependency is required.', 'Shares the BV table mapping: source Pin Name and pin Netname, test-point NetName, inch coordinates and side fields provide identity and connectivity; repeated numeric Pin annotations are allowed while source names remain unique on each component and side. Repeated test-point labels stay separate.', 'Pads and component bodies have no physical dimensions and use disclosed estimates. MIL and NO_PROBE Type annotations do not model probe sizes or availability; NO_PROBE electrical points are retained with a warning. Non-zero outline radii use straight segments. Multiple Layout groups and unknown sections or headers are refused. The text export has no declared row counts or terminal marker, so completeness beyond its available records cannot be established.'],
  },
  evidence: { status: 'validated with real text exports', validatedWith: 'two complete CSV exports checked at every Layout, Pin and Nail row', rewrites: [], extra: ['Pin identities, positions, nets, owners, sides and outline point order agree with independently traversed source rows. No samples are distributed.'] },
  listOrder: 76, family: 'Boardview', detection: 'signature',
  sniff(input) { return hasBv2Header(input.head) ? sniffed(94, '#Layout# first CSV section') : NO_MATCH; },
  parse: parseBv2,
});
