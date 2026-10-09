'use strict';

// Isolated renderer interaction audit; product files and user preferences are untouched.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.TRACE_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results');
const URL = process.env.TRACE_QA_URL || 'http://127.0.0.1:5173';
const fixture = `$HEADER
GENCAD 1.4
UNITS MM
ORIGIN 0 0
$ENDHEADER
$BOARD
RECTANGLE 0 0 40 30
$ENDBOARD
$PADS
PAD P ROUND -1
CIRCLE 0 0 0.2
$ENDPADS
$PADSTACKS
PADSTACK PS 0
PAD P TOP 0 0
$ENDPADSTACKS
$SHAPES
SHAPE S
RECTANGLE -2 -1 4 2
PIN 1 PS -1 0 TOP 0 0
PIN 2 PS 1 0 TOP 0 0
$ENDSHAPES
$COMPONENTS
COMPONENT R1
PLACE 10 20
LAYER TOP
ROTATION 0
SHAPE S 0 0
DEVICE D
COMPONENT R2
PLACE 30 10
LAYER TOP
ROTATION 0
SHAPE S 0 0
DEVICE D
COMPONENT R3
PLACE 10 10
LAYER BOTTOM
ROTATION 0
SHAPE S 0 0
DEVICE D
$ENDCOMPONENTS
$DEVICES
DEVICE D
VALUE "10 kOhm"
PACKAGE "0402"
$ENDDEVICES
$SIGNALS
SIGNAL GND
NODE R1 1
NODE R2 1
NODE R3 1
SIGNAL POWER
NODE R1 2
NODE R2 2
SIGNAL OTHER
NODE R3 2
$ENDSIGNALS
`;
const boardPayload = (name, text) => {
  const data = Buffer.from(text, 'utf8');
  return { name, path: `qa://${name}`, dataBase64: data.toString('base64'), key: createHash('sha256').update(data).digest('hex') };
};
const payloads = {
  A: boardPayload('Renderer-A.gcd', fixture),
  B: boardPayload('Renderer-B.gcd', fixture.replaceAll('R1', 'X1').replaceAll('R2', 'X2').replaceAll('R3', 'X3').replace('RECTANGLE 0 0 40 30', 'RECTANGLE 0 0 80 40')),
};
const report = { startedAt: new Date().toISOString(), runtime: (process.env.TRACE_BROWSER_CHANNEL || 'Chromium') + ' / Playwright', url: URL, fixture: 'Synthetic GENCAD: 3 components, 6 real round pads, 3 nets', checks: [] };

async function turn(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function open(browser, supportOnly = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(payloads => {
    const listeners = new Set();
    const filePayload = payload => ({ name: payload.name, path: payload.path, data: Uint8Array.from(atob(payload.dataBase64), char => char.charCodeAt(0)), key: payload.key });
    window.__rendererQA = { board: null, initialBoardCalls: 0, workerMessages: [], payloadBytes: atob(payloads.A.dataBase64).length, deliver: key => listeners.forEach(listener => listener(filePayload(payloads[key]))) };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); this.addEventListener('message', event => { window.__rendererQA.workerMessages.push(event.data); if (event.data?.board) window.__rendererQA.board = event.data.board; }); }
    };
    window.traceDesktop = {
      openBoard: async () => null, readBoard: async () => null, acceptBoard: async () => {}, initialBoard: async () => { window.__rendererQA.initialBoardCalls++; return filePayload(payloads.A); },
      recentBoards: async () => [], getSettings: async () => ({ language: 'hu', theme: 'dark', layout: 'workshop', motion: false, showLabels: true, showConnections: true }),
      saveSettings: async () => {}, getNotes: async () => [], saveNotes: async () => {}, minimize() {}, maximize() {}, close() {},
      isMaximized: async () => false, onMaximized: () => () => {}, droppedFilePath: () => '',
      onOpenBoard(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
  }, payloads);
  if (supportOnly) await page.goto(`${URL}/tests/fixtures/support-verification-qa.html`, { waitUntil: 'networkidle' });
  else {
    await page.goto(URL, { waitUntil: 'networkidle' });
    const supportNotice = page.getByTestId('support-notice');
    if (await supportNotice.count()) await page.getByTestId('support-not-now').click();
    try { await page.waitForFunction(() => window.__rendererQA.board?.name === 'Renderer-A', null, { timeout: 10000 }); }
    catch (error) {
      const state = await page.evaluate(() => ({ title: document.title, body: document.body.innerText, board: window.__rendererQA.board, initialBoardCalls: window.__rendererQA.initialBoardCalls, payloadBytes: window.__rendererQA.payloadBytes, workerMessages: window.__rendererQA.workerMessages.map(message => ({ keys: Object.keys(message ?? {}), error: message?.error, formatError: message?.formatError, progress: message?.progress, format: message?.board?.format })) }));
      throw new Error(`${error.message}; initial fixture never became ready: ${JSON.stringify(state)}; browser errors: ${errors.join(' | ')}`);
    }
    await page.locator('[data-testid="status-coords"]').waitFor();
    await turn(page);
  }
  return { context, page, errors };
}
async function model(page, rotation = 0, mirrored = false) {
  return page.evaluate(async ({ rotation, mirrored }) => {
    const geometry = await import('/src/lib/geometry.ts');
    const canvas = document.querySelector('canvas.board-canvas');
    const rect = canvas.getBoundingClientRect().toJSON();
    const board = window.__rendererQA.board;
    const view = geometry.fitView(board.bounds, rect.width, rect.height);
    view.rotation = rotation; view.mirrored = mirrored;
    return { board, view, rect };
  }, { rotation, mirrored });
}
async function project(page, point, state) {
  return page.evaluate(async ({ point, state }) => {
    const geometry = await import('/src/lib/geometry.ts');
    return geometry.boardToScreen(point, state.view, state.rect.width, state.rect.height);
  }, { point, state });
}
async function padVisible(page, point) {
  return page.locator('canvas.board-canvas').evaluate((canvas, point) => {
    const dpr = canvas.width / canvas.clientWidth;
    const x = Math.round(point.x * dpr), y = Math.round(point.y * dpr);
    const pixels = canvas.getContext('2d').getImageData(x - 3, y - 3, 7, 7).data;
    let found = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index] > 190 && pixels[index + 1] > 195 && pixels[index + 2] > 175) found++;
    return found;
  }, point);
}
async function baseHash(page) {
  return page.locator('canvas.board-canvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (const byte of data) hash = Math.imul(hash ^ byte, 16777619);
    return hash >>> 0;
  });
}
async function run(browser, name, work, supportOnly = false) {
  const instance = await open(browser, supportOnly);
  const start = Date.now();
  try {
    const details = await work(instance.page);
    assert.deepEqual(instance.errors, []);
    report.checks.push({ name, passed: true, durationMs: Date.now() - start, details });
    console.log(`PASS ${name}`);
  } catch (error) {
    const image = `renderer-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-failure.png`;
    await instance.page.screenshot({ path: path.join(OUT, image) }).catch(() => {});
    report.checks.push({ name, passed: false, durationMs: Date.now() - start, error: error.message, screenshot: image, browserErrors: instance.errors });
    console.log(`FAIL ${name}: ${error.message}`);
  } finally { await instance.context.close(); }
}

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.TRACE_BROWSER_CHANNEL || undefined, headless: true });
  try {
    if (process.env.TRACE_QA_SUPPORT_RETRY === '1') {
      await run(browser, 'Support verification retry keeps focus and announces recovery', async page => {
        await page.evaluate(async () => {
          window.traceDesktop = {};
          let call = 0;
          window.__supportPrepareCount = () => call;
          window.traceDesktop.prepareSupport = () => call++ === 0
            ? Promise.resolve({ status: 'unavailable', expiresAt: null, available: true, code: '' })
            : new Promise(resolve => { window.__resolveSupport = resolve; });
          const [reactModule, reactDomModule, { default: SupportVerification }, { createTranslator }] = await Promise.all([
            import('/node_modules/.vite/deps/react.js'), import('/node_modules/.vite/deps/react-dom_client.js'), import('/src/components/SupportVerification.tsx'), import('/src/lib/i18n.ts'),
          ]);
          window.__supportReact = reactModule.default ?? reactModule;
          const createRoot = reactDomModule.createRoot ?? reactDomModule.default?.createRoot;
          window.__createSupportRoot = createRoot;
          const host = document.createElement('div');
          host.id = 'support-retry-test';
          document.body.append(host);
          window.__supportRoot = createRoot(host);
          window.__supportRoot.render(window.__supportReact.createElement(SupportVerification, { t: createTranslator('en') }));
        });
        const retry = page.getByTestId('support-retry');
        await retry.waitFor();
        assert.match(await page.getByRole('status').innerText(), /Payment verification is unavailable/);
        assert.equal(await page.getByTestId('support-verification').getByRole('status').count(), 1, 'stable verification wrapper scopes the live status');
        assert.equal(await page.getByTestId('support-verification').getByTestId('support-verification-controls').count(), 1, 'stable verification wrapper contains its busy controls');
        assert.equal(await page.getByRole('status').evaluate(status => status.closest('[aria-busy="true"]')), null, 'live status stays outside every busy subtree');
        await retry.focus();
        await page.evaluate(() => {
          const button = document.querySelector('[data-testid="support-retry"]');
          button.click(); button.click();
        });
        await page.waitForFunction(() => document.querySelector('[data-testid="support-retry"]')?.getAttribute('aria-disabled') === 'true');
        assert.equal(await page.evaluate(() => window.__supportPrepareCount()), 2, 'same-turn repeated activation starts only one retry preparation');
        assert.equal(await page.getByTestId('support-retry').count(), 1, 'Retry remains focused and present during preparation');
        assert.equal(await page.getByTestId('support-retry').evaluate(button => document.activeElement === button), true);
        assert.equal(await page.getByTestId('support-verification-controls').getAttribute('aria-busy'), 'true');
        assert.match(await page.getByRole('status').innerText(), /Retrying payment verification/);
        assert.equal(await page.getByRole('status').evaluate(status => status.closest('[aria-busy="true"]')), null, 'pending announcement has no busy ancestor');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => window.__supportPrepareCount()), 2, 'repeated Enter activation does not restart preparation');
        await page.evaluate(() => window.__resolveSupport({ status: 'inactive', expiresAt: null, available: true, code: 'a'.repeat(32) }));
        await page.getByTestId('support-verify').waitFor();
        assert.equal(await page.getByTestId('support-verify').evaluate(button => document.activeElement === button), true, 'focus moves to the next useful action after recovery');

        await page.evaluate(async () => {
          window.__supportRoot.unmount();
          const host = document.createElement('div');
          host.id = 'support-retry-test-again';
          document.body.append(host);
          window.__supportRoot = window.__createSupportRoot(host);
          let call = 0;
          window.traceDesktop.prepareSupport = () => call++ === 0
            ? Promise.resolve({ status: 'unavailable', expiresAt: null, available: true, code: '' })
            : new Promise(resolve => { window.__resolveSupport = resolve; });
          const { default: SupportVerification } = await import('/src/components/SupportVerification.tsx');
          window.__supportRoot.render(window.__supportReact.createElement(SupportVerification, { t: (key) => key }));
          const elsewhere = document.createElement('button');
          elsewhere.textContent = 'Unrelated action';
          elsewhere.id = 'unrelated-focus';
          document.body.append(elsewhere);
        });
        const retryAgain = page.getByTestId('support-retry');
        await retryAgain.waitFor();
        await retryAgain.focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('[data-testid="support-retry"]')?.getAttribute('aria-disabled') === 'true');
        await page.locator('#unrelated-focus').focus();
        await page.evaluate(() => window.__resolveSupport({ status: 'inactive', expiresAt: null, available: true, code: 'b'.repeat(32) }));
        await page.getByTestId('support-verify').waitFor();
        assert.equal(await page.locator('#unrelated-focus').evaluate(button => document.activeElement === button), true, 'recovery does not steal focus from an action the user chose');

        await page.evaluate(async () => {
          window.__supportRoot.unmount();
          const host = document.createElement('div');
          document.body.append(host);
          window.__supportRoot = window.__createSupportRoot(host);
          let call = 0;
          window.traceDesktop.prepareSupport = () => call++ === 0
            ? Promise.resolve({ status: 'unavailable', expiresAt: null, available: true, code: '' })
            : new Promise(resolve => { window.__resolveSupport = resolve; });
          window.__closed = 0;
          const [{ SupportDialog }, { createTranslator }] = await Promise.all([
            import('/src/components/SupportNotice.tsx'), import('/src/lib/i18n.ts'),
          ]);
          window.__supportRoot.render(window.__supportReact.createElement(SupportDialog, {
            t: createTranslator('en'), open: async () => true,
            onClose: () => { window.__closed++; window.__supportRoot.unmount(); },
          }));
        });
        await page.getByTestId('support-retry').waitFor();
        await page.getByTestId('support-retry').focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('[data-testid="support-retry"]')?.getAttribute('aria-disabled') === 'true');
        await page.getByTestId('support-not-now').click();
        assert.equal(await page.evaluate(() => !document.querySelector('[data-testid="support-notice"]')?.open), true, 'Not now closes during a pending retry');
        assert.equal(await page.evaluate(() => window.__closed), 1);

        await page.evaluate(async () => {
          const host = document.createElement('div');
          document.body.append(host);
          window.__supportRoot = window.__createSupportRoot(host);
          let call = 0;
          window.traceDesktop.prepareSupport = () => call++ === 0
            ? Promise.resolve({ status: 'unavailable', expiresAt: null, available: true, code: '' })
            : new Promise(resolve => { window.__resolveSupport = resolve; });
          const { SupportDialog } = await import('/src/components/SupportNotice.tsx');
          window.__supportRoot.render(window.__supportReact.createElement(SupportDialog, {
            t: (key) => key, open: async () => true,
            onClose: () => { window.__closed++; window.__supportRoot.unmount(); },
          }));
        });
        await page.getByTestId('support-retry').waitFor();
        await page.getByTestId('support-retry').focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('[data-testid="support-retry"]')?.getAttribute('aria-disabled') === 'true');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => !document.querySelector('[data-testid="support-notice"]')?.open), true, 'Escape closes during a pending retry');
        assert.equal(await page.evaluate(() => window.__closed), 2);
        return { retryFocusableWhileBusy: true, busyAndResultAnnounced: true, pendingStatusOutsideBusy: true, rapidAndEnterRetriesDeduplicated: true, recoveryFocus: 'Verify', unrelatedFocusPreserved: true, notNowAndEscapeCloseWhileBusy: true };
      }, true);
    } else {
    await run(browser, 'Quarter rotation bottom mirror and anchored zoom preserve pad geometry', async page => {
      const state = await model(page, 90, true);
      await page.keyboard.press('r');
      await page.getByTestId('side-bottom').click();
      await turn(page);
      const pin = state.board.pins.find(pin => pin.componentId === 'R3' && pin.number === '1');
      const anchor = await project(page, pin, state);
      assert.ok(await padVisible(page, anchor) > 0, 'Rotated bottom pad should appear at the exact projected coordinate');
      await page.mouse.move(state.rect.x + anchor.x, state.rect.y + anchor.y);
      await page.mouse.wheel(0, -120); await turn(page);
      assert.ok(await padVisible(page, anchor) > 0, 'Wheel zoom should retain the exact pad under the cursor');
      const coordinates = await page.locator('.statusbar').innerText();
      const cursor = (await page.locator('.status-center').innerText()).match(/X (-?\d+,\d+) · Y (-?\d+,\d+) mm/);
      assert.ok(cursor, 'Cursor coordinates should update after zoom');
      assert.ok(Math.abs(parseFloat(cursor[1].replace(',', '.')) - pin.x) < 1 / state.view.scale);
      assert.ok(Math.abs(parseFloat(cursor[2].replace(',', '.')) - pin.y) < 1 / state.view.scale);
      const expectedZoom = await page.evaluate(async state => {
        const geometry = await import('/src/lib/geometry.ts');
        const fit = geometry.fitView(state.board.bounds, state.rect.width, state.rect.height, 90, true);
        return Math.round(state.view.scale * Math.exp(120 * 0.0016) / fit.scale * 100);
      }, state);
      assert.equal(await page.locator('.zoom-value').innerText(), `${expectedZoom}%`);
      return { expectedAnchor: anchor, coordinates, rotation: await page.locator('.rotation-badge').innerText() };
    });
    await run(browser, 'Measurement updates overlay while preserving the cached board image', async page => {
      const state = await model(page);
      const points = [];
      for (const component of ['R1', 'R2']) points.push(await project(page, state.board.pins.find(pin => pin.componentId === component && pin.number === '1'), state));
      const before = await baseHash(page);
      await page.getByTestId('measure-tool').click();
      for (const point of points) await page.mouse.click(state.rect.x + point.x, state.rect.y + point.y);
      await turn(page);
      assert.match(await page.locator('.mode-pill').innerText(), /22,36 mm/);
      assert.equal(await baseHash(page), before, 'Measurement should never modify the cached board image');
      await page.keyboard.press('r');
      await page.getByTestId('side-bottom').click(); await turn(page);
      assert.match(await page.locator('.mode-pill').innerText(), /22,36 mm/);
      return { distanceMm: Math.sqrt(500), beforeHash: before, measurement: await page.locator('.mode-pill').innerText() };
    });
    await run(browser, 'Hover target is invalidated after keyboard rotation', async page => {
      const state = await model(page);
      const component = state.board.components.find(component => component.id === 'R1');
      const point = await project(page, component.position, state);
      await page.mouse.move(state.rect.x + point.x, state.rect.y + point.y);
      await page.locator('.canvas-hover-card').waitFor();
      assert.match(await page.locator('.canvas-hover-card').innerText(), /R1/);
      await page.keyboard.press('r'); await turn(page);
      assert.equal(await page.locator('.rotation-badge').innerText(), '90°');
      assert.equal(await page.locator('.canvas-hover-card').count(), 0, 'The R1 hover card remains at its former screen position after R1 rotates away');
      return { clearedAfterRotation: true };
    });
    await run(browser, 'DPR-only change updates both canvas backing sizes', async page => {
      const session = await page.context().newCDPSession(page);
      const before = await page.locator('canvas.board-canvas').evaluate(canvas => ({ width: canvas.width, cssWidth: canvas.clientWidth, dpr: devicePixelRatio }));
      await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 2, mobile: false });
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas.board-canvas');
        return canvas.width === Math.round(canvas.clientWidth * devicePixelRatio);
      });
      const after = await page.evaluate(() => {
        const base = document.querySelector('canvas.board-canvas'), overlay = document.querySelector('canvas.board-canvas-overlay');
        return { dpr: devicePixelRatio, cssWidth: base.clientWidth, baseWidth: base.width, overlayWidth: overlay.width };
      });
      assert.equal(after.baseWidth, Math.round(after.cssWidth * after.dpr), 'Canvas backing resolution is stale after a DPR-only change');
      assert.equal(after.overlayWidth, after.baseWidth);
      await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1.5, mobile: false });
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas.board-canvas');
        return canvas.width === Math.round(canvas.clientWidth * devicePixelRatio);
      });
      const rearmed = await page.locator('canvas.board-canvas').evaluate(canvas => ({ width: canvas.width, cssWidth: canvas.clientWidth, dpr: devicePixelRatio }));
      assert.equal(rearmed.width, Math.round(rearmed.cssWidth * rearmed.dpr), 'The DPR observer must re-arm after each change');
      await turn(page);
      await page.evaluate(() => {
        window.__rendererQA.idleDraws = 0;
        const nativeFill = CanvasRenderingContext2D.prototype.fill;
        CanvasRenderingContext2D.prototype.fill = function (...args) {
          if (this.canvas.classList.contains('board-canvas')) window.__rendererQA.idleDraws++;
          return nativeFill.apply(this, args);
        };
      });
      await page.waitForTimeout(1200);
      const idleDraws = await page.evaluate(() => window.__rendererQA.idleDraws);
      assert.equal(idleDraws, 0, 'The ratio-only fallback must never redraw when DPR stays unchanged');
      return { before, after, rearmed, idleDraws };
    });
    await run(browser, 'New board cancels an active drag before fitting the new view', async page => {
      const canvas = page.locator('canvas.board-canvas');
      const box = await canvas.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down(); await turn(page);
      assert.equal(await canvas.evaluate(canvas => canvas.style.cursor), 'grabbing');
      await page.evaluate(() => window.__rendererQA.deliver('B'));
      await page.waitForFunction(() => document.querySelector('.project-name')?.textContent === 'Renderer-B'); await turn(page);
      assert.equal(await canvas.evaluate(canvas => canvas.style.cursor), 'grab', 'Drag state from the previous board survives the file switch');
      await page.mouse.up();
      return { activeDragCleared: true };
    });
    await run(browser, 'New board clears measurements hover and net caches', async page => {
      await page.getByTestId('search-input').fill('R1');
      await page.locator('[data-testid="search-row"][data-source="board-components"]').filter({ has: page.locator('.component-ref', { hasText: /^R1$/ }) }).click();
      await page.locator('[data-testid="pin-row"]').filter({ hasText: 'GND' }).click(); await turn(page);
      assert.equal(await page.locator('.net-title strong').innerText(), 'GND');
      await page.getByTestId('measure-tool').click();
      const box = await page.locator('canvas.board-canvas').boundingBox();
      await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.35);
      await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6); await turn(page);
      await page.evaluate(() => window.__rendererQA.deliver('B'));
      await page.waitForFunction(() => document.querySelector('.project-name')?.textContent === 'Renderer-B'); await turn(page);
      assert.equal(await page.locator('.net-title').count(), 0);
      assert.equal(await page.locator('.canvas-hover-card').count(), 0);
      const mode = page.locator('.mode-pill');
      assert.doesNotMatch(await mode.count() ? await mode.innerText() : '', /\d+,\d{2} mm/);
      const state = await model(page);
      const pin = state.board.pins.find(pin => pin.componentId === 'X1' && pin.number === '1');
      assert.ok(await padVisible(page, await project(page, pin, state)) > 0, 'New board pads must use the new fitted view and cache');
      return { board: state.board.name, selectedNetCleared: true, measurementCleared: true };
    });
    }
  } finally { await browser.close(); }
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.every(check => check.passed);
  await fs.writeFile(path.join(OUT, 'qa-renderer.json'), JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.passed ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
