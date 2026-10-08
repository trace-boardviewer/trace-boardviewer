/*
 * Detection facts of the diagnostic report (original TRACE module, MIT): the candidates of the dispatcher (src/lib/formats/dispatch.ts)
 * are tried in its order - strongest sniff first - and each is recorded as declined, claimed or failed, with the failure's code and
 * pipeline stage and never its message (messages echo content such as "duplicate REFDES U12"). The first candidate that does not decline
 * is the one the real dispatcher would use; the candidates behind it were never reached ('skipped').
 */
import type { BoardAdapter, ContainerAdapter } from '../formats/adapter';
import { CERTAIN, LIKELY } from '../formats/adapter';
import { GenCadParseError } from '../gencad';
import { BoardFormatError, TextDecodeError, type ParseInput } from '../formats/common';
import { contextFor, parseBoardAsync, type Candidate } from '../formats/dispatch';
import { trackBuildStageAsync } from '../formats/stage';
import { withParseProgress } from '../parse-progress';
import type { Board } from '../types';
import { ERROR_CODES, FORMAT_IDS, type DetectionEntry, type ErrorCode, type FormatId, type SniffTier, type Stage } from './report';

export const tierOf = (confidence: number): SniffTier => (confidence >= CERTAIN ? 'certain' : confidence >= LIKELY ? 'likely' : confidence > 0 ? 'possible' : 'none');
/** The schema id of an adapter; an adapter whose id the schema does not list yet is reported as 'other'. */
export const formatIdOf = (id: string): FormatId => ((FORMAT_IDS as readonly string[]).includes(id) ? id as FormatId : 'other');

const GENCAD_HEADER_KEYS = new Set([
  'parse.error.binary', 'parse.error.empty', 'parse.error.requiresGencad14', 'parse.error.unitsMissing', 'parse.error.unsupportedUnit',
  'parse.error.userUnitDivisor', 'parse.error.badSectionMarker', 'parse.error.missingSection', 'parse.error.missingSectionEnd', 'parse.error.duplicateSection',
  'parse.error.mismatchedSectionEnd', 'parse.error.dataOutsideSection',
]);
const GENCAD_BUILD_KEYS = new Set(['parse.error.noComponents', 'parse.error.noPins', 'parse.error.coordinateRange', 'parse.error.coordinateRangeMm', 'parse.error.sizeRangeMm']);
const GENCAD_LIMIT_KEYS = new Set(['parse.error.tooLarge', 'parse.error.tooManyRecords']);
/** GenCAD keeps structured catalog issues; their keys (not their parameters, which may hold content) give code and stage. */
function gencadFailure(error: GenCadParseError): { code: ErrorCode; stage: Stage } {
  const key = error.issue.key;
  if (GENCAD_LIMIT_KEYS.has(key)) return { code: 'LIMIT_EXCEEDED', stage: 'records' };
  if (key === 'parse.error.requiresGencad14') return { code: 'UNSUPPORTED_VARIANT', stage: 'header' };
  if (GENCAD_HEADER_KEYS.has(key)) return { code: 'INVALID_FORMAT', stage: 'header' };
  if (GENCAD_BUILD_KEYS.has(key)) return { code: 'INVALID_FORMAT', stage: 'build' };
  return { code: 'INVALID_FORMAT', stage: 'records' };
}

export interface CandidateRun {
  entry: DetectionEntry;
  adapter: BoardAdapter | ContainerAdapter;
  /** The board of a claiming candidate (only the selected candidate's board is used for result facts). */
  board?: Board;
  /** Wall time of this candidate's run in milliseconds. */
  ms: number;
  /** For failures without a stage of their own: the stage still has to come from the structure hook (records vs header). */
  needsHookStage: boolean;
}
export interface RunOptions {
  now(): number;
  signal?: AbortSignal;
  /** Fraction 0..1 of the candidate's own work. */
  progress(fraction: number): void;
  boards: readonly BoardAdapter[];
}

const isAbort = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
function overBudget(adapter: BoardAdapter, input: ParseInput): boolean {
  let total = input.data.length;
  for (const bytes of Object.values(input.companions ?? {})) total += bytes.length;
  return input.data.length > adapter.limits.maxInputBytes || total > adapter.limits.maxTotalBytes;
}

/** Runs one candidate on the input as the dispatcher would; never throws for file content (an abort is rethrown). */
export async function runCandidate(candidate: Candidate, input: ParseInput, options: RunOptions): Promise<CandidateRun> {
  const adapter = candidate.adapter, id = formatIdOf(adapter.id), sniff = tierOf(candidate.confidence);
  const base = { id, sniff, code: null, stage: null, format: null, keyKind: null } satisfies Omit<DetectionEntry, 'result'>;
  const started = options.now();
  const done = (entry: DetectionEntry, extra: Partial<CandidateRun> = {}): CandidateRun => ({ entry, adapter, ms: Math.max(0, options.now() - started), needsHookStage: false, ...extra });
  const isContainer = adapter.kind === 'container';
  if (adapter.kind === 'board' && overBudget(adapter, input)) return done({ ...base, result: 'error', code: 'LIMIT_EXCEEDED', stage: 'header', format: id });
  let inner: FormatId | null = null;
  const run = await trackBuildStageAsync<Board | null>(() => {
    if (adapter.kind === 'container') {
      return parseBoardAsync(input, { adapters: options.boards, containers: [adapter], ...(options.signal ? { signal: options.signal } : {}) })
        .then(imported => { inner = formatIdOf(imported.adapter); return imported.board; });
    }
    const context = contextFor(adapter, input, options.signal, options.progress);
    return withParseProgress(options.progress, () => adapter.parse(input, context));
  });
  if (!run.failed) {
    const board = run.value ?? null;
    if (!board) return done({ ...base, result: 'declined' });
    if (adapter.kind === 'board' && (board.components.length > adapter.limits.maxComponents || board.pins.length > adapter.limits.maxPins)) {
      return done({ ...base, result: 'error', code: 'LIMIT_EXCEEDED', stage: 'build', format: id });
    }
    return done({ ...base, result: 'claimed', format: isContainer ? inner : id }, { board });
  }
  const error = run.error;
  if (isAbort(error)) throw error;
  if (error instanceof TextDecodeError) return done({ ...base, result: 'declined' });
  if (error instanceof GenCadParseError) {
    const { code, stage } = gencadFailure(error);
    return done({ ...base, result: 'error', code, stage, format: 'gencad' });
  }
  const format = isContainer ? null : id;
  if (error instanceof BoardFormatError) {
    const code: ErrorCode = (ERROR_CODES as readonly string[]).includes(error.code) ? error.code as ErrorCode : 'INVALID_FORMAT';
    const keyKind = error.keyKind === 'fz' || error.keyKind === 'xzz' ? error.keyKind : null;
    if (isContainer) return done({ ...base, result: 'error', code, stage: 'container', format, keyKind });
    if (run.built) return done({ ...base, result: 'error', code, stage: 'build', format, keyKind });
    const fixed: Stage | null = code === 'KEY_REQUIRED' || code === 'INVALID_KEY' ? 'decrypt' : code === 'COMPANIONS_REQUIRED' ? 'container' : null;
    if (fixed) return done({ ...base, result: 'error', code, stage: fixed, format, keyKind });
    // UNSUPPORTED_VARIANT, WRONG_KIND and a malformed file are decided from the header, the container listing or the records; the hook tells which.
    return done({ ...base, result: 'error', code, stage: null, format, keyKind }, { needsHookStage: true });
  }
  return done({ ...base, result: 'error', code: 'INTERNAL', stage: run.built ? 'build' : null, format }, { needsHookStage: !run.built });
}
