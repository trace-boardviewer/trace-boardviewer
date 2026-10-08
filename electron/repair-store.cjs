'use strict';

// RepairStore: the readings of every board family, kept by the main process (docs/READINGS_FORMAT.md, "Store").
//
// FILES, in <profile>/readings/ (a family id is 64 lower-case hexadecimal digits):
//   <id>.jsonl            append-only log. One line per append call, written in one write:
//                           {"v":1,"seq":N,"at":"<ISO time>","events":[...],"crc":"<crc32 of the line without the crc field>"}
//   <id>.snapshot.jsonl   the compacted state: a header line {"format":"trace-repair-snapshot","version":1,"seq":S,"count":C,"family":{...}},
//                         one line per reading (its canonical JSON, the id first), and a trailer {"crc":"<crc32 of every byte before>","bytes":B}.
//   <id>.jsonl.damaged-…  bytes of the log that could not be read on load, set aside once and never read again.
//   families.json         a cache of the family list keyed by the size and time of each family's files; derived, rebuilt when stale.
//
// GUARANTEES
//  - Every event is validated natively (readings.cjs, the twin of src/lib/readings/schema.ts) and checked against the family's current
//    state before anything is written; an append is all or nothing: one record, one write.
//  - One FIFO queue for every operation; nothing is ever renamed over a file the store has open.
//  - Crash safety (a kill at any instant, tested by killing a writer process): a record that was not completely written fails its CRC (or
//    its JSON) and is set aside on the next load together with everything after it; a snapshot is written to a temporary file and renamed;
//    a log whose records are already in the snapshot (a kill between the rename and the truncation of the log) is skipped by sequence
//    number. A load therefore always yields the state after some prefix of the appends, at least every append that had resolved.
//    Without fsync, an operating-system crash or power cut can lose the last appends; the damage is detected the same way.
//  - Bounds: 100,000 readings per family (validator), the readings of one family at most `maxStateBytes` as JSON, a family header
//    (members and pin set) at most `maxHeaderBytes`, one record at most `maxRecordBytes`, the log at most `maxLogBytes` (it is compacted
//    first), files read with an exact bounded read (store.cjs readBounded).
//  - A snapshot that is damaged is never repaired or replaced: the family is reported unreadable and its files stay as they are.
//  - Loading costs O(bytes): the snapshot is checked by its CRC and kept as one JSON line per reading (no parse per reading); `read`
//    hands the readings to the renderer as the text of one JSON array, which the renderer parses (no structured clone of 100k objects).
//
// Texts users may see go through the injected translator; validator texts are English with a stable `code` (READINGS_*), which the
// renderer translates.

const defaultFs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { randomUUID } = require('node:crypto');
const readings = require('./readings.cjs');
const { localAbsolutePath, readBounded, renameWithRetry, storeError } = require('./store.cjs');

const SNAPSHOT_FORMAT = 'trace-repair-snapshot';
const SNAPSHOT_VERSION = 1;
const RECORD_VERSION = 1;
const MiB = 1024 * 1024;
const DEFAULTS = Object.freeze({
  maxStateBytes: 64 * MiB, maxHeaderBytes: 16 * MiB, maxRecordBytes: 64 * MiB, maxLogBytes: 64 * MiB,
  compactRecords: 1000, compactBytes: 4 * MiB, cacheFamilies: 3, maxFamilies: 10000,
});
const FAMILY_ID = /^[a-f0-9]{64}$/;
const FAMILY_FILE = /^([a-f0-9]{64})\.(?:jsonl|snapshot\.jsonl)$/;
const READING_LINE = /^\{"id":"([A-Za-z0-9][A-Za-z0-9._:~-]{0,63})",/;
const CRC_TAIL = /,"crc":"([0-9a-f]{8})"\}$/;
const CRC_TAIL_LENGTH = 18; // ,"crc":"xxxxxxxx"}
const INDEX_NAME = 'families.json';
const INDEX_VERSION = 1;
const identity = (key) => key;
const hex8 = (value) => (value >>> 0).toString(16).padStart(8, '0');
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function options(value) {
  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (value && value[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw storeError(`${key} must be a positive integer.`, 'STORE_INVALID_OPTIONS');
      merged[key] = value[key];
    }
  }
  if (merged.maxRecordBytes > merged.maxLogBytes) throw storeError('maxRecordBytes cannot exceed maxLogBytes.', 'STORE_INVALID_OPTIONS');
  return Object.freeze(merged);
}

/** One log line (newline included) for the events of one append. */
function serializeRecord(seq, at, events) {
  const body = JSON.stringify({ v: RECORD_VERSION, seq, at, events });
  return `${body.slice(0, -1)},"crc":"${hex8(zlib.crc32(body))}"}\n`;
}

/** The record of one log line (without its newline), or null when the line is damaged. */
function parseRecord(line) {
  if (line.length <= CRC_TAIL_LENGTH) return null;
  const tail = CRC_TAIL.exec(line.toString('latin1', line.length - CRC_TAIL_LENGTH));
  if (!tail) return null;
  const crc = zlib.crc32('}', zlib.crc32(line.subarray(0, line.length - CRC_TAIL_LENGTH)));
  if (hex8(crc) !== tail[1]) return null;
  let record;
  try { record = JSON.parse(line.toString('utf8')); } catch { return null; }
  if (!isObject(record) || record.v !== RECORD_VERSION || !Number.isSafeInteger(record.seq) || record.seq < 1 ||
      !readings.isTimestamp(record.at) || !Array.isArray(record.events)) return null;
  return record;
}

function createRepairStore(config) {
  const { t = identity, fs = defaultFs, now = () => new Date().toISOString() } = config || {};
  const limits = options(config && config.limits);
  const renameDelays = config && config.renameRetryDelaysMs;
  const root = localAbsolutePath(config && config.directory, t, Boolean(config && config.trusted));
  const directory = path.join(root, 'readings');
  const fileOf = (name) => path.join(directory, name);
  const logOf = (id) => fileOf(`${id}.jsonl`);
  const snapshotOf = (id) => fileOf(`${id}.snapshot.jsonl`);
  const unreadable = (cause) => storeError(t('native.error.readingsUnreadable'), 'READINGS_UNREADABLE', cause);
  const tooLarge = (max) => storeError(t('native.error.readingsTooLarge', { max: Math.round(max / MiB) }), 'READINGS_TOO_LARGE');
  const saveFailed = (cause) => storeError(t('native.error.dataSaveFailed'), 'READINGS_SAVE_FAILED', cause);

  let queue = Promise.resolve();
  let closing = false;
  let directoryReady = false;
  /** Loaded families, least recently used first: id -> entry. */
  const cache = new Map();

  function familyId(value) {
    if (typeof value !== 'string' || !FAMILY_ID.test(value)) throw new readings.ReadingsError('READINGS_INVALID', 'Invalid readings: family id.');
    return value;
  }

  // Appends an operation to the FIFO queue; the tail never rejects, so one failure does not block the operations behind it.
  function enqueue(operation, { write = false } = {}) {
    if (write && closing) return Promise.reject(storeError(t('native.error.readingsStoreClosing'), 'STORE_CLOSING'));
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function ensureDirectory() {
    if (directoryReady) return;
    await fs.mkdir(directory, { recursive: true });
    directoryReady = true;
  }

  async function closeAppend(entry) {
    if (!entry || !entry.appendHandle) return;
    const handle = entry.appendHandle;
    entry.appendHandle = null;
    await handle.close();
  }

  async function closeAppends() {
    for (const entry of cache.values()) await closeAppend(entry);
  }

  // The bytes of a file (exact, bounded), or null when it does not exist.
  async function readFile(filename, maxBytes) {
    let handle;
    try {
      handle = await fs.open(filename, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw unreadable();
      if (stat.size > maxBytes) throw tooLarge(maxBytes);
      return await readBounded(handle, stat.size, maxBytes, t);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      if (error && (error.code === 'READINGS_UNREADABLE' || error.code === 'READINGS_TOO_LARGE')) throw error;
      throw unreadable(error);
    } finally {
      if (handle) await handle.close();
    }
  }

  async function atomicWrite(filename, data) {
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await ensureDirectory();
      await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await renameWithRetry(fs, temporary, filename, renameDelays);
    } catch (error) {
      if (error && error.code === 'ENOENT') directoryReady = false;
      await fs.unlink(temporary).catch(() => {});
      throw saveFailed(error);
    }
  }

  // Temporary files of this family left by a write that was killed (one queue: no write of this store is in flight now).
  async function removeStaleTemporaries(prefix, listed) {
    let names = listed;
    if (!names) { try { names = await fs.readdir(directory); } catch { return; } }
    for (const name of names) if (name.startsWith(prefix) && name.endsWith('.tmp')) await fs.unlink(fileOf(name)).catch(() => {});
  }
  const exists = (filename) => fs.stat(filename).then(() => true, () => false);

  // ---------------------------------------------------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------------------------------------------------

  const maxSnapshotBytes = () => limits.maxStateBytes + limits.maxHeaderBytes + MiB;

  function parseSnapshot(buffer, id) {
    const length = buffer.length;
    if (length < 2 || buffer[length - 1] !== 0x0a) throw unreadable();
    const trailerStart = buffer.lastIndexOf(0x0a, length - 2) + 1;
    let trailer;
    try { trailer = JSON.parse(buffer.toString('utf8', trailerStart, length - 1)); } catch (error) { throw unreadable(error); }
    if (!isObject(trailer) || trailer.bytes !== trailerStart || typeof trailer.crc !== 'string' || hex8(zlib.crc32(buffer.subarray(0, trailerStart))) !== trailer.crc) throw unreadable();
    const headerEnd = buffer.indexOf(0x0a);
    let header;
    try { header = JSON.parse(buffer.toString('utf8', 0, headerEnd)); } catch (error) { throw unreadable(error); }
    if (!isObject(header) || header.format !== SNAPSHOT_FORMAT || header.version !== SNAPSHOT_VERSION || !Number.isSafeInteger(header.seq) || header.seq < 0 ||
        !Number.isSafeInteger(header.count) || header.count < 0 || header.count > readings.LIMITS.readings) throw unreadable();
    let family;
    try { family = readings.validateFamilyHeader(header.family); } catch (error) { throw unreadable(error); }
    if (family.id !== id) throw unreadable();
    const lines = buffer.toString('utf8', headerEnd + 1, trailerStart).split('\n');
    lines.pop(); // the text ends with a newline
    if (lines.length !== header.count) throw unreadable();
    const map = new Map();
    for (const line of lines) {
      const match = READING_LINE.exec(line);
      if (!match || map.has(match[1]) || line.charCodeAt(line.length - 1) !== 0x7d) throw unreadable();
      map.set(match[1], line);
    }
    // Bytes of the reading lines alone: everything between the header line and the trailer, minus one newline per reading.
    const bytes = trailerStart - (headerEnd + 1) - lines.length;
    return { state: { family, readings: map }, seq: header.seq, bytes, headerBytes: headerEnd };
  }

  function snapshotBytes(entry) {
    const header = JSON.stringify({ format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, seq: entry.seq, count: entry.state.readings.size, family: entry.state.family });
    const body = Buffer.from(entry.state.readings.size === 0 ? `${header}\n` : `${header}\n${[...entry.state.readings.values()].join('\n')}\n`, 'utf8');
    const trailer = Buffer.from(`${JSON.stringify({ crc: hex8(zlib.crc32(body)), bytes: body.length })}\n`, 'utf8');
    return Buffer.concat([body, trailer]);
  }

  // Writes the state as the snapshot, then empties the log (a kill in between leaves records the snapshot holds: skipped by seq).
  async function compact(entry) {
    await closeAppend(entry);
    const data = snapshotBytes(entry);
    if (data.length > maxSnapshotBytes()) throw tooLarge(limits.maxStateBytes);
    await atomicWrite(snapshotOf(entry.id), data);
    try { await fs.truncate(logOf(entry.id), 0); } catch (error) { if (!error || error.code !== 'ENOENT') return; }
    entry.logBytes = 0;
    entry.logRecords = 0;
    entry.needsNewline = false;
  }

  function scheduleCompaction(id) {
    enqueue(async () => {
      const entry = cache.get(id);
      if (entry && (entry.logRecords >= limits.compactRecords || entry.logBytes >= limits.compactBytes)) await compact(entry);
    }, { write: true }).catch(() => {}); // A failed compaction leaves a valid log; the next append tries again.
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Loading a family
  // ---------------------------------------------------------------------------------------------------------------

  const encodeLines = (lines) => (reading, index) => lines[index];
  const lineBytes = (line) => Buffer.byteLength(line, 'utf8');

  // The events of `records` applied to `entry` (or a new one), with the byte bounds; throws without changing the entry.
  function plan(entry, events, id) {
    readings.checkEvents(entry ? entry.state : null, events, id);
    const lines = events.map((event) => (event.type === 'reading.add' || event.type === 'reading.replace' ? JSON.stringify(event.reading) : null));
    let bytes = entry ? entry.bytes : 0;
    const sizes = new Map();
    const sizeOf = (readingId) => {
      if (sizes.has(readingId)) return sizes.get(readingId);
      const line = entry ? entry.state.readings.get(readingId) : undefined;
      return line === undefined ? 0 : lineBytes(line);
    };
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (event.type === 'family.create') { bytes = 0; sizes.clear(); continue; }
      if (lines[index] !== null) {
        const size = lineBytes(lines[index]);
        bytes += size - sizeOf(event.reading.id);
        sizes.set(event.reading.id, size);
      } else if (event.type === 'reading.remove') {
        bytes -= sizeOf(event.id);
        sizes.set(event.id, 0);
      }
    }
    if (bytes > limits.maxStateBytes) throw tooLarge(limits.maxStateBytes);
    let headerBytes = entry ? entry.headerBytes : 0;
    if (events.some((event) => event.type.startsWith('family.'))) {
      const scratch = readings.applyEvents(entry ? { family: JSON.parse(JSON.stringify(entry.state.family)), readings: new Map() } : null,
        events.filter((event) => event.type.startsWith('family.')));
      headerBytes = lineBytes(JSON.stringify(scratch.family));
      if (headerBytes > limits.maxHeaderBytes) throw tooLarge(limits.maxHeaderBytes);
    }
    return { lines, bytes, headerBytes };
  }

  function commit(entry, id, events, planned) {
    const state = readings.applyEvents(entry ? entry.state : null, events, encodeLines(planned.lines));
    const next = entry ?? { id, state, seq: 0, bytes: 0, headerBytes: 0, logBytes: 0, logRecords: 0, needsNewline: false, damaged: undefined };
    next.state = state;
    next.bytes = planned.bytes;
    next.headerBytes = planned.headerBytes;
    return next;
  }

  // The family as its files hold it, or null when it has none. A damaged log tail is set aside (copied once) and cut off.
  async function loadEntry(id, listed) {
    await removeStaleTemporaries(`${id}.`, listed);
    let entry = null;
    const snapshot = await readFile(snapshotOf(id), maxSnapshotBytes());
    if (snapshot) {
      const parsed = parseSnapshot(snapshot, id);
      entry = { id, state: parsed.state, seq: parsed.seq, bytes: parsed.bytes, headerBytes: parsed.headerBytes, logBytes: 0, logRecords: 0, needsNewline: false, damaged: undefined };
    }
    const snapshotSeq = entry ? entry.seq : 0;
    const log = await readFile(logOf(id), limits.maxLogBytes);
    if (!log || log.length === 0) return entry;
    let offset = 0;
    let good = 0;
    let damagedLines = 0;
    while (offset < log.length) {
      const newline = log.indexOf(0x0a, offset);
      const end = newline === -1 ? log.length : newline;
      const record = parseRecord(log.subarray(offset, end));
      let applied = false;
      // Records the snapshot already holds (a kill between writing it and emptying the log) come first and are skipped.
      if (record && snapshot && entry.logRecords === 0 && record.seq <= snapshotSeq) applied = true;
      else if (record && record.seq === (entry ? entry.seq : 0) + 1) {
        try {
          const events = readings.validateEvents(record.events);
          const planned = plan(entry, events, id);
          entry = commit(entry, id, events, planned);
          entry.seq = record.seq;
          entry.logRecords++;
          applied = true;
        } catch { /* an event that does not apply: the record and everything after it are set aside */ }
      }
      if (!applied) {
        for (let at = offset; at < log.length; at = log.indexOf(0x0a, at) + 1 || log.length) damagedLines++;
        break;
      }
      good = newline === -1 ? log.length : newline + 1;
      offset = good;
      if (entry && newline === -1) entry.needsNewline = true;
    }
    if (good < log.length) {
      const tail = log.subarray(good);
      // Named by where it was cut and what it holds, so a kill during this repair does not copy the same bytes twice.
      const copy = fileOf(`${id}.jsonl.damaged-${good}-${hex8(zlib.crc32(tail))}`);
      if (!(await exists(copy))) await atomicWrite(copy, tail);
      try { await fs.truncate(logOf(id), good); } catch (error) { throw saveFailed(error); }
      if (entry) entry.damaged = { lines: damagedLines, bytes: tail.length };
    }
    if (entry) entry.logBytes = good;
    return entry;
  }

  async function getEntry(id) {
    const cached = cache.get(id);
    if (cached) { cache.delete(id); cache.set(id, cached); return cached; }
    const entry = await loadEntry(id);
    if (entry) await remember(entry);
    return entry;
  }

  async function remember(entry) {
    cache.delete(entry.id);
    cache.set(entry.id, entry);
    while (cache.size > limits.cacheFamilies) {
      const oldest = cache.keys().next().value;
      await closeAppend(cache.get(oldest));
      cache.delete(oldest);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Family list
  // ---------------------------------------------------------------------------------------------------------------

  function summaryOf(entry) {
    const family = entry.state.family;
    const summary = { id: family.id };
    if (family.name !== undefined) summary.name = family.name;
    summary.createdAt = family.createdAt;
    summary.members = family.members.map((member) => ({ ...member, fileKeys: [...member.fileKeys] }));
    if (family.pinSet !== undefined) summary.pairCount = readings.pinSetSize(family.pinSet);
    summary.readingCount = entry.state.readings.size;
    summary.seq = entry.seq;
    return summary;
  }

  async function stampOf(id) {
    const part = async (filename) => {
      try { const stat = await fs.stat(filename); return `${stat.size}:${Math.round(stat.mtimeMs)}`; } catch { return '-'; }
    };
    return `${await part(logOf(id))}|${await part(snapshotOf(id))}`;
  }

  async function readIndex() {
    try {
      const buffer = await readFile(fileOf(INDEX_NAME), 32 * MiB);
      const value = buffer ? JSON.parse(buffer.toString('utf8')) : null;
      return isObject(value) && value.version === INDEX_VERSION && isObject(value.families) ? value.families : {};
    } catch { return {}; }
  }

  async function listFamilies() {
    let names;
    try { names = await fs.readdir(directory); } catch (error) { if (error && error.code === 'ENOENT') return []; throw unreadable(error); }
    await removeStaleTemporaries(`${INDEX_NAME}.`);
    const ids = [...new Set(names.map((name) => FAMILY_FILE.exec(name)).filter(Boolean).map((match) => match[1]))].sort().slice(0, limits.maxFamilies);
    const index = await readIndex();
    const next = {};
    const list = [];
    let changed = Object.keys(index).length !== ids.length;
    for (const id of ids) {
      let summary;
      const cached = cache.get(id);
      const stamp = await stampOf(id);
      const known = index[id];
      if (cached) summary = summaryOf(cached);
      else if (isObject(known) && known.stamp === stamp && isObject(known.summary) && known.summary.id === id) summary = known.summary;
      else {
        try {
          const entry = await loadEntry(id, names);
          summary = entry ? summaryOf(entry) : null;
        } catch { summary = { id, unreadable: true }; }
      }
      if (!summary) continue;
      const after = cached || summary === known?.summary ? stamp : await stampOf(id); // a load may have cut a damaged tail
      if (!known || known.stamp !== after || summary !== known.summary) changed = true;
      next[id] = { stamp: after, summary };
      list.push(summary);
    }
    if (changed) await atomicWrite(fileOf(INDEX_NAME), `${JSON.stringify({ version: INDEX_VERSION, families: next })}\n`).catch(() => {});
    return list;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Public operations
  // ---------------------------------------------------------------------------------------------------------------

  return Object.freeze({
    directory,
    limits,
    get closing() { return closing; },
    /**
     * Appends the events of one call to a family (all or nothing). Resolves to { seq, readingCount } once the record is written.
     * Validation errors reject before anything is queued.
     */
    append(id, rawEvents) {
      let checkedId, events;
      try { checkedId = familyId(id); events = readings.validateEvents(rawEvents); } catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        const entry = await getEntry(checkedId);
        const planned = plan(entry, events, checkedId);
        const seq = (entry ? entry.seq : 0) + 1;
        const line = serializeRecord(seq, now(), events);
        const size = lineBytes(line);
        if (size > limits.maxRecordBytes) throw tooLarge(limits.maxRecordBytes);
        if (entry && entry.logBytes + size > limits.maxLogBytes) await compact(entry);
        const prefix = entry && entry.needsNewline ? '\n' : '';
        const before = entry ? entry.logBytes : 0;
        let appendHandle;
        try {
          await ensureDirectory();
          appendHandle = entry && entry.appendHandle ? entry.appendHandle : await fs.open(logOf(checkedId), 'a', 0o600);
          // Keep the append descriptor warm; reopening it for every reading can dominate Windows disk latency.
          await fs.appendFile(appendHandle, prefix + line, { encoding: 'utf8' });
        } catch (error) {
          if (error && error.code === 'ENOENT') directoryReady = false;
          if (appendHandle) await appendHandle.close().catch(() => {});
          if (entry) entry.appendHandle = null;
          // Never leave a partial record in front of the next one: cut the log back, and load the family again next time.
          await fs.truncate(logOf(checkedId), before).catch(() => {});
          cache.delete(checkedId);
          throw saveFailed(error);
        }
        const next = commit(entry, checkedId, events, planned);
        next.appendHandle = appendHandle;
        next.seq = seq;
        next.logBytes = before + prefix.length + size;
        next.logRecords++;
        next.needsNewline = false;
        await remember(next);
        if (next.logRecords >= limits.compactRecords || next.logBytes >= limits.compactBytes) scheduleCompaction(checkedId);
        return { seq, readingCount: next.state.readings.size };
      }, { write: true });
    },
    /**
     * The family: { family, seq, readingCount, readings, damaged? }, `readings` being the text of a JSON array of the readings in their
     * order (`headerOnly`: without it). Null when the family does not exist. Allowed while closing.
     */
    read(id, readOptions) {
      let checkedId;
      try { checkedId = familyId(id); } catch (error) { return Promise.reject(error); }
      const headerOnly = Boolean(readOptions && readOptions.headerOnly === true);
      return enqueue(async () => {
        const entry = await getEntry(checkedId);
        if (!entry) return null;
        const result = { family: JSON.parse(JSON.stringify(entry.state.family)), seq: entry.seq, readingCount: entry.state.readings.size };
        if (!headerOnly) result.readings = `[${[...entry.state.readings.values()].join(',')}]`;
        if (entry.damaged) result.damaged = { ...entry.damaged };
        return result;
      });
    },
    /** Every family: summaries { id, name?, createdAt, members, pairCount?, readingCount, seq }, or { id, unreadable: true }. */
    list() { return enqueue(listFamilies); },
    /** Writes the snapshot of a family now (the store also does this on its own). Resolves false when the family does not exist. */
    compact(id) {
      let checkedId;
      try { checkedId = familyId(id); } catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        const entry = await getEntry(checkedId);
        if (!entry) return false;
        await compact(entry);
        return true;
      }, { write: true });
    },
    /** Drops the loaded families (the next operation reads the files again). */
    forget() { return enqueue(async () => { await closeAppends(); cache.clear(); }); },
    flush() { return queue.then(() => undefined); },
    /** Further appends are rejected (STORE_CLOSING); resolves once every accepted operation has settled. */
    beginShutdown() { closing = true; return enqueue(closeAppends); },
  });
}

module.exports = Object.freeze({ DEFAULTS, SNAPSHOT_FORMAT, SNAPSHOT_VERSION, createRepairStore, serializeRecord, parseRecord });
