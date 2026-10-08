/*
 * Board dispatcher v2 (original TRACE module, MIT).
 *
 * 1. Size guard, then byte-order-marked UTF-16 is re-encoded as UTF-8, so byte-sniffing and text-decoding readers agree.
 * 2. Every adapter sniffs the head (at most SNIFF_BYTES), the name and the size; candidates are ranked by confidence, then
 *    by whether the file's extension is theirs, then by id. Registration order plays no part.
 * 3. Two board adapters CERTAIN about the same bytes is an ambiguity: the file is refused with both names, never guessed.
 * 4. Candidates are parsed strongest first. A parse returns the board, declines (null: the full input is not its format,
 *    or TextDecodeError for undecodable UTF-16), or throws; a format error ends the import, anything else is wrapped with
 *    the adapter id. Byte budgets are checked before a parse, record budgets on its result.
 * 5. A container candidate (ZIP) is opened instead of parsed: its one board (or one companion set) is unpacked within the
 *    container's budgets and dispatched like a file of its own; containers are never opened inside containers.
 * One core (a generator that yields parse steps) serves the synchronous `parseBoard` and the asynchronous `parseBoardAsync`.
 */
import type { Board } from '../types';
import { utf16ToUtf8, utf8Input } from '../encoding';
import { GenCadParseError } from '../gencad';
import { CERTAIN, LIKELY, META_LIMIT, META_TEXT, SNIFF_BYTES, type BoardAdapter, type ContainerAdapter, type ContainerEntry, type FormatAdapter, type KeyKind, type KeyMaterial, type ParseContext, type ProgressPhase, type SniffInput, type SniffResult, type SupportStatus } from './adapter';
import { BoardFormatError, localizedFormatError, MAX_IMPORT_BYTES, TextDecodeError, type ParseInput } from './common';
import { BOARD_ADAPTERS, CONTAINER_ADAPTERS, selectCompanionSet } from './registry';
import { baseName, extensionOf, hasUtf16Mark } from './sniff';

export interface Candidate<A extends FormatAdapter = FormatAdapter> {
  readonly adapter: A;
  readonly confidence: number;
  readonly reason: string;
  readonly variant?: string;
  readonly needsKey?: KeyKind;
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}
export interface DispatchOptions {
  /** Board adapters to consider (default: the registry). */
  readonly adapters?: readonly BoardAdapter[];
  /** Containers to open (default: the registry). */
  readonly containers?: readonly ContainerAdapter[];
  readonly signal?: AbortSignal;
  /** Overall progress 0..1 with the phase it belongs to; monotonic. */
  readonly onProgress?: (fraction: number, phase: ProgressPhase) => void;
}
/** A parsed board with the adapter that read it and why it was chosen. */
export interface BoardImport {
  readonly board: Board;
  readonly adapter: string;
  readonly confidence: number;
  readonly reason: string;
  /** The container that held the board (its adapter id) and the member that was opened, when the file was an archive. */
  readonly container?: string;
  readonly entry?: string;
}

const clamp = (value: number): number => Math.max(0, Math.min(100, Math.floor(value)));
const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The sniff view of an input: its head, name and full size. */
export const sniffInputOf = (input: { data: Uint8Array; name: string }): SniffInput => ({ head: input.data.subarray(0, SNIFF_BYTES), name: input.name, size: input.data.length });

const META_KEY = /^[a-z][A-Za-z0-9]{0,31}$/;
/** The sniff's metadata, bounded: at most META_LIMIT camelCase keys, finite numbers, booleans and strings of at most META_TEXT characters. */
function boundedMeta(meta: unknown): Record<string, string | number | boolean> | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const out: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(meta)) {
    if (count >= META_LIMIT || !META_KEY.test(key)) continue;
    if (typeof value === 'string' && value) out[key] = value.slice(0, META_TEXT);
    else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') out[key] = value;
    else continue;
    count++;
  }
  return count ? Object.freeze(out) : undefined;
}
/** Every adapter's sniff, strongest first. A sniff that throws counts as no match (sniffs must be total; the conformance test fails on it). */
export function rankAdapters<A extends FormatAdapter>(input: SniffInput, adapters: readonly A[]): Array<Candidate<A>> {
  const extension = extensionOf(input.name), owns = (adapter: A) => (adapter.extensions.includes(extension) ? 1 : 0);
  const ranked: Array<Candidate<A>> = [];
  for (const adapter of adapters) {
    let result: SniffResult;
    try { result = adapter.sniff(input); } catch { continue; }
    const confidence = typeof result?.confidence === 'number' && Number.isFinite(result.confidence) ? clamp(result.confidence) : 0;
    if (confidence <= 0) continue;
    const meta = boundedMeta(result.meta);
    ranked.push({ adapter, confidence, reason: String(result.reason ?? ''), ...(result.variant ? { variant: String(result.variant).slice(0, META_TEXT) } : {}), ...(result.needsKey ? { needsKey: result.needsKey } : {}), ...(meta ? { meta } : {}) });
  }
  return ranked.sort((a, b) => b.confidence - a.confidence || owns(b.adapter) - owns(a.adapter) || compareIds(a.adapter.id, b.adapter.id));
}
/** The candidates that make a file ambiguous: two or more board adapters at CERTAIN ([] otherwise). */
export const ambiguousCandidates = <A extends FormatAdapter>(ranked: ReadonlyArray<Candidate<A>>): Array<Candidate<A>> => {
  const certain = ranked.filter(candidate => candidate.adapter.kind === 'board' && candidate.confidence >= CERTAIN);
  return certain.length > 1 ? certain : [];
};

const fileLabel = (name: string): string => name.split(/[\\/]/).pop() ?? name;
function ambiguous(name: string, certain: readonly Candidate[]): BoardFormatError {
  const formats = certain.map(candidate => candidate.adapter.name).join(', '), file = fileLabel(name);
  return localizedFormatError(`The content of "${file}" matches more than one format with certainty (${formats}); it is not opened, so that no format is guessed.`, 'AMBIGUOUS_FORMAT', { key: 'parse.error.ambiguousFormat', params: { file, formats } });
}
function checkInput(raw: ParseInput): ParseInput {
  if (!(raw.data instanceof Uint8Array)) throw new BoardFormatError('Board data must be a byte array.');
  if (raw.data.length > MAX_IMPORT_BYTES) throw new BoardFormatError('Board data exceeds the 64 MiB import limit.', 'LIMIT_EXCEEDED');
  for (const [name, bytes] of Object.entries(raw.companions ?? {})) {
    if (!(bytes instanceof Uint8Array)) throw new BoardFormatError(`Companion file ${name} must be a byte array.`);
    if (bytes.length > MAX_IMPORT_BYTES) throw new BoardFormatError(`Companion file ${name} exceeds the 64 MiB import limit.`, 'LIMIT_EXCEEDED');
  }
  const input = utf8Input(raw);
  if (input.data.length > MAX_IMPORT_BYTES) throw new BoardFormatError('Board data exceeds the 64 MiB import limit.', 'LIMIT_EXCEEDED');
  return input;
}
const isAbort = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error && isAbort(signal.reason) ? signal.reason : new DOMException('Import cancelled.', 'AbortError');
}

interface Progress { report(fraction: number, phase: ProgressPhase): void }
function progressOf(options: DispatchOptions): Progress {
  let last = 0;
  return { report(fraction, phase) {
    const value = Math.max(last, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
    last = value;
    try { options.onProgress?.(value, phase); } catch { /* a progress listener never breaks an import */ }
  } };
}
const PARSE_START = 0.1, PARSE_END = 0.98;
const NEVER = new AbortController().signal;
/** The context one parse receives; `requestKey` answers from the session keys the input carries. */
export function contextFor(adapter: BoardAdapter, input: ParseInput, signal: AbortSignal = NEVER, progress: (fraction: number) => void = () => {}): ParseContext {
  return {
    signal,
    limits: adapter.limits,
    progress: fraction => { try { progress(Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))); } catch { /* never breaks a parse */ } },
    requestKey(kind: KeyKind): Promise<KeyMaterial> {
      const key = kind === 'fz' ? input.options?.fzKey : input.options?.xzzKey;
      if (key !== undefined) return Promise.resolve(key);
      return Promise.reject(new BoardFormatError(`${adapter.name}: this file is encrypted and needs a key.`, 'KEY_REQUIRED', adapter.name, kind));
    },
  };
}
function checkBudgets(adapter: BoardAdapter, input: ParseInput): void {
  let total = input.data.length;
  for (const bytes of Object.values(input.companions ?? {})) total += bytes.length;
  if (input.data.length > adapter.limits.maxInputBytes || total > adapter.limits.maxTotalBytes) {
    throw new BoardFormatError(`${adapter.name}: the file exceeds the import limit of this format.`, 'LIMIT_EXCEEDED', adapter.name);
  }
}
function checkOutput(adapter: BoardAdapter, board: Board): void {
  if (board.components.length > adapter.limits.maxComponents || board.pins.length > adapter.limits.maxPins) {
    throw new BoardFormatError('Board record count exceeds the import limit.', 'LIMIT_EXCEEDED', adapter.name);
  }
}

interface ParseStep { readonly adapter: BoardAdapter; readonly input: ParseInput; readonly context: ParseContext }
type Core = Generator<ParseStep, BoardImport, Board | null>;

function* dispatch(raw: ParseInput, options: DispatchOptions, progress: Progress, depth: number): Core {
  const input = checkInput(raw);
  throwIfAborted(options.signal);
  progress.report(0, 'detect');
  const boards = options.adapters ?? BOARD_ADAPTERS, containers = depth === 0 ? options.containers ?? CONTAINER_ADAPTERS : [];
  const ranked = rankAdapters<FormatAdapter>(sniffInputOf(input), [...boards, ...containers]);
  if (input.options?.pinList?.mapping && /\.(csv|tsv|txt)$/i.test(input.name)) {
    const pinList = boards.find(adapter => adapter.id === 'pinlist');
    if (pinList) { const at = ranked.findIndex(candidate => candidate.adapter === pinList); if (at >= 0) ranked.splice(at, 1); ranked.unshift({ adapter: pinList, confidence: 89, reason: 'Explicit pin-list column mapping' }); }
  }
  const certain = ambiguousCandidates(ranked);
  if (certain.length) throw ambiguous(input.name, certain);
  for (const candidate of ranked) {
    throwIfAborted(options.signal);
    const adapter = candidate.adapter;
    if (adapter.kind === 'container') return yield* openContainer(adapter, input, boards, options, progress);
    checkBudgets(adapter, input);
    progress.report(PARSE_START, 'parse');
    let board: Board | null;
    const context = contextFor(adapter, input, options.signal, fraction => progress.report(PARSE_START + (PARSE_END - PARSE_START) * fraction, 'parse'));
    try { board = yield { adapter, input, context }; }
    catch (error) {
      if (error instanceof BoardFormatError || error instanceof GenCadParseError || isAbort(error)) throw error;
      if (error instanceof TextDecodeError) continue; // A UTF-16 BOM followed by garbage is not text this adapter can claim.
      const wrapped = new BoardFormatError(`${adapter.id}: unexpected parser failure: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_FORMAT', adapter.id);
      wrapped.cause = error; throw wrapped;
    }
    if (board) {
      checkOutput(adapter, board);
      progress.report(1, 'done');
      return { board, adapter: adapter.id, confidence: candidate.confidence, reason: candidate.reason };
    }
  }
  const extension = extensionOf(input.name);
  throw new BoardFormatError(`The content of "${fileLabel(input.name)}" (${extension || 'no extension'}) matched none of the supported boardview formats.`, 'UNRECOGNIZED');
}

const ARCHIVE = 'ZIP archive';
const listed = (paths: readonly string[]): string => paths.slice(0, 5).map(path => path.slice(0, 120)).join(', ') + (paths.length > 5 ? ', …' : '');
const folderOf = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1);
const several = (paths: readonly string[]) => localizedFormatError(`ZIP archive: it holds more than one board (${listed(paths)}); it is not opened, so that no board is guessed.`, 'UNSUPPORTED_VARIANT', { key: 'parse.error.archiveSeveralBoards', params: { entries: listed(paths) } }, ARCHIVE);

/**
 * The sniff view of the first bytes of a file whose full size is `size`, as the dispatcher would sniff the whole file:
 * byte-order-marked UTF-16 is re-encoded as UTF-8 (cut to whole code units); a head that ends before the file reports a
 * size beyond its own length, so the sniffs know the file continues.
 */
export function sniffHead(raw: Uint8Array, name: string, size: number): SniffInput {
  raw = raw.subarray(0, SNIFF_BYTES);
  const complete = raw.length >= size;
  if (!hasUtf16Mark(raw)) return { head: raw.subarray(0, SNIFF_BYTES), name, size: Math.max(size, raw.length) };
  let end = raw.length - (raw.length % 2);
  if (!complete && end >= 2) { const high = raw[0] === 0xff ? raw[end - 1] : raw[end - 2]; if (high >= 0xd8 && high <= 0xdb) end -= 2; }
  const units = raw.subarray(0, end), converted = utf16ToUtf8(units);
  if (converted === units) return { head: raw.subarray(0, SNIFF_BYTES), name, size: Math.max(size, raw.length) }; // undecodable UTF-16: the text adapters decline it, as for a plain file
  const head = converted.subarray(0, SNIFF_BYTES);
  return { head, name, size: complete && head.length === converted.length ? head.length : Math.max(size, head.length + 1) };
}
const memberSniffInput = (entry: ContainerEntry, name: string): SniffInput => sniffHead(entry.head(SNIFF_BYTES), name, entry.size);
interface Member { readonly entry: ContainerEntry; readonly best: Candidate<BoardAdapter>; readonly set?: readonly string[] }
/**
 * Opens the one board of an archive. Every member with a board extension is sniffed; members that some board reader is
 * at least LIKELY about are boards (when there are none, every recognized member counts). Members of one companion set
 * in one folder (the ASC trio) are one board. More than one board is refused with their names.
 */
function* openContainer(container: ContainerAdapter, input: ParseInput, boards: readonly BoardAdapter[], options: DispatchOptions, progress: Progress): Core {
  progress.report(0.02, 'unpack');
  const entries = container.open(input.data, input.name).filter(entry => !entry.skipped);
  const pro = boards.find(adapter => adapter.id === 'easyeda-pro');
  if (pro && entries.some(entry => entry.path.toLowerCase() === 'project.json') && entries.some(entry => /^pcb\/[^/]+\.epcb$/i.test(entry.path))) {
    return yield* dispatch(input, { ...options, adapters: [pro], containers: [] }, progress, 1);
  }
  const archive = fileLabel(input.name), stem = archive.replace(/\.[^.]*$/, '') || 'archive';
  const boardExtensions = new Set(boards.flatMap(adapter => adapter.extensions));
  const companionMembers = new Set(boards.flatMap(adapter => (adapter.companions?.sets ?? []).flatMap(set => [...set])));
  const candidates = entries.filter(entry => boardExtensions.has(extensionOf(entry.path)) || companionMembers.has(baseName(entry.path)));
  if (candidates.length > container.limits.maxCandidates) throw several(candidates.map(entry => entry.path));
  const namesByFolder = new Map<string, string[]>();
  for (const entry of entries) {
    const folder = folderOf(entry.path);
    const names = namesByFolder.get(folder) ?? [];
    names.push(baseName(entry.path)); namesByFolder.set(folder, names);
  }
  const members: Member[] = [];
  for (const entry of candidates) {
    throwIfAborted(options.signal);
    const memberHead = memberSniffInput(entry, `${stem}/${entry.path}`);
    if (rankAdapters(memberHead, CONTAINER_ADAPTERS).length) continue; // Never open a nested archive.
    const best = rankAdapters(memberHead, boards)[0];
    if (best) members.push({ entry, best, set: selectCompanionSet(best.adapter.companions?.sets ?? [], entry.path, namesByFolder.get(folderOf(entry.path)) ?? []) });
  }
  if (!members.length) throw localizedFormatError('ZIP archive: no entry is a board file TRACE can open.', 'UNRECOGNIZED', { key: 'parse.error.archiveNoBoard' }, ARCHIVE);
  const strong = members.filter(member => member.best.confidence >= LIKELY);
  const pool = strong.length ? strong : members;
  const groups = new Map<string, Member[]>();
  for (const member of pool) {
    const key = member.set ? `${member.best.adapter.id}\n${folderOf(member.entry.path)}\n${member.set.join('|')}` : `\n${member.entry.path}`;
    groups.set(key, [...groups.get(key) ?? [], member]);
  }
  // Members of one family TRACE recognizes but cannot read (the layers of a Gerber set) are explained by that family's refusal.
  const unreadable = pool.every(member => member.best.adapter === pool[0].best.adapter) && pool[0].best.adapter.capability.status === 'recognized-unsupported';
  if (groups.size > 1 && !unreadable) throw several(pool.map(member => member.entry.path));
  const group = unreadable ? [pool[0]] : [...groups.values()][0];
  const chosen = group.length > 1 ? [...group].sort((a, b) => a.set!.indexOf(baseName(a.entry.path)) - b.set!.indexOf(baseName(b.entry.path)))[0] : group[0];

  let budget = container.limits.maxExtractedBytes;
  const data = chosen.entry.read(budget);
  budget -= data.length;
  const companions: Record<string, Uint8Array> = {}, folder = folderOf(chosen.entry.path);
  for (const name of chosen.set ?? []) {
    if (name === baseName(chosen.entry.path)) continue;
    const sibling = entries.find(entry => folderOf(entry.path) === folder && baseName(entry.path) === name);
    if (!sibling) continue;
    throwIfAborted(options.signal);
    companions[name] = sibling.read(budget);
    budget -= companions[name].length;
  }
  progress.report(PARSE_START, 'unpack');
  const member: ParseInput = { name: `${stem}/${chosen.entry.path}`, data, ...(Object.keys(companions).length ? { companions } : {}), ...(input.options ? { options: input.options } : {}) };
  const result = yield* dispatch(member, { ...options, adapters: boards }, progress, 1);
  result.board.warnings.push({ key: 'parse.warning.archiveEntry', params: { entry: chosen.entry.path.slice(0, 200), archive } });
  return { ...result, container: container.id, entry: chosen.entry.path };
}

const isThenable = (value: unknown): value is PromiseLike<unknown> => typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';

/** Synchronous import: every adapter on the way must parse synchronously (all built-in ones do). */
export function parseBoardDetailed(input: ParseInput, options: DispatchOptions = {}): BoardImport {
  const core = dispatch(input, options, progressOf(options), 0);
  let step = core.next();
  while (!step.done) {
    const { adapter, input: stepInput, context } = step.value;
    let result: Board | null = null, failure: unknown, failed = false;
    try {
      const value = adapter.parse(stepInput, context);
      if (isThenable(value)) { void Promise.resolve(value).catch(() => {}); throw new BoardFormatError(`${adapter.id}: this reader is asynchronous; use parseBoardAsync.`, 'INVALID_FORMAT', adapter.id); }
      result = value;
    } catch (error) { failure = error; failed = true; }
    step = failed ? core.throw(failure) : core.next(result);
  }
  return step.value;
}
/** The board only (the dispatcher API used before adapter v2). */
export const parseBoard = (input: ParseInput): Board => parseBoardDetailed(input).board;

/** Asynchronous import with progress and cancellation; synchronous and asynchronous adapters both work. */
export async function parseBoardAsync(input: ParseInput, options: DispatchOptions = {}): Promise<BoardImport> {
  const core = dispatch(input, options, progressOf(options), 0);
  let step = core.next();
  while (!step.done) {
    const { adapter, input: stepInput, context } = step.value;
    let result: Board | null = null, failure: unknown, failed = false;
    try { result = await adapter.parse(stepInput, context); throwIfAborted(options.signal); }
    catch (error) { failure = error; failed = true; }
    step = failed ? core.throw(failure) : core.next(result);
  }
  return step.value;
}

/** What the dispatcher would consider for these bytes, strongest first (diagnostics and tests; nothing is parsed or unpacked). */
export function detectFormat(input: ParseInput, options: Pick<DispatchOptions, 'adapters' | 'containers'> = {}): Candidate[] {
  return rankAdapters<FormatAdapter>(sniffInputOf(checkInput(input)), [...options.adapters ?? BOARD_ADAPTERS, ...options.containers ?? CONTAINER_ADAPTERS]);
}

/** One candidate of a sniff-only look at a file, as plain data (structured-cloneable, frozen). */
export interface SniffCandidate {
  readonly id: string;
  readonly kind: 'board' | 'container';
  /** Display name of the format ("KiCad PCB"). */
  readonly format: string;
  readonly status: SupportStatus;
  readonly confidence: number;
  readonly reason: string;
  readonly variant?: string;
  readonly needsKey?: KeyKind;
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}
export interface BoardSniff {
  /** What the dispatcher would try first; undefined when no reader or container recognizes the head. */
  readonly best?: SniffCandidate;
  /** Every candidate, strongest first. */
  readonly candidates: readonly SniffCandidate[];
  /** Two board readers are certain about the head: opening the file would be refused as ambiguous. */
  readonly ambiguous: boolean;
}
/**
 * Sniff-only identification for listings and background scans: the first bytes of a file (at most SNIFF_BYTES are
 * looked at; pass the head, the file name and the full size), never a parse, never an unpack, no side effects. Byte-order
 * marked UTF-16 heads are re-encoded as the dispatcher would. Cheap and bounded (every sniff is linear in the head), safe
 * in a worker; the verdict equals the dispatcher's first candidate for the whole file, which can still decline it.
 */
export function sniffBoard(head: Uint8Array, name: string, size: number = head.length): BoardSniff {
  if (!(head instanceof Uint8Array)) throw new TypeError('sniffBoard: the head must be a byte array.');
  const ranked = rankAdapters<FormatAdapter>(sniffHead(head, String(name ?? ''), Number.isFinite(size) ? size : head.length), [...BOARD_ADAPTERS, ...CONTAINER_ADAPTERS]);
  const candidates = ranked.map(({ adapter, confidence, reason, variant, needsKey, meta }) => Object.freeze({
    id: adapter.id, kind: adapter.kind, format: adapter.name, status: adapter.capability.status, confidence, reason,
    ...(variant ? { variant } : {}), ...(needsKey ? { needsKey } : {}), ...(meta ? { meta } : {}),
  }));
  return Object.freeze({ ...(candidates[0] ? { best: candidates[0] } : {}), candidates: Object.freeze(candidates), ambiguous: ambiguousCandidates(ranked).length > 0 });
}
