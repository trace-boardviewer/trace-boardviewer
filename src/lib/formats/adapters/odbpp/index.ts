import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseOdbpp } from '../../odbpp';
import { sniffOdbppHead } from '../../odbpp-sniff';

export default defineBoardAdapter({
  capability: {
    id: 'odbpp', name: 'ODB++ archive', extensions: ['.tgz', '.gz', '.tar', '.zip', '.z'],
    variants: ['product model in a gzip tar (.tgz, .tar.gz), a plain tar, a compress(1) tar (.tar.Z) or a ZIP; step, matrix, eda/data, component layers and profile of design format 7.x and 8.x'],
    status: 'open-tool-validated', validation: 'open-tool-files',
    openTool: { tool: 'kicad-cli 9.0.9 (pcb export odb)', designs: 'thirty-nine open designs: KiCad 5 and 9 demo boards, Antmicro Jetson Nano baseboard, MNT Reform 2 motherboard, Raspberry Pi Pico boards' },
    electrical: 'nets', geometry: 'mixed',
    units: 'UNITS line of each file (MM or INCH), else misc/info, else INCH; converted to mm',
    sides: 'component layers comp_+_top / comp_+_bot (a mirrored component is seen from below); a pin sits on the side of the copper its subnet features touch',
    notes: [
      'Validated with open tool-written files: 39 ODB++ ZIP exports that kicad-cli 9.0.9 wrote from open designs. 27 were compared with the design itself (read from its .kicad_pcb), 11 KiCad 5 designs with the IPC-2581 export of the same design, and the largest one (1,495 components, 6,883 pads) by its component and pad counts. Against the 27: 3,203 components matched by reference with equal position, side, rotation and value (the others are 137 duplicate designators that the writer renames and 55 footprints without pads that it leaves out); 14,642 pins matched by reference, number and position within 10 µm and 109 more by position alone (the writer names unnumbered pads NPTH<n> or PAD<n>) with the same net, so no pin of a matched component is missing; the nets are the same 3,397 groups of pins, although the writer rewrites some names (blanks, overbars). No file written by an ODB++ vendor\'s own software has been tested.',
      'Read: the board step (the step with the most components that does not repeat other steps; the others are listed in an import note and can be named in the import options; panel and array steps are not expanded), the layer matrix, units, component layers (reference, package, position, rotation, mirror, properties, part numbers), packages with pins and outlines, nets with toeprint subnets (or the CAD netlist when eda/data has none) and the board profile. Copper features, drills, fonts, solder mask and silkscreen are not read or drawn.',
      'Pad shapes: rectangles, squares and circles keep their size; other contours are drawn as the smallest enclosing rectangle and counted in an import note. A component whose rotation and mirror do not reproduce its pin positions with the specification\'s placement is placed with the combination that does, and says so.',
      'Limits: the archive must be at most 64 MiB (the import limit); inflation stops at 1 GiB per stream, 200,000 entries, 64 MiB per file and 192 MiB of kept files; only the files a board needs are kept and nothing is written to disk. Absolute, drive-letter and ".." paths and links are never used and are disclosed; ZIP members are checked against their CRC-32 and declared size. Encrypted ZIPs and compression methods other than stored and deflate are refused.',
      'An extracted product-model folder is read through the library functions (a path-to-bytes file set); the file chooser opens archives only.',
    ],
  },
  listOrder: 190,
  family: 'ECAD design',
  detection: 'structure',
  // The entry names are the evidence: tar headers inside a bounded inflate of the head, or the ZIP local headers in the window. Names that
  // show the product model rank above the ZIP container (60), so that the reader receives the whole archive; a stream whose names lie
  // beyond the window stays possible and the parse decides.
  sniff({ head, size }) {
    const found = sniffOdbppHead(head, size);
    return found ? sniffed(found.confidence, found.reason, { variant: found.container, meta: { container: found.container } }) : NO_MATCH;
  },
  parse(input, context) {
    if (context.signal.aborted) throw context.signal.reason ?? new DOMException('Import cancelled.', 'AbortError');
    const step = input.options?.odbpp?.step;
    return parseOdbpp(input, step === undefined ? {} : { step });
  },
});
