'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const supportUpdates = require('../scripts/packaged-functional/support-updates.cjs');
const updates = require('../electron/updates.cjs');
const support = require('../electron/support.cjs');

function reviveMainCallback(callback, electron, globals = {}) {
  const nativeRequire = Module.createRequire(path.join(__dirname, '..', 'package.json'));
  const mainRequire = request => request === 'electron' ? electron : nativeRequire(request);
  Object.assign(globals, { require: mainRequire, Buffer, Response, URL, Date });
  const context = vm.createContext(globals);
  const revived = vm.runInContext(`(${callback.toString()})`, context, { filename: 'serialized-electron-main-callback.cjs' });
  return revived;
}

test('packaged update helper executes main callbacks with Electron context first and payload second', async () => {
  const previousLoad = Module._load;
  const originalNow = Date.now;
  let partition;
  let pageCalls = 0;
  let cachedAnswer;
  let restarts = 0;
  const startupCalls = [];
  const electronAPI = { kind: 'synthetic-electron-context' };
  const fakeElectron = { app: { getAppPath: () => path.resolve(__dirname, '..') }, session: { fromPartition: () => (partition = {}) } };
  const mainGlobals = {};
  const page = { evaluate: async callback => {
    if (callback.toString().includes('requestAnimationFrame')) { startupCalls.push('committed-render'); return; }
    pageCalls++;
    if (pageCalls === 1) {
      cachedAnswer = await updates.checkForUpdate({ currentVersion: '1.3.1-rc.2', fetchImpl: (url, init) => partition.fetch(url, init) });
      return cachedAnswer.status === 'available' ? { status: 'available', version: cachedAnswer.version } : cachedAnswer;
    }
    if (pageCalls === 2) return cachedAnswer.status === 'available' ? { status: 'available', version: cachedAnswer.version } : cachedAnswer;
    return reviveMainCallback(() => {
      globalThis.__traceQaExternalUrls = ['https://github.com/trace-boardviewer/trace-boardviewer/releases/tag/v1.3.2'];
    }, fakeElectron, mainGlobals)();
  }, waitForFunction: async () => { startupCalls.push('app-and-board-ready'); },
  locator: selector => ({
    waitFor: async ({ state }) => startupCalls.push(`${selector}:${state}`),
    click: async () => startupCalls.push(`${selector}:click`),
  }) };
  const calls = [];
  const ctx = {
    main: async (callback, payload) => { calls.push(payload); return reviveMainCallback(callback, fakeElectron, mainGlobals)(electronAPI, payload); },
    getPage: () => page,
    restart: async () => { restarts++; Date.now = originalNow; delete mainGlobals.__traceQaUpdateReplies; },
    screenshot: async () => {},
  };
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return previousLoad.call(this, request, parent, isMain);
  };
  try {
    const result = await supportUpdates.testSuccessfulPackagedUpdate(ctx, page);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], { body: { tag_name: 'v1.3.2', prerelease: false, draft: false, html_url: 'https://invalid.example/ignored' } });
    assert.equal(calls[1], undefined);
    assert.equal(calls[2], undefined);
    assert.equal(result.releasePage, `${updates.RELEASE_PAGE_BASE}v1.3.2`);
    assert.equal(result.externalTraffic, 'none; session fetch and shell handoff were intercepted locally');
    assert.equal(pageCalls, 3, 'the packaged flow checks successfully, immediately checks again, then opens the validated page');
    assert.equal(restarts, 1);
    assert.deepEqual(startupCalls, [
      'app-and-board-ready', 'committed-render',
      '[data-testid=support-button]:visible', '[data-testid=support-notice]:visible',
      '[data-testid=support-not-now]:click', '[data-testid=support-notice]:detached',
    ], 'restart settles the actual packaged UI and skips the startup notice before a later chooser can run');
  } finally {
    Module._load = previousLoad;
    Date.now = originalNow;
    delete mainGlobals.__traceQaUpdateReplies;
    delete mainGlobals.__traceQaExternalUrls;
  }
});

test('inactive startup notice is skipped only after app readiness and detaches before manual interactions', async () => {
  const calls = [];
  const page = {
    waitForFunction: async (_predicate, _argument, options) => { calls.push(['ready', options.timeout]); },
    evaluate: async callback => { calls.push([callback.toString().includes('requestAnimationFrame') ? 'committed' : 'evaluate']); },
    locator: selector => ({
      waitFor: async ({ state, timeout }) => calls.push([selector, state, timeout]),
      click: async () => calls.push([selector, 'click']),
    }),
  };
  const result = await supportUpdates.settleInactivePackagedStartup(page);
  assert.deepEqual(result, { ready: true, supportHeartVisible: true, startupNotice: 'shown and skipped' });
  assert.deepEqual(calls, [
    ['ready', 20_000], ['committed'],
    ['[data-testid=support-button]', 'visible', 10_000],
    ['[data-testid=support-notice]', 'visible', 10_000],
    ['[data-testid=support-not-now]', 'click'],
    ['[data-testid=support-notice]', 'detached', 10_000],
  ]);
});

test('packaged receipt helper executes its callback against the real verifier and synthetic profile store', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-support-qa-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const claim = '89abcdef012345670123456789abcdef';
  const now = Date.UTC(2026, 0, 2, 12);
  const payload = Buffer.from(JSON.stringify({ claim, paidAt: now, expiresAt: support.yearAfter(now), version: 1 })).toString('base64url');
  const receipt = { payload, signature: crypto.sign('sha256', Buffer.from(payload), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
  const fixture = { claim, now, publicKey: publicKey.export({ format: 'jwk' }), receipt };
  let registered;
  const electronAPI = { kind: 'synthetic-electron-context' };
  const mainGlobals = {};
  const ipcMain = { removeHandler: () => {}, handle: (name, callback) => { registered = { name, callback }; } };
  const fakeElectron = { app: { getAppPath: () => path.resolve(__dirname, '..'), getPath: () => directory }, ipcMain };
  const ctx = { main: (callback, payloadValue) => reviveMainCallback(callback, fakeElectron, mainGlobals)(electronAPI, payloadValue) };
  const previousLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getAppPath: () => path.resolve(__dirname, '..'), getPath: () => directory }, ipcMain };
    return previousLoad.call(this, request, parent, isMain);
  };
  try {
    const result = await supportUpdates.installSyntheticReceiptService(ctx, fixture, { seed: true });
    assert.equal(result.status.status, 'verified');
    assert.equal(result.label, 'synthetic configured receipt; not provider proof');
    assert.equal(registered.name, 'trace:get-support-status');
    const status = await registered.callback({ sender: { id: 7 }, senderFrame: { url: 'file:///packaged/index.html' } });
    assert.deepEqual(status, { status: 'verified', expiresAt: support.yearAfter(now), available: true });
    const rendererReply = await supportUpdates.awaitRendererInitialStatusReply(ctx);
    assert.deepEqual(JSON.parse(JSON.stringify(rendererReply)), {
      request: { id: 1, senderId: 7, frameUrl: 'file:///packaged/index.html' },
      reply: status,
    }, 'the serialized packaged handler records the actual renderer IPC request and its fulfilled status reply');
    assert.deepEqual(await supportUpdates.setSyntheticReceiptTime(ctx, support.yearAfter(now) - 1),
      { status: 'verified', expiresAt: support.yearAfter(now), available: true }, 'the same stored signed receipt stays verified one millisecond before expiry');
    assert.deepEqual(await supportUpdates.setSyntheticReceiptTime(ctx, support.yearAfter(now)),
      { status: 'inactive', expiresAt: null, available: true }, 'the same stored signed receipt becomes inactive exactly at expiry');
  } finally {
    Module._load = previousLoad;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('installed expiry clock allocates isolated negative IDs and forwards unrelated real IDs', async () => {
  const originalSetInterval = () => 701;
  const forwardedClearCalls = [];
  const originalClearInterval = id => forwardedClearCalls.push(id);
  const browser = {
    sessionStorage: {
      values: new Map(),
      getItem(key) { return this.values.get(key) ?? null; },
      setItem(key, value) { this.values.set(key, value); },
      removeItem(key) { this.values.delete(key); },
    },
    window: { setInterval: originalSetInterval, clearInterval: originalClearInterval },
  };
  let initScript;
  let initArguments;
  const page = {
    addInitScript: async (callback, args) => { initScript = callback; initArguments = args; },
    evaluate: async (callback, value) => vm.runInNewContext(`(${callback.toString()})(${JSON.stringify(value)})`, browser),
  };

  await supportUpdates.installExpiryRendererClockBeforeReload(page, 12_345);
  vm.runInNewContext(`(${initScript.toString()})`, browser)(initArguments);
  const clock = browser.window.__traceQaSupportExpiryClock;
  const timers = Array.from({ length: 3 }, () => {
    const id = browser.window.setInterval(() => {}, 60_000);
    return { id, timer: clock.activeTimers.get(id) };
  });
  try {
    const ids = timers.map(({ id }) => id);
    assert.equal(ids.length, 3);
    assert.ok(ids.every(id => Number.isInteger(id) && id < 0), 'every installed fake timer ID is negative');
    assert.equal(new Set(ids).size, 3, 'each installed fake timer ID is unique');
    for (const { id, timer } of timers) browser.window.clearInterval(id);
    assert.ok(timers.every(({ timer }) => timer.active === false), 'clearing each allocated fake timer deactivates its callback');
    assert.equal(clock.activeTimers.size, 0, 'all allocated timers are removed from the active set');

    browser.window.clearInterval(701);
    assert.deepEqual(forwardedClearCalls, [701], 'an unrelated positive real timer ID reaches the original clearInterval');
  } finally {
    await supportUpdates.restoreExpiryRendererClock(page);
  }
  assert.equal(browser.window.setInterval, originalSetInterval, 'the installed setInterval wrapper is restored');
  assert.equal(browser.window.clearInterval, originalClearInterval, 'the installed clearInterval wrapper is restored');
  assert.equal(clock.fakeTimerIds.size, 0, 'restoration removes fake ID ownership');
});

test('bounded expiry clock advances the captured support-status timer at the exact boundary', async () => {
  const originalWindow = global.window;
  const originalSessionStorage = global.sessionStorage;
  const originalAnimationFrame = global.requestAnimationFrame;
  const originalNow = Date.now;
  let fired = 0;
  let forwardedClearCalls = 0;
  const originalSetInterval = () => 'original setInterval';
  const originalClearInterval = () => { forwardedClearCalls++; };
  const timer = { id: 33, active: true, run: () => {
    fired++;
    global.window.clearInterval(timer.id);
    global.window.setInterval(() => {}, 60_000);
  } };
  const clock = { now: 0, boundary: 12_345, callbacks: [timer], activeTimers: new Map([[timer.id, timer]]),
    fakeTimerIds: new Set([timer.id]), originalNow, originalSetInterval, originalClearInterval };
  global.window = { __traceQaSupportExpiryClock: clock, setInterval: (callback, delay) => {
    const next = { id: 34, active: true, run: callback, delay };
    clock.callbacks.push(next);
    clock.activeTimers.set(next.id, next);
    clock.fakeTimerIds.add(next.id);
    return next.id;
  }, clearInterval: id => {
    if (clock.fakeTimerIds.has(id)) {
      const active = clock.activeTimers.get(id);
      if (active) { active.active = false; clock.activeTimers.delete(id); }
      return;
    }
    clock.originalClearInterval(id);
  } };
  global.sessionStorage = { removeItem: () => {} };
  Date.now = () => clock.now;
  global.requestAnimationFrame = callback => callback();
  try {
    const page = { evaluate: (callback, boundary) => callback(boundary) };
    const evidence = await supportUpdates.advanceExpiryRendererClock(page, 12_345);
    assert.deepEqual(evidence, { now: 12_345, boundary: 12_345, timerCallbacks: 1,
      timerId: 33, firedTimerId: 33, fired: true, activeTimersAfter: [34] },
    'the original support-status timer identity is retained while expiry creates a reminder timer');
    assert.equal(fired, 1, 'the captured interval callback is invoked once');
    assert.equal(timer.active, false, 'the effect cleanup clears the original support-status timer');
    assert.deepEqual([...clock.activeTimers.keys()], [34], 'the legitimate post-expiry reminder timer remains active');
    window.clearInterval(timer.id);
    assert.equal(forwardedClearCalls, 0, 're-clearing an owned fake interval never reaches the original API');
    window.clearInterval(999);
    assert.equal(forwardedClearCalls, 1, 'a non-fake interval ID still reaches the original API');
    await supportUpdates.restoreExpiryRendererClock(page);
    assert.equal(Date.now, originalNow, 'Date.now is restored');
    assert.equal(window.setInterval, originalSetInterval, 'setInterval is restored');
    assert.equal(window.clearInterval, originalClearInterval, 'clearInterval is restored');
    assert.equal(clock.activeTimers.size, 0, 'restoration deactivates and removes all fake interval callbacks');
    assert.equal(clock.fakeTimerIds.size, 0, 'restoration drops all fake interval ID ownership');
    assert.equal(clock.callbacks.every(callback => !callback.active), true, 'no fake callback remains active');
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    if (originalSessionStorage === undefined) delete global.sessionStorage;
    else global.sessionStorage = originalSessionStorage;
    Date.now = originalNow;
    if (originalAnimationFrame === undefined) delete global.requestAnimationFrame;
    else global.requestAnimationFrame = originalAnimationFrame;
  }
});

test('search readiness waits for the exact current board component row and cleared pending state', async () => {
  const originalDocument = global.document;
  const componentRow = ref => ({ querySelector: selector => selector === '.component-ref' ? { textContent: ref } : null });
  let currentRef = 'U10';
  let pending = true;
  global.document = {
    querySelector: selector => selector === '[data-testid=search-input]' ? {
      value: 'U1', parentElement: { querySelector: () => pending ? {} : null },
    } : null,
    querySelectorAll: selector => selector === '[data-testid=search-row][data-source="board-components"]'
      ? [componentRow(currentRef)] : [],
  };
  try {
    const page = { waitForFunction: async (predicate, ref, options) => {
      assert.equal(ref, 'U1');
      assert.equal(options.timeout, 15_000);
      assert.equal(predicate(ref), false, 'a U10 substring match and pending search cannot release Enter');
      currentRef = 'U1';
      assert.equal(predicate(ref), false, 'the exact row remains blocked until the integrated search settles');
      pending = false;
      assert.equal(predicate(ref), true, 'the exact current U1 row with no pending indicator releases Enter');
    } };
    await supportUpdates.waitForCurrentBoardComponentRow(page, 'U1');
  } finally {
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
  }
});

test('owned receipt board identity resolves real filesystem symlink aliases', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-support-path-'));
  const targetDirectory = path.join(directory, 'actual');
  const aliasDirectory = path.join(directory, 'alias');
  const target = path.join(targetDirectory, 'receipt-board.cad');
  const alias = path.join(aliasDirectory, 'receipt-board.cad');
  try {
    await fs.mkdir(targetDirectory);
    await fs.writeFile(target, 'synthetic board path identity fixture');
    try {
      await fs.symlink(targetDirectory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) {
        t.skip(`host does not permit symlink fixtures (${error.code})`);
        return;
      }
      throw error;
    }
    const resolved = await supportUpdates.assertSameCanonicalOwnedPath(alias, target);
    assert.equal(resolved.source, resolved.target, 'the alias and target resolve to the same canonical filesystem path');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('owned receipt board identity follows the host filesystem case capability', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-support-case-'));
  const target = path.join(directory, 'CanonicalCase.cad');
  const alternateCase = path.join(directory, 'canonicalcase.cad');
  try {
    await fs.writeFile(target, 'synthetic board case identity fixture');
    let alternateExists = true;
    try {
      await fs.realpath(alternateCase);
    } catch (error) {
      if (error.code === 'ENOENT') alternateExists = false;
      else throw error;
    }
    if (alternateExists) {
      const resolved = await supportUpdates.assertSameCanonicalOwnedPath(alternateCase, target);
      assert.equal(resolved.source, resolved.target, 'case aliases resolve identically when the host filesystem supports them');
    } else {
      await assert.rejects(supportUpdates.assertSameCanonicalOwnedPath(alternateCase, target), { code: 'ENOENT' },
        'a case-sensitive host rejects a path with different case');
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('main callback contracts survive serialization with argument order, isolated globals, and error propagation', async () => {
  const electronAPI = { kind: 'synthetic-electron-context' };
  const payload = { marker: 'second-argument' };
  const callback = async (electron, value) => {
    require('node:assert/strict').equal(electron.kind, 'synthetic-electron-context');
    require('node:assert/strict').equal(value.marker, 'second-argument');
    return value.marker;
  };
  assert.equal(await reviveMainCallback(callback, {})(electronAPI, payload), 'second-argument');
  const failure = async () => { throw new Error('serialized callback failure'); };
  await assert.rejects(reviveMainCallback(failure, {})(), /serialized callback failure/);
  const hostOnlyValue = 'host closure must not survive';
  const captured = () => hostOnlyValue;
  assert.throws(() => reviveMainCallback(captured, {})(), /hostOnlyValue is not defined/);
});
