'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const i18n = require('./i18n.cjs');
const formats = require('./formats.cjs');
const identity = require('./identity.cjs');
const workspace = require('./workspace.cjs');
const documents = require('./documents.cjs');
const diagnostics = require('./diagnostics.cjs');
const updates = require('./updates.cjs');
const support = require('./support.cjs');
const { createEgress, createElectronFetch } = require('./net/egress.cjs');
const bugReports = require('./bug-reports.cjs');
const { createJsonStore, createByteBudget, readBounded, hasStreamSeparator, renameWithRetry } = require('./store.cjs');
const readingsFormat = require('./readings.cjs');
const { createRepairStore } = require('./repair-store.cjs');

// Bound for the primary file alone and for the primary plus every companion sidecar together.
const MAX_BOARD_BYTES = 64 * 1024 * 1024;
const MAX_NOTES_BYTES = 8 * 1024 * 1024;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;
// A readings file picked for import (pack, CSV, OpenBoardData text) and a written export.
const MAX_READINGS_FILE_BYTES = 64 * 1024 * 1024;
// Bytes that concurrent reads (boards and documents together) may hold at once; a burst of opens
// can never allocate more than this, whatever the sizes of the files.
const MAX_INFLIGHT_READ_BYTES = 2 * MAX_BOARD_BYTES;
const MAX_RECENTS = 12;
const MAX_READ_CANDIDATES = 64;
const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark', layout: 'workshop', motion: true, showLabels: true, showConnections: true, updateCheck: true,
});
// Support notice (shown on every start, see src/components/SupportNotice.tsx) and the heart button of the top bar. The links (Stripe, Ko-fi and
// the support page of the project website) live HERE and nowhere else in the desktop app: the renderer sends an id over
// 'trace:open-support-link', never a URL, and only these three ids are ever opened. Bug reports stay inside the app.
const SUPPORT_LINKS = Object.freeze({
  stripe: 'https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00',
  kofi: 'https://ko-fi.com/tracerboardview',
  support: 'https://trace-boardviewer.github.io/support.html',
});
// Update notification (see electron/updates.cjs and src/components/UpdateNotice.tsx): the renderer asks 'trace:check-for-updates' and gets a bare result; it never
// sends a URL or a tag. The validated tag of the last check that found a newer release is kept HERE, and 'trace:open-update-page' opens the release page of exactly that tag.
let availableUpdateTag = null;
// GitHub allows 60 unauthenticated requests per hour per address, shared with every other GitHub client behind the same connection. So a request is spent at most
// once per UPDATE_MIN_INTERVAL_MS and, after a 403 or 429, not before the time the answer asked for (retryAfterMs of updates.cjs: a minute to an hour); until then
// every ask, from the start-up check or from Check now, gets the last answer again without a request, and asks that overlap share the one request in flight.
const UPDATE_MIN_INTERVAL_MS = 30 * 1000;
const UPDATE_MAX_INTERVAL_MS = 60 * 60 * 1000;
let nextUpdateRequestAt = 0;
let lastUpdateAnswer = { status: 'unavailable' };
let updateRequest = null;
// The network layer (electron/net/egress.cjs): the only code of the main process that makes a request. Created on first use; every feature registers there
// (the update check, for now) and its requests land in the activity log that Settings shows through the two 'trace:*-network-activity' channels below.
let egress = null;
function getEgress() {
  if (!egress) {
    const layer = createEgress({
      // The in-memory partition 'trace-egress': no cookies or cache, no permissions, no downloads, only hosts some feature may reach.
      fetchImpl: createElectronFetch({ session, isAllowed: (url) => layer.isAllowedUrl(url) }),
      version: app.getVersion(), now: () => Date.now(),
      // Read at the moment of each request from the committed settings, so a switch that was just turned off holds at once.
      isEnabled: (setting) => config.settings[setting] === true,
    });
    layer.register(updates.FEATURE);
    layer.register(support.FEATURE);
    if (bugReports.CONFIG.enabled === true) layer.register(bugReports.FEATURE);
    egress = layer;
  }
  return egress;
}
/** One request to the releases API: the answer for the renderer (status and version only), the remembered tag and the cooldown change together. */
async function requestUpdateCheck() {
  const result = await updates.checkForUpdate({ currentVersion: app.getVersion(), egress: getEgress() });
  nextUpdateRequestAt = Date.now() + Math.min(UPDATE_MAX_INTERVAL_MS, Math.max(UPDATE_MIN_INTERVAL_MS, result.retryAfterMs || 0));
  availableUpdateTag = result.status === 'available' ? result.tag : null;
  lastUpdateAnswer = result.status === 'available' ? { status: 'available', version: result.version } : { status: result.status };
  return lastUpdateAnswer;
}
// The one place that hands a URL to the operating system. Both callers build the URL from main-process data only (SUPPORT_LINKS, or RELEASE_PAGE_BASE plus a validated
// tag), never from renderer input; anything but https is refused here as a last guard.
async function openExternalUrl(url) {
  if (new URL(url).protocol !== 'https:') throw new Error('Only https links are opened.');
  await shell.openExternal(url);
}
// Errors that carry one of these codes keep the code readable by the renderer: Electron drops custom
// error properties on the way through IPC, so the message starts with "[CODE] " and preload.cjs turns it
// back into `error.code` (the clean text follows the prefix).
const PUBLIC_CODE = /^(?:DOCUMENT_|EXPORT_|WORKSPACE_|READINGS_|DIAGNOSTIC_)[A-Z_]+$|^(?:STORE_CLOSING|BOARD_CLOSING|BOARD_MISMATCH|MANIFEST_INVALID)$/;
// Language of every native message and dialog. It follows the saved setting (see loadConfig and
// trace:save-settings), so a language switch in the renderer applies here immediately.
let locale = i18n.LEGACY_LANGUAGE;
const t = (key, params) => i18n.translate(locale, key, params);
let mainWindow = null;
let config = { version: 1, settings: { ...DEFAULT_SETTINGS, language: locale }, recentBoards: [] };
// One queued atomic store for the settings, the notes and the workspaces: a single shutdown gate
// (B01) covers every write.
let store = null;
let bugReportService = null;
function getBugReportService() {
  if (!bugReportService) bugReportService = bugReports.createBugReportService({
    store: getStore(), egress: getEgress(), getVersion: () => app.getVersion(), platform: process.platform,
    arch: process.arch, locale: () => locale,
  });
  return bugReportService;
}
// The readings of every board family (electron/repair-store.cjs): its own queue, closed by the same quit sequence.
let repairStore = null;
const readBudget = createByteBudget(MAX_INFLIGHT_READ_BYTES);
const exportsInFlight = new Set();
let initialBoardPromise = null;
let startupBoardPath = null;
let trustedPageUrl = '';
let rendererReady = false;
let pendingBoardPath = null;
let boardDeliveryGeneration = 0;
const readCandidates = new Map();
let quitting = false;
let finalQuit = false;
let windowsAllowed = false; // set once the startup chain created the first window (macOS activate / open-file must not beat it)
let shutdown = null;
// A config.json that could not be read (damaged, or written by another version of the application) is kept as
// config.json.bak-<timestamp> before the first write replaces it (see preserveUnreadableConfig).
let configUnreadable = false;

// The value of '--option=value' or '--option value'. Chromium moves the switches of a second instance in front of its positional
// arguments, so the space form arrives as '--board', '--some-switch', ..., '<path>': a following switch is never the value (the
// bare path is then found by findBoardArgument).
function optionValue(argv, option) {
  const equal = argv.find((argument) => typeof argument === 'string' && argument.startsWith(`${option}=`));
  if (equal) return equal.slice(option.length + 1);
  const index = argv.indexOf(option);
  const next = index >= 0 ? argv[index + 1] : undefined;
  return typeof next === 'string' && !next.startsWith('-') ? next : null;
}

function localAbsolutePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32767 || value.includes('\0') ||
      !path.isAbsolute(value) || value.startsWith('\\\\') || value.startsWith('//')) {
    throw new Error(t('native.error.invalidPath'));
  }
  return path.normalize(value);
}

function boardPath(value) {
  const filename = localAbsolutePath(value);
  // W-fin-lifecycle-01: "host.txt:alt.cad" names an NTFS alternate data stream, not a board file.
  if (hasStreamSeparator(filename, process.platform)) throw new Error(t('native.error.invalidPath'));
  if (!formats.isSupportedExtension(filename)) {
    throw new Error(t('native.error.unsupportedFile'));
  }
  return filename;
}

// Linux launch arguments come from desktop launchers and shells: a desktop entry's %U hands over file:// URIs (a file dropped on the
// launcher, "Open with"), and a shell hands over paths relative to the directory it was started in (the .deb puts trace-boardviewer
// on the PATH). Both become an absolute path here, so the board checks that follow are the ones every other path gets; a URI of
// another host or of another scheme names no local file and gives null. Windows and macOS pass absolute paths and keep the old rule
// (absolute paths only, no URIs): there the argument comes back unchanged.
const URI_WITH_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
function argumentPath(argument, workingDirectory) {
  if (process.platform !== 'linux' || typeof argument !== 'string') return argument;
  if (/^file:\/\//i.test(argument)) {
    try {
      const url = new URL(argument);
      return url.host === '' ? fileURLToPath(url) : null; // the URL parser already turns file://localhost/ into an empty host
    } catch { return null; }
  }
  if (URI_WITH_SCHEME.test(argument)) return null;
  if (path.isAbsolute(argument)) return argument;
  return typeof workingDirectory === 'string' && path.isAbsolute(workingDirectory) ? path.resolve(workingDirectory, argument) : null;
}

// `workingDirectory` is the directory the launch was started in (this process, or the second instance), for relative arguments.
// A --board value that cannot be turned into a local path is kept as it is, so that the usual check reports it.
function findBoardArgument(argv, workingDirectory) {
  const explicit = optionValue(argv, '--board');
  if (explicit) return argumentPath(explicit, workingDirectory) ?? explicit;
  for (const raw of argv) {
    if (typeof raw !== 'string' || raw.startsWith('-')) continue;
    const argument = argumentPath(raw, workingDirectory);
    if (typeof argument === 'string' && path.isAbsolute(argument) && formats.isSupportedExtension(argument)) return argument;
  }
  return null;
}

// The working directory of this launch. process.cwd() throws when that directory was removed in the meantime.
function launchDirectory() {
  try { return process.cwd(); } catch { return undefined; }
}

// A separate profile makes development/QA runs independent of the user's saved data.
const profileOverride = optionValue(process.argv, '--user-data-dir');
if (profileOverride) {
  const directory = localAbsolutePath(profileOverride);
  fsSync.mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
} else if (process.platform === 'linux') {
  // Linux: Electron derives the default profile from package.json before this script runs, so setName below cannot move it, and a
  // builder or Electron upgrade that changed that default would leave the settings, notes and workspaces behind. Pinned instead:
  // $XDG_CONFIG_HOME/trace-boardviewer (~/.config/trace-boardviewer), created private (0700) as Chromium creates its own profile.
  const directory = path.join(app.getPath('appData'), 'trace-boardviewer');
  try {
    fsSync.mkdirSync(directory, { recursive: true, mode: 0o700 });
    app.setPath('userData', directory);
  } catch (error) {
    console.warn('TRACE: the profile directory could not be prepared; the default location is used:', error.message);
  }
}
app.setName('TRACE Boardviewer');
app.setAppUserModelId('hu.trace.boardviewer');
startupBoardPath = findBoardArgument(process.argv.slice(app.isPackaged ? 1 : 2), launchDirectory());

// Created on first use, after the profile directory is final. Once quitting began a store created
// later is born closed, so no write can slip in between the quit intent and the final quit.
function getStore() {
  if (!store) {
    store = createJsonStore({ directory: app.getPath('userData'), maxBytes: MAX_WORKSPACE_BYTES, t, fs, trusted: true });
    if (quitting) void store.beginShutdown();
  }
  return store;
}
let supportService = null;
function getSupportService() {
  if (!supportService) supportService = support.createSupportService({ store: getStore(), egress: getEgress });
  return supportService;
}
function getRepairStore() {
  if (!repairStore) {
    repairStore = createRepairStore({ directory: app.getPath('userData'), t, fs, trusted: true });
    if (quitting) void repairStore.beginShutdown();
  }
  return repairStore;
}

const nativeError = (message, code) => Object.assign(new Error(message), { code });
function validateKey(key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
    throw new Error(t('native.error.invalidBoardKey'));
  }
  return key;
}
const notesName = (key) => `notes/${validateKey(key)}.json`;

// Platform aware path identity (M01): see identity.cjs.
const pathId = (filename) => identity.pathIdentity(filename, { platform: process.platform });
const samePath = (a, b) => identity.samePath(a, b, { platform: process.platform });
// A fresh Uint8Array over the read buffer's own, exactly sized ArrayBuffer: a pooled Buffer view would
// carry unrelated memory across IPC.
const exactBytes = (buffer) => (buffer.byteOffset === 0 && buffer.buffer.byteLength === buffer.byteLength
  ? new Uint8Array(buffer.buffer, 0, buffer.byteLength) : new Uint8Array(buffer));

function settingsValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.language !== undefined && !i18n.isLanguage(value.language)) ||
      (value.updateCheck !== undefined && typeof value.updateCheck !== 'boolean') ||
      !['dark', 'light', 'system'].includes(value.theme) ||
      !['workshop', 'focus'].includes(value.layout) ||
      ['motion', 'showLabels', 'showConnections'].some((key) => typeof value[key] !== 'boolean')) {
    throw new Error(t('native.error.invalidSettings'));
  }
  return {
    // A caller that does not know about languages keeps the current one.
    language: value.language ?? locale, theme: value.theme, layout: value.layout, motion: value.motion,
    showLabels: value.showLabels, showConnections: value.showConnections,
    // A caller that predates the update check keeps the current choice.
    updateCheck: value.updateCheck ?? config.settings.updateCheck,
  };
}

// Each stored field is checked on its own, so one damaged value never resets the other settings.
function storedSettings(stored, language) {
  const field = (key, valid) => (valid(stored[key]) ? stored[key] : DEFAULT_SETTINGS[key]);
  const flag = (value) => typeof value === 'boolean';
  return {
    language,
    theme: field('theme', (value) => ['dark', 'light', 'system'].includes(value)),
    layout: field('layout', (value) => ['workshop', 'focus'].includes(value)),
    motion: field('motion', flag), showLabels: field('showLabels', flag), showConnections: field('showConnections', flag),
    // Profiles saved before the update check have no such field: they get the default (on).
    updateCheck: field('updateCheck', flag),
  };
}

// Only called after app is ready (from loadConfig): the system language is not reliable earlier.
function systemLanguages() {
  const languages = [];
  try { if (typeof app.getPreferredSystemLanguages === 'function') languages.push(...app.getPreferredSystemLanguages()); } catch { /* Fall through. */ }
  try { if (typeof app.getLocale === 'function') languages.push(app.getLocale()); } catch { /* Fall through. */ }
  return languages;
}

// Notes (pin notes and measurements included) are validated by workspace.cjs, which keeps the same
// limits as before: one note per target is an invariant (B15), so a second record for the same
// target would stay hidden in the UI and be dropped by the next save; such an array is rejected on read
// and write alike. A note's target is a key (reference and pin number, see src/lib/note-keys.ts) or, for
// notes written before keys existed, the importer's positional ids (componentId, pinId), which the
// renderer converts once when it opens the board (the validator reads both kinds in one list). Notes
// written before pin notes existed (id, componentId, text, updatedAt) are positional notes of that kind.
function notesValue(value) {
  try { return workspace.validateNotes(value); }
  catch (error) {
    if (error && error.code === 'TOO_MANY_NOTES') throw new Error(t('native.error.tooManyNotes', { max: workspace.LIMITS.notes }));
    if (error && error.code === 'NOTES_INVALID') throw new Error(t('native.error.invalidNote', { max: workspace.LIMITS.text }));
    throw error;
  }
}

// A positional note that no conversion has been tried on (a keyed note has `target`; a tried one carries `unresolved`).
const pendingPositional = (note) => note !== null && typeof note === 'object' && !Array.isArray(note) &&
  note.target === undefined && note.componentId !== undefined && note.unresolved === undefined;
// The first save that replaces positional notes by their keyed form keeps the original file beside it, once, as `<notes file>.positional.bak`
// (the store does it inside the write's own queue slot, see keepFirst in store.cjs). The renderer converts each positional id by looking it up in
// the board as the current importer reads it; the copy keeps the old ids, the only record of what the notes pointed at, so the step can be undone
// by hand. A save that still carries unconverted positional notes (an older writer) keeps nothing: nothing was converted.
const positionalNotesCopy = (name, incoming) => (incoming.some(pendingPositional) ? undefined
  : { name: `${name}.positional.bak`, when: (current) => Array.isArray(current) && current.some(pendingPositional) });

// A missing config file is a brand-new profile; an unreadable one is damaged (defaults, Hungarian UI).
const MISSING = Symbol('missing');

async function loadConfig() {
  let freshProfile = false;
  try {
    const saved = await getStore().read('config.json', { maxBytes: MAX_CONFIG_BYTES, missing: MISSING });
    if (saved === MISSING) freshProfile = true;
    else if (saved && saved.version === 1) {
      const stored = saved.settings && typeof saved.settings === 'object' && !Array.isArray(saved.settings) ? saved.settings : {};
      // A profile saved before language support (or holding an unusable value) keeps the Hungarian UI it was used with.
      const language = i18n.normalizeLanguage(stored.language) || i18n.LEGACY_LANGUAGE;
      config.settings = storedSettings(stored, language);
      if (Array.isArray(saved.recentBoards)) {
        config.recentBoards = saved.recentBoards.slice(0, MAX_RECENTS).flatMap((item) => {
          try {
            const filename = boardPath(item.path);
            if (typeof item.openedAt !== 'string' || !Number.isFinite(Date.parse(item.openedAt))) return [];
            return [{ name: path.basename(filename), path: filename, openedAt: item.openedAt }];
          } catch { return []; }
        });
      }
      // Linux: "Do not ask again" in the question about a missing Chromium sandbox (confirmUnsandboxedStart). Only a stored true counts.
      if (saved.noSandboxAccepted === true) config.noSandboxAccepted = true;
    } else configUnreadable = true; // Another version wrote it: kept aside before this one overwrites it.
  } catch {
    configUnreadable = true;
    console.warn('TRACE: the local settings could not be read; defaults were loaded instead.');
  }
  // Only a brand-new profile follows the system language; it is stored with the first config write.
  if (freshProfile) config.settings = { ...config.settings, language: i18n.detectLanguage(systemLanguages()) };
  locale = config.settings.language;
}

// Moves an unreadable config.json aside once, right before the first write and inside the store queue (no other write can slip
// in between). Best effort: a failed rename only costs the backup, never the write.
async function preserveUnreadableConfig() {
  if (!configUnreadable) return;
  configUnreadable = false;
  const filename = getStore().path('config.json');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  await fs.rename(filename, `${filename}.bak-${stamp}`).catch(() => {});
}

// The updater runs inside the store queue, in submission order, on the committed in-memory config; the
// result is written atomically and only then becomes the config.
function updateConfig(updater) {
  let next;
  return getStore().compute('config.json', async () => {
    await preserveUnreadableConfig();
    next = updater(config);
    return next;
  }, { maxBytes: MAX_CONFIG_BYTES, commit: () => { config = next; } }).then(() => undefined);
}

const superseded = () => Object.assign(new Error('superseded'), { superseded: true });

// Companion sidecars of a board file are gathered only from the primary file's own
// directory, matched by case-insensitive basename and never followed outside that directory. The plan
// lists what exists and what it weighs BEFORE any byte is allocated; a missing sibling is simply
// omitted (the parser decides what it needs). The primary and every companion together stay within
// MAX_BOARD_BYTES. `formats.companionNames` lists the siblings of whichever set member was chosen, so the
// same complete file set (and therefore the same board key, B32) results from every entry file.
async function planCompanions(primaryPath, primaryBytes) {
  const wanted = formats.companionNames(path.basename(primaryPath));
  if (!wanted.length) return { items: [], bytes: 0 };
  const directory = path.dirname(primaryPath);
  const entries = (await fs.readdir(directory)).sort();
  const items = [];
  const candidateErrors = new Map();
  for (const name of wanted) {
    const entry = entries.find((candidate) => candidate === name) ?? entries.find((candidate) => candidate.toLowerCase() === name);
    if (entry === undefined) continue;
    try {
      const canonical = await fs.realpath(path.join(directory, entry));
      if (!samePath(path.dirname(canonical), directory)) continue; // A link leaving the directory is not a sibling.
      const stat = await fs.stat(canonical);
      if (!stat.isFile()) continue; // A directory named like a sidecar is not one.
      items.push({ name, canonical, size: stat.size });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; // Removed between listing and reading.
      candidateErrors.set(name, error); // An unselected alternative must not prevent opening the chosen set.
    }
  }
  const selected = new Set(formats.companionNames(primaryPath, [path.basename(primaryPath), ...items.map((item) => item.name), ...candidateErrors.keys()]));
  for (const [name, error] of candidateErrors) if (selected.has(name)) throw error;
  const chosen = items.filter((item) => selected.has(item.name));
  let total = primaryBytes;
  for (const item of chosen) {
    if (item.size > MAX_BOARD_BYTES - total) throw new Error(t('native.error.boardTooLarge', { max: 64 }));
    total += item.size;
  }
  return { items: chosen, bytes: total - primaryBytes };
}

async function readCompanions(plan, checkpoint) {
  const companions = {};
  for (const item of plan.items) {
    let handle;
    try {
      handle = await fs.open(item.canonical, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      if (stat.size !== item.size) throw Object.assign(new Error(t('native.error.fileChangedWhileReading')), { code: 'STORE_CHANGED' });
      companions[item.name] = exactBytes(await readBounded(handle, stat.size, item.size, t, { checkpoint }));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    } finally {
      if (handle) await handle.close();
    }
  }
  return Object.keys(companions).length ? companions : null;
}

function rememberCandidate(result) {
  const candidateId = `${pathId(result.path)}\0${result.key}`;
  readCandidates.delete(candidateId);
  readCandidates.set(candidateId, { name: result.name, path: result.path, key: result.key });
  while (readCandidates.size > MAX_READ_CANDIDATES) readCandidates.delete(readCandidates.keys().next().value);
}

// `wanted` lets an external delivery that was superseded by a newer request stop at every checkpoint:
// before it opens anything, before the budget grants it memory, before the allocation and between the
// chunks of the read (B11). The bytes of all concurrent reads together stay within readBudget.
async function readBoard(filename, wanted = () => true) {
  const requested = boardPath(filename);
  const checkpoint = () => { if (!wanted()) throw superseded(); };
  let handle;
  let release = null;
  try {
    checkpoint();
    const canonical = boardPath(await fs.realpath(requested));
    checkpoint();
    handle = await fs.open(canonical, 'r');
    checkpoint();
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(t('native.error.notAFile'));
    if (stat.size > MAX_BOARD_BYTES) throw new Error(t('native.error.boardTooLarge', { max: 64 }));
    if (stat.size === 0) throw new Error(t('native.error.boardEmpty'));
    checkpoint();
    const plan = await planCompanions(canonical, stat.size);
    release = await readBudget.acquire(stat.size + plan.bytes, checkpoint);
    // The original bytes travel unchanged; the renderer parser recognizes the format and a recent is
    // only recorded after that parse succeeds (acceptBoard).
    const contents = await readBounded(handle, stat.size, MAX_BOARD_BYTES, t, { checkpoint });
    const companions = await readCompanions(plan, checkpoint);
    const key = identity.boardKey([
      { name: path.basename(canonical), data: contents },
      ...Object.entries(companions ?? {}).map(([name, data]) => ({ name, data })),
    ]);
    const result = {
      name: path.basename(canonical), path: canonical, data: exactBytes(contents),
      ...(companions ? { companions } : {}), key,
    };
    rememberCandidate(result);
    return result;
  } catch (error) {
    if (error.superseded) throw error;
    if (error.code === 'ENOENT') throw new Error(t('native.error.boardNotFound'));
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error(t('native.error.boardNotReadable'));
    // Size and change errors already carry their localized text.
    if (typeof error.code === 'string' && error.code.startsWith('STORE_')) throw new Error(error.message);
    if (error.code) throw new Error(t('native.error.boardReadFailed'));
    throw error;
  } finally {
    // The budget is returned only after the handle is closed: open handles are bounded too.
    if (handle) await handle.close();
    if (release) release();
  }
}

// Format diagnostic report (Help > Format diagnostic report, electron/diagnostics.cjs, docs/DIAGNOSTIC-REPORT.md). The main process owns both dialogs:
// the file is chosen HERE and its bytes go to the renderer's diagnostic worker under a neutral name (diagnostics.parserName: only an extension, or the
// fixed role name of a companion-set member), so that neither the name, the folder nor the user's profile ever reaches the renderer or the report.
// Nothing here touches the network or the clipboard; the report is validated against the closed schema again before the one file write.
// The dedupe code is an HMAC under a random secret of this installation (diagnostic-secret.json in the profile); the secret never leaves this file.
let diagnosticSecret = null;
function getDiagnosticSecret() {
  diagnosticSecret ??= (async () => {
    const stored = await getStore().read('diagnostic-secret.json', { maxBytes: 4096, missing: null }).catch(() => null);
    const existing = diagnostics.parseSecret(stored);
    if (existing) return existing;
    const created = diagnostics.newSecret();
    // A secret that could not be stored still serves this session; the next one makes another (codes are then no longer comparable).
    await getStore().write('diagnostic-secret.json', created, { maxBytes: 4096 }).catch(() => {});
    return diagnostics.parseSecret(created);
  })();
  return diagnosticSecret;
}

async function readDiagnosticFile(filename) {
  const requested = localAbsolutePath(filename);
  if (hasStreamSeparator(requested, process.platform)) throw new Error(t('native.error.invalidPath'));
  let handle;
  let release = null;
  try {
    const canonical = await fs.realpath(requested);
    if (hasStreamSeparator(canonical, process.platform)) throw new Error(t('native.error.invalidPath'));
    handle = await fs.open(canonical, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(t('native.error.notAFile'));
    if (stat.size > MAX_BOARD_BYTES) throw new Error(t('native.error.boardTooLarge', { max: 64 }));
    const plan = await planCompanions(canonical, stat.size);
    release = await readBudget.acquire(stat.size + plan.bytes, diagnosticOpen);
    const contents = await readBounded(handle, stat.size, MAX_BOARD_BYTES, t, { checkpoint: diagnosticOpen });
    const companions = await readCompanions(plan, diagnosticOpen);
    const base = path.basename(canonical);
    const member = formats.companionNames(base).length > 0;
    // A single file is identified by its bytes alone (a renamed copy gives the same code); a set by its members' roles and bytes.
    const code = diagnostics.dedupeCode(await getDiagnosticSecret(), [
      { name: member ? base : '', data: contents },
      ...Object.entries(companions ?? {}).map(([name, data]) => ({ name, data })),
    ]);
    return { name: diagnostics.parserName(base, member), data: exactBytes(contents), ...(companions ? { companions } : {}), os: diagnostics.osFamily(process.platform), dedupe: code };
  } catch (error) {
    if (error.code === 'DIAGNOSTIC_CLOSING') throw error;
    if (error.code === 'ENOENT') throw new Error(t('native.error.boardNotFound'));
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error(t('native.error.boardNotReadable'));
    if (typeof error.code === 'string' && error.code.startsWith('STORE_')) throw new Error(error.message);
    if (error.code) throw new Error(t('native.error.boardReadFailed'));
    throw error;
  } finally {
    if (handle) await handle.close();
    if (release) release();
  }
}

async function pickDiagnosticFile() {
  diagnosticOpen();
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: t('native.dialog.diagnosticPickTitle'), buttonLabel: t('native.dialog.diagnosticPickButton'), properties: ['openFile'],
    // Any file may be diagnosed (an unrecognized one is the usual reason): "all files" first, then the format filters.
    filters: [{ name: t('native.dialog.diagnosticAllFiles'), extensions: ['*'] }, ...formats.dialogFilters(t('native.dialog.openFilter'))],
  });
  if (choice.canceled || !choice.filePaths[0]) return null;
  diagnosticOpen();
  return readDiagnosticFile(choice.filePaths[0]);
}

async function saveDiagnosticReport(report) {
  diagnosticOpen();
  let text;
  try { text = diagnostics.serializeReport(diagnostics.validateReport(report, { reviewed: true })); }
  catch (error) {
    console.warn('TRACE: a diagnostic report was refused:', error && error.message); // names a field, never a value
    throw nativeError(t('native.error.diagnosticInvalid'), 'DIAGNOSTIC_INVALID');
  }
  diagnosticOpen(); // no await since the check: the last look before the dialog opens
  const choice = await dialog.showSaveDialog(mainWindow, {
    title: t('native.dialog.diagnosticSaveTitle'), buttonLabel: t('native.dialog.diagnosticSaveButton'),
    // A bare name: the dialog starts where the user last saved, not next to the file that was examined.
    defaultPath: 'trace-format-diagnostic.json', filters: [{ name: t('native.dialog.diagnosticSaveFilter'), extensions: ['json'] }],
  });
  if (choice.canceled || !choice.filePath) return null;
  diagnosticOpen();
  const target = /\.json$/i.test(choice.filePath) ? choice.filePath : `${choice.filePath}.json`;
  const work = fs.writeFile(target, text, 'utf8');
  exportsInFlight.add(work);
  try { await work; }
  catch { throw nativeError(t('native.error.diagnosticWriteFailed'), 'DIAGNOSTIC_WRITE_FAILED'); }
  finally { exportsInFlight.delete(work); }
  return { bytes: Buffer.byteLength(text, 'utf8') };
}


function acceptBoard(filename, key) {
  const checkedPath = boardPath(filename);
  const checkedKey = validateKey(key);
  const candidate = readCandidates.get(`${pathId(checkedPath)}\0${checkedKey}`);
  if (!candidate) throw new Error(t('native.error.boardNotVerified'));
  return updateConfig((current) => ({
    ...current,
    recentBoards: [
      { name: candidate.name, path: candidate.path, openedAt: new Date().toISOString() },
      ...current.recentBoards.filter((item) => !samePath(item.path, candidate.path)),
    ].slice(0, MAX_RECENTS),
  }));
}

function isTrustedUrl(value) {
  try {
    const received = new URL(value);
    const expected = new URL(trustedPageUrl);
    return received.protocol === expected.protocol && received.origin === expected.origin &&
      received.pathname === expected.pathname && received.search === expected.search;
  } catch { return false; }
}

function trustedSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame && isTrustedUrl(event.senderFrame.url));
}

function allowClipboardWrite(contents, permission, details) {
  return Boolean(permission === 'clipboard-sanitized-write' && mainWindow && !mainWindow.isDestroyed() &&
    contents === mainWindow.webContents && details?.isMainFrame === true &&
    isTrustedUrl(details.requestingUrl) && isTrustedUrl(contents.mainFrame.url));
}

function exposeCode(error) {
  const code = error && error.code;
  if (typeof code !== 'string' || !PUBLIC_CODE.test(code) || typeof error.message !== 'string') return error;
  return Object.assign(new Error(`[${code}] ${error.message}`, { cause: error }), { code });
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) throw new Error(t('native.error.untrustedSender'));
    try { return await callback(...args); } catch (error) { throw exposeCode(error); }
  });
}

// A new renderer intent or external open makes every older external delivery obsolete, including
// those still waiting for read budget.
function supersedeDeliveries() {
  const generation = ++boardDeliveryGeneration;
  readBudget.poke();
  return generation;
}

async function loadManifest(key) {
  let raw;
  try { raw = await getStore().read(workspace.manifestName(key), { maxBytes: MAX_WORKSPACE_BYTES }); }
  catch {
    throw nativeError('The saved workspace cannot be read. The existing file was left unchanged.', 'WORKSPACE_UNREADABLE'); // i18n: pending
  }
  // BOARD_MISMATCH / MANIFEST_INVALID: a manifest of another board or a damaged one is never returned.
  return raw === null ? null : workspace.validateManifest(raw, key);
}

function pickOptions(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value) || (value.multiple !== undefined && typeof value.multiple !== 'boolean')) {
    throw nativeError('Invalid document options.', 'DOCUMENT_INVALID_OPTIONS'); // i18n: pending
  }
  return { kinds: value.kinds, multiple: value.multiple };
}

function documentContext(extra) {
  return { t, fs, budget: readBudget, platform: process.platform, ...extra };
}

function exportRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.documentIds) ||
      value.documentIds.length > workspace.LIMITS.documents ||
      value.documentIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > workspace.LIMITS.id) ||
      typeof value.includeBoard !== 'boolean' || typeof value.includeNotes !== 'boolean') {
    throw nativeError('Invalid workspace export request.', 'EXPORT_INVALID_REQUEST'); // i18n: pending
  }
  return { key: validateKey(value.boardKey), documentIds: [...value.documentIds], includeBoard: value.includeBoard, includeNotes: value.includeNotes };
}

// "Check, await, act" is a race once the quit intent can arrive in between: every intent that opens a dialog or starts
// work looks at `quitting` again after each awaited step and right before it acts, never only on entry.
function refuseWhenClosing(code, message) {
  if (quitting) throw nativeError(message, code);
}
const exportOpen = () => refuseWhenClosing('EXPORT_CLOSING', 'The application is closing; the export was not started.'); // i18n: pending
const boardOpen = () => refuseWhenClosing('BOARD_CLOSING', 'The application is closing; no board was opened.'); // i18n: pending
const documentsOpen = () => refuseWhenClosing('DOCUMENT_CLOSING', 'The application is closing; no document was attached.'); // i18n: pending
const diagnosticOpen = () => refuseWhenClosing('DIAGNOSTIC_CLOSING', t('native.error.diagnosticClosing'));

async function exportWorkspace(value) {
  const request = exportRequest(value);
  exportOpen();
  const manifest = await loadManifest(request.key);
  exportOpen();
  if (!manifest) throw nativeError('Save the workspace before exporting it.', 'WORKSPACE_NOT_FOUND'); // i18n: pending
  const notes = request.includeNotes ? notesValue(await getStore().read(notesName(request.key), { maxBytes: MAX_NOTES_BYTES, missing: [] })) : null;
  const stem = documents.safeFileName(path.parse(manifest.board.name).name, 'workspace');
  exportOpen(); // no await since the notes load: this is the last look before the dialog opens
  const choice = await dialog.showSaveDialog(mainWindow, {
    title: 'Export workspace', buttonLabel: 'Export', // i18n: pending
    defaultPath: path.isAbsolute(manifest.board.path) ? path.join(path.dirname(manifest.board.path), `${stem}-workspace.zip`) : `${stem}-workspace.zip`,
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }], // i18n: pending
  });
  if (choice.canceled || !choice.filePath) return null;
  // The dialog may have been open when the quit intent arrived; an answer after it starts nothing. From here on the
  // export is registered (exportsInFlight) and the quit waits for it.
  exportOpen();
  const target = /\.zip$/i.test(choice.filePath) ? choice.filePath : `${choice.filePath}.zip`;
  const work = (async () => {
    let boardFiles = null;
    if (request.includeBoard) {
      const board = await readBoard(manifest.board.path);
      if (board.key !== request.key) throw nativeError('The board file changed since the workspace was saved; it cannot be bundled.', 'EXPORT_BOARD_CHANGED'); // i18n: pending
      boardFiles = [
        { name: board.name, path: board.path, primary: true, data: board.data },
        ...Object.entries(board.companions ?? {}).map(([name, data]) => ({ name, path: path.join(path.dirname(board.path), name), data })),
      ];
    }
    return documents.exportBundle({
      manifest, notes, documentIds: request.documentIds, includeBoard: request.includeBoard, boardFiles, target, t, fs, platform: process.platform,
    });
  })();
  exportsInFlight.add(work);
  try { return await work; } finally { exportsInFlight.delete(work); }
}

// Readings (docs/READINGS_FORMAT.md). The renderer never names a path: import and export go through dialogs that main opens, the import
// returns the file's base name and text only (the renderer parses it with src/lib/readings and appends the events, which the repair
// store validates natively again), and an export is a pack the renderer built that main validates and writes itself.
const readingsOpen = () => refuseWhenClosing('READINGS_CLOSING', t('native.error.readingsClosing'));
const readingsError = (message, code) => nativeError(message, code);

async function importReadings() {
  readingsOpen();
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: t('native.dialog.readingsImportTitle'), buttonLabel: t('native.dialog.readingsImportButton'), properties: ['openFile'],
    filters: [{ name: t('native.dialog.readingsImportFilter'), extensions: ['json', 'csv', 'tsv', 'txt'] }, { name: t('native.dialog.allFiles'), extensions: ['*'] }],
  });
  if (choice.canceled || !choice.filePaths[0]) return null;
  readingsOpen();
  const filename = localAbsolutePath(choice.filePaths[0]);
  if (hasStreamSeparator(filename, process.platform)) throw new Error(t('native.error.invalidPath'));
  let handle;
  let release = null;
  try {
    handle = await fs.open(filename, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw readingsError(t('native.error.notAFile'), 'READINGS_NOT_A_FILE');
    if (stat.size > MAX_READINGS_FILE_BYTES) throw readingsError(t('native.error.fileLimitExceeded'), 'READINGS_FILE_TOO_LARGE');
    release = await readBudget.acquire(stat.size);
    const bytes = await readBounded(handle, stat.size, MAX_READINGS_FILE_BYTES, t);
    const text = readingsFormat.decodeImportText(bytes);
    if (text === null) throw readingsError(t('native.error.readingsNotText'), 'READINGS_NOT_TEXT');
    return { name: path.basename(filename), bytes: bytes.length, text };
  } catch (error) {
    if (error && typeof error.code === 'string' && error.code.startsWith('READINGS_')) throw error;
    if (error && typeof error.code === 'string' && error.code.startsWith('STORE_')) throw readingsError(error.message, 'READINGS_FILE_UNREADABLE');
    throw readingsError(t('native.error.readingsFileUnreadable'), 'READINGS_FILE_UNREADABLE');
  } finally {
    if (handle) await handle.close();
    if (release) release();
  }
}

function readingsExportRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['pack', 'csv'].includes(value.format) ||
      (value.name !== undefined && (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 120))) {
    throw readingsError(t('native.error.readingsInvalidRequest'), 'READINGS_INVALID_REQUEST');
  }
  // READINGS_INVALID / READINGS_TOO_MANY: the native twin of validatePack, licence marking included.
  return { format: value.format, pack: readingsFormat.validatePack(value.pack), name: value.name };
}

async function exportReadings(value) {
  const request = readingsExportRequest(value);
  const text = request.format === 'csv' ? readingsFormat.packToCsv(request.pack) : readingsFormat.serializePack(request.pack);
  const data = Buffer.from(text, 'utf8');
  if (data.length > MAX_READINGS_FILE_BYTES) throw readingsError(t('native.error.readingsTooLarge', { max: 64 }), 'READINGS_TOO_LARGE');
  readingsOpen();
  const stem = documents.safeFileName(request.name ?? request.pack.board.label ?? request.pack.title ?? 'readings', 'readings');
  const extension = request.format === 'csv' ? 'csv' : 'json';
  const choice = await dialog.showSaveDialog(mainWindow, {
    title: t('native.dialog.readingsExportTitle'), buttonLabel: t('native.dialog.readingsExportButton'),
    defaultPath: request.format === 'csv' ? `${stem}.csv` : `${stem}.trace-readings.json`,
    filters: [{ name: request.format === 'csv' ? t('native.dialog.readingsCsvFilter') : t('native.dialog.readingsPackFilter'), extensions: [extension] }],
  });
  if (choice.canceled || !choice.filePath) return null;
  readingsOpen();
  const chosen = localAbsolutePath(choice.filePath);
  if (hasStreamSeparator(chosen, process.platform)) throw new Error(t('native.error.invalidPath'));
  const target = chosen.toLowerCase().endsWith(`.${extension}`) ? chosen : `${chosen}.${extension}`;
  const work = (async () => {
    const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await renameWithRetry(fs, temporary, target);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw readingsError(t('native.error.dataSaveFailed'), 'READINGS_SAVE_FAILED');
    }
    return { name: path.basename(target), bytes: data.length, readings: request.pack.readings.length };
  })();
  exportsInFlight.add(work);
  try { return await work; } finally { exportsInFlight.delete(work); }
}

function readingsReadOptions(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value) || (value.headerOnly !== undefined && typeof value.headerOnly !== 'boolean')) {
    throw readingsError(t('native.error.readingsInvalidRequest'), 'READINGS_INVALID_REQUEST');
  }
  return { headerOnly: value.headerOnly === true };
}

// Close/quit flush (W-fin-lifecycle-02, W-fin-documents-01). The renderer saves the workspace after a 400 ms quiet
// period and owns the timer that retries a failed write; `pagehide` comes too late for app.quit() and a destroyed
// renderer cannot retry. Before the window is destroyed and before the store starts shutting down, main therefore asks
// the renderer to write what it still holds ('trace:flush-request', preload.cjs onFlushRequest) and waits - bounded - for
// its answer ('trace:flush-done') and for the store queue (the rename retry included) to drain. The wait is bounded so
// a hung renderer can never keep the window or the app open; the quit itself still drains the store without a bound.
const FLUSH_TIMEOUT_MS = 1000;
const flushWaiters = new Map();
let flushSequence = 0;

// Resolves when `work` settles or after `ms`, whichever comes first; never rejects, leaves no timer behind.
function boundedWait(work, ms) {
  let timer;
  return Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, ms); })])
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

// A renderer that has not started (no board can be open yet) or is gone has nothing to flush.
function rendererFlushable(window) {
  if (!window || mainWindow !== window || !rendererReady || window.isDestroyed()) return false;
  const contents = window.webContents;
  return !(contents.isDestroyed?.() || contents.isCrashed?.());
}

// Resolves once the renderer's pending saves reached the disk or the bounded wait elapsed; never rejects.
async function flushForClose(window) {
  const id = ++flushSequence;
  let acknowledge;
  const answered = new Promise((resolve) => { acknowledge = resolve; });
  flushWaiters.set(id, acknowledge);
  const work = (async () => {
    try {
      window.webContents.send('trace:flush-request', id);
      await answered;
    } catch { /* A renderer that cannot be reached has nothing left to flush. */ }
    if (store) await store.flush(); // The writes the renderer just issued, rename retries included.
    if (repairStore) await repairStore.flush();
  })();
  await boundedWait(work, FLUSH_TIMEOUT_MS);
  flushWaiters.delete(id);
}

function installIpc() {
  ipcMain.on('trace:flush-done', (event, id) => {
    if (!trustedSender(event) || !Number.isSafeInteger(id)) return;
    flushWaiters.get(id)?.();
  });
  handle('trace:open-board', async () => {
    boardOpen();
    supersedeDeliveries();
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: t('native.dialog.openTitle'), buttonLabel: t('native.dialog.openButton'), properties: ['openFile'],
      filters: formats.dialogFilters(t('native.dialog.openFilter'), t('native.dialog.allFiles')),
    });
    if (choice.canceled || !choice.filePaths[0]) return null;
    boardOpen();
    return readBoard(choice.filePaths[0]);
  });
  handle('trace:read-board', (filename) => { supersedeDeliveries(); return readBoard(filename); });
  handle('trace:accept-board', acceptBoard);
  handle('trace:initial-board', () => {
    rendererReady = true;
    if (!initialBoardPromise) {
      initialBoardPromise = (async () => {
        if (startupBoardPath) {
          const requested = startupBoardPath;
          try { return { ...await readBoard(requested), startupSource: 'argument' }; }
          catch (error) {
            // The file named at launch cannot be opened: the renderer gets the error (its start-up toast), the file is forgotten so
            // that a later call restores a recent board like a plain start, and the last readable recent follows right away.
            startupBoardPath = null;
            initialBoardPromise = null;
            void restoreRecentBoard();
            throw error;
          }
        }
        // Skip moved/deleted files when restoring the last available board.
        for (const recent of config.recentBoards) {
          try { return { ...await readBoard(recent.path), startupSource: 'recent' }; } catch { /* Try the next recent. */ }
        }
        return null;
      })();
    }
    if (pendingBoardPath) {
      const pending = pendingBoardPath;
      pendingBoardPath = null;
      void deliverBoard(pending);
    }
    return initialBoardPromise;
  });
  handle('trace:recent-boards', () => config.recentBoards.map((item) => ({ ...item })));
  handle('trace:get-settings', () => ({ ...config.settings }));
  handle('trace:save-settings', (settings) => {
    const checked = settingsValue(settings);
    // Native messages and dialogs switch together with the renderer, before the write completes.
    locale = checked.language;
    return updateConfig((current) => ({ ...current, settings: checked }));
  });
  handle('trace:get-notes', async (key) => {
    const name = notesName(key);
    try { return notesValue(await getStore().read(name, { maxBytes: MAX_NOTES_BYTES, missing: [] })); }
    catch { throw new Error(t('native.error.notesUnreadable')); }
  });
  handle('trace:save-notes', async (key, notes) => {
    const name = notesName(key);
    const checked = notesValue(notes);
    const keepFirst = positionalNotesCopy(name, checked);
    try { await getStore().write(name, checked, { maxBytes: MAX_NOTES_BYTES, ...(keepFirst ? { keepFirst } : {}) }); }
    catch (error) {
      if (error && error.code === 'STORE_TOO_LARGE') throw new Error(t('native.error.notesTooLarge', { max: 8 }));
      throw error;
    }
  });
  handle('trace:load-workspace', (key) => loadManifest(validateKey(key)));
  handle('trace:save-workspace', async (key, manifest) => {
    const checkedKey = validateKey(key);
    const checked = workspace.validateManifest(manifest, checkedKey);
    await getStore().write(workspace.manifestName(checkedKey), checked, { maxBytes: MAX_WORKSPACE_BYTES });
  });
  handle('trace:pick-documents', async (options) => {
    const { kinds, multiple } = pickOptions(options);
    documentsOpen();
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach documents', buttonLabel: 'Attach', // i18n: pending
      properties: multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
      filters: documents.dialogFilters(kinds),
    });
    if (choice.canceled || !choice.filePaths.length) return [];
    documentsOpen();
    return documents.readSelection(choice.filePaths, documentContext({ kinds }));
  });
  handle('trace:read-document', async (filename, options) => {
    const { kinds } = pickOptions(options);
    return (await documents.readSelection([filename], documentContext({ kinds })))[0];
  });
  handle('trace:locate-documents', (boardFile, requests) => documents.locateDocuments(boardFile, requests, documentContext()));
  handle('trace:export-workspace', exportWorkspace);
  // Format diagnostic report: the first takes no argument (main opens the dialog), the second only the report object, which is validated again here.
  handle('trace:diagnostic-pick', () => pickDiagnosticFile());
  handle('trace:diagnostic-save', (report) => saveDiagnosticReport(report));
  // Bug reports are prepared and sent by the main process. The renderer can name only a short-lived handle;
  // it cannot provide a URL, request body, headers, report id or app metadata.
  handle('trace:bug-report-prepare', (request) => getBugReportService().prepare(request));
  handle('trace:bug-report-send', (request) => getBugReportService().send(request));
  handle('trace:bug-report-cancel', (request) => getBugReportService().cancel(request));
  handle('trace:bug-report-draft-get', () => getBugReportService().getDraft());
  handle('trace:bug-report-draft-save', (request) => getBugReportService().saveDraft(request));
  handle('trace:bug-report-draft-discard', () => getBugReportService().discardDraft());
  // Readings (repair store): families are named by their 64-hex id; every event is validated natively before it is written.
  handle('trace:list-readings-families', () => getRepairStore().list());
  handle('trace:read-readings', (familyId, options) => getRepairStore().read(familyId, readingsReadOptions(options)));
  handle('trace:append-readings', (familyId, events) => getRepairStore().append(familyId, events));
  handle('trace:import-readings', importReadings);
  handle('trace:export-readings', exportReadings);
  // Developer-facing text on purpose: the renderer only ever sends the four fixed ids, so users never see this message.
  handle('trace:open-support-link', async (id) => {
    if (typeof id !== 'string' || !Object.hasOwn(SUPPORT_LINKS, id)) throw new Error('Unknown support link.');
    let url = SUPPORT_LINKS[id];
    if (id === 'stripe') {
      try {
        const reference = await getSupportService().prepare();
        if (reference?.available === true && typeof reference.code === 'string' && /^[a-f0-9]{32}$/.test(reference.code)) url += '?client_reference_id=' + reference.code;
      } catch { /* The fixed Stripe page still opens when local reference storage is unavailable. */ }
    }
    await openExternalUrl(url);
  });
  handle('trace:get-support-status', () => getSupportService().status());
  handle('trace:prepare-support', () => getSupportService().prepare());
  handle('trace:check-support', () => getSupportService().check());
  // No renderer argument is read by either update handler. Developer-facing text on purpose, like the support link above.
  handle('trace:check-for-updates', () => {
    const wait = nextUpdateRequestAt - Date.now();
    // Inside the cooldown the last answer is repeated. A wait longer than any cooldown ever set can only come from a clock that was set back: it is dropped.
    if (wait > 0 && wait <= UPDATE_MAX_INTERVAL_MS) return lastUpdateAnswer;
    if (!updateRequest) updateRequest = requestUpdateCheck().finally(() => { updateRequest = null; });
    return updateRequest;
  });
  handle('trace:open-update-page', async () => {
    if (!availableUpdateTag) throw new Error('No update available.');
    await openExternalUrl(updates.RELEASE_PAGE_BASE + availableUpdateTag);
  });
  // Network activity (Settings > Network): the registered features and the in-memory log of every request, read-only; the one write is emptying the log.
  // Neither handler reads a renderer argument, and no channel lets the renderer name a URL, a feature or a host.
  handle('trace:get-network-activity', () => ({ features: getEgress().features(), ...getEgress().activity() }));
  handle('trace:clear-network-activity', () => { getEgress().clearLog(); });
  handle('trace:is-maximized', () => mainWindow.isMaximized());
  for (const [channel, action] of [
    ['trace:minimize', () => mainWindow.minimize()],
    ['trace:maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()],
    ['trace:close', () => mainWindow.close()],
  ]) {
    ipcMain.on(channel, (event) => { if (trustedSender(event)) action(); });
  }
}

// Session-wide policy, installed once like the IPC: the default session outlives every window, so a window created again (macOS
// activate / open-file) must not add another copy of each listener. The sanitized clipboard write is the only permission ever
// granted, and only to the trusted main document; no download ever starts.
function installSession() {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowClipboardWrite(contents, permission, details));
  });
  defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => allowClipboardWrite(contents, permission, details));
  defaultSession.on('will-download', (event) => event.preventDefault());
}

// After a failed start-up file: the first readable recent board reaches the renderer over 'trace:board-opened', as a plain start
// would have restored it, once the renderer holds the rejection of 'trace:initial-board' (the send follows at least one file
// operation, the reply does not). The delivery supersedes nothing: any newer open, external or from the renderer, stops it at its
// next checkpoint, and a recent that is gone is skipped without a dialog.
async function restoreRecentBoard() {
  const targetWindow = mainWindow;
  const generation = boardDeliveryGeneration;
  const current = () => !quitting && generation === boardDeliveryGeneration && rendererReady &&
    Boolean(targetWindow) && mainWindow === targetWindow && !targetWindow.isDestroyed();
  for (const recent of config.recentBoards) {
    if (!current()) return;
    try {
      const payload = await readBoard(recent.path, current);
      if (current()) targetWindow.webContents.send('trace:board-opened', { ...payload, startupSource: 'recent' });
      return;
    } catch (error) {
      if (error.superseded) return;
      // Try the next recent.
    }
  }
}

async function deliverBoard(filename) {
  if (quitting) return;
  const generation = supersedeDeliveries();
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) {
    pendingBoardPath = filename;
    return;
  }
  const targetWindow = mainWindow;
  const current = () => generation === boardDeliveryGeneration && mainWindow === targetWindow && !targetWindow.isDestroyed();
  try {
    // A burst of external opens (second-instance / open-file) is coalesced: latest wins and every older
    // delivery stops at its next checkpoint, before allocating and during the read.
    const payload = await readBoard(filename, current);
    if (current()) targetWindow.webContents.send('trace:board-opened', payload);
  } catch (error) {
    // A failed delivery that outlived the quit intent must not open a message box on a closing app.
    if (current() && !quitting) {
      await dialog.showMessageBox(targetWindow, { type: 'error', title: t('native.dialog.openFailedTitle'), message: error.message });
    }
  }
}

// A window whose page never paints (a renderer gone before its first frame, a document request that never answers) would stay
// hidden for ever while the process holds the single-instance lock: every further launch would exit at once and nothing would
// appear. After this long the window is shown as it is.
const FALLBACK_SHOW_MS = 4000;

// The window icon. X11 task bars and Alt+Tab show it where no installed desktop entry matches the window (an AppImage without desktop
// integration); under Wayland the desktop entry is the only source. On Linux nativeImage decodes PNG (ICO is a Windows format), and
// 256 px keeps the X11 icon property small. Windows keeps the ICO; macOS ignores the option.
function windowIcon() {
  if (process.platform !== 'linux') return path.join(__dirname, '..', 'assets', 'icon.ico');
  const file = path.join(__dirname, '..', 'assets', 'icon.png');
  let image = nativeImage.createFromPath(file);
  // Inside app.asar the path may not decode on every platform; Node's fs reads the archive, so decode the bytes instead.
  if (image.isEmpty() && typeof nativeImage.createFromBuffer === 'function') {
    try { image = nativeImage.createFromBuffer(fsSync.readFileSync(file)); } catch { /* keep the empty image */ }
  }
  return image.isEmpty() ? undefined : image.resize({ width: 256, height: 256, quality: 'best' });
}

function createWindow() {
  rendererReady = false;
  const icon = windowIcon();
  initialBoardPromise = null;
  const developmentUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : null;
  if (developmentUrl) {
    const candidate = new URL(developmentUrl);
    if (candidate.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(candidate.hostname) || candidate.username || candidate.password) {
      throw new Error(t('native.error.devServerNotLocal'));
    }
    trustedPageUrl = candidate.href;
  } else {
    trustedPageUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
  }
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 960, minHeight: 640,
    title: 'TRACE Boardviewer', backgroundColor: '#11161d', frame: false,
    show: false, icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, spellcheck: false,
    },
  });
  const window = mainWindow;
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!isTrustedUrl(url)) event.preventDefault(); });
  mainWindow.webContents.on('will-redirect', (event, url) => { if (!isTrustedUrl(url)) event.preventDefault(); });
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) bugReportService?.invalidateWindow();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.on('maximize', () => mainWindow.webContents.send('trace:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('trace:maximized', false));
  const showWindow = () => {
    if (quitting || mainWindow !== window || window.isDestroyed() || window.isVisible()) return;
    window.show();
    // X11 keeps the icon only on a mapped window under some window managers; set it again once the window is shown.
    if (process.platform === 'linux' && icon && typeof window.setIcon === 'function') window.setIcon(icon);
  };
  const fallbackShow = setTimeout(showWindow, FALLBACK_SHOW_MS);
  window.once('ready-to-show', () => { clearTimeout(fallbackShow); showWindow(); });
  const loadPage = () => window.loadURL(trustedPageUrl).catch((error) => {
    // Closing during startup aborts navigation; that is a normal shutdown.
    if (quitting || window.isDestroyed() || mainWindow !== window) return;
    console.error('TRACE: the user interface could not be loaded:', error.message);
    dialog.showErrorBox(t('native.dialog.startupErrorTitle'), t('native.dialog.startupLoadFailed'));
    app.quit();
  });
  // A renderer that is gone (crashed, killed, out of memory) leaves a frameless window with nothing in it and no controls; a clean
  // exit, a window on its way out and a quit in progress are not failures. The user is told, then the page is loaded again with the
  // start-up state reset, so the new renderer announces itself through 'trace:initial-board' like the first one did and an external
  // open that arrives meanwhile waits for it (pendingBoardPath).
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details?.reason === 'clean-exit' || quitting || mainWindow !== window || window.isDestroyed()) return;
    rendererReady = false;
    initialBoardPromise = null;
    void dialog.showMessageBox(window, { type: 'error', title: app.name, message: t('native.dialog.rendererGone') })
      .then(() => { if (!quitting && mainWindow === window && !window.isDestroyed()) void loadPage(); });
  });
  // A renderer that stopped answering (a parser stuck on a hostile file, a huge board on a slow machine) can be given more time or
  // closed. One dialog per hang. Closing a renderer that is still hung skips the close-time flush it could not answer anyway; one
  // that recovered while the dialog was open is flushed like any other.
  let hung = false;
  let hangDialog = null;
  window.webContents.on('responsive', () => { hung = false; });
  window.webContents.on('unresponsive', () => {
    hung = true;
    if (hangDialog || quitting || mainWindow !== window || window.isDestroyed()) return;
    hangDialog = dialog.showMessageBox(window, {
      type: 'warning', title: app.name, message: t('native.dialog.unresponsive'),
      buttons: [t('native.dialog.unresponsiveWait'), t('native.dialog.unresponsiveClose')], defaultId: 0, cancelId: 0, noLink: true,
    }).then((answer) => {
      hangDialog = null;
      if (answer?.response !== 1 || window.isDestroyed()) return;
      if (hung && mainWindow === window) rendererReady = false;
      window.close();
    });
  });
  // The first close request is held back until the renderer's pending saves are written (bounded, see
  // flushForClose), then the window closes for real. A quit in progress (finalQuit) has already flushed.
  let closeApproved = false;
  let closeFlush = null;
  window.on('close', (event) => {
    if (closeApproved || finalQuit || !rendererFlushable(window)) return;
    event.preventDefault();
    closeFlush ??= flushForClose(window).then(() => {
      closeApproved = true;
      if (!window.isDestroyed()) window.close();
    });
  });
  window.on('closed', () => {
    clearTimeout(fallbackShow);
    bugReportService?.invalidateWindow();
    if (mainWindow === window) { mainWindow = null; rendererReady = false; }
  });
  void loadPage();
}

// macOS routes Cmd+Q, Cmd+H, Cmd+M, Cmd+W and the Edit key equivalents through the application menu, and
// setApplicationMenu(null) leaves Electron's default menu in place there, View > Reload and Toggle Developer Tools
// included. A minimal menu replaces it: the application, Edit and Window menus with their standard roles only, no
// View and no Help (the role menus would add Services, Speech and the window list). Windows and Linux keep no menu bar.
function applicationMenu() {
  if (process.platform !== 'darwin') return null;
  return Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }, // i18n: pending
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] }, // i18n: pending
  ]);
}

// Linux sandbox gate. Chromium's OS sandbox (a user and PID namespace, or the SUID helper, plus a seccomp-bpf filter) confines every
// renderer. On Linux it is off exactly when the browser process carries the switch --no-sandbox; without the switch Chromium refuses
// to start where it finds no usable sandbox. The AppImage launcher adds the switch by itself when the system forbids unprivileged user
// namespaces (Ubuntu 23.10 and newer); the .deb keeps the sandbox through an AppArmor profile. The switch is read from Chromium's own
// parsed command line (app.commandLine), the one Chromium acts on, not from process.argv: argv misses the switch Electron adds for
// ELECTRON_DISABLE_SANDBOX and the single-dash spelling, and would count a --no-sandbox after a "--" terminator (checked with
// Electron 44 on Windows, whose process metrics report the sandbox state: hasSwitch matched it in each of these cases).
// Nothing runs unsandboxed without a decision: Quit is the default and the answer to Esc or to closing the box. TRACE_ACCEPT_NO_SANDBOX=1
// (scripts, CI) or an earlier "Do not ask again" (noSandboxAccepted in config.json) skips the question; the warning line is always
// written to stderr. Windows and macOS are never asked.
const NO_SANDBOX_WARNING = 'TRACE: running without the Chromium sandbox (--no-sandbox).';
// 'start': sandboxed or not Linux; 'accepted': unsandboxed and already agreed to; 'ask': unsandboxed, the user decides.
function sandboxGate({ platform, noSandbox, acceptEnvironment, accepted }) {
  if (platform !== 'linux' || noSandbox !== true) return 'start';
  return acceptEnvironment === '1' || accepted === true ? 'accepted' : 'ask';
}

// Resolves true when the start-up may go on, false when the user chose to quit. Runs after loadConfig (the stored answer and the
// language) and before any window or IPC exists.
async function confirmUnsandboxedStart() {
  const decision = sandboxGate({
    platform: process.platform, noSandbox: process.platform === 'linux' && app.commandLine.hasSwitch('no-sandbox'),
    acceptEnvironment: process.env.TRACE_ACCEPT_NO_SANDBOX, accepted: config.noSandboxAccepted,
  });
  if (decision === 'start') return true;
  console.warn(NO_SANDBOX_WARNING);
  if (decision === 'accepted') return true;
  const answer = await dialog.showMessageBox({
    type: 'warning', title: app.name, noLink: true, defaultId: 0, cancelId: 0,
    buttons: [t('native.dialog.noSandboxQuit'), t('native.dialog.noSandboxStart')],
    checkboxLabel: t('native.dialog.noSandboxRemember'), checkboxChecked: false,
    message: t('native.dialog.noSandboxMessage'),
    detail: `${t('native.dialog.noSandboxRisk')}\n\n${t('native.dialog.noSandboxAdvice')}`,
  });
  if (answer?.response !== 1) return false;
  if (answer.checkboxChecked === true) {
    // Stored with the settings. A failed write only means that the question comes again at the next start.
    await updateConfig((current) => ({ ...current, noSandboxAccepted: true }))
      .catch((error) => console.warn('TRACE: the answer could not be saved:', error.message));
  }
  return true;
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const filename = findBoardArgument(argv.slice(app.isPackaged ? 1 : 2), workingDirectory);
    if (filename) void deliverBoard(filename);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      // A window still waiting for its first paint is shown as it is: a second launch must never leave nothing on screen.
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on('open-file', (event, filename) => {
    event.preventDefault();
    if (!app.isReady()) startupBoardPath = filename;
    else {
      void deliverBoard(filename);
      // macOS keeps the process alive without a window: the board waits in pendingBoardPath for the new renderer.
      if (process.platform === 'darwin' && windowsAllowed && !quitting && BrowserWindow.getAllWindows().length === 0) createWindow();
    }
  });
  app.whenReady().then(async () => {
    await loadConfig();
    if (!(await confirmUnsandboxedStart())) { app.quit(); return; }
    Menu.setApplicationMenu(applicationMenu());
    installIpc();
    installSession();
    createWindow();
    windowsAllowed = true;
  }).catch((error) => {
    dialog.showErrorBox(t('native.dialog.startupErrorTitle'), error.message || t('native.dialog.startupFailed'));
    app.quit();
  });
  app.on('activate', () => { if (windowsAllowed && !quitting && BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', (event) => {
    quitting = true;
    if (finalQuit) return;
    event.preventDefault();
    // With a live renderer the quit first lets it write what it still holds (the debounced workspace snapshot of a
    // direct app.quit()); only then the store flips to "closing" (new writes are rejected with STORE_CLOSING) and the
    // promise resolves after every write accepted before that moment has been committed. Without a live renderer
    // the store closes at once, in this very turn.
    const closeStore = () => Promise.allSettled([
      bugReportService ? bugReportService.beginShutdown() : Promise.resolve(),
      store ? store.beginShutdown() : Promise.resolve(), repairStore ? repairStore.beginShutdown() : Promise.resolve(), ...exportsInFlight,
    ]);
    shutdown ??= (rendererFlushable(mainWindow) ? flushForClose(mainWindow).then(closeStore) : closeStore())
      .then(() => { finalQuit = true; app.quit(); });
  });
}
