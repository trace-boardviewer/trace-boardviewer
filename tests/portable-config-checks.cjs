'use strict';

// W-win-build-01 — static tripwire for the portable wrapper's extraction directory.
//
// EVIDENCE CLASS: static source/config. These checks read package.json and the PINNED electron-builder sources
// (app-builder-lib NsisTarget.js and templates/nsis/portable.nsi) and prove that the configured value selects the
// per-launch branch of that builder version. They do NOT prove how the Windows wrapper behaves — that is shown
// only by scripts/check-portable-isolation.cjs run against the real EXE on Windows (see windows.yml,
// job `portable-isolation`, and its control job).
//
// Background (electron-builder 26.15.3, read from source, which contradicts the text in its scheme.json):
//   NsisTarget.js:   if (typeof unpackDirName === "string" || !unpackDirName) defines.UNPACK_DIR_NAME = unpackDirName || ksuid()
//   portable.nsi:    $INSTDIR = "$PLUGINSDIR\app"; !ifdef UNPACK_DIR_NAME => $INSTDIR = "$TEMP\<UNPACK_DIR_NAME>";
//                    RMDir /r $INSTDIR before extracting and again after the app exits.
// => unset / false / '' / a string  : ONE fixed directory per EXE build, shared by every concurrent launch, so the
//                                     first instance to exit (or the next launch) deletes the other's runtime.
// => true                            : UNPACK_DIR_NAME stays undefined and each launch extracts into its own NSIS
//                                     plug-in directory ($PLUGINSDIR, unique per launch).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function builderLibrary() {
  const builderManifest = require.resolve('electron-builder/package.json', { paths: [root] });
  const libraryManifest = require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builderManifest)] });
  return { directory: path.dirname(libraryManifest), version: JSON.parse(fs.readFileSync(libraryManifest, 'utf8')).version };
}
const normalizeSpace = (text) => text.replace(/\s+/g, ' ').trim();
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

// The portable branch of the pinned builder, as a model of what the source does with the configured value.
// It is only used after the source text is pinned below, so it cannot silently drift from the real code.
const PINNED_CONDITION = 'typeof unpackDirName === "string" || !unpackDirName';
function wrapperDirectory(unpackDirName) {
  const definesUnpackDirName = typeof unpackDirName === 'string' || !unpackDirName;
  return definesUnpackDirName ? 'fixed-shared-temp-directory' : 'per-launch-plugins-directory';
}

test('portable config: build.portable.unpackDirName is exactly true (per-launch extraction)', () => {
  assert.equal(packageJson.build?.portable?.unpackDirName, true,
    'package.json build.portable.unpackDirName must be the boolean true. Unset, false, "" or any string makes every launch of one EXE build extract into the SAME %TEMP% directory, and closing one instance deletes the other running instance\'s runtime (W-win-build-01).');
  assert.equal(wrapperDirectory(packageJson.build.portable.unpackDirName), 'per-launch-plugins-directory');
});

test('build config: the Electron fuses of the portable binary (no run-as-node, no NODE_OPTIONS, code only from the integrity-checked ASAR; --inspect kept for the packaged QA launches)', () => {
  assert.deepEqual(packageJson.build?.electronFuses, {
    runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: true,
    onlyLoadAppFromAsar: true, enableEmbeddedAsarIntegrityValidation: true, enableCookieEncryption: true, grantFileProtocolExtraPrivileges: true,
  }, 'tests/mac-config-checks.cjs holds the same list for the Mac file and checks it against the builder schema');
});

test('portable config: no other builder config file or CLI override can shadow the package.json value', () => {
  const stray = fs.readdirSync(root).filter((name) => /^electron-builder\.(ya?ml|json5?|toml|[cm]?[jt]s)$/i.test(name));
  assert.deepEqual(stray, [], `an electron-builder.* config file would replace package.json "build": ${stray.join(', ')}`);
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    assert.doesNotMatch(command, /unpackDirName/i, `script "${name}" must not override portable.unpackDirName`);
  }
});

test('portable semantics model: only true avoids the fixed shared directory (the string/false/unset cases are the defect)', () => {
  assert.equal(wrapperDirectory(true), 'per-launch-plugins-directory');
  for (const shared of [undefined, null, false, '', 'any-name', 'false']) {
    assert.equal(wrapperDirectory(shared), 'fixed-shared-temp-directory', `unpackDirName=${JSON.stringify(shared)}`);
  }
});

test('pinned builder source: NsisTarget.js still defines UNPACK_DIR_NAME exactly as verified (re-verify on upgrade)', () => {
  const library = builderLibrary();
  const source = normalizeSpace(read(library.directory, 'out', 'targets', 'nsis', 'NsisTarget.js'));
  const expected = `if (${PINNED_CONDITION}) { defines.UNPACK_DIR_NAME = unpackDirName || (0, builder_util_1.generateKsuid)(); }`;
  assert.ok(source.includes(expected),
    `app-builder-lib ${library.version}: the portable UNPACK_DIR_NAME rule changed. Re-read NsisTarget.js and portable.nsi, re-run the Windows isolation check (scripts/check-portable-isolation.cjs) and then update this pin and the model above.`);
  assert.equal(packageJson.devDependencies['electron-builder'], library.version, 'electron-builder must stay an exact pin that matches the installed builder library');
});

test('pinned builder template: portable.nsi picks $PLUGINSDIR\\app unless UNPACK_DIR_NAME is defined, and cleans only $INSTDIR', () => {
  const library = builderLibrary();
  const template = normalizeSpace(read(library.directory, 'templates', 'nsis', 'portable.nsi'));
  const order = [
    'StrCpy $INSTDIR "$PLUGINSDIR\\app"',
    '!ifdef UNPACK_DIR_NAME StrCpy $INSTDIR "$TEMP\\${UNPACK_DIR_NAME}" !endif',
    'RMDir /r $INSTDIR SetOutPath $INSTDIR',
    'ExecWait "$INSTDIR\\${APP_EXECUTABLE_FILENAME} $R0" $0 SetErrorLevel $0',
    // pnpm patch (patches/app-builder-lib@26.15.3.patch): the final removal is retried while a child of the app still holds a file.
    'SetOutPath $EXEDIR',
    'traceCleanupRetry: RMDir /r $INSTDIR IfFileExists "$INSTDIR\\*.*" 0 traceCleanupDone',
    'Sleep 250 Goto traceCleanupRetry traceCleanupDone: SectionEnd',
  ];
  let cursor = 0;
  for (const fragment of order) {
    const found = template.indexOf(fragment, cursor);
    assert.notEqual(found, -1, `app-builder-lib ${library.version}: portable.nsi no longer contains, in order: ${fragment}`);
    cursor = found + fragment.length;
  }
});

test('pnpm patch of the builder template: concurrent wrappers serialize the NSIS plug-in directory initialization through a lock file, before the first plug-in call of .onInit', () => {
  // Measured on real Windows (run 37326477292): two wrappers started within ~5 ms share one $PLUGINSDIR in 8/40 (fixed build)
  // and 7/40 (old layout) attempts and one launch is lost; NSIS's own initializer (GetTempFileName -> Delete -> CreateDirectory)
  // is not atomic. The patch holds a FILE_SHARE_READ-only handle on one lock file while the first plug-in call runs.
  const library = builderLibrary();
  const template = normalizeSpace(read(library.directory, 'templates', 'nsis', 'portable.nsi'));
  const onInit = template.slice(template.indexOf('Function .onInit'), template.indexOf('FunctionEnd', template.indexOf('Function .onInit')));
  const order = [
    'SetSilent silent',
    'FileOpen $traceInitLock "$TEMP\\trace-boardviewer-portable-init.lock" a',
    'IfErrors 0 traceInitLocked',
    'Sleep 5 Goto traceInitLockRetry',
    "System::Call 'kernel32::GetCurrentProcessId()i.r0'",
    'FileClose $traceInitLock',
    '!insertmacro check64BitAndSetRegView',
  ];
  let cursor = 0;
  for (const fragment of order) {
    const found = onInit.indexOf(fragment, cursor);
    assert.notEqual(found, -1, `.onInit no longer contains, in order: ${fragment}`);
    cursor = found + fragment.length;
  }
  assert.equal(onInit.indexOf('System::Call'), onInit.indexOf("System::Call 'kernel32::GetCurrentProcessId()i.r0'"), 'the lock-protected call is the FIRST plug-in call of .onInit');
  assert.ok(onInit.indexOf('FileOpen $traceInitLock') < onInit.indexOf('System::Call'), 'the lock is taken before any plug-in call');
  assert.ok(onInit.indexOf('IntCmp $traceInitLockTries 2000 traceInitLockGiveUp') !== -1, 'the wait is bounded (2000 x 5 ms)');
  // The patch is registered for the locked install, so CI builds the same wrapper.
  const workspace = read(root, 'pnpm-workspace.yaml');
  assert.match(workspace, /patchedDependencies:\n\s+app-builder-lib@26\.15\.3: patches\/app-builder-lib@26\.15\.3\.patch\n/);
  const lock = read(root, 'pnpm-lock.yaml');
  assert.match(lock, /patchedDependencies:\n\s+app-builder-lib@26\.15\.3: fb4d2faf53597e8007c7547e77e37b95b97e6fd9e04e35781796edcc12210342\n/, 'the lockfile pins the patch digest');
  // Byte-exact: .gitattributes keeps *.patch at LF on every checkout (a CRLF conversion on Windows changed the digest once).
  const patch = read(root, 'patches', 'app-builder-lib@26.15.3.patch');
  assert.equal(/\r/.test(patch), false, 'the patch file is checked out with LF line endings (.gitattributes *.patch eol=lf)');
  assert.equal(require('node:crypto').createHash('sha256').update(patch).digest('hex'), 'fb4d2faf53597e8007c7547e77e37b95b97e6fd9e04e35781796edcc12210342');
  assert.match(read(root, '.gitattributes'), /^\*\.patch text eol=lf$/m);
  assert.ok(patch.includes('+    FileOpen $traceInitLock "$TEMP\\trace-boardviewer-portable-init.lock" a') && patch.includes('+  traceCleanupRetry:'), 'the patch carries both changes and nothing else touches the template');
  assert.equal((patch.match(/^diff --git /gm) || []).length, 1, 'exactly one file is patched');
  // The directory name is not the proof: pnpm names the patched instance `app-builder-lib@26.15.3_patch_hash=<sha>` or,
  // when that exceeds its virtual-store name limit (seen with pnpm 11 on Windows), an abbreviated
  // `app-builder-lib@26.15.3_pat_<md5>` (W-fix3-qa-01). The proof is the template itself: byte-exact digest of the
  // upstream 26.15.3 template plus the repository patch, which an unpatched instance (junction to another install,
  // `pnpm install` without the patch) cannot produce.
  const templateDigest = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(library.directory, 'templates', 'nsis', 'portable.nsi'))).digest('hex');
  assert.equal(templateDigest, 'eb1e6096c21807a0b27b3db985050418f63f79fb394e56025995ee06b2651dfb', 'the resolved app-builder-lib carries the patched template byte-for-byte');
  assert.match(path.basename(path.dirname(path.dirname(library.directory))), /^app-builder-lib@26\.15\.3_(patch_hash=|pat_)/, 'the resolved app-builder-lib is a patched pnpm instance (full or abbreviated directory name)');
});

test('pinned builder source: the bundled option text for unpackDirName is known to contradict the code (do not "fix" the value from the docs)', () => {
  const library = builderLibrary();
  const scheme = JSON.parse(read(library.directory, 'scheme.json'));
  const description = JSON.stringify(scheme).match(/"unpackDirName":\{"description":"([^"]*)"/)?.[1] ?? '';
  // The text says `false` selects the per-launch $PLUGINSDIR; the code above says `true` does. If the builder fixes the
  // text, this test starts failing so someone re-reads the new semantics instead of trusting either side.
  assert.match(description, /set explicitly to `false`.*PLUGINSDIR/i,
    'The scheme text changed; re-verify the semantics against NsisTarget.js and portable.nsi before changing anything.');
});

// ---------------------------------------------------------------------------------------------------------
// Payload hygiene of the Windows package (master plan D25). EVIDENCE CLASS: static config and pinned builder source.
// Measured before the change on real portable builds (win-unpacked of 1.1.0, same files list): resources/app.asar.unpacked held
// node_modules/@napi-rs/canvas-win32-x64-msvc (skia.win32-x64-msvc.node, 37 MB) and no app-update.yml was written. What the
// shipped package really contains is confirmed by the Windows CI job (portable build, payload manifest, packaged smoke test).
// ---------------------------------------------------------------------------------------------------------

test('payload: the unused @napi-rs/canvas native binary stays out of the Windows package (the exclusion of the macOS and Linux files)', () => {
  const build = packageJson.build;
  const exclusion = '!node_modules/@napi-rs/**';
  assert.ok(build.files.includes(exclusion),
    'package.json build.files must exclude @napi-rs: only pdfjs-dist\'s Node-only canvas path refers to it (the renderer is sandboxed), and without the line the host\'s prebuilt .node binary is bundled and unpacked into app.asar.unpacked.');
  assert.deepEqual(build.files.filter((pattern) => pattern.startsWith('!')), [exclusion], 'the exclusion is the only negation of the Windows list');
  assert.equal(build.files.at(-1), exclusion, 'negations come last, after every positive pattern (the order the macOS and Linux files keep, guarded by their drift checks)');
  for (const key of ['asarUnpack', 'extraResources', 'extraFiles']) {
    assert.ok(!(key in build) && !(key in (build.win ?? {})) && !(key in (build.portable ?? {})), `${key} could bring the binary back: no extra payload beyond build.files`);
  }
});

// The catalogs are folders of namespace files (electron/locales/<language>/<namespace>.json) that the main process reads at run
// time (electron/locale-catalogs.cjs); a files pattern that drops one would ship a language without a feature's texts. The macOS and
// Linux lists are the same positive patterns (their drift guards in mac-config-checks.cjs and linux-config-checks.cjs).
test('payload: build.files selects every catalog namespace file of all eight languages and the modules that load them', () => {
  const { Minimatch } = require(require.resolve('minimatch', { paths: [builderLibrary().directory] }));
  // The builder's own matching options (app-builder-lib fileMatcher.js: { dot: true }); a negation removes what a positive pattern selected.
  const rules = packageJson.build.files.map((pattern) => ({ negate: pattern.startsWith('!'), matcher: new Minimatch(pattern.replace(/^!/, ''), { dot: true }) }));
  // ... plus the builder's built-in exclusions of file names and extensions (fileMatcher.js adds them after the configured patterns).
  const { excludedExts, excludedNames } = require(path.join(builderLibrary().directory, 'out', 'fileMatcher.js'));
  for (const pattern of [`**/*.{${excludedExts},pdb}`, '**/._*', `**/{${excludedNames}}`]) rules.push({ negate: true, matcher: new Minimatch(pattern, { dot: true }) });
  const selected = (file) => rules.some((rule) => !rule.negate && rule.matcher.match(file)) && !rules.some((rule) => rule.negate && rule.matcher.match(file));
  const { LANGUAGES } = require('../electron/i18n.cjs');
  assert.equal(LANGUAGES.length, 8);
  const locales = path.join(root, 'electron', 'locales');
  assert.deepEqual(fs.readdirSync(locales).sort(), [...LANGUAGES].sort(), 'electron/locales holds one folder per language and no flat catalog file');
  const english = fs.readdirSync(path.join(locales, 'en')).filter((name) => name.endsWith('.json')).sort();
  assert.ok(english.length >= 10, 'the English namespace files exist');
  for (const language of LANGUAGES) {
    const names = fs.readdirSync(path.join(locales, language)).filter((name) => name.endsWith('.json')).sort();
    assert.deepEqual(names, english, `${language} has the same namespace files as English`);
    for (const name of names) assert.ok(selected(`electron/locales/${language}/${name}`), `build.files must select electron/locales/${language}/${name}`);
  }
  for (const file of ['electron/i18n.cjs', 'electron/locale-catalogs.cjs']) assert.ok(selected(file), `build.files must select ${file}`);
});

test('payload: package.json publishes nothing, so no app-update.yml with the repository name can be generated (publish: null)', () => {
  const build = packageJson.build;
  assert.equal(build.publish, null, 'build.publish must be an explicit null (as in the macOS and Linux files): the builder otherwise derives a GitHub provider from the git remote');
  // A target-level or platform-level publish would take precedence over the global null (PublishManager.getPublishConfigs).
  assert.equal(build.win?.publish, undefined);
  assert.equal(build.portable?.publish, undefined);
  assert.deepEqual(build.win?.target, ['portable'], 'the Windows build is the portable EXE only');
});

test('pinned builder source: app-update.yml is written only next to an installer target, and an explicit global publish null resolves to no publish configuration', () => {
  const library = builderLibrary();
  const source = normalizeSpace(read(library.directory, 'out', 'publish', 'PublishManager.js'));
  // The portable target is neither "nsis" nor an electron-updater aware appx, so the hook returns before it writes the file: the
  // file is absent from portable builds today and `publish: null` is the guard for the day an installer target is added.
  const suitable = 'function isSuitableWindowsTarget(target) { if (target.name === "appx" && target.options != null && target.options.electronUpdaterAware) { return true; } return target.name === "nsis" || target.name.startsWith("nsis-"); }';
  assert.ok(source.includes(suitable), `app-builder-lib ${library.version}: isSuitableWindowsTarget changed. Re-check whether the portable target now gets resources/app-update.yml.`);
  assert.ok(source.includes('else if (packager.platform === index_1.Platform.WINDOWS) { if (!event.targets.some(it => isSuitableWindowsTarget(it))) { return; } }'),
    `app-builder-lib ${library.version}: the onAfterPack guard for Windows targets changed`);
  assert.ok(source.includes('publishers = platformPackager.config.publish; if (publishers === null) { return null; }'),
    `app-builder-lib ${library.version}: a null global publish no longer resolves to "no publish configuration"`);
  assert.ok(source.includes('"app-update.yml"'), 'the file name the other platforms assert against is still the one the builder writes');
});

// Text recognition (OCR) payload. EVIDENCE CLASS: static config and source. The engine files reach the package only as files Vite
// emits into dist/assets (the OCR worker chunk, the two LSTM WebAssembly builds and the gzip English data, about 8.9 MB), which
// build.files already ships inside app.asar; nothing is executed from the real file system, so no asarUnpack is needed. The npm
// packages themselves (44 MB and 14 MB with every build and data variant) must never be copied into app.asar/node_modules.
test('payload: the OCR engine ships inside app.asar through dist/assets; its npm packages are exact development dependencies only', () => {
  const build = packageJson.build;
  for (const name of ['tesseract.js-core', '@tesseract.js-data/eng']) {
    assert.match(packageJson.devDependencies?.[name] ?? '', /^\d+\.\d+\.\d+$/, `${name} is pinned to an exact version as a devDependency`);
    assert.ok(!(name in (packageJson.dependencies ?? {})), `${name} must not be a production dependency: electron-builder would copy the whole package into app.asar/node_modules`);
  }
  for (const wrapper of ['tesseract.js', 'tesseract-wasm']) {
    assert.ok(!(wrapper in (packageJson.dependencies ?? {})) && !(wrapper in (packageJson.devDependencies ?? {})), `${wrapper} is not used (its worker defaults to a CDN and it runs an install script)`);
  }
  assert.ok(build.files.includes('dist/**/*'), 'dist/ (with dist/assets) is shipped inside app.asar');
  assert.equal(build.asar, true);
  assert.ok(!('asarUnpack' in build), 'no asarUnpack: the worker, the WebAssembly and the language data are read by the renderer from the archive');
  const bundled = fs.readFileSync(path.join(root, 'src', 'lib', 'ocr', 'bundled.ts'), 'utf8');
  for (const asset of ['tesseract.js-core/tesseract-core-simd-lstm.wasm?url', 'tesseract.js-core/tesseract-core-lstm.wasm?url', '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url']) {
    assert.ok(bundled.includes(`'${asset}'`), `${asset} is a literal import, so Vite emits it into dist/assets`);
  }
  assert.match(bundled, /new Worker\(new URL\('\.\/ocr\.worker\.ts', import\.meta\.url\), \{ type: 'module'/, 'the worker is a module worker emitted by Vite (never a blob: worker, which would need wasm-unsafe-eval in the page CSP)');
  const worker = fs.readFileSync(path.join(root, 'src', 'lib', 'ocr', 'ocr.worker.ts'), 'utf8');
  for (const build of ['tesseract-core-simd-lstm.js', 'tesseract-core-lstm.js']) assert.ok(worker.includes(`'tesseract.js-core/${build}'`), `the worker bundles ${build}`);
  for (const file of fs.readdirSync(path.join(root, 'src', 'lib', 'ocr')).filter((name) => !name.endsWith('.test.ts'))) {
    const text = fs.readFileSync(path.join(root, 'src', 'lib', 'ocr', file), 'utf8');
    assert.doesNotMatch(text, /https?:\/\/|jsdelivr|unpkg|cdn\./i, `${file}: no remote URL in the OCR code (everything is bundled)`);
  }
});
