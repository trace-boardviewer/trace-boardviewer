'use strict';

/*
 * Synthetic benchmark of the real application on generated boards (no private board needed). Run through qa-performance:
 *
 *   node scripts/qa-performance.cjs --synthetic=100k                  one size, the production Electron shell (default)
 *   node scripts/qa-performance.cjs --synthetic=all                   10k, 50k, 100k, 250k and 1m pins
 *   node scripts/qa-performance.cjs --synthetic=100k --runtime=browser  Chromium over the built dist/ (headless unless --headed)
 *
 * Options: --out=<dir> (report, screenshots; default test-results/performance-synthetic), --label=<name> (default synthetic-<runtime>),
 *          --seed=<n>, --board-dir=<dir> (generated boards are cached there), --budget=<file> | --no-budget, --strict (exit code 1 when a
 *          budget fails), --quick (a quarter of the interaction samples), --no-fence, --no-screenshots, --url=<url> (browser runtime: a running
 *          server instead of dist/), --dsf=<n> (device scale factor, default 1), --flag=<chromium switch> (repeatable, for example
 *          --flag=--disable-gpu for software rendering), --revision=<text> (recorded in the report; the git revision when git is on the PATH),
 *          --wait-quiet=<seconds> (before each size wait up to that long for the machine to be idle), --conditions=<text> (how the machine
 *          was when measuring, for example "under load, indicative"; without it the report says "quiet" or "under load, indicative" from the
 *          measured load).
 *
 * Conditions: frame times depend on what else the machine runs. Each size records the processor share of the other programs (before, after and
 * during the run), the number of other node, electron and browser processes and the free memory (perf-host.cjs); the report carries the
 * conditions as one label. A baseline for comparison is taken on a quiet machine: node scripts/qa-performance.cjs --synthetic=all
 * --label=baseline --wait-quiet=300 (npm run bench:baseline). Besides <label>.json the run writes <label>.md (perf-report.cjs: tables,
 * budgets, and "--compare=<earlier.json>" for two reports).
 *
 * The application is the production build (dist/): build it first with `node node_modules/vite/bin/vite.js build`. Each size runs in
 * a fresh application process with an isolated profile. Measured per size: open to first paint (split into reading, worker parse and
 * transfer, scene build and first draw), idle draws, pan and zoom frames at fit and at about 20 px/mm (draw callback time, frame
 * cadence, long tasks), hover handler time, search keystroke latency, selecting the GND net, the frames with that net selected, JS heap
 * and process memory, and (per-frame raster fence) the cost of a frame including the raster work the draw callback leaves to the GPU.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const generator = require('./gen-synthetic-board.cjs');
const budgets = require('./perf-budget.cjs');
const host = require('./perf-host.cjs');
const reports = require('./perf-report.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'test-results', 'performance-synthetic');
const DEFAULT_BUDGET = path.join(ROOT, 'config', 'perf-budget.json');
const VIEWPORT = { width: 1440, height: 960 };
const REPORT_SCHEMA = 1;
const FIT_PADDING = 60; // src/lib/geometry.ts fitView
const WHEEL_STEP = 100; // deltaY of one wheel notch; the camera zooms by exp(0.0016 * delta) per notch
const WHEEL_FACTOR = Math.exp(0.0016 * WHEEL_STEP);
const DETAIL_PX_PER_MM = 20;
const SETTINGS = Object.freeze({ language: 'en', theme: 'dark', layout: 'workshop', motion: false, showLabels: true, showConnections: true });
const CHROMIUM_FLAGS = ['--enable-precise-memory-info', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Text that goes into a report carries no local paths (repository, home directory, temp directory). */
const scrub = value => [[os.tmpdir(), '<tmp>'], [ROOT, '<repo>'], [os.homedir(), '~']]
  .reduce((text, [from, to]) => text.split(from).join(to).split(from.split('\\').join('/')).join(to), String(value))
  .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s'"]+/g, '~');

// ---------------------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------------------

function parseArguments(argv) {
  const value = name => { const hit = argv.find(item => item === `--${name}` || item.startsWith(`--${name}=`)); return hit === undefined ? undefined : hit.includes('=') ? hit.slice(name.length + 3) : ''; };
  const flag = name => argv.includes(`--${name}`);
  const synthetic = value('synthetic');
  const sizeText = synthetic === undefined ? [] : synthetic === '' ? ['100k'] : synthetic === 'all' ? Object.keys(generator.SIZES) : synthetic.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  const sizes = sizeText.map(label => {
    if (!Object.hasOwn(generator.SIZES, label)) throw new RangeError(`--synthetic: "${label}" is not one of ${Object.keys(generator.SIZES).join(', ')} or all.`);
    return label;
  });
  const runtime = value('runtime') ?? 'electron';
  if (!['electron', 'browser'].includes(runtime)) throw new RangeError('--runtime must be electron or browser.');
  const seed = value('seed') === undefined ? 1 : Number(value('seed'));
  if (!Number.isInteger(seed) || seed < 0) throw new RangeError('--seed must be a non-negative integer.');
  const dsf = value('dsf') === undefined ? 1 : Number(value('dsf'));
  if (!(dsf > 0 && dsf <= 4)) throw new RangeError('--dsf must be a number above 0 and up to 4.');
  const waitQuiet = value('wait-quiet') === undefined ? 0 : Number(value('wait-quiet'));
  if (!(waitQuiet >= 0 && waitQuiet <= 3600)) throw new RangeError('--wait-quiet must be a number of seconds from 0 to 3600.');
  return {
    sizes, runtime, seed, dsf, quick: flag('quick'), fence: !flag('no-fence'), strict: flag('strict'), headed: flag('headed'), screenshots: !flag('no-screenshots'),
    out: path.resolve(value('out') || DEFAULT_OUT), label: value('label') || `synthetic-${runtime}`, boardDir: path.resolve(value('board-dir') || generator.DEFAULT_DIR),
    budget: flag('no-budget') ? null : path.resolve(value('budget') || DEFAULT_BUDGET), url: value('url') || process.env.TRACE_QA_URL || null,
    waitQuiet, conditions: (value('conditions') || '').trim() || null,
    flags: argv.filter(item => item.startsWith('--flag=')).map(item => item.slice(7)), revision: value('revision') || null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Page-side instrumentation (serialized into the page: it must not use anything from this file)
// ---------------------------------------------------------------------------------------------------------------

function instrument() {
  window.__TRACE_SUPPORT_NOTICE__ = 'off'; // the product's own switch for automation: no start-up dialog over the board
  const perf = { frames: [], longTasks: [], pointer: [], keys: [], clicks: [], windows: {}, marks: {}, heap: [], phase: 'boot', fence: false, board: null, lastBoard: null, resultMutationAt: 0, arm: false };
  window.__benchPerf = perf;
  const nativeRAF = window.requestAnimationFrame.bind(window);
  let current = null;
  window.requestAnimationFrame = callback => nativeRAF(timestamp => {
    const frame = { phase: perf.phase, t: timestamp, start: performance.now(), end: 0, duration: 0, base: false, overlay: false, fenceMs: 0 };
    const prior = current;
    current = frame;
    try { callback(timestamp); } finally {
      current = prior;
      frame.end = performance.now();
      frame.duration = frame.end - frame.start;
      if (frame.base || frame.overlay) {
        if (frame.base && perf.fence) {
          const canvas = document.querySelector('canvas.board-canvas');
          if (canvas) { const context = canvas.getContext('2d'); const f0 = performance.now(); context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1); frame.fenceMs = performance.now() - f0; }
        }
        perf.frames.push(frame);
        const marks = perf.marks;
        if (frame.base && marks.openAt !== undefined && marks.boardAt !== undefined && marks.firstDrawEnd === undefined) {
          marks.firstDrawStart = frame.start; marks.firstDrawEnd = frame.end; marks.firstDrawCallbackMs = frame.duration;
          nativeRAF(() => { marks.firstPaintAt = performance.now(); });
        }
      }
    }
  });
  // A base redraw sets the transform on the board canvas, an overlay redraw on the overlay canvas (BoardCanvas.tsx draw).
  const prototype = CanvasRenderingContext2D.prototype;
  const nativeSetTransform = prototype.setTransform;
  prototype.setTransform = function (...args) {
    if (current) { if (this.canvas.className === 'board-canvas') current.base = true; else current.overlay = true; }
    return nativeSetTransform.apply(this, args);
  };
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) perf.longTasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: true }); } catch { /* not available */ }

  // The parser worker: when the file reaches it and when the parsed board arrives back (parse + structured clone out and in).
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      const post = this.postMessage.bind(this);
      this.postMessage = (message, ...rest) => {
        if (perf.arm && message && message.data instanceof Uint8Array && perf.marks.parseSentAt === undefined) { perf.marks.parseSentAt = performance.now(); perf.marks.fileBytes = message.data.byteLength; }
        return post(message, ...rest);
      };
      this.addEventListener('message', event => {
        if (perf.arm && event.data && event.data.board && perf.marks.parseSentAt !== undefined && perf.marks.boardAt === undefined) {
          perf.marks.boardAt = performance.now();
          const board = event.data.board;
          perf.lastBoard = board;
          perf.board = { components: board.components.length, pins: board.pins.length, nets: board.nets.length };
        }
      });
    }
  };

  // The moment the user opens a board: the click on an open button (desktop shell) or the file input change (browser).
  const armOpen = () => { if (perf.arm && perf.marks.openAt === undefined) perf.marks.openAt = performance.now(); };
  document.addEventListener('click', event => { if (event.target && event.target.closest && event.target.closest('[data-testid="welcome-open"], [data-testid="open-board"]')) armOpen(); }, true);
  document.addEventListener('change', event => { if (event.target && event.target.matches && event.target.matches('input[type="file"]')) armOpen(); }, true);
  document.addEventListener('pointerdown', () => { perf.clicks.push({ t: performance.now(), phase: perf.phase }); }, true);
  document.addEventListener('keydown', event => {
    const entry = { t: performance.now(), key: event.key, phase: perf.phase, paintAt: 0 };
    perf.keys.push(entry);
    nativeRAF(() => setTimeout(() => { entry.paintAt = performance.now(); }, 0));
  }, true);
  try {
    new MutationObserver(records => {
      for (const record of records) {
        const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (element && element.closest && element.closest('.search-panel') && !element.closest('.search-field')) { perf.resultMutationAt = performance.now(); perf.mutations = (perf.mutations || 0) + 1; return; }
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  } catch { /* not available */ }

  // pointermove handlers: the time of every listener, grouped by event time stamp afterwards (React's root listener holds the hover hit test).
  const nativeAdd = EventTarget.prototype.addEventListener, nativeRemove = EventTarget.prototype.removeEventListener;
  const wrapped = new WeakMap();
  const captureOf = options => (typeof options === 'boolean' ? options : !!(options && options.capture));
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'pointermove' && typeof listener === 'function') {
      let byCapture = wrapped.get(listener);
      if (!byCapture) { byCapture = new Map(); wrapped.set(listener, byCapture); }
      const key = captureOf(options) ? 1 : 0;
      let wrapper = byCapture.get(key);
      if (!wrapper) {
        wrapper = function (event) {
          const start = performance.now();
          try { return listener.call(this, event); } finally { if (perf.phase.startsWith('hover')) perf.pointer.push({ phase: perf.phase, ts: event.timeStamp, ms: performance.now() - start }); }
        };
        byCapture.set(key, wrapper);
      }
      return nativeAdd.call(this, type, wrapper, options);
    }
    return nativeAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (type === 'pointermove' && typeof listener === 'function') {
      const wrapper = wrapped.get(listener)?.get(captureOf(options) ? 1 : 0);
      if (wrapper) return nativeRemove.call(this, type, wrapper, options);
    }
    return nativeRemove.call(this, type, listener, options);
  };

  setInterval(() => {
    const memory = performance.memory;
    if (memory && perf.marks.openAt !== undefined && (perf.marks.firstPaintAt === undefined || performance.now() - perf.marks.firstPaintAt < 1500)) perf.heap.push(memory.usedJSHeapSize);
  }, 100);

  perf.begin = (name, fence) => { perf.phase = name; perf.fence = !!fence; perf.windows[name] = [performance.now(), 0]; };
  perf.finish = name => { const window_ = perf.windows[name]; if (window_) window_[1] = performance.now(); perf.phase = 'between'; perf.fence = false; };
  perf.collect = name => {
    const range = perf.windows[name] || [0, performance.now()];
    return {
      range,
      frames: perf.frames.filter(frame => frame.phase === name),
      longTasks: perf.longTasks.filter(task => task.start >= range[0] && task.start <= range[1] + 50),
      pointer: perf.pointer.filter(entry => entry.phase === name),
    };
  };
  perf.cloneMs = rounds => {
    if (!perf.lastBoard) return null;
    let best = Infinity;
    try { for (let i = 0; i < rounds; i++) { const t0 = performance.now(); structuredClone(perf.lastBoard); best = Math.min(best, performance.now() - t0); } } catch { return null; }
    return best;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Application sessions
// ---------------------------------------------------------------------------------------------------------------

async function serveDist() {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('dist/index.html not found: build the production app first (node node_modules/vite/bin/vite.js build).');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };
  const server = http.createServer((request, response) => {
    const target = path.join(dist, path.normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname)).replace(/^([\\/]+)/, ''));
    const file = target.endsWith(path.sep) || (fs.existsSync(target) && fs.statSync(target).isDirectory()) ? path.join(target, 'index.html') : target;
    if (!file.startsWith(dist) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => server.close(resolve)) };
}

function watchPage(page, session) {
  page.on('pageerror', error => session.pageErrors.push(scrub(error.message || error).slice(0, 300)));
  page.on('console', message => { if (message.type() === 'error') session.consoleErrors.push(scrub(message.text()).slice(0, 300)); });
  page.on('crash', () => { session.crashed = true; });
}

/** The Electron binary of this checkout; never require('electron') here, its index.js downloads a missing binary. */
function electronExecutable() {
  const directory = path.dirname(require.resolve('electron/package.json'));
  const executable = path.join(directory, 'dist', fs.readFileSync(path.join(directory, 'path.txt'), 'utf8').trim());
  if (!fs.existsSync(executable)) throw new Error('The Electron binary is not installed in this checkout (node_modules/electron/dist).');
  return executable;
}

async function startElectron(options) {
  const { _electron } = require('playwright');
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'trace-bench-profile-'));
  await fsp.writeFile(path.join(profile, 'config.json'), JSON.stringify({ version: 1, settings: { ...SETTINGS, updateCheck: false }, recentBoards: [] }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  const app = await _electron.launch({
    executablePath: electronExecutable(), env, timeout: 90_000,
    args: [ROOT, `--user-data-dir=${profile}`, `--force-device-scale-factor=${options.dsf}`, ...CHROMIUM_FLAGS, ...options.flags],
  });
  const session = { kind: 'electron', pageErrors: [], consoleErrors: [], crashed: false };
  try {
    const page = await app.firstWindow();
    watchPage(page, session);
    await app.evaluate(({ BrowserWindow }, size) => { const window_ = BrowserWindow.getAllWindows()[0]; if (window_.isMaximized()) window_.unmaximize(); window_.setContentSize(size.width, size.height); window_.show(); window_.focus(); }, VIEWPORT);
    // The application's own first load must be over before the instrumented reload, or the two navigations cancel each other.
    await page.getByTestId('welcome').waitFor({ timeout: 60_000 });
    await delay(1000);
    await app.context().addInitScript(instrument);
    for (let attempt = 1; ; attempt++) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }); await page.getByTestId('welcome').waitFor({ timeout: 30_000 }); break; }
      catch (error) { if (attempt >= 3) throw error; await delay(1500); }
    }
    if (!(await page.evaluate(() => !!window.__benchPerf))) throw new Error('The instrumentation did not load into the application page.');
    Object.assign(session, {
      page, app,
      cdp: await page.context().newCDPSession(page),
      openBoard: async file => {
        await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, file);
        await page.evaluate(() => { window.__benchPerf.arm = true; });
        await page.getByTestId('welcome-open').click();
      },
      // Processor seconds all application processes have used (the benchmark's own share of the machine's load).
      ownCpuSeconds: async () => app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().reduce((sum, metric) => sum + (metric.cpu?.cumulativeCPUUsage ?? 0), 0)),
      processMetrics: async () => app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map(metric => ({ type: metric.type, pid: metric.pid, workingSetKB: metric.memory.workingSetSize, peakWorkingSetKB: metric.memory.peakWorkingSetSize, privateKB: metric.memory.privateBytes ?? 0 }))),
      machine: async () => app.evaluate(async ({ app: electronApp }) => {
        const info = await electronApp.getGPUInfo('complete').catch(() => null);
        const attributes = info?.auxAttributes ?? {};
        return {
          electron: process.versions.electron, chrome: process.versions.chrome,
          gpuFeatureStatus: electronApp.getGPUFeatureStatus(),
          glRenderer: attributes.glRenderer ?? null, glVendor: attributes.glVendor ?? null,
          gpuDevices: (info?.gpuDevice ?? []).map(device => ({ vendorId: device.vendorId, deviceId: device.deviceId, active: !!device.active, driverVersion: device.driverVersion, vendorString: device.vendorString, deviceString: device.deviceString })),
        };
      }),
      close: async () => {
        await Promise.race([app.close().catch(() => {}), delay(15_000)]);
        try { app.process().kill(); } catch { /* already gone */ }
        await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
      },
    });
    return session;
  } catch (error) { try { await app.close(); } catch { /* ignore */ } await fsp.rm(profile, { recursive: true, force: true }).catch(() => {}); throw error; }
}

async function startBrowser(options) {
  const { chromium } = require('playwright');
  const served = options.url ? null : await serveDist();
  const browser = await chromium.launch({ headless: !options.headed, args: [...CHROMIUM_FLAGS, `--force-device-scale-factor=${options.dsf}`, ...options.flags], ...(process.env.TRACE_BROWSER_CHANNEL ? { channel: process.env.TRACE_BROWSER_CHANNEL } : {}) });
  const session = { kind: 'browser', pageErrors: [], consoleErrors: [], crashed: false };
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: options.dsf });
    await context.addInitScript(settings => { localStorage.setItem('trace-settings', JSON.stringify(settings)); }, SETTINGS);
    await context.addInitScript(instrument);
    const page = await context.newPage();
    watchPage(page, session);
    await page.goto(options.url || served.url, { waitUntil: 'load' });
    await page.getByTestId('welcome').waitFor({ timeout: 60_000 });
    Object.assign(session, {
      page, browser,
      cdp: await context.newCDPSession(page),
      openBoard: async file => {
        await page.evaluate(() => { window.__benchPerf.arm = true; });
        await page.getByTestId('board-file-input').setInputFiles(file);
      },
      processMetrics: async () => null,
      ownCpuSeconds: async () => {
        const info = await browser.newBrowserCDPSession().then(connection => connection.send('SystemInfo.getProcessInfo')).catch(() => null);
        return info && Array.isArray(info.processInfo) ? info.processInfo.reduce((sum, item) => sum + (item.cpuTime || 0), 0) : null;
      },
      machine: async () => {
        // SystemInfo is a browser-level domain: it is not reachable from the page's own session.
        const info = await browser.newBrowserCDPSession().then(connection => connection.send('SystemInfo.getInfo')).catch(() => null);
        return {
          chrome: browser.version(), headless: !options.headed,
          gpuFeatureStatus: info?.featureStatus ?? null,
          glRenderer: info?.gpu?.auxAttributes?.glRenderer ?? null, glVendor: info?.gpu?.auxAttributes?.glVendor ?? null,
          gpuDevices: (info?.gpu?.devices ?? []).map(device => ({ vendorId: device.vendorId, deviceId: device.deviceId, vendorString: device.vendorString, deviceString: device.deviceString, driverVersion: device.driverVersion })),
        };
      },
      close: async () => { await browser.close().catch(() => {}); if (served) await served.close(); },
    });
    return session;
  } catch (error) { await browser.close().catch(() => {}); if (served) await served.close(); throw error; }
}

// ---------------------------------------------------------------------------------------------------------------
// Measuring one board
// ---------------------------------------------------------------------------------------------------------------

const mb = bytes => Math.round(bytes / 1048576 * 10) / 10;
const kbToMb = kb => Math.round(kb / 1024 * 10) / 10;

/**
 * Statistics of one phase. `draw` is the time of the animation-frame callback that redraws the board (what the page's JavaScript pays).
 * The Canvas2D work the callback only records (rasterization on the GPU) is not in it; the fenced phases add it: `raster` is the wait for
 * the pixels, `total` the callback plus that wait, the cost of one frame. `interval` is the time between two redrawn frames: the achieved
 * frame time when the input is faster than the frames, otherwise the input cadence.
 */
function frameStats(collected) {
  const base = collected.frames.filter(frame => frame.base);
  const intervals = base.slice(1).map((frame, index) => frame.t - base[index].t);
  const seconds = Math.max(0.001, (collected.range[1] - collected.range[0]) / 1000);
  const out = {
    frames: base.length,
    framesPerSecond: Math.round(base.length / seconds * 10) / 10,
    draw: budgets.stats(base.map(frame => frame.duration)),
    interval: budgets.stats(intervals),
    longTasks: { count: collected.longTasks.length, totalMs: Math.round(collected.longTasks.reduce((sum, task) => sum + task.duration, 0)), maxMs: Math.round(Math.max(0, ...collected.longTasks.map(task => task.duration))) },
  };
  if (collected.fenced) {
    out.raster = budgets.stats(base.map(frame => frame.fenceMs));
    out.total = budgets.stats(base.map(frame => frame.duration + frame.fenceMs));
  }
  return out;
}

async function measureBoard(options, label, log) {
  const pins = generator.SIZES[label];
  const { file, summary, reused } = generator.ensureBoard(options.boardDir, { pins, seed: options.seed });
  log(`${label}: board ${path.basename(file)} (${(summary.bytes / 1048576).toFixed(1)} MiB, ${summary.components} parts, ${summary.nets} nets${reused ? ', reused' : ', generated'})`);
  const result = {
    size: label, status: 'failed', pins: summary.pins,
    board: { file: path.basename(file), seed: summary.seed, generatorVersion: summary.version, bytes: summary.bytes, components: summary.components, nets: summary.nets, widthMm: summary.board.widthMm, heightMm: summary.board.heightMm, gndShare: Number(summary.netStats.gndShare.toFixed(3)) },
  };
  if (options.waitQuiet > 0) {
    const waited = await host.waitUntilQuiet(options.waitQuiet);
    log(`${label}: ${waited.quiet ? 'machine quiet' : 'machine still busy'} after ${waited.waitedS} s (${waited.lastPercent} % busy)`);
    result.waitedForQuiet = { seconds: waited.waitedS, reached: waited.quiet };
  }
  result.host = { logicalCpus: os.cpus().length, before: { cpuBusyPercent: await host.sampleBusyPercent(1000), freeMemoryGB: freeMemoryGB(), processes: await host.otherProcesses() } };
  const meter = host.startLoadMeter();
  const session = options.runtime === 'electron' ? await startElectron(options) : await startBrowser(options);
  const { page, cdp } = session;
  const framesTarget = options.quick ? 25 : 100; // redrawn frames wanted per sampled phase (rounds of input repeat until reached or the time is up)
  const board = { width: summary.board.widthMm, height: summary.board.heightMm };
  const probe = summary.probe;
  page.setDefaultTimeout(Math.max(30_000, pins * 0.2)); // a frame of a big board takes seconds; Playwright waits for the page between actions
  try {
    // --- helpers: a phase is a named window of the page's frame log; `sample` repeats an input round until enough frames were redrawn
    const sample = async (name, round, { fence = false, minFrames = framesTarget, maxMs = pins >= 500_000 ? 45_000 : pins >= 200_000 ? 30_000 : 20_000, settle = 250 } = {}) => {
      await page.evaluate(([n, f]) => window.__benchPerf.begin(n, f), [name, fence]);
      const started = Date.now();
      for (let rounds = 1; rounds <= 12; rounds++) {
        await round();
        const frames = await page.evaluate(n => window.__benchPerf.frames.filter(frame => frame.phase === n && frame.base).length, name);
        if (frames >= minFrames || Date.now() - started > maxMs) break;
      }
      await drain(settle);
      await page.evaluate(n => window.__benchPerf.finish(n), name);
      const collected = await page.evaluate(n => window.__benchPerf.collect(n), name);
      collected.fenced = fence;
      return collected;
    };
    // Waits until the page has stopped redrawing (no frame for a while, longer after a slow frame): input still queued must not fall into the next phase.
    const drain = async (minimumMs = 250) => {
      await delay(minimumMs);
      await page.waitForFunction(() => { const frames = window.__benchPerf.frames; const last = frames[frames.length - 1]; return !last || performance.now() - last.end > Math.max(500, last.duration * 3 + 200); }, null, { timeout: 120_000, polling: 100 }).catch(() => {});
    };
    const canvasBox = () => page.locator('canvas.board-canvas').boundingBox();
    const fit = async () => { await page.getByRole('button', { name: 'Fit board', exact: true }).click(); await drain(300); };
    const zoomPercent = async () => Number((await page.getByTestId('zoom-value').innerText()).replace(/[^\d.]/g, ''));
    const quiet = (ms, timeout = Math.max(8000, pins * 0.06)) => page.waitForFunction(([quietMs]) => performance.now() - window.__benchPerf.resultMutationAt > quietMs, [ms], { timeout, polling: 50 }).catch(() => {});
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage').catch(() => {}); const usage = await cdp.send('Runtime.getHeapUsage'); return { usedMB: mb(usage.usedSize), totalMB: mb(usage.totalSize) }; };
    const processSummary = async () => {
      const processes = await session.processMetrics();
      if (!processes) return null;
      const sum = (type, key) => kbToMb(processes.filter(item => item.type === type).reduce((total, item) => total + item[key], 0));
      return { rendererWorkingSetMB: sum('Tab', 'workingSetKB'), rendererPeakWorkingSetMB: sum('Tab', 'peakWorkingSetKB'), rendererPrivateMB: sum('Tab', 'privateKB'), gpuWorkingSetMB: sum('GPU', 'workingSetKB'), totalWorkingSetMB: kbToMb(processes.reduce((total, item) => total + item.workingSetKB, 0)) };
    };
    const pointerStats = collected => {
      const byEvent = new Map();
      for (const entry of collected.pointer) byEvent.set(entry.ts, (byEvent.get(entry.ts) || 0) + entry.ms);
      return budgets.stats([...byEvent.values()]);
    };

    result.machine = await session.machine();
    // --- load
    const loadTimeout = 120_000 + pins * 0.7;
    await session.openBoard(file);
    const loadStarted = Date.now();
    for (;;) {
      if (session.crashed) throw new Error('The renderer crashed while loading the board.');
      const state = await page.evaluate(() => ({ paint: window.__benchPerf.marks.firstPaintAt !== undefined, toast: document.querySelector('.toast.error, [data-testid="toast"]')?.textContent ?? '' }));
      if (state.paint) break;
      if (/fail|error|invalid|large|memory/i.test(state.toast)) throw new Error(`The application refused the board: ${state.toast.slice(0, 200)}`);
      if (Date.now() - loadStarted > loadTimeout) throw new Error(`No first paint within ${Math.round(loadTimeout / 1000)} s.`);
      await delay(250);
    }
    await delay(1500);
    const marks = await page.evaluate(() => ({ ...window.__benchPerf.marks, board: window.__benchPerf.board, heapPeak: Math.max(0, ...window.__benchPerf.heap) }));
    if (marks.board.pins !== summary.pins || marks.board.components !== summary.components || marks.board.nets !== summary.nets) throw new Error(`The application loaded ${JSON.stringify(marks.board)}, expected ${summary.components} parts, ${summary.pins} pins, ${summary.nets} nets.`);
    const loadTasks = await page.evaluate(([start, end]) => window.__benchPerf.longTasks.filter(task => task.start >= start && task.start <= end), [marks.openAt, marks.firstPaintAt + 1500]);
    result.load = {
      firstPaintMs: Math.round(marks.firstPaintAt - marks.openAt),
      firstDrawEndMs: Math.round(marks.firstDrawEnd - marks.openAt),
      readAndHandoffMs: Math.round(marks.parseSentAt - marks.openAt),
      workerRoundTripMs: Math.round(marks.boardAt - marks.parseSentAt),
      sceneAndFirstDrawMs: Math.round(marks.firstDrawEnd - marks.boardAt),
      firstDrawCallbackMs: Math.round(marks.firstDrawCallbackMs * 10) / 10,
      structuredCloneEstimateMs: null, // measured at the end of the run: a copy of a 1M pin board needs about a gigabyte more
      longTasks: { count: loadTasks.length, totalMs: Math.round(loadTasks.reduce((sum, task) => sum + task.duration, 0)), maxMs: Math.round(Math.max(0, ...loadTasks.map(task => task.duration))) },
      peakJsHeapMB: mb(marks.heapPeak),
    };
    log(`${label}: first paint ${result.load.firstPaintMs} ms (read ${result.load.readAndHandoffMs}, worker ${result.load.workerRoundTripMs}, scene+draw ${result.load.sceneAndFirstDrawMs})`);
    result.memory = { afterLoad: { heap: await heap(), processes: await processSummary() } };
    result.view = { viewport: VIEWPORT, devicePixelRatio: await page.evaluate(() => window.devicePixelRatio) };

    // --- idle: nothing may draw
    result.idle = { draws: (await sample('idle', () => delay(2000), { minFrames: 0 })).frames.length };

    // --- inputs
    const box = await canvasBox();
    const fitScale = Math.min(Math.max(1, box.width - 2 * FIT_PADDING) / board.width, Math.max(1, box.height - 2 * FIT_PADDING) / board.height);
    result.view.canvas = { width: Math.round(box.width), height: Math.round(box.height) };
    result.view.fitPxPerMm = Math.round(fitScale * 1000) / 1000;
    const center = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
    // The largest BGA on the top side is the dense spot the detail view zooms into (the wheel keeps the point under the cursor fixed).
    const anchor = probe.bga ? { x: box.x + box.width / 2 + (probe.bga.x - board.width / 2) * fitScale, y: box.y + box.height / 2 - (probe.bga.y - board.height / 2) * fitScale } : { x: center.x, y: center.y };
    const panRound = amplitude => async () => {
      const steps = 24;
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) await page.mouse.move(center.x + amplitude * i / steps, center.y + amplitude * 0.5 * i / steps);
      for (let i = steps - 1; i >= 0; i--) await page.mouse.move(center.x + amplitude * i / steps, center.y + amplitude * 0.5 * i / steps);
      await page.mouse.up();
    };
    const zoomRound = (at, notches) => async () => {
      await page.mouse.move(at.x, at.y);
      for (let i = 0; i < notches; i++) { await page.mouse.wheel(0, -WHEEL_STEP); await delay(8); }
      for (let i = 0; i < notches; i++) { await page.mouse.wheel(0, WHEEL_STEP); await delay(8); }
    };
    const hoverRound = async () => {
      const columns = 14, rows = 9;
      for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
        await page.mouse.move(box.x + box.width * (0.04 + 0.92 * (r % 2 ? columns - 1 - c : c) / (columns - 1)), box.y + box.height * (0.05 + 0.9 * r / (rows - 1)));
        await delay(8);
      }
    };
    const zoomToDetail = async () => {
      await fit();
      await page.mouse.move(anchor.x, anchor.y);
      const notches = Math.max(1, Math.ceil(Math.log(DETAIL_PX_PER_MM / fitScale) / Math.log(WHEEL_FACTOR)));
      for (let i = 0; i < notches; i++) { await page.mouse.wheel(0, -WHEEL_STEP); await delay(40); }
      await drain(400);
      return Math.round(fitScale * await zoomPercent()) / 100;
    };
    result.pan = {}; result.zoom = {}; result.hover = {}; result.frameCost = { pan: {}, zoom: {} };

    // --- fit view, then the detail view (about 20 px/mm), without a selection
    await fit();
    result.pan.fit = frameStats(await sample('pan-fit', panRound(90)));
    await fit();
    result.zoom.fit = frameStats(await sample('zoom-fit', zoomRound({ x: center.x, y: center.y - 40 }, 8)));
    await fit();
    result.hover.fit = { pointerMoveMs: pointerStats(await sample('hover-fit', hoverRound, { minFrames: 0 })) };
    if (options.screenshots) await page.screenshot({ path: path.join(options.out, `${options.label}-${label}-fit.png`) });
    result.view.detailPxPerMm = await zoomToDetail();
    result.pan.detail = frameStats(await sample('pan-detail', panRound(180)));
    result.zoom.detail = frameStats(await sample('zoom-detail', zoomRound(anchor, 3)));
    result.hover.detail = { pointerMoveMs: pointerStats(await sample('hover-detail', hoverRound, { minFrames: 0 })) };
    if (options.screenshots) await page.screenshot({ path: path.join(options.out, `${options.label}-${label}-detail.png`) });
    await fit();
    await page.mouse.move(center.x, center.y);

    // --- search: type two references one key at a time
    const searchInput = page.getByTestId('search-input');
    const queries = [probe.search, probe.component];
    const keystrokes = [];
    let resultCount = '';
    await searchInput.click();
    await page.evaluate(() => window.__benchPerf.begin('search', false));
    for (const query of queries) {
      for (const character of query) {
        const before = await page.evaluate(() => window.__benchPerf.keys.length);
        await page.keyboard.type(character);
        await delay(60);
        await quiet(250);
        const entry = await page.evaluate(count => {
          const perf_ = window.__benchPerf, key = perf_.keys.slice(count).find(item => item.key.length === 1) || perf_.keys[count];
          return { downAt: key.t, paintAt: key.paintAt, lastResultAt: perf_.resultMutationAt };
        }, before);
        const settled = entry.lastResultAt > entry.downAt ? entry.lastResultAt - entry.downAt : entry.paintAt - entry.downAt;
        keystrokes.push({ query, key: character, settledMs: Math.round(settled * 10) / 10, nextPaintMs: Math.round((entry.paintAt - entry.downAt) * 10) / 10 });
      }
      resultCount = (await page.getByTestId('search-count').innerText()).replace(/\s/g, '');
      await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace'); await quiet(300);
    }
    await page.evaluate(() => window.__benchPerf.finish('search'));
    result.search = { queries, keystrokeMs: budgets.stats(keystrokes.map(item => item.settledMs)), nextPaintMs: budgets.stats(keystrokes.map(item => item.nextPaintMs)), perKey: keystrokes, lastResultCount: resultCount };
    log(`${label}: search "${queries.join('", "')}" p95 ${result.search.keystrokeMs.p95} ms over ${keystrokes.length} keystrokes`);

    // --- select the GND net through the search, then pan and zoom with it highlighted
    await searchInput.fill(probe.gnd);
    await quiet(300);
    // The component group (every part on the net, capped at 300 rows) comes first; the net rows are at the end of the list.
    await page.evaluate(() => { const list = document.getElementById('wsp-results'); if (list) list.scrollTop = list.scrollHeight; });
    await delay(300);
    const row = page.locator('[data-testid="search-row"][data-source="board-nets"]').filter({ has: page.locator('.component-ref', { hasText: new RegExp(`^${probe.gnd}$`) }) }).first();
    await row.waitFor();
    await page.evaluate(() => window.__benchPerf.begin('select-gnd', false));
    await row.click();
    await drain(1500);
    await page.evaluate(() => window.__benchPerf.finish('select-gnd'));
    if (await page.getByTestId('inspector-net').count() !== 1) throw new Error('Selecting the net through the search did not show the net in the inspector.');
    const selection = await page.evaluate(() => {
      const perf_ = window.__benchPerf;
      const click = perf_.clicks.filter(item => item.phase === 'select-gnd').at(-1);
      const frames = perf_.frames.filter(frame => frame.base && click && frame.start >= click.t);
      const first = frames[0];
      return click && first ? { firstDrawMs: first.end - click.t, firstDrawCallbackMs: first.duration, frames: frames.length, lastMs: frames.at(-1).end - click.t } : null;
    });
    result.selectNet = selection ? { net: probe.gnd, pins: summary.netStats.gndPins, firstDrawMs: Math.round(selection.firstDrawMs * 10) / 10, firstDrawCallbackMs: Math.round(selection.firstDrawCallbackMs * 10) / 10, framesAfterClick: selection.frames, lastFrameMs: Math.round(selection.lastMs) } : null;
    await fit();
    result.pan.gnd = frameStats(await sample('pan-gnd', panRound(90)));
    await fit();
    result.zoom.gnd = frameStats(await sample('zoom-gnd', zoomRound({ x: center.x, y: center.y - 40 }, 8)));
    result.memory.afterInteraction = { heap: await heap(), processes: await processSummary() };
    if (options.screenshots) { await fit(); await page.screenshot({ path: path.join(options.out, `${options.label}-${label}-gnd.png`) }); }

    // --- frame cost: every frame also waits for its pixels (a 1 pixel readback), so the cost includes the GPU raster work the callback only
    //     records. These run last; a plain pan repeated afterwards shows whether the readbacks changed how the canvas is drawn.
    if (options.fence) {
      await fit();
      result.frameCost.pan.gnd = frameStats(await sample('cost-pan-gnd', panRound(90), { fence: true }));
      await page.keyboard.press('Escape');
      await delay(300);
      if (await page.getByTestId('inspector-net').count() !== 0) throw new Error('The net selection was not cleared before the frame cost measurement.');
      await fit();
      result.frameCost.pan.fit = frameStats(await sample('cost-pan-fit', panRound(90), { fence: true }));
      await fit();
      result.frameCost.zoom.fit = frameStats(await sample('cost-zoom-fit', zoomRound({ x: center.x, y: center.y - 40 }, 8), { fence: true }));
      await zoomToDetail();
      result.frameCost.pan.detail = frameStats(await sample('cost-pan-detail', panRound(180), { fence: true }));
      result.frameCost.zoom.detail = frameStats(await sample('cost-zoom-detail', zoomRound(anchor, 3), { fence: true }));
      await fit();
      const again = frameStats(await sample('after-fence-pan-fit', panRound(90)));
      result.frameCost.afterFencePlainPanFit = { drawMean: again.draw.mean, drawMeanBefore: result.pan.fit.draw.mean, changed: again.draw.mean > result.pan.fit.draw.mean * 1.5 + 2 };
    }
    result.status = 'ok';
    // How long structuredClone(board) takes on this thread (serialize and deserialize): the transfer from the worker costs about half of it here.
    const cloneMs = await page.evaluate(rounds => window.__benchPerf.cloneMs(rounds), pins <= 100_000 ? 3 : 1).catch(() => null);
    result.load.structuredCloneEstimateMs = cloneMs === null ? null : Math.round(cloneMs);
    result.errors = { console: session.consoleErrors.slice(0, 5), page: session.pageErrors.slice(0, 5) };
  } catch (error) {
    result.error = scrub(error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : error).slice(0, 600);
    result.errors = { console: session.consoleErrors.slice(0, 5), page: session.pageErrors.slice(0, 5) };
    if (options.screenshots && page) await page.screenshot({ path: path.join(options.out, `${options.label}-${label}-failure.png`) }).catch(() => {});
    log(`${label}: FAILED ${result.error}`);
  } finally {
    // The processor seconds the application used, taken before it closes: the rest of the machine's busy time is other programs.
    try { result.host.duringRun = meter.stop(await session.ownCpuSeconds().catch(() => null)); } catch { /* the load is informational */ }
    await session.close();
  }
  result.host.after = { cpuBusyPercent: await host.sampleBusyPercent(1000), freeMemoryGB: freeMemoryGB(), processes: await host.otherProcesses() };
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------

/** The git revision of the checkout when git can be run (never required). */
function gitRevision() {
  try { return require('node:child_process').execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim(); } catch { return null; }
}

const freeMemoryGB = () => Math.round(os.freemem() / 2 ** 30 * 10) / 10;

function describeMachine() {
  const cpus = os.cpus();
  return { platform: process.platform, osRelease: os.release(), arch: os.arch(), cpuModel: cpus[0]?.model?.trim() ?? 'unknown', logicalCpus: cpus.length, memoryGB: Math.round(os.totalmem() / 2 ** 30 * 10) / 10, node: process.versions.node };
}

function summaryLine(result) {
  if (result.status !== 'ok') return `${result.size.padEnd(5)} FAILED`;
  const p95 = value => (value === undefined || value === null || value.p95 === undefined ? '-' : value.p95.toFixed(1));
  const cost = value => (value && value.total ? p95(value.total) : '-');
  return [
    `${result.size.padEnd(5)} first paint ${String(result.load.firstPaintMs).padStart(6)} ms`,
    `pan fit p95 draw ${p95(result.pan.fit.draw)} / frame ${cost(result.frameCost.pan.fit)}`,
    `zoom fit p95 draw ${p95(result.zoom.fit.draw)} / frame ${cost(result.frameCost.zoom.fit)}`,
    `pan detail ${p95(result.pan.detail.draw)}`,
    `select GND ${result.selectNet ? result.selectNet.firstDrawMs : '-'} ms`,
    `search p95 ${p95(result.search.keystrokeMs)}`,
    `hover p95 ${p95(result.hover.fit.pointerMoveMs)}`,
    `heap ${result.memory.afterLoad.heap.usedMB} MB`,
    `other load ${host.loadPercent(result.host) ?? '-'} %`,
  ].join(' | ');
}

async function main(argv) {
  const options = parseArguments(argv);
  if (!options.sizes.length) throw new RangeError('Give --synthetic=<10k|50k|100k|250k|1m|all>.');
  const budget = options.budget ? budgets.loadBudget(options.budget) : null;
  await fsp.mkdir(options.out, { recursive: true });
  await fsp.mkdir(options.boardDir, { recursive: true });
  const log = text => console.log(text);
  const report = {
    schema: REPORT_SCHEMA, kind: 'trace-synthetic-performance', label: options.label, runtime: options.runtime, startedAt: new Date().toISOString(),
    revision: options.revision || gitRevision(), packageVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    generator: { name: generator.GENERATOR, version: generator.GENERATOR_VERSION, seed: options.seed }, machine: describeMachine(),
    settings: { viewport: VIEWPORT, deviceScaleFactor: options.dsf, quick: options.quick, fence: options.fence, headed: options.runtime === 'browser' ? options.headed : true, chromiumFlags: options.flags, appearance: SETTINGS },
    sizes: [],
  };
  const reportFile = path.join(options.out, `${options.label}.json`);
  const save = () => fsp.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  for (const label of options.sizes) {
    const result = await measureBoard(options, label, log);
    report.sizes.push(result);
    if (!report.application && result.machine) report.application = result.machine;
    log(summaryLine(result));
    await save();
  }
  report.finishedAt = new Date().toISOString();
  report.conditions = host.classifyConditions(report.sizes.map(result => result.host), options.conditions);
  log(`Conditions: ${report.conditions}`);
  let code = 0;
  if (budget) {
    const evaluation = budgets.evaluateBudget(budget, report.sizes);
    report.budget = { file: path.basename(options.budget), strict: options.strict, ...evaluation };
    log(`\nBudgets (${path.basename(options.budget)}, ${options.strict ? 'strict' : 'report only'}):\n${budgets.formatBudgetTable(evaluation)}`);
    code = budgets.exitCodeFor(evaluation, options.strict);
  }
  if (report.sizes.some(result => result.status !== 'ok')) code = 1;
  await save();
  const markdownFile = path.join(options.out, `${options.label}.md`);
  await fsp.writeFile(markdownFile, reports.formatMarkdown(report));
  log(`\nReport: ${scrub(reportFile)} (tables: ${path.basename(markdownFile)})`);
  return code;
}

module.exports = { main, parseArguments, instrument, startElectron, startBrowser, VIEWPORT, DEFAULT_BUDGET, DEFAULT_OUT };
