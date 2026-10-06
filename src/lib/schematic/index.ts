import { utf8Input } from '../encoding';
import { computeConnectivity } from './connectivity';
import { parseEagleSch } from './eagle-sch';
import { parseKicadLegacySch } from './kicad-legacy';
import { parseKicadSch } from './kicad-sch';
import { SchematicError } from './model';
import type { Schematic, SchematicDesign, SchematicFormat, SchematicInput, SchematicParser } from './model';

export { SchematicError } from './model';
export type { SchematicInput } from './model';

/** Same import bound as boards: the primary file alone and every companion are checked against it natively too. */
export const MAX_SCHEMATIC_BYTES = 64 * 1024 * 1024;
const MAX_COMPANION_FILES = 256;

/** Honest per-format record behind the public support table; `status` flips only with fixture tests that prove it. */
export interface SchematicCapability {
  id: SchematicFormat;
  name: string;
  extensions: string[];
  variants: string[];
  status: 'supported';
  /** How nets are obtained: from wire/label geometry (computed) or from connectivity the file declares. */
  connectivity: 'computed-from-geometry' | 'declared-nets';
  units: string;
  hierarchy: string;
  requires: string[];
  limits: string[];
}

export const SCHEMATIC_CAPABILITIES: readonly SchematicCapability[] = [
  { id: 'kicad-sch', name: 'KiCad schematic', extensions: ['.kicad_sch'], variants: ['S-expression, (version) 20211123 (KiCad 6.0) through 20250114 (KiCad 9.0.x)'], status: 'supported',
    connectivity: 'computed-from-geometry', units: 'mm, Y down; every symbol resolved to absolute coordinates',
    hierarchy: 'Sheet symbols resolved from sibling .kicad_sch files of the same directory; repeated sub-sheets become separate instances (path = /sheetUuid/…) with per-instance references and units',
    requires: ['sub-sheet files in the same directory (otherwise the sheet is shown unresolved with a diagnostic)'],
    limits: ['Versions outside the covered range are rejected, never guessed', 'Mirror combined with 90°/270° rotation follows the published conventions and is proven only by synthetic fixtures', 'Local power symbols (KiCad 9) get no global net; bus aliases are not expanded', 'Sub-sheet files in other directories are not loaded'] },
  { id: 'kicad-legacy-sch', name: 'KiCad legacy schematic', extensions: ['.sch'], variants: ['EESchema Schematic File Version 1–4 (text .sch)'], status: 'supported',
    connectivity: 'computed-from-geometry', units: 'mil in the file, converted to mm, Y down',
    hierarchy: 'Sheet files from the same directory; instance path = chain of $Sheet timestamps; alternate references (AR records) per instance',
    requires: ['<project>-cache.lib or other .lib files in the same directory for symbol pins and bodies', 'sub-sheet .sch files in the same directory'],
    limits: ['A symbol whose library entry is missing keeps no pins and no body (diagnostic) — nothing is invented', 'The orientation-matrix reading of the two rotate+mirror matrices and the arc direction follow the published description and synthetic fixtures only', 'Versions above 4 are rejected'] },
  { id: 'eagle-sch', name: 'EAGLE schematic', extensions: ['.sch'], variants: ['EAGLE XML <schematic> (attribute-driven; fixtures cover 6.5–9.7)'], status: 'supported',
    connectivity: 'declared-nets', units: 'mm in the file, Y flipped to Y down',
    hierarchy: 'Each <sheet> is a sibling sheet; EAGLE modules (hierarchical designs) are not supported and produce a warning',
    requires: [],
    limits: ['Pin numbers are the BOARD pad names from the device connects; supply and package-less symbols are never cross-probed', 'Implicit power connections of unplaced gates are not modelled', 'Bus members are not expanded; connectivity comes only from declared nets'] },
];

export interface SchematicParserEntry { id: SchematicFormat; parse: SchematicParser }
/** Detection is by CONTENT; each parser returns null for bytes that are not its format. `.sch` is shared by two formats. */
export const SCHEMATIC_PARSERS: SchematicParserEntry[] = [
  { id: 'kicad-sch', parse: parseKicadSch },
  { id: 'kicad-legacy-sch', parse: parseKicadLegacySch },
  { id: 'eagle-sch', parse: parseEagleSch },
];

function checkInput(input: SchematicInput): void {
  if (!(input.data instanceof Uint8Array)) throw new SchematicError('Schematic data must be a byte array.', 'INVALID_FORMAT');
  if (input.data.length > MAX_SCHEMATIC_BYTES) throw new SchematicError('Schematic data exceeds the 64 MiB import limit.', 'LIMIT_EXCEEDED');
  const entries = Object.entries(input.companions ?? {});
  if (entries.length > MAX_COMPANION_FILES) throw new SchematicError(`More than ${MAX_COMPANION_FILES} companion files were supplied.`, 'LIMIT_EXCEEDED');
  let total = input.data.length;
  for (const [name, bytes] of entries) {
    if (!(bytes instanceof Uint8Array)) throw new SchematicError(`Companion file ${name} must be a byte array.`, 'INVALID_FORMAT');
    total += bytes.length;
    if (total > MAX_SCHEMATIC_BYTES) throw new SchematicError('The schematic and its companion files exceed the 64 MiB import limit.', 'LIMIT_EXCEEDED');
  }
}

/**
 * First parser that recognizes the bytes wins; recognized-but-malformed input throws from its parser. Byte-order-marked
 * UTF-16 files (primary and companions) are re-encoded as UTF-8 first, as the board dispatcher does, so the readers that
 * sniff their header on raw bytes see them too.
 */
export function parseSchematic(raw: SchematicInput): Schematic {
  checkInput(raw);
  const input = utf8Input(raw);
  for (const { id, parse } of SCHEMATIC_PARSERS) {
    let schematic: Schematic | null;
    try { schematic = parse(input); }
    catch (error) {
      if (error instanceof SchematicError) throw error;
      const wrapped = new SchematicError(`${id}: unexpected parser failure: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_FORMAT', id);
      wrapped.cause = error; throw wrapped;
    }
    if (schematic) return schematic;
  }
  const base = input.name.split(/[\\/]/).pop() ?? input.name;
  throw new SchematicError(`The content of "${base}" matched none of the supported schematic formats (KiCad .kicad_sch, KiCad legacy .sch, EAGLE .sch).`, 'UNRECOGNIZED');
}

/** Parses and computes connectivity: what the schematic worker returns for one document. */
export function loadSchematicDesign(input: SchematicInput, options: { signal?: AbortSignal } = {}): SchematicDesign {
  const schematic = parseSchematic(input);
  return { schematic, connectivity: computeConnectivity(schematic, options) };
}
