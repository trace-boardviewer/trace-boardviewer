'use strict';

// MODEL / STATIC EVIDENCE ONLY — simulated platform, not Windows wrapper acceptance.
//
// These tests run on Linux and Windows without Electron and without the portable EXE. They prove that the
// decision logic of scripts/check-portable-isolation.cjs is correct and not vacuous when fed by a FAKE
// platform (a virtual clock plus a scripted world of wrapper/main/renderer/gpu processes and extraction
// directories): the signatures of the OLD shared-directory build recorded by LOCAL (both launches lost at
// 0 ms, launcher A exit 1 with B surviving at 5000 ms, shared runtime directory shrinking from 78 files /
// 503557201 B to 7 files / 366521134 B at 10000/20000 ms) fail the default mode and are detected by the
// control mode, every other defect class fails with a precise id, a failing baseline and every other
// infrastructure problem is exit 2 and never a pass, and the cleanup only touches what the run started.
// Whether the REAL Windows wrapper behaves like the isolated model is proven only by the windows.yml
// `portable-isolation` / `portable-isolation-control` jobs on a Windows runner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const check = require('../scripts/check-portable-isolation.cjs');
const payloadManifest = require('../scripts/payload-manifest.cjs');

// ---------------------------------------------------------------------------------------------------------
// Fake Windows world
// ---------------------------------------------------------------------------------------------------------

const TEMP = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp'; // NSIS reports the 8.3 spelling
const MAIN = 'TRACE Boardviewer.exe';
const FULL_BYTES_FOR_FIXTURE = 503557201;
const REMAINS_BYTES_FOR_FIXTURE = 366521134;
const FULL = Object.freeze({ files: 78, bytes: FULL_BYTES_FOR_FIXTURE }); // observed while both instances ran (old defect)
const REMAINS = Object.freeze({ files: 7, bytes: REMAINS_BYTES_FOR_FIXTURE }); // observed after instance A exited (old defect)
const PROFILE = Object.freeze({ files: 31, bytes: 1234567 });
const EXE = 'C:\\fake\\release\\TRACE-Boardviewer-1.1.0.exe';
// launch order of a default run: baseline, then A/B of each stagger (0, 5000, 10000, 20000), then C and D
const L = Object.freeze({ baseline: 1, c0: { A: 2, B: 3 }, c5000: { A: 4, B: 5 }, c10000: { A: 6, B: 7 }, c20000: { A: 8, B: 9 }, C: 10, D: 11 });
const dirKey = (target) => target.replace(/RUNNER~1/i, 'runneradmin').replace(/[\\/]+$/, '').toLowerCase();
const dirOfExe = (exe) => exe.slice(0, exe.lastIndexOf('\\'));

// A deterministic stand-in for the extracted runtime: 78 files / 503557201 B (FULL). The 7 files that stay behind in the old
// defect (REMAINS, 366521134 B) are a SUBSET of them, so a shrink is a real "missing files" difference. Nested paths on purpose.
const KEPT = ['TRACE Boardviewer.exe', 'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'v8_context_snapshot.bin', 'snapshot_blob.bin'];
const BASE_FILES = (() => {
  const kept = [{ path: KEPT[0], size: 245726720 }];
  const keptSizes = [30000000, 25000000, 20000000, 15000000, 10000000];
  KEPT.slice(1, 6).forEach((name, index) => kept.push({ path: name, size: keptSizes[index] }));
  kept.push({ path: KEPT[6], size: REMAINS_BYTES_FOR_FIXTURE - kept.reduce((total, file) => total + file.size, 0) });
  const others = [{ path: 'resources/app.asar', size: 80163902 }];
  for (let index = 0; index < 69; index++) others.push({ path: `locales/loc${String(index).padStart(2, '0')}.pak`, size: 600000 + index * 37 });
  others.push({ path: 'd3dcompiler_47.dll', size: (FULL_BYTES_FOR_FIXTURE - REMAINS_BYTES_FOR_FIXTURE) - others.reduce((total, file) => total + file.size, 0) });
  return payloadManifest.sortByPath([...kept, ...others]);
})();
const REMAINS_FILES = BASE_FILES.filter((file) => KEPT.includes(file.path));
const fakeSha = (name, size, corrupted = false) => crypto.createHash('sha256').update(`${name}|${size}${corrupted ? '|corrupted' : ''}`).digest('hex');
const sumSizes = (files) => files.reduce((total, file) => total + file.size, 0);
/** The listing a fake runtime directory shows for given counts (explicit entries win; FULL and REMAINS map to the fixtures above). */
function entriesFor(stats) {
  if (stats.entries) return stats.entries;
  if (stats.files === BASE_FILES.length && stats.bytes === sumSizes(BASE_FILES)) return BASE_FILES;
  if (stats.files === REMAINS_FILES.length && stats.bytes === sumSizes(REMAINS_FILES)) return REMAINS_FILES;
  const files = [];
  for (let index = 0; index < stats.files; index++) files.push(BASE_FILES[index] ? { ...BASE_FILES[index] } : { path: `extra/e${index}.bin`, size: 1 });
  if (files.length) files[files.length - 1].size += stats.bytes - sumSizes(files); // the last file absorbs the difference
  return payloadManifest.sortByPath(files);
}
/** A payload manifest as scripts/payload-manifest.cjs would write it for the fixture files (the same pure function). */
const makePayloadManifest = (files = BASE_FILES) => payloadManifest.finalizeManifest(files.map((file) => ({ ...file, sha256: fakeSha(file.path, file.size) })));

class FakeWindows {
  /**
   * options: mode 'isolated'|'shared'; extractMs (default 10000); overlap 'reference'|'both-lost'|'no-window'|'none'
   * (shared mode only); per-launch flags (true = every launch, or an array of launch indexes): neverReady,
   * exitBeforeReady, profileNeverAppears, ignoreClose, leaveRuntime, leaveNsParent; exitCodes {launchIndex: code};
   * spawnError (index); snapshotFails; missingExe; killOnClose; windowless; dStaysRunning; dMainInvisible;
   * damageOnCleanup {from, victim}; touchOnLaunch {launch, victim}; onFinish(world, wrapper);
   * gpu: noGpuProcess, twoGpuProcesses, gpuTerminateFails, gpuNoRespawn, gpuMainDies, gpuDamagesRuntime;
   * snapshotCostMs (virtual duration of every process snapshot); damageOnCleanup {from, victim, to: {files, bytes}, afterMs, restoreAfterMs}; sharedNoShrink; removalDelayMs (isolated cleanup becomes visible late);
   * profileDelayMs + profileDelayFor [launch indexes]; snapshotFailsAfterMs; snapshotFailsAfterLaunch; snapshotFailNext (count);
   * pidReuse (a killed main's pid is reused by another executable); survivorAfterKill (a stuck process keeps the dir busy);
   * longSpellingFor [launch indexes] (the process reports the long spelling RUNNER~1 -> runneradmin of the same directory)
   * jsonFiles {file: value} (the payload manifest and any config store); hashCostMs (virtual cost of hashing one runtime directory);
   * parity {corrupt: [{launch, path}], unreadable: [{launch, path, failures}]} (hash level: same size, other content / EBUSY for the first N reads);
   * runtimeEntries {launch: (entries) => entries} (set level: the runtime directory of that launch lists other files);
   * configAtStart (every first instance writes an empty config.json), preRecorded (C already lists the synthetic board before D),
   * forwardNotRecorded, forwardRecordDelayMs (default 300), forwardRecordedPath (fn board => recorded spelling), configReadErrors (the next N config reads fail)
   */
  constructor(options = {}) {
    this.opts = { mode: 'isolated', extractMs: 10000, ...options };
    this.clock = 0;
    this.events = [];
    this.seq = 0;
    this.nextPidValue = 4000;
    this.nsCounter = 0;
    this.areaCounter = 0;
    this.procs = new Map();
    this.wrappers = new Map();
    this.launches = [];
    this.dirs = new Map();
    this.kills = [];
    this.injectedKills = [];
    this.areas = [];
    this.removedAreas = [];
    this.removedTrees = [];
    this.written = new Map();
    this.logs = [];
    this.jsonFiles = new Map(Object.entries(this.opts.jsonFiles || {}));
    this.hashCalls = [];
    this.unreadableUsed = new Map();
    this.writeTimes = new Map();
  }

  flag(name, index) { const value = this.opts[name]; return value === true || (Array.isArray(value) && value.includes(index)); }

  // virtual time -------------------------------------------------------------------------------------------
  now() { return this.clock; }
  nowIso() { return new Date(Date.UTC(2026, 9, 5, 12, 0, 0) + this.clock).toISOString(); }
  at(delayMs, fn) { this.events.push({ time: this.clock + delayMs, seq: this.seq++, fn }); }
  async sleep(ms) {
    const target = this.clock + Math.max(0, ms);
    for (;;) {
      this.events.sort((a, b) => a.time - b.time || a.seq - b.seq);
      if (!this.events.length || this.events[0].time > target) break;
      const event = this.events.shift();
      this.clock = Math.max(this.clock, event.time);
      event.fn();
    }
    this.clock = target;
    await Promise.resolve();
  }
  log(line) { this.logs.push(line); }
  info() { return { os: 'fake-windows', arch: 'x64', release: '10.0', node: process.version }; }

  // directories --------------------------------------------------------------------------------------------
  setDir(target, stats) { this.dirs.set(dirKey(target), { path: target, files: stats.files, bytes: stats.bytes, entries: stats.entries }); }
  removeDir(target) {
    const key = dirKey(target);
    for (const existing of [...this.dirs.keys()]) if (existing === key || existing.startsWith(`${key}\\`)) this.dirs.delete(existing);
  }
  async dirStats(target) {
    const key = dirKey(target);
    const own = this.dirs.get(key);
    if (own) return { exists: true, files: own.files, bytes: own.bytes };
    const children = [...this.dirs.entries()].filter(([existing]) => existing.startsWith(`${key}\\`));
    if (!children.length) return { exists: false, files: 0, bytes: 0 };
    return { exists: true, files: children.reduce((sum, [, v]) => sum + v.files, 0), bytes: children.reduce((sum, [, v]) => sum + v.bytes, 0) };
  }
  async exists(target) { return (await this.dirStats(target)).exists; }
  /** Size-only listing of a runtime directory (what the real platform walks). */
  async dirManifest(target) {
    const key = dirKey(target);
    const own = this.dirs.get(key);
    if (!own) return { exists: false, files: [] };
    return { exists: true, files: entriesFor(own).map((entry) => ({ path: entry.path, size: entry.size })) };
  }
  /** Streaming-hash model: deterministic per (path, size); corrupt / unreadable / listing overrides per launch. */
  async hashTree(target, { skip = null } = {}) {
    const running = [...this.procs.values()].some((proc) => proc.alive && proc.exe && dirKey(proc.exe).startsWith(`${dirKey(target)}\\`));
    this.hashCalls.push({ dir: target, skipped: skip ? skip.size : 0, running, atMs: this.clock });
    if (this.opts.hashCostMs) await this.sleep(this.opts.hashCostMs);
    const key = dirKey(target);
    const own = this.dirs.get(key);
    if (!own) return { exists: false, files: [], unreadable: [] };
    const wrapper = this.launches.find((candidate) => candidate.runDir && dirKey(candidate.runDir) === key);
    const launch = wrapper ? wrapper.index : null;
    const parity = this.opts.parity || {};
    const corrupt = (parity.corrupt || []).filter((item) => item.launch === launch).map((item) => item.path);
    let listing = entriesFor(own);
    const override = this.opts.runtimeEntries && this.opts.runtimeEntries[launch];
    if (override) listing = override(listing);
    const files = [];
    const unreadable = [];
    for (const entry of listing) {
      if (skip && skip.has(entry.path)) continue;
      const bad = (parity.unreadable || []).find((item) => item.launch === launch && item.path === entry.path);
      if (bad) {
        const used = this.unreadableUsed.get(`${launch}|${entry.path}`) || 0;
        if (used < (bad.failures ?? Infinity)) { this.unreadableUsed.set(`${launch}|${entry.path}`, used + 1); unreadable.push({ path: entry.path, code: 'EBUSY' }); continue; }
      }
      files.push({ path: entry.path, size: entry.size, sha256: fakeSha(entry.path, entry.size, corrupt.includes(entry.path)) });
    }
    return { exists: true, files, unreadable };
  }
  async readJsonFile(file) {
    if (this.opts.configReadErrors > 0 && /config\.json$/.test(file)) { this.opts.configReadErrors -= 1; return { status: 'error', message: 'EBUSY: simulated' }; }
    if (!this.jsonFiles.has(file)) return { status: 'missing' };
    return { status: 'ok', value: structuredClone(this.jsonFiles.get(file)) };
  }
  async canonicalize(target) { return target.replace(/RUNNER~1/i, 'runneradmin'); }
  async listNsRuntimeDirs() {
    return [...this.dirs.values()].filter((entry) => /\\ns[a-z][0-9A-F]+\.tmp\\app$/i.test(entry.path)).map((entry) => entry.path);
  }
  async removeTree(target) {
    if (!(await this.exists(target))) return false;
    this.removeDir(target);
    this.removedTrees.push(target);
    return true;
  }
  async makeTempArea() { const area = `FAKE-AREA-${++this.areaCounter}`; this.areas.push(area); return area; }
  async removeTempArea(dir) { this.removedAreas.push(dir); }
  async writeFile(file, text) { this.written.set(file, text); this.writeTimes.set(file, this.clock); }
  async fileInfo() {
    if (this.opts.missingExe) throw new Error('ENOENT: no such file');
    return { sizeBytes: 218_000_000, sha256: 'ab'.repeat(32) };
  }

  // processes ----------------------------------------------------------------------------------------------
  nextPid() { this.nextPidValue += 4; return this.nextPidValue; }
  addProc(fields) {
    const proc = { pid: this.nextPid(), name: MAIN, type: '', windowHandle: 0, responding: true, alive: true, hidden: false, ...fields };
    this.procs.set(proc.pid, proc);
    return proc;
  }
  mainOf(launchIndex) { return this.procs.get(this.launches[launchIndex - 1].mainPid); }
  wrapperOf(mainPid) { return [...this.wrappers.values()].find((wrapper) => wrapper.mainPid === mainPid) || null; }
  killWithChildren(pid) {
    const proc = this.procs.get(pid);
    if (proc) proc.alive = false;
    for (const child of this.procs.values()) if (child.ppid === pid && child.alive) this.killWithChildren(child.pid);
  }
  aliveWrapperPids() { return [...this.wrappers.values()].filter((wrapper) => !wrapper.exited).map((wrapper) => wrapper.pid); }
  addForeignMain() { return this.addProc({ ppid: 17, exe: `D:\\Apps\\TRACE\\${MAIN}`, windowHandle: 777 }); } // a TRACE instance the user started
  async snapshot() {
    if (this.opts.snapshotCostMs) await this.sleep(this.opts.snapshotCostMs); // a real snapshot takes seconds
    if (this.opts.snapshotFails) throw new Error('powershell.exe failed: simulated');
    if (this.opts.snapshotFailsAfterMs !== undefined && this.clock >= this.opts.snapshotFailsAfterMs) throw new Error('powershell.exe failed: simulated (mid-run)');
    if (this.opts.snapshotFailsAfterLaunch !== undefined && this.launches.length >= this.opts.snapshotFailsAfterLaunch) throw new Error('powershell.exe failed: simulated (after launch)');
    if (this.opts.snapshotFailNext > 0) { this.opts.snapshotFailNext -= 1; throw new Error('powershell.exe failed: simulated (transient)'); }
    return [...this.procs.values()].filter((proc) => proc.alive && !proc.hidden).map((proc) => ({
      pid: proc.pid, ppid: proc.ppid, name: proc.name, exe: proc.exe ?? null, type: proc.type, windowHandle: proc.windowHandle, responding: proc.responding,
    }));
  }

  allocate() {
    if (this.opts.mode === 'shared') return { runDir: `${TEMP}\\trace-control-shared`, nsisParent: null };
    // real NSIS plugin dirs: ns + ONE letter + hex (nseC3BF.tmp, nsj1138.tmp, nsk58A3.tmp)
    const n = this.nsCounter++;
    const leaf = `ns${'kqzafw'[n % 6]}${(0xA1B2 + n * 37).toString(16).toUpperCase()}.tmp`;
    return { runDir: `${TEMP}\\${leaf}\\app`, nsisParent: `${TEMP}\\${leaf}` };
  }
  exitCodeOf(wrapper) { return (this.opts.exitCodes || {})[wrapper.index] ?? 0; }
  finish(wrapper, code) {
    if (wrapper.exited) return;
    wrapper.exited = true;
    wrapper.exitCode = code;
    wrapper.exitedAtMs = this.clock;
    if (this.opts.onFinish) this.opts.onFinish(this, wrapper);
  }

  /** What `RMDir /r $INSTDIR` after the app exits does. */
  wrapperCleanup(wrapper) {
    const { opts } = this;
    if (wrapper.cancelled || this.flag('leaveRuntime', wrapper.index)) return;
    if (opts.mode === 'shared') {
      const stillUsed = [...this.procs.values()].some((proc) => proc.alive && proc.type === '' && proc.exe && dirKey(proc.exe).startsWith(`${dirKey(wrapper.runDir)}\\`));
      if (stillUsed) { if (!opts.sharedNoShrink) this.setDir(wrapper.runDir, REMAINS); } else this.removeDir(wrapper.runDir);
      return;
    }
    if (opts.damageOnCleanup && opts.damageOnCleanup.from === wrapper.index) {
      const victim = this.launches[opts.damageOnCleanup.victim - 1];
      const damage = () => {
        if (!victim || !victim.runDir) return;
        this.setDir(victim.runDir, opts.damageOnCleanup.to || REMAINS);
        if (opts.damageOnCleanup.restoreAfterMs) this.at(opts.damageOnCleanup.restoreAfterMs, () => this.setDir(victim.runDir, FULL)); // transient
      };
      if (opts.damageOnCleanup.afterMs) this.at(opts.damageOnCleanup.afterMs, damage); else damage();
    }
    if (this.flag('leaveRuntime', wrapper.index)) return;
    if (this.flag('leaveNsParent', wrapper.index)) { this.removeDir(wrapper.runDir); this.setDir(wrapper.nsisParent, { files: 0, bytes: 0 }); return; }
    if (opts.removalDelayMs) this.at(opts.removalDelayMs, () => this.removeDir(wrapper.nsisParent)); // antivirus / slow disk
    else this.removeDir(wrapper.nsisParent);
  }

  launch(exe, args) {
    const index = this.launches.length + 1;
    if (this.opts.spawnError === index) return Promise.reject(new Error('spawn UNKNOWN'));
    const profile = (args.find((arg) => arg.startsWith('--user-data-dir=')) || '').slice('--user-data-dir='.length);
    const wrapper = { pid: this.nextPid(), index, args, profile, exited: false, exitCode: null, exitedAtMs: null, mainPid: null, runDir: null, nsisParent: null, launchedAt: this.clock, cancelled: false, noWindow: false };
    this.wrappers.set(wrapper.pid, wrapper);
    this.launches.push(wrapper);
    const second = [...this.procs.values()].some((proc) => proc.alive && proc.type === '' && proc.profile === profile && this.wrapperOf(proc.pid));
    Object.assign(wrapper, this.allocate());
    if (this.flag('exitBeforeReady', index) && !second) this.at(1000, () => this.finish(wrapper, this.opts.exitCodes?.[index] ?? 1));
    else if (second) this.secondInstance(wrapper);
    else { this.applyOverlap(wrapper); this.firstInstance(wrapper); }
    return Promise.resolve({ pid: wrapper.pid, state: () => ({ exited: wrapper.exited, exitCode: wrapper.exitCode, signal: null, exitedAtMs: wrapper.exitedAtMs }) });
  }

  /** The old shared-directory build: overlapping extractions destroy each other (LOCAL's recorded signatures). */
  applyOverlap(wrapper) {
    const model = this.opts.overlap ?? 'reference';
    if (this.opts.mode !== 'shared' || model === 'none') return;
    const other = [...this.wrappers.values()].find((w) => w !== wrapper && !w.exited && !w.cancelled && w.runDir === wrapper.runDir && w.mainPid === null && w.profile !== wrapper.profile);
    if (!other) return;
    const gap = this.clock - other.launchedAt;
    if (model === 'both-lost' || (model === 'reference' && gap < 1000)) { // both launches lost, launchers exit silently
      other.cancelled = true;
      wrapper.cancelled = true;
      this.at(3000, () => { this.finish(other, 0); this.finish(wrapper, 0); });
    } else if (model === 'reference') { // A is still extracting: A exits with code 1, B survives
      other.cancelled = true;
      this.at(2000, () => this.finish(other, 1));
    } else if (model === 'no-window') { // both keep running but never show a window
      other.noWindow = true;
      wrapper.noWindow = true;
    }
  }

  firstInstance(wrapper) {
    this.at(this.opts.extractMs, () => {
      if (wrapper.exited || wrapper.cancelled) return;
      this.setDir(wrapper.runDir, FULL);
      const touch = this.opts.touchOnLaunch;
      if (touch && touch.launch === wrapper.index) this.setDir(this.launches[touch.victim - 1].runDir, REMAINS);
      const exeDir = this.flag('longSpellingFor', wrapper.index) ? wrapper.runDir.replace(/RUNNER~1/i, 'runneradmin') : wrapper.runDir;
      const main = this.addProc({ ppid: wrapper.pid, exe: `${exeDir}\\${MAIN}`, profile: wrapper.profile });
      wrapper.mainPid = main.pid;
      const configFile = path.join(wrapper.profile, 'config.json');
      if (this.opts.configAtStart) this.jsonFiles.set(configFile, { version: 1, settings: {}, recentBoards: [] });
      if (this.opts.preRecorded) this.jsonFiles.set(configFile, { version: 1, settings: {}, recentBoards: [{ name: 'synthetic-board.cad', path: path.join(path.dirname(wrapper.profile), 'synthetic-board.cad'), openedAt: '2026-10-05T12:00:00.000Z' }] });
      if (!this.flag('profileNeverAppears', wrapper.index)) {
        const delayed = this.opts.profileDelayMs && (!this.opts.profileDelayFor || this.opts.profileDelayFor.includes(wrapper.index));
        if (delayed) this.at(this.opts.profileDelayMs, () => this.setDir(wrapper.profile, PROFILE)); else this.setDir(wrapper.profile, PROFILE);
      }
      if (this.flag('neverReady', wrapper.index) || wrapper.noWindow) return;
      if (!this.opts.noGpuProcess) this.at(500, () => { if (main.alive) this.addProc({ ppid: main.pid, exe: main.exe, type: 'gpu-process' }); });
      if (this.opts.twoGpuProcesses) this.at(600, () => { if (main.alive) this.addProc({ ppid: main.pid, exe: main.exe, type: 'gpu-process' }); });
      this.at(1000, () => { if (main.alive) this.addProc({ ppid: main.pid, exe: main.exe, type: 'renderer' }); });
      if (!this.opts.windowless) this.at(2500, () => { if (main.alive) main.windowHandle = 0x10000 + main.pid; });
    });
  }

  secondInstance(wrapper) {
    this.at(4000, () => {
      this.setDir(wrapper.runDir, FULL);
      const main = this.addProc({ ppid: wrapper.pid, exe: `${wrapper.runDir}\\${MAIN}`, profile: wrapper.profile, hidden: !!this.opts.dMainInvisible });
      wrapper.mainPid = main.pid;
      this.at(this.opts.forwardRecordDelayMs ?? 300, () => this.recordForwardedBoard(wrapper)); // D hands its argv to the first instance, which records the board
      if (this.opts.dStaysRunning) return;
      this.at(700, () => this.killWithChildren(main.pid)); // single-instance lock lost: the process quits by itself
      this.at(1400, () => { this.wrapperCleanup(wrapper); this.finish(wrapper, this.exitCodeOf(wrapper)); });
    });
  }

  /** C (the running first instance of the profile) parses the forwarded board and saves it in its config store (acceptBoard). */
  recordForwardedBoard(secondWrapper) {
    if (this.opts.forwardNotRecorded) return;
    const first = [...this.procs.values()].find((proc) => proc.alive && proc.type === '' && proc.profile === secondWrapper.profile && proc.ppid !== secondWrapper.pid && this.wrapperOf(proc.pid));
    if (!first) return; // the first instance is already quitting: its store no longer accepts writes
    const board = secondWrapper.args.find((arg) => !arg.startsWith('--'));
    if (!board) return;
    const configFile = path.join(secondWrapper.profile, 'config.json');
    const current = this.jsonFiles.get(configFile) || { version: 1, settings: {}, recentBoards: [] };
    const recordedPath = this.opts.forwardRecordedPath ? this.opts.forwardRecordedPath(board) : board;
    this.jsonFiles.set(configFile, { ...current, recentBoards: [{ name: path.basename(board), path: recordedPath, openedAt: '2026-10-05T12:00:30.000Z' }, ...current.recentBoards] });
  }

  async closeMainWindow(pid) {
    const proc = this.procs.get(pid);
    if (!proc || !proc.alive) return { method: 'CloseMainWindow', ok: false, detail: 'process not found' };
    const wrapper = this.wrapperOf(pid);
    const method = proc.windowHandle ? 'CloseMainWindow' : 'taskkill-graceful';
    if (this.opts.killOnClose) await this.killTree(pid); // a platform that "closes" by force-killing
    else if (this.flag('ignoreClose', wrapper.index)) return { method, ok: true, detail: 'ok' };
    else this.at(1500, () => this.killWithChildren(pid));
    this.at(2500, () => { this.wrapperCleanup(wrapper); this.finish(wrapper, this.exitCodeOf(wrapper)); });
    return { method, ok: true, detail: 'ok' };
  }

  /** The injected GPU restart: refuses anything that is not a `type` descendant of rootPid. */
  async terminateChildProcess(pid, { rootPid, type }) {
    if (this.opts.gpuTerminateFails) return { killed: false, reason: 'taskkill exit 1' };
    const proc = this.procs.get(pid);
    if (!proc || !proc.alive) return { killed: false, reason: 'process not found' };
    if (proc.type !== type) return { killed: false, reason: `process is of type "${proc.type}"` };
    let below = false;
    for (let current = proc; current; current = this.procs.get(current.ppid)) if (current.ppid === rootPid) below = true;
    if (!below) return { killed: false, reason: `not a descendant of ${rootPid}` };
    proc.alive = false;
    this.injectedKills.push({ pid, rootPid, type, atMs: this.clock });
    const main = this.procs.get(rootPid);
    const wrapper = this.wrapperOf(rootPid);
    const runDir = dirOfExe(main.exe);
    if (this.opts.gpuDamagesRuntime) this.setDir(runDir, REMAINS);
    const damaged = this.opts.mode === 'shared' && this.dirs.get(dirKey(runDir)) && this.dirs.get(dirKey(runDir)).files === REMAINS.files;
    if (this.opts.gpuMainDies || damaged) { // the respawned GPU process cannot start from the damaged runtime: B dies
      this.at(1000, () => { this.killWithChildren(rootPid); });
      this.at(1500, () => { this.wrapperCleanup(wrapper); this.finish(wrapper, 1); });
    } else if (!this.opts.gpuNoRespawn) {
      this.at(1500, () => { if (main.alive) this.addProc({ ppid: rootPid, exe: main.exe, type: 'gpu-process' }); });
    }
    return { killed: true, reason: 'terminated' };
  }

  async killTree(pid) {
    this.kills.push({ pid, atMs: this.clock });
    const wrapper = this.wrappers.get(pid);
    this.killWithChildren(pid);
    if (wrapper && !wrapper.exited) { wrapper.exited = true; wrapper.exitCode = 1; wrapper.exitedAtMs = this.clock; } // killed: no runtime cleanup happens
    if (wrapper && wrapper.mainPid && this.opts.pidReuse) { // the main's pid is handed to an unrelated executable
      this.procs.set(wrapper.mainPid, { pid: wrapper.mainPid, name: MAIN, type: '', windowHandle: 0, responding: true, alive: true, hidden: false, ppid: 17, exe: 'D:\\Apps\\Reuser\\TRACE Boardviewer.exe' });
    }
    if (wrapper && wrapper.runDir && this.opts.survivorAfterKill) { // a stuck process keeps our extraction directory busy
      this.addProc({ ppid: 17, exe: `${wrapper.runDir}\\${MAIN}`, type: 'utility' });
    }
  }
  killLog() { return this.kills.slice(); }
}

const baseOptions = (extra = {}) => ({ exe: EXE, timeoutSec: 120, ...extra });
const ids = (list) => list.map((item) => item.id);
const profile = (area, name) => path.join(area, name);
const conc = (result, nominalMs) => result.evidence.concurrency.find((rec) => rec.stagger.nominalMs === nominalMs);

async function runWorld(worldOptions = {}, runOptions = {}) {
  const world = new FakeWindows(worldOptions);
  const result = await check.run(baseOptions(runOptions), world);
  return { world, result };
}

let passingRun = null;
async function passingEvidence() {
  passingRun ??= (await runWorld()).result.evidence;
  return structuredClone({ baseline: passingRun.baseline, concurrency: passingRun.concurrency, scenario2: passingRun.scenario2, forcedKill: false });
}

let passingRunRepeat2 = null;
async function passingEvidenceRepeat2() {
  passingRunRepeat2 ??= (await runWorld({}, { repeat: 2 })).result.evidence;
  return structuredClone({ baseline: passingRunRepeat2.baseline, concurrency: passingRunRepeat2.concurrency, scenario2: passingRunRepeat2.scenario2, forcedKill: false });
}

// ---------------------------------------------------------------------------------------------------------
// Fixed behaviour: pass
// ---------------------------------------------------------------------------------------------------------

test('isolated behaviour passes every scenario with signature isolated-ok, exit 0 and no force-kill', async () => {
  const { world, result } = await runWorld();
  assert.deepEqual(result.failures, []);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.exitCode, 0);
  const evidence = result.evidence;
  assert.equal(evidence.baseline.passed, true);
  assert.deepEqual(evidence.concurrency.map((rec) => rec.stagger.nominalMs), [0, 5000, 10000, 20000]);
  assert.deepEqual(evidence.concurrency.map((rec) => rec.observed.signature), ['isolated-ok', 'isolated-ok', 'isolated-ok', 'isolated-ok']);
  assert.deepEqual(evidence.concurrency.map((rec) => rec.observed.matchesReference), [true, true, true, true]);
  for (const rec of evidence.concurrency) {
    assert.equal(rec.runDirShared, false, rec.name);
    assert.notEqual(rec.A.runDir, rec.B.runDir);
    assert.equal(rec.A.runDirKind, 'per-launch-nsis');
    assert.deepEqual([rec.launchers.A.outcome, rec.launchers.B.outcome], ['ready', 'ready']);
    assert.ok(rec.A.profile.files > 0 && rec.B.profile.files > 0, 'both profiles are populated');
    assert.deepEqual(rec.bothRunning.B.runDir, { exists: true, ...FULL });
    assert.deepEqual(rec.afterAExit.runDir, { exists: true, ...FULL }, `${rec.name}: B keeps EXACTLY its file count and bytes right after A exits`);
    assert.deepEqual(rec.afterAExitSettled.runDir, { exists: true, ...FULL });
    assert.equal(rec.afterAExit.proc.mainAlive, true);
    assert.equal(rec.afterAExit.proc.responding, true);
    assert.ok(rec.afterAExit.proc.windowHandle > 0);
    assert.equal(rec.aClose.exitCode, 0);
    assert.equal(rec.aClose.cleanup.runDirRemoved, true);
    assert.equal(rec.aClose.cleanup.nsisParentRemoved, true);
    assert.equal(rec.bClose.exitCode, 0);
  }
  assert.equal(evidence.scenario2.D.exitedByItself, true);
  assert.equal(evidence.scenario2.D.exitCode, 0);
  assert.equal(evidence.scenario2.dCleanup.runDirRemoved, true);
  assert.equal(evidence.scenario2.cClose.exitCode, 0);
  assert.equal(evidence.forcedKill, false);
  assert.deepEqual(world.kills, [], 'nothing is force-killed on the success path nor by the cleanup');
  assert.deepEqual(world.aliveWrapperPids(), []);
  assert.equal(evidence.detection.any, false);
  assert.equal(world.areas.length, 6, 'a fresh temp area per scenario: baseline, four staggers, second instance');
  assert.deepEqual(world.removedAreas, world.areas);
  assert.equal(new Set(world.areas).size, 6);
});

test('baseline scenario: a single launch alone is ready with window and profile files, closes with exit 0 and its runtime is removed', async () => {
  const { result } = await runWorld();
  const baseline = result.evidence.baseline;
  assert.equal(baseline.launcher.outcome, 'ready');
  assert.equal(baseline.instance.windowMode, 'handle');
  assert.ok(baseline.instance.profile.files > 0);
  assert.equal(baseline.close.exitCode, 0);
  assert.equal(baseline.close.cleanup.runDirRemoved, true);
  assert.deepEqual(baseline.problems, []);
});

test('each concurrency scenario gets fresh distinct --user-data-dir profiles; D reuses C\'s profile plus the synthetic board', async () => {
  const { world } = await runWorld();
  const profileOf = (index) => world.launches[index - 1].profile;
  const all = [L.baseline, L.c0.A, L.c0.B, L.c5000.A, L.c5000.B, L.c10000.A, L.c10000.B, L.c20000.A, L.c20000.B, L.C].map(profileOf);
  assert.equal(new Set(all).size, all.length, 'no two launches (other than C/D) share a profile');
  const d = world.launches[L.D - 1];
  assert.equal(d.profile, profileOf(L.C));
  assert.deepEqual(d.args, [`--user-data-dir=${profileOf(L.C)}`, path.join(world.areas[5], 'synthetic-board.cad')], 'the preferred "=" form of the profile switch');
  assert.ok(world.launches.every((wrapper) => wrapper.args[0].startsWith('--user-data-dir=') && !wrapper.args.includes('--user-data-dir')));
  assert.equal(world.written.get(path.join(world.areas[5], 'synthetic-board.cad')), check.SYNTHETIC_BOARD);
  assert.ok(world.launches[L.c0.A - 1].profile.startsWith(world.areas[1]) && world.launches[L.c5000.A - 1].profile.startsWith(world.areas[2]));
});

test('staggers: 0 and 5000 ms are measured from A\'s wrapper spawn, 10000 and 20000 ms from the first observation of A\'s main process; nominal AND achieved are recorded', async () => {
  const { result } = await runWorld();
  const [s0, s5, s10, s20] = result.evidence.concurrency.map((rec) => rec.stagger);
  assert.deepEqual([s0.from, s5.from, s10.from, s20.from], ['wrapper-spawn', 'wrapper-spawn', 'main-seen', 'main-seen']);
  assert.deepEqual([s0.achievedMs, s5.achievedMs, s10.achievedMs, s20.achievedMs], [0, 5000, 10000, 20000]);
  assert.ok(s10.achievedFromAWrapperSpawnMs > 10000 && s20.achievedFromAWrapperSpawnMs > 20000, 'main-seen staggers include A\'s extraction time');
  assert.deepEqual([s0.referenceReached, s10.referenceReached], [true, true]);
  assert.deepEqual([s0.aStatusAtBLaunch, s5.aStatusAtBLaunch, s10.aStatusAtBLaunch, s20.aStatusAtBLaunch], ['pending', 'pending', 'ready', 'ready'], 'A is still extracting at 0/5000 ms and already running at 10000/20000 ms after its main process appeared');
  assert.deepEqual([s0.aMainSeenAtBLaunch, s5.aMainSeenAtBLaunch, s10.aMainSeenAtBLaunch], [false, false, true]);
});

test('evidence carries exe path/size/SHA-256, timestamps, per-scenario pids, launcher exit codes/elapsed ms, gpu pids, localReference provenance and no command lines', async () => {
  const { result } = await runWorld();
  const evidence = JSON.parse(JSON.stringify(result.evidence));
  assert.equal(evidence.schema, 'trace-portable-isolation-evidence/3'); // bumped from /2 for repeat / closeOrder / preservation / payloadParity / forwardedBoardRecorded
  assert.equal(evidence.exe.path, path.resolve(EXE));
  assert.equal(evidence.exe.sizeBytes, 218_000_000);
  assert.equal(evidence.exe.sha256, 'ab'.repeat(32));
  assert.match(evidence.tool.startedAt, /^2026-10-05T/);
  assert.ok(evidence.tool.finishedAt);
  const rec = evidence.concurrency[3];
  for (const key of ['wrapperPid', 'mainPid', 'runDir', 'runDirCanonical', 'baseline', 'windowMode', 'descendantPids', 'profile']) assert.ok(rec.A[key] !== undefined, `A.${key}`);
  assert.equal(rec.A.runDirCanonical.includes('RUNNER~1'), false, 'the canonical spelling is recorded next to the reported one');
  assert.ok(rec.launchers.A.wrapperPid && rec.launchers.A.elapsedMs > 0 && rec.launchers.A.outcome === 'ready');
  assert.deepEqual(Object.keys(rec.stagger).sort(), ['aMainSeenAtBLaunch', 'aStatusAtBLaunch', 'achievedFromAWrapperSpawnMs', 'achievedMs', 'from', 'nominalMs', 'referenceReached']);
  assert.equal(rec.gpuRestart.injected, true);
  assert.match(rec.gpuRestart.note, /INJECTED/);
  assert.equal(rec.gpuRestart.pidsBefore.length, 1);
  assert.equal(rec.gpuRestart.newPids.length, 1);
  assert.deepEqual(rec.gpuRestart.pidsAfter, rec.gpuRestart.newPids);
  assert.equal(evidence.concurrency[0].gpuRestart, null, 'the injection runs once, in the last scenario');
  assert.equal(evidence.localReference.reportSha256, 'E2A6406736995C88275DC40382A3A94A89BE21979623BC98F7EE599EB50CA83D');
  assert.match(evidence.localReference.provenance, /not CI evidence/i);
  assert.deepEqual(evidence.localReference.signatures.map((entry) => [entry.nominalMs, entry.signature]),
    [[0, 'both-lost'], [5000, 'a-exit-nonzero-b-survives'], [10000, 'shared-dir-runtime-shrinks'], [20000, 'shared-dir-runtime-shrinks']]);
  assert.equal(evidence.forcedKill, false);
  assert.equal(evidence.verdict, 'pass');
  assert.deepEqual(evidence.failures, []);
  assert.equal(JSON.stringify(evidence).toLowerCase().includes('commandline'), false);
  assert.ok(evidence.timeline.length > 20);
});

test('a window-less session falls back to the renderer-after-settle readiness rule and closes gracefully (still no kill)', async () => {
  const { world, result } = await runWorld({ windowless: true });
  assert.equal(result.verdict, 'pass', JSON.stringify(result.failures));
  assert.equal(result.evidence.baseline.instance.windowMode, 'renderer-fallback');
  assert.ok(result.evidence.baseline.instance.readyAfterMs >= 15000, 'the fallback waits for the minimum settle time');
  assert.equal(result.evidence.concurrency[3].aClose.method, 'taskkill-graceful');
  assert.ok(result.observations.some((item) => item.id === 'BASELINE_WINDOW_MODE'));
  assert.deepEqual(world.kills, []);
});

// ---------------------------------------------------------------------------------------------------------
// The OLD build: LOCAL's reference signatures
// ---------------------------------------------------------------------------------------------------------

test('OLD build fixture (LOCAL reference): both-lost at 0 ms, A exit 1 with B surviving at 5000 ms, shared dir shrinking 78->7 files at 10000/20000 ms FAILS the default mode', async () => {
  const { result } = await runWorld({ mode: 'shared' });
  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.evidence.concurrency.map((rec) => rec.observed.signature),
    ['both-lost', 'a-exit-nonzero-b-survives', 'shared-dir-runtime-shrinks', 'shared-dir-runtime-shrinks']);
  assert.deepEqual(result.evidence.concurrency.map((rec) => rec.observed.matchesReference), [false, false, false, false], 'isolated mode expects isolated-ok everywhere');
  const failed = ids(result.failures);
  for (const id of ['CONC0_A_EXITED_BEFORE_READY', 'CONC0_B_EXITED_BEFORE_READY', 'CONC5000_A_EXITED_BEFORE_READY', 'CONC10000_RUNDIR_SHARED', 'CONC20000_RUNDIR_SHARED', 'CONC10000_B_RUNTIME_CHANGED_IMMEDIATE', 'CONC20000_B_RUNTIME_CHANGED_IMMEDIATE']) {
    assert.ok(failed.includes(id), `${id} missing from ${failed.join()}`);
  }
  assert.equal(failed.includes('CONC5000_B_EXITED_BEFORE_READY'), false, 'B survives at 5000 ms');
  const a5 = conc(result, 5000).launchers.A;
  assert.deepEqual([a5.outcome, a5.exitCode], ['exited', 1]);
  assert.ok(a5.elapsedMs > 0);
  const b0 = conc(result, 0).launchers.B;
  assert.deepEqual([b0.outcome, b0.exitCode], ['exited', 0], 'silent launcher exit recorded with code and elapsed time');
  const late = conc(result, 20000);
  assert.deepEqual(late.bothRunning.B.runDir, { exists: true, ...FULL });
  assert.deepEqual(late.afterAExit.runDir, { exists: true, ...REMAINS });
  assert.equal(late.aClose.exitCode, 0);
  assert.equal(late.afterAExit.proc.mainAlive, true, 'B was still alive while its runtime had been deleted underneath it');
  assert.equal(result.evidence.forcedKill, false, 'no forced kill on the success path');
});

test('OLD build fixture passes the CONTROL mode: every scenario matches LOCAL\'s reference signature, baseline passed, per-scenario signature recorded', async () => {
  const { result } = await runWorld({ mode: 'shared' }, { expect: 'shared' });
  assert.equal(result.exitCode, 0, JSON.stringify(result.failures));
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.failures, []);
  assert.equal(result.detection.any, true);
  assert.equal(result.detection.baselineOk, true);
  assert.deepEqual(result.evidence.concurrency.map((rec) => rec.observed.matchesReference), [true, true, true, true]);
  assert.deepEqual(result.evidence.concurrency.map((rec) => rec.observed.family), ['reference-defect', 'reference-defect', 'reference-defect', 'reference-defect']);
  assert.deepEqual(result.evidence.concurrency.map((rec) => rec.observed.expectedSignature),
    ['both-lost', 'a-exit-nonzero-b-survives', 'shared-dir-runtime-shrinks', 'shared-dir-runtime-shrinks']);
  assert.equal(result.evidence.concurrency[3].gpuRestart.after.proc.mainAlive, false, 'the injected GPU restart killed B in the damaged shared runtime');
  assert.ok(result.observations.some((item) => item.expectedInControlMode));
});

test('control mode reports honestly when a (still defective) signature differs from the reference at the 0/5000 ms timing boundary (matchesReference=false) and still passes', async () => {
  const { result } = await runWorld({ mode: 'shared', overlap: 'no-window' }, { expect: 'shared' });
  assert.equal(result.exitCode, 0, JSON.stringify(result.failures));
  const [s0, s5, s10] = result.evidence.concurrency.map((rec) => rec.observed);
  assert.equal(s0.signature, 'both-lost');
  assert.equal(s0.matchesReference, true);
  assert.equal(s5.signature, 'both-lost', 'no window for either instance (timeout) instead of A exit 1 / B survives');
  assert.equal(s5.expectedSignature, 'a-exit-nonzero-b-survives');
  assert.equal(s5.matchesReference, false, 'a deviation is reported, not hidden');
  assert.equal(s10.matchesReference, true);
  assert.equal(conc(result, 0).launchers.A.outcome, 'timeout');
  const isolatedVerdict = (await runWorld({ mode: 'shared', overlap: 'no-window' })).result;
  assert.ok(ids(isolatedVerdict.failures).includes('CONC0_A_NOT_READY'));
});

test('control mode records the variant signatures a-lost-b-survives (A exits 0) and b-lost-a-survives but they ALONE do not pass it (a slow runner can fake them)', async () => {
  const single = { expect: 'shared', staggers: [{ nominalMs: 5000, from: 'wrapper-spawn' }] }; // launch order: baseline 1, A 2, B 3
  const variantA = (await runWorld({ exitBeforeReady: [2], exitCodes: { 2: 0 } }, single)).result;
  assert.equal(variantA.evidence.concurrency[0].observed.signature, 'a-lost-b-survives');
  assert.equal(variantA.exitCode, 1);
  assert.deepEqual(ids(variantA.failures), ['CONTROL_DEFECT_NOT_DETECTED']);
  assert.deepEqual([variantA.detection.supplementary, variantA.detection.structural, variantA.detection.any], [true, false, false]);
  const variantB = (await runWorld({ exitBeforeReady: [3] }, single)).result;
  assert.equal(variantB.evidence.concurrency[0].observed.signature, 'b-lost-a-survives');
  assert.deepEqual(ids(variantB.failures), ['CONTROL_DEFECT_NOT_DETECTED']);
  assert.match(variantB.failures[0].message, /supplementary/);
});

test('control mode FAILS (CONTROL_DEFECT_NOT_DETECTED) when only lost launches are seen: both-lost / a-exit-nonzero without a shared directory or shrinking runtime', async () => {
  const only0 = (await runWorld({ exitBeforeReady: [2, 3] }, { expect: 'shared', staggers: [{ nominalMs: 0, from: 'wrapper-spawn' }] })).result;
  assert.equal(only0.evidence.concurrency[0].observed.signature, 'both-lost');
  assert.equal(only0.exitCode, 1);
  assert.deepEqual(ids(only0.failures), ['CONTROL_DEFECT_NOT_DETECTED']);
  assert.deepEqual([only0.detection.supplementary, only0.detection.structural], [true, false]);
  // the early-overlap staggers of the OLD build alone (0 and 5000 ms) are not structural either
  const early = (await runWorld({ mode: 'shared' }, { expect: 'shared', staggers: [{ nominalMs: 0, from: 'wrapper-spawn' }, { nominalMs: 5000, from: 'wrapper-spawn' }] })).result;
  assert.deepEqual(early.evidence.concurrency.map((rec) => rec.observed.signature), ['both-lost', 'a-exit-nonzero-b-survives']);
  assert.equal(early.exitCode, 1);
  assert.deepEqual(ids(early.failures), ['CONTROL_DEFECT_NOT_DETECTED']);
  // ...while the structural stagger of the same old build is enough
  const late = (await runWorld({ mode: 'shared' }, { expect: 'shared', staggers: [{ nominalMs: 10000, from: 'main-seen' }] })).result;
  assert.equal(late.exitCode, 0, JSON.stringify(late.failures));
  assert.deepEqual([late.detection.structural, late.detection.any], [true, true]);
});

test('control mode: the structural signature (runDirShared or a shrinking runtime) is required even when every supplementary signature fires', async () => {
  const world = { mode: 'shared', gpuMainDies: true };
  const full = (await runWorld(world, { expect: 'shared' })).result;
  assert.equal(full.exitCode, 0);
  const evidence = structuredClone(full.evidence);
  for (const rec of evidence.concurrency) { rec.runDirShared = false; for (const key of ['afterAExit', 'afterAExitSettled']) if (rec[key]) rec[key].runDir = { exists: true, ...FULL }; }
  const verdict = check.analyze({ expect: 'shared', baseline: evidence.baseline, concurrency: evidence.concurrency, scenario2: evidence.scenario2, forcedKill: false });
  assert.deepEqual(ids(verdict.failures), ['CONTROL_DEFECT_NOT_DETECTED'], 'only both-lost / a-exit-nonzero / gpu-restart-damage remain');
  assert.deepEqual([verdict.detection.supplementary, verdict.detection.structural], [true, false]);
});

test('control mode is not vacuous: against a correctly isolated build --expect shared FAILS with CONTROL_DEFECT_NOT_DETECTED', async () => {
  const { result } = await runWorld({ mode: 'isolated' }, { expect: 'shared' });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(ids(result.failures), ['CONTROL_DEFECT_NOT_DETECTED']);
  assert.equal(result.detection.any, false);
  assert.deepEqual(result.evidence.concurrency.map((rec) => rec.observed.matchesReference), [false, false, false, false], 'the isolated build matches none of the old-defect signatures');
});

test('control mode does not mistake unrelated failures (A exit code, empty profile, window lost) for the old defect', async () => {
  for (const world of [{ exitCodes: { [L.c20000.A]: 3 } }, { profileNeverAppears: [L.c0.B] }, { onFinish: (w, wrapper) => { if (wrapper.index === L.c20000.A) w.mainOf(L.c20000.B).windowHandle = 0; } }]) {
    const { result } = await runWorld(world, { expect: 'shared' });
    assert.equal(result.exitCode, 1, JSON.stringify(world));
    assert.deepEqual(ids(result.failures), ['CONTROL_DEFECT_NOT_DETECTED']);
    assert.ok(result.evidence.concurrency.some((rec) => rec.observed.signature === 'other-failure'));
    assert.deepEqual([result.detection.supplementary, result.detection.structural], [false, false], 'an unrelated failure is neither structural nor supplementary evidence');
  }
});

test('control mode detects the defect from the removed runtime alone (distinct dirs, but A\'s exit shrinks B\'s runtime)', async () => {
  const { result } = await runWorld({ mode: 'isolated', damageOnCleanup: { from: L.c10000.A, victim: L.c10000.B } }, { expect: 'shared' });
  assert.equal(result.exitCode, 0);
  const rec = conc(result, 10000);
  assert.equal(rec.runDirShared, false);
  assert.equal(rec.observed.signature, 'shared-dir-runtime-shrinks');
});

test('control mode still fails a force-kill in the success path (never excused as an expected defect effect)', async () => {
  const { result } = await runWorld({ mode: 'shared', killOnClose: true }, { expect: 'shared' });
  assert.equal(result.exitCode, 1);
  assert.ok(ids(result.failures).includes('FORCED_KILL_IN_SUCCESS_PATH'));
});

test('control mode ignores a scenario-2 infrastructure problem only after the concurrency scenarios already detected the defect', async () => {
  const { world, result } = await runWorld({ mode: 'shared', spawnError: L.C }, { expect: 'shared' });
  assert.equal(result.exitCode, 0, JSON.stringify(result.failures));
  assert.ok(result.evidence.scenario2.infrastructureError.message.includes('could not start'));
  assert.equal(world.launches.length, L.C - 1, 'C was never started');
  const isolated = await runWorld({ mode: 'isolated', spawnError: L.C }, { expect: 'shared' });
  assert.equal(isolated.result.exitCode, 2, 'without a prior detection the same problem stays an infrastructure failure');
});

// ---------------------------------------------------------------------------------------------------------
// Baseline: a failing baseline is an infrastructure failure in BOTH modes
// ---------------------------------------------------------------------------------------------------------

for (const [name, world, pattern] of [
  ['the launch never becomes ready', { neverReady: [L.baseline] }, /no window appeared|not ready/],
  ['the launcher exits by itself before readiness', { exitBeforeReady: [L.baseline] }, /exited by itself \(code 1\)/],
  ['the launcher exits non-zero after a normal close', { exitCodes: { [L.baseline]: 3 } }, /exited with code 3/],
  ['no profile files are created', { profileNeverAppears: [L.baseline] }, /no profile files were created/],
  ['the runtime directory is not removed after the close', { leaveRuntime: [L.baseline] }, /runtime directory was not removed/],
]) {
  for (const mode of ['isolated', 'shared']) {
    test(`baseline failure (${name}) is exit 2 infrastructure-failure in ${mode === 'isolated' ? 'isolated' : 'control'} mode, never a detection or a pass`, async () => {
      const { world: fake, result } = await runWorld({ ...world, mode: mode === 'shared' ? 'shared' : 'isolated' }, { expect: mode, timeoutSec: 30 });
      assert.equal(result.exitCode, 2);
      assert.equal(result.verdict, 'infrastructure-failure');
      assert.deepEqual(result.failures, []);
      assert.match(result.evidence.infrastructureError.message, /baseline/);
      assert.match(result.evidence.infrastructureError.message, pattern);
      assert.equal(result.evidence.concurrency.length, 0, 'nothing else ran on top of a broken baseline');
      assert.equal(result.evidence.baseline.passed, false);
      assert.deepEqual(fake.aliveWrapperPids(), []);
      assert.equal(result.evidence.forcedKill, false);
    });
  }
}

test('baselineProblems is empty for a good baseline and names every reason otherwise', async () => {
  const good = (await passingEvidence()).baseline;
  assert.deepEqual(check.baselineProblems(good), []);
  const bad = structuredClone(good);
  bad.close.exitCode = 1;
  bad.close.cleanup.runDirRemoved = false;
  bad.instance.profile = { exists: true, files: 0, bytes: 0 };
  assert.equal(check.baselineProblems(bad).length, 3);
  assert.deepEqual(check.baselineProblems(null), ['the baseline scenario did not run']);
  assert.match(check.baselineProblems({ launcher: { outcome: 'exited', exitCode: 1, elapsedMs: 5 } })[0], /exited by itself \(code 1\)/);
});

// ---------------------------------------------------------------------------------------------------------
// Isolated mode: precise failures
// ---------------------------------------------------------------------------------------------------------

test('a launcher that exits by itself before readiness fails (CONC5000_A_EXITED_BEFORE_READY) with exit code and elapsed time recorded', async () => {
  const { result } = await runWorld({ exitBeforeReady: [L.c5000.A] });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(ids(result.failures), ['CONC5000_A_EXITED_BEFORE_READY']);
  const launcher = conc(result, 5000).launchers.A;
  assert.deepEqual([launcher.outcome, launcher.exitCode], ['exited', 1]);
  assert.equal(launcher.elapsedMs, 1000);
  assert.equal(conc(result, 5000).observed.signature, 'a-exit-nonzero-b-survives');
  assert.equal(conc(result, 20000).observed.signature, 'isolated-ok', 'the other scenarios are judged on their own');
});

test('a profile that never appears fails (CONC0_B_PROFILE_EMPTY) even though the window is there', async () => {
  const { result } = await runWorld({ profileNeverAppears: [L.c0.B] });
  assert.deepEqual(ids(result.failures), ['CONC0_B_PROFILE_EMPTY']);
  assert.equal(conc(result, 0).B.profile.exists, false);
});

test('an instance without a window within the timeout fails (CONC10000_B_NOT_READY) although its launcher is still alive', async () => {
  const { result } = await runWorld({ neverReady: [L.c10000.B] }, { timeoutSec: 30 });
  assert.ok(ids(result.failures).includes('CONC10000_B_NOT_READY'));
  assert.equal(conc(result, 10000).launchers.B.outcome, 'timeout');
  assert.equal(result.exitCode, 1, 'a hung launch after a passing baseline is a failed assertion, not infrastructure');
});

test('A exiting with a non-zero code after its normal close fails (CONC20000_A_EXIT_CODE)', async () => {
  const { result } = await runWorld({ exitCodes: { [L.c20000.A]: 3 } });
  assert.deepEqual(ids(result.failures), ['CONC20000_A_EXIT_CODE']);
  assert.match(result.failures[0].message, /code 3/);
});

test('B exiting with a non-zero code fails (CONC20000_B_EXIT_CODE)', async () => {
  const { result } = await runWorld({ exitCodes: { [L.c20000.B]: 1 } });
  assert.deepEqual(ids(result.failures), ['CONC20000_B_EXIT_CODE']);
});

test('a force-kill anywhere in the success path fails (FORCED_KILL_IN_SUCCESS_PATH) and is recorded as forcedKill=true', async () => {
  const { result } = await runWorld({ killOnClose: true });
  assert.equal(result.exitCode, 1);
  assert.ok(ids(result.failures).includes('FORCED_KILL_IN_SUCCESS_PATH'));
  assert.equal(result.evidence.forcedKill, true);
});

test('B no longer Responding / windowless / dead after A exits fails (CONC20000_B_NOT_RESPONDING / _WINDOW_LOST / _MAIN_DEAD)', async () => {
  const hit = (apply) => ({ onFinish: (world, wrapper) => { if (wrapper.index === L.c20000.A) apply(world.mainOf(L.c20000.B), world); } });
  assert.ok(ids((await runWorld(hit((main) => { main.responding = false; }))).result.failures).includes('CONC20000_B_NOT_RESPONDING'));
  assert.ok(ids((await runWorld(hit((main) => { main.windowHandle = 0; }))).result.failures).includes('CONC20000_B_WINDOW_LOST'));
  assert.ok(ids((await runWorld(hit((main, world) => { world.killWithChildren(main.pid); }))).result.failures).includes('CONC20000_B_MAIN_DEAD'));
});

test('B losing its renderer (window-less session) after A exits fails (CONC20000_B_RENDERER_LOST)', async () => {
  const { result } = await runWorld({
    windowless: true,
    onFinish: (world, wrapper) => {
      if (wrapper.index !== L.c20000.A) return;
      const main = world.mainOf(L.c20000.B);
      for (const proc of world.procs.values()) if (proc.type === 'renderer' && proc.ppid === main.pid) proc.alive = false;
    },
  });
  assert.ok(ids(result.failures).includes('CONC20000_B_RENDERER_LOST'), ids(result.failures).join());
});

test('B\'s runtime shrinking although the directories differ fails (CONC20000_B_RUNTIME_CHANGED_IMMEDIATE), with exact numbers', async () => {
  const { result } = await runWorld({ damageOnCleanup: { from: L.c20000.A, victim: L.c20000.B } });
  assert.equal(result.exitCode, 1);
  const failure = result.failures.find((item) => item.id === 'CONC20000_B_RUNTIME_CHANGED_IMMEDIATE');
  assert.ok(failure);
  assert.match(failure.message, /78 files \/ 503557201 B.*7 files \/ 366521134 B/);
});

test('B\'s start touching A\'s runtime fails while both run (CONC10000_A_RUNTIME_CHANGED_BOTH_RUNNING)', async () => {
  const { result } = await runWorld({ touchOnLaunch: { launch: L.c10000.B, victim: L.c10000.A } });
  assert.ok(ids(result.failures).includes('CONC10000_A_RUNTIME_CHANGED_BOTH_RUNNING'), ids(result.failures).join());
});

test('A\'s extraction directory or NSIS parent surviving its normal exit fails (cleanup assertions)', async () => {
  const left = await runWorld({ leaveRuntime: [L.c20000.A] });
  assert.ok(ids(left.result.failures).includes('CONC20000_A_RUNDIR_NOT_REMOVED'));
  const parent = await runWorld({ leaveNsParent: [L.c20000.B] });
  assert.ok(ids(parent.result.failures).includes('CONC20000_B_NSIS_PARENT_NOT_REMOVED'));
  assert.equal(ids(parent.result.failures).includes('CONC20000_B_RUNDIR_NOT_REMOVED'), false);
});

test('A ignoring the normal close is a failed assertion (CONC0_A_NOT_EXITED), the next scenarios still run, and the cleanup kills only our wrappers', async () => {
  const world = new FakeWindows({ ignoreClose: [L.c0.A] });
  const stranger = world.addForeignMain();
  const result = await check.run(baseOptions({ timeoutSec: 20 }), world);
  assert.equal(result.exitCode, 1);
  assert.ok(ids(result.failures).includes('CONC0_A_NOT_EXITED'));
  assert.equal(conc(result, 20000).observed.signature, 'isolated-ok');
  assert.equal(result.evidence.forcedKill, false, 'the success path itself never killed anything');
  assert.ok(world.kills.length >= 2, 'A and B of that scenario were killed by its cleanup');
  const ours = new Set(world.launches.map((wrapper) => wrapper.pid));
  assert.ok(world.kills.every((kill) => ours.has(kill.pid)), 'only wrapper trees this run started are killed');
  assert.equal(stranger.alive, true, 'a TRACE process the check did not start is never touched');
  assert.deepEqual(world.aliveWrapperPids(), []);
});

// ---------------------------------------------------------------------------------------------------------
// GPU-restart injection
// ---------------------------------------------------------------------------------------------------------

test('GPU restart (injected): exactly one verified gpu-process of B\'s own main is terminated, a NEW gpu pid appears, B stays alive/Responding/windowed with unchanged runtime', async () => {
  const { world, result } = await runWorld();
  const g = conc(result, 20000).gpuRestart;
  assert.equal(g.injected, true);
  assert.equal(g.performed, true);
  assert.equal(g.respawned, true);
  assert.equal(g.pidsBefore.length, 1);
  assert.equal(g.targetPid, g.pidsBefore[0]);
  assert.equal(g.newPids.length, 1);
  assert.ok(!g.pidsBefore.includes(g.newPids[0]), 'a NEW pid, not the terminated one');
  assert.deepEqual(world.injectedKills.map((kill) => [kill.pid, kill.rootPid, kill.type]), [[g.targetPid, g.mainPid, 'gpu-process']]);
  assert.equal(g.after.proc.mainAlive, true);
  assert.equal(g.after.proc.responding, true);
  assert.ok(g.after.proc.windowHandle > 0);
  assert.deepEqual(g.after.runDir, { exists: true, ...FULL });
  assert.deepEqual(g.afterSettled.runDir, { exists: true, ...FULL });
  assert.deepEqual(world.kills, [], 'the injected termination is not a forced kill of the success path');
  assert.equal(result.evidence.forcedKill, false);
});

for (const [name, world, id] of [
  ['no gpu-process child at all', { noGpuProcess: true }, 'CONC20000_GPU_PROCESS_NOT_FOUND'],
  ['the termination is refused', { gpuTerminateFails: true }, 'CONC20000_GPU_KILL_NOT_PERFORMED'],
  ['Electron does not respawn the gpu-process', { gpuNoRespawn: true }, 'CONC20000_GPU_NOT_RESPAWNED'],
  ['B dies after the GPU restart', { gpuMainDies: true }, 'CONC20000_GPU_B_MAIN_DEAD'],
  ['B\'s runtime shrinks after the GPU restart', { gpuDamagesRuntime: true }, 'CONC20000_GPU_B_RUNTIME_CHANGED_AFTER_GPU'],
]) {
  test(`GPU restart: ${name} fails the isolated mode (${id})`, async () => {
    const { result } = await runWorld(world);
    assert.equal(result.exitCode, 1);
    assert.ok(ids(result.failures).includes(id), `${id} missing from ${ids(result.failures).join()}`);
  });
}

test('GPU restart in control mode: B dying / no respawn / damaged runtime is RECORDED (gpu-restart-damage, supplementary) but cannot pass the control without the structural signature', async () => {
  const single = { expect: 'shared', staggers: [{ nominalMs: 20000, from: 'main-seen' }] };
  for (const world of [{ gpuMainDies: true }, { gpuNoRespawn: true }, { gpuDamagesRuntime: true }]) {
    const { result } = await runWorld(world, single); // distinct directories: no structural signature
    const rec = result.evidence.concurrency[0];
    assert.equal(rec.observed.signature, 'gpu-restart-damage', JSON.stringify(world));
    assert.ok(rec.observed.indicators.some((text) => /GPU restart/.test(text)));
    assert.deepEqual([result.detection.supplementary, result.detection.structural, result.exitCode], [true, false, 1], JSON.stringify(world));
    assert.deepEqual(ids(result.failures), ['CONTROL_DEFECT_NOT_DETECTED']);
  }
  const clean = await runWorld({}, single);
  assert.equal(clean.result.exitCode, 1, 'a clean GPU respawn is not a defect signature');
  assert.equal(clean.result.detection.supplementary, false);
  const shared = await runWorld({ mode: 'shared' }, single);
  assert.equal(shared.result.exitCode, 0, 'with the structural signature the GPU damage is additional recorded evidence');
  assert.equal(shared.result.evidence.concurrency[0].gpuRestart.after.proc.mainAlive, false);
});

test('GPU restart terminates EXACTLY one gpu-process (the other stays) and a surviving old gpu pid is not mistaken for a respawn', async () => {
  const both = await runWorld({ twoGpuProcesses: true });
  const g = conc(both.result, 20000).gpuRestart;
  assert.equal(g.pidsBefore.length, 2);
  assert.equal(both.world.injectedKills.length, 1, 'exactly one process terminated');
  assert.equal(g.targetPid, g.pidsBefore[0]);
  assert.equal(g.newPids.length, 1);
  assert.ok(g.pidsAfter.includes(g.pidsBefore[1]) && g.pidsAfter.includes(g.newPids[0]) && !g.pidsAfter.includes(g.targetPid));
  assert.equal(both.result.verdict, 'pass');
  const stuck = await runWorld({ twoGpuProcesses: true, gpuNoRespawn: true });
  assert.ok(ids(stuck.result.failures).includes('CONC20000_GPU_NOT_RESPAWNED'), 'the remaining old gpu-process is not a NEW pid');
  assert.deepEqual(conc(stuck.result, 20000).gpuRestart.newPids, []);
});

test('GPU restart is skipped only visibly: B\'s main gone before the injection fails with CONC20000_GPU_SKIPPED, not silently', async () => {
  const { result } = await runWorld({ onFinish: (world, wrapper) => { if (wrapper.index === L.c20000.A) world.killWithChildren(world.mainOf(L.c20000.B).pid); } });
  assert.ok(ids(result.failures).includes('CONC20000_GPU_SKIPPED'), ids(result.failures).join());
  assert.ok(ids(result.failures).includes('CONC20000_B_MAIN_DEAD'));
});

test('verifyTerminationTarget accepts only a gpu-process below the expected main (parent chain + command-line type), never main, renderer or a foreign process', () => {
  const records = check.parseProcessJson(JSON.stringify([
    { pid: 10, ppid: 1, name: MAIN, exe: 'C:\\t\\nsk1A2.tmp\\app\\TRACE Boardviewer.exe', type: '', windowHandle: 5, responding: true },
    { pid: 11, ppid: 10, name: MAIN, exe: 'C:\\t\\nsk1A2.tmp\\app\\TRACE Boardviewer.exe', type: 'gpu-process' },
    { pid: 12, ppid: 10, name: MAIN, exe: 'C:\\t\\nsk1A2.tmp\\app\\TRACE Boardviewer.exe', type: 'renderer' },
    { pid: 20, ppid: 2, name: MAIN, exe: 'D:\\other\\TRACE Boardviewer.exe', type: '' },
    { pid: 21, ppid: 20, name: MAIN, exe: 'D:\\other\\TRACE Boardviewer.exe', type: 'gpu-process' },
    { pid: 30, ppid: 10, name: 'notepad.exe', exe: 'C:\\Windows\\notepad.exe', type: 'gpu-process' },
  ]));
  const target = (pid, rootPid = 10) => check.verifyTerminationTarget(records, pid, { rootPid, type: 'gpu-process' });
  assert.equal(target(11).ok, true);
  assert.match(target(10).reason, /not gpu-process/);
  assert.match(target(12).reason, /renderer/);
  assert.match(target(21).reason, /not a descendant of 10/);
  assert.match(target(30).reason, /notepad\.exe/);
  assert.equal(target(999).reason, 'process not found');
  assert.equal(target(11, 20).ok, false, 'wrong root');
  assert.equal(target(-1).reason, 'invalid pid');
});

// ---------------------------------------------------------------------------------------------------------
// Scenario 2: second-instance forwarding
// ---------------------------------------------------------------------------------------------------------

test('D not exiting by itself fails (S2_D_NOT_SELF_EXIT) without the check force-killing it; only the cleanup kills', async () => {
  const world = new FakeWindows({ dStaysRunning: true });
  const result = await check.run(baseOptions({ timeoutSec: 20 }), world);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(ids(result.failures), ['S2_D_NOT_SELF_EXIT']);
  assert.equal(result.evidence.forcedKill, false);
  const cleanup = result.evidence.cleanup.find((entry) => entry.scenario === 'second-instance');
  assert.ok(cleanup.killedPids.length >= 2, 'C and D are killed by the cleanup, after the verdict data was recorded');
  assert.deepEqual(world.aliveWrapperPids(), []);
});

test('D exiting non-zero fails (S2_D_EXIT_CODE)', async () => {
  const { result } = await runWorld({ exitCodes: { [L.D]: 1 } });
  assert.deepEqual(ids(result.failures), ['S2_D_EXIT_CODE']);
});

test('D\'s cleanup damaging C\'s runtime fails (S2_C_RUNTIME_CHANGED_IMMEDIATE)', async () => {
  const { result } = await runWorld({ damageOnCleanup: { from: L.D, victim: L.C } });
  assert.equal(result.exitCode, 1);
  assert.ok(ids(result.failures).includes('S2_C_RUNTIME_CHANGED_IMMEDIATE'), ids(result.failures).join());
});

test('C no longer Responding / windowless after D finished fails (S2_C_NOT_RESPONDING / S2_C_WINDOW_LOST)', async () => {
  const { result } = await runWorld({ onFinish: (world, wrapper) => { if (wrapper.index === L.D) { world.mainOf(L.C).responding = false; world.mainOf(L.C).windowHandle = 0; } } });
  assert.ok(ids(result.failures).includes('S2_C_NOT_RESPONDING'), ids(result.failures).join());
  assert.ok(ids(result.failures).includes('S2_C_WINDOW_LOST'), ids(result.failures).join());
});

test('D leaving its extraction behind fails (S2_D_RUNDIR_NOT_REMOVED + S2_D_LEFTOVER_DIRS)', async () => {
  const { result } = await runWorld({ leaveRuntime: [L.D] });
  assert.ok(ids(result.failures).includes('S2_D_RUNDIR_NOT_REMOVED'));
  assert.ok(ids(result.failures).includes('S2_D_LEFTOVER_DIRS'));
});

test('a too-short-lived D is judged by the leftover scan: an unobserved leftover extraction still fails (S2_D_LEFTOVER_DIRS)', async () => {
  const clean = await runWorld({ dMainInvisible: true });
  assert.equal(clean.result.verdict, 'pass');
  assert.equal(clean.result.evidence.scenario2.D.runDir, null);
  assert.ok(clean.result.observations.some((item) => item.id === 'S2_D_RUNDIR_UNOBSERVED'));
  const dirty = await runWorld({ dMainInvisible: true, leaveRuntime: [L.D] });
  assert.deepEqual(ids(dirty.result.failures), ['S2_D_LEFTOVER_DIRS']);
});

test('C\'s own cleanup after scenario 2 must exit 0 and remove its runtime (S2_C_EXIT_CODE / S2_C_RUNDIR_NOT_REMOVED)', async () => {
  const code = await runWorld({ exitCodes: { [L.C]: 9 } });
  assert.deepEqual(ids(code.result.failures), ['S2_C_EXIT_CODE']);
  const left = await runWorld({ leaveRuntime: [L.C] });
  assert.deepEqual(ids(left.result.failures), ['S2_C_RUNDIR_NOT_REMOVED', 'S2_C_NSIS_PARENT_NOT_REMOVED'], 'the plugin directory cannot go while its app directory remains');
});

// ---------------------------------------------------------------------------------------------------------
// Infrastructure failures are exit 2, never a pass
// ---------------------------------------------------------------------------------------------------------

test('a spawn error in a concurrency launch, a missing EXE, failing PowerShell snapshots and an exhausted time budget are all exit 2', async () => {
  const spawn = (await runWorld({ spawnError: L.c5000.B })).result;
  assert.equal(spawn.exitCode, 2);
  assert.match(spawn.evidence.infrastructureError.message, /could not start the portable EXE/);
  const missing = (await runWorld({ missingExe: true })).result;
  assert.equal(missing.exitCode, 2);
  assert.match(missing.evidence.infrastructureError.message, /cannot read the portable EXE/);
  const blind = await runWorld({ snapshotFails: true }, { timeoutSec: 10 });
  assert.equal(blind.result.exitCode, 2);
  assert.match(blind.result.evidence.infrastructureError.message, /process snapshot failed twice \(powershell\.exe failed/);
  const slow = await runWorld({}, { maxTotalSec: 40 });
  assert.equal(slow.result.exitCode, 2);
  assert.match(slow.result.evidence.infrastructureError.message, /global time budget of 40 s exhausted/);
});

test('cleanup after an infrastructure failure kills only our wrappers and removes only this run\'s extraction directories and temp areas', async () => {
  const world = new FakeWindows({ neverReady: [L.baseline] });
  const stranger = world.addForeignMain();
  world.setDir(`${TEMP}\\nsq7C1.tmp\\app`, FULL); // somebody else's extraction
  const result = await check.run(baseOptions({ timeoutSec: 20 }), world);
  assert.equal(result.exitCode, 2);
  assert.equal(stranger.alive, true);
  assert.equal(await world.exists(`${TEMP}\\nsq7C1.tmp\\app`), true);
  assert.equal(await world.exists(world.launches[0].nsisParent), false);
  assert.deepEqual(world.removedTrees, [world.launches[0].nsisParent]);
  assert.deepEqual(world.kills.map((kill) => kill.pid), [world.launches[0].pid]);
  assert.deepEqual(world.removedAreas, world.areas);
  assert.equal(result.evidence.forcedKill, false, 'a cleanup kill after a failure is not a success-path force-kill');
});

test('an unexpected internal error is exit 2 with the stack in the evidence, not a pass', async () => {
  const world = new FakeWindows();
  world.canonicalize = async () => { throw new Error('boom'); };
  const result = await check.run(baseOptions(), world);
  assert.equal(result.exitCode, 2);
  assert.match(result.evidence.infrastructureError.message, /unexpected Error.*boom/s);
});

// ---------------------------------------------------------------------------------------------------------
// JSON parsing of PowerShell output
// ---------------------------------------------------------------------------------------------------------

const row = (overrides = {}) => ({ pid: 100, ppid: 50, name: MAIN, exe: 'C:\\Temp\\nsk1A2.tmp\\app\\TRACE Boardviewer.exe', type: '', windowHandle: 0, responding: true, ...overrides });

test('parseProcessJson: a single object (ConvertTo-Json of one process) becomes a one-element list', () => {
  const list = check.parseProcessJson(JSON.stringify(row()));
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], row());
});

test('parseProcessJson: an array keeps order and every record', () => {
  const list = check.parseProcessJson(JSON.stringify([row({ pid: 1 }), row({ pid: 2, type: 'renderer' })]));
  assert.deepEqual(list.map((item) => item.pid), [1, 2]);
  assert.equal(list[1].type, 'renderer');
});

test('parseProcessJson: empty output, whitespace, "null" and "[]" all mean "no processes" (empty list), BOM tolerated', () => {
  for (const text of ['', '   \r\n', 'null', '[]', '\uFEFF[]', undefined, null]) assert.deepEqual(check.parseProcessJson(text), [], JSON.stringify(text));
});

test('parseProcessJson: a null ExecutablePath (access denied) stays null and is never turned into a path', () => {
  const [item] = check.parseProcessJson(JSON.stringify([row({ exe: null })]));
  assert.equal(item.exe, null);
  const [missing] = check.parseProcessJson('{"pid":7,"ppid":1,"name":"TRACE Boardviewer.exe"}');
  assert.equal(missing.exe, null);
  assert.equal(missing.responding, null);
  assert.equal(missing.windowHandle, 0);
});

test('parseProcessJson: backslashes and spaces in paths (TRACE Boardviewer.exe) survive the JSON round trip', () => {
  const exe = 'C:\\Users\\John Doe\\AppData\\Local\\Temp\\nsA1B2.tmp\\app\\TRACE Boardviewer.exe';
  const [item] = check.parseProcessJson(`[{"pid":9,"ppid":3,"name":"TRACE Boardviewer.exe","exe":${JSON.stringify(exe)},"type":"","windowHandle":131072,"responding":true}]`);
  assert.equal(item.exe, exe);
  assert.equal(item.windowHandle, 131072);
});

test('parseProcessJson: Windows PowerShell 5.1 shapes ({"value":[...],"Count":n} wrapper, IntPtr {"value":n}, raw Win32_Process names) are normalised', () => {
  const wrapped = check.parseProcessJson(JSON.stringify({ value: [row({ pid: 5 }), row({ pid: 6 })], Count: 2 }));
  assert.deepEqual(wrapped.map((item) => item.pid), [5, 6]);
  const [intPtr] = check.parseProcessJson('[{"pid":5,"ppid":1,"name":"x","windowHandle":{"value":4242},"responding":false}]');
  assert.equal(intPtr.windowHandle, 4242);
  assert.equal(intPtr.responding, false);
  const [raw] = check.parseProcessJson('[{"ProcessId":12,"ParentProcessId":4,"Name":"TRACE Boardviewer.exe","ExecutablePath":"C:\\\\x\\\\TRACE Boardviewer.exe"}]');
  assert.deepEqual([raw.pid, raw.ppid, raw.exe], [12, 4, 'C:\\x\\TRACE Boardviewer.exe']);
});

test('parseProcessJson: output that is not JSON throws instead of silently reading as an empty (healthy-looking) snapshot', () => {
  assert.throws(() => check.parseProcessJson('Get-CimInstance : Access denied'), check.ProcessJsonError);
  assert.deepEqual(check.parseProcessJson('[1, "x", null, {"pid": 3, "ppid": 1, "name": "n"}]').map((item) => item.pid), [3], 'non-object junk entries are dropped');
});

// ---------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------

test('classifyRuntimeDir recognises the per-launch NSIS plugin directory (case-insensitive, spaces, trailing slash)', () => {
  const nsis = check.classifyRuntimeDir('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\nsA1B2.tmp\\app\\');
  assert.equal(nsis.kind, 'per-launch-nsis');
  assert.equal(nsis.nsisParent, 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\nsA1B2.tmp');
  assert.equal(check.classifyRuntimeDir('c:\\users\\john doe\\appdata\\local\\temp\\NSK58a3.TMP\\APP').kind, 'per-launch-nsis');
  // names observed on real windows-latest runs: ns + ONE letter + hex
  for (const leaf of ['nseC3BF', 'nsj1138', 'nsgAF3D', 'nsk58A3', 'nsmBEC3', 'nsk3F2']) {
    assert.equal(check.classifyRuntimeDir(`C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\${leaf}.tmp\\app`).kind, 'per-launch-nsis', leaf);
    assert.match(`${leaf}.tmp`, check.NSIS_PARENT_RE);
  }
});

test('classifyRuntimeDir flags a fixed %TEMP% subdirectory (the shared-directory defect) and refuses to call anything else isolated', () => {
  const fixed = check.classifyRuntimeDir('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\trace-control-shared');
  assert.equal(fixed.kind, 'fixed-temp-subdir');
  assert.equal(fixed.nsisParent, null);
  assert.equal(check.classifyRuntimeDir('D:\\Work\\Temp2\\trace', 'D:\\Work\\Temp2').kind, 'fixed-temp-subdir');
  assert.equal(check.classifyRuntimeDir('D:\\Apps\\TRACE').kind, 'other');
  assert.equal(check.classifyRuntimeDir('C:\\Temp\\nsk12.tmp\\notapp').kind, 'other', 'only <nsXXXX.tmp>\\app is the per-launch layout');
  assert.equal(check.classifyRuntimeDir('C:\\Temp\\ns12.tmp\\app').kind, 'other', 'ns + digits only (no letter) is not the NSIS plugin directory form');
  assert.equal(check.classifyRuntimeDir('C:\\Temp\\nsZZ.tmp\\app').kind, 'other', 'ns + letter + non-hex is not an NSIS plugin directory');
  assert.equal(check.classifyRuntimeDir('C:\\Temp\\nsk.tmp\\app').kind, 'other', 'ns + letter without any hex digit');
  assert.equal(check.NSIS_PARENT_RE.test('ns12.tmp'), false);
  assert.equal(check.classifyRuntimeDir(null).kind, 'other');
});

test('samePath / isInside compare Windows paths case-insensitively and ignore trailing separators', () => {
  assert.equal(check.samePath('C:\\Temp\\NSA.tmp\\app', 'c:\\temp\\nsa.tmp\\app\\'), true);
  assert.equal(check.samePath('C:\\Temp\\a', 'C:\\Temp\\b'), false);
  assert.equal(check.samePath(null, 'C:\\x'), false);
  assert.equal(check.isInside('C:\\Temp\\nsA.tmp\\app\\x.exe', 'c:\\temp\\nsa.tmp'), true);
  assert.equal(check.isInside('C:\\Temp\\nsA.tmpx\\app', 'C:\\Temp\\nsA.tmp'), false);
  assert.equal(check.isInside('C:\\Temp', 'C:\\Temp'), false);
});

test('isReady: a window handle proves readiness at once; renderers alone need the minimum settle time', () => {
  const main = check.parseProcessJson(JSON.stringify([row({ pid: 10, ppid: 9 })]));
  assert.equal(check.isReady(main, 9).ready, false);
  assert.equal(check.isReady(main, 8).reason, 'main process not started yet');
  const windowed = check.parseProcessJson(JSON.stringify([row({ pid: 10, ppid: 9, windowHandle: 55 })]));
  assert.deepEqual([check.isReady(windowed, 9).ready, check.isReady(windowed, 9).mode], [true, 'handle']);
  const rendered = check.parseProcessJson(JSON.stringify([row({ pid: 10, ppid: 9 }), row({ pid: 11, ppid: 10, type: 'renderer' })]));
  assert.equal(check.isReady(rendered, 9, { sinceMainMs: 5000, minSettleMs: 15000 }).ready, false);
  assert.deepEqual([check.isReady(rendered, 9, { sinceMainMs: 15000, minSettleMs: 15000 }).ready, check.isReady(rendered, 9, { sinceMainMs: 15000, minSettleMs: 15000 }).mode], [true, 'renderer-fallback']);
  const unreadable = check.parseProcessJson(JSON.stringify([row({ pid: 10, ppid: 9, exe: null, windowHandle: 5 })]));
  assert.equal(check.isReady(unreadable, 9).ready, false, 'without a readable ExecutablePath no runtime directory can be derived');
});

test('findMainProcess ignores other TRACE instances and Chromium children of the wrapper PID', () => {
  const records = check.parseProcessJson(JSON.stringify([row({ pid: 1, ppid: 500 }), row({ pid: 2, ppid: 9, type: 'gpu-process' }), row({ pid: 3, ppid: 9 })]));
  assert.equal(check.findMainProcess(records, 9).pid, 3);
  assert.equal(check.findMainProcess(records, 777), null);
});

test('inspectInstance lists the gpu-process pids below the main process and does not mistake a reused PID with another executable path for the instance', () => {
  const records = check.parseProcessJson(JSON.stringify([row({ pid: 10 }), row({ pid: 12, ppid: 10, type: 'gpu-process' }), row({ pid: 11, ppid: 10, type: 'gpu-process' }), row({ pid: 13, ppid: 10, type: 'renderer' })]));
  const proc = check.inspectInstance(records, { mainPid: 10, mainExe: 'C:\\Temp\\nsk1A2.tmp\\app\\TRACE Boardviewer.exe' });
  assert.deepEqual([proc.mainAlive, proc.gpuPids, proc.rendererCount], [true, [11, 12], 1]);
  assert.equal(check.inspectInstance(records, { mainPid: 10, mainExe: 'D:\\elsewhere\\TRACE Boardviewer.exe' }).mainAlive, false);
  assert.equal(check.inspectInstance(records, { mainPid: 10, mainExe: 'c:\\TEMP\\nsk1A2.tmp\\APP\\trace boardviewer.exe' }).mainAlive, true);
});

test('observedSignature names each situation (and only claims early-overlap names when the baseline passed)', () => {
  const ready = { outcome: 'ready' };
  const exited = (exitCode) => ({ outcome: 'exited', exitCode, elapsedMs: 3000 });
  assert.equal(check.observedSignature({ launchers: { A: exited(0), B: exited(0) } }).name, 'both-lost');
  assert.equal(check.observedSignature({ launchers: { A: { outcome: 'timeout' }, B: { outcome: 'timeout' } } }).name, 'both-lost');
  assert.equal(check.observedSignature({ launchers: { A: exited(1), B: ready } }).name, 'a-exit-nonzero-b-survives');
  assert.equal(check.observedSignature({ launchers: { A: exited(0), B: ready } }).name, 'a-lost-b-survives');
  assert.equal(check.observedSignature({ launchers: { A: ready, B: exited(1) } }).name, 'b-lost-a-survives');
  assert.equal(check.observedSignature({ launchers: { A: ready, B: ready }, runDirShared: true, A: { runDir: 'X' } }).name, 'shared-dir-runtime-shrinks');
  assert.equal(check.observedSignature({ launchers: { A: ready, B: ready }, runDirShared: false }, { issueCount: 2 }).name, 'other-failure');
  assert.equal(check.observedSignature({ launchers: { A: ready, B: ready }, runDirShared: false }).name, 'isolated-ok');
  assert.equal(check.observedSignature({ launchers: { A: exited(1), B: ready } }, { baselineOk: false, issueCount: 1 }).name, 'other-failure', 'no defect is attributed when the baseline did not pass');
  assert.deepEqual(check.DEFECT_SIGNATURES.includes('isolated-ok') || check.DEFECT_SIGNATURES.includes('other-failure'), false);
});

test('parseArgs: defaults (four staggers), both flag spellings, --staggers/--max-total-sec and every usage error', () => {
  const defaults = check.parseArgs(['--exe', 'a.exe']);
  assert.deepEqual([defaults.exe, defaults.expect, defaults.out, defaults.timeoutSec, defaults.maxTotalSec, defaults.help], ['a.exe', 'isolated', 'portable-isolation-evidence.json', 120, 1500, false]);
  assert.deepEqual(defaults.staggers, [
    { nominalMs: 0, from: 'wrapper-spawn' }, { nominalMs: 5000, from: 'wrapper-spawn' }, { nominalMs: 10000, from: 'main-seen' }, { nominalMs: 20000, from: 'main-seen' },
  ]);
  const full = check.parseArgs(['--exe=b.exe', '--expect', 'shared', '--out', 'e.json', '--timeout-sec=45', '--max-total-sec', '900', '--staggers', '0,main:7000']);
  assert.deepEqual([full.exe, full.expect, full.out, full.timeoutSec, full.maxTotalSec], ['b.exe', 'shared', 'e.json', 45, 900]);
  assert.deepEqual(full.staggers, [{ nominalMs: 0, from: 'wrapper-spawn' }, { nominalMs: 7000, from: 'main-seen' }]);
  for (const bad of [[], ['--exe'], ['--exe', 'a', '--expect', 'maybe'], ['--exe', 'a', '--timeout-sec', '0'], ['--exe', 'a', '--timeout-sec', 'abc'], ['--exe', 'a', '--nope'],
    ['--exe', 'a', '--staggers', '5,5'], ['--exe', 'a', '--staggers', 'x'], ['--exe', 'a', '--staggers', ''], ['--exe', 'a', '--max-total-sec', '-1']]) {
    assert.throws(() => check.parseArgs(bad), check.UsageError, JSON.stringify(bad));
  }
  assert.equal(check.parseArgs(['--help']).help, true);
});

test('the synthetic board is an original, tiny, ASCII, section-balanced GENCAD 1.4 text', () => {
  const text = check.SYNTHETIC_BOARD;
  const lines = text.trimEnd().split('\n');
  assert.ok(lines.length <= 40, `${lines.length} lines`);
  assert.match(text, /\nGENCAD 1\.4\n/);
  assert.match(text, /^[\x09\x0A\x20-\x7E]+$/);
  const opened = lines.filter((line) => /^\$(?!END)[A-Z]+$/.test(line)).map((line) => line.slice(1));
  const closed = lines.filter((line) => /^\$END[A-Z]+$/.test(line)).map((line) => line.slice(4));
  assert.deepEqual(opened, closed);
  for (const required of ['HEADER', 'SHAPES', 'COMPONENTS']) assert.ok(opened.includes(required), required);
});

// ---------------------------------------------------------------------------------------------------------
// analyze(): each decision on its own, derived from a recorded passing run
// ---------------------------------------------------------------------------------------------------------

const c20 = (e) => e.concurrency[3];
const c0 = (e) => e.concurrency[0];
const mutations = [
  ['A exit code', (e) => { c20(e).aClose.exitCode = 1; }, 'CONC20000_A_EXIT_CODE'],
  ['A signal-terminated (null exit code)', (e) => { c20(e).aClose.exitCode = null; c20(e).aClose.signal = 'SIGKILL'; }, 'CONC20000_A_EXIT_CODE'],
  ['A never exited', (e) => { c20(e).aClose.exited = false; }, 'CONC20000_A_NOT_EXITED'],
  ['A close request not delivered', (e) => { c20(e).aClose.delivered = false; }, 'CONC20000_A_CLOSE_NOT_DELIVERED'],
  ['A runtime not removed', (e) => { c20(e).aClose.cleanup.runDirRemoved = false; c20(e).aClose.cleanup.remaining = ['x']; }, 'CONC20000_A_RUNDIR_NOT_REMOVED'],
  ['A NSIS parent not removed', (e) => { c20(e).aClose.cleanup.nsisParentRemoved = false; }, 'CONC20000_A_NSIS_PARENT_NOT_REMOVED'],
  ['A/B share one directory', (e) => { c20(e).runDirShared = true; }, 'CONC20000_RUNDIR_SHARED'],
  ['A empty baseline', (e) => { c20(e).A.baseline = { exists: true, files: 0, bytes: 0 }; }, 'CONC20000_A_BASELINE_EMPTY'],
  ['B missing baseline', (e) => { c20(e).B.baseline = { exists: false, files: 0, bytes: 0 }; }, 'CONC20000_B_BASELINE_EMPTY'],
  ['A runtime changed while both run', (e) => { c20(e).bothRunning.A.runDir.files -= 1; }, 'CONC20000_A_RUNTIME_CHANGED_BOTH_RUNNING'],
  ['B runtime changed while both run', (e) => { c20(e).bothRunning.B.runDir.bytes += 1; }, 'CONC20000_B_RUNTIME_CHANGED_BOTH_RUNNING'],
  ['A window gone while both run', (e) => { c20(e).bothRunning.A.proc.windowHandle = 0; }, 'CONC20000_A_WINDOW_LOST'],
  ['A launcher gone while both run', (e) => { c20(e).bothRunning.A.proc.wrapperAlive = false; }, 'CONC20000_A_WRAPPER_EXITED'],
  ['B file count changed (immediate)', (e) => { c20(e).afterAExit.runDir.files -= 1; }, 'CONC20000_B_RUNTIME_CHANGED_IMMEDIATE'],
  ['B bytes changed by one byte (immediate)', (e) => { c20(e).afterAExit.runDir.bytes += 1; }, 'CONC20000_B_RUNTIME_CHANGED_IMMEDIATE'],
  ['B runtime changed after settling', (e) => { c20(e).afterAExitSettled.runDir.bytes -= 1; }, 'CONC20000_B_RUNTIME_CHANGED_SETTLED'],
  ['B runtime directory vanished', (e) => { c20(e).afterAExit.runDir = { exists: false, files: 0, bytes: 0 }; }, 'CONC20000_B_RUNTIME_CHANGED_IMMEDIATE'],
  ['B main dead', (e) => { c20(e).afterAExit.proc.mainAlive = false; }, 'CONC20000_B_MAIN_DEAD'],
  ['B not responding', (e) => { c20(e).afterAExit.proc.responding = false; }, 'CONC20000_B_NOT_RESPONDING'],
  ['B responding unknown (null) is not accepted as responding', (e) => { c20(e).afterAExit.proc.responding = null; }, 'CONC20000_B_NOT_RESPONDING'],
  ['B window gone', (e) => { c20(e).afterAExitSettled.proc.windowHandle = 0; }, 'CONC20000_B_WINDOW_LOST'],
  ['B wrapper exited', (e) => { c20(e).afterAExit.proc.wrapperAlive = false; }, 'CONC20000_B_WRAPPER_EXITED'],
  ['B observation missing', (e) => { delete c20(e).afterAExit; }, 'CONC20000_B_NOT_CHECKED'],
  ['B exit code', (e) => { c20(e).bClose.exitCode = 2; }, 'CONC20000_B_EXIT_CODE'],
  ['B never closed', (e) => { c20(e).bClose = null; }, 'CONC20000_B_NOT_CLOSED'],
  ['B runtime not removed', (e) => { c20(e).bClose.cleanup.runDirRemoved = false; }, 'CONC20000_B_RUNDIR_NOT_REMOVED'],
  ['GPU step missing', (e) => { c20(e).gpuRestart = null; }, 'CONC20000_GPU_NOT_RUN'],
  ['GPU step skipped', (e) => { c20(e).gpuRestart.skipped = 'x'; }, 'CONC20000_GPU_SKIPPED'],
  ['no gpu-process found', (e) => { c20(e).gpuRestart.targetPid = null; }, 'CONC20000_GPU_PROCESS_NOT_FOUND'],
  ['gpu-process not terminated', (e) => { c20(e).gpuRestart.performed = false; c20(e).gpuRestart.reason = 'x'; }, 'CONC20000_GPU_KILL_NOT_PERFORMED'],
  ['gpu-process not respawned', (e) => { c20(e).gpuRestart.respawned = false; }, 'CONC20000_GPU_NOT_RESPAWNED'],
  ['B dead after the GPU restart', (e) => { c20(e).gpuRestart.after.proc.mainAlive = false; }, 'CONC20000_GPU_B_MAIN_DEAD'],
  ['B not responding after the GPU restart', (e) => { c20(e).gpuRestart.afterSettled.proc.responding = false; }, 'CONC20000_GPU_B_NOT_RESPONDING'],
  ['B window lost after the GPU restart', (e) => { c20(e).gpuRestart.after.proc.windowHandle = 0; }, 'CONC20000_GPU_B_WINDOW_LOST'],
  ['B runtime changed after the GPU restart', (e) => { c20(e).gpuRestart.after.runDir.files -= 1; }, 'CONC20000_GPU_B_RUNTIME_CHANGED_AFTER_GPU'],
  ['launcher A exited before readiness', (e) => { c0(e).launchers.A = { outcome: 'exited', exitCode: 1, elapsedMs: 3000 }; }, 'CONC0_A_EXITED_BEFORE_READY'],
  ['launcher B timed out', (e) => { c0(e).launchers.B = { outcome: 'timeout', elapsedMs: 120000 }; }, 'CONC0_B_NOT_READY'],
  ['launcher never started', (e) => { delete c0(e).launchers.B; }, 'CONC0_B_NOT_LAUNCHED'],
  ['profile A empty', (e) => { c0(e).A.profile = { exists: true, files: 0, bytes: 0 }; }, 'CONC0_A_PROFILE_EMPTY'],
  ['profile B missing', (e) => { c0(e).B.profile = { exists: false, files: 0, bytes: 0 }; }, 'CONC0_B_PROFILE_EMPTY'],
  ['baseline close exit code', (e) => { e.baseline.close.exitCode = 1; }, 'BASELINE_FAILED'],
  ['baseline missing', (e) => { e.baseline = null; }, 'BASELINE_MISSING'],
  ['no concurrency scenario', (e) => { e.concurrency = []; }, 'CONCURRENCY_NOT_RUN'],
  ['forced kill', (e) => { e.forcedKill = true; }, 'FORCED_KILL_IN_SUCCESS_PATH'],
  ['scenario 2 missing', (e) => { e.scenario2 = null; }, 'S2_NOT_RUN'],
  ['D not self-exit', (e) => { e.scenario2.D.exitedByItself = false; }, 'S2_D_NOT_SELF_EXIT'],
  ['D exit code', (e) => { e.scenario2.D.exitCode = 1; }, 'S2_D_EXIT_CODE'],
  ['D shares C directory', (e) => { e.scenario2.D.sharesRunDirWithC = true; }, 'S2_RUNDIR_SHARED'],
  ['C runtime changed by D', (e) => { e.scenario2.afterDExit.runDir.files = 7; }, 'S2_C_RUNTIME_CHANGED_IMMEDIATE'],
  ['C main dead after D', (e) => { e.scenario2.afterDExitSettled.proc.mainAlive = false; }, 'S2_C_MAIN_DEAD'],
  ['D runtime not removed', (e) => { e.scenario2.dCleanup.runDirRemoved = false; }, 'S2_D_RUNDIR_NOT_REMOVED'],
  ['D leftover dirs', (e) => { e.scenario2.dCleanup.leftoverNsDirs = ['nsq7C1.tmp']; }, 'S2_D_LEFTOVER_DIRS'],
  ['C exit code', (e) => { e.scenario2.cClose.exitCode = 4; }, 'S2_C_EXIT_CODE'],
  ['C NSIS parent not removed', (e) => { e.scenario2.cClose.cleanup.nsisParentRemoved = false; }, 'S2_C_NSIS_PARENT_NOT_REMOVED'],
];

test('analyze: the recorded passing run is the baseline for the mutation table (no failures, no detection)', async () => {
  const verdict = check.analyze({ expect: 'isolated', ...(await passingEvidence()) });
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.detection.any, false);
  assert.deepEqual(verdict.signatures.map((entry) => entry.signature), ['isolated-ok', 'isolated-ok', 'isolated-ok', 'isolated-ok']);
});

for (const [name, mutate, expectedId] of mutations) {
  test(`analyze: ${name} => ${expectedId} fails the isolated verdict`, async () => {
    const evidence = await passingEvidence();
    mutate(evidence);
    const verdict = check.analyze({ expect: 'isolated', ...evidence });
    assert.equal(verdict.verdict, 'fail');
    assert.ok(ids(verdict.failures).includes(expectedId), `${expectedId} missing from ${ids(verdict.failures).join()}`);
  });
}

test('analyze: an empty/unknown input is a failure, never a pass', () => {
  assert.equal(check.analyze({}).verdict, 'fail');
  assert.equal(check.analyze(undefined).verdict, 'fail');
  assert.equal(check.analyze({ expect: 'shared' }).verdict, 'fail');
  assert.equal(check.analyze({ expect: 'shared' }).detection.any, false);
});

test('analyze (control): without a passing baseline no defect signature is attributed, even when a launcher was lost', async () => {
  const evidence = await passingEvidence();
  c0(evidence).launchers.A = { outcome: 'exited', exitCode: 1, elapsedMs: 100 };
  c20(evidence).runDirShared = true;
  evidence.baseline.close.exitCode = 1;
  const verdict = check.analyze({ expect: 'shared', ...evidence });
  assert.equal(verdict.detection.baselineOk, false);
  assert.equal(verdict.detection.any, false);
  assert.ok(ids(verdict.failures).includes('BASELINE_FAILED'), 'a failed baseline is never excused as an expected defect effect');
  assert.ok(ids(verdict.failures).includes('CONTROL_DEFECT_NOT_DETECTED'));
});

test('analyze: a measurement that equals the baseline in files but not in bytes is still "changed" (exact comparison)', async () => {
  const evidence = await passingEvidence();
  c20(evidence).afterAExitSettled.runDir.bytes -= 1;
  assert.equal(check.analyze({ expect: 'isolated', ...evidence }).verdict, 'fail');
});

// ---------------------------------------------------------------------------------------------------------
// Second-pass hardening (real-CI findings and reviewer mutants)
// ---------------------------------------------------------------------------------------------------------

const only = (nominalMs, from = 'main-seen') => [{ nominalMs, from }]; // launch order of a single-stagger run: baseline 1, A 2, B 3, C 4, D 5

test('the fake allocates realistic NSIS plugin directory names (ns + one letter + hex, varying letters) and all of them classify as per-launch', async () => {
  const { world, result } = await runWorld();
  const leaves = world.launches.map((wrapper) => path.win32.basename(wrapper.nsisParent));
  assert.ok(new Set(leaves.map((leaf) => leaf[2].toLowerCase())).size >= 4, `varied letters: ${leaves.join()}`);
  for (const leaf of leaves) assert.match(leaf, /^ns[a-z][0-9A-F]{4}\.tmp$/i);
  assert.equal(result.evidence.concurrency.every((rec) => rec.A.runDirKind === 'per-launch-nsis' && rec.B.runDirKind === 'per-launch-nsis'), true);
  assert.equal(result.observations.some((item) => /RUNDIR_KIND/.test(item.id)), false, 'no "not the NSIS pattern" notes for realistic names');
});

test('cleanupKilled: a clean run records cleanupKilled=false with no pids; the verdict never depends on it', async () => {
  const { result } = await runWorld();
  assert.equal(result.evidence.cleanupKilled, false);
  assert.deepEqual(result.evidence.cleanupKilledPids, []);
  assert.equal(result.evidence.forcedKill, false);
  assert.match(check.formatSummary(result), /forcedKill=false \(success path\); cleanupKilled=false/);
});

test('cleanupKilled: a cleanup kill is recorded (flag + pids + summary) but is NOT a forced kill and does not fail the isolated verdict by itself', async () => {
  const { world, result } = await runWorld({ ignoreClose: [L.c0.A] }, { timeoutSec: 20 });
  assert.equal(result.evidence.cleanupKilled, true);
  assert.ok(result.evidence.cleanupKilledPids.length >= 1);
  assert.ok(result.evidence.cleanupKilledPids.every((pid) => world.launches.some((wrapper) => wrapper.pid === pid)));
  assert.equal(result.evidence.forcedKill, false);
  assert.equal(ids(result.failures).includes('FORCED_KILL_IN_SUCCESS_PATH'), false);
  assert.match(check.formatSummary(result), new RegExp(`cleanupKilled=true \\(pids ${result.evidence.cleanupKilledPids.join(', ')}`));
});

test('cleanupKilled in control mode: killing a surviving B in the old build is legitimate and the control still passes', async () => {
  const { result } = await runWorld({ mode: 'shared' }, { expect: 'shared' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence.cleanupKilled, true, 'the 5000 ms scenario leaves B running; its cleanup kills it');
  assert.equal(result.evidence.forcedKill, false);
});

test('snapshot retry: ONE transient PowerShell failure is retried and the run still passes; two in a row are an infrastructure failure (exit 2)', async () => {
  const once = await runWorld({ snapshotFailNext: 1 });
  assert.equal(once.result.exitCode, 0, JSON.stringify(once.result.failures));
  assert.ok(once.result.evidence.timeline.some((entry) => entry.step === 'process snapshot failed, retrying once'));
  const twice = await runWorld({ snapshotFailNext: 2 });
  assert.equal(twice.result.exitCode, 2);
  assert.equal(twice.result.verdict, 'infrastructure-failure');
  assert.match(twice.result.evidence.infrastructureError.message, /process snapshot failed twice/);
  assert.deepEqual(twice.world.aliveWrapperPids(), []);
});

for (const mode of ['isolated', 'shared']) {
  test(`a snapshot that starts failing mid-run is exit 2 in ${mode === 'shared' ? 'control' : 'isolated'} mode: an unreadable process table is never a "both-lost" detection`, async () => {
    const { result } = await runWorld({ mode, snapshotFailsAfterLaunch: 3 }, { expect: mode }); // A and B of the first concurrency scenario are running
    assert.equal(result.exitCode, 2);
    assert.equal(result.verdict, 'infrastructure-failure');
    assert.equal(result.evidence.infrastructureError.step, 'readiness poll');
    assert.match(result.evidence.infrastructureError.message, /process snapshot failed twice/);
    assert.deepEqual(result.failures, []);
    assert.equal(result.evidence.concurrency[0].observed, null, 'no signature is claimed from partial data');
    const timed = await runWorld({ mode, snapshotFailsAfterMs: 25000 }, { expect: mode });
    assert.equal(timed.result.exitCode, 2);
    assert.equal(timed.result.verdict, 'infrastructure-failure');
  });
}

test('a launcher that never resolves (alive, no window) with a small --max-total-sec is exit 2 (global budget), not a hang and not a pass', async () => {
  const { world, result } = await runWorld({ neverReady: [L.c0.A] }, { maxTotalSec: 60 });
  assert.equal(result.exitCode, 2);
  assert.match(result.evidence.infrastructureError.message, /global time budget of 60 s exhausted/);
  assert.deepEqual(world.aliveWrapperPids(), []);
  assert.ok(world.clock < 120000, 'stopped by the budget, not by the per-wait timeout');
});

test('a delayed profile (6 s after the window) passes; one that appears only after the 15 s wait fails with CONC0_B_PROFILE_EMPTY', async () => {
  const slow = await runWorld({ profileDelayMs: 6000 });
  assert.equal(slow.result.verdict, 'pass', JSON.stringify(slow.result.failures));
  assert.ok(slow.result.evidence.baseline.instance.profile.waitedMs > 0, 'the profile wait is recorded');
  assert.ok(slow.result.evidence.concurrency.every((rec) => rec.A.profile.files > 0 && rec.B.profile.files > 0));
  const late = await runWorld({ profileDelayMs: 40000, profileDelayFor: [L.c0.B] });
  assert.deepEqual(ids(late.result.failures), ['CONC0_B_PROFILE_EMPTY']);
});

test('the wrapper cleanup becoming visible 4 s late passes; 15 s late fails the concurrency/second-instance cleanup checks (bounded wait, no silent pass)', async () => {
  const fine = await runWorld({ removalDelayMs: 4000 });
  assert.equal(fine.result.verdict, 'pass', JSON.stringify(fine.result.failures));
  assert.ok(fine.result.evidence.concurrency[0].aClose.cleanup.waitedMs >= 4000);
  const late = await runWorld({ removalDelayMs: 15000 });
  assert.equal(late.result.exitCode, 1);
  for (const id of ['CONC0_A_RUNDIR_NOT_REMOVED', 'CONC0_B_RUNDIR_NOT_REMOVED', 'S2_D_RUNDIR_NOT_REMOVED', 'S2_C_RUNDIR_NOT_REMOVED']) assert.ok(ids(late.result.failures).includes(id), `${id} in ${ids(late.result.failures).join()}`);
});

test('the baseline gets the longer 30 s cleanup wait: 15 s late passes, 35 s late is an infrastructure failure (baseline stays strict)', async () => {
  const world = new FakeWindows({ removalDelayMs: 15000 });
  const result = await check.run(baseOptions(), world);
  assert.equal(result.evidence.baseline.passed, true, 'the baseline waited for the delayed removal');
  assert.equal(result.evidence.baseline.close.cleanup.runDirRemoved, true);
  const beyond = await runWorld({ removalDelayMs: 35000 }, { timeoutSec: 30 });
  assert.equal(beyond.result.exitCode, 2);
  assert.match(beyond.result.evidence.infrastructureError.message, /baseline.*not removed/);
});

test('scenario 2 in the shared-directory build fails the isolated mode with S2_RUNDIR_SHARED (D extracted into C\'s directory)', async () => {
  const { result } = await runWorld({ mode: 'shared' });
  assert.ok(ids(result.failures).includes('S2_RUNDIR_SHARED'), ids(result.failures).join());
  assert.equal(result.evidence.scenario2.D.sharesRunDirWithC, true);
});

test('shrink detection is exact for control mode: a bytes-only shrink, a files-only shrink, and damage that appears only AFTER the immediate snapshot', async () => {
  const control = { expect: 'shared', staggers: only(10000) };
  const damage = (to, afterMs) => ({ damageOnCleanup: { from: 2, victim: 3, to, afterMs } }); // A = launch 2, B = launch 3
  for (const [name, to] of [['bytes only', { files: FULL.files, bytes: FULL.bytes - 1 }], ['files only', { files: FULL.files - 1, bytes: FULL.bytes }]]) {
    const { result } = await runWorld(damage(to), control);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.failures)}`);
    assert.equal(result.evidence.concurrency[0].observed.signature, 'shared-dir-runtime-shrinks', name);
    assert.equal(result.detection.structural, true);
  }
  const late = await runWorld(damage(REMAINS, 2000), control);
  const rec = late.result.evidence.concurrency[0];
  assert.deepEqual(rec.afterAExit.runDir, { exists: true, ...FULL }, 'the immediate snapshot does not see the damage yet');
  assert.deepEqual(rec.afterAExitSettled.runDir, { exists: true, ...REMAINS }, 'only the settled snapshot does');
  assert.equal(late.result.exitCode, 0, JSON.stringify(late.result.failures));
  assert.equal(rec.observed.signature, 'shared-dir-runtime-shrinks');
  const strict = await runWorld(damage(REMAINS, 2000), { staggers: only(10000) });
  assert.deepEqual(ids(strict.result.failures).filter((id) => /^CONC10000_B_RUNTIME_CHANGED/.test(id)), ['CONC10000_B_RUNTIME_CHANGED_SETTLED']);
  const noDamage = await runWorld({}, control);
  assert.equal(noDamage.result.exitCode, 1, 'without any damage the control cannot pass');
});

test('control mode: a shared runtime directory ALONE (A\'s exit does not shrink it) is structural evidence; so is a shrink alone (distinct directories)', async () => {
  const shared = await runWorld({ mode: 'shared', sharedNoShrink: true, overlap: 'none' }, { expect: 'shared', staggers: only(10000) });
  const rec = shared.result.evidence.concurrency[0];
  assert.equal(rec.runDirShared, true);
  assert.deepEqual(rec.afterAExit.runDir, { exists: true, ...FULL }, 'nothing shrank');
  assert.equal(shared.result.exitCode, 0, JSON.stringify(shared.result.failures));
  assert.equal(shared.result.detection.structural, true);
  const strict = await runWorld({ mode: 'shared', sharedNoShrink: true, overlap: 'none' }, { staggers: only(10000) });
  assert.ok(ids(strict.result.failures).includes('CONC10000_RUNDIR_SHARED'), 'the isolated mode fails the shared directory on its own');
});

test('a TRANSIENT shrink seen only by the immediate snapshot still counts (control) and still fails (isolated: CONC10000_B_RUNTIME_CHANGED_IMMEDIATE only)', async () => {
  const world = { damageOnCleanup: { from: 2, victim: 3, to: REMAINS, restoreAfterMs: 1500 } };
  const control = await runWorld(world, { expect: 'shared', staggers: only(10000) });
  const rec = control.result.evidence.concurrency[0];
  assert.deepEqual(rec.afterAExit.runDir, { exists: true, ...REMAINS });
  assert.deepEqual(rec.afterAExitSettled.runDir, { exists: true, ...FULL }, 'restored by the settled snapshot');
  assert.equal(control.result.exitCode, 0, JSON.stringify(control.result.failures));
  const strict = await runWorld(world, { staggers: only(10000) });
  assert.deepEqual(ids(strict.result.failures).filter((id) => /^CONC10000_B_RUNTIME_CHANGED/.test(id)), ['CONC10000_B_RUNTIME_CHANGED_IMMEDIATE']);
});

test('D\'s leftover scan waits for the wrapper cleanup too: an unobserved D whose extraction disappears 4 s late passes, 15 s late fails (S2_D_LEFTOVER_DIRS)', async () => {
  const fine = await runWorld({ dMainInvisible: true, removalDelayMs: 4000 });
  assert.equal(fine.result.verdict, 'pass', JSON.stringify(fine.result.failures));
  const late = await runWorld({ dMainInvisible: true, removalDelayMs: 15000 });
  assert.ok(ids(late.result.failures).includes('S2_D_LEFTOVER_DIRS'), ids(late.result.failures).join());
});

test('stagger accuracy: with 1.5 s snapshots the achieved stagger lands on the nominal 5000 ms (no whole-poll overshoot); main-seen staggers stay at or just after nominal', async () => {
  const { result } = await runWorld({ snapshotCostMs: 1500 });
  assert.equal(result.verdict, 'pass', JSON.stringify(result.failures));
  const [s0, s5, s10, s20] = result.evidence.concurrency.map((rec) => rec.stagger);
  assert.ok(s0.achievedMs >= 0 && s0.achievedMs < 50, `0 ms: ${s0.achievedMs}`);
  assert.ok(s5.achievedMs >= 5000 && s5.achievedMs < 5100, `5000 ms: ${s5.achievedMs}`);
  assert.ok(s10.achievedMs >= 10000 && s10.achievedMs < 10100, `10000 ms: ${s10.achievedMs}`);
  assert.ok(s20.achievedMs >= 20000 && s20.achievedMs < 20100, `20000 ms: ${s20.achievedMs}`);
});

test('classifyCloseOutput maps the close script output (CRLF, trailing blank lines) to ok / gone / other / refused', () => {
  assert.equal(check.classifyCloseOutput('ok\r\n'), 'ok');
  assert.equal(check.classifyCloseOutput('\r\ngone\r\n\r\n'), 'gone');
  assert.equal(check.classifyCloseOutput('other'), 'other');
  assert.equal(check.classifyCloseOutput('refused\r\n'), 'refused');
  assert.equal(check.classifyCloseOutput(''), 'refused');
  assert.equal(check.classifyCloseOutput('WARNING: something\r\nok'), 'ok');
});

test('pathExists: only a definite "not found" means removed; EPERM/EACCES/EBUSY/EIO still count as present (never a false "cleanup done")', async () => {
  const err = (code) => Object.assign(new Error(code), { code });
  const fakeFs = (code) => ({ stat: async () => { if (code) throw err(code); return {}; } });
  assert.equal(await check.pathExists('x', fakeFs(null)), true);
  assert.equal(await check.pathExists('x', fakeFs('ENOENT')), false);
  assert.equal(await check.pathExists('x', fakeFs('ENOTDIR')), false);
  for (const code of ['EPERM', 'EACCES', 'EBUSY', 'EIO']) assert.equal(await check.pathExists('x', fakeFs(code)), true, code);
  assert.equal(await check.pathExists(path.join(os.tmpdir(), 'portable-iso-surely-missing-path')), false);
});

test('sameDirectory: the 8.3 spelling (RUNNER~1) and the long spelling (runneradmin) of ONE directory are the same directory (canonicalized)', async () => {
  const { result } = await runWorld({ mode: 'shared', longSpellingFor: [3] }, { staggers: only(10000) });
  const rec = result.evidence.concurrency[0];
  assert.notEqual(rec.A.runDir.toLowerCase(), rec.B.runDir.toLowerCase(), 'the processes report different spellings');
  assert.equal(rec.runDirShared, true);
  assert.ok(ids(result.failures).includes('CONC10000_RUNDIR_SHARED'));
});

test('cleanup never kills a recorded main pid that was reused by another executable (pid reuse), only our wrapper', async () => {
  const world = new FakeWindows({ neverReady: [L.baseline], pidReuse: true });
  const result = await check.run(baseOptions({ timeoutSec: 20 }), world);
  assert.equal(result.exitCode, 2);
  const wrapper = world.launches[0];
  assert.deepEqual(world.kills.map((kill) => kill.pid), [wrapper.pid]);
  assert.equal(world.procs.get(wrapper.mainPid).alive, true, 'the unrelated process that got the pid is untouched');
});

test('cleanup never removes an extraction directory that a (stuck) process still runs from', async () => {
  const world = new FakeWindows({ neverReady: [L.baseline], survivorAfterKill: true });
  const result = await check.run(baseOptions({ timeoutSec: 20 }), world);
  assert.equal(result.exitCode, 2);
  assert.equal(await world.exists(world.launches[0].runDir), true);
  assert.deepEqual(world.removedTrees, []);
});

test('cleanup skips removing extraction directories when it cannot verify that nothing still runs from them (snapshot failure during cleanup)', async () => {
  const world = new FakeWindows({ neverReady: [L.baseline] });
  const original = world.killTree.bind(world);
  world.killTree = async (pid) => { await original(pid); world.opts.snapshotFails = true; }; // the process table becomes unreadable right after the kill
  const result = await check.run(baseOptions({ timeoutSec: 20 }), world);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(world.removedTrees, []);
  assert.ok(result.evidence.cleanup[0].errors.some((text) => /snapshot/.test(text)));
});

test('removeTree / removeTempArea refuse any path outside the temp directory (and only touch things inside it)', async () => {
  const base = await fsp.realpath(os.tmpdir());
  const tempRoot = await fsp.mkdtemp(path.join(base, 'portable-iso-root-'));
  const outside = await fsp.mkdtemp(path.join(base, 'portable-iso-outside-'));
  try {
    const platform = check.createNodePlatform({ tmpdir: () => tempRoot });
    await fsp.mkdir(path.join(tempRoot, 'inner', 'deep'), { recursive: true });
    await fsp.writeFile(path.join(outside, 'keep.txt'), 'x');
    await assert.rejects(platform.removeTree(outside), /outside the temp directory/);
    await assert.rejects(platform.removeTempArea(outside), /outside the temp directory/);
    await assert.rejects(platform.removeTree(path.dirname(tempRoot)), /outside the temp directory/);
    await assert.rejects(platform.removeTree(tempRoot), /outside the temp directory/, 'the temp root itself is not removable either');
    assert.equal(await fsp.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'x');
    assert.equal(await platform.removeTree(path.join(tempRoot, 'inner')), true);
    assert.equal(await platform.removeTree(path.join(tempRoot, 'inner')), false, 'already gone');
    assert.deepEqual(await fsp.readdir(tempRoot), []);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test('dirStatsOf skips busy/denied entries (EPERM/EACCES/EBUSY, vanished) instead of failing, so the count drop is the signal; unknown errors still surface', async () => {
  const err = (code) => Object.assign(new Error(code), { code });
  const dirent = (name, kind) => ({ name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file' });
  const tree = {
    root: [dirent('a.bin', 'file'), dirent('sub', 'dir'), dirent('busy', 'dir'), dirent('denied', 'dir'), dirent('gone', 'dir'), dirent('locked.bin', 'file'), dirent('vanished.bin', 'file'), dirent('denied.bin', 'file')],
    [`root${path.sep}sub`]: [dirent('inner.bin', 'file')],
  };
  const sizes = { [`root${path.sep}a.bin`]: 10, [`root${path.sep}sub${path.sep}inner.bin`]: 100 };
  const lstatErrors = { [`root${path.sep}locked.bin`]: 'EBUSY', [`root${path.sep}vanished.bin`]: 'ENOENT', [`root${path.sep}denied.bin`]: 'EACCES' };
  const readdirErrors = { [`root${path.sep}busy`]: 'EPERM', [`root${path.sep}denied`]: 'EACCES', [`root${path.sep}gone`]: 'ENOENT' };
  const fake = {
    stat: async () => ({ isDirectory: () => true }),
    readdir: async (dir) => { if (readdirErrors[dir]) throw err(readdirErrors[dir]); return tree[dir]; },
    lstat: async (file) => { if (lstatErrors[file]) throw err(lstatErrors[file]); return { size: sizes[file] }; },
  };
  assert.deepEqual(await check.dirStatsOf('root', fake), { exists: true, files: 2, bytes: 110 });
  assert.deepEqual(await check.dirStatsOf('root', { ...fake, stat: async () => { throw err('EPERM'); } }), { exists: true, files: 0, bytes: 0 }, 'a present but unreadable directory still exists');
  assert.deepEqual(await check.dirStatsOf('root', { ...fake, stat: async () => { throw err('ENOENT'); } }), { exists: false, files: 0, bytes: 0 });
  await assert.rejects(check.dirStatsOf('root', { ...fake, lstat: async () => { throw err('EIO'); } }), /EIO/);
  await assert.rejects(check.dirStatsOf('root', { ...fake, readdir: async () => { throw err('EIO'); } }), /EIO/);
});

test('PowerShell snapshot script fails loudly (exit 3) instead of reporting "no processes" when WMI fails or returns nothing; close script checks the process name', () => {
  const script = check.buildSnapshotScript();
  assert.ok(script.includes('Get-CimInstance -ClassName Win32_Process -ErrorAction Stop'));
  assert.ok(script.includes('exit 3'));
  assert.equal((script.match(/exit 3/g) || []).length, 2, 'both the WMI exception and the empty result exit non-zero');
  assert.ok(script.indexOf("$all.Count -eq 0") > script.indexOf('-ErrorAction Stop') && script.indexOf('foreach ($c in $all)') > script.indexOf('$all.Count -eq 0'));
  const close = check.buildCloseScript(4242);
  assert.ok(close.includes("$p.ProcessName -ne 'TRACE Boardviewer'"), 'a reused pid of another program is never asked to close');
  assert.ok(close.indexOf('ProcessName') < close.indexOf('CloseMainWindow()'));
});

// ---------------------------------------------------------------------------------------------------------
// Real-platform building blocks that need neither Windows nor Electron
// ---------------------------------------------------------------------------------------------------------

test('dirStatsOf counts files only, recursively, including hidden ones, and reports a missing directory as not existing', async () => {
  const root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'portable-iso-test-'));
  try {
    await fsp.mkdir(path.join(root, 'a', 'b'), { recursive: true });
    await fsp.mkdir(path.join(root, 'empty'));
    await fsp.writeFile(path.join(root, 'one.bin'), Buffer.alloc(10));
    await fsp.writeFile(path.join(root, '.hidden'), Buffer.alloc(5));
    await fsp.writeFile(path.join(root, 'a', 'two.bin'), Buffer.alloc(100));
    await fsp.writeFile(path.join(root, 'a', 'b', 'three.bin'), Buffer.alloc(1000));
    assert.deepEqual(await check.dirStatsOf(root), { exists: true, files: 4, bytes: 1115 });
    assert.deepEqual(await check.dirStatsOf(path.join(root, 'empty')), { exists: true, files: 0, bytes: 0 });
    assert.deepEqual(await check.dirStatsOf(path.join(root, 'nope')), { exists: false, files: 0, bytes: 0 });
    assert.deepEqual(await check.dirStatsOf(path.join(root, 'one.bin')), { exists: false, files: 0, bytes: 0 }, 'a file is not a directory');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('PowerShell scripts are passed as -EncodedCommand (UTF-16LE base64): the pid is validated and the main exe name is quoted', () => {
  const script = check.buildSnapshotScript();
  assert.equal(Buffer.from(check.encodePowerShell(script), 'base64').toString('utf16le'), script);
  assert.ok(script.includes("'TRACE Boardviewer.exe'"));
  assert.ok(script.includes('ConvertTo-Json -InputObject @($rows) -Compress'), 'an array is forced even for one process');
  assert.ok(script.includes('--type='), 'the Chromium process type is derived from the command line inside PowerShell');
  assert.equal(script.includes('CommandLine ='), false, 'command lines (which may contain user paths) are never emitted');
  assert.ok(check.buildCloseScript(1234).includes('Get-Process -Id 1234'));
  assert.ok(check.buildCloseScript(1234).includes('CloseMainWindow()'));
  for (const bad of ['1; calc', -1, 0, 1.5, NaN, null]) assert.throws(() => check.buildCloseScript(bad), /invalid pid/);
});

// ---------------------------------------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------------------------------------

function cliDeps(world) {
  const written = [];
  const lines = [];
  const errors = [];
  return {
    written, lines, errors,
    deps: { platform: world, log: (line) => lines.push(line), error: (line) => errors.push(line), writeEvidence: async (target, text) => { written.push({ target, text }); } },
  };
}

test('main: a passing run exits 0, prints a compact summary and writes parsable evidence to --out', async () => {
  const cli = cliDeps(new FakeWindows());
  const code = await check.main(['--exe', EXE, '--out', 'evidence.json'], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.written[0].target, 'evidence.json');
  const evidence = JSON.parse(cli.written[0].text);
  assert.equal(evidence.verdict, 'pass');
  const summary = cli.lines.join('\n');
  assert.match(summary, /PASS \(expect=isolated, exit 0\)/);
  assert.match(summary, /forcedKill=false/);
  assert.match(summary, /runDirShared=false/);
  assert.match(summary, /signature=isolated-ok/);
  assert.match(summary, /INJECTED GPU restart: target=\d+ performed=true/);
});

test('main: the old defect exits 1 in the default mode and 0 with --expect shared; both write the evidence file', async () => {
  const strict = cliDeps(new FakeWindows({ mode: 'shared' }));
  assert.equal(await check.main(['--exe', EXE], strict.deps), 1);
  assert.equal(strict.written[0].target, 'portable-isolation-evidence.json');
  assert.match(strict.lines.join('\n'), /FAIL .*\n[\s\S]*CONC10000_RUNDIR_SHARED/);
  const control = cliDeps(new FakeWindows({ mode: 'shared' }));
  assert.equal(await check.main(['--exe', EXE, '--expect', 'shared'], control.deps), 0);
  assert.match(control.lines.join('\n'), /old defect detected: true/);
  assert.match(control.lines.join('\n'), /signature=both-lost \(expected both-lost, matchesReference=true\)/);
});

test('main: infrastructure failure exits 2, usage errors exit 2, an unwritable evidence file turns a pass into exit 2', async () => {
  const infra = cliDeps(new FakeWindows({ neverReady: true }));
  assert.equal(await check.main(['--exe', EXE, '--timeout-sec', '20'], infra.deps), 2);
  assert.equal(JSON.parse(infra.written[0].text).verdict, 'infrastructure-failure', 'evidence is still written');
  const usage = cliDeps(new FakeWindows());
  assert.equal(await check.main(['--expect', 'isolated'], usage.deps), 2);
  assert.match(usage.errors.join('\n'), /--exe <portable\.exe> is required/);
  const unwritable = cliDeps(new FakeWindows());
  unwritable.deps.writeEvidence = async () => { throw new Error('disk full'); };
  assert.equal(await check.main(['--exe', EXE], unwritable.deps), 2);
  assert.match(unwritable.errors.join('\n'), /disk full/);
});

test('main: without an injected platform it refuses to run on a non-Windows host with exit 2', { skip: process.platform === 'win32' }, async () => {
  const errors = [];
  assert.equal(await check.main(['--exe', EXE], { error: (line) => errors.push(line), log: () => {} }), 2);
  assert.match(errors.join('\n'), /only runs on Windows/);
});

// ---------------------------------------------------------------------------------------------------------
// Windows regression extension (simulated platform only; see the header comment).
// R1 repeat + alternating close order, R2 per-file preservation, R3 payload parity, R4 forwarded board, R5 evidence/summary
// ---------------------------------------------------------------------------------------------------------

const STAGGER_MS = [0, 5000, 10000, 20000];
/** Launch indexes of a run with `repeat` attempts per stagger: baseline, then A/B of every (stagger, attempt), then C and D. */
function launchPlan(repeat, staggers = STAGGER_MS) {
  const plan = { baseline: 1 };
  let next = 2;
  for (const ms of staggers) for (let attempt = 1; attempt <= repeat; attempt++) { plan[`${ms}-r${attempt}`] = { A: next, B: next + 1 }; next += 2; }
  plan.C = next;
  plan.D = next + 1;
  return plan;
}
const LP2 = launchPlan(2);
const rep2 = { repeat: 2 };
const byName = (result, name) => result.evidence.concurrency.find((rec) => rec.name === name);
const hex64 = /^[0-9a-f]{64}$/;

test('--repeat 2: every stagger runs twice with unique names, fresh temp areas and fresh distinct profiles; attempt 1 closes A first, attempt 2 closes B first', async () => {
  const { world, result } = await runWorld({}, rep2);
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  assert.equal(result.verdict, 'pass');
  const names = result.evidence.concurrency.map((rec) => rec.name);
  assert.deepEqual(names, STAGGER_MS.flatMap((ms) => [`concurrency-${ms}-r1`, `concurrency-${ms}-r2`]));
  assert.equal(new Set(names).size, 8, 'scenario names stay unique');
  assert.deepEqual(result.evidence.concurrency.map((rec) => rec.closeOrder), ['A-first', 'B-first', 'A-first', 'B-first', 'A-first', 'B-first', 'A-first', 'B-first']);
  assert.deepEqual(result.evidence.concurrency.map((rec) => [rec.attempt.index, rec.attempt.of]), [[1, 2], [2, 2], [1, 2], [2, 2], [1, 2], [2, 2], [1, 2], [2, 2]]);
  assert.deepEqual(result.evidence.concurrency.map((rec) => rec.stagger.nominalMs), STAGGER_MS.flatMap((ms) => [ms, ms]));
  assert.deepEqual(result.evidence.concurrency.map((rec) => rec.closedFirst), ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B']);
  assert.deepEqual(result.evidence.concurrency.map((rec) => rec.survivor), ['B', 'A', 'B', 'A', 'B', 'A', 'B', 'A']);
  assert.equal(world.areas.length, 10, 'baseline + 8 attempts + second instance, each in its own temp area');
  assert.equal(new Set(world.areas).size, 10);
  const profiles = world.launches.filter((wrapper) => wrapper.index !== LP2.D).map((wrapper) => wrapper.profile);
  assert.equal(new Set(profiles).size, profiles.length, 'fresh distinct synthetic profiles for every launch (D reuses C by design)');
  assert.equal(result.evidence.options.repeat, 2);
  assert.equal(result.evidence.repeat, 2);
  assert.equal(world.launches.length, LP2.D);
  assert.deepEqual(world.kills, []);
});

test('--repeat 1 (the default) keeps the old names and the old A-first behaviour; --repeat 3 alternates A-first, B-first, A-first', async () => {
  const single = await runWorld({}, { staggers: only(10000) });
  assert.deepEqual(single.result.evidence.concurrency.map((rec) => rec.name), ['concurrency-10000']);
  assert.equal(single.result.evidence.concurrency[0].closeOrder, 'A-first');
  assert.equal(single.result.evidence.options.repeat, 1);
  const triple = await runWorld({}, { repeat: 3, staggers: only(0, 'wrapper-spawn') });
  assert.deepEqual(triple.result.evidence.concurrency.map((rec) => [rec.name, rec.closeOrder]), [['concurrency-0-r1', 'A-first'], ['concurrency-0-r2', 'B-first'], ['concurrency-0-r3', 'A-first']]);
  assert.equal(triple.result.verdict, 'pass', JSON.stringify(triple.result.failures));
  assert.deepEqual(check.closeOrderForAttempt(1), 'A-first');
  assert.deepEqual([check.concName(5000, 2, 2), check.concName(5000, 1, 1), check.concPrefix({ stagger: { nominalMs: 5000 }, attempt: { index: 2, of: 2 } }), check.concPrefix({ stagger: { nominalMs: 5000 } })], ['concurrency-5000-r2', 'concurrency-5000', 'CONC5000_R2', 'CONC5000']);
});

test('B-first attempt (isolated): B closes first (exit 0, its runtime and NSIS parent removed, no forced kill) and the survivor A stays alive, Responding, windowed with its EXACT runtime', async () => {
  const { world, result } = await runWorld({}, rep2);
  for (const ms of STAGGER_MS) {
    const rec = byName(result, `concurrency-${ms}-r2`);
    assert.equal(rec.closeOrder, 'B-first');
    assert.deepEqual([rec.bClose.exited, rec.bClose.exitCode, rec.bClose.cleanup.runDirRemoved, rec.bClose.cleanup.nsisParentRemoved], [true, 0, true, true], `${rec.name}: closer B`);
    assert.deepEqual([rec.aClose.exited, rec.aClose.exitCode, rec.aClose.cleanup.runDirRemoved], [true, 0, true], `${rec.name}: A closed second`);
    assert.equal(rec.afterAExit, null, 'the legacy A-first observation fields stay empty in B-first order');
    assert.equal(rec.afterAExitSettled, null);
    for (const snapshot of [rec.afterBExit, rec.afterBExitSettled]) {
      assert.deepEqual(snapshot.runDir, { exists: true, ...FULL }, `${rec.name}: A keeps EXACTLY its file count and bytes`);
      assert.equal(snapshot.manifest.digest, rec.A.baselineManifest.digest, 'and its exact per-file set');
      assert.equal(snapshot.manifest.diff, null);
      assert.deepEqual([snapshot.proc.mainAlive, snapshot.proc.responding, snapshot.proc.wrapperAlive], [true, true, true]);
      assert.ok(snapshot.proc.windowHandle > 0);
    }
    assert.equal(rec.observed.signature, 'isolated-ok');
    assert.equal(rec.launchers.A.outcome, 'ready');
    assert.equal(rec.gpuRestart, null);
  }
  assert.equal(result.evidence.forcedKill, false);
  // B really exited before A in the simulated world, in every attempt-2 scenario
  for (const key of ['0-r2', '5000-r2', '10000-r2', '20000-r2']) {
    const [a, b] = [world.launches[LP2[key].A - 1], world.launches[LP2[key].B - 1]];
    assert.ok(b.exitedAtMs < a.exitedAtMs, `${key}: B (${b.exitedAtMs}) closed before A (${a.exitedAtMs})`);
  }
  const timeline = result.evidence.timeline.map((entry) => entry.step);
  const start = timeline.indexOf('scenario concurrency-10000-r2: start');
  const slice = timeline.slice(start, timeline.indexOf('scenario concurrency-20000-r1: start'));
  assert.ok(slice.indexOf('B: closed') !== -1 && slice.indexOf('B: closed') < slice.indexOf('A: closed'));
  assert.ok(slice.includes('A after B exit'));
});

test('the GPU restart injection and every A-first behaviour stay as before: once, in the largest stagger, first attempt only', async () => {
  const { result } = await runWorld({}, rep2);
  const withGpu = result.evidence.concurrency.filter((rec) => rec.gpuRestart);
  assert.deepEqual(withGpu.map((rec) => rec.name), ['concurrency-20000-r1']);
  assert.deepEqual(result.evidence.concurrency.map((rec) => rec.injectGpu), [false, false, false, false, false, false, true, false]);
  assert.equal(withGpu[0].gpuRestart.respawned, true);
});

test('every attempt records nominal AND achieved stagger, close order, signature and the launcher outcomes/exit codes', async () => {
  const { result } = await runWorld({}, rep2);
  for (const rec of result.evidence.concurrency) {
    assert.equal(typeof rec.stagger.achievedMs, 'number', rec.name);
    assert.ok(Math.abs(rec.stagger.achievedMs - rec.stagger.nominalMs) < 100, `${rec.name}: achieved ${rec.stagger.achievedMs}`);
    assert.ok(['A-first', 'B-first'].includes(rec.closeOrder));
    assert.equal(rec.observed.signature, 'isolated-ok');
    assert.deepEqual([rec.launchers.A.outcome, rec.launchers.B.outcome], ['ready', 'ready']);
    assert.equal(rec.aClose.exitCode, 0);
    assert.equal(rec.bClose.exitCode, 0);
  }
  const summary = check.formatSummary(result);
  assert.match(summary, /repeat=2 \(every stagger runs that many times; odd attempts close A first, even attempts B first\)/);
  assert.match(summary, /concurrency-5000-r2: stagger nominal 5000 ms from wrapper-spawn, achieved 5000 ms; signature=isolated-ok/);
  assert.match(summary, /close order B-first \(attempt 2\/2\): B closes first, A is the survivor; per-file manifest identical \(78 files, [0-9a-f]{12}\)/);
  assert.match(summary, /B closed \(CloseMainWindow\): exited=true code=0; A after B exit: 78 files \/ 503557201 B, alive=true, responding=true/);
  assert.match(summary, /concurrency-5000-r2: [^\n]*\n[^\n]*\n[^\n]*\n[^\n]*A after B exit[^\n]*\n    A closed \(CloseMainWindow\): exited=true code=0\n/, 'the second closer is printed after the first one (B-first)');
  assert.match(summary, /concurrency-5000-r1: [^\n]*\n[^\n]*\n[^\n]*\n[^\n]*B after A exit[^\n]*\n    B closed \(CloseMainWindow\): exited=true code=0\n/, 'and for A-first');
});

test('repeat misuse is a usage error: 0, 11, fractions and non-numbers are refused by the CLI parser and by run()', async () => {
  for (const bad of ['0', '11', '1.5', 'x', '-1', '']) assert.throws(() => check.parseArgs(['--exe', 'a', '--repeat', bad]), check.UsageError, bad);
  assert.equal(check.parseArgs(['--exe', 'a']).repeat, 1);
  assert.equal(check.parseArgs(['--exe', 'a', '--repeat', '2']).repeat, 2);
  assert.equal(check.parseArgs(['--exe', 'a', '--repeat=3']).repeat, 3);
  assert.equal(check.parseArgs(['--exe', 'a', '--repeat', '10']).repeat, 10);
  await assert.rejects(check.run(baseOptions({ repeat: 0 }), new FakeWindows()), check.UsageError);
  await assert.rejects(check.run(baseOptions({ repeat: 11 }), new FakeWindows()), check.UsageError);
  await assert.rejects(check.run(baseOptions({ repeat: 1.5 }), new FakeWindows()), check.UsageError);
});

// ---- B-first: every failure the A-first order has, mirrored for the survivor A and the closer B -----------------

const reverse = (key) => ({ A: LP2[key].A, B: LP2[key].B });

for (const [name, worldFor, expectedId] of [
  ['survivor A dies after B closed', (r) => ({ onFinish: (w, wrapper) => { if (wrapper.index === r.B) w.killWithChildren(w.mainOf(r.A).pid); } }), 'CONC20000_R2_A_MAIN_DEAD'],
  ['survivor A not Responding', (r) => ({ onFinish: (w, wrapper) => { if (wrapper.index === r.B) w.mainOf(r.A).responding = false; } }), 'CONC20000_R2_A_NOT_RESPONDING'],
  ['survivor A loses its window', (r) => ({ onFinish: (w, wrapper) => { if (wrapper.index === r.B) w.mainOf(r.A).windowHandle = 0; } }), 'CONC20000_R2_A_WINDOW_LOST'],
  ['closer B exits non-zero', (r) => ({ exitCodes: { [r.B]: 3 } }), 'CONC20000_R2_B_EXIT_CODE'],
  ['closer B leaves its runtime behind', (r) => ({ leaveRuntime: [r.B] }), 'CONC20000_R2_B_RUNDIR_NOT_REMOVED'],
  ['closer B leaves its NSIS parent behind', (r) => ({ leaveNsParent: [r.B] }), 'CONC20000_R2_B_NSIS_PARENT_NOT_REMOVED'],
  ['closer B ignores the normal close', (r) => ({ ignoreClose: [r.B] }), 'CONC20000_R2_B_NOT_EXITED'],
  ['closer B is force-killed instead of closed', () => ({ killOnClose: true }), 'FORCED_KILL_IN_SUCCESS_PATH'],
  ['second closer A exits non-zero', (r) => ({ exitCodes: { [r.A]: 2 } }), 'CONC20000_R2_A_EXIT_CODE'],
  ['the survivor A runtime shrinks (distinct directories)', (r) => ({ damageOnCleanup: { from: r.B, victim: r.A } }), 'CONC20000_R2_A_RUNTIME_CHANGED_IMMEDIATE'],
]) {
  test(`B-first attempt (isolated): ${name} => ${expectedId}`, async () => {
    const { result } = await runWorld(worldFor(reverse('20000-r2')), { ...rep2, timeoutSec: 30 });
    assert.equal(result.exitCode, 1, JSON.stringify(result.failures));
    assert.ok(ids(result.failures).includes(expectedId), `${expectedId} missing from ${ids(result.failures).join()}`);
    for (const failure of result.failures) assert.equal(/^CONC20000_(?!R2_)/.test(failure.id) && failure.id !== 'FORCED_KILL_IN_SUCCESS_PATH', false, `${failure.id} leaked into the attempt-1 id space`);
  });
}

test('failure ids of a repeated run name the attempt (CONC20000_R2_...) and never collide with attempt 1; the other attempts are judged on their own', async () => {
  const { result } = await runWorld({ exitCodes: { [LP2['20000-r2'].B]: 3 } }, rep2);
  assert.deepEqual(ids(result.failures), ['CONC20000_R2_B_EXIT_CODE']);
  assert.equal(byName(result, 'concurrency-20000-r1').observed.signature, 'isolated-ok');
  const lost = await runWorld({ exitBeforeReady: [LP2['5000-r2'].A] }, rep2);
  const lostFailure = lost.result.failures.find((item) => item.id === 'CONC5000_R2_A_EXITED_BEFORE_READY');
  assert.match(lostFailure.message, /^stagger 5000 ms \(attempt 2\/2, B-first\): launcher A exited by itself/, 'messages that name the scenario name the attempt and the close order');
  const both = await runWorld({ exitCodes: { [LP2['20000-r1'].A]: 3, [LP2['20000-r2'].B]: 3 } }, rep2);
  assert.deepEqual(ids(both.result.failures), ['CONC20000_R1_A_EXIT_CODE', 'CONC20000_R2_B_EXIT_CODE'], 'the same kind of failure in two attempts is reported twice');
});

test('a signature other than isolated-ok without a specific failure is caught per attempt (CONC20000_R2_SIGNATURE), even when another attempt of the same stagger has failures of its own', async () => {
  const evidence = await passingEvidenceRepeat2();
  const rec = evidence.concurrency.find((candidate) => candidate.name === 'concurrency-20000-r2');
  rec.runDirShared = true; // a defect signature without a recorded issue is impossible to hide: the shared directory already fails
  const verdict = check.analyze({ expect: 'isolated', ...evidence });
  assert.ok(ids(verdict.failures).includes('CONC20000_R2_RUNDIR_SHARED'));
  assert.equal(verdict.signatures.find((entry) => entry.name === 'concurrency-20000-r2').signature, 'shared-dir-runtime-shrinks');
  // synthetic record: a damaged GPU step on an attempt that does not inject one is a signature that no specific check explains
  const synthetic = await passingEvidenceRepeat2();
  const r1 = synthetic.concurrency.find((candidate) => candidate.name === 'concurrency-20000-r1');
  const r2 = synthetic.concurrency.find((candidate) => candidate.name === 'concurrency-20000-r2');
  r1.aClose.exitCode = 3; // attempt 1 has its own failure (CONC20000_R1_A_EXIT_CODE)
  r2.gpuRestart = { performed: true, respawned: false, targetPid: 1, after: { runDir: { exists: true, ...FULL }, proc: { mainAlive: true } }, afterSettled: null };
  const both = check.analyze({ expect: 'isolated', ...synthetic });
  assert.deepEqual(ids(both.failures), ['CONC20000_R1_A_EXIT_CODE', 'CONC20000_R2_SIGNATURE'], 'attempt 1\'s failure must not hide attempt 2\'s unexplained signature');
  assert.equal(both.signatures.find((entry) => entry.name === 'concurrency-20000-r2').signature, 'gpu-restart-damage');
});

// ---- shared-directory (old) build: the reverse close order damages the survivor ---------------------------------

test('OLD shared-directory build, B-first attempt: closing B first shrinks the SURVIVOR A (78 -> 7 files) and fails the isolated mode (CONC10000_R2_A_RUNTIME_CHANGED_IMMEDIATE)', async () => {
  const { result } = await runWorld({ mode: 'shared' }, { ...rep2, staggers: only(10000) });
  assert.equal(result.exitCode, 1);
  const r1 = byName(result, 'concurrency-10000-r1');
  const r2 = byName(result, 'concurrency-10000-r2');
  assert.deepEqual(r1.afterAExit.runDir, { exists: true, ...REMAINS }, 'A-first: B shrinks');
  assert.deepEqual(r2.afterBExit.runDir, { exists: true, ...REMAINS }, 'B-first: A shrinks');
  assert.equal(r2.afterBExit.proc.mainAlive, true, 'A was still running while its runtime had been deleted underneath it');
  assert.deepEqual(r2.bClose.exitCode, 0);
  const failed = ids(result.failures);
  for (const id of ['CONC10000_R1_RUNDIR_SHARED', 'CONC10000_R1_B_RUNTIME_CHANGED_IMMEDIATE', 'CONC10000_R2_RUNDIR_SHARED', 'CONC10000_R2_A_RUNTIME_CHANGED_IMMEDIATE']) assert.ok(failed.includes(id), `${id} in ${failed.join()}`);
  const failure = result.failures.find((item) => item.id === 'CONC10000_R2_A_RUNTIME_CHANGED_IMMEDIATE');
  assert.match(failure.message, /A's runtime changed immediately after B exited: before 78 files \/ 503557201 B, now 7 files \/ 366521134 B/);
  assert.match(failure.message, /missing \(71\): .*\+61 more/, 'the failure names the missing paths (10 listed)');
  assert.deepEqual([r2.observed.signature, check.observedSignature(r2).flags.runtimeShrunk], ['shared-dir-runtime-shrinks', true]);
  assert.match(r2.observed.indicators.join(' '), /after B closed, A's runtime went from 78 files \/ 503557201 B to 7 files \/ 366521134 B/);
});

test('control mode detects the reverse-order shrink: a B-first attempt ALONE passes the structural gate; the per-close-order breakdown is recorded', async () => {
  const LPS = launchPlan(2, [10000]); // single-stagger run: baseline 1, r1 A 2 / B 3, r2 A 4 / B 5
  const worldOnlyB = { damageOnCleanup: { from: LPS['10000-r2'].B, victim: LPS['10000-r2'].A } }; // distinct dirs; only B's close harms A
  const control = await runWorld(worldOnlyB, { ...rep2, expect: 'shared', staggers: only(10000) });
  assert.equal(control.result.exitCode, 0, JSON.stringify(control.result.failures));
  assert.equal(control.result.detection.structural, true);
  assert.deepEqual(control.result.detection.byCloseOrder, { 'A-first': { attempts: 1, structural: false, runtimeShrunk: false }, 'B-first': { attempts: 1, structural: true, runtimeShrunk: true } });
  assert.equal(byName(control.result, 'concurrency-10000-r1').observed.signature, 'isolated-ok');
  assert.equal(byName(control.result, 'concurrency-10000-r2').observed.signature, 'shared-dir-runtime-shrinks');
  assert.match(check.formatSummary(control.result), /per close order: A-first 1 attempt\(s\) structural=false runtimeShrunk=false; B-first 1 attempt\(s\) structural=true runtimeShrunk=true/);
  const onlyA = await runWorld({ damageOnCleanup: { from: LPS['10000-r1'].A, victim: LPS['10000-r1'].B } }, { ...rep2, expect: 'shared', staggers: only(10000) });
  assert.equal(onlyA.result.exitCode, 0, 'the same gate also works from the A-first attempt alone');
  assert.deepEqual([onlyA.result.detection.byCloseOrder['A-first'].structural, onlyA.result.detection.byCloseOrder['B-first'].structural], [true, false]);
  const none = await runWorld({}, { ...rep2, expect: 'shared', staggers: only(10000) });
  assert.equal(none.result.exitCode, 1);
  assert.deepEqual(ids(none.result.failures), ['CONTROL_DEFECT_NOT_DETECTED'], 'no damage in either order: the control cannot pass');
});

test('control mode with the shared-directory build and --repeat 2 passes through BOTH close orders and still needs a passing baseline', async () => {
  const { result } = await runWorld({ mode: 'shared' }, { ...rep2, expect: 'shared' });
  assert.equal(result.exitCode, 0, JSON.stringify(result.failures));
  assert.equal(result.detection.byCloseOrder['A-first'].structural, true);
  assert.equal(result.detection.byCloseOrder['B-first'].structural, true);
  assert.equal(result.detection.byCloseOrder['B-first'].runtimeShrunk, true, 'the survivor A shrank in the shared directory');
  assert.equal(result.evidence.concurrency.length, 8);
  assert.deepEqual(result.evidence.concurrency.map((rec) => rec.observed.matchesReference), [true, true, true, true, true, true, true, true]);
  const broken = await runWorld({ mode: 'shared', exitCodes: { 1: 3 } }, { ...rep2, expect: 'shared', timeoutSec: 30 });
  assert.equal(broken.result.exitCode, 2, 'a failing baseline is exit 2 in control mode with repeat too');
  const evidence = structuredClone(result.evidence);
  evidence.baseline.close.exitCode = 1;
  const verdict = check.analyze({ expect: 'shared', baseline: evidence.baseline, concurrency: evidence.concurrency, scenario2: evidence.scenario2, forcedKill: false });
  assert.equal(verdict.detection.any, false);
  assert.ok(ids(verdict.failures).includes('CONTROL_DEFECT_NOT_DETECTED'));
  assert.ok(ids(verdict.failures).includes('BASELINE_FAILED'));
});

test('control mode: flaky signatures in the reverse order alone never pass the control (lost launches / GPU damage are only supplementary)', async () => {
  const lostB = launchPlan(2, [5000])['5000-r2']; // B-first attempt of a one-stagger run: launches 4 (A) and 5 (B)
  const { result } = await runWorld({ exitBeforeReady: [lostB.B] }, { ...rep2, expect: 'shared', staggers: only(5000, 'wrapper-spawn') });
  assert.equal(byName(result, 'concurrency-5000-r2').observed.signature, 'b-lost-a-survives');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(ids(result.failures), ['CONTROL_DEFECT_NOT_DETECTED']);
  assert.deepEqual([result.detection.supplementary, result.detection.structural], [true, false]);
});

test('observedSignature / closeOrderOf use the survivor of the record: B-first reads afterBExit* and A\'s baseline', () => {
  const ready = { outcome: 'ready' };
  const rec = {
    launchers: { A: ready, B: ready }, runDirShared: false, closeOrder: 'B-first',
    A: { baseline: { exists: true, ...FULL } }, B: { baseline: { exists: true, files: 5, bytes: 1000 } }, // B's own baseline is tiny: only the survivor's (A's) baseline shows the shrink
    afterAExit: { runDir: { exists: true, ...FULL } }, afterBExit: { runDir: { exists: true, ...REMAINS } }, afterBExitSettled: { runDir: { exists: true, ...FULL } },
  };
  const signature = check.observedSignature(rec);
  assert.equal(signature.name, 'shared-dir-runtime-shrinks');
  assert.match(signature.indicators[0], /after B closed, A's runtime went from/);
  assert.equal(check.observedSignature({ ...rec, closeOrder: 'A-first' }).name, 'isolated-ok', 'the same record read as A-first looks at afterAExit (intact)');
  const order = check.closeOrderOf(rec);
  assert.deepEqual([order.name, order.first, order.second, order.afterFirst === rec.afterBExit], ['B-first', 'B', 'A', true]);
  assert.equal(check.closeOrderOf({}).name, 'A-first');
  assert.equal(check.closeOrderOf({ closeOrder: 'whatever' }).name, 'A-first');
});

// ---- R2: per-file preservation (exact SET, not only count/bytes) --------------------------------------------------

const swapOne = (entries, from = 'locales/loc05.pak', to = 'locales/loc05.pak.bak') => entries.map((entry) => (entry.path === from ? { ...entry, path: to } : entry));
const swapMany = (entries, count) => entries.map((entry, index) => (/^locales\/loc/.test(entry.path) && index < count + 10 && entry.path.length < 18 ? { ...entry, path: `${entry.path}.x` } : entry)).sort((a, b) => (a.path < b.path ? -1 : 1));

test('evidence carries the per-file manifest: every runtime has a 78-file path+size digest, identical for A and B, unchanged in every observation', async () => {
  const { result } = await runWorld();
  const expected = payloadManifest.digestFileList(BASE_FILES, { withHash: false });
  assert.match(expected, hex64);
  assert.equal(result.evidence.baseline.instance.baselineManifest.digest, expected);
  for (const rec of result.evidence.concurrency) {
    for (const label of ['A', 'B']) assert.deepEqual(rec[label].baselineManifest, { fileCount: 78, digest: expected }, `${rec.name} ${label}`);
    for (const snapshot of [rec.bothRunning.A, rec.bothRunning.B, rec.afterAExit, rec.afterAExitSettled]) {
      assert.deepEqual([snapshot.manifest.digest, snapshot.manifest.fileCount, snapshot.manifest.diff], [expected, 78, null], rec.name);
    }
    assert.deepEqual(Object.keys(rec.A.baselineManifest), ['fileCount', 'digest'], 'only the digest goes into the evidence, not the 78-entry listing');
    assert.equal(rec.preservation.equal, true);
    assert.deepEqual([rec.preservation.survivor, rec.preservation.closedFirst, rec.preservation.baselineDigest], ['B', 'A', expected]);
    assert.deepEqual(rec.preservation.observations.map((entry) => entry.when), ['while both ran', 'after A exited', 'after settling']);
  }
  assert.equal(result.evidence.scenario2.C.baselineManifest.digest, expected);
  assert.equal(result.evidence.scenario2.preservation.equal, true);
  assert.equal(result.evidence.scenario2.preservation.survivor, 'C');
  assert.equal(result.evidence.concurrency[3].gpuRestart.after.manifest.digest, expected);
  assert.equal(JSON.stringify(result.evidence).includes('loc05.pak'), false, 'no per-file listing is serialized while nothing differs');
});

test('the survivor loses ONE file while count and bytes stay EQUAL: a count/bytes-only check passes it, the per-file set check FAILS it (CONC20000_B_FILESET_CHANGED_IMMEDIATE)', async () => {
  const world = { damageOnCleanup: { from: L.c20000.A, victim: L.c20000.B, to: { files: FULL.files, bytes: FULL.bytes, entries: swapOne(BASE_FILES) } } };
  const { result } = await runWorld(world);
  const rec = conc(result, 20000);
  assert.deepEqual(rec.afterAExit.runDir, { exists: true, ...FULL }, 'count and bytes are identical to the baseline: the old comparison saw nothing');
  assert.equal(check.statsEqual(rec.afterAExit.runDir, rec.B.baseline), true);
  assert.equal(result.exitCode, 1);
  const failed = ids(result.failures);
  assert.ok(failed.includes('CONC20000_B_FILESET_CHANGED_IMMEDIATE'), failed.join());
  assert.ok(failed.includes('CONC20000_B_FILESET_CHANGED_SETTLED'));
  assert.equal(failed.some((id) => id.includes('RUNTIME_CHANGED')), false, 'the counts did not change');
  const failure = result.failures.find((item) => item.id === 'CONC20000_B_FILESET_CHANGED_IMMEDIATE');
  assert.match(failure.message, /same 78 files \/ 503557201 B .*different per-file set/);
  assert.match(failure.message, /missing \(1\): locales\/loc05\.pak; extra \(1\): locales\/loc05\.pak\.bak/);
  assert.deepEqual(rec.afterAExit.manifest.diff.counts, { missing: 1, extra: 1, sizeMismatch: 0, hashMismatch: 0 });
  assert.equal(rec.preservation.equal, false);
  assert.match(rec.preservation.text, /per-file manifest CHANGED after A exited: [0-9a-f]{12} -> [0-9a-f]{12} missing \(1\)/);
  assert.equal(rec.observed.signature, 'other-failure', 'not a shrink, not shared: no defect signature is invented');
});

test('the same one-file swap in the survivor A of a B-first attempt fails with the R2 attempt prefix; control mode does not mistake a set-only change for a shrink', async () => {
  const { result } = await runWorld({ damageOnCleanup: { from: LP2['20000-r2'].B, victim: LP2['20000-r2'].A, to: { files: FULL.files, bytes: FULL.bytes, entries: swapOne(BASE_FILES) } } }, rep2);
  assert.ok(ids(result.failures).includes('CONC20000_R2_A_FILESET_CHANGED_IMMEDIATE'), ids(result.failures).join());
  assert.match(result.failures.find((item) => item.id === 'CONC20000_R2_A_FILESET_CHANGED_IMMEDIATE').message, /^A's runtime has the same/);
  const control = await runWorld({ damageOnCleanup: { from: L.c10000.A, victim: L.c10000.B, to: { files: FULL.files, bytes: FULL.bytes, entries: swapOne(BASE_FILES) } } }, { expect: 'shared', staggers: only(10000) });
  assert.equal(control.result.exitCode, 1, 'a swap with equal counts is not the old defect\'s shrink');
  assert.equal(control.result.detection.structural, false);
});

test('a lost file that also changes the count lists up to 10 missing paths in the RUNTIME_CHANGED failure (and the total)', async () => {
  const { result } = await runWorld({ damageOnCleanup: { from: L.c20000.A, victim: L.c20000.B, to: { files: 50, bytes: 400000000, entries: BASE_FILES.slice(0, 50) } } });
  const failure = result.failures.find((item) => item.id === 'CONC20000_B_RUNTIME_CHANGED_IMMEDIATE');
  assert.match(failure.message, /before 78 files \/ 503557201 B, now 50 files/);
  const listed = /missing \((\d+)\): (.*?), \+(\d+) more/.exec(failure.message);
  assert.equal(listed[1], '28');
  assert.equal(listed[2].split(', ').length, 10, 'exactly 10 paths are listed');
  assert.equal(listed[3], '18', 'and the rest is counted');
});

test('a swap of 12 files lists exactly 10 missing and 10 extra paths and counts the full 12', async () => {
  const swapped = BASE_FILES.map((entry) => (/^locales\/loc0[0-9]|^locales\/loc1[0-1]/.test(entry.path) ? { ...entry, path: `${entry.path}.bak` } : entry));
  const { result } = await runWorld({ damageOnCleanup: { from: L.c20000.A, victim: L.c20000.B, to: { files: FULL.files, bytes: FULL.bytes, entries: swapped } } });
  const rec = conc(result, 20000);
  assert.deepEqual(rec.afterAExit.manifest.diff.counts, { missing: 12, extra: 12, sizeMismatch: 0, hashMismatch: 0 });
  assert.equal(rec.afterAExit.manifest.diff.missing.length, 10);
  assert.equal(rec.afterAExit.manifest.diff.extra.length, 10);
  const failure = result.failures.find((item) => item.id === 'CONC20000_B_FILESET_CHANGED_IMMEDIATE');
  assert.match(failure.message, /missing \(12\): (?:[^,;]+, ){9}[^,;]+, \+2 more; extra \(12\): (?:[^,;]+, ){9}[^,;]+, \+2 more\./);
});

test('a file that keeps its name but changes its size (same total bytes elsewhere) is a FILESET change with a "size changed" entry', async () => {
  const resized = BASE_FILES.map((entry) => (entry.path === 'locales/loc01.pak' ? { ...entry, size: entry.size + 5 } : entry.path === 'locales/loc02.pak' ? { ...entry, size: entry.size - 5 } : entry));
  const { result } = await runWorld({ damageOnCleanup: { from: L.c20000.A, victim: L.c20000.B, to: { files: FULL.files, bytes: FULL.bytes, entries: resized } } });
  const failure = result.failures.find((item) => item.id === 'CONC20000_B_FILESET_CHANGED_IMMEDIATE');
  assert.ok(failure);
  assert.match(failure.message, /size changed \(2\): locales\/loc01\.pak \(\d+ -> \d+ B\), locales\/loc02\.pak/);
});

test('the file set is also compared while BOTH run (A touched by B\'s start) and after the injected GPU restart', async () => {
  const touched = await runWorld({ touchOnLaunch: { launch: L.c10000.B, victim: L.c10000.A } });
  assert.ok(ids(touched.result.failures).includes('CONC10000_A_RUNTIME_CHANGED_BOTH_RUNNING'));
  const evidence = await passingEvidence();
  c20(evidence).bothRunning.A.manifest.digest = 'f'.repeat(64);
  c20(evidence).bothRunning.B.manifest.digest = 'e'.repeat(64);
  c20(evidence).gpuRestart.after.manifest.digest = '0'.repeat(64);
  const verdict = check.analyze({ expect: 'isolated', ...evidence });
  assert.ok(ids(verdict.failures).includes('CONC20000_A_FILESET_CHANGED_BOTH_RUNNING'), ids(verdict.failures).join());
  assert.ok(ids(verdict.failures).includes('CONC20000_B_FILESET_CHANGED_BOTH_RUNNING'), ids(verdict.failures).join());
  assert.ok(ids(verdict.failures).includes('CONC20000_GPU_B_FILESET_CHANGED_AFTER_GPU'));
});

test('scenario 2: D must not change C\'s file set either (S2_C_FILESET_CHANGED_IMMEDIATE)', async () => {
  const { result } = await runWorld({ damageOnCleanup: { from: L.D, victim: L.C, to: { files: FULL.files, bytes: FULL.bytes, entries: swapOne(BASE_FILES) } } });
  assert.ok(ids(result.failures).includes('S2_C_FILESET_CHANGED_IMMEDIATE'), ids(result.failures).join());
  assert.equal(result.evidence.scenario2.preservation.equal, false);
});

test('backward compatibility: evidence WITHOUT manifests (older schema) is still judged by count/bytes; a missing observation manifest next to a recorded baseline manifest is NOT accepted', async () => {
  const legacy = await passingEvidence();
  const strip = (rec) => { for (const label of ['A', 'B']) delete rec[label].baselineManifest; for (const key of ['afterAExit', 'afterAExitSettled']) delete rec[key].manifest; for (const label of ['A', 'B']) delete rec.bothRunning[label].manifest; };
  legacy.concurrency.forEach(strip);
  delete legacy.scenario2.C.baselineManifest;
  for (const key of ['afterDExit', 'afterDExitSettled']) delete legacy.scenario2[key].manifest;
  for (const rec of legacy.concurrency) if (rec.gpuRestart) { delete rec.gpuRestart.after.manifest; delete rec.gpuRestart.afterSettled.manifest; }
  assert.deepEqual(check.analyze({ expect: 'isolated', ...legacy }).failures, []);
  const half = await passingEvidence();
  delete c20(half).afterAExit.manifest;
  const verdict = check.analyze({ expect: 'isolated', ...half });
  assert.ok(ids(verdict.failures).includes('CONC20000_B_FILESET_CHANGED_IMMEDIATE'));
  assert.match(verdict.failures.find((item) => item.id === 'CONC20000_B_FILESET_CHANGED_IMMEDIATE').message, /not recorded/);
});

test('describeDiff / preservationOf: wording and the "not observed in every step" case', () => {
  assert.equal(check.describeDiff(null), '');
  assert.equal(check.describeDiff({ counts: { missing: 0, extra: 0, sizeMismatch: 0, hashMismatch: 0 }, missing: [], extra: [], sizeMismatch: [], hashMismatch: [] }), '');
  assert.equal(check.describeDiff({ counts: { missing: 12, extra: 1, sizeMismatch: 0, hashMismatch: 1 }, missing: ['a', 'b'], extra: ['c'], sizeMismatch: [], hashMismatch: [{ path: 'd' }] }), ' missing (12): a, b, +10 more; extra (1): c; content changed (1): d.');
  const instance = { baselineManifest: { fileCount: 3, digest: 'ab'.repeat(32) } };
  assert.equal(check.preservationOf(instance, [['x', { manifest: { digest: 'ab'.repeat(32) } }], ['y', null]]).equal, null);
  assert.match(check.preservationOf(instance, [['x', { manifest: { digest: 'ab'.repeat(32) } }], ['y', null]]).text, /not observed in every step/);
  assert.equal(check.preservationOf(null, []), null);
});

// ---- R3: payload parity (unpacked build vs RUNNING extracted runtime) ----------------------------------------------

const MANIFEST_FILE = 'payload-manifest.json';
const goodManifest = makePayloadManifest();
const withManifest = (world = {}, manifest = goodManifest) => ({ ...world, jsonFiles: { ...(world.jsonFiles || {}), [MANIFEST_FILE]: manifest } });
const parityRun = (world = {}, options = {}, manifest = goodManifest) => runWorld(withManifest(world, manifest), { payloadManifest: MANIFEST_FILE, ...options });

test('payload parity passes when baseline, A and B of the first 20000 attempt equal the manifest file by file; only those three runtime directories are hashed, while running', async () => {
  const { world, result } = await parityRun({ hashCostMs: 4000 });
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  assert.equal(result.verdict, 'pass');
  assert.equal(world.hashCalls.length, 3, 'baseline, A and B of the first 20000-stagger attempt: nothing else is hashed');
  assert.deepEqual(world.hashCalls.map((call) => call.dir), [world.launches[L.baseline - 1].runDir, world.launches[L.c20000.A - 1].runDir, world.launches[L.c20000.B - 1].runDir]);
  assert.ok(world.hashCalls.every((call) => call.running === true && call.skipped === 0), 'the RUNNING runtime is hashed, in one pass');
  const evidence = result.evidence;
  assert.deepEqual(evidence.payload, {
    file: MANIFEST_FILE, schema: 'trace-payload-manifest/1', manifestDigest: goodManifest.manifestDigest, fileCount: 78, totalBytes: 503557201,
    exeSha256: goodManifest.exeSha256, asarSha256: goodManifest.asarSha256,
  });
  const parity = [evidence.baseline.payloadParity, conc(result, 20000).payloadParity.A, conc(result, 20000).payloadParity.B];
  for (const record of parity) {
    assert.equal(record.equal, true);
    assert.deepEqual([record.missingCount, record.extraCount, record.sizeMismatchCount, record.hashMismatchCount, record.unreadableCount], [0, 0, 0, 0, 0]);
    assert.equal(record.actual.manifestDigest, goodManifest.manifestDigest, 'digest recomputed from the hashed runtime equals the manifest digest');
    assert.equal(record.actual.exeSha256, goodManifest.exeSha256);
    assert.equal(record.actual.asarSha256, goodManifest.asarSha256);
    assert.deepEqual([record.actual.fileCount, record.actual.totalBytes], [78, 503557201]);
    assert.equal(record.attempts, 1);
    assert.ok(record.hashingMs >= 4000, 'hashing time is recorded');
    assert.match(record.text, /^identical to the payload manifest: 78 files \/ 503557201 B/);
  }
  assert.deepEqual(parity.map((record) => record.subject), ['baseline', 'A', 'B']);
  assert.equal(conc(result, 20000).parityTarget, true);
  assert.equal(result.evidence.concurrency.filter((rec) => rec.parityTarget).length, 1);
  assert.equal(evidence.payloadParity.passed, true);
  assert.deepEqual(evidence.payloadParity.subjects.map((subject) => [subject.subject, subject.equal]), [['baseline', true], ['concurrency-20000 A', true], ['concurrency-20000 B', true]]);
  assert.equal(evidence.payloadParity.manifestDigest, goodManifest.manifestDigest);
  // hashed BEFORE A is closed: both instances were alive for both calls (running flag) and the evidence order says so
  const timeline = evidence.timeline.map((entry) => entry.step);
  const at = timeline.indexOf('payload parity A');
  assert.ok(at !== -1 && at < timeline.indexOf('A: closed', at) && timeline.indexOf('payload parity B') < timeline.indexOf('A: closed', at));
  const summary = check.formatSummary(result);
  assert.match(summary, /payload manifest: payload-manifest\.json \(78 files, digest [0-9a-f]{12}\)/);
  assert.match(summary, /baseline payload parity: identical to the payload manifest/);
  assert.match(summary, /payload parity A: identical.*\n.*payload parity B: identical/);
  assert.match(summary, /payload parity: every checked runtime directory is identical to the payload manifest \(baseline=true, concurrency-20000 A=true, concurrency-20000 B=true\)/);
  assert.match(summary, /\n    C per-file manifest identical \(78 files, [0-9a-f]{12}\) after D exited \/ after settling\n/, 'the second-instance survivor C is covered in the summary too');
  assert.equal(JSON.stringify(evidence).toLowerCase().includes('commandline'), false);
});

test('with --repeat 2 the parity runs ONCE (first 20000 attempt); without --payload-manifest nothing is hashed and the behaviour is unchanged', async () => {
  const both = await parityRun({}, rep2);
  assert.equal(both.world.hashCalls.length, 3);
  assert.deepEqual(both.result.evidence.concurrency.filter((rec) => rec.payloadParity).map((rec) => rec.name), ['concurrency-20000-r1']);
  assert.equal(both.result.verdict, 'pass', JSON.stringify(both.result.failures));
  const plain = await runWorld({ parity: { corrupt: [{ launch: 1, path: 'resources/app.asar' }] } });
  assert.equal(plain.world.hashCalls.length, 0);
  assert.equal(plain.result.verdict, 'pass');
  assert.deepEqual([plain.result.evidence.payload, plain.result.evidence.payloadParity, plain.result.evidence.baseline.payloadParity], [null, null, null]);
  assert.equal(plain.result.evidence.options.payloadManifest, null);
  assert.equal(check.formatSummary(plain.result).includes('payload manifest: none (parity not requested)'), true);
});

for (const [name, subject, launch, id] of [
  ['the baseline runtime', 'BASELINE', L.baseline, 'PAYLOAD_PARITY_HASH_BASELINE'],
  ['A\'s runtime', 'A', L.c20000.A, 'PAYLOAD_PARITY_HASH_A'],
  ['B\'s runtime', 'B', L.c20000.B, 'PAYLOAD_PARITY_HASH_B'],
]) {
  test(`parity: ONE file of ${name} with the same size but a different SHA-256 fails exactly that subject (${id})`, async () => {
    const { result } = await parityRun({ parity: { corrupt: [{ launch, path: 'locales/loc05.pak' }] } });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(ids(result.failures), [id], 'nothing else fails: counts, sizes and every other file are identical');
    assert.match(result.failures[0].message, /1 file\(s\) have the same size but a different SHA-256 than the payload manifest: locales\/loc05\.pak\./);
    assert.equal(result.evidence.payloadParity.passed, false);
    assert.equal(result.evidence.payloadParity.subjects.filter((entry) => !entry.equal).length, 1);
  });
}

test('parity: a corrupted app.asar or exe is named by its own id and by the per-file hash mismatch; the evidence records the runtime hashes', async () => {
  const asar = (await parityRun({ parity: { corrupt: [{ launch: L.baseline, path: 'resources/app.asar' }] } })).result;
  assert.deepEqual(ids(asar.failures), ['PAYLOAD_PARITY_HASH_BASELINE', 'PAYLOAD_PARITY_ASAR_BASELINE']);
  assert.notEqual(asar.evidence.baseline.payloadParity.actual.asarSha256, goodManifest.asarSha256);
  assert.equal(asar.evidence.baseline.payloadParity.actual.exeSha256, goodManifest.exeSha256);
  assert.match(asar.failures[1].message, /resources\/app\.asar sha256 [0-9a-f]{64} differs from the manifest's [0-9a-f]{64}/);
  const exe = (await parityRun({ parity: { corrupt: [{ launch: L.c20000.B, path: 'TRACE Boardviewer.exe' }] } })).result;
  assert.deepEqual(ids(exe.failures), ['PAYLOAD_PARITY_HASH_B', 'PAYLOAD_PARITY_EXE_B']);
  assert.equal(exe.verdict, 'fail');
});

test('parity: a file missing from the running runtime, an extra file and a size difference are each reported with their paths', async () => {
  const without = (path) => (entries) => entries.filter((entry) => entry.path !== path);
  const missing = (await parityRun({ runtimeEntries: { [L.baseline]: without('locales/loc07.pak') } })).result;
  assert.ok(ids(missing.failures).includes('PAYLOAD_PARITY_MISSING_BASELINE'));
  assert.match(missing.failures.find((item) => item.id === 'PAYLOAD_PARITY_MISSING_BASELINE').message, /1 file\(s\) of the payload manifest are not in the running runtime directory: locales\/loc07\.pak\./);
  assert.equal(missing.evidence.baseline.payloadParity.missingCount, 1);
  assert.match(missing.evidence.baseline.payloadParity.text, /^DIFFERS from the payload manifest: missing 1, extra 0, size 0, content 0, unreadable 0 \(e\.g\. locales\/loc07\.pak\)$/);
  const extra = (await parityRun({ runtimeEntries: { [L.c20000.A]: (entries) => [...entries, { path: 'resources/injected.dll', size: 9 }] } })).result;
  assert.ok(ids(extra.failures).includes('PAYLOAD_PARITY_EXTRA_A'));
  assert.match(extra.failures.find((item) => item.id === 'PAYLOAD_PARITY_EXTRA_A').message, /resources\/injected\.dll/);
  const resized = (await parityRun({ runtimeEntries: { [L.c20000.B]: (entries) => entries.map((entry) => (entry.path === 'd3dcompiler_47.dll' ? { ...entry, size: entry.size + 1 } : entry)) } })).result;
  assert.ok(ids(resized.failures).includes('PAYLOAD_PARITY_SIZE_B'));
  assert.match(resized.failures.find((item) => item.id === 'PAYLOAD_PARITY_SIZE_B').message, /d3dcompiler_47\.dll \(\d+ -> \d+ B\)/);
  assert.deepEqual(resized.evidence.concurrency.find((rec) => rec.parityTarget).payloadParity.B.sizeMismatch.map((entry) => entry.path), ['d3dcompiler_47.dll']);
});

test('parity: more than 10 differing files list exactly 10 paths and the full count in the failure and in the evidence', async () => {
  const corrupt = BASE_FILES.filter((entry) => /^locales\/loc[0-1]\d\.pak$/.test(entry.path)).slice(0, 14).map((entry) => ({ launch: L.baseline, path: entry.path }));
  assert.equal(corrupt.length, 14);
  const { result } = await parityRun({ parity: { corrupt } });
  const failure = result.failures.find((item) => item.id === 'PAYLOAD_PARITY_HASH_BASELINE');
  assert.match(failure.message, /^The baseline instance: 14 file\(s\) have the same size but a different SHA-256 than the payload manifest: (?:locales\/loc\d\d\.pak, ){9}locales\/loc\d\d\.pak, \+4 more\.$/);
  assert.equal(result.evidence.baseline.payloadParity.hashMismatchCount, 14);
  assert.equal(result.evidence.baseline.payloadParity.hashMismatch.length, 10);
});

test('parity: an UNREADABLE file is reported explicitly after the bounded retry, never passed, never double-counted as missing (exit 1, not infrastructure)', async () => {
  const { world, result } = await parityRun({ parity: { unreadable: [{ launch: L.baseline, path: 'resources/app.asar' }] } }); // EBUSY forever
  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, 'fail');
  assert.ok(ids(result.failures).includes('PAYLOAD_PARITY_UNREADABLE_BASELINE'));
  assert.equal(ids(result.failures).includes('PAYLOAD_PARITY_MISSING_BASELINE'), false, 'reported as unreadable, not as missing');
  assert.match(result.failures.find((item) => item.id === 'PAYLOAD_PARITY_UNREADABLE_BASELINE').message, /1 file\(s\) could not be read after 3 attempt\(s\), so parity is NOT established for them: resources\/app\.asar \(EBUSY\)\./);
  const record = result.evidence.baseline.payloadParity;
  assert.deepEqual([record.attempts, record.unreadableCount, record.equal, record.actual.asarSha256], [3, 1, false, null]);
  assert.deepEqual(record.unreadable, [{ path: 'resources/app.asar', code: 'EBUSY' }]);
  const baselineCalls = world.hashCalls.filter((call) => call.dir === world.launches[0].runDir);
  assert.deepEqual(baselineCalls.map((call) => call.skipped), [0, 77, 77], 'retries only repeat what failed; 77 files are never re-hashed');
  assert.ok(baselineCalls[1].atMs - baselineCalls[0].atMs >= 2000, 'a pause between the attempts');
  assert.equal(result.evidence.baseline.passed, true, 'a parity problem is a finding, not a baseline infrastructure failure');
  assert.match(check.formatSummary(result), /baseline payload parity: DIFFERS from the payload manifest: missing 0, extra 0, size 0, content 0, unreadable 1 \(e\.g\. resources\/app\.asar\)/);
});

test('parity: a TRANSIENTLY unreadable file passes only when a re-read within the bounded attempts succeeds and its content equals the manifest; the recovery is recorded', async () => {
  const once = (await parityRun({ parity: { unreadable: [{ launch: L.baseline, path: 'resources/app.asar', failures: 1 }] } })).result;
  assert.equal(once.verdict, 'pass', JSON.stringify(once.failures));
  assert.deepEqual([once.evidence.baseline.payloadParity.attempts, once.evidence.baseline.payloadParity.recoveredAfterRetry, once.evidence.baseline.payloadParity.recoveredAfterRetryCount], [2, ['resources/app.asar'], 1]);
  assert.match(once.evidence.baseline.payloadParity.text, /\(1 file\(s\) needed a re-read\)/);
  const twice = (await parityRun({ parity: { unreadable: [{ launch: L.c20000.A, path: 'TRACE Boardviewer.exe', failures: 2 }] } })).result;
  assert.equal(twice.verdict, 'pass', JSON.stringify(twice.failures));
  assert.equal(conc(twice, 20000).payloadParity.A.attempts, 3);
  const thrice = (await parityRun({ parity: { unreadable: [{ launch: L.c20000.A, path: 'TRACE Boardviewer.exe', failures: 3 }] } })).result;
  assert.deepEqual(ids(thrice.failures).filter((id) => id.startsWith('PAYLOAD_PARITY')), ['PAYLOAD_PARITY_UNREADABLE_A', 'PAYLOAD_PARITY_EXE_A']);
  // a re-read that succeeds does NOT excuse a content difference
  const corrupt = (await parityRun({ parity: { unreadable: [{ launch: L.baseline, path: 'resources/app.asar', failures: 1 }], corrupt: [{ launch: L.baseline, path: 'resources/app.asar' }] } })).result;
  assert.deepEqual(ids(corrupt.failures), ['PAYLOAD_PARITY_HASH_BASELINE', 'PAYLOAD_PARITY_ASAR_BASELINE']);
});

test('parity: a content difference is final: the directory is hashed exactly once (no retry can turn a real mismatch into a pass)', async () => {
  const { world, result } = await parityRun({ parity: { corrupt: [{ launch: L.baseline, path: 'locales/loc01.pak' }] } });
  assert.equal(result.exitCode, 1);
  assert.equal(world.hashCalls.filter((call) => call.dir === world.launches[0].runDir).length, 1);
  assert.equal(result.evidence.baseline.payloadParity.attempts, 1);
});

test('parity attempts and delay are tunable but never below one attempt; a vanished runtime directory is PAYLOAD_PARITY_DIR_MISSING', async () => {
  const tuned = await runWorld(withManifest({ parity: { unreadable: [{ launch: L.baseline, path: 'resources/app.asar', failures: 4 }] } }), { payloadManifest: MANIFEST_FILE, tuning: { parityAttempts: 5 } });
  assert.equal(tuned.result.evidence.baseline.payloadParity.equal, true);
  assert.equal(tuned.result.evidence.baseline.payloadParity.attempts, 5);
  const single = await runWorld(withManifest({ parity: { unreadable: [{ launch: L.baseline, path: 'resources/app.asar', failures: 1 }] } }), { payloadManifest: MANIFEST_FILE, tuning: { parityAttempts: 0 } });
  assert.equal(single.result.evidence.baseline.payloadParity.attempts, 1, 'attempts are clamped to at least one');
  const evidence = await passingEvidence();
  evidence.baseline.payloadParity = { ...structuredClone(goodParity()), exists: false, runDir: 'X' };
  const verdict = check.analyze({ expect: 'isolated', ...evidence, payload: goodManifestSummary() });
  assert.ok(ids(verdict.failures).includes('PAYLOAD_PARITY_DIR_MISSING_BASELINE'));
});

// parity records built by the real evaluation function, for analyze-level tests
const goodManifestSummary = () => ({ manifestDigest: goodManifest.manifestDigest, exeSha256: goodManifest.exeSha256, asarSha256: goodManifest.asarSha256, fileCount: 78, totalBytes: 503557201 });
const goodParity = () => check.evaluatePayloadParity(goodManifest, { exists: true, files: goodManifest.files, unreadable: [] });
async function parityEvidence() {
  const evidence = await passingEvidence();
  evidence.baseline.payloadParity = { ...goodParity(), subject: 'baseline', runDir: 'x' };
  const target = c20(evidence);
  target.parityTarget = true;
  target.payloadParity = { A: { ...goodParity(), subject: 'A', runDir: 'a' }, B: { ...goodParity(), subject: 'B', runDir: 'b' } };
  return evidence;
}

test('analyze: the parity decisions on their own (every kind of difference, defence in depth against inconsistent records)', async () => {
  const clean = await parityEvidence();
  assert.deepEqual(check.analyze({ expect: 'isolated', ...clean, payload: goodManifestSummary() }).failures, []);
  const mutate = async (apply, payload = goodManifestSummary()) => {
    const evidence = await parityEvidence();
    apply(evidence);
    return ids(check.analyze({ expect: 'isolated', ...evidence, payload }).failures).filter((id) => id.startsWith('PAYLOAD_PARITY'));
  };
  assert.deepEqual(await mutate((e) => { e.baseline.payloadParity = null; }), ['PAYLOAD_PARITY_NOT_RUN_BASELINE']);
  assert.deepEqual(await mutate((e) => { delete c20(e).payloadParity.B; }), ['PAYLOAD_PARITY_NOT_RUN_B']);
  assert.deepEqual(await mutate((e) => { c20(e).parityTarget = false; }), ['PAYLOAD_PARITY_NOT_RUN_CONCURRENCY']);
  assert.deepEqual(await mutate((e) => { e.baseline.payloadParity.missingCount = 1; e.baseline.payloadParity.missing = ['a']; }), ['PAYLOAD_PARITY_MISSING_BASELINE']);
  assert.deepEqual(await mutate((e) => { c20(e).payloadParity.A.extraCount = 2; c20(e).payloadParity.A.extra = ['x', 'y']; }), ['PAYLOAD_PARITY_EXTRA_A']);
  assert.deepEqual(await mutate((e) => { c20(e).payloadParity.B.sizeMismatchCount = 1; c20(e).payloadParity.B.sizeMismatch = [{ path: 'p', expected: 1, actual: 2 }]; }), ['PAYLOAD_PARITY_SIZE_B']);
  assert.deepEqual(await mutate((e) => { e.baseline.payloadParity.hashMismatchCount = 1; e.baseline.payloadParity.hashMismatch = [{ path: 'p' }]; }), ['PAYLOAD_PARITY_HASH_BASELINE']);
  assert.deepEqual(await mutate((e) => { e.baseline.payloadParity.unreadableCount = 1; e.baseline.payloadParity.unreadable = [{ path: 'p', code: 'EBUSY' }]; }), ['PAYLOAD_PARITY_UNREADABLE_BASELINE']);
  assert.deepEqual(await mutate((e) => { e.baseline.payloadParity.actual.exeSha256 = 'f'.repeat(64); }), ['PAYLOAD_PARITY_EXE_BASELINE']);
  assert.deepEqual(await mutate((e) => { c20(e).payloadParity.A.actual.asarSha256 = null; }), ['PAYLOAD_PARITY_ASAR_A']);
  assert.deepEqual(await mutate((e) => { c20(e).payloadParity.B.actual.manifestDigest = 'e'.repeat(64); }), ['PAYLOAD_PARITY_DIGEST_B'], 'a digest that differs although no difference was recorded is itself a failure');
  assert.deepEqual(await mutate(() => {}, { ...goodManifestSummary(), manifestDigest: 'd'.repeat(64) }), ['PAYLOAD_PARITY_DIGEST_BASELINE', 'PAYLOAD_PARITY_DIGEST_A', 'PAYLOAD_PARITY_DIGEST_B'], 'a record computed against another manifest does not count');
  assert.deepEqual(await mutate(() => {}, null), [], 'without a payload manifest the parity is not judged (unchanged behaviour)');
});

test('evaluatePayloadParity: "equal" needs the recomputed digest AND the exe/app.asar hashes to match too, not only zero differences', () => {
  const files = goodManifest.files;
  assert.equal(check.evaluatePayloadParity(goodManifest, { exists: true, files, unreadable: [] }).equal, true);
  assert.equal(check.evaluatePayloadParity({ ...goodManifest, manifestDigest: 'f'.repeat(64) }, { exists: true, files, unreadable: [] }).equal, false);
  assert.equal(check.evaluatePayloadParity({ ...goodManifest, exeSha256: 'e'.repeat(64) }, { exists: true, files, unreadable: [] }).equal, false);
  assert.equal(check.evaluatePayloadParity({ ...goodManifest, asarSha256: 'd'.repeat(64) }, { exists: true, files, unreadable: [] }).equal, false);
  assert.equal(check.evaluatePayloadParity(goodManifest, { exists: false, files: [], unreadable: [] }).equal, false);
  assert.equal(check.formatParity(null), 'not run');
  assert.equal(check.formatParity({ exists: false }), 'runtime directory not found');
});

test('analyze: parity failures are informational in control mode (the control EXE is another build) - and the CLI refuses the combination up front', async () => {
  const evidence = await parityEvidence();
  evidence.baseline.payloadParity.hashMismatchCount = 1;
  const verdict = check.analyze({ expect: 'shared', ...evidence, payload: goodManifestSummary() });
  assert.equal(ids(verdict.failures).some((id) => id.startsWith('PAYLOAD_PARITY')), false);
  assert.throws(() => check.parseArgs(['--exe', 'a', '--expect', 'shared', '--payload-manifest', 'm.json']), /cannot be combined with --expect shared/);
  await assert.rejects(check.run(baseOptions({ expect: 'shared', payloadManifest: MANIFEST_FILE }), new FakeWindows(withManifest({ mode: 'shared' }))), check.UsageError);
  assert.equal(check.parseArgs(['--exe', 'a', '--payload-manifest', 'm.json']).payloadManifest, 'm.json');
  assert.equal(check.parseArgs(['--exe', 'a', '--payload-manifest=m.json']).payloadManifest, 'm.json');
  assert.equal(check.parseArgs(['--exe', 'a']).payloadManifest, null);
  assert.throws(() => check.parseArgs(['--exe', 'a', '--payload-manifest']), check.UsageError);
  assert.throws(() => check.parseArgs(['--exe', 'a', '--payload-manifest=']), check.UsageError);
});

test('an unusable payload manifest is an INFRASTRUCTURE failure (exit 2) before anything is launched: missing, unreadable, not JSON-valid, wrong schema, inconsistent digest, no exe/app.asar', async () => {
  const inconsistent = structuredClone(goodManifest);
  inconsistent.files[3].sha256 = 'f'.repeat(64);
  const noExe = payloadManifest.finalizeManifest(goodManifest.files.filter((entry) => entry.path !== 'TRACE Boardviewer.exe'));
  const noAsar = payloadManifest.finalizeManifest(goodManifest.files.filter((entry) => entry.path !== 'resources/app.asar'));
  for (const [name, world, pattern] of [
    ['file not found', {}, /cannot read the payload manifest payload-manifest\.json: file not found/],
    ['wrong schema', withManifest({}, { ...goodManifest, schema: 'other/1' }), /is not valid: schema is "other\/1"/],
    ['digest does not match the files', withManifest({}, inconsistent), /is not valid: .*manifestDigest does not match/],
    ['not an object', withManifest({}, ['x']), /is not valid: the manifest is not a JSON object/],
    ['no exe', withManifest({}, noExe), /lists no TRACE Boardviewer\.exe \/ resources\/app\.asar/],
    ['no app.asar', withManifest({}, noAsar), /lists no TRACE Boardviewer\.exe/],
  ]) {
    const { world: fake, result } = await runWorld(world, { payloadManifest: MANIFEST_FILE });
    assert.equal(result.exitCode, 2, name);
    assert.equal(result.verdict, 'infrastructure-failure', name);
    assert.equal(result.evidence.infrastructureError.step, 'read payload manifest', name);
    assert.match(result.evidence.infrastructureError.message, pattern, name);
    assert.equal(fake.launches.length, 0, `${name}: nothing was launched on top of an unusable manifest`);
    assert.deepEqual(result.failures, []);
  }
  const broken = new FakeWindows(withManifest());
  broken.readJsonFile = async () => ({ status: 'error', message: 'EACCES: denied' });
  const denied = await check.run(baseOptions({ payloadManifest: MANIFEST_FILE }), broken);
  assert.equal(denied.exitCode, 2);
  assert.match(denied.evidence.infrastructureError.message, /EACCES: denied/);
  const thrown = new FakeWindows(withManifest());
  thrown.readJsonFile = async () => { throw new Error('boom'); };
  assert.equal((await check.run(baseOptions({ payloadManifest: MANIFEST_FILE }), thrown)).exitCode, 2);
});

test('payload parity and the other new decisions keep a running hash within the global time budget (exit 2 when exhausted, never a hang)', async () => {
  const { result } = await parityRun({ hashCostMs: 30000 }, { maxTotalSec: 60 });
  assert.equal(result.exitCode, 2);
  assert.match(result.evidence.infrastructureError.message, /global time budget of 60 s exhausted/);
});

test('main: --repeat and --payload-manifest are wired through the CLI (exit 0, evidence options, summary lines)', async () => {
  const cli = cliDeps(new FakeWindows(withManifest()));
  const code = await check.main(['--exe', EXE, '--repeat', '2', '--payload-manifest', MANIFEST_FILE, '--out', 'e.json', '--max-total-sec', '2100'], cli.deps);
  assert.equal(code, 0, cli.lines.join('\n'));
  const evidence = JSON.parse(cli.written[0].text);
  assert.deepEqual([evidence.schema, evidence.options.repeat, evidence.options.payloadManifest, evidence.options.maxTotalSec], ['trace-portable-isolation-evidence/3', 2, MANIFEST_FILE, 2100]);
  assert.equal(evidence.concurrency.length, 8);
  assert.equal(evidence.payloadParity.passed, true);
  assert.equal(evidence.forwardedBoardRecorded, true);
  const summary = cli.lines.join('\n');
  assert.match(summary, /repeat=2/);
  assert.match(summary, /forwardedBoardRecorded=true/);
  assert.match(summary, /payload parity: every checked runtime directory is identical/);
  const infra = cliDeps(new FakeWindows());
  assert.equal(await check.main(['--exe', EXE, '--payload-manifest', MANIFEST_FILE], infra.deps), 2, 'a manifest that is not there is exit 2');
  const usage = cliDeps(new FakeWindows());
  assert.equal(await check.main(['--exe', EXE, '--repeat', '0'], usage.deps), 2);
  assert.match(usage.errors.join('\n'), /--repeat must be a whole number between 1 and 10/);
});

// ---- R4: the forwarded board must have been DELIVERED (C's config store lists it) ----------------------------------

test('forwarding proof: after C closed normally C\'s config store lists the synthetic board; it was not recorded before D; C started WITHOUT a board argument', async () => {
  const { world, result } = await runWorld();
  assert.equal(result.verdict, 'pass', JSON.stringify(result.failures));
  const s2 = result.evidence.scenario2;
  assert.equal(result.evidence.forwardedBoardRecorded, true);
  assert.equal(s2.forwardedBoardRecorded, true);
  const fb = s2.forwardedBoard;
  assert.deepEqual([fb.recorded, fb.status, fb.preDRecorded, fb.preDStatus, fb.recordedBeforeClose], [true, 'ok', false, 'missing', true]);
  assert.equal(fb.recentCount, 1);
  assert.equal(path.basename(fb.matchedPath), 'synthetic-board.cad');
  assert.equal(fb.configFile, path.join(world.launches[L.C - 1].profile, 'config.json'), 'the config store lives in the profile that C and D share');
  assert.match(fb.text, /lists the synthetic board \(synthetic-board\.cad, 1 recent board\(s\)\); it was not yet recorded before D started/);
  assert.deepEqual(s2.preD, { status: 'missing', recorded: false, recentCount: null });
  // ordering facts: the board existed before ANY instance of the scenario started, and C was started without it
  const boardFile = path.join(world.areas[5], 'synthetic-board.cad');
  assert.ok(world.writeTimes.get(boardFile) <= world.launches[L.C - 1].launchedAt, 'board written before C starts');
  assert.deepEqual(world.launches[L.C - 1].args, [`--user-data-dir=${world.launches[L.C - 1].profile}`], 'C has no board argument');
  assert.deepEqual(world.launches[L.D - 1].args, [`--user-data-dir=${world.launches[L.C - 1].profile}`, boardFile]);
  assert.deepEqual(s2.board, { name: 'synthetic-board.cad', bytes: Buffer.byteLength(check.SYNTHETIC_BOARD), sha256: crypto.createHash('sha256').update(check.SYNTHETIC_BOARD, 'utf8').digest('hex') });
  assert.equal(world.written.get(boardFile), check.SYNTHETIC_BOARD, 'only the original synthetic board is ever written');
  assert.equal(JSON.stringify(result.evidence).includes('C:\\Users\\John'), false);
  assert.match(check.formatSummary(result), /forwardedBoardRecorded=true: C's config\.json lists the synthetic board/);
});

test('forwarding proof: a board that D "forwarded" but C never recorded FAILS the isolated mode with S2_FORWARDED_BOARD_NOT_RECORDED (D exit 0 and everything else green)', async () => {
  const absent = await runWorld({ forwardNotRecorded: true });
  assert.equal(absent.result.exitCode, 1);
  assert.deepEqual(ids(absent.result.failures), ['S2_FORWARDED_BOARD_NOT_RECORDED']);
  assert.equal(absent.result.evidence.scenario2.D.exitCode, 0);
  assert.equal(absent.result.evidence.forwardedBoardRecorded, false);
  assert.match(absent.result.failures[0].message, /config store \(.*config\.json\) does not list the synthetic board forwarded by D \(config\.json does not exist\)/);
  assert.equal(absent.result.evidence.scenario2.forwardedBoard.waitedForRecordMs >= 10000, true, 'a bounded wait before C is closed, then the verdict');
  const empty = await runWorld({ forwardNotRecorded: true, configAtStart: true });
  assert.deepEqual(ids(empty.result.failures), ['S2_FORWARDED_BOARD_NOT_RECORDED']);
  assert.match(empty.result.failures[0].message, /recentBoards is empty/);
  const other = await runWorld({ forwardRecordedPath: () => 'C:\\Boards\\other-board.cad' });
  assert.deepEqual(ids(other.result.failures), ['S2_FORWARDED_BOARD_NOT_RECORDED']);
  assert.match(other.result.failures[0].message, /1 recent board\(s\), none is the synthetic board \(other-board\.cad\)/);
  assert.match(check.formatSummary(absent.result), /forwardedBoardRecorded=false: NOT recorded: config\.json does not exist/);
});

test('forwarding proof: the board is matched case-insensitively and separator-tolerantly (Windows), canonical or 8.3 spelling through the canonicalisation helper', async () => {
  for (const spell of [(board) => board.toUpperCase(), (board) => board.replace(/\//g, '\\'), (board) => board.toLowerCase().replace(/\//g, '\\')]) {
    const { result } = await runWorld({ forwardRecordedPath: spell });
    assert.equal(result.evidence.forwardedBoardRecorded, true, spell.toString());
    assert.equal(result.verdict, 'pass', JSON.stringify(result.failures));
  }
  const canonicalize = async (target) => target.replace(/RUNNER~1/i, 'runneradmin');
  const board = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\trace-portable-isolation-ab12\\synthetic-board.cad';
  const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\trace-portable-isolation-ab12\\synthetic-board.cad';
  const config = (recorded) => ({ version: 1, settings: {}, recentBoards: [{ name: 'x', path: recorded, openedAt: '2026-10-05T12:00:00.000Z' }] });
  assert.equal((await check.findForwardedBoard(config(short), board, canonicalize)).found, true, 'recorded 8.3 spelling, requested long spelling');
  assert.equal((await check.findForwardedBoard(config(board), short, canonicalize)).found, true, 'requested 8.3 spelling, recorded long spelling');
  assert.equal((await check.findForwardedBoard(config(board.toUpperCase()), board, canonicalize)).found, true);
  assert.equal((await check.findForwardedBoard(config(board.replace(/\\/g, '/')), board, canonicalize)).found, true);
  assert.equal((await check.findForwardedBoard(config(board.replace('ab12', 'cd34')), board, canonicalize)).found, false, 'another directory is another board');
  assert.equal((await check.findForwardedBoard(config(`${board}.bak`), board, canonicalize)).found, false);
  assert.equal((await check.findForwardedBoard(config(board), board, async () => { throw new Error('realpath failed'); })).found, true, 'a failing canonicalisation falls back to the plain spelling');
});

test('findForwardedBoard: garbage configs are "not found" with a reason, never a throw or a false positive', async () => {
  const canonicalize = async (target) => target;
  for (const [config, reason] of [[null, /no recentBoards list/], [{}, /no recentBoards list/], [{ recentBoards: 'x' }, /no recentBoards list/], [{ recentBoards: [] }, /recentBoards is empty/], [{ recentBoards: [null, {}, { path: 5 }, { path: '' }] }, /recentBoards is empty/]]) {
    const found = await check.findForwardedBoard(config, 'C:\\a\\synthetic-board.cad', canonicalize);
    assert.equal(found.found, false, JSON.stringify(config));
    assert.match(found.reason, reason);
  }
  const mixed = await check.findForwardedBoard({ recentBoards: [null, { path: 'C:\\other.cad' }, { path: 'C:\\a\\Synthetic-Board.CAD' }] }, 'C:\\a\\synthetic-board.cad', canonicalize);
  assert.deepEqual([mixed.found, mixed.matchedPath, mixed.recentCount], [true, 'C:\\a\\Synthetic-Board.CAD', 2]);
});

test('forwarding proof: a board already recorded BEFORE D started proves nothing (S2_FORWARDED_BOARD_PRERECORDED)', async () => {
  const { result } = await runWorld({ preRecorded: true });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(ids(result.failures), ['S2_FORWARDED_BOARD_PRERECORDED']);
  assert.equal(result.evidence.scenario2.forwardedBoard.preDRecorded, true);
  assert.equal(result.evidence.forwardedBoardRecorded, true);
  const stale = await runWorld({ preRecorded: true, forwardNotRecorded: true });
  assert.deepEqual(ids(stale.result.failures).sort(), ['S2_FORWARDED_BOARD_NOT_RECORDED', 'S2_FORWARDED_BOARD_PRERECORDED'].sort().filter((id) => id !== 'S2_FORWARDED_BOARD_NOT_RECORDED'), 'a pre-recorded board still counts as listed after C closed, but the proof is void');
});

test('forwarding proof: C needs a moment to record the board: a record that appears within the bounded wait passes, one that never appears fails; the wait is bounded by forwardWaitMs', async () => {
  const late = await runWorld({ forwardRecordDelayMs: 9000 });
  assert.equal(late.result.verdict, 'pass', JSON.stringify(late.result.failures));
  assert.ok(late.result.evidence.scenario2.forwardedBoard.waitedForRecordMs > 0 && late.result.evidence.scenario2.forwardedBoard.waitedForRecordMs < 10000);
  assert.equal(late.result.evidence.scenario2.forwardedBoard.recordedBeforeClose, true);
  const never = await runWorld({ forwardRecordDelayMs: 90000 });
  assert.deepEqual(ids(never.result.failures), ['S2_FORWARDED_BOARD_NOT_RECORDED']);
  const waited = never.result.evidence.scenario2.forwardedBoard.waitedForRecordMs;
  assert.ok(waited >= 10000 && waited < 12000, `bounded wait: ${waited}`);
  const quick = await runWorld({ forwardRecordDelayMs: 90000 }, { tuning: { forwardWaitMs: 1000 } });
  assert.ok(quick.result.evidence.scenario2.forwardedBoard.waitedForRecordMs < 3000, 'the bound is a tuning value');
});

test('forwarding proof: the verdict rests on the config store AFTER C closed normally (a record seen while C ran but gone afterwards fails)', async () => {
  const { result } = await runWorld({ onFinish: (world, wrapper) => { if (wrapper.index === L.C) world.jsonFiles.delete(path.join(wrapper.profile, 'config.json')); } });
  const fb = result.evidence.scenario2.forwardedBoard;
  assert.deepEqual([fb.recordedBeforeClose, fb.recorded, fb.readAfterCloseOfExitedC], [true, false, true]);
  assert.deepEqual(ids(result.failures), ['S2_FORWARDED_BOARD_NOT_RECORDED']);
  assert.equal(result.evidence.forwardedBoardRecorded, false);
  assert.equal(result.evidence.scenario2.forwardedBoardRecorded, false, 'the scenario-level field is the post-close verdict too');
});

test('forwarding proof: an unreadable config store is re-read (transient), a persistently unreadable one is reported (never a pass); the pre-D read problem is not an assertion', async () => {
  const transient = await runWorld({ configReadErrors: 1 });
  assert.equal(transient.result.verdict, 'pass', JSON.stringify(transient.result.failures));
  assert.deepEqual([transient.result.evidence.scenario2.forwardedBoard.preDStatus, transient.result.evidence.scenario2.forwardedBoard.preDRecorded], ['error', null], 'the first (pre-D) read failed: unknown, not "recorded"');
  const finalOnce = (errors) => ({ onFinish: (world, wrapper) => { if (wrapper.index === L.C) world.opts.configReadErrors = errors; } }); // errors hit the read AFTER C closed
  const rereadOnce = await runWorld(finalOnce(1));
  assert.equal(rereadOnce.result.verdict, 'pass', JSON.stringify(rereadOnce.result.failures));
  assert.equal(rereadOnce.result.evidence.scenario2.forwardedBoard.status, 'ok');
  const rereadTwice = await runWorld(finalOnce(2));
  assert.equal(rereadTwice.result.verdict, 'pass', 'initial read + two re-reads');
  const rereadNever = await runWorld(finalOnce(3));
  assert.deepEqual(ids(rereadNever.result.failures), ['S2_FORWARDED_BOARD_NOT_RECORDED'], 'a store that stays unreadable is never a pass');
  const broken = await runWorld({ configReadErrors: 100000 });
  assert.equal(broken.result.exitCode, 1);
  assert.deepEqual(ids(broken.result.failures), ['S2_FORWARDED_BOARD_NOT_RECORDED']);
  assert.match(broken.result.failures[0].message, /\(config\.json could not be read \(EBUSY: simulated\)\)/);
  assert.equal(broken.result.evidence.scenario2.forwardedBoard.status, 'error');
});

test('forwarding proof in CONTROL mode is recorded but informational; analyze flags a missing delivery check explicitly (S2_FORWARDED_BOARD_NOT_CHECKED)', async () => {
  const { result } = await runWorld({ mode: 'shared', forwardNotRecorded: true }, { expect: 'shared' });
  assert.equal(result.exitCode, 0, JSON.stringify(result.failures));
  assert.equal(result.evidence.forwardedBoardRecorded, false);
  assert.ok(result.observations.some((item) => item.id === 'S2_FORWARDED_BOARD_NOT_RECORDED' && item.expectedInControlMode === true));
  const evidence = await passingEvidence();
  delete evidence.scenario2.forwardedBoard;
  assert.ok(ids(check.analyze({ expect: 'isolated', ...evidence }).failures).includes('S2_FORWARDED_BOARD_NOT_CHECKED'));
  const notRecorded = await passingEvidence();
  notRecorded.scenario2.forwardedBoard.recorded = false;
  notRecorded.scenario2.forwardedBoard.reason = 'x';
  assert.deepEqual(ids(check.analyze({ expect: 'isolated', ...notRecorded }).failures), ['S2_FORWARDED_BOARD_NOT_RECORDED']);
  const pre = await passingEvidence();
  pre.scenario2.forwardedBoard.preDRecorded = true;
  assert.deepEqual(ids(check.analyze({ expect: 'isolated', ...pre }).failures), ['S2_FORWARDED_BOARD_PRERECORDED']);
  const unknown = await passingEvidence();
  unknown.scenario2.forwardedBoard.preDRecorded = null;
  assert.deepEqual(check.analyze({ expect: 'isolated', ...unknown }).failures, [], 'an unreadable pre-D store alone is not an assertion');
});

test('a D that never exits by itself does not get a forwarding verdict (the S2_D_NOT_SELF_EXIT failure already stands alone)', async () => {
  const world = new FakeWindows({ dStaysRunning: true });
  const result = await check.run(baseOptions({ timeoutSec: 20 }), world);
  assert.deepEqual(ids(result.failures), ['S2_D_NOT_SELF_EXIT']);
  assert.equal(result.evidence.forwardedBoardRecorded, null);
  assert.equal(result.evidence.scenario2.forwardedBoard, undefined);
});

// ---- real-platform building blocks (no Windows needed) ----------------------------------------------------------

test('readJsonFileOf: ok / missing / invalid JSON / BOM / too large / not a file / EBUSY are returned as data, never thrown', async () => {
  const fakeFs = (behaviour) => ({
    stat: async () => { if (behaviour.statError) throw Object.assign(new Error(behaviour.statError), { code: behaviour.statError }); return { isFile: () => behaviour.isFile !== false, size: behaviour.size ?? (behaviour.text ?? '').length }; },
    readFile: async () => { if (behaviour.readError) throw Object.assign(new Error(behaviour.readError), { code: behaviour.readError }); return behaviour.text; },
  });
  assert.deepEqual(await check.readJsonFileOf('x', { fsModule: fakeFs({ text: '{"a":1}' }) }), { status: 'ok', value: { a: 1 } });
  assert.deepEqual(await check.readJsonFileOf('x', { fsModule: fakeFs({ text: '\uFEFF{"a":2}' }) }), { status: 'ok', value: { a: 2 } });
  assert.deepEqual(await check.readJsonFileOf('x', { fsModule: fakeFs({ statError: 'ENOENT' }) }), { status: 'missing' });
  assert.equal((await check.readJsonFileOf('x', { fsModule: fakeFs({ statError: 'EBUSY' }) })).status, 'error');
  assert.match((await check.readJsonFileOf('x', { fsModule: fakeFs({ readError: 'EACCES', text: '' }) })).message, /EACCES/);
  assert.match((await check.readJsonFileOf('x', { fsModule: fakeFs({ text: '{broken' }) })).message, /invalid JSON/);
  assert.match((await check.readJsonFileOf('x', { fsModule: fakeFs({ isFile: false }) })).message, /not a regular file/);
  assert.match((await check.readJsonFileOf('x', { fsModule: fakeFs({ size: 99, text: '{}' }), maxBytes: 10 })).message, /larger than 10 B/);
});

test('the real node platform: dirManifest, hashTree and readJsonFile on a temp tree agree with dirStats and with scripts/payload-manifest.cjs', async () => {
  const base = await fsp.realpath(os.tmpdir());
  const root = await fsp.mkdtemp(path.join(base, 'portable-iso-platform-'));
  try {
    const files = { 'TRACE Boardviewer.exe': Buffer.alloc(300, 1), 'resources/app.asar': Buffer.alloc(200, 2), 'locales/en.pak': Buffer.alloc(10, 3) };
    for (const [name, data] of Object.entries(files)) { await fsp.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fsp.writeFile(path.join(root, name), data); }
    await fsp.writeFile(path.join(root, 'config.json'), JSON.stringify({ version: 1, recentBoards: [] }));
    const platform = check.createNodePlatform({ tmpdir: () => base });
    const listing = await platform.dirManifest(root);
    assert.deepEqual(listing.files.map((entry) => entry.path), ['TRACE Boardviewer.exe', 'config.json', 'locales/en.pak', 'resources/app.asar']);
    const stats = await platform.dirStats(root);
    assert.deepEqual(stats, { exists: true, files: listing.files.length, bytes: listing.files.reduce((total, entry) => total + entry.size, 0) }, 'counts and the per-file listing come from ONE walk');
    assert.deepEqual(await platform.dirManifest(path.join(root, 'nope')), { exists: false, files: [] });
    const hashed = await platform.hashTree(root);
    assert.equal(hashed.unreadable.length, 0);
    assert.equal(hashed.files.find((entry) => entry.path === 'resources/app.asar').sha256, crypto.createHash('sha256').update(files['resources/app.asar']).digest('hex'));
    const again = await platform.hashTree(root, { skip: new Set(hashed.files.map((entry) => entry.path)) });
    assert.deepEqual(again.files, []);
    assert.deepEqual(await platform.hashTree(path.join(root, 'nope')), { exists: false, files: [], unreadable: [] });
    assert.deepEqual(await platform.readJsonFile(path.join(root, 'config.json')), { status: 'ok', value: { version: 1, recentBoards: [] } });
    assert.deepEqual(await platform.readJsonFile(path.join(root, 'missing.json')), { status: 'missing' });
    assert.equal((await platform.readJsonFile(root)).status, 'error', 'a directory is not a JSON file');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---- R5: evidence schema 3 and the workflow wiring (static) ----------------------------------------------------

test('evidence schema 3 keeps every schema-2 field and adds repeat / closeOrder / preservation / payloadParity / forwardedBoardRecorded', async () => {
  const { result } = await runWorld({}, { repeat: 2 });
  const evidence = JSON.parse(JSON.stringify(result.evidence));
  assert.equal(check.SCHEMA, 'trace-portable-isolation-evidence/3');
  for (const key of ['schema', 'tool', 'options', 'localReference', 'exe', 'tempAreas', 'baseline', 'concurrency', 'scenario2', 'forcedKill', 'cleanupKilled', 'cleanupKilledPids', 'cleanup', 'detection', 'failures', 'observations', 'verdict', 'exitCode', 'infrastructureError', 'timeline']) assert.ok(key in evidence, `schema-2 field ${key} is still there`);
  for (const key of ['repeat', 'payload', 'payloadParity', 'forwardedBoardRecorded']) assert.ok(key in evidence, `new field ${key}`);
  for (const rec of evidence.concurrency) {
    for (const key of ['name', 'stagger', 'injectGpu', 'launchers', 'A', 'B', 'runDirShared', 'bothRunning', 'aClose', 'afterAExit', 'afterAExitSettled', 'settleMs', 'gpuRestart', 'bClose', 'observed']) assert.ok(key in rec, `schema-2 field ${key} of ${rec.name}`);
    for (const key of ['attempt', 'closeOrder', 'closedFirst', 'survivor', 'afterBExit', 'afterBExitSettled', 'preservation', 'payloadParity', 'parityTarget']) assert.ok(key in rec, `new field ${key} of ${rec.name}`);
  }
  assert.ok('baselineManifest' in evidence.baseline.instance && 'payloadParity' in evidence.baseline);
  assert.deepEqual(evidence.options, { expect: 'isolated', timeoutSec: 120, maxTotalSec: 1500, staggers: evidence.options.staggers, repeat: 2, payloadManifest: null });
  assert.ok('preD' in evidence.scenario2 && 'forwardedBoard' in evidence.scenario2 && 'preservation' in evidence.scenario2);
});

const WORKFLOW = require('node:fs').readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'windows.yml'), 'utf8').replace(/\r\n/g, '\n');
const jobBlock = (name) => {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.ok(start !== -1, `job ${name}`);
  const next = WORKFLOW.slice(start + 1).search(/\n  [a-z][a-z-]*:\n/);
  return WORKFLOW.slice(start, next === -1 ? undefined : start + 1 + next);
};
const stepIndex = (block, title) => { const at = block.indexOf(`- name: ${title}\n`); assert.ok(at !== -1, `step "${title}"`); return at; };

test('windows.yml (static): the build job creates the payload manifest between the checksum step and the EXE upload, outside release/, and uploads it as its own artifact; the release artifact step is untouched', () => {
  const build = jobBlock('build');
  const checksum = stepIndex(build, 'Generate EXE checksum');
  const manifest = stepIndex(build, 'Generate payload manifest of the unpacked app');
  const exeUpload = stepIndex(build, 'Upload portable EXE and checksum');
  const manifestUpload = stepIndex(build, 'Upload payload manifest');
  assert.ok(checksum < manifest && manifest < exeUpload && exeUpload < manifestUpload, 'order: checksum, manifest, EXE upload, manifest upload');
  const manifestStep = build.slice(manifest, exeUpload);
  assert.match(manifestStep, /Test-Path -LiteralPath \$traceUnpacked -PathType Container/);
  assert.match(manifestStep, /\$traceUnpacked = Join-Path release 'win-unpacked'/);
  assert.match(manifestStep, /throw "release\/win-unpacked is missing/);
  assert.match(manifestStep, /node scripts\/payload-manifest\.cjs --dir \$traceUnpacked --out payload-manifest\.json/);
  assert.match(manifestStep, /\$LASTEXITCODE -ne 0/);
  assert.match(manifestStep, /exeSha256 -or -not \$traceManifest\.asarSha256/);
  assert.equal(/--out release/.test(manifestStep), false, 'the manifest is written OUTSIDE release/');
  const upload = build.slice(manifestUpload);
  assert.match(upload, /name: portable-payload-manifest-\$\{\{ steps\.metadata\.outputs\.version \}\}\n\s+path: payload-manifest\.json\n\s+if-no-files-found: error\n\s+retention-days: 14\n\s+overwrite: true/);
  // the existing release artifact: byte-for-byte as before
  assert.ok(build.includes(`      - name: Upload portable EXE and checksum
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
        with:
          name: \${{ steps.metadata.outputs.artifact_name }}
          path: |
            release/TRACE-Boardviewer-\${{ steps.metadata.outputs.version }}.exe
            release/TRACE-Boardviewer-\${{ steps.metadata.outputs.version }}.exe.sha256
          if-no-files-found: error
          compression-level: 0
          retention-days: 14
`));
  assert.ok(build.includes(`      - name: Generate EXE checksum
        env:
          TRACE_VERSION: \${{ steps.metadata.outputs.version }}
        run: |
          $traceExe = Join-Path release "TRACE-Boardviewer-$env:TRACE_VERSION.exe"
          if (-not (Test-Path -LiteralPath $traceExe -PathType Leaf)) { throw 'Portable EXE is missing.' }
          $traceHash = (Get-FileHash -LiteralPath $traceExe -Algorithm SHA256).Hash.ToLowerInvariant()
          "$traceHash  $([IO.Path]::GetFileName($traceExe))" | Set-Content -LiteralPath "$traceExe.sha256" -Encoding ascii
`));
});

test('windows.yml (static): the measurement job is measurement only (needs build, gates nothing, 20 attempts at 0/2/10/40 ms + 20 second-instance launches on the verified EXE); the control job measures the old wrapper the same way, after its gate', () => {
  const measurement = jobBlock('portable-startup-measurement');
  assert.match(measurement, /needs: build\n/);
  assert.match(measurement, /timeout-minutes: 60\n/);
  assert.match(measurement, /MEASUREMENT ONLY, never a gate/);
  const verify = stepIndex(measurement, 'Verify the downloaded EXE is the uploaded payload');
  const measure = stepIndex(measurement, 'Measure startup race and second-instance leftovers');
  assert.ok(verify < measure, 'the EXE is verified against its .sha256 before it is measured');
  const measureStep = measurement.slice(measure, stepIndex(measurement, 'Show startup measurement summary'));
  assert.match(measureStep, /node scripts\/measure-portable-startup\.cjs --exe "release\/TRACE-Boardviewer-\$env:TRACE_VERSION\.exe" --staggers 0,2,10,40 --attempts 20 --second-instance 20 --label fixed --out portable-startup-measurement\.json --max-total-sec 3000\n/);
  assert.match(measurement, /name: portable-startup-measurement-\$\{\{ needs\.build\.outputs\.version \}\}\n\s+path: portable-startup-measurement\.json\n/);
  const release = jobBlock('draft-release');
  assert.match(release, /needs: \[build, portable-isolation, mac\]\n/, 'the measurement never gates the release');
  assert.equal(/portable-startup-measurement/.test(release), false);
  assert.equal(/portable-startup-measurement/.test(jobBlock('portable-isolation')), false, 'the isolation gate is unchanged');
  const control = jobBlock('portable-isolation-control');
  const controlMeasure = stepIndex(control, "Measure the CONTROL wrapper's startup race (measurement only, never a gate)");
  assert.ok(controlMeasure > stepIndex(control, 'Check that the control EXE is detected as defective'), 'the control gate runs first');
  const controlMeasureStep = control.slice(controlMeasure, stepIndex(control, 'Show CONTROL startup measurement summary'));
  assert.match(controlMeasureStep, /if: always\(\)\n/);
  assert.match(controlMeasureStep, /--staggers 0,2,10,40 --attempts 20 --second-instance 0 --label control --out portable-startup-measurement-control\.json --max-total-sec 1500\n/);
  assert.match(control, /name: portable-startup-measurement-control\n\s+path: portable-startup-measurement-control\.json\n/);
});

test('windows.yml (static): the isolation job downloads the payload manifest artifact and passes --repeat 2 --payload-manifest with the 2100 s budget inside a 45 minute job; the control runs --repeat 2 (no manifest) inside 75 minutes (its gate plus the startup measurement)', () => {
  const isolation = jobBlock('portable-isolation');
  assert.match(isolation, /timeout-minutes: 45\n/);
  const download = stepIndex(isolation, 'Download payload manifest');
  assert.ok(download > stepIndex(isolation, 'Download build artifact') && download < stepIndex(isolation, 'Check portable instance isolation'));
  assert.match(isolation.slice(download, download + 400), /name: portable-payload-manifest-\$\{\{ needs\.build\.outputs\.version \}\}\n\s+path: payload-manifest\n/);
  const check = isolation.slice(stepIndex(isolation, 'Check portable instance isolation'), stepIndex(isolation, 'Show Portable instance isolation summary'));
  assert.match(check, /--repeat 2/);
  assert.match(check, /--payload-manifest "payload-manifest\/payload-manifest\.json"/);
  assert.match(check, /--max-total-sec 2100/);
  assert.equal(/--expect/.test(check), false);
  assert.match(isolation, /Verify the downloaded payload manifest/);
  const control = jobBlock('portable-isolation-control');
  assert.match(control, /timeout-minutes: 75\n/);
  const controlCheck = control.slice(stepIndex(control, 'Check that the control EXE is detected as defective'), stepIndex(control, 'Show Portable isolation CONTROL (old shared-directory build) summary'));
  assert.match(controlCheck, /--expect shared/);
  assert.match(controlCheck, /--repeat 2/);
  assert.match(controlCheck, /--max-total-sec 2100/);
  assert.equal(/payload-manifest/.test(control), false, 'the control EXE is a different build: no payload manifest');
  assert.equal(/--max-total-sec 1320/.test(WORKFLOW), false);
});

test('windows.yml (static): both summary steps print the new evidence (close order, preservation, payload parity, forwarded board, repeat)', () => {
  for (const block of [jobBlock('portable-isolation'), jobBlock('portable-isolation-control')]) {
    for (const needle of ['$traceEvidence.options.repeat', '$traceScenario.closeOrder', '$traceScenario.preservation.text', '$traceEvidence.forwardedBoardRecorded', '$traceEvidence.scenario2.forwardedBoard.text', '$traceEvidence.detection.byCloseOrder']) {
      assert.ok(block.includes(needle), `${needle} is printed`);
    }
  }
  for (const block of [jobBlock('portable-isolation'), jobBlock('portable-isolation-control')]) {
    for (const line of [
      'if ($traceEvidence.scenario2 -and $traceEvidence.scenario2.forwardedBoard) { $traceLines += "forwardedBoardRecorded=$($traceEvidence.forwardedBoardRecorded): $($traceEvidence.scenario2.forwardedBoard.text)" }',
      'if ($traceEvidence.scenario2 -and $traceEvidence.scenario2.preservation) { $traceLines += "second-instance C: $($traceEvidence.scenario2.preservation.text)" }',
      'if ($traceScenario.preservation) { $traceLines += "  $($traceScenario.preservation.text)" }',
      'foreach ($traceSide in @(\'A\', \'B\')) { $traceLines += "  payload parity $($traceSide): $($traceScenario.payloadParity.$traceSide.text)" }',
      'foreach ($traceSubject in @($traceEvidence.payloadParity.subjects)) { $traceLines += "  $($traceSubject.subject): $($traceSubject.text)" }',
      '$traceLines += "baseline payload parity: $($traceEvidence.baseline.payloadParity.text)"',
      'if ($traceEvidence.payload) { $traceManifestText = "digest $($traceEvidence.payload.manifestDigest) ($($traceEvidence.payload.fileCount) files)" }',
    ]) assert.ok(block.includes(line), `summary line is printed: ${line.slice(0, 80)}`);
  }
  const isolation = jobBlock('portable-isolation');
  for (const needle of ['$traceEvidence.payloadParity', '$traceSubject.text', '$traceEvidence.payload.manifestDigest']) assert.ok(isolation.includes(needle), `${needle} is printed by the isolation summary`);
  assert.equal(/\$traceEvidence\.payloadParity/.test(jobBlock('portable-isolation-control')), true, 'the control summary prints the (empty) parity state too, null-safely');
});
