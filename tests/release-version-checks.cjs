'use strict';

// A version with a prerelease suffix (1.3.1-rc.1) is a test release. This file follows such a version through the release pipeline and
// proves that a suffixed version is treated as a prerelease at every step, while a stable version behaves as before:
//   - the version pattern of the three build jobs, and the step "Validate release metadata" of each job run for real (bash for the macOS and
//     Linux jobs, PowerShell for the Windows job): version accepted or refused, tag must match package.json, artifact name;
//   - the file names the builds produce (package.json and the two builder configs) are the names the draft release looks for;
//   - the .deb version uses "~", so a test release sorts before its final release (the builder's own function, plus Debian's ordering rules);
//   - the step "Create draft GitHub release" runs for real against a stand-in for `gh`: prerelease flag, title, assets, notes;
//   - the update check of the app never offers a suffixed tag and offers the final release to a test version.
// Everything runs on temporary folders; nothing is built, published or downloaded. The steps that need bash or PowerShell are skipped
// (with the reason) where that shell is not installed.
//
//   node --test tests/release-version-checks.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const rel = (...parts) => path.join(ROOT, ...parts);
const WORKFLOW_PATH = process.env.TRACE_RELEASE_VERSION_CHECKS_WORKFLOW || rel('.github', 'workflows', 'windows.yml');
const packageJson = JSON.parse(fs.readFileSync(rel('package.json'), 'utf8'));

// The pinned electron-builder resolves its own YAML parser and library; nothing is added to the project.
const builderManifest = require.resolve('electron-builder/package.json', { paths: [ROOT] });
const libDirectory = path.dirname(require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builderManifest)] }));
const yaml = require(require.resolve('js-yaml', { paths: [libDirectory] }));
const workflow = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n'));
const macConfig = yaml.load(fs.readFileSync(rel('config', 'electron-builder.mac.yml'), 'utf8'));
const linuxConfig = yaml.load(fs.readFileSync(rel('config', 'electron-builder.linux.yml'), 'utf8'));

const STABLE = '1.3.1';
const TEST = '1.3.1-rc.1';
const stepOf = (job, name) => {
  const step = workflow.jobs[job].steps.find((entry) => entry.name === name);
  assert.ok(step, `step "${name}" exists in job ${job}`);
  return step;
};
const temporaryFolder = (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-release-version-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
};
const withNodeOnPath = (extraDirectories = []) => {
  const env = { ...process.env };
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') || 'PATH';
  env[key] = [...extraDirectories, path.dirname(process.execPath), env[key] || ''].join(path.delimiter);
  return env;
};
const forward = (file) => file.replace(/\\/g, '/');
/** The lines `name=value` a step appended to $GITHUB_OUTPUT (PowerShell 5.1 writes UTF-16 or UTF-8 with a mark there, PowerShell 7 and bash plain UTF-8). */
const readOutputs = (file) => {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file);
  const text = (raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8')).replace(/^﻿/, '');
  return Object.fromEntries(text.split(/\r?\n/).filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
};

// ---- the shells -----------------------------------------------------------------------------------------------------------

const bashProbe = (() => {
  const probeFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-bash-probe-'));
  try {
    // A Windows path must be visible to bash as it is written here (Git for Windows); the WSL launcher would not see it.
    const result = spawnSync('bash', ['-c', 'test -d "$1" && echo visible', 'probe', forward(probeFolder)], { encoding: 'utf8' });
    return result.status === 0 && result.stdout.trim() === 'visible' ? null : 'bash is not installed or does not see temporary folders by their Windows path';
  } catch { return 'bash is not installed'; } finally { fs.rmSync(probeFolder, { recursive: true, force: true }); }
})();
const powershell = (() => {
  for (const name of ['pwsh', 'powershell.exe']) {
    const result = spawnSync(name, ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output ($PSVersionTable.PSVersion.Major)'], { encoding: 'utf8' });
    if (result.status === 0 && /^\d+/.test(result.stdout.trim())) return name;
  }
  return null;
})();
const bashSkip = bashProbe || false;
const powershellSkip = powershell ? false : 'PowerShell is not installed';

function runBash(folder, script, env) {
  const file = path.join(folder, 'step.sh');
  fs.writeFileSync(file, script);
  // The shell GitHub starts for `shell: bash`.
  return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', forward(file)], { cwd: folder, env, encoding: 'utf8' });
}
function runPowerShell(folder, script, env) {
  const file = path.join(folder, 'step.ps1');
  // GitHub's `shell: pwsh` starts the step with the error action "stop".
  fs.writeFileSync(file, `$ErrorActionPreference = 'Stop'\n${script}\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n`);
  const args = ['-NoProfile', '-NonInteractive', ...(powershell === 'powershell.exe' ? ['-ExecutionPolicy', 'Bypass'] : []), '-File', file];
  return spawnSync(powershell, args, { cwd: folder, env, encoding: 'utf8' });
}

// ---- 1. the version pattern -----------------------------------------------------------------------------------------------

const METADATA_STEP = 'Validate release metadata';
const patternOf = (job) => {
  const run = stepOf(job, METADATA_STEP).run;
  const found = /-notmatch '([^']+)'/.exec(run) || /versionPattern='([^']+)'/.exec(run);
  assert.ok(found, `job ${job} validates the version with one pattern`);
  return new RegExp(found[1]);
};

test('every build job accepts the same versions: a release version with or without one prerelease suffix', () => {
  const patterns = ['build', 'mac', 'linux'].map(patternOf);
  const accepted = ['1.3.0', '1.3.1', '1.3.1-rc.1', '1.3.1-rc.10', '2.0.0-beta.2', '10.20.30-rc.1.2'];
  const refused = ['1.3', '1.3.1.0', 'v1.3.1', '1.3.1-', '1.3.1+build', '1.3.1-rc 1', '1.3.1-rc!', '-1.3.1', '1.3.1-rc.1+x', ''];
  for (const version of accepted) patterns.forEach((pattern, index) => assert.ok(pattern.test(version), `${version} is accepted by job ${['build', 'mac', 'linux'][index]}`));
  for (const version of refused) patterns.forEach((pattern, index) => assert.ok(!pattern.test(version), `${JSON.stringify(version)} is refused by job ${['build', 'mac', 'linux'][index]}`));
  assert.ok(patterns.every((pattern) => pattern.test(packageJson.version)), `package.json says ${packageJson.version}: a version the release jobs accept`);
});

// ---- 2. the step "Validate release metadata", run for real --------------------------------------------------------------------

const CASES = [
  // [package.json version, ref, tag name, expected: the version to publish, or null when the step must fail, the message]
  { version: STABLE, ref: `refs/tags/v${STABLE}`, tag: `v${STABLE}`, ok: true },
  { version: TEST, ref: `refs/tags/v${TEST}`, tag: `v${TEST}`, ok: true },
  { version: TEST, ref: `refs/tags/v${STABLE}`, tag: `v${STABLE}`, ok: false, message: /Release tag must match the version in package\.json/ },
  { version: STABLE, ref: `refs/tags/v${TEST}`, tag: `v${TEST}`, ok: false, message: /Release tag must match the version in package\.json/ },
  { version: TEST, ref: `refs/tags/${TEST}`, tag: TEST, ok: false, message: /Release tag must match the version in package\.json/ },
  { version: TEST, ref: 'refs/heads/main', tag: 'main', ok: true },
  { version: '1.3.1-', ref: 'refs/heads/main', tag: 'main', ok: false, message: /valid release version/ },
  { version: '1.3', ref: 'refs/tags/v1.3', tag: 'v1.3', ok: false, message: /valid release version/ },
];
const JOB_FACTS = {
  mac: { env: { TRACE_ARCH: 'arm64' }, artifact: (version) => `TRACE-Boardviewer-${version}-mac-arm64` },
  linux: { env: { TRACE_ARCH: 'x64' }, artifact: (version) => `TRACE-Boardviewer-${version}-linux-x64` },
};

for (const job of ['mac', 'linux']) {
  test(`${job} job, step "${METADATA_STEP}" (bash): a suffixed version is a valid release version, and the tag must match it exactly`, { skip: bashSkip }, (t) => {
    const step = stepOf(job, METADATA_STEP);
    for (const entry of CASES) {
      const folder = temporaryFolder(t);
      fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'x', version: entry.version }));
      const output = path.join(folder, 'github-output');
      fs.writeFileSync(output, '');
      const env = { ...withNodeOnPath(), ...JOB_FACTS[job].env, TRACE_REF: entry.ref, TRACE_TAG: entry.tag, GITHUB_OUTPUT: forward(output) };
      const result = runBash(folder, step.run, env);
      const label = `${entry.version} on ${entry.ref}`;
      if (entry.ok) {
        assert.equal(result.status, 0, `${label}: ${result.stderr}`);
        assert.deepEqual(readOutputs(output), { version: entry.version, artifact_name: JOB_FACTS[job].artifact(entry.version) }, label);
      } else {
        assert.notEqual(result.status, 0, `${label} must fail`);
        assert.match(result.stderr, entry.message, label);
        assert.deepEqual(readOutputs(output), {}, `${label}: nothing is handed to the later steps`);
      }
    }
  });
}

test('build job, step "Validate release metadata" (PowerShell): the same rules for the Windows build', { skip: powershellSkip }, (t) => {
  const step = stepOf('build', METADATA_STEP);
  for (const entry of CASES) {
    const folder = temporaryFolder(t);
    fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'x', version: entry.version }));
    const output = path.join(folder, 'github-output');
    fs.writeFileSync(output, '');
    const result = runPowerShell(folder, step.run, { ...withNodeOnPath(), TRACE_REF: entry.ref, TRACE_TAG: entry.tag, GITHUB_OUTPUT: output });
    const label = `${entry.version} on ${entry.ref}`;
    if (entry.ok) {
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.deepEqual(readOutputs(output), { version: entry.version, artifact_name: `TRACE-Boardviewer-${entry.version}-windows-x64` }, label);
    } else {
      assert.notEqual(result.status, 0, `${label} must fail`);
      assert.match(`${result.stdout}${result.stderr}`, entry.message, label);
      assert.deepEqual(readOutputs(output), {}, `${label}: nothing is handed to the later steps`);
    }
  }
});

// ---- 3. file names ---------------------------------------------------------------------------------------------------------

const expand = (template, values) => template.replace(/\$\{(\w+)\}/g, (whole, key) => {
  assert.ok(key in values, `the builder knows \${${key}}`);
  return values[key];
});

test('the files the builds write for a suffixed version are the files the draft release looks for', () => {
  // The builder fills ${arch} by itself: the AppImage says x86_64 and the .deb amd64 on x64 (config/electron-builder.linux.yml), the zip arm64.
  const produced = {
    exe: expand(packageJson.build.portable.artifactName, { version: TEST }),
    zip: expand(macConfig.mac.artifactName, { version: TEST, arch: 'arm64', ext: 'zip' }),
    appimage: expand(linuxConfig.linux.artifactName, { version: TEST, arch: 'x86_64', ext: 'AppImage' }),
    deb: expand(linuxConfig.linux.artifactName, { version: TEST, arch: 'amd64', ext: 'deb' }),
  };
  assert.deepEqual(produced, {
    exe: `TRACE-Boardviewer-${TEST}.exe`,
    zip: `TRACE-Boardviewer-${TEST}-mac-arm64.zip`,
    appimage: `TRACE-Boardviewer-${TEST}-linux-x86_64.AppImage`,
    deb: `TRACE-Boardviewer-${TEST}-linux-amd64.deb`,
  });
  const draft = stepOf('draft-release', 'Create draft GitHub release').run;
  const looksFor = (variable) => {
    const found = new RegExp(`\\$${variable} = Join-Path release "([^"]+)"`).exec(draft);
    assert.ok(found, `the draft step looks for $${variable}`);
    return found[1].replace('$env:TRACE_VERSION', TEST);
  };
  assert.deepEqual({ exe: looksFor('traceExe'), zip: looksFor('traceZip'), appimage: looksFor('traceAppImage'), deb: looksFor('traceDeb') }, produced);
  // The workflow uploads and finds the artifacts under names built from the same version.
  assert.equal(workflow.jobs.build.outputs.artifact_name, '${{ steps.metadata.outputs.artifact_name }}');
  const upload = workflow.jobs.build.steps.find((step) => step.name === 'Upload portable EXE and checksum');
  assert.ok(upload.with.path.includes('release/TRACE-Boardviewer-${{ steps.metadata.outputs.version }}.exe'));
  assert.equal(packageJson.build.portable.artifactName, 'TRACE-Boardviewer-${version}.exe', 'the builder writes the version of package.json into the EXE name, suffix included');
});

// ---- 4. the .deb version -----------------------------------------------------------------------------------------------

/** Debian's version comparison (dpkg: epoch ignored, upstream and revision split at the last hyphen, "~" sorts before everything). */
function compareDebianVersions(a, b) {
  const order = (c) => (c === undefined || /\d/.test(c) ? 0 : /[A-Za-z]/.test(c) ? c.charCodeAt(0) : c === '~' ? -1 : c.charCodeAt(0) + 256);
  const digit = (c) => c !== undefined && /\d/.test(c);
  const verrevcmp = (x, y) => {
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      let firstDifference = 0;
      while ((i < x.length && !digit(x[i])) || (j < y.length && !digit(y[j]))) {
        const left = order(x[i]);
        const right = order(y[j]);
        if (left !== right) return left - right;
        i += 1;
        j += 1;
      }
      while (x[i] === '0') i += 1;
      while (y[j] === '0') j += 1;
      while (digit(x[i]) && digit(y[j])) {
        if (!firstDifference) firstDifference = x.charCodeAt(i) - y.charCodeAt(j);
        i += 1;
        j += 1;
      }
      if (digit(x[i])) return 1;
      if (digit(y[j])) return -1;
      if (firstDifference) return firstDifference;
    }
    return 0;
  };
  const split = (version) => { const at = version.lastIndexOf('-'); return at < 0 ? [version, ''] : [version.slice(0, at), version.slice(at + 1)]; };
  const [upstreamA, revisionA] = split(a);
  const [upstreamB, revisionB] = split(b);
  return verrevcmp(upstreamA, upstreamB) || verrevcmp(revisionA, revisionB);
}

test('the .deb of a test release carries "~" in its version, so it sorts before the final release', () => {
  const { LinuxTargetHelper } = require(path.join(libDirectory, 'out', 'targets', 'LinuxTargetHelper.js'));
  const debVersion = (version) => new LinuxTargetHelper({ appInfo: { version } }).getSanitizedVersion('deb');
  assert.equal(debVersion(STABLE), STABLE, 'a stable version is written as it is');
  assert.equal(debVersion(TEST), '1.3.1~rc.1', 'the builder writes the suffix after a tilde');
  assert.equal(debVersion('1.3.1-rc.12'), '1.3.1~rc.12');
  const scripts = require('../scripts/linux-smoke.cjs');
  assert.deepEqual(scripts.checkDebFields({ Package: 'trace-boardviewer', Version: debVersion(TEST), Architecture: 'amd64', Maintainer: 'TRACE Boardviewer <noreply@trace-boardviewer.invalid>', Homepage: 'https://github.com/trace-boardviewer/trace-boardviewer' }, { arch: 'x64', version: TEST, homepage: 'https://github.com/trace-boardviewer/trace-boardviewer' }), [], 'the smoke test expects exactly what the builder writes');
  // apt installs the newest version it knows: the final release must replace a test release, and a test release must not replace a final one.
  const less = (a, b) => assert.ok(compareDebianVersions(a, b) < 0, `${a} sorts before ${b}`);
  less('1.3.1~rc.1', '1.3.1');
  less('1.3.1~rc.1', '1.3.1~rc.2');
  less('1.3.1~rc.2', '1.3.1~rc.10');
  less('1.3.0', '1.3.1~rc.1');
  less('1.3.1', '1.3.2~rc.1');
  // Why the tilde: with the hyphen of the file name, dpkg reads "rc.1" as a package revision, which sorts AFTER the final release.
  assert.ok(compareDebianVersions('1.3.1-rc.1', '1.3.1') > 0, 'a hyphen would make the test release newer than the final release');
});

// ---- 5. the draft release ------------------------------------------------------------------------------------------------------

const GH_STUB = `'use strict';
const fs = require('node:fs');
fs.writeFileSync('gh-arguments.json', JSON.stringify(process.argv.slice(2)));
`;

/** A folder with the four downloaded builds and their checksum files, a stand-in for `gh` and the environment of the draft step. */
function draftFolder(t, version) {
  const folder = temporaryFolder(t);
  const assets = {
    exe: `TRACE-Boardviewer-${version}.exe`,
    zip: `TRACE-Boardviewer-${version}-mac-arm64.zip`,
    appimage: `TRACE-Boardviewer-${version}-linux-x86_64.AppImage`,
    deb: `TRACE-Boardviewer-${version}-linux-amd64.deb`,
  };
  fs.mkdirSync(path.join(folder, 'release'));
  for (const name of Object.values(assets)) {
    const content = Buffer.from(`stand-in for ${name}`);
    fs.writeFileSync(path.join(folder, 'release', name), content);
    fs.writeFileSync(path.join(folder, 'release', `${name}.sha256`), `${crypto.createHash('sha256').update(content).digest('hex')}  ${name}\n`);
  }
  const bin = path.join(folder, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(folder, 'gh-stub.cjs'), GH_STUB);
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'gh.cmd'), `@echo off\r\n"${process.execPath}" "${path.join(folder, 'gh-stub.cjs')}" %*\r\n`);
  else {
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(folder, 'gh-stub.cjs')}" "$@"\n`);
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
  }
  const env = (overrides = {}) => ({
    ...withNodeOnPath([bin]), GH_TOKEN: 'not-a-token', GH_REPO: 'example/example',
    TRACE_TAG: `v${version}`, TRACE_VERSION: version, TRACE_MAC_VERSION: version, TRACE_LINUX_VERSION: version, ...overrides,
  });
  const ghArguments = () => (fs.existsSync(path.join(folder, 'gh-arguments.json')) ? JSON.parse(fs.readFileSync(path.join(folder, 'gh-arguments.json'), 'utf8')) : null);
  return { folder, assets, env, ghArguments, notes: () => fs.readFileSync(path.join(folder, 'release-notes.md'), 'utf8').replace(/^﻿/, '') };
}

test('draft release (PowerShell): a suffixed version becomes a prerelease draft with all eight files and notes that say so', { skip: powershellSkip }, (t) => {
  const draft = stepOf('draft-release', 'Create draft GitHub release');
  const test_ = draftFolder(t, TEST);
  const result = runPowerShell(test_.folder, draft.run, test_.env());
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const args = test_.ghArguments();
  assert.ok(args, 'gh release create was called');
  assert.deepEqual(args.slice(0, 3), ['release', 'create', `v${TEST}`]);
  const files = args.slice(3, args.indexOf('--draft')).map((argument) => path.basename(argument));
  assert.deepEqual(files.sort(), Object.values(test_.assets).flatMap((name) => [name, `${name}.sha256`]).sort(), 'the four builds and their four checksum files, nothing else');
  assert.deepEqual(args.slice(args.indexOf('--draft')), ['--draft', '--verify-tag', '--title', `TRACE Boardviewer ${TEST}`, '--notes-file', 'release-notes.md', '--prerelease']);
  assert.ok(!args.includes('--latest'));
  const notes = test_.notes();
  assert.ok(notes.startsWith('**This is a prerelease for testing.**'), 'the notes start with the prerelease notice');
  assert.ok(notes.includes(`**TRACE Boardviewer ${TEST}**`));
  for (const name of Object.values(test_.assets)) assert.ok(notes.includes(name), `the notes name ${name}`);
});

test('draft release (PowerShell): a stable version is a normal draft with the notes it always had', { skip: powershellSkip }, (t) => {
  const draft = stepOf('draft-release', 'Create draft GitHub release');
  const stable = draftFolder(t, STABLE);
  const result = runPowerShell(stable.folder, draft.run, stable.env());
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const args = stable.ghArguments();
  assert.deepEqual(args.slice(args.indexOf('--draft')), ['--draft', '--verify-tag', '--title', `TRACE Boardviewer ${STABLE}`, '--notes-file', 'release-notes.md']);
  const notes = stable.notes();
  assert.ok(notes.startsWith(`**TRACE Boardviewer ${STABLE}** is a free, open-source (MIT) boardviewer`), 'no notice in front of the notes');
  assert.doesNotMatch(notes, /prerelease/i);
});

test('draft release (PowerShell): a tag that is not the version, or builds of different versions, create nothing', { skip: powershellSkip }, (t) => {
  const draft = stepOf('draft-release', 'Create draft GitHub release');
  for (const [overrides, message] of [
    [{ TRACE_TAG: `v${STABLE}` }, /Release version does not match the tag/],
    [{ TRACE_MAC_VERSION: STABLE }, /macOS build version does not match/],
    [{ TRACE_LINUX_VERSION: STABLE }, /Linux build version does not match/],
  ]) {
    const mismatch = draftFolder(t, TEST);
    const result = runPowerShell(mismatch.folder, draft.run, mismatch.env(overrides));
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, message);
    assert.equal(mismatch.ghArguments(), null, 'gh was not called');
  }
});

// ---- 6. the update check of the app --------------------------------------------------------------------------------------------

test('the update check never offers a suffixed tag, and a test release is offered the final release', async () => {
  const updates = require('../electron/updates.cjs');
  const answer = (currentVersion, tag, extra = {}) => updates.checkForUpdate({
    currentVersion,
    fetchImpl: async () => new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: false, html_url: 'https://example.invalid/', ...extra }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const CURRENT = { status: 'current' };
  // GitHub's "latest" is the newest stable release, so a test release is normally never what the app sees ...
  assert.deepEqual(await answer('1.3.0', 'v1.3.0'), CURRENT);
  assert.deepEqual(await answer(TEST, 'v1.3.0'), CURRENT, 'the test release is newer than 1.3.0: nothing to offer');
  // ... and when it is (a mistake on the releases page), the tag and the flag each keep it away from every user.
  for (const current of ['1.3.0', TEST, '1.2.0']) {
    assert.deepEqual(await answer(current, `v${TEST}`), CURRENT, `${current}: a suffixed tag with the flag unset`);
    assert.deepEqual(await answer(current, `v${TEST}`, { prerelease: true }), CURRENT, `${current}: a suffixed tag with the prerelease flag`);
    assert.deepEqual(await answer(current, 'v1.3.2', { prerelease: true }), CURRENT, `${current}: a plain tag whose release is flagged as prerelease`);
    assert.deepEqual(await answer(current, 'v1.3.2-rc.2'), CURRENT, `${current}: the next test release`);
  }
  assert.deepEqual(await answer(TEST, 'v1.3.1-rc.2'), CURRENT, 'a later test release is not offered to a test release either');
  // The final release is offered to everybody older, a test release of the same version included.
  assert.deepEqual(await answer(TEST, `v${STABLE}`), { status: 'available', version: STABLE, tag: `v${STABLE}` });
  assert.deepEqual(await answer('1.3.0', `v${STABLE}`), { status: 'available', version: STABLE, tag: `v${STABLE}` });
  assert.deepEqual(await answer(STABLE, `v${STABLE}`), CURRENT);
  assert.deepEqual(await answer('1.3.2-rc.1', `v${STABLE}`), CURRENT, 'a test release of a later version is newer than the stable one');
  // The running version is parsed with the same suffix rules (an unparsable version would silently turn the check off).
  assert.deepEqual(await updates.checkForUpdate({ currentVersion: '1.3.1-rc.1', fetchImpl: async () => new Response('{}', { status: 404 }) }), { status: 'unavailable' });
  const { VERSION_PATTERN } = require('../electron/net/egress.cjs');
  assert.ok(VERSION_PATTERN.test(TEST), 'the User-Agent carries the version of a test release');
  assert.ok(VERSION_PATTERN.test(packageJson.version), 'the version of package.json parses');
});
