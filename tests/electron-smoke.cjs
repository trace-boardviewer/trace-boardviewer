'use strict';

// The one real-Electron smoke test for the native layer: the actual electron/main.cjs + preload.cjs in an
// Electron 44 window, driven through Playwright's Electron support. It proves what mocks cannot:
// the context bridge surface, structured clone of bytes, the machine code of rejected invokes
// (error.code survives the bridge), the quit-time write rejection and the document/workspace
// round trip. A tiny local HTTP page stands in for the UI (main.cjs accepts a local dev-server URL).
//
//   TRACE_ELECTRON_SMOKE=1 xvfb-run -a node --test tests/electron-smoke.cjs
//
// `--no-sandbox` is passed here only because the container runs as root; the application itself keeps
// sandbox: true for its window. TRACE_ACCEPT_NO_SANDBOX=1 answers the question main.cjs asks on Linux before it starts without
// the Chromium sandbox. Skipped unless TRACE_ELECTRON_SMOKE=1 (needs a display and Electron).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const i18n = require('../electron/i18n.cjs');

const ROOT = path.resolve(__dirname, '..');
const enabled = process.env.TRACE_ELECTRON_SMOKE === '1';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// The electron package exports the path of its binary; resolving it (instead of assuming ROOT/node_modules) also works for a checkout
// whose packages are installed higher up the directory tree.
const electronExecutable = () => require('electron');
const NOW = '2026-03-04T05:06:07.000Z';

test('real Electron: bridge surface, native errors with codes, workspace and documents, quit-time writes', { skip: !enabled && 'set TRACE_ELECTRON_SMOKE=1 and run under xvfb-run', timeout: 120000 }, async (t) => {
  const { _electron } = require('playwright');
  const fflate = require('fflate');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-electron-smoke-'));
  const server = http.createServer((request, response) => {
    // Stand-in for api.github.com in the update sub-test: the releases/latest answer, hostile html_url included (main.cjs must never use it).
    if (request.url === '/__latest-release') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ tag_name: 'v99.0.0', draft: false, prerelease: false, html_url: 'https://evil.example/phish', name: 'x', body: 'y' }));
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>TRACE smoke</title><body>smoke</body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let app;
  t.after(async () => {
    if (app) await app.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await fs.rm(absolute, { recursive: true, force: true });
  });

  const profile = path.join(root, 'profile');
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'docs'), { recursive: true });
  const trio = { 'format.asc': 'F', 'pins.asc': 'PP', 'nails.asc': 'NNN' };
  for (const [name, text] of Object.entries(trio)) await fs.writeFile(path.join(project, name), text);
  const boardFile = path.join(project, 'Board.cad');
  const BOARD = '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n';
  await fs.writeFile(boardFile, BOARD);
  const PDF = Buffer.from('%PDF-1.4\n% synthetic\n%%EOF\n');
  const pdfFile = path.join(project, 'docs', 'ref.pdf');
  await fs.writeFile(pdfFile, PDF);

  const env = { ...process.env, TRACE_ACCEPT_NO_SANDBOX: '1', VITE_DEV_SERVER_URL: `http://127.0.0.1:${server.address().port}/` };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: electronExecutable(),
    args: ['--no-sandbox', ROOT, `--user-data-dir=${profile}`], env, timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.traceDesktop), null, { timeout: 30000 });
  // Rejections come back as plain data. `code` is read from the "[CODE] " message prefix (the contract);
  // `bridgeCode` is error.code as the renderer sees it: undefined, because the bridge copies messages only.
  // `source` is the text of an arrow function. It is evaluated to a handle and the argument travels as data (Playwright's own argument
  // serialization): no code is assembled from strings or from serialized values.
  const run = async (source, argument) => {
    const callable = await page.evaluateHandle(source);
    try {
      return await page.evaluate(async ([fn, input]) => {
        try { return { ok: true, value: await fn(input) }; } catch (error) {
          const match = /^\[([A-Z][A-Z0-9_]+)\] /.exec(error.message);
          return { ok: false, name: error.name, message: error.message, code: match ? match[1] : undefined, bridgeCode: error.code };
        }
      }, [callable, argument ?? null]);
    } finally { await callable.dispose(); }
  };

  await t.test('the bridge exposes the TraceDesktop API and nothing generic', async () => {
    const names = await page.evaluate(() => Object.keys(window.traceDesktop).sort());
    assert.deepEqual(names, [
      'acceptBoard', 'checkForUpdates', 'close', 'droppedFilePath', 'exportWorkspace', 'getNotes', 'getSettings', 'initialBoard', 'isMaximized', 'loadWorkspace', 'locateDocuments', 'maximize',
      'minimize', 'onFlushRequest', 'onMaximized', 'onOpenBoard', 'openBoard', 'openSupportLink', 'openUpdatePage', 'pickDocuments', 'readBoard', 'readDocument', 'recentBoards', 'saveNotes', 'saveSettings', 'saveWorkspace',
    ]);
    assert.equal(await page.evaluate(() => typeof window.ipcRenderer + typeof window.require + typeof window.process), 'undefinedundefinedundefined');
  });

  await t.test('boards: bytes cross the bridge as Uint8Array; the ASC key is the same from every entry file', async () => {
    const board = await run('(path) => window.traceDesktop.readBoard(path).then((p) => ({ name: p.name, key: p.key, type: Object.prototype.toString.call(p.data), length: p.data.byteLength, text: new TextDecoder().decode(p.data) }))', boardFile);
    assert.deepEqual(board.value, { name: 'Board.cad', key: sha256(BOARD), type: '[object Uint8Array]', length: BOARD.length, text: BOARD });
    const keys = new Set();
    for (const name of Object.keys(trio)) {
      const result = await run('(path) => window.traceDesktop.readBoard(path).then((p) => ({ key: p.key, companions: Object.keys(p.companions ?? {}).sort() }))', path.join(project, name));
      keys.add(result.value.key);
      assert.equal(result.value.companions.length, 2, name);
    }
    assert.equal(keys.size, 1, 'one identity for the whole set');
  });

  await t.test('settings and notes (pin notes with measurements) round-trip; a duplicate target is rejected', async () => {
    const settings = (await run('() => window.traceDesktop.getSettings()')).value;
    const saved = await run('(s) => window.traceDesktop.saveSettings(s).then(() => window.traceDesktop.getSettings())', { ...settings, theme: 'light' });
    assert.equal(saved.value.theme, 'light');
    const key = sha256(BOARD);
    const notes = [
      { id: 'n1', componentId: 'U1', text: 'supply', updatedAt: NOW },
      { id: 'n2', componentId: 'U1', pinId: 'U1.3', text: 'low', measurements: { voltage: '0.4 V' }, updatedAt: NOW },
    ];
    assert.equal((await run('([k, n]) => window.traceDesktop.saveNotes(k, n).then(() => window.traceDesktop.getNotes(k))', [key, notes])).value.length, 2);
    const duplicate = await run('([k, n]) => window.traceDesktop.saveNotes(k, n)', [key, [notes[0], { ...notes[0], id: 'n9' }]]);
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.message, /Invalid note|Érvénytelen|ungültig|invalide|non valida|Neplatná|Nieprawid|Недійсна/i);
  });

  await t.test('workspace: save, load, malformed and foreign manifests fail with a stable machine code that survives the context bridge', async () => {
    const key = sha256(BOARD);
    const manifest = {
      version: 1, board: { key, name: 'Board.cad', path: boardFile, format: 'gencad' },
      documents: [{ id: 'd1', kind: 'pdf', name: 'ref.pdf', path: pdfFile, relativePath: 'docs/ref.pdf', key: sha256(PDF), size: PDF.length, bookmarks: [], annotations: [], addedAt: NOW }],
      split: { enabled: false, ratio: 0.5, right: null }, activeTab: 'board', cameras: {}, aliases: { refs: { U1A: 'U1' }, nets: {} }, updatedAt: NOW,
    };
    assert.equal((await run('([k, m]) => window.traceDesktop.saveWorkspace(k, m)', [key, manifest])).ok, true);
    assert.deepEqual((await run('(k) => window.traceDesktop.loadWorkspace(k)', key)).value, manifest);
    assert.equal((await run('(k) => window.traceDesktop.loadWorkspace(k)', 'c'.repeat(64))).value, null);
    // A manifest that belongs to another board, stored under this board's name, is never attached.
    const foreign = 'd'.repeat(64);
    await fs.writeFile(path.join(profile, 'workspaces', `${foreign}.json`), JSON.stringify(manifest));
    const mismatch = await run('(k) => window.traceDesktop.loadWorkspace(k)', foreign);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'BOARD_MISMATCH', 'the code survives the bridge as the message prefix');
    assert.match(mismatch.message, /^\[BOARD_MISMATCH\] The workspace belongs to another board\.$/, 'Electron wrapper removed, clean text after the prefix');
    assert.equal(mismatch.bridgeCode, undefined, 'Electron 44 drops error.code at the context bridge: the prefix is the only channel');
    await fs.writeFile(path.join(profile, 'workspaces', `${'e'.repeat(64)}.json`), JSON.stringify({ version: 1 }));
    assert.equal((await run('(k) => window.traceDesktop.loadWorkspace(k)', 'e'.repeat(64))).code, 'MANIFEST_INVALID');
  });

  await t.test('documents: pick, read, locate and export through real dialogs replaced in the main process', async () => {
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [pdfFile]);
    const picked = await run('() => window.traceDesktop.pickDocuments({ kinds: ["pdf"] }).then((list) => list.map((d) => ({ name: d.name, kind: d.kind, format: d.format, key: d.key, size: d.size, type: Object.prototype.toString.call(d.data) })))');
    assert.deepEqual(picked.value, [{ name: 'ref.pdf', kind: 'pdf', format: 'pdf', key: sha256(PDF), size: PDF.length, type: '[object Uint8Array]' }]);
    const wrongKind = await run('(p) => window.traceDesktop.readDocument(p, { kinds: ["image"] })', pdfFile);
    assert.equal(wrongKind.code, 'DOCUMENT_UNSUPPORTED_EXTENSION');
    assert.match(wrongKind.message, /^\[DOCUMENT_UNSUPPORTED_EXTENSION\] Unsupported document type ".pdf"/);
    const located = await run('([b, r]) => window.traceDesktop.locateDocuments(b, r)', [boardFile, [{ id: 'd1', kind: 'pdf', path: path.join(root, 'gone', 'ref.pdf'), relativePath: 'docs/ref.pdf', key: sha256(PDF) }]]);
    assert.equal(located.value[0].status, 'moved');
    const target = path.join(root, 'bundle.zip');
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, target);
    const exported = await run('(k) => window.traceDesktop.exportWorkspace({ boardKey: k, documentIds: ["d1"], includeBoard: false, includeNotes: true })', sha256(BOARD));
    assert.equal(exported.ok, true);
    const entries = fflate.unzipSync(new Uint8Array(await fs.readFile(target)));
    assert.deepEqual(Object.keys(entries).sort(), ['documents/ref.pdf', 'notes.json', 'workspace.json']);
    assert.ok(Buffer.from(entries['documents/ref.pdf']).equals(PDF));
  });

  // New IPC 'trace:open-support-link'.
  await t.test('support notice: openSupportLink sends an id over the real bridge; main opens exactly the three constant URLs and rejects everything else', async () => {
    await app.evaluate(({ shell }) => { globalThis.__supportOpened = []; shell.openExternal = async (url) => { globalThis.__supportOpened.push(url); }; });
    assert.equal((await run('() => window.traceDesktop.openSupportLink("stripe")')).ok, true);
    assert.equal((await run('() => window.traceDesktop.openSupportLink("kofi")')).ok, true);
    assert.equal((await run('() => window.traceDesktop.openSupportLink("bug")')).ok, true);
    for (const bad of ['paypal', 'https://ko-fi.com/tracerboardview', 'constructor', '']) {
      const refused = await run('(id) => window.traceDesktop.openSupportLink(id)', bad);
      assert.equal(refused.ok, false, JSON.stringify(bad));
      assert.match(refused.message, /Unknown support link/);
    }
    assert.deepEqual(await app.evaluate(() => globalThis.__supportOpened), ['https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00', 'https://ko-fi.com/tracerboardview', 'https://github.com/trace-boardviewer/trace-boardviewer/issues/new?template=bug_report.yml']);
  });

  // New IPC 'trace:check-for-updates' and 'trace:open-update-page'.
  // The REAL net.fetch is called (so Electron 44 really accepts the request options and returns a readable body), but it is pointed at the local page that answers like releases/latest.
  await t.test('update notification: checkForUpdates and openUpdatePage over the real bridge; main fetches with the real net.fetch, validates the tag and opens exactly the tag URL', async () => {
    const early = await run('() => window.traceDesktop.openUpdatePage()');
    assert.equal(early.ok, false, 'nothing to open before a check');
    assert.match(early.message, /No update available/);
    await app.evaluate(({ net, shell }, target) => {
      const realFetch = net.fetch.bind(net);
      globalThis.__updateRequests = [];
      globalThis.__updateOpened = [];
      net.fetch = async (url, init) => {
        globalThis.__updateRequests.push({ url, method: init.method, redirect: init.redirect, credentials: init.credentials, referrerPolicy: init.referrerPolicy, headers: { ...init.headers } });
        const real = await realFetch(target, init);
        // net.fetch documents Response.url as unreliable: hand main.cjs a plain Response with the same status, headers and bytes.
        return new Response(await real.arrayBuffer(), { status: real.status, headers: real.headers });
      };
      shell.openExternal = async (url) => { globalThis.__updateOpened.push(url); };
    }, `http://127.0.0.1:${server.address().port}/__latest-release`);
    const checked = await run('() => window.traceDesktop.checkForUpdates()');
    assert.deepEqual(checked.value, { status: 'available', version: '99.0.0' }, 'the renderer gets status and version only');
    const [request] = await app.evaluate(() => globalThis.__updateRequests);
    assert.equal(request.url, 'https://api.github.com/repos/trace-boardviewer/trace-boardviewer/releases/latest', 'main asked the fixed API URL (the stand-in only redirected it afterwards)');
    assert.deepEqual({ method: request.method, redirect: request.redirect, credentials: request.credentials, referrerPolicy: request.referrerPolicy }, { method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
    assert.match(request.headers['User-Agent'], /^TRACE-Boardviewer\/\d+\.\d+\.\d+/);
    assert.deepEqual(Object.keys(request.headers).sort(), ['Accept', 'Accept-Language', 'User-Agent', 'X-GitHub-Api-Version'], 'exactly the four declared headers');
    assert.equal(request.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.deepEqual(await app.evaluate(() => globalThis.__updateOpened), [], 'checking opens nothing');
    assert.equal((await run('() => window.traceDesktop.openUpdatePage("https://evil.example/", "v1.0.0")')).ok, true);
    assert.deepEqual(await app.evaluate(() => globalThis.__updateOpened), ['https://github.com/trace-boardviewer/trace-boardviewer/releases/tag/v99.0.0'], 'arguments are ignored; the page is the validated tag, never html_url');
    // Inside the cooldown (30 s after a request) a check makes no request and repeats the answer; once the clock of the main process is past it, a failing
    // request is the bare "unavailable" and forgets the tag.
    await app.evaluate(({ net }) => { net.fetch = async (url) => { globalThis.__updateRequests.push({ url }); throw new Error('offline'); }; });
    assert.deepEqual((await run('() => window.traceDesktop.checkForUpdates()')).value, { status: 'available', version: '99.0.0' }, 'the answer of the first request again');
    assert.equal((await app.evaluate(() => globalThis.__updateRequests)).length, 1, 'no request inside the cooldown');
    await app.evaluate(() => { globalThis.__realNow = Date.now; Date.now = () => globalThis.__realNow() + 60000; });
    try { assert.deepEqual((await run('() => window.traceDesktop.checkForUpdates()')).value, { status: 'unavailable' }, 'past the cooldown the failing request is reported'); }
    finally { await app.evaluate(() => { Date.now = globalThis.__realNow; }); }
    assert.equal((await app.evaluate(() => globalThis.__updateRequests)).length, 2);
    assert.equal((await run('() => window.traceDesktop.openUpdatePage()')).ok, false, 'the tag is forgotten');
    assert.equal((await app.evaluate(() => globalThis.__updateOpened)).length, 1);
    // updateCheck is a stored setting: default on, kept when switched off.
    const settings = (await run('() => window.traceDesktop.getSettings()')).value;
    assert.equal(settings.updateCheck, true);
    const saved = await run('(s) => window.traceDesktop.saveSettings(s).then(() => window.traceDesktop.getSettings())', { ...settings, updateCheck: false });
    assert.equal(saved.value.updateCheck, false);
    await run('(s) => window.traceDesktop.saveSettings(s)', { ...saved.value, updateCheck: true });
  });

  await t.test('quit: a write submitted after the quit intent is rejected with [STORE_CLOSING]; the write accepted before it is drained before the app exits', async () => {
    const key = sha256(BOARD);
    const stored = path.join(profile, 'notes', `${key}.json`);
    const accepted = [{ id: 'n7', componentId: 'U7', text: 'accepted before quitting', updatedAt: NOW }];
    // Hold the rename of the next notes write so that it is accepted but not yet committed (the B01 window).
    await app.evaluate(() => {
      const fsp = process.mainModule.require('node:fs/promises');
      const original = fsp.rename;
      globalThis.heldRename = { entered: 0, release: null };
      fsp.rename = async (from, to) => {
        if (String(to).includes('notes')) { globalThis.heldRename.entered++; await new Promise((resolve) => { globalThis.heldRename.release = resolve; }); }
        return original.call(fsp, from, to);
      };
    });
    await page.evaluate(([k, notes]) => { window.pendingSave = window.traceDesktop.saveNotes(k, notes); }, [key, accepted]);
    for (let attempt = 0; attempt < 200 && await app.evaluate(() => globalThis.heldRename.entered) < 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await app.evaluate(() => globalThis.heldRename.entered), 1, 'the first write reached its rename and is held there');
    const closed = new Promise((resolve) => app.once('close', resolve));
    await app.evaluate(({ app: electronApp }) => { electronApp.emit('before-quit', { preventDefault() {} }); });
    for (const [label, source, argument] of [
      ['notes', '([k, n]) => window.traceDesktop.saveNotes(k, n)', [key, []]],
      ['settings', '() => window.traceDesktop.getSettings().then((s) => window.traceDesktop.saveSettings(s))', null],
      ['workspace', '([k, m]) => window.traceDesktop.saveWorkspace(k, m)', [key, { version: 1, board: { key, name: 'Board.cad', path: boardFile, format: 'gencad' }, documents: [], split: { enabled: false, ratio: 0.5, right: null }, activeTab: 'board', cameras: {}, updatedAt: NOW }]],
    ]) {
      const rejected = await run(source, argument);
      assert.equal(rejected.ok, false, label);
      assert.equal(rejected.code, 'STORE_CLOSING', label);
      assert.match(rejected.message, /^\[STORE_CLOSING\] The data store is shutting down/, label);
    }
    assert.equal(await app.evaluate(() => 1), 1, 'the application is still alive while the accepted write is pending');
    await app.evaluate(() => globalThis.heldRename.release());
    await closed;
    const written = JSON.parse(await fs.readFile(stored, 'utf8'));
    assert.deepEqual(written, accepted, 'the write accepted before the quit intent was committed before the exit, the rejected ones changed nothing');
    assert.equal((await fs.readdir(path.join(profile, 'notes'))).filter((name) => name.endsWith('.tmp')).length, 0);
  });
});

// Close/quit flush (W-fin-lifecycle-02, W-fin-documents-01) in the real thing: the page stands in for the renderer, keeping a
// snapshot that only a 'trace:flush-request' makes it write (like the 400 ms debounce of the workspace saver). Closing the
// window and a direct app.quit() must both wait for that write before the process exits. This proves the context bridge
// (a listener that returns a promise), the main-process wait and the order "flush, then the store closes".
test('real Electron: closing the window and app.quit() wait for the renderer to write its pending snapshot', { skip: !enabled && 'set TRACE_ELECTRON_SMOKE=1 and run under xvfb-run', timeout: 120000 }, async (t) => {
  const { _electron } = require('playwright');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-electron-flush-'));
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>TRACE flush smoke</title><body>flush</body>'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let app;
  t.after(async () => {
    if (app) await app.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const BOARD = '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n';
  const key = sha256(BOARD);
  const manifest = {
    version: 1, board: { key, name: 'Board.cad', path: path.join(root, 'Board.cad'), format: 'gencad' }, documents: [],
    split: { enabled: false, ratio: 0.5, right: null }, activeTab: 'board', cameras: {}, updatedAt: NOW,
  };
  const env = { ...process.env, TRACE_ACCEPT_NO_SANDBOX: '1', VITE_DEV_SERVER_URL: `http://127.0.0.1:${server.address().port}/` };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const how of ['window close', 'app.quit()']) {
    const profile = path.join(root, `profile-${how.replace(/\W+/g, '-')}`);
    app = await _electron.launch({ executablePath: electronExecutable(), args: ['--no-sandbox', ROOT, `--user-data-dir=${profile}`], env, timeout: 60000 });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.traceDesktop), null, { timeout: 30000 });
    // The renderer announces itself (initialBoard, as the controller does at start-up) and registers its flush listener.
    await page.evaluate(([k, m]) => {
      window.traceDesktop.onFlushRequest(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); await window.traceDesktop.saveWorkspace(k, m); });
      return window.traceDesktop.initialBoard();
    }, [key, manifest]);
    const exited = new Promise((resolve) => app.once('close', resolve));
    // The app exits while the call is running, so the call itself may be reported as interrupted.
    const request = how === 'window close'
      ? app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      : app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
    request.catch(() => {});
    await exited;
    app = undefined;
    const written = JSON.parse(await fs.readFile(path.join(profile, 'workspaces', `${key}.json`), 'utf8'));
    assert.deepEqual(written, manifest, `${how}: the snapshot held by the renderer was written before the process exited`);
    assert.equal((await fs.readdir(path.join(profile, 'workspaces'))).filter((name) => name.endsWith('.tmp')).length, 0, how);
  }
});

// Renderer failures, a second launch, a start-up file that fails and a window that never paints, in the real thing (H1-01, H1-02,
// H1-03, H1-08). The page stands in for the renderer again; dialog.showMessageBox is replaced in the main process so that no native
// dialog waits for a click, and a second instance is a real second Electron process on the same profile.
test('real Electron: a gone renderer is reported and reloaded, a hung one can be closed, a second launch and a failed start-up file are handled, a window that never paints is shown', { skip: !enabled && 'set TRACE_ELECTRON_SMOKE=1 and run under xvfb-run', timeout: 240000 }, async (t) => {
  const { _electron } = require('playwright');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-electron-lifecycle-'));
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>TRACE lifecycle smoke</title><body>lifecycle</body>'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let app;
  t.after(async () => {
    if (app) await app.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    // The profile of the killed process (last sub-test) can stay locked for a moment after the kill.
    await fs.rm(absolute, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  const BOARD = '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n';
  const boardFile = path.join(root, 'Board.cad');
  await fs.writeFile(boardFile, BOARD);
  const env = { ...process.env, TRACE_ACCEPT_NO_SANDBOX: '1', VITE_DEV_SERVER_URL: `http://127.0.0.1:${server.address().port}/` };
  delete env.ELECTRON_RUN_AS_NODE;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const poll = async (check, limit = 200) => { for (let attempt = 0; attempt < limit && !(await check()); attempt++) await sleep(50); };
  const launch = async (profile, extra = []) => {
    app = await _electron.launch({ executablePath: electronExecutable(), args: ['--no-sandbox', ROOT, `--user-data-dir=${profile}`, ...extra], env, timeout: 60000 });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.traceDesktop), null, { timeout: 30000 });
    return page;
  };
  // A second Electron process on the same profile: the lock makes it hand its arguments over and exit; resolves to its exit code.
  const secondLaunch = (profile, extra) => new Promise((resolve) => {
    const child = spawn(electronExecutable(), [ROOT, `--user-data-dir=${profile}`, ...extra], { env, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve('still running after 20 s'); }, 20000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  // The main process answers every message box itself with `response` and records what was asked.
  const answerDialogs = (response) => app.evaluate(({ dialog }, answer) => {
    globalThis.__boxes = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__boxes.push({ type: options.type, title: options.title, message: options.message, buttons: options.buttons ?? null });
      return { response: answer, checkboxChecked: false };
    };
  }, response);
  const boxes = () => app.evaluate(() => globalThis.__boxes);
  const catalogTexts = (key) => Object.values(i18n.catalogs).map((catalog) => catalog[key]);

  await t.test('second instance: "--board <path>" with a space reaches the running instance as the board (Chromium puts the switch first), without a dialog', async () => {
    const page = await launch(path.join(root, 'profile-gone'));
    assert.equal(await page.evaluate(() => window.traceDesktop.initialBoard()), null, 'no recents yet: this is the cached start-up answer');
    await page.evaluate(() => { window.__opened = []; window.traceDesktop.onOpenBoard((payload) => window.__opened.push(payload.name)); });
    await answerDialogs(0);
    assert.equal(await secondLaunch(path.join(root, 'profile-gone'), ['--board', boardFile]), 0, 'the second process hands its arguments over and exits');
    await poll(async () => (await page.evaluate(() => window.__opened.length)) > 0);
    assert.deepEqual(await page.evaluate(() => window.__opened), ['Board.cad']);
    assert.deepEqual(await boxes(), [], 'no "invalid path" dialog for the switch that followed --board');
    await page.evaluate((file) => window.traceDesktop.readBoard(file).then((payload) => window.traceDesktop.acceptBoard(payload.path, payload.key)), boardFile);
  });

  // Playwright's page object does not survive a renderer crash ("Target crashed" from then on), so the reloaded renderer is
  // reached through webContents.executeJavaScript from the main process.
  await t.test('render-process-gone: one error dialog, the same window loads the page again and the new renderer gets a fresh start-up answer', async () => {
    const inRenderer = (source) => app.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(code), source);
    await answerDialogs(0);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      globalThis.__loads = 0;
      window.webContents.on('did-finish-load', () => { globalThis.__loads++; });
      window.webContents.forcefullyCrashRenderer();
    });
    await poll(async () => (await app.evaluate(() => globalThis.__loads)) >= 1);
    const state = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { loads: globalThis.__loads, crashed: window.webContents.isCrashed(), visible: window.isVisible(), windows: BrowserWindow.getAllWindows().length };
    });
    assert.deepEqual(state, { loads: 1, crashed: false, visible: true, windows: 1 }, 'the same window, loaded again, still visible');
    const asked = await boxes();
    assert.equal(asked.length, 1);
    assert.equal(asked[0].type, 'error');
    assert.equal(asked[0].title, 'TRACE Boardviewer');
    assert.ok(catalogTexts('native.dialog.rendererGone').includes(asked[0].message), 'the message is the catalog text of the current language');
    await poll(async () => (await inRenderer('typeof window.traceDesktop')) === 'object');
    const restored = await inRenderer('window.traceDesktop.initialBoard().then((payload) => ({ name: payload && payload.name, source: payload && payload.startupSource }))');
    assert.deepEqual(restored, { name: 'Board.cad', source: 'recent' }, 'computed afresh for the new renderer: the board accepted before the crash');
  });

  await t.test('unresponsive: Wait keeps the window; Close closes it and the application exits', async () => {
    await answerDialogs(0);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.emit('unresponsive'); });
    await poll(async () => (await boxes()).length > 0);
    const [asked] = await boxes();
    assert.equal(asked.type, 'warning');
    assert.equal(asked.title, 'TRACE Boardviewer');
    assert.ok(catalogTexts('native.dialog.unresponsive').includes(asked.message));
    assert.equal(asked.buttons.length, 2);
    assert.ok(catalogTexts('native.dialog.unresponsiveClose').includes(asked.buttons[1]));
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'Wait keeps the window');
    await answerDialogs(1);
    const exited = new Promise((resolve) => app.once('close', resolve));
    app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.emit('unresponsive'); }).catch(() => {});
    await exited;
    app = undefined;
  });

  await t.test('a start-up file that cannot be read: initialBoard() rejects first, then the last board arrives over onOpenBoard, and the next call restores the recents', async () => {
    const profile = path.join(root, 'profile-startup');
    await fs.mkdir(profile, { recursive: true });
    const settings = { language: 'en', theme: 'dark', layout: 'workshop', motion: true, showLabels: true, showConnections: true, updateCheck: false };
    await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({ version: 1, settings, recentBoards: [{ name: 'Board.cad', path: boardFile, openedAt: NOW }] }));
    const page = await launch(profile, [`--board=${path.join(root, 'missing.cad')}`]);
    const events = await page.evaluate(() => new Promise((resolve) => {
      const seen = [];
      const done = () => { if (seen.length === 2) resolve(seen); };
      window.traceDesktop.onOpenBoard((payload) => { seen.push({ kind: 'opened', name: payload.name, source: payload.startupSource }); done(); });
      window.traceDesktop.initialBoard().then(
        (payload) => { seen.push({ kind: 'resolved', name: payload && payload.name }); done(); },
        (error) => { seen.push({ kind: 'rejected', message: error.message }); done(); });
      setTimeout(() => resolve(seen), 15000);
    }));
    assert.equal(events.length, 2, JSON.stringify(events));
    assert.equal(events[0].kind, 'rejected', 'the renderer holds the rejection (its start-up toast) before the board arrives');
    assert.match(events[0].message, /was not found/);
    assert.deepEqual(events[1], { kind: 'opened', name: 'Board.cad', source: 'recent' });
    assert.deepEqual(await page.evaluate(() => window.traceDesktop.initialBoard().then((payload) => ({ name: payload.name, source: payload.startupSource }))), { name: 'Board.cad', source: 'recent' });
    await app.close();
    app = undefined;
  });

  // Playwright's launch waits for the first page to load, which never happens here, so the process is started plainly and the
  // window handle of the process is read from outside (0 while nothing is on screen).
  await t.test('a page that never paints: the window is shown after 4 s and the lock holder is visible when a second launch exits', { skip: process.platform !== 'win32' && 'the window handle of another process is read through PowerShell' }, async () => {
    const hanging = http.createServer(() => { /* never answers: the document request stays pending */ });
    await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const profile = path.join(root, 'profile-hang');
    const hangingEnv = { ...env, VITE_DEV_SERVER_URL: `http://127.0.0.1:${hanging.address().port}/` };
    const child = spawn(electronExecutable(), [ROOT, `--user-data-dir=${profile}`], { env: hangingEnv, stdio: 'ignore', windowsHide: false });
    const handle = () => execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue).MainWindowHandle`], { encoding: 'utf8' }).trim();
    const started = Date.now();
    try {
      await sleep(1500);
      assert.equal(handle(), '0', 'nothing on screen yet: the page has not painted and the fallback has not fired');
      let shownAt = null;
      await poll(() => { if (handle() !== '0') { shownAt = Date.now() - started; return true; } return false; }, 400);
      assert.ok(shownAt !== null && shownAt < 20000, `the window appeared after ${shownAt} ms`);
      const second = await new Promise((resolve) => {
        const launched = spawn(electronExecutable(), [ROOT, `--user-data-dir=${profile}`, boardFile], { env: hangingEnv, stdio: 'ignore', windowsHide: true });
        const timer = setTimeout(() => { launched.kill(); resolve('still running after 20 s'); }, 20000);
        launched.on('exit', (code) => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(second, 0, 'the single-instance lock is held by a visible window');
      assert.notEqual(handle(), '0');
    } finally {
      const gone = new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 10000); });
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
      await gone;
      await new Promise((resolve) => hanging.close(resolve));
    }
  });
});