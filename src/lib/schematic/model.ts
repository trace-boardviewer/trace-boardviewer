/**
 * Structured schematic model: the single contract between the schematic parsers (KiCad .kicad_sch, KiCad legacy
 * .sch, EAGLE .sch), the connectivity engine, the SchematicViewer and the cross-probe index.
 *
 * Conventions (every producer MUST follow them, every consumer may rely on them):
 *  - Geometry is in millimetres with the Y axis pointing DOWN (screen / KiCad schematic orientation). Parsers of
 *    Y-up sources (EAGLE, KiCad library symbols) convert; the original unit is kept in `Schematic.sourceUnit`.
 *  - Every coordinate in a `SchSheetDef` is ABSOLUTE on that sheet: parsers resolve symbol placement, rotation,
 *    mirroring and the library body, so the viewer and the connectivity engine never repeat that math.
 *  - Arcs are sampled into polylines by the parser (`SchGraphic` has no arc variant).
 *  - Identity: every element has an `id` that is unique inside its sheet definition and stable for identical
 *    input bytes. A hierarchical sheet INSTANCE is identified by its `path` (see `SchSheetInstance`); a repeated
 *    sub-sheet therefore yields several instances of one definition and nothing collides.
 *  - Nothing is invented: unknown records become `SchDiagnostic`s, never guessed geometry or connectivity.
 *  - All objects are plain JSON-like data (structured-clone safe) so a Worker can post them to the UI.
 */

export type SchematicFormat = 'kicad-sch' | 'kicad-legacy-sch' | 'eagle-sch';

export interface SchPoint { x: number; y: number }
export interface SchBounds { minX: number; minY: number; maxX: number; maxY: number }

export type SchPinType =
  | 'input' | 'output' | 'bidirectional' | 'tri_state' | 'passive' | 'free' | 'unspecified'
  | 'power_in' | 'power_out' | 'open_collector' | 'open_emitter' | 'no_connect';

export interface SchPin {
  /** Unique within the sheet definition: `${symbol.id}#${number}` (+ `@${unit}` when numbers repeat across units). */
  id: string;
  /** Physical pin number or ball name exactly as a board file refers to it ("1", "A12", "VCC"). Never empty. */
  number: string;
  /** Electrical function name ("VCC", "~RESET"); '' when the library calls it "~" or nothing. */
  name: string;
  /** Connection point (the outer end of the pin, where wires attach), absolute. */
  at: SchPoint;
  /** Inner end of the pin line at the symbol body, absolute (drawing only). */
  body: SchPoint;
  type: SchPinType;
  hidden: boolean;
  /** Library unit the pin belongs to; 0 = common to every unit. */
  unit: number;
  /**
   * KiCad: an invisible power-input pin is implicitly tied to the GLOBAL net named after the pin. The parser sets
   * this to that name so the engine can honour it; undefined for every other pin.
   */
  implicitNet?: string;
}

export interface SchPolyline { kind: 'poly'; points: SchPoint[]; width: number; filled: boolean }
export interface SchRect { kind: 'rect'; min: SchPoint; max: SchPoint; width: number; fill: 'none' | 'outline' | 'background' }
export interface SchCircle { kind: 'circle'; center: SchPoint; radius: number; width: number; fill: 'none' | 'outline' | 'background' }
export interface SchTextGraphic {
  kind: 'text'; at: SchPoint; text: string;
  /** Degrees, counter-clockwise on screen (0 = horizontal reading left to right). */
  angle: number; size: number; anchor: 'start' | 'middle' | 'end'; bold?: boolean; italic?: boolean;
  /** Field / property text may be hidden in the source; the viewer skips hidden text. */
  hidden?: boolean;
}
export type SchGraphic = SchPolyline | SchRect | SchCircle | SchTextGraphic;

export interface SchField { name: string; value: string; at?: SchPoint; angle?: number; hidden: boolean }

export interface SchSymbol {
  /** KiCad uuid; EAGLE `${part}:${gate}`; legacy KiCad `${timestamp}` or `sym${index}` when absent. */
  id: string;
  /** Library identifier ("Device:R", EAGLE `${library}:${deviceset}:${device}`). */
  libId: string;
  /** Reference stored in the symbol itself ("R?" before annotation); see `symbolRef` for the per-instance value. */
  refDefault: string;
  /**
   * Reference (and annotated unit) per hierarchical sheet-instance path. Non-hierarchical formats use the single
   * key ''. KiCad >= 7 stores this in `(instances (project (path ... (reference) (unit))))`.
   */
  instances: Record<string, { ref: string; unit: number }>;
  value: string;
  footprint: string;
  datasheet: string;
  /** Placed unit (1-based). Multi-unit parts appear as several SchSymbols sharing one reference. */
  unit: number;
  unitCount: number;
  at: SchPoint;
  /** Degrees counter-clockwise on screen: 0, 90, 180, 270. */
  rotation: number;
  mirror: 'none' | 'x' | 'y';
  pins: SchPin[];
  /** Body graphics of the placed unit/body style, absolute. */
  graphics: SchGraphic[];
  fields: SchField[];
  /** Power symbol (KiCad `power` library flag, EAGLE supply gate): ties every connected wire to the GLOBAL net `net`. */
  power?: { net: string };
  /** true for #PWR/#FLG style symbols that are not parts of the bill of materials (never cross-probed to the board). */
  virtual: boolean;
  dnp: boolean;
  bounds: SchBounds;
}

export interface SchWire { id: string; a: SchPoint; b: SchPoint }
export interface SchBus { id: string; a: SchPoint; b: SchPoint }
/** Wire-to-bus connector. It is NOT a conductor between bus members; see connectivity.ts. */
export interface SchBusEntry { id: string; at: SchPoint; to: SchPoint }
export interface SchJunction { id: string; at: SchPoint }
export interface SchNoConnect { id: string; at: SchPoint }

export type SchLabelKind = 'local' | 'global' | 'hierarchical';
export interface SchLabel {
  id: string; kind: SchLabelKind;
  /** Exactly as written (bus syntax "D[0..7]" and "{A B}" is interpreted by the connectivity engine). */
  text: string;
  /** Anchor point; `angle` is the direction the label text extends from it: 0 right, 90 up, 180 left, 270 down (degrees, on screen). */
  at: SchPoint; angle: number;
  shape?: 'input' | 'output' | 'bidirectional' | 'tri_state' | 'passive';
}

export interface SchSheetPin { id: string; name: string; at: SchPoint; shape: 'input' | 'output' | 'bidirectional' | 'tri_state' | 'passive' }
/** A hierarchical sheet symbol drawn on its parent sheet. */
export interface SchSheetRef {
  /** KiCad uuid of the sheet symbol: it is the path component of every instance below it. */
  id: string;
  name: string;
  /** File name exactly as written ("power.kicad_sch"); resolved against the loaded companion files. */
  file: string;
  /** Id of the child `SchSheetDef`, or null when the file was not available (see diagnostics). */
  defId: string | null;
  at: SchPoint; size: SchPoint;
  pins: SchSheetPin[];
}

export interface SchSheetDef {
  /** Unique within the design: normalized lowercase file key for file formats, `sheet:${n}` for EAGLE. */
  id: string;
  /** Display name: file stem or EAGLE sheet description/number. */
  name: string;
  file: string;
  /** KiCad: the (uuid) of the sheet file itself (the first path component of the root instance). */
  uuid?: string;
  title: string;
  titleBlock: Record<string, string>;
  /** Paper size in mm when known. */
  paper?: { width: number; height: number };
  symbols: SchSymbol[];
  wires: SchWire[];
  buses: SchBus[];
  busEntries: SchBusEntry[];
  junctions: SchJunction[];
  noConnects: SchNoConnect[];
  labels: SchLabel[];
  sheetRefs: SchSheetRef[];
  /** Free drawing (lines, rectangles) and notes that carry no electrical meaning. */
  graphics: SchGraphic[];
  bounds: SchBounds;
}

/** One occurrence of a sheet definition in the hierarchy. */
export interface SchSheetInstance {
  /** '' for the root; every child is `${parentPath}/${sheetRef.id}`, so paths always start with '/' (`/id1/id2`, as in KiCad). EAGLE: `sheet:${n}` (no hierarchy). */
  path: string;
  defId: string;
  /** Name shown in navigation (the parent's sheet-symbol name, or the file stem for the root). */
  name: string;
  /** Page number in the source ("1" for root) when known, else the 1-based preorder position. */
  page: string;
  parentPath: string | null;
  /** Sheet-symbol id on the parent that leads here; null for the root. */
  sheetRefId: string | null;
  childPaths: string[];
  depth: number;
}

/** Connectivity declared explicitly by the source (EAGLE nets/segments/pinrefs); KiCad connectivity is computed from geometry. */
export interface SchDeclaredNet {
  name: string;
  pins: Array<{ instancePath: string; defId: string; symbolId: string; pinId: string }>;
  /**
   * Wires the source itself assigns to this net (EAGLE net/segment/wire), including wires of segments that carry no pin
   * reference. A declared net with zero pins is kept (a labelled stub is still a net); nothing here is inferred from geometry.
   */
  wires?: Array<{ instancePath: string; defId: string; wireId: string }>;
}

export type SchSeverity = 'info' | 'warning' | 'error';
export interface SchDiagnostic {
  severity: SchSeverity;
  /** Stable machine code, e.g. 'SHEET_FILE_MISSING', 'UNKNOWN_RECORD', 'NO_CONNECT_CONFLICT'. */
  code: string;
  /** English text (parser diagnostics are not localized, like the board adapters' notes). */
  message: string;
  defId?: string;
  instancePath?: string;
  at?: SchPoint;
}

export interface Schematic {
  format: SchematicFormat;
  /** Human label with version, e.g. "KiCad schematic (version 20231120)". */
  formatLabel: string;
  /** Unit of the SOURCE coordinates (geometry here is already mm). */
  sourceUnit: 'mm' | 'mil' | 'inch';
  name: string;
  defs: SchSheetDef[];
  rootDefId: string;
  /** Expanded hierarchy, root first, preorder; one entry per instance (repeated sub-sheets repeat their definition). */
  instances: SchSheetInstance[];
  declaredNets?: SchDeclaredNet[];
  diagnostics: SchDiagnostic[];
}

/** Reference of `symbol` as annotated for the sheet instance `instancePath` (falls back to the stored reference). */
export function symbolRef(symbol: SchSymbol, instancePath: string): string {
  return symbol.instances[instancePath]?.ref ?? symbol.instances['']?.ref ?? symbol.refDefault;
}
/** Key of a symbol placement: the same symbol on two instances of a repeated sheet gets two keys. */
export const symbolKey = (instancePath: string, symbolId: string): string => `${instancePath}\u0000${symbolId}`;
/** Key of a pin placement. */
export const pinKey = (instancePath: string, symbolId: string, pinId: string): string => `${instancePath}\u0000${symbolId}\u0000${pinId}`;
/** Key of a wire placement. */
export const wireKey = (instancePath: string, wireId: string): string => `${instancePath}\u0000${wireId}`;

// ---------------------------------------------------------------------------------------------------------------
// Connectivity result (produced by src/lib/schematic/connectivity.ts)
// ---------------------------------------------------------------------------------------------------------------

export interface SchNetMember {
  instancePath: string;
  defId: string;
  symbolId: string;
  pinId: string;
  /** Reference as annotated for this instance. */
  ref: string;
  unit: number;
  pinNumber: string;
  pinName: string;
}
export interface SchNet {
  /** Stable for identical input: `net:global:${name}` | `net:local:${instancePath}:${name}` | `net:auto:${n}`. */
  id: string;
  /** Best name: a label/power-symbol/pin name, or an automatic KiCad-style name "Net-(R1-Pad2)" with `auto` set. */
  name: string;
  auto: boolean;
  /** 'global' labels/power symbols (design-wide), 'local' = visible only in `scopePath` (a single sheet instance),
   *  'hierarchical' = joined across a sheet pin / hierarchical label pair at instance-path scope. */
  scope: 'global' | 'local' | 'hierarchical';
  scopePath?: string;
  /** All distinct names that were merged into this net (labels, power symbols, sheet pins), sorted. */
  aliases: string[];
  members: SchNetMember[];
  /** Wires belonging to the net, for highlighting. */
  wires: Array<{ instancePath: string; wireId: string }>;
}
export interface SchConnectivity {
  nets: SchNet[];
  /** pinKey → SchNet.id for every pin that belongs to a net with at least one other member or any name. */
  pinNet: Record<string, string>;
  /** wireKey → SchNet.id */
  wireNet: Record<string, string>;
  /** Pins explicitly marked no-connect. */
  noConnectPins: string[];
  /** Pins with neither a connection nor a no-connect marker (informational). */
  floatingPins: string[];
  diagnostics: SchDiagnostic[];
}
/** What a worker returns for one schematic document: the parsed model and its computed connectivity. */
export interface SchematicDesign { schematic: Schematic; connectivity: SchConnectivity }

/** Structured, English failure of a recognized-but-unreadable schematic (mirrors BoardFormatError). */
export type SchematicErrorCode = 'INVALID_FORMAT' | 'UNRECOGNIZED' | 'LIMIT_EXCEEDED' | 'UNSUPPORTED_VARIANT' | 'ABORTED';
export class SchematicError extends Error {
  constructor(message: string, readonly code: SchematicErrorCode = 'INVALID_FORMAT', readonly format?: SchematicFormat) {
    super(message); this.name = 'SchematicError';
  }
}

/** Import budgets shared by every schematic adapter (bytes are bounded natively; these bound the expanded output). */
export const SCHEMATIC_LIMITS = Object.freeze({
  maxSheetDefs: 256,
  maxInstances: 4096,
  maxSymbolsPerDef: 100_000,
  maxPinsTotal: 2_000_000,
  maxWiresPerDef: 500_000,
  maxExpression: 6_000_000,
  maxNestingDepth: 64,
  maxCoordinateMm: 1e6,
});

/** Input of every schematic parser: the primary file plus sibling files from the SAME directory (lowercase basename keys). */
export interface SchematicInput {
  name: string;
  data: Uint8Array;
  companions?: Record<string, Uint8Array>;
}
export type SchematicParser = (input: SchematicInput) => Schematic | null;
