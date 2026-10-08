import { CERTAIN, defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { CFB_MAGIC, looksAscii, parseAltium } from '../../altium';
import { extensionOf, startsWith } from '../../sniff';
import { altiumHook } from '../../../diagnostics/hooks-binary';

const EXTENSIONS = ['.pcbdoc', '.cmpcbdoc', '.cspcbdoc'];

export default defineBoardAdapter({
  capability: {
    id: 'altium', name: 'Altium PcbDoc', extensions: EXTENSIONS, variants: ['binary OLE compound (CFB version 3) record streams', 'ASCII |RECORD=Board|KIND=Protel_Advanced_PCB lines (keys checked against binary twins)'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'real',
    units: 'binary int32 1/10000 mil; text values need a mil/mm/in suffix', sides: 'pad layer 1 top, 32 bottom, 74 both; inner and non-copper pads are skipped and counted; components on MIDn are skipped and counted',
    notes: ['Only components, nets, pads and the first Board6 outline record are read; tracks, vias, arcs, fills, regions, text, models and rules are not, and every import says so.', 'Layouts follow public documentation (KiCad developer docs, Altium API reference, [MS-CFB]); component bodies come from pad extents and values are not read.', 'Round unequal / octagonal / rounded-rectangle pads are drawn as rectangles and counted as approximated; outline arcs are drawn as chords.', 'Validated on 28 openly licensed boards (26 binary, 2 ASCII). Independent raw-stream component, pad and net counts agree for all binary boards; two ASCII/binary twins agree on every pad to 1 micrometre. Altium-written P-CAD netlists agree on all 3,151 and 3,146 connected pads of the two designs; only the two inner-layer net-tie pads are omitted. Free pads and copper are not drawn. Hole-only pads use hole diameter, not copper land size. Compound-file version 4 is unsupported; SchLib/PcbLib are named and rejected. Other writers and versions remain unverified.'],
  },
  listOrder: 130,
  family: 'ECAD design',
  detection: 'signature',
  // altium.ts claims every OLE compound file (a non-Altium one is named and refused) and text whose first line is |RECORD= or |HEADER=.
  // The compound-file signature is shared with every Office document and with Altium's own SchDoc, and the Altium streams lie in the
  // directory, beyond the head: it is CERTAIN only for a name this reader owns, otherwise POSSIBLE, so that a spreadsheet or a schematic is not
  // called a board in a listing (the parse still claims the file and names what it is).
  sniff: ({ head, name }) => startsWith(head, CFB_MAGIC)
    ? EXTENSIONS.includes(extensionOf(name)) ? sniffed(CERTAIN, 'OLE compound file signature (the Altium streams are checked when read)', { meta: { storage: 'compound file' } })
      : sniffed(30, 'OLE compound file signature under a name that is not an Altium PCB (the Altium streams are checked when read)', { meta: { storage: 'compound file' } })
    : looksAscii(head) ? sniffed(CERTAIN + 5, '|RECORD= / |HEADER= first line of an ASCII PcbDoc', { meta: { storage: 'ascii' } }) : NO_MATCH,
  structure: altiumHook,
  parse: parseAltium,
});
