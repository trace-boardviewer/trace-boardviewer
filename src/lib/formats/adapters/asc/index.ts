import { defineBoardAdapter, LIKELY, NO_MATCH, sniffed } from '../../adapter';
import { parseAsc } from '../../asc';
import { baseName, hasNul, hasUtf16Mark } from '../../sniff';
import { ascHook } from '../../../diagnostics/hooks-text';

const TRIO = ['format.asc', 'pins.asc', 'nails.asc'];

export default defineBoardAdapter({
  capability: {
    id: 'asc', name: 'ASC companion trio', extensions: ['.asc'], variants: ['format.asc + pins.asc + nails.asc in one directory'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated',
    units: 'inch (×25.4)', sides: 'the side field of the "Part <ref> <side>" line: exactly (T) is top, everything else bottom; pins inherit it; nails carry their own side field', requires: ['companions'],
    notes: ['All three files are required; the result and the notes identity are identical whichever of the three is opened (complete-file-set key).', 'Companions are matched case-insensitively in the selected file\'s directory only; missing files are named in the error.', 'Pads carry no physical size.', 'Remaining gap to supported: no real ASC export was available. OpenBoardView also loads the trio when parts.asc, nets.asc or a .bom file is chosen; here only format.asc, pins.asc and nails.asc open it.'],
  },
  listOrder: 70,
  family: 'Boardview',
  // The trio has no magic number: the file role comes from the name, and parseAsc checks the layout of the first record.
  detection: 'name',
  companions: { sets: [TRIO] },
  sniff(input) {
    if (!TRIO.includes(baseName(input.name))) return NO_MATCH;
    if (!hasUtf16Mark(input.head) && hasNul(input.head, 8192)) return NO_MATCH;
    return sniffed(LIKELY, `${baseName(input.name)}: a member of the ASC trio by name; its first record is checked when read`);
  },
  structure: ascHook,
  parse: parseAsc,
});
