#!/usr/bin/env node
'use strict';

// Regression check for the Windows portable wrapper (electron-builder NSIS "portable" target).
//
// Defect being guarded: with the default `unpackDirName` the wrapper extracts the whole app into one FIXED
// directory (%TEMP%\<name>) shared by every launch of the same EXE, and runs `RMDir /r` on it before
// extracting and again after the app exits. Overlapping launches therefore destroy each other: during the
// first ~10 s (extraction) the launches are lost or one of them exits with code 1; later, closing one running
// instance deletes the runtime of every other running instance. With `build.portable.unpackDirName: true`
// each launch extracts into its own NSIS plugin directory (%TEMP%\nsXXXX.tmp\app) and instances cannot
// interfere with each other.
//
// Usage (Windows only; Node >= 24):
//   node scripts/check-portable-isolation.cjs --exe <portable.exe> [--expect isolated|shared]
//        [--out <evidence.json>] [--timeout-sec N] [--staggers 0,5000,main:10000,main:20000] [--max-total-sec N]
//        [--repeat N] [--payload-manifest <payload-manifest.json>]
//
//   --repeat N          run every stagger N times (default 1: the old behaviour and scenario names). Attempt 1 closes A first
//                       and B must survive; attempt 2 closes B first and A must survive (alternating for N > 2). Every
//                       attempt has its own temp area and its own throw-away profiles. With N > 1 the scenarios are named
//                       concurrency-<ms>-r<k>. The injected GPU restart and the payload parity run once (largest stagger,
//                       first attempt).
//   --payload-manifest  (isolated mode only) a scripts/payload-manifest.cjs manifest of the build's UNPACKED app. The
//                       extracted runtime directories of the baseline instance and of A and B (largest stagger, first
//                       attempt) must equal it file by file (path, size, SHA-256), the exe and app.asar included.
//   --expect isolated   (default) exit 0 only when the fixed behaviour is demonstrated in EVERY scenario.
//   --expect shared     CONTROL mode: exit 0 only when the check DETECTS the old shared-directory defect, so a pass
//                       of the default mode cannot be vacuous. Use it with a deliberately defective EXE. The criterion
//                       is STRUCTURAL: the baseline passed AND at least one concurrency scenario showed a shared
//                       runtime directory or B's runtime shrinking after A closed (LOCAL's deterministic 78 -> 7
//                       files). Lost launches, launcher exit codes and GPU damage are recorded as supplementary
//                       signatures only (a slow runner can fake them).
//
// Exit codes: 0 verdict matches the expectation; 1 an assertion failed; 2 infrastructure failure (usage error,
// not Windows, wrapper could not be started, the baseline launch failed, PowerShell failure, time budget).
// Both 1 and 2 must fail the CI job.
//
// Scenarios (each runs in its own private temp area with its own throw-away --user-data-dir profiles; the real
// user profile is never used):
//   0. baseline: ONE launch alone becomes ready (window + profile files), closes normally with exit 0 and its
//      runtime directory is removed. A failing baseline is an infrastructure failure in BOTH modes. With
//      --payload-manifest the RUNNING baseline runtime is hashed first and must equal the manifest file by file.
//   1. concurrency, once per stagger (default 0 and 5000 ms measured from A's wrapper spawn while A is still
//      extracting; 10000 and 20000 ms measured from the first observation of A's main process): launch A, then
//      B. Isolated mode requires signature `isolated-ok`: both windows and profiles appear, both launchers stay
//      alive, distinct runtime directories, the instance that closes first exits normally (exit 0, runtime and NSIS
//      parent removed, no forced kill) and the SURVIVOR's runtime keeps EXACTLY its file count/bytes and its exact
//      per-file SET (sorted relative path + size, compared as a set; the failure lists up to 10 missing/extra paths)
//      while the survivor stays alive, Responding and windowed. Both close orders are covered (see --repeat).
//      In the first attempt of the last scenario an INJECTED GPU restart follows: one --type=gpu-process child of B's
//      own main process is terminated and Electron must respawn a new one while B is unharmed (an injection, not a
//      claim about normal incidence). With --payload-manifest A and B of that same attempt are hashed while both run.
//   2. second-instance forwarding: launch C WITHOUT a board argument, then D with the SAME profile plus a synthetic board
//      file (written to the temp area before D starts). D must forward and exit by itself with 0, clean up its own
//      extraction and not touch C's runtime, and after C closed normally C's own config.json (recentBoards) must hold
//      the synthetic board: proof that the forwarded argument was DELIVERED, not only that D went away.
//
// Every launch passes the profile as one argument, --user-data-dir=<path>. The NSIS plugin directory of a launch is
// %TEMP%\ns<letter><hex>.tmp\app (e.g. nseC3BF.tmp, nsj1138.tmp).
//
// Observed signature names per concurrency scenario: isolated-ok (fixed behaviour), both-lost,
// a-exit-nonzero-b-survives, shared-dir-runtime-shrinks (the three signatures of the OLD build recorded by
// LOCAL, see LOCAL_REFERENCE), plus the honest variants a-lost-b-survives, b-lost-a-survives,
// gpu-restart-damage and other-failure. Timing-sensitive races are reported with matchesReference=false
// instead of being hidden or failed in control mode.
//
// Architecture: every decision is a pure exported function (analyze, classifyRuntimeDir, parseProcessJson, ...).
// Every OS interaction (spawn, process snapshot, CloseMainWindow, directory statistics, sleep) lives behind the
// injectable `platform` object, so tests/portable-isolation-checks.cjs exercises the whole flow without
// Windows. The success path never force-kills anything (the injected GPU termination targets only a verified
// gpu-process child and is recorded separately); only the final cleanup kills, and only process trees this
// script started.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const payloadManifest = require('./payload-manifest.cjs');

const SCHEMA = 'trace-portable-isolation-evidence/3';
const TOOL_NAME = 'scripts/check-portable-isolation.cjs';
const MAIN_EXE_NAME = 'TRACE Boardviewer.exe';
// NSIS names its plugin directory ns + ONE letter (chr('a' + GetTickCount() % 26)) + hex: nseC3BF.tmp, nsj1138.tmp, nsk58A3.tmp.
const NSIS_PARENT_RE = /^ns[a-z][0-9A-F]+\.tmp$/i;
const DEFAULT_OUT = 'portable-isolation-evidence.json';
const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_MAX_TOTAL_SEC = 1500; // the workflow jobs pass their own --max-total-sec; this is the script's own net
const DEFAULT_REPEAT = 1;
const MAX_REPEAT = 10;
const CONFIG_FILE_NAME = 'config.json'; // the app's config store inside the --user-data-dir profile (electron/store.cjs name, electron/main.cjs loadConfig)
const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INFRA: 2 });
// Milliseconds. Real waits; the tests inject a virtual clock so these cost nothing there.
const DEFAULT_TUNING = Object.freeze({
  pollMs: 500, // readiness / exit polling
  dPollMs: 250, // polling while the second-instance launcher D lives
  settleMs: 3000, // re-check delay after a sibling exited
  cleanupWaitMs: 10000, // bounded wait for the wrapper's own cleanup to become visible
  baselineCleanupWaitMs: 30000, // the very first extraction/removal on a cold runner may be slower
  minSettleMs: 15000, // renderer-only readiness fallback needs the main process this old
  profileWaitMs: 15000, // bounded wait for profile files after the window appeared
  gpuWaitMs: 15000, // bounded wait for a --type=gpu-process child of B before the injection
  gpuRespawnWaitMs: 30000, // bounded wait for Electron to respawn the terminated gpu-process
  parityAttempts: 3, // payload parity: a transiently unreadable file is re-read up to this many times IN TOTAL, then reported
  parityRetryDelayMs: 2000,
  forwardWaitMs: 10000, // bounded wait for C to have recorded the forwarded board before C is closed
});
/** from: 'wrapper-spawn' = measured from A's wrapper spawn (A still extracting); 'main-seen' = from the first observation of A's main process. */
const DEFAULT_STAGGERS = Object.freeze([
  Object.freeze({ nominalMs: 0, from: 'wrapper-spawn' }),
  Object.freeze({ nominalMs: 5000, from: 'wrapper-spawn' }),
  Object.freeze({ nominalMs: 10000, from: 'main-seen' }),
  Object.freeze({ nominalMs: 20000, from: 'main-seen' }),
]);
const USAGE = `Usage: node scripts/check-portable-isolation.cjs --exe <portable.exe> [--expect isolated|shared] [--out <evidence.json>] [--timeout-sec N] [--staggers 0,5000,main:10000,main:20000] [--max-total-sec N] [--repeat N] [--payload-manifest <payload-manifest.json>]`;

/**
 * Provenance only (NOT CI evidence, not produced by this script): the signatures LOCAL (Windows evidence
 * owner) recorded on the OLD shared-directory build, frozen commit 082b653, in its final REPORT.json.
 * Control mode compares what it observes with this table and reports matchesReference per scenario.
 */
const LOCAL_REFERENCE = Object.freeze({
  provenance: 'LOCAL (Windows evidence owner) final REPORT.json on the OLD shared-directory build, frozen commit 082b653. Provenance only: not CI evidence, not executed by this script.',
  reportSha256: 'E2A6406736995C88275DC40382A3A94A89BE21979623BC98F7EE599EB50CA83D',
  signatures: Object.freeze([
    Object.freeze({ nominalMs: 0, measuredFrom: 'wrapper-spawn', actualMs: [39, 41], signature: 'both-lost', note: 'BOTH launches are lost: no window and no profile files for either instance; the launchers exit without a visible app.' }),
    Object.freeze({ nominalMs: 5000, measuredFrom: 'wrapper-spawn', actualMs: [5085], signature: 'a-exit-nonzero-b-survives', note: 'A is still extracting: launcher A exits with code 1, launcher B SURVIVES (its window and profile appear).' }),
    Object.freeze({ nominalMs: 10000, measuredFrom: 'main-seen', actualMs: [10060], signature: 'shared-dir-runtime-shrinks', note: 'both start and both close; runDirShared; 78 files/503557201 B while both run -> 7 files/366521134 B after A exits normally (exit 0, no forced kill) while B stays alive.' }),
    Object.freeze({ nominalMs: 20000, measuredFrom: 'main-seen', actualMs: [20100], signature: 'shared-dir-runtime-shrinks', note: 'same as 10000 ms.' }),
  ]),
});
/** Signatures that mean "the old defect was observed" (control mode). */
const DEFECT_SIGNATURES = Object.freeze(['both-lost', 'a-exit-nonzero-b-survives', 'a-lost-b-survives', 'b-lost-a-survives', 'shared-dir-runtime-shrinks', 'gpu-restart-damage']);
const REFERENCE_DEFECT_SIGNATURES = Object.freeze(['both-lost', 'a-exit-nonzero-b-survives', 'shared-dir-runtime-shrinks']);

// An original, minimal GENCAD 1.4 board written by this script. Nothing here comes from a real design.
const SYNTHETIC_BOARD = [
  '# Synthetic board for the portable-wrapper isolation check. Not derived from any real design.',
  '$HEADER', 'GENCAD 1.4', 'UNITS MM', 'ORIGIN 0 0', '$ENDHEADER',
  '$BOARD', 'RECTANGLE 0 0 20 10', '$ENDBOARD',
  '$PADS', 'PAD P ROUND -1', 'CIRCLE 0 0 0.3', '$ENDPADS',
  '$PADSTACKS', 'PADSTACK PS 0', 'PAD P TOP 0 0', '$ENDPADSTACKS',
  '$SHAPES', 'SHAPE S', 'RECTANGLE -1 -0.5 2 1', 'PIN 1 PS -0.8 0 TOP 0 0', 'PIN 2 PS 0.8 0 TOP 0 0', '$ENDSHAPES',
  '$COMPONENTS', 'COMPONENT R1', 'PLACE 10 5', 'LAYER TOP', 'ROTATION 0', 'SHAPE S 0 0', '$ENDCOMPONENTS',
  '$SIGNALS', 'SIGNAL NET_A', 'NODE R1 1', 'SIGNAL NET_B', 'NODE R1 2', '$ENDSIGNALS',
  '',
].join('\n');

class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}
/** The check could not be carried out (not a verdict about the product). */
class InfraError extends Error {
  constructor(message, step) { super(message); this.name = 'InfraError'; this.step = step || null; }
}
class ProcessJsonError extends Error {
  constructor(message) { super(message); this.name = 'ProcessJsonError'; }
}

// ---------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------

const round2 = (value) => Math.round(value * 100) / 100;

/** Windows-path containment, case-insensitive, separator tolerant. */
function isInside(child, parent, pathModule = path.win32) {
  if (typeof child !== 'string' || typeof parent !== 'string' || !child || !parent) return false;
  const fold = (value) => {
    const normalized = pathModule.normalize(value).replace(/[\\/]+$/, '');
    return pathModule === path.win32 ? normalized.toLowerCase() : normalized;
  };
  const c = fold(child);
  const p = fold(parent);
  return c.length > p.length && c.startsWith(p) && (c[p.length] === '\\' || c[p.length] === '/');
}

/** Case-insensitive, separator-tolerant equality of two Windows paths. */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const fold = (value) => path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
  return fold(a) === fold(b);
}

const isMainName = (name) => typeof name === 'string' && name.toLowerCase() === MAIN_EXE_NAME.toLowerCase();

/**
 * Where does a running instance's extracted runtime live?
 *  - per-launch-nsis:   <...>\nsXXXX.tmp\app  (NSIS plugin directory; fixed behaviour, unpackDirName: true)
 *  - fixed-temp-subdir: <tempDir>\<name>      (shared by every launch of the same EXE; the defect)
 *  - other:             anything else (reported, never assumed)
 */
function classifyRuntimeDir(runDir, tempDir) {
  const empty = { dir: null, leaf: null, parent: null, kind: 'other', nsisParent: null };
  if (typeof runDir !== 'string' || !runDir) return empty;
  const win = path.win32;
  const dir = win.normalize(runDir).replace(/[\\/]+$/, '');
  const parent = win.dirname(dir);
  const leaf = win.basename(dir);
  const parentLeaf = win.basename(parent);
  if (leaf.toLowerCase() === 'app' && NSIS_PARENT_RE.test(parentLeaf)) {
    return { dir, leaf, parent, kind: 'per-launch-nsis', nsisParent: parent };
  }
  // %TEMP% may be spelled as an 8.3 short path by NSIS, so a leaf named "Temp" counts as the temp directory too.
  if ((typeof tempDir === 'string' && tempDir && samePath(parent, tempDir)) || parentLeaf.toLowerCase() === 'temp') {
    return { dir, leaf, parent, kind: 'fixed-temp-subdir', nsisParent: null };
  }
  return { dir, leaf, parent, kind: 'other', nsisParent: null };
}

function toInt(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
    if (value && typeof value === 'object') { // Windows PowerShell 5.1 serialises IntPtr as { "value": n }
      const nested = toInt(value.value, value.Value);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function normalizeProcess(item) {
  const pid = toInt(item.pid, item.ProcessId);
  if (pid === null) return null;
  const exe = [item.exe, item.ExecutablePath].find((value) => typeof value === 'string' && value.length > 0);
  const responding = [item.responding, item.Responding].find((value) => typeof value === 'boolean');
  return {
    pid,
    ppid: toInt(item.ppid, item.ParentProcessId) ?? 0,
    name: [item.name, item.Name].find((value) => typeof value === 'string') ?? '',
    exe: exe ?? null, // null: access denied / exited while enumerating
    type: [item.type].find((value) => typeof value === 'string') ?? '',
    windowHandle: toInt(item.windowHandle, item.MainWindowHandle) ?? 0,
    responding: responding === undefined ? null : responding,
  };
}

/**
 * Parses the output of `... | ConvertTo-Json -Compress`. ConvertTo-Json yields nothing for an empty
 * pipeline, a bare object for one element, an array for several, and Windows PowerShell 5.1 sometimes wraps
 * arrays as { "value": [...], "Count": n }. All of them become an array of normalised records.
 */
function parseProcessJson(text) {
  const raw = typeof text === 'string' ? text.replace(/^﻿/, '').trim() : '';
  if (raw === '' || raw === 'null') return [];
  let value;
  try { value = JSON.parse(raw); } catch (error) {
    throw new ProcessJsonError(`process snapshot is not valid JSON (${error.message}): ${raw.slice(0, 120)}`);
  }
  if (value === null) return [];
  if (!Array.isArray(value) && typeof value === 'object' && Array.isArray(value.value) && 'Count' in value) value = value.value;
  const items = Array.isArray(value) ? value : [value];
  return items.filter((item) => item !== null && typeof item === 'object').map(normalizeProcess).filter(Boolean);
}

/** The instance's main process: the wrapper's direct child named like the app executable. */
function findMainProcess(records, wrapperPid) {
  return records.find((record) => record.ppid === wrapperPid && isMainName(record.name) && record.type === '') || null;
}

function descendantsOf(records, rootPid) {
  const found = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length) {
    const parent = queue.shift();
    for (const record of records) {
      if (record.ppid === parent && !seen.has(record.pid)) { seen.add(record.pid); found.push(record); queue.push(record.pid); }
    }
  }
  return found;
}

/**
 * Is the instance usable? Preferred proof: its main process owns a top-level window. Fallback for sessions
 * without window handles: the main process has lived `minSettleMs` and a --type=renderer descendant exists.
 */
function isReady(records, wrapperPid, { sinceMainMs = 0, minSettleMs = DEFAULT_TUNING.minSettleMs } = {}) {
  const main = findMainProcess(records, wrapperPid);
  if (!main) return { ready: false, reason: 'main process not started yet', main: null };
  if (!main.exe) return { ready: false, reason: 'main process ExecutablePath is not readable', main };
  if (main.windowHandle !== 0) return { ready: true, mode: 'handle', reason: 'main window present', main };
  const renderers = descendantsOf(records, main.pid).filter((record) => record.type === 'renderer');
  if (renderers.length && sinceMainMs >= minSettleMs) return { ready: true, mode: 'renderer-fallback', reason: 'renderer present after settle time', main };
  return { ready: false, reason: renderers.length ? 'renderer present, waiting for settle time' : 'no window and no renderer yet', main };
}

/** Liveness facts about one instance from a process snapshot (pid reuse guarded by the recorded path). */
function inspectInstance(records, { mainPid, mainExe }) {
  const main = records.find((record) => record.pid === mainPid && isMainName(record.name)) || null;
  const alive = !!main && (!mainExe || !main.exe || samePath(main.exe, mainExe));
  const descendants = alive ? descendantsOf(records, mainPid) : [];
  return {
    mainAlive: alive,
    responding: alive ? main.responding : null,
    windowHandle: alive ? main.windowHandle : 0,
    rendererCount: descendants.filter((record) => record.type === 'renderer').length,
    gpuPids: descendants.filter((record) => record.type === 'gpu-process').map((record) => record.pid).sort((a, b) => a - b),
  };
}

/** May `pid` be terminated by the injected GPU restart? Only a `type` process (by command line) below `rootPid`. Pure. */
function verifyTerminationTarget(records, pid, { rootPid, type }) {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(rootPid) || rootPid <= 0) return { ok: false, reason: 'invalid pid' };
  const target = records.find((record) => record.pid === pid);
  if (!target) return { ok: false, reason: 'process not found' };
  if (!isMainName(target.name) || target.type !== type) return { ok: false, reason: `process is "${target.name}" of type "${target.type}", not ${type}` };
  if (!descendantsOf(records, rootPid).some((record) => record.pid === pid)) return { ok: false, reason: `process is not a descendant of ${rootPid}` };
  return { ok: true, reason: 'verified' };
}

const statsEqual = (a, b) => !!a && !!b && a.exists === b.exists && a.files === b.files && a.bytes === b.bytes;
const statsReduced = (now, before) => !!now && !!before && (!now.exists || now.files < before.files || now.bytes < before.bytes);
const fmtStats = (stats) => (stats && stats.exists ? `${stats.files} files / ${stats.bytes} B` : 'missing');
const profileOk = (profile) => !!profile && profile.exists === true && profile.files > 0;
const shortDigest = (digest) => (typeof digest === 'string' && digest ? digest.slice(0, 12) : 'n/a');
/** Exact per-file SET equality of two size-only listings is decided by their digests (see payloadManifest.digestFileList). */
const manifestEqual = (snapshotManifest, baselineManifest) => !!snapshotManifest && !!baselineManifest && !!baselineManifest.digest && snapshotManifest.digest === baselineManifest.digest;

/** " missing (1): a; extra (2): b, c, +1 more; size changed (1): x (10 -> 9 B)." (leading space, empty when nothing to say). Pure. */
function describeDiff(diff) {
  if (!diff || !diff.counts) return '';
  const part = (label, list, count) => (count > 0 ? `${label} (${count}): ${list.join(', ')}${count > list.length ? `, +${count - list.length} more` : ''}` : null);
  const parts = [
    part('missing', diff.missing || [], diff.counts.missing),
    part('extra', diff.extra || [], diff.counts.extra),
    part('size changed', (diff.sizeMismatch || []).map((item) => `${item.path} (${item.expected} -> ${item.actual} B)`), diff.counts.sizeMismatch),
    part('content changed', (diff.hashMismatch || []).map((item) => item.path), diff.counts.hashMismatch),
  ].filter(Boolean);
  return parts.length ? ` ${parts.join('; ')}.` : '';
}

/** Why the board was not found: the reason, plus the I/O message when the store could not be read. Pure. */
const forwardedDetail = (forwarded) => `${forwarded.reason || 'unknown'}${forwarded.status === 'error' && forwarded.message ? ` (${forwarded.message})` : ''}`;

/**
 * Which instance closes first in a concurrency record, and which one is the SURVIVOR whose runtime must stay intact.
 * A-first (attempt 1, the old behaviour): A closes, B survives. B-first (attempt 2): B closes, A survives. The legacy field
 * names stay literally true: aClose/bClose are A's/B's close records, afterAExit* are B's observations after A exited,
 * afterBExit* are A's observations after B exited. Pure.
 */
function closeOrderOf(rec) {
  if (rec && rec.closeOrder === 'B-first') {
    return { name: 'B-first', first: 'B', second: 'A', firstClose: rec.bClose, secondClose: rec.aClose, afterFirst: rec.afterBExit, afterFirstSettled: rec.afterBExitSettled };
  }
  return { name: 'A-first', first: 'A', second: 'B', firstClose: rec && rec.aClose, secondClose: rec && rec.bClose, afterFirst: rec && rec.afterAExit, afterFirstSettled: rec && rec.afterAExitSettled };
}

/** Failure-id prefix of a concurrency record: CONC20000 for a single run, CONC20000_R2 for attempt 2 of a repeated run. */
const concPrefix = (rec) => `CONC${rec.stagger.nominalMs}${rec.attempt && rec.attempt.of > 1 ? `_R${rec.attempt.index}` : ''}`;

/** Scenario name: concurrency-20000 for a single run, concurrency-20000-r2 for attempt 2 of a repeated run. */
const concName = (nominalMs, attempt, repeat) => (repeat > 1 ? `concurrency-${nominalMs}-r${attempt}` : `concurrency-${nominalMs}`);

/** Attempt k alternates the close order: odd = A first (B survives), even = B first (A survives). */
const closeOrderForAttempt = (attempt) => (attempt % 2 === 1 ? 'A-first' : 'B-first');

/** Problems of the single-launch baseline; any entry makes the whole run an infrastructure failure. Pure. */
function baselineProblems(baseline) {
  if (!baseline) return ['the baseline scenario did not run'];
  const problems = [];
  const launcher = baseline.launcher;
  if (!launcher) return ['the baseline launch was not recorded'];
  if (launcher.outcome === 'exited') problems.push(`the launcher exited by itself (code ${launcher.exitCode}) after ${launcher.elapsedMs} ms before a window appeared`);
  else if (launcher.outcome === 'timeout') problems.push(`no window appeared within ${launcher.elapsedMs} ms`);
  else if (launcher.outcome !== 'ready') problems.push(`the launch ended as "${launcher.outcome}"`);
  else {
    const instance = baseline.instance;
    if (!instance || !instance.baseline || !instance.baseline.exists || !(instance.baseline.files > 0)) problems.push('its runtime directory was empty or missing when it became ready');
    if (!instance || !profileOk(instance.profile)) problems.push('no profile files were created');
    const close = baseline.close;
    if (!close) problems.push('it was never closed');
    else {
      if (!close.alreadyExited && !close.delivered) problems.push(`the normal close request could not be delivered (${close.method}: ${close.detail})`);
      if (!close.exited) problems.push('the launcher did not exit after a normal close');
      else {
        if (close.exitCode !== 0) problems.push(`the launcher exited with code ${close.exitCode} after a normal close, expected 0`);
        if (close.cleanup && close.cleanup.runDirRemoved === false) problems.push(`its runtime directory was not removed (${(close.cleanup.remaining || []).join(', ')})`);
        if (close.cleanup && close.cleanup.nsisParentRemoved === false) problems.push('its NSIS plugin directory was not removed');
      }
    }
  }
  return problems;
}

const settleWhen = (ms) => (ms ? `after a ${ms} ms settle time` : 'after settling');

function checkSurvivor(add, prefix, label, snapshot, baseline, windowMode, whenText, key, baselineManifest = null) {
  if (!snapshot) { add(`${prefix}_NOT_CHECKED`, `${label}: no observation was recorded ${whenText}.`); return; }
  if (!statsEqual(snapshot.runDir, baseline)) {
    add(`${prefix}_RUNTIME_CHANGED_${key}`,
      `${label}'s runtime changed ${whenText}: before ${fmtStats(baseline)}, now ${fmtStats(snapshot.runDir)}. A sibling's start/exit must not touch it.${describeDiff(snapshot.manifest && snapshot.manifest.diff)}`);
  } else if (baselineManifest && !manifestEqual(snapshot.manifest, baselineManifest)) {
    // Same file count and bytes, but not the same files: a count/bytes comparison alone would have passed this.
    add(`${prefix}_FILESET_CHANGED_${key}`,
      `${label}'s runtime has the same ${fmtStats(baseline)} ${whenText} but a different per-file set (path+size manifest ${shortDigest(baselineManifest.digest)} -> ${snapshot.manifest ? shortDigest(snapshot.manifest.digest) : 'not recorded'}).${describeDiff(snapshot.manifest && snapshot.manifest.diff)}`);
  }
  const proc = snapshot.proc;
  if (!proc || !proc.mainAlive) { add(`${prefix}_MAIN_DEAD`, `${label}'s main process is no longer running (${whenText}).`); return; }
  if (proc.responding !== true) add(`${prefix}_NOT_RESPONDING`, `${label}'s main process is not Responding (${whenText}; Responding=${proc.responding}).`);
  if (windowMode === 'handle') {
    if (!proc.windowHandle) add(`${prefix}_WINDOW_LOST`, `${label}'s main window is gone (${whenText}).`);
  } else if (!(proc.rendererCount > 0)) {
    add(`${prefix}_RENDERER_LOST`, `${label} has no renderer process any more (${whenText}).`);
  }
  if (proc.wrapperAlive === false) add(`${prefix}_WRAPPER_EXITED`, `${label}'s wrapper process exited while ${label} was supposed to keep running (${whenText}).`);
}

function checkClose(add, prefix, label, close, { expectRemoval = true } = {}) {
  if (!close) { add(`${prefix}_NOT_CLOSED`, `${label} was never closed (no observation).`); return false; }
  if (!close.alreadyExited && !close.delivered) add(`${prefix}_CLOSE_NOT_DELIVERED`, `${label}: the normal close request could not be delivered (${close.method}: ${close.detail}).`);
  if (!close.exited) {
    add(`${prefix}_NOT_EXITED`, `${label}'s wrapper did not exit within ${Math.round((close.waitedMs || 0) / 1000)} s after a normal close (it was NOT force-killed by the check).`);
    return false;
  }
  if (close.exitCode !== 0) add(`${prefix}_EXIT_CODE`, `${label}'s wrapper exited with code ${close.exitCode}${close.signal ? ` (signal ${close.signal})` : ''}, expected 0.`);
  const cleanup = close.cleanup;
  if (expectRemoval && cleanup && !cleanup.skipped) {
    if (cleanup.runDirRemoved === false) add(`${prefix}_RUNDIR_NOT_REMOVED`, `${label}'s extraction directory still exists after the wrapper exited: ${(cleanup.remaining || []).join(', ')}.`);
    if (cleanup.nsisParentRemoved === false) add(`${prefix}_NSIS_PARENT_NOT_REMOVED`, `${label}'s NSIS plugin directory ${cleanup.nsisParent} still exists after the wrapper exited.`);
  }
  return true;
}

function checkBaselineStats(add, prefix, label, instance) {
  const base = instance && instance.baseline;
  if (!base || !base.exists || !(base.files > 0) || !(base.bytes > 0)) {
    add(`${prefix}_BASELINE_EMPTY`, `${label}: its runtime directory was empty or missing when it became ready (${fmtStats(base)}), so the later comparisons would be meaningless.`);
  }
}

function checkGpu(rec, add, P) {
  if (!rec.injectGpu) return;
  const g = rec.gpuRestart;
  if (!g) { add(`${P}_GPU_NOT_RUN`, 'The injected GPU-restart step did not run.'); return; }
  if (g.skipped) { add(`${P}_GPU_SKIPPED`, `The injected GPU-restart step was skipped: ${g.skipped}.`); return; }
  if (!g.targetPid) { add(`${P}_GPU_PROCESS_NOT_FOUND`, `B's main process had no --type=gpu-process child within ${Math.round((g.waitedForGpuMs || 0) / 1000)} s, so the restart could not be injected.`); return; }
  if (!g.performed) { add(`${P}_GPU_KILL_NOT_PERFORMED`, `The gpu-process ${g.targetPid} was not terminated (${g.reason}).`); return; }
  if (!g.respawned) add(`${P}_GPU_NOT_RESPAWNED`, `After the injected termination of gpu-process ${g.targetPid} Electron did not start a NEW gpu-process within ${Math.round((g.waitedForRespawnMs || 0) / 1000)} s (before ${g.pidsBefore.join(',')}, after ${(g.pidsAfter || []).join(',') || 'none'}).`);
  checkSurvivor(add, `${P}_GPU_B`, 'B', g.after, rec.B.baseline, rec.B.windowMode, 'after the injected GPU restart', 'AFTER_GPU', rec.B.baselineManifest);
  checkSurvivor(add, `${P}_GPU_B`, 'B', g.afterSettled, rec.B.baseline, rec.B.windowMode, `after the injected GPU restart, ${settleWhen(g.settleMs)}`, 'AFTER_GPU_SETTLED', rec.B.baselineManifest);
}

function checkConcurrency(rec, add, note) {
  const P = concPrefix(rec);
  const order = closeOrderOf(rec);
  const where = `stagger ${rec.stagger.nominalMs} ms${rec.attempt && rec.attempt.of > 1 ? ` (attempt ${rec.attempt.index}/${rec.attempt.of}, ${order.name})` : ''}`;
  const launchers = rec.launchers || {};
  let allReady = true;
  for (const label of ['A', 'B']) {
    const launcher = launchers[label];
    if (!launcher) { add(`${P}_${label}_NOT_LAUNCHED`, `${where}: launcher ${label} was never started.`); allReady = false; continue; }
    if (launcher.outcome === 'exited') {
      add(`${P}_${label}_EXITED_BEFORE_READY`, `${where}: launcher ${label} exited by itself with code ${launcher.exitCode}${launcher.signal ? ` (signal ${launcher.signal})` : ''} after ${launcher.elapsedMs} ms, before its main process was observed (${launcher.reason || 'no window'}); the launch was lost. This check does not establish the cause (an exit within the first few hundred ms happens before any extraction; see scripts/measure-portable-startup.cjs).`);
      allReady = false;
    } else if (launcher.outcome === 'timeout') {
      add(`${P}_${label}_NOT_READY`, `${where}: launcher ${label} was still running after ${launcher.elapsedMs} ms but no window appeared.`);
      allReady = false;
    } else if (launcher.outcome !== 'ready') {
      add(`${P}_${label}_NOT_READY`, `${where}: launcher ${label} ended as "${launcher.outcome}".`);
      allReady = false;
    } else if (!profileOk(rec[label] && rec[label].profile)) {
      add(`${P}_${label}_PROFILE_EMPTY`, `${where}: instance ${label} became ready but its --user-data-dir profile has no files (${fmtStats(rec[label] && rec[label].profile)}).`);
    }
  }
  if (!allReady) return;
  const { A, B } = rec;
  checkBaselineStats(add, `${P}_A`, 'A', A);
  checkBaselineStats(add, `${P}_B`, 'B', B);
  if (A.runDirKind !== 'per-launch-nsis') note(`${P}_A_RUNDIR_KIND`, `${where}: A's runtime directory is ${A.runDir} (${A.runDirKind}), not the NSIS plugin directory pattern nsXXXX.tmp\\app.`);
  if (B.runDirKind !== 'per-launch-nsis') note(`${P}_B_RUNDIR_KIND`, `${where}: B's runtime directory is ${B.runDir} (${B.runDirKind}), not the NSIS plugin directory pattern nsXXXX.tmp\\app.`);
  if (A.baseline && B.baseline && !statsEqual(A.baseline, B.baseline)) note(`${P}_BASELINE_DIFFERS`, `${where}: A's runtime (${fmtStats(A.baseline)}) and B's (${fmtStats(B.baseline)}) differ although both extract the same EXE.`);
  if (A.baselineManifest && B.baselineManifest && !manifestEqual(A.baselineManifest, B.baselineManifest) && statsEqual(A.baseline, B.baseline)) {
    note(`${P}_MANIFEST_DIFFERS`, `${where}: A's and B's runtimes have the same size but different per-file manifests (${shortDigest(A.baselineManifest.digest)} vs ${shortDigest(B.baselineManifest.digest)}) although both extract the same EXE.`);
  }
  if (rec.runDirShared) add(`${P}_RUNDIR_SHARED`, `${where}: A and B run from the same extraction directory (${A.runDir}); closing one instance deletes the other's runtime.`);
  checkSurvivor(add, `${P}_A`, 'A', rec.bothRunning && rec.bothRunning.A, A.baseline, A.windowMode, 'while both instances run', 'BOTH_RUNNING', A.baselineManifest);
  checkSurvivor(add, `${P}_B`, 'B', rec.bothRunning && rec.bothRunning.B, B.baseline, B.windowMode, 'while both instances run', 'BOTH_RUNNING', B.baselineManifest);
  // The instance that closes first must go away cleanly; the other one (the survivor) must not notice.
  const firstClosed = checkClose(add, `${P}_${order.first}`, order.first, order.firstClose, { expectRemoval: !rec.runDirShared });
  if (!firstClosed) return;
  const survivor = rec[order.second];
  checkSurvivor(add, `${P}_${order.second}`, order.second, order.afterFirst, survivor.baseline, survivor.windowMode, `immediately after ${order.first} exited`, 'IMMEDIATE', survivor.baselineManifest);
  checkSurvivor(add, `${P}_${order.second}`, order.second, order.afterFirstSettled, survivor.baseline, survivor.windowMode, `after ${order.first} exited, ${settleWhen(rec.settleMs)}`, 'SETTLED', survivor.baselineManifest);
  checkGpu(rec, add, P);
  if (order.secondClose) checkClose(add, `${P}_${order.second}`, order.second, order.secondClose, { expectRemoval: !rec.runDirShared });
  else add(`${P}_${order.second}_NOT_CLOSED`, `${where}: ${order.second} was never closed (the run stopped early).`);
}

// ---- scenario 2: the forwarded board must have been DELIVERED to C ------------------------------------------

/**
 * Looks for the synthetic board in the parsed config store of C's profile ({version, settings, recentBoards:[{name, path,
 * openedAt}]}, electron/main.cjs acceptBoard). The app records the CANONICAL (realpath) spelling, so every spelling is
 * compared case-insensitively and separator-tolerantly, directly and through `canonicalize` (8.3 short vs long names). Pure
 * apart from `canonicalize`.
 */
async function findForwardedBoard(config, boardFile, canonicalize) {
  if (!config || typeof config !== 'object' || !Array.isArray(config.recentBoards)) {
    return { found: false, recentCount: 0, matchedPath: null, recentNames: [], reason: 'config.json has no recentBoards list' };
  }
  const canon = async (value) => { try { return (await canonicalize(value)) || value; } catch { return value; } };
  const wanted = [boardFile];
  const boardCanonical = await canon(boardFile);
  if (!samePath(boardCanonical, boardFile)) wanted.push(boardCanonical);
  const recents = config.recentBoards.filter((item) => item && typeof item.path === 'string' && item.path);
  const recentNames = recents.slice(0, 5).map((item) => path.win32.basename(item.path));
  for (const item of recents) {
    const spellings = [item.path];
    const itemCanonical = await canon(item.path);
    if (!samePath(itemCanonical, item.path)) spellings.push(itemCanonical);
    if (spellings.some((spelling) => wanted.some((target) => samePath(spelling, target)))) {
      return { found: true, recentCount: recents.length, matchedPath: item.path, recentNames, reason: null };
    }
  }
  return { found: false, recentCount: recents.length, matchedPath: null, recentNames, reason: recents.length ? `${recents.length} recent board(s), none is the synthetic board (${recentNames.join(', ')})` : 'recentBoards is empty' };
}

// ---- payload parity (unpacked build vs extracted runtime) -----------------------------------------------------

const PARITY_LIMIT = payloadManifest.DIFF_LIMIT;

/**
 * Compares what was hashed in a RUNNING runtime directory with the validated manifest. Files that could not be read are
 * reported as `unreadable` (never as equal, never double-counted as missing). `equal` demands every count to be zero AND the
 * recomputed digest AND the exe/app.asar hashes to match. Pure.
 */
function evaluatePayloadParity(manifest, hashed, { attempts = 1, recovered = [] } = {}) {
  const files = hashed.files || [];
  const unreadable = hashed.unreadable || [];
  const diff = payloadManifest.diffFileLists(manifest.files, files, { limit: PARITY_LIMIT, compareHash: true, ignore: new Set(unreadable.map((item) => item.path)) });
  const record = {
    exists: hashed.exists !== false,
    expected: { fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, manifestDigest: manifest.manifestDigest, exeSha256: manifest.exeSha256, asarSha256: manifest.asarSha256 },
    actual: {
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      manifestDigest: payloadManifest.digestFileList(files, { withHash: true }),
      exeSha256: (files.find((file) => file.path === payloadManifest.MAIN_EXE_PATH) || {}).sha256 || null,
      asarSha256: (files.find((file) => file.path === payloadManifest.APP_ASAR_PATH) || {}).sha256 || null,
    },
    missingCount: diff.counts.missing, extraCount: diff.counts.extra, sizeMismatchCount: diff.counts.sizeMismatch, hashMismatchCount: diff.counts.hashMismatch, unreadableCount: unreadable.length,
    missing: diff.missing, extra: diff.extra, sizeMismatch: diff.sizeMismatch, hashMismatch: diff.hashMismatch,
    unreadable: unreadable.slice(0, PARITY_LIMIT).map((item) => ({ path: item.path, code: item.code })),
    attempts, recoveredAfterRetry: recovered.slice(0, PARITY_LIMIT), recoveredAfterRetryCount: recovered.length,
  };
  record.equal = record.exists && parityProblemCount(record) === 0 && record.actual.manifestDigest === manifest.manifestDigest
    && record.actual.exeSha256 === manifest.exeSha256 && record.actual.asarSha256 === manifest.asarSha256;
  record.text = formatParity(record);
  return record;
}

const parityProblemCount = (parity) => (parity.missingCount || 0) + (parity.extraCount || 0) + (parity.sizeMismatchCount || 0) + (parity.hashMismatchCount || 0) + (parity.unreadableCount || 0);

/** One line: what was compared and the verdict. Pure. */
function formatParity(parity) {
  if (!parity) return 'not run';
  if (parity.exists === false) return 'runtime directory not found';
  if (parity.equal) {
    return `identical to the payload manifest: ${parity.actual.fileCount} files / ${parity.actual.totalBytes} B, manifest ${shortDigest(parity.actual.manifestDigest)}, exe ${shortDigest(parity.actual.exeSha256)}, app.asar ${shortDigest(parity.actual.asarSha256)}${parity.recoveredAfterRetryCount ? ` (${parity.recoveredAfterRetryCount} file(s) needed a re-read)` : ''}`;
  }
  const first = [...(parity.missing || []), ...(parity.extra || []), ...(parity.sizeMismatch || []).map((item) => item.path), ...(parity.hashMismatch || []).map((item) => item.path), ...(parity.unreadable || []).map((item) => item.path)].slice(0, 3);
  return `DIFFERS from the payload manifest: missing ${parity.missingCount}, extra ${parity.extraCount}, size ${parity.sizeMismatchCount}, content ${parity.hashMismatchCount}, unreadable ${parity.unreadableCount}${first.length ? ` (e.g. ${first.join(', ')})` : ''}`;
}

/** Failures of one parity record, PAYLOAD_PARITY_<KIND>_<SUBJECT>; every list names up to 10 differing paths. */
function checkParitySubject(add, subject, label, parity, payload) {
  if (!parity) { add(`PAYLOAD_PARITY_NOT_RUN_${subject}`, `${label}: payload parity was requested (--payload-manifest) but this runtime directory was not hashed.`); return; }
  if (parity.exists === false) { add(`PAYLOAD_PARITY_DIR_MISSING_${subject}`, `${label}: the runtime directory (${parity.runDir}) did not exist when it was to be hashed.`); return; }
  const paths = (list, total) => `${list.join(', ')}${total > list.length ? `, +${total - list.length} more` : ''}`;
  let flagged = false;
  const flag = (id, message) => { flagged = true; add(`PAYLOAD_PARITY_${id}_${subject}`, `${label}: ${message}`); };
  if (parity.unreadableCount > 0) {
    flag('UNREADABLE', `${parity.unreadableCount} file(s) could not be read after ${parity.attempts || 1} attempt(s), so parity is NOT established for them: ${paths((parity.unreadable || []).map((item) => `${item.path || '.'} (${item.code})`), parity.unreadableCount)}.`);
  }
  if (parity.missingCount > 0) flag('MISSING', `${parity.missingCount} file(s) of the payload manifest are not in the running runtime directory: ${paths(parity.missing || [], parity.missingCount)}.`);
  if (parity.extraCount > 0) flag('EXTRA', `${parity.extraCount} file(s) in the running runtime directory are not in the payload manifest: ${paths(parity.extra || [], parity.extraCount)}.`);
  if (parity.sizeMismatchCount > 0) flag('SIZE', `${parity.sizeMismatchCount} file(s) differ in size from the payload manifest: ${paths((parity.sizeMismatch || []).map((item) => `${item.path} (${item.expected} -> ${item.actual} B)`), parity.sizeMismatchCount)}.`);
  if (parity.hashMismatchCount > 0) flag('HASH', `${parity.hashMismatchCount} file(s) have the same size but a different SHA-256 than the payload manifest: ${paths((parity.hashMismatch || []).map((item) => item.path), parity.hashMismatchCount)}.`);
  const actual = parity.actual || {};
  if (actual.exeSha256 !== payload.exeSha256) flag('EXE', `${payloadManifest.MAIN_EXE_PATH} sha256 ${actual.exeSha256 || 'n/a'} differs from the manifest's ${payload.exeSha256}.`);
  if (actual.asarSha256 !== payload.asarSha256) flag('ASAR', `${payloadManifest.APP_ASAR_PATH} sha256 ${actual.asarSha256 || 'n/a'} differs from the manifest's ${payload.asarSha256}.`);
  if (!flagged && actual.manifestDigest !== payload.manifestDigest) {
    flag('DIGEST', `the recomputed manifest digest ${shortDigest(actual.manifestDigest)} differs from the payload manifest's ${shortDigest(payload.manifestDigest)} although no individual difference was recorded.`);
  }
}

function checkPayloadParity(payload, baseline, records, add) {
  checkParitySubject(add, 'BASELINE', 'The baseline instance', baseline && baseline.payloadParity, payload);
  const target = records.find((rec) => rec.parityTarget === true);
  if (!target) { add('PAYLOAD_PARITY_NOT_RUN_CONCURRENCY', 'Payload parity was requested but no concurrency attempt was designated for it.'); return; }
  for (const label of ['A', 'B']) checkParitySubject(add, label, `${label} of ${target.name}`, target.payloadParity && target.payloadParity[label], payload);
}

function checkScenario2(s2, add, note) {
  if (!s2) { add('S2_NOT_RUN', 'Scenario 2 (second-instance forwarding) did not run.'); return; }
  if (!s2.C || !s2.D) { add('S2_INCOMPLETE', 'Scenario 2 did not record both launches.'); return; }
  const { C, D } = s2;
  checkBaselineStats(add, 'S2_C', 'C', C);
  if (D.sharesRunDirWithC === true) add('S2_RUNDIR_SHARED', `D (second launch) extracted into C's directory (${C.runDir}).`);
  if (!D.runDir) note('S2_D_RUNDIR_UNOBSERVED', 'D\'s main process was too short-lived to observe its runtime directory; its cleanup is judged from the leftover scan only.');
  if (!D.exitedByItself) {
    add('S2_D_NOT_SELF_EXIT', `D (second launch with the same profile and a board file) did not exit by itself within ${Math.round((D.waitedMs || 0) / 1000)} s (it was NOT force-killed by the check).`);
  } else if (D.exitCode !== 0) {
    add('S2_D_EXIT_CODE', `D exited with code ${D.exitCode}${D.signal ? ` (signal ${D.signal})` : ''}, expected 0.`);
  }
  if (D.exitedByItself) {
    checkSurvivor(add, 'S2_C', 'C', s2.afterDExit, C.baseline, C.windowMode, 'immediately after D exited', 'IMMEDIATE', C.baselineManifest);
    checkSurvivor(add, 'S2_C', 'C', s2.afterDExitSettled, C.baseline, C.windowMode, `after D exited, ${settleWhen(s2.settleMs)}`, 'SETTLED', C.baselineManifest);
    const cleanup = s2.dCleanup;
    if (!cleanup) add('S2_D_CLEANUP_NOT_CHECKED', 'D\'s cleanup was not checked.');
    else {
      if (cleanup.runDirRemoved === false) add('S2_D_RUNDIR_NOT_REMOVED', `D's extraction directory still exists after D exited: ${(cleanup.remaining || []).join(', ')}.`);
      if (cleanup.leftoverNsDirs && cleanup.leftoverNsDirs.length) add('S2_D_LEFTOVER_DIRS', `New extraction directories remain after D exited: ${cleanup.leftoverNsDirs.join(', ')}.`);
    }
    // Delivery proof: D going away proves nothing about whether the board argument reached C. C's own config store must say so.
    const forwarded = s2.forwardedBoard;
    if (!forwarded) add('S2_FORWARDED_BOARD_NOT_CHECKED', 'C\'s config store was not read, so the delivery of the forwarded board is unproven.');
    else {
      if (forwarded.preDRecorded === true) add('S2_FORWARDED_BOARD_PRERECORDED', 'C already had the synthetic board in its recent boards BEFORE D was launched, so a later entry would prove nothing about the forwarding.');
      if (forwarded.recorded !== true) add('S2_FORWARDED_BOARD_NOT_RECORDED', `After C closed normally its config store (${forwarded.configFile || 'config.json'}) does not list the synthetic board forwarded by D (${forwardedDetail(forwarded)}): the forwarded argument was not delivered or not accepted.`);
    }
  }
  if (s2.cClose) checkClose(add, 'S2_C', 'C', s2.cClose, { expectRemoval: !(D.sharesRunDirWithC === true) });
  else if (D.exitedByItself) add('S2_C_NOT_CLOSED', 'C was never closed (the run stopped early).');
}

/**
 * Names what a concurrency scenario showed. Pure.
 * isolated-ok | both-lost | a-exit-nonzero-b-survives | a-lost-b-survives | b-lost-a-survives |
 * shared-dir-runtime-shrinks | gpu-restart-damage | other-failure
 * Early-overlap names (a launcher lost before readiness) are only claimed when the baseline passed.
 */
function observedSignature(rec, { baselineOk = true, issueCount = 0 } = {}) {
  const launchers = rec.launchers || {};
  const state = (label) => (launchers[label] ? launchers[label].outcome : 'missing');
  const lost = (label) => state(label) !== 'ready';
  const indicators = [];
  let name = null;
  if (baselineOk) {
    const a = launchers.A;
    if (lost('A') && lost('B')) { name = 'both-lost'; indicators.push(`neither instance became ready (A ${state('A')}, B ${state('B')})`); }
    else if (lost('A')) {
      name = a && a.outcome === 'exited' && a.exitCode !== null && a.exitCode !== 0 ? 'a-exit-nonzero-b-survives' : 'a-lost-b-survives';
      indicators.push(`launcher A ${state('A')}${a && a.outcome === 'exited' ? ` with code ${a.exitCode} after ${a.elapsedMs} ms` : ''}, B survived`);
    } else if (lost('B')) { name = 'b-lost-a-survives'; indicators.push(`launcher B ${state('B')}, A survived`); }
  }
  const shared = rec.runDirShared === true;
  // The SURVIVOR is the instance that stays running while the other one closes first (B in A-first order, A in B-first order).
  const order = closeOrderOf(rec);
  const base = rec[order.second] && rec[order.second].baseline;
  const shrunkSnapshot = [order.afterFirst, order.afterFirstSettled].find((snapshot) => snapshot && statsReduced(snapshot.runDir, base));
  const shrunk = !!shrunkSnapshot;
  if (shared) indicators.push(`A and B ran from the same directory ${rec.A && rec.A.runDir}`);
  if (shrunk) indicators.push(`after ${order.first} closed, ${order.second}'s runtime went from ${fmtStats(base)} to ${fmtStats(shrunkSnapshot.runDir)}`);
  if (!name && (shared || shrunk)) name = 'shared-dir-runtime-shrinks';
  const g = rec.gpuRestart;
  const gpuDamage = !!(g && g.performed && base && ((g.after && g.after.proc && !g.after.proc.mainAlive) || !g.respawned || statsReduced(g.after && g.after.runDir, base) || statsReduced(g.afterSettled && g.afterSettled.runDir, base)));
  if (gpuDamage) indicators.push(`after the injected GPU restart B ${g.after && g.after.proc && !g.after.proc.mainAlive ? 'died' : g.respawned ? 'lost runtime files' : 'got no new gpu-process'}`);
  if (!name && gpuDamage) name = 'gpu-restart-damage';
  if (!name) name = issueCount ? 'other-failure' : 'isolated-ok';
  const family = REFERENCE_DEFECT_SIGNATURES.includes(name) ? 'reference-defect' : DEFECT_SIGNATURES.includes(name) ? 'defect-variant' : name === 'isolated-ok' ? 'ok' : 'other-failure';
  return { name, family, indicators, flags: { sharedRunDir: shared, runtimeShrunk: shrunk, earlyOverlap: ['both-lost', 'a-exit-nonzero-b-survives', 'a-lost-b-survives', 'b-lost-a-survives'].includes(name), gpuDamage } };
}

function expectedSignature(expect, nominalMs) {
  if (expect === 'isolated') return 'isolated-ok';
  const reference = LOCAL_REFERENCE.signatures.find((entry) => entry.nominalMs === nominalMs);
  return reference ? reference.signature : null;
}

/**
 * Decides the verdict from the recorded facts. Pure.
 * @param {{expect?: 'isolated'|'shared', baseline?: object, concurrency?: object[], scenario2?: object, forcedKill?: boolean, payload?: {manifestDigest: string, exeSha256: string, asarSha256: string}}} input
 * @returns {{verdict: 'pass'|'fail', mode: string, failures: {id: string, message: string}[], observations: object[], detection: object, signatures: object[]}}
 */
function analyze(input) {
  const expect = input && input.expect === 'shared' ? 'shared' : 'isolated';
  const issues = [];
  const notes = [];
  const add = (id, message, always = false) => { if (!issues.some((issue) => issue.id === id)) issues.push({ id, message, always }); };
  const note = (id, message) => notes.push({ id, message });
  if (input && input.forcedKill) add('FORCED_KILL_IN_SUCCESS_PATH', 'A process was force-killed during the check itself; the success path must close instances normally.', true);
  const baseline = input && input.baseline;
  const problems = baselineProblems(baseline);
  const baselineOk = problems.length === 0;
  if (!baseline) add('BASELINE_MISSING', 'The single-launch baseline did not run.', true);
  else if (!baselineOk) add('BASELINE_FAILED', `The single-launch baseline failed: ${problems.join('; ')}.`, true);
  else if (baseline.instance && baseline.instance.windowMode !== 'handle') note('BASELINE_WINDOW_MODE', `The baseline became ready through the renderer fallback (${baseline.instance.windowMode}), not through a window handle.`);
  const records = (input && input.concurrency) || [];
  if (!records.length) add('CONCURRENCY_NOT_RUN', 'No concurrency scenario ran.');
  const signatures = records.map((rec) => {
    let local = 0;
    checkConcurrency(rec, (id, message, always) => { local += 1; add(id, message, always); }, note);
    const observed = observedSignature(rec, { baselineOk, issueCount: local });
    const expected = expectedSignature(expect, rec.stagger.nominalMs);
    return {
      name: rec.name, prefix: concPrefix(rec), nominalMs: rec.stagger.nominalMs, achievedMs: rec.stagger.achievedMs, closeOrder: closeOrderOf(rec).name,
      attempt: rec.attempt ? rec.attempt.index : 1, signature: observed.name, family: observed.family, indicators: observed.indicators, flags: observed.flags,
      expectedSignature: expected, matchesReference: expected === null ? null : observed.name === expected,
    };
  });
  checkScenario2(input && input.scenario2, add, note);
  const s2 = input && input.scenario2;
  const payload = input && input.payload ? input.payload : null; // only in isolated mode: the validated payload manifest the runtime must equal
  if (payload) checkPayloadParity(payload, baseline, records, add);
  // The control verdict rests on STRUCTURAL evidence only (LOCAL's deterministic shared directory / 78 -> 7 files). Lost
  // launches, launcher exit codes and GPU damage are recorded as supplementary signatures: a slow runner can fake them.
  const structural = signatures.some((entry) => entry.flags.sharedRunDir || entry.flags.runtimeShrunk);
  const supplementary = signatures.some((entry) => DEFECT_SIGNATURES.includes(entry.signature));
  const detection = {
    any: baselineOk && structural,
    structural,
    supplementary,
    baselineOk,
    scenarios: signatures.map((entry) => ({ name: entry.name, closeOrder: entry.closeOrder, signature: entry.signature, family: entry.family })),
    // The same structural gate, reported per close order: when B closes first the survivor is A and A's runtime shrinks.
    byCloseOrder: Object.fromEntries(['A-first', 'B-first'].map((name) => {
      const group = signatures.filter((entry) => entry.closeOrder === name);
      return [name, { attempts: group.length, structural: group.some((entry) => entry.flags.sharedRunDir || entry.flags.runtimeShrunk), runtimeShrunk: group.some((entry) => entry.flags.runtimeShrunk) }];
    })),
    details: signatures.flatMap((entry) => entry.indicators.map((text) => `${entry.name}: ${text}`)),
    // Informational only: the control verdict rests on the concurrency scenarios.
    scenario2: {
      sharedDir: !!(s2 && s2.D && s2.D.sharesRunDirWithC === true),
      runtimeShrunk: !!(s2 && s2.C && [s2.afterDExit, s2.afterDExitSettled].some((snapshot) => snapshot && statsReduced(snapshot.runDir, s2.C.baseline))),
    },
  };
  let failures;
  let observations;
  if (expect === 'isolated') {
    failures = issues.map(({ id, message }) => ({ id, message }));
    for (const entry of signatures) {
      if (entry.signature !== 'isolated-ok' && !failures.some((failure) => failure.id.startsWith(`${entry.prefix}_`))) {
        failures.push({ id: `${entry.prefix}_SIGNATURE`, message: `${entry.name} showed signature "${entry.signature}" instead of "isolated-ok".` });
      }
    }
    observations = notes;
  } else {
    // Control mode: the effects of the defect are expected, so they are recorded rather than failed.
    failures = issues.filter((issue) => issue.always).map(({ id, message }) => ({ id, message }));
    if (!detection.any) {
      failures.push({
        id: 'CONTROL_DEFECT_NOT_DETECTED',
        message: baselineOk
          ? `Control mode: no scenario showed the STRUCTURAL old-defect signature (a shared runtime directory or the survivor's runtime shrinking after the other instance closed)${supplementary ? '; lost launches / launcher exit codes / GPU damage were recorded but are only supplementary because a slow runner can fake them' : ''}. The check would not catch the old defect with this EXE (or the control EXE is not defective).`
          : 'Control mode: the baseline did not pass, so no defect signature can be attributed.',
      });
    }
    observations = [...notes, ...issues.filter((issue) => !issue.always).map(({ id, message }) => ({ id, message, expectedInControlMode: true }))];
  }
  return { verdict: failures.length ? 'fail' : 'pass', mode: expect, failures, observations, detection, signatures };
}

/** "0,5000,main:10000" -> [{nominalMs, from}]; a bare number is measured from A's wrapper spawn. */
function parseStaggers(text) {
  const specs = [];
  for (const part of String(text).split(',').map((item) => item.trim())) {
    const match = /^(?:(wrapper|main):)?(\d{1,6})$/.exec(part);
    if (!match) throw new UsageError(`--staggers entries must look like 5000 or main:10000, got "${part}".`);
    const nominalMs = Number(match[2]);
    if (nominalMs > 120000) throw new UsageError('--staggers values must be at most 120000 ms.');
    if (specs.some((spec) => spec.nominalMs === nominalMs)) throw new UsageError(`--staggers lists ${nominalMs} twice.`);
    specs.push({ nominalMs, from: match[1] === 'main' ? 'main-seen' : 'wrapper-spawn' });
  }
  if (!specs.length) throw new UsageError('--staggers needs at least one value.');
  return specs;
}

function parseArgs(argv) {
  const options = { exe: null, expect: 'isolated', out: DEFAULT_OUT, timeoutSec: DEFAULT_TIMEOUT_SEC, staggers: DEFAULT_STAGGERS.map((spec) => ({ ...spec })), maxTotalSec: DEFAULT_MAX_TOTAL_SEC, repeat: DEFAULT_REPEAT, payloadManifest: null, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const take = () => {
      if (equals > 0) return arg.slice(equals + 1);
      if (index + 1 >= argv.length) throw new UsageError(`${flag} needs a value.`);
      return argv[++index];
    };
    const seconds = (raw, max) => {
      const value = Number(raw);
      if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(value) || value <= 0 || value > max) throw new UsageError(`${flag} must be a number between 1 and ${max}, got "${raw}".`);
      return value;
    };
    const count = (raw) => {
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > MAX_REPEAT) throw new UsageError(`${flag} must be a whole number between 1 and ${MAX_REPEAT}, got "${raw}".`);
      return value;
    };
    switch (flag) {
      case '--exe': options.exe = take(); break;
      case '--expect': options.expect = take(); break;
      case '--out': options.out = take(); break;
      case '--timeout-sec': options.timeoutSec = seconds(take(), 3600); break;
      case '--max-total-sec': options.maxTotalSec = seconds(take(), 7200); break;
      case '--staggers': options.staggers = parseStaggers(take()); break;
      case '--repeat': options.repeat = count(take()); break;
      case '--payload-manifest': options.payloadManifest = take(); break;
      case '--help': case '-h': options.help = true; break;
      default: throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  if (options.help) return options;
  if (!options.exe) throw new UsageError('--exe <portable.exe> is required.');
  if (options.expect !== 'isolated' && options.expect !== 'shared') throw new UsageError(`--expect must be "isolated" or "shared", got "${options.expect}".`);
  if (options.payloadManifest !== null && !options.payloadManifest) throw new UsageError('--payload-manifest needs a file name.');
  if (options.payloadManifest && options.expect === 'shared') throw new UsageError('--payload-manifest cannot be combined with --expect shared: the control EXE is a different build than the manifest describes.');
  return options;
}

function formatSummary(result) {
  const { evidence } = result;
  const lines = [];
  lines.push(`TRACE portable isolation check: ${result.verdict.toUpperCase()} (expect=${evidence.options.expect}, exit ${result.exitCode})`);
  if (evidence.exe) lines.push(`  exe: ${evidence.exe.path} (${evidence.exe.sizeBytes} B, sha256 ${evidence.exe.sha256})`);
  const repeat = evidence.options.repeat || 1;
  lines.push(`  repeat=${repeat}${repeat > 1 ? ' (every stagger runs that many times; odd attempts close A first, even attempts B first)' : ' (every stagger runs once, A closes first)'}; payload manifest: ${evidence.payload ? `${evidence.payload.file} (${evidence.payload.fileCount} files, digest ${shortDigest(evidence.payload.manifestDigest)})` : 'none (parity not requested)'}`);
  const baseline = evidence.baseline;
  if (baseline && baseline.launcher) {
    lines.push(`  baseline (single launch): ${baseline.launcher.outcome}${baseline.instance ? ` runDir=${baseline.instance.runDir} [${fmtStats(baseline.instance.baseline)}] profile=${fmtStats(baseline.instance.profile)}` : ''}${baseline.close ? `, closed exit=${baseline.close.exitCode} runtimeRemoved=${baseline.close.cleanup && baseline.close.cleanup.runDirRemoved}` : ''}${baseline.problems && baseline.problems.length ? `, PROBLEMS: ${baseline.problems.join('; ')}` : ''}`);
  }
  if (baseline && baseline.payloadParity) lines.push(`    baseline payload parity: ${formatParity(baseline.payloadParity)}`);
  for (const rec of evidence.concurrency || []) {
    const observed = rec.observed || {};
    const L = rec.launchers || {};
    const launcher = (label) => (L[label] ? `${L[label].outcome}${L[label].exitCode !== null && L[label].exitCode !== undefined ? `(code ${L[label].exitCode})` : ''}@${L[label].elapsedMs}ms` : 'n/a');
    lines.push(`  ${rec.name}: stagger nominal ${rec.stagger.nominalMs} ms from ${rec.stagger.from}, achieved ${rec.stagger.achievedMs} ms; signature=${observed.signature}${observed.expectedSignature ? ` (expected ${observed.expectedSignature}, matchesReference=${observed.matchesReference})` : ''}`);
    lines.push(`    launchers A ${launcher('A')}, B ${launcher('B')}; runDirShared=${rec.runDirShared}${rec.A ? `; A [${fmtStats(rec.A.baseline)}] ${rec.A.runDir}` : ''}${rec.B ? `; B [${fmtStats(rec.B.baseline)}] ${rec.B.runDir}` : ''}`);
    const order = closeOrderOf(rec);
    if (rec.closeOrder) lines.push(`    close order ${rec.closeOrder}${rec.attempt ? ` (attempt ${rec.attempt.index}/${rec.attempt.of})` : ''}: ${order.first} closes first, ${order.second} is the survivor${rec.preservation ? `; ${rec.preservation.text}` : ''}`);
    if (order.firstClose) lines.push(`    ${order.first} closed (${order.firstClose.method}): exited=${order.firstClose.exited} code=${order.firstClose.exitCode}; ${order.second} after ${order.first} exit: ${fmtStats(order.afterFirst && order.afterFirst.runDir)}, alive=${order.afterFirst && order.afterFirst.proc && order.afterFirst.proc.mainAlive}, responding=${order.afterFirst && order.afterFirst.proc && order.afterFirst.proc.responding}`);
    if (rec.payloadParity) for (const label of ['A', 'B']) lines.push(`    payload parity ${label}: ${formatParity(rec.payloadParity[label])}`);
    if (rec.gpuRestart) {
      const g = rec.gpuRestart;
      lines.push(`    INJECTED GPU restart: ${g.skipped ? `skipped (${g.skipped})` : `target=${g.targetPid} performed=${g.performed} gpu pids before [${(g.pidsBefore || []).join(',')}] after [${(g.pidsAfter || []).join(',')}] respawned=${g.respawned} B alive=${g.after && g.after.proc && g.after.proc.mainAlive}`}`);
    }
    if (order.secondClose) lines.push(`    ${order.second} closed (${order.secondClose.method}): exited=${order.secondClose.exited} code=${order.secondClose.exitCode}`);
  }
  const s2 = evidence.scenario2;
  if (s2 && s2.C) {
    lines.push(`  second-instance: C ${s2.C.runDir} [${fmtStats(s2.C.baseline)}]${s2.D ? `; D exitedByItself=${s2.D.exitedByItself} code=${s2.D.exitCode}${s2.D.runDir ? ` runDir=${s2.D.runDir}` : ' (runDir not observed)'}` : ''}`);
    if (s2.afterDExit) lines.push(`    C after D exit: ${fmtStats(s2.afterDExit.runDir)}, alive=${s2.afterDExit.proc && s2.afterDExit.proc.mainAlive}, responding=${s2.afterDExit.proc && s2.afterDExit.proc.responding}`);
    if (s2.preservation) lines.push(`    C ${s2.preservation.text}`);
    if (s2.cClose) lines.push(`    C closed (${s2.cClose.method}): exited=${s2.cClose.exited} code=${s2.cClose.exitCode}`);
    if (s2.forwardedBoard) lines.push(`    forwardedBoardRecorded=${s2.forwardedBoard.recorded}: ${s2.forwardedBoard.text}`);
  }
  if (evidence.payloadParity) lines.push(`  payload parity: ${evidence.payloadParity.passed ? 'every checked runtime directory is identical to the payload manifest' : 'NOT established'} (${evidence.payloadParity.subjects.map((subject) => `${subject.subject}=${subject.equal}`).join(', ')})`);
  lines.push(`  forcedKill=${evidence.forcedKill} (success path); cleanupKilled=${!!evidence.cleanupKilled}${evidence.cleanupKilledPids && evidence.cleanupKilledPids.length ? ` (pids ${evidence.cleanupKilledPids.join(', ')})` : ''}`);
  if (evidence.detection && (evidence.options.expect === 'shared' || evidence.detection.any)) {
    lines.push(`  old defect detected: ${evidence.detection.any} (structural=${evidence.detection.structural}, supplementary=${evidence.detection.supplementary})${evidence.detection.details.length ? ` (${evidence.detection.details.join('; ')})` : ''}`);
    const byOrder = evidence.detection.byCloseOrder;
    if (byOrder) lines.push(`    per close order: ${['A-first', 'B-first'].filter((name) => byOrder[name] && byOrder[name].attempts).map((name) => `${name} ${byOrder[name].attempts} attempt(s) structural=${byOrder[name].structural} runtimeShrunk=${byOrder[name].runtimeShrunk}`).join('; ') || 'n/a'}`);
  }
  if (evidence.infrastructureError) lines.push(`  INFRASTRUCTURE FAILURE${evidence.infrastructureError.step ? ` at ${evidence.infrastructureError.step}` : ''}: ${evidence.infrastructureError.message}`);
  if (result.failures.length) {
    lines.push(`  failed assertions (${result.failures.length}):`);
    for (const failure of result.failures) lines.push(`    - ${failure.id}: ${failure.message}`);
  } else if (!evidence.infrastructureError) lines.push('  failed assertions: none');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------
// Orchestration (all OS interaction goes through `platform`)
// ---------------------------------------------------------------------------------------------------------

/**
 * platform contract (see createNodePlatform for the real implementation):
 *   info() -> {os, release, node, arch}          nowIso() -> string        now() -> monotonic ms (high resolution)
 *   sleep(ms) -> Promise                          log(line)
 *   fileInfo(exe) -> Promise<{sizeBytes, sha256}>
 *   makeTempArea() -> Promise<dir>                removeTempArea(dir) -> Promise   (one area per scenario)
 *   writeFile(file, text) -> Promise              removeTree(dir) -> Promise<boolean>
 *   launch(exe, args, {cwd}) -> Promise<{pid, state() -> {exited, exitCode, signal, exitedAtMs}}>
 *   snapshot() -> Promise<ProcessRecord[]>        every TRACE Boardviewer.exe process (see parseProcessJson)
 *   closeMainWindow(pid) -> Promise<{method, ok, detail}>   graceful close request, never a kill
 *   terminateChildProcess(pid, {rootPid, type}) -> Promise<{killed, reason}>   injected GPU restart only; refuses
 *                                                 anything that is not a `type` descendant of rootPid
 *   dirStats(dir) -> Promise<{exists, files, bytes}>        exists(path) -> Promise<boolean>
 *   dirManifest(dir) -> Promise<{exists, files: [{path, size}]}>   size-only listing of every file (relative POSIX paths); the
 *                                                 per-file preservation manifest is derived from it
 *   hashTree(dir, {skip}) -> Promise<{exists, files: [{path, size, sha256}], unreadable: [{path, code}]}>   streaming SHA-256 of
 *                                                 every file of a (running) runtime directory; `skip` = Set of paths already hashed
 *   readJsonFile(file) -> Promise<{status: 'ok', value} | {status: 'missing'} | {status: 'error', message}>   the app's config
 *                                                 store in a profile, the payload manifest
 *   canonicalize(path) -> Promise<string>         listNsRuntimeDirs() -> Promise<string[]>  (nsXXXX.tmp\app dirs)
 *   killTree(pid) -> Promise                      forcibly kills a process tree; only the final cleanup calls it
 *   killLog() -> {pid, atMs}[]                    every forced kill the platform performed via killTree
 */

function createContext(options, platform, evidence) {
  const tuning = { ...DEFAULT_TUNING, ...(options.tuning || {}) };
  const timeoutMs = options.timeoutSec * 1000;
  const startedAt = platform.now();
  const ctx = {
    options, platform, tuning, timeoutMs, evidence, startedAt,
    deadline: startedAt + options.maxTotalSec * 1000, // global safety net: nothing may run forever
    exe: null, payload: null, area: null, spawned: [], mains: [], runtimeDirs: [], knownRuntimeDirs: [], forcedKill: false, cleanupKilled: false, cleanupKilledPids: [],
    step(label, data) {
      const tMs = round2(platform.now() - startedAt);
      evidence.timeline.push({ tMs, step: label, ...(data || {}) });
      const detail = data ? ' ' + Object.entries(data).map(([key, value]) => `${key}=${typeof value === 'object' && value !== null ? JSON.stringify(value) : value}`).join(' ') : '';
      platform.log(`[+${(tMs / 1000).toFixed(1)}s] ${label}${detail}`);
    },
    checkBudget(step) {
      if (platform.now() > ctx.deadline) throw new InfraError(`global time budget of ${options.maxTotalSec} s exhausted`, step);
    },
    /**
     * Process snapshot with ONE retry. A snapshot that still fails is an infrastructure failure: an unreadable process table must
     * never be mistaken for "no processes" (which would look like lost launches). The retry only repeats an observation.
     */
    async snapshot(step) {
      let first;
      try { return await platform.snapshot(); } catch (error) { first = error; }
      ctx.step('process snapshot failed, retrying once', { at: step, error: first.message });
      try { return await platform.snapshot(); } catch (error) {
        throw new InfraError(`process snapshot failed twice (${first.message}; ${error.message})`, step);
      }
    },
  };
  return ctx;
}

/** Fresh temp area and process bookkeeping per scenario; the scenario's own cleanup runs in `finally`. */
async function withScenario(ctx, name, body) {
  const { platform, evidence } = ctx;
  ctx.area = null; ctx.spawned = []; ctx.mains = []; ctx.runtimeDirs = [];
  const killsBefore = platform.killLog().length;
  ctx.step(`scenario ${name}: start`);
  try {
    ctx.area = await platform.makeTempArea();
    evidence.tempAreas.push(ctx.area);
    return await body();
  } finally {
    if (platform.killLog().length > killsBefore) ctx.forcedKill = true; // anything killed so far was killed on the success path
    let result;
    try { result = await cleanup(ctx); } catch (error) { result = { killedPids: [], removed: [], errors: [String(error && error.message || error)] }; }
    evidence.cleanup.push({ scenario: name, ...result });
    if (result.killedPids.length) { // the cleanup had to kill something this script started (never part of the verdict; see analyze)
      ctx.cleanupKilled = true;
      ctx.cleanupKilledPids.push(...result.killedPids);
    }
  }
}

async function launchWrapper(ctx, label, args) {
  let handle;
  try { handle = await ctx.platform.launch(ctx.exe, args, { cwd: ctx.area }); } catch (error) {
    throw new InfraError(`${label}: could not start the portable EXE: ${error.message}`, `launch ${label}`);
  }
  ctx.spawned.push({ label, pid: handle.pid, handle });
  ctx.step(`${label}: wrapper started`, { pid: handle.pid });
  return handle;
}

/** Remember a main process (and the extraction directory it runs from) that this script started, for the final cleanup. */
function registerMain(ctx, main) {
  if (ctx.mains.some((known) => known.pid === main.pid)) return;
  const classification = classifyRuntimeDir(path.win32.dirname(main.exe));
  const entry = { runDir: classification.dir, nsisParent: classification.nsisParent };
  ctx.mains.push({ pid: main.pid, exe: main.exe });
  ctx.runtimeDirs.push(entry);
  if (!ctx.knownRuntimeDirs.some((known) => samePath(known.runDir, entry.runDir))) ctx.knownRuntimeDirs.push(entry);
}

// ---- readiness trackers ---------------------------------------------------------------------------------

function newTracker(ctx, label, handle, profile) {
  return { label, handle, profile, launchedAt: ctx.platform.now(), status: 'pending', reason: 'no process snapshot yet', mainSeenAt: null, instance: null, exitCode: null, signal: null, elapsedMs: null, wrapperPid: handle.pid };
}

async function describeReady(ctx, tracker, probe, records, at) {
  const runDir = path.win32.dirname(probe.main.exe);
  const classification = classifyRuntimeDir(runDir);
  const runDirCanonical = await ctx.platform.canonicalize(runDir);
  const listing = summarizeSnapshot(await ctx.platform.dirManifest(runDir));
  const baseline = listing.runDir;
  const instance = {
    label: tracker.label, wrapperPid: tracker.handle.pid, mainPid: probe.main.pid, mainExe: probe.main.exe,
    descendantPids: descendantsOf(records, probe.main.pid).map((record) => record.pid),
    runDir, runDirCanonical, runDirKind: classification.kind, nsisParent: classification.nsisParent,
    windowMode: probe.mode, readyAfterMs: round2(at - tracker.launchedAt), baseline,
    // Per-file manifest (sorted relative path + size) of the runtime when the instance became ready. Only its digest goes into the
    // evidence; the listing stays in memory so a later difference can name the missing/extra paths.
    baselineManifest: { fileCount: baseline.files, digest: listing.digest }, profile: null,
  };
  BASELINE_LISTINGS.set(instance, listing.files);
  ctx.step(`${tracker.label}: ready`, { mainPid: instance.mainPid, mode: instance.windowMode, runDir, files: baseline.files, bytes: baseline.bytes, manifest: shortDigest(listing.digest), afterMs: instance.readyAfterMs });
  return instance;
}

/** In-memory only: instance -> its runtime's sorted [{path, size}] listing at readiness (never serialized). */
const BASELINE_LISTINGS = new WeakMap();

/** {exists, files:[{path,size}]} -> {runDir: {exists, files, bytes}, digest, files}; the counts and the digest come from ONE walk. */
function summarizeSnapshot(listing) {
  const files = listing && listing.exists ? listing.files : [];
  return {
    runDir: { exists: !!(listing && listing.exists), files: files.length, bytes: files.reduce((total, file) => total + file.size, 0) },
    digest: payloadManifest.digestFileList(files, { withHash: false }),
    files,
  };
}

/** One snapshot (InfraError when unreadable), then every pending tracker becomes ready / exited / timeout or stays pending. */
async function pollOnce(ctx, trackers) {
  const pending = trackers.filter((tracker) => tracker.status === 'pending');
  if (!pending.length) return;
  const { platform, tuning } = ctx;
  const records = await ctx.snapshot('readiness poll'); // throws InfraError when the process table cannot be read
  const at = platform.now();
  for (const tracker of pending) {
    const probe = isReady(records, tracker.handle.pid, { sinceMainMs: tracker.mainSeenAt === null ? 0 : at - tracker.mainSeenAt, minSettleMs: tuning.minSettleMs });
    if (probe.main && tracker.mainSeenAt === null) { tracker.mainSeenAt = at; ctx.step(`${tracker.label}: main process first observed`, { mainPid: probe.main.pid }); }
    if (probe.main && probe.main.exe) registerMain(ctx, probe.main); // known to the cleanup even if it never becomes ready
    tracker.reason = probe.reason;
    if (probe.ready) { tracker.instance = await describeReady(ctx, tracker, probe, records, at); tracker.status = 'ready'; continue; }
    const state = tracker.handle.state();
    if (state.exited) {
      tracker.status = 'exited';
      tracker.exitCode = state.exitCode;
      tracker.signal = state.signal || null;
      tracker.elapsedMs = round2(Math.max(0, (state.exitedAtMs ?? platform.now()) - tracker.launchedAt));
      ctx.step(`${tracker.label}: launcher exited before readiness`, { exitCode: state.exitCode, afterMs: tracker.elapsedMs, reason: tracker.reason });
    } else if (at - tracker.launchedAt >= ctx.timeoutMs) {
      tracker.status = 'timeout';
      tracker.elapsedMs = round2(at - tracker.launchedAt);
    }
  }
}

/**
 * Polls until every tracker is resolved, or (with `until`, an absolute time) until that time has come. A snapshot costs
 * seconds on a real runner, so when the remaining time is shorter than the last poll the pump just waits for `until`
 * instead of overshooting the requested stagger by a whole poll.
 */
async function pumpTrackers(ctx, trackers, until = null) {
  let lastPollMs = 0;
  for (;;) {
    ctx.checkBudget('readiness');
    if (until !== null) {
      const remaining = until - ctx.platform.now();
      if (remaining <= 0) return;
      if (remaining <= lastPollMs) { await ctx.platform.sleep(remaining); return; }
    }
    const pollStarted = ctx.platform.now();
    await pollOnce(ctx, trackers);
    const now = ctx.platform.now();
    lastPollMs = now - pollStarted;
    if (until === null) { if (!trackers.some((tracker) => tracker.status === 'pending')) return; }
    else if (now >= until) return;
    await ctx.platform.sleep(until === null ? ctx.tuning.pollMs : Math.max(1, Math.min(ctx.tuning.pollMs, until - now)));
  }
}

function launcherFacts(tracker) {
  return {
    outcome: tracker.status, wrapperPid: tracker.wrapperPid, exitCode: tracker.exitCode, signal: tracker.signal,
    elapsedMs: tracker.status === 'ready' ? tracker.instance.readyAfterMs : tracker.elapsedMs, reason: tracker.status === 'ready' ? null : tracker.reason,
  };
}

/** Profile files appear shortly before/after the window; bounded wait, then the observed numbers are recorded as they are. */
async function awaitProfile(ctx, tracker) {
  const { platform, tuning } = ctx;
  const started = platform.now();
  let stats;
  for (;;) {
    stats = await platform.dirStats(tracker.profile);
    if ((stats.exists && stats.files > 0) || platform.now() - started >= tuning.profileWaitMs) break;
    await platform.sleep(500);
  }
  return { ...stats, waitedMs: round2(platform.now() - started) };
}

/** For scenarios whose first instance must exist (scenario 2): anything but "ready" is an infrastructure failure. */
async function bringUpOrThrow(ctx, label, handle, profile) {
  const tracker = newTracker(ctx, label, handle, profile);
  await pumpTrackers(ctx, [tracker]);
  if (tracker.status === 'exited') {
    throw new InfraError(`${label}: the wrapper exited (code ${tracker.exitCode}${tracker.signal ? `, signal ${tracker.signal}` : ''}) before its main process became ready (${tracker.reason}).`, `${label} readiness`);
  }
  if (tracker.status !== 'ready') {
    throw new InfraError(`${label}: not ready within ${ctx.options.timeoutSec} s (${tracker.reason}).`, `${label} readiness`);
  }
  tracker.instance.profile = await awaitProfile(ctx, tracker);
  return tracker.instance;
}

const sameDirectory = (a, b) => samePath(a.runDir, b.runDir) || samePath(a.runDirCanonical, b.runDirCanonical);

async function observe(ctx, instance, handle, step) {
  const records = await ctx.snapshot(step);
  const proc = inspectInstance(records, instance);
  proc.wrapperAlive = !handle.state().exited;
  const listing = summarizeSnapshot(await ctx.platform.dirManifest(instance.runDir));
  // `runDir` keeps the count/bytes shape; `manifest` is the exact per-file SET (path+size) as a digest plus, only when it differs
  // from the instance's baseline, the difference (counts and up to 10 missing/extra/changed paths).
  const manifest = { digest: listing.digest, fileCount: listing.runDir.files, diff: null };
  const reference = BASELINE_LISTINGS.get(instance);
  if (reference && instance.baselineManifest && listing.digest !== instance.baselineManifest.digest) {
    manifest.diff = payloadManifest.diffFileLists(reference, listing.files, { compareHash: false });
  }
  return { atMs: round2(ctx.platform.now() - ctx.startedAt), runDir: listing.runDir, manifest, proc };
}

// ---- payload parity: the RUNNING runtime must equal the build's unpacked payload ----------------------------

/** Reads and validates --payload-manifest. Anything wrong with the manifest itself is an infrastructure failure (exit 2). */
async function loadPayloadManifest(ctx, file) {
  let read;
  try { read = await ctx.platform.readJsonFile(file); } catch (error) {
    throw new InfraError(`cannot read the payload manifest ${file}: ${error.message}`, 'read payload manifest');
  }
  if (!read || read.status !== 'ok') {
    throw new InfraError(`cannot read the payload manifest ${file}: ${read && read.status === 'missing' ? 'file not found' : (read && read.message) || 'unreadable'}`, 'read payload manifest');
  }
  const problems = payloadManifest.validateManifest(read.value);
  if (problems.length) throw new InfraError(`the payload manifest ${file} is not valid: ${problems.slice(0, 5).join('; ')}`, 'read payload manifest');
  const manifest = read.value;
  if (!manifest.exeSha256 || !manifest.asarSha256) {
    throw new InfraError(`the payload manifest ${file} lists no ${payloadManifest.MAIN_EXE_PATH} / ${payloadManifest.APP_ASAR_PATH}, so it cannot establish parity of the executable and the app archive`, 'read payload manifest');
  }
  return {
    file, manifest,
    summary: { file, schema: manifest.schema, manifestDigest: manifest.manifestDigest, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, exeSha256: manifest.exeSha256, asarSha256: manifest.asarSha256 },
  };
}

/**
 * Hashes the files of a RUNNING instance's runtime directory (streaming SHA-256, same algorithm as scripts/payload-manifest.cjs)
 * and compares every file (path, size, SHA-256) with the manifest. A file that cannot be read right now (antivirus, a sibling
 * touching it) is re-read after a pause, `parityAttempts` times in total; one that is still unreadable is REPORTED as
 * unreadable and fails the check. A content difference is final: it is never re-read.
 */
async function verifyPayloadParity(ctx, subject, instance) {
  const { platform, tuning } = ctx;
  ctx.checkBudget('payload parity');
  const started = platform.now();
  const maxAttempts = Math.max(1, tuning.parityAttempts);
  const hashed = new Map();
  const everUnreadable = new Set();
  let attempts = 0;
  let exists = false;
  let pending = [];
  for (;;) {
    attempts += 1;
    const pass = await platform.hashTree(instance.runDir, { skip: new Set(hashed.keys()) });
    exists = pass.exists !== false;
    for (const file of pass.files || []) hashed.set(file.path, file);
    pending = pass.unreadable || [];
    for (const item of pending) everUnreadable.add(item.path);
    if (!exists || !pending.length || attempts >= maxAttempts) break;
    ctx.step(`payload parity ${subject}: ${pending.length} file(s) not readable, re-reading`, { attempt: attempts, first: pending.slice(0, 3).map((item) => `${item.path} (${item.code})`) });
    await platform.sleep(tuning.parityRetryDelayMs);
    ctx.checkBudget('payload parity');
  }
  const stillUnreadable = new Set(pending.map((item) => item.path));
  const recovered = [...everUnreadable].filter((name) => !stillUnreadable.has(name) && hashed.has(name)).sort();
  const record = evaluatePayloadParity(ctx.payload.manifest, { exists, files: [...hashed.values()], unreadable: pending }, { attempts, recovered });
  record.subject = subject;
  record.runDir = instance.runDir;
  record.hashingMs = round2(platform.now() - started);
  ctx.step(`payload parity ${subject}`, { equal: record.equal, files: record.actual.fileCount, attempts, hashingMs: record.hashingMs, exe: shortDigest(record.actual.exeSha256), asar: shortDigest(record.actual.asarSha256), missing: record.missingCount, extra: record.extraCount, size: record.sizeMismatchCount, hash: record.hashMismatchCount, unreadable: record.unreadableCount });
  return record;
}

async function waitExit(ctx, handle, timeoutMs, pollMs = ctx.tuning.pollMs) {
  const started = ctx.platform.now();
  for (;;) {
    ctx.checkBudget('wait for exit');
    const state = handle.state();
    const waitedMs = round2(ctx.platform.now() - started);
    if (state.exited) return { exited: true, exitCode: state.exitCode, signal: state.signal || null, waitedMs };
    if (waitedMs >= timeoutMs) return { exited: false, exitCode: null, signal: null, waitedMs };
    await ctx.platform.sleep(pollMs);
  }
}

/** Bounded wait for the wrapper's own cleanup to become visible; reports delay, never retries a close. */
async function waitForRemoval(ctx, paths, maxWaitMs = ctx.tuning.cleanupWaitMs) {
  const started = ctx.platform.now();
  let remaining = paths.slice();
  for (;;) {
    const next = [];
    for (const target of remaining) if (await ctx.platform.exists(target)) next.push(target);
    remaining = next;
    const waitedMs = round2(ctx.platform.now() - started);
    if (!remaining.length) return { removed: true, waitedMs, remaining: [] };
    if (waitedMs >= maxWaitMs) return { removed: false, waitedMs, remaining };
    await ctx.platform.sleep(500);
  }
}

async function cleanupFacts(ctx, instance, skipRuntimeDir, maxWaitMs) {
  if (skipRuntimeDir) return { skipped: 'runtime directory is shared with a sibling instance' };
  const targets = [instance.runDir];
  if (instance.nsisParent) targets.push(instance.nsisParent);
  const result = await waitForRemoval(ctx, targets, maxWaitMs);
  return {
    runDirRemoved: !result.remaining.some((target) => samePath(target, instance.runDir)),
    nsisParent: instance.nsisParent,
    nsisParentRemoved: instance.nsisParent ? !result.remaining.some((target) => samePath(target, instance.nsisParent)) : null,
    waitedMs: result.waitedMs,
    remaining: result.remaining,
  };
}

/** Normal close (never a kill), then wait for the wrapper to leave by itself. */
async function closeAndWait(ctx, label, instance, handle, { skipRuntimeDir = false, cleanupWaitMs } = {}) {
  const result = { label, alreadyExited: false, delivered: false, method: null, detail: null, exited: false, exitCode: null, signal: null, waitedMs: 0 };
  const before = handle.state();
  if (before.exited) {
    Object.assign(result, { alreadyExited: true, exited: true, exitCode: before.exitCode, signal: before.signal || null, method: 'none', detail: 'wrapper had already exited' });
  } else {
    let close;
    try { close = await ctx.platform.closeMainWindow(instance.mainPid); } catch (error) {
      throw new InfraError(`${label}: could not send the close request: ${error.message}`, `close ${label}`);
    }
    result.delivered = !!close.ok; result.method = close.method; result.detail = close.detail ?? null;
    Object.assign(result, await waitExit(ctx, handle, result.delivered ? ctx.timeoutMs : ctx.tuning.settleMs));
  }
  if (result.exited) result.cleanup = await cleanupFacts(ctx, instance, skipRuntimeDir, cleanupWaitMs);
  ctx.step(`${label}: closed`, { method: result.method, delivered: result.delivered, exited: result.exited, exitCode: result.exitCode });
  return result;
}

// ---- scenario 0: baseline -------------------------------------------------------------------------------

async function baselineScenario(ctx) {
  const { evidence } = ctx;
  const rec = evidence.baseline = { name: 'baseline', launcher: null, instance: null, payloadParity: null, close: null, problems: [], passed: false };
  await withScenario(ctx, 'baseline', async () => {
    const profile = path.join(ctx.area, 'profileBaseline');
    const handle = await launchWrapper(ctx, 'baseline', [`--user-data-dir=${profile}`]);
    const tracker = newTracker(ctx, 'baseline', handle, profile);
    await pumpTrackers(ctx, [tracker]);
    if (tracker.status === 'ready') {
      tracker.instance.profile = await awaitProfile(ctx, tracker);
      // The runtime of the RUNNING baseline instance must equal the build's unpacked payload, file by file (a finding about the
      // product, not a baseline problem: it never turns the baseline into an infrastructure failure).
      if (ctx.payload) rec.payloadParity = await verifyPayloadParity(ctx, 'baseline', tracker.instance);
    }
    rec.launcher = launcherFacts(tracker);
    rec.instance = tracker.instance;
    if (tracker.status === 'ready') rec.close = await closeAndWait(ctx, 'baseline', tracker.instance, handle, { cleanupWaitMs: ctx.tuning.baselineCleanupWaitMs });
  });
  rec.problems = baselineProblems(rec);
  rec.passed = rec.problems.length === 0;
  if (!rec.passed) throw new InfraError(`the baseline (one launch alone) failed, so nothing else can be concluded: ${rec.problems.join('; ')}`, 'baseline');
}

// ---- scenario 1: concurrency ----------------------------------------------------------------------------

/** Waits (polling A) until the nominal stagger has elapsed from its reference point; returns that reference time. */
async function waitStagger(ctx, tracker, spec) {
  if (spec.from === 'main-seen') {
    for (;;) {
      ctx.checkBudget('stagger');
      await pollOnce(ctx, [tracker]);
      if (tracker.mainSeenAt !== null || tracker.status !== 'pending') break;
      await ctx.platform.sleep(ctx.tuning.pollMs);
    }
    if (tracker.mainSeenAt === null) return { referenceMs: null, reached: false }; // A never produced a main process: launch B at once
    if (spec.nominalMs > 0) await pumpTrackers(ctx, [tracker], tracker.mainSeenAt + spec.nominalMs);
    return { referenceMs: tracker.mainSeenAt, reached: true };
  }
  if (spec.nominalMs > 0) await pumpTrackers(ctx, [tracker], tracker.launchedAt + spec.nominalMs);
  return { referenceMs: tracker.launchedAt, reached: true };
}

/**
 * One concurrency attempt: launch A, then B after the stagger, then close ONE instance normally (A in 'A-first' order, B in
 * 'B-first' order) while the other one, the survivor, must not notice. Every attempt has its own temp area and profiles.
 * @param {{attempt?: number, repeat?: number, closeOrder?: 'A-first'|'B-first', injectGpu?: boolean, parityTarget?: boolean}} plan
 */
async function concurrencyScenario(ctx, spec, plan = {}) {
  const { platform, tuning, evidence } = ctx;
  const { attempt = 1, repeat = 1, closeOrder = 'A-first', parityTarget = false } = plan;
  const bFirst = closeOrder === 'B-first';
  const injectGpu = !!plan.injectGpu; // run() asks for it in attempt 1 only, which always closes A first (B, the injection's target, survives)
  const first = bFirst ? 'B' : 'A';
  const second = bFirst ? 'A' : 'B';
  const rec = {
    name: concName(spec.nominalMs, attempt, repeat),
    attempt: { index: attempt, of: repeat },
    closeOrder, closedFirst: first, survivor: second,
    stagger: { nominalMs: spec.nominalMs, from: spec.from, achievedMs: null, achievedFromAWrapperSpawnMs: null, referenceReached: null, aStatusAtBLaunch: null, aMainSeenAtBLaunch: null },
    injectGpu, parityTarget, launchers: {}, A: null, B: null, runDirShared: null, bothRunning: null, payloadParity: null,
    aClose: null, afterAExit: null, afterAExitSettled: null, afterBExit: null, afterBExitSettled: null, settleMs: null, gpuRestart: null, bClose: null, preservation: null, observed: null,
  };
  evidence.concurrency.push(rec);
  await withScenario(ctx, rec.name, async () => {
    const profileA = path.join(ctx.area, 'profileA');
    const profileB = path.join(ctx.area, 'profileB');
    const handleA = await launchWrapper(ctx, 'A', [`--user-data-dir=${profileA}`]);
    const trackerA = newTracker(ctx, 'A', handleA, profileA);
    const reference = await waitStagger(ctx, trackerA, spec);
    const handleB = await launchWrapper(ctx, 'B', [`--user-data-dir=${profileB}`]);
    const trackerB = newTracker(ctx, 'B', handleB, profileB);
    rec.stagger.achievedFromAWrapperSpawnMs = round2(trackerB.launchedAt - trackerA.launchedAt);
    rec.stagger.achievedMs = reference.referenceMs === null ? null : round2(trackerB.launchedAt - reference.referenceMs);
    rec.stagger.referenceReached = reference.reached;
    rec.stagger.aStatusAtBLaunch = trackerA.status; // 'pending' = A was still extracting/starting when B was launched
    rec.stagger.aMainSeenAtBLaunch = trackerA.mainSeenAt !== null;
    ctx.step('B launched', { nominalMs: spec.nominalMs, from: spec.from, achievedMs: rec.stagger.achievedMs, achievedFromAWrapperSpawnMs: rec.stagger.achievedFromAWrapperSpawnMs });
    await pumpTrackers(ctx, [trackerA, trackerB]);
    for (const tracker of [trackerA, trackerB]) if (tracker.status === 'ready') tracker.instance.profile = await awaitProfile(ctx, tracker);
    rec.launchers = { A: launcherFacts(trackerA), B: launcherFacts(trackerB) };
    rec.A = trackerA.instance;
    rec.B = trackerB.instance;
    if (trackerA.status !== 'ready' || trackerB.status !== 'ready') {
      ctx.step(`${rec.name}: an instance never became ready`, { A: trackerA.status, B: trackerB.status });
      return;
    }
    const { A, B } = rec;
    rec.runDirShared = sameDirectory(A, B);
    rec.bothRunning = { A: await observe(ctx, A, handleA, 'both running'), B: await observe(ctx, B, handleB, 'both running') };
    ctx.step('A/B comparison', { runDirShared: rec.runDirShared, A: fmtStats(rec.bothRunning.A.runDir), B: fmtStats(rec.bothRunning.B.runDir), manifestA: shortDigest(rec.bothRunning.A.manifest.digest), manifestB: shortDigest(rec.bothRunning.B.manifest.digest) });
    // Payload parity of the RUNNING runtimes (A and B together), before anything is closed.
    if (parityTarget) rec.payloadParity = { A: await verifyPayloadParity(ctx, 'A', A), B: await verifyPayloadParity(ctx, 'B', B) };
    const instances = { A: { instance: A, handle: handleA }, B: { instance: B, handle: handleB } };
    const closer = instances[first];
    const survivor = instances[second];
    const firstClose = await closeAndWait(ctx, first, closer.instance, closer.handle, { skipRuntimeDir: rec.runDirShared });
    rec[`${first.toLowerCase()}Close`] = firstClose;
    if (!firstClose.exited) return;
    const afterFirst = await observe(ctx, survivor.instance, survivor.handle, `${second} after ${first} exit`);
    rec[`after${first}Exit`] = afterFirst;
    ctx.step(`${second} after ${first} exit`, { mainAlive: afterFirst.proc.mainAlive, responding: afterFirst.proc.responding, files: afterFirst.runDir.files, bytes: afterFirst.runDir.bytes, manifest: shortDigest(afterFirst.manifest.digest) });
    await platform.sleep(tuning.settleMs);
    rec.settleMs = tuning.settleMs;
    rec[`after${first}ExitSettled`] = await observe(ctx, survivor.instance, survivor.handle, `${second} after settle`);
    if (injectGpu) rec.gpuRestart = await gpuRestartStep(ctx, B, handleB);
    rec[`${second.toLowerCase()}Close`] = await closeAndWait(ctx, second, survivor.instance, survivor.handle, { skipRuntimeDir: rec.runDirShared });
  });
}

/** INJECTED restart of one gpu-process child of B's own main process; Electron must respawn it and B must stay unharmed. */
async function gpuRestartStep(ctx, B, handleB) {
  const { platform, tuning } = ctx;
  const step = {
    injected: true,
    note: 'INJECTED restart: this check terminates one --type=gpu-process child of B\'s own main process to see whether Electron respawns it. It is an injection, not a claim about normal incidence.',
    mainPid: B.mainPid, targetPid: null, performed: false, reason: null, pidsBefore: [], pidsAfter: [], newPids: [], respawned: false,
    waitedForGpuMs: 0, waitedForRespawnMs: 0, settleMs: null, after: null, afterSettled: null, skipped: null,
  };
  const started = platform.now();
  let gpu = [];
  for (;;) {
    ctx.checkBudget('gpu discovery');
    const proc = inspectInstance(await ctx.snapshot('gpu discovery'), B);
    if (!proc.mainAlive) { step.skipped = 'B\'s main process is not running'; return step; }
    gpu = proc.gpuPids;
    if (gpu.length || platform.now() - started >= tuning.gpuWaitMs) break;
    await platform.sleep(500);
  }
  step.waitedForGpuMs = round2(platform.now() - started);
  step.pidsBefore = gpu.slice();
  if (!gpu.length) return step;
  step.targetPid = gpu[0];
  let result;
  try { result = await platform.terminateChildProcess(step.targetPid, { rootPid: B.mainPid, type: 'gpu-process' }); } catch (error) {
    throw new InfraError(`could not terminate the gpu-process ${step.targetPid}: ${error.message}`, 'gpu restart');
  }
  step.performed = !!result.killed;
  step.reason = result.reason ?? null;
  ctx.step('INJECTED GPU restart', { mainPid: B.mainPid, targetPid: step.targetPid, performed: step.performed, reason: step.reason, pidsBefore: step.pidsBefore });
  if (!step.performed) return step;
  const killedAt = platform.now();
  for (;;) {
    ctx.checkBudget('gpu respawn');
    const proc = inspectInstance(await ctx.snapshot('gpu respawn'), B);
    step.pidsAfter = proc.gpuPids;
    step.newPids = proc.gpuPids.filter((pid) => !step.pidsBefore.includes(pid));
    if (step.newPids.length || !proc.mainAlive || platform.now() - killedAt >= tuning.gpuRespawnWaitMs) break;
    await platform.sleep(tuning.pollMs);
  }
  step.waitedForRespawnMs = round2(platform.now() - killedAt);
  step.respawned = step.newPids.length > 0;
  step.after = await observe(ctx, B, handleB, 'B after GPU restart');
  await platform.sleep(tuning.settleMs);
  step.settleMs = tuning.settleMs;
  step.afterSettled = await observe(ctx, B, handleB, 'B after GPU restart settle');
  step.pidsAfter = step.afterSettled.proc.gpuPids;
  ctx.step('GPU restart outcome', { respawned: step.respawned, newPids: step.newPids, mainAlive: step.after.proc.mainAlive, responding: step.after.proc.responding });
  return step;
}

// ---- scenario 2: second-instance forwarding -------------------------------------------------------------

/** One look into C's config store: is the synthetic board among its recent boards? I/O problems are reported, never thrown. */
async function readRecentBoards(ctx, configFile, boardFile) {
  let read;
  try { read = await ctx.platform.readJsonFile(configFile); } catch (error) { read = { status: 'error', message: error.message }; }
  if (!read || read.status !== 'ok') {
    const status = read && read.status === 'missing' ? 'missing' : 'error';
    return { status, message: status === 'error' ? (read && read.message) || 'unreadable' : null, recorded: false, recentCount: null, matchedPath: null, recentNames: [], reason: status === 'missing' ? `${CONFIG_FILE_NAME} does not exist` : `${CONFIG_FILE_NAME} could not be read` };
  }
  const found = await findForwardedBoard(read.value, boardFile, (target) => ctx.platform.canonicalize(target));
  return { status: 'ok', message: null, recorded: found.found, recentCount: found.recentCount, matchedPath: found.matchedPath, recentNames: found.recentNames, reason: found.reason };
}

/** One line for the summary. Pure. */
function formatForwarded(forwarded) {
  if (!forwarded) return 'not checked';
  if (forwarded.recorded) return `C's ${CONFIG_FILE_NAME} lists the synthetic board (${path.win32.basename(forwarded.matchedPath || '')}, ${forwarded.recentCount} recent board(s)); it was ${forwarded.preDRecorded === false ? 'not yet recorded before D started' : `NOT confirmed absent before D started (${forwarded.preDStatus})`}`;
  return `NOT recorded: ${forwardedDetail(forwarded)}`;
}

async function secondInstanceScenario(ctx) {
  const { platform, tuning, evidence } = ctx;
  const s2 = evidence.scenario2 = {};
  await withScenario(ctx, 'second-instance', async () => {
    // The synthetic board exists in the temp area BEFORE any instance starts; C is launched WITHOUT a board argument, so C itself
    // cannot record it. Only D (same profile + the board) can deliver it.
    const boardFile = path.join(ctx.area, 'synthetic-board.cad');
    await platform.writeFile(boardFile, SYNTHETIC_BOARD);
    s2.board = { name: path.basename(boardFile), bytes: Buffer.byteLength(SYNTHETIC_BOARD), sha256: crypto.createHash('sha256').update(SYNTHETIC_BOARD, 'utf8').digest('hex') };
    const profile = path.join(ctx.area, 'profileC');
    const configFile = path.join(profile, CONFIG_FILE_NAME);
    const handleC = await launchWrapper(ctx, 'C', [`--user-data-dir=${profile}`]);
    const C = s2.C = await bringUpOrThrow(ctx, 'C', handleC, profile);
    const preD = await readRecentBoards(ctx, configFile, boardFile);
    s2.preD = { status: preD.status, recorded: preD.recorded, recentCount: preD.recentCount };
    ctx.step('C: config store before D', { ...s2.preD });
    const nsLeaf = (dir) => path.win32.basename(path.win32.dirname(dir));
    s2.nsBefore = (await platform.listNsRuntimeDirs()).map(nsLeaf);

    const handleD = await launchWrapper(ctx, 'D', [`--user-data-dir=${profile}`, boardFile]);
    const D = s2.D = { wrapperPid: handleD.pid, mainPid: null, runDir: null, runDirCanonical: null, sharesRunDirWithC: null };
    const started = platform.now();
    for (;;) {
      ctx.checkBudget('D second-instance exit');
      let records = null;
      try { records = await platform.snapshot(); } catch (error) { D.lastSnapshotError = error.message; }
      if (records && !D.runDir) {
        const main = findMainProcess(records, handleD.pid);
        if (main && main.exe) {
          D.mainPid = main.pid;
          D.runDir = path.win32.dirname(main.exe);
          D.runDirCanonical = await platform.canonicalize(D.runDir);
          D.runDirKind = classifyRuntimeDir(D.runDir).kind;
          registerMain(ctx, main);
          D.sharesRunDirWithC = sameDirectory(C, D);
          ctx.step('D: main process observed', { mainPid: D.mainPid, runDir: D.runDir, sharesRunDirWithC: D.sharesRunDirWithC });
        }
      }
      const state = handleD.state();
      D.waitedMs = round2(platform.now() - started);
      if (state.exited) { Object.assign(D, { exitedByItself: true, exitCode: state.exitCode, signal: state.signal || null }); break; }
      if (D.waitedMs >= ctx.timeoutMs) { Object.assign(D, { exitedByItself: false, exitCode: null, signal: null }); break; }
      await platform.sleep(tuning.dPollMs);
    }
    ctx.step('D: finished', { exitedByItself: D.exitedByItself, exitCode: D.exitCode, observedRunDir: D.runDir });
    if (!D.exitedByItself) return;

    s2.afterDExit = await observe(ctx, C, handleC, 'C after D exit');
    // D's own extraction must be gone: the observed directory (if any) and every new extraction directory.
    const targets = D.runDir && !D.sharesRunDirWithC ? [D.runDir] : [];
    const nsParentOfD = D.runDir ? classifyRuntimeDir(D.runDir).nsisParent : null;
    if (nsParentOfD && !D.sharesRunDirWithC) targets.push(nsParentOfD);
    const removal = await waitForRemoval(ctx, targets);
    const cLeaf = C.nsisParent ? path.win32.basename(C.nsisParent) : null;
    const leftoverNs = async () => (await platform.listNsRuntimeDirs()).map(nsLeaf).filter((leaf) => !s2.nsBefore.includes(leaf) && leaf !== cLeaf);
    let leftover = await leftoverNs();
    const waitStart = platform.now();
    while (leftover.length && platform.now() - waitStart < tuning.cleanupWaitMs) { await platform.sleep(500); leftover = await leftoverNs(); }
    s2.dCleanup = {
      runDirObserved: !!D.runDir,
      runDirRemoved: D.runDir && !D.sharesRunDirWithC ? removal.removed : null,
      remaining: removal.remaining,
      leftoverNsDirs: leftover,
    };
    await platform.sleep(tuning.settleMs);
    s2.settleMs = tuning.settleMs;
    s2.afterDExitSettled = await observe(ctx, C, handleC, 'C after settle');
    // C needs a moment to parse the forwarded board and record it; give it a bounded time BEFORE C is closed (once C is quitting its
    // store rejects new writes). This only avoids a premature close: the verdict rests on the read AFTER C closed normally.
    const recordWaitStart = platform.now();
    let beforeClose = await readRecentBoards(ctx, configFile, boardFile);
    while (!beforeClose.recorded && platform.now() - recordWaitStart < tuning.forwardWaitMs) { await platform.sleep(500); beforeClose = await readRecentBoards(ctx, configFile, boardFile); }
    const waitedForRecordMs = round2(platform.now() - recordWaitStart);
    s2.cClose = await closeAndWait(ctx, 'C', C, handleC, { skipRuntimeDir: D.sharesRunDirWithC === true });
    let final = await readRecentBoards(ctx, configFile, boardFile);
    for (let reread = 0; final.status === 'error' && reread < 2; reread++) { await platform.sleep(500); final = await readRecentBoards(ctx, configFile, boardFile); } // an unreadable file is re-read, a clean answer never is
    s2.forwardedBoard = {
      boardFile, configFile, status: final.status, message: final.message, recorded: final.recorded, matchedPath: final.matchedPath, recentCount: final.recentCount, reason: final.reason,
      preDStatus: preD.status, preDRecorded: preD.status === 'error' ? null : preD.recorded, recordedBeforeClose: beforeClose.recorded, waitedForRecordMs, readAfterCloseOfExitedC: !!(s2.cClose && s2.cClose.exited),
    };
    s2.forwardedBoard.text = formatForwarded(s2.forwardedBoard);
    s2.forwardedBoardRecorded = final.recorded;
    ctx.step('forwarded board', { recorded: final.recorded, status: final.status, recentCount: final.recentCount, waitedForRecordMs, preDRecorded: s2.forwardedBoard.preDRecorded });
  });
}

/** Scenario cleanup: kills only trees this script started (and verified orphaned mains), removes only its own dirs. */
async function cleanup(ctx) {
  const { platform } = ctx;
  const result = { killedPids: [], removed: [], errors: [] };
  for (const spawned of ctx.spawned) {
    if (spawned.handle.state().exited) continue;
    try { await platform.killTree(spawned.pid); result.killedPids.push(spawned.pid); } catch (error) { result.errors.push(`kill ${spawned.pid}: ${error.message}`); }
  }
  let records = [];
  try { records = await platform.snapshot(); } catch (error) { result.errors.push(`snapshot: ${error.message}`); }
  for (const main of ctx.mains) { // an orphaned main of ours (same pid AND same executable path)
    const live = records.find((record) => record.pid === main.pid && isMainName(record.name) && record.exe && samePath(record.exe, main.exe));
    if (!live) continue;
    try { await platform.killTree(main.pid); result.killedPids.push(main.pid); } catch (error) { result.errors.push(`kill ${main.pid}: ${error.message}`); }
  }
  if (result.killedPids.length) await platform.sleep(1500);
  let verified = true; // can we prove that nothing still runs from our extraction directories?
  try { records = await platform.snapshot(); } catch (error) { records = []; verified = false; result.errors.push(`snapshot: ${error.message}`); }
  // Leftovers of OUR extractions (this scenario's and earlier scenarios'), unless something still runs from them
  // (or that cannot be verified).
  for (const { runDir, nsisParent } of verified ? ctx.knownRuntimeDirs : []) {
    const target = nsisParent || runDir;
    if (records.some((record) => record.exe && isInside(record.exe, target))) continue;
    try { if (await platform.removeTree(target)) result.removed.push(target); } catch (error) { result.errors.push(`remove ${target}: ${error.message}`); }
  }
  if (ctx.area) {
    try { await platform.removeTempArea(ctx.area); result.removed.push(ctx.area); } catch (error) { result.errors.push(`remove temp area: ${error.message}`); }
  }
  return result;
}

function normalizeOptions(options) {
  if (!options || typeof options.exe !== 'string' || !options.exe) throw new UsageError('--exe <portable.exe> is required.');
  const expect = options.expect === undefined ? 'isolated' : options.expect;
  if (expect !== 'isolated' && expect !== 'shared') throw new UsageError(`--expect must be "isolated" or "shared", got "${expect}".`);
  const timeoutSec = options.timeoutSec === undefined ? DEFAULT_TIMEOUT_SEC : options.timeoutSec;
  if (typeof timeoutSec !== 'number' || !Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new UsageError('timeoutSec must be a positive number.');
  const maxTotalSec = options.maxTotalSec === undefined ? DEFAULT_MAX_TOTAL_SEC : options.maxTotalSec;
  if (typeof maxTotalSec !== 'number' || !Number.isFinite(maxTotalSec) || maxTotalSec <= 0) throw new UsageError('maxTotalSec must be a positive number.');
  const staggers = options.staggers === undefined ? DEFAULT_STAGGERS.map((spec) => ({ ...spec })) : options.staggers;
  if (!Array.isArray(staggers) || !staggers.length || staggers.some((spec) => !spec || !Number.isInteger(spec.nominalMs) || spec.nominalMs < 0 || !['wrapper-spawn', 'main-seen'].includes(spec.from))) throw new UsageError('staggers must be a non-empty list of {nominalMs, from}.');
  const repeat = options.repeat === undefined ? DEFAULT_REPEAT : options.repeat;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) throw new UsageError(`repeat must be a whole number between 1 and ${MAX_REPEAT}.`);
  const manifestFile = options.payloadManifest === undefined || options.payloadManifest === null ? null : options.payloadManifest;
  if (manifestFile !== null && (typeof manifestFile !== 'string' || !manifestFile)) throw new UsageError('payloadManifest must be a file name.');
  if (manifestFile !== null && expect === 'shared') throw new UsageError('--payload-manifest cannot be combined with --expect shared: the control EXE is a different build than the manifest describes.');
  return { exe: options.exe, expect, out: options.out || DEFAULT_OUT, timeoutSec, maxTotalSec, staggers, repeat, payloadManifest: manifestFile, tuning: options.tuning };
}

/** Preservation summary of one survivor: did its per-file manifest stay identical in every observation? Pure. */
function preservationOf(instance, samples) {
  const base = instance && instance.baselineManifest;
  if (!base) return null;
  const digests = samples.map(([, snapshot]) => (snapshot && snapshot.manifest ? snapshot.manifest.digest : null));
  const equal = digests.every((digest) => digest !== null) ? digests.every((digest) => digest === base.digest) : null;
  const changed = samples.find(([, snapshot]) => snapshot && snapshot.manifest && snapshot.manifest.digest !== base.digest);
  const text = equal === true
    ? `per-file manifest identical (${base.fileCount} files, ${shortDigest(base.digest)}) ${samples.map(([when]) => when).join(' / ')}`
    : equal === false
      ? `per-file manifest CHANGED ${changed[0]}: ${shortDigest(base.digest)} -> ${shortDigest(changed[1].manifest.digest)}${describeDiff(changed[1].manifest.diff)}`
      : 'per-file manifest not observed in every step';
  return { fileCount: base.fileCount, baselineDigest: base.digest, observations: samples.map(([when], index) => ({ when, digest: digests[index] })), equal, text };
}

function summarizeConcurrencyPreservation(rec) {
  const order = closeOrderOf(rec);
  const summary = preservationOf(rec[order.second], [
    ['while both ran', rec.bothRunning && rec.bothRunning[order.second]],
    [`after ${order.first} exited`, order.afterFirst],
    ['after settling', order.afterFirstSettled],
  ]);
  return summary ? { survivor: order.second, closedFirst: order.first, ...summary } : null;
}

/** The evidence's payload parity overview (baseline + A and B of the designated attempt), assembled from the recorded facts. */
function summarizePayloadParity(evidence, payload) {
  if (!payload) return null;
  const subjects = [];
  const baselineParity = evidence.baseline && evidence.baseline.payloadParity;
  const target = (evidence.concurrency || []).find((rec) => rec.parityTarget === true);
  const entries = [['baseline', baselineParity], ['A', target && target.payloadParity && target.payloadParity.A], ['B', target && target.payloadParity && target.payloadParity.B]];
  for (const [subject, parity] of entries) {
    subjects.push({
      subject: subject === 'baseline' ? 'baseline' : `${target ? target.name : 'concurrency'} ${subject}`, runDir: parity ? parity.runDir : null, equal: parity ? parity.equal === true : false,
      exeSha256: parity && parity.actual ? parity.actual.exeSha256 : null, asarSha256: parity && parity.actual ? parity.actual.asarSha256 : null,
      manifestDigest: parity && parity.actual ? parity.actual.manifestDigest : null, text: formatParity(parity),
    });
  }
  return {
    requested: true, manifestFile: payload.file, manifestDigest: payload.manifestDigest, fileCount: payload.fileCount, totalBytes: payload.totalBytes, exeSha256: payload.exeSha256, asarSha256: payload.asarSha256,
    subjects, passed: subjects.length === 3 && subjects.every((subject) => subject.equal),
  };
}

/**
 * Runs the whole check against `platform` and returns {exitCode, verdict, failures, observations, detection,
 * evidence}. Never throws for check outcomes: infrastructure problems (including a failing baseline) become
 * verdict 'infrastructure-failure' (exit code 2), failed assertions become verdict 'fail' (exit code 1).
 */
async function run(rawOptions, platform) {
  const options = normalizeOptions(rawOptions);
  const evidence = {
    schema: SCHEMA,
    tool: { name: TOOL_NAME, startedAt: platform.nowIso(), finishedAt: null, ...platform.info() },
    options: { expect: options.expect, timeoutSec: options.timeoutSec, maxTotalSec: options.maxTotalSec, staggers: options.staggers, repeat: options.repeat, payloadManifest: options.payloadManifest },
    repeat: options.repeat,
    localReference: LOCAL_REFERENCE,
    exe: null, payload: null, payloadParity: null, forwardedBoardRecorded: null, tempAreas: [], baseline: null, concurrency: [], scenario2: null,
    forcedKill: false, cleanupKilled: false, cleanupKilledPids: [], cleanup: [], detection: null, failures: [], observations: [],
    verdict: null, exitCode: null, infrastructureError: null, timeline: [],
  };
  const ctx = createContext(options, platform, evidence);
  let infra = null;
  try {
    const exe = path.resolve(options.exe);
    let info;
    try { info = await platform.fileInfo(exe); } catch (error) { throw new InfraError(`cannot read the portable EXE ${exe}: ${error.message}`, 'read exe'); }
    ctx.exe = exe;
    evidence.exe = { path: exe, sizeBytes: info.sizeBytes, sha256: info.sha256 };
    ctx.step('exe', { path: exe, sizeBytes: info.sizeBytes, sha256: info.sha256 });
    if (options.payloadManifest) {
      ctx.payload = await loadPayloadManifest(ctx, options.payloadManifest);
      evidence.payload = ctx.payload.summary;
      ctx.step('payload manifest', { file: options.payloadManifest, files: ctx.payload.summary.fileCount, bytes: ctx.payload.summary.totalBytes, digest: shortDigest(ctx.payload.summary.manifestDigest) });
    }

    await baselineScenario(ctx);
    // Every stagger runs `repeat` times. Attempt 1 closes A first (B survives), attempt 2 closes B first (A survives), and so on.
    // The injected GPU restart and the payload parity run once: largest stagger, first attempt.
    const gpuNominal = Math.max(...options.staggers.map((spec) => spec.nominalMs));
    for (const spec of options.staggers) {
      for (let attempt = 1; attempt <= options.repeat; attempt++) {
        const primary = spec.nominalMs === gpuNominal && attempt === 1;
        await concurrencyScenario(ctx, spec, { attempt, repeat: options.repeat, closeOrder: closeOrderForAttempt(attempt), injectGpu: primary, parityTarget: primary && !!ctx.payload });
      }
    }
    try { await secondInstanceScenario(ctx); } catch (error) {
      // Control mode asks only whether the defect is detectable; the concurrency scenarios may already have proven it.
      const proven = analyze({ expect: 'shared', baseline: evidence.baseline, concurrency: evidence.concurrency }).detection.any;
      if (!(error instanceof InfraError) || options.expect !== 'shared' || !proven) throw error;
      evidence.scenario2 = { ...(evidence.scenario2 || {}), infrastructureError: { message: error.message, step: error.step } };
      ctx.step('scenario 2 infrastructure problem ignored in control mode (defect already detected)', { message: error.message });
    }
  } catch (error) {
    infra = error instanceof InfraError ? error : new InfraError(`unexpected ${error && error.name || 'error'}: ${error && error.stack || error}`, 'internal');
  }
  evidence.forcedKill = ctx.forcedKill;
  evidence.cleanupKilled = ctx.cleanupKilled;
  evidence.cleanupKilledPids = ctx.cleanupKilledPids;
  evidence.tool.finishedAt = platform.nowIso();
  let verdict;
  let exitCode;
  let analysis;
  if (infra) {
    // Partial data proves nothing: report the infrastructure problem, never a verdict about the product.
    analysis = { failures: [], observations: [], detection: analyze({ expect: options.expect, baseline: evidence.baseline, concurrency: evidence.concurrency }).detection, signatures: [] };
    verdict = 'infrastructure-failure';
    exitCode = EXIT.INFRA;
    evidence.infrastructureError = { message: infra.message, step: infra.step };
  } else {
    analysis = analyze({ expect: options.expect, baseline: evidence.baseline, concurrency: evidence.concurrency, scenario2: evidence.scenario2, forcedKill: evidence.forcedKill, payload: evidence.payload });
    verdict = analysis.verdict;
    exitCode = verdict === 'pass' ? EXIT.PASS : EXIT.FAIL;
  }
  for (const entry of analysis.signatures) {
    const rec = evidence.concurrency.find((candidate) => candidate.name === entry.name);
    if (rec) rec.observed = { signature: entry.signature, family: entry.family, indicators: entry.indicators, expectedSignature: entry.expectedSignature, matchesReference: entry.matchesReference };
  }
  for (const rec of evidence.concurrency) rec.preservation = summarizeConcurrencyPreservation(rec);
  const s2 = evidence.scenario2;
  const s2Preservation = s2 && s2.C ? preservationOf(s2.C, [['after D exited', s2.afterDExit], ['after settling', s2.afterDExitSettled]]) : null;
  if (s2Preservation) s2.preservation = { survivor: 'C', ...s2Preservation };
  evidence.forwardedBoardRecorded = s2 && s2.forwardedBoard ? s2.forwardedBoard.recorded : null;
  evidence.payloadParity = summarizePayloadParity(evidence, evidence.payload);
  evidence.detection = analysis.detection;
  evidence.observations = analysis.observations;
  evidence.failures = analysis.failures;
  evidence.verdict = verdict;
  evidence.exitCode = exitCode;
  return { exitCode, verdict, failures: evidence.failures, observations: analysis.observations, detection: analysis.detection, evidence };
}

// ---------------------------------------------------------------------------------------------------------
// Real platform (Windows)
// ---------------------------------------------------------------------------------------------------------

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const encodePowerShell = (script) => Buffer.from(script, 'utf16le').toString('base64');

/** Process snapshot: every TRACE Boardviewer.exe process, no command lines (only the Chromium --type). */
function buildSnapshotScript() {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }',
    `$mainName = ${psQuote(MAIN_EXE_NAME)}`,
    // A WMI failure must never read as "no processes": exit non-zero so the node side reports an infrastructure failure.
    'try { $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }',
    "if ($all.Count -eq 0) { [Console]::Error.WriteLine('empty Win32_Process'); exit 3 }",
    '$live = @{}',
    'foreach ($g in @(Get-Process)) { $live[[int]$g.Id] = $g }',
    '$rows = @()',
    'foreach ($c in $all) {',
    '  if ($c.Name -ne $mainName) { continue }',
    '  $id = [int]$c.ProcessId',
    "  $type = ''",
    "  if ($c.CommandLine -match '--type=([A-Za-z0-9_-]+)') { $type = $Matches[1] }",
    '  $handle = [int64]0',
    '  $resp = $null',
    '  $g = $live[$id]',
    '  if ($g) {',
    '    try { $handle = $g.MainWindowHandle.ToInt64() } catch { }',
    '    try { $resp = [bool]$g.Responding } catch { }',
    '  }',
    '  $rows += [pscustomobject]@{ pid = $id; ppid = [int]$c.ParentProcessId; name = [string]$c.Name; exe = $c.ExecutablePath; type = $type; windowHandle = $handle; responding = $resp }',
    '}',
    'ConvertTo-Json -InputObject @($rows) -Compress',
  ].join('\n');
}

/** Last word of the close script's output: ok | gone | other (pid reused by another program) | refused (no main window). */
function classifyCloseOutput(text) {
  const word = String(text).trim().split(/\s+/).pop();
  return ['ok', 'gone', 'other'].includes(word) ? word : 'refused';
}

function buildCloseScript(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${pid}`);
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    // Never close a window of a process that merely reused the pid.
    `if ($null -eq $p) { 'gone' } elseif ($p.ProcessName -ne ${psQuote(MAIN_EXE_NAME.replace(/\.exe$/i, ''))}) { 'other' } elseif ($p.CloseMainWindow()) { 'ok' } else { 'refused' }`,
  ].join('\n');
}

function runPowerShell(script, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`powershell.exe failed: ${error.message}${stderr ? ` | ${String(stderr).slice(0, 300)}` : ''}`));
        else resolve(stdout);
      });
  });
}

function execResult(file, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout || '', stderr: stderr || '', error });
    });
  });
}

const isGone = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR';

/** Only a definite "not found" counts as removed; EPERM/EBUSY/EACCES and friends mean something is still there. */
async function pathExists(target, fsModule = fsp) {
  try { await fsModule.stat(target); return true; } catch (error) { return !isGone(error); }
}

async function dirStatsOf(dir, fsModule = fsp) {
  // One walk implementation (scripts/payload-manifest.cjs) for the counts and for the per-file manifests, so they can never
  // disagree. A busy / permission-denied entry (a sibling is deleting its runtime, antivirus holds a file) is skipped there: the
  // resulting count drop IS the signal, and it must not abort the whole check with an infrastructure error.
  const listing = await payloadManifest.listDirectory(dir, { stat: fsModule.stat, lstat: fsModule.lstat, readdir: fsModule.readdir });
  return { exists: listing.exists, files: listing.files.length, bytes: listing.files.reduce((total, file) => total + file.size, 0) };
}

/** Reads and parses a JSON file (the app's config store, the payload manifest); problems are returned, never thrown. */
async function readJsonFileOf(file, { fsModule = fsp, maxBytes = 8 * 1024 * 1024 } = {}) {
  let text;
  try {
    const stat = await fsModule.stat(file);
    if (!stat.isFile()) return { status: 'error', message: 'not a regular file' };
    if (stat.size > maxBytes) return { status: 'error', message: `larger than ${maxBytes} B` };
    text = await fsModule.readFile(file, 'utf8');
  } catch (error) {
    if (isGone(error)) return { status: 'missing' };
    return { status: 'error', message: `${error.code || 'error'}: ${error.message}` };
  }
  try { return { status: 'ok', value: JSON.parse(text.replace(/^\uFEFF/, '')) }; } catch (error) { return { status: 'error', message: `invalid JSON: ${error.message}` }; }
}

function createNodePlatform({ tmpdir = () => os.tmpdir() } = {}) {
  const kills = [];
  const clock = () => round2(performance.now());
  const tempRoot = () => fsp.realpath(tmpdir());
  const snapshot = async () => parseProcessJson(await runPowerShell(buildSnapshotScript()));
  const exists = (target) => pathExists(target);
  const guardedRemove = async (target) => {
    let canonical;
    try { canonical = await fsp.realpath(target); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!isInside(canonical, await tempRoot(), path)) throw new Error(`refusing to remove ${target}: it is outside the temp directory`);
    await fsp.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    return true;
  };
  return {
    info: () => ({ os: process.platform, arch: process.arch, release: os.release(), node: process.version }),
    nowIso: () => new Date().toISOString(),
    now: clock,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
    async fileInfo(file) {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error('not a file');
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      return { sizeBytes: stat.size, sha256: hash.digest('hex') };
    },
    async makeTempArea() { return fsp.realpath(await fsp.mkdtemp(path.join(await tempRoot(), 'trace-portable-isolation-'))); },
    async removeTempArea(dir) { await guardedRemove(dir); },
    removeTree: guardedRemove,
    writeFile: (file, text) => fsp.writeFile(file, text, 'utf8'),
    launch(exe, args, { cwd } = {}) {
      return new Promise((resolve, reject) => {
        const state = { exited: false, exitCode: null, signal: null, exitedAtMs: null };
        const child = spawn(exe, args, { stdio: 'ignore', windowsHide: false, shell: false, cwd, detached: false });
        child.once('error', (error) => { state.exited = true; state.exitedAtMs = clock(); reject(error); });
        child.once('exit', (code, signal) => { state.exited = true; state.exitedAtMs = clock(); state.exitCode = code; state.signal = signal; });
        child.once('spawn', () => { child.unref(); resolve({ pid: child.pid, state: () => ({ ...state }) }); });
      });
    },
    snapshot,
    async closeMainWindow(pid) {
      const word = classifyCloseOutput(await runPowerShell(buildCloseScript(pid)));
      if (word === 'ok') return { method: 'CloseMainWindow', ok: true, detail: 'ok' };
      if (word === 'gone') return { method: 'CloseMainWindow', ok: false, detail: 'process not found' };
      if (word === 'other') return { method: 'CloseMainWindow', ok: false, detail: 'the pid now belongs to another process' };
      // No main window handle (window-less session): ask politely with WM_CLOSE. No /F, so this is not a kill.
      const result = await execResult('taskkill.exe', ['/PID', String(pid)]);
      return { method: 'taskkill-graceful', ok: result.code === 0, detail: `CloseMainWindow refused; taskkill exit ${result.code}` };
    },
    /** Injected GPU restart: terminates `pid` only when a fresh snapshot proves it is a `type` descendant of rootPid. */
    async terminateChildProcess(pid, { rootPid, type }) {
      const verdict = verifyTerminationTarget(await snapshot(), pid, { rootPid, type });
      if (!verdict.ok) return { killed: false, reason: verdict.reason };
      const result = await execResult('taskkill.exe', ['/PID', String(pid), '/F']);
      return { killed: result.code === 0, reason: result.code === 0 ? 'terminated' : `taskkill exit ${result.code}` };
    },
    dirStats: dirStatsOf,
    dirManifest: (dir) => payloadManifest.listDirectory(dir),
    hashTree: (dir, options) => payloadManifest.hashDirectory(dir, options),
    readJsonFile: (file) => readJsonFileOf(file),
    exists,
    async canonicalize(target) { try { return await fsp.realpath(target); } catch { return target; } },
    async listNsRuntimeDirs() {
      const root = tmpdir();
      const found = [];
      for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !NSIS_PARENT_RE.test(entry.name)) continue;
        const app = path.join(root, entry.name, 'app');
        if (await exists(app)) found.push(app);
      }
      return found;
    },
    async killTree(pid) {
      kills.push({ pid, atMs: clock() });
      await execResult('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
    },
    killLog: () => kills.slice(),
  };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log || ((line) => console.log(line));
  const error = deps.error || ((line) => console.error(line));
  let options;
  try { options = parseArgs(argv); } catch (problem) {
    error(`${problem.message}\n${USAGE}`);
    return EXIT.INFRA;
  }
  if (options.help) { log(USAGE); return EXIT.PASS; }
  if (!deps.platform && process.platform !== 'win32') {
    error('This check drives the real Windows portable wrapper and only runs on Windows.');
    return EXIT.INFRA;
  }
  const platform = deps.platform || createNodePlatform();
  const result = await run(options, platform);
  const writeEvidence = deps.writeEvidence || (async (target, text) => {
    await fsp.mkdir(path.dirname(path.resolve(target)), { recursive: true });
    await fsp.writeFile(target, text, 'utf8');
  });
  let exitCode = result.exitCode;
  try { await writeEvidence(options.out, `${JSON.stringify(result.evidence, null, 2)}\n`); } catch (problem) {
    error(`Could not write the evidence file ${options.out}: ${problem.message}`);
    if (exitCode === EXIT.PASS) exitCode = EXIT.INFRA;
  }
  log(formatSummary(result));
  log(`evidence: ${path.resolve(options.out)}`);
  return exitCode;
}

module.exports = {
  EXIT, SCHEMA, DEFAULT_TUNING, DEFAULT_STAGGERS, DEFAULT_REPEAT, MAX_REPEAT, CONFIG_FILE_NAME, LOCAL_REFERENCE, DEFECT_SIGNATURES, NSIS_PARENT_RE, MAIN_EXE_NAME, SYNTHETIC_BOARD, USAGE,
  UsageError, InfraError, ProcessJsonError,
  isInside, samePath, classifyRuntimeDir, parseProcessJson, findMainProcess, descendantsOf, isReady, inspectInstance,
  statsEqual, verifyTerminationTarget, baselineProblems, observedSignature, analyze, parseArgs, parseStaggers, formatSummary,
  buildSnapshotScript, buildCloseScript, classifyCloseOutput, encodePowerShell, dirStatsOf, pathExists, readJsonFileOf,
  closeOrderOf, closeOrderForAttempt, concName, concPrefix, describeDiff, findForwardedBoard, evaluatePayloadParity, formatParity, formatForwarded,
  preservationOf, summarizePayloadParity,
  run, main, createNodePlatform,
};

if (require.main === module) {
  main().then((code) => { process.exit(code); }, (problem) => { console.error(problem); process.exit(EXIT.INFRA); });
}
