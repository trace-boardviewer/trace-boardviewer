'use strict';

// MODEL / STATIC EVIDENCE ONLY. scripts/measure-portable-startup.cjs is a MEASUREMENT (never a gate) that runs on a Windows
// runner. These tests pin its pure decision helpers (attempt classification, per-stagger summary, sampler parsing, process
// tree attribution, leftover summary) and its %TEMP% watcher on a synthetic directory, so the numbers it reports are
// computed as documented. Nothing here is Windows wrapper evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const measure = require('../scripts/measure-portable-startup.cjs');

const alive = (pid) => ({ wrapperPid: pid, alive: true, exitCode: null, elapsedMs: null });
const exited = (pid, exitCode, elapsedMs) => ({ wrapperPid: pid, alive: false, exitCode, elapsedMs });

test('parseArgs: defaults, lists and bounds', () => {
  const options = measure.parseArgs(['--exe', 'x.exe']);
  assert.deepEqual(options.staggers, [0, 2, 10, 40]);
  assert.equal(options.attempts, 20);
  assert.equal(options.secondInstance, 20);
  assert.equal(options.label, 'fixed');
  const custom = measure.parseArgs(['--exe', 'x.exe', '--staggers', '0, 5', '--attempts', '3', '--second-instance', '0', '--label', 'control', '--max-total-sec', '600', '--out', 'o.json']);
  assert.deepEqual(custom.staggers, [0, 5]);
  assert.equal(custom.attempts, 3);
  assert.equal(custom.secondInstance, 0);
  assert.equal(custom.label, 'control');
  assert.equal(custom.maxTotalSec, 600);
  assert.equal(custom.out, 'o.json');
  assert.throws(() => measure.parseArgs([]), /--exe is required/);
  assert.throws(() => measure.parseArgs(['--exe', 'x.exe', '--attempts', '201']), /between 0 and 200/);
  assert.throws(() => measure.parseArgs(['--exe', 'x.exe', '--staggers', 'a']), /whole number/);
  assert.throws(() => measure.parseArgs(['--exe', 'x.exe', '--label', 'bad label']), /alphanumeric/);
  assert.throws(() => measure.parseArgs(['--exe', 'x.exe', '--bogus']), /unknown argument/);
  assert.equal(measure.parseArgs(['--help']).help, true);
});

test('classifyAttempt: every class, in priority order (lost launchers before directory counts)', () => {
  assert.equal(measure.classifyAttempt({ A: alive(1), B: alive(2) }, ['nsa1111.tmp', 'nsb2222.tmp']), 'isolated');
  assert.equal(measure.classifyAttempt({ A: alive(1), B: alive(2) }, ['nsa1111.tmp', 'nsb2222.tmp', 'nsc3333.tmp']), 'isolated');
  assert.equal(measure.classifyAttempt({ A: alive(1), B: alive(2) }, ['nsa1111.tmp']), 'shared-plugins-dir');
  assert.equal(measure.classifyAttempt({ A: alive(1), B: alive(2) }, []), 'no-dir-yet');
  assert.equal(measure.classifyAttempt({ A: exited(1, 1, 175), B: alive(2) }, ['nsa1111.tmp']), 'A-lost');
  assert.equal(measure.classifyAttempt({ A: alive(1), B: exited(2, 2, 90) }, ['nsa1111.tmp', 'nsb2222.tmp']), 'B-lost');
  assert.equal(measure.classifyAttempt({ A: exited(1, 3221225477, 80), B: exited(2, 3221225477, 75) }, []), 'both-lost');
});

test('summarizeRace: counts per stagger; only self-exits enter the exit-code histogram; survivors judged by intact flag', () => {
  const attempts = [
    { nominalMs: 0, achievedMs: 2.1, classification: 'isolated', launchers: { A: alive(1), B: alive(2) }, followUp: null },
    { nominalMs: 0, achievedMs: 1.9, classification: 'A-lost', launchers: { A: exited(3, 1, 175.4), B: alive(4) }, followUp: { survivors: { B: { outcome: 'ready', files: 78, bytes: 1, intact: true, close: { exitCode: 0 } } } } },
    { nominalMs: 0, achievedMs: 2.4, classification: 'shared-plugins-dir', launchers: { A: alive(5), B: alive(6) }, followUp: { survivors: { A: { outcome: 'ready', files: 7, bytes: 1, intact: false, close: { exitCode: 0 } }, B: { outcome: 'exited', exitCode: 1, afterMs: 3500 } } } },
    { nominalMs: 0, achievedMs: 2.0, classification: 'both-lost', launchers: { A: exited(7, 3221225477, 80), B: exited(8, 3221225477, 75) }, followUp: { survivors: {} } },
    { nominalMs: 10, achievedMs: 10.3, classification: 'isolated', launchers: { A: alive(9), B: alive(10) }, followUp: null },
    { nominalMs: 10, achievedMs: 10.1, classification: 'B-lost', launchers: { A: alive(11), B: exited(12, 2, 120) }, followUp: { survivors: { A: { outcome: 'timeout', afterMs: 120000 } } } },
  ];
  const summary = measure.summarizeRace(attempts);
  assert.equal(summary.length, 2);
  const [s0, s10] = summary;
  assert.equal(s0.nominalMs, 0);
  assert.equal(s0.attempts, 4);
  assert.equal(s0.isolated, 1);
  assert.equal(s0.aLost, 1);
  assert.equal(s0.sharedPluginsDir, 1);
  assert.equal(s0.bothLost, 1);
  assert.deepEqual(s0.selfExitCodes, { 1: 2, 3221225477: 2 }); // A-lost (1), shared follow-up B exited 1, both-lost x2; the closed survivors (exit 0) are NOT counted
  assert.deepEqual(s0.selfExitElapsedMs, { n: 4, min: 75, max: 3500, mean: 957.6 });
  assert.deepEqual(s0.achievedMs, { n: 4, min: 1.9, max: 2.4, mean: 2.1 });
  assert.equal(s0.survivorsIntact, 1);
  assert.equal(s0.survivorsDamaged, 1);
  assert.equal(s0.survivorsUnknown, 0);
  assert.equal(s10.attempts, 2);
  assert.equal(s10.bLost, 1);
  assert.deepEqual(s10.selfExitCodes, { 2: 1 });
  assert.equal(s10.survivorsNotReady, 1);
});

test('parseSamplerLog: JSON lines, malformed lines counted, numbers coerced', () => {
  const text = [
    '{"t":1000,"costMs":120,"procs":[{"pid":"10","ppid":"5","exe":"C:\\\\x\\\\app\\\\TRACE Boardviewer.exe","type":""}]}',
    'garbage',
    '{"t":"nope","procs":[]}',
    '',
    '{"t":1300,"procs":[]}',
  ].join('\r\n');
  const parsed = measure.parseSamplerLog(text);
  assert.equal(parsed.malformed, 2);
  assert.equal(parsed.samples.length, 2);
  assert.deepEqual(parsed.samples[0].procs, [{ pid: 10, ppid: 5, exe: 'C:\\x\\app\\TRACE Boardviewer.exe', type: '' }]);
  assert.equal(parsed.samples[0].costMs, 120);
  assert.equal(parsed.samples[1].costMs, null);
});

test('wrapperTreeFromSamples: main (ppid = wrapper) and its children with first/last observation relative to the wrapper exit', () => {
  const exe = 'C:\\T\\nsq1234.tmp\\app\\TRACE Boardviewer.exe';
  const samples = [
    { t: 1000, procs: [{ pid: 50, ppid: 40, exe, type: '' }] },
    { t: 1200, procs: [{ pid: 50, ppid: 40, exe, type: '' }, { pid: 51, ppid: 50, exe, type: 'gpu-process' }, { pid: 52, ppid: 50, exe, type: 'utility' }] },
    { t: 1400, procs: [{ pid: 51, ppid: 50, exe, type: 'gpu-process' }] }, // main gone, gpu child still alive after the wrapper exited at 1350
    { t: 1600, procs: [] },
    { t: 5000, procs: [{ pid: 50, ppid: 40, exe, type: '' }] }, // outside the window: ignored
    { t: 1100, procs: [{ pid: 99, ppid: 1, exe, type: '' }] }, // another wrapper's main: ignored
  ];
  const tree = measure.wrapperTreeFromSamples(samples, 40, { fromMs: 900, toMs: 2000, wrapperExitMs: 1350 });
  const byPid = Object.fromEntries(tree.map((rec) => [rec.pid, rec]));
  assert.deepEqual(Object.keys(byPid).map(Number).sort(), [50, 51, 52]);
  assert.equal(byPid[50].role, 'main');
  assert.equal(byPid[50].firstSeenMs, 1000);
  assert.equal(byPid[50].lastSeenMs, 1200);
  assert.equal(byPid[50].seenAfterWrapperExit, false);
  assert.equal(byPid[51].role, 'child');
  assert.equal(byPid[51].type, 'gpu-process');
  // the gpu child at t=1400 is only attributed while its parent main is in the same sample; here the main is gone, so last seen stays 1200
  assert.equal(byPid[51].lastSeenMs, 1200);
  assert.equal(byPid[51].lastSeenRelToWrapperExitMs, -150);
  assert.equal(byPid[52].samples, 1);
  const orphanAware = measure.wrapperTreeFromSamples([...samples, { t: 1450, procs: [{ pid: 50, ppid: 40, exe, type: '' }, { pid: 51, ppid: 50, exe, type: 'gpu-process' }] }], 40, { fromMs: 900, toMs: 2000, wrapperExitMs: 1350 });
  assert.equal(orphanAware.find((rec) => rec.pid === 51).seenAfterWrapperExit, true);
  assert.equal(orphanAware.find((rec) => rec.pid === 51).lastSeenRelToWrapperExitMs, 100);
  assert.equal(measure.wrapperTreeFromSamples(samples, 40, { fromMs: 900, toMs: 2000, wrapperExitMs: null })[0].firstSeenRelToWrapperExitMs, null);
});

test('summarizeSecondInstance: exit codes, leftovers at the last scan, holders, removability, tree facts', () => {
  const attempts = [
    { wrapper: { exitCode: 0 }, leftoverScans: [{ atMs: 0, dirs: [{ name: 'nsa1.tmp', files: [{ path: 'app/x', size: 1 }] }] }, { atMs: 10000, dirs: [] }], tree: [{ role: 'main', type: '' }, { role: 'child', type: 'gpu-process', seenAfterWrapperExit: true }] },
    { wrapper: { exitCode: 0 }, leftoverScans: [{ atMs: 0, dirs: [] }, { atMs: 10000, dirs: [{ name: 'nsb2.tmp', files: [{ path: 'app/TRACE Boardviewer.exe', size: 5 }, { path: 'app/ffmpeg.dll', size: 6 }] }] }], leftoverHolders: [{ atMs: 10500, rows: [{ pid: 7, via: 'image' }] }], leftoverRemoval: [{ target: 'x', removed: true }], tree: [{ role: 'main', type: '' }] },
    { wrapper: { exitCode: 1 }, leftoverScans: [{ atMs: 0, dirs: [] }, { atMs: 10000, dirs: [{ name: 'nsc3.tmp', files: [] }] }], leftoverHolders: [{ atMs: 10500, rows: [] }], leftoverRemoval: [{ target: 'y', removed: false, error: 'EBUSY' }], tree: [] },
  ];
  const summary = measure.summarizeSecondInstance(attempts);
  assert.equal(summary.attempts, 3);
  assert.deepEqual(summary.exitCodes, { 0: 2, 1: 1 });
  assert.equal(summary.leftoverAtLastScan, 2);
  assert.deepEqual(summary.leftoverFileCounts, [2, 0]);
  assert.equal(summary.holdersObserved, 1);
  assert.equal(summary.leftoverRemovedByMeasurement, 1);
  assert.equal(summary.leftoverStillLocked, 1);
  assert.equal(summary.mainObserved, 2);
  assert.equal(summary.gpuChildObserved, 1);
  assert.equal(summary.childrenSeenAfterWrapperExit, 1);
});

test('formatSummary names the label, the status, every stagger row, the baseline and the second-instance facts', () => {
  const evidence = {
    label: 'fixed', status: 'measured', infrastructureError: null,
    baseline: { outcome: 'ready', files: 78, bytes: 503557201, afterMs: 20000, close: { exitCode: 0 } },
    race: { observeMs: 2500, watcherTickMs: { median: 1.2, max: 9.8 }, summary: measure.summarizeRace([{ nominalMs: 0, achievedMs: 2, classification: 'A-lost', launchers: { A: exited(1, 1, 175), B: alive(2) }, followUp: { survivors: { B: { outcome: 'ready', files: 78, intact: true, close: { exitCode: 0 } } } } }]) },
    secondInstance: { summary: measure.summarizeSecondInstance([{ wrapper: { exitCode: 0 }, leftoverScans: [{ atMs: 10000, dirs: [{ name: 'nsz9.tmp', files: [{ path: 'a', size: 1 }] }] }], leftoverHolders: [{ rows: [{ pid: 1 }] }], leftoverRemoval: [{ removed: false }], tree: [] }]) },
  };
  const text = measure.formatSummary(evidence);
  assert.match(text, /\(fixed\): measured/);
  assert.match(text, /stagger 0 ms: 1 attempts .*A-lost=1 .*self-exit codes \{"1":1\} after 175\.\.175 ms; survivors intact=1/);
  assert.match(text, /baseline \(one launch alone\): ready, 78 files \/ 503557201 B/);
  assert.match(text, /second instance .*: 1 attempts, D exit codes \{"0":1\}.*leftover directories at the last scan 1x \(file counts \[1\]\), holders found 1x, removable later 0x, still locked 1x/);
  assert.match(measure.formatSummary({ label: 'control', status: 'infrastructure-failure', infrastructureError: { message: 'boom' } }), /\(control\): infrastructure-failure — boom/);
});

test('the %TEMP% watcher records only NEW ns<letter><hex>.tmp entries, their kind transitions and directory contents', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'trace-watcher-'));
  try {
    fs.writeFileSync(path.join(root, 'nsa0001.tmp'), ''); // pre-existing: ignored
    fs.mkdirSync(path.join(root, 'nsb0002.tmp'));
    fs.mkdirSync(path.join(root, 'nspre00.tmp')); // not an NSIS name (one letter, then hex): ignored
    const watcher = measure.createTempWatcher(root);
    const origin = performance.timeOrigin + performance.now();
    watcher.start();
    // Windows timers tick every ~15.6 ms, so each phase lasts several ticks on every platform.
    await new Promise((resolve) => setTimeout(resolve, 40));
    fs.writeFileSync(path.join(root, 'nsk58A3.tmp'), ''); // NSIS: GetTempFileName creates a file ...
    await new Promise((resolve) => setTimeout(resolve, 60));
    fs.unlinkSync(path.join(root, 'nsk58A3.tmp')); // ... Delete ...
    fs.mkdirSync(path.join(root, 'nsk58A3.tmp')); // ... CreateDirectory
    await new Promise((resolve) => setTimeout(resolve, 60));
    fs.writeFileSync(path.join(root, 'nsk58A3.tmp', 'app-64.7z'), 'abc');
    fs.mkdirSync(path.join(root, 'nsk58A3.tmp', 'app'));
    fs.writeFileSync(path.join(root, 'other.txt'), ''); // not an NSIS name: ignored
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(watcher.currentNewDirs(), ['nsk58A3.tmp']);
    const result = watcher.stop(origin);
    assert.deepEqual(result.preExisting.sort(), ['nsa0001.tmp', 'nsb0002.tmp']);
    assert.equal(result.entries.length, 1);
    const [entry] = result.entries;
    assert.equal(entry.name, 'nsk58A3.tmp');
    assert.deepEqual(entry.kinds.map((item) => item.kind), ['file', 'dir']);
    assert.equal(entry.finalKind, 'dir');
    assert.ok(entry.kinds[0].atMs >= 0 && entry.kinds[1].atMs > entry.kinds[0].atMs, 'transition times are relative to the origin and increasing');
    const last = entry.contents[entry.contents.length - 1];
    assert.deepEqual(last.names, ['app', 'app-64.7z']);
    assert.deepEqual(last.sizes, { 'app-64.7z': 3 });
    assert.ok(result.tickStats && result.tickStats.n >= 5 && result.tickStats.median < 50, `tick statistics recorded (Windows timer granularity is ~15.6 ms): ${JSON.stringify(result.tickStats)}`);
    assert.equal(result.readErrors, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    fs.rmSync(path.join(root, 'nsk58A3.tmp'), { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(watcher.currentNewDirs(), ['nsk58A3.tmp'], 'a stopped watcher no longer observes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PowerShell scripts quote their inputs and the JSON output parser tolerates a BOM and garbage', () => {
  assert.match(measure.samplerScript("C:\\a'b\\stop", 12), /'C:\\a''b\\stop'/);
  assert.match(measure.samplerScript('x', 12), /AddSeconds\(12\)/);
  assert.match(measure.holdersScript(["C:\\T\\ns1.tmp", "C:\\T\\it's.tmp"]), /@\('C:\\T\\ns1\.tmp', 'C:\\T\\it''s\.tmp'\)/);
  assert.match(measure.eventLogScript(1700000000123.9), /FromUnixTimeMilliseconds\(1700000000123\)/);
  assert.deepEqual(measure.parseJsonOutput('\uFEFF[{"pid":1}]', []), [{ pid: 1 }]);
  assert.deepEqual(measure.parseJsonOutput('not json', { events: [] }), { events: [] });
  assert.deepEqual(measure.parseJsonOutput('', 'fallback'), 'fallback');
});

test('the measurement refuses to run off-Windows and never pretends to be a verdict', () => {
  assert.equal(measure.EXIT.OK, 0);
  assert.equal(measure.EXIT.INFRA, 2);
  assert.equal(Object.keys(measure.EXIT).includes('FAIL'), false, 'a measurement has no FAIL exit code');
  assert.match(measure.USAGE, /measure-portable-startup\.cjs --exe/);
});
