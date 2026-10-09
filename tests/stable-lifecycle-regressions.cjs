'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createJsonStore } = require('../electron/store.cjs');
const { createRepairStore } = require('../electron/repair-store.cjs');
const { isInsideTemp, makeTempDir } = require('./canonical-temp.cjs');

test('lifecycle: independent profiles retain concurrent settings, workspace, note and readings writes after reopen', async (t) => {
  const root = await makeTempDir('trace-lifecycle-profile-test-');
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });

  const profiles = ['profile-a', 'profile-b'].map((name) => path.join(root, name));
  await Promise.all(profiles.map((directory) => fs.mkdir(directory)));
  const stores = profiles.map((directory) => createJsonStore({ directory, maxBytes: 1024 * 1024 }));
  const readingsStores = profiles.map((directory) => createRepairStore({ directory }));
  const familyId = 'a'.repeat(64);
  const family = { id: familyId, createdAt: '2026-10-08T00:00:00.000Z', members: [{ fingerprint: familyId, fingerprintVersion: 1, fileKeys: [] }] };
  const reading = (id, value) => ({ id, kind: 'diode', target: { net: 'SYNTHETIC_NET' }, value, unit: 'V', conditions: { power: 'unpowered' }, source: 'known-good' });

  try {
    await Promise.all(stores.map((store, index) => store.write('config.json', {
      version: 1,
      settings: { theme: index === 0 ? 'dark' : 'light', writeCount: 0 },
      recentBoards: [{ name: `synthetic-${index}.cad`, path: `/synthetic/${index}.cad` }],
    })));

    await Promise.all(stores.flatMap((store, index) => [
      store.write(`workspaces/${familyId}.json`, { owner: `profile-${index}`, documents: [] }),
      store.write(`notes/${familyId}.json`, [{ id: `note-${index}`, target: { ref: 'U1' }, text: `note-${index}` }]),
      ...Array.from({ length: 12 }, () => store.update('config.json', (current) => ({
        ...current,
        settings: { ...current.settings, writeCount: current.settings.writeCount + 1 },
      }))),
    ]));

    await Promise.all(readingsStores.map((store, index) => store.append(familyId, [
      { type: 'family.create', family },
      { type: 'reading.add', reading: reading(`reading-${index}`, index + 0.25) },
    ])));

    await Promise.all([...stores.map((store) => store.beginShutdown()), ...readingsStores.map((store) => store.beginShutdown())]);

    const reopened = profiles.map((directory) => createJsonStore({ directory, maxBytes: 1024 * 1024 }));
    const reopenedReadings = profiles.map((directory) => createRepairStore({ directory }));
    try {
      for (let index = 0; index < profiles.length; index++) {
        const config = await reopened[index].read('config.json');
        assert.equal(config.settings.theme, index === 0 ? 'dark' : 'light');
        assert.equal(config.settings.writeCount, 12, 'queued read-modify-write updates are not lost');
        assert.equal(config.recentBoards[0].path, `/synthetic/${index}.cad`);
        assert.deepEqual(await reopened[index].read(`workspaces/${familyId}.json`), { owner: `profile-${index}`, documents: [] });
        assert.equal((await reopened[index].read(`notes/${familyId}.json`))[0].text, `note-${index}`);
        const snapshot = await reopenedReadings[index].read(familyId);
        assert.deepEqual(JSON.parse(snapshot.readings).map((item) => item.value), [index + 0.25]);
      }
    } finally {
      await Promise.all([...reopened.map((store) => store.beginShutdown()), ...reopenedReadings.map((store) => store.beginShutdown())]);
    }
  } finally {
    await Promise.all([...stores.map((store) => store.beginShutdown()), ...readingsStores.map((store) => store.beginShutdown())]);
  }
});
