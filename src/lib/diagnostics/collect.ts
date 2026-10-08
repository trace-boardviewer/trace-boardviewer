/*
 * The content-free format diagnostic collector (original TRACE module, MIT). Input: exactly one file plus its companions (the ASC
 * trio), never a folder or a library of files. Output: a trace-format-diagnostic/1 report (electron/diagnostic-schema.json) made of
 * closed enumerations and rounded aggregates only. It follows the dispatcher's own steps in their "collect structure" path: every
 * adapter sniffs the head (detection), the candidates are tried strongest first as the dispatcher does (declined, claimed, error),
 * the structure hook of the adapter the dispatcher would use describes the layout (structure), and the chosen board's aggregates and
 * plausibility metrics follow (result). An adapter without a `structure` hook is reported with its detection and result facts only.
 *
 * Pure apart from the injected clock and heap probe: the same bytes and environment give the same report. collectDiagnostic always
 * builds the fullest report (level 2, with the dedupe code it was given); projectReport derives what the user chose to share.
 */
import { version as APP_VERSION } from '../../../package.json';
import { utf8Input } from '../encoding';
import type { BoardAdapter, ContainerAdapter } from '../formats/adapter';
import { MAX_IMPORT_BYTES, vendorDisconnected, type ParseInput } from '../formats/common';
import { fzKeyParityValid, xzzKeyParityValid } from '../formats/crypto';
import { ambiguousCandidates, rankAdapters, sniffInputOf } from '../formats/dispatch';
import { BOARD_ADAPTERS, CONTAINER_ADAPTERS } from '../formats/registry';
import type { StructureHook } from '../formats/structure-hook';
import type { Board } from '../types';
import { formatIdOf, runCandidate, tierOf, type CandidateRun } from './detect';
import { genericHookFor } from './hooks';
import { extensionClass, inputFacts } from './input-facts';
import { plausibility } from './plausibility';
import {
  count2, HOOK_IDS, log2Ceil, REDACTION_VERSION, SCHEMA_ID, share,
  type DiagnosticReport, type OsFamily, type ResultFacts, type StructureFacts,
} from './report';
import { FactSink, stageFromHook, type StructureInput } from './structure';

export interface DiagnosticInput {
  /** What the parsers need of the name: the extension and, for the ASC trio, the fixed role name. Never reported. */
  name: string;
  data: Uint8Array;
  /** Companion files by lowercase basename (the ASC trio only). */
  companions?: Record<string, Uint8Array>;
  /** Session keys the user typed for this run. Never reported: the report says whether a key was supplied and whether its parity holds. */
  options?: { fzKey?: number[]; xzzKey?: string };
}
export interface DiagnosticEnv {
  os: OsFamily;
  /** The dedupe code the main process computed under the per-install secret (16 hex digits), or null. */
  dedupe?: string | null;
  appVersion?: string;
  now?: () => number;
  /** Used JS heap in bytes, or null when the runtime does not tell. */
  heap?: () => number | null;
  /** Called while the collector works (`fraction` of the whole, 0..1): the worker forwards it to the watchdog as a sign of life. */
  progress?: (fraction: number) => void;
  /** Aborts the collection between steps (the user cancelled, or the watchdog stopped it). */
  signal?: AbortSignal;
  boards?: readonly BoardAdapter[];
  containers?: readonly ContainerAdapter[];
}

const COMPANION_ROLES = new Set(['format.asc', 'pins.asc', 'nails.asc']);
const PLACEHOLDER_NETS = [/^N\/?C(?:$|[_\-\d])/i, /^N\$\d+$/, /^Net-\(/, /^unconnected-\(/, /^\$?NET\d+$/i];
const isPlaceholderNet = (name: string): boolean => vendorDisconnected(name) || PLACEHOLDER_NETS.some(pattern => pattern.test(name));
const baseName = (name: string): string => (name.split(/[\\/]/).pop() ?? '').toLowerCase();

/** FNV-1a over the adapter ids, their hook marks, the hook ids and the schema id: which adapter set produced the report, as 8 hex digits. */
function adapterSet(boards: readonly BoardAdapter[], containers: readonly ContainerAdapter[]): string {
  let hash = 0x811c9dc5;
  const text = `${boards.map(adapter => `${adapter.id}${adapter.structure ? '+' : ''}`).join(',')}|${containers.map(adapter => adapter.id).join(',')}|${HOOK_IDS.join(',')}|${SCHEMA_ID}`;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}

function runHook(hook: StructureHook, input: StructureInput, tick?: () => void): { sink: FactSink; facts: StructureFacts } {
  const sink = new FactSink(hook, 2, tick);
  try { hook.collect(input, sink); } catch { /* a hook that fails reports what it gathered so far */ }
  return { sink, facts: sink.facts(hook.kind, sink.sawLines) };
}

function resultFacts(board: Board, unitKind: ResultFacts['unitKind']): ResultFacts {
  const sides = { top: 0, bottom: 0, both: 0 };
  for (const component of board.components) sides[component.side]++;
  const total = board.components.length;
  return {
    parts: count2(board.components.length), pins: count2(board.pins.length), nets: count2(board.nets.length),
    sides: { top: share(sides.top, total), bottom: share(sides.bottom, total), both: share(sides.both, total) },
    unitKind,
    outline: board.warnings.some(warning => warning.key === 'parse.warning.missingBoardOutline') ? 'estimated' : board.outline.length >= 3 ? 'present' : 'absent',
    pinsWithoutNet: share(board.pins.filter(pin => !pin.net).length, board.pins.length),
    placeholderNets: share(board.nets.filter(net => isPlaceholderNet(net.name)).length, board.nets.length),
    padSizeKnown: share(board.pins.filter(pin => pin.radius > 0 || pin.width !== undefined || pin.height !== undefined).length, board.pins.length),
  };
}

function keyFacts(options: DiagnosticInput['options'], extension: string): DiagnosticReport['keys'] {
  const fz = options?.fzKey, xzz = options?.xzzKey?.trim();
  const checks: boolean[] = [];
  if (fz !== undefined) checks.push(Array.isArray(fz) && fz.length === 44 && fz.every(word => Number.isInteger(word) && word >= 0 && word <= 0xffffffff) && fzKeyParityValid(fz, extension === '.cae' ? 'cae' : 'fz'));
  if (xzz !== undefined && xzz !== '') checks.push(/^(?:0x)?[0-9a-f]{16}$/i.test(xzz) && xzzKeyParityValid(xzz));
  if (!checks.length) return { supplied: false, parity: 'n/a' };
  return { supplied: true, parity: checks.every(Boolean) ? 'valid' : 'invalid' };
}

/**
 * Builds the fullest report of one file plus its companions (level 2; projectReport derives the shared one). Never throws for file
 * content; rejects with an AbortError when `env.signal` aborts, and with a RangeError for an input that is not one file within the limit.
 */
export async function collectDiagnostic(raw: DiagnosticInput, env: DiagnosticEnv): Promise<DiagnosticReport> {
  if (!(raw.data instanceof Uint8Array) || raw.data.length > MAX_IMPORT_BYTES) throw new RangeError('The diagnostic input must be one file of at most 64 MiB.');
  const companions: Record<string, Uint8Array> = {};
  let companionBytes = 0;
  for (const [name, bytes] of Object.entries(raw.companions ?? {})) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('Companion files must be byte arrays.');
    companionBytes += bytes.length;
    companions[baseName(name)] = bytes;
  }
  if (raw.data.length + companionBytes > MAX_IMPORT_BYTES) throw new RangeError('The diagnostic input must be one file of at most 64 MiB.');
  const now = env.now ?? (() => 0), heap = env.heap ?? (() => null);
  const boards = env.boards ?? BOARD_ADAPTERS, containers = env.containers ?? CONTAINER_ADAPTERS;
  let peak = 0, last = 0;
  const probe = () => {
    const used = heap();
    if (used !== null && Number.isFinite(used) && used > peak) peak = used;
  };
  const report = (fraction: number) => {
    last = fraction;
    probe();
    try { env.progress?.(Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))); } catch { /* progress never breaks the collector */ }
  };
  const cancelled = () => {
    if (env.signal?.aborted) throw env.signal.reason instanceof Error && env.signal.reason.name === 'AbortError' ? env.signal.reason : new DOMException('Diagnostic cancelled.', 'AbortError');
  };
  cancelled();
  report(0);
  /** A sign of life during a long synchronous scan: the same fraction again (the worker decides whether to post it), and a look at the abort signal. */
  const heartbeat = () => { report(last); cancelled(); };

  const extension = extensionClass(raw.name);
  const input = inputFacts(raw.name, raw.data, companions);
  const parseInput: ParseInput = utf8Input({ name: raw.name, data: raw.data, companions, ...(raw.options ? { options: raw.options } : {}) });
  const ranked = rankAdapters<BoardAdapter | ContainerAdapter>(sniffInputOf(parseInput), [...boards, ...containers]);
  const ambiguous = ambiguousCandidates(ranked);
  const runs: CandidateRun[] = [];
  const stepsTotal = Math.max(1, ranked.length) + 2;
  let selected: CandidateRun | null = null;
  const startedAt = now();

  if (ambiguous.length) {
    // Two readers are certain about the same bytes: the dispatcher refuses the file, so no candidate is parsed.
    for (const candidate of ranked) {
      const certain = ambiguous.includes(candidate);
      runs.push({
        adapter: candidate.adapter, ms: 0, needsHookStage: false,
        entry: {
          id: formatIdOf(candidate.adapter.id), sniff: tierOf(candidate.confidence), result: certain ? 'error' : 'skipped',
          code: certain ? 'AMBIGUOUS_FORMAT' : null, stage: certain ? 'header' : null, format: null, keyKind: null,
        },
      });
    }
  } else {
    for (let index = 0; index < ranked.length; index++) {
      cancelled();
      const candidate = ranked[index];
      const run = await runCandidate(candidate, parseInput, { now, boards, ...(env.signal ? { signal: env.signal } : {}), progress: fraction => report((index + fraction) / stepsTotal) });
      runs.push(run);
      report((index + 1) / stepsTotal);
      if (run.entry.result !== 'declined') { selected = run; break; }
    }
    for (const candidate of ranked.slice(runs.length)) {
      runs.push({
        adapter: candidate.adapter, ms: 0, needsHookStage: false,
        entry: { id: formatIdOf(candidate.adapter.id), sniff: tierOf(candidate.confidence), result: 'skipped', code: null, stage: null, format: null, keyKind: null },
      });
    }
  }
  const allMs = Math.max(0, now() - startedAt);

  const role = baseName(raw.name);
  const structureInput: StructureInput = {
    data: parseInput.data, companions: parseInput.companions ?? {}, extension, ...(COMPANION_ROLES.has(role) ? { companionRole: role } : {}),
    keys: { ...(raw.options?.fzKey ? { fzKey: raw.options.fzKey } : {}), ...(raw.options?.xzzKey ? { xzzKey: raw.options.xzzKey } : {}) },
  };
  // A failure whose stage is not fixed by its code or by the builder takes it from its adapter's hook: the first step of the format's
  // pipeline the hook could not complete, else records.
  const hookRuns = new Map<StructureHook, ReturnType<typeof runHook>>();
  const hookRun = (adapter: BoardAdapter | ContainerAdapter) => {
    const hook = adapter.kind === 'board' ? adapter.structure : undefined;
    if (!hook) return undefined;
    let result = hookRuns.get(hook);
    if (!result) { result = runHook(hook, structureInput, heartbeat); hookRuns.set(hook, result); }
    return { hook, ...result };
  };
  for (const run of runs) {
    if (!run.needsHookStage) continue;
    const found = hookRun(run.adapter);
    run.entry.stage = found ? stageFromHook(found.hook, found.sink) : run.entry.code === 'UNSUPPORTED_VARIANT' || run.entry.code === 'WRONG_KIND' ? 'header' : 'records';
  }

  const outcome: DiagnosticReport['detection']['outcome'] = ambiguous.length ? 'failed' : !selected ? 'unrecognized' : selected.entry.result === 'claimed' ? 'opened' : 'failed';
  let structure: StructureFacts, frameSink: FactSink | null = null;
  const own = selected ? hookRun(selected.adapter) : undefined;
  if (own) { structure = own.facts; frameSink = own.sink; }
  else structure = runHook(genericHookFor(boards, input.textLike), structureInput, heartbeat).facts;
  report((stepsTotal - 1) / stepsTotal);

  let result: ResultFacts | null = null, plausibilityFacts: DiagnosticReport['plausibility'] = null;
  if (selected?.board) {
    const board = selected.board;
    result = resultFacts(board, frameSink?.unitKind ?? 'unknown');
    plausibilityFacts = plausibility(board, {
      toMm: frameSink?.toMm ?? null, padAngle: frameSink?.padAngleMode ?? 'unknown',
      outlineEstimated: result.outline === 'estimated',
    }, heartbeat);
  }
  report(1);

  return {
    schema: SCHEMA_ID,
    app: { version: /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(env.appVersion ?? APP_VERSION) ? env.appVersion ?? APP_VERSION : '0.0.0', adapterSet: adapterSet(boards, containers), os: env.os },
    privacy: { redaction: REDACTION_VERSION, level: 2, reviewedByUser: false, dedupe: typeof env.dedupe === 'string' },
    input,
    detection: {
      outcome, selected: selected ? selected.entry.id : null, format: selected?.entry.format ?? null, ambiguous: ambiguous.length > 0,
      adapters: runs.map(run => run.entry),
    },
    structure, result, plausibility: plausibilityFacts,
    keys: keyFacts(raw.options, extension),
    performance: { parseMs: count2(selected ? selected.ms : allMs), peakHeapLog2: peak > 0 ? Math.min(40, log2Ceil(peak)) : null },
    dedupe: typeof env.dedupe === 'string' && /^[0-9a-f]{16}$/.test(env.dedupe) ? env.dedupe : null,
  };
}

export { projectReport, type ProjectOptions } from './project';
