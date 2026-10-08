/*
 * Ground truth of a synthetic library: what every file is, which board family and revision it belongs to, which files are
 * duplicates, which files an automatic grouping may join with strong evidence, and the part numbers per board. The generator writes
 * it as JSON next to the library; the metrics runner (metrics.ts) and the future grouping tests read it.
 *
 * Vocabulary follows the contract (src/lib/library/model.ts): `kind` and `format` are what a perfect sniffer says about the file's CONTENT, `role`
 * is what the file is for a board, `joinStrength` is what a precision-first grouper is expected to do:
 *   strong  the file belongs to a strong component of its family: a set of at least two distinct contents connected by strong evidence (the
 *           same board number in a header or title block, an equal fingerprint, document coverage of at least 0.8 with at most
 *           0.15 document-only references, a structured schematic link, or byte-identical copies). An automatic group is expected
 *           to contain every file of the component (a family can have several components that only weak evidence connects);
 *   weak    only weak evidence (a board number or model in a file or folder name, a manual that mentions the number, a file in the
 *           folder of the family): at most a suggestion is expected;
 *   none    nothing a program can know (an opaque name in an opaque folder, a scan without a text layer, encrypted content).
 */

import type { FileRole, LibraryErrorCode, LibraryKind } from '../model.ts';
import { FILE_ROLES, LIBRARY_ERRORS, LIBRARY_KINDS } from '../model.ts';

export const GROUND_TRUTH_SCHEMA_VERSION = 1;
/** Changes whenever the generator would write other bytes for the same options (word lists, builders, layouts). */
export const GENERATOR_VERSION = 1;

/** The kinds and roles are the Library contract's own (model.ts), so a truth can never name a kind the Library does not have. */
export const KINDS = LIBRARY_KINDS;
export type { LibraryKind };
export const ROLES = FILE_ROLES;
export type Role = FileRole;
/** The closed error codes of the contract (model.ts LIBRARY_ERRORS) a scan reports for a file it cannot use. */
export const PROBLEM_CODES = LIBRARY_ERRORS;
export type ProblemCode = LibraryErrorCode;
export const STRENGTHS = ['strong', 'weak', 'none'] as const;
export type JoinStrength = (typeof STRENGTHS)[number];
export const FLAGS = [
  'copy', 'renamed-copy', 'wrong-extension', 'truncated', 'empty', 'encrypted', 'password-protected', 'scanned', 'resaved', 'signature-only',
  'zip-bomb', 'zip-slip', 'nested-archive', 'encrypted-entry', 'excluded-folder', 'hidden-file', 'long-name', 'deep-path', 'unicode-name', 'bidi-name',
  'upper-case-extension', 'no-extension', 'in-archive', 'junk', 'macos-junk',
] as const;
export type ItemFlag = (typeof FLAGS)[number];
export const EVIDENCE = [
  'header-id', 'title-id', 'fingerprint', 'coverage', 'structured-link', 'duplicate-content',
  'name-id', 'name-model', 'folder-id', 'folder-model', 'proximity', 'prose-mention', 'bom-title', 'partial-coverage', 'revision-fingerprint',
] as const;
export type Evidence = (typeof EVIDENCE)[number];
export const DEVICE_TYPE_IDS = ['laptop', 'phone', 'tablet', 'console', 'graphics', 'monitor', 'desktop', 'mainboard'] as const;
export const NEEDS_KEY = ['fz', 'xzz'] as const;

export interface TruthPartNumber { exact: string; base: string; refs: string[] }
export interface TruthRevision {
  revision: string;
  /** 1 for the oldest. */
  order: number;
  parts: number;
  /** Number of distinct (reference, pin) pairs of the canonical board. */
  pins: number;
  changedParts: number;
  renamedNets: number;
  /** Jaccard similarity of the (reference, pin) sets with the previous revision; null for the first. */
  jaccardToPrevious: number | null;
  partNumbers: TruthPartNumber[];
}
export interface TruthFamily {
  id: string;
  vendor: string;
  model: string;
  deviceType: string;
  boardNumber: string;
  boardNumberShape: string;
  /** Second number that documents carry (the 051-style schematic number), if the shape has one. */
  schematicNumber?: string;
  revisionScheme: string;
  /** Another family this one was derived from: a different board with a similar part list and, often, a similar name. */
  siblingOf?: string;
  /** Similarity of the (reference, pin) sets of the sibling's first board and the original's last revision (below 0.75 by construction). */
  siblingJaccard?: number;
  /** Name of the layout style of the collection the family lives in. */
  layout: string;
  revisions: TruthRevision[];
}
export interface TruthItem {
  /** The path for a file on disk, "<archive path>!/<entry>" for an archive member. */
  id: string;
  /** Path relative to the library root, forward slashes; for a member the path of the archive. */
  path: string;
  container?: { archive: string; entry: string };
  size: number;
  /** Null when it is not computed (a bomb entry). */
  sha256: string | null;
  kind: LibraryKind;
  format: string | null;
  variant?: string;
  role: Role;
  familyId: string | null;
  revision: string | null;
  duplicateSet: string | null;
  joinStrength: JoinStrength;
  /** Strong component of the family ("F0007.2") the file belongs to; null unless `joinStrength` is strong. */
  component: string | null;
  evidence: Evidence[];
  flags: ItemFlag[];
  /** (reference, pin) fingerprint a reader computes from the file (boards): "fp1:" and 64 hex digits, as src/lib/board-fingerprint.ts. */
  fingerprint?: string;
  pinSetSize?: number;
  /** Part numbers printed in the file, exactly as printed (board values, schematic labels, BOM, datasheet tables). */
  partNumbers?: string[];
  /** Tokens that look like part numbers but are not (net, package, date, sheet, value). */
  decoys?: string[];
  /** Number of reference designators printed (documents) or placed (boards). */
  refCount?: number;
  /** Share of the family board's references that the document prints (documents). */
  coverage?: number;
  pages?: number;
  needsKey?: (typeof NEEDS_KEY)[number];
  /** The closed error code a correct scan reports for the item (the rules of the Library design: encrypted content, damaged or unsafe entries, archives inside archives, unsupported archive formats). Absent when the file is fine. */
  problem?: ProblemCode;
  /** Declared uncompressed size of an archive member that is not computed (bombs). */
  declaredSize?: number;
  mtimeMs?: number;
}
export interface TruthGroup {
  id: string;
  familyId: string;
  label: string;
  boardNumber: string;
  members: Array<{ item: string; strength: JoinStrength; component: string | null }>;
}
export interface TruthDuplicateSet {
  id: string;
  /** identical: the same bytes; resaved: other bytes, the same text per page. */
  kind: 'identical' | 'resaved';
  members: string[];
}
export interface GroundTruth {
  schemaVersion: number;
  generator: { name: string; version: number };
  options: { files: number; bytes: number; seed: string; preset: string | null };
  totals: { files: number; members: number; bytes: number; families: number; groups: number };
  families: TruthFamily[];
  items: TruthItem[];
  groups: TruthGroup[];
  duplicateSets: TruthDuplicateSet[];
  /** Exact part number to the families whose boards carry it. */
  partIndex: Record<string, string[]>;
}

// ---- JSON schema -----------------------------------------------------------------------------------------------------------

const str = { type: 'string' } as const;
const nullable = (inner: Record<string, unknown>) => ({ anyOf: [inner, { type: 'null' }] });
const strings = { type: 'array', items: str } as const;
const enumOf = (values: readonly string[]) => ({ type: 'string', enum: [...values] });

/** JSON Schema (draft 2020-12, the subset json-schema.ts understands) of a ground-truth file. */
export const GROUND_TRUTH_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Synthetic library ground truth',
  description: 'What every file of a generated library is, and what a grouping of it is expected to do. Written by scripts/gen-synthetic-library.cjs.',
  type: 'object',
  required: ['schemaVersion', 'generator', 'options', 'totals', 'families', 'items', 'groups', 'duplicateSets', 'partIndex'],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: GROUND_TRUTH_SCHEMA_VERSION },
    generator: { type: 'object', required: ['name', 'version'], additionalProperties: false, properties: { name: str, version: { type: 'integer', minimum: 1 } } },
    options: { type: 'object', required: ['files', 'bytes', 'seed', 'preset'], additionalProperties: false, properties: { files: { type: 'integer', minimum: 1 }, bytes: { type: 'integer', minimum: 1 }, seed: str, preset: nullable(str) } },
    totals: { type: 'object', required: ['files', 'members', 'bytes', 'families', 'groups'], additionalProperties: false, properties: { files: { type: 'integer', minimum: 0 }, members: { type: 'integer', minimum: 0 }, bytes: { type: 'integer', minimum: 0 }, families: { type: 'integer', minimum: 0 }, groups: { type: 'integer', minimum: 0 } } },
    families: { type: 'array', items: { $ref: '#/$defs/family' } },
    items: { type: 'array', items: { $ref: '#/$defs/item' } },
    groups: { type: 'array', items: { $ref: '#/$defs/group' } },
    duplicateSets: { type: 'array', items: { $ref: '#/$defs/duplicateSet' } },
    partIndex: { type: 'object', additionalProperties: strings },
  },
  $defs: {
    partNumber: { type: 'object', required: ['exact', 'base', 'refs'], additionalProperties: false, properties: { exact: str, base: str, refs: strings } },
    revision: {
      type: 'object', required: ['revision', 'order', 'parts', 'pins', 'changedParts', 'renamedNets', 'jaccardToPrevious', 'partNumbers'], additionalProperties: false,
      properties: {
        revision: str, order: { type: 'integer', minimum: 1 }, parts: { type: 'integer', minimum: 0 }, pins: { type: 'integer', minimum: 0 }, changedParts: { type: 'integer', minimum: 0 }, renamedNets: { type: 'integer', minimum: 0 },
        jaccardToPrevious: nullable({ type: 'number', minimum: 0, maximum: 1 }), partNumbers: { type: 'array', items: { $ref: '#/$defs/partNumber' } },
      },
    },
    family: {
      type: 'object', required: ['id', 'vendor', 'model', 'deviceType', 'boardNumber', 'boardNumberShape', 'revisionScheme', 'layout', 'revisions'], additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^F[0-9]{4,}$' }, vendor: str, model: str, deviceType: enumOf(DEVICE_TYPE_IDS), boardNumber: str, boardNumberShape: str, schematicNumber: str, revisionScheme: str,
        siblingOf: { type: 'string', pattern: '^F[0-9]{4,}$' }, siblingJaccard: { type: 'number', minimum: 0, maximum: 1 }, layout: str, revisions: { type: 'array', minItems: 1, items: { $ref: '#/$defs/revision' } },
      },
    },
    item: {
      type: 'object', required: ['id', 'path', 'size', 'sha256', 'kind', 'format', 'role', 'familyId', 'revision', 'duplicateSet', 'joinStrength', 'component', 'evidence', 'flags'], additionalProperties: false,
      properties: {
        id: str, path: str, container: { type: 'object', required: ['archive', 'entry'], additionalProperties: false, properties: { archive: str, entry: str } },
        size: { type: 'integer', minimum: 0 }, sha256: nullable({ type: 'string', pattern: '^[0-9a-f]{64}$' }), kind: enumOf(KINDS), format: nullable(str), variant: str, role: enumOf(ROLES),
        familyId: nullable({ type: 'string', pattern: '^F[0-9]{4,}$' }), revision: nullable(str), duplicateSet: nullable({ type: 'string', pattern: '^D[0-9]{4,}$' }),
        joinStrength: enumOf(STRENGTHS), component: nullable({ type: 'string', pattern: '^F[0-9]{4,}\\.[0-9]+$' }), evidence: { type: 'array', items: enumOf(EVIDENCE) }, flags: { type: 'array', items: enumOf(FLAGS) },
        fingerprint: { type: 'string', pattern: '^fp1:[0-9a-f]{64}$' }, pinSetSize: { type: 'integer', minimum: 0 }, partNumbers: strings, decoys: strings, refCount: { type: 'integer', minimum: 0 },
        coverage: { type: 'number', minimum: 0, maximum: 1 }, pages: { type: 'integer', minimum: 1 }, needsKey: enumOf(NEEDS_KEY), problem: enumOf(PROBLEM_CODES), declaredSize: { type: 'integer', minimum: 0 }, mtimeMs: { type: 'integer', minimum: 0 },
      },
    },
    group: {
      type: 'object', required: ['id', 'familyId', 'label', 'boardNumber', 'members'], additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^G[0-9]{4,}$' }, familyId: { type: 'string', pattern: '^F[0-9]{4,}$' }, label: str, boardNumber: str,
        members: { type: 'array', items: { type: 'object', required: ['item', 'strength', 'component'], additionalProperties: false, properties: { item: str, strength: enumOf(['strong', 'weak']), component: nullable({ type: 'string', pattern: '^F[0-9]{4,}\\.[0-9]+$' }) } } },
      },
    },
    duplicateSet: { type: 'object', required: ['id', 'kind', 'members'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^D[0-9]{4,}$' }, kind: enumOf(['identical', 'resaved']), members: { type: 'array', minItems: 2, items: str } } },
  },
} as const;
