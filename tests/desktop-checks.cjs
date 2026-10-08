'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const i18n = require('../electron/i18n.cjs');
const formats = require('../electron/formats.cjs');
const { isInsideTemp, makeTempDir } = require('./canonical-temp.cjs');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/** Payloads come from another realm: compare their bytes through a Buffer view. */
const bytesOf = (view) => Buffer.from(view.buffer, view.byteOffset, view.byteLength);
/**
 * The board identity shared with the renderer, written from the contract: one file is the plain SHA-256;
 * several files (the complete ASC set, primary included) are hashed as lowercase basename, NUL, uint64be
 * length, bytes, sorted by lowercase basename - so it never depends on which entry file was chosen.
 */
function boardKey(entries) {
  const list = Object.entries(entries).map(([name, data]) => [name.toLowerCase(), Buffer.from(data)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (list.length === 1) return sha256(list[0][1]);
  const hash = createHash('sha256');
  for (const [name, data] of list) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(data.length));
    hash.update(Buffer.from(name, 'utf8')).update(Buffer.from([0])).update(length).update(data);
  }
  return hash.digest('hex');
}
const settle = async (ready, limit = 100) => { for (let attempt = 0; attempt < limit && !ready(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10)); };
/** The switch names Chromium parses from a launch: "--name" or "-name" (a value follows "="); nothing after a "--" terminator is a switch. */
function chromiumSwitches(argv) {
  const names = [];
  for (const argument of argv) {
    if (argument === '--') break;
    const match = /^--?([^=]+)/.exec(argument);
    if (match) names.push(match[1]);
  }
  return names;
}

async function desktopHarness(directory, options = {}) {
  const handlers = new Map();
  const messages = new Map();
  let window;
  const created = []; // every window the main process constructed, in order (destroyed ones stay in the list)
  const app = new EventEmitter();
  // A fresh profile follows the system language; Hungarian keeps the older assertions below stable.
  const systemLanguages = options.systemLanguages ?? ['hu-HU'];
  // deferReady keeps the app "not ready" until releaseReady(), so the order of language queries can be checked.
  let ready = !options.deferReady;
  let markReady;
  const readyGate = options.deferReady ? new Promise((resolve) => { markReady = resolve; }) : null;
  const languageCalls = { total: 0, beforeReady: 0 };
  Object.assign(app, {
    isPackaged: false, setName(name) { this.name = name; }, setAppUserModelId() {},
    // Every app.setPath call is recorded with whether the app was ready by then; getPath keeps answering with the test directory
    // (options.appData for 'appData'), so the store always lives in `directory`.
    pathsSet: [], setPath(name, value) { this.pathsSet.push({ name, value, ready }); },
    getPath: (name) => (name === 'appData' && options.appData ? options.appData : directory), isReady: () => ready, getVersion: () => options.version ?? '1.2.0',
    whenReady: () => readyGate ? readyGate.then(() => { ready = true; }) : Promise.resolve(),
    requestSingleInstanceLock: () => true, quitCount: 0, quit() { this.quitCount++; },
    // Chromium's own command line: the switches of options.argv as Chromium parses them, or options.commandLineSwitches for a line that
    // differs from process.argv (a switch Electron appended itself, e.g. for ELECTRON_DISABLE_SANDBOX).
    commandLine: { hasSwitch: (name) => (options.commandLineSwitches ?? chromiumSwitches(options.argv ?? [])).includes(name) },
  });
  if (!options.withoutLanguageApis) {
    const record = () => { languageCalls.total++; if (!ready) languageCalls.beforeReady++; };
    Object.assign(app, {
      getPreferredSystemLanguages: () => { record(); return systemLanguages; },
      getLocale: () => { record(); return systemLanguages[0]; },
    });
  }
  // One default session shared by every window, like Electron's (a window without a partition uses session.defaultSession); the
  // counters show how often main.cjs installed each policy.
  const defaultSession = Object.assign(new EventEmitter(), {
    permissionRequestHandlers: 0, permissionCheckHandlers: 0,
    setPermissionRequestHandler(callback) { this.permissionRequestHandlers++; this.permissionHandler = callback; },
    setPermissionCheckHandler(callback) { this.permissionCheckHandlers++; this.permissionCheck = callback; },
  });
  class MockBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      window = this;
      created.push(this);
      this.options = options;
      this.maximized = false;
      this.minimized = false;
      this.visible = false;
      this.minimizeCount = 0;
      this.loadCount = 0;
      this.calls = []; // show / focus / restore, in order
      this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        session: defaultSession, mainFrame: { url: '' }, sent: [],
        // `onSend` lets a test play the renderer: it sees every message main sends (e.g. 'trace:flush-request').
        send(channel, value) { this.sent.push({ channel, value }); this.onSend?.(channel, value); },
        setWindowOpenHandler(callback) { this.popupHandler = callback; },
      });
    }
    isDestroyed() { return this.destroyed; }
    isMaximized() { return this.maximized; }
    isMinimized() { return this.minimized; }
    isVisible() { return this.visible; }
    maximize() { this.maximized = true; this.emit('maximize'); }
    unmaximize() { this.maximized = false; this.emit('unmaximize'); }
    minimize() { this.minimizeCount++; }
    restore() { this.minimized = false; this.calls.push('restore'); }
    focus() { this.calls.push('focus'); }
    show() { this.showCount = (this.showCount || 0) + 1; this.visible = true; this.calls.push('show'); }
    // Like Electron: 'close' is emitted first and a listener may veto it (event.preventDefault()); then the window goes away.
    close() {
      if (this.destroyed) return;
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', event);
      this.closeEvents = (this.closeEvents || 0) + 1;
      if (event.defaultPrevented) return;
      this.destroyed = true;
      this.emit('closed');
    }
    setMenuBarVisibility() {}
    loadURL(url) { this.loadCount++; this.webContents.mainFrame.url = url; return options.loadURL ? options.loadURL(url) : Promise.resolve(); }
    static getAllWindows() { return window && !window.destroyed ? [window] : []; }
  }
  const dialog = {
    choice: { canceled: true, filePaths: [] },
    saveChoice: { canceled: true, filePath: undefined },
    messages: [], errorBoxes: [], openOptions: [], saveOptions: [],
    showOpenDialog(_window, dialogOptions) { this.openOptions.push(dialogOptions); return Promise.resolve(this.choice); },
    showSaveDialog(_window, dialogOptions) { this.saveOptions.push(dialogOptions); return Promise.resolve(this.saveChoice); },
    // Answers like Electron: the index of the pressed button (`response`, default 0) or whatever `answer(options)` resolves to. Like
    // Electron it takes the options with or without a parent window first (`parents` records the window, null for none).
    // options.dialogResponse / options.dialogAnswer answer the boxes main.cjs opens during start-up, before the harness returns.
    parents: [], response: options.dialogResponse, answer: options.dialogAnswer,
    showMessageBox(windowOrOptions, boxOptions) {
      const asked = boxOptions === undefined ? windowOrOptions : boxOptions;
      this.messages.push(asked);
      this.parents.push(boxOptions === undefined ? null : windowOrOptions);
      return Promise.resolve(this.answer ? this.answer(asked) : { response: this.response ?? 0, checkboxChecked: false });
    },
    showErrorBox(title, message) {
      if (options.captureErrors) this.errorBoxes.push({ title, message });
      else throw new Error(message);
    },
  };
  // Every URL the main process hands to the operating system (support notice); `options.openExternal` replaces the behaviour.
  const shell = {
    opened: [], extraArguments: [],
    openExternal(url, ...rest) {
      this.opened.push(url);
      this.extraArguments.push(rest);
      return options.openExternal ? options.openExternal(url, ...rest) : Promise.resolve();
    },
  };
  // The only network function the main process may use: the fetch of the in-memory 'trace-egress' partition (electron/net/egress.cjs, created on first
  // use), which the harness answers through `net.fetch` so that every request is recorded in `net.requests`. No test touches the network: a request
  // without `options.fetch` is refused. `partitions` lists every session main.cjs asked for, `egressSession` is the one it got.
  const net = {
    requests: [],
    fetch(url, init) {
      this.requests.push({ url, init });
      return options.fetch ? options.fetch(url, init) : Promise.reject(new Error('no network in tests'));
    },
  };
  const partitions = [];
  const egressSession = Object.assign(new EventEmitter(), {
    webRequest: { listeners: [], onBeforeRequest(filter, listener) { this.listeners.push({ filter, listener }); } },
    setPermissionRequestHandler(callback) { this.permissionHandler = callback; },
    setPermissionCheckHandler(callback) { this.permissionCheck = callback; },
    fetch(url, init) { return net.fetch(url, init); },
  });
  // The application menu: `templates` holds every template main.cjs built, `applied` every value it set (null, or the built menu).
  const menu = {
    templates: [], applied: [],
    buildFromTemplate(template) { this.templates.push(template); return { template }; },
    setApplicationMenu(value) { this.applied.push(value); },
  };
  // nativeImage.createFromPath: an image that remembers its file, empty when the file does not exist (or with options.emptyImages);
  // resize() answers with a plain record of the request.
  const nativeImage = {
    created: [],
    createFromPath(file) {
      this.created.push(file);
      const empty = options.emptyImages === true || !require('node:fs').existsSync(file);
      return { file, isEmpty: () => empty, resize: (size) => ({ resizedFrom: file, size: { ...size } }) };
    },
  };
  const electron = {
    app, BrowserWindow: MockBrowserWindow, dialog, Menu: menu, nativeImage, shell, net,
    session: { defaultSession, fromPartition(name, partitionOptions) { partitions.push({ name, options: partitionOptions }); return egressSession; } },
    ipcMain: {
      handle(channel, callback) { handlers.set(channel, callback); },
      on(channel, callback) { messages.set(channel, callback); },
    },
  };
  const filename = path.resolve(__dirname, '..', 'electron', 'main.cjs');
  const source = await fs.readFile(filename, 'utf8');
  // The context is returned so a test can reach a top-level function of main.cjs (e.g. openExternalUrl) that no handler exposes.
  // `options.timers` replaces the timer functions main.cjs sees (the fallback show), `options.argv` the launch arguments after the
  // application path, `options.cwd` the working directory of the launch, `options.env` its environment, `options.console` the console.
  const context = {
    require: (name) => name === 'electron' ? electron : name === 'node:fs/promises' && options.fs ? options.fs : require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name),
    __dirname: path.dirname(filename), Buffer, URL, console: options.console ?? console,
    setTimeout: options.timers?.setTimeout ?? setTimeout, clearTimeout: options.timers?.clearTimeout ?? clearTimeout,
    process: {
      argv: ['electron.exe', 'app', ...(options.argv ?? [])], pid: process.pid, platform: options.platform ?? 'win32', env: { ...options.env },
      cwd: () => options.cwd ?? process.cwd(),
    },
  };
  vm.runInNewContext(source, context, { filename });
  const waitForWindow = async () => {
    for (let attempt = 0; attempt < 100 && !window; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(window, 'Desktop should create the window after loading config');
  };
  // options.noWindow: the start-up is expected to end without a window (the Linux sandbox question answered with Quit).
  if (!options.deferReady && !options.noWindow) await waitForWindow();
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return {
    get window() { return window; }, get windows() { return [...created]; }, context, app, dialog, shell, net, partitions, egressSession, menu, nativeImage, session: electron.session, handlers, languageCalls, waitForWindow,
    releaseReady: () => markReady(),
    invoke: (channel, ...args) => handlers.get(channel)(event(), ...args),
    message: (channel, ...args) => messages.get(channel)(event(), ...args),
    forgedMessage: (channel, ...args) => messages.get(channel)({ sender: {}, senderFrame: { url: 'https://example.com/' } }, ...args),
  };
}

test('desktop IPC, local import, persistence and boundary checks', async (t) => {
  const directory = await makeTempDir('trace-desktop-test-');
  t.after(async () => {
    const absolute = path.resolve(directory);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const harness = await desktopHarness(directory);
  const { invoke, window } = harness;
  const validText = '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n';
  const boardFile = path.join(directory, 'Circuit.CAD');
  await fs.writeFile(boardFile, validText);

  await t.test('renderer isolation and navigation controls are enabled', () => {
    assert.equal(window.options.frame, false);
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.equal(window.options.webPreferences.contextIsolation, true);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.minWidth, 960);
    assert.equal(window.options.minHeight, 640);
    assert.equal(window.webContents.popupHandler({ url: 'https://example.com/' }).action, 'deny');
    let blocked = false;
    window.webContents.emit('will-navigate', { preventDefault() { blocked = true; } }, 'https://example.com/');
    assert.equal(blocked, true);
    let permission = true;
    window.webContents.session.permissionHandler({}, 'camera', (value) => { permission = value; });
    assert.equal(permission, false);
    assert.equal(window.webContents.session.permissionCheck(), false);
  });

  await t.test('every privileged handler rejects another window or subframe', async () => {
    for (const callback of harness.handlers.values()) {
      await assert.rejects(callback({ sender: {}, senderFrame: { url: 'https://example.com/' } }), /nem az alkalmazás/);
      await assert.rejects(callback({ sender: window.webContents, senderFrame: { url: window.webContents.mainFrame.url } }), /nem az alkalmazás/);
    }
    harness.forgedMessage('trace:minimize');
    assert.equal(window.minimizeCount, 0);
  });

  await t.test('clipboard write is restricted to the trusted main document', () => {
    const session = window.webContents.session;
    const details = { requestingUrl: window.webContents.mainFrame.url, isMainFrame: true };
    assert.equal(session.permissionCheck(window.webContents, 'clipboard-sanitized-write', 'file://', details), true);
    assert.equal(session.permissionCheck(window.webContents, 'clipboard-read', 'file://', details), false);
    assert.equal(session.permissionCheck(window.webContents, 'clipboard-sanitized-write', 'file://', { ...details, isMainFrame: false }), false);
    assert.equal(session.permissionCheck(window.webContents, 'clipboard-sanitized-write', 'https://example.com', { ...details, requestingUrl: 'https://example.com/' }), false);
    assert.equal(session.permissionCheck({}, 'clipboard-sanitized-write', 'file://', details), false);
    let allowed = false;
    session.permissionHandler(window.webContents, 'clipboard-sanitized-write', (value) => { allowed = value; }, details);
    assert.equal(allowed, true);
  });

  await t.test('board read returns the original bytes as an exactly sized Uint8Array with a stable SHA256 key', async () => {
    const payload = await invoke('trace:read-board', boardFile);
    assert.equal(payload.name, 'Circuit.CAD');
    assert.equal('text' in payload, false, 'the payload carries bytes, never decoded text');
    assert.equal(Object.prototype.toString.call(payload.data), '[object Uint8Array]');
    assert.equal(payload.data.byteOffset, 0);
    assert.equal(payload.data.byteLength, Buffer.byteLength(validText), 'payload length equals the file size');
    assert.equal(payload.data.buffer.byteLength, payload.data.byteLength, 'the transported buffer is exactly the file: never a pooled or oversized allocation');
    assert.equal(bytesOf(payload.data).toString('utf8'), validText);
    assert.equal(payload.companions, undefined, 'single-file formats gather no sidecars');
    assert.equal(payload.key, sha256(validText));
    assert.equal(await fs.readFile(boardFile, 'utf8'), validText);
    const second = await invoke('trace:read-board', boardFile);
    assert.equal(second.key, payload.key);
    assert.equal((await invoke('trace:recent-boards')).length, 0, 'Unparsed read must not update recents');
    await invoke('trace:accept-board', payload.path, payload.key);
    const recent = await invoke('trace:recent-boards');
    assert.equal(recent.length, 1);
    assert.equal(recent[0].path.toLowerCase(), boardFile.toLowerCase());
    assert.ok(Number.isFinite(Date.parse(recent[0].openedAt)));
  });

  await t.test('accepted board acknowledgment must match a native path and content hash', async () => {
    const payload = await invoke('trace:read-board', boardFile);
    await assert.rejects(invoke('trace:accept-board', payload.path, 'b'.repeat(64)), /nem igazolható/);
    await assert.rejects(invoke('trace:accept-board', path.join(directory, 'unknown.cad'), payload.key), /nem igazolható/);
    await assert.rejects(invoke('trace:accept-board', '../Circuit.CAD', payload.key), /Érvénytelen helyi/);
    await assert.rejects(invoke('trace:accept-board', payload.path, '../hash'), /boardazonosító/);
    assert.equal((await invoke('trace:recent-boards')).length, 1);
  });

  await t.test('paths, extensions, empty and oversized files fail clearly; recognition is left to the renderer parser', async () => {
    await assert.rejects(invoke('trace:read-board', '../Circuit.CAD'), /Érvénytelen helyi/);
    await assert.rejects(invoke('trace:read-board', path.join(directory, 'secret.unsupported')), { message: i18n.translate('hu', 'native.error.unsupportedFile') });
    await assert.rejects(invoke('trace:read-board', path.join(directory, 'missing.cad')), /nem található/);
    const arbitrary = path.join(directory, 'not-a-board.cad');
    await fs.writeFile(arbitrary, 'This file is not GENCAD');
    const text = await invoke('trace:read-board', arbitrary);
    assert.equal(bytesOf(text.data).toString('utf8'), 'This file is not GENCAD', 'a .cad file with arbitrary text is returned; the renderer parser decides');
    const binary = Buffer.from([0x23, 0xe2, 0x63, 0x28, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x80, 0xef, 0xbb, 0xbf]);
    await fs.writeFile(arbitrary, binary);
    const raw = await invoke('trace:read-board', arbitrary);
    assert.ok(bytesOf(raw.data).equals(binary), 'binary bytes including NUL and BOM-like prefixes travel unchanged');
    assert.equal(raw.data.byteLength, binary.length);
    assert.equal(raw.key, sha256(binary));
    assert.equal((await invoke('trace:recent-boards')).length, 1, 'an unparsed read never becomes a recent');
    await fs.writeFile(arbitrary, '');
    await assert.rejects(invoke('trace:read-board', arbitrary), /üres/);
    await fs.truncate(arbitrary, 64 * 1024 * 1024 + 1);
    await assert.rejects(invoke('trace:read-board', arbitrary), /64 MB/);
  });

  await t.test('W-fin-lifecycle-01: a path that names an NTFS alternate data stream ("host.txt:alt.cad") is an invalid path, never a board or a document', async () => {
    const host = path.join(directory, 'ads-host.txt');
    await fs.writeFile(host, 'host text');
    const stream = `${host}:alt.cad`;
    try { await fs.writeFile(stream, validText); } catch { /* Only NTFS has streams; the rejection does not depend on one existing. */ }
    const invalid = { message: i18n.translate('hu', 'native.error.invalidPath') };
    const recentsBefore = (await invoke('trace:recent-boards')).length;
    await assert.rejects(invoke('trace:read-board', stream), invalid);
    await assert.rejects(invoke('trace:read-board', `${directory}${path.sep}dir:x${path.sep}Circuit.CAD`), invalid, 'a colon in a directory segment');
    await assert.rejects(invoke('trace:accept-board', stream, 'a'.repeat(64)), invalid);
    assert.equal((await invoke('trace:recent-boards')).length, recentsBefore, 'nothing was recorded');
    // Documents: the shared path check (store.cjs) answers with the existing invalid-path code. That check reads the REAL platform,
    // while this harness fakes win32 for main.cjs only, so the NTFS rule is asserted on Windows. Elsewhere ':' is a legal file-name
    // character and the same two requests reach the file system: the missing document is not found and the board file (which this
    // test could create there) is located like any other (a test assumption, not a product difference).
    if (process.platform === 'win32') {
      await assert.rejects(invoke('trace:read-document', `${host}:alt.pdf`), { code: 'DOCUMENT_INVALID_PATH', message: /^\[DOCUMENT_INVALID_PATH\] / });
      await assert.rejects(invoke('trace:locate-documents', stream, []), { code: 'DOCUMENT_INVALID_PATH' });
    } else {
      await assert.rejects(invoke('trace:read-document', `${host}:alt.pdf`), { code: 'DOCUMENT_NOT_FOUND' });
      assert.equal((await invoke('trace:locate-documents', stream, [])).length, 0);
    }
    // An external launch with such a path reports the invalid path and opens nothing.
    const launched = await desktopHarness(path.join(directory, 'ads-launch-profile'));
    await launched.invoke('trace:initial-board');
    launched.app.emit('second-instance', {}, ['electron.exe', 'app', `--board=${stream}`]);
    await settle(() => launched.dialog.messages.length >= 1);
    assert.equal(launched.dialog.messages[0].message, invalid.message);
    assert.deepEqual(launched.window.webContents.sent.filter((entry) => entry.channel === 'trace:board-opened'), []);
    // Where a colon is an ordinary file-name character the path check does not interfere (the file just does not exist here).
    const posix = await desktopHarness(path.join(directory, 'ads-posix-profile'), { platform: 'linux' });
    const outcome = await posix.invoke('trace:read-board', path.join(directory, 'no-such:name.cad')).then(() => 'read', (error) => error.message);
    assert.notEqual(outcome, invalid.message, 'linux/darwin keep ":" in file names');
    assert.equal(outcome, i18n.translate('hu', 'native.error.boardNotFound'));
  });

  await t.test('every supported boardview extension is accepted on the IPC, argument and dialog paths; others are rejected', async () => {
    const samples = path.join(directory, 'extensions');
    await fs.mkdir(samples, { recursive: true });
    for (const [index, extension] of formats.SUPPORTED_EXTENSIONS.entries()) {
      const filename = path.join(samples, `Sample${index}${index % 2 ? extension.toUpperCase() : extension}`);
      await fs.writeFile(filename, `bytes of ${extension}`);
      const payload = await invoke('trace:read-board', filename);
      assert.equal(payload.name, path.basename(filename));
      assert.equal(bytesOf(payload.data).toString('utf8'), `bytes of ${extension}`);
    }
    for (const name of ['board.unsupported', 'board.cad.bak', 'board', 'board.CAD.exe', 'cad']) {
      await assert.rejects(invoke('trace:read-board', path.join(samples, name)), { message: i18n.translate('hu', 'native.error.unsupportedFile') });
    }
    // External launches: --board=, a bare absolute path, and an unsupported bare path that is ignored without a dialog.
    const brd = path.join(samples, 'Launch.brd');
    await fs.writeFile(brd, 'str_length:\n');
    const kicad = path.join(samples, 'Launch.kicad_pcb');
    await fs.writeFile(kicad, '(kicad_pcb)');
    await fs.writeFile(path.join(samples, 'notes.unsupported'), 'not a board');
    const launched = await desktopHarness(path.join(directory, 'extension-launch-profile'));
    await launched.invoke('trace:initial-board');
    const delivered = () => launched.window.webContents.sent.filter((event) => event.channel === 'trace:board-opened').map((event) => event.value.name);
    launched.app.emit('second-instance', {}, ['electron.exe', 'app', `--board=${brd}`]);
    await settle(() => delivered().length >= 1);
    launched.app.emit('second-instance', {}, ['electron.exe', 'app', kicad]);
    await settle(() => delivered().length >= 2);
    launched.app.emit('second-instance', {}, ['electron.exe', 'app', path.join(samples, 'notes.unsupported')]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(delivered(), ['Launch.brd', 'Launch.kicad_pcb']);
    assert.equal(launched.dialog.messages.length, 0);
    const opened = launched.window.webContents.sent.find((event) => event.channel === 'trace:board-opened').value;
    assert.equal(bytesOf(opened.data).toString('utf8'), 'str_length:\n');
    assert.equal(opened.key, sha256('str_length:\n'));
    // The chooser: one filter with every supported extension under the localized name, then English families repeating only supported ones.
    launched.dialog.choice = { canceled: true, filePaths: [] };
    await launched.invoke('trace:open-board');
    const filters = launched.dialog.openOptions.at(-1).filters;
    assert.equal(filters[0].name, i18n.translate('hu', 'native.dialog.openFilter'));
    assert.deepEqual(Array.from(filters[0].extensions), formats.SUPPORTED_EXTENSIONS.map((extension) => extension.slice(1)));
    assert.ok(filters.length > 1);
    for (const filter of filters.slice(1)) {
      assert.ok(typeof filter.name === 'string' && filter.name && !/[^\x20-\x7e]/.test(filter.name), 'family names are plain English');
      assert.ok(filter.extensions.length);
      for (const extension of filter.extensions) assert.ok(formats.SUPPORTED_EXTENSIONS.includes(`.${extension}`), `${filter.name}: .${extension}`);
    }
  });

  await t.test('ASC companions: case-insensitive siblings of the same directory, missing ones omitted, identity covers them, total bounded', async () => {
    const wanted = formats.companionNames('format.asc');
    assert.ok(wanted.includes('pins.asc') && wanted.includes('nails.asc'), 'format.asc gathers pins.asc and nails.asc');
    const trio = path.join(directory, 'asc-trio');
    await fs.mkdir(trio, { recursive: true });
    const primary = path.join(trio, 'Format.ASC');
    await fs.writeFile(primary, 'format bytes');
    await fs.writeFile(path.join(trio, 'PINS.asc'), 'pins bytes');
    await fs.writeFile(path.join(trio, 'README.txt'), 'ignored');
    const partial = await invoke('trace:read-board', primary);
    assert.equal(partial.name, 'Format.ASC');
    assert.deepEqual(Object.keys(partial.companions), ['pins.asc'], 'the missing nails.asc is omitted; the parser decides what it needs');
    assert.equal(Object.prototype.toString.call(partial.companions['pins.asc']), '[object Uint8Array]');
    assert.equal(bytesOf(partial.companions['pins.asc']).toString('utf8'), 'pins bytes');
    assert.equal(partial.companions['pins.asc'].buffer.byteLength, 'pins bytes'.length, 'companion buffers are exactly sized too');
    assert.equal(bytesOf(partial.data).toString('utf8'), 'format bytes');
    assert.equal(partial.key, boardKey({ 'Format.ASC': 'format bytes', 'pins.asc': 'pins bytes' }));
    assert.notEqual(partial.key, sha256('format bytes'), 'companion names and bytes are part of the identity');
    await fs.writeFile(path.join(trio, 'nails.asc'), 'nails bytes');
    const full = await invoke('trace:read-board', primary);
    assert.deepEqual(Object.keys(full.companions).sort(), ['nails.asc', 'pins.asc']);
    const fullSet = { 'format.asc': 'format bytes', 'pins.asc': 'pins bytes', 'nails.asc': 'nails bytes' };
    assert.equal(full.key, boardKey(fullSet));
    // B32: the same complete set has the same identity whichever member was chosen as the entry file.
    for (const [file, member] of [['PINS.asc', 'pins.asc'], ['nails.asc', 'nails.asc']]) {
      const other = await invoke('trace:read-board', path.join(trio, file));
      assert.equal(other.key, full.key, `${file} as entry file`);
      assert.equal(other.name, file);
      assert.deepEqual(Object.keys(other.companions).sort(), ['format.asc', 'nails.asc', 'pins.asc'].filter((name) => name !== member), `${file}: the other two members travel as companions`);
      assert.equal(bytesOf(other.data).toString('utf8'), fullSet[member], `${file}: the primary payload is the chosen file`);
    }
    await fs.writeFile(path.join(trio, 'PINS.asc'), 'pins bytes v2');
    const edited = await invoke('trace:read-board', primary);
    assert.notEqual(edited.key, full.key, 'editing a companion changes the board identity, so notes never cross orderings');
    assert.equal(edited.key, boardKey({ 'format.asc': 'format bytes', 'pins.asc': 'pins bytes v2', 'nails.asc': 'nails bytes' }));
    assert.equal((await invoke('trace:read-board', path.join(trio, 'nails.asc'))).key, edited.key, 'the edited set is the same from another entry file');
    const accepting = await desktopHarness(path.join(directory, 'asc-profile'));
    const read = await accepting.invoke('trace:read-board', primary);
    await assert.rejects(accepting.invoke('trace:accept-board', read.path, full.key), /nem igazolható/, 'a stale companion state cannot be acknowledged');
    await accepting.invoke('trace:accept-board', read.path, read.key);
    assert.equal((await accepting.invoke('trace:recent-boards'))[0].name, 'Format.ASC', 'the recent is the primary file, like any single-file board');
    assert.equal((await accepting.invoke('trace:initial-board')).key, read.key, 'a restored companion board carries the same identity');
    // A directory named like a sidecar is skipped; without usable companions the key is the plain primary hash.
    const lone = path.join(directory, 'asc-lone');
    await fs.mkdir(path.join(lone, 'pins.asc'), { recursive: true });
    await fs.writeFile(path.join(lone, 'format.asc'), 'format only');
    const alone = await invoke('trace:read-board', path.join(lone, 'format.asc'));
    assert.equal(alone.companions, undefined);
    assert.equal(alone.key, sha256('format only'));
    // A link that leaves the directory is not a sibling (checked only where this user may create links).
    const outside = path.join(directory, 'outside-nails.asc');
    await fs.writeFile(outside, 'outside bytes');
    let linked = false;
    try { await fs.symlink(outside, path.join(lone, 'nails.asc'), 'file'); linked = true; } catch { /* Creating symlinks needs a privilege on Windows. */ }
    if (linked) assert.equal((await invoke('trace:read-board', path.join(lone, 'format.asc'))).companions, undefined, 'a link leaving the directory is not followed');
    // The primary and its companions together stay within 64 MiB; a single companion over the limit fails the same way.
    const heavy = path.join(directory, 'asc-heavy');
    await fs.mkdir(heavy, { recursive: true });
    await fs.writeFile(path.join(heavy, 'format.asc'), 'x'.repeat(1024));
    await fs.writeFile(path.join(heavy, 'pins.asc'), '');
    await fs.truncate(path.join(heavy, 'pins.asc'), 64 * 1024 * 1024 - 512);
    await assert.rejects(invoke('trace:read-board', path.join(heavy, 'format.asc')), /64 MB/);
    await fs.truncate(path.join(heavy, 'pins.asc'), 64 * 1024 * 1024 + 1);
    await assert.rejects(invoke('trace:read-board', path.join(heavy, 'format.asc')), /64 MB/);
    await fs.truncate(path.join(heavy, 'pins.asc'), 2048);
    assert.equal((await invoke('trace:read-board', path.join(heavy, 'format.asc'))).companions['pins.asc'].byteLength, 2048);
  });

  // fs wrapper for the files below `directory`: hooks see every stat/read/close of their handles.
  const watchedFs = (directory, hooks = {}) => new Proxy(fs, { get(target, property) {
    if (property === 'open') return async (filename, ...rest) => {
      const handle = await target.open(filename, ...rest);
      if (!filename.startsWith(directory)) return handle;
      let started = false;
      return new Proxy(handle, { get(file, key) {
        if (key === 'stat') return async () => { hooks.onStat?.(filename); const result = await file.stat(); await hooks.afterStat?.(filename); return result; };
        if (key === 'read') return async (...args) => {
          if (!started) { started = true; hooks.onStart?.(filename); }
          hooks.onRead?.(filename);
          await hooks.beforeRead?.(filename);
          return file.read(...args);
        };
        if (key === 'close') return async () => { const result = await file.close(); if (started) hooks.onEnd?.(filename); return result; };
        const value = file[key];
        return typeof value === 'function' ? value.bind(file) : value;
      } });
    };
    return target[property];
  } });

  await t.test('a burst of external opens is coalesced: only the newest file is opened and read; superseded deliveries stop before allocating', async () => {
    const burst = path.join(directory, 'burst');
    await fs.mkdir(burst, { recursive: true });
    const files = [];
    for (let index = 0; index < 8; index++) {
      const filename = path.join(burst, `Burst-${index}.cad`);
      await fs.writeFile(filename, validText);
      files.push(filename);
    }
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const reads = [];
    const statted = [];
    const bursting = await desktopHarness(path.join(directory, 'burst-profile'), {
      fs: watchedFs(burst, { onStat: (filename) => statted.push(filename), afterStat: () => gate, onRead: (filename) => reads.push(filename) }),
    });
    await bursting.invoke('trace:initial-board');
    for (const filename of files) bursting.app.emit('second-instance', {}, ['electron.exe', 'app', `--board=${filename}`]);
    await settle(() => statted.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(statted, [files[7]], 'a delivery that is already obsolete never opens its file (B11)');
    release();
    const delivered = () => bursting.window.webContents.sent.filter((event) => event.channel === 'trace:board-opened');
    await settle(() => delivered().length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(delivered().map((event) => event.value.name), ['Burst-7.cad']);
    assert.deepEqual([...new Set(reads)], [files[7]], 'only the newest delivery allocated and read its file');
    assert.equal(bursting.dialog.messages.length, 0, 'superseded deliveries are silent');
    // A direct renderer read is never coalesced away.
    assert.equal((await bursting.invoke('trace:read-board', files[0])).name, 'Burst-0.cad');
  });

  await t.test('B11: a delivery superseded while its file is being read stops between chunks instead of reading it to the end', async () => {
    const stream = path.join(directory, 'stream');
    await fs.mkdir(stream, { recursive: true });
    const big = path.join(stream, 'Big.cad');
    const small = path.join(stream, 'Small.cad');
    await fs.writeFile(big, '');
    await fs.truncate(big, 24 * 1024 * 1024); // Sparse: six 4 MiB chunks.
    await fs.writeFile(small, validText);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const reads = [];
    const harness = await desktopHarness(path.join(directory, 'stream-profile'), {
      fs: watchedFs(stream, { onRead: (filename) => reads.push(path.basename(filename)), beforeRead: (filename) => (filename === big && reads.length === 1 ? gate : undefined) }),
    });
    await harness.invoke('trace:initial-board');
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', `--board=${big}`]);
    await settle(() => reads.length >= 1);
    assert.deepEqual(reads, ['Big.cad'], 'the older delivery is inside its first chunk');
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', `--board=${small}`]);
    await settle(() => reads.includes('Small.cad'));
    release();
    const delivered = () => harness.window.webContents.sent.filter((event) => event.channel === 'trace:board-opened');
    await settle(() => delivered().length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(delivered().map((event) => event.value.name), ['Small.cad']);
    assert.equal(reads.filter((name) => name === 'Big.cad').length, 1, 'the obsolete read stopped after its first chunk (4 of 24 MiB)');
    assert.equal(harness.dialog.messages.length, 0);
  });

  await t.test('B11: concurrent reads together never hold more than the aggregate budget', async () => {
    const heavy = path.join(directory, 'budget');
    await fs.mkdir(heavy, { recursive: true });
    const files = [];
    for (let index = 0; index < 5; index++) {
      const filename = path.join(heavy, `Heavy-${index}.cad`);
      await fs.writeFile(filename, '');
      await fs.truncate(filename, 30 * 1024 * 1024); // 5 x 30 MiB against a 128 MiB budget: four at a time.
      files.push(filename);
    }
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let active = 0;
    let peak = 0;
    const harness = await desktopHarness(path.join(directory, 'budget-profile'), {
      fs: watchedFs(heavy, { onStart: () => { active++; peak = Math.max(peak, active); }, onEnd: () => { active--; }, beforeRead: () => gate }),
    });
    const reading = Promise.all(files.map((filename) => harness.invoke('trace:read-board', filename)));
    await settle(() => active >= 4);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(active, 4, 'the fifth read waits for budget while four hold 120 MiB');
    release();
    const payloads = await reading;
    assert.equal(peak, 4);
    assert.deepEqual(payloads.map((payload) => payload.data.byteLength), files.map(() => 30 * 1024 * 1024));
  });

  await t.test('B33: a board that shrinks after stat is rejected instead of returned truncated', async () => {
    const shrink = path.join(directory, 'shrink');
    await fs.mkdir(shrink, { recursive: true });
    const filename = path.join(shrink, 'Shrunk.cad');
    await fs.writeFile(filename, validText);
    const lying = new Proxy(fs, { get(target, property) {
      if (property === 'open') return async (name, ...rest) => {
        const handle = await target.open(name, ...rest);
        if (name !== filename) return handle;
        return new Proxy(handle, { get(file, key) {
          if (key === 'stat') return async () => Object.assign(await file.stat(), { size: validText.length + 40 }); // The file was longer when stat ran.
          const value = file[key];
          return typeof value === 'function' ? value.bind(file) : value;
        } });
      };
      return target[property];
    } });
    const harness = await desktopHarness(path.join(directory, 'shrink-profile'), { fs: lying });
    await assert.rejects(harness.invoke('trace:read-board', filename), { message: i18n.translate('hu', 'native.error.fileChangedWhileReading') });
    // Growth is still caught: stat reports less than the file holds.
    const growing = new Proxy(lying, { get(target, property) {
      if (property === 'open') return async (name, ...rest) => {
        const handle = await fs.open(name, ...rest);
        if (name !== filename) return handle;
        return new Proxy(handle, { get(file, key) {
          if (key === 'stat') return async () => Object.assign(await file.stat(), { size: validText.length - 5 });
          const value = file[key];
          return typeof value === 'function' ? value.bind(file) : value;
        } });
      };
      return target[property];
    } });
    const harness2 = await desktopHarness(path.join(directory, 'grow-profile'), { fs: growing });
    await assert.rejects(harness2.invoke('trace:read-board', filename), { message: i18n.translate('hu', 'native.error.fileChangedWhileReading') });
    assert.equal((await harness2.invoke('trace:recent-boards')).length, 0);
  });

  await t.test('dialog cancellation and local chosen file are handled', async () => {
    assert.equal(await invoke('trace:open-board'), null);
    harness.dialog.choice = { canceled: false, filePaths: [boardFile] };
    assert.equal((await invoke('trace:open-board')).name, 'Circuit.CAD');
  });

  await t.test('settings validation and serial writes preserve the latest choices', async () => {
    const settings = await invoke('trace:get-settings');
    assert.equal(settings.theme, 'dark');
    const next = { ...settings, theme: 'light', motion: false };
    await invoke('trace:save-settings', next);
    const current = await invoke('trace:get-settings');
    assert.equal(current.theme, 'light');
    assert.equal(current.motion, false);
    await assert.rejects(invoke('trace:save-settings', { ...next, theme: 'unknown' }), /érvénytelenek/);
    await assert.rejects(invoke('trace:save-settings', { ...next, showLabels: 'true' }), /érvénytelenek/);
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
    assert.equal(saved.settings.theme, 'light');
    assert.equal(saved.recentBoards.length, 1);
  });

  await t.test('notes persist by board content and reject traversal or invalid records', async () => {
    const { key } = await invoke('trace:read-board', boardFile);
    assert.equal((await invoke('trace:get-notes', key)).length, 0);
    const note = { id: 'note-1', componentId: 'U1', text: 'Ellenőrizni a tápot', updatedAt: new Date().toISOString() };
    await invoke('trace:save-notes', key, [note]);
    const loaded = await invoke('trace:get-notes', key);
    assert.equal(loaded[0].text, note.text);
    await assert.rejects(invoke('trace:save-notes', '../outside', [note]), /boardazonosító/);
    await assert.rejects(invoke('trace:save-notes', key, [note, note]), /Érvénytelen megjegyzés/);
    await assert.rejects(invoke('trace:save-notes', key, [{ ...note, text: 'a'.repeat(8001) }]), /8000/);
    // One note per component: a second record for the same component is rejected on write and locks a stored file on read.
    const twin = { ...note, id: 'note-2', text: 'Hidden duplicate' };
    await assert.rejects(invoke('trace:save-notes', key, [note, twin]), { message: i18n.translate('hu', 'native.error.invalidNote', { max: 8000 }) });
    assert.equal((await invoke('trace:get-notes', key))[0].text, note.text);
    const stored = path.join(directory, 'notes', `${key}.json`);
    const original = await fs.readFile(stored, 'utf8');
    await fs.writeFile(stored, JSON.stringify([note, twin]));
    await assert.rejects(invoke('trace:get-notes', key), { message: i18n.translate('hu', 'native.error.notesUnreadable') });
    await fs.writeFile(stored, original);
    assert.equal((await invoke('trace:get-notes', key))[0].text, note.text);
    assert.equal((await fs.readdir(path.join(directory, 'notes'))).length, 1);
  });

  await t.test('window controls report maximize state and send events', async () => {
    assert.equal(await invoke('trace:is-maximized'), false);
    harness.message('trace:maximize');
    assert.equal(await invoke('trace:is-maximized'), true);
    harness.message('trace:maximize');
    assert.equal(await invoke('trace:is-maximized'), false);
    harness.message('trace:minimize');
    assert.equal(window.minimizeCount, 1);
    assert.equal(window.webContents.sent.filter((event) => event.channel === 'trace:maximized').length, 2);
  });

  await t.test('another launch restores settings, recent board and notes', async () => {
    const reopened = await desktopHarness(directory);
    assert.equal((await reopened.invoke('trace:get-settings')).theme, 'light');
    const restored = await reopened.invoke('trace:initial-board');
    assert.equal(restored.name, 'Circuit.CAD');
    assert.equal(restored.startupSource, 'recent');
    assert.equal((await reopened.invoke('trace:get-notes', restored.key))[0].componentId, 'U1');
  });

  await t.test('stale earlier read never replaces the latest renderer-accepted recent', async () => {
    const earlier = path.join(directory, 'Earlier.cad');
    const latest = path.join(directory, 'Latest.cad');
    await fs.writeFile(earlier, validText);
    await fs.writeFile(latest, `${validText}\n`);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const delayedFs = new Proxy(fs, { get(target, property) {
      if (property === 'realpath') return async filename => { if (filename === earlier) await gate; return target.realpath(filename); };
      return target[property];
    } });
    const raced = await desktopHarness(path.join(directory, 'stale-profile'), { fs: delayedFs });
    const oldRead = raced.invoke('trace:read-board', earlier);
    const accepted = await raced.invoke('trace:read-board', latest);
    await raced.invoke('trace:accept-board', accepted.path, accepted.key);
    release();
    await oldRead;
    assert.equal((await raced.invoke('trace:recent-boards'))[0].name, 'Latest.cad');
    const restored = await raced.invoke('trace:initial-board');
    assert.equal(restored.name, 'Latest.cad');
  });

  await t.test('obsolete external launch payload and error cannot override the latest launch', async () => {
    const earlier = path.join(directory, 'Earlier.cad');
    const latest = path.join(directory, 'Latest.cad');
    for (const failEarlier of [false, true]) {
      let release, earlierFinished = false;
      const gate = new Promise(resolve => { release = resolve; });
      const delayedFs = new Proxy(fs, { get(target, property) {
        if (property === 'realpath') return async filename => {
          if (filename === earlier) {
            await gate; earlierFinished = true;
            if (failEarlier) throw Object.assign(new Error('missing earlier board'), { code: 'ENOENT' });
          }
          return target.realpath(filename);
        };
        return target[property];
      } });
      const external = await desktopHarness(path.join(directory, `external-profile-${failEarlier}`), { fs: delayedFs });
      await external.invoke('trace:initial-board');
      external.app.emit('second-instance', {}, ['electron.exe', 'app', `--board=${earlier}`]);
      external.app.emit('second-instance', {}, ['electron.exe', 'app', `--board=${latest}`]);
      for (let attempt = 0; attempt < 100 && !external.window.webContents.sent.some(event => event.channel === 'trace:board-opened'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      release();
      for (let attempt = 0; attempt < 100 && !earlierFinished; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      await new Promise(resolve => setTimeout(resolve, 30));
      const delivered = external.window.webContents.sent.filter(event => event.channel === 'trace:board-opened');
      assert.deepEqual(delivered.map(event => event.value.name), ['Latest.cad']);
      assert.equal(external.dialog.messages.length, 0);
    }
  });

  await t.test('unaccepted malformed board cannot become the restored recent', async () => {
    const unaccepted = await desktopHarness(path.join(directory, 'malformed-profile'));
    const parsed = await unaccepted.invoke('trace:read-board', boardFile);
    await unaccepted.invoke('trace:accept-board', parsed.path, parsed.key);
    const bad = path.join(directory, 'Header-only.cad');
    await fs.writeFile(bad, '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n');
    await unaccepted.invoke('trace:read-board', bad);
    assert.equal((await unaccepted.invoke('trace:recent-boards'))[0].name, 'Circuit.CAD');
    assert.equal((await unaccepted.invoke('trace:initial-board')).name, 'Circuit.CAD');
  });

  await t.test('new renderer read or chooser intent suppresses an older external payload and error', async () => {
    const earlier = path.join(directory, 'Earlier.cad');
    const latest = path.join(directory, 'Latest.cad');
    for (const intent of ['read', 'open', 'cancel']) {
      for (const failEarlier of [false, true]) {
        let release, began = false, finished = false, opened = false;
        const gate = new Promise(resolve => { release = resolve; });
        const delayedFs = new Proxy(fs, { get(target, property) {
          if (property === 'realpath') return async filename => {
            if (filename === earlier) {
              began = true; await gate;
              if (failEarlier) { finished = true; throw Object.assign(new Error('missing earlier board'), { code: 'ENOENT' }); }
              // A superseded delivery stops right after this step (B11): it never opens the file.
              const canonical = await target.realpath(filename);
              finished = true;
              return canonical;
            }
            return target.realpath(filename);
          };
          if (property === 'open') return async (filename, ...arguments_) => {
            const handle = await target.open(filename, ...arguments_);
            if (filename !== earlier) return handle;
            opened = true;
            return new Proxy(handle, { get(file, key) {
              if (key === 'close') return async () => { const result = await file.close(); finished = true; return result; };
              const value = file[key];
              return typeof value === 'function' ? value.bind(file) : value;
            } });
          };
          return target[property];
        } });
        const crossed = await desktopHarness(path.join(directory, `cross-profile-${intent}-${failEarlier}`), { fs: delayedFs });
        await crossed.invoke('trace:initial-board');
        crossed.app.emit('second-instance', {}, ['electron.exe', 'app', `--board=${earlier}`]);
        for (let attempt = 0; attempt < 100 && !began; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(began, true);
        let accepted;
        if (intent === 'read') accepted = await crossed.invoke('trace:read-board', latest);
        else {
          crossed.dialog.choice = intent === 'cancel' ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [latest] };
          accepted = await crossed.invoke('trace:open-board');
        }
        if (accepted) await crossed.invoke('trace:accept-board', accepted.path, accepted.key);
        else assert.equal(accepted, null);
        release();
        for (let attempt = 0; attempt < 100 && !finished; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(finished, true);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(opened, false, 'the superseded delivery never opened the file');
        assert.equal(crossed.window.webContents.sent.filter(event => event.channel === 'trace:board-opened').length, 0);
        assert.equal(crossed.dialog.messages.length, 0);
        const recent = await crossed.invoke('trace:recent-boards');
        if (intent === 'cancel') assert.equal(recent.length, 0);
        else assert.equal(recent[0].name, 'Latest.cad');
      }
    }
  });

  await t.test('native read candidate memory is bounded and requires a fresh read after eviction', async () => {
    const bounded = await desktopHarness(path.join(directory, 'bounded-profile'));
    const first = await bounded.invoke('trace:read-board', boardFile);
    let latest;
    for (let index = 0; index < 64; index++) {
      const filename = path.join(directory, `Candidate-${index}.cad`);
      await fs.writeFile(filename, validText);
      latest = await bounded.invoke('trace:read-board', filename);
    }
    await assert.rejects(bounded.invoke('trace:accept-board', first.path, first.key), /nem igazolható/);
    await bounded.invoke('trace:accept-board', latest.path, latest.key);
    const refreshed = await bounded.invoke('trace:read-board', boardFile);
    await bounded.invoke('trace:accept-board', refreshed.path, refreshed.key);
    assert.equal((await bounded.invoke('trace:recent-boards'))[0].name, 'Circuit.CAD');
  });

  await t.test('closing during startup suppresses aborted navigation and cannot show a destroyed window', async () => {
    let rejectLoad;
    const loading = new Promise((_, reject) => { rejectLoad = reject; });
    const closing = await desktopHarness(path.join(directory, 'closed-startup-profile'), { loadURL: () => loading, captureErrors: true });
    closing.window.close();
    rejectLoad(Object.assign(new Error('ERR_ABORTED'), { code: 'ERR_ABORTED' }));
    closing.window.emit('ready-to-show');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closing.dialog.errorBoxes.length, 0);
    assert.equal(closing.window.showCount || 0, 0);
    assert.equal(closing.app.quitCount, 0);
  });

  await t.test('quit intent suppresses aborted startup before the window is destroyed', async () => {
    let rejectLoad;
    const loading = new Promise((_, reject) => { rejectLoad = reject; });
    const quitting = await desktopHarness(path.join(directory, 'quitting-startup-profile'), { loadURL: () => loading, captureErrors: true });
    let prevented = false;
    quitting.app.emit('before-quit', { preventDefault() { prevented = true; } });
    assert.equal(quitting.window.isDestroyed(), false);
    rejectLoad(Object.assign(new Error('ERR_ABORTED'), { code: 'ERR_ABORTED' }));
    quitting.window.emit('ready-to-show');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prevented, true);
    assert.equal(quitting.dialog.errorBoxes.length, 0);
    assert.equal(quitting.window.showCount || 0, 0);
    assert.equal(quitting.app.quitCount, 1);
  });

  await t.test('a real load failure in a live window remains visible and quits the app', async () => {
    for (const code of ['ERR_FILE_NOT_FOUND', 'ERR_ABORTED']) {
      let rejectLoad;
      const loading = new Promise((_, reject) => { rejectLoad = reject; });
      const broken = await desktopHarness(path.join(directory, `broken-startup-${code}`), { loadURL: () => loading, captureErrors: true });
      rejectLoad(Object.assign(new Error(code), { code }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(broken.window.isDestroyed(), false);
      assert.equal(broken.dialog.errorBoxes.length, 1);
      assert.match(broken.dialog.errorBoxes[0].title, /indítási hiba/);
      assert.match(broken.dialog.errorBoxes[0].message, /felület nem tölthető be/);
      assert.equal(broken.app.quitCount, 1);
    }
  });
});

test('native localization: language setting, migration, detection, dialogs and messages', async (t) => {
  const root = await makeTempDir('trace-native-i18n-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const validText = '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n';
  const boardFile = path.join(root, 'Old.cad');
  await fs.writeFile(boardFile, validText);
  const missing = path.join(root, 'missing.cad');
  const profile = async (name, config) => {
    const directory = path.join(root, name);
    await fs.mkdir(directory, { recursive: true });
    if (config) await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
    return directory;
  };
  const plain = (value) => JSON.parse(JSON.stringify(value)); // The harness runs main.cjs in another realm.
  const readConfig = async (directory) => JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
  const oldSettings = { theme: 'light', layout: 'focus', motion: false, showLabels: false, showConnections: false };
  const oldRecent = { name: 'Old.cad', path: boardFile, openedAt: '2026-01-02T03:04:05.000Z' };

  await t.test('a pre-language profile keeps every setting and recent file, stays Hungarian and ignores the system language', async () => {
    const directory = await profile('legacy', { version: 1, settings: oldSettings, recentBoards: [oldRecent] });
    const harness = await desktopHarness(directory, { systemLanguages: ['de-DE'] });
    assert.deepEqual(plain(await harness.invoke('trace:get-settings')), { language: 'hu', ...oldSettings, updateCheck: true }, 'a profile saved before the update check gets it switched on (the default)');
    const recents = await harness.invoke('trace:recent-boards');
    assert.equal(recents.length, 1);
    assert.equal(recents[0].path.toLowerCase(), boardFile.toLowerCase());
    assert.equal(recents[0].openedAt, oldRecent.openedAt);
    await assert.rejects(harness.invoke('trace:read-board', missing), { message: i18n.translate('hu', 'native.error.boardNotFound') });
    // The first write stores the migrated language and keeps everything else.
    await harness.invoke('trace:save-settings', { ...(await harness.invoke('trace:get-settings')), theme: 'dark' });
    const saved = await readConfig(directory);
    assert.deepEqual(saved.settings, { language: 'hu', ...oldSettings, updateCheck: true, theme: 'dark' });
    assert.equal(saved.recentBoards.length, 1);
  });

  await t.test('a profile with an unusable stored language keeps its other settings and becomes Hungarian', async () => {
    for (const language of ['xx', 42, null, '']) {
      const directory = await profile(`bad-language-${String(language) || 'empty'}`, { version: 1, settings: { ...oldSettings, language }, recentBoards: [oldRecent] });
      const harness = await desktopHarness(directory, { systemLanguages: ['fr-FR'] });
      assert.deepEqual(plain(await harness.invoke('trace:get-settings')), { language: 'hu', ...oldSettings, updateCheck: true });
      assert.equal((await harness.invoke('trace:recent-boards')).length, 1);
    }
  });

  await t.test('one damaged stored field falls back to its default without resetting the other settings', async () => {
    const directory = await profile('damaged-field', { version: 1, settings: { language: 'sk', theme: 'purple', layout: 'focus', motion: 'yes', showLabels: false, showConnections: false }, recentBoards: [oldRecent] });
    const harness = await desktopHarness(directory, { systemLanguages: ['de-DE'] });
    assert.deepEqual(plain(await harness.invoke('trace:get-settings')), { language: 'sk', theme: 'dark', layout: 'focus', motion: true, showLabels: false, showConnections: false, updateCheck: true });
    assert.equal((await harness.invoke('trace:recent-boards')).length, 1);
  });

  await t.test('a fresh profile follows the system language, falls back to English and stores it with the first write', async () => {
    for (const [system, expected] of [[['de-AT', 'en-US'], 'de'], [['uk-UA'], 'uk'], [['zz-ZZ', 'fr-CA'], 'fr'], [['SK'], 'sk'], [['ja-JP'], 'en'], [[], 'en']]) {
      const harness = await desktopHarness(await profile(`fresh-${expected}-${system.join('_') || 'none'}`), { systemLanguages: system });
      assert.equal((await harness.invoke('trace:get-settings')).language, expected);
    }
    const noApis = await desktopHarness(await profile('fresh-no-apis'), { withoutLanguageApis: true });
    assert.equal((await noApis.invoke('trace:get-settings')).language, 'en');
    const directory = await profile('fresh-persist');
    const harness = await desktopHarness(directory, { systemLanguages: ['pl-PL'] });
    const payload = await harness.invoke('trace:read-board', boardFile);
    await harness.invoke('trace:accept-board', payload.path, payload.key);
    assert.equal((await readConfig(directory)).settings.language, 'pl');
    const again = await desktopHarness(directory, { systemLanguages: ['hu-HU'] });
    assert.equal((await again.invoke('trace:get-settings')).language, 'pl', 'the stored choice wins over the system language');
  });

  await t.test('every language: saving switches native messages and dialogs at once and survives a restart', async () => {
    const directory = await profile('switch');
    const harness = await desktopHarness(directory);
    const tooLong = { id: 'n1', componentId: 'U1', text: 'a'.repeat(8001), updatedAt: new Date().toISOString() };
    for (const language of i18n.LANGUAGES) {
      await harness.invoke('trace:save-settings', { ...(await harness.invoke('trace:get-settings')), language });
      harness.dialog.choice = { canceled: true, filePaths: [] };
      assert.equal(await harness.invoke('trace:open-board'), null);
      const options = harness.dialog.openOptions.at(-1);
      assert.equal(options.title, i18n.translate(language, 'native.dialog.openTitle'));
      assert.equal(options.buttonLabel, i18n.translate(language, 'native.dialog.openButton'));
      assert.equal(options.filters[0].name, i18n.translate(language, 'native.dialog.openFilter'));
      assert.deepEqual(plain(options.filters[0].extensions), formats.SUPPORTED_EXTENSIONS.map((extension) => extension.slice(1)));
      await assert.rejects(harness.invoke('trace:read-board', missing), { message: i18n.translate(language, 'native.error.boardNotFound') });
      await assert.rejects(harness.invoke('trace:read-board', '../Circuit.CAD'), { message: i18n.translate(language, 'native.error.invalidPath') });
      await assert.rejects(harness.invoke('trace:save-notes', 'a'.repeat(64), [tooLong]), { message: i18n.translate(language, 'native.error.invalidNote', { max: 8000 }) });
      await assert.rejects(harness.invoke('trace:save-settings', { ...(await harness.invoke('trace:get-settings')), theme: 'unknown' }), { message: i18n.translate(language, 'native.error.invalidSettings') });
      const reopened = await desktopHarness(directory, { systemLanguages: ['hu-HU'] });
      assert.equal((await reopened.invoke('trace:get-settings')).language, language);
      await assert.rejects(reopened.invoke('trace:read-board', missing), { message: i18n.translate(language, 'native.error.boardNotFound') });
    }
    assert.equal((await readConfig(directory)).settings.language, 'uk');
  });

  await t.test('language values are validated and a caller that omits the language keeps the current one', async () => {
    const harness = await desktopHarness(await profile('validate'), { systemLanguages: ['it-IT'] });
    const settings = await harness.invoke('trace:get-settings');
    assert.equal(settings.language, 'it');
    for (const language of ['xx', 'EN', 7, null, {}]) {
      await assert.rejects(harness.invoke('trace:save-settings', { ...settings, language }), { message: i18n.translate('it', 'native.error.invalidSettings') });
    }
    const { language: _language, ...withoutLanguage } = settings;
    await harness.invoke('trace:save-settings', { ...withoutLanguage, theme: 'light' });
    assert.deepEqual(plain(await harness.invoke('trace:get-settings')), { ...plain(settings), theme: 'light' });
  });

  await t.test('a failed external open reports in the current language and the stored language is used for startup errors', async () => {
    const directory = await profile('delivery', { version: 1, settings: { ...oldSettings, language: 'de' }, recentBoards: [] });
    const harness = await desktopHarness(directory);
    await harness.invoke('trace:initial-board');
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', `--board=${missing}`]);
    for (let attempt = 0; attempt < 100 && !harness.dialog.messages.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(harness.dialog.messages.length, 1);
    assert.equal(harness.dialog.messages[0].title, i18n.translate('de', 'native.dialog.openFailedTitle'));
    assert.equal(harness.dialog.messages[0].message, i18n.translate('de', 'native.error.boardNotFound'));
    await harness.invoke('trace:save-settings', { ...(await harness.invoke('trace:get-settings')), language: 'fr' });
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', `--board=${missing}`]);
    for (let attempt = 0; attempt < 100 && harness.dialog.messages.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(harness.dialog.messages[1].title, i18n.translate('fr', 'native.dialog.openFailedTitle'));
    assert.equal(harness.dialog.messages[1].message, i18n.translate('fr', 'native.error.boardNotFound'));

    for (const language of ['en', 'uk']) {
      let rejectLoad;
      const loading = new Promise((_, reject) => { rejectLoad = reject; });
      const stored = await profile(`startup-${language}`, { version: 1, settings: { ...oldSettings, language }, recentBoards: [] });
      const broken = await desktopHarness(stored, { loadURL: () => loading, captureErrors: true });
      rejectLoad(Object.assign(new Error('ERR_FILE_NOT_FOUND'), { code: 'ERR_FILE_NOT_FOUND' }));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(broken.dialog.errorBoxes.length, 1);
      assert.equal(broken.dialog.errorBoxes[0].title, i18n.translate(language, 'native.dialog.startupErrorTitle'));
      assert.equal(broken.dialog.errorBoxes[0].message, i18n.translate(language, 'native.dialog.startupLoadFailed'));
      assert.equal(broken.app.quitCount, 1);
    }
  });

  await t.test('the system language is only queried after the app is ready, and a ready app uses it for a fresh profile', async () => {
    const harness = await desktopHarness(await profile('ready-order'), { deferReady: true, systemLanguages: ['pl-PL', 'en-US'] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(harness.languageCalls.total, 0, 'nothing may read the system language before whenReady resolves');
    harness.releaseReady();
    await harness.waitForWindow();
    assert.equal(harness.languageCalls.beforeReady, 0);
    assert.ok(harness.languageCalls.total >= 1, 'a fresh profile reads the system language once the app is ready');
    assert.equal((await harness.invoke('trace:get-settings')).language, 'pl');
    // An existing profile never needs the system language.
    const existing = await desktopHarness(await profile('ready-order-existing', { version: 1, settings: oldSettings, recentBoards: [] }), { systemLanguages: ['de-DE'] });
    assert.equal(existing.languageCalls.total, 0);
    assert.equal((await existing.invoke('trace:get-settings')).language, 'hu');
  });

  await t.test('a damaged, future or incomplete config is an existing profile: Hungarian, never the system language', async () => {
    const defaults = { language: 'hu', theme: 'dark', layout: 'workshop', motion: true, showLabels: true, showConnections: true, updateCheck: true };
    for (const [name, content, recents] of [
      ['garbage', '{ this is not json', 0],
      ['future-version', JSON.stringify({ version: 2, settings: { ...oldSettings, language: 'de' }, recentBoards: [oldRecent] }), 0],
      ['no-settings', JSON.stringify({ version: 1, recentBoards: [oldRecent] }), 1],
      ['settings-array', JSON.stringify({ version: 1, settings: [], recentBoards: [oldRecent] }), 1],
      ['settings-null', JSON.stringify({ version: 1, settings: null, recentBoards: [] }), 0],
    ]) {
      const directory = await profile(`damaged-${name}`);
      await fs.writeFile(path.join(directory, 'config.json'), content);
      const harness = await desktopHarness(directory, { systemLanguages: ['fr-FR'] });
      assert.deepEqual(plain(await harness.invoke('trace:get-settings')), defaults, name);
      assert.equal((await harness.invoke('trace:recent-boards')).length, recents, name);
    }
  });

  await t.test('overlapping language saves end with the last choice in memory, on disk and after a restart', async () => {
    const directory = await profile('overlap');
    const harness = await desktopHarness(directory, { systemLanguages: ['hu-HU'] });
    const current = await harness.invoke('trace:get-settings');
    await Promise.all(['de', 'fr', 'pl', 'sk'].map((language) => harness.invoke('trace:save-settings', { ...current, language })));
    assert.equal((await harness.invoke('trace:get-settings')).language, 'sk');
    assert.equal((await readConfig(directory)).settings.language, 'sk');
    await assert.rejects(harness.invoke('trace:read-board', missing), { message: i18n.translate('sk', 'native.error.boardNotFound') });
    const reopened = await desktopHarness(directory, { systemLanguages: ['hu-HU'] });
    assert.equal((await reopened.invoke('trace:get-settings')).language, 'sk');
  });

  await t.test('a language switch does not touch recents, notes, the accepted-board contract or the startup source', async () => {
    const directory = await profile('switch-keeps-state', { version: 1, settings: { ...oldSettings, language: 'hu' }, recentBoards: [oldRecent] });
    const harness = await desktopHarness(directory);
    const payload = await harness.invoke('trace:read-board', boardFile);
    await harness.invoke('trace:accept-board', payload.path, payload.key);
    const note = { id: 'n1', componentId: 'U1', text: 'Ellenőrzött', updatedAt: new Date().toISOString() };
    await harness.invoke('trace:save-notes', payload.key, [note]);
    await harness.invoke('trace:save-settings', { ...(await harness.invoke('trace:get-settings')), language: 'uk' });
    assert.equal((await harness.invoke('trace:recent-boards')).length, 1);
    assert.equal((await harness.invoke('trace:get-notes', payload.key))[0].text, note.text, 'notes are user data and never translated');
    await assert.rejects(harness.invoke('trace:accept-board', payload.path, 'b'.repeat(64)), { message: i18n.translate('uk', 'native.error.boardNotVerified') });
    const reopened = await desktopHarness(directory);
    const restored = await reopened.invoke('trace:initial-board');
    assert.equal(restored.startupSource, 'recent');
    assert.equal((await reopened.invoke('trace:get-settings')).language, 'uk');
  });

  await t.test('every native message key used by the native modules exists in all eight catalogs and none is left unused', async () => {
    // main.cjs hands its translator to store.cjs, repair-store.cjs and documents.cjs, which look up their own keys.
    let source = '';
    for (const name of ['main', 'store', 'repair-store', 'documents', 'workspace', 'identity', 'formats']) source += await fs.readFile(path.resolve(__dirname, '..', 'electron', `${name}.cjs`), 'utf8');
    const used = new Set([...source.matchAll(/\bt\('(native\.[\w.]+)'/g)].map((match) => match[1]));
    assert.ok(used.size >= 25, 'main.cjs should use the native catalog keys');
    // Recognition moved to the renderer parser: the key that judged GENCAD content was removed from every catalog.
    assert.equal(used.has('native.error.notGencad'), false, 'the native process no longer judges file contents');
    for (const language of i18n.LANGUAGES) {
      const catalog = i18n.catalogs[language];
      for (const key of used) assert.ok(Object.hasOwn(catalog, key), `${language} lacks ${key}`);
      assert.equal(Object.hasOwn(catalog, 'native.error.notGencad'), false, `${language} still carries the dead key`);
      const nativeKeys = Object.keys(catalog).filter((key) => key.startsWith('native.'));
      assert.deepEqual(nativeKeys.filter((key) => !used.has(key)), [], `${language} has native keys no native module uses`);
    }
  });

  await t.test('no user-visible Hungarian text is hard-coded in the native sources', async () => {
    for (const name of ['main.cjs', 'preload.cjs', 'formats.cjs']) {
      const source = await fs.readFile(path.resolve(__dirname, '..', 'electron', name), 'utf8');
      assert.equal(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/.test(source), false, `${name} contains Hungarian letters`);
    }
  });
});

test('format manifest: electron/formats.cjs mirrors electron/formats.json and refuses a damaged manifest', async () => {
  const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, '..', 'electron', 'formats.json'), 'utf8'));
  assert.deepEqual([...formats.SUPPORTED_EXTENSIONS], manifest.extensions, 'the CJS list equals the JSON manifest');
  assert.ok(formats.SUPPORTED_EXTENSIONS.length >= 2);
  assert.ok(Object.isFrozen(formats.SUPPORTED_EXTENSIONS));
  for (const extension of formats.SUPPORTED_EXTENSIONS) {
    assert.match(extension, /^\.[a-z0-9_]+$/, `${extension} must start with "." and be lowercase`);
    assert.equal(extension, extension.toLowerCase());
  }
  assert.equal(new Set(formats.SUPPORTED_EXTENSIONS).size, formats.SUPPORTED_EXTENSIONS.length, 'no duplicate extensions');
  for (const required of ['.cad', '.gcd']) assert.ok(formats.SUPPORTED_EXTENSIONS.includes(required), `${required} stays supported`);
  const companions = manifest.companions ?? {};
  assert.ok(Object.keys(companions).length >= 1, 'the ASC trio is declared');
  for (const [primary, siblings] of Object.entries(companions)) {
    assert.deepEqual(formats.companionNames(primary), siblings);
    assert.deepEqual(formats.companionNames(path.join('C:\\Boards', primary.toUpperCase())), siblings, 'matched by case-insensitive basename');
    for (const name of [primary, ...siblings]) {
      assert.equal(name, name.toLowerCase(), `${name} must be lowercase`);
      assert.ok(formats.isSupportedExtension(name), `${name} must itself be an openable file`);
    }
  }
  assert.ok(formats.companionNames('format.asc').includes('pins.asc'));
  assert.deepEqual(formats.companionNames('board.cad'), []);
  assert.deepEqual(formats.companionNames(42), []);
  const copy = formats.companionNames('format.asc');
  copy.push('other.asc');
  assert.equal(formats.companionNames('format.asc').includes('other.asc'), false, 'callers receive a copy');
  assert.equal(formats.isSupportedExtension('C:\\Boards\\BOARD.CAD'), true);
  assert.equal(formats.isSupportedExtension('board.kicad_pcb'), formats.SUPPORTED_EXTENSIONS.includes('.kicad_pcb'));
  for (const value of ['board.unsupported', 'board.cad.bak', 'board', '', 'cad', undefined, null, 7]) assert.equal(formats.isSupportedExtension(value), false, String(value));
  const filters = formats.dialogFilters('Every board');
  assert.deepEqual(filters[0], { name: 'Every board', extensions: formats.SUPPORTED_EXTENSIONS.map((extension) => extension.slice(1)) });
  for (const filter of filters) assert.ok(filter.extensions.every((extension) => !extension.startsWith('.') && formats.SUPPORTED_EXTENSIONS.includes(`.${extension}`)), filter.name);
  // A damaged manifest is refused when the module loads, never silently narrowed or widened.
  const source = await fs.readFile(path.resolve(__dirname, '..', 'electron', 'formats.cjs'), 'utf8');
  const load = (json) => vm.runInNewContext(source, { require: (name) => name === './formats.json' ? json : require(name), module: {} }, { filename: 'formats.cjs' });
  for (const bad of [
    null, {}, { extensions: [] }, { extensions: 'cad' }, { extensions: ['cad'] }, { extensions: ['.CAD'] }, { extensions: ['.cad', '.cad'] },
    { extensions: ['.c ad'] }, { extensions: ['.cad'], companions: [] }, { extensions: ['.cad'], companions: { 'format.asc': 'pins.asc' } },
    { extensions: ['.cad'], companions: { 'format.asc': ['format.asc'] } }, { extensions: ['.cad'], companions: { 'Format.asc': ['pins.asc'] } },
    { extensions: ['.cad'], companions: { 'format.asc': ['../pins.asc'] } }, { extensions: ['.cad'], companions: { 'format.asc': ['PINS.asc'] } },
    { extensions: ['.cad'], families: {} }, { extensions: ['.cad'], families: [{ name: 'GenCAD', extensions: ['.brd'] }] }, { extensions: ['.cad'], families: [{ name: 'Gén', extensions: ['.cad'] }] },
    { extensions: ['.cad'], families: [{ name: 'GenCAD', extensions: '.cad' }] }, { extensions: ['.cad'], families: [null] },
  ]) assert.throws(() => load(bad), /formats\.json/, JSON.stringify(bad));
  assert.deepEqual(Array.from(load({ extensions: ['.cad'] }).dialogFilters('x'), (filter) => Array.from(filter.extensions)), [['cad']], 'no families: only the every-format filter');
  const loaded = load({ extensions: ['.cad'], companions: { 'a.asc': ['b.asc'] }, families: [{ name: 'GenCAD', extensions: ['.cad'] }] });
  assert.deepEqual([...loaded.SUPPORTED_EXTENSIONS], ['.cad']);
  assert.deepEqual([...loaded.companionNames('A.ASC')], ['b.asc']);
  assert.deepEqual(Array.from(loaded.dialogFilters('x'), (filter) => Array.from(filter.extensions)), [['cad'], ['cad']]);
});

// ---------------------------------------------------------------------------------------------
// Workspace, documents and the shutdown gate through main.cjs's real handlers (mocked Electron)
// ---------------------------------------------------------------------------------------------
test('native workspace, documents and shutdown gate through the IPC handlers', async (t) => {
  const root = await makeTempDir('trace-native-ws-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const NOW = '2026-03-04T05:06:07.000Z';
  const KEY = 'a'.repeat(64);
  const text = (key, params) => i18n.translate('hu', key, params);
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let counter = 0;
  const profile = () => path.join(root, `profile-${++counter}`);
  const PDF = Buffer.from('%PDF-1.4\n% synthetic datasheet\n%%EOF\n');
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'docs'), { recursive: true });
  const BOARD = '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n';
  const boardFile = path.join(project, 'Board.cad');
  await fs.writeFile(boardFile, BOARD);
  const pdfFile = path.join(project, 'docs', 'ref.pdf');
  await fs.writeFile(pdfFile, PDF);
  const manifest = (key = KEY, patch = {}) => ({
    version: 1, board: { key, name: 'Board.cad', path: boardFile, format: 'gencad' },
    documents: [{ id: 'd1', kind: 'pdf', name: 'ref.pdf', path: pdfFile, relativePath: 'docs/ref.pdf', key: sha256(PDF), size: PDF.length, bookmarks: [], annotations: [], addedAt: NOW }],
    split: { enabled: false, ratio: 0.5, right: null }, activeTab: 'board', cameras: {}, updatedAt: NOW, ...patch,
  });
  // A file system whose handles for matching files report a different size to stat() (the file changed after stat).
  const lyingFs = (matches, delta) => new Proxy(fs, { get(target, property) {
    if (property !== 'open') return target[property];
    return async (filename, ...rest) => {
      const handle = await target.open(filename, ...rest);
      if (!matches(filename)) return handle;
      return new Proxy(handle, { get(file, key) {
        if (key === 'stat') return async () => { const stat = await file.stat(); return Object.assign(stat, { size: stat.size + delta }); };
        const value = file[key];
        return typeof value === 'function' ? value.bind(file) : value;
      } });
    };
  } });

  await t.test('notes channels use the shared validators: pin notes and measurements, one note per target on write AND read (B15), old notes stay valid', async () => {
    const harness = await desktopHarness(profile());
    const component = { id: 'n1', componentId: 'U1', text: 'old style note', updatedAt: NOW };
    const pinNote = { id: 'n2', componentId: 'U1', pinId: 'U1.3', text: 'low', measurements: { voltage: '0.4 V', resistance: '12 k' }, updatedAt: NOW };
    await harness.invoke('trace:save-notes', KEY, [component, pinNote]);
    assert.deepEqual(plain(await harness.invoke('trace:get-notes', KEY)), [component, pinNote], 'pin id and measurements are stored and returned');
    assert.deepEqual(plain(await harness.invoke('trace:get-notes', 'b'.repeat(64))), [], 'a board without notes has none');
    const invalid = { message: text('native.error.invalidNote', { max: 8000 }) };
    await assert.rejects(harness.invoke('trace:save-notes', KEY, [pinNote, { ...pinNote, id: 'n3' }]), invalid, 'a second note for one pin');
    await assert.rejects(harness.invoke('trace:save-notes', KEY, [component, { ...component, id: 'n3' }]), invalid, 'a second note for one component');
    await assert.rejects(harness.invoke('trace:save-notes', KEY, [{ ...pinNote, measurements: { voltage: 'v'.repeat(65) } }]), invalid);
    await assert.rejects(harness.invoke('trace:save-notes', KEY, Array.from({ length: 501 }, (_, index) => ({ ...component, id: `n${index}`, componentId: `U${index}` }))), { message: text('native.error.tooManyNotes', { max: 500 }) });
    await assert.rejects(harness.invoke('trace:save-notes', KEY, 'not a list'), invalid);
    // Read side: a stored file with a hidden duplicate is locked, never partially returned; saving a valid list recovers it.
    const directory = harness.app.getPath();
    const file = path.join(directory, 'notes', `${KEY}.json`);
    await fs.writeFile(file, JSON.stringify([pinNote, { ...pinNote, id: 'n3' }]));
    await assert.rejects(harness.invoke('trace:get-notes', KEY), { message: text('native.error.notesUnreadable') });
    await fs.writeFile(file, '{ not json');
    await assert.rejects(harness.invoke('trace:get-notes', KEY), { message: text('native.error.notesUnreadable') });
    await harness.invoke('trace:save-notes', KEY, [component]);
    assert.deepEqual(plain(await harness.invoke('trace:get-notes', KEY)), [component], 'an explicit save recovers a damaged file');
  });

  await t.test('keyed notes: stored and returned as keys next to positional notes, validated like the others; the first save that replaces positional notes keeps the old file once', async () => {
    const directory = profile();
    const harness = await desktopHarness(directory);
    const file = path.join(directory, 'notes', `${KEY}.json`), copy = `${file}.positional.bak`;
    const exists = (target) => fs.access(target).then(() => true, () => false);
    const positional = [{ id: 'n1', componentId: 'part:1', text: 'old part note', updatedAt: NOW }, { id: 'n2', componentId: 'part:1', pinId: 'pin:4', text: 'old pin note', measurements: { voltage: '0.4 V' }, updatedAt: NOW }];
    // An older writer (or the renderer before the conversion): positional notes, no copy is made of anything.
    await harness.invoke('trace:save-notes', KEY, positional);
    assert.equal(await exists(copy), false, 'nothing was converted, nothing is kept');
    await harness.invoke('trace:save-notes', KEY, [...positional, { id: 'n3', componentId: 'part:2', text: 'second save, still positional', updatedAt: NOW }]);
    assert.equal(await exists(copy), false);
    // The conversion: keyed notes plus one that could not be placed. The file as it was is kept beside the new one.
    const before = JSON.parse(await fs.readFile(file, 'utf8'));
    const converted = [
      { id: 'n1', target: { ref: 'U1' }, text: 'old part note', updatedAt: NOW },
      { id: 'n2', target: { ref: 'U1', pin: '3' }, text: 'old pin note', measurements: { voltage: '0.4 V' }, updatedAt: NOW },
      { id: 'n3', componentId: 'part:2', text: 'second save, still positional', updatedAt: NOW, unresolved: { reason: 'legacy-id-missing', at: NOW } },
    ];
    await harness.invoke('trace:save-notes', KEY, converted);
    assert.deepEqual(plain(await harness.invoke('trace:get-notes', KEY)), converted, 'keys, positional leftovers and their record survive a round trip');
    assert.deepEqual(JSON.parse(await fs.readFile(copy, 'utf8')), before, 'the copy is exactly the file that was replaced');
    assert.deepEqual((await fs.readdir(path.join(directory, 'notes'))).filter((name) => name.endsWith('.tmp')), []);
    // Later saves change the notes, never the copy.
    await harness.invoke('trace:save-notes', KEY, [...converted, { id: 'n4', target: { ref: 'R1', at: { side: 'top', x: 12.5, y: -8.25 } }, text: 'duplicate reference, bound by position', updatedAt: NOW }]);
    assert.deepEqual(JSON.parse(await fs.readFile(copy, 'utf8')), before);
    assert.equal(plain(await harness.invoke('trace:get-notes', KEY)).length, 4);
    // The copy is not a note file: another board never sees it, and it is not read as this board's notes.
    assert.deepEqual(plain(await harness.invoke('trace:get-notes', 'b'.repeat(64))), []);
    // A board that never had positional notes gets no copy.
    const other = 'c'.repeat(64);
    await harness.invoke('trace:save-notes', other, [{ id: 'k', target: { ref: 'U1' }, text: 'keyed from the start', updatedAt: NOW }]);
    await harness.invoke('trace:save-notes', other, [{ id: 'k', target: { ref: 'U1' }, text: 'edited', updatedAt: NOW }]);
    assert.equal(await exists(path.join(directory, 'notes', `${other}.json.positional.bak`)), false);
    // The same rules on write and read as for the positional kind (B15): one note per key, canonical names, bounded positions.
    const invalid = { message: text('native.error.invalidNote', { max: 8000 }) };
    const keyed = { id: 'k1', target: { ref: 'U1' }, text: 'a', updatedAt: NOW };
    await assert.rejects(harness.invoke('trace:save-notes', KEY, [keyed, { ...keyed, id: 'k2', target: { ref: ' U1 ' } }]), invalid, 'two spellings of one key');
    await assert.rejects(harness.invoke('trace:save-notes', KEY, [{ ...keyed, target: {} }]), invalid);
    await assert.rejects(harness.invoke('trace:save-notes', KEY, [{ ...keyed, target: { ref: 'U1', pin: '1', pinAt: { side: 'top', x: 0, y: 0 } } }]), invalid);
    await assert.rejects(harness.invoke('trace:save-notes', KEY, [{ ...keyed, target: { at: { side: 'top', x: 1e10, y: 0 } } }]), invalid);
    await assert.rejects(harness.invoke('trace:save-notes', KEY, [{ ...keyed, componentId: 'U1' }]), invalid, 'a key and a positional id together');
    await assert.rejects(harness.invoke('trace:save-notes', KEY, [{ id: 'n3', componentId: 'part:2', text: 'x', updatedAt: NOW, unresolved: { reason: 'because', at: NOW } }]), invalid);
    // A damaged file is still reported and still recovered by an explicit save, with the copy untouched.
    await fs.writeFile(file, JSON.stringify([keyed, { ...keyed, id: 'k2' }]));
    await assert.rejects(harness.invoke('trace:get-notes', KEY), { message: text('native.error.notesUnreadable') });
    await harness.invoke('trace:save-notes', KEY, [keyed]);
    assert.deepEqual(plain(await harness.invoke('trace:get-notes', KEY)), [keyed]);
    assert.deepEqual(JSON.parse(await fs.readFile(copy, 'utf8')), before);
  });

  await t.test('workspace channels: round trip, BOARD_MISMATCH never attaches another board, damaged files are reported and recoverable', async () => {
    const directory = profile();
    const harness = await desktopHarness(directory);
    assert.equal(await harness.invoke('trace:load-workspace', KEY), null, 'nothing saved yet');
    const saved = manifest(KEY, { aliases: { refs: { U1A: 'U1' }, nets: { VCC: '+3V3' } }, cameras: { board: { zoom: 2 }, d1: { page: 3 } } });
    await harness.invoke('trace:save-workspace', KEY, saved);
    assert.deepEqual(plain(await harness.invoke('trace:load-workspace', KEY)), saved);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'workspaces', `${KEY}.json`), 'utf8')), saved, 'stored under workspaces/<key>.json');
    // Another board's manifest saved under this board's key is refused on write and, if found on disk, on read.
    const other = 'b'.repeat(64);
    await assert.rejects(harness.invoke('trace:save-workspace', other, manifest(KEY)), { code: 'BOARD_MISMATCH', message: /^\[BOARD_MISMATCH\] The workspace belongs to another board\.$/ });
    assert.equal(await harness.invoke('trace:load-workspace', other), null);
    await fs.mkdir(path.join(directory, 'workspaces'), { recursive: true });
    await fs.writeFile(path.join(directory, 'workspaces', `${other}.json`), JSON.stringify(manifest(KEY)));
    await assert.rejects(harness.invoke('trace:load-workspace', other), { code: 'BOARD_MISMATCH' }, 'a copied or renamed manifest is not attached to this board');
    // Damaged files: reported, left unchanged, recoverable by an explicit save.
    const broken = path.join(directory, 'workspaces', `${'c'.repeat(64)}.json`);
    await fs.writeFile(broken, '{ truncated');
    await assert.rejects(harness.invoke('trace:load-workspace', 'c'.repeat(64)), { code: 'WORKSPACE_UNREADABLE', message: /^\[WORKSPACE_UNREADABLE\] The saved workspace cannot be read/ });
    assert.equal(await fs.readFile(broken, 'utf8'), '{ truncated', 'the damaged file was left unchanged');
    await fs.writeFile(broken, JSON.stringify({ version: 1, board: { key: 'c'.repeat(64) } }));
    await assert.rejects(harness.invoke('trace:load-workspace', 'c'.repeat(64)), { code: 'MANIFEST_INVALID', message: /^\[MANIFEST_INVALID\] Invalid workspace manifest: board\.name\./ });
    await harness.invoke('trace:save-workspace', 'c'.repeat(64), manifest('c'.repeat(64)));
    assert.equal(plain(await harness.invoke('trace:load-workspace', 'c'.repeat(64))).board.key, 'c'.repeat(64), 'recovered');
    // Validation on save: unknown fields dropped, malformed aliases rejected, bad keys rejected, nothing written.
    await assert.rejects(harness.invoke('trace:save-workspace', KEY, manifest(KEY, { aliases: { refs: Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`R${index}`, 'X'])), nets: {} } })), { code: 'MANIFEST_INVALID' });
    await assert.rejects(harness.invoke('trace:save-workspace', KEY, manifest(KEY, { split: { enabled: true, ratio: 0.5, right: { kind: 'bogus', id: 'x' } } })), { code: 'MANIFEST_INVALID' });
    for (const bad of ['../x', 'short', 5, undefined]) {
      await assert.rejects(harness.invoke('trace:load-workspace', bad), { message: text('native.error.invalidBoardKey') });
      await assert.rejects(harness.invoke('trace:save-workspace', bad, manifest()), { message: text('native.error.invalidBoardKey') });
    }
    assert.deepEqual(plain(await harness.invoke('trace:load-workspace', KEY)), saved, 'rejected saves changed nothing');
    assert.deepEqual((await fs.readdir(path.join(directory, 'workspaces'))).filter((name) => name.endsWith('.tmp')), []);
  });

  await t.test('B01: after the quit intent new settings, notes and workspace writes are rejected with STORE_CLOSING while every accepted write is drained before the final quit', async () => {
    const note = (id) => [{ id, componentId: 'U1', text: id, updatedAt: NOW }];
    const writers = {
      'config.json': { write: (h, n) => h.invoke('trace:save-settings', { ...plain(h.settings), theme: n === 1 ? 'light' : n === 2 ? 'system' : 'dark' }), read: async (directory) => (JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'))).settings.theme, expected: 'system' },
      [`${KEY}.json.notes`]: { write: (h, n) => h.invoke('trace:save-notes', KEY, note(`note-${n}`)), read: async (directory) => (JSON.parse(await fs.readFile(path.join(directory, 'notes', `${KEY}.json`), 'utf8')))[0].id, expected: 'note-2' },
      [`${KEY}.json.workspace`]: { write: (h, n) => h.invoke('trace:save-workspace', KEY, manifest(KEY, { updatedAt: `2026-03-04T05:06:0${n}.000Z` })), read: async (directory) => (JSON.parse(await fs.readFile(path.join(directory, 'workspaces', `${KEY}.json`), 'utf8'))).updatedAt, expected: '2026-03-04T05:06:02.000Z' },
    };
    for (const [label, writer] of Object.entries(writers)) {
      const directory = profile();
      const blocked = [];
      const releases = [];
      const target = label.endsWith('.notes') ? path.join('notes', `${KEY}.json`) : label.endsWith('.workspace') ? path.join('workspaces', `${KEY}.json`) : 'config.json';
      const gatedFs = new Proxy(fs, { get(source, property) {
        if (property === 'rename') return async (from, to) => { if (to.endsWith(target)) { blocked.push(to); await new Promise((resolve) => releases.push(resolve)); } return source.rename(from, to); };
        return source[property];
      } });
      const harness = await desktopHarness(directory, { fs: gatedFs });
      harness.settings = await harness.invoke('trace:get-settings');
      const first = writer.write(harness, 1);
      await settle(() => blocked.length === 1);
      assert.equal(blocked.length, 1, `${label}: write A is held at its rename`);
      const second = writer.write(harness, 2); // Accepted before the quit intent, queued behind A.
      let prevented = false;
      harness.app.emit('before-quit', { preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
      const refused = [
        harness.invoke('trace:save-settings', { ...plain(harness.settings), motion: false }),
        harness.invoke('trace:save-notes', KEY, note('late')),
        harness.invoke('trace:save-workspace', KEY, manifest()),
      ];
      for (const attempt of refused) await assert.rejects(attempt, { code: 'STORE_CLOSING', message: /^\[STORE_CLOSING\] The data store is shutting down/ }, label);
      await sleep(30);
      assert.equal(harness.app.quitCount, 0, `${label}: no quit while A is held`);
      releases[0]();
      await first;
      await settle(() => blocked.length === 2);
      assert.equal(blocked.length, 2, `${label}: the accepted write B reached its rename`);
      assert.equal(harness.app.quitCount, 0, `${label}: B is blocked before its rename and the quit must still wait (the audited B01 moment)`);
      releases[1]();
      await second;
      await settle(() => harness.app.quitCount === 1);
      assert.equal(harness.app.quitCount, 1, `${label}: the final quit follows the drain`);
      assert.equal(await writer.read(directory), writer.expected, `${label}: the last accepted write is on disk`);
      harness.app.emit('before-quit', { preventDefault() {} });
      await sleep(10);
      assert.equal(harness.app.quitCount, 1, `${label}: a second quit request does not quit twice`);
    }
  });

  // Close/quit flush (W-fin-lifecycle-02, W-fin-documents-01). The renderer is played by a few lines of test code that answer
  // 'trace:flush-request' the way preload.cjs + useWorkspace.ts do (write the pending snapshot, then 'trace:flush-done');
  // the real wiring is covered by src/app/useWorkspace.test.ts (the hook) and tests/electron-smoke.cjs (real Electron).
  const flushRequests = (harness) => harness.window.webContents.sent.filter((entry) => entry.channel === 'trace:flush-request');
  const playRenderer = (harness, work) => {
    harness.window.webContents.onSend = (channel, id) => {
      if (channel !== 'trace:flush-request') return;
      void (async () => { try { await work(id); } finally { harness.message('trace:flush-done', id); } })();
    };
  };
  const workspaceFile = (directory) => path.join(directory, 'workspaces', `${KEY}.json`);

  await t.test('W-fin-lifecycle-02: closing the window first lets the renderer write its pending snapshot, even when the write fails on its first attempts (rename retry)', async () => {
    const directory = profile();
    let failures = 5; // Within the store's retry budget: an antivirus scan that holds the target for a few hundred ms.
    let renames = 0;
    const flakyFs = new Proxy(fs, { get(source, property) {
      if (property === 'rename') return async (from, to) => {
        if (to.endsWith(path.join('workspaces', `${KEY}.json`))) { renames++; if (failures > 0) { failures--; throw Object.assign(new Error('EPERM: simulated sharing violation'), { code: 'EPERM' }); } }
        return source.rename(from, to);
      };
      return source[property];
    } });
    const harness = await desktopHarness(directory, { fs: flakyFs });
    await harness.invoke('trace:initial-board');
    const pending = manifest(KEY, { updatedAt: '2026-03-04T05:06:09.000Z' }); // What the 400 ms debounce still holds.
    playRenderer(harness, () => harness.invoke('trace:save-workspace', KEY, pending));
    harness.window.close();
    assert.equal(harness.window.isDestroyed(), false, 'the close is held back until the renderer has written');
    assert.equal(flushRequests(harness).length, 1, 'the renderer was asked to flush');
    harness.window.close(); // A second click on the close button changes nothing and asks nothing.
    await settle(() => harness.window.isDestroyed());
    assert.equal(harness.window.isDestroyed(), true, 'then the window really closes');
    assert.equal(flushRequests(harness).length, 1);
    assert.equal(renames, 6, 'five failed renames were retried by the store, the sixth committed');
    assert.deepEqual(JSON.parse(await fs.readFile(workspaceFile(directory), 'utf8')), pending, 'the last change is on disk');
    assert.deepEqual((await fs.readdir(path.join(directory, 'workspaces'))).filter((name) => name.endsWith('.tmp')), []);
  });

  await t.test('W-fin-documents-01: app.quit() inside the debounce asks the renderer first; the store closes only after its write (STORE_CLOSING afterwards, as in B01)', async () => {
    const directory = profile();
    const harness = await desktopHarness(directory);
    await harness.invoke('trace:initial-board');
    const pending = manifest(KEY, { updatedAt: '2026-03-04T05:06:10.000Z' });
    let written = false;
    playRenderer(harness, async () => { await sleep(25); await harness.invoke('trace:save-workspace', KEY, pending); written = true; });
    let prevented = false;
    harness.app.emit('before-quit', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(flushRequests(harness).length, 1, 'the renderer was asked to flush');
    // A forged acknowledgement (another sender, a made-up id) neither completes the wait nor throws.
    harness.forgedMessage('trace:flush-done', flushRequests(harness)[0].value);
    harness.message('trace:flush-done', 9999);
    harness.message('trace:flush-done', 'x');
    await sleep(5);
    assert.equal(harness.app.quitCount, 0, 'the quit waits for the renderer');
    assert.equal(written, false);
    await settle(() => harness.app.quitCount === 1);
    assert.equal(written, true, 'the write was accepted although the quit intent was already given');
    assert.equal(harness.app.quitCount, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(workspaceFile(directory), 'utf8')), pending);
    await assert.rejects(harness.invoke('trace:save-workspace', KEY, manifest()), { code: 'STORE_CLOSING', message: /^\[STORE_CLOSING\] The data store is shutting down/ });
    harness.app.emit('before-quit', { preventDefault() {} });
    await sleep(10);
    assert.equal(harness.app.quitCount, 1, 'a second quit request neither asks again nor quits twice');
    assert.equal(flushRequests(harness).length, 1);
  });

  await t.test('the close/quit flush is bounded: a renderer that never answers keeps neither the window nor the app open', async () => {
    const closing = await desktopHarness(profile());
    const quitting = await desktopHarness(profile());
    for (const harness of [closing, quitting]) await harness.invoke('trace:initial-board');
    closing.window.close();
    quitting.app.emit('before-quit', { preventDefault() {} });
    await sleep(300);
    assert.equal(closing.window.isDestroyed(), false, 'still waiting for the renderer');
    assert.equal(quitting.app.quitCount, 0, 'still waiting for the renderer');
    await settle(() => closing.window.isDestroyed() && quitting.app.quitCount === 1, 250);
    assert.equal(closing.window.isDestroyed(), true, 'the wait is over after about a second');
    assert.equal(quitting.app.quitCount, 1);
  });

  await t.test('nothing is asked before the renderer started or after the window is gone: close and quit go through at once', async () => {
    const early = await desktopHarness(profile());
    early.window.close();
    assert.equal(early.window.isDestroyed(), true, 'no renderer yet: the window closes in the same turn');
    assert.equal(flushRequests(early).length, 0);
    const late = await desktopHarness(profile());
    await late.invoke('trace:initial-board');
    playRenderer(late, async () => {});
    late.window.close();
    await settle(() => late.window.isDestroyed());
    assert.equal(flushRequests(late).length, 1);
    late.app.emit('before-quit', { preventDefault() {} }); // The window is gone: the quit has nobody to ask.
    await settle(() => late.app.quitCount === 1);
    assert.equal(late.app.quitCount, 1);
    assert.equal(flushRequests(late).length, 1, 'no second request to a destroyed window');
    // During the final quit (the flush is done) a window close is not held back again.
    const quitting = await desktopHarness(profile());
    await quitting.invoke('trace:initial-board');
    playRenderer(quitting, async () => {});
    quitting.app.emit('before-quit', { preventDefault() {} });
    await settle(() => quitting.app.quitCount === 1);
    quitting.app.emit('before-quit', { preventDefault() {} }); // Electron emits it again for the final app.quit(): finalQuit lets it pass.
    quitting.window.close();
    assert.equal(quitting.window.isDestroyed(), true, 'the final quit closes the window without a second flush');
    assert.equal(flushRequests(quitting).length, 1);
  });

  await t.test('preload: onFlushRequest runs every listener and answers trace:flush-done with the request id once all of them settled (also with none, or a failing one)', async () => {
    const handlers = new Map();
    const sent = [];
    let api;
    const electron = {
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke: async () => undefined, on(channel, callback) { handlers.set(channel, callback); }, removeListener() {}, send(channel, ...args) { sent.push([channel, ...args]); } },
      webUtils: { getPathForFile: () => '' },
    };
    const source = await fs.readFile(path.resolve(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
    vm.runInNewContext(source, { require: (name) => (name === 'electron' ? electron : require(name)) }, { filename: 'preload.cjs' });
    const request = handlers.get('trace:flush-request');
    assert.equal(typeof request, 'function', 'the preload listens for the request');
    request({}, 1);
    await sleep(5);
    assert.deepEqual(sent, [['trace:flush-done', 1]], 'no listener: answered at once');
    let release;
    const slow = new Promise((resolve) => { release = resolve; });
    const off = [api.onFlushRequest(() => slow), api.onFlushRequest(() => { throw new Error('a listener that fails'); }), api.onFlushRequest(() => Promise.reject(new Error('and one that rejects')))];
    request({}, 2);
    await sleep(5);
    assert.equal(sent.length, 1, 'no answer while a listener is still writing');
    release();
    await sleep(5);
    assert.deepEqual(sent.at(-1), ['trace:flush-done', 2], 'answered after every listener settled, failures included');
    for (const detach of off) detach();
    request({}, 3);
    await sleep(5);
    assert.deepEqual(sent.at(-1), ['trace:flush-done', 3], 'detached listeners are gone');
    for (const bad of ['x', 1.5, undefined, null]) request({}, bad);
    await sleep(5);
    assert.equal(sent.length, 3, 'a request without a numeric id is ignored');
    assert.throws(() => api.onFlushRequest('not a function'), { name: 'TypeError', message: /flush listener must be a function/ });
  });

  await t.test('the code of a rejected invoke reaches the renderer API through preload.cjs: quit-time save has code STORE_CLOSING, other errors pass untouched', async () => {
    const harness = await desktopHarness(profile());
    let api;
    const electron = {
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      // Electron rejects an invoke with "Error invoking remote method '<channel>': <error.toString()>".
      ipcRenderer: { invoke: (channel, ...args) => harness.invoke(channel, ...args).catch((error) => { throw new Error(`Error invoking remote method '${channel}': ${error}`); }), on() {}, removeListener() {}, send() {} },
      webUtils: { getPathForFile: () => '' },
    };
    const source = await fs.readFile(path.resolve(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
    vm.runInNewContext(source, { require: (name) => (name === 'electron' ? electron : require(name)) }, { filename: 'preload.cjs' });
    assert.deepEqual(Object.keys(api).sort(), [
      'acceptBoard', 'appendReadings', 'checkForUpdates', 'clearNetworkActivity', 'close', 'droppedFilePath', 'exportReadings', 'exportWorkspace', 'getNetworkActivity', 'getNotes', 'getSettings', 'importReadings', 'initialBoard', 'isMaximized',
      'checkSupport', 'getSupportStatus', 'prepareSupport', 'listReadingFamilies', 'loadWorkspace', 'locateDocuments', 'maximize', 'minimize', 'onFlushRequest', 'onMaximized', 'onOpenBoard', 'openBoard', 'openSupportLink', 'openUpdatePage', 'pickDiagnosticFile', 'pickDocuments', 'readBoard', 'readDocument', 'readReadings',
      'recentBoards', 'saveDiagnosticReport', 'saveNotes', 'saveSettings', 'saveWorkspace',
    ].sort(), 'the preload exposes exactly the TraceDesktop members; support status, preparation and verification accept no argument');
    harness.app.emit('before-quit', { preventDefault() {} });
    for (const call of [() => api.saveNotes(KEY, []), () => api.saveWorkspace(KEY, manifest()), async () => api.saveSettings(await api.getSettings())]) {
      await assert.rejects(call(), (error) => error.code === 'STORE_CLOSING' && /^\[STORE_CLOSING\] The data store is shutting down/.test(error.message) && !/Error invoking/.test(error.message));
    }
    await assert.rejects(api.loadWorkspace('zz'), (error) => error.code === undefined && /^Error invoking remote method 'trace:load-workspace': Error: /.test(error.message), 'an error without a machine code is passed on untouched');
    await assert.rejects(api.readDocument(path.join(root, 'nothing.pdf')), (error) => error.code === 'DOCUMENT_NOT_FOUND' && /^\[DOCUMENT_NOT_FOUND\] /.test(error.message));
  });

  await t.test('B33 on every real read path: a file that shrank (or grew) after stat is rejected, never returned truncated', async () => {
    // Board and companions.
    const trio = path.join(root, 'shrink-trio');
    await fs.mkdir(trio);
    for (const [name, content] of [['format.asc', 'format bytes'], ['pins.asc', 'pins bytes'], ['nails.asc', 'nails bytes']]) await fs.writeFile(path.join(trio, name), content);
    const changed = { message: text('native.error.fileChangedWhileReading') };
    for (const delta of [20, -3]) {
      for (const victim of ['format.asc', 'pins.asc']) {
        const harness = await desktopHarness(profile(), { fs: lyingFs((filename) => filename.endsWith(victim), delta) });
        await assert.rejects(harness.invoke('trace:read-board', path.join(trio, 'format.asc')), changed, `${victim} stat ${delta > 0 ? '+' : ''}${delta}`);
        assert.equal((await harness.invoke('trace:recent-boards')).length, 0);
      }
    }
    // Documents (read-document and pick-documents).
    const docs = path.join(root, 'shrink-docs');
    await fs.mkdir(docs);
    const legacy = path.join(docs, 'sheet.sch');
    await fs.writeFile(legacy, `EESchema Schematic File Version 4\n${'#'.repeat(60)}\n`);
    await fs.writeFile(path.join(docs, 'sub.sch'), 'EESchema Schematic File Version 4\n#\n');
    for (const delta of [25, -4]) {
      const harness = await desktopHarness(profile(), { fs: lyingFs((filename) => filename === legacy, delta) });
      await assert.rejects(harness.invoke('trace:read-document', legacy), { code: 'DOCUMENT_CHANGED', message: /^\[DOCUMENT_CHANGED\] / });
      harness.dialog.choice = { canceled: false, filePaths: [legacy] };
      await assert.rejects(harness.invoke('trace:pick-documents', { kinds: ['schematic'] }), { code: 'DOCUMENT_CHANGED' });
    }
    // A companion that shrank is skipped with its reason, not delivered truncated.
    const sub = path.join(docs, 'sub.sch');
    const honest = await desktopHarness(profile(), { fs: lyingFs((filename) => filename === sub, 10) });
    const withSkipped = await honest.invoke('trace:read-document', legacy);
    assert.equal(withSkipped.companions, undefined);
    assert.deepEqual(plain(withSkipped.skipped), [{ name: 'sub.sch', reason: 'changed while reading' }]);
    // The JSON store: notes, workspace and settings files.
    const directory = profile();
    const setup = await desktopHarness(directory);
    await setup.invoke('trace:save-notes', KEY, [{ id: 'n1', componentId: 'U1', text: 'kept', updatedAt: NOW }]);
    await setup.invoke('trace:save-workspace', KEY, manifest());
    await setup.invoke('trace:save-settings', { ...plain(await setup.invoke('trace:get-settings')), theme: 'light' });
    const notesBefore = await fs.readFile(path.join(directory, 'notes', `${KEY}.json`), 'utf8');
    for (const delta of [30, -5]) {
      const lying = await desktopHarness(directory, { fs: lyingFs((filename) => filename.endsWith('.json'), delta) });
      assert.equal((await lying.invoke('trace:get-settings')).theme, 'dark', 'a config that cannot be read coherently falls back to the defaults');
      await assert.rejects(lying.invoke('trace:get-notes', KEY), { message: text('native.error.notesUnreadable') });
      await assert.rejects(lying.invoke('trace:load-workspace', KEY), { code: 'WORKSPACE_UNREADABLE' });
    }
    assert.equal(await fs.readFile(path.join(directory, 'notes', `${KEY}.json`), 'utf8'), notesBefore, 'rejected reads never rewrite the files');
  });

  await t.test('M01: path identity follows the platform; distinct POSIX files that differ only by case never collapse', async () => {
    const boards = path.join(root, 'posix');
    await fs.mkdir(boards);
    const upper = path.join(boards, 'U1.cad');
    const lower = path.join(boards, 'u1.cad');
    await fs.writeFile(upper, BOARD);
    let caseSensitive = true;
    try { await fs.writeFile(lower, BOARD); caseSensitive = (await fs.readdir(boards)).length === 2; } catch { caseSensitive = false; }
    if (caseSensitive) {
      for (const platform of ['linux', 'darwin']) {
        const harness = await desktopHarness(profile(), { platform });
        const a = await harness.invoke('trace:read-board', upper);
        const b = await harness.invoke('trace:read-board', lower);
        assert.equal(a.key, b.key, 'identical bytes: the candidate must still be correlated by path');
        await harness.invoke('trace:accept-board', a.path, a.key);
        assert.equal((await harness.invoke('trace:recent-boards'))[0].path, upper, `${platform}: accepting A records A, not B`);
        await harness.invoke('trace:accept-board', b.path, b.key);
        assert.deepEqual(plain(await harness.invoke('trace:recent-boards')).map((item) => item.path).sort(), [lower, upper].sort(), `${platform}: two files stay two recents`);
        await fs.writeFile(lower, `${BOARD}\n`);
        const c = await harness.invoke('trace:read-board', lower);
        await harness.invoke('trace:accept-board', c.path, c.key);
        assert.equal((await harness.invoke('trace:recent-boards')).length, 2, `${platform}: distinct bytes keep both too`);
        await fs.writeFile(lower, BOARD);
      }
    }
    // Windows volumes fold case: a different spelling of an already read path is the same candidate and the same recent.
    const win = await desktopHarness(profile(), { platform: 'win32' });
    const read = await win.invoke('trace:read-board', upper);
    await win.invoke('trace:accept-board', read.path.toUpperCase(), read.key);
    await win.invoke('trace:accept-board', read.path.toLowerCase(), read.key);
    assert.equal((await win.invoke('trace:recent-boards')).length, 1, 'win32: one file, one recent');
    const posix = await desktopHarness(profile(), { platform: 'linux' });
    const exact = await posix.invoke('trace:read-board', upper);
    await assert.rejects(posix.invoke('trace:accept-board', exact.path.toLowerCase(), exact.key), { message: text('native.error.boardNotVerified') }, 'linux: another spelling is another path');
  });

  await t.test('B34 through trace:read-document: the XML root is derived safely (declared control, bare root, comment prefix, DOCTYPE prefix), entities are refused', async () => {
    const harness = await desktopHarness(profile());
    const xml = path.join(root, 'xml');
    await fs.mkdir(xml);
    const read = async (name, content) => { const filename = path.join(xml, name); await fs.writeFile(filename, content); return harness.invoke('trace:read-document', filename); };
    const declared = await read('declared.sch', '<?xml version="1.0" encoding="utf-8"?>\n<eagle version="9.6.2"><drawing/></eagle>\n');
    assert.deepEqual([declared.kind, declared.format], ['schematic', 'eagle']);
    assert.deepEqual([(await read('bare.sch', '<eagle version="9.6.2"><drawing/></eagle>')).format, (await read('comment.sch', '<!-- exported by a synthetic tool -->\n<eagle version="9.6.2"/>')).format], ['eagle', 'eagle']);
    assert.equal((await read('doctype.sch', '<?xml version="1.0"?>\n<!DOCTYPE eagle SYSTEM "eagle.dtd">\n<eagle version="9.6.2"/>')).format, 'eagle');
    assert.equal((await read('bare.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')).format, 'svg');
    await assert.rejects(read('entity.sch', '<?xml version="1.0"?>\n<!DOCTYPE eagle [ <!ENTITY x "expanded"> ]>\n<eagle>&x;</eagle>'), { code: 'DOCUMENT_UNSAFE_XML', message: /^\[DOCUMENT_UNSAFE_XML\] / });
    await assert.rejects(read('other.sch', '<?xml version="1.0"?><note/>'), { code: 'DOCUMENT_CONTENT_MISMATCH' });
  });

  await t.test('pick, read, locate and export through the handlers: bounds, kinds, companions, safe bundle', async () => {
    const directory = profile();
    const harness = await desktopHarness(directory);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);
    const pngFile = path.join(project, 'docs', 'photo.png');
    await fs.writeFile(pngFile, png);
    // Dialog: filters per kind, multi-select, cancel resolves [], at most 16 files.
    harness.dialog.choice = { canceled: true, filePaths: [] };
    assert.deepEqual(plain(await harness.invoke('trace:pick-documents')), []);
    const filters = harness.dialog.openOptions.at(-1).filters;
    assert.equal(harness.dialog.openOptions.at(-1).properties.includes('multiSelections'), true);
    assert.deepEqual(plain(filters.slice(1).map((filter) => filter.name)), ['PDF documents', 'Images', 'Schematics']);
    await harness.invoke('trace:pick-documents', { kinds: ['pdf'], multiple: false });
    assert.deepEqual(plain(harness.dialog.openOptions.at(-1)), { ...plain(harness.dialog.openOptions.at(-1)), properties: ['openFile'], filters: [{ name: 'PDF documents', extensions: ['pdf'] }] });
    harness.dialog.choice = { canceled: false, filePaths: [pdfFile, pngFile] };
    const picked = await harness.invoke('trace:pick-documents');
    assert.deepEqual(plain(picked.map((item) => [item.name, item.kind, item.format, item.key])), [['ref.pdf', 'pdf', 'pdf', sha256(PDF)], ['photo.png', 'image', 'png', sha256(png)]]);
    assert.equal(picked[0].data.buffer.byteLength, PDF.length, 'exactly sized bytes cross the bridge');
    harness.dialog.choice = { canceled: false, filePaths: Array.from({ length: 17 }, () => pdfFile) };
    await assert.rejects(harness.invoke('trace:pick-documents'), { code: 'DOCUMENT_TOO_MANY' });
    for (const bad of [5, [], { kinds: ['nope'] }, { multiple: 'yes' }]) await assert.rejects(harness.invoke('trace:pick-documents', bad), (error) => /^(DOCUMENT_INVALID_OPTIONS|DOCUMENT_INVALID_KIND)$/.test(error.code), JSON.stringify(bad));
    await assert.rejects(harness.invoke('trace:read-document', pngFile, { kinds: ['pdf'] }), { code: 'DOCUMENT_UNSUPPORTED_EXTENSION' });
    assert.equal((await harness.invoke('trace:read-document', pngFile, { kinds: ['image'] })).format, 'png');
    // Locate.
    const located = await harness.invoke('trace:locate-documents', boardFile, [
      { id: 'a', kind: 'pdf', path: pdfFile, relativePath: 'docs/ref.pdf', key: sha256(PDF) },
      { id: 'b', kind: 'pdf', path: path.join(root, 'gone', 'ref.pdf'), relativePath: 'docs/ref.pdf', key: sha256(PDF) },
      { id: 'c', kind: 'pdf', path: pdfFile, key: sha256('different') },
      { id: 'd', kind: 'pdf', path: path.join(root, 'gone', 'x.pdf'), relativePath: '../escape.pdf', key: sha256(PDF) },
    ]);
    assert.deepEqual(plain(located.map((item) => [item.id, item.status])), [['a', 'ok'], ['b', 'moved'], ['c', 'changed'], ['d', 'unreadable']]);
    await assert.rejects(harness.invoke('trace:locate-documents', 'relative/Board.cad', []), { code: 'DOCUMENT_INVALID_PATH' });
    // Export: needs a saved workspace, validates the request, honours cancel, bundles only what was selected.
    const request = { boardKey: KEY, documentIds: ['d1'], includeBoard: false, includeNotes: false };
    await assert.rejects(harness.invoke('trace:export-workspace', request), { code: 'WORKSPACE_NOT_FOUND' });
    for (const bad of [null, 5, { ...request, documentIds: 'd1' }, { ...request, includeBoard: 'yes' }, { ...request, documentIds: [5] }, { ...request, boardKey: 'x' }]) {
      await assert.rejects(harness.invoke('trace:export-workspace', bad), (error) => error.code === 'EXPORT_INVALID_REQUEST' || error.message === text('native.error.invalidBoardKey'), JSON.stringify(bad));
    }
    const boardKeyOfFile = (await harness.invoke('trace:read-board', boardFile)).key;
    const saved = manifest(boardKeyOfFile, { documents: [...manifest().documents, { ...manifest().documents[0], id: 'd2', name: 'photo.png', kind: 'image', path: pngFile, relativePath: 'docs/photo.png', key: sha256(png), size: png.length }] });
    await harness.invoke('trace:save-workspace', boardKeyOfFile, saved);
    await harness.invoke('trace:save-notes', boardKeyOfFile, [{ id: 'n1', componentId: 'U1', text: 'exported note', updatedAt: NOW }]);
    harness.dialog.saveChoice = { canceled: true, filePath: undefined };
    assert.equal(await harness.invoke('trace:export-workspace', { ...request, boardKey: boardKeyOfFile }), null, 'cancel resolves null');
    assert.match(harness.dialog.saveOptions.at(-1).defaultPath, /Board-workspace\.zip$/);
    assert.deepEqual(plain(harness.dialog.saveOptions.at(-1).filters), [{ name: 'ZIP archive', extensions: ['zip'] }]);
    const target = path.join(root, 'bundle');
    harness.dialog.saveChoice = { canceled: false, filePath: target };
    const result = await harness.invoke('trace:export-workspace', { boardKey: boardKeyOfFile, documentIds: ['d2'], includeBoard: true, includeNotes: true });
    assert.equal(result.path, `${target}.zip`, 'a .zip extension is added when the dialog returned none');
    const fflate = require('fflate');
    const entries = fflate.unzipSync(new Uint8Array(await fs.readFile(`${target}.zip`)));
    assert.deepEqual(Object.keys(entries).sort(), ['board/Board.cad', 'documents/photo.png', 'notes.json', 'workspace.json'], 'the unselected PDF is not in the bundle');
    assert.equal(Buffer.from(entries['board/Board.cad']).toString(), BOARD);
    assert.equal(result.files, 4);
    assert.equal(JSON.stringify(JSON.parse(Buffer.from(entries['workspace.json']).toString())).includes(root), false, 'no local path in the bundle');
    // The board changed since the workspace was saved: it cannot be bundled under the old identity.
    await fs.writeFile(boardFile, `${BOARD}LINE 0 0 1 1\n`);
    await assert.rejects(harness.invoke('trace:export-workspace', { boardKey: boardKeyOfFile, documentIds: [], includeBoard: true, includeNotes: false }), { code: 'EXPORT_BOARD_CHANGED' });
    await fs.writeFile(boardFile, BOARD);
    // A save dialog that answers with an original file name still never touches the original (.zip is appended).
    harness.dialog.saveChoice = { canceled: false, filePath: pdfFile };
    const beside = await harness.invoke('trace:export-workspace', { boardKey: boardKeyOfFile, documentIds: ['d1'], includeBoard: false, includeNotes: false });
    assert.equal(beside.path, `${pdfFile}.zip`);
    assert.equal(sha256(await fs.readFile(pdfFile)), sha256(PDF), 'originals are never modified');
    await fs.rm(`${pdfFile}.zip`);
    // After the quit intent no export starts.
    harness.app.emit('before-quit', { preventDefault() {} });
    await assert.rejects(harness.invoke('trace:export-workspace', { boardKey: boardKeyOfFile, documentIds: [], includeBoard: false, includeNotes: false }), { code: 'EXPORT_CLOSING' });
  });

  await t.test('W-win-lifecycle-01: an export whose destination is held for a moment (EBUSY) is retried and completes; one that stays held fails cleanly (EXPORT_WRITE_FAILED)', async () => {
    let failures = 3;
    const heldZip = new Proxy(fs, { get(source, property) {
      if (property === 'rename') return async (from, to) => {
        if (to.endsWith('.zip') && failures > 0) { failures--; throw Object.assign(new Error('EBUSY: simulated sharing violation'), { code: 'EBUSY' }); }
        return source.rename(from, to);
      };
      return source[property];
    } });
    const harness = await desktopHarness(profile(), { fs: heldZip });
    await harness.invoke('trace:save-workspace', KEY, manifest());
    const request = { boardKey: KEY, documentIds: ['d1'], includeBoard: false, includeNotes: false };
    const bundle = path.join(root, 'held-bundle.zip');
    harness.dialog.saveChoice = { canceled: false, filePath: bundle };
    const result = await harness.invoke('trace:export-workspace', request);
    assert.equal(result.path, bundle);
    assert.equal(failures, 0, 'three failed renames were retried');
    assert.deepEqual(Object.keys(require('fflate').unzipSync(new Uint8Array(await fs.readFile(bundle)))).sort(), ['documents/ref.pdf', 'workspace.json']);
    failures = 1000;
    const stuck = path.join(root, 'stuck-bundle.zip');
    harness.dialog.saveChoice = { canceled: false, filePath: stuck };
    await assert.rejects(harness.invoke('trace:export-workspace', request), { code: 'EXPORT_WRITE_FAILED', message: /^\[EXPORT_WRITE_FAILED\] / });
    await assert.rejects(fs.stat(stuck), { code: 'ENOENT' }, 'no partial bundle');
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), [], 'no temporary file');
  });

  // The quit gate is a "check, await, act" problem: every intent that can open a dialog or start a write must look at the
  // quit flag again after each awaited step. These tests hold chosen steps (reads, renames, the dialog itself) in the
  // mocked-Electron harness; they are deterministic main-handler evidence, not a native GUI run.
  const gatedHarness = async (directory, rules) => {
    const gates = {};
    const arm = (name) => { gates[name] = { hits: 0, releases: [] }; return gates[name]; };
    const hold = (name) => { const gate = gates[name]; if (!gate) return undefined; gate.hits++; return new Promise((resolve) => gate.releases.push(resolve)); };
    const gatedFs = new Proxy(fs, { get(source, property) {
      if (property === 'open' || property === 'realpath') {
        return async (filename, ...rest) => { await hold(rules[property]?.(filename)); return source[property](filename, ...rest); };
      }
      if (property === 'rename') return async (from, to) => { await hold(rules.rename?.(to)); return source.rename(from, to); };
      return source[property];
    } });
    const harness = await desktopHarness(directory, { fs: gatedFs });
    return Object.assign(harness, { arm });
  };
  const closingRules = {
    open: (filename) => (filename.endsWith(path.join('workspaces', `${KEY}.json`)) ? 'manifest' : filename.endsWith(path.join('notes', `${KEY}.json`)) ? 'notesRead' : undefined),
    rename: (to) => (to.endsWith(path.join('notes', `${KEY}.json`)) ? 'noteWrite' : to.endsWith(path.join('workspaces', `${KEY}.json`)) ? 'workspaceWrite' : to.endsWith('.zip') ? 'zipRename' : undefined),
  };
  const outcomeOf = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

  await t.test('B44: a quit intent that arrives while an export is still loading its manifest or notes never opens a save dialog (EXPORT_CLOSING, not a cancel)', async () => {
    for (const withNotes of [false, true]) {
      const label = withNotes ? 'notes read held' : 'manifest read held';
      const directory = profile();
      const harness = await gatedHarness(directory, closingRules);
      await harness.invoke('trace:save-workspace', KEY, manifest());
      harness.dialog.saveChoice = { canceled: true, filePath: undefined };
      const read = harness.arm(withNotes ? 'notesRead' : 'manifest');
      const exporting = outcomeOf(harness.invoke('trace:export-workspace', { boardKey: KEY, documentIds: [], includeBoard: false, includeNotes: withNotes }));
      await settle(() => read.hits === 1);
      assert.equal(read.hits, 1, `${label}: the export passed its first quit check and is waiting for the read`);
      // A separate accepted write keeps the app alive (draining) after the quit intent. It targets a file the held read does NOT
      // have: since W-win-lifecycle-01 a write waits for a read of the same file (the store never renames over an open handle).
      const write = harness.arm(withNotes ? 'workspaceWrite' : 'noteWrite');
      const saving = withNotes
        ? harness.invoke('trace:save-workspace', KEY, manifest(KEY, { updatedAt: '2026-03-04T05:06:11.000Z' }))
        : harness.invoke('trace:save-notes', KEY, [{ id: 'n1', componentId: 'U1', text: 'accepted before the quit', updatedAt: NOW }]);
      await settle(() => write.hits === 1);
      assert.equal(write.hits, 1, `${label}: the ${withNotes ? 'workspace' : 'note'} write is accepted and held at its rename`);
      let prevented = false;
      harness.app.emit('before-quit', { preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
      await sleep(20);
      assert.equal(harness.app.quitCount, 0, `${label}: the app stays alive draining the accepted write`);
      read.releases[0]();
      const outcome = await exporting;
      assert.equal(harness.dialog.saveOptions.length, 0, `${label}: no save dialog after the quit intent`);
      assert.equal(outcome.error?.code, 'EXPORT_CLOSING', `${label}: stable code, not a null/cancel (${outcome.error ? 'rejected' : `resolved ${JSON.stringify(outcome.value)}`})`);
      assert.match(outcome.error.message, /^\[EXPORT_CLOSING\] /);
      assert.equal(harness.app.quitCount, 0, `${label}: still draining`);
      write.releases[0]();
      await saving;
      await settle(() => harness.app.quitCount === 1);
      assert.equal(harness.app.quitCount, 1, `${label}: the final quit follows the drain`);
      if (withNotes) assert.equal(JSON.parse(await fs.readFile(workspaceFile(directory), 'utf8')).updatedAt, '2026-03-04T05:06:11.000Z', `${label}: the accepted write is on disk`);
      else assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'notes', `${KEY}.json`), 'utf8'))[0].id, 'n1', `${label}: the accepted write is on disk`);
    }
  });

  await t.test('B44 controls: an export in progress at the quit intent is drained and completes; a dialog answered after the quit intent writes nothing', async () => {
    const harness = await gatedHarness(profile(), closingRules);
    await harness.invoke('trace:save-workspace', KEY, manifest());
    // In progress: the save dialog was answered, the zip is complete and waits at its final rename.
    const bundle = path.join(root, 'drained-bundle.zip');
    harness.dialog.saveChoice = { canceled: false, filePath: bundle };
    const rename = harness.arm('zipRename');
    const running = outcomeOf(harness.invoke('trace:export-workspace', { boardKey: KEY, documentIds: ['d1'], includeBoard: false, includeNotes: false }));
    await settle(() => rename.hits === 1);
    assert.equal(rename.hits, 1);
    harness.app.emit('before-quit', { preventDefault() {} });
    await sleep(20);
    assert.equal(harness.app.quitCount, 0, 'the quit waits for the export in progress');
    rename.releases[0]();
    const done = await running;
    assert.equal(done.error, undefined);
    assert.equal(done.value.path, bundle);
    assert.deepEqual(Object.keys(require('fflate').unzipSync(new Uint8Array(await fs.readFile(bundle)))).sort(), ['documents/ref.pdf', 'workspace.json']);
    await settle(() => harness.app.quitCount === 1);
    assert.equal(harness.app.quitCount, 1, 'the final quit follows the drained export');

    // A save dialog that is open at the quit intent: the answer arrives afterwards and nothing is written.
    const second = await gatedHarness(profile(), closingRules);
    await second.invoke('trace:save-workspace', KEY, manifest());
    const late = path.join(root, 'late-bundle.zip');
    let answer;
    second.dialog.showSaveDialog = function showSaveDialog(_window, options) { this.saveOptions.push(options); return new Promise((resolve) => { answer = resolve; }); };
    const asking = outcomeOf(second.invoke('trace:export-workspace', { boardKey: KEY, documentIds: ['d1'], includeBoard: false, includeNotes: false }));
    await settle(() => second.dialog.saveOptions.length === 1);
    second.app.emit('before-quit', { preventDefault() {} });
    answer({ canceled: false, filePath: late });
    assert.equal((await asking).error?.code, 'EXPORT_CLOSING');
    await assert.rejects(fs.stat(late), { code: 'ENOENT' }, 'no file after the quit intent');
    assert.equal(second.dialog.saveOptions.length, 1, 'only the dialog that was already open');
  });

  await t.test('B44 siblings: open-board and pick-documents open no dialog after the quit intent and refuse an answer that arrives after it; a failed external open shows no message box', async () => {
    const touched = [];
    const track = (filename) => { if (filename.includes('Board.cad')) touched.push(filename); };
    const harness = await gatedHarness(profile(), { open: track, realpath: track });
    // Two dialogs that are already open when the quit intent arrives.
    const answers = [];
    harness.dialog.showOpenDialog = function showOpenDialog(_window, options) { this.openOptions.push(options); return new Promise((resolve) => answers.push(resolve)); };
    const opening = outcomeOf(harness.invoke('trace:open-board'));
    const picking = outcomeOf(harness.invoke('trace:pick-documents', { kinds: ['pdf'] }));
    const cancelling = outcomeOf(harness.invoke('trace:open-board'));
    await settle(() => answers.length === 3);
    assert.equal(answers.length, 3);
    harness.app.emit('before-quit', { preventDefault() {} });
    answers[0]({ canceled: false, filePaths: [boardFile] });
    answers[1]({ canceled: false, filePaths: [pdfFile] });
    answers[2]({ canceled: true, filePaths: [] });
    assert.equal((await opening).error?.code, 'BOARD_CLOSING', 'a board chosen after the quit intent is not read');
    assert.equal((await picking).error?.code, 'DOCUMENT_CLOSING', 'documents chosen after the quit intent are not read');
    assert.equal((await cancelling).value, null, 'a genuine cancel stays a cancel');
    assert.deepEqual(touched, [], 'no board file was touched after the quit intent');
    // New intents after the quit intent never reach the dialog.
    harness.dialog.openOptions.length = 0;
    await assert.rejects(harness.invoke('trace:open-board'), { code: 'BOARD_CLOSING', message: /^\[BOARD_CLOSING\] / });
    await assert.rejects(harness.invoke('trace:pick-documents'), { code: 'DOCUMENT_CLOSING', message: /^\[DOCUMENT_CLOSING\] / });
    assert.equal(harness.dialog.openOptions.length, 0, 'no open dialog after the quit intent');

    // External open (second instance): a read that fails after the quit intent shows no error box and no later delivery starts.
    const external = await gatedHarness(profile(), { realpath: (filename) => (filename.endsWith('Gone.cad') ? 'external' : undefined) });
    await external.invoke('trace:initial-board');
    const gate = external.arm('external');
    const gone = path.join(root, 'void', 'Gone.cad');
    external.app.emit('second-instance', {}, ['electron.exe', 'app', gone]);
    await settle(() => gate.hits === 1);
    assert.equal(gate.hits, 1);
    external.app.emit('before-quit', { preventDefault() {} });
    gate.releases[0]();
    await sleep(30);
    assert.deepEqual(external.dialog.messages, [], 'no message box after the quit intent');
    external.app.emit('second-instance', {}, ['electron.exe', 'app', gone]);
    await sleep(10);
    assert.deepEqual(external.dialog.messages, []);
    assert.equal(gate.hits, 1, 'and the new delivery never started');
  });
});

// Support notice (shown on every start, easy to skip). The links are constants of the MAIN process only: the
// renderer sends an id over 'trace:open-support-link', main maps it and calls shell.openExternal for exactly these four URLs (Stripe, Ko-fi, the GitHub bug report form,
// and the support page of the project website that the heart button of the top bar opens).
test('support notice: trace:open-support-link opens only the four fixed links by id; any other value is rejected and shell.openExternal is never called', async (t) => {
  const root = await makeTempDir('trace-support-link-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const URLS = {
    stripe: 'https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00', kofi: 'https://ko-fi.com/tracerboardview', bug: 'https://github.com/trace-boardviewer/trace-boardviewer/issues/new?template=bug_report.yml',
    support: 'https://trace-boardviewer.github.io/support.html',
  };
  const stripeLink = async harness => {
    const url = new URL(URLS.stripe);
    if (require('../electron/support-verification.json').enabled) {
      const prepared = await harness.invoke('trace:prepare-support');
      assert.match(prepared.code, /^[a-f0-9]{32}$/);
      url.searchParams.set('client_reference_id', prepared.code);
    }
    return url.href;
  };
  let counter = 0;
  const profile = () => path.join(root, `profile-${++counter}`);
  const describeValue = (value) => (typeof value === 'symbol' ? `symbol ${value.description}` : typeof value === 'bigint' ? `${value}n` : typeof value === 'function' ? 'function' : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));

  await t.test('the channel exists, is a privileged handler (trusted window only) and opens nothing for a forged sender or subframe', async () => {
    const harness = await desktopHarness(profile());
    const handler = harness.handlers.get('trace:open-support-link');
    assert.equal(typeof handler, 'function');
    await assert.rejects(handler({ sender: {}, senderFrame: { url: 'https://example.com/' } }, 'stripe'), /nem az alkalmazás/);
    await assert.rejects(handler({ sender: harness.window.webContents, senderFrame: { url: 'https://example.com/' } }, 'kofi'), /nem az alkalmazás/);
    assert.deepEqual(harness.shell.opened, []);
  });

  await t.test('stripe, kofi, bug and support open exactly their constant URLs, once per request, with no extra arguments', async () => {
    const harness = await desktopHarness(profile());
    const stripe = await stripeLink(harness);
    assert.equal(await harness.invoke('trace:open-support-link', 'stripe'), undefined);
    assert.deepEqual(harness.shell.opened, [stripe]);
    assert.equal(await harness.invoke('trace:open-support-link', 'kofi'), undefined);
    assert.deepEqual(harness.shell.opened, [stripe, URLS.kofi]);
    assert.equal(await harness.invoke('trace:open-support-link', 'bug'), undefined);
    assert.deepEqual(harness.shell.opened, [stripe, URLS.kofi, URLS.bug]);
    assert.equal(await harness.invoke('trace:open-support-link', 'support'), undefined);
    assert.deepEqual(harness.shell.opened, [stripe, URLS.kofi, URLS.bug, URLS.support]);
    assert.deepEqual(harness.shell.extraArguments, [[], [], [], []], 'openExternal gets the URL only');
    for (const url of harness.shell.opened) assert.equal(new URL(url).protocol, 'https:');
  });

  await t.test('unknown ids, URLs, look-alikes, prototype names and non-strings are rejected with an error and nothing opens', async () => {
    const harness = await desktopHarness(profile());
    const invalid = [
      'paypal', 'Stripe', 'KOFI', ' stripe', 'kofi ', 'stripe\n', 'stripe\0', '', 'ko-fi', 'donate', 'Bug', 'BUG', 'bug ', 'bug\n', 'bugs', 'issue', 'issues', 'report', 'github',
      'Support', 'SUPPORT', ' support', 'support ', 'support\n', 'support\0', 'supports', 'support.html', 'website', 'site', 'home', 'trace-boardviewer',
      'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'prototype',
      URLS.stripe, URLS.kofi, URLS.bug, URLS.support, 'https://trace-boardviewer.github.io/', 'https://trace-boardviewer.github.io/support.html?next=https://evil.example/', 'http://trace-boardviewer.github.io/support.html',
      'https://github.com/trace-boardviewer/trace-boardviewer/issues', 'https://evil.example/', 'http://ko-fi.com/tracerboardview', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:', 'C:\\Windows\\System32\\calc.exe',
      undefined, null, 0, 1, true, false, NaN, 10n, Symbol.for('stripe'), ['stripe'], ['kofi', 'stripe'], { id: 'stripe' }, { toString: () => 'stripe' }, () => 'stripe', new String('stripe'),
      Symbol.for('support'), ['support'], ['support', 'stripe'], { id: 'support' }, { toString: () => 'support' }, () => 'support', new String('support'),
    ];
    for (const value of invalid) {
      await assert.rejects(harness.invoke('trace:open-support-link', value), /unknown support link/i, `rejected: ${describeValue(value)}`);
    }
    await assert.rejects(harness.invoke('trace:open-support-link'), /unknown support link/i, 'no argument at all');
    assert.deepEqual(harness.shell.opened, [], 'shell.openExternal was never called');
  });

  await t.test('a second argument can never redirect the link: the URL comes from the constant map', async () => {
    const harness = await desktopHarness(profile());
    await harness.invoke('trace:open-support-link', 'kofi', 'https://evil.example/', { url: 'https://evil.example/' });
    assert.deepEqual(harness.shell.opened, [URLS.kofi]);
  });

  await t.test('an operating system failure is reported to the renderer (rejected), not swallowed; the next request still works', async () => {
    let fail = true;
    const harness = await desktopHarness(profile(), { openExternal: async () => { if (fail) throw new Error('no handler for https'); } });
    const stripe = await stripeLink(harness);
    await assert.rejects(harness.invoke('trace:open-support-link', 'stripe'), /no handler for https/);
    fail = false;
    await harness.invoke('trace:open-support-link', 'kofi');
    assert.deepEqual(harness.shell.opened, [stripe, URLS.kofi]);
  });

  await t.test('existing isolation stays untouched: sandbox, context isolation, popups denied, foreign navigation blocked, clipboard-only permissions', async () => {
    const harness = await desktopHarness(profile());
    const { window } = harness;
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.equal(window.options.webPreferences.contextIsolation, true);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.webSecurity, true);
    assert.equal(window.webContents.popupHandler({ url: URLS.stripe }).action, 'deny', 'a renderer popup to the support link is still denied: only the main-process handler opens it');
    let blocked = false;
    window.webContents.emit('will-navigate', { preventDefault() { blocked = true; } }, URLS.kofi);
    assert.equal(blocked, true);
    let permission = true;
    window.webContents.session.permissionHandler({}, 'openExternal', (value) => { permission = value; });
    assert.equal(permission, false);
    assert.deepEqual(harness.shell.opened, []);
  });

  await t.test('the main-process source holds the three fixed support URLs exactly once each and builds the bug form from the repository slug; the preload source holds none (the renderer never sends a URL)', async () => {
    const main = await fs.readFile(path.resolve(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
    const preload = await fs.readFile(path.resolve(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
    for (const url of [URLS.stripe, URLS.kofi, URLS.support]) assert.equal(main.split(url).length - 1, 1, `${url} appears once in main.cjs`);
    const table = /const SUPPORT_LINKS = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(main);
    assert.ok(table, 'main.cjs has the frozen SUPPORT_LINKS table');
    assert.deepEqual([...table[1].matchAll(/^\s+([a-z]+):/gm)].map((match) => match[1]), ['stripe', 'kofi', 'bug', 'support'], 'the table has exactly the four ids, in this order');
    assert.equal(main.split('bug: `https://github.com/${updates.REPOSITORY}/issues/new?template=bug_report.yml`').length - 1, 1, 'the bug form is built from the slug of updates.cjs (electron/repository.json), once');
    assert.doesNotMatch(main, /github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+/, 'main.cjs names no repository of its own');
    for (const url of Object.values(URLS)) assert.equal(preload.includes(url), false, `${url} is not in preload.cjs`);
    assert.doesNotMatch(preload, /github\.com/, 'the preload holds no GitHub address');
    assert.equal(/openExternal/.test(preload), false, 'the preload never calls shell.openExternal');
    assert.equal((main.match(/shell\.openExternal\(/g) ?? []).length, 1, 'exactly one openExternal call site in main.cjs (the openExternalUrl helper, which the support links and the update page both go through)');
  });

  await t.test('preload: openSupportLink forwards the id only, over trace:open-support-link', async () => {
    const calls = [];
    let api;
    const electron = {
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke: async (channel, ...args) => { calls.push([channel, ...args]); }, on() {}, removeListener() {}, send() {} },
      webUtils: { getPathForFile: () => '' },
    };
    const source = await fs.readFile(path.resolve(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
    vm.runInNewContext(source, { require: (name) => (name === 'electron' ? electron : require(name)) }, { filename: 'preload.cjs' });
    assert.equal(typeof api.openSupportLink, 'function');
    await api.openSupportLink('stripe');
    await api.openSupportLink('kofi');
    await api.openSupportLink('bug');
    await api.openSupportLink('support');
    assert.deepEqual(calls, [['trace:open-support-link', 'stripe'], ['trace:open-support-link', 'kofi'], ['trace:open-support-link', 'bug'], ['trace:open-support-link', 'support']]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Update notification. SCOPE: a NOTIFICATION, not a
// self-installer. The Windows build is an unsigned portable EXE and the macOS build is unsigned (electron-updater cannot update portable builds,
// macOS auto-update needs a signed app, and silently replacing an unsigned executable is a supply-chain risk), so TRACE only tells the user that a
// newer release exists and sends them to its release page. electron/updates.cjs is the pure, injectable part; main.cjs adds two privileged handlers.
// No test below touches the network: every request is answered by an injected fake.
// ---------------------------------------------------------------------------------------------------------------
const updates = require('../electron/updates.cjs');

const UPDATE_API = 'https://api.github.com/repos/trace-boardviewer/trace-boardviewer/releases/latest';
const UPDATE_PAGE = 'https://github.com/trace-boardviewer/trace-boardviewer/releases/tag/';
const jsonResponse = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
/** A release as the API would send it, with hostile text in every field the app must never use. */
const releaseBody = (tag, extra = {}) => ({
  tag_name: tag, draft: false, prerelease: false, html_url: 'https://evil.example/phish', name: 'Evil release', body: 'Download https://evil.example/setup.exe',
  assets: [{ browser_download_url: 'https://evil.example/setup.exe' }], ...extra,
});
const reportsUrl = (response, url) => Object.defineProperty(response, 'url', { value: url });

test('update check (electron/updates.cjs): one fixed HTTPS request, a strict tag, a numeric comparison; every failure is the same bare "unavailable"', async (t) => {
  const UNAVAILABLE = { status: 'unavailable' };
  /** Runs one check against an injected fetch (a Response, or a function that makes one) and records the calls. */
  const check = async (response, options = {}) => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return typeof response === 'function' ? response(url, init) : response; };
    const result = await updates.checkForUpdate({ currentVersion: '1.2.0', fetchImpl, ...options });
    return { result, calls };
  };

  await t.test('the repository slug of electron/repository.json builds both URLs, and the defaults are an 8 s timeout and a 256 KiB body', async () => {
    assert.equal(updates.REPOSITORY, 'trace-boardviewer/trace-boardviewer');
    assert.deepEqual(JSON.parse(await fs.readFile(path.resolve(__dirname, '..', 'electron', 'repository.json'), 'utf8')), { repository: updates.REPOSITORY });
    assert.equal(updates.RELEASES_API, UPDATE_API);
    assert.equal(updates.RELEASE_PAGE_BASE, UPDATE_PAGE);
    const source = await fs.readFile(path.resolve(__dirname, '..', 'electron', 'updates.cjs'), 'utf8');
    assert.doesNotMatch(source, /github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+/, 'updates.cjs names no repository of its own');
    assert.match(source, /DEFAULT_TIMEOUT_MS = 8000\b/);
    assert.match(source, /DEFAULT_MAX_BYTES = 262144\b/);
  });

  await t.test('a strictly newer release is available (version and tag); the same version or an older one is current', async () => {
    assert.deepEqual((await check(jsonResponse(releaseBody('v1.2.1')))).result, { status: 'available', version: '1.2.1', tag: 'v1.2.1' });
    for (const tag of ['v1.2.0', 'v1.1.9', 'v1.0.99', 'v0.9.9', 'v0.0.0']) {
      assert.deepEqual((await check(jsonResponse(releaseBody(tag)))).result, { status: 'current' }, tag);
    }
  });

  await t.test('versions compare as numbers, not as text: 1.10.0 is newer than 1.9.0; a release is newer than its own pre-release', async () => {
    for (const [current, tag, status] of [
      ['1.9.0', 'v1.10.0', 'available'], ['1.10.0', 'v1.9.0', 'current'], ['1.2.9', 'v1.2.10', 'available'], ['1.2.10', 'v1.2.9', 'current'],
      ['1.99.99', 'v2.0.0', 'available'], ['2.0.0', 'v1.99.99', 'current'], ['9.9.9', 'v10.0.0', 'available'], ['10.0.0', 'v9.9.9', 'current'],
      ['1.2.0', 'v1.2.0', 'current'], ['0.0.0', 'v0.0.1', 'available'], ['1.2.0', 'v9999.9999.9999', 'available'], ['9999.9999.9999', 'v9999.9999.9999', 'current'],
      ['1.2.0-rc1', 'v1.2.0', 'available'], ['1.2.0-rc.1', 'v1.2.0', 'available'], ['1.2.0-rc1', 'v1.2.1', 'available'], ['1.2.0-rc1', 'v1.1.9', 'current'], ['1.2.1-beta.2', 'v1.2.0', 'current'],
    ]) {
      const { result } = await check(jsonResponse(releaseBody(tag)), { currentVersion: current });
      assert.equal(result.status, status, `running ${current}, latest ${tag}`);
      if (status === 'available') assert.deepEqual(result, { status, version: tag.slice(1), tag });
    }
  });

  await t.test('a draft or a pre-release is never offered (current), however new its tag is', async () => {
    for (const extra of [{ prerelease: true }, { draft: true }, { draft: true, prerelease: true }, { prerelease: true, tag_name: 'v9.0.0-beta.1' }]) {
      assert.deepEqual((await check(jsonResponse(releaseBody('v9.0.0', extra)))).result, { status: 'current' }, JSON.stringify(extra));
    }
  });

  await t.test('a tag with a pre-release suffix (v<major>.<minor>.<patch>-<suffix>) is a pre-release by its name: never offered, but no error (current)', async () => {
    for (const tag of ['v1.2.1-rc1', 'v1.2.1-beta.2', 'v9.9.9-rc.1', 'v1.2.0-rc1', 'v1.1.0-alpha', 'v2.0.0-x.y-z.1', `v1.2.1-${'a'.repeat(32)}`]) {
      assert.deepEqual((await check(jsonResponse(releaseBody(tag)))).result, { status: 'current' }, tag);
    }
  });

  await t.test('a tag that is not exactly v<major>.<minor>.<patch> is "unavailable": leading zeros, build metadata, missing parts, other prefixes, odd characters, non-strings', async () => {
    const bad = [
      'v01.2.1', 'v1.02.1', 'v1.2.01', 'v00.0.0', 'v1.2.1+build5', 'v1.2.1-rc1+build5', 'v1.2.1-', 'v1.2.1-rc 1', 'v1.2.1-rc1\n', `v1.2.1-${'a'.repeat(33)}`, 'v01.2.1-rc1',
      'v1.2.1.', 'v1.2.1.4', '1.2.1', 'V1.2.1', 'vv1.2.1', 'v1.2', 'v1', 'v1.2.x', 'v1.2.-1', 'v-1.2.3', 'v12345.0.0', 'v1.2.12345',
      'v1.2.1\n', '\nv1.2.1', ' v1.2.1', 'v1.2.1 ', 'v1.2.1\0', 'v1.2.1\r\n', 'v1,2,1', 'v1_2_1', 'v\uFF11.\uFF12.\uFF11', 'v1.2.1/../../x', 'v1.2.1?x=1', 'v1.2.1#frag', 'latest', 'release-1.2.1', '', ' ',
      null, undefined, 42, true, ['v1.2.1'], { toString: () => 'v1.2.1' },
    ];
    for (const tag of bad) {
      const { result } = await check(jsonResponse(releaseBody(tag)));
      assert.deepEqual(result, UNAVAILABLE, `tag ${JSON.stringify(tag)}`);
    }
    assert.deepEqual((await check(jsonResponse({ draft: false }))).result, UNAVAILABLE, 'no tag_name at all');
  });

  await t.test('a status other than 200 is "unavailable", even with a perfect body; only a 403 or 429 adds the waiting time', async () => {
    for (const status of [201, 202, 206, 301, 302, 400, 401, 404, 410, 500, 502, 503]) {
      assert.deepEqual((await check(jsonResponse(releaseBody('v9.9.9'), { status }))).result, UNAVAILABLE, String(status));
    }
    for (const status of [204, 304]) assert.deepEqual((await check(new Response(null, { status }))).result, UNAVAILABLE, String(status));
    for (const status of [403, 429]) assert.deepEqual((await check(jsonResponse(releaseBody('v9.9.9'), { status }))).result, { status: 'unavailable', retryAfterMs: 60000 }, String(status));
  });

  await t.test('rate limited (403 or 429): retry-after in seconds wins, then x-ratelimit-reset once the remaining count is 0, else a minute; always a number between one minute and one hour, never text', async () => {
    const limited = (headers, status = 429) => check(jsonResponse(releaseBody('v9.9.9'), { status, headers: { 'content-type': 'application/json', ...headers } }));
    const seconds = () => Math.floor(Date.now() / 1000);
    assert.deepEqual((await limited({ 'retry-after': '120' })).result, { status: 'unavailable', retryAfterMs: 120000 });
    assert.deepEqual((await limited({ 'retry-after': '120' }, 403)).result, { status: 'unavailable', retryAfterMs: 120000 });
    assert.equal((await limited({ 'retry-after': '1' })).result.retryAfterMs, 60000, 'never less than a minute');
    assert.equal((await limited({ 'retry-after': '86400' })).result.retryAfterMs, 3600000, 'never more than an hour');
    assert.equal((await limited({ 'retry-after': '120', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(seconds() + 1800) })).result.retryAfterMs, 120000, 'retry-after wins');
    const untilReset = (await limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(seconds() + 1800) })).result.retryAfterMs;
    assert.ok(untilReset > 1790000 && untilReset <= 1800000, `until the reset time (${untilReset} ms)`);
    assert.equal((await limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(seconds() - 5) })).result.retryAfterMs, 60000, 'a reset time in the past is still a minute');
    assert.equal((await limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(seconds() + 86400) })).result.retryAfterMs, 3600000, 'a reset time far away is an hour');
    assert.equal((await limited({ 'x-ratelimit-remaining': '7', 'x-ratelimit-reset': String(seconds() + 1800) })).result.retryAfterMs, 60000, 'the reset time counts only once the quota is used up');
    for (const headers of [{}, { 'retry-after': 'soon' }, { 'retry-after': '-5' }, { 'retry-after': '0' }, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'never' }, { 'x-ratelimit-remaining': '0' }]) {
      assert.deepEqual((await limited(headers)).result, { status: 'unavailable', retryAfterMs: 60000 }, JSON.stringify(headers));
    }
    for (const headers of [{ 'retry-after': '1e9' }, { 'retry-after': ' 7200 ' }, { 'retry-after': '90.5' }]) {
      const { result } = await limited(headers);
      assert.deepEqual(Object.keys(result).sort(), ['retryAfterMs', 'status'], JSON.stringify(headers));
      assert.ok(Number.isSafeInteger(result.retryAfterMs) && result.retryAfterMs >= 60000 && result.retryAfterMs <= 3600000, `${JSON.stringify(headers)}: ${result.retryAfterMs}`);
      assert.doesNotMatch(JSON.stringify(result), /evil|phish|setup\.exe/i);
    }
    // A 200 never carries a waiting time, whatever its headers say; the body of a 403 or 429 is released unread.
    assert.deepEqual((await check(jsonResponse(releaseBody('v1.2.1'), { headers: { 'content-type': 'application/json', 'retry-after': '120' } }))).result, { status: 'available', version: '1.2.1', tag: 'v1.2.1' });
    let cancelled = false;
    const unread = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(16)); }, cancel() { cancelled = true; } }), { status: 429, headers: { 'retry-after': '90' } });
    assert.deepEqual((await check(unread)).result, { status: 'unavailable', retryAfterMs: 90000 });
    assert.equal(cancelled, true, 'the body was released');
  });

  await t.test('a body that is not one JSON object is "unavailable": malformed, truncated, trailing text, arrays, scalars, invalid UTF-8, empty', async () => {
    for (const text of ['', ' ', 'not json', '{', '{"tag_name":"v9.9.9"', '[]', '[{"tag_name":"v9.9.9"}]', 'null', '"v9.9.9"', '42', 'true', '{"tag_name":"v9.9.9"}garbage', '<html>rate limited</html>']) {
      assert.deepEqual((await check(jsonResponse(text))).result, UNAVAILABLE, JSON.stringify(text));
    }
    assert.deepEqual((await check(new Response(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), { status: 200 }))).result, UNAVAILABLE, 'invalid UTF-8');
    assert.deepEqual((await check(new Response(null, { status: 200 }))).result, UNAVAILABLE, 'no body');
  });

  await t.test('a body over the limit is rejected (declared or streamed), exactly the limit is accepted, and the rest of a long stream is never read', async () => {
    const padded = (size) => JSON.stringify({ tag_name: 'v9.9.9', pad: 'x'.repeat(size) });
    const body = padded(1000);
    assert.equal((await check(jsonResponse(body), { maxBytes: body.length })).result.status, 'available', 'exactly at the limit');
    assert.deepEqual((await check(jsonResponse(body), { maxBytes: body.length - 1 })).result, UNAVAILABLE, 'one byte over');
    assert.deepEqual((await check(jsonResponse(padded(262144)))).result, UNAVAILABLE, 'over the default limit of 256 KiB');
    const atDefault = padded(262144 - padded(0).length);
    assert.equal(atDefault.length, 262144);
    assert.equal((await check(jsonResponse(atDefault))).result.status, 'available', 'exactly 256 KiB');
    // A declared length over the limit is refused before a byte is read, and the body is released.
    let declaredCancelled = false;
    const declared = new Response(new ReadableStream({ cancel() { declaredCancelled = true; } }), { status: 200, headers: { 'content-length': '999999' } });
    assert.deepEqual((await check(declared, { maxBytes: 4096 })).result, UNAVAILABLE);
    assert.equal(declaredCancelled, true, 'the unread body was released');
    // An endless stream stops at the limit and is cancelled.
    let cancelled = false;
    let pulls = 0;
    const endless = new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } }), { status: 200 });
    assert.deepEqual((await check(endless, { maxBytes: 4096 })).result, UNAVAILABLE);
    assert.equal(cancelled, true, 'the endless stream was cancelled');
    assert.ok(pulls < 50, `the stream was read only up to the limit (${pulls} pulls)`);
  });

  await t.test('a timeout is "unavailable" and aborts the request; a fetch that ignores the signal, one that honours it and a body that never ends are all cut off', async () => {
    const delays = [];
    const nativeTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      delays.push(delay);
      return nativeTimeout(callback, 0, ...args);
    });
    const ignoring = await check(() => new Promise(() => {}), { timeoutMs: 40 });
    assert.deepEqual(ignoring.result, UNAVAILABLE);
    assert.equal(ignoring.calls[0].init.signal.aborted, true, 'the signal was aborted');
    const honouring = await check((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))), { timeoutMs: 40 });
    assert.deepEqual(honouring.result, UNAVAILABLE);
    const stalled = new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { status: 200 });
    assert.deepEqual((await check(stalled, { timeoutMs: 40 })).result, UNAVAILABLE);
    assert.deepEqual(delays, [40, 40, 40], 'every request uses the caller deadline');
    globalThis.setTimeout.mock.restore();
    // A fast answer is not delayed or lost by the timer.
    assert.equal((await check(jsonResponse(releaseBody('v1.2.1')), { timeoutMs: 5000 })).result.status, 'available');
  });

  await t.test('no redirect is followed or trusted: the request says redirect "error", a rejecting fetch is "unavailable", and a response from another host is refused even if the fetch ignored the option', async () => {
    assert.equal((await check(jsonResponse(releaseBody('v9.9.9')))).calls[0].init.redirect, 'error');
    const honouring = await check((_url, init) => (init.redirect === 'error' ? Promise.reject(new TypeError('redirect mode is set to error')) : jsonResponse(releaseBody('v9.9.9'))));
    assert.deepEqual(honouring.result, UNAVAILABLE);
    for (const url of [
      'https://evil.example/repos/trace-boardviewer/trace-boardviewer/releases/latest', 'https://api.github.com.evil.example/x', 'https://api.github.com@evil.example/x', 'http://api.github.com/x',
      'https://github.com/x', 'ftp://api.github.com/x', 'file:///C:/x', 'not a url',
    ]) {
      assert.deepEqual((await check(reportsUrl(jsonResponse(releaseBody('v9.9.9')), url))).result, UNAVAILABLE, url);
    }
    assert.deepEqual((await check(Object.defineProperty(reportsUrl(jsonResponse(releaseBody('v9.9.9')), UPDATE_API), 'redirected', { value: true }))).result, UNAVAILABLE, 'a response that says it was redirected');
    assert.equal((await check(reportsUrl(jsonResponse(releaseBody('v1.2.1')), UPDATE_API))).result.status, 'available', 'the API host itself is fine');
    assert.equal((await check(jsonResponse(releaseBody('v1.2.1')))).result.status, 'available', 'net.fetch does not report a URL (documented): an empty one is accepted');
  });

  await t.test('the request: one GET to the fixed API URL, exactly the Accept, Accept-Language (fixed, so the system language is not revealed), User-Agent and X-GitHub-Api-Version headers, no credentials, no cookies, no referrer, no body', async () => {
    const { calls } = await check(jsonResponse(releaseBody('v1.2.1')));
    assert.equal(calls.length, 1, 'exactly one request');
    assert.equal(calls[0].url, UPDATE_API);
    assert.equal(new URL(calls[0].url).protocol, 'https:');
    assert.equal(new URL(calls[0].url).hostname, 'api.github.com');
    const init = calls[0].init;
    assert.deepEqual(Object.keys(init).sort(), ['credentials', 'headers', 'method', 'redirect', 'referrer', 'referrerPolicy', 'signal']);
    assert.equal(init.method, 'GET');
    assert.deepEqual({ ...init.headers }, { Accept: 'application/vnd.github+json', 'Accept-Language': 'en', 'User-Agent': 'TRACE-Boardviewer/1.2.0', 'X-GitHub-Api-Version': '2022-11-28' });
    assert.equal(init.credentials, 'omit', 'no cookies and no authorization');
    assert.equal(init.referrer, '');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    for (const name of Object.keys(init.headers)) assert.doesNotMatch(name, /^(?:authorization|cookie|proxy-authorization|x-.*token.*)$/i);
    // The URL does not depend on the running version; the User-Agent carries it.
    const other = await check(jsonResponse(releaseBody('v9.9.9')), { currentVersion: '1.4.2' });
    assert.equal(other.calls[0].url, UPDATE_API);
    assert.equal(other.calls[0].init.headers['User-Agent'], 'TRACE-Boardviewer/1.4.2');
  });

  await t.test('the answer carries only the validated tag and version: html_url, name, body and assets of the response never leave the module', async () => {
    const { result } = await check(jsonResponse(releaseBody('v1.2.1', { tag_name: 'v1.2.1' })));
    assert.deepEqual(Object.keys(result).sort(), ['status', 'tag', 'version']);
    assert.doesNotMatch(JSON.stringify(result), /evil|phish|setup\.exe/i);
    assert.equal(UPDATE_PAGE + result.tag, 'https://github.com/trace-boardviewer/trace-boardviewer/releases/tag/v1.2.1');
  });

  await t.test('every failure is exactly { status: "unavailable" }: no error text, no response content', async () => {
    const secret = 'C:\\Users\\Someone\\secret-token-123';
    for (const response of [
      () => Promise.reject(new Error(secret)), () => { throw new Error(secret); }, () => undefined, () => null, () => ({}), () => ({ status: 200 }), () => ({ status: 200, body: {} }),
      () => ({ status: 200, body: { getReader() { throw new Error(secret); } } }), () => jsonResponse(`{"message":"${secret}"}`), () => jsonResponse({ message: secret, tag_name: secret }),
    ]) {
      const { result } = await check(response);
      assert.deepEqual(result, UNAVAILABLE);
      assert.deepEqual(Object.keys(result), ['status']);
      assert.doesNotMatch(JSON.stringify(result), /secret|Someone/);
    }
  });

  await t.test('a running version that is not plain digits (or no fetch at all) is "unavailable" and nothing is sent: the version goes into a header', async () => {
    for (const currentVersion of ['', 'dev', '1.2', '1.2.0.1', '01.2.0', '1.02.0', '1.2.00', '1.2.0\r\nX-Evil: 1', '1.2.0 ', ' 1.2.0', 'v1.2.0', '1.2.0-', '1.2.0-rc 1', '1.2.0-rc1+build', undefined, null, 120]) {
      const { result, calls } = await check(jsonResponse(releaseBody('v9.9.9')), { currentVersion });
      assert.deepEqual(result, UNAVAILABLE, String(currentVersion));
      assert.equal(calls.length, 0, `no request for ${JSON.stringify(currentVersion)}`);
    }
    assert.deepEqual(await updates.checkForUpdate({ currentVersion: '1.2.0' }), UNAVAILABLE);
    assert.deepEqual(await updates.checkForUpdate({ currentVersion: '1.2.0', fetchImpl: 'https://api.github.com' }), UNAVAILABLE);
    assert.deepEqual(await updates.checkForUpdate(), UNAVAILABLE);
  });
});

test('update notification: trace:check-for-updates and trace:open-update-page are privileged, read no renderer argument, and open only the release page of the tag the main process validated', async (t) => {
  const root = await makeTempDir('trace-update-handlers-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  let counter = 0;
  const profile = () => path.join(root, `profile-${++counter}`);
  const plain = (value) => JSON.parse(JSON.stringify(value)); // The harness runs main.cjs in another realm.
  /** A harness whose network answers come from `answers` (a function, or a list used in turn); with no answer the request is refused. */
  const updating = (answers, options = {}) => {
    const queue = Array.isArray(answers) ? [...answers] : null;
    return desktopHarness(profile(), { ...options, fetch: async (url, init) => (queue ? queue.shift()(url, init) : answers(url, init)) });
  };
  const release = (tag, extra) => () => jsonResponse(releaseBody(tag, extra));
  const failing = () => { throw new Error('offline'); };

  await t.test('both channels exist, are privileged handlers, and a forged sender or subframe reaches neither the network nor the browser', async () => {
    const harness = await updating(release('v9.9.9'));
    for (const channel of ['trace:check-for-updates', 'trace:open-update-page']) {
      const handler = harness.handlers.get(channel);
      assert.equal(typeof handler, 'function', channel);
      await assert.rejects(handler({ sender: {}, senderFrame: { url: 'https://example.com/' } }), /nem az alkalmazás/, channel);
      await assert.rejects(handler({ sender: harness.window.webContents, senderFrame: { url: 'https://example.com/' } }), /nem az alkalmazás/, channel);
    }
    assert.deepEqual(harness.net.requests, []);
    assert.deepEqual(harness.shell.opened, []);
  });

  await t.test('nothing is requested on its own: the main process makes no request until the renderer asks', async () => {
    const harness = await updating(release('v9.9.9'));
    await harness.invoke('trace:get-settings');
    await harness.invoke('trace:recent-boards');
    assert.deepEqual(harness.net.requests, [], 'no request at start-up');
  });

  await t.test('open-update-page before any check rejects with "No update available." and opens nothing, whatever the renderer sends', async () => {
    const harness = await updating(release('v9.9.9'));
    for (const args of [[], ['v9.9.9'], ['https://evil.example/'], [{ tag: 'v9.9.9', url: 'https://evil.example/' }], ['v1.2.1', UPDATE_PAGE + 'v1.2.1']]) {
      await assert.rejects(harness.invoke('trace:open-update-page', ...args), /No update available\./, JSON.stringify(args));
    }
    assert.deepEqual(harness.shell.opened, []);
    assert.deepEqual(harness.net.requests, []);
  });

  await t.test('an available release: the renderer gets status and version only (no tag, no URL); the page opened is exactly the tag URL, once per request, with no extra argument', async () => {
    const harness = await updating(release('v1.2.1'));
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'available', version: '1.2.1' });
    assert.equal(harness.net.requests.length, 1);
    assert.equal(harness.net.requests[0].url, UPDATE_API);
    assert.equal(harness.net.requests[0].init.headers['User-Agent'], 'TRACE-Boardviewer/1.2.0', 'the running version comes from app.getVersion()');
    assert.deepEqual(harness.shell.opened, [], 'checking never opens anything');
    assert.equal(await harness.invoke('trace:open-update-page'), undefined);
    assert.deepEqual(harness.shell.opened, ['https://github.com/trace-boardviewer/trace-boardviewer/releases/tag/v1.2.1']);
    assert.deepEqual(harness.shell.extraArguments, [[]], 'openExternal gets the URL only');
    assert.equal(new URL(harness.shell.opened[0]).protocol, 'https:');
    await harness.invoke('trace:open-update-page');
    assert.deepEqual(harness.shell.opened, [UPDATE_PAGE + 'v1.2.1', UPDATE_PAGE + 'v1.2.1'], 'a second request opens the same page again');
  });

  await t.test('the running version is the one app.getVersion() reports', async () => {
    const harness = await updating(release('v1.4.3'), { version: '1.4.2' });
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'available', version: '1.4.3' });
    assert.equal(harness.net.requests[0].init.headers['User-Agent'], 'TRACE-Boardviewer/1.4.2');
    const same = await updating(release('v1.4.2'), { version: '1.4.2' });
    assert.deepEqual(plain(await same.invoke('trace:check-for-updates')), { status: 'current' });
  });

  await t.test('the arguments of both channels are ignored: a renderer cannot choose the request, the tag or the URL', async () => {
    const harness = await updating(release('v1.2.1'));
    const evil = ['https://evil.example/', 'v9.9.9', { url: 'https://evil.example/', tag: 'v9.9.9', currentVersion: '0.0.0', fetchImpl: () => {} }];
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates', ...evil)), { status: 'available', version: '1.2.1' });
    assert.equal(harness.net.requests.length, 1);
    assert.equal(harness.net.requests[0].url, UPDATE_API);
    assert.equal(harness.net.requests[0].init.headers['User-Agent'], 'TRACE-Boardviewer/1.2.0');
    await harness.invoke('trace:open-update-page', ...evil);
    assert.deepEqual(harness.shell.opened, [UPDATE_PAGE + 'v1.2.1']);
  });

  await t.test('the URL is built from the validated tag only: html_url, name, body and assets of the response are never used', async () => {
    const harness = await updating(release('v2.0.0', { html_url: 'https://evil.example/download', name: 'https://evil.example/', body: 'https://evil.example/' }));
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'available', version: '2.0.0' });
    await harness.invoke('trace:open-update-page');
    assert.deepEqual(harness.shell.opened, ['https://github.com/trace-boardviewer/trace-boardviewer/releases/tag/v2.0.0']);
    for (const url of harness.shell.opened) assert.doesNotMatch(url, /evil/);
  });

  /** Moves the clock of the main process `ms` into the future (its only reader is the update cooldown): main.cjs runs in its own realm, whose Date is patched here. */
  const later = (harness, ms) => vm.runInContext(`Date.now = ((real, offset) => () => real() + offset)(Date.now, ${ms})`, harness.context);

  await t.test('the remembered tag follows the latest check: a newer tag replaces it; a current, unavailable or pre-release answer clears it', async () => {
    const harness = await updating([release('v1.2.1'), release('v1.3.0'), release('v1.2.0'), release('v1.2.5'), failing, release('v1.2.7'), release('v1.2.8-rc1')]);
    const check = async () => { later(harness, 30000); return plain(await harness.invoke('trace:check-for-updates')); }; // past the cooldown every time
    await check(); // v1.2.1
    await harness.invoke('trace:open-update-page');
    await check(); // v1.3.0
    await harness.invoke('trace:open-update-page');
    assert.deepEqual(await check(), { status: 'current' }); // v1.2.0
    await assert.rejects(harness.invoke('trace:open-update-page'), /No update available\./);
    await check(); // v1.2.5
    await harness.invoke('trace:open-update-page');
    assert.deepEqual(await check(), { status: 'unavailable' }); // the request failed
    await assert.rejects(harness.invoke('trace:open-update-page'), /No update available\./);
    await check(); // v1.2.7
    assert.deepEqual(await check(), { status: 'current' }); // v1.2.8-rc1: a pre-release by its tag, never offered
    await assert.rejects(harness.invoke('trace:open-update-page'), /No update available\./);
    assert.deepEqual(harness.shell.opened, [UPDATE_PAGE + 'v1.2.1', UPDATE_PAGE + 'v1.3.0', UPDATE_PAGE + 'v1.2.5']);
    assert.equal(harness.net.requests.length, 7, 'one request per check once the cooldown is over');
  });

  await t.test('current, unavailable, pre-release, rate-limited and malformed answers never call openExternal', async () => {
    for (const answer of [release('v1.2.0'), release('v1.1.0'), release('v9.9.9', { prerelease: true }), release('v9.9.9', { draft: true }), release('v9.9.9-rc1'), failing, () => jsonResponse('not json'), () => jsonResponse(releaseBody('v9.9.9'), { status: 404 }), () => jsonResponse(releaseBody('v9.9.9'), { status: 429, headers: { 'retry-after': '120' } })]) {
      const single = await updating(answer);
      const result = plain(await single.invoke('trace:check-for-updates'));
      assert.notEqual(result.status, 'available');
      assert.deepEqual(Object.keys(result), ['status']);
      await assert.rejects(single.invoke('trace:open-update-page'), /No update available\./);
      assert.deepEqual(single.shell.opened, []);
    }
  });

  await t.test('an operating system failure to open the page is reported to the renderer (rejected); the tag is kept, so a retry works', async () => {
    let fail = true;
    const harness = await updating(release('v1.2.1'), { openExternal: async () => { if (fail) throw new Error('no handler for https'); } });
    await harness.invoke('trace:check-for-updates');
    await assert.rejects(harness.invoke('trace:open-update-page'), /no handler for https/);
    fail = false;
    await harness.invoke('trace:open-update-page');
    assert.deepEqual(harness.shell.opened, [UPDATE_PAGE + 'v1.2.1', UPDATE_PAGE + 'v1.2.1']);
  });

  await t.test('inside the cooldown (30 s after a request) a check makes no request and repeats the last answer, the remembered tag stays, and the next request follows once it is over', async () => {
    const harness = await updating([release('v1.2.1'), release('v1.3.0')]);
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'available', version: '1.2.1' });
    later(harness, 29000);
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'available', version: '1.2.1' }, 'the answer of the first request again');
    assert.equal(harness.net.requests.length, 1, 'no second request');
    await harness.invoke('trace:open-update-page');
    assert.deepEqual(harness.shell.opened, [UPDATE_PAGE + 'v1.2.1'], 'the tag of the first request is still there');
    later(harness, 1000);
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'available', version: '1.3.0' });
    assert.equal(harness.net.requests.length, 2);
  });

  await t.test('a failed request (offline) is not retried before 30 s either: the cached "unavailable" is repeated', async () => {
    const harness = await updating([failing, release('v1.2.1')]);
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'unavailable' });
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'unavailable' });
    assert.equal(harness.net.requests.length, 1);
    later(harness, 30000);
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'available', version: '1.2.1' });
    assert.equal(harness.net.requests.length, 2);
  });

  await t.test('rate limited (403 or 429): the renderer gets the bare "unavailable" and main stays quiet for the time GitHub asked, never less than a minute', async () => {
    const limited = (headers) => () => jsonResponse(releaseBody('v9.9.9'), { status: 429, headers: { 'content-type': 'application/json', ...headers } });
    const harness = await updating([limited({ 'retry-after': '120' }), release('v1.2.1'), limited({}), release('v1.2.2')]);
    const result = plain(await harness.invoke('trace:check-for-updates'));
    assert.deepEqual(result, { status: 'unavailable' });
    assert.deepEqual(Object.keys(result), ['status'], 'retryAfterMs never crosses the bridge');
    later(harness, 60000);
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'unavailable' }, 'still waiting after a minute');
    assert.equal(harness.net.requests.length, 1);
    later(harness, 60000);
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'available', version: '1.2.1' }, 'two minutes: the next request is made');
    later(harness, 30000);
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'unavailable' }); // a 429 without headers: a minute
    later(harness, 30000);
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'unavailable' }, 'half a minute is not enough after a 429');
    assert.equal(harness.net.requests.length, 3);
    later(harness, 30000);
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'available', version: '1.2.2' });
    assert.equal(harness.net.requests.length, 4);
  });

  await t.test('asks that overlap share one request, and all of them get its answer', async () => {
    let answer;
    const harness = await updating(() => new Promise((resolve) => { answer = () => resolve(jsonResponse(releaseBody('v1.2.1'))); }));
    const asks = [harness.invoke('trace:check-for-updates'), harness.invoke('trace:check-for-updates'), harness.invoke('trace:check-for-updates')];
    await settle(() => typeof answer === 'function');
    assert.equal(harness.net.requests.length, 1, 'one request for three asks');
    answer();
    assert.deepEqual((await Promise.all(asks)).map(plain), [{ status: 'available', version: '1.2.1' }, { status: 'available', version: '1.2.1' }, { status: 'available', version: '1.2.1' }]);
    assert.equal(harness.net.requests.length, 1);
  });

  await t.test('a clock set back does not freeze the check: a cooldown further away than any ever set is dropped', async () => {
    const harness = await updating([release('v1.2.1'), release('v1.2.2'), release('v1.2.3')]);
    await harness.invoke('trace:check-for-updates');
    later(harness, -3600001);
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'available', version: '1.2.2' }, 'the clock went back by more than an hour: a request is made');
    later(harness, -1000);
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'available', version: '1.2.2' }, 'a second back: still inside the cooldown');
    assert.equal(harness.net.requests.length, 2);
  });

  await t.test('the one hand-over point to the operating system (openExternalUrl, shared with the support links) refuses anything but an https URL', async () => {
    const harness = await updating(release('v1.2.1'));
    await harness.invoke('trace:open-support-link', 'kofi');
    assert.deepEqual(harness.shell.opened, ['https://ko-fi.com/tracerboardview'], 'the support links still open through it');
    assert.equal(typeof harness.context.openExternalUrl, 'function');
    for (const url of ['http://github.com/', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:', 'ftp://example.com/', 'mailto:a@example.com', 'not a url', '', undefined]) {
      await assert.rejects(harness.context.openExternalUrl(url), undefined, String(url));
    }
    assert.deepEqual(harness.shell.opened, ['https://ko-fi.com/tracerboardview'], 'nothing else was handed over');
  });

  await t.test('the source: main.cjs holds neither update URL (they are in updates.cjs), the preload holds no URL, and the preload forwards no argument for either call', async () => {
    const main = await fs.readFile(path.resolve(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
    const preload = await fs.readFile(path.resolve(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
    for (const url of [UPDATE_API, UPDATE_PAGE, 'api.github.com']) {
      assert.equal(main.includes(url), false, `${url} is not in main.cjs`);
      assert.equal(preload.includes(url), false, `${url} is not in preload.cjs`);
    }
    assert.equal(main.split('net.fetch(').length - 1, 0, 'main.cjs makes no request itself: the update check goes through electron/net/egress.cjs, the one fetch call site (see the egress isolation test)');
    assert.equal(/\bfetch\(|XMLHttpRequest|node:https?|\bhttps?\.request/.test(preload), false, 'the preload makes no request');
    const calls = [];
    let api;
    const electron = {
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke: async (channel, ...args) => { calls.push([channel, ...args]); return { status: 'current' }; }, on() {}, removeListener() {}, send() {} },
      webUtils: { getPathForFile: () => '' },
    };
    vm.runInNewContext(preload, { require: (name) => (name === 'electron' ? electron : require(name)) }, { filename: 'preload.cjs' });
    assert.equal(typeof api.checkForUpdates, 'function');
    assert.equal(typeof api.openUpdatePage, 'function');
    await api.checkForUpdates('https://evil.example/', { tag: 'v9.9.9' });
    await api.openUpdatePage('https://evil.example/', 'v9.9.9');
    assert.deepEqual(calls, [['trace:check-for-updates'], ['trace:open-update-page']], 'no renderer argument is forwarded');
  });
});

test('settings: updateCheck defaults to on, is validated like the other booleans, and a damaged stored value never resets the other settings', async (t) => {
  const root = await makeTempDir('trace-update-setting-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const profile = async (name, config) => {
    const directory = path.join(root, name);
    await fs.mkdir(directory, { recursive: true });
    if (config) await fs.writeFile(path.join(directory, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
    return directory;
  };
  const readConfig = async (directory) => JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
  const stored = { language: 'de', theme: 'light', layout: 'focus', motion: false, showLabels: false, showConnections: false };

  await t.test('a fresh profile and a profile saved before this setting existed have it switched on', async () => {
    assert.equal((await (await desktopHarness(await profile('fresh'))).invoke('trace:get-settings')).updateCheck, true);
    const legacy = await desktopHarness(await profile('legacy', { version: 1, settings: stored, recentBoards: [] }));
    assert.deepEqual(plain(await legacy.invoke('trace:get-settings')), { ...stored, updateCheck: true }, 'the other settings are untouched');
  });

  await t.test('switching it off is saved, survives a restart, and a caller that omits it keeps the current value', async () => {
    const directory = await profile('off');
    const harness = await desktopHarness(directory);
    const settings = await harness.invoke('trace:get-settings');
    await harness.invoke('trace:save-settings', { ...settings, updateCheck: false });
    assert.equal((await harness.invoke('trace:get-settings')).updateCheck, false);
    assert.equal((await readConfig(directory)).settings.updateCheck, false);
    const { updateCheck: _omitted, ...withoutUpdateCheck } = await harness.invoke('trace:get-settings');
    await harness.invoke('trace:save-settings', { ...withoutUpdateCheck, theme: 'light' });
    assert.equal((await harness.invoke('trace:get-settings')).updateCheck, false, 'an older caller does not switch it back on');
    const reopened = await desktopHarness(directory);
    assert.equal((await reopened.invoke('trace:get-settings')).updateCheck, false);
    assert.equal((await reopened.invoke('trace:get-settings')).theme, 'light');
    await reopened.invoke('trace:save-settings', { ...plain(await reopened.invoke('trace:get-settings')), updateCheck: true });
    assert.equal((await readConfig(directory)).settings.updateCheck, true);
  });

  await t.test('a damaged stored value falls back to the default (on) without resetting any other stored setting', async () => {
    for (const [index, bad] of ['false', 'true', 0, 1, null, [], {}, 'yes'].entries()) {
      const harness = await desktopHarness(await profile(`damaged-${index}`, { version: 1, settings: { ...stored, updateCheck: bad }, recentBoards: [] }));
      assert.deepEqual(plain(await harness.invoke('trace:get-settings')), { ...stored, updateCheck: true }, JSON.stringify(bad));
    }
    const kept = await desktopHarness(await profile('stored-false', { version: 1, settings: { ...stored, updateCheck: false }, recentBoards: [] }));
    assert.deepEqual(plain(await kept.invoke('trace:get-settings')), { ...stored, updateCheck: false }, 'a valid stored false is kept');
  });

  await t.test('trace:save-settings rejects a value that is not a boolean, writes nothing, and keeps the other settings', async () => {
    const directory = await profile('validate');
    const harness = await desktopHarness(directory);
    const settings = plain(await harness.invoke('trace:get-settings'));
    await harness.invoke('trace:save-settings', { ...settings, theme: 'light' });
    for (const bad of ['false', 'true', 0, 1, null, [], {}]) {
      await assert.rejects(harness.invoke('trace:save-settings', { ...settings, theme: 'dark', updateCheck: bad }), /érvénytelenek/, JSON.stringify(bad));
    }
    const after = plain(await harness.invoke('trace:get-settings'));
    assert.deepEqual(after, { ...settings, theme: 'light' }, 'nothing changed after the rejected saves');
    assert.equal((await readConfig(directory)).settings.theme, 'light');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Egress (electron/net/egress.cjs): the one place of the main process that may use the network. Every feature registers with an exact host
// allow-list, methods, limits, an opt-in and fixed headers; every request and its outcome goes into a bounded in-memory log that the renderer can
// read (never write, apart from emptying it). No test below touches the network: the fetch is injected.
// ---------------------------------------------------------------------------------------------------------------
const egressModule = require('../electron/net/egress.cjs');
const { createEgress, createElectronFetch } = egressModule;

const SAMPLE_HOST = 'data.example.org';
const SAMPLE_URL = `https://${SAMPLE_HOST}/library/index.json`;
const SAMPLE_ID = 'sample-library';
const sampleFeature = (extra = {}) => ({
  id: SAMPLE_ID, hosts: [SAMPLE_HOST], methods: ['GET'], maxBytes: 4096, timeoutMs: 1000, headers: { Accept: 'application/json' }, responseHeaders: ['retry-after'], ...extra,
});
/** An egress around a fake fetch; `answer` is a Response, or a function (url, init) that makes one or throws. Returns the layer and the calls the fetch saw. */
function sampleEgress({ answer = () => jsonResponse({ ok: true }), feature = {}, register = true, ...options } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return typeof answer === 'function' ? answer(url, init) : answer; };
  const layer = createEgress({ fetchImpl, version: '1.2.0', ...options });
  if (register) layer.register(sampleFeature(feature));
  return { layer, calls };
}
const lastEntry = (layer) => layer.activity().entries.at(-1);
/** A body that streams `chunks` (byte counts) and counts how often it is pulled and whether it was cancelled. */
function countedStream(chunkSizes, { endless = false } = {}) {
  const state = { pulls: 0, cancelled: false };
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      state.pulls++;
      if (index < chunkSizes.length) controller.enqueue(new Uint8Array(chunkSizes[index++]).fill(120));
      else if (endless) controller.enqueue(new Uint8Array(1024).fill(120));
      else controller.close();
    },
    cancel() { state.cancelled = true; },
  });
  return { body, state };
}

test('egress registration: a feature needs an exact host list and limits; a bad descriptor or a repeated id throws, nothing is ever opened by accident', async (t) => {
  const fresh = () => createEgress({ fetchImpl: async () => jsonResponse({}), version: '1.2.0' });

  await t.test('a good descriptor registers once and is frozen; a changed copy of it later does not change the policy', async () => {
    const layer = fresh();
    const descriptor = sampleFeature();
    const feature = layer.register(descriptor);
    assert.equal(Object.isFrozen(feature), true);
    assert.equal(Object.isFrozen(feature.hosts), true);
    assert.equal(Object.isFrozen(feature.headers), true);
    assert.throws(() => layer.register(sampleFeature()), TypeError, 'the same id twice');
    descriptor.hosts.push('evil.example');
    descriptor.headers.Cookie = 'a=b';
    assert.deepEqual([...feature.hosts], [SAMPLE_HOST]);
    assert.deepEqual({ ...feature.headers }, { Accept: 'application/json' });
    assert.equal(layer.isAllowedUrl('https://evil.example/'), false);
    assert.deepEqual(layer.features(), [{ id: SAMPLE_ID, hosts: [SAMPLE_HOST], methods: ['GET'], optIn: null, enabled: true }]);
  });

  await t.test('every descriptor that could widen the policy is rejected: wildcards, IPs, ports, schemes, other methods, redirect following, forbidden headers, unknown fields', async () => {
    const { maxBytes: _maxBytes, ...withoutMaxBytes } = sampleFeature();
    const { timeoutMs: _timeoutMs, ...withoutTimeout } = sampleFeature();
    const bad = [
      {}, null, [], 'sample', sampleFeature({ id: 'Bad Id' }), sampleFeature({ id: 'x' }), sampleFeature({ id: 'a'.repeat(49) }), sampleFeature({ id: undefined }),
      sampleFeature({ hosts: [] }), sampleFeature({ hosts: undefined }), sampleFeature({ hosts: 'data.example.org' }), sampleFeature({ hosts: ['*.example.org'] }),
      sampleFeature({ hosts: ['example.org:8443'] }), sampleFeature({ hosts: ['Example.org'] }), sampleFeature({ hosts: ['localhost'] }), sampleFeature({ hosts: ['192.168.0.1'] }),
      sampleFeature({ hosts: ['[::1]'] }), sampleFeature({ hosts: ['https://example.org'] }), sampleFeature({ hosts: ['example.org/path'] }), sampleFeature({ hosts: ['example.org.'] }),
      sampleFeature({ hosts: ['a.example.org', 'a.example.org'] }), sampleFeature({ hosts: Array.from({ length: 9 }, (_, i) => `h${i}.example.org`) }), sampleFeature({ hosts: [''] }), sampleFeature({ hosts: [42] }),
      sampleFeature({ methods: ['POST'] }), sampleFeature({ methods: ['GET', 'DELETE'] }), sampleFeature({ methods: [] }), sampleFeature({ methods: ['get'] }), sampleFeature({ methods: 'GET' }),
      sampleFeature({ redirect: 'follow' }), sampleFeature({ redirect: 'manual' }), sampleFeature({ redirect: 'error' }),
      withoutMaxBytes, withoutTimeout, sampleFeature({ maxBytes: 0 }), sampleFeature({ maxBytes: -1 }), sampleFeature({ maxBytes: 1.5 }), sampleFeature({ maxBytes: '4096' }), sampleFeature({ maxBytes: 64 * 1024 * 1024 }),
      sampleFeature({ timeoutMs: 0 }), sampleFeature({ timeoutMs: 10 ** 9 }), sampleFeature({ timeoutMs: NaN }), sampleFeature({ maxInFlight: 0 }), sampleFeature({ maxInFlight: 9 }),
      ...['Authorization', 'authorization', 'Proxy-Authorization', 'Cookie', 'Cookie2', 'Set-Cookie', 'Referer', 'Origin', 'Host', 'User-Agent', 'Accept-Language', 'Content-Type', 'Content-Length', 'Transfer-Encoding', 'Connection',
        'X-Api-Key', 'X-Session-Id', 'X-Auth-Token', 'X-Password', 'X-Secret', 'X-Forwarded-For', 'X-Real-IP', 'Via', 'Bad Name', 'X:Y', ''].map((name) => sampleFeature({ headers: { [name]: 'x' } })),
      sampleFeature({ headers: { Accept: 'a\r\nX-Evil: 1' } }), sampleFeature({ headers: { Accept: 7 } }), sampleFeature({ headers: { Accept: '' } }), sampleFeature({ headers: { Accept: ' padded ' } }), sampleFeature({ headers: ['Accept'] }), sampleFeature({ headers: null }),
      sampleFeature({ headers: { Accept: 'a', accept: 'b' } }),
      sampleFeature({ responseHeaders: ['Set-Cookie'] }), sampleFeature({ responseHeaders: ['set-cookie'] }), sampleFeature({ responseHeaders: ['set-cookie2'] }), sampleFeature({ responseHeaders: ['bad header'] }), sampleFeature({ responseHeaders: Array.from({ length: 9 }, (_, i) => `x-h${i}`) }),
      sampleFeature({ paths: ['library/index.json'] }), sampleFeature({ paths: ['/a?b=1'] }), sampleFeature({ paths: ['/a#b'] }), sampleFeature({ paths: ['/a\\b'] }), sampleFeature({ pathPrefixes: ['/library'] }), sampleFeature({ pathPrefixes: ['library/'] }),
      sampleFeature({ bodyStatuses: [404] }), sampleFeature({ bodyStatuses: [200.5] }), sampleFeature({ bodyStatuses: '200' }),
      sampleFeature({ optIn: { setting: 'bad key!' } }), sampleFeature({ optIn: { setting: 'x', extra: 1 } }), sampleFeature({ optIn: 'updateCheck' }), sampleFeature({ optIn: { setting: 'x', bypassWithUserAction: 'yes' } }), sampleFeature({ optIn: [] }),
      sampleFeature({ download: { maxBytes: 10 } }), sampleFeature({ download: { extension: 'json' } }), sampleFeature({ download: { maxBytes: 10, extension: 'a/b' } }), sampleFeature({ download: { maxBytes: 10, extension: 'json', directory: '/tmp' } }),
      sampleFeature({ download: { maxBytes: 10 ** 10, extension: 'json' } }), sampleFeature({ download: 'json' }),
      sampleFeature({ allowQuery: 'yes' }), sampleFeature({ cookies: true }), sampleFeature({ followRedirects: true }), sampleFeature({ proxy: 'http://evil.example' }), sampleFeature({ body: 'x' }),
    ];
    for (const descriptor of bad) assert.throws(() => fresh().register(descriptor), TypeError, JSON.stringify(descriptor)?.slice(0, 120));
    // Registering nothing leaves nothing reachable.
    const layer = fresh();
    for (const descriptor of bad) { try { layer.register(descriptor); } catch { /* expected */ } }
    assert.deepEqual(layer.features(), []);
    assert.equal(layer.isAllowedUrl(SAMPLE_URL), false);
  });

  await t.test('the layer needs a fetch function; without a valid version nothing is sent', async () => {
    for (const fetchImpl of [undefined, null, 'https://data.example.org', {}, 42]) assert.throws(() => createEgress({ fetchImpl, version: '1.2.0' }), TypeError);
    for (const version of [undefined, null, '', 'dev', '1.2', '1.2.0\r\nX-Evil: 1', 'v1.2.0', 120, '1.2.0 ']) {
      const { layer, calls } = sampleEgress({ version });
      assert.deepEqual(await layer.request(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'not-allowed' }, String(version));
      assert.equal(calls.length, 0);
      assert.equal(layer.userAgent, null);
    }
    assert.equal(sampleEgress({ version: '1.3.0-rc.1' }).layer.userAgent, 'TRACE-Boardviewer/1.3.0-rc.1');
  });
});

test('egress allow-list: another host, http, a port, credentials, a tricky or un-normalized URL, a path outside the list or another method never reaches the fetch', async (t) => {
  const refused = async (label, rawUrl, error, options, feature) => {
    const { layer, calls } = sampleEgress({ feature });
    const result = await layer.request(SAMPLE_ID, rawUrl, options);
    assert.deepEqual(result, { ok: false, error }, label);
    assert.equal(calls.length, 0, `${label}: the fetch was never called`);
    const entry = lastEntry(layer);
    assert.equal(entry.outcome, 'refused', label);
    assert.equal(entry.error, error, label);
    assert.equal(entry.status, null);
    assert.equal(layer.activity().entries.length, 1, `${label}: the refusal is in the log`);
  };

  await t.test('only the exact host is reachable: suffixes, subdomains, a trailing dot, a userinfo trick and look-alikes are refused', async () => {
    for (const rawUrl of [
      'https://evil.example/library/index.json', `https://${SAMPLE_HOST}.evil.example/library/index.json`, `https://evil.example/${SAMPLE_HOST}/library/index.json`,
      `https://x.${SAMPLE_HOST}/library/index.json`, `https://${SAMPLE_HOST}./library/index.json`, 'https://example.org/library/index.json', 'https://data.example.org.evil.example/library/index.json',
      'https://93.184.216.34/library/index.json', 'https://[::1]/library/index.json', 'https://localhost/library/index.json',
    ]) await refused(rawUrl, rawUrl, 'host');
    for (const rawUrl of [
      `https://${SAMPLE_HOST}@evil.example/library/index.json`, `https://user:secret@${SAMPLE_HOST}/library/index.json`, `https://user@${SAMPLE_HOST}/library/index.json`,
      `https://:secret@${SAMPLE_HOST}/library/index.json`,
    ]) await refused(rawUrl, rawUrl, 'invalid-url');
  });

  await t.test('only https: http, ftp, file, data, javascript and websocket URLs are refused', async () => {
    for (const rawUrl of [`http://${SAMPLE_HOST}/library/index.json`, `ftp://${SAMPLE_HOST}/library/index.json`, 'file:///C:/Windows/win.ini', 'data:text/plain,hello', 'javascript:alert(1)', `wss://${SAMPLE_HOST}/library/index.json`, 'blob:https://data.example.org/x']) {
      await refused(rawUrl, rawUrl, 'scheme');
    }
  });

  await t.test('only the default port, no fragment, no query (unless the feature allows one), and the URL must already be normalized', async () => {
    for (const rawUrl of [
      `https://${SAMPLE_HOST}:8443/library/index.json`, `https://${SAMPLE_HOST}:443/library/index.json`, `https://${SAMPLE_HOST}:/library/index.json`,
      `${SAMPLE_URL}#fragment`, `${SAMPLE_URL}#`, `${SAMPLE_URL}?x=1`, `${SAMPLE_URL}?`, `${SAMPLE_URL}?token=SECRET`,
      `HTTPS://DATA.EXAMPLE.ORG/library/index.json`, `https://${SAMPLE_HOST}/library/../library/index.json`, `https://${SAMPLE_HOST}/library/%2e%2e/library/index.json`, `https://${SAMPLE_HOST}/library/./index.json`,
      `https://${SAMPLE_HOST}\\library\\index.json`, ` ${SAMPLE_URL}`, `${SAMPLE_URL}\n`, `${SAMPLE_URL}\t`, `https://${SAMPLE_HOST}/lib\nrary/index.json`, 'https://d\u0430ta.example.org/library/index.json',
      `https://${SAMPLE_HOST}/${'a'.repeat(3000)}`, '', ' ',
    ]) await refused(JSON.stringify(rawUrl).slice(0, 80), rawUrl, 'invalid-url');
    for (const value of [null, undefined, 42, true, {}, [SAMPLE_URL], { href: SAMPLE_URL }, new URL(SAMPLE_URL), { toString: () => SAMPLE_URL }]) await refused(String(typeof value), value, 'invalid-url');
  });

  await t.test('a path outside the feature\'s exact paths and prefixes is refused; inside them it is sent', async () => {
    const feature = { paths: ['/library/index.json'], pathPrefixes: ['/library/files/'] };
    for (const rawUrl of [`https://${SAMPLE_HOST}/other.json`, `https://${SAMPLE_HOST}/library/index.json/extra`, `https://${SAMPLE_HOST}/library/files`, `https://${SAMPLE_HOST}/library/filesystem/a`, `https://${SAMPLE_HOST}/`]) {
      await refused(rawUrl, rawUrl, 'path', undefined, feature);
    }
    const { layer, calls } = sampleEgress({ feature });
    for (const rawUrl of [SAMPLE_URL, `https://${SAMPLE_HOST}/library/files/a.json`, `https://${SAMPLE_HOST}/library/files/deep/er/b.json`]) assert.equal((await layer.request(SAMPLE_ID, rawUrl)).ok, true, rawUrl);
    assert.equal(calls.length, 3);
  });

  await t.test('a query is sent only when the feature allows it, and it never reaches the log', async () => {
    const { layer, calls } = sampleEgress({ feature: { allowQuery: true } });
    assert.equal((await layer.request(SAMPLE_ID, `${SAMPLE_URL}?token=SECRET&x=1`)).ok, true);
    assert.equal(calls[0].url, `${SAMPLE_URL}?token=SECRET&x=1`);
    assert.doesNotMatch(JSON.stringify(layer.activity()), /SECRET|token|x=1|\?/);
    assert.equal(lastEntry(layer).path, '/library/index.json');
  });

  await t.test('only the feature\'s methods: POST, DELETE, a lower-case get and HEAD (when not listed) are refused; HEAD works when listed and reads no body', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'get', 'CONNECT', 'TRACE', 'OPTIONS', 'HEAD', '', 42, {}]) await refused(String(method), SAMPLE_URL, 'method', { method });
    const { layer, calls } = sampleEgress({ feature: { methods: ['GET', 'HEAD'] }, answer: () => new Response(null, { status: 200, headers: { 'retry-after': '5' } }) });
    const head = await layer.request(SAMPLE_ID, SAMPLE_URL, { method: 'HEAD' });
    assert.deepEqual({ ...head, headers: { ...head.headers } }, { ok: true, status: 200, headers: { 'retry-after': '5' }, body: null });
    assert.equal(calls[0].init.method, 'HEAD');
    const get = await layer.request(SAMPLE_ID, SAMPLE_URL, { method: 'GET' });
    assert.equal(get.ok, false, 'a GET of an empty body answer is not a usable answer');
  });

  await t.test('an unknown or hostile feature id is "not-registered"; nothing is sent and the log shows no unvetted text', async () => {
    const { layer, calls } = sampleEgress();
    for (const id of ['nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', null, undefined, 42, {}, ['sample-library'], 'SAMPLE-LIBRARY', 'sample-library ', 'x'.repeat(100)]) {
      assert.deepEqual(await layer.request(id, SAMPLE_URL), { ok: false, error: 'not-registered' }, String(id));
    }
    assert.equal(calls.length, 0);
    for (const entry of layer.activity().entries) {
      assert.equal(entry.outcome, 'refused');
      assert.match(entry.feature, /^(?:[a-z0-9-]{1,48}|\?)$/);
    }
    assert.deepEqual(await layer.download('nope', SAMPLE_URL), { ok: false, error: 'not-registered' });
  });
});

test('egress request shape: fixed headers, no credentials, no referrer, no redirect, no caller-chosen header or option', async (t) => {
  const BASE_KEYS = ['credentials', 'headers', 'method', 'redirect', 'referrer', 'referrerPolicy', 'signal'];

  await t.test('the fetch gets exactly the normalized URL and exactly these init keys and headers', async () => {
    const { layer, calls } = sampleEgress();
    const result = await layer.request(SAMPLE_ID, SAMPLE_URL);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body.toString('utf8')), { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, SAMPLE_URL);
    const init = calls[0].init;
    assert.deepEqual(Object.keys(init).sort(), BASE_KEYS);
    assert.equal(init.method, 'GET');
    assert.deepEqual({ ...init.headers }, { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': 'TRACE-Boardviewer/1.2.0' });
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrer, '');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    for (const name of Object.keys(init.headers)) assert.doesNotMatch(name, /^(?:authorization|cookie|proxy-authorization|referer|origin|x-.*token.*)$/i);
  });

  await t.test('the language header is fixed to en whatever the system says, and the User-Agent carries only the version', async () => {
    const { layer, calls } = sampleEgress({ version: '1.4.2' });
    await layer.request(SAMPLE_ID, SAMPLE_URL);
    assert.equal(calls[0].init.headers['Accept-Language'], 'en');
    assert.equal(calls[0].init.headers['User-Agent'], 'TRACE-Boardviewer/1.4.2');
    assert.doesNotMatch(JSON.stringify(calls[0].init.headers), /Electron|Chrome|Windows|Linux|Mac/i);
  });

  await t.test('a caller cannot add a header, a credential, a body, a redirect mode, a referrer, a signal or another URL through the options', async () => {
    const { layer, calls } = sampleEgress();
    await layer.request(SAMPLE_ID, SAMPLE_URL, {});
    const baseline = calls[0].init;
    const hostile = {
      headers: { Cookie: 'a=b', Authorization: 'Bearer x', 'X-Evil': '1' }, credentials: 'include', redirect: 'follow', referrer: 'https://evil.example/', referrerPolicy: 'unsafe-url', body: 'x', signal: new AbortController().signal,
      url: 'https://evil.example/', keepalive: true, cache: 'default', mode: 'no-cors', proxy: 'http://evil.example', session: {}, useSessionCookies: true,
    };
    await layer.request(SAMPLE_ID, SAMPLE_URL, hostile);
    const init = calls[1].init;
    assert.deepEqual(Object.keys(init).sort(), BASE_KEYS);
    assert.deepEqual({ ...init.headers }, { ...baseline.headers });
    for (const key of ['method', 'credentials', 'redirect', 'referrer', 'referrerPolicy']) assert.equal(init[key], baseline[key], key);
    assert.notEqual(init.signal, hostile.signal);
    assert.equal(calls[1].url, SAMPLE_URL);
    for (const junk of [null, 'x', 42, [], () => {}]) assert.equal((await layer.request(SAMPLE_ID, SAMPLE_URL, junk)).ok, true);
  });

  await t.test('the response headers handed back are only the feature\'s allow-list (never a cookie, a location or a server text), cleaned and capped', async () => {
    const asked = [];
    const served = { 'retry-after': '120', 'set-cookie': 'session=SECRET; HttpOnly', location: 'https://evil.example/', 'x-evil': 'phish', 'content-type': 'application/json' };
    const { layer } = sampleEgress({ answer: () => ({ status: 200, headers: { get(name) { asked.push(name.toLowerCase()); return served[name.toLowerCase()] ?? null; } }, body: new Response('{}').body }) });
    const result = await layer.request(SAMPLE_ID, SAMPLE_URL);
    assert.deepEqual({ ...result.headers }, { 'retry-after': '120' });
    assert.doesNotMatch(JSON.stringify(result.headers), /SECRET|evil|phish|cookie/i);
    assert.deepEqual([...new Set(asked)].sort(), ['content-length', 'retry-after'], 'no other header of the answer is even looked at');
    const long = sampleEgress({ answer: () => jsonResponse({}, { headers: { 'retry-after': 'x'.repeat(1000) } }) });
    assert.equal((await long.layer.request(SAMPLE_ID, SAMPLE_URL)).headers['retry-after'].length, 256);
  });
});

test('egress redirects are refused: the request says so, a rejecting fetch is a network error, and a response that was redirected or comes from elsewhere is never used', async (t) => {
  const run = (answer, feature) => { const { layer, calls } = sampleEgress({ answer, feature }); return layer.request(SAMPLE_ID, SAMPLE_URL).then((result) => ({ result, layer, calls })); };
  const reportsUrl = (response, url) => Object.defineProperty(response, 'url', { value: url });

  await t.test('the request carries redirect "error"; a fetch that honours it rejects, which is a network error', async () => {
    const { result, calls } = await run((_url, init) => (init.redirect === 'error' ? Promise.reject(new TypeError('redirect mode is set to error')) : jsonResponse({})));
    assert.equal(calls[0].init.redirect, 'error');
    assert.deepEqual(result, { ok: false, error: 'network' });
  });

  await t.test('a response that says it was redirected, or reports another host, scheme or an unparsable URL, is refused and its body released', async () => {
    let released = 0;
    const releasing = (response) => { const body = response.body; const cancel = body.cancel.bind(body); body.cancel = (...args) => { released++; return cancel(...args); }; return response; };
    for (const answer of [
      () => Object.defineProperty(jsonResponse({}), 'redirected', { value: true }),
      () => reportsUrl(jsonResponse({}), 'https://evil.example/library/index.json'), () => reportsUrl(jsonResponse({}), `https://${SAMPLE_HOST}.evil.example/x`),
      () => reportsUrl(jsonResponse({}), `https://${SAMPLE_HOST}@evil.example/x`), () => reportsUrl(jsonResponse({}), `http://${SAMPLE_HOST}/library/index.json`), () => reportsUrl(jsonResponse({}), 'ftp://data.example.org/x'),
    ]) {
      const { result, layer } = await run(() => releasing(answer()));
      assert.deepEqual(result, { ok: false, error: 'redirect' });
      assert.equal(lastEntry(layer).outcome, 'error');
      assert.equal(lastEntry(layer).error, 'redirect');
    }
    assert.equal(released, 6, 'every refused body was released unread');
    const { result } = await run(() => reportsUrl(jsonResponse({}), 'not a url'));
    assert.deepEqual(result, { ok: false, error: 'bad-response' });
    assert.equal((await run(() => reportsUrl(jsonResponse({}), SAMPLE_URL))).result.ok, true, 'the host that was asked is fine');
    assert.equal((await run(() => jsonResponse({}))).result.ok, true, 'net.fetch does not report a URL (documented): an empty one is accepted');
  });

  await t.test('a 3xx answer is a refused redirect (with its status), never followed or read; 304 and the others are plain statuses', async () => {
    for (const status of [300, 301, 302, 303, 305, 307, 308]) {
      const { result } = await run(() => jsonResponse({}, { status, headers: { location: 'https://evil.example/' } }));
      assert.deepEqual(result, { ok: false, error: 'redirect', status }, String(status));
    }
    for (const status of [304, 400, 404, 500]) assert.equal((await run(() => (status === 304 ? new Response(null, { status }) : jsonResponse({}, { status })))).result.status, status);
  });

  await t.test('answers that are no HTTP response at all are "bad-response": nothing, a primitive, a missing or impossible status', async () => {
    for (const answer of [() => undefined, () => null, () => 'ok', () => 42, () => ({}), () => ({ status: 'ok' }), () => ({ status: 99 }), () => ({ status: 600 }), () => ({ status: 200.5 }), () => ({ status: 200 }), () => ({ status: 200, body: {} })]) {
      const { result } = await run(answer);
      assert.deepEqual(result, { ok: false, error: 'bad-response' });
    }
    // A rejection or a throw never leaks its text.
    const secret = 'C:\\Users\\Someone\\secret-token-123';
    for (const answer of [() => Promise.reject(new Error(secret)), () => { throw new Error(secret); }, () => ({ status: 200, body: { getReader() { throw new Error(secret); } } })]) {
      const { result, layer } = await run(answer);
      assert.equal(result.ok, false);
      assert.doesNotMatch(JSON.stringify(result), /secret|Someone/);
      assert.doesNotMatch(JSON.stringify(layer.activity()), /secret|Someone/);
    }
  });
});

test('egress size and time limits: an oversize body (declared or streamed), a slow or endless body and a fetch that never answers are cut off, and a caller can only tighten the limits', async (t) => {
  await t.test('a body over the limit is refused (declared or streamed), exactly the limit is accepted, and the rest of a long stream is never read', async () => {
    const exact = sampleEgress({ answer: () => new Response(new Uint8Array(4096).fill(120)) });
    const ok = await exact.layer.request(SAMPLE_ID, SAMPLE_URL);
    assert.equal(ok.ok, true);
    assert.equal(ok.body.length, 4096);
    assert.equal(lastEntry(exact.layer).bytes, 4096);
    const over = sampleEgress({ answer: () => new Response(new Uint8Array(4097).fill(120)) });
    assert.deepEqual(await over.layer.request(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'too-large' });
    assert.equal(lastEntry(over.layer).bytes, 0, 'a refused body counts no bytes');
    let declaredCancelled = false;
    const declared = sampleEgress({ answer: () => new Response(new ReadableStream({ cancel() { declaredCancelled = true; } }), { status: 200, headers: { 'content-length': '999999' } }) });
    assert.deepEqual(await declared.layer.request(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'too-large' });
    assert.equal(declaredCancelled, true, 'the unread body was released');
    const stream = countedStream([], { endless: true });
    const endless = sampleEgress({ answer: () => new Response(stream.body, { status: 200 }) });
    assert.deepEqual(await endless.layer.request(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'too-large' });
    assert.equal(stream.state.cancelled, true, 'the endless stream was cancelled');
    assert.ok(stream.state.pulls < 50, `the stream was read only up to the limit (${stream.state.pulls} pulls)`);
  });

  await t.test('a caller\'s timeoutMs and maxBytes can only be smaller than the feature\'s, never larger', async () => {
    const small = sampleEgress({ answer: () => new Response(new Uint8Array(100).fill(120)) });
    assert.deepEqual(await small.layer.request(SAMPLE_ID, SAMPLE_URL, { maxBytes: 99 }), { ok: false, error: 'too-large' });
    assert.equal((await small.layer.request(SAMPLE_ID, SAMPLE_URL, { maxBytes: 100 })).ok, true);
    const big = sampleEgress({ answer: () => new Response(new Uint8Array(5000).fill(120)) });
    assert.deepEqual(await big.layer.request(SAMPLE_ID, SAMPLE_URL, { maxBytes: 10 ** 9 }), { ok: false, error: 'too-large' }, 'a larger limit is ignored');
    for (const value of [0, -5, NaN, Infinity, '99', null]) assert.equal((await sampleEgress({ answer: () => new Response(new Uint8Array(100)) }).layer.request(SAMPLE_ID, SAMPLE_URL, { maxBytes: value })).ok, true, String(value));
    const slow = sampleEgress({ feature: { timeoutMs: 60 }, answer: () => new Promise(() => {}) });
    const delays = [];
    const nativeTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      delays.push(delay);
      return nativeTimeout(callback, 0, ...args);
    });
    assert.deepEqual(await slow.layer.request(SAMPLE_ID, SAMPLE_URL, { timeoutMs: 600000 }), { ok: false, error: 'timeout' });
    assert.deepEqual(delays, [60], 'the feature deadline caps the caller deadline');
    globalThis.setTimeout.mock.restore();
  });

  await t.test('a fetch that never answers, one that honours the signal and a body that never ends are all cut off with a timeout; the signal is aborted', async () => {
    const delays = [];
    const nativeTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      delays.push(delay);
      return nativeTimeout(callback, 0, ...args);
    });
    const ignoring = sampleEgress({ answer: () => new Promise(() => {}) });
    assert.deepEqual(await ignoring.layer.request(SAMPLE_ID, SAMPLE_URL, { timeoutMs: 40 }), { ok: false, error: 'timeout' });
    assert.equal(ignoring.calls[0].init.signal.aborted, true);
    const honouring = sampleEgress({ answer: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    assert.deepEqual(await honouring.layer.request(SAMPLE_ID, SAMPLE_URL, { timeoutMs: 40 }), { ok: false, error: 'timeout' });
    let stalledCancelled = false;
    const stalled = sampleEgress({ answer: () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { stalledCancelled = true; } }), { status: 200 }) });
    assert.deepEqual(await stalled.layer.request(SAMPLE_ID, SAMPLE_URL, { timeoutMs: 40 }), { ok: false, error: 'timeout' });
    assert.equal(stalledCancelled, true, 'the stalled body was cancelled');
    const dripping = sampleEgress({ answer: () => new Response(new ReadableStream({ pull(controller) { return new Promise((resolve) => setTimeout(() => { try { controller.enqueue(new Uint8Array(1)); } catch { /* cancelled meanwhile */ } resolve(); }, 15)); } }), { status: 200 }) });
    assert.deepEqual(await dripping.layer.request(SAMPLE_ID, SAMPLE_URL, { timeoutMs: 80 }), { ok: false, error: 'timeout' }, 'a body that drips for ever is cut off at the deadline');
    assert.deepEqual(delays.filter(delay => delay !== 15), [40, 40, 40, 80], 'each request sets one caller deadline');
    globalThis.setTimeout.mock.restore();
    assert.equal(lastEntry(dripping.layer).error, 'timeout');
    // A fast answer is not delayed or lost by the timer.
    assert.equal((await sampleEgress().layer.request(SAMPLE_ID, SAMPLE_URL, { timeoutMs: 5000 })).ok, true);
  });

  await t.test('only the statuses the feature has a use for are read; any other answer releases its body unread', async () => {
    let released = false;
    const { layer } = sampleEgress({ answer: () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(16)); }, cancel() { released = true; } }), { status: 429, headers: { 'retry-after': '90' } }) });
    const result = await layer.request(SAMPLE_ID, SAMPLE_URL);
    assert.deepEqual({ ...result, headers: { ...result.headers } }, { ok: true, status: 429, headers: { 'retry-after': '90' }, body: null });
    assert.equal(released, true);
    assert.equal(lastEntry(layer).bytes, 0);
    assert.equal(lastEntry(layer).status, 429);
    const wide = sampleEgress({ feature: { bodyStatuses: [200, 202] }, answer: () => new Response('{"a":1}', { status: 202 }) });
    assert.equal((await wide.layer.request(SAMPLE_ID, SAMPLE_URL)).body.toString(), '{"a":1}');
  });

  await t.test('at most maxInFlight requests of one feature run at once; a finished or timed-out one frees its place', async () => {
    let calls = 0;
    let release;
    const { layer } = sampleEgress({ feature: { maxInFlight: 1, timeoutMs: 50 }, answer: () => { calls++; return calls === 1 ? new Promise((resolve) => { release = () => resolve(jsonResponse({})); }) : calls === 2 ? new Promise(() => {}) : jsonResponse({}); } });
    const first = layer.request(SAMPLE_ID, SAMPLE_URL);
    await settle(() => typeof release === 'function');
    assert.deepEqual(await layer.request(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'busy' });
    assert.equal(calls, 1, 'the busy request was not sent');
    release();
    assert.equal((await first).ok, true);
    assert.deepEqual(await layer.request(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'timeout' }, 'the second request hangs and times out');
    assert.equal((await layer.request(SAMPLE_ID, SAMPLE_URL)).ok, true, 'a timed-out request freed its place');
    assert.deepEqual(layer.activity().entries.map((entry) => `${entry.outcome}:${entry.error ?? ''}`), ['ok:', 'refused:busy', 'error:timeout', 'ok:']);
    // The default allows two at once.
    let open = 0;
    const releases = [];
    const pair = sampleEgress({ answer: () => { open++; return new Promise((resolve) => { releases.push(() => resolve(jsonResponse({}))); }); } });
    const a = pair.layer.request(SAMPLE_ID, SAMPLE_URL);
    const b = pair.layer.request(SAMPLE_ID, SAMPLE_URL);
    await settle(() => open === 2);
    assert.deepEqual(await pair.layer.request(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'busy' });
    releases.forEach((go) => go());
    assert.deepEqual((await Promise.all([a, b])).map((result) => result.ok), [true, true]);
  });
});

test('egress opt-in: a feature with a setting is off until the setting is on, the setting is read at the moment of each request, and only an explicit user action passes a feature that allows it', async (t) => {
  const settings = { readingsLibrary: false };
  const optedIn = (extra = {}, options = {}) => sampleEgress({ feature: { optIn: { setting: 'readingsLibrary', ...extra } }, isEnabled: (key) => settings[key] === true, ...options });

  await t.test('off: refused as "disabled", nothing sent, logged as refused; on: sent; off again: refused again (the setting is never cached)', async () => {
    settings.readingsLibrary = false;
    const { layer, calls } = optedIn();
    assert.deepEqual(await layer.request(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'disabled' });
    assert.equal(calls.length, 0);
    assert.deepEqual({ outcome: lastEntry(layer).outcome, error: lastEntry(layer).error, host: lastEntry(layer).host }, { outcome: 'refused', error: 'disabled', host: SAMPLE_HOST });
    settings.readingsLibrary = true;
    assert.equal((await layer.request(SAMPLE_ID, SAMPLE_URL)).ok, true);
    assert.equal(calls.length, 1);
    settings.readingsLibrary = false;
    assert.deepEqual(await layer.request(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'disabled' });
    assert.equal(calls.length, 1);
    assert.deepEqual(layer.activity().entries.map((entry) => entry.outcome), ['refused', 'ok', 'refused']);
  });

  await t.test('a setting that is not exactly true is off: a failing or missing isEnabled, and any other truthy value', async () => {
    for (const isEnabled of [undefined, () => { throw new Error('no settings'); }, () => 1, () => 'true', () => ({}), () => undefined, () => null, () => false]) {
      const { layer, calls } = sampleEgress({ feature: { optIn: { setting: 'readingsLibrary' } }, isEnabled });
      assert.deepEqual(await layer.request(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'disabled' }, String(isEnabled));
      assert.equal(calls.length, 0);
      assert.equal(layer.features()[0].enabled, false);
    }
    const asked = [];
    const { layer } = sampleEgress({ feature: { optIn: { setting: 'readingsLibrary' } }, isEnabled: (key) => { asked.push(key); return true; } });
    await layer.request(SAMPLE_ID, SAMPLE_URL);
    assert.deepEqual(asked, ['readingsLibrary'], 'only the feature\'s own setting is asked');
  });

  await t.test('an opt-in that allows a user action lets exactly userAction: true through while the setting is off; the renderer-style truthy values do not', async () => {
    settings.readingsLibrary = false;
    const { layer, calls } = optedIn({ bypassWithUserAction: true });
    for (const userAction of [undefined, false, 1, 'true', {}, null]) assert.deepEqual(await layer.request(SAMPLE_ID, SAMPLE_URL, { userAction }), { ok: false, error: 'disabled' }, String(userAction));
    assert.equal(calls.length, 0);
    assert.equal((await layer.request(SAMPLE_ID, SAMPLE_URL, { userAction: true })).ok, true);
    assert.equal(calls.length, 1);
    // A feature that does not allow it is refused even for a user action: the setting is the only switch.
    const strict = optedIn();
    assert.deepEqual(await strict.layer.request(SAMPLE_ID, SAMPLE_URL, { userAction: true }), { ok: false, error: 'disabled' });
    assert.equal(strict.calls.length, 0);
  });

  await t.test('features() lists the setting a feature depends on and whether it is on; a feature without an opt-in is always listed as on', async () => {
    settings.readingsLibrary = false;
    const { layer } = optedIn();
    layer.register(sampleFeature({ id: 'always-on', hosts: ['other.example.org'] }));
    assert.deepEqual(layer.features(), [
      { id: SAMPLE_ID, hosts: [SAMPLE_HOST], methods: ['GET'], optIn: 'readingsLibrary', enabled: false },
      { id: 'always-on', hosts: ['other.example.org'], methods: ['GET'], optIn: null, enabled: true },
    ]);
    settings.readingsLibrary = true;
    assert.equal(layer.features()[0].enabled, true);
    assert.equal(layer.isAllowedUrl('https://other.example.org/x'), true);
    assert.equal(layer.isAllowedUrl('https://other.example.org:444/x'), false);
    assert.equal(layer.isAllowedUrl('http://other.example.org/x'), false);
    assert.equal(layer.isAllowedUrl('https://user@other.example.org/x'), false);
    assert.equal(layer.isAllowedUrl('https://evil.example/x'), false);
    assert.equal(layer.isAllowedUrl(42), false);
  });
});

test('egress log: every request and its outcome, host and path only, bounded, in memory and read as copies', async (t) => {
  await t.test('an entry has exactly these fields; time, duration, bytes, status and outcome come from the exchange', async () => {
    let clock = Date.parse('2026-10-07T10:00:00.000Z');
    const { layer } = sampleEgress({ now: () => clock, answer: () => { clock += 25; return jsonResponse({ ok: true }); } });
    assert.deepEqual(layer.activity(), { limit: 200, dropped: 0, entries: [] });
    await layer.request(SAMPLE_ID, SAMPLE_URL);
    clock += 1000;
    assert.deepEqual(layer.activity().entries, [{
      id: 1, time: '2026-10-07T10:00:00.000Z', kind: 'request', feature: SAMPLE_ID, method: 'GET', host: SAMPLE_HOST, path: '/library/index.json',
      outcome: 'ok', status: 200, bytes: JSON.stringify({ ok: true }).length, durationMs: 25, error: null,
    }]);
    assert.deepEqual(Object.keys(lastEntry(layer)).sort(), ['bytes', 'durationMs', 'error', 'feature', 'host', 'id', 'kind', 'method', 'outcome', 'path', 'status', 'time']);
  });

  await t.test('a request in flight is already in the log as "pending" and is completed in place', async () => {
    let release;
    const { layer } = sampleEgress({ answer: () => new Promise((resolve) => { release = () => resolve(jsonResponse({})); }) });
    const pending = layer.request(SAMPLE_ID, SAMPLE_URL);
    await settle(() => typeof release === 'function');
    assert.deepEqual({ outcome: lastEntry(layer).outcome, status: lastEntry(layer).status, durationMs: lastEntry(layer).durationMs, bytes: lastEntry(layer).bytes }, { outcome: 'pending', status: null, durationMs: null, bytes: 0 });
    release();
    await pending;
    assert.equal(layer.activity().entries.length, 1);
    assert.equal(lastEntry(layer).outcome, 'ok');
    assert.equal(lastEntry(layer).status, 200);
  });

  await t.test('failures are logged with a class from the fixed list and never with the text of an error, a header or a body', async () => {
    const secret = 'token=SECRET-123 C:\\Users\\Someone';
    const { layer } = sampleEgress({ answer: (url, init) => { if (url.includes('boom')) throw new Error(`failed https://data.example.org/x?${secret}`); return jsonResponse({}, { status: 500, headers: { 'x-secret': secret } }); } });
    await layer.request(SAMPLE_ID, `https://${SAMPLE_HOST}/boom`);
    await layer.request(SAMPLE_ID, `https://${SAMPLE_HOST}/server-error`);
    const [failed, status] = layer.activity().entries;
    assert.deepEqual({ outcome: failed.outcome, error: failed.error, status: failed.status }, { outcome: 'error', error: 'network', status: null });
    assert.deepEqual({ outcome: status.outcome, error: status.error, status: status.status }, { outcome: 'ok', error: null, status: 500 });
    assert.doesNotMatch(JSON.stringify(layer.activity()), /SECRET|Someone|token|x-secret|User-Agent|Accept/i);
    for (const entry of layer.activity().entries) assert.ok(entry.error === null || egressModule.ERROR_CLASSES.includes(entry.error));
  });

  await t.test('only the host and the path of an https/http URL are ever shown: other schemes show nothing, a long path is cut, the query and fragment are gone', async () => {
    const { layer } = sampleEgress({ feature: { allowQuery: true } });
    await layer.request(SAMPLE_ID, 'data:text/plain,SECRET-IN-DATA');
    await layer.request(SAMPLE_ID, 'javascript:alert(SECRET)');
    await layer.request(SAMPLE_ID, `https://user:SECRET@${SAMPLE_HOST}/library/index.json`);
    await layer.request(SAMPLE_ID, `https://${SAMPLE_HOST}/${'a'.repeat(300)}?token=SECRET`);
    const [data, script, userinfo, long] = layer.activity().entries;
    assert.deepEqual([data.host, data.path, script.host, script.path], ['', '', '', '']);
    assert.deepEqual([userinfo.host, userinfo.path], [SAMPLE_HOST, '/library/index.json']);
    assert.equal(long.path.length, 120);
    assert.ok(long.path.endsWith('…'));
    assert.doesNotMatch(JSON.stringify(layer.activity()), /SECRET|token|user:/);
  });

  await t.test('the log is a ring: only the newest entries stay, the dropped ones are counted, the sequence never repeats, and the size is clamped', async () => {
    const { layer } = sampleEgress({ logLimit: 5 });
    for (let index = 0; index < 12; index++) await layer.request(SAMPLE_ID, SAMPLE_URL);
    const { entries, dropped, limit } = layer.activity();
    assert.equal(limit, 5);
    assert.equal(entries.length, 5);
    assert.equal(dropped, 7);
    assert.deepEqual(entries.map((entry) => entry.id), [8, 9, 10, 11, 12]);
    assert.equal(sampleEgress().layer.logLimit, 200, 'the default');
    for (const logLimit of [0, -1, NaN, '5', 1.5, null, Infinity]) assert.equal(sampleEgress({ logLimit }).layer.logLimit, 200, String(logLimit));
    assert.equal(sampleEgress({ logLimit: 99999 }).layer.logLimit, 1000, 'the largest');
    const big = sampleEgress({ logLimit: 99999 });
    for (let index = 0; index < 1001; index++) await big.layer.request(SAMPLE_ID, SAMPLE_URL);
    assert.equal(big.layer.activity().entries.length, 1000);
    assert.equal(big.layer.activity().dropped, 1);
    const flood = sampleEgress();
    for (let index = 0; index < 500; index++) await flood.layer.request(SAMPLE_ID, 'https://evil.example/x');
    assert.equal(flood.layer.activity().entries.length, 200, 'a flood of refused requests is bounded too');
    assert.equal(flood.layer.activity().dropped, 300);
  });

  await t.test('clearing empties the log and the dropped count but not the sequence; reading gives copies that cannot change the log', async () => {
    const { layer } = sampleEgress();
    await layer.request(SAMPLE_ID, SAMPLE_URL);
    await layer.request(SAMPLE_ID, SAMPLE_URL);
    const copy = layer.activity();
    copy.entries[0].host = 'evil.example';
    copy.entries.length = 0;
    assert.equal(layer.activity().entries.length, 2);
    assert.equal(layer.activity().entries[0].host, SAMPLE_HOST);
    layer.clearLog();
    assert.deepEqual(layer.activity(), { limit: 200, dropped: 0, entries: [] });
    await layer.request(SAMPLE_ID, SAMPLE_URL);
    assert.deepEqual(layer.activity().entries.map((entry) => entry.id), [3]);
    assert.equal(Object.isFrozen(layer), true, 'the layer object itself cannot be changed');
  });
});

test('egress download: the audited path to disk writes only into the folder main chose, under a name made from the SHA-256, size-capped, and leaves nothing behind on any failure', async (t) => {
  const root = await makeTempDir('trace-egress-download-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  let counter = 0;
  const content = Buffer.from('{"readings":[1,2,3]}');
  const digest = sha256(content);
  const listing = async (directory) => { try { return (await fs.readdir(directory)).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const downloading = ({ feature = {}, ...options } = {}) => {
    const directory = path.join(root, `downloads-${++counter}`);
    const built = sampleEgress({
      feature: { timeoutMs: 30_000, download: { maxBytes: 1024, extension: 'json' }, ...feature }, downloadDirectory: directory,
      answer: () => new Response(content, { status: 200, headers: { 'content-disposition': 'attachment; filename="../../evil.exe"' } }), ...options,
    });
    return { ...built, directory };
  };

  await t.test('the file is named by its SHA-256 and the feature\'s extension, written into the chosen folder, and the path, digest and size come back', async () => {
    const { layer, calls, directory } = downloading();
    const result = await layer.download(SAMPLE_ID, SAMPLE_URL);
    assert.deepEqual(result, { ok: true, status: 200, path: path.join(directory, `${digest}.json`), sha256: digest, bytes: content.length });
    assert.deepEqual(await fs.readFile(result.path), content);
    assert.deepEqual(await listing(directory), [`${digest}.json`], 'no temporary file is left');
    assert.equal(path.dirname(result.path), directory);
    assert.deepEqual(Object.keys(calls[0].init).sort(), ['credentials', 'headers', 'method', 'redirect', 'referrer', 'referrerPolicy', 'signal'], 'the same request as any other');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.credentials, 'omit');
    const entry = lastEntry(layer);
    assert.deepEqual({ kind: entry.kind, outcome: entry.outcome, bytes: entry.bytes, status: entry.status, path: entry.path }, { kind: 'download', outcome: 'ok', bytes: content.length, status: 200, path: '/library/index.json' });
    assert.doesNotMatch(JSON.stringify(layer.activity()), /downloads-|Users|Temp/i, 'the log shows no local path');
    if (process.platform !== 'win32') assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
    // The same bytes again land in the same file.
    const again = await layer.download(SAMPLE_ID, SAMPLE_URL);
    assert.equal(again.path, result.path);
    assert.deepEqual(await listing(directory), [`${digest}.json`]);
  });

  await t.test('the caller supplies no folder, path or file name, and nothing from the URL or the server reaches the file system', async () => {
    const { layer, directory } = downloading();
    const other = path.join(root, 'elsewhere');
    const result = await layer.download(`${SAMPLE_ID}`, `https://${SAMPLE_HOST}/library/..%2F..%2Fevil.json`, {
      directory: other, downloadDirectory: other, path: other, fileName: '../../x.json', filename: 'x.json', target: path.join(other, 'x.json'), extension: 'exe', userAction: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.path, path.join(directory, `${digest}.json`));
    assert.deepEqual(await listing(directory), [`${digest}.json`], 'neither the URL path nor the Content-Disposition name was used');
    assert.deepEqual(await listing(other), [], 'the folder the caller named was never touched');
    await assert.rejects(fs.access(other), 'and not even created');
  });

  await t.test('too large (declared, streamed or endless) is refused, a caller can only lower the cap, and no file or temporary file remains', async () => {
    const { layer, directory } = downloading({ answer: () => new Response(new Uint8Array(1025).fill(120)) });
    assert.deepEqual(await layer.download(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'too-large' });
    assert.deepEqual(await listing(directory), []);
    const declared = downloading({ answer: () => new Response(new Uint8Array(10), { headers: { 'content-length': '5000' } }) });
    assert.deepEqual(await declared.layer.download(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'too-large' });
    assert.deepEqual(await listing(declared.directory), []);
    const stream = countedStream([], { endless: true });
    const endless = downloading({ answer: () => new Response(stream.body) });
    assert.deepEqual(await endless.layer.download(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'too-large' });
    assert.equal(stream.state.cancelled, true);
    assert.ok(stream.state.pulls < 50);
    assert.deepEqual(await listing(endless.directory), []);
    const small = downloading();
    assert.deepEqual(await small.layer.download(SAMPLE_ID, SAMPLE_URL, { maxBytes: content.length - 1 }), { ok: false, error: 'too-large' });
    assert.deepEqual(await listing(small.directory), []);
    const huge = downloading({ answer: () => new Response(new Uint8Array(2000)) });
    assert.deepEqual(await huge.layer.download(SAMPLE_ID, SAMPLE_URL, { maxBytes: 10 ** 9 }), { ok: false, error: 'too-large' }, 'a larger cap is ignored');
    assert.deepEqual(await listing(huge.directory), []);
    assert.equal(lastEntry(huge.layer).outcome, 'error');
    assert.equal(lastEntry(huge.layer).kind, 'download');
  });

  await t.test('a body that stalls half way, a fetch that never answers and a drip are cut off by the deadline and take their temporary file with them', async () => {
    const stalled = downloading({ feature: { timeoutMs: 80 }, answer: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10).fill(1)); }, pull() { return new Promise(() => {}); } })) });
    assert.deepEqual(await stalled.layer.download(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'timeout' });
    assert.deepEqual(await listing(stalled.directory), []);
    const silent = downloading({ answer: () => new Promise(() => {}) });
    assert.deepEqual(await silent.layer.download(SAMPLE_ID, SAMPLE_URL, { timeoutMs: 40 }), { ok: false, error: 'timeout' });
    assert.deepEqual(await listing(silent.directory), []);
    assert.equal(silent.calls[0].init.signal.aborted, true);
  });

  await t.test('an expected digest is checked before the file is kept: a wrong one leaves nothing, the right one succeeds, a malformed one is refused', async () => {
    const wrong = downloading();
    assert.deepEqual(await wrong.layer.download(SAMPLE_ID, SAMPLE_URL, { expectedSha256: sha256('other') }), { ok: false, error: 'hash-mismatch' });
    assert.deepEqual(await listing(wrong.directory), []);
    const right = downloading();
    assert.equal((await right.layer.download(SAMPLE_ID, SAMPLE_URL, { expectedSha256: digest })).ok, true);
    assert.deepEqual(await listing(right.directory), [`${digest}.json`]);
    for (const expectedSha256 of [digest.toUpperCase(), digest.slice(1), `${digest}0`, '', 42, null, {}, [digest]]) {
      const malformed = downloading();
      assert.deepEqual(await malformed.layer.download(SAMPLE_ID, SAMPLE_URL, { expectedSha256 }), { ok: false, error: 'not-allowed' }, String(expectedSha256));
      assert.equal(malformed.calls.length, 0);
    }
    assert.deepEqual(await sampleEgress().layer.request(SAMPLE_ID, SAMPLE_URL, { expectedSha256: digest }), { ok: false, error: 'not-allowed' }, 'a plain request cannot be checked against a digest');
  });

  await t.test('only a 200 answer is kept; redirects and other statuses are refused and write nothing', async () => {
    for (const [status, error] of [[404, 'bad-response'], [500, 'bad-response'], [202, 'bad-response'], [301, 'redirect'], [307, 'redirect']]) {
      const { layer, directory } = downloading({ answer: () => new Response(content, { status }) });
      assert.deepEqual(await layer.download(SAMPLE_ID, SAMPLE_URL), { ok: false, error, status }, String(status));
      assert.deepEqual(await listing(directory), []);
    }
    const redirected = downloading({ answer: () => Object.defineProperty(new Response(content), 'redirected', { value: true }) });
    assert.deepEqual(await redirected.layer.download(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'redirect' });
    assert.deepEqual(await listing(redirected.directory), []);
  });

  await t.test('the same policy as a request applies first: host, scheme, path, method, opt-in; no folder, a relative folder or a feature without download is "not-allowed"', async () => {
    const { layer, calls } = downloading({ feature: { optIn: { setting: 'readingsLibrary' } }, isEnabled: () => false });
    assert.deepEqual(await layer.download(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'disabled' });
    const policy = downloading();
    assert.deepEqual(await policy.layer.download(SAMPLE_ID, 'https://evil.example/x.json'), { ok: false, error: 'host' });
    assert.deepEqual(await policy.layer.download(SAMPLE_ID, `http://${SAMPLE_HOST}/x.json`), { ok: false, error: 'scheme' });
    assert.deepEqual(await policy.layer.download(SAMPLE_ID, `${SAMPLE_URL}?x=1`), { ok: false, error: 'invalid-url' });
    assert.deepEqual(await policy.layer.download(SAMPLE_ID, SAMPLE_URL, { method: 'HEAD' }), { ok: false, error: 'method' });
    assert.equal(policy.calls.length + calls.length, 0);
    assert.deepEqual(await listing(policy.directory), []);
    for (const downloadDirectory of [undefined, null, '', 'relative/downloads', './downloads', 42, 'C:\\ok\0bad']) {
      const refused = sampleEgress({ feature: { download: { maxBytes: 1024, extension: 'json' } }, downloadDirectory });
      assert.deepEqual(await refused.layer.download(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'not-allowed' }, String(downloadDirectory));
      assert.equal(refused.calls.length, 0);
    }
    const plain = sampleEgress({ downloadDirectory: path.join(root, 'no-download-feature') });
    assert.deepEqual(await plain.layer.download(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'not-allowed' });
    assert.equal(plain.calls.length, 0);
    assert.deepEqual(await listing(path.join(root, 'no-download-feature')), []);
  });

  await t.test('a folder that cannot be used, a write that fails or writes nothing and a failing rename are "storage" errors that leave nothing behind; short writes are completed', async () => {
    const blocker = path.join(root, 'a-file');
    await fs.writeFile(blocker, 'x');
    const file = sampleEgress({ feature: { download: { maxBytes: 1024, extension: 'json' } }, downloadDirectory: blocker });
    assert.deepEqual(await file.layer.download(SAMPLE_ID, SAMPLE_URL), { ok: false, error: 'storage' });
    assert.equal(await fs.readFile(blocker, 'utf8'), 'x');
    const failing = async (patch) => {
      const { layer, directory } = downloading({ fs: patch });
      const result = await layer.download(SAMPLE_ID, SAMPLE_URL);
      return { result, files: await listing(directory) };
    };
    const writeFails = await failing({ ...fs, open: async (...args) => { const handle = await fs.open(...args); handle.write = async () => { throw new Error('disk full'); }; return handle; } });
    assert.deepEqual(writeFails, { result: { ok: false, error: 'storage' }, files: [] });
    const writesNothing = await failing({ ...fs, open: async (...args) => { const handle = await fs.open(...args); handle.write = async () => ({ bytesWritten: 0 }); return handle; } });
    assert.deepEqual(writesNothing, { result: { ok: false, error: 'storage' }, files: [] });
    const renameFails = await failing({ ...fs, rename: async () => { throw new Error('locked'); } });
    assert.deepEqual(renameFails, { result: { ok: false, error: 'storage' }, files: [] });
    const openFails = await failing({ ...fs, open: async () => { throw new Error('denied'); } });
    assert.deepEqual(openFails, { result: { ok: false, error: 'storage' }, files: [] });
    const { layer, directory } = downloading({ fs: { ...fs, open: async (...args) => { const handle = await fs.open(...args); const write = handle.write.bind(handle); handle.write = (buffer, offset, length, position) => write(buffer, offset, Math.min(length, 3), position); return handle; } } });
    const result = await layer.download(SAMPLE_ID, SAMPLE_URL);
    assert.equal(result.ok, true);
    assert.deepEqual(await fs.readFile(result.path), content, 'a legal short write is completed');
    assert.deepEqual(await listing(directory), [`${digest}.json`]);
  });
});

test('egress transport: the production fetch is the in-memory trace-egress partition, created on first use, with no permission, no download and a second line of defence for the hosts', async (t) => {
  const partitions = [];
  const sessionCalls = [];
  const partition = Object.assign(new EventEmitter(), {
    webRequest: { listeners: [], onBeforeRequest(filter, listener) { this.listeners.push({ filter, listener }); } },
    setPermissionRequestHandler(callback) { this.permissionHandler = callback; },
    setPermissionCheckHandler(callback) { this.permissionCheck = callback; },
    fetch(url, init) { sessionCalls.push({ url, init }); return Promise.resolve(jsonResponse({ ok: true })); },
  });
  const session = { fromPartition(name, options) { partitions.push({ name, options }); return partition; }, get defaultSession() { throw new Error('the default session is never used'); } };
  const { layer } = sampleEgress({ register: true });

  await t.test('nothing is created until the first request; then one partition without cache, named without "persist:" (so it lives in memory only), and the fetch goes through its session', async () => {
    const fetchImpl = createElectronFetch({ session, isAllowed: (url) => layer.isAllowedUrl(url) });
    assert.deepEqual(partitions, [], 'created lazily');
    const response = await fetchImpl(SAMPLE_URL, { method: 'GET' });
    assert.equal(response.status, 200);
    await fetchImpl(SAMPLE_URL, { method: 'GET' });
    assert.deepEqual(partitions, [{ name: 'trace-egress', options: { cache: false } }], 'one partition, reused');
    assert.equal(egressModule.PARTITION, 'trace-egress');
    assert.doesNotMatch(partitions[0].name, /^persist:/);
    assert.deepEqual(sessionCalls.map((call) => call.url), [SAMPLE_URL, SAMPLE_URL]);
  });

  await t.test('the partition grants no permission, starts no download, and cancels any request to a URL no feature may reach', async () => {
    const answers = [];
    partition.permissionHandler({}, 'notifications', (allowed) => answers.push(allowed));
    assert.deepEqual(answers, [false]);
    assert.equal(partition.permissionCheck({}, 'clipboard-read'), false);
    let prevented = false;
    partition.emit('will-download', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(partition.webRequest.listeners.length, 1);
    const { filter, listener } = partition.webRequest.listeners[0];
    assert.deepEqual(filter, { urls: ['*://*/*'] });
    const decide = (url) => { let decision; listener({ url }, (value) => { decision = value; }); return decision; };
    assert.deepEqual(decide(SAMPLE_URL), { cancel: false });
    for (const url of ['https://evil.example/', `http://${SAMPLE_HOST}/library/index.json`, `https://${SAMPLE_HOST}:8443/x`, `https://user@${SAMPLE_HOST}/x`, 'wss://data.example.org/', 'file:///C:/x']) assert.deepEqual(decide(url), { cancel: true }, url);
  });

  await t.test('a session that lacks the optional hooks still works (they are best effort), and the hooks are installed once however many requests follow', async () => {
    const bare = { fetch: () => Promise.resolve(jsonResponse({})) };
    const fetchImpl = createElectronFetch({ session: { fromPartition: () => bare }, isAllowed: () => true });
    assert.equal((await fetchImpl(SAMPLE_URL, {})).status, 200);
    assert.equal(partition.webRequest.listeners.length, 1, 'the first session was not hooked again');
  });
});

test('egress isolation: no main-process file but electron/net/egress.cjs reaches the network, egress itself uses only Node built-ins, and the renderer CSP is unchanged', async (t) => {
  const electronDirectory = path.resolve(__dirname, '..', 'electron');
  const walk = async (directory) => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(async (entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : /\.(?:cjs|mjs|js|ts)$/.test(entry.name) ? [full] : [];
  }))).flat();
  const BUILTINS = '(?:node:)?(?:https?|http2|net|tls|dgram|dns|undici)|node-fetch|axios|got|electron-updater|request|superagent|ws';
  /** Every way a file of the main process could reach the network on its own. A comment may mention them; a call, an import or a require may not. */
  const NETWORK = [
    /\.fetch\s*\(/, /(?<![\w.$])fetch\s*\(/, /\bnet\.(?:request|connect|fetch)\s*\(/, /\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource|ClientRequest)\b/, /\bnavigator\.sendBeacon\b/,
    new RegExp(`require\\(\\s*['"](?:${BUILTINS})['"]\\s*\\)`), new RegExp(`import\\s*\\(\\s*['"](?:${BUILTINS})['"]`), new RegExp(`from\\s+['"](?:${BUILTINS})['"]`),
    /\bautoUpdater\b/, /\bdownloadURL\s*\(/, /\{[^}]*\bnet\b[^}]*\}\s*=\s*require\(\s*['"]electron['"]\s*\)/,
  ];
  const files = (await walk(electronDirectory)).map((file) => path.relative(electronDirectory, file).split(path.sep).join('/'));

  await t.test('the scan sees the main process files, and only electron/net/egress.cjs matches a network pattern', async () => {
    for (const expected of ['main.cjs', 'updates.cjs', 'store.cjs', 'documents.cjs', 'workspace.cjs', 'preload.cjs', 'net/egress.cjs']) assert.ok(files.includes(expected), `${expected} is scanned`);
    const offenders = [];
    for (const file of files) {
      const source = await fs.readFile(path.join(electronDirectory, file), 'utf8');
      for (const pattern of NETWORK) if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
    }
    assert.deepEqual([...new Set(offenders.map((offender) => offender.split(':')[0]))], ['net/egress.cjs'], offenders.join('\n'));
  });

  await t.test('the patterns really catch a call, an import and a require (so a clean scan means something)', async () => {
    for (const sample of ['net.fetch(url)', 'await fetch(url)', 'session.defaultSession.fetch(url)', 'const { net } = require(\'electron\')', 'require("node:https")', 'require(\'http\')', 'import https from \'node:https\'', 'new WebSocket(url)', 'new XMLHttpRequest()', 'autoUpdater.checkForUpdates()', 'require("undici")', 'net.request({})']) {
      assert.ok(NETWORK.some((pattern) => pattern.test(sample)), sample);
    }
    for (const sample of ['// net.fetch was here', 'fetchImpl(url, init)', 'const fetchImpl = createElectronFetch({})', 'require(\'node:path\')', 'shell.openExternal(url)']) {
      assert.equal(NETWORK.some((pattern) => pattern.test(sample.replace(/^\/\/.*$/, ''))), false, sample);
    }
  });

  await t.test('egress.cjs has exactly one fetch call (the transport), requires nothing but node:crypto, node:fs/promises and node:path, and never reads or writes a cookie store', async () => {
    const source = await fs.readFile(path.join(electronDirectory, 'net', 'egress.cjs'), 'utf8');
    assert.equal(source.split(/\.fetch\s*\(/).length - 1, 1, 'one .fetch( call site');
    assert.deepEqual([...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]).sort(), ['node:crypto', 'node:fs/promises', 'node:path']);
    assert.doesNotMatch(source, /\.cookies\b|\bsetCookie\b/);
    assert.doesNotMatch(source, /writeFile\(|appendFile\(|createWriteStream\(/, 'the log is memory only; the one file write is the audited download');
  });

  await t.test('main.cjs, updates.cjs and the preload hold no fetch, no net import and no update URL; updates.cjs reaches the network only through egress', async () => {
    const [main, updatesSource, preload] = await Promise.all(['main.cjs', 'updates.cjs', 'preload.cjs'].map((name) => fs.readFile(path.join(electronDirectory, name), 'utf8')));
    assert.match(main, /require\('\.\/net\/egress\.cjs'\)/);
    assert.match(updatesSource, /require\('\.\/net\/egress\.cjs'\)/);
    assert.doesNotMatch(main, /\bnet\b[^\n]*require\('electron'\)|\{[^}]*\bnet\b[^}]*\}\s*=\s*require\('electron'\)/);
    assert.doesNotMatch(updatesSource, /\.fetch\s*\(|(?<![\w.$])fetch\s*\(/);
    assert.doesNotMatch(preload, /\bfetch\(|XMLHttpRequest|WebSocket|node:https?|\bhttps?\.request/);
  });

  await t.test('the renderer CSP is unchanged: the page may connect to itself only (plus the dev server websocket, which the production build removes), with no unsafe-eval', async () => {
    const html = await fs.readFile(path.resolve(__dirname, '..', 'index.html'), 'utf8');
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
    assert.equal(csp, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws://127.0.0.1:5173; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'");
    const production = csp.replace(' ws://127.0.0.1:5173', '');
    assert.equal(/connect-src ([^;]*)/.exec(production)[1], "'self'");
    assert.doesNotMatch(csp, /unsafe-eval|\*|https?:|github/i);
    assert.equal((html.match(/Content-Security-Policy/g) ?? []).length, 1, 'one policy');
  });
});

test('network activity in the main process: the update check runs through egress and is logged, and the renderer can read and empty the log but never start a request', async (t) => {
  const root = await makeTempDir('trace-network-activity-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  let counter = 0;
  const plain = (value) => JSON.parse(JSON.stringify(value)); // The harness runs main.cjs in another realm.
  const networking = (answer, options = {}) => desktopHarness(path.join(root, `profile-${++counter}`), { ...options, fetch: async (url, init) => answer(url, init) });
  const release = (tag) => () => jsonResponse(releaseBody(tag));
  const CHANNELS = ['trace:clear-network-activity', 'trace:get-network-activity'];
  const FORGED = [{ sender: {}, senderFrame: { url: 'https://example.com/' } }];
  const activity = async (harness) => plain(await harness.invoke('trace:get-network-activity'));
  const UPDATE_PATH = '/repos/trace-boardviewer/trace-boardviewer/releases/latest';

  await t.test('both channels are privileged handlers: a forged sender or a subframe reaches neither the log nor the network, and they are the only network channels', async () => {
    const harness = await networking(release('v9.9.9'));
    await harness.invoke('trace:check-for-updates');
    for (const channel of CHANNELS) {
      const handler = harness.handlers.get(channel);
      assert.equal(typeof handler, 'function', channel);
      await assert.rejects(handler(...FORGED), /nem az alkalmazás/, channel);
      await assert.rejects(handler({ sender: harness.window.webContents, senderFrame: { url: 'https://example.com/' } }), /nem az alkalmazás/, channel);
      await assert.rejects(handler({ sender: harness.window.webContents, senderFrame: { ...harness.window.webContents.mainFrame, url: `${harness.window.webContents.mainFrame.url}?x=1` } }), /nem az alkalmazás/, `${channel}: another page URL`);
    }
    assert.equal((await activity(harness)).entries.length, 1, 'the forged clear emptied nothing');
    assert.equal(harness.net.requests.length, 1);
    assert.deepEqual([...harness.handlers.keys()].filter((channel) => /network|egress|fetch|download|proxy/i.test(channel)).sort(), CHANNELS, 'no channel lets the renderer name a URL, a host or a feature');
    assert.deepEqual([...harness.handlers.keys()].filter((channel) => /^trace:(?:get|clear)-network/.test(channel)).sort(), CHANNELS);
  });

  await t.test('nothing is requested on its own and no session is created before the first request: the list shows the one feature, off the network until the renderer asks', async () => {
    const harness = await networking(release('v9.9.9'));
    assert.deepEqual(harness.partitions, [], 'no partition at start-up');
    const first = await activity(harness);
    assert.deepEqual(first.features, [{ id: 'update-check', hosts: ['api.github.com'], methods: ['GET'], optIn: 'updateCheck', enabled: true }, { id: 'support-verification', hosts: [require('../electron/support.cjs').FEATURE.hosts[0]], methods: ['GET'], optIn: 'supportVerification', enabled: false }]);
    assert.deepEqual(first.entries, []);
    assert.equal(first.dropped, 0);
    assert.equal(first.limit, 200);
    assert.deepEqual(harness.net.requests, []);
    assert.deepEqual(harness.partitions, [], 'listing the features creates no session either');
  });

  await t.test('the update check is one logged request: host and path only, status and size, no header, no body and no server text', async () => {
    const harness = await networking(() => jsonResponse(releaseBody('v1.2.1'), { headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', 'x-evil': 'phish' } }));
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'available', version: '1.2.1' });
    const { entries, features } = await activity(harness);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.deepEqual({ kind: entry.kind, feature: entry.feature, method: entry.method, host: entry.host, path: entry.path, outcome: entry.outcome, status: entry.status, error: entry.error },
      { kind: 'request', feature: 'update-check', method: 'GET', host: 'api.github.com', path: UPDATE_PATH, outcome: 'ok', status: 200, error: null });
    assert.ok(entry.bytes > 0 && entry.bytes <= 262144);
    assert.ok(Number.isInteger(entry.durationMs) && entry.durationMs >= 0);
    assert.match(entry.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'durationMs', 'error', 'feature', 'host', 'id', 'kind', 'method', 'outcome', 'path', 'status', 'time']);
    assert.doesNotMatch(JSON.stringify({ entries, features }), /evil|phish|setup\.exe|set-cookie|User-Agent|vnd\.github|Accept/i);
    assert.deepEqual(harness.partitions, [{ name: 'trace-egress', options: { cache: false } }], 'the request went through the in-memory partition');
    assert.equal(harness.net.requests[0].url, `https://api.github.com${UPDATE_PATH}`);
  });

  await t.test('every outcome of the update check is a log entry: a rate limit (status 429), an offline failure (network), an oversize answer (too-large), a redirect, and a repeated ask inside the cooldown adds none', async () => {
    const answers = [
      () => jsonResponse(releaseBody('v9.9.9'), { status: 429, headers: { 'retry-after': '90' } }),
      () => { throw new Error('offline https://api.github.com/x?token=SECRET'); },
      () => new Response(new Uint8Array(262145), { status: 200 }),
      () => Object.defineProperty(jsonResponse(releaseBody('v9.9.9')), 'redirected', { value: true }),
      () => jsonResponse(releaseBody('v1.2.1')),
    ];
    const harness = await networking((url, init) => answers.shift()(url, init));
    const later = (ms) => vm.runInContext(`Date.now = ((real, offset) => () => real() + offset)(Date.now, ${ms})`, harness.context);
    const results = [];
    for (let index = 0; index < 5; index++) { later(index === 1 ? 3600000 : 30000); results.push(plain(await harness.invoke('trace:check-for-updates'))); }
    assert.deepEqual(results.map((result) => result.status), ['unavailable', 'unavailable', 'unavailable', 'unavailable', 'available']);
    const { entries } = await activity(harness);
    assert.deepEqual(entries.map((entry) => [entry.outcome, entry.status, entry.error]), [['ok', 429, null], ['error', null, 'network'], ['error', null, 'too-large'], ['error', null, 'redirect'], ['ok', 200, null]]);
    assert.deepEqual(entries.map((entry) => entry.id), [1, 2, 3, 4, 5]);
    assert.doesNotMatch(JSON.stringify(entries), /SECRET|offline|token/);
    await harness.invoke('trace:check-for-updates'); // inside the cooldown: the last answer, no request
    assert.equal((await activity(harness)).entries.length, 5);
    assert.equal(harness.net.requests.length, 5);
  });

  await t.test('the setting is the switch of the automatic check, and Check now (a user action) still goes through with it off; the list shows the state live', async () => {
    const harness = await networking(release('v1.2.1'));
    const settings = plain(await harness.invoke('trace:get-settings'));
    assert.equal((await activity(harness)).features[0].enabled, true);
    await harness.invoke('trace:save-settings', { ...settings, updateCheck: false });
    assert.equal((await activity(harness)).features[0].enabled, false, 'off in the list as soon as it is saved');
    assert.equal((await activity(harness)).features[0].optIn, 'updateCheck');
    assert.deepEqual(plain(await harness.invoke('trace:check-for-updates')), { status: 'available', version: '1.2.1' }, 'Check now is the user\'s own request');
    assert.equal(harness.net.requests.length, 1);
    assert.equal((await activity(harness)).entries[0].outcome, 'ok');
    await harness.invoke('trace:save-settings', { ...settings, updateCheck: true });
    assert.equal((await activity(harness)).features[0].enabled, true);
  });

  await t.test('the egress rules hold for the update feature in the main process: the exact URL only, the exact headers, no credentials, no redirects', async () => {
    const harness = await networking(release('v1.2.1'), { version: '1.4.2' });
    await harness.invoke('trace:check-for-updates');
    const [request] = harness.net.requests;
    assert.equal(request.url, `https://api.github.com${UPDATE_PATH}`);
    assert.deepEqual(Object.keys(request.init).sort(), ['credentials', 'headers', 'method', 'redirect', 'referrer', 'referrerPolicy', 'signal']);
    assert.deepEqual({ ...request.init.headers }, { Accept: 'application/vnd.github+json', 'Accept-Language': 'en', 'User-Agent': 'TRACE-Boardviewer/1.4.2', 'X-GitHub-Api-Version': '2022-11-28' });
    assert.equal(request.init.credentials, 'omit');
    assert.equal(request.init.redirect, 'error');
    assert.equal(request.init.referrer, '');
    assert.equal(request.init.referrerPolicy, 'no-referrer');
  });

  await t.test('the network session is the in-memory partition: no permission is granted, no download starts, and only the hosts of registered features pass its filter; the default session is untouched', async () => {
    const harness = await networking(release('v1.2.1'));
    await harness.invoke('trace:check-for-updates');
    assert.equal(harness.partitions.length, 1);
    const egressSession = harness.egressSession;
    assert.notEqual(egressSession, harness.session.defaultSession);
    const answers = [];
    egressSession.permissionHandler({}, 'geolocation', (allowed) => answers.push(allowed));
    assert.deepEqual(answers, [false]);
    assert.equal(egressSession.permissionCheck({}, 'clipboard-sanitized-write'), false);
    let prevented = false;
    egressSession.emit('will-download', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    const [{ listener }] = egressSession.webRequest.listeners;
    const decide = (url) => { let decision; listener({ url }, (value) => { decision = value; }); return decision; };
    assert.deepEqual(decide('https://api.github.com/anything'), { cancel: false });
    for (const url of ['https://github.com/x', 'https://evil.example/', 'http://api.github.com/x', 'https://api.github.com:8443/x']) assert.deepEqual(decide(url), { cancel: true }, url);
    // The page's own session keeps its single policy: only the sanitized clipboard write, and this session never got it.
    assert.equal(harness.session.defaultSession.permissionRequestHandlers, 1);
    assert.equal(harness.session.defaultSession.permissionCheckHandlers, 1);
  });

  await t.test('the renderer can empty the log, and both channels ignore every argument: it cannot choose a feature, a URL or a limit', async () => {
    const harness = await networking(release('v1.2.1'));
    await harness.invoke('trace:check-for-updates');
    const evil = ['https://evil.example/', { url: 'https://evil.example/', feature: 'update-check', limit: 1, hosts: ['evil.example'] }, 42];
    const read = plain(await harness.invoke('trace:get-network-activity', ...evil));
    assert.equal(read.entries.length, 1);
    assert.equal(read.limit, 200);
    assert.deepEqual(read.features.map((feature) => feature.hosts), [['api.github.com'], require('../electron/support.cjs').FEATURE.hosts]);
    assert.equal(await harness.invoke('trace:clear-network-activity', ...evil), undefined);
    assert.deepEqual(plain(await harness.invoke('trace:get-network-activity')), { features: read.features, limit: 200, dropped: 0, entries: [] });
    assert.equal(harness.net.requests.length, 1, 'reading and clearing start no request');
    const later = (ms) => vm.runInContext(`Date.now = ((real, offset) => () => real() + offset)(Date.now, ${ms})`, harness.context);
    later(30000);
    await harness.invoke('trace:check-for-updates');
    assert.deepEqual((await activity(harness)).entries.map((entry) => entry.id), [2], 'the sequence goes on after a clear');
  });

  await t.test('the preload forwards no argument for either call, and the renderer gets plain data, never the layer', async () => {
    const preload = await fs.readFile(path.resolve(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
    const calls = [];
    let api;
    const electron = {
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke: async (channel, ...args) => { calls.push([channel, ...args]); return { features: [], entries: [], dropped: 0, limit: 200 }; }, on() {}, removeListener() {}, send() {} },
      webUtils: { getPathForFile: () => '' },
    };
    vm.runInNewContext(preload, { require: (name) => (name === 'electron' ? electron : require(name)) }, { filename: 'preload.cjs' });
    assert.equal(typeof api.getNetworkActivity, 'function');
    assert.equal(typeof api.clearNetworkActivity, 'function');
    await api.getNetworkActivity('https://evil.example/', { feature: 'x' });
    await api.clearNetworkActivity('https://evil.example/', 7);
    assert.deepEqual(calls, [['trace:get-network-activity'], ['trace:clear-network-activity']]);
    const harness = await networking(release('v1.2.1'));
    await harness.invoke('trace:check-for-updates');
    const raw = await harness.invoke('trace:get-network-activity');
    assert.deepEqual(Object.keys(raw).sort(), ['dropped', 'entries', 'features', 'limit']);
    for (const entry of raw.entries) for (const value of Object.values(entry)) assert.ok(value === null || ['string', 'number'].includes(typeof value));
  });
});

// macOS lifecycle (docs/MAC_VALIDATION.md M-03, M-04 and the native finding N-02). main.cjs reads the platform from process.platform, which the
// harness fakes through options.platform (default win32). Everything that changes behaviour is darwin-only; the Windows / Linux rows prove it did not.
// (M-01, "no application menu", was refuted natively: macOS keeps Electron's default menu, View > Reload and Toggle Developer Tools included, even
// after Menu.setApplicationMenu(null); N-02 is that menu, replaced by a minimal darwin-only template.)
test('macOS lifecycle: application menu, activate before startup finished, open-file without a window, session policy installed once', async (t) => {
  const root = await makeTempDir('trace-mac-lifecycle-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let counter = 0;
  const profile = () => path.join(root, `profile-${++counter}`);
  const boardFile = path.join(root, 'Opened.cad');
  await fs.writeFile(boardFile, '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n');
  const openEvent = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  const live = (harness) => harness.windows.filter((window) => !window.isDestroyed());
  const delivered = (harness, window = harness.window) => window.webContents.sent.filter((entry) => entry.channel === 'trace:board-opened');
  // Holds the startup chain inside loadConfig (the first read of config.json) after the app is ready: the gap in which
  // main.cjs has no IPC and no window yet. deferReady additionally keeps the app "not ready" until releaseReady().
  const gapHarness = async (platform) => {
    let hits = 0;
    const releases = [];
    const gatedFs = new Proxy(fs, { get(source, property) {
      if (property !== 'open') return source[property];
      return async (filename, ...rest) => {
        if (String(filename).endsWith('config.json') && hits++ === 0) await new Promise((resolve) => releases.push(resolve));
        return source.open(filename, ...rest);
      };
    } });
    const harness = await desktopHarness(profile(), { platform, deferReady: true, fs: gatedFs });
    return Object.assign(harness, { reachedGap: () => hits === 1, releaseGap: () => releases[0]() });
  };
  const startupDone = (harness) => settle(() => harness.handlers.has('trace:initial-board') && harness.windows.length > 0);
  const plain = (value) => JSON.parse(JSON.stringify(value)); // The harness runs main.cjs in another realm.
  // Every role in a menu template, submenus at any depth included.
  const roles = (items) => items.flatMap((item) => [...(item.role ? [item.role] : []), ...(Array.isArray(item.submenu) ? roles(item.submenu) : [])]);

  await t.test('N-02: darwin gets a minimal application menu (app, Edit, Window) without View, Reload or Developer Tools', async () => {
    const harness = await desktopHarness(profile(), { platform: 'darwin' });
    assert.equal(harness.menu.templates.length, 1, 'one template is built');
    const [template] = harness.menu.templates;
    assert.equal(harness.menu.applied.length, 1, 'the menu is set once');
    assert.equal(harness.menu.applied[0].template, template, 'the built menu is the one set');
    assert.deepEqual(plain(template.map((item) => item.label)), ['TRACE Boardviewer', 'Edit', 'Window']);
    assert.equal(template.some((item) => item.role !== undefined), false, 'no role menus at the top level: appMenu / editMenu / windowMenu would add Services, Speech and the window list');
    assert.deepEqual(plain(template.map((item) => item.submenu.map((entry) => entry.role ?? entry.type))), [
      ['about', 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit'],
      ['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'selectAll'],
      ['minimize', 'zoom', 'close'],
    ]);
    const everyRole = roles(template);
    for (const role of ['toggleDevTools', 'reload', 'forceReload', 'viewMenu', 'help', 'services', 'startSpeaking', 'stopSpeaking']) {
      assert.equal(everyRole.includes(role), false, `${role} is nowhere in the menu`);
    }
    assert.equal(template.some((item) => item.role === 'viewMenu' || /^view$/i.test(String(item.label))), false, 'no View menu at the top level');
    assert.equal(harness.windows.length, 1, 'startup is otherwise unchanged');
  });

  await t.test('N-02: Windows and Linux keep no menu bar: setApplicationMenu(null) as before, no template is built', async () => {
    for (const platform of [undefined, 'win32', 'linux']) {
      const harness = await desktopHarness(profile(), platform ? { platform } : {});
      assert.deepEqual(harness.menu.applied, [null], `${platform ?? 'default'}: the menu is cleared exactly once`);
      assert.equal(harness.menu.templates.length, 0, `${platform ?? 'default'}: nothing is built`);
      assert.equal(harness.windows.length, 1);
    }
  });

  await t.test('M-03: activate before the app is ready creates nothing; the startup chain still creates the one window', async () => {
    for (const platform of ['darwin', 'win32']) {
      const harness = await desktopHarness(profile(), { platform, deferReady: true });
      harness.app.emit('activate');
      harness.app.emit('activate');
      assert.equal(harness.windows.length, 0, `${platform}: no window before ready`);
      harness.releaseReady();
      await harness.waitForWindow();
      await startupDone(harness);
      await sleep(20);
      assert.equal(harness.windows.length, 1, `${platform}: exactly one window after normal startup`);
    }
  });

  await t.test('M-03: activate (and open-file) in the gap between ready and the first window create nothing; one window, the board arrives once', async () => {
    for (const platform of ['darwin', 'win32']) {
      const harness = await gapHarness(platform);
      harness.releaseReady();
      await settle(() => harness.reachedGap());
      assert.equal(harness.reachedGap(), true, 'startup is waiting inside loadConfig');
      harness.app.emit('activate');
      const event = openEvent();
      harness.app.emit('open-file', event, boardFile);
      assert.equal(event.prevented, true, `${platform}: open-file is still claimed`);
      assert.equal(harness.windows.length, 0, `${platform}: no window while startup has not finished`);
      assert.equal(harness.handlers.size, 0, `${platform}: no IPC yet either`);
      harness.releaseGap();
      await startupDone(harness);
      harness.app.emit('activate'); // after startup a live window exists: still nothing new
      await sleep(20);
      assert.equal(harness.windows.length, 1, `${platform}: exactly one window in total, no orphan`);
      assert.equal(live(harness).length, 1);
      await harness.invoke('trace:initial-board'); // the real renderer is now trusted and picks the board up
      await settle(() => delivered(harness).length > 0);
      await sleep(30);
      assert.deepEqual(delivered(harness).map((entry) => entry.value.name), ['Opened.cad'], `${platform}: the board is delivered once`);
    }
  });

  await t.test('M-03: after startup, activate with zero windows creates exactly one; with a window present it creates none', async () => {
    const harness = await desktopHarness(profile(), { platform: 'darwin' });
    harness.app.emit('activate');
    assert.equal(harness.windows.length, 1, 'a window exists: activate adds nothing');
    const first = harness.window;
    first.close();
    assert.equal(first.isDestroyed(), true);
    assert.equal(live(harness).length, 0);
    harness.app.emit('activate'); // the Dock icon was clicked
    assert.equal(harness.windows.length, 2);
    assert.equal(live(harness).length, 1);
    assert.notEqual(harness.window, first);
    harness.app.emit('activate');
    assert.equal(harness.windows.length, 2, 'the second activate finds the new window');
    // The new window is a working one: its renderer is trusted and gets the same startup answer.
    assert.equal(await harness.invoke('trace:initial-board'), null);
  });

  await t.test('M-03: activate while quitting never creates a window', async () => {
    const harness = await desktopHarness(profile(), { platform: 'darwin' });
    harness.app.emit('before-quit', { preventDefault() {} });
    harness.window.close();
    assert.equal(live(harness).length, 0);
    harness.app.emit('activate');
    await sleep(20);
    assert.equal(harness.windows.length, 1, 'no window appeared during the quit');
  });

  await t.test('M-04: open-file with zero windows on darwin creates one window; the board waits for its renderer and arrives once', async () => {
    const harness = await desktopHarness(profile(), { platform: 'darwin' });
    const first = harness.window;
    first.close();
    assert.equal(live(harness).length, 0);
    const event = openEvent();
    harness.app.emit('open-file', event, boardFile);
    assert.equal(event.prevented, true);
    assert.equal(harness.windows.length, 2, 'a window was created for the document');
    assert.equal(live(harness).length, 1);
    const second = harness.window;
    assert.notEqual(second, first);
    await sleep(30);
    assert.deepEqual(delivered(harness, second), [], 'nothing is sent before the new renderer asked for its startup board');
    await harness.invoke('trace:initial-board');
    await settle(() => delivered(harness, second).length > 0);
    await sleep(30);
    assert.deepEqual(delivered(harness, second).map((entry) => entry.value.name), ['Opened.cad'], 'delivered exactly once');
    assert.deepEqual(delivered(harness, first), [], 'never to the closed window');
    assert.equal(harness.windows.length, 2, 'and still only one window was created');
    assert.equal(harness.dialog.messages.length, 0);
  });

  await t.test('M-04: open-file with a window present, and before ready, creates no window (as before)', async () => {
    const harness = await desktopHarness(profile(), { platform: 'darwin' });
    await harness.invoke('trace:initial-board');
    harness.app.emit('open-file', openEvent(), boardFile);
    await settle(() => delivered(harness).length > 0);
    assert.equal(harness.windows.length, 1, 'the open window receives the board');
    assert.deepEqual(delivered(harness).map((entry) => entry.value.name), ['Opened.cad']);
    const early = await desktopHarness(profile(), { platform: 'darwin', deferReady: true });
    early.app.emit('open-file', openEvent(), boardFile);
    assert.equal(early.windows.length, 0, 'before ready the path only becomes the startup board');
    early.releaseReady();
    await early.waitForWindow();
    assert.equal((await early.invoke('trace:initial-board')).startupSource, 'argument');
    assert.equal(early.windows.length, 1);
  });

  await t.test('M-04: open-file while quitting creates no window', async () => {
    const harness = await desktopHarness(profile(), { platform: 'darwin' });
    harness.app.emit('before-quit', { preventDefault() {} });
    harness.window.close();
    harness.app.emit('open-file', openEvent(), boardFile);
    await sleep(20);
    assert.equal(harness.windows.length, 1);
    assert.equal(live(harness).length, 0);
  });

  await t.test('M-04: off darwin an open-file with no window never creates one (Windows and Linux unchanged)', async () => {
    for (const platform of [undefined, 'win32', 'linux']) {
      const harness = await desktopHarness(profile(), platform ? { platform } : {});
      harness.window.close();
      assert.equal(live(harness).length, 0);
      const event = openEvent();
      harness.app.emit('open-file', event, boardFile);
      assert.equal(event.prevented, true);
      await sleep(20);
      assert.equal(harness.windows.length, 1, `${platform ?? 'default'}: no window was created`);
      assert.deepEqual(delivered(harness), []);
    }
  });

  await t.test('no regression: exactly one window after normal startup on every platform, even with an early activate', async () => {
    for (const platform of [undefined, 'win32', 'linux', 'darwin']) {
      const harness = await desktopHarness(profile(), { deferReady: true, ...(platform ? { platform } : {}) });
      harness.app.emit('activate');
      harness.releaseReady();
      await harness.waitForWindow();
      await startupDone(harness);
      harness.app.emit('activate');
      await sleep(20);
      assert.equal(harness.windows.length, 1, `${platform ?? 'default'}: one window`);
      assert.equal(live(harness).length, 1);
      assert.equal(harness.app.quitCount, 0);
    }
  });

  await t.test('H1-06: the session policy (permissions, no downloads) is installed once on the default session, never again per window', async () => {
    const harness = await desktopHarness(profile(), { platform: 'darwin' });
    const { defaultSession } = harness.session;
    const installed = () => [defaultSession.listenerCount('will-download'), defaultSession.permissionRequestHandlers, defaultSession.permissionCheckHandlers];
    assert.deepEqual(installed(), [1, 1, 1], 'installed once with the IPC');
    for (let round = 0; round < 3; round++) {
      harness.window.close();
      harness.app.emit('activate'); // the Dock icon: a new window on the same session
    }
    assert.equal(harness.windows.length, 4);
    assert.deepEqual(installed(), [1, 1, 1], 'a window created again adds nothing');
    // The one policy follows the current window: the sanitized clipboard write is granted to it and to nothing else.
    const { window } = harness;
    const details = { requestingUrl: window.webContents.mainFrame.url, isMainFrame: true };
    assert.equal(defaultSession.permissionCheck(window.webContents, 'clipboard-sanitized-write', 'file://', details), true);
    assert.equal(defaultSession.permissionCheck(window.webContents, 'clipboard-read', 'file://', details), false);
    assert.equal(defaultSession.permissionCheck(harness.windows[0].webContents, 'clipboard-sanitized-write', 'file://', details), false, 'a closed window is not the main window');
    let granted = true;
    defaultSession.permissionHandler(window.webContents, 'notifications', (value) => { granted = value; }, details);
    assert.equal(granted, false);
    let blocked = false;
    defaultSession.emit('will-download', { preventDefault() { blocked = true; } });
    assert.equal(blocked, true, 'downloads stay blocked on the shared session');
  });
});

// Renderer and window lifecycle (H1-01, H1-02, H1-03). The harness raises the webContents events a real renderer crash or hang
// would raise, plays the timer of the fallback show by hand (options.timers) and hands main.cjs the argument vector of a second
// instance exactly as Electron delivers it.
test('renderer and window lifecycle: a gone or hung renderer, a window that never paints, a second launch and reordered switches', async (t) => {
  const root = await makeTempDir('trace-window-lifecycle-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let counter = 0;
  const profile = async () => { const directory = path.join(root, `profile-${++counter}`); await fs.mkdir(directory, { recursive: true }); return directory; };
  const validText = '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n';
  const boardFile = path.join(root, 'Opened.cad');
  await fs.writeFile(boardFile, validText);
  const other = path.join(root, 'Other.cad');
  await fs.writeFile(other, `${validText}\n`);
  const delivered = (harness, window = harness.window) => window.webContents.sent.filter((entry) => entry.channel === 'trace:board-opened').map((entry) => entry.value.name);
  const gone = (window, reason = 'crashed') => window.webContents.emit('render-process-gone', {}, { reason, exitCode: reason === 'clean-exit' ? 0 : 1 });
  // Fake timers for main.cjs only (the harness and the store keep the real ones): every scheduled callback is recorded with its
  // delay, `fire(ms)` runs the pending ones of that delay.
  const fakeTimers = () => {
    const pending = [];
    return {
      pending,
      timers: {
        setTimeout: (callback, ms) => { const timer = { callback, ms, cleared: false, fired: false }; pending.push(timer); return timer; },
        clearTimeout: (timer) => { if (timer) timer.cleared = true; },
      },
      fire(ms) { for (const timer of pending) if (timer.ms === ms && !timer.cleared && !timer.fired) { timer.fired = true; timer.callback(); } },
    };
  };

  await t.test('H1-01: a renderer that is gone gets one error dialog in the current language, then the page is loaded again with the start-up state reset', async () => {
    const harness = await desktopHarness(await profile());
    const { window } = harness;
    assert.equal(await harness.invoke('trace:initial-board'), null, 'the start-up answer of the first renderer (no recents yet) is cached');
    const payload = await harness.invoke('trace:read-board', boardFile);
    await harness.invoke('trace:accept-board', payload.path, payload.key);
    assert.equal(window.loadCount, 1);
    gone(window);
    assert.equal(harness.dialog.messages.length, 1);
    const [box] = harness.dialog.messages;
    assert.equal(box.type, 'error');
    assert.equal(box.title, 'TRACE Boardviewer');
    assert.equal(box.message, i18n.translate('hu', 'native.dialog.rendererGone'));
    await settle(() => window.loadCount === 2);
    assert.equal(window.loadCount, 2, 'the page is loaded again once the dialog is answered');
    assert.equal(window.isDestroyed(), false);
    // The renderer is not ready until the new page announces itself: an external open waits (pendingBoardPath) instead of being
    // sent to a page that is still loading.
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', `--board=${other}`]);
    await sleep(30);
    assert.deepEqual(delivered(harness), [], 'nothing is sent to the reloading page');
    const restored = await harness.invoke('trace:initial-board');
    assert.equal(restored.name, 'Opened.cad', 'the start-up answer is computed afresh: the board accepted before the crash');
    assert.equal(restored.startupSource, 'recent');
    await settle(() => delivered(harness).length > 0);
    assert.deepEqual(delivered(harness), ['Other.cad'], 'the external open that waited is delivered to the new renderer');
    assert.equal(harness.app.quitCount, 0);
  });

  await t.test('H1-01: a clean exit, a quit in progress and a window that is no longer the main window are not failures', async () => {
    const clean = await desktopHarness(await profile());
    gone(clean.window, 'clean-exit');
    await sleep(10);
    assert.equal(clean.dialog.messages.length, 0);
    assert.equal(clean.window.loadCount, 1);
    const quitting = await desktopHarness(await profile());
    quitting.app.emit('before-quit', { preventDefault() {} });
    gone(quitting.window);
    await sleep(10);
    assert.equal(quitting.dialog.messages.length, 0);
    assert.equal(quitting.window.loadCount, 1);
    const replaced = await desktopHarness(await profile(), { platform: 'darwin' });
    const first = replaced.window;
    first.close();
    replaced.app.emit('activate');
    assert.notEqual(replaced.window, first);
    gone(first);
    await sleep(10);
    assert.equal(replaced.dialog.messages.length, 0);
    assert.equal(first.loadCount, 1);
    assert.equal(replaced.window.loadCount, 1);
  });

  await t.test('H1-01: a hung renderer offers Wait and Close; Wait keeps the window, Close closes it without the flush it could not answer', async () => {
    const harness = await desktopHarness(await profile());
    const { window } = harness;
    await harness.invoke('trace:initial-board'); // a live renderer: a close would normally wait for its flush
    harness.dialog.response = 0;
    window.webContents.emit('unresponsive');
    assert.equal(harness.dialog.messages.length, 1);
    const [asked] = harness.dialog.messages;
    assert.equal(asked.type, 'warning');
    assert.equal(asked.title, 'TRACE Boardviewer');
    assert.equal(asked.message, i18n.translate('hu', 'native.dialog.unresponsive'));
    assert.deepEqual(Array.from(asked.buttons), [i18n.translate('hu', 'native.dialog.unresponsiveWait'), i18n.translate('hu', 'native.dialog.unresponsiveClose')]);
    assert.equal(asked.defaultId, 0);
    assert.equal(asked.cancelId, 0, 'Esc means Wait');
    window.webContents.emit('unresponsive');
    assert.equal(harness.dialog.messages.length, 1, 'one dialog per hang');
    await sleep(10);
    assert.equal(window.isDestroyed(), false, 'Wait keeps the window');
    harness.dialog.response = 1;
    window.webContents.emit('unresponsive');
    assert.equal(harness.dialog.messages.length, 2, 'a new hang asks again');
    await settle(() => window.isDestroyed());
    assert.equal(window.isDestroyed(), true, 'Close closes the window');
    assert.equal(window.closeEvents, 1, 'closed at the first close event');
    assert.deepEqual(window.webContents.sent.filter((entry) => entry.channel === 'trace:flush-request'), [], 'a hung renderer is not asked to flush');
    // A renderer that recovered while the dialog was open is flushed like any other close.
    const recovered = await desktopHarness(await profile());
    await recovered.invoke('trace:initial-board');
    let flushRequests = 0;
    recovered.window.webContents.onSend = (channel, id) => { if (channel === 'trace:flush-request') { flushRequests++; recovered.message('trace:flush-done', id); } };
    let answer;
    recovered.dialog.answer = () => new Promise((resolve) => { answer = resolve; });
    recovered.window.webContents.emit('unresponsive');
    recovered.window.webContents.emit('responsive');
    answer({ response: 1, checkboxChecked: false });
    await settle(() => recovered.window.isDestroyed());
    assert.equal(recovered.window.isDestroyed(), true);
    assert.equal(flushRequests, 1, 'the recovered renderer wrote its pending state first');
    assert.equal(recovered.window.closeEvents, 2, 'held back once for the flush, then closed');
  });

  await t.test('H1-02: a window that never reports ready-to-show is shown after 4 s; ready-to-show cancels the fallback and shows at once', async () => {
    const clock = fakeTimers();
    const harness = await desktopHarness(await profile(), { timers: clock.timers });
    const { window } = harness;
    assert.equal(window.showCount ?? 0, 0, 'hidden until the page paints or the fallback fires');
    assert.equal(clock.pending.filter((timer) => timer.ms === 4000).length, 1, 'one fallback timer per window');
    clock.fire(4000);
    assert.equal(window.showCount, 1, 'shown without ready-to-show');
    assert.equal(window.isVisible(), true);
    window.emit('ready-to-show');
    assert.equal(window.showCount, 1, 'a window that is already visible is not shown again');
    const ready = fakeTimers();
    const painted = await desktopHarness(await profile(), { timers: ready.timers });
    painted.window.emit('ready-to-show');
    assert.equal(painted.window.showCount, 1);
    assert.equal(ready.pending.find((timer) => timer.ms === 4000).cleared, true, 'ready-to-show cancels the fallback');
    ready.fire(4000);
    assert.equal(painted.window.showCount, 1);
  });

  await t.test('H1-02: the fallback never shows a window of a quitting app, a closed window or a window that was replaced', async () => {
    const quitting = fakeTimers();
    const quit = await desktopHarness(await profile(), { timers: quitting.timers });
    quit.app.emit('before-quit', { preventDefault() {} });
    quitting.fire(4000);
    assert.equal(quit.window.showCount ?? 0, 0, 'a quitting app shows nothing');
    const closing = fakeTimers();
    const closed = await desktopHarness(await profile(), { timers: closing.timers });
    closed.window.close();
    assert.equal(closing.pending.find((timer) => timer.ms === 4000).cleared, true, 'closing the window clears its timer');
    closing.fire(4000);
    assert.equal(closed.window.showCount ?? 0, 0);
    const replacing = fakeTimers();
    const replaced = await desktopHarness(await profile(), { platform: 'darwin', timers: replacing.timers });
    const first = replaced.window;
    first.close();
    replaced.app.emit('activate');
    assert.notEqual(replaced.window, first);
    assert.equal(replacing.pending.filter((timer) => timer.ms === 4000).length, 2, 'the new window has its own fallback');
    replacing.fire(4000);
    assert.equal(first.showCount ?? 0, 0);
    assert.equal(replaced.window.showCount, 1, 'only the current window is shown');
  });

  await t.test('H1-02: a second launch shows a window that is not visible yet before focusing it; a visible one is only focused, a minimized one restored', async () => {
    const harness = await desktopHarness(await profile());
    const { window } = harness;
    harness.app.emit('second-instance', {}, ['electron.exe', 'app']);
    assert.deepEqual(window.calls, ['show', 'focus']);
    harness.app.emit('second-instance', {}, ['electron.exe', 'app']);
    assert.deepEqual(window.calls, ['show', 'focus', 'focus']);
    window.minimized = true;
    harness.app.emit('second-instance', {}, ['electron.exe', 'app']);
    assert.deepEqual(window.calls.slice(3), ['restore', 'focus']);
    assert.equal(harness.dialog.messages.length, 0);
    assert.deepEqual(delivered(harness), []);
  });

  await t.test('H1-03: "--board <path>" handed to a running instance still opens the path after Chromium moved the switch in front of its own', async () => {
    const harness = await desktopHarness(await profile());
    await harness.invoke('trace:initial-board');
    // The argument vector of a second instance as Electron 44 delivers it on Windows: the bare switch first, Chromium's own switches
    // next, the positional path last. The value of --board is never a switch; the path is found as the bare argument.
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', '--board', '--allow-file-access-from-files', '--source-app-id', 'C:\\app', boardFile]);
    await settle(() => delivered(harness).length > 0);
    assert.deepEqual(delivered(harness), ['Opened.cad']);
    assert.equal(harness.dialog.messages.length, 0, 'no "invalid path" dialog for the switch that followed --board');
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', '--board', other]); // the space form in its plain order
    await settle(() => delivered(harness).length > 1);
    assert.deepEqual(delivered(harness), ['Opened.cad', 'Other.cad']);
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', `--board=${boardFile}`]);
    await settle(() => delivered(harness).length > 2);
    assert.deepEqual(delivered(harness), ['Opened.cad', 'Other.cad', 'Opened.cad']);
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', '--board']); // nothing follows: nothing to open
    await sleep(30);
    assert.equal(delivered(harness).length, 3);
    assert.equal(harness.dialog.messages.length, 0);
  });
});

// The start-up file and the settings file (H1-08, H1-05).
test('start-up file and settings file: a failed start-up argument falls through to the recents; an unreadable config.json is kept as a backup', async (t) => {
  const root = await makeTempDir('trace-startup-config-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const plain = (value) => JSON.parse(JSON.stringify(value)); // The harness runs main.cjs in another realm.
  let counter = 0;
  const profile = async (config) => {
    const directory = path.join(root, `profile-${++counter}`);
    await fs.mkdir(directory, { recursive: true });
    if (config !== undefined) await fs.writeFile(path.join(directory, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config, null, 2));
    return directory;
  };
  const validText = '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n';
  const boardFile = path.join(root, 'Opened.cad');
  await fs.writeFile(boardFile, validText);
  const other = path.join(root, 'Other.cad');
  await fs.writeFile(other, `${validText}\n`);
  const missing = path.join(root, 'missing.cad');
  const settings = { language: 'en', theme: 'dark', layout: 'workshop', motion: true, showLabels: true, showConnections: true, updateCheck: true };
  const recent = (filename) => ({ name: path.basename(filename), path: filename, openedAt: '2026-01-02T03:04:05.000Z' });
  const opened = (harness) => harness.window.webContents.sent.filter((entry) => entry.channel === 'trace:board-opened').map((entry) => entry.value);
  const backups = async (directory) => (await fs.readdir(directory)).filter((name) => name.startsWith('config.json.bak-')).sort();

  await t.test('H1-08: a start-up file that cannot be read rejects once; the last readable board follows over trace:board-opened and the next call restores the recents', async () => {
    const directory = await profile({ version: 1, settings, recentBoards: [recent(path.join(root, 'Gone.cad')), recent(boardFile)] });
    const harness = await desktopHarness(directory, { argv: [missing] });
    await assert.rejects(harness.invoke('trace:initial-board'), { message: i18n.translate('en', 'native.error.boardNotFound') });
    await settle(() => opened(harness).length > 0);
    const [restored] = opened(harness);
    assert.equal(restored.name, 'Opened.cad', 'the first recent is gone and skipped, the second is delivered');
    assert.equal(restored.startupSource, 'recent');
    assert.equal(restored.key, sha256(validText));
    assert.equal(harness.dialog.messages.length, 0, 'a recent that is gone opens no dialog');
    const again = await harness.invoke('trace:initial-board');
    assert.equal(again.name, 'Opened.cad', 'the forgotten start-up file no longer blocks the recents');
    assert.equal(again.startupSource, 'recent');
    await sleep(30);
    assert.equal(opened(harness).length, 1, 'delivered once');
  });

  await t.test('H1-08: without a readable recent the start screen stays; a newer open supersedes the fallback before it is sent', async () => {
    const empty = await desktopHarness(await profile(), { argv: [missing] });
    await assert.rejects(empty.invoke('trace:initial-board'), { message: i18n.translate('hu', 'native.error.boardNotFound') });
    await sleep(30);
    assert.deepEqual(opened(empty), []);
    assert.equal(await empty.invoke('trace:initial-board'), null, 'the next call tries the (empty) recents instead of the file');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const delayedFs = new Proxy(fs, { get(target, property) {
      if (property === 'realpath') return async (filename) => { if (filename === boardFile) await gate; return target.realpath(filename); };
      return target[property];
    } });
    const raced = await desktopHarness(await profile({ version: 1, settings, recentBoards: [recent(boardFile)] }), { argv: [missing], fs: delayedFs });
    await assert.rejects(raced.invoke('trace:initial-board'), { message: i18n.translate('en', 'native.error.boardNotFound') });
    const read = await raced.invoke('trace:read-board', other); // a renderer intent while the recent is still being read
    assert.equal(read.name, 'Other.cad');
    release();
    await sleep(30);
    assert.deepEqual(opened(raced), [], 'the superseded fallback never reaches the renderer');
  });

  await t.test('H1-05: a config.json written by another version is kept as config.json.bak-<timestamp> before the first write', async () => {
    const future = JSON.stringify({ version: 2, settings: { ...settings, language: 'de', theme: 'light', newField: 'kept' }, recentBoards: [recent(boardFile)], pinnedBoards: [boardFile] }, null, 2);
    const directory = await profile(future);
    const harness = await desktopHarness(directory, { systemLanguages: ['fr-FR'] });
    assert.equal((await harness.invoke('trace:get-settings')).language, 'hu', 'an unreadable file is an existing profile with defaults');
    assert.deepEqual(await fs.readdir(directory), ['config.json'], 'nothing is written or moved before the first write');
    await harness.invoke('trace:save-settings', { ...plain(await harness.invoke('trace:get-settings')), theme: 'system' });
    const [backup, ...more] = await backups(directory);
    assert.ok(backup, 'a backup exists');
    assert.deepEqual(more, []);
    assert.match(backup, /^config\.json\.bak-\d{8}T\d{6}Z$/);
    assert.equal(await fs.readFile(path.join(directory, backup), 'utf8'), future, 'the old file is kept byte for byte');
    const written = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
    assert.equal(written.version, 1);
    assert.equal(written.settings.theme, 'system');
    await harness.invoke('trace:save-settings', { ...plain(await harness.invoke('trace:get-settings')), theme: 'dark' });
    assert.equal((await backups(directory)).length, 1, 'one backup per unreadable file, not per write');
    const reopened = await desktopHarness(directory);
    assert.equal((await reopened.invoke('trace:get-settings')).theme, 'dark', 'the version-1 file is readable');
    await reopened.invoke('trace:save-settings', { ...plain(await reopened.invoke('trace:get-settings')), motion: false });
    assert.equal((await backups(directory)).length, 1, 'a readable file is never backed up');
  });

  await t.test('H1-05: a damaged config.json is kept the same way; a readable one gets no backup; a failed rename does not block the write', async () => {
    const damaged = `{"version":1,"settings":{"theme":"light","language":"de"},"recentBoards":[{"path":${JSON.stringify(boardFile)}`;
    const directory = await profile(damaged);
    const harness = await desktopHarness(directory);
    assert.equal((await harness.invoke('trace:recent-boards')).length, 0);
    await harness.invoke('trace:save-settings', { ...plain(await harness.invoke('trace:get-settings')), layout: 'focus' });
    const [backup] = await backups(directory);
    assert.match(backup, /^config\.json\.bak-\d{8}T\d{6}Z$/);
    assert.equal(await fs.readFile(path.join(directory, backup), 'utf8'), damaged);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).settings.layout, 'focus');
    assert.deepEqual((await fs.readdir(directory)).sort(), ['config.json', backup].sort(), 'no temporary file is left behind');
    const sound = await profile({ version: 1, settings, recentBoards: [] });
    const readable = await desktopHarness(sound);
    await readable.invoke('trace:save-settings', { ...plain(await readable.invoke('trace:get-settings')), theme: 'light' });
    assert.deepEqual(await fs.readdir(sound), ['config.json']);
    // The backup is best effort: a rename that fails (another handle on the file) costs the backup, never the settings write.
    const stuck = await profile('{ this is not json');
    const failingFs = new Proxy(fs, { get(target, property) {
      if (property === 'rename') return async (from, to) => { if (String(to).includes('config.json.bak-')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return target.rename(from, to); };
      return target[property];
    } });
    const unlucky = await desktopHarness(stuck, { fs: failingFs });
    await unlucky.invoke('trace:save-settings', { ...plain(await unlucky.invoke('trace:get-settings')), theme: 'light' });
    assert.deepEqual(await fs.readdir(stuck), ['config.json']);
    assert.equal(JSON.parse(await fs.readFile(path.join(stuck, 'config.json'), 'utf8')).settings.theme, 'light');
  });
});

// The Linux desktop shell. The harness fakes the platform for main.cjs only; paths, URLs and files stay those of the machine that runs the
// tests, so a "linux" harness on Windows resolves Windows paths. What is asserted is the decision main.cjs takes for each platform.
test('Linux desktop shell: pinned profile directory', async (t) => {
  const root = await makeTempDir('trace-linux-shell-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  let counter = 0;
  const profile = async () => { const directory = path.join(root, `profile-${++counter}`); await fs.mkdir(directory, { recursive: true }); return directory; };
  const plain = (value) => JSON.parse(JSON.stringify(value)); // The harness runs main.cjs in another realm.

  await t.test('linux without --user-data-dir pins userData to <appData>/trace-boardviewer before the app is ready and creates it', async () => {
    const appData = path.join(root, 'xdg-config');
    const harness = await desktopHarness(await profile(), { platform: 'linux', appData, deferReady: true });
    const pinned = path.join(appData, 'trace-boardviewer');
    assert.deepEqual(plain(harness.app.pathsSet), [{ name: 'userData', value: pinned, ready: false }]);
    assert.equal((await fs.stat(pinned)).isDirectory(), true, 'the directory exists before Electron is told about it');
    if (process.platform !== 'win32') assert.equal((await fs.stat(pinned)).mode & 0o777, 0o700, 'private to the user, like the profile Chromium creates');
    harness.releaseReady();
    await harness.waitForWindow();
    assert.equal(harness.app.pathsSet.length, 1, 'set once, never moved later');
  });

  await t.test('an explicit --user-data-dir wins on linux and is the only path set, as on every platform', async () => {
    for (const platform of ['linux', 'win32', 'darwin']) {
      const explicit = path.join(root, `explicit-${platform}`);
      const harness = await desktopHarness(await profile(), { platform, appData: path.join(root, `unused-${platform}`), argv: [`--user-data-dir=${explicit}`] });
      assert.deepEqual(plain(harness.app.pathsSet).map(({ name, value }) => ({ name, value })), [{ name: 'userData', value: explicit }], platform);
      await assert.rejects(fs.stat(path.join(root, `unused-${platform}`)), { code: 'ENOENT' }, `${platform}: nothing is created under appData`);
    }
  });

  await t.test('windows and macOS keep the default location: no path is set without --user-data-dir', async () => {
    for (const platform of [undefined, 'win32', 'darwin']) {
      const appData = path.join(root, `default-${platform ?? 'none'}`);
      const harness = await desktopHarness(await profile(), { appData, ...(platform ? { platform } : {}) });
      assert.deepEqual(plain(harness.app.pathsSet), [], platform ?? 'default');
      await assert.rejects(fs.stat(appData), { code: 'ENOENT' });
    }
  });
});

test('Linux desktop shell: file:// URIs and relative paths as launch arguments, first start and second instance', async (t) => {
  const root = await makeTempDir('trace-linux-arguments-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let counter = 0;
  const profile = async () => { const directory = path.join(root, `profile-${++counter}`); await fs.mkdir(directory, { recursive: true }); return directory; };
  const validText = '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n';
  const boards = path.join(root, 'boards');
  await fs.mkdir(path.join(boards, 'sub'), { recursive: true });
  const launch = path.join(boards, 'Launch.cad');
  const spaced = path.join(boards, 'With Space #1.cad'); // a space and a "#" are percent-encoded in the URI
  const nested = path.join(boards, 'sub', 'Rel.brd');
  for (const file of [launch, spaced]) await fs.writeFile(file, validText);
  await fs.writeFile(nested, 'str_length:\n');
  const uri = (file) => pathToFileURL(file).href;
  const localhostUri = (file) => uri(file).replace(/^file:\/\//, 'file://localhost');
  const delivered = (harness) => harness.window.webContents.sent.filter((entry) => entry.channel === 'trace:board-opened').map((entry) => entry.value.name);
  const startup = async (platform, argv, extra = {}) => {
    const harness = await desktopHarness(await profile(), { platform, argv, ...extra });
    const result = await harness.invoke('trace:initial-board').then((value) => value && { name: value.name, source: value.startupSource }, (error) => ({ error: error.message }));
    return { harness, result };
  };
  const invalidPath = i18n.translate('hu', 'native.error.invalidPath');

  await t.test('linux, first start: a local file:// URI (empty host or localhost, percent-encoded) opens the board', async () => {
    assert.deepEqual((await startup('linux', [uri(launch)])).result, { name: 'Launch.cad', source: 'argument' });
    assert.ok(uri(spaced).includes('%20') && uri(spaced).includes('%23'), 'the URI really carries encoded characters');
    assert.deepEqual((await startup('linux', [uri(spaced)])).result, { name: 'With Space #1.cad', source: 'argument' });
    assert.deepEqual((await startup('linux', [localhostUri(launch)])).result, { name: 'Launch.cad', source: 'argument' });
    assert.deepEqual((await startup('linux', ['--board', uri(nested)])).result, { name: 'Rel.brd', source: 'argument' }, '--board <uri>');
    assert.deepEqual((await startup('linux', [`--board=${uri(launch)}`])).result, { name: 'Launch.cad', source: 'argument' }, '--board=<uri>');
  });

  await t.test('linux, first start: a relative path is resolved against the working directory of the launch', async () => {
    assert.deepEqual((await startup('linux', [path.join('sub', 'Rel.brd')], { cwd: boards })).result, { name: 'Rel.brd', source: 'argument' });
    assert.deepEqual((await startup('linux', ['Launch.cad'], { cwd: boards })).result, { name: 'Launch.cad', source: 'argument' });
    assert.deepEqual((await startup('linux', [`--board=${path.join('sub', 'Rel.brd')}`], { cwd: boards })).result, { name: 'Rel.brd', source: 'argument' });
    assert.deepEqual((await startup('linux', ['--board', 'Launch.cad'], { cwd: boards })).result, { name: 'Launch.cad', source: 'argument' });
  });

  await t.test('linux: URIs of another host or scheme, unsupported files and switches are ignored without a dialog; a --board value that names no local file is reported', async () => {
    const remote = uri(launch).replace(/^file:\/\//, 'file://fileserver');
    const ignored = [[remote], ['https://example.com/Launch.cad'], ['smb://fileserver/share/Launch.cad'], ['sftp://host/Launch.cad'], ['notes.unsupported'], ['--some-switch=Launch.cad'], ['-x', 'Launch.unsupported']];
    for (const argv of ignored) {
      const { harness, result } = await startup('linux', argv, { cwd: boards });
      assert.equal(result, null, `${argv.join(' ')}: nothing is opened`);
      assert.equal(harness.dialog.messages.length, 0);
    }
    for (const value of [remote, 'https://example.com/Launch.cad']) {
      assert.deepEqual((await startup('linux', [`--board=${value}`], { cwd: boards })).result, { error: invalidPath }, `--board=${value}: the usual invalid-path error`);
    }
  });

  await t.test('linux, second instance: URIs and paths relative to the working directory of the SECOND instance reach the running window', async () => {
    const harness = await desktopHarness(await profile(), { platform: 'linux', cwd: path.join(boards, 'sub') });
    await harness.invoke('trace:initial-board');
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', uri(spaced)], root);
    await settle(() => delivered(harness).length >= 1);
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', 'Launch.cad'], boards); // exists in boards/, not in sub/ (the first instance's directory)
    await settle(() => delivered(harness).length >= 2);
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', '--board', path.join('sub', 'Rel.brd')], boards);
    await settle(() => delivered(harness).length >= 3);
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', localhostUri(launch)], path.parse(root).root);
    await settle(() => delivered(harness).length >= 4);
    assert.deepEqual(delivered(harness), ['With Space #1.cad', 'Launch.cad', 'Rel.brd', 'Launch.cad']);
    assert.equal(harness.dialog.messages.length, 0);
    // Without a usable working directory a relative path cannot be resolved: nothing is opened and nothing is reported.
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', 'Launch.cad']);
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', 'Launch.cad'], 'relative-directory');
    harness.app.emit('second-instance', {}, ['electron.exe', 'app', 'https://example.com/Launch.cad'], boards);
    await sleep(40);
    assert.equal(delivered(harness).length, 4);
    assert.equal(harness.dialog.messages.length, 0);
  });

  await t.test('windows and macOS are unchanged: no URIs, no relative paths; an explicit --board value is checked as before', async () => {
    for (const platform of ['win32', 'darwin']) {
      for (const argv of [[uri(launch)], [localhostUri(launch)], ['Launch.cad'], [path.join('sub', 'Rel.brd')]]) {
        const { harness, result } = await startup(platform, argv, { cwd: boards });
        assert.equal(result, null, `${platform} ${argv[0]}: ignored as before`);
        assert.equal(harness.dialog.messages.length, 0);
      }
      for (const value of [uri(launch), 'Launch.cad']) {
        assert.deepEqual((await startup(platform, [`--board=${value}`], { cwd: boards })).result, { error: invalidPath }, `${platform} --board=${value}`);
      }
      assert.deepEqual((await startup(platform, [launch], { cwd: boards })).result, { name: 'Launch.cad', source: 'argument' }, `${platform}: an absolute path still opens`);
      const running = await desktopHarness(await profile(), { platform, cwd: boards });
      await running.invoke('trace:initial-board');
      running.app.emit('second-instance', {}, ['electron.exe', 'app', 'Launch.cad'], boards);
      running.app.emit('second-instance', {}, ['electron.exe', 'app', uri(launch)], boards);
      await sleep(40);
      assert.deepEqual(delivered(running), [], `${platform}: a second instance with a relative path or a URI opens nothing`);
      running.app.emit('second-instance', {}, ['electron.exe', 'app', launch], boards);
      await settle(() => delivered(running).length >= 1);
      assert.deepEqual(delivered(running), ['Launch.cad']);
      assert.equal(running.dialog.messages.length, 0);
    }
  });
});

test('Linux desktop shell: window icon', async (t) => {
  const root = await makeTempDir('trace-linux-icon-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  let counter = 0;
  const profile = async () => { const directory = path.join(root, `profile-${++counter}`); await fs.mkdir(directory, { recursive: true }); return directory; };
  const plain = (value) => JSON.parse(JSON.stringify(value)); // The harness runs main.cjs in another realm.
  const asset = (name) => path.resolve(__dirname, '..', 'assets', name);

  await t.test('windows and macOS keep the ICO path; no image is decoded', async () => {
    for (const platform of [undefined, 'win32', 'darwin']) {
      const harness = await desktopHarness(await profile(), platform ? { platform } : {});
      assert.equal(harness.window.options.icon, asset('icon.ico'), platform ?? 'default');
      assert.deepEqual(harness.nativeImage.created, []);
    }
  });

  await t.test('linux: a 256 px image decoded from the PNG (ICO is a Windows format)', async () => {
    const harness = await desktopHarness(await profile(), { platform: 'linux' });
    assert.deepEqual(plain(harness.window.options.icon), { resizedFrom: asset('icon.png'), size: { width: 256, height: 256, quality: 'best' } });
    assert.deepEqual(harness.nativeImage.created, [asset('icon.png')]);
    const png = await fs.readFile(asset('icon.png'));
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
    assert.ok(png.readUInt32BE(16) >= 256 && png.readUInt32BE(16) === png.readUInt32BE(20), 'a square source of at least 256 px: the resize only shrinks it');
  });

  await t.test('linux: an image that cannot be decoded leaves the option unset; the window is still created', async () => {
    const harness = await desktopHarness(await profile(), { platform: 'linux', emptyImages: true });
    assert.equal(harness.window.options.icon, undefined);
    assert.equal(harness.windows.length, 1);
  });
});

// The Linux sandbox gate (main.cjs confirmUnsandboxedStart): a process started without Chromium's OS sandbox asks before anything else
// happens. Chromium's command line is the harness's app.commandLine; the start-up answers come from options.dialogResponse/dialogAnswer.
test('Linux desktop shell: the question before starting without the Chromium sandbox', async (t) => {
  const root = await makeTempDir('trace-linux-sandbox-gate-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  let counter = 0;
  const profile = async (config) => {
    const directory = path.join(root, `profile-${++counter}`);
    await fs.mkdir(directory, { recursive: true });
    if (config !== undefined) await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
    return directory;
  };
  const plain = (value) => JSON.parse(JSON.stringify(value)); // The harness runs main.cjs in another realm.
  const readConfig = async (directory) => JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
  const hasConfig = async (directory) => (await fs.readdir(directory)).includes('config.json');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A console whose warnings are recorded (main.cjs writes the no-sandbox line with console.warn, i.e. to stderr).
  const recorder = () => {
    const warnings = [];
    return { warnings, console: Object.assign(Object.create(console), { warn: (...parts) => warnings.push(parts.join(' ')) }) };
  };
  const WARNING = 'TRACE: running without the Chromium sandbox (--no-sandbox).';
  const box = (language) => {
    const text = (key) => i18n.translate(language, key);
    return {
      type: 'warning', title: 'TRACE Boardviewer', noLink: true, defaultId: 0, cancelId: 0,
      buttons: [text('native.dialog.noSandboxQuit'), text('native.dialog.noSandboxStart')],
      checkboxLabel: text('native.dialog.noSandboxRemember'), checkboxChecked: false,
      message: text('native.dialog.noSandboxMessage'),
      detail: `${text('native.dialog.noSandboxRisk')}\n\n${text('native.dialog.noSandboxAdvice')}`,
    };
  };
  const settings = { language: 'de', theme: 'light', layout: 'focus', motion: false, showLabels: true, showConnections: false, updateCheck: false };

  await t.test('linux with --no-sandbox: one warning box before any window or IPC; Quit (the default, also Esc and closing) ends the start-up and stores nothing', async () => {
    const directory = await profile();
    const log = recorder();
    let seen = null;
    const harness = await desktopHarness(directory, { platform: 'linux', argv: ['--no-sandbox'], deferReady: true, console: log.console });
    // Quit with the checkbox ticked: "Do not ask again" only applies to starting without the sandbox.
    harness.dialog.answer = () => { seen = { windows: harness.windows.length, handlers: harness.handlers.size, menus: harness.menu.applied.length }; return { response: 0, checkboxChecked: true }; };
    harness.releaseReady();
    await settle(() => harness.app.quitCount > 0);
    assert.equal(harness.app.quitCount, 1, 'the app quits');
    assert.equal(harness.dialog.messages.length, 1, 'one question');
    assert.deepEqual(plain(harness.dialog.messages[0]), box('hu'), 'a fresh profile asks in the system language (hu-HU here)');
    assert.deepEqual(harness.dialog.parents, [null], 'no parent window: none exists yet');
    assert.deepEqual(seen, { windows: 0, handlers: 0, menus: 0 }, 'asked before the menu, the IPC and the window');
    await sleep(30);
    assert.equal(harness.windows.length, 0, 'no window is ever created');
    assert.equal(harness.handlers.size, 0, 'no IPC is installed');
    assert.equal(await hasConfig(directory), false, 'nothing is written');
    assert.deepEqual(log.warnings, [WARNING], 'the warning line is written once');
    // Any answer but "Start without sandbox" is a Quit.
    for (const answer of [{ response: 2, checkboxChecked: false }, { response: -1 }, undefined]) {
      const other = await desktopHarness(await profile(), { platform: 'linux', argv: ['--no-sandbox'], noWindow: true, dialogAnswer: () => answer });
      await settle(() => other.app.quitCount > 0);
      assert.equal(other.app.quitCount, 1, JSON.stringify(answer));
      assert.equal(other.windows.length, 0);
    }
  });

  await t.test('Start without sandbox opens the window; without the checkbox nothing is stored and the next start asks again', async () => {
    const directory = await profile();
    const first = await desktopHarness(directory, { platform: 'linux', argv: ['--no-sandbox'], dialogResponse: 1 });
    assert.equal(first.dialog.messages.length, 1);
    assert.equal(first.windows.length, 1);
    assert.equal(first.app.quitCount, 0);
    assert.equal(await first.invoke('trace:initial-board'), null, 'the start-up goes on as usual');
    assert.equal(await hasConfig(directory), false, 'no answer is stored');
    const second = await desktopHarness(directory, { platform: 'linux', argv: ['--no-sandbox'], dialogResponse: 1 });
    assert.equal(second.dialog.messages.length, 1, 'asked again');
  });

  await t.test('"Do not ask again" stores the answer in config.json with the settings; the next start skips the question but still logs the warning', async () => {
    const boardFile = path.join(root, 'Kept.cad');
    await fs.writeFile(boardFile, '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n');
    const recent = { name: 'Kept.cad', path: boardFile, openedAt: '2026-01-02T03:04:05.000Z' };
    const directory = await profile({ version: 1, settings, recentBoards: [recent] });
    const first = await desktopHarness(directory, { platform: 'linux', argv: ['--no-sandbox'], dialogAnswer: () => ({ response: 1, checkboxChecked: true }) });
    assert.deepEqual(plain(first.dialog.messages[0]), box('de'), 'asked in the stored language');
    const stored = await readConfig(directory);
    assert.equal(stored.noSandboxAccepted, true);
    assert.deepEqual(stored.settings, settings, 'the settings are kept as they were');
    assert.equal(stored.recentBoards.length, 1, 'and the recent files');
    assert.equal(stored.version, 1);
    assert.equal('noSandboxAccepted' in await first.invoke('trace:get-settings'), false, 'the renderer never sees the answer');
    // Later writes keep it (a settings save replaces only the settings).
    await first.invoke('trace:save-settings', { ...plain(await first.invoke('trace:get-settings')), theme: 'dark' });
    assert.equal((await readConfig(directory)).noSandboxAccepted, true);
    assert.equal((await readConfig(directory)).settings.theme, 'dark');
    const log = recorder();
    const second = await desktopHarness(directory, { platform: 'linux', argv: ['--no-sandbox'], console: log.console });
    assert.equal(second.dialog.messages.length, 0, 'not asked again');
    assert.equal(second.windows.length, 1);
    assert.deepEqual(log.warnings, [WARNING]);
    assert.equal((await second.invoke('trace:initial-board')).name, 'Kept.cad', 'the start-up is otherwise unchanged');
  });

  await t.test('only a stored true counts: another value, or a config.json that cannot be used, asks again', async () => {
    for (const config of [
      { version: 1, settings, recentBoards: [], noSandboxAccepted: 'yes' },
      { version: 1, settings, recentBoards: [], noSandboxAccepted: 1 },
      { version: 2, settings, recentBoards: [], noSandboxAccepted: true },
    ]) {
      const harness = await desktopHarness(await profile(config), { platform: 'linux', argv: ['--no-sandbox'], dialogResponse: 1 });
      assert.equal(harness.dialog.messages.length, 1, JSON.stringify(config));
    }
  });

  await t.test('TRACE_ACCEPT_NO_SANDBOX=1 skips the question, stores nothing and still logs; any other value asks', async () => {
    const directory = await profile();
    const log = recorder();
    const accepted = await desktopHarness(directory, { platform: 'linux', argv: ['--no-sandbox'], env: { TRACE_ACCEPT_NO_SANDBOX: '1' }, console: log.console });
    assert.equal(accepted.dialog.messages.length, 0);
    assert.equal(accepted.windows.length, 1);
    assert.deepEqual(log.warnings, [WARNING]);
    assert.equal(await hasConfig(directory), false, 'the environment is not remembered');
    for (const value of ['0', 'true', 'yes', '', ' 1', '1 ']) {
      const asked = await desktopHarness(await profile(), { platform: 'linux', argv: ['--no-sandbox'], env: { TRACE_ACCEPT_NO_SANDBOX: value }, dialogResponse: 1 });
      assert.equal(asked.dialog.messages.length, 1, JSON.stringify(value));
    }
  });

  await t.test('the switch is read from Chromium\'s command line, not from process.argv', async () => {
    // ELECTRON_DISABLE_SANDBOX: Electron appends --no-sandbox to Chromium's line; process.argv does not show it.
    const appended = await desktopHarness(await profile(), { platform: 'linux', argv: [], commandLineSwitches: ['no-sandbox'], dialogResponse: 1 });
    assert.equal(appended.dialog.messages.length, 1, 'asked: the sandbox is off although process.argv has no --no-sandbox');
    // The opposite: process.argv carries the text, Chromium's line does not (as after a "--" terminator): nothing is asked.
    const lookalike = await desktopHarness(await profile(), { platform: 'linux', argv: ['--no-sandbox'], commandLineSwitches: [] });
    assert.equal(lookalike.dialog.messages.length, 0, 'not asked: Chromium kept its sandbox');
    // As Chromium parses a launch (checked against Electron 44): "-no-sandbox" is the switch, "--no-sandbox" after "--" is not.
    const single = await desktopHarness(await profile(), { platform: 'linux', argv: ['-no-sandbox'], dialogResponse: 1 });
    assert.equal(single.dialog.messages.length, 1);
    const terminated = await desktopHarness(await profile(), { platform: 'linux', argv: ['--', '--no-sandbox'] });
    assert.equal(terminated.dialog.messages.length, 0);
  });

  await t.test('never asked on Windows or macOS, with or without --no-sandbox, nor on Linux with the sandbox on', async () => {
    for (const [platform, argv] of [[undefined, ['--no-sandbox']], ['win32', ['--no-sandbox']], ['darwin', ['--no-sandbox']], ['linux', []], ['linux', ['--disable-gpu-sandbox']]]) {
      const log = recorder();
      const harness = await desktopHarness(await profile(), { argv, console: log.console, ...(platform ? { platform } : {}) });
      assert.equal(harness.dialog.messages.length, 0, `${platform ?? 'default'} ${argv.join(' ')}`);
      assert.equal(harness.windows.length, 1);
      assert.deepEqual(log.warnings, []);
    }
  });

  await t.test('a failed write of the answer does not stop the start; the question simply comes again', async () => {
    const directory = await profile();
    const failing = new Proxy(fs, { get(target, property) {
      if (property === 'writeFile') return async (filename, ...rest) => { if (String(filename).includes('config.json')) throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }); return target.writeFile(filename, ...rest); };
      return target[property];
    } });
    const log = recorder();
    const harness = await desktopHarness(directory, { platform: 'linux', argv: ['--no-sandbox'], fs: failing, console: log.console, dialogAnswer: () => ({ response: 1, checkboxChecked: true }) });
    assert.equal(harness.windows.length, 1, 'the window opens');
    assert.equal(log.warnings[0], WARNING);
    assert.match(log.warnings[1] ?? '', /^TRACE: the answer could not be saved:/);
    assert.equal(await hasConfig(directory), false);
    const again = await desktopHarness(directory, { platform: 'linux', argv: ['--no-sandbox'], dialogResponse: 1 });
    assert.equal(again.dialog.messages.length, 1);
  });

  await t.test('the decision itself (sandboxGate): only Linux without the sandbox is ever asked or accepted', async () => {
    const gate = (await desktopHarness(await profile())).context.sandboxGate; // a top-level function of main.cjs
    const cases = [
      [{ platform: 'win32', noSandbox: true }, 'start'], [{ platform: 'darwin', noSandbox: true }, 'start'],
      [{ platform: 'linux', noSandbox: false }, 'start'], [{ platform: 'linux', noSandbox: false, accepted: true, acceptEnvironment: '1' }, 'start'],
      [{ platform: 'linux', noSandbox: true }, 'ask'], [{ platform: 'linux', noSandbox: true, accepted: false }, 'ask'],
      [{ platform: 'linux', noSandbox: true, accepted: 'true' }, 'ask'], [{ platform: 'linux', noSandbox: true, acceptEnvironment: 'true' }, 'ask'],
      [{ platform: 'linux', noSandbox: true, accepted: true }, 'accepted'], [{ platform: 'linux', noSandbox: true, acceptEnvironment: '1' }, 'accepted'],
      [{ platform: 'linux', noSandbox: 'yes' }, 'start'],
    ];
    for (const [input, expected] of cases) assert.equal(gate(input), expected, JSON.stringify(input));
  });
});

test('readings through the IPC handlers: the repair store, a main-owned import dialog that returns text only, a main-validated export, and the quit gate', async (t) => {
  const readingsFormat = require('../electron/readings.cjs');
  const root = await makeTempDir('trace-native-readings-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  let counter = 0;
  const profile = () => path.join(root, `profile-${++counter}`);
  const ID = 'c'.repeat(64);
  const family = { id: ID, createdAt: '2026-10-07T08:00:00Z', members: [{ fingerprint: ID, fingerprintVersion: 1, fileKeys: [] }] };
  const reading = (id, value, extra = {}) => ({ id, kind: 'diode', target: { net: 'PP3V3_S5' }, value, unit: 'V', conditions: { power: 'unpowered' }, source: 'known-good', ...extra });
  const pack = (readings, extra = {}) => ({ format: 'trace-readings', version: 1, license: 'CC0-1.0', board: { label: 'Main board' }, readings, ...extra });
  const plain = (value) => JSON.parse(JSON.stringify(value)); // results built inside main.cjs come from another realm

  await t.test('append, read and list: events are validated natively, a bad call writes nothing, the readings come back as JSON text', async () => {
    const harness = await desktopHarness(profile());
    const created = await harness.invoke('trace:append-readings', ID, [{ type: 'family.create', family }, { type: 'reading.add', reading: reading('r1', 0.412) }]);
    assert.deepEqual(created, { seq: 1, readingCount: 1 });
    await assert.rejects(harness.invoke('trace:append-readings', ID, [{ type: 'reading.add', reading: reading('r2', -1) }]), { code: 'READINGS_INVALID', message: /^\[READINGS_INVALID\] Invalid readings: events\[0\]\.reading\.value\.$/ });
    await assert.rejects(harness.invoke('trace:append-readings', ID, [{ type: 'reading.add', reading: reading('r1', 0.5) }]), { code: 'READINGS_CONFLICT' });
    await assert.rejects(harness.invoke('trace:append-readings', '../x', [{ type: 'reading.remove', id: 'r1' }]), { code: 'READINGS_INVALID' });
    await assert.rejects(harness.invoke('trace:read-readings', ID, { headerOnly: 'yes' }), { code: 'READINGS_INVALID_REQUEST' });
    const snapshot = await harness.invoke('trace:read-readings', ID);
    assert.equal(snapshot.seq, 1);
    assert.deepEqual(JSON.parse(snapshot.readings), [reading('r1', 0.412)]);
    assert.equal((await harness.invoke('trace:read-readings', ID, { headerOnly: true })).readings, undefined);
    assert.equal(await harness.invoke('trace:read-readings', 'd'.repeat(64)), null);
    const list = await harness.invoke('trace:list-readings-families');
    assert.deepEqual(list.map((entry) => [entry.id, entry.readingCount, entry.seq]), [[ID, 1, 1]]);
  });

  await t.test('import: the dialog is main-owned, the result is the base name and the decoded text; binary or unreadable files are refused with a code', async () => {
    const harness = await desktopHarness(profile());
    const folder = path.join(root, 'import');
    await fs.mkdir(folder, { recursive: true });
    const packFile = path.join(folder, 'board.trace-readings.json');
    const packText = readingsFormat.serializePack(readingsFormat.validatePack(pack([reading('r1', 0.412)])));
    await fs.writeFile(packFile, `﻿${packText}`);
    assert.equal(await harness.invoke('trace:import-readings'), null, 'a cancelled dialog imports nothing');
    harness.dialog.choice = { canceled: false, filePaths: [packFile] };
    const imported = await harness.invoke('trace:import-readings');
    assert.deepEqual(plain(imported), { name: 'board.trace-readings.json', bytes: Buffer.byteLength(packText) + 3, text: packText }, 'base name only (never the path), BOM removed');
    assert.equal(harness.dialog.openOptions.at(-1).properties.includes('openFile'), true);
    const utf16 = path.join(folder, 'obdata.txt');
    await fs.writeFile(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ID 820-00165\nPP3V3 0.41 3.3 OL\n', 'utf16le')]));
    harness.dialog.choice = { canceled: false, filePaths: [utf16] };
    assert.equal((await harness.invoke('trace:import-readings')).text, 'ID 820-00165\nPP3V3 0.41 3.3 OL\n');
    const binary = path.join(folder, 'image.json');
    await fs.writeFile(binary, Buffer.from([0x7b, 0x00, 0x7d]));
    harness.dialog.choice = { canceled: false, filePaths: [binary] };
    await assert.rejects(harness.invoke('trace:import-readings'), { code: 'READINGS_NOT_TEXT' });
    harness.dialog.choice = { canceled: false, filePaths: [path.join(folder, 'missing.csv')] };
    await assert.rejects(harness.invoke('trace:import-readings'), { code: 'READINGS_FILE_UNREADABLE' });
  });

  await t.test('export: the pack is validated natively (licence marking included) before any dialog, and the written bytes are those of the native writers', async () => {
    const harness = await desktopHarness(profile());
    const folder = path.join(root, 'export');
    await fs.mkdir(folder, { recursive: true });
    const odbl = reading('o1', 0.5, { source: 'imported', license: 'ODbL-1.0', provenance: { origin: 'openboarddata', title: '820-00165' } });
    await assert.rejects(harness.invoke('trace:export-readings', { format: 'pack', pack: pack([reading('r1', 0.4), odbl]) }), { code: 'READINGS_INVALID', message: /not listed in licenses/ });
    await assert.rejects(harness.invoke('trace:export-readings', { format: 'xml', pack: pack([]) }), { code: 'READINGS_INVALID_REQUEST' });
    assert.equal(harness.dialog.saveOptions.length, 0, 'no dialog opened for a refused export');
    assert.equal(await harness.invoke('trace:export-readings', { format: 'pack', pack: pack([reading('r1', 0.4)]) }), null, 'a cancelled dialog writes nothing');
    assert.equal(harness.dialog.saveOptions.at(-1).defaultPath, 'Main board.trace-readings.json');
    const marked = pack([reading('r1', 0.4), odbl], { licenses: ['CC0-1.0', 'ODbL-1.0'] });
    const expected = readingsFormat.serializePack(readingsFormat.validatePack(marked));
    harness.dialog.saveChoice = { canceled: false, filePath: path.join(folder, 'shared') };
    const written = await harness.invoke('trace:export-readings', { format: 'pack', pack: marked });
    assert.deepEqual(plain(written), { name: 'shared.json', bytes: Buffer.byteLength(expected), readings: 2 });
    assert.equal(await fs.readFile(path.join(folder, 'shared.json'), 'utf8'), expected);
    harness.dialog.saveChoice = { canceled: false, filePath: path.join(folder, 'table.csv') };
    await harness.invoke('trace:export-readings', { format: 'csv', pack: marked, name: 'table' });
    const csv = await fs.readFile(path.join(folder, 'table.csv'), 'utf8');
    assert.equal(csv, readingsFormat.packToCsv(readingsFormat.validatePack(marked)));
    assert.match(csv.split('\r\n')[1], /,known-good,CC0-1\.0,/, 'a row without a licence of its own names the pack licence');
    assert.match(csv.split('\r\n')[2], /,imported,ODbL-1\.0,openboarddata,/, 'the ODbL row keeps its licence and provenance');
    assert.deepEqual((await fs.readdir(folder)).filter((name) => name.endsWith('.tmp')), []);
  });

  await t.test('quit gate: appends and file dialogs are refused once quitting began, reads still answer', async () => {
    const harness = await desktopHarness(profile());
    await harness.invoke('trace:append-readings', ID, [{ type: 'family.create', family }]);
    harness.app.emit('before-quit', { preventDefault() {} });
    await assert.rejects(harness.invoke('trace:append-readings', ID, [{ type: 'reading.add', reading: reading('r1', 0.4) }]), { code: 'STORE_CLOSING' });
    await assert.rejects(harness.invoke('trace:import-readings'), { code: 'READINGS_CLOSING' });
    await assert.rejects(harness.invoke('trace:export-readings', { format: 'pack', pack: pack([]) }), { code: 'READINGS_CLOSING' });
    assert.equal((await harness.invoke('trace:read-readings', ID)).readingCount, 0);
  });
});

test('format diagnostic report through the IPC handlers: main-owned dialogs, a neutral name, a secret that stays in the profile, a validated and canonical save', async (t) => {
  const root = await makeTempDir('trace-diagnostic-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const diagnostics = require('../electron/diagnostics.cjs');
  const text = (key, params) => i18n.translate('hu', key, params);
  let counter = 0;
  const profile = () => path.join(root, `profile-${++counter}`);
  const folder = path.join(root, 'Customer Secret QZX7');
  await fs.mkdir(folder, { recursive: true });
  const BOARD = '$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n';
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const choose = (harness, ...files) => { harness.dialog.choice = { canceled: false, filePaths: files }; };
  const reviewed = () => ({
    schema: 'trace-format-diagnostic/1',
    app: { version: '1.3.0', adapterSet: '0123abcd', os: 'win32' },
    privacy: { redaction: 1, level: 1, reviewedByUser: true, dedupe: false },
    input: { extension: '.cad', sizeLog2: 6, companions: { count: 0, extensions: [] }, container: 'none', textLike: true, encoding: 'ascii', lineEndings: 'lf', entropy: Array.from({ length: 16 }, () => 4.5), magic: 'none' },
    detection: { outcome: 'unrecognized', selected: null, format: null, ambiguous: false, adapters: [] },
    structure: null, result: null, plausibility: null, keys: { supplied: false, parity: 'n/a' }, performance: { parseMs: 3, peakHeapLog2: null }, dedupe: null,
  });

  await t.test('the file dialog is the main process\'s own: any file, localized, cancel resolves null, the renderer chooses nothing', async () => {
    const harness = await desktopHarness(profile());
    harness.dialog.choice = { canceled: true, filePaths: [] };
    assert.equal(await harness.invoke('trace:diagnostic-pick'), null);
    const options = harness.dialog.openOptions.at(-1);
    assert.equal(options.title, text('native.dialog.diagnosticPickTitle'));
    assert.equal(options.buttonLabel, text('native.dialog.diagnosticPickButton'));
    assert.deepEqual(plain(options.properties), ['openFile']);
    assert.deepEqual(plain(options.filters[0]), { name: text('native.dialog.diagnosticAllFiles'), extensions: ['*'] }, 'any file may be diagnosed: "all files" comes first');
    assert.ok(options.filters.length > 1, 'the format filters follow');
    // An argument from the renderer changes nothing: no path can be named.
    const board = path.join(folder, 'QZX7 board REV3.cad');
    await fs.writeFile(board, BOARD);
    harness.dialog.choice = { canceled: true, filePaths: [] };
    assert.equal(await harness.invoke('trace:diagnostic-pick', board), null, 'a path argument is ignored');
  });

  await t.test('the renderer gets the bytes under a neutral name: never the file name, the folder, the user or the secret', async () => {
    const dir = profile();
    const harness = await desktopHarness(dir);
    const board = path.join(folder, 'QZX7 board REV3.CAD');
    await fs.writeFile(board, BOARD);
    choose(harness, board);
    const payload = await harness.invoke('trace:diagnostic-pick');
    assert.deepEqual(Object.keys(payload).sort(), ['data', 'dedupe', 'name', 'os'], 'nothing else travels');
    assert.equal(payload.name, 'diagnostic.cad');
    assert.equal(payload.os, 'win32');
    assert.equal(Object.prototype.toString.call(payload.data), '[object Uint8Array]');
    assert.equal(bytesOf(payload.data).toString('utf8'), BOARD);
    assert.match(payload.dedupe, /^[0-9a-f]{16}$/);
    const wire = JSON.stringify({ ...payload, data: undefined });
    for (const secret of ['QZX7', 'Customer', 'Secret', 'REV3', 'board', root, os.userInfo().username]) assert.equal(wire.includes(secret), false, `${secret} does not travel`);
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'diagnostic-secret.json'), 'utf8'));
    assert.deepEqual(Object.keys(stored).sort(), ['secret', 'version']);
    assert.match(stored.secret, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(payload).includes(stored.secret), false, 'the secret never reaches the renderer');
    assert.equal(harness.net.requests.length, 0, 'no network request');
  });

  await t.test('extension-less and unknown-extension files work, an empty file too; only a safe extension survives', async () => {
    const harness = await desktopHarness(profile());
    for (const [file, expected] of [['readme', 'diagnostic'], ['dump.XYZ', 'diagnostic.xyz'], ['weird.name.with-dash', 'diagnostic'], ['empty.brd', 'diagnostic.brd']]) {
      const target = path.join(folder, file);
      await fs.writeFile(target, file === 'empty.brd' ? '' : 'some bytes');
      choose(harness, target);
      const payload = await harness.invoke('trace:diagnostic-pick');
      assert.equal(payload.name, expected, file);
      assert.equal(payload.data.byteLength, file === 'empty.brd' ? 0 : 10);
    }
  });

  await t.test('the repeat-detection code: an HMAC under the install\'s own secret, the same for the same bytes under any name, different for other bytes, other installs and a public hash', async () => {
    const dir = profile();
    const harness = await desktopHarness(dir);
    const a = path.join(folder, 'a.cad'), b = path.join(folder, 'renamed copy.cad'), c = path.join(folder, 'c.cad');
    await fs.writeFile(a, BOARD); await fs.writeFile(b, BOARD); await fs.writeFile(c, `${BOARD}\n`);
    const codeOf = async (file, h = harness) => { choose(h, file); return (await h.invoke('trace:diagnostic-pick')).dedupe; };
    const first = await codeOf(a);
    assert.equal(await codeOf(b), first, 'a renamed copy gives the same code');
    assert.notEqual(await codeOf(c), first, 'other bytes, other code');
    const again = await desktopHarness(dir);
    assert.equal(await codeOf(a, again), first, 'the secret persists in the profile');
    const other = await desktopHarness(profile());
    assert.notEqual(await codeOf(a, other), first, 'another install has another secret');
    for (const algorithm of ['sha256', 'sha1', 'md5']) assert.equal(createHash(algorithm).update(BOARD).digest('hex').startsWith(first), false, `not a plain ${algorithm}`);
    // A damaged secret file is replaced, not trusted.
    await fs.writeFile(path.join(dir, 'diagnostic-secret.json'), '{"version":1,"secret":"nothex"}');
    const repaired = await desktopHarness(dir);
    const fresh = await codeOf(a, repaired);
    assert.match(fresh, /^[0-9a-f]{16}$/);
    assert.match(JSON.parse(await fs.readFile(path.join(dir, 'diagnostic-secret.json'), 'utf8')).secret, /^[0-9a-f]{64}$/);
  });

  await t.test('a companion set gives the same code whichever member was chosen, with the fixed role names', async () => {
    const harness = await desktopHarness(profile());
    const set = path.join(folder, 'trio');
    await fs.mkdir(set, { recursive: true });
    for (const [name, content] of [['Format.ASC', 'f'], ['pins.asc', 'p'], ['NAILS.asc', 'n']]) await fs.writeFile(path.join(set, name), content);
    const codes = [];
    for (const member of ['Format.ASC', 'pins.asc', 'NAILS.asc']) {
      choose(harness, path.join(set, member));
      const payload = await harness.invoke('trace:diagnostic-pick');
      assert.equal(payload.name, member.toLowerCase());
      assert.deepEqual(Object.keys(payload.companions).sort(), ['format.asc', 'nails.asc', 'pins.asc'].filter((name) => name !== member.toLowerCase()));
      codes.push(payload.dedupe);
    }
    assert.equal(new Set(codes).size, 1);
  });

  await t.test('refusals: a folder, a missing file, an oversize file, a path that is not local, and the quit gate; the dialog opens only when it should', async () => {
    const harness = await desktopHarness(profile());
    choose(harness, folder);
    await assert.rejects(harness.invoke('trace:diagnostic-pick'), { message: text('native.error.notAFile') });
    choose(harness, path.join(folder, 'missing.cad'));
    await assert.rejects(harness.invoke('trace:diagnostic-pick'), { message: text('native.error.boardNotFound') });
    choose(harness, 'relative/path.cad');
    await assert.rejects(harness.invoke('trace:diagnostic-pick'), { message: text('native.error.invalidPath') });
    const huge = path.join(folder, 'huge.bin');
    await fs.writeFile(huge, '');
    await fs.truncate(huge, 64 * 1024 * 1024 + 1);
    choose(harness, huge);
    await assert.rejects(harness.invoke('trace:diagnostic-pick'), { message: text('native.error.boardTooLarge', { max: 64 }) });
    const opened = harness.dialog.openOptions.length;
    harness.app.emit('before-quit', { preventDefault() {} });
    await assert.rejects(harness.invoke('trace:diagnostic-pick'), { code: 'DIAGNOSTIC_CLOSING', message: `[DIAGNOSTIC_CLOSING] ${text('native.error.diagnosticClosing')}` });
    await assert.rejects(harness.invoke('trace:diagnostic-save', reviewed()), { code: 'DIAGNOSTIC_CLOSING' });
    assert.equal(harness.dialog.openOptions.length, opened, 'no dialog after the quit intent');
    assert.equal(harness.dialog.saveOptions.length, 0);
  });

  await t.test('save: the report is validated against the closed schema again, the user must have reviewed it, and a refused report opens no dialog', async () => {
    const harness = await desktopHarness(profile());
    const bad = [
      null, 'text', [], {}, { ...reviewed(), extra: 1 }, { ...reviewed(), privacy: { ...reviewed().privacy, reviewedByUser: false } },
      { ...reviewed(), input: { ...reviewed().input, extension: '.secret-customer' } }, { ...reviewed(), input: { ...reviewed().input, fileName: 'board.cad' } },
      { ...reviewed(), detection: { ...reviewed().detection, adapters: [{ id: 'QZX7', sniff: 'certain', result: 'claimed', code: null, stage: null, format: null, keyKind: null }] } },
      { ...reviewed(), structure: { hook: 'gencad', kind: 'text', variant: null, headerOk: true, linesLog2: 3, keywords: { QZX7NET: 1 }, fields: {}, numbers: null, sections: [], header: { codes: {}, counts: {} }, blocks: null } },
    ];
    for (const report of bad) {
      await assert.rejects(harness.invoke('trace:diagnostic-save', report), { code: 'DIAGNOSTIC_INVALID', message: `[DIAGNOSTIC_INVALID] ${text('native.error.diagnosticInvalid')}` }, JSON.stringify(report)?.slice(0, 60));
    }
    assert.equal(harness.dialog.saveOptions.length, 0, 'a refused report opens no dialog');
  });

  await t.test('save: the main-owned dialog, a bare default name, .json added, the canonical text written, cancel writes nothing, and a failed write is reported', async () => {
    const harness = await desktopHarness(profile());
    const report = reviewed();
    harness.dialog.saveChoice = { canceled: true, filePath: undefined };
    assert.equal(await harness.invoke('trace:diagnostic-save', report), null);
    const options = harness.dialog.saveOptions.at(-1);
    assert.equal(options.title, text('native.dialog.diagnosticSaveTitle'));
    assert.equal(options.buttonLabel, text('native.dialog.diagnosticSaveButton'));
    assert.equal(options.defaultPath, 'trace-format-diagnostic.json', 'a bare name: the dialog does not start next to the examined file');
    assert.deepEqual(plain(options.filters), [{ name: text('native.dialog.diagnosticSaveFilter'), extensions: ['json'] }]);
    const target = path.join(folder, 'shared report');
    harness.dialog.saveChoice = { canceled: false, filePath: target };
    const written = await harness.invoke('trace:diagnostic-save', report);
    const expected = diagnostics.serializeReport(diagnostics.validateReport(report, { reviewed: true }));
    assert.deepEqual(plain(written), { bytes: Buffer.byteLength(expected) });
    assert.equal(await fs.readFile(`${target}.json`, 'utf8'), expected, 'the canonical text, with .json added');
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    // The renderer's own key order does not matter: the file is the canonical form.
    const shuffled = Object.fromEntries(Object.entries(report).reverse());
    harness.dialog.saveChoice = { canceled: false, filePath: path.join(folder, 'again.JSON') };
    await harness.invoke('trace:diagnostic-save', shuffled);
    assert.equal(await fs.readFile(path.join(folder, 'again.JSON'), 'utf8'), expected);
    harness.dialog.saveChoice = { canceled: false, filePath: path.join(folder, 'no-such-folder', 'x.json') };
    await assert.rejects(harness.invoke('trace:diagnostic-save', report), { code: 'DIAGNOSTIC_WRITE_FAILED', message: `[DIAGNOSTIC_WRITE_FAILED] ${text('native.error.diagnosticWriteFailed')}` });
    assert.equal(harness.net.requests.length, 0, 'no network request');
  });

  await t.test('the preload forwards nothing but the report: the pick takes no argument, the save takes the report only', async () => {
    const harness = await desktopHarness(profile());
    let api;
    const calls = [];
    const electron = {
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke: (channel, ...args) => { calls.push([channel, args]); return harness.invoke(channel, ...args); }, on() {}, removeListener() {}, send() {} },
      webUtils: { getPathForFile: () => '' },
    };
    const source = await fs.readFile(path.resolve(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
    vm.runInNewContext(source, { require: (name) => (name === 'electron' ? electron : require(name)) }, { filename: 'preload.cjs' });
    harness.dialog.choice = { canceled: true, filePaths: [] };
    await api.pickDiagnosticFile('C:\\secret\\board.cad', { more: true });
    harness.dialog.saveChoice = { canceled: true, filePath: undefined };
    await api.saveDiagnosticReport(reviewed(), '/elsewhere');
    assert.deepEqual(plain(calls), [['trace:diagnostic-pick', []], ['trace:diagnostic-save', [plain(reviewed())]]]);
    const preload = source.split('\n').filter((line) => /Diagnostic/.test(line)).join('\n');
    assert.doesNotMatch(preload, /clipboard|fetch|https?:/, 'the diagnostic calls of the preload carry no URL and no clipboard');
  });

  await t.test('the source: the diagnostic code reaches no network or clipboard, and the validator module needs only node:crypto and the schema', async () => {
    const [main, validator] = await Promise.all(['main.cjs', 'diagnostics.cjs'].map((name) => fs.readFile(path.resolve(__dirname, '..', 'electron', name), 'utf8')));
    assert.deepEqual([...validator.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]).sort(), ['./diagnostic-schema.json', 'node:crypto']);
    const code = validator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|node:https?|\bnet\b\.|clipboard|process\.env|Date\.now|new Date\b|os\.hostname|userInfo/);
    assert.doesNotMatch(main, /clipboard\./, 'the main process never writes the clipboard');
    const block = main.slice(main.indexOf('async function readDiagnosticFile'), main.indexOf('function acceptBoard'));
    assert.ok(block.length > 1000);
    assert.doesNotMatch(block, /\bfetch\(|egress|shell\.|clipboard|openExternal|net\./, 'the diagnostic block reaches nothing outside the file dialogs');
  });
});
