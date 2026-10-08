/*
 * Public face of the board formats. Readers live in adapter folders (adapters/<id>/index.ts, interface in adapter.ts),
 * the registry (registry.ts) derives every format table from them, and the dispatcher (dispatch.ts) picks a reader by
 * sniff confidence. docs/ADAPTERS.md explains how to add one.
 */
import type { Board } from '../types';
import type { BoardAdapter } from './adapter';
import { BoardFormatError, type BoardParser, type ParseInput } from './common';
import { contextFor } from './dispatch';
import { BOARD_ADAPTERS } from './registry';

export { BoardFormatError } from './common';
export type { FormatErrorCode, ParseInput, ParseOptions } from './common';
export { CERTAIN, LIKELY, POSSIBLE, SNIFF_BYTES, STATUS_VALIDATION } from './adapter';
export type { BoardAdapter, ContainerAdapter, ContainerCapability, FormatAdapter, FormatCapability, ParseContext, RealFileEvidence, ResourceLimits, SniffInput, SniffResult, SupportStatus, Validation } from './adapter';
export { BOARD_ADAPTERS, BOARD_EVIDENCE, CONTAINER_ADAPTERS, CONTAINER_CAPABILITIES, FORMAT_CAPABILITIES, SUPPORTED_EXTENSIONS, buildFormatsManifest, companionNames } from './registry';
export { detectFormat, parseBoard, parseBoardAsync, parseBoardDetailed, rankAdapters, sniffBoard, type BoardImport, type BoardSniff, type Candidate, type DispatchOptions, type SniffCandidate } from './dispatch';

/** One adapter on its own, synchronously (tests and tools); the dispatcher's ranking and budgets are not applied. */
export function parseWith(adapter: BoardAdapter, input: ParseInput): Board | null {
  const result = adapter.parse(input, contextFor(adapter, input));
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result).catch(() => {});
    throw new BoardFormatError(`${adapter.id}: this reader is asynchronous.`, 'INVALID_FORMAT', adapter.id);
  }
  return result as Board | null;
}

export interface ParserEntry { readonly id: string; readonly parse: BoardParser }
/**
 * The adapter-v1 view of the registry: one synchronous parse per board adapter, in list order, for tools and tests that
 * call every reader on the same bytes. The dispatcher does not use it and its order decides nothing.
 */
export const PARSERS: readonly ParserEntry[] = Object.freeze(BOARD_ADAPTERS.map(adapter => Object.freeze({ id: adapter.id, parse: (input: ParseInput) => parseWith(adapter, input) })));
