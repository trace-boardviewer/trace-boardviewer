'use strict';

// Deterministic browser regressions against the real React UI and parser worker.
// IPC is mocked before App imports; deferred reads/writes expose async races.
// Run with Vite available: node scripts/qa-races.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const OUT = path.resolve(__dirname, '..', 'test-results', 'races');
const URL = process.env.TRACE_QA_URL || 'http://localhost:5173';
const AKEY = 'a'.repeat(64);
const BKEY = 'b'.repeat(64);
const defaults = { language: 'hu', theme: 'dark', layout: 'workshop', motion: false, showLabels: true, showConnections: true };
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
$ENDCOMPONENTS
$DEVICES
DEVICE D
VALUE "10 kOhm"
PACKAGE "0402"
$ENDDEVICES
$SIGNALS
SIGNAL GND
NODE R1 1
SIGNAL "POWER 3V3"
NODE R1 2
$ENDSIGNALS
`;
const payloads = {
  A: { name: 'Race-A.cad', path: 'C:/qa/Race-A.cad', text: fixture, key: AKEY },
  B: { name: 'Race-B.cad', path: 'C:/qa/Race-B.cad', text: fixture.replace('10 kOhm', '22 kOhm'), key: BKEY },
  C: { name: 'Race-C.cad', path: 'C:/qa/Race-C.cad', key: 'c'.repeat(64), text: fixture.replace('$ENDCOMPONENTS', 'COMPONENT AR1\nPLACE 25 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\n$ENDCOMPONENTS') },
  D: { name: 'Race-D.cad', path: 'C:/qa/Race-D.cad', key: 'd'.repeat(64), text: '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nRECTANGLE 0 0 40 30\n$ENDBOARD\n' },
};
const note = (id, componentId, text) => ({ id, componentId, text, updatedAt: '2026-10-05T12:00:00.000Z' });
const report = { startedAt: new Date().toISOString(), runtime: (process.env.TRACE_BROWSER_CHANNEL || 'Chromium') + ' / Playwright', url: URL, fixture: 'Synthetic GENCAD 1.4 fixtures; no user dataset copied', checks: [] };

async function contextFor(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, ...(options.locale ? { locale: options.locale } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push({ type: 'pageerror', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') errors.push({ type: 'console', message: message.text() }); });
  await page.addInitScript(({ payloads, defaults, options }) => {
    const clone = value => JSON.parse(JSON.stringify(value));
    const pendingReads = new Map();
    const pendingSaves = [];
    const openedListeners = new Set();
    const state = {
      readStarted: [], readFinished: [], initialRequests: 0,
      notes: clone(options.notes || {}), corruptKeys: [...(options.corruptKeys || [])],
      saveCalls: [], settingsCalls: [], acceptCalls: [], workerTerminations: 0, closedWithSettingsCalls: null,
    };
    const keyForPath = filename => Object.keys(payloads).find(key => payloads[key].path === filename);
    window.__traceQA = {
      state,
      resolveRead(key) {
        const pending = pendingReads.get(key);
        if (!pending) throw new Error(`No deferred read for ${key}`);
        pendingReads.delete(key); pending.resolve(clone(payloads[key]));
      },
      rejectRead(key, message) {
        const pending = pendingReads.get(key);
        if (!pending) throw new Error(`No deferred read for ${key}`);
        pendingReads.delete(key); pending.reject(new Error(message));
      },
      resolveSave(index) {
        const pending = pendingSaves[index];
        if (!pending || pending.finished) throw new Error(`No deferred save ${index}`);
        pending.finished = true; state.notes[pending.key] = clone(pending.notes); pending.resolve();
      },
      restoreNotes(key, notes) { state.corruptKeys = state.corruptKeys.filter(value => value !== key); state.notes[key] = clone(notes); },
      deliver(key) { openedListeners.forEach(listener => listener(clone(payloads[key]))); },
    };
    if (options.deferWorkerA) {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        postMessage(value, ...args) {
          if (value.name === payloads.A.name) { state.workerAStarted = true; return; }
          return super.postMessage(value, ...args);
        }
        terminate() { state.workerTerminations++; super.terminate(); }
      };
    }
    if (options.browserMode) {
      if ('browserSettings' in options) localStorage.setItem('trace-settings', typeof options.browserSettings === 'string' ? options.browserSettings : JSON.stringify(options.browserSettings));
      return;
    }
    window.traceDesktop = {
      openBoard: async () => null,
      readBoard(filename) {
        const key = keyForPath(filename);
        if (!key) return Promise.reject(new Error('Unknown QA file'));
        state.readStarted.push(key);
        if (options.rejectReads?.includes(key)) return Promise.reject(new Error('Synthetic unreadable recent'));
        if (options.immediateReads?.includes(key)) { state.readFinished.push(key); return Promise.resolve(clone(payloads[key])); }
        return new Promise((resolve, reject) => pendingReads.set(key, { resolve, reject })).then(payload => {
          state.readFinished.push(key); return payload;
        });
      },
      acceptBoard: async (path, key) => { state.acceptCalls.push({ path, key }); if (options.rejectAccept) throw new Error('Synthetic recents write failure'); },
      initialBoard: async () => { state.initialRequests++; return options.start ? { ...clone(payloads[options.start]), ...(options.startupSource ? { startupSource: options.startupSource } : {}) } : null; },
      recentBoards: async () => (options.recents || Object.keys(payloads)).map(key => ({ name: payloads[key].name, path: payloads[key].path, openedAt: '2026-10-05T12:00:00.000Z' })),
      getSettings: async () => {
        if (options.deferSettings) return new Promise((resolve, reject) => {
          window.__traceQA.resolveSettings = saved => resolve(clone(saved || defaults));
          window.__traceQA.rejectSettings = () => reject(new Error('Synthetic settings read failure'));
        });
        return clone(defaults);
      },
      saveSettings(value) { state.settingsCalls.push(clone(value)); return Promise.resolve(); },
      getNotes: async key => {
        if (options.deferNotesKey === key) await new Promise(resolve => { window.__traceQA.resolveNotes = resolve; });
        if (state.corruptKeys.includes(key)) throw new Error("Error invoking remote method 'trace:get-notes': Error: A mentett megjegyzések nem olvashatók. A meglévő fájl változatlan maradt.");
        return clone(state.notes[key] || []);
      },
      saveNotes(key, notes) {
        state.saveCalls.push({ key, notes: clone(notes) });
        if (options.deferSaves) return new Promise(resolve => pendingSaves.push({ key, notes: clone(notes), resolve, finished: false }));
        state.notes[key] = clone(notes); return Promise.resolve();
      },
      minimize() {}, maximize() {},
      close() { state.closedWithSettingsCalls = state.settingsCalls.length; },
      isMaximized: async () => false,
      onMaximized: () => () => {},
      onOpenBoard(listener) { openedListeners.add(listener); return () => openedListeners.delete(listener); },
      droppedFilePath(file) { return Object.values(payloads).find(payload => payload.name === file.name)?.path || ''; },
    };
  }, { payloads, defaults, options });
  await page.goto(URL, { waitUntil: 'networkidle' });
  return { context, page, errors };
}

async function renderTurn(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function boardIs(page, name, components = 1, pins = 2) {
  await page.waitForFunction(value => document.querySelector('.project-name')?.textContent === value, `Race-${name}`);
  await page.locator('.loading-overlay').waitFor({ state: 'hidden' });
  assert.match((await page.locator('.status-left').innerText()).replace(/\s/g, ''), new RegExp(components + 'alkatrész.*' + pins + 'pin.*2net'));
}
async function selectR1(page) {
  await page.locator('.component-row').filter({ has: page.locator('.component-ref', { hasText: /^R1$/ }) }).click();
  await page.waitForFunction(() => document.querySelector('.hero-ref')?.textContent === 'R1');
}
async function editNote(page, text) {
  await page.locator('.selection-actions').getByRole('button', { name: 'Megjegyzés', exact: true }).click();
  if (text != null) await page.locator('#note-draft').fill(text);
}
async function drop(page, key) {
  await page.evaluate(filename => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['synthetic QA import'], filename, { type: 'text/plain' }));
    document.querySelector('.app').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, payloads[key].name);
  await page.waitForFunction(value => window.__traceQA.state.readStarted.includes(value), key);
}

async function runCase(browser, label, options, work) {
  const started = Date.now();
  const instance = await contextFor(browser, options);
  try {
    const details = await work(instance.page);
    assert.deepEqual(instance.errors, [], 'Unexpected browser errors');
    report.checks.push({ label, passed: true, durationMs: Date.now() - started, details, browserErrors: instance.errors });
    console.log(`PASS ${label}`);
  } catch (error) {
    const screenshot = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-failure.png';
    await instance.page.screenshot({ path: path.join(OUT, screenshot), fullPage: true }).catch(() => {});
    report.checks.push({ label, passed: false, durationMs: Date.now() - started, error: error.stack || String(error), screenshot, browserErrors: instance.errors });
    console.error(`FAIL ${label}: ${error.message}`);
  } finally { await instance.context.close(); }
}

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.TRACE_BROWSER_CHANNEL ? { channel: process.env.TRACE_BROWSER_CHANNEL } : {}) });
  try {
    await runCase(browser, 'Latest request wins when A read finishes after B', {}, async page => {
      await drop(page, 'A');
      await drop(page, 'B');
      await page.evaluate(() => window.__traceQA.resolveRead('B'));
      await boardIs(page, 'B');
      await page.evaluate(() => window.__traceQA.resolveRead('A'));
      await page.waitForFunction(() => window.__traceQA.state.readFinished.includes('A'));
      await renderTurn(page);
      assert.equal(await page.locator('.project-name').innerText(), 'Race-B');
      assert.equal(await page.locator('.component-value').innerText(), '22 kOhm');
      const state = await page.evaluate(() => window.__traceQA.state);
      assert.deepEqual(state.readStarted, ['A', 'B']); assert.deepEqual(state.readFinished, ['B', 'A']);
      return { readsStarted: state.readStarted, readsFinished: state.readFinished, finalBoard: 'Race-B' };
    });

    await runCase(browser, 'Corrupt notes do not block import and require explicit successful reread', { start: 'A', corruptKeys: [AKEY] }, async page => {
      await boardIs(page, 'A');
      await selectR1(page); await editNote(page);
      const save = page.getByRole('button', { name: 'Mentés', exact: true });
      assert.equal(await save.isDisabled(), true);
      assert.equal(await page.locator('#note-draft').getAttribute('readonly'), '');
      assert.doesNotMatch(await page.locator('.data-warning').innerText(), /Error invoking|trace:get-notes/);
      assert.equal(await page.evaluate(() => window.__traceQA.state.saveCalls.length), 0);
      await page.getByRole('button', { name: 'Újraolvasás', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('button.outline-button:disabled'));
      assert.equal(await save.isDisabled(), true, 'A failed reread must not enable writes');
      const recovered = [note('restored-r1', 'R1', 'Recovered original note'), note('preserved-r2', 'R2', 'Keep this unrelated note')];
      await page.evaluate(({ key, notes }) => window.__traceQA.restoreNotes(key, notes), { key: AKEY, notes: recovered });
      assert.equal(await save.isDisabled(), true, 'External repair alone must not unlock writes before user reread');
      await page.getByRole('button', { name: 'Újraolvasás', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.data-warning'));
      assert.equal(await page.locator('#note-draft').inputValue(), 'Recovered original note');
      assert.equal(await save.isEnabled(), true);
      await page.locator('#note-draft').fill('Revised after explicit recovery'); await save.click();
      await page.locator('.note-preview').waitFor();
      const state = await page.evaluate(() => window.__traceQA.state);
      assert.equal(state.saveCalls.length, 1);
      assert.deepEqual(state.notes[AKEY].find(value => value.componentId === 'R2'), recovered[1]);
      assert.equal(state.notes[AKEY].find(value => value.componentId === 'R1').text, 'Revised after explicit recovery');
      return { boardOpenedDespiteCorruption: true, saveCallsBeforeRecovery: 0, unrelatedNotePreserved: true, savedAfterExplicitReread: true };
    });

    await runCase(browser, 'Escape cannot dismiss a pending note save', { start: 'A', deferSaves: true }, async page => {
      await boardIs(page, 'A'); await selectR1(page); await editNote(page, 'Pending Escape regression note');
      await page.getByRole('button', { name: 'Mentés', exact: true }).click();
      await page.waitForFunction(() => window.__traceQA.state.saveCalls.length === 1);
      await page.keyboard.press('Escape'); await renderTurn(page);
      assert.equal(await page.locator('dialog[open]').count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Mentés', exact: true }).isDisabled(), true);
      const cancelWasPrevented = await page.locator('dialog').evaluate(dialog => !dialog.dispatchEvent(new Event('cancel', { bubbles: false, cancelable: true })));
      assert.equal(cancelWasPrevented, true, 'The native cancel event must also be prevented');
      assert.equal(await page.locator('dialog[open]').count(), 1);
      await page.evaluate(() => window.__traceQA.resolveSave(0));
      await page.locator('dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.note-preview span').innerText(), 'Pending Escape regression note');
      return { keyboardEscapeKeptDialogOpen: true, nativeCancelPrevented: true, eventualSaveCompleted: true };
    });

    await runCase(browser, 'Settings IPC is sent in the change event before immediate close', {}, async page => {
      await page.getByRole('button', { name: 'Beállítások', exact: true }).click();
      const state = await page.evaluate(() => {
        const button = [...document.querySelectorAll('.settings-options button')].find(value => value.textContent === 'Világos');
        button.click();
        const callsInChangeEvent = window.__traceQA.state.settingsCalls.length;
        window.traceDesktop.close();
        return { callsInChangeEvent, callsAtClose: window.__traceQA.state.closedWithSettingsCalls, calls: window.__traceQA.state.settingsCalls };
      });
      assert.equal(state.callsInChangeEvent, 1, 'Persistence must happen before the event returns');
      assert.equal(state.callsAtClose, 1);
      assert.equal(state.calls[0].theme, 'light');
      return { synchronousIpcCalls: state.callsInChangeEvent, callsAtImmediateClose: state.callsAtClose, savedTheme: state.calls[0].theme };
    });

    await runCase(browser, 'Old board save cannot overwrite new board notes or its pending-save state', { start: 'A', deferSaves: true, notes: { [BKEY]: [note('b-existing', 'R1', 'B original note')] } }, async page => {
      await boardIs(page, 'A'); await selectR1(page); await editNote(page, 'A late note');
      await page.getByRole('button', { name: 'Mentés', exact: true }).click();
      await page.waitForFunction(() => window.__traceQA.state.saveCalls.length === 1);
      await page.evaluate(() => window.__traceQA.deliver('B'));
      await boardIs(page, 'B'); await selectR1(page);
      assert.equal(await page.locator('.note-preview span').innerText(), 'B original note');
      await editNote(page, 'B revised note'); await page.getByRole('button', { name: 'Mentés', exact: true }).click();
      await page.waitForFunction(() => window.__traceQA.state.saveCalls.length === 2);
      await page.evaluate(() => window.__traceQA.resolveSave(0)); await renderTurn(page);
      assert.equal(await page.locator('.project-name').innerText(), 'Race-B');
      assert.equal(await page.locator('.note-preview span').innerText(), 'B original note');
      assert.equal(await page.locator('dialog[open]').count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Mentés', exact: true }).isDisabled(), true, 'A completion must not clear B saving state');
      await page.keyboard.press('Escape'); await renderTurn(page);
      assert.equal(await page.locator('dialog[open]').count(), 1);
      await page.evaluate(() => window.__traceQA.resolveSave(1));
      await page.locator('dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.note-preview span').innerText(), 'B revised note');
      const state = await page.evaluate(() => window.__traceQA.state);
      assert.equal(state.notes[AKEY][0].text, 'A late note'); assert.equal(state.notes[BKEY][0].text, 'B revised note');
      assert.deepEqual(state.saveCalls.map(value => value.key), [AKEY, BKEY]);
      return { finalBoard: 'Race-B', separateBoardWrites: true, newBoardNotesProtected: true, newBoardPendingStateProtected: true };
    });
    await runCase(browser, 'Pending native settings reveal saved language and theme before controls become usable', { deferSettings: true, locale: 'en-GB' }, async page => {
      await page.waitForFunction(() => typeof window.__traceQA.resolveSettings === 'function');
      const settings = page.getByTestId('settings-button');
      assert.equal(await settings.isVisible(), false, 'Pending preferences must not expose controls in a temporary language/theme');
      assert.equal(await page.getByTestId('language-button').isVisible(), false);
      const saved = { ...defaults, language: 'de', theme: 'light' };
      await page.evaluate(value => window.__traceQA.resolveSettings(value), saved);
      await settings.waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.documentElement.lang === 'de' && document.documentElement.dataset.theme === 'light');
      assert.equal((await page.evaluate(() => window.__traceQA.state)).settingsCalls.length, 0, 'Reading preferences must not rewrite them');
      await settings.click();
      assert.equal(await page.locator('dialog[open]').getByTestId('language-select').inputValue(), 'de');
      await page.getByRole('button', { name: 'Dunkel', exact: true }).click();
      await page.locator('dialog[open] .modal-footer .primary-button').click();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
      const calls = await page.evaluate(() => window.__traceQA.state.settingsCalls);
      assert.equal(calls.length, 1); assert.equal(calls[0].theme, 'dark'); assert.equal(calls[0].language, 'de');
      return { pendingControlsHidden: true, savedLanguage: 'de', savedTheme: 'light', userThemeChangePersisted: 'dark' };
    });
    await runCase(browser, 'Rejected native settings reveal an error and keep preference controls usable', { deferSettings: true, locale: 'hu-HU' }, async page => {
      await page.waitForFunction(() => typeof window.__traceQA.rejectSettings === 'function');
      const settings = page.getByTestId('settings-button');
      assert.equal(await settings.isVisible(), false);
      await page.evaluate(() => window.__traceQA.rejectSettings());
      await settings.waitFor({ state: 'visible' });
      await page.locator('.toast.error').filter({ hasText: 'Synthetic settings read failure' }).waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'), 'hu');
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
      await settings.click();
      assert.equal(await page.locator('dialog[open]').getByTestId('language-select').inputValue(), 'hu');
      await page.getByRole('button', { name: 'Világos', exact: true }).click();
      await page.locator('dialog[open] .modal-footer .primary-button').click();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
      const calls = await page.evaluate(() => window.__traceQA.state.settingsCalls);
      assert.equal(calls.length, 1); assert.equal(calls[0].theme, 'light'); assert.equal(calls[0].language, 'hu');
      return { readErrorVisible: true, controlsRevealedAfterError: true, userThemeChangePersisted: 'light', defaultLanguage: 'hu' };
    });
    await runCase(browser, 'Malformed saved settings fall back per field while preserving valid values', { browserMode: true, browserSettings: { theme: 'corrupt', layout: 'focus', motion: false, showLabels: null, showConnections: false } }, async page => {
      await page.locator('input[type=file]').setInputFiles({ name: payloads.A.name, mimeType: 'text/plain', buffer: Buffer.from(fixture) });
      await boardIs(page, 'A');
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
      assert.equal(await page.locator('.app.focus-mode').count(), 1); assert.equal(await page.locator('canvas.board-canvas').count(), 1);
      await page.getByRole('button', { name: 'Beállítások', exact: true }).click();
      const switches = page.getByRole('switch');
      assert.equal(await switches.nth(0).isChecked(), false); assert.equal(await switches.nth(1).isChecked(), true); assert.equal(await switches.nth(2).isChecked(), false);
      return { fallbackTheme: 'dark', preservedLayout: 'focus', preservedMotion: false, fallbackLabels: true, preservedConnections: false };
    });
    await runCase(browser, 'Broken settings JSON leaves the app usable with defaults', { browserMode: true, browserSettings: '{invalid json' }, async page => {
      await page.locator('.toast.error').waitFor();
      await page.locator('input[type=file]').setInputFiles({ name: payloads.A.name, mimeType: 'text/plain', buffer: Buffer.from(fixture) });
      await boardIs(page, 'A'); assert.equal(await page.locator('.search-panel').count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
      return { defaultWorkshopStillUsable: true };
    });
    await runCase(browser, 'Exact reference takes priority and Enter selects it', { start: 'C' }, async page => {
      await boardIs(page, 'C', 2, 4); await page.locator('.search-field input').fill('r1');
      assert.deepEqual(await page.locator('.component-ref').allInnerTexts(), ['R1', 'AR1']);
      await page.keyboard.press('Enter'); await renderTurn(page); assert.equal(await page.locator('.hero-ref').innerText(), 'R1');
      return { caseInsensitiveExactMatchFirst: true, selected: 'R1' };
    });
    await runCase(browser, 'Enter on a filter checkbox does not change the selected component', { start: 'C' }, async page => {
      await boardIs(page, 'C', 2, 4); await selectR1(page); await page.locator('.search-options input').focus();
      await page.keyboard.press('Enter'); await renderTurn(page); assert.equal(await page.locator('.hero-ref').innerText(), 'R1');
      return { selected: 'R1', unrelatedInputLeftAlone: true };
    });
    await runCase(browser, 'Modal Escape restores settings and note invokers including textarea autofocus', { start: 'A' }, async page => {
      await boardIs(page, 'A');
      const settings = page.getByRole('button', { name: 'Beállítások', exact: true });
      await settings.click(); await page.keyboard.press('Escape'); await renderTurn(page);
      assert.equal(await settings.evaluate(el => el === document.activeElement), true);
      await selectR1(page); const notes = page.locator('.selection-actions').getByRole('button', { name: 'Megjegyzés', exact: true });
      await notes.click(); assert.equal(await page.locator('#note-draft').evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Escape'); await renderTurn(page); assert.equal(await notes.evaluate(el => el === document.activeElement), true);
      return { settingsInvokerRestored: true, noteInvokerRestored: true, textareaAutofocused: true };
    });
    await runCase(browser, 'A newer import cancels a worker that has not replied', { start: 'A', deferWorkerA: true }, async page => {
      await page.waitForFunction(() => window.__traceQA.state.workerAStarted);
      await page.evaluate(() => window.__traceQA.deliver('B')); await boardIs(page, 'B');
      const state = await page.evaluate(() => window.__traceQA.state);
      assert.ok(state.workerTerminations >= 1); assert.deepEqual(state.acceptCalls.map(value => value.key), [BKEY]);
      return { oldWorkerTerminated: true, onlyNewBoardAccepted: true };
    });
    await runCase(browser, 'Late notes read cannot replace a newer imported board', { start: 'A', deferNotesKey: AKEY }, async page => {
      await page.waitForFunction(() => !!window.__traceQA.resolveNotes);
      await page.evaluate(() => window.__traceQA.deliver('B')); await boardIs(page, 'B');
      await page.evaluate(() => window.__traceQA.resolveNotes()); await renderTurn(page);
      assert.equal(await page.locator('.project-name').innerText(), 'Race-B');
      assert.deepEqual(await page.evaluate(() => window.__traceQA.state.acceptCalls.map(value => value.key)), [BKEY]);
      return { staleNotesIgnored: true, staleBoardNeverAccepted: true };
    });
    await runCase(browser, 'Returning home prevents an outstanding read from reopening a board', { start: 'A' }, async page => {
      await boardIs(page, 'A'); await drop(page, 'B'); await page.locator('.brand').click();
      await page.evaluate(() => window.__traceQA.resolveRead('B')); await renderTurn(page);
      assert.equal(await page.locator('.welcome').count(), 1); assert.equal(await page.locator('.project-name').count(), 0);
      return { stayedOnWelcome: true };
    });
    await runCase(browser, 'A recents write error keeps the parsed board available', { start: 'A', rejectAccept: true }, async page => {
      await boardIs(page, 'A'); await page.locator('.toast.error').waitFor(); await selectR1(page);
      assert.equal(await page.locator('.hero-ref').innerText(), 'R1'); assert.match(await page.locator('.toast.error').innerText(), /recents write failure/);
      return { parsedBoardKept: true, persistenceErrorReported: true };
    });
    await runCase(browser, 'Legacy recent startup skips a header-valid board with invalid content', { start: 'D', startupSource: 'recent', recents: ['D', 'A'], immediateReads: ['A'] }, async page => {
      await boardIs(page, 'A'); const state = await page.evaluate(() => window.__traceQA.state);
      assert.deepEqual(state.readStarted, ['A']); assert.deepEqual(state.acceptCalls.map(value => value.key), [AKEY]);
      return { recoveredBoard: 'Race-A', invalidRecentNeverAccepted: true };
    });
    await runCase(browser, 'Legacy recent startup continues past an unreadable alternative', { start: 'D', startupSource: 'recent', recents: ['D', 'A', 'B'], rejectReads: ['A'], immediateReads: ['B'] }, async page => {
      await boardIs(page, 'B'); const state = await page.evaluate(() => window.__traceQA.state);
      assert.deepEqual(state.readStarted, ['A', 'B']); assert.deepEqual(state.acceptCalls.map(value => value.key), [BKEY]);
      return { recoveredBoard: 'Race-B', unreadableAlternativeSkipped: true };
    });
    await runCase(browser, 'Explicit startup argument failure never falls back to a recent', { start: 'D', startupSource: 'argument', recents: ['D', 'A'], immediateReads: ['A'] }, async page => {
      await page.locator('.toast.error').waitFor(); await page.locator('.loading-overlay').waitFor({ state: 'hidden' }); await renderTurn(page);
      const state = await page.evaluate(() => window.__traceQA.state);
      assert.deepEqual(state.readStarted, []); assert.deepEqual(state.acceptCalls, []); assert.equal(await page.locator('.welcome').count(), 1);
      return { explicitArgumentErrorKept: true, noUnexpectedRecentOpened: true };
    });
    await runCase(browser, 'A new user import cancels automatic legacy recent recovery', { start: 'D', startupSource: 'recent', recents: ['D', 'A'] }, async page => {
      await page.waitForFunction(() => window.__traceQA.state.readStarted.includes('A'));
      await drop(page, 'B'); await page.evaluate(() => window.__traceQA.resolveRead('B')); await boardIs(page, 'B');
      await page.evaluate(() => window.__traceQA.resolveRead('A')); await renderTurn(page);
      assert.equal(await page.locator('.project-name').innerText(), 'Race-B');
      assert.deepEqual(await page.evaluate(() => window.__traceQA.state.acceptCalls.map(value => value.key)), [BKEY]);
      return { userImportWon: true, fallbackBoardNeverAccepted: true };
    });
  } finally { await browser.close(); }
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.length === 20 && report.checks.every(check => check.passed);
  await fs.writeFile(path.join(OUT, 'qa-races.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.checks.filter(check => check.passed).length}/${report.checks.length} async regressions passed. Report: ${path.join(OUT, 'qa-races.json')}`);
  process.exitCode = report.passed ? 0 : 1;
})().catch(async error => {
  report.error = error.stack || String(error); report.passed = false;
  await fs.writeFile(path.join(OUT, 'qa-races.json'), JSON.stringify(report, null, 2) + '\n').catch(() => {});
  console.error(error); process.exitCode = 1;
});
