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
