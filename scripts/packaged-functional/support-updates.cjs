'use strict';

const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { boardText } = require('../packaged-functional-qa.cjs');
const support = require('../../electron/support.cjs');
const updates = require('../../electron/updates.cjs');
const egress = require('../../electron/net/egress.cjs');

const RELEASE = '1.3.1';
const PACKAGED_UPDATE_RELEASE = '1.3.2';
const HOURS = 60 * 60 * 1000;
const UPDATE_PATH = new URL(updates.RELEASES_API).pathname;

function requireContext(ctx) {
  for (const name of ['getPage', 'getApp', 'step', 'screenshot', 'main', 'dismissSupport', 'registerFixture', 'openFiles', 'restart', 'waitBoard']) {
    assert.equal(typeof ctx?.[name], 'function', `native support/update QA needs ctx.${name}`);
  }
  assert.ok(ctx.options && ctx.evidence, 'native support/update QA needs artifact identity and evidence');
}

function signedFixture(claim, paidAt, privateKey) {
  const payloadValue = { claim, paidAt, expiresAt: support.yearAfter(paidAt), version: 1 };
  const payload = Buffer.from(JSON.stringify(payloadValue)).toString('base64url');
  const signature = sign('sha256', Buffer.from(payload), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { payload, signature };
}

async function verifyReceiptContract() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const claim = '0123456789abcdef0123456789abcdef';
  const paidAt = Date.UTC(2024, 1, 29, 12);
  const receipt = signedFixture(claim, paidAt, privateKey);
  const expiresAt = support.yearAfter(paidAt);
  assert.equal(new Date(expiresAt).toISOString(), '2025-02-28T12:00:00.000Z', 'one-year expiry clamps leap day to the last valid day');
  assert.deepEqual(support.validateReceipt(receipt, claim, expiresAt - 1, jwk), {
    claim, paidAt, expiresAt, version: 1,
  });
  assert.equal(support.validateReceipt(receipt, claim, expiresAt, jwk), null, 'the receipt expires at the exact UTC boundary');
  assert.equal(support.validateReceipt(receipt, 'fedcba9876543210fedcba9876543210', expiresAt - 1, jwk), null, 'the receipt is bound to its local claim');
  assert.equal(support.validateReceipt({ ...receipt, signature: Buffer.alloc(64).toString('base64url') }, claim, expiresAt - 1, jwk), null, 'an invalid signature is inactive');
  return { verifier: 'production support verifier', key: 'ephemeral synthetic fixture key', fixedProductionPublicKey: false,
    utcBoundary: { paidAt: new Date(paidAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), activeAt: expiresAt - 1, inactiveAt: expiresAt } };
}

async function verifyUpdateContract() {
  const seen = [];
  const answer = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
  const olderVersions = ['1.2.0', '1.3.0', '1.3.1-rc.2'];
  for (const currentVersion of olderVersions) {
    const available = await updates.checkForUpdate({ currentVersion, fetchImpl: async (url, init) => {
      seen.push({ url: String(url), method: init.method, redirect: init.redirect, credentials: init.credentials,
        headers: Object.fromEntries(new Headers(init.headers).entries()) });
      return answer({ tag_name: 'v1.3.1', prerelease: false, draft: false, html_url: 'https://invalid.example/ignored' });
    } });
    assert.deepEqual(available, { status: 'available', version: RELEASE, tag: 'v1.3.1' }, `${currentVersion} can see the newer stable release`);
  }
  assert.ok(seen.every(request => request.url === updates.RELEASES_API && request.method === 'GET' && request.redirect === 'error' && request.credentials === 'omit'));
  assert.ok(seen.every(request => !Object.keys(request.headers).some(name => ['cookie', 'authorization', 'referer'].includes(name.toLowerCase()))), 'the fixed request includes no cookies, authorization or referrer');
  assert.equal(egress.PARTITION, 'trace-egress', 'the product uses its isolated in-memory egress partition');

  const prerelease = await updates.checkForUpdate({ currentVersion: '1.3.0', fetchImpl: async () => answer({ tag_name: 'v1.4.0-rc.2', prerelease: false, draft: false }) });
  assert.deepEqual(prerelease, { status: 'current' }, 'a prerelease is never offered as stable');
  const denied = await updates.checkForUpdate({ currentVersion: RELEASE, fetchImpl: async () => answer({ message: 'synthetic rate limit' }, 429, { 'retry-after': '1' }) });
  assert.equal(denied.status, 'unavailable');
  assert.equal(denied.retryAfterMs, 60_000, 'the retry delay is clamped to one minute');
  return { parser: 'production update checker', source: 'synthetic in-memory GitHub API replies', release: RELEASE,
    oldVersionsChecked: olderVersions, url: seen[0].url, method: seen[0].method, redirect: seen[0].redirect, credentials: seen[0].credentials,
    egressPartition: egress.PARTITION, cookieAuthorizationReferrerHeaders: false,
    prereleaseOffered: false, rateLimitRetryAfterMs: denied.retryAfterMs,
    releasePageOpen: 'not exercised by this transport fixture; packaged UI exercises only the blocked offline path' };
}

function keyRequiredXzzFixture() {
  const mainLength = 5 + 64;
  const netAt = 0x30 + 4 + mainLength;
  const data = new Uint8Array(netAt + 4 + 9);
  const view = new DataView(data.buffer);
  data.set(Buffer.from('XZZPCB', 'ascii'));
  // A synthetically encrypted component record asks for a session-only XZZ key. Its zeroed
  // payload is deliberately not a valid board and the test always skips the key request.
  view.setUint32(0x20, 0x10, true);
  view.setUint32(0x30, mainLength, true);
  data.set([0x07, 64, 0, 0, 0], 0x34);
  view.setUint32(0x28, netAt - 0x20, true);
  view.setUint32(netAt, 9, true);
  view.setUint32(netAt + 4, 1, true);
  data[netAt + 8] = 0x41;
  return data;
}

async function withVirtualReminderClock(page, action) {
  const state = await page.evaluate(() => {
    const originalNow = Date.now;
    const originalInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    const base = originalNow();
    window.__traceQaSupportClock = { delta: 0, callback: null, originalNow, originalInterval, originalClearInterval };
    Date.now = () => base + window.__traceQaSupportClock.delta;
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 60_000) {
        window.__traceQaSupportClock.callback = () => callback(...args);
        return 0x51a7;
      }
      return originalInterval(callback, delay, ...args);
    };
    window.clearInterval = id => { if (id !== 0x51a7) return originalClearInterval(id); };
    return { visible: document.visibilityState, focused: document.hasFocus() };
  });
  assert.equal(state.visible, 'visible', 'hourly reminder is tested while the packaged UI is visible');
  assert.equal(state.focused, true, 'hourly reminder is tested while the packaged UI has focus');
  try {
    return await action(async (delta) => {
      await page.evaluate(value => { window.__traceQaSupportClock.delta = value; }, delta);
      const callback = await page.evaluate(() => typeof window.__traceQaSupportClock.callback === 'function');
      assert.equal(callback, true, 'the actual SupportNotice interval was captured');
      await page.evaluate(() => window.__traceQaSupportClock.callback());
    });
  } finally {
    await page.evaluate(() => {
      const clock = window.__traceQaSupportClock;
      if (!clock) return;
      Date.now = clock.originalNow;
      window.setInterval = clock.originalInterval;
      window.clearInterval = clock.originalClearInterval;
      delete window.__traceQaSupportClock;
    });
  }
}

async function testSkippableReminder(ctx, page) {
  await withVirtualReminderClock(page, async (tick) => {
    await ctx.dismissSupport();
    await page.locator('[data-testid=support-button]').click();
    await page.waitForSelector('[data-testid=support-notice]', { timeout: 10_000 });
    const focus = await page.locator('[data-testid=support-not-now]').evaluate(node => node === document.activeElement);
    assert.equal(focus, true, 'the skip button takes initial focus');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=support-notice]').waitFor({ state: 'detached', timeout: 10_000 });

    await tick(HOURS - 1);
    assert.equal(await page.locator('[data-testid=support-notice]').count(), 0, 'the reminder does not repeat before one hour');

    await page.locator('[data-testid=settings-button]').click();
    await page.waitForSelector('[data-testid=settings-dialog]', { timeout: 10_000 });
    await tick(HOURS);
    assert.equal(await page.locator('[data-testid=support-notice]').count(), 0, 'the reminder defers while a modal is active');
    const done = page.locator('[data-testid=settings-dialog] button').last();
    await done.click();
    await page.waitForSelector('[data-testid=support-notice]', { timeout: 10_000 });
    await tick(HOURS);
    assert.equal(await page.locator('[data-testid=support-notice]').count(), 1, 'one deferred reminder appears after the dialog closes');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=support-notice]').waitFor({ state: 'detached', timeout: 10_000 });
    await tick(HOURS);
    assert.equal(await page.locator('[data-testid=support-notice]').count(), 0, 'repeated timer activation cannot reopen a dismissed notice in the same hour');

    const reminderBoard = await ctx.registerFixture('support-reminder-owned-baseline.cad', Buffer.from(boardText()));
    await ctx.openFiles([reminderBoard]);
    await page.waitForFunction(() => /support-reminder-owned-baseline\.cad/i.test(document.querySelector('.project-subtitle')?.textContent || ''), null, { timeout: 20_000 });
    await page.locator('[data-testid=board-pane] canvas').waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('[data-testid=search-input]').fill('U1');
    await waitForCurrentBoardComponentRow(page, 'U1');
    await page.locator('[data-testid=search-input]').press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-testid=hero-ref]')?.textContent?.trim() === 'U1', null, { timeout: 10_000 });
    await page.locator('[data-testid=add-note]').click();
    await page.waitForSelector('[data-testid=note-dialog]', { timeout: 10_000 });
    assert.match(await page.locator('[data-testid=note-dialog] h2').textContent(), /U1/, 'the editable note belongs to the explicitly selected part on the generated baseline board');
    await page.locator('#note-draft').fill('reminder modal owned note');
    await tick(2 * HOURS);
    assert.equal(await page.locator('[data-testid=support-notice]').count(), 0, 'the reminder defers while a note editor is active');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=note-dialog]').waitFor({ state: 'detached', timeout: 10_000 });
    await page.waitForSelector('[data-testid=support-notice]', { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=support-notice]').waitFor({ state: 'detached', timeout: 10_000 });

    const encryptedBoard = await ctx.registerFixture('support-reminder-key-required.xzz', keyRequiredXzzFixture());
    await ctx.openFiles([encryptedBoard]);
    await page.waitForSelector('[data-testid=key-dialog]', { timeout: 20_000 });
    await tick(3 * HOURS);
    assert.equal(await page.locator('[data-testid=support-notice]').count(), 0, 'the reminder defers during a live encrypted-board key request');
    await page.locator('[data-testid=key-skip]').click();
    await page.locator('[data-testid=key-dialog]').waitFor({ state: 'detached', timeout: 10_000 });
    await page.waitForSelector('[data-testid=support-notice]', { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=support-notice]').waitFor({ state: 'detached', timeout: 10_000 });
    await ctx.screenshot('support-reminder-deferred-during-key-request');
    await ctx.screenshot('support-reminder-skipped-and-deferred');
  });
}

async function waitForCurrentBoardComponentRow(page, ref) {
  await page.waitForFunction((expectedRef) => {
    const input = document.querySelector('[data-testid=search-input]');
    const pending = input?.parentElement?.querySelector('.spin');
    const row = [...document.querySelectorAll('[data-testid=search-row][data-source="board-components"]')]
      .find(candidate => candidate.querySelector('.component-ref')?.textContent?.trim() === expectedRef);
    return input?.value.trim() === expectedRef && !pending && !!row;
  }, ref, { timeout: 15_000 });
}

async function testSuccessfulPackagedUpdate(ctx, page) {
  const stable = { tag_name: `v${PACKAGED_UPDATE_RELEASE}`, prerelease: false, draft: false, html_url: 'https://invalid.example/ignored' };
  const transport = await ctx.main(async (electronAPI, { body }) => {
    require('node:assert/strict').ok(electronAPI, 'the packaged main context is the first main-callback argument');
    const { session } = require('electron');
    const partition = session.fromPartition('trace-egress', { cache: false });
    const previousNow = Date.now;
    const offset = 60_000;
    Date.now = () => previousNow() + offset;
    partition.fetch = async (url, init) => {
      globalThis.__traceQaUpdateReplies = (globalThis.__traceQaUpdateReplies || []).concat([{ url: String(url), method: init.method, credentials: init.credentials, redirect: init.redirect }]);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { offset };
  }, { body: stable });
  assert.equal(transport.offset, 60_000, 'the packaged main-process rate limit is advanced by a virtual main clock');
  try {
    const reply = await page.evaluate(() => window.traceDesktop.checkForUpdates());
    assert.deepEqual(reply, { status: 'available', version: PACKAGED_UPDATE_RELEASE }, 'the packaged main IPC returns the parsed newer stable update');
    const cachedReply = await page.evaluate(() => window.traceDesktop.checkForUpdates());
    assert.deepEqual(cachedReply, reply, 'an immediate second packaged IPC returns the cached successful answer');
    const cached = await ctx.main((electronAPI) => {
      require('node:assert/strict').ok(electronAPI, 'the packaged main context is the first main-callback argument');
      return globalThis.__traceQaUpdateReplies || [];
    });
    assert.equal(cached.length, 1, 'the immediate second packaged IPC stays inside cooldown without another fetch');
    await page.evaluate(() => window.traceDesktop.openUpdatePage());
    const external = await ctx.main((electronAPI) => {
      require('node:assert/strict').ok(electronAPI, 'the packaged main context is the first main-callback argument');
      const { app } = require('electron');
      const path = require('node:path');
      const { RELEASE_PAGE_BASE } = require(path.join(app.getAppPath(), 'electron', 'updates.cjs'));
      return {
      contextAvailable: Boolean(electronAPI),
      urls: globalThis.__traceQaExternalUrls || [],
      requests: globalThis.__traceQaUpdateReplies || [],
      releasePageBase: RELEASE_PAGE_BASE,
      };
    });
    assert.equal(external.contextAvailable, true, 'the packaged main context is the first main-callback argument');
    assert.equal(external.urls.at(-1), `${external.releasePageBase}v${PACKAGED_UPDATE_RELEASE}`, 'the validated tag opens only the fixed stable release page');
    assert.equal(external.requests.at(-1)?.url, updates.RELEASES_API, 'the real packaged egress transport saw only its fixed API endpoint');
    assert.equal(external.requests.at(-1)?.method, 'GET');
    assert.equal(external.requests.at(-1)?.credentials, 'omit');
    assert.equal(external.requests.at(-1)?.redirect, 'error');
    assert.equal(external.requests.length, 1, 'the successful reply used one rate-limited packaged request');
    await ctx.screenshot('stable-update-validated-release-page-stubbed');
    return { channel: 'real packaged update IPC handlers', parser: 'real packaged updater and egress response parser',
      mainRateLimit: 'real packaged cooldown exercised after a virtual 60-second advance', releasePage: `${updates.RELEASE_PAGE_BASE}v${PACKAGED_UPDATE_RELEASE}`,
      externalTraffic: 'none; session fetch and shell handoff were intercepted locally' };
  } finally {
    // A normal restart disposes this launch-scoped transport override before the next test step.
    await ctx.restart();
    page = ctx.getPage();
    assert.ok(page, 'the current packaged page is reacquired after the successful-update restart');
    await settleInactivePackagedStartup(page);
  }
}

async function installSyntheticReceiptService(ctx, fixture, { seed }) {
  return ctx.main(async (electronAPI, { fixture: value, seedValue }) => {
    require('node:assert/strict').ok(electronAPI, 'the packaged main context is the first main-callback argument');
    const { app, ipcMain } = require('electron');
    const path = require('node:path');
    const fs = require('node:fs/promises');
    const { createJsonStore } = require(path.join(app.getAppPath(), 'electron', 'store.cjs'));
    const { createSupportService } = require(path.join(app.getAppPath(), 'electron', 'support.cjs'));
    const store = createJsonStore({ directory: app.getPath('userData'), maxBytes: 8192, fs, trusted: true, t: key => key });
    const clock = { now: value.now };
    if (seedValue) await store.write('support-receipt.json', { claim: value.claim });
    const service = createSupportService({ store, now: () => clock.now, config: {
      enabled: true, endpoint: 'https://synthetic-receipts.invalid', publicKey: value.publicKey,
    }, egress: () => ({ request: async () => ({ ok: true, status: 200, body: Buffer.from(JSON.stringify(value.receipt)) }) }) });
    if (seedValue) {
      const receiptStatus = await service.check();
      if (receiptStatus.status !== 'verified') throw new Error('Synthetic configured receipt did not verify in the packaged service.');
    }
    ipcMain.removeHandler('trace:get-support-status');
    const rendererStatus = { nextRequest: 0, requests: [], replies: [] };
    ipcMain.handle('trace:get-support-status', async (event) => {
      const id = ++rendererStatus.nextRequest;
      const request = { id, senderId: event.sender.id, frameUrl: event.senderFrame?.url || null };
      rendererStatus.requests.push(request);
      try {
        const reply = await service.status();
        rendererStatus.replies.push({ id, reply });
        return reply;
      } catch (error) {
        rendererStatus.replies.push({ id, error: String(error?.message || error) });
        throw error;
      }
    });
    globalThis.__traceQaSyntheticReceipt = { service, store, clock, rendererStatus, label: 'synthetic configured receipt; not provider proof' };
    return { status: await service.status(), label: globalThis.__traceQaSyntheticReceipt.label };
  }, { fixture, seedValue: seed });
}

async function setSyntheticReceiptTime(ctx, now) {
  return ctx.main(async (electronAPI, { time }) => {
    require('node:assert/strict').ok(electronAPI, 'the packaged main context is the first main-callback argument');
    const fixture = globalThis.__traceQaSyntheticReceipt;
    if (!fixture?.clock) throw new Error('Synthetic support receipt clock is not installed.');
    fixture.clock.now = time;
    return await fixture.service.status();
  }, { time: now });
}

async function installExpiryRendererClockBeforeReload(page, boundary) {
  const marker = '__traceQaSupportExpiryClockNextNavigation';
  await page.addInitScript(({ expectedBoundary, sessionMarker }) => {
    if (sessionStorage.getItem(sessionMarker) !== 'armed') return;
    sessionStorage.removeItem(sessionMarker);
    const originalNow = Date.now;
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    const clock = { now: expectedBoundary - 1, boundary: expectedBoundary, callbacks: [], activeTimers: new Map(), fakeTimerIds: new Set(), nextTimerId: -1, originalNow, originalSetInterval, originalClearInterval };
    window.__traceQaSupportExpiryClock = clock;
    Date.now = () => clock.now;
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 60_000) {
        const id = clock.nextTimerId;
        clock.nextTimerId -= 1;
        const timer = { id, active: true, run: () => callback(...args) };
        clock.callbacks.push(timer);
        clock.activeTimers.set(id, timer);
        clock.fakeTimerIds.add(id);
        return id;
      }
      return originalSetInterval(callback, delay, ...args);
    };
    window.clearInterval = id => {
      if (clock.fakeTimerIds.has(id)) {
        const timer = clock.activeTimers.get(id);
        if (timer) {
          timer.active = false;
          clock.activeTimers.delete(id);
        }
        return;
      }
      originalClearInterval(id);
    };
  }, { expectedBoundary: boundary, sessionMarker: marker });
  await page.evaluate(sessionMarker => sessionStorage.setItem(sessionMarker, 'armed'), marker);
}

async function advanceExpiryRendererClock(page, boundary) {
  const result = await page.evaluate(async expectedBoundary => {
    const clock = window.__traceQaSupportExpiryClock;
    if (!clock) throw new Error('The one-navigation renderer expiry clock was not installed before reload.');
    if (clock.boundary !== expectedBoundary) throw new Error('Renderer expiry clock boundary does not match the synthetic receipt.');
    const activeBefore = [...clock.activeTimers.values()];
    if (activeBefore.length !== 1) throw new Error(`Expected only the actual support-status timer before expiry; found ${activeBefore.length} active 60-second timers.`);
    const supportStatusTimer = activeBefore[0];
    if (!supportStatusTimer.active || clock.activeTimers.get(supportStatusTimer.id) !== supportStatusTimer) throw new Error('The support-status timer identity changed before expiry.');
    clock.now = expectedBoundary;
    supportStatusTimer.run();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { now: Date.now(), boundary: clock.boundary, timerCallbacks: activeBefore.length,
      timerId: supportStatusTimer.id, firedTimerId: supportStatusTimer.id, fired: true,
      activeTimersAfter: [...clock.activeTimers.keys()] };
  }, boundary);
  assert.equal(result.now, boundary, 'the actual support-status timer observed the exact expiry clock');
  assert.equal(result.boundary, boundary);
  assert.equal(result.timerCallbacks, 1, 'exactly one active support-status timer existed before expiry');
  assert.equal(result.firedTimerId, result.timerId, 'the captured support-status timer identity was fired');
  assert.equal(result.fired, true);
  return result;
}

async function restoreExpiryRendererClock(page) {
  await page.evaluate(() => {
    sessionStorage.removeItem('__traceQaSupportExpiryClockNextNavigation');
    const clock = window.__traceQaSupportExpiryClock;
    if (!clock) return;
    Date.now = clock.originalNow;
    window.setInterval = clock.originalSetInterval;
    window.clearInterval = clock.originalClearInterval;
    for (const timer of clock.activeTimers.values()) timer.active = false;
    clock.activeTimers.clear();
    clock.fakeTimerIds.clear();
    delete window.__traceQaSupportExpiryClock;
  });
}

async function beginRendererStatusObservation(ctx) {
  return ctx.main(async (electronAPI) => {
    require('node:assert/strict').ok(electronAPI, 'the packaged main context is the first main-callback argument');
    const observation = globalThis.__traceQaSyntheticReceipt?.rendererStatus;
    if (!observation) throw new Error('Synthetic support status instrumentation is not installed.');
    observation.requests.length = 0;
    observation.replies.length = 0;
    return true;
  });
}

async function awaitRendererInitialStatusReply(ctx) {
  return ctx.main(async (electronAPI) => {
    require('node:assert/strict').ok(electronAPI, 'the packaged main context is the first main-callback argument');
    const observation = globalThis.__traceQaSyntheticReceipt?.rendererStatus;
    if (!observation) throw new Error('Synthetic support status instrumentation is not installed.');
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      const request = observation.requests[0];
      const reply = observation.replies.find(candidate => candidate.id === request?.id);
      if (request && reply) {
        if (reply.error) throw new Error(`Renderer initial support status request failed: ${reply.error}`);
        return { request, reply: reply.reply };
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for the renderer initial support status IPC reply.');
  });
}

async function waitForCommittedSupportRender(page) {
  await page.waitForFunction(() => {
    const app = document.querySelector('[data-testid=app]');
    const canvas = document.querySelector('[data-testid=board-pane] canvas');
    return app && getComputedStyle(app).visibility !== 'hidden' && canvas;
  }, null, { timeout: 20_000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function skipVisibleStartupNotice(page) {
  const heart = page.locator('[data-testid=support-button]');
  const notice = page.locator('[data-testid=support-notice]');
  await heart.waitFor({ state: 'visible', timeout: 10_000 });
  await notice.waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('[data-testid=support-not-now]').click();
  await notice.waitFor({ state: 'detached', timeout: 10_000 });
}

async function settleInactivePackagedStartup(page) {
  await waitForCommittedSupportRender(page);
  await skipVisibleStartupNotice(page);
  return { ready: true, supportHeartVisible: true, startupNotice: 'shown and skipped' };
}

async function waitForOwnedReceiptBoard(ctx, page, target) {
  await ctx.waitBoard({ components: 3, pins: 6, nets: 2, target });
  await page.waitForFunction(fileName => {
    const subtitle = document.querySelector('.project-subtitle')?.textContent || '';
    return subtitle.toLowerCase().includes(fileName.toLowerCase());
  }, target.split(/[\\/]/).at(-1), { timeout: 20_000 });
  const source = await page.locator('.project-heading').getAttribute('title');
  await assertSameCanonicalOwnedPath(source, target);
}

async function assertSameCanonicalOwnedPath(source, target, { realpath = fs.realpath, platform = process.platform } = {}) {
  assert.equal(typeof source, 'string', 'the packaged project title includes its source path');
  const [actualSource, actualTarget] = await Promise.all([realpath(source), realpath(target)]);
  const comparable = value => platform === 'win32' ? value.toLowerCase() : value;
  assert.equal(comparable(actualSource), comparable(actualTarget), 'the packaged project title identifies the same canonical owned fixture file');
  return { source: actualSource, target: actualTarget };
}

async function testVerifiedReceiptSuppressionAcrossRestart(ctx, page) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const claim = '89abcdef012345670123456789abcdef';
  const paidAt = Date.now();
  const expiresAt = support.yearAfter(paidAt);
  const receipt = signedFixture(claim, paidAt, privateKey);
  const fixture = { claim, now: paidAt, expiresAt, publicKey: publicKey.export({ format: 'jwk' }), receipt };
  const ownedBoard = await ctx.registerFixture('support-receipt-owned-baseline.cad', Buffer.from(boardText()));
  await ctx.openFiles([ownedBoard]);
  await waitForOwnedReceiptBoard(ctx, page, ownedBoard);
  await ctx.restart();
  page = ctx.getPage();
  assert.ok(page, 'the normal restart reacquires the current packaged page on the tracked owned board');
  await waitForOwnedReceiptBoard(ctx, page, ownedBoard);
  await ctx.dismissSupport();

  const inactive = await installSyntheticReceiptService(ctx, fixture, { seed: false });
  assert.deepEqual(inactive.status, { status: 'inactive', expiresAt: null, available: true }, 'the inactive synthetic status is a positive control for the support UI');
  await beginRendererStatusObservation(ctx);
  await page.reload();
  page = ctx.getPage();
  const inactiveInitial = await awaitRendererInitialStatusReply(ctx);
  assert.deepEqual(inactiveInitial.reply, inactive.status, 'the actual renderer bootstrap receives the inactive synthetic status');
  await waitForCommittedSupportRender(page);
  await page.locator('[data-testid=support-button]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('[data-testid=support-notice]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('[data-testid=support-not-now]').click();
  await page.locator('[data-testid=support-notice]').waitFor({ state: 'detached', timeout: 10_000 });
  await page.locator('[data-testid=support-button]').click();
  await page.locator('[data-testid=support-notice]').waitFor({ state: 'visible', timeout: 10_000 });
  await ctx.screenshot('inactive-startup-notice-skipped-manual-heart-opens-reminder');
  await page.locator('[data-testid=support-not-now]').click();
  await page.locator('[data-testid=support-notice]').waitFor({ state: 'detached', timeout: 10_000 });

  const initial = await installSyntheticReceiptService(ctx, fixture, { seed: true });
  assert.equal(initial.status.status, 'verified', 'the real packaged receipt service verifies the synthetic-key receipt and stores it locally');
  await beginRendererStatusObservation(ctx);
  await page.reload();
  page = ctx.getPage();
  const verifiedInitial = await awaitRendererInitialStatusReply(ctx);
  assert.deepEqual(verifiedInitial.reply, { status: 'verified', expiresAt, available: true }, 'the actual renderer bootstrap receives the verified synthetic status');
  await waitForCommittedSupportRender(page);
  await page.waitForFunction(() => document.querySelector('[data-testid=support-button]') === null, null, { timeout: 20_000 });
  assert.equal(await page.locator('[data-testid=support-notice]').count(), 0, 'verified synthetic status suppresses the packaged notice after the renderer has committed two redraw frames');
  const beforeRestart = verifiedInitial.reply;

  await ctx.restart();
  page = ctx.getPage();
  assert.ok(page, 'the current packaged page is reacquired after normal restart');
  await waitForOwnedReceiptBoard(ctx, page, ownedBoard);
  await ctx.dismissSupport();
  const afterRestart = await installSyntheticReceiptService(ctx, fixture, { seed: false });
  assert.deepEqual(afterRestart.status, beforeRestart, 'the persisted claim and signed receipt remain verified after a normal packaged restart');
  await beginRendererStatusObservation(ctx);
  await page.reload();
  page = ctx.getPage();
  const restartedInitial = await awaitRendererInitialStatusReply(ctx);
  assert.deepEqual(restartedInitial.reply, beforeRestart, 'the actual renderer bootstrap receives the persisted verified status after restart');
  await waitForCommittedSupportRender(page);
  await page.waitForFunction(() => document.querySelector('[data-testid=support-button]') === null, null, { timeout: 20_000 });
  assert.equal(await page.locator('[data-testid=support-notice]').count(), 0, 'the verified synthetic status still suppresses the notice after restart and committed rendering');
  await ctx.screenshot('synthetic-receipt-suppression-after-restart');

  const beforeExpiry = await setSyntheticReceiptTime(ctx, expiresAt - 1);
  assert.deepEqual(beforeExpiry, { status: 'verified', expiresAt, available: true }, 'the real service verifies the unchanged signed receipt immediately before expiry');
  await installExpiryRendererClockBeforeReload(page, expiresAt);
  let expiryEvidence;
  try {
    await beginRendererStatusObservation(ctx);
    await page.reload();
    page = ctx.getPage();
    const beforeExpiryBootstrap = await awaitRendererInitialStatusReply(ctx);
    assert.deepEqual(beforeExpiryBootstrap.reply, beforeExpiry, 'the actual renderer bootstrap IPC receives verified status immediately before expiry');
    await waitForCommittedSupportRender(page);
    await page.waitForFunction(() => document.querySelector('[data-testid=support-button]') === null, null, { timeout: 20_000 });
    assert.equal(await page.locator('[data-testid=support-notice]').count(), 0, 'verified status keeps the heart and notice hidden in committed pre-expiry frames');

    const atExpiryService = await setSyntheticReceiptTime(ctx, expiresAt);
    assert.deepEqual(atExpiryService, { status: 'inactive', expiresAt: null, available: true }, 'the real service treats the unchanged signed receipt as expired at the exact boundary');
    const timerEvidence = await advanceExpiryRendererClock(page, expiresAt);
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid=support-button]')) && Boolean(document.querySelector('[data-testid=support-notice]')), null, { timeout: 10_000 });
    await waitForCommittedSupportRender(page);
    await page.locator('[data-testid=support-button]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('[data-testid=support-notice]').waitFor({ state: 'visible', timeout: 10_000 });
    await beginRendererStatusObservation(ctx);
    const expiredStatus = await page.evaluate(() => window.traceDesktop.getSupportStatus());
    assert.deepEqual(expiredStatus, atExpiryService, 'renderer IPC returns the real expired service status at the boundary');
    const manuallyObservedExpiredReply = await awaitRendererInitialStatusReply(ctx);
    assert.deepEqual(manuallyObservedExpiredReply.reply, atExpiryService, 'the manually requested renderer IPC reply matches the expired service status');
    await page.locator('[data-testid=support-not-now]').click();
    await page.locator('[data-testid=support-notice]').waitFor({ state: 'detached', timeout: 10_000 });
    await page.locator('[data-testid=support-button]').waitFor({ state: 'visible', timeout: 10_000 });
    await ctx.screenshot('synthetic-receipt-expiry-timer-restores-skippable-notice');
    expiryEvidence = { beforeExpiryBootstrap, atExpiryService, manuallyObservedExpiredReply, timer: timerEvidence,
      frames: 'two animation frames after the actual useSupportStatus 60-second timer callback', heartVisible: true,
      noticeVisibleAtExpiry: true, ordinarySkipRemains: true };
  } finally {
    await restoreExpiryRendererClock(page);
  }
  await ctx.restart();
  page = ctx.getPage();
  assert.ok(page, 'the current packaged page is reacquired after the receipt restart');
  return { service: 'real packaged createSupportService and P-256 receipt verifier',
    configuredKey: 'fresh synthetic P-256 public key', providerPayment: 'not exercised; no provider proof',
    profileStorage: 'claim and signature stored by packaged JSON store in isolated profile',
    expiry: { paidAt: new Date(paidAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), calendarYear: true },
    restart: 'normal quit and relaunch of the same packaged artifact/profile with the owned fixture as tracked launch target', buttonHidden: true, noticeHidden: true,
    rendererBootstrap: { inactivePositiveControl: inactiveInitial, verified: verifiedInitial, afterRestart: restartedInitial, committedRender: 'two animation frames after the app and owned canvas became visible', inactiveStartupNotice: 'shown and skipped; manual heart then reopened the reminder' },
    annualExpiry: expiryEvidence,
    seam: 'test-only replacement of get-support-status IPC with a real packaged service configured using a synthetic key; controlled reload; not provider proof' };
}

async function testNetworkConsentAndUpdateFailure(ctx, page) {
  const bridge = await page.evaluate(async () => ({
    methods: {
      settings: typeof window.traceDesktop?.getSettings,
      checkForUpdates: typeof window.traceDesktop?.checkForUpdates,
      openUpdatePage: typeof window.traceDesktop?.openUpdatePage,
      network: typeof window.traceDesktop?.getNetworkActivity,
    },
    settings: await window.traceDesktop?.getSettings(),
    activity: await window.traceDesktop?.getNetworkActivity(),
  }));
  for (const method of ['settings', 'checkForUpdates', 'openUpdatePage', 'network']) assert.equal(bridge.methods[method], 'function', `packaged bridge exposes ${method}`);
  assert.equal(bridge.settings.updateCheck, false, 'the packaged QA profile starts with automatic update checks opted out');
  const updateFeature = bridge.activity.features.find(feature => feature.id === 'update-check');
  assert.ok(updateFeature, 'the registered update feature is visible in network activity');
  assert.ok(updateFeature.hosts.includes('api.github.com'), 'the update feature reports its fixed public host');
  assert.equal(updateFeature.enabled, false, 'the automatic update feature starts disabled in the QA profile');

  await page.locator('[data-testid=settings-button]').click();
  await page.waitForSelector('[data-testid=settings-dialog]', { timeout: 10_000 });
  const setting = page.locator('[data-testid=update-check-switch]');
  assert.equal(await setting.isChecked(), false);
  await page.locator('[data-testid=network-feature-update-check] [data-state=off]').waitFor({ state: 'attached', timeout: 10_000 });
  await page.locator('[data-testid=network-activity-toggle]').click();
  await page.locator('[data-testid=network-log]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('[data-testid=update-check-now]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid=update-check-status]')?.textContent || '').trim().length > 0, null, { timeout: 20_000 });
  assert.equal(await page.locator('[data-testid=update-check-download]').count(), 0, 'an offline failure does not offer a download');

  assert.ok(ctx.getApp(), 'the current packaged Electron process remains attached');
  const report = await page.evaluate(path => window.traceDesktop.getNetworkActivity().then(value => ({ ...value, expectedPath: path })), UPDATE_PATH);
  const updateEntries = report.entries.filter(entry => entry.feature === 'update-check');
  assert.ok(updateEntries.length > 0, 'the explicit Check now action is recorded');
  assert.ok(updateEntries.every(entry => entry.host === 'api.github.com' && entry.path === report.expectedPath), 'the activity log contains only the fixed API host/path, without a query');
  assert.ok(updateEntries.every(entry => entry.outcome !== 'ok'), 'the synthetic packaged run cannot reach the external service');
  assert.ok(updateEntries.every(entry => !JSON.stringify(entry).includes('client_reference_id')), 'the activity log does not include support reference query data');

  await setting.check();
  await page.waitForFunction(() => window.traceDesktop.getSettings().then(settings => settings.updateCheck === true), null, { timeout: 10_000 });
  await page.locator('[data-testid=network-feature-update-check] [data-state=on]').waitFor({ state: 'attached', timeout: 10_000 });
  await setting.uncheck();
  await page.waitForFunction(() => window.traceDesktop.getSettings().then(settings => settings.updateCheck === false), null, { timeout: 10_000 });
  await page.locator('[data-testid=network-feature-update-check] [data-state=off]').waitFor({ state: 'attached', timeout: 10_000 });

  const opened = await page.evaluate(async () => {
    try { await window.traceDesktop.openUpdatePage(); return { rejected: false }; }
    catch { return { rejected: true }; }
  });
  assert.equal(opened.rejected, true, 'the main process does not open a release page until a validated stable update exists');
  await ctx.screenshot('network-consent-and-update-failure');
  await page.locator('[data-testid=settings-dialog] button').last().click();
  return { startupUpdateCheck: 'opted out in the packaged QA profile', manualCheck: 'synthetic network is blocked before external access',
    updateActivityEntries: updateEntries.length, host: updateFeature.hosts, switch: 'enabled and revoked through Settings',
    noDownloadOrInstall: true, releasePageWithoutValidatedTag: 'rejected', profile: 'the QA profile is isolated by the core runner' };
}

async function run(ctx) {
  requireContext(ctx);
  const localEvidence = await ctx.step('synthetic signed receipt and one-calendar-year verifier boundaries', verifyReceiptContract);
  const updateEvidence = await ctx.step('stable updater parsing, prerelease refusal and synthetic rate-limit backoff', verifyUpdateContract);
  let page = ctx.getPage();
  assert.ok(page, 'a live packaged renderer is required');
  await ctx.step('hourly support reminder is skippable, virtual-clock driven and deferred during a modal', () => testSkippableReminder(ctx, page));
  const networkEvidence = await ctx.step('packaged opt-in update consent, activity, offline failure and release-page guard', () => testNetworkConsentAndUpdateFailure(ctx, page));
  const successfulUpdate = await ctx.step('successful stable update through packaged IPC with local transport and external-open stubs', () => testSuccessfulPackagedUpdate(ctx, page));
  page = ctx.getPage();
  const verifiedSuppression = await ctx.step('synthetic configured receipt verifies in packaged service and suppresses UI across normal restart', () => testVerifiedReceiptSuppressionAcrossRestart(ctx, page));
  page = ctx.getPage();
  const result = {
    receipt: localEvidence,
    updater: updateEvidence,
    packagedUi: networkEvidence,
    successfulPackagedUpdate: successfulUpdate,
    syntheticReceiptSuppression: verifiedSuppression,
    productionReceiptKey: 'not exercised; receipt crypto used a fresh synthetic fixture key',
    providerAndNetwork: 'no provider request or external network access; updater replies were local synthetic fixtures and packaged request was blocked',
    platformAcceptance: 'pending exact final Windows, macOS and Linux artifacts',
  };
  ctx.evidence.supportUpdates = result;
  return result;
}

module.exports = Object.freeze({ run, testSuccessfulPackagedUpdate, installSyntheticReceiptService,
  waitForCurrentBoardComponentRow, beginRendererStatusObservation, awaitRendererInitialStatusReply,
  assertSameCanonicalOwnedPath, settleInactivePackagedStartup, skipVisibleStartupNotice,
  setSyntheticReceiptTime, installExpiryRendererClockBeforeReload, advanceExpiryRendererClock, restoreExpiryRendererClock });
