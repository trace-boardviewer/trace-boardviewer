/**
 * Which board family the open board belongs to, by the three steps of board-fingerprint.ts:
 *  1. same file   - a member of a family lists the open file's key: applied automatically;
 *  2. same fingerprint - a member has the open board's fingerprint (same version): applied automatically, with a notice;
 *  3. similar     - the (ref, pin) set of a family is at least 95 % like the open board's (Jaccard): OFFERED with the lists of pins that
 *                   exist on one side only, and applied only on the technician's confirmation (a `family.link` event).
 * Nothing is linked silently. Families are summaries from the store (`trace:list-readings-families`); the pin sets needed for step 3 are
 * loaded only for the candidates `similarCandidates` names (a Jaccard of 0.95 needs pin counts within 5 % of each other).
 */
import { FINGERPRINT_VERSION, SIMILAR_THRESHOLD, matchBoard, pinSetSize } from '../board-fingerprint';
import type { BoardRecord, PinRef, PinSet } from '../board-fingerprint';
import type { FamilySummary } from './model';
import type { FamilyHeader, FamilyMember, RepairEvent } from './schema';

export type { FamilySummary };

export interface OpenBoard extends BoardRecord { pinSet: PinSet }

export type FamilyMatch =
  | { kind: 'same-file'; familyId: string }
  | { kind: 'same-fingerprint'; familyId: string }
  | { kind: 'similar'; candidates: Array<{ familyId: string; similarity: number; unmatchedRecorded: PinRef[]; unmatchedOpen: PinRef[] }> }
  | { kind: 'none' };

/** Families whose pin count allows a similarity of at least `threshold` with a board of `pairs` pins (their pin sets are worth loading). */
export function similarCandidates(families: readonly FamilySummary[], pairs: number, threshold: number = SIMILAR_THRESHOLD): string[] {
  if (pairs === 0) return [];
  return families.filter(family => {
    const count = family.pairCount;
    if (count === undefined || count === 0) return false;
    return Math.min(count, pairs) / Math.max(count, pairs) >= threshold;
  }).map(family => family.id);
}

/**
 * The family of the open board. `pinSets` holds the pin sets of the similar candidates (by family id); families without one are
 * matched by file key and fingerprint only. Similar candidates are ordered by similarity, best first.
 */
export function matchFamily(families: readonly FamilySummary[], open: OpenBoard, pinSets: ReadonlyMap<string, PinSet> = new Map(), threshold: number = SIMILAR_THRESHOLD): FamilyMatch {
  if (open.fileKey) {
    const byFile = families.find(family => family.members.some(member => member.fileKeys.includes(open.fileKey!)));
    if (byFile) return { kind: 'same-file', familyId: byFile.id };
  }
  if (pinSetSize(open.pinSet) === 0) return { kind: 'none' };
  const byFingerprint = families.find(family => family.members.some(member => member.fingerprintVersion === FINGERPRINT_VERSION && member.fingerprint === open.fingerprint));
  if (byFingerprint) return { kind: 'same-fingerprint', familyId: byFingerprint.id };
  const candidates: Array<{ familyId: string; similarity: number; unmatchedRecorded: PinRef[]; unmatchedOpen: PinRef[] }> = [];
  for (const family of families) {
    const pinSet = pinSets.get(family.id);
    if (!pinSet) continue;
    const match = matchBoard({ fingerprint: '', pinSet }, open, threshold);
    if (match.kind === 'similar') candidates.push({ familyId: family.id, similarity: match.similarity, unmatchedRecorded: match.unmatchedRecorded, unmatchedOpen: match.unmatchedOpen });
  }
  if (candidates.length === 0) return { kind: 'none' };
  candidates.sort((a, b) => (b.similarity - a.similarity) || (a.familyId < b.familyId ? -1 : 1));
  return { kind: 'similar', candidates };
}

/** The first event of a new family for the open board: its id is the board's fingerprint (a convention; any 64-hex id is valid). */
export function createFamilyEvent(open: OpenBoard, options: { now: string; name?: string; label?: string; keepPinSet?: boolean }): RepairEvent {
  const member: FamilyMember = { fingerprint: open.fingerprint, fingerprintVersion: FINGERPRINT_VERSION, fileKeys: open.fileKey ? [open.fileKey] : [] };
  if (options.label !== undefined) member.label = options.label;
  const family: FamilyHeader = { id: open.fingerprint, createdAt: options.now, members: [member] };
  if (options.name !== undefined) family.name = options.name;
  if (options.keepPinSet !== false && pinSetSize(open.pinSet) > 0) family.pinSet = open.pinSet;
  // Key order of validateFamilyHeader.
  const ordered: FamilyHeader = { id: family.id, ...(family.name !== undefined ? { name: family.name } : {}), createdAt: family.createdAt, members: family.members, ...(family.pinSet ? { pinSet: family.pinSet } : {}) };
  return { type: 'family.create', family: ordered };
}

/** The event that adds the open board to a family: after a confirmed similar match, or a known fingerprint seen in a new file. */
export function linkEvent(open: OpenBoard, options: { similarity?: number; label?: string } = {}): RepairEvent {
  const member: FamilyMember = { fingerprint: open.fingerprint, fingerprintVersion: FINGERPRINT_VERSION, fileKeys: open.fileKey ? [open.fileKey] : [] };
  if (options.label !== undefined) member.label = options.label;
  return options.similarity === undefined ? { type: 'family.link', member } : { type: 'family.link', member, similarity: options.similarity };
}

/** True when the family does not list the open file yet (a `family.link` would add its key). */
export function needsLink(family: Pick<FamilyHeader, 'members'>, open: OpenBoard): boolean {
  const member = family.members.find(item => item.fingerprint === open.fingerprint);
  return !member || (open.fileKey !== undefined && !member.fileKeys.includes(open.fileKey));
}
