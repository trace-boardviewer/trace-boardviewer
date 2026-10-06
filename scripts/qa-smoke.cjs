'use strict';

// Runs the real sample through the browser UI and the production Electron shell.
// Use: node scripts/qa-smoke.cjs --browser | --electron | --packaged | --all
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { chromium, _electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results');
const boardArgument = process.argv.find(argument => argument.startsWith('--board='));
const sampleValue = boardArgument ? boardArgument.slice(8) : process.env.TRACE_TEST_BOARD;
if (!sampleValue) { console.error('Provide a local GENCAD board: TRACE_TEST_BOARD=/path/to/board.cad node scripts/qa-smoke.cjs --browser (or pass --board=/path/to/board.cad). The real-board suite expects AC1, AC15, U1 and VU13 references.'); process.exit(2); }
const SAMPLE = path.resolve(sampleValue);
const QA_URL = process.env.TRACE_QA_URL || 'http://localhost:5173';
const expectedCounts = process.env.TRACE_EXPECT_COUNTS?.split(',').map(Number);
if (expectedCounts && (expectedCounts.length !== 3 || expectedCounts.some(value => !Number.isInteger(value) || value < 1))) { console.error('TRACE_EXPECT_COUNTS must contain component,pin,net counts, for example4908,13394,2059.'); process.exit(2); }
const browserOptions = { headless: true, ...(process.env.TRACE_BROWSER_CHANNEL ? { channel: process.env.TRACE_BROWSER_CHANNEL } : {}) };
const NOTE = 'QA ellenőrzés: AC1 / AGND_AUD – tartós helyi megjegyzés.';
const report = { startedAt: new Date().toISOString(), sample: SAMPLE, runs: [] };
const mode = process.argv.includes('--packaged') ? 'packaged' : process.argv.includes('--electron') ? 'electron' : process.argv.includes('--browser') ? 'browser' : 'all';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runStep(run, label, work) {
  const start = Date.now();
  try {
    const details = await work();
    run.checks.push({ label, passed: true, durationMs: Date.now() - start, ...(details ? { details } : {}) });
    console.log(`PASS [${run.runtime}] ${label}`);
  } catch (error) {
    run.checks.push({ label, passed: false, durationMs: Date.now() - start, error: error.stack || String(error) });
    console.error(`FAIL [${run.runtime}] ${label}: ${error.message}`);
    throw error;
  }
}

function collectErrors(page, run) {
  page.on('pageerror', error => run.pageErrors.push(error.stack || error.message));
  page.on('console', message => {
    if (message.type() === 'error') run.consoleErrors.push({ message: message.text().replace(/data:font\/woff2?;base64,[^']+/g, 'data:font/[embedded]'), location: message.location() });
  });
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await delay(450);
}

async function shot(page, run, name) {
  await settle(page);
  const filename = `${run.runtime}-${name}.png`;
  await page.screenshot({ path: path.join(OUT, filename), fullPage: true });
  run.screenshots.push(filename);
}

async function waitBoard(page) {
  await page.locator('.statusbar').waitFor({ timeout: 45000 });
  await page.locator('.loading-overlay').waitFor({ state: 'hidden', timeout: 45000 });
  const status = (await page.locator('.status-left').innerText()).replace(/[\s\u00a0\u202f]/g, '');
  const match = status.match(/(\d+)alkatrész.*?(\d+)pin.*?(\d+)net/);
  assert.ok(match, 'The status bar must show component, pin and net counts');
  const actual = match.slice(1).map(Number);
  assert.ok(actual.every(value => value > 0));
  if (expectedCounts) assert.deepEqual(actual, expectedCounts, 'Loaded board counts differ from TRACE_EXPECT_COUNTS');
  await settle(page);
  return { components: actual[0], pins: actual[1], nets: actual[2] };
}

async function selectExact(page, ref) {
  await page.locator('.search-field input').fill(ref);
  const row = page.locator('.component-row').filter({ has: page.locator('.component-ref').filter({ hasText: new RegExp(`^${ref}$`) }) });
  await delay(40);
  if (await row.count() === 0) {
    const list = page.locator('.component-list, .focus-result-list').first();
    await list.evaluate(element => { element.scrollTop = 0; });
    for (let scroll = 0; scroll < 200 && await row.count() === 0; scroll++) {
      await list.evaluate(element => { element.scrollTop += Math.max(150, element.clientHeight * 0.7); });
      await delay(40);
    }
  }
  await row.click();
  await page.waitForFunction(value => document.querySelector('.hero-ref')?.textContent === value, ref);
  await settle(page);
}

async function cyanPixels(page) {
  return page.locator('canvas.board-canvas').evaluate(canvas => {
    const context = canvas.getContext('2d');
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 1] >= 150 && data[i + 2] >= 150 && data[i + 1] - data[i] >= 55 && data[i + 2] - data[i] >= 55) count++;
    }
    return count;
  });
}

async function setTheme(page, theme) {
  await page.getByRole('button', { name: 'Beállítások', exact: true }).click();
  await page.getByRole('button', { name: theme === 'dark' ? 'Sötét' : 'Világos', exact: true }).click();
  await page.getByRole('button', { name: 'Kész', exact: true }).click();
  await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
  await settle(page);
  assert.equal(await page.getByRole('button', { name: 'Beállítások', exact: true }).evaluate(el => el === document.activeElement), true, 'Closing Settings must return focus to its invoking control');
}

async function commonChecks(page, run) {
  await runStep(run, 'U1 and VU13 focused inspection', async () => {
    for (const ref of ['U1', 'VU13']) {
      await selectExact(page, ref);
      assert.equal(await page.getByRole('button', { name: 'Felső', exact: true }).getAttribute('aria-pressed'), 'true');
      await shot(page, run, `1440-${ref.toLowerCase()}-inspection`);
    }
  });
  await runStep(run, 'Exact AC1 selection changes automatically to bottom side', async () => {
    await selectExact(page, 'AC1');
    assert.equal(await page.getByRole('button', { name: 'Alsó', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('canvas.board-canvas').getAttribute('aria-label'), /alsó oldal, tükrözve/);
    const canvas = await page.locator('canvas.board-canvas').boundingBox();
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await shot(page, run, '1440-ac1-inspection');
  });
  await runStep(run, 'AGND_AUD net selection highlights pads and connected components', async () => {
    await page.locator('.pin-row').filter({ hasText: 'AGND_AUD' }).click();
    assert.equal(await page.locator('.net-title strong').innerText(), 'AGND_AUD');
    await page.getByRole('button', { name: 'Teljes nyák', exact: true }).click();
    await settle(page);
    const highlighted = await cyanPixels(page);
    await page.getByRole('button', { name: 'Netkiemelés', exact: true }).click();
    await settle(page);
    const hidden = await cyanPixels(page);
    assert.ok(highlighted > hidden + 10, `Expected cyan pad pixels to increase: ${highlighted} vs ${hidden}`);
    await page.getByRole('button', { name: 'Netkiemelés', exact: true }).click();
    await page.locator('.connection-summary').click();
    assert.ok(await page.locator('.connection-row').count() > 1);
    await shot(page, run, '1440-workshop-bottom-net');
    await page.locator('.connection-summary').click();
    return { highlightedCyanPixels: highlighted, cyanPixelsWithoutNet: hidden, netSummary: await page.locator('.connection-summary').innerText() };
  });
  await runStep(run, 'AC15 search across sides changes automatically to top side', async () => {
    await selectExact(page, 'AC15');
    assert.equal(await page.getByRole('button', { name: 'Felső', exact: true }).getAttribute('aria-pressed'), 'true');
  });
  await runStep(run, 'Zoom, fit, quarter rotation and distance measurement', async () => {
    await page.getByRole('button', { name: 'Teljes nyák', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.zoom-value')?.textContent === '100%');
    await page.getByRole('button', { name: 'Nagyítás', exact: true }).click();
    await page.waitForFunction(() => parseInt(document.querySelector('.zoom-value')?.textContent || '0') > 100);
    await page.getByRole('button', { name: 'Teljes nyák', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.zoom-value')?.textContent === '100%');
    await page.getByRole('button', { name: 'Forgatás 90°-kal', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.rotation-badge')?.textContent === '90°');
    await page.getByRole('button', { name: 'Távolságmérés', exact: true }).click();
    const canvas = await page.locator('canvas.board-canvas').boundingBox();
    await page.mouse.click(canvas.x + canvas.width * 0.35, canvas.y + canvas.height * 0.42);
    await page.mouse.click(canvas.x + canvas.width * 0.6, canvas.y + canvas.height * 0.58);
    await page.waitForFunction(() => /\d+,\d{2} mm/.test(document.querySelector('.mode-pill')?.textContent || ''));
    const measurement = await page.locator('.mode-pill').innerText();
    assert.ok(parseFloat(measurement.replace(',', '.')) > 0);
    await shot(page, run, '1440-measurement');
    await page.getByRole('button', { name: 'Mérés befejezése', exact: true }).click();
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Forgatás 90°-kal', exact: true }).click();
    await page.getByRole('button', { name: 'Teljes nyák', exact: true }).click();
    return { measurement };
  });
  await runStep(run, 'Save an AC1 note through the UI', async () => {
    await selectExact(page, 'AC1');
    const invoker = page.locator('.selection-actions').getByRole('button', { name: 'Megjegyzés', exact: true });
    await invoker.click();
    assert.equal(await page.locator('#note-draft').evaluate(el => el === document.activeElement), true, 'Opening notes must focus the editor');
    await page.locator('#note-draft').fill(NOTE);
    await page.getByRole('button', { name: 'Mentés', exact: true }).click();
    await page.locator('.note-preview').waitFor();
    assert.equal(await page.locator('.note-preview span').innerText(), NOTE);
    assert.equal(await invoker.evaluate(el => el === document.activeElement), true, 'Saving notes must return focus to the invoking control');
  });
  await runStep(run, 'Light theme and focus workshop layout switching', async () => {
    await setTheme(page, 'light');
    await page.getByRole('button', { name: 'Fókusz mód', exact: true }).click();
    await page.locator('.focus-mode').waitFor();
    assert.equal(await page.locator('.search-panel').count(), 0);
    await page.getByRole('textbox', { name: 'Alkatrész keresése', exact: true }).fill('');
    await page.getByRole('button', { name: 'Teljes nyák', exact: true }).click();
    await shot(page, run, '1440-focus-light');
    await page.getByRole('button', { name: 'Műhely mód', exact: true }).click();
    assert.equal(await page.locator('.search-panel').count(), 1);
  });
  await runStep(run, '960 × 640 compact workshop and focus remain usable', async () => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.getByRole('button', { name: 'Teljes nyák', exact: true }).click();
    await shot(page, run, '960-workshop-light');
    const dimensions = await page.evaluate(() => ({
      width: window.innerWidth, height: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      canvas: document.querySelector('canvas').getBoundingClientRect().toJSON(),
    }));
    assert.ok(dimensions.scrollWidth <= dimensions.width, 'Horizontal document overflow');
    assert.ok(dimensions.scrollHeight <= dimensions.height, 'Vertical document overflow');
    assert.ok(dimensions.canvas.width >= 300 && dimensions.canvas.height >= 400, 'Canvas unexpectedly small');
    await page.getByRole('button', { name: 'Fókusz mód', exact: true }).click();
    await page.getByRole('button', { name: 'Teljes nyák', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.zoom-value')?.textContent === '100%');
    await shot(page, run, '960-focus-light');
    await page.locator('.pin-row').filter({ hasText: 'AGND_AUD' }).click();
    assert.equal(await page.locator('.net-title strong').innerText(), 'AGND_AUD');
    await shot(page, run, '960-focus-light-net');
    await page.getByRole('button', { name: 'Műhely mód', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 960 });
    return dimensions;
  });
  await setTheme(page, 'dark');
}

async function browserRun() {
  const run = { runtime: 'browser', checks: [], screenshots: [], consoleErrors: [], pageErrors: [] };
  report.runs.push(run);
  const browser = await chromium.launch(browserOptions);
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, permissions: ['clipboard-read', 'clipboard-write'] });
    await context.addInitScript(() => { if (!localStorage.getItem('trace-settings')) localStorage.setItem('trace-settings', JSON.stringify({ language: 'hu' })); });
    page = await context.newPage();
    collectErrors(page, run);
    await page.goto(QA_URL, { waitUntil: 'networkidle' });
    await runStep(run, 'Welcome screen', async () => {
      await page.getByRole('button', { name: 'Boardview megnyitása', exact: true }).waitFor();
      await shot(page, run, '1440-welcome-dark');
    });
    await runStep(run, 'Browser file input loads the real CAD sample', async () => {
      await page.getByLabel('Boardview fájl', { exact: true }).setInputFiles(SAMPLE);
      const counts = await waitBoard(page);
      await shot(page, run, '1440-workshop-top');
      return counts;
    });
    await commonChecks(page, run);
    await runStep(run, 'Clipboard Copy label action', async () => {
      await selectExact(page, 'AC1');
      await page.getByRole('button', { name: 'Jelölés másolása', exact: true }).click();
      await page.getByText('Másolva a vágólapra', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'AC1');
    });
    await runStep(run, 'Invalid CAD shows an error while preserving the loaded board', async () => {
      await page.getByLabel('Boardview fájl', { exact: true }).setInputFiles({ name: 'invalid.cad', mimeType: 'text/plain', buffer: Buffer.from('This is not a GENCAD board.') });
      await page.locator('.toast.error').waitFor();
      assert.match(await page.locator('.toast.error').innerText(), /GENCAD|érvényes|formátum/i);
      await waitBoard(page);
      assert.equal(await page.locator('.hero-ref').innerText(), 'AC1');
    });
    await runStep(run, 'Browser note and settings survive reload', async () => {
      await setTheme(page, 'light');
      await page.getByRole('button', { name: 'Fókusz mód', exact: true }).click();
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByLabel('Boardview fájl', { exact: true }).setInputFiles(SAMPLE);
      await waitBoard(page);
      await selectExact(page, 'AC1');
      assert.equal(await page.locator('.note-preview span').innerText(), NOTE);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
      assert.equal(await page.locator('.focus-mode').count(), 1);
    });
    await runStep(run, 'No browser console errors or uncaught page errors', async () => {
      assert.deepEqual(run.consoleErrors, []);
      assert.deepEqual(run.pageErrors, []);
    });
    run.passed = true;
  } catch (error) {
    run.passed = false;
    run.error = error.stack || String(error);
    if (page) await shot(page, run, 'failure').catch(() => {});
  } finally { await browser.close(); }
}

async function electronRun(packaged = false) {
  const runtime = packaged ? 'packaged' : 'electron';
  const run = { runtime, checks: [], screenshots: [], consoleErrors: [], pageErrors: [], processStderr: [] };
  report.runs.push(run);
  const profile = path.join(OUT, `${runtime}-profile-${Date.now()}`);
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({ version: 1, settings: { language: 'hu', theme: 'dark', layout: 'workshop', motion: true, showLabels: true, showConnections: true }, recentBoards: [] }));
  const executablePath = packaged ? path.join(ROOT, 'release', 'win-unpacked', 'TRACE Boardviewer.exe') : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.VITE_DEV_SERVER_URL;
  let app, page;
  const launch = async (openSample = true) => {
    const args = [...(packaged ? [] : [ROOT]), `--user-data-dir=${profile}`, ...(openSample ? [`--board=${SAMPLE}`] : [])];
    app = await _electron.launch({ executablePath, args, env: environment, timeout: 45000 });
    app.process().stderr.on('data', data => run.processStderr.push(data.toString()));
    page = await app.firstWindow();
    collectErrors(page, run);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960));
    return page;
  };
  try {
    await runStep(run, 'Real production Electron launch loads the sample via native filesystem', async () => {
      await launch();
      const counts = await waitBoard(page);
      assert.ok((await page.url()).startsWith('file:///'), 'Expected the production file URL');
      assert.equal(await app.evaluate(({ app }) => app.isPackaged), packaged, 'Expected the requested production runtime');
      assert.equal(await page.evaluate(() => typeof window.traceDesktop), 'object');
      assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
      await shot(page, run, '1440-workshop-top');
      return { ...counts, productionUrl: page.url(), profile };
    });
    await commonChecks(page, run);
    await runStep(run, 'Native clipboard label and net Copy actions', async () => {
      await selectExact(page, 'AC1');
      await page.getByRole('button', { name: 'Jelölés másolása', exact: true }).click();
      await page.getByText('Másolva a vágólapra', { exact: true }).waitFor();
      assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'AC1');
      await page.locator('.pin-row').filter({ hasText: 'AGND_AUD' }).click();
      await page.getByRole('button', { name: 'Netnév másolása', exact: true }).click();
      await page.getByText('Másolva a vágólapra', { exact: true }).waitFor();
      assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'AGND_AUD');
    });
    await runStep(run, 'Native file-open IPC rejects invalid CAD without replacing the board', async () => {
      const invalid = path.join(OUT, 'invalid.cad');
      await fs.writeFile(invalid, 'This is not a GENCAD board.');
      await app.evaluate(({ dialog }, filename) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
      }, invalid);
      await page.getByRole('button', { name: 'Megnyitás', exact: true }).click();
      await page.locator('.toast.error').waitFor();
      assert.match(await page.locator('.toast.error').innerText(), /nem érvényes GENCAD/);
      await waitBoard(page);
      assert.equal(await page.locator('.hero-ref').innerText(), 'AC1');
    });
    await runStep(run, 'Native notes, settings and recent board survive a full process restart', async () => {
      await setTheme(page, 'light');
      await page.getByRole('button', { name: 'Fókusz mód', exact: true }).click();
      await delay(350);
      await app.close(); app = null;
      await launch(false);
      await waitBoard(page);
      await selectExact(page, 'AC1');
      assert.equal(await page.locator('.note-preview span').innerText(), NOTE);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
      assert.equal(await page.locator('.focus-mode').count(), 1);
      const recents = await page.evaluate(() => window.traceDesktop.recentBoards());
      assert.ok(recents.some(recent => pathNormalize(recent.path) === pathNormalize(path.resolve(SAMPLE))));
      await shot(page, run, '1440-restored-note');
      return { persistedNote: NOTE, recentBoards: recents.length };
    });
    await runStep(run, 'No Electron renderer console errors or uncaught page errors', async () => {
      assert.deepEqual(run.consoleErrors, []);
      assert.deepEqual(run.pageErrors, []);
    });
    run.passed = true;
  } catch (error) {
    run.passed = false;
    run.error = error.stack || String(error);
    if (page && !page.isClosed()) await shot(page, run, 'failure').catch(() => {});
  } finally { if (app) await app.close().catch(() => {}); }
}

function pathNormalize(value) { return value.replaceAll('\\', '/').toLowerCase(); }

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  if (mode === 'browser' || mode === 'all') await browserRun();
  if (mode === 'electron' || mode === 'all') await electronRun();
  if (mode === 'packaged') await electronRun(true);
  report.finishedAt = new Date().toISOString();
  report.passed = report.runs.length > 0 && report.runs.every(run => run.passed);
  const reportPath = path.join(OUT, `qa-${mode}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${reportPath}`);
  process.exitCode = report.passed ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
