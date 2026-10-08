/**
 * The state of one board family in the repair store and how events change it. Pure TypeScript.
 *
 * Twin of the reducer in electron/readings.cjs (the store in the main process applies the same rules before it writes): same order
 * of checks, same codes, same messages; `readings-parity.test.ts` runs both on one corpus. Two steps, so an append is all or nothing:
 *  - `checkEvents(state, events)` throws for the first event that cannot apply, without changing anything;
 *  - `applyEvents(state, events)` applies events that passed the check (in place: a 100k-reading family is never copied per append).
 *
 * Rules: the first event of a family is `family.create` (and only the first); `reading.add` needs a new id, `reading.replace` and
 * `reading.remove` an existing one (also counting the earlier events of the same call); `family.link` adds a board (or the new file
 * keys of a board already in the family); a family holds at most `READINGS_LIMITS.readings` readings, `members` boards and
 * `fileKeys` file keys per board. Readings keep their insertion order; a replaced reading keeps its place.
 */
import { READINGS_LIMITS, ReadingsError } from './schema';
import type { FamilyHeader, FamilyMember, Reading, ReadingsPack, RepairEvent } from './schema';

export interface ReadingsState {
  family: FamilyHeader;
  /** Current readings by id, in insertion order. */
  readings: Map<string, Reading>;
}

const L = READINGS_LIMITS;

/** Adds a board to the family header, or the file keys (and the label) it brings to a board the family already has. In place. */
export function mergeMember(family: FamilyHeader, member: FamilyMember): void {
  const existing = family.members.find(item => item.fingerprint === member.fingerprint);
  if (!existing) { family.members.push({ ...member, fileKeys: [...member.fileKeys] }); return; }
  for (const key of member.fileKeys) if (!existing.fileKeys.includes(key)) existing.fileKeys.push(key);
  if (existing.label === undefined && member.label !== undefined) existing.label = member.label;
}

/** The header with another name, keys in the canonical order of `validateFamilyHeader`. */
function renamed(family: FamilyHeader, name: string): FamilyHeader {
  const next: FamilyHeader = { id: family.id, name, createdAt: family.createdAt, members: family.members };
  if (family.pinSet !== undefined) next.pinSet = family.pinSet;
  return next;
}

function memberLimits(family: FamilyHeader, member: FamilyMember, index: number): void {
  const existing = family.members.find(item => item.fingerprint === member.fingerprint);
  if (!existing) {
    if (family.members.length >= L.members) throw new ReadingsError('READINGS_INVALID', `Invalid readings: events[${index}].member (a family holds at most ${L.members} boards).`);
    return;
  }
  let keys = existing.fileKeys.length;
  for (const key of member.fileKeys) if (!existing.fileKeys.includes(key)) keys++;
  if (keys > L.fileKeys) throw new ReadingsError('READINGS_INVALID', `Invalid readings: events[${index}].member.fileKeys (a board holds at most ${L.fileKeys} file keys).`);
}

/**
 * Throws the first reason why `events` cannot apply to `state` (null: the family does not exist yet), changing nothing. `familyId`,
 * when given, is the family the events are for: a `family.create` must carry that id.
 */
export function checkEvents(state: ReadingsState | null, events: readonly RepairEvent[], familyId?: string): void {
  let family: FamilyHeader | null = state ? state.family : null;
  // Changes of this call, simulated without touching the state: ids added and removed, and a scratch header for member limits.
  const added = new Set<string>();
  const removed = new Set<string>();
  let count = state ? state.readings.size : 0;
  let scratch: FamilyHeader | null = null;
  const has = (id: string): boolean => added.has(id) || (state !== null && state.readings.has(id) && !removed.has(id));
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.type === 'family.create') {
      if (family) throw new ReadingsError('READINGS_FAMILY_EXISTS', `Readings conflict: events[${index}] creates a board family that exists already.`);
      if (familyId !== undefined && event.family.id !== familyId) throw new ReadingsError('READINGS_INVALID', `Invalid readings: events[${index}].family.id (another family).`);
      family = event.family;
      continue;
    }
    if (!family) throw new ReadingsError('READINGS_NO_FAMILY', `Readings conflict: events[${index}] needs a board family; the first event of a family is family.create.`);
    switch (event.type) {
      case 'family.link':
        scratch ??= { ...family, members: family.members.map(member => ({ ...member, fileKeys: [...member.fileKeys] })) };
        memberLimits(scratch, event.member, index);
        mergeMember(scratch, event.member);
        break;
      case 'family.rename':
        break;
      case 'reading.add':
        if (has(event.reading.id)) throw new ReadingsError('READINGS_CONFLICT', `Readings conflict: events[${index}] adds reading ${event.reading.id}, which exists already.`);
        if (removed.has(event.reading.id)) removed.delete(event.reading.id); else added.add(event.reading.id);
        if (++count > L.readings) throw new ReadingsError('READINGS_TOO_MANY', `At most ${L.readings} readings can be saved for one board family.`);
        break;
      case 'reading.replace':
        if (!has(event.reading.id)) throw new ReadingsError('READINGS_CONFLICT', `Readings conflict: events[${index}] replaces reading ${event.reading.id}, which does not exist.`);
        break;
      case 'reading.remove':
        if (!has(event.id)) throw new ReadingsError('READINGS_CONFLICT', `Readings conflict: events[${index}] removes reading ${event.id}, which does not exist.`);
        if (added.has(event.id)) added.delete(event.id); else removed.add(event.id);
        count--;
        break;
    }
  }
}

/** Applies events that passed `checkEvents`. Mutates and returns `state`; a `family.create` makes the state when there is none. */
export function applyEvents(state: ReadingsState | null, events: readonly RepairEvent[]): ReadingsState {
  let current = state;
  for (const event of events) {
    if (event.type === 'family.create') {
      current = { family: { ...event.family, members: event.family.members.map(member => ({ ...member, fileKeys: [...member.fileKeys] })) }, readings: new Map() };
      continue;
    }
    if (!current) throw new ReadingsError('READINGS_NO_FAMILY', 'Readings conflict: the first event of a family is family.create.');
    switch (event.type) {
      case 'family.link': mergeMember(current.family, event.member); break;
      case 'family.rename': current.family = renamed(current.family, event.name); break;
      case 'reading.add': case 'reading.replace': current.readings.set(event.reading.id, event.reading); break;
      case 'reading.remove': current.readings.delete(event.id); break;
    }
  }
  if (!current) throw new ReadingsError('READINGS_NO_FAMILY', 'Readings conflict: the first event of a family is family.create.');
  return current;
}

/** A family as the store returns it (`trace:read-readings`): the readings as the text of one JSON array (see `parseFamilySnapshot`). */
export interface RawFamilySnapshot {
  family: FamilyHeader;
  /** Sequence number of the last append the state includes. */
  seq: number;
  readingCount: number;
  /** Absent when only the header was asked for. */
  readings?: string;
  /** Present when damaged log lines were set aside on load (they are kept in a copy next to the log). */
  damaged?: { lines: number; bytes: number };
}
export interface FamilySnapshot extends Omit<RawFamilySnapshot, 'readings'> { readings: Reading[] }

/**
 * The readings of a raw snapshot. The main process validated every reading before it was written and checks the files by CRC on
 * load, so the text is parsed, not validated again (100k readings: one JSON.parse). Throws when the text is not the array it promises.
 */
export function parseFamilySnapshot(raw: RawFamilySnapshot): FamilySnapshot {
  const readings: unknown = raw.readings === undefined ? [] : JSON.parse(raw.readings);
  if (!Array.isArray(readings) || (raw.readings !== undefined && readings.length !== raw.readingCount)) {
    throw new ReadingsError('READINGS_UNREADABLE', 'The readings of the board family do not match their count.');
  }
  const snapshot: FamilySnapshot = { family: raw.family, seq: raw.seq, readingCount: raw.readingCount, readings: readings as Reading[] };
  if (raw.damaged) snapshot.damaged = raw.damaged;
  return snapshot;
}

/** The renderer-side state of a family as the store returned it. */
export function stateFromSnapshot(snapshot: Pick<FamilySnapshot, 'family' | 'readings'>): ReadingsState {
  return { family: snapshot.family, readings: new Map(snapshot.readings.map(reading => [reading.id, reading])) };
}

/** A family as the store lists it: the header without its pin set, plus the pin count of that set. */
export interface FamilySummary {
  id: string;
  name?: string;
  createdAt: string;
  members: FamilyMember[];
  /** Pairs in the family's (ref, pin) set; absent when the family has none. */
  pairCount?: number;
  readingCount?: number;
  /** Sequence number of the family's last append. */
  seq?: number;
}
/** What `trace:list-readings-families` lists: a family, or one whose files cannot be read (left unchanged on disk). */
export type FamilyListEntry = FamilySummary | { id: string; unreadable: true };
export const readableFamilies = (entries: readonly FamilyListEntry[]): FamilySummary[] => entries.filter((entry): entry is FamilySummary => !('unreadable' in entry));
/** `trace:append-readings`: the sequence number of the record and the family's reading count after it. */
export interface AppendResult { seq: number; readingCount: number }
/** `trace:import-readings`: the picked file's base name (never its path), size and text; null when the dialog was cancelled. */
export interface ReadingsImportFile { name: string; bytes: number; text: string }
/** `trace:export-readings`: the pack to write (validated again natively) as a pack file or as CSV, and the suggested file name. */
export interface ReadingsExportRequest { format: 'pack' | 'csv'; pack: ReadingsPack; name?: string }
export interface ReadingsExportResult { name: string; bytes: number; readings: number }
