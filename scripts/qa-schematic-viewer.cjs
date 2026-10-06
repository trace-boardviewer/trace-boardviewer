'use strict';

// Drives harness/schematic-viewer.html (synthetic designs only): rendering, camera, hit-testing, callbacks, hierarchy
// navigation, accessibility basics, resource behaviour and draw time on a 5,000-symbol sheet. Screenshots go to
// TRACE_QA_OUT (default: <tmp>/trace-qa-schematic-viewer). Needs the dev server (started here on :5201 when absent):
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/qa-schematic-viewer.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.TRACE_PLAYWRIGHT_PATH || 'playwright');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.TRACE_QA_URL || 'http://127.0.0.1:5201';
const PAGE_URL = `${BASE}/harness/schematic-viewer.html`;
const OUT = process.env.TRACE_QA_OUT || path.join(os.tmpdir(), 'trace-qa-schematic-viewer');
const results = [];

function findChromium() {
  if (process.env.TRACE_CHROMIUM) return process.env.TRACE_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    for (const dir of fs.readdirSync(base).sort().reverse()) {
      const candidate = path.join(base, dir, 'chrome-linux', 'chrome');
      if (dir.startsWith('chromium-') && fs.existsSync(candidate)) return candidate;
    }
  } catch { /* fall through to Playwright's own default */ }
  return undefined;
}

async function reachable() {
  try { return (await fetch(PAGE_URL)).ok; } catch { return false; }
}

async function ensureServer() {
  if (await reachable()) return null;
  const port = new URL(BASE).port || '5201';
  const child = spawn('npx', ['vite', '--port', port, '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { if (await reachable()) return child; await new Promise(r => setTimeout(r, 250)); }
  child.kill();
  throw new Error(`Dev server did not start at ${BASE}`);
}

const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
const state = page => page.evaluate(() => window.__harness.state());
const logOf = page => page.evaluate(() => window.__harness.log.map(e => ({ type: e.type, detail: e.detail })));
const last = async (page, type) => (await logOf(page)).filter(e => e.type === type).at(-1)?.detail;
const count = async (page, type) => (await logOf(page)).filter(e => e.type === type).length;

async function viewInfo(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.schv'), rect = document.querySelector('.schv-canvas').getBoundingClientRect();
    const [x, y, s] = root.dataset.view.split(',').map(Number);
    return { x, y, s, left: rect.left, top: rect.top, w: rect.width, h: rect.height, drawMs: Number(root.dataset.drawMs), drawn: root.dataset.drawn };
  });
}
const toScreen = (v, px, py) => ({ x: v.left + v.w / 2 + (px - v.x) * v.s, y: v.top + v.h / 2 + (py - v.y) * v.s });
async function goTo(page, x, y, zoom) {
  await page.evaluate(c => window.__harness.setCamera(c), { zoom, x, y, fit: 'none' });
  await settle(page);
  return viewInfo(page);
}
async function clickSheet(page, x, y, opts = {}) {
  const v = await viewInfo(page), p = toScreen(v, x, y);
  await page.mouse.click(p.x, p.y, opts);
  await settle(page);
}
/** Colour of a canvas (base by default) at a sheet point, brightest of the 3x3 neighbourhood by blue+green-red, as rgba. */
async function pixelAt(page, x, y, selector = '.schv-canvas') {
  const v = await viewInfo(page), p = toScreen(v, x, y);
  return page.evaluate(({ px, py, selector }) => {
    const c = document.querySelector(selector), ratio = c.width / c.getBoundingClientRect().width;
    const d = c.getContext('2d').getImageData(Math.round(px * ratio) - 1, Math.round(py * ratio) - 1, 3, 3).data;
    let best = [0, 0, 0, 0], score = -1e9;
    for (let i = 0; i < d.length; i += 4) { const s = d[i + 1] + d[i + 2] - d[i] + d[i + 3]; if (s > score) { score = s; best = [d[i], d[i + 1], d[i + 2], d[i + 3]]; } }
    return best;
  }, { px: p.x - v.left, py: p.y - v.top, selector });
}

async function step(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, ms: Date.now() - t0, detail }); console.log(`ok   ${name}${detail ? ` ${JSON.stringify(detail)}` : ''}`); }
  catch (error) { results.push({ name, ok: false, error: error.message }); console.log(`FAIL ${name}\n     ${error.message.split('\n').slice(0, 6).join('\n     ')}`); }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await ensureServer();
  const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
  const errors = [];
  let stressReport;
  let page;
  const open = async (width = 1440, height = 860, extra = {}) => {
    if (page) await page.context().close();
    const context = await browser.newContext({ viewport: { width, height }, ...extra });
    page = await context.newPage();
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console.error: ${m.text()}`); });
    // The harness page has no favicon; any other failing request is a defect.
    page.on('response', r => { if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
    await page.goto(PAGE_URL);
    await page.waitForSelector('.schv-canvas');
    await settle(page);
  };

  try {
    await open();

    await step('renders the root sheet with accessible canvas and a fit camera', async () => {
      const label = await page.getAttribute('.schv-canvas', 'aria-label');
      assert.equal(await page.getAttribute('.schv-canvas', 'role'), 'img');
      assert.match(label, /Schematic sheet .main., page 1 of 6: 13 symbols/);
      const v = await viewInfo(page);
      assert.ok(v.s > 1 && v.w > 500, `view ${JSON.stringify(v)}`);
      const [sym, wires] = v.drawn.split('/').map(Number);
      assert.equal(sym, 13);
      assert.ok(wires >= 25, `wires drawn ${wires}`);
      const inked = await page.evaluate(() => {
        const c = document.querySelector('.schv-canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const bg = [d[0], d[1], d[2]]; let n = 0;
        for (let i = 0; i < d.length; i += 4 * 7) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40) n++;
        return n;
      });
      assert.ok(inked > 400, `canvas looks blank (${inked} inked samples)`);
      const camera = (await state(page)).camera;
      assert.equal(camera.fit, 'page'); assert.ok(Number.isFinite(camera.zoom) && Number.isFinite(camera.x) && Number.isFinite(camera.y), JSON.stringify(camera));
      return { zoom: +camera.zoom.toFixed(3), drawn: v.drawn };
    });

    await step('wheel zoom keeps the point under the pointer; drag pans; neither selects', async () => {
      const before = await viewInfo(page), at = { x: Math.round(before.left + before.w * 0.6), y: Math.round(before.top + before.h * 0.5) };
      const anchorBefore = { x: before.x + (at.x - before.left - before.w / 2) / before.s, y: before.y + (at.y - before.top - before.h / 2) / before.s };
      await page.mouse.move(at.x, at.y);
      for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
      await settle(page);
      const zoomed = await viewInfo(page);
      assert.ok(zoomed.s > before.s * 1.4, `scale ${before.s} -> ${zoomed.s}`);
      const anchorAfter = { x: zoomed.x + (at.x - zoomed.left - zoomed.w / 2) / zoomed.s, y: zoomed.y + (at.y - zoomed.top - zoomed.h / 2) / zoomed.s };
      assert.ok(Math.hypot(anchorAfter.x - anchorBefore.x, anchorAfter.y - anchorBefore.y) * zoomed.s < 1, `anchor drifted ${JSON.stringify({ anchorBefore, anchorAfter, before, zoomed })}`);
      const camera = (await state(page)).camera;
      assert.equal(camera.fit, 'none'); assert.ok(Math.abs(camera.zoom - zoomed.s / 4) < 0.01, JSON.stringify(camera));
      await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x + 120, at.y + 60, { steps: 8 }); await page.mouse.up();
      await settle(page);
      const panned = await viewInfo(page);
      assert.ok(panned.x < zoomed.x - 1 && panned.y < zoomed.y - 0.5, `pan ${zoomed.x},${zoomed.y} -> ${panned.x},${panned.y}`);
      assert.equal((await logOf(page)).filter(e => ['pin', 'symbol', 'net'].includes(e.type)).length, 0, 'drag or wheel produced a selection');
    });

    await step('fit button restores the page fit and emits it through onCameraChange', async () => {
      await page.click('button[aria-label^="Fit sheet"]');
      await settle(page);
      assert.equal((await state(page)).camera.fit, 'page');
    });

    await step('click a pin -> onSelectPin with ids, ref, number; net highlight appears in the net colour', async () => {
      const pin = await page.evaluate(() => window.__harness.geometry.pin('', 'r1', '1'));
      await goTo(page, 80, 68, 3.2);
      await clickSheet(page, pin.x, (pin.y + pin.by) / 2);
      const event = await last(page, 'pin');
      assert.deepEqual(event, { instancePath: '', symbolId: 'r1', pinId: 'r1#1', ref: 'R1', pinNumber: '1' });
      const selection = (await state(page)).selection;
      assert.equal(selection.netId, 'net:global:+3V3'); assert.equal(selection.symbolKey, '\u0000r1');
      const wire = await page.evaluate(() => window.__harness.geometry.named('pwr1'));
      const rgb = await pixelAt(page, wire.ax, 44.5);
      assert.ok(rgb[1] > 150 && rgb[2] > 150 && rgb[0] < 140, `net wire pixel ${rgb} is not the net accent`);
      await page.screenshot({ path: path.join(OUT, 'pin-selected-dark.png') });
      return { netPixel: rgb };
    });

    await step('click a wire -> onSelectNet(net id) and the other nets stay calm', async () => {
      const w = await page.evaluate(() => window.__harness.geometry.named('n1'));
      await clickSheet(page, w.ax + 4, w.ay);
      assert.equal(await last(page, 'net'), 'net:global:VSENSE_OUT');
      assert.equal((await state(page)).selection.netId, 'net:global:VSENSE_OUT');
      const other = await page.evaluate(() => window.__harness.geometry.named('gnd'));
      const rgb = await pixelAt(page, other.ax, other.ay + 1.5);
      assert.ok(rgb[2] < 120 && rgb[1] > rgb[0] + 30, `unselected wire pixel ${rgb} should stay the (dimmed) wire green, not the net accent`);
    });

    await step('click a symbol -> onSelectSymbol by real geometry; the loose parser box selects nothing', async () => {
      await clickSheet(page, 60, 88);
      assert.deepEqual(await last(page, 'symbol'), { instancePath: '', symbolId: 'r2', ref: 'R2' });
      const nets = await count(page, 'net');
      await clickSheet(page, 66.5, 88);
      assert.equal(await count(page, 'net'), nets + 1, 'a click in the loose box but outside the body must clear');
      assert.equal(await last(page, 'net'), null);
    });

    await step('click empty space clears the selection', async () => {
      await clickSheet(page, 20, 20);
      assert.equal(await last(page, 'net'), null);
      assert.deepEqual((await state(page)).selection, {});
    });

    await step('hover never re-renders React; tooltip names the pin and its net', async () => {
      const pin = await page.evaluate(() => window.__harness.geometry.pin('', 'u1', '2'));
      await goTo(page, 160, 70, 3.2);
      const v = await viewInfo(page), p = toScreen(v, (pin.x + pin.bx) / 2, pin.y);
      const commits = await page.evaluate(() => window.__harness.counters.commits);
      await page.mouse.move(v.left + 300, v.top + 300);
      for (let i = 0; i <= 40; i++) await page.mouse.move(v.left + 300 + (p.x - v.left - 300) * i / 40, v.top + 300 + (p.y - v.top - 300) * i / 40);
      await settle(page);
      const tip = await page.evaluate(() => { const t = document.querySelector('.schv-tip'); return { hidden: t.hidden, text: t.textContent }; });
      assert.equal(tip.hidden, false); assert.match(tip.text, /U1 .* 2 .* EN/); assert.match(tip.text, /VSENSE_OUT/);
      const after = await page.evaluate(() => window.__harness.counters.commits);
      assert.equal(after, commits, `${after - commits} React commits during 41 pointer moves`);
      await page.mouse.move(v.left + 20, v.top + 20); await settle(page);
      assert.equal(await page.evaluate(() => document.querySelector('.schv-tip').hidden), true);
    });

    await step('double-click a sheet symbol descends; repeated sub-sheets get distinct instances and refs', async () => {
      await page.click('button[aria-label^="Fit sheet"]'); await settle(page);
      const sheet = await page.evaluate(() => window.__harness.geometry.sheet('', 'sh-chb'));
      const v = await viewInfo(page), p = toScreen(v, sheet.x + sheet.w / 2, sheet.y + sheet.h / 2);
      await page.mouse.dblclick(p.x, p.y);
      await settle(page);
      assert.equal(await last(page, 'instance'), 'sh-chb');
      assert.equal((await state(page)).instancePath, 'sh-chb');
      assert.equal(await page.textContent('.schv-crumb-current'), 'Channel B');
      assert.match(await page.getAttribute('.schv-canvas', 'aria-label'), /page 5 of 6/);
      // Keyboard: S focuses the only sub-sheet, Enter opens it.
      await page.focus('.schv-canvas'); await page.keyboard.press('s'); await page.keyboard.press('Enter'); await settle(page);
      assert.equal(await last(page, 'instance'), 'sh-chb/sh-flt');
      const pinB = await page.evaluate(() => window.__harness.geometry.pin('', 'f-r', '1'));
      await goTo(page, 80, 80, 4);
      await clickSheet(page, (pinB.x + pinB.bx) / 2, pinB.y);
      const eventB = await last(page, 'pin');
      assert.equal(eventB.ref, 'R22'); assert.equal(eventB.instancePath, 'sh-chb/sh-flt');
      // The other repeated instance shows the same definition with its own annotation.
      await page.evaluate(() => window.__harness.setInstance('sh-cha/sh-flt')); await settle(page);
      await goTo(page, 80, 80, 4);
      await clickSheet(page, (pinB.x + pinB.bx) / 2, pinB.y);
      const eventA = await last(page, 'pin');
      assert.equal(eventA.ref, 'R12'); assert.equal(eventA.instancePath, 'sh-cha/sh-flt');
      // The selection of one instance is not painted on the other: only the displayed instance resolves its keys.
      await page.evaluate(() => window.__harness.setInstance('sh-chb/sh-flt')); await settle(page);
      assert.equal(await page.textContent('.schv-crumb-current'), 'Filter');
      return { refs: [eventB.ref, eventA.ref] };
    });

    await step('Backspace and the parent button ascend; Page Up/Down and the buttons switch sheets', async () => {
      await page.focus('.schv-canvas'); await page.keyboard.press('Backspace'); await settle(page);
      assert.equal(await last(page, 'instance'), 'sh-chb');
      await page.click('button[aria-label^="Parent sheet"]'); await settle(page);
      assert.equal(await last(page, 'instance'), '');
      assert.equal(await page.isDisabled('button[aria-label^="Parent sheet"]'), true);
      await page.focus('.schv-canvas'); await page.keyboard.press('PageDown'); await settle(page);
      assert.equal(await last(page, 'instance'), 'sh-pwr');
      await page.click('button[aria-label^="Next sheet"]'); await settle(page);
      assert.equal(await last(page, 'instance'), 'sh-cha');
      await page.click('button[aria-label^="Previous sheet"]'); await settle(page);
      assert.equal(await last(page, 'instance'), 'sh-pwr');
      await page.click('.schv-crumbs button, .schv-nav .schv-row-main >> nth=0'); await settle(page);
    });

    await step('sheet tree lists repeated sub-sheets separately, with depth, pages and a current marker; keyboard moves focus', async () => {
      await page.evaluate(() => window.__harness.setInstance('sh-cha/sh-flt')); await settle(page);
      const rows = await page.$$eval('.schv-row-main', buttons => buttons.map(b => ({ label: b.getAttribute('aria-label'), current: b.getAttribute('aria-current'), tab: b.tabIndex })));
      assert.equal(rows.length, 6);
      assert.equal(rows.filter(r => /Filter, filter\.kicad_sch, repeated sheet/.test(r.label)).length, 2);
      assert.equal(rows.filter(r => r.current === 'page').length, 1);
      assert.match(rows.find(r => r.current === 'page').label, /^Page 4, Filter/);
      assert.equal(rows.filter(r => r.tab === 0).length, 1, 'exactly one roving tab stop');
      const indents = await page.$$eval('.schv-row', items => items.map(i => parseInt(i.style.paddingLeft, 10)));
      assert.ok(indents[3] > indents[2] && indents[2] > indents[0], `indent ${indents}`);
      await page.focus('.schv-row-main[tabindex="0"]');
      await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
      assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /^Page 2, Power/);
      await page.keyboard.press('Enter'); await settle(page);
      assert.equal(await last(page, 'instance'), 'sh-pwr');
      await page.focus('.schv-row-main[aria-current="page"]');
      await page.keyboard.press('End'); assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /^Page 6/);
      await page.keyboard.press('Home'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowDown');
      const collapsed = await page.$$eval('.schv-row-main', b => b.length);
      assert.ok(collapsed <= 6);
    });

    await step('a sheet whose file is missing is drawn dashed with a caption and does not descend', async () => {
      await page.evaluate(() => window.__harness.setInstance('')); await settle(page);
      await page.click('button[aria-label^="Fit sheet"]'); await settle(page);
      const instances = await count(page, 'instance');
      const sheet = await page.evaluate(() => window.__harness.geometry.sheet('', 'sh-miss'));
      const v = await viewInfo(page), p = toScreen(v, sheet.x + sheet.w / 2, sheet.y + sheet.h / 2);
      await page.mouse.dblclick(p.x, p.y); await settle(page);
      assert.equal(await count(page, 'instance'), instances);
      await page.mouse.move(p.x + 4, p.y + 4); await settle(page);
      assert.match(await page.evaluate(() => document.querySelector('.schv-tip').textContent), /file missing/);
      await goTo(page, 228, 152, 3);
      await page.screenshot({ path: path.join(OUT, 'missing-sheet-dark.png') });
    });

    await step('camera is controlled: a camera set by the host is followed, our own echo is not re-applied', async () => {
      const events = await page.evaluate(() => window.__harness.counters.cameraEvents);
      const v = await goTo(page, 100, 90, 2.5);
      assert.ok(Math.abs(v.x - 100) < 0.01 && Math.abs(v.s - 10) < 0.01, JSON.stringify(v));
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => window.__harness.counters.cameraEvents), events, 'a host camera must not be echoed back');
      await page.evaluate(() => window.__harness.setCamera({ fit: 'page' })); await settle(page);
      assert.ok((await viewInfo(page)).s < 4);
      assert.ok((await page.evaluate(() => window.__harness.counters.cameraEvents)) > events, 'the fitted camera is reported');
    });

    await step('keyboard: +/- zoom, arrows pan, 0 fits, Escape clears', async () => {
      await page.focus('.schv-canvas');
      const a = await viewInfo(page);
      await page.keyboard.press('+'); await page.waitForTimeout(260); await settle(page);
      const b = await viewInfo(page); assert.ok(b.s > a.s * 1.3, `${a.s} -> ${b.s}`);
      await page.keyboard.press('ArrowLeft'); await settle(page);
      const c = await viewInfo(page); assert.ok(c.x < b.x, 'ArrowLeft pans the view');
      await page.keyboard.press('0'); await page.waitForTimeout(260); await settle(page);
      assert.ok(Math.abs((await viewInfo(page)).s - a.s) < 0.01);
      const nets = await count(page, 'net'); await page.keyboard.press('Escape'); assert.equal(await count(page, 'net'), nets + 1);
    });

    await step('highlights of the displayed instance are painted (search = accent, probe/selection = net)', async () => {
      await page.evaluate(() => window.__harness.setHighlights(true)); await settle(page);
      const accent = await pixelAt(page, 60, 50.5, '.schv-overlay');
      assert.ok(accent[3] > 20 && accent[0] > accent[2] + 30, `search highlight overlay pixel ${accent} should be warm and translucent`);
      await page.screenshot({ path: path.join(OUT, 'highlights-dark.png') });
      await page.evaluate(() => window.__harness.setHighlights(false));
    });

    // ----- themes and widths -----
    for (const theme of ['dark', 'light']) {
      for (const width of [960, 1440]) {
        await step(`screenshots ${theme} ${width}px`, async () => {
          await open(width, 820);
          await page.evaluate(t => window.__harness.setTheme(t), theme); await settle(page);
          await page.waitForTimeout(200);
          await page.screenshot({ path: path.join(OUT, `root-fit-${theme}-${width}.png`) });
          const pin = await page.evaluate(() => window.__harness.geometry.pin('', 'u1', '8'));
          await goTo(page, 175, 65, 3);
          await clickSheet(page, (pin.x + pin.bx) / 2, pin.y);
          await page.mouse.move(2, 2); await settle(page);
          await page.screenshot({ path: path.join(OUT, `net-zoom-${theme}-${width}.png`) });
          const rgb = await pixelAt(page, 180, pin.y);
          assert.ok(rgb[1] > 100 && rgb[2] > 100 && rgb[0] < 120, `${theme} net pixel ${rgb}`);
        });
      }
    }

    await step('compact / narrow pane: toolbar collapses, sheet list is a popover that opens, focuses and closes with Escape', async () => {
      await open(1200, 760);
      await page.evaluate(() => { window.__harness.setCompact(true); window.__harness.setWidth(420); }); await settle(page);
      assert.equal(await page.isVisible('.schv-nav'), false);
      assert.equal(await page.isVisible('.schv-btn-text'), false);
      const toolbar = await page.$eval('.schv-toolbar', e => ({ scroll: e.scrollWidth, client: e.clientWidth }));
      assert.ok(toolbar.scroll <= toolbar.client + 1, `toolbar overflows ${JSON.stringify(toolbar)}`);
      await page.click('button[aria-label="Sheets"]'); await settle(page);
      assert.equal(await page.isVisible('.schv-nav-popover'), true);
      assert.equal(await page.getAttribute('button[aria-label="Sheets"]', 'aria-expanded'), 'true');
      assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label') || ''), /^Page 1/);
      await page.screenshot({ path: path.join(OUT, 'compact-popover-dark.png') });
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await settle(page);
      assert.equal(await last(page, 'instance'), 'sh-cha');
      assert.equal(await page.isVisible('.schv-nav-popover'), false, 'choosing a sheet closes the popover');
      await page.click('button[aria-label="Sheets"]'); await page.keyboard.press('Escape'); await settle(page);
      assert.equal(await page.isVisible('.schv-nav-popover'), false);
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Sheets');
      await page.evaluate(() => window.__harness.setInstance('sh-cha/sh-flt')); await settle(page);
      await page.screenshot({ path: path.join(OUT, 'compact-nested-dark.png') });
      assert.ok((await page.$$eval('.schv-crumbs li', l => l.length)) <= 3, 'compact breadcrumb keeps at most the last two entries plus an ellipsis');
    });

    await step('reduced motion: fit lands immediately even with motion on', async () => {
      await open(1200, 760, { reducedMotion: 'reduce' });
      await page.evaluate(() => window.__harness.setMotion(true));
      await goTo(page, 100, 90, 3);
      await page.click('button[aria-label^="Fit sheet"]'); await settle(page);
      assert.ok((await viewInfo(page)).s < 4, 'view did not jump to the fit');
    });

    await step('narrow viewport has no horizontal overflow', async () => {
      await open(960, 700);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `overflow ${overflow}`);
    });

    // ----- stress -----
    await step('stress sheet (5,000 symbols): culled draws and timings', async () => {
      await open(1440, 860);
      const t0 = Date.now();
      await page.evaluate(() => window.__harness.setDesign('stress'));
      await page.waitForFunction(() => document.querySelector('.schv')?.dataset.drawn && /^\d+\/\d+\/\d+$/.test(document.querySelector('.schv').dataset.drawn) && window.__harness.state().design === 'stress');
      await settle(page);
      const firstDrawMs = Date.now() - t0;
      const label = await page.getAttribute('.schv-canvas', 'aria-label');
      assert.match(label, /5000 symbols/);
      const samples = [];
      const record = async (name, fn) => { await fn(); await settle(page); const v = await viewInfo(page); samples.push({ name, drawMs: v.drawMs, drawn: v.drawn }); };
      await record('fit', async () => page.click('button[aria-label^="Fit sheet"]'));
      await record('fit-again', async () => { await page.evaluate(() => window.__harness.setCamera({ fit: 'none', zoom: 0.5, x: 590, y: 420 })); });
      await record('mid-zoom', async () => page.evaluate(() => window.__harness.setCamera({ fit: 'none', zoom: 1.2, x: 300, y: 300 })));
      await record('detail-zoom', async () => page.evaluate(() => window.__harness.setCamera({ fit: 'none', zoom: 4, x: 300, y: 300 })));
      await record('text-zoom', async () => page.evaluate(() => window.__harness.setCamera({ fit: 'none', zoom: 12, x: 300, y: 300 })));
      const fit = samples.find(s => s.name === 'fit'), detail = samples.find(s => s.name === 'detail-zoom');
      const fitSymbols = Number(fit.drawn.split('/')[0]), detailSymbols = Number(detail.drawn.split('/')[0]);
      assert.equal(fitSymbols, 5000); assert.ok(detailSymbols < 400, `culling failed: ${detailSymbols} symbols drawn when zoomed in`);
      // Continuous interaction: 90 drag steps and 30 wheel steps, one frame each; wall time per frame includes raster.
      await page.click('button[aria-label^="Fit sheet"]'); await settle(page);
      const v = await viewInfo(page);
      // Pointer events are dispatched inside the page (no CDP round trip): the time per step is JS + raster until the next frame.
      const frames = await page.evaluate(async ({ cx, cy }) => {
        const canvas = document.querySelector('.schv-canvas'), out = [];
        const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
        fire('pointerdown', cx, cy);
        for (let i = 0; i < 90; i++) {
          const t = performance.now();
          fire('pointermove', cx + Math.sin(i / 9) * 260, cy + Math.cos(i / 9) * 160);
          await new Promise(r => requestAnimationFrame(r));
          out.push(performance.now() - t);
        }
        fire('pointerup', cx, cy);
        return out;
      }, { cx: v.left + v.w / 2, cy: v.top + v.h / 2 });
      const draws = [];
      await page.mouse.move(v.left + v.w / 2, v.top + v.h / 2);
      for (let i = 0; i < 30; i++) {
        await page.mouse.wheel(0, i < 15 ? -150 : 150);
        await settle(page);
        draws.push((await viewInfo(page)).drawMs);
      }
      const stat = arr => { const s = [...arr].sort((a, b) => a - b); return { min: +s[0].toFixed(1), median: +s[Math.floor(s.length / 2)].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s[s.length - 1].toFixed(1) }; };
      stressReport = { firstPaintMs: firstDrawMs, drawMsByView: samples, dragFrameMs: stat(frames), wheelDrawMs: stat(draws), symbols: 5000 };
      const budget = Number(process.env.TRACE_QA_DRAW_BUDGET_MS || 80);
      assert.ok(Math.max(...samples.map(s => s.drawMs)) < budget, `a draw exceeded ${budget} ms: ${JSON.stringify(samples)}`);
      assert.ok(stressReport.wheelDrawMs.p95 < budget, `wheel draw p95 ${stressReport.wheelDrawMs.p95} ms`);
      await page.click('button[aria-label^="Fit sheet"]'); await settle(page);
      await page.screenshot({ path: path.join(OUT, 'stress-fit-dark.png') });
      await goTo(page, 300, 300, 3);
      await page.screenshot({ path: path.join(OUT, 'stress-zoom-dark.png') });
      return stressReport;
    });

    await step('no React commit storm: camera changes commit at most once per frame', async () => {
      const before = await page.evaluate(() => ({ c: window.__harness.counters.commits, e: window.__harness.counters.cameraEvents }));
      const v = await viewInfo(page);
      await page.mouse.move(v.left + v.w / 2, v.top + v.h / 2);
      const t0 = await page.evaluate(() => performance.now());
      for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -40);
      await settle(page);
      const after = await page.evaluate(() => ({ c: window.__harness.counters.commits, e: window.__harness.counters.cameraEvents, t: performance.now() }));
      const frames = Math.ceil((after.t - t0) / 16) + 2;
      assert.ok(after.e - before.e <= frames, `${after.e - before.e} camera events in ${frames} frames`);
      assert.ok(after.c - before.c <= (after.e - before.e) * 2 + 2, `${after.c - before.c} commits for ${after.e - before.e} camera events`);
      return { cameraEvents: after.e - before.e, commits: after.c - before.c };
    });

    await step('unmount releases resources: backing stores are freed and no frame callback fires afterwards', async () => {
      const result = await page.evaluate(async () => {
        const canvas = document.querySelector('.schv-canvas');
        const widthBefore = canvas.width;
        window.__harness.setVisible(false);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { widthBefore, widthAfter: canvas.width, detached: !canvas.isConnected };
      });
      assert.ok(result.widthBefore > 0); assert.equal(result.widthAfter, 0, 'the backing store is released'); assert.equal(result.detached, true);
    });

    assert.deepEqual(errors, [], `page errors:\n${errors.join('\n')}`);
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  const failed = results.filter(r => !r.ok);
  fs.writeFileSync(path.join(OUT, 'qa-report.json'), JSON.stringify({ results, stress: stressReport, screenshots: fs.readdirSync(OUT).filter(f => f.endsWith('.png')) }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots + report in ${OUT}`);
  if (failed.length) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
