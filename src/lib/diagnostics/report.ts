/*
 * Types of the content-free format diagnostic report, trace-format-diagnostic/1 (original TRACE module, MIT).
 *
 * The whitelist itself is electron/diagnostic-schema.json: closed objects, closed enumerations, ranges and rounding rules,
 * checked by the one validator in electron/diagnostics.cjs (the main process runs it before anything is saved). The types below
 * mirror it for the collector; src/lib/diagnostics/schema.test.ts fails when the literal lists here drift from the schema.
 */
import schema from '../../../electron/diagnostic-schema.json';
import { canonicalReport } from './canonical';

export const SCHEMA_ID = 'trace-format-diagnostic/1';
export const REDACTION_VERSION = 1;

export const STAGES = ['header', 'container', 'decrypt', 'decompress', 'records', 'build'] as const;
export type Stage = (typeof STAGES)[number];
export const ERROR_CODES = ['INVALID_FORMAT', 'UNRECOGNIZED', 'LIMIT_EXCEEDED', 'KEY_REQUIRED', 'INVALID_KEY', 'COMPANIONS_REQUIRED', 'UNSUPPORTED_VARIANT', 'WRONG_KIND', 'AMBIGUOUS_FORMAT', 'INTERNAL'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
/** The ids of the registered adapters (src/lib/formats/adapters/<id>) plus 'other' for an adapter whose id is not whitelisted yet. */
export const FORMAT_IDS = [
  'allegro-brd', 'altium', 'asc', 'bdv', 'brd', 'brd2', 'brd-v1', 'bv', 'bv2', 'bvr', 'bvr1', 'cst', 'eagle', 'easyeda-pro', 'easyeda-std', 'fabmaster', 'farc', 'fz', 'gencad', 'gerber', 'hyperlynx', 'ipc2581', 'ipc356',
  'kicad', 'mentor-neutral', 'odbpp', 'pads-binary', 'pinlist', 'samsung-cad', 'tebo-ict', 'tvw', 'unisoft-f2b', 'vs2', 'xzz', 'zip', 'other',
] as const;
export type FormatId = (typeof FORMAT_IDS)[number];
export const SNIFF_TIERS = ['none', 'possible', 'likely', 'certain'] as const;
export type SniffTier = (typeof SNIFF_TIERS)[number];
export const HOOK_IDS = ['gencad', 'brd', 'bdv', 'bvr', 'asc', 'fz', 'xzz', 'cst', 'kicad', 'eagle', 'altium', 'samsung-cad', 'allegro-brd', 'farc', 'bv', 'unisoft-f2b', 'pads-binary', 'brd-v1', 'generic-text', 'generic-binary'] as const;
export type HookId = (typeof HOOK_IDS)[number];
export const VARIANTS = [
  'gencad-1.4', 'gencad-other', 'kicad-footprint', 'kicad-module', 'eagle-board', 'eagle-schematic', 'eagle-library', 'altium-cfb', 'altium-cfb-v4', 'altium-ascii',
  'altium-schematic', 'xzz-plain', 'xzz-xor', 'cst-int16', 'samsung-cad', 'bdv-plain', 'bdv-encoded', 'bvr1', 'bvr3', 'bvr-other', 'brd-landrex', 'brd-landrex-encoded',
  'brd2', 'asc-trio', 'fz-text', 'fz-zlib', 'fz-rc6', 'cae-text', 'cae-zlib', 'cae-rc6', 'farc-ascii', 'farc-faz', 'bv-jet3', 'bv-jet4', 'pads-sdb-2026', 'pads-sdb-2027', 'brd-v1-opaque',
] as const;
export type Variant = (typeof VARIANTS)[number];
export const UNIT_KINDS = ['mm', 'inch', 'mil', 'thou', 'user', 'mil/10000', 'per-value', 'unknown'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];
export const HEADER_CODES = ['version', 'unitCode', 'cfbMajorVersion', 'cfbSectorShift', 'obfuscated', 'encrypted', 'containerLayout', 'contentLog2', 'descriptionLog2', 'declaredWidthLog2', 'declaredHeightLog2'] as const;
export type HeaderCode = (typeof HEADER_CODES)[number];
export const HEADER_COUNTS = ['declaredOutlinePoints', 'declaredParts', 'declaredPins', 'declaredNets', 'declaredNails', 'blocks', 'netRecords', 'streams', 'otherStreams', 'sections', 'otherSections', 'companionFiles'] as const;
export type HeaderCount = (typeof HEADER_COUNTS)[number];
export const CONTAINERS = ['none', 'zip', 'gzip', 'tar', 'cfb', 'sqlite', 'jet', 'zlib'] as const;
export type Container = (typeof CONTAINERS)[number];
export const ENCODINGS = ['binary', 'ascii', 'utf8', 'utf8-bom', 'utf16le-bom', 'utf16be-bom', 'windows-1252'] as const;
export type Encoding = (typeof ENCODINGS)[number];
export const LINE_ENDINGS = ['none', 'lf', 'crlf', 'cr', 'mixed', 'n/a'] as const;
export type LineEndings = (typeof LINE_ENDINGS)[number];
export const PITCHES = ['0.4', '0.5', '0.65', '0.8', '1.0', '1.27', '2.54', 'below', 'between', 'above', 'none'] as const;
export type Pitch = (typeof PITCHES)[number];
export type OsFamily = 'win32' | 'darwin' | 'linux' | 'other';
export type PadAngleMode = 'absolute' | 'relative' | 'none';
export type UnitsCandidate = 'x1' | 'x25.4' | 'x0.0254';

/** Open vocabularies of the schema (long lists): read from the schema itself, so they exist in exactly one place. */
export const KEYWORDS: ReadonlySet<string> = new Set(schema.enums.keyword);
export const EXTENSIONS: ReadonlySet<string> = new Set(schema.enums.extension);
export const MAGIC_LABELS: ReadonlySet<string> = new Set(schema.enums.magic);
/** The section name of lines that belong to no section of the format. */
export const NO_SECTION = '(none)';

export interface FieldStats { min: number; median: number; max: number }
export interface SectionFacts {
  name: string;
  records: number;
  /** Level 2 only. */
  distinctShapes?: number;
  /** Level 2 only: collapsed shapes (letters A, digits 9, punctuation kept) of the first 32 lines of the section. */
  shapes?: Array<{ shape: string; count: number }>;
}
export interface BlockFacts {
  tagBits: number;
  tags: Record<string, number>;
  /** Power-of-two buckets of the block lengths (bitLength): key n counts lengths in [2^(n-1), 2^n), key 0 the empty blocks. */
  lengths: Record<string, number>;
  /** Level 2 only: [tag, length] of the first 256 blocks, numbers only. */
  sequence?: Array<[number, number]>;
}
export interface StructureFacts {
  hook: HookId;
  kind: 'text' | 'binary';
  variant: Variant | null;
  headerOk: boolean;
  linesLog2: number | null;
  keywords: Record<string, number>;
  fields: Record<string, FieldStats>;
  numbers: { count: number; magnitude: Record<string, number>; decimals: Record<string, number> } | null;
  sections: SectionFacts[];
  header: { codes: Partial<Record<HeaderCode, number>>; counts: Partial<Record<HeaderCount, number>> };
  blocks: BlockFacts | null;
}
export interface DetectionEntry {
  id: FormatId;
  /** How sure the adapter's sniff was about the head of the file: certain from 90, likely from 50, possible below. */
  sniff: SniffTier;
  /** 'skipped': the dispatcher would not have reached this candidate (a stronger one claimed the file or failed on it). */
  result: 'declined' | 'claimed' | 'error' | 'skipped';
  code: ErrorCode | null;
  stage: Stage | null;
  format: FormatId | null;
  keyKind: 'fz' | 'xzz' | null;
}
export interface ResultFacts {
  parts: number; pins: number; nets: number;
  sides: { top: number; bottom: number; both: number };
  unitKind: UnitKind;
  outline: 'present' | 'estimated' | 'absent';
  pinsWithoutNet: number;
  placeholderNets: number;
  padSizeKnown: number;
}
export interface Interpretation {
  units: UnitsCandidate;
  padAngle: 'absolute' | 'relative' | 'as-read';
  bottom: 'as-read' | 'mirrored';
  asRead: boolean;
  pinsInsideOutline: number | null;
  overlappingPadPairs: number | null;
  medianPitch: Pitch;
}
export interface PlausibilityFacts {
  asReadUnits: UnitsCandidate | 'other' | 'unknown';
  asReadPadAngle: PadAngleMode | 'unknown';
  pinDensityTopBottom: number | null;
  limited: boolean;
  interpretations: Interpretation[];
}
export interface DiagnosticReport {
  schema: typeof SCHEMA_ID;
  app: { version: string; adapterSet: string; os: OsFamily };
  privacy: { redaction: typeof REDACTION_VERSION; level: 1 | 2; reviewedByUser: boolean; dedupe: boolean };
  input: {
    extension: string; sizeLog2: number; companions: { count: number; extensions: string[] }; container: Container; textLike: boolean;
    encoding: Encoding; lineEndings: LineEndings; entropy: number[]; magic: string;
  };
  /** adapters: the candidates whose sniff matched, strongest first (the dispatcher's order). */
  detection: { outcome: 'opened' | 'failed' | 'unrecognized'; selected: FormatId | null; format: FormatId | null; ambiguous: boolean; adapters: DetectionEntry[] };
  structure: StructureFacts | null;
  result: ResultFacts | null;
  plausibility: PlausibilityFacts | null;
  keys: { supplied: boolean; parity: 'valid' | 'invalid' | 'n/a' };
  performance: { parseMs: number; peakHeapLog2: number | null };
  dedupe: string | null;
}

// --- Rounding: every count and ratio of the report goes through one of these ------------------------------------------------------
/** Two significant digits (0 stays 0); the validator rejects any count that is not rounded this way. */
export function roundSig2(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  return Number(value.toPrecision(2));
}
/** A non-negative count rounded to two significant digits. */
export const count2 = (value: number): number => Math.max(0, roundSig2(Math.round(value)));
/** A share between 0 and 1 with two decimals (0 when the denominator is 0). */
export const share = (part: number, whole: number): number => (whole > 0 ? Number(Math.min(1, Math.max(0, part / whole)).toFixed(2)) : 0);
/** Number of bits of a non-negative integer below 2^32: 0 for 0, n for values in [2^(n-1), 2^n). The block-length buckets. */
export const bitLength = (value: number): number => (value >= 1 ? 32 - Math.clz32(Math.min(0xffffffff, Math.floor(value))) : 0);
/** Smallest n with value <= 2^n (0 for 0 and 1): the size buckets. */
export const log2Ceil = (value: number): number => (value > 1 ? bitLength(Math.ceil(value) - 1) : 0);

/**
 * The canonical file text of a report: two-space JSON, a trailing newline. The review dialog shows exactly this text and the main process writes the
 * same text (electron/diagnostics.cjs serializeReport); collect.test.ts proves that both agree for every format.
 */
export const reportText = (report: DiagnosticReport): string => `${JSON.stringify(canonicalReport(report), null, 2)}\n`;
