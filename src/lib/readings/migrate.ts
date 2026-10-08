/**
 * Opt-in migration of the values typed into pin notes (`measurements.voltage`, `.resistance`, `.other`) into readings.
 *
 * Lossless: the notes are not changed; each reading keeps the field text verbatim in `raw`, the note's time as `takenAt`, and a
 * provenance `{ origin: 'note', sourceId: <note id> }`. What cannot be read exactly is not migrated and is listed with the reason (a
 * field longer than a reading's `raw` text can hold is one of them: it would not be kept verbatim).
 * Idempotent: the id of a reading is derived from the note id and the field (`note-<hash>-<field>`), so a second run plans nothing
 * for readings the family already holds (pass their ids in `existingIds`).
 *
 * Rules: only keyed pin notes (a reference and a pin number, no position fallback: readings hold no geometry) are migrated. The
 * voltage field is a voltage taken powered, the resistance field a resistance taken unpowered (a resistance cannot be measured on a
 * powered board; a voltage needs power). The free `other` field is migrated only when it names its kind: "diode" (diode mode,
 * unpowered) or "beep" / "continuity" (continuity, unpowered); anything else stays in the note.
 */
import type { BoardNote, KeyedNote } from '../types';
import { fnv1a64 } from './ids';
import { READINGS_LIMITS, isTimestamp, validateReading } from './schema';
import type { Reading, ReadingKind, ReadingSource } from './schema';
import { parseReadingValue } from './value';

export type NoteField = 'voltage' | 'resistance' | 'other';
export type MigrationSkip = 'not-keyed' | 'not-a-pin' | 'anchored' | 'ambiguous' | 'unparsed' | 'too-long' | 'exists';
export interface NoteMigrationPlan {
  readings: Reading[];
  migrated: Array<{ noteId: string; field: NoteField; readingId: string; assumedMillivolts?: true }>;
  skipped: Array<{ noteId: string; field?: NoteField; reason: MigrationSkip }>;
}
export interface NoteMigrationOptions {
  /** Source of the new readings; default measured (a note holds what was measured on the board in hand). */
  source?: Exclude<ReadingSource, 'imported'>;
  /** Ids the family holds already. */
  existingIds?: ReadonlySet<string>;
}

/** Id of the reading migrated from one field of one note (the same note and field always give the same id). */
export const noteReadingId = (noteId: string, field: NoteField): string => `note-${fnv1a64(noteId)}-${field}`;

const DIODE_WORD = /\b(?:diode|dio)\b|^d\s+|\s+d$/i;
const CONTINUITY_WORD = /\b(?:beep|continuity|cont)\b/i;

/** Kind and value text of a field; null when the field does not name what it is. */
function readField(field: NoteField, text: string): { kind: ReadingKind; text: string } | null {
  if (field === 'voltage') return { kind: 'voltage', text };
  if (field === 'resistance') return { kind: 'resistance', text };
  if (CONTINUITY_WORD.test(text)) {
    const rest = text.replace(CONTINUITY_WORD, ' ').replace(/[:=]/g, ' ').trim();
    return { kind: 'continuity', text: rest === '' ? 'beep' : rest };
  }
  if (DIODE_WORD.test(text)) return { kind: 'diode', text: text.replace(DIODE_WORD, ' ').replace(/[:=]/g, ' ').trim() };
  return null;
}

const isPinNote = (note: KeyedNote): boolean => note.target.ref !== undefined && note.target.pin !== undefined;
const isAnchored = (note: KeyedNote): boolean => note.target.at !== undefined || note.target.pinAt !== undefined;

export function planNoteMigration(notes: readonly BoardNote[], options: NoteMigrationOptions = {}): NoteMigrationPlan {
  const plan: NoteMigrationPlan = { readings: [], migrated: [], skipped: [] };
  const source = options.source ?? 'measured';
  for (const note of notes) {
    if (!note.measurements) continue;
    if (!('target' in note)) { plan.skipped.push({ noteId: note.id, reason: 'not-keyed' }); continue; }
    if (isAnchored(note)) { plan.skipped.push({ noteId: note.id, reason: 'anchored' }); continue; }
    if (!isPinNote(note)) { plan.skipped.push({ noteId: note.id, reason: 'not-a-pin' }); continue; }
    for (const field of ['voltage', 'resistance', 'other'] as const) {
      const text = note.measurements[field];
      if (text === undefined || text.trim() === '') continue;
      const id = noteReadingId(note.id, field);
      if (options.existingIds?.has(id)) { plan.skipped.push({ noteId: note.id, field, reason: 'exists' }); continue; }
      if (text.length > READINGS_LIMITS.raw) { plan.skipped.push({ noteId: note.id, field, reason: 'too-long' }); continue; }
      const read = readField(field, text);
      if (!read) { plan.skipped.push({ noteId: note.id, field, reason: 'ambiguous' }); continue; }
      const parsed = parseReadingValue(read.text, read.kind);
      if (!parsed.ok) { plan.skipped.push({ noteId: note.id, field, reason: 'unparsed' }); continue; }
      const raw: Record<string, unknown> = { id, kind: read.kind, target: { ref: note.target.ref, pin: note.target.pin } };
      if ('connected' in parsed) raw.connected = parsed.connected;
      else if ('ol' in parsed) raw.ol = true;
      else { raw.value = parsed.value; raw.unit = parsed.unit; }
      raw.raw = text;
      raw.conditions = { power: read.kind === 'voltage' ? 'powered' : 'unpowered' };
      raw.source = source;
      raw.provenance = { origin: 'note', sourceId: note.id.slice(0, READINGS_LIMITS.sourceId) };
      if (isTimestamp(note.updatedAt)) raw.takenAt = note.updatedAt;
      let reading: Reading;
      try { reading = validateReading(raw); } catch { plan.skipped.push({ noteId: note.id, field, reason: 'unparsed' }); continue; }
      plan.readings.push(reading);
      plan.migrated.push('assumedMillivolts' in parsed ? { noteId: note.id, field, readingId: id, assumedMillivolts: true } : { noteId: note.id, field, readingId: id });
    }
  }
  return plan;
}
