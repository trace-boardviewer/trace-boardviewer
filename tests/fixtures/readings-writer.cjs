'use strict';

// Writer process of the kill-during-write check in tests/readings-store-checks.cjs: appends batches of readings to one family as fast as
// it can, with a small compaction threshold so that snapshots are written and logs emptied all the time, and prints "ack <batches>
// <readings>" after every append that resolved. Chunk progress lets the parent kill during a write after observing completed batches.
//
//   node readings-writer.cjs <profile directory> <family id>
//
// Every batch adds the next readings w<n> (n counts up from 0, a long note makes the records large) and replaces w0 with the value of
// the batch number, so a loaded state is consistent exactly when its readings are w0 .. w<m-1> and w0 carries the number of the last
// applied batch.

const fs = require('node:fs/promises');
const { createRepairStore } = require('../../electron/repair-store.cjs');

const [directory, id] = process.argv.slice(2);
const NOTE = 'x'.repeat(400);
const reading = (n, value) => ({ id: `w${n}`, kind: 'voltage', target: { ref: 'U1', pin: String(n) }, value, unit: 'V', conditions: { power: 'powered' }, source: 'measured', note: NOTE });

// Every write goes out in 4 KiB pieces. After each piece the writer waits for the parent to continue or kill it, so the kill
// deterministically lands inside a write instead of depending on scheduling or disk speed.
async function chunked(filename, data, flag, mode) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const owned = typeof filename === 'string';
  const handle = owned ? await fs.open(filename, flag, mode) : filename;
  try {
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      await handle.write(bytes, offset, Math.min(4096, bytes.length - offset));
      const continued = new Promise((resolve) => process.stdin.once('data', resolve));
      process.stdout.write(`write ${owned && filename.endsWith('.tmp') ? 'snapshot' : 'log'} ${offset + Math.min(4096, bytes.length - offset)}\n`);
      await continued;
    }
  } finally { if (owned) await handle.close(); }
}
const slowFs = Object.create(fs);
slowFs.appendFile = (filename, data, options) => chunked(filename, data, 'a', options && options.mode);
slowFs.writeFile = (filename, data, options) => chunked(filename, data, (options && options.flag) || 'w', options && options.mode);

(async () => {
  const store = createRepairStore({ directory, fs: slowFs, limits: { compactRecords: 5, compactBytes: 256 * 1024 } });
  const loaded = await store.read(id);
  let count = loaded ? loaded.readingCount : 0;
  let batch = loaded && count > 0 ? JSON.parse(loaded.readings)[0].value : 0;
  if (!loaded) await store.append(id, [{ type: 'family.create', family: { id, createdAt: '2026-10-07T08:00:00Z', members: [{ fingerprint: id, fingerprintVersion: 1, fileKeys: [] }] } }]);
  process.stdout.write(`ack ${batch} ${count}\n`);
  for (;;) {
    batch++;
    const size = 1 + (batch * 37) % 300;
    const events = [];
    for (let k = 0; k < size; k++) events.push({ type: 'reading.add', reading: reading(count + k, count + k) });
    if (count === 0) events[0] = { type: 'reading.add', reading: reading(0, batch) };
    else events.push({ type: 'reading.replace', reading: reading(0, batch) });
    await store.append(id, events);
    count += size;
    process.stdout.write(`ack ${batch} ${count}\n`);
  }
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exit(3); });
