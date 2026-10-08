import type { Board } from '../../../types';
import { parseGenCad } from '../../../gencad';
import { CERTAIN, defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { decodeText, type ParseInput } from '../../common';
import { headText, hasUtf16Mark, ruleHolds } from '../../sniff';
import { gencadHook } from '../../../diagnostics/hooks-text';
import { genCadStorageText, hasGenCadStorageHeader } from '../../gencad-framing';

const GENCAD_SNIFF_CHARS = 16 * 1024;
/**
 * A GenCAD file opens with its `$HEADER` section, so the claim is a line holding exactly that marker. A bare `GENCAD`
 * keyword is no claim: other text formats ignore unknown keywords, so a `GENCAD 1.4` line inside, say, a BVR3 file must
 * not pull it into this adapter, which cannot return it once claimed. Horizontal whitespace only, never `\s`, keeps the
 * scan linear across blank-line floods.
 */
const GENCAD_HEADER = /^[ \t]*\$HEADER[ \t]*$/im;
/** GenCAD keeps its own structured errors (GenCadParseError.issue) for the localized UI. */
export function parseGenCadBoard(input: ParseInput): Board | null {
  const storage = genCadStorageText(input.data);
  const text = decodeText(storage ?? input.data);
  if (!GENCAD_HEADER.test(text.slice(0, GENCAD_SNIFF_CHARS))) return null;
  const board = parseGenCad(text, input.name);
  if (storage) board.warnings.push({ key: 'parse.warning.formatNote', params: { message: 'Read GenCAD text from a length-checked 32-byte CAD storage wrapper; only trailing zero storage padding was removed.' } });
  return board;
}

export default defineBoardAdapter({
  capability: {
    id: 'gencad', name: 'GenCAD 1.4', extensions: ['.cad', '.gcd'], variants: ['GENCAD 1.4 ($HEADER … $SIGNALS)', 'length-checked 32-byte CAD storage wrapper with zero page padding'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'mixed',
    units: 'UNITS header: MM, INCH, THOU/MIL, USER (25.4 / divisor)', sides: 'LAYER TOP/BOTTOM; SHAPE MIRRORX/Y/XY and FLIP select padstack layers',
    notes: ['Exact ROUND/RECTANGLE pads keep their dimensions; other pad shapes are approximated by bounding rectangles.', 'Only the outer closed board contour is drawn; cutouts are disclosed as a warning.', 'Shape instancing is preflighted against an expanded-output budget (250,000 components, 1,000,000 pins, 8,000,000 placed outline, body and pad-corner points) before any pin is created; a file may hold up to 8,000,000 lines within the 64 MiB limit.'],
  },
  listOrder: 10,
  family: 'GenCAD',
  detection: 'signature',
  // The claim rule reads the first 16 Ki characters, which lie within the first 64 KiB in every encoding decodeText uses.
  sniff(input) {
    if (hasGenCadStorageHeader(input.head)) return sniffed(CERTAIN, 'fixed CAD storage header followed by $HEADER and GENCAD at byte 32');
    if (hasUtf16Mark(input.head)) return NO_MATCH;
    const verdict = ruleHolds(input, text => GENCAD_HEADER.test(text.slice(0, GENCAD_SNIFF_CHARS)));
    if (verdict === 'all') {
      const text = headText(input).slice(0, GENCAD_SNIFF_CHARS);
      const version = /^[ \t]*GENCAD[ \t]+([0-9][0-9.]{0,7})[ \t]*$/im.exec(text)?.[1], units = /^[ \t]*UNITS[ \t]+([A-Za-z]{1,8})/im.exec(text)?.[1];
      return sniffed(CERTAIN, '$HEADER section marker line in the first 16 Ki characters', { meta: { ...(version ? { version } : {}), ...(units ? { units: units.toUpperCase() } : {}) } });
    }
    return verdict === 'some' ? sniffed(40, '$HEADER line found in one possible text encoding of the head') : NO_MATCH;
  },
  structure: gencadHook,
  parse: parseGenCadBoard,
});
