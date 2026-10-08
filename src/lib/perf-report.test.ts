import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Markdown tables and report comparison of the synthetic benchmark (scripts/perf-report.cjs, plain Node). */
type Json = Record<string, unknown>;
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'perf-report.cjs');
const lib = createRequire(import.meta.url)(SCRIPT) as {
  COMPARE_METRICS: Array<[string, string, string, number]>;
  fmt(value: unknown, digits?: number): string;
  formatMarkdown(report: Json): string;
  compareReports(first: Json, second: Json): string;
};
const budgets = createRequire(import.meta.url)(join(__dirname, '..', '..', 'scripts', 'perf-budget.cjs')) as { valueAt(object: unknown, path: string): unknown };

const stat = (mean: number, p95: number) => ({ n: 100, mean, p50: mean, p95, p99: p95, max: p95 });
function result(size: string, scale: number, over: Json = {}): Json {
  return {
    size, status: 'ok', pins: 1000, board: { components: 400, nets: 300 },
    host: { logicalCpus: 16, before: { cpuBusyPercent: 12, freeMemoryGB: 8.5, processes: { node: 3, electron: 1, browser: 2, total: 200 } }, after: { cpuBusyPercent: 9 }, duringRun: { elapsedS: 80, machineBusyPercent: 40, ownBusyPercent: 25, otherBusyPercent: 15 } },
    load: { firstPaintMs: 1000 * scale, readAndHandoffMs: 10 * scale, workerRoundTripMs: 600 * scale, sceneAndFirstDrawMs: 390 * scale },
    memory: { afterLoad: { heap: { usedMB: 50 * scale } }, afterInteraction: { processes: { rendererPeakWorkingSetMB: 700 * scale } } },
    pan: { fit: { draw: stat(2 * scale, 4 * scale) }, detail: { draw: stat(1, 2) }, gnd: { draw: stat(3, 5) } },
    zoom: { fit: { draw: stat(3 * scale, 6 * scale) }, detail: { draw: stat(1, 2) }, gnd: { draw: stat(4, 7) } },
    frameCost: { pan: { fit: { total: stat(5 * scale, 9 * scale) }, detail: { total: stat(2, 3) }, gnd: { total: stat(6, 10) } }, zoom: { fit: { total: stat(6 * scale, 11 * scale) }, detail: { total: stat(2, 4) } } },
    hover: { fit: { pointerMoveMs: stat(0.1, 0.2) } }, search: { keystrokeMs: stat(8, 12) }, selectNet: { firstDrawMs: 30 * scale, pins: 300 }, idle: { draws: 0 },
    ...over,
  };
}
function report(label: string, sizes: Json[], over: Json = {}): Json {
  return {
    schema: 1, label, runtime: 'electron', startedAt: '2026-10-07T10:00:00.000Z', finishedAt: '2026-10-07T10:30:00.000Z', revision: 'abc123def456', packageVersion: '1.3.0',
    generator: { name: 'trace-synthetic-board', version: 1, seed: 1 }, conditions: 'under load, indicative',
    machine: { platform: 'win32', osRelease: '10.0.1', arch: 'x64', cpuModel: 'Example CPU', logicalCpus: 16, memoryGB: 24 },
    application: { electron: '44.5.1', chrome: '152.0', glRenderer: 'ANGLE (Example GPU)', gpuDevices: [{ deviceString: 'Example GPU', active: true }, { deviceString: 'Other', active: false }] },
    settings: { viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, quick: false },
    sizes, ...over,
  };
}

describe('number formatting', () => {
  it('prints numbers with fixed decimals and a dash for anything else', () => {
    expect(lib.fmt(3.14159, 2)).toBe('3.14');
    expect(lib.fmt(12, 0)).toBe('12');
    for (const value of [undefined, null, Number.NaN, 'x']) expect(lib.fmt(value)).toBe('-');
  });
});

describe('Markdown report', () => {
  const md = lib.formatMarkdown(report('baseline', [result('100k', 2), result('10k', 1)], {
    budget: { file: 'perf-budget.json', pass: 1, fail: 1, noData: 0, notMeasured: 0, rows: [
      { id: 'a', status: 'fail', size: '100k', label: 'Pan p95, fit view, 100k pins', value: 18, max: 12, unit: 'ms' },
      { id: 'b', status: 'pass', size: '100k', label: 'Open to first paint, 100k pins', value: 2000, max: 3000, unit: 'ms' },
    ] },
  }));

  it('names the run, its conditions, the machine and the graphics adapter in use', () => {
    expect(md).toContain('# baseline: synthetic benchmark (electron)');
    expect(md).toContain('Conditions: **under load, indicative**');
    expect(md).toContain('Example CPU, 16 logical processors, 24 GB memory');
    expect(md).toContain('Graphics: Example GPU');
    expect(md).toContain('Electron 44.5.1');
    expect(md).not.toContain('Other');
  });

  it('lists the sizes in ascending order with mean and p95 of the frame cost', () => {
    expect(md.indexOf('**10k**')).toBeLessThan(md.indexOf('**100k**'));
    expect(md).toContain('| **100k** | 10.0 / 18.0 |');
    expect(md).toContain('| **10k** | 5.0 / 9.0 |');
    expect(md).toContain('## Frame cost');
    expect(md).toContain('## Draw callback only');
  });

  it('shows the host load of every run, with the other programs share during the run when known', () => {
    expect(md).toContain('15 % other during the run; 12 % busy before, 9 % after; 3 node, 1 electron, 2 browser of 200 processes; 8.5 GB free');
  });

  it('shows the budget results and the counts', () => {
    expect(md).toContain('| FAIL | 100k | Pan p95, fit view, 100k pins | 18.00 ms | 12 ms |');
    expect(md).toContain('| PASS | 100k | Open to first paint, 100k pins | 2000 ms | 3000 ms |');
    expect(md).toContain('1 pass, 1 fail, 0 no data, 0 skipped.');
  });

  it('copes with a failed size and with missing metrics', () => {
    const failed = lib.formatMarkdown(report('partial', [result('10k', 1), { size: '1m', status: 'failed', error: 'No first paint within 900 s.', host: {} }], { conditions: undefined, application: undefined }));
    expect(failed).toContain('**1m** (failed)');
    expect(failed).toContain('- 1m: No first paint within 900 s.');
    expect(failed).toContain('Conditions: **not recorded**');
    expect(failed).toContain('Graphics: not recorded');
  });
});

describe('comparison of two reports', () => {
  const first = report('before', [result('10k', 1), result('100k', 2), result('1m', 10)]);
  const second = report('after', [result('10k', 0.5), result('100k', 1), { size: '1m', status: 'failed' }], { conditions: 'quiet' });
  const text = lib.compareReports(first, second);

  it('gives the ratio second to first for the sizes measured in both', () => {
    expect(text).toContain('# Comparison: after against before');
    expect(text).toContain('| First paint | 10k | 1000 ms | 500 ms | 0.50 |');
    expect(text).toContain('| Pan, fit view, frame p95 | 100k | 18.0 ms | 9.0 ms | 0.50 |');
    expect(text).not.toContain('| 1m |');
    expect(text).toContain('quiet');
  });

  it('says so when no size is common', () => {
    expect(lib.compareReports(report('a', [result('10k', 1)]), report('b', [result('50k', 1)]))).toContain('No board size was measured in both reports.');
  });

  it('only uses metrics that exist in a report', () => {
    const sample = result('10k', 1);
    for (const [label, metric] of lib.COMPARE_METRICS) expect(typeof budgets.valueAt(sample, metric), label).toBe('number');
  });
});

describe('command line', () => {
  it('writes the tables or the comparison to a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-report-'));
    try {
      const a = join(dir, 'a.json'), b = join(dir, 'b.json'), out = join(dir, 'out.md');
      writeFileSync(a, JSON.stringify(report('first', [result('10k', 2)])));
      writeFileSync(b, JSON.stringify(report('second', [result('10k', 1)])));
      execFileSync(process.execPath, [SCRIPT, a, `--out=${out}`]);
      expect(readFileSync(out, 'utf8')).toContain('# first: synthetic benchmark');
      execFileSync(process.execPath, [SCRIPT, b, `--compare=${a}`, `--out=${out}`]);
      expect(readFileSync(out, 'utf8')).toContain('# Comparison: second against first');
      expect(execFileSync(process.execPath, [SCRIPT, a], { encoding: 'utf8' })).toContain('## Open and memory');
      expect(() => execFileSync(process.execPath, [SCRIPT, join(dir, 'missing.json')], { stdio: 'pipe' })).toThrow();
      expect(() => execFileSync(process.execPath, [SCRIPT], { stdio: 'pipe' })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
