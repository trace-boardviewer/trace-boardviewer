import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { brdV1Hook, brdV1Signature, parseBrdV1 } from '../../brd-v1';

export default defineBoardAdapter({
  capability: {
    id: 'brd-v1', name: 'BRD_V1.0 encoded boardview', extensions: ['.brd'], variants: ['BRD_V1.0 plus eight zero bytes and opaque payload'], status: 'recognized-unsupported', validation: 'none', electrical: 'none', geometry: 'estimated',
    units: 'unknown', sides: 'unknown',
    notes: ['The full 16-byte signature identifies this family. The payload encoding and writing program have not been established; no encryption-key type is inferred.', 'Request a readable GenCAD or supported boardview export from the original writer. FZ and XZZ keys do not apply.'],
  },
  listOrder: 35, family: 'Boardview', detection: 'signature',
  sniff: ({ head }) => brdV1Signature(head) ? sniffed(100, 'Exact 16-byte BRD_V1.0 encoded-board header', { variant: 'BRD_V1.0' }) : NO_MATCH,
  parse: parseBrdV1, structure: brdV1Hook,
});
