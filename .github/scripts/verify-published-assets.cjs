'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

// Fixed from the public v1.3.1 GitHub release metadata; never recomputed from a downloaded file.
const RELEASE = Object.freeze({
  tag: 'v1.3.1',
  version: '1.3.1',
  sourceSha: '83ba92241dc94dd9ce307217096f254cb86bd289',
  assets: Object.freeze({
    mac: Object.freeze([
      { name: 'TRACE-Boardviewer-1.3.1-mac-arm64.zip', bytes: 150690954, sha256: 'e6b0ea4d5a4581423d2573457bdc0c837e632dee2538ba58bdfe607b065d84c5' },
      { name: 'TRACE-Boardviewer-1.3.1-mac-arm64.zip.sha256', bytes: 104, sha256: '9f76b5a1225296b2fb129fda6f5b8eefce65cc6b92542c6d96f7cddf6518d226' },
    ]),
    linux: Object.freeze([
      { name: 'TRACE-Boardviewer-1.3.1-linux-amd64.deb', bytes: 116703148, sha256: 'f0a406fbe5467abdbcc88b46b6aff5d5a08da70bfdac1dbe97e5d4407a148bbf' },
      { name: 'TRACE-Boardviewer-1.3.1-linux-amd64.deb.sha256', bytes: 106, sha256: '5e32b34a66e2c4b81937b9f8b29f5250b790349f27c633b5ed81bc2bdd7d29dd' },
      { name: 'TRACE-Boardviewer-1.3.1-linux-x86_64.AppImage', bytes: 139975858, sha256: '42a337d11f3480359a12e9d4331b7cd7a1c669eaee6131a699c01f3765374389' },
      { name: 'TRACE-Boardviewer-1.3.1-linux-x86_64.AppImage.sha256', bytes: 112, sha256: 'cc2c53fd57838dd89e3ef91b019d65c181e79a41e7af5f799d00d9f6461d0bc9' },
    ]),
  }),
});

function parseArgs(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index++) {
    const match = /^--([a-z-]+)=(.*)$/.exec(argv[index]);
    if (!match || !match[2] || values.has(match[1])) throw new Error('Use unique --platform=mac|linux, --directory=<absolute path>, and --out=<absolute path>.');
    values.set(match[1], match[2]);
  }
  if (values.size !== 3 || !values.has('platform') || !values.has('directory') || !values.has('out')) {
    throw new Error('Use --platform=mac|linux, --directory=<absolute path>, and --out=<absolute path>.');
  }
  const directory = path.resolve(values.get('directory'));
  const out = path.resolve(values.get('out'));
  if (!path.isAbsolute(values.get('directory')) || !path.isAbsolute(values.get('out'))) throw new Error('Directory and output paths must be absolute.');
  return { platform: values.get('platform'), directory, out };
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

async function verify({ platform, directory, out }) {
  const assets = RELEASE.assets[platform];
  assert.ok(assets, 'platform must be mac or linux');
  const records = [];
  for (const expected of assets) {
    const filename = path.join(directory, expected.name);
    const stat = await fs.stat(filename);
    assert.ok(stat.isFile(), `${expected.name} is a regular file`);
    assert.equal(stat.size, expected.bytes, `${expected.name} has the published byte count`);
    const digest = sha256(await fs.readFile(filename));
    assert.equal(digest, expected.sha256, `${expected.name} matches the published release metadata digest`);
    records.push({ name: expected.name, bytes: stat.size, sha256: digest });
  }

  for (const asset of assets.filter((item) => item.name.endsWith('.sha256'))) {
    const corresponding = assets.find((item) => `${item.name}.sha256` === asset.name);
    assert.ok(corresponding, `${asset.name} has a corresponding package`);
    const content = (await fs.readFile(path.join(directory, asset.name), 'utf8')).trim();
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(content);
    assert.ok(match, `${asset.name} contains one SHA-256 line`);
    assert.equal(match[1], corresponding.sha256, `${asset.name} declares the official package digest`);
    assert.equal(match[2], corresponding.name, `${asset.name} names the exact package`);
  }

  await fs.mkdir(path.dirname(out), { recursive: true });
  const manifest = {
    schema: 'trace-published-release-assets/1',
    tag: RELEASE.tag,
    version: RELEASE.version,
    sourceSha: RELEASE.sourceSha,
    platform,
    assets: records,
  };
  await fs.writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

if (require.main === module) {
  verify(parseArgs(process.argv)).then((manifest) => {
    for (const asset of manifest.assets) console.log(`${asset.name} ${asset.bytes} bytes sha256=${asset.sha256}`);
  }).catch((error) => {
    console.error(`Published asset verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ RELEASE, parseArgs, verify });
