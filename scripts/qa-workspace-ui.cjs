'use strict';

// Drives harness/workspace.html (the whole App shell on the synthetic mock core, src/app/mock-api.ts) in headless Chromium and,
// when src/app/useWorkspace.ts exists, the real index.html in the browser fallback.
// Usage: node scripts/qa-workspace-ui.cjs [scenario ...]    (no argument = every scenario)
// Env:   TRACE_QA_URL (default http://127.0.0.1:5210; a vite dev server is started when nothing answers there),
//        TRACE_QA_OUT (screenshots, default test-results/workspace-ui), TRACE_CHROMIUM_PATH, PLAYWRIGHT_BROWSERS_PATH.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.TRACE_PLAYWRIGHT_PATH || 'playwright');

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.TRACE_QA_URL || 'http://127.0.0.1:5210').replace(/\/$/, '');
const OUT = process.env.TRACE_QA_OUT || path.join(ROOT, 'test-results', 'workspace-ui');
const HARNESS = `${BASE}/harness/workspace.html`;

const results = [];
let scenario = '';
function check(name, ok, detail) {
  results.push({ scenario, name, ok: !!ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${scenario} :: ${name}${detail !== undefined ? `  [${typeof detail === 'string' ? detail : JSON.stringify(detail)}]` : ''}`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function dismissStartupSupportNotice(page) {
  const notice = page.locator('[data-testid="support-notice"]');
  await notice.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
  if (await notice.count()) await page.locator('[data-testid="support-not-now"]').click();
}

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
async function serverUp() { try { return (await fetch(HARNESS)).ok; } catch { return false; } }
async function ensureServer() {
  if (await serverUp()) return null;
  const port = new URL(BASE).port || '5210';
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', port, '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { if (await serverUp()) return child; await sleep(250); }
  child.kill();
  throw new Error(`dev server did not start on ${BASE}`);
}

// The sandbox Chromium predates Map#getOrInsertComputed (pdf.js 6 needs it; the Electron target ships it).
const POLYFILL = () => {
  for (const Collection of [Map, WeakMap]) {
    const proto = Collection.prototype;
    if (!proto.getOrInsert) Object.defineProperty(proto, 'getOrInsert', { configurable: true, writable: true, value(key, value) { if (!this.has(key)) this.set(key, value); return this.get(key); } });
    if (!proto.getOrInsertComputed) Object.defineProperty(proto, 'getOrInsertComputed', { configurable: true, writable: true, value(key, compute) { if (!this.has(key)) this.set(key, compute(key)); return this.get(key); } });
  }
};

let browser;
const pageErrors = [];
async function openPage({ width = 1440, height = 900, theme = 'dark', query = '', url = HARNESS, layout = 'workshop', init, dismissStartupSupport = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(POLYFILL);
  await context.addInitScript(([th, lay]) => localStorage.setItem('trace-settings', JSON.stringify({ language: 'en', theme: th, layout: lay, motion: false, showLabels: true, showConnections: true })), [theme, layout]);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`[${scenario}] ${String(error)}`));
  page.on('console', message => { if (message.type() === 'error' && !/favicon|Failed to load resource/.test(message.text())) pageErrors.push(`[${scenario}] console: ${message.text().slice(0, 200)}`); });
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}${query}`);
  await page.waitForSelector('[data-testid=app]', { timeout: 15000 });
  if (dismissStartupSupport) await dismissStartupSupportNotice(page);
  return page;
}
const calls = (page, name) => page.evaluate(n => window.__mock.calls.filter(c => c.name === n).map(c => c.args), name);
const state = page => page.evaluate(() => { const s = window.__mock.state(); return { tab: s.activeTab, split: s.split, selection: s.selection, notes: s.notes.length, docs: s.documents.map(d => [d.record.id, d.status]) }; });
const renders = page => page.evaluate(() => ({ ...window.__wspRenders }));
const shot = async (page, name) => { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };
const focusSearch = async page => { await page.keyboard.press('Control+f'); await page.waitForFunction(() => document.activeElement && document.activeElement.matches('[data-testid=search-input]')); };
async function pick(page, ref, exact = true) {
  await focusSearch(page);
  await page.fill('[data-testid=search-input]', ref);
  await page.waitForFunction(r => !!document.querySelector('[data-testid=search-row]') && window.__mock.state().search.query === r, ref);
  await page.keyboard.press('Enter');
  if (exact) await page.waitForFunction(r => { const s = window.__mock.state(); return s.board.components.find(c => c.id === s.selection.componentId)?.ref === r; }, ref);
}
const resultRefs = page => page.$$eval('[data-testid=search-row]', rows => rows.map(row => row.querySelector('.component-ref')?.textContent ?? ''));

// ------------------------------------------------------------------------------------------------------------------------------ scenarios
const scenarios = {
  async support() {
    const page = await openPage({ dismissStartupSupport: false });
    const notice = page.locator('[data-testid="support-notice"]');
    await notice.waitFor({ state: 'visible', timeout: 10000 });
    check('startup support reminder is shown and can be skipped', await page.locator('[data-testid="support-not-now"]').isVisible());
    await page.locator('[data-testid="support-not-now"]').click();
    await notice.waitFor({ state: 'detached', timeout: 5000 });
    check('skipping the optional reminder leaves the workspace usable', await page.locator('[data-testid=app]').isVisible());
    await page.close();
  },

  async tabs() {
    const page = await openPage();
    const tabs = await page.$$eval('[role=tab]', nodes => nodes.map(node => ({ name: node.textContent.replace(/\d+$/, '').trim(), selected: node.getAttribute('aria-selected'), tab: node.tabIndex })));
    check('three tabs Board / Schematic / Documents', tabs.map(t => t.name).join() === 'Board,Schematic,Documents' && tabs[0].selected === 'true', tabs);
    check('roving tabindex: only the selected tab is in the tab order', tabs.map(t => t.tab).join() === '0,-1,-1');
    check('tabpanel is labelled by the active tab', await page.$eval('[role=tabpanel]', node => node.getAttribute('aria-labelledby')) === 'wsp-tab-board');
    await page.click('[data-testid=tab-schematic]');
    check('Schematic tab shows the schematic viewer and diagnostics', await page.isVisible('[data-testid=schematic-tab]') && await page.isVisible('[data-testid=schematic-diagnostics]') && (await calls(page, 'setActiveTab')).some(a => a[0] === 'schematic'));
    check('unresolved sheet file is listed with the same-directory hint', /amp\.kicad_sch/.test(await page.$eval('[data-testid=schematic-diagnostics]', n => n.textContent)) && /same folder/.test(await page.$eval('[data-testid=schematic-diagnostics]', n => n.textContent)));
    await page.click('[data-testid=tab-documents]');
    check('Documents tab lists every document with status chips', (await page.$$eval('[data-testid=document-row] [data-testid=status-chip]', n => n.map(x => x.textContent))).join() === 'Ready,Ready,Ready,Missing,Changed');
    await page.focus('[data-testid=tab-documents]');
    await page.keyboard.press('ArrowRight');
    check('ArrowRight wraps to the Board tab and activates it', (await state(page)).tab === 'board' && await page.evaluate(() => document.activeElement?.id === 'wsp-tab-board'));
    await page.keyboard.press('End');
    check('End jumps to the last tab', (await state(page)).tab === 'documents');
    await page.keyboard.press('Home');
    await page.keyboard.press('Alt+2');
    check('Alt+2 opens the Schematic tab', (await state(page)).tab === 'schematic');
    await page.close();
  },

  async split() {
    const page = await openPage({ width: 1440 });
    await page.click('[data-testid=split-toggle]');
    await page.waitForSelector('[data-testid=split-layout]');
    const patch = (await calls(page, 'setSplit'))[0]?.[0];
    check('split toggle calls setSplit({enabled:true, right}) with a document preselected', patch?.enabled === true && !!patch.right, patch);
    const width = async sel => (await page.$eval(sel, n => n.getBoundingClientRect().width));
    const total = async () => (await width('[data-testid=split-left]')) + (await width('[data-testid=split-right]'));
    const ratioNow = async () => (await width('[data-testid=split-left]')) / (await total());
    const nowText = () => page.$eval('[data-testid=split-divider]', n => n.getAttribute('aria-valuenow'));
    check('divider is a focusable vertical separator with value 50', await page.$eval('[data-testid=split-divider]', n => n.getAttribute('role') === 'separator' && n.getAttribute('aria-orientation') === 'vertical' && n.tabIndex === 0) && await nowText() === '50');
    check('right pane shows a document picker and a viewer', await page.isVisible('[data-testid=split-picker]'));
    await page.focus('[data-testid=split-divider]');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    check('ArrowRight x3 moves the divider to 56%', await nowText() === '56' && Math.abs(await ratioNow() - 0.56) < 0.02, [await nowText(), await ratioNow()]);
    await page.keyboard.press('Shift+ArrowLeft');
    check('Shift+ArrowLeft moves by 10%', await nowText() === '46');
    await page.keyboard.press('Home');
    check('Home clamps to 20%', await nowText() === '20' && Math.abs(await ratioNow() - 0.2) < 0.02);
    await page.keyboard.press('End');
    check('End clamps to 80%', await nowText() === '80' && Math.abs(await ratioNow() - 0.8) < 0.02);
    await page.keyboard.press('Enter');
    check('Enter resets to 50%', await nowText() === '50');
    const box = await (await page.$('[data-testid=split-divider]')).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 100, { steps: 8 });
    const live = await ratioNow();
    await page.mouse.up();
    const after = (await calls(page, 'setSplit')).map(a => a[0].ratio).filter(r => r !== undefined).pop();
    check('mouse drag previews live and persists once on release', live > 0.55 && after > 0.55 && Math.abs(after - await ratioNow()) < 0.02, { live, after });
    const box2 = await (await page.$('[data-testid=split-divider]')).boundingBox();
    await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2); await page.mouse.down(); await page.mouse.move(-300, box2.y + 100, { steps: 6 }); await page.mouse.up();
    check('dragging far left clamps the ratio at 0.2', Math.abs((await calls(page, 'setSplit')).map(a => a[0].ratio).filter(r => r !== undefined).pop() - 0.2) < 1e-9);
    await page.dblclick('[data-testid=split-divider]');
    check('double-click resets to 50%', await nowText() === '50');
    // Independent camera: zooming the document pane never touches the board status.
    const zoomBefore = await page.evaluate(() => window.__mock.statusStore.getSnapshot().zoom);
    await page.selectOption('[data-testid=split-picker]', 'pdf1');
    await page.waitForSelector('.pdfv', { timeout: 10000 });
    await page.click('.pdfv [aria-label*="oom in" i]').catch(() => {});
    await sleep(500);
    const zoomAfter = await page.evaluate(() => window.__mock.statusStore.getSnapshot().zoom);
    const docCameras = (await calls(page, 'setCamera')).filter(a => a[0] === 'pdf1');
    check('PDF pane camera is persisted for its own source and independent of the board camera', zoomBefore === zoomAfter && docCameras.length > 0 && (await calls(page, 'setCamera')).every(a => a[0] !== 'board'), { zoomBefore, zoomAfter, docCameras: docCameras.length });
    check('viewers got the compact chrome in the split pane', await page.$eval('.pdfv', n => n.getAttribute('data-compact')) === 'true');
    await page.close();
  },

  async search() {
    const page = await openPage();
    await focusSearch(page);
    await page.fill('[data-testid=search-input]', 'U7');
    await page.waitForFunction(() => { const s = window.__mock.state().search; return s.query === 'U7' && !s.pending && s.result && s.result.groups[4].rows.length > 0; });
    const headers = await page.$$eval('.wsp-group-header', n => n.map(x => x.firstChild.textContent));
    check('results are grouped by source in order', headers.join() === 'Board components,Schematic symbols,Documents', headers);
    check('document rows carry the page identity', /p\. 2/.test(await page.$eval('[data-testid=search-row][data-source=documents]', n => n.textContent)));
    check('schematic rows carry sheet and page', /p\. 1/.test(await page.$eval('[data-testid=search-row][data-source=schematic-symbols]', n => n.textContent)));
    await page.fill('[data-testid=search-input]', 'R1');
    await page.waitForFunction(() => window.__mock.state().search.query === 'R1');
    let refs = await resultRefs(page);
    check('the exact literal reference is the first row (R1 before r1 and R10)', refs[0] === 'R1' && refs.includes('r1') && refs.indexOf('r1') > 0, refs.slice(0, 6));
    await page.fill('[data-testid=search-input]', 'r1');
    await page.waitForFunction(() => window.__mock.state().search.query === 'r1');
    refs = await resultRefs(page);
    check('B18: literal "r1" ranks the bottom-side r1 first; R1 is only a flagged alternative', refs[0] === 'r1' && (await page.$$eval('.wsp-result-list .wsp-chip', n => n.map(x => x.textContent.trim()))).includes('case differs'), refs.slice(0, 4));
    await page.fill('[data-testid=search-input]', 'R1');
    await page.keyboard.press('Enter');
    const rows = await calls(page, 'activateSearchRow');
    check('Enter activates the first row through activateSearchRow', rows.length === 1 && rows[0][0].source === 'board-components' && rows[0][0].ref === 'R1', rows[0] && rows[0][0].ref);
    check('Enter selected the exact component and left the field', (await state(page)).selection.componentId === 'c:R1' && await page.evaluate(() => document.activeElement?.tagName !== 'INPUT'));
    // ArrowDown moves the active row; Enter opens it.
    await focusSearch(page);
    await page.fill('[data-testid=search-input]', 'U');
    await page.waitForFunction(() => window.__mock.state().search.query === 'U');
    await page.keyboard.press('ArrowDown');
    check('ArrowDown moves aria-activedescendant to the second row', await page.$eval('[data-testid=search-input]', n => n.getAttribute('aria-activedescendant')) === 'wsp-row-1');
    // B12: scroll position must not survive a new result set.
    await page.fill('[data-testid=search-input]', 'R');
    await page.waitForFunction(() => window.__mock.state().search.query === 'R');
    await page.$eval('#wsp-results', n => { n.scrollTop = n.scrollHeight; });
    await sleep(150);
    const scrolled = await page.$eval('#wsp-results', n => n.scrollTop);
    await page.fill('[data-testid=search-input]', 'R1');
    await page.waitForFunction(() => window.__mock.state().search.query === 'R1');
    await sleep(150);
    const reset = await page.$eval('#wsp-results', n => n.scrollTop);
    const first = (await resultRefs(page))[0];
    check('B12: the result list returns to the top for a new query', scrolled > 100 && reset === 0 && first === 'R1', { scrolled, reset, first });
    // B14: Escape clears the field itself.
    await page.keyboard.press('Escape');
    check('B14: Escape in the search field clears the query', await page.inputValue('[data-testid=search-input]') === '' && (await calls(page, 'setSearchQuery')).pop()[0] === '');
    check('Escape on the empty field leaves it', await page.evaluate(() => document.activeElement?.matches('[data-testid=search-input]')) === true);
    await page.keyboard.press('Escape');
    check('the second Escape blurs the field', await page.evaluate(() => document.activeElement?.matches('[data-testid=search-input]')) === false);
    // B25: IME composition must neither commit nor select on Enter.
    await focusSearch(page);
    const cdp = await page.context().newCDPSession(page);
    const before = { commits: (await calls(page, 'setSearchQuery')).length, rows: (await calls(page, 'activateSearchRow')).length };
    await cdp.send('Input.imeSetComposition', { text: 'U7', selectionStart: 2, selectionEnd: 2 });
    await page.keyboard.press('Enter');
    const during = { commits: (await calls(page, 'setSearchQuery')).length, rows: (await calls(page, 'activateSearchRow')).length, focused: await page.evaluate(() => document.activeElement?.matches('[data-testid=search-input]')) };
    check('B25: nothing is committed while composing, Enter does not select or blur', during.commits === before.commits && during.rows === before.rows && during.focused, { before, during });
    await cdp.send('Input.insertText', { text: 'U7' });
    await page.waitForFunction(() => window.__mock.state().search.query === 'U7');
    check('the composed text is committed once composition ends', (await calls(page, 'setSearchQuery')).pop()[0] === 'U7');
    await page.keyboard.press('Enter');
    check('a normal Enter afterwards selects the first row', (await calls(page, 'activateSearchRow')).length === before.rows + 1);
    await shot(page, 'search-grouped');
    await focusSearch(page);
    await page.fill('[data-testid=search-input]', 'U7');
    await page.waitForFunction(() => { const q = window.__mock.state().search; return q.query === 'U7' && !q.pending && q.result.groups[4].rows.length > 0; });
    await page.click('[data-testid=search-row][data-source=documents]');
    await page.waitForSelector('[data-testid=documents-tab]');
    const picked = await state(page);
    check('activating a document hit opens that document in the Documents tab (split.right is the selection)', picked.tab === 'documents' && picked.split.right?.id === 'pdf1', picked);
    await page.close();
  },

  async inspector() {
    const page = await openPage({ height: 1000 });
    await pick(page, 'U7');
    check('ambiguous mapping lists explicit candidates', await page.$$eval('[data-testid=schematic-candidate]', n => n.length) === 2);
    check('ambiguous mapping never shows a single "show in schematic" link', await page.$('[data-testid=show-schematic]') === null);
    await page.click('[data-testid=schematic-candidate] >> nth=1');
    check('choosing a candidate calls chooseSchematicTarget(1)', JSON.stringify(await calls(page, 'chooseSchematicTarget')) === '[[1]]');
    await page.waitForSelector('[data-mapping=unique]');
    await pick(page, 'U1');
    const unique = await page.$eval('[data-mapping=unique]', n => n.textContent);
    check('unique mapping shows sheet, part and link status', /Sheet/.test(unique) && /power/.test(unique) && /U1/.test(unique) && /Link:/.test(unique), unique.slice(0, 120));
    await page.click('[data-testid=pin-row] >> nth=4');
    const dis = await page.$eval('[data-testid=link-disagreements]', n => n.textContent);
    check('pin missing in the schematic is listed', /pin missing in the schematic/.test(dis), dis);
    await pick(page, 'C2');
    const dis2 = await page.$eval('[data-testid=link-disagreements]', n => n.textContent);
    check('net disagreement shows both net names', /board net VCC_CORE/.test(dis2) && /schematic net \+1V8/.test(dis2), dis2);
    await pick(page, 'C20');
    check('board-only part: "missing" says so and nothing is guessed', await page.isVisible('[data-mapping=missing]') && await page.$('[data-testid=show-schematic]') === null && /No schematic counterpart found/.test(await page.$eval('[data-mapping=missing]', n => n.textContent)));
    await pick(page, 'PU301');
    const hits = await page.$$eval('[data-testid=document-hit]', n => n.map(x => x.textContent));
    check('duplicate PDF hits are listed for an explicit choice with page identity', hits.length === 3 && hits.filter(h => /Page 2/.test(h)).length === 2, hits);
    await page.click('[data-testid=document-hit]:has-text("Page 2") >> nth=1');
    const rows = (await calls(page, 'activateSearchRow')).map(a => a[0]).filter(r => r.source === 'documents');
    check('choosing a hit calls activateSearchRow with that occurrence', rows.length === 1 && rows[0].page === 2 && rows[0].documentId === 'pdf1', rows[0]);
    // B21: the pad keeps its physical side.
    await pick(page, 'Q1');
    await page.click('[data-testid=side-bottom]');
    await page.click('[data-testid=pin-row] >> nth=2');
    check('B21: a bottom pad of a top part keeps the bottom view', await page.$eval('[data-testid=side-bottom]', n => n.getAttribute('aria-pressed')) === 'true');
    await page.click('[data-testid=pin-row] >> nth=0');
    check('a top pad of the same part shows the top side again', await page.$eval('[data-testid=side-top]', n => n.getAttribute('aria-pressed')) === 'true');
    await page.click('[data-testid=side-bottom]');
    await pick(page, 'J1');
    await page.click('[data-testid=pin-row] >> nth=1');
    check('a "both" part keeps the current side', await page.$eval('[data-testid=side-bottom]', n => n.getAttribute('aria-pressed')) === 'true');
    await shot(page, 'inspector-sections');
    await page.close();
  },

  async longref() {
    for (const layout of ['workshop', 'focus']) for (const width of [960, 1440]) {
      const page = await openPage({ width, height: 800, layout });
      await pick(page, 'TP_VCORE_CPU');
      const info = await page.evaluate(() => {
        const button = document.querySelector('[data-testid=copy-ref]'); const content = document.querySelector('.inspector-content');
        const b = button.getBoundingClientRect(), c = content.getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        const ref = document.querySelector('[data-testid=hero-ref]');
        return { inside: b.left >= c.left - 0.5 && b.right <= c.right + 0.5, hit: !!hit && (hit === button || button.contains(hit)), ellipsis: ref.scrollWidth >= ref.clientWidth };
      });
      check(`B26: copy button stays visible and clickable (${layout} ${width}px)`, info.inside && info.hit, info);
      if (layout === 'workshop' && width === 960) {
        await page.click('[data-testid=copy-ref]');
        await page.waitForSelector('[data-testid=toast]', { timeout: 3000 }).catch(() => {});
        check('copy shows a confirmation toast', await page.isVisible('[data-testid=toast]'));
      }
      await page.close();
    }
  },

  async notes() {
    const page = await openPage({ height: 900 });
    await pick(page, 'U1');
    check('existing note card shows text and labelled technician measurements', /Replaced after short/.test(await page.$eval('[data-testid=note-card]', n => n.textContent)) && /3\.28 V/.test(await page.$eval('[data-testid=note-card]', n => n.textContent)) && /Technician-entered/.test(await page.$eval('[data-testid=note-card]', n => n.textContent)));
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('n');
    await page.waitForSelector('[data-testid=note-dialog]');
    const existing = await page.inputValue('#note-draft');
    check('B13: N opens the editor with the saved text untouched', existing === 'Replaced after short on VIN. Check the inductor next.', existing);
    check('measurement fields are prefilled', await page.inputValue('[data-testid=measure-voltage]') === '3.28 V');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=note-dialog]', { state: 'detached' });
    await pick(page, 'C1');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('n');
    await page.waitForSelector('[data-testid=note-dialog]');
    check('B13: a new note starts empty (no "n" typed by the shortcut)', await page.inputValue('#note-draft') === '');
    check('dialog names the target', /C1/.test(await page.$eval('[data-testid=note-dialog] h2', n => n.textContent)));
    await page.fill('#note-draft', 'Cap measured 98 nF');
    await page.fill('[data-testid=measure-voltage]', '3.3 V');
    await page.fill('[data-testid=measure-other]', 'x'.repeat(80));
    check('measurement fields are bounded to 64 characters', (await page.inputValue('[data-testid=measure-other]')).length === 64);
    await page.fill('[data-testid=measure-other]', '');
    await page.click('[data-testid=note-save]');
    await page.waitForSelector('[data-testid=note-dialog]', { state: 'detached' });
    const call = (await calls(page, 'upsertNote')).pop();
    check('Save calls upsertNote with target and patch', call[0].componentId === 'c:C1' && !call[0].pinId && call[1].text === 'Cap measured 98 nF' && call[1].measurements.voltage === '3.3 V', call);
    check('the note card appears after the save', /Cap measured/.test(await page.$eval('[data-testid=note-card]', n => n.textContent)));
    // pin note
    await page.click('[data-testid=pin-row] >> nth=0');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('n');
    await page.waitForSelector('[data-testid=note-dialog]');
    check('with a pin selected the editor targets that pin', /pin 1/.test(await page.$eval('[data-testid=note-dialog] h2', n => n.textContent)));
    await page.fill('#note-draft', 'Pin 1 reads 3.3 V');
    page.evaluate(() => window.__mock.hooks.failNextNote());
    await page.click('[data-testid=note-save]');
    await page.waitForSelector('[data-testid=note-dialog] .data-warning');
    check('a failed save keeps the dialog open with the text', await page.inputValue('#note-draft') === 'Pin 1 reads 3.3 V' && /not saved/.test(await page.$eval('[data-testid=note-dialog] .data-warning', n => n.textContent)));
    await page.click('[data-testid=note-save]');
    await page.waitForSelector('[data-testid=note-dialog]', { state: 'detached' });
    check('retrying saves exactly one note for that pin', (await page.evaluate(() => window.__mock.state().notes.filter(n => n.target?.ref === 'C1' && n.target.pin === '1').length)) === 1);
    await page.close();
    const blocked = await openPage({ query: 'notesBlocked=1' });
    await pick(blocked, 'U1');
    check('notesBlocked is explained in the inspector with a retry button', await blocked.isVisible('[data-testid=retry-notes]'));
    await blocked.click('[data-testid=note-tool]');
    await blocked.waitForSelector('[data-testid=note-dialog]');
    check('blocked notes: editor is read-only and Save is disabled', await blocked.$eval('#note-draft', n => n.readOnly) && await blocked.$eval('[data-testid=note-save]', n => n.disabled));
    await blocked.click('[data-testid=note-dialog] button:has-text("Retry reading notes")');
    await blocked.waitForFunction(() => !document.querySelector('#note-draft').readOnly);
    check('retry calls retryNotes and unlocks the editor', (await calls(blocked, 'retryNotes')).length === 1);
    await blocked.close();
  },

  async documents() {
    const page = await openPage({ query: '' });
    await page.click('[data-testid=tab-documents]');
    await page.click('[data-testid=relink-row]');
    check('relink button calls relinkDocument for the missing document', JSON.stringify(await calls(page, 'relinkDocument')) === '[["miss1"]]');
    await page.click('[data-testid=accept-row]');
    await page.waitForFunction(() => window.__mock.state().documents.find(d => d.record.id === 'chg1').status === 'ready');
    check('accept-changed calls acceptChangedDocument and the document turns ready', JSON.stringify(await calls(page, 'acceptChangedDocument')) === '[["chg1"]]');
    // state card with the same actions
    await page.click('[data-testid=document-row]:has-text("old-datasheet") .wsp-doc-main');
    await page.waitForSelector('[data-testid=document-state]');
    check('selecting a missing document shows an explicit relink card', /missing/i.test(await page.$eval('[data-testid=document-state]', n => n.textContent)) && await page.isVisible('[data-testid=relink]'));
    await page.click('[data-testid=relink]');
    check('the card relink button calls the action too', (await calls(page, 'relinkDocument')).length === 2);
    await page.click('[data-testid=remove-document] >> nth=3');
    await page.click('[data-testid=remove-confirm]');
    check('remove asks for confirmation then calls removeDocument', (await calls(page, 'removeDocument')).length === 1);
    await page.click('[data-testid=attach]');
    check('native attach calls attachDocuments()', (await calls(page, 'attachDocuments')).length === 1);
    // drag and drop overlay and routing
    await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'datasheet.pdf', { type: 'application/pdf' })); const target = document.querySelector('[data-testid=app]'); target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt })); window.__dt = dt; });
    check('drag over shows the drop overlay', await page.waitForSelector('.drop-overlay', { timeout: 3000 }).then(() => true, () => false));
    await page.evaluate(() => document.querySelector('[data-testid=app]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt })));
    await page.waitForFunction(() => window.__mock.calls.some(c => c.name === 'attachFiles'));
    check('dropped non-board files are attached as documents', JSON.stringify((await calls(page, 'attachFiles'))[0]) === '[["datasheet.pdf"]]');
    await shot(page, 'documents-tab');
    await page.close();
    const browserMode = await openPage({ query: 'persistence=session-only' });
    await browserMode.click('[data-testid=tab-documents]');
    check('session-only mode says honestly that nothing is saved', /not saved/i.test(await browserMode.$eval('[data-testid=session-only]', n => n.textContent)) && /Not saved/.test(await browserMode.$eval('[data-testid=save-state]', n => n.textContent)));
    await browserMode.setInputFiles('[data-testid=document-file-input]', { name: 'fresh.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await browserMode.waitForFunction(() => window.__mock.calls.some(c => c.name === 'attachFiles'));
    check('browser fallback attaches through the file input (attachFiles)', JSON.stringify((await calls(browserMode, 'attachFiles'))[0]) === '[["fresh.pdf"]]');
    await browserMode.close();
  },

  async export() {
    const page = await openPage();
    await page.click('[data-testid=tab-documents]');
    await page.click('[data-testid=export-open]');
    await page.waitForSelector('[data-testid=export-dialog]');
    check('nothing is ticked by default and Export is disabled', await page.$eval('[data-testid=export-run]', n => n.disabled) && (await page.$$eval('[data-testid=export-dialog] input:checked', n => n.length)) === 0);
    check('the summary says nothing is selected', /Tick at least one/.test(await page.textContent('[data-testid=export-summary]')));
    await page.check('[data-testid=export-doc] >> nth=1');
    check('ticking a document enables Export and updates the summary', !await page.$eval('[data-testid=export-run]', n => n.disabled) && /1 document, board file: no, notes: no/.test(await page.textContent('[data-testid=export-summary]')));
    await page.click('[data-testid=export-run]');
    await page.waitForSelector('[data-testid=export-result]');
    check('exportWorkspace gets exactly the ticked document and nothing implicit', JSON.stringify((await calls(page, 'exportWorkspace'))[0]) === JSON.stringify([{ documentIds: ['pdf1'], includeBoard: false, includeNotes: false }]));
    await page.check('[data-testid=export-board]'); await page.check('[data-testid=export-notes]');
    await page.click('[data-testid=export-run]');
    await page.waitForFunction(() => window.__mock.calls.filter(c => c.name === 'exportWorkspace').length === 2);
    const second = (await calls(page, 'exportWorkspace'))[1][0];
    check('board file and notes are included only when ticked', second.includeBoard === true && second.includeNotes === true && second.documentIds.length === 1, second);
    await shot(page, 'export-dialog');
    await page.close();
  },

  async statusbar() {
    const page = await openPage({ height: 900 });
    await pick(page, 'U1');
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('m');
    const canvas = await (await page.$('[data-testid=board-pane] canvas')).boundingBox();
    const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;
    await page.mouse.click(cx - 80, cy); await page.mouse.click(cx + 80, cy - 40);
    await sleep(300);
    check('a completed measurement is shown in the status bar with its exact value', /Measurement [\d.]+ mm/.test(await page.textContent('[data-testid=status-coords]')), await page.textContent('[data-testid=status-coords]'));
    check('status bar shows geometry/unit/source and the save state', /KiCad PCB · mm/.test(await page.textContent('[data-testid=status-source]')) && await page.textContent('[data-testid=save-state]') === 'Saved');
    const before = await renders(page);
    const textBefore = await page.textContent('[data-testid=status-coords]');
    for (let i = 0; i < 120; i++) { await page.mouse.move(cx - 150 + (i % 60) * 5, cy - 120 + Math.floor(i / 2) * 3); if (i % 20 === 0) await sleep(30); }
    await sleep(200);
    const after = await renders(page);
    const delta = key => (after[key] ?? 0) - (before[key] ?? 0);
    check('P01: moving the pointer re-renders only the status bar', delta('status') > 5 && delta('shell') === 0 && delta('left') === 0 && delta('inspector') === 0, { status: delta('status'), shell: delta('shell'), left: delta('left'), inspector: delta('inspector') });
    check('the displayed coordinates changed', textBefore !== await page.textContent('[data-testid=status-coords]'));
    await page.evaluate(() => window.__mock.hooks.patch({ save: { dirty: true, saving: false, failure: null } }));
    check('dirty state is announced', /Unsaved/.test(await page.textContent('[data-testid=save-state]')));
    await page.evaluate(() => window.__mock.hooks.patch({ save: { dirty: true, saving: false, failure: 'disk is full' } }));
    check('a save failure is shown as an alert', /Save failed: disk is full/.test(await page.textContent('[data-testid=save-state]')) && await page.$eval('[data-testid=save-state]', n => n.getAttribute('role')) === 'alert');
    await page.close();
  },

  // Task 2: the board view (zoom, centre, rotation, viewed side) is persisted per board and restored INSTEAD of the automatic fit.
  async boardcamera() {
    const KEY_B = 'b'.repeat(64);
    // Fraction of pixels (any channel off by > 24) that differ between two PNG screenshots; the stored camera is rounded to 3 decimals, so sub-pixel antialiasing noise is tolerated.
    const diffPage = await browser.newPage();
    const diff = (a, b) => diffPage.evaluate(async ([x, y]) => {
      const load = async base64 => { const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob(); const bitmap = await createImageBitmap(blob); const c = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height }); const g = c.getContext('2d'); g.drawImage(bitmap, 0, 0); return g.getImageData(0, 0, c.width, c.height); };
      const [p, q] = await Promise.all([load(x), load(y)]);
      if (p.width !== q.width || p.height !== q.height) return 1;
      let bad = 0; for (let i = 0; i < p.data.length; i += 4) if (Math.abs(p.data[i] - q.data[i]) > 24 || Math.abs(p.data[i + 1] - q.data[i + 1]) > 24 || Math.abs(p.data[i + 2] - q.data[i + 2]) > 24) bad++;
      return bad / (p.width * p.height);
    }, [a.toString('base64'), b.toString('base64')]);
    const same = async (a, b) => { const d = await diff(a, b); return { ok: d < 0.002, d }; };
    const open = (query = 'persist=1', init) => openPage({ query, width: 1440, height: 900, init });
    const paneShot = async page => { await page.mouse.move(2, 2); await sleep(120); return page.locator('[data-testid=board-pane]').screenshot(); };
    const boardCameras = page => calls(page, 'setCamera').then(list => list.filter(a => a[0] === 'board').map(a => a[1]));
    let page = await open();
    await page.waitForSelector('[data-testid=board-pane] canvas'); await sleep(700);
    const fit = await paneShot(page);
    check('the automatic fit is never persisted (no camera is written by merely loading the board)', (await boardCameras(page)).length === 0);
    const box = await (await page.$('[data-testid=board-pane] canvas')).boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx + 200, cy - 60); await page.mouse.down(); await page.mouse.move(cx + 80, cy - 20, { steps: 10 }); await page.mouse.up();
    await page.mouse.move(cx - 40, cy + 20); await page.mouse.wheel(0, -400);
    await page.keyboard.press('r');
    await page.click('[data-testid=side-bottom]');
    await sleep(900);
    const cams = await boardCameras(page);
    const last = cams.at(-1);
    check('the user view is reported once it settled (not at pointer rate) with zoom, centre, rotation and side', cams.length >= 1 && cams.length <= 3 && last && last.side === 'bottom' && last.rotation === 90 && last.zoom > 0 && Number.isFinite(last.x) && Number.isFinite(last.y), { count: cams.length, last });
    const changed = await paneShot(page);
    // The camera the first session persisted, seeded into fresh browser contexts (each context has its own storage).
    const seedA = `localStorage.setItem('trace-mock-workspace:${'a'.repeat(64)}', ${JSON.stringify(JSON.stringify({ cameras: { board: last } }))})`;
    check('the changed view differs from the fit', (await diff(changed, fit)) > 0.01);
    await shot(page, 'boardcamera-changed');
    // Switching tabs unmounts the canvas; coming back restores the stored view instead of resetting to the fit.
    await page.click('[data-testid=tab-schematic]'); await sleep(300);
    await page.click('[data-testid=tab-board]'); await sleep(700);
    const roundTrip = await same(await paneShot(page), changed);
    check('a tab round trip keeps the board view (no reset to fit)', roundTrip.ok, roundTrip.d);
    // "Quit and reopen": a reload with the persisted workspace.
    await page.reload(); await page.waitForSelector('[data-testid=board-pane] canvas'); await dismissStartupSupportNotice(page); await sleep(900);
    const reopened = await paneShot(page);
    const restart = await same(reopened, changed);
    check('after a restart the board shows the same view (zoom, centre, rotation, mirrored side; < 0.2% of pixels differ)', restart.ok, restart.d);
    check('the viewed side is restored with the camera', await page.getAttribute('[data-testid=side-bottom]', 'aria-pressed') === 'true' && await page.getAttribute('[data-testid=side-top]', 'aria-pressed') === 'false');
    check('restoring does not write the camera again', (await boardCameras(page)).length === 0, await boardCameras(page));
    await shot(page, 'boardcamera-restored');
    await page.close();
    // Another board never receives the camera of the first one.
    page = await open(`persist=1&boardKey=${KEY_B}`, seedA); await page.waitForSelector('[data-testid=board-pane] canvas'); await sleep(900);
    const other = await same(await paneShot(page), fit);
    check('another board (other key) opens fitted, not with the stored camera', other.ok && await page.getAttribute('[data-testid=side-top]', 'aria-pressed') === 'true', other.d);
    await page.close();
    // Invalid or absent stored data falls back to the fit.
    const seed = camera => ([k, c]) => localStorage.setItem(`trace-mock-workspace:${k}`, JSON.stringify({ cameras: { board: c } }));
    for (const [label, camera] of [['non-numeric zoom', { zoom: 'x', x: 1, y: 1, rotation: 0, side: 'top' }], ['NaN-like centre', { zoom: 3, x: 1e12, y: 0, rotation: 0, side: 'top' }], ['unknown side', { zoom: 3, x: 50, y: 80, rotation: 0, side: 'left' }], ['view of an empty region', { zoom: 3, x: 90000, y: 90000, rotation: 0, side: 'top' }], ['empty object', {}]]) {
      page = await openPage({ query: 'persist=1&boardKey=' + 'c'.repeat(64), width: 1440, height: 900, init: `localStorage.setItem('trace-mock-workspace:${'c'.repeat(64)}', ${JSON.stringify(JSON.stringify({ cameras: { board: camera } }))})` });
      await page.waitForSelector('[data-testid=board-pane] canvas'); await sleep(800);
      const invalid = await same(await paneShot(page), fit);
      check(`invalid stored camera (${label}) falls back to the fit`, invalid.ok, invalid.d);
      await page.close();
    }
    // The workspace may load after the board (real core): the stored view is applied when it arrives, unless the user already moved the view.
    page = await open('persist=1&cameraDelay=1500', seedA);
    await page.waitForSelector('[data-testid=board-pane] canvas'); await sleep(500);
    const early = await same(await paneShot(page), fit);
    check('before the stored camera arrives the board is fitted', early.ok, early.d);
    await sleep(1600);
    const late = await same(await paneShot(page), changed);
    check('when the stored camera arrives it replaces the fit', late.ok, late.d);
    await shot(page, 'boardcamera-late');
    await page.close();
    page = await open('persist=1&cameraDelay=1500', seedA);
    await page.waitForSelector('[data-testid=board-pane] canvas'); await sleep(400);
    const b2 = await (await page.$('[data-testid=board-pane] canvas')).boundingBox();
    await page.mouse.move(b2.x + 300, b2.y + 200); await page.mouse.wheel(0, -500);
    await sleep(1800);
    const touched = await paneShot(page);
    const vsStored = await diff(touched, changed), vsFit = await diff(touched, fit);
    check('a view the user already moved is not overwritten by the late stored camera', vsStored > 0.01 && vsFit > 0.01, { vsStored, vsFit });
    await page.close();
    await diffPage.close();
  },

  // Task 3: the alias panel (explicit, reversible, never auto-applied) built on state.link and the manifest aliases.
  async aliases() {
    const page = await openPage({ query: 'persist=1', width: 1440, height: 1500 }); // tall: the screenshots show the whole panel
    await page.click('[data-testid=tab-schematic]');
    check('the Schematic tab offers the link and alias panel', await page.isVisible('[data-testid=open-link-panel]'));
    await page.click('[data-testid=open-link-panel]');
    await page.waitForSelector('[data-testid=link-dialog][open]');
    check('the panel is a labelled modal dialog', await page.$eval('[data-testid=link-dialog]', n => n.getAttribute('aria-label') === 'Board and schematic link' && n.open));
    check('persistence is explained (saved with the workspace)', /saved with this board/i.test(await page.textContent('[data-testid=alias-persistence]')));
    check('the comparison summary is listed', /schematic-only/.test(await page.textContent('[data-testid=link-summary]')) && /nets differ/.test(await page.textContent('[data-testid=link-summary]')));
    const refOptions = await page.$$eval('[data-testid=alias-ref-from] option', n => n.map(o => o.textContent));
    check('schematic-only references are listed as candidates (R99, lower-case q1)', refOptions.some(o => o.startsWith('R99')) && refOptions.some(o => o.startsWith('q1')), refOptions);
    check('nothing is preselected and creating is disabled until both sides are chosen', (await page.inputValue('[data-testid=alias-ref-from]')) === '' && await page.isDisabled('[data-testid=alias-ref-create]') && await page.isDisabled('[data-testid=alias-ref-to]'));
    // a case-differing candidate is flagged and must be chosen explicitly
    await page.selectOption('[data-testid=alias-ref-from]', 'q1');
    const boardOptions = await page.$$eval('[data-testid=alias-ref-to] option', n => n.map(o => ({ value: o.value, text: o.textContent })));
    check('the letter-case twin is offered first and flagged, but not selected', boardOptions[1]?.value === 'Q1' && /letter case/.test(boardOptions[1].text) && (await page.inputValue('[data-testid=alias-ref-to]')) === '', boardOptions.slice(0, 3));
    await page.selectOption('[data-testid=alias-ref-from]', 'R99');
    await page.selectOption('[data-testid=alias-ref-to]', 'D1');
    const consequence = await page.textContent('[data-testid=alias-ref-consequence]');
    check('the consequence is shown before anything is applied', /R99/.test(consequence) && /D1/.test(consequence) && /Nothing is renamed/.test(consequence) && (await calls(page, 'setAlias')).length === 0, consequence);
    await shot(page, 'aliases-form');
    await page.click('[data-testid=alias-ref-create]');
    check('creating calls setAlias("refs", schematic, board)', JSON.stringify(await calls(page, 'setAlias')) === JSON.stringify([['refs', 'R99', 'D1']]), await calls(page, 'setAlias'));
    check('the alias is listed with a labelled remove button', await page.isVisible('[aria-label="Remove reference alias R99 → D1"]') && /R99/.test(await page.textContent('[data-testid=alias-list]')));
    check('the linked reference left the schematic-only candidates', !(await page.$$eval('[data-testid=alias-ref-from] option', n => n.map(o => o.value))).includes('R99'));
    check('a confirmation is announced', /Created reference alias/.test(await page.textContent('[data-testid=alias-message]')));
    // net alias
    const netOptions = await page.$$eval('[data-testid=alias-net-from] option', n => n.map(o => o.value));
    check('schematic-only nets are candidates (+1V8)', netOptions.includes('+1V8'), netOptions);
    await page.selectOption('[data-testid=alias-net-from]', '+1V8');
    await page.fill('[data-testid=alias-net-filter]', 'net_');
    const board = await page.$$eval('[data-testid=alias-net-to] option', n => n.map(o => o.value));
    check('the board net list is filterable', board.length >= 2 && board.every(n => /net_/i.test(n)), board);
    await page.selectOption('[data-testid=alias-net-to]', 'NET_B');
    check('the net consequence mentions both names and nothing is applied yet', /\+1V8/.test(await page.textContent('[data-testid=alias-net-consequence]')) && /NET_B/.test(await page.textContent('[data-testid=alias-net-consequence]')) && (await calls(page, 'setAlias')).length === 1);
    await page.click('[data-testid=alias-net-create]');
    check('creating calls setAlias("nets", schematic net, board net)', JSON.stringify((await calls(page, 'setAlias')).at(-1)) === JSON.stringify(['nets', '+1V8', 'NET_B']), await calls(page, 'setAlias'));
    check('both aliases are listed', (await page.$$('[data-testid=alias-list] li')).length === 2);
    // alias issues from the link report
    await page.evaluate(() => { const s = window.__mock.state(); window.__mock.hooks.patch({ link: { ...s.link, aliasIssues: { rows: [{ kind: 'ref', from: 'R99', to: 'D1', problem: 'target-missing' }], total: 1, truncated: false } } }); });
    check('alias issues are shown on the alias (target missing)', /no reference "D1" any more/.test(await page.textContent('[data-testid=alias-issue]')));
    await shot(page, 'aliases-list');
    await page.click('[aria-label="Remove reference alias R99 → D1"]');
    check('removing calls removeAlias and drops the row', JSON.stringify(await calls(page, 'removeAlias')) === JSON.stringify([['refs', 'R99']]) && (await page.$$('[data-testid=alias-list] li')).length === 1);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=link-dialog]', { state: 'detached' });
    check('Escape closes the panel and focus returns to the invoker', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'open-link-panel'));
    // persisted across a restart (the mock stands in for the manifest; the real store is covered by the Electron e2e)
    await page.reload(); await page.waitForSelector('[data-testid=app]');
    await dismissStartupSupportNotice(page);
    await page.click('[data-testid=tab-schematic]'); await page.click('[data-testid=open-link-panel]'); await page.waitForSelector('[data-testid=link-dialog][open]');
    check('the remaining alias survives a restart', /\+1V8/.test(await page.textContent('[data-testid=alias-list]')) && !/R99/.test(await page.textContent('[data-testid=alias-list]')));
    await page.close();
    // session-only: explained, aliases still work for the session and are listed
    const session = await openPage({ query: 'persistence=session-only', width: 1440, height: 900 });
    await session.click('[data-testid=tab-schematic]'); await session.click('[data-testid=open-link-panel]'); await session.waitForSelector('[data-testid=link-dialog][open]');
    check('session-only mode explains that nothing is saved', /nothing is saved/i.test(await session.textContent('[data-testid=alias-persistence]')));
    await session.selectOption('[data-testid=alias-ref-from]', 'R99'); await session.selectOption('[data-testid=alias-ref-to]', 'D1'); await session.click('[data-testid=alias-ref-create]');
    check('a session alias is created and listed', /R99/.test(await session.textContent('[data-testid=alias-list]')));
    await shot(session, 'aliases-session-only');
    await session.close();
    // narrow window: the form stacks, no horizontal overflow
    const narrow = await openPage({ query: 'persist=1', width: 960, height: 800 });
    await narrow.click('[data-testid=tab-schematic]'); await narrow.click('[data-testid=open-link-panel]'); await narrow.waitForSelector('[data-testid=link-dialog][open]');
    check('960px: the panel fits without horizontal scrolling', await narrow.$eval('[data-testid=link-dialog]', n => n.scrollWidth <= n.clientWidth + 1));
    await narrow.close();
  },

  // Task 4: net-only ambiguity candidates are listed explicitly (scope/sheet identity) and never selected silently.
  async netmapping() {
    const page = await openPage({ width: 1440, height: 900 });
    // Board nets sit below the component rows of the virtualized result list: the same action the net row calls is invoked directly.
    const selectNet = name => page.evaluate(n => window.__mock.actions.selectNet(n, 'search'), name);
    await selectNet('NET_A');
    await page.waitForSelector('[data-testid=inspector-schematic-net]');
    const section = '[data-testid=inspector-schematic-net]';
    check('an ambiguous net lists explicit candidates and selects nothing by itself', await page.$eval(`${section} [data-mapping]`, n => n.getAttribute('data-mapping')) === 'ambiguous' && (await page.$$('[data-testid=schematic-net-candidate]')).length === 2 && (await calls(page, 'chooseSchematicNet')).length === 0);
    const texts = await page.$$eval('[data-testid=schematic-net-candidate]', n => n.map(x => x.textContent));
    check('every candidate shows scope, sheet identity and connection count', texts.every(x => /local to a sheet/.test(x) && /connection/.test(x)) && texts.some(x => /power \(p\. 1\)/.test(x)) && texts.some(x => /Regulator \(p\. 2\)/.test(x)), texts);
    await shot(page, 'netmapping-ambiguous');
    await page.click('[data-testid=schematic-net-candidate] >> nth=1');
    check('choosing a candidate calls chooseSchematicNet(index) and resolves the list', JSON.stringify(await calls(page, 'chooseSchematicNet')) === JSON.stringify([[1]]) && await page.$eval(`${section} [data-mapping]`, n => n.getAttribute('data-mapping')) === 'unique');
    await page.click('[data-testid=show-schematic-net]');
    check('a resolved net can be shown in the schematic', (await state(page)).tab === 'schematic' || (await state(page)).split.right?.kind === 'schematic');
    await page.click('[data-testid=tab-board]');
    // a unique net
    await selectNet('GND');
    await page.waitForFunction(() => document.querySelector('[data-testid=inspector-schematic-net] [data-mapping]')?.getAttribute('data-mapping') === 'unique');
    check('a unique net is shown as linked with its scope', /global/.test(await page.textContent('[data-testid=schematic-net-unique]')));
    // a board net the schematic does not have: missing with reasons, a way to the alias panel, nothing guessed
    await selectNet('NET_B');
    await page.waitForFunction(() => document.querySelector('[data-testid=inspector-schematic-net] [data-mapping]')?.getAttribute('data-mapping') === 'missing');
    check('a missing net explains why and offers the alias panel', /No schematic net has this name/.test(await page.textContent(section)) && /No schematic net has this name\./.test(await page.textContent(section)) && await page.isVisible('[data-testid=open-link-panel-net]'));
    await page.click('[data-testid=open-link-panel-net]');
    await page.waitForSelector('[data-testid=link-dialog][open]');
    check('the alias panel opens from the missing-net card', true);
    await page.keyboard.press('Escape');
    // schematic -> board: ambiguous and missing counterparts in the Schematic tab
    await page.click('[data-testid=tab-schematic]');
    await page.evaluate(() => { const s = window.__mock.state(); window.__mock.hooks.patch({ probe: { ...s.probe, boardNetMapping: { status: 'ambiguous', candidates: [{ name: 'NET_A', id: null, pinCount: 2, via: 'exact' }, { name: 'Net_A', id: 'x', pinCount: 3, via: 'alias' }], total: 2, truncated: false, reasons: ['several-board-nets'], caseInsensitive: [] } } }); });
    await page.waitForSelector('[data-testid=board-net-mapping][data-mapping=ambiguous]');
    check('several board nets for a schematic net are listed for an explicit choice', (await page.$$('[data-testid=board-net-candidate]')).length === 2 && /Several board nets match/.test(await page.textContent('[data-testid=board-net-mapping]')));
    await shot(page, 'netmapping-board-banner');
    await page.click('[data-testid=board-net-candidate] >> nth=1');
    check('choosing calls chooseBoardNet(index)', JSON.stringify(await calls(page, 'chooseBoardNet')) === JSON.stringify([[1]]));
    await page.evaluate(() => { const s = window.__mock.state(); window.__mock.hooks.patch({ probe: { ...s.probe, boardNetMapping: { status: 'missing', candidates: [], total: 0, truncated: false, reasons: ['no-board-net'], caseInsensitive: [{ name: 'net_x', id: null, pinCount: 1, via: 'case-insensitive' }] } } }); });
    await page.waitForSelector('[data-testid=board-net-mapping][data-mapping=missing]');
    check('a missing board net is explained and case-differing names are flagged, not linked', /No board net matches/.test(await page.textContent('[data-testid=board-net-mapping]')) && /net_x/.test(await page.textContent('[data-testid=board-net-flagged]')));
    await page.close();
  },

  async dialogs() {
    const page = await openPage({ query: 'empty=1' });
    check('without a board the welcome screen shows recent files', await page.isVisible('[data-testid=welcome]') && (await page.$$('.recent-row')).length === 2);
    await page.click('[data-testid=welcome-open]');
    check('Open calls openBoard in native mode', (await calls(page, 'openBoard')).length === 1);
    await page.click('.recent-row >> nth=0');
    check('a recent file calls openRecent with its path', JSON.stringify(await calls(page, 'openRecent')) === '[["C:/service/mainboard.kicad_pcb"]]');
    await page.evaluate(() => window.__mock.hooks.setKeyRequest({ fileName: 'enc.xzz', kind: 'xzz', code: 'KEY_REQUIRED', message: 'This board is encrypted.' }));
    await page.waitForSelector('[data-testid=key-dialog]');
    check('an encrypted board opens the key dialog from state.import.keyRequest', /encrypted/.test(await page.textContent('[data-testid=key-dialog]')) && await page.$eval('[data-testid=key-submit]', n => n.disabled));
    await page.fill('#board-key', '0123456789abcdef');
    check('a valid 16-digit XZZ key enables the button', !await page.$eval('[data-testid=key-submit]', n => n.disabled));
    await page.click('[data-testid=key-submit]');
    check('the key goes to submitKey (session only)', JSON.stringify(await calls(page, 'submitKey')) === '[["0123456789abcdef"]]');
    await page.evaluate(() => window.__mock.hooks.setKeyRequest({ fileName: 'enc.xzz', kind: 'xzz', code: 'INVALID_KEY', message: 'Wrong key.' }));
    await page.waitForSelector('[data-testid=key-dialog]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window.__mock.calls.filter(c => c.name === 'cancelKeyRequest').length) === 1);
    check('Escape cancels the key request', true);
    await page.evaluate(() => window.__mock.hooks.notify('error', 'Something failed in the mock.'));
    await page.waitForSelector('[data-testid=toast]');
    check('notices from the core become toasts', /Something failed/.test(await page.textContent('[data-testid=toast]')));
    await page.click('[data-testid=toast] button');
    await page.waitForFunction(() => !document.querySelector('[data-testid=toast]'));
    check('dismissing a toast removes the core notice', true);
    const board = await openPage();
    await board.evaluate(() => window.__mock.hooks.patch({ import: { ...window.__mock.state().import, phase: 'processing' } }));
    check('the loading overlay follows state.import.phase', await board.isVisible('[data-testid=loading-overlay]'));
    await board.evaluate(() => window.__mock.hooks.patch({ import: { ...window.__mock.state().import, phase: 'idle' } }));
    await board.click('[data-testid=settings-button]');
    check('settings, help, info and recents dialogs open', await board.isVisible('[data-testid=settings-dialog]'));
    await board.keyboard.press('Escape');
    await board.keyboard.press('?'); check('help dialog lists the new shortcuts', /Alt \+ 1/.test(await board.textContent('[data-testid=help-dialog]'))); await board.keyboard.press('Escape');
    await board.click('.data-info'); check('file info dialog shows parser warnings', await board.isVisible('[data-testid=info-dialog]')); await board.keyboard.press('Escape');
    await page.close(); await board.close();
  },

  async focus() {
    const page = await openPage({ layout: 'focus', width: 1440, height: 900 });
    check('focus layout hides the left panel and floats the inspector', await page.$('.search-panel') === null && await page.isVisible('.floating-inspector'));
    await page.keyboard.press('Control+f');
    await page.fill('[data-testid=search-input]', 'U7');
    await page.waitForSelector('.focus-search-results [data-testid=search-row]');
    check('focus search shows grouped results over the canvas', await page.isVisible('.focus-search-results .wsp-group-header'));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__mock.state().selection.componentId === 'c:U7');
    await page.keyboard.press('Escape');
    check('focus layout keeps the selection inspector', await page.isVisible('[data-testid=hero-ref]'));
    await page.click('[data-testid=split-toggle]');
    await page.waitForSelector('[data-testid=split-layout]');
    check('focus layout works with split view', await page.isVisible('[data-testid=split-right]'));
    await shot(page, 'focus-split-1440');
    await page.close();
  },

  async layouts() {
    for (const theme of ['dark', 'light']) for (const width of [960, 1200, 1440, 1920]) {
      const height = width >= 1920 ? 1080 : width >= 1440 ? 900 : 720;
      const page = await openPage({ width, height, theme });
      await pick(page, 'U7');
      await page.click('[data-testid=pin-row] >> nth=1');
      await sleep(400);
      const overflow = await page.evaluate(() => {
        const bad = [];
        const root = document.documentElement;
        if (root.scrollWidth > root.clientWidth) bad.push('page');
        for (const sel of ['.app-titlebar', '.workspace', '.wsp-main', '.inspector', '.search-panel', '.statusbar']) { const n = document.querySelector(sel); if (n && n.scrollWidth > n.clientWidth + 1) bad.push(`${sel}:${n.scrollWidth}>${n.clientWidth}`); }
        const bar = document.querySelector('.app-titlebar').getBoundingClientRect();
        const last = [...document.querySelectorAll('.app-titlebar button')].map(b => b.getBoundingClientRect().right).reduce((a, b) => Math.max(a, b), 0);
        if (last > bar.right + 0.5) bad.push('titlebar-controls-clipped');
        return bad;
      });
      check(`board layout without overflow (${theme} ${width}px)`, overflow.length === 0, overflow);
      await shot(page, `board-${theme}-${width}`);
      await page.click('[data-testid=split-toggle]');
      await page.selectOption('[data-testid=split-picker]', 'pdf1');
      await page.waitForSelector('.pdfv', { timeout: 10000 });
      await sleep(900);
      const overflowSplit = await page.evaluate(() => {
        const bad = []; const root = document.documentElement;
        if (root.scrollWidth > root.clientWidth) bad.push('page');
        for (const sel of ['.wsp-main', '.wsp-split', '.wsp-pane', '.inspector', '.statusbar']) for (const n of document.querySelectorAll(sel)) if (n.scrollWidth > n.clientWidth + 1) bad.push(`${sel}:${n.scrollWidth}>${n.clientWidth}`);
        const panes = [...document.querySelectorAll('.wsp-pane')].map(n => Math.round(n.getBoundingClientRect().width));
        if (Math.min(...panes) < 200) bad.push('pane-too-narrow:' + panes.join('/'));
        return bad;
      });
      check(`split view usable without overflow (${theme} ${width}px)`, overflowSplit.length === 0, overflowSplit);
      await shot(page, `split-pdf-${theme}-${width}`);
      if (width === 960 || width === 1440) {
        await page.click('[data-testid=tab-schematic]'); await sleep(900);
        await shot(page, `split-schematic-${theme}-${width}`);
        await page.click('[data-testid=tab-documents]'); await sleep(500);
        await shot(page, `split-documents-${theme}-${width}`);
      }
      await page.close();
    }
  },

  async realapp() {
    if (!fs.existsSync(path.join(ROOT, 'src', 'app', 'useWorkspace.ts'))) { check('real core present (skipped: src/app/useWorkspace.ts missing)', true); return; }
    const gencad = `$HEADER\nGENCAD 1.4\nUNITS MM\nORIGIN 0 0\n$ENDHEADER\n$BOARD\nRECTANGLE 0 0 40 30\n$ENDBOARD\n$PADS\nPAD P ROUND -1\nCIRCLE 0 0 0.2\n$ENDPADS\n$PADSTACKS\nPADSTACK PS 0\nPAD P TOP 0 0\n$ENDPADSTACKS\n$SHAPES\nSHAPE S\nRECTANGLE -2 -1 4 2\nPIN 1 PS -1 0 TOP 0 0\nPIN 2 PS 1 0 TOP 0 0\n$ENDSHAPES\n$COMPONENTS\nCOMPONENT R1\nPLACE 10 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\nCOMPONENT U1\nPLACE 25 10\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\n$ENDCOMPONENTS\n$DEVICES\nDEVICE D\nVALUE "10 kOhm"\nPACKAGE "0402"\n$ENDDEVICES\n$SIGNALS\nSIGNAL GND\nNODE R1 1\nNODE U1 1\nSIGNAL "POWER 3V3"\nNODE R1 2\nNODE U1 2\n$ENDSIGNALS\n`;
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >>', null];
    const content = 'BT /F1 18 Tf 72 700 Td (Synthetic R1 U1 GND) Tj ET', content2 = 'BT /F1 18 Tf 72 700 Td (Second page R2 only) Tj ET';
    objects[3] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`; objects[6] = `<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`;
    let pdf = '%PDF-1.4\n'; const offsets = [];
    objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const eff = '(effects (font (size 1.27 1.27)))';
    const sch = `(kicad_sch (version 20231120) (generator "synthetic") (uuid "00000000-0000-4000-8000-000000000001") (paper "A4") (lib_symbols (symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes) (property "Reference" "R" (at 0 6 0) ${eff}) (property "Value" "R" (at 0 -6 0) ${eff}) (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none)))) (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~" ${eff}) (number "1" ${eff})) (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" ${eff}) (number "2" ${eff}))))) (symbol (lib_id "Device:R") (at 100 50 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "00000000-0000-4000-8000-000000000021") (property "Reference" "R1" (at 0 0 0) ${eff}) (property "Value" "10k" (at 0 3 0) ${eff}) (pin "1" (uuid "00000000-0000-4000-8000-000000000031")) (pin "2" (uuid "00000000-0000-4000-8000-000000000032"))) (global_label "GND" (shape input) (at 100 46.19 90) (uuid "00000000-0000-4000-8000-000000000041") ${eff}) (global_label "POWER 3V3" (shape input) (at 100 53.81 270) (uuid "00000000-0000-4000-8000-000000000042") ${eff}) (sheet_instances (path "/" (page "1"))))`;
    const page = await openPage({ url: `${BASE}/index.html`, query: '', width: 1440, height: 900 });
    await page.waitForFunction(() => document.querySelector('[data-testid=welcome]'), null, { timeout: 15000 });
    check('real app starts on the welcome screen', true);
    await page.setInputFiles('[data-testid=board-file-input]', { name: 'tiny.cad', mimeType: 'text/plain', buffer: Buffer.from(gencad) });
    await page.waitForSelector('[data-testid=project-name]', { timeout: 20000 });
    check('a synthetic GenCAD board opens through the file input', (await page.textContent('[data-testid=project-name]')).length > 0 && await page.isVisible('[data-testid=board-pane] canvas'));
    check('the component list shows R1 and U1', (await page.$$eval('[data-testid=component-row] .component-ref', n => n.map(x => x.textContent))).join() === 'R1,U1');
    await page.setInputFiles('[data-testid=document-file-input]', [{ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) }, { name: 'photo.png', mimeType: 'image/png', buffer: png }, { name: 'tiny.kicad_sch', mimeType: 'text/plain', buffer: Buffer.from(sch) }]);
    await page.click('[data-testid=tab-documents]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=document-row]').length === 3, null, { timeout: 20000 });
    await sleep(2500);
    const chips = await page.$$eval('[data-testid=document-row] [data-testid=status-chip]', n => n.map(x => x.textContent));
    check('PDF, image and KiCad schematic are attached and ready', chips.length === 3 && chips.every(c => c === 'Ready'), chips);
    await shot(page, 'real-documents');
    await page.click('[data-testid=tab-schematic]');
    await sleep(1500);
    check('the schematic tab renders the attached design', await page.isVisible('[data-testid=schematic-tab] .schv'));
    await page.click('[data-testid=tab-board]');
    await focusSearch(page);
    await page.fill('[data-testid=search-input]', 'R1');
    await page.waitForSelector('[data-testid=search-row]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid=hero-ref]');
    check('searching R1 selects it in the inspector with a schematic section', await page.isVisible('[data-testid=inspector-schematic]'));
    await page.click('[data-testid=tab-board]');
    await page.click('[data-testid=search-row][data-source=documents]');
    await page.waitForSelector('[data-testid=documents-tab] .pdfv', { timeout: 15000 });
    check('activating a PDF hit opens that document in its viewer', await page.isVisible('[data-testid=documents-tab] .pdfv'));
    await page.click('[data-testid=split-toggle]');
    await sleep(1500);
    await shot(page, 'real-split');
    // B46 with the real core: a remount of the PDF viewer (leave for the image, come back) must not replay the old R1 search/highlight.
    await page.click('[data-testid=split-toggle]'); // split off again: the Documents tab shows the full list
    await page.click('[data-testid=tab-documents]');
    await page.waitForSelector('[data-testid=documents-tab] .pdfv', { timeout: 15000 });
    const pdfState = () => page.evaluate(() => { const root = document.querySelector('.pdfv'), sc = document.querySelector('.pdfv-scroller'); return root ? { page: Number(root.dataset.page), zoom: Number(root.dataset.zoom), top: sc?.scrollTop ?? -1, left: sc?.scrollLeft ?? -1, query: document.querySelector('.pdfv-search-input')?.value ?? '' } : null; });
    const rowOf = name => page.locator('[data-testid=document-row] .wsp-doc-main', { hasText: name });
    check('B46 setup: the PDF has two pages and opened on the R1 hit (page 1)', (await pdfState()).page === 1 && /\/ 2/.test(await page.textContent('.pdfv-of')), await pdfState());
    await page.fill('[data-testid=search-input]', '');
    await page.fill('.pdfv-search-input', '');
    await page.click('.pdfv-zoom'); await page.keyboard.press('Control+a'); await page.keyboard.type('200'); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.pdfv')?.dataset.page === '2' && Math.abs(Number(document.querySelector('.pdfv').dataset.zoom) - 2) < 0.001, null, { timeout: 8000 });
    await page.evaluate(() => { const sc = document.querySelector('.pdfv-scroller'); sc.scrollTop += 90; sc.scrollLeft += 30; });
    await sleep(900);
    const read = await pdfState();
    check('B46 setup: page 2 at exactly 200% scrolled, both queries empty', read.page === 2 && Math.abs(read.zoom - 2) < 0.001 && read.query === '' && read.top > 0, read);
    await rowOf('photo.png').click();
    await page.waitForSelector('[data-testid=documents-tab] .imgv', { timeout: 15000 });
    await rowOf('notes.pdf').click();
    await page.waitForSelector('[data-testid=documents-tab] .pdfv-page[data-render=done]', { timeout: 15000 });
    await sleep(1500);
    const back = await pdfState();
    check('B46: returning to the PDF without a new selection keeps page 2 / 200% / scroll', back && back.page === 2 && Math.abs(back.zoom - 2) < 0.001 && Math.abs(back.top - read.top) <= 4 && Math.abs(back.left - read.left) <= 4, { read, back });
    await page.fill('[data-testid=search-input]', 'R1'); // an old query restored/driven from outside: counts hits, never scrolls
    await sleep(1200);
    await rowOf('photo.png').click();
    await page.waitForSelector('[data-testid=documents-tab] .imgv', { timeout: 15000 });
    await rowOf('notes.pdf').click();
    await page.waitForSelector('[data-testid=documents-tab] .pdfv-page[data-render=done]', { timeout: 15000 });
    await sleep(1500);
    const retained = await pdfState();
    check('B46: with the old query retained the remount still keeps page 2 / 200%', retained && retained.query === 'R1' && retained.page === 2 && Math.abs(retained.zoom - 2) < 0.001, retained);
    check('no page errors in the real app flow', pageErrors.filter(e => e.startsWith('[realapp]')).length === 0, pageErrors.filter(e => e.startsWith('[realapp]')).slice(0, 3));
    await page.close();
  },
};

(async () => {
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(scenarios);
  const server = await ensureServer();
  browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  try {
    for (const name of names) {
      if (!scenarios[name]) { console.error(`unknown scenario ${name}`); process.exitCode = 2; continue; }
      scenario = name;
      try { await scenarios[name](); } catch (error) { check('scenario completed without throwing', false, String(error && error.message || error).split('\n')[0]); }
    }
    scenario = 'all';
    const offenders = [];
    for (const file of fs.readdirSync(path.join(ROOT, 'src', 'components', 'workspace'))) if (/\.tsx?$/.test(file) && /\.localeCompare\(/.test(fs.readFileSync(path.join(ROOT, 'src', 'components', 'workspace', file), 'utf8'))) offenders.push(file);
    check('P02: no per-comparison localeCompare in the workspace panels (one shared Intl.Collator)', offenders.length === 0, offenders);
    check('no page errors across scenarios', pageErrors.filter(e => !e.includes('[realapp]')).length === 0, pageErrors.slice(0, 5));
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  process.exit(failed.length ? 1 : 0);
})();
