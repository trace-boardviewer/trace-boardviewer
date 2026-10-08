/*
 * Metrics runner: scores what a Library grouping did with a synthetic library against the generator's ground truth.
 *
 * The result format (`LibraryResult`) is deliberately small, so a test, the benchmark script or a harness over the real service can
 * produce it: groups of item ids with a tier per member, and optionally the part numbers found in each item and the sets of
 * identical files. `fromLibraryGroups` in contract.ts converts the Library's own `LibraryGroup` records.
 *
 * Definitions (all counts are over unordered pairs of items, an item being a file or an archive member):
 *   wrong-join rate   pairs of automatic members of one group that are not the same board family (a file with no family is never
 *                     the same family as anything), over all pairs of automatic members of one group. Target <= 0.005.
 *   strong recall     pairs inside one strong component of the truth that the result put into one group as automatic members,
 *                     over all such pairs. Target >= 0.95.
 *   part precision    for documents with a text layer, part numbers returned that the document prints (or whose base number it
 *                     prints) over all part numbers returned. Target >= 0.98.
 *   part recall       printed part numbers returned over printed part numbers, at precision above. Target >= 0.8.
 *   suggestion precision   suggested members whose family is the family of the group's automatic members, over all suggested members.
 *   duplicate recall / precision   identical-file pairs found against the truth's identical sets.
 * Metrics whose input is missing in the result (no `parts`, no `duplicates`) are null and are not checked.
 */
import { mpnBase } from './board-model.ts';
import type { GroundTruth, TruthItem } from './ground-truth.ts';
import { validateJson } from './json-schema.ts';

export const RESULT_VERSION = 1;

export interface ResultMember { item: string; tier: 'automatic' | 'suggested' }
export interface ResultGroup { id: string; members: ResultMember[] }
export interface LibraryResult {
  version: typeof RESULT_VERSION;
  groups: ResultGroup[];
  /** Part numbers extracted per item id. An item that is not listed returned none. */
  parts?: Record<string, string[]>;
  /** Sets of items the result found to be byte-identical. */
  duplicates?: Array<{ items: string[] }>;
}

export const RESULT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Library grouping result',
  description: 'What a grouping of a synthetic library produced, in the form the metrics runner scores.',
  type: 'object',
  required: ['version', 'groups'],
  additionalProperties: false,
  properties: {
    version: { const: RESULT_VERSION },
    groups: { type: 'array', items: { $ref: '#/$defs/group' } },
    parts: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
    duplicates: { type: 'array', items: { type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', minItems: 2, items: { type: 'string' } } } } },
  },
  $defs: {
    group: {
      type: 'object', required: ['id', 'members'], additionalProperties: false,
      properties: {
        id: { type: 'string' },
        members: { type: 'array', items: { type: 'object', required: ['item', 'tier'], additionalProperties: false, properties: { item: { type: 'string' }, tier: { type: 'string', enum: ['automatic', 'suggested'] } } } },
      },
    },
  },
} as const;

/** The grouping thresholds of the Library design (targets to measure, not results). */
export const TARGETS = Object.freeze({ maxWrongJoinRate: 0.005, minStrongRecall: 0.95, minPartPrecision: 0.98, minPartRecall: 0.8 });

export interface LibraryMetrics {
  groups: { total: number; automaticMembers: number; suggestedMembers: number; pairs: number; wrongPairs: number; wrongJoinRate: number };
  strong: { components: number; pairs: number; joined: number; recall: number };
  suggestions: { members: number; right: number; precision: number | null };
  parts: { documents: number; truth: number; returned: number; correct: number; found: number; decoyHits: number; precision: number | null; recall: number | null } | null;
  duplicates: { truthPairs: number; foundPairs: number; correct: number; precision: number | null; recall: number | null } | null;
  /** Problems with the result itself: unknown items, an item in two groups. */
  problems: string[];
}

const pairs = (n: number): number => (n * (n - 1)) / 2;
const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

/** Problems of a result that is not even in the format (empty when the shape is right). */
export function validateResult(result: unknown): string[] {
  return validateJson(RESULT_SCHEMA as unknown as Record<string, unknown>, result);
}

const normalize = (token: string): string => token.trim().toUpperCase();

export function scoreResult(truth: GroundTruth, result: LibraryResult): LibraryMetrics {
  const byId = new Map<string, TruthItem>(truth.items.map(item => [item.id, item]));
  const problems: string[] = [];
  const seen = new Map<string, string>();

  // groups
  let automaticMembers = 0, suggestedMembers = 0, groupPairs = 0, rightPairs = 0, suggestedRight = 0;
  const strongOf = new Map<string, string>();
  const componentSizes = new Map<string, number>();
  for (const item of truth.items) if (item.component) { strongOf.set(item.id, item.component); componentSizes.set(item.component, (componentSizes.get(item.component) ?? 0) + 1); }
  let joined = 0;
  for (const group of result.groups) {
    const families = new Map<string, number>(), components = new Map<string, number>();
    const suggested: TruthItem[] = [];
    let automatic = 0;
    for (const member of group.members) {
      const item = byId.get(member.item);
      if (!item) { if (problems.length < 20) problems.push(`group ${group.id}: unknown item "${member.item}"`); continue; }
      const earlier = seen.get(member.item);
      if (earlier !== undefined && earlier !== group.id) { if (problems.length < 20) problems.push(`item "${member.item}" is in groups ${earlier} and ${group.id}`); continue; }
      seen.set(member.item, group.id);
      if (member.tier === 'suggested') { suggested.push(item); suggestedMembers++; continue; }
      automatic++; automaticMembers++;
      if (item.familyId) families.set(item.familyId, (families.get(item.familyId) ?? 0) + 1);
      const component = strongOf.get(item.id);
      if (component) components.set(component, (components.get(component) ?? 0) + 1);
    }
    groupPairs += pairs(automatic);
    for (const count of families.values()) rightPairs += pairs(count);
    for (const count of components.values()) joined += pairs(count);
    let majority: string | null = null, best = 0;
    for (const [family, count] of families) if (count > best || (count === best && majority !== null && family < majority)) { majority = family; best = count; }
    for (const item of suggested) if (majority !== null && item.familyId === majority) suggestedRight++;
  }
  let strongPairs = 0;
  for (const size of componentSizes.values()) strongPairs += pairs(size);

  // part numbers
  let parts: LibraryMetrics['parts'] = null;
  if (result.parts) {
    let documents = 0, expected = 0, returned = 0, correct = 0, found = 0, decoyHits = 0;
    for (const item of truth.items) {
      if (!item.partNumbers?.length && !item.decoys?.length) continue;
      if (item.kind !== 'pdf') continue;
      documents++;
      const printed = new Set((item.partNumbers ?? []).map(normalize));
      const accepted = new Set<string>();
      for (const token of printed) { accepted.add(token); accepted.add(normalize(mpnBase(token))); }
      const decoys = new Set((item.decoys ?? []).map(normalize));
      const got = new Set((result.parts[item.id] ?? []).map(normalize));
      expected += printed.size;
      returned += got.size;
      for (const token of got) {
        if (accepted.has(token) || accepted.has(normalize(mpnBase(token)))) correct++;
        else if (decoys.has(token)) decoyHits++;
      }
      for (const token of printed) if (got.has(token) || got.has(normalize(mpnBase(token)))) found++;
    }
    parts = { documents, truth: expected, returned, correct, found, decoyHits, precision: ratio(correct, returned), recall: ratio(found, expected) };
  }

  // duplicates
  let duplicates: LibraryMetrics['duplicates'] = null;
  if (result.duplicates) {
    const truthSet = new Set<string>();
    for (const set of truth.duplicateSets) {
      if (set.kind !== 'identical') continue;
      const members = [...set.members].sort();
      for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) truthSet.add(`${members[a]}\u0000${members[b]}`);
    }
    const foundSet = new Set<string>();
    for (const set of result.duplicates) {
      const members = [...new Set(set.items)].sort();
      for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) foundSet.add(`${members[a]}\u0000${members[b]}`);
    }
    let correct = 0;
    for (const pair of foundSet) if (truthSet.has(pair)) correct++;
    duplicates = { truthPairs: truthSet.size, foundPairs: foundSet.size, correct, precision: ratio(correct, foundSet.size), recall: ratio(correct, truthSet.size) };
  }

  return {
    groups: { total: result.groups.length, automaticMembers, suggestedMembers, pairs: groupPairs, wrongPairs: groupPairs - rightPairs, wrongJoinRate: groupPairs ? (groupPairs - rightPairs) / groupPairs : 0 },
    strong: { components: componentSizes.size, pairs: strongPairs, joined, recall: strongPairs ? joined / strongPairs : 1 },
    suggestions: { members: suggestedMembers, right: suggestedRight, precision: ratio(suggestedRight, suggestedMembers) },
    parts, duplicates, problems,
  };
}

export interface TargetCheck { metric: string; value: number | null; target: number; comparison: '<=' | '>='; pass: boolean }

/** The target checks of the Library design for the metrics that were measured. A metric without data is not checked. */
export function checkTargets(metrics: LibraryMetrics, targets = TARGETS): TargetCheck[] {
  const checks: TargetCheck[] = [
    { metric: 'wrong-join rate', value: metrics.groups.wrongJoinRate, target: targets.maxWrongJoinRate, comparison: '<=', pass: metrics.groups.wrongJoinRate <= targets.maxWrongJoinRate },
    { metric: 'strong-evidence recall', value: metrics.strong.recall, target: targets.minStrongRecall, comparison: '>=', pass: metrics.strong.recall >= targets.minStrongRecall },
  ];
  if (metrics.parts) {
    checks.push({ metric: 'part-number precision', value: metrics.parts.precision, target: targets.minPartPrecision, comparison: '>=', pass: (metrics.parts.precision ?? 0) >= targets.minPartPrecision });
    checks.push({ metric: 'part-number recall', value: metrics.parts.recall, target: targets.minPartRecall, comparison: '>=', pass: (metrics.parts.recall ?? 0) >= targets.minPartRecall });
  }
  return checks;
}

/** Metrics that got worse than a stored baseline by more than `tolerance` (an absolute amount of the 0-1 metric). */
export function regressions(current: LibraryMetrics, baseline: LibraryMetrics, tolerance = 0.002): string[] {
  const out: string[] = [];
  if (current.groups.wrongJoinRate > baseline.groups.wrongJoinRate + tolerance) out.push(`wrong-join rate ${current.groups.wrongJoinRate} > ${baseline.groups.wrongJoinRate}`);
  if (current.strong.recall < baseline.strong.recall - tolerance) out.push(`strong recall ${current.strong.recall} < ${baseline.strong.recall}`);
  if (current.parts && baseline.parts) {
    if ((current.parts.precision ?? 0) < (baseline.parts.precision ?? 0) - tolerance) out.push(`part precision ${current.parts.precision} < ${baseline.parts.precision}`);
    if ((current.parts.recall ?? 0) < (baseline.parts.recall ?? 0) - tolerance) out.push(`part recall ${current.parts.recall} < ${baseline.parts.recall}`);
  }
  return out;
}

/**
 * The result a precision-first library with perfect evidence would give: one group per strong component with its items as
 * automatic members, the weak items of a family suggested into the family's largest component, the printed part numbers and the
 * identical sets.
 */
export function oracleResult(truth: GroundTruth): LibraryResult {
  const groups = new Map<string, ResultGroup>();
  const sizeOf = new Map<string, number>();
  for (const item of truth.items) if (item.component) {
    const group = groups.get(item.component) ?? groups.set(item.component, { id: item.component, members: [] }).get(item.component)!;
    group.members.push({ item: item.id, tier: 'automatic' });
    sizeOf.set(item.component, (sizeOf.get(item.component) ?? 0) + 1);
  }
  const largest = new Map<string, string>();
  for (const [component, size] of sizeOf) {
    const family = component.slice(0, component.indexOf('.'));
    const known = largest.get(family);
    if (known === undefined || size > sizeOf.get(known)! || (size === sizeOf.get(known)! && component < known)) largest.set(family, component);
  }
  for (const item of truth.items) if (item.joinStrength === 'weak' && item.familyId) {
    const target = largest.get(item.familyId);
    if (target) groups.get(target)!.members.push({ item: item.id, tier: 'suggested' });
  }
  const parts: Record<string, string[]> = {};
  for (const item of truth.items) if (item.kind === 'pdf' && item.partNumbers?.length) parts[item.id] = [...item.partNumbers];
  const duplicates = truth.duplicateSets.filter(set => set.kind === 'identical').map(set => ({ items: [...set.members] }));
  return { version: RESULT_VERSION, groups: [...groups.values()], parts, duplicates };
}
