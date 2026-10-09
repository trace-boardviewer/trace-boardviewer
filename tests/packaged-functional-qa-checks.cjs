'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { parseArgs, boardText, ascFiles, assertPayloadManifest, supportStatusStrings, LANGUAGES, canonicalIdentity, appImageMode,
  normalizeBoardExpectation, isPathWithin, registerFixtureFile, validateEvidenceManifest, finalizeEvidence, createEvidenceEnvelope, snapshotErrorChannels,
  waitForProcessObserverMarker, verifyScreenshotManifest, strictContext, runRequiredScenarioModules, settleStartupSupportNotice, listenForErrors,
  collectFailureDiagnostics, collectShutdownEvidence, deriveFinalObservations, hasCompleteNormalQuit, createObserverMarkerAccumulator, __testCloseNormally,
  recordStep, SCENARIO_MANIFEST, REQUIRED_SCREENSHOTS } = require('../scripts/packaged-functional-qa.cjs');
const inspector = require('../scripts/packaged-functional-inspector.cjs');

const qaRoot = path.join(os.tmpdir(), 'trace packaged functional qa');
const SUPPORT_NOTICE = '[data-testid=support-notice]';
const SUPPORT_SKIP = `${SUPPORT_NOTICE} [data-testid=support-not-now]`;
const base = [
  'node', 'scripts/packaged-functional-qa.cjs',
  `--executable=${path.join(qaRoot, 'TRACE Boardviewer')}`,
  `--asar=${path.join(qaRoot, 'resources', 'app.asar')}`,
  `--artifact=${path.join(qaRoot, 'TRACE-Boardviewer-1.3.1-rc.2.package')}`,
  `--checksum=${path.join(qaRoot, 'TRACE-Boardviewer-1.3.1-rc.2.package.sha256')}`,
  '--version=1.3.1-rc.2', `--os=${process.platform}`, `--arch=${process.arch}`, `--out=${path.join(qaRoot, 'evidence.json')}`,
];

test('functional runner accepts an explicitly identified prerelease package and host-native absolute paths', () => {
  const result = parseArgs(base);
  assert.equal(result.version, '1.3.1-rc.2');
  assert.equal(result.os, process.platform);
  assert.equal(result.arch, process.arch);
  for (const name of ['executable', 'asar', 'artifact', 'checksum', 'out']) {
    assert.ok(path.isAbsolute(result[name]), `${name} uses an absolute ${process.platform} path`);
  }
});

test('functional runner fails closed for missing identity and relative artifact paths', () => {
  assert.throws(() => parseArgs(['node', 'script']), /Required option missing/);
  assert.throws(() => parseArgs(base.map((item) => item.startsWith('--asar=') ? '--asar=resources/app.asar' : item)), /absolute path/);
});

test('functional runner rejects a package identity for a different host OS', () => {
  const otherPlatform = ['win32', 'darwin', 'linux'].find((platform) => platform !== process.platform);
  assert.ok(otherPlatform);
  assert.throws(() => parseArgs(base.map((item) => item.startsWith('--os=') ? `--os=${otherPlatform}` : item)), /does not match this runner/);
});

test('runtime identity comparison follows Windows and POSIX realpath rules', () => {
  const resolved = (value) => value.replace('/Alias/', '/Canonical/');
  assert.equal(canonicalIdentity('/tmp/Case/profile', '/tmp/case/profile', 'linux', resolved), false, 'POSIX case-distinct profiles are not equal');
  assert.equal(canonicalIdentity('/tmp/Case/profile', '/tmp/case/profile', 'darwin', resolved), false, 'case-sensitive macOS volumes preserve case');
  assert.equal(canonicalIdentity('C:/Users/Alias/profile', 'c:/users/Canonical/profile', 'win32', resolved), true, 'Windows identity resolves aliases then folds case');
  assert.equal(canonicalIdentity('/var/tmp/profile', '/private/var/tmp/profile', 'darwin', (value) => value.startsWith('/var/') ? '/private' + value : value), true, 'macOS /var aliases compare by canonical path');
});

test('runtime identity and fixture containment helpers accept real canonical paths through a symlink alias', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-qa-canonical-path-'));
  const fixtureRoot = path.join(directory, 'fixtures');
  const aliasRoot = path.join(directory, 'fixture-alias');
  const aliasSubdir = path.join(aliasRoot, 'nested');
  try {
    await fs.mkdir(path.join(fixtureRoot, 'nested'), { recursive: true });
    try { await fs.symlink(fixtureRoot, aliasRoot, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) return t.skip(`directory symlinks are unavailable on this host (${error.code})`);
      throw error;
    }
    const canonicalAliasRoot = await fs.realpath(aliasRoot);
    const canonicalParent = await fs.realpath(aliasSubdir);
    assert.equal(isPathWithin(aliasRoot, canonicalParent), false, 'a lexical symlink root does not contain its canonical spelling');
    assert.equal(isPathWithin(canonicalAliasRoot, canonicalParent), true, 'a canonical fixture root contains its canonical child');
    const registered = [], hashes = {};
    const rootRegistered = await registerFixtureFile(aliasRoot, 'root-level.cad', 'root fixture', registered, hashes);
    assert.equal(await fs.readFile(rootRegistered, 'utf8'), 'root fixture', 'the live helper accepts an ordinary root-level fixture through a symlinked root');
    assert.equal(hashes['root-level.cad'], crypto.createHash('sha256').update('root fixture').digest('hex'));
    const registeredPath = await registerFixtureFile(aliasRoot, 'nested/registered.cad', Buffer.from('synthetic'), registered, hashes);
    assert.deepEqual(registered, [rootRegistered, registeredPath], 'the live fixture registration helper accepts root and nested files through a symlinked fixture root');
    assert.equal(hashes['nested/registered.cad'], crypto.createHash('sha256').update('synthetic').digest('hex'));
    assert.equal(canonicalIdentity(aliasSubdir, path.join(fixtureRoot, 'nested'), process.platform,
      (filename) => fsSync.realpathSync.native(filename)), true, 'the runtime identity helper compares two real aliases using node:fs realpathSync.native');

    const outside = path.join(directory, 'outside');
    await fs.mkdir(outside);
    const escape = path.join(fixtureRoot, 'escape');
    await fs.symlink(outside, escape, 'junction');
    assert.equal(isPathWithin(canonicalAliasRoot, await fs.realpath(escape)), false, 'canonical fixture containment rejects a link that escapes the fixture root');
    await assert.rejects(() => registerFixtureFile(aliasRoot, 'escape/leaked.cad', 'synthetic', registered, hashes), /resolves inside/,
      'the live fixture registration helper rejects a canonical parent outside the fixture root');
    await assert.rejects(() => registerFixtureFile(aliasRoot, '../outside.cad', 'synthetic', registered, hashes), /stays inside/,
      'the live fixture registration helper rejects lexical traversal before writing');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('board wait contract normalizes arrays and strict count objects with optional identity', () => {
  assert.deepEqual(normalizeBoardExpectation([3, 6, 2]), { components: 3, pins: 6, nets: 2 });
  assert.deepEqual(normalizeBoardExpectation({ components: 1, pins: 1, nets: 1, title: 'Board', target: 'board.cad', nativeKey: 'board.cad' }),
    { components: 1, pins: 1, nets: 1, title: 'Board', target: 'board.cad', nativeKey: 'board.cad' });
  assert.throws(() => normalizeBoardExpectation({ components: '3', pins: 6, nets: 2 }), /components expectation/);
  assert.throws(() => normalizeBoardExpectation({ components: 3, pins: 6 }), /pins|nets expectation/);
  assert.equal(isPathWithin('/fixtures', '/fixtures/board.cad'), true);
  assert.equal(isPathWithin('/fixtures', '/fixtures-other/board.cad'), false);
});

test('scenario modules run against the live app before the final normal-quit assertion', () => {
  const source = fsSync.readFileSync(path.resolve(__dirname, '../scripts/packaged-functional-qa.cjs'), 'utf8');
  assert.ok(source.indexOf('evidence.moduleResults = await runRequiredScenarioModules(context)') < source.indexOf("step('packaged app closes with exit code zero after functional checks'"));
  assert.match(source, /Buffer\.isBuffer\(bytes\) \|\| bytes instanceof Uint8Array/);
  assert.match(source, /withOpenDialog: async \(paths, action\)/);
  assert.match(source, /withSaveDialog: async \(destination, action\)/);
  assert.match(source, /const target = runningTarget; await closeNormally\(\); await launch\(options, runningProfile, target\)/);
});

test('pre-main inspector contract installs persistent request and error observers before app code', async () => {
  const source = fsSync.readFileSync(path.resolve(__dirname, '../scripts/packaged-functional-qa.cjs'), 'utf8');
  const premain = fsSync.readFileSync(path.resolve(__dirname, '../scripts/packaged-functional-inspector.cjs'), 'utf8');
  const mainHeader = fsSync.readFileSync(path.resolve(__dirname, '../electron/main.cjs'), 'utf8').split(/\r?\n/);
  assert.equal(mainHeader[2], "const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell } = require('electron');",
    'the public Electron main header keeps the first require on the frozen pre-main breakpoint line');
  assert.match(source, /launchWithPreMainObservers/);
  assert.match(premain, /__traceQaNetwork=\[\]/);
  assert.match(premain, /request\.onBeforeRequest/);
  assert.match(premain, /listener\(details,finish\)/, 'the production request callback still runs through the composed observer');
  assert.match(premain, /args\.find\(value=>value&&value\.webRequest/, 'session-created events support Electron event signatures before creating a partition');
  assert.match(premain, /originalFromPartition=e\.session\.fromPartition\.bind/);
  assert.match(premain, /labels\.set\(value,String\(partition\|\|'default'\)\)/, 'late-bound session labels preserve partition identity after creation');
  assert.match(premain, /const label=labels\.get\(value\)\|\|'session'/, 'request callbacks read the current label instead of closing over a stale one');
  assert.match(premain, /labels\.set\(e\.session\.defaultSession,'default'\)/);
  assert.match(premain, /e\.app\.on\('ready'.*labels\.set\(e\.session\.defaultSession,'default'\)/s, 'the default session is identified only after app.ready');
  assert.doesNotMatch(premain, /session\.getPartition\(/, 'Electron Session is not assumed to expose getPartition');
  assert.doesNotMatch(source, /__traceQaNetwork\s*=\s*\[\]/, 'post-launch attachment never resets requests captured before Playwright connects');
  assert.match(premain, /uncaughtExceptionMonitor/);
  assert.doesNotMatch(premain, /unhandledRejection/);
  assert.doesNotMatch(source + premain, /egress\.fetch\s*=/, 'production session.fetch remains the transport under test');
  assert.match(premain, /chromiumSandbox:\s*true/);
  assert.match(source, /canonicalIdentity\(options\.executable, options\.artifact, options\.os\)/, 'AppImage mode is tied to the exact wrapper argument');
  assert.match(source, /process\.env\.APPIMAGE/);
  assert.equal(inspector.MAIN_ENTRY, 'app.asar/electron/main.cjs');
  assert.equal(inspector.MAIN_LINE, 3);
  assert.equal(inspector.isMainEntryFrame({ url: 'file:///tmp/resources/app.asar/electron/main.cjs' }), true);
  assert.equal(inspector.isMainEntryFrame({ url: 'file:///tmp/resources/app.asar/electron/other.cjs' }), false);
  assert.equal(appImageMode({ os: 'linux', artifact: '/tmp/TRACE.AppImage' }), true);
  assert.equal(appImageMode({ os: 'linux', artifact: '/tmp/package.deb' }), false);
  assert.equal(appImageMode({ os: 'win32', artifact: 'TRACE.AppImage' }), false);
  assert.match(inspector.observerExpression(), /uncaughtExceptionMonitor/);
  assert.match(inspector.observerExpression(), /will-quit/);
  assert.equal(await inspector.waitForPortRelease(await inspector.reserveInspectorPort()), true, 'the reserved loopback port is released');
});

test('report discard and privacy cleanup explicitly leave the dirty session before detaching', () => {
  const source = fsSync.readFileSync(path.resolve(__dirname, '../scripts/packaged-functional/bug-reports.cjs'), 'utf8');
  const discarded = source.slice(source.indexOf("await welcome.locator('[data-testid=bug-report-discard-draft]')"), source.indexOf("'bug report context remains mounted"));
  assert.match(discarded, /bug-report-cancel[\s\S]*?\[role=alertdialog\][\s\S]*?bug-report-leave[\s\S]*?state: 'detached'/,
    'clearing the saved journal is followed by the real Leave decision for the still-dirty session description');
  const privacy = source.slice(source.indexOf('user-selected privacy cleanup removes'), source.indexOf('evidence.bugReportObserver.localAcceptance'));
  assert.match(privacy, /bug-report-cancel[\s\S]*?\[role=alertdialog\][\s\S]*?bug-report-leave[\s\S]*?state: 'detached'/,
    'removing sensitive text does not silently discard the remaining nonempty description');
  assert.match(discarded, /getBugReportDraft\?\.\(\)\)\?\.status === 'empty'/,
    'the separate empty saved-journal proof remains in place');
});

test('Windows QA refuses an unpacked executable or ASAR that differs from its portable payload manifest', () => {
  const manifest = { schema: 'trace-payload-manifest/1', exeSha256: 'a'.repeat(64), asarSha256: 'b'.repeat(64), manifestDigest: 'c'.repeat(64), fileCount: 2, totalBytes: 3 };
  assert.deepEqual(assertPayloadManifest(manifest, { executableSha256: 'a'.repeat(64), asarSha256: 'b'.repeat(64) }), {
    digest: manifest.manifestDigest, files: 2, bytes: 3,
  });
  assert.throws(() => assertPayloadManifest(manifest, { executableSha256: 'd'.repeat(64), asarSha256: 'b'.repeat(64) }), /runtime executable matches/);
  assert.throws(() => assertPayloadManifest(manifest, { executableSha256: 'a'.repeat(64), asarSha256: 'd'.repeat(64) }), /app\.asar matches/);
});

test('required scenario context rejects missing helpers and unexpected helpers', () => {
  const helpers = Object.fromEntries(['getPage', 'getApp', 'step', 'registerFixture', 'openFiles', 'waitBoard', 'setLanguage', 'deliverSyntheticBoard', 'dismissSupport', 'screenshot', 'main',
    'withProfile', 'withWelcome', 'restart', 'readProfile', 'writeProfile', 'withOpenDialog', 'withSaveDialog'].map((key) => [key, () => {}]));
  assert.equal(Object.isFrozen(strictContext(helpers)), true);
  assert.throws(() => strictContext({ ...helpers, restart: undefined }), /required scenario context helper restart/);
  assert.throws(() => strictContext({ ...helpers, maybeSkip: true }), /unexpected scenario context helper/);
});

function startupNoticePage({ notice = false, noticeDelay = null, documentKey = 'document-1', blockedClick = false } = {}) {
  const state = { titlebar: true, notice, button: notice, supportButton: true, ordinarySkip: false, documentKey };
  const locatorCalls = [];
  const clickTimeouts = [];
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const matches = (selector, requested) => {
    if (selector === '.app-titlebar') return state.titlebar === (requested === 'visible');
    if (selector === '[data-testid=support-notice]') return state.notice === (requested === 'visible');
    if (selector === '[data-testid=support-notice] [data-testid=support-not-now]') return state.button === (requested === 'visible');
    if (selector === '[data-testid=support-button]') return state.supportButton === (requested === 'visible');
    throw new Error(`unexpected startup notice selector: ${selector}`);
  };
  return {
    locatorCalls,
    clickTimeouts,
    state,
    evaluate: async () => ({ url: 'file:///app/index.html', key: state.documentKey, ordinarySkip: state.ordinarySkip }),
    ordinarySkip() { state.ordinarySkip = true; state.notice = false; state.button = false; },
    reload({ notice: nextNotice = false } = {}) {
      state.documentKey += '-reload'; state.ordinarySkip = false;
      state.notice = nextNotice; state.button = nextNotice;
    },
    showNotice() { state.notice = true; state.button = true; },
    locator(selector) {
      return {
        isVisible: async () => matches(selector, 'visible'),
        waitFor: async ({ state: requested, timeout }) => {
          locatorCalls.push({ selector, state: requested });
          const deadline = Date.now() + timeout;
          while (!matches(selector, requested)) {
            if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${selector} to become ${requested}`);
            await delay(2);
          }
        },
        click: async (options = {}) => {
          clickTimeouts.push(options.timeout);
          if (blockedClick) return new Promise(() => {});
          state.notice = false; state.button = false; state.ordinarySkip = true;
        },
      };
    },
  };
}

test('fresh startup waits for a delayed normal notice and clicks its visible Skip button', async () => {
  const page = startupNoticePage({ noticeDelay: 15 });
  setTimeout(() => page.showNotice(), 15);
  const settlement = settleStartupSupportNotice(page, 250);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(page.locatorCalls.map(({ selector, state }) => [selector, state]), [[SUPPORT_NOTICE, 'visible']],
    'a fresh document waits only for its delayed ordinary notice');
  assert.deepEqual(await settlement, { status: 'dismissed' });
  assert.deepEqual(page.locatorCalls.map(({ selector, state }) => [selector, state]), [
    [SUPPORT_NOTICE, 'visible'],
    [SUPPORT_SKIP, 'visible'],
    [SUPPORT_NOTICE, 'detached'],
  ]);
});

test('an ordinary Skip from another scenario settles repeatedly only in its current document', async () => {
  const page = startupNoticePage();
  page.ordinarySkip();
  assert.deepEqual(await settleStartupSupportNotice(page, 250), { status: 'already-dismissed' });
  assert.deepEqual(await settleStartupSupportNotice(page, 250), { status: 'already-dismissed' }, 'the observed Skip remains valid for this document');
  page.reload({ notice: true });
  assert.deepEqual(await settleStartupSupportNotice(page, 250), { status: 'dismissed' }, 'a new document does not inherit the prior Skip');
  assert.equal(page.state.notice, false);
});

test('a notice that unexpectedly reappears after an ordinary Skip is still closed', async () => {
  const page = startupNoticePage({ notice: true });
  assert.deepEqual(await settleStartupSupportNotice(page, 250), { status: 'dismissed' });
  page.showNotice();
  assert.deepEqual(await settleStartupSupportNotice(page, 250), { status: 'dismissed' });
  assert.equal(page.state.notice, false);
});

test('missing fresh notice fails closed even when given a fabricated bootstrap observation', async () => {
  const missingNotice = startupNoticePage();
  const fabricatedBootstrapObservation = { source: 'renderer-bootstrap', documentKey: 'document-1',
    request: { id: 1, senderId: 2, frameUrl: 'file:///app/index.html' },
    reply: { status: 'verified', expiresAt: Date.now() + 60_000, available: true }, committedRender: true };
  await assert.rejects(settleStartupSupportNotice(missingNotice, 25, { bootstrapObservation: fabricatedBootstrapObservation }), (error) => {
    assert.ok([
      'Timed out waiting for [data-testid=support-notice] to become visible',
      'fresh support notice did not settle before the startup support deadline',
    ].includes(error.message), `unexpected fresh-notice failure phase: ${error.message}`);
    return true;
  });
  assert.deepEqual(missingNotice.locatorCalls.map(({ selector, state }) => [selector, state]), [[SUPPORT_NOTICE, 'visible']]);
  assert.deepEqual(missingNotice.clickTimeouts, [], 'a fabricated bootstrap observation cannot authorize a Skip click');
  assert.equal(missingNotice.state.notice, false, 'a fabricated bootstrap observation cannot settle an absent notice');
});

test('a blocked Skip click fails within the shared startup settlement deadline', async () => {
  const page = startupNoticePage({ notice: true, blockedClick: true });
  const started = Date.now();
  await assert.rejects(settleStartupSupportNotice(page, 30), /support notice Skip click did not settle before the startup support deadline/);
  assert.ok(Date.now() - started < 150, 'a blocked click cannot outlive the promised deadline');
  assert.ok(page.clickTimeouts[0] > 0 && page.clickTimeouts[0] <= 30, 'Playwright receives the remaining overall deadline');
});

test('required scenario modules run sequentially and missing or assertion-free modules fail closed', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-qa-modules-'));
  const order = [];
  const context = { step: async (name, action) => { order.push(name); return require('../scripts/packaged-functional-qa.cjs').recordStep(name, action || (async () => null)); } };
  try {
    for (const id of SCENARIO_MANIFEST.modules) {
      await fs.writeFile(path.join(directory, id + '.cjs'), `exports.run = async (ctx) => { await ctx.step(${JSON.stringify(id)}); return ${JSON.stringify(id)}; };\n`);
    }
    const results = await runRequiredScenarioModules(context, directory);
    assert.deepEqual(order, [...SCENARIO_MANIFEST.modules]);
    assert.deepEqual(results.map((entry) => entry.id), [...SCENARIO_MANIFEST.modules]);
    assert.ok(results.every((entry) => entry.steps === 1));
    await fs.writeFile(path.join(directory, 'viewers.cjs'), 'exports.run = async () => undefined;\n');
    await assert.rejects(() => runRequiredScenarioModules(context, directory), /recorded at least one assertion/);
    await fs.writeFile(path.join(directory, 'viewers.cjs'), `exports.run = async (ctx) => { await ctx.step('viewers'); };\n`);
    await fs.rm(path.join(directory, 'workspaces.cjs'));
    await assert.rejects(() => runRequiredScenarioModules(context, directory), /required scenario module workspaces is present/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('evidence validator requires startup coverage, exact launch identity, normal exits and mandatory screenshots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-qa-evidence-'));
  try {
    const screenshots = [];
    for (const name of REQUIRED_SCREENSHOTS) {
      const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(name)]);
      await fs.writeFile(path.join(dir, name), bytes);
      screenshots.push({ name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), signature: 'png' });
    }
    const sha = 'a'.repeat(64);
    const initialEnvelope = createEvidenceEnvelope(['node', 'qa', '--out=' + path.join(dir, 'report.json')]);
    assert.equal(initialEnvelope.status, 'fail');
    assert.equal(Object.hasOwn(initialEnvelope, 'pageErrors'), false, 'the production initial envelope does not fabricate final global snapshots');
    const report = Object.assign(initialEnvelope, { sourceSha: 'source-sha',
      artifact: { sha256: sha, executableSha256: sha, asarSha256: sha, payloadLinkage: { fuses: { configured: {}, observed: {} } } },
      runtime: { isPackaged: true, executableSha256: sha, asarSha256: sha },
      launches: [1, 2, 3].map((launch) => ({ launch, startup: { marker: inspector.MAIN_ENTRY, line: inspector.MAIN_LINE, installedBeforeReady: true, inspectorPort: 43210 + launch, inspectorPortReleased: true },
        startupObservation: { installedBeforeReady: true, willQuitCaptured: true, cancelledRequests: true, finalNetworkCount: 0, finalErrors: 0, finalExternalIntents: 0 }, mainErrors: [], externalIntents: [],
        identity: { isPackaged: true, executableSha256: sha, asarSha256: sha }, networkAttempts: [], pageErrors: [], consoleErrors: [], cspErrors: [], exit: { launch, exitCode: 0, signal: null, forced: false } })),
      networkObservation: { scope: 'startup-through-exit', complete: true, preMain: true }, errorObservation: { scope: 'startup-through-exit', complete: true, preMain: true }, normalQuit: true,
      processExits: [1, 2, 3].map((launch) => ({ launch, exitCode: 0, signal: null, forced: false })),
      fixtureHashesUnchanged: true, steps: [...SCENARIO_MANIFEST.coreSteps, ...SCENARIO_MANIFEST.modules.map((id) => ({ name: `${id} synthetic assertion`, status: 'pass' }))].map((entry) => typeof entry === 'string' ? ({ name: entry, status: 'pass' }) : entry),
      scenarioManifest: SCENARIO_MANIFEST, scenarioModules: [...SCENARIO_MANIFEST.modules],
      moduleResults: SCENARIO_MANIFEST.modules.map((id, index) => ({ id, stepStart: SCENARIO_MANIFEST.coreSteps.length + index, stepEnd: SCENARIO_MANIFEST.coreSteps.length + index + 1, steps: 1, completed: true })) });
    const supportDenial = { session: 'trace-egress', url: 'https://trace-support.trace-boardviewer.workers.dev/receipt?claim=synthetic',
      method: 'GET', cancelledBeforeNetwork: true, source: 'Electron webRequest pre-main observer' };
    const reportAction = { launch: 2, actionID: 'bug-report-send-a', reportId: '3b241e0b-b013-4a53-8f1d-000000000001',
      bytes: 64, sha256: 'b'.repeat(64), acknowledgement: 'received' };
    const reportB = { launch: 2, actionID: 'bug-report-send-b', reportId: '3b241e0b-b013-4a53-8f1d-000000000002',
      bytes: 65, sha256: 'c'.repeat(64), acknowledgement: 'uncertain' };
    const retryB = { ...reportB, launch: 3, actionID: 'bug-report-send-b-retry', acknowledgement: 'received' };
    const reportAttempt = { targetID: 'bug-report-receiver', method: 'POST', bytes: reportAction.bytes, sha256: reportAction.sha256,
      actionID: reportAction.actionID, decision: 'allow' };
    const responseRecord = { actionID: reportB.actionID, mode: 'hold-and-cancel', phase: 'cancelled', outcome: 'cancelled', statusCode: 200 };
    const cancelOracle = { actionID: reportB.actionID, cancelAccepted: true, sendTerminalUncertain: true, heldAtCancelAccepted: true,
      heldAtSendTerminal: true, cancelRequestMatchesSend: true, cancelOutcome: 'accepted', sendOutcome: 'uncertain', generation: 1 };
    const observer = (allowedCount, gateArms, attempts = [], responses = [], cancelOracles = [], responseArms = 0) => {
      const value = { version: 2, allowedCount, deniedCount: 0, gateArms, gateFailures: 0, responseArms, responseFailures: 0 };
      return { ...value, attempts, responses, cancelOracles, finalMarker: { ...value, attempts, responses, cancelOracles } };
    };
    for (const launch of report.launches) {
      launch.reportObserver = observer(0, 0);
      launch.reportObserverCaptureValid = true;
      launch.startupObservation.reportObserver = { version: 2, allowedCount: 0, deniedCount: 0, gateArms: 0, gateFailures: 0, responseArms: 0, responseFailures: 0 };
    }
    report.launches[0].externalIntents = ['https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00','https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00'];
    report.launches[0].startupObservation.finalExternalIntents = 2;
    report.launches[0].networkAttempts = [supportDenial];
    report.launches[0].startupObservation.finalNetworkCount = 1;
    report.launches[0].reportObserver = observer(0, 0);
    report.launches[0].reportObserverCaptureValid = true;
    const attemptA = { ...reportAttempt, actionID: reportAction.actionID, bytes: reportAction.bytes, sha256: reportAction.sha256 };
    const attemptB = { ...reportAttempt, actionID: reportB.actionID, bytes: reportB.bytes, sha256: reportB.sha256 };
    const attemptRetry = { ...reportAttempt, actionID: retryB.actionID, bytes: retryB.bytes, sha256: retryB.sha256 };
    report.launches[1].networkAttempts = [attemptA, attemptB];
    report.launches[1].startupObservation.finalNetworkCount = 2;
    report.launches[1].startupObservation.cancelledRequests = false;
    report.launches[1].reportObserver = observer(2, 2, [attemptA, attemptB], [responseRecord], [cancelOracle], 1);
    report.launches[1].reportObserverCaptureValid = true;
    report.launches[1].startupObservation.reportObserver = { version: 2, allowedCount: 2, deniedCount: 0, gateArms: 2, gateFailures: 0, responseArms: 1, responseFailures: 0 };
    report.launches[2].networkAttempts = [attemptRetry];
    report.launches[2].startupObservation.finalNetworkCount = 1;
    report.launches[2].startupObservation.cancelledRequests = false;
    report.launches[2].reportObserver = observer(1, 1, [attemptRetry]);
    report.launches[2].reportObserverCaptureValid = true;
    report.launches[2].startupObservation.reportObserver = { version: 2, allowedCount: 1, deniedCount: 0, gateArms: 1, gateFailures: 0, responseArms: 0, responseFailures: 0 };
    report.networkAttempts = report.launches.flatMap((launch) => launch.networkAttempts);
    report.bugReportObserver = { schema: 'trace-packaged-bug-report-observer/2', completed: true, actions: [reportAction,reportB,retryB], responses: [responseRecord],
      localAcceptance: { completed: true, localPostCount: 0, localIntentCount: 0, localActions: true, locales: ['hu','en','de','fr','it','sk','pl','uk'] },
      syntheticDelivery: { completed: true, injectedNativeEvent: true, sameDialogPreserved: true, originalContextPreserved: true, reopenContextChanged: true },
      finalObserver: { version: 2, allowedCount: 3, deniedCount: 0, gateArms: 3, gateFailures: 0, responseArms: 1, responseFailures: 0 } };
    assert.ok(validateEvidenceManifest(report, screenshots).some((problem) => /global pageErrors observation is missing/.test(problem)),
      'the actual initial envelope shape remains incomplete until finalization snapshots live errors');
    snapshotErrorChannels(report, { pageErrors: [], consoleErrors: [], cspErrors: [] });
    assert.equal(finalizeEvidence(report, screenshots), report, 'the production finalizer changes an in-progress fail status to pass only after full validation');
    assert.equal(report.status, 'pass');
    assert.deepEqual(report.manifestProblems, []);
    assert.equal(await verifyScreenshotManifest(dir, screenshots), true);
    const expectRejected = (candidate, pattern) => assert.ok(validateEvidenceManifest(candidate, screenshots).some((problem) => pattern.test(problem)), `expected rejection matching ${pattern}`);
    for (const field of ['signal', 'forced']) {
      const candidate = structuredClone(report);
      delete candidate.launches[0].exit[field];
      expectRejected(candidate, /launches lack complete/);
      const processCandidate = structuredClone(report);
      delete processCandidate.processExits[0][field];
      expectRejected(processCandidate, /normal process exits are incomplete/);
    }
    {
      const candidate = structuredClone(report);
      candidate.launches[1].launch = candidate.launches[0].launch;
      expectRejected(candidate, /launch identifiers are not unique/);
      const duplicateExit = structuredClone(report);
      duplicateExit.processExits[1].launch = duplicateExit.processExits[0].launch;
      expectRejected(duplicateExit, /process exit launch identifiers are not unique/);
      const mismatch = structuredClone(report);
      mismatch.processExits[0].exitCode = 1;
      expectRejected(mismatch, /normal process exits are incomplete/);
      const mismatchedLaunchExit = structuredClone(report);
      mismatchedLaunchExit.launches[0].exit.launch = 99;
      expectRejected(mismatchedLaunchExit, /lack exactly one matching normal process exit/);
      const fewer = structuredClone(report);
      fewer.processExits.pop();
      expectRejected(fewer, /process exit count does not match launch count/);
    }
    for (const observer of ['networkObservation', 'errorObservation']) {
      const candidate = structuredClone(report);
      candidate[observer].complete = false;
      expectRejected(candidate, /not proven complete/);
    }
    {
      const candidate = structuredClone(report);
      candidate.launches[0].startupObservation.finalNetworkCount = 2;
      expectRejected(candidate, /launches lack complete/);
      const globalNetwork = structuredClone(report);
      globalNetwork.networkAttempts.push({ url: 'https://example.invalid', cancelledBeforeNetwork: true });
      expectRejected(globalNetwork, /global network attempts do not match/);
      const missingGlobalNetwork = structuredClone(report);
      delete missingGlobalNetwork.networkAttempts;
      expectRejected(missingGlobalNetwork, /global network attempts are missing/);
      const mainError = structuredClone(report);
      mainError.launches[0].mainErrors.push({ type: 'synthetic' });
      expectRejected(mainError, /launches lack complete/);
      const incompleteModule = structuredClone(report);
      delete incompleteModule.moduleResults[0].completed;
      expectRejected(incompleteModule, /lacks a valid completed step range/);
      const unlinkedModule = structuredClone(report);
      unlinkedModule.moduleResults[0].stepEnd = unlinkedModule.moduleResults[0].stepStart;
      expectRejected(unlinkedModule, /lacks a valid completed step range/);
      const failedModuleStep = structuredClone(report);
      failedModuleStep.steps[failedModuleStep.moduleResults[0].stepStart].status = 'fail';
      expectRejected(failedModuleStep, /not bound to unique passing steps/);
    }
    const finalLaunchExit = report.processExits.pop();
    assert.ok(validateEvidenceManifest(report, screenshots).some((problem) => /lack exactly one matching normal process exit/.test(problem)),
      'a failed final launch cannot inherit earlier normal-exit evidence');
    report.processExits.push(finalLaunchExit);
    report.cleanupFailures = [{ launch: 3, error: 'synthetic bounded cleanup failure' }];
    assert.ok(validateEvidenceManifest(report, screenshots).some((problem) => /cleanup failures/.test(problem)));
    delete report.cleanupFailures;
    for (const channel of ['pageErrors', 'consoleErrors', 'cspErrors']) {
      snapshotErrorChannels(report, { pageErrors: [], consoleErrors: [], cspErrors: [], [channel]: ['late synthetic error'] });
      assert.ok(validateEvidenceManifest(report, screenshots).some((problem) => problem.includes(channel) && /contains errors/.test(problem)), `final global ${channel} errors fail validation`);
      snapshotErrorChannels(report, { pageErrors: [], consoleErrors: [], cspErrors: [] });
    }
    for (const channel of ['pageErrors', 'consoleErrors', 'cspErrors']) {
      report.launches[0][channel] = ['late synthetic error'];
      assert.ok(validateEvidenceManifest(report, screenshots).some((problem) => /launches recorded renderer/.test(problem)), `final launch ${channel} errors fail validation`);
      report.launches[0][channel] = [];
    }
    report.networkObservation.scope = 'post-first-window-observer-through-exit';
    assert.ok(validateEvidenceManifest(report, screenshots).some((problem) => /startup-to-exit/.test(problem)));
    report.networkObservation.scope = 'startup-through-exit';
    report.errorObservation.scope = 'post-first-window-listeners-through-exit';
    assert.ok(validateEvidenceManifest(report, screenshots).some((problem) => /error observation/.test(problem)));
    report.errorObservation.scope = 'startup-through-exit';
    snapshotErrorChannels(report, { pageErrors: ['late synthetic error'], consoleErrors: [], cspErrors: [] });
    assert.throws(() => finalizeEvidence(report, screenshots), /Evidence manifest failed closed/);
    assert.equal(report.status, 'hold', 'finalization retains a failed run when any late global error exists');
    snapshotErrorChannels(report, { pageErrors: [], consoleErrors: [], cspErrors: [] });
    report.status = 'pass';
    screenshots.pop();
    assert.ok(validateEvidenceManifest(report, screenshots).some((problem) => /required screenshot/.test(problem)));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('partial launch cleanup records errors and port release without inventing a PID or complete global observation', async () => {
  const errors = [{ type: 'synthetic setup failure' }];
  const launchRecord = { launch: 3, identity: null, startup: { inspectorPort: 45123 }, networkAttempts: [],
    pageErrorStart: 0, consoleErrorStart: 0, cspErrorStart: 0 };
  const channels = { pageErrors: [...errors], consoleErrors: [], cspErrors: [] };
  let markerCalls = 0, releasedPort = null;
  const problems = await collectShutdownEvidence({ launchRecord, readStderr: () => 'no observer marker', ...channels,
    findMarker: async () => { markerCalls++; return null; },
    releasePort: async (port) => { releasedPort = port; return true; } });

  assert.equal(markerCalls, 0, 'missing launch identity cannot be used to claim a matching will-quit marker');
  assert.equal(releasedPort, 45123, 'bounded cleanup still confirms the owned inspector port release');
  assert.equal(launchRecord.startup.inspectorPortReleased, true);
  assert.deepEqual(launchRecord.pageErrors, errors, 'final renderer error channel is retained after setup failure');
  assert.ok(problems.some((problem) => /identity PID is missing/.test(problem)));
  assert.ok(problems.some((problem) => /final will-quit snapshot/.test(problem)));

  const launch = (number, overrides = {}) => ({ launch: number,
    startup: { installedBeforeReady: true, inspectorPortReleased: true },
    startupObservation: { installedBeforeReady: true, willQuitCaptured: true, finalNetworkCount: 0,
      finalErrors: 0, sessions: 1 }, networkAttempts: [], mainErrors: [], pageErrors: [], consoleErrors: [], cspErrors: [],
    exit: { launch: number, exitCode: 0, signal: null, forced: false }, ...overrides });
  const report = { launches: [launch(1), launch(2), launch(3, {
    identity: null, startupObservation: { installedBeforeReady: true, willQuitCaptured: false },
  })], processExits: [1, 2, 3].map((number) => ({ launch: number, exitCode: 0, signal: null, forced: false })),
  networkAttempts: [], pageErrors: [], consoleErrors: [], cspErrors: [],
  networkObservation: { scope: 'startup-through-exit', complete: false },
  errorObservation: { scope: 'startup-through-exit', complete: false } };
  assert.equal(hasCompleteNormalQuit(report.launches, report.processExits), true,
    'normal owned process exits remain separately provable when observer identity is incomplete');
  const duplicateExits = structuredClone(report.processExits);
  duplicateExits[2].launch = duplicateExits[1].launch;
  assert.equal(hasCompleteNormalQuit(report.launches, duplicateExits), false, 'duplicate process exits cannot satisfy normalQuit');
  assert.equal(deriveFinalObservations(report), false, 'a late incomplete launch keeps global observers incomplete');
  assert.equal(report.networkObservation.complete, false);
  assert.equal(report.errorObservation.complete, false);

  const observedFailure = { launches: [launch(1), launch(2), launch(3)],
    processExits: [1, 2, 3].map((number) => ({ launch: number, exitCode: 0, signal: null, forced: false })),
    networkAttempts: [], pageErrors: [], consoleErrors: [], cspErrors: [], status: 'fail', steps: [{ status: 'fail' }],
    networkObservation: {}, errorObservation: {} };
  assert.equal(deriveFinalObservations(observedFailure), true,
    'a functional assertion failure does not erase complete observer evidence after all launches shut down cleanly');
  assert.equal(observedFailure.status, 'fail', 'complete observation evidence does not promote a failed functional run');

  for (const sessions of [undefined, 0, -1, 1.5, []]) {
    const invalidSessionReport = structuredClone(observedFailure);
    if (sessions === undefined) delete invalidSessionReport.launches[0].startupObservation.sessions;
    else invalidSessionReport.launches[0].startupObservation.sessions = sessions;
    assert.equal(deriveFinalObservations(invalidSessionReport), false,
      `session count ${String(sessions)} cannot establish complete observations`);
  }
});

test('shutdown evidence classifies port-release errors without retaining their raw private message', async () => {
  const canary = 'PRIVATE_PORT_RELEASE_REPORT_CANARY';
  const launchRecord = { launch: 47, identity: null, startup: { inspectorPort: 45678 }, networkAttempts: [],
    pageErrorStart: 0, consoleErrorStart: 0, cspErrorStart: 0 };
  await collectShutdownEvidence({ launchRecord, readStderr: () => '', pageErrors: [], consoleErrors: [], cspErrors: [],
    releasePort: async () => { throw new Error(canary); } });
  assert.match(launchRecord.cleanup.inspectorPortError, /inspector port release failed; details withheld/);
  assert.equal(JSON.stringify(launchRecord).includes(canary), false);
});

test('failure diagnostics time out independently and preserve the original functional error', async () => {
  const diagnostics = await collectFailureDiagnostics({ evaluate: () => new Promise(() => {}) }, () => new Promise(() => {}), 15);
  assert.match(diagnostics.rendererError, /Renderer state capture exceeded 15 ms/);
  assert.match(diagnostics.screenshotError, /Synthetic failure screenshot exceeded 15 ms/);
  const original = new Error('synthetic first functional failure');
  await assert.rejects(() => recordStep('synthetic diagnostic timeout keeps original error', async () => { throw original; }), (error) => error === original);
});

test('support-reminder report failure diagnostics retain error occurrence while withholding renderer and console canaries', async () => {
  const canary = 'PRIVATE_SUPPORT_REPORT_DESCRIPTION_C:\\secret\\draft.json';
  const screenshot = await collectFailureDiagnostics({ evaluate: () => { throw new Error(canary); } }, async () => 'masked-screenshot', 25, true);
  assert.equal(screenshot.reportCaptureMasked, true);
  assert.equal(screenshot.screenshot, 'masked-screenshot');
  assert.equal(JSON.stringify(screenshot).includes(canary), false);
  const originalError = console.error;
  let logged = '';
  console.error = (value) => { logged += String(value); };
  try {
    await assert.rejects(() => recordStep('support reminder report action stays local and exposes privacy choices', async () => {
      throw new Error(canary);
    }), (error) => error.message === canary);
  } finally { console.error = originalError; }
  assert.match(logged, /details withheld/);
  assert.equal(logged.includes(canary), false);
});

test('report module phase redacts page errors, console text and CSP location across channels', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-report-privacy-phase-'));
  const { EventEmitter } = require('node:events');
  const page = new EventEmitter();
  const channels = { pageErrors: [], consoleErrors: [], cspErrors: [] };
  listenForErrors(page, channels);
  const canary = 'PRIVATE_REPORT_FILL_CANARY C:\\secret\\draft.json';
  globalThis.__traceQaTestEmitReportError = () => {
    page.emit('pageerror', new Error(canary));
    page.emit('console', { type: () => 'error', text: () => canary, location: () => ({ url: 'file:///C:/secret/draft.json' }) });
    page.emit('console', { type: () => 'error', text: () => 'Content Security Policy blocked ' + canary, location: () => ({ url: 'file:///C:/secret/draft.json' }) });
  };
  try {
    for (const id of SCENARIO_MANIFEST.modules) {
      const body = id === 'bug-reports'
        ? `exports.run = async (ctx) => ctx.step('support reminder report action stays local and exposes privacy choices', async () => { globalThis.__traceQaTestEmitReportError(); });`
        : `exports.run = async (ctx) => ctx.step('${id} synthetic privacy boundary', async () => {});`;
      await fs.writeFile(path.join(directory, id + '.cjs'), body);
    }
    await runRequiredScenarioModules({ step: (name, action) => recordStep(name, action), getPage: () => page }, directory);
    assert.equal(channels.pageErrors.length, 1);
    assert.deepEqual(channels.consoleErrors, [
      { type: 'console', reportSensitive: true, class: 'renderer' },
      { type: 'console', reportSensitive: true, class: 'csp' },
    ]);
    assert.deepEqual(channels.cspErrors, ['[redacted bug-report CSP error]']);
    assert.equal(JSON.stringify(channels).includes(canary), false);
    assert.equal(JSON.stringify(channels).includes('secret'), false);
  } finally {
    delete globalThis.__traceQaTestEmitReportError;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('process observer marker polling reads stderr again after later stream chunks arrive', async () => {
  const actual = actualObserverMarkerOutput();
  assert.equal(actual.charCodeAt(actual.length - 1), 10, 'the observer writes a real newline after its complete JSON marker');
  let stderr = '';
  setTimeout(() => { stderr += actual; }, 45);
  assert.deepEqual(await waitForProcessObserverMarker(() => stderr, 731, 500), JSON.parse(actual.slice('TRACE_QA_PREMAIN_FINAL '.length).trim()));
  assert.equal(await waitForProcessObserverMarker(() => '', 731, 30), null, 'marker polling remains bounded when no marker arrives');
});

function actualObserverMarkerOutput() {
  const appListeners = new Map();
  const sessions = new Map();
  let output = '';
  const makeSession = () => ({ webRequest: { onBeforeRequest(_filter, listener) { this.before = listener; },
    onHeadersReceived(_filter, listener) { this.headers = listener; } } });
  const defaultSession = makeSession();
  sessions.set('default', defaultSession);
  const app = { isReady: () => false, isPackaged: true,
    on(name, listener) { const listeners = appListeners.get(name) || []; listeners.push(listener); appListeners.set(name, listeners); } };
  const electron = { app, session: { defaultSession,
    fromPartition(name) { if (!sessions.has(name)) sessions.set(name, makeSession()); return sessions.get(name); } },
    ipcMain: { handle() {} }, BrowserWindow: { getAllWindows: () => [] }, shell: { openExternal: async () => {} } };
  const fakeProcess = { pid: 731, on() {}, stderr: { write(value) { output += String(value); } } };
  const sandbox = { require(name) { if (name === 'electron') return electron; if (name === 'node:crypto') return crypto; throw new Error('unexpected module'); },
    process: fakeProcess, Buffer, URL, Date, setTimeout, clearTimeout, console };
  vm.runInNewContext(inspector.observerExpression(), sandbox, { timeout: 1000 });
  for (const listener of appListeners.get('session-created') || []) listener({}, defaultSession);
  for (const listener of appListeners.get('ready') || []) listener();
  for (const listener of appListeners.get('will-quit') || []) listener();
  return output;
}

test('privacy-safe marker stream accepts every fragment boundary and emits only complete validated observer snapshots', () => {
  const actual = actualObserverMarkerOutput();
  const expected = JSON.parse(actual.slice('TRACE_QA_PREMAIN_FINAL '.length).trim());
  for (let boundary = 0; boundary <= actual.length; boundary++) {
    const stream = createObserverMarkerAccumulator();
    const markers = [...stream.push(actual.slice(0, boundary)), ...stream.push(actual.slice(boundary))];
    assert.deepEqual(markers, [expected], `the real observer marker survives split at character ${boundary}`);
  }
  const stream = createObserverMarkerAccumulator();
  const merged = [
    ...stream.push('private chatter\r\nTRACE_QA_PREMAIN_FINAL ' + 'x'.repeat(70000) + '\n'),
    ...stream.push('TRACE_QA_PREMAIN_FINAL {"pid":731,"secret":"PRIVATE_MARKER_CANARY"}\n' + actual + actual),
  ];
  assert.deepEqual(merged, [expected, expected], 'oversized and invalid private lines are discarded while multiple valid closed markers are preserved');
  assert.equal(JSON.stringify(merged).includes('PRIVATE_MARKER_CANARY'), false);
});

test('closeNormally redacts a report-phase app.close canary while retaining its internal cause and failure classification', async () => {
  const { EventEmitter } = require('node:events');
  const canary = 'PRIVATE_CLEANUP_REPORT_CANARY';
  const cause = new Error(canary);
  const child = new EventEmitter();
  child.exitCode = 0;
  child.signalCode = null;
  const observer = { version: 2, allowedCount: 0, deniedCount: 0, gateArms: 0, gateFailures: 0, responseArms: 0, responseFailures: 0,
    attempts: [], responses: [], cancelOracles: [] };
  const snapshot = { network: [], errors: [], external: [], reportObserver: observer, installedBeforeReady: true, ready: true, events: ['ready'], sessions: 1, windows: 0 };
  const testApp = { process: () => child, evaluate: async () => snapshot, close: async () => { throw cause; } };
  const launchRecord = { launch: 913, startup: { installedBeforeReady: true, inspectorPort: 0 }, identity: null,
    networkAttempts: [], pageErrorStart: 0, consoleErrorStart: 0, cspErrorStart: 0 };
  const result = await __testCloseNormally({ app: testApp, launchRecord, privacyActive: true });
  assert.equal(result.error.cause, cause, 'cleanup preserves the original internal error object');
  assert.ok(launchRecord.cleanup.problems.some((problem) => /application close failed; details withheld/.test(problem)));
  assert.equal(JSON.stringify(result.evidence).includes(canary), false, 'the actual closeNormally evidence path never stores the error text');
  assert.equal(JSON.stringify(launchRecord.cleanup).includes(canary), false);
});

test('packaged startup reports Playwright launch rejection before waiting for an inspector timeout', async () => {
  const startedAt = Date.now();
  await assert.rejects(() => inspector.launchWithPreMainObservers({ executablePath: 'synthetic-app' }, {
    timeout: 5000,
    launch: async () => { throw new Error('synthetic spawn failure'); },
  }), /launch rejected before the inspector endpoint: synthetic spawn failure/);
  assert.ok(Date.now() - startedAt < 1000, 'an observed launch rejection fails promptly');
});

test('packaged startup reports its own child exit code before waiting for an inspector timeout', async () => {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  const app = { process: () => child, close: async () => {} };
  setTimeout(() => { child.exitCode = 7; child.emit('exit', 7, null); }, 10);
  await assert.rejects(() => inspector.launchWithPreMainObservers({ executablePath: 'synthetic-app' }, {
    timeout: 5000,
    launch: async () => app,
  }), /exited before the inspector endpoint \(code 7, signal none\)/);
});

test('packaged startup timeout uses explicit options before the Playwright launch budget and validates bounds', () => {
  assert.equal(inspector.startupTimeout({ timeout: 61000 }, { timeout: 17000 }), 17000);
  assert.equal(inspector.startupTimeout({ timeout: 61000 }, {}), 61000);
  assert.equal(inspector.startupTimeout({}, {}), 10000);
  for (const timeout of [0, -1, Infinity, NaN, 600001]) {
    assert.throws(() => inspector.startupTimeout({}, { timeout }), /positive finite value/);
  }
});

test('aborting inspector discovery prevents another poll after an in-flight request fails', async () => {
  const { EventEmitter } = require('node:events');
  const controller = new AbortController();
  const request = new EventEmitter();
  let requests = 0, scheduled = 0, destroyed = 0;
  request.destroy = () => { destroyed++; request.emit('error', Object.assign(new Error('cancelled'), { code: 'ECONNRESET' })); };
  const discovery = inspector.inspectorEndpoint(12345, 5000, {
    signal: controller.signal,
    get: () => { requests++; return request; },
    setTimer: () => { scheduled++; return scheduled; },
    clearTimer: () => {},
  });
  controller.abort();
  await assert.rejects(discovery, /discovery stopped/);
  request.emit('error', Object.assign(new Error('late request error'), { code: 'ECONNRESET' }));
  assert.equal(requests, 1, 'abort leaves no follow-up HTTP probe');
  assert.equal(scheduled, 0, 'abort leaves no follow-up poll timer');
  assert.equal(destroyed, 1, 'abort cancels the active HTTP request');
});

test('a Playwright app resolving after startup failure is closed and its child exits', async () => {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  let closeCount = 0;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let resolveLaunch;
  const launchPromise = new Promise((resolve) => { resolveLaunch = resolve; });
  const app = { process: () => child, close: async () => {
    closeCount++;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    resolveClosed();
  } };
  const failure = inspector.launchWithPreMainObservers({ executablePath: 'synthetic-app' }, {
    timeout: 30,
    cleanupTimeoutMs: 5,
    launch: () => launchPromise,
  });
  await assert.rejects(failure, /Timed out waiting for the loopback inspector endpoint.*cleanup pending or failed/);
  resolveLaunch(app);
  await inspector.withTimeout(closed, 1000, 'late app cleanup did not run');
  assert.equal(closeCount, 1, 'the owned Playwright app is closed exactly once');
  assert.equal(child.exitCode, 0, 'the owned child exits through normal app cleanup');
});

test('failure cleanup bounds app.close and reports when the owned child is still live', async () => {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const closeNeverSettles = new Promise(() => {});
  const app = { process: () => child, close: () => closeNeverSettles };
  const processFailure = new Error('synthetic owned process error');
  setTimeout(() => child.emit('error', processFailure), 10);
  await assert.rejects(() => inspector.launchWithPreMainObservers({ executablePath: 'synthetic-app' }, {
    timeout: 1000,
    cleanupTimeoutMs: 20,
    launch: async () => app,
  }), (error) => {
    assert.match(error.message, /synthetic owned process error/);
    assert.match(error.message, /app\.close\(\) did not settle within 20 ms/);
    assert.match(error.message, /owned packaged child remains live; cleanup did not confirm its exit/);
    assert.equal(error.cause, processFailure, 'cleanup diagnostics preserve the original process failure');
    assert.equal(child.exitCode, null, 'the test does not claim that a still-live owned process exited');
    return true;
  });
});

test('loopback inspector timeout preserves the last endpoint response or connection error', async () => {
  const port = await inspector.reserveInspectorPort();
  await assert.rejects(() => inspector.inspectorEndpoint(port, 80), /Timed out waiting for the loopback inspector endpoint; last probe:/);
});

test('argument-validation failure writes a machine-readable envelope before exiting', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-qa-failure-envelope-'));
  const output = path.join(dir, 'failure.json');
  try {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/packaged-functional-qa.cjs'), `--out=${output}`, '--bogus=value'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    const report = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(report.status, 'fail');
    assert.equal(report.failureStage, 'argument-validation');
    assert.equal(report.failure.stage, 'argument-validation');
    assert.ok(Array.isArray(report.steps) && Array.isArray(report.screenshotManifest));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('packaged fixtures contain the exact board shape and complete declared ASC companion set', () => {
  const board = boardText();
  assert.equal((board.match(/^COMPONENT /gm) || []).length, 3);
  assert.equal((board.match(/^PIN [12] /gm) || []).length, 2);
  assert.equal((board.match(/^SIGNAL /gm) || []).length, 2);
  const secondBoard = board.replace('COMPONENT U10\nPLACE 30 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\n',
    'COMPONENT U10\nPLACE 30 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\nCOMPONENT U11\nPLACE 35 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\n');
  const componentCount = (secondBoard.match(/^COMPONENT /gm) || []).length;
  const pinsPerComponent = (secondBoard.match(/^PIN [12] /gm) || []).length;
  const signalCount = (secondBoard.match(/^SIGNAL /gm) || []).length;
  assert.deepEqual([componentCount, componentCount * pinsPerComponent, signalCount], [4, 8, 2],
    'the native second-board fixture settles to exactly four components, eight pins and two nets');
  assert.deepEqual(Object.keys(ascFiles()).sort(), ['format.asc', 'nails.asc', 'pins.asc']);
});

test('packaged support UI QA checks the localized unavailable and retry strings in all shipped locales', async () => {
  assert.deepEqual([...LANGUAGES].sort(), ['de', 'en', 'fr', 'hu', 'it', 'pl', 'sk', 'uk']);
  const values = await Promise.all(LANGUAGES.map(async (language) => [language, await supportStatusStrings(language)]));
  for (const [language, strings] of values) {
    assert.ok(strings.unavailable.trim(), `${language} unavailable string`);
    assert.ok(strings.retry.trim(), `${language} retry string`);
  }
  assert.equal(new Set(values.map(([, strings]) => strings.retry)).size, LANGUAGES.length, 'all eight retries are distinct localized strings');
});
