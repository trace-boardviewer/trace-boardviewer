'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { boardRasterHistory, camera, cameraAfterObservedDrag, cameraAfterWheel, dragToPersistedCenter, fittedScale, installBoardRasterHistoryObserver, navigateDocumentsToRestoreBoardCamera, panCamera, registerViewerFixtures, restartWithRasterHistory, selectBoardTab, setPersistableCameraScale, settleBoardSelection, waitForStableBoardPaint } = require('../scripts/packaged-functional/viewers.cjs');

test('viewer fixture registration awaits each native fixture before the module can attach it', async () => {
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  const context = {
    registerFixture(name, bytes) {
      calls.push({ name, bytes, ready: false });
      const entry = calls.at(-1);
      return (calls.length === 1 ? firstGate : Promise.resolve()).then(() => {
        entry.ready = true;
        return `fixture://${name}`;
      });
    },
  };

  const pending = registerViewerFixtures(context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'registration is sequential while the first async write is pending');
  assert.equal(calls[0].ready, false, 'the first fixture has not been marked ready');
  releaseFirst();
  const fixtures = await pending;
  assert.equal(calls.length, 8, 'the known board, attached KiCad baseline, PDF, SVG, EAGLE, and KiCad primary/companion fixtures were registered');
  assert.ok(calls.every(entry => entry.ready), 'the helper resolves only after every fixture is ready');
  assert.equal(fixtures.nativePdf, 'fixture://viewer-native-text.pdf');
  assert.equal(fixtures.knownBoard, 'fixture://viewer-known-board.cad');
  assert.equal(fixtures.knownSchematic, 'fixture://viewer-known-board.kicad_sch');
  assert.equal(fixtures.kicadChild, 'fixture://viewer-channel.kicad_sch');
});

test('viewer fixture registration rejects a failed write and never hands out an incomplete path', async () => {
  const calls = [];
  const context = {
    registerFixture(name) {
      calls.push(name);
      return Promise.reject(new Error('synthetic fixture write failed'));
    },
  };
  await assert.rejects(registerViewerFixtures(context), /synthetic fixture write failed/);
  assert.deepEqual(calls, ['viewer-known-board.cad']);
});

test('native board restart oracle holds the production camera debounce and waits for the startup notice to settle', () => {
  const fixture = fs.readFileSync(require.resolve('../scripts/packaged-functional/viewers.cjs'), 'utf8');
  const canvas = fs.readFileSync(require.resolve('../src/components/BoardCanvas.tsx'), 'utf8');
  const workspace = fs.readFileSync(require.resolve('../src/app/useWorkspace.ts'), 'utf8');
  assert.match(canvas, /const CAMERA_IDLE_MS = 350/);
  assert.match(canvas, /window\.setTimeout\(\(\) => \{ cameraTimerRef\.current = null; emitCamera\(\); \}, CAMERA_IDLE_MS\)/);
  assert.match(canvas, /window\.addEventListener\('pagehide', flushCamera\)/);
  assert.match(workspace, /pageHide\?\.dispatchEvent\(new Event\('pagehide'\)\)/);
  assert.match(fixture, /if \(delay !== 350\)/);
  assert.match(fixture, /originalSetTimeout\.call\(window, callback, 60_000/);
  assert.match(fixture, /await waitForStableBoardPaint\(page\)/);
  assert.match(fixture, /if \(currentEntries\.some\(entry => !entry\)\) \{ finish\(false\); return; \}/);
  assert.match(fixture, /if \(repeated >= 2\) finish\(true\)/);
  assert.match(fixture, /await page\.waitForTimeout\(500\)/);
  assert.match(fixture, /stillPendingCamera\.camera, delayedCamera\.camera/);
  assert.match(fixture, /afterRestart\.paint, pendingArrowFrame\.paint/);
  assert.match(fixture, /viewers-camera-before-pending/);
  assert.match(fixture, /viewers-camera-after-restart/);
  assert.match(fixture, /await settleBoardSelection\(page, \{ clearWithCanvas: true \}\)/);
  assert.match(fixture, /await settleBoardSelection\(restarted, \{ clearWithCanvas: true \}\)/);
  assert.match(fixture, /await waitForStableBoardPaint\(restarted\)/);
  assert.match(fixture, /await page\.mouse\.wheel\(0, deltaY\)/);
  assert.match(fixture, /Math\.round\(box\.width \* 0\.13\)/);
  assert.match(fixture, /Math\.round\(box\.height \* 0\.07\)/);
  assert.match(fixture, /data-testid=support-not-now/);
  assert.match(fixture, /supportNoticeSkippedAfterRestart/);
});

test('camera restart setup uses normal UI input at a profile-stable camera scale and clears transient selection normally', async () => {
  const actions = [];
  let evaluateCount = 0;
  const page = {
    mouse: {
      async move(x, y) { actions.push(['move', x, y]); },
      async wheel(x, y) { actions.push(['wheel', x, y]); },
      async click(x, y) { actions.push(['click', x, y]); },
    },
    locator(selector) {
      if (selector === '[data-testid=search-input]') return { async count() { return 1; }, async fill(value) { actions.push(['search', value]); } };
      if (selector === '[data-testid=board-pane] canvas') return { first: () => ({ async boundingBox() { return { x: 10, y: 20, width: 800, height: 600 }; } }) };
      throw new Error(`unexpected selector: ${selector}`);
    },
    async waitForFunction(predicate, arg) {
      assert.match(predicate.toString(), /zoom-value/);
      assert.equal(arg, 102);
      actions.push(['wait']);
    },
    async evaluate() {
      actions.push(['evaluate']);
      evaluateCount++;
      return evaluateCount === 3 ? [{ clientX: 410, clientY: 320, deltaY: -14.542891837096418 }] : undefined;
    },
  };
  const scale = await setPersistableCameraScale(page, { x: 10, y: 20, width: 800, height: 600 }, 19.54);
  assert.deepEqual(scale, { targetScale: 20, expectedPercent: 102, actualScale: 20, wheel: { clientX: 410, clientY: 320, deltaY: -14.542891837096418 } });
  assert.deepEqual(actions[0], ['evaluate']);
  assert.deepEqual(actions[1], ['move', 410, 320]);
  assert.equal(actions[2][0], 'wheel');
  assert.equal(actions[2][1], 0);
  assert.ok(Math.abs(actions[2][2] + 14.542891837096418) < 1e-12, 'the wheel delta reaches the selected grid scale through the regular canvas input handler');
  assert.equal(actions.at(-2)[0], 'evaluate', 'the normal wheel zoom settles before reading the observed browser input');

  const selectionActions = [];
  const clearPage = {
    locator(selector) {
      if (selector === '[data-testid=search-input]') return { async count() { return 1; }, async fill(value) { selectionActions.push(['search', value]); } };
      if (selector === '[data-testid=board-pane] canvas') return { first: () => ({ async boundingBox() { return { x: 10, y: 20, width: 800, height: 600 }; } }) };
      throw new Error(`unexpected selector: ${selector}`);
    },
    mouse: {
      async click(x, y) { selectionActions.push(['click', x, y]); },
      async move(x, y) { selectionActions.push(['move', x, y]); },
    },
    async waitForFunction(predicate, _arg, options) {
      assert.match(predicate.toString(), /canvas-hover-card|Select a component/);
      assert.equal(options.timeout, 5000);
      selectionActions.push(['wait']);
    },
  };
  await settleBoardSelection(clearPage, { clearWithCanvas: true });
  assert.deepEqual(selectionActions, [['search', ''], ['click', 18, 28], ['move', 6, 16], ['wait'], ['wait']]);
});

test('camera anchor and pan expectations use observed native input values and known fit geometry', () => {
  const canvas = { x: 10, y: 20, width: 800, height: 600 };
  const scale = fittedScale(canvas);
  assert.equal(scale, 16);
  const wheel = { clientX: 410, clientY: 320, deltaY: -Math.log(20 / 16) / 0.0016 };
  const zoomed = cameraAfterWheel({ zoom: scale, x: 20, y: 15, rotation: 0, side: 'top' }, canvas, wheel, 20);
  assert.equal(zoomed.zoom, 20);
  assert.equal(zoomed.x, 20);
  assert.equal(zoomed.y, 15);
  const aboveCenter = cameraAfterWheel({ zoom: scale, x: 20, y: 15, rotation: 0, side: 'top' }, canvas, { ...wheel, clientY: 319 }, 20);
  assert.ok(aboveCenter.y > 15, 'canvas screen y points down while board camera y points up');
  const alignment = dragToPersistedCenter(zoomed);
  assert.deepEqual(alignment.target, { x: 21, y: 16 });
  assert.deepEqual(alignment.delta, { x: -20, y: 20 });
  const moved = cameraAfterObservedDrag(zoomed, [
    { type: 'pointerdown', clientX: 100, clientY: 100 },
    { type: 'pointermove', clientX: 90, clientY: 110 },
    { type: 'pointermove', clientX: 80, clientY: 120 },
    { type: 'pointerup', clientX: 80, clientY: 120 },
  ]);
  assert.deepEqual(moved.delta, { x: -20, y: 20 });
  assert.equal(moved.camera.x, alignment.target.x);
  assert.equal(moved.camera.y, alignment.target.y);
});

test('viewer entry and restart explicitly activate the visible Board tab before waiting for its canvas', async () => {
  const actions = [];
  const page = {
    locator(selector) {
      assert.equal(selector, '#wsp-tab-board', 'Board activation uses the normal visible workspace tab');
      return {
        async waitFor(options) { actions.push(['visible', options.state]); },
        async click() { actions.push(['click']); },
      };
    },
    async waitForFunction(predicate, _arg, options) {
      assert.match(predicate.toString(), /#wsp-tab-board/);
      assert.match(predicate.toString(), /aria-selected/);
      actions.push(['selected', options.timeout]);
    },
  };
  await selectBoardTab(page);
  assert.deepEqual(actions, [['visible', 'visible'], ['click'], ['selected', 10000]], 'activation waits, clicks normally, and confirms the tab became selected');

  const source = fs.readFileSync(require.resolve('../scripts/packaged-functional/viewers.cjs'), 'utf8');
  const entry = source.slice(source.indexOf("ctx.step('viewer scenarios begin"), source.indexOf("ctx.step('board canvas renders"));
  assert.ok(entry.indexOf('await selectBoardTab(page)') < entry.indexOf('await page.waitForSelector'), 'the first canvas wait follows normal Board tab selection');
  assert.ok(entry.indexOf('await selectBoardTab(page)') < entry.indexOf('ctx.waitBoard('), 'the exact target/count wait follows normal Board tab selection');
  const restart = source.slice(source.indexOf('const settleBoardStartup'), source.indexOf('const installCameraDebounceHold'));
  assert.ok(restart.indexOf('await selectBoardTab(page)') < restart.indexOf('await page.waitForSelector'), 'restart canvas wait follows normal Board tab selection');
});

test('camera oracle restores the stored transform through ordinary Documents and Board navigation before a fresh held pan', async () => {
  const actions = [];
  const page = {
    locator(selector) {
      actions.push(['locator', selector]);
      return { async click() { actions.push(['click', selector]); }, async waitFor(options) { actions.push(['visible', selector, options.state]); } };
    },
    async evaluate(callback) {
      if (/paintBaseline/.test(callback.toString())) return [{ canvasId: 1, draws: 0 }];
      return true;
    },
    async waitForFunction(predicate) { actions.push(['wait', predicate.toString()]); return true; },
    async waitForSelector(selector, options) { actions.push(['canvas', selector, options.state]); },
  };
  await navigateDocumentsToRestoreBoardCamera(page);
  assert.match(actions[0][1], /data-split/);
  assert.deepEqual(actions.filter(action => action[0] === 'click'), [
    ['click', '#wsp-tab-documents'],
    ['click', '#wsp-tab-board'],
  ]);
  assert.ok(actions.some(action => action[0] === 'wait' && /data-testid=board-pane/.test(action[1])), 'the old board canvas is unmounted between the visible tabs');
  assert.ok(actions.findIndex(action => action[0] === 'canvas') > actions.findIndex(action => action[0] === 'click' && action[1] === '#wsp-tab-board'));

  const source = fs.readFileSync(require.resolve('../scripts/packaged-functional/viewers.cjs'), 'utf8');
  const scenario = source.slice(source.indexOf("ctx.step('board pan, rotation"), source.indexOf("ctx.step('current exact reference"));
  assert.match(waitForStableBoardPaint.toString(), /page\.evaluate\(/, 'paint settlement returns a serialized boolean instead of a waitForFunction handle');
  assert.doesNotMatch(waitForStableBoardPaint.toString(), /page\.waitForFunction\(/);
  assert.ok(scenario.indexOf('await navigateDocumentsToRestoreBoardCamera(page)') < scenario.indexOf('await installCameraDebounceHold(page)'), 'normal remount restores the rounded store before a new held keyboard input');
  assert.ok(scenario.indexOf('const pendingArrowBaseline = await boardPaintBaseline(page)') < scenario.indexOf("await page.keyboard.press('ArrowDown')"), 'the keyboard action captures draw counts before input');
  assert.match(scenario, /restartWithRasterHistory\(page, \(\) => ctx\.restart\(\), snapshot => \{ rasterHistoryBeforeRestart = snapshot; \}\)/, 'the raster snapshot is saved before restart can close the old page');
  assert.match(scenario, /waitForPersistedCamera\(ctx, knownBoard, buildKnownBoardFixture\(\), delayedCamera\.camera, \{ tolerance: 1e-7 \}\)/);
  assert.match(scenario, /const pendingCamera = panCamera\(delayedCamera\.camera, \{ x: 0, y: -40 \}\)/, 'the ArrowDown oracle comes from a known 40px move and persisted zoom');
  assert.match(scenario, /afterRestart\.paint, pendingArrowFrame\.paint/);
});

test('camera hashes are explicit snapshots and paint settlement avoids pixel readback', async () => {
  const calls = [];
  const page = { async evaluate(callback, argument) { calls.push({ callback: callback.toString(), argument }); return argument; } };
  assert.equal(await camera(page), false);
  assert.equal(await camera(page, { paint: true }), true);
  assert.equal(calls[0].argument, false);
  assert.equal(calls[1].argument, true);
  assert.match(camera.toString(), /\.rotation-badge/);
  assert.doesNotMatch(camera.toString(), /\.canvas-meta/);
  assert.match(installBoardRasterHistoryObserver.toString(), /getContextAttributes/);
  assert.match(installBoardRasterHistoryObserver.toString(), /getTransform/);
  assert.match(installBoardRasterHistoryObserver.toString(), /getImageData/);
  assert.match(installBoardRasterHistoryObserver.toString(), /Reflect\.apply\(original, this, args\)/);
  assert.doesNotMatch(waitForStableBoardPaint.toString(), /getImageData|willReadFrequently/);
});

test('raster observer never initializes a canvas and leaves production context options untouched', async () => {
  const calls = [];
  class FakeContext {
    constructor(canvas, options) { this.canvas = canvas; this.attributes = { alpha: options?.alpha ?? true }; this.drawCalls = []; }
    getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
    getContextAttributes() { return this.attributes; }
    getImageData() { return { data: new Uint8Array(4) }; }
    fillRect(...args) { this.drawCalls.push(args); return this.drawCalls.length; }
  }
  class FakeCanvas {
    constructor(name) { this.name = name; this.width = 40; this.height = 30; this.className = name; this.context = null; }
    closest(selector) { return selector === '[data-testid=board-pane]' ? {} : null; }
    getContext(type, options) {
      calls.push({ canvas: this.name, type, options });
      if (!this.context) this.context = new FakeContext(this, options);
      return this.context;
    }
  }
  const globalDescriptors = new Map(['window', 'document', 'HTMLCanvasElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const existingCanvas = new FakeCanvas('existing');
  const existingOptions = Object.freeze({ alpha: false });
  const existingContext = existingCanvas.getContext('2d', existingOptions);
  const lazyCanvas = new FakeCanvas('lazy');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { CanvasRenderingContext2D: FakeContext } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [existingCanvas, lazyCanvas] } });
  Object.defineProperty(globalThis, 'HTMLCanvasElement', { configurable: true, value: FakeCanvas });
  const page = { async evaluate(callback) { return callback(); } };
  try {
    const installed = await installBoardRasterHistoryObserver(page);
    assert.equal(installed.installed, true);
    assert.equal(lazyCanvas.context, null, 'installation leaves the not-yet-initialized production canvas untouched');
    assert.equal(calls.length, 1, 'installation made no observer-owned getContext call');

    const existingDrawResult = existingContext.fillRect(1, 2, 3, 4);
    assert.equal(existingDrawResult, 1, 'the wrapper preserves the original drawing return value');
    const alphaOptions = Object.freeze({ alpha: false });
    const lazyContext = lazyCanvas.getContext('2d', alphaOptions);
    assert.equal(calls.at(-1).canvas, 'lazy', 'the original getContext receiver remains the canvas');
    assert.equal(calls.at(-1).type, '2d', 'the original getContext type argument remains unchanged');
    assert.equal(calls.at(-1).options, alphaOptions, 'the original production getContext receives the same options object');
    assert.equal(lazyContext.getContextAttributes().alpha, false, 'the production context retains alpha:false');
    const lazyDrawResult = lazyContext.fillRect(5, 6, 7, 8);
    assert.equal(lazyDrawResult, 1);

    const snapshot = await boardRasterHistory(page);
    assert.equal(snapshot.getContextCalls, 1, 'only the actual post-install production getContext is counted');
    assert.equal(snapshot.drawCalls, 2, 'existing and newly created production contexts register actual draws');
    const existing = snapshot.contexts.find(entry => entry.canvas === '40x30' && entry.firstObservedVia === 'draw');
    assert.ok(existing, 'an already-created context is registered on its first observed draw');
    assert.equal(existing.creationArgs, null, 'arguments observed after creation are not mislabeled as creation options');
    assert.equal(existing.firstObservedGetContextArgs, null);
    assert.equal(existing.attributes.alpha, false, 'effective attributes remain observable on a context first seen at draw');
    const lazy = snapshot.contexts.find(entry => entry.firstObservedVia === 'getContext');
    assert.deepEqual(lazy.firstObservedGetContextArgs, ['2d', { alpha: false }]);
    assert.equal(lazy.creationArgs, null, 'even a first observed call is not asserted to have created its returned context');
    assert.equal(lazy.creationOptionsKnown, false);
  } finally {
    for (const [key, descriptor] of globalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

const withFakeAnimationPage = async ({ history, canvases = [], onFrame, closed = () => false }, action) => {
  const original = new Map(['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map();
  let nextFrame = 1;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: history ? { __viewerRasterHistory: history } : {} });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => canvases } });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: callback => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: id => frames.delete(id) });
  let evaluateCalls = 0;
  const page = {
    async evaluate(callback, argument) {
      evaluateCalls++;
      if (closed()) throw new Error('page is closed');
      const result = Promise.resolve(callback(argument));
      while (true) {
        const raced = await Promise.race([result.then(value => ({ done: true, value })), new Promise(resolve => setTimeout(() => resolve({ done: false }), 0))]);
        if (raced.done) return raced.value;
        if (closed()) throw new Error('page is closed');
        const batch = [...frames.entries()];
        for (const [id, frame] of batch) {
          if (!frames.delete(id)) continue;
          onFrame?.();
          frame(0);
        }
      }
    },
    evaluateCalls: () => evaluateCalls,
    waitForFunction: undefined,
    pendingFrames: () => frames.size,
  };
  try { return await action(page); } finally {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
};

test('paint settlement fails closed without an observer or a registered current canvas', async () => {
  const canvas = { width: 20, height: 10 };
  await withFakeAnimationPage({ canvases: [canvas] }, async page => {
    await assert.rejects(waitForStableBoardPaint(page, { timeoutMs: 10 }), /current registered board canvases/);
  });
  const history = { installed: true, canvasDraws: new WeakMap() };
  await withFakeAnimationPage({ history, canvases: [canvas] }, async page => {
    await assert.rejects(waitForStableBoardPaint(page, { timeoutMs: 10 }), /current registered board canvases/);
  });
});

test('paint settlement requires a positive draw and a post-action baseline draw before stable frames', async () => {
  const canvas = { width: 40, height: 30 };
  const record = { draws: 0 };
  const history = { installed: true, canvasDraws: new WeakMap([[canvas, { canvasId: 4, record }]]) };
  await withFakeAnimationPage({ history, canvases: [canvas] }, async page => {
    await assert.rejects(waitForStableBoardPaint(page, { timeoutMs: 10 }), /current registered board canvases/);
    assert.equal(page.pendingFrames(), 0, 'timeout cancels the outstanding animation frame');
  });
  record.draws = 3;
  let frames = 0;
  await withFakeAnimationPage({ history, canvases: [canvas], onFrame: () => { if (++frames === 2) record.draws++; } }, async page => {
    await waitForStableBoardPaint(page, { baseline: [{ canvasId: 4, draws: 3 }], timeoutMs: 100 });
    assert.ok(frames >= 4, 'the callback waits for the baseline draw and then observes three stable samples');
    assert.equal(page.evaluateCalls(), 1, 'settlement returns the in-page primitive through the Playwright evaluate API');
    assert.equal(page.waitForFunction, undefined, 'the fake does not mask Playwright waitForFunction JSHandle semantics');
    assert.equal(page.pendingFrames(), 0, 'successful settlement leaves no animation callback running');
  });
});

test('continuous canvas drawing times out and stops its animation loop', async () => {
  const canvas = { width: 40, height: 30 };
  const record = { draws: 1 };
  const history = { installed: true, canvasDraws: new WeakMap([[canvas, { canvasId: 1, record }]]) };
  await withFakeAnimationPage({ history, canvases: [canvas], onFrame: () => { record.draws++; } }, async page => {
    await assert.rejects(waitForStableBoardPaint(page, { timeoutMs: 15 }), /current registered board canvases/);
    assert.equal(page.pendingFrames(), 0, 'deadline cancels the outstanding animation frame');
  });
});

test('restart returns the raster history snapshot captured while the old page is live', async () => {
  const snapshot = { installed: true, contexts: [{ id: 1, draws: 3 }] };
  let pageClosed = false;
  const page = { async evaluate() { if (pageClosed) throw new Error('page is closed'); return snapshot; } };
  let savedBeforeClose = null;
  const returned = await restartWithRasterHistory(page, async () => { pageClosed = true; }, value => { savedBeforeClose = value; });
  assert.deepEqual(returned, snapshot);
  assert.deepEqual(savedBeforeClose, snapshot, 'the caller retains the snapshot before restart begins closing the old page');
  await assert.rejects(boardRasterHistory(page), /page is closed/);
});

test('camera drag oracle uses accepted pointermove segments and ignores pointerup displacement', () => {
  const camera = { zoom: 2, x: 10, y: 20, rotation: 0, side: 'top' };
  const observed = cameraAfterObservedDrag(camera, [
    { type: 'pointerdown', clientX: 100, clientY: 100 },
    { type: 'pointermove', clientX: 90, clientY: 110 },
    { type: 'pointerup', clientX: 80, clientY: 120 },
  ]);
  assert.deepEqual(observed.delta, { x: -10, y: 10 });
  assert.deepEqual(observed.camera, panCamera(camera, { x: -10, y: 10 }));
  assert.throws(() => cameraAfterObservedDrag(camera, [
    { type: 'pointerdown', clientX: 100, clientY: 100 },
    { type: 'pointermove', clientX: 102, clientY: 101 },
    { type: 'pointerup', clientX: 80, clientY: 120 },
  ]), /pointermove events cross the production pan gesture threshold/);
});

test('90 degree camera pan maps a downward screen move onto the board x axis', () => {
  const original = { zoom: 2, x: 10, y: 20, rotation: 90, side: 'top' };
  const moved = panCamera(original, { x: 0, y: -40 });

  assert.equal(moved.x, 30, 'ArrowDown at 90 degrees changes board x by the scaled screen movement');
  assert.ok(Math.abs(moved.y - original.y) < 1e-10, 'ArrowDown at 90 degrees leaves board y unchanged');
  assert.notDeepEqual(moved, original, 'the complete camera changes for the rotated keyboard pan');
});
