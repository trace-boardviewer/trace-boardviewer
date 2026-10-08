'use strict';

/*
 * What else the machine is doing around a benchmark run, so a baseline taken on a busy machine can be recognised and labelled
 * (frame times are only comparable between runs made under the same conditions). Four numbers per run:
 *   - the share of processor time the whole machine spent busy during one second, before and after the run (the application
 *     is not running then, so it is everyone else);
 *   - the same share over the whole run with the benchmark's own processes (this script and the application) taken out;
 *   - how many other node, electron and browser processes exist (their image names; the benchmark's own are not counted);
 *   - free memory.
 * Parsing and classification are pure functions (unit tested); only listProcesses, cpuTimes and the meter touch the machine.
 */

const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** A run counts as quiet when the other programs used at most this share of the processor all the time. */
const QUIET_PERCENT = 15;
const BROWSER_NAMES = new Set(['chrome', 'chromium', 'chrome-headless-shell', 'headless_shell', 'msedge', 'msedgewebview2', 'firefox', 'brave']);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Process list of `tasklist /FO CSV /NH`: "Image Name","PID",... */
function parseTasklist(text) {
  const list = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (match) list.push({ pid: Number(match[2]), name: match[1] });
  }
  return list;
}

/** Process list of `ps -A -o pid=,comm=`: "  123 name" (the name may contain spaces). */
function parsePs(text) {
  const list = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) list.push({ pid: Number(match[1]), name: path.basename(match[2]) });
  }
  return list;
}

/** Lower-case image name without directory and .exe: "Electron.exe" -> "electron". */
function baseName(name) {
  return path.basename(String(name).replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
}

/** Counts of the node, electron (the Electron binary and its helpers) and browser processes and of all processes; `ownPids` are left out. */
function countProcesses(list, ownPids = []) {
  const own = new Set(ownPids);
  const counts = { node: 0, electron: 0, browser: 0, total: 0 };
  for (const item of list) {
    if (own.has(item.pid)) continue;
    const name = baseName(item.name);
    counts.total++;
    if (name === 'node') counts.node++;
    else if (name.startsWith('electron')) counts.electron++;
    else if (BROWSER_NAMES.has(name)) counts.browser++;
  }
  return counts;
}

function run(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 20_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
  });
}

/** [{ pid, name }] of every process, or null when the platform tool is not available. */
async function listProcesses() {
  if (process.platform === 'win32') {
    const tasklist = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
    const text = await run(tasklist, ['/FO', 'CSV', '/NH']);
    return text === null ? null : parseTasklist(text);
  }
  const text = await run('ps', ['-A', '-o', 'pid=,comm=']);
  return text === null ? null : parsePs(text);
}

/** Processes of the machine other than this one; null when they cannot be listed. */
async function otherProcesses() {
  const list = await listProcesses();
  return list ? countProcesses(list, [process.pid]) : null;
}

/** Busy and total processor time of all logical processors, in milliseconds (user, system and interrupt time are busy). */
function cpuTimes(cpus = os.cpus()) {
  let busy = 0, total = 0;
  for (const { times } of cpus) {
    busy += times.user + times.nice + times.sys + times.irq;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
  }
  return { busy, total };
}

const percent = (part, whole) => (whole > 0 ? Math.max(0, Math.min(100, Math.round((100 * part) / whole))) : 0);

/** Share of processor time the machine was busy between two cpuTimes() readings, in whole percent. */
function busyPercent(before, after) {
  return percent(after.busy - before.busy, after.total - before.total);
}

/** Busy share of the machine over `ms` milliseconds. */
async function sampleBusyPercent(ms = 1000) {
  const before = cpuTimes();
  await delay(ms);
  return busyPercent(before, cpuTimes());
}

/**
 * Waits until the machine has been at most `threshold` percent busy for `needed` samples of a second in a row, at most `seconds`
 * seconds. Resolves { waitedS, quiet, lastPercent }; the caller decides what to do when it never became quiet.
 */
async function waitUntilQuiet(seconds, { threshold = QUIET_PERCENT, needed = 3, sample = sampleBusyPercent } = {}) {
  const started = Date.now();
  let streak = 0, last = 0;
  for (;;) {
    last = await sample(1000);
    streak = last <= threshold ? streak + 1 : 0;
    if (streak >= needed) return { waitedS: Math.round((Date.now() - started) / 1000), quiet: true, lastPercent: last };
    if (Date.now() - started >= seconds * 1000) return { waitedS: Math.round((Date.now() - started) / 1000), quiet: false, lastPercent: last };
  }
}

/**
 * Measures the processor share over a stretch of time. `stop(ownSeconds)` takes the processor seconds the benchmark's own
 * application processes used (null when unknown); this script's own use is taken from process.cpuUsage().
 * Result: { elapsedS, machineBusyPercent, ownBusyPercent, otherBusyPercent } (the last two null when the application's use is unknown).
 */
function startLoadMeter() {
  const times = cpuTimes();
  const usage = process.cpuUsage();
  const started = Date.now();
  return {
    stop(applicationSeconds) {
      const after = cpuTimes();
      const spent = process.cpuUsage(usage);
      const total = after.total - times.total;
      const machine = percent(after.busy - times.busy, total);
      const result = { elapsedS: Math.round((Date.now() - started) / 100) / 10, machineBusyPercent: machine, ownBusyPercent: null, otherBusyPercent: null };
      if (typeof applicationSeconds === 'number' && Number.isFinite(applicationSeconds)) {
        const ownMs = applicationSeconds * 1000 + (spent.user + spent.system) / 1000;
        result.ownBusyPercent = percent(ownMs, total);
        result.otherBusyPercent = Math.max(0, machine - result.ownBusyPercent);
      }
      return result;
    },
  };
}

/** The load number of one run: how busy the rest of the machine was at worst (before, after, and during the run when known). */
function loadPercent(host) {
  const values = [host?.before?.cpuBusyPercent, host?.after?.cpuBusyPercent, host?.duringRun?.otherBusyPercent].filter(value => typeof value === 'number');
  return values.length ? Math.max(...values) : null;
}

/**
 * The conditions of a report: the text the person gave (`override`), or "quiet" when no run saw more than QUIET_PERCENT other load,
 * "under load, indicative" when one did or no load was measured.
 */
function classifyConditions(hosts, override) {
  if (typeof override === 'string' && override.trim()) return override.trim();
  const loads = hosts.map(loadPercent);
  return loads.length && loads.every(value => value !== null && value <= QUIET_PERCENT) ? 'quiet' : 'under load, indicative';
}

module.exports = { QUIET_PERCENT, parseTasklist, parsePs, baseName, countProcesses, listProcesses, otherProcesses, cpuTimes, busyPercent, sampleBusyPercent, waitUntilQuiet, startLoadMeter, loadPercent, classifyConditions };
