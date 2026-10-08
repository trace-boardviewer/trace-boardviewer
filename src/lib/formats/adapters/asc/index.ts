import { defineBoardAdapter, LIKELY, NO_MATCH, sniffed } from '../../adapter';
import { parseAsc } from '../../asc';
import { baseName, hasUtf16Mark } from '../../sniff';
import { ascHook } from '../../../diagnostics/hooks-text';

const TRIO = ['format.asc', 'pins.asc', 'nails.asc'];
const ENTRIES = [...TRIO, '@format.asc'];

export default defineBoardAdapter({
  capability: {
    id: 'asc', name: 'ASC companion trio', extensions: ['.asc'], variants: ['format.asc + pins.asc + nails.asc in one directory', '@format.asc outline with ordinary pins.asc/nails.asc companions'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'estimated',
    units: 'inch (×25.4)', sides: 'the side field of the "Part <ref> <side>" line: exactly (T) is top, everything else bottom; pins inherit it; nails carry their own side field', requires: ['companions'],
    notes: ['One outline export and both pins.asc and nails.asc are required. Opening @format.asc explicitly uses its outline; pins/nails entries prefer format.asc and use @format.asc only when the ordinary outline is absent.', 'Companions are matched case-insensitively in the selected file\'s directory only; missing files are named in the error.', 'Pads carry no physical size. Optional radii and probe annotations are disclosed; a pin containing only its id and name has no drawable position and is omitted with a note.', 'Only format.asc, @format.asc, pins.asc and nails.asc open the trio; parts.asc, nets.asc and other sidecars contain auxiliary data.'],
  },
  evidence: { status: 'validated with selected real files', validatedWith: 'selected ASC entry files with their same-directory companions; canonical geometry, sides, component links and net membership checked', rewrites: [], extra: ['Shortened headers, radius/grid columns, probe-list variants and mixed-case Part records have synthetic regressions. No sample is distributed.'] },
  listOrder: 70,
  family: 'Boardview',
  // The trio has no magic number: the file role comes from the name, and parseAsc checks the layout of the first record.
  detection: 'name',
  companions: { sets: [TRIO, ['@format.asc', 'pins.asc', 'nails.asc']] },
  sniff(input) {
    if (!ENTRIES.includes(baseName(input.name))) return NO_MATCH;
    if (!hasUtf16Mark(input.head)) {
      const nul = input.head.subarray(0, 8192).indexOf(0);
      const terminal = nul > 0 && input.size === input.head.length && (input.head[nul - 1] === 10 || input.head[nul - 1] === 13)
        && input.head.subarray(nul).every(byte => byte === 0 || byte === 9 || byte === 10 || byte === 13 || byte === 32);
      if (nul >= 0 && !terminal) return NO_MATCH;
    }
    return sniffed(LIKELY, `${baseName(input.name)}: a member of the ASC trio by name; its first record is checked when read`);
  },
  structure: ascHook,
  parse: parseAsc,
});
