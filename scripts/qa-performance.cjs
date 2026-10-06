'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results');
const boardArgument = process.argv.find(argument => argument.startsWith('--board='));
const sampleValue = boardArgument ? boardArgument.slice(8) : process.env.TRACE_TEST_BOARD;
if (!sampleValue) { console.error('Provide a local GENCAD stress board with AC1/GND: TRACE_TEST_BOARD=/path/to/board.cad node scripts/qa-performance.cjs --label=before (or pass --board=/path/to/board.cad).'); process.exit(2); }
const SAMPLE = path.resolve(sampleValue);
const label = (process.argv.find(argument => argument.startsWith('--label=')) || '--label=before').slice(8);
const profileZoom = process.argv.includes('--profile-zoom');
const URL = process.env.TRACE_QA_URL || 'http://localhost:5173';
const expectedCounts = process.env.TRACE_EXPECT_COUNTS?.split(',').map(Number);
if (expectedCounts && (expectedCounts.length !== 3 || expectedCounts.some(value => !Number.isInteger(value) || value < 1))) { console.error('TRACE_EXPECT_COUNTS must contain component,pin,net counts.'); process.exit(2); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function instrument() {
  const metrics = { phase: 'boot', frames: [], fences: [], fenceNext: false, board: null, errors: [] };
  window.__tracePerf = metrics;
  const states = new WeakMap();
  const pathSegments = new WeakMap();
  let current = null;
  const stateFor = context => {
    let state = states.get(context);
    if (!state) { state = { dashed: false, segments: 0 }; states.set(context, state); }
    return state;
  };
  const nativeRAF = window.requestAnimationFrame;
  window.requestAnimationFrame = callback => nativeRAF.call(window, timestamp => {
    const prior = current;
    const frame = { phase: metrics.phase, timestamp, duration: 0, calls: {}, canvases: [], strokeMs: 0, dashedStrokeMs: 0, networkStrokeMs: 0, maxStrokeMs: 0, maxDashedSegments: 0, maxNetworkSegments: 0 };
    current = frame;
    const start = performance.now();
    try { callback(timestamp); }
    finally {
      frame.duration = performance.now() - start;
      current = prior;
      if (Object.keys(frame.calls).length) metrics.frames.push(frame);
      if (metrics.fenceNext && frame.canvases.includes('board-canvas')) {
        metrics.fenceNext = false;
        const canvas = document.querySelector('canvas.board-canvas');
        const context = canvas.getContext('2d');
        const fenceStart = performance.now();
        context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1);
        metrics.fences.push({ phase: metrics.phase, drawCallbackMs: frame.duration, rasterReadbackFenceMs: performance.now() - fenceStart });
      }
    }
  });
  const prototype = CanvasRenderingContext2D.prototype;
  const mark = (context, method) => {
    if (!current) return;
    current.calls[method] = (current.calls[method] || 0) + 1;
    const name = context.canvas.className || 'unnamed';
    if (!current.canvases.includes(name)) current.canvases.push(name);
  };
  for (const method of ['fill', 'fillRect', 'clearRect', 'drawImage', 'strokeRect', 'strokeText', 'fillText']) {
    const original = prototype[method];
    prototype[method] = function (...args) {
      mark(this, method);
      return original.apply(this, args);
    };
  }
  const originalBegin = prototype.beginPath;
  prototype.beginPath = function (...args) { stateFor(this).segments = 0; return originalBegin.apply(this, args); };
  const originalLine = prototype.lineTo;
  prototype.lineTo = function (...args) { stateFor(this).segments++; return originalLine.apply(this, args); };
  const originalDash = prototype.setLineDash;
  prototype.setLineDash = function (segments) { stateFor(this).dashed = segments.length > 0; return originalDash.call(this, segments); };
  const originalPathLine = Path2D.prototype.lineTo;
  Path2D.prototype.lineTo = function (...args) { pathSegments.set(this, (pathSegments.get(this) || 0) + 1); return originalPathLine.apply(this, args); };
  const originalStroke = prototype.stroke;
  prototype.stroke = function (...args) {
    const start = performance.now();
    const result = originalStroke.apply(this, args);
    const duration = performance.now() - start;
    if (current) {
      const state = stateFor(this);
      mark(this, 'stroke');
      current.strokeMs += duration;
      current.maxStrokeMs = Math.max(current.maxStrokeMs, duration);
      if (state.dashed && args.length === 0) {
        current.dashedStrokeMs += duration;
        current.maxDashedSegments = Math.max(current.maxDashedSegments, state.segments);
      }
      const segments = args[0] instanceof Path2D ? pathSegments.get(args[0]) || 0 : state.segments;
      if (segments > 192) {
        current.networkStrokeMs += duration;
        current.maxNetworkSegments = Math.max(current.maxNetworkSegments, segments);
      }
    }
    return result;
  };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => {
        if (event.data?.board) {
          const board = event.data.board;
          const nets = board.nets.map(net => {
            const ids = new Set(net.pinIds);
            const pins = board.pins.filter(pin => ids.has(pin.id));
            return { name: net.name, totalPins: pins.length, topPins: pins.filter(pin => pin.side === 'top' || pin.side === 'both').length, bottomPins: pins.filter(pin => pin.side === 'bottom' || pin.side === 'both').length, components: new Set(pins.map(pin => pin.componentId)).size };
          }).sort((a, b) => b.totalPins - a.totalPins);
          metrics.board = { components: board.components.length, pins: board.pins.length, nets: board.nets.length, largestNets: nets.slice(0, 10) };
        }
      });
    }
  };
}

function summarize(frames) {
  const sorted = frames.map(frame => frame.duration).sort((a, b) => a - b);
  const at = fraction => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0;
  const timestamps = [...new Set(frames.map(frame => frame.timestamp))].sort((a, b) => a - b);
  const gaps = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]).sort((a, b) => a - b);
  const gapAt = fraction => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * fraction))] : 0;
  const sum = key => frames.reduce((total, frame) => total + frame[key], 0);
  const strokes = frames.reduce((total, frame) => total + (frame.calls.stroke || 0), 0);
  const mainFrames = frames.filter(frame => frame.canvases.includes('board-canvas'));
  const overlayFrames = frames.filter(frame => frame.canvases.some(name => name !== 'board-canvas'));
  const mean = values => values.length ? values.reduce((total, frame) => total + frame.duration, 0) / values.length : 0;
  return {
    drawFrames: frames.length,
    mainCanvasDrawFrames: mainFrames.length, meanMainCanvasCallbackMs: mean(mainFrames),
    overlayDrawFrames: overlayFrames.length, meanOverlayCallbackMs: mean(overlayFrames),
    meanDrawMs: frames.length ? sum('duration') / frames.length : 0,
    medianDrawMs: at(0.5), p95DrawMs: at(0.95), maxDrawMs: at(1),
    uniqueAnimationFrames: timestamps.length, medianAnimationFrameGapMs: gapAt(0.5), p95AnimationFrameGapMs: gapAt(0.95), maxAnimationFrameGapMs: gapAt(1),
    framesOver16_7ms: frames.filter(frame => frame.duration > 16.7).length,
    framesOver50ms: frames.filter(frame => frame.duration > 50).length,
    framesOver100ms: frames.filter(frame => frame.duration > 100).length,
    meanStrokeMsPerDraw: frames.length ? sum('strokeMs') / frames.length : 0,
    meanDashedStrokeMsPerDraw: frames.length ? sum('dashedStrokeMs') / frames.length : 0,
    meanNetworkStrokeMsPerDraw: frames.length ? sum('networkStrokeMs') / frames.length : 0,
    maxStrokeMs: Math.max(0, ...frames.map(frame => frame.maxStrokeMs)),
    maxDashedSegments: Math.max(0, ...frames.map(frame => frame.maxDashedSegments)),
    maxNetworkSegments: Math.max(0, ...frames.map(frame => frame.maxNetworkSegments)),
    drawsByCanvas: Object.fromEntries([...new Set(frames.flatMap(frame => frame.canvases))].map(name => [name, frames.filter(frame => frame.canvases.includes(name)).length])),
    meanStrokeCallsPerDraw: frames.length ? strokes / frames.length : 0,
  };
}

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.TRACE_BROWSER_CHANNEL ? { channel: process.env.TRACE_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.addInitScript(() => { if (!localStorage.getItem('trace-settings')) localStorage.setItem('trace-settings', JSON.stringify({ language: 'hu' })); });
  const consoleErrors = [], pageErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(instrument);
  const results = { label, startedAt: new Date().toISOString(), url: URL, viewport: { width: 1440, height: 960 }, phases: [] };
  const phase = async (name, action, settleMs = 250) => {
    await page.evaluate(value => { window.__tracePerf.phase = value; }, name);
    const started = Date.now();
    await action();
    await delay(settleMs);
    const frames = await page.evaluate(value => window.__tracePerf.frames.filter(frame => frame.phase === value), name);
    const summary = { name, wallMs: Date.now() - started, ...summarize(frames) };
    results.phases.push(summary);
    console.log(`${name}: ${summary.drawFrames} draws, mean${summary.meanDrawMs.toFixed(2)}ms /p95${summary.p95DrawMs.toFixed(2)}ms /max${summary.maxDrawMs.toFixed(2)}ms, dashed${summary.meanDashedStrokeMsPerDraw.toFixed(2)}ms, segments${summary.maxDashedSegments}`);
  };
  const fit = async () => { await page.getByRole('button', { name: 'Teljes nyák', exact: true }).click(); await delay(800); };
  const pan = async () => {
    const box = await page.locator('canvas.board-canvas').boundingBox();
    const x = box.x + box.width * 0.5, y = box.y + box.height * 0.5;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 90, y + 45, { steps: 12 });
    await page.mouse.move(x, y, { steps: 12 });
    await page.mouse.up();
  };
  const zoom = async () => {
    const box = await page.locator('canvas.board-canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
    for (let step = 0; step < 12; step++) { await page.mouse.wheel(0, step < 6 ? -60 : 60); await delay(80); }
  };
  const screenshot = async name => {
    await page.evaluate(() => { window.__tracePerf.phase = 'screenshot'; });
    await page.screenshot({ path: path.join(OUT, `performance-${label}-${name}.png`) });
  };
  try {
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.getByLabel('Boardview fájl', { exact: true }).setInputFiles(SAMPLE);
    await page.locator('.statusbar').waitFor({ timeout: 45000 });
    await page.evaluate(() => document.fonts.ready);
    await delay(1000);
    results.board = await page.evaluate(() => window.__tracePerf.board);
    const actualCounts = [results.board.components, results.board.pins, results.board.nets];
    assert.ok(actualCounts.every(value => value > 0));
    if (expectedCounts) assert.deepEqual(actualCounts, expectedCounts, 'Loaded board counts differ from TRACE_EXPECT_COUNTS');
    if (label === 'after') {
      const baseline = JSON.parse(await fs.readFile(path.join(OUT, 'performance-before.json'), 'utf8'));
      assert.deepEqual(results.board, baseline.board, 'Performance changes must preserve all board and net counts');
    }
    console.log(`Board: ${JSON.stringify(results.board)}`);
    await phase('top-no-net-pan', pan);
    await page.getByRole('textbox', { name: 'Alkatrész keresése', exact: true }).fill('AC1');
    await page.locator('.component-row').filter({ has: page.locator('.component-ref').filter({ hasText: /^AC1$/ }) }).click();
    await fit();
    await phase('bottom-no-net-pan', pan);
    await phase('bottom-select-gnd', async () => { await page.locator('.pin-row').filter({ has: page.locator('span').filter({ hasText: /^GND$/ }) }).click(); }, 1000);
    assert.equal(await page.locator('.net-title strong').innerText(), 'GND');
    results.gndSummary = await page.locator('.connection-summary').innerText();
    await fit();
    await screenshot('bottom-gnd');
    await phase('bottom-gnd-stationary-hover', async () => {
      const box = await page.locator('canvas.board-canvas').boundingBox();
      await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.48);
      await delay(5000);
    });
    await phase('bottom-gnd-pan', pan);
    await fit();
    await phase('bottom-gnd-zoom', zoom);
    await fit();
    await page.getByRole('button', { name: 'Beállítások', exact: true }).click();
    await page.getByRole('switch').nth(2).uncheck();
    await page.getByRole('button', { name: 'Kész', exact: true }).click();
    await delay(500);
    await phase('bottom-gnd-no-connections-pan', pan);
    await page.getByRole('button', { name: 'Beállítások', exact: true }).click();
    await page.getByRole('switch').nth(2).check();
    await page.getByRole('button', { name: 'Kész', exact: true }).click();
    await page.getByRole('button', { name: 'Felső', exact: true }).click();
    await fit();
    await screenshot('top-gnd');
    await phase('top-gnd-pan', pan);
    await fit();
    let profiler;
    if (profileZoom) {
      profiler = await page.context().newCDPSession(page);
      await profiler.send('Profiler.enable'); await profiler.send('Profiler.start');
    }
    await phase('top-gnd-zoom', zoom);
    if (profiler) {
      const { profile } = await profiler.send('Profiler.stop');
      const filename = `performance-${label}-top-gnd-zoom.cpuprofile`;
      await fs.writeFile(path.join(OUT, filename), JSON.stringify(profile));
      results.cpuProfile = filename;
      await profiler.detach();
    }
    for (const side of ['bottom', 'top']) {
      await page.getByRole('button', { name: side === 'top' ? 'Felső' : 'Alsó', exact: true }).click();
      await fit();
      await phase(`${side}-gnd-raster-fence`, async () => {
        await page.evaluate(() => { window.__tracePerf.fenceNext = true; });
        await page.getByRole('button', { name: 'Teljes nyák', exact: true }).click();
      });
    }
    results.consoleErrors = consoleErrors;
    results.pageErrors = pageErrors;
    results.rawFrames = await page.evaluate(() => window.__tracePerf.frames);
    results.rasterFences = await page.evaluate(() => window.__tracePerf.fences);
    console.log(`Raster fences (separate, 1pixel synchronous readback): ${JSON.stringify(results.rasterFences)}`);
    results.finishedAt = new Date().toISOString();
    if (label === 'after') {
      const baseline = JSON.parse(await fs.readFile(path.join(OUT, 'performance-before.json'), 'utf8'));
      for (const name of ['bottom-gnd-zoom', 'top-gnd-zoom']) {
        const before = baseline.phases.find(phase => phase.name === name);
        const after = results.phases.find(phase => phase.name === name);
        assert.ok(after.meanMainCanvasCallbackMs <= before.meanDrawMs * 1.5 + 10, `${name} regressed from${before.meanDrawMs.toFixed(1)}ms to${after.meanMainCanvasCallbackMs.toFixed(1)}ms`);
      }
    }
    results.passed = consoleErrors.length === 0 && pageErrors.length === 0;
  } catch (error) {
    results.error = error.stack || String(error);
    results.passed = false;
    results.rawFrames = await page.evaluate(() => window.__tracePerf.frames).catch(() => []);
    await screenshot('failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    await fs.writeFile(path.join(OUT, `performance-${label}.json`), `${JSON.stringify(results, null, 2)}\n`);
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
