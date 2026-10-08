/**
 * Entry of the fuzz runner (scripts/fuzz-parsers.cjs). The script bundles this file once and then both imports it (for the generators,
 * the shrinker and the fixture format) and starts it as worker threads. A worker does the risky part: it runs the inputs, so a hang or
 * an out-of-memory crash costs one worker, which the script terminates and replaces; it knows from the shared status block which input
 * was running.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { packInput, unpackInput } from './corpus';
import { loadSeeds } from './seeds';
import type { PackedInput, Seed } from './corpus';
import { buildPool, CI_CONFIG, copyOf, ddmin, describeInput, generate, inProcessProbe, runCase, runCaseConfirmed, shrink, sweepInput, sweepSize, timeBudgetMs } from './engine';
import type { CaseResult, Finding, FuzzConfig, TargetPool } from './engine';
import { ALL_TARGETS } from './targets';
import type { FuzzTarget } from './targets';

export { ALL_TARGETS, buildPool, CI_CONFIG, copyOf, ddmin, describeInput, generate, inProcessProbe, loadSeeds, packInput, runCase, runCaseConfirmed, shrink, sweepInput, sweepSize, timeBudgetMs, unpackInput };
export type { CaseResult, Finding, FuzzConfig, FuzzTarget, PackedInput, Seed, TargetPool };

/**
 * Slots of the shared status block of a worker: [run counter, start time, time budget in ms (0 = idle), position]. The position is the
 * iteration (0 or more) or, for the sweep of the seeds, -(1 + index of the sweep input).
 */
export const STATUS_SLOTS = 4;

export interface StartMessage { type: 'run'; target: string; phase: 'sweep' | 'iterations'; from: number; count: number }
export interface CheckMessage { type: 'check'; id: number; target: string; input: PackedInput }
export interface BatchStats {
  target: string; executed: number; outcomes: Record<string, number>; errorCodes: Record<string, number>; ms: number; maxMs: number; maxUnits: number; maxBytes: number;
  slowest: Array<{ ms: number; bytes: number; iteration: number }>;
}
export interface FoundMessage { iteration: number; label: string; finding: Finding; ms: number; input: PackedInput }
export type WorkerReply =
  | { type: 'ready' }
  | { type: 'done'; stats: BatchStats; found: FoundMessage[] }
  | { type: 'checked'; id: number; finding: Finding | null; ms: number };

function worker(): void {
  const port = parentPort!;
  const { corpusDir, config, status } = workerData as { corpusDir: string; config: FuzzConfig; status: SharedArrayBuffer };
  const slots = new Float64Array(status);
  const corpus = loadSeeds(corpusDir);
  const targets = new Map(ALL_TARGETS().map(target => [target.id, target]));
  const pools = new Map<string, TargetPool>();
  const poolOf = (target: FuzzTarget) => { let pool = pools.get(target.id); if (!pool) { pool = buildPool(target, corpus); pools.set(target.id, pool); } return pool; };
  let counter = 0;
  const watched = <T>(target: FuzzTarget, input: Parameters<typeof timeBudgetMs>[0], iteration: number, work: () => T): T => {
    slots[0] = ++counter; slots[1] = Date.now(); slots[2] = timeBudgetMs(input, config); slots[3] = iteration;
    try { return work(); } finally { slots[2] = 0; }
  };
  port.postMessage({ type: 'ready' } satisfies WorkerReply);
  port.on('message', (message: StartMessage | CheckMessage) => {
    if (message.type === 'check') {
      const target = targets.get(message.target)!;
      const input = unpackInput(message.input);
      const result = watched(target, input, -1, () => runCase(target, input, config));
      port.postMessage({ type: 'checked', id: message.id, finding: result.finding ?? null, ms: result.ms } satisfies WorkerReply);
      return;
    }
    const target = targets.get(message.target)!;
    const pool = poolOf(target);
    const stats: BatchStats = { target: target.id, executed: 0, outcomes: {}, errorCodes: {}, ms: 0, maxMs: 0, maxUnits: 0, maxBytes: 0, slowest: [] };
    const found: FoundMessage[] = [];
    const account = (iteration: number, label: string, input: Parameters<typeof timeBudgetMs>[0], result: CaseResult) => {
      stats.executed++; stats.ms += result.ms;
      stats.outcomes[result.outcome] = (stats.outcomes[result.outcome] ?? 0) + 1;
      if (result.errorCode) stats.errorCodes[result.errorCode] = (stats.errorCodes[result.errorCode] ?? 0) + 1;
      stats.maxMs = Math.max(stats.maxMs, result.ms); stats.maxUnits = Math.max(stats.maxUnits, result.units); stats.maxBytes = Math.max(stats.maxBytes, result.bytes);
      if (result.ms > 25) { stats.slowest.push({ ms: result.ms, bytes: result.bytes, iteration }); stats.slowest.sort((a, b) => b.ms - a.ms); stats.slowest.length = Math.min(stats.slowest.length, 3); }
      if (result.finding) found.push({ iteration, label, finding: result.finding, ms: result.ms, input: packInput(input) });
    };
    if (message.phase === 'sweep') {
      for (let index = message.from; index < message.from + message.count && index < sweepSize(pool); index++) {
        const { label, input } = sweepInput(pool, index);
        account(-(1 + index), label, input, watched(target, input, -(1 + index), () => runCaseConfirmed(target, input, config)));
      }
      port.postMessage({ type: 'done', stats, found } satisfies WorkerReply);
      return;
    }
    for (let iteration = message.from; iteration < message.from + message.count; iteration++) {
      const input = generate(target, pool, config, iteration);
      account(iteration, `iteration ${iteration}`, input, watched(target, input, iteration, () => runCaseConfirmed(target, input, config)));
    }
    port.postMessage({ type: 'done', stats, found } satisfies WorkerReply);
  });
}

if (!isMainThread && (workerData as { fuzzWorker?: boolean } | null)?.fuzzWorker) worker();
