import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { encodedNailsFirst, parseBdv } from '../../bdv';
import { hasUtf16Mark, indexOfBytes, mayContinueAsText } from '../../sniff';
import { bdvHook } from '../../../diagnostics/hooks-text';

// The markers bdv.ts searches for anywhere in the file: the encoded first line, or the format and pins section markers.
const ENCODED_MARKER = 'dd:1.3?,r?-=bb', FORMAT_MARKER = '<<format.asc>>', PINS_MARKER = '<<pins.asc>>';

export default defineBoardAdapter({
  capability: {
    id: 'bdv', name: 'Honhan BDV', extensions: ['.bdv'], variants: ['plain <<format.asc>>/<<pins.asc>>/<<nails.asc>> sections', 'encoded (keyless per-line cipher; line 1 reads dd:1.3?,r?-=bb)', 'encoded nails-first export without an outline'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'estimated',
    units: 'inch (×25.4)', sides: 'the side field of the "Part <ref> <side>" line: exactly (T) is top, everything else bottom; pins inherit it; nails carry their own side field',
    notes: ['Section column headings and compact metadata headers are accepted. Outline rows may include a radius; nonzero-radius segments are shown straight with a notice.', 'Pads carry no physical size; test points become one-pin TP:<probe> components. Probe IDs can be omitted, comma-separated or continued on the next row; net names can contain spaces; a test point row names its net with one word, or with the whole name when a pin already carries it.', 'The encoded nails-first variant retains complete component/pin/test-point records with their inch coordinates and explicit sides; its absent outline is estimated and disclosed.'],
  },
  evidence: { status: 'validated with selected real files', validatedWith: 'selected plain, encoded and nails-first exports; finite canonical geometry, explicit sides, component links and reverse net membership checked', rewrites: [], extra: ['Malformed or incomplete consumed records remain rejected. This evidence does not prove every BDV dialect or physical pad dimensions. No sample is distributed.'] },
  listOrder: 40,
  family: 'Boardview',
  detection: 'signature',
  sniff(input) {
    const { head } = input;
    if (hasUtf16Mark(head)) return NO_MATCH;
    if (encodedNailsFirst(head)) return sniffed(84, 'encoded BDV nails-first signature');
    if (indexOfBytes(head, ENCODED_MARKER) >= 0) return sniffed(84, 'encoded BDV first-line signature');
    if (indexOfBytes(head, FORMAT_MARKER) >= 0 && indexOfBytes(head, PINS_MARKER) >= 0) return sniffed(84, '<<format.asc>> and <<pins.asc>> section markers');
    return mayContinueAsText(input) ? sniffed(8, 'BDV markers may lie beyond the sniff window') : NO_MATCH;
  },
  structure: bdvHook,
  parse: parseBdv,
});
