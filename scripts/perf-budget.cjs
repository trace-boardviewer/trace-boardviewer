'use strict';

/*
 * Performance budgets and the small statistics the synthetic benchmark needs (no browser, no Electron: unit tested).
 *
 * The budget file (config/perf-budget.json) lists thresholds on named metrics of the benchmark report. A metric is a dotted path
 * into the result of one board size, for example "pan.fit.draw.p95" (milliseconds). Evaluating a report against it gives one
 * row per budget: pass, fail, or "no data" when the size was not measured or the metric is absent. Nothing here exits the
 * process; the benchmark only fails its exit code when asked to (--strict).
 */

const fs = require('node:fs');

const BUDGET_SCHEMA = 1;
const SIZE_NAMES = ['10k', '50k', '100k', '250k', '1m'];

/** Value at a dotted path; undefined when any step is missing. */
function valueAt(object, dotted) {
  let current = object;
  for (const key of String(dotted).split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** Validates a parsed budget file; returns it unchanged or throws a RangeError naming the first problem. */
function validateBudget(budget) {
  const fail = message => { throw new RangeError(`Invalid performance budget: ${message}`); };
  if (!budget || typeof budget !== 'object') fail('not an object.');
  if (budget.schema !== BUDGET_SCHEMA) fail(`schema must be ${BUDGET_SCHEMA}.`);
  if (!Array.isArray(budget.budgets) || !budget.budgets.length) fail('"budgets" must be a non-empty array.');
  const ids = new Set();
  for (const item of budget.budgets) {
    if (!item || typeof item !== 'object') fail('a budget entry is not an object.');
    if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(item.id)) fail(`entry id ${JSON.stringify(item.id)} must be lower-case words joined by dashes.`);
    if (ids.has(item.id)) fail(`duplicate id "${item.id}".`);
    ids.add(item.id);
    if (!SIZE_NAMES.includes(item.size)) fail(`${item.id}: size must be one of ${SIZE_NAMES.join(', ')}.`);
    if (typeof item.metric !== 'string' || !/^[A-Za-z0-9]+(\.[A-Za-z0-9]+)*$/.test(item.metric)) fail(`${item.id}: metric must be a dotted path.`);
    if (typeof item.max !== 'number' || !Number.isFinite(item.max) || item.max <= 0) fail(`${item.id}: max must be a positive number.`);
    if (typeof item.unit !== 'string' || !item.unit) fail(`${item.id}: unit is required.`);
    if (typeof item.label !== 'string' || !item.label) fail(`${item.id}: label is required.`);
    if (item.source !== undefined && typeof item.source !== 'string') fail(`${item.id}: source must be text.`);
  }
  return budget;
}

function loadBudget(file) {
  return validateBudget(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/**
 * One row per budget. `results` is the list of per-size results of a report ({ size, status, ... }); only results with
 * status "ok" count as measured.
 */
function evaluateBudget(budget, results) {
  const bySize = new Map(results.map(result => [result.size, result]));
  const rows = budget.budgets.map(item => {
    const base = { id: item.id, size: item.size, metric: item.metric, label: item.label, unit: item.unit, max: item.max };
    const result = bySize.get(item.size);
    if (!result) return { ...base, status: 'not-measured', value: null };
    if (result.status !== 'ok') return { ...base, status: 'no-data', value: null, reason: `the ${item.size} run did not finish` };
    const value = valueAt(result, item.metric);
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ...base, status: 'no-data', value: null, reason: 'metric absent from the result' };
    return { ...base, status: value <= item.max ? 'pass' : 'fail', value };
  });
  const count = status => rows.filter(row => row.status === status).length;
  return { rows, pass: count('pass'), fail: count('fail'), noData: count('no-data'), notMeasured: count('not-measured') };
}

/** Exit code for a budget evaluation: 1 only in strict mode and only for a failed or unverifiable budget. */
function exitCodeFor(evaluation, strict) {
  return strict && (evaluation.fail > 0 || evaluation.noData > 0) ? 1 : 0;
}

const WORD = { pass: 'PASS', fail: 'FAIL', 'no-data': 'NO DATA', 'not-measured': 'skipped' };
function formatBudgetTable(evaluation) {
  const lines = evaluation.rows.map(row => {
    const value = row.value === null ? '-' : `${row.value.toFixed(row.unit === 'ms' && row.value < 100 ? 2 : 0)} ${row.unit}`;
    return `${WORD[row.status].padEnd(8)} ${row.size.padEnd(5)} ${row.label.padEnd(44)} ${value.padStart(12)}  (budget <= ${row.max} ${row.unit})`;
  });
  lines.push(`${evaluation.pass} pass, ${evaluation.fail} fail, ${evaluation.noData} no data, ${evaluation.notMeasured} skipped`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Statistics: nearest-rank percentiles, like the older performance harness
// ---------------------------------------------------------------------------------------------------------------

function percentile(sorted, fraction) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0;
}

const round3 = value => Math.round(value * 1000) / 1000;

/** { n, mean, p50, p95, p99, max } of numbers (rounded to microseconds when the numbers are milliseconds); { n: 0 } when empty. */
function stats(values) {
  const finite = values.filter(value => Number.isFinite(value));
  if (!finite.length) return { n: 0 };
  const sorted = [...finite].sort((a, b) => a - b);
  const sum = finite.reduce((total, value) => total + value, 0);
  return { n: finite.length, mean: round3(sum / finite.length), p50: round3(percentile(sorted, 0.5)), p95: round3(percentile(sorted, 0.95)), p99: round3(percentile(sorted, 0.99)), max: round3(sorted[sorted.length - 1]) };
}

module.exports = { BUDGET_SCHEMA, SIZE_NAMES, valueAt, validateBudget, loadBudget, evaluateBudget, exitCodeFor, formatBudgetTable, percentile, stats };
