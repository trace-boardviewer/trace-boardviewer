#!/usr/bin/env node
'use strict';

// MEASUREMENT ONLY — never a gate. Quantifies two intermittent residuals of the portable wrapper on real Windows:
//
//   R1 "startup race": two wrappers started within milliseconds of each other. For every attempt the %TEMP% directory is
//      watched at ~1-2 ms resolution for NSIS plug-in directories (ns<letter><hex>.tmp: first a temp FILE, then a DIRECTORY),
//      the launchers' exit codes/timings are recorded, and the attempt is classified: two private directories while both
//      wrappers live (isolated), ONE directory shared by two live wrappers (shared-plugins-dir), or a launcher lost.
//      Anomalous attempts run on so the consequence (survivor's runtime directory and file count) is recorded.
//   R2 "second-instance leftover": a same-profile second launch D that exits by itself (single-instance lock). After the
//      wrapper exits, every NEW ns*.tmp directory is re-scanned over time with its remaining files, the processes that still
//      run from it or hold a module inside it, D's own process tree from a background sampler (main process and
//      --type children, with their last observation relative to the wrapper's exit), the Application event log and WER.
//
// Exit code: 0 = measurements written (whatever they show), 2 = infrastructure failure. Nothing here changes the verdict of
// scripts/check-portable-isolation.cjs; this script only reuses its pure helpers and its Windows platform layer.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const check = require('./check-portable-isolation.cjs');

const SCHEMA = 'trace-portable-startup-measurement/1';
const TOOL_NAME = 'scripts/measure-portable-startup.cjs';
const MAIN_EXE_NAME = check.MAIN_EXE_NAME;
const NSIS_ENTRY_RE = /^ns[a-z][0-9A-F]+\.tmp$/i; // the plug-in dir AND the temp file it starts as share this name shape
const EXIT = Object.freeze({ OK: 0, INFRA: 2 });
const DEFAULTS = Object.freeze({
  staggers: [0, 2, 10, 40],
  attempts: 20,
  secondInstance: 20,
  observeMs: 2500, // startup race: decision point (the plug-in dir is created within the first ~100 ms)
  readyTimeoutMs: 120000,
  leftoverScansMs: [0, 1000, 2000, 5000, 10000],
  leftoverExtraWaitMs: 30000, // after the last scan, a leftover is watched this long more before it is force-removed
  maxTotalSec: 2700,
  label: 'fixed',
});
const USAGE = `Usage: node ${TOOL_NAME} --exe <portable.exe> [--out <file.json>] [--staggers 0,2,10,40] [--attempts N] [--second-instance N] [--label fixed|control] [--max-total-sec N]`;

class InfraError extends Error { constructor(message, step) { super(message); this.name = 'InfraError'; this.step = step || null; } }

const round2 = (value) => Math.round(value * 100) / 100;
const nowMs = () => performance.timeOrigin + performance.now(); // epoch ms with sub-ms resolution (PowerShell samples use epoch ms too)

// ---------------------------------------------------------------------------------------------------------
// Pure helpers (tested in tests/portable-startup-measurement-checks.cjs)
// ---------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { exe: null, out: 'portable-startup-measurement.json', staggers: DEFAULTS.staggers.slice(), attempts: DEFAULTS.attempts, secondInstance: DEFAULTS.secondInstance, label: DEFAULTS.label, maxTotalSec: DEFAULTS.maxTotalSec, help: false };
  const needValue = (flag, index) => { if (index + 1 >= argv.length) throw new Error(`${flag} needs a value`); return argv[index + 1]; };
  const count = (flag, raw, max) => { if (!/^\d+$/.test(raw) || Number(raw) > max) throw new Error(`${flag} must be a whole number between 0 and ${max}, got "${raw}"`); return Number(raw); };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (flag === '--exe') { options.exe = needValue(flag, i); i++; continue; }
    if (flag === '--out') { options.out = needValue(flag, i); i++; continue; }
    if (flag === '--staggers') {
      const raw = needValue(flag, i); i++;
      options.staggers = raw.split(',').map((item) => item.trim()).filter(Boolean).map((item) => count(flag, item, 60000));
      if (!options.staggers.length) throw new Error('--staggers needs at least one value');
      continue;
    }
    if (flag === '--attempts') { options.attempts = count(flag, needValue(flag, i), 200); i++; continue; }
    if (flag === '--second-instance') { options.secondInstance = count(flag, needValue(flag, i), 200); i++; continue; }
    if (flag === '--max-total-sec') { options.maxTotalSec = count(flag, needValue(flag, i), 21600); i++; continue; }
    if (flag === '--label') { options.label = needValue(flag, i); i++; if (!/^[a-z0-9-]+$/i.test(options.label)) throw new Error('--label must be alphanumeric'); continue; }
    throw new Error(`unknown argument ${flag}`);
  }
  if (!options.help && !options.exe) throw new Error('--exe is required');
  return options;
}

/**
 * Classifies one startup-race attempt at its decision point. Pure.
 *   launchers: { A: {alive, exitCode, elapsedMs}, B: {...} }; newDirs: names of NEW ns*.tmp DIRECTORIES present now.
 *   isolated                 both wrappers alive, >= 2 private directories (the expected outcome)
 *   shared-plugins-dir       both wrappers alive but only ONE new directory: they share an NSIS plug-in directory
 *   no-dir-yet               both alive, no directory yet (decision point too early / slow machine)
 *   A-lost | B-lost          one wrapper exited by itself before the decision point
 *   both-lost                both exited
 */
function classifyAttempt(launchers, newDirs) {
  const aliveA = launchers.A.alive, aliveB = launchers.B.alive;
  if (!aliveA && !aliveB) return 'both-lost';
  if (!aliveA) return 'A-lost';
  if (!aliveB) return 'B-lost';
  if (newDirs.length >= 2) return 'isolated';
  if (newDirs.length === 1) return 'shared-plugins-dir';
  return 'no-dir-yet';
}

/**
 * Per-stagger counts from the attempt records. Pure. Exit codes count ONLY wrappers that exited by themselves (before the
 * decision point, or during the follow-up); wrappers closed or killed by the measurement never enter the histogram.
 */
function summarizeRace(attempts) {
  const byStagger = new Map();
  for (const attempt of attempts) {
    const key = String(attempt.nominalMs);
    if (!byStagger.has(key)) byStagger.set(key, { nominalMs: attempt.nominalMs, attempts: 0, isolated: 0, sharedPluginsDir: 0, noDirYet: 0, aLost: 0, bLost: 0, bothLost: 0, selfExitCodes: {}, achievedMs: [], selfExitElapsedMs: [], survivorsIntact: 0, survivorsDamaged: 0, survivorsUnknown: 0, survivorsNotReady: 0 });
    const row = byStagger.get(key);
    row.attempts++;
    row.achievedMs.push(attempt.achievedMs);
    const field = { isolated: 'isolated', 'shared-plugins-dir': 'sharedPluginsDir', 'no-dir-yet': 'noDirYet', 'A-lost': 'aLost', 'B-lost': 'bLost', 'both-lost': 'bothLost' }[attempt.classification];
    if (field) row[field]++;
    const countSelfExit = (code, elapsedMs) => { row.selfExitCodes[String(code)] = (row.selfExitCodes[String(code)] || 0) + 1; if (typeof elapsedMs === 'number') row.selfExitElapsedMs.push(elapsedMs); };
    for (const label of ['A', 'B']) {
      const launcher = attempt.launchers && attempt.launchers[label];
      if (launcher && !launcher.alive) countSelfExit(launcher.exitCode, launcher.elapsedMs);
    }
    for (const survivor of Object.values((attempt.followUp && attempt.followUp.survivors) || {})) {
      if (survivor.outcome === 'exited') { countSelfExit(survivor.exitCode, survivor.afterMs); continue; }
      if (survivor.outcome !== 'ready') { row.survivorsNotReady++; continue; }
      if (survivor.intact === true) row.survivorsIntact++; else if (survivor.intact === false) row.survivorsDamaged++; else row.survivorsUnknown++;
    }
  }
  const stats = (values) => (values.length ? { n: values.length, min: Math.min(...values), max: Math.max(...values), mean: round2(values.reduce((a, b) => a + b, 0) / values.length) } : null);
  return [...byStagger.values()].map((row) => ({ ...row, achievedMs: stats(row.achievedMs), selfExitElapsedMs: stats(row.selfExitElapsedMs) }));
}

/** Parses the sampler's JSON lines ({t, procs:[{pid,ppid,exe,type}]}); malformed lines are counted, never thrown. Pure. */
function parseSamplerLog(text) {
  const samples = [];
  let malformed = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const sample = JSON.parse(trimmed);
      if (!sample || typeof sample.t !== 'number' || !Array.isArray(sample.procs)) { malformed++; continue; }
      samples.push({ t: sample.t, costMs: sample.costMs ?? null, procs: sample.procs.map((proc) => ({ pid: Number(proc.pid), ppid: Number(proc.ppid), exe: proc.exe || null, type: proc.type || '' })) });
    } catch { malformed++; }
  }
  return { samples, malformed };
}

/**
 * The process tree of one wrapper (pid) as the sampler saw it between fromMs and toMs: the main process (ppid == wrapper,
 * no --type) and its direct children, each with first/last observation relative to the wrapper's exit. Pure.
 */
function wrapperTreeFromSamples(samples, wrapperPid, { fromMs, toMs, wrapperExitMs }) {
  const seen = new Map(); // pid -> record
  for (const sample of samples) {
    if (sample.t < fromMs || sample.t > toMs) continue;
    const mains = sample.procs.filter((proc) => proc.ppid === wrapperPid && proc.type === '');
    for (const main of mains) {
      const rec = seen.get(main.pid) || { pid: main.pid, role: 'main', type: '', exe: main.exe, firstSeenMs: sample.t, lastSeenMs: sample.t, samples: 0 };
      rec.lastSeenMs = sample.t; rec.samples++; seen.set(main.pid, rec);
      for (const child of sample.procs.filter((proc) => proc.ppid === main.pid)) {
        const crec = seen.get(child.pid) || { pid: child.pid, role: 'child', type: child.type, exe: child.exe, firstSeenMs: sample.t, lastSeenMs: sample.t, samples: 0, parentPid: main.pid };
        crec.lastSeenMs = sample.t; crec.samples++; seen.set(child.pid, crec);
      }
    }
  }
  const rel = (value) => (wrapperExitMs === null || wrapperExitMs === undefined ? null : round2(value - wrapperExitMs));
  return [...seen.values()].map((rec) => ({ ...rec, firstSeenRelToWrapperExitMs: rel(rec.firstSeenMs), lastSeenRelToWrapperExitMs: rel(rec.lastSeenMs), seenAfterWrapperExit: wrapperExitMs !== null && rec.lastSeenMs > wrapperExitMs }));
}

function summarizeSecondInstance(attempts) {
  const summary = { attempts: attempts.length, exitCodes: {}, leftoverAtLastScan: 0, leftoverRemovedByMeasurement: 0, leftoverStillLocked: 0, leftoverFileCounts: [], childrenSeenAfterWrapperExit: 0, mainObserved: 0, gpuChildObserved: 0, holdersObserved: 0 };
  for (const attempt of attempts) {
    const code = String(attempt.wrapper.exitCode);
    summary.exitCodes[code] = (summary.exitCodes[code] || 0) + 1;
    const last = attempt.leftoverScans && attempt.leftoverScans.length ? attempt.leftoverScans[attempt.leftoverScans.length - 1] : null;
    if (last && last.dirs.length) {
      summary.leftoverAtLastScan++;
      summary.leftoverFileCounts.push(last.dirs.reduce((total, dir) => total + dir.files.length, 0));
      if (attempt.leftoverHolders && attempt.leftoverHolders.some((holder) => holder.rows.length)) summary.holdersObserved++;
      if (attempt.leftoverRemoval) { if (attempt.leftoverRemoval.every((item) => item.removed)) summary.leftoverRemovedByMeasurement++; else summary.leftoverStillLocked++; }
    }
    const tree = attempt.tree || [];
    if (tree.some((rec) => rec.role === 'main')) summary.mainObserved++;
    if (tree.some((rec) => rec.role === 'child' && rec.type === 'gpu-process')) summary.gpuChildObserved++;
    if (tree.some((rec) => rec.seenAfterWrapperExit)) summary.childrenSeenAfterWrapperExit++;
  }
  return summary;
}

function formatSummary(evidence) {
  const lines = [`Portable startup measurement (${evidence.label}): ${evidence.status}${evidence.infrastructureError ? ` — ${evidence.infrastructureError.message}` : ''}`];
  if (evidence.race && evidence.race.summary) {
    lines.push(`startup race (observe ${evidence.race.observeMs} ms; %TEMP% watcher median tick ${evidence.race.watcherTickMs ? evidence.race.watcherTickMs.median : '?'} ms, max gap ${evidence.race.watcherTickMs ? evidence.race.watcherTickMs.max : '?'} ms):`);
    for (const row of evidence.race.summary) {
      lines.push(`  stagger ${row.nominalMs} ms: ${row.attempts} attempts (achieved ${row.achievedMs ? `${row.achievedMs.min}..${row.achievedMs.max}` : '?'} ms): isolated=${row.isolated} shared-plugins-dir=${row.sharedPluginsDir} A-lost=${row.aLost} B-lost=${row.bLost} both-lost=${row.bothLost} no-dir-yet=${row.noDirYet}; self-exit codes ${JSON.stringify(row.selfExitCodes)}${row.selfExitElapsedMs ? ` after ${row.selfExitElapsedMs.min}..${row.selfExitElapsedMs.max} ms` : ''}; survivors intact=${row.survivorsIntact} damaged=${row.survivorsDamaged} not-ready=${row.survivorsNotReady} unknown=${row.survivorsUnknown}`);
    }
  }
  if (evidence.baseline) lines.push(`baseline (one launch alone): ${evidence.baseline.outcome}, ${evidence.baseline.files} files / ${evidence.baseline.bytes} B, ready after ${evidence.baseline.afterMs} ms, closed with exit ${evidence.baseline.close ? evidence.baseline.close.exitCode : '?'}`);
  if (evidence.secondInstance && evidence.secondInstance.summary) {
    const s = evidence.secondInstance.summary;
    lines.push(`second instance (same profile, quick exit): ${s.attempts} attempts, D exit codes ${JSON.stringify(s.exitCodes)}, main process observed ${s.mainObserved}x, gpu child observed ${s.gpuChildObserved}x, process tree seen AFTER wrapper exit ${s.childrenSeenAfterWrapperExit}x, leftover directories at the last scan ${s.leftoverAtLastScan}x (file counts ${JSON.stringify(s.leftoverFileCounts)}), holders found ${s.holdersObserved}x, removable later ${s.leftoverRemovedByMeasurement}x, still locked ${s.leftoverStillLocked}x`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------
// Windows side
// ---------------------------------------------------------------------------------------------------------

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

function runPowerShell(script, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', check.encodePowerShell(script)],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => { if (error) reject(new Error(`powershell.exe failed: ${error.message}${stderr ? ` | ${String(stderr).slice(0, 300)}` : ''}`)); else resolve(stdout); });
  });
}

function samplerScript(stopFile, maxSeconds) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }',
    `$stop = ${psQuote(stopFile)}`,
    `$deadline = (Get-Date).AddSeconds(${maxSeconds})`,
    `$name = ${psQuote(MAIN_EXE_NAME)}`,
    'while (-not (Test-Path -LiteralPath $stop) -and (Get-Date) -lt $deadline) {',
    '  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    "  $rows = @()",
    "  foreach ($c in @(Get-CimInstance -ClassName Win32_Process -Filter \"Name = '$name'\")) {",
    "    $type = ''",
    "    if ($c.CommandLine -match '--type=([A-Za-z0-9_-]+)') { $type = $Matches[1] }",
    '    $rows += [pscustomobject]@{ pid = [int]$c.ProcessId; ppid = [int]$c.ParentProcessId; exe = $c.ExecutablePath; type = $type }',
    '  }',
    '  $t1 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '  [Console]::Out.WriteLine((ConvertTo-Json -InputObject ([pscustomobject]@{ t = $t0; costMs = ($t1 - $t0); procs = $rows }) -Compress -Depth 4))',
    '  [Console]::Out.Flush()',
    '  Start-Sleep -Milliseconds 100',
    '}',
  ].join('\n');
}

function holdersScript(dirs) {
  const list = dirs.map(psQuote).join(', ');
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }',
    `$dirs = @(${list})`,
    '$rows = @()',
    'function Inside($p) { if (-not $p) { return $false }; foreach ($d in $dirs) { if ($p.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { return $true } }; return $false }',
    'foreach ($c in @(Get-CimInstance -ClassName Win32_Process)) { if (Inside $c.ExecutablePath) { $rows += [pscustomobject]@{ pid = [int]$c.ProcessId; ppid = [int]$c.ParentProcessId; name = [string]$c.Name; path = $c.ExecutablePath; via = "image" } } }',
    'foreach ($g in @(Get-Process)) { try { foreach ($m in @($g.Modules)) { if (Inside $m.FileName) { $rows += [pscustomobject]@{ pid = [int]$g.Id; ppid = -1; name = [string]$g.ProcessName; path = $m.FileName; via = "module" } } } } catch { } }',
    'ConvertTo-Json -InputObject @($rows) -Compress',
  ].join('\n');
}

function eventLogScript(sinceEpochMs) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }',
    `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(sinceEpochMs)}).LocalDateTime`,
    '$rows = @()',
    "foreach ($e in @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since } -MaxEvents 200)) {",
    "  if ($e.Level -gt 3) { continue }",
    "  $m = [string]$e.Message; $m = ($m -replace '\\s+', ' '); if ($m.Length -gt 400) { $m = $m.Substring(0, 400) }",
    "  if (($m -notmatch 'TRACE') -and ($e.ProviderName -notmatch 'Application Error|Windows Error Reporting|Application Hang')) { continue }",
    '  $rows += [pscustomobject]@{ time = $e.TimeCreated.ToString("o"); provider = [string]$e.ProviderName; id = [int]$e.Id; level = [int]$e.Level; message = $m }',
    '}',
    '$wer = @()',
    "foreach ($root in @(\"$env:LOCALAPPDATA\\Microsoft\\Windows\\WER\\ReportQueue\", \"$env:LOCALAPPDATA\\Microsoft\\Windows\\WER\\ReportArchive\", \"$env:ProgramData\\Microsoft\\Windows\\WER\\ReportQueue\", \"$env:ProgramData\\Microsoft\\Windows\\WER\\ReportArchive\")) {",
    '  foreach ($d in @(Get-ChildItem -LiteralPath $root -Directory)) { if ($d.LastWriteTime -ge $since) { $wer += [pscustomobject]@{ name = $d.Name; time = $d.LastWriteTime.ToString("o") } } }',
    '}',
    'ConvertTo-Json -InputObject ([pscustomobject]@{ events = @($rows); wer = @($wer) }) -Compress -Depth 4',
  ].join('\n');
}

function parseJsonOutput(text, fallback) {
  try { const value = JSON.parse(String(text).replace(/^﻿/, '').trim() || 'null'); return value === null ? fallback : value; } catch { return fallback; }
}

/** %TEMP% watcher: ~1-2 ms readdir ticks; records every NEW ns*.tmp entry, its kind transitions and (for directories) content changes. */
function createTempWatcher(tempDir) {
  const state = { running: false, before: new Set(), entries: new Map(), ticks: [], lastTick: null, readErrors: 0 };
  const contentOf = (name) => {
    const dir = path.join(tempDir, name);
    try {
      const names = fs.readdirSync(dir).sort();
      const sizes = {};
      for (const leaf of names) { if (/^app-.*\.7z$/i.test(leaf)) { try { sizes[leaf] = fs.statSync(path.join(dir, leaf)).size; } catch { sizes[leaf] = null; } } }
      return { names, sizes };
    } catch (error) { return { error: error.code || 'error' }; }
  };
  const tick = () => {
    if (!state.running) return;
    const at = nowMs();
    if (state.lastTick !== null) state.ticks.push(round2(at - state.lastTick));
    state.lastTick = at;
    let listing = null;
    try { listing = fs.readdirSync(tempDir, { withFileTypes: true }); } catch { state.readErrors++; }
    if (listing) {
      const present = new Set();
      for (const entry of listing) {
        if (!NSIS_ENTRY_RE.test(entry.name) || state.before.has(entry.name)) continue;
        present.add(entry.name);
        const kind = entry.isDirectory() ? 'dir' : 'file';
        let rec = state.entries.get(entry.name);
        if (!rec) { rec = { name: entry.name, firstSeenMs: at, lastSeenMs: at, kinds: [], contents: [], lastKind: null, lastContentMs: 0 }; state.entries.set(entry.name, rec); }
        if (rec.lastKind !== kind) { rec.kinds.push({ kind, atMs: at }); rec.lastKind = kind; }
        rec.lastSeenMs = at;
        if (kind === 'dir' && at - rec.lastContentMs >= 20) {
          rec.lastContentMs = at;
          const content = contentOf(entry.name);
          const last = rec.contents.length ? rec.contents[rec.contents.length - 1] : null;
          const names = JSON.stringify(content.names || content.error);
          const sizes = JSON.stringify(content.sizes || null);
          // A changed entry list is recorded at once; a growing archive only every 250 ms.
          if (!last || last.namesKey !== names || (last.sizesKey !== sizes && at - last.atMs >= 250)) rec.contents.push({ atMs: at, namesKey: names, sizesKey: sizes, ...content });
        }
      }
      for (const rec of state.entries.values()) {
        if (!present.has(rec.name) && rec.lastKind !== 'gone') { rec.kinds.push({ kind: 'gone', atMs: at }); rec.lastKind = 'gone'; }
      }
    }
    setTimeout(tick, 1);
  };
  return {
    start() {
      state.running = true; state.entries.clear(); state.ticks = []; state.lastTick = null; state.readErrors = 0;
      state.before = new Set();
      try { for (const entry of fs.readdirSync(tempDir)) if (NSIS_ENTRY_RE.test(entry)) state.before.add(entry); } catch { /* an unreadable temp is reported by the first tick */ }
      setTimeout(tick, 0);
    },
    stop(originMs) {
      state.running = false;
      const rel = (value) => round2(value - originMs);
      const entries = [...state.entries.values()].map((rec) => ({
        name: rec.name, firstSeenMs: rel(rec.firstSeenMs), lastSeenMs: rel(rec.lastSeenMs), finalKind: rec.lastKind,
        kinds: rec.kinds.map((item) => ({ kind: item.kind, atMs: rel(item.atMs) })),
        contents: rec.contents.map(({ namesKey, sizesKey, atMs, ...rest }) => ({ atMs: rel(atMs), ...rest })),
      }));
      const ticks = state.ticks.slice().sort((a, b) => a - b);
      const tickStats = ticks.length ? { n: ticks.length, median: ticks[Math.floor(ticks.length / 2)], max: ticks[ticks.length - 1] } : null;
      return { entries, tickStats, readErrors: state.readErrors, preExisting: [...state.before] };
    },
    currentNewDirs() {
      return [...state.entries.values()].filter((rec) => rec.lastKind === 'dir').map((rec) => rec.name);
    },
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
/** Waits `ms` with a short busy tail so small staggers (2 ms) are reproduced more faithfully than a bare timer. */
async function preciseWait(ms) {
  if (ms <= 0) return;
  const target = performance.now() + ms;
  if (ms > 4) await sleep(ms - 3);
  while (performance.now() < target) { /* busy tail (< 4 ms) */ }
}

async function listDirFiles(dir) {
  const files = [];
  const walk = async (current, prefix) => {
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch (error) { files.push({ path: prefix || '.', error: error.code || 'error' }); return; }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else { let size = null; try { size = (await fsp.stat(path.join(current, entry.name))).size; } catch { /* reported as null */ } files.push({ path: rel, size }); }
    }
  };
  await walk(dir, '');
  return files;
}

async function removeIfPossible(platform, target) {
  try { return { target, removed: await platform.removeTree(target), error: null }; } catch (error) { return { target, removed: false, error: `${error.code || 'error'}: ${error.message}` }; }
}

function createContext(options, platform, evidence) {
  const startedAt = nowMs();
  const ctx = {
    options, platform, evidence, startedAt, deadline: startedAt + options.maxTotalSec * 1000, tempDir: os.tmpdir(), exe: null, area: null,
    step(label, data) {
      const tMs = round2(nowMs() - startedAt);
      evidence.timeline.push({ tMs, step: label, ...(data || {}) });
      const detail = data ? ' ' + Object.entries(data).map(([key, value]) => `${key}=${typeof value === 'object' && value !== null ? JSON.stringify(value) : value}`).join(' ') : '';
      platform.log(`[+${(tMs / 1000).toFixed(1)}s] ${label}${detail}`);
    },
    checkBudget(step) { if (nowMs() > ctx.deadline) throw new InfraError(`global time budget of ${options.maxTotalSec} s exhausted`, step); },
    async snapshot(step) {
      try { return await platform.snapshot(); } catch (first) {
        try { return await platform.snapshot(); } catch (error) { throw new InfraError(`process snapshot failed twice (${first.message}; ${error.message})`, step); }
      }
    },
  };
  return ctx;
}

async function launch(ctx, label, args) {
  try { return await ctx.platform.launch(ctx.exe, args, { cwd: ctx.area }); } catch (error) { throw new InfraError(`${label}: could not start the portable EXE: ${error.message}`, `launch ${label}`); }
}

/** Polls the process table until the wrapper's main process is ready (window) or the wrapper exited; bounded. */
async function waitReadyOrExit(ctx, handle, timeoutMs) {
  const started = nowMs();
  let mainSeenAt = null;
  for (;;) {
    ctx.checkBudget('readiness');
    const records = await ctx.snapshot('readiness');
    const at = nowMs();
    const probe = check.isReady(records, handle.pid, { sinceMainMs: mainSeenAt === null ? 0 : at - mainSeenAt, minSettleMs: check.DEFAULT_TUNING.minSettleMs });
    if (probe.main && mainSeenAt === null) mainSeenAt = at;
    if (probe.ready) {
      const runDir = path.win32.dirname(probe.main.exe);
      const stats = await ctx.platform.dirStats(runDir);
      return { outcome: 'ready', mainPid: probe.main.pid, runDir, nsisParent: check.classifyRuntimeDir(runDir).nsisParent, files: stats.files, bytes: stats.bytes, afterMs: round2(at - started), mode: probe.mode };
    }
    const state = handle.state();
    if (state.exited) return { outcome: 'exited', exitCode: state.exitCode, afterMs: round2(at - started), mainSeen: mainSeenAt !== null };
    if (at - started >= timeoutMs) return { outcome: 'timeout', afterMs: round2(at - started), mainSeen: mainSeenAt !== null, reason: probe.reason };
    await sleep(check.DEFAULT_TUNING.pollMs);
  }
}

async function closeWrapper(ctx, handle, mainPid, timeoutMs) {
  const close = mainPid ? await ctx.platform.closeMainWindow(mainPid) : { method: 'none', ok: false, detail: 'no main process' };
  const started = nowMs();
  while (!handle.state().exited && nowMs() - started < timeoutMs) await sleep(250);
  const state = handle.state();
  return { close, exited: state.exited, exitCode: state.exitCode, waitedMs: round2(nowMs() - started) };
}

async function cleanupAttempt(ctx, handles, dirNames) {
  const killed = [];
  for (const [label, handle] of Object.entries(handles)) {
    if (handle.state().exited) continue;
    try { await ctx.platform.killTree(handle.pid); killed.push(`${label}:${handle.pid}`); } catch { /* best effort */ }
  }
  if (killed.length) await sleep(1500);
  const removals = [];
  for (const name of dirNames) removals.push(await removeIfPossible(ctx.platform, path.join(ctx.tempDir, name)));
  return { killed, removals };
}

// ---- R1: startup race -----------------------------------------------------------------------------------

async function raceAttempt(ctx, nominalMs, index, watcher) {
  const profileA = path.join(ctx.area, `race-${nominalMs}-${index}-A`);
  const profileB = path.join(ctx.area, `race-${nominalMs}-${index}-B`);
  const rec = { nominalMs, index, achievedMs: null, launchers: {}, classification: null, newDirsAtDecision: [], watcher: null, followUp: null, cleanup: null };
  watcher.start();
  const handleA = await launch(ctx, 'A', [`--user-data-dir=${profileA}`]);
  const tA = nowMs();
  let handleB = null;
  let dirsToRemove = [];
  try {
    await preciseWait(nominalMs);
    handleB = await launch(ctx, 'B', [`--user-data-dir=${profileB}`]);
    await raceAttemptBody(ctx, rec, watcher, handleA, handleB, tA, (dirs) => { dirsToRemove = dirs; });
  } finally {
    // Whatever happened (including an infrastructure error mid-attempt), nothing this attempt started may outlive it.
    if (!rec.watcher) rec.watcher = watcher.stop(tA);
    const handles = { A: handleA };
    if (handleB) handles.B = handleB;
    rec.cleanup = await cleanupAttempt(ctx, handles, [...new Set([...dirsToRemove, ...rec.watcher.entries.filter((entry) => entry.finalKind === 'dir').map((entry) => entry.name)])]);
  }
  return rec;
}

async function raceAttemptBody(ctx, rec, watcher, handleA, handleB, tA, setDirsToRemove) {
  const { nominalMs, index } = rec;
  const tB = nowMs();
  rec.achievedMs = round2(tB - tA);
  // Launcher facts are captured at the decision point, BEFORE the measurement closes or kills anything (taskkill makes a killed
  // wrapper report exit code 1, which must never look like a self-exit).
  const facts = (handle, startedAt) => {
    const state = handle.state();
    return { wrapperPid: handle.pid, alive: !state.exited, exitCode: state.exited ? state.exitCode : null, elapsedMs: state.exited ? round2((state.exitedAtMs ?? performance.now()) + performance.timeOrigin - startedAt) : null };
  };
  // Observe until the decision point, or until both wrappers are gone.
  const decisionAt = tA + ctx.options.observeMs;
  while (nowMs() < decisionAt && !(handleA.state().exited && handleB.state().exited)) await sleep(10);
  rec.launchers = { A: facts(handleA, tA), B: facts(handleB, tB) };
  rec.newDirsAtDecision = watcher.currentNewDirs();
  rec.classification = classifyAttempt(rec.launchers, rec.newDirsAtDecision);
  rec.decisionAtMs = round2(nowMs() - tA);
  ctx.step(`race ${nominalMs} ms #${index}`, { achievedMs: rec.achievedMs, classification: rec.classification, newDirs: rec.newDirsAtDecision, A: rec.launchers.A, B: rec.launchers.B });
  setDirsToRemove(rec.newDirsAtDecision.slice());
  if (rec.classification !== 'isolated') {
    // Anomaly: let it play out so the consequence is on record (bounded). Survivor(s) run to readiness, then are closed normally
    // (their own exit codes are recorded in the follow-up, separately from the self-exits above).
    const followUp = { survivors: {}, processesAtDecision: null };
    try { followUp.processesAtDecision = (await ctx.snapshot('anomaly')).filter((record) => record.name === MAIN_EXE_NAME).map((record) => ({ pid: record.pid, ppid: record.ppid, type: record.type, exe: record.exe })); } catch (error) { followUp.processesAtDecision = { error: error.message }; }
    const survivors = [];
    if (rec.launchers.A.alive) survivors.push(['A', handleA]);
    if (rec.launchers.B.alive) survivors.push(['B', handleB]);
    for (const [label, handle] of survivors) {
      const ready = await waitReadyOrExit(ctx, handle, ctx.options.readyTimeoutMs);
      const entry = { ...ready };
      if (ready.outcome === 'ready') {
        entry.intact = ctx.expected ? ready.files === ctx.expected.files && ready.bytes === ctx.expected.bytes : null;
        entry.close = await closeWrapper(ctx, handle, ready.mainPid, 60000);
        if (ready.nsisParent) { await sleep(2000); entry.nsisParentRemovedByWrapper = !(await ctx.platform.exists(ready.nsisParent)); }
      }
      followUp.survivors[label] = entry;
    }
    followUp.newDirsAfterFollowUp = watcher.currentNewDirs();
    setDirsToRemove([...new Set([...rec.newDirsAtDecision, ...followUp.newDirsAfterFollowUp])]);
    rec.followUp = followUp;
    ctx.step(`race ${nominalMs} ms #${index}: follow-up`, { survivors: Object.fromEntries(Object.entries(followUp.survivors).map(([label, entry]) => [label, { outcome: entry.outcome, files: entry.files ?? null, intact: entry.intact ?? null, runDir: entry.runDir ?? null, exitCode: entry.close ? entry.close.exitCode : entry.exitCode ?? null }])) });
  }
  rec.watcher = watcher.stop(tA);
}

/** One launch alone: the extraction time on this machine and the expected runtime size for the "intact" judgement. */
async function baselineScenario(ctx) {
  const { options, evidence } = ctx;
  const handle = await launch(ctx, 'baseline', [`--user-data-dir=${path.join(ctx.area, 'baseline')}`]);
  const ready = await waitReadyOrExit(ctx, handle, options.readyTimeoutMs);
  if (ready.outcome !== 'ready') { try { await ctx.platform.killTree(handle.pid); } catch { /* best effort */ } throw new InfraError(`the baseline launch did not become ready: ${ready.outcome}${ready.reason ? ` (${ready.reason})` : ''}`, 'baseline'); }
  const close = await closeWrapper(ctx, handle, ready.mainPid, 60000);
  if (!handle.state().exited) { try { await ctx.platform.killTree(handle.pid); } catch { /* best effort */ } }
  evidence.baseline = { wrapperPid: handle.pid, ...ready, close };
  ctx.expected = { files: ready.files, bytes: ready.bytes };
  ctx.step('baseline', { files: ready.files, bytes: ready.bytes, afterMs: ready.afterMs, exitCode: close.exitCode });
}

async function raceScenario(ctx) {
  const { options, evidence } = ctx;
  const race = evidence.race = { observeMs: options.observeMs, attempts: [], summary: null, watcherTickMs: null };
  const watcher = createTempWatcher(ctx.tempDir);
  const tickSamples = [];
  for (const nominalMs of options.staggers) {
    for (let index = 1; index <= options.attempts; index++) {
      ctx.checkBudget(`race ${nominalMs} #${index}`);
      const rec = await raceAttempt(ctx, nominalMs, index, watcher);
      if (rec.watcher && rec.watcher.tickStats) tickSamples.push(rec.watcher.tickStats);
      race.attempts.push(rec);
    }
  }
  race.summary = summarizeRace(race.attempts);
  if (tickSamples.length) race.watcherTickMs = { median: tickSamples.map((item) => item.median).sort((a, b) => a - b)[Math.floor(tickSamples.length / 2)], max: Math.max(...tickSamples.map((item) => item.max)) };
}

// ---- R2: same-profile second instance ---------------------------------------------------------------------

async function startSampler(ctx) {
  const stopFile = path.join(ctx.area, 'sampler.stop');
  const logFile = path.join(ctx.area, 'sampler.jsonl');
  const fd = fs.openSync(logFile, 'w');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', check.encodePowerShell(samplerScript(stopFile, Math.ceil(ctx.options.maxTotalSec)))], { stdio: ['ignore', fd, 'ignore'], windowsHide: true });
  child.unref();
  return {
    pid: child.pid, logFile,
    async stop() {
      try { fs.writeFileSync(stopFile, 'stop'); } catch { /* the sampler also ends with its own deadline */ }
      const started = nowMs();
      while (child.exitCode === null && nowMs() - started < 15000) await sleep(200);
      if (child.exitCode === null) { try { child.kill(); } catch { /* best effort */ } }
      try { fs.closeSync(fd); } catch { /* already closed */ }
      let text = '';
      try { text = await fsp.readFile(logFile, 'utf8'); } catch { /* reported as empty */ }
      return parseSamplerLog(text);
    },
  };
}

async function secondInstanceScenario(ctx) {
  const { options, evidence, platform } = ctx;
  const s2 = evidence.secondInstance = { C: null, sampler: null, attempts: [], summary: null };
  const boardFile = path.join(ctx.area, 'synthetic-board.cad');
  await fsp.writeFile(boardFile, check.SYNTHETIC_BOARD, 'utf8');
  const profile = path.join(ctx.area, 'profileC');
  const handleC = await launch(ctx, 'C', [`--user-data-dir=${profile}`]);
  const tC = nowMs();
  const readyC = await waitReadyOrExit(ctx, handleC, options.readyTimeoutMs);
  if (readyC.outcome !== 'ready') {
    try { await platform.killTree(handleC.pid); } catch { /* best effort */ }
    throw new InfraError(`C (first instance) did not become ready: ${readyC.outcome}${readyC.reason ? ` (${readyC.reason})` : ''}`, 'C ready');
  }
  s2.C = { wrapperPid: handleC.pid, ...readyC };
  ctx.step('C ready', { mainPid: readyC.mainPid, runDir: readyC.runDir, files: readyC.files, afterMs: readyC.afterMs });
  const sampler = await startSampler(ctx);
  s2.sampler = { pid: sampler.pid };
  const watcher = createTempWatcher(ctx.tempDir);
  const cLeaf = readyC.nsisParent ? path.win32.basename(readyC.nsisParent) : null;
  const scanNewDirs = async (names) => {
    const dirs = [];
    for (const name of names) {
      if (name === cLeaf) continue;
      const dir = path.join(ctx.tempDir, name);
      if (!(await platform.exists(dir))) continue;
      const files = await listDirFiles(dir);
      dirs.push({ name, files, totalBytes: files.reduce((total, file) => total + (file.size || 0), 0) });
    }
    return dirs;
  };
  try {
    for (let index = 1; index <= options.secondInstance; index++) {
      ctx.checkBudget(`second instance #${index}`);
      const rec = { index, wrapper: null, newDirs: [], leftoverScans: [], leftoverHolders: null, leftoverRemoval: null, tree: null, eventLog: null, C: null, watcher: null };
      watcher.start();
      const tStart = nowMs();
      const handleD = await launch(ctx, 'D', [`--user-data-dir=${profile}`, boardFile]);
      const tD = nowMs();
      while (!handleD.state().exited && nowMs() - tD < options.readyTimeoutMs) await sleep(20);
      const state = handleD.state();
      const tExit = state.exited ? performance.timeOrigin + state.exitedAtMs : null;
      rec.wrapper = { pid: handleD.pid, exitedByItself: state.exited, exitCode: state.exited ? state.exitCode : null, elapsedMs: state.exited ? round2(tExit - tD) : null };
      if (!state.exited) { try { await platform.killTree(handleD.pid); } catch { /* best effort */ } rec.wrapper.killedByMeasurement = true; }
      rec.watcher = watcher.stop(tD);
      rec.newDirs = rec.watcher.entries.filter((entry) => entry.kinds.some((item) => item.kind === 'dir')).map((entry) => entry.name);
      const exitRef = tExit ?? nowMs();
      for (const atMs of options.leftoverScansMs) {
        const wait = exitRef + atMs - nowMs();
        if (wait > 0) await sleep(wait);
        rec.leftoverScans.push({ atMs, dirs: await scanNewDirs(rec.newDirs) });
      }
      const last = rec.leftoverScans[rec.leftoverScans.length - 1];
      if (last.dirs.length) {
        const dirs = last.dirs.map((dir) => path.join(ctx.tempDir, dir.name));
        const canonical = [];
        for (const dir of dirs) canonical.push(await platform.canonicalize(dir));
        const holders = parseJsonOutput(await runPowerShell(holdersScript([...new Set([...dirs, ...canonical])])), []);
        rec.leftoverHolders = [{ atMs: round2(nowMs() - exitRef), rows: Array.isArray(holders) ? holders : [holders] }];
        await sleep(options.leftoverExtraWaitMs);
        rec.leftoverScans.push({ atMs: round2(nowMs() - exitRef), dirs: await scanNewDirs(rec.newDirs) });
        const holdersLater = parseJsonOutput(await runPowerShell(holdersScript([...new Set([...dirs, ...canonical])])), []);
        rec.leftoverHolders.push({ atMs: round2(nowMs() - exitRef), rows: Array.isArray(holdersLater) ? holdersLater : [holdersLater] });
        rec.leftoverRemoval = [];
        for (const dir of dirs) rec.leftoverRemoval.push(await removeIfPossible(platform, dir));
      }
      const cStats = await platform.dirStats(readyC.runDir);
      rec.C = { files: cStats.files, bytes: cStats.bytes };
      rec.eventLog = parseJsonOutput(await runPowerShell(eventLogScript(tStart - 2000)), { events: [], wer: [] });
      rec.windowMs = { startEpochMs: Math.floor(tD), exitEpochMs: tExit === null ? null : Math.floor(tExit) };
      ctx.step(`second instance #${index}`, { exitCode: rec.wrapper.exitCode, elapsedMs: rec.wrapper.elapsedMs, newDirs: rec.newDirs, leftoverAtLastScan: last.dirs.map((dir) => `${dir.name}:${dir.files.length} files`), holders: rec.leftoverHolders ? rec.leftoverHolders.map((h) => h.rows.length) : null, cFiles: rec.C.files, events: rec.eventLog.events.length });
      s2.attempts.push(rec);
    }
  } finally {
    const samples = await sampler.stop();
    s2.sampler.samples = samples.samples.length; s2.sampler.malformed = samples.malformed;
    s2.sampler.costMs = samples.samples.length ? { max: Math.max(...samples.samples.map((sample) => sample.costMs || 0)) } : null;
    for (const rec of s2.attempts) {
      if (!rec.windowMs) continue;
      rec.tree = wrapperTreeFromSamples(samples.samples, rec.wrapper.pid, { fromMs: rec.windowMs.startEpochMs, toMs: (rec.windowMs.exitEpochMs || rec.windowMs.startEpochMs) + 60000, wrapperExitMs: rec.windowMs.exitEpochMs });
    }
    const closeC = await closeWrapper(ctx, handleC, readyC.mainPid, 60000);
    s2.C.close = closeC;
    s2.C.elapsedMs = round2(nowMs() - tC);
    if (!handleC.state().exited) { try { await platform.killTree(handleC.pid); } catch { /* best effort */ } }
    s2.summary = summarizeSecondInstance(s2.attempts);
  }
}

async function run(options, platform) {
  const evidence = {
    schema: SCHEMA, tool: { name: TOOL_NAME, startedAt: new Date().toISOString(), finishedAt: null, ...platform.info() }, label: options.label,
    options: { staggers: options.staggers, attempts: options.attempts, secondInstance: options.secondInstance, observeMs: options.observeMs, maxTotalSec: options.maxTotalSec },
    exe: null, baseline: null, race: null, secondInstance: null, status: null, infrastructureError: null, timeline: [],
  };
  const ctx = createContext({ ...DEFAULTS, ...options }, platform, evidence);
  ctx.expected = null;
  let infra = null;
  try {
    const exe = path.resolve(options.exe);
    let info;
    try { info = await platform.fileInfo(exe); } catch (error) { throw new InfraError(`cannot read the portable EXE ${exe}: ${error.message}`, 'read exe'); }
    ctx.exe = exe;
    evidence.exe = { path: exe, sizeBytes: info.sizeBytes, sha256: info.sha256 };
    ctx.area = await platform.makeTempArea();
    ctx.step('start', { exe, sha256: info.sha256, tempDir: ctx.tempDir, area: ctx.area });
    await baselineScenario(ctx);
    if (options.attempts > 0) await raceScenario(ctx);
    if (options.secondInstance > 0) await secondInstanceScenario(ctx);
  } catch (error) {
    infra = error instanceof InfraError ? error : new InfraError(`unexpected ${error && error.name || 'error'}: ${error && error.stack || error}`, 'internal');
  }
  if (ctx.area) { try { await platform.removeTempArea(ctx.area); } catch { /* best effort */ } }
  evidence.tool.finishedAt = new Date().toISOString();
  evidence.status = infra ? 'infrastructure-failure' : 'measured';
  evidence.infrastructureError = infra ? { message: infra.message, step: infra.step } : null;
  return { exitCode: infra ? EXIT.INFRA : EXIT.OK, evidence };
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(`${error.message}\n${USAGE}`); return EXIT.INFRA; }
  if (options.help) { console.log(USAGE); return EXIT.OK; }
  if (process.platform !== 'win32') { console.error('This measurement drives the real Windows portable wrapper and only runs on Windows.'); return EXIT.INFRA; }
  const platform = check.createNodePlatform();
  const result = await run(options, platform);
  await fsp.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
  await fsp.writeFile(options.out, `${JSON.stringify(result.evidence, null, 2)}\n`, 'utf8');
  console.log(formatSummary(result.evidence));
  console.log(`evidence: ${path.resolve(options.out)}`);
  return result.exitCode;
}

module.exports = { SCHEMA, EXIT, DEFAULTS, NSIS_ENTRY_RE, USAGE, parseArgs, classifyAttempt, summarizeRace, parseSamplerLog, wrapperTreeFromSamples, summarizeSecondInstance, formatSummary, samplerScript, holdersScript, eventLogScript, parseJsonOutput, createTempWatcher, run };

if (require.main === module) {
  main().then((code) => { process.exit(code); }, (error) => { console.error(error); process.exit(EXIT.INFRA); });
}
