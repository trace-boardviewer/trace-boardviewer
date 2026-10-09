'use strict';

// STATIC checks for the Linux packaging configuration. This is NOT Linux runtime acceptance: it never launches the app, never
// builds a package and says nothing about how the product behaves on a Linux desktop. It parses config/electron-builder.linux.yml
// with the pinned electron-builder's own YAML loader and schema, checks it against the "build" block of package.json (the Linux
// file is a copy, see its header), asks the pinned builder to generate the desktop entries from it, and pins the behaviour of the
// builder's Linux templates that the sandbox policy relies on. It runs on Linux, Windows and macOS:
//
//   node --test tests/linux-config-checks.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const rel = (...parts) => path.join(ROOT, ...parts);

const CONFIG_FILE = 'config/electron-builder.linux.yml';
const SELF_FILE = 'tests/linux-config-checks.cjs';
// The only negation the Linux "files" list may add to the package.json list; see the header of the config file.
const ALLOWED_NEGATIONS = ['!node_modules/@napi-rs/**'];
const MAINTAINER = 'TRACE Boardviewer <noreply@trace-boardviewer.invalid>';
const SANDBOX_SWITCH = /--(?:no|disable)[-a-z]*sandbox|ELECTRON_DISABLE_SANDBOX/i;

// The pinned electron-builder resolves its own YAML parser, schema validator and Linux target code; nothing is added to the project.
function builderTools() {
  const builderManifest = require.resolve('electron-builder/package.json', { paths: [ROOT] });
  const libManifest = require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builderManifest)] });
  const libDirectory = path.dirname(libManifest);
  const lib = (...parts) => path.join(libDirectory, ...parts);
  return {
    directory: libDirectory,
    lib,
    version: JSON.parse(fs.readFileSync(libManifest, 'utf8')).version,
    yaml: require(require.resolve('js-yaml', { paths: [libDirectory] })),
    validateConfiguration: require(lib('out', 'util', 'config', 'config.js')).validateConfiguration,
  };
}
const tools = builderTools();
const parseYaml = (text) => tools.yaml.load(text);
// The two inputs below can be pointed at COPIES (mutation checks of the assertions): the real files are never edited, not even
// temporarily.
const CONFIG_PATH = process.env.TRACE_LINUX_CHECKS_CONFIG || rel(CONFIG_FILE);
const PACKAGE_JSON_PATH = process.env.TRACE_LINUX_CHECKS_PACKAGE_JSON || rel('package.json');
const configText = fs.readFileSync(CONFIG_PATH, 'utf8');
const linuxConfig = parseYaml(configText);
const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
const repository = JSON.parse(fs.readFileSync(rel('electron', 'repository.json'), 'utf8')).repository;
const HOMEPAGE = `https://github.com/${repository}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const validate = (config) => tools.validateConfiguration(clone(config), { isEnabled: false, add() {} });
const SCHEMA_ERROR = /does not match the API schema/;
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

// Every key name that appears anywhere in the parsed config (objects inside arrays included).
function keysOf(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, found));
  else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { found.add(key); keysOf(inner, found); }
  return found;
}
// What must never reach a public file: a person's address or a path of the machine the file was written on.
function personalTraces(text) {
  const found = [];
  for (const [address] of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) if (address !== 'noreply@trace-boardviewer.invalid') found.push(`address ${address}`);
  for (const [location] of text.matchAll(/(?:^|[\s'"=(])(?:[A-Za-z]:[\\/]|\/(?:home|Users|root)\/|\\\\)[^\s'")]*/g)) found.push(`path ${location.trim()}`);
  return found;
}

test('static: the Linux config is a valid electron-builder configuration for the pinned builder', async () => {
  assert.equal(tools.version, packageJson.devDependencies['electron-builder'], 'the schema checked against is the pinned builder version');
  await validate(linuxConfig);
  assert.ok(linuxConfig && typeof linuxConfig === 'object' && !Array.isArray(linuxConfig));
  // The schema rejects unknown keys, so a typo in a security-relevant option cannot pass silently.
  for (const mutate of [
    (config) => { config.linux.executableArg = ['--example']; },
    (config) => { config.linux.syncDesktopNames = true; },
    (config) => { config.deb.recomends = []; },
    (config) => { config.electronFuse = { runAsNode: true }; },
    (config) => { config.toolsets.appimage = '9.9.9'; },
  ]) {
    const broken = clone(linuxConfig);
    mutate(broken);
    await assert.rejects(() => validate(broken), SCHEMA_ERROR, String(mutate));
  }
});

test('static: placement - the config is not auto-discovered and nothing Linux-specific sits in the shipped trees', () => {
  const discovered = fs.readdirSync(ROOT).filter((name) => /^electron-builder\.(?:ya?ml|json5?|toml|[cm]?js|ts)$/.test(name));
  assert.deepEqual(discovered, [], 'a root electron-builder.* file would be auto-discovered by the builder');
  assert.equal(path.posix.dirname(CONFIG_FILE), 'config');
  for (const file of [CONFIG_FILE, SELF_FILE]) {
    assert.ok(fs.existsSync(rel(file)), `${file} exists`);
    assert.ok(!['assets', 'electron', 'src', 'dist'].includes(file.split('/')[0]), `${file} must not sit under a shipped tree`);
  }
  // The shipped trees (the ASAR packs assets/, electron/ and dist/) must hold no Linux packaging artifacts either: the icon set,
  // the desktop entry and the AppArmor profile are generated by the builder at build time.
  const offenders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (/\.(?:desktop|appimage|deb|rpm|snap|flatpak)$/i.test(entry.name) || /(?:^|[-_.])(?:linux|apparmor)(?:[-_.]|$)/i.test(entry.name)) offenders.push(path.relative(ROOT, full));
    }
  };
  for (const tree of ['assets', 'electron', 'src']) if (fs.existsSync(rel(tree))) walk(rel(tree));
  assert.deepEqual(offenders, []);
  // Build outputs of the three platforms never reach a commit.
  const ignored = read(ROOT, '.gitignore').split(/\r?\n/).map((line) => line.trim());
  for (const directory of ['release/', 'release-mac/', 'release-linux/']) assert.ok(ignored.includes(directory), `.gitignore lists ${directory}`);
});

test('static: design - AppImage and deb for one architecture per run, arch in every artifact name, separate output directory', () => {
  const targets = [].concat(linuxConfig.linux.target);
  assert.deepEqual(targets, ['AppImage', 'deb'], 'v1 ships an AppImage and a deb only (tar.gz, rpm, snap and flatpak are deferred)');
  for (const target of targets) assert.equal(typeof target, 'string', 'the arch is chosen by the command line, never pinned inside the target');
  assert.equal(linuxConfig.linux.defaultArch, undefined);
  assert.ok(!/universal/i.test(JSON.stringify(linuxConfig)));
  for (const token of ['${version}', '${arch}', '${ext}', 'linux']) assert.ok(linuxConfig.linux.artifactName.includes(token), `artifactName contains ${token}`);
  assert.ok(!('artifactName' in (linuxConfig.deb || {})) && !('artifactName' in (linuxConfig.appImage || {})), 'one artifact name pattern for both formats');
  assert.equal(linuxConfig.directories.output, 'release-linux');
  const others = [packageJson.build.directories.output, 'release-mac'];
  for (const other of others) {
    assert.notEqual(linuxConfig.directories.output, other, 'must differ from the other platforms\' output directories');
    for (const [a, b] of [[linuxConfig.directories.output, other], [other, linuxConfig.directories.output]]) assert.ok(!`${a}/`.startsWith(`${b}/`), `${a} must not live inside ${b}`);
  }
  assert.equal(linuxConfig.publish, null, 'nothing is published and no app-update.yml is generated from the git remote');
  assert.equal(linuxConfig.electronDist, undefined, 'the host Electron (node_modules/electron/dist) must not be copied into a possibly other-arch build');
  assert.equal(linuxConfig.toolsets.appimage, '1.0.3', 'the static AppImage runtime: no libfuse2, no sandbox switch in the desktop entry');
  assert.deepEqual(Object.keys(linuxConfig.toolsets), ['appimage']);
  for (const hook of ['afterSign', 'afterPack', 'beforePack', 'afterAllArtifactBuild', 'onNodeModuleFile']) assert.ok(!(hook in linuxConfig), `${hook} hook`);
  for (const key of ['snap', 'snapcraft', 'rpm', 'pacman', 'flatpak', 'appImage', 'extraResources', 'extraFiles', 'asarUnpack']) assert.ok(!(key in linuxConfig), `${key} is not configured`);
  // The icon is the SVG source: the builder installs a single PNG source unchanged under hicolor/<its size>, and the hicolor theme
  // lists no directory above 512 px, so the 1024x1024 PNG would never be found by menus and docks. An SVG goes to scalable/apps.
  assert.equal(linuxConfig.linux.icon, 'assets/icon.svg');
  const icon = fs.readFileSync(rel(linuxConfig.linux.icon), 'utf8');
  assert.match(icon, /^<svg\b[^>]*\sviewBox="0 0 1024 1024"/, 'a square, self-contained vector image');
  assert.doesNotMatch(icon, /<(?:image|script|style|text|foreignObject|use)\b|xlink:href|\shref=|url\(|<!ENTITY/i, 'no external reference, script or text in the icon');
  assert.ok(!('icon' in linuxConfig), 'the icon is a linux option only: a root icon would also feed the Windows and macOS formats');
});

test('static: sandbox policy - no sandbox switch anywhere, the builder\'s AppArmor and SUID handling stays as shipped', () => {
  assert.doesNotMatch(configText, SANDBOX_SWITCH, 'neither the options nor the comments of the config mention a sandbox-off switch');
  const keys = keysOf(linuxConfig);
  for (const key of ['executableArgs', 'afterInstall', 'afterRemove', 'appArmorProfile', 'fpm', 'depends', 'mimeTypes', 'protocols', 'fileAssociations', 'license']) {
    assert.ok(!keys.has(key), `${key} must not be configured: the builder defaults stay`);
  }
  assert.ok(!keys.has('Exec') && !keys.has('StartupWMClass'), 'the launcher line and the window class come from the builder');
  assert.deepEqual(linuxConfig.deb.recommends, [], 'no libappindicator3-1: no tray icon is used and the package is gone from current Ubuntu releases');
  assert.deepEqual(Object.keys(linuxConfig.deb).sort(), ['packageCategory', 'priority', 'recommends']);
});

test('static: identity - names, desktop entry, maintainer and homepage are neutral and consistent', () => {
  const linux = linuxConfig.linux;
  assert.match(linux.executableName, /^[a-z0-9-]+$/);
  assert.equal(linux.executableName, packageJson.name, 'one name for the executable, the package, the icon and the profile Electron derives from package.json');
  assert.equal(linuxConfig.extraMetadata.desktopName, `${linux.executableName}.desktop`);
  assert.deepEqual(Object.keys(linuxConfig.extraMetadata).sort(), ['desktopName', 'homepage'], 'nothing else is written into the packaged package.json');
  assert.equal(linuxConfig.extraMetadata.homepage, HOMEPAGE, 'the repository URL from electron/repository.json, never derived from a git remote');
  assert.equal(linux.syncDesktopName, true);
  assert.equal(linux.maintainer, MAINTAINER);
  assert.equal(linux.vendor, 'TRACE Boardviewer');
  assert.equal(linux.category, 'Development;Electronics;');
  assert.deepEqual(Object.keys(linux.desktop), ['entry']);
  assert.deepEqual(Object.keys(linux.desktop.entry).sort(), ['GenericName', 'Keywords']);
  assert.ok(linux.synopsis && linux.description);
  assert.ok(!linux.synopsis.includes('\n') && !linux.description.includes('\n'));
  assert.deepEqual(personalTraces(configText), [], 'no address other than the project\'s non-deliverable one, no local path');
  assert.deepEqual([...configText.matchAll(/https?:\/\/[^\s'")]+/g)].map((match) => match[0]), [HOMEPAGE], 'the homepage is the only URL in the file');
  assert.ok(!/\b(?:copyright|\(c\))\b/i.test(configText));
});

test('static: no personal address or machine path in the Linux files', () => {
  assert.deepEqual(personalTraces(configText), []);
  assert.deepEqual(personalTraces(fs.readFileSync(rel(SELF_FILE), 'utf8')), []);
  // The detector itself: a match for every shape of leak it is meant to find (the samples are assembled here so that this file
  // does not contain them).
  const backslash = String.fromCharCode(92);
  const drive = ['C:', 'Users', 'someone', 'project'].join(backslash);
  assert.equal(personalTraces(`path: ${drive}`).length, 1);
  assert.equal(personalTraces('see ' + '/home' + '/someone/project').length, 1);
  assert.equal(personalTraces('see ' + '/Users' + '/someone/project').length, 1);
  assert.equal(personalTraces('mail someone' + '@' + 'mail.invalid').length, 1);
  assert.equal(personalTraces(`maintainer: '${MAINTAINER}'`).length, 0);
  assert.equal(personalTraces('output: release-linux\nfiles: node_modules/@napi-rs/**').length, 0);
});

test('static: drift guard - appId, productName, asar and files match package.json "build"', () => {
  const build = packageJson.build;
  assert.equal(linuxConfig.appId, build.appId);
  assert.equal(linuxConfig.productName, build.productName);
  assert.equal(linuxConfig.asar, build.asar);
  const negations = linuxConfig.files.filter((pattern) => pattern.startsWith('!'));
  assert.deepEqual(negations.filter((pattern) => !ALLOWED_NEGATIONS.includes(pattern)), [], 'only documented negations are allowed');
  assert.deepEqual(linuxConfig.files.filter((pattern) => !pattern.startsWith('!')), build.files.filter((pattern) => !pattern.startsWith('!')), 'the positive patterns are identical, in order');
  assert.ok(build.files.includes('shared/bug-report-contract.cjs'), 'the shared report contract is packaged');
  assert.deepEqual(build.files.filter((pattern) => pattern.startsWith('!') && !linuxConfig.files.includes(pattern)), [], 'a negation added to package.json must also be in the Linux list');
  assert.deepEqual(linuxConfig.files.slice(-negations.length), negations, 'negations come last');
  assert.ok(!('asarUnpack' in linuxConfig) && !('extraResources' in linuxConfig) && !('extraFiles' in linuxConfig), 'no extra payload beyond package.json build');
  assert.equal(linuxConfig.disableAsarIntegrity, undefined);
  assert.equal(build.disableAsarIntegrity, undefined);
});

// The same seven fuses as the Windows build: no ELECTRON_RUN_AS_NODE, no NODE_OPTIONS, application code only from app.asar, encrypted
// cookies; file:// keeps its privileges (the UI and pdf.js load over it) and --inspect stays on (packaged-build smoke tests attach
// through it). Electron 44 compiles ASAR integrity validation for macOS and Windows only, so that fuse is inert on Linux; it is kept
// equal so that one list stays valid everywhere. A fuse not listed keeps Electron's default, so the lists are compared whole.
test('static: Electron fuses - package.json "build" and the Linux file flip the same fuses and the pinned builder maps every name', async () => {
  const expected = {
    runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: true,
    onlyLoadAppFromAsar: true, enableEmbeddedAsarIntegrityValidation: true, enableCookieEncryption: true, grantFileProtocolExtraPrivileges: true,
  };
  assert.deepEqual(packageJson.build.electronFuses, expected, 'the Windows build block');
  assert.deepEqual(linuxConfig.electronFuses, expected, 'the Linux file: the same set (resetAdHocDarwinSignature is macOS only)');
  for (const bad of [{ enableNodeCliInspect: false }, { resetAdhocDarwinSignature: true }, { grantFileProtocolExtraPrivilege: true }]) {
    const broken = clone(linuxConfig);
    broken.electronFuses = { ...broken.electronFuses, ...bad };
    await assert.rejects(() => validate(broken), SCHEMA_ERROR, JSON.stringify(bad));
  }
  // The names are mapped one by one onto @electron/fuses (platformPackager.generateFuseConfig); a key the pinned builder does not map
  // would pass the schema and change nothing in the binary.
  const packager = read(tools.lib('out', 'platformPackager.js'));
  for (const key of Object.keys(expected)) assert.ok(packager.includes(`if (fuses.${key} != null)`), `${key} is handed to @electron/fuses by app-builder-lib ${tools.version}`);
  // The fuses are flipped in the Linux executable (named after linux.executableName), not only in Windows and macOS binaries.
  assert.ok(packager.includes('this instanceof index_1.LinuxPackager ? this.executableName : this.appInfo.productFilename'));
});

test('static: the @napi-rs exclusion is safe - no shipped runtime code can require it', () => {
  assert.ok(ALLOWED_NEGATIONS.every((pattern) => linuxConfig.files.includes(pattern)), 'the documented exclusion is present');
  const allowedRequires = new Set(['electron', 'fflate']);
  for (const name of fs.readdirSync(rel('electron')).filter((entry) => entry.endsWith('.cjs'))) {
    const source = fs.readFileSync(rel('electron', name), 'utf8');
    assert.doesNotMatch(source, /napi-rs|pdfjs-dist|createRequire/, `electron/${name} must not reach @napi-rs/canvas`);
    for (const [, specifier] of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      assert.ok(allowedRequires.has(specifier), `electron/${name} requires "${specifier}": review whether the Linux "files" exclusions still hold`);
    }
  }
  assert.ok(packageJson.dependencies.fflate, 'fflate (required by electron/documents.cjs) is a production dependency and is not excluded');
  assert.ok(!linuxConfig.files.some((pattern) => /fflate/.test(pattern)));
});

// The pinned builder generates the desktop entries from the config. They are produced here by the builder's own code with a minimal
// stand-in for the packager, so that the launcher line, the window class and the categories are checked without Linux or a build.
test('static: desktop entries - the pinned builder generates them from the config for the AppImage and the deb', async () => {
  const { LinuxTargetHelper } = require(tools.lib('out', 'targets', 'LinuxTargetHelper.js'));
  const AppImageTarget = require(tools.lib('out', 'targets', 'appimage', 'AppImageTarget.js')).default;
  const packager = {
    config: linuxConfig,
    platformSpecificBuildOptions: linuxConfig.linux,
    fileAssociations: [],
    executableName: linuxConfig.linux.executableName,
    // The product name has no character the builder would sanitize, so the install directory is the product name.
    appInfo: { productName: linuxConfig.productName, sanitizedProductName: linuxConfig.productName, description: packageJson.description, buildVersion: packageJson.version },
    // The builder's metadata is package.json with extraMetadata merged over it.
    info: { metadata: { ...packageJson, ...linuxConfig.extraMetadata } },
  };
  const helper = new LinuxTargetHelper(packager);
  const entryOf = (text) => Object.fromEntries(text.split('\n').filter((line) => /^[A-Za-z-]+=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const appImage = await new AppImageTarget(null, packager, helper, 'out').desktopEntry.value;
  const deb = await helper.computeDesktopEntry({ ...linuxConfig.linux, ...linuxConfig.deb });
  const common = {
    Name: 'TRACE Boardviewer',
    Terminal: 'false',
    Type: 'Application',
    Icon: 'trace-boardviewer',
    StartupWMClass: 'trace-boardviewer',
    GenericName: 'Boardviewer',
    Categories: 'Development;Electronics;',
    Comment: linuxConfig.linux.description,
    Keywords: linuxConfig.linux.desktop.entry.Keywords,
  };
  assert.deepEqual(entryOf(appImage), { ...common, Exec: 'AppRun %U', 'X-AppImage-Version': packageJson.version });
  assert.deepEqual(entryOf(deb), { ...common, Exec: '"/opt/TRACE Boardviewer/trace-boardviewer" %U' });
  for (const entry of [appImage, deb]) {
    assert.doesNotMatch(entry, SANDBOX_SWITCH, 'no launcher line carries a sandbox switch');
    assert.doesNotMatch(entry, /^MimeType=/m, 'no file association is registered');
  }
  // The icon files the builder installs for these entries: the SVG itself, which both targets place under hicolor/scalable/apps.
  // (An SVG source is returned as it is; nothing is converted or written.)
  const { convertIcon } = require(tools.lib('out', 'util', 'iconConverter.js'));
  const derived = await convertIcon({ sources: [linuxConfig.linux.icon], fallbackSources: [], roots: [ROOT], format: 'set', outDir: path.join(ROOT, 'release-linux', '.icon-set-unused') });
  assert.equal(derived.isFallback, false);
  assert.deepEqual(derived.icons.map((icon) => path.basename(icon.file)), ['icon.svg']);
  assert.equal(helper.getDesktopFileName(), 'trace-boardviewer', 'the desktop file is named like the window class Electron derives from desktopName');
  assert.equal(linuxConfig.extraMetadata.desktopName, `${entryOf(deb).StartupWMClass}.desktop`);
  // The names the builder derives for the package and the AppArmor profile.
  assert.equal(packager.executableName, packageJson.name);
});

// Behaviour of the pinned builder that the sandbox policy of the Linux release relies on. If an upgrade changes one of these
// lines, re-read the builder's Linux code and the policy before updating the pin.
test('static: pinned builder behaviour - AppRun sandbox probe, AppArmor profile, SUID rule and the static AppImage runtime', () => {
  const appRun = read(tools.lib('out', 'targets', 'appimage', 'appImageUtil.js'));
  assert.ok(appRun.includes('! unshare -Ur true'), 'AppRun probes unprivileged user namespaces before it decides anything');
  assert.ok(appRun.includes('NO_SANDBOX=(--no-sandbox)'), 'the only place a sandbox switch is added: when the probe fails');
  const target = read(tools.lib('out', 'targets', 'appimage', 'AppImageTarget.js'));
  assert.ok(target.includes('appimageTool == null || appimageTool === "0.0.0" ? ["--no-sandbox"] : []'), 'only the legacy runtime writes a sandbox switch into the desktop entry; 1.0.3 does not');
  const profile = read(tools.directory, 'templates', 'linux', 'apparmor-profile.tpl');
  assert.ok(profile.includes('userns,') && profile.includes('flags=(unconfined)'), 'the profile lets the app create user namespaces');
  assert.ok(profile.includes('abi <abi/4.0>'));
  const afterInstall = read(tools.directory, 'templates', 'linux', 'after-install.tpl');
  assert.ok(afterInstall.includes('apparmor_parser --replace --write-cache --skip-read-cache'), 'the profile is loaded at install time');
  assert.ok(afterInstall.includes('apparmor_parser --skip-kernel-load'), 'and only where this AppArmor version accepts it');
  assert.ok(afterInstall.includes('unshare --user true') && afterInstall.includes('chmod 4755'), 'the SUID helper is set only where user namespaces do not work');
  assert.ok(read(tools.directory, 'templates', 'linux', 'after-remove.tpl').includes('apparmor_parser --remove'), 'removal unloads the profile');
  const fpm = read(tools.lib('out', 'targets', 'FpmTarget.js'));
  assert.ok(fpm.includes('"apparmor-profile"'), 'the profile is copied into resources/');
  assert.ok(fpm.includes('extWithDot === ".svg" ? "scalable"'), 'the deb installs an SVG icon under hicolor/scalable/apps');
  assert.ok(read(tools.lib('out', 'targets', 'appimage', 'appLauncher.js')).includes('"scalable/apps"'), 'the AppImage installs an SVG icon under hicolor/scalable/apps');
  assert.ok(read(tools.lib('out', 'util', 'iconConverter.js')).includes('resolved.endsWith(".svg") && format === "set"'), 'an SVG source is used as it is for the Linux icon set');
  const { appimageChecksums } = require(tools.lib('out', 'toolsets', 'linux.js'));
  assert.ok(appimageChecksums['1.0.3'] && Object.keys(appimageChecksums['1.0.3']).length === 1, 'the pinned builder knows the 1.0.3 AppImage toolset and verifies its checksum');
});
