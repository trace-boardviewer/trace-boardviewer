import type { DocumentPayload } from '../documents';
import type { FilePayload } from '../types';
import type { BoardSummary, DocumentSummary, DuplicateSet, IndexSummary, LibraryDecision, LibraryErrorCode, LibraryFile, LibraryGroup, LibraryRevision, LibrarySettings, RegisteredRoot, RootOptions, RootSummary, ScanProgress } from './model';
import type { QueryRequest, QueryTerm } from './query';
export const LIBRARY_PROTOCOL_VERSION = 1 as const;
export interface LibraryOperations {
  roots: { args: Record<string, never>; result: RootSummary[] };
  'add-root': { args: { label?: string }; result: RootSummary | null };
  'remove-root': { args: { rootId: string; forgetCorrections: boolean }; result: null };
  'root-options': { args: { rootId: string; options: RootOptions }; result: null };
  scan: { args: { rootId?: string; mode: 'changes' | 'full' }; result: null };
  pause: { args: Record<string, never>; result: ScanProgress };
  resume: { args: Record<string, never>; result: ScanProgress };
  stop: { args: Record<string, never>; result: ScanProgress };
  status: { args: Record<string, never>; result: ScanProgress };
  settings: { args: { settings: LibrarySettings }; result: null };
  'get-settings': { args: Record<string, never>; result: LibrarySettings };
  query: { args: QueryRequest; result: QueryPage };
  group: { args: { id: string }; result: GroupDetail | null };
  file: { args: { id: string }; result: LibraryFile | null };
  similar: { args: { id: string; basis: 'layout' | 'parts' }; result: SimilarGroup[] };
  decide: { args: { decision: LibraryDecision }; result: null };
  open: { args: { fileId: string; select?: { ref: string } }; result: FilePayload };
  attach: { args: { fileIds: string[] }; result: DocumentPayload[] };
  reveal: { args: { fileId: string }; result: null };
  ocr: { args: { contentId: string; pages: 'triage' | 'all' }; result: null };
  'delete-index': { args: { keepCorrections: boolean; keepRoots: boolean }; result: null };
}
export type LibraryOperation = keyof LibraryOperations;
export type LibraryRequest = { [K in LibraryOperation]: { version: 1; requestId: string; operation: K; args: LibraryOperations[K]['args'] } }[LibraryOperation];
export type LibraryResponse = { [K in LibraryOperation]: { version: 1; requestId: string; operation: K; ok: true; result: LibraryOperations[K]['result'] } }[LibraryOperation] | { version: 1; requestId: string; operation: LibraryOperation; ok: false; error: LibraryErrorCode };
export interface SearchMatch { term: QueryTerm; tier: 'exact' | 'base' | 'prefix' | 'family' | 'text'; contentId: string; source: string; refs: string[]; pages: number[] }
export interface QueryRow { id: string; label: string; kind: 'group' | 'file' | 'duplicate'; fileCount: number; matches: SearchMatch[]; rootLabel?: string; relativePath?: string }
export interface QueryPage { rows: QueryRow[]; total: number; cursor?: string; facets: { kinds: { value: string; count: number }[]; roles: { value: string; count: number }[]; formats: { value: string; count: number }[]; roots: { value: string; count: number }[] } }
export interface GroupDetail { group: LibraryGroup; files: LibraryFile[]; revisions: LibraryRevision[]; duplicates: DuplicateSet[]; boards: BoardSummary[]; documents: DocumentSummary[] }
export interface SimilarGroup { groupId: string; score: number; basis: 'layout' | 'parts' }
export type LibraryEvent = { version: 1; type: 'progress'; progress: ScanProgress } | { version: 1; type: 'changed'; generation: number; groupIds: string[] } | { version: 1; type: 'error'; error: LibraryErrorCode; rootId?: string };
/** Bridge wrapper assigns request IDs; progress/change listeners return an unsubscribe function. */
export interface LibraryApi { invoke<K extends LibraryOperation>(operation: K, args: LibraryOperations[K]['args']): Promise<LibraryOperations[K]['result']>; subscribe(listener: (event: LibraryEvent) => void): () => void }
/** Only the main-owned port can send registered paths. UI requests go through LibraryRequest. */
export type MainToService = { version: 1; type: 'configure'; roots: RegisteredRoot[]; settings: LibrarySettings; generation: number } | { version: 1; type: 'request'; request: LibraryRequest } | { version: 1; type: 'shutdown'; requestId: string };
export type ServiceToMain = { version: 1; type: 'response'; response: LibraryResponse } | { version: 1; type: 'event'; event: LibraryEvent } | { version: 1; type: 'checkpointed'; requestId: string };
export interface IndexJob { version: 1; type: 'job'; jobId: string; contentId: string; generation: number; extractorVersion: number; kind: 'board' | 'schematic' | 'pdf' | 'image'; format: string; name: string; bytes: Uint8Array; companions?: { name: string; bytes: Uint8Array }[]; options: { fullText: boolean; ocr: 'off' | 'triage' | 'all' } }
export type ServiceToIndexer = IndexJob | { version: 1; type: 'cancel'; jobId: string; generation: number };
/** Service must correlate jobId/contentId/generation/version to an outstanding job before accepting any result. */
export type IndexerToService = { version: 1; type: 'progress'; jobId: string; generation: number; fraction: number } | { version: 1; type: 'result'; jobId: string; contentId: string; generation: number; extractorVersion: number; summary: IndexSummary } | { version: 1; type: 'error'; jobId: string; generation: number; error: LibraryErrorCode };
