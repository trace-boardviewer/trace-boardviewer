'use strict';

// Drives harness/pdf-viewer.html (PdfViewer + synthetic PDFs + a controlled shell) in headless Chromium.
// Usage: node scripts/qa-pdf-viewer.cjs [scenario ...]    (no argument = every scenario)
// Env:   TRACE_QA_URL (default http://127.0.0.1:5202; a vite dev server is started when nothing answers there),
//        TRACE_QA_OUT (screenshots, default test-results/pdf-viewer), TRACE_CHROMIUM_PATH, PLAYWRIGHT_BROWSERS_PATH.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.TRACE_PLAYWRIGHT_PATH || 'playwright');

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.TRACE_QA_URL || 'http://127.0.0.1:5202').replace(/\/$/, '');
const OUT = process.env.TRACE_QA_OUT || path.join(ROOT, 'test-results', 'pdf-viewer');
const HARNESS = `${BASE}/harness/pdf-viewer.html`;

const results = [];
let currentScenario = '';
function check(name, ok, detail) {
  results.push({ scenario: currentScenario, name, ok: !!ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${currentScenario} :: ${name}${detail !== undefined ? `  [${typeof detail === 'string' ? detail : JSON.stringify(detail)}]` : ''}`);
}
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function findChromium() {
  if (process.env.TRACE_CHROMIUM_PATH) return process.env.TRACE_CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(require('node:os').homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root).sort().reverse(); } catch { continue; }
    for (const entry of entries) {
      for (const candidate of [`${entry}/chrome-linux/chrome`, `${entry}/chrome-linux/headless_shell`, `${entry}/chrome-linux64/chrome`, `${entry}/chrome-win/chrome.exe`]) {
        if (/^chromium(_headless_shell)?-/.test(entry) && fs.existsSync(path.join(root, candidate))) return path.join(root, candidate);
      }
    }
  }
  return undefined;
}

async function serverUp() {
  try { return (await fetch(HARNESS)).ok; } catch { return false; }
}
async function ensureServer() {
  if (await serverUp()) return null;
  const port = new URL(BASE).port || '5202';
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', port, '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { if (await serverUp()) return child; await sleep(250); }
  child.kill();
  throw new Error(`dev server did not start on ${BASE}`);
}

async function shot(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

// ------------------------------------------------------------------------------------------------ page helpers
async function open(browser, query, viewport = { width: 1200, height: 800 }, options = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: options.dpr || 1, reducedMotion: options.reducedMotion || 'no-preference', colorScheme: 'dark' });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', error => page.errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') page.errors.push(`console.error: ${message.text()}`); });
  await page.goto(`${HARNESS}?${query}`);
  await page.waitForFunction(() => window.__harnessReady === true, null, { timeout: 30000 });
  return page;
}
const state = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__harness.state())));
const stats = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__harness.stats())));
async function ready(page, n = 1) {
  await page.waitForSelector(`.pdfv-page[data-page="${n}"][data-render="done"]`, { timeout: 20000 });
}
async function settle(page, ms = 450) { await page.waitForTimeout(ms); }
const root = page => page.locator('.pdfv');
const attr = (page, name) => page.locator('.pdfv').getAttribute(name);
async function viewerState(page) {
  return page.evaluate(() => {
    const element = document.querySelector('.pdfv');
    const scroller = document.querySelector('.pdfv-scroller');
    return element ? { page: Number(element.dataset.page), zoom: Number(element.dataset.zoom), rotation: Number(element.dataset.rotation), fit: element.dataset.fit, scrollTop: scroller?.scrollTop, scrollLeft: scroller?.scrollLeft, attached: Number(scroller?.dataset.canvasesAttached), cached: Number(scroller?.dataset.canvasesCached), mounted: Number(scroller?.dataset.pagesMounted) } : null;
  });
}
const rectOf = (page, selector, index = 0) => page.evaluate(([sel, i]) => {
  const element = document.querySelectorAll(sel)[i];
  if (!element) return null;
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}, [selector, index]);
const iou = (a, b) => {
  if (!a || !b) return 0;
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)), h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = w * h;
  return inter / (a.width * a.height + b.width * b.height - inter || 1);
};
/** Rect of the first text-layer span of a page whose text equals `text`. */
const spanRect = (page, pageNumber, text) => page.evaluate(([n, t]) => {
  const span = [...document.querySelectorAll(`.pdfv-page[data-page="${n}"] .pdfv-text > span`)].find(s => s.textContent === t);
  if (!span) return null;
  const r = span.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}, [pageNumber, text]);
const searchBox = page => page.getByLabel('Find in document', { exact: true });
async function search(page, query) {
  const box = searchBox(page);
  await box.fill(query);
  await page.waitForFunction(q => {
    const count = document.querySelector('[data-testid="pdfv-count"]')?.textContent ?? '';
    return q === '' || (count !== '' && !/Searching/.test(count));
  }, query, { timeout: 20000 });
  await page.waitForTimeout(150);
}
const countText = page => page.locator('[data-testid="pdfv-count"]').textContent();
const button = (page, label) => page.getByRole('button', { name: label, exact: true });

// ------------------------------------------------------------------------------------------------ scenarios
const scenarios = {};

scenarios.vector = async browser => {
  const page = await open(browser, 'doc=vector');
  await ready(page);
  await settle(page);
  const v0 = await viewerState(page);
  check('opens ready with fit-width default', (await state(page)).status === 'ready' && v0.fit === 'width' && v0.page === 1, v0);
  check('renders page canvases and thumbnails', (await page.locator('.pdfv-page canvas').count()) >= 1 && (await page.locator('.pdfv-thumb canvas').count()) >= 1);
  check('text layer holds the PDF text', (await spanRect(page, 1, 'PU301')) !== null && (await spanRect(page, 1, 'GND')) !== null);

  // text selection through the real pointer: triple-click selects the sentence line
  const sentence = await page.evaluate(() => {
    const span = [...document.querySelectorAll('.pdfv-page[data-page="1"] .pdfv-text > span')].find(s => s.textContent.startsWith('The quick brown fox'));
    const r = span.getBoundingClientRect();
    return { x: r.x + 40, y: r.y + r.height / 2 };
  });
  await page.mouse.click(sentence.x, sentence.y, { clickCount: 3 });
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  check('triple-click selects the text line', /The quick brown fox jumps over the lazy dog/.test(selected), selected.slice(0, 60));
  await page.mouse.click(5, 5); // clear

  // search: count, hits, active hit, wrap
  await search(page, 'PU301');
  check('search count and first active hit', (await countText(page)).startsWith('1 / 8'), await countText(page));
  const hitsOnPage1 = await page.locator('.pdfv-page[data-page="1"] .pdfv-hit').count();
  check('page 1 shows both hits, one active', hitsOnPage1 === 2 && (await page.locator('.pdfv-hit.is-active').count()) === 1, hitsOnPage1);
  const activeRect = await rectOf(page, '.pdfv-hit.is-active');
  const spanBox = await spanRect(page, 1, 'PU301');
  check('active hit sits on the matching text (IoU > 0.55)', iou(activeRect, spanBox) > 0.55, { iou: iou(activeRect, spanBox) });
  const styles = await page.evaluate(() => {
    const active = getComputedStyle(document.querySelector('.pdfv-hit.is-active'));
    const other = getComputedStyle(document.querySelector('.pdfv-hit:not(.is-active)'));
    return { active: active.boxShadow, other: other.boxShadow };
  });
  check('active hit is visually stronger than other hits', styles.active !== styles.other && styles.active.length > styles.other.length, styles);
  await shot(page, 'vector-search');
  const seen = [];
  for (let i = 0; i < 8; i++) { await searchBox(page).press('Enter'); await page.waitForTimeout(120); seen.push(await countText(page)); }
  check('Enter walks the hits and wraps to the first', seen[6] === '8 / 8' && seen[7] === '1 / 8', seen);
  await searchBox(page).press('Shift+Enter');
  await page.waitForTimeout(150);
  check('Shift+Enter goes back with wrap to the last hit', (await countText(page)) === '8 / 8', await countText(page));
  await page.waitForTimeout(500);
  check('navigating to a hit on page 3 scrolls there', (await viewerState(page)).page === 3, await viewerState(page));
  await button(page, 'Whole word').click();
  await page.waitForTimeout(500);
  check('whole-word drops PU3011 (7 matches)', (await countText(page)).endsWith('/ 7'), await countText(page));
  await button(page, 'Whole word').click();
  await searchBox(page).fill('');
  await page.waitForTimeout(300);
  check('clearing the query clears hits', (await page.locator('.pdfv-hit').count()) === 0 && (await countText(page)) === '');

  // page jump, prev/next
  const pageInput = page.getByLabel('Page number', { exact: true });
  await pageInput.fill('2');
  await pageInput.press('Enter');
  await settle(page, 600);
  check('typed page jump', (await viewerState(page)).page === 2 && (await pageInput.inputValue()) === '2', await viewerState(page));
  await button(page, 'Next page').click();
  await settle(page, 600);
  check('next page', (await viewerState(page)).page === 3);
  await button(page, 'Previous page').click();
  await settle(page, 600);
  check('previous page', (await viewerState(page)).page === 2);

  // zoom
  const zoomInput = page.getByLabel('Zoom percent', { exact: true });
  await zoomInput.click();
  await zoomInput.fill('200');
  await zoomInput.press('Enter');
  await settle(page, 500);
  let v = await viewerState(page);
  check('typed zoom 200% switches fit off', v.zoom === 2 && v.fit === 'none', v);
  await button(page, 'Zoom out (-)').click();
  await settle(page, 300);
  check('zoom out steps down', (await viewerState(page)).zoom < 2, (await viewerState(page)).zoom);
  await button(page, 'Zoom in (+)').click();
  await zoomInput.fill('garbage');
  await zoomInput.press('Enter');
  await settle(page, 300);
  check('garbage zoom text is rejected', (await viewerState(page)).zoom >= 1.5, (await viewerState(page)).zoom);
  await button(page, 'Fit page').click();
  await settle(page, 500);
  v = await viewerState(page);
  const pageBox = await rectOf(page, `.pdfv-page[data-page="${v.page}"]`);
  const scrollerBox = await rectOf(page, '.pdfv-scroller');
  check('fit page makes the whole page visible', v.fit === 'page' && pageBox.height <= scrollerBox.height + 1 && pageBox.width <= scrollerBox.width + 1, { v, pageBox: [pageBox.width, pageBox.height], scroller: [scrollerBox.width, scrollerBox.height] });
  await button(page, 'Fit width').click();
  await settle(page, 500);
  v = await viewerState(page);
  const wideBox = await rectOf(page, `.pdfv-page[data-page="${v.page}"]`);
  check('fit width fills the pane width', v.fit === 'width' && wideBox.width > scrollerBox.width - 40 && wideBox.width <= scrollerBox.width, { wide: wideBox.width, pane: scrollerBox.width });

  // keyboard: PageDown at fit page, +/-, Ctrl+F
  await button(page, 'Fit page').click();
  await settle(page, 500);
  await page.locator('.pdfv-scroller').focus();
  const before = (await viewerState(page)).page;
  await page.keyboard.press('PageDown');
  await settle(page, 600);
  check('PageDown moves one page at fit-page', (await viewerState(page)).page === Math.min(3, before + 1), await viewerState(page));
  await page.keyboard.press('+');
  await settle(page, 200);
  const zin = (await viewerState(page)).zoom;
  await page.keyboard.press('-');
  await settle(page, 200);
  check('+ / - change the zoom', zin > (await viewerState(page)).zoom, { zin, after: (await viewerState(page)).zoom });
  await page.keyboard.press('Control+f');
  check('Ctrl+F focuses the search field', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Find in document'));
  await page.locator('.pdfv-scroller').focus();
  await page.evaluate(() => window.__harness.bumpSearchFocus());
  await page.waitForTimeout(100);
  check('focusSearchNonce focuses the search field', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Find in document'));
  await shot(page, 'vector-fit-page');
  check('no page errors', page.errors.length === 0, page.errors);
  await page.context().close();
};

scenarios.interaction = async browser => {
  const page = await open(browser, 'doc=vector');
  await ready(page);
  await settle(page, 700);

  // probe regions: buttons with accessible names, distinct from search highlights
  const probes = await page.locator('.pdfv-probe').count();
  const labels = await page.locator('.pdfv-probe').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
  check('probe regions are buttons with accessible names', probes >= 2 && labels.every(label => /Component|Net/.test(label)), labels);
  await page.locator('.pdfv-probe').first().click();
  let s = await state(page);
  check('probe click reaches onProbeRegionClick', s.probeClicks.length === 1 && /PU301|GND|R12/.test(s.probeClicks[0]), s.probeClicks);
  await page.waitForTimeout(200);
  check('selection highlight is painted with the net accent', (await page.locator('.pdfv-xhl-selection').count()) === 1);
  const probeColors = await page.evaluate(() => {
    const probe = getComputedStyle(document.querySelector('.pdfv-xhl-probe, .pdfv-xhl-selection'));
    return probe.boxShadow;
  });
  check('probe/selection style differs from search style', !!probeColors);
  await shot(page, 'interaction-probes');

  // bookmarks round trip
  await button(page, 'Next page').click();
  await settle(page, 600);
  await button(page, 'Add bookmark at this position').click();
  await page.waitForTimeout(250);
  s = await state(page);
  check('bookmark created through onBookmarksChange', s.bookmarks.length === 1 && s.bookmarks[0].page === 2 && s.bookmarks[0].label === 'Page 2' && typeof s.bookmarks[0].y === 'number', s.bookmarks);
  const rename = page.getByLabel('Bookmark name', { exact: true });
  check('new bookmark opens in rename mode', await rename.isVisible());
  await rename.fill('Regulator output');
  await rename.press('Enter');
  await page.waitForTimeout(200);
  s = await state(page);
  check('rename commits', s.bookmarks[0].label === 'Regulator output', s.bookmarks);
  await button(page, 'Previous page').click();
  await settle(page, 600);
  await page.getByRole('button', { name: 'Regulator output, page 2' }).click();
  await settle(page, 700);
  check('bookmark jump goes to its page', (await viewerState(page)).page === 2, await viewerState(page));
  await shot(page, 'interaction-bookmarks');
  await page.getByRole('button', { name: 'Delete bookmark: Regulator output' }).click();
  await page.waitForTimeout(200);
  check('bookmark delete', (await state(page)).bookmarks.length === 0);

  // annotation round trip: click-to-place
  await button(page, 'Fit width').click();
  await settle(page, 500);
  await page.getByRole('button', { name: /^Add note/ }).click();
  const target = await spanRect(page, 2, 'PU301');
  // scroll the page into view first
  await page.evaluate(() => document.querySelector('.pdfv-page[data-page="2"]').scrollIntoView({ block: 'start' }));
  await settle(page, 500);
  const spot = await spanRect(page, 2, 'PU301');
  await page.mouse.click(spot.cx, spot.cy);
  await page.waitForSelector('.pdfv-popover textarea');
  check('note editor opens and takes focus', await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'));
  await page.keyboard.type('Check C7 ripple here');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForTimeout(250);
  s = await state(page);
  const note = s.annotations[0];
  check('annotation stored in document space', s.annotations.length === 1 && note.page === 2 && near(note.x, 72 + 18, 25) && near(note.y, 792 - 680 - 6, 25) && note.text === 'Check C7 ripple here' && !!note.updatedAt, note);
  check('marker exposes the note text', (await page.getByRole('button', { name: 'Note: Check C7 ripple here' }).count()) === 1);
  const marker = await rectOf(page, '.pdfv-note');
  check('marker sits on the clicked spot', near(marker.cx, spot.cx, 3) && near(marker.cy, spot.cy, 3), { marker: [marker.cx, marker.cy], spot: [spot.cx, spot.cy] });
  await shot(page, 'interaction-note');
  // the note follows the page through rotation (document-space storage)
  for (const turn of [1, 2, 3]) {
    await button(page, 'Rotate clockwise').click();
    await settle(page, 700);
    await page.evaluate(() => document.querySelector('.pdfv-page[data-page="2"]').scrollIntoView({ block: 'center' }));
    await settle(page, 500);
    const m = await rectOf(page, '.pdfv-note');
    const t = await spanRect(page, 2, 'PU301');
    check(`note stays on its text after rotating ${turn * 90} degrees`, m && t && m.cx > t.x - 10 && m.cx < t.x + t.width + 10 && m.cy > t.y - 12 && m.cy < t.y + t.height + 12, { m: m && [m.cx, m.cy], t: t && [t.x, t.y, t.width, t.height] });
  }
  await button(page, 'Rotate clockwise').click();
  await settle(page, 600);
  // edit through the marker, keyboard only
  await page.locator('.pdfv-note').focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pdfv-popover textarea');
  await page.keyboard.type(' (edited)');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(250);
  s = await state(page);
  check('keyboard edit updates the note', s.annotations[0].text === 'Check C7 ripple here (edited)', s.annotations[0]);
  check('focus returns to the marker', await page.evaluate(() => document.activeElement?.classList.contains('pdfv-note')));
  // sidebar notes list + delete
  await page.getByRole('tab', { name: 'Notes' }).click();
  check('notes panel lists the note', (await page.getByRole('button', { name: /Check C7 ripple here.*page 2/ }).count()) >= 1);
  await page.getByRole('button', { name: /^Delete note:/ }).click();
  await page.waitForTimeout(250);
  check('note delete', (await state(page)).annotations.length === 0 && (await page.locator('.pdfv-note').count()) === 0);
  // keyboard placement
  await page.getByRole('button', { name: /^Add note/ }).focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pdfv-popover textarea');
  await page.keyboard.type('Keyboard note');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  s = await state(page);
  check('keyboard placement creates a note at the view centre', s.annotations.length === 1 && s.annotations[0].text === 'Keyboard note', s.annotations);
  // empty drafts are discarded
  await page.getByRole('button', { name: /^Add note/ }).focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pdfv-popover textarea');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('an empty note is never stored', (await state(page)).annotations.length === 1);
  check('no page errors', page.errors.length === 0, page.errors);
  await page.context().close();
};

scenarios.camera = async browser => {
  const page = await open(browser, 'doc=vector');
  await ready(page);
  await settle(page, 800);
  await page.waitForTimeout(500);
  let s = await state(page);
  check('initial camera is reported', s.cameraCalls >= 1 && s.lastCamera && s.lastCamera.page === 1 && s.lastCamera.fit === 'width', { calls: s.cameraCalls, last: s.lastCamera });
  const calls0 = s.cameraCalls;
  // quiescence: echoing the emitted camera back must not cause a feedback loop
  await page.waitForTimeout(1500);
  check('echoed camera does not loop', (await state(page)).cameraCalls === calls0, { before: calls0, after: (await state(page)).cameraCalls });
  // throttled while scrolling
  await page.evaluate(async () => {
    const el = document.querySelector('.pdfv-scroller');
    for (let i = 0; i < 60; i++) { el.scrollTop += 25; await new Promise(r => setTimeout(r, 8)); }
  });
  await page.waitForTimeout(700);
  s = await state(page);
  const burst = s.cameraCalls - calls0;
  check('camera changes are throttled while scrolling (<= 6 for ~0.5s of scroll)', burst >= 1 && burst <= 6, burst);
  check('last camera carries a document-space position', typeof s.lastCamera.x === 'number' && typeof s.lastCamera.y === 'number', s.lastCamera);
  // external restore
  await page.evaluate(() => window.__harness.setCamera({ page: 3, zoom: 1, rotation: 90, fit: 'none' }));
  await settle(page, 900);
  let v = await viewerState(page);
  check('external camera restores page, zoom and rotation', v.page === 3 && v.zoom === 1 && v.rotation === 90 && v.fit === 'none', v);
  await page.evaluate(() => window.__harness.setCamera({ page: 2, zoom: 1.5, rotation: 0, fit: 'none', x: 100, y: 200 }));
  await settle(page, 900);
  v = await viewerState(page);
  const pageTop = await page.evaluate(() => document.querySelector('.pdfv-page[data-page="2"]').getBoundingClientRect().top - document.querySelector('.pdfv-scroller').getBoundingClientRect().top);
  check('camera x/y places that document point at the viewport corner', v.page === 2 && near(pageTop, -200 * 1.5, 3) && near(v.scrollLeft, Math.max(0, v.scrollLeft), 1), { v, pageTop });
  await page.evaluate(() => window.__harness.setCamera({ fit: 'width' }));
  await settle(page, 700);
  check('external fit mode applies', (await viewerState(page)).fit === 'width');
  // round-trip of the emitted camera through a fresh viewer
  const last = (await state(page)).lastCamera;
  await page.evaluate(() => window.__harness.load('vector'));
  await ready(page);
  await page.evaluate(cam => window.__harness.setCamera(cam), { ...last, page: 3, y: 100, x: 0, fit: 'none', zoom: 1 });
  await settle(page, 900);
  v = await viewerState(page);
  check('restore on a freshly opened session', v.page === 3 && v.zoom === 1, v);
  check('no page errors', page.errors.length === 0, page.errors);
  await page.context().close();
};

scenarios.scan = async browser => {
  const page = await open(browser, 'doc=scan');
  await ready(page);
  await page.waitForSelector('[data-notice="raster"]', { timeout: 15000 });
  const notice = await page.locator('[data-notice="raster"]').textContent();
  check('scan-only PDF states that search is unavailable', /No text layer/.test(notice) && /scanned or raster/.test(notice), notice);
  check('search field is disabled', await searchBox(page).isDisabled());
  check('pages still render (raster)', (await page.locator('.pdfv-page canvas').count()) >= 1);
  check('no text layer spans', (await page.locator('.pdfv-text > span').count()) === 0);
  await shot(page, 'scan');
  check('no page errors', page.errors.length === 0, page.errors);
  await page.context().close();
};

scenarios.rotated = async browser => {
  const page = await open(browser, 'doc=rotated&probes=0');
  await ready(page);
  await search(page, 'GND');
  const pageInput = page.getByLabel('Page number', { exact: true });
  const expectedLandscape = { 2: true, 4: true, 5: true };
  for (let n = 1; n <= 5; n++) {
    await pageInput.fill(String(n));
    await pageInput.press('Enter');
    await ready(page, n);
    await settle(page, 500);
    const box = await rectOf(page, `.pdfv-page[data-page="${n}"]`);
    const landscape = box.width > box.height;
    check(`page ${n} is sized from /Rotate (landscape=${!!expectedLandscape[n]})`, landscape === !!expectedLandscape[n], { w: box.width, h: box.height });
    const hit = await rectOf(page, `.pdfv-page[data-page="${n}"] .pdfv-hit`);
    const text = await spanRect(page, n, 'GND');
    check(`page ${n}: search highlight lies on the text layer`, iou(hit, text) > 0.5, { iou: iou(hit, text) });
  }
  // user rotation on top of the page's own /Rotate
  await pageInput.fill('2'); await pageInput.press('Enter');
  await settle(page, 500);
  await button(page, 'Rotate clockwise').click();
  await ready(page, 2);
  await settle(page, 800);
  const hit = await rectOf(page, '.pdfv-page[data-page="2"] .pdfv-hit');
  const text = await spanRect(page, 2, 'GND');
  const box = await rectOf(page, '.pdfv-page[data-page="2"]');
  check('user rotation adds to /Rotate (page 2 becomes portrait again)', box.height > box.width && iou(hit, text) > 0.5, { box: [box.width, box.height], iou: iou(hit, text) });
  await shot(page, 'rotated');
  check('no page errors', page.errors.length === 0, page.errors);
  await page.context().close();
};

scenarios.mixed = async browser => {
  const page = await open(browser, 'doc=mixed&probes=0');
  await ready(page);
  await settle(page, 800);
  const sizes = await page.evaluate(() => [...document.querySelectorAll('.pdfv-page')].map(el => ({ n: Number(el.dataset.page), w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })));
  const expected = { 1: 595 / 842, 2: 1190 / 842, 3: 612 / 792, 4: 1 };
  check('placeholders keep each page aspect ratio (mixed sizes)', sizes.length >= 2 && sizes.every(item => near(item.w / item.h, expected[item.n], 0.01)), sizes);
  check('no page errors', page.errors.length === 0, page.errors);
  await page.context().close();
};

scenarios.big = async browser => {
  const page = await open(browser, 'doc=big&probes=0');
  await ready(page);
  await settle(page, 800);
  const peak = { attached: 0, cached: 0, mounted: 0, live: 0, megapixels: 0, maxCanvas: 0 };
  const sample = async () => {
    const v = await viewerState(page), st = await stats(page);
    peak.attached = Math.max(peak.attached, v.attached); peak.cached = Math.max(peak.cached, v.cached); peak.mounted = Math.max(peak.mounted, v.mounted);
    peak.live = Math.max(peak.live, st.live); peak.megapixels = Math.max(peak.megapixels, st.megapixels); peak.maxCanvas = Math.max(peak.maxCanvas, st.maxCanvasMegapixels);
    return { v, st };
  };
  const pageInput = page.getByLabel('Page number', { exact: true });
  check('300 pages known', (await page.locator('.pdfv-of').textContent()).includes('300'));
  for (const target of [50, 150, 299, 1, 250, 120, 300]) {
    await pageInput.fill(String(target));
    await pageInput.press('Enter');
    await settle(page, 700);
    const { v } = await sample();
    check(`jump to page ${target}`, v.page === target, v.page);
  }
  const jumps = await sample();
  check('mounted pages stay bounded (<= 5)', peak.mounted <= 5, peak);
  check('attached page canvases stay bounded (<= 5)', peak.attached <= 5, peak);
  check('cached canvases within the cache bound (<= 6)', peak.cached <= 6, peak);
  // bound = 6 cached + 3 attached page canvases + 24 cached + <= 15 mounted thumbnail canvases
  check('live canvases incl. thumbnails stay bounded (<= 48)', peak.live <= 48, peak);
  check('render concurrency never exceeds 2 (+ 1 thumbnail)', jumps.st.maxInflight <= 3, jumps.st.maxInflight);
  check('thumbnail DOM is virtualized (<= 30 of 300)', (await page.locator('.pdfv-thumb').count()) <= 30, await page.locator('.pdfv-thumb').count());
  console.log(`   numbers after 7 jumps: renders started=${jumps.st.calls} completed=${jumps.st.completed} aborted=${jumps.st.aborted} peak=${JSON.stringify(peak)}`);

  // fast scroll through ~100 pages: pages that only flash by must not be rendered
  await page.evaluate(() => window.__harness.resetStats());
  const crossed = await page.evaluate(async () => {
    const el = document.querySelector('.pdfv-scroller');
    el.scrollTop = 0;
    await new Promise(r => setTimeout(r, 300));
    for (let i = 0; i < 70; i++) { el.scrollTop += 2600; await new Promise(r => setTimeout(r, 14)); }
    return Number(document.querySelector('.pdfv').dataset.page);
  });
  await settle(page, 900);
  const churn = await sample();
  const mainRenders = churn.st.log.filter(entry => entry.scale >= 0.5).length, thumbRenders = churn.st.log.length - mainRenders;
  check('fast scroll renders far fewer pages than it crosses', mainRenders < crossed / 3 && thumbRenders < crossed / 2, { crossed, mainRenders, thumbRenders, started: churn.st.calls });
  console.log(`   fast scroll crossed ${crossed} pages: renders started=${churn.st.calls} completed=${churn.st.completed} aborted=${churn.st.aborted}`);

  // obsolete render cancelled
  await page.evaluate(() => { window.__harness.setSlow(500); window.__harness.resetStats(); });
  await pageInput.fill('200'); await pageInput.press('Enter');
  await page.waitForTimeout(350);
  await pageInput.fill('20'); await pageInput.press('Enter');
  await page.waitForTimeout(1500);
  const cancelled = await stats(page);
  check('abandoned render is aborted and never completes', cancelled.aborted >= 1 && cancelled.perPage[200] === undefined, { aborted: cancelled.aborted, completed200: cancelled.perPage[200] ?? 0 });
  await page.evaluate(() => window.__harness.setSlow(0));

  // search / outline on the big document
  await search(page, 'NEEDLE');
  await settle(page, 600);
  check('search finds the single needle and jumps to page 150', (await countText(page)) === '1 / 1' && (await viewerState(page)).page === 150, { count: await countText(page), v: await viewerState(page) });
  await searchBox(page).fill('');
  await page.getByRole('tab', { name: 'Outline' }).click();
  await page.getByRole('button', { name: 'End, page 300', exact: true }).click();
  await settle(page, 800);
  check('outline entry jumps to page 300', (await viewerState(page)).page === 300, await viewerState(page));
  await shot(page, 'big-end');

  // switching documents releases everything of the old session
  await page.evaluate(() => window.__harness.load('vector'));
  await ready(page);
  await settle(page, 800);
  const after = await stats(page);
  check('document switch disposes the old session and frees its canvases', after.handleLog.includes('dispose') && after.live <= 8, { log: after.handleLog, live: after.live });
  check('no page errors', page.errors.length === 0, page.errors);
  await page.context().close();
};

scenarios.states = async browser => {
  let page = await open(browser, 'doc=encrypted');
  await page.waitForSelector('form[aria-labelledby="pdfv-pw-title"]', { timeout: 15000 });
  check('password-protected PDF asks for a password', await page.getByLabel('Password', { exact: true }).isVisible());
  await shot(page, 'state-password');
  await page.getByLabel('Password', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.waitForFunction(() => /not correct/.test(document.querySelector('#pdfv-pw-error')?.textContent ?? ''), null, { timeout: 15000 });
  check('wrong password shows an alert', true);
  await page.getByLabel('Password', { exact: true }).fill('secret');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await ready(page);
  check('correct password opens the document', (await state(page)).status === 'ready' && (await page.locator('.pdfv-text > span').count()) > 0);
  await page.evaluate(() => window.__harness.dispose());
  await page.waitForSelector('text=This document has been closed');
  check('closed session shows the closed state', true);
  check('no page errors', page.errors.length === 0, page.errors);
  await page.context().close();
  page = await open(browser, 'doc=broken');
  await page.waitForSelector('text=The PDF could not be opened', { timeout: 15000 });
  check('invalid PDF shows the error state with its code', /INVALID_PDF/.test(await page.locator('.pdfv-state').textContent()));
  await shot(page, 'state-error');
  check('no page errors (broken file)', page.errors.length === 0, page.errors);
  await page.context().close();
};

scenarios.layout = async browser => {
  for (const width of [960, 1200, 1440, 1920]) {
    const page = await open(browser, 'doc=vector', { width, height: 800 });
    await ready(page);
    await searchBox(page).fill('PU301');
    await page.waitForTimeout(700);
    const geometry = await page.evaluate(() => {
      const pane = document.querySelector('.pdfv').getBoundingClientRect();
      const controls = [...document.querySelectorAll('.pdfv-toolbar button, .pdfv-toolbar input')].map(el => el.getBoundingClientRect());
      const search = document.querySelector('.pdfv-search').getBoundingClientRect();
      return { pane: pane.width, outside: controls.filter(r => r.right > pane.right + 0.5 || r.left < pane.left - 0.5).length, search: search.width, docOverflow: document.documentElement.scrollWidth > innerWidth, toolbarH: document.querySelector('.pdfv-toolbar').getBoundingClientRect().height };
    });
    check(`${width}px: toolbar fits, search field usable, no horizontal page scroll`, geometry.outside === 0 && geometry.search >= 150 && !geometry.docOverflow, geometry);
    await shot(page, `layout-${width}`);
    check(`${width}px: no page errors`, page.errors.length === 0, page.errors);
    await page.context().close();
  }
  let page = await open(browser, 'doc=vector&compact=1&w=420&h=640', { width: 900, height: 700 });
  await ready(page);
  await settle(page, 500);
  check('compact: sidebar and thumbnails are hidden by default', (await page.locator('.pdfv-sidebar').count()) === 0 && (await page.locator('.pdfv-thumb').count()) === 0);
  const compact = await page.evaluate(() => {
    const pane = document.querySelector('.pdfv').getBoundingClientRect();
    const controls = [...document.querySelectorAll('.pdfv-toolbar button, .pdfv-toolbar input')].map(el => el.getBoundingClientRect());
    return { pane: pane.width, outside: controls.filter(r => r.right > pane.right + 0.5 || r.left < pane.left - 0.5).length, toolbarH: document.querySelector('.pdfv-toolbar').getBoundingClientRect().height, scrollW: document.querySelector('.pdfv-toolbar').scrollWidth, clientW: document.querySelector('.pdfv-toolbar').clientWidth };
  });
  check('compact (420px pane): toolbar controls stay inside the pane', compact.outside === 0 && compact.scrollW <= compact.clientW + 1, compact);
  await button(page, 'Show sidebar').click();
  await page.waitForSelector('.pdfv-sidebar');
  check('compact sidebar offers outline/bookmarks/notes but no thumbnails tab', (await page.getByRole('tab', { name: 'Pages' }).count()) === 0 && (await page.getByRole('tab', { name: 'Outline' }).count()) === 1);
  await shot(page, 'layout-compact-sidebar');
  await page.getByRole('button', { name: 'Details, page 3', exact: true }).click();
  await settle(page, 600);
  check('compact: choosing an outline entry jumps and closes the overlay', (await viewerState(page)).page === 3 && (await page.locator('.pdfv-sidebar').count()) === 0, await viewerState(page));
  await shot(page, 'layout-compact');
  await page.context().close();
  page = await open(browser, 'doc=vector&theme=light');
  await ready(page);
  await search(page, 'PU301');
  await shot(page, 'layout-light');
  check('light theme: no page errors', page.errors.length === 0, page.errors);
  await page.context().close();
  // reduced motion: short jumps are immediate (no smooth scrolling)
  page = await open(browser, 'doc=vector', { width: 1200, height: 800 }, { reducedMotion: 'reduce' });
  await ready(page);
  await button(page, 'Fit page').click();
  await settle(page, 500);
  await button(page, 'Next page').click();
  await page.waitForTimeout(80);
  const t1 = (await viewerState(page)).scrollTop;
  await page.waitForTimeout(80);
  check('reduced motion: page jump is instant', (await viewerState(page)).scrollTop === t1 && (await viewerState(page)).page === 2, { t1, v: await viewerState(page) });
  await page.context().close();
};

// B46: a remount, a restored query or an already-drawn highlight must never move the reading camera; only a fresh intent does.
scenarios.navigateIntent = async browser => {
  const page = await open(browser, 'doc=vector');
  await ready(page);
  await settle(page, 700);
  const regionsOnPage = async n => page.evaluate(n_ => window.__harness.regions().filter(r => r.page === n_).map(r => r.id), n);
  const page1Region = (await regionsOnPage(1))[0];
  check('fixture offers a probe region on page 1', !!page1Region, page1Region);
  await page.locator('.pdfv-probe').first().click(); // selection becomes the active highlight with a fresh navigate intent
  await settle(page, 500);
  // read page 2 at 200% and scroll inside it, like the audit reproduction
  await page.evaluate(() => window.__harness.setCamera({ page: 2, zoom: 2, fit: 'none' }));
  await page.waitForFunction(() => document.querySelector('.pdfv')?.dataset.page === '2', null, { timeout: 8000 });
  await settle(page, 500);
  await page.evaluate(() => { const el = document.querySelector('.pdfv-scroller'); el.scrollTop += 150; el.scrollLeft += 40; });
  await settle(page, 800);
  const before = await viewerState(page);
  check('setup: page 2 at 200% scrolled inside the page', before.page === 2 && near(before.zoom, 2, 0.001) && before.fit === 'none', before);
  const unchanged = async (label, tolerance = 3) => {
    await ready(page, before.page);
    await settle(page, 1100);
    const after = await viewerState(page);
    check(`${label}: still page 2 at 200% with the same scroll`, after.page === before.page && near(after.zoom, before.zoom, 0.001) && near(after.scrollTop, before.scrollTop, tolerance) && near(after.scrollLeft, before.scrollLeft, tolerance), { before: { page: before.page, top: before.scrollTop, left: before.scrollLeft }, after: { page: after.page, top: after.scrollTop, left: after.scrollLeft } });
  };
  // 1) remount with the old active highlight still passed in (selection cleared elsewhere, highlight left drawn)
  await page.evaluate(() => window.__harness.remount());
  await unchanged('remount with a retained active highlight');
  // 2) a query restored from outside (unified search / persisted text) does not navigate, neither live nor on remount
  await page.evaluate(() => window.__harness.setQuery('PU301'));
  await settle(page, 1200);
  await unchanged('external query set while mounted');
  check('the restored query still counts its hits', /\/ 8/.test(await countText(page)), await countText(page));
  await page.evaluate(() => window.__harness.remount());
  await unchanged('remount with a retained query');
  check('after remount the query is still drawn and counted', /\/ 8/.test(await countText(page)), await countText(page));
  check('after remount the active highlight stays drawn on its page', (await page.evaluate(() => window.__harness.state().selected)) === page1Region);
  await shot(page, 'navigate-intent-remount');
  // 3) explicit intents still navigate
  await searchBox(page).fill('R12'); // typing in the viewer's own field: first hit on/after the page being read (page 3: page 2 has none)
  await page.waitForFunction(() => /^\d+ \/ \d+/.test(document.querySelector('[data-testid="pdfv-count"]')?.textContent ?? ''), null, { timeout: 8000 });
  await settle(page, 900);
  check('typing in the own search field navigates to a hit', (await viewerState(page)).page === 3, await viewerState(page));
  await page.evaluate(() => window.__harness.setCamera({ page: 2, zoom: 2, fit: 'none' }));
  await page.waitForFunction(() => document.querySelector('.pdfv')?.dataset.page === '2', null, { timeout: 8000 });
  await page.evaluate(() => window.__harness.setQuery(''));
  await settle(page, 600);
  await page.evaluate(id => window.__harness.selectRegion(id, true), page1Region);
  await page.waitForFunction(() => document.querySelector('.pdfv')?.dataset.page === '1', null, { timeout: 8000 });
  check('a fresh navigate nonce goes to the active highlight', (await viewerState(page)).page === 1, await viewerState(page));
  // the same intent after a remount works too (the nonce is compared with the value seen at mount, not with 0)
  await page.evaluate(() => window.__harness.setCamera({ page: 3, zoom: 2, fit: 'none' }));
  await page.waitForFunction(() => document.querySelector('.pdfv')?.dataset.page === '3', null, { timeout: 8000 });
  await page.evaluate(() => window.__harness.remount());
  await ready(page, 3); await settle(page, 700);
  check('remount keeps the camera on page 3', (await viewerState(page)).page === 3, await viewerState(page));
  await page.evaluate(id => window.__harness.selectRegion(id, true), page1Region);
  await page.evaluate(() => window.__harness.bumpNavigate());
  await page.waitForFunction(() => document.querySelector('.pdfv')?.dataset.page === '1', null, { timeout: 8000 });
  check('a navigate nonce raised after the remount moves the camera', (await viewerState(page)).page === 1, await viewerState(page));
  check('no page errors', page.errors.length === 0, page.errors);
  await page.context().close();
};

scenarios.strict = async browser => {
  const page = await open(browser, 'doc=vector&strict=1');
  await ready(page);
  await search(page, 'GND');
  check('StrictMode (double effects): opens, renders and searches', (await countText(page)).includes('/') && (await page.locator('.pdfv-page canvas').count()) >= 1, await countText(page));
  check('no page errors in StrictMode', page.errors.length === 0, page.errors);
  await page.context().close();
};

// ------------------------------------------------------------------------------------------------ driver
(async () => {
  const wanted = process.argv.slice(2);
  const names = Object.keys(scenarios).filter(name => !wanted.length || wanted.includes(name));
  const server = await ensureServer();
  const executablePath = findChromium();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
  try {
    for (const name of names) {
      currentScenario = name;
      console.log(`\n== ${name}`);
      try { await scenarios[name](browser); } catch (error) { check('scenario completed', false, String(error && error.stack || error).split('\n').slice(0, 4).join(' | ')); }
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  const failed = results.filter(result => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${OUT}`);
  if (failed.length) { for (const result of failed) console.log(` FAIL ${result.scenario} :: ${result.name}`); process.exit(1); }
})().catch(error => { console.error(error); process.exit(1); });
