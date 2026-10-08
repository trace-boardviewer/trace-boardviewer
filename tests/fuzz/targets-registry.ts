/**
 * Fuzz targets taken from the adapter registry that are not a parse: the sniff of every board adapter and container (total, bounded,
 * honest), every container (members listed without unpacking, each unpacked within a budget) and the sniff-only identification that the
 * file listings use. The lists come from the registry, so an adapter that is registered later is covered without a change here.
 */
import { MAX_MESSAGE_CHARS } from '../../src/lib/bounded-text';
import { BOARD_ADAPTERS, BoardFormatError, CONTAINER_ADAPTERS, sniffBoard } from '../../src/lib/formats';
import { CERTAIN, META_LIMIT, META_TEXT, SNIFF_BYTES } from '../../src/lib/formats/adapter';
import type { ContainerAdapter, FormatAdapter, SniffResult } from '../../src/lib/formats/adapter';
import { sniffHead, sniffInputOf } from '../../src/lib/formats/dispatch';
import type { FuzzTarget } from './targets';

const FORMAT_CODES: ReadonlySet<string> = new Set(['INVALID_FORMAT', 'UNRECOGNIZED', 'LIMIT_EXCEEDED', 'KEY_REQUIRED', 'INVALID_KEY', 'COMPANIONS_REQUIRED', 'UNSUPPORTED_VARIANT', 'WRONG_KIND', 'AMBIGUOUS_FORMAT']);
const isFormatError = (error: unknown): boolean => error instanceof BoardFormatError && FORMAT_CODES.has(error.code);

const META_KEY = /^[a-z][A-Za-z0-9]{0,31}$/;
/** What a sniff result must satisfy (adapter.ts, conformance.test.ts): a whole confidence from 0 to 100, a reason exactly when it is above 0, bounded metadata. */
export function checkSniffResult(result: SniffResult): string | null {
  if (typeof result !== 'object' || result === null) return 'the sniff did not return an object';
  const { confidence, reason, variant, needsKey, meta } = result;
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) return `a confidence of ${String(confidence)}`;
  if (typeof reason !== 'string' || (reason.length > 0) !== (confidence > 0)) return `a reason of ${typeof reason === 'string' ? reason.length : typeof reason} characters at confidence ${confidence}`;
  if (reason.length > MAX_MESSAGE_CHARS) return `a reason of ${reason.length} characters`;
  if (variant !== undefined && typeof variant !== 'string') return 'a variant that is not text';
  if (needsKey !== undefined && needsKey !== 'fz' && needsKey !== 'xzz') return `a key kind ${String(needsKey)}`;
  if (meta !== undefined) {
    const entries = Object.entries(meta);
    if (entries.length > META_LIMIT) return `${entries.length} metadata entries`;
    for (const [key, value] of entries) {
      if (!META_KEY.test(key)) return `a metadata key "${key.slice(0, 40)}"`;
      if (typeof value === 'string' ? value.length > META_TEXT : typeof value === 'number' ? !Number.isFinite(value) : typeof value !== 'boolean') return `metadata "${key}" is not a bounded text, a finite number or a boolean`;
    }
  }
  return null;
}

/** A sniff on the whole file, and on the first half of it given the size of the whole (the head of a file that goes on). */
const sniffTarget = (adapter: FormatAdapter): FuzzTarget => ({
  id: `sniff:${adapter.id}`, family: 'util', seeds: [adapter.id],
  run: input => ({
    whole: adapter.sniff(sniffInputOf(input)),
    head: adapter.sniff(sniffHead(input.data.subarray(0, input.data.length >> 1), input.name, input.data.length)),
  }),
  allowed: () => false,
  check: output => { const { whole, head } = output as { whole: SniffResult; head: SniffResult }; return checkSniffResult(whole) ?? checkSniffResult(head); },
  units: () => 1,
  digest: output => JSON.stringify(output),
});

/** The sniff-only identification of the file listings: ordered candidates, an honest ambiguity flag, nothing parsed or unpacked. */
const sniffBoardTarget = (): FuzzTarget => ({
  id: 'util:sniff-board', family: 'util', seeds: [...BOARD_ADAPTERS, ...CONTAINER_ADAPTERS].map(adapter => adapter.id),
  run: input => sniffBoard(input.data.subarray(0, SNIFF_BYTES), input.name, input.data.length),
  allowed: () => false,
  check: output => {
    const { best, candidates, ambiguous } = output as ReturnType<typeof sniffBoard>;
    const known = new Set([...BOARD_ADAPTERS, ...CONTAINER_ADAPTERS].map(adapter => adapter.id));
    let previous = 101, certain = 0;
    for (const candidate of candidates) {
      if (!known.has(candidate.id)) return `a candidate "${String(candidate.id).slice(0, 40)}" that is not registered`;
      if (!Number.isInteger(candidate.confidence) || candidate.confidence < 1 || candidate.confidence > 100) return `a candidate with confidence ${String(candidate.confidence)}`;
      if (candidate.confidence > previous) return 'the candidates are not ordered by confidence';
      previous = candidate.confidence;
      if (candidate.kind === 'board' && candidate.confidence >= CERTAIN) certain++;
      if (candidate.variant !== undefined && candidate.variant.length > META_TEXT) return 'a variant longer than the limit';
      if (candidate.meta && Object.keys(candidate.meta).length > META_LIMIT) return 'more metadata entries than the limit';
    }
    if (best !== candidates[0]) return 'best is not the first candidate';
    return ambiguous === certain > 1 ? null : 'the ambiguity flag does not match the candidates';
  },
  units: output => (output as ReturnType<typeof sniffBoard>).candidates.length,
  digest: output => JSON.stringify(output),
});

/** Most members unpacked per archive, and the budget of each, by the container target. */
const MEMBER_LIMIT = 48, MEMBER_BUDGET = 1 << 20;
/** A container lists its members without unpacking them and unpacks each within a budget: names stay inside the folder, sizes are declared and kept. */
const containerTarget = (adapter: ContainerAdapter): FuzzTarget => ({
  id: `container:${adapter.id}`, family: 'util', seeds: [adapter.id],
  run: input => {
    const entries = adapter.open(input.data, input.name);
    let unpacked = 0, refused = 0;
    for (const entry of entries.slice(0, MEMBER_LIMIT)) {
      if (entry.skipped) continue;
      if (!entry.path || entry.path.includes('\0') || entry.path.includes('\\') || entry.path.startsWith('/') || /^[A-Za-z]:/.test(entry.path) || entry.path.split('/').includes('..')) throw new Error(`a member offered under the name "${entry.path.slice(0, 60)}"`);
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`a member of size ${String(entry.size)}`);
      const head = entry.head(4096);
      if (!(head instanceof Uint8Array) || head.length > 4096 || head.length > entry.size) throw new Error(`a head of ${head.length} bytes for a member of ${entry.size}`);
      try {
        const bytes = entry.read(MEMBER_BUDGET);
        if (bytes.length !== entry.size) throw new Error(`a member of the declared size ${entry.size} gave ${bytes.length} bytes`);
        unpacked += bytes.length;
      } catch (error) {
        if (!isFormatError(error)) throw error;
        refused++;
      }
    }
    return { entries: entries.length, unpacked, refused };
  },
  allowed: isFormatError,
  check: output => {
    const { entries, unpacked } = output as { entries: number; unpacked: number };
    return entries > adapter.limits.maxEntries ? `${entries} members (limit ${adapter.limits.maxEntries})` : unpacked > MEMBER_LIMIT * MEMBER_BUDGET ? `${unpacked} bytes unpacked` : null;
  },
  units: output => (output as { entries: number }).entries,
  digest: output => JSON.stringify(output),
});

export const registryTargets = (): FuzzTarget[] => [
  ...[...BOARD_ADAPTERS, ...CONTAINER_ADAPTERS].map(sniffTarget),
  ...CONTAINER_ADAPTERS.map(containerTarget),
  sniffBoardTarget(),
];
