# What TRACE can open — exact support table

This file is generated from the format registry (one folder per reader under `src/lib/formats/adapters/`, see `docs/ADAPTERS.md`) and `SCHEMATIC_CAPABILITIES` (`src/lib/schematic/index.ts`) and checked by a test; do not edit it by hand.

**How to read the status.** *supported* = an adapter is registered and was validated against real files. *validated with real files* = the same standard for the sample families named in the Validated-with cell (the notes list what the real files did not cover). *validated with open tool-written files* = an adapter is registered and was validated against files that an open-source tool wrote from open designs (the Validated-with cell names the tool and the designs), but no file written by the vendor's own software has been tested. *draft (synthetic fixtures only)* = an adapter is registered and proven on original synthetic fixtures (units, sides, net identity, malformed input, resource limits) but **no real vendor file has been tested**. *recognized, not readable* = the bytes are identified and a precise explanation is shown, but nothing is imported. *extension only* = the file chooser accepts the extension, the content is reported as unrecognized. A file extension alone never selects a parser: formats are detected by their bytes. Every reader rates how certain it is about the first 64 KiB of a file; when the content fits more than one format with certainty, the file is not opened and both formats are named, so that no format is guessed.

No customer or manufacturer board is included in the repository or the application. FZ/CAE can open automatically with published format keys; other key variants and encrypted XZZ require a user-supplied key, kept for the session only and never saved. Every decrypted container must pass framing and checksum validation.

## Boardview and board formats

| Format | Extensions | Status | Validated with | Nets | Geometry | Needs |
| --- | --- | --- | --- | --- | --- | --- |
| GenCAD 1.4 | `.cad` `.gcd` | supported | real files | yes | mixed | — |
| Landrex / TestLink BRD | `.brd` | validated with selected real files | checked by the maintainer on real encoded exports; part, pin and outline counts checked against the decoded records | yes | estimated | — |
| TOPTEST BRD2 | `.brd` | draft (synthetic fixtures only) | synthetic fixtures | yes | estimated | — |
| Honhan BDV | `.bdv` | validated with selected real files | checked by the maintainer on real encoded exports; component, pin and nail counts cross-checked against the decoded records | yes | estimated | — |
| BVR raw boardview (BVRAW_FORMAT_3) | `.bvr` | validated with open tool-written files | open tool-written files: kicad-boardview exports of the five open Raspberry Pi Pico designs | yes | mixed | — |
| BVR raw boardview (BVRAW_FORMAT_1) | `.bvr` | draft (synthetic fixtures only) | synthetic fixtures | yes | estimated | — |
| ASC companion trio | `.asc` | draft (synthetic fixtures only) | synthetic fixtures | yes | estimated | companion files |
| FZ / CAE boardview | `.fz` `.cae` | supported | real files | yes | mixed | — |
| XZZ PCB | `.pcb` | draft (synthetic fixtures only) | synthetic fixtures | yes | mixed | — |
| CAST CST | `.cst` | draft (synthetic fixtures only) | synthetic fixtures | yes | estimated | — |
| KiCad PCB | `.kicad_pcb` | validated with real files | real files: KiCad 9 demo (pic_programmer), Antmicro Jetson Nano baseboard (28 MB), Raspberry Pi Pico (open designs, KiCad 8 files), the other KiCad 5 and KiCad 9 demo boards and the MNT Reform 2 motherboard (KiCad 5, 7 and 8 files); synthetic fixtures: KiCad 4 and 6 styles | yes | real | — |
| EAGLE board XML | `.brd` | validated with real files | real files: SparkFun RedBoard (EAGLE 7.7 XML board; 35 MB EAGLE 7.5 production panel); synthetic fixtures: 9.x documents, through-hole pads, rotated mirrored elements | yes | real | — |
| Altium PcbDoc | `.pcbdoc` `.cmpcbdoc` `.cspcbdoc` | supported | real files | yes | real | — |
| Samsung CAD | `.cad` | validated with a selected real file | checked by the maintainer on a real export; components, component pins and test vias counted independently | yes | estimated | — |
| Mentor Neutral | `.neu` | recognized, not readable | none | no | estimated | — |
| Cadence Allegro BRD (native) | `.brd` | recognized, not readable | none | no | estimated | — |
| TVW boardview | `.tvw` | validated with selected real files | checked by the maintainer on real exports: complete component tables and every pin UID link checked against the declared layer pads | yes | mixed | — |
| EasyEDA Standard PCB | `.json` | draft (synthetic fixtures only) | synthetic fixtures | yes | mixed | — |
| Gerber RS-274X | `.gbr` | recognized, not readable | none | no | real | — |
| EasyEDA Pro PCB | `.epro` `.epcb` `.zip` | supported | real files | yes | mixed | — |
| ODB++ archive | `.tgz` `.gz` `.tar` `.zip` `.z` | validated with open tool-written files | open tool-written files: kicad-cli 9.0.9 (pcb export odb) exports of thirty-nine open designs: KiCad 5 and 9 demo boards, Antmicro Jetson Nano baseboard, MNT Reform 2 motherboard, Raspberry Pi Pico boards | yes | mixed | — |
| HyperLynx (.hyp) | `.hyp` | draft (synthetic fixtures only) | synthetic fixtures | yes | mixed | — |
| Fabmaster (FATF) | `.fab` `.fatf` | draft (synthetic fixtures only) | synthetic fixtures | yes | mixed | — |
| IPC-D-356 | `.ipc` `.356` `.d356` `.ipc356` | validated with open tool-written files | open tool-written files: kicad-cli 9 exports of 39 open designs | yes | estimated | — |
| Pin list (CSV/TSV) | `.csv` `.tsv` `.txt` | draft (synthetic fixtures only) | synthetic fixtures | yes | estimated | — |
| IPC-2581 | `.xml` `.cvg` | validated with open tool-written files | open tool-written files: kicad-cli 9 exports of 27 open designs | yes | mixed | — |

### GenCAD 1.4

- **Variants:**
  - GENCAD 1.4 ($HEADER … $SIGNALS)
- **Units:** UNITS header: MM, INCH, THOU/MIL, USER (25.4 / divisor)
- **Sides:** LAYER TOP/BOTTOM; SHAPE MIRRORX/Y/XY and FLIP select padstack layers
- **Notes and limits:**
  - Exact ROUND/RECTANGLE pads keep their dimensions; other pad shapes are approximated by bounding rectangles.
  - Only the outer closed board contour is drawn; cutouts are disclosed as a warning.
  - Shape instancing is preflighted against an expanded-output budget (250,000 components, 1,000,000 pins, 8,000,000 placed outline, body and pad-corner points) before any pin is created; a file may hold up to 8,000,000 lines within the 64 MiB limit.

### Landrex / TestLink BRD

- **Variants:**
  - plain text (str_length/var_data)
  - rotated-byte encoded (signature 23 E2 63 28)
- **Units:** mil (×0.0254)
- **Sides:** part type 1 and 4–7 top, 2 and ≥8 bottom, 0 and 3 both; pins inherit the part; nails side 1 top, otherwise bottom
- **Notes and limits:**
  - Pads carry no physical size (radius 0); component bodies come from their pins; the outline comes from the Format record.
  - UNCONNECTED<n> vendor placeholders are no net.
  - Components without pins are omitted with a note (the format gives them no position). A header count that disagrees with the rows is rejected as malformed, where OpenBoardView only logs it and continues.
  - Four-count and six-field var_data headers are accepted; the extra signed fields are not guessed coordinate offsets. Nail nets may be omitted.
  - Pad dimensions remain estimated; other TestLink dialects are not established by these samples. No sample is distributed.

### TOPTEST BRD2

- **Variants:**
  - BRDOUT/NETS/PARTS/PINS/NAILS
- **Units:** mil (×0.0254)
- **Sides:** side codes 1 top, 2 bottom, 0 both; bottom Y is boardHeight − rawY; a part with no pin on its own side becomes both; nails side 1 top, otherwise bottom
- **Notes and limits:**
  - Pads carry no physical size (radius 0); part body rectangles and the outline come from the file.
  - A truncated BRDOUT file is reported as a malformed BRD2, not as unrecognized.
  - A component without pins keeps its declared side and body rectangle (OpenBoardView turns it into a through-hole part on both sides); header counts that disagree with the rows are rejected.
  - Remaining gap to supported: no real BRD2 file was available.

### Honhan BDV

- **Variants:**
  - plain <<format.asc>>/<<pins.asc>>/<<nails.asc>> sections
  - encoded (keyless per-line cipher; line 1 reads dd:1.3?,r?-=bb)
- **Units:** inch (×25.4)
- **Sides:** the side field of the "Part <ref> <side>" line: exactly (T) is top, everything else bottom; pins inherit it; nails carry their own side field
- **Notes and limits:**
  - Section column headings and compact metadata headers are accepted. Outline rows may include a radius; nonzero-radius segments are shown straight with a notice.
  - Pads carry no physical size; test points become one-pin TP:<probe> components. Probe IDs can be omitted, comma-separated or continued on the next row; net names can contain spaces; a test point row names its net with one word, or with the whole name when a pin already carries it.
  - This evidence covers the checked exports only; it does not prove every BDV dialect or physical pad dimensions. No sample is distributed.

### BVR raw boardview (BVRAW_FORMAT_3)

- **Variants:**
  - BVRAW_FORMAT_3 (PART_/PIN_ records with radii), as written by kicad-boardview
- **Units:** mil (×0.0254)
- **Sides:** PART_SIDE/PIN_SIDE T/B/O (absent = both, disclosed); coordinates are the same for both sides (no mirroring)
- **Notes and limits:**
  - Validated with open tool-written files: the five Raspberry Pi Pico boardviews (open design) exported by the open-source kicad-boardview plugin. All five open; three were cross-checked against their .kicad_pcb: components, pin counts per component, net names, sides and pin positions agree to the file's 1 mil resolution; the exporter leaves out non-copper and overlapping same-numbered pads.
  - PIN_NUMBER, PIN_NAME and PIN_NET may be empty (fiducials, unconnected pads); a net name may contain blanks. PIN_RADIUS is half the pad's larger dimension in mil in these exports.
  - No vendor-written BVR3 file was tested; the .obdata metadata sidecars (package, value and status per reference) are not read.
  - Other BVRAW_FORMAT_<n> versions are recognized and rejected as unsupported variants.
  - .bv Microsoft Access databases are not readable; export them to BVR first.

### BVR raw boardview (BVRAW_FORMAT_1)

- **Variants:**
  - BVRAW_FORMAT_1 (<<Layout>>/<<Pin>>/<<Nail>>)
- **Units:** inch (×25.4)
- **Sides:** per-line (T) top, otherwise bottom
- **Notes and limits:**
  - The one-line section headers follow the OpenBoardView reference reader; no real BVRAW_FORMAT_1 file was available, so this dialect is proven on synthetic fixtures only.
  - Pads carry no physical size; components without pins are omitted with a note.

### ASC companion trio

- **Variants:**
  - format.asc + pins.asc + nails.asc in one directory
- **Units:** inch (×25.4)
- **Sides:** the side field of the "Part <ref> <side>" line: exactly (T) is top, everything else bottom; pins inherit it; nails carry their own side field
- **Notes and limits:**
  - All three files are required; the result and the notes identity are identical whichever of the three is opened (complete-file-set key).
  - Companions are matched case-insensitively in the selected file's directory only; missing files are named in the error.
  - Pads carry no physical size.
  - Remaining gap to supported: no real ASC export was available. OpenBoardView also loads the trio when parts.asc, nets.asc or a .bom file is chosen; here only format.asc, pins.asc and nails.asc open it.

### FZ / CAE boardview

- **Variants:**
  - ASUS FZ (RC6 feedback, published default key)
  - ASRock CAE (RC6 feedback, published default key)
  - unencrypted zlib container (length- or footer-framed)
  - decoded A!/S! text
- **Units:** mil (×0.0254); UNIT:millimeters ×1; any other UNIT value is read as thou with a disclosed note
- **Sides:** REFDES mirror YES is bottom, otherwise top; test vias T is top, otherwise bottom
- **Notes and limits:**
  - ASUS FZ and ASRock CAE automatically try their respective published 44-word keys; an explicit user session key overrides the default. Other key variants can use the session key dialog. Plain zlib containers and decoded text need no key.
  - Recognized by extension plus structure (encrypted data has no magic). Fixed-offset zlib headers, complete framing, declared decompressed lengths where present and both checksums validate before import. CAE uses framing/checksum validation rather than ASUS parity restrictions.
  - The RADIUS column is used as the pad radius when present (unverified); graphics blocks are ignored and no outline is read. Component bodies are estimated from pins.
  - Automatic import was checked by the maintainer on real encrypted FZ and CAE exports. No vendor file is redistributed; exact geometry has not been compared with a reference viewer.
  - A REFDES without pins is omitted with a note; a repeated REFDES is rejected, where OpenBoardView lets the later one take over the name.

### XZZ PCB

- **Variants:**
  - plain XZZPCB header
  - XOR-obfuscated header (marker v6v6555v6v6)
  - DES-ECB encrypted part/pin records (16 hex-digit key)
- **Units:** raw ÷ 10000 mil, then ×0.0254
- **Sides:** component side is not decoded: every part is placed on top and this is disclosed
- **Notes and limits:**
  - The DES key is only needed for encrypted records (kept for the session only).
  - Pin and test-pad positions are real; pad sizes are unknown (estimated). The outline comes from layer 28 (arcs as nine chords); cutouts and open chains are disclosed.
  - Vias and text blocks are skipped; unknown block types are disclosed.
  - A component block without pins is omitted with a note; an unknown component sub-record type is rejected, where OpenBoardView skips byte by byte.
  - Remaining gap to supported: no real XZZ file was available.

### CAST CST

- **Variants:**
  - LE int16 binary, CDev/CPad sections
- **Units:** mil (×0.0254)
- **Sides:** layer 0x0C top, 0x01 bottom; every other layer code is rejected; a negative part id creates one ICT part on both sides
- **Notes and limits:**
  - Pin positions are real; pad size, body and outline are absent (a missing-outline warning is shown).
  - Pin numbers are file-order ordinals, not physical pin names; components with no pins are omitted with a note.
  - An unknown layer code is rejected on purpose (OpenBoardView places such a component on both sides; finding B04).
  - Remaining gap to supported: no real CAST file was available.

### KiCad PCB

- **Variants:**
  - S-expression kicad_pcb (versions 4–9: footprint and legacy module records)
- **Units:** mm
- **Sides:** front copper layer top (F.Cu, or the name the design gives layer 0), back copper layer bottom (B.Cu, or the name the design gives layer 31; layer 2 from KiCad 9) (file geometry already mirrored); *.Cu pads both
- **Notes and limits:**
  - Fixtures cover KiCad 4/5 legacy module records, KiCad 6 footprint+fp_text and KiCad 8 property styles. Real KiCad 5 (module records), 7 (fp_text), 8 and 9 boards (file versions 20171130, 20221018, 20240108, 20241030 and 20241229) were validated as well; KiCad 4 files and the KiCad 6 file version remain synthetic-fixture only. KiCad 3 and older are unsupported; tracks, zones and vias are ignored (nets come from pads only).
  - Pad angles are board-absolute (confirmed on real KiCad 8/9 boards, top and bottom parts: reading the angle as footprint-relative makes up to 501 neighbouring pad pairs overlap on a real board, this reading at most 7); footprint rotation only places local pad positions. Rect and equal-size circle pads are exact; oval, roundrect, trapezoid, custom and non-square circle pads are drawn as bounding rectangles and counted as approximated.
  - Edge.Cuts (line, rect, poly, circle, arc, curve): the largest closed loop is the outline; inner loops and footprint-level Edge.Cuts are disclosed as cutouts but not drawn; open chains are never closed.
  - Contradictory net ids/names are rejected. A user net literally named UNCONNECTED keeps its identity; only KiCad single-pad unconnected-(…) placeholders are treated as no-connects.
  - Real-file result: footprint, pad, net, side and pad-number counts and every pad position equal an independent reading of the same files; pad positions were also checked against the absolute track and via ends of the same net (bottom side and 0/45/90/180/225/270/315 degree parts included) and no pad is misplaced; outlines equal the Edge.Cuts extents (160.02 x 99.06 mm, 100.226 x 55 mm, 53.7 x 21 mm).
  - Edge.Cuts end points closer than 0.01 mm are one corner (a real board has a 20 nm gap, which used to leave the contour open); larger gaps stay open and are disclosed. Tracks, vias, zones and text are checked for syntax but never built, so a 28 MB board of 3.6 million expressions opens in about 0.2 s (it used to be refused as too large).
  - unconnected-(...) placeholder nets, including the "_1" suffixed name KiCad gives a second pad of the same number, are no-connects. Pads without a number (mounting holes, fiducials) are numbered "~1", "~2", ... so that none takes the number of a real pad of the same part.
  - Copper layers are identified by the number and type in the (layers ...) table, not by name: KiCad 5 lets a design rename them (top_copper, Dessus, Top_layer, ...), and ten of the thirteen real KiCad 5 demo boards were refused as "unsupported layer" before. The front is layer 0, the back is layer 31 (KiCad up to 8) or 2 (KiCad 9); the names the design gave stay the labels and one import note lists them. A footprint on an inner layer is still refused.
  - A real KiCad 9 demo board has 349 pad teardrop lists written with the opening parenthesis of "filter_ratio" missing, which made the document unbalanced and the board "malformed"; KiCad itself opens it. Inside a teardrops list, and only there, such an element is now read as KiCad reads it, and an import note counts them.
  - Cross-check against the files kicad-cli 9.0.9 wrote from the same boards (38 boards of KiCad 5 to 9; the 68 MiB one only with the 64 MiB import limit lifted): all 26,220 pads are found in the IPC-D-356 export (26,136 test records and 84 tooling holes), at the same position (largest difference 3 µm, the rounding of the export), on the same side and net, and all 5,164 parts of the position export are found with the same position, side and rotation. The export shortens net names to 14 characters and numbers collisions; no net is merged or split.
  - Not covered by real files: KiCad 4 and 6 files, footprints on inner copper layers (rejected by design), boards beyond the 64 MiB import limit (a real 68 MiB board is refused by the limit, not by the reader).

### EAGLE board XML

- **Variants:**
  - <eagle> board XML with <elements>, <libraries>, <signals> (declaration optional)
- **Units:** mm
- **Sides:** element rot M prefix mirrors to bottom; R angle rotates
- **Notes and limits:**
  - Original adapter from Autodesk ULP object documentation; no EAGLE code is used; fixtures are synthetic 9.6-style documents, and the real SparkFun RedBoard board and its 35 MB panel (EAGLE 7.7 and 7.5 XML) were validated as well.
  - XML entities are never expanded (DOCTYPE ENTITY is rejected); EAGLE schematics (<schematic> root) are not boards and EAGLE libraries are rejected as the wrong kind.
  - Exact pads: SMD rectangle/square/fully round square and round or square through-hole pads; partially rounded, capsule (roundness 100 non-square), octagon, long and offset pads are drawn as bounding rectangles and counted as approximated. Only SMD layers 1 and 16 are supported.
  - Mirrored (bottom) elements were checked on real boards only without rotation (every signal wire that ends on a bottom pad lies on it); the order for an element that is mirrored AND rotated (x flips first, then counter-clockwise rotation) follows convention and is not independently verified. Outline arcs/circles are sampled as straight segments; inner loops are disclosed as cutouts; pad counts of referenced packages are preflighted against the 1,000,000-pin limit before any pin is created.
  - Real-file result: element, pad, signal and contact counts and net names equal an independent reading of the files; signal wires and vias of the same signal end on their pads (2,576 checkable pads on the panel, rotations 0/90/180/270, bottom side included); the RedBoard outline is exactly 68.58 x 53.34 mm.
  - No real file has a through-hole <pad> or a mirrored element with a rotation, so those paths stay synthetic-fixture only.
  - Open gap, panels: a file with several boards keeps only the largest closed outline (the others are listed as cutouts) and the view bounds cover that one board, not the whole panel (963 of the 1,027 parts of the real 35 MB panel lie outside the kept bounds).
  - A 35 MB panel of 1,027 parts opens in about 2.2 s (peak about 540 MB).

### Altium PcbDoc

- **Variants:**
  - binary OLE compound (CFB version 3) record streams
  - ASCII |RECORD=Board|KIND=Protel_Advanced_PCB lines (keys checked against binary twins)
- **Units:** binary int32 1/10000 mil; text values need a mil/mm/in suffix
- **Sides:** pad layer 1 top, 32 bottom, 74 both; inner and non-copper pads are skipped and counted; components on MIDn are skipped and counted
- **Notes and limits:**
  - Only components, nets, pads and the first Board6 outline record are read; tracks, vias, arcs, fills, regions, text, models and rules are not, and every import says so.
  - Layouts follow public documentation (KiCad developer docs, Altium API reference, [MS-CFB]); component bodies come from pad extents and values are not read.
  - Round unequal / octagonal / rounded-rectangle pads are drawn as rectangles and counted as approximated; outline arcs are drawn as chords.
  - Validated on 28 openly licensed boards (26 binary, 2 ASCII). Independent raw-stream component, pad and net counts agree for all binary boards; two ASCII/binary twins agree on every pad to 1 micrometre. Altium-written P-CAD netlists agree on all 3,151 and 3,146 connected pads of the two designs; only the two inner-layer net-tie pads are omitted. Free pads and copper are not drawn. Hole-only pads use hole diameter, not copper land size. Compound-file version 4 is unsupported; SchLib/PcbLib are named and rejected. Other writers and versions remain unverified.

### Samsung CAD

- **Variants:**
  - ###Panel Added with COMP / C_PIN / N_VIA records
- **Units:** inch (×25.4), as OpenBoardView reads it; physical scale is not independently measured
- **Sides:** COMP side field: 1 top, any other value bottom; pins inherit the component; N_VIA supplies its own side
- **Notes and limits:**
  - The layout follows the OpenBoardView reference reader (the only public description found); both the "###Panel Added" and "C_PIN" markers must be present, which also keeps GenCAD .cad files apart.
  - Pads carry no physical size and components no body or outline: positions come from the C_PIN records and test vias; the outline is inferred from those positions.
  - The pin number is the text after the dash in the REF-PIN field (upstream discards it); a leading "/" of a net name is removed; N_VIA records become generated test-point components on their stated net and side.
  - All counted pins and test vias are imported. The checked file validates record handling, not physical unit scale or every Samsung CAD dialect. No sample is distributed.

### Mentor Neutral

- **Variants:**
  - Mentor Graphics neutral file (# file / # date header)
- **Units:** unverified
- **Sides:** unverified
- **Notes and limits:**
  - Recognized by a header taken from a single vendor help example; no adapter or fixture.

### Cadence Allegro BRD (native)

- **Variants:**
  - binary database; documented magic 0x00130000–0x00150000 (16.0–18.0+) plus "all" at offset 0xF8
- **Units:** n/a
- **Sides:** n/a
- **Notes and limits:**
  - Native Allegro databases are proprietary; export GenCAD or use the vendor viewer.
  - Databases older than 16.0 are not recognized.

### TVW boardview

- **Variants:**
  - compact component metadata
  - component metadata with height word
  - two extra Pascal metadata fields
  - physical-pad UID references
  - pin-list layer reference through the full layer-header list (any number of aux, silk, mask and inner headers)
  - net table closing word 0x2e23 or 0x2e17, with or without the usual 69-byte prefix
- **Units:** centimil (×0.000254 mm); disk Y/X coordinates are swapped
- **Sides:** the pin list names its layer by the zero-based index into the full list of layer headers and the header type decides the side (1 TOP, 2 BOTTOM); layers of other kinds are counted but never read; the numbers 2 (TOP), 5 and 7 (BOTTOM) also work when the detected header list does not name them
- **Notes and limits:**
  - Original reader based on the MIT teboviewformat record description and independent byte inspection; no external TVW reader is included.
  - Every declared component is read sequentially. Each pin UID divided by eight indexes its declared physical-pad table, preserving its label, coordinates, net, side and dimensions; no nearby-pad or master-order guess is used.
  - One-pin test-point records are imported with generated pin identity. An unsupported record, invalid pad index, malformed table or resource-limit breach is rejected instead of silently dropping pins.
  - Board edges and copper traces are not imported. Custom pad shapes are represented by their bounding boxes. Real-file evidence covers the tested export variants and does not certify every TVW dialect.
  - Still refused with a precise message: an export whose layer headers use a prefix other than the known one, an AppleDouble ("._") companion file, and a pin list that names an aux, silk, mask or inner layer or a layer number that no header provides.
  - All declared pins, including test points, are imported with exact source pad references. Symmetric bottom-footprint label swaps and reordered master pins are covered by regression tests. No sample is distributed.

### EasyEDA Standard PCB

- **Variants:**
  - shape-array PCB document (head docType 3, "shape" list of LIB/PAD/TRACK strings)
  - object-model PCB document (TRACK/PAD/FOOTPRINT keys), also inside a "dataStr" wrapper
- **Units:** 10 mil (0.254 mm)
- **Sides:** pad layer 1 top, 2 bottom, 11 both; a component is on the side of its SMD pads, otherwise of its silkscreen
- **Notes and limits:**
  - Fixtures are original synthetic documents modelled on the vendor examples; no real EasyEDA Standard file was available. The angle direction of a footprint or a round pad is not stated by the vendor (read as clockwise on the canvas, like the editor's SVG), so only rectangular pads that list their four corner points are exact.
  - Footprints (LIB) carry absolute canvas coordinates, so a bottom-side part is simply a part whose pads sit on layer 2; designator, package and value come from the P text and the footprint attributes.
  - Tracks, vias, copper areas, holes, text and images are not read (nets come from the pads); free pads with a net become one-pad parts; oval and polygon pads are drawn as bounding rectangles and counted as approximated.
  - Outline: layer 10 tracks, arcs, rectangles and circles stitched into the largest closed loop (arcs sampled as segments); inner loops are disclosed as cutouts. Schematic documents are not boards; a footprint document is rejected as the wrong kind.

### Gerber RS-274X

- **Variants:**
  - single-layer RS-274X graphics
- **Units:** MO IN/MM
- **Sides:** n/a
- **Notes and limits:**
  - A single Gerber layer has no components or nets; a geometry-only mode would be needed.

### EasyEDA Pro PCB

- **Variants:**
  - project archive (.epro, or the .zip backup the client writes: project.json + PCB/ + FOOTPRINT/, line-based JSON arrays, format 1.x)
  - bare PCB document (.epcb: components only, no pads)
- **Units:** mil (0.0254 mm); the vendor text says 0.01 inch, real files say mil
- **Sides:** COMPONENT layer TOP/BOTTOM (bottom parts are mirrored in x, unverified); pad layer MULTI is both
- **Notes and limits:**
  - Validated with real files: eight open-licence EasyEDA Pro projects (twelve .zip project backups plus the same projects exported from the offline .eprj databases); top-side pad positions agree with the routed tracks of the same nets.
  - No real bottom-side component was available and the vendor documents are silent on the bottom mirror: the mirror-then-rotate convention is unverified and every import with a bottom-side part says so.
  - Tracks, vias, copper pours and text are not read (nets come from the PAD_NET assignments); oval, polygon and n-gon pads are drawn as bounding rectangles and counted as approximated; footprint pad overrides are ignored and disclosed.
  - Outline: OUTLINE-layer lines, arcs, polylines and circles stitched into the largest closed loop (arcs and curves are sampled); inner loops are disclosed as cutouts. A bare .epcb has no footprints, so it shows part positions only.
  - The offline .eprj/.elib SQLite databases and the V3 log format are recognized and rejected with a hint (export an .epro); schematics and panels are not boards.

### ODB++ archive

- **Variants:**
  - product model in a gzip tar (.tgz, .tar.gz), a plain tar, a compress(1) tar (.tar.Z) or a ZIP; step, matrix, eda/data, component layers and profile of design format 7.x and 8.x
- **Units:** UNITS line of each file (MM or INCH), else misc/info, else INCH; converted to mm
- **Sides:** component layers comp_+_top / comp_+_bot (a mirrored component is seen from below); a pin sits on the side of the copper its subnet features touch
- **Notes and limits:**
  - Validated with open tool-written files: 39 ODB++ ZIP exports that kicad-cli 9.0.9 wrote from open designs. 27 were compared with the design itself (read from its .kicad_pcb), 11 KiCad 5 designs with the IPC-2581 export of the same design, and the largest one (1,495 components, 6,883 pads) by its component and pad counts. Against the 27: 3,203 components matched by reference with equal position, side, rotation and value (the others are 137 duplicate designators that the writer renames and 55 footprints without pads that it leaves out); 14,642 pins matched by reference, number and position within 10 µm and 109 more by position alone (the writer names unnumbered pads NPTH<n> or PAD<n>) with the same net, so no pin of a matched component is missing; the nets are the same 3,397 groups of pins, although the writer rewrites some names (blanks, overbars). No file written by an ODB++ vendor's own software has been tested.
  - Read: the board step (the step with the most components that does not repeat other steps; the others are listed in an import note and can be named in the import options; panel and array steps are not expanded), the layer matrix, units, component layers (reference, package, position, rotation, mirror, properties, part numbers), packages with pins and outlines, nets with toeprint subnets (or the CAD netlist when eda/data has none) and the board profile. Copper features, drills, fonts, solder mask and silkscreen are not read or drawn.
  - Pad shapes: rectangles, squares and circles keep their size; other contours are drawn as the smallest enclosing rectangle and counted in an import note. A component whose rotation and mirror do not reproduce its pin positions with the specification's placement is placed with the combination that does, and says so.
  - Limits: the archive must be at most 64 MiB (the import limit); inflation stops at 1 GiB per stream, 200,000 entries, 64 MiB per file and 192 MiB of kept files; only the files a board needs are kept and nothing is written to disk. Absolute, drive-letter and ".." paths and links are never used and are disclosed; ZIP members are checked against their CRC-32 and declared size. Encrypted ZIPs and compression methods other than stored and deflate are refused.
  - An extracted product-model folder is read through the library functions (a path-to-bytes file set); the file chooser opens archives only.

### HyperLynx (.hyp)

- **Variants:**
  - HyperLynx (.hyp) text records
- **Units:** ENGLISH inch; METRIC cm, converted to mm
- **Sides:** SMD pads follow the padstack outer layer; through-hole pads both
- **Notes and limits:**
  - No vendor-written file validated; KiCad writes HyperLynx only from its GUI. Padstack geometry, angles and outline are proven on synthetic fixtures only.

### Fabmaster (FATF)

- **Variants:**
  - Fabmaster (FATF) text records
- **Units:** J unit rows: mil, mm, micron, inch, cm
- **Sides:** SYM_MIRROR selects bottom; through-hole pads both
- **Notes and limits:**
  - No vendor-written file validated. Padstack offsets are ignored; pad rotations and first-copper sizes are unverified; custom pads use bounding rectangles.

### IPC-D-356

- **Variants:**
  - IPC-D-356 text records
- **Units:** CUST 0: 0.0001 inch; CUST 1 and SI supported synthetically
- **Sides:** Access codes select outer sides; bottom access can be overridden
- **Notes and limits:**
  - Electrical nets are exact; component bodies, outline and pad shapes are estimated. KiCad 9 exports: 39 files, 13,792 pads matched; only CUST 0 verified. Other writers and access conventions remain unverified.

### Pin list (CSV/TSV)

- **Variants:**
  - Pin list (CSV/TSV) text records
- **Units:** Detected or explicitly supplied unit and decimal separator
- **Sides:** Detected side words or explicit default and side mapping
- **Notes and limits:**
  - Synthetic fixtures only. Familiar headers are detected; unfamiliar or headerless lists need explicit column, unit, decimal and side mapping. A mapping-confirmation interface is not yet available. No physical component bodies or outline.

### IPC-2581

- **Variants:**
  - revision B/C XML; revision A read with B/C rules
- **Units:** CadHeader units converted to mm
- **Sides:** Conductor layer side and component Xform mirror
- **Notes and limits:**
  - KiCad 9 exports only: 27 boards; 3,395/3,395 components and identical nets. Other writers are unverified.
  - One selected step is shown; revision A uses B/C rules. Shapes and curves may be approximated; copper tracks, zones and vias are not rendered. XML entities are refused.

## Archives

A board may also be opened from an archive that holds it together with its companion files. The archive is unpacked in memory, inside the same sandboxed worker that reads boards; nothing is written to disk.

| Container | Extensions | Status | Validated with |
| --- | --- | --- | --- |
| ZIP archive (a board with its companion files) | `.zip` | draft (synthetic fixtures only) | synthetic fixtures |

### ZIP archive (a board with its companion files)

- **Variants:**
  - stored and deflated entries (methods 0 and 8), ZIP64 sizes; UTF-8 or code page 437 names
- **Notes and limits:**
  - The board is chosen by content: every entry with a board extension is sniffed, and the one board the archive holds is opened; companion files (the ASC trio) are taken from the same folder of the archive. An archive that holds several boards is refused with their names, so that no board is guessed.
  - Limits: 64 MiB for the archive and 64 MiB unpacked for the board plus its companions, 4,096 entries, at most 64 entries with a board extension, and an expansion of at most 250:1 for entries above 1 MiB; every entry must match its declared size and CRC-32. Archives inside the archive are not opened.
  - Encrypted entries, compression methods other than stored and deflate, and split archives are refused with a precise message. Names that would leave the archive folder (absolute paths, drive letters, "..") and operating-system metadata (__MACOSX, ._ files) are ignored. Nothing is written to disk.
  - Notes and the workspace belong to the archive file: the same board opened unpacked is a different file.
  - Proven on archives written by the fflate library and on hand-built damaged, encrypted, oversized and bomb archives; archives written by other tools follow the same specification.

## Structured schematics

Schematics are separate from boards: they keep their own symbols, pins, wires, labels and sheet hierarchy, and are linked to a board only through exact reference/pin keys and aliases the technician confirms. Connectivity follows the published rules: wires crossing without a junction are not connected, no-connect markers stay disconnected, local labels are sheet-scoped, global labels and power symbols are design-wide, hierarchical ports are scoped to their sheet instance, and bus entries never short bus members together.

| Format | Extensions | Connectivity | Validated with | Needs |
| --- | --- | --- | --- | --- |
| Altium schematic | `.schdoc` | computed from geometry | 113 openly licensed SchDocs; LimeSDR nets agree with the Altium-written netlist (627/627) | sibling .SchDoc and .PrjPcb files for hierarchy and project scope |
| KiCad schematic | `.kicad_sch` | computed from geometry | real files: KiCad 9 demo (2 sheets), Antmicro Jetson Nano baseboard (8 sheets), Raspberry Pi Pico (open designs, KiCad 8 files) | sub-sheet files in the same directory (otherwise the sheet is shown unresolved with a diagnostic) |
| KiCad legacy schematic | `.sch` | computed from geometry | synthetic fixtures only (no real legacy file was available) | <project>-cache.lib or other .lib files in the same directory for symbol pins and bodies; sub-sheet .sch files in the same directory |
| EAGLE schematic | `.sch` | declared by the file | real files: SparkFun RedBoard (EAGLE 7.7 XML) | — |

### Altium schematic

- **Variants:**
  - OLE compound FileHeader record stream
  - Ascii File schematic export
- **Units:** 10 mil converted to mm, Y down
- **Hierarchy:** Sibling SchDoc sheets and PrjPcb scope; hierarchy proven only synthetically; Repeat sheets shown once
- **Notes and limits:**
  - Harness, variants, off-sheet connectors and IEEE symbols are not modelled
  - Scope values 1 and 4 are unknown and disclosed
  - Binary-flagged and Additional records are skipped and disclosed
  - Real-file evidence covers flat designs; hierarchy, repeated sheets and scope 0 remain synthetic only.

### KiCad schematic

- **Variants:**
  - S-expression, (version) 20211123 (KiCad 6.0) through 20250114 (KiCad 9.0.x)
- **Units:** mm, Y down; every symbol resolved to absolute coordinates
- **Hierarchy:** Sheet symbols resolved from sibling .kicad_sch files of the same directory; repeated sub-sheets become separate instances (path = /sheetUuid/…) with per-instance references and units
- **Notes and limits:**
  - Versions outside the covered range are rejected, never guessed
  - Mirror-x combined with 90°/270° rotation is confirmed on real files (dozens of placements, no floating pin); mirror-y combined with 90°/270° and 180° combined with a mirror occur in no real file and are proven only by synthetic fixtures
  - Local power symbols (KiCad 9) get no global net; bus aliases are not expanded
  - Sub-sheet files in other directories are not loaded
  - Real-file result: each of 17 sheet files equals an independent reading of the file (symbols, pins, wires, junctions, no-connects, labels, sheet pins) and no pin is left floating; a sheet opens in 2-90 ms.
  - A power flag (PWR_FLAG: a power symbol whose only pin is a power output) names no net, a hidden power-input pin ties its global net on any symbol (including KiCad 4/5-style "#PWR" symbols without a (power) flag), "{slash}" and "/" are one name, and a name that carries a KiCad escape token such as {slash} is plain text, never bus syntax.

### KiCad legacy schematic

- **Variants:**
  - EESchema Schematic File Version 1–4 (text .sch)
- **Units:** mil in the file, converted to mm, Y down
- **Hierarchy:** Sheet files from the same directory; instance path = chain of $Sheet timestamps; alternate references (AR records) per instance
- **Notes and limits:**
  - A symbol whose library entry is missing keeps no pins and no body (diagnostic) — nothing is invented
  - The orientation-matrix reading of the two rotate+mirror matrices and the arc direction follow the published description and synthetic fixtures only
  - Versions above 4 are rejected
  - No real KiCad 5 (EESchema) schematic was available: this reader is proven by synthetic fixtures only. Its power-flag rule follows the KiCad schematic reader (a flag names no net).

### EAGLE schematic

- **Variants:**
  - EAGLE XML <schematic> (attribute-driven; fixtures cover 6.5–9.7)
- **Units:** mm in the file, Y flipped to Y down
- **Hierarchy:** Each <sheet> is a sibling sheet; EAGLE modules (hierarchical designs) are not supported and produce a warning
- **Notes and limits:**
  - Pin numbers are the BOARD pad names from the device connects; supply and package-less symbols are never cross-probed
  - Implicit power connections of unplaced gates are not modelled
  - Bus members are not expanded; connectivity comes only from declared nets
  - Real-file result: sheet, instance, net, pin-reference, wire, label and junction counts equal an independent reading of the file, and all 48 declared nets carry the names of the board. No real file has modules or buses.

## Documents in the workspace

| Kind | Extensions | What TRACE does | What it does not do |
| --- | --- | --- | --- |
| PDF | `.pdf` | Offline pdf.js viewer: multi-page, thumbnails, zoom/fit/rotate, page jump, selectable text, text search with next/previous, bookmarks, page notes; exact board references found in the text can be linked to board parts | A scanned or raster page has no text until you choose Recognize text: the built-in OCR (Tesseract, English, on this computer, nothing downloaded or uploaded) reads it, marks every recognized word with its confidence, makes it searchable and links only exact board names read with at least 60 % confidence; misread names are misses, never wrong links. A PDF is a document, never a boardview or a netlist. No document JavaScript, no XFA, no remote resources. |
| Images | `.png` `.jpg` `.jpeg` `.webp` `.svg` | Viewer with zoom, pan, rotation, bookmarks, point notes; physical measurement only after the user calibrates two points with a known distance | No board registration/overlay yet. SVG is sanitized and shown only as an inert image (no scripts, no remote assets; removals are disclosed). Raster images are limited to 80 megapixels. |
| Schematics | `.kicad_sch` `.sch` `.schdoc` (`.lib` and `.prjpcb` as companions) | See the schematic table above | See the schematic limits above |

Real-file validation of the documents: **PDF** — the pdf.js sample, the SparkFun RedBoard pin-diagram PDF and three KiCad-plotted Raspberry Pi Pico schematics (2 pages each, 63-97 bookmarks) were opened, text-indexed and searched through the application's own session code (pdf.js in Node, legacy worker build); every board reference and 50-61 net names of each plotted schematic were found as exact tokens. Page rendering was not exercised outside the renderer, and the RedBoard PDF is a pin diagram without component references. **Images** — a lossy WebP photograph, two PNG screenshots and an Inkscape SVG with an embedded JPEG: container sniffing, header dimensions (PNG sizes also against System.Drawing), the pixel budget and the SVG size and attribute policy were checked; decoding (ImageBitmap) and the DOM sanitizer need the renderer and were not exercised outside it.

Documents are identified by the SHA-256 of their original bytes. A workspace manifest (per board key) remembers absolute and board-relative paths, notes, bookmarks, annotations, calibration, split state and cameras; a moved file is found again by its relative path, a missing one offers **relink**, and a changed file is never adopted silently. Opening another board never attaches an old document. Project export bundles only the files the user explicitly ticks. The view of the board (zoom, centre, rotation and side) is remembered per board and restored; a stored view that does not show the board falls back to the automatic fit.

Cross-probe links are never guessed: references and nets match only by exact normalized names. Letter-case differences, duplicate references, repeated sheets and several nets carrying one name are listed as candidates for an explicit choice, and equivalences (schematic reference → board reference, schematic net → board net) exist only as aliases the technician confirms in the **Link and aliases** panel; they are saved with the workspace and can be removed.

Real-file check of the links, run in both directions on the SparkFun RedBoard (EAGLE board and schematic), the KiCad 9 demo, the Antmicro Jetson Nano baseboard and three Raspberry Pi Pico designs: every schematic reference that has a board part linked uniquely by its exact name and nets matched by exact names without any confirmed alias — including the sheet-qualified names KiCad writes into a board (`/sheet/NAME`, `{slash}` for `/`) and its KiCad 8/9 automatic names (`Net-(D1-K)`). What remained different was real: board-only pads (fiducials, shield and mounting pads), artwork footprints with no schematic part, and one no-connect pad on a duplicated pad number.

## Resource limits

- Board and schematic imports: 64 MiB per file (primary plus companions together); record, pin, instance and expansion budgets are enforced before output is created; coordinates beyond ±1e9 mm are rejected. Every board reader declares its budgets, and the import checks them before and after reading.
- Archives: 64 MiB per archive and 64 MiB unpacked for the board plus its companions, 4,096 entries, a bounded expansion ratio and a CRC-32 check per entry (see the archive notes above).
- Documents: 64 MiB per file; at most 16 files / 256 MiB per attach action; PDFs up to 2,000 pages and 500,000 indexed text items per session; PDF cross-reference bounded to 50,000 hits with disclosed truncation; images up to 80 megapixels.
- Native reads are exact-size and growth/shrink safe; writes are queued and atomic; a write submitted after quit began is rejected while every accepted write is drained.

## Not verified

- Real-file validation covers GenCAD 1.4, Landrex / TestLink BRD, Honhan BDV, FZ / CAE boardview, KiCad PCB, EAGLE board XML, Altium PcbDoc, Samsung CAD, TVW boardview and EasyEDA Pro PCB (validated with real files, see the table), BVR raw boardview (BVRAW_FORMAT_3), validated with kicad-boardview exports of the five open Raspberry Pi Pico designs (no vendor-written file was tested), ODB++ archive, validated with kicad-cli 9.0.9 (pcb export odb) exports of thirty-nine open designs: KiCad 5 and 9 demo boards, Antmicro Jetson Nano baseboard, MNT Reform 2 motherboard, Raspberry Pi Pico boards (no vendor-written file was tested), IPC-D-356, validated with kicad-cli 9 exports of 39 open designs (no vendor-written file was tested), IPC-2581, validated with kicad-cli 9 exports of 27 open designs (no vendor-written file was tested) and the Altium schematic, KiCad schematic and EAGLE schematic readers (real files, see above). TVW has record and geometry checks on selected real exports; export variants it does not know are refused with a precise message, and the remaining gaps are disclosed in the import notice. Other rows retain their individual synthetic or open-tool validation level. Selected exports do not establish complete vendor-format coverage; header variants, pad dimensions and transforms remain subject to the limits above.
- Transform conventions that the specifications leave open follow published conventions and are verified only against synthetic data, except where real files confirmed them (KiCad pad angles; KiCad schematic mirror-x with 90°/270° rotation; EAGLE mirror without rotation): KiCad schematic mirror-y with 90°/270° rotation, the EAGLE order for an element that is mirrored and rotated, and the legacy KiCad rotate+mirror matrices and arc direction.
- **Source-level Electron checks:** the main process, preload bridge, local import, persistence and renderer contracts are exercised by native and renderer tests. Production smoke checks use generated boards and an isolated profile. They cover the tested revision and environment; they do not certify every desktop configuration.
- **Packaged builds:** the release workflow builds the Windows portable EXE, the unsigned Apple-silicon macOS ZIP and the Linux packages from the release tag. Publishing requires platform build and smoke checks plus matching SHA-256 files. macOS and Linux packages remain experimental; download assets and workflow results are available in the GitHub release.
- **Linux builds (experimental):** a .deb and an AppImage for x86-64 are built and smoke-tested by GitHub Actions on Ubuntu 24.04 under a virtual X display: package contents, launch, board import, PDF and image attach, workspace save and restore, quit, single instance, window class and icon, the default data location and the Chromium sandbox state (on for the .deb with its AppArmor profile and for the AppImage where user namespaces are allowed; off, after consent, for the AppImage under Ubuntu's user-namespace restriction). No Linux build has been tried on a desktop Linux machine yet. Not tested: real desktop sessions (GNOME, KDE, Wayland), other distributions, arm64 and the native file chooser.

