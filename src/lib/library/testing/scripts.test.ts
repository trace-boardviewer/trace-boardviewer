import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { generateMemoryLibrary } from './library';
import * as presets from './presets';

const require = createRequire(import.meta.url);
const generator = require('../../../../scripts/gen-synthetic-library.cjs') as {
  MARKER: string;
  checkOutput(out: string, force: boolean): string;
  generateToDisk(options: Record<string, unknown>, out: string, flags: { force?: boolean; bench?: boolean }): Promise<{ out: string; root: string; truth: { items: Array<{ path: string; container?: unknown; mtimeMs: number; size: number }> }; manifest: { treeHash: string; stats: { files: number; bytes: number } } }>;
  verifyLibrary(out: string): string[];
  truthText(truth: unknown): string;
};
const bench = require('../../../../scripts/library-bench.cjs') as {
  percentile(values: number[], p: number): number | null;
  summarize(values: number[]): Record<string, number>;
  parseArguments(argv: string[], presets: unknown): Record<string, unknown> & { phases: string[]; options: Record<string, unknown> };
  formatMarkdown(report: unknown): string;
  latencyChecks(report: unknown): Array<{ metric: string; pass: boolean | null }>;
  scrub(text: string): string;
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-library-script-test-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const typeStripping = Boolean(process.features.typescript);
const MIB = 1024 * 1024;

describe('gen-synthetic-library: where it may write', () => {
  it('refuses a folder inside the repository, one that contains it, a file, and a non-empty folder without --force', () => {
    expect(() => generator.checkOutput(path.join(repo, 'test-results', 'x'), false)).toThrow(/inside the repository/);
    expect(() => generator.checkOutput(path.join(repo, 'src'), true)).toThrow(/inside the repository/);
    expect(() => generator.checkOutput(path.dirname(repo), true)).toThrow(/contains the repository|inside the repository/);
    const file = path.join(scratch, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(() => generator.checkOutput(file, false)).toThrow(/not a folder/);
    const busy = path.join(scratch, 'busy');
    fs.mkdirSync(busy);
    fs.writeFileSync(path.join(busy, 'keep.txt'), 'mine');
    expect(() => generator.checkOutput(busy, false)).toThrow(/not empty/);
    expect(() => generator.checkOutput(busy, true)).toThrow(/holds no synthetic library/);
    expect(fs.readFileSync(path.join(busy, 'keep.txt'), 'utf8')).toBe('mine');
    expect(generator.checkOutput(path.join(scratch, 'new', 'deeper'), false)).toBe(path.join(scratch, 'new', 'deeper'));
    const empty = path.join(scratch, 'empty');
    fs.mkdirSync(empty);
    expect(generator.checkOutput(empty, false)).toBe(empty);
  });
});

describe.skipIf(!typeStripping)('gen-synthetic-library: writing a library', () => {
  const options = { files: 100, bytes: 6 * MIB, seed: 'script-test', hostile: true };

  it('writes the files, the truth and the manifest; the same options give the same tree; a folder it wrote may be replaced', async () => {
    const out = path.join(scratch, 'one');
    const first = await generator.generateToDisk(options, out, { bench: false });
    expect(fs.readdirSync(out).sort()).toEqual(['ground-truth.json', 'ground-truth.schema.json', 'library', 'manifest.json', 'result.schema.json']);
    expect(generator.verifyLibrary(out)).toEqual([]);
    expect(first.manifest.stats.files).toBe(100);
    expect(first.manifest.stats.bytes).toBeLessThanOrEqual(options.bytes);
    const truthOnDisk = JSON.parse(fs.readFileSync(path.join(out, 'ground-truth.json'), 'utf8'));
    expect(truthOnDisk.totals.files).toBe(100);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).generator).toBe(generator.MARKER);

    // the file system holds exactly what the in-memory builder makes (so the sink, the long paths and the times are right)
    const memory = generateMemoryLibrary(options);
    expect(JSON.stringify(truthOnDisk)).toBe(JSON.stringify(memory.truth));
    const walked: string[] = [];
    const walk = (dir: string, prefix: string): void => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`); else walked.push(`${prefix}${entry.name}`); } };
    walk(path.join(out, 'library'), '');
    expect(walked.sort()).toEqual(first.truth.items.filter(item => !item.container).map(item => item.path).sort());
    const sample = first.truth.items.find(item => !item.container && item.size > 0)!;
    expect(Math.abs(fs.statSync(path.join(out, 'library', ...sample.path.split('/'))).mtimeMs - sample.mtimeMs)).toBeLessThan(2000);

    await expect(generator.generateToDisk(options, out, { bench: false })).rejects.toThrow(/not empty/);
    const second = await generator.generateToDisk(options, out, { bench: false, force: true });
    expect(second.manifest.treeHash).toBe(first.manifest.treeHash);
    const other = await generator.generateToDisk({ ...options, seed: 'another' }, path.join(scratch, 'two'), { bench: false });
    expect(other.manifest.treeHash).not.toBe(first.manifest.treeHash);
  }, 120_000);

  it('notices a changed or missing file', async () => {
    const out = path.join(scratch, 'one');
    const files = JSON.parse(fs.readFileSync(path.join(out, 'ground-truth.json'), 'utf8')).items.filter((item: { container?: unknown; size: number }) => !item.container && item.size > 10) as Array<{ path: string }>;
    fs.appendFileSync(path.join(out, 'library', ...files[0].path.split('/')), 'x');
    fs.rmSync(path.join(out, 'library', ...files[1].path.split('/')));
    const problems = generator.verifyLibrary(out);
    expect(problems.some(problem => problem.startsWith('size '))).toBe(true);
    expect(problems.some(problem => problem.startsWith('missing '))).toBe(true);
  });

  it('writes a truth file with one line per record', () => {
    const memory = generateMemoryLibrary({ ...options, files: 60, bytes: 3 * MIB });
    const text = generator.truthText(memory.truth);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(memory.truth)));
    expect(text.split('\n').length).toBeGreaterThan(memory.truth.items.length);
  }, 60_000);
});

describe('library-bench', () => {
  it('computes percentiles and summaries', () => {
    expect(bench.percentile([], 95)).toBeNull();
    expect(bench.percentile([5], 95)).toBe(5);
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(bench.percentile(values, 50)).toBe(50);
    expect(bench.percentile(values, 95)).toBe(95);
    expect(bench.percentile(values, 100)).toBe(100);
    expect(bench.summarize([3, 1, 2])).toEqual({ n: 3, min: 1, mean: 2, p50: 2, p95: 3, max: 3 });
    expect(bench.summarize([])).toEqual({ n: 0 });
    expect(bench.summarize([1, Number.NaN, 'x' as never])).toEqual({ n: 1, min: 1, mean: 1, p50: 1, p95: 1, max: 1 });
  });

  it('reads its arguments and refuses unknown ones', () => {
    const parsed = bench.parseArguments(['--preset=small', '--seed=7', '--phases=generate,verify,scan', '--keep', '--bytes=64M', '--wait-quiet=30'], presets);
    expect(parsed).toMatchObject({ keep: true, waitQuiet: 30, phases: ['generate', 'verify', 'scan'], options: { preset: 'small', seed: 7, bytes: 64 * MIB } });
    expect(bench.parseArguments([], presets).phases).toEqual(['generate', 'verify']);
    expect(() => bench.parseArguments(['--nope'], presets)).toThrow(/unknown argument/);
    expect(() => bench.parseArguments(['--phases=generate,fly'], presets)).toThrow(/phases/);
    expect(() => bench.parseArguments(['--wait-quiet=99999'], presets)).toThrow(/wait-quiet/);
  });

  it('checks latency percentiles against the latency targets, and leaves unmeasured ones unchecked', () => {
    const checks = bench.latencyChecks({ partNumber: bench.summarize([10, 20, 400]), browse: bench.summarize([5, 6, 7]), boardPage: { n: 0 } });
    expect(checks.map(check => [check.metric, check.pass])).toEqual([['partNumber p95 (ms)', false], ['browse p95 (ms)', true], ['boardPage p95 (ms)', null]]);
  });

  it('renders a report as Markdown without local paths', () => {
    const load = { elapsedS: 1, machineBusyPercent: 40, ownBusyPercent: null, otherBusyPercent: null };
    const report = {
      label: 'small-s1', conditions: 'quiet', revision: 'abc1234', options: { seed: 1, preset: 'small' },
      machine: { logicalCpus: 8, cpuModel: 'Test CPU', memoryGB: 16, platform: 'win32', arch: 'x64', node: '24.0.0' },
      host: { before: { cpuBusyPercent: 3, freeMemoryGB: 9, processes: { node: 2, electron: 0, browser: 1, total: 100, complete: true } }, after: { cpuBusyPercent: 4 } },
      library: { files: 400, members: 30, bytes: 33554432, families: 30 },
      phases: {
        generate: { status: 'ok', ms: 2500, processCpuMs: 2100, peakRssMB: 200, load, filesPerSecond: 160, mibPerSecond: 12.8 },
        verify: { status: 'ok', ms: 200, processCpuMs: 150, peakRssMB: 210, load, problems: [] },
        scan: { status: 'skipped', reason: 'no scan hook' },
      },
    };
    const text = bench.formatMarkdown(report);
    expect(text).toContain('# Library benchmark: small-s1');
    expect(text).toContain('| generate | ok | 2.50 | 2.10 | 200 | 40 | - | 160 files/s, 12.8 MiB/s |');
    expect(text).toContain('| scan | skipped | - | - | - | - | - | no scan hook |');
    expect(text).toContain('8 logical CPUs');
    expect(text).toContain('2 node, 0 electron, 1 browser of 100 processes');
    expect(bench.scrub(`${os.tmpdir()}${path.sep}x and ${repo}${path.sep}y`)).toBe(`<tmp>${path.sep}x and <repo>${path.sep}y`);
  });
});
