/*
 * Format adapter interface, version 2 (original TRACE module, MIT).
 *
 * An adapter is one folder under src/lib/formats/adapters/<id>/ whose index.ts default-exports the result of
 * defineBoardAdapter (or defineContainerAdapter). The registry (registry.ts) discovers every folder at build time, so adding a reader never edits a
 * shared list; electron/formats.json, FORMAT_CAPABILITIES and docs/SUPPORT.md are derived from the registry and tests fail
 * when a derived file drifts. docs/ADAPTERS.md is the contributor guide.
 *
 * Adapters are compiled into the application. There are no runtime plugins: code loaded from outside app.asar would
 * bypass the integrity checks, and a malicious reader running in the renderer would see every file the user opens.
 */
import type { Board } from '../types';
import { MAX_IMPORT_BYTES, type ParseInput } from './common';
import type { StructureHook } from './structure-hook';

export const ADAPTER_API_VERSION = 2;
/** The most bytes a sniff ever sees: the head of the (UTF-8 normalized) file. */
export const SNIFF_BYTES = 64 * 1024;
/**
 * Sniff confidence scale (0..100). A sniff returns the strength of its evidence, never a guess dressed up as certainty:
 *   CERTAIN  (90..100) the format's own signature at its fixed place: a magic number at an offset, the root element or
 *                      first record, a mandatory header line. Two board adapters certain about the same bytes is an
 *                      ambiguity: the file is not opened.
 *   LIKELY   (50..89)  markers found anywhere in the head, or a name the format is known by plus matching content.
 *   POSSIBLE (1..49)   only the name fits, or the markers may lie beyond the sniff window; the parse decides.
 *   0                  not this format; the parse is never called.
 * Inside a tier, evidence that is more specific outranks evidence that is less specific; docs/ADAPTERS.md lists the
 * values the built-in adapters use, and registry.test.ts pins the verdict for every overlap that is known.
 */
export const CERTAIN = 90, LIKELY = 50, POSSIBLE = 1;

/** Keys the key dialog can collect today; a new kind needs its own dialog and validation (docs/ADAPTERS.md). */
export type KeyKind = 'fz' | 'xzz';
/** FZ/CAE: 44 unsigned 32-bit words; XZZ: 16 hexadecimal digits. Session-only: never stored, logged or reported. */
export type KeyMaterial = readonly number[] | string;

/**
 * Status levels of the public support table (R1 3.3). Each level moves only with tests and evidence:
 *   supported               registered and validated with real vendor-written files;
 *   open-tool-validated     registered and validated with files written by open tools (`openTool` names the tool and the
 *                           designs), but not with files written by the vendor's own software;
 *   draft                   registered and proven on original synthetic fixtures only;
 *   recognized-unsupported  the bytes are identified and explained, nothing is imported;
 *   extension-only          the chooser accepts the extension; the content is reported as unrecognized.
 */
export type SupportStatus = 'supported' | 'open-tool-validated' | 'draft' | 'recognized-unsupported' | 'extension-only';
export type Validation = 'real-files' | 'open-tool-files' | 'synthetic-fixtures' | 'none';
/** The validation level each status requires (registry.test.ts enforces it). */
export const STATUS_VALIDATION: Readonly<Record<SupportStatus, Validation>> = Object.freeze({
  supported: 'real-files', 'open-tool-validated': 'open-tool-files', draft: 'synthetic-fixtures', 'recognized-unsupported': 'none', 'extension-only': 'none',
});

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
  status: SupportStatus;
  validation: Validation;
  /** Required for 'open-tool-files': which open tool wrote the files and from which open designs. */
  openTool?: { tool: string; designs: string };
  electrical: 'nets' | 'none';
  geometry: 'real' | 'estimated' | 'mixed';
  units: string;
  sides: string;
  requires?: ('key' | 'companions')[];
  notes: string[];
}

/**
 * Real-file evidence recorded by a validation lane, kept next to the adapter it describes. `status`/`validatedWith` replace
 * the table cells, `rewrites` replace a substring of exactly one stale note (`from` must occur once), `extra` is appended.
 */
export interface RealFileEvidence { status: string; validatedWith: string; rewrites: ReadonlyArray<{ from: string; to: string }>; extra: readonly string[] }

/** What a sniff sees: at most SNIFF_BYTES of the head, the file name (a path or a bare name) and the full size. */
export interface SniffInput { readonly head: Uint8Array; readonly name: string; readonly size: number }
export interface SniffResult {
  /** 0..100, see CERTAIN / LIKELY / POSSIBLE. */
  readonly confidence: number;
  /** Short English reason for diagnostics and tests ("BVRAW_FORMAT_3 header line"); empty only for confidence 0. */
  readonly reason: string;
  readonly variant?: string;
  /** The bytes look encrypted and will need this key kind. */
  readonly needsKey?: KeyKind;
  /**
   * A few facts the head states outright (a version, the units, the writing tool), for listings that never parse the
   * file. At most META_LIMIT entries with camelCase keys; strings are cut to META_TEXT characters.
   */
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}
export const META_LIMIT = 8, META_TEXT = 120;
export const NO_MATCH: SniffResult = Object.freeze({ confidence: 0, reason: '' });
export const sniffed = (confidence: number, reason: string, extra: Omit<SniffResult, 'confidence' | 'reason'> = {}): SniffResult => Object.freeze({ confidence, reason, ...extra });

/**
 * How an adapter tells its files apart. At most one adapter per extension may rely on the name alone; every other adapter
 * that shares the extension must detect by content (registry.test.ts fails otherwise).
 *   signature  a fixed magic number, header line or root element;
 *   structure  the layout of the content (several markers, record shapes);
 *   name       the extension or file name only (encrypted or magic-less formats);
 *   none       never detected by bytes (extension-only families).
 */
export type Detection = 'signature' | 'structure' | 'name' | 'none';

/** Declared budgets. The dispatcher enforces the byte limits before parse and the record limits on the result. */
export interface ResourceLimits {
  /** Largest primary file (bytes). */
  readonly maxInputBytes: number;
  /** Primary plus companion files together (bytes). */
  readonly maxTotalBytes: number;
  readonly maxComponents: number;
  readonly maxPins: number;
}
export const DEFAULT_LIMITS: ResourceLimits = Object.freeze({ maxInputBytes: MAX_IMPORT_BYTES, maxTotalBytes: MAX_IMPORT_BYTES, maxComponents: 250_000, maxPins: 1_000_000 });

/** Companion files: every set lists lowercase basenames that belong together in one directory; any member opens the set. */
export interface CompanionRule { readonly sets: ReadonlyArray<readonly string[]> }

/** Families of the open dialog's secondary filters (plain English, shown verbatim by the native dialog). */
export const DIALOG_FAMILIES = ['GenCAD', 'Boardview', 'ECAD design', 'Gerber', 'Archive'] as const;
export type DialogFamily = (typeof DIALOG_FAMILIES)[number];

export type ProgressPhase = 'detect' | 'unpack' | 'parse' | 'done';
export interface ParseContext {
  /** Aborted when the import is cancelled; check it between phases of long work. */
  readonly signal: AbortSignal;
  /** This adapter's declared budgets: check them before allocating. */
  readonly limits: ResourceLimits;
  /** Progress inside this adapter's parse, 0..1 (monotonic; values outside the range are clamped). */
  progress(fraction: number): void;
  /**
   * The session key of `kind`. Resolves with the key the user already supplied in this session, otherwise rejects with
   * BoardFormatError KEY_REQUIRED (the UI then asks and re-runs the import). Keys are never stored, logged or reported.
   */
  requestKey(kind: KeyKind): Promise<KeyMaterial>;
}

/**
 * A board reader. `parse` returns the board, or null when the full input turns out not to be this format after all (a
 * POSSIBLE or LIKELY sniff); a recognized but malformed file throws BoardFormatError (GenCAD: GenCadParseError).
 * It may be synchronous (all built-in readers are) or return a promise; `parseBoard` needs a synchronous result.
 */
export interface BoardAdapter {
  readonly apiVersion: typeof ADAPTER_API_VERSION;
  readonly kind: 'board';
  /** Stable id: the capability id, used in the support table, diagnostics and corpus manifests. */
  readonly id: string;
  readonly name: string;
  readonly extensions: readonly string[];
  /** Position in the support table, the extension lists and the dialog families; never affects detection. */
  readonly listOrder: number;
  readonly family: DialogFamily;
  readonly detection: Detection;
  readonly capability: Readonly<FormatCapability>;
  readonly evidence?: RealFileEvidence;
  readonly limits: ResourceLimits;
  readonly companions?: CompanionRule;
  /** Key kinds this reader may need (the content, not the extension, decides whether it does). */
  readonly keys?: readonly KeyKind[];
  /**
   * Optional hook that lets the content-free format diagnostic report describe the layout of this format's files (structure-hook.ts,
   * docs/ADAPTERS.md). An adapter without one is reported with its detection and result facts only.
   */
  readonly structure?: StructureHook;
  /** Bounded and total: looks only at `input.head`, the name and the size; never throws, never allocates in proportion to the file. */
  sniff(input: SniffInput): SniffResult;
  parse(input: ParseInput, context: ParseContext): Board | null | Promise<Board | null>;
}

export interface ContainerCapability {
  id: string;
  name: string;
  extensions: string[];
  variants: string[];
  status: SupportStatus;
  validation: Validation;
  notes: string[];
}
/** One member of an opened container: a normalized relative path ('/'-separated) and a way to read its bytes. */
export interface ContainerEntry {
  readonly path: string;
  /** Declared uncompressed size. */
  readonly size: number;
  /** Set for members that are never offered as a board or a companion (unsafe names, folders, operating-system metadata). */
  readonly skipped?: string;
  /** At most `limit` bytes of the head (bounded inflate), for sniffing. */
  head(limit: number): Uint8Array;
  /** The whole entry; throws BoardFormatError LIMIT_EXCEEDED past `budget` bytes. */
  read(budget: number): Uint8Array;
}
export interface ContainerLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  /** Uncompressed bytes of the board plus its companions, together. */
  readonly maxExtractedBytes: number;
  /** Declared uncompressed / compressed size, for entries above 1 MiB. */
  readonly maxRatio: number;
  /** Entries with a board extension that are sniffed; more means the archive is a collection, not one board. */
  readonly maxCandidates: number;
}
/**
 * A container (ZIP) holding one board and its companions. A board format that is itself an archive (a project or job
 * archive) is a board adapter whose sniff outranks the container's. Containers are opened once: an archive inside an
 * archive is never opened.
 */
export interface ContainerAdapter {
  readonly apiVersion: typeof ADAPTER_API_VERSION;
  readonly kind: 'container';
  readonly id: string;
  readonly name: string;
  readonly extensions: readonly string[];
  readonly listOrder: number;
  readonly family: DialogFamily;
  readonly detection: Detection;
  readonly capability: Readonly<ContainerCapability>;
  readonly limits: ContainerLimits;
  sniff(input: SniffInput): SniffResult;
  /** Lists the members (bounded; nothing is inflated yet). Throws BoardFormatError for damaged or unsupported archives. */
  open(data: Uint8Array, name: string): ContainerEntry[];
}
export type FormatAdapter = BoardAdapter | ContainerAdapter;

type BoardAdapterSpec = Omit<BoardAdapter, 'apiVersion' | 'kind' | 'id' | 'name' | 'extensions' | 'limits'> & { limits?: Partial<ResourceLimits> };
type ContainerAdapterSpec = Omit<ContainerAdapter, 'apiVersion' | 'kind' | 'id' | 'name' | 'extensions'>;

const freezeCapability = <T extends { extensions: string[]; variants: string[]; notes: string[] }>(capability: T): Readonly<T> =>
  Object.freeze({ ...capability, extensions: Object.freeze([...capability.extensions]) as string[], variants: Object.freeze([...capability.variants]) as string[], notes: Object.freeze([...capability.notes]) as string[] });

/** The one way to declare a board adapter: identity, name and extensions come from the capability record. */
export function defineBoardAdapter(spec: BoardAdapterSpec): BoardAdapter {
  const capability = freezeCapability(spec.capability);
  return Object.freeze({
    ...spec, apiVersion: ADAPTER_API_VERSION, kind: 'board' as const, id: capability.id, name: capability.name, extensions: capability.extensions,
    capability, limits: Object.freeze({ ...DEFAULT_LIMITS, ...spec.limits }), ...(spec.keys ? { keys: Object.freeze([...spec.keys]) } : {}),
  });
}
/** The one way to declare a container adapter. */
export function defineContainerAdapter(spec: ContainerAdapterSpec): ContainerAdapter {
  const capability = freezeCapability(spec.capability);
  return Object.freeze({ ...spec, apiVersion: ADAPTER_API_VERSION, kind: 'container' as const, id: capability.id, name: capability.name, extensions: capability.extensions, capability, limits: Object.freeze({ ...spec.limits }) });
}
