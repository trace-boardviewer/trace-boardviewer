'use strict';

// Smoke test for the PACKAGED, UNSIGNED macOS app (a "<name>.app" produced by config/electron-builder.mac.yml).
//
//   node scripts/mac-smoke.cjs --app "release-mac/mac-arm64/TRACE Boardviewer.app" --arch arm64 \
//        [--out test-results/mac/mac-evidence-arm64.json] [--commit <sha>] [--artifact <zip>] [--evidence-only] [--keep-temp]
//
// It refuses to run anywhere but macOS (exit 2), so it can never produce "Mac" evidence on Linux or Windows.
// Exit codes: 0 = every check passed, 1 = a check failed, 2 = refused or bad arguments.
//
// What it does, with only synthetic data created in a private temporary directory: launches the packaged
// binary with an empty temporary --user-data-dir, imports an original GENCAD board through the real UI path,
// attaches an original PDF and PNG, waits for the workspace to be written, quits normally (expects exit code 0),
// restarts with the SAME profile (no --board) and expects the board and the documents to be restored.
// It writes an evidence JSON, including a list of what it does NOT cover.
//
// Honest limits: the native file chooser is replaced in the main process (the app's own dialog code is not
// driven), Dock/Finder events are simulated or skipped, and the result says nothing about signing,
// notarization, Gatekeeper behaviour of a downloaded copy or any release. The decision logic below is pure and
// exported so tests/mac-config-checks.cjs can exercise it on any OS; the code that talks to macOS or to the
// app only runs from main() / runSmoke() below.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const EXIT = Object.freeze({ OK: 0, FAILED: 1, REFUSED: 2 });
const SCHEMA = 'trace-mac-smoke-evidence/1';
const FIXTURE_NAME = 'MacSmoke.cad';
const EXPECTED_COUNTS = Object.freeze({ components: 2, pins: 4, nets: 2 });
const DOCUMENT_NAMES = Object.freeze(['macsmoke.pdf', 'macsmoke.png']);

// Original synthetic GENCAD board: two two-pin parts joined by two nets. Checked once against the project's
// own parser (2 components, 4 pins, 2 nets, no warnings); it is generated at run time, never committed.
const FIXTURE_BOARD = [
  '$HEADER', 'GENCAD 1.4', 'UNITS MM', 'ORIGIN 0 0', '$ENDHEADER',
  '$BOARD', 'RECTANGLE 0 0 30 20', '$ENDBOARD',
  '$PADS', 'PAD RP ROUND -1', 'CIRCLE 0 0 0.3', '$ENDPADS',
  '$PADSTACKS', 'PADSTACK PS 0', 'PAD RP TOP 0 0', '$ENDPADSTACKS',
  '$SHAPES', 'SHAPE SH2', 'RECTANGLE -1.5 -1 3 2', 'PIN 1 PS -1 0 TOP 0 0', 'PIN 2 PS 1 0 TOP 0 0', '$ENDSHAPES',
  '$COMPONENTS',
  'COMPONENT MS1', 'PLACE 8 10', 'LAYER TOP', 'ROTATION 0', 'SHAPE SH2 0 0', 'DEVICE DV',
  'COMPONENT MS2', 'PLACE 22 10', 'LAYER TOP', 'ROTATION 0', 'SHAPE SH2 0 0', 'DEVICE DV',
  '$ENDCOMPONENTS',
  '$DEVICES', 'DEVICE DV', 'VALUE "1k"', '$ENDDEVICES',
  '$SIGNALS', 'SIGNAL NET_A', 'NODE MS1 1', 'NODE MS2 1', 'SIGNAL NET_B', 'NODE MS1 2', 'NODE MS2 2', '$ENDSIGNALS',
  '',
].join('\n');

const NOT_COVERED = Object.freeze([
  'Gatekeeper / quarantine first-open experience of a downloaded copy (this run opens the local build output)',
  'Developer ID signing, hardened runtime, notarization and stapling (the build is ad-hoc signed at most)',
  'The native open/save/attach file chooser (replaced in the main process) and the renderer drag-and-drop path',
  'Finder "Open With", double-click and Dock-drop delivery through the open-file event',
  'A real Dock click or app-switch (activate is only simulated with app.emit)',
  'Application menu, Cmd+Q, Cmd+C / V / X / A / Z in text fields (the app installs no application menu)',
  'Frameless window behaviour: custom window controls, zoom, full screen, Retina or multi-display rendering fidelity',
  'The other CPU architecture and any universal build',
  'The default (non-isolated) userData location, upgrades, DMG/pkg installation, auto-update',
  'Performance, memory, sleep/wake, logout/restart while the app is open',
  'Real customer boards, licensed samples or any user profile (none were used)',
]);

// ---------------------------------------------------------------------------------------------------------
// Pure decision logic (no OS access): exported for tests.
// ---------------------------------------------------------------------------------------------------------

/** The one gate that keeps Linux/Windows runs from ever producing macOS evidence. */
function platformGate(platform) {
  if (platform === 'darwin') return { allowed: true, message: '' };
  return {
    allowed: false,
    message: `mac-smoke.cjs refuses to run on "${platform}": it only runs on macOS (darwin), because its result is macOS runtime evidence and must never be produced anywhere else.`,
  };
}

function normalizeArch(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'arm64' || text === 'aarch64' || text === 'arm64e') return 'arm64';
  if (text === 'x64' || text === 'x86_64' || text === 'amd64' || text === 'x86-64') return 'x64';
  return null;
}

const USAGE = 'Usage: node scripts/mac-smoke.cjs --app <path to .app> --arch <arm64|x64> [--out <file>] [--commit <sha>] [--artifact <zip>] [--evidence-only] [--keep-temp]';

function parseArgs(argv, env = {}) {
  const parsed = { app: null, arch: null, out: null, commit: env.GITHUB_SHA || null, artifact: null, evidenceOnly: false, keepTemp: false, help: false, errors: [] };
  const valued = { '--app': 'app', '--arch': 'arch', '--out': 'out', '--commit': 'commit', '--artifact': 'artifact' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const equal = argument.indexOf('=');
    const name = equal > 0 ? argument.slice(0, equal) : argument;
    if (name === '--help' || name === '-h') parsed.help = true;
    else if (name === '--evidence-only') parsed.evidenceOnly = true;
    else if (name === '--keep-temp') parsed.keepTemp = true;
    else if (Object.hasOwn(valued, name)) {
      const value = equal > 0 ? argument.slice(equal + 1) : argv[++index];
      if (value === undefined || value === '' || value.startsWith('--')) parsed.errors.push(`${name} needs a value`);
      else parsed[valued[name]] = value;
    } else parsed.errors.push(`unknown argument ${argument}`);
  }
  if (!parsed.help) {
    if (!parsed.app) parsed.errors.push('--app is required');
    else if (!/\.app\/?$/.test(parsed.app)) parsed.errors.push('--app must point at a .app bundle');
    if (!parsed.arch) parsed.errors.push('--arch is required');
    else if (normalizeArch(parsed.arch) === null || !['arm64', 'x64'].includes(parsed.arch)) parsed.errors.push('--arch must be arm64 or x64');
  }
  return parsed;
}

/** Architectures named by `lipo -info` or `file` output for one Mach-O binary, normalized and de-duplicated. */
function parseMachArchs(text) {
  const found = new Set();
  for (const line of String(text ?? '').split('\n')) {
    let tail = null;
    const lipoFat = /Architectures in the fat file: .* are: (.*)$/.exec(line);
    const lipoThin = /is architecture: (\S+)/.exec(line);
    if (lipoFat) tail = lipoFat[1];
    else if (lipoThin) tail = lipoThin[1];
    else if (/Mach-O/.test(line)) {
      // "Mach-O universal binary with 2 architectures: [x86_64:Mach-O ...] [arm64:Mach-O ...]" or "... executable arm64".
      const bracketed = [...line.matchAll(/\[([A-Za-z0-9_]+)(?::[^\]]*)?\]/g)].map((match) => match[1]);
      tail = bracketed.length ? bracketed.join(' ') : line.trim().split(/\s+/).pop();
    }
    for (const word of String(tail ?? '').split(/\s+/)) {
      const arch = normalizeArch(word);
      if (arch) found.add(arch);
    }
  }
  return [...found].sort();
}

/** `sysctl -n sysctl.proc_translated` of the process under test: true (Rosetta), false (native) or null (unknown). */
function parseTranslated({ output, failed, hostArch }) {
  if (!failed) {
    const text = String(output ?? '').trim();
    if (text === '1') return true;
    if (text === '0') return false;
    return null;
  }
  // The key does not exist on Intel Macs, where nothing can be translated (UNVERIFIED assumption, hence the host check).
  return hostArch === 'x64' ? false : null;
}

/**
 * Whether a run counts as NATIVE validation of the requested architecture. Anything else is labelled with the
 * reason: x64 on Apple silicon is Rosetta, "NOT native Intel validation".
 */
function classifyValidation({ requestedArch, binaryArchs, hostArch, translated }) {
  const requested = normalizeArch(requestedArch);
  const archs = (binaryArchs ?? []).map(normalizeArch).filter(Boolean);
  const reasons = [];
  if (archs.length !== 1) reasons.push(`the main binary is not a single-architecture Mach-O (${archs.join(', ') || 'unknown'})`);
  else if (requested !== archs[0]) reasons.push(`the binary is ${archs[0]} but ${requested} was requested`);
  const binary = archs.length === 1 ? archs[0] : null;
  const host = normalizeArch(hostArch);
  if (binary && host && host !== binary) reasons.push(`a ${host} host cannot run a ${binary} binary natively`);
  if (!host) reasons.push('the host architecture is unknown');
  if (translated === true) reasons.push('the app process is translated (Rosetta)');
  else if (translated === null) reasons.push('whether the app process is translated could not be determined');
  const native = reasons.length === 0;
  let label;
  if (native) label = `native ${binary} on ${host}`;
  else if (binary === 'x64' && host === 'arm64') label = 'Rosetta (x64 on Apple silicon): NOT native Intel validation';
  else label = `NOT native validation: ${reasons.join('; ')}`;
  return { native, label, reasons, requestedArch: requested, binaryArch: binary, hostArch: host, translated };
}

/** Fields of `codesign -dv --verbose=4 <app>` (written to stderr) that matter for an unsigned/ad-hoc baseline. */
function parseCodesign(text) {
  const body = String(text ?? '');
  const field = (key) => { const match = new RegExp(`^${key}=(.*)$`, 'm').exec(body); return match ? match[1].trim() : null; };
  const directory = /CodeDirectory [^\n]*flags=(0x[0-9a-f]+)\(([^)]*)\)/.exec(body);
  const teamIdentifier = field('TeamIdentifier');
  const identifier = field('Identifier');
  return {
    signed: !/code object is not signed at all/i.test(body) && (identifier !== null || directory !== null),
    adhoc: field('Signature') === 'adhoc' || /\badhoc\b/.test(directory ? directory[2] : ''),
    teamIdentifier,
    hasTeamIdentifier: teamIdentifier !== null && teamIdentifier !== 'not set',
    identifier,
    authorities: [...body.matchAll(/^Authority=(.*)$/gm)].map((match) => match[1]),
  };
}

/** Distinct first path components of `unzip -Z1` output. */
function parseZipTopLevel(listing) {
  return [...new Set(String(listing ?? '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => line.split('/')[0]))].sort();
}

/** Component, pin and net counts from the status bar text: its first three integers, whatever the UI language. */
function extractCounts(text) {
  const numbers = (String(text ?? '').match(/\d+/g) ?? []).slice(0, 3).map(Number);
  return numbers.length === 3 ? { components: numbers[0], pins: numbers[1], nets: numbers[2] } : null;
}

const sameCounts = (a, b) => Boolean(a && b && a.components === b.components && a.pins === b.pins && a.nets === b.nets);

/** A canvas reading counts as painted when enough pixels differ from its own background pixel. */
const isPainted = (stats, minimum = 100) => Boolean(stats && Number.isFinite(stats.different) && stats.different >= minimum);

/** Document rows must be exactly the expected names, all `ready`. Names are compared case-insensitively. */
function decideRows(rows, expectedNames) {
  const got = rows.map((row) => String(row.name).toLowerCase()).sort();
  const want = expectedNames.map((name) => name.toLowerCase()).sort();
  const bad = rows.filter((row) => row.status !== 'ready');
  if (JSON.stringify(got) !== JSON.stringify(want)) return { ok: false, reason: `rows are [${got.join(', ')}], expected [${want.join(', ')}]` };
  if (bad.length) return { ok: false, reason: bad.map((row) => `${row.name}=${row.status}`).join(', ') };
  return { ok: true, reason: '' };
}

/** Check manifest written by the app for the fixture board: right board key, exactly the attached documents. */
function decideManifest(manifest, { key, names }) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'no manifest' };
  if (manifest.board?.key !== key) return { ok: false, reason: 'manifest belongs to another board key' };
  const documents = Array.isArray(manifest.documents) ? manifest.documents.map((doc) => String(doc.name).toLowerCase()).sort() : [];
  const want = names.map((name) => name.toLowerCase()).sort();
  return JSON.stringify(documents) === JSON.stringify(want) ? { ok: true, reason: '' } : { ok: false, reason: `documents [${documents.join(', ')}] differ from [${want.join(', ')}]` };
}

/** A normal quit means exit code 0 without a signal and without a forced kill. */
const isCleanExit = (result) => Boolean(result) && result.code === 0 && !result.signal && !result.timedOut;

function summarizeChecks(checks) {
  const failed = checks.filter((check) => check.status === 'fail').map((check) => check.name);
  const skipped = checks.filter((check) => check.status === 'skipped').map((check) => check.name);
  return { passed: checks.length > 0 && failed.length === 0 && skipped.length === 0, failed, skipped, total: checks.length };
}

function buildEvidence(input) {
  const { checks = [], classification = null, mode = 'full' } = input;
  const summary = summarizeChecks(checks);
  return {
    schema: SCHEMA,
    disclaimer: 'Smoke evidence for an UNSIGNED/ad-hoc macOS build. Not a release acceptance, not a signing, notarization or Gatekeeper result.',
    mode,
    commit: input.commit ?? 'unknown',
    requestedArch: input.requestedArch ?? null,
    classification,
    nativeValidation: Boolean(classification && classification.native && summary.passed && mode === 'full'),
    passed: summary.passed,
    failedChecks: summary.failed,
    skippedChecks: summary.skipped,
    host: input.host ?? null,
    app: input.app ?? null,
    artifact: input.artifact ?? null,
    runtime: input.runtime ?? null,
    run: input.run ?? null,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    checks,
    notCovered: [...NOT_COVERED],
    ...(input.error ? { error: String(input.error) } : {}),
  };
}

// Deterministic original fixtures ---------------------------------------------------------------------------

function makePdf(label = 'TRACE macOS smoke fixture') {
  const content = `0.2 0.4 0.8 rg 20 20 120 70 re f\nBT /F1 14 Tf 20 120 Td (${label}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function makePng() {
  const width = 16;
  const height = 16;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // filter byte 0, then RGB
    for (let x = 0; x < width; x++) { row[1 + x * 3] = x * 16; row[2 + x * 3] = y * 16; row[3 + x * 3] = 160; }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Runs inside the renderer (serialized by Playwright): no closures allowed.
function paintInPage(selector) {
  const canvas = document.querySelector(selector);
  if (!canvas || !canvas.width || !canvas.height) return null;
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const base = [data[0], data[1], data[2]];
  let different = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (Math.abs(data[index] - base[0]) + Math.abs(data[index + 1] - base[1]) + Math.abs(data[index + 2] - base[2]) > 40) different++;
  }
  return { width: canvas.width, height: canvas.height, different };
}

// ---------------------------------------------------------------------------------------------------------
// OS part. Nothing below runs on import.
// ---------------------------------------------------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(work, { timeoutMs = 30000, intervalMs = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await work();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await delay(intervalMs);
  }
}

function tool(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: options.timeoutMs ?? 30000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error ? String(result.error.message) : null };
}

const plistValue = (plist, key) => {
  const result = tool('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
  return result.status === 0 ? result.stdout.trim() : null;
};

async function sha256File(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/** Host, bundle, binary and signature facts. Only called on macOS. */
async function collectStaticEvidence({ appPath, artifact, env }) {
  const uname = tool('/usr/bin/uname', ['-m']).stdout.trim();
  const swVers = tool('/usr/bin/sw_vers', []).stdout;
  const swField = (key) => (new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(swVers) || [])[1] ?? null;
  const optionalArm64 = tool('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']);
  // hw.optional.arm64 stays 1 on Apple silicon even when this Node process itself runs under Rosetta.
  const hostArch = optionalArm64.status === 0 && optionalArm64.stdout.trim() === '1' ? 'arm64' : normalizeArch(uname);
  const host = {
    platform: process.platform, nodeArch: process.arch, nodeVersion: process.version, unameM: uname, hostArch,
    productName: swField('ProductName'), productVersion: swField('ProductVersion'), buildVersion: swField('BuildVersion'),
  };
  const run = {
    githubRunId: env.GITHUB_RUN_ID ?? null, runnerName: env.RUNNER_NAME ?? null, runnerOs: env.RUNNER_OS ?? null,
    runnerArch: env.RUNNER_ARCH ?? null, imageOs: env.ImageOS ?? null, imageVersion: env.ImageVersion ?? null,
  };
  const contents = path.join(appPath, 'Contents');
  const plist = path.join(contents, 'Info.plist');
  const executableName = plistValue(plist, 'CFBundleExecutable') ?? path.basename(appPath, '.app');
  const executable = path.join(contents, 'MacOS', executableName);
  const exists = async (target) => fs.stat(target).then(() => true, () => false);
  const lipo = tool('/usr/bin/lipo', ['-info', executable]);
  const fileOutput = tool('/usr/bin/file', ['-b', executable]);
  const binaryArchs = parseMachArchs(`${lipo.stdout}\n${fileOutput.stdout}`);
  const describe = tool('/usr/bin/codesign', ['-dv', '--verbose=4', appPath]);
  const codesignText = `${describe.stderr}\n${describe.stdout}`;
  const verify = tool('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { timeoutMs: 120000 });
  const gatekeeper = tool('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', appPath]);
  const app = {
    path: appPath, executable, bundleId: plistValue(plist, 'CFBundleIdentifier'), shortVersion: plistValue(plist, 'CFBundleShortVersionString'),
    minimumSystemVersion: plistValue(plist, 'LSMinimumSystemVersion'), iconFile: plistValue(plist, 'CFBundleIconFile'),
    machO: { file: fileOutput.stdout.trim(), lipo: lipo.stdout.trim(), archs: binaryArchs },
    codesign: { ...parseCodesign(codesignText), describeExit: describe.status, verifyExit: verify.status, verifyOutput: (verify.stderr + verify.stdout).trim().slice(0, 600) },
    gatekeeperAssessment: { exit: gatekeeper.status, output: (gatekeeper.stderr + gatekeeper.stdout).trim().slice(0, 400), note: 'informational: an ad-hoc signed app is expected to be rejected' },
    layout: {
      appAsar: await exists(path.join(contents, 'Resources', 'app.asar')),
      appAsarUnpacked: await exists(path.join(contents, 'Resources', 'app.asar.unpacked')),
      appUpdateYml: await exists(path.join(contents, 'Resources', 'app-update.yml')),
      iconIcns: await exists(path.join(contents, 'Resources', 'icon.icns')),
    },
  };
  let artifactEvidence = null;
  if (artifact) {
    artifactEvidence = { name: path.basename(artifact), sha256: await sha256File(artifact), size: (await fs.stat(artifact)).size, zipTopLevel: null };
    if (artifact.endsWith('.zip')) artifactEvidence.zipTopLevel = parseZipTopLevel(tool('/usr/bin/unzip', ['-Z1', artifact], { timeoutMs: 120000 }).stdout);
  }
  return { host, run, app, artifact: artifactEvidence };
}

function staticChecks({ requestedArch, app, artifact }) {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, status: ok ? 'pass' : 'fail', ...(detail ? { detail } : {}) });
  add('main binary is a single-architecture Mach-O matching the requested arch', app.machO.archs.length === 1 && app.machO.archs[0] === requestedArch, `${app.machO.archs.join(',') || 'none'} (requested ${requestedArch})`);
  add('bundle identifier is hu.trace.boardviewer', app.bundleId === 'hu.trace.boardviewer', String(app.bundleId));
  add('code signature is ad-hoc with no Team ID (no certificate was used)', app.codesign.signed && app.codesign.adhoc && !app.codesign.hasTeamIdentifier && app.codesign.authorities.length === 0, JSON.stringify({ signed: app.codesign.signed, adhoc: app.codesign.adhoc, team: app.codesign.teamIdentifier }));
  add('codesign --verify --deep --strict accepts the bundle', app.codesign.verifyExit === 0, app.codesign.verifyOutput.slice(0, 200));
  add('app.asar is present and nothing is unpacked beside it (no native module shipped)', app.layout.appAsar && !app.layout.appAsarUnpacked);
  add('no app-update.yml (no repository metadata embedded)', !app.layout.appUpdateYml);
  add('icon.icns was generated into the bundle', app.layout.iconIcns);
  if (artifact && Array.isArray(artifact.zipTopLevel)) add('the zip holds exactly the .app at its top level', artifact.zipTopLevel.length === 1 && artifact.zipTopLevel[0].endsWith('.app'), artifact.zipTopLevel.join(','));
  return results;
}

async function makeTempRoot() {
  const canonical = await fs.realpath(os.tmpdir()); // /var/folders/... is a symlink to /private/var/...: use the canonical spelling the app uses
  return fs.realpath(await fs.mkdtemp(path.join(canonical, 'trace-mac-smoke-')));
}

async function quitApp(app, child, timeoutMs = 30000) {
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  await app.evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => {});
  const result = await Promise.race([exited, delay(timeoutMs).then(() => null)]);
  if (result === null) { child.kill('SIGKILL'); return { code: null, signal: 'SIGKILL', timedOut: true }; }
  return { ...result, timedOut: false };
}

/**
 * The launch-quit-restart flow. `executable` is the app binary; `argsPrefix` is only used by developer tooling that
 * drives a development Electron instead (the checks then fail honestly: not packaged, not darwin).
 * Returns { checks, runtime }.
 */
async function runFlow({ executable, argsPrefix = [], requestedArch, hostArch, keepTemp = false, log = () => {} }) {
  const { _electron } = require('playwright');
  const root = await makeTempRoot();
  const profile = path.join(root, 'profile');
  const project = path.join(root, 'project');
  await fs.mkdir(project, { recursive: true });
  const boardFile = path.join(project, FIXTURE_NAME);
  const pdfFile = path.join(project, 'macsmoke.pdf');
  const pngFile = path.join(project, 'macsmoke.png');
  await fs.writeFile(boardFile, FIXTURE_BOARD);
  await fs.writeFile(pdfFile, makePdf());
  await fs.writeFile(pngFile, makePng());
  const boardKey = sha256(Buffer.from(FIXTURE_BOARD)); // a single-file board is identified by the SHA-256 of its bytes
  const manifestFile = path.join(profile, 'workspaces', `${boardKey}.json`);

  const checks = [];
  const runtime = { appPlatform: null, appArch: null, isPackaged: null, electron: null, chrome: null, node: null, appVersion: null, locale: null, userData: null, translated: null, stderrTail: [], quits: [], supportNotice: [] };
  const errors = [];
  let aborted = false;
  let app = null;
  let child = null; // Playwright's ElectronApplication.process() throws once the app is gone, so keep the handle
  let page = null;
  const stderrLines = [];

  const step = async (name, work, { critical = false } = {}) => {
    if (aborted) { checks.push({ name, status: 'skipped', detail: 'an earlier critical step failed' }); return; }
    const started = Date.now();
    try {
      const detail = await work();
      checks.push({ name, status: 'pass', ms: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
      log(`PASS ${name}`);
    } catch (error) {
      checks.push({ name, status: 'fail', ms: Date.now() - started, detail: String(error && error.message ? error.message : error).slice(0, 500) });
      log(`FAIL ${name}: ${error && error.message}`);
      if (critical) aborted = true;
    }
  };

  const launch = async (withBoard) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VITE_DEV_SERVER_URL;
    const args = [...argsPrefix, `--user-data-dir=${profile}`, ...(withBoard ? [`--board=${boardFile}`] : [])];
    app = await _electron.launch({ executablePath: executable, args, env, timeout: 90000 });
    child = app.process();
    child.stderr?.on('data', (data) => { for (const line of String(data).split('\n')) if (line.trim()) stderrLines.push(line.trim().slice(0, 300)); });
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 200)}`); });
    await page.waitForFunction(() => Boolean(window.traceDesktop), null, { timeout: 60000 });
    await page.waitForSelector('[data-testid=project-name]', { timeout: 60000 });
  };

  const readCounts = async () => {
    await page.locator('.statusbar').waitFor({ timeout: 60000 });
    const text = await waitFor(async () => { const value = await page.locator('.status-left').innerText(); return extractCounts(value) ? value : null; }, { timeoutMs: 60000, what: 'status bar counts' });
    return extractCounts(text);
  };
  const waitPainted = async (selector, minimum, timeoutMs = 30000) => {
    let last = null;
    await waitFor(async () => { last = await page.evaluate(paintInPage, selector); return isPainted(last, minimum); }, { timeoutMs, what: `${selector} to be painted` });
    return last;
  };
  const docRows = () => page.$$eval('[data-testid=document-row]', (nodes) => nodes.map((node) => ({ name: node.querySelector('.wsp-doc-title')?.textContent ?? '', status: node.getAttribute('data-status') })));
  const waitRows = async (names) => {
    let rows = [];
    await waitFor(async () => {
      rows = await docRows();
      const failed = rows.filter((row) => ['error', 'unreadable', 'missing', 'changed'].includes(row.status));
      if (failed.length) throw new Error(`document row(s) failed: ${failed.map((row) => `${row.name}=${row.status}`).join(', ')}`);
      return decideRows(rows, names).ok;
    }, { timeoutMs: 45000, what: `document rows ${names.join(', ')} to be ready` });
    return rows;
  };
  const openDocumentsTab = async () => { await page.click('#wsp-tab-documents'); await page.waitForSelector('[data-testid=documents-tab]', { timeout: 30000 }); };
  const openRow = (name) => page.locator('[data-testid=document-row] .wsp-doc-main', { hasText: name }).click();
  // The 1.2.0 support notice is a modal <dialog> shown over the ready UI on EVERY start; it intercepts pointer events, so each
  // launch must dismiss it before the UI can be driven. The same step checks its documented behaviour: it is shown, "Not now" has the
  // focus, and Enter (the default action of the focused button) closes it. The Stripe / Ko-fi buttons are never clicked here.
  const dismissSupportNotice = async (label) => {
    await page.waitForSelector('[data-testid=support-notice]', { state: 'visible', timeout: 30000 });
    const shown = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid=support-notice]');
      const active = document.activeElement;
      return {
        modal: Boolean(dialog && dialog.matches(':modal')),
        title: dialog?.querySelector('h1,h2,h3')?.textContent ?? '',
        focus: active ? active.getAttribute('data-testid') : null,
        links: [...document.querySelectorAll('[data-support-link]')].map((node) => node.getAttribute('data-support-link')),
      };
    });
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid=support-notice]', { state: 'detached', timeout: 15000 });
    runtime.supportNotice.push({ label, ...shown });
    if (shown.focus !== 'support-not-now') throw new Error(`focus is on "${shown.focus}", not on the "Not now" button`);
    if (!shown.modal) throw new Error('the notice is not a modal dialog');
    // 1.2.0 shipped two links (stripe, kofi); later builds add 'bug' (Report a bug) between Ko-fi and "Not now". Order matters, extras do not.
    const links = shown.links.filter((id) => id !== 'bug');
    if (JSON.stringify(links) !== JSON.stringify(['stripe', 'kofi'])) throw new Error(`support links ${JSON.stringify(shown.links)}`);
    return `title "${shown.title}", Not now focused, closed with Enter`;
  };
  const quit = async (label) => {
    const result = await quitApp(app, child);
    runtime.quits.push({ label, ...result });
    app = null;
    if (!isCleanExit(result)) throw new Error(`not a normal quit: exit code ${result.code}, signal ${result.signal}${result.timedOut ? ', timed out and was killed' : ''}`);
    const leftovers = [];
    for (const directory of ['workspaces', 'notes']) {
      for (const name of await fs.readdir(path.join(profile, directory)).catch(() => [])) if (name.endsWith('.tmp')) leftovers.push(`${directory}/${name}`);
    }
    if (leftovers.length) throw new Error(`temporary files left in the profile: ${leftovers.join(', ')}`);
    return `exit code ${result.code}`;
  };

  try {
    // ---- launch 1: fresh profile, board from --board --------------------------------------------------
    await step('launch 1: the packaged app starts with an empty temporary profile and shows the UI', async () => { await launch(true); }, { critical: true });
    await step('support notice (launch 1): shown on start, "Not now" focused, Enter closes it', () => dismissSupportNotice('launch 1'), { critical: true });
    await step('runtime facts: packaged, darwin, expected arch, isolated profile', async () => {
      const facts = await app.evaluate(({ app: electronApp }) => ({
        isPackaged: electronApp.isPackaged, appVersion: electronApp.getVersion(), locale: electronApp.getLocale(), userData: electronApp.getPath('userData'),
        platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
      }));
      Object.assign(runtime, { appPlatform: facts.platform, appArch: facts.arch, isPackaged: facts.isPackaged, electron: facts.electron, chrome: facts.chrome, node: facts.node, appVersion: facts.appVersion, locale: facts.locale, userData: facts.userData });
      // Asked from inside the app process so a Rosetta-translated app answers for itself.
      const translatedRaw = await app.evaluate(() => {
        try { return { output: String(process.getBuiltinModule('node:child_process').execFileSync('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8', timeout: 5000 })), failed: false }; }
        catch (error) { return { output: '', failed: true, message: String(error && error.message).slice(0, 200) }; }
      });
      runtime.translated = parseTranslated({ ...translatedRaw, hostArch });
      const problems = [];
      if (facts.platform !== 'darwin') problems.push(`the app reports platform ${facts.platform}`);
      if (facts.isPackaged !== true) problems.push('the app is not packaged');
      if (facts.arch !== requestedArch) problems.push(`the app process is ${facts.arch}, requested ${requestedArch}`);
      if (path.resolve(facts.userData) !== path.resolve(profile)) problems.push(`userData is ${facts.userData}, not the temporary profile`);
      if (problems.length) throw new Error(problems.join('; '));
      return `electron ${facts.electron}, ${facts.platform}/${facts.arch}, translated=${runtime.translated}`;
    });
    await step('renderer is isolated: bridge present, no Node globals', async () => {
      const surface = await page.evaluate(() => ({ bridge: typeof window.traceDesktop, require: typeof window.require, process: typeof window.process }));
      if (surface.bridge !== 'object' || surface.require !== 'undefined' || surface.process !== 'undefined') throw new Error(JSON.stringify(surface));
    });
    await step('exactly one window exists after launch (an early activate event must not create a second one)', async () => {
      await delay(2000);
      const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      if (count !== 1) throw new Error(`${count} windows`);
    });
    await step('board import through the real UI path: counts match and the canvas is painted', async () => {
      const name = (await page.textContent('[data-testid=project-name]')) ?? '';
      if (!/MacSmoke/i.test(name)) throw new Error(`project name is "${name}"`);
      const counts = await readCounts();
      if (!sameCounts(counts, EXPECTED_COUNTS)) throw new Error(`counts ${JSON.stringify(counts)}, expected ${JSON.stringify(EXPECTED_COUNTS)}`);
      const stats = await waitPainted('[data-testid=board-pane] canvas', 100);
      return { counts, canvas: stats };
    });
    await step('document attach: a PDF and a PNG become ready rows (file chooser replaced in the main process)', async () => {
      await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [pdfFile, pngFile]);
      await openDocumentsTab();
      await page.locator('[data-testid=attach]').first().click();
      return JSON.stringify(await waitRows(DOCUMENT_NAMES));
    });
    await step('the PDF renders in the packaged app (pdf.js worker loaded from the asar)', async () => {
      await openRow('macsmoke.pdf');
      await page.waitForSelector('[data-testid=documents-tab] .pdfv-page[data-render=done]', { timeout: 45000 });
      return await waitPainted('.pdfv-page canvas', 150, 15000);
    });
    await step('the PNG decodes and is drawn', async () => {
      await openRow('macsmoke.png');
      await page.waitForSelector('[data-testid=documents-tab] .imgv[data-phase=ready]', { timeout: 45000 });
      return await waitPainted('.imgv-canvas', 50, 15000);
    });
    await step('workspace save: the manifest for this board is written with both documents', async () => {
      const manifest = await waitFor(async () => {
        try { const parsed = JSON.parse(await fs.readFile(manifestFile, 'utf8')); return decideManifest(parsed, { key: boardKey, names: DOCUMENT_NAMES }).ok ? parsed : null; } catch { return null; }
      }, { timeoutMs: 30000, what: 'the workspace manifest' });
      return `${manifest.documents.length} documents, board ${manifest.board.name}`;
    });
    await step('normal quit (app.quit) ends the process with exit code 0 and leaves no temporary files', () => quit('after launch 1'), { critical: true });

    // ---- launch 2: same profile, no --board -------------------------------------------------------------
    await step('launch 2: restart with the SAME profile and no --board', async () => { await launch(false); }, { critical: true });
    await step('support notice (launch 2): shown again on the next start, "Not now" focused, Enter closes it', () => dismissSupportNotice('launch 2'), { critical: true });
    await step('restore: the last board returns from the recents and renders', async () => {
      await page.click('#wsp-tab-board'); // the workspace may have been saved while another tab was active
      await page.waitForSelector('[data-testid=board-pane] canvas', { timeout: 30000 });
      const recents = await page.evaluate(() => window.traceDesktop.recentBoards());
      if (!recents.some((item) => path.resolve(item.path) === path.resolve(boardFile))) throw new Error(`recents: ${JSON.stringify(recents.map((item) => item.path))}`);
      const counts = await readCounts();
      if (!sameCounts(counts, EXPECTED_COUNTS)) throw new Error(`counts ${JSON.stringify(counts)}`);
      return { recents: recents.length, canvas: await waitPainted('[data-testid=board-pane] canvas', 100) };
    });
    await step('restore: the workspace documents are remembered and ready', async () => {
      await openDocumentsTab();
      return JSON.stringify(await waitRows(DOCUMENT_NAMES));
    });
    await step('darwin lifecycle (simulated): closing the last window keeps the app alive and activate opens a window', async () => {
      await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); });
      await waitFor(async () => (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 0, { timeoutMs: 15000, what: 'the window to close' });
      await delay(1500);
      if (child.exitCode !== null) throw new Error(`the app exited with ${child.exitCode} after its last window closed`);
      await app.evaluate(({ app: electronApp }) => { electronApp.emit('activate', {}, false); }); // simulation: NOT a real Dock click
      await waitFor(async () => (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1, { timeoutMs: 20000, what: 'activate to open a window' });
    });
    await step('normal quit again ends with exit code 0', () => quit('after launch 2'));
    await step('no uncaught page errors or renderer console errors in either launch', async () => { if (errors.length) throw new Error(errors.slice(0, 4).join(' | ')); });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    runtime.stderrTail = stderrLines.slice(-20);
    const resolved = path.resolve(root);
    if (!keepTemp && resolved.startsWith(`${path.resolve(await fs.realpath(os.tmpdir()))}${path.sep}`)) await fs.rm(resolved, { recursive: true, force: true });
  }
  return { checks, runtime };
}

/** macOS only: gathers evidence, runs the flow unless --evidence-only, writes the evidence JSON. */
async function runSmoke(options) {
  const gate = platformGate(process.platform);
  if (!gate.allowed) throw new Error(gate.message);
  const { app: appPath, arch, out, commit, artifact, evidenceOnly = false, keepTemp = false, env = process.env, log = console.log } = options;
  const startedAt = new Date().toISOString();
  const absoluteApp = path.resolve(appPath);
  let evidence;
  let error = null;
  let stat = { host: null, run: null, app: null, artifact: null };
  let checks = [];
  let runtime = null;
  let classification = null;
  try {
    if (!(await fs.stat(absoluteApp).then((entry) => entry.isDirectory(), () => false))) throw new Error(`not a directory: ${absoluteApp}`);
    stat = await collectStaticEvidence({ appPath: absoluteApp, artifact: artifact ? path.resolve(artifact) : null, env });
    checks = staticChecks({ requestedArch: arch, app: stat.app, artifact: stat.artifact });
    if (!evidenceOnly) {
      const flow = await runFlow({ executable: stat.app.executable, requestedArch: arch, hostArch: stat.host.hostArch, keepTemp, log });
      checks = checks.concat(flow.checks);
      runtime = flow.runtime;
    }
    classification = classifyValidation({ requestedArch: arch, binaryArchs: stat.app.machO.archs, hostArch: stat.host.hostArch, translated: runtime ? runtime.translated : null });
  } catch (caught) {
    error = caught && caught.stack ? caught.stack : String(caught);
    log(`ERROR ${error}`);
  } finally {
    evidence = buildEvidence({
      commit, requestedArch: arch, classification, mode: evidenceOnly ? 'evidence-only' : 'full', checks, host: stat.host, app: stat.app, artifact: stat.artifact,
      runtime, run: stat.run, startedAt, finishedAt: new Date().toISOString(), error,
    });
    const target = path.resolve(out || path.join('test-results', 'mac', `mac-smoke-evidence-${arch}.json`));
    await fs.mkdir(path.dirname(target), { recursive: true });
    const home = os.homedir();
    const text = `${JSON.stringify(evidence, null, 2)}\n`;
    await fs.writeFile(target, home && home.length > 1 ? text.split(home).join('~') : text);
    log(`Evidence: ${target}`);
    evidence.path = target;
  }
  return evidence;
}

async function main(argv, env = process.env) {
  const gate = platformGate(process.platform);
  if (!gate.allowed) { console.error(gate.message); return EXIT.REFUSED; }
  const parsed = parseArgs(argv, env);
  if (parsed.help || parsed.errors.length) {
    for (const message of parsed.errors) console.error(`mac-smoke: ${message}`);
    console.error(USAGE);
    return parsed.help && !parsed.errors.length ? EXIT.OK : EXIT.REFUSED;
  }
  const evidence = await runSmoke({ ...parsed, env });
  console.log(`${evidence.passed ? 'PASSED' : 'FAILED'}: ${evidence.classification ? evidence.classification.label : 'no classification'}${evidence.nativeValidation ? '' : ' (not accepted as native validation)'}`);
  return evidence.passed ? EXIT.OK : EXIT.FAILED;
}

module.exports = Object.freeze({
  EXIT, SCHEMA, FIXTURE_NAME, FIXTURE_BOARD, EXPECTED_COUNTS, DOCUMENT_NAMES, NOT_COVERED, USAGE,
  platformGate, normalizeArch, parseArgs, parseMachArchs, parseTranslated, classifyValidation, parseCodesign, parseZipTopLevel,
  extractCounts, sameCounts, isPainted, decideRows, decideManifest, isCleanExit, summarizeChecks, buildEvidence,
  makePdf, makePng, sha256, runFlow, runSmoke, main,
});

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = EXIT.FAILED; });
}
