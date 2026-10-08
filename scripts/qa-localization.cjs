'use strict';

// Black-box localization checks with synthetic GENCAD data and isolated profiles.
// Run against Vite: node scripts/qa-localization.cjs --browser
// Native production builds: --electron or --packaged; TRACE_PACKAGED_EXE can select
// a separate absolute packaged executable. --baseline checks pre-locale UI.
// --measurement-prompts-only runs the focused browser control-overlap regression.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { chromium, _electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results', 'localization');
const QA_URL = process.env.TRACE_QA_URL || 'http://localhost:5173';
const baselineOnly = process.argv.includes('--baseline');
const measurementPromptsOnly = process.argv.includes('--measurement-prompts-only');
const mode = process.argv.includes('--all') ? 'all' : process.argv.includes('--packaged') ? 'packaged' : process.argv.includes('--electron') ? 'electron' : 'browser';
const browserOptions = { headless: true, ...(process.env.TRACE_BROWSER_CHANNEL ? { channel: process.env.TRACE_BROWSER_CHANNEL } : {}) };
const defaults = { language: 'hu', theme: 'dark', layout: 'workshop', motion: false, showLabels: true, showConnections: true };
const NOTE = 'Synthetic repair note — R1 / GND / Україна.';
const DRAFT = 'Unsaved draft: Українська Ґґ Єє Іі Її; café; R1 / GND.';
const GLYPHS = 'Українська Ґґ Єє Іі Її';
const languages = [
  { code: 'hu', name: 'Magyar', clipboard: /vágólap/iu, copied: /másol/iu, empty: /üres/iu, badNumber: /hibás szám/iu, line: /sor/iu, note: /megjegyz/iu, canvas: /nyák|oldal/iu },
  { code: 'en', name: 'English', clipboard: /clipboard/iu, copied: /copied/iu, empty: /empty/iu, badNumber: /invalid number/iu, line: /line/iu, note: /note/iu, canvas: /board|side/iu },
  { code: 'de', name: 'Deutsch', clipboard: /zwischenablage/iu, copied: /kopier/iu, empty: /leer/iu, badNumber: /ungültige zahl/iu, line: /zeile/iu, note: /notiz|anmerk/iu, canvas: /platine|seite/iu },
  { code: 'fr', name: 'Français', clipboard: /presse[\s-]*papiers?/iu, copied: /copi/iu, empty: /vide/iu, badNumber: /nombre non valide/iu, line: /ligne/iu, note: /note/iu, canvas: /circuit|face|côté|carte/iu },
  { code: 'it', name: 'Italiano', clipboard: /appunti/iu, copied: /copiat/iu, empty: /vuot/iu, badNumber: /numero non valido/iu, line: /riga/iu, note: /nota|annotaz/iu, canvas: /scheda|lato/iu },
  { code: 'sk', name: 'Slovenčina', clipboard: /schránk/iu, copied: /kopír|kopíro/iu, empty: /prázdn/iu, badNumber: /neplatné číslo/iu, line: /riadok/iu, note: /poznám/iu, canvas: /dosk|stran/iu },
  { code: 'pl', name: 'Polski', clipboard: /schow/iu, copied: /skopiow/iu, empty: /pust/iu, badNumber: /nieprawidłowa liczba/iu, line: /wiersz/iu, note: /notatk|uwag/iu, canvas: /płyt|stron/iu },
  { code: 'uk', name: 'Українська', clipboard: /буфер/iu, copied: /скопій|скопію/iu, empty: /порож/iu, badNumber: /некоректне число/iu, line: /рядок/iu, note: /нотат|приміт/iu, canvas: /плат|сторон/iu },
];
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
const filename = 'Localization-Reference.cad';
const boardName = 'Localization-Reference';
const fixturePath = path.join(OUT, filename);
const emptyPath = path.join(OUT, 'Localization-Empty.cad');
const malformedFixture = fixture.replace('PLACE 10 20', 'PLACE not-a-number 20');
const malformedLine = malformedFixture.split('\n').findIndex(line => line === 'PLACE not-a-number 20') + 1;
const malformedPath = path.join(OUT, 'Localization-Malformed.cad');
const report = { startedAt: new Date().toISOString(), mode, baselineOnly, measurementPromptsOnly, fixture: { source: 'Synthetic GENCAD 1.4; no external board data', components: 3, pins: 6, nets: 3 }, runs: [] };

async function fileIdentity(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  const stat = await fs.stat(filename);
  return { path: filename, sha256: hash.digest('hex'), bytes: stat.size };
}
/** A language catalog is a folder of namespace files; its identity is one SHA-256 over the file names and contents in name order. */
async function catalogIdentity(directory) {
  const names = (await fs.readdir(directory)).filter(name => name.endsWith('.json')).sort();
  const hash = createHash('sha256');
  let bytes = 0;
  for (const name of names) {
    const data = await fs.readFile(path.join(directory, name));
    hash.update(name); hash.update('\0'); hash.update(data); hash.update('\0');
    bytes += data.length;
  }
  return { path: directory, files: names.length, sha256: hash.digest('hex'), bytes };
}
async function sourceIdentity() {
  const sourceFiles = ['src/App.tsx', 'src/styles.css', 'src/lib/types.ts', 'src/components/BoardCanvas.tsx', 'src/lib/i18n.ts', 'src/lib/gencad.ts', 'src/lib/board-worker.ts',
    'electron/main.cjs', 'electron/preload.cjs', 'electron/i18n.cjs', 'package.json', 'dist/index.html'];
  const files = await Promise.all(sourceFiles.map(async name => ({ name, ...await fileIdentity(path.join(ROOT, name)) })));
  const catalogs = await Promise.all(languages.map(async ({ code }) => ({ code, ...await catalogIdentity(path.join(ROOT, 'electron', 'locales', code)) })));
  return { recordedAt: new Date().toISOString(), files, catalogs };
}
function assertCatalogIdentity(actual, expected) {
  const fingerprints = catalogs => catalogs.map(({ code, sha256 }) => ({ code, sha256 })).sort((a, b) => a.code.localeCompare(b.code));
  assert.deepEqual(fingerprints(actual), fingerprints(expected), 'Native catalogs must match the recorded source freeze');
}

async function settle(page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}
function collectErrors(page, run) {
  page.on('pageerror', error => run.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') run.consoleErrors.push({ text: message.text(), location: message.location() }); });
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) run.navigation.push({ url: frame.url(), at: new Date().toISOString() }); });
}
async function step(instance, label, work) {
  const started = Date.now();
  try {
    const details = await work();
    instance.run.checks.push({ label, passed: true, durationMs: Date.now() - started, ...(details ? { details } : {}) });
    console.log(`PASS [${instance.run.runtime}] ${label}`);
  } catch (error) {
    instance.run.checks.push({ label, passed: false, durationMs: Date.now() - started, error: error.stack || String(error) });
    console.error(`FAIL [${instance.run.runtime}] ${label}: ${error.message}`);
    throw error;
  }
}
async function shot(instance, label) {
  await settle(instance.page);
  const image = `${instance.run.runtime}-${label}.png`;
  const pixels = await instance.page.screenshot({ path: path.join(OUT, image), fullPage: true });
  instance.run.screenshots.push(image);
  (instance.run.screenshotMetrics ||= []).push({ image, pixels: { width: pixels.readUInt32BE(16), height: pixels.readUInt32BE(20) },
    viewport: await instance.page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio })) });
}
async function waitBoard(page) {
  await page.waitForFunction(name => document.querySelector('.project-name')?.textContent === name, boardName, { timeout: 45000 });
  await page.locator('.loading-overlay').waitFor({ state: 'hidden', timeout: 45000 });
  assert.deepEqual((await page.locator('.status-left').innerText()).match(/\d+/g)?.map(Number), [3, 6, 3], 'Synthetic component/pin/net counts must be preserved');
  await settle(page);
}
async function openSettings(page) {
  const tested = page.getByTestId('settings-button');
  const opener = await tested.count() ? tested : page.locator('.header-actions > button').last();
  await opener.click();
  await page.locator('dialog[open]').waitFor();
}
async function closeSettings(page) {
  await page.locator('dialog[open] .modal-footer .primary-button').click();
  await page.locator('dialog').waitFor({ state: 'hidden' });
  await settle(page);
}
async function waitLanguage(page, code) {
  await page.waitForFunction(expected => document.documentElement.lang.split('-')[0].toLowerCase() === expected, code);
}
async function chooseLanguage(page, code) {
  const workers = await page.evaluate(() => window.__localeWorkerCount);
  await openSettings(page);
  const control = page.locator('dialog[open]').getByTestId('language-select');
  await control.selectOption(code);
  await waitLanguage(page, code);
  assert.equal(await control.inputValue(), code);
  await closeSettings(page);
  assert.equal(await page.evaluate(() => window.__localeWorkerCount), workers, 'Changing language must not start another parser worker');
}
async function selectR1(page) {
  await page.locator('.search-field input').fill('R1');
  await page.locator('.component-row').filter({ has: page.locator('.component-ref', { hasText: /^R1$/ }) }).click();
  await page.waitForFunction(() => document.querySelector('.hero-ref')?.textContent === 'R1');
}
async function openNotes(page) {
  await page.locator('.selection-actions .tool-button').click();
  await page.locator('#note-draft').waitFor();
}
async function stateSnapshot(page) {
  await page.mouse.move(4, 4);
  await settle(page);
  return page.evaluate(() => {
    const text = selector => document.querySelector(selector)?.textContent?.trim() || null;
    const number = value => value == null ? null : Number.parseFloat(value.replace(/[^\d,.-]/g, '').replace(',', '.'));
    const canvas = document.querySelector('canvas.board-canvas');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index++) hash = Math.imul(hash ^ pixels[index], 16777619);
    return {
      board: text('.project-name'), counts: text('.status-left')?.match(/\d+/g)?.map(Number),
      selected: text('.hero-ref'), selectedPin: text('.pin-row.selected span:first-child'), net: text('.net-title strong'),
      side: [...document.querySelectorAll('.side-switch button')].findIndex(button => button.getAttribute('aria-pressed') === 'true'),
      note: text('.note-preview span'), query: document.querySelector('.search-field input')?.value,
      zoom: number(text('.zoom-value')), rotation: number(text('.rotation-badge')) || 0,
      measurement: number(text('.mode-pill')), measurementActive: Boolean(document.querySelector('.mode-pill')),
      canvas: { width: canvas.width, height: canvas.height, hash: (hash >>> 0).toString(16) },
    };
  });
}
function assertSameState(actual, expected) {
  assert.deepEqual(actual, expected, 'Language changes and reported errors must preserve board, selection, pin/net, camera, saved note and measurement');
}
async function assertCompactLayout(page, nativeRoundingTolerance = 0) {
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector('dialog[open]');
    const rect = dialog?.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      dialog: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null };
  });
  assert.ok(Math.abs(layout.width - 960) <= nativeRoundingTolerance, 'Compact viewport width exceeds bounded native DPI rounding');
  assert.ok(Math.abs(layout.height - 640) <= nativeRoundingTolerance, 'Compact viewport height exceeds bounded native DPI rounding');
  assert.ok(layout.scrollWidth <= layout.width, 'Localized document has horizontal overflow');
  assert.ok(layout.scrollHeight <= layout.height, 'Localized document has vertical overflow');
  if (layout.dialog) {
    assert.ok(layout.dialog.left >= -1 && layout.dialog.right <= layout.width + 1, 'Localized modal exceeds viewport width');
    assert.ok(layout.dialog.top >= -1 && layout.dialog.bottom <= layout.height + 1, 'Localized modal exceeds viewport height');
  }
  return layout;
}
async function prepareBoard(instance) {
  const page = instance.page;
  await waitBoard(page);
  await page.evaluate(() => {
    if (window.__localeWorkerInstalled) return;
    const NativeWorker = window.Worker;
    window.__localeWorkerCount = 0; window.__localeWorkerInstalled = true;
    window.Worker = class extends NativeWorker { constructor(...args) { super(...args); window.__localeWorkerCount++; } };
  });
  await selectR1(page);
  await page.locator('.pin-row').filter({ hasText: /GND/ }).click();
  assert.equal(await page.locator('.net-title strong').innerText(), 'GND');
  await openNotes(page); await page.locator('#note-draft').fill(NOTE);
  await page.locator('dialog[open] .modal-footer .primary-button').click();
  await page.locator('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.note-preview span').innerText(), NOTE);
  await page.locator('canvas.board-canvas').focus();
  await page.keyboard.press('r'); await page.keyboard.press('Equal'); await page.keyboard.press('m');
  const box = await page.locator('canvas.board-canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.32, box.y + box.height * 0.34);
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.60);
  await page.waitForFunction(() => /\d/.test(document.querySelector('.mode-pill')?.textContent || ''));
  await instance.resize(960, 640); await settle(page);
  const state = await stateSnapshot(page);
  assert.equal(state.selected, 'R1'); assert.equal(state.net, 'GND'); assert.equal(state.rotation, 90);
  assert.equal(state.note, NOTE); assert.ok(state.measurement > 0);
  return state;
}
async function clipboardChecks(instance, language) {
  const page = instance.page;
  const copy = page.locator('.part-hero .tool-button');
  await copy.click(); await page.locator('.toast:not(.error)').filter({ hasText: language.copied }).waitFor();
  const copiedText = await page.locator('.toast:not(.error)').innerText();
  assert.match(copiedText, language.copied, 'Clipboard success should follow the current language');
  assert.equal(await instance.readClipboard(), 'R1');
  await page.evaluate(() => {
    window.__localeClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Synthetic clipboard denial')) } });
  });
  try {
    await copy.click(); await page.locator('.toast.error').waitFor();
    const warning = await page.locator('.toast.error').innerText();
    assert.match(warning, language.clipboard, 'Clipboard warning should follow the current language');
    return { copiedText, warning };
  } finally {
    await page.evaluate(() => {
      const descriptor = window.__localeClipboardDescriptor;
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor); else delete navigator.clipboard;
      delete window.__localeClipboardDescriptor;
    });
  }
}
async function ukrainianFonts(page) {
  await page.locator('#note-draft').fill(DRAFT);
  const result = await page.evaluate(async text => {
    await document.fonts.load('400 14px Manrope', text); await document.fonts.ready;
    const faces = [...document.fonts].filter(face => /manrope/i.test(face.family) && face.status === 'loaded').map(face => ({ family: face.family, weight: face.weight, unicodeRange: face.unicodeRange }));
    const covers = (ranges, code) => ranges.split(',').some(range => {
      const match = range.trim().match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i);
      if (!match) return false;
      const lower = Number.parseInt(match[1].replaceAll('?', '0'), 16);
      const upper = Number.parseInt(match[2] || match[1].replaceAll('?', 'F'), 16);
      return code >= lower && code <= upper;
    });
    const missing = [...new Set([...text].filter(character => !/\s/u.test(character)))].filter(character => !faces.some(face => covers(face.unicodeRange, character.codePointAt(0))));
    return { checked: document.fonts.check('400 14px Manrope', text), faces, missing };
  }, GLYPHS);
  assert.equal(result.checked, true); assert.deepEqual(result.missing, [], 'Bundled Manrope should cover Ukrainian letters including Ґ, Є, І and Ї');
  return result;
}
async function measurementPromptChecks(instance) {
  const page = instance.page;
  const results = [];
  instance.run.measurementPromptRegression = { widths: [960, 1001, 1201, 1440], layouts: ['workshop', 'focus'], languages: languages.map(({ code }) => code), cases: results };
  if (await page.locator('.toast').count()) await page.locator('.toast > button').click();
  if (await page.locator('.mode-pill').count()) await page.locator('.mode-pill > button').click();
  for (const language of languages) {
    await chooseLanguage(page, language.code);
    for (const layout of ['workshop', 'focus']) {
      if (Boolean(await page.locator('.app.focus-mode').count()) !== (layout === 'focus')) await page.locator('.header-actions .tool-button').first().click();
      for (const width of [960, 1001, 1201, 1440]) {
        await instance.resize(width, 640);
        await page.locator('canvas.board-canvas').focus(); await page.keyboard.press('m');
        await page.locator('.mode-pill').waitFor(); await settle(page);
        const bounds = await page.evaluate(() => {
          const rect = element => { const r = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : element; return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
          const pill = document.querySelector('.mode-pill');
          const span = pill.querySelector(':scope > span'); const close = pill.querySelector(':scope > button'); const icon = pill.querySelector(':scope > svg');
          const buttons = [...document.querySelectorAll('.side-switch button')];
          const pillRect = rect(pill), spanRect = rect(span), closeRect = rect(close), iconRect = rect(icon);
          const intersection = other => ({ width: Math.max(0, Math.min(pillRect.right, other.right) - Math.max(pillRect.left, other.left)), height: Math.max(0, Math.min(pillRect.bottom, other.bottom) - Math.max(pillRect.top, other.top)) });
          const inside = (child, parent) => child.left >= parent.left - 1 && child.right <= parent.right + 1 && child.top >= parent.top - 1 && child.bottom <= parent.bottom + 1;
          const range = document.createRange(); range.selectNodeContents(span);
          const textRects = [...range.getClientRects()].map(rect);
          return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, prompt: span.textContent, pill: pillRect, span: spanRect, close: closeRect, icon: iconRect,
            sides: buttons.map(button => { const r = rect(button); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { text: button.textContent, rect: r, intersection: intersection(r), centerReceivesPointer: button === hit || button.contains(hit) }; }),
            textFits: span.scrollWidth <= span.clientWidth + 1 && span.scrollHeight <= span.clientHeight + 1 && textRects.every(r => inside(r, spanRect)),
            childrenFit: [spanRect, closeRect, iconRect].every(r => inside(r, pillRect)), closeSize: closeRect.width >= 13 && closeRect.height >= 13, iconSize: iconRect.width >= 13 && iconRect.height >= 13,
            pillFitsViewport: pillRect.left >= 0 && pillRect.right <= innerWidth && pillRect.top >= 0 && pillRect.bottom <= innerHeight };
        });
        const result = { language: language.code, layout, requested: { width, height: 640 }, bounds, failures: [] }; results.push(result);
        if (bounds.prompt.length < 10 || / mm$/.test(bounds.prompt)) result.failures.push('Expected the initial measurement prompt rather than a completed distance');
        if (bounds.sides.some(side => side.intersection.width > 0.5 && side.intersection.height > 0.5)) result.failures.push('Measurement prompt overlaps a side button');
        if (bounds.sides.some(side => !side.centerReceivesPointer)) result.failures.push('A side button center is covered');
        if (!bounds.textFits || !bounds.childrenFit || !bounds.closeSize || !bounds.iconSize || !bounds.pillFitsViewport) result.failures.push('Prompt text, icon or close button does not fit');
        for (const sideIndex of [1, 0]) {
          try {
            const button = page.locator('.side-switch button').nth(sideIndex);
            await button.click({ timeout: 2000 });
            assert.equal(await button.getAttribute('aria-pressed'), 'true');
            assert.equal(await page.locator('.mode-pill').count(), 1, 'Side switching should keep measurement mode active');
          } catch (error) { result.failures.push(`${sideIndex ? 'Bottom' : 'Top'} click failed: ${error.message.split('\n')[0]}`); }
        }
        if (width === 960 && layout === 'workshop' && ['de', 'it'].includes(language.code)) await shot(instance, `measurement-${language.code}-960-workshop`);
        try { await page.locator('.mode-pill > button').click({ timeout: 2000 }); await page.locator('.mode-pill').waitFor({ state: 'hidden' }); }
        catch (error) { result.failures.push(`Measurement close click failed: ${error.message.split('\n')[0]}`); }
        result.passed = result.failures.length === 0;
      }
    }
  }
  if (await page.locator('.app.focus-mode').count()) await page.locator('.header-actions .tool-button').first().click();
  await instance.resize(960, 640); await chooseLanguage(page, 'uk');
  const regression = instance.run.measurementPromptRegression;
  regression.passed = results.every(result => result.passed); regression.passedCases = results.filter(result => result.passed).length;
  assert.equal(regression.passed, true, `Measurement prompt regression: ${regression.passedCases}/${results.length} cases passed`);
  return { cases: results.length, passedCases: regression.passedCases };
}
async function localizationChecks(instance, expected) {
  const page = instance.page;
  // Windows can round a frameless minimum window by a few CSS pixels at 125% DPI.
  // Browser tests stay exactly 960×640; native tests keep the real minimum size.
  const nativeRoundingTolerance = instance.run.runtime === 'browser' ? 0 : 3;
  await step(instance, 'All eight language values and native autonyms are available', async () => {
    await openSettings(page);
    const options = await page.locator('dialog[open]').getByTestId('language-select').locator('option').evaluateAll(elements => elements.map(option => ({ code: option.value, name: option.textContent.trim() })));
    const byCode = (a, b) => a.code.localeCompare(b.code);
    assert.deepEqual([...options].sort(byCode), languages.map(({ code, name }) => ({ code, name })).sort(byCode));
    await closeSettings(page); return { options };
  });
  for (const language of languages) {
    await step(instance, `${language.code}: live switch preserves state and fits 960 × 640`, async () => {
      const workers = await page.evaluate(() => window.__localeWorkerCount);
      await openSettings(page); await page.locator('dialog[open]').getByTestId('language-select').selectOption(language.code); await waitLanguage(page, language.code);
      const layout = await assertCompactLayout(page, nativeRoundingTolerance); await shot(instance, `${language.code}-960-settings`); await closeSettings(page);
      assertSameState(await stateSnapshot(page), expected);
      assert.equal(await page.evaluate(() => window.__localeWorkerCount), workers, 'Locale-only UI changes must not reparse the board');
      assert.match(await page.locator('canvas.board-canvas').getAttribute('aria-label'), language.canvas, 'Canvas description should follow the current language');
      await shot(instance, `${language.code}-960-workshop`);
      return { htmlLang: await page.locator('html').getAttribute('lang'), layout, statePreserved: true, extraParserWorkers: 0 };
    });
    await step(instance, `${language.code}: clipboard messages and file errors are localized`, async () => {
      const clipboard = await clipboardChecks(instance, language);
      await instance.importEmpty(); await page.locator('.toast.error').waitFor(); await page.locator('.loading-overlay').waitFor({ state: 'hidden' });
      const error = await page.locator('.toast.error').innerText();
      assert.match(error, language.empty, 'Empty-file error should follow the current language');
      assert.doesNotMatch(error, /Error invoking remote method|trace:[a-z-]+/i, 'User errors should hide raw IPC prefixes');
      assertSameState(await stateSnapshot(page), expected);
      await instance.importMalformed(); await page.locator('.loading-overlay').waitFor({ state: 'hidden' });
      await page.locator('.toast.error').filter({ hasText: language.badNumber }).waitFor();
      const parserError = await page.locator('.toast.error').innerText();
      assert.match(parserError, language.badNumber, 'Worker parser issue should follow the current language');
      assert.match(parserError, language.line, 'Worker parser line suffix should be localized');
      assert.ok(parserError.includes('PLACE') && parserError.includes(String(malformedLine)), 'Parser record and exact source line should survive translation');
      assert.doesNotMatch(parserError, /\{(?:record|line)\}|Error invoking remote method|trace:[a-z-]+/i);
      assertSameState(await stateSnapshot(page), expected); await shot(instance, `${language.code}-960-error`);
      return { clipboard, error, parserError, parserLine: malformedLine, statePreserved: true };
    });
    await step(instance, `${language.code}: saved note and translated note dialog remain available`, async () => {
      await openNotes(page); assert.equal(await page.locator('#note-draft').inputValue(), NOTE);
      assert.match(await page.locator('dialog[open] .modal-header').innerText(), language.note, 'Note dialog should follow the current language');
      const layout = await assertCompactLayout(page, nativeRoundingTolerance);
      const live = page.locator('dialog[open] [data-testid="language-select"]');
      let draftSwitch = 'not exposed in the open note dialog; explicit cancellation retains its existing contract';
      if (await live.count()) {
        await page.locator('#note-draft').fill(DRAFT);
        const next = languages[(languages.indexOf(language) + 1) % languages.length].code;
        await live.selectOption(next); await waitLanguage(page, next); assert.equal(await page.locator('#note-draft').inputValue(), DRAFT);
        await live.selectOption(language.code); await waitLanguage(page, language.code); assert.equal(await page.locator('#note-draft').inputValue(), DRAFT);
        draftSwitch = 'tested: open unsaved draft preserved across two live language switches';
      }
      const fonts = language.code === 'uk' ? await ukrainianFonts(page) : null;
      await shot(instance, `${language.code}-960-notes`);
      await page.keyboard.press('Escape'); await page.locator('dialog').waitFor({ state: 'hidden' });
      assertSameState(await stateSnapshot(page), expected);
      return { savedNotePreserved: true, draftSwitch, layout, ...(fonts ? { ukrainianFonts: fonts } : {}) };
    });
  }
  await step(instance, 'Focus layout retains selection and note in long locales', async () => {
    for (const code of ['de', 'fr', 'uk']) {
      await chooseLanguage(page, code);
      await page.locator('.header-actions .tool-button').first().click();
      assert.equal(await page.locator('.app.focus-mode').count(), 1); await assertCompactLayout(page, nativeRoundingTolerance);
      assert.equal(await page.locator('.hero-ref').innerText(), 'R1'); assert.equal(await page.locator('.net-title strong').innerText(), 'GND');
      assert.equal(await page.locator('.note-preview span').innerText(), NOTE); await shot(instance, `${code}-960-focus`);
      await page.locator('.header-actions .tool-button').first().click(); assert.equal(await page.locator('.search-panel').count(), 1);
    }
    return { checked: ['de', 'fr', 'uk'] };
  });
  await step(instance, 'Notes remain writable after repeated language changes', async () => {
    const updated = NOTE + ' Updated after language switches.';
    for (const text of [updated, NOTE]) {
      await openNotes(page); await page.locator('#note-draft').fill(text);
      await page.locator('dialog[open] .modal-footer .primary-button').click(); await page.locator('dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.note-preview span').innerText(), text);
    }
    return { updatedAndRestoredThroughUI: true, savedBoardIdentityStillValid: true };
  });
  await step(instance, 'A pending clipboard failure uses the language active when it appears', async () => {
    await chooseLanguage(page, 'en'); const before = await stateSnapshot(page);
    await page.evaluate(() => {
      window.__localeClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((_resolve, reject) => { window.__localeRejectClipboard = reject; }) } });
    });
    try {
      await page.locator('.part-hero .tool-button').click(); await page.waitForFunction(() => typeof window.__localeRejectClipboard === 'function');
      await chooseLanguage(page, 'uk'); await page.evaluate(() => window.__localeRejectClipboard(new Error('Synthetic late clipboard denial')));
      await page.locator('.toast.error').filter({ hasText: languages.find(language => language.code === 'uk').clipboard }).waitFor();
      assertSameState(await stateSnapshot(page), before); return { requestedIn: 'en', warningDisplayedIn: 'uk', statePreserved: true };
    } finally {
      await page.evaluate(() => {
        const descriptor = window.__localeClipboardDescriptor;
        if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor); else delete navigator.clipboard;
        delete window.__localeClipboardDescriptor; delete window.__localeRejectClipboard;
      });
    }
  });
  // Keep the original localization checks, and exercise the longer initial prompt
  // separately from the completed numeric measurement used for state preservation.
  await measurementPromptChecks(instance);
}
async function browserRun() {
  const run = { runtime: 'browser', checks: [], screenshots: [], consoleErrors: [], pageErrors: [], navigation: [] }; report.runs.push(run);
  run.sourceAtStart = await sourceIdentity();
  const browser = await chromium.launch(browserOptions);
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(settings => { if (!localStorage.getItem('trace-settings')) localStorage.setItem('trace-settings', JSON.stringify(settings)); }, defaults);
  const page = await context.newPage(); collectErrors(page, run);
  const instance = { run, page, resize: (width, height) => page.setViewportSize({ width, height }),
    readClipboard: () => page.evaluate(() => navigator.clipboard.readText()),
    importEmpty: () => page.locator('input[type=file]').setInputFiles({ name: 'Localization-Empty.cad', mimeType: 'text/plain', buffer: Buffer.alloc(0) }),
    importMalformed: () => page.locator('input[type=file]').setInputFiles({ name: 'Localization-Malformed.cad', mimeType: 'text/plain', buffer: Buffer.from(malformedFixture) }) };
  try {
    await page.goto(QA_URL, { waitUntil: 'networkidle' });
    await page.locator('input[type=file]').setInputFiles({ name: filename, mimeType: 'text/plain', buffer: Buffer.from(fixture) });
    let expected;
    if (measurementPromptsOnly) {
      await waitBoard(page);
      await step(instance, 'Measurement prompt leaves side controls usable in all languages and breakpoints', () => measurementPromptChecks(instance));
    } else {
    await step(instance, 'Synthetic baseline includes selection net saved note camera and measurement', async () => {
      expected = await prepareBoard(instance); await assertCompactLayout(page); await shot(instance, 'baseline-960'); return expected;
    });
    if (!baselineOnly) {
      await localizationChecks(instance, expected);
      await step(instance, 'Browser language and saved note survive reload', async () => {
        await chooseLanguage(page, 'uk'); await page.reload({ waitUntil: 'networkidle' }); await waitLanguage(page, 'uk');
        await page.locator('input[type=file]').setInputFiles({ name: filename, mimeType: 'text/plain', buffer: Buffer.from(fixture) });
        await waitBoard(page); await selectR1(page); assert.equal(await page.locator('.note-preview span').innerText(), NOTE);
        assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('trace-settings'))).language, 'uk');
        await openSettings(page); assert.equal(await page.locator('dialog[open]').getByTestId('language-select').inputValue(), 'uk'); await closeSettings(page);
        await shot(instance, 'uk-browser-restored'); return { language: 'uk', savedNote: NOTE };
      });
    }
    }
    await step(instance, 'No console or uncaught page errors', async () => { assert.deepEqual(run.consoleErrors, []); assert.deepEqual(run.pageErrors, []); });
    run.passed = true;
  } catch (error) { run.passed = false; run.error = error.stack || String(error); await shot(instance, 'failure').catch(() => {}); }
  finally { await browser.close(); run.sourceAtEnd = await sourceIdentity(); }
}
async function nativeRun(packaged) {
  const runtime = packaged ? 'packaged' : 'electron';
  const run = { runtime, checks: [], screenshots: [], consoleErrors: [], pageErrors: [], navigation: [] }; report.runs.push(run);
  const profile = path.join(OUT, `${runtime}-profile-${Date.now()}`);
  await fs.mkdir(profile, { recursive: true }); await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({ version: 1, settings: defaults, recentBoards: [] }));
  if (packaged && process.env.TRACE_PACKAGED_EXE && !path.isAbsolute(process.env.TRACE_PACKAGED_EXE)) throw new Error('TRACE_PACKAGED_EXE must be an absolute path to the packaged application executable.');
  const executablePath = packaged ? process.env.TRACE_PACKAGED_EXE || path.join(ROOT, 'release', 'win-unpacked', 'TRACE Boardviewer.exe') : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  run.executablePath = executablePath;
  run.acceptance = { recordedAt: new Date().toISOString(), executable: await fileIdentity(executablePath), sourceAtStart: await sourceIdentity(), launches: [] };
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  let app, page, instance;
  const launch = async openFixture => {
    app = await _electron.launch({ executablePath, args: [...(packaged ? [] : [ROOT]), `--user-data-dir=${profile}`, ...(openFixture ? [`--board=${fixturePath}`] : [])], env, timeout: 45000 });
    page = await app.firstWindow(); collectErrors(page, run);
    const nativeIdentity = await app.evaluate(({ app }, codes) => {
      const appPath = app.getAppPath();
      const nativePath = process.getBuiltinModule('node:path');
      // Use Electron's module loader so its fs wrapper can read inside app.asar.
      const nativeRequire = process.getBuiltinModule('node:module').createRequire(nativePath.join(appPath, 'package.json'));
      const io = nativeRequire('node:fs');
      const crypto = nativeRequire('node:crypto');
      // Same identity as sourceIdentity(): one SHA-256 over the namespace file names and contents of a language, in name order.
      const catalogs = codes.map(code => {
        const directory = nativePath.join(appPath, 'electron', 'locales', code);
        const names = io.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        for (const name of names) {
          const data = io.readFileSync(nativePath.join(directory, name));
          hash.update(name); hash.update('\0'); hash.update(data); hash.update('\0');
          bytes += data.length;
        }
        return { code, path: directory, files: names.length, sha256: hash.digest('hex'), bytes };
      });
      return { isPackaged: app.isPackaged, appPath, runtimeExecutable: process.execPath, version: app.getVersion(), versions: process.versions, catalogs };
    }, languages.map(({ code }) => code));
    const identity = { recordedAt: new Date().toISOString(), openingArgument: openFixture, productionUrl: page.url(), ...nativeIdentity,
      runtimeExecutableIdentity: await fileIdentity(nativeIdentity.runtimeExecutable),
      asar: nativeIdentity.appPath.toLowerCase().endsWith('.asar') ? await fileIdentity(nativeIdentity.appPath) : null };
    run.acceptance.launches.push(identity);
    assert.equal(identity.isPackaged, packaged);
    assert.ok(identity.productionUrl.startsWith('file:///'), 'Native acceptance must use a production file renderer');
    const normalizePath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    assert.equal(normalizePath(fileURLToPath(identity.productionUrl)), normalizePath(path.join(identity.appPath, 'dist', 'index.html')), 'Renderer URL must belong to the running app root');
    assertCatalogIdentity(identity.catalogs, run.acceptance.sourceAtStart.catalogs);
    if (packaged) assert.ok(identity.asar, 'Packaged acceptance must identify its actual app.asar');
    const importPath = async selected => {
      await app.evaluate(({ dialog }, selectedPath) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [selectedPath] }; };
      }, selected);
      await page.locator('.header-actions .open-button').click();
    };
    instance = { run, page, resize: async (width, height) => {
      await app.evaluate(({ BrowserWindow }, dimensions) => BrowserWindow.getAllWindows()[0].setContentSize(dimensions.width, dimensions.height), { width, height });
      await page.waitForFunction(dimensions => Math.abs(innerWidth - dimensions.width) <= 3 && Math.abs(innerHeight - dimensions.height) <= 3, { width, height });
      (run.viewportResizes ||= []).push({ requested: { width, height }, actual: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio })),
        native: await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; return { bounds: win.getBounds(), contentBounds: win.getContentBounds(), minimumSize: win.getMinimumSize() }; }) });
    }, readClipboard: () => app.evaluate(({ clipboard }) => clipboard.readText()),
    importEmpty: () => importPath(emptyPath), importMalformed: () => importPath(malformedPath) };
    await instance.resize(1440, 960);
  };
  try {
    await launch(true);
    let expected;
    await step(instance, 'Native synthetic baseline uses an isolated production profile', async () => { expected = await prepareBoard(instance); await shot(instance, 'baseline-960'); return { state: expected, productionUrl: page.url(), profile }; });
    await localizationChecks(instance, expected);
    await step(instance, 'Native language and saved note survive a full process restart', async () => {
      await chooseLanguage(page, 'uk'); await app.close(); app = null; await launch(false); await waitBoard(page); await waitLanguage(page, 'uk'); await selectR1(page);
      assert.equal(await page.locator('.note-preview span').innerText(), NOTE);
      assert.equal((await page.evaluate(() => window.traceDesktop.getSettings())).language, 'uk');
      await openSettings(page); assert.equal(await page.locator('dialog[open]').getByTestId('language-select').inputValue(), 'uk'); await closeSettings(page);
      await instance.resize(960, 640); await shot(instance, 'uk-native-restored'); return { language: 'uk', savedNote: NOTE, recentBoardRestored: true };
    });
    await step(instance, 'No native renderer console or uncaught page errors', async () => {
      assert.deepEqual(run.consoleErrors, []); assert.deepEqual(run.pageErrors, []);
      run.acceptance.sourceAtEnd = await sourceIdentity();
      run.acceptance.executableAtEnd = await fileIdentity(executablePath);
      run.acceptance.executableUnchanged = run.acceptance.executable.sha256 === run.acceptance.executableAtEnd.sha256;
      run.acceptance.sourceUnchanged = [...run.acceptance.sourceAtStart.files, ...run.acceptance.sourceAtStart.catalogs].every((before, index) => before.sha256 === [...run.acceptance.sourceAtEnd.files, ...run.acceptance.sourceAtEnd.catalogs][index].sha256);
      assert.equal(run.acceptance.executableUnchanged, true, 'The requested executable changed during native acceptance');
      assert.equal(run.acceptance.sourceUnchanged, true, 'The source freeze changed during native acceptance');
      assert.deepEqual(run.acceptance.launches[1].asar, run.acceptance.launches[0].asar, 'The app archive changed across the native restart');
      return { executableUnchanged: true, sourceUnchanged: true, catalogSourceParity: true, launches: run.acceptance.launches.length };
    });
    run.passed = true;
  } catch (error) { run.passed = false; run.error = error.stack || String(error); if (instance && !instance.page.isClosed()) await shot(instance, 'failure').catch(() => {}); }
  finally { if (app) await app.close().catch(() => {}); }
}

(async () => {
  if (baselineOnly && mode !== 'browser') throw new Error('--baseline is a browser-only pre-localization fixture check.');
  if (measurementPromptsOnly && (mode !== 'browser' || baselineOnly)) throw new Error('--measurement-prompts-only is a browser-only targeted regression check.');
  await fs.mkdir(OUT, { recursive: true }); await fs.writeFile(fixturePath, fixture); await fs.writeFile(emptyPath, ''); await fs.writeFile(malformedPath, malformedFixture);
  if (mode === 'browser' || mode === 'all') await browserRun();
  if (mode === 'electron' || mode === 'all') await nativeRun(false);
  if (mode === 'packaged' || mode === 'all') await nativeRun(true);
  report.finishedAt = new Date().toISOString(); report.passed = report.runs.length > 0 && report.runs.every(run => run.passed);
  const output = path.join(OUT, `qa-localization-${measurementPromptsOnly ? 'measurement-prompts-' : ''}${baselineOnly ? 'baseline' : mode}.json`); await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Localization report: ${output}`); process.exitCode = report.passed ? 0 : 1;
})().catch(async error => {
  report.error = error.stack || String(error); report.passed = false;
  await fs.mkdir(OUT, { recursive: true }).catch(() => {}); await fs.writeFile(path.join(OUT, 'qa-localization-startup-failure.json'), JSON.stringify(report, null, 2) + '\n').catch(() => {});
  console.error(error); process.exitCode = 1;
});
