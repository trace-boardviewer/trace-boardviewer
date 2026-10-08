import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { BoardFormatError } from '../../common';
import { hasNul, latin1 } from '../../sniff';

export default defineBoardAdapter({
  capability: {
    id: 'vs2', name: 'VS2 assembly listing', extensions: ['.lst'], variants: ['$VS2 fixed-column listing with CODE/PLN/LEAD-L1/LEAD-L2/CENTER POS/ORI columns'], status: 'recognized-unsupported', validation: 'none', electrical: 'none', geometry: 'estimated',
    units: 'the examined positions match CASTw CST mil coordinates after translation; the listing has no unit declaration', sides: 'PLN NBR matches the numbered CST component layer; per-design outer-plane mapping is unverified',
    notes: ['The CASTw assembly listing contains component centers, two lead reference points, R/B/L/T orientation annotations and additional $SP pages.', 'Matched LST/CST exports establish the coordinate scale and shared numbered planes, including 1, 4, 8, 9, 10 and 12. They do not establish each design’s outer-layer mapping or a complete physical pin/net model, so the listing is recognized with an explanation.'],
  },
  listOrder: 151,
  family: 'Boardview',
  detection: 'signature',
  sniff({ head }) {
    if (hasNul(head, 1024)) return NO_MATCH;
    return /^\$VS2(?:[ \t]|\r?\n|$)/.test(latin1(head)) ? sniffed(95, '$VS2 assembly-list header on the first line') : NO_MATCH;
  },
  parse(input) {
    if (hasNul(input.data, 1024) || !/^\$VS2(?:[ \t]|\r?\n|$)/.test(latin1(input.data.subarray(0, 1024)))) return null;
    throw new BoardFormatError('CASTw VS2 assembly listing detected. Its per-design top/bottom plane mapping and complete electrical pin model are not validated. A verified layer stack and full pin/net export are required.', 'UNSUPPORTED_VARIANT', 'vs2');
  },
});
