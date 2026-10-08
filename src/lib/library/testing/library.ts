/*
 * The synthetic library generator. `generateLibrary` writes a deterministic library (family by family, then the special cases,
 * then the filler that uses up the byte budget) into a sink and returns the ground truth. Same options, same bytes.
 *
 * Phases and the file budget (`files` counts files on disk; archive members are extra):
 *   1. families, until `files - special - filler` files exist; a feedback loop on the observed bytes per file sets the size of
 *      the next family, so the families use about 70 % of the byte budget;
 *   2. the special cases (hostile archives, empty and signature-only files, once each) and generic files up to `files - filler`;
 *   3. `filler` large opaque files that use what is left of the byte budget (never more).
 */
import { addFiller, addGenericFile, addGuaranteed } from './chaos.ts';
import { Engine } from './engine.ts';
import type { LibrarySink } from './engine.ts';
import { generateFamily } from './families.ts';
import type { FamilyRun } from './families.ts';
import type { GroundTruth } from './ground-truth.ts';
import { makeCollections } from './layout.ts';
import type { LibraryOptions, ResolvedOptions } from './presets.ts';
import { resolveOptions } from './presets.ts';
import { finalizeTruth } from './records.ts';

export interface LibraryStats {
  files: number;
  members: number;
  bytes: number;
  families: number;
  /** Files by kind, then by format, as the ground truth says. */
  kinds: Record<string, number>;
  formats: Record<string, number>;
  roles: Record<string, number>;
  duplicateSets: number;
  /** Share of the files that are byte copies of another file. */
  duplicateShare: number;
  ms: number;
}

export interface GeneratedLibrary { truth: GroundTruth; stats: LibraryStats; options: ResolvedOptions }

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Bytes per file at scale 1 before the first family is measured. */
const INITIAL_BYTES_PER_FILE = 70_000;

export function generateLibrary(input: Partial<LibraryOptions> & { preset?: LibraryOptions['preset'] }, sink: LibrarySink, engineOptions: { cacheBytes?: number } = {}): GeneratedLibrary {
  const started = Date.now();
  const options = resolveOptions(input);
  const e = new Engine(options, sink, engineOptions.cacheBytes);
  const rng = e.root.fork('library');
  const fileCount = options.files;
  const fillerSlots = clamp(Math.round(fileCount * 0.01), 2, 1000);
  const specialShare = options.hostile ? 0.07 : 0.04;
  const run: FamilyRun = { collections: makeCollections(rng.fork('collections'), clamp(Math.round(fileCount / 700), 2, 12)), chains: new Map(), numbers: new Set(), recent: [], families: [] };

  // phase 1: families
  const familyLimit = fileCount - fillerSlots - Math.round(fileCount * specialShare);
  e.limit = familyLimit;
  e.scale = clamp(options.bytes / fileCount / INITIAL_BYTES_PER_FILE, 0.1, 10);
  let unit: number | null = null;
  let familyIndex = 0;
  while (e.diskFiles < familyLimit) {
    const files = e.diskFiles, bytes = e.diskBytes, scale = e.scale;
    generateFamily(e, run, familyIndex++);
    const added = e.diskFiles - files;
    if (added > 0) {
      const observed = (e.diskBytes - bytes) / added / scale;
      unit = unit === null ? observed : unit * 0.7 + observed * 0.3;
      const desired = (options.bytes * 0.72 - e.diskBytes) / Math.max(1, familyLimit - e.diskFiles);
      const next = clamp(desired / Math.max(1, unit), 0.1, 10);
      // the first families may move the scale a lot (the first guess is rough), later ones only a little
      const step = familyIndex <= 6 ? 2.5 : 1.6;
      e.scale = clamp(Math.sqrt(e.scale * next), e.scale / step, e.scale * step);
    }
    if (familyIndex > fileCount) throw new Error('the generator made no progress');
  }

  // phase 2: special cases and generic files
  e.limit = fileCount - fillerSlots;
  if (options.hostile && fileCount >= 100) addGuaranteed(e, run);
  for (let n = 0; e.hasRoom(); n++) if (!addGenericFile(e, run, n)) break;

  // phase 3: filler
  e.limit = fileCount;
  addFiller(e, run, fillerSlots);
  if (e.diskBytes > options.bytes) throw new RangeError(`the library needs ${e.diskBytes} bytes, more than the budget of ${options.bytes}: raise --bytes or lower --files`);

  const truth = finalizeTruth({
    options: { files: fileCount, bytes: options.bytes, seed: options.seed, preset: options.preset },
    families: run.families, contents: e.contents, items: e.items, unions: e.unions, resaved: e.resaved, bytes: e.diskBytes,
  });
  return { truth, stats: statsOf(truth, Date.now() - started), options };
}

export function statsOf(truth: GroundTruth, ms: number): LibraryStats {
  const kinds: Record<string, number> = {}, formats: Record<string, number> = {}, roles: Record<string, number> = {};
  let copies = 0;
  for (const item of truth.items) {
    if (item.container) continue;
    kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
    const format = item.format ?? 'none';
    formats[format] = (formats[format] ?? 0) + 1;
    roles[item.role] = (roles[item.role] ?? 0) + 1;
    if (item.flags.includes('copy')) copies++;
  }
  const sorted = (record: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(record).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  return {
    files: truth.totals.files, members: truth.totals.members, bytes: truth.totals.bytes, families: truth.totals.families, kinds: sorted(kinds), formats: sorted(formats), roles: sorted(roles),
    duplicateSets: truth.duplicateSets.length, duplicateShare: truth.totals.files ? copies / truth.totals.files : 0, ms,
  };
}

/** A library held in memory (tests): the files by path, and the ground truth. */
export interface MemoryLibrary extends GeneratedLibrary { files: Map<string, Uint8Array>; mtimes: Map<string, number> }

export function generateMemoryLibrary(input: Partial<LibraryOptions> & { preset?: LibraryOptions['preset'] }): MemoryLibrary {
  const files = new Map<string, Uint8Array>(), mtimes = new Map<string, number>();
  const generated = generateLibrary(input, { writeFile: file => { const key = file.path.join('/'); files.set(key, file.bytes); mtimes.set(key, file.mtimeMs); } }, { cacheBytes: Infinity });
  return { ...generated, files, mtimes };
}
