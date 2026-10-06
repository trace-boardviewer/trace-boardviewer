'use strict';

// Queued atomic JSON store for the native process (generalizes readJson/readSizedFile/atomicJson,
// configQueue/notesQueue and the before-quit drain of main.cjs; B01).
//
//  - One FIFO queue per store: writes and updates run strictly in submission order.
//  - Every write is atomic: unique temporary file (mode 0o600, flag 'wx') + rename; a failed
//    write removes its temporary file and reports native.error.dataSaveFailed to its caller only.
//  - beginShutdown() flips the store to "closing" synchronously and then drains the queue, so a
//    write submitted after shutdown began is rejected immediately (code STORE_CLOSING) while every
//    write accepted before that moment completes before the returned promise resolves.
//  - The final rename is retried a bounded number of times on EPERM/EACCES/EBUSY (W-win-lifecycle-01):
//    on Windows any other open handle on the target (an antivirus scan, the indexer, a preview pane)
//    makes rename-over-existing fail for a moment. After the last attempt the failure is reported
//    exactly as before (temporary file removed, STORE_WRITE_FAILED, the queue continues).
//  - A read still waits for the writes accepted before it (and stays allowed after beginShutdown()), and
//    from then on holds its file: a write to the SAME file waits until the read handle is closed, so the
//    store never renames over a file it has open itself (W-win-lifecycle-01). Reads and writes of
//    different files do not wait for each other.
//  - Reads are exact: the buffer has precisely the stat() size, and a file that shrank (fewer bytes
//    than expected) or grew (a probe byte past the end) while it was read is reported as
//    STORE_CHANGED instead of being returned (B33). Growth can never allocate more than
//    expected + 1 bytes; the read can be split in chunks with a checkpoint so that a superseded
//    reader stops during the read (B11).
//  - createByteBudget() bounds the bytes concurrently held by in-flight reads (B11).
//
// Names are store-relative: one or more segments of [A-Za-z0-9._-]+ joined by '/', so
// 'config.json', 'notes/<key>.json' and 'workspaces/<key>.json' are valid; '..', empty segments,
// backslashes, drive letters and absolute paths are not.
//
// All user-visible texts go through the injected translator t(key, params); plain English texts
// are marked `// i18n: pending`. The fs/promises object is injectable so that the desktop test
// harness (which mocks node:fs/promises for main.cjs) keeps observing every file operation.

const defaultFs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_NAME_SEGMENTS = 4;
const MAX_SEGMENT_LENGTH = 255;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const MISSING = Symbol('missing');
const identity = (key) => key;
// Rename retry (W-win-lifecycle-01): the pause after each failed attempt; the attempt count is this
// length + 1 (7 attempts, at most 630 ms of waiting in total).
const RENAME_RETRY_DELAYS_MS = Object.freeze([10, 20, 40, 80, 160, 320]);
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function storeError(message, code, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

// True when a Windows path names an NTFS alternate data stream ("host.txt:alt.cad", W-fin-lifecycle-01):
// after the drive prefix no segment may contain ':'. Other platforms allow the character in file names.
function hasStreamSeparator(filename, platform = process.platform) {
  return platform === 'win32' && typeof filename === 'string' && filename.slice(path.win32.parse(filename).root.length).includes(':');
}

// Mirrors localAbsolutePath in main.cjs: string, bounded, no NUL, absolute, no UNC prefix.
// `trusted` (the application's own profile directory, never renderer input) allows a UNC location,
// which a redirected Windows profile can legitimately have. A path that names an alternate data stream is
// never a local document or board path (the profile directory is exempt like its UNC form).
function localAbsolutePath(value, t = identity, trusted = false) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32767 || value.includes('\0') ||
      !path.isAbsolute(value) || (!trusted && (value.startsWith('\\\\') || value.startsWith('//')))) {
    throw storeError(t('native.error.invalidPath'), 'STORE_INVALID_PATH');
  }
  const normalized = path.normalize(value);
  if (!trusted && hasStreamSeparator(normalized)) throw storeError(t('native.error.invalidPath'), 'STORE_INVALID_PATH');
  return normalized;
}

// Returns the validated segments of a store-relative name.
function validateName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_SEGMENTS * (MAX_SEGMENT_LENGTH + 1)) {
    throw storeError('Invalid store entry name.', 'STORE_INVALID_NAME'); // i18n: pending
  }
  const segments = name.split('/');
  if (segments.length > MAX_NAME_SEGMENTS || segments.some((segment) =>
    segment.length === 0 || segment.length > MAX_SEGMENT_LENGTH || segment === '.' || segment === '..' || !SEGMENT_PATTERN.test(segment))) {
    throw storeError('Invalid store entry name.', 'STORE_INVALID_NAME'); // i18n: pending
  }
  return segments;
}

// Reads exactly `expectedBytes` (the size the handle reported). The buffer is zero filled so that a
// view handed to another process never carries stale heap bytes, and has precisely the file's
// length (never a pooled or oversized allocation). `options.checkpoint()` runs before the
// allocation and before every chunk and may throw to abandon the read.
async function readBounded(handle, expectedBytes, maximumBytes, t = identity, options = {}) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maximumBytes) {
    throw storeError(t('native.error.fileLimitExceeded'), 'STORE_TOO_LARGE');
  }
  const { chunkBytes = READ_CHUNK_BYTES, checkpoint } = options;
  if (checkpoint) checkpoint();
  const buffer = Buffer.alloc(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    if (checkpoint) checkpoint();
    const { bytesRead } = await handle.read(buffer, offset, Math.min(chunkBytes, expectedBytes - offset), offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== expectedBytes) throw storeError(t('native.error.fileChangedWhileReading'), 'STORE_CHANGED'); // Shrank after stat().
  // One probe byte past the end detects growth without allocating more than expected + 1 bytes.
  const probe = Buffer.alloc(1);
  const { bytesRead } = await handle.read(probe, 0, 1, expectedBytes);
  if (bytesRead > 0) {
    throw expectedBytes + 1 > maximumBytes ? storeError(t('native.error.fileLimitExceeded'), 'STORE_TOO_LARGE') : storeError(t('native.error.fileChangedWhileReading'), 'STORE_CHANGED');
  }
  return buffer;
}

// Aggregate bound for concurrent reads: acquire(bytes, check) resolves to a release function once the
// bytes fit (a request larger than the whole budget runs alone), strictly first come first served.
// `check()` may throw (a superseded reader); it is re-evaluated whenever the budget changes or poke()
// is called, so an obsolete waiter leaves the queue without ever being granted memory.
function createByteBudget(limitBytes) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw storeError('The byte budget must be a positive integer.', 'STORE_INVALID_OPTIONS'); // i18n: pending
  let used = 0;
  const waiters = [];
  function pump() {
    for (let index = 0; index < waiters.length;) {
      const waiter = waiters[index];
      try { waiter.check(); } catch (error) { waiters.splice(index, 1); waiter.reject(error); continue; }
      if (index === 0 && (used === 0 || used + waiter.bytes <= limitBytes)) {
        waiters.splice(0, 1);
        used += waiter.bytes;
        let released = false;
        waiter.resolve(() => { if (!released) { released = true; used -= waiter.bytes; pump(); } });
        continue;
      }
      index++;
    }
  }
  return Object.freeze({
    limitBytes,
    get inFlight() { return used; },
    get waiting() { return waiters.length; },
    poke: pump,
    acquire(bytes, check = () => {}) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) return Promise.reject(storeError('The byte count must be a non-negative integer.', 'STORE_INVALID_OPTIONS')); // i18n: pending
      return new Promise((resolve, reject) => { waiters.push({ bytes, check, resolve, reject }); pump(); });
    },
  });
}

// Validates a retry schedule (the pause after each failed attempt, milliseconds).
function retrySchedule(value) {
  if (value === undefined) return RENAME_RETRY_DELAYS_MS;
  if (!Array.isArray(value) || value.length > 16 || value.some((ms) => typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 5000)) {
    throw storeError('The rename retry schedule must be a short list of delays in milliseconds.', 'STORE_INVALID_OPTIONS'); // i18n: pending
  }
  return Object.freeze([...value]);
}

// fs.rename with a bounded retry on EPERM/EACCES/EBUSY (W-win-lifecycle-01). The source is untouched by a
// failed rename, so repeating it is safe; any other error, and the error of the last attempt, is thrown
// unchanged. Shared with the zip export of documents.cjs.
async function renameWithRetry(fs, from, to, delaysMs = RENAME_RETRY_DELAYS_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (error) {
      if (attempt >= delaysMs.length || !error || !RENAME_RETRY_CODES.has(error.code)) throw error;
      await sleep(delaysMs[attempt]);
    }
  }
}

function serialize(value, maxBytes, t) {
  const text = JSON.stringify(value, null, 2);
  if (typeof text !== 'string') throw storeError('The value cannot be stored as JSON.', 'STORE_NOT_SERIALIZABLE'); // i18n: pending
  const body = `${text}\n`;
  if (Buffer.byteLength(body, 'utf8') > maxBytes) throw storeError(t('native.error.fileLimitExceeded'), 'STORE_TOO_LARGE');
  return body;
}

function createJsonStore(options) {
  const { maxBytes = DEFAULT_MAX_BYTES, t = identity, fs = defaultFs } = options || {};
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw storeError('maxBytes must be a positive integer.', 'STORE_INVALID_OPTIONS'); // i18n: pending
  const renameDelays = retrySchedule(options && options.renameRetryDelaysMs);
  const directory = localAbsolutePath(options && options.directory, t, Boolean(options && options.trusted));
  let queue = Promise.resolve();
  let closing = false;

  const root = directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
  function filenameOf(name) {
    const filename = path.join(directory, ...validateName(name));
    // Defense in depth: the validated segments can never leave the store directory.
    if (!filename.startsWith(root)) throw storeError('Invalid store entry name.', 'STORE_INVALID_NAME'); // i18n: pending
    return filename;
  }

  // Per-call bound for one entry (config, notes and workspaces differ), never above the store's own.
  function limitOf(callOptions) {
    const limit = callOptions && callOptions.maxBytes !== undefined ? callOptions.maxBytes : maxBytes;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maxBytes) throw storeError('maxBytes must be a positive integer within the store limit.', 'STORE_INVALID_OPTIONS'); // i18n: pending
    return limit;
  }

  // Resolves to the parsed value, or MISSING when the entry does not exist.
  async function readFile(filename, limit) {
    let handle;
    try {
      handle = await fs.open(filename, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw storeError(t('native.error.notAFile'), 'STORE_NOT_A_FILE');
      const buffer = await readBounded(handle, stat.size, limit, t);
      try { return JSON.parse(buffer.toString('utf8')); }
      catch (error) { throw storeError(t('native.error.dataFileInvalid'), 'STORE_INVALID_JSON', error); }
    } catch (error) {
      if (error && error.code === 'ENOENT') return MISSING;
      if (error && typeof error.code === 'string' && error.code.startsWith('STORE_')) throw error;
      throw storeError(t('native.error.dataFileInvalid'), 'STORE_READ_FAILED', error);
    } finally {
      if (handle) await handle.close();
    }
  }

  // Files that a read holds (it has passed the queue and has not closed its handle yet): count and the writers waiting for 0.
  const readers = new Map();
  const readerKey = (filename) => (process.platform === 'win32' ? filename.toLowerCase() : filename);
  // Synchronous on purpose: called right after `await queue` resumes, before any write queued later can start.
  function holdForRead(filename) {
    const key = readerKey(filename);
    const entry = readers.get(key) ?? { count: 0, idle: [] };
    entry.count++;
    readers.set(key, entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--entry.count === 0) { readers.delete(key); for (const resolve of entry.idle.splice(0)) resolve(); }
    };
  }
  function readersIdle(filename) {
    const entry = readers.get(readerKey(filename));
    return entry ? new Promise((resolve) => entry.idle.push(resolve)) : undefined;
  }

  async function atomicWrite(filename, body) {
    await readersIdle(filename); // Never rename over a file this store still has open (W-win-lifecycle-01).
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await renameWithRetry(fs, temporary, filename, renameDelays);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw storeError(t('native.error.dataSaveFailed'), 'STORE_WRITE_FAILED', error);
    }
  }

  // Appends an operation to the FIFO queue. The queue tail never rejects, so one failed write
  // cannot block or fail the writes behind it; the failure reaches the operation's own caller.
  function enqueue(operation) {
    if (closing) return Promise.reject(storeError('The data store is shutting down; the write was not accepted.', 'STORE_CLOSING')); // i18n: pending
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return Object.freeze({
    directory,
    maxBytes,
    get closing() { return closing; },
    path: filenameOf,
    // Resolves to the parsed JSON value, or `options.missing` (default null) when the entry does not
    // exist. Waits for the writes accepted so far, so a read after a write observes that write, and then holds
    // its file until the handle is closed: a later write to the same file waits for it instead of renaming over
    // the open file. Reads are accepted while closing.
    async read(name, readOptions) {
      const filename = filenameOf(name);
      const limit = limitOf(readOptions);
      await queue;
      const release = holdForRead(filename);
      let value;
      try { value = await readFile(filename, limit); } finally { release(); }
      if (value !== MISSING) return value;
      return readOptions && Object.hasOwn(readOptions, 'missing') ? readOptions.missing : null;
    },
    // Serializes and size-checks synchronously (before queuing), then writes atomically in order.
    write(name, value, writeOptions) {
      let filename, body;
      try { filename = filenameOf(name); body = serialize(value, limitOf(writeOptions), t); }
      catch (error) { return Promise.reject(error); }
      return enqueue(() => atomicWrite(filename, body));
    },
    // Read-modify-write inside the queue: the updater receives the committed value (null when the
    // entry does not exist) after every earlier operation has settled, and its result is written.
    update(name, updater, updateOptions) {
      let filename, limit;
      try {
        filename = filenameOf(name);
        limit = limitOf(updateOptions);
        if (typeof updater !== 'function') throw storeError('The updater must be a function.', 'STORE_INVALID_OPTIONS'); // i18n: pending
      } catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        const current = await readFile(filename, limit);
        const next = await updater(current === MISSING ? null : current);
        await atomicWrite(filename, serialize(next, limit, t));
        return next;
      });
    },
    // Like update() for state kept in memory by the caller (the settings and recents): `producer()` runs
    // inside the queue after every earlier operation settled, its result is written, and then
    // `options.commit(value)` runs still inside the same queue slot, so the next operation always sees it.
    compute(name, producer, computeOptions) {
      let filename, limit;
      try {
        filename = filenameOf(name);
        limit = limitOf(computeOptions);
        if (typeof producer !== 'function') throw storeError('The producer must be a function.', 'STORE_INVALID_OPTIONS'); // i18n: pending
      } catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        const next = await producer();
        await atomicWrite(filename, serialize(next, limit, t));
        if (computeOptions && typeof computeOptions.commit === 'function') computeOptions.commit(next);
        return next;
      });
    },
    // Resolves once every operation accepted before this call has settled; never rejects.
    flush() { return queue.then(() => undefined); },
    // Marks the store closing (further writes are rejected) and drains the accepted ones.
    beginShutdown() { closing = true; return queue.then(() => undefined); },
  });
}

module.exports = Object.freeze({
  DEFAULT_MAX_BYTES, READ_CHUNK_BYTES, RENAME_RETRY_DELAYS_MS, createJsonStore, createByteBudget, localAbsolutePath, hasStreamSeparator, validateName, readBounded, renameWithRetry, storeError,
});
