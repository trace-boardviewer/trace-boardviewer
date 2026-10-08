#!/usr/bin/env node
'use strict';

/**
 * Parser fuzzing runner. Feeds mutated seed files and random bytes to every registered board parser, sniff and container, the schematic
 * readers and the shared low-level readers (tests/fuzz/targets.ts) and checks the contract of each (tests/fuzz/engine.ts):
 * only the documented errors, a valid and bounded result, unchanged input, a repeatable result, a time that grows linearly with the
 * input. The work runs in worker threads that this script watches: a call that exceeds its time budget by far is a hang and an
 * out-of-memory worker is a memory finding; either way the worker is replaced and the run goes on.
 *
 *   node scripts/fuzz-parsers.cjs                          short deterministic run (CI), well under a minute
 *   node scripts/fuzz-parsers.cjs --mode long --minutes 30 --save
 *   node scripts/fuzz-parsers.cjs --replay board:kicad:57  rerun one input of the short run (prints it as hex with --hex)
 *
 * Options
 *   --mode ci|long        ci: fixed number of inputs per target (default); long: runs until --minutes have passed
 *   --minutes N           long mode duration (default 10)
 *   --iterations N        ci mode: mutated inputs per target (default 2000)
 *   --seed TEXT           seed of the run (default: ci-1 in ci mode, a fresh one in long mode, printed so the run can be repeated)
 *   --workers N           worker threads (default: half of the cores, at most 4)
 *   --targets A,B         only targets whose id contains one of these texts (board:kicad, schematic, util:inflate, ...)
 *   --max-kib N           largest primary file in KiB (default 192 in ci mode, 1024 in long mode)
 *   --time-scale F        multiplies every time budget (default 1; raise it on a loaded machine)
 *   --heap-mb N           old-generation heap limit of a worker, the memory budget of one input (default 1024)
 *   --save                write the minimized crashing inputs to tests/fuzz/regressions/
 *   --no-shrink           report findings without minimizing them
 *   --out DIR             where the report goes (default .fuzz/report)
 *   --keep-going          do not stop dispatching after the first finding of a target (default: a target with a finding gets a smaller share)
 *
 * Exit status: 0 when nothing was found, 1 when there are findings, 2 when the run itself failed.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const args = (() => {
  const result = { flags: new Set(), values: {} };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (['save', 'no-shrink', 'keep-going', 'hex', 'keep-build'].includes(name)) result.flags.add(name);
    else { result.values[name] = argv[++index]; if (result.values[name] === undefined) throw new Error(`--${name} needs a value`); }
  }
  return result;
})();
const number = (name, fallback) => { const text = args.values[name]; if (text === undefined) return fallback; const value = Number(text); if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`); return value; };

const mode = args.values.mode ?? 'ci';
if (!['ci', 'long'].includes(mode)) throw new Error('--mode must be ci or long');
const long = mode === 'long';
const seed = args.values.seed ?? (long ? `long-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}` : 'ci-1');
const workerCount = Math.max(1, Math.floor(number('workers', Math.min(4, Math.max(1, Math.floor(os.cpus().length / 2))))));
const iterations = Math.floor(number('iterations', 2000));
const minutes = number('minutes', 10);
const timeScale = number('time-scale', 1);
const heapMb = Math.floor(number('heap-mb', 1024));
const maxBytes = Math.floor(number('max-kib', long ? 1024 : 192) * 1024);
const outDir = path.resolve(root, args.values.out ?? path.join('.fuzz', 'report'));
const corpusDir = path.join(root, 'tests', 'fuzz', 'corpus');
const regressionDir = path.join(root, 'tests', 'fuzz', 'regressions');
const BATCH = long ? 250 : 100;
const SWEEP_SLICE = 130;

const log = (...parts) => console.log(...parts);
const now = () => Date.now();

// ---------------------------------------------------------------------------------------------------------------------------------
// Build and load the TypeScript sources of the harness
// ---------------------------------------------------------------------------------------------------------------------------------

async function bundle() {
  const outputDir = path.join(root, '.fuzz', 'build');
  const { build } = await import('vite');
  await build({
    configFile: false, root, logLevel: 'warn', publicDir: false,
    build: { ssr: path.join(root, 'tests', 'fuzz', 'runner-entry.ts'), outDir: outputDir, emptyOutDir: true, minify: false, sourcemap: false, target: 'node24', rollupOptions: { output: { format: 'es', entryFileNames: 'fuzz-runner.mjs' } } },
    ssr: { noExternal: true },
  });
  const file = path.join(outputDir, 'fuzz-runner.mjs');
  if (!fs.existsSync(file)) throw new Error('The fuzz harness bundle was not written.');
  return file;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Worker pool with a watchdog
// ---------------------------------------------------------------------------------------------------------------------------------

class Slot {
  constructor(bundleFile, config) {
    this.bundleFile = bundleFile; this.config = config;
    this.job = null; this.worker = null; this.status = null; this.ready = false; this.killedBy = null; this.onDone = null; this.onChecked = new Map();
  }
  start() {
    const shared = new SharedArrayBuffer(8 * 4);
    this.status = new Float64Array(shared);
    this.killedBy = null; this.ready = false;
    const worker = new Worker(this.bundleFile, {
      workerData: { fuzzWorker: true, corpusDir, config: this.config, status: shared },
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 64 },
      stdout: false, stderr: false,
    });
    this.worker = worker;
    this.dead = false;
    // A worker that was replaced may still report its exit: only the current one counts.
    worker.on('message', message => { if (this.worker === worker) this.onMessage(message); });
    worker.on('error', error => { if (this.worker === worker) this.onDeath(error); });
    worker.on('exit', code => { if (this.worker === worker) this.onDeath(code === 0 ? null : new Error(`worker exited with code ${code}`)); });
    return new Promise(resolve => { this.resolveReady = resolve; });
  }
  onMessage(message) {
    if (message.type === 'ready') { this.ready = true; this.resolveReady?.(); return; }
    if (message.type === 'done') { const done = this.onDone; this.onDone = null; this.job = null; done?.({ ok: true, message }); return; }
    if (message.type === 'checked') { const resolve = this.onChecked.get(message.id); this.onChecked.delete(message.id); resolve?.({ ok: true, message }); }
  }
  onDeath(error) {
    if (this.dead) return;
    this.dead = true;
    const reason = this.killedBy ?? (error && error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : error ? 'crash' : 'exit');
    const position = this.status[3];
    const done = this.onDone; this.onDone = null; this.job = null;
    const checks = [...this.onChecked.values()]; this.onChecked.clear();
    const death = { ok: false, reason, position, error: error ? String(error.message || error).slice(0, 200) : '' };
    done?.(death);
    for (const resolve of checks) resolve(death);
    this.resolveReady?.();
  }
  /** Time since the current input started, and the budget it was given; null when idle. */
  running() {
    if (!this.status || this.status[2] === 0) return null;
    return { since: now() - this.status[1], budget: this.status[2], position: this.status[3] };
  }
  kill(reason) { this.killedBy = reason; this.worker.terminate(); }
  run(message) { return new Promise(resolve => { this.job = message; this.onDone = resolve; this.worker.postMessage(message); }); }
  check(id, target, input) { return new Promise(resolve => { this.onChecked.set(id, resolve); this.worker.postMessage({ type: 'check', id, target, input }); }); }
}

const hardLimit = budget => Math.max(4000, budget * 3 + 1000);

// ---------------------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------------------

async function main() {
  const started = now();
  log(`Building the fuzz harness...`);
  const bundleFile = await bundle();
  const harness = await import(pathToFileURL(bundleFile).href);
  const config = { seed, maxBytes, timeScale };
  const corpus = harness.loadSeeds(corpusDir);
  const filters = args.values.targets ? args.values.targets.split(',').map(text => text.trim()).filter(Boolean) : [];
  const targets = harness.ALL_TARGETS().filter(target => !filters.length || filters.some(text => target.id.includes(text)));
  if (!targets.length) throw new Error('No target matches --targets.');
  const targetById = new Map(targets.map(target => [target.id, target]));
  const pools = new Map(targets.map(target => [target.id, harness.buildPool(target, corpus)]));

  if (args.values.replay) return replay(harness, config, targetById, pools, bundleFile);

  log(`${long ? `Long run of ${minutes} min` : `Short run of ${iterations} inputs per target`}, seed ${seed}, ${workerCount} workers, ${targets.length} targets, ${corpus.length} seeds, inputs up to ${Math.round(maxBytes / 1024)} KiB.`);

  // --- job queue --------------------------------------------------------------------------------------------------------------
  const stats = new Map(targets.map(target => [target.id, { executed: 0, outcomes: {}, errorCodes: {}, ms: 0, maxMs: 0, maxUnits: 0, maxBytes: 0, slowest: [], jobs: 0, nextIteration: 0, sweepNext: 0, sweepDone: false }]));
  const findings = new Map();
  const deadline = long ? started + minutes * 60_000 : Infinity;
  const quiet = new Set();

  const record = (target, found) => {
    const entry = findings.get(found.finding.signature);
    if (entry) { entry.count++; return; }
    findings.set(found.finding.signature, { target, finding: found.finding, label: found.label, iteration: found.iteration, ms: found.ms, input: found.input, count: 1 });
    log(`  FINDING ${found.finding.kind} in ${target}: ${found.finding.message}  [${found.label}]`);
  };
  const addStats = (target, batch) => {
    const total = stats.get(target);
    total.executed += batch.executed; total.ms += batch.ms; total.maxMs = Math.max(total.maxMs, batch.maxMs); total.maxUnits = Math.max(total.maxUnits, batch.maxUnits); total.maxBytes = Math.max(total.maxBytes, batch.maxBytes);
    for (const [key, count] of Object.entries(batch.outcomes)) total.outcomes[key] = (total.outcomes[key] ?? 0) + count;
    for (const [key, count] of Object.entries(batch.errorCodes)) total.errorCodes[key] = (total.errorCodes[key] ?? 0) + count;
    total.slowest.push(...batch.slowest); total.slowest.sort((a, b) => b.ms - a.ms); total.slowest.length = Math.min(total.slowest.length, 3);
  };

  /** Next piece of work, or null when there is none (yet). */
  let cursor = 0;
  const nextJob = () => {
    if (now() > deadline) return null;
    for (let tries = 0; tries < targets.length; tries++) {
      const target = targets[cursor++ % targets.length];
      const total = stats.get(target.id);
      const pool = pools.get(target.id);
      if (!total.sweepDone) {
        const size = harness.sweepSize(pool);
        if (total.sweepNext < size) { const job = { type: 'run', target: target.id, phase: 'sweep', from: total.sweepNext, count: Math.min(SWEEP_SLICE, size - total.sweepNext) }; total.sweepNext += job.count; return job; }
        total.sweepDone = true;
      }
      if (!long && total.nextIteration >= iterations) continue;
      if (long && quiet.has(target.id) && total.nextIteration > 20 * BATCH) continue;
      const job = { type: 'run', target: target.id, phase: 'iterations', from: total.nextIteration, count: long ? BATCH : Math.min(BATCH, iterations - total.nextIteration) };
      total.nextIteration += job.count;
      return job;
    }
    return null;
  };

  const slots = Array.from({ length: workerCount }, () => new Slot(bundleFile, config));
  await Promise.all(slots.map(slot => slot.start()));

  const watchdog = setInterval(() => {
    for (const slot of slots) {
      const running = slot.running();
      if (running && running.since > hardLimit(running.budget)) slot.kill('hang');
    }
  }, 100);

  let lastReport = now();
  async function drive(slot) {
    for (let job = nextJob(); job; job = nextJob()) {
      let remaining = job;
      while (remaining) {
        const outcome = await slot.run(remaining);
        if (outcome.ok) {
          addStats(job.target, outcome.message.stats);
          for (const found of outcome.message.found) record(job.target, found);
          stats.get(job.target).jobs++;
          remaining = null;
        } else {
          // The worker died at `position`: report that input and go on after it with a fresh worker.
          const position = outcome.position;
          const pool = pools.get(job.target), target = targetById.get(job.target);
          const ref = position < 0 ? -(position + 1) : position;
          const rebuilt = position < 0 ? harness.sweepInput(pool, ref) : { label: `iteration ${ref}`, input: harness.generate(target, pool, config, ref) };
          const kind = outcome.reason === 'exit' ? 'crash' : outcome.reason;
          const finding = { kind, message: kind === 'hang' ? `no result within the time limit (${rebuilt.input.data.length} bytes)` : kind === 'memory' ? `out of memory with a ${Math.round(heapMb)} MiB heap (${rebuilt.input.data.length} bytes)` : `the worker died: ${outcome.error}`, signature: `${job.target}|${kind}|worker` };
          record(job.target, { label: rebuilt.label, iteration: position, finding, ms: 0, input: harness.packInput(rebuilt.input) });
          await slot.start();
          const done = ref + 1 - remaining.from;
          const left = remaining.count - done;
          remaining = left > 0 ? { ...remaining, from: remaining.from + done, count: left } : null;
          if (!long) quiet.add(job.target);
        }
        if (findings.size && !args.flags.has('keep-going')) for (const entry of findings.values()) quiet.add(entry.target);
        if (long && now() - lastReport > 60_000) { lastReport = now(); progress(); }
      }
    }
  }
  const progress = () => {
    const done = [...stats.values()].reduce((sum, entry) => sum + entry.executed, 0);
    log(`  ${Math.round((now() - started) / 1000)} s: ${done} inputs, ${findings.size} finding(s)`);
  };
  await Promise.all(slots.map(drive));
  clearInterval(watchdog);
  await Promise.all(slots.map(slot => slot.worker.terminate().catch(() => undefined)));
  const runMs = now() - started;

  // --- report ----------------------------------------------------------------------------------------------------------------
  log('');
  log('target'.padEnd(26) + 'inputs'.padStart(9) + '  ' + 'result'.padEnd(20) + 'errors'.padEnd(28) + 'max ms'.padStart(8) + ' ' + 'max bytes'.padStart(10));
  for (const target of targets) {
    const total = stats.get(target.id);
    const outcomes = `${total.outcomes.output ?? 0} ok/${total.outcomes.null ?? 0} no/${total.outcomes.error ?? 0} err`;
    const codes = Object.entries(total.errorCodes).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([code, count]) => `${code} ${count}`).join(', ');
    log(target.id.padEnd(26) + String(total.executed).padStart(9) + '  ' + outcomes.padEnd(20) + codes.padEnd(28) + total.maxMs.toFixed(1).padStart(8) + ' ' + String(total.maxBytes).padStart(10));
  }
  const totalInputs = [...stats.values()].reduce((sum, entry) => sum + entry.executed, 0);
  log(`\n${totalInputs} inputs in ${(runMs / 1000).toFixed(1)} s, ${findings.size} distinct finding(s).`);

  // --- shrink and save ---------------------------------------------------------------------------------------------------------
  const saved = [];
  if (findings.size) {
    const checker = new Slot(bundleFile, config);
    await checker.start();
    let checkId = 0;
    const workerProbe = (targetId) => async candidate => {
      // For findings that can only be seen in a worker (hang, out of memory): did the worker die again?
      const limitWatch = setInterval(() => { const running = checker.running(); if (running && running.since > hardLimit(running.budget)) checker.kill('hang'); }, 50);
      try {
        const outcome = await checker.check(++checkId, targetId, harness.packInput(candidate));
        if (!outcome.ok) { await checker.start(); return true; }
        return false;
      } finally { clearInterval(limitWatch); }
    };
    for (const [signature, entry] of findings) {
      const target = targetById.get(entry.target);
      let input = harness.unpackInput(entry.input);
      const remote = ['hang', 'memory', 'crash'].includes(entry.finding.kind);
      let reproduced = true;
      if (!remote) {
        const again = harness.runCase(target, input, config);
        reproduced = Boolean(again.finding && again.finding.kind === entry.finding.kind && again.finding.signature === entry.finding.signature);
        if (!reproduced && entry.finding.kind === 'slow') reproduced = harness.runCaseConfirmed(target, input, config).finding?.kind === 'slow';
      }
      if (!reproduced) { log(`  not reproducible, not saved: ${signature}`); entry.flaky = true; continue; }
      if (!args.flags.has('no-shrink')) {
        log(`  shrinking ${signature} (${input.data.length} bytes)...`);
        const probe = remote ? workerProbe(entry.target) : harness.inProcessProbe(target, entry.finding, config, entry.ms);
        input = await harness.shrink(input, probe, { maxTests: remote ? 120 : 1500, deadlineMs: remote ? 120_000 : 60_000 });
        log(`    -> ${input.data.length} bytes${input.companions ? ` and ${Object.keys(input.companions).length} companion(s)` : ''}`);
      }
      entry.minimized = harness.packInput(input);
      const text = JSON.stringify(entry.minimized);
      const id = crypto.createHash('sha1').update(entry.target).update(entry.finding.kind).update(text).digest('hex').slice(0, 8);
      const file = `${entry.target.replace(/[^A-Za-z0-9]+/g, '-')}-${entry.finding.kind}-${id}.json`;
      entry.fixture = file;
      if (args.flags.has('save')) {
        fs.mkdirSync(regressionDir, { recursive: true });
        const fixture = { target: entry.target, finding: entry.finding.kind, note: entry.finding.message.slice(0, 200), ...entry.minimized };
        fs.writeFileSync(path.join(regressionDir, file), `${JSON.stringify(fixture, null, 1)}\n`);
        saved.push(file);
      }
    }
    await checker.worker.terminate().catch(() => undefined);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const reportFile = path.join(outDir, `${mode}-${seed.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`);
  fs.writeFileSync(reportFile, JSON.stringify({
    mode, seed, workers: workerCount, iterations: long ? null : iterations, minutes: long ? minutes : null, maxBytes, timeScale, heapMb, seconds: runMs / 1000, inputs: totalInputs,
    targets: Object.fromEntries(targets.map(target => { const { sweepDone, sweepNext, nextIteration, ...rest } = stats.get(target.id); return [target.id, { ...rest, iterations: nextIteration }]; })),
    findings: [...findings.values()].map(entry => ({ target: entry.target, kind: entry.finding.kind, message: entry.finding.message, signature: entry.finding.signature, count: entry.count, label: entry.label, iteration: entry.iteration, fixture: entry.fixture ?? null, flaky: entry.flaky ?? false })),
  }, null, 1));
  log(`Report: ${path.relative(root, reportFile)}`);
  if (saved.length) log(`Saved regression fixtures: ${saved.join(', ')}`);
  if (!args.flags.has('keep-build')) fs.rmSync(path.join(root, '.fuzz', 'build'), { recursive: true, force: true });
  return findings.size ? 1 : 0;
}

async function replay(harness, config, targetById, pools, bundleFile) {
  // --replay <target>:<iteration>  (the iteration number a finding prints; "seed 7" style labels are sweep inputs and are not replayed here)
  const text = args.values.replay;
  const at = text.lastIndexOf(':');
  const targetId = text.slice(0, at), iteration = Number(text.slice(at + 1));
  const target = targetById.get(targetId);
  if (!target || !Number.isInteger(iteration) || iteration < 0) throw new Error('--replay needs <target>:<iteration>, for example board:kicad:57');
  const input = harness.generate(target, pools.get(targetId), config, iteration);
  const result = harness.runCase(target, input, config);
  log(`${targetId} iteration ${iteration} (seed ${config.seed}): ${harness.describeInput(input)} -> ${result.outcome}${result.errorCode ? ` ${result.errorCode}` : ''}, ${result.ms.toFixed(1)} ms`);
  if (result.finding) log(`FINDING ${result.finding.kind}: ${result.finding.message}`);
  if (args.flags.has('hex')) log(Buffer.from(input.data).toString('hex'));
  else log(Buffer.from(input.data.subarray(0, 400)).toString('latin1').replace(/[^\x09\x0a\x20-\x7e]/g, '.'));
  void bundleFile;
  return result.finding ? 1 : 0;
}

main().then(code => process.exit(code), error => { console.error(error && error.stack ? error.stack : error); process.exit(2); });
