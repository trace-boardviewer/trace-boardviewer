/*
 * Options and presets of the synthetic library generator. The three sizes: small (unit tests),
 * medium (nightly), scale (local benchmark with a 10 to 20 GB budget).
 */
import type { BenchGenCad } from './bench-boards.ts';
import type { Hasher } from './sha256.ts';

export const PRESET_NAMES = ['small', 'medium', 'scale'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

const MIB = 1024 * 1024;
export const PRESETS: Readonly<Record<PresetName, Readonly<{ files: number; bytes: number }>>> = {
  small: { files: 400, bytes: 32 * MIB },
  medium: { files: 5_000, bytes: 1024 * MIB },
  scale: { files: 100_000, bytes: 15 * 1024 * MIB },
};

/** Fewest bytes per file the generator can honour (a board of a few dozen parts, one page of a schematic). */
export const MIN_BYTES_PER_FILE = 24 * 1024;
export const MAX_FILES = 400_000;
export const MAX_BYTES = 64 * 1024 * MIB;

export interface LibraryOptions {
  /** Number of files on disk (archive members are extra). */
  files: number;
  /** Upper bound of the total size of the files on disk; the generator lands at 90 to 100 % of it when the file count allows. */
  bytes: number;
  /** Any text or number: the same seed and options always give the same bytes. */
  seed: string | number;
  /** Recorded in the ground truth. */
  preset?: PresetName | null;
  /** The benchmark's GenCAD board generator; without it every board comes from the model generator. */
  benchGenCad?: BenchGenCad | null;
  /** Share of the families whose first revision is a benchmark board (0 to 1, default 0.3 when `benchGenCad` is given). */
  benchShare?: number;
  /** Hash function of file contents (default: a dependency-free SHA-256; the script passes Node's). */
  hasher?: Hasher;
  /** Leaves out the hostile cases (bombs, zip-slip, nested archives, signature-only archives, encrypted entries). */
  hostile?: boolean;
}

export interface ResolvedOptions extends LibraryOptions { seed: string; preset: PresetName | null; hostile: boolean }

/** Checks the options and fills the defaults; throws a RangeError that names the problem. */
export function resolveOptions(input: Partial<LibraryOptions> & { preset?: PresetName | null }): ResolvedOptions {
  const preset = input.preset ?? null;
  if (preset !== null && !PRESET_NAMES.includes(preset)) throw new RangeError(`preset "${preset}" is not one of ${PRESET_NAMES.join(', ')}`);
  const defaults = preset ? PRESETS[preset] : null;
  const files = input.files ?? defaults?.files;
  const bytes = input.bytes ?? defaults?.bytes;
  if (files === undefined || bytes === undefined) throw new RangeError('give --files and --bytes, or a --preset');
  if (!Number.isInteger(files) || files < 20 || files > MAX_FILES) throw new RangeError(`files must be an integer from 20 to ${MAX_FILES}`);
  if (!Number.isInteger(bytes) || bytes > MAX_BYTES) throw new RangeError(`bytes must be an integer of at most ${MAX_BYTES}`);
  if (bytes < files * MIN_BYTES_PER_FILE) throw new RangeError(`${files} files need a budget of at least ${files * MIN_BYTES_PER_FILE} bytes (${MIN_BYTES_PER_FILE} per file)`);
  if (input.seed === undefined || String(input.seed) === '') throw new RangeError('give a seed');
  const share = input.benchShare;
  if (share !== undefined && !(share >= 0 && share <= 1)) throw new RangeError('benchShare must be from 0 to 1');
  return { ...input, files, bytes, seed: String(input.seed), preset, hostile: input.hostile !== false };
}

/** Parses "--bytes" values such as 5000000, 64M, 32MiB, 1.5G or 2GiB (binary units). */
export function parseByteSize(text: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?\s*$/i.exec(text);
  if (!match) throw new RangeError(`"${text}" is not a size such as 64M or 2G`);
  const unit = { '': 1, k: 1024, m: MIB, g: 1024 * MIB, t: 1024 * 1024 * MIB }[match[2].toLowerCase() as '' | 'k' | 'm' | 'g' | 't'];
  return Math.floor(Number(match[1]) * unit);
}
