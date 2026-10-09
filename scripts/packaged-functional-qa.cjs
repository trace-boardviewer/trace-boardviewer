'use strict';

// Bounded end-to-end checks against a packaged Electron executable and its app.asar.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { _electron } = require('playwright');
const { zipSync } = require('fflate');
const { makeImageOnlyPdf } = require('./qa-ocr.cjs');
const { reconcileBugReportNetworkEvidence, isReportRecord, isResponseRecord, isCancelOracle, isCancelledAttempt, observerCounts } = require('./packaged-functional/bug-reports.cjs');
const { launchWithPreMainObservers, waitForPortRelease, withTimeout } = require('./packaged-functional-inspector.cjs');

const ROOT = path.resolve(__dirname, '..');

function hasOnlyOwnKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const ARCHES = new Set(['x64', 'arm64']);
const LANGUAGES = ['hu', 'en', 'de', 'fr', 'it', 'sk', 'pl', 'uk'];
const STRIPE_BASE = 'https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00';
const REQUIRED_MODULES = Object.freeze(['imports', 'viewers', 'workspaces', 'support-updates', 'bug-reports']);
const REQUIRED_SCREENSHOTS = Object.freeze(['board-loaded.png', 'ocr-recognized.png']);
const REQUIRED_CORE_STEPS = Object.freeze([
  'packaged runtime identity, app.asar and isolated user profile',
  'production file URL, renderer isolation and exact board counts',
  'packaged support recovery, all localized unavailable states and safe Stripe IPC',
  'ordinary single-board ZIP opens',
  'unsafe and multi-board ZIPs are refused while the loaded board stays usable',
  'declared ASC outline, pins and nails companions open through either member',
  'attachments and bundled image-only PDF OCR work',
  'typed pin note, measurement, attachments and settings survive normal quit and restart',
  'only the deliberate verification request was blocked before network access',
  'packaged app closes with exit code zero after functional checks',
  'no uncaught renderer errors or CSP violations',
]);
const SCENARIO_MANIFEST = Object.freeze({ schema: 'trace-packaged-functional-scenarios/1', modules: REQUIRED_MODULES, coreSteps: REQUIRED_CORE_STEPS });
const CHECKS = [], FAILURES = [], NETWORK = [], PAGE_ERRORS = [], CONSOLE_ERRORS = [], CSP_ERRORS = [];
let reportPrivacyActive = false;
let app = null, page = null, evidence = null, launchNumber = 0;
const OBSERVED_PAGES = new WeakSet();
let failureScreenshot = null;

function cleanupErrorClass(stage, error) {
  const timeout = error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT';
  return `${stage} ${timeout ? 'timed out' : 'failed'}; details withheld`;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function safeObserverMarker(value) {
  const topKeys = ['pid', 'networkCount', 'allExternalRequestsCancelled', 'errors', 'externalIntents', 'sessions', 'ready', 'reportObserver'];
  if (!exactKeys(value, topKeys) || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !Number.isSafeInteger(value.networkCount) || value.networkCount < 0 || value.networkCount > 10000
    || typeof value.allExternalRequestsCancelled !== 'boolean' || !Number.isSafeInteger(value.errors) || value.errors < 0
    || !Number.isSafeInteger(value.externalIntents) || value.externalIntents < 0 || !Number.isSafeInteger(value.sessions) || value.sessions < 0
    || typeof value.ready !== 'boolean') return null;
  const observer = value.reportObserver;
  const observerKeys = ['version', 'allowedCount', 'deniedCount', 'gateArms', 'gateFailures', 'responseArms', 'responseFailures', 'attempts', 'responses', 'cancelOracles'];
  if (!exactKeys(observer, observerKeys) || !Array.isArray(observer.attempts) || observer.attempts.length > 256
    || !Array.isArray(observer.responses) || observer.responses.length > 64
    || !Array.isArray(observer.cancelOracles) || observer.cancelOracles.length > 32) return null;
  const counts = observerCounts({ version: observer.version, allowedCount: observer.allowedCount, deniedCount: observer.deniedCount,
    gateArms: observer.gateArms, gateFailures: observer.gateFailures, responseArms: observer.responseArms, responseFailures: observer.responseFailures });
  if (!counts || !observer.attempts.every(isReportRecord) || !observer.responses.every(isResponseRecord)
    || !observer.cancelOracles.every(isCancelOracle)) return null;
  return { pid: value.pid, networkCount: value.networkCount, allExternalRequestsCancelled: value.allExternalRequestsCancelled,
    errors: value.errors, externalIntents: value.externalIntents, sessions: value.sessions, ready: value.ready,
    reportObserver: { ...counts, attempts: observer.attempts.map((entry) => ({ ...entry })),
      responses: observer.responses.map((entry) => ({ ...entry })), cancelOracles: observer.cancelOracles.map((entry) => ({ ...entry })) } };
}

function createObserverMarkerAccumulator(maxMarkerBytes = 65536) {
  assert.ok(Number.isSafeInteger(maxMarkerBytes) && maxMarkerBytes >= 128 && maxMarkerBytes <= 65536);
  const prefix = 'TRACE_QA_PREMAIN_FINAL ';
  let line = '';
  let discarding = false;
  return Object.freeze({
    push(chunk) {
      const markers = [];
      for (const character of String(chunk)) {
        if (character === '\n') {
          if (!discarding) {
            const complete = line.endsWith('\r') ? line.slice(0, -1) : line;
            if (complete.startsWith(prefix)) {
              try {
                const marker = safeObserverMarker(JSON.parse(complete.slice(prefix.length)));
                if (marker) markers.push(marker);
              } catch { /* malformed or incomplete private data is discarded */ }
            }
          }
          line = '';
          discarding = false;
        } else if (!discarding) {
          if (line.length >= maxMarkerBytes) { line = ''; discarding = true; }
          else line += character;
        }
      }
      return markers;
    },
  });
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index++) {
    const match = /^--([a-z][a-z-]*)=(.*)$/.exec(argv[index]);
    if (!match || !match[2]) throw new Error('Expected --name=value, received ' + (argv[index] || '(empty)'));
    if (values.has(match[1])) throw new Error('Duplicate option --' + match[1]);
    values.set(match[1], match[2]);
  }
  for (const name of ['executable', 'asar', 'artifact', 'checksum', 'version', 'os', 'arch', 'out']) {
    if (!values.has(name)) throw new Error('Required option missing: --' + name + '=...');
  }
  const options = Object.fromEntries(values);
  for (const name of ['executable', 'asar', 'artifact', 'checksum', 'out', ...(options.manifest ? ['manifest'] : [])]) {
    if (!path.isAbsolute(options[name])) throw new Error('--' + name + ' must be an absolute path');
    options[name] = path.resolve(options[name]);
  }
  if (!VERSION_RE.test(options.version)) throw new Error('--version is not a valid release version');
  if (!PLATFORMS.has(options.os)) throw new Error('--os must be win32, darwin or linux');
  if (!ARCHES.has(options.arch)) throw new Error('--arch must be x64 or arm64');
  if (options.os !== process.platform) throw new Error('Requested OS does not match this runner');
  if (options.arch !== process.arch) throw new Error('Requested architecture does not match this runner');
  return options;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fileSha = async (filename) => sha256(await fs.readFile(filename));

function asarLibrary() {
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
  return libraryRequire('@electron/asar');
}

function captureOcrAssets(archive) {
  const asar = asarLibrary();
  const entries = asar.listPackage(archive).map((original) => ({ original, normalized: original.replace(/\\/g, '/') }));
  const paths = entries.filter(({ normalized }) => /^\/dist\/assets\/(?:ocr\.worker-.+\.js|tesseract-core-(?:simd-)?lstm-.+\.wasm|eng\.traineddata-.+\.gz)$/.test(normalized));
  assert.equal(paths.length, 4, 'packaged ASAR contains OCR worker, both local WASM builds and English language data');
  const assets = paths.map(({ original, normalized }) => {
    const internalPath = normalized.slice(1);
    const bytes = asar.extractFile(archive, original.slice(1));
    return { path: internalPath, bytes: bytes.length, sha256: sha256(bytes) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(assets.filter((asset) => asset.path.endsWith('.wasm')).length, 2);
  assert.equal(assets.filter((asset) => asset.path.includes('traineddata')).length, 1);
  return assets;
}

function assertPayloadManifest(manifest, { asarSha256, executableSha256 }) {
  assert.equal(manifest && manifest.schema, 'trace-payload-manifest/1');
  assert.equal(manifest.asarSha256, asarSha256, 'app.asar matches the packaged payload manifest');
  assert.equal(manifest.exeSha256, executableSha256, 'runtime executable matches the packaged payload manifest');
  return { digest: manifest.manifestDigest, files: manifest.fileCount, bytes: manifest.totalBytes };
}

function canonicalIdentity(actual, expected, platform = process.platform, realpath = (value) => path.resolve(value)) {
  const left = realpath(actual), right = realpath(expected);
  return platform === 'win32' ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US') : left === right;
}

function appImageMode(options) { return options.os === 'linux' && /\.AppImage$/i.test(options.artifact); }

function validateEvidenceManifest(report, screenshots, expected = SCENARIO_MANIFEST) {
  const problems = [];
  if (!report || report.schema !== 'trace-packaged-functional-qa/1') problems.push('missing or invalid evidence schema');
  if (report?.status !== 'pass') problems.push(`run status is ${report?.status ?? 'missing'}`);
  if (!report?.sourceSha || report.sourceSha === 'unknown') problems.push('source identity is missing');
  if (!report?.artifact?.sha256 || !report?.artifact?.executableSha256 || !report?.artifact?.asarSha256) problems.push('artifact or runtime payload identity is missing');
  if (!report?.artifact?.payloadLinkage?.fuses?.observed || !report?.artifact?.payloadLinkage?.fuses?.configured) problems.push('artifact-linked configured and observed fuse values are missing');
  if (!report?.runtime?.isPackaged || !report?.runtime?.executableSha256 || !report?.runtime?.asarSha256) problems.push('packaged runtime identity proof is missing');
  if (report?.runtime?.executableSha256 !== report?.artifact?.executableSha256) problems.push('runtime executable is not linked to the tested artifact');
  if (report?.runtime?.asarSha256 !== report?.artifact?.asarSha256) problems.push('runtime ASAR is not linked to the tested artifact');
  if (!Array.isArray(report?.launches) || report.launches.length < 3 || report.launches.some((launch) => !Number.isSafeInteger(launch.launch) || !launch.identity?.isPackaged || launch.identity.executableSha256 !== report.artifact.executableSha256 || launch.identity.asarSha256 !== report.artifact.asarSha256 || !Array.isArray(launch.networkAttempts) || !Array.isArray(launch.pageErrors) || !Array.isArray(launch.consoleErrors) || launch.exit?.exitCode !== 0 || launch.exit?.signal !== null || launch.exit?.forced !== false || launch.startup?.marker !== 'app.asar/electron/main.cjs' || launch.startup?.line !== 3 || launch.startup?.installedBeforeReady !== true || !Number.isInteger(launch.startup?.inspectorPort) || launch.startup?.inspectorPortReleased !== true || launch.startupObservation?.installedBeforeReady !== true || launch.startupObservation?.willQuitCaptured !== true || typeof launch.startupObservation?.cancelledRequests !== 'boolean' || !Number.isSafeInteger(launch.startupObservation?.finalNetworkCount) || launch.startupObservation.finalNetworkCount !== launch.networkAttempts.length || launch.startupObservation?.finalErrors !== 0 || !Array.isArray(launch.mainErrors) || launch.mainErrors.length !== 0)) problems.push('one or more launches lack complete pre-main artifact identity, observations or a normal exit');
  if (Array.isArray(report?.launches) && new Set(report.launches.map((launch) => launch.launch)).size !== report.launches.length) problems.push('launch identifiers are not unique');
  if (report?.launches?.some((launch) => !Array.isArray(launch.pageErrors) || launch.pageErrors.length > 0
    || !Array.isArray(launch.consoleErrors) || launch.consoleErrors.length > 0
    || !Array.isArray(launch.cspErrors) || launch.cspErrors.length > 0)) problems.push('one or more launches recorded renderer page, console or CSP errors');
  for (const channel of ['pageErrors', 'consoleErrors', 'cspErrors']) {
    if (!Array.isArray(report?.[channel])) problems.push(`global ${channel} observation is missing`);
    else if (report[channel].length > 0) problems.push(`global ${channel} observation contains errors`);
  }
  if (report?.networkObservation?.scope !== 'startup-through-exit' || report.networkObservation?.preMain !== true || report.networkObservation?.complete !== true) problems.push('startup-to-exit network observation is not proven complete');
  if (report?.errorObservation?.scope !== 'startup-through-exit' || report.errorObservation?.preMain !== true || report.errorObservation?.complete !== true) problems.push('startup-to-exit error observation is not proven complete');
  if (report?.artifact?.kind === 'appimage' && report.launches?.some((launch) => !launch.identity?.appImage || !launch.startup?.wrapper?.executableInsideAppDir)) problems.push('AppImage wrapper-to-mounted-runtime identity is incomplete');
  if (report?.normalQuit !== true || !Array.isArray(report.processExits) || report.processExits.length < 3 || report.processExits.some((exit) => !Number.isSafeInteger(exit.launch) || exit.exitCode !== 0 || exit.signal !== null || exit.forced !== false)) problems.push('normal process exits are incomplete');
  if (Array.isArray(report?.processExits) && new Set(report.processExits.map((exit) => exit.launch)).size !== report.processExits.length) problems.push('process exit launch identifiers are not unique');
  if (Array.isArray(report?.launches) && Array.isArray(report?.processExits)) {
    if (report.processExits.length !== report.launches.length) problems.push('process exit count does not match launch count');
    if (report.launches.some((launch) => {
      const matches = report.processExits.filter((exit) => exit.launch === launch.launch);
      return matches.length !== 1 || !isDeepStrictEqual(matches[0], launch.exit);
    })) problems.push('one or more owned launches lack exactly one matching normal process exit');
  }
  if (!Array.isArray(report?.networkAttempts)) problems.push('global network attempts are missing');
  else if (Array.isArray(report?.launches)
    && !isDeepStrictEqual(report.networkAttempts, report.launches.flatMap((launch) => Array.isArray(launch.networkAttempts) ? launch.networkAttempts : []))) problems.push('global network attempts do not match the per-launch final snapshots');
  problems.push(...reconcileBugReportNetworkEvidence(report));
  if (Array.isArray(report?.cleanupFailures) && report.cleanupFailures.length) problems.push('one or more owned launches have cleanup failures');
  if (report?.fixtureHashesUnchanged !== true) problems.push('synthetic fixture immutability is not proven');
  const checks = report?.steps;
  if (!Array.isArray(checks) || checks.length === 0 || checks.some((check) => check.status !== 'pass')) problems.push('required checks are missing, failed or skipped');
  for (const name of expected.coreSteps) if (!checks?.some((check) => check.name === name && check.status === 'pass')) problems.push(`required core check ${name} is missing`);
  if (JSON.stringify(report?.scenarioManifest) !== JSON.stringify(expected)) problems.push('versioned required scenario manifest is missing or changed');
  if (!Array.isArray(report?.scenarioModules) || JSON.stringify(report.scenarioModules) !== JSON.stringify(expected.modules)) problems.push('required scenario module manifest does not match');
  if (!Array.isArray(report?.moduleResults) || report.moduleResults.length !== expected.modules.length) problems.push('one or more required scenario modules did not complete an assertion');
  else {
    const linkedSteps = new Set();
    for (let index = 0; index < report.moduleResults.length; index++) {
      const entry = report.moduleResults[index];
      const validRange = Number.isSafeInteger(entry.stepStart) && Number.isSafeInteger(entry.stepEnd) && Number.isSafeInteger(entry.steps)
        && entry.stepStart >= 0 && entry.stepEnd > entry.stepStart && entry.stepEnd <= (Array.isArray(checks) ? checks.length : 0)
        && entry.steps === entry.stepEnd - entry.stepStart;
      if (entry.id !== expected.modules[index] || entry.completed !== true || !validRange) {
        problems.push(`required scenario module ${expected.modules[index]} lacks a valid completed step range`);
        continue;
      }
      for (let stepIndex = entry.stepStart; stepIndex < entry.stepEnd; stepIndex++) {
        if (linkedSteps.has(stepIndex) || checks[stepIndex]?.status !== 'pass') problems.push(`required scenario module ${entry.id} is not bound to unique passing steps`);
        linkedSteps.add(stepIndex);
      }
    }
  }
  if (!Array.isArray(screenshots)) problems.push('screenshot manifest is missing');
  else {
    const names = screenshots.map((image) => image.name);
    if (new Set(names).size !== names.length) problems.push('screenshot manifest contains duplicate names');
    for (const name of REQUIRED_SCREENSHOTS) if (!names.includes(name)) problems.push(`required screenshot ${name} is missing`);
    for (const image of screenshots) {
      if (!Number.isInteger(image.bytes) || image.bytes <= 8 || !/^[a-f0-9]{64}$/.test(image.sha256 || '') || image.signature !== 'png') problems.push(`screenshot ${image.name || '(unnamed)'} is not hashed PNG evidence`);
    }
  }
  return problems;
}

async function verifyScreenshotManifest(directory, screenshots) {
  assert.ok(Array.isArray(screenshots), 'screenshot manifest exists');
  for (const entry of screenshots) {
    assert.equal(path.basename(entry.name), entry.name, 'screenshot entry has a safe file name');
    const filename = path.join(directory, entry.name);
    const bytes = await fs.readFile(filename);
    assert.equal(bytes.length, entry.bytes, `${entry.name} byte count matches its manifest`);
    assert.equal(sha256(bytes), entry.sha256, `${entry.name} SHA-256 matches its manifest`);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${entry.name} is PNG`);
  }
  for (const name of REQUIRED_SCREENSHOTS) assert.ok(screenshots.some((entry) => entry.name === name), `mandatory screenshot ${name} exists`);
  return true;
}

function strictContext(context) {
  const allowed = new Set(['options', 'evidence', 'root', 'profile', 'fixtureDir', 'getPage', 'getApp', 'step', 'registerFixture', 'openFiles', 'waitBoard', 'setLanguage', 'deliverSyntheticBoard',
    'dismissSupport', 'screenshot', 'main', 'withProfile', 'withWelcome', 'restart', 'readProfile', 'writeProfile', 'withOpenDialog', 'withSaveDialog']);
  for (const key of Object.keys(context)) assert.ok(allowed.has(key), `unexpected scenario context helper ${key}`);
  for (const key of ['getPage', 'getApp', 'step', 'registerFixture', 'openFiles', 'waitBoard', 'setLanguage', 'deliverSyntheticBoard', 'dismissSupport', 'screenshot', 'main', 'withProfile', 'withWelcome', 'restart', 'readProfile', 'writeProfile', 'withOpenDialog', 'withSaveDialog']) {
    assert.equal(typeof context[key], 'function', `required scenario context helper ${key}`);
  }
  return Object.freeze(context);
}

async function runRequiredScenarioModules(context, directory = path.join(ROOT, 'scripts', 'packaged-functional')) {
  assert.equal(SCENARIO_MANIFEST.schema, 'trace-packaged-functional-scenarios/1');
  const results = [];
  for (const id of SCENARIO_MANIFEST.modules) {
    const filename = path.resolve(directory, id + '.cjs');
    assert.ok(filename.startsWith(path.resolve(directory) + path.sep), `scenario module ${id} stays in its package directory`);
    assert.ok(require('node:fs').existsSync(filename), `required scenario module ${id} is present`);
    const resolvedModule = require.resolve(filename);
    delete require.cache[resolvedModule];
    const module = require(resolvedModule);
    assert.equal(typeof module.run, 'function', `required scenario module ${id} exports run(ctx)`);
    const before = CHECKS.length;
    if (id === 'bug-reports') {
      reportPrivacyActive = true;
      if (typeof context.main === 'function') await context.main(() => globalThis.__traceQaSetBugReportPrivacy?.(true));
    }
    const result = await module.run(context);
    if (id === 'bug-reports') {
      if (typeof context.main === 'function') await context.main(() => globalThis.__traceQaSetBugReportPrivacy?.(false));
      reportPrivacyActive = false;
    }
    const count = CHECKS.length - before;
    assert.ok(count > 0, `required scenario module ${id} recorded at least one assertion`);
    results.push({ id, stepStart: before, stepEnd: CHECKS.length, steps: count, completed: true, result: result === undefined ? null : result });
  }
  return results;
}

async function assertArtifactPayloadLinkage(options, { asarSha256, executableSha256, payloadManifest }) {
  if (appImageMode(options)) {
    assert.ok(canonicalIdentity(options.executable, options.artifact, options.os), 'AppImage QA launches the exact checksummed wrapper');
  }
  if (options.os === 'win32') {
    assert.ok(options.manifest, 'Windows QA requires the unpacked-payload manifest');
    const fuses = await inspectFuses(options.executable);
    return { method: 'unpacked payload manifest plus portable-isolation runtime parity', asarSha256, executableSha256,
      manifestDigest: payloadManifest.digest, portableArtifact: path.basename(options.artifact), fuses };
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-package-link-'));
  try {
    if (options.os === 'darwin') {
      const result = spawnSync('ditto', ['-x', '-k', options.artifact, temporary], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      assert.equal(result.status, 0, `ditto extracted the checksummed macOS ZIP: ${result.stderr || result.error || ''}`);
      const packagedAsar = path.join(temporary, 'TRACE Boardviewer.app', 'Contents', 'Resources', 'app.asar');
      const extractedSha256 = await fileSha(packagedAsar);
      assert.equal(extractedSha256, asarSha256, 'the QA ASAR is byte-identical to app.asar inside the checksummed macOS ZIP');
      const packagedExecutable = path.join(temporary, 'TRACE Boardviewer.app', 'Contents', 'MacOS', 'TRACE Boardviewer');
      const extractedExecutableSha256 = await fileSha(packagedExecutable);
      assert.equal(extractedExecutableSha256, executableSha256, 'the tested macOS executable is byte-identical to the executable inside the checksummed ZIP');
      return { method: 'ditto extraction from checksummed ZIP', asarSha256: extractedSha256, executableSha256: extractedExecutableSha256,
        fuses: await inspectFuses(packagedExecutable) };
    }
    const appImage = /\.AppImage$/i.test(options.artifact);
    const result = appImage
      ? spawnSync(options.artifact, ['--appimage-extract'], { cwd: temporary, encoding: 'utf8', maxBuffer: 1024 * 1024 })
      : spawnSync('dpkg-deb', ['-x', options.artifact, temporary], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `${appImage ? 'AppImage' : 'Debian package'} extracted: ${result.stderr || result.error || ''}`);
    const packageRoot = appImage ? path.join(temporary, 'squashfs-root') : temporary;
    const packagedAsar = path.join(packageRoot, appImage ? 'resources' : path.join('opt', 'TRACE Boardviewer', 'resources'), 'app.asar');
    const extractedSha256 = await fileSha(packagedAsar);
    assert.equal(extractedSha256, asarSha256, `the ${appImage ? 'AppImage' : 'installed DEB'} ASAR is byte-identical to app.asar inside the checksummed artifact`);
    const packagedExecutable = path.join(packageRoot, appImage ? 'trace-boardviewer' : path.join('opt', 'TRACE Boardviewer', 'trace-boardviewer'));
    const extractedExecutableSha256 = await fileSha(packagedExecutable);
    if (!appImage) assert.equal(extractedExecutableSha256, executableSha256, 'the tested DEB executable is byte-identical to the executable inside the checksummed DEB');
    return { method: appImage ? 'AppImage squashfs extraction' : 'dpkg-deb extraction from installed-package artifact', asarSha256: extractedSha256,
      executableSha256: extractedExecutableSha256, fuses: await inspectFuses(packagedExecutable),
      ...(appImage ? { wrapperIdentity: { executable: path.basename(options.executable), artifact: path.basename(options.artifact), equal: true,
        extractedRuntime: path.basename(packagedExecutable), appRun: 'squashfs-root/AppRun' } } : {}) };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

async function inspectFuses(binary) {
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
  const fuses = libraryRequire('@electron/fuses');
  const observedRaw = await fuses.getCurrentFuseWire(binary);
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const configured = packageJson.build?.electronFuses || {};
  const smoke = require(path.join(ROOT, 'scripts', 'linux-smoke.cjs'));
  const observed = smoke.describeFuseWire(observedRaw);
  const expected = smoke.expectedFuseWire(configured);
  assert.deepEqual(expected.unknown, [], 'all configured fuses map to a recorded Electron fuse');
  assert.deepEqual(smoke.compareFuseWire(observed, expected.wire), [], `${path.basename(binary)} fuse wire matches every configured value`);
  return { executableSha256: await fileSha(binary), configured, observed };
}

function boardText() {
  return '$HEADER\nGENCAD 1.4\nUNITS MM\nORIGIN 0 0\n$ENDHEADER\n$BOARD\nRECTANGLE 0 0 40 30\n$ENDBOARD\n$PADS\nPAD P ROUND -1\nCIRCLE 0 0 0.2\n$ENDPADS\n$PADSTACKS\nPADSTACK PS 0\nPAD P TOP 0 0\n$ENDPADSTACKS\n$SHAPES\nSHAPE S\nRECTANGLE -2 -1 4 2\nPIN 1 PS -1 0 TOP 0 0\nPIN 2 PS 1 0 TOP 0 0\n$ENDSHAPES\n$COMPONENTS\nCOMPONENT PU301\nPLACE 10 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\nCOMPONENT U1\nPLACE 20 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\nCOMPONENT U10\nPLACE 30 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\n$ENDCOMPONENTS\n$DEVICES\nDEVICE D\nVALUE "10k"\n$ENDDEVICES\n$SIGNALS\nSIGNAL GND\nNODE PU301 1\nNODE U1 1\nNODE U10 1\nSIGNAL VCC\nNODE PU301 2\nNODE U1 2\nNODE U10 2\n$ENDSIGNALS\n';
}

function schematicText() {
  const eff = '(effects (font (size 1.27 1.27)))';
  const pin = (at, number) => `(pin passive line (at ${at}) (length 1.27) (name "~" ${eff}) (number "${number}" ${eff}))`;
  const lib = `(symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 0 6 0) ${eff}) (property "Value" "R" (at 0 -6 0) ${eff})
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "R_1_1" ${pin('0 3.81 270', '1')} ${pin('0 -3.81 90', '2')}))`;
  const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
  const placed = (ref, id, x) => `(symbol (lib_id "Device:R") (at ${x} 50 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "${id}")
    (property "Reference" "${ref}" (at 0 0 0) ${eff}) (property "Value" "10k" (at 0 0 0) ${eff})
    (instances (project "demo" (path "/${uuid(1)}" (reference "${ref}") (unit 1)))))`;
  return `(kicad_sch (version 20231120) (generator "synthetic") (uuid "${uuid(1)}") (paper "A4") (lib_symbols ${lib})
    ${placed('R1', uuid(2), 40)} ${placed('R2', uuid(3), 80)}
    (wire (pts (xy 40 46.19) (xy 80 46.19)) (stroke (width 0) (type default)) (uuid "${uuid(4)}"))
    (global_label "SIG" (shape input) (at 60 46.19 0) ${eff} (uuid "${uuid(5)}")))`;
}

function ascFiles() {
  const headers = (n, label) => Array.from({ length: n }, (_, i) => '; ' + label + ' header ' + (i + 1));
  return {
    'format.asc': [...headers(8, 'format'), '0.000 0.000', '2.000 0.000', '2.000 1.000', '0.000 1.000'].join('\n') + '\n',
    'pins.asc': [...headers(8, 'pins'), 'Part U1 (T)', '1  1  0.100 0.200  1  VCC  5'].join('\n') + '\n',
    'nails.asc': headers(7, 'nails').join('\n') + '\n',
  };
}

async function captureArtifact(options) {
  const bytes = await fs.readFile(options.artifact);
  const declared = (await fs.readFile(options.checksum, 'utf8')).trim().split(/\s+/)[0].toLowerCase();
  const actual = sha256(bytes);
  assert.match(declared, /^[a-f0-9]{64}$/i, 'checksum file contains SHA-256');
  assert.equal(actual, declared, 'artifact matches its checksum file');
  const asarSha256 = await fileSha(options.asar);
  const executableSha256 = await fileSha(options.executable);
  const ocrAssets = captureOcrAssets(options.asar);
  let payloadManifest = null;
  if (options.manifest) {
    const parsed = JSON.parse(await fs.readFile(options.manifest, 'utf8'));
    payloadManifest = { ...assertPayloadManifest(parsed, { asarSha256, executableSha256 }), name: path.basename(options.manifest) };
  }
  const payloadLinkage = await assertArtifactPayloadLinkage(options, { asarSha256, executableSha256, payloadManifest });
  return { name: path.basename(options.artifact), bytes: bytes.length, sha256: actual,
    checksumName: path.basename(options.checksum), asarName: path.basename(options.asar),
    kind: /\.AppImage$/i.test(options.artifact) ? 'appimage' : 'package',
    asarBytes: (await fs.stat(options.asar)).size, asarSha256, executableSha256: payloadLinkage.executableSha256 || executableSha256,
    ocrAssets, payloadManifest, payloadLinkage };
}

async function step(name, action) {
  const fallbackStage = evidence?.failureStage || 'functional-run';
  if (evidence) evidence.failureStage = 'functional-step:' + name;
  try {
    const result = await action();
    CHECKS.push({ name, status: 'pass', result: result === undefined ? null : result });
    console.log('PASS ' + name);
    if (evidence) evidence.failureStage = fallbackStage;
    return result;
  } catch (error) {
    const reportFailure = reportPrivacyActive || /^(?:bug report|support reminder report)/i.test(name);
    const failure = { name, message: reportFailure ? 'Bug-report acceptance step failed; diagnostic text was withheld.' : error && error.message || String(error) };
    try {
      failure.diagnostics = await collectFailureDiagnostics(page, failureScreenshot, 1200, reportFailure);
    } catch (diagnosticError) {
      failure.diagnostics = { status: 'unavailable', ...(reportFailure ? { reportCaptureMasked: true, error: 'Bug-report diagnostics failed; details were withheld.' }
        : { error: String(diagnosticError && diagnosticError.message || diagnosticError) }) };
    }
    if (reportFailure) failure.diagnostics = { status: 'captured', reportCaptureMasked: true,
      screenshot: failure.diagnostics?.screenshot || null };
    CHECKS.push({ name, status: 'fail', ...(reportFailure ? { error: '[redacted bug-report diagnostic]' } : { error: String(error && error.stack || error) }), diagnostics: failure.diagnostics });
    FAILURES.push(failure);
    console.error('FAIL ' + name + ': ' + (reportFailure ? 'bug-report step failed (details withheld)' : error && error.message || error));
    throw error;
  }
}

async function collectFailureDiagnostics(target, captureScreenshot, timeoutMs = 1200, reportSensitive = reportPrivacyActive) {
  const diagnostics = { status: 'captured', capturedAt: new Date().toISOString() };
  const bounded = (operation, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
    Promise.resolve().then(operation).then(resolve, reject).finally(() => clearTimeout(timer));
  });
  if (!target) return { ...diagnostics, status: 'unavailable', error: 'No active renderer page was available' };
  if (reportSensitive) {
    if (typeof captureScreenshot === 'function') {
      try { diagnostics.screenshot = await bounded(captureScreenshot, 'Synthetic failure screenshot'); }
      catch { diagnostics.screenshotError = 'Bug-report screenshot capture failed; renderer text was withheld.'; }
    }
    return { ...diagnostics, reportCaptureMasked: true, renderer: { bugReportDialogOpen: true } };
  }
  try {
    diagnostics.renderer = await bounded(() => target.evaluate(() => {
      if (document.querySelector('[data-testid=bug-report-dialog]')) return { bugReportDialogOpen: true, activeElementTag: document.activeElement?.tagName || null };
      const text = (selector) => document.querySelector(selector)?.textContent?.trim()?.slice(0, 500) || null;
      const active = document.activeElement;
      const canvases = [...document.querySelectorAll('[data-testid=board-pane] canvas, .board-pane canvas, canvas')].slice(0, 8).map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        const style = getComputedStyle(canvas);
        return { attached: canvas.isConnected, visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, width: canvas.width, height: canvas.height };
      });
      const pane = document.querySelector('[data-testid=board-pane]');
      const panes = [...document.querySelectorAll('[data-testid*=workspace], [data-testid*=document], .workspace-pane')].slice(0, 12).map((node) => ({
        testId: node.getAttribute('data-testid'), role: node.getAttribute('role'), state: node.getAttribute('data-state'),
        status: node.getAttribute('data-status'), text: (node.innerText || '').trim().slice(0, 300),
      }));
      const dialogs = [...document.querySelectorAll('[role=dialog], [aria-modal=true], [data-testid*=modal], [data-testid*=import]')]
        .filter((node) => !node.closest('[data-testid=bug-report-dialog]')).slice(0, 12).map((node) => ({
        testId: node.getAttribute('data-testid'), role: node.getAttribute('role'), ariaLabel: node.getAttribute('aria-label'),
        visible: node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0, text: (node.innerText || '').trim().slice(0, 300),
      }));
      const count = (selector) => document.querySelectorAll(selector).length;
      return {
        url: location.href, activeTab: document.querySelector('[role=tab][aria-selected=true]')?.innerText?.trim() || null,
        activeElement: active ? { tag: active.tagName, testId: active.getAttribute('data-testid'), ariaLabel: active.getAttribute('aria-label'), role: active.getAttribute('role') } : null,
        boardTitle: text('[data-testid=project-name]') || text('[data-testid=board-title]') || document.title || null,
        boardPane: pane ? { attached: pane.isConnected, state: pane.getAttribute('data-state'), text: (pane.innerText || '').trim().slice(0, 500) } : null,
        boardCounts: { components: count('[data-testid=component-row]'), pins: count('[data-testid=pin-row]'), nets: count('[data-testid=net-row]') },
        canvases, workspacePanes: panes, modalImportState: dialogs,
      };
    }), 'Renderer state capture');
  } catch (error) {
    diagnostics.rendererError = String(error && error.message || error);
  }
  if (typeof captureScreenshot === 'function') {
    try { diagnostics.screenshot = await bounded(captureScreenshot, 'Synthetic failure screenshot'); }
    catch (error) { diagnostics.screenshotError = String(error && error.message || error); }
  }
  return diagnostics;
}

function listenForErrors(target, channels = { pageErrors: PAGE_ERRORS, consoleErrors: CONSOLE_ERRORS, cspErrors: CSP_ERRORS }) {
  if (OBSERVED_PAGES.has(target)) return;
  OBSERVED_PAGES.add(target);
  target.on('pageerror', (error) => channels.pageErrors.push(reportPrivacyActive ? '[redacted bug-report renderer error]' : String(error && error.stack || error)));
  target.on('console', (message) => {
    if (message.type() !== 'error') return;
    const observedText = message.text();
    const csp = /content security policy|refused to (?:load|connect|frame|execute)|violates the following content security/i.test(observedText);
    const text = reportPrivacyActive ? null : observedText.slice(0, 600);
    channels.consoleErrors.push(reportPrivacyActive ? { type: 'console', reportSensitive: true, class: csp ? 'csp' : 'renderer' }
      : { text, location: message.location() });
    if (csp) channels.cspErrors.push(reportPrivacyActive ? '[redacted bug-report CSP error]' : text);
  });
}

function installOrdinarySupportSkipObserver() {
  if (window.__traceQaSupportSkipObserverInstalled) return;
  Object.defineProperty(window, '__traceQaSupportSkipObserverInstalled', { value: true, configurable: true });
  document.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const target = event.target instanceof Element ? event.target.closest('[data-testid=support-not-now]') : null;
    if (target) Object.defineProperty(window, '__traceQaOrdinarySupportSkip', { value: true, configurable: true });
  }, true);
}

async function launch(options, profile, board) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  const started = await launchWithPreMainObservers({ executablePath: options.executable,
    args: ['--user-data-dir=' + profile, ...(board ? ['--board=' + board] : [])], env, timeout: 60000 });
  app = started.app;
  if (reportPrivacyActive) await app.evaluate(() => globalThis.__traceQaSetBugReportPrivacy?.(true));
  launchNumber++;
  const startup = { ...started.proof, inspectorPort: started.port };
  evidence.launches = evidence.launches || [];
  const launchRecord = { launch: launchNumber, startup, identity: null, pageErrorStart: PAGE_ERRORS.length,
    consoleErrorStart: CONSOLE_ERRORS.length, cspErrorStart: CSP_ERRORS.length, networkAttempts: [], pageErrors: [], consoleErrors: [] };
  evidence.launches.push(launchRecord);
  const privateMarkerStream = createObserverMarkerAccumulator();
  app.process().stderr.on('data', (chunk) => {
    const output = chunk.toString();
    if (!reportPrivacyActive) { evidence.stderr = (evidence.stderr || '').concat(output).slice(-12000); return; }
    for (const marker of privateMarkerStream.push(output)) {
      evidence.stderr = (evidence.stderr || '').concat('TRACE_QA_PREMAIN_FINAL ' + JSON.stringify(marker) + '\n').slice(-12000);
    }
  });
  const observeWindow = (window) => listenForErrors(window);
  app.on('window', observeWindow);
  for (const existing of app.windows?.() || []) observeWindow(existing);
  page = await app.firstWindow();
  await page.addInitScript(installOrdinarySupportSkipObserver);
  await page.evaluate(installOrdinarySupportSkipObserver);
  const identity = await app.evaluate(({ app: e }) => ({
    isPackaged: e.isPackaged, version: e.getVersion(), platform: process.platform, arch: process.arch, pid: process.pid,
    executable: process.execPath, appPath: e.getAppPath(), userData: e.getPath('userData'),
    appImage: process.env.APPIMAGE || null, appDir: process.env.APPDIR || null, argv0: process.argv0 || null,
    processArgsNoSandbox: !process.argv.includes('--no-sandbox'),
  }));
  identity.executableSha256 = await fileSha(identity.executable);
  identity.asarSha256 = await fileSha(identity.appPath);
  if (options.os === 'linux') assert.ok(identity.processArgsNoSandbox, 'Linux QA launch keeps Chromium sandbox enabled');
  if (appImageMode(options)) {
    assert.ok(identity.appImage && canonicalIdentity(identity.appImage, options.artifact, options.os), 'runtime APPIMAGE names the exact tested wrapper');
    const runtimeRelative = identity.appDir && path.relative(path.resolve(identity.appDir), path.resolve(identity.executable));
    assert.ok(identity.appDir && runtimeRelative && runtimeRelative !== '..' && !runtimeRelative.startsWith('..' + path.sep) && !path.isAbsolute(runtimeRelative),
      'runtime executable resolves inside the active APPDIR mount');
    assert.ok(identity.processArgsNoSandbox, 'sandbox-on AppImage launch has no Playwright or application no-sandbox argument');
    startup.wrapper = { appImage: path.basename(identity.appImage), appDir: path.basename(identity.appDir), runtimeExecutable: path.basename(identity.executable),
      executableInsideAppDir: path.relative(identity.appDir, identity.executable).split(path.sep).join('/') };
  }
  launchRecord.identity = identity;
}

async function closeNormally() {
  const child = app.process();
  const launchRecord = evidence.launches?.findLast((entry) => entry.launch === launchNumber);
  let observationError = null;
  {
    try {
      const snapshot = await withTimeout(app.evaluate(() => globalThis.__traceQaPreMainSnapshot()), 1500, 'Pre-main shutdown snapshot did not settle');
      const attempts = snapshot.network || [];
      const reportObserver = snapshot.reportObserver;
      const reportAttempts = Array.isArray(reportObserver?.attempts) ? reportObserver.attempts : [];
      const reportCounts = reportObserver && { version: reportObserver.version, allowedCount: reportObserver.allowedCount,
        deniedCount: reportObserver.deniedCount, gateArms: reportObserver.gateArms, gateFailures: reportObserver.gateFailures,
        responseArms: reportObserver.responseArms, responseFailures: reportObserver.responseFailures };
      const reportSnapshotValid = hasOnlyOwnKeys(reportObserver, ['version', 'allowedCount', 'deniedCount', 'gateArms', 'gateFailures', 'responseArms', 'responseFailures', 'attempts', 'responses', 'cancelOracles'])
        && observerCounts(reportCounts) !== null;
      const safeAttempts = reportAttempts.map((entry) => ({ targetID: entry?.targetID === 'bug-report-receiver' ? entry.targetID : null,
        method: typeof entry?.method === 'string' && /^[A-Z]{1,12}$/.test(entry.method) ? entry.method : null,
        bytes: Number.isSafeInteger(entry?.bytes) ? entry.bytes : null,
        sha256: typeof entry?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256) ? entry.sha256 : null,
        actionID: typeof entry?.actionID === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(entry.actionID) ? entry.actionID : null,
        decision: entry?.decision === 'allow' || entry?.decision === 'cancel' ? entry.decision : null }));
      const rawResponses = Array.isArray(reportObserver?.responses) ? reportObserver.responses : [];
      const rawCancelOracles = Array.isArray(reportObserver?.cancelOracles) ? reportObserver.cancelOracles : [];
      const safeResponses = rawResponses.map((entry) => ({ actionID: entry?.actionID, mode: entry?.mode, phase: entry?.phase,
        outcome: entry?.outcome, statusCode: entry?.statusCode }));
      const safeCancelOracles = rawCancelOracles.map((entry) => ({ actionID: entry?.actionID,
        cancelAccepted: entry?.cancelAccepted === true, sendTerminalUncertain: entry?.sendTerminalUncertain === true,
        heldAtCancelAccepted: entry?.heldAtCancelAccepted === true, heldAtSendTerminal: entry?.heldAtSendTerminal === true,
        cancelRequestMatchesSend: entry?.cancelRequestMatchesSend === true,
        cancelOutcome: entry?.cancelOutcome, sendOutcome: entry?.sendOutcome, generation: entry?.generation }));
      const reportCaptureValid = reportSnapshotValid && reportObserver?.version === 2 && reportAttempts.length === safeAttempts.length
        && reportAttempts.every((entry) => isReportRecord(entry)) && rawResponses.length === safeResponses.length
        && rawResponses.every(isResponseRecord) && rawCancelOracles.length === safeCancelOracles.length
        && rawCancelOracles.every(isCancelOracle);
      NETWORK.push(...attempts);
      if (launchRecord) {
        launchRecord.networkAttempts = attempts;
        launchRecord.reportObserver = { ...reportCounts, attempts: safeAttempts, responses: safeResponses, cancelOracles: safeCancelOracles, finalMarker: null };
        launchRecord.reportObserverCaptureValid = reportCaptureValid;
        launchRecord.startupObservation = { installedBeforeReady: snapshot.installedBeforeReady, ready: snapshot.ready,
          events: snapshot.events, sessions: snapshot.sessions, windowsAtCapture: snapshot.windows,
          cancelledRequests: attempts.every(isCancelledAttempt),
          reportObserver: reportObserver && { ...reportCounts } };
        launchRecord.mainErrors = snapshot.errors;
        launchRecord.externalIntents = snapshot.external;
      }
      PAGE_ERRORS.push(...snapshot.errors.filter((entry) => entry.type === 'uncaught-exception'));
      CONSOLE_ERRORS.push(...snapshot.errors.filter((entry) => entry.type === 'console'));
    } catch (error) {
      observationError = error;
      if (launchRecord) launchRecord.cleanup = { ...(launchRecord.cleanup || {}), observationError: cleanupErrorClass('shutdown observation', error) };
    }
  }
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  let closeError = null;
  try { await withTimeout(app.close(), 10000, 'Packaged Electron app.close() did not settle during cleanup'); }
  catch (error) { closeError = error; }
  let exitWaitError = null;
  let exitCode = child.exitCode;
  if (exitCode === null) {
    try { exitCode = await withTimeout(exited, 10000, 'Packaged Electron process did not exit normally'); }
    catch (error) { exitWaitError = error; }
  }
  const exit = { launch: launchNumber, exitCode, signal: child.signalCode || null, forced: false };
  evidence.processExits = evidence.processExits || [];
  evidence.processExits.push(exit);
  if (launchRecord) launchRecord.exit = exit;
  if (exitCode !== null) app = null;
  if (launchRecord) {
    const cleanupProblems = [];
    if (closeError) cleanupProblems.push(cleanupErrorClass('application close', closeError));
    if (exitWaitError) cleanupProblems.push(cleanupErrorClass('process exit wait', exitWaitError));
    if (observationError) cleanupProblems.push(cleanupErrorClass('shutdown observation', observationError));
    if (exitCode !== 0 || child.signalCode) cleanupProblems.push(`process exit was not normal (code ${exitCode}, signal ${child.signalCode || 'none'})`);
    cleanupProblems.push(...await collectShutdownEvidence({ launchRecord, readStderr: () => evidence.stderr || '',
      pageErrors: PAGE_ERRORS, consoleErrors: CONSOLE_ERRORS, cspErrors: CSP_ERRORS }));
    launchRecord.exit = exit;
    delete launchRecord.pageErrorStart;
    delete launchRecord.consoleErrorStart;
    delete launchRecord.cspErrorStart;
    if (cleanupProblems.length) launchRecord.cleanup = { ...(launchRecord.cleanup || {}), problems: cleanupProblems };
    if (cleanupProblems.length) throw new Error('Packaged shutdown evidence incomplete: ' + cleanupProblems.join('; '),
      { cause: closeError || exitWaitError || observationError || undefined });
  }
  if (closeError || exitWaitError || observationError || exitCode !== 0 || child.signalCode) {
    throw new Error(`Packaged shutdown evidence incomplete for launch ${launchNumber}`, { cause: closeError || exitWaitError || observationError || undefined });
  }
  return exit;
}

async function __testCloseNormally({ app: testApp, launchRecord, privacyActive = true }) {
  const previous = { app, evidence, launchNumber, reportPrivacyActive, network: NETWORK.length,
    pageErrors: PAGE_ERRORS.length, consoleErrors: CONSOLE_ERRORS.length, cspErrors: CSP_ERRORS.length };
  app = testApp;
  launchNumber = launchRecord.launch;
  reportPrivacyActive = privacyActive;
  evidence = { launches: [launchRecord], processExits: [], stderr: '' };
  try {
    await closeNormally();
    return { error: null, evidence, launchRecord };
  } catch (error) {
    return { error, evidence, launchRecord };
  } finally {
    app = previous.app;
    evidence = previous.evidence;
    launchNumber = previous.launchNumber;
    reportPrivacyActive = previous.reportPrivacyActive;
    NETWORK.length = previous.network;
    PAGE_ERRORS.length = previous.pageErrors;
    CONSOLE_ERRORS.length = previous.consoleErrors;
    CSP_ERRORS.length = previous.cspErrors;
  }
}

async function collectShutdownEvidence({ launchRecord, readStderr, pageErrors, consoleErrors, cspErrors,
  findMarker = waitForProcessObserverMarker, releasePort = waitForPortRelease }) {
  const problems = [];
  let marker = null;
  const pid = launchRecord.identity?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) problems.push('packaged runtime identity PID is missing; final will-quit proof is incomplete');
  else marker = await findMarker(readStderr, pid);
  if (!marker) problems.push('pre-main observer did not emit its final will-quit snapshot');
  else {
    const cancelled = launchRecord.networkAttempts.every(isCancelledAttempt);
    if (marker.allExternalRequestsCancelled !== cancelled) problems.push('final observer cancellation marker conflicts with the captured request decisions');
    if (marker.networkCount !== launchRecord.networkAttempts.length) problems.push('final observer network count did not match captured requests');
    const markerReportObserver = marker.reportObserver;
    const safeMarker = markerReportObserver && observerCounts({ version: markerReportObserver.version, allowedCount: markerReportObserver.allowedCount,
      deniedCount: markerReportObserver.deniedCount, gateArms: markerReportObserver.gateArms, gateFailures: markerReportObserver.gateFailures,
      responseArms: markerReportObserver.responseArms, responseFailures: markerReportObserver.responseFailures });
    const capturedCounts = launchRecord.reportObserver && { version: launchRecord.reportObserver.version,
      allowedCount: launchRecord.reportObserver.allowedCount, deniedCount: launchRecord.reportObserver.deniedCount,
      gateArms: launchRecord.reportObserver.gateArms, gateFailures: launchRecord.reportObserver.gateFailures,
      responseArms: launchRecord.reportObserver.responseArms, responseFailures: launchRecord.reportObserver.responseFailures };
    const safeCapturedCounts = observerCounts(capturedCounts);
    const markerResponseRecords = markerReportObserver?.responses;
    const markerCancelOracles = markerReportObserver?.cancelOracles;
    const markerAttempts = markerReportObserver?.attempts;
    const safeMarkerAttempts = Array.isArray(markerAttempts) && markerAttempts.every(isReportRecord) ? markerAttempts : null;
    const safeMarkerResponseRecords = Array.isArray(markerResponseRecords) && markerResponseRecords.every(isResponseRecord) ? markerResponseRecords : null;
    const safeMarkerCancelOracles = Array.isArray(markerCancelOracles) && markerCancelOracles.every(isCancelOracle) ? markerCancelOracles : null;
    if (!hasOnlyOwnKeys(markerReportObserver, ['version','allowedCount','deniedCount','gateArms','gateFailures','responseArms','responseFailures','attempts','responses','cancelOracles'])
      || !safeMarker || !safeCapturedCounts || !isDeepStrictEqual(safeMarker, safeCapturedCounts)
      || !safeMarkerAttempts || !isDeepStrictEqual(safeMarkerAttempts, launchRecord.reportObserver.attempts)
      || !safeMarkerResponseRecords || !safeMarkerCancelOracles
      || !isDeepStrictEqual(safeMarkerResponseRecords, launchRecord.reportObserver.responses)
      || !isDeepStrictEqual(safeMarkerCancelOracles, launchRecord.reportObserver.cancelOracles)) problems.push('final report observer marker does not match the shutdown snapshot');
    else launchRecord.reportObserver.finalMarker = { ...safeMarker, attempts: safeMarkerAttempts, responses: safeMarkerResponseRecords, cancelOracles: safeMarkerCancelOracles };
    if (marker.errors !== 0) problems.push('pre-main observer recorded main or renderer errors');
    if (marker.ready !== true) problems.push('pre-main observer was not ready at normal shutdown');
    launchRecord.startupObservation = { ...(launchRecord.startupObservation || {}), willQuitCaptured: true,
      finalNetworkCount: marker.networkCount, finalErrors: marker.errors, finalExternalIntents: marker.externalIntents,
      sessions: marker.sessions };
  }
  try { launchRecord.startup.inspectorPortReleased = await releasePort(launchRecord.startup.inspectorPort); }
  catch (error) {
    launchRecord.cleanup = { ...(launchRecord.cleanup || {}), inspectorPortError: cleanupErrorClass('inspector port release', error) };
  }
  if (launchRecord.startup.inspectorPortReleased !== true) problems.push('loopback inspector port release was not confirmed');
  launchRecord.pageErrors = pageErrors.slice(launchRecord.pageErrorStart);
  launchRecord.consoleErrors = consoleErrors.slice(launchRecord.consoleErrorStart);
  launchRecord.cspErrors = cspErrors.slice(launchRecord.cspErrorStart);
  return problems;
}

async function waitForProcessObserverMarker(readStderr, pid, timeoutMs = 1500) {
  assert.equal(typeof readStderr, 'function', 'stderr reader remains live until the observer marker arrives');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stderr = readStderr();
    const marker = stderr.match(/TRACE_QA_PREMAIN_FINAL (\{[^\r\n]+\})\r?\n/g)?.map((line) => {
      try { return safeObserverMarker(JSON.parse(line.slice('TRACE_QA_PREMAIN_FINAL '.length).trim())); } catch { return null; }
    }).findLast((entry) => entry?.pid === pid);
    if (marker) return marker;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function injectSupportReadEacces() {
  await app.evaluate(({ app: electronApp }) => {
    const getBuiltin = process.getBuiltinModule || ((id) => process.mainModule.require(id));
    const fs = getBuiltin('fs/promises');
    const path = getBuiltin('path');
    const target = path.resolve(electronApp.getPath('userData'), 'support-receipt.json');
    const original = fs.open;
    fs.open = async function (filename, ...args) {
      if (path.resolve(String(filename)) === target) {
        fs.open = original;
        globalThis.__traceQaInjectedEacces = (globalThis.__traceQaInjectedEacces || 0) + 1;
        const error = new Error('Synthetic packaged-QA EACCES for support receipt read');
        error.code = 'EACCES';
        throw error;
      }
      return original.call(this, filename, ...args);
    };
  });
}

async function waitForMain(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await app.evaluate(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Electron main-process state: ' + message);
}

async function supportStatusStrings(language) {
  const catalog = JSON.parse(await fs.readFile(path.join(ROOT, 'electron', 'locales', language, 'support.json'), 'utf8'));
  assert.equal(typeof catalog['support.unavailable'], 'string');
  assert.equal(typeof catalog['support.retry'], 'string');
  return { unavailable: catalog['support.unavailable'], retry: catalog['support.retry'] };
}

async function showSupportRetry(language, injectEacces) {
  if (injectEacces) await injectSupportReadEacces();
  await page.click('[data-testid=support-button]');
  await page.waitForSelector('[data-testid=support-retry]', { timeout: 15000 });
  const expected = await supportStatusStrings(language);
  const actual = await page.locator('[data-testid=support-verification] [role=status]').innerText();
  const retry = await page.locator('[data-testid=support-retry]').innerText();
  assert.equal(actual, expected.unavailable, `${language}: rendered unavailable text`);
  assert.equal(retry, expected.retry, `${language}: rendered retry text`);
  return { language, unavailable: actual, retry };
}

async function dismissSupportDialog() { await page.click('[data-testid=support-not-now]'); }

async function switchLanguage(language) {
  await page.click('[data-testid=settings-button]');
  await page.waitForSelector('[data-testid=settings-dialog]');
  await page.locator('[data-testid=language-select]').selectOption(language);
  await page.waitForFunction((value) => document.documentElement.lang === value, language, { timeout: 10000 });
  await page.locator('[data-testid=settings-dialog] button').last().click();
}

async function runSupportUiChecks(profile) {
  const receiptPath = path.join(profile, 'support-receipt.json');
  await page.waitForSelector('[data-testid=support-notice]', { timeout: 20000 });
  await page.waitForSelector('[data-testid=support-retry]', { timeout: 15000 });
  const malformedBefore = await fs.readFile(receiptPath);
  assert.equal((await page.locator('[data-testid=support-verification] [role=status]').innerText()), (await supportStatusStrings('en')).unavailable);
  await page.click('[data-testid=support-stripe]');
  await waitForMain(() => globalThis.__traceQaExternalUrls?.length === 1, 'first mocked external open');
  await page.waitForFunction(() => document.querySelector('[data-testid=support-stripe]')?.disabled === false, null, { timeout: 10000 });
  const malformedUrl = await app.evaluate(() => globalThis.__traceQaExternalUrls.at(-1));
  assert.equal(malformedUrl, STRIPE_BASE, 'malformed receipt opens only the fixed Stripe base URL');
  assert.deepEqual(await fs.readFile(receiptPath), malformedBefore, 'malformed receipt bytes are unchanged');
  await fs.unlink(receiptPath);
  await page.click('[data-testid=support-retry]');
  await page.waitForFunction(() => !!document.querySelector('[data-testid=support-verification] input')?.value, null, { timeout: 15000 });
  const code = await page.locator('[data-testid=support-verification] input').inputValue();
  assert.match(code, /^TRACE-[a-f0-9]{32}$/);
  await dismissSupportDialog();

  const localized = [];
  for (const language of LANGUAGES) {
    if ((await page.evaluate(() => document.documentElement.lang)) !== language) await switchLanguage(language);
    localized.push(await showSupportRetry(language, true));
    const retryBefore = await app.evaluate(() => globalThis.__traceQaInjectedEacces || 0);
    assert.ok(retryBefore > 0, `${language}: injected EACCES reached packaged main-process support store`);
    await page.click('[data-testid=support-retry]');
    await page.waitForFunction(() => !!document.querySelector('[data-testid=support-verification] input')?.value, null, { timeout: 15000 });
    await dismissSupportDialog();
  }

  if ((await page.evaluate(() => document.documentElement.lang)) !== 'en') await switchLanguage('en');
  await page.click('[data-testid=support-button]');
  await page.waitForSelector('[data-testid=support-verification] input', { timeout: 15000 });
  const bytesBeforeEaccesStripe = await fs.readFile(receiptPath);
  await injectSupportReadEacces();
  await page.click('[data-testid=support-stripe]');
  await waitForMain(() => globalThis.__traceQaExternalUrls?.length === 2, 'second mocked external open');
  await page.waitForFunction(() => document.querySelector('[data-testid=support-stripe]')?.disabled === false, null, { timeout: 10000 });
  const eaccesUrl = await app.evaluate(() => globalThis.__traceQaExternalUrls.at(-1));
  assert.equal(eaccesUrl, STRIPE_BASE, 'EACCES opens only the fixed Stripe base URL without a claim');
  assert.deepEqual(await fs.readFile(receiptPath), bytesBeforeEaccesStripe, 'EACCES leaves the valid support receipt bytes unchanged');
  assert.ok((await app.evaluate(() => globalThis.__traceQaInjectedEacces || 0)) >= LANGUAGES.length + 1);

  await injectSupportReadEacces();
  await dismissSupportDialog();
  const rendered = await showSupportRetry('en', false);
  await page.click('[data-testid=support-retry]');
  await page.waitForSelector('[data-testid=support-verify]', { timeout: 15000 });
  const egressBefore = (await app.evaluate(() => (globalThis.__traceQaNetwork || []).length));
  await app.evaluate(() => { globalThis.__traceQaHoldEgress = true; });
  await page.click('[data-testid=support-verify]');
  await waitForMain(() => typeof globalThis.__traceQaEgressRelease === 'function', 'support egress reached the local test interception');
  await page.waitForFunction(() => document.querySelector('[data-testid=support-verify]')?.disabled === true, null, { timeout: 10000 });
  const disabledWhileBusy = await page.locator('[data-testid=support-verify]').isDisabled();
  await app.evaluate(() => { globalThis.__traceQaHoldEgress = false; globalThis.__traceQaEgressRelease?.(); globalThis.__traceQaEgressRelease = null; });
  await page.waitForFunction(() => !document.querySelector('[data-testid=support-verify]')?.disabled &&
    /unavailable/i.test(document.querySelector('[data-testid=support-verification] [role=status]')?.textContent || ''), null, { timeout: 15000 });
  await dismissSupportDialog();
  const external = await app.evaluate(() => globalThis.__traceQaExternalUrls || []);
  assert.deepEqual(external, [STRIPE_BASE, STRIPE_BASE]);
  const network = await app.evaluate(() => globalThis.__traceQaNetwork || []);
  assert.equal(network.length, egressBefore + 1, 'one verification attempt was observed and canceled before reaching the provider');
  assert.ok(network.at(-1).url.startsWith('https://'), 'the blocked request used HTTPS');
  return {
    localized,
    recoveryReference: 'TRACE-' + code.slice('TRACE-'.length),
    stripeMalformed: { url: malformedUrl, storedBytesUnchanged: true },
    stripeEacces: { url: eaccesUrl, storedBytesUnchanged: true, proof: 'injected-main-process-fs-open-EACCES' },
    supportReadEaccesProof: 'injected-main-process-fs-open-EACCES',
    verification: { rendered, verifyDisabledWhileBusy: disabledWhileBusy, providerRequestsReached: 0, blockedAttempts: 1 },
    networkAttempts: network,
    externalOpenCalls: external,
  };
}

async function openDialog(files) {
  return withOpenDialog(files, () => page.locator('[data-testid=open-board]').click());
}

function normalizeBoardExpectation(expected = [3, 6, 2]) {
  const counts = Array.isArray(expected) ? { components: expected[0], pins: expected[1], nets: expected[2] } : expected;
  assert.ok(counts && typeof counts === 'object' && !Array.isArray(counts), 'board expectation is a count tuple or object');
  for (const key of ['components', 'pins', 'nets']) assert.ok(Number.isSafeInteger(counts[key]) && counts[key] >= 0, `${key} expectation is a non-negative integer`);
  for (const key of ['target', 'title', 'nativeKey']) if (counts[key] !== undefined) assert.equal(typeof counts[key], 'string', `${key} expectation is a string`);
  return counts;
}

function sameCanonicalPath(actual, expected, platform = process.platform) {
  const left = path.resolve(actual), right = path.resolve(expected);
  return platform === 'win32' ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US') : left === right;
}

function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function registerFixtureFile(fixtureDir, name, bytes, files, fixtureHashes) {
  assert.equal(typeof name, 'string');
  const target = path.resolve(fixtureDir, name);
  assert.ok(isPathWithin(fixtureDir, target), 'registered fixture path stays inside the synthetic fixture directory');
  assert.ok(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array || typeof bytes === 'string', 'registered fixture must be Buffer, Uint8Array, or a documented UTF-8 string');
  assert.equal(files.includes(target), false, 'registered fixture names cannot overwrite existing synthetic inputs');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const canonicalFixtureRoot = await fs.realpath(fixtureDir);
  const canonicalParent = await fs.realpath(path.dirname(target));
  assert.ok(canonicalParent === canonicalFixtureRoot || isPathWithin(canonicalFixtureRoot, canonicalParent),
    'registered fixture parent resolves inside the synthetic fixture directory');
  const fixtureBytes = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  await fs.writeFile(target, fixtureBytes, { flag: 'wx' });
  const relative = path.relative(fixtureDir, target).replace(/\\/g, '/');
  fixtureHashes[relative] = await fileSha(target);
  if (!files.includes(target)) files.push(target);
  return target;
}

async function withDialogOverride(method, value, action) {
  assert.ok(app && typeof action === 'function', `${method} requires a live app and caller action`);
  const token = `__traceQaDialog_${method}`;
  await app.evaluate(({ dialog }, { methodName, tokenName, dialogValue }) => {
    if (globalThis[tokenName]) throw new Error(`A ${methodName} chooser is already active`);
    const original = dialog[methodName];
    const replacement = methodName === 'showOpenDialog'
      ? async () => ({ canceled: false, filePaths: dialogValue })
      : async () => ({ canceled: false, filePath: dialogValue });
    globalThis[tokenName] = { original, replacement };
    dialog[methodName] = replacement;
  }, { methodName: method, tokenName: token, dialogValue: value });
  try { return await action(); }
  finally {
    if (app) await app.evaluate(({ dialog }, { methodName, tokenName }) => {
      const saved = globalThis[tokenName];
      if (saved) {
        if (dialog[methodName] === saved.replacement) dialog[methodName] = saved.original;
        delete globalThis[tokenName];
      }
    }, { methodName: method, tokenName: token });
  }
}

async function withOpenDialog(files, action) {
  assert.ok(Array.isArray(files) && files.length > 0, 'open chooser requires one or more paths');
  return withDialogOverride('showOpenDialog', files, action);
}

async function withSaveDialog(destination, action) {
  assert.equal(typeof destination, 'string', 'save chooser requires a destination path');
  return withDialogOverride('showSaveDialog', destination, action);
}

async function waitBoard(expected = [3, 6, 2]) {
  const counts = normalizeBoardExpectation(expected);
  if (counts.nativeKey !== undefined) assert.ok(counts.target, 'nativeKey checks require the requested target as well');
  const expectedTarget = counts.target === undefined ? null : await fs.realpath(counts.target);
  if (counts.nativeKey !== undefined) {
    const singleFileKey = sha256(await fs.readFile(expectedTarget));
    assert.equal(counts.nativeKey, singleFileKey, 'single-file native board identity matches the requested target bytes');
  }
  const deadline = Date.now() + 45000;
  let latest = null;
  while (Date.now() < deadline) {
    if (await page.locator('[data-testid=project-name]').count() && await page.locator('[data-testid=board-pane] canvas').count()) {
      const text = (await page.locator('.status-left').innerText()).replace(/[\s\u00a0\u202f]/g, '');
      const values = text.match(/(\d+)\D{0,24}(\d+)\D{0,24}(\d+)/);
      const identity = await page.locator('.project-heading').evaluate((node) => ({ title: node.querySelector('.project-name')?.textContent?.trim() || '', target: node.getAttribute('title') || '' }));
      const actualTarget = identity.target ? await fs.realpath(identity.target).catch(() => null) : null;
      latest = { values: values?.slice(1).map(Number) || null, identity };
      const countsMatch = JSON.stringify(latest.values) === JSON.stringify([counts.components, counts.pins, counts.nets]);
      const titleMatches = counts.title === undefined || identity.title === counts.title;
      const targetMatches = expectedTarget === null || (actualTarget !== null && sameCanonicalPath(actualTarget, expectedTarget, optionsPlatform()));
      if (countsMatch && titleMatches && targetMatches) {
        return { components: counts.components, pins: counts.pins, nets: counts.nets, title: identity.title, target: identity.target };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`active board did not reach the requested counts/identity: ${JSON.stringify(latest)}`);
}

function optionsPlatform() { return evidence?.expected?.os || process.platform; }

const SUPPORT_NOTICE = '[data-testid=support-notice]';
const SUPPORT_SKIP = `${SUPPORT_NOTICE} [data-testid=support-not-now]`;
const SUPPORT_SKIP_SETTLEMENTS = new WeakMap();

async function withinStartupDeadline(action, deadline, description) {
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, 'startup support settlement exceeded its deadline');
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${description} did not settle before the startup support deadline`)), remaining); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function settleStartupSupportNotice(targetPage = page, timeout = 20000) {
  assert.ok(targetPage, 'startup support settlement requires a live page');
  assert.ok(Number.isFinite(timeout) && timeout > 0, 'startup support settlement timeout is positive and finite');
  const deadline = Date.now() + timeout;
  const remaining = () => {
    const value = deadline - Date.now();
    assert.ok(value > 0, 'startup support settlement exceeded its deadline');
    return value;
  };
  const documentState = await withinStartupDeadline(
    () => targetPage.evaluate(() => ({
      url: location.href,
      key: `${location.href}\n${performance.timeOrigin}`,
      ordinarySkip: window.__traceQaOrdinarySupportSkip === true,
    })), deadline, 'current renderer document identity',
  );
  let settlement = SUPPORT_SKIP_SETTLEMENTS.get(targetPage);
  if (!settlement || settlement.key !== documentState.key) {
    settlement = { key: documentState.key, ordinarySkip: false };
    SUPPORT_SKIP_SETTLEMENTS.set(targetPage, settlement);
  }
  if (documentState.ordinarySkip) settlement.ordinarySkip = true;

  const notice = targetPage.locator(SUPPORT_NOTICE);
  const skip = targetPage.locator(SUPPORT_SKIP);
  const visibleNow = await withinStartupDeadline(() => notice.isVisible(), deadline, 'support notice visibility check');
  if (visibleNow) {
    await withinStartupDeadline(() => skip.waitFor({ state: 'visible', timeout: remaining() }), deadline, 'support notice Skip button');
    await withinStartupDeadline(() => skip.click({ timeout: remaining() }), deadline, 'support notice Skip click');
    await withinStartupDeadline(() => notice.waitFor({ state: 'detached', timeout: remaining() }), deadline, 'support notice close');
    settlement.ordinarySkip = true;
    return { status: 'dismissed' };
  }

  if (settlement.ordinarySkip) {
    // An ordinary Skip may have been clicked by a scenario module outside this helper.
    // Handle a dialog that reappeared after the earlier visibility check.
    if (await withinStartupDeadline(() => notice.isVisible(), deadline, 'support notice reappearance check')) {
      await withinStartupDeadline(() => skip.waitFor({ state: 'visible', timeout: remaining() }), deadline, 'support notice Skip button');
      await withinStartupDeadline(() => skip.click({ timeout: remaining() }), deadline, 'support notice Skip click');
      await withinStartupDeadline(() => notice.waitFor({ state: 'detached', timeout: remaining() }), deadline, 'support notice close');
      return { status: 'dismissed' };
    }
    return { status: 'already-dismissed' };
  }

  // This generic helper is used only for the generated, unpaid startup profiles.
  // Verified support suppression is asserted by the dedicated support scenario with
  // its real renderer bootstrap observation; absence here always fails closed.
  await withinStartupDeadline(() => notice.waitFor({ state: 'visible', timeout: remaining() }), deadline, 'fresh support notice');
  await withinStartupDeadline(() => skip.waitFor({ state: 'visible', timeout: remaining() }), deadline, 'support notice Skip button');
  await withinStartupDeadline(() => skip.click({ timeout: remaining() }), deadline, 'support notice Skip click');
  await withinStartupDeadline(() => notice.waitFor({ state: 'detached', timeout: remaining() }), deadline, 'support notice close');
  settlement.ordinarySkip = true;
  return { status: 'dismissed' };
}

async function attachDocuments(files) {
  await page.click('#wsp-tab-documents');
  await page.waitForSelector('[data-testid=documents-tab]');
  await withOpenDialog(files, () => page.click('[data-testid=attach]'));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=document-row]').length === 2 &&
    [...document.querySelectorAll('[data-testid=document-row]')].every((row) =>
      row.getAttribute('data-status') === 'ready' && row.querySelector('[data-testid=status-chip]')?.getAttribute('data-status') === 'ready'),
  null, { timeout: 45000 });
  const names = await page.$$eval('[data-testid=document-row]', (rows) => rows.map((row) => row.querySelector('.wsp-doc-title')?.textContent || '').sort());
  assert.deepEqual(names, ['manual.pdf', 'wiring.kicad_sch']);
  return names;
}

async function runFunctional(options) {
  evidence.failureStage = 'fixture-generation';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-packaged-functional-'));
  const profile = path.join(root, 'profile'), fixtureDir = path.join(root, 'fixtures');
  const writeQaProfileConfig = async (target) => {
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'config.json'), JSON.stringify({ version: 1, settings: {
      language: 'en', theme: 'dark', layout: 'workshop', motion: true, showLabels: true, showConnections: true,
      updateCheck: false, supportVerification: false,
    }, recentBoards: [] }));
  };
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(fixtureDir, { recursive: true });
  await writeQaProfileConfig(profile);
  // Deliberately damaged synthetic support storage exercises the packaged Retry flow without a provider call.
  await fs.writeFile(path.join(profile, 'support-receipt.json'), '{"claim":');
  const boardPath = path.join(fixtureDir, 'SyntheticBoard.cad');
  const secondBoardPath = path.join(fixtureDir, 'SyntheticBoardWithExtraComponent.cad');
  const pdfPath = path.join(fixtureDir, 'manual.pdf');
  const schematicPath = path.join(fixtureDir, 'wiring.kicad_sch');
  const board = Buffer.from(boardText());
  const boardTextWithExtra = boardText().replace('COMPONENT U10\nPLACE 30 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\n',
    'COMPONENT U10\nPLACE 30 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\nCOMPONENT U11\nPLACE 35 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\n');
  const secondBoard = Buffer.from(boardTextWithExtra);
  const pdf = makeImageOnlyPdf(['PU301   U10', 'U10']);
      const schematic = Buffer.from(schematicText());
  await Promise.all([fs.writeFile(boardPath, board), fs.writeFile(secondBoardPath, secondBoard), fs.writeFile(pdfPath, pdf), fs.writeFile(schematicPath, schematic)]);
  const boardZip = path.join(fixtureDir, 'SyntheticBoard.zip');
  const unsafeZip = path.join(fixtureDir, 'Unsafe.zip');
  const multiZip = path.join(fixtureDir, 'MultipleBoards.zip');
  await Promise.all([
    fs.writeFile(boardZip, zipSync({ 'SyntheticBoard.cad': board })),
    fs.writeFile(unsafeZip, zipSync({ '../escape.cad': board })),
    fs.writeFile(multiZip, zipSync({ 'one.cad': board, 'two.cad': board })),
  ]);
  const asc = ascFiles();
  for (const [name, content] of Object.entries(asc)) await fs.writeFile(path.join(fixtureDir, name), content);
  const files = [boardPath, secondBoardPath, pdfPath, schematicPath, boardZip, unsafeZip, multiZip, ...Object.keys(asc).map((name) => path.join(fixtureDir, name))];
  const fixtureHashes = Object.fromEntries(await Promise.all(files.map(async (file) => [path.relative(fixtureDir, file).replace(/\\/g, '/'), await fileSha(file)])));
  evidence.fixtures = fixtureHashes;
  const screenshotsDir = path.join(path.dirname(options.out), path.basename(options.out, path.extname(options.out)) + '-screenshots');
  await fs.mkdir(screenshotsDir, { recursive: true });
  const screenshotManifest = [];
  const maskBugReportEvidence = async () => {
    if (!page) return;
    await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid=bug-report-dialog]');
      if (dialog) dialog.style.visibility = 'hidden';
      for (const selector of ['[data-testid=bug-report-dialog] textarea', '[data-testid=bug-report-dialog] pre', '[data-testid=bug-report-dialog] [role=status]', '[data-testid=bug-report-dialog] [role=alertdialog]', '[data-testid=bug-report-description]', '[data-testid=bug-report-preview]', '[data-testid=bug-report-result]', '.bug-report-hash', '.bug-report-json pre']) {
        const element = document.querySelector(selector);
        if (element && 'value' in element) element.value = '';
        else if (element) element.textContent = '';
      }
    });
  };
  const screenshot = async (name) => {
    assert.match(name, /^[a-z0-9][a-z0-9-]*$/i, 'screenshot label is a simple file-safe name');
    const filename = name + '.png';
    const fullPath = path.join(screenshotsDir, filename);
    await maskBugReportEvidence();
    await page.screenshot({ path: fullPath, fullPage: true });
    const bytes = await fs.readFile(fullPath);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${filename} is a PNG screenshot`);
    screenshotManifest.push({ name: filename, bytes: bytes.length, sha256: sha256(bytes), signature: 'png' });
    evidence.screenshots = evidence.screenshots || [];
    evidence.screenshots.push(filename);
    return filename;
  };
  failureScreenshot = async () => {
    if (!page) return null;
    await maskBugReportEvidence();
    return screenshot('failure-diagnostic');
  };
  evidence.failureStage = 'functional-flow';
  try {
    await launch(options, profile, boardPath);
    evidence.runtime = { ...evidence.launches[0].identity };
    evidence.security = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const preferences = window.webContents.getLastWebPreferences();
      return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration, processArgsNoSandbox: process.argv.includes('--no-sandbox') };
    });
    evidence.runtime.executableSha256 = await fileSha(evidence.runtime.executable);
    evidence.runtime.asarSha256 = await fileSha(evidence.runtime.appPath);
    await step('packaged runtime identity, app.asar and isolated user profile', async () => {
      assert.equal(evidence.runtime.isPackaged, true);
      assert.equal(evidence.runtime.version, options.version);
      assert.equal(evidence.runtime.platform, options.os);
      assert.equal(evidence.runtime.arch, options.arch);
      const realpath = (filename) => fsSync.realpathSync.native(filename);
      if (evidence.artifact.kind !== 'appimage') assert.ok(canonicalIdentity(evidence.runtime.executable, options.executable, options.os, realpath), 'runtime executable resolves to the requested artifact executable');
      if (evidence.artifact.kind !== 'appimage') assert.ok(canonicalIdentity(evidence.runtime.appPath, options.asar, options.os, realpath), 'runtime app.asar resolves to the requested ASAR');
      assert.ok(canonicalIdentity(evidence.runtime.userData, profile, options.os, realpath), 'runtime profile resolves to the isolated profile');
      assert.equal(evidence.runtime.executableSha256, evidence.artifact.executableSha256, 'the running executable is byte-identical to the executable linked from the artifact');
      assert.equal(evidence.runtime.asarSha256, evidence.artifact.asarSha256, 'the running ASAR is byte-identical to the ASAR linked from the artifact');
      assert.equal(evidence.security.sandbox, true, 'renderer sandbox remains enabled');
      assert.equal(evidence.security.contextIsolation, true);
      assert.equal(evidence.security.nodeIntegration, false);
      assert.equal(evidence.security.processArgsNoSandbox, false);
      return { runtime: evidence.runtime, security: evidence.security };
    });
    await step('production file URL, renderer isolation and exact board counts', async () => {
      const counts = await waitBoard();
      assert.match(page.url(), /^file:\/\//);
      assert.equal(await page.evaluate(() => window.isSecureContext), true);
      assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
      const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
      assert.match(policy || '', /script-src 'self'/);
      assert.doesNotMatch(policy || '', /unsafe-eval|wasm-unsafe-eval/);
      evidence.csp = { policy, unsafeEvalEnabled: false };
      await screenshot('board-loaded');
      return { ...counts, url: page.url(), csp: evidence.csp };
    });
    await step('packaged support recovery, all localized unavailable states and safe Stripe IPC', async () => {
      const result = await runSupportUiChecks(profile);
      evidence.support = result;
      return result;
    });
    await step('ordinary single-board ZIP opens', async () => {
      await openDialog([boardZip]);
      await page.waitForFunction(() => /SyntheticBoard\.zip/i.test(document.querySelector('.project-subtitle')?.textContent || ''), null, { timeout: 30000 });
      return waitBoard();
    });
    await step('unsafe and multi-board ZIPs are refused while the loaded board stays usable', async () => {
      for (const file of [unsafeZip, multiZip]) {
        const oldToast = page.locator('.toast.error[role=alert]');
        if (await oldToast.count()) {
          await oldToast.locator('button[aria-label]').click();
          await oldToast.waitFor({ state: 'detached', timeout: 5000 });
        }
        await openDialog([file]);
        await page.waitForSelector('.toast.error[role=alert]', { timeout: 15000 });
        const rejection = await page.locator('.toast.error[role=alert]').innerText();
        await waitBoard();
        CHECKS.push({ name: path.basename(file) + ' rejection is shown while the board stays usable', status: 'pass', result: rejection });
      }
      return { rejected: ['Unsafe.zip', 'MultipleBoards.zip'], boardUsable: true };
    });
    await step('declared ASC outline, pins and nails companions open through either member', async () => {
      await openDialog([path.join(fixtureDir, 'format.asc')]);
      await page.waitForFunction(() => /format\.asc/i.test(document.querySelector('.project-subtitle')?.textContent || ''), null, { timeout: 20000 });
      const counts = await waitBoard([1, 1, 1]);
      await page.fill('[data-testid=search-input]', 'U1');
      await page.press('[data-testid=search-input]', 'Enter');
      await page.waitForSelector('[data-testid=pin-row]', { timeout: 15000 });
      await page.locator('[data-testid=pin-row]').first().click();
      await page.click('[data-testid=add-note]');
      await page.fill('#note-draft', 'companion identity note');
      await page.click('[data-testid=note-save]');
      await page.waitForSelector('[data-testid=note-card]', { timeout: 15000 });
      await page.waitForFunction(() => /saved/i.test(document.querySelector('[data-testid=save-state]')?.getAttribute('data-state') || document.querySelector('[data-testid=save-state]')?.textContent || ''), null, { timeout: 20000 });
      const exit = await closeNormally();
      await launch(options, profile, path.join(fixtureDir, 'pins.asc'));
      await waitBoard([1, 1, 1]);
      await settleStartupSupportNotice();
      await page.waitForFunction(() => /pins\.asc/i.test(document.querySelector('.project-subtitle')?.textContent || ''), null, { timeout: 20000 });
      await page.fill('[data-testid=search-input]', 'U1');
      await page.press('[data-testid=search-input]', 'Enter');
      await page.waitForSelector('[data-testid=pin-row]', { timeout: 15000 });
      await page.locator('[data-testid=pin-row]').first().click();
      await page.waitForFunction(() => /companion identity note/.test(document.querySelector('[data-testid=inspector]')?.textContent || ''), null, { timeout: 15000 });
      return { openedFrom: 'format.asc', restartedFrom: 'pins.asc', companionCounts: counts, companionNoteRestored: true, firstProcessExit: exit.exitCode };
    });
    await step('attachments and bundled image-only PDF OCR work', async () => {
      await openDialog([boardPath]);
      await page.waitForFunction(() => /SyntheticBoard\.cad/i.test(document.querySelector('.project-subtitle')?.textContent || ''), null, { timeout: 20000 });
      await waitBoard();
      const attachments = await attachDocuments([pdfPath, schematicPath]);
      await page.locator('[data-testid=document-row] .wsp-doc-main', { hasText: 'manual.pdf' }).click();
      await page.waitForSelector('[data-testid=documents-tab] .pdfv-page[data-render=done]', { timeout: 30000 });
      await page.locator('[data-action=recognize-text]').click();
      await page.waitForSelector('.pdfv-ocr-badge', { timeout: 120000 });
      const words = await page.$$eval('.pdfv-text-ocr > span', (nodes) => nodes.map((node) => ({
        text: node.textContent || '', confidence: Number((node.getAttribute('title') || '').match(/(\d+)\s*%/)?.[1] || 0),
      })));
      assert.ok(words.some((word) => /PU301/i.test(word.text) && word.confidence > 0), JSON.stringify(words));
      assert.ok(words.some((word) => /U10/i.test(word.text) && word.confidence >= 60), JSON.stringify(words));
      const labels = await page.$$eval('.pdfv-probe.is-ocr', (nodes) => nodes.map((node) => node.getAttribute('aria-label') || node.getAttribute('title') || ''));
      assert.ok(labels.some((label) => /^U10,/.test(label)), 'exact U10 OCR reference is linked');
      assert.ok(!labels.some((label) => /^U1,/.test(label)), 'U10 must not be substring-matched as U1');
      const observed = await app.evaluate(() => globalThis.__traceQaResources || []);
      const ocrUrls = observed.filter((url) => /(?:tesseract-core-(?:simd-)?lstm|eng\.traineddata)/.test(url));
      assert.ok(ocrUrls.some((url) => /\.wasm(?:[?#]|$)/.test(url)), 'the OCR WASM asset was loaded by the packaged renderer');
      assert.ok(ocrUrls.some((url) => /traineddata/.test(url)), 'the English OCR data was loaded by the packaged renderer');
      const archiveAssets = new Set(evidence.artifact.ocrAssets.map((asset) => asset.path.replace(/\\/g, '/')));
      const observedAssets = ocrUrls.map((url) => {
        const pathname = decodeURIComponent(new URL(url).pathname).replace(/\\/g, '/');
        assert.match(pathname, /\/resources\/app\.asar\/dist\/assets\//i, 'OCR asset URL resolves inside the packaged app.asar');
        const match = pathname.match(/(dist\/assets\/[^/]+)$/);
        assert.ok(match, 'observed OCR URL has a concrete packaged asset name');
        assert.ok(archiveAssets.has(match[1]), 'the loaded OCR asset is one whose bytes were hashed from this ASAR');
        return match[1];
      });
      evidence.ocrAssetRuntimeProof = { assets: observedAssets, loadedFrom: 'resources/app.asar/dist/assets', archiveSha256: evidence.artifact.asarSha256 };
      await page.fill('[data-testid=search-input]', 'PU301');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=search-row]')].some((node) => /manual\.pdf|document/i.test(node.textContent || '')), null, { timeout: 30000 });
      assert.equal(await page.locator('.pdfv-error').count(), 0);
      await screenshot('ocr-recognized');
      await page.fill('[data-testid=search-input]', '');
      await page.locator('[data-testid=document-row] .wsp-doc-main', { hasText: 'wiring.kicad_sch' }).click();
      await page.waitForFunction(() => document.querySelector('.schv-canvas') || document.querySelector('.wsp-state[role=alert]'), null, { timeout: 30000 }).catch(() => {});
      const schematicState = await page.evaluate(() => ({ canvasCount: document.querySelectorAll('.schv-canvas').length,
        selectedDocument: document.querySelector('[data-testid=document-row][aria-current=true] .wsp-doc-title')?.textContent || null,
        message: document.querySelector('.wsp-state[role=alert]')?.innerText || null,
        viewerText: document.querySelector('[data-testid=documents-tab]')?.innerText || '' }));
      assert.equal(schematicState.canvasCount, 1, `the synthetic KiCad schematic reaches its packaged canvas: ${JSON.stringify(schematicState)}`);
      return { attachments, recognizedWords: words, exactReferenceLabels: labels, ocrAssetRuntimeProof: evidence.ocrAssetRuntimeProof, schematic: schematicState };
    });
    await step('typed pin note, measurement, attachments and settings survive normal quit and restart', async () => {
      await page.fill('[data-testid=search-input]', 'PU301');
      await page.press('[data-testid=search-input]', 'Enter');
      await page.waitForSelector('[data-testid=pin-row]', { timeout: 15000 });
      await page.locator('[data-testid=pin-row]').first().click();
      await page.click('#wsp-tab-board');
      await page.click('[data-testid=add-note]');
      await page.fill('#note-draft', 'packaged fixture note');
      await page.fill('[data-testid=measure-voltage]', '0.42 V');
      await page.click('[data-testid=note-save]');
      await page.waitForFunction(() => /0\.42 V/.test(document.querySelector('[data-testid=note-card]')?.textContent || ''), null, { timeout: 15000 });
      await page.waitForFunction(() => /saved/i.test(document.querySelector('[data-testid=save-state]')?.getAttribute('data-state') || document.querySelector('[data-testid=save-state]')?.textContent || ''), null, { timeout: 20000 });
      await page.click('[data-testid=settings-button]');
      await page.waitForSelector('[data-testid=settings-dialog]');
      await page.click('[data-testid=theme-light]');
      const settingButtons = page.locator('[data-testid=settings-dialog] button');
      await settingButtons.last().click();
      const exit = await closeNormally();
      evidence.normalQuit = exit.exitCode === 0;
      await launch(options, profile, boardPath);
      await waitBoard();
      await settleStartupSupportNotice();
      await page.fill('[data-testid=search-input]', 'PU301');
      await page.press('[data-testid=search-input]', 'Enter');
      await page.waitForSelector('[data-testid=pin-row]');
      await page.locator('[data-testid=pin-row]').first().click();
      await page.waitForFunction(() => /0\.42 V/.test(document.querySelector('[data-testid=inspector]')?.textContent || ''), null, { timeout: 20000 });
      await page.click('#wsp-tab-documents');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=document-row]').length === 2 && [...document.querySelectorAll('[data-testid=document-row]')].every((row) => row.getAttribute('data-status') === 'ready'), null, { timeout: 30000 });
      await page.locator('[data-testid=document-row] .wsp-doc-main', { hasText: 'manual.pdf' }).click();
      await page.waitForSelector('[data-action=recognize-text]', { timeout: 20000 });
      assert.equal(await page.locator('.pdfv-ocr-badge').count(), 0, 'OCR results are session-only and must not survive a new process');
      const settings = await page.evaluate(() => window.traceDesktop.getSettings());
      assert.equal(settings.updateCheck, false);
      assert.equal(settings.theme, 'light');
      assert.equal(await app.evaluate(({ app: e }) => e.getPath('userData')), profile);
      return { noteRestored: true, measurement: '0.42 V', attachmentsRestored: 2, settings, sameProfile: true, normalExitCode: exit.exitCode };
    });
    evidence.restartedRuntime = { ...evidence.launches.at(-1).identity };
    await step('only the deliberate verification request was blocked before network access', async () => {
      const activity = await page.evaluate(() => window.traceDesktop.getNetworkActivity());
      const finalProcessAttempts = await app.evaluate(() => globalThis.__traceQaNetwork || []);
      NETWORK.push(...finalProcessAttempts);
      evidence.launches.at(-1).networkAttempts = finalProcessAttempts;
      evidence.networkActivity = activity;
      assert.ok(NETWORK.every((attempt) => attempt.cancelledBeforeNetwork === true));
      assert.equal(NETWORK.length, 1, 'after the first-window observer was installed, only the deliberate support-verification attempt occurred');
      assert.equal(evidence.support?.verification?.providerRequestsReached, 0);
      return { blockedAttempts: NETWORK.length, providerRequestsReached: 0, updateCheckSeededOff: true, featureIds: (activity.features || []).map((feature) => feature.id) };
    });
    await step('no uncaught renderer errors or CSP violations', async () => {
      assert.deepEqual(PAGE_ERRORS, []);
      assert.deepEqual(CSP_ERRORS, []);
      assert.deepEqual(CONSOLE_ERRORS, [], 'unexplained browser console errors fail packaged QA');
      return { pageErrors: 0, cspErrors: 0, consoleErrors: 0 };
    });
    const profileFile = (name) => {
      assert.equal(typeof name, 'string');
      const resolved = path.resolve(runningProfile, name);
      assert.ok(resolved.startsWith(runningProfile + path.sep), 'profile helper path remains inside the active isolated profile');
      return resolved;
    };
    let runningProfile = profile;
    let runningTarget = boardPath;
    const context = strictContext({
      options, evidence, root, get profile() { return runningProfile; }, fixtureDir,
      getPage: () => { assert.ok(page, 'a live renderer page is available'); return page; },
      getApp: () => { assert.ok(app, 'a live Electron app is available'); return app; },
      step: (name, action) => step(name, action),
      registerFixture: (name, bytes) => registerFixtureFile(fixtureDir, name, bytes, files, fixtureHashes),
      openFiles: async (paths) => {
        assert.ok(Array.isArray(paths) && paths.length > 0, 'openFiles requires one or more synthetic fixture paths');
        const fixtureRoot = await fs.realpath(fixtureDir);
        const checked = await Promise.all(paths.map(async (filename) => {
          const real = await fs.realpath(filename);
          assert.ok(isPathWithin(fixtureRoot, real), 'openFiles accepts only files inside the synthetic fixture directory');
          return real;
        }));
        return withOpenDialog(checked, () => page.locator('[data-testid=open-board]').click());
      }, waitBoard: async (expectedCounts) => {
        const result = await waitBoard(expectedCounts);
        if (expectedCounts && !Array.isArray(expectedCounts) && expectedCounts.target) runningTarget = await fs.realpath(expectedCounts.target);
        return result;
      },
      setLanguage: async (language) => {
        assert.ok(LANGUAGES.includes(language), 'QA language selection is limited to the eight shipped locales');
        await switchLanguage(language);
        assert.equal(await page.evaluate(() => document.documentElement.lang), language, 'the real settings control selected the requested locale');
        return true;
      },
      deliverSyntheticBoard: async (filename) => {
        const fixtureRoot = await fs.realpath(fixtureDir);
        const real = await fs.realpath(filename);
        assert.ok(isPathWithin(fixtureRoot, real), 'synthetic native board delivery stays inside the generated fixture root');
        const delivered = await app.evaluate(({ app: electronApp }, value) => {
          if (process.platform === 'darwin') return electronApp.emit('open-file', { preventDefault() {} }, value);
          return electronApp.emit('second-instance', {}, [process.execPath, '--board=' + value], require('node:path').dirname(value));
        }, real);
        assert.equal(delivered, true, 'the actual main process has a listener for the platform native-delivery event');
        return { delivered: true };
      },
      dismissSupport: async () => settleStartupSupportNotice(), screenshot,
      main: async (fn, arg) => { assert.ok(app, 'main evaluation requires a live process'); return app.evaluate(fn, arg); },
      withOpenDialog: async (paths, action) => withOpenDialog(paths, action),
      withSaveDialog: async (destination, action) => withSaveDialog(destination, action),
      restart: async () => { assert.ok(app, 'restart requires a live process'); const target = runningTarget; await closeNormally(); await launch(options, runningProfile, target); return app; },
      withWelcome: async (action) => {
        assert.equal(typeof action, 'function');
        const previousTarget = runningTarget;
        const previousProfile = runningProfile;
        const welcomeProfile = path.join(root, 'fresh-no-board-profile');
        if (app) await closeNormally();
        runningTarget = null;
        runningProfile = welcomeProfile;
        let welcomeStarted = false;
        try {
          await writeQaProfileConfig(welcomeProfile);
          await launch(options, runningProfile, null);
          welcomeStarted = true;
          await page.waitForSelector('[data-testid=welcome]', { timeout: 20000 });
          assert.equal(await page.locator('[data-testid=project-name]').count(), 0, 'fresh profile starts with no active board');
          assert.equal(await page.locator('.recent-empty').count(), 1, 'fresh profile has no restored recent board');
          return await action();
        } finally {
          if (welcomeStarted && app) await closeNormally();
          runningProfile = previousProfile;
          runningTarget = previousTarget;
          if (!app && previousTarget) await launch(options, runningProfile, previousTarget);
        }
      },
      withProfile: async (nextProfile, action) => {
        assert.equal(typeof action, 'function');
        const target = path.resolve(nextProfile);
        assert.ok(isPathWithin(root, target), 'isolated profile remains within the run temporary directory');
        const previous = runningProfile, boardBefore = runningTarget;
        if (app) await closeNormally();
        runningProfile = target;
        try {
          await fs.mkdir(target, { recursive: true });
          await launch(options, target, boardBefore);
          return await action();
        } finally {
          if (app) await closeNormally();
          runningProfile = previous;
          runningTarget = boardBefore;
          await launch(options, previous, boardBefore);
        }
      },
      readProfile: async (name) => { assert.equal(app, null, 'profile reads require a stopped app'); return fs.readFile(profileFile(name)); },
      writeProfile: async (name, bytes) => { assert.equal(app, null, 'profile writes require a stopped app'); await fs.writeFile(profileFile(name), bytes); },
    });
    evidence.networkObservation = { scope: 'startup-through-exit', complete: false, preMain: false,
      detail: 'A loopback inspector breakpoint at packaged electron/main.cjs line 3 installed native session observers before app code resumed; each launch retained the initial request buffer through normal exit.' };
    evidence.errorObservation = { scope: 'startup-through-exit', complete: false, preMain: false,
      detail: 'Pre-main uncaughtExceptionMonitor and web-contents error observers remained active through normal exit; fatal exception and rejection handling was not overridden.' };
    evidence.scenarioModules = [...SCENARIO_MANIFEST.modules];
    evidence.scenarioManifest = SCENARIO_MANIFEST;
    evidence.moduleResults = await runRequiredScenarioModules(context);
    await step('packaged app closes with exit code zero after functional checks', async () => {
      const exit = await closeNormally();
      evidence.normalQuit = hasCompleteNormalQuit(evidence.launches, evidence.processExits);
      return exit;
    });
    evidence.failureStage = 'fixture-integrity';
    const unchanged = Object.fromEntries(await Promise.all(files.map(async (file) => [path.relative(fixtureDir, file).replace(/\\/g, '/'), await fileSha(file)])));
    evidence.fixtureHashesUnchanged = JSON.stringify(unchanged) === JSON.stringify(fixtureHashes);
    assert.equal(evidence.fixtureHashesUnchanged, true, 'all registered synthetic fixtures remain byte-identical');
    evidence.screenshotManifest = screenshotManifest;
    evidence.steps = [...CHECKS];
    evidence.failures = [...FAILURES];
    evidence.failureStage = 'evidence-validation';
  } finally {
    if (app) {
      try { await withTimeout(closeNormally(), 24000, 'Final owned-process cleanup exceeded its total deadline'); }
      catch (error) {
        evidence.cleanupFailures = evidence.cleanupFailures || [];
        const exits = evidence.processExits || (evidence.processExits = []);
        if (!exits.some((entry) => entry.launch === launchNumber)) exits.push({ launch: launchNumber, exitCode: null, signal: null, forced: false });
        const launchRecord = evidence.launches?.findLast((entry) => entry.launch === launchNumber);
        if (launchRecord) launchRecord.cleanup = { ...(launchRecord.cleanup || {}), incomplete: true };
        evidence.cleanupFailures.push({ launch: launchNumber, error: cleanupErrorClass('owned-process cleanup', error),
          childExitCode: app?.process?.().exitCode ?? evidence.processExits?.findLast((entry) => entry.launch === launchNumber)?.exitCode ?? null,
          inspectorPortReleased: evidence.launches?.findLast((entry) => entry.launch === launchNumber)?.startup?.inspectorPortReleased ?? null });
        console.error(reportPrivacyActive ? 'Bug-report owned-process cleanup incomplete; details withheld.'
          : 'Owned-process cleanup incomplete; details withheld.');
      }
    }
    const pairedLaunches = evidence.launches || [];
    const exitsByLaunch = new Map((evidence.processExits || []).map((exit) => [exit.launch, exit]));
    evidence.normalQuit = hasCompleteNormalQuit(pairedLaunches, evidence.processExits);
    evidence.launchCleanup = pairedLaunches.map((entry) => ({ launch: entry.launch, pid: entry.identity?.pid ?? null,
      exit: exitsByLaunch.get(entry.launch) || null, inspectorPort: entry.startup?.inspectorPort ?? null,
      inspectorPortReleased: entry.startup?.inspectorPortReleased ?? null }));
    const after = Object.fromEntries(await Promise.all(files.map(async (file) => [path.relative(fixtureDir, file).replace(/\\/g, '/'), await fileSha(file)])));
    evidence.fixtureHashesUnchanged = JSON.stringify(after) === JSON.stringify(fixtureHashes);
    evidence.networkAttempts = NETWORK;
    snapshotErrorChannels(evidence);
    deriveFinalObservations(evidence);
    evidence.steps = CHECKS;
    evidence.failures = FAILURES;
    evidence.screenshotManifest = screenshotManifest;
    if (evidence.fixtureHashesUnchanged !== true) evidence.status = 'fail';
    if (process.env.TRACE_QA_KEEP_PROFILE !== '1') await fs.rm(root, { recursive: true, force: true });
  }
  await verifyScreenshotManifest(screenshotsDir, screenshotManifest);
  finalizeEvidence(evidence, screenshotManifest);
}

function hasCompleteNormalQuit(launches, processExits) {
  if (!Array.isArray(launches) || launches.length < 3 || !Array.isArray(processExits) || processExits.length !== launches.length) return false;
  const launchIds = launches.map((entry) => entry.launch);
  const exitIds = processExits.map((entry) => entry.launch);
  if (launchIds.some((id) => !Number.isSafeInteger(id)) || new Set(launchIds).size !== launchIds.length
    || exitIds.some((id) => !Number.isSafeInteger(id)) || new Set(exitIds).size !== exitIds.length) return false;
  return launches.every((launch) => {
    const matches = processExits.filter((exit) => exit.launch === launch.launch);
    return matches.length === 1 && launch.exit?.launch === launch.launch && launch.exit?.exitCode === 0
      && launch.exit?.signal === null && launch.exit?.forced === false && matches[0].exitCode === 0
      && matches[0].signal === null && matches[0].forced === false && isDeepStrictEqual(matches[0], launch.exit)
      && launch.startup?.inspectorPortReleased === true;
  });
}

function deriveFinalObservations(report) {
  const launches = report.launches;
  const channelsClear = ['pageErrors', 'consoleErrors', 'cspErrors'].every((name) => Array.isArray(report[name]) && report[name].length === 0);
  const launchProofsComplete = Array.isArray(launches) && launches.length > 0 && launches.every((launch) =>
    launch.startup?.installedBeforeReady === true
    && launch.startupObservation?.installedBeforeReady === true
    && launch.startupObservation?.willQuitCaptured === true
    && Number.isSafeInteger(launch.startupObservation?.finalNetworkCount)
    && Array.isArray(launch.networkAttempts)
    && launch.startupObservation.finalNetworkCount === launch.networkAttempts.length
    && launch.startupObservation.finalErrors === 0
    && Number.isSafeInteger(launch.startupObservation.sessions)
    && launch.startupObservation.sessions >= 1
    && launch.startup?.inspectorPortReleased === true
    && Array.isArray(launch.mainErrors) && launch.mainErrors.length === 0
    && ['pageErrors', 'consoleErrors', 'cspErrors'].every((name) => Array.isArray(launch[name]) && launch[name].length === 0));
  const networkReconciles = Array.isArray(report.networkAttempts) && Array.isArray(launches)
    && isDeepStrictEqual(report.networkAttempts, launches.flatMap((launch) => Array.isArray(launch.networkAttempts) ? launch.networkAttempts : []));
  const complete = launchProofsComplete && channelsClear && networkReconciles
    && hasCompleteNormalQuit(launches, report.processExits);
  for (const name of ['networkObservation', 'errorObservation']) {
    if (report[name]) {
      report[name].scope = 'startup-through-exit';
      report[name].preMain = Array.isArray(launches) && launches.length > 0
        && launches.every((launch) => launch.startup?.installedBeforeReady === true);
      report[name].complete = complete;
    }
  }
  return complete;
}

function finalizeEvidence(report, screenshots) {
  report.status = 'pass';
  const manifestProblems = validateEvidenceManifest(report, screenshots);
  report.manifestProblems = manifestProblems;
  if (manifestProblems.length) {
    report.status = 'hold';
    throw new Error('Evidence manifest failed closed: ' + manifestProblems.join('; '));
  }
  return report;
}

function createEvidenceEnvelope(argv) {
  return { schema: 'trace-packaged-functional-qa/1', startedAt: new Date().toISOString(), status: 'fail', failureStage: 'argument-validation',
    steps: [], failures: [], processExits: [], screenshots: [], screenshotManifest: [], fixtureHashesUnchanged: false, networkAttempts: [],
    networkObservation: { scope: 'not-started', complete: false }, output: requestedOutput(argv) };
}

function snapshotErrorChannels(report, channels = { pageErrors: PAGE_ERRORS, consoleErrors: CONSOLE_ERRORS, cspErrors: CSP_ERRORS }) {
  for (const name of ['pageErrors', 'consoleErrors', 'cspErrors']) {
    assert.ok(Array.isArray(channels[name]), `live ${name} channel is an array`);
    report[name] = channels[name].slice();
  }
  return report;
}

function requestedOutput(argv) {
  const arg = argv.find((value) => value.startsWith('--out='));
  if (!arg) return null;
  const value = arg.slice('--out='.length);
  return value && path.isAbsolute(value) ? path.resolve(value) : null;
}

async function writeEvidence(filename) {
  if (!filename || !evidence) return false;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, JSON.stringify(evidence, null, 2) + '\n');
  return true;
}

async function main(argv = process.argv) {
  evidence = createEvidenceEnvelope(argv);
  try {
    const options = parseArgs(argv);
    evidence.output = options.out;
    evidence.failureStage = 'artifact-validation';
    evidence.expected = { os: options.os, arch: options.arch, version: options.version };
    evidence.paths = { executable: path.basename(options.executable), asar: path.basename(options.asar), artifact: path.basename(options.artifact),
      checksum: path.basename(options.checksum), output: path.basename(options.out) };
    const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    evidence.sourceSha = source.status === 0 ? source.stdout.trim() : process.env.GITHUB_SHA || 'unknown';
    for (const key of ['executable', 'asar', 'artifact', 'checksum']) {
      const stat = await fs.stat(options[key]);
      assert.ok(stat.isFile(), `${key} is a file`);
    }
    evidence.artifact = await captureArtifact(options);
    Object.assign(evidence, { runtime: null, profileIsolated: true, sessionCacheOnly: true, providerUrlsVisited: null, normalQuit: false });
    await writeEvidence(options.out);
    evidence.failureStage = 'functional-run';
    await runFunctional(options);
    if (evidence.status !== 'pass') throw new Error('functional run did not satisfy the required evidence manifest');
  } catch (error) {
    if (evidence.status !== 'hold') evidence.status = 'fail';
    const reportFailure = reportPrivacyActive || /^functional-step:(?:bug report|support reminder report)/i.test(evidence.failureStage || '');
    evidence.failure = { stage: evidence.failureStage,
      message: reportFailure ? 'Bug-report acceptance failed; input, preview and renderer diagnostic text was withheld.' : error && error.message || String(error),
      stack: reportFailure ? '[redacted bug-report diagnostic]' : String(error && error.stack || error) };
    evidence.failures = [...(evidence.failures || []), { name: evidence.failureStage,
      message: reportFailure ? 'Bug-report acceptance failed; details withheld.' : error && error.message || String(error) }];
    process.exitCode = 1;
  } finally {
    const output = evidence.output || requestedOutput(argv);
    try { await writeEvidence(output); }
    catch (error) { console.error(reportPrivacyActive ? 'Could not write bug-report failure evidence; details withheld.'
      : 'Could not write failure evidence: ' + (error && error.message || error)); process.exitCode = 2; }
  }
}

if (require.main === module) main().catch((error) => {
  if (reportPrivacyActive || /^functional-step:(?:bug report|support reminder report)/i.test(evidence?.failureStage || '')) console.error('Bug-report acceptance failed; diagnostic text withheld.');
  else console.error(error.stack || error);
  process.exitCode = 2;
});
module.exports = Object.freeze({ parseArgs, boardText, ascFiles, assertPayloadManifest, supportStatusStrings, LANGUAGES,
  canonicalIdentity, appImageMode, inspectFuses, fileSha, normalizeBoardExpectation, isPathWithin, registerFixtureFile, validateEvidenceManifest, finalizeEvidence, createEvidenceEnvelope, snapshotErrorChannels, listenForErrors, waitForProcessObserverMarker, verifyScreenshotManifest, strictContext, runRequiredScenarioModules, recordStep: step,
  collectFailureDiagnostics, collectShutdownEvidence, deriveFinalObservations, hasCompleteNormalQuit, createObserverMarkerAccumulator, __testCloseNormally,
  settleStartupSupportNotice, SCENARIO_MANIFEST, REQUIRED_MODULES, REQUIRED_SCREENSHOTS, main });
