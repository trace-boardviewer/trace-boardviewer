import { utf8, type AdapterFixture } from '../../fixture';

const KICAD = [
  '(kicad_pcb (version 20240108) (generator "synthetic") (net 0 "") (net 1 "GND")',
  ' (footprint "Test:Package" (layer "F.Cu") (at 10 20 90) (property "Reference" "U1") (property "Value" "v")',
  '  (fp_rect (start -3 -2) (end 3 2) (layer "F.Fab"))',
  '  (pad "1" smd rect (at 2 3 90) (size 2 1) (layers "F.Cu") (net 1 "GND")))',
  ' (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts")))',
].join('\n') + '\n';

/** KiCad 5 lets a design name its copper layers itself; the numbers and types in the layer table say which is which. */
const RENAMED_LAYERS = [
  '(kicad_pcb (version 20171130) (host pcbnew 5.1.10)',
  ' (layers (0 top_copper signal) (31 bottom_copper signal) (36 B.SilkS user) (37 F.SilkS user) (44 Edge.Cuts user))',
  ' (net 0 "") (net 1 GND)',
  ' (module Test:Package (layer top_copper) (at 10 20)',
  '  (fp_text reference U1 (at 0 0) (layer F.SilkS)) (fp_text value v (at 0 1) (layer F.Fab))',
  '  (pad 1 smd rect (at 2 3) (size 2 1) (layers top_copper F.Paste F.Mask) (net 1 GND)))',
  ' (module Test:Pin (layer bottom_copper) (at 30 10)',
  '  (fp_text reference J1 (at 0 0) (layer B.SilkS)) (fp_text value Pin (at 0 1) (layer B.Fab))',
  '  (pad 1 smd rect (at 0 0) (size 1 1) (layers bottom_copper B.Paste B.Mask) (net 1 GND)))',
  ' (gr_line (start 0 0) (end 40 0) (layer Edge.Cuts)) (gr_line (start 40 0) (end 40 30) (layer Edge.Cuts))',
  ' (gr_line (start 40 30) (end 0 30) (layer Edge.Cuts)) (gr_line (start 0 30) (end 0 0) (layer Edge.Cuts)))',
].join('\n') + '\n';

/** KiCad 9 writes some pad teardrop settings with the opening parenthesis of "filter_ratio" missing; KiCad reads them all the same. */
const TEARDROPS = [
  '(kicad_pcb (version 20241229) (generator "synthetic") (net 0 "") (net 1 "GND")',
  ' (footprint "Test:Package" (layer "F.Cu") (at 10 20 90) (property "Reference" "U1") (property "Value" "v")',
  '  (pad "1" smd rect (at 2 3 90) (size 2 1) (layers "F.Cu") (net 1 "GND")',
  '   (teardrops (best_length_ratio 0.5) (max_length 1) (best_width_ratio 1) (max_width 2) (curved_edges no)filter_ratio 0.9)',
  '   (enabled yes) (allow_two_segments yes) (prefer_zone_connections yes))',
  '   (uuid "00000000-0000-4000-8000-000000000001")))',
  ' (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts")))',
].join('\n') + '\n';

const fixtures: AdapterFixture[] = [
  { label: 'KiCad 8 board', name: 'board.kicad_pcb', data: utf8(KICAD) },
  { label: 'comment prologue', name: 'board.kicad_pcb', data: utf8(`; exported\n\n${KICAD}`) },
  { label: 'KiCad 5 board with renamed copper layers', name: 'board.kicad_pcb', data: utf8(RENAMED_LAYERS) },
  { label: 'KiCad 9 board with teardrop settings missing a parenthesis', name: 'board.kicad_pcb', data: utf8(TEARDROPS) },
];
export default fixtures;
