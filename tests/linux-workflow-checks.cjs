'use strict';

// STATIC / SIMULATED checks for the Linux lane of the release workflow. This is NOT Linux runtime acceptance: it never builds a
// package, never launches the app and says nothing about how the product behaves on Linux (the linux job of the workflow does that
// on an Ubuntu 24.04 runner). It parses .github/workflows/windows.yml with the pinned electron-builder's own YAML loader, checks the
// linux job (runner, permissions, pinned actions, step order, the four smoke scenarios, the scan, the uploads) and exercises the pure
// logic and the platform gate of scripts/linux-smoke.cjs. It runs on Linux, Windows and macOS:
//
//   node --test tests/linux-workflow-checks.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const rel = (...parts) => path.join(ROOT, ...parts);
const smoke = require('../scripts/linux-smoke.cjs');
const macSmoke = require('../scripts/mac-smoke.cjs');

const WORKFLOW_FILE = '.github/workflows/windows.yml';
const SMOKE_FILE = 'scripts/linux-smoke.cjs';
// Inputs that can be pointed at COPIES (mutation checks of the assertions, or a sibling branch's file); the real files are never edited.
const WORKFLOW_PATH = process.env.TRACE_LINUX_WORKFLOW_CHECKS_WORKFLOW || rel(WORKFLOW_FILE);
const SMOKE_SOURCE_PATH = process.env.TRACE_LINUX_WORKFLOW_CHECKS_SMOKE_SOURCE || rel(SMOKE_FILE);
const LINUX_CONFIG_PATH = process.env.TRACE_LINUX_WORKFLOW_CHECKS_CONFIG || rel('config', 'electron-builder.linux.yml');
const MAIN_PATH = process.env.TRACE_LINUX_WORKFLOW_CHECKS_MAIN || rel('electron', 'main.cjs');
// The English catalog is a folder of namespace files (electron/locales/en/<namespace>.json); the override names such a folder.
const LOCALE_EN_DIRECTORY = process.env.TRACE_LINUX_WORKFLOW_CHECKS_LOCALE_EN || rel('electron', 'locales', 'en');

// The pinned electron-builder resolves its own YAML parser; nothing is added to the project.
function builderYaml() {
  const builderManifest = require.resolve('electron-builder/package.json', { paths: [ROOT] });
  const libDirectory = path.dirname(require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builderManifest)] }));
  return require(require.resolve('js-yaml', { paths: [libDirectory] }));
}
const yaml = builderYaml();
const workflowText = fs.readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');
const workflow = yaml.load(workflowText);
const smokeSource = fs.readFileSync(SMOKE_SOURCE_PATH, 'utf8');
// One job's YAML text (from its "  <name>:" line to the next job), the same cut the other workflow tests use.
const jobText = (name) => {
  const start = workflowText.indexOf(`\n  ${name}:\n`);
  assert.ok(start !== -1, `job ${name} exists in ${WORKFLOW_FILE}`);
  const next = workflowText.slice(start + 1).search(/\n  [a-z][a-z-]*:\n/);
  return workflowText.slice(start, next === -1 ? undefined : start + 1 + next);
};
const linux = () => workflow.jobs.linux;
const stepNamed = (prefix) => {
  const step = linux().steps.find((entry) => typeof entry.name === 'string' && entry.name.startsWith(prefix));
  assert.ok(step, `step "${prefix}..." exists in the linux job`);
  return step;
};
const smokeStep = (scenario) => {
  const steps = linux().steps.filter((step) => step.run && step.run.includes(`linux-smoke.cjs run --scenario ${scenario} `));
  assert.equal(steps.length, 1, `exactly one step runs scenario ${scenario}`);
  return steps[0];
};
const PACKAGES_EXIST = "!cancelled() && steps.locate.outcome == 'success'";
const XVFB = "xvfb-run -a -s '-screen 0 1600x1000x24' node scripts/linux-smoke.cjs run ";

// ---- the workflow ------------------------------------------------------------------------------------------

test('static: the linux job lives in the release workflow, pinned to ubuntu-24.04, read-only, bash, bounded, on every trigger of the Windows build', () => {
  assert.equal(fs.existsSync(rel('.github', 'workflows', 'linux.yml')), false, 'one workflow: a second one would be a second, unreviewed path to a build');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const job = linux();
  assert.ok(job, 'job "linux"');
  assert.equal(job['runs-on'], 'ubuntu-24.04', 'an explicit label: ubuntu-latest moves to a new release without a review');
  assert.equal(job.if, undefined, 'Linux minutes are the cheapest: the job runs wherever the Windows build runs (pull requests included)');
  assert.equal(workflow.jobs.build.if, undefined, 'the Windows build itself runs on every trigger');
  assert.ok(!('needs' in job), 'the job builds from source on its own');
  assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 60);
  assert.ok(!('permissions' in job), 'no job-level permission override: the linux job never writes to the repository');
  assert.ok(!('strategy' in job) && !('container' in job) && !('services' in job));
  assert.equal(job.defaults.run.shell, 'bash');
  assert.equal(job.env.TRACE_ARCH, 'x64');
  assert.equal(job.env.TRACE_COMMIT, '${{ github.sha }}');
  assert.deepEqual(Object.keys(job.outputs).sort(), ['artifact_name', 'version']);
  assert.equal(job.outputs.artifact_name, '${{ steps.metadata.outputs.artifact_name }}');
  const text = jobText('linux');
  assert.doesNotMatch(text, /secrets\.|GITHUB_TOKEN|GH_TOKEN/, 'the linux job uses no secret and no token');
  assert.doesNotMatch(text, /gh release|contents:\s*write|softprops|action-gh-release|download-artifact/, 'the linux job only builds, tests and uploads');
  assert.equal(workflow.on.workflow_call.outputs.linux_artifact_name.value, '${{ jobs.linux.outputs.artifact_name }}');
  assert.match(workflow.on.workflow_call.outputs.linux_artifact_name.description, /AppImage, \.deb and SHA256/);
});

test('static: actions are pinned to the same full SHAs as the Windows build job; checkout persists no credentials', () => {
  const pinsOf = (steps) => new Map(steps.filter((step) => step.uses).map((step) => step.uses.split('@')));
  const buildPins = pinsOf(workflow.jobs.build.steps);
  const linuxPins = pinsOf(linux().steps);
  assert.deepEqual([...linuxPins.keys()].sort(), ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact', 'pnpm/action-setup']);
  for (const [name, sha] of linuxPins) {
    assert.match(sha, /^[0-9a-f]{40}$/, `${name} is pinned to a full commit SHA`);
    assert.equal(buildPins.get(name), sha, `${name} uses the same pinned SHA as the Windows build job`);
  }
  const checkout = linux().steps.find((step) => step.uses && step.uses.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  const node = linux().steps.find((step) => step.uses && step.uses.startsWith('actions/setup-node@'));
  assert.deepEqual(node.with, { 'node-version': '24', 'package-manager-cache': false });
  const install = stepNamed('Install locked dependencies');
  assert.equal(install.run, 'pnpm install --frozen-lockfile');
  assert.ok(!linux().steps.some((step) => /Prepare Electron runtime/.test(step.name) || /setup:electron/.test(step.run ?? '')), 'no setup:electron: the builder downloads the Linux Electron itself');
});

test('static: the steps run in order: tests, build, checksums, static package checks, the four smoke scenarios, scan, upload, cleanup last', () => {
  const names = linux().steps.map((step) => step.name);
  const order = [
    'Install locked dependencies', 'Validate release metadata', 'Run the static Linux packaging checks', 'Run parser and geometry tests',
    'Run desktop boundary and persistence tests', 'Build the renderer', 'Build the Linux packages', 'Locate the packages and generate checksums',
    'Install the smoke-test tools', 'Check the packages statically (S0)',
  ];
  const at = (prefix) => { const index = names.findIndex((name) => name.startsWith(prefix)); assert.ok(index >= 0, `step "${prefix}"`); return index; };
  const indices = order.map(at);
  assert.deepEqual([...indices].sort((a, b) => a - b), indices, 'the build and test steps keep their order');
  const scenario = (id) => linux().steps.indexOf(smokeStep(id));
  const relax = at('Allow unprivileged user namespaces');
  assert.ok(at('Check the packages statically (S0)') < scenario('S1') && scenario('S1') < scenario('S2') && scenario('S2') < relax && relax < scenario('S3') && scenario('S3') < scenario('S4'),
    'S0, then the restricted scenarios S1 and S2, then the sysctl change, then S3 and S4');
  const scan = at('Scan the packages for private names and paths');
  const upload = at('Upload Linux packages and checksums');
  const evidence = at('Upload Linux smoke evidence');
  assert.ok(scenario('S4') < at('Show Linux smoke summary') && scenario('S4') < scan && scan < upload && upload < evidence, 'smoke and scan come before the upload');
  assert.equal(names[names.length - 1], 'Stop leftover app processes', 'the cleanup is the last step');
  const metadata = stepNamed('Validate release metadata');
  assert.equal(metadata.id, 'metadata');
  assert.match(metadata.run, /echo "artifact_name=TRACE-Boardviewer-\$version-linux-\$TRACE_ARCH" >> "\$GITHUB_OUTPUT"/);
  assert.match(metadata.run, /if \[\[ "\$TRACE_REF" == refs\/tags\/\* && "\$TRACE_TAG" != "v\$version" \]\]; then/, 'a tag must match package.json, as in the other jobs');
  assert.equal(stepNamed('Run the static Linux packaging checks').run, 'node --test tests/linux-config-checks.cjs tests/linux-workflow-checks.cjs');
  assert.equal(stepNamed('Run parser and geometry tests').run, 'pnpm test');
  assert.equal(stepNamed('Run desktop boundary and persistence tests').run, 'pnpm test:desktop');
  assert.equal(stepNamed('Build the renderer').run, 'pnpm run build');
});

test('static: contexts reach the scripts only through env (no ${{ inside any run script of the job)', () => {
  for (const step of linux().steps.filter((entry) => entry.run)) {
    assert.doesNotMatch(step.run, /\$\{\{/, `step "${step.name}"`);
    assert.equal(step.shell, undefined, `step "${step.name}" uses the job's bash`);
  }
});

test('static: the build command builds AppImage and deb with the Linux config for the job architecture and publishes nothing', () => {
  const build = stepNamed('Build the Linux packages');
  assert.equal(build.run, 'pnpm exec electron-builder --linux AppImage deb "--$TRACE_ARCH" --config config/electron-builder.linux.yml --publish never');
  for (const step of linux().steps.filter((entry) => entry.run)) assert.doesNotMatch(step.run, /--win\b|--mac\b|--publish always|--publish onTag/, `step "${step.name}"`);
  const locate = stepNamed('Locate the packages and generate checksums');
  assert.equal(locate.id, 'locate');
  assert.match(locate.run, /x64\) appimageArch=x86_64; debArch=amd64; unpacked=release-linux\/linux-unpacked ;;/);
  assert.match(locate.run, /appimage="release-linux\/TRACE-Boardviewer-\$TRACE_VERSION-linux-\$appimageArch\.AppImage"/);
  assert.match(locate.run, /deb="release-linux\/TRACE-Boardviewer-\$TRACE_VERSION-linux-\$debArch\.deb"/);
  assert.match(locate.run, /sha256sum "\$name" > "\$name\.sha256"/, 'the same "<sha256>  <file name>" line as the EXE checksum');
  assert.equal(smoke.artifactFileName('1.2.0', 'x64', 'AppImage'), 'TRACE-Boardviewer-1.2.0-linux-x86_64.AppImage', 'the smoke script expects the names the locate step builds');
  assert.equal(smoke.artifactFileName('1.2.0', 'x64', 'deb'), 'TRACE-Boardviewer-1.2.0-linux-amd64.deb');
  assert.match(locate.run, /if \[ ! -x "\$unpacked\/trace-boardviewer" \]/);
  const tools = stepNamed('Install the smoke-test tools');
  for (const name of ['fuse3', 'x11-utils', 'xdotool', 'desktop-file-utils', 'xvfb', 'xauth']) assert.match(tools.run, new RegExp(` ${name}(?= |$)`, 'm'), `${name} is installed`);
});

test('static: the workflow never switches the sandbox off and never pre-answers the consent dialog', () => {
  const text = jobText('linux');
  assert.doesNotMatch(text, /no-sandbox|disable-setuid-sandbox|disable-namespace-sandbox|ELECTRON_DISABLE_SANDBOX/, 'no sandbox-off switch anywhere in the job, comments included');
  assert.doesNotMatch(workflowText, /TRACE_ACCEPT_NO_SANDBOX/, 'no job-wide bypass: the smoke script sets it per launch, and never for the launches that answer the consent dialog');
  assert.doesNotMatch(text, /APPIMAGE_EXTRACT_AND_RUN|--appimage-extract-and-run/, 'the AppImage runs through FUSE; only the smoke script falls back, and records it');
});

test('static: the four smoke scenarios S1-S4 under Xvfb with the user-namespace state each one needs', () => {
  const expected = {
    S1: '--scenario S1 --target installed --arch "$TRACE_ARCH" --userns restricted --expect-sandbox on --expect-gate no --out test-results/linux/smoke-S1-deb-restricted.json',
    S2: '--scenario S2 --target appimage --appimage "$TRACE_APPIMAGE" --arch "$TRACE_ARCH" --userns restricted --expect-sandbox off --expect-gate yes --out test-results/linux/smoke-S2-appimage-restricted.json',
    S3: '--scenario S3 --target appimage --appimage "$TRACE_APPIMAGE" --arch "$TRACE_ARCH" --userns allowed --expect-sandbox on --expect-gate no --out test-results/linux/smoke-S3-appimage-userns.json',
    S4: '--scenario S4 --target unpacked --unpacked "$TRACE_UNPACKED" --arch "$TRACE_ARCH" --userns allowed --expect-sandbox on --expect-gate no --out test-results/linux/smoke-S4-unpacked-userns.json',
  };
  for (const [scenario, args] of Object.entries(expected)) {
    const step = smokeStep(scenario);
    assert.ok(step.run.includes(`${XVFB}${args}`), `${scenario} runs: ${args}`);
    assert.equal(step.if, PACKAGES_EXIST, `${scenario} runs whenever the packages exist, even after an earlier scenario failed`);
    assert.ok(Number.isInteger(step['timeout-minutes']) && step['timeout-minutes'] <= 15, `${scenario} has its own timeout`);
    // Every scenario must be accepted by the script's own argument parser (the variables as the locate step sets them).
    const values = { '"$TRACE_ARCH"': 'x64', '"$TRACE_APPIMAGE"': 'release-linux/TRACE-Boardviewer-1.2.0-linux-x86_64.AppImage', '"$TRACE_UNPACKED"': 'release-linux/linux-unpacked' };
    const argv = ['run', ...args.split(' ').map((word) => values[word] ?? word)];
    assert.deepEqual(smoke.parseArgs(argv).errors, [], `${scenario} arguments parse`);
  }
  const s1 = smokeStep('S1');
  const s1Lines = s1.run.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.equal(s1Lines[1], 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1', 'S1 sets the stock restriction explicitly before anything else');
  assert.ok(s1Lines.includes('sudo apt-get install -y --no-install-recommends "./$TRACE_DEB"'), 'the .deb is installed with apt (dependencies and maintainer scripts run)');
  assert.ok(s1Lines.includes('test -f /etc/apparmor.d/trace-boardviewer'));
  assert.ok(s1Lines.includes("sudo cat /sys/kernel/security/apparmor/profiles | grep -F 'trace-boardviewer (unconfined)'"), 'the profile is loaded');
  assert.ok(s1Lines.indexOf("sudo cat /sys/kernel/security/apparmor/profiles | grep -F 'trace-boardviewer (unconfined)'") < s1Lines.findIndex((line) => line.startsWith('xvfb-run')));
  assert.equal(s1Lines[0], 'set -euo pipefail');
  const s2Lines = smokeStep('S2').run.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(s2Lines.slice(0, 2), ['set -euo pipefail', 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1'], 'S2 asserts the restriction itself');
  const relax = stepNamed('Allow unprivileged user namespaces');
  assert.equal(relax.run, 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0');
  assert.equal(relax.if, PACKAGES_EXIST);
  for (const scenario of ['S3', 'S4']) assert.doesNotMatch(smokeStep(scenario).run, /sysctl/, `${scenario} relies on the step before it`);
  assert.equal(linux().steps.filter((step) => step.run && /--expect-gate yes/.test(step.run)).length, 1, 'only S2 expects the consent dialog');
  assert.equal(stepNamed('Check the packages statically (S0)').run, 'node scripts/linux-smoke.cjs static --appimage "$TRACE_APPIMAGE" --deb "$TRACE_DEB" --unpacked "$TRACE_UNPACKED" --arch "$TRACE_ARCH" --out test-results/linux/linux-static.json');
  assert.equal(stepNamed('Check the packages statically (S0)').if, PACKAGES_EXIST);
  const summary = stepNamed('Show Linux smoke summary');
  assert.equal(summary.if, 'always()');
  assert.match(summary.run, /node scripts\/linux-smoke\.cjs summary --dir test-results\/linux >> "\$GITHUB_STEP_SUMMARY"/);
  for (const step of linux().steps.filter((entry) => entry.env)) {
    for (const [name, value] of Object.entries(step.env)) {
      if (/^TRACE_(APPIMAGE|DEB|UNPACKED)$/.test(name)) assert.equal(value, `\${{ steps.locate.outputs.${name.slice(6).toLowerCase()} }}`, `${step.name}: ${name} comes from the locate step`);
    }
  }
});

test('static: the scan searches every text file of the three trees and each app.asar for runner paths; one hit fails before the upload', () => {
  const scan = stepNamed('Scan the packages for private names and paths');
  assert.equal(scan.if, PACKAGES_EXIST);
  assert.ok(scan.run.includes("pattern='/Users/runner|/home/runner|runner/work'"), 'the same pattern as the macOS scan, no broader one (third-party files carry addresses that are not ours)');
  assert.match(scan.run, /for tree in "\$TRACE_UNPACKED" "\$work\/appimage\/squashfs-root" "\$work\/deb"; do/);
  assert.match(scan.run, /grep -r -I -i -l -E "\$pattern" "\$tree"/, 'every text file, case-insensitively');
  assert.match(scan.run, /--appimage-extract > \/dev\/null/);
  assert.match(scan.run, /dpkg-deb -R "\$TRACE_DEB" "\$work\/deb"/);
  assert.ok(scan.run.includes('for file in "$TRACE_UNPACKED/resources/app.asar" "$work/appimage/squashfs-root/resources/app.asar" "$work/deb/opt/TRACE Boardviewer/resources/app.asar"; do'));
  assert.match(scan.run, /grep -a -i -q -E "\$pattern" "\$file"/, 'each app.asar as bytes');
  assert.match(scan.run, /if \[ ! -f "\$file" \]; then echo "Cannot scan a missing file: \$file" >&2; exit 1; fi/);
  assert.match(scan.run, /if \[ "\$hits" -ne 0 \]; then\n\s+echo '[^\n]*' >&2\n\s+exit 1/, 'one hit fails the job');
  assert.match(scan.run, /^set -euo pipefail/);
});

test('static: the packages are uploaded only after every step passed; the evidence always; the cleanup kills only app processes', () => {
  const upload = stepNamed('Upload Linux packages and checksums');
  assert.equal(upload.if, undefined, 'no if: the default success() keeps a failed smoke test or scan from uploading anything');
  assert.equal(upload.with.name, '${{ steps.metadata.outputs.artifact_name }}');
  assert.equal(upload.with.path.trim(), ['${{ steps.locate.outputs.appimage }}', '${{ steps.locate.outputs.appimage }}.sha256', '${{ steps.locate.outputs.deb }}', '${{ steps.locate.outputs.deb }}.sha256'].join('\n'));
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['compression-level'], 0);
  assert.equal(upload.with['retention-days'], 14);
  const evidence = stepNamed('Upload Linux smoke evidence');
  assert.equal(evidence.if, 'always()');
  assert.equal(evidence.with.name, 'linux-smoke-evidence-${{ steps.metadata.outputs.version }}');
  assert.equal(evidence.with.path.trim(), 'test-results/linux/*.json\ntest-results/linux/*.png');
  assert.equal(evidence.with['if-no-files-found'], 'warn');
  assert.equal(evidence.with['retention-days'], 14);
  assert.equal(evidence.with.overwrite, true);
  const cleanup = stepNamed('Stop leftover app processes');
  assert.equal(cleanup.if, 'always()');
  assert.ok(cleanup.run.includes('pkill -KILL -f -- "$appProcesses" || true'));
  // The pattern (an extended regular expression for pkill) must hit the app and the AppImage runtime, never the checkout or the runner.
  const declared = /^appProcesses='([^']+)'$/m.exec(cleanup.run);
  assert.ok(declared, 'the process pattern is declared once');
  const pattern = new RegExp(declared[1]);
  for (const line of ['/opt/TRACE Boardviewer/trace-boardviewer --user-data-dir=/tmp/p', '/tmp/.mount_TRACE-x/trace-boardviewer --type=renderer',
    '/home/runner/work/trace-boardviewer/trace-boardviewer/release-linux/TRACE-Boardviewer-1.2.0-linux-x86_64.AppImage --inspect=0', 'release-linux/linux-unpacked/trace-boardviewer']) {
    assert.match(line, pattern, line);
  }
  for (const line of ['/home/runner/actions-runner/cached/bin/Runner.Worker spawnclient 1 2', 'bash -e /home/runner/work/_temp/1234.sh',
    'node /home/runner/work/trace-boardviewer/trace-boardviewer/scripts/linux-smoke.cjs summary --dir test-results/linux', 'git -C /home/runner/work/trace-boardviewer/trace-boardviewer status']) {
    assert.doesNotMatch(line, pattern, line);
  }
});

test('static: the draft release waits for the linux job, verifies the AppImage and the .deb against their SHA256 files and attaches both', () => {
  const release = workflow.jobs['draft-release'];
  assert.deepEqual(release.needs, ['build', 'portable-isolation', 'mac', 'linux'], 'a Linux failure blocks the draft release, as a macOS failure does');
  assert.equal(release.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')", 'only a pushed v* tag drafts a release');
  const downloads = release.steps.filter((step) => step.uses && step.uses.startsWith('actions/download-artifact@'));
  const linuxDownload = downloads.find((step) => step.name === 'Download Linux build artifact');
  assert.ok(linuxDownload, 'the Linux artifact is downloaded');
  assert.deepEqual(linuxDownload.with, { name: '${{ needs.linux.outputs.artifact_name }}', path: 'release' });
  assert.equal(linuxDownload.uses, downloads[0].uses, 'the same pinned download action');
  assert.ok(release.steps.indexOf(linuxDownload) < release.steps.findIndex((step) => step.name === 'Create draft GitHub release'));
  const create = release.steps.find((step) => step.name === 'Create draft GitHub release');
  assert.equal(create.env.TRACE_LINUX_VERSION, '${{ needs.linux.outputs.version }}');
  const lines = create.run.split('\n');
  const at = (line) => { const index = lines.indexOf(line); assert.ok(index >= 0, `script line: ${line}`); return index; };
  const linuxCheck = at("if ($env:TRACE_LINUX_VERSION -ne $env:TRACE_VERSION) { throw 'The Linux build version does not match the Windows build version.' }");
  assert.ok(at("if ($env:TRACE_MAC_VERSION -ne $env:TRACE_VERSION) { throw 'The macOS build version does not match the Windows build version.' }") < linuxCheck);
  const appImage = at('$traceAppImage = Join-Path release "TRACE-Boardviewer-$env:TRACE_VERSION-linux-x86_64.AppImage"');
  const deb = at('$traceDeb = Join-Path release "TRACE-Boardviewer-$env:TRACE_VERSION-linux-amd64.deb"');
  const loop = at('foreach ($traceFile in @($traceExe, $traceZip, $traceAppImage, $traceDeb)) {');
  assert.ok(linuxCheck < appImage && appImage < deb && deb < loop, 'versions first, then the names, then the checksum loop over all four assets');
  assert.equal(smoke.artifactFileName('X', 'x64', 'AppImage'), 'TRACE-Boardviewer-X-linux-x86_64.AppImage', 'the names the linux job builds and uploads');
  assert.equal(smoke.artifactFileName('X', 'x64', 'deb'), 'TRACE-Boardviewer-X-linux-amd64.deb');
  const notes = create.run.slice(create.run.indexOf('@"'), create.run.indexOf('"@'));
  assert.match(notes, /- TRACE-Boardviewer-\$\{env:TRACE_VERSION\}-linux-amd64\.deb \(\+ \.sha256\): experimental Linux x86-64 package/);
  assert.ok(notes.includes('      sudo apt install ./TRACE-Boardviewer-${env:TRACE_VERSION}-linux-amd64.deb\n'), 'the install line, indented as a code block of the list item');
  assert.match(notes, /- TRACE-Boardviewer-\$\{env:TRACE_VERSION\}-linux-x86_64\.AppImage \(\+ \.sha256\): experimental portable Linux x86-64 build/);
  assert.match(notes, /Make it executable \(chmod \+x\) and run it/);
  assert.match(notes, /TRACE asks before it starts without it: use the \.deb there\./);
  assert.match(notes, /\nThe Linux builds are tested automatically on Ubuntu 24\.04 only\.\n/, 'the honest limit of the Linux testing');
  assert.ok(notes.indexOf('-mac-arm64.zip') < notes.indexOf('-linux-amd64.deb') && notes.indexOf('-linux-amd64.deb') < notes.indexOf('-linux-x86_64.AppImage') && notes.indexOf('-linux-x86_64.AppImage') < notes.indexOf('User board files are not included.'));
  assert.doesNotMatch(notes, /`/, 'no backticks: the notes are a double-quoted PowerShell here-string, where a backtick escapes');
  assert.doesNotMatch(notes, /\$(?!\{env:TRACE_VERSION\})/, 'the only expansion in the notes is the version');
});

// ---- the smoke script --------------------------------------------------------------------------------------

test('static: the smoke script refuses to produce evidence off Linux, loads Playwright lazily and keeps the sandbox', () => {
  for (const platform of ['win32', 'darwin', 'freebsd']) {
    const gate = smoke.platformGate(platform);
    assert.equal(gate.allowed, false, platform);
    assert.match(gate.message, /refuses to run on "/);
  }
  assert.equal(smoke.platformGate('linux').allowed, true);
  assert.match(smokeSource, /if \(require\.main === module\)/, 'the OS part only runs when executed directly');
  const mainBody = smokeSource.slice(smokeSource.indexOf('async function main('));
  assert.ok(mainBody.indexOf('platformGate(process.platform)') > 0 && mainBody.indexOf('platformGate(process.platform)') < mainBody.indexOf('parseArgs('), 'the platform gate comes before argument parsing');
  for (const name of ['async function runScenario(', 'async function runStatic(']) {
    const body = smokeSource.slice(smokeSource.indexOf(name));
    assert.ok(body.indexOf('platformGate(process.platform)') > 0 && body.indexOf('platformGate(process.platform)') < 200, `${name} checks the platform first`);
  }
  assert.doesNotMatch(smokeSource.split('\n').filter((line) => /^(?:const|let|var)\s/.test(line)).join('\n'), /require\('playwright'\)/, 'playwright is loaded lazily, after the gate');
  // Playwright adds the sandbox-off switch on Linux unless chromiumSandbox is true: the one launch call must say so.
  const launches = [...smokeSource.matchAll(/_electron\.launch\(\{([^}]*)\}\)/g)].map((match) => match[1]);
  assert.equal(launches.length, 1, 'one Playwright launch call');
  assert.match(launches[0], /chromiumSandbox: true/);
  assert.match(launches[0], /args,/);
  // Every argument list comes from resolveSpec, which builds it with launchArgs, which refuses a sandbox-off switch.
  assert.match(smokeSource.slice(smokeSource.indexOf('function resolveSpec(')), /^[^\n]*\n(?:[^\n]*\n){0,5}?\s*return \{ profile, args: launchArgs\(\{ profile, board, positional \}\), cwd \};/);
  assert.equal((smokeSource.match(/\} = resolveSpec\(spec, dirs\);/g) ?? []).length, 2, 'the Playwright launches and the second instances take their arguments from resolveSpec');
  assert.match(smokeSource, /spawn\(executable, args, \{ env, cwd: cwd \?\? undefined, detached: true/);
  assert.doesNotMatch(smokeSource, /args\.push\(['"`]--no-sandbox|'--no-sandbox',|"--no-sandbox",/, 'no sandbox-off switch is ever pushed');
  assert.match(smokeSource, /require\('\.\/mac-smoke\.cjs'\)/, 'fixtures and pure decisions are shared with the macOS smoke test');
});

test('static: off Linux, static and run exit 2 with nothing on stdout; summary and --dry-run work everywhere and write nothing', { skip: process.platform === 'linux' && 'on Linux the commands would really run' }, () => {
  const run = (args) => spawnSync(process.execPath, [rel(SMOKE_FILE), ...args], { encoding: 'utf8', timeout: 30000, cwd: os.tmpdir() });
  for (const args of [['static', '--appimage', 'a.AppImage', '--deb', 'a.deb', '--unpacked', 'u', '--arch', 'x64'], ['run', '--scenario', 'S1', '--target', 'installed', '--arch', 'x64', '--userns', 'restricted', '--expect-sandbox', 'on', '--expect-gate', 'no'], ['run', '--help']]) {
    const result = run(args);
    assert.equal(result.status, 2, `exit code 2 for ${JSON.stringify(args)}`);
    assert.match(result.stderr, /refuses to run on/);
    assert.equal(result.stdout, '', 'nothing is produced on stdout');
  }
  assert.equal(run([]).status, 2, 'no command');
  assert.equal(run(['bogus']).status, 2, 'unknown command');
  const out = path.join(os.tmpdir(), `trace-linux-dry-run-${process.pid}.json`);
  const dry = run(['run', '--dry-run', '--scenario', 'S2', '--target', 'appimage', '--appimage', 'release-linux/TRACE-Boardviewer-1.2.0-linux-x86_64.AppImage', '--arch', 'x64', '--userns', 'restricted', '--expect-sandbox', 'off', '--expect-gate', 'yes', '--out', out]);
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.launches.map((launch) => `${launch.label}:${launch.consentDialog}`), ['gate-quit:quit', 'gate-start:start-remember', 'gate-remembered:absent', 'launch-1:absent',
    'launch-2:absent', 'second-instance-uri:absent', 'second-instance-relative:absent', 'default-location:absent']);
  assert.ok(plan.launches.slice(0, 3).every((launch) => !('TRACE_ACCEPT_NO_SANDBOX' in launch.environment.set)), 'the dialog launches never set the bypass');
  assert.ok(plan.launches.slice(3).every((launch) => launch.environment.set.TRACE_ACCEPT_NO_SANDBOX === '1'), 'the flow of S2 never depends on the dialog automation');
  assert.ok(plan.launches.every((launch) => launch.args.every((argument) => !/sandbox/.test(argument))));
  assert.match(plan.launches[5].args[1], /^file:\/\/\/tmp\/trace-linux-smoke-XXXXXX\/project\/LinuxSmokeTwo\.cad$/);
  assert.deepEqual([plan.launches[6].args[1], plan.launches[6].cwd], ['LinuxSmoke.cad', '/tmp/trace-linux-smoke-XXXXXX/project']);
  assert.equal(fs.existsSync(out), false, 'a dry run writes no evidence');
  const staticDry = run(['static', '--dry-run', '--appimage', 'r/TRACE-Boardviewer-1.2.0-linux-x86_64.AppImage', '--deb', 'r/TRACE-Boardviewer-1.2.0-linux-amd64.deb', '--unpacked', 'r/linux-unpacked', '--arch', 'x64']);
  assert.equal(staticDry.status, 0, staticDry.stderr);
  assert.match(JSON.parse(staticDry.stdout).unpackedExecutable, /r\/linux-unpacked\/trace-boardviewer$/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-linux-summary-'));
  try {
    const summary = run(['summary', '--dir', empty]);
    assert.equal(summary.status, 0);
    assert.match(summary.stdout, /No Linux smoke evidence was written/);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('simulated: runScenario() and runStatic() reject off Linux', { skip: process.platform === 'linux' && 'on Linux they would really run' }, async () => {
  const out = path.join(os.tmpdir(), `trace-linux-must-not-exist-${process.pid}.json`);
  await assert.rejects(() => smoke.runScenario({ command: 'run', scenario: 'S1', target: 'installed', arch: 'x64', userns: 'restricted', expectSandbox: 'on', expectGate: 'no', out }), /refuses to run on/);
  await assert.rejects(() => smoke.runStatic({ command: 'static', appimage: 'a.AppImage', deb: 'a.deb', unpacked: 'u', arch: 'x64', out }), /refuses to run on/);
  assert.equal(fs.existsSync(out), false);
});

test('simulated: argument parsing, executable and file names', () => {
  const good = smoke.parseArgs(['run', '--scenario', 'S3', '--target=appimage', '--appimage', 'r/T.AppImage', '--arch', 'x64', '--userns', 'allowed', '--expect-sandbox', 'on', '--expect-gate', 'no', '--keep-temp'], { GITHUB_SHA: 'abc' });
  assert.deepEqual(good.errors, []);
  assert.equal(good.commit, 'abc');
  assert.equal(good.keepTemp, true);
  assert.equal(smoke.executableFor(good), 'r/T.AppImage');
  assert.equal(smoke.executableFor({ target: 'installed' }), '/opt/TRACE Boardviewer/trace-boardviewer');
  assert.equal(smoke.executableFor({ target: 'unpacked', unpacked: 'release-linux/linux-unpacked/' }), 'release-linux/linux-unpacked/trace-boardviewer');
  assert.equal(smoke.executableFor({ target: 'installed', executable: '/x/y' }), '/x/y');
  const base = ['run', '--scenario', 'S1', '--target', 'installed', '--arch', 'x64', '--userns', 'restricted'];
  assert.deepEqual(smoke.parseArgs([...base, '--expect-sandbox', 'on', '--expect-gate', 'no']).errors, []);
  for (const bad of [
    [], ['bogus'], ['run'], [...base, '--expect-sandbox', 'on', '--expect-gate', 'yes'], [...base, '--expect-sandbox', 'off', '--expect-gate', 'no'],
    [...base, '--expect-sandbox', 'maybe', '--expect-gate', 'no'], ['run', '--scenario', 'S0', '--target', 'installed', '--arch', 'x64', '--userns', 'restricted', '--expect-sandbox', 'on', '--expect-gate', 'no'],
    ['run', '--scenario', 'S1', '--target', 'appimage', '--arch', 'x64', '--userns', 'restricted', '--expect-sandbox', 'off', '--expect-gate', 'yes'],
    ['run', '--scenario', 'S1', '--target', 'appimage', '--appimage', 'x.deb', '--arch', 'x64', '--userns', 'restricted', '--expect-sandbox', 'off', '--expect-gate', 'yes'],
    ['run', '--scenario', 'S1', '--target', 'installed', '--appimage', 'x.AppImage', '--arch', 'x64', '--userns', 'restricted', '--expect-sandbox', 'on', '--expect-gate', 'no'],
    ['run', '--scenario', 'S4', '--target', 'unpacked', '--arch', 'x64', '--userns', 'allowed', '--expect-sandbox', 'on', '--expect-gate', 'no'],
    [...base, '--expect-sandbox', 'on', '--expect-gate', 'no', '--arch', 'universal'], [...base, '--expect-sandbox', 'on', '--expect-gate', 'no', '--userns', 'maybe'],
    [...base, '--expect-sandbox', 'on', '--expect-gate', 'no', '--bogus'], [...base, '--expect-sandbox', 'on', '--expect-gate', 'no', '--deb', 'x.deb'],
    [...base, '--expect-sandbox', 'on', '--expect-gate'], [...base, '--expect-sandbox', 'on', '--expect-gate', 'no', '--keep-temp=1'],
    ['static', '--appimage', 'a.AppImage', '--deb', 'a.deb', '--arch', 'x64'], ['static', '--appimage', 'a.zip', '--deb', 'a.deb', '--unpacked', 'u', '--arch', 'x64'],
    ['static', '--appimage', 'a.AppImage', '--deb', 'a.deb', '--unpacked', 'u', '--arch', 'x64', '--keep-temp'],
    ['summary'], ['summary', '--dir', 'd', '--dry-run'],
  ]) assert.ok(smoke.parseArgs(bad).errors.length > 0, JSON.stringify(bad));
  assert.deepEqual(smoke.parseArgs(['run', '--help']).errors, []);
  assert.equal(smoke.defaultOut({ command: 'run', scenario: 'S2', target: 'appimage' }), 'test-results/linux/smoke-S2-appimage.json');
  assert.equal(smoke.artifactFileName('1.3.0-rc.1', 'arm64', 'deb'), 'TRACE-Boardviewer-1.3.0-rc.1-linux-arm64.deb');
  assert.throws(() => smoke.artifactFileName('1.2.0', 'ia32', 'deb'), /unknown architecture/);
});

test('simulated: launches never switch the sandbox off; the launcher only copies stderr; the environment is scrubbed', () => {
  assert.deepEqual(smoke.launchArgs({ profile: '/tmp/p', board: '/tmp/b c.cad' }), ['--user-data-dir=/tmp/p', '--board=/tmp/b c.cad']);
  assert.deepEqual(smoke.launchArgs({ profile: '/tmp/p', positional: 'file:///tmp/b.cad' }), ['--user-data-dir=/tmp/p', 'file:///tmp/b.cad']);
  assert.deepEqual(smoke.launchArgs({}), []);
  assert.equal(smoke.fileUri('/tmp/x y/Board#1.cad'), 'file:///tmp/x%20y/Board%231.cad');
  assert.throws(() => smoke.launchArgs({ positional: '--no-sandbox' }), /never switches the sandbox off/);
  for (const bad of ['--no-sandbox', '--no-sandbox=1', '--disable-setuid-sandbox', '--disable-namespace-sandbox', '--disable-seccomp-filter-sandbox', '--no-zygote-sandbox']) {
    assert.throws(() => smoke.assertSandboxKept(['--board=/x.cad', bad]), /never switches the sandbox off/, bad);
  }
  assert.doesNotThrow(() => smoke.assertSandboxKept(['--user-data-dir=/tmp/no-sandbox-dir', '--board=/tmp/no-sandbox.cad']), 'a path that merely contains the words is fine');
  const script = smoke.wrapperScript({ target: "/opt/TRACE Boardviewer/trace-boardviewer", stderrFile: "/tmp/it's/log.txt" });
  assert.ok(script.startsWith('#!/bin/bash\n'));
  assert.ok(script.includes(`exec '/opt/TRACE Boardviewer/trace-boardviewer' "$@" 2> >(exec tee -a -- '/tmp/it'\\''s/log.txt' >&2)`));
  assert.doesNotMatch(script, /sandbox/, 'the launcher adds no switch');
  assert.equal(smoke.shQuote("a'b"), "'a'\\''b'");
  const base = { PATH: '/usr/bin:/bin', HOME: '/home/u', XDG_CONFIG_HOME: '/home/u/.config', ELECTRON_RUN_AS_NODE: '1', TRACE_ACCEPT_NO_SANDBOX: '1', CHROME_DESKTOP: 'other.desktop', APPIMAGE_EXTRACT_AND_RUN: '1', KEEP: 'yes' };
  const env = smoke.launchEnvironment(base, { stubBin: '/tmp/r/bin', xdgRecord: '/tmp/r/logs/xdg-open.txt' });
  assert.equal(env.PATH, '/tmp/r/bin:/usr/bin:/bin', 'the stand-in xdg-open comes first');
  assert.equal(env.TRACE_SMOKE_XDG_RECORD, '/tmp/r/logs/xdg-open.txt');
  for (const name of ['ELECTRON_RUN_AS_NODE', 'TRACE_ACCEPT_NO_SANDBOX', 'CHROME_DESKTOP', 'APPIMAGE_EXTRACT_AND_RUN']) assert.ok(!(name in env), `${name} is not inherited`);
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.KEEP, 'yes');
  assert.equal(env.XDG_CONFIG_HOME, '/home/u/.config', 'kept unless the launch tests the default location');
  const accepted = smoke.launchEnvironment(base, { stubBin: '/b', xdgRecord: '/r', home: '/tmp/r/home', acceptNoSandbox: true, appimageExtractAndRun: true });
  assert.deepEqual([accepted.HOME, accepted.XDG_CONFIG_HOME, accepted.TRACE_ACCEPT_NO_SANDBOX, accepted.APPIMAGE_EXTRACT_AND_RUN], ['/tmp/r/home', undefined, '1', '1'], 'the default location: HOME set, XDG_CONFIG_HOME unset');
  const changes = smoke.environmentChanges(base, env);
  assert.deepEqual(changes.unset, ['APPIMAGE_EXTRACT_AND_RUN', 'CHROME_DESKTOP', 'ELECTRON_RUN_AS_NODE', 'TRACE_ACCEPT_NO_SANDBOX']);
  assert.equal(changes.set.PATH, '/tmp/r/bin:<inherited PATH>', 'the inherited PATH is not copied into the evidence');
  assert.ok(!('KEEP' in changes.set));
});

test('simulated: the launch plan answers the consent dialog in its own profiles and runs the flow without depending on it', () => {
  const withGate = smoke.launchSpecs({ expectGate: 'yes' });
  assert.deepEqual(withGate.map((spec) => [spec.label, spec.profile, spec.board, spec.positional, spec.cwd, spec.gate, spec.acceptNoSandbox, spec.spawnOnly]), [
    ['gate-quit', 'gate-quit', 'first', null, null, 'quit', false, false],
    ['gate-start', 'gate', 'first', null, null, 'start-remember', false, false],
    ['gate-remembered', 'gate', null, null, null, 'absent', false, false],
    ['launch-1', 'main', 'first', null, null, 'absent', true, false],
    ['launch-2', 'main', null, null, null, 'absent', true, false],
    ['second-instance-uri', 'main', null, 'second-uri', 'root', 'absent', true, true],
    ['second-instance-relative', 'main', null, 'first-relative', 'project', 'absent', true, true],
    ['default-location', null, null, null, null, 'absent', true, false],
  ]);
  assert.deepEqual(withGate.filter((spec) => spec.home).map((spec) => spec.label), ['default-location']);
  const without = smoke.launchSpecs({ expectGate: 'no' });
  assert.deepEqual(without.map((spec) => spec.label), ['launch-1', 'launch-2', 'second-instance-uri', 'second-instance-relative', 'default-location']);
  assert.ok(without.every((spec) => spec.gate === 'absent' && spec.acceptNoSandbox === false), 'with the sandbox on nothing is pre-accepted');
  const dirs = smoke.runDirectories('/tmp/r');
  assert.equal(dirs.board, '/tmp/r/project/LinuxSmoke.cad');
  assert.equal(dirs.secondBoard, '/tmp/r/project/LinuxSmokeTwo.cad');
  assert.equal(new Set([dirs.profile, dirs.gateProfile, dirs.gateQuitProfile]).size, 3, 'the dialog launches use profiles of their own');
  const resolved = withGate.map((spec) => smoke.resolveSpec(spec, dirs));
  assert.deepEqual(resolved[0], { profile: '/tmp/r/profile-gate-quit', args: ['--user-data-dir=/tmp/r/profile-gate-quit', '--board=/tmp/r/project/LinuxSmoke.cad'], cwd: null });
  assert.deepEqual(resolved[5], { profile: '/tmp/r/profile', args: ['--user-data-dir=/tmp/r/profile', 'file:///tmp/r/project/LinuxSmokeTwo.cad'], cwd: '/tmp/r' });
  assert.deepEqual(resolved[6], { profile: '/tmp/r/profile', args: ['--user-data-dir=/tmp/r/profile', 'LinuxSmoke.cad'], cwd: '/tmp/r/project' });
  assert.deepEqual(resolved[7], { profile: null, args: [], cwd: null });
});

test('simulated: consent dialog decisions', () => {
  const shown = { shown: true, browserWindows: 0, noSandboxSwitch: true, warningLogged: true };
  assert.deepEqual(smoke.decideGate('quit', { gate: shown, windowShown: false, exit: { code: 0, signal: null, timedOut: false }, answerStored: false }), []);
  assert.deepEqual(smoke.decideGate('quit', { gate: shown, windowShown: false, exit: { code: 0, signal: null, timedOut: false }, answerStored: null }), [], 'no config.json at all is fine');
  assert.ok(smoke.decideGate('quit', { gate: shown, windowShown: true, exit: { code: 0, signal: null, timedOut: false }, answerStored: false }).some((p) => /window opened after Quit/.test(p)));
  assert.ok(smoke.decideGate('quit', { gate: shown, windowShown: false, exit: { code: null, signal: 'SIGKILL', timedOut: true }, answerStored: false }).some((p) => /exit code 0/.test(p)));
  assert.ok(smoke.decideGate('quit', { gate: shown, windowShown: false, exit: { code: 0 }, answerStored: true }).some((p) => /Quit stored noSandboxAccepted/.test(p)));
  assert.ok(smoke.decideGate('quit', { gate: { ...shown, browserWindows: 1 }, windowShown: false, exit: { code: 0 } }).some((p) => /must come first/.test(p)));
  assert.ok(smoke.decideGate('quit', { gate: { ...shown, noSandboxSwitch: false }, windowShown: false, exit: { code: 0 } }).some((p) => /sandbox-off switch/.test(p)));
  assert.ok(smoke.decideGate('quit', { gate: { ...shown, warningLogged: false }, windowShown: false, exit: { code: 0 } }).some((p) => /warning line/.test(p)));
  assert.ok(smoke.decideGate('quit', { gate: { shown: false }, windowShown: false, exit: { code: 0 } }).some((p) => /did not appear/.test(p)));
  assert.deepEqual(smoke.decideGate('start-remember', { gate: shown, windowShown: true, answerStored: true }), []);
  assert.ok(smoke.decideGate('start-remember', { gate: shown, windowShown: true, answerStored: false }).some((p) => /did not store noSandboxAccepted: true in config\.json/.test(p)));
  assert.ok(smoke.decideGate('start-remember', { gate: shown, windowShown: false, answerStored: true }).some((p) => /no window/.test(p)));
  assert.deepEqual(smoke.decideGate('absent', { gate: { shown: false }, windowShown: true }), []);
  assert.ok(smoke.decideGate('absent', { gate: shown, windowShown: true }).some((p) => /none was expected/.test(p)));
  assert.ok(smoke.decideGate('absent', { gate: null, windowShown: false }).some((p) => /no window/.test(p)));
});

test('simulated: /proc facts, sandbox classification and the scenario environment', () => {
  const browserText = 'Name:\ttrace-boardvie\nUmask:\t0022\nState:\tS (sleeping)\nPid:\t4100\nNSpid:\t4100\nSeccomp:\t0\nSeccomp_filters:\t0\n';
  const sandboxed = 'Name:\ttrace-boardvie\nPid:\t4200\nNSpid:\t4200\t5\nSeccomp:\t2\nSeccomp_filters:\t3\n';
  const open = 'Name:\ttrace-boardvie\nPid:\t4300\nNSpid:\t4300\nSeccomp:\t0\n';
  const browser = smoke.parseProcStatus(browserText);
  assert.deepEqual(browser, { name: 'trace-boardvie', pid: 4100, seccomp: 0, seccompFilters: 0, nspid: [4100] });
  const renderer = smoke.parseProcStatus(sandboxed);
  assert.deepEqual([renderer.seccomp, renderer.seccompFilters, renderer.nspid], [2, 3, [4200, 5]]);
  assert.deepEqual(smoke.parseProcStatus(''), { name: null, pid: null, seccomp: null, seccompFilters: null, nspid: [] });
  const off = smoke.parseProcStatus(open);
  assert.equal(smoke.classifySandbox({ browser, renderers: [renderer, renderer], noSandboxSwitch: false }), 'on');
  assert.equal(smoke.classifySandbox({ browser, renderers: [renderer], noSandboxSwitch: true }), 'mixed', 'a switch contradicting the facts is never "on"');
  assert.equal(smoke.classifySandbox({ browser, renderers: [off], noSandboxSwitch: true }), 'off');
  assert.equal(smoke.classifySandbox({ browser, renderers: [off, renderer], noSandboxSwitch: false }), 'mixed');
  assert.equal(smoke.classifySandbox({ browser, renderers: [{ seccomp: 2, nspid: [4400] }], noSandboxSwitch: false }), 'mixed', 'a filter without a nested PID namespace is not the full sandbox');
  assert.equal(smoke.classifySandbox({ browser, renderers: [], noSandboxSwitch: false }), 'unknown');
  assert.equal(smoke.classifySandbox({ browser: { nspid: [] }, renderers: [renderer] }), 'unknown');
  assert.equal(smoke.classifySandbox({ browser, renderers: [{ seccomp: null, nspid: [1, 2] }] }), 'unknown');
  // A runner inside a container already has a nested namespace: the comparison is relative to the browser.
  assert.equal(smoke.classifySandbox({ browser: { nspid: [9, 1] }, renderers: [{ seccomp: 2, nspid: [10, 2, 3] }], noSandboxSwitch: false }), 'on');
  assert.deepEqual(smoke.decideSandbox({ expectSandbox: 'on', classification: 'on', target: 'installed', browserLabel: 'trace-boardviewer (unconfined)' }), []);
  assert.ok(smoke.decideSandbox({ expectSandbox: 'on', classification: 'on', target: 'installed', browserLabel: 'unconfined' }).some((p) => /AppArmor label/.test(p)));
  assert.deepEqual(smoke.decideSandbox({ expectSandbox: 'off', classification: 'off', target: 'appimage', browserLabel: 'unconfined' }), []);
  assert.ok(smoke.decideSandbox({ expectSandbox: 'on', classification: 'mixed', target: 'unpacked', browserLabel: null }).length === 1);
  assert.deepEqual(smoke.decideUserns({ expected: 'restricted', sysctl: 1, unshareOk: false }), []);
  assert.deepEqual(smoke.decideUserns({ expected: 'allowed', sysctl: 0, unshareOk: true }), []);
  assert.deepEqual(smoke.decideUserns({ expected: 'allowed', sysctl: null, unshareOk: true }), [], 'a kernel without the knob does not restrict');
  assert.equal(smoke.decideUserns({ expected: 'restricted', sysctl: 0, unshareOk: true }).length, 2);
  assert.equal(smoke.decideUserns({ expected: 'allowed', sysctl: 1, unshareOk: false }).length, 2);
  assert.deepEqual(smoke.decideDefaultProfile({ home: '/tmp/r/home', userData: '/tmp/r/home/.config/trace-boardviewer' }), { ok: true, expected: '/tmp/r/home/.config/trace-boardviewer', relative: '$HOME/.config/trace-boardviewer' });
  assert.equal(smoke.decideDefaultProfile({ home: '/tmp/r/home', userData: '/tmp/r/home/.config/TRACE Boardviewer' }).ok, false);
  assert.equal(smoke.decideDefaultProfile({ home: '/tmp/r/home', userData: '/root/.config/trace-boardviewer' }).relative, '/root/.config/trace-boardviewer');
});

test('simulated: desktop entries, .deb control fields, file list, AppArmor profile, maintainer scripts and the AppImage launcher', () => {
  const appimageEntry = ['[Desktop Entry]', 'Name=TRACE Boardviewer', 'Exec=AppRun %U', 'Terminal=false', 'Type=Application', 'Icon=trace-boardviewer', 'StartupWMClass=trace-boardviewer',
    'X-AppImage-Version=1.2.0', 'GenericName=Boardviewer', 'Keywords=boardview;', 'Comment=Free, offline boardviewer', 'Categories=Development;Electronics;', ''].join('\n');
  assert.deepEqual(smoke.checkDesktopEntry(smoke.parseDesktopEntry(appimageEntry), { kind: 'appimage', version: '1.2.0' }), []);
  assert.ok(smoke.checkDesktopEntry(smoke.parseDesktopEntry(appimageEntry), { kind: 'appimage', version: '1.3.0' }).some((p) => /X-AppImage-Version/.test(p)));
  const switched = appimageEntry.replace('Exec=AppRun %U', `Exec=AppRun --no-${'sandbox'} %U`);
  assert.ok(smoke.checkDesktopEntry(smoke.parseDesktopEntry(switched), { kind: 'appimage', version: '1.2.0' }).some((p) => /sandbox switch/.test(p)));
  assert.ok(smoke.checkDesktopEntry(smoke.parseDesktopEntry(`${appimageEntry}MimeType=application/x-board;\n`), { kind: 'appimage', version: '1.2.0' }).some((p) => /MimeType/.test(p)));
  assert.ok(smoke.checkDesktopEntry(smoke.parseDesktopEntry(appimageEntry.replace('StartupWMClass=trace-boardviewer', 'StartupWMClass=TRACE Boardviewer')), { kind: 'appimage', version: '1.2.0' }).length > 0);
  assert.ok(smoke.checkDesktopEntry(smoke.parseDesktopEntry(`${appimageEntry}Name=Other\n`), { kind: 'appimage', version: '1.2.0' }).some((p) => /duplicate/.test(p)));
  assert.deepEqual(smoke.checkDesktopEntry(smoke.parseDesktopEntry(''), { kind: 'deb' }), ['no [Desktop Entry] group']);
  const debEntry = appimageEntry.replace('Exec=AppRun %U', 'Exec="/opt/TRACE Boardviewer/trace-boardviewer" %U').replace('X-AppImage-Version=1.2.0\n', '');
  assert.deepEqual(smoke.checkDesktopEntry(smoke.parseDesktopEntry(debEntry), { kind: 'deb' }), []);
  assert.ok(smoke.checkDesktopEntry(smoke.parseDesktopEntry(appimageEntry), { kind: 'deb' }).length >= 2, 'an AppImage entry is not a .deb entry');
  assert.equal(smoke.parseDesktopEntry('[Desktop Entry]\nName=A=B\n# c\n[Desktop Action x]\nName=X\n').entry.Name, 'A=B');

  const control = ['Package: trace-boardviewer', 'Version: 1.2.0', 'License: MIT', 'Vendor: TRACE Boardviewer', 'Architecture: amd64', 'Maintainer: TRACE Boardviewer <noreply@trace-boardviewer.invalid>',
    'Installed-Size: 360000', 'Depends: libgtk-3-0, libnotify4', 'Section: electronics', 'Priority: optional', 'Homepage: https://github.com/trace-boardviewer/trace-boardviewer',
    'Description: Offline boardviewer for electronics repair', ' Free, offline boardviewer for electronics repair.', ''].join('\n');
  const fields = smoke.parseDebFields(control);
  assert.equal(fields.Description, 'Offline boardviewer for electronics repair\nFree, offline boardviewer for electronics repair.');
  const homepage = 'https://github.com/trace-boardviewer/trace-boardviewer';
  assert.deepEqual(smoke.checkDebFields(fields, { arch: 'x64', version: '1.2.0', homepage }), []);
  assert.ok(smoke.checkDebFields(fields, { arch: 'arm64', version: '1.2.0', homepage }).some((p) => /Architecture/.test(p)));
  assert.ok(smoke.checkDebFields({ ...fields, Version: '1.3.0~rc.1' }, { arch: 'x64', version: '1.3.0-rc.1', homepage }).length === 0, 'a prerelease suffix is written with ~ in a .deb');
  const leaked = smoke.parseDebFields(control.replace('Vendor: TRACE Boardviewer', `Vendor: someone@${'example'}.org`));
  assert.ok(smoke.checkDebFields(leaked, { arch: 'x64', version: '1.2.0', homepage }).some((p) => /addresses other than/.test(p)));
  assert.ok(smoke.checkDebFields(smoke.parseDebFields(control.replace('License: MIT', 'License: /home/runner/work/x')), { arch: 'x64', version: '1.2.0', homepage }).some((p) => /build-machine path/.test(p)));

  const listing = [
    'drwxr-xr-x 0/0               0 2026-10-06 12:00 ./',
    'drwxr-xr-x 0/0               0 2026-10-06 12:00 ./opt/TRACE Boardviewer/',
    '-rwxr-xr-x 0/0       228629832 2026-10-06 12:00 ./opt/TRACE Boardviewer/trace-boardviewer',
    '-rwxr-xr-x 0/0           15232 2026-10-06 12:00 ./opt/TRACE Boardviewer/chrome-sandbox',
    '-rw-r--r-- 0/0        76500000 2026-10-06 12:00 ./opt/TRACE Boardviewer/resources/app.asar',
    '-rw-r--r-- 0/0             250 2026-10-06 12:00 ./opt/TRACE Boardviewer/resources/apparmor-profile',
    '-rw-r--r-- 0/0             400 2026-10-06 12:00 ./usr/share/applications/trace-boardviewer.desktop',
    '-rw-r--r-- 0/0             855 2026-10-06 12:00 ./usr/share/icons/hicolor/scalable/apps/trace-boardviewer.svg',
    'lrwxrwxrwx 0/0               0 2026-10-06 12:00 ./usr/bin/x -> /opt/TRACE Boardviewer/trace-boardviewer',
  ].join('\n');
  const paths = smoke.parseDebListing(listing);
  assert.ok(paths.includes('/opt/TRACE Boardviewer/trace-boardviewer') && paths.includes('/usr/bin/x') && !paths.includes('/'));
  assert.deepEqual(smoke.checkDebListing(paths), []);
  assert.ok(smoke.checkDebListing(paths.filter((entry) => !entry.endsWith('.svg'))).some((p) => /scalable/.test(p)));
  assert.ok(smoke.checkDebListing([...paths, '/opt/TRACE Boardviewer/resources/app.asar.unpacked/x.node']).some((p) => /unexpected/.test(p)));
  assert.equal(smoke.ICON_PATH, 'usr/share/icons/hicolor/scalable/apps/trace-boardviewer.svg');

  const profile = 'abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile "trace-boardviewer" "/opt/TRACE Boardviewer/trace-boardviewer" flags=(unconfined) {\n  userns,\n\n  include if exists <local/trace-boardviewer>\n}';
  assert.deepEqual(smoke.checkAppArmorProfile(profile), []);
  assert.ok(smoke.checkAppArmorProfile(profile.replace('  userns,\n', '')).some((p) => /userns/.test(p)));
  assert.ok(smoke.checkAppArmorProfile(profile.replace('flags=(unconfined) ', '')).length > 0);
  const installedOn = (body) => smoke.checkPostinst(body);
  const postinst = "if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then\n    chmod 4755 '/opt/TRACE Boardviewer/chrome-sandbox' || true\nelse\n    chmod 0755 '/opt/TRACE Boardviewer/chrome-sandbox' || true\nfi\n  if apparmor_parser --skip-kernel-load --debug \"$APPARMOR_PROFILE_SOURCE\" > /dev/null 2>&1; then\n      apparmor_parser --replace --write-cache --skip-read-cache \"$APPARMOR_PROFILE_TARGET\"\n";
  assert.deepEqual(installedOn(postinst), []);
  assert.ok(installedOn(postinst.replace('unshare --user true', 'true')).length === 1);

  // The pinned builder's own AppRun is the reference (the same file tests/linux-config-checks.cjs pins).
  const builderManifest = require.resolve('electron-builder/package.json', { paths: [ROOT] });
  const libDirectory = path.dirname(require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builderManifest)] }));
  const { generateAppRunScript } = require(path.join(libDirectory, 'out', 'targets', 'appimage', 'appImageUtil.js'));
  const appRun = generateAppRunScript({ DesktopFileName: 'trace-boardviewer.desktop', ExecutableName: 'trace-boardviewer', ProductName: 'TRACE Boardviewer', ProductFilename: 'TRACE Boardviewer', ResourceName: 'appimagekit-trace-boardviewer' });
  assert.deepEqual(smoke.checkAppRun(appRun), [], 'the pinned builder AppRun passes');
  assert.ok(smoke.checkAppRun(appRun.replace('exec "$BIN" "${NO_SANDBOX[@]}" "${args[@]}"', `exec "$BIN" --no-${'sandbox'} "\${args[@]}"`)).length > 0, 'an unconditional switch fails');
  assert.ok(smoke.checkAppRun(appRun.replace('! unshare -Ur true', '! true')).length > 0);
});

test('simulated: ELF header, PNG size, X11 tool output and fuse wire parsing', () => {
  const elf = Buffer.alloc(64);
  elf.write('\x7fELF', 0, 'latin1');
  elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(0x3e, 18);
  assert.deepEqual(smoke.elfMachine(elf), { elf: true, bits: 64, littleEndian: true, machine: 0x3e });
  elf.writeUInt16LE(0xb7, 18);
  assert.equal(smoke.elfMachine(elf).machine, smoke.ARCHES.arm64.elfMachine);
  assert.equal(smoke.elfMachine(Buffer.from('MZ\x90\x00')).elf, false, 'a PE file is not an ELF');
  assert.equal(smoke.elfMachine(null).elf, false);
  assert.deepEqual(smoke.pngSize(macSmoke.makePng()), { width: 16, height: 16 });
  assert.equal(smoke.pngSize(Buffer.from('nope')), null);

  assert.deepEqual(smoke.parseXpropWmClass('WM_CLASS(STRING) = "trace-boardviewer", "trace-boardviewer"\n'), ['trace-boardviewer', 'trace-boardviewer']);
  assert.deepEqual(smoke.parseXpropWmClass('WM_CLASS(STRING) = "trace boardviewer", "TRACE Boardviewer"'), ['trace boardviewer', 'TRACE Boardviewer']);
  assert.equal(smoke.parseXpropWmClass('WM_CLASS:  not found.'), null);
  const props = 'WM_CLASS(STRING) = "trace-boardviewer", "trace-boardviewer"\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DIALOG\nWM_NAME(STRING) = "TRACE Boardviewer"\n_NET_WM_NAME(UTF8_STRING) = "TRACE Boardviewer"\n';
  assert.equal(smoke.parseXpropAtom(props, '_NET_WM_WINDOW_TYPE'), '_NET_WM_WINDOW_TYPE_DIALOG');
  assert.equal(smoke.parseXpropString(props, '_NET_WM_NAME'), 'TRACE Boardviewer');
  assert.equal(smoke.parseXpropString(props, 'WM_ICON_NAME'), null);

  const pixels = (count) => Array.from({ length: count }, () => '4278190080').join(', ');
  assert.deepEqual(smoke.parseNetWmIconSize(`_NET_WM_ICON(CARDINAL) = 2, 2, ${pixels(4)}, 1, 1, ${pixels(1)}`), { sizes: [{ width: 2, height: 2 }, { width: 1, height: 1 }], truncated: false, found: true });
  assert.deepEqual(smoke.parseNetWmIconSize('_NET_WM_ICON(CARDINAL) = \tIcon (256 x 256):\n\t(ascii art)\n\tIcon (16 x 16):\n'), { sizes: [{ width: 256, height: 256 }, { width: 16, height: 16 }], truncated: false, found: true });
  assert.equal(smoke.parseNetWmIconSize('_NET_WM_ICON:  not found.').found, false);
  assert.equal(smoke.parseNetWmIconSize('_NET_WM_ICON(CARDINAL) = \n').found, false);
  assert.equal(smoke.parseNetWmIconSize(`_NET_WM_ICON(CARDINAL) = 4, 4, ${pixels(3)}`).truncated, true);

  const info = 'xwininfo: Window id: 0x1a00003 "TRACE Boardviewer"\n\n  Absolute upper-left X:  580\n  Absolute upper-left Y:  420\n  Relative upper-left X:  0\n  Width: 440\n  Height: 160\n  Map State: IsViewable\n';
  assert.deepEqual(smoke.parseXwininfo(info), { id: 0x1a00003, x: 580, y: 420, width: 440, height: 160, mapState: 'IsViewable' });
  const tree = ['xwininfo: Window id: 0x3c3 (the root window) (has no name)', '', '  Root window id: 0x3c3 (the root window) (has no name)', '  2 children:',
    '     0x1a00003 "LinuxSmoke — TRACE": ("trace-boardviewer" "trace-boardviewer")  1440x940+80+30  +80+30', '     0x1a00001 (has no name): ()  1x1+-1+-1  +-1+-1'].join('\n');
  const windows = smoke.parseXwininfoTree(tree);
  assert.deepEqual(windows[0], { id: 0x1a00003, name: 'LinuxSmoke — TRACE', instance: 'trace-boardviewer', class: 'trace-boardviewer', width: 1440, height: 940 });
  assert.equal(windows[1].name, null);
  assert.deepEqual(smoke.parseXdotoolIds('27262979\n27262981\n\n'), [27262979, 27262981]);
  assert.deepEqual(smoke.parseXdotoolIds(''), []);
  assert.deepEqual(smoke.parseKeyValueLines('argc=1\nurl=https://x/?a=b\n'), { argc: '1', url: 'https://x/?a=b' });

  const configured = { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: true, onlyLoadAppFromAsar: true, enableEmbeddedAsarIntegrityValidation: true, enableCookieEncryption: true, grantFileProtocolExtraPrivileges: true };
  const expected = smoke.expectedFuseWire(configured);
  assert.deepEqual(expected.unknown, []);
  assert.equal(expected.wire.RunAsNode, 'DISABLE');
  assert.equal(expected.wire.EnableNodeCliInspectArguments, 'ENABLE');
  const observed = smoke.describeFuseWire({ version: '1', 0: 48, 1: 49, 2: 48, 3: 49, 4: 49, 5: 49, 6: 48, 7: 49, 8: 49 });
  assert.equal(observed.fuse8, 'ENABLE', 'a fuse newer than @electron/fuses is kept under its index');
  assert.deepEqual(smoke.compareFuseWire(observed, expected.wire), []);
  assert.deepEqual(smoke.compareFuseWire({ ...observed, RunAsNode: 'ENABLE' }, expected.wire), ['RunAsNode is ENABLE, expected DISABLE']);
  assert.deepEqual(smoke.expectedFuseWire({ ...configured, resetAdHocDarwinSignature: true }).unknown, ['resetAdHocDarwinSignature'], 'an unknown key is reported, never ignored');
  assert.deepEqual(smoke.expectedFuseWire(JSON.parse(fs.readFileSync(rel('package.json'), 'utf8')).build.electronFuses).unknown, [], 'every fuse of the build block maps onto @electron/fuses 1.8.0');
});

test('simulated: evidence, summary and the honest list of what is not covered', () => {
  const pass = { name: 'a', status: 'pass' };
  const run = smoke.buildEvidence({ kind: 'run', scenario: 'S2', target: 'appimage', arch: 'x64', userns: { expected: 'restricted', sysctl: 1, unshare: false }, expectSandbox: 'off', expectGate: 'yes',
    sandbox: { classification: 'off' }, defaultProfile: { ok: true, relative: '$HOME/.config/trace-boardviewer' },
    gate: [{ label: 'gate-quit', shown: true, answer: 'Quit (Escape)' }, { label: 'launch-1', shown: true, answer: 'Start without sandbox + Do not ask again' }, { label: 'launch-2', shown: false }],
    checks: [pass], observations: ['note'] });
  assert.equal(run.schema, 'trace-linux-smoke-evidence/1');
  assert.equal(run.passed, true);
  assert.match(run.disclaimer, /Not a release acceptance/);
  assert.equal(run.commit, 'unknown', 'a missing commit is never invented');
  const failed = smoke.buildEvidence({ kind: 'run', scenario: 'S1', target: 'installed', expectSandbox: 'on', expectGate: 'no', checks: [pass, { name: 'b', status: 'fail', detail: 'x | y' }, { name: 'c', status: 'skipped' }] });
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.failedChecks, ['b']);
  assert.equal(smoke.buildEvidence({ kind: 'run', checks: [] }).passed, false, 'no checks is not a pass');
  const staticEvidence = smoke.buildEvidence({ kind: 'static', checks: [pass] });
  assert.equal(staticEvidence.scenario, 'S0');
  const summary = smoke.formatSummary([failed, run, staticEvidence, { schema: 'other' }]);
  const rows = summary.split('\n').filter((line) => /^\| S\d/.test(line));
  assert.deepEqual(rows.map((line) => line.split('|')[1].trim()), ['S0', 'S1', 'S2'], 'one row per evidence file, in scenario order');
  assert.match(rows[2], /off \/ off/);
  assert.match(rows[2], /shown 2x of 3 launches \(Quit \(Escape\); Start without sandbox \+ Do not ask again\)/);
  assert.match(rows[2], /\$HOME\/\.config\/trace-boardviewer/);
  assert.match(rows[1], /FAILED \(1 failed, 1 skipped\)/);
  assert.match(summary, /- S1: b: x \\\| y/, 'cells and lines are escaped for Markdown');
  assert.match(summary, /Observations \(informational\)/);
  assert.match(summary, /Not covered: /);
  assert.match(smoke.formatSummary([]), /No Linux smoke evidence was written/);
  assert.ok(smoke.NOT_COVERED.length >= 8);
  for (const needle of [/Wayland/, /GNOME/, /file chooser/, /arm64/, /HiDPI/, /upgrade/]) assert.ok(smoke.NOT_COVERED.some((item) => needle.test(item)), String(needle));
});

test('simulated: the synthetic fixtures are original, consistent and distinct', () => {
  assert.notEqual(smoke.SECOND_FIXTURE_BOARD, smoke.FIXTURE_BOARD, 'the second instance opens a different board');
  const count = (text, pattern) => text.trim().split('\n').filter((line) => pattern.test(line)).length;
  for (const board of [smoke.FIXTURE_BOARD, smoke.SECOND_FIXTURE_BOARD]) {
    assert.equal(count(board, /^COMPONENT /), smoke.EXPECTED_COUNTS.components);
    assert.equal(count(board, /^SIGNAL /), smoke.EXPECTED_COUNTS.nets);
  }
  assert.ok(smoke.SECOND_FIXTURE_NAME.startsWith(smoke.FIXTURE_NAME.replace(/\.cad$/, '')), 'the forwarded board is recognisable by its project name');
  assert.ok(smoke.DOCUMENT_NAMES.every((name) => /^linuxsmoke\.(pdf|png)$/.test(name)));
  assert.match(smoke.XDG_OPEN_STUB, /^#!\/bin\/sh\n/);
  assert.match(smoke.XDG_OPEN_STUB, /TRACE_SMOKE_XDG_RECORD/);
  assert.doesNotMatch(smoke.XDG_OPEN_STUB, /xdg-open "|exec /, 'the stand-in opens nothing');
});

// ---- contracts with the sibling files (checked once they exist on the branch) -------------------------------

test('contract: the names the smoke script expects are the names config/electron-builder.linux.yml produces', { skip: !fs.existsSync(LINUX_CONFIG_PATH) && 'config/electron-builder.linux.yml is not on this branch yet' }, () => {
  const config = yaml.load(fs.readFileSync(LINUX_CONFIG_PATH, 'utf8'));
  const repository = JSON.parse(fs.readFileSync(rel('electron', 'repository.json'), 'utf8')).repository;
  assert.equal(config.productName, smoke.PRODUCT_NAME);
  assert.equal(config.linux.executableName, smoke.EXECUTABLE_NAME);
  assert.equal(config.extraMetadata.desktopName, smoke.DESKTOP_FILE);
  assert.equal(config.extraMetadata.homepage, `https://github.com/${repository}`);
  assert.equal(config.linux.maintainer, smoke.MAINTAINER);
  assert.equal(config.linux.category, smoke.CATEGORIES);
  assert.equal(config.directories.output, 'release-linux', 'the locate step reads release-linux/');
  assert.deepEqual(config.linux.target, ['AppImage', 'deb']);
  assert.equal(config.linux.artifactName, 'TRACE-Boardviewer-${version}-linux-${arch}.${ext}', 'the locate step and artifactFileName build these names');
  assert.match(config.linux.icon, /\.svg$/, 'the static checks look for the scalable SVG icon');
  assert.equal(JSON.parse(fs.readFileSync(rel('package.json'), 'utf8')).name, smoke.DEB_PACKAGE, 'the .deb package name is package.json "name"');
  assert.deepEqual(smoke.expectedFuseWire(config.electronFuses).unknown, []);
});

test('contract: the consent gate the smoke script drives is the one electron/main.cjs implements', { skip: !/confirmUnsandboxedStart/.test(fs.readFileSync(MAIN_PATH, 'utf8')) && 'the Linux consent gate is not in electron/main.cjs on this branch yet' }, () => {
  const main = fs.readFileSync(MAIN_PATH, 'utf8');
  const english = Object.assign({}, ...fs.readdirSync(LOCALE_EN_DIRECTORY).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(fs.readFileSync(path.join(LOCALE_EN_DIRECTORY, name), 'utf8'))));
  assert.ok(main.includes(`'${smoke.GATE.stderrLine}'`), 'the exact warning line');
  assert.match(main, new RegExp(`process\\.env\\.${smoke.GATE.acceptEnv}\\b`), 'the environment bypass is read from the environment');
  assert.match(main, /acceptEnvironment === '1'/, 'only the value 1 accepts');
  assert.match(main, new RegExp(`${smoke.GATE.acceptedKey} === true`), 'the stored answer is the noSandboxAccepted key, only a stored true counts');
  assert.match(main, new RegExp(`\\{ \\.\\.\\.current, ${smoke.GATE.acceptedKey}: true \\}`), '"Do not ask again" writes noSandboxAccepted: true into the config');
  const body = main.slice(main.indexOf('async function confirmUnsandboxedStart('));
  assert.match(body, /app\.commandLine\.hasSwitch\('no-sandbox'\)/, 'the same switch the smoke reads');
  assert.ok(body.indexOf('console.warn(NO_SANDBOX_WARNING)') > 0 && body.indexOf('console.warn(NO_SANDBOX_WARNING)') < body.indexOf("if (decision === 'accepted') return true;"),
    'the warning line is written before the bypass returns: the smoke expects it in every unsandboxed launch');
  assert.match(body, /title: app\.name/, 'the smoke finds the dialog by the product name');
  assert.match(body, /defaultId: 0, cancelId: 0/, 'Escape answers Quit');
  assert.match(body, /buttons: \[t\('native\.dialog\.noSandboxQuit'\), t\('native\.dialog\.noSandboxStart'\)\]/, 'Quit left, Start right: the smoke clicks the right-hand button to start');
  assert.match(body, /checkboxLabel: t\('native\.dialog\.noSandboxRemember'\), checkboxChecked: false/);
  assert.match(body, /if \(answer\?\.response !== 1\) return false;/, 'anything but Start quits');
  assert.deepEqual([english['native.dialog.noSandboxQuit'], english['native.dialog.noSandboxStart']], [...smoke.GATE.buttons]);
  assert.equal(english['native.dialog.noSandboxRemember'], smoke.GATE.checkbox);
  assert.match(main, /if \(!\(await confirmUnsandboxedStart\(\)\)\) \{ app\.quit\(\); return; \}/, 'Quit ends the start-up before any window');
});
