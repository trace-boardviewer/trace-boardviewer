import { FORMAT_CAPABILITIES } from './formats';
import type { FormatCapability } from './formats';
import { SCHEMATIC_CAPABILITIES } from './schematic';
import type { SchematicCapability } from './schematic';

/**
 * Renders docs/SUPPORT.md from the capability tables, so the public support statement can never drift from the code
 * (src/lib/support-table.test.ts fails when the committed file differs; `UPDATE_SUPPORT=1 npx vitest run src/lib/support-table.test.ts`
 * rewrites it). The static sections state what the viewers and the workspace do and do not do.
 */
const STATUS: Record<FormatCapability['status'], string> = {
  supported: 'supported',
  draft: 'draft (synthetic fixtures only)',
  'recognized-unsupported': 'recognized, not readable',
  'extension-only': 'extension only',
};
const VALIDATION: Record<FormatCapability['validation'], string> = {
  'real-files': 'real files',
  'synthetic-fixtures': 'synthetic fixtures',
  none: 'none',
};
/**
 * Real-file evidence, kept next to the generator so that a claim and its limits are one reviewed place (the rows of FORMAT_CAPABILITIES /
 * SCHEMATIC_CAPABILITIES live in other files; this table overlays them without touching those files, and support-table.test.ts fails if an
 * overlay no longer matches its row).
 * `status`/`validatedWith` replace the table cells, `rewrites` replace a substring of exactly one stale note (`from` must occur once), `extra` is appended.
 */
export interface RealFileEvidence { status: string; validatedWith: string; rewrites: ReadonlyArray<{ from: string; to: string }>; extra: readonly string[] }
export const BOARD_EVIDENCE: Readonly<Record<string, RealFileEvidence>> = {
  kicad: {
    status: 'validated with real files',
    validatedWith: 'real files: KiCad 9 demo (pic_programmer), Antmicro Jetson Nano baseboard (28 MB), Raspberry Pi Pico (open designs, KiCad 8 files); synthetic fixtures: KiCad 4-7 styles',
    rewrites: [
      { from: 'KiCad 8 property styles; no real KiCad file was tested.', to: 'KiCad 8 property styles. Real KiCad 8 and 9 boards (file versions 20240108 and 20241229) were validated as well; the KiCad 4/5 module and KiCad 6 fp_text styles remain synthetic-fixture only.' },
      { from: "(previous author's reading, synthetic fixtures only)", to: '(confirmed on real KiCad 8/9 boards, top and bottom parts: reading the angle as footprint-relative makes up to 501 neighbouring pad pairs overlap on a real board, this reading at most 7)' },
    ],
    extra: [
      'Real-file result: footprint, pad, net, side and pad-number counts and every pad position equal an independent reading of the same files; pad positions were also checked against the absolute track and via ends of the same net (bottom side and 0/45/90/180/225/270/315 degree parts included) and no pad is misplaced; outlines equal the Edge.Cuts extents (160.02 x 99.06 mm, 100.226 x 55 mm, 53.7 x 21 mm).',
      'Edge.Cuts end points closer than 0.01 mm are one corner (a real board has a 20 nm gap, which used to leave the contour open); larger gaps stay open and are disclosed. Tracks, vias, zones and text are checked for syntax but never built, so a 28 MB board of 3.6 million expressions opens in about 0.2 s (it used to be refused as too large).',
      'unconnected-(...) placeholder nets, including the "_1" suffixed name KiCad gives a second pad of the same number, are no-connects. Pads without a number (mounting holes, fiducials) are numbered "~1", "~2", ... so that none takes the number of a real pad of the same part.',
      'Not covered by real files: KiCad 4-7 boards, footprints on inner copper layers (rejected by design), custom-shaped pads.',
    ],
  },
  eagle: {
    status: 'validated with real files',
    validatedWith: 'real files: SparkFun RedBoard (EAGLE 7.7 XML board; 35 MB EAGLE 7.5 production panel); synthetic fixtures: 9.x documents, through-hole pads, rotated mirrored elements',
    rewrites: [
      { from: 'fixtures are synthetic 9.6-style documents.', to: 'fixtures are synthetic 9.6-style documents, and the real SparkFun RedBoard board and its 35 MB panel (EAGLE 7.7 and 7.5 XML) were validated as well.' },
      { from: 'The mirror order (x flips first, then counter-clockwise rotation) follows convention and is not independently verified.', to: 'Mirrored (bottom) elements were checked on real boards only without rotation (every signal wire that ends on a bottom pad lies on it); the order for an element that is mirrored AND rotated (x flips first, then counter-clockwise rotation) follows convention and is not independently verified.' },
    ],
    extra: [
      'Real-file result: element, pad, signal and contact counts and net names equal an independent reading of the files; signal wires and vias of the same signal end on their pads (2,576 checkable pads on the panel, rotations 0/90/180/270, bottom side included); the RedBoard outline is exactly 68.58 x 53.34 mm.',
      'No real file has a through-hole <pad> or a mirrored element with a rotation, so those paths stay synthetic-fixture only.',
      'Open gap, panels: a file with several boards keeps only the largest closed outline (the others are listed as cutouts) and the view bounds cover that one board, not the whole panel (963 of the 1,027 parts of the real 35 MB panel lie outside the kept bounds).',
      'A 35 MB panel of 1,027 parts opens in about 2.2 s (peak about 540 MB).',
    ],
  },
};
export const SCHEMATIC_EVIDENCE: Readonly<Record<SchematicCapability['id'], RealFileEvidence>> = {
  'kicad-sch': {
    status: 'validated with real files',
    validatedWith: 'real files: KiCad 9 demo (2 sheets), Antmicro Jetson Nano baseboard (8 sheets), Raspberry Pi Pico (open designs, KiCad 8 files)',
    rewrites: [
      { from: 'Mirror combined with 90°/270° rotation follows the published conventions and is proven only by synthetic fixtures', to: 'Mirror-x combined with 90°/270° rotation is confirmed on real files (dozens of placements, no floating pin); mirror-y combined with 90°/270° and 180° combined with a mirror occur in no real file and are proven only by synthetic fixtures' },
    ],
    extra: [
      'Real-file result: each of 17 sheet files equals an independent reading of the file (symbols, pins, wires, junctions, no-connects, labels, sheet pins) and no pin is left floating; a sheet opens in 2-90 ms.',
      'A power flag (PWR_FLAG: a power symbol whose only pin is a power output) names no net, a hidden power-input pin ties its global net on any symbol (including KiCad 4/5-style "#PWR" symbols without a (power) flag), "{slash}" and "/" are one name, and a name that carries a KiCad escape token such as {slash} is plain text, never bus syntax.',
    ],
  },
  'kicad-legacy-sch': {
    status: 'synthetic fixtures only',
    validatedWith: 'synthetic fixtures only (no real legacy file was available)',
    rewrites: [],
    extra: ['No real KiCad 5 (EESchema) schematic was available: this reader is proven by synthetic fixtures only. Its power-flag rule follows the KiCad schematic reader (a flag names no net).'],
  },
  'eagle-sch': {
    status: 'validated with real files',
    validatedWith: 'real files: SparkFun RedBoard (EAGLE 7.7 XML)',
    rewrites: [],
    extra: ['Real-file result: sheet, instance, net, pin-reference, wire, label and junction counts equal an independent reading of the file, and all 48 declared nets carry the names of the board. No real file has modules or buses.'],
  },
};
function notesOf(notes: readonly string[], evidence: RealFileEvidence | undefined): string[] {
  const out = [...notes];
  for (const { from, to } of evidence?.rewrites ?? []) {
    const index = out.findIndex(note => note.includes(from));
    if (index >= 0) out[index] = out[index].replace(from, () => to);
  }
  return [...out, ...evidence?.extra ?? []];
}

/**
 * One Markdown table cell. Backslashes are escaped first: otherwise a value that ends in a backslash would combine with the
 * backslash added in front of a pipe ("\\" + "\|") and turn that pipe back into a column separator.
 */
export const cell = (value: string) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const list = (items: readonly string[]) => items.map(item => `  - ${item}`).join('\n');

export function buildSupportMarkdown(): string {
  const out: string[] = [];
  out.push('# What TRACE can open — exact support table', '');
  out.push('This file is generated from `FORMAT_CAPABILITIES` (`src/lib/formats/index.ts`) and `SCHEMATIC_CAPABILITIES` (`src/lib/schematic/index.ts`) and checked by a test; do not edit it by hand.', '');
  out.push('**How to read the status.** *supported* = an adapter is registered and was validated against real files. *validated with real files* = the same standard for the sample families named in the Validated-with cell (the notes list what the real files did not cover). *draft (synthetic fixtures only)* = an adapter is registered and proven on original synthetic fixtures (units, sides, net identity, malformed input, resource limits) but **no real vendor file has been tested**. *recognized, not readable* = the bytes are identified and a precise explanation is shown, but nothing is imported. *extension only* = the file chooser accepts the extension, the content is reported as unrecognized. A file extension alone never selects a parser: formats are detected by their bytes.', '');
  out.push('No customer or manufacturer board is included in the repository or the application. Encrypted formats need a key the user supplies (kept for the session only, never saved); no key ships with TRACE.', '');

  out.push('## Boardview and board formats', '');
  out.push('| Format | Extensions | Status | Validated with | Nets | Geometry | Needs |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of FORMAT_CAPABILITIES) {
    out.push(`| ${cell(c.name)} | ${c.extensions.map(e => `\`${e}\``).join(' ')} | ${BOARD_EVIDENCE[c.id]?.status ?? STATUS[c.status]} | ${BOARD_EVIDENCE[c.id]?.validatedWith ?? VALIDATION[c.validation]} | ${c.electrical === 'nets' ? 'yes' : 'no'} | ${c.geometry} | ${(c.requires ?? []).map(r => (r === 'key' ? 'user-supplied key' : 'companion files')).join(', ') || '—'} |`);
  }
  out.push('');
  for (const c of FORMAT_CAPABILITIES) {
    out.push(`### ${c.name}`, '');
    out.push(`- **Variants:**`, list(c.variants));
    out.push(`- **Units:** ${c.units}`);
    out.push(`- **Sides:** ${c.sides}`);
    out.push(`- **Notes and limits:**`, list(notesOf(c.notes, BOARD_EVIDENCE[c.id])), '');
  }

  out.push('## Structured schematics', '');
  out.push('Schematics are separate from boards: they keep their own symbols, pins, wires, labels and sheet hierarchy, and are linked to a board only through exact reference/pin keys and aliases the technician confirms. Connectivity follows the published rules: wires crossing without a junction are not connected, no-connect markers stay disconnected, local labels are sheet-scoped, global labels and power symbols are design-wide, hierarchical ports are scoped to their sheet instance, and bus entries never short bus members together.', '');
  out.push('| Format | Extensions | Connectivity | Validated with | Needs |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const c of SCHEMATIC_CAPABILITIES) {
    out.push(`| ${c.name} | ${c.extensions.map(e => `\`${e}\``).join(' ')} | ${c.connectivity === 'computed-from-geometry' ? 'computed from geometry' : 'declared by the file'} | ${SCHEMATIC_EVIDENCE[c.id].validatedWith} | ${c.requires.length ? cell(c.requires.join('; ')) : '—'} |`);
  }
  out.push('');
  for (const c of SCHEMATIC_CAPABILITIES) {
    out.push(`### ${c.name}`, '');
    out.push(`- **Variants:**`, list(c.variants));
    out.push(`- **Units:** ${c.units}`);
    out.push(`- **Hierarchy:** ${c.hierarchy}`);
    out.push(`- **Notes and limits:**`, list(notesOf(c.limits, SCHEMATIC_EVIDENCE[c.id])), '');
  }
  out.push('Altium schematics (`.SchDoc`) are not read: no public specification could be validated, so they are named and rejected. Nothing is invented from a rendered drawing.', '');

  out.push('## Documents in the workspace', '');
  out.push('| Kind | Extensions | What TRACE does | What it does not do |');
  out.push('| --- | --- | --- | --- |');
  out.push('| PDF | `.pdf` | Offline pdf.js viewer: multi-page, thumbnails, zoom/fit/rotate, page jump, selectable text, text search with next/previous, bookmarks, page notes; exact board references found in the text can be linked to board parts | No OCR: a scanned or raster PDF is shown and clearly marked as not searchable. A PDF is a document, never a boardview or a netlist. No document JavaScript, no XFA, no remote resources. |');
  out.push('| Images | `.png` `.jpg` `.jpeg` `.webp` `.svg` | Viewer with zoom, pan, rotation, bookmarks, point notes; physical measurement only after the user calibrates two points with a known distance | No board registration/overlay yet. SVG is sanitized and shown only as an inert image (no scripts, no remote assets; removals are disclosed). Raster images are limited to 80 megapixels. |');
  out.push('| Schematics | `.kicad_sch` `.sch` (`.lib` as a companion) | See the schematic table above | See the schematic limits above |');
  out.push('');
  out.push('Real-file validation of the documents: **PDF** — the pdf.js sample, the SparkFun RedBoard pin-diagram PDF and three KiCad-plotted Raspberry Pi Pico schematics (2 pages each, 63-97 bookmarks) were opened, text-indexed and searched through the application\'s own session code (pdf.js in Node, legacy worker build); every board reference and 50-61 net names of each plotted schematic were found as exact tokens. Page rendering was not exercised outside the renderer, and the RedBoard PDF is a pin diagram without component references. **Images** — a lossy WebP photograph, two PNG screenshots and an Inkscape SVG with an embedded JPEG: container sniffing, header dimensions (PNG sizes also against System.Drawing), the pixel budget and the SVG size and attribute policy were checked; decoding (ImageBitmap) and the DOM sanitizer need the renderer and were not exercised outside it.', '');
  out.push('Documents are identified by the SHA-256 of their original bytes. A workspace manifest (per board key) remembers absolute and board-relative paths, notes, bookmarks, annotations, calibration, split state and cameras; a moved file is found again by its relative path, a missing one offers **relink**, and a changed file is never adopted silently. Opening another board never attaches an old document. Project export bundles only the files the user explicitly ticks. The view of the board (zoom, centre, rotation and side) is remembered per board and restored; a stored view that does not show the board falls back to the automatic fit.', '');
  out.push('Cross-probe links are never guessed: references and nets match only by exact normalized names. Letter-case differences, duplicate references, repeated sheets and several nets carrying one name are listed as candidates for an explicit choice, and equivalences (schematic reference → board reference, schematic net → board net) exist only as aliases the technician confirms in the **Link and aliases** panel; they are saved with the workspace and can be removed.', '');
  out.push('Real-file check of the links, run in both directions on the SparkFun RedBoard (EAGLE board and schematic), the KiCad 9 demo, the Antmicro Jetson Nano baseboard and three Raspberry Pi Pico designs: every schematic reference that has a board part linked uniquely by its exact name and nets matched by exact names without any confirmed alias — including the sheet-qualified names KiCad writes into a board (`/sheet/NAME`, `{slash}` for `/`) and its KiCad 8/9 automatic names (`Net-(D1-K)`). What remained different was real: board-only pads (fiducials, shield and mounting pads), artwork footprints with no schematic part, and one no-connect pad on a duplicated pad number.', '');

  out.push('## Resource limits', '');
  out.push('- Board and schematic imports: 64 MiB per file (primary plus companions together); record, pin, instance and expansion budgets are enforced before output is created; coordinates beyond ±1e9 mm are rejected.');
  out.push('- Documents: 64 MiB per file; at most 16 files / 256 MiB per attach action; PDFs up to 2,000 pages and 500,000 indexed text items per session; PDF cross-reference bounded to 50,000 hits with disclosed truncation; images up to 80 megapixels.');
  out.push('- Native reads are exact-size and growth/shrink safe; writes are queued and atomic; a write submitted after quit began is rejected while every accepted write is drained.', '');

  out.push('## Not verified', '');
  // The static sentence must name the second real-file-validated family (BVRAW_FORMAT_3, Raspberry Pi Pico exports); otherwise it contradicts the generated table.
  out.push('- Every adapter except GenCAD, KiCad PCB and EAGLE board XML (validated with real KiCad 8/9 and SparkFun RedBoard files, see the table), the KiCad and EAGLE schematic readers (real files, see above) and BVRAW_FORMAT_3 (validated with the open Raspberry Pi Pico boardviews written by kicad-boardview; no vendor-written BVR3 file was tested) is proven only with original synthetic fixtures. Vendor-specific details (header line counts, pad radius units, key schedules, version differences) rest on public documentation and are listed per format above.');
  out.push('- Transform conventions that the specifications leave open follow published conventions and are verified only against synthetic data, except where real files confirmed them (KiCad pad angles; KiCad schematic mirror-x with 90°/270° rotation; EAGLE mirror without rotation): KiCad schematic mirror-y with 90°/270° rotation, the EAGLE order for an element that is mirrored and rotated, and the legacy KiCad rotate+mirror matrices and arc direction.');
  out.push('- **Source-level Electron proof:** the Electron main process, preload bridge and renderer are exercised from source by mocked-Electron native checks and by real-Electron checks (Electron 44 on Linux under a virtual display). On Windows 11 the TypeScript build, the production Vite build, the unit/native suites and the packaged builds below have been exercised.');
  out.push('- **Packaged builds:** Windows `win-unpacked` and portable EXE builds of this product tree were produced and exercised on real Windows 11 (payload identity, the import matrix, two-instance isolation, GPU-process restart, persistence across relaunch). That is validation evidence, not a release acceptance. macOS builds are experimental and unsigned.', '');
  return `${out.join('\n')}\n`;
}
