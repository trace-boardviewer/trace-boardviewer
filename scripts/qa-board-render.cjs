'use strict';

/*
 * Board canvas pixel captures and frame timing on harness/board-canvas.html (the canvas alone, real input events).
 *
 *   node scripts/qa-board-render.cjs --board=<file> [--board=<file> ...] [--out=<dir>]          capture every scenario
 *   node scripts/qa-board-render.cjs --board=<file> ... --compare=<dir of an earlier capture>    capture and compare pixel for pixel
 *   node scripts/qa-board-render.cjs --perf --board=<file> ... [--frames=120] [--fence]          frame timing instead of captures
 *
 * Options: --dsf=1,2 (device scale factors to capture, default 1,2 for captures and 1 for timing), --runtime=headless|electron (default
 * headless for captures: the Chromium headless shell rasterizes in software and is deterministic; electron for timing: the
 * application's Electron in a shown window with GPU raster), --url=<base> (a running dev server; default: start Vite on port 5287),
 * --label=<text> (recorded in the report), --runs=<n> (timing: repeat each board n times; the summary is the median of the runs),
 * --phases=<list> (timing: only these phases of first, pan-fit, zoom-fit, pan-detail, select-net, pan-fit-net, hover),
 * --scenarios=<list> (captures: only the named scenarios),
 * --profile (timing: a CPU profile of every phase next to the report and its functions with the most self time).
 *
 * Board files are only read from the given paths and served to the page by a local server on 127.0.0.1; they are never copied into
 * the output. The output holds the
 * exact RGBA of both canvases (gzip), PNGs to look at and manifest.json with a SHA-256 per canvas. --compare exits with code 1 when any
 * canvas differs in any byte and reports the number of differing pixels, the largest channel difference and the bounding box.
 *
 * Timing reports the time of every animation-frame callback that drew (the JavaScript side of a frame: drawing commands are recorded,
 * the GPU rasterizes them later; --fence adds a one-pixel read-back after each base frame to include the raster) and, per phase, the
 * time of each renderer layer of the base frames. Frame times on a loaded machine are noisy: compare medians of several runs.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium, _electron } = require(process.env.TRACE_PLAYWRIGHT_PATH || 'playwright');

const ROOT = path.resolve(__dirname, '..');
const VIEWPORT = { width: 1440, height: 960 };
const DEFAULT_PORT = 5287;
const FIRST_DRAW_MOUNTS = 5;

function parseArguments(argv) {
  const values = name => argv.filter(item => item.startsWith(`--${name}=`)).map(item => item.slice(name.length + 3));
  const value = name => values(name).at(-1);
  const boards = values('board').map(file => path.resolve(file));
  if (!boards.length) throw new Error('Give at least one --board=<file>.');
  for (const file of boards) if (!fs.existsSync(file)) throw new Error(`Board file not found: ${path.basename(file)}`);
  return {
    boards,
    perf: argv.includes('--perf'),
    fence: argv.includes('--fence'),
    runtime: value('runtime') ?? (argv.includes('--perf') ? 'electron' : 'headless'),
    frames: Number(value('frames') ?? 120),
    runs: Math.max(1, Number(value('runs') ?? 1)),
    dsf: (value('dsf') ?? (argv.includes('--perf') ? '1' : '1,2')).split(',').map(Number).filter(n => n > 0 && n <= 4),
    out: path.resolve(value('out') ?? path.join(ROOT, 'test-results', 'board-render', argv.includes('--perf') ? 'perf' : 'pixels')),
    compare: value('compare') ? path.resolve(value('compare')) : null,
    url: value('url') ?? null,
    label: value('label') ?? null,
    phases: value('phases') ? new Set(value('phases').split(',')) : null,
    scenarios: value('scenarios') ? new Set(value('scenarios').split(',')) : null,
    profile: argv.includes('--profile'),
  };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function reachable(url) { try { return (await fetch(url)).ok; } catch { return false; } }
async function ensureServer(base) {
  const page = `${base}/harness/board-canvas.html`;
  if (await reachable(page)) return null;
  const port = new URL(base).port;
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', port, '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 120; i++) { if (await reachable(page)) return child; await delay(250); }
  child.kill();
  throw new Error(`The dev server did not start at ${base}.`);
}
const tagOf = file => path.basename(file).replace(/[^A-Za-z0-9._-]+/g, '_');
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null;
  const round = n => (n === null ? null : Math.round(n * 1000) / 1000);
  return { n: sorted.length, mean: round(sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length)), p50: round(at(0.5)), p95: round(at(0.95)), max: round(at(1)) };
};

/** Serves board N of the list at /board/N to the harness page (another origin, so with an open CORS header). */
async function serveBoards(files) {
  const server = http.createServer((request, response) => {
    const index = Number((request.url ?? '').split('/').pop());
    const file = files[index];
    if (!/^\/board\/\d+$/.test(request.url ?? '') || !file) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: index => `http://127.0.0.1:${server.address().port}/board/${index}`, close: () => new Promise(resolve => server.close(resolve)) };
}

/** A minimal Electron main process: one shown window of the viewport size that loads the harness URL. */
const ELECTRON_MAIN = `'use strict';
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', process.env.TRACE_QA_DSF || '1');
for (const name of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(name);
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: ${VIEWPORT.width}, height: ${VIEWPORT.height}, useContentSize: true, show: true, autoHideMenuBar: true, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true } });
  win.setMenu(null);
  win.loadURL(process.env.TRACE_QA_PAGE);
});
app.on('window-all-closed', () => app.quit());
`;

async function openPage(options, dsf) {
  const pageUrl = `${options.base}/harness/board-canvas.html${options.perf ? '?strict=0' : ''}`;
  let page, close, version;
  if (options.runtime === 'electron') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-board-render-'));
    fs.writeFileSync(path.join(dir, 'main.cjs'), ELECTRON_MAIN);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'trace-board-render-qa', main: 'main.cjs' }));
    const executablePath = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
    const app = await _electron.launch({ executablePath, args: [dir, `--user-data-dir=${path.join(dir, 'profile')}`], env: { ...process.env, TRACE_QA_PAGE: pageUrl, TRACE_QA_DSF: String(dsf) }, timeout: 60000 });
    page = await app.firstWindow();
    version = await app.evaluate(async ({ app: electronApp }) => {
      const info = await electronApp.getGPUInfo('complete').catch(() => null);
      const renderer = info?.auxAttributes?.glRenderer ?? 'unknown GL renderer';
      return `Electron ${process.versions.electron} / Chrome ${process.versions.chrome} / ${renderer} / 2d_canvas ${electronApp.getGPUFeatureStatus()['2d_canvas']}`;
    });
    close = async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  } else if (options.runtime === 'headless') {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.TRACE_CHROMIUM || undefined, args: ['--force-color-profile=srgb'] });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: dsf });
    page = await context.newPage();
    version = `Chromium headless shell ${browser.version()}`;
    close = () => browser.close();
  } else throw new Error('--runtime must be headless or electron.');
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  if (page.url() !== pageUrl) await page.goto(pageUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__boardHarness);
  if (options.profile) {
    options.cdp = await page.context().newCDPSession(page);
    await options.cdp.send('Profiler.enable');
    await options.cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  }
  // The canvas fonts must be ready before the first draw: a canvas never repaints by itself when a font arrives later.
  await page.evaluate(async () => {
    await Promise.all(["600 11px 'IBM Plex Mono'", "600 13px 'IBM Plex Mono'", "500 12px 'IBM Plex Mono'", "10px 'IBM Plex Mono'"].map(font => document.fonts.load(font)));
    await document.fonts.ready;
  });
  return { page, errors, version, close };
}
const harness = (page, fn, arg) => page.evaluate(fn, arg);
async function loadBoard(page, options, index, file) {
  return harness(page, ({ url, name }) => window.__boardHarness.load(url, name), { url: options.boardUrl(index), name: path.basename(file) });
}

// ---------------------------------------------------------------------------------------------
// Pixel scenarios
// ---------------------------------------------------------------------------------------------

/** Each scenario mounts a fresh canvas (`show`), optionally drives it with real input, then both canvases are captured. */
function scenarios(picks) {
  const part = picks.largestPart, net = picks.largestNet, mid = picks.midNet ?? picks.largestNet, bottom = picks.bottomPart;
  const pinSelection = target => target ? { componentId: target.componentId, pinId: target.pinId, net: target.name } : {};
  const around = (bounds, grow) => ({ minX: bounds.minX - grow, minY: bounds.minY - grow, maxX: bounds.maxX + grow, maxY: bounds.maxY + grow });
  const list = [
    { id: 'fit-top-dark', show: {} },
    { id: 'fit-bottom-light', show: { side: 'bottom', theme: 'light' } },
    { id: 'fit-top-nolabels-light', show: { theme: 'light', showLabels: false } },
    { id: 'tiny-markers', camera: { factor: 0.35 }, show: {} },
  ];
  if (part) {
    list.push(
      { id: 'part-detail-selected', camera: { bounds: around(part.bounds, 4) }, show: { selection: { componentId: part.id } } },
      { id: 'part-deep-zoom', camera: { bounds: around(part.bounds, 0.5), factor: 2.5 }, show: { selection: { componentId: part.id } } },
      { id: 'part-hover', camera: { bounds: around(part.bounds, 6) }, show: {}, input: [{ move: part.center }] },
      { id: 'measure-two-points', camera: { bounds: around(part.bounds, 4) }, show: { measureMode: true }, input: [{ click: { x: part.bounds.minX, y: part.bounds.minY } }, { click: part.center }] },
      { id: 'measure-live-de', camera: { bounds: around(part.bounds, 4) }, show: { measureMode: true, language: 'de', theme: 'light' }, input: [{ click: part.center }, { move: { x: part.bounds.maxX, y: part.bounds.maxY } }] },
      { id: 'click-select', camera: { bounds: around(part.bounds, 4) }, show: {}, input: [{ click: part.center }] },
    );
  }
  if (mid) list.push({ id: 'net-mid-dashed', camera: { bounds: around(mid.bounds, 3) }, show: { selection: pinSelection(mid) } });
  if (net) {
    list.push(
      { id: 'net-largest-rot90', camera: { rotation: 90 }, show: { selection: pinSelection(net) } },
      { id: 'net-largest-bottom-nolines', camera: { side: 'bottom', rotation: 270 }, show: { side: 'bottom', showConnections: false, selection: pinSelection(net) } },
      { id: 'net-only-light-rot180', camera: { rotation: 180, factor: 2.2 }, show: { theme: 'light', selection: { net: net.name } } },
      // The view shows only part of the net: its lines are clipped (before and after a pan).
      { id: 'net-largest-zoomed', camera: { factor: 3 }, show: { selection: pinSelection(net) } },
      { id: 'net-largest-zoomed-drag', camera: { factor: 3, rotation: 90 }, show: { selection: pinSelection(net) }, input: [{ drag: { from: { x: 700, y: 480 }, by: { x: -160, y: 90 } } }] },
    );
  }
  if (bottom) list.push({ id: 'bottom-part-selected', camera: { side: 'bottom', bounds: around(bottom.bounds, 6) }, show: { side: 'bottom', selection: { componentId: bottom.id } } });
  list.push(
    { id: 'drag-pan', show: {}, input: [{ drag: { from: { x: 700, y: 480 }, by: { x: 137, y: -53 } } }] },
    { id: 'wheel-zoom', show: {}, input: [{ wheel: { at: { x: 820, y: 400 }, deltaY: -100, notches: 3 } }] },
    { id: 'command-rotate-zoom', show: {}, input: [{ command: 'rotate' }, { command: 'zoom-in' }] },
    { id: 'keys-arrow-pan', show: {}, input: [{ key: 'ArrowLeft' }, { key: 'ArrowUp' }] },
  );
  if (part) list.push({ id: 'command-center-selection', show: { selection: { componentId: part.id } }, input: [{ command: 'center-selection' }] });
  return list;
}

async function runInput(page, steps) {
  for (const step of steps ?? []) {
    if (step.move) {
      const p = await harness(page, point => window.__boardHarness.toScreen(point), step.move);
      await page.mouse.move(p.x, p.y);
    } else if (step.click) {
      const p = await harness(page, point => window.__boardHarness.toScreen(point), step.click);
      await page.mouse.click(p.x, p.y);
    } else if (step.drag) {
      const { from, by } = step.drag;
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + by.x * i / 8, from.y + by.y * i / 8);
      await page.mouse.up();
    } else if (step.wheel) {
      await page.mouse.move(step.wheel.at.x, step.wheel.at.y);
      for (let i = 0; i < step.wheel.notches; i++) { await page.mouse.wheel(0, step.wheel.deltaY); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r()))); }
    } else if (step.command) {
      await harness(page, type => window.__boardHarness.command(type), step.command);
    } else if (step.key) {
      await page.locator('canvas.board-canvas').focus();
      await page.keyboard.press(step.key);
    }
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  }
}

async function capturePixels(options) {
  const manifest = { kind: 'trace-board-render-pixels', label: options.label, startedAt: new Date().toISOString(), runtime: options.runtime, viewport: VIEWPORT, boards: [] };
  for (const dsf of options.dsf) {
    const { page, errors, version, close } = await openPage(options, dsf);
    manifest.browser = version;
    try {
      for (const [index, file] of options.boards.entries()) {
        const info = await loadBoard(page, options, index, file);
        const tag = `${tagOf(file)}@${dsf}x`;
        const entry = { tag, components: info.components, pins: info.pins, nets: info.nets, format: info.format, captures: [] };
        manifest.boards.push(entry);
        const dir = path.join(options.out, tag);
        fs.mkdirSync(dir, { recursive: true });
        for (const scenario of scenarios(info.picks).filter(scenario => !options.scenarios || options.scenarios.has(scenario.id))) {
          const camera = scenario.camera ? await harness(page, o => window.__boardHarness.fitCamera(o), scenario.camera) : null;
          await harness(page, () => { window.__boardHarness.callbacks.selectComponent.length = 0; window.__boardHarness.callbacks.selectPin.length = 0; });
          await harness(page, s => window.__boardHarness.show(s), { ...scenario.show, camera });
          await runInput(page, scenario.input);
          const shot = await harness(page, () => window.__boardHarness.capture({ png: true }));
          const callbacks = await harness(page, () => ({ component: [...window.__boardHarness.callbacks.selectComponent], pin: [...window.__boardHarness.callbacks.selectPin] }));
          const record = { id: scenario.id, callbacks, canvases: {} };
          for (const name of ['base', 'overlay']) {
            const raw = Buffer.from(shot[name].rgba, 'base64');
            fs.writeFileSync(path.join(dir, `${scenario.id}.${name}.rgba.gz`), zlib.gzipSync(raw, { level: 6 }));
            fs.writeFileSync(path.join(dir, `${scenario.id}.${name}.png`), Buffer.from(shot[name].png.split(',')[1], 'base64'));
            record.canvases[name] = { width: shot[name].width, height: shot[name].height, sha256: sha256(raw) };
          }
          entry.captures.push(record);
          console.log(`${tag} ${scenario.id}: base ${record.canvases.base.sha256.slice(0, 12)} overlay ${record.canvases.overlay.sha256.slice(0, 12)}${callbacks.component.length || callbacks.pin.length ? ` callbacks ${JSON.stringify(callbacks)}` : ''}`);
        }
      }
      manifest[`errors@${dsf}x`] = errors;
      if (errors.length) console.log(`page errors at ${dsf}x:\n  ${errors.join('\n  ')}`);
    } finally { await close(); }
  }
  fs.mkdirSync(options.out, { recursive: true });
  fs.writeFileSync(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function diffRaw(a, b, width) {
  let pixels = 0, maxDelta = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 4) {
    const delta = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
    if (!delta) continue;
    pixels++; maxDelta = Math.max(maxDelta, delta);
    const p = i / 4, x = p % width, y = Math.floor(p / width);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { pixels, maxDelta, sizeDiffers: a.length !== b.length, bbox: pixels ? { minX, minY, maxX, maxY } : null };
}

function compareManifests(options, current) {
  const earlier = JSON.parse(fs.readFileSync(path.join(options.compare, 'manifest.json'), 'utf8'));
  const result = { compared: 0, identical: 0, differing: [], missing: [], callbackMismatches: [] };
  for (const board of current.boards) {
    const other = earlier.boards.find(item => item.tag === board.tag);
    if (!other) { result.missing.push(board.tag); continue; }
    for (const capture of board.captures) {
      const previous = other.captures.find(item => item.id === capture.id);
      if (!previous) { result.missing.push(`${board.tag}/${capture.id}`); continue; }
      if (JSON.stringify(previous.callbacks) !== JSON.stringify(capture.callbacks)) result.callbackMismatches.push({ capture: `${board.tag}/${capture.id}`, before: previous.callbacks, after: capture.callbacks });
      for (const name of ['base', 'overlay']) {
        result.compared++;
        if (previous.canvases[name].sha256 === capture.canvases[name].sha256) { result.identical++; continue; }
        const a = zlib.gunzipSync(fs.readFileSync(path.join(options.compare, board.tag, `${capture.id}.${name}.rgba.gz`)));
        const b = zlib.gunzipSync(fs.readFileSync(path.join(options.out, board.tag, `${capture.id}.${name}.rgba.gz`)));
        result.differing.push({ capture: `${board.tag}/${capture.id}`, canvas: name, ...diffRaw(a, b, capture.canvases[name].width) });
      }
    }
  }
  fs.writeFileSync(path.join(options.out, 'comparison.json'), `${JSON.stringify({ against: path.basename(options.compare), ...result }, null, 2)}\n`);
  console.log(`compared ${result.compared} canvases: ${result.identical} identical, ${result.differing.length} differing, ${result.missing.length} missing, ${result.callbackMismatches.length} callback mismatches`);
  for (const item of result.differing) console.log(`  DIFF ${item.capture} ${item.canvas}: ${item.pixels} px, max channel delta ${item.maxDelta}, bbox ${JSON.stringify(item.bbox)}`);
  for (const item of result.callbackMismatches) console.log(`  CALLBACKS ${item.capture}: ${JSON.stringify(item.before)} -> ${JSON.stringify(item.after)}`);
  return result.differing.length === 0 && result.missing.length === 0 && result.callbackMismatches.length === 0;
}

// ---------------------------------------------------------------------------------------------
// Frame timing
// ---------------------------------------------------------------------------------------------

/** The functions with the most self time in a CPU profile (sampled every 0.1 ms), in ms. */
function topFunctions(profile, count = 14) {
  const self = new Map();
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  for (let i = 0; i < profile.samples.length; i++) {
    const frame = nodes.get(profile.samples[i])?.callFrame;
    if (!frame) continue;
    const name = `${frame.functionName || '(anonymous)'} ${frame.url ? `${path.basename(frame.url.split('?')[0])}:${frame.lineNumber + 1}` : ''}`.trim();
    self.set(name, (self.get(name) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([name, ms]) => ({ name, ms: Math.round(ms * 10) / 10 }));
}

async function measure(page, phase, work, fence, options = {}) {
  await harness(page, ({ phase, fence }) => window.__boardHarness.perf.reset(phase, fence), { phase, fence });
  if (options.cdp) await options.cdp.send('Profiler.start');
  const extra = await work();
  let profile = null;
  if (options.cdp) {
    ({ profile } = await options.cdp.send('Profiler.stop'));
    fs.mkdirSync(options.out, { recursive: true });
    fs.writeFileSync(path.join(options.out, `${options.label ?? 'perf'}-${options.profileTag}-${phase}.cpuprofile`), JSON.stringify(profile));
  }
  const frames = await harness(page, phase => window.__boardHarness.perf.frames().filter(frame => frame.phase === phase), phase);
  const base = frames.filter(frame => frame.base);
  // Renderer layer times of the base frames (a frame without a base render, or a canvas that reports none, counts as 0).
  const layerIds = [...new Set(base.flatMap(frame => Object.keys(frame.layers ?? {})))];
  const layers = Object.fromEntries(layerIds.map(id => [id, stats(base.map(frame => frame.layers?.[id] ?? 0))]));
  return {
    frames: frames.length, baseFrames: base.length, draw: stats(base.map(frame => frame.duration)),
    ...(fence ? { drawPlusFence: stats(base.map(frame => frame.duration + frame.fenceMs)) } : {}), layers,
    ...(profile ? { profileTop: topFunctions(profile) } : {}), ...(extra ?? {}),
  };
}

/** Median over the runs of each layer's p50 in each phase. */
function layerSummary(runs) {
  const result = {};
  for (const run of runs) for (const [phase, value] of Object.entries(run)) {
    for (const [id, layer] of Object.entries(value?.layers ?? {})) ((result[phase] ??= {})[id] ??= []).push(layer.p50);
  }
  for (const phase of Object.keys(result)) for (const id of Object.keys(result[phase])) result[phase][id] = median(result[phase][id]);
  return result;
}

/** The numbers a timing run is summarized by (the median over --runs). */
const SUMMARY = {
  firstDrawMs: r => r.firstDraw?.mountToFirstDrawEndMs,
  firstDrawCallbackMs: r => r.firstDraw?.firstDrawCallbackMs,
  panFitP50: r => r.panFit?.draw.p50, panFitP95: r => r.panFit?.draw.p95,
  zoomFitP50: r => r.zoomFit?.draw.p50, zoomFitP95: r => r.zoomFit?.draw.p95,
  panDetailP50: r => r.panDetail?.draw.p50, panDetailP95: r => r.panDetail?.draw.p95,
  selectNetMs: r => r.selectLargestNet?.draw.max,
  panFitNetP50: r => r.panFitNetSelected?.draw.p50, panFitNetP95: r => r.panFitNetSelected?.draw.p95,
  hoverHandlerP95: r => r.hover?.handler.p95,
  panFitFenceP95: r => r.panFit?.drawPlusFence?.p95, zoomFitFenceP95: r => r.zoomFit?.drawPlusFence?.p95,
};
const median = values => {
  const sorted = values.filter(value => typeof value === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return Math.round((sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) * 1000) / 1000;
};

async function perfBoard(page, options, index, file) {
  const info = await loadBoard(page, options, index, file);
  const center = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  const n = options.frames;
  const want = phase => !options.phases || options.phases.has(phase);
  options.profileTag = tagOf(file);
  const once = async () => {
    const result = {};
    // First draw: the median of FIRST_DRAW_MOUNTS fresh mounts (each builds the board scene and draws it once).
    const shots = [];
    for (let i = 0; i < (want('first') ? FIRST_DRAW_MOUNTS : 1); i++) shots.push(await harness(page, s => window.__boardHarness.show(s, { phase: 'first' }), {}));
    if (want('first')) result.firstDraw = { mountToFirstDrawEndMs: median(shots.map(shot => shot.firstDrawMs)), firstDrawCallbackMs: median(shots.map(shot => shot.firstDrawCallbackMs)), mounts: shots.length };
    if (want('pan-fit')) result.panFit = await measure(page, 'pan-fit', () => harness(page, ({ at, n }) => window.__boardHarness.perf.pan(at, { x: 3, y: 2 }, n), { at: center, n }), options.fence, options);
    if (want('zoom-fit')) {
      result.zoomFit = await measure(page, 'zoom-fit', async () => {
        for (let i = 0; i < n; i++) await harness(page, ({ at, d }) => window.__boardHarness.perf.wheel(at, d, 1), { at: center, d: i % 2 ? 100 : -100 });
      }, options.fence, options);
    }
    if (want('pan-detail')) {
      const detail = await harness(page, () => window.__boardHarness.fitCamera({ zoom: 20 }));
      await harness(page, s => window.__boardHarness.show(s), { camera: detail });
      result.panDetail = await measure(page, 'pan-detail', () => harness(page, ({ at, n }) => window.__boardHarness.perf.pan(at, { x: 3, y: 2 }, n), { at: center, n }), options.fence, options);
    }
    const net = info.picks.largestNet;
    if (net && (want('select-net') || want('pan-fit-net'))) {
      await harness(page, s => window.__boardHarness.show(s), {});
      const selection = { componentId: net.componentId, pinId: net.pinId, net: net.name };
      if (want('select-net')) result.selectLargestNet = await measure(page, 'select-net', () => harness(page, s => window.__boardHarness.update(s), { selection }), options.fence, options);
      else await harness(page, s => window.__boardHarness.update(s), { selection });
      if (want('pan-fit-net')) result.panFitNetSelected = await measure(page, 'pan-fit-net', () => harness(page, ({ at, n }) => window.__boardHarness.perf.pan(at, { x: -3, y: 2 }, n), { at: center, n }), options.fence, options);
    }
    const part = info.picks.largestPart;
    if (part && want('hover')) {
      const camera = await harness(page, b => window.__boardHarness.fitCamera({ bounds: b }), { minX: part.bounds.minX - 8, minY: part.bounds.minY - 8, maxX: part.bounds.maxX + 8, maxY: part.bounds.maxY + 8 });
      await harness(page, s => window.__boardHarness.show(s), { camera });
      const points = await harness(page, ({ part, n }) => Array.from({ length: n }, (_, i) => window.__boardHarness.toScreen({
        x: part.bounds.minX + (part.bounds.maxX - part.bounds.minX) * ((i * 37) % 101) / 100,
        y: part.bounds.minY + (part.bounds.maxY - part.bounds.minY) * ((i * 53) % 103) / 102,
      })), { part, n: Math.min(n, 80) });
      let handler = [];
      result.hover = await measure(page, 'hover', async () => { handler = await harness(page, p => window.__boardHarness.perf.hover(p), points); }, false, options);
      result.hover.handler = stats(handler);
    }
    return result;
  };
  const runs = [];
  for (let run = 0; run < options.runs; run++) runs.push(await once());
  const summary = Object.fromEntries(Object.entries(SUMMARY).map(([key, read]) => [key, median(runs.map(read))]));
  return { board: { file: path.basename(file), components: info.components, pins: info.pins, nets: info.nets, parseMs: Math.round(info.parseMs) }, summary, layersP50: layerSummary(runs), runs };
}

async function runPerf(options) {
  const report = { kind: 'trace-board-render-perf', label: options.label, startedAt: new Date().toISOString(), runtime: options.runtime, viewport: VIEWPORT, dsf: options.dsf[0] ?? 1, frames: options.frames, runs: options.runs, fence: options.fence, boards: [] };
  const { page, errors, version, close } = await openPage(options, options.dsf[0] ?? 1);
  report.browser = version;
  try {
    for (const [index, file] of options.boards.entries()) {
      const result = await perfBoard(page, options, index, file);
      report.boards.push(result);
      const s = result.summary;
      const f = value => (value === null || value === undefined ? '-' : value.toFixed(2));
      console.log(`${result.board.file} (${result.board.pins} pins, median of ${options.runs}): first draw ${f(s.firstDrawMs)} ms (callback ${f(s.firstDrawCallbackMs)}) | pan fit p50 ${f(s.panFitP50)} p95 ${f(s.panFitP95)} | zoom fit p50 ${f(s.zoomFitP50)} p95 ${f(s.zoomFitP95)} | pan detail p50 ${f(s.panDetailP50)} p95 ${f(s.panDetailP95)} | select net ${f(s.selectNetMs)} | pan fit+net p50 ${f(s.panFitNetP50)} p95 ${f(s.panFitNetP95)} | hover handler p95 ${f(s.hoverHandlerP95)}${options.fence ? ` | fence p95 pan ${f(s.panFitFenceP95)} zoom ${f(s.zoomFitFenceP95)}` : ''}`);
      for (const [phase, layers] of Object.entries(result.layersP50)) {
        console.log(`  ${phase} layer p50: ${Object.entries(layers).map(([id, ms]) => `${id} ${f(ms)}`).join(', ')}`);
      }
      for (const [phase, value] of Object.entries(result.runs.at(-1))) {
        if (value?.profileTop) console.log(`  ${phase} self time (last run): ${value.profileTop.slice(0, 10).map(item => `${item.name} ${item.ms}`).join(' | ')}`);
      }
    }
    report.errors = errors;
    if (errors.length) console.log(`page errors:\n  ${errors.join('\n  ')}`);
  } finally { await close(); }
  fs.mkdirSync(options.out, { recursive: true });
  const file = path.join(options.out, `${options.label ?? 'perf'}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${file}`);
  return report;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  options.base = options.url ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  const server = await ensureServer(options.base);
  const boards = await serveBoards(options.boards);
  options.boardUrl = boards.url;
  try {
    if (options.perf) { await runPerf(options); return 0; }
    const manifest = await capturePixels(options);
    const errors = Object.entries(manifest).filter(([key, value]) => key.startsWith('errors@') && value.length);
    if (options.compare) return compareManifests(options, manifest) && !errors.length ? 0 : 1;
    return errors.length ? 1 : 0;
  } finally { await boards.close(); server?.kill(); }
}

main().then(code => { process.exitCode = code; }, error => { console.error(error); process.exitCode = 1; });
