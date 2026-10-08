/** Local derived-index contracts. IDs are opaque, stable across restarts, and never paths. */
export type LibraryId = string;
export const LIBRARY_SCHEMA_VERSION = 1 as const;
export const LIBRARY_KINDS = ['board', 'board-archive', 'schematic', 'pdf', 'image', 'archive', 'spreadsheet', 'firmware', 'text', 'unknown'] as const;
export type LibraryKind = typeof LIBRARY_KINDS[number];
export const FILE_STATES = ['identified', 'pending', 'indexed', 'unknown', 'unsupported', 'encrypted', 'damaged', 'skipped', 'link', 'no-access', 'locked', 'missing'] as const;
export type FileState = typeof FILE_STATES[number];
export const FILE_ROLES = ['board', 'schematic', 'board-pdf', 'datasheet', 'service-manual', 'bom', 'photo', 'thermal', 'firmware', 'other'] as const;
export type FileRole = typeof FILE_ROLES[number];
export const LIBRARY_STAGES = ['enumerate', 'identity', 'sniff', 'name', 'summary', 'knowledge', 'ocr', 'group', 'full-text'] as const;
export type LibraryStage = typeof LIBRARY_STAGES[number];
export const LIBRARY_ERRORS = ['invalid-request', 'unsupported-version', 'not-found', 'outside-root', 'file-changed', 'root-offline', 'no-access', 'locked', 'unknown-format', 'unsupported-format', 'encrypted', 'too-large', 'timeout', 'reader-crash', 'damaged', 'cancelled', 'nested-archive', 'unsafe-entry', 'storage-full', 'newer-schema', 'internal'] as const;
export type LibraryErrorCode = typeof LIBRARY_ERRORS[number];
export interface RootOptions { fullText: boolean; watch: boolean; exclusions: string[]; rescanMinutes: number }
export const DEFAULT_ROOT_OPTIONS: Readonly<RootOptions> = Object.freeze({ fullText: false, watch: false, exclusions: [], rescanMinutes: 0 });
/** Renderer-safe root; the registered realpath exists only in main and service. */
export interface RootSummary { id: LibraryId; label: string; state: 'online' | 'offline' | 'no-access'; network: boolean; options: RootOptions; fileCount: number }
export interface RegisteredRoot extends RootSummary { realpath: string }
export interface LibrarySettings { version: 1; performance: 'gentle' | 'normal' | 'use-more'; checkAtStartup: boolean; ocrDuringScan: 'off' | 'triage'; ocrOnBattery: boolean }
export const DEFAULT_LIBRARY_SETTINGS: Readonly<LibrarySettings> = Object.freeze({ version: 1, performance: 'normal', checkAtStartup: true, ocrDuringScan: 'triage', ocrOnBattery: false });
export interface FileIdentity { size: number; mtimeMs?: number; fileKey?: string; quickKey?: string; sha256?: string; workspaceKey?: string }
export interface LibraryFile extends FileIdentity { id: LibraryId; rootId: LibraryId; relativePath: string; contentId?: LibraryId; containerId?: LibraryId; entryPath?: string; state: FileState; kind: LibraryKind; format?: string; role: FileRole; problem?: LibraryErrorCode; missingSince?: number; seenScan: LibraryId }
export type MetadataSource = 'folder' | 'name' | 'archive' | 'header' | 'pdf-metadata' | 'outline' | 'title-block' | 'schematic' | 'ocr' | 'user';
export interface Identifier { kind: 'board-number' | 'revision' | 'vendor' | 'model' | 'device-type' | 'title'; raw: string; norm: string; source: MetadataSource; confidence: number; page?: number; pattern?: string }
export interface BoardIdentity { identifiers: Identifier[]; title?: string; revision?: string; drawing?: string; company?: string; date?: string }
export interface LibraryComponent { ref: string; value: string; package?: string; pinCount: number; exact?: string; base?: string; family?: string; category?: string; source: MetadataSource }
export interface PassiveHistogramRow { kind: 'resistor' | 'capacitor' | 'inductor' | 'ferrite'; valueSI?: number; package?: string; count: number }
export interface PartTerm { norm: string; base?: string; family?: string; category?: string; tier: 'known' | 'near-ref' | 'board-confirmed' | 'text'; source: MetadataSource; refs: string[]; additionalRefs: number; pages: number[] }
/** Raw sorted distinct refs, compressed only by the trusted service after validation. No library-wide ref postings. */
export interface SummaryBase { identity: BoardIdentity; refs: string[]; rails: string[]; terms: PartTerm[]; truncated?: ('refs' | 'rails' | 'terms' | 'components' | 'passives' | 'full-text')[] }
export interface BoardSummary extends SummaryBase { kind: 'board'; adapter: string; variant?: string; parts: number; pins: number; nets: number; sides: ('top' | 'bottom' | 'both')[]; widthMm?: number; heightMm?: number; fingerprint: string; fingerprintVersion: number; minhash: number[]; components: LibraryComponent[]; passives: PassiveHistogramRow[] }
export interface DocumentSummary extends SummaryBase { kind: 'document'; format: string; role: FileRole; pages: number; textLayer: 'yes' | 'no' | 'mixed'; ocr: 'none' | 'triage' | 'all'; title?: string; producer?: string; pageHashes: string[]; fullText?: { page: number; body: string }[] }
export interface ImageSummary { kind: 'image'; width: number; height: number }
export type IndexSummary = BoardSummary | DocumentSummary | ImageSummary;
export const EVIDENCE_KINDS = ['fingerprint', 'layout-similar', 'layout-related', 'doc-coverage', 'structured-link', 'id-content', 'id-name', 'proximity', 'conflict', 'user-same', 'user-different'] as const;
export interface GroupEvidence { kind: typeof EVIDENCE_KINDS[number]; a: LibraryId; b: LibraryId; strength: 'strong' | 'suggest' | 'conflict'; score: number; foundRefs?: number; boardRefs?: number; documentOnlyShare?: number; identifiers?: string[]; pages?: number[] }
/** Explanation uses evidence codes and numeric facts; presentation translates codes. */
export interface GroupMember { contentId: LibraryId; role: FileRole; revision?: string; tier: 'automatic' | 'suggested' | 'user'; evidence: GroupEvidence[] }
export interface LibraryGroup { id: LibraryId; label: string; boardNumber?: string; vendor?: string; model?: string; deviceType?: string; updated: number; members: GroupMember[]; tags: string[] }
export interface LibraryRevision { contentId: LibraryId; label: string; scheme: string; order?: number; basis: 'token' | 'layout' | 'user' | 'unknown'; addedParts?: number; removedParts?: number; changedValues?: number }
export interface DuplicateSet { id: LibraryId; kind: 'identical' | 'archive-copy' | 'other-format' | 'resaved-document' | 'name-clash'; fileIds: LibraryId[]; contentIds: LibraryId[]; evidence: GroupEvidence[] }
/** Persist targets by hash/complete-file-set workspace key, or by root + relative location until a hash exists. */
export type DecisionTarget = { kind: 'content'; sha256: string } | { kind: 'file'; rootId: LibraryId; relativePath: string; entryPath?: string };
export type LibraryDecision =
  | { kind: 'merge'; groups: LibraryId[] }
  | { kind: 'split'; groupId: LibraryId; contents: LibraryId[] }
  | { kind: 'same' | 'different'; a: DecisionTarget; b: DecisionTarget }
  | { kind: 'label'; groupId: LibraryId; label: string }
  | { kind: 'role'; target: DecisionTarget; role: FileRole }
  | { kind: 'tag'; groupId: LibraryId; tag: string; enabled: boolean }
  | { kind: 'hide'; target: DecisionTarget; hidden: boolean };
export interface StoredDecision { id: LibraryId; at: number; decision: LibraryDecision; targets: DecisionTarget[] }
export interface ScanProgress { scanId: LibraryId; state: 'idle' | 'running' | 'paused' | 'stopping' | 'complete' | 'failed'; phase: LibraryStage; rootId?: LibraryId; relativeFolder?: string; discovered: number; completed: number; failed: number; pending: number; bytesRead: number; etaSeconds?: { low: number; high: number }; performance: LibrarySettings['performance'] }
export interface StageState { contentId: LibraryId; stage: LibraryStage; version: number; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; at: number; error?: LibraryErrorCode }
