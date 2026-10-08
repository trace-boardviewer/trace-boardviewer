'use strict';

/*
 * Benchmark harness of the Library, in the pattern of the board benchmark (perf-synthetic.cjs): one JSON report per run with the
 * conditions of the machine (processor count, share of the processor the other programs used, other node and electron processes,
 * free memory) next to the measurements, plus a Markdown copy.
 *
 *   node scripts/library-bench.cjs --preset=small [--seed=1] [--evidence-dir=<dir>] [--label=<name>]
 *   node scripts/library-bench.cjs --preset=medium --keep --library-out=<dir>
 *   node scripts/library-bench.cjs --library=<dir of a generated library> --phases=verify,scan --scan-hook=<module.cjs>
 *
 * Phases (--phases=generate,verify,scan,query; default generate,verify):
 *   generate  makes a synthetic library (scripts/gen-synthetic-library.cjs) and times it
 *   verify    reads every generated file back and checks size and SHA-256 against the ground truth (also a disk-read measurement)
 *   scan      calls the scan hook, scores the grouping it returns against the ground truth and checks the grouping targets of the Library design
 *   query     calls the query hook and compares the 95th percentiles with the latency targets of the Library design
 * The scan and query phases need a hook, because the Library service does not exist yet; without one they are recorded as skipped.
 *
 * Hooks are CommonJS modules (--scan-hook=<file>, --query-hook=<file>) that export an async function:
 *   scan({ root, truth, options, log })  -> { result?: LibraryResult (see src/lib/library/testing/metrics.ts), counters?: object, appProcessSeconds?: number }
 *   query({ root, truth, scan })         -> { partNumber?: number[], browse?: number[], boardPage?: number[] }   (latencies in milliseconds)
 * `root` is the folder to scan (<library out>/library). The time of a hook is the wall time of the call; the processor share of the
 * run is taken from the whole machine with this process and the number the hook reports (appProcessSeconds) taken out.
 *
 * Options
 *   --preset=<name> | --files=<n> --bytes=<size>   what to generate (see gen-synthetic-library.cjs); --seed=<s> (default 1)
 *   --library=<dir>         use a library that was generated earlier (the out folder, with ground-truth.json) instead of generating
 *   --library-out=<dir>     where to generate (default: a folder in the system temp directory, removed afterwards unless --keep)
 *   --keep                  keep the generated library
 *   --no-bench              no GenCAD boards from scripts/gen-synthetic-board.cjs
 *   --evidence-dir=<dir>    where the report is written (default test-results/library-bench in the repository)
 *   --label=<name>          report name (default <preset or files>-s<seed>)
 *   --wait-quiet=<seconds>  before the first phase wait up to that long for the machine to be idle
 *   --conditions=<text>     how the machine was ("quiet", "under load, indicative"); without it the report classifies the measured load
 *   --revision=<text>       recorded in the report (default: the git revision when git is on the PATH)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const host = require('./perf-host.cjs');
const generator = require('./gen-synthetic-library.cjs');

const REPO = path.resolve(__dirname, '..');
const REPORT_SCHEMA = 1;
const PHASES = ['generate', 'verify', 'scan', 'query'];

/** Latency targets of the Library design that this harness can measure through a hook (reference machine: a desktop with an SSD). */
const LATENCY_TARGETS = Object.freeze({ partNumber: 150, browse: 200, boardPage: 200 });

const scrub = value => [[os.tmpdir(), '<tmp>'], [REPO, '<repo>'], [os.homedir(), '~']]
  .reduce((text, [from, to]) => text.split(from).join(to).split(from.split('\\').join('/')).join(to), String(value))
  .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s'"]+/g, '~');

/** p-th percentile (nearest rank) of a list of numbers; null for an empty list. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** { n, min, mean, p50, p95, max } of a list of numbers, rounded to two decimals. */
function summarize(values) {
  const clean = (values || []).filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!clean.length) return { n: 0 };
  const round = value => Math.round(value * 100) / 100;
  return { n: clean.length, min: round(Math.min(...clean)), mean: round(clean.reduce((sum, value) => sum + value, 0) / clean.length), p50: round(percentile(clean, 50)), p95: round(percentile(clean, 95)), max: round(Math.max(...clean)) };
}

function parseArguments(argv, presets) {
  const value = name => { const hit = argv.find(item => item === `--${name}` || item.startsWith(`--${name}=`)); return hit === undefined ? undefined : hit.includes('=') ? hit.slice(name.length + 3) : ''; };
  const flag = name => argv.includes(`--${name}`);
  const known = new Set(['preset', 'files', 'bytes', 'seed', 'library', 'library-out', 'keep', 'no-bench', 'evidence-dir', 'label', 'wait-quiet', 'conditions', 'revision', 'phases', 'scan-hook', 'query-hook', 'help']);
  for (const item of argv) { const name = /^--([^=]+)/.exec(item); if (!name || !known.has(name[1])) throw new Error(`unknown argument ${item}; --help shows usage`); }
  const phases = (value('phases') ?? 'generate,verify').split(',').map(item => item.trim()).filter(Boolean);
  for (const phase of phases) if (!PHASES.includes(phase)) throw new RangeError(`--phases: "${phase}" is not one of ${PHASES.join(', ')}`);
  const waitQuiet = value('wait-quiet') === undefined ? 0 : Number(value('wait-quiet'));
  if (!(waitQuiet >= 0 && waitQuiet <= 3600)) throw new RangeError('--wait-quiet must be a number of seconds from 0 to 3600.');
  const seedText = value('seed');
  const options = {};
  if (value('files') !== undefined) options.files = Number(value('files'));
  if (value('bytes') !== undefined) options.bytes = presets.parseByteSize(value('bytes'));
  return {
    help: flag('help'), phases, library: value('library'), libraryOut: value('library-out'), keep: flag('keep'), bench: !flag('no-bench'), waitQuiet, conditions: value('conditions'), revision: value('revision'),
    evidenceDir: value('evidence-dir'), label: value('label'), scanHook: value('scan-hook'), queryHook: value('query-hook'),
    options: { ...options, preset: value('preset') || null, seed: seedText === undefined || seedText === '' ? 1 : (/^\d+$/.test(seedText) ? Number(seedText) : seedText) },
  };
}

function machineFacts() {
  const cpus = os.cpus();
  return { platform: process.platform, osRelease: os.release(), arch: os.arch(), cpuModel: cpus[0]?.model?.trim() ?? 'unknown', logicalCpus: cpus.length, memoryGB: Math.round(os.totalmem() / 2 ** 30 * 10) / 10, node: process.versions.node };
}
const freeMemoryGB = () => Math.round(os.freemem() / 2 ** 30 * 10) / 10;

/**
 * Other node, electron and browser processes. The shared helper gives up when the platform tool exits with an error; some
 * restricted environments make tasklist list only part of the processes and exit with an error, so a second attempt keeps what it
 * printed and says that the list may be incomplete.
 */
async function otherProcesses() {
  const counts = await host.otherProcesses();
  if (counts) return { ...counts, complete: true };
  if (process.platform !== 'win32') return null;
  const tasklist = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
  const text = await new Promise(resolve => execFile(tasklist, ['/FO', 'CSV', '/NH'], { timeout: 20_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => resolve(stdout && stdout.length ? stdout : null)));
  return text === null ? null : { ...host.countProcesses(host.parseTasklist(text), [process.pid]), complete: false };
}

function gitRevision() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

/** Runs one phase body and records wall time, this process's processor time, peak resident memory and the machine load around it. */
async function measure(body) {
  const meter = host.startLoadMeter();
  const cpu = process.cpuUsage();
  const started = process.hrtime.bigint();
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 100);
  let outcome;
  try { outcome = await body(); } finally { clearInterval(timer); }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const used = process.cpuUsage(cpu);
  peak = Math.max(peak, process.memoryUsage().rss);
  const load = meter.stop(outcome && typeof outcome.appProcessSeconds === 'number' ? outcome.appProcessSeconds : undefined);
  return { outcome, timing: { ms: Math.round(ms), processCpuMs: Math.round((used.user + used.system) / 1000), peakRssMB: Math.round(peak / 2 ** 20), load } };
}

function phaseGenerate({ args, core, out }) {
  return async () => {
    const options = core.presets.resolveOptions(args.options);
    const generated = await generator.generateToDisk(options, out, { force: true, bench: args.bench });
    return { generated, options };
  };
}

function summarizeGenerate(timing, generated) {
  const stats = generated.manifest.stats;
  const seconds = Math.max(0.001, timing.ms / 1000);
  return {
    status: 'ok', ...timing, files: stats.files, members: stats.members, bytes: stats.bytes, families: stats.families,
    filesPerSecond: Math.round(stats.files / seconds), mibPerSecond: Math.round(stats.bytes / 1048576 / seconds * 10) / 10, treeHash: generated.manifest.treeHash,
  };
}

function runVerify(out) {
  return async () => {
    const problems = generator.verifyLibrary(out);
    return { problems };
  };
}

function loadHook(file, name) {
  if (!file) return null;
  const hook = require(path.resolve(file));
  if (typeof hook[name] !== 'function') throw new Error(`${file} does not export ${name}()`);
  return hook[name];
}

/** The latency targets against measured percentiles; a metric without samples is "not measured". */
function latencyChecks(report) {
  return Object.entries(LATENCY_TARGETS).map(([key, target]) => {
    const stat = report[key];
    return { metric: `${key} p95 (ms)`, value: stat && stat.n ? stat.p95 : null, target, comparison: '<=', pass: stat && stat.n ? stat.p95 <= target : null };
  });
}

function fmt(value, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-';
}

function formatMarkdown(report) {
  const lines = [`# Library benchmark: ${report.label}`, ''];
  const m = report.machine, h = report.host;
  lines.push(`- Conditions: **${report.conditions}**; ${m.logicalCpus} logical CPUs (${m.cpuModel}), ${m.memoryGB} GB memory, ${m.platform} ${m.arch}, Node ${m.node}`);
  lines.push(`- Other programs: ${h.before.cpuBusyPercent} % busy before, ${h.after.cpuBusyPercent} % after; ${h.before.processes ? `${h.before.processes.node} node, ${h.before.processes.electron} electron, ${h.before.processes.browser} browser of ${h.before.processes.total} processes${h.before.processes.complete ? '' : ' (list may be incomplete)'}` : 'processes not listed'}; ${h.before.freeMemoryGB} GB free before`);
  lines.push(`- Library: ${report.library.files} files + ${report.library.members} archive members, ${fmt(report.library.bytes / 1048576, 1)} MiB, ${report.library.families} families, seed ${report.options.seed}${report.options.preset ? `, preset ${report.options.preset}` : ''}`);
  if (report.revision) lines.push(`- Revision: ${report.revision}`);
  lines.push('', '| Phase | Status | Wall (s) | Process CPU (s) | Peak RSS (MB) | Machine busy (%) | Other busy (%) | Notes |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const phase of PHASES) {
    const entry = report.phases[phase];
    if (!entry) continue;
    if (entry.status !== 'ok') { lines.push(`| ${phase} | ${entry.status} | - | - | - | - | - | ${entry.reason ?? ''} |`); continue; }
    const notes = phase === 'generate' ? `${entry.filesPerSecond} files/s, ${entry.mibPerSecond} MiB/s` : phase === 'verify' ? `${entry.problems.length} problems` : phase === 'scan' ? `${entry.checks ? entry.checks.filter(check => check.pass === false).length : 0} target checks failed` : '';
    lines.push(`| ${phase} | ok | ${fmt(entry.ms / 1000, 2)} | ${fmt(entry.processCpuMs / 1000, 2)} | ${entry.peakRssMB} | ${entry.load.machineBusyPercent} | ${entry.load.otherBusyPercent ?? '-'} | ${notes} |`);
  }
  const scan = report.phases.scan;
  if (scan && scan.status === 'ok' && scan.metrics) {
    lines.push('', '## Grouping against the ground truth', '', '| Metric | Value | Target | Result |', '| --- | ---: | ---: | --- |');
    for (const check of scan.checks) lines.push(`| ${check.metric} | ${fmt(check.value, 4)} | ${check.comparison} ${check.target} | ${check.pass ? 'pass' : 'FAIL'} |`);
  }
  const query = report.phases.query;
  if (query && query.status === 'ok') {
    lines.push('', '## Query latency', '', '| Metric | p50 | p95 | Target (p95) | Result |', '| --- | ---: | ---: | ---: | --- |');
    for (const check of query.checks) { const key = check.metric.split(' ')[0]; lines.push(`| ${key} | ${fmt(query[key]?.p50, 1)} | ${fmt(query[key]?.p95, 1)} | ${check.comparison} ${check.target} | ${check.pass === null ? 'not measured' : check.pass ? 'pass' : 'FAIL'} |`); }
  }
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  const core = await generator.loadCore();
  const args = parseArguments(argv, core.presets);
  if (args.help || argv.length === 0) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^'use strict';\s*\/\*\n?/, '')); return 0; }
  const evidenceDir = path.resolve(args.evidenceDir || path.join(REPO, 'test-results', 'library-bench'));
  const generating = args.phases.includes('generate');
  if (!generating && !args.library) throw new Error('give --library=<dir> when the generate phase is left out');
  const label = args.label || (args.options.preset ? `${args.options.preset}-s${args.options.seed}` : `${args.options.files ?? 'library'}-s${args.options.seed}`);
  const scanHook = loadHook(args.scanHook, 'scan'), queryHook = loadHook(args.queryHook, 'query');
  const out = path.resolve(args.libraryOut || args.library || path.join(os.tmpdir(), `trace-library-bench-${label}`));
  const quiet = args.waitQuiet > 0 ? await host.waitUntilQuiet(args.waitQuiet) : null;
  const before = { cpuBusyPercent: await host.sampleBusyPercent(1000), freeMemoryGB: freeMemoryGB(), processes: await otherProcesses() };
  const report = {
    schema: REPORT_SCHEMA, kind: 'library-bench', label, createdAt: new Date().toISOString(), revision: args.revision || gitRevision(), machine: machineFacts(),
    options: { ...args.options, phases: args.phases, bench: args.bench }, library: null, host: { logicalCpus: os.cpus().length, before, after: null, waitedQuiet: quiet }, phases: {}, conditions: '',
  };
  let truth = null, manifest = null;
  try {
    if (generating) {
      const { outcome, timing } = await measure(phaseGenerate({ args, core, out }));
      report.phases.generate = summarizeGenerate(timing, outcome.generated);
      truth = outcome.generated.truth; manifest = outcome.generated.manifest;
      report.options = { ...report.options, files: outcome.options.files, bytes: outcome.options.bytes };
    } else report.phases.generate = { status: 'skipped', reason: 'using --library' };
    if (!truth) {
      truth = JSON.parse(fs.readFileSync(path.join(out, 'ground-truth.json'), 'utf8'));
      manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
      report.options = { ...report.options, files: manifest.options.files, bytes: manifest.options.bytes, seed: manifest.options.seed, preset: manifest.options.preset };
    }
    report.library = { files: manifest.stats.files, members: manifest.stats.members, bytes: manifest.stats.bytes, families: manifest.stats.families, kinds: manifest.stats.kinds, treeHash: manifest.treeHash };
    const root = path.join(out, 'library');

    if (args.phases.includes('verify')) {
      const { outcome, timing } = await measure(runVerify(out));
      report.phases.verify = { status: outcome.problems.length ? 'failed' : 'ok', ...timing, problems: outcome.problems.map(scrub), mibPerSecond: Math.round(manifest.stats.bytes / 1048576 / Math.max(0.001, timing.ms / 1000) * 10) / 10 };
    }
    let scanResult = null;
    if (args.phases.includes('scan')) {
      if (!scanHook) report.phases.scan = { status: 'skipped', reason: 'no scan hook (--scan-hook=<module>)' };
      else {
        const { outcome, timing } = await measure(async () => scanHook({ root, truth, options: report.options, log: message => console.log(scrub(message)) }));
        scanResult = outcome || {};
        const entry = { status: 'ok', ...timing, counters: scanResult.counters ?? null };
        if (scanResult.result) {
          const metrics = core.metrics.scoreResult(truth, scanResult.result);
          entry.metrics = metrics;
          entry.checks = core.metrics.checkTargets(metrics);
        }
        report.phases.scan = entry;
      }
    }
    if (args.phases.includes('query')) {
      if (!queryHook) report.phases.query = { status: 'skipped', reason: 'no query hook (--query-hook=<module>)' };
      else {
        const { outcome, timing } = await measure(async () => queryHook({ root, truth, scan: scanResult }));
        const latencies = outcome || {};
        const entry = { status: 'ok', ...timing, partNumber: summarize(latencies.partNumber), browse: summarize(latencies.browse), boardPage: summarize(latencies.boardPage) };
        entry.checks = latencyChecks(entry);
        report.phases.query = entry;
      }
    }
  } finally {
    report.host.after = { cpuBusyPercent: await host.sampleBusyPercent(1000), freeMemoryGB: freeMemoryGB(), processes: await otherProcesses() };
    if (generating && !args.keep && !args.libraryOut && !args.library) fs.rmSync(generator.fsPath(out), { recursive: true, force: true });
  }
  const measured = Object.values(report.phases).filter(phase => phase.load);
  report.host.duringRun = measured.length ? { otherBusyPercent: measured.every(phase => phase.load.otherBusyPercent !== null) ? Math.max(...measured.map(phase => phase.load.otherBusyPercent)) : null, machineBusyPercent: Math.max(...measured.map(phase => phase.load.machineBusyPercent)) } : null;
  report.conditions = host.classifyConditions([report.host], args.conditions);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const base = path.join(evidenceDir, `bench-${label}-${report.createdAt.replace(/[:.]/g, '-')}`);
  const text = scrub(JSON.stringify(report, null, 2));
  fs.writeFileSync(`${base}.json`, `${text}\n`);
  fs.writeFileSync(`${base}.md`, scrub(formatMarkdown(JSON.parse(text))));
  console.log(`report: ${scrub(`${base}.json`)}`);
  const failed = Object.values(report.phases).some(phase => phase.status === 'failed');
  return failed ? 1 : 0;
}

module.exports = { percentile, summarize, parseArguments, formatMarkdown, latencyChecks, scrub, LATENCY_TARGETS, PHASES };

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(scrub(error.message)); process.exitCode = 1; });
