'use strict';

// Drives harness/image-viewer.html (served by `npx vite --port 5203 --strictPort`) with synthetic fixtures:
// decode + orientation, zoom/pan/keyboard, calibration math, bookmarks/notes through props, hostile SVG (request log + script flag),
// the B30/B36 SVG size controls with real pixel counts, limits, cancellation, DPR, theme/size screenshots. Exit code 1 on any failure.
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers TRACE_PLAYWRIGHT_PATH=<playwright module> node scripts/qa-image-viewer.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TRACE_PLAYWRIGHT_PATH || 'playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.TRACE_QA_OUT || path.join(ROOT, 'test-results', 'image-viewer');
const BASE = process.env.TRACE_QA_URL || 'http://127.0.0.1:5203';
const PAGE_URL = `${BASE}/harness/image-viewer.html`;
fs.mkdirSync(OUT, { recursive: true });

const QUAD = { tl: [230, 40, 40], tr: [40, 200, 60], bl: [50, 80, 230], br: [240, 220, 40] };
const results = [];
const numbers = {};
const note = (key, value) => { numbers[key] = value; };
const close = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b} (tol ${tol})`);
const colorNear = (pixel, expected, tol, label) => assert.ok(expected.every((v, i) => Math.abs(pixel[i] - v) <= tol) && pixel[3] === 255, `${label}: rgba(${pixel}) vs rgb(${expected}) tol ${tol}`);

async function main() {
  const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
  const problems = [];
  const requests = [];
  const open = async (viewport, { scale = 1, query = '' } = {}) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: scale });
    const page = await context.newPage();
    page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
    page.on('console', message => {
      // The harness reads canvas pixels back many times on purpose; that browser hint is not a viewer defect.
      if ((message.type() === 'error' || message.type() === 'warning') && !/willReadFrequently/.test(message.text())) problems.push(`console ${message.type()}: ${message.text()}`);
    });
    await page.route('**/*', route => {
      const url = route.request().url();
      requests.push(url);
      return url.startsWith(BASE) ? route.continue() : route.abort();
    });
    await page.goto(`${PAGE_URL}?motion=off&chrome=0&fixture=quad-png${query}`);
    await page.waitForFunction(() => window.__imgv && window.__imgv.mounted);
    return { context, page };
  };

  let activePage = null;
  const currentPage = () => activePage;
  const test = async (name, fn) => {
    const started = Date.now();
    try {
      try { await fn(); } catch (error) {
        // The dev server is shared with other processes; a file edit elsewhere reloads the page under us. Retry such a test once on a fresh load.
        if (!/Execution context was destroyed|navigation/.test(String(error.message))) throw error;
        await currentPage().waitForFunction(() => window.__imgv && window.__imgv.mounted);
        await fn();
      }
      results.push({ name, ok: true, ms: Date.now() - started }); console.log(`  ok   ${name} (${Date.now() - started} ms)`); }
    catch (error) { results.push({ name, ok: false, error }); console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').join('\n       ')}`); }
  };

  // --- page helpers ---------------------------------------------------------------------------
  const H = page => ({
    settle: () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r()))))),
    async load(name) {
      await page.evaluate(n => window.__imgv.load(n), name);
      await page.waitForFunction(n => window.__imgv.state().fixture === n && window.__imgv.phase() !== 'loading', name, { timeout: 30000 });
      await this.settle();
    },
    state: () => page.evaluate(() => window.__imgv.state()),
    clientOf: (x, y) => page.evaluate(([a, b]) => window.__imgv.clientOf(a, b), [x, y]),
    imageAt: (x, y) => page.evaluate(([a, b]) => window.__imgv.imageAt(a, b), [x, y]),
    pixel: (x, y) => page.evaluate(([a, b]) => window.__imgv.canvasPixel(a, b), [x, y]),
    text: selector => page.locator(selector).first().innerText(),
    async clickImage(x, y) { const p = await this.clientOf(x, y); await page.mouse.click(p.x, p.y); await this.settle(); return p; },
    async camera() { await this.settle(); return (await this.state()).camera; },
    async focusSurface() { await page.locator('.imgv-surface').focus(); },
    async key(k) { await this.focusSurface(); await page.keyboard.press(k); await this.settle(); },
    tool: name => page.locator(`.imgv-toolbar button[aria-label^="${name}"]`),
  });

  // ============================================================================================
  console.log('Decode, orientation and rotation');
  let { context, page } = await open({ width: 1440, height: 900 });
  const h = H(page);
  activePage = page;
  await h.load('quad-png');

  const quadrantCheck = async (rotation, tol, label) => {
    const cam = await h.camera();
    assert.equal(cam.rotation, rotation, `${label}: camera rotation`);
    const w = 400, ht = 300;
    const spots = { tl: [w / 4, ht / 4], tr: [3 * w / 4, ht / 4], bl: [w / 4, 3 * ht / 4], br: [3 * w / 4, 3 * ht / 4] };
    for (const [key, [x, y]] of Object.entries(spots)) {
      const p = await h.clientOf(x, y);
      colorNear(await h.pixel(p.x, p.y), QUAD[key], tol, `${label} ${key} at rotation ${rotation}`);
    }
  };
  for (const [fixture, format, tol] of [['quad-png', 'PNG', 3], ['quad-jpeg', 'JPEG', 28], ['quad-webp', 'WebP', 28], ['svg-quad', 'SVG', 3]]) {
    await test(`${fixture}: sniffed as ${format}, 400 x 300, quadrant colours at all four rotations`, async () => {
      await h.load(fixture);
      const status = await h.text('.imgv-status');
      assert.match(status, new RegExp(`400 × 300 px · ${format}`));
      await quadrantCheck(0, tol, fixture);
      for (const rotation of [90, 180, 270]) { await h.key('r'); await quadrantCheck(rotation, tol, fixture); }
      await h.key('r');
      assert.equal((await h.camera()).rotation, 0);
    });
  }
  await test('exif-jpeg: EXIF orientation 6 is applied (300 x 400, blue top-left)', async () => {
    await h.load('exif-jpeg');
    assert.match(await h.text('.imgv-status'), /300 × 400 px · JPEG/);
    const expected = { tl: QUAD.bl, tr: QUAD.tl, br: QUAD.tr, bl: QUAD.br };
    for (const [key, [x, y]] of Object.entries({ tl: [75, 100], tr: [225, 100], bl: [75, 300], br: [225, 300] })) {
      const p = await h.clientOf(x, y);
      colorNear(await h.pixel(p.x, p.y), expected[key], 28, `exif ${key}`);
    }
  });

  // ============================================================================================
  console.log('Zoom, pan, keyboard');
  await test('wheel zoom keeps the image point under the pointer fixed', async () => {
    await h.load('board-png');
    const before = await h.camera();
    const stage = await page.locator('.imgv-surface').boundingBox();
    // Chromium truncates MouseEvent/WheelEvent coordinates to whole pixels, so the pointer sits on one.
    const pointer = { x: Math.round(stage.x + stage.width * 0.7), y: Math.round(stage.y + stage.height * 0.35) };
    const under = await h.imageAt(pointer.x, pointer.y);
    await page.mouse.move(pointer.x, pointer.y);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
    const after = await h.camera();
    assert.ok(after.zoom > before.zoom * 1.5, `zoomed in: ${before.zoom} -> ${after.zoom}`);
    assert.equal(after.fit, 'none');
    const now = await h.imageAt(pointer.x, pointer.y);
    close(now.x, under.x, 0.6, 'anchor x'); close(now.y, under.y, 0.6, 'anchor y');
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 240);
    const out = await h.camera();
    assert.ok(out.zoom < after.zoom, 'zoomed out again');
    note('wheelZoomRange', `${before.zoom.toFixed(3)} -> ${after.zoom.toFixed(3)} -> ${out.zoom.toFixed(3)}`);
  });
  await test('drag pans: the image point under the pointer follows it; a click does not pan', async () => {
    await h.load('board-png');
    await h.key('0');
    const stage = await page.locator('.imgv-surface').boundingBox();
    const start = { x: stage.x + 300, y: stage.y + 300 };
    const grabbed = await h.imageAt(start.x, start.y);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(start.x + i * 7, start.y + i * 4);
    await page.mouse.up();
    await h.settle();
    const dropped = await h.imageAt(start.x + 84, start.y + 48);
    close(dropped.x, grabbed.x, 1.2, 'drag x'); close(dropped.y, grabbed.y, 1.2, 'drag y');
    const stable = await h.camera();
    await h.settle();
    assert.deepEqual(await h.camera(), stable, 'camera does not drift after the drag');
    const before = await h.camera();
    await page.mouse.click(start.x + 2, start.y + 2);
    await h.settle();
    assert.deepEqual(await h.camera(), before, 'a click is not a pan');
  });
  await test('keyboard: + - 0 F W R Shift+R arrows', async () => {
    await h.load('board-png');
    const fit = await h.camera();
    await h.key('+'); const plus = await h.camera();
    close(plus.zoom / fit.zoom, 1.25, 1e-6, 'zoom in factor'); assert.equal(plus.fit, 'none');
    await h.key('-'); close((await h.camera()).zoom, fit.zoom, 1e-6, 'zoom out returns');
    await h.key('0'); assert.equal((await h.camera()).zoom, 1);
    const centered = await h.camera();
    await h.key('ArrowRight'); const right = await h.camera();
    close(right.x - centered.x, 48, 1e-6, 'ArrowRight pans 48 css px'); close(right.y, centered.y, 1e-9, 'ArrowRight keeps y');
    await h.key('ArrowDown'); close((await h.camera()).y - right.y, 48, 1e-6, 'ArrowDown');
    await h.key('Shift+ArrowLeft'); close((await h.camera()).x, right.x - 192, 1e-6, 'Shift+Arrow pans four steps');
    await h.key('f'); const refit = await h.camera();
    close(refit.zoom, fit.zoom, 1e-6, 'F refits'); assert.equal(refit.fit, 'page');
    await h.key('w'); const width = await h.camera();
    assert.equal(width.fit, 'width'); assert.ok(width.zoom >= fit.zoom - 1e-9);
    await h.key('r'); assert.equal((await h.camera()).rotation, 90);
    assert.equal((await h.camera()).fit, 'width', 'rotation keeps the fit request');
    await h.key('Shift+R'); assert.equal((await h.camera()).rotation, 0);
    await h.key('Shift+R'); assert.equal((await h.camera()).rotation, 270);
    await h.key('R');
  });
  await test('Escape cancels a half-finished calibration, then the tool', async () => {
    await h.load('board-png');
    await h.key('c');
    assert.equal(await h.tool('Calibrate').getAttribute('aria-pressed'), 'true');
    assert.match(await h.text('.imgv-dock'), /first end/);
    await h.clickImage(200, 200);
    assert.match(await h.text('.imgv-dock'), /second end/);
    await h.key('Escape');
    assert.match(await h.text('.imgv-dock'), /first end/);
    assert.equal(await h.tool('Calibrate').getAttribute('aria-pressed'), 'true');
    await h.key('Escape');
    assert.equal(await h.tool('Calibrate').getAttribute('aria-pressed'), 'false');
    assert.equal(await h.tool('Select').getAttribute('aria-pressed'), 'true');
  });
  await test('camera props are adopted, damaged values stay sane, and the viewer does not fight an echoed camera', async () => {
    await h.load('board-png');
    await page.evaluate(() => window.__imgv.setCamera({ zoom: 2, x: 100, y: 50, rotation: 90, fit: 'none' }));
    await h.settle();
    const size = await page.evaluate(() => window.__imgv.stageSize());
    const rect = await page.locator('.imgv-surface').boundingBox();
    const centre = await h.imageAt(rect.x + size.width / 2, rect.y + size.height / 2);
    close(centre.x, 100, 1e-6, 'adopted x'); close(centre.y, 50, 1e-6, 'adopted y');
    assert.match(await h.text('.imgv-status'), /Rotation 90°/);
    await page.evaluate(() => window.__imgv.setCamera({ zoom: -3, x: 1e12, y: Number.NaN, rotation: 45, fit: 'bogus' }));
    await h.settle();
    assert.match(await h.text('.imgv-status'), /Zoom \d+%/);
    await page.evaluate(() => window.__imgv.setCamera({ fit: 'page' }));
    await h.settle();
    assert.equal((await h.camera()).fit, 'page');
  });
  await test('fit mode follows the pane size; manual zoom does not', async () => {
    await h.load('board-png');
    await page.setViewportSize({ width: 1440, height: 900 });
    const big = await h.camera();
    await page.setViewportSize({ width: 960, height: 700 });
    await h.settle(); await h.settle();
    const small = await h.camera();
    assert.ok(small.zoom < big.zoom, `refit smaller: ${big.zoom} -> ${small.zoom}`);
    assert.equal(small.fit, 'page');
    await h.key('+');
    const manual = await h.camera();
    await page.setViewportSize({ width: 1200, height: 800 });
    await h.settle(); await h.settle();
    assert.equal((await h.camera()).zoom, manual.zoom);
    await page.setViewportSize({ width: 1440, height: 900 });
    await h.settle();
  });

  // ============================================================================================
  console.log('Calibration and measurement');
  await test('calibration: two clicks + typed distance give exactly pixels/mm of the clicked points, and nothing else does', async () => {
    await h.load('board-png');
    await h.key('c');
    const a = await h.clientOf(120, 860), b = await h.clientOf(920, 860);
    const ia = await h.imageAt(a.x, a.y), ib = await h.imageAt(b.x, b.y);
    await page.mouse.click(a.x, a.y); await h.settle();
    await page.mouse.click(b.x, b.y); await h.settle();
    const input = page.locator('.imgv-form input');
    await input.waitFor();
    assert.equal(await input.evaluate(el => el === document.activeElement), true, 'the distance field takes focus');
    const before = (await h.state()).events.length;
    for (const bad of ['', '0', '-5', 'abc', '1e999', '12 cm']) {
      await input.fill(bad);
      await input.press('Enter');
      assert.match(await h.text('.imgv-form__help'), /positive number of millimetres/, `error for ${JSON.stringify(bad)}`);
      assert.equal((await h.state()).calibration, undefined);
    }
    assert.equal((await h.state()).events.length, before, 'no calibration event for invalid input');
    await input.fill('40');
    await input.press('Enter');
    await h.settle();
    const state = await h.state();
    const expected = Math.hypot(ib.x - ia.x, ib.y - ia.y) / 40;
    assert.equal(state.calibration.confirmed, true);
    close(state.calibration.pixelsPerMm / expected, 1, 1e-6, 'pixelsPerMm vs clicked points (mouse coordinates are float32)');
    close(state.calibration.pixelsPerMm, 20, 0.02, 'ruler is 20 px/mm');
    assert.match(await h.text('.imgv-status'), /Calibrated 20\.0\d px\/mm \(set by you\)/);
    assert.equal(await h.tool('Select').getAttribute('aria-pressed'), 'true');
    note('calibrationPxPerMm', state.calibration.pixelsPerMm);
  });
  await test('calibration refuses coincident points', async () => {
    await h.key('c');
    await h.clickImage(300, 300);
    await h.clickImage(300.2, 300.2);
    assert.match(await h.text('.imgv-dock'), /less than one image pixel/);
    assert.equal(await page.locator('.imgv-form').count(), 0);
    await h.key('Escape'); await h.key('Escape');
  });
  await test('measure reports mm only when calibrated, at every rotation', async () => {
    const ppm = (await h.state()).calibration.pixelsPerMm;
    for (const rotation of [0, 90, 180, 270]) {
      await h.key('m');
      const a = await h.clientOf(200, 300), b = await h.clientOf(700, 500);
      const ia = await h.imageAt(a.x, a.y), ib = await h.imageAt(b.x, b.y);
      await page.mouse.click(a.x, a.y); await h.settle();
      await page.mouse.click(b.x, b.y); await h.settle();
      const expected = Math.hypot(ib.x - ia.x, ib.y - ia.y) / ppm;
      const value = await h.text('.imgv-dock__value');
      assert.match(value, /^\d+\.\d\d mm$/, `rotation ${rotation}`);
      close(parseFloat(value), expected, 0.0051, `measured mm at ${rotation}`);
      await h.key('Escape'); await h.key('Escape');
      await h.key('r');
    }
  });
  await test('clear calibration: back to pixels only, and the text says so', async () => {
    await page.locator('button[aria-label="Clear calibration"]').click();
    await h.settle();
    assert.equal((await h.state()).calibration, undefined);
    assert.match(await h.text('.imgv-status'), /Not calibrated: pixels only/);
    await h.key('m');
    await h.clickImage(200, 300); await h.clickImage(500, 700);
    assert.match(await h.text('.imgv-dock__value'), /^\d+ px$/);
    assert.match(await h.text('.imgv-dock'), /Not calibrated/);
    assert.doesNotMatch(await h.text('.imgv-dock__value'), /mm/);
    await h.key('Escape'); await h.key('Escape');
  });
  await test('stored calibrations are validated: a confirmed one gives mm, damaged or unconfirmed ones never do', async () => {
    const measureOnce = async () => { await h.key('m'); await h.clickImage(200, 300); await h.clickImage(400, 300); const text = await h.text('.imgv-dock__value'); await h.key('Escape'); await h.key('Escape'); return text; };
    await page.evaluate(() => window.__imgv.setCalibration({ pixelsPerMm: 10, confirmed: true }));
    await h.settle();
    assert.match(await measureOnce(), /^\d+\.\d\d mm$/);
    for (const bad of [{ pixelsPerMm: 0, confirmed: true }, { pixelsPerMm: Number.NaN, confirmed: true }, { pixelsPerMm: 10, confirmed: false }, { pixelsPerMm: -2, confirmed: true }]) {
      await page.evaluate(c => window.__imgv.setCalibration(c), bad);
      await h.settle();
      assert.match(await measureOnce(), /^\d+ px$/, JSON.stringify(bad));
      assert.match(await h.text('.imgv-status'), /Not calibrated/);
    }
    await page.evaluate(() => window.__imgv.setCalibration(undefined));
  });

  // ============================================================================================
  console.log('Bookmarks and annotations through props');
  await test('bookmarks: add at the view centre, rename, go to, delete', async () => {
    await h.load('board-png');
    await h.key('0');
    await h.key('ArrowRight');
    const cam = await h.camera();
    await page.locator('button[aria-label^="Add bookmark"]').click();
    await h.settle();
    let { bookmarks } = await h.state();
    assert.equal(bookmarks.length, 1);
    assert.equal(bookmarks[0].page, 1);
    assert.equal(bookmarks[0].label, 'Bookmark 1');
    close(bookmarks[0].x, cam.x, 0.006, 'bookmark x'); close(bookmarks[0].y, cam.y, 0.006, 'bookmark y');
    assert.ok(bookmarks[0].id.length > 8);
    const rename = page.locator('.imgv-row input');
    await rename.fill('Ruler zero');
    await rename.press('Enter');
    await h.settle();
    assert.equal((await h.state()).bookmarks[0].label, 'Ruler zero');
    await h.key('b');
    assert.equal((await h.state()).bookmarks.length, 2);
    await h.key('ArrowDown');
    await page.locator('.imgv-panel [role=list][aria-label=Bookmarks] button.imgv-row__main').first().click();
    await h.settle();
    const goto = await h.camera();
    close(goto.x, bookmarks[0].x, 1e-6, 'go to x'); close(goto.y, bookmarks[0].y, 1e-6, 'go to y');
    await page.locator('button[aria-label="Delete Ruler zero"]').click();
    await h.settle();
    assert.equal((await h.state()).bookmarks.length, 1);
  });
  await test('notes: place by click, empty text refused, marker painted, edit and delete through props', async () => {
    await h.load('board-png');
    await h.key('n');
    const spot = await h.clientOf(500, 400);
    await page.mouse.click(spot.x, spot.y);
    await h.settle();
    const dialog = page.locator('.imgv-editor');
    await dialog.waitFor();
    assert.equal(await dialog.locator('textarea').evaluate(el => el === document.activeElement), true);
    await dialog.locator('button', { hasText: 'Save' }).click();
    assert.match(await dialog.innerText(), /Enter some text/);
    assert.equal((await h.state()).annotations.length, 0);
    await dialog.locator('textarea').fill('U12 pin 3 reads 0.4 V');
    await dialog.locator('textarea').press('Control+Enter');
    await h.settle();
    let { annotations } = await h.state();
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].page, 1);
    assert.equal(annotations[0].text, 'U12 pin 3 reads 0.4 V');
    close(annotations[0].x, 500, 0.006, 'note x'); close(annotations[0].y, 400, 0.006, 'note y');
    assert.match(annotations[0].updatedAt, /^\d{4}-\d\d-\d\dT/);
    const accent = await page.evaluate(() => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = getComputedStyle(document.querySelector('.imgv')).getPropertyValue('--net').trim(); c.fillRect(0, 0, 1, 1); return Array.from(c.getImageData(0, 0, 1, 1).data); });
    const marker = await h.pixel(spot.x, spot.y - 7);
    colorNear(marker, accent.slice(0, 3), 14, 'selected marker uses the net accent');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.imgv-editor').count(), 0);
    await page.evaluate(seed => window.__imgv.setAnnotations(seed), [
      { id: 'seed-1', page: 1, x: 200, y: 200, text: 'seeded one', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'seed-2', page: 1, x: 300, y: 260, text: 'seeded two', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'seed-3', page: 1, x: 900, y: 700, text: 'seeded three', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    await h.settle();
    assert.equal(await page.locator('.imgv-panel [role=list][aria-label=Notes] [role=listitem]').count(), 3);
    await page.locator('.imgv-panel [role=list][aria-label=Notes] button.imgv-row__main').nth(1).click();
    await h.settle();
    await page.locator('.imgv-editor textarea').fill('seeded two, edited');
    await page.locator('.imgv-editor button', { hasText: 'Save' }).click();
    await h.settle();
    ({ annotations } = await h.state());
    assert.equal(annotations[1].text, 'seeded two, edited');
    assert.notEqual(annotations[1].updatedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(annotations[0].text, 'seeded one');
    await page.locator('button[aria-label="Delete note 1"]').click();
    await h.settle();
    assert.deepEqual((await h.state()).annotations.map(a => a.id), ['seed-2', 'seed-3']);
    await page.evaluate(() => window.__imgv.props({ theme: 'light' }));
    await h.settle();
    assert.equal((await h.state()).annotations.length, 2, 'notes survive a theme change');
    await page.evaluate(() => window.__imgv.props({ theme: 'dark' }));
  });

  // ============================================================================================
  console.log('SVG safety');
  await test('hostile SVG: nothing runs, nothing is requested, everything removed is disclosed, safe content renders', async () => {
    requests.length = 0;
    await page.evaluate(() => { delete window.__pwned; });
    await h.load('svg-hostile');
    await page.waitForTimeout(600);
    const rect = await page.locator('.imgv-surface').boundingBox();
    await page.mouse.move(rect.x + 100, rect.y + 100);
    await page.mouse.click(rect.x + 120, rect.y + 120);
    await page.mouse.move(rect.x + 300, rect.y + 300);
    assert.equal(await page.evaluate(() => window.__pwned), undefined, 'no script, handler or javascript: URL ran');
    const foreign = requests.filter(url => !url.startsWith(BASE) || /__hostile|hostile\.invalid|etc\/passwd|relative\/local|other\.svg/.test(url));
    assert.deepEqual(foreign, [], 'no hostile or remote request');
    await page.locator('.imgv-banner button[aria-expanded]').click();
    const banner = await h.text('.imgv-banner');
    for (const needle of ['unsafe', 'removed', 'Nothing in this file was run or loaded']) assert.ok(banner.includes(needle), `banner mentions "${needle}"`);
    const items = (await page.locator('.imgv-removed li').allInnerTexts()).join(' | ');
    for (const needle of ['<script> element', '<foreignObject> element', '<a> element', '<set> element', '<animate> element', '<style> element', 'onload on <svg>', 'onclick on <rect>', 'onmouseover on <g>', 'href on <image>', 'href on <use>', 'fill on <rect>', 'style on <rect>', 'style on <g>']) {
      assert.ok(items.includes(needle), `disclosed: ${needle}\n  got: ${items}`);
    }
    assert.match(await h.text('.imgv-status'), /300 × 200 px · SVG/);
    const red = await h.clientOf(150, 50);
    colorNear(await h.pixel(red.x, red.y), [255, 0, 0], 6, 'safe gradient-styled rect survives');
    note('hostileRemovedCount', await page.locator('.imgv-removed li').count());
  });
  await test('hostile SVG: the green circle (handlers stripped, element kept) still renders', async () => {
    const green = await h.clientOf(250, 150);
    colorNear(await h.pixel(green.x, green.y), [40, 200, 60], 6, 'circle');
  });
  await test('hostile SVG variants: HTML posing as SVG is unsupported; an entity bomb ends quickly; Latin-1 text loads', async () => {
    await h.load('html-not-svg');
    assert.equal(await page.locator('.imgv-state--error strong').innerText(), 'Unsupported image format');
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    const started = Date.now();
    await h.load('svg-entity-bomb');
    const ms = Date.now() - started;
    assert.ok(ms < 8000, `entity bomb took ${ms} ms`);
    note('entityBombMs', ms);
    note('entityBombOutcome', await page.evaluate(() => window.__imgv.phase()));
    await h.load('svg-latin1');
    assert.match(await h.text('.imgv-status'), /120 × 40 px · SVG/);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
  });

  console.log('B30 / B36 SVG sizing with pixel counts');
  const probe = (name, sanitized) => page.evaluate(([svg, s]) => window.__imgv.probeSvg(svg, s), [name, sanitized]);
  const svgText = name => page.evaluate(n => window.__imgv.fixtureText(n), name);
  await test('B30: width-only SVG keeps 100 x 150 and all 4000 red pixels (sanitized == the browser\'s own rendering)', async () => {
    const text = await svgText('svg-width-only');
    const sanitized = await probe(text, true), raw = await probe(text, false);
    assert.deepEqual({ w: sanitized.width, h: sanitized.height, red: sanitized.red }, { w: 100, h: 150, red: 4000 });
    assert.deepEqual({ w: raw.width, h: raw.height, red: raw.red }, { w: 100, h: 150, red: 4000 });
    note('B30 width-only', `${sanitized.width}x${sanitized.height} red=${sanitized.red}`);
  });
  await test('B30: height-only SVG keeps 300 x 100 and all 10000 red pixels', async () => {
    const text = await svgText('svg-height-only');
    const sanitized = await probe(text, true), raw = await probe(text, false);
    assert.deepEqual({ w: sanitized.width, h: sanitized.height, red: sanitized.red }, { w: 300, h: 100, red: 10000 });
    assert.deepEqual({ w: raw.width, h: raw.height, red: raw.red }, { w: 300, h: 100, red: 10000 });
    note('B30 height-only', `${sanitized.width}x${sanitized.height} red=${sanitized.red}`);
  });
  await test('B30 controls: width+viewBox and full-size SVG keep 4000 red pixels; the oracle sees the old square (0 pixels)', async () => {
    for (const name of ['svg-width-viewbox', 'svg-full']) {
      const result = await probe(await svgText(name), true);
      assert.deepEqual({ w: result.width, h: result.height, red: result.red }, { w: 100, h: 150, red: 4000 }, name);
    }
    const square = await probe('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="0" y="110" width="100" height="40" fill="#ff0000"/></svg>', false);
    assert.equal(square.red, 0, 'a 100 x 100 viewport crops the red band away, so the count oracle detects the old bug');
  });
  await test('B30 in the viewer canvas: the width-only SVG shows its red band at zoom 2 (no crop)', async () => {
    await h.load('svg-width-only');
    assert.match(await h.text('.imgv-status'), /100 × 150 px · SVG/);
    await page.evaluate(() => window.__imgv.setCamera({ zoom: 2, x: 50, y: 75, rotation: 0, fit: 'none' }));
    await h.settle();
    const stats = await page.evaluate(() => window.__imgv.canvasStats());
    const expected = 4000 * 4;
    note('viewerCanvasRedAtZoom2', `${stats.red} (ideal ${expected})`);
    assert.ok(stats.red >= expected * 0.93 && stats.red <= expected * 1.03, `red pixels ${stats.red} vs ${expected}`);
    await h.load('svg-height-only');
    assert.match(await h.text('.imgv-status'), /300 × 100 px · SVG/);
  });
  await test('B36: oversized SVG sizes are bounded to whole pixels within the budget, in the viewer too', async () => {
    await h.load('svg-huge');
    assert.match(await h.text('.imgv-status'), /8944 × 8944 px · SVG/);
    await h.load('svg-thin-huge');
    assert.equal(await page.evaluate(() => window.__imgv.phase()), 'ready');
    assert.match(await h.text('.imgv-status'), /80000000 × 1 px · SVG/);
    const probeThin = await page.evaluate(async () => {
      const svg = window.__imgv.fixtureText('svg-thin-huge');
      const bytes = new TextEncoder().encode(svg);
      const { loadImageDocument } = await import('/src/lib/images.ts');
      const doc = await loadImageDocument(bytes);
      const out = { width: doc.width, height: doc.height };
      doc.dispose();
      return out;
    });
    assert.ok(probeThin.width * probeThin.height <= 80_000_000 && Number.isInteger(probeThin.width));
  });

  // ============================================================================================
  console.log('Limits, errors, cancellation');
  await test('too-large PNG header is refused before any decode; zero-size, corrupt and unknown inputs fail with specific messages', async () => {
    await page.evaluate(() => window.__imgv.resetCounters());
    await h.load('png-too-large');
    assert.equal(await page.locator('.imgv-state--error strong').innerText(), 'Image too large to open safely');
    assert.match(await page.locator('.imgv-state--error').innerText(), /20000 x 20000/);
    await h.load('png-zero-size');
    assert.match(await page.locator('.imgv-state--error').innerText(), /header is invalid/);
    assert.equal(await page.evaluate(() => window.__bitmapCalls), 0, 'the decoder was never reached');
    await h.load('png-corrupt');
    assert.equal(await page.locator('.imgv-state--error strong').innerText(), 'This image could not be decoded');
    assert.equal(await page.evaluate(() => window.__bitmapCalls), 1);
    await h.load('bytes-unknown');
    assert.equal(await page.locator('.imgv-state--error strong').innerText(), 'Unsupported image format');
    await h.load('empty');
    assert.equal(await page.locator('.imgv-state--error strong').innerText(), 'Unsupported image format');
    assert.equal(await page.locator('.imgv-toolbar button[aria-label^="Zoom in"]').isDisabled(), true);
    assert.equal(await page.locator('.imgv-toolbar button[aria-label^="Calibrate"]').isDisabled(), true);
  });
  await test('rapid document switching: queued decodes never start, an aborted decode releases its bitmap, the last request wins', async () => {
    const big = await page.evaluate(() => window.__imgv.fixtureBytes('big-png').then(b => Array.from(b)));
    const png = await page.evaluate(() => window.__imgv.fixtureBytes('quad-png').then(b => Array.from(b)));
    const jpeg = await page.evaluate(() => window.__imgv.fixtureBytes('quad-jpeg').then(b => Array.from(b)));
    await h.load('svg-quad');
    await page.evaluate(() => window.__imgv.resetCounters());
    await page.evaluate(async ([a, b, c]) => {
      const frame = () => new Promise(r => requestAnimationFrame(() => r()));
      window.__imgv.loadBytes('big', Uint8Array.from(a)); await frame();
      window.__imgv.loadBytes('png', Uint8Array.from(b)); await frame();
      window.__imgv.loadBytes('jpeg', Uint8Array.from(c));
    }, [big, png, jpeg]);
    await page.waitForFunction(() => window.__imgv.state().fixture === 'jpeg' && window.__imgv.phase() === 'ready', null, { timeout: 30000 });
    await h.settle();
    assert.match(await h.text('.imgv-status'), /400 × 300 px · JPEG/);
    const counters = await page.evaluate(() => ({ calls: window.__bitmapCalls, closed: window.__bitmapClosed }));
    note('switchCounters', JSON.stringify(counters));
    assert.equal(counters.calls, 2, 'big + jpeg decoded; the png request was aborted while queued and never started');
    assert.ok(counters.closed >= 1, 'the aborted big decode closed its bitmap');
    assert.equal(await page.locator('.imgv-state').count(), 0);
  });

  await test('a 12-megapixel image: pan/zoom frame times (real numbers), and no React commits while interacting (camera kept outside React)', async () => {
    const ref = await open({ width: 1440, height: 900 }, { query: '&camera=ref' });
    const hr = H(ref.page);
    const loadStart = Date.now();
    await hr.load('big-png');
    note('big-png 4096x3072 load+decode ms', Date.now() - loadStart);
    await hr.key('0');
    await ref.page.evaluate(() => window.__imgv.resetCounters());
    const frames = await ref.page.evaluate(() => { window.__frames = []; let last = performance.now(); const tick = now => { window.__frames.push(now - last); last = now; window.__raf = requestAnimationFrame(tick); }; window.__raf = requestAnimationFrame(tick); });
    const box = await ref.page.locator('.imgv-surface').boundingBox();
    await ref.page.mouse.move(box.x + 400, box.y + 300);
    await ref.page.mouse.down();
    for (let i = 0; i < 90; i++) await ref.page.mouse.move(box.x + 400 + i * 4, box.y + 300 + i * 2);
    await ref.page.mouse.up();
    for (let i = 0; i < 20; i++) await ref.page.mouse.wheel(0, i % 2 ? 120 : -120);
    await hr.settle();
    const stats = await ref.page.evaluate(() => { cancelAnimationFrame(window.__raf); const f = window.__frames.slice(2).sort((a, b) => a - b); return { n: f.length, p50: f[Math.floor(f.length * 0.5)], p95: f[Math.floor(f.length * 0.95)], max: f[f.length - 1] }; });
    const after = await hr.state();
    note('big-png pan+zoom frame ms', `n=${stats.n} p50=${stats.p50.toFixed(1)} p95=${stats.p95.toFixed(1)} max=${stats.max.toFixed(1)}`);
    note('React commits during 90 pointer moves + 20 wheel steps (camera=ref)', after.commits);
    note('camera emits during that interaction', after.cameraEmits);
    assert.equal(after.commits, 0, 'the viewer did not re-render React while panning and zooming');
    assert.ok(after.cameraEmits >= 1 && after.cameraEmits <= stats.n + 2, `emits ${after.cameraEmits} are frame-throttled (${stats.n} frames)`);
    assert.ok(stats.p95 < 120, `p95 frame time ${stats.p95}`);
    void frames;
    await ref.context.close();
  });

  await test('device pixel ratio 2: the canvas backing store is 2x and pixels stay exact', async () => {
    const hi = await open({ width: 1200, height: 800 }, { scale: 2 });
    const hh = H(hi.page);
    await hh.load('quad-png');
    const stats = await hi.page.evaluate(() => window.__imgv.canvasStats());
    assert.equal(stats.dpr, 2);
    close(stats.width, stats.cssWidth * 2, 1, 'backing width'); close(stats.height, stats.cssHeight * 2, 1, 'backing height');
    const p = await hh.clientOf(100, 75);
    colorNear(await hh.pixel(p.x, p.y), QUAD.tl, 3, 'dpr2 colour');
    await hi.context.close();
  });

  // ============================================================================================
  console.log('Screenshots (dark/light, 960/1440)');
  const scenario = async (pg, hp) => {
    await hp.load('board-png');
    await hp.key('c');
    const a = await hp.clientOf(120, 860), b = await hp.clientOf(920, 860);
    await pg.mouse.click(a.x, a.y); await pg.mouse.click(b.x, b.y); await hp.settle();
    await pg.locator('.imgv-form input').fill('40'); await pg.locator('.imgv-form input').press('Enter');
    await hp.settle();
    await hp.key('m');
    await hp.clickImage(1380, 800); await hp.clickImage(1140, 380);
    await pg.evaluate(() => {
      window.__imgv.setBookmarks([{ id: 'b1', page: 1, label: 'Ruler zero', x: 120, y: 860 }, { id: 'b2', page: 1, label: 'Red marker', x: 1380, y: 800 }, { id: 'b3', page: 1, label: 'Whole board' }]);
      window.__imgv.setAnnotations([{ id: 'n1', page: 1, x: 735, y: 355, text: 'U12 pin 3 reads 0.4 V under load', updatedAt: '2026-01-01T00:00:00.000Z' }, { id: 'n2', page: 1, x: 1040, y: 560, text: 'Lifted pad, reflow before test', updatedAt: '2026-01-01T00:00:00.000Z' }]);
    });
    await hp.settle();
  };
  for (const [width, height] of [[1440, 900], [960, 700]]) {
    for (const theme of ['dark', 'light']) {
      const shot = await open({ width, height }, { query: `&theme=${theme}` });
      const hs = H(shot.page);
      await scenario(shot.page, hs);
      await shot.page.screenshot({ path: path.join(OUT, `board-${theme}-${width}.png`) });
      await hs.key('Escape'); await hs.key('Escape');
      await hs.key('c'); await hs.clickImage(300, 500); await hs.clickImage(700, 500);
      await shot.page.locator('.imgv-form input').fill('1x');
      await shot.page.locator('.imgv-form input').press('Enter');
      await shot.page.screenshot({ path: path.join(OUT, `calibrate-error-${theme}-${width}.png`) });
      await hs.key('Escape'); await hs.key('Escape');
      await hs.key('n'); await hs.clickImage(600, 300);
      await shot.page.locator('.imgv-editor textarea').fill('Cracked capacitor, replace C14');
      await shot.page.screenshot({ path: path.join(OUT, `note-editor-${theme}-${width}.png`) });
      await shot.page.keyboard.press('Escape');
      await hs.load('svg-hostile');
      await shot.page.waitForTimeout(300);
      await shot.page.screenshot({ path: path.join(OUT, `hostile-svg-${theme}-${width}.png`) });
      await hs.load('png-too-large');
      await shot.page.screenshot({ path: path.join(OUT, `limit-${theme}-${width}.png`) });
      await hs.load('alpha-png');
      await shot.page.screenshot({ path: path.join(OUT, `alpha-${theme}-${width}.png`) });
      await shot.context.close();
    }
  }
  {
    const narrow = await open({ width: 960, height: 700 }, { query: '&compact=1&theme=dark' });
    const hn = H(narrow.page);
    await hn.load('board-png');
    assert.equal(await narrow.page.locator('.imgv-panel').count(), 0, 'compact: the panel starts closed');
    await narrow.page.setViewportSize({ width: 640, height: 640 });
    await hn.settle();
    await narrow.page.locator('button[aria-controls]').click();
    await hn.settle();
    assert.equal(await narrow.page.locator('.imgv-panel').count(), 1);
    await narrow.page.screenshot({ path: path.join(OUT, 'compact-panel-dark-640.png') });
    await narrow.context.close();
  }

  await context.close();
  await browser.close();

  // --- summary --------------------------------------------------------------------------------
  const failed = results.filter(r => !r.ok);
  if (problems.length) console.log(`\nPage problems (${problems.length}):\n  ${[...new Set(problems)].join('\n  ')}`);
  console.log('\nNumbers:'); for (const [key, value] of Object.entries(numbers)) console.log(`  ${key}: ${value}`);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed, ${problems.length} page errors/warnings, screenshots in ${OUT}`);
  if (failed.length || problems.length) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
