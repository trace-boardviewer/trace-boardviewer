#!/usr/bin/env node
'use strict';

// Per-file manifest of an unpacked app directory (electron-builder's release/win-unpacked) and the pure building
// blocks the Windows portable isolation check (scripts/check-portable-isolation.cjs) uses to prove that the files
// the portable wrapper EXTRACTS and RUNS are byte-identical to the files the build produced.
//
// Usage:  node scripts/payload-manifest.cjs --dir <directory> --out <manifest.json>
//
// Output (deterministic; no timestamps and no absolute paths, so the same tree always gives the same file):
//   { schema: 'trace-payload-manifest/1', fileCount, totalBytes,
//     files: [{ path, size, sha256 }],            relative POSIX paths, sorted by plain code-unit order
//     manifestDigest,                              SHA-256 over the canonical (path, size, sha256) lines, see digestFileList
//     exeSha256, asarSha256 }                      the root file "TRACE Boardviewer.exe" / "resources/app.asar", else null
//
// Exit codes: 0 manifest written; 1 the directory is missing/empty or a file could not be read (nothing is written);
// 2 usage error. A manifest that silently skipped an unreadable file would prove nothing, so any unreadable entry
// fails the run.
//
// Files are hashed as a stream (no whole-file buffers: the main executable is ~245 MB). No dependencies beyond Node.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA = 'trace-payload-manifest/1';
const LISTING_DOMAIN = 'trace-dir-listing/1'; // size-only listings (no content hashes), e.g. the per-instance preservation manifests
const MAIN_EXE_PATH = 'TRACE Boardviewer.exe';
const APP_ASAR_PATH = 'resources/app.asar';
const DIFF_LIMIT = 10;
const SHA256_RE = /^[0-9a-f]{64}$/;
const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2 });
const USAGE = 'Usage: node scripts/payload-manifest.cjs --dir <directory> --out <manifest.json>';

class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}
class ManifestError extends Error {
  constructor(message) { super(message); this.name = 'ManifestError'; }
}

const defaultApi = Object.freeze({ stat: fsp.stat, lstat: fsp.lstat, readdir: fsp.readdir, createReadStream: fs.createReadStream });

const isGone = (error) => !!error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
// A busy / permission-denied entry (a sibling is deleting its runtime, antivirus holds a file) is reported, never fatal.
const isBusy = (error) => !!error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY');

// ---------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------

const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortByPath = (files) => files.slice().sort((a, b) => compareCodeUnits(a.path, b.path));
const sumBytes = (files) => files.reduce((total, file) => total + file.size, 0);

/** SHA-256 over a domain line and one JSON line per item, so no path (even one with a newline) can blur two fields. */
function digestLines(domain, lines) {
  const hash = crypto.createHash('sha256');
  hash.update(`${domain}\n`);
  for (const line of lines) hash.update(`${JSON.stringify(line)}\n`);
  return hash.digest('hex');
}

/**
 * Canonical digest of a file list, independent of the order the list was built in.
 * withHash=true  (payload manifest): lines [path, size, sha256]
 * withHash=false (size-only listing): lines [path, size], a different domain, so the two digests can never be confused
 */
function digestFileList(files, { withHash = true } = {}) {
  const sorted = sortByPath(files);
  return withHash
    ? digestLines(SCHEMA, sorted.map((file) => [file.path, file.size, file.sha256]))
    : digestLines(LISTING_DOMAIN, sorted.map((file) => [file.path, file.size]));
}

/** Count, bytes and digest of a size-only listing (the "preservation manifest" of a runtime directory). */
function summarizeListing(files) {
  return { fileCount: files.length, totalBytes: sumBytes(files), digest: digestFileList(files, { withHash: false }) };
}

function hashOfPath(files, wanted) {
  const hit = files.find((file) => file.path === wanted);
  return hit ? hit.sha256 : null;
}

/** Builds the manifest object from hashed files (any order). Throws ManifestError for duplicate paths. */
function finalizeManifest(files) {
  const sorted = sortByPath(files).map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 }));
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].path === sorted[index - 1].path) throw new ManifestError(`duplicate path in the file list: ${sorted[index].path}`);
  }
  return {
    schema: SCHEMA,
    fileCount: sorted.length,
    totalBytes: sumBytes(sorted),
    files: sorted,
    manifestDigest: digestFileList(sorted, { withHash: true }),
    exeSha256: hashOfPath(sorted, MAIN_EXE_PATH),
    asarSha256: hashOfPath(sorted, APP_ASAR_PATH),
  };
}

/** Is `value` a safe relative POSIX path (no absolute, no drive, no "." / ".." segments, no empty segments, no backslash)? */
function isRelativePosixPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Everything that is wrong with a manifest object (empty list = valid and internally consistent). Never throws. */
function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['the manifest is not a JSON object'];
  if (manifest.schema !== SCHEMA) problems.push(`schema is ${JSON.stringify(manifest.schema)}, expected "${SCHEMA}"`);
  if (!Array.isArray(manifest.files)) { problems.push('files is not an array'); return problems; }
  let listOk = true;
  manifest.files.forEach((file, index) => {
    const where = `files[${index}]`;
    if (!file || typeof file !== 'object') { problems.push(`${where} is not an object`); listOk = false; return; }
    if (!isRelativePosixPath(file.path)) { problems.push(`${where}.path is not a relative POSIX path: ${JSON.stringify(file.path)}`); listOk = false; }
    if (!Number.isSafeInteger(file.size) || file.size < 0) { problems.push(`${where}.size is not a non-negative integer`); listOk = false; }
    if (typeof file.sha256 !== 'string' || !SHA256_RE.test(file.sha256)) { problems.push(`${where}.sha256 is not a lowercase hex SHA-256`); listOk = false; }
  });
  if (listOk) {
    for (let index = 1; index < manifest.files.length; index++) {
      if (compareCodeUnits(manifest.files[index - 1].path, manifest.files[index].path) >= 0) {
        problems.push(`files are not strictly sorted / unique at "${manifest.files[index].path}"`);
        break;
      }
    }
    if (manifest.fileCount !== manifest.files.length) problems.push(`fileCount ${manifest.fileCount} does not match the ${manifest.files.length} listed files`);
    if (manifest.totalBytes !== sumBytes(manifest.files)) problems.push(`totalBytes ${manifest.totalBytes} does not match the sum of the listed sizes ${sumBytes(manifest.files)}`);
    if (manifest.manifestDigest !== digestFileList(manifest.files, { withHash: true })) problems.push('manifestDigest does not match the listed files');
    if (manifest.exeSha256 !== hashOfPath(manifest.files, MAIN_EXE_PATH)) problems.push(`exeSha256 does not match the listed "${MAIN_EXE_PATH}"`);
    if (manifest.asarSha256 !== hashOfPath(manifest.files, APP_ASAR_PATH)) problems.push(`asarSha256 does not match the listed "${APP_ASAR_PATH}"`);
  } else if (typeof manifest.manifestDigest !== 'string') problems.push('manifestDigest is missing');
  return problems;
}

/**
 * Exact set comparison of two file lists ({path, size[, sha256]}). Paths are compared exactly. Counts are complete; every
 * list is sorted and cut at `limit` entries. `ignore` (a Set of paths) removes paths from both sides (files reported
 * separately, e.g. as unreadable). compareHash=false compares path + size only (size-only listings).
 */
function diffFileLists(expected, actual, { limit = DIFF_LIMIT, compareHash = true, ignore = null } = {}) {
  const wanted = new Map();
  for (const file of expected || []) wanted.set(file.path, file);
  const found = new Map();
  for (const file of actual || []) found.set(file.path, file);
  const skipped = (name) => !!ignore && ignore.has(name);
  const missing = [];
  const extra = [];
  const sizeMismatch = [];
  const hashMismatch = [];
  for (const [name, want] of wanted) {
    if (skipped(name)) continue;
    const have = found.get(name);
    if (!have) missing.push(name);
    else if (have.size !== want.size) sizeMismatch.push({ path: name, expected: want.size, actual: have.size });
    else if (compareHash && have.sha256 !== want.sha256) hashMismatch.push({ path: name, expected: want.sha256, actual: have.sha256 });
  }
  for (const name of found.keys()) if (!skipped(name) && !wanted.has(name)) extra.push(name);
  const byText = (a, b) => compareCodeUnits(a, b);
  const byPath = (a, b) => compareCodeUnits(a.path, b.path);
  missing.sort(byText); extra.sort(byText); sizeMismatch.sort(byPath); hashMismatch.sort(byPath);
  const counts = { missing: missing.length, extra: extra.length, sizeMismatch: sizeMismatch.length, hashMismatch: hashMismatch.length };
  return {
    equal: counts.missing + counts.extra + counts.sizeMismatch + counts.hashMismatch === 0,
    counts,
    missing: missing.slice(0, limit), extra: extra.slice(0, limit), sizeMismatch: sizeMismatch.slice(0, limit), hashMismatch: hashMismatch.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Directory access (injectable fs api: { stat, lstat, readdir, createReadStream })
// ---------------------------------------------------------------------------------------------------------

/**
 * Lists every non-directory entry below `dir` (hidden files included) as {path (relative POSIX), full, regular}.
 * A directory that cannot be listed right now (busy / denied) is reported in `problems`, one that vanished is ignored,
 * any other error is thrown.
 */
async function walkDirectory(dir, api = defaultApi) {
  let stat;
  try { stat = await api.stat(dir); } catch (error) {
    if (isGone(error)) return { exists: false, entries: [], problems: [] };
    if (isBusy(error)) return { exists: true, entries: [], problems: [{ path: '', code: error.code }] }; // present but unreadable right now
    throw error;
  }
  if (!stat.isDirectory()) return { exists: false, entries: [], problems: [] };
  const entries = [];
  const problems = [];
  const pending = [{ full: dir, rel: '' }];
  while (pending.length) {
    const { full: current, rel } = pending.pop();
    let children;
    try { children = await api.readdir(current, { withFileTypes: true }); } catch (error) {
      if (isGone(error)) continue; // vanished while walking
      if (isBusy(error)) { problems.push({ path: rel, code: error.code }); continue; }
      throw error;
    }
    for (const child of children) {
      const childRel = rel ? `${rel}/${child.name}` : child.name;
      const childFull = path.join(current, child.name);
      if (child.isDirectory()) pending.push({ full: childFull, rel: childRel });
      else entries.push({ path: childRel, full: childFull, regular: child.isFile() });
    }
  }
  return { exists: true, entries, problems };
}

/**
 * Size-only listing {exists, files:[{path, size}]} sorted by path. Busy / vanished entries are skipped (the resulting
 * shortfall IS the signal for the preservation check); anything unexpected is thrown. Non-regular entries are ignored.
 */
async function listDirectory(dir, api = defaultApi) {
  const walked = await walkDirectory(dir, api);
  if (!walked.exists) return { exists: false, files: [] };
  const files = [];
  for (const entry of walked.entries) {
    if (!entry.regular) continue;
    try { files.push({ path: entry.path, size: (await api.lstat(entry.full)).size }); } catch (error) { if (!isGone(error) && !isBusy(error)) throw error; }
  }
  return { exists: true, files: sortByPath(files) };
}

/** Streaming SHA-256 of one file; also returns the number of bytes streamed. */
async function hashStream(full, api = defaultApi) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of api.createReadStream(full)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}

/**
 * Hashes every regular file below `dir`. Returns {exists, files:[{path,size,sha256}], unreadable:[{path,code}]}. Nothing is
 * skipped silently: a file that cannot be read (busy, denied, changed while it was read, not a regular file) or a
 * directory that cannot be listed is reported in `unreadable`; a file that vanished is simply absent (a comparison reports
 * it as missing). `skip` (a Set of paths) leaves already hashed files out, so a retry only repeats what failed.
 */
async function hashDirectory(dir, { api = defaultApi, skip = null } = {}) {
  const walked = await walkDirectory(dir, api);
  if (!walked.exists) return { exists: false, files: [], unreadable: [] };
  const files = [];
  const unreadable = walked.problems.map((problem) => ({ path: problem.path, code: problem.code, kind: 'directory' }));
  for (const entry of walked.entries) {
    if (skip && skip.has(entry.path)) continue;
    if (!entry.regular) { unreadable.push({ path: entry.path, code: 'NOT_REGULAR', kind: 'file' }); continue; }
    try {
      const size = (await api.lstat(entry.full)).size;
      const { sha256, bytes } = await hashStream(entry.full, api);
      if (bytes !== size) { unreadable.push({ path: entry.path, code: 'CHANGED', kind: 'file' }); continue; } // grew or shrank while it was read
      files.push({ path: entry.path, size, sha256 });
    } catch (error) {
      if (isGone(error)) continue;
      unreadable.push({ path: entry.path, code: (error && error.code) || 'ERROR', kind: 'file' });
    }
  }
  return { exists: true, files: sortByPath(files), unreadable: sortByPath(unreadable) };
}

/** Manifest of `dir`; throws ManifestError when the directory is missing/empty or any entry could not be hashed. */
async function buildManifest(dir, { api = defaultApi } = {}) {
  const result = await hashDirectory(dir, { api });
  if (!result.exists) throw new ManifestError(`directory not found: ${dir}`);
  if (result.unreadable.length) {
    const shown = result.unreadable.slice(0, DIFF_LIMIT).map((item) => `${item.path || '.'} (${item.code})`).join(', ');
    throw new ManifestError(`${result.unreadable.length} entries could not be hashed, so the manifest would be incomplete: ${shown}`);
  }
  if (!result.files.length) throw new ManifestError(`directory contains no files: ${dir}`);
  return finalizeManifest(result.files);
}

// ---------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { dir: null, out: null, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const take = () => {
      if (equals > 0) return arg.slice(equals + 1);
      if (index + 1 >= argv.length) throw new UsageError(`${flag} needs a value.`);
      return argv[++index];
    };
    switch (flag) {
      case '--dir': options.dir = take(); break;
      case '--out': options.out = take(); break;
      case '--help': case '-h': options.help = true; break;
      default: throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  if (options.help) return options;
  if (!options.dir) throw new UsageError('--dir <directory> is required.');
  if (!options.out) throw new UsageError('--out <manifest.json> is required.');
  const dir = path.resolve(options.dir);
  const out = path.resolve(options.out);
  if (out === dir || out.startsWith(dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`)) {
    throw new UsageError('--out must be outside --dir (the manifest would otherwise list itself).');
  }
  return options;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log || ((line) => console.log(line));
  const error = deps.error || ((line) => console.error(line));
  let options;
  try { options = parseArgs(argv); } catch (problem) {
    error(`${problem.message}\n${USAGE}`);
    return EXIT.USAGE;
  }
  if (options.help) { log(USAGE); return EXIT.OK; }
  let manifest;
  try { manifest = await buildManifest(options.dir, { api: deps.api || defaultApi }); } catch (problem) {
    error(`Payload manifest failed: ${problem.message}`);
    return EXIT.FAIL;
  }
  const writeOut = deps.writeFile || (async (target, text) => {
    await fsp.mkdir(path.dirname(path.resolve(target)), { recursive: true });
    await fsp.writeFile(target, text, 'utf8');
  });
  try { await writeOut(options.out, `${JSON.stringify(manifest, null, 2)}\n`); } catch (problem) {
    error(`Could not write ${options.out}: ${problem.message}`);
    return EXIT.FAIL;
  }
  log(`payload manifest: ${manifest.fileCount} files, ${manifest.totalBytes} bytes, digest ${manifest.manifestDigest}`);
  log(`  ${MAIN_EXE_PATH} sha256 ${manifest.exeSha256 || 'n/a (not found)'}`);
  log(`  ${APP_ASAR_PATH} sha256 ${manifest.asarSha256 || 'n/a (not found)'}`);
  log(`  written to ${path.resolve(options.out)}`);
  return EXIT.OK;
}

module.exports = {
  SCHEMA, LISTING_DOMAIN, MAIN_EXE_PATH, APP_ASAR_PATH, DIFF_LIMIT, EXIT, USAGE, UsageError, ManifestError,
  compareCodeUnits, sortByPath, digestFileList, summarizeListing, finalizeManifest, validateManifest, isRelativePosixPath, diffFileLists,
  walkDirectory, listDirectory, hashStream, hashDirectory, buildManifest, parseArgs, main,
};

if (require.main === module) {
  main().then((code) => { process.exit(code); }, (problem) => { console.error(problem); process.exit(EXIT.FAIL); });
}
