'use strict';

// Smoke test for the PACKAGED experimental Linux builds of config/electron-builder.linux.yml: the .deb, the AppImage and the
// unpacked app (release-linux/linux-unpacked).
//
//   node scripts/linux-smoke.cjs static --appimage <file> --deb <file> --unpacked <dir> --arch x64 [--out <json>]
//   node scripts/linux-smoke.cjs run --scenario S1 --target installed|appimage|unpacked [--appimage <file>] [--unpacked <dir>]
//        [--executable <path>] --arch x64 --userns restricted|allowed --expect-sandbox on|off --expect-gate yes|no
//        [--out <json>] [--commit <sha>] [--keep-temp]
//   node scripts/linux-smoke.cjs summary --dir test-results/linux       (Markdown for $GITHUB_STEP_SUMMARY)
//
// "static" and "run" refuse to run anywhere but Linux (exit 2), so they never produce Linux evidence elsewhere. With --dry-run they
// only print what they would check and launch (resolved paths, arguments, environment changes) and touch nothing; that, and
// "summary", run on any OS. Exit codes: 0 = every check passed, 1 = a check failed, 2 = refused or bad arguments.
//
// "static" checks the three build outputs without starting them: ELF architecture, layout, fuse wire, the AppImage contents and
// desktop entry, the .deb control fields, file list, desktop entry, AppArmor profile and maintainer scripts.
//
// "run" drives one packaged build through Playwright with synthetic data in a private temporary directory: launch with an empty
// --user-data-dir and a generated board, the support notice, runtime facts, renderer isolation, the Chromium sandbox state read from
// /proc (renderer Seccomp mode and PID namespace depth), board import, PDF and PNG attach, the workspace manifest, a normal quit,
// a relaunch that restores board and documents, the X11 window class and icon, the bug-report link through a stand-in xdg-open,
// single instance (a file:// URI and a relative path from a second process), and the default profile location under a temporary
// HOME. Where the system makes the AppImage start without the sandbox (--expect-gate yes), the app's consent dialog must appear
// before any window. The script answers it on the X display in profiles of its own: once with the default (Quit: the app must end
// with exit code 0, without a window and without storing anything), once with "Start without sandbox" and "Do not ask again" (the
// window must open and config.json must hold "noSandboxAccepted": true), then a relaunch of that profile must start without asking.
// The packaged-app flow of that scenario runs with TRACE_ACCEPT_NO_SANDBOX=1, so it never depends on the dialog automation. Where the
// sandbox is expected on, no dialog and no warning line may appear.
//
// The sandbox is never switched off by this script: Playwright is told to keep Chromium's sandbox (chromiumSandbox: true; without it
// Playwright adds the sandbox-off switch on Linux) and every argument list is checked before a launch. Only the AppImage launcher
// itself may add that switch, which is exactly what scenario S2 observes.
//
// Honest limits: the native file chooser is replaced in the main process, the X display is Xvfb without a window manager, and the
// result says nothing about real desktop sessions; see NOT_COVERED. The decision logic below is pure and exported so
// tests/linux-workflow-checks.cjs can exercise it on any OS; the code that talks to Linux or to the app only runs from main().

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
// The fixtures and the pure decisions are shared with the macOS smoke test. Importing it runs nothing.
const mac = require('./mac-smoke.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXIT = Object.freeze({ OK: 0, FAILED: 1, REFUSED: 2 });
const SCHEMA = 'trace-linux-smoke-evidence/1';
const COMMANDS = Object.freeze(['static', 'run', 'summary']);
const TARGETS = Object.freeze(['installed', 'appimage', 'unpacked']);
const TARGET_LABELS = Object.freeze({ installed: 'installed .deb', appimage: 'AppImage', unpacked: 'unpacked app' });

// Names fixed by config/electron-builder.linux.yml (tests/linux-workflow-checks.cjs compares them with the config).
const PRODUCT_NAME = 'TRACE Boardviewer';
const EXECUTABLE_NAME = 'trace-boardviewer';
const DESKTOP_FILE = `${EXECUTABLE_NAME}.desktop`;
const INSTALL_DIR = `/opt/${PRODUCT_NAME}`;
const INSTALLED_EXECUTABLE = `${INSTALL_DIR}/${EXECUTABLE_NAME}`;
const DEB_PACKAGE = 'trace-boardviewer';
const MAINTAINER = 'TRACE Boardviewer <noreply@trace-boardviewer.invalid>';
const MAINTAINER_ADDRESS = 'noreply@trace-boardviewer.invalid';
const CATEGORIES = 'Development;Electronics;';
// The icon is the SVG asset, installed as hicolor/scalable/apps/<executable>.svg in both packages.
const ICON_PATH = `usr/share/icons/hicolor/scalable/apps/${EXECUTABLE_NAME}.svg`;
const ARCHES = Object.freeze({
  x64: Object.freeze({ elfMachine: 0x3e, deb: 'amd64', appimage: 'x86_64', unpackedDir: 'linux-unpacked' }),
  arm64: Object.freeze({ elfMachine: 0xb7, deb: 'arm64', appimage: 'arm64', unpackedDir: 'linux-arm64-unpacked' }),
});
const BUILD_PATH_PATTERN = /\/Users\/runner|\/home\/runner|runner\/work/i;

// The Linux sandbox consent gate of electron/main.cjs (confirmUnsandboxedStart). tests/linux-workflow-checks.cjs keeps these in step
// with the main process and the English catalog. "Do not ask again" is stored as "noSandboxAccepted": true in <profile>/config.json.
const GATE = Object.freeze({
  stderrLine: 'TRACE: running without the Chromium sandbox (--no-sandbox).',
  acceptEnv: 'TRACE_ACCEPT_NO_SANDBOX',
  configFile: 'config.json',
  acceptedKey: 'noSandboxAccepted',
  buttons: Object.freeze(['Quit', 'Start without sandbox']),
  checkbox: 'Do not ask again',
  title: PRODUCT_NAME,
});
// Chromium switches that turn (part of) the OS sandbox off. None of them is ever passed by this script.
const SANDBOX_OFF_SWITCHES = Object.freeze(['no-sandbox', 'disable-setuid-sandbox', 'disable-namespace-sandbox', 'disable-seccomp-filter-sandbox', 'no-zygote-sandbox']);

const FIXTURE_NAME = 'LinuxSmoke.cad';
const SECOND_FIXTURE_NAME = 'LinuxSmokeTwo.cad';
const DOCUMENT_NAMES = Object.freeze(['linuxsmoke.pdf', 'linuxsmoke.png']);
const FIXTURE_BOARD = mac.FIXTURE_BOARD;
// Same parts, pins and nets, one placement moved: different bytes, so a different board key and project.
const SECOND_FIXTURE_BOARD = mac.FIXTURE_BOARD.replace('PLACE 22 10', 'PLACE 23 10');
const EXPECTED_COUNTS = mac.EXPECTED_COUNTS;

// Fuse names of @electron/fuses 1.8.0 (FuseV1Options) by the config key that sets them.
const FUSE_INDEX = Object.freeze({
  runAsNode: 0, enableCookieEncryption: 1, enableNodeOptionsEnvironmentVariable: 2, enableNodeCliInspectArguments: 3,
  enableEmbeddedAsarIntegrityValidation: 4, onlyLoadAppFromAsar: 5, loadBrowserProcessSpecificV8Snapshot: 6, grantFileProtocolExtraPrivileges: 7,
});
const FUSE_NAMES = Object.freeze(['RunAsNode', 'EnableCookieEncryption', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar', 'LoadBrowserProcessSpecificV8Snapshot', 'GrantFileProtocolExtraPrivileges']);
const FUSE_STATES = Object.freeze({ 48: 'DISABLE', 49: 'ENABLE', 114: 'REMOVED', 144: 'INHERIT' });

const NOT_COVERED = Object.freeze([
  'Real desktop sessions: GNOME, KDE and other environments, Wayland (CI uses Xvfb without a window manager, X11 only)',
  'HiDPI and fractional scaling',
  'The native GTK / portal file chooser (replaced in the main process) and drag-and-drop from a file manager',
  'AppImage desktop integration tools and menu entries created by them',
  'Distributions and releases other than Ubuntu 24.04, and arm64',
  'Keyring prompts on a real desktop (the cookie-encryption fuse)',
  '.deb upgrade and removal beyond one installation',
  'Frameless window resize, maximize and snapping behaviour under real window managers',
  'Performance, memory, suspend and resume',
  'Real customer boards, licensed samples or any user profile (none were used)',
]);

const USAGE = [
  'Usage:',
  '  node scripts/linux-smoke.cjs static --appimage <file> --deb <file> --unpacked <dir> --arch <x64|arm64> [--out <json>] [--dry-run]',
  '  node scripts/linux-smoke.cjs run --scenario <S1..S9> --target <installed|appimage|unpacked> [--appimage <file>] [--unpacked <dir>]',
  '       [--executable <path>] --arch <x64|arm64> --userns <restricted|allowed> --expect-sandbox <on|off> --expect-gate <yes|no>',
  '       [--out <json>] [--commit <sha>] [--keep-temp] [--dry-run]',
  '  node scripts/linux-smoke.cjs summary --dir <directory with evidence JSON files>',
].join('\n');

// ---------------------------------------------------------------------------------------------------------
// Pure decision logic (no OS access): exported for tests.
// ---------------------------------------------------------------------------------------------------------

/** The one gate that keeps Windows and macOS runs from ever producing Linux evidence. */
function platformGate(platform) {
  if (platform === 'linux') return { allowed: true, message: '' };
  return {
    allowed: false,
    message: `linux-smoke.cjs refuses to run on "${platform}": "static" and "run" only run on Linux, because their result is Linux evidence and must never be produced anywhere else ("summary" and --dry-run work everywhere).`,
  };
}

const VALUED = Object.freeze({
  '--appimage': 'appimage', '--deb': 'deb', '--unpacked': 'unpacked', '--executable': 'executable', '--target': 'target', '--arch': 'arch',
  '--scenario': 'scenario', '--userns': 'userns', '--expect-sandbox': 'expectSandbox', '--expect-gate': 'expectGate', '--out': 'out',
  '--dir': 'dir', '--commit': 'commit',
});
const FLAGS = Object.freeze({ '--keep-temp': 'keepTemp', '--dry-run': 'dryRun', '--help': 'help', '-h': 'help' });
const ALLOWED = Object.freeze({
  static: ['appimage', 'deb', 'unpacked', 'arch', 'out', 'commit', 'dryRun', 'help'],
  run: ['scenario', 'target', 'appimage', 'unpacked', 'executable', 'arch', 'userns', 'expectSandbox', 'expectGate', 'out', 'commit', 'keepTemp', 'dryRun', 'help'],
  summary: ['dir', 'help'],
});
const optionName = (key) => Object.keys(VALUED).find((name) => VALUED[name] === key) ?? Object.keys(FLAGS).find((name) => FLAGS[name] === key) ?? key;

function parseArgs(argv, env = {}) {
  const parsed = {
    command: null, appimage: null, deb: null, unpacked: null, executable: null, target: null, arch: null, scenario: null, userns: null,
    expectSandbox: null, expectGate: null, out: null, dir: null, commit: env.GITHUB_SHA || null, keepTemp: false, dryRun: false, help: false, errors: [],
  };
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) {
    parsed.errors.push(command ? `unknown command ${command} (static, run or summary)` : 'a command is required: static, run or summary');
    return parsed;
  }
  parsed.command = command;
  const given = new Set();
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    const equal = argument.indexOf('=');
    const name = equal > 0 ? argument.slice(0, equal) : argument;
    if (Object.hasOwn(FLAGS, name)) {
      if (equal > 0) parsed.errors.push(`${name} takes no value`);
      else { parsed[FLAGS[name]] = true; given.add(FLAGS[name]); }
    } else if (Object.hasOwn(VALUED, name)) {
      const value = equal > 0 ? argument.slice(equal + 1) : rest[++index];
      if (value === undefined || value === '' || value.startsWith('--')) parsed.errors.push(`${name} needs a value`);
      else { parsed[VALUED[name]] = value; given.add(VALUED[name]); }
    } else parsed.errors.push(`unknown argument ${argument}`);
  }
  for (const key of given) if (!ALLOWED[command].includes(key) && key !== 'commit') parsed.errors.push(`${optionName(key)} is not an option of "${command}"`);
  if (parsed.help) return parsed;
  const oneOf = (key, values) => {
    if (!parsed[key]) parsed.errors.push(`${optionName(key)} is required`);
    else if (!values.includes(parsed[key])) parsed.errors.push(`${optionName(key)} must be one of ${values.join(', ')}`);
  };
  if (command === 'static') {
    if (!parsed.appimage) parsed.errors.push('--appimage is required');
    else if (!/\.AppImage$/.test(parsed.appimage)) parsed.errors.push('--appimage must name a .AppImage file');
    if (!parsed.deb) parsed.errors.push('--deb is required');
    else if (!/\.deb$/.test(parsed.deb)) parsed.errors.push('--deb must name a .deb file');
    if (!parsed.unpacked) parsed.errors.push('--unpacked is required');
    oneOf('arch', Object.keys(ARCHES));
  } else if (command === 'run') {
    if (!parsed.scenario) parsed.errors.push('--scenario is required');
    else if (!/^S[1-9]$/.test(parsed.scenario)) parsed.errors.push('--scenario must be S1 to S9');
    oneOf('target', TARGETS);
    oneOf('arch', Object.keys(ARCHES));
    oneOf('userns', ['restricted', 'allowed']);
    oneOf('expectSandbox', ['on', 'off']);
    oneOf('expectGate', ['yes', 'no']);
    // The gate asks exactly when the process runs without the sandbox; any other combination cannot be a correct expectation.
    if (parsed.expectGate === 'yes' && parsed.expectSandbox === 'on') parsed.errors.push('--expect-gate yes needs --expect-sandbox off (the consent dialog only appears without the sandbox)');
    if (parsed.expectGate === 'no' && parsed.expectSandbox === 'off') parsed.errors.push('--expect-sandbox off needs --expect-gate yes (a process without the sandbox must ask first)');
    if (parsed.appimage && parsed.target && parsed.target !== 'appimage') parsed.errors.push('--appimage is only used with --target appimage');
    if (parsed.unpacked && parsed.target && parsed.target !== 'unpacked') parsed.errors.push('--unpacked is only used with --target unpacked');
    if (parsed.target === 'appimage') {
      const file = parsed.executable || parsed.appimage;
      if (!file) parsed.errors.push('--target appimage needs --appimage <file>');
      else if (!/\.AppImage$/.test(file)) parsed.errors.push('the AppImage must be a .AppImage file');
    }
    if (parsed.target === 'unpacked' && !parsed.unpacked && !parsed.executable) parsed.errors.push('--target unpacked needs --unpacked <dir>');
  } else if (!parsed.dir) parsed.errors.push('--dir is required');
  return parsed;
}

/** The executable a run starts: computed from the target unless --executable names it. POSIX paths, not resolved. */
function executableFor({ target, appimage, unpacked, executable }) {
  if (executable) return executable;
  if (target === 'installed') return INSTALLED_EXECUTABLE;
  if (target === 'appimage') return appimage ?? null;
  if (target === 'unpacked' && unpacked) return path.posix.join(unpacked, EXECUTABLE_NAME);
  return null;
}

/** Release file name of one package, as config/electron-builder.linux.yml names it (arch token per format). */
function artifactFileName(version, arch, ext) {
  const tokens = ARCHES[arch];
  if (!tokens) throw new Error(`unknown architecture ${arch}`);
  return `TRACE-Boardviewer-${version}-linux-${ext === 'AppImage' ? tokens.appimage : tokens.deb}.${ext}`;
}

const DEFAULT_OUT = Object.freeze({ static: 'test-results/linux/linux-static.json' });
function defaultOut(parsed) {
  return parsed.command === 'run' ? `test-results/linux/smoke-${parsed.scenario}-${parsed.target}.json` : DEFAULT_OUT.static;
}

const shQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

/**
 * The launcher Playwright starts for one launch: it execs the app under test with exactly the arguments it was given and copies
 * the app's stderr into a file from the first line on, while Playwright keeps reading the same stream (it needs the "DevTools
 * listening" line). exec keeps the process id, so the process Playwright holds IS the app (an AppImage runtime execs AppRun, which
 * execs the app; an AppArmor profile attaches by the executable path as usual).
 */
function wrapperScript({ target, stderrFile }) {
  return [
    '#!/bin/bash',
    '# Written by scripts/linux-smoke.cjs for one launch: starts the app under test with the arguments given here and copies its stderr',
    '# into a file. Nothing is added to the arguments.',
    `exec ${shQuote(target)} "$@" 2> >(exec tee -a -- ${shQuote(stderrFile)} >&2)`,
    '',
  ].join('\n');
}

/** Throws when an argument list would switch the Chromium sandbox off. */
function assertSandboxKept(args) {
  for (const argument of args) {
    const match = /^--([a-z-]+)(?:=|$)/.exec(String(argument));
    if (match && SANDBOX_OFF_SWITCHES.includes(match[1])) throw new Error(`refusing to launch with ${match[0]}: this smoke test never switches the sandbox off`);
  }
  return args;
}

/** file:// URI of an absolute POSIX path, as a desktop launcher passes it for %U. */
const fileUri = (file) => `file://${String(file).split('/').map((part) => encodeURIComponent(part)).join('/')}`;

/**
 * Arguments of one launch: the app reads --user-data-dir, --board and a bare board argument (a path or a file:// URI); Playwright adds
 * only its two debugging switches.
 */
function launchArgs({ profile = null, board = null, positional = null } = {}) {
  const args = [];
  if (profile) args.push(`--user-data-dir=${profile}`);
  if (board) args.push(`--board=${board}`);
  if (positional) args.push(positional);
  return assertSandboxKept(args);
}

// Inherited variables that would change what is tested: a runtime switch, a dev-server URL, a desktop name or AppImage state left
// over from the caller, the consent bypass.
const SCRUBBED_ENV = Object.freeze(['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'NODE_OPTIONS', 'CHROME_DESKTOP', 'APPDIR', 'APPIMAGE', 'ARGV0', 'OWD',
  'APPIMAGE_EXTRACT_AND_RUN', GATE.acceptEnv]);

/** Environment of one launch. */
function launchEnvironment(base, { stubBin, xdgRecord, home = null, acceptNoSandbox = false, appimageExtractAndRun = false }) {
  const env = { ...base };
  for (const name of SCRUBBED_ENV) delete env[name];
  env.PATH = base.PATH ? `${stubBin}:${base.PATH}` : stubBin;
  env.TRACE_SMOKE_XDG_RECORD = xdgRecord;
  if (home) {
    // The documented default: XDG_CONFIG_HOME unset, so the profile goes to $HOME/.config/trace-boardviewer.
    env.HOME = home;
    delete env.XDG_CONFIG_HOME;
  }
  if (acceptNoSandbox) env[GATE.acceptEnv] = '1';
  if (appimageExtractAndRun) env.APPIMAGE_EXTRACT_AND_RUN = '1';
  return env;
}

/** What launchEnvironment changed, for the evidence and the dry run (values of unchanged variables are never listed). */
function environmentChanges(base, next) {
  const set = {};
  const unset = [];
  for (const [name, value] of Object.entries(next)) if (base[name] !== value) set[name] = name === 'PATH' ? `${value.split(':')[0]}:<inherited PATH>` : value;
  for (const name of Object.keys(base)) if (!(name in next)) unset.push(name);
  return { set, unset: unset.sort() };
}

/**
 * The launches of one run, in order. profile: 'main' | 'gate' | 'gate-quit' | null (no --user-data-dir: the default location); board:
 * 'first' (--board) or null; positional: a bare board argument ('second-uri': a file:// URI, 'first-relative': a path relative to cwd);
 * gate: what must happen with the consent dialog ('quit' and 'start-remember' answer it, 'absent' means it must not appear);
 * acceptNoSandbox: TRACE_ACCEPT_NO_SANDBOX=1 for this launch; spawnOnly: started without Playwright (a second instance).
 */
function launchSpecs({ expectGate }) {
  const gate = expectGate === 'yes' || expectGate === true;
  const spec = (label, fields) => ({ label, profile: 'main', board: null, positional: null, cwd: null, home: false, acceptNoSandbox: gate, gate: 'absent', spawnOnly: false, ...fields });
  const specs = [];
  if (gate) {
    // The consent dialog itself, in profiles of its own: answered with the default (Quit), answered with "Start without sandbox" and
    // "Do not ask again", then a relaunch that must skip it because of the stored answer. These launches never set the bypass.
    specs.push(spec('gate-quit', { profile: 'gate-quit', board: 'first', acceptNoSandbox: false, gate: 'quit' }));
    specs.push(spec('gate-start', { profile: 'gate', board: 'first', acceptNoSandbox: false, gate: 'start-remember' }));
    specs.push(spec('gate-remembered', { profile: 'gate', acceptNoSandbox: false }));
  }
  // The packaged-app flow. Without the sandbox (S2) every one of these launches sets TRACE_ACCEPT_NO_SANDBOX=1, so a problem with
  // answering the dialog on the display can never block the rest of the scenario.
  specs.push(spec('launch-1', { board: 'first' }));
  specs.push(spec('launch-2', {}));
  specs.push(spec('second-instance-uri', { positional: 'second-uri', cwd: 'root', spawnOnly: true }));
  specs.push(spec('second-instance-relative', { positional: 'first-relative', cwd: 'project', spawnOnly: true }));
  specs.push(spec('default-location', { profile: null, home: true }));
  return specs;
}

/** Concrete profile, arguments and working directory of one spec inside a run's directories. */
function resolveSpec(spec, dirs) {
  const profile = { main: dirs.profile, gate: dirs.gateProfile, 'gate-quit': dirs.gateQuitProfile }[spec.profile] ?? null;
  const board = spec.board === 'first' ? dirs.board : null;
  const positional = spec.positional === 'second-uri' ? fileUri(dirs.secondBoard) : spec.positional === 'first-relative' ? FIXTURE_NAME : null;
  const cwd = spec.cwd === 'root' ? dirs.root : spec.cwd === 'project' ? dirs.project : null;
  return { profile, args: launchArgs({ profile, board, positional }), cwd };
}

/** Fields of /proc/<pid>/status that show the sandbox: Seccomp mode (2 = filter) and the PID in every nested PID namespace. */
function parseProcStatus(text) {
  const body = String(text ?? '');
  const field = (key) => { const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(body); return match ? match[1].trim() : null; };
  const number = (value) => (value === null || value === '' || !/^-?\d+$/.test(value) ? null : Number(value));
  const nspid = field('NSpid');
  return {
    name: field('Name'), pid: number(field('Pid')), seccomp: number(field('Seccomp')), seccompFilters: number(field('Seccomp_filters')),
    nspid: nspid ? nspid.split(/\s+/).filter((part) => /^\d+$/.test(part)).map(Number) : [],
  };
}

/**
 * Sandbox state from /proc facts. "on": every renderer runs a seccomp-bpf filter (Seccomp 2) inside a PID namespace nested below the
 * browser's (both the namespace and the SUID sandbox create one) and the process has no sandbox-off switch. "off": no filter and the
 * browser's own PID namespace for every renderer. Anything else is "mixed"; missing facts are "unknown".
 */
function classifySandbox({ browser, renderers, noSandboxSwitch }) {
  if (!browser || !Array.isArray(browser.nspid) || browser.nspid.length === 0 || !Array.isArray(renderers) || renderers.length === 0) return 'unknown';
  const states = renderers.map((renderer) => {
    if (!renderer || renderer.seccomp === null || renderer.seccomp === undefined || !Array.isArray(renderer.nspid) || renderer.nspid.length === 0) return 'unknown';
    const nested = renderer.nspid.length > browser.nspid.length;
    if (renderer.seccomp === 2 && nested) return 'on';
    if (renderer.seccomp === 0 && !nested) return 'off';
    return 'mixed';
  });
  if (states.includes('unknown')) return 'unknown';
  if (states.every((state) => state === 'on')) return noSandboxSwitch === true ? 'mixed' : 'on';
  if (states.every((state) => state === 'off')) return 'off';
  return 'mixed';
}

/** The sandbox state a scenario expects, plus the AppArmor label the installed .deb must give the app. Returns problems. */
function decideSandbox({ expectSandbox, classification, target, browserLabel }) {
  const problems = [];
  if (classification !== expectSandbox) problems.push(`sandbox is ${classification}, expected ${expectSandbox}`);
  if (target === 'installed' && !/^trace-boardviewer\b/.test(String(browserLabel ?? ''))) problems.push(`the app runs under the AppArmor label "${browserLabel}", not the trace-boardviewer profile of the .deb`);
  return problems;
}

/** Whether the host is in the user-namespace state the scenario needs. sysctl null = the knob does not exist (no restriction). */
function decideUserns({ expected, sysctl, unshareOk }) {
  const problems = [];
  if (expected === 'restricted') {
    if (sysctl !== 1) problems.push(`kernel.apparmor_restrict_unprivileged_userns is ${sysctl}, expected 1`);
    if (unshareOk !== false) problems.push('unshare -Ur true succeeded, so unprivileged user namespaces are not restricted');
  } else {
    if (sysctl !== 0 && sysctl !== null) problems.push(`kernel.apparmor_restrict_unprivileged_userns is ${sysctl}, expected 0`);
    if (unshareOk !== true) problems.push('unshare -Ur true failed, so unprivileged user namespaces are not available');
  }
  return problems;
}

/**
 * Problems of one launch record against what its spec expects from the consent dialog.
 * record: { gate: { shown, browserWindows, noSandboxSwitch, warningLogged } | null, windowShown, exit, answerStored }
 * answerStored: whether <profile>/config.json holds "noSandboxAccepted": true after the launch.
 */
function decideGate(expectation, record) {
  const problems = [];
  const gate = record.gate ?? { shown: false };
  if (expectation === 'quit' || expectation === 'start-remember') {
    if (!gate.shown) problems.push('the consent dialog did not appear');
    else {
      if (gate.browserWindows !== 0) problems.push(`${gate.browserWindows} window(s) existed while the dialog was up; the dialog must come first`);
      if (gate.noSandboxSwitch !== true) problems.push('the process asking for consent has no sandbox-off switch');
      if (gate.warningLogged !== true) problems.push('the warning line was not written to stderr');
    }
    if (expectation === 'quit') {
      if (record.windowShown) problems.push('a window opened after Quit');
      if (!record.exit || record.exit.code !== 0 || record.exit.signal || record.exit.timedOut) problems.push(`Quit did not end the app with exit code 0 (${JSON.stringify(record.exit)})`);
      if (record.answerStored) problems.push(`Quit stored ${GATE.acceptedKey}`);
    } else {
      if (!record.windowShown) problems.push('no window opened after "Start without sandbox"');
      if (!record.answerStored) problems.push(`"Do not ask again" did not store ${GATE.acceptedKey}: true in ${GATE.configFile} (the Space key may not have reached the check box)`);
    }
  } else {
    if (gate.shown) problems.push('a consent dialog appeared although none was expected');
    if (!record.windowShown) problems.push('no window opened');
  }
  return problems;
}

/** INI-style parse of a .desktop file: every group with its keys, plus duplicate keys. */
function parseDesktopEntry(text) {
  const groups = {};
  const duplicates = [];
  let current = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) { current = header[1]; groups[current] ??= {}; continue; }
    const equal = raw.indexOf('=');
    if (current === null || equal < 1) continue;
    const key = raw.slice(0, equal).trim();
    const value = raw.slice(equal + 1).trim();
    if (Object.hasOwn(groups[current], key)) duplicates.push(`${current}/${key}`);
    groups[current][key] = value;
  }
  return { entry: groups['Desktop Entry'] ?? null, groups, duplicates };
}

/** Problems of a desktop entry generated for the AppImage ("appimage") or the .deb ("deb"). */
function checkDesktopEntry(parsed, { kind, version = null }) {
  const problems = [];
  const entry = parsed && parsed.entry;
  if (!entry) return ['no [Desktop Entry] group'];
  const expect = (key, value) => { if (entry[key] !== value) problems.push(`${key}=${entry[key] ?? '(missing)'}, expected ${value}`); };
  expect('Type', 'Application');
  expect('Name', PRODUCT_NAME);
  expect('Exec', kind === 'appimage' ? 'AppRun %U' : `"${INSTALLED_EXECUTABLE}" %U`);
  expect('Terminal', 'false');
  expect('Icon', EXECUTABLE_NAME);
  expect('StartupWMClass', EXECUTABLE_NAME);
  expect('Categories', CATEGORIES);
  if (/sandbox/i.test(entry.Exec ?? '')) problems.push('Exec carries a sandbox switch');
  if ('MimeType' in entry) problems.push('MimeType is set: no file associations are registered');
  if (kind === 'appimage' && version !== null) expect('X-AppImage-Version', version);
  if (kind === 'deb' && 'X-AppImage-Version' in entry) problems.push('the .deb entry carries X-AppImage-Version');
  if (parsed.duplicates.length) problems.push(`duplicate keys ${parsed.duplicates.join(', ')}`);
  return problems;
}

/** `dpkg-deb -f <deb>` output: control fields, continuation lines joined with a newline. */
function parseDebFields(text) {
  const fields = {};
  let last = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) { fields[last] += `\n${line.trim()}`; continue; }
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line);
    if (match) { last = match[1]; fields[last] = match[2].trim(); }
  }
  return fields;
}

const addressesIn = (text) => [...String(text ?? '').matchAll(/[^\s<>()"',;]+@[^\s<>()"',;]+/g)].map((match) => match[0]);

/** Problems of the .deb control fields. */
function checkDebFields(fields, { arch, version, homepage }) {
  const problems = [];
  const expect = (key, value) => { if (fields[key] !== value) problems.push(`${key}: ${fields[key] ?? '(missing)'}, expected ${value}`); };
  expect('Package', DEB_PACKAGE);
  expect('Version', String(version).replace(/-/g, '~'));
  expect('Architecture', ARCHES[arch] ? ARCHES[arch].deb : `(unknown arch ${arch})`);
  expect('Maintainer', MAINTAINER);
  expect('Homepage', homepage);
  const text = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n');
  const others = addressesIn(text).filter((address) => address !== MAINTAINER_ADDRESS);
  if (others.length) problems.push(`addresses other than the maintainer address: ${others.join(', ')}`);
  if (BUILD_PATH_PATTERN.test(text)) problems.push('a build-machine path appears in the control fields');
  return problems;
}

/** Paths of `dpkg-deb -c <deb>` (tar listing): absolute, without the leading ".", symlink targets dropped, no trailing slash. */
function parseDebListing(text) {
  const paths = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\S+\s+\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/.exec(line);
    if (!match) continue;
    let entry = match[1];
    const arrow = entry.indexOf(' -> ');
    if (arrow > 0) entry = entry.slice(0, arrow);
    entry = entry.replace(/^\.\//, '/').replace(/\/$/, '');
    if (entry && entry !== '.' && entry !== '/') paths.push(entry.startsWith('/') ? entry : `/${entry}`);
  }
  return paths;
}

/** Problems of the .deb file list. */
function checkDebListing(paths) {
  const set = new Set(paths);
  const problems = [];
  for (const required of [INSTALLED_EXECUTABLE, `${INSTALL_DIR}/chrome-sandbox`, `${INSTALL_DIR}/resources/app.asar`, `${INSTALL_DIR}/resources/apparmor-profile`,
    `/usr/share/applications/${DESKTOP_FILE}`, `/${ICON_PATH}`]) {
    if (!set.has(required)) problems.push(`missing ${required}`);
  }
  for (const forbidden of [`${INSTALL_DIR}/resources/app.asar.unpacked`, `${INSTALL_DIR}/resources/app-update.yml`]) {
    if (paths.some((entry) => entry === forbidden || entry.startsWith(`${forbidden}/`))) problems.push(`unexpected ${forbidden}`);
  }
  return problems;
}

/** Problems of the AppArmor profile the .deb installs. */
function checkAppArmorProfile(text) {
  const body = String(text ?? '');
  const problems = [];
  if (!/^\s*userns,\s*$/m.test(body)) problems.push('no "userns," rule');
  if (!body.includes('flags=(unconfined)')) problems.push('not flags=(unconfined)');
  if (!body.includes(`"${INSTALLED_EXECUTABLE}"`)) problems.push(`does not attach to "${INSTALLED_EXECUTABLE}"`);
  if (!/profile\s+"?trace-boardviewer"?\s/.test(body)) problems.push('the profile is not named trace-boardviewer');
  return problems;
}

/** Problems of the .deb post-install script: it loads the profile and sets chrome-sandbox SUID only without user namespaces. */
function checkPostinst(text) {
  const body = String(text ?? '');
  const problems = [];
  for (const needle of ['apparmor_parser --replace --write-cache --skip-read-cache', 'apparmor_parser --skip-kernel-load', 'unshare --user true', `chmod 4755 '${INSTALL_DIR}/chrome-sandbox'`, `chmod 0755 '${INSTALL_DIR}/chrome-sandbox'`]) {
    if (!body.includes(needle)) problems.push(`missing: ${needle}`);
  }
  return problems;
}

/** Problems of the AppImage launcher: the sandbox-off switch is added only when the user-namespace probe fails. */
function checkAppRun(text) {
  const body = String(text ?? '');
  const problems = [];
  if (!body.includes('if [ $HAVE_NO_SANDBOX -eq 0 ] && ! unshare -Ur true 2>/dev/null ; then')) problems.push('the unshare -Ur true probe is missing or changed');
  if (!body.includes('NO_SANDBOX=(--no-sandbox)')) problems.push('the conditional switch is missing or changed');
  // Outside comments the switch may only appear in the check for a caller-given switch and in the conditional assignment.
  const code = body.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  if ((code.match(/--no-sandbox/g) ?? []).length !== 2) problems.push('the switch appears outside the probe (expected exactly the comparison and the conditional assignment)');
  if (!body.includes('exec "$BIN" "${NO_SANDBOX[@]}" "${args[@]}"')) problems.push('the app is not started with only the conditional switch added');
  return problems;
}

/** ELF header facts of an executable: class, byte order and e_machine. */
function elfMachine(buffer) {
  if (!buffer || buffer.length < 20 || buffer[0] !== 0x7f || buffer.toString('latin1', 1, 4) !== 'ELF') return { elf: false, bits: null, machine: null };
  const bits = buffer[4] === 2 ? 64 : buffer[4] === 1 ? 32 : null;
  const littleEndian = buffer[5] !== 2;
  return { elf: true, bits, littleEndian, machine: littleEndian ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18) };
}

/** Width and height from a PNG header, or null. */
function pngSize(buffer) {
  if (!buffer || buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const XPROP_STRING = '"((?:[^"\\\\]|\\\\.)*)"';

/** `xprop -id <id> WM_CLASS` gives [instance, class] or null. */
function parseXpropWmClass(text) {
  const match = new RegExp(`WM_CLASS(?:\\([^)]*\\))?\\s*=\\s*${XPROP_STRING}\\s*,\\s*${XPROP_STRING}`).exec(String(text ?? ''));
  return match ? [match[1], match[2]] : null;
}

/** One atom-valued property of xprop output (`_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DIALOG`), or null. */
function parseXpropAtom(text, name) {
  const match = new RegExp(`^${name}(?:\\([^)]*\\))?\\s*=\\s*([A-Z0-9_, ]+)$`, 'm').exec(String(text ?? ''));
  return match ? match[1].trim() : null;
}

/** One string-valued property of xprop output (`WM_NAME(STRING) = "TRACE Boardviewer"`), or null. */
function parseXpropString(text, name) {
  const match = new RegExp(`^${name}(?:\\([^)]*\\))?\\s*=\\s*${XPROP_STRING}`, 'm').exec(String(text ?? ''));
  return match ? match[1] : null;
}

/**
 * Icon sizes of `xprop -id <id> _NET_WM_ICON` output: either a flat list of width, height and width*height pixels per icon, or the
 * "Icon (W x H):" rendering that newer xprop versions print.
 */
function parseNetWmIconSize(text) {
  const body = String(text ?? '');
  if (/not found|no such atom/i.test(body)) return { sizes: [], truncated: false, found: false };
  const rendered = [...body.matchAll(/Icon \((\d+) x (\d+)\)/g)].map((match) => ({ width: Number(match[1]), height: Number(match[2]) }));
  if (rendered.length) return { sizes: rendered, truncated: false, found: true };
  const equal = body.indexOf('=');
  if (equal < 0) return { sizes: [], truncated: false, found: false };
  const values = body.slice(equal + 1).split(',').map((part) => part.trim()).filter(Boolean).map(Number);
  const sizes = [];
  let index = 0;
  let truncated = false;
  while (index + 1 < values.length) {
    const width = values[index];
    const height = values[index + 1];
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 4096 || height > 4096) { truncated = true; break; }
    sizes.push({ width, height });
    index += 2 + width * height;
  }
  if (index > values.length) truncated = true;
  return { sizes, truncated, found: sizes.length > 0 };
}

/** `xwininfo -id <id>` gives absolute position, size and map state. */
function parseXwininfo(text) {
  const body = String(text ?? '');
  const number = (label) => { const match = new RegExp(`${label}:\\s*(-?\\d+)`).exec(body); return match ? Number(match[1]) : null; };
  const id = /Window id:\s*(0x[0-9a-f]+)/i.exec(body);
  const state = /Map State:\s*(\w+)/.exec(body);
  return { id: id ? Number.parseInt(id[1], 16) : null, x: number('Absolute upper-left X'), y: number('Absolute upper-left Y'), width: number('Width'), height: number('Height'), mapState: state ? state[1] : null };
}

/** `xwininfo -root -tree` gives windows with id, name, class hint and size. */
function parseXwininfoTree(text) {
  const windows = [];
  const pattern = new RegExp(`^\\s*(0x[0-9a-f]+)\\s+(?:${XPROP_STRING}|\\(has no name\\))(?::\\s*\\((?:${XPROP_STRING}\\s+${XPROP_STRING})?\\))?\\s+(\\d+)x(\\d+)`, 'i');
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match) windows.push({ id: Number.parseInt(match[1], 16), name: match[2] ?? null, instance: match[3] ?? null, class: match[4] ?? null, width: Number(match[5]), height: Number(match[6]) });
  }
  return windows;
}

/** Window ids printed by `xdotool search` (decimal, one per line). */
const parseXdotoolIds = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).map(Number);

/** key=value lines (the stand-in xdg-open record). */
function parseKeyValueLines(text) {
  const result = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const equal = line.indexOf('=');
    if (equal > 0) result[line.slice(0, equal)] = line.slice(equal + 1);
  }
  return result;
}

/** The fuse wire the config asks for, by fuse name: 'ENABLE' or 'DISABLE'. Unknown config keys are reported, never ignored. */
function expectedFuseWire(electronFuses) {
  const wire = {};
  const unknown = [];
  for (const [key, value] of Object.entries(electronFuses ?? {})) {
    if (!Object.hasOwn(FUSE_INDEX, key)) { unknown.push(key); continue; }
    wire[FUSE_NAMES[FUSE_INDEX[key]]] = value ? 'ENABLE' : 'DISABLE';
  }
  return { wire, unknown };
}

/** The wire read by @electron/fuses getCurrentFuseWire, by fuse name. */
function describeFuseWire(raw) {
  const wire = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!/^\d+$/.test(key)) continue;
    wire[FUSE_NAMES[Number(key)] ?? `fuse${key}`] = FUSE_STATES[value] ?? String(value);
  }
  return wire;
}

/** Mismatches between an expected and an observed wire (only the expected fuses are compared; the others keep Electron's default). */
function compareFuseWire(observed, expected) {
  return Object.entries(expected).filter(([name, state]) => observed[name] !== state).map(([name, state]) => `${name} is ${observed[name] ?? 'absent'}, expected ${state}`);
}

/** The default profile location relative to the temporary HOME, and whether it is the documented one. */
function decideDefaultProfile({ home, userData }) {
  const expected = path.posix.join(home, '.config', EXECUTABLE_NAME);
  const relative = typeof userData === 'string' && (userData === home || userData.startsWith(`${home}/`)) ? userData.slice(home.length + 1) : null;
  return { ok: userData === expected, expected, relative: relative === null ? userData : `$HOME/${relative}` };
}

function buildEvidence(input) {
  const checks = input.checks ?? [];
  const summary = mac.summarizeChecks(checks);
  return {
    schema: SCHEMA,
    kind: input.kind,
    disclaimer: 'Smoke evidence for an experimental Linux build on a CI runner (Xvfb, no window manager). Not a release acceptance and not a statement about real desktop sessions.',
    commit: input.commit ?? 'unknown',
    arch: input.arch ?? null,
    scenario: input.scenario ?? (input.kind === 'static' ? 'S0' : null),
    target: input.target ?? null,
    executable: input.executable ?? null,
    userns: input.userns ?? null,
    expectSandbox: input.expectSandbox ?? null,
    expectGate: input.expectGate ?? null,
    passed: summary.passed,
    failedChecks: summary.failed,
    skippedChecks: summary.skipped,
    sandbox: input.sandbox ?? null,
    gate: input.gate ?? null,
    defaultProfile: input.defaultProfile ?? null,
    appimage: input.appimage ?? null,
    packages: input.packages ?? null,
    runtime: input.runtime ?? null,
    launches: input.launches ?? null,
    host: input.host ?? null,
    run: input.run ?? null,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    checks,
    observations: input.observations ?? [],
    notCovered: [...NOT_COVERED],
    ...(input.error ? { error: String(input.error) } : {}),
  };
}

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function gateText(evidence) {
  const records = Array.isArray(evidence.gate) ? evidence.gate : [];
  const shown = records.filter((record) => record.shown);
  if (!records.length) return 'not observed';
  if (!shown.length) return `not shown (${records.length} launches)`;
  return `shown ${shown.length}x of ${records.length} launches (${shown.map((record) => record.answer ?? 'unanswered').join('; ')})`;
}

/** The consent-dialog part of every Playwright launch record, for the evidence and the summary. */
function gateRecords(launches) {
  return (launches ?? []).filter((record) => record.expectation !== 'exit').map((record) => ({
    label: record.label, expectation: record.expectation, shown: Boolean(record.gate && record.gate.shown), answer: record.answer ?? null,
    dialog: record.gate && record.gate.shown ? { windowType: record.gate.windowType ?? null, wmClass: record.gate.wmClass ?? null, width: record.gate.width ?? null, height: record.gate.height ?? null,
      browserWindows: record.gate.browserWindows, noSandboxSwitch: record.gate.noSandboxSwitch, warningLogged: record.gate.warningLogged, shownAfterMs: record.gate.shownAfterMs ?? null, screenshot: record.gate.screenshot ?? null } : null,
    windowShown: record.windowShown, answerStored: record.answerStored ?? null, acceptNoSandbox: record.acceptNoSandbox ?? null, noSandboxSwitch: record.noSandboxSwitch ?? null, warningLogged: record.warningLogged ?? null, exit: record.exit ?? null,
  }));
}

/** Markdown summary of every evidence file of one job, for $GITHUB_STEP_SUMMARY. */
function formatSummary(evidences) {
  const lines = ['### Linux packages (experimental)', ''];
  const list = (evidences ?? []).filter((evidence) => evidence && evidence.schema === SCHEMA);
  if (!list.length) return [...lines, 'No Linux smoke evidence was written.', ''].join('\n');
  const order = (evidence) => `${evidence.kind === 'static' ? 'S0' : evidence.scenario ?? 'S?'}`;
  list.sort((a, b) => order(a).localeCompare(order(b)));
  lines.push('| Scenario | Package | User namespaces | Sandbox (expected / observed) | Consent dialog (expected / observed) | Default profile | Result |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const evidence of list) {
    const result = evidence.passed ? `passed (${evidence.checks.length} checks)` : `FAILED (${evidence.failedChecks.length} failed, ${evidence.skippedChecks.length} skipped)`;
    if (evidence.kind === 'static') {
      lines.push(`| S0 | AppImage, .deb and unpacked app (static) | n/a | n/a | n/a | n/a | ${cell(result)} |`);
      continue;
    }
    const sandbox = `${evidence.expectSandbox ?? '?'} / ${evidence.sandbox ? evidence.sandbox.classification : 'not read'}`;
    const userns = evidence.userns ? `${evidence.userns.expected} (sysctl ${evidence.userns.sysctl ?? 'n/a'})` : '?';
    const profile = evidence.defaultProfile ? evidence.defaultProfile.relative : 'not checked';
    lines.push(`| ${cell(evidence.scenario)} | ${cell(TARGET_LABELS[evidence.target] ?? evidence.target)} | ${cell(userns)} | ${cell(sandbox)} | ${cell(`${evidence.expectGate ?? '?'} / ${gateText(evidence)}`)} | ${cell(profile)} | ${cell(result)} |`);
  }
  const failures = list.flatMap((evidence) => [
    ...evidence.checks.filter((check) => check.status === 'fail').map((check) => `- ${order(evidence)}: ${check.name}: ${String(check.detail ?? '').slice(0, 300)}`),
    ...(evidence.error ? [`- ${order(evidence)}: error: ${String(evidence.error).split('\n')[0].slice(0, 300)}`] : []),
  ]);
  if (failures.length) lines.push('', '**Failed checks**', '', ...failures.map(cell));
  const observations = list.flatMap((evidence) => (evidence.observations ?? []).map((note) => `- ${order(evidence)}: ${note}`));
  if (observations.length) lines.push('', '**Observations (informational)**', '', ...observations.map(cell));
  lines.push('', `Not covered: ${NOT_COVERED.join('; ')}.`, '');
  return lines.join('\n');
}

/** What a run would do, without doing it (the --dry-run output). */
function planRun(parsed, { base = {}, root = '/tmp/trace-linux-smoke-XXXXXX', cwd = '/' } = {}) {
  const raw = executableFor(parsed);
  const executable = raw && !path.posix.isAbsolute(raw) && !path.isAbsolute(raw) ? path.posix.join(cwd, raw) : raw;
  const dirs = runDirectories(root);
  const launches = launchSpecs({ expectGate: parsed.expectGate }).map((spec) => {
    const env = launchEnvironment(base, { stubBin: dirs.bin, xdgRecord: dirs.xdgRecord, home: spec.home ? dirs.home : null, acceptNoSandbox: spec.acceptNoSandbox });
    const resolved = resolveSpec(spec, dirs);
    return {
      label: spec.label,
      startedBy: spec.spawnOnly ? 'child_process (second instance)' : 'Playwright _electron.launch with chromiumSandbox: true, through a stderr-copying launcher',
      args: resolved.args,
      ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
      environment: environmentChanges(base, env),
      consentDialog: spec.gate,
    };
  });
  return {
    dryRun: true, command: 'run', scenario: parsed.scenario, target: parsed.target, arch: parsed.arch, userns: parsed.userns,
    expectSandbox: parsed.expectSandbox, expectGate: parsed.expectGate, executable, out: parsed.out || defaultOut(parsed),
    appimage: parsed.target === 'appimage' ? 'probe: <AppImage> --appimage-mount; APPIMAGE_EXTRACT_AND_RUN=1 for every launch only if FUSE mounting fails' : null,
    launches,
  };
}

function planStatic(parsed, { version = null, cwd = '/' } = {}) {
  const resolve = (file) => (path.posix.isAbsolute(file) || path.isAbsolute(file) ? file : path.posix.join(cwd, file));
  return {
    dryRun: true, command: 'static', arch: parsed.arch, out: parsed.out || defaultOut(parsed),
    appimage: resolve(parsed.appimage), deb: resolve(parsed.deb), unpacked: resolve(parsed.unpacked),
    unpackedExecutable: path.posix.join(resolve(parsed.unpacked), EXECUTABLE_NAME),
    expectedFileNames: version ? { appimage: artifactFileName(version, parsed.arch, 'AppImage'), deb: artifactFileName(version, parsed.arch, 'deb') } : null,
    tools: ['<AppImage> --appimage-extract', 'desktop-file-validate', 'dpkg-deb -f / -c / -x / -e', '@electron/fuses getCurrentFuseWire'],
  };
}

/** Paths of one run inside its temporary root. */
function runDirectories(root) {
  const join = path.posix.join;
  return {
    root, profile: join(root, 'profile'), gateProfile: join(root, 'profile-gate'), gateQuitProfile: join(root, 'profile-gate-quit'), home: join(root, 'home'), project: join(root, 'project'),
    bin: join(root, 'bin'), launchers: join(root, 'launchers'), logs: join(root, 'logs'), xdgRecord: join(root, 'logs', 'xdg-open.txt'),
    board: join(root, 'project', FIXTURE_NAME), secondBoard: join(root, 'project', SECOND_FIXTURE_NAME),
    pdf: join(root, 'project', DOCUMENT_NAMES[0]), png: join(root, 'project', DOCUMENT_NAMES[1]),
  };
}

// Stand-in for xdg-open: records what the app asked to open (and the library path it inherited) and opens nothing.
const XDG_OPEN_STUB = [
  '#!/bin/sh',
  '# Stand-in for xdg-open written by scripts/linux-smoke.cjs: records what the app asked to open and opens nothing.',
  'record="${TRACE_SMOKE_XDG_RECORD:?}"',
  '{',
  '  printf \'argc=%s\\n\' "$#"',
  '  printf \'url=%s\\n\' "$1"',
  '  if [ "${LD_LIBRARY_PATH+set}" = set ]; then printf \'ld_library_path=%s\\n\' "$LD_LIBRARY_PATH"; else printf \'ld_library_path_unset=1\\n\'; fi',
  '} > "$record.tmp" && mv -f "$record.tmp" "$record"',
  'exit 0',
  '',
].join('\n');

// Runs inside the renderer (serialized by Playwright): no closures allowed. Same measure as the macOS smoke test.
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
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: options.timeoutMs ?? 30000, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, cwd: options.cwd, env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, signal: result.signal ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error ? String(result.error.message) : null };
}

const readText = (file) => { try { return fsSync.readFileSync(file, 'utf8'); } catch { return ''; } };
const exists = (file) => fsSync.existsSync(file);
const isExecutable = (file) => { try { fsSync.accessSync(file, fsSync.constants.X_OK); return fsSync.statSync(file).isFile(); } catch { return false; } };
const tail = (text, count = 25) => String(text ?? '').split('\n').map((line) => line.trimEnd()).filter(Boolean).slice(-count).map((line) => line.slice(0, 300));

async function makeTempRoot(prefix) {
  const canonical = await fs.realpath(os.tmpdir());
  return fs.realpath(await fs.mkdtemp(path.join(canonical, prefix)));
}

async function removeTempRoot(root, keep) {
  const resolved = path.resolve(root);
  const temp = path.resolve(await fs.realpath(os.tmpdir()));
  if (!keep && resolved.startsWith(`${temp}${path.sep}`)) await fs.rm(resolved, { recursive: true, force: true }).catch(() => {});
}

function builderLibDirectory() {
  const builderManifest = require.resolve('electron-builder/package.json', { paths: [ROOT] });
  return path.dirname(require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builderManifest)] }));
}

function readJson(file) { return JSON.parse(fsSync.readFileSync(file, 'utf8')); }

/** The electronFuses the Linux build was configured with (the Linux config; the Windows build block as a fallback). */
function configuredFuses() {
  const configFile = path.join(ROOT, 'config', 'electron-builder.linux.yml');
  if (exists(configFile)) {
    const yaml = require(require.resolve('js-yaml', { paths: [builderLibDirectory()] }));
    return { source: 'config/electron-builder.linux.yml', fuses: yaml.load(fsSync.readFileSync(configFile, 'utf8')).electronFuses };
  }
  return { source: 'package.json build', fuses: readJson(path.join(ROOT, 'package.json')).build.electronFuses };
}

async function readFuseWire(binary) {
  const fuses = require(require.resolve('@electron/fuses', { paths: [builderLibDirectory()] }));
  return fuses.getCurrentFuseWire(binary);
}

async function sha256File(file) {
  const { createHash } = require('node:crypto');
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function hostFacts(env) {
  const osRelease = readText('/etc/os-release');
  const field = (key) => { const match = new RegExp(`^${key}="?([^"\\n]*)"?$`, 'm').exec(osRelease); return match ? match[1] : null; };
  const sysctlText = readText('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').trim();
  const unshare = tool('unshare', ['-Ur', 'true'], { timeoutMs: 10000 });
  return {
    host: {
      platform: process.platform, nodeArch: process.arch, nodeVersion: process.version, kernel: os.release(), prettyName: field('PRETTY_NAME'), versionId: field('VERSION_ID'),
      uid: typeof process.getuid === 'function' ? process.getuid() : null, display: env.DISPLAY ?? null, devFuse: exists('/dev/fuse'),
      apparmorRestrictUnprivilegedUserns: /^\d+$/.test(sysctlText) ? Number(sysctlText) : null, unshareUr: { ok: unshare.status === 0, stderr: unshare.stderr.trim().slice(0, 200) },
    },
    run: {
      githubRunId: env.GITHUB_RUN_ID ?? null, runnerOs: env.RUNNER_OS ?? null, runnerArch: env.RUNNER_ARCH ?? null, imageOs: env.ImageOS ?? null, imageVersion: env.ImageVersion ?? null,
    },
  };
}

async function writeEvidence(evidence, out, log) {
  const target = path.resolve(out);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const home = os.homedir();
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  await fs.writeFile(target, home && home.length > 1 ? text.split(home).join('~') : text);
  log(`Evidence: ${target}`);
  return target;
}

// ---- static ----------------------------------------------------------------------------------------------

async function staticChecks(parsed, { log }) {
  const checks = [];
  const add = (name, problems, detail) => {
    const list = Array.isArray(problems) ? problems : problems ? [] : ['failed'];
    checks.push({ name, status: list.length ? 'fail' : 'pass', ...(list.length ? { detail: list.join('; ').slice(0, 800) } : detail !== undefined ? { detail } : {}) });
    log(`${list.length ? 'FAIL' : 'PASS'} ${name}${list.length ? `: ${list.join('; ')}` : ''}`);
  };
  const facts = { packages: {}, appimage: {}, deb: {}, unpacked: {} };
  const arch = ARCHES[parsed.arch];
  const appimage = path.resolve(parsed.appimage);
  const deb = path.resolve(parsed.deb);
  const unpacked = path.resolve(parsed.unpacked);
  const version = readJson(path.join(ROOT, 'package.json')).version;
  const homepage = `https://github.com/${readJson(path.join(ROOT, 'electron', 'repository.json')).repository}`;
  const work = await makeTempRoot('trace-linux-static-');
  try {
    for (const [key, file] of [['appimage', appimage], ['deb', deb]]) {
      facts.packages[key] = exists(file) ? { name: path.basename(file), bytes: fsSync.statSync(file).size, sha256: await sha256File(file) } : { name: path.basename(file), missing: true };
    }
    add('package file names follow TRACE-Boardviewer-<version>-linux-<arch>.<ext>', [
      ...(path.basename(appimage) === artifactFileName(version, parsed.arch, 'AppImage') ? [] : [`AppImage is ${path.basename(appimage)}, expected ${artifactFileName(version, parsed.arch, 'AppImage')}`]),
      ...(path.basename(deb) === artifactFileName(version, parsed.arch, 'deb') ? [] : [`.deb is ${path.basename(deb)}, expected ${artifactFileName(version, parsed.arch, 'deb')}`]),
      ...(exists(appimage) ? [] : ['the AppImage is missing']), ...(exists(deb) ? [] : ['the .deb is missing']),
    ]);

    // unpacked app
    const executable = path.join(unpacked, EXECUTABLE_NAME);
    const head = exists(executable) ? fsSync.readFileSync(executable).subarray(0, 64) : null;
    const elf = elfMachine(head);
    facts.unpacked.elf = elf;
    add(`ELF: linux-unpacked/${EXECUTABLE_NAME} is a 64-bit ELF for ${parsed.arch} (e_machine 0x${arch.elfMachine.toString(16)})`,
      elf.elf && elf.bits === 64 && elf.machine === arch.elfMachine ? [] : [`ELF facts ${JSON.stringify(elf)}`]);
    const layout = {
      executable: isExecutable(executable), chromeSandbox: exists(path.join(unpacked, 'chrome-sandbox')), appAsar: exists(path.join(unpacked, 'resources', 'app.asar')),
      appAsarUnpacked: exists(path.join(unpacked, 'resources', 'app.asar.unpacked')), appUpdateYml: exists(path.join(unpacked, 'resources', 'app-update.yml')),
    };
    facts.unpacked.layout = layout;
    add('unpacked layout: executable, chrome-sandbox and resources/app.asar present; no app.asar.unpacked, no app-update.yml',
      [...(layout.executable ? [] : ['executable missing']), ...(layout.chromeSandbox ? [] : ['chrome-sandbox missing']), ...(layout.appAsar ? [] : ['app.asar missing']),
        ...(layout.appAsarUnpacked ? ['app.asar.unpacked exists'] : []), ...(layout.appUpdateYml ? ['app-update.yml exists'] : [])]);
    try {
      const { source, fuses } = configuredFuses();
      const expected = expectedFuseWire(fuses);
      const observed = describeFuseWire(await readFuseWire(executable));
      facts.unpacked.fuses = { source, observed };
      add(`fuses: the Linux executable carries the fuse wire of ${source}`, [...compareFuseWire(observed, expected.wire), ...expected.unknown.map((key) => `unknown fuse key ${key}`)]);
    } catch (error) {
      add('fuses: the Linux executable carries the configured fuse wire', [`could not read the fuse wire: ${error.message}`]);
    }

    // AppImage
    const appimageDir = path.join(work, 'appimage');
    await fs.mkdir(appimageDir, { recursive: true });
    const extract = exists(appimage) ? tool(appimage, ['--appimage-extract'], { cwd: appimageDir, timeoutMs: 600000 }) : { status: null, stderr: 'missing', error: null };
    const squash = path.join(appimageDir, 'squashfs-root');
    facts.appimage.extract = { status: extract.status, error: extract.error, stderr: tail(extract.stderr, 5) };
    const linkTarget = (file) => { try { return fsSync.readlinkSync(file); } catch { return null; } };
    const appimageLayout = {
      appRun: isExecutable(path.join(squash, 'AppRun')), desktop: exists(path.join(squash, DESKTOP_FILE)), dirIcon: linkTarget(path.join(squash, '.DirIcon')),
      rootIcon: linkTarget(path.join(squash, `${EXECUTABLE_NAME}.svg`)), icon: exists(path.join(squash, ICON_PATH)), executable: isExecutable(path.join(squash, EXECUTABLE_NAME)),
      appAsar: exists(path.join(squash, 'resources', 'app.asar')), appAsarUnpacked: exists(path.join(squash, 'resources', 'app.asar.unpacked')),
      appUpdateYml: exists(path.join(squash, 'resources', 'app-update.yml')),
    };
    facts.appimage.layout = appimageLayout;
    add(`AppImage: extracts with --appimage-extract; AppRun, ${DESKTOP_FILE}, the executable and resources/app.asar at the top level; no app.asar.unpacked, no app-update.yml`, [
      ...(extract.status === 0 ? [] : [`--appimage-extract exit ${extract.status} ${extract.error ?? ''} ${tail(extract.stderr, 3).join(' ')}`]),
      ...(appimageLayout.appRun ? [] : ['AppRun missing or not executable']), ...(appimageLayout.desktop ? [] : [`${DESKTOP_FILE} missing`]),
      ...(appimageLayout.executable ? [] : ['executable missing']), ...(appimageLayout.appAsar ? [] : ['app.asar missing']),
      ...(appimageLayout.appAsarUnpacked ? ['app.asar.unpacked exists'] : []), ...(appimageLayout.appUpdateYml ? ['app-update.yml exists'] : []),
    ]);
    add(`AppImage icon: ${ICON_PATH}, with ${EXECUTABLE_NAME}.svg and .DirIcon at the top level linking to it`, [
      ...(appimageLayout.icon ? [] : [`${ICON_PATH} missing`]),
      ...(appimageLayout.rootIcon === ICON_PATH ? [] : [`${EXECUTABLE_NAME}.svg links to ${appimageLayout.rootIcon}`]),
      ...(appimageLayout.dirIcon === ICON_PATH ? [] : [`.DirIcon links to ${appimageLayout.dirIcon}`]),
    ]);
    const appimageDesktopFile = path.join(squash, DESKTOP_FILE);
    const appimageEntry = parseDesktopEntry(readText(appimageDesktopFile));
    facts.appimage.desktopEntry = appimageEntry.entry;
    const appimageValidate = exists(appimageDesktopFile) ? tool('desktop-file-validate', [appimageDesktopFile]) : { status: null, stdout: '', stderr: 'missing', error: null };
    facts.appimage.desktopFileValidate = { status: appimageValidate.status, output: tail(`${appimageValidate.stdout}\n${appimageValidate.stderr}`, 10), error: appimageValidate.error };
    add('AppImage desktop entry: Name, Exec=AppRun %U (no sandbox switch), Icon, StartupWMClass, Categories, version; desktop-file-validate accepts it', [
      ...checkDesktopEntry(appimageEntry, { kind: 'appimage', version }),
      ...(appimageValidate.status === 0 ? [] : [`desktop-file-validate exit ${appimageValidate.status} ${appimageValidate.error ?? ''} ${tail(appimageValidate.stdout + appimageValidate.stderr, 3).join(' ')}`]),
    ]);
    add('AppImage launcher: AppRun adds the sandbox-off switch only when unshare -Ur true fails', checkAppRun(readText(path.join(squash, 'AppRun'))));

    // .deb
    const debFields = parseDebFields(exists(deb) ? tool('dpkg-deb', ['-f', deb]).stdout : '');
    facts.deb.fields = debFields;
    add('deb control: Package, Version, Architecture, Maintainer and Homepage; no other address, no build path', checkDebFields(debFields, { arch: parsed.arch, version, homepage }));
    const listing = parseDebListing(exists(deb) ? tool('dpkg-deb', ['-c', deb]).stdout : '');
    facts.deb.entries = listing.length;
    add(`deb contents: ${INSTALLED_EXECUTABLE}, chrome-sandbox, resources/app.asar and apparmor-profile, the desktop entry and the scalable icon`, checkDebListing(listing));
    const debDir = path.join(work, 'deb');
    const extracted = exists(deb) ? tool('dpkg-deb', ['-x', deb, debDir], { timeoutMs: 300000 }) : { status: null };
    const control = exists(deb) ? tool('dpkg-deb', ['-e', deb, path.join(work, 'deb-control')]) : { status: null };
    const profileText = readText(path.join(debDir, INSTALL_DIR.slice(1), 'resources', 'apparmor-profile'));
    facts.deb.apparmorProfile = profileText.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
    add('deb AppArmor profile: trace-boardviewer, flags=(unconfined) with userns for the installed executable', extracted.status === 0 ? checkAppArmorProfile(profileText) : ['dpkg-deb -x failed']);
    const debDesktopFile = path.join(debDir, 'usr', 'share', 'applications', DESKTOP_FILE);
    const debEntry = parseDesktopEntry(readText(debDesktopFile));
    facts.deb.desktopEntry = debEntry.entry;
    const debValidate = exists(debDesktopFile) ? tool('desktop-file-validate', [debDesktopFile]) : { status: null, stdout: '', stderr: 'missing', error: null };
    facts.deb.desktopFileValidate = { status: debValidate.status, output: tail(`${debValidate.stdout}\n${debValidate.stderr}`, 10), error: debValidate.error };
    add(`deb desktop entry: Exec="${INSTALLED_EXECUTABLE}" %U, same Icon, StartupWMClass and Categories; desktop-file-validate accepts it`, [
      ...checkDesktopEntry(debEntry, { kind: 'deb' }),
      ...(debValidate.status === 0 ? [] : [`desktop-file-validate exit ${debValidate.status} ${debValidate.error ?? ''} ${tail(debValidate.stdout + debValidate.stderr, 3).join(' ')}`]),
    ]);
    add('deb maintainer scripts: postinst loads the AppArmor profile and sets chrome-sandbox SUID only without user namespaces',
      control.status === 0 ? checkPostinst(readText(path.join(work, 'deb-control', 'postinst'))) : ['dpkg-deb -e failed']);
    const debAsar = path.join(debDir, INSTALL_DIR.slice(1), 'resources', 'app.asar');
    const asars = [path.join(unpacked, 'resources', 'app.asar'), path.join(squash, 'resources', 'app.asar'), debAsar].filter(exists);
    const digests = await Promise.all(asars.map(sha256File));
    facts.asarSha256 = digests;
    add('the unpacked app, the AppImage and the .deb carry the same app.asar', asars.length === 3 && new Set(digests).size === 1 ? [] : [`${asars.length} of 3 found, ${new Set(digests).size} distinct digest(s)`]);
  } finally {
    await removeTempRoot(work, false);
  }
  return { checks, facts };
}

// ---- run -------------------------------------------------------------------------------------------------

const xdo = (args, timeoutMs = 10000) => { const result = tool('xdotool', args, { timeoutMs }); return { args: args.join(' '), status: result.status, error: result.error, stderr: result.stderr.trim().slice(0, 200) }; };

function windowFacts(id) {
  const info = parseXwininfo(tool('xwininfo', ['-id', String(id)]).stdout);
  const props = tool('xprop', ['-id', String(id), 'WM_CLASS', '_NET_WM_WINDOW_TYPE', 'WM_NAME', '_NET_WM_NAME']).stdout;
  return {
    id, hex: `0x${id.toString(16)}`, x: info.x, y: info.y, width: info.width, height: info.height, mapState: info.mapState,
    name: parseXpropString(props, '_NET_WM_NAME') ?? parseXpropString(props, 'WM_NAME'), wmClass: parseXpropWmClass(props), windowType: parseXpropAtom(props, '_NET_WM_WINDOW_TYPE'),
  };
}

/** Visible top-level windows whose name is exactly the product name (the consent dialog's title). */
const findTitledWindows = () => parseXdotoolIds(tool('xdotool', ['search', '--onlyvisible', '--name', `^${GATE.title}$`], { timeoutMs: 10000 }).stdout);

/** Best-effort picture of the dialog for the evidence (ImageMagick "import" is used only when the runner has it). */
function screenshotWindow(id, file) {
  const result = tool('import', ['-window', String(id), file], { timeoutMs: 20000 });
  return result.status === 0 && exists(file) ? file : null;
}

async function waitForConsentDialog({ app, child, stderrFile, timeoutMs = 45000 }) {
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the app exited (code ${child.exitCode}, signal ${child.signalCode}) before a consent dialog appeared`);
    const ids = findTitledWindows();
    if (ids.length) {
      const browserWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length).catch(() => null);
      if (browserWindows > 0) return { shown: false, browserWindows, note: 'a window opened without a consent dialog' };
      if (browserWindows === 0) {
        const candidates = ids.map(windowFacts);
        const dialog = candidates.find((facts) => facts.mapState === 'IsViewable' && facts.width > 0) ?? candidates[0];
        const noSandboxSwitch = await app.evaluate(({ app: electronApp }, name) => electronApp.commandLine.hasSwitch(name), 'no-sandbox').catch(() => null);
        return { shown: true, ...dialog, candidates: candidates.length, browserWindows, noSandboxSwitch, warningLogged: readText(stderrFile).includes(GATE.stderrLine), shownAfterMs: Date.now() - started };
      }
    }
    if (Date.now() - started > timeoutMs) return { shown: false, browserWindows: null, note: `no window titled "${GATE.title}" appeared within ${timeoutMs} ms` };
    await delay(300);
  }
}

/**
 * Answers the consent dialog on the X display (Xvfb, no window manager). Quit: Escape, which GTK turns into the dialog's cancel
 * response (Quit). Start: Space toggles "Do not ask again" when it is wanted (GTK focuses the first focusable widget of a new
 * dialog, the check box), then a click on the right-hand button ("Start without sandbox": GTK lays dialog buttons out left to right in the order given).
 */
async function answerConsentDialog(dialog, answer, { remember = true } = {}) {
  const actions = [];
  const centerX = dialog.x + Math.floor(dialog.width / 2);
  const centerY = dialog.y + Math.floor(dialog.height / 2);
  actions.push(xdo(['mousemove', '--sync', String(centerX), String(centerY)]));
  actions.push(xdo(['windowfocus', '--sync', String(dialog.id)], 5000));
  await delay(300);
  if (answer === 'quit') {
    actions.push(xdo(['key', '--clearmodifiers', 'Escape']));
    return actions;
  }
  if (remember) {
    actions.push(xdo(['key', '--clearmodifiers', 'space']));
    await delay(400);
  }
  const buttonX = dialog.x + dialog.width - Math.min(40, Math.floor(dialog.width / 4));
  const buttonY = dialog.y + dialog.height - 16;
  actions.push(xdo(['mousemove', '--sync', String(buttonX), String(buttonY), 'click', '1']));
  return actions;
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false }); return; }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      resolve({ code: null, signal: 'SIGKILL', timedOut: true });
    }, timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut: false }); });
  });
}

function killGroup(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

/** FUSE check for the AppImage: mount it once (the runtime prints the mount point and stays until signalled). */
async function probeAppImageMount(appimage) {
  const child = spawn(appimage, ['--appimage-mount'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const mountPoint = await waitFor(async () => (/^(\/\S.*)$/m.exec(stdout) || [])[1] || (child.exitCode !== null ? 'exited' : null), { timeoutMs: 30000, what: 'the AppImage mount point' }).catch(() => null);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
  const exit = await waitExit(child, 10000);
  return { mounted: Boolean(mountPoint && mountPoint !== 'exited'), mountPoint: mountPoint === 'exited' ? null : mountPoint, exit, stderr: tail(stderr, 5) };
}

function readAppArmorLabel(pid) {
  for (const file of [`/proc/${pid}/attr/apparmor/current`, `/proc/${pid}/attr/current`]) {
    const text = readText(file).replace(/\0/g, '').trim();
    if (text) return text;
  }
  return null;
}

function procFacts(pid) {
  return { pid, ...parseProcStatus(readText(`/proc/${pid}/status`)), apparmor: readAppArmorLabel(pid) };
}

async function runFlow({ parsed, executable, log, observations }) {
  const { _electron } = require('playwright');
  const root = await makeTempRoot('trace-linux-smoke-');
  const dirs = runDirectories(root);
  for (const directory of [dirs.project, dirs.bin, dirs.launchers, dirs.logs, dirs.home]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(dirs.board, FIXTURE_BOARD);
  await fs.writeFile(dirs.secondBoard, SECOND_FIXTURE_BOARD);
  await fs.writeFile(dirs.pdf, mac.makePdf('TRACE Linux smoke fixture'));
  await fs.writeFile(dirs.png, mac.makePng());
  await fs.writeFile(path.join(dirs.bin, 'xdg-open'), XDG_OPEN_STUB, { mode: 0o755 });
  const boardKey = mac.sha256(Buffer.from(FIXTURE_BOARD));
  const manifestFile = path.join(dirs.profile, 'workspaces', `${boardKey}.json`);
  const repository = readJson(path.join(ROOT, 'electron', 'repository.json')).repository;
  const bugUrl = `https://github.com/${repository}/issues/new?template=bug_report.yml`;
  const evidenceDir = path.dirname(path.resolve(parsed.out || defaultOut(parsed)));

  const checks = [];
  const runtime = { appPlatform: null, appArch: null, isPackaged: null, electron: null, chrome: null, appVersion: null, userData: null, chromeDesktop: null, supportNotice: [], quits: [] };
  const launches = [];
  const errors = [];
  const started = new Set(); // every app process of this run, killed in the end if still alive
  let sandbox = null;
  let defaultProfile = null;
  let appimage = null;
  let aborted = false;
  let app = null;
  let child = null;
  let current = null; // the launch record of the running app
  let page = null;

  const step = async (name, work, { critical = false } = {}) => {
    if (aborted) { checks.push({ name, status: 'skipped', detail: 'an earlier critical step failed' }); return; }
    const begun = Date.now();
    try {
      const detail = await work();
      checks.push({ name, status: 'pass', ms: Date.now() - begun, ...(detail === undefined ? {} : { detail }) });
      log(`PASS ${name}`);
    } catch (error) {
      checks.push({ name, status: 'fail', ms: Date.now() - begun, detail: String(error && error.message ? error.message : error).slice(0, 800) });
      log(`FAIL ${name}: ${error && error.message}`);
      if (critical) aborted = true;
    }
  };

  if (parsed.target === 'appimage') {
    if (!isExecutable(executable)) await fs.chmod(executable, 0o755);
    const probe = await probeAppImageMount(executable);
    appimage = { mode: probe.mounted ? 'fuse' : 'extract-and-run', probe };
    if (!probe.mounted) observations.push(`the AppImage could not be mounted through FUSE (${probe.stderr.join(' ') || 'no output'}); every launch used APPIMAGE_EXTRACT_AND_RUN=1, which runs the same AppRun`);
  }
  const specs = launchSpecs({ expectGate: parsed.expectGate });
  const specFor = (label) => specs.find((spec) => spec.label === label);
  const envOf = (spec) => launchEnvironment(process.env, {
    stubBin: dirs.bin, xdgRecord: dirs.xdgRecord, home: spec.home ? dirs.home : null, acceptNoSandbox: spec.acceptNoSandbox, appimageExtractAndRun: appimage ? appimage.mode === 'extract-and-run' : false,
  });
  // "Do not ask again" is stored as "noSandboxAccepted": true in <profile>/config.json (written before the window is created).
  const answerStored = (profile) => {
    if (!profile) return null;
    try { return JSON.parse(readText(path.join(profile, GATE.configFile)))[GATE.acceptedKey] === true; } catch { return false; }
  };

  /** One Playwright launch through the stderr-copying launcher; answers or rules out the consent dialog as the spec says. */
  const launch = async (spec, { waitForProject = true } = {}) => {
    // A process left behind by a failed step (a dialog nobody answered, a window that never loaded) would confuse the next launch.
    for (const previous of started) killGroup(previous);
    const stderrFile = path.join(dirs.logs, `${spec.label}.stderr.txt`);
    const launcher = path.join(dirs.launchers, `${spec.label}.sh`);
    await fs.writeFile(launcher, wrapperScript({ target: executable, stderrFile }), { mode: 0o755 });
    const { profile, args } = resolveSpec(spec, dirs);
    const env = envOf(spec);
    const record = {
      label: spec.label, args, environment: environmentChanges(process.env, env), acceptNoSandbox: spec.acceptNoSandbox, expectation: spec.gate, gate: null, answer: null,
      actions: [], windowShown: false, exit: null, answerStored: null, stderrFile, stderrTail: [],
    };
    launches.push(record);
    current = record;
    page = null;
    app = await _electron.launch({ executablePath: launcher, args, env, timeout: 90000, chromiumSandbox: true });
    child = app.process();
    started.add(child);
    let windowEvents = 0;
    app.on('window', () => { windowEvents++; });
    const browserWindowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length).catch(() => null);
    if (spec.gate === 'quit' || spec.gate === 'start-remember') {
      record.gate = await waitForConsentDialog({ app, child, stderrFile });
      if (!record.gate.shown) throw new Error(`consent dialog expected: ${record.gate.note}`);
      const picture = screenshotWindow(record.gate.id, path.join(evidenceDir, `${parsed.scenario}-${spec.label}-consent-dialog.png`));
      if (picture) record.gate.screenshot = path.basename(picture);
      record.answer = spec.gate === 'quit' ? 'Quit (Escape)' : 'Start without sandbox + Do not ask again';
      record.actions = await answerConsentDialog(record.gate, spec.gate === 'quit' ? 'quit' : 'start', { remember: true });
      if (spec.gate === 'quit') {
        // If Escape did not reach the dialog, it is still up: click the left-hand button (Quit) instead.
        const ended = await waitFor(async () => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 6000, what: 'the app to end' }).catch(() => false);
        if (!ended && windowEvents === 0 && (await browserWindowCount()) === 0 && findTitledWindows().length > 0) {
          record.actions.push(xdo(['mousemove', '--sync', String(record.gate.x + Math.min(40, Math.floor(record.gate.width / 4))), String(record.gate.y + record.gate.height - 16), 'click', '1']));
          record.answer += ' (click fallback)';
        }
        record.exit = await waitExit(child, 30000);
        record.windowShown = windowEvents > 0;
        record.answerStored = answerStored(profile);
        record.stderrTail = tail(readText(stderrFile));
        app = null;
        return record;
      }
      // If the click missed the button, the dialog is still up and no window exists: answer with the keyboard instead (from the check
      // box, which has the focus, Tab and Tab reach the right-hand button). Never sent once a window exists, where the keys would reach the UI.
      const settled = await waitFor(async () => windowEvents > 0 || child.exitCode !== null || (await browserWindowCount()) > 0 || findTitledWindows().length === 0,
        { timeoutMs: 8000, what: 'the dialog to close' }).catch(() => false);
      if (!settled && child.exitCode === null && windowEvents === 0 && (await browserWindowCount()) === 0 && findTitledWindows().length > 0) {
        record.actions.push(xdo(['key', '--clearmodifiers', 'Tab', 'Tab', 'Return']));
        record.answer += ' (keyboard fallback after the click)';
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        record.exit = { code: child.exitCode, signal: child.signalCode, timedOut: false };
        throw new Error(`the app ended after the answer (exit code ${child.exitCode}): the answer reached Quit, not "Start without sandbox"`);
      }
      page = await app.firstWindow({ timeout: 60000 });
      record.windowShown = true;
      record.answerStored = answerStored(profile);
    } else {
      try {
        page = await app.firstWindow({ timeout: 60000 });
      } catch (error) {
        const dialogs = findTitledWindows();
        throw new Error(`${error.message}${dialogs.length ? `; a window titled "${GATE.title}" is up without a BrowserWindow: probably an unexpected consent dialog` : ''}`);
      }
      record.windowShown = true;
      record.gate = { shown: false };
      record.answerStored = answerStored(profile);
    }
    page.on('pageerror', (error) => errors.push(`${spec.label} pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`${spec.label} console: ${message.text().slice(0, 200)}`); });
    await page.waitForFunction(() => Boolean(window.traceDesktop), null, { timeout: 60000 });
    if (waitForProject) await page.waitForSelector('[data-testid=project-name]', { timeout: 60000 });
    return record;
  };

  const consentState = async (record) => {
    const noSandboxSwitch = await app.evaluate(({ app: electronApp }, name) => electronApp.commandLine.hasSwitch(name), 'no-sandbox');
    const warningLogged = readText(record.stderrFile).includes(GATE.stderrLine);
    Object.assign(record, { noSandboxSwitch, warningLogged });
    return { noSandboxSwitch, warningLogged };
  };
  const expectConsentState = (state, { gateExpected }) => {
    const problems = [];
    if (state.noSandboxSwitch !== gateExpected) problems.push(`the sandbox-off switch is ${state.noSandboxSwitch ? 'present' : 'absent'}`);
    if (state.warningLogged !== gateExpected) problems.push(`the warning line was ${state.warningLogged ? '' : 'not '}written to stderr`);
    if (problems.length) throw new Error(problems.join('; '));
  };

  const readCounts = async () => {
    await page.locator('.statusbar').waitFor({ timeout: 60000 });
    const text = await waitFor(async () => { const value = await page.locator('.status-left').innerText(); return mac.extractCounts(value) ? value : null; }, { timeoutMs: 60000, what: 'status bar counts' });
    return mac.extractCounts(text);
  };
  const waitPainted = async (selector, minimum, timeoutMs = 30000) => {
    let last = null;
    await waitFor(async () => { last = await page.evaluate(paintInPage, selector); return mac.isPainted(last, minimum); }, { timeoutMs, what: `${selector} to be painted` });
    return last;
  };
  const docRows = () => page.$$eval('[data-testid=document-row]', (nodes) => nodes.map((node) => ({ name: node.querySelector('.wsp-doc-title')?.textContent ?? '', status: node.getAttribute('data-status') })));
  const waitRows = async (names) => {
    let rows = [];
    await waitFor(async () => {
      rows = await docRows();
      const failed = rows.filter((row) => ['error', 'unreadable', 'missing', 'changed'].includes(row.status));
      if (failed.length) throw new Error(`document row(s) failed: ${failed.map((row) => `${row.name}=${row.status}`).join(', ')}`);
      return mac.decideRows(rows, names).ok;
    }, { timeoutMs: 45000, what: `document rows ${names.join(', ')} to be ready` });
    return rows;
  };
  const openDocumentsTab = async () => { await page.click('#wsp-tab-documents'); await page.waitForSelector('[data-testid=documents-tab]', { timeout: 30000 }); };
  const openRow = (name) => page.locator('[data-testid=document-row] .wsp-doc-main', { hasText: name }).click();
  // The support notice is a modal <dialog> on every start; it intercepts pointer events until Enter ("Not now", focused) closes it.
  const dismissSupportNotice = async (label) => {
    await page.waitForSelector('[data-testid=support-notice]', { state: 'visible', timeout: 30000 });
    const shown = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid=support-notice]');
      const active = document.activeElement;
      return { modal: Boolean(dialog && dialog.matches(':modal')), focus: active ? active.getAttribute('data-testid') : null };
    });
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid=support-notice]', { state: 'detached', timeout: 15000 });
    runtime.supportNotice.push({ label, ...shown });
    if (shown.focus !== 'support-not-now') throw new Error(`focus is on "${shown.focus}", not on the "Not now" button`);
    if (!shown.modal) throw new Error('the notice is not a modal dialog');
  };
  const quit = async (label, profile = dirs.profile) => {
    const exited = waitExit(child, 30000);
    await app.evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => {});
    const result = await exited;
    runtime.quits.push({ label, ...result });
    if (current) { current.exit = result; current.stderrTail = tail(readText(current.stderrFile)); }
    app = null;
    if (!mac.isCleanExit(result)) throw new Error(`not a normal quit: exit code ${result.code}, signal ${result.signal}${result.timedOut ? ', timed out and was killed' : ''}`);
    const leftovers = [];
    for (const directory of ['workspaces', 'notes']) {
      for (const name of await fs.readdir(path.join(profile, directory)).catch(() => [])) if (name.endsWith('.tmp')) leftovers.push(`${directory}/${name}`);
    }
    if (leftovers.length) throw new Error(`temporary files left in the profile: ${leftovers.join(', ')}`);
    return `exit code ${result.code}`;
  };
  const gateExpected = parsed.expectGate === 'yes';

  try {
    // ---- the consent dialog (only where the process runs without the sandbox), in profiles of its own ----------------------------
    if (gateExpected) {
      const dialogFacts = (record) => ({ windowType: record.gate.windowType, wmClass: record.gate.wmClass, width: record.gate.width, height: record.gate.height, shownAfterMs: record.gate.shownAfterMs, answer: record.answer });
      await step('consent dialog (Quit): started without the sandbox, the app asks before any window; Quit ends it with exit code 0 and stores nothing', async () => {
        const record = await launch(specFor('gate-quit'));
        const problems = decideGate('quit', record);
        if (problems.length) throw new Error(problems.join('; '));
        return { dialog: dialogFacts(record), exit: record.exit };
      });
      let started_ = null;
      await step(`consent dialog (Start): "Start without sandbox" opens the window and "Do not ask again" stores ${GATE.acceptedKey}: true`, async () => {
        started_ = await launch(specFor('gate-start'));
        const problems = decideGate('start-remember', started_);
        const result = await quit('after the consent dialog', dirs.gateProfile).catch((error) => { problems.push(error.message); return null; });
        if (problems.length) throw new Error(problems.join('; '));
        return { dialog: dialogFacts(started_), quit: result };
      });
      if (started_ && started_.answerStored) {
        await step('consent dialog remembered: the next start with that profile opens the window without asking; the warning line is still written', async () => {
          const record = await launch(specFor('gate-remembered'), { waitForProject: false });
          const problems = decideGate('absent', record);
          const state = await consentState(record);
          if (!state.noSandboxSwitch) problems.push('the relaunch has no sandbox-off switch');
          if (!state.warningLogged) problems.push('the warning line was not written to stderr');
          const result = await quit('after the remembered start', dirs.gateProfile).catch((error) => { problems.push(error.message); return null; });
          if (problems.length) throw new Error(problems.join('; '));
          return result;
        });
      } else {
        checks.push({ name: 'consent dialog remembered: the next start with that profile opens the window without asking', status: 'skipped', detail: `no stored ${GATE.acceptedKey}: the step before failed` });
      }
    }

    // ---- launch 1: fresh profile, board from --board -------------------------------------------------------------------------
    let first = null;
    await step(gateExpected
      ? `launch 1: the packaged app starts with an empty temporary profile and shows the UI (${GATE.acceptEnv}=1: no question)`
      : 'launch 1: the packaged app starts with an empty temporary profile and shows the UI without a consent dialog', async () => {
      first = await launch(specFor('launch-1'));
      const problems = decideGate('absent', first);
      if (problems.length) throw new Error(problems.join('; '));
    }, { critical: true });
    await step(`consent state (launch 1): the sandbox-off switch and the warning line are ${gateExpected ? 'present' : 'absent'}`, async () => {
      expectConsentState(await consentState(first), { gateExpected });
    });
    await step('support notice (launch 1): shown on start, "Not now" focused, Enter closes it', () => dismissSupportNotice('launch 1'), { critical: true });
    await step(`runtime facts: packaged, linux, ${parsed.arch}, isolated profile, desktop name ${DESKTOP_FILE}`, async () => {
      const facts = await app.evaluate(({ app: electronApp }) => ({
        isPackaged: electronApp.isPackaged, appVersion: electronApp.getVersion(), userData: electronApp.getPath('userData'), platform: process.platform, arch: process.arch,
        electron: process.versions.electron, chrome: process.versions.chrome, chromeDesktop: process.env.CHROME_DESKTOP ?? null, execPath: process.execPath,
      }));
      Object.assign(runtime, { appPlatform: facts.platform, appArch: facts.arch, isPackaged: facts.isPackaged, electron: facts.electron, chrome: facts.chrome, appVersion: facts.appVersion, userData: facts.userData, chromeDesktop: facts.chromeDesktop, execPath: facts.execPath });
      const problems = [];
      if (facts.platform !== 'linux') problems.push(`the app reports platform ${facts.platform}`);
      if (facts.isPackaged !== true) problems.push('the app is not packaged');
      if (facts.arch !== parsed.arch) problems.push(`the app process is ${facts.arch}, requested ${parsed.arch}`);
      if (path.resolve(facts.userData) !== path.resolve(dirs.profile)) problems.push(`userData is ${facts.userData}, not the temporary profile`);
      if (facts.chromeDesktop !== DESKTOP_FILE) problems.push(`CHROME_DESKTOP is ${facts.chromeDesktop}, expected ${DESKTOP_FILE}`);
      if (problems.length) throw new Error(problems.join('; '));
      return `electron ${facts.electron}, ${facts.platform}/${facts.arch}`;
    });
    await step('renderer is isolated: bridge present, no Node globals', async () => {
      const surface = await page.evaluate(() => ({ bridge: typeof window.traceDesktop, require: typeof window.require, process: typeof window.process }));
      if (surface.bridge !== 'object' || surface.require !== 'undefined' || surface.process !== 'undefined') throw new Error(JSON.stringify(surface));
    });
    await step('exactly one window exists after launch', async () => {
      await delay(2000);
      const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      if (count !== 1) throw new Error(`${count} windows`);
    });
    await step(`Chromium sandbox is ${parsed.expectSandbox} (renderer Seccomp mode and PID namespace read from /proc)${parsed.target === 'installed' ? ', under the AppArmor profile of the .deb' : ''}`, async () => {
      const info = await app.evaluate(({ app: electronApp }, name) => ({
        pid: process.pid, argv: process.argv, noSandboxSwitch: electronApp.commandLine.hasSwitch(name),
        metrics: electronApp.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, serviceName: metric.serviceName ?? null })),
      }), 'no-sandbox');
      const browser = procFacts(info.pid);
      const renderers = info.metrics.filter((metric) => metric.type === 'Tab').map((metric) => procFacts(metric.pid));
      const others = info.metrics.filter((metric) => metric.type !== 'Tab' && metric.type !== 'Browser').map((metric) => ({ type: metric.type, serviceName: metric.serviceName, ...procFacts(metric.pid) }));
      const classification = classifySandbox({ browser, renderers, noSandboxSwitch: info.noSandboxSwitch });
      sandbox = { classification, expected: parsed.expectSandbox, noSandboxSwitch: info.noSandboxSwitch, argv: info.argv, browser, renderers, others };
      const problems = decideSandbox({ expectSandbox: parsed.expectSandbox, classification, target: parsed.target, browserLabel: browser.apparmor });
      if (problems.length) throw new Error(`${problems.join('; ')} (renderers: ${JSON.stringify(renderers.map((renderer) => ({ seccomp: renderer.seccomp, nspid: renderer.nspid })))}, browser nspid ${JSON.stringify(browser.nspid)})`);
      return `${classification}: ${renderers.length} renderer(s), Seccomp ${renderers.map((renderer) => renderer.seccomp).join('/')}, namespace depth ${renderers.map((renderer) => renderer.nspid.length).join('/')} vs ${browser.nspid.length}; AppArmor ${browser.apparmor}`;
    });
    await step('board import through the real UI path: counts match and the canvas is painted', async () => {
      const name = (await page.textContent('[data-testid=project-name]')) ?? '';
      if (!/LinuxSmoke/i.test(name)) throw new Error(`project name is "${name}"`);
      const counts = await readCounts();
      if (!mac.sameCounts(counts, EXPECTED_COUNTS)) throw new Error(`counts ${JSON.stringify(counts)}, expected ${JSON.stringify(EXPECTED_COUNTS)}`);
      return { counts, canvas: await waitPainted('[data-testid=board-pane] canvas', 100) };
    });
    await step('document attach: a PDF and a PNG become ready rows (file chooser replaced in the main process)', async () => {
      await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [dirs.pdf, dirs.png]);
      await openDocumentsTab();
      await page.locator('[data-testid=attach]').first().click();
      return JSON.stringify(await waitRows(DOCUMENT_NAMES));
    });
    await step('the PDF renders in the packaged app (pdf.js worker loaded from the asar)', async () => {
      await openRow(DOCUMENT_NAMES[0]);
      await page.waitForSelector('[data-testid=documents-tab] .pdfv-page[data-render=done]', { timeout: 45000 });
      return waitPainted('.pdfv-page canvas', 150, 15000);
    });
    await step('the PNG decodes and is drawn', async () => {
      await openRow(DOCUMENT_NAMES[1]);
      await page.waitForSelector('[data-testid=documents-tab] .imgv[data-phase=ready]', { timeout: 45000 });
      return waitPainted('.imgv-canvas', 50, 15000);
    });
    await step('workspace save: the manifest for this board is written with both documents', async () => {
      const manifest = await waitFor(async () => {
        try { const parsedManifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); return mac.decideManifest(parsedManifest, { key: boardKey, names: DOCUMENT_NAMES }).ok ? parsedManifest : null; } catch { return null; }
      }, { timeoutMs: 30000, what: 'the workspace manifest' });
      return `${manifest.documents.length} documents, board ${manifest.board.name}`;
    });
    await step('normal quit (app.quit) ends the process with exit code 0 and leaves no temporary files', () => quit('after launch 1'), { critical: true });

    // ---- launch 2: same profile, no --board -----------------------------------------------------------------------------------
    let second = null;
    await step('launch 2: restart with the SAME profile and no --board, no consent dialog', async () => {
      second = await launch(specFor('launch-2'));
      const problems = decideGate('absent', second);
      if (problems.length) throw new Error(problems.join('; '));
    }, { critical: true });
    await step(`consent state (launch 2): the sandbox-off switch and the warning line are ${gateExpected ? 'present' : 'absent'}`, async () => {
      expectConsentState(await consentState(second), { gateExpected });
    });
    await step('support notice (launch 2): shown again, "Not now" focused, Enter closes it', () => dismissSupportNotice('launch 2'), { critical: true });
    await step('restore: the last board returns from the recents and renders', async () => {
      await page.click('#wsp-tab-board');
      await page.waitForSelector('[data-testid=board-pane] canvas', { timeout: 30000 });
      const recents = await page.evaluate(() => window.traceDesktop.recentBoards());
      if (!recents.some((item) => item.path === dirs.board)) throw new Error(`recents: ${JSON.stringify(recents.map((item) => item.path))}`);
      const counts = await readCounts();
      if (!mac.sameCounts(counts, EXPECTED_COUNTS)) throw new Error(`counts ${JSON.stringify(counts)}`);
      return { recents: recents.length, canvas: await waitPainted('[data-testid=board-pane] canvas', 100) };
    });
    await step('restore: the workspace documents are remembered and ready', async () => {
      await openDocumentsTab();
      return JSON.stringify(await waitRows(DOCUMENT_NAMES));
    });
    await step(`X11 identity: the window is in the X tree, WM_CLASS is "${EXECUTABLE_NAME}", "${EXECUTABLE_NAME}" and the window icon is 256x256`, async () => {
      const info = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const handle = window.getNativeWindowHandle();
        return { xid: handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0), title: window.getTitle() };
      });
      const hex = `0x${info.xid.toString(16)}`;
      const tree = parseXwininfoTree(tool('xwininfo', ['-root', '-tree']).stdout);
      const node = tree.find((entry) => entry.id === info.xid);
      const wmClass = parseXpropWmClass(tool('xprop', ['-id', hex, 'WM_CLASS']).stdout);
      // xprop reads at most 500,000 bytes of a property by default and prints nothing for an icon cut short by that limit;
      // the 256 px icon is set twice (window and application icon, about 524 KB), so the limit is raised.
      const iconOutput = tool('xprop', ['-len', String(16 * 1024 * 1024), '-id', hex, '_NET_WM_ICON'], { timeoutMs: 60000 });
      const icon = parseNetWmIconSize(iconOutput.stdout || iconOutput.stderr);
      // Diagnosis only: whether the main process can decode the packaged PNG at all (from the path and from the bytes).
      const mainIcon = await app.evaluate(({ app: electronApp, nativeImage }) => {
        const file = electronApp.getAppPath() + '/assets/icon.png';
        const fromPath = nativeImage.createFromPath(file);
        return { file, fromPathEmpty: fromPath.isEmpty(), fromPathSize: fromPath.getSize() };
      }).catch((error) => ({ error: String(error && error.message || error) }));
      runtime.x11 = { xid: hex, title: info.title, treeName: node ? node.name : null, wmClass, iconSizes: icon.sizes, iconTruncated: icon.truncated, mainIcon, xpropIcon: String(iconOutput.stdout || iconOutput.stderr || '').slice(0, 200) };
      const problems = [];
      if (!node) problems.push(`window ${hex} is not in xwininfo -root -tree`);
      else if (!/TRACE/.test(node.name ?? '')) problems.push(`the X window name is "${node.name}"`);
      if (!wmClass || wmClass[0] !== EXECUTABLE_NAME || wmClass[1] !== EXECUTABLE_NAME) problems.push(`WM_CLASS is ${JSON.stringify(wmClass)}`);
      const largest = icon.sizes.reduce((best, size) => (!best || size.width * size.height > best.width * best.height ? size : best), null);
      if (!largest) problems.push(`the window has no _NET_WM_ICON (main process: ${JSON.stringify(mainIcon)}; xprop: ${JSON.stringify(runtime.x11.xpropIcon)})`);
      else if (largest.width !== 256 || largest.height !== 256) problems.push(`the largest window icon is ${largest.width}x${largest.height}`);
      if (problems.length) throw new Error(problems.join('; '));
      return runtime.x11;
    });
    // openExternal: a check only when the stand-in received the call; if Electron used another path (an XDG portal), it is noted.
    {
      await fs.rm(dirs.xdgRecord, { force: true });
      let opened = null;
      let failure = null;
      if (!aborted) {
        try {
          await page.evaluate(() => window.traceDesktop.openSupportLink('bug'));
          opened = await waitFor(async () => (exists(dirs.xdgRecord) ? parseKeyValueLines(readText(dirs.xdgRecord)) : null), { timeoutMs: 15000, what: 'the stand-in xdg-open' }).catch(() => null);
        } catch (error) { failure = error; }
      }
      if (failure) checks.push({ name: 'openExternal: the bug-report link is handed to the system', status: 'fail', detail: String(failure.message).slice(0, 500) });
      else if (opened) {
        runtime.openExternal = opened;
        const ok = opened.url === bugUrl && opened.argc === '1';
        checks.push({ name: 'openExternal: the bug-report link reaches xdg-open as exactly one https URL', status: ok ? 'pass' : 'fail', detail: ok ? opened.url : `received ${JSON.stringify(opened)}, expected ${bugUrl}` });
        if (opened.ld_library_path !== undefined) observations.push(`xdg-open inherited LD_LIBRARY_PATH=${opened.ld_library_path}`);
      } else if (!aborted) observations.push('openExternal: the stand-in xdg-open received nothing within 15 s (Electron may have used the XDG portal); the link was not verified');
    }
    // A second process with the same profile hands its board argument to the first window and exits; it never reaches the consent
    // question (the single-instance lock comes first). Desktop launchers pass %U as file:// URIs; a shell passes paths relative to its
    // working directory.
    const secondInstance = async (label, projectPattern) => {
      const spec = specFor(label);
      const env = envOf(spec);
      const { args, cwd } = resolveSpec(spec, dirs);
      const secondChild = spawn(executable, args, { env, cwd: cwd ?? undefined, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      started.add(secondChild);
      let output = '';
      secondChild.stdout.on('data', (data) => { output += data; });
      secondChild.stderr.on('data', (data) => { output += data; });
      const exit = await waitExit(secondChild, 60000);
      launches.push({ label, args, cwd, environment: environmentChanges(process.env, env), acceptNoSandbox: spec.acceptNoSandbox, expectation: 'exit', exit, stderrTail: tail(output) });
      if (!mac.isCleanExit(exit)) throw new Error(`the second instance ended with ${JSON.stringify(exit)}: ${tail(output, 5).join(' | ')}`);
      const name = await waitFor(async () => { const value = (await page.textContent('[data-testid=project-name]')) ?? ''; return projectPattern.test(value) ? value : null; }, { timeoutMs: 45000, what: 'the forwarded board' });
      const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      if (count !== 1) throw new Error(`${count} windows after the second launch`);
      return `second instance exit ${exit.code} (${args[args.length - 1]}), first window shows "${name}"`;
    };
    await step('single instance: a second launch with a file:// URI of another board exits with code 0 and the first window shows that board', () => secondInstance('second-instance-uri', /LinuxSmokeTwo/i));
    await step('single instance: a second launch with a board path relative to its working directory hands it to the first window', () => secondInstance('second-instance-relative', /LinuxSmoke(?!Two)/i));
    await step('normal quit again ends with exit code 0', () => quit('after launch 2'));

    // ---- default profile location -----------------------------------------------------------------------------------------------
    await step(`default data location: without --user-data-dir and XDG_CONFIG_HOME the profile is $HOME/.config/${EXECUTABLE_NAME}, created private (0700)`, async () => {
      const record = await launch(specFor('default-location'), { waitForProject: false });
      const problems = decideGate('absent', record);
      const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
      defaultProfile = decideDefaultProfile({ home: dirs.home, userData });
      if (!defaultProfile.ok) problems.push(`userData is ${userData}, expected ${defaultProfile.expected}`);
      else if (!exists(userData)) problems.push(`${userData} was not created`);
      else {
        defaultProfile.mode = (fsSync.statSync(userData).mode & 0o777).toString(8);
        if (defaultProfile.mode !== '700') problems.push(`${userData} has mode ${defaultProfile.mode}, expected 700`);
      }
      const state = await consentState(record);
      try { expectConsentState(state, { gateExpected }); } catch (error) { problems.push(error.message); }
      const exit = await quit('after the default-location launch', userData).catch((error) => { problems.push(error.message); return null; });
      if (problems.length) throw new Error(problems.join('; '));
      return `${defaultProfile.relative}; ${exit}`;
    });
    await step('no uncaught page errors or renderer console errors in any launch', async () => { if (errors.length) throw new Error(errors.slice(0, 4).join(' | ')); });
  } finally {
    for (const process_ of started) killGroup(process_);
    for (const record of launches) if (record.stderrFile && !record.stderrTail.length) record.stderrTail = tail(readText(record.stderrFile));
    for (const record of launches) delete record.stderrFile;
    await removeTempRoot(root, parsed.keepTemp);
    if (parsed.keepTemp) log(`Kept ${root}`);
  }
  return { checks, runtime, launches, gate: gateRecords(launches), sandbox, defaultProfile, appimage };
}

async function runScenario(parsed, { env = process.env, log = console.log } = {}) {
  const gate = platformGate(process.platform);
  if (!gate.allowed) throw new Error(gate.message);
  const startedAt = new Date().toISOString();
  const executable = path.resolve(executableFor(parsed));
  const observations = [];
  let checks = [];
  let flow = { runtime: null, launches: null, gate: null, sandbox: null, defaultProfile: null, appimage: null };
  let error = null;
  const facts = hostFacts(env);
  const userns = { expected: parsed.userns, sysctl: facts.host.apparmorRestrictUnprivilegedUserns, unshare: facts.host.unshareUr.ok };
  try {
    const usernsProblems = decideUserns({ expected: parsed.userns, sysctl: userns.sysctl, unshareOk: userns.unshare });
    checks.push({ name: `scenario environment: unprivileged user namespaces are ${parsed.userns}`, status: usernsProblems.length ? 'fail' : 'pass', ...(usernsProblems.length ? { detail: usernsProblems.join('; ') } : {}) });
    if (!exists(executable)) throw new Error(`the executable does not exist: ${executable}`);
    if (parsed.target === 'installed') {
      const status = tool('dpkg-query', ['-W', '-f=${Status} ${Version}', DEB_PACKAGE]);
      const sandboxMode = (() => { try { return (fsSync.statSync(`${INSTALL_DIR}/chrome-sandbox`).mode & 0o7777).toString(8); } catch { return null; } })();
      facts.installed = { dpkg: status.stdout.trim(), apparmorProfileFile: exists(`/etc/apparmor.d/${EXECUTABLE_NAME}`), chromeSandboxMode: sandboxMode };
      const problems = [];
      if (!/^install ok installed /.test(facts.installed.dpkg)) problems.push(`dpkg reports "${facts.installed.dpkg}"`);
      if (!facts.installed.apparmorProfileFile) problems.push(`/etc/apparmor.d/${EXECUTABLE_NAME} is missing`);
      checks.push({ name: 'the .deb is installed and its AppArmor profile file is in place', status: problems.length ? 'fail' : 'pass', ...(problems.length ? { detail: problems.join('; ') } : { detail: facts.installed }) });
    }
    if (usernsProblems.length) {
      checks.push({ name: 'packaged-app flow', status: 'skipped', detail: 'the host is not in the user-namespace state of this scenario' });
    } else {
      flow = await runFlow({ parsed, executable, log, observations });
      checks = checks.concat(flow.checks);
    }
  } catch (caught) {
    error = caught && caught.stack ? caught.stack : String(caught);
    log(`ERROR ${error}`);
    checks.push({ name: 'the run completed', status: 'fail', detail: String(caught && caught.message ? caught.message : caught).slice(0, 500) });
  }
  const evidence = buildEvidence({
    kind: 'run', commit: parsed.commit, arch: parsed.arch, scenario: parsed.scenario, target: parsed.target, executable, userns, expectSandbox: parsed.expectSandbox,
    expectGate: parsed.expectGate, sandbox: flow.sandbox, gate: flow.gate, defaultProfile: flow.defaultProfile, appimage: flow.appimage, runtime: flow.runtime,
    launches: flow.launches, host: { ...facts.host, ...(facts.installed ? { installed: facts.installed } : {}) }, run: facts.run, checks, observations, startedAt,
    finishedAt: new Date().toISOString(), error,
  });
  evidence.path = await writeEvidence(evidence, parsed.out || defaultOut(parsed), log);
  return evidence;
}

async function runStatic(parsed, { env = process.env, log = console.log } = {}) {
  const gate = platformGate(process.platform);
  if (!gate.allowed) throw new Error(gate.message);
  const startedAt = new Date().toISOString();
  const facts = hostFacts(env);
  let result = { checks: [], facts: null };
  let error = null;
  try {
    result = await staticChecks(parsed, { log });
  } catch (caught) {
    error = caught && caught.stack ? caught.stack : String(caught);
    log(`ERROR ${error}`);
    result.checks.push({ name: 'the static checks completed', status: 'fail', detail: String(caught && caught.message ? caught.message : caught).slice(0, 500) });
  }
  const evidence = buildEvidence({
    kind: 'static', commit: parsed.commit, arch: parsed.arch, packages: result.facts, host: facts.host, run: facts.run, checks: result.checks, startedAt, finishedAt: new Date().toISOString(), error,
  });
  evidence.path = await writeEvidence(evidence, parsed.out || defaultOut(parsed), log);
  return evidence;
}

async function readEvidenceDirectory(directory) {
  const names = await fs.readdir(directory).catch(() => []);
  const evidences = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
      if (parsed && parsed.schema === SCHEMA) evidences.push(parsed);
    } catch { /* not evidence */ }
  }
  return evidences;
}

async function main(argv, env = process.env) {
  const command = argv[0];
  const dryRun = argv.includes('--dry-run');
  // The platform gate comes first for the two commands that produce Linux evidence; only a dry run (prints a plan, writes nothing)
  // and the summary of existing evidence run elsewhere.
  if ((command === 'static' || command === 'run') && !dryRun) {
    const gate = platformGate(process.platform);
    if (!gate.allowed) { console.error(gate.message); return EXIT.REFUSED; }
  }
  const parsed = parseArgs(argv, env);
  if (parsed.help || parsed.errors.length) {
    for (const message of parsed.errors) console.error(`linux-smoke: ${message}`);
    console.error(USAGE);
    return parsed.help && !parsed.errors.length ? EXIT.OK : EXIT.REFUSED;
  }
  if (parsed.command === 'summary') {
    console.log(formatSummary(await readEvidenceDirectory(parsed.dir)));
    return EXIT.OK;
  }
  if (parsed.dryRun) {
    const cwd = process.cwd().split(path.sep).join('/');
    const version = (() => { try { return readJson(path.join(ROOT, 'package.json')).version; } catch { return null; } })();
    const plan = parsed.command === 'run' ? planRun(parsed, { base: env, cwd }) : planStatic(parsed, { version, cwd });
    console.log(JSON.stringify(plan, null, 2));
    return EXIT.OK;
  }
  if (parsed.command === 'run' && typeof process.getuid === 'function' && process.getuid() === 0) {
    console.error('linux-smoke: refusing to run as root: Chromium does not sandbox a root process, so the result would not describe a user\'s run.');
    return EXIT.REFUSED;
  }
  const evidence = parsed.command === 'run' ? await runScenario(parsed, { env }) : await runStatic(parsed, { env });
  console.log(`${evidence.passed ? 'PASSED' : 'FAILED'}: ${evidence.kind === 'run' ? `${evidence.scenario} ${evidence.target}` : 'static package checks'}${evidence.failedChecks.length ? ` (failed: ${evidence.failedChecks.join('; ')})` : ''}`);
  return evidence.passed ? EXIT.OK : EXIT.FAILED;
}

module.exports = Object.freeze({
  EXIT, SCHEMA, COMMANDS, TARGETS, PRODUCT_NAME, EXECUTABLE_NAME, DESKTOP_FILE, INSTALL_DIR, INSTALLED_EXECUTABLE, DEB_PACKAGE, MAINTAINER, CATEGORIES,
  ICON_PATH, ARCHES, GATE, SANDBOX_OFF_SWITCHES, FIXTURE_NAME, SECOND_FIXTURE_NAME, DOCUMENT_NAMES, FIXTURE_BOARD, SECOND_FIXTURE_BOARD, EXPECTED_COUNTS,
  FUSE_INDEX, FUSE_NAMES, NOT_COVERED, USAGE, XDG_OPEN_STUB,
  platformGate, parseArgs, executableFor, artifactFileName, defaultOut, shQuote, wrapperScript, assertSandboxKept, fileUri, launchArgs, launchEnvironment, resolveSpec,
  environmentChanges, launchSpecs, runDirectories, parseProcStatus, classifySandbox, decideSandbox, decideUserns, decideGate, parseDesktopEntry,
  checkDesktopEntry, parseDebFields, checkDebFields, parseDebListing, checkDebListing, checkAppArmorProfile, checkPostinst, checkAppRun, elfMachine,
  pngSize, parseXpropWmClass, parseXpropAtom, parseXpropString, parseNetWmIconSize, parseXwininfo, parseXwininfoTree, parseXdotoolIds,
  parseKeyValueLines, expectedFuseWire, describeFuseWire, compareFuseWire, decideDefaultProfile, buildEvidence, formatSummary, planRun, planStatic,
  runScenario, runStatic, main,
});

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = EXIT.FAILED; });
}
