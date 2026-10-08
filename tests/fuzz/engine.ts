/**
 * The fuzzing engine: derives an input from (seed, target, iteration), runs a target on it under the contract checks and, for a finding,
 * shrinks the input to a small one that shows the same finding.
 *
 * Contract checked for every input (see docs/FUZZING.md):
 *  1. nothing is thrown except the failures the function documents (the target's `allowed`), and a thrown error is well formed;
 *  2. a successful result satisfies the model invariants (tests/fuzz/invariants.ts) and has bounded size;
 *  3. the input bytes are not changed and the same bytes give the same result again (also from a fresh copy);
 *  4. the call returns within a time budget that grows linearly with the size of the input.
 * A hang or an out-of-memory crash cannot be seen from inside the process; the runner script (scripts/fuzz-parsers.cjs) watches for them.
 */
import { deflateSync, zlibSync } from 'fflate';
import { MAX_MESSAGE_CHARS } from '../../src/lib/bounded-text';
import { SUPPORTED_EXTENSIONS } from '../../src/lib/formats/registry';
import type { Ipc356Options } from '../../src/lib/formats/ipc356';
import type { PinListOptions } from '../../src/lib/formats/pinlist-csv';
import type { FuzzInput, FuzzOptions, Seed } from './corpus';
import { totalBytes } from './corpus';
import { harvestDictionary, mutateBytes } from './mutate';
import type { MutationContext } from './mutate';
import { createRng } from './prng';
import type { Rng } from './prng';
import type { FuzzTarget } from './targets';

export interface FuzzConfig {
  /** Seed of the whole run; the same seed, target and iteration give the same input. */
  seed: string | number;
  /** Upper bound of a primary file (and of each companion) in bytes. */
  maxBytes: number;
  /** Multiplier of the time budget, for a slow or loaded machine. */
  timeScale: number;
}
export const CI_CONFIG: FuzzConfig = { seed: 'ci-1', maxBytes: 192 * 1024, timeScale: 1 };

export type FindingKind = 'unexpected-exception' | 'malformed-error' | 'invariant' | 'unbounded-output' | 'input-modified' | 'nondeterministic' | 'slow' | 'hang' | 'memory' | 'crash';
export interface Finding {
  kind: FindingKind;
  /** One line, free of paths: what went wrong. */
  message: string;
  /** Groups the same defect found by different inputs. */
  signature: string;
}
export interface CaseResult {
  outcome: 'null' | 'output' | 'error';
  ms: number;
  bytes: number;
  units: number;
  errorCode?: string;
  finding?: Finding;
}

// ---------------------------------------------------------------------------------------------------------------
// Pools: the seeds and words of one target
// ---------------------------------------------------------------------------------------------------------------

export interface TargetPool {
  own: Seed[];
  all: Seed[];
  donors: Uint8Array[];
  dictionary: Uint8Array[];
}
export function buildPool(target: FuzzTarget, corpus: readonly Seed[]): TargetPool {
  const own = corpus.filter(seed => target.seeds.includes(seed.adapter));
  const all = corpus.slice();
  const donors = all.map(seed => seed.input.data).filter(data => data.length <= 64 * 1024).slice(0, 200);
  const dictionary = harvestDictionary([...own, ...(own.length ? [] : all.slice(0, 40))].flatMap(seed => [seed.input.data, ...Object.values(seed.input.companions ?? {})]));
  return { own, all, donors, dictionary };
}

// ---------------------------------------------------------------------------------------------------------------
// Input generation
// ---------------------------------------------------------------------------------------------------------------

const NAMES = ['board.brd', 'board.cad', 'board.gcd', 'board.fz', 'board.cae', 'board.pcb', 'board.cst', 'board.bdv', 'board.bvr', 'format.asc', 'pins.asc', 'board.kicad_pcb', 'board.pcbdoc', 'sheet.kicad_sch', 'sheet.sch', 'board.xml', 'board.tgz', 'board', 'BOARD.BRD', '',
  'board.hyp', 'board.fab', 'board.fatf', 'board.json', 'project.epro', 'board.epcb', 'board.zip', 'board.ipc', 'board.356', 'pins.csv', 'pins.tsv', 'pins.txt', 'board.cvg', 'Sheet.SchDoc', 'SHEET.SCHDOC', 'Project.PrjPcb'];
const SIGNATURES = ['{VERSION=2.0}\n{UNITS=ENGLISH LENGTH}\n', 'A!REFDES!COMP_CLASS!SYM_NAME!SYM_X!SYM_Y!\n', '{"head":{"docType":"3","editorVersion":"6.5.1"},', '["DOCTYPE","PCB","1.8"]\n', 'PK\u0003\u0004', 'P  UNITS CUST 0\n327N1    U1   -1   A01X+001000Y+001000X0300Y0600R000S0\n',
  'Ref,Pin,X,Y,Net\n', 'Ref;Pin;X;Y;Net\n', '<IPC-2581 revision="C" xmlns="http://webstds.ipc.org/2581">', '|HEADER=Protel for Windows - Schematic Capture Binary File Version 5.0|Weight=0\n', '|RECORD=1|', '(kicad_pcb', '(kicad_sch', '$HEADER\nGENCAD 1.4\n', '<?xml version="1.0"?><eagle>', 'BRDOUT:', 'str_length:', 'XZZPCB', 'BVRAW_FORMAT_3\n', 'BVRAW_FORMAT_1\n', '<<format.asc>>', '###Panel Added', 'EESchema Schematic File Version 4\n', 'ÐÏ\u0011à', '\u001f\u008b\u0008', '%FSLAX24Y24*%', '<IPC-2581'];

/** File names with every extension a registered adapter claims, drawn from a stream of their own so that registering a format does not change the other inputs. */
const REGISTERED_NAMES: readonly string[] = SUPPORTED_EXTENSIONS.flatMap(extension => [`board${extension}`, `BOARD${extension.toUpperCase()}`]);

function hexKey(rng: Rng): string { return Array.from({ length: 16 }, () => '0123456789abcdef'[rng.int(16)]).join(''); }

/** Binary data has zero bytes in its first kilobyte; text does not. */
const isBinary = (data: Uint8Array): boolean => data.subarray(0, 1024).includes(0);

function pickSeed(pool: TargetPool, rng: Rng, foreign: boolean): Seed | null {
  const from = foreign || pool.own.length === 0 ? pool.all : pool.own;
  return from.length ? rng.pick(from) : null;
}

function prepared(target: FuzzTarget, data: Uint8Array, rng: Rng): Uint8Array {
  if (!target.prepare || rng.chance(0.15)) return data;
  try { return target.prepare === 'zlib' ? zlibSync(data) : deflateSync(data); } catch { return data; }
}

function soup(rng: Rng, pool: TargetPool, header: Uint8Array | null, maxBytes: number): Uint8Array {
  const words = pool.dictionary.length ? pool.dictionary : [new TextEncoder().encode('X')];
  const numbers = ['0', '1', '-1', '10', '100', '2.5', '1000000', '-0.5', '12345678', '1e3'];
  const pieces: string[] = [];
  const dec = new TextDecoder('latin1');
  if (header && rng.chance(0.7)) pieces.push(dec.decode(header.subarray(0, rng.range(8, 120))), '\n');
  const lines = rng.range(1, rng.chance(0.8) ? 40 : 400);
  for (let line = 0; line < lines; line++) {
    const count = rng.range(1, 8);
    const parts: string[] = [];
    for (let index = 0; index < count; index++) parts.push(rng.chance(0.55) ? dec.decode(rng.pick(words)) : rng.chance(0.7) ? rng.pick(numbers) : String(rng.range(-100, 100)));
    pieces.push(parts.join(rng.chance(0.8) ? ' ' : ','), rng.chance(0.85) ? '\n' : '\r\n');
  }
  const bytes = new TextEncoder().encode(pieces.join(''));
  return bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
}

/** The input of iteration `iteration`: always the same for the same (config.seed, target, iteration). */
export function generate(target: FuzzTarget, pool: TargetPool, config: FuzzConfig, iteration: number): FuzzInput {
  const rng = createRng(config.seed, target.id, iteration);
  const context: MutationContext = { rng, dictionary: pool.dictionary, donors: pool.donors, maxBytes: config.maxBytes };
  const strategy = rng.weighted([62, 9, 6, 7, 5, 4, 3]);
  const base = pickSeed(pool, rng, strategy === 1);
  const seedData = base ? prepared(target, base.input.data, rng) : new Uint8Array(0);
  let input: FuzzInput = base ? { name: base.input.name, data: seedData, ...(base.input.companions ? { companions: { ...base.input.companions } } : {}), ...(base.input.options ? { options: base.input.options } : {}) } : { name: rng.pick(NAMES), data: new Uint8Array(0) };
  switch (strategy) {
    case 0: case 1: {
      const rounds = strategy === 1 ? rng.int(3) : rng.chance(0.5) ? 1 : rng.range(2, 6);
      const where = rng.weighted([80, 14, 6]);
      if (where === 1 && input.companions && Object.keys(input.companions).length) {
        const name = rng.pick(Object.keys(input.companions));
        input.companions[name] = mutateBytes(input.companions[name], context, rounds);
      } else if (where === 2 && input.companions && Object.keys(input.companions).length) {
        const names = Object.keys(input.companions);
        const mode = rng.int(3), victim = rng.pick(names);
        if (mode === 0) delete input.companions[victim];
        else if (mode === 1) input.companions[rng.pick(NAMES).toLowerCase()] = input.companions[victim];
        else input.companions[victim] = new Uint8Array(0);
      } else input.data = mutateBytes(input.data, context, rounds, isBinary(input.data) && rng.chance(0.6));
      break;
    }
    case 2: {
      const cut = rng.chance(0.7) ? Math.floor((input.data.length * rng.int(65)) / 64) : rng.int(input.data.length + 1);
      input.data = mutateBytes(input.data.subarray(0, cut), context, rng.int(2));
      break;
    }
    case 3: input = { ...input, data: soup(rng, pool, base?.input.data ?? null, config.maxBytes) }; break;
    case 4: {
      const signature = rng.chance(0.5) ? new TextEncoder().encode(rng.pick(SIGNATURES)) : new Uint8Array(0);
      // Often the first bytes of one of the target's own seeds instead: the signature of any registered format without a list of them here.
      const own = createRng(config.seed, target.id, iteration, 'head');
      const prefix = pool.own.length && own.chance(0.4) ? own.pick(pool.own).input.data.subarray(0, own.range(4, 64)) : signature;
      const body = rng.bytes(Math.floor(Math.exp(rng.next() * Math.log(4096))) - 1 + rng.int(2));
      const data = new Uint8Array(prefix.length + body.length);
      data.set(prefix); data.set(body, prefix.length);
      input = { ...input, data };
      break;
    }
    case 5: input.name = rng.pick(NAMES); input.data = mutateBytes(input.data, context, rng.int(3)); break;
    default: {
      // Keys: the right shape, the wrong shape, and nonsense.
      const key = rng.weighted([3, 3, 2, 2]);
      input.options = key === 0 ? { fzKey: Array.from({ length: 44 }, () => rng.int(2 ** 32)) } : key === 1 ? { fzKey: Array.from({ length: rng.pick([0, 1, 43, 44, 45, 200]) }, () => rng.pick([0, 1, -1, 2 ** 32, 1.5, NaN, 2 ** 31])) } : key === 2 ? { xzzKey: hexKey(rng) } : { xzzKey: rng.pick(['', 'zzzzzzzzzzzzzzzz', '0'.repeat(15), '0'.repeat(17), '\u0000'.repeat(16), 'FFFFFFFFFFFFFFFF']) };
      input.data = mutateBytes(input.data, context, rng.int(3));
    }
  }
  const extra = readerOptions(target.id, rng);
  if (extra) input.options = { ...input.options, ...extra };
  const names = createRng(config.seed, target.id, iteration, 'name');
  if (REGISTERED_NAMES.length && names.chance(0.12)) input.name = names.pick(REGISTERED_NAMES);
  if (input.data.length > config.maxBytes) input.data = input.data.subarray(0, config.maxBytes);
  return input;
}

/** Numbers a reader option may be given: the usual ones, the edges, and the values that are not numbers a person could mean. */
const optionNumber = (rng: Rng): number => rng.pick([0, 1, -1, 0.001, 0.0254, 0.5, 25.4, 1000, 1e-9, 1e9, 1e300, Number.MAX_VALUE, Number.MIN_VALUE, NaN, Infinity, -Infinity, 2 ** 31, 2 ** 53]);

/**
 * Options of the readers that take some (IPC-D-356, the pin list), drawn for a quarter of their inputs: the values a person could
 * choose in the dialog, and extreme ones. Other targets draw nothing, so their inputs do not depend on this.
 */
function readerOptions(targetId: string, rng: Rng): FuzzOptions | undefined {
  const pinList = targetId === 'board:pinlist' || targetId === 'sniff:pinlist-analysis';
  if (!pinList && targetId !== 'board:ipc356') return undefined;
  if (!rng.chance(0.25)) return undefined;
  if (targetId === 'board:ipc356') {
    const options: Ipc356Options = {};
    if (rng.chance(0.5)) options.unitsToMm = optionNumber(rng);
    if (rng.chance(0.4)) options.bottomAccess = rng.pick([0, 1, 2, 3, 4, 5, -1, 99, NaN, 1.5]);
    if (rng.chance(0.5)) options.rotation = rng.pick(['clockwise', 'counterclockwise'] as const);
    if (rng.chance(0.5)) options.vias = rng.pick(['skip', 'points'] as const);
    return { ipc356: options };
  }
  const options: PinListOptions = {};
  if (rng.chance(0.4)) options.delimiter = rng.pick([',', ';', '\t', '|'] as const);
  if (rng.chance(0.3)) options.hasHeader = rng.chance(0.5);
  if (rng.chance(0.6)) {
    const mapping: NonNullable<PinListOptions['mapping']> = {};
    for (const role of ['refdes', 'pin', 'net', 'x', 'y', 'side', 'value', 'package'] as const) {
      if (rng.chance(0.7)) mapping[role] = rng.pick([0, 1, 2, 3, 4, 5, 6, 7, 12, -1, 1e9, 1.5, 'ref', 'Pin', 'x', 'Y', 'net', 'side', '', null]);
    }
    options.mapping = mapping;
  }
  if (rng.chance(0.3)) options.decimal = rng.pick(['.', ','] as const);
  if (rng.chance(0.4)) options.unit = rng.pick(['mm', 'mil', 'inch', 'um'] as const);
  if (rng.chance(0.2)) options.unitsToMm = optionNumber(rng);
  if (rng.chance(0.3)) options.defaultSide = rng.pick(['top', 'bottom', 'both'] as const);
  if (rng.chance(0.2)) options.sideMap = { '1': 'top', '2': 'bottom', COMP: 'top', SOLDER: 'bottom', __proto__: 'both', constructor: 'top', toString: 'bottom' } as Record<string, 'top' | 'bottom' | 'both'>;
  if (rng.chance(0.3)) options.flipY = rng.chance(0.5);
  if (rng.chance(0.2)) options.limits = { maxPins: rng.pick([0, 1, 2, 5, 100, -1, 1e9, NaN]), maxParts: rng.pick([0, 1, 2, 5, 100, -1, 1e9, NaN]) };
  return { pinList: options };
}

/**
 * The sweep of a target: each of its own seeds whole and cut at every 1/64 of its length. A target that draws on the seeds of every
 * format (the dispatchers) has hundreds of them; it cuts each at fewer points (never fewer than 3), so that a sweep stays at about
 * 2,600 inputs. The random truncations of the derived inputs cover the rest.
 */
const SWEEP_INPUTS = 2600;
export const cutsOf = (pool: TargetPool): number => Math.max(3, Math.min(64, Math.floor(SWEEP_INPUTS / Math.max(1, pool.own.length)) - 1));
export const sweepSize = (pool: TargetPool): number => pool.own.length * (cutsOf(pool) + 1);
export function sweepInput(pool: TargetPool, index: number): { label: string; input: FuzzInput } {
  const cuts = cutsOf(pool), seed = pool.own[Math.floor(index / (cuts + 1))], part = index % (cuts + 1);
  if (part === cuts) return { label: `seed ${seed.id}`, input: seed.input };
  return { label: `seed ${seed.id} cut ${part}/${cuts}`, input: { ...seed.input, data: seed.input.data.subarray(0, Math.floor((seed.input.data.length * part) / cuts)) } };
}

// ---------------------------------------------------------------------------------------------------------------
// Running one input
// ---------------------------------------------------------------------------------------------------------------

/** Time the call may take: a fixed part for start-up and caches, plus a linear part per KiB of input. */
export const timeBudgetMs = (input: FuzzInput, config: FuzzConfig): number => (400 + 6 * (totalBytes(input) / 1024)) * config.timeScale;

const clean = (text: string): string => text.replace(/[A-Za-z]:[\\/][^\s'")]*|\/(?:home|Users|tmp)\/[^\s'")]*/g, '<path>').replace(/\s+/g, ' ').trim();
const shape = (text: string): string => clean(text).replace(/\d+(?:\.\d+)?/g, '#').replace(/"[^"]{0,60}"/g, '"~"').replace(/'[^']{0,60}'/g, "'~'").slice(0, 110);
function frames(error: unknown): string {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  const names: string[] = [];
  for (const match of stack.matchAll(/^\s+at (?:async )?([A-Za-z_$][\w$.<>]*) /gm)) { names.push(match[1]); if (names.length >= 2) break; }
  return names.join('>');
}
const finding = (target: FuzzTarget, kind: FindingKind, message: string, key = message, error?: unknown): Finding => ({ kind, message: clean(message).slice(0, 300), signature: `${target.id}|${kind}|${shape(key)}${error === undefined ? '' : `|${frames(error)}`}` });

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(a, b) === 0;
export const copyOf = (input: FuzzInput): FuzzInput => ({
  name: input.name, data: input.data.slice(),
  ...(input.companions ? { companions: Object.fromEntries(Object.entries(input.companions).map(([name, bytes]) => [name, bytes.slice()])) } : {}),
  ...(input.options ? { options: structuredClone(input.options) } : {}),
});

/** Largest output a target may produce, as units of its own kind; anything above is a bomb. */
const OUTPUT_UNIT_LIMIT = 4_000_000;
/** Outputs this small are run twice to compare. */
const DETERMINISM_LIMIT_BYTES = 48 * 1024;

export function runCase(target: FuzzTarget, input: FuzzInput, config: FuzzConfig): CaseResult {
  const bytes = totalBytes(input);
  const guard = copyOf(input);
  const started = performance.now();
  let output: unknown, error: unknown, thrown = false;
  try { output = target.run(input); } catch (caught) { thrown = true; error = caught; }
  const ms = performance.now() - started;
  const result: CaseResult = { outcome: thrown ? 'error' : output === null ? 'null' : 'output', ms, bytes, units: 0 };
  const budget = timeBudgetMs(input, config);
  const flag = (found: Finding) => { result.finding ??= found; };

  if (!sameBytes(guard.data, input.data) || Object.entries(guard.companions ?? {}).some(([name, data]) => !sameBytes(data, input.companions?.[name] ?? new Uint8Array(0)))) flag(finding(target, 'input-modified', 'the parser changed the bytes it was given'));
  if (thrown) {
    const name = error instanceof Error ? error.name : typeof error;
    if (!target.allowed(error)) {
      const cause = error instanceof Error && error.cause instanceof Error ? ` (cause ${error.cause.name}: ${error.cause.message})` : '';
      const text = `${name}: ${error instanceof Error ? error.message : String(error)}${cause}`;
      flag(finding(target, 'unexpected-exception', text, cause ? `${name}${cause}` : text, error instanceof Error && error.cause instanceof Error ? error.cause : error));
    } else {
      const { message, code, issue } = error as { message?: unknown; code?: unknown; issue?: { params?: Record<string, unknown> } };
      const quoted = issue?.params ? Object.values(issue.params).find(value => typeof value === 'string' && value.length > MAX_MESSAGE_CHARS) : undefined;
      if (typeof quoted === 'string') flag(finding(target, 'malformed-error', `a message parameter of ${quoted.length} characters`, 'parameter'));
      result.errorCode = typeof code === 'string' ? code : name;
      if (typeof message !== 'string' || message === '' || message.length > MAX_MESSAGE_CHARS) flag(finding(target, 'malformed-error', `an error message of ${typeof message === 'string' ? message.length : typeof message} characters`, 'message'));
    }
  } else if (output !== null && output !== undefined) {
    const violation = target.check ? target.check(output, input) : null;
    if (violation) flag(finding(target, 'invariant', violation));
    result.units = target.units ? target.units(output) : 0;
    if (result.units > OUTPUT_UNIT_LIMIT) flag(finding(target, 'unbounded-output', `${result.units} units of output from ${bytes} bytes`, 'units'));
  }
  if (ms > budget && !result.finding) flag(finding(target, 'slow', `${Math.round(ms)} ms for ${Math.round(bytes / 1024)} KiB (budget ${Math.round(budget)} ms)`, 'time'));
  if (!result.finding && bytes <= DETERMINISM_LIMIT_BYTES && target.digest) {
    // The same bytes again, from a fresh copy (decoded text is cached per array), must give the same result.
    const again = copyOf(input);
    let second: string;
    try { const value = target.run(again); second = value === null ? 'null' : `ok:${target.digest(value)}`; } catch (caught) { second = `error:${caught instanceof Error ? `${caught.name}:${(caught as { code?: unknown }).code}:${caught.message}` : String(caught)}`; }
    const first = thrown ? `error:${error instanceof Error ? `${error.name}:${(error as { code?: unknown }).code}:${error.message}` : String(error)}` : output === null ? 'null' : `ok:${target.digest(output)}`;
    if (first !== second) flag(finding(target, 'nondeterministic', 'the same bytes gave a different result the second time', 'again'));
  }
  return result;
}

/**
 * `runCase`, and a time finding is only kept when the input is slow every time: a pause of a busy machine does not count, a quadratic
 * reader does (the best of three runs is over the budget).
 */
export function runCaseConfirmed(target: FuzzTarget, input: FuzzInput, config: FuzzConfig): CaseResult {
  const first = runCase(target, input, config);
  if (first.finding?.kind !== 'slow') return first;
  let best = first;
  for (let again = 0; again < 3; again++) {
    const next = runCase(target, input, config);
    if (next.finding?.kind !== 'slow') return next;
    if (next.ms < best.ms) best = next;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Shrinking
// ---------------------------------------------------------------------------------------------------------------

/** Classic delta debugging: the smallest list (by chunk removal) that still satisfies `test`, within `limit` evaluations. */
export async function ddmin<T>(items: T[], test: (candidate: T[]) => Promise<boolean> | boolean, limit: number): Promise<T[]> {
  let current = items, granularity = 2, tests = 0;
  while (current.length >= 2 && tests < limit) {
    const size = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length && tests < limit; start += size) {
      const candidate = [...current.slice(0, start), ...current.slice(start + size)];
      if (candidate.length === 0) continue;
      tests++;
      if (await test(candidate)) { current = candidate; granularity = Math.max(granularity - 1, 2); reduced = true; break; }
    }
    if (!reduced) { if (granularity >= current.length) break; granularity = Math.min(current.length, granularity * 2); }
  }
  return current;
}

function splitLines(data: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let from = 0;
  for (let index = 0; index < data.length; index++) if (data[index] === 0x0a) { lines.push(data.subarray(from, index + 1)); from = index + 1; }
  if (from < data.length) lines.push(data.subarray(from));
  return lines;
}
function join(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const result = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}

export interface ShrinkOptions { maxTests: number; deadlineMs: number }

/** Does this candidate still show the finding? (In process with `runCase`, or in a watched worker for a hang.) */
export type Probe = (candidate: FuzzInput) => Promise<boolean>;

/** Probe for findings an exception, a bad result or a slow call shows: the same kind and signature (a time finding: at least half as slow). */
export function inProcessProbe(target: FuzzTarget, found: Finding, config: FuzzConfig, originalMs: number): Probe {
  return async candidate => {
    const result = runCase(target, candidate, config);
    if (!result.finding || result.finding.kind !== found.kind) return false;
    if (found.kind === 'slow') return result.ms >= Math.max(50, originalMs * 0.5);
    return result.finding.signature === found.signature;
  };
}

/** Smaller input that still satisfies `still`: lines first, then bytes, then each companion, then the options. */
export async function shrink(input: FuzzInput, still: Probe, options: ShrinkOptions): Promise<FuzzInput> {
  const deadline = Date.now() + options.deadlineMs;
  const check = async (candidate: FuzzInput) => (Date.now() > deadline ? false : still(candidate));
  let best = copyOf(input);
  const reduce = async (get: () => Uint8Array, set: (value: Uint8Array) => void) => {
    const lines = splitLines(get());
    if (lines.length > 3) {
      const kept = await ddmin(lines, async candidate => { const saved = get(); set(join(candidate)); const ok = await check(best); set(saved); return ok; }, Math.floor(options.maxTests / 3));
      set(join(kept));
    }
    const bytes = Array.from(get());
    if (bytes.length > 1) {
      const kept = await ddmin(bytes, async candidate => { const saved = get(); set(Uint8Array.from(candidate)); const ok = await check(best); set(saved); return ok; }, options.maxTests);
      set(Uint8Array.from(kept));
    }
  };
  await reduce(() => best.data, value => { best.data = value; });
  if (best.companions) {
    for (const name of Object.keys(best.companions)) {
      const without = copyOf(best); delete without.companions![name];
      if (await check(without)) { best = without; continue; }
      await reduce(() => best.companions![name], value => { best.companions![name] = value; });
    }
    if (Object.keys(best.companions ?? {}).length === 0) delete best.companions;
  }
  if (best.options) { const without = copyOf(best); delete without.options; if (await check(without)) best = without; }
  return best;
}

/** A readable name for an input: the file name it came with, and its size. */
export const describeInput = (input: FuzzInput): string => `${input.name || '(no name)'} ${input.data.length} bytes${input.companions ? ` + ${Object.keys(input.companions).length} companion(s)` : ''}`;
