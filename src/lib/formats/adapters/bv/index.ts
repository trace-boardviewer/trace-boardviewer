import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { isJetDatabase } from '../../bv-jet';
import { bvHook, parseBv } from '../../bv';

export default defineBoardAdapter({
  capability: {
    id: 'bv', name: 'Jet BV boardview', extensions: ['.bv'], variants: ['Jet4 Layout / Pin / Nail boardview tables', 'Jet3 scalar table framing (synthetic validation)', 'optional Layout Group column'],
    status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'estimated', units: 'inch (×25.4)',
    sides: 'explicit (T) / (B) table fields; component sides follow all their pins; test points carry their own side',
    notes: ['Original bounded Jet3/Jet4 scalar-table reader without a database dependency or Buffer global. Required Layout, Pin and Nail tables and all their declared live rows are validated.', 'Pin Name supplies the pin identity; numeric Pin is its source ordinal. Nail NetName supplies test-point connectivity. Layer, grid, net-id and virtual-pin annotations do not invent connections. Exporter UNCONNECTED placeholders remain unconnected. Repeated test-point labels are retained as separate rows and disclosed.', 'Pads and component bodies have no physical dimensions and use the disclosed viewing estimates. Non-zero outline radii use straight segments. File data-page encryption, overflow rows, multiple Layout groups, other Access engines and unsupported required column types are refused explicitly.'],
  },
  evidence: { status: 'validated with real Jet4 boardview files', validatedWith: '42 paths / 30 distinct contents; every Layout, Pin and Nail table cell compared with an independent MIT reader', rewrites: [], extra: ['Complete declared row counts, inch coordinates, source pin names, nets and side markers agree. Jet3 is covered by original synthetic fixtures only. No board samples are distributed.'] },
  listOrder: 75, family: 'Boardview', detection: 'signature',
  sniff(input) { return isJetDatabase(input.head) ? sniffed(95, 'Standard Jet DB signature', { variant: input.head[20] === 0 ? 'Jet3' : input.head[20] === 1 ? 'Jet4' : 'other Jet version' }) : NO_MATCH; },
  parse: parseBv,
  structure: bvHook,
});
