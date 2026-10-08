import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Budget evaluation and statistics of the synthetic benchmark (scripts/perf-budget.cjs, plain Node). */
interface Budget { schema: number; budgets: Array<{ id: string; size: string; metric: string; max: number; unit: string; label: string; source?: string }> }
interface Row { id: string; status: 'pass' | 'fail' | 'no-data' | 'not-measured'; value: number | null; max: number; reason?: string }
interface Evaluation { rows: Row[]; pass: number; fail: number; noData: number; notMeasured: number }
interface Stats { n: number; mean?: number; p50?: number; p95?: number; p99?: number; max?: number }
const ROOT = join(__dirname, '..', '..');
const lib = createRequire(import.meta.url)(join(ROOT, 'scripts', 'perf-budget.cjs')) as {
  SIZE_NAMES: string[];
  valueAt(object: unknown, path: string): unknown;
  validateBudget(budget: unknown): Budget;
  loadBudget(file: string): Budget;
  evaluateBudget(budget: Budget, results: unknown[]): Evaluation;
  exitCodeFor(evaluation: Evaluation, strict: boolean): number;
  formatBudgetTable(evaluation: Evaluation): string;
  percentile(sorted: number[], fraction: number): number;
  stats(values: number[]): Stats;
};
const committed = JSON.parse(readFileSync(join(ROOT, 'config', 'perf-budget.json'), 'utf8')) as Budget;
const entry = (over: Record<string, unknown> = {}) => ({ id: 'pan-100k', size: '100k', metric: 'frameCost.pan.fit.total.p95', max: 12, unit: 'ms', label: 'Pan', ...over });
const budget = (...entries: Array<Record<string, unknown>>): Budget => ({ schema: 1, budgets: entries as Budget['budgets'] });

describe('committed performance budget', () => {
  it('is valid and carries the acceptance thresholds of the plan', () => {
    expect(() => lib.validateBudget(committed)).not.toThrow();
    expect(lib.loadBudget(join(ROOT, 'config', 'perf-budget.json'))).toEqual(committed);
    const byId = new Map(committed.budgets.map(item => [item.id, item]));
    expect(byId.get('pan-p95-100k')).toMatchObject({ size: '100k', max: 12, unit: 'ms', metric: 'frameCost.pan.fit.total.p95' });
    expect(byId.get('zoom-p95-100k')).toMatchObject({ size: '100k', max: 16, unit: 'ms', metric: 'frameCost.zoom.fit.total.p95' });
    expect(byId.get('first-paint-100k')).toMatchObject({ size: '100k', max: 3000, unit: 'ms', metric: 'load.firstPaintMs' });
    expect(byId.get('pan-p95-250k')).toMatchObject({ size: '250k', max: 33, unit: 'ms' });
    expect(byId.get('zoom-p95-250k')).toMatchObject({ size: '250k', max: 33, unit: 'ms', metric: 'frameCost.zoom.fit.total.p95' });
    expect(new Set(committed.budgets.map(item => item.id)).size).toBe(committed.budgets.length);
  });
});

describe('budget validation', () => {
  it.each([
    ['not an object', null],
    ['wrong schema', { schema: 2, budgets: [entry()] }],
    ['no budgets', { schema: 1, budgets: [] }],
    ['bad id', budget(entry({ id: 'Pan 100k' }))],
    ['duplicate id', budget(entry(), entry())],
    ['unknown size', budget(entry({ size: '75k' }))],
    ['bad metric path', budget(entry({ metric: 'pan..p95' }))],
    ['empty metric path', budget(entry({ metric: '' }))],
    ['zero maximum', budget(entry({ max: 0 }))],
    ['text maximum', budget(entry({ max: '12' }))],
    ['infinite maximum', budget(entry({ max: Infinity }))],
    ['no unit', budget(entry({ unit: '' }))],
    ['no label', budget(entry({ label: '' }))],
    ['source not text', budget(entry({ source: 5 }))],
  ])('refuses %s', (_name, value) => {
    expect(() => lib.validateBudget(value)).toThrow(RangeError);
  });

  it('knows the five benchmark sizes', () => {
    expect(lib.SIZE_NAMES).toEqual(['10k', '50k', '100k', '250k', '1m']);
  });
});

describe('budget evaluation', () => {
  const measured = (size: string, metrics: Record<string, unknown>, status = 'ok') => ({ size, status, ...metrics });

  it('passes at the threshold and fails above it', () => {
    const rules = budget(entry({ id: 'a', max: 12 }), entry({ id: 'b', max: 12 }), entry({ id: 'c', max: 12 }));
    const equal = lib.evaluateBudget(rules, [measured('100k', { frameCost: { pan: { fit: { total: { p95: 12 } } } } })]);
    expect(equal.rows.map(row => row.status)).toEqual(['pass', 'pass', 'pass']);
    const over = lib.evaluateBudget(rules, [measured('100k', { frameCost: { pan: { fit: { total: { p95: 12.001 } } } } })]);
    expect(over.rows.map(row => row.status)).toEqual(['fail', 'fail', 'fail']);
    expect(over.fail).toBe(3);
    expect(over.rows[0].value).toBe(12.001);
  });

  it('separates not measured, unfinished and missing metrics', () => {
    const rules = budget(entry({ id: 'a' }), entry({ id: 'b', size: '250k' }), entry({ id: 'c', size: '1m', metric: 'load.firstPaintMs', max: 100 }), entry({ id: 'd', size: '10k', metric: 'load.firstPaintMs', max: 100 }));
    const evaluation = lib.evaluateBudget(rules, [
      measured('100k', { load: { firstPaintMs: 5 } }), // metric absent
      measured('1m', {}, 'failed'), // the run did not finish
      measured('10k', { load: { firstPaintMs: Number.NaN } }), // not a number
    ]);
    expect(evaluation.rows.map(row => [row.id, row.status])).toEqual([['a', 'no-data'], ['b', 'not-measured'], ['c', 'no-data'], ['d', 'no-data']]);
    expect(evaluation).toMatchObject({ pass: 0, fail: 0, noData: 3, notMeasured: 1 });
    expect(evaluation.rows[2].reason).toContain('did not finish');
  });

  it('reports only: a failed budget changes the exit code only in strict mode', () => {
    const rules = budget(entry({ max: 12 }));
    const failing = lib.evaluateBudget(rules, [measured('100k', { frameCost: { pan: { fit: { total: { p95: 30 } } } } })]);
    const passing = lib.evaluateBudget(rules, [measured('100k', { frameCost: { pan: { fit: { total: { p95: 3 } } } } })]);
    const noData = lib.evaluateBudget(rules, [measured('100k', {})]);
    const skipped = lib.evaluateBudget(rules, []);
    expect([failing, passing, noData, skipped].map(evaluation => lib.exitCodeFor(evaluation, false))).toEqual([0, 0, 0, 0]);
    expect([failing, passing, noData, skipped].map(evaluation => lib.exitCodeFor(evaluation, true))).toEqual([1, 0, 1, 0]);
  });

  it('prints one line per budget and a count line', () => {
    const rules = budget(entry({ id: 'a', label: 'Pan p95', max: 12 }), entry({ id: 'b', size: '250k', label: 'Pan p95 250k', max: 33 }));
    const table = lib.formatBudgetTable(lib.evaluateBudget(rules, [measured('100k', { frameCost: { pan: { fit: { total: { p95: 30.456 } } } } })]));
    const lines = table.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^FAIL\s+100k\s+Pan p95\s+30\.46 ms\s+\(budget <= 12 ms\)$/);
    expect(lines[1]).toMatch(/^skipped\s+250k/);
    expect(lines[2]).toBe('0 pass, 1 fail, 0 no data, 1 skipped');
  });
});

describe('metric paths and statistics', () => {
  it('reads dotted paths without prototype surprises', () => {
    const object = { a: { b: { c: 4 } }, list: [1, 2] };
    expect(lib.valueAt(object, 'a.b.c')).toBe(4);
    expect(lib.valueAt(object, 'a.b')).toEqual({ c: 4 });
    expect(lib.valueAt(object, 'a.x.c')).toBeUndefined();
    expect(lib.valueAt(object, 'a.b.c.d')).toBeUndefined();
    expect(lib.valueAt(object, 'toString')).toBeUndefined();
    expect(lib.valueAt(object, 'a.constructor')).toBeUndefined();
    expect(lib.valueAt(null, 'a')).toBeUndefined();
  });

  it('computes nearest-rank percentiles like the earlier performance harness', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(lib.stats(values)).toEqual({ n: 100, mean: 50.5, p50: 51, p95: 96, p99: 100, max: 100 });
    expect(lib.stats([5])).toEqual({ n: 1, mean: 5, p50: 5, p95: 5, p99: 5, max: 5 });
    expect(lib.stats([3, 1, 2])).toMatchObject({ n: 3, p50: 2, max: 3 });
    expect(lib.stats([])).toEqual({ n: 0 });
    expect(lib.stats([Number.NaN, 4, Number.POSITIVE_INFINITY])).toEqual({ n: 1, mean: 4, p50: 4, p95: 4, p99: 4, max: 4 });
    expect(lib.percentile([], 0.95)).toBe(0);
    expect(lib.stats([0.0004, 0.0004]).mean).toBe(0);
  });
});
