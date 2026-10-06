import formats from '../../../electron/formats.json';
import type { Board } from '../types';
import { utf8Input } from '../encoding';
import { GenCadParseError, parseGenCad } from '../gencad';
import { BoardFormatError, decodeText, MAX_IMPORT_BYTES, TextDecodeError, type BoardParser, type ParseInput } from './common';

export { BoardFormatError } from './common';
export type { FormatErrorCode, ParseInput, ParseOptions } from './common';

/**
 * Honest per-format capability record behind the public support table. `status` and `validation` move only with tests:
 * 'draft' means an adapter is registered and proven on ORIGINAL synthetic fixtures (units, sides, net identity, negatives),
 * but NOT against real vendor files; 'supported' additionally requires real-file validation.
 */
export interface FormatCapability {
  id: string;
  name: string;
  extensions: string[];
  variants: string[];
  status: 'supported' | 'draft' | 'recognized-unsupported' | 'extension-only';
  validation: 'real-files' | 'synthetic-fixtures' | 'none';
  electrical: 'nets' | 'none';
  geometry: 'real' | 'estimated' | 'mixed';
  units: string;
  sides: string;
  requires?: ('key' | 'companions')[];
  notes: string[];
}

export const FORMAT_CAPABILITIES: readonly FormatCapability[] = [
  { id: 'gencad', name: 'GenCAD 1.4', extensions: ['.cad', '.gcd'], variants: ['GENCAD 1.4 ($HEADER … $SIGNALS)'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'mixed',
    units: 'UNITS header: MM, INCH, THOU/MIL, USER (25.4 / divisor)', sides: 'LAYER TOP/BOTTOM; SHAPE MIRRORX/Y/XY and FLIP select padstack layers',
    notes: ['Exact ROUND/RECTANGLE pads keep their dimensions; other pad shapes are approximated by bounding rectangles.', 'Only the outer closed board contour is drawn; cutouts are disclosed as a warning.', 'Shape instancing is preflighted against an expanded-output budget (250,000 components, 1,000,000 pins, 8,000,000 placed outline, body and pad-corner points) before any pin is created; a file may hold up to 8,000,000 lines within the 64 MiB limit.'] },
  { id: 'brd', name: 'Landrex / TestLink BRD', extensions: ['.brd'], variants: ['plain text (str_length/var_data)', 'rotated-byte encoded (signature 23 E2 63 28)'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated',
    units: 'mil (×0.0254)', sides: 'part type 1 and 4–7 top, 2 and ≥8 bottom, 0 and 3 both; pins inherit the part; nails side 1 top, otherwise bottom',
    notes: ['Pads carry no physical size (radius 0); component bodies come from their pins; the outline comes from the Format record.', 'UNCONNECTED<n> vendor placeholders are no net.', 'Components without pins are omitted with a note (the format gives them no position). A header count that disagrees with the rows is rejected as malformed, where OpenBoardView only logs it and continues.', 'Remaining gap to supported: no real Landrex / TestLink file was available.'] },
  { id: 'brd2', name: 'TOPTEST BRD2', extensions: ['.brd'], variants: ['BRDOUT/NETS/PARTS/PINS/NAILS'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated',
    units: 'mil (×0.0254)', sides: 'side codes 1 top, 2 bottom, 0 both; bottom Y is boardHeight − rawY; a part with no pin on its own side becomes both; nails side 1 top, otherwise bottom',
    notes: ['Pads carry no physical size (radius 0); part body rectangles and the outline come from the file.', 'A truncated BRDOUT file is reported as a malformed BRD2, not as unrecognized.', 'A component without pins keeps its declared side and body rectangle (OpenBoardView turns it into a through-hole part on both sides); header counts that disagree with the rows are rejected.', 'Remaining gap to supported: no real BRD2 file was available.'] },
  { id: 'bdv', name: 'Honhan BDV', extensions: ['.bdv'], variants: ['plain <<format.asc>>/<<pins.asc>>/<<nails.asc>> sections', 'encoded (keyless per-line cipher; line 1 reads dd:1.3?,r?-=bb)'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated',
    units: 'inch (×25.4)', sides: 'the side field of the "Part <ref> <side>" line: exactly (T) is top, everything else bottom; pins inherit it; nails carry their own side field',
    notes: ['Header line counts (8/8/7) follow the OpenBoardView reference reader and are NOT verified against a vendor file.', 'Pads carry no physical size; test points become one-pin TP:<probe> components.', 'Remaining gap to supported: no real BDV file was available; a Part line must hold exactly a reference and a side marker.'] },
  { id: 'bvr', name: 'BVR raw boardview (BVRAW_FORMAT_3)', extensions: ['.bvr'], variants: ['BVRAW_FORMAT_3 (PART_/PIN_ records with radii), as written by kicad-boardview'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'mixed',
    units: 'mil (×0.0254)', sides: 'PART_SIDE/PIN_SIDE T/B/O (absent = both, disclosed); coordinates are the same for both sides (no mirroring)',
    notes: ['Validated with real files: the five Raspberry Pi Pico boardviews (open design) exported by the open-source kicad-boardview plugin. All five open; three were cross-checked against their .kicad_pcb: components, pin counts per component, net names, sides and pin positions agree to the file\'s 1 mil resolution; the exporter leaves out non-copper and overlapping same-numbered pads.', 'PIN_NUMBER, PIN_NAME and PIN_NET may be empty (fiducials, unconnected pads); a net name may contain blanks. PIN_RADIUS is half the pad\'s larger dimension in mil in these exports.', 'No vendor-written BVR3 file was tested; the .obdata metadata sidecars (package, value and status per reference) are not read.', 'Other BVRAW_FORMAT_<n> versions are recognized and rejected as unsupported variants.', '.bv Microsoft Access databases are not readable; export them to BVR first.'] },
  { id: 'bvr1', name: 'BVR raw boardview (BVRAW_FORMAT_1)', extensions: ['.bvr'], variants: ['BVRAW_FORMAT_1 (<<Layout>>/<<Pin>>/<<Nail>>)'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated',
    units: 'inch (×25.4)', sides: 'per-line (T) top, otherwise bottom',
    notes: ['The one-line section headers follow the OpenBoardView reference reader; no real BVRAW_FORMAT_1 file was available, so this dialect is proven on synthetic fixtures only.', 'Pads carry no physical size; components without pins are omitted with a note.'] },
  { id: 'asc', name: 'ASC companion trio', extensions: ['.asc'], variants: ['format.asc + pins.asc + nails.asc in one directory'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated',
    units: 'inch (×25.4)', sides: 'the side field of the "Part <ref> <side>" line: exactly (T) is top, everything else bottom; pins inherit it; nails carry their own side field', requires: ['companions'],
    notes: ['All three files are required; the result and the notes identity are identical whichever of the three is opened (complete-file-set key).', 'Companions are matched case-insensitively in the selected file\'s directory only; missing files are named in the error.', 'Pads carry no physical size.', 'Remaining gap to supported: no real ASC export was available. OpenBoardView also loads the trio when parts.asc, nets.asc or a .bom file is chosen; here only format.asc, pins.asc and nails.asc open it.'] },
  { id: 'fz', name: 'FZ / CAE encrypted boardview', extensions: ['.fz', '.cae'], variants: ['ASUS FZ (RC6 feedback, 44-word key)', 'ASRock CAE (RC6 feedback, 44-word key)', 'unencrypted zlib container (four footer layouts)'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'mixed',
    units: 'mil (×0.0254); UNIT:millimeters ×1; any other UNIT value is read as thou with a disclosed note', sides: 'REFDES mirror YES is bottom, otherwise top; test vias T is top, otherwise bottom', requires: ['key'],
    notes: ['No key ships with the application; the user supplies the 44 unsigned 32-bit words (kept for the session only, never saved).', 'Recognized by extension plus structure (encrypted data has no magic): a random binary file named .fz asks for a key.', 'The RADIUS column is used as the pad radius when present (unverified); graphics blocks are ignored and no outline is read.', 'Proven only with synthetic keys and containers; no real vendor file was tested.', 'A REFDES without pins is omitted with a note; a repeated REFDES is rejected, where OpenBoardView lets the later one take over the name.'] },
  { id: 'xzz', name: 'XZZ PCB', extensions: ['.pcb'], variants: ['plain XZZPCB header', 'XOR-obfuscated header (marker v6v6555v6v6)', 'DES-ECB encrypted part/pin records (16 hex-digit key)'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'mixed',
    units: 'raw ÷ 10000 mil, then ×0.0254', sides: 'component side is not decoded: every part is placed on top and this is disclosed',
    notes: ['The DES key is only needed for encrypted records (kept for the session only).', 'Pin and test-pad positions are real; pad sizes are unknown (estimated). The outline comes from layer 28 (arcs as nine chords); cutouts and open chains are disclosed.', 'Vias and text blocks are skipped; unknown block types are disclosed.', 'A component block without pins is omitted with a note; an unknown component sub-record type is rejected, where OpenBoardView skips byte by byte.', 'Remaining gap to supported: no real XZZ file was available.'] },
  { id: 'cst', name: 'CAST CST', extensions: ['.cst'], variants: ['LE int16 binary, CDev/CPad sections'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated',
    units: 'mil (×0.0254)', sides: 'layer 0x0C top, 0x01 bottom; every other layer code is rejected; a negative part id creates one ICT part on both sides',
    notes: ['Pin positions are real; pad size, body and outline are absent (a missing-outline warning is shown).', 'Pin numbers are file-order ordinals, not physical pin names; components with no pins are omitted with a note.', 'An unknown layer code is rejected on purpose (OpenBoardView places such a component on both sides; finding B04).', 'Remaining gap to supported: no real CAST file was available.'] },
  { id: 'kicad', name: 'KiCad PCB', extensions: ['.kicad_pcb'], variants: ['S-expression kicad_pcb (versions 4–9: footprint and legacy module records)'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'real',
    units: 'mm', sides: 'F.Cu top, B.Cu bottom (file geometry already mirrored); *.Cu pads both',
    notes: ['Fixtures cover KiCad 4/5 legacy module records, KiCad 6 footprint+fp_text and KiCad 8 property styles; no real KiCad file was tested. KiCad 3 and older are unsupported; tracks, zones and vias are ignored (nets come from pads only).', 'Pad angles are board-absolute (previous author\'s reading, synthetic fixtures only); footprint rotation only places local pad positions. Rect and equal-size circle pads are exact; oval, roundrect, trapezoid, custom and non-square circle pads are drawn as bounding rectangles and counted as approximated.', 'Edge.Cuts (line, rect, poly, circle, arc, curve): the largest closed loop is the outline; inner loops and footprint-level Edge.Cuts are disclosed as cutouts but not drawn; open chains are never closed.', 'Contradictory net ids/names are rejected. A user net literally named UNCONNECTED keeps its identity; only KiCad single-pad unconnected-(…) placeholders are treated as no-connects.'] },
  { id: 'eagle', name: 'EAGLE board XML', extensions: ['.brd'], variants: ['<eagle> board XML with <elements>, <libraries>, <signals> (declaration optional)'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'real',
    units: 'mm', sides: 'element rot M prefix mirrors to bottom; R angle rotates', notes: ['Original adapter from Autodesk ULP object documentation; no EAGLE code is used; fixtures are synthetic 9.6-style documents.', 'XML entities are never expanded (DOCTYPE ENTITY is rejected); EAGLE schematics (<schematic> root) are not boards and EAGLE libraries are rejected as the wrong kind.', 'Exact pads: SMD rectangle/square/fully round square and round or square through-hole pads; partially rounded, capsule (roundness 100 non-square), octagon, long and offset pads are drawn as bounding rectangles and counted as approximated. Only SMD layers 1 and 16 are supported.', 'The mirror order (x flips first, then counter-clockwise rotation) follows convention and is not independently verified. Outline arcs/circles are sampled as straight segments; inner loops are disclosed as cutouts; pad counts of referenced packages are preflighted against the 1,000,000-pin limit before any pin is created.'] },
  { id: 'altium', name: 'Altium PcbDoc', extensions: ['.pcbdoc', '.cmpcbdoc', '.cspcbdoc'], variants: ['binary OLE compound (CFB version 3) record streams', 'ASCII |RECORD=Board|KIND=Protel_Advanced_PCB lines (draft: keys not publicly documented)'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'real',
    units: 'binary int32 1/10000 mil; text values need a mil/mm/in suffix', sides: 'pad layer 1 top, 32 bottom, 74 both (others rejected); component LAYER TOP/BOTTOM',
    notes: ['Only components, nets, pads and the first Board6 outline record are read; tracks, vias, arcs, fills, regions, text, models and rules are not, and every import says so.', 'Layouts follow public documentation (KiCad developer docs, Altium API reference, [MS-CFB]); component bodies come from pad extents and values are not read.', 'Round unequal / octagonal / rounded-rectangle pads are drawn as rectangles and counted as approximated; outline arcs are drawn as chords.', 'No real Altium file was tested; compound-file version 4 is rejected as an unsupported variant. SchDoc/SchLib/PcbLib are named and rejected.'] },
  { id: 'samsung-cad', name: 'Samsung CAD', extensions: ['.cad'], variants: ['###Panel Added with COMP / C_PIN / N_VIA records'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated',
    units: 'inch (×25.4), as OpenBoardView reads it; not verified against a vendor file', sides: 'COMP side field: 1 top, any other value bottom; pins inherit the component',
    notes: ['The layout follows the OpenBoardView reference reader (the only public description found); both the "###Panel Added" and "C_PIN" markers must be present, which also keeps GenCAD .cad files apart.', 'Pads carry no physical size and components no body or outline: positions come from the C_PIN records only and the outline from the pins.', 'The pin number is the text after the dash in the REF-PIN field (upstream discards it); a leading "/" of a net name is removed; N_VIA test vias are counted and not shown.'] },
  { id: 'mentor-neutral', name: 'Mentor Neutral', extensions: ['.neu'], variants: ['Mentor Graphics neutral file (# file / # date header)'], status: 'recognized-unsupported', validation: 'none', electrical: 'none', geometry: 'estimated',
    units: 'unverified', sides: 'unverified', notes: ['Recognized by a header taken from a single vendor help example; no adapter or fixture.'] },
  { id: 'allegro-brd', name: 'Cadence Allegro BRD (native)', extensions: ['.brd'], variants: ['binary database; documented magic 0x00130000–0x00150000 (16.0–18.0+) plus "all" at offset 0xF8'], status: 'recognized-unsupported', validation: 'none', electrical: 'none', geometry: 'estimated',
    units: 'n/a', sides: 'n/a', notes: ['Native Allegro databases are proprietary; export GenCAD or use the vendor viewer.', 'Databases older than 16.0 are not recognized.'] },
  { id: 'tvw', name: 'TVW boardview', extensions: ['.tvw'], variants: ['observed binary container'], status: 'extension-only', validation: 'none', electrical: 'none', geometry: 'estimated',
    units: 'n/a', sides: 'n/a', notes: ['The extension is accepted by the file chooser, but no public byte signature exists, so the content is reported as unrecognized.', 'The only public parser is LGPL and is not used.'] },
  { id: 'gerber', name: 'Gerber RS-274X', extensions: ['.gbr'], variants: ['single-layer RS-274X graphics'], status: 'recognized-unsupported', validation: 'none', electrical: 'none', geometry: 'real',
    units: 'MO IN/MM', sides: 'n/a', notes: ['A single Gerber layer has no components or nets; a geometry-only mode would be needed.'] },
  { id: 'odbpp', name: 'ODB++ archive', extensions: ['.tgz'], variants: ['gzip tar with odb/ matrix/steps hierarchy'], status: 'recognized-unsupported', validation: 'none', electrical: 'none', geometry: 'real',
    units: 'INCH/MM per step', sides: 'n/a', notes: ['Recognized from tar headers only (bounded, nothing extracted); multi-file archive import is not implemented.'] },
  { id: 'ipc2581', name: 'IPC-2581', extensions: ['.xml', '.cvg'], variants: ['IPC-2581 revision B/C XML'], status: 'recognized-unsupported', validation: 'none', electrical: 'none', geometry: 'real',
    units: 'per file', sides: 'n/a', notes: ['Recognized by the IPC-2581 root element only.'] },
];

/** Lowercase extensions with a leading dot: everything the chooser may open, recognized-unsupported families included. */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.freeze(formats.extensions.map(extension => {
  if (!/^\.[a-z0-9_]+$/.test(extension)) throw new Error(`formats.json: invalid extension ${extension}`);
  return extension;
}));
const COMPANIONS: Readonly<Record<string, readonly string[] | undefined>> = formats.companions;
/** Lowercase basenames of the sidecars that belong to `name` in the same directory ([] for single-file formats). */
export function companionNames(name: string): string[] {
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return Object.hasOwn(COMPANIONS, base) ? [...COMPANIONS[base] ?? []] : [];
}

const GENCAD_SNIFF_BYTES = 16 * 1024;
/**
 * A GenCAD file opens with its `$HEADER` section, so the claim is a line holding exactly that marker. A bare `GENCAD`
 * keyword is no claim: other text formats ignore unknown keywords, so a `GENCAD 1.4` line inside, say, a BVR3 file must
 * not pull it into this adapter, which cannot return it once claimed. Horizontal whitespace only, never `\s`, keeps the
 * scan linear across blank-line floods.
 */
const GENCAD_HEADER = /^[ \t]*\$HEADER[ \t]*$/im;
/** GenCAD keeps its own structured errors (GenCadParseError.issue) for the localized UI. */
function parseGenCadBoard(input: ParseInput): Board | null {
  const text = decodeText(input.data);
  if (!GENCAD_HEADER.test(text.slice(0, GENCAD_SNIFF_BYTES))) return null;
  return parseGenCad(text, input.name);
}

export interface ParserEntry { id: string; parse: BoardParser }
// --- Adapter registration ---
// Order: cheap exact-signature parsers first, GenCAD before BRD (CAD/BRD/SCH extensions collide), structure/extension-gated
// parsers (FZ, ASC) after the content-signature parsers, recognizers of unsupported families last. Every parser returns null
// for bytes that are not its format; a recognized but malformed file throws from its adapter.
import { parseAltium } from './altium';
import { parseAsc } from './asc';
import { parseBdv } from './bdv';
import { parseBrd } from './brd';
import { parseBvr } from './bvr';
import { parseCst } from './cst';
import { parseEagle } from './eagle';
import { parseFz } from './fz';
import { parseKicad } from './kicad';
import { recognizeUnsupported } from './recognizers';
import { parseSamsungCad } from './samsung-cad';
import { parseXzz } from './xzz';
export const PARSERS: ParserEntry[] = [
  { id: 'gencad', parse: parseGenCadBoard },
  { id: 'kicad', parse: parseKicad },
  { id: 'eagle', parse: parseEagle },
  { id: 'altium', parse: parseAltium },
  { id: 'xzz', parse: parseXzz },
  { id: 'cst', parse: parseCst },
  { id: 'samsung-cad', parse: parseSamsungCad },
  { id: 'bdv', parse: parseBdv },
  { id: 'bvr', parse: parseBvr },
  { id: 'brd', parse: parseBrd },
  { id: 'asc', parse: parseAsc },
  { id: 'fz', parse: parseFz },
  { id: 'recognizers', parse: recognizeUnsupported },
];
// --- End of adapter registration ---

const extensionOf = (name: string): string => /(\.[^.\\/]+)$/.exec(name.split(/[\\/]/).pop() ?? '')?.[1]?.toLowerCase() ?? '';

/**
 * Size guard, then the first parser that recognizes the bytes wins; recognized-but-malformed input throws from its adapter.
 * A byte-order-marked UTF-16 file is re-encoded as UTF-8 first, so the adapters that sniff bytes and the ones that
 * decode text agree on what the file says.
 */
export function parseBoard(raw: ParseInput): Board {
  if (!(raw.data instanceof Uint8Array)) throw new BoardFormatError('Board data must be a byte array.');
  if (raw.data.length > MAX_IMPORT_BYTES) throw new BoardFormatError('Board data exceeds the 64 MiB import limit.', 'LIMIT_EXCEEDED');
  for (const [name, bytes] of Object.entries(raw.companions ?? {})) {
    if (!(bytes instanceof Uint8Array)) throw new BoardFormatError(`Companion file ${name} must be a byte array.`);
    if (bytes.length > MAX_IMPORT_BYTES) throw new BoardFormatError(`Companion file ${name} exceeds the 64 MiB import limit.`, 'LIMIT_EXCEEDED');
  }
  const input = utf8Input(raw);
  if (input.data.length > MAX_IMPORT_BYTES) throw new BoardFormatError('Board data exceeds the 64 MiB import limit.', 'LIMIT_EXCEEDED');
  for (const { id, parse } of PARSERS) {
    let board: Board | null;
    try { board = parse(input); }
    catch (error) {
      if (error instanceof BoardFormatError || error instanceof GenCadParseError) throw error;
      if (error instanceof TextDecodeError) continue; // A UTF-16 BOM followed by garbage is not text this parser can claim.
      const wrapped = new BoardFormatError(`${id}: unexpected parser failure: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_FORMAT', id);
      wrapped.cause = error; throw wrapped;
    }
    if (board) return board;
  }
  const extension = extensionOf(input.name);
  throw new BoardFormatError(`The content of "${input.name.split(/[\\/]/).pop() ?? input.name}" (${extension || 'no extension'}) matched none of the supported boardview formats.`, 'UNRECOGNIZED');
}
