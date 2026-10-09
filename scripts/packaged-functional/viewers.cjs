'use strict';

// Packaged viewer acceptance checks. All inputs are synthetic and registered through the runner.
// The runner calls run(ctx) once on its live, packaged Electron page.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { makeImageOnlyPdf } = require('../qa-ocr.cjs');

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const installBoardRasterHistoryObserver = page => page.evaluate(() => {
  const key = '__viewerRasterHistory';
  if (window[key]?.installed) return window[key].snapshot();
  const state = window[key] = { installed: true, contexts: [], getContextCalls: 0, drawCalls: 0, readCalls: 0, canvasDraws: new WeakMap(), canvasIds: new WeakMap(), nextCanvasId: 1 };
  const contextIds = new WeakMap();
  const isBoardCanvas = canvas => canvas instanceof HTMLCanvasElement && !!canvas.closest('[data-testid=board-pane]');
  const matrix = context => {
    const value = context.getTransform();
    return [value.a, value.b, value.c, value.d, value.e, value.f];
  };
  const trackContext = (context, canvas, observedGetContextArgs = null) => {
    if (!context) return null;
    if (contextIds.has(context)) return contextIds.get(context);
    let safeObservedArgs = null;
    if (observedGetContextArgs !== null) {
      safeObservedArgs = [observedGetContextArgs[0]];
      const options = observedGetContextArgs[1];
      if (options && typeof options === 'object') {
        const safeOptions = {};
        try {
          for (const name of ['alpha', 'desynchronized', 'colorSpace', 'colorType', 'willReadFrequently']) {
            const descriptor = Object.getOwnPropertyDescriptor(options, name);
            if (descriptor && Object.hasOwn(descriptor, 'value') && ['boolean', 'string'].includes(typeof descriptor.value)) safeOptions[name] = descriptor.value;
          }
          safeObservedArgs.push(safeOptions);
        } catch { safeObservedArgs = [observedGetContextArgs[0]]; }
      }
    }
    const canvasId = state.canvasIds.get(canvas) ?? state.nextCanvasId++;
    state.canvasIds.set(canvas, canvasId);
    const record = { id: state.contexts.length + 1, canvas: `${canvas.width}x${canvas.height}`, classes: String(canvas.className || ''),
      creationArgs: null, creationOptionsKnown: false, firstObservedGetContextArgs: safeObservedArgs,
      firstObservedVia: safeObservedArgs ? 'getContext' : 'draw', attributes: context.getContextAttributes?.() ?? null,
      initialTransform: matrix(context), reads: 0, draws: 0, lastDrawTransforms: [] };
    state.contexts.push(record);
    contextIds.set(context, record);
    state.canvasDraws.set(canvas, { record, canvasId });
    return record;
  };
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, writable: true, value: function (...args) {
    if (isBoardCanvas(this) && args[0] === '2d') state.getContextCalls++;
    const context = Reflect.apply(originalGetContext, this, args);
    if (isBoardCanvas(this) && args[0] === '2d') trackContext(context, this, args);
    return context;
  } });

  const contextPrototype = window.CanvasRenderingContext2D?.prototype;
  if (!contextPrototype) throw new Error('Canvas2D raster history cannot observe the current renderer.');
  for (const name of ['getImageData', 'clearRect', 'fill', 'fillRect', 'fillText', 'putImageData', 'stroke', 'strokeRect', 'strokeText', 'drawImage']) {
    const descriptor = Object.getOwnPropertyDescriptor(contextPrototype, name);
    const original = descriptor?.value;
    if (typeof original !== 'function') continue;
    Object.defineProperty(contextPrototype, name, { ...descriptor, value: function (...args) {
      const canvas = this.canvas;
      const boardCanvas = isBoardCanvas(canvas);
      const record = boardCanvas ? trackContext(this, canvas) : null;
      if (record && name === 'getImageData') { record.reads++; state.readCalls++; }
      else if (record) {
        const transform = matrix(this);
        record.draws++; state.drawCalls++;
        record.lastDrawTransforms.push({ method: name, matrix: transform });
        if (record.lastDrawTransforms.length > 120) record.lastDrawTransforms.shift();
      }
      return Reflect.apply(original, this, args);
    } });
  }
  state.paintBaseline = () => [...document.querySelectorAll('[data-testid=board-pane] canvas')].map(canvas => {
    const entry = state.canvasDraws.get(canvas);
    return entry ? { canvasId: entry.canvasId, draws: entry.record.draws } : null;
  });
  state.snapshot = () => ({ installed: state.installed, getContextCalls: state.getContextCalls, drawCalls: state.drawCalls, readCalls: state.readCalls,
    contexts: state.contexts.map(({ id, canvas, classes, creationArgs, creationOptionsKnown, firstObservedGetContextArgs, firstObservedVia, attributes, initialTransform, reads, draws, lastDrawTransforms }) =>
      ({ id, canvas, classes, creationArgs, creationOptionsKnown, firstObservedGetContextArgs, firstObservedVia, attributes, initialTransform, reads, draws, lastDrawTransforms: [...lastDrawTransforms] })) });
  return state.snapshot();
});
const boardRasterHistory = page => page.evaluate(() => window.__viewerRasterHistory?.snapshot() ?? null);
const boardPaintBaseline = page => page.evaluate(() => window.__viewerRasterHistory?.paintBaseline() ?? null);
const restartWithRasterHistory = async (page, restart, saveSnapshot = () => {}) => {
  const snapshot = await boardRasterHistory(page);
  assert.ok(snapshot?.installed, 'the old live page has an installed raster history observer before restart');
  saveSnapshot(snapshot);
  await restart();
  return snapshot;
};
const waitForStableBoardPaint = async (page, { baseline = null, timeoutMs = 5000 } = {}) => {
  const settled = await page.evaluate(({ baseline, timeoutMs }) => new Promise(resolve => {
  let previous = '', repeated = 0, done = false, frame = 0;
  const finish = value => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (frame) cancelAnimationFrame(frame);
    resolve(value);
  };
  const timer = setTimeout(() => finish(false), timeoutMs);
  const sample = () => {
    if (done) return;
    const canvases = [...document.querySelectorAll('[data-testid=board-pane] canvas')];
    const history = window.__viewerRasterHistory;
    if (!history?.installed || !canvases.length) { finish(false); return; }
    const currentEntries = canvases.map(canvas => {
      const entry = history.canvasDraws.get(canvas);
      return entry ? { canvasId: entry.canvasId, draws: entry.record.draws, size: `${canvas.width}x${canvas.height}` } : null;
    });
    if (currentEntries.some(entry => !entry)) { finish(false); return; }
    const current = currentEntries.map(entry => `${entry.canvasId}:${entry.size}:${entry.draws}`).join('|');
    const before = new Map((baseline ?? []).filter(Boolean).map(entry => [entry.canvasId, entry.draws]));
    const hasDrawn = currentEntries.every(entry => entry.draws > 0 && entry.draws > (before.get(entry.canvasId) ?? 0));
    if (!hasDrawn) { previous = ''; repeated = 0; frame = requestAnimationFrame(sample); return; }
    if (current === previous) repeated++; else repeated = 0;
    if (repeated >= 2) finish(true);
    else { previous = current; frame = requestAnimationFrame(sample); }
  };
  frame = requestAnimationFrame(sample);
}), { baseline, timeoutMs });
  assert.equal(settled, true, 'the current registered board canvases produced a new draw and reached stable consecutive frames');
};
async function sameCanonicalPath(actualPath, expectedPath, platform = process.platform) {
  const [actual, expected] = await Promise.all([fs.realpath(actualPath), fs.realpath(expectedPath)]);
  return sameCanonicalPathStrings(actual, expected, platform);
}
function sameCanonicalPathStrings(actual, expected, platform = process.platform) {
  return platform === 'win32'
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}
const eagleSchematic = `<?xml version="1.0" encoding="utf-8"?><eagle version="9.6.2"><drawing><schematic><libraries><library name="tiny"><symbols><symbol name="POINT"><pin name="P" x="0" y="0" length="point" direction="pas"/></symbol></symbols><devicesets><deviceset name="DUAL"><gates><gate name="A" symbol="POINT" x="0" y="0"/><gate name="B" symbol="POINT" x="0" y="0"/></gates><devices><device name="" package="TWO"><connects><connect gate="A" pin="P" pad="1"/><connect gate="B" pin="P" pad="2"/></connects></device></devices></deviceset></devicesets></library></libraries><parts><part name="U1" library="tiny" deviceset="DUAL" device="" value="DUAL"/></parts><sheets><sheet><instances><instance part="U1" gate="A" x="10" y="20"/></instances><nets><net name="SIG" class="0"><segment><pinref part="U1" gate="A" pin="P"/><wire x1="10" y1="20" x2="15" y2="20" width="0.15" layer="91"/></segment></net></nets></sheet><sheet><instances><instance part="U1" gate="B" x="40" y="20"/></instances><nets><net name="SIG" class="0"><segment><pinref part="U1" gate="B" pin="P"/><wire x1="40" y1="20" x2="45" y2="20" width="0.15" layer="91"/></segment></net></nets></sheet></sheets></schematic></drawing></eagle>`;
function buildKnownBoardFixture() {
  return Buffer.from([
    '$HEADER', 'GENCAD 1.4', 'UNITS MM', 'ORIGIN 0 0', '$ENDHEADER',
    '$BOARD', 'RECTANGLE 0 0 40 30', '$ENDBOARD',
    '$PADS', 'PAD P ROUND -1', 'CIRCLE 0 0 0.2', '$ENDPADS',
    '$PADSTACKS', 'PADSTACK PS 0', 'PAD P TOP 0 0', '$ENDPADSTACKS',
    '$SHAPES', 'SHAPE S', 'RECTANGLE -2 -1 4 2', 'PIN 1 PS -1 0 TOP 0 0', 'PIN 2 PS 1 0 TOP 0 0', '$ENDSHAPES',
    '$COMPONENTS',
    ...['PU301', 'U1', 'U10'].flatMap((ref, index) => [`COMPONENT ${ref}`, `PLACE ${10 + index * 10} 20`, 'LAYER TOP', 'ROTATION 0', 'SHAPE S 0 0', 'DEVICE D']),
    '$ENDCOMPONENTS', '$DEVICES', 'DEVICE D', 'VALUE "10k"', '$ENDDEVICES',
    '$SIGNALS', 'SIGNAL GND', 'NODE PU301 1', 'NODE U1 1', 'NODE U10 1', 'SIGNAL VCC', 'NODE PU301 2', 'NODE U1 2', 'NODE U10 2', '$ENDSIGNALS', '',
  ].join('\n'), 'utf8');
}
const hierarchyUuid = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const hierarchyEffects = '(effects (font (size 1.27 1.27)))';
const hierarchyPin = (at, number) => `(pin passive line (at ${at}) (length 1.27) (name "~" ${hierarchyEffects}) (number "${number}" ${hierarchyEffects}))`;
const hierarchyLibrary = `(symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (in_bom yes) (on_board yes)
  (property "Reference" "R" (at 0 6 0) ${hierarchyEffects}) (property "Value" "R" (at 0 -6 0) ${hierarchyEffects})
  (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "R_1_1" ${hierarchyPin('0 3.81 270', '1')} ${hierarchyPin('0 -3.81 90', '2')}))`;
const knownKicadSchematic = `(kicad_sch (version 20231120) (generator "synthetic") (uuid "00000000-0000-4000-8000-000000000101") (paper "A4") (lib_symbols ${hierarchyLibrary})
  (symbol (lib_id "Device:R") (at 20 20 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "00000000-0000-4000-8000-000000000121")
    (property "Reference" "U1" (at 0 0 0) ${hierarchyEffects}) (property "Value" "10k" (at 0 0 0) ${hierarchyEffects})
    (instances (project "viewer" (path "/00000000-0000-4000-8000-000000000101" (reference "U1") (unit 1)))))
  (wire (pts (xy 20 16.19) (xy 35 16.19)) (stroke (width 0) (type default)) (uuid "00000000-0000-4000-8000-000000000131"))
  (label "VCC" (at 35 16.19 0) (effects (font (size 1.27 1.27))) (uuid "00000000-0000-4000-8000-000000000132"))
  (sheet_instances (path "/" (page "1"))))`;
function buildKicadHierarchyFixtures() {
  const rootId = hierarchyUuid(1), sheetId = hierarchyUuid(11);
  const root = `(kicad_sch (version 20231120) (generator "synthetic") (uuid "${rootId}") (paper "A4") (lib_symbols ${hierarchyLibrary})
    (sheet (at 50 40) (size 30 20) (uuid "${sheetId}") (property "Sheetname" "Channel" (at 0 0 0) ${hierarchyEffects})
      (property "Sheetfile" "viewer-channel.kicad_sch" (at 0 0 0) ${hierarchyEffects})
      (pin "IN" input (at 50 46.19 180) ${hierarchyEffects} (uuid "${hierarchyUuid(71)}")))
    (symbol (lib_id "Device:R") (at 20 20 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "${hierarchyUuid(21)}")
      (property "Reference" "PU301" (at 0 0 0) ${hierarchyEffects}) (property "Value" "10k" (at 0 0 0) ${hierarchyEffects})
      (instances (project "viewer" (path "/${rootId}" (reference "PU301") (unit 1)))))
    (wire (pts (xy 20 23.81) (xy 20 46.19)) (stroke (width 0) (type default)) (uuid "${hierarchyUuid(31)}"))
    (wire (pts (xy 20 46.19) (xy 50 46.19)) (stroke (width 0) (type default)) (uuid "${hierarchyUuid(32)}"))
    (sheet_instances (path "/" (page "1"))))`;
  const child = `(kicad_sch (version 20231120) (generator "synthetic") (uuid "${hierarchyUuid(2)}") (paper "A4") (lib_symbols ${hierarchyLibrary})
    (symbol (lib_id "Device:R") (at 100 50 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "${hierarchyUuid(41)}")
      (property "Reference" "U10" (at 0 0 0) ${hierarchyEffects}) (property "Value" "10k" (at 0 0 0) ${hierarchyEffects})
      (instances (project "viewer" (path "/${rootId}/${sheetId}" (reference "U10") (unit 1)))))
    (wire (pts (xy 100 46.19) (xy 50 46.19)) (stroke (width 0) (type default)) (uuid "${hierarchyUuid(42)}"))
    (hierarchical_label "IN" (shape input) (at 50 46.19 180) ${hierarchyEffects} (uuid "${hierarchyUuid(43)}")))`;
  return { root, child };
}
async function registerViewerFixtures(ctx) {
  const knownBoard = await ctx.registerFixture('viewer-known-board.cad', buildKnownBoardFixture());
  const knownSchematic = await ctx.registerFixture('viewer-known-board.kicad_sch', Buffer.from(knownKicadSchematic));
  const nativePdf = await ctx.registerFixture('viewer-native-text.pdf', makeTextPdf('TRACE-VIEWER-ALPHA U10'));
  const scannedPdf = await ctx.registerFixture('viewer-scanned-text.pdf', makeImageOnlyPdf(['TRACE-VIEWER-OCR', 'U10']));
  const svg = await ctx.registerFixture('viewer-sanitized.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#246"/><script>window.__viewerSvgExecuted=true</script><foreignObject><body>remove</body></foreignObject><text x="16" y="50" fill="white">TRACE VIEW</text></svg>'));
  const eagle = await ctx.registerFixture('viewer-hierarchical.eagle.sch', Buffer.from(eagleSchematic));
  const hierarchy = buildKicadHierarchyFixtures();
  const hierarchicalKicad = await ctx.registerFixture('viewer-hierarchical.kicad_sch', Buffer.from(hierarchy.root));
  const kicadChild = await ctx.registerFixture('viewer-channel.kicad_sch', Buffer.from(hierarchy.child));
  return { knownBoard, knownSchematic, nativePdf, scannedPdf, svg, eagle, hierarchicalKicad, kicadChild };
}
const requireSelector = async (page, selector) => {
  await page.waitForSelector(selector, { state: 'visible', timeout: 20000 });
  return page.locator(selector).first();
};
const selectBoardTab = async page => {
  const tab = page.locator('#wsp-tab-board');
  await tab.waitFor({ state: 'visible', timeout: 15000 });
  await tab.click();
  await page.waitForFunction(() => document.querySelector('#wsp-tab-board')?.getAttribute('aria-selected') === 'true', null, { timeout: 10000 });
};
const navigateDocumentsToRestoreBoardCamera = async page => {
  const baseline = await boardPaintBaseline(page);
  await page.waitForFunction(() => document.querySelector('.workspace')?.getAttribute('data-split') === 'false', null, { timeout: 5000 });
  await page.locator('#wsp-tab-documents').click();
  await page.waitForFunction(() => document.querySelector('#wsp-tab-documents')?.getAttribute('aria-selected') === 'true', null, { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid=board-pane] canvas'), null, { timeout: 10000 });
  await selectBoardTab(page);
  await page.waitForSelector('[data-testid=board-pane] canvas', { state: 'visible', timeout: 15000 });
  await waitForStableBoardPaint(page, { baseline });
};
const settleBoardSelection = async (page, { clearWithCanvas = false } = {}) => {
  const search = page.locator('[data-testid=search-input]');
  if (await search.count()) await search.fill('');
  const canvas = page.locator('[data-testid=board-pane] canvas').first();
  if (clearWithCanvas) {
    const box = await canvas.boundingBox();
    assert.ok(box, 'the board canvas has a point outside the fitted outline for clearing any prior selection');
    await page.mouse.click(box.x + 8, box.y + 8);
  }
  const box = await canvas.boundingBox();
  if (box) await page.mouse.move(box.x - 4, box.y - 4);
  await page.waitForFunction(() => !document.querySelector('.canvas-hover-card'), null, { timeout: 5000 });
  await page.waitForFunction(() => /Select a component/.test(document.querySelector('[data-testid=inspector]')?.textContent || ''), null, { timeout: 5000 });
};
const cameraAfterWheel = (camera, rect, wheel, scale) => {
  const anchorX = wheel.clientX - rect.x - rect.width / 2;
  const anchorY = wheel.clientY - rect.y - rect.height / 2;
  const nextScale = camera.zoom * Math.exp(-Math.max(-350, Math.min(350, wheel.deltaY)) * 0.0016);
  assert.ok(Math.abs(nextScale - scale) < 1e-10, 'wheel transform uses the scale derived from the actual observed delta');
  return { ...camera, zoom: nextScale, x: camera.x + anchorX * (1 / camera.zoom - 1 / nextScale), y: camera.y - anchorY * (1 / camera.zoom - 1 / nextScale) };
};
const dragToPersistedCenter = camera => {
  const target = { x: Math.round((Math.round(camera.x * 1000) / 1000 + 1) * 1000) / 1000, y: Math.round((Math.round(camera.y * 1000) / 1000 + 1) * 1000) / 1000 };
  return { target, delta: { x: (camera.x - target.x) * camera.zoom, y: (target.y - camera.y) * camera.zoom } };
};
const cameraAfterObservedDrag = (camera, events) => {
  const downs = events.map((event, index) => event.type === 'pointerdown' ? index : -1).filter(index => index >= 0);
  const ups = events.filter(event => event.type === 'pointerup');
  assert.equal(downs.length, 1, 'camera alignment uses one ordinary pointer down');
  assert.equal(ups.length, 1, 'camera alignment uses one ordinary pointer up');
  const start = events[downs[0]];
  let last = start;
  let moved = false;
  const delta = { x: 0, y: 0 };
  for (const event of events.slice(downs[0] + 1)) {
    if (event.type !== 'pointermove') continue;
    const segment = { x: event.clientX - last.clientX, y: event.clientY - last.clientY };
    if (!moved && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > 4) moved = true;
    if (moved) { delta.x += segment.x; delta.y += segment.y; }
    last = event;
  }
  assert.ok(moved, 'ordinary pointermove events cross the production pan gesture threshold');
  return { camera: panCamera(camera, delta), delta };
};
const fittedScale = (canvas, board = { width: 40, height: 30 }) => Math.min(Math.max(1, canvas.width - 120) / board.width, Math.max(1, canvas.height - 120) / board.height);
const setPersistableCameraScale = async (page, canvas, initialScale) => {
  // Measure the wheel anchor and delta delivered by Chromium; the fitted scale comes from the known board and canvas geometry.
  const targetScale = [1, 2, 4, 5, 8, 10, 20, 25, 40, 50]
    .sort((a, b) => Math.abs(Math.log(a / initialScale)) - Math.abs(Math.log(b / initialScale)))[0];
  const deltaY = -Math.log(targetScale / initialScale) / 0.0016;
  const expectedPercent = Math.round(targetScale / initialScale * 100);
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid=board-pane] canvas');
    window.__viewerWheelObservation = [];
    canvas.addEventListener('wheel', event => window.__viewerWheelObservation.push({ clientX: event.clientX, clientY: event.clientY, deltaY: event.deltaY }), { capture: true, once: true });
  });
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.wheel(0, deltaY);
  await page.waitForFunction(expected => Number.parseFloat(document.querySelector('[data-testid=zoom-value]')?.textContent || '0') === expected,
    expectedPercent, { timeout: 10000 });
  await settle(page);
  const [wheel] = await page.evaluate(() => window.__viewerWheelObservation || []);
  assert.ok(wheel && Number.isFinite(wheel.clientX) && Number.isFinite(wheel.deltaY), 'the normal wheel event exposes its actual browser anchor and delta');
  const actualScale = initialScale * Math.exp(-Math.max(-350, Math.min(350, wheel.deltaY)) * 0.0016);
  return { targetScale, expectedPercent, actualScale, wheel };
};
const settleBoardStartup = async page => {
  await page.waitForFunction(() => /viewer-known-board\.cad/i.test(document.querySelector('.project-subtitle')?.textContent || ''), null, { timeout: 30000 });
  const skip = page.locator('[data-testid=support-not-now]');
  let noticeSkipped = false;
  try {
    await skip.waitFor({ state: 'visible', timeout: 3000 });
    await skip.click();
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[data-testid=support-notice]');
      return !dialog || !dialog.open;
    }, null, { timeout: 5000 });
    noticeSkipped = true;
  } catch (error) {
    const open = await page.locator('[data-testid=support-notice]').evaluate(dialog => dialog.open).catch(() => false);
    assert.equal(open, false, 'startup continues only after any support notice is absent or closed');
    if (error?.name !== 'TimeoutError') throw error;
  }
  await selectBoardTab(page);
  await page.waitForSelector('[data-testid=board-pane] canvas', { state: 'visible', timeout: 45000 });
  return { noticeSkipped };
};
const installCameraDebounceHold = async page => page.evaluate(() => {
  const originalSetTimeout = window.setTimeout;
  const held = [];
  window.setTimeout = function (callback, delay, ...args) {
    if (delay !== 350) return originalSetTimeout.call(window, callback, delay, ...args);
    const timer = originalSetTimeout.call(window, callback, 60_000, ...args);
    held.push({ timer, delay });
    return timer;
  };
  window.__traceViewerCameraDebounceHold = {
    held,
    restore() { window.setTimeout = originalSetTimeout; },
  };
});
const restoreCameraDebounceHold = async page => page.evaluate(() => {
  const hold = window.__traceViewerCameraDebounceHold;
  if (!hold) return 0;
  hold.restore();
  delete window.__traceViewerCameraDebounceHold;
  return hold.held.length;
});
const fileInput = page => page.locator('[data-testid=document-file-input]');
function makeTextPdf(text) {
  const content = value => Buffer.from(`BT /F1 28 Tf 40 220 Td (${value}) Tj ET\n`, 'ascii');
  const firstPage = content(text), secondPage = content('TRACE-VIEWER-PAGE-TWO');
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.concat([Buffer.from(`<< /Length ${firstPage.length} >>\nstream\n`), firstPage, Buffer.from('endstream')]),
    Buffer.concat([Buffer.from(`<< /Length ${secondPage.length} >>\nstream\n`), secondPage, Buffer.from('endstream')]),
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [];
  let offset = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(offset);
    const row = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    chunks.push(row); offset += row.length;
  }
  const xref = offset;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
const attach = async (ctx, files) => {
  const page = ctx.getPage();
  await page.click('[data-testid=tab-documents]');
  await requireSelector(page, '[data-testid=documents-tab]');
  await fileInput(page).setInputFiles(files);
  await page.waitForFunction(names => {
    const rows = [...document.querySelectorAll('[data-testid=document-row]')];
    return names.every(name => rows.some(row => row.textContent.includes(name) && row.getAttribute('data-status') === 'ready'));
  }, files.map(file => file.split(/[\\/]/).at(-1)), { timeout: 45000 });
};
const attachFromDialog = async (ctx, files) => {
  const page = ctx.getPage();
  await page.click('[data-testid=tab-documents]');
  await requireSelector(page, '[data-testid=documents-tab]');
  await ctx.withOpenDialog(files, async () => { await page.locator('[data-testid=attach]').click(); });
  const names = files.map(file => path.basename(file));
  await page.waitForFunction(expected => {
    const rows = [...document.querySelectorAll('[data-testid=document-row]')];
    return expected.every(name => rows.some(row => row.textContent.includes(name) && row.getAttribute('data-status') === 'ready'));
  }, names, { timeout: 45000 });
};
const openDocument = async (ctx, name) => {
  const page = ctx.getPage();
  await page.locator('[data-testid=document-row]').filter({ hasText: name }).locator('.wsp-doc-main').click();
  await page.waitForSelector('[data-testid=document-viewer]', { state: 'visible', timeout: 30000 });
  await settle(page);
};
const camera = (page, { paint: includePaint = false } = {}) => page.evaluate(includePaint => {
  const canvas = document.querySelector('[data-testid=board-pane] canvas');
  const rect = canvas?.getBoundingClientRect();
  const zoom = document.querySelector('[data-testid=zoom-value]')?.textContent?.trim();
  const rotation = document.querySelector('.rotation-badge')?.textContent?.match(/-?\d+/)?.[0] ?? '0';
  const context = includePaint && canvas ? canvas.getContext('2d') : null;
  const pixels = context && canvas ? context.getImageData(0, 0, canvas.width, canvas.height).data : null;
  let paint = null;
  if (pixels) {
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index++) hash = Math.imul(hash ^ pixels[index], 16777619);
    paint = `${canvas.width}x${canvas.height}:${hash >>> 0}`;
  }
  const side = document.querySelector('[data-testid=side-top]')?.getAttribute('aria-pressed') === 'true' ? 'top'
    : document.querySelector('[data-testid=side-bottom]')?.getAttribute('aria-pressed') === 'true' ? 'bottom' : null;
  return { canvas: !!canvas, rect: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, zoom, rotation, side, paint };
}, includePaint);
const persistedWorkspace = async (ctx, boardPath, boardBytes) => {
  const app = ctx.getApp();
  assert.ok(app && typeof app.evaluate === 'function', 'the current native Electron app is available for its production profile path');
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const key = crypto.createHash('sha256').update(boardBytes).digest('hex');
  const manifest = JSON.parse(await fs.readFile(path.join(userData, 'workspaces', `${key}.json`), 'utf8'));
  assert.equal(manifest.board.key, key, 'the production workspace manifest belongs to the known board content hash');
  assert.equal(await sameCanonicalPath(manifest.board.path, boardPath), true, 'the production workspace manifest names the known board path');
  assert.ok(manifest.cameras?.board && ['zoom', 'x', 'y', 'rotation'].every(field => Number.isFinite(manifest.cameras.board[field])), 'the production manifest contains a complete persisted board camera');
  assert.ok(['top', 'bottom'].includes(manifest.cameras.board.side), 'the production manifest contains a persisted board side');
  return { key, path: manifest.board.path, camera: manifest.cameras.board };
};
const waitForPersistedCamera = async (ctx, boardPath, boardBytes, expected, { timeout = 15000, tolerance = 0.02 } = {}) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const persisted = await persistedWorkspace(ctx, boardPath, boardBytes);
      const matches = ['zoom', 'x', 'y', 'rotation'].every(field => Math.abs(persisted.camera[field] - expected[field]) <= tolerance) && persisted.camera.side === expected.side;
      if (matches) return persisted;
      lastError = new Error(`camera has not reached the expected transform: ${JSON.stringify(persisted.camera)}`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error('persisted camera did not reach the expected transform before timeout');
};
const assertCameraClose = (actual, expected, tolerance = 0.001) => {
  for (const field of ['zoom', 'x', 'y', 'rotation']) {
    assert.ok(Math.abs(actual[field] - expected[field]) <= tolerance, `persisted camera ${field} is restored within ${tolerance}: ${actual[field]} vs ${expected[field]}`);
  }
  assert.equal(actual.side, expected.side, 'persisted camera side is restored');
};
const panCamera = (camera, screenDelta) => {
  const angle = -camera.rotation * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  const screenX = screenDelta.x / camera.zoom, screenY = screenDelta.y / camera.zoom;
  const x = screenX * c - screenY * s;
  const y = screenX * s + screenY * c;
  const mirroredX = camera.side === 'bottom' ? -x : x;
  return { ...camera, x: camera.x - mirroredX, y: camera.y + y };
};
const activateSearch = async (page, query, expectedSource, expectedText) => {
  const input = page.locator('[data-testid=search-input]');
  await input.fill(query);
  const row = page.locator(`[data-testid=search-row][data-source="${expectedSource}"]`).filter({ hasText: expectedText }).first();
  await row.waitFor({ state: 'visible', timeout: 20000 });
  const text = await row.innerText();
  assert.equal(text.split(/\r?\n/)[0].trim(), expectedText, `query ${query} exposes exact result ${expectedText}`);
  await row.click();
  return text;
};
const waitForExactComponentRow = async (page, ref) => {
  await page.waitForFunction(expected => [...document.querySelectorAll('[data-testid=search-row][data-source="board-components"]')]
    .some(row => row.querySelector('.component-ref')?.textContent?.trim() === expected), ref, { timeout: 20000 });
  const rows = page.locator('[data-testid=search-row][data-source="board-components"]');
  const refs = (await rows.locator('.component-ref').allTextContents()).map(text => text.trim());
  const index = refs.indexOf(ref);
  assert.notEqual(index, -1, `current query exposes exact board component ${ref}`);
  const row = rows.nth(index);
  await row.waitFor({ state: 'visible', timeout: 20000 });
  assert.equal((await row.locator('.component-ref').innerText()).trim(), ref, `current query exposes exact board component ${ref}`);
  return row;
};

async function run(ctx) {
  const pageAtStart = ctx.getPage();
  const { knownBoard, knownSchematic, nativePdf, scannedPdf, svg, eagle, hierarchicalKicad } = await registerViewerFixtures(ctx);
  await installBoardRasterHistoryObserver(pageAtStart);

  await ctx.step('viewer scenarios begin on their generated known board with exact U1, U10, and VCC targets', async () => {
    let page = ctx.getPage();
    await ctx.withOpenDialog([knownBoard], async () => { await page.locator('[data-testid=open-board]').click(); });
    page = ctx.getPage();
    await page.waitForFunction(() => /viewer-known-board\.cad/i.test(document.querySelector('.project-subtitle')?.textContent || ''), null, { timeout: 30000 });
    await selectBoardTab(page);
    await page.waitForSelector('[data-testid=board-pane] canvas', { timeout: 30000 });
    const targetCounts = await ctx.waitBoard({ components: 3, pins: 6, nets: 2, target: knownBoard });
    assert.deepEqual({ components: targetCounts.components, pins: targetCounts.pins, nets: targetCounts.nets },
      { components: 3, pins: 6, nets: 2 }, 'the actual runner target is the exact generated known board');
    await settle(page);
    const search = page.locator('[data-testid=search-input]');
    await search.fill('U1');
    await waitForExactComponentRow(page, 'U1');
    const componentRows = page.locator('[data-testid=search-row][data-source="board-components"]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=search-row][data-source="board-components"]')].some(row => row.textContent?.includes('U10')));
    const refs = (await componentRows.locator('.component-ref').allTextContents()).map(text => text.trim()).sort();
    assert.deepEqual(refs, ['U1', 'U10']);
    await search.fill('VCC');
    const netRow = page.locator('[data-testid=search-row][data-source="board-nets"]').filter({ hasText: 'VCC' }).first();
    await netRow.waitFor({ state: 'visible', timeout: 20000 });
    assert.equal((await netRow.locator('.component-ref').innerText()).trim(), 'VCC');
    return { board: 'viewer-known-board.cad', counts: { components: targetCounts.components, pins: targetCounts.pins, nets: targetCounts.nets }, refs, net: 'VCC' };
  });

  await ctx.step('board canvas renders a visible bounded scene and fit returns the full synthetic board', async () => {
    const page = ctx.getPage();
    const initial = await camera(page);
    assert.equal(initial.canvas, true, 'board canvas is present');
    assert.ok(initial.rect.width > 200 && initial.rect.height > 160, JSON.stringify(initial));
    const beforeZoom = Number.parseFloat(initial.zoom);
    assert.ok(Number.isFinite(beforeZoom), `board zoom is visible: ${initial.zoom}`);
    await page.getByRole('button', { name: /zoom in/i }).click();
    await page.waitForFunction(old => Number.parseFloat(document.querySelector('[data-testid=zoom-value]')?.textContent || '0') > old, beforeZoom);
    await settle(page);
    const zoomed = await camera(page, { paint: true });
    await page.getByRole('button', { name: /fit/i }).click();
    const expectedScale = Math.min(Math.max(1, initial.rect.width - 120) / 40, Math.max(1, initial.rect.height - 120) / 30);
    await page.waitForFunction(() => Math.abs(Number.parseFloat(document.querySelector('[data-testid=zoom-value]')?.textContent || '0') - 100) < 0.5);
    await settle(page);
    const fitted = await camera(page, { paint: true });
    assert.ok(fitted.rect.width > 200 && fitted.rect.height > 160);
    assert.equal(fitted.rotation, '0', 'known-board geometry is derived only from an ordinary unrotated fit');
    assert.equal(fitted.side, 'top', 'known-board geometry is derived only from the ordinary top side');
    assert.equal(fitted.zoom, '100%', 'the actual fitted scale is captured before deriving the known board center');
    assert.notEqual(fitted.paint, zoomed.paint, 'Fit redraws the board at the calculated 40 × 30 mm full-board scale');
    const expectedFitCamera = { zoom: expectedScale, x: 20, y: 15, rotation: 0, side: 'top' };
    const fitProfile = await waitForPersistedCamera(ctx, knownBoard, buildKnownBoardFixture(), expectedFitCamera, { tolerance: 0.02 });
    await ctx.screenshot('viewers-board-fit');
    return { initialZoom: initial.zoom, zoomAfterFit: fitted.zoom, fullBoardMm: { width: 40, height: 30 }, expectedFitCamera, persistedFitCamera: fitProfile.camera, canvas: fitted.rect, redraw: fitted.paint };
  });

  await ctx.step('board pan, rotation, top/bottom side controls, and keyboard camera commands act on the live canvas', async () => {
    const page = ctx.getPage();
    const initialProfile = await persistedWorkspace(ctx, knownBoard, buildKnownBoardFixture());
    const canvas = await requireSelector(page, '[data-testid=board-pane] canvas');
    const canvasBox = await canvas.boundingBox();
    assert.ok(canvasBox, 'fitted canvas has measured dimensions for the known-board camera oracle');
    const expectedFitScale = fittedScale(canvasBox);
    const rotatedFitScale = Math.min(Math.max(1, canvasBox.width - 120) / 30, Math.max(1, canvasBox.height - 120) / 40);
    assertCameraClose(initialProfile.camera, { zoom: expectedFitScale, x: 20, y: 15, rotation: 0, side: 'top' }, 0.02);
    await settleBoardSelection(page, { clearWithCanvas: true });
    const persistableScale = await setPersistableCameraScale(page, canvasBox, expectedFitScale);
    assert.ok(Math.abs(persistableScale.actualScale - persistableScale.targetScale) < 0.00005, 'the actual wheel event lands on a camera zoom representable at four decimal places');
    let expectedCamera = cameraAfterWheel({ zoom: expectedFitScale, x: 20, y: 15, rotation: 0, side: 'top' }, canvasBox, persistableScale.wheel, persistableScale.actualScale);
    await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid=board-pane] canvas');
      window.__viewerPointerObservation = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup']) canvas.addEventListener(type, event => window.__viewerPointerObservation.push({ type, clientX: event.clientX, clientY: event.clientY }), { capture: true });
    });
    const alignment = dragToPersistedCenter(expectedCamera);
    const start = { x: canvasBox.x + canvasBox.width * 0.45, y: canvasBox.y + canvasBox.height * 0.5 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + alignment.delta.x, start.y + alignment.delta.y, { steps: 4 });
    await page.mouse.up();
    const pointerEvents = await page.evaluate(() => window.__viewerPointerObservation || []);
    const observedAlignment = cameraAfterObservedDrag(expectedCamera, pointerEvents);
    expectedCamera = observedAlignment.camera;
    assert.equal(Math.round(expectedCamera.x * 1000) / 1000, alignment.target.x, 'ordinary drag places live camera x in the intended persisted millimetre bucket');
    assert.equal(Math.round(expectedCamera.y * 1000) / 1000, alignment.target.y, 'ordinary drag places live camera y in the intended persisted millimetre bucket');
    assert.equal(Math.round(expectedCamera.zoom * 10000) / 10000, persistableScale.targetScale, 'actual wheel transform places live zoom in the intended persisted scale bucket');
    const persistedGridCamera = { ...expectedCamera, zoom: Math.round(expectedCamera.zoom * 10000) / 10000, x: Math.round(expectedCamera.x * 1000) / 1000, y: Math.round(expectedCamera.y * 1000) / 1000 };
    const scaledCamera = await waitForPersistedCamera(ctx, knownBoard, buildKnownBoardFixture(), persistedGridCamera, { tolerance: 1e-7 });
    assertCameraClose(scaledCamera.camera, persistedGridCamera, 1e-7);
    const paintBefore = (await camera(page, { paint: true })).paint;
    assert.ok(paintBefore, 'board renderer exposes readable painted pixels for camera verification');
    const box = await canvas.boundingBox();
    assert.ok(box && box.width > 100 && box.height > 100, 'camera input has a usable canvas point');
    const dragDelta = { x: Math.round(box.width * 0.13), y: Math.round(box.height * 0.07) };
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.45 + dragDelta.x, box.y + box.height * 0.5 + dragDelta.y, { steps: 4 });
    await page.mouse.up();
    expectedCamera = panCamera(expectedCamera, dragDelta);
    const paintAfter = (await camera(page, { paint: true })).paint;
    assert.notEqual(paintAfter, paintBefore, 'dragging the board moves rendered geometry, not only the cursor/status readout');
    const afterDragProfile = await waitForPersistedCamera(ctx, knownBoard, buildKnownBoardFixture(), expectedCamera);
    const rotationBefore = await page.locator('.canvas-meta').innerText();
    await page.getByRole('button', { name: /rotate/i }).click();
    await page.waitForFunction(value => document.querySelector('.canvas-meta')?.textContent !== value, rotationBefore);
    expectedCamera = { ...expectedCamera, rotation: 90 };
    await page.locator('[data-testid=side-bottom]').click();
    await assert.equal(await page.locator('[data-testid=side-bottom]').getAttribute('aria-pressed'), 'true');
    expectedCamera = { ...expectedCamera, side: 'bottom' };
    await page.locator('[data-testid=side-top]').click();
    await assert.equal(await page.locator('[data-testid=side-top]').getAttribute('aria-pressed'), 'true');
    expectedCamera = { ...expectedCamera, side: 'top' };
    await canvas.focus();
    await page.keyboard.press('ArrowRight');
    await settle(page);
    expectedCamera = panCamera(expectedCamera, { x: -40, y: 0 });
    const delayedCamera = await waitForPersistedCamera(ctx, knownBoard, buildKnownBoardFixture(), expectedCamera, { timeout: 20000 });
    await navigateDocumentsToRestoreBoardCamera(page);
    await settleBoardSelection(page, { clearWithCanvas: true });
    await waitForStableBoardPaint(page);
    const normalizedCamera = await waitForPersistedCamera(ctx, knownBoard, buildKnownBoardFixture(), delayedCamera.camera, { tolerance: 1e-7 });
    assertCameraClose(normalizedCamera.camera, delayedCamera.camera, 1e-7);
    const beforePendingArrow = await camera(page, { paint: true });
    assert.equal(beforePendingArrow.zoom, `${Math.round(delayedCamera.camera.zoom / rotatedFitScale * 100)}%`, 'normal Documents and Board navigation restores the persisted zoom before the held keyboard pan');
    assert.equal(beforePendingArrow.rotation, `${delayedCamera.camera.rotation}`, 'normal Documents and Board navigation restores the persisted rotation before the held keyboard pan');
    await ctx.screenshot('viewers-camera-before-pending');
    await installCameraDebounceHold(page);
    let cameraHoldRestored = false;
    let rasterHistoryBeforeRestart = null;
    try {
      const pendingArrowBaseline = await boardPaintBaseline(page);
      await page.keyboard.press('ArrowDown');
      await page.waitForFunction(() => window.__traceViewerCameraDebounceHold?.held.some(timer => timer.delay === 350), null, { timeout: 5000 });
      await waitForStableBoardPaint(page, { baseline: pendingArrowBaseline });
      await settle(page);
      const pendingArrowFrame = await camera(page, { paint: true });
      assert.notEqual(pendingArrowFrame.paint, beforePendingArrow.paint, 'the pending ArrowDown changes the actual rendered board before restart');
      await page.waitForTimeout(500);
      const stillPendingCamera = await persistedWorkspace(ctx, knownBoard, buildKnownBoardFixture());
      assertCameraClose(stillPendingCamera.camera, delayedCamera.camera, 0.02);
      const pendingCamera = panCamera(delayedCamera.camera, { x: 0, y: -40 });
      assert.notEqual(stillPendingCamera.camera.x, pendingCamera.x,
        'after the real 350 ms debounce window, the changed canvas is still newer than the persisted camera');
      expectedCamera = pendingCamera;
      const heldTimers = await restoreCameraDebounceHold(page);
      cameraHoldRestored = true;
      assert.equal(heldTimers, 1, 'the harness held exactly one real 350 ms BoardCanvas camera debounce');
      await restartWithRasterHistory(page, () => ctx.restart(), snapshot => { rasterHistoryBeforeRestart = snapshot; });
      const restarted = ctx.getPage();
      await installBoardRasterHistoryObserver(restarted);
      const startup = await settleBoardStartup(restarted);
      await settle(restarted);
      await settleBoardSelection(restarted, { clearWithCanvas: true });
      await waitForStableBoardPaint(restarted);
      const afterRestart = await camera(restarted, { paint: true });
      const rasterHistoryAfterRestart = await boardRasterHistory(restarted);
      const afterProfileRestart = await waitForPersistedCamera(ctx, knownBoard, buildKnownBoardFixture(), expectedCamera, { timeout: 20000 });
      assert.equal(afterProfileRestart.key, delayedCamera.key, 'normal restart preserves the active board content hash');
      assert.equal(await sameCanonicalPath(afterProfileRestart.path, delayedCamera.path), true, 'normal restart preserves the active board path');
      assertCameraClose(afterProfileRestart.camera, expectedCamera, 0.02);
      assert.equal(afterRestart.zoom, `${Math.round(expectedCamera.zoom / rotatedFitScale * 100)}%`, 'the pending camera zoom is restored after normal restart');
      assert.equal(await restarted.locator('[data-testid=side-top]').getAttribute('aria-pressed'), 'true', 'the persisted top side is restored');
      assert.equal(afterRestart.paint, pendingArrowFrame.paint, 'the settled canvas after restart matches the actual pending ArrowDown frame');
      await ctx.screenshot('viewers-camera-after-restart');
      await ctx.screenshot('viewers-board-transformed-after-restart');
      return { panned: true, keyboardPan: true, rotationChanged: true, delayedCameraEmission: delayedCamera.camera, restartFlushedPendingPan: true, sideRestored: 'top', activeBoardHash: afterProfileRestart.key, activeBoardPath: afterProfileRestart.path, initialPersistedCamera: initialProfile.camera, afterDragCamera: afterDragProfile.camera, expectedTransformedCamera: expectedCamera, transformedPersistedCamera: afterProfileRestart.camera, pendingArrowFrame: pendingArrowFrame.paint, restoredFrame: afterRestart.paint, supportNoticeSkippedAfterRestart: startup.noticeSkipped, rasterHistoryBeforeRestart, rasterHistoryAfterRestart, viewRestored: afterRestart };
    } finally {
      if (!cameraHoldRestored) await restoreCameraDebounceHold(page);
      if (!rasterHistoryBeforeRestart) {
        try { rasterHistoryBeforeRestart = await boardRasterHistory(page); } catch { /* Preserve failures when restart already closed the page. */ }
      }
    }
  });

  await ctx.step('current exact reference and net result activation selects only the requested board target', async () => {
    const page = ctx.getPage();
    const input = page.locator('[data-testid=search-input]');
    const workers = page.workers();
    assert.ok(workers.length > 0, 'the packaged board model worker is running');
    const instrumented = [];
    for (const worker of workers) {
      await worker.evaluate(() => {
        if (self.__traceViewerQA) return;
        const original = self.postMessage.bind(self);
        self.__traceViewerQA = { original, held: [], holdOldQuery: false, oldHeld: false, notify: null };
        self.postMessage = (message, transfer) => {
          const qa = self.__traceViewerQA;
          if (qa.holdOldQuery && message?.type === 'search' && message.result?.query?.trim().toUpperCase() === 'U1') {
            qa.held.push({ message, transfer }); qa.oldHeld = true; qa.notify?.(); qa.notify = null; return;
          }
          return original(message, transfer);
        };
      });
      instrumented.push(worker);
    }
    try {
      for (const worker of instrumented) await worker.evaluate(() => { if (self.__traceViewerQA) { self.__traceViewerQA.holdOldQuery = true; self.__traceViewerQA.oldHeld = false; } });
      await input.fill('U1');
      const heldOn = Date.now() + 20000;
      let oldResultHeld = false;
      while (Date.now() < heldOn && !oldResultHeld) {
        for (const worker of instrumented) oldResultHeld ||= await worker.evaluate(() => !!self.__traceViewerQA?.oldHeld);
        if (!oldResultHeld) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(oldResultHeld, true, 'the real worker response for the older U1 query was deterministically deferred');
      await input.fill('U10');
      const currentRow = await waitForExactComponentRow(page, 'U10');
      const refText = await currentRow.innerText();
      assert.doesNotMatch(refText, /\bU1\b/, 'U10 is not confused with U1');
      await input.press('Enter');
      await page.waitForFunction(() => /U10/.test(document.querySelector('[data-testid=inspector]')?.textContent || ''));
      const selectedPin = page.locator('[data-testid=pin-row]').first();
      await selectedPin.waitFor({ state: 'visible', timeout: 15000 });
      await selectedPin.click();
      await assert.equal(await selectedPin.getAttribute('aria-pressed'), 'true');
      for (const worker of instrumented) await worker.evaluate(() => {
        const qa = self.__traceViewerQA;
        if (!qa) return;
        qa.holdOldQuery = false;
        for (const entry of qa.held.splice(0)) qa.original(entry.message, entry.transfer);
      });
      await page.waitForTimeout(25);
      assert.match(await page.locator('[data-testid=inspector]').innerText(), /U10/,
        'releasing the late U1 response does not replace the current U10 selection');
      const netText = await activateSearch(page, 'VCC', 'board-nets', 'VCC');
      assert.match(netText, /VCC/);
      await page.waitForFunction(() => /VCC/.test(document.querySelector('[data-testid=inspector]')?.textContent || '') || /VCC/.test(document.querySelector('[data-testid=status-source]')?.textContent || ''));
      return { exactReference: 'U10', exactPinSelected: true, staleQuery: 'U1', staleResponseReleased: true, net: 'VCC', activatedBy: 'Enter and mouse click' };
    } finally {
      for (const worker of instrumented) await worker.evaluate(() => {
        const qa = self.__traceViewerQA;
        if (!qa) return;
        qa.holdOldQuery = false;
        for (const entry of qa.held.splice(0)) qa.original(entry.message, entry.transfer);
        self.postMessage = qa.original; delete self.__traceViewerQA;
      });
    }
  });

  await ctx.step('a late current query cannot activate completed stale U1 rows by mouse or Enter', async () => {
    const page = ctx.getPage();
    const input = page.locator('[data-testid=search-input]');
    const workers = page.workers();
    assert.ok(workers.length > 0, 'the packaged board model worker is running for stale-row fencing');
    const instrumented = [];
    for (const worker of workers) {
      await worker.evaluate(() => {
        if (self.__traceViewerQA) return;
        const original = self.postMessage.bind(self);
        self.__traceViewerQA = { original, held: [], holdOldQuery: false, oldHeld: false, holdNewQuery: false, newHeld: false, notify: null };
        self.postMessage = (message, transfer) => {
          const qa = self.__traceViewerQA;
          if (qa.holdNewQuery && message?.type === 'search' && message.result?.query?.trim().toUpperCase() === 'U10') {
            qa.held.push({ message, transfer }); qa.newHeld = true; qa.notify?.(); qa.notify = null; return;
          }
          return original(message, transfer);
        };
      });
      instrumented.push(worker);
    }
    try {
      await activateSearch(page, 'VCC', 'board-nets', 'VCC');
      await page.waitForFunction(() => /VCC/.test(document.querySelector('[data-testid=inspector]')?.textContent || ''));
      const exactPriorSelection = await page.locator('[data-testid=inspector]').innerText();
      await input.fill('U1');
      const completedU1 = page.locator('[data-testid=search-row][data-source="board-components"]').filter({ hasText: 'U1' }).first();
      await completedU1.waitFor({ state: 'visible', timeout: 20000 });
      const completedRowText = await completedU1.innerText();
      assert.equal(completedRowText.split(/\r?\n/)[0].trim(), 'U1', 'the earlier U1 query has completed with its exact row before the newer query starts');
      const oldRowBox = await completedU1.boundingBox();
      assert.ok(oldRowBox, 'the completed U1 row has a mouse target before it becomes stale');
      for (const worker of instrumented) await worker.evaluate(() => { if (self.__traceViewerQA) { self.__traceViewerQA.holdNewQuery = true; self.__traceViewerQA.newHeld = false; } });
      await input.fill('U10');
      const heldOn = Date.now() + 20000;
      let newResultHeld = false;
      while (Date.now() < heldOn && !newResultHeld) {
        for (const worker of instrumented) newResultHeld ||= await worker.evaluate(() => !!self.__traceViewerQA?.newHeld);
        if (!newResultHeld) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(newResultHeld, true, 'the actual U10 worker result is held while U1 is stale');
      await page.mouse.click(oldRowBox.x + oldRowBox.width / 2, oldRowBox.y + oldRowBox.height / 2);
      await input.press('Enter');
      assert.equal(await page.locator('[data-testid=inspector]').innerText(), exactPriorSelection, 'mouse at the former U1 row and Enter cannot change the exact prior selection while U10 is pending');
      const visibleRefs = await page.locator('[data-testid=search-row][data-source="board-components"] .component-ref').allTextContents();
      assert.deepEqual(visibleRefs, [], 'pending U10 rows are empty while the exact worker response is held');
      for (const worker of instrumented) await worker.evaluate(() => {
        const qa = self.__traceViewerQA;
        if (!qa) return;
        qa.holdNewQuery = false;
        for (const entry of qa.held.splice(0)) qa.original(entry.message, entry.transfer);
      });
      await waitForExactComponentRow(page, 'U10');
      await input.press('Enter');
      await page.waitForFunction(() => /\bU10\b/.test(document.querySelector('[data-testid=inspector]')?.textContent || '') && !/\bU1\b(?!0)/.test(document.querySelector('[data-testid=inspector]')?.textContent || ''));
      return { completedQuery: 'U1', heldCurrentQuery: 'U10', staleMouseAndEnterPreservedSelection: true, currentActivation: 'U10' };
    } finally {
      for (const worker of instrumented) await worker.evaluate(() => {
        const qa = self.__traceViewerQA;
        if (!qa) return;
        qa.holdNewQuery = false;
        for (const entry of qa.held.splice(0)) qa.original(entry.message, entry.transfer);
        self.postMessage = qa.original; delete self.__traceViewerQA;
      });
    }
  });

  await ctx.step('search Enter activation and IME composition preserve the current partial query until composition ends', async () => {
    const page = ctx.getPage();
    const input = page.locator('[data-testid=search-input]');
    await input.fill('U1');
    await waitForExactComponentRow(page, 'U1');
    await input.press('Enter');
    await page.waitForFunction(() => /\bU1\b/.test(document.querySelector('[data-testid=inspector]')?.textContent || '') && !/\bU10\b/.test(document.querySelector('[data-testid=inspector]')?.textContent || ''));
    const baselineInspector = await page.locator('[data-testid=inspector]').innerText();
    assert.match(baselineInspector, /\bU1\b/);
    assert.doesNotMatch(baselineInspector, /\bU10\b/);
    await input.fill('U');
    await input.evaluate(el => { el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    await input.evaluate(el => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'U10');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: '10', inputType: 'insertCompositionText', isComposing: true }));
    });
    await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, isComposing: true })));
    assert.equal(await input.inputValue(), 'U10', 'the partial IME composition remains in the input');
    assert.equal(await page.locator('[data-testid=inspector]').innerText(), baselineInspector, 'IME-marked Enter leaves the exact pre-composition selection unchanged');
    assert.equal(await input.evaluate(el => document.activeElement === el), true, 'IME-marked Enter keeps focus in the search input');
    await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'U10' })));
    await waitForExactComponentRow(page, 'U10');
    await input.press('Enter');
    await page.waitForFunction(() => /\bU10\b/.test(document.querySelector('[data-testid=inspector]')?.textContent || ''));
    const committedInspector = await page.locator('[data-testid=inspector]').innerText();
    assert.match(committedInspector, /\bU10\b/, 'a normal Enter after composition commit selects exact U10');
    assert.doesNotMatch(committedInspector, /\bU1\b(?!0)/, 'committed U10 is not treated as U1');
    return { normalEnterBaseline: 'U1', composingEnterPreservedSelectionAndFocus: true, committedQuery: 'U10' };
  });

  await ctx.step('an attached KiCad baseline cross-probes the current board and native hierarchy remains selectable', async () => {
    const page = ctx.getPage();
    await attachFromDialog(ctx, [knownSchematic]);
    await openDocument(ctx, 'viewer-known-board.kicad_sch');
    const canvas = await requireSelector(page, '.schv-canvas');
    const summary = await canvas.getAttribute('aria-label');
    assert.ok(summary && /sheet|symbol|schematic/i.test(summary), `structured schematic accessibility summary exists: ${summary}`);
    const state = await page.locator('[data-testid=schematic-diagnostics]').innerText();
    assert.match(state, /KiCad/i);
    const bounds = await canvas.boundingBox();
    assert.ok(bounds && bounds.width > 100 && bounds.height > 100);
    await canvas.focus();
    await page.keyboard.press('Home');
    await settle(page);
    const symbolRow = page.locator('[data-testid=search-row][data-source="schematic-symbols"]').filter({ hasText: 'U1' }).first();
    await page.locator('[data-testid=search-input]').fill('U1');
    await symbolRow.waitFor({ state: 'visible', timeout: 20000 });
    await symbolRow.click();
    await page.waitForFunction(() => document.querySelector('[data-testid=tab-schematic]')?.getAttribute('aria-selected') === 'true');
    assert.match(await symbolRow.getAttribute('class') || '', /selected/, 'the exact schematic U1 row is selected after cross-probe');
    assert.match(await page.locator('[data-testid=inspector]').innerText(), /U1/, 'the attached schematic U1 resolves against the current board U1 target');
    const netRow = page.locator('[data-testid=search-row][data-source="schematic-nets"]').filter({ hasText: 'VCC' }).first();
    await page.locator('[data-testid=search-input]').fill('VCC');
    await netRow.waitFor({ state: 'visible', timeout: 20000 });
    await netRow.click();
    assert.match(await netRow.getAttribute('class') || '', /selected/, 'the exact schematic VCC net is selected after cross-probe');
    assert.match(await page.locator('[data-testid=inspector]').innerText(), /VCC/, 'the attached schematic VCC resolves against the current board VCC net');
    await page.getByRole('button', { name: /fit/i }).click();
    const pinPoint = await page.evaluate(() => {
      const root = document.querySelector('.schv'), canvas = document.querySelector('.schv-canvas');
      const rect = canvas?.getBoundingClientRect(), view = root?.dataset.view?.split(',').map(Number);
      if (!rect || !view || view.length < 3) return null;
      const [cx, cy, scale] = view;
      const x = 20, y = 16.19;
      return { x: rect.left + rect.width / 2 + (x - cx) * scale, y: rect.top + rect.height / 2 + (y - cy) * scale };
    });
    assert.ok(pinPoint && Number.isFinite(pinPoint.x) && Number.isFinite(pinPoint.y), 'synthetic schematic pin has a measurable canvas position');
    await page.mouse.click(pinPoint.x, pinPoint.y);
    const liveStatus = page.locator('.schv-sr[role=status]');
    await page.waitForFunction(() => /Pin U1 [12] selected/.test(document.querySelector('.schv-sr[role=status]')?.textContent || ''), null, { timeout: 15000 });
    const pinAnnouncement = await liveStatus.innerText();
    assert.match(pinAnnouncement, /Pin U1 [12] selected/, 'mouse hit testing selects an exact schematic reference and pin');
    await attach(ctx, [eagle]);
    await openDocument(ctx, 'viewer-hierarchical.eagle.sch');
    const eagleDiag = await page.locator('[data-testid=schematic-diagnostics]').innerText();
    assert.match(eagleDiag, /EAGLE/i, 'the second synthetic multi-sheet schematic was parsed as EAGLE');
    await page.locator('[data-testid=search-input]').fill('U1');
    const eagleSymbol = page.locator('[data-testid=search-row][data-source="schematic-symbols"]').filter({ hasText: 'U1' }).first();
    await eagleSymbol.waitFor({ state: 'visible', timeout: 20000 });
    await eagleSymbol.click();
    assert.match(await page.locator('[data-testid=inspector]').innerText(), /U1/, 'the EAGLE U1 reference is matched to the current board target');
    const sheets = page.locator('.schv-nav .schv-row-main');
    await sheets.nth(1).waitFor({ state: 'visible', timeout: 15000 });
    await sheets.nth(1).click();
    await page.waitForFunction(() => /page 2/i.test(document.querySelector('.schv-canvas')?.getAttribute('aria-label') || ''));
    await attach(ctx, [hierarchicalKicad]);
    await openDocument(ctx, 'viewer-hierarchical.kicad_sch');
    const hierarchyDiagnostics = await page.locator('[data-testid=schematic-diagnostics]').innerText();
    assert.match(hierarchyDiagnostics, /KiCad/i, 'authored hierarchical KiCad fixture is recognized by the native schematic viewer');
    const childSymbol = page.locator('[data-testid=search-row][data-source="schematic-symbols"]').filter({ hasText: 'U10' }).first();
    await page.locator('[data-testid=search-input]').fill('U10');
    await childSymbol.waitFor({ state: 'visible', timeout: 20000 });
    await childSymbol.click();
    assert.match(await childSymbol.getAttribute('class') || '', /selected/, 'the child sheet instance resolves to its exact U10 symbol');
    const hierarchySymbolText = await childSymbol.innerText();
    assert.match(hierarchySymbolText, /Channel/i, 'the child sheet name is present on its own R1 instance in the packaged hierarchy');
    return { structuredCanvas: true, exactReferenceCrossProbe: 'U1', exactNetCrossProbe: 'VCC', exactSchematicPin: pinAnnouncement, kicadDiagnostics: state.slice(0, 180), eagleDiagnostics: eagleDiag.slice(0, 160), eagleSheetNavigation: 2, eagleReferenceCrossProbe: 'U1', kicadHierarchyReference: 'U10', kicadHierarchySheet: hierarchySymbolText.slice(0, 120), hierarchyDiagnostics: hierarchyDiagnostics.slice(0, 180), canvas: bounds };
  });

  await ctx.step('PDF actual text search, scanned OCR text, page navigation, bookmark and page annotation work', async () => {
    const page = ctx.getPage();
    await attach(ctx, [nativePdf, scannedPdf]);
    await openDocument(ctx, 'viewer-native-text.pdf');
    await page.waitForSelector('.pdfv-page[data-page="1"][data-render="done"]', { timeout: 30000 });
    const search = page.locator('.pdfv-search-input');
    await search.fill('TRACE-VIEWER-ALPHA');
    await page.waitForFunction(() => Number(document.querySelector('[data-testid=pdfv-count]')?.textContent?.match(/\d+/)?.[0] || 0) > 0);
    assert.ok(await page.locator('.pdfv-hit').count() > 0, 'native PDF text search paints a hit on the rendered page');
    await page.getByRole('button', { name: /next page/i }).click();
    await page.waitForFunction(() => document.querySelector('.pdfv')?.getAttribute('data-page') === '2');
    await page.getByRole('button', { name: /previous page/i }).click();
    await page.waitForFunction(() => document.querySelector('.pdfv')?.getAttribute('data-page') === '1');
    await page.getByRole('button', { name: /add bookmark/i }).click();
    await page.locator('[data-tab=bookmarks]').click();
    await page.waitForFunction(() => document.querySelectorAll('.pdfv-bm').length === 1);
    await page.getByRole('button', { name: /add note/i }).click();
    await page.locator('.pdfv-page[data-page="1"]').click({ position: { x: 120, y: 120 } });
    const noteEditor = page.getByRole('dialog', { name: /note/i });
    await noteEditor.waitFor({ state: 'visible' });
    await noteEditor.locator('textarea').fill('viewer page annotation');
    await noteEditor.getByRole('button', { name: /done/i }).click();
    await page.waitForSelector('.pdfv-note', { timeout: 10000 });
    await openDocument(ctx, 'viewer-scanned-text.pdf');
    await page.locator('[data-action=recognize-text]').click();
    await page.waitForSelector('.pdfv-ocr-badge', { timeout: 120000 });
    const recognized = await page.locator('.pdfv-text-ocr').innerText();
    assert.match(recognized, /TRACE-VIEWER-OCR/i);
    assert.match(recognized, /U10/);
    const exactProbe = page.locator('.pdfv-probe.is-ocr[aria-label^="U10,"]').first();
    await exactProbe.waitFor({ state: 'visible', timeout: 15000 });
    await exactProbe.click();
    await page.waitForFunction(() => /U10/.test(document.querySelector('[data-testid=inspector]')?.textContent || ''));
    const beforeRotate = await page.locator('.pdfv').getAttribute('data-rotation');
    await page.getByRole('button', { name: /rotate clockwise/i }).click();
    await page.waitForFunction(value => document.querySelector('.pdfv')?.getAttribute('data-rotation') !== value, beforeRotate);
    await ctx.screenshot('viewers-pdf-text-and-ocr');
    return { nativeTextSearch: true, pageNavigation: '1→2→1', scannedOcr: recognized.slice(0, 160), exactOcrClickThrough: 'U10', pageAnnotation: true, bookmarkCount: 1, rotationChanged: true };
  });

  await ctx.step('PNG, JPEG, and WebP decode through the packaged image viewer', async () => {
    const page = ctx.getPage();
    const encoded = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 160;
      const context = canvas.getContext('2d');
      for (const [x, y, color] of [[0, 0, '#e34d46'], [120, 0, '#48a86a'], [0, 80, '#426be0'], [120, 80, '#e0bb40']]) {
        context.fillStyle = color; context.fillRect(x, y, 120, 80);
      }
      context.fillStyle = '#111'; context.font = 'bold 18px sans-serif'; context.fillText('TRACE IMAGE', 12, 76);
      return ['image/png', 'image/jpeg', 'image/webp'].map(type => ({ type, data: canvas.toDataURL(type) }));
    });
    const names = [];
    for (const [index, type] of ['image/png', 'image/jpeg', 'image/webp'].entries()) {
      const payload = encoded[index];
      assert.equal(payload.type, type);
      assert.ok(payload.data.startsWith(`data:${type};base64,`), `browser encoded a synthetic ${type} fixture`);
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type];
      names.push(await ctx.registerFixture(`viewer-raster.${ext}`, Buffer.from(payload.data.split(',')[1], 'base64')));
    }
    await attach(ctx, names);
    const decoded = [];
    for (const [index, name] of ['viewer-raster.png', 'viewer-raster.jpg', 'viewer-raster.webp'].entries()) {
      await openDocument(ctx, name);
      const info = await page.locator('.imgv-surface').getAttribute('aria-label');
      assert.match(info || '', /240 by 160 pixels/i, `${name} reports its actual decoded dimensions`);
      const rendered = await page.locator('.imgv-canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
      assert.ok(rendered.width >= 240 && rendered.height >= 160, `${name} has a painted viewer canvas`);
      decoded.push({ name, dimensions: info, painted: rendered });
    }
    return { encodedTypes: encoded.map(item => item.type), decoded };
  });

  await ctx.step('sanitized SVG opens in the image viewer, strips active content, and supports calibration, rotation, bookmarks, and notes', async () => {
    const page = ctx.getPage();
    await attach(ctx, [svg]);
    await openDocument(ctx, 'viewer-sanitized.svg');
    const surface = await requireSelector(page, '.imgv-surface');
    await page.waitForFunction(() => document.querySelector('.imgv')?.getAttribute('data-phase') === 'ready');
    const security = await page.evaluate(() => ({ executed: window.__viewerSvgExecuted === true, removed: document.querySelector('.imgv-removed')?.innerText || '' }));
    assert.equal(security.executed, false, 'embedded SVG script did not execute');
    assert.match(security.removed, /script|foreignObject/i, 'sanitizer reports removed active SVG elements');
    await page.getByRole('button', { name: /rotate clockwise/i }).click();
    const rotated = await surface.getAttribute('aria-label');
    assert.match(rotated || '', /240 by 160/i);
    await page.getByRole('button', { name: /bookmark/i }).click();
    await page.getByRole('button', { name: /bookmarks and notes/i }).click();
    await page.waitForFunction(() => document.querySelectorAll('.imgv-row').length >= 1);
    const calib = page.getByRole('button', { name: /calibrat/i });
    await calib.click();
    const box = await surface.boundingBox();
    assert.ok(box && box.width > 100 && box.height > 100);
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.5);
    await page.locator('.imgv-input').first().fill('100');
    await page.getByRole('button', { name: /set scale/i }).click();
    await page.getByRole('button', { name: /note/i }).first().click();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const editor = page.getByRole('dialog', { name: /new note/i });
    await editor.locator('textarea').fill('image viewer annotation');
    await editor.getByRole('button', { name: /^save$/i }).click();
    await page.waitForFunction(() => document.querySelectorAll('.imgv-row').length >= 2);
    await ctx.screenshot('viewers-sanitized-svg');
    return { svgSecurity: security, rotation: rotated, bookmarkCreated: true, calibrationApplied: true, noteCreated: true };
  });

  // Do not cache the page across any helper that could restart the runtime.
  assert.ok(ctx.getPage() === pageAtStart || ctx.getPage(), 'viewer module retains a live runner page');
}

module.exports = Object.freeze({ boardPaintBaseline, boardRasterHistory, buildKnownBoardFixture, buildKicadHierarchyFixtures, camera, cameraAfterObservedDrag, cameraAfterWheel, dragToPersistedCenter, fittedScale, installBoardRasterHistoryObserver, navigateDocumentsToRestoreBoardCamera, panCamera, registerViewerFixtures, restartWithRasterHistory, sameCanonicalPath, sameCanonicalPathStrings, selectBoardTab, setPersistableCameraScale, settleBoardSelection, waitForStableBoardPaint, run });
