'use strict';

// Native tests for electron/repair-store.cjs (the readings of every board family): append/read/list, the all-or-nothing append, the
// bounds, the log and snapshot on disk, recovery from torn, damaged or out-of-order records, a damaged snapshot that is left alone,
// a failed write that is cut back, the shutdown gate, a writer process killed at observed write boundaries, and load/append budgets
// (100k readings load within a small multiple of a plain pass over the snapshot, an append within a small multiple of a plain append of
// the same record; both measured in the same process, so a busy machine does not decide the outcome). Loaded by tests/store-checks.cjs,
// so it runs with the native suites.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { createRepairStore, serializeRecord, parseRecord, SNAPSHOT_FORMAT } = require('../electron/repair-store.cjs');
const readings = require('../electron/readings.cjs');
const { isInsideTemp, makeTempDir } = require('./canonical-temp.cjs');

const t = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);
const ID = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const family = (id = ID, extra = {}) => ({ id, createdAt: '2026-10-07T08:00:00Z', members: [{ fingerprint: id, fingerprintVersion: 1, fileKeys: [] }], ...extra });
const create = (id = ID, extra) => ({ type: 'family.create', family: family(id, extra) });
const voltage = (id, value, extra = {}) => ({ id, kind: 'voltage', target: { ref: 'U7', pin: '3' }, value, unit: 'V', conditions: { power: 'powered' }, source: 'measured', ...extra });
const add = (reading) => ({ type: 'reading.add', reading });
const ids = (snapshot) => JSON.parse(snapshot.readings).map((reading) => reading.id);
const files = async (directory) => (await fs.readdir(path.join(directory, 'readings'))).sort();
const logOf = (directory, id = ID) => path.join(directory, 'readings', `${id}.jsonl`);
const snapshotOf = (directory, id = ID) => path.join(directory, 'readings', `${id}.snapshot.jsonl`);

test('electron/repair-store.cjs: readings of board families in an append-only log with snapshots', async (t0) => {
  const root = await makeTempDir('trace-repair-store-test-');
  const stores = [];
  t0.after(async () => {
    for (const store of stores) await store.beginShutdown();
    assert.ok(await isInsideTemp(root));
    await fs.rm(root, { recursive: true, force: true });
  });
  let counter = 0;
  const profile = async () => { const directory = path.join(root, `p${++counter}`); await fs.mkdir(directory); return directory; };
  const open = (directory, extra = {}) => {
    const store = createRepairStore({ directory, t, ...extra });
    stores.push(store);
    return store;
  };

  await t0.test('append, read and list; a replaced reading keeps its place; a new store reads the same state', async () => {
    const directory = await profile();
    const store = open(directory);
    assert.equal(await store.read(ID), null);
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(await store.append(ID, [create(), add(voltage('r1', 1.8)), add(voltage('r2', 3.3))]), { seq: 1, readingCount: 2 });
    assert.deepEqual(await store.append(ID, [{ type: 'reading.replace', reading: voltage('r1', 1.79) }, add(voltage('r3', 5))]), { seq: 2, readingCount: 3 });
    assert.deepEqual(await store.append(ID, [{ type: 'reading.remove', id: 'r2' }, { type: 'family.rename', name: 'Logic board' }]), { seq: 3, readingCount: 2 });
    const snapshot = await store.read(ID);
    assert.deepEqual(JSON.parse(snapshot.readings), [voltage('r1', 1.79), voltage('r3', 5)]);
    assert.equal(snapshot.family.name, 'Logic board');
    assert.equal(snapshot.seq, 3);
    assert.equal(snapshot.damaged, undefined);
    const header = await store.read(ID, { headerOnly: true });
    assert.equal(header.readings, undefined);
    assert.equal(header.readingCount, 2);
    assert.deepEqual(await files(directory), [`${ID}.jsonl`]);
    const again = open(directory);
    assert.deepEqual(await again.read(ID), snapshot);
    assert.deepEqual(await again.list(), [{ id: ID, name: 'Logic board', createdAt: '2026-10-07T08:00:00Z', members: family().members, readingCount: 2, seq: 3 }]);
  });

  await t0.test('an append is all or nothing: the first invalid or conflicting event rejects the call and nothing is written', async () => {
    const directory = await profile();
    const store = open(directory);
    await assert.rejects(store.append(ID, [create(), add(voltage('r1', 1)), add({ ...voltage('r2', 1), unit: 'ohm' })]), { code: 'READINGS_INVALID', message: 'Invalid readings: events[2].reading.unit.' });
    await assert.rejects(store.append(ID, [add(voltage('r1', 1))]), { code: 'READINGS_NO_FAMILY' });
    await assert.rejects(store.append(ID, [create(OTHER)]), { code: 'READINGS_INVALID', message: 'Invalid readings: events[0].family.id (another family).' });
    await assert.rejects(store.append('A'.repeat(64), [create()]), { code: 'READINGS_INVALID', message: 'Invalid readings: family id.' });
    await assert.rejects(store.append(ID, []), { code: 'READINGS_INVALID' });
    await assert.rejects(fs.readdir(path.join(directory, 'readings')), { code: 'ENOENT' }, 'nothing was written, not even the folder');
    await store.append(ID, [create(), add(voltage('r1', 1))]);
    await assert.rejects(store.append(ID, [add(voltage('r2', 2)), add(voltage('r1', 2))]), { code: 'READINGS_CONFLICT', message: 'Readings conflict: events[1] adds reading r1, which exists already.' });
    await assert.rejects(store.append(ID, [{ type: 'reading.replace', reading: voltage('r9', 2) }]), { code: 'READINGS_CONFLICT' });
    await assert.rejects(store.append(ID, [{ type: 'reading.remove', id: 'r1' }, { type: 'reading.remove', id: 'r1' }]), { code: 'READINGS_CONFLICT' });
    await assert.rejects(store.append(ID, [create()]), { code: 'READINGS_FAMILY_EXISTS' });
    assert.deepEqual(ids(await store.read(ID)), ['r1']);
    assert.equal((await fs.readFile(logOf(directory), 'utf8')).split('\n').length, 2, 'one record');
    assert.deepEqual(ids(await open(directory).read(ID)), ['r1']);
  });

  await t0.test('warm appends avoid redundant directory operations and reload with the same state', async () => {
    const directory = await profile();
    const counting = Object.create(fs);
    let directories = 0;
    let appendsOpened = 0;
    counting.mkdir = (...args) => { directories++; return fs.mkdir(...args); };
    counting.open = (...args) => { if (args[1] === 'a') appendsOpened++; return fs.open(...args); };
    const store = open(directory, { fs: counting });
    await store.append(ID, [create()]);
    for (let n = 0; n < 20; n++) await store.append(ID, [add(voltage(`r${n}`, n))]);
    await store.compact(ID);
    assert.equal(directories, 1, 'directory setup happens once, outside the warm append path');
    assert.equal(appendsOpened, 1, 'warm appends reuse one descriptor');
    assert.deepEqual(await open(directory).read(ID), await store.read(ID));
  });

  await t0.test('append descriptors close on compaction, eviction, forgetting and shutdown', async () => {
    const directory = await profile();
    const counting = Object.create(fs);
    let opened = 0, closed = 0;
    counting.open = async (...args) => {
      const handle = await fs.open(...args);
      if (args[1] === 'a') {
        opened++;
        const close = handle.close.bind(handle);
        handle.close = async () => { closed++; return close(); };
      }
      return handle;
    };
    const store = open(directory, { fs: counting, limits: { cacheFamilies: 1 } });
    await store.append(ID, [create()]);
    await store.append(OTHER, [create(OTHER)]);
    assert.equal(closed, 1, 'eviction closes the descriptor');
    await store.compact(OTHER);
    assert.equal(closed, 2, 'compaction closes before replacing/truncating files');
    await store.append(OTHER, [add(voltage('r1', 1))]);
    await store.forget();
    assert.equal(closed, 3);
    await store.append(OTHER, [add(voltage('r2', 2))]);
    await store.beginShutdown();
    assert.equal(opened, 4);
    assert.equal(closed, opened, 'shutdown leaves no append descriptor open');
    assert.deepEqual(ids(await store.read(OTHER)), ['r1', 'r2']);
  });

  await t0.test('bounds: the bytes of the readings, of one record and of the family header', async () => {
    const directory = await profile();
    const store = open(directory, { limits: { maxStateBytes: 2000, maxRecordBytes: 3000, maxLogBytes: 3000, maxHeaderBytes: 400 } });
    await store.append(ID, [create()]);
    const note = 'n'.repeat(900);
    await store.append(ID, [add(voltage('r1', 1, { note }))]);
    await assert.rejects(store.append(ID, [add(voltage('r2', 1, { note })), add(voltage('r3', 1, { note }))]), { code: 'READINGS_TOO_LARGE', message: 'native.error.readingsTooLarge {"max":0}' });
    await store.append(ID, [{ type: 'reading.replace', reading: voltage('r1', 1) }, add(voltage('r2', 1, { note }))]);
    await assert.rejects(store.append(ID, [{ type: 'family.link', member: { fingerprint: 'e'.repeat(64), fingerprintVersion: 1, fileKeys: ['f'.repeat(64), '0'.repeat(64), '1'.repeat(64), '2'.repeat(64)] } }]), { code: 'READINGS_TOO_LARGE' });
    const big = open(await profile(), { limits: { maxRecordBytes: 1500, maxLogBytes: 4000 } });
    await assert.rejects(big.append(ID, [create(), add(voltage('r1', 1, { note: 'n'.repeat(1500) }))]), { code: 'READINGS_TOO_LARGE' });
    assert.deepEqual(ids(await store.read(ID)), ['r1', 'r2']);
  });

  await t0.test('on disk: one CRC-checked JSON record per append; compaction writes a CRC-checked snapshot and empties the log', async () => {
    const directory = await profile();
    let clock = 0;
    const store = open(directory, { now: () => `2026-10-07T08:00:0${clock++}Z`, limits: { compactRecords: 3 } });
    await store.append(ID, [create(), add(voltage('r1', 1))]);
    const line = (await fs.readFile(logOf(directory), 'utf8')).trimEnd();
    const record = JSON.parse(line);
    assert.deepEqual(Object.keys(record), ['v', 'seq', 'at', 'events', 'crc']);
    assert.equal(record.at, '2026-10-07T08:00:00Z');
    const body = JSON.stringify({ v: 1, seq: 1, at: record.at, events: record.events });
    assert.equal(record.crc, (zlib.crc32(body) >>> 0).toString(16).padStart(8, '0'));
    assert.equal(serializeRecord(1, record.at, record.events), `${line}\n`);
    assert.deepEqual(parseRecord(Buffer.from(line)), record);
    assert.equal(parseRecord(Buffer.from(line.replace('"r1"', '"r2"'))), null, 'a changed byte fails the CRC');
    await store.append(ID, [add(voltage('r2', 2))]);
    await store.append(ID, [add(voltage('r3', 3))]);
    await store.flush(); // the compaction is queued behind the third append
    assert.equal((await fs.stat(logOf(directory))).size, 0);
    const text = await fs.readFile(snapshotOf(directory), 'utf8');
    const lines = text.trimEnd().split('\n');
    assert.deepEqual(JSON.parse(lines[0]), { format: SNAPSHOT_FORMAT, version: 1, seq: 3, count: 3, family: family() });
    assert.deepEqual(lines.slice(1, 4).map((item) => JSON.parse(item).id), ['r1', 'r2', 'r3']);
    const prefix = Buffer.byteLength(text) - Buffer.byteLength(lines[4]) - 1;
    assert.deepEqual(JSON.parse(lines[4]), { crc: (zlib.crc32(Buffer.from(text).subarray(0, prefix)) >>> 0).toString(16).padStart(8, '0'), bytes: prefix });
    await store.append(ID, [add(voltage('r4', 4))]);
    const fresh = await open(directory).read(ID);
    assert.deepEqual(ids(fresh), ['r1', 'r2', 'r3', 'r4']);
    assert.equal(fresh.seq, 4);
    assert.equal(await store.compact(OTHER), false);
  });

  await t0.test('a torn last record is set aside once (copied next to the log) and cut off; the family goes on from the last whole record', async () => {
    const directory = await profile();
    await open(directory).append(ID, [create(), add(voltage('r1', 1))]);
    await open(directory).append(ID, [add(voltage('r2', 2))]);
    const whole = await fs.readFile(logOf(directory));
    const torn = serializeRecord(3, '2026-10-07T09:00:00Z', [add(voltage('r3', 3))]).slice(0, 40);
    await fs.appendFile(logOf(directory), torn);
    const store = open(directory);
    const loaded = await store.read(ID);
    assert.deepEqual(ids(loaded), ['r1', 'r2']);
    assert.deepEqual(loaded.damaged, { lines: 1, bytes: 40 });
    assert.deepEqual(await fs.readFile(logOf(directory)), whole, 'the log is cut back to its whole records');
    const copies = (await files(directory)).filter((name) => name.includes('.damaged-'));
    assert.equal(copies.length, 1);
    assert.equal(await fs.readFile(path.join(directory, 'readings', copies[0]), 'utf8'), torn);
    assert.deepEqual(await store.append(ID, [add(voltage('r3', 3))]), { seq: 3, readingCount: 3 });
    const again = await open(directory).read(ID);
    assert.deepEqual(ids(again), ['r1', 'r2', 'r3']);
    assert.equal(again.damaged, undefined, 'reported once, when it was set aside');
  });

  await t0.test('a damaged, out-of-order or inapplicable record ends the replay: it and everything after it are set aside', async () => {
    for (const [label, mutate] of [
      ['a changed byte (CRC)', (lines) => { lines[1] = lines[1].replace('"r2"', '"r9"'); }],
      ['a sequence gap', (lines) => { lines[1] = serializeRecord(5, '2026-10-07T09:00:00Z', [add(voltage('r2', 2))]).trimEnd(); }],
      ['an event that does not apply', (lines) => { lines[1] = serializeRecord(2, '2026-10-07T09:00:00Z', [{ type: 'reading.remove', id: 'r7' }]).trimEnd(); }],
      ['an invalid event', (lines) => { lines[1] = serializeRecord(2, '2026-10-07T09:00:00Z', [add({ ...voltage('r2', 2), kind: 'current' })]).trimEnd(); }],
      ['an empty line', (lines) => { lines.splice(1, 0, ''); }],
    ]) {
      const directory = await profile();
      const store = open(directory);
      await store.append(ID, [create(), add(voltage('r1', 1))]);
      await store.append(ID, [add(voltage('r2', 2))]);
      await store.append(ID, [add(voltage('r3', 3))]);
      const lines = (await fs.readFile(logOf(directory), 'utf8')).split('\n');
      mutate(lines);
      await fs.writeFile(logOf(directory), lines.join('\n'));
      const loaded = await open(directory).read(ID);
      assert.deepEqual(ids(loaded), ['r1'], label);
      assert.equal(loaded.seq, 1, label);
      assert.ok(loaded.damaged && loaded.damaged.lines >= 2, label);
    }
  });

  await t0.test('a whole last record without its newline is kept, and the next append starts on a new line', async () => {
    const directory = await profile();
    await open(directory).append(ID, [create(), add(voltage('r1', 1))]);
    const text = await fs.readFile(logOf(directory), 'utf8');
    await fs.writeFile(logOf(directory), text.slice(0, -1));
    const store = open(directory);
    assert.equal((await store.read(ID)).damaged, undefined);
    await store.append(ID, [add(voltage('r2', 2))]);
    assert.equal((await fs.readFile(logOf(directory), 'utf8')).split('\n').length, 3);
    assert.deepEqual(ids(await open(directory).read(ID)), ['r1', 'r2']);
  });

  await t0.test('a kill between writing the snapshot and emptying the log: the records the snapshot holds are skipped by sequence number', async () => {
    const directory = await profile();
    const store = open(directory);
    await store.append(ID, [create(), add(voltage('r1', 1))]);
    await store.append(ID, [{ type: 'reading.remove', id: 'r1' }, add(voltage('r2', 2))]);
    const log = await fs.readFile(logOf(directory));
    await store.compact(ID);
    await fs.writeFile(logOf(directory), log); // as if the truncation never happened
    const reopened = open(directory);
    const loaded = await reopened.read(ID);
    assert.deepEqual(ids(loaded), ['r2']);
    assert.equal(loaded.seq, 2);
    assert.equal(loaded.damaged, undefined);
    assert.deepEqual(await reopened.append(ID, [add(voltage('r3', 3))]), { seq: 3, readingCount: 2 });
    assert.deepEqual(ids(await open(directory).read(ID)), ['r2', 'r3']);
  });

  await t0.test('a damaged snapshot is never repaired or replaced: the family is unreadable, listed as such, and its files stay byte for byte', async () => {
    const directory = await profile();
    const store = open(directory);
    await store.append(ID, [create(), add(voltage('r1', 1))]);
    await store.compact(ID);
    await store.append(ID, [add(voltage('r2', 2))]);
    const snapshot = await fs.readFile(snapshotOf(directory));
    const damaged = Buffer.from(snapshot);
    damaged[damaged.indexOf('"r1"') + 2] = 0x39;
    await fs.writeFile(snapshotOf(directory), damaged);
    const log = await fs.readFile(logOf(directory));
    const reopened = open(directory);
    await assert.rejects(reopened.read(ID), { code: 'READINGS_UNREADABLE', message: 'native.error.readingsUnreadable' });
    await assert.rejects(reopened.append(ID, [add(voltage('r3', 3))]), { code: 'READINGS_UNREADABLE' });
    assert.deepEqual(await reopened.list(), [{ id: ID, unreadable: true }]);
    assert.deepEqual(await fs.readFile(snapshotOf(directory)), damaged);
    assert.deepEqual(await fs.readFile(logOf(directory)), log);
    for (const variant of [snapshot.subarray(0, snapshot.length - 1), Buffer.concat([snapshot, Buffer.from('x\n')]), Buffer.from(snapshot.toString().replace('"seq":1', '"seq":-1'))]) {
      await fs.writeFile(snapshotOf(directory), variant);
      await assert.rejects(open(directory).read(ID), { code: 'READINGS_UNREADABLE' });
    }
    await fs.writeFile(snapshotOf(directory), snapshot);
    assert.deepEqual(ids(await open(directory).read(ID)), ['r1', 'r2']);
  });

  await t0.test('temporary files of a killed write are removed when the family is loaded', async () => {
    const directory = await profile();
    await open(directory).append(ID, [create()]);
    const stale = path.join(directory, 'readings', `${ID}.snapshot.jsonl.123.abc.tmp`);
    const unrelated = path.join(directory, 'readings', `${OTHER}.snapshot.jsonl.123.abc.tmp`);
    await fs.writeFile(stale, 'half');
    await fs.writeFile(unrelated, 'half');
    await open(directory).read(ID);
    await assert.rejects(fs.stat(stale), { code: 'ENOENT' });
    assert.equal((await fs.stat(unrelated)).isFile(), true, 'another family is left to its own load');
  });

  await t0.test('a write that fails halfway is cut back, so the next record never follows a partial one', async () => {
    const directory = await profile();
    let failNext = false;
    const failing = Object.create(fs);
    failing.appendFile = async (filename, data, ...rest) => {
      if (!failNext) return fs.appendFile(filename, data, ...rest);
      failNext = false;
      await fs.appendFile(filename, String(data).slice(0, 25));
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    };
    const store = open(directory, { fs: failing });
    await store.append(ID, [create(), add(voltage('r1', 1))]);
    const before = await fs.readFile(logOf(directory));
    failNext = true;
    await assert.rejects(store.append(ID, [add(voltage('r2', 2))]), { code: 'READINGS_SAVE_FAILED', message: 'native.error.dataSaveFailed' });
    assert.deepEqual(await fs.readFile(logOf(directory)), before);
    assert.deepEqual(await store.append(ID, [add(voltage('r2', 2))]), { seq: 2, readingCount: 2 });
    const loaded = await open(directory).read(ID);
    assert.deepEqual(ids(loaded), ['r1', 'r2']);
    assert.equal(loaded.damaged, undefined);
  });

  await t0.test('shutdown: appends accepted before it complete, later ones are rejected with STORE_CLOSING, reads still answer', async () => {
    const directory = await profile();
    const store = open(directory);
    const first = store.append(ID, [create(), add(voltage('r1', 1))]);
    const drained = store.beginShutdown();
    await assert.rejects(store.append(ID, [add(voltage('r2', 2))]), { code: 'STORE_CLOSING' });
    await drained;
    assert.deepEqual(await first, { seq: 1, readingCount: 1 });
    assert.deepEqual(ids(await store.read(ID)), ['r1']);
    assert.equal(store.closing, true);
  });

  await t0.test('the family list is cached by the size and time of each family\'s files and refreshed when they change', async () => {
    const directory = await profile();
    await open(directory).append(ID, [create(ID, { name: 'One' })]);
    await open(directory).append(OTHER, [create(OTHER), add(voltage('r1', 1))]);
    await fs.writeFile(path.join(directory, 'readings', 'notes.txt'), 'not a family');
    assert.deepEqual((await open(directory).list()).map((entry) => [entry.id, entry.name, entry.readingCount]), [[ID, 'One', 0], [OTHER, undefined, 1]]);
    const index = JSON.parse(await fs.readFile(path.join(directory, 'readings', 'families.json'), 'utf8'));
    assert.deepEqual(Object.keys(index.families), [ID, OTHER]);
    let opened = 0;
    const counting = Object.create(fs);
    counting.open = (filename, ...rest) => { if (String(filename).includes(ID) || String(filename).includes(OTHER)) opened++; return fs.open(filename, ...rest); };
    assert.equal((await open(directory, { fs: counting }).list()).length, 2);
    assert.equal(opened, 0, 'an up-to-date cache answers without opening a family');
    await open(directory).append(ID, [{ type: 'family.rename', name: 'Two' }]);
    assert.equal((await open(directory, { fs: counting }).list())[0].name, 'Two');
    assert.ok(opened > 0);
  });

  await t0.test('kill during write: kills at different chunk offsets leave a consistent prefix of acknowledged appends', async () => {
    const directory = await profile();
    const writer = path.join(__dirname, 'fixtures', 'readings-writer.cjs');
    const size = (batch) => 1 + (batch * 37) % 300;
    const countAfter = (batch) => { let count = 0; for (let index = 1; index <= batch; index++) count += size(index); return count; };
    let acked = { batch: 0, count: 0 };
    let damagedLoads = 0;
    let temporaryLeft = 0;
    for (let round = 0; round < 8; round++) {
      const child = spawn(process.execPath, [writer, directory, ID], { stdio: ['pipe', 'pipe', 'pipe'] });
      const baseline = acked.batch;
      let output = '';
      let errors = '';
      let killed = false;
      child.stderr.on('data', (chunk) => { errors += chunk; });
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const lines = output.split('\n');
        output = lines.pop();
        for (const line of lines) {
          const ack = /^ack (\d+) (\d+)$/.exec(line);
          if (ack) acked = { batch: Number(ack[1]), count: Number(ack[2]) };
          const progress = /^write (log|snapshot) (\d+)$/.exec(line);
          if (!killed && progress && acked.batch >= baseline + 2 && Number(progress[2]) >= 4096 * (1 + round % 4)) {
            killed = true;
            child.kill('SIGKILL');
          } else if (!killed && progress) child.stdin.write('continue\n');
        }
      });
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      const exit = await exited;
      assert.equal(errors, '', `the writer failed: ${errors}`);
      assert.notEqual(exit.code, 3);
      assert.ok(killed, 'a partial write was observed before the kill');
      temporaryLeft += (await files(directory)).filter((name) => name.endsWith('.tmp')).length;
      const loaded = await open(directory).read(ID);
      const list = JSON.parse(loaded.readings);
      const batch = list.length === 0 ? 0 : list[0].value;
      assert.ok(batch >= acked.batch, `round ${round}: batch ${batch} lost an acknowledged append (${acked.batch})`);
      assert.equal(list.length, countAfter(batch), `round ${round}: the readings are those of ${batch} whole appends`);
      list.forEach((reading, index) => { assert.equal(reading.id, `w${index}`); if (index > 0) assert.equal(reading.value, index); });
      if (loaded.damaged) damagedLoads++;
      const leftovers = (await files(directory)).filter((name) => name.endsWith('.tmp'));
      assert.deepEqual(leftovers, [], 'a load removes the temporary files of the killed write');
      acked = { batch, count: list.length };
    }
    assert.ok(acked.batch > 8, 'the writers made progress');
    t0.diagnostic(`kill during write: 8 kills, ${acked.batch} appends kept, ${damagedLoads} loads set a torn record aside, ${temporaryLeft} killed snapshot writes left a temporary file`);
  });

  await t0.test('budgets: 100,000 readings load within a small multiple of a plain pass over the snapshot; an append within a small multiple of a plain append (measured in a plain process, tests/fixtures/readings-budget.cjs)', async () => {
    // No number of milliseconds is compared. Every timed store operation is followed at once, in the same process, by a plain operation on the same
    // data (tests/fixtures/readings-budget.cjs says which), so a busy machine slows both alike. The load is a read of the snapshot with its CRC-32 check,
    // decoding, line split and index by id: the store may spend a small multiple of that for checking the layout of every line, but not a parse of
    // every record again, a quadratic step or a second pass per reading (those cost many times the plain pass). An append is a record written through a
    // warm descriptor: the store adds planning, validation and its queue, but not work in proportion to the 100,000 readings of the family.
    // The factors sit above what a correct store costs on a quiet machine and far below a per-reading step. Other processes can still stall one
    // measurement, so the best sample counts (they only ever add time), as does the best of three rounds of appends and up to three measurements.
    const LOAD_FACTOR = 4;
    const APPEND_FACTOR = 8;
    const sorted = (list) => [...list].sort((a, b) => a - b);
    const measure = async () => {
      const directory = await profile();
      const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'readings-budget.cjs'), directory], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let errors = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { errors += chunk; });
      const code = await new Promise((resolve) => child.on('exit', resolve));
      assert.equal(code, 0, errors);
      const result = JSON.parse(output);
      assert.equal(result.tooMany, 'READINGS_TOO_MANY', 'the 100,001st reading is refused');
      const loads = sorted(result.loads);
      const plainLoads = sorted(result.plainLoads);
      // Each round of 200 appends against the 200 plain appends taken right after them; medians and 95th percentiles are compared by round.
      const rounds = result.appends.map((times, round) => {
        const store = sorted(times);
        const plain = sorted(result.plainAppends[round]);
        return { median: store[100], p95: store[190], max: store[199], plainMedian: plain[100], plainP95: plain[190], medianRatio: store[100] / plain[100], p95Ratio: store[190] / plain[190] };
      });
      return { loads, plainLoads, loadRatio: loads[0] / plainLoads[0], parse: sorted(result.parses)[Math.floor(result.parses.length / 2)], rounds, megabytes: result.snapshotBytes / 1048576 };
    };
    const meets = (run) => run.loadRatio <= LOAD_FACTOR && run.rounds.some((round) => round.medianRatio <= APPEND_FACTOR && round.p95Ratio <= APPEND_FACTOR);
    const runs = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const run = await measure();
      runs.push(run);
      t0.diagnostic(`100k readings (${run.megabytes.toFixed(1)} MiB snapshot), measurement ${attempt + 1}: store load best ${run.loads[0].toFixed(0)} ms (${run.loads.map((ms) => ms.toFixed(0)).join('/')}) against a plain pass of best ${run.plainLoads[0].toFixed(0)} ms (${run.plainLoads.map((ms) => ms.toFixed(0)).join('/')}), ratio ${run.loadRatio.toFixed(2)}; ` +
        `renderer parse median ${run.parse.toFixed(0)} ms; append rounds (store median/p95 against plain median/p95, ratios): ${run.rounds.map((round) => `${round.median.toFixed(2)}/${round.p95.toFixed(2)} against ${round.plainMedian.toFixed(2)}/${round.plainP95.toFixed(2)} ms (${round.medianRatio.toFixed(1)}/${round.p95Ratio.toFixed(1)})`).join(', ')}`);
      if (meets(run)) return;
    }
    const best = runs.reduce((winner, run) => (run.loadRatio < winner.loadRatio ? run : winner));
    assert.ok(best.loadRatio <= LOAD_FACTOR, `load ${best.loads[0].toFixed(0)} ms is ${best.loadRatio.toFixed(2)} times the plain pass (${best.plainLoads[0].toFixed(0)} ms); at most ${LOAD_FACTOR} times is accepted`);
    const rounds = runs.flatMap((run) => run.rounds);
    assert.ok(rounds.some((round) => round.medianRatio <= APPEND_FACTOR && round.p95Ratio <= APPEND_FACTOR),
      `no round kept the append within ${APPEND_FACTOR} times a plain append (median ratios ${rounds.map((round) => round.medianRatio.toFixed(1)).join('/')}, p95 ratios ${rounds.map((round) => round.p95Ratio.toFixed(1)).join('/')})`);
  });
});
