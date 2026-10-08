import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseSamsungCad } from '../../samsung-cad';
import { hasUtf16Mark, indexOfBytes, mayContinueAsText } from '../../sniff';
import { samsungCadHook } from '../../../diagnostics/hooks-text';

// samsung-cad.ts (CADFile::verifyFormat): both markers anywhere in the file.
const PANEL = '###Panel Added', PIN_KEYWORD = 'C_PIN';

export default defineBoardAdapter({
  capability: {
    id: 'samsung-cad', name: 'Samsung CAD', extensions: ['.cad'], variants: ['###Panel Added with COMP / C_PIN / N_VIA records'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'estimated',
    units: 'inch (×25.4), as OpenBoardView reads it; physical scale is not independently measured', sides: 'COMP side field: 1 top, any other value bottom; pins inherit the component; N_VIA supplies its own side',
    notes: ['The layout follows the OpenBoardView reference reader (the only public description found); both the "###Panel Added" and "C_PIN" markers must be present, which also keeps GenCAD .cad files apart.', 'Pads carry no physical size and components no body or outline: positions come from the C_PIN records and test vias; the outline is inferred from those positions.', 'The pin number is the text after the dash in the REF-PIN field (upstream discards it); a leading "/" of a net name is removed; N_VIA records become generated test-point components on their stated net and side.'],
  },
  evidence: { status: 'validated with a selected real file', validatedWith: 'checked by the maintainer on a real export; components, component pins and test vias counted independently', rewrites: [], extra: ['All counted pins and test vias are imported. The checked file validates record handling, not physical unit scale or every Samsung CAD dialect. No sample is distributed.'] },
  listOrder: 140,
  family: 'Boardview',
  detection: 'structure',
  sniff(input) {
    const { head } = input;
    if (hasUtf16Mark(head)) return NO_MATCH;
    if (indexOfBytes(head, PANEL) >= 0 && indexOfBytes(head, PIN_KEYWORD) >= 0) return sniffed(85, '"###Panel Added" and "C_PIN" markers');
    return mayContinueAsText(input) ? sniffed(9, 'Samsung CAD markers may lie beyond the sniff window') : NO_MATCH;
  },
  structure: samsungCadHook,
  parse: parseSamsungCad,
});
