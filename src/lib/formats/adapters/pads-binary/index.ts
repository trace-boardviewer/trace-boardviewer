import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { padsBinaryHook, padsBinaryVersion, parsePadsBinary } from '../../pads-binary';

export default defineBoardAdapter({
  capability: {
    id: 'pads-binary', name: 'PADS native SDB', extensions: ['.pcb'], variants: ['native database 0x2026 / 0x2027'], status: 'recognized-unsupported', validation: 'none', electrical: 'none', geometry: 'estimated',
    units: 'native BASIC = 1/38100 mil (no geometry imported)', sides: 'native placement mirror bit (no geometry imported)',
    notes: ['Exact native signature, bounded controller directory, flat-controller prefix and EOF document footer are diagnosed. Custom-decal terminal geometry has not been independently validated, so no board is imported.', 'Both tested KiCad builds failed to import all 21 investigated native databases. Request a PADS Layout ASCII export for conversion through KiCad, then inspect geometry and nets before saving .kicad_pcb. This export route has not been tested on these designs. See docs/PADS-BINARY.md.', 'Diagnostic terminal-pool storage counts are not treated as live pin counts. Other database versions remain unrecognized.'],
  },
  listOrder: 165, family: 'ECAD design', detection: 'signature',
  sniff({ head }) {
    const version = padsBinaryVersion(head);
    return version === null ? NO_MATCH : sniffed(100, 'PADS native 00 FF magic and exact database version', { variant: `0x${version.toString(16)}`, meta: { version } });
  },
  parse: parsePadsBinary, structure: padsBinaryHook,
});
