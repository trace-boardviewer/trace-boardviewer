# What TRACE can open — exact support table

This file is generated from `FORMAT_CAPABILITIES` (`src/lib/formats/index.ts`) and `SCHEMATIC_CAPABILITIES` (`src/lib/schematic/index.ts`) and checked by a test; do not edit it by hand.

**How to read the status.** *supported* = an adapter is registered and was validated against real files. *validated with real files* = the same standard for the sample families named in the Validated-with cell (the notes list what the real files did not cover). *draft (synthetic fixtures only)* = an adapter is registered and proven on original synthetic fixtures (units, sides, net identity, malformed input, resource limits) but **no real vendor file has been tested**. *recognized, not readable* = the bytes are identified and a precise explanation is shown, but nothing is imported. *extension only* = the file chooser accepts the extension, the content is reported as unrecognized. A file extension alone never selects a parser: formats are detected by their bytes.

No customer or manufacturer board is included in the repository or the application. Encrypted formats need a key the user supplies (kept for the session only, never saved); no key ships with TRACE.

## Boardview and board formats

| Format | Extensions | Status | Validated with | Nets | Geometry | Needs |
| --- | --- | --- | --- | --- | --- | --- |
| GenCAD 1.4 | `.cad` `.gcd` | supported | real files | yes | mixed | — |
| Landrex / TestLink BRD | `.brd` | draft (synthetic fixtures only) | synthetic fixtures | yes | estimated | — |
| TOPTEST BRD2 | `.brd` | draft (synthetic fixtures only) | synthetic fixtures | yes | estimated | — |
| Honhan BDV | `.bdv` | draft (synthetic fixtures only) | synthetic fixtures | yes | estimated | — |
| BVR raw boardview (BVRAW_FORMAT_3) | `.bvr` | supported | real files | yes | mixed | — |
| BVR raw boardview (BVRAW_FORMAT_1) | `.bvr` | draft (synthetic fixtures only) | synthetic fixtures | yes | estimated | — |
| ASC companion trio | `.asc` | draft (synthetic fixtures only) | synthetic fixtures | yes | estimated | companion files |
| FZ / CAE encrypted boardview | `.fz` `.cae` | draft (synthetic fixtures only) | synthetic fixtures | yes | mixed | user-supplied key |
| XZZ PCB | `.pcb` | draft (synthetic fixtures only) | synthetic fixtures | yes | mixed | — |
| CAST CST | `.cst` | draft (synthetic fixtures only) | synthetic fixtures | yes | estimated | — |
| KiCad PCB | `.kicad_pcb` | validated with real files | real files: KiCad 9 demo (pic_programmer), Antmicro Jetson Nano baseboard (28 MB), Raspberry Pi Pico (open designs, KiCad 8 files); synthetic fixtures: KiCad 4-7 styles | yes | real | — |
| EAGLE board XML | `.brd` | validated with real files | real files: SparkFun RedBoard (EAGLE 7.7 XML board; 35 MB EAGLE 7.5 production panel); synthetic fixtures: 9.x documents, through-hole pads, rotated mirrored elements | yes | real | — |
| Altium PcbDoc | `.pcbdoc` `.cmpcbdoc` `.cspcbdoc` | draft (synthetic fixtures only) | synthetic fixtures | yes | real | — |
| Samsung CAD | `.cad` | draft (synthetic fixtures only) | synthetic fixtures | yes | estimated | — |
| Mentor Neutral | `.neu` | recognized, not readable | none | no | estimated | — |
| Cadence Allegro BRD (native) | `.brd` | recognized, not readable | none | no | estimated | — |
| TVW boardview | `.tvw` | extension only | none | no | estimated | — |
| Gerber RS-274X | `.gbr` | recognized, not readable | none | no | real | — |
| ODB++ archive | `.tgz` | recognized, not readable | none | no | real | — |
| IPC-2581 | `.xml` `.cvg` | recognized, not readable | none | no | real | — |

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
  - Remaining gap to supported: no real Landrex / TestLink file was available.

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
  - Header line counts (8/8/7) follow the OpenBoardView reference reader and are NOT verified against a vendor file.
  - Pads carry no physical size; test points become one-pin TP:<probe> components.
  - Remaining gap to supported: no real BDV file was available; a Part line must hold exactly a reference and a side marker.

### BVR raw boardview (BVRAW_FORMAT_3)

- **Variants:**
  - BVRAW_FORMAT_3 (PART_/PIN_ records with radii), as written by kicad-boardview
- **Units:** mil (×0.0254)
- **Sides:** PART_SIDE/PIN_SIDE T/B/O (absent = both, disclosed); coordinates are the same for both sides (no mirroring)
- **Notes and limits:**
  - Validated with real files: the five Raspberry Pi Pico boardviews (open design) exported by the open-source kicad-boardview plugin. All five open; three were cross-checked against their .kicad_pcb: components, pin counts per component, net names, sides and pin positions agree to the file's 1 mil resolution; the exporter leaves out non-copper and overlapping same-numbered pads.
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

### FZ / CAE encrypted boardview

- **Variants:**
  - ASUS FZ (RC6 feedback, 44-word key)
  - ASRock CAE (RC6 feedback, 44-word key)
  - unencrypted zlib container (four footer layouts)
- **Units:** mil (×0.0254); UNIT:millimeters ×1; any other UNIT value is read as thou with a disclosed note
- **Sides:** REFDES mirror YES is bottom, otherwise top; test vias T is top, otherwise bottom
- **Notes and limits:**
  - No key ships with the application; the user supplies the 44 unsigned 32-bit words (kept for the session only, never saved).
  - Recognized by extension plus structure (encrypted data has no magic): a random binary file named .fz asks for a key.
  - The RADIUS column is used as the pad radius when present (unverified); graphics blocks are ignored and no outline is read.
  - Proven only with synthetic keys and containers; no real vendor file was tested.
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
- **Sides:** F.Cu top, B.Cu bottom (file geometry already mirrored); *.Cu pads both
- **Notes and limits:**
  - Fixtures cover KiCad 4/5 legacy module records, KiCad 6 footprint+fp_text and KiCad 8 property styles. Real KiCad 8 and 9 boards (file versions 20240108 and 20241229) were validated as well; the KiCad 4/5 module and KiCad 6 fp_text styles remain synthetic-fixture only. KiCad 3 and older are unsupported; tracks, zones and vias are ignored (nets come from pads only).
  - Pad angles are board-absolute (confirmed on real KiCad 8/9 boards, top and bottom parts: reading the angle as footprint-relative makes up to 501 neighbouring pad pairs overlap on a real board, this reading at most 7); footprint rotation only places local pad positions. Rect and equal-size circle pads are exact; oval, roundrect, trapezoid, custom and non-square circle pads are drawn as bounding rectangles and counted as approximated.
  - Edge.Cuts (line, rect, poly, circle, arc, curve): the largest closed loop is the outline; inner loops and footprint-level Edge.Cuts are disclosed as cutouts but not drawn; open chains are never closed.
  - Contradictory net ids/names are rejected. A user net literally named UNCONNECTED keeps its identity; only KiCad single-pad unconnected-(…) placeholders are treated as no-connects.
  - Real-file result: footprint, pad, net, side and pad-number counts and every pad position equal an independent reading of the same files; pad positions were also checked against the absolute track and via ends of the same net (bottom side and 0/45/90/180/225/270/315 degree parts included) and no pad is misplaced; outlines equal the Edge.Cuts extents (160.02 x 99.06 mm, 100.226 x 55 mm, 53.7 x 21 mm).
  - Edge.Cuts end points closer than 0.01 mm are one corner (a real board has a 20 nm gap, which used to leave the contour open); larger gaps stay open and are disclosed. Tracks, vias, zones and text are checked for syntax but never built, so a 28 MB board of 3.6 million expressions opens in about 0.2 s (it used to be refused as too large).
  - unconnected-(...) placeholder nets, including the "_1" suffixed name KiCad gives a second pad of the same number, are no-connects. Pads without a number (mounting holes, fiducials) are numbered "~1", "~2", ... so that none takes the number of a real pad of the same part.
  - Not covered by real files: KiCad 4-7 boards, footprints on inner copper layers (rejected by design), custom-shaped pads.

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
  - ASCII |RECORD=Board|KIND=Protel_Advanced_PCB lines (draft: keys not publicly documented)
- **Units:** binary int32 1/10000 mil; text values need a mil/mm/in suffix
- **Sides:** pad layer 1 top, 32 bottom, 74 both (others rejected); component LAYER TOP/BOTTOM
- **Notes and limits:**
  - Only components, nets, pads and the first Board6 outline record are read; tracks, vias, arcs, fills, regions, text, models and rules are not, and every import says so.
  - Layouts follow public documentation (KiCad developer docs, Altium API reference, [MS-CFB]); component bodies come from pad extents and values are not read.
  - Round unequal / octagonal / rounded-rectangle pads are drawn as rectangles and counted as approximated; outline arcs are drawn as chords.
  - No real Altium file was tested; compound-file version 4 is rejected as an unsupported variant. SchDoc/SchLib/PcbLib are named and rejected.

### Samsung CAD

- **Variants:**
  - ###Panel Added with COMP / C_PIN / N_VIA records
- **Units:** inch (×25.4), as OpenBoardView reads it; not verified against a vendor file
- **Sides:** COMP side field: 1 top, any other value bottom; pins inherit the component
- **Notes and limits:**
  - The layout follows the OpenBoardView reference reader (the only public description found); both the "###Panel Added" and "C_PIN" markers must be present, which also keeps GenCAD .cad files apart.
  - Pads carry no physical size and components no body or outline: positions come from the C_PIN records only and the outline from the pins.
  - The pin number is the text after the dash in the REF-PIN field (upstream discards it); a leading "/" of a net name is removed; N_VIA test vias are counted and not shown.

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
  - observed binary container
- **Units:** n/a
- **Sides:** n/a
- **Notes and limits:**
  - The extension is accepted by the file chooser, but no public byte signature exists, so the content is reported as unrecognized.
  - The only public parser is LGPL and is not used.

### Gerber RS-274X

- **Variants:**
  - single-layer RS-274X graphics
- **Units:** MO IN/MM
- **Sides:** n/a
- **Notes and limits:**
  - A single Gerber layer has no components or nets; a geometry-only mode would be needed.

### ODB++ archive

- **Variants:**
  - gzip tar with odb/ matrix/steps hierarchy
- **Units:** INCH/MM per step
- **Sides:** n/a
- **Notes and limits:**
  - Recognized from tar headers only (bounded, nothing extracted); multi-file archive import is not implemented.

### IPC-2581

- **Variants:**
  - IPC-2581 revision B/C XML
- **Units:** per file
- **Sides:** n/a
- **Notes and limits:**
  - Recognized by the IPC-2581 root element only.

## Structured schematics

Schematics are separate from boards: they keep their own symbols, pins, wires, labels and sheet hierarchy, and are linked to a board only through exact reference/pin keys and aliases the technician confirms. Connectivity follows the published rules: wires crossing without a junction are not connected, no-connect markers stay disconnected, local labels are sheet-scoped, global labels and power symbols are design-wide, hierarchical ports are scoped to their sheet instance, and bus entries never short bus members together.

| Format | Extensions | Connectivity | Validated with | Needs |
| --- | --- | --- | --- | --- |
| KiCad schematic | `.kicad_sch` | computed from geometry | real files: KiCad 9 demo (2 sheets), Antmicro Jetson Nano baseboard (8 sheets), Raspberry Pi Pico (open designs, KiCad 8 files) | sub-sheet files in the same directory (otherwise the sheet is shown unresolved with a diagnostic) |
| KiCad legacy schematic | `.sch` | computed from geometry | synthetic fixtures only (no real legacy file was available) | <project>-cache.lib or other .lib files in the same directory for symbol pins and bodies; sub-sheet .sch files in the same directory |
| EAGLE schematic | `.sch` | declared by the file | real files: SparkFun RedBoard (EAGLE 7.7 XML) | — |

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

Altium schematics (`.SchDoc`) are not read: no public specification could be validated, so they are named and rejected. Nothing is invented from a rendered drawing.

## Documents in the workspace

| Kind | Extensions | What TRACE does | What it does not do |
| --- | --- | --- | --- |
| PDF | `.pdf` | Offline pdf.js viewer: multi-page, thumbnails, zoom/fit/rotate, page jump, selectable text, text search with next/previous, bookmarks, page notes; exact board references found in the text can be linked to board parts | No OCR: a scanned or raster PDF is shown and clearly marked as not searchable. A PDF is a document, never a boardview or a netlist. No document JavaScript, no XFA, no remote resources. |
| Images | `.png` `.jpg` `.jpeg` `.webp` `.svg` | Viewer with zoom, pan, rotation, bookmarks, point notes; physical measurement only after the user calibrates two points with a known distance | No board registration/overlay yet. SVG is sanitized and shown only as an inert image (no scripts, no remote assets; removals are disclosed). Raster images are limited to 80 megapixels. |
| Schematics | `.kicad_sch` `.sch` (`.lib` as a companion) | See the schematic table above | See the schematic limits above |

Real-file validation of the documents: **PDF** — the pdf.js sample, the SparkFun RedBoard pin-diagram PDF and three KiCad-plotted Raspberry Pi Pico schematics (2 pages each, 63-97 bookmarks) were opened, text-indexed and searched through the application's own session code (pdf.js in Node, legacy worker build); every board reference and 50-61 net names of each plotted schematic were found as exact tokens. Page rendering was not exercised outside the renderer, and the RedBoard PDF is a pin diagram without component references. **Images** — a lossy WebP photograph, two PNG screenshots and an Inkscape SVG with an embedded JPEG: container sniffing, header dimensions (PNG sizes also against System.Drawing), the pixel budget and the SVG size and attribute policy were checked; decoding (ImageBitmap) and the DOM sanitizer need the renderer and were not exercised outside it.

Documents are identified by the SHA-256 of their original bytes. A workspace manifest (per board key) remembers absolute and board-relative paths, notes, bookmarks, annotations, calibration, split state and cameras; a moved file is found again by its relative path, a missing one offers **relink**, and a changed file is never adopted silently. Opening another board never attaches an old document. Project export bundles only the files the user explicitly ticks. The view of the board (zoom, centre, rotation and side) is remembered per board and restored; a stored view that does not show the board falls back to the automatic fit.

Cross-probe links are never guessed: references and nets match only by exact normalized names. Letter-case differences, duplicate references, repeated sheets and several nets carrying one name are listed as candidates for an explicit choice, and equivalences (schematic reference → board reference, schematic net → board net) exist only as aliases the technician confirms in the **Link and aliases** panel; they are saved with the workspace and can be removed.

Real-file check of the links, run in both directions on the SparkFun RedBoard (EAGLE board and schematic), the KiCad 9 demo, the Antmicro Jetson Nano baseboard and three Raspberry Pi Pico designs: every schematic reference that has a board part linked uniquely by its exact name and nets matched by exact names without any confirmed alias — including the sheet-qualified names KiCad writes into a board (`/sheet/NAME`, `{slash}` for `/`) and its KiCad 8/9 automatic names (`Net-(D1-K)`). What remained different was real: board-only pads (fiducials, shield and mounting pads), artwork footprints with no schematic part, and one no-connect pad on a duplicated pad number.

## Resource limits

- Board and schematic imports: 64 MiB per file (primary plus companions together); record, pin, instance and expansion budgets are enforced before output is created; coordinates beyond ±1e9 mm are rejected.
- Documents: 64 MiB per file; at most 16 files / 256 MiB per attach action; PDFs up to 2,000 pages and 500,000 indexed text items per session; PDF cross-reference bounded to 50,000 hits with disclosed truncation; images up to 80 megapixels.
- Native reads are exact-size and growth/shrink safe; writes are queued and atomic; a write submitted after quit began is rejected while every accepted write is drained.

## Not verified

- Every adapter except GenCAD, KiCad PCB and EAGLE board XML (validated with real KiCad 8/9 and SparkFun RedBoard files, see the table), the KiCad and EAGLE schematic readers (real files, see above) and BVRAW_FORMAT_3 (validated with the open Raspberry Pi Pico boardviews written by kicad-boardview; no vendor-written BVR3 file was tested) is proven only with original synthetic fixtures. Vendor-specific details (header line counts, pad radius units, key schedules, version differences) rest on public documentation and are listed per format above.
- Transform conventions that the specifications leave open follow published conventions and are verified only against synthetic data, except where real files confirmed them (KiCad pad angles; KiCad schematic mirror-x with 90°/270° rotation; EAGLE mirror without rotation): KiCad schematic mirror-y with 90°/270° rotation, the EAGLE order for an element that is mirrored and rotated, and the legacy KiCad rotate+mirror matrices and arc direction.
- **Source-level Electron proof:** the Electron main process, preload bridge and renderer are exercised from source by mocked-Electron native checks and by real-Electron checks (Electron 44 on Linux under a virtual display). On Windows 11 the TypeScript build, the production Vite build, the unit/native suites and the packaged builds below have been exercised.
- **Packaged builds:** Windows `win-unpacked` and portable EXE builds of this product tree were produced and exercised on real Windows 11 (payload identity, the import matrix, two-instance isolation, GPU-process restart, persistence across relaunch). That is validation evidence, not a release acceptance. macOS builds are experimental and unsigned.

