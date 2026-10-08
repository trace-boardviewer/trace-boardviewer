import { BOARD_EVIDENCE, CONTAINER_CAPABILITIES, FORMAT_CAPABILITIES } from './formats';
import type { FormatCapability, RealFileEvidence, SupportStatus, Validation } from './formats';
import { SCHEMATIC_CAPABILITIES } from './schematic';
import type { SchematicCapability } from './schematic';

export { BOARD_EVIDENCE } from './formats';
export type { RealFileEvidence } from './formats';

/**
 * Renders docs/SUPPORT.md from the format registry (src/lib/formats/registry.ts: capability records and real-file evidence
 * live in the adapter folders) and the schematic capability table, so the public support statement can never drift from
 * the code (src/lib/support-table.test.ts fails when the committed file differs; `UPDATE_SUPPORT=1 npx vitest run
 * src/lib/support-table.test.ts` rewrites it). The static sections state what the viewers and the workspace do and do not do.
 */
const STATUS: Record<SupportStatus, string> = {
  supported: 'supported',
  'open-tool-validated': 'validated with open tool-written files',
  draft: 'draft (synthetic fixtures only)',
  'recognized-unsupported': 'recognized, not readable',
  'extension-only': 'extension only',
};
const VALIDATION: Record<Validation, string> = {
  'real-files': 'real files',
  'open-tool-files': 'open tool-written files',
  'synthetic-fixtures': 'synthetic fixtures',
  none: 'none',
};
/** "kicad-boardview exports of the five open Raspberry Pi Pico designs". */
const openToolFiles = (c: FormatCapability): string => (c.openTool ? `${c.openTool.tool} exports of ${c.openTool.designs}` : VALIDATION['open-tool-files']);
const validatedWith = (c: FormatCapability): string => BOARD_EVIDENCE[c.id]?.validatedWith
  ?? (c.validation === 'open-tool-files' ? `${VALIDATION[c.validation]}: ${openToolFiles(c)}` : VALIDATION[c.validation]);
/** "a", "a and b", "a, b and c". */
const series = (items: readonly string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const statusOf = (c: FormatCapability): string => BOARD_EVIDENCE[c.id]?.status ?? STATUS[c.status];
/**
 * Real-file evidence for the schematic readers (the board evidence lives with its adapter). `status`/`validatedWith` replace
 * the table cells, `rewrites` replace a substring of exactly one stale note (`from` must occur once), `extra` is appended.
 */
export const SCHEMATIC_EVIDENCE: Readonly<Record<SchematicCapability['id'], RealFileEvidence>> = {
  'altium-sch': { status: 'validated with real files', validatedWith: '113 openly licensed SchDocs; LimeSDR nets agree with the Altium-written netlist (627/627)', rewrites: [], extra: ['Real-file evidence covers flat designs; hierarchy, repeated sheets and scope 0 remain synthetic only.'] },
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
  out.push('This file is generated from the format registry (one folder per reader under `src/lib/formats/adapters/`, see `docs/ADAPTERS.md`) and `SCHEMATIC_CAPABILITIES` (`src/lib/schematic/index.ts`) and checked by a test; do not edit it by hand.', '');
  out.push('**How to read the status.** *supported* = an adapter is registered and was validated against real files. *validated with real files* = the same standard for the sample families named in the Validated-with cell (the notes list what the real files did not cover). *validated with open tool-written files* = an adapter is registered and was validated against files that an open-source tool wrote from open designs (the Validated-with cell names the tool and the designs), but no file written by the vendor\'s own software has been tested. *draft (synthetic fixtures only)* = an adapter is registered and proven on original synthetic fixtures (units, sides, net identity, malformed input, resource limits) but **no real vendor file has been tested**. *recognized, not readable* = the bytes are identified and a precise explanation is shown, but nothing is imported. *extension only* = the file chooser accepts the extension, the content is reported as unrecognized. A file extension alone never selects a parser: formats are detected by their bytes. Every reader rates how certain it is about the first 64 KiB of a file; when the content fits more than one format with certainty, the file is not opened and both formats are named, so that no format is guessed.', '');
  out.push('No customer or manufacturer board is included in the repository or the application. FZ/CAE can open automatically with published format keys; other key variants and encrypted XZZ require a user-supplied key, kept for the session only and never saved. Every decrypted container must pass framing and checksum validation.', '');

  out.push('## Boardview and board formats', '');
  out.push('| Format | Extensions | Status | Validated with | Nets | Geometry | Needs |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of FORMAT_CAPABILITIES) {
    out.push(`| ${cell(c.name)} | ${c.extensions.map(e => `\`${e}\``).join(' ')} | ${statusOf(c)} | ${cell(validatedWith(c))} | ${c.electrical === 'nets' ? 'yes' : 'no'} | ${c.geometry} | ${(c.requires ?? []).map(r => (r === 'key' ? 'user-supplied key' : 'companion files')).join(', ') || '—'} |`);
  }
  out.push('');
  for (const c of FORMAT_CAPABILITIES) {
    out.push(`### ${c.name}`, '');
    out.push(`- **Variants:**`, list(c.variants));
    out.push(`- **Units:** ${c.units}`);
    out.push(`- **Sides:** ${c.sides}`);
    out.push(`- **Notes and limits:**`, list(notesOf(c.notes, BOARD_EVIDENCE[c.id])), '');
  }

  out.push('## Archives', '');
  out.push('A board may also be opened from an archive that holds it together with its companion files. The archive is unpacked in memory, inside the same sandboxed worker that reads boards; nothing is written to disk.', '');
  out.push('| Container | Extensions | Status | Validated with |');
  out.push('| --- | --- | --- | --- |');
  for (const c of CONTAINER_CAPABILITIES) out.push(`| ${cell(c.name)} | ${c.extensions.map(e => `\`${e}\``).join(' ')} | ${STATUS[c.status]} | ${VALIDATION[c.validation]} |`);
  out.push('');
  for (const c of CONTAINER_CAPABILITIES) {
    out.push(`### ${c.name}`, '');
    out.push(`- **Variants:**`, list(c.variants));
    out.push(`- **Notes and limits:**`, list(c.notes), '');
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


  out.push('## Documents in the workspace', '');
  out.push('| Kind | Extensions | What TRACE does | What it does not do |');
  out.push('| --- | --- | --- | --- |');
  out.push('| PDF | `.pdf` | Offline pdf.js viewer: multi-page, thumbnails, zoom/fit/rotate, page jump, selectable text, text search with next/previous, bookmarks, page notes; exact board references found in the text can be linked to board parts | A scanned or raster page has no text until you choose Recognize text: the built-in OCR (Tesseract, English, on this computer, nothing downloaded or uploaded) reads it, marks every recognized word with its confidence, makes it searchable and links only exact board names read with at least 60 % confidence; misread names are misses, never wrong links. A PDF is a document, never a boardview or a netlist. No document JavaScript, no XFA, no remote resources. |');
  out.push('| Images | `.png` `.jpg` `.jpeg` `.webp` `.svg` | Viewer with zoom, pan, rotation, bookmarks, point notes; physical measurement only after the user calibrates two points with a known distance | No board registration/overlay yet. SVG is sanitized and shown only as an inert image (no scripts, no remote assets; removals are disclosed). Raster images are limited to 80 megapixels. |');
  out.push('| Schematics | `.kicad_sch` `.sch` `.schdoc` (`.lib` and `.prjpcb` as companions) | See the schematic table above | See the schematic limits above |');
  out.push('');
  out.push('Real-file validation of the documents: **PDF** — the pdf.js sample, the SparkFun RedBoard pin-diagram PDF and three KiCad-plotted Raspberry Pi Pico schematics (2 pages each, 63-97 bookmarks) were opened, text-indexed and searched through the application\'s own session code (pdf.js in Node, legacy worker build); every board reference and 50-61 net names of each plotted schematic were found as exact tokens. Page rendering was not exercised outside the renderer, and the RedBoard PDF is a pin diagram without component references. **Images** — a lossy WebP photograph, two PNG screenshots and an Inkscape SVG with an embedded JPEG: container sniffing, header dimensions (PNG sizes also against System.Drawing), the pixel budget and the SVG size and attribute policy were checked; decoding (ImageBitmap) and the DOM sanitizer need the renderer and were not exercised outside it.', '');
  out.push('Documents are identified by the SHA-256 of their original bytes. A workspace manifest (per board key) remembers absolute and board-relative paths, notes, bookmarks, annotations, calibration, split state and cameras; a moved file is found again by its relative path, a missing one offers **relink**, and a changed file is never adopted silently. Opening another board never attaches an old document. Project export bundles only the files the user explicitly ticks. The view of the board (zoom, centre, rotation and side) is remembered per board and restored; a stored view that does not show the board falls back to the automatic fit.', '');
  out.push('Cross-probe links are never guessed: references and nets match only by exact normalized names. Letter-case differences, duplicate references, repeated sheets and several nets carrying one name are listed as candidates for an explicit choice, and equivalences (schematic reference → board reference, schematic net → board net) exist only as aliases the technician confirms in the **Link and aliases** panel; they are saved with the workspace and can be removed.', '');
  out.push('Real-file check of the links, run in both directions on the SparkFun RedBoard (EAGLE board and schematic), the KiCad 9 demo, the Antmicro Jetson Nano baseboard and three Raspberry Pi Pico designs: every schematic reference that has a board part linked uniquely by its exact name and nets matched by exact names without any confirmed alias — including the sheet-qualified names KiCad writes into a board (`/sheet/NAME`, `{slash}` for `/`) and its KiCad 8/9 automatic names (`Net-(D1-K)`). What remained different was real: board-only pads (fiducials, shield and mounting pads), artwork footprints with no schematic part, and one no-connect pad on a duplicated pad number.', '');

  out.push('## Resource limits', '');
  out.push('- Board and schematic imports: 64 MiB per file (primary plus companions together); record, pin, instance and expansion budgets are enforced before output is created; coordinates beyond ±1e9 mm are rejected. Every board reader declares its budgets, and the import checks them before and after reading.');
  out.push('- Archives: 64 MiB per archive and 64 MiB unpacked for the board plus its companions, 4,096 entries, a bounded expansion ratio and a CRC-32 check per entry (see the archive notes above).');
  out.push('- Documents: 64 MiB per file; at most 16 files / 256 MiB per attach action; PDFs up to 2,000 pages and 500,000 indexed text items per session; PDF cross-reference bounded to 50,000 hits with disclosed truncation; images up to 80 megapixels.');
  out.push('- Native reads are exact-size and growth/shrink safe; writes are queued and atomic; a write submitted after quit began is rejected while every accepted write is drained.', '');

  out.push('## Not verified', '');
  // Derived from the same records as the tables above, so the sentence cannot contradict them.
  const realBoards = FORMAT_CAPABILITIES.filter(c => c.status === 'supported' || /^validated with (?:selected )?real files$/.test(BOARD_EVIDENCE[c.id]?.status ?? '')).map(c => c.name);
  const openToolBoards = FORMAT_CAPABILITIES.filter(c => c.status === 'open-tool-validated').map(c => `${c.name}, validated with ${openToolFiles(c)} (no vendor-written file was tested)`);
  const realSchematics = SCHEMATIC_CAPABILITIES.filter(c => SCHEMATIC_EVIDENCE[c.id].status === 'validated with real files').map(c => c.name);
  const validated = [`${series(realBoards)} (validated with real files, see the table)`, ...openToolBoards, `the ${series(realSchematics)} readers (real files, see above)`];
  out.push(`- Real-file validation covers ${series(validated)}. TVW has record and geometry checks on selected real exports; export variants it does not know are refused with a precise message, and the remaining gaps are disclosed in the import notice. Other rows retain their individual synthetic or open-tool validation level. Selected exports do not establish complete vendor-format coverage; header variants, pad dimensions and transforms remain subject to the limits above.`);
  out.push('- Transform conventions that the specifications leave open follow published conventions and are verified only against synthetic data, except where real files confirmed them (KiCad pad angles; KiCad schematic mirror-x with 90°/270° rotation; EAGLE mirror without rotation): KiCad schematic mirror-y with 90°/270° rotation, the EAGLE order for an element that is mirrored and rotated, and the legacy KiCad rotate+mirror matrices and arc direction.');
  out.push('- **Source-level Electron checks:** the main process, preload bridge, local import, persistence and renderer contracts are exercised by native and renderer tests. Production smoke checks use generated boards and an isolated profile. They cover the tested revision and environment; they do not certify every desktop configuration.');
  out.push('- **Packaged builds:** the release workflow builds the Windows portable EXE, the unsigned Apple-silicon macOS ZIP and the Linux packages from the release tag. Publishing requires platform build and smoke checks plus matching SHA-256 files. macOS and Linux packages remain experimental; download assets and workflow results are available in the GitHub release.');
  out.push('- **Linux builds (experimental):** a .deb and an AppImage for x86-64 are built and smoke-tested by GitHub Actions on Ubuntu 24.04 under a virtual X display: package contents, launch, board import, PDF and image attach, workspace save and restore, quit, single instance, window class and icon, the default data location and the Chromium sandbox state (on for the .deb with its AppArmor profile and for the AppImage where user namespaces are allowed; off, after consent, for the AppImage under Ubuntu\'s user-namespace restriction). No Linux build has been tried on a desktop Linux machine yet. Not tested: real desktop sessions (GNOME, KDE, Wayland), other distributions, arm64 and the native file chooser.', '');
  return `${out.join('\n')}\n`;
}
