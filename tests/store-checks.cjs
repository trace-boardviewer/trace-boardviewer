'use strict';

// Native tests for electron/store.cjs: the B01 shutdown race (deterministic, with a mocked
// node:fs/promises whose rename can be held until released), FIFO ordering, atomic-write cleanup,
// growth-safe bounded reads, queued read-modify-write and name/option validation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createJsonStore, createByteBudget, validateName, readBounded, DEFAULT_MAX_BYTES, RENAME_RETRY_DELAYS_MS, renameWithRetry, hasStreamSeparator, localAbsolutePath,
} = require('../electron/store.cjs');
const documents = require('../electron/documents.cjs');
const { isInsideTemp, makeTempDir } = require('./canonical-temp.cjs');

const t = (key) => key;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (condition) => { for (let i = 0; i < 500; i++) { if (condition()) return; await sleep(2); } throw new Error('Test gate timed out.'); };
// 'pending' | 'resolved' | 'rejected' after ms milliseconds.
const settles = (promise, ms = 40) => Promise.race([promise.then(() => 'resolved', () => 'rejected'), sleep(ms).then(() => 'pending')]);
async function tmpFiles(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.tmp')) found.push(entry.name);
  }
  return found;
}
const readJson = async (filename) => JSON.parse(await fs.readFile(filename, 'utf8'));

// node:fs/promises derivative whose rename blocks for the given targets until released (as in an
// audit script) and can be told to fail once.
function blockableFs(shouldBlock) {
  const pending = [];
  const releases = [];
  const mockFs = Object.create(fs);
  mockFs.failNextRename = null;
  mockFs.rename = async (from, to) => {
    if (mockFs.failNextRename) { const error = mockFs.failNextRename; mockFs.failNextRename = null; throw error; }
    if (shouldBlock(to)) { pending.push({ from, to }); await new Promise((resolve) => releases.push(resolve)); }
    return fs.rename(from, to);
  };
  return { mockFs, pending, releases, releaseAll: () => { for (const release of releases.splice(0)) release(); } };
}

test('electron/store.cjs: queued atomic JSON store with a shutdown gate', async (t0) => {
  const root = await makeTempDir('trace-store-test-');
  t0.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  let counter = 0;
  const profile = async () => { const directory = path.join(root, `profile-${++counter}`); await fs.mkdir(directory); return directory; };

  await t0.test('B01: a write submitted after shutdown began is rejected and the accepted write completes before the drain resolves', async () => {
    for (const name of ['config.json', `notes/${'a'.repeat(64)}.json`]) {
      const directory = await profile();
      const target = path.join(directory, ...name.split('/'));
      const { mockFs, pending, releases, releaseAll } = blockableFs((to) => to === target);
      try {
        const store = createJsonStore({ directory, maxBytes: 1024 * 1024, t, fs: mockFs });
        const first = store.write(name, { n: 1 });
        await wait(() => pending.length === 1);
        const shutdown = store.beginShutdown();
        assert.equal(store.closing, true);
        const second = store.write(name, { n: 2 });
        // Rejected without waiting for the blocked rename: the queue is never touched.
        await assert.rejects(second, { code: 'STORE_CLOSING', message: /shutting down/ });
        assert.equal(await settles(shutdown), 'pending', 'the drain waits for the accepted write');
        assert.equal(pending.length, 1, 'the rejected write never reached rename');
        releases[0]();
        await first;
        await shutdown;
        assert.deepEqual(await readJson(target), { n: 1 });
        assert.equal(pending.length, 1);
        assert.deepEqual(await tmpFiles(directory), []);
        await assert.rejects(store.write(name, { n: 3 }), { code: 'STORE_CLOSING' });
        await assert.rejects(store.update(name, (value) => value), { code: 'STORE_CLOSING' });
        assert.deepEqual(await store.read(name), { n: 1 }, 'reads keep working after shutdown');
        await store.flush();
        await store.beginShutdown();
      } finally { releaseAll(); }
    }
  });

  await t0.test('a write accepted before shutdown is drained even when its own rename blocks', async () => {
    const directory = await profile();
    const target = path.join(directory, 'config.json');
    const { mockFs, pending, releases, releaseAll } = blockableFs((to) => to === target);
    try {
      const store = createJsonStore({ directory, t, fs: mockFs });
      const first = store.write('config.json', { n: 1 });
      await wait(() => pending.length === 1);
      const second = store.write('config.json', { n: 2 });
      const shutdown = store.beginShutdown();
      releases[0]();
      await first;
      await wait(() => pending.length === 2);
      // This is the exact moment the audited main.cjs called the final app.quit(): the second
      // accepted write is blocked before its rename. The drain must still be pending here.
      assert.equal(await settles(shutdown), 'pending');
      assert.equal(await settles(second), 'pending');
      releases[1]();
      await second;
      await shutdown;
      assert.deepEqual(await readJson(target), { n: 2 });
      assert.deepEqual(await tmpFiles(directory), []);
    } finally { releaseAll(); }
  });

  await t0.test('sequential writes keep submission order even when later renames would finish first', async () => {
    const directory = await profile();
    const order = [];
    const mockFs = Object.create(fs);
    let call = 0;
    mockFs.rename = async (from, to) => {
      const index = call++;
      await sleep(Math.max(0, 20 - index) * 2);
      order.push(JSON.parse(await fs.readFile(from, 'utf8')).n);
      return fs.rename(from, to);
    };
    const store = createJsonStore({ directory, t, fs: mockFs });
    const writes = Array.from({ length: 20 }, (_, index) => store.write('ordered.json', { n: index + 1 }));
    await Promise.all(writes);
    assert.deepEqual(order, Array.from({ length: 20 }, (_, index) => index + 1));
    assert.deepEqual(await readJson(path.join(directory, 'ordered.json')), { n: 20 });
    assert.deepEqual(await tmpFiles(directory), []);
  });

  await t0.test('a failed write removes its temporary file, is reported to its caller only and does not block the queue', async () => {
    const directory = await profile();
    const { mockFs, releaseAll } = blockableFs(() => false);
    try {
      const store = createJsonStore({ directory, t, fs: mockFs });
      await store.write('broken.json', { n: 0 });
      mockFs.failNextRename = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      const failed = store.write('broken.json', { n: 1 });
      const next = store.write('broken.json', { n: 2 });
      await assert.rejects(failed, (error) => {
        assert.equal(error.code, 'STORE_WRITE_FAILED');
        assert.equal(error.message, 'native.error.dataSaveFailed');
        assert.equal(error.cause.code, 'ENOSPC');
        return true;
      });
      await store.flush();
      await next;
      assert.deepEqual(await readJson(path.join(directory, 'broken.json')), { n: 2 });
      assert.deepEqual(await tmpFiles(directory), []);
      // A failure before rename (the temporary file could not be created) is reported the same way.
      const failingWrite = Object.create(mockFs);
      failingWrite.writeFile = async () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); };
      const readOnly = createJsonStore({ directory, t, fs: failingWrite });
      await assert.rejects(readOnly.write('broken.json', { n: 3 }), { code: 'STORE_WRITE_FAILED', message: 'native.error.dataSaveFailed' });
      await readOnly.beginShutdown();
      assert.deepEqual(await readJson(path.join(directory, 'broken.json')), { n: 2 });
      assert.deepEqual(await tmpFiles(directory), []);
    } finally { releaseAll(); }
  });

  await t0.test('read: missing entry is null, damaged JSON, oversized and growing files are structured errors', async () => {
    const directory = await profile();
    const store = createJsonStore({ directory, maxBytes: 64, t });
    assert.equal(await store.read('missing.json'), null);
    assert.equal(await store.read('notes/missing.json'), null, 'a missing sub-directory is also null');
    await store.write('ok.json', { n: 1 });
    assert.deepEqual(await store.read('ok.json'), { n: 1 });
    await fs.writeFile(path.join(directory, 'damaged.json'), '{ not json');
    await assert.rejects(store.read('damaged.json'), { code: 'STORE_INVALID_JSON', message: 'native.error.dataFileInvalid' });
    await fs.writeFile(path.join(directory, 'big.json'), `"${'x'.repeat(70)}"`);
    await assert.rejects(store.read('big.json'), { code: 'STORE_TOO_LARGE', message: 'native.error.fileLimitExceeded' });
    await fs.writeFile(path.join(directory, 'exact.json'), `"${'x'.repeat(62)}"`); // 64 bytes: still allowed
    assert.equal((await store.read('exact.json')).length, 62);
    await fs.mkdir(path.join(directory, 'folder.json'));
    await assert.rejects(store.read('folder.json'), (error) => /^STORE_/.test(error.code) && ['native.error.notAFile', 'native.error.dataFileInvalid'].includes(error.message));
    // A file that grows between stat() and read(): the handle reports the old size.
    const growing = Object.create(fs);
    growing.open = async (filename, ...rest) => {
      const handle = await fs.open(filename, ...rest);
      return new Proxy(handle, { get(file, key) {
        if (key === 'stat') return async () => { const stat = await file.stat(); return Object.assign(stat, { size: stat.size - 3, isFile: () => true }); };
        const value = file[key];
        return typeof value === 'function' ? value.bind(file) : value;
      } });
    };
    const racy = createJsonStore({ directory, maxBytes: 64, t, fs: growing });
    await assert.rejects(racy.read('ok.json'), { code: 'STORE_CHANGED', message: 'native.error.fileChangedWhileReading' });
    // readBounded itself never allocates more than maxBytes + 1.
    const handle = await fs.open(path.join(directory, 'big.json'), 'r');
    try {
      await assert.rejects(readBounded(handle, 65, 64, t), { code: 'STORE_TOO_LARGE' });
      await assert.rejects(readBounded(handle, 10, 64, t), { code: 'STORE_CHANGED' });
      assert.equal((await readBounded(handle, 72, 100, t)).byteLength, 72);
    } finally { await handle.close(); }
  });

  await t0.test('update sees committed values under concurrency and after a blocked write', async () => {
    const directory = await profile();
    const target = path.join(directory, 'counter.json');
    const { mockFs, pending, releases, releaseAll } = blockableFs((to) => to === target);
    try {
      const store = createJsonStore({ directory, t, fs: mockFs });
      const seen = [];
      const results = await Promise.all(Array.from({ length: 10 }, () => store.update('config.json', (value) => {
        seen.push(value);
        return { n: (value ? value.n : 0) + 1 };
      })));
      assert.equal(seen[0], null, 'a missing entry is presented as null');
      assert.deepEqual(results.map((value) => value.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.deepEqual(await readJson(path.join(directory, 'config.json')), { n: 10 });
      // An update queued behind a blocked write sees that write's value, never the older file.
      const seed = store.write('counter.json', { n: 40 });
      await wait(() => pending.length === 1);
      releases[0]();
      await seed;
      const blocked = store.write('counter.json', { n: 41 });
      await wait(() => pending.length === 2);
      const update = store.update('counter.json', (value) => ({ n: value.n + 1 }));
      assert.equal(await settles(update), 'pending');
      assert.deepEqual(await readJson(target), { n: 40 }, 'the older file is still on disk while the write is blocked');
      releases[1]();
      await blocked;
      await wait(() => pending.length === 3);
      releases[2]();
      assert.deepEqual(await update, { n: 42 });
      assert.deepEqual(await readJson(target), { n: 42 });
      // A failing updater writes nothing and does not block the queue; oversized results are rejected.
      await assert.rejects(store.update('config.json', () => { throw new Error('updater failed'); }), { message: 'updater failed' });
      const small = createJsonStore({ directory, maxBytes: 32, t });
      await assert.rejects(small.update('config.json', () => ({ text: 'x'.repeat(40) })), { code: 'STORE_TOO_LARGE' });
      await assert.rejects(store.update('config.json', 'not a function'), { code: 'STORE_INVALID_OPTIONS' });
      assert.deepEqual(await store.read('config.json'), { n: 10 });
      await store.flush();
    } finally { releaseAll(); }
  });

  await t0.test('names are validated, never leave the store directory and sub-directories are created on demand', async () => {
    const directory = await profile();
    const store = createJsonStore({ directory, t });
    assert.equal(store.path('notes/a.json'), path.join(directory, 'notes', 'a.json'));
    assert.deepEqual(validateName('workspaces/x-y_z.1.json'), ['workspaces', 'x-y_z.1.json']);
    await store.write(`notes/${'a'.repeat(64)}.json`, [{ id: 'n1' }]);
    await store.write('workspaces/key.json', { version: 1 });
    assert.deepEqual(await store.read(`notes/${'a'.repeat(64)}.json`), [{ id: 'n1' }]);
    assert.deepEqual((await fs.readdir(path.join(directory, 'workspaces'))), ['key.json']);
    for (const name of ['', '../x.json', 'a/../b.json', '/abs.json', 'C:\\x.json', 'a\\b.json', 'x\0.json', 'a//b.json', '.', '..', 'a/./b',
      'a b.json', 'é.json', 'a/b/c/d/e.json', `${'a'.repeat(256)}.json`, 42, null, undefined]) {
      assert.throws(() => store.path(name), { code: 'STORE_INVALID_NAME' }, String(name));
      await assert.rejects(store.write(name, {}), { code: 'STORE_INVALID_NAME' }, String(name));
      await assert.rejects(store.read(name), { code: 'STORE_INVALID_NAME' }, String(name));
      await assert.rejects(store.update(name, (value) => value), { code: 'STORE_INVALID_NAME' }, String(name));
    }
    assert.deepEqual((await fs.readdir(directory)).sort(), ['notes', 'workspaces']);
  });

  await t0.test('the size limit is enforced before queuing and unserializable values are rejected', async () => {
    const directory = await profile();
    const target = path.join(directory, 'config.json');
    const { mockFs, pending, releases, releaseAll } = blockableFs((to) => to === target);
    try {
      const store = createJsonStore({ directory, maxBytes: 64, t, fs: mockFs });
      const blocked = store.write('config.json', { n: 1 });
      await wait(() => pending.length === 1);
      // Rejected immediately although the queue is blocked: nothing was queued.
      await assert.rejects(store.write('big.json', { text: 'x'.repeat(100) }), { code: 'STORE_TOO_LARGE', message: 'native.error.fileLimitExceeded' });
      await assert.rejects(store.write('config.json', undefined), { code: 'STORE_NOT_SERIALIZABLE' });
      assert.equal(pending.length, 1, 'rejected writes were never queued');
      releases[0]();
      await blocked;
      // A serialized value of exactly maxBytes is accepted: '{\n  "s": "<50 x>"\n}\n' is 64 bytes.
      await store.write('exact.json', { s: 'x'.repeat(50) });
      await assert.rejects(store.write('exact.json', { s: 'x'.repeat(51) }), { code: 'STORE_TOO_LARGE' });
      assert.equal((await fs.stat(path.join(directory, 'exact.json'))).size, 64);
      assert.equal(await store.read('big.json'), null);
      await store.beginShutdown();
    } finally { releaseAll(); }
  });

  await t0.test('B33: readBounded returns exactly the stat size; a shrunk file is STORE_CHANGED, growth is caught, the buffer is never oversized', async () => {
    const directory = await profile();
    const file = path.join(directory, 'twenty.bin');
    await fs.writeFile(file, Buffer.alloc(20, 7));
    const handle = await fs.open(file, 'r');
    try {
      const exact = await readBounded(handle, 20, 64, t);
      assert.equal(exact.byteLength, 20);
      assert.equal(exact.buffer.byteLength, 20, 'an exactly sized ArrayBuffer: nothing to clone beyond the file');
      assert.ok(exact.every((byte) => byte === 7));
      await assert.rejects(readBounded(handle, 21, 64, t), { code: 'STORE_CHANGED', message: 'native.error.fileChangedWhileReading' }, 'shrank by one byte after stat');
      await assert.rejects(readBounded(handle, 64, 64, t), { code: 'STORE_CHANGED' }, 'shrank to a third');
      await assert.rejects(readBounded(handle, 19, 64, t), { code: 'STORE_CHANGED' }, 'grew by one byte after stat');
      await assert.rejects(readBounded(handle, 19, 19, t), { code: 'STORE_TOO_LARGE' }, 'grew past the limit');
      await assert.rejects(readBounded(handle, 65, 64, t), { code: 'STORE_TOO_LARGE' });
      assert.equal((await readBounded(handle, 0, 64, t).catch((error) => error.code)), 'STORE_CHANGED', 'announced empty but not empty');
    } finally { await handle.close(); }
    await fs.writeFile(path.join(directory, 'empty.bin'), '');
    const empty = await fs.open(path.join(directory, 'empty.bin'), 'r');
    try { assert.equal((await readBounded(empty, 0, 8, t)).byteLength, 0); } finally { await empty.close(); }
    // A store entry that shrank after stat() is an error, not a damaged-but-parsed value.
    await fs.writeFile(path.join(directory, 'entry.json'), '{"n":1}\n');
    const shrinking = Object.create(fs);
    shrinking.open = async (filename, ...rest) => {
      const real = await fs.open(filename, ...rest);
      return new Proxy(real, { get(target, key) {
        if (key === 'stat') return async () => Object.assign(await target.stat(), { size: 12 });
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    await assert.rejects(createJsonStore({ directory, t, fs: shrinking }).read('entry.json'), { code: 'STORE_CHANGED' });
  });

  await t0.test('readBounded runs its checkpoint before the allocation and between chunks, so a superseded reader stops mid-read', async () => {
    const directory = await profile();
    const file = path.join(directory, 'chunked.bin');
    await fs.writeFile(file, Buffer.alloc(10 * 1024, 1));
    const handle = await fs.open(file, 'r');
    try {
      let calls = 0;
      const reads = [];
      const watched = new Proxy(handle, { get(target, key) {
        if (key === 'read') return (buffer, offset, length, position) => { reads.push([offset, length]); return target.read(buffer, offset, length, position); };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const stop = new Error('superseded');
      await assert.rejects(readBounded(watched, 10 * 1024, 64 * 1024, t, { chunkBytes: 4096, checkpoint: () => { if (++calls === 3) throw stop; } }), (error) => error === stop);
      assert.deepEqual(reads, [[0, 4096]], 'only the first 4 KiB were read before the checkpoint stopped the rest');
      calls = 0;
      assert.equal((await readBounded(handle, 10 * 1024, 64 * 1024, t, { chunkBytes: 4096, checkpoint: () => { calls++; } })).byteLength, 10 * 1024);
      assert.equal(calls, 4, 'one check before the allocation and one before each of the three chunks');
      let allocated = false;
      await assert.rejects(readBounded(handle, 10, 64, t, { checkpoint: () => { throw new Error('stop before allocating'); } }), /stop before allocating/);
      assert.equal(allocated, false);
    } finally { await handle.close(); }
  });

  await t0.test('createByteBudget: first come first served, an oversized request runs alone, releases are idempotent, cancelled waiters leave the queue', async () => {
    const budget = createByteBudget(100);
    assert.equal(budget.limitBytes, 100);
    const a = await budget.acquire(60);
    const b = await budget.acquire(40);
    assert.equal(budget.inFlight, 100);
    let granted = '';
    const c = budget.acquire(30).then((release) => { granted += 'c'; return release; });
    const d = budget.acquire(10).then((release) => { granted += 'd'; return release; });
    await sleep(15);
    assert.equal(granted, '', 'd is small enough but may not jump ahead of c');
    assert.equal(budget.waiting, 2);
    a();
    a(); // A second release of the same grant changes nothing.
    assert.equal(budget.inFlight, 40 + 30 + 10, 'c and then d took the freed bytes, in that order');
    const releaseC = await c;
    const releaseD = await d;
    assert.equal(granted, 'cd');
    assert.equal(budget.inFlight, 80);
    b(); releaseC(); releaseD();
    assert.equal(budget.inFlight, 0);
    // A request larger than the whole budget is not starved: it runs when nothing else does.
    const small = await budget.acquire(10);
    let hugeGranted = false;
    const huge = budget.acquire(500).then((release) => { hugeGranted = true; return release; });
    await sleep(10);
    assert.equal(hugeGranted, false);
    small();
    const releaseHuge = await huge;
    assert.equal(budget.inFlight, 500);
    releaseHuge();
    // A waiter whose check throws is rejected without ever holding bytes, even while the budget stays full.
    const full = await budget.acquire(100);
    let superseded = false;
    const waiting = budget.acquire(50, () => { if (superseded) throw Object.assign(new Error('superseded'), { superseded: true }); });
    const behind = budget.acquire(20);
    superseded = true;
    budget.poke();
    await assert.rejects(waiting, { superseded: true });
    assert.equal(budget.waiting, 1);
    full();
    (await behind)();
    assert.equal(budget.inFlight, 0);
    await assert.rejects(budget.acquire(-1), { code: 'STORE_INVALID_OPTIONS' });
    await assert.rejects(budget.acquire(1.5), { code: 'STORE_INVALID_OPTIONS' });
    for (const bad of [0, -5, 1.5, NaN, '8']) assert.throws(() => createByteBudget(bad), { code: 'STORE_INVALID_OPTIONS' });
    assert.equal((await budget.acquire(0)) instanceof Function, true, 'zero bytes are always granted');
  });

  await t0.test('per-call limits, the missing marker and compute(): in-queue producer with commit, failures do not commit or block', async () => {
    const directory = await profile();
    const store = createJsonStore({ directory, maxBytes: 1024, t });
    await store.write('small.json', { text: 'x'.repeat(100) });
    await assert.rejects(store.write('small.json', { text: 'x'.repeat(100) }, { maxBytes: 64 }), { code: 'STORE_TOO_LARGE' }, 'a call may narrow the limit');
    await assert.rejects(store.read('small.json', { maxBytes: 64 }), { code: 'STORE_TOO_LARGE' });
    assert.equal((await store.read('small.json', { maxBytes: 512 })).text.length, 100);
    for (const maxBytes of [0, -1, 1.5, 2048, '8']) {
      await assert.rejects(store.read('small.json', { maxBytes }), { code: 'STORE_INVALID_OPTIONS' }, `read ${maxBytes}`);
      await assert.rejects(store.write('small.json', {}, { maxBytes }), { code: 'STORE_INVALID_OPTIONS' }, `write ${maxBytes}`);
    }
    const MISSING = Symbol('missing');
    assert.equal(await store.read('absent.json', { missing: MISSING }), MISSING);
    assert.deepEqual(await store.read('absent.json', { missing: [] }), []);
    assert.equal(await store.read('absent.json'), null);
    await fs.writeFile(path.join(directory, 'null.json'), 'null');
    assert.equal(await store.read('null.json', { missing: MISSING }), null, 'a stored JSON null is a value, not a missing entry');
    // compute(): the producer runs in the queue after earlier writes; commit runs in the same slot.
    const order = [];
    const { mockFs, pending, releases, releaseAll } = blockableFs((to) => to === path.join(directory, 'config.json'));
    try {
      const gated = createJsonStore({ directory, t, fs: mockFs });
      let state = { n: 0 };
      const compute = (label, patch) => gated.compute('config.json', () => { order.push(`produce ${label} from n=${state.n}`); return { n: state.n + patch }; }, { commit: (value) => { state = value; order.push(`commit ${label} n=${value.n}`); } });
      const first = compute('A', 1);
      await wait(() => pending.length === 1);
      const second = compute('B', 10);
      const shutdown = gated.beginShutdown();
      await assert.rejects(compute('C', 100), { code: 'STORE_CLOSING' });
      assert.deepEqual(order, ['produce A from n=0'], 'B waits for A; C was refused');
      releases[0]();
      await first;
      await wait(() => pending.length === 2);
      assert.equal(await settles(shutdown), 'pending', 'the drain waits for the accepted compute B');
      releases[1]();
      await second;
      await shutdown;
      assert.deepEqual(order, ['produce A from n=0', 'commit A n=1', 'produce B from n=1', 'commit B n=11'], 'B saw the committed result of A');
      assert.deepEqual(await readJson(path.join(directory, 'config.json')), { n: 11 });
    } finally { releaseAll(); }
    const other = createJsonStore({ directory, maxBytes: 64, t });
    let committed = false;
    await assert.rejects(other.compute('c.json', () => { throw new Error('producer failed'); }, { commit: () => { committed = true; } }), { message: 'producer failed' });
    await assert.rejects(other.compute('c.json', () => ({ text: 'x'.repeat(100) }), { commit: () => { committed = true; } }), { code: 'STORE_TOO_LARGE' });
    await assert.rejects(other.compute('c.json', 'not a function'), { code: 'STORE_INVALID_OPTIONS' });
    assert.equal(committed, false, 'nothing is committed when the producer or the write fails');
    assert.equal(await other.compute('c.json', () => ({ ok: true }), { commit: () => { committed = true; } }).then((value) => value.ok), true);
    assert.equal(committed, true, 'and the queue was not blocked by the failures');
  });

  await t0.test('only the application profile may be a UNC location (trusted); any other directory still may not', async () => {
    assert.throws(() => createJsonStore({ directory: '\\\\server\\share\\profile', t }), { code: 'STORE_INVALID_PATH' });
    assert.throws(() => createJsonStore({ directory: '//server/share/profile', t, trusted: false }), { code: 'STORE_INVALID_PATH' });
    assert.doesNotThrow(() => createJsonStore({ directory: '//server/share/profile', t, trusted: true }));
    for (const directory of ['relative/profile', '', `${root}\0`]) assert.throws(() => createJsonStore({ directory, t, trusted: true }), { code: 'STORE_INVALID_PATH' }, 'trusted never means unchecked');
  });

  await t0.test('store options are validated like native paths', async () => {
    for (const directory of ['relative/profile', '\\\\server\\share\\profile', '//server/share', `${root}\0`, '', 42, undefined, 'x'.repeat(32768)]) {
      assert.throws(() => createJsonStore({ directory, t }), { code: 'STORE_INVALID_PATH', message: 'native.error.invalidPath' }, String(directory));
    }
    assert.throws(() => createJsonStore(), { code: 'STORE_INVALID_PATH' });
    for (const maxBytes of [0, -1, 1.5, NaN, Infinity, '8']) assert.throws(() => createJsonStore({ directory: root, maxBytes, t }), { code: 'STORE_INVALID_OPTIONS' });
    const store = createJsonStore({ directory: path.join(root, 'sub', '..', 'normalized') });
    assert.equal(store.directory, path.join(root, 'normalized'));
    assert.equal(store.maxBytes, DEFAULT_MAX_BYTES);
    assert.equal(store.closing, false);
    // Without a translator the catalog key itself is the message, so a missing injection is visible.
    assert.throws(() => createJsonStore({ directory: 'relative' }), { message: 'native.error.invalidPath' });
  });

  await t0.test('keepFirst: a write that replaces old-shaped data keeps the old file once, in its own queue slot, and never replaces an existing copy', async () => {
    const directory = await profile();
    const store = createJsonStore({ directory, t });
    const name = 'notes/n.json', copy = 'notes/n.json.old';
    const file = (entry) => path.join(directory, ...entry.split('/'));
    const keep = { name: copy, when: (current) => Array.isArray(current) && current.some((item) => item && item.old === true) };
    // A missing target has nothing to keep.
    await store.write(name, [{ old: true, id: 1 }], { keepFirst: keep });
    await assert.rejects(fs.access(file(copy)), { code: 'ENOENT' });
    // The target now holds old-shaped data: the next write keeps it first (the copy is exactly what was there) and then replaces it.
    await store.write(name, [{ id: 2 }], { keepFirst: keep });
    assert.deepEqual(await readJson(file(copy)), [{ old: true, id: 1 }]);
    assert.deepEqual(await readJson(file(name)), [{ id: 2 }]);
    // Once the data is new-shaped there is nothing to keep, and an existing copy is never replaced, even by a later old-shaped file.
    await store.write(name, [{ id: 3 }], { keepFirst: keep });
    await store.write(name, [{ old: true, id: 4 }]);
    await store.write(name, [{ id: 5 }], { keepFirst: keep });
    assert.deepEqual(await readJson(file(copy)), [{ old: true, id: 1 }]);
    assert.deepEqual(await readJson(file(name)), [{ id: 5 }]);
    assert.deepEqual(await tmpFiles(directory), []);
    // A damaged copy is not replaced either, and a damaged target keeps nothing: the write itself still goes through.
    const other = 'notes/m.json';
    await store.write(other, [{ old: true }]);
    await fs.writeFile(file(`${other}.old`), '{not json');
    await store.write(other, [{ id: 1 }], { keepFirst: { name: `${other}.old`, when: keep.when } });
    assert.equal(await fs.readFile(file(`${other}.old`), 'utf8'), '{not json');
    assert.deepEqual(await readJson(file(other)), [{ id: 1 }]);
    await fs.writeFile(file(other), '{not json');
    await store.write(other, [{ id: 2 }], { keepFirst: { name: `${other}.second`, when: () => true } });
    await assert.rejects(fs.access(file(`${other}.second`)), { code: 'ENOENT' });
    assert.deepEqual(await readJson(file(other)), [{ id: 2 }]);
  });

  await t0.test('keepFirst: the copy and the write are one accepted operation (B01): after the quit intent both are refused, before it both complete', async () => {
    const directory = await profile();
    const name = 'notes/q.json', copy = 'notes/q.json.old';
    const target = path.join(directory, 'notes', 'q.json');
    const { mockFs, pending, releases, releaseAll } = blockableFs((to) => to === target);
    try {
      const store = createJsonStore({ directory, t, fs: mockFs });
      // The first write is plain; the second keeps the first before it replaces it, and is accepted before the quit intent.
      const keep = { name: copy, when: (current) => Array.isArray(current) && current.length === 1 };
      const first = store.write(name, [{ old: true }]);
      await wait(() => pending.length === 1);
      const second = store.write(name, [{ new: true }], { keepFirst: keep });
      const shutdown = store.beginShutdown();
      await assert.rejects(store.write(name, [{ late: true }], { keepFirst: keep }), { code: 'STORE_CLOSING' });
      releases[0]();
      await first;
      await wait(() => pending.length === 2);
      releases[1]();
      await second;
      await shutdown;
      assert.deepEqual(await readJson(path.join(directory, 'notes', 'q.json.old')), [{ old: true }]);
      assert.deepEqual(await readJson(target), [{ new: true }]);
    } finally { releaseAll(); }
  });

  await t0.test('keepFirst: a copy that cannot be written rejects the whole write and the old file stays exactly as it was', async () => {
    const directory = await profile();
    const name = 'notes/f.json', copy = 'notes/f.json.old';
    const target = path.join(directory, 'notes', 'f.json');
    const failing = Object.create(fs);
    failing.rename = async (from, to) => { if (to.endsWith('f.json.old')) throw Object.assign(new Error('ENOSPC: simulated'), { code: 'ENOSPC' }); return fs.rename(from, to); };
    const store = createJsonStore({ directory, t, fs: failing });
    const plain = createJsonStore({ directory, t });
    await plain.write(name, [{ old: true }]);
    await assert.rejects(store.write(name, [{ new: true }], { keepFirst: { name: copy, when: () => true } }), { code: 'STORE_WRITE_FAILED' });
    assert.deepEqual(await readJson(target), [{ old: true }]);
    await assert.rejects(fs.access(path.join(directory, 'notes', 'f.json.old')), { code: 'ENOENT' });
    assert.deepEqual(await tmpFiles(directory), []);
    // the queue goes on after the failure
    await plain.write(name, [{ again: true }]);
    assert.deepEqual(await readJson(target), [{ again: true }]);
  });

  await t0.test('keepFirst: the options are validated before anything is queued', async () => {
    const directory = await profile();
    const store = createJsonStore({ directory, t });
    await assert.rejects(store.write('a.json', [], { keepFirst: { name: 'a.json.old' } }), { code: 'STORE_INVALID_OPTIONS' });
    await assert.rejects(store.write('a.json', [], { keepFirst: { name: 'a.json', when: () => true } }), { code: 'STORE_INVALID_OPTIONS' });
    await assert.rejects(store.write('a.json', [], { keepFirst: { name: '../escape.json', when: () => true } }), { code: 'STORE_INVALID_NAME' });
    await assert.rejects(store.write('a.json', [], { keepFirst: { name: 'a/../../b.json', when: () => true } }), { code: 'STORE_INVALID_NAME' });
    await assert.rejects(fs.access(path.join(directory, 'a.json')), { code: 'ENOENT' });
  });
});

// ---------------------------------------------------------------------------------------------
// W-win-lifecycle-01: on Windows any other open handle on the target (the app's own concurrent read, an antivirus
// scan, the indexer, a preview pane) makes rename-over-existing fail with EPERM for a moment.
// ---------------------------------------------------------------------------------------------

// node:fs/promises derivative whose next `failures` renames fail with `code`; counts every attempt.
function flakyRenameFs(failures, code = 'EPERM') {
  const mockFs = Object.create(fs);
  const stats = { attempts: 0, failed: 0 };
  let remaining = failures;
  mockFs.rename = async (from, to) => {
    stats.attempts++;
    if (remaining > 0) { remaining--; stats.failed++; throw Object.assign(new Error(`${code}: simulated sharing violation`), { code }); }
    return fs.rename(from, to);
  };
  return { mockFs, stats };
}

// node:fs/promises derivative that behaves like Windows: renaming over a file that a read handle still has open
// fails with EPERM. `gate()` holds every read, `holdTurns` keeps the handle open a few event-loop turns longer (a
// slow disk; turns instead of timers because a Windows timer is no finer than 15.6 ms).
function windowsLikeFs({ holdTurns = 0, gate } = {}) {
  const held = new Map();
  const stats = { renames: 0, blocked: 0 };
  const mockFs = Object.create(fs);
  mockFs.open = async (filename, ...rest) => {
    const handle = await fs.open(filename, ...rest);
    if (rest[0] !== 'r') return handle;
    held.set(filename, (held.get(filename) ?? 0) + 1);
    let closed = false;
    return new Proxy(handle, { get(target, key) {
      if (key === 'read') return async (...args) => {
        if (gate) await gate();
        for (let turn = 0; turn < holdTurns; turn++) await new Promise((resolve) => setImmediate(resolve));
        return target.read(...args);
      };
      if (key === 'close') return async () => { const result = await target.close(); if (!closed) { closed = true; held.set(filename, held.get(filename) - 1); } return result; };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  mockFs.rename = async (from, to) => {
    stats.renames++;
    if ((held.get(to) ?? 0) > 0) { stats.blocked++; throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); }
    return fs.rename(from, to);
  };
  return { mockFs, stats };
}

test('electron/store.cjs: bounded rename retry and reads inside the write queue (W-win-lifecycle-01)', async (t0) => {
  const root = await makeTempDir('trace-store-retry-test-');
  t0.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  let counter = 0;
  const profile = async () => { const directory = path.join(root, `profile-${++counter}`); await fs.mkdir(directory); return directory; };
  const FAST = [1, 1, 1, 1, 1, 1]; // Six pauses = seven attempts, like the default schedule, without the waiting.

  await t0.test('the default schedule is bounded: at most 8 attempts and one second of waiting', () => {
    assert.ok(Array.isArray(RENAME_RETRY_DELAYS_MS) && Object.isFrozen(RENAME_RETRY_DELAYS_MS));
    assert.ok(RENAME_RETRY_DELAYS_MS.length >= 5 && RENAME_RETRY_DELAYS_MS.length <= 7, 'a handful of retries');
    assert.ok(RENAME_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) <= 1000);
    assert.ok(RENAME_RETRY_DELAYS_MS.every((ms, index) => index === 0 || ms >= RENAME_RETRY_DELAYS_MS[index - 1]), 'backing off');
    for (const bad of ['x', [-1], [NaN], ['5'], [6000], new Array(17).fill(1)]) assert.throws(() => createJsonStore({ directory: root, t, renameRetryDelaysMs: bad }), { code: 'STORE_INVALID_OPTIONS' }, JSON.stringify(bad));
    assert.doesNotThrow(() => createJsonStore({ directory: root, t, renameRetryDelaysMs: [] }));
  });

  await t0.test('a rename that fails with EPERM/EACCES/EBUSY up to the budget is retried: write, update and compute all succeed without data loss', async () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      for (const failures of [1, 3, 6]) {
        for (const mode of ['write', 'update', 'compute']) {
          const directory = await profile();
          const target = path.join(directory, 'state.json');
          await createJsonStore({ directory, t }).write('state.json', { n: 1 });
          const flaky = flakyRenameFs(failures, code);
          const retrying = createJsonStore({ directory, t, fs: flaky.mockFs, renameRetryDelaysMs: FAST });
          const label = `${code} x${failures} ${mode}`;
          if (mode === 'write') await retrying.write('state.json', { n: 2 });
          else if (mode === 'update') assert.deepEqual(await retrying.update('state.json', (value) => ({ n: value.n + 1 })), { n: 2 }, label);
          else assert.deepEqual(await retrying.compute('state.json', () => ({ n: 2 })), { n: 2 }, label);
          assert.equal(flaky.stats.attempts, failures + 1, `${label}: every failure was followed by another attempt`);
          assert.deepEqual(await readJson(target), { n: 2 }, `${label}: the new value is on disk`);
          assert.deepEqual(await tmpFiles(directory), [], `${label}: no temporary file is left`);
          await retrying.beginShutdown();
        }
      }
    }
  });

  await t0.test('more failures than the budget: STORE_WRITE_FAILED with the cause, the old file intact, the temporary file removed and the queue goes on', async () => {
    const directory = await profile();
    const target = path.join(directory, 'state.json');
    await createJsonStore({ directory, t }).write('state.json', { n: 1 });
    const { mockFs, stats } = flakyRenameFs(FAST.length + 1);
    const store = createJsonStore({ directory, t, fs: mockFs, renameRetryDelaysMs: FAST });
    const failed = store.write('state.json', { n: 2 });
    const next = store.write('state.json', { n: 3 });
    await assert.rejects(failed, (error) => {
      assert.equal(error.code, 'STORE_WRITE_FAILED');
      assert.equal(error.message, 'native.error.dataSaveFailed');
      assert.equal(error.cause.code, 'EPERM');
      return true;
    });
    await next; // The renames are exhausted: the write behind the failed one succeeds on its first attempt.
    assert.equal(stats.attempts, FAST.length + 1 + 1, 'the failed write used every attempt and the next one needed a single attempt');
    assert.deepEqual(await readJson(target), { n: 3 });
    assert.deepEqual(await tmpFiles(directory), []);
    // Failing for good keeps the previous value.
    const stuck = flakyRenameFs(1000);
    const store2 = createJsonStore({ directory, t, fs: stuck.mockFs, renameRetryDelaysMs: FAST });
    await assert.rejects(store2.write('state.json', { n: 4 }), { code: 'STORE_WRITE_FAILED' });
    await assert.rejects(store2.update('state.json', () => ({ n: 5 })), { code: 'STORE_WRITE_FAILED' });
    assert.deepEqual(await readJson(target), { n: 3 }, 'the last committed value survives');
    assert.deepEqual(await tmpFiles(directory), []);
  });

  await t0.test('only sharing-type errors are retried: ENOSPC, ENOENT and EROFS fail at once', async () => {
    for (const code of ['ENOSPC', 'ENOENT', 'EROFS', 'EXDEV']) {
      const directory = await profile();
      const { mockFs, stats } = flakyRenameFs(5, code);
      const store = createJsonStore({ directory, t, fs: mockFs, renameRetryDelaysMs: FAST });
      await assert.rejects(store.write('state.json', { n: 1 }), (error) => error.code === 'STORE_WRITE_FAILED' && error.cause.code === code, code);
      assert.equal(stats.attempts, 1, `${code} is not transient`);
      assert.deepEqual(await tmpFiles(directory), []);
    }
    // With an empty schedule even EPERM is final (the retry can be switched off).
    const directory = await profile();
    const { mockFs, stats } = flakyRenameFs(1);
    await assert.rejects(createJsonStore({ directory, t, fs: mockFs, renameRetryDelaysMs: [] }).write('state.json', { n: 1 }), { code: 'STORE_WRITE_FAILED' });
    assert.equal(stats.attempts, 1);
  });

  await t0.test('renameWithRetry: waits between attempts, throws the last error unchanged, passes other errors through at once', async () => {
    const calls = [];
    const failing = { rename: async (from, to) => { calls.push([from, to]); throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
    const delays = [];
    const nativeTimeout = globalThis.setTimeout;
    t0.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      delays.push(delay);
      return nativeTimeout(callback, 0, ...args);
    });
    await assert.rejects(renameWithRetry(failing, 'a', 'b', [15, 15]), { code: 'EBUSY', message: 'busy' });
    assert.equal(calls.length, 3);
    assert.deepEqual(delays, [15, 15], 'one scheduled pause between each pair of attempts');
    globalThis.setTimeout.mock.restore();
    const odd = { rename: async () => { throw 'not an error object'; } };
    await assert.rejects(renameWithRetry(odd, 'a', 'b', [1, 1]), (error) => error === 'not an error object');
    assert.equal(await renameWithRetry({ rename: async () => 'done' }, 'a', 'b'), 'done');
  });

  await t0.test('a read holds its file: a write to the same file queued behind a read that has it open waits, instead of renaming over it', async () => {
    const directory = await profile();
    const target = path.join(directory, 'state.json');
    await fs.writeFile(target, '{"n":1}\n');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let reading = false;
    const { mockFs, stats } = windowsLikeFs({ gate: async () => { reading = true; await gate; } });
    const store = createJsonStore({ directory, t, fs: mockFs, renameRetryDelaysMs: [] });
    const read = store.read('state.json');
    await wait(() => reading);
    const write = store.write('state.json', { n: 2 });
    await sleep(40);
    assert.equal(stats.renames, 0, 'the write did not start while the read still has the file open');
    release();
    assert.deepEqual(await read, { n: 1 }, 'the read submitted first sees the value before the write');
    await write;
    assert.equal(stats.blocked, 0, 'no rename ever met an open read handle');
    assert.deepEqual(await readJson(target), { n: 2 });
    assert.deepEqual(await tmpFiles(directory), []);
  });

  await t0.test('a held read blocks only writes of its own file: another entry is written meanwhile, and the held read never fails or sees a half-written file', async () => {
    const directory = await profile();
    await fs.writeFile(path.join(directory, 'held.json'), '{"n":1}\n');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let reading = false;
    const { mockFs, stats } = windowsLikeFs({ gate: async () => { reading = true; await gate; } });
    const store = createJsonStore({ directory, t, fs: mockFs, renameRetryDelaysMs: [] });
    const read = store.read('held.json');
    await wait(() => reading);
    await store.write('other.json', { n: 9 }); // A different file: not blocked by the read.
    assert.deepEqual(await readJson(path.join(directory, 'other.json')), { n: 9 });
    const sameFile = store.write('held.json', { n: 2 });
    assert.equal(await settles(sameFile), 'pending', 'the write to the file being read waits');
    release();
    assert.deepEqual(await read, { n: 1 });
    await sameFile;
    assert.equal(stats.blocked, 0);
    assert.deepEqual(await readJson(path.join(directory, 'held.json')), { n: 2 });
    // Two overlapping reads of one file both finish before the write starts; the lock is released even when a read fails.
    await fs.writeFile(path.join(directory, 'damaged.json'), '{ not json');
    const failing = store.read('damaged.json').then(() => 'read', (error) => error.code);
    const second = store.read('damaged.json').then(() => 'read', (error) => error.code);
    const rewrite = store.write('damaged.json', { repaired: true });
    assert.deepEqual(await Promise.all([failing, second]), ['STORE_INVALID_JSON', 'STORE_INVALID_JSON']);
    await rewrite;
    assert.deepEqual(await store.read('damaged.json'), { repaired: true }, 'a failed read does not leave the file locked');
    assert.deepEqual(await tmpFiles(directory), []);
  });

  await t0.test('a read submitted behind a pending write waits for it and returns its value (also after shutdown began)', async () => {
    const directory = await profile();
    const target = path.join(directory, 'state.json');
    const { mockFs, pending, releases, releaseAll } = blockableFs((to) => to === target);
    try {
      const store = createJsonStore({ directory, t, fs: mockFs });
      const write = store.write('state.json', { n: 7 });
      await wait(() => pending.length === 1);
      const read = store.read('state.json');
      assert.equal(await settles(read), 'pending', 'the read waits behind the write');
      const shutdown = store.beginShutdown();
      const lateRead = store.read('state.json');
      releases[0]();
      await write;
      assert.deepEqual(await read, { n: 7 });
      assert.deepEqual(await lateRead, { n: 7 }, 'a read accepted after shutdown began still works');
      await shutdown;
    } finally { releaseAll(); }
  });

  await t0.test('probe: 400 concurrent writes and reads of one entry on a Windows-like file system all succeed, in order, with valid JSON and no EPERM at all', async () => {
    const directory = await profile();
    const { mockFs, stats } = windowsLikeFs({ holdTurns: 6 });
    const store = createJsonStore({ directory, t, fs: mockFs });
    await store.write('probe.json', { n: -1 });
    const results = await Promise.allSettled(Array.from({ length: 400 }, (_, index) => (index % 2 === 0 ? store.write('probe.json', { n: index }) : store.read('probe.json'))));
    const failed = results.filter((result) => result.status === 'rejected');
    assert.equal(failed.length, 0, `failed operations: ${failed.length} (first: ${failed[0]?.reason?.message})`);
    assert.equal(stats.blocked, 0, 'reads and writes never overlapped');
    results.forEach((result, index) => { if (index % 2 === 1) assert.deepEqual(result.value, { n: index - 1 }, `read ${index} sees the write submitted just before it`); });
    assert.deepEqual(await readJson(path.join(directory, 'probe.json')), { n: 398 });
    assert.deepEqual(await tmpFiles(directory), []);
  });

  await t0.test('probe: the same 400 operations on this machine\'s real file system, several entries at once', async () => {
    const directory = await profile();
    const store = createJsonStore({ directory, t });
    const names = ['a.json', 'b.json', 'c.json'];
    for (const name of names) await store.write(name, { n: -1 });
    const results = await Promise.allSettled(Array.from({ length: 400 }, (_, index) => {
      const name = names[index % names.length];
      return Math.floor(index / names.length) % 2 === 0 ? store.write(name, { n: index }) : store.read(name);
    }));
    const failed = results.filter((result) => result.status === 'rejected');
    assert.equal(failed.length, 0, `failed operations: ${failed.length} (first: ${failed[0]?.reason?.cause?.code ?? failed[0]?.reason?.message})`);
    for (const name of names) assert.equal(typeof (await readJson(path.join(directory, name))).n, 'number');
    assert.deepEqual(await tmpFiles(directory), []);
  });
});

test('electron/documents.cjs: the export bundle retries its final rename like the store (W-win-lifecycle-01)', async (t0) => {
  const root = await makeTempDir('trace-export-retry-test-');
  t0.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const fflate = require('fflate');
  const board = path.join(root, 'Board.cad');
  await fs.writeFile(board, '$HEADER\nGENCAD 1.4\n$ENDHEADER\n');
  const manifest = {
    version: 1, board: { key: 'a'.repeat(64), name: 'Board.cad', path: board, format: 'gencad' }, documents: [],
    split: { enabled: false, ratio: 0.5, right: null }, activeTab: 'board', cameras: {}, updatedAt: '2026-03-04T05:06:07.000Z',
  };
  const exportTo = (target, mockFs, delays = [1, 1, 1]) => documents.exportBundle({
    manifest, notes: [], documentIds: [], includeBoard: false, boardFiles: null, target, t, fs: mockFs, platform: process.platform, renameRetryDelaysMs: delays,
  });
  let counter = 0;
  const targetFile = () => path.join(root, `bundle-${++counter}.zip`);
  const leftovers = async () => (await fs.readdir(root)).filter((name) => name.endsWith('.tmp'));

  await t0.test('EPERM/EACCES/EBUSY within the budget: the bundle is written and complete, no temporary file is left', async () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const target = targetFile();
      await fs.writeFile(target, 'an older bundle');
      const { mockFs, stats } = flakyRenameFs(3, code);
      const result = await exportTo(target, mockFs);
      assert.equal(result.path, target);
      assert.equal(stats.attempts, 4, `${code}: three failures, then the rename that worked`);
      assert.deepEqual(Object.keys(fflate.unzipSync(new Uint8Array(await fs.readFile(target)))).sort(), ['notes.json', 'workspace.json'], code);
      assert.deepEqual(await leftovers(), [], code);
    }
  });

  await t0.test('more failures than the budget: EXPORT_WRITE_FAILED, the existing file at the destination is untouched, the temporary file is removed', async () => {
    const target = targetFile();
    await fs.writeFile(target, 'an older bundle');
    const { mockFs, stats } = flakyRenameFs(1000);
    await assert.rejects(exportTo(target, mockFs), (error) => error.code === 'EXPORT_WRITE_FAILED' && error.cause.code === 'EPERM');
    assert.equal(stats.attempts, 4, 'three pauses = four attempts, then it gave up');
    assert.equal(await fs.readFile(target, 'utf8'), 'an older bundle');
    assert.deepEqual(await leftovers(), []);
  });

  await t0.test('a non-transient rename error is not retried', async () => {
    const target = targetFile();
    const { mockFs, stats } = flakyRenameFs(5, 'ENOSPC');
    await assert.rejects(exportTo(target, mockFs), { code: 'EXPORT_WRITE_FAILED' });
    assert.equal(stats.attempts, 1);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    assert.deepEqual(await leftovers(), []);
  });
});

test('W-fin-lifecycle-01: a Windows path that names an NTFS alternate data stream is not a local path; other platforms keep the colon', () => {
  for (const name of ['C:\\Boards\\host.txt:alt.cad', 'C:\\Boards\\host.cad:stream', 'C:\\Boards\\dir:x\\board.cad', 'D:/Boards/host.txt:alt.cad', '\\\\server\\share\\a:b.cad']) {
    assert.equal(hasStreamSeparator(name, 'win32'), true, name);
  }
  for (const name of ['C:\\Boards\\board.cad', 'c:\\Boards\\Sub Dir\\Board (2).CAD', 'D:/Boards/board.cad', '\\\\server\\share\\board.cad', 'C:\\']) {
    assert.equal(hasStreamSeparator(name, 'win32'), false, name);
  }
  for (const platform of ['linux', 'darwin']) assert.equal(hasStreamSeparator('/home/user/board:v2.cad', platform), false, `${platform} allows ':' in a file name`);
  assert.equal(hasStreamSeparator(42, 'win32'), false);
  if (process.platform === 'win32') {
    assert.throws(() => localAbsolutePath('C:\\Boards\\host.txt:alt.cad', t), { code: 'STORE_INVALID_PATH', message: 'native.error.invalidPath' });
    assert.equal(localAbsolutePath('C:\\Boards\\board.cad', t), 'C:\\Boards\\board.cad');
    assert.doesNotThrow(() => localAbsolutePath('C:\\Users\\x\\AppData\\profile', t, true), 'the trusted profile directory is not subject to the stream rule');
  }
});

// The repair store (electron/repair-store.cjs) builds on this store's helpers; its checks run with this suite.
require('./readings-store-checks.cjs');
