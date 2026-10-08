import { describe, expect, it } from 'vitest';
import type { GroundTruth, TruthItem } from './ground-truth';
import { GENERATOR_VERSION, GROUND_TRUTH_SCHEMA_VERSION } from './ground-truth';
import { generateMemoryLibrary } from './library';
import type { LibraryResult } from './metrics';
import { RESULT_VERSION, checkTargets, oracleResult, regressions, scoreResult, validateResult } from './metrics';

function item(id: string, familyId: string | null, component: string | null, extra: Partial<TruthItem> = {}): TruthItem {
  return {
    id, path: id, size: 10, sha256: id.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a').slice(0, 64), kind: 'board', format: 'bvr', role: 'board', familyId, revision: null, duplicateSet: null,
    joinStrength: component ? 'strong' : 'none', component, evidence: [], flags: [], ...extra,
  };
}

/**
 * Two families. F0001: a1 a2 a3 a4 and the schematic p1 form one strong component, a5 is weak. F0002: b1 b2 b3 and p2 form one.
 * u1 and u2 belong to no family. Strong pairs: C(5,2) + C(4,2) = 16.
 */
function handTruth(): GroundTruth {
  const items: TruthItem[] = [
    item('a1', 'F0001', 'F0001.1'), item('a2', 'F0001', 'F0001.1'), item('a3', 'F0001', 'F0001.1'), item('a4', 'F0001', 'F0001.1'), item('a5', 'F0001', null, { joinStrength: 'weak' }),
    item('b1', 'F0002', 'F0002.1'), item('b2', 'F0002', 'F0002.1'), item('b3', 'F0002', 'F0002.1'),
    item('u1', null, null), item('u2', null, null),
    item('p1', 'F0001', 'F0001.1', { kind: 'pdf', format: 'pdf', role: 'schematic', partNumbers: ['QXM1234LTR', 'VLR5678'], decoys: ['100NF', 'PP3V3_S0'] }),
    item('p2', 'F0002', 'F0002.1', { kind: 'pdf', format: 'pdf', role: 'schematic', partNumbers: ['ZTN9001/NOPB'], decoys: ['1UF'] }),
  ];
  return {
    schemaVersion: GROUND_TRUTH_SCHEMA_VERSION, generator: { name: 'test', version: GENERATOR_VERSION }, options: { files: items.length, bytes: 1000, seed: 'hand', preset: null },
    totals: { files: items.length, members: 0, bytes: 100, families: 2, groups: 2 }, families: [], items, groups: [],
    duplicateSets: [{ id: 'D0001', kind: 'identical', members: ['a1', 'b1'] }, { id: 'D0002', kind: 'identical', members: ['a2', 'a3', 'a4'] }], partIndex: {},
  };
}

const automatic = (...ids: string[]) => ids.map(id => ({ item: id, tier: 'automatic' as const }));
const result = (groups: LibraryResult['groups'], more: Partial<LibraryResult> = {}): LibraryResult => ({ version: RESULT_VERSION, groups, ...more });

describe('grouping metrics on a hand-made truth', () => {
  const truth = handTruth();
  // F0001 strong component is a1 a2 a3 a4 p1 (5 items: 10 pairs); F0002 is b1 b2 b3 p2 (4 items: 6 pairs): 16 strong pairs
  const perfect = result([{ id: 'g1', members: [...automatic('a1', 'a2', 'a3', 'a4', 'p1'), { item: 'a5', tier: 'suggested' }] }, { id: 'g2', members: automatic('b1', 'b2', 'b3', 'p2') }]);

  it('scores a perfect result: no wrong join, every strong pair joined', () => {
    const metrics = scoreResult(truth, perfect);
    expect(metrics.groups).toMatchObject({ total: 2, automaticMembers: 9, suggestedMembers: 1, pairs: 16, wrongPairs: 0, wrongJoinRate: 0 });
    expect(metrics.strong).toEqual({ components: 2, pairs: 16, joined: 16, recall: 1 });
    expect(metrics.suggestions).toEqual({ members: 1, right: 1, precision: 1 });
    expect(metrics.problems).toEqual([]);
    expect(checkTargets(metrics).every(check => check.pass)).toBe(true);
  });

  it('counts the pairs a wrong merge creates', () => {
    // one group of the five F0001 items and two F0002 items: 7 members, 21 pairs; right pairs C(5,2) + C(2,2) = 11
    const merged = result([{ id: 'g1', members: automatic('a1', 'a2', 'a3', 'a4', 'p1', 'b1', 'b2') }, { id: 'g2', members: automatic('b3', 'p2') }]);
    const metrics = scoreResult(truth, merged);
    expect(metrics.groups.pairs).toBe(22);
    expect(metrics.groups.wrongPairs).toBe(10);
    expect(metrics.groups.wrongJoinRate).toBeCloseTo(10 / 22, 10);
    expect(checkTargets(metrics).find(check => check.metric === 'wrong-join rate')!.pass).toBe(false);
  });

  it('treats a file with no family as wrong in any group', () => {
    const metrics = scoreResult(truth, result([{ id: 'g1', members: automatic('a1', 'a2', 'u1') }]));
    expect(metrics.groups).toMatchObject({ pairs: 3, wrongPairs: 2 });
    expect(scoreResult(truth, result([{ id: 'g1', members: automatic('u1', 'u2') }])).groups.wrongPairs).toBe(1);
  });

  it('measures recall when a strong component is split or left out', () => {
    const split = result([{ id: 'g1', members: automatic('a1', 'a2', 'a3') }, { id: 'g2', members: automatic('a4', 'p1') }, { id: 'g3', members: automatic('b1', 'b2', 'b3', 'p2') }]);
    const metrics = scoreResult(truth, split);
    expect(metrics.strong.joined).toBe(3 + 1 + 6);
    expect(metrics.strong.recall).toBeCloseTo(10 / 16, 10);
    expect(metrics.groups.wrongPairs).toBe(0);
    expect(scoreResult(truth, result([])).strong).toEqual({ components: 2, pairs: 16, joined: 0, recall: 0 });
    expect(scoreResult(truth, result([])).groups.wrongJoinRate).toBe(0);
  });

  it('does not count suggested members as joins, and judges them by the family of the automatic members', () => {
    const metrics = scoreResult(truth, result([{ id: 'g1', members: [...automatic('a1', 'a2'), { item: 'a5', tier: 'suggested' }, { item: 'b1', tier: 'suggested' }, { item: 'u1', tier: 'suggested' }] }]));
    expect(metrics.groups).toMatchObject({ automaticMembers: 2, suggestedMembers: 3, pairs: 1, wrongPairs: 0 });
    expect(metrics.suggestions).toEqual({ members: 3, right: 1, precision: 1 / 3 });
    expect(scoreResult(truth, result([{ id: 'g1', members: [{ item: 'a5', tier: 'suggested' }] }])).suggestions).toEqual({ members: 1, right: 0, precision: 0 });
  });

  it('reports items it does not know and items in two groups', () => {
    const metrics = scoreResult(truth, result([{ id: 'g1', members: automatic('a1', 'a2', 'nope') }, { id: 'g2', members: automatic('a2', 'b1') }]));
    expect(metrics.problems).toEqual(['group g1: unknown item "nope"', 'item "a2" is in groups g1 and g2']);
    expect(metrics.groups).toMatchObject({ automaticMembers: 3, pairs: 1 + 0 });
  });

  it('scores part numbers: exact, base form, decoys, misses', () => {
    // truth: p1 prints QXM1234LTR and VLR5678, p2 prints ZTN9001/NOPB; the base of the last is ZTN9001
    const parts = { p1: ['qxm1234ltr', '100NF', 'U7000'], p2: ['ZTN9001'] };
    const metrics = scoreResult(truth, result([], { parts }));
    expect(metrics.parts).toEqual({ documents: 2, truth: 3, returned: 4, correct: 2, found: 2, decoyHits: 1, precision: 0.5, recall: 2 / 3 });
    const none = scoreResult(truth, result([], { parts: {} })).parts!;
    expect(none).toMatchObject({ returned: 0, correct: 0, found: 0, precision: null, recall: 0 });
    expect(scoreResult(truth, result([])).parts).toBeNull();
    const all = scoreResult(truth, result([], { parts: { p1: ['QXM1234LTR', 'VLR5678'], p2: ['ZTN9001/NOPB'] } })).parts!;
    expect([all.precision, all.recall]).toEqual([1, 1]);
  });

  it('scores identical-file sets by pairs', () => {
    // truth pairs: a1-b1; a2-a3, a2-a4, a3-a4
    const full = scoreResult(truth, result([], { duplicates: [{ items: ['a1', 'b1'] }, { items: ['a2', 'a3', 'a4'] }] })).duplicates!;
    expect(full).toMatchObject({ truthPairs: 4, foundPairs: 4, correct: 4, precision: 1, recall: 1 });
    const partial = scoreResult(truth, result([], { duplicates: [{ items: ['a2', 'a3'] }, { items: ['a5', 'u1'] }] })).duplicates!;
    expect(partial).toMatchObject({ foundPairs: 2, correct: 1, precision: 0.5, recall: 0.25 });
    expect(scoreResult(truth, result([])).duplicates).toBeNull();
  });

  it('checks the grouping targets and compares with a baseline', () => {
    const checks = checkTargets(scoreResult(truth, result([{ id: 'g1', members: automatic('a1', 'a2', 'a3', 'a4', 'p1') }], { parts: { p1: ['QXM1234LTR', 'VLR5678'], p2: ['ZTN9001'] } })));
    expect(checks.map(check => [check.metric, check.pass])).toEqual([['wrong-join rate', true], ['strong-evidence recall', false], ['part-number precision', true], ['part-number recall', true]]);
    const baseline = scoreResult(truth, perfect);
    const worse = scoreResult(truth, result([{ id: 'g1', members: automatic('a1', 'a2') }, { id: 'g2', members: automatic('a3', 'b1') }]));
    expect(regressions(baseline, baseline)).toEqual([]);
    expect(regressions(worse, baseline).length).toBe(2);
  });

  it('validates the format of a result', () => {
    expect(validateResult(perfect)).toEqual([]);
    expect(validateResult({ version: 2, groups: [] })).not.toEqual([]);
    expect(validateResult({ version: 1, groups: [{ id: 'g', members: [{ item: 'a', tier: 'maybe' }] }] })).not.toEqual([]);
    expect(validateResult({ version: 1, groups: [], extra: 1 })).not.toEqual([]);
    expect(validateResult({ version: 1, groups: [], duplicates: [{ items: ['only-one'] }] })).not.toEqual([]);
    expect(validateResult({ version: 1, groups: [], parts: { a: [1] } })).not.toEqual([]);
  });
});

describe('metrics on a generated library', () => {
  const library = generateMemoryLibrary({ files: 140, bytes: 10 * 1024 * 1024, seed: 'metrics' });

  it('give the oracle a perfect score that passes every target', () => {
    const oracle = oracleResult(library.truth);
    expect(validateResult(oracle)).toEqual([]);
    const metrics = scoreResult(library.truth, oracle);
    expect(metrics.problems).toEqual([]);
    expect(metrics.groups.wrongJoinRate).toBe(0);
    expect(metrics.strong.recall).toBe(1);
    expect(metrics.strong.pairs).toBeGreaterThan(50);
    expect(metrics.parts!.precision).toBe(1);
    expect(metrics.parts!.recall).toBe(1);
    expect(metrics.parts!.documents).toBeGreaterThan(5);
    expect(metrics.duplicates).toMatchObject({ precision: 1, recall: 1 });
    expect(metrics.suggestions.precision).toBe(1);
    expect(checkTargets(metrics).every(check => check.pass)).toBe(true);
  });

  it('catch a wrong join when two groups are merged, and a missed join when one is cut', () => {
    const oracle = oracleResult(library.truth);
    const groups = oracle.groups.filter(group => group.members.filter(member => member.tier === 'automatic').length >= 3);
    expect(groups.length).toBeGreaterThan(2);
    const merged = result([{ id: 'merged', members: [...groups[0].members, ...groups[1].members] }, ...oracle.groups.filter(group => group !== groups[0] && group !== groups[1])]);
    const mergedMetrics = scoreResult(library.truth, merged);
    expect(mergedMetrics.groups.wrongPairs).toBeGreaterThan(0);
    expect(checkTargets(mergedMetrics)[0].pass).toBe(false);
    const cut = result(oracle.groups.map(group => (group === groups[0] ? { id: group.id, members: group.members.slice(0, 2) } : group)));
    const cutMetrics = scoreResult(library.truth, cut);
    expect(cutMetrics.strong.recall).toBeLessThan(1);
    expect(cutMetrics.groups.wrongPairs).toBe(0);
  });

  it('keep the oracle from putting an item with no family into a group', () => {
    const oracle = oracleResult(library.truth);
    const byId = new Map(library.truth.items.map(entry => [entry.id, entry]));
    for (const group of oracle.groups) for (const member of group.members) expect(byId.get(member.item)!.familyId).not.toBeNull();
  });
});
