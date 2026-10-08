import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseBrd } from '../../brd';
import { completeLines, hasUtf16Mark, isComplete, ruleHolds, startsWith } from '../../sniff';
import { brdHook } from '../../../diagnostics/hooks-text';

/** As brd.ts: a BRDOUT line, with horizontal whitespace only before it. */
const BRDOUT_LINE = /^[ \t]*BRDOUT:/m;

export default defineBoardAdapter({
  capability: {
    id: 'brd2', name: 'TOPTEST BRD2', extensions: ['.brd'], variants: ['BRDOUT/NETS/PARTS/PINS/NAILS'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated',
    units: 'mil (×0.0254)', sides: 'side codes 1 top, 2 bottom, 0 both; bottom Y is boardHeight − rawY; a part with no pin on its own side becomes both; nails side 1 top, otherwise bottom',
    notes: ['Pads carry no physical size (radius 0); part body rectangles and the outline come from the file.', 'A truncated BRDOUT file is reported as a malformed BRD2, not as unrecognized.', 'A component without pins keeps its declared side and body rectangle (OpenBoardView turns it into a through-hole part on both sides); header counts that disagree with the rows are rejected.', 'Remaining gap to supported: no real BRD2 file was available.'],
  },
  listOrder: 30,
  family: 'Boardview',
  detection: 'signature',
  // A BRDOUT line anywhere wins over the Landrex markers (brd.ts); a BRDOUT line beyond the window is the BRD adapter's possible case.
  sniff(input) {
    if (startsWith(input.head, [0x23, 0xe2, 0x63, 0x28]) || hasUtf16Mark(input.head)) return NO_MATCH;
    const complete = isComplete(input);
    const verdict = ruleHolds(input, text => BRDOUT_LINE.test(completeLines(text, complete)));
    return verdict === 'all' ? sniffed(82, 'BRDOUT: header line') : verdict === 'some' ? sniffed(40, 'BRDOUT: line in one possible text encoding of the head') : NO_MATCH;
  },
  structure: brdHook,
  parse: parseBrd,
});
