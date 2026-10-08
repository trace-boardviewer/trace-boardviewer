/*
 * The records the generator keeps while it writes a library: contents (distinct bytes), items (files on disk and archive members),
 * families, and the pure step that turns them into the ground truth (strengths, groups, duplicate sets, part index).
 */
import type { Evidence, GroundTruth, ItemFlag, JoinStrength, LibraryKind, ProblemCode, Role, TruthDuplicateSet, TruthFamily, TruthGroup, TruthItem } from './ground-truth.ts';
import { GENERATOR_VERSION, GROUND_TRUTH_SCHEMA_VERSION } from './ground-truth.ts';

/** Distinct bytes. The bytes are rebuilt on demand by `build` (a pure function), never kept. */
export interface Content {
  id: number;
  kind: LibraryKind;
  format: string | null;
  variant?: string;
  role: Role;
  familyId: string | null;
  revision: string | null;
  flags: ItemFlag[];
  /** The board number sits in the content: 'header-id' (a format header) or 'title-id' (a title block). */
  idEvidence?: 'header-id' | 'title-id';
  fingerprint?: string;
  pinSetSize?: number;
  partNumbers?: string[];
  decoys?: string[];
  refCount?: number;
  coverage?: number;
  pages?: number;
  needsKey?: 'fz' | 'xzz';
  /** Evidence the content carries on its own, besides the unions (for example 'prose-mention'). */
  evidence: Set<Evidence>;
  size?: number;
  sha256?: string;
  build(): Uint8Array;
}

export interface Item {
  id: string;
  path: string;
  contentId: number;
  familyId: string | null;
  revision: string | null;
  role: Role;
  flags: ItemFlag[];
  /** Evidence from the names of the path, computed for the item's family. */
  nameEvidence: Evidence[];
  container?: { archive: string; entry: string };
  /** Directory key used for proximity ("" for archive members: their archive). */
  directory: string;
  mtimeMs: number;
  /** Members of nested archives are never opened by the library. */
  unreachable?: boolean;
  declaredSize?: number;
  size?: number;
  sha256?: string | null;
  /** Kind, format and variant of the item when they differ from the content's (a file of the wrong extension keeps the content's). */
  override?: Partial<Pick<TruthItem, 'kind' | 'format' | 'variant'>>;
}

export interface Union { a: number; b: number; evidence: Evidence }

class UnionFind {
  parent = new Map<number, number>();
  find(x: number): number {
    let root = x;
    while ((this.parent.get(root) ?? root) !== root) root = this.parent.get(root)!;
    let at = x;
    while (at !== root) { const next = this.parent.get(at) ?? at; this.parent.set(at, root); at = next; }
    return root;
  }
  union(a: number, b: number): void {
    const x = this.find(a), y = this.find(b);
    if (x !== y) this.parent.set(Math.max(x, y), Math.min(x, y));
  }
}

/** The error code the rules of the Library design give a file with these flags (a member of an archive, a damaged or encrypted file); undefined when it is fine. */
export function expectedProblem(flags: readonly ItemFlag[], member: boolean): ProblemCode | undefined {
  if (member && flags.includes('nested-archive')) return 'nested-archive';
  if (member && flags.includes('zip-slip')) return 'unsafe-entry';
  if (member && flags.includes('zip-bomb')) return 'too-large';
  if (flags.includes('encrypted-entry') || flags.includes('encrypted') || flags.includes('password-protected')) return 'encrypted';
  if (flags.includes('truncated')) return 'damaged';
  if (flags.includes('signature-only')) return 'unsupported-format';
  return undefined;
}

export interface FinalizeInput {
  options: GroundTruth['options'];
  families: TruthFamily[];
  contents: Map<number, Content>;
  items: Item[];
  unions: Union[];
  /** Pairs of contents that are re-saved copies of each other (same text, other bytes). */
  resaved: Array<[number, number]>;
  bytes: number;
}

/**
 * Ground truth from the records. The unions (strong evidence between two contents) form strong components; an item whose component
 * holds at least two distinct contents is "strong" (copies of one content are not a group of their own). Another item is "weak" when its names, its folder (a folder that holds a strong item of the
 * family) or a weak content clue point to the family, "none" otherwise. Archive members inside a nested archive are none (the
 * library does not open them).
 */
export function finalizeTruth(input: FinalizeInput): GroundTruth {
  const forest = new UnionFind();
  for (const union of input.unions) forest.union(union.a, union.b);
  const evidenceOf = new Map<number, Set<Evidence>>();
  const note = (contentId: number, evidence: Evidence): void => { (evidenceOf.get(contentId) ?? evidenceOf.set(contentId, new Set()).get(contentId)!).add(evidence); };
  for (const union of input.unions) { note(union.a, union.evidence); note(union.b, union.evidence); }
  for (const content of input.contents.values()) { for (const e of content.evidence) note(content.id, e); if (content.idEvidence) note(content.id, content.idEvidence); }

  // items per family and strong component
  const componentContents = new Map<string, Set<number>>();
  const componentKey = (item: Item): string => `${item.familyId}/${forest.find(item.contentId)}`;
  for (const item of input.items) if (item.familyId && !item.unreachable) { const key = componentKey(item); (componentContents.get(key) ?? componentContents.set(key, new Set()).get(key)!).add(item.contentId); }
  const componentSize = new Map<string, number>([...componentContents].map(([key, set]) => [key, set.size] as const));
  const componentName = new Map<string, string>();
  const componentCount = new Map<string, number>();
  const strongDirectories = new Map<string, Set<string>>();
  for (const item of input.items) {
    if (!item.familyId || item.unreachable) continue;
    const key = componentKey(item);
    if ((componentSize.get(key) ?? 0) < 2) continue;
    if (!componentName.has(key)) { const n = (componentCount.get(item.familyId) ?? 0) + 1; componentCount.set(item.familyId, n); componentName.set(key, `${item.familyId}.${n}`); }
    (strongDirectories.get(item.familyId) ?? strongDirectories.set(item.familyId, new Set()).get(item.familyId)!).add(item.directory);
  }
  const copies = new Map<number, number>();
  for (const item of input.items) copies.set(item.contentId, (copies.get(item.contentId) ?? 0) + 1);

  const truthItems: TruthItem[] = [];
  for (const item of input.items) {
    const content = input.contents.get(item.contentId)!;
    const evidence = new Set<Evidence>(evidenceOf.get(item.contentId) ?? []);
    for (const e of item.nameEvidence) evidence.add(e);
    let strength: JoinStrength = 'none';
    let component: string | null = null;
    if (item.familyId && !item.unreachable) {
      const key = componentKey(item);
      if ((componentSize.get(key) ?? 0) >= 2) { strength = 'strong'; component = componentName.get(key) ?? null; }
      else {
        const near = strongDirectories.get(item.familyId)?.has(item.directory) ?? false;
        if (near) evidence.add('proximity');
        const weakClues = item.nameEvidence.length > 0 || near || evidence.has('prose-mention') || evidence.has('partial-coverage') || evidence.has('revision-fingerprint') || evidence.has('bom-title');
        strength = weakClues ? 'weak' : 'none';
      }
    }
    if (item.unreachable) evidence.clear();
    else if ((copies.get(item.contentId) ?? 0) > 1) evidence.add('duplicate-content');
    const flags = [...new Set([...item.flags, ...content.flags])];
    const record: TruthItem = {
      id: item.id, path: item.path, ...(item.container ? { container: item.container } : {}), size: item.size ?? content.size ?? 0, sha256: item.sha256 === undefined ? content.sha256 ?? null : item.sha256,
      kind: item.override?.kind ?? content.kind, format: item.override?.format === undefined ? content.format : item.override.format, ...(item.override?.variant ?? content.variant ? { variant: item.override?.variant ?? content.variant } : {}),
      role: item.role, familyId: item.familyId, revision: item.revision, duplicateSet: null, joinStrength: strength, component, evidence: [...evidence].sort() as Evidence[], flags: flags.sort() as ItemFlag[],
      ...(content.fingerprint ? { fingerprint: content.fingerprint, pinSetSize: content.pinSetSize } : {}),
      ...(content.partNumbers?.length ? { partNumbers: content.partNumbers } : {}), ...(content.decoys?.length ? { decoys: content.decoys } : {}),
      ...(content.refCount !== undefined ? { refCount: content.refCount } : {}), ...(content.coverage !== undefined ? { coverage: content.coverage } : {}), ...(content.pages ? { pages: content.pages } : {}),
      ...(content.needsKey ? { needsKey: content.needsKey } : {}), ...(item.declaredSize !== undefined ? { declaredSize: item.declaredSize } : {}), mtimeMs: item.mtimeMs,
    };
    const problem = expectedProblem(flags, item.container !== undefined);
    if (problem) record.problem = problem;
    truthItems.push(record);
  }

  // duplicate sets: identical bytes (equal hash, whatever content made them) and re-saved documents
  const sets: TruthDuplicateSet[] = [];
  const byHash = new Map<string, TruthItem[]>();
  for (const record of truthItems) if (record.sha256 && record.size > 0) (byHash.get(record.sha256) ?? byHash.set(record.sha256, []).get(record.sha256)!).push(record);
  let setNumber = 0;
  for (const records of byHash.values()) {
    if (records.length < 2) continue;
    const id = `D${String(++setNumber).padStart(4, '0')}`;
    sets.push({ id, kind: 'identical', members: records.map(record => record.id) });
    for (const record of records) record.duplicateSet = id;
  }
  const byContent = new Map<number, TruthItem[]>();
  input.items.forEach((item, index) => { (byContent.get(item.contentId) ?? byContent.set(item.contentId, []).get(item.contentId)!).push(truthItems[index]); });
  for (const [a, b] of input.resaved) {
    const members = [...(byContent.get(a) ?? []), ...(byContent.get(b) ?? [])].map(record => record.id);
    if (members.length < 2) continue;
    sets.push({ id: `D${String(++setNumber).padStart(4, '0')}`, kind: 'resaved', members });
  }

  // groups: one per family with at least one strong or weak member
  const groups: TruthGroup[] = [];
  for (const family of input.families) {
    const members = truthItems.filter(record => record.familyId === family.id && (record.joinStrength === 'strong' || record.joinStrength === 'weak')).map(record => ({ item: record.id, strength: record.joinStrength, component: record.component }));
    if (!members.length) continue;
    groups.push({ id: `G${String(groups.length + 1).padStart(4, '0')}`, familyId: family.id, label: `${family.vendor} ${family.model} ${family.boardNumber}`, boardNumber: family.boardNumber, members });
  }

  const partIndex: Record<string, string[]> = {};
  for (const family of input.families) for (const revision of family.revisions) for (const part of revision.partNumbers) {
    const list = partIndex[part.exact] ?? (partIndex[part.exact] = []);
    if (!list.includes(family.id)) list.push(family.id);
  }
  const files = truthItems.filter(record => !record.container).length;
  return {
    schemaVersion: GROUND_TRUTH_SCHEMA_VERSION, generator: { name: 'trace-synthetic-library', version: GENERATOR_VERSION }, options: input.options,
    totals: { files, members: truthItems.length - files, bytes: input.bytes, families: input.families.length, groups: groups.length },
    families: input.families, items: truthItems, groups, duplicateSets: sets, partIndex,
  };
}
