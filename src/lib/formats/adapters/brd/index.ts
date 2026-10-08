import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseBrd } from '../../brd';
import { completeLines, hasUtf16Mark, isComplete, mayContinueAsText, ruleHolds, startsWith } from '../../sniff';
import { brdHook } from '../../../diagnostics/hooks-text';

/** The first four bytes of an encoded file; they decode to "str_" (BRDFile.cpp:41). */
const ENCODED_HEADER = [0x23, 0xe2, 0x63, 0x28];
// Horizontal whitespace only, as in brd.ts: `^\s*` would cross newlines and turn a blank-line flood quadratic.
const BRDOUT_LINE = /^[ \t]*BRDOUT:/m;
const STR_LENGTH = /^[ \t]*str_length:[ \t]*$/m, VAR_DATA = /^[ \t]*var_data:[ \t]*$/m;

export default defineBoardAdapter({
  capability: {
    id: 'brd', name: 'Landrex / TestLink BRD', extensions: ['.brd'], variants: ['plain text (str_length/var_data)', 'rotated-byte encoded (signature 23 E2 63 28)'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'estimated',
    units: 'mil (×0.0254)', sides: 'part type 1 and 4–7 top, 2 and ≥8 bottom, 0 and 3 both; pins inherit the part; nails side 1 top, otherwise bottom',
    notes: ['Pads carry no physical size (radius 0); component bodies come from their pins; the outline comes from the Format record.', 'UNCONNECTED<n> vendor placeholders are no net.', 'Components without pins are omitted with a note (the format gives them no position). A header count that disagrees with the rows is rejected as malformed, where OpenBoardView only logs it and continues.', 'Four-count and six-field var_data headers are accepted; the extra signed fields are not guessed coordinate offsets. Nail nets may be omitted.', 'Extended Pins1 first-pin indices are checked against explicit Pins2 owners; its four extra numeric fields do not establish physical bodies. A terminal source-byte DOS EOF marker or separate NUL/whitespace padding is disclosed; arbitrary suffix data is rejected.'],
  },
  evidence: { status: 'validated with selected real files', validatedWith: 'selected BRD contents; canonical invariants, encoded/plain record counts and the extended Pins1 first-pin indices checked against explicit owners', rewrites: [], extra: ['Pad dimensions remain estimated; unvalidated numeric component metadata is disclosed. Synthetic regressions cover source-byte EOF framing, suffix rejection, byte budgets and interleaved extended Pins1 pin ownership. No sample is distributed.'] },
  listOrder: 20,
  family: 'Boardview',
  detection: 'signature',
  // parseBrd reads a BRDOUT line anywhere as TOPTEST BRD2 (that adapter's sniff), and str_length/var_data lines anywhere as
  // Landrex; markers beyond the sniff window stay possible, and parseBrd itself returns whichever dialect the file holds.
  sniff(input) {
    if (startsWith(input.head, ENCODED_HEADER)) return sniffed(100, 'rotated-byte encoded BRD signature 23 E2 63 28', { meta: { encoded: true } });
    if (hasUtf16Mark(input.head)) return NO_MATCH;
    const complete = isComplete(input);
    if (ruleHolds(input, text => BRDOUT_LINE.test(completeLines(text, complete))) === 'all') return NO_MATCH;
    const verdict = ruleHolds(input, text => { const lines = completeLines(text, complete); return STR_LENGTH.test(lines) && VAR_DATA.test(lines); });
    if (verdict === 'all') return sniffed(81, 'str_length: and var_data: section lines', { meta: { encoded: false } });
    if (verdict === 'some' || mayContinueAsText(input)) return sniffed(6, 'text whose BRD section lines may lie beyond the sniff window');
    return NO_MATCH;
  },
  structure: brdHook,
  parse: parseBrd,
});
