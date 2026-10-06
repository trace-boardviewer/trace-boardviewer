'use strict';

// Linux/Windows unit tests (no Windows, no Electron, no network) for scripts/payload-manifest.cjs: the per-file manifest of an
// unpacked app directory that the Windows portable isolation check compares with the RUNNING extracted runtime. They prove the
// pure functions (digests, validation, set comparison) and the directory walk/hash on temporary trees; they say nothing about
// the real win-unpacked tree or the real wrapper, which only the windows.yml jobs on a Windows runner exercise.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const pm = require('../scripts/payload-manifest.cjs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'payload-manifest.cjs');
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const err = (code) => Object.assign(new Error(code), { code });
/** Creating a symlink needs a privilege on Windows (Developer Mode / elevation); the symlink assertions simply do not apply without it. */
async function trySymlink(target, link) {
  try { await fsp.symlink(target, link); return true; } catch (error) { if (error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOSYS')) return false; throw error; }
}

async function withTree(files, body) {
  const base = await fsp.realpath(os.tmpdir());
  const root = await fsp.mkdtemp(path.join(base, 'payload-manifest-test-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, ...name.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content);
    }
    return await body(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const TREE = {
  'TRACE Boardviewer.exe': Buffer.from('MZ-main-executable'),
  'resources/app.asar': Buffer.from('asar archive bytes'),
  'locales/en-US.pak': Buffer.from('en'),
  'locales/hu.pak': Buffer.from('hu'),
  '.hidden': Buffer.from('h'),
  'a/b/c/deep.bin': Buffer.alloc(100000, 7),
};

// ---------------------------------------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------------------------------------

const file = (name, size = 1, hash = 'a') => ({ path: name, size, sha256: sha(`${name}${hash}`) });

test('finalizeManifest: exact field set, sorted relative paths, totals, digest, exeSha256/asarSha256 (null when absent)', () => {
  const files = [file('resources/app.asar', 10), file('TRACE Boardviewer.exe', 20), file('locales/hu.pak', 5)];
  const manifest = pm.finalizeManifest(files);
  assert.deepEqual(Object.keys(manifest), ['schema', 'fileCount', 'totalBytes', 'files', 'manifestDigest', 'exeSha256', 'asarSha256']);
  assert.equal(manifest.schema, 'trace-payload-manifest/1');
  assert.equal(manifest.fileCount, 3);
  assert.equal(manifest.totalBytes, 35);
  assert.deepEqual(manifest.files.map((entry) => entry.path), ['TRACE Boardviewer.exe', 'locales/hu.pak', 'resources/app.asar'], 'plain code-unit order, upper case before lower case');
  assert.deepEqual(Object.keys(manifest.files[0]), ['path', 'size', 'sha256']);
  assert.equal(manifest.exeSha256, files[1].sha256);
  assert.equal(manifest.asarSha256, files[0].sha256);
  assert.match(manifest.manifestDigest, /^[0-9a-f]{64}$/);
  const bare = pm.finalizeManifest([file('x.bin')]);
  assert.deepEqual([bare.exeSha256, bare.asarSha256], [null, null]);
  assert.throws(() => pm.finalizeManifest([file('x.bin'), file('x.bin', 2)]), pm.ManifestError);
  assert.deepEqual(pm.validateManifest(manifest), []);
});

test('exeSha256 is the ROOT "TRACE Boardviewer.exe" and asarSha256 is "resources/app.asar", never a same-named file elsewhere', () => {
  const manifest = pm.finalizeManifest([file('sub/TRACE Boardviewer.exe'), file('app.asar'), file('other/resources/app.asar')]);
  assert.equal(manifest.exeSha256, null);
  assert.equal(manifest.asarSha256, null);
});

test('manifestDigest is stable (independent of input order, same twice) and changes with ANY single path, size or hash difference', () => {
  const base = [file('a.bin', 1), file('b/c.bin', 2), file('TRACE Boardviewer.exe', 3), file('resources/app.asar', 4)];
  const digest = pm.finalizeManifest(base).manifestDigest;
  assert.equal(pm.finalizeManifest(base.slice().reverse()).manifestDigest, digest, 'order of the input does not matter');
  assert.equal(pm.finalizeManifest(structuredClone(base)).manifestDigest, digest, 'the same twice');
  const variants = {
    'one path renamed': base.map((entry, index) => (index === 1 ? { ...entry, path: 'b/d.bin' } : entry)),
    'one size changed': base.map((entry, index) => (index === 1 ? { ...entry, size: 3 } : entry)),
    'one hash changed': base.map((entry, index) => (index === 1 ? { ...entry, sha256: sha('other') } : entry)),
    'one file added': [...base, file('z.bin')],
    'one file removed': base.slice(1),
    'case of a path changed': base.map((entry, index) => (index === 0 ? { ...entry, path: 'A.bin' } : entry)),
  };
  const seen = new Set([digest]);
  for (const [name, files] of Object.entries(variants)) {
    const other = pm.finalizeManifest(files).manifestDigest;
    assert.notEqual(other, digest, name);
    seen.add(other);
  }
  assert.equal(seen.size, 1 + Object.keys(variants).length, 'every variant has its own digest');
});

test('digestFileList: a path containing a newline or separator cannot blur two fields; size-only and hashed digests are different domains', () => {
  const one = [{ path: 'a\n1', size: 2, sha256: sha('x') }];
  const two = [{ path: 'a', size: 12, sha256: sha('x') }];
  assert.notEqual(pm.digestFileList(one), pm.digestFileList(two));
  const files = [{ path: 'a.bin', size: 1, sha256: sha('a') }];
  assert.notEqual(pm.digestFileList(files, { withHash: true }), pm.digestFileList(files, { withHash: false }));
  const listing = [{ path: 'b', size: 2 }, { path: 'a', size: 1 }];
  assert.equal(pm.digestFileList(listing, { withHash: false }), pm.digestFileList(listing.slice().reverse(), { withHash: false }));
  assert.deepEqual(pm.summarizeListing(listing), { fileCount: 2, totalBytes: 3, digest: pm.digestFileList(listing, { withHash: false }) });
});

test('validateManifest names every kind of damage and never throws', () => {
  const good = pm.finalizeManifest([file('TRACE Boardviewer.exe', 3), file('resources/app.asar', 4), file('x/y.bin', 5)]);
  assert.deepEqual(pm.validateManifest(good), []);
  const damaged = (mutate) => { const copy = structuredClone(good); mutate(copy); return pm.validateManifest(copy).join(' | '); };
  assert.match(damaged((m) => { m.schema = 'other/1'; }), /schema/);
  assert.match(damaged((m) => { m.fileCount = 4; }), /fileCount/);
  assert.match(damaged((m) => { m.totalBytes = 1; }), /totalBytes/);
  assert.match(damaged((m) => { m.manifestDigest = 'f'.repeat(64); }), /manifestDigest/);
  assert.match(damaged((m) => { m.exeSha256 = 'f'.repeat(64); }), /exeSha256/);
  assert.match(damaged((m) => { m.asarSha256 = null; }), /asarSha256/);
  assert.match(damaged((m) => { m.files.reverse(); }), /sorted/);
  assert.match(damaged((m) => { m.files[1] = { ...m.files[0] }; }), /sorted|unique/);
  assert.match(damaged((m) => { m.files[0].path = '../evil.bin'; }), /relative POSIX path/);
  assert.match(damaged((m) => { m.files[0].path = '/abs.bin'; }), /relative POSIX path/);
  assert.match(damaged((m) => { m.files[0].path = 'C:\\x.bin'; }), /relative POSIX path/);
  assert.match(damaged((m) => { m.files[0].path = 'a\\b.bin'; }), /relative POSIX path/);
  assert.match(damaged((m) => { m.files[0].size = -1; }), /size/);
  assert.match(damaged((m) => { m.files[0].size = 1.5; }), /size/);
  assert.match(damaged((m) => { m.files[0].sha256 = 'ABC'; }), /sha256/);
  assert.match(damaged((m) => { m.files = 'nope'; }), /files is not an array/);
  assert.deepEqual(pm.validateManifest(null).length, 1);
  assert.deepEqual(pm.validateManifest([]).length, 1);
  assert.ok(pm.validateManifest({}).length >= 1);
  assert.equal(pm.isRelativePosixPath('a/b.c'), true);
  for (const bad of ['', 'a//b', './a', 'a/../b', 'a/', null, 5]) assert.equal(pm.isRelativePosixPath(bad), false, String(bad));
});

test('diffFileLists: exact set comparison with complete counts and lists cut at 10, sorted; ignore and size-only modes', () => {
  const expected = Array.from({ length: 30 }, (_, index) => file(`f${String(index).padStart(2, '0')}.bin`, index + 1));
  const same = pm.diffFileLists(expected, structuredClone(expected));
  assert.deepEqual([same.equal, same.counts], [true, { missing: 0, extra: 0, sizeMismatch: 0, hashMismatch: 0 }]);
  const actual = [
    ...expected.slice(12).map((entry, index) => (index === 0 ? { ...entry, size: entry.size + 1 } : index === 1 ? { ...entry, sha256: sha('other') } : entry)),
    ...Array.from({ length: 13 }, (_, index) => file(`extra${String(index).padStart(2, '0')}.bin`)),
  ];
  const diff = pm.diffFileLists(expected, actual);
  assert.equal(diff.equal, false);
  assert.deepEqual(diff.counts, { missing: 12, extra: 13, sizeMismatch: 1, hashMismatch: 1 });
  assert.equal(diff.missing.length, 10);
  assert.equal(diff.extra.length, 10);
  assert.deepEqual(diff.missing.slice(0, 3), ['f00.bin', 'f01.bin', 'f02.bin'], 'sorted');
  assert.deepEqual(diff.sizeMismatch, [{ path: 'f12.bin', expected: 13, actual: 14 }]);
  assert.deepEqual(diff.hashMismatch.map((entry) => entry.path), ['f13.bin']);
  assert.deepEqual(pm.diffFileLists(expected, actual, { limit: 3 }).extra.length, 3);
  const skipped = pm.diffFileLists(expected, actual, { ignore: new Set(['f00.bin', 'extra00.bin']) });
  assert.deepEqual([skipped.counts.missing, skipped.counts.extra], [11, 12], 'ignored paths are removed from both sides');
  const sizeOnly = pm.diffFileLists([{ path: 'a', size: 1 }], [{ path: 'a', size: 1 }, { path: 'b', size: 2 }], { compareHash: false });
  assert.deepEqual([sizeOnly.counts.extra, sizeOnly.counts.hashMismatch, sizeOnly.equal], [1, 0, false]);
  assert.equal(pm.diffFileLists([{ path: 'a', size: 1, sha256: 'x' }], [{ path: 'a', size: 1, sha256: 'y' }], { compareHash: false }).equal, true);
  const hashOnly = pm.diffFileLists([{ path: 'a', size: 1, sha256: 'x' }], [{ path: 'a', size: 1, sha256: 'y' }]);
  assert.deepEqual([hashOnly.equal, hashOnly.counts.hashMismatch], [false, 1], 'a content-only difference is a difference');
});

// ---------------------------------------------------------------------------------------------------------
// Directory walk and hash on a real temporary tree
// ---------------------------------------------------------------------------------------------------------

test('buildManifest on a temp tree: relative POSIX paths, sizes, streaming SHA-256 of every file, hidden and nested files, exe/asar hashes', async () => {
  await withTree(TREE, async (root) => {
    await fsp.mkdir(path.join(root, 'empty-dir'));
    const manifest = await pm.buildManifest(root);
    assert.equal(manifest.fileCount, Object.keys(TREE).length, 'directories are not files');
    assert.deepEqual(manifest.files.map((entry) => entry.path), Object.keys(TREE).sort(), 'sorted, forward slashes, no root prefix');
    for (const entry of manifest.files) {
      assert.equal(entry.size, TREE[entry.path].length, entry.path);
      assert.equal(entry.sha256, sha(TREE[entry.path]), entry.path);
      assert.equal(entry.path.includes('\\'), false);
    }
    assert.equal(manifest.totalBytes, Object.values(TREE).reduce((total, buffer) => total + buffer.length, 0));
    assert.equal(manifest.exeSha256, sha(TREE['TRACE Boardviewer.exe']));
    assert.equal(manifest.asarSha256, sha(TREE['resources/app.asar']));
    assert.deepEqual(pm.validateManifest(manifest), []);
    const again = await pm.buildManifest(root);
    assert.equal(again.manifestDigest, manifest.manifestDigest, 'digest stability: the same tree gives the same manifest');
    assert.equal(JSON.stringify(again), JSON.stringify(manifest), 'byte-identical serialisation');
  });
});

test('the manifest is independent of the creation order and of where the tree lives', async () => {
  const names = Object.keys(TREE);
  const reversed = Object.fromEntries(names.slice().reverse().map((name) => [name, TREE[name]]));
  const a = await withTree(TREE, (root) => pm.buildManifest(root));
  const b = await withTree(reversed, (root) => pm.buildManifest(root));
  assert.equal(a.manifestDigest, b.manifestDigest);
  assert.deepEqual(a.files, b.files);
});

test('one changed byte, one renamed file or one extra file changes the digest of a real tree', async () => {
  const base = await withTree(TREE, (root) => pm.buildManifest(root));
  const flipped = await withTree({ ...TREE, 'locales/hu.pak': Buffer.from('hx') }, (root) => pm.buildManifest(root));
  assert.notEqual(flipped.manifestDigest, base.manifestDigest);
  assert.deepEqual(pm.diffFileLists(base.files, flipped.files).hashMismatch.map((entry) => entry.path), ['locales/hu.pak']);
  const renamed = await withTree(Object.fromEntries(Object.entries(TREE).map(([name, data]) => [name === 'locales/hu.pak' ? 'locales/hu2.pak' : name, data])), (root) => pm.buildManifest(root));
  assert.notEqual(renamed.manifestDigest, base.manifestDigest);
  const extra = await withTree({ ...TREE, 'new.bin': Buffer.from('n') }, (root) => pm.buildManifest(root));
  assert.notEqual(extra.manifestDigest, base.manifestDigest);
});

test('a missing exe / app.asar gives null hashes; an empty or missing directory is a ManifestError', async () => {
  const bare = await withTree({ 'x.bin': Buffer.from('x') }, (root) => pm.buildManifest(root));
  assert.deepEqual([bare.exeSha256, bare.asarSha256], [null, null]);
  await withTree({}, async (root) => { await assert.rejects(pm.buildManifest(root), /contains no files/); });
  await assert.rejects(pm.buildManifest(path.join(os.tmpdir(), 'payload-manifest-surely-missing')), /directory not found/);
  await withTree({ 'f.bin': Buffer.from('x') }, async (root) => { await assert.rejects(pm.buildManifest(path.join(root, 'f.bin')), /directory not found/, 'a file is not a directory'); });
});

test('hashing is a STREAM: a multi-megabyte file is read in chunks (never in one buffer) and still hashes correctly', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024 + 123);
  for (let index = 0; index < big.length; index += 4096) big[index] = (index / 4096) & 0xff;
  await withTree({ 'big.bin': big }, async (root) => {
    const chunks = [];
    const api = {
      stat: (target) => fsp.stat(target), lstat: (target) => fsp.lstat(target), readdir: (target, options) => fsp.readdir(target, options),
      createReadStream: (target) => {
        const stream = require('node:fs').createReadStream(target, { highWaterMark: 64 * 1024 });
        stream.on('data', (chunk) => chunks.push(chunk.length));
        return stream;
      },
    };
    const result = await pm.hashDirectory(root, { api });
    assert.equal(result.files[0].sha256, sha(big));
    assert.equal(result.files[0].size, big.length);
    assert.ok(chunks.length > 50 && Math.max(...chunks) <= 64 * 1024, `${chunks.length} chunks, max ${Math.max(...chunks)}`);
    assert.equal(chunks.reduce((total, size) => total + size, 0), big.length);
  });
});

test('hashDirectory reports an unreadable file explicitly (code), keeps hashing the others, and buildManifest refuses to write an incomplete manifest', async () => {
  await withTree(TREE, async (root) => {
    const api = {
      stat: fsp.stat, lstat: fsp.lstat, readdir: fsp.readdir,
      createReadStream: (target) => {
        if (target.endsWith('app.asar')) { return (async function* () { throw err('EBUSY'); })(); }
        return require('node:fs').createReadStream(target);
      },
    };
    const result = await pm.hashDirectory(root, { api });
    assert.deepEqual(result.unreadable, [{ path: 'resources/app.asar', code: 'EBUSY', kind: 'file' }]);
    assert.equal(result.files.length, Object.keys(TREE).length - 1);
    assert.equal(result.files.some((entry) => entry.path === 'resources/app.asar'), false);
    await assert.rejects(pm.buildManifest(root, { api }), /1 entries could not be hashed.*resources\/app\.asar \(EBUSY\)/);
    const rootBusy = await pm.hashDirectory(root, { api: { ...api, stat: async () => { throw err('EBUSY'); } } });
    assert.deepEqual(rootBusy, { exists: true, files: [], unreadable: [{ path: '', code: 'EBUSY', kind: 'directory' }] }, 'a busy root is reported, not read as an empty directory');
    await assert.rejects(pm.buildManifest(root, { api: { ...api, stat: async () => { throw err('EBUSY'); } } }), /\. \(EBUSY\)/);
    const retry = await pm.hashDirectory(root, { api, skip: new Set(result.files.map((entry) => entry.path)) });
    assert.deepEqual(retry.files, [], 'skip leaves the already hashed files out');
    assert.deepEqual(retry.unreadable.map((entry) => entry.path), ['resources/app.asar']);
  });
});

test('hashDirectory: a file that changes size while it is read is "CHANGED"; a vanished file is simply absent; a symlink is NOT_REGULAR; a busy directory is reported', async () => {
  await withTree({ 'a.bin': Buffer.alloc(1000, 1), 'gone.bin': Buffer.from('g'), 'ok.bin': Buffer.from('o'), 'busy/inner.bin': Buffer.from('i') }, async (root) => {
    const linked = await trySymlink(path.join(root, 'ok.bin'), path.join(root, 'link.bin'));
    const api = {
      stat: fsp.stat, lstat: fsp.lstat,
      readdir: (target, options) => { if (target.endsWith(`${path.sep}busy`)) throw err('EPERM'); return fsp.readdir(target, options); },
      createReadStream: (target) => {
        if (target.endsWith('a.bin')) return (async function* () { yield Buffer.alloc(500, 1); })(); // shrank while it was read
        if (target.endsWith('gone.bin')) return (async function* () { throw err('ENOENT'); })();
        return require('node:fs').createReadStream(target);
      },
    };
    const result = await pm.hashDirectory(root, { api });
    const byPath = Object.fromEntries(result.unreadable.map((entry) => [entry.path, entry.code]));
    assert.deepEqual(byPath, { 'a.bin': 'CHANGED', busy: 'EPERM', ...(linked ? { 'link.bin': 'NOT_REGULAR' } : {}) });
    assert.deepEqual(result.files.map((entry) => entry.path), ['ok.bin']);
  });
});

test('listDirectory (size-only): sorted {path,size}, hidden files, symlinks ignored, busy/vanished entries skipped, other errors thrown, missing dir', async () => {
  await withTree({ 'b.bin': Buffer.alloc(3), 'a/z.bin': Buffer.alloc(5), '.dot': Buffer.alloc(1) }, async (root) => {
    await trySymlink(path.join(root, 'b.bin'), path.join(root, 'link'));
    assert.deepEqual(await pm.listDirectory(root), { exists: true, files: [{ path: '.dot', size: 1 }, { path: 'a/z.bin', size: 5 }, { path: 'b.bin', size: 3 }] });
    assert.deepEqual(await pm.listDirectory(path.join(root, 'nope')), { exists: false, files: [] });
    assert.deepEqual(await pm.listDirectory(path.join(root, 'b.bin')), { exists: false, files: [] });
    const lstat = (code) => (target) => { if (target.endsWith('b.bin')) throw err(code); return fsp.lstat(target); };
    const base = { stat: fsp.stat, readdir: fsp.readdir };
    for (const code of ['EBUSY', 'EACCES', 'EPERM', 'ENOENT']) assert.equal((await pm.listDirectory(root, { ...base, lstat: lstat(code) })).files.length, 2, code);
    await assert.rejects(pm.listDirectory(root, { ...base, lstat: lstat('EIO') }), /EIO/);
    assert.deepEqual(await pm.listDirectory(root, { stat: async () => { throw err('EPERM'); } }), { exists: true, files: [] });
  });
});

// ---------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------

function cli(extra = {}) {
  const out = { lines: [], errors: [], written: [] };
  return {
    out,
    deps: { log: (line) => out.lines.push(line), error: (line) => out.errors.push(line), writeFile: async (target, text) => { out.written.push({ target, text }); }, ...extra },
  };
}

test('parseArgs: both flag spellings, required flags, unknown flags, --out must not be inside --dir', () => {
  assert.deepEqual(pm.parseArgs(['--dir', 'a', '--out', 'b.json']), { dir: 'a', out: 'b.json', help: false });
  assert.deepEqual(pm.parseArgs(['--dir=a', '--out=b.json']), { dir: 'a', out: 'b.json', help: false });
  assert.equal(pm.parseArgs(['--help']).help, true);
  for (const bad of [[], ['--dir', 'a'], ['--out', 'b'], ['--dir'], ['--dir', 'a', '--out', 'b', '--nope'], ['--dir', 'a', '--out', 'a/m.json'], ['--dir', 'a', '--out', 'a']]) {
    assert.throws(() => pm.parseArgs(bad), pm.UsageError, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => pm.parseArgs(['--dir', 'release/win-unpacked', '--out', 'payload-manifest.json']));
  assert.doesNotThrow(() => pm.parseArgs(['--dir', 'release/win-unpacked', '--out', 'release/win-unpacked-manifest.json']), 'a sibling with a similar prefix is outside');
});

test('main: writes the manifest (spec fields, trailing newline) and exits 0; a second run writes the identical bytes', async () => {
  await withTree(TREE, async (root) => {
    const first = cli();
    assert.equal(await pm.main(['--dir', root, '--out', 'm.json'], first.deps), 0);
    const second = cli();
    assert.equal(await pm.main(['--dir', root, '--out', 'm.json'], second.deps), 0);
    assert.equal(first.out.written[0].text, second.out.written[0].text);
    assert.ok(first.out.written[0].text.endsWith('}\n'));
    const manifest = JSON.parse(first.out.written[0].text);
    assert.deepEqual(Object.keys(manifest), ['schema', 'fileCount', 'totalBytes', 'files', 'manifestDigest', 'exeSha256', 'asarSha256']);
    assert.deepEqual(pm.validateManifest(manifest), []);
    assert.match(first.out.lines.join('\n'), /payload manifest: 6 files/);
    assert.match(first.out.lines.join('\n'), new RegExp(`TRACE Boardviewer\\.exe sha256 ${sha(TREE['TRACE Boardviewer.exe'])}`));
    assert.equal(JSON.stringify(manifest).includes(root), false, 'no absolute paths in the manifest');
  });
});

test('main: a missing directory, an empty directory or an unreadable file exits 1 and writes NOTHING; usage errors exit 2; --help exits 0', async () => {
  const missing = cli();
  assert.equal(await pm.main(['--dir', path.join(os.tmpdir(), 'payload-manifest-surely-missing'), '--out', 'm.json'], missing.deps), 1);
  assert.match(missing.out.errors.join('\n'), /directory not found/);
  assert.deepEqual(missing.out.written, []);
  await withTree({}, async (root) => {
    const empty = cli();
    assert.equal(await pm.main(['--dir', root, '--out', 'm.json'], empty.deps), 1);
    assert.deepEqual(empty.out.written, []);
  });
  await withTree(TREE, async (root) => {
    const unreadable = cli({ api: { stat: fsp.stat, lstat: fsp.lstat, readdir: fsp.readdir, createReadStream: (target) => (target.endsWith('hu.pak') ? (async function* () { throw err('EACCES'); })() : require('node:fs').createReadStream(target)) } });
    assert.equal(await pm.main(['--dir', root, '--out', 'm.json'], unreadable.deps), 1);
    assert.match(unreadable.out.errors.join('\n'), /locales\/hu\.pak \(EACCES\)/);
    assert.deepEqual(unreadable.out.written, []);
    const unwritable = cli({ writeFile: async () => { throw new Error('disk full'); } });
    assert.equal(await pm.main(['--dir', root, '--out', 'm.json'], unwritable.deps), 1);
    assert.match(unwritable.out.errors.join('\n'), /disk full/);
    const usage = cli();
    assert.equal(await pm.main(['--dir', root], usage.deps), 2);
    assert.match(usage.out.errors.join('\n'), /--out <manifest\.json> is required/);
    const help = cli();
    assert.equal(await pm.main(['--help'], help.deps), 0);
    assert.match(help.out.lines.join('\n'), /Usage: node scripts\/payload-manifest\.cjs --dir/);
  });
});

test('the script runs as a real CLI process: writes the file (creating its folder), exit codes 0 / 1 / 2', async () => {
  await withTree(TREE, async (root) => {
    const outFile = path.join(root, '..', `payload-manifest-cli-${process.pid}`, 'nested', 'manifest.json');
    try {
      const output = execFileSync(process.execPath, [SCRIPT, '--dir', root, '--out', outFile], { encoding: 'utf8' });
      assert.match(output, /payload manifest: 6 files/);
      const manifest = JSON.parse(await fsp.readFile(outFile, 'utf8'));
      assert.deepEqual(pm.validateManifest(manifest), []);
      assert.equal(manifest.exeSha256, sha(TREE['TRACE Boardviewer.exe']));
      assert.equal(manifest.asarSha256, sha(TREE['resources/app.asar']));
      const failure = (args) => { try { execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' }); return 0; } catch (error) { return error.status; } };
      assert.equal(failure(['--dir', path.join(root, 'nope'), '--out', outFile]), 1);
      assert.equal(failure(['--dir', root]), 2);
    } finally {
      await fsp.rm(path.dirname(path.dirname(outFile)), { recursive: true, force: true });
    }
  });
});
