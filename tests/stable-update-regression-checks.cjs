'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const updates = require('../electron/updates.cjs');

const stableRelease = () => new Response(JSON.stringify({
  tag_name: 'v1.3.1',
  draft: false,
  prerelease: false,
  // The notification must use only the validated tag, never response supplied URLs or asset links.
  html_url: 'https://untrusted.example/release',
  assets: [{ browser_download_url: 'https://untrusted.example/app.exe' }],
}), { status: 200 });

test('stable 1.3.1 is offered from each supported baseline using one injected request and the fixed release page', async () => {
  for (const currentVersion of ['1.2.0', '1.3.0', '1.3.1-rc.2']) {
    const calls = [];
    const result = await updates.checkForUpdate({
      currentVersion,
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method });
        return stableRelease();
      },
    });

    assert.deepEqual(result, { status: 'available', version: '1.3.1', tag: 'v1.3.1' }, currentVersion);
    assert.deepEqual(calls, [{ url: updates.RELEASES_API, method: 'GET' }], currentVersion);
    assert.equal(`${updates.RELEASE_PAGE_BASE}${result.tag}`, 'https://github.com/trace-boardviewer/trace-boardviewer/releases/tag/v1.3.1');
  }
});

test('a newer prerelease remains unavailable as an update, with or without the API prerelease flag', async () => {
  for (const prerelease of [true, false]) {
    const result = await updates.checkForUpdate({
      currentVersion: '1.3.0',
      fetchImpl: async () => new Response(JSON.stringify({ tag_name: 'v1.3.2-rc.1', draft: false, prerelease }), { status: 200 }),
    });
    assert.deepEqual(result, { status: 'current' }, `prerelease flag ${prerelease}`);
  }
});
