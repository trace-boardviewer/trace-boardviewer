'use strict';

// STATIC / SIMULATED checks for the macOS packaging baseline. This is NOT macOS runtime acceptance: it never
// launches the app, never builds a macOS bundle and says nothing about how the product behaves on a Mac.
// It parses config/electron-builder.mac.yml with the pinned electron-builder's own YAML loader and schema,
// checks it against the "build" block of package.json (the Mac file is a copy, see its header), checks the
// mac job and the draft-release job of the release workflow, and exercises the pure decision logic of
// scripts/mac-smoke.cjs. It runs on Linux, Windows and macOS:
//
//   node --test tests/mac-config-checks.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const rel = (...parts) => path.join(ROOT, ...parts);
const read = (...parts) => fs.readFileSync(rel(...parts), 'utf8');
const smoke = require('../scripts/mac-smoke.cjs');

const CONFIG_FILE = 'config/electron-builder.mac.yml';
const WORKFLOW_FILE = '.github/workflows/windows.yml';
const DOC_FILE = 'docs/MAC_VALIDATION.md';
const SMOKE_FILE = 'scripts/mac-smoke.cjs';
const SELF_FILE = 'tests/mac-config-checks.cjs';
// The only negation the Mac "files" list may add to the package.json list; see the header of the config file.
const ALLOWED_NEGATIONS = ['!node_modules/@napi-rs/**'];

// The pinned electron-builder resolves its own YAML parser and schema validator; nothing is added to the project.
function builderTools() {
  const builderManifest = require.resolve('electron-builder/package.json', { paths: [ROOT] });
  const libManifest = require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builderManifest)] });
  const libDirectory = path.dirname(libManifest);
  return {
    directory: libDirectory,
    version: JSON.parse(fs.readFileSync(libManifest, 'utf8')).version,
    yaml: require(require.resolve('js-yaml', { paths: [libDirectory] })),
    validateConfiguration: require(path.join(libDirectory, 'out', 'util', 'config', 'config.js')).validateConfiguration,
  };
}
const tools = builderTools();
const parseYaml = (text) => tools.yaml.load(text);
// The three inputs below can be pointed at COPIES (mutation checks of the assertions): the real package.json
// belongs to another lane and is never edited, not even temporarily.
const CONFIG_PATH = process.env.TRACE_MAC_CHECKS_CONFIG || rel(CONFIG_FILE);
const WORKFLOW_PATH = process.env.TRACE_MAC_CHECKS_WORKFLOW || rel(WORKFLOW_FILE);
const PACKAGE_JSON_PATH = process.env.TRACE_MAC_CHECKS_PACKAGE_JSON || rel('package.json');
const SMOKE_SOURCE_PATH = process.env.TRACE_MAC_CHECKS_SMOKE_SOURCE || rel(SMOKE_FILE);
const configText = fs.readFileSync(CONFIG_PATH, 'utf8');
const workflowText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const macConfig = parseYaml(configText);
const workflow = parseYaml(workflowText);
const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
// One job's YAML text (from its "  <name>:" line to the next job) for checks that must be scoped to the mac job.
const jobText = (name) => {
  const text = workflowText.replace(/\r\n/g, '\n');
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start !== -1, `job ${name} exists in ${WORKFLOW_FILE}`);
  const next = text.slice(start + 1).search(/\n  [a-z][a-z-]*:\n/);
  return text.slice(start, next === -1 ? undefined : start + 1 + next);
};
const stripYamlComments = (text) => text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '')).join('\n');

const macFiles = () => {
  const found = [CONFIG_FILE, DOC_FILE, WORKFLOW_FILE, SELF_FILE];
  for (const name of fs.readdirSync(rel('scripts'))) if (/^mac-.*\.cjs$/.test(name)) found.push(`scripts/${name}`);
  const extra = rel('config', 'mac');
  if (fs.existsSync(extra)) {
    const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.relative(ROOT, path.join(directory, entry.name)).split(path.sep).join('/')]));
    found.push(...walk(extra));
  }
  return found;
};

test('static: the Mac config is a valid electron-builder configuration for the pinned builder', async () => {
  assert.equal(tools.version, packageJson.devDependencies['electron-builder'], 'the schema checked against is the pinned builder version');
  await tools.validateConfiguration(JSON.parse(JSON.stringify(macConfig)), { isEnabled: false, add() {} });
  assert.ok(macConfig && typeof macConfig === 'object' && !Array.isArray(macConfig));
  // The schema rejects unknown keys, so a typo in a security-relevant option cannot pass silently.
  const broken = JSON.parse(JSON.stringify(macConfig));
  broken.mac.notarise = false;
  await assert.rejects(() => tools.validateConfiguration(broken, { isEnabled: false, add() {} }), /does not match the API schema/);
});

test('static: placement - the config is not auto-discovered and nothing Mac-specific sits in the shipped trees', () => {
  const discovered = fs.readdirSync(ROOT).filter((name) => /^electron-builder\.(?:ya?ml|json5?|toml|[cm]?js|ts)$/.test(name));
  assert.deepEqual(discovered, [], 'a root electron-builder.* file would be auto-discovered by the builder');
  assert.equal(path.posix.dirname(CONFIG_FILE), 'config');
  for (const file of macFiles()) {
    assert.ok(fs.existsSync(rel(file)), `${file} exists`);
    assert.ok(!['assets', 'electron', 'src', 'dist'].includes(file.split('/')[0]), `${file} must not sit under a shipped tree`);
  }
  // The shipped trees (the ASAR packs assets/, electron/ and dist/) must hold no Mac packaging artifacts either.
  const offenders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (/\.(?:icns|plist|entitlements|dmg)$/i.test(entry.name) || /(?:^|[-_.])mac(?:[-_.]|$)/i.test(entry.name)) offenders.push(path.relative(ROOT, full));
    }
  };
  for (const tree of ['assets', 'electron', 'src']) if (fs.existsSync(rel(tree))) walk(rel(tree));
  assert.deepEqual(offenders, []);
});

test('static: design - one architecture per run, zip only, arch in every artifact name, separate output directory', () => {
  const targets = [].concat(macConfig.mac.target).map((target) => (typeof target === 'string' ? target : target.target));
  assert.deepEqual(targets, ['zip'], 'baseline target is zip only (dmg, pkg and mas are deferred)');
  for (const target of [].concat(macConfig.mac.target)) assert.equal(typeof target, 'string', 'the arch is chosen by the command line, never pinned inside the target');
  assert.ok(!/universal/i.test(JSON.stringify(macConfig)), 'no universal build in the baseline');
  assert.match(macConfig.mac.artifactName, /\$\{arch\}/);
  assert.match(macConfig.mac.artifactName, /\$\{version\}/);
  assert.match(macConfig.mac.artifactName, /\$\{ext\}/);
  assert.equal(macConfig.directories.output, 'release-mac');
  assert.notEqual(macConfig.directories.output, packageJson.build.directories.output, 'must differ from the Windows output directory');
  for (const [a, b] of [[macConfig.directories.output, packageJson.build.directories.output], [packageJson.build.directories.output, macConfig.directories.output]]) {
    assert.ok(!`${a}/`.startsWith(`${b}/`), `${a} must not live inside ${b}`);
  }
  assert.equal(macConfig.publish, null, 'nothing is published and no app-update.yml is generated from the git remote');
  assert.equal(macConfig.electronDist, undefined, 'the host Electron (node_modules/electron/dist) must not be copied into a possibly other-arch build');
  assert.equal(macConfig.mac.defaultArch, undefined);
  const icon = fs.readFileSync(rel(macConfig.mac.icon));
  assert.equal(icon.subarray(1, 4).toString('latin1'), 'PNG');
  assert.ok(icon.readUInt32BE(16) >= 512 && icon.readUInt32BE(20) >= 512, 'the builder needs a PNG of at least 512x512 to derive the .icns');
});

test('static: signing - ad-hoc only, no certificate, no notarization, no secrets', () => {
  assert.equal(macConfig.mac.identity, '-', 'ad-hoc ("-") is the only identity allowed: never a certificate name');
  assert.equal(macConfig.mac.hardenedRuntime, false);
  assert.equal(macConfig.mac.notarize, false);
  assert.equal(macConfig.mac.gatekeeperAssess, false);
  for (const key of ['cscLink', 'cscKeyPassword', 'cscInstallerLink', 'cscInstallerKeyPassword', 'provisioningProfile', 'entitlements', 'entitlementsInherit', 'sign', 'type', 'forceCodeSigning', 'identityValidation']) {
    assert.ok(!(key in macConfig.mac) && !(key in macConfig), `${key} must not be configured`);
  }
  for (const hook of ['afterSign', 'afterPack', 'beforePack', 'afterAllArtifactBuild', 'onNodeModuleFile']) assert.ok(!(hook in macConfig), `${hook} hook`);
  const secrets = /CSC_LINK|CSC_KEY_PASSWORD|CSC_NAME|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|APPLE_API_KEY|APPLE_KEYCHAIN|\.p12|\.pfx|PRIVATE KEY|Developer ID/;
  for (const [file, text] of [[CONFIG_FILE, configText], [WORKFLOW_FILE, workflowText]]) assert.doesNotMatch(stripYamlComments(text), secrets, `${file} references no signing material`);
  const macText = stripYamlComments(jobText('mac'));
  assert.doesNotMatch(macText, /secrets\./, 'the mac job uses no secret; the draft-release job is the only one with a token');
  assert.doesNotMatch(macText, /GITHUB_TOKEN|GH_TOKEN/);
  assert.equal(workflow.jobs.mac.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
});

test('static: drift guard - appId, productName, asar and files match package.json "build"', () => {
  const build = packageJson.build;
  assert.equal(macConfig.appId, build.appId);
  assert.equal(macConfig.productName, build.productName);
  assert.equal(macConfig.asar, build.asar);
  const negations = macConfig.files.filter((pattern) => pattern.startsWith('!'));
  assert.deepEqual(negations.filter((pattern) => !ALLOWED_NEGATIONS.includes(pattern)), [], 'only documented negations are allowed');
  assert.deepEqual(macConfig.files.filter((pattern) => !pattern.startsWith('!')), build.files.filter((pattern) => !pattern.startsWith('!')), 'the positive patterns are identical, in order');
  assert.deepEqual(build.files.filter((pattern) => pattern.startsWith('!') && !macConfig.files.includes(pattern)), [], 'a negation added to package.json must also be in the Mac list');
  assert.deepEqual(macConfig.files.slice(-negations.length), negations, 'negations come last');
  assert.ok(!('asarUnpack' in macConfig) && !('extraResources' in macConfig) && !('extraFiles' in macConfig), 'no extra payload beyond package.json build');
});

// The fuses the shipped binaries carry (H1-07). Both configurations flip the same set: no ELECTRON_RUN_AS_NODE, no NODE_OPTIONS,
// application code only from the integrity-checked app.asar, encrypted cookies; file:// keeps its privileges (the UI and pdf.js load
// over it) and --inspect stays on (scripts/mac-smoke.cjs and every Playwright launch of a packaged build attach through it). The Mac
// file adds the ad-hoc signature reset. A fuse not listed keeps Electron's default, so the lists are compared whole.
test('static: Electron fuses - package.json "build" and the Mac file flip the same fuses, the pinned builder maps every name and its schema rejects a misspelled one', async () => {
  const expected = {
    runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: true,
    onlyLoadAppFromAsar: true, enableEmbeddedAsarIntegrityValidation: true, enableCookieEncryption: true, grantFileProtocolExtraPrivileges: true,
  };
  assert.deepEqual(packageJson.build.electronFuses, expected, 'the Windows build block');
  assert.deepEqual(macConfig.electronFuses, { ...expected, resetAdHocDarwinSignature: true }, 'the Mac file: the same set plus the signature reset');
  await tools.validateConfiguration(JSON.parse(JSON.stringify(packageJson.build)), { isEnabled: false, add() {} });
  for (const bad of [{ enableNodeCliInspect: false }, { resetAdhocDarwinSignature: true }, { grantFileProtocolExtraPrivilege: true }]) {
    const broken = JSON.parse(JSON.stringify(macConfig));
    broken.electronFuses = { ...broken.electronFuses, ...bad };
    await assert.rejects(() => tools.validateConfiguration(broken, { isEnabled: false, add() {} }), /does not match the API schema/, JSON.stringify(bad));
  }
  // The names are mapped one by one onto @electron/fuses (platformPackager.generateFuseConfig); a key the pinned builder does not
  // map would pass the schema and change nothing in the binary.
  const packager = fs.readFileSync(path.join(tools.directory, 'out', 'platformPackager.js'), 'utf8');
  for (const key of Object.keys(expected)) assert.ok(packager.includes(`if (fuses.${key} != null)`), `${key} is handed to @electron/fuses by app-builder-lib ${tools.version}`);
  assert.ok(packager.includes('resetAdHocDarwinSignature: fuses.resetAdHocDarwinSignature'));
  assert.ok(packager.includes('await this.doAddElectronFuses(packContext);') && packager.indexOf('await this.doAddElectronFuses(packContext);') < packager.indexOf('await this.doSignAfterPack('), 'the fuses are flipped before signing');
  // Windows: the builder embeds the ASAR hash in the executable's resources whenever integrity is not disabled, which is what the
  // enableEmbeddedAsarIntegrityValidation fuse checks at start.
  assert.equal(packageJson.build.disableAsarIntegrity, undefined);
  assert.equal(macConfig.disableAsarIntegrity, undefined);
  assert.ok(fs.readFileSync(path.join(tools.directory, 'out', 'electron', 'electronWin.js'), 'utf8').includes('id: "ELECTRONASAR"'));
});

test('static: the @napi-rs exclusion is safe - no shipped runtime code can require it', () => {
  assert.ok(ALLOWED_NEGATIONS.every((pattern) => macConfig.files.includes(pattern)), 'the documented exclusion is present');
  const allowedRequires = new Set(['electron', 'fflate']);
  for (const name of fs.readdirSync(rel('electron')).filter((entry) => entry.endsWith('.cjs'))) {
    const source = fs.readFileSync(rel('electron', name), 'utf8');
    assert.doesNotMatch(source, /napi-rs|pdfjs-dist|createRequire/, `electron/${name} must not reach @napi-rs/canvas`);
    for (const [, specifier] of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      assert.ok(allowedRequires.has(specifier), `electron/${name} requires "${specifier}": review whether the Mac "files" exclusions still hold`);
    }
  }
  assert.ok(packageJson.dependencies.fflate, 'fflate (required by electron/documents.cjs) is a production dependency and is not excluded');
  assert.ok(!macConfig.files.some((pattern) => /fflate/.test(pattern)));
});

test('static: the mac job builds the unsigned arm64 zip inside the release workflow, read-only, with the pinned SHAs of the Windows build', () => {
  assert.equal(fs.existsSync(rel('.github', 'workflows', 'macos.yml')), false, 'the macOS build lives in the release workflow; a second workflow would be a second, unreviewed path to a build');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(workflow.concurrency && workflow.concurrency.group);
  const job = workflow.jobs.mac;
  assert.ok(job, 'job "mac"');
  assert.match(String(job['runs-on']), /^macos-\d+$/, 'an explicit versioned Apple silicon label (macos-<version>): never macos-latest, an -intel or -large (x64) label, or an expression');
  assert.equal(job.if, "github.event_name != 'pull_request'", 'pull requests do not spend hosted macOS minutes');
  assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 60);
  assert.ok(!('permissions' in job), 'no job-level permission override: the mac job never writes to the repository');
  assert.equal(job.defaults.run.shell, 'bash');
  assert.equal(job.env.TRACE_ARCH, 'arm64');
  assert.equal(job.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.deepEqual(Object.keys(job.outputs).sort(), ['artifact_name', 'version']);

  const pinsOf = (steps) => new Map(steps.filter((step) => step.uses).map((step) => step.uses.split('@')));
  const buildPins = pinsOf(workflow.jobs.build.steps);
  const macPins = pinsOf(job.steps);
  assert.ok(macPins.size >= 4);
  for (const [name, sha] of macPins) {
    assert.match(sha, /^[0-9a-f]{40}$/, `${name} is pinned to a full commit SHA`);
    assert.equal(buildPins.get(name), sha, `${name} uses the same pinned SHA as the Windows build job`);
  }
  const checkout = job.steps.find((step) => step.uses && step.uses.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  const names = job.steps.map((step) => step.name);
  const order = ['Install locked dependencies', 'Validate release metadata', 'Run the static macOS packaging checks', 'Build the renderer', 'Build the unsigned macOS app', 'Locate the app and generate the zip checksum', 'Run the packaged-app smoke test', 'Scan the app bundle for private names and paths', 'Upload macOS zip and checksum', 'Upload macOS smoke evidence'];
  assert.deepEqual(names.filter((name) => order.includes(name)), order, 'the steps run in this order: the smoke test and the scan come before the upload');
  assert.ok(!names.some((name) => /Prepare Electron runtime/.test(name)), 'no setup:electron: the builder downloads the arm64 Electron itself');

  const text = stripYamlComments(jobText('mac'));
  assert.doesNotMatch(text, /gh release|contents:\s*write|softprops|action-gh-release|download-artifact/, 'the mac job only builds and uploads');
  for (const step of job.steps.filter((entry) => entry.run)) {
    assert.doesNotMatch(step.run, /\$\{\{/, `step "${step.name}": contexts reach scripts through env only`);
  }
  const build = job.steps.find((step) => step.run && /electron-builder/.test(step.run));
  assert.match(build.run, /--mac zip "--\$TRACE_ARCH" --config config\/electron-builder\.mac\.yml --publish never/);
  assert.doesNotMatch(build.run, /--win|--linux|--universal|--publish always/);
  const checksum = job.steps.find((step) => step.name === 'Locate the app and generate the zip checksum');
  assert.match(checksum.run, /shasum -a 256 "\$\(basename "\$zip"\)" > "\$\(basename "\$zip"\)\.sha256"/, 'the same "<sha256>  <file name>" line as the EXE checksum');
  const smokeStep = job.steps.find((step) => step.run && step.run.includes('scripts/mac-smoke.cjs'));
  assert.ok(smokeStep['timeout-minutes'], 'the smoke step has its own timeout');
  assert.match(smokeStep.run, /--app "\$TRACE_APP" --arch "\$TRACE_ARCH" --commit "\$TRACE_COMMIT" --artifact "\$TRACE_ZIP" --out "test-results\/mac\/mac-smoke-evidence-\$TRACE_ARCH\.json"/);
  assert.doesNotMatch(smokeStep.run, /--evidence-only/, 'the release build runs the full smoke test');

  const scan = job.steps.find((step) => step.name === 'Scan the app bundle for private names and paths');
  for (const needle of ['/Users/runner', '/home/runner', 'runner/work']) assert.ok(scan.run.includes(needle), `the scan looks for ${needle}`);
  assert.match(scan.run, /grep -r -I -i -l -E "\$pattern" "\$TRACE_APP"/, 'every text file of the bundle, case-insensitively');
  assert.match(scan.run, /grep -a -i -q -E "\$pattern" "\$file"/, 'the asar and the main executable as bytes');
  assert.ok(scan.run.includes('Contents/Resources/app.asar') && scan.run.includes('Contents/MacOS/TRACE Boardviewer'));
  assert.match(scan.run, /if \[ "\$hits" -ne 0 \]; then\n\s+echo '[^\n]*' >&2\n\s+exit 1/, 'one hit fails the job');
  assert.equal(scan.if, undefined);

  const upload = job.steps.find((step) => step.name === 'Upload macOS zip and checksum');
  assert.equal(upload.if, undefined, 'the zip is uploaded only when every step before it passed');
  assert.equal(upload.with.name, '${{ steps.metadata.outputs.artifact_name }}');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['retention-days'], 14);
  assert.match(upload.with.path, /-mac-\$\{\{ env\.TRACE_ARCH \}\}\.zip\n/);
  assert.match(upload.with.path, /-mac-\$\{\{ env\.TRACE_ARCH \}\}\.zip\.sha256\n?$/);
  const evidence = job.steps.find((step) => step.name === 'Upload macOS smoke evidence');
  assert.equal(evidence.if, 'always()');
  assert.match(evidence.with.path, /test-results\/mac\/\*\.json/);
  assert.equal(evidence.with['retention-days'], 14);
});

test('static: the draft release carries both builds and a suffixed version becomes a prerelease', () => {
  const release = workflow.jobs['draft-release'];
  assert.deepEqual(release.needs, ['build', 'portable-isolation', 'mac']);
  assert.deepEqual(release.permissions, { contents: 'write' });
  const downloads = release.steps.filter((step) => step.uses && step.uses.startsWith('actions/download-artifact@')).map((step) => step.with.name);
  assert.deepEqual(downloads, ['${{ needs.build.outputs.artifact_name }}', '${{ needs.mac.outputs.artifact_name }}']);
  const create = release.steps.find((step) => step.name === 'Create draft GitHub release');
  assert.equal(create.env.TRACE_MAC_VERSION, '${{ needs.mac.outputs.version }}');
  assert.match(create.run, /if \(\$env:TRACE_MAC_VERSION -ne \$env:TRACE_VERSION\) \{ throw/, 'both builds must be of the same version');
  assert.match(create.run, /\$traceZip = Join-Path release "TRACE-Boardviewer-\$env:TRACE_VERSION-mac-arm64\.zip"/);
  assert.match(create.run, /foreach \(\$traceFile in @\(\$traceExe, \$traceZip\)\)/, 'both assets are checked against their .sha256 files');
  assert.match(create.run, /Get-FileHash -LiteralPath \$traceFile -Algorithm SHA256/);
  assert.match(create.run, /\$traceAssets \+= @\(\$traceFile, \$traceChecksum\)/, 'the EXE, the zip and both checksum files are attached');
  assert.match(create.run, /@\('--draft', '--verify-tag', '--title', "TRACE Boardviewer \$env:TRACE_VERSION", '--notes-file', 'release-notes\.md'\)/);
  assert.match(create.run, /if \(\$env:TRACE_VERSION -match '-'\) \{ \$traceArgs \+= '--prerelease' \}/, 'a prerelease suffix never becomes the latest release the app checks');
  assert.match(create.run, /gh release create @traceArgs\n/);
  assert.doesNotMatch(create.run, /--latest|--prerelease=false/);
  const notes = create.run.slice(create.run.indexOf('@"'), create.run.indexOf('"@'));
  assert.match(notes, /TRACE-Boardviewer-\$\{env:TRACE_VERSION\}\.exe/);
  assert.match(notes, /TRACE-Boardviewer-\$\{env:TRACE_VERSION\}-mac-arm64\.zip/);
  assert.match(notes, /experimental/i);
  assert.match(notes, /unsigned/i);
  assert.match(notes, /not notarized/);
  assert.match(notes, /Apple silicon only/);
  const openLine = 'xattr -dr com.apple.quarantine "/Applications/TRACE Boardviewer.app"';
  assert.ok(notes.includes(openLine), 'the one-line open instruction');
  assert.doesNotMatch(notes, /`/, 'no backticks: the notes are a double-quoted PowerShell here-string, where a backtick escapes');
  assert.ok(read('README.md').includes(openLine), 'README gives the same instruction');
});

test('static: the smoke script refuses to produce evidence off macOS', () => {
  for (const platform of ['linux', 'win32', 'freebsd']) {
    const gate = smoke.platformGate(platform);
    assert.equal(gate.allowed, false, platform);
    assert.match(gate.message, /refuses to run on "/);
    assert.match(gate.message, /only runs on macOS/);
  }
  assert.equal(smoke.platformGate('darwin').allowed, true);
  const source = fs.readFileSync(SMOKE_SOURCE_PATH, 'utf8');
  assert.match(source, /if \(require\.main === module\)/, 'the OS part only runs when executed directly');
  const mainBody = source.slice(source.indexOf('async function main('));
  assert.ok(mainBody.indexOf('platformGate(process.platform)') > 0 && mainBody.indexOf('platformGate(process.platform)') < mainBody.indexOf('parseArgs('), 'the platform gate is the first thing main() does');
  const runSmokeBody = source.slice(source.indexOf('async function runSmoke('), source.indexOf('async function main('));
  assert.ok(runSmokeBody.indexOf('platformGate(process.platform)') >= 0 && runSmokeBody.indexOf('platformGate(process.platform)') < runSmokeBody.indexOf('collectStaticEvidence('));
  assert.doesNotMatch(source.split('\n').filter((line) => /^(?:const|let|var)\s/.test(line)).join('\n'), /require\('playwright'\)/, 'playwright is loaded lazily, after the gate');
  if (process.platform !== 'darwin') {
    for (const args of [[], ['--app', 'X.app', '--arch', 'arm64'], ['--help']]) {
      const result = spawnSync(process.execPath, [rel(SMOKE_FILE), ...args], { encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 2, `exit code 2 for ${JSON.stringify(args)}`);
      assert.match(result.stderr, /refuses to run on/);
      assert.equal(result.stdout, '', 'nothing is produced on stdout');
    }
  } else {
    const result = spawnSync(process.execPath, [rel(SMOKE_FILE)], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 2, 'missing arguments are refused with exit code 2');
  }
});

test('simulated: runSmoke() itself rejects off macOS', { skip: process.platform === 'darwin' && 'on macOS runSmoke() would really run' }, async () => {
  await assert.rejects(() => smoke.runSmoke({ app: 'X.app', arch: 'arm64', out: path.join(ROOT, 'test-results', 'must-not-exist.json') }), /refuses to run on/);
  assert.equal(fs.existsSync(rel('test-results', 'must-not-exist.json')), false);
});

test('simulated: argument parsing', () => {
  const ok = smoke.parseArgs(['--app', 'a/B.app', '--arch=arm64', '--artifact', 'z.zip', '--evidence-only'], { GITHUB_SHA: 'abc' });
  assert.deepEqual({ app: ok.app, arch: ok.arch, artifact: ok.artifact, evidenceOnly: ok.evidenceOnly, commit: ok.commit, errors: ok.errors }, { app: 'a/B.app', arch: 'arm64', artifact: 'z.zip', evidenceOnly: true, commit: 'abc', errors: [] });
  assert.equal(smoke.parseArgs(['--app', 'a.app', '--arch', 'x64', '--commit', 'c0ffee'], { GITHUB_SHA: 'abc' }).commit, 'c0ffee');
  for (const bad of [[], ['--app', 'a.app'], ['--app', 'a.app', '--arch', 'universal'], ['--app', 'a.app', '--arch', 'x86_64'], ['--app', 'a.dmg', '--arch', 'arm64'], ['--app', 'a.app', '--arch'], ['--app', 'a.app', '--arch', 'arm64', '--bogus']]) {
    assert.ok(smoke.parseArgs(bad).errors.length > 0, JSON.stringify(bad));
  }
  assert.equal(smoke.parseArgs(['--help']).errors.length, 0);
});

test('simulated: architecture parsing and the native / Rosetta classification', () => {
  assert.equal(smoke.normalizeArch('x86_64'), 'x64');
  assert.equal(smoke.normalizeArch('arm64e'), 'arm64');
  assert.equal(smoke.normalizeArch('ppc'), null);
  assert.deepEqual(smoke.parseMachArchs('Non-fat file: /A/TRACE Boardviewer is architecture: arm64'), ['arm64']);
  assert.deepEqual(smoke.parseMachArchs('Architectures in the fat file: /A/TRACE are: x86_64 arm64'), ['arm64', 'x64']);
  assert.deepEqual(smoke.parseMachArchs('Mach-O 64-bit executable x86_64'), ['x64']);
  assert.deepEqual(smoke.parseMachArchs('Mach-O 64-bit executable arm64'), ['arm64']);
  assert.deepEqual(smoke.parseMachArchs('Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64:Mach-O 64-bit executable arm64]'), ['arm64', 'x64']);
  assert.deepEqual(smoke.parseMachArchs('ELF 64-bit LSB executable, x86-64'), [], 'a non-Mach-O file names no macOS architecture');
  assert.deepEqual(smoke.parseMachArchs(''), []);

  assert.equal(smoke.parseTranslated({ output: '1\n', failed: false, hostArch: 'arm64' }), true);
  assert.equal(smoke.parseTranslated({ output: '0\n', failed: false, hostArch: 'arm64' }), false);
  assert.equal(smoke.parseTranslated({ output: '', failed: true, hostArch: 'x64' }), false);
  assert.equal(smoke.parseTranslated({ output: '', failed: true, hostArch: 'arm64' }), null, 'unknown is never reported as native');

  const native = smoke.classifyValidation({ requestedArch: 'arm64', binaryArchs: ['arm64'], hostArch: 'arm64', translated: false });
  assert.equal(native.native, true);
  assert.match(native.label, /^native arm64/);
  assert.equal(smoke.classifyValidation({ requestedArch: 'x64', binaryArchs: ['x64'], hostArch: 'x64', translated: false }).native, true);
  const rosetta = smoke.classifyValidation({ requestedArch: 'x64', binaryArchs: ['x64'], hostArch: 'arm64', translated: true });
  assert.equal(rosetta.native, false);
  assert.match(rosetta.label, /Rosetta/);
  assert.match(rosetta.label, /NOT native Intel validation/);
  assert.equal(smoke.classifyValidation({ requestedArch: 'x64', binaryArchs: ['x64'], hostArch: 'arm64', translated: false }).native, false, 'an x64 binary on an arm64 host is never native');
  const translatedSameArch = smoke.classifyValidation({ requestedArch: 'x64', binaryArchs: ['x64'], hostArch: 'x64', translated: true });
  assert.equal(translatedSameArch.native, false, 'a translated process is never native, even when the architectures agree');
  assert.ok(translatedSameArch.reasons.some((reason) => /Rosetta/.test(reason)));
  assert.equal(smoke.classifyValidation({ requestedArch: 'arm64', binaryArchs: ['arm64'], hostArch: 'arm64', translated: null }).native, false);
  assert.equal(smoke.classifyValidation({ requestedArch: 'arm64', binaryArchs: ['x64'], hostArch: 'arm64', translated: false }).native, false, 'requested and built architecture differ');
  assert.equal(smoke.classifyValidation({ requestedArch: 'arm64', binaryArchs: ['arm64', 'x64'], hostArch: 'arm64', translated: false }).native, false, 'a universal binary is not a single-arch validation');
  assert.equal(smoke.classifyValidation({ requestedArch: 'arm64', binaryArchs: [], hostArch: 'arm64', translated: false }).native, false);
});

test('simulated: signature, zip and UI-text parsing', () => {
  const adhoc = ['Executable=/x/TRACE Boardviewer.app/Contents/MacOS/TRACE Boardviewer', 'Identifier=hu.trace.boardviewer', 'Format=app bundle with Mach-O thin (arm64)',
    'CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=30+7 location=embedded', 'Signature=adhoc', 'TeamIdentifier=not set'].join('\n');
  assert.deepEqual({ ...smoke.parseCodesign(adhoc) }, { signed: true, adhoc: true, teamIdentifier: 'not set', hasTeamIdentifier: false, identifier: 'hu.trace.boardviewer', authorities: [] });
  const unsigned = smoke.parseCodesign('/x/TRACE Boardviewer.app: code object is not signed at all');
  assert.equal(unsigned.signed, false);
  assert.equal(unsigned.adhoc, false);
  const real = smoke.parseCodesign('Identifier=a.b\nCodeDirectory v=20500 size=9 flags=0x10000(runtime) hashes=1+1 location=embedded\nAuthority=Developer ID Application: Someone (ABCDE12345)\nTeamIdentifier=ABCDE12345');
  assert.equal(real.adhoc, false);
  assert.equal(real.hasTeamIdentifier, true);
  assert.equal(real.authorities.length, 1);

  assert.deepEqual(smoke.parseZipTopLevel('TRACE Boardviewer.app/Contents/Info.plist\nTRACE Boardviewer.app/Contents/MacOS/x\n'), ['TRACE Boardviewer.app']);
  assert.deepEqual(smoke.parseZipTopLevel('mac-arm64/a.app/x\nreadme\n'), ['mac-arm64', 'readme']);

  assert.deepEqual(smoke.extractCounts('2 components · 4 pins · 2 nets'), { components: 2, pins: 4, nets: 2 });
  assert.deepEqual(smoke.extractCounts('2 alkatrész · 4 pin · 2 net'), { components: 2, pins: 4, nets: 2 });
  assert.equal(smoke.extractCounts('no digits here'), null);
  assert.equal(smoke.extractCounts('1 · 2'), null);
  assert.equal(smoke.sameCounts({ components: 2, pins: 4, nets: 2 }, smoke.EXPECTED_COUNTS), true);
  assert.equal(smoke.sameCounts({ components: 2, pins: 4, nets: 3 }, smoke.EXPECTED_COUNTS), false);
  assert.equal(smoke.isPainted({ different: 100 }), true);
  assert.equal(smoke.isPainted({ different: 99 }), false);
  assert.equal(smoke.isPainted(null), false);
});

test('simulated: workspace, quit and evidence decisions', () => {
  const names = ['macsmoke.pdf', 'macsmoke.png'];
  assert.equal(smoke.decideRows([{ name: 'MacSmoke.pdf', status: 'ready' }, { name: 'macsmoke.png', status: 'ready' }], names).ok, true);
  assert.equal(smoke.decideRows([{ name: 'macsmoke.pdf', status: 'ready' }], names).ok, false, 'a missing row is a failure');
  assert.equal(smoke.decideRows([{ name: 'macsmoke.pdf', status: 'ready' }, { name: 'macsmoke.png', status: 'missing' }], names).ok, false);
  assert.equal(smoke.decideRows([{ name: 'macsmoke.pdf', status: 'ready' }, { name: 'macsmoke.png', status: 'ready' }, { name: 'extra.pdf', status: 'ready' }], names).ok, false);
  const key = 'a'.repeat(64);
  assert.equal(smoke.decideManifest({ board: { key }, documents: [{ name: 'macsmoke.png' }, { name: 'macsmoke.pdf' }] }, { key, names }).ok, true);
  assert.equal(smoke.decideManifest({ board: { key: 'b'.repeat(64) }, documents: [] }, { key, names }).ok, false);
  assert.equal(smoke.decideManifest({ board: { key }, documents: [{ name: 'macsmoke.pdf' }] }, { key, names }).ok, false);
  assert.equal(smoke.decideManifest(null, { key, names }).ok, false);

  assert.equal(smoke.isCleanExit({ code: 0, signal: null, timedOut: false }), true);
  assert.equal(smoke.isCleanExit({ code: 1, signal: null, timedOut: false }), false);
  assert.equal(smoke.isCleanExit({ code: null, signal: 'SIGKILL', timedOut: true }), false);
  assert.equal(smoke.isCleanExit({ code: 0, signal: 'SIGTERM', timedOut: false }), false);

  assert.deepEqual(smoke.summarizeChecks([{ name: 'a', status: 'pass' }, { name: 'b', status: 'pass' }]), { passed: true, failed: [], skipped: [], total: 2 });
  assert.equal(smoke.summarizeChecks([{ name: 'a', status: 'pass' }, { name: 'b', status: 'fail' }]).passed, false);
  assert.equal(smoke.summarizeChecks([{ name: 'a', status: 'pass' }, { name: 'b', status: 'skipped' }]).passed, false, 'a skipped check is not a pass');
  assert.equal(smoke.summarizeChecks([]).passed, false, 'no checks is not a pass');

  const nativeClass = smoke.classifyValidation({ requestedArch: 'arm64', binaryArchs: ['arm64'], hostArch: 'arm64', translated: false });
  const checks = [{ name: 'a', status: 'pass' }];
  const full = smoke.buildEvidence({ commit: 'c', requestedArch: 'arm64', classification: nativeClass, mode: 'full', checks });
  assert.equal(full.nativeValidation, true);
  assert.equal(full.schema, smoke.SCHEMA);
  assert.match(full.disclaimer, /Not a release acceptance/);
  assert.ok(full.notCovered.length >= 8 && full.notCovered.some((item) => /Gatekeeper/.test(item)) && full.notCovered.some((item) => /notarization/.test(item)));
  assert.equal(smoke.buildEvidence({ commit: 'c', requestedArch: 'arm64', classification: nativeClass, mode: 'evidence-only', checks }).nativeValidation, false, 'static evidence alone is never native validation');
  assert.equal(smoke.buildEvidence({ commit: 'c', requestedArch: 'arm64', classification: nativeClass, mode: 'full', checks: [...checks, { name: 'b', status: 'fail' }] }).nativeValidation, false);
  const rosetta = smoke.classifyValidation({ requestedArch: 'x64', binaryArchs: ['x64'], hostArch: 'arm64', translated: true });
  assert.equal(smoke.buildEvidence({ commit: 'c', requestedArch: 'x64', classification: rosetta, mode: 'full', checks }).nativeValidation, false);
  assert.equal(smoke.buildEvidence({ requestedArch: 'x64', checks }).commit, 'unknown', 'a missing commit is never invented');
});

test('simulated: the synthetic fixtures are original, consistent and valid', () => {
  const lines = smoke.FIXTURE_BOARD.trim().split('\n');
  const count = (pattern) => lines.filter((line) => pattern.test(line)).length;
  assert.equal(count(/^COMPONENT /), smoke.EXPECTED_COUNTS.components);
  assert.equal(count(/^SIGNAL /), smoke.EXPECTED_COUNTS.nets);
  assert.equal(count(/^PIN /) * smoke.EXPECTED_COUNTS.components, smoke.EXPECTED_COUNTS.pins, 'every component instantiates the two-pin shape');
  for (const section of ['HEADER', 'BOARD', 'PADS', 'PADSTACKS', 'SHAPES', 'COMPONENTS', 'DEVICES', 'SIGNALS']) {
    assert.ok(lines.includes(`$${section}`) && lines.includes(`$END${section}`), `$${section} section`);
  }
  assert.ok(lines.length < 60);
  assert.ok(!/\.(?:cad|gcd)$/i.test(smoke.DOCUMENT_NAMES.join('')), 'documents are not boards');

  const pdf = smoke.makePdf().toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4\n') && pdf.endsWith('%%EOF\n'));
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)[1]);
  assert.ok(pdf.slice(startxref).startsWith('xref\n0 6\n'));
  const entries = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  assert.equal(entries.length, 5);
  entries.forEach((offset, index) => assert.ok(pdf.slice(offset).startsWith(`${index + 1} 0 obj\n`), `xref offset of object ${index + 1}`));
  assert.deepEqual(smoke.makePdf(), smoke.makePdf(), 'fixtures are deterministic');

  const png = smoke.makePng();
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let position = 8;
  const types = [];
  while (position < png.length) {
    const length = png.readUInt32BE(position);
    const type = png.toString('latin1', position + 4, position + 8);
    const crc = png.readUInt32BE(position + 8 + length);
    assert.equal(crc, zlib.crc32(png.subarray(position + 4, position + 8 + length)) >>> 0, `CRC of ${type}`);
    types.push(type);
    position += 12 + length;
  }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  assert.equal(png.readUInt32BE(16), 16);
  assert.equal(png.readUInt32BE(20), 16);
  assert.deepEqual(smoke.makePng(), smoke.makePng());
});

test('static: the validation document has its required sections and no unqualified Mac claims', () => {
  const doc = read(DOC_FILE);
  for (const heading of [/^## 1\. Architecture support/m, /^## 2\. What was inspected/m, /^## 3\. Unsigned app behaviour/m, /^## 4\. Native validation checklist/m, /^## 5\. Blockers and gaps/m, /^## 6\. Proposed shared-code changes \(NOT applied\)/m]) {
    assert.match(doc, heading);
  }
  // One native run exists (section 7, Apple M3); every other Mac target is still unrun.
  assert.match(doc, /one native run on an Apple M3/);
  assert.match(doc, /have not been run on any Mac/i);
  assert.match(doc, /UNVERIFIED/);
  assert.match(doc, /NOT native Intel validation/);
  const claims = [
    /\b(?:was|were|has been|have been|is|are)\s+(?:successfully\s+)?(?:tested|validated|verified|launched|run|started|signed|notarized|smoke-tested)\s+on\s+(?:a\s+|an\s+|the\s+)?(?:real\s+)?(?:mac|macos|apple)/i,
    /\bmac(?:os)?\s+(?:release|build|app)\s+is\s+(?:ready|working|supported|validated)\b/i,
    /\bready\s+for\s+(?:a\s+)?mac(?:os)?\s+release\b/i,
  ];
  for (const file of macFiles().filter((name) => name !== SELF_FILE)) {
    const text = read(file);
    for (const claim of claims) {
      for (const match of text.matchAll(new RegExp(claim.source, 'gi'))) {
        // A negated sentence ("has never been run on macOS", "Nothing ... has been run on macOS") is the honest form.
        const lineStart = text.lastIndexOf('\n', match.index) + 1;
        const before = text.slice(lineStart, match.index);
        assert.match(before, /\b(?:not|never|nothing|no|cannot|without|unverified)\b/i, `${file} must not claim macOS testing: "${match[0]}"`);
      }
    }
  }
});
