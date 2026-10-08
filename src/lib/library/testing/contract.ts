/*
 * The bridge between the Library's own records (src/lib/library/model.ts) and the synthetic library's ground truth and metrics:
 * the evidence vocabulary of the truth in the contract's terms, and converters that turn groups, part terms and duplicate sets of
 * the Library into the `LibraryResult` the metrics runner scores.
 */
import type { DuplicateSet, LibraryGroup, PartTerm } from '../model.ts';
import { EVIDENCE_KINDS } from '../model.ts';
import type { Evidence } from './ground-truth.ts';
import type { LibraryResult, ResultGroup } from './metrics.ts';
import { RESULT_VERSION } from './metrics.ts';

export type ContractEvidence = (typeof EVIDENCE_KINDS)[number];

/**
 * What each kind of evidence in the ground truth is called in the contract. The truth names what a file carries (a header, a title
 * block, a folder name); the contract names the test between two contents. `null`: not an evidence edge of its own (identical copies
 * are one content).
 */
export const EVIDENCE_TO_CONTRACT: Readonly<Record<Evidence, ContractEvidence | null>> = {
  'header-id': 'id-content',
  'title-id': 'id-content',
  fingerprint: 'fingerprint',
  coverage: 'doc-coverage',
  'structured-link': 'structured-link',
  'duplicate-content': null,
  'name-id': 'id-name',
  'name-model': 'id-name',
  'folder-id': 'id-name',
  'folder-model': 'id-name',
  proximity: 'proximity',
  'prose-mention': 'id-name',
  'bom-title': 'id-name',
  'partial-coverage': 'doc-coverage',
  'revision-fingerprint': 'layout-similar',
};

/**
 * The scored form of the Library's groups. `itemsOf` maps a content id to the ids of the files that hold it (the truth's item ids:
 * paths, or "<archive path>!/<entry>"): a member is a content, and every file of a content joins the group with it. 'user' members
 * are decisions, not evidence, and count as automatic.
 */
export function fromLibraryGroups(groups: readonly LibraryGroup[], itemsOf: (contentId: string) => readonly string[]): LibraryResult['groups'] {
  return groups.map((group): ResultGroup => ({
    id: group.id,
    members: group.members.flatMap(member => itemsOf(member.contentId).map(item => ({ item, tier: member.tier === 'suggested' ? ('suggested' as const) : ('automatic' as const) }))),
  }));
}

/**
 * The part numbers of the Library's part terms as the result format wants them. Terms of the 'text' tier are searchable but ranked
 * last and not offered as part numbers, so they are left out unless asked for.
 */
export function partsFromTerms(documents: ReadonlyArray<{ items: readonly string[]; terms: readonly PartTerm[] }>, tiers: ReadonlyArray<PartTerm['tier']> = ['known', 'near-ref', 'board-confirmed']): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const document of documents) {
    const found = [...new Set(document.terms.filter(term => tiers.includes(term.tier)).map(term => term.norm))];
    for (const item of document.items) out[item] = found;
  }
  return out;
}

/** Identical-file sets of the Library as the result format wants them (identical copies and copies inside archives). */
export function duplicatesFromSets(sets: readonly DuplicateSet[], itemOf: (fileId: string) => string | undefined): NonNullable<LibraryResult['duplicates']> {
  const out: NonNullable<LibraryResult['duplicates']> = [];
  for (const set of sets) {
    if (set.kind !== 'identical' && set.kind !== 'archive-copy') continue;
    const items = set.fileIds.map(itemOf).filter((item): item is string => item !== undefined);
    if (items.length >= 2) out.push({ items });
  }
  return out;
}

export function libraryResult(parts: { groups: readonly LibraryGroup[]; itemsOf: (contentId: string) => readonly string[]; parts?: Record<string, string[]>; duplicates?: LibraryResult['duplicates'] }): LibraryResult {
  return { version: RESULT_VERSION, groups: fromLibraryGroups(parts.groups, parts.itemsOf), ...(parts.parts ? { parts: parts.parts } : {}), ...(parts.duplicates ? { duplicates: parts.duplicates } : {}) };
}
