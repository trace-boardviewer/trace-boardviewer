import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { allegro, refuseFamily } from '../../recognizers';

export default defineBoardAdapter({
  capability: {
    id: 'allegro-brd', name: 'Cadence Allegro BRD (native)', extensions: ['.brd'], variants: ['binary database; documented magic 0x00130000–0x00150000 (16.0–18.0+) plus "all" at offset 0xF8'], status: 'recognized-unsupported', validation: 'none', electrical: 'none', geometry: 'estimated',
    units: 'n/a', sides: 'n/a', notes: ['Native Allegro databases are proprietary; export GenCAD or use the vendor viewer.', 'Databases older than 16.0 are not recognized.'],
  },
  listOrder: 160,
  family: 'ECAD design',
  detection: 'signature',
  sniff: ({ head }) => { const found = allegro(head); return found ? sniffed(100, `Allegro database magic (${found.detail}) and "all" at 0xF8`, { variant: found.detail, ...(found.detail ? { meta: { version: found.detail } } : {}) }) : NO_MATCH; },
  parse: refuseFamily('allegro-brd'),
});
