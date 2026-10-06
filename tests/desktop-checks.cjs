'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
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
    isPackaged: false, setName(name) { this.name = name; }, setAppUserModelId() {}, setPath() {},
    getPath: () => directory, isReady: () => ready, getVersion: () => options.version ?? '1.2.0',
    whenReady: () => readyGate ? readyGate.then(() => { ready = true; }) : Promise.resolve(),
    requestSingleInstanceLock: () => true, quitCount: 0, quit() { this.quitCount++; },
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
    // Answers like Electron: the index of the pressed button (`response`, default 0) or whatever `answer(options)` resolves to.
    showMessageBox(_window, options) {
      this.messages.push(options);
      return Promise.resolve(this.answer ? this.answer(options) : { response: this.response ?? 0, checkboxChecked: false });
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
  // The only network function main.cjs may use (update check). No test touches the network: a request without `options.fetch` is refused.
  const net = {
    requests: [],
    fetch(url, init) {
      this.requests.push({ url, init });
      return options.fetch ? options.fetch(url, init) : Promise.reject(new Error('no network in tests'));
    },
  };
  // The application menu: `templates` holds every template main.cjs built, `applied` every value it set (null, or the built menu).
  const menu = {
    templates: [], applied: [],
    buildFromTemplate(template) { this.templates.push(template); return { template }; },
    setApplicationMenu(value) { this.applied.push(value); },
  };
  const electron = {
    app, BrowserWindow: MockBrowserWindow, dialog, Menu: menu, shell, net, session: { defaultSession },
    ipcMain: {
      handle(channel, callback) { handlers.set(channel, callback); },
      on(channel, callback) { messages.set(channel, callback); },
    },
  };
  const filename = path.resolve(__dirname, '..', 'electron', 'main.cjs');
  const source = await fs.readFile(filename, 'utf8');
  // The context is returned so a test can reach a top-level function of main.cjs (e.g. openExternalUrl) that no handler exposes.
  // `options.timers` replaces the timer functions main.cjs sees (the fallback show), `options.argv` the launch arguments after the
  // application path.
  const context = {
    require: (name) => name === 'electron' ? electron : name === 'node:fs/promises' && options.fs ? options.fs : require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name),
    __dirname: path.dirname(filename), Buffer, URL, console,
    setTimeout: options.timers?.setTimeout ?? setTimeout, clearTimeout: options.timers?.clearTimeout ?? clearTimeout,
    process: { argv: ['electron.exe', 'app', ...(options.argv ?? [])], pid: process.pid, platform: options.platform ?? 'win32', env: {} },
  };
  vm.runInNewContext(source, context, { filename });
  const waitForWindow = async () => {
    for (let attempt = 0; attempt < 100 && !window; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(window, 'Desktop should create the window after loading config');
  };
  if (!options.deferReady) await waitForWindow();
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return {
    get window() { return window; }, get windows() { return [...created]; }, context, app, dialog, shell, net, menu, session: electron.session, handlers, languageCalls, waitForWindow,
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
    await assert.rejects(invoke('trace:read-board', path.join(directory, 'secret.txt')), { message: i18n.translate('hu', 'native.error.unsupportedFile') });
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
    // Documents: the shared path check (store.cjs) answers with the existing invalid-path code.
    await assert.rejects(invoke('trace:read-document', `${host}:alt.pdf`), { code: 'DOCUMENT_INVALID_PATH', message: /^\[DOCUMENT_INVALID_PATH\] / });
    await assert.rejects(invoke('trace:locate-documents', stream, []), { code: 'DOCUMENT_INVALID_PATH' });
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
    for (const name of ['board.txt', 'board.cad.bak', 'board', 'board.CAD.exe', 'cad']) {
      await assert.rejects(invoke('trace:read-board', path.join(samples, name)), { message: i18n.translate('hu', 'native.error.unsupportedFile') });
    }
    // External launches: --board=, a bare absolute path, and an unsupported bare path that is ignored without a dialog.
    const brd = path.join(samples, 'Launch.brd');
    await fs.writeFile(brd, 'str_length:\n');
    const kicad = path.join(samples, 'Launch.kicad_pcb');
    await fs.writeFile(kicad, '(kicad_pcb)');
    await fs.writeFile(path.join(samples, 'notes.txt'), 'not a board');
    const launched = await desktopHarness(path.join(directory, 'extension-launch-profile'));
    await launched.invoke('trace:initial-board');
    const delivered = () => launched.window.webContents.sent.filter((event) => event.channel === 'trace:board-opened').map((event) => event.value.name);
    launched.app.emit('second-instance', {}, ['electron.exe', 'app', `--board=${brd}`]);
    await settle(() => delivered().length >= 1);
    launched.app.emit('second-instance', {}, ['electron.exe', 'app', kicad]);
    await settle(() => delivered().length >= 2);
    launched.app.emit('second-instance', {}, ['electron.exe', 'app', path.join(samples, 'notes.txt')]);
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
    // main.cjs hands its translator to store.cjs and documents.cjs, which look up their own keys.
    let source = '';
    for (const name of ['main', 'store', 'documents', 'workspace', 'identity', 'formats']) source += await fs.readFile(path.resolve(__dirname, '..', 'electron', `${name}.cjs`), 'utf8');
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
  for (const value of ['board.txt', 'board.cad.bak', 'board', '', 'cad', undefined, null, 7]) assert.equal(formats.isSupportedExtension(value), false, String(value));
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
  ]) assert.throws(() => load(bad), /formats\.json/, JSON.stringify(bad));
  const loaded = load({ extensions: ['.cad'], companions: { 'a.asc': ['b.asc'] } });
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
      'acceptBoard', 'checkForUpdates', 'close', 'droppedFilePath', 'exportWorkspace', 'getNotes', 'getSettings', 'initialBoard', 'isMaximized', 'loadWorkspace', 'locateDocuments', 'maximize', 'minimize',
      'onFlushRequest', 'onMaximized', 'onOpenBoard', 'openBoard', 'openSupportLink', 'openUpdatePage', 'pickDocuments', 'readBoard', 'readDocument', 'recentBoards', 'saveNotes', 'saveSettings', 'saveWorkspace',
    ], 'the preload exposes exactly the TraceDesktop members (plus onFlushRequest, the close/quit flush hook; openSupportLink takes an id, never a URL; checkForUpdates and openUpdatePage take no argument at all)');
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
// renderer sends an id over 'trace:open-support-link', main maps it and calls shell.openExternal for exactly these three URLs (Stripe, Ko-fi, the GitHub bug report form).
test('support notice: trace:open-support-link opens only the three fixed links by id; any other value is rejected and shell.openExternal is never called', async (t) => {
  const root = await makeTempDir('trace-support-link-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const URLS = { stripe: 'https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00', kofi: 'https://ko-fi.com/tracerboardview', bug: 'https://github.com/trace-boardviewer/trace-boardviewer/issues/new?template=bug_report.yml' };
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

  await t.test('stripe, kofi and bug open exactly their constant URLs, once per request, with no extra arguments', async () => {
    const harness = await desktopHarness(profile());
    assert.equal(await harness.invoke('trace:open-support-link', 'stripe'), undefined);
    assert.deepEqual(harness.shell.opened, [URLS.stripe]);
    assert.equal(await harness.invoke('trace:open-support-link', 'kofi'), undefined);
    assert.deepEqual(harness.shell.opened, [URLS.stripe, URLS.kofi]);
    assert.equal(await harness.invoke('trace:open-support-link', 'bug'), undefined);
    assert.deepEqual(harness.shell.opened, [URLS.stripe, URLS.kofi, URLS.bug]);
    assert.deepEqual(harness.shell.extraArguments, [[], [], []], 'openExternal gets the URL only');
    for (const url of harness.shell.opened) assert.equal(new URL(url).protocol, 'https:');
  });

  await t.test('unknown ids, URLs, look-alikes, prototype names and non-strings are rejected with an error and nothing opens', async () => {
    const harness = await desktopHarness(profile());
    const invalid = [
      'paypal', 'Stripe', 'KOFI', ' stripe', 'kofi ', 'stripe\n', 'stripe\0', '', 'ko-fi', 'donate', 'Bug', 'BUG', 'bug ', 'bug\n', 'bugs', 'issue', 'issues', 'report', 'github',
      'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'prototype',
      URLS.stripe, URLS.kofi, URLS.bug, 'https://github.com/trace-boardviewer/trace-boardviewer/issues', 'https://evil.example/', 'http://ko-fi.com/tracerboardview', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:', 'C:\\Windows\\System32\\calc.exe',
      undefined, null, 0, 1, true, false, NaN, 10n, Symbol.for('stripe'), ['stripe'], ['kofi', 'stripe'], { id: 'stripe' }, { toString: () => 'stripe' }, () => 'stripe', new String('stripe'),
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
    await assert.rejects(harness.invoke('trace:open-support-link', 'stripe'), /no handler for https/);
    fail = false;
    await harness.invoke('trace:open-support-link', 'kofi');
    assert.deepEqual(harness.shell.opened, [URLS.stripe, URLS.kofi]);
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

  await t.test('the main-process source holds the two support URLs exactly once each and builds the bug form from the repository slug; the preload source holds none (the renderer never sends a URL)', async () => {
    const main = await fs.readFile(path.resolve(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
    const preload = await fs.readFile(path.resolve(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
    for (const url of [URLS.stripe, URLS.kofi]) assert.equal(main.split(url).length - 1, 1, `${url} appears once in main.cjs`);
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
    assert.deepEqual(calls, [['trace:open-support-link', 'stripe'], ['trace:open-support-link', 'kofi'], ['trace:open-support-link', 'bug']]);
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
    const started = Date.now();
    const ignoring = await check(() => new Promise(() => {}), { timeoutMs: 40 });
    assert.deepEqual(ignoring.result, UNAVAILABLE);
    assert.equal(ignoring.calls[0].init.signal.aborted, true, 'the signal was aborted');
    const honouring = await check((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))), { timeoutMs: 40 });
    assert.deepEqual(honouring.result, UNAVAILABLE);
    const stalled = new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { status: 200 });
    assert.deepEqual((await check(stalled, { timeoutMs: 40 })).result, UNAVAILABLE);
    assert.ok(Date.now() - started < 4000, 'none of the three waited for the default 8 s');
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
    assert.equal(main.split('net.fetch(').length - 1, 1, 'exactly one net.fetch call site in main.cjs');
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
