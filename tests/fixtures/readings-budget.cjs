'use strict';

// Measurement process of the budget check in tests/readings-store-checks.cjs (and of the numbers in the readings evidence): a family
// of 100,000 readings is built in <profile directory>, then appends and loads are timed in this plain process, without the test
// runner's async bookkeeping on every promise (which slows file operations several times over and is absent in the application).
// Every timed store operation is followed at once by a plain reference operation on the same data in the same process: an append
// of a record of the same size to a scratch file through a warm descriptor, and a read of the snapshot with its CRC-32 check, decoding,
// line split and index by id. The check compares the two, so a busy machine slows both alike and the check needs no fixed number of milliseconds.
// Prints one JSON line: { tooMany, appends: [[ms...] x 3 rounds], plainAppends: [[ms...] x 3 rounds], loads: [ms...],
// plainLoads: [ms...], parses: [ms...], snapshotBytes }.
//
//   node readings-budget.cjs <profile directory>

const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRepairStore, serializeRecord } = require('../../electron/repair-store.cjs');

const [directory] = process.argv.slice(2);
const ID = 'a'.repeat(64);
const KINDS = ['diode', 'voltage', 'resistance', 'continuity'];
// A realistic mix: pin and net targets, every kind, OL, state label, meter model, raw text and time.
function reading(n) {
  const kind = KINDS[n % 4];
  const value = kind === 'continuity' ? { connected: n % 2 === 0 } : n % 17 === 0 ? { ol: true } : { value: (n % 1000) / 1000, unit: kind === 'resistance' ? 'ohm' : 'V' };
  return {
    id: `r${n}`, kind, target: n % 3 ? { ref: `U${n % 5000}`, pin: String(n % 64), net: `NET_${n % 9000}` } : { net: `PP3V3_S${n % 50}` }, ...value, raw: '0.412',
    conditions: { power: kind === 'voltage' ? 'powered' : 'unpowered', state: 'S0', meter: 'UT61E+' }, source: n % 2 ? 'measured' : 'known-good', takenAt: '2026-10-07T10:11:12.345Z',
  };
}
const voltage = (n, value) => ({ id: `r${n}`, kind: 'voltage', target: { ref: 'U1', pin: String(n % 64) }, value, unit: 'V', conditions: { power: 'powered' }, source: 'measured' });

(async () => {
  const store = createRepairStore({ directory });
  await store.append(ID, [{ type: 'family.create', family: { id: ID, createdAt: '2026-10-07T08:00:00Z', members: [{ fingerprint: ID, fingerprintVersion: 1, fileKeys: [] }] } }]);
  for (let start = 0; start < 100000; start += 10000) {
    const events = [];
    for (let n = start; n < start + 10000; n++) events.push({ type: 'reading.add', reading: reading(n) });
    await store.append(ID, events);
  }
  await store.flush();
  let tooMany = null;
  await store.append(ID, [{ type: 'reading.add', reading: reading(100000) }]).catch((error) => { tooMany = error.code; });
  // Appends to the 100k family (replacing readings): a warm-up round that is not counted, then three rounds of 200 (a shared machine
  // can stall one round; the check takes the best round).
  // Each append is paired with a plain append of a record of the same size through a warm descriptor (the store keeps one open too).
  const plainLog = await fs.open(path.join(directory, 'plain-append.log'), 'a');
  const appends = [];
  const plainAppends = [];
  for (let round = 0; round < 4; round++) {
    const times = [];
    const plainTimes = [];
    for (let n = 0; n < 200; n++) {
      const events = [{ type: 'reading.replace', reading: voltage(n * 4 + 1, round + n / 100) }];
      const record = serializeRecord(n + 1, '2026-10-07T10:11:12.345Z', events);
      const started = performance.now();
      await store.append(ID, events);
      times.push(performance.now() - started);
      const plainStarted = performance.now();
      await fs.appendFile(plainLog, record, { encoding: 'utf8' });
      plainTimes.push(performance.now() - plainStarted);
    }
    if (round > 0) { appends.push(times); plainAppends.push(plainTimes); }
  }
  await plainLog.close();
  await store.compact(ID);
  // Loads by fresh stores (the files are read, checked and indexed), and the renderer's parse of the readings text.
  const snapshotFile = path.join(directory, 'readings', `${ID}.snapshot.jsonl`);
  const loads = [];
  const plainLoads = [];
  const parses = [];
  for (let run = 0; run < 9; run++) {
    const fresh = createRepairStore({ directory });
    const started = performance.now();
    const snapshot = await fresh.read(ID);
    loads.push(performance.now() - started);
    const parsing = performance.now();
    const list = JSON.parse(snapshot.readings);
    parses.push(performance.now() - parsing);
    if (list.length !== 100000) throw new Error(`loaded ${list.length} readings`);
    // The plain pass over the same data, which any load has to make: read the bytes, check the CRC-32, decode the text, cut it into
    // lines and index them by their id (the store does that and checks the layout of every line).
    const plainStarted = performance.now();
    const bytes = await fs.readFile(snapshotFile);
    const checksum = zlib.crc32(bytes);
    const lines = bytes.toString('utf8').split('\n');
    const index = new Map();
    for (let at = 1; at < lines.length - 2; at++) { const line = lines[at], start = line.indexOf('"id":"') + 6; index.set(line.slice(start, line.indexOf('"', start)), line); }
    plainLoads.push(performance.now() - plainStarted);
    if (index.size !== 100000 || !Number.isInteger(checksum)) throw new Error(`the plain pass indexed ${index.size} lines`);
  }
  const snapshotBytes = (await fs.stat(snapshotFile)).size;
  process.stdout.write(`${JSON.stringify({ tooMany, appends, plainAppends, loads, plainLoads, parses, snapshotBytes })}\n`);
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exit(3); });
