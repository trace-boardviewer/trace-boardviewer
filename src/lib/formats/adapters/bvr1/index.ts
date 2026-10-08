import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseBvr } from '../../bvr';
import { hasUtf16Mark } from '../../sniff';
import { bvrHeader } from '../bvr/header';
import { bvrHook } from '../../../diagnostics/hooks-text';

export default defineBoardAdapter({
  capability: {
    id: 'bvr1', name: 'BVR raw boardview (BVRAW_FORMAT_1)', extensions: ['.bvr'], variants: ['BVRAW_FORMAT_1 (<<Layout>>/<<Pin>>/<<Nail>>)'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'estimated',
    units: 'inch (×25.4)', sides: 'per-line (T) top, otherwise bottom',
    notes: ['The one-line section headers follow the OpenBoardView reference reader. Layout records may contain two additional numeric metadata fields; only X/Y determine the outline, with a note.', 'Pads carry no physical size; components without pins are omitted with a note.'],
  },
  evidence: { status: 'validated with selected real files', validatedWith: 'selected BVRAW_FORMAT_1 exports; canonical geometry, sides, component links and net membership checked', rewrites: [], extra: ['Additional numeric layout metadata has synthetic regressions. No sample is distributed.'] },
  listOrder: 60,
  family: 'Boardview',
  detection: 'signature',
  // A header beyond the sniff window is the BVR3 adapter's possible case (parseBvr reads both versions).
  sniff(input) {
    if (hasUtf16Mark(input.head)) return NO_MATCH;
    const header = bvrHeader(input);
    if (typeof header !== 'object' || header.version !== 1) return NO_MATCH;
    return sniffed(header.firstLine ? 100 : 83, `BVRAW_FORMAT_1 header ${header.firstLine ? 'on the first line' : 'line'}`, { variant: 'BVRAW_FORMAT_1', meta: { version: 1 } });
  },
  structure: bvrHook,
  parse: parseBvr,
});
