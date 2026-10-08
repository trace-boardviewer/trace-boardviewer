import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseKicad } from '../../kicad';
import { headText, hasUtf16Mark, isComplete, ruleHolds } from '../../sniff';
import { kicadHook } from '../../../diagnostics/hooks-text';

/** kicad.ts: optional blanks and ";" comment lines, then the "(kicad_pcb" root. */
const ROOT = /^\s*(?:;[^\n]*\n\s*)*\(kicad_pcb(?:\s|\))/;
/** A head that ends while still inside that prologue (or inside the root token) may continue as a KiCad board. */
const OPEN_PROLOGUE = /^\s*(?:;[^\n]*\n\s*)*(?:;[^\n]*|\([a-z_]{0,9})?$/;

export default defineBoardAdapter({
  capability: {
    id: 'kicad', name: 'KiCad PCB', extensions: ['.kicad_pcb'], variants: ['S-expression kicad_pcb (versions 4–9: footprint and legacy module records)'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'real',
    units: 'mm', sides: 'front copper layer top (F.Cu, or the name the design gives layer 0), back copper layer bottom (B.Cu, or the name the design gives layer 31; layer 2 from KiCad 9) (file geometry already mirrored); *.Cu pads both',
    notes: ['Fixtures cover KiCad 4/5 legacy module records, KiCad 6 footprint+fp_text and KiCad 8 property styles; no real KiCad file was tested. KiCad 3 and older are unsupported; tracks, zones and vias are ignored (nets come from pads only).', 'Pad angles are board-absolute (previous author\'s reading, synthetic fixtures only); footprint rotation only places local pad positions. Rect and equal-size circle pads are exact; oval, roundrect, trapezoid, custom and non-square circle pads are drawn as bounding rectangles and counted as approximated.', 'Edge.Cuts (line, rect, poly, circle, arc, curve): the largest closed loop is the outline; inner loops and footprint-level Edge.Cuts are disclosed as cutouts but not drawn; open chains are never closed.', 'Contradictory net ids/names are rejected. A user net literally named UNCONNECTED keeps its identity; only KiCad single-pad unconnected-(…) placeholders are treated as no-connects.'],
  },
  evidence: {
    status: 'validated with real files',
    validatedWith: 'real files: KiCad 9 demo (pic_programmer), Antmicro Jetson Nano baseboard (28 MB), Raspberry Pi Pico (open designs, KiCad 8 files), the other KiCad 5 and KiCad 9 demo boards and the MNT Reform 2 motherboard (KiCad 5, 7 and 8 files); synthetic fixtures: KiCad 4 and 6 styles',
    rewrites: [
      { from: 'KiCad 8 property styles; no real KiCad file was tested.', to: 'KiCad 8 property styles. Real KiCad 5 (module records), 7 (fp_text), 8 and 9 boards (file versions 20171130, 20221018, 20240108, 20241030 and 20241229) were validated as well; KiCad 4 files and the KiCad 6 file version remain synthetic-fixture only.' },
      { from: "(previous author's reading, synthetic fixtures only)", to: '(confirmed on real KiCad 8/9 boards, top and bottom parts: reading the angle as footprint-relative makes up to 501 neighbouring pad pairs overlap on a real board, this reading at most 7)' },
    ],
    extra: [
      'Real-file result: footprint, pad, net, side and pad-number counts and every pad position equal an independent reading of the same files; pad positions were also checked against the absolute track and via ends of the same net (bottom side and 0/45/90/180/225/270/315 degree parts included) and no pad is misplaced; outlines equal the Edge.Cuts extents (160.02 x 99.06 mm, 100.226 x 55 mm, 53.7 x 21 mm).',
      'Edge.Cuts end points closer than 0.01 mm are one corner (a real board has a 20 nm gap, which used to leave the contour open); larger gaps stay open and are disclosed. Tracks, vias, zones and text are checked for syntax but never built, so a 28 MB board of 3.6 million expressions opens in about 0.2 s (it used to be refused as too large).',
      'unconnected-(...) placeholder nets, including the "_1" suffixed name KiCad gives a second pad of the same number, are no-connects. Pads without a number (mounting holes, fiducials) are numbered "~1", "~2", ... so that none takes the number of a real pad of the same part.',
      'Copper layers are identified by the number and type in the (layers ...) table, not by name: KiCad 5 lets a design rename them (top_copper, Dessus, Top_layer, ...), and ten of the thirteen real KiCad 5 demo boards were refused as "unsupported layer" before. The front is layer 0, the back is layer 31 (KiCad up to 8) or 2 (KiCad 9); the names the design gave stay the labels and one import note lists them. A footprint on an inner layer is still refused.',
      'A real KiCad 9 demo board has 349 pad teardrop lists written with the opening parenthesis of "filter_ratio" missing, which made the document unbalanced and the board "malformed"; KiCad itself opens it. Inside a teardrops list, and only there, such an element is now read as KiCad reads it, and an import note counts them.',
      'Cross-check against the files kicad-cli 9.0.9 wrote from the same boards (38 boards of KiCad 5 to 9; the 68 MiB one only with the 64 MiB import limit lifted): all 26,220 pads are found in the IPC-D-356 export (26,136 test records and 84 tooling holes), at the same position (largest difference 3 µm, the rounding of the export), on the same side and net, and all 5,164 parts of the position export are found with the same position, side and rotation. The export shortens net names to 14 characters and numbers collisions; no net is merged or split.',
      'Not covered by real files: KiCad 4 and 6 files, footprints on inner copper layers (rejected by design), boards beyond the 64 MiB import limit (a real 68 MiB board is refused by the limit, not by the reader).',
    ],
  },
  listOrder: 110,
  family: 'ECAD design',
  detection: 'signature',
  sniff(input) {
    if (hasUtf16Mark(input.head)) return NO_MATCH;
    const verdict = ruleHolds(input, text => ROOT.test(text));
    if (verdict === 'all') {
      const text = headText(input).slice(0, 4096), version = /\(version\s+(\d{1,12})\)/.exec(text)?.[1], generator = /\(generator\s+"?([^\s")]{1,60})/.exec(text)?.[1];
      return sniffed(100, '(kicad_pcb root expression', { meta: { ...(version ? { fileVersion: Number(version) } : {}), ...(generator ? { generator } : {}) } });
    }
    if (verdict === 'some' || !isComplete(input) && ruleHolds(input, text => OPEN_PROLOGUE.test(text)) !== 'none') return sniffed(12, 'blank or comment prologue that may continue with (kicad_pcb');
    return NO_MATCH;
  },
  structure: kicadHook,
  parse: parseKicad,
});
