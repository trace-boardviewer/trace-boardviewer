/**
 * TRACE readings pack: the shareable JSON file (`.trace-readings.json`, format `trace-readings`, version 1; docs/READINGS_FORMAT.md).
 *
 * A pack holds the board identity (fingerprint and version, optional label, board number, file keys and (ref, pin) set) and readings:
 * names and values, never geometry, file content, paths or user names (free texts hold only what was typed). The default licence is
 * CC0-1.0. A reading that carries another licence (an OpenBoardData value is ODbL-1.0) is "foreign" to a pack with a different
 * licence: `buildPack` leaves it out unless asked to mark it, and a marked pack lists every licence in `licenses`, keeps the
 * licence and provenance on each such reading, and is refused by `validatePack` (in both processes) when that list is missing.
 *
 * `serializePack` writes the header with two-space indentation and one reading per line; electron/readings.cjs writes the identical
 * bytes (the main process writes the file). `parsePack` is its inverse: parsePack(serializePack(p)) equals p for every valid pack.
 */
import { DEFAULT_PACK_LICENSE, READINGS_FORMAT, READINGS_VERSION, ReadingsError, validatePack, validateReading } from './schema';
import type { PackBoard, Reading, ReadingProvenance, ReadingsPack } from './schema';

/** Largest pack text accepted (characters). */
export const MAX_PACK_TEXT = 64 * 1024 * 1024;

export interface BuildPackOptions {
  board: PackBoard;
  /** SPDX id of the pack; default CC0-1.0. */
  license?: string;
  title?: string;
  attribution?: string;
  createdAt?: string;
  /** Readings licensed otherwise than the pack: left out (default) or kept and marked (their licence listed in `licenses`). */
  foreign?: 'exclude' | 'mark';
}
export interface BuiltPack {
  pack: ReadingsPack;
  /** Readings left out because their licence differs from the pack's (with `foreign: 'exclude'`). */
  excluded: Reading[];
}

/** Licence a reading is under inside a pack licensed `packLicense`. */
export const licenseOf = (reading: Reading, packLicense: string): string => reading.license ?? packLicense;

/** A validated pack of the given readings (the caller chose them). Throws a ReadingsError when the result would be invalid. */
export function buildPack(readings: readonly Reading[], options: BuildPackOptions): BuiltPack {
  const license = options.license ?? DEFAULT_PACK_LICENSE;
  const foreign = options.foreign ?? 'exclude';
  const kept: Reading[] = [];
  const excluded: Reading[] = [];
  const others = new Set<string>();
  for (const reading of readings) {
    const own = licenseOf(reading, license);
    if (own === license) { kept.push(reading); continue; }
    if (foreign === 'exclude') { excluded.push(reading); continue; }
    others.add(own);
    kept.push(reading);
  }
  const pack: Record<string, unknown> = { format: READINGS_FORMAT, version: READINGS_VERSION, license };
  if (others.size > 0) pack.licenses = [license, ...[...others].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
  if (options.title !== undefined) pack.title = options.title;
  if (options.attribution !== undefined) pack.attribution = options.attribution;
  if (options.createdAt !== undefined) pack.createdAt = options.createdAt;
  pack.board = options.board;
  pack.readings = kept;
  return { pack: validatePack(pack), excluded };
}

/** The pack file text: header indented by two spaces, the board on one line, one reading per line, a final newline. */
export function serializePack(pack: ReadingsPack): string {
  const lines: string[] = [];
  const field = (key: string, value: unknown) => lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  field('format', pack.format);
  field('version', pack.version);
  field('license', pack.license);
  if (pack.licenses !== undefined) field('licenses', pack.licenses);
  if (pack.title !== undefined) field('title', pack.title);
  if (pack.attribution !== undefined) field('attribution', pack.attribution);
  if (pack.createdAt !== undefined) field('createdAt', pack.createdAt);
  field('board', pack.board);
  const body = pack.readings.length === 0 ? '[]' : `[\n${pack.readings.map(reading => `    ${JSON.stringify(reading)}`).join(',\n')}\n  ]`;
  lines.push(`  "readings": ${body}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

export type PackParse = { ok: true; pack: ReadingsPack } | { ok: false; code: string; message: string };

/** Reads pack text (a UTF-8 BOM is ignored): JSON, then `validatePack`. Never throws. */
export function parsePack(text: string): PackParse {
  if (typeof text !== 'string') return { ok: false, code: 'READINGS_INVALID', message: 'Invalid readings: pack.' };
  if (text.length > MAX_PACK_TEXT) return { ok: false, code: 'READINGS_TOO_LARGE', message: 'The readings pack is too large.' };
  let raw: unknown;
  try { raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); }
  catch { return { ok: false, code: 'READINGS_INVALID', message: 'Invalid readings: the pack is not JSON.' }; }
  try { return { ok: true, pack: validatePack(raw) }; }
  catch (error) {
    if (error instanceof ReadingsError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Import into a family
// ---------------------------------------------------------------------------------------------------------------

export interface PlanImportOptions {
  /** Time of the import (ISO), written to the provenance of each reading that gets one here. */
  now: string;
  /** New id for a reading whose id is taken in the family by a different reading. */
  newId: () => string;
}
export interface ImportPlan {
  /** Readings to append (`reading.add`), already in their stored form. */
  readings: Reading[];
  /** Readings the family holds already in the same form (a second import of the same file adds nothing). */
  unchanged: number;
  /** Readings that got a new id because theirs was taken. */
  renamed: Array<{ from: string; to: string }>;
}

/** Identity of a stored reading for "already imported": its JSON without the time of the import. */
function importIdentity(reading: Reading): string {
  if (reading.provenance?.importedAt === undefined) return JSON.stringify(reading);
  const { importedAt: _ignored, ...provenance } = reading.provenance;
  return JSON.stringify({ ...reading, provenance });
}

/**
 * The stored form of readings that come from a file, and which of them are new for the family:
 *  - known-good readings become `imported`, with the reading's or the file's licence and a provenance (`origin`, the file's title and
 *    attribution, the original id as `sourceId`, the time of the import);
 *  - imported readings keep their licence (or take the file's) and provenance;
 *  - measured readings stay measured and get the licence and provenance the same way.
 * Everything else is unchanged; the result is validated.
 */
export function planImport(readings: readonly Reading[], file: { origin: ReadingProvenance['origin']; license: string; title?: string; attribution?: string },
  existing: ReadonlyMap<string, Reading> | null, options: PlanImportOptions): ImportPlan {
  const plan: ImportPlan = { readings: [], unchanged: 0, renamed: [] };
  const taken = new Set<string>();
  const known = new Map<string, string>();
  if (existing) for (const [id, reading] of existing) known.set(id, importIdentity(reading));
  for (const reading of readings) {
    const provenance: ReadingProvenance = reading.provenance ?? { origin: file.origin };
    if (!reading.provenance) {
      if (file.title !== undefined) provenance.title = file.title;
      if (file.attribution !== undefined) provenance.attribution = file.attribution;
      provenance.sourceId = reading.id;
      provenance.importedAt = options.now;
    }
    const stored = validateReading({
      ...reading,
      source: reading.source === 'known-good' ? 'imported' : reading.source,
      license: reading.license ?? file.license,
      provenance,
    });
    const identity = importIdentity(stored);
    const current = known.get(stored.id);
    if (current === identity) { plan.unchanged++; continue; }
    if (current !== undefined || taken.has(stored.id)) {
      let id = options.newId();
      while (known.has(id) || taken.has(id)) id = options.newId();
      plan.renamed.push({ from: stored.id, to: id });
      stored.id = id;
    }
    taken.add(stored.id);
    plan.readings.push(stored);
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------------------------
// Content audit
// ---------------------------------------------------------------------------------------------------------------

export interface PackAuditFinding { field: string; kind: 'path' | 'email' | 'url' }
const PATH_LIKE = /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]|\/(?:home|Users|root|mnt|media|var|tmp|etc)\/)/;
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_LIKE = /\b(?:https?|file|ftp):\/\//i;

/**
 * The "contains no file content" check before sharing. The schema has no field for geometry or file bytes, so a valid pack holds only
 * names, values and typed text; this lists typed text that looks like a local path, an e-mail address or a link, for the technician
 * to look at (typed text is allowed: the findings are a warning, not an error).
 */
export function auditPack(pack: ReadingsPack): PackAuditFinding[] {
  const findings: PackAuditFinding[] = [];
  const check = (field: string, text: string | undefined) => {
    if (text === undefined) return;
    if (PATH_LIKE.test(text)) findings.push({ field, kind: 'path' });
    if (EMAIL_LIKE.test(text)) findings.push({ field, kind: 'email' });
    if (URL_LIKE.test(text)) findings.push({ field, kind: 'url' });
  };
  check('title', pack.title);
  check('attribution', pack.attribution);
  check('board.label', pack.board.label);
  check('board.boardNumber', pack.board.boardNumber);
  pack.readings.forEach((reading, index) => {
    check(`readings[${index}].note`, reading.note);
    check(`readings[${index}].raw`, reading.raw);
    check(`readings[${index}].conditions.state`, reading.conditions.state);
    check(`readings[${index}].conditions.meter`, reading.conditions.meter);
    check(`readings[${index}].provenance.title`, reading.provenance?.title);
    check(`readings[${index}].provenance.attribution`, reading.provenance?.attribution);
  });
  return findings;
}
