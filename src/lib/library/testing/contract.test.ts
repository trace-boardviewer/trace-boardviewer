import { describe, expect, it } from 'vitest';
import type { DuplicateSet, LibraryGroup, PartTerm } from '../model';
import { EVIDENCE_KINDS, FILE_ROLES, LIBRARY_ERRORS, LIBRARY_KINDS } from '../model';
import { EVIDENCE_TO_CONTRACT, duplicatesFromSets, fromLibraryGroups, libraryResult, partsFromTerms } from './contract';
import { EVIDENCE, KINDS, PROBLEM_CODES, ROLES } from './ground-truth';
import { generateMemoryLibrary } from './library';
import { checkTargets, scoreResult, validateResult } from './metrics';

describe('the ground truth speaks the contract of the Library', () => {
  it('uses the kinds, roles and error codes of model.ts, not copies of them', () => {
    expect(KINDS).toBe(LIBRARY_KINDS);
    expect(ROLES).toBe(FILE_ROLES);
    expect(PROBLEM_CODES).toBe(LIBRARY_ERRORS);
  });

  it('names every kind of evidence in the contract\'s terms', () => {
    expect(Object.keys(EVIDENCE_TO_CONTRACT).sort()).toEqual([...EVIDENCE].sort());
    for (const mapped of Object.values(EVIDENCE_TO_CONTRACT)) if (mapped !== null) expect(EVIDENCE_KINDS).toContain(mapped);
  });

  it('gives each generated item a kind and role the contract has, and problem codes only where the Library design gives one', () => {
    const library = generateMemoryLibrary({ files: 200, bytes: 14 * 1024 * 1024, seed: 'contract' });
    const problems = new Map<string, number>();
    for (const item of library.truth.items) {
      expect(LIBRARY_KINDS).toContain(item.kind);
      expect(FILE_ROLES).toContain(item.role);
      if (item.problem) problems.set(item.problem, (problems.get(item.problem) ?? 0) + 1);
    }
    expect([...problems.keys()].sort()).toEqual(['damaged', 'encrypted', 'nested-archive', 'too-large', 'unsafe-entry', 'unsupported-format']);
    const byId = new Map(library.truth.items.map(item => [item.id, item]));
    for (const item of library.truth.items) {
      if (item.problem === 'unsafe-entry') expect(item.flags).toContain('zip-slip');
      if (item.problem === 'too-large') expect(item.flags).toContain('zip-bomb');
      if (item.problem === 'unsupported-format') expect(['rar', '7z']).toContain(item.format);
      if (item.problem === 'damaged') expect(item.flags).toContain('truncated');
      if (item.problem === 'nested-archive') expect(item.container).toBeDefined();
      if (item.flags.includes('zip-slip') && item.container) expect(byId.get(item.container.archive)!.flags).toContain('zip-slip');
    }
  });
});

describe('converting the Library\'s records into a scorable result', () => {
  const evidence = { kind: 'id-content' as const, a: 'c1', b: 'c2', strength: 'strong' as const, score: 1 };
  const group = (id: string, members: Array<[string, 'automatic' | 'suggested' | 'user']>): LibraryGroup => ({
    id, label: id, updated: 0, tags: [], members: members.map(([contentId, tier]) => ({ contentId, role: 'board' as const, tier, evidence: [evidence] })),
  });

  it('expands contents to the files that hold them, and keeps suggestions apart from automatic members', () => {
    const files: Record<string, string[]> = { c1: ['a/one.bvr', 'b/copy.bvr'], c2: ['a/two.pdf'], c3: ['x/three.pdf'], c4: ['u.txt'] };
    const groups = fromLibraryGroups([group('g1', [['c1', 'automatic'], ['c2', 'automatic'], ['c3', 'suggested'], ['c4', 'user']])], contentId => files[contentId] ?? []);
    expect(groups).toEqual([{ id: 'g1', members: [
      { item: 'a/one.bvr', tier: 'automatic' }, { item: 'b/copy.bvr', tier: 'automatic' }, { item: 'a/two.pdf', tier: 'automatic' }, { item: 'x/three.pdf', tier: 'suggested' }, { item: 'u.txt', tier: 'automatic' },
    ] }]);
    expect(validateResult({ version: 1, groups })).toEqual([]);
  });

  it('leaves the text tier out of the part numbers unless asked, and keeps identical-file sets', () => {
    const term = (norm: string, tier: PartTerm['tier']): PartTerm => ({ norm, tier, source: 'title-block', refs: [], additionalRefs: 0, pages: [1] });
    const documents = [{ items: ['a.pdf', 'copy.pdf'], terms: [term('QXM1234', 'known'), term('VLR55', 'near-ref'), term('HELLO1', 'text'), term('QXM1234', 'board-confirmed')] }];
    expect(partsFromTerms(documents)).toEqual({ 'a.pdf': ['QXM1234', 'VLR55'], 'copy.pdf': ['QXM1234', 'VLR55'] });
    expect(partsFromTerms(documents, ['text'])['a.pdf']).toEqual(['HELLO1']);
    const sets: DuplicateSet[] = [
      { id: 'd1', kind: 'identical', fileIds: ['f1', 'f2', 'f9'], contentIds: ['c1'], evidence: [] }, { id: 'd2', kind: 'name-clash', fileIds: ['f3', 'f4'], contentIds: [], evidence: [] },
      { id: 'd3', kind: 'archive-copy', fileIds: ['f5', 'f6'], contentIds: ['c2'], evidence: [] }, { id: 'd4', kind: 'identical', fileIds: ['f7', 'f8'], contentIds: [], evidence: [] },
    ];
    const ids: Record<string, string> = { f1: 'p/1', f2: 'p/2', f5: 'p/5', f6: 'z.zip!/5', f7: 'p/7' };
    expect(duplicatesFromSets(sets, fileId => ids[fileId])).toEqual([{ items: ['p/1', 'p/2'] }, { items: ['p/5', 'z.zip!/5'] }]);
  });

  it('scores the Library\'s groups built from a truth like any other result', () => {
    const library = generateMemoryLibrary({ files: 120, bytes: 8 * 1024 * 1024, seed: 'convert' });
    const itemsOfContent = new Map<string, string[]>();
    for (const item of library.truth.items) if (item.sha256) (itemsOfContent.get(item.sha256) ?? itemsOfContent.set(item.sha256, []).get(item.sha256)!).push(item.id);
    const byComponent = new Map<string, Set<string>>();
    for (const item of library.truth.items) if (item.component && item.sha256) (byComponent.get(item.component) ?? byComponent.set(item.component, new Set()).get(item.component)!).add(item.sha256);
    const groups = [...byComponent].map(([component, contents]): LibraryGroup => group(component, [...contents].map(sha => [sha, 'automatic'] as [string, 'automatic'])));
    const result = libraryResult({ groups, itemsOf: sha => itemsOfContent.get(sha) ?? [] });
    const metrics = scoreResult(library.truth, result);
    expect(metrics.problems).toEqual([]);
    expect(metrics.strong.recall).toBe(1);
    expect(metrics.groups.wrongJoinRate).toBe(0);
    expect(checkTargets(metrics).filter(check => check.value !== null).every(check => check.pass)).toBe(true);
  }, 60_000);
});
