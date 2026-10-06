'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, listener) {
  if (typeof listener !== 'function') throw new TypeError('The event listener must be a function.'); // Developer-facing; the sandboxed preload stays standalone.
  // Never expose Electron's event object or generic IPC methods to the renderer.
  const receive = (_event, value) => listener(value);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}

// Electron delivers a rejected invoke() as a plain Error whose message is "Error invoking remote method
// '<channel>': Error: <text>", and the context bridge then copies an Error into the renderer with its
// message and stack ONLY: `code`, `name` and `cause` are dropped (verified with Electron 44 in
// tests/electron-smoke.cjs). The only channel that reaches the renderer is therefore the message. The main
// process starts the text of an error that has a stable machine code with "[CODE] " (STORE_CLOSING,
// BOARD_MISMATCH, MANIFEST_INVALID, DOCUMENT_*, EXPORT_*, WORKSPACE_*). Here Electron's wrapper is removed
// so the message is exactly "[CODE] text", and `.code` is set as well (it survives wherever no bridge
// copy is involved, e.g. tests). The renderer reads the code from the message prefix. Any other rejection
// is passed on untouched, and the raw IPC machinery is never exposed.
const CODE_PREFIX = /^(?:Error invoking remote method '[^']*': )?(?:Error: )?(\[([A-Z][A-Z0-9_]{2,47})\] )/;
function call(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((error) => {
    const match = error && typeof error.message === 'string' ? CODE_PREFIX.exec(error.message) : null;
    if (!match) throw error;
    throw Object.assign(new Error(error.message.slice(match.index + match[0].length - match[1].length)), { code: match[2] });
  });
}

// Close/quit flush (W-fin-lifecycle-02): before it destroys the window or shuts the store down, the main process
// sends 'trace:flush-request' with a number. Every listener registered through onFlushRequest writes what the
// renderer still holds (the debounced workspace snapshot) and may return a promise; once all of them settled the
// answer 'trace:flush-done' goes back with the same number. With no listener it answers at once, so a renderer
// that has not subscribed (yet) never holds the main process up. The request is only ever listened to here.
const flushListeners = new Set();
ipcRenderer.on('trace:flush-request', (_event, id) => {
  if (!Number.isSafeInteger(id)) return;
  const pending = [...flushListeners].map((listener) => {
    try { return Promise.resolve(listener()); } catch (error) { return Promise.reject(error); }
  });
  void Promise.allSettled(pending).then(() => ipcRenderer.send('trace:flush-done', id));
});
function onFlushRequest(listener) {
  if (typeof listener !== 'function') throw new TypeError('The flush listener must be a function.'); // Developer-facing; the sandboxed preload stays standalone.
  flushListeners.add(listener);
  return () => { flushListeners.delete(listener); };
}

contextBridge.exposeInMainWorld('traceDesktop', Object.freeze({
  // Board payloads carry the original bytes: structured clone delivers the main-process Uint8Array
  // (and any companion sidecars) to the renderer as Uint8Array values.
  openBoard: () => call('trace:open-board'),
  readBoard: (path) => call('trace:read-board', path),
  acceptBoard: (path, key) => call('trace:accept-board', path, key),
  initialBoard: () => call('trace:initial-board'),
  recentBoards: () => call('trace:recent-boards'),
  getSettings: () => call('trace:get-settings'),
  saveSettings: (settings) => call('trace:save-settings', settings),
  getNotes: (boardKey) => call('trace:get-notes', boardKey),
  saveNotes: (boardKey, notes) => call('trace:save-notes', boardKey, notes),
  // Workspace and documents (errors with a stable machine code start their message with "[CODE] ", see call()).
  loadWorkspace: (boardKey) => call('trace:load-workspace', boardKey),
  saveWorkspace: (boardKey, manifest) => call('trace:save-workspace', boardKey, manifest),
  pickDocuments: (options) => call('trace:pick-documents', options),
  readDocument: (path, options) => call('trace:read-document', path, options),
  locateDocuments: (boardPath, requests) => call('trace:locate-documents', boardPath, requests),
  exportWorkspace: (request) => call('trace:export-workspace', request),
  // Support notice: the renderer names one of three fixed links by id ('stripe' | 'kofi' | 'bug'); main.cjs holds the URLs and rejects anything else.
  openSupportLink: (id) => call('trace:open-support-link', id),
  // Update notification: neither call takes an argument (none is forwarded). The main process fetches the release info itself and keeps the validated tag; the renderer never sends a URL or a tag.
  checkForUpdates: () => call('trace:check-for-updates'),
  openUpdatePage: () => call('trace:open-update-page'),
  minimize: () => ipcRenderer.send('trace:minimize'),
  maximize: () => ipcRenderer.send('trace:maximize'),
  close: () => ipcRenderer.send('trace:close'),
  isMaximized: () => call('trace:is-maximized'),
  onMaximized: (listener) => subscribe('trace:maximized', listener),
  droppedFilePath: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  onOpenBoard: (listener) => subscribe('trace:board-opened', listener),
  onFlushRequest,
}));
