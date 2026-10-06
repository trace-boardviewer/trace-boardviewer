# macOS packaging and validation baseline

Status: a reviewable baseline, written and statically checked on Linux, followed by one native run on an Apple M3 (macOS 26.6.2, arm64, Electron 44.5.1) recorded in section 7 and in `docs/MAC_LOCAL_REPORT_arm64_2026-10-06.md`: the arm64 bundle was built, launched, driven by hand and passed by `scripts/mac-smoke.cjs` on that Mac (classification `native arm64 on arm64`). Sections 1–6 keep the static findings as written; where section 7 corrects them (M-01 refuted, M-04 confirmed and fixed, M-03 not reproduced) section 7 wins. The x64 (Intel) build and a universal build have not been run on any Mac, Linux, static and cross-build checks are never macOS runtime acceptance, and there is no signed or notarized Mac release: the arm64 build is offered only as an experimental, ad-hoc signed download.

Everything marked **UNVERIFIED** is a statement that could not be checked offline or on Linux. It must be confirmed on a Mac or at dispatch time before anyone relies on it.

| File | Purpose |
| --- | --- |
| `config/electron-builder.mac.yml` | Standalone electron-builder config: unsigned (ad-hoc) zip of the `.app`, one architecture per run, output in `release-mac/`. |
| `.github/workflows/windows.yml` (`mac` job) | Part of the release workflow (skipped for pull requests). Builds the zip on an arm64 runner, collects evidence, runs the smoke test and the private-name scan, uploads the zip with its SHA256 file for the draft release and the evidence as a separate 14-day artifact. |
| `scripts/mac-smoke.cjs` | Launch / import / attach / save / quit / restart smoke test for the packaged app. Refuses to run unless `process.platform === 'darwin'`. |
| `tests/mac-config-checks.cjs` | Static and simulated checks (run on any OS): `node --test tests/mac-config-checks.cjs`. |

Commands (a human on a Mac or the workflow; one architecture per run):

```sh
pnpm run build
pnpm exec electron-builder --mac zip --arm64 --config config/electron-builder.mac.yml --publish never   # or --x64
node scripts/mac-smoke.cjs --app "release-mac/mac-arm64/TRACE Boardviewer.app" --arch arm64   # x64: release-mac/mac/..., --arch x64
```

## 1. Architecture support

| Target | How it is built | What counts as native validation | Status |
| --- | --- | --- | --- |
| arm64 (Apple silicon) | `--arm64`; the builder downloads the `darwin-arm64` Electron zip (no `electronDist`) | An Apple silicon Mac or arm64 runner, app process not translated; evidence classification `native arm64 on arm64` | Validated natively once, on an Apple M3 (section 7). |
| x64 (Intel) | `--x64`; the builder downloads the `darwin-x64` Electron zip | An Intel Mac or Intel runner; evidence classification `native x64 on x64` | Not validated. |
| x64 on Apple silicon (Rosetta) | The same x64 build, run under translation | Never. The smoke script labels it `Rosetta (x64 on Apple silicon): NOT native Intel validation` and sets `nativeValidation: false` | Allowed as a diagnostic only. |
| universal | Not built | - | Deferred (reasons below). |

How "native" is decided (`classifyValidation` in `scripts/mac-smoke.cjs`, unit-tested): the main binary must be a single-architecture Mach-O (`lipo -info` / `file`), equal to the requested `--arch`, equal to the host architecture, and `sysctl -n sysctl.proc_translated` asked **inside the app process** must return `0`. An unknown translation state is never reported as native. The host architecture uses `hw.optional.arm64` so that a Node process itself running under Rosetta cannot pass as Intel.

Universal build decision: not built in the baseline.

- Each slice needs its own native run anyway; one universal run cannot validate both an Intel and an Apple silicon machine.
- electron-builder packs both architectures and merges them with `@electron/universal` (`app-builder-lib/out/macPackager.js`, `doUniversalPack`), with ASAR integrity and fuses disabled for the intermediate packs. That is more machinery and none of it can be checked on Linux.
- The merge needs identical app contents in both slices. Host-architecture native modules would break it; the config already excludes the only one (section 2.3), but this is exactly the kind of drift a universal build would hide.
- It roughly doubles the download. Revisit after both single-architecture baselines pass natively.

Minimum macOS version: the config does not set `LSMinimumSystemVersion`, so the value comes from the Electron 44.5.1 bundle. UNVERIFIED which version that is; the smoke evidence records it (`app.minimumSystemVersion`).

## 2. What was inspected

### 2.1 Application code (read-only)

Findings are ordered by severity. "Owner" is who has to act; none of the code changes were applied (section 6).

| ID | Severity | Evidence | Finding and proposed fix | Owner |
| --- | --- | --- | --- | --- |
| M-01 | High (expected, UNVERIFIED on a Mac) | `electron/main.cjs:639` `Menu.setApplicationMenu(null)`; `:591` `setMenuBarVisibility(false)` | Electron documents that `null` suppresses the default menu. On macOS the menu bar carries Cmd+Q, Cmd+H, Cmd+M, Cmd+W and the Edit key equivalents; as widely reported for Electron (not reproduced here), Cmd+C / V / X / A / Z do not reach text fields without an Edit menu. The renderer's own shortcuts (`src/components/workspace/Shell.tsx:225`, `ctrlKey \|\| metaKey`) are unaffected, but the search field, note editor and PDF page box are text inputs. A no-menu app is not acceptable on macOS. Minimal fix: darwin-only template with the `appMenu`, `editMenu`, `windowMenu` roles (patch 6.1). | Lead (main.cjs + desktop-checks mock) |
| M-02 | Medium | `electron/main.cjs:582` `frame: false`; custom window buttons `src/components/workspace/TopBar.tsx:54`; drag region `src/styles.css:4`; IPC `main.cjs:536-541` | No traffic-light buttons on macOS; the Windows-style minimize / maximize / close sit at the right edge. No native full-screen button. Works, but not Mac-like. A `titleBarStyle: 'hidden'` variant is a UI decision and is not proposed here. | Lead / product |
| M-03 | Medium (UNVERIFIED) | `electron/main.cjs:646` `activate`, `:637-645` `whenReady` | Electron documents that `activate` also fires on first launch. The handler is registered before ready and is not gated on the startup chain, which awaits `loadConfig()` before `createWindow()`. If `activate` arrives in that gap there are no windows, so `createWindow()` runs before `installIpc()` and the startup chain then creates a second window; the first becomes an orphan whose IPC is rejected by `trustedSender`. If it arrived before ready, `new BrowserWindow` would throw. Timing cannot be reproduced on Linux. The smoke test checks that exactly one window exists after launch. Fix: patch 6.2. | Lead |
| M-04 | Medium (UNVERIFIED) | `electron/main.cjs:632-636` `open-file`, `:545-550` `deliverBoard` | After the last window closes the process stays alive on macOS (`:647`). A Finder "Open With" or `open -a` then fires `open-file`, `deliverBoard` stores the path in `pendingBoardPath` (`:549`) because `mainWindow` is null, and nothing creates a window. The board waits until the user clicks the Dock icon. Matters once the app is a document handler (M-06) or for `open -a`. Fix: patch 6.3. | Lead |
| M-05 | Low once M-01 is fixed | `electron/main.cjs:647` `window-all-closed` | Not quitting on darwin is the correct convention. Without a menu (M-01) the only ways out are Dock > Quit or `app.quit()`, and the custom close button leaves a windowless process. | Lead |
| M-06 | Decision | `electron/formats.json`; no `CFBundleDocumentTypes` | File associations are deferred: Finder double-click, Dock-drop and "recommended application" will not work. Reasons: the board extension list mixes proprietary and generic types (`.xml`, `.brd`, `.pcb`, `.asc`, `.neu`) that must not be claimed as default owner; the right set and `Alternate` rank is a product decision; the `open-file` path has the M-04 gap; none of it can be tested on Linux. Drag-and-drop into the window (`preload.cjs` `webUtils.getPathForFile`) and the Open dialog do not need it. | Product / lead |
| M-07 | Info | `electron/main.cjs:620-631`; Electron docs for `requestSingleInstanceLock` | On macOS the system keeps a second Finder launch out and sends `open-file`; `second-instance` (argv parsing, `:624-631`) only fires for command-line launches. The lock is expected to be per user-data directory, so each `--user-data-dir` profile is independent (UNVERIFIED on macOS). | - |
| M-08 | Low (UNVERIFIED on macOS) | `electron/main.cjs:85-92`, `:99` | The default user-data folder is derived from `package.json` `name`, not from `app.setName('TRACE Boardviewer')` at `:91`. Observed with Electron 44.5.1 on Linux (same initialisation code): name `trace-boardviewer`, user data `.../trace-boardviewer`, unchanged after `setName`. Expected on macOS: `~/Library/Application Support/trace-boardviewer`, not `TRACE Boardviewer`. The packaged `package.json` has no `productName` (inspected in a Linux dir build). All persistence goes through `app.getPath('userData')` (`:99`); no `%APPDATA%` or other Windows location is hard-coded anywhere in `electron/`. The checklist records the real default path. | Lead (documentation) |
| M-09 | Low | `electron/identity.cjs:12-17,68`; `electron/main.cjs:115-116`; `identity.cjs:82` `probeCaseInsensitive` | APFS is case-insensitive by default. Darwin keeps paths exact (never merges two files), so the worst case is one file listed twice in the recents. `probeCaseInsensitive` exists but is not wired ("phase 3 on a real Mac"). Board keys are content hashes and store names are lowercase hex, so they are not affected. | Lead, with Mac evidence |
| M-10 | Low | `electron/main.cjs:283`, `tests/canonical-temp.cjs` | `os.tmpdir()` is `/var/folders/...`, a symlink into `/private/var`. The app canonicalises with `realpath`, so recents and manifests hold `/private/var/...`. The smoke test creates its fixtures under the canonical temp root for the same reason. | - |
| M-11 | Low | `electron/main.cjs:428,460,520`; `electron/formats.cjs` `dialogFilters` | Native open / save / attach dialogs with extension filters become sheets on a frameless window. UNVERIFIED. The smoke test replaces the dialogs in the main process, so the checklist asks for a manual run with the real dialogs. | Human validator |
| M-12 | Low | `electron/main.cjs:648-656` `before-quit` | The drain pattern prevents the first quit and calls `app.quit()` again after the store drained. On a macOS logout or restart this may make the app cancel the first termination request (UNVERIFIED). | Lead, with Mac evidence |
| M-13 | Low | `electron/documents.cjs:361,496` | A relative path or name segment starting with `X:` is rejected (Windows drive-letter guard). A POSIX file literally named like `a:b.pdf` would be refused. Cosmetic. | - |
| M-14 | Info | `electron/main.cjs:92`; Electron typings (`@platform win32`) | `setAppUserModelId` is Windows-only and harmless elsewhere. `BrowserWindow` `icon: assets/icon.ico` (`:583`) is ignored on macOS; the Dock / Finder icon comes from the bundle. | - |
| M-15 | Info | `electron/main.cjs:93`, `:625` | `argv.slice(app.isPackaged ? 1 : 2)` is correct for a packaged macOS binary. | - |

### 2.2 Existing QA scripts: reusable against a packaged `.app`?

None of them as they are (read-only analysis):

- `scripts/qa-smoke.cjs:280` hard-codes `release/win-unpacked/TRACE Boardviewer.exe` and `electron.exe`; it also needs a real board (`TRACE_TEST_BOARD`) and Hungarian UI labels.
- `scripts/qa-workspace-e2e.cjs:104` and `tests/electron-smoke.cjs:57` hard-code `node_modules/electron/dist/electron` (the Linux layout; on macOS the binary is inside `Electron.app/Contents/MacOS`) and pass `--no-sandbox`.
- `scripts/qa-localization.cjs:506` accepts `TRACE_PACKAGED_EXE` for a packaged binary; the rest of that script was not assessed for macOS.

`scripts/mac-smoke.cjs` therefore copies the mechanism (Playwright `_electron.launch`, stubbed chooser, `data-testid` selectors, workspace manifest polling) from `qa-workspace-e2e.cjs` without editing it. Its flow was rehearsed on Linux against the development Electron under Xvfb to validate selectors and logic: every UI step passed, and the checks that need darwin or a packaged app failed, as designed. That rehearsal is not macOS evidence.

### 2.3 Builder semantics (pinned sources, electron-builder and app-builder-lib 26.15.3)

| Question | Answer (source) |
| --- | --- |
| `--config` versus package.json `build` | With `--config <file>` the builder reads only that file; the `build` block is not read or merged (`out/util/config/load.js`, `getConfig` calls `readConfig`). `extends` can load other config files but cannot reuse the `build` block of `package.json`. Hence the copied fields and the drift test. A root `electron-builder.*` file is only discovered when package.json has no `build` key (`loadConfig` / `findAndReadConfig`); the Mac file lives in `config/` and the test forbids a root file. |
| Schema | The config validates against the pinned `scheme.json` (unknown keys are rejected); the test runs the builder's own `validateConfiguration`. |
| Targets | `zip` is `ArchiveTarget` (archives the folder holding the `.app`, symlinks preserved); `dmg` needs `hdiutil` (`dmg-builder/out/hdiuil.js`) and so a Mac. Default targets are zip and dmg. The baseline builds zip only. |
| Signing | `identity` not set: keychain search, and if nothing is found signing is skipped for all architectures with no automatic ad-hoc fallback (`scheme.json` text, `MacTargetHelper.findSigningIdentity`). `identity: null`: skip entirely (`handleNullIdentity`). `identity: "-"`: explicit ad-hoc opt-in. Off macOS the builder skips signing (`macCodeSign.isSignAllowed`). |
| Why ad-hoc (`"-"`) here | Packaging modifies the downloaded Electron bundle (renames the executable, rewrites `Info.plist`, adds `app.asar`), and Apple silicon requires arm64 code to carry at least an ad-hoc signature. With `null` the original per-binary signatures would remain beside a broken bundle seal (behaviour UNVERIFIED, not pursued). With `"-"` `osx-sign` re-signs the whole bundle consistently. |
| Caveat of `"-"` | The builder still runs `security find-identity -v` and matches `"-"` as a **substring** of identity names (`macCodeSign._findIdentity`). On a Mac or account holding a code-signing identity whose name contains a hyphen, the build could sign with it. Hosted runners are expected to hold none (UNVERIFIED). `CSC_IDENTITY_AUTO_DISCOVERY=false` does not change this while `identity` is `"-"`. The smoke test therefore asserts the result: `Signature=adhoc`, no Team ID, no authority. |
| Hardened runtime | Default on; with ad-hoc it makes library validation reject the bundled frameworks (warning in `MacTargetHelper.js:39`, `scheme.json`). The baseline sets `hardenedRuntime: false`. The default entitlements template (allow-jit, allow-unsigned-executable-memory, disable-library-validation) is left alone and is only relevant when hardened runtime comes back with real signing. |
| Notarization | `notarizeIfProvided` reads `APPLE_ID`, `APPLE_API_KEY...` and `APPLE_KEYCHAIN...` from the environment unless `notarize: false`. The config sets `false`; the workflow references no secrets. `gatekeeperAssess` defaults to `false` and is set explicitly. |
| `electronDist` | `package.json` sets `electronDist: node_modules/electron/dist`. For a directory that is not a zip and does not contain `electron-v<ver>-<platform>-<arch>.zip`, the builder copies `Electron.app` from it unchanged whatever `--arm64` / `--x64` says (`out/electron/ElectronFramework.js`, `unpack`). On a Mac that directory is the **host** Electron, so an x64 build on Apple silicon (or the reverse) would silently carry the wrong architecture. The Mac config has none; the builder downloads the matching zip (network needed, checksum verification by the builder UNVERIFIED). |
| Architecture and names | Arch comes from `--arm64` / `--x64`. App directories: `release-mac/mac` (x64) and `release-mac/mac-arm64`. The default artifact pattern drops the arch for x64, so `artifactName` is forced to `TRACE-Boardviewer-${version}-mac-${arch}.${ext}` (`platformPackager.expandArtifactNamePattern`, `isUserForced`). |
| Icon | `mac.icon: assets/icon.png`. The builder converts the 1024 x 1024 PNG to `.icns` itself (verified on Linux with its converter: valid 153 KB `.icns`), so no binary icon is committed and nothing is added under `assets/`. |
| Publish metadata | Without `publish: null` the builder derives a GitHub provider from the git remote and writes `resources/app-update.yml` with `owner: trace-boardviewer`, `repo: trace-boardviewer` into the app (observed in a Linux dir build). `publish: null` removes it (verified). The Windows config probably has the same exposure (UNVERIFIED for the Windows portable; see 6.5). |
| Cross-building from Linux | Not attempted and not useful: signing is skipped off macOS (no ad-hoc seal, which arm64 needs) and `dmg` needs `hdiutil`. A Linux build of the mac `zip` target might run (UNVERIFIED) but would not be a valid baseline. |

### 2.4 Native and optional modules (`@napi-rs/canvas`)

- Shipped runtime code (`electron/*.cjs`, `preload.cjs`) requires only `electron`, `fflate` and local files (`electron/documents.cjs:598` is the only non-builtin, non-relative require besides `electron`). `pdfjs-dist` is bundled by Vite into `dist/`.
- `@napi-rs/canvas` appears in `dist/assets/index-*.js` only inside pdf.js's Node canvas factory: `process.getBuiltinModule('module').createRequire(import.meta.url)('@napi-rs/canvas')`. The renderer is sandboxed (`sandbox: true`, `nodeIntegration: false`, `main.cjs:585-586`), so that path is unreachable, and main / preload never load pdf.js. Only Node-side QA scripts and tests use it.
- Reproduced with the builder on Linux (`--linux dir`, same `files` list): without a negation the host's prebuilt `skia.linux-x64-gnu.node` and the wrapper are bundled, and about 34 MB land in `app.asar.unpacked`; with `'!node_modules/@napi-rs/**'` the whole `@napi-rs` tree and `app.asar.unpacked` disappear. On a Mac the host-architecture binary would be bundled the same way (inferred, UNVERIFIED), and wrongly so for a cross-architecture build.
- Decision: the Mac config excludes it. The test fails if any `electron/*.cjs` ever requires something other than `electron`, `fflate`, `node:` modules or local files, so the exclusion cannot silently become wrong. No `asarUnpack` is needed (no native module, no bundled executable is spawned). The smoke test checks that `app.asar.unpacked` does not exist.

## 3. Unsigned app behaviour

What the artifact is: a zip holding `TRACE Boardviewer.app`, ad-hoc signed (`Signature=adhoc`, no Team ID), not notarized, no hardened runtime. Expected top-level zip entry: the `.app` (checked by the smoke script, UNVERIFIED until run).

What to expect (all UNVERIFIED; macOS versions differ):

- A copy without the quarantine attribute (built locally, or copied by `scp`, USB or a command-line download; browsers, AirDrop and Mail do set it) normally starts without a prompt.
- A quarantined copy that is not notarized is blocked by Gatekeeper on first open. The dialog wording and the way past it depend on the macOS version:
  - Older macOS: Control-click (or right-click) the app, choose Open, confirm.
  - macOS 15 and later: that shortcut is reported to be gone; try to open the app once, then System Settings > Privacy & Security > "Open Anyway".
  - Terminal alternative for a build whose SHA-256 you verified against the evidence file: `xattr -dr com.apple.quarantine "/path/TRACE Boardviewer.app"`.
- `spctl --assess -vv` is expected to reject the app; the smoke evidence records the answer as information, not as a failure.
- An invalid or missing signature on Apple silicon is the reason for the ad-hoc seal. A quarantined app with a broken seal may be reported as "damaged" instead of "unidentified developer".
- Every rebuild changes the ad-hoc signature identity; nothing in the app depends on it (no entitlements, no permissions requested).

The smoke test opens the local build output, which carries no quarantine attribute. It says nothing about the quarantined first-open path; that is item I of the checklist.

## 4. Native validation checklist

Run on the real hardware (or a hosted runner of the same architecture), once per architecture, on the exact commit. Evidence stays private: workflow artifacts in a private repository, 14-day retention, never attached to a release, issue or chat. Use only the synthetic fixtures below; never a private board, a user profile or a licensed sample.

| # | Step | Evidence to preserve |
| --- | --- | --- |
| A | Pre-flight: record full commit SHA, branch, workflow run id (if any), machine model and chip (`sysctl -n machdep.cpu.brand_string`), `uname -m`, `sw_vers`, `sysctl -n sysctl.proc_translated`, runner label and image version. | Evidence JSON `host` and `run` blocks, or a text file with the same values. For x64 on Apple silicon write "Rosetta, NOT native Intel validation" and stop counting it as Intel validation. |
| B | Artifact: SHA-256 of the zip (`shasum -a 256`), compare with the `.sha256` file and the evidence JSON; extract with `ditto -x -k`; record `lipo -info`, `file`, `codesign -dv --verbose=4`, `codesign --verify --deep --strict`, `spctl --assess -vv`, `plutil -extract LSMinimumSystemVersion raw ...`. | The three hashes, the command outputs, expected `architecture matches`, `Signature=adhoc`, `TeamIdentifier=not set`. |
| C | Launch and close with an isolated profile: `"<app>/Contents/MacOS/TRACE Boardviewer" --user-data-dir="$(mktemp -d)"`. Then: close with the custom X button (expect: window gone, process alive), click the Dock icon (expect: window returns), Dock > Quit. Try Cmd+Q, Cmd+H, Cmd+M, Cmd+W and record the actual result. | Screenshot of the first window, the process list before and after closing, the exit code of a Dock quit. Failing Cmd+Q / Cmd+H is expected until M-01 is fixed; record it. |
| D | Synthetic import and render: write the fixtures (`node -e "const s=require('./scripts/mac-smoke.cjs'),f=require('fs');f.writeFileSync('MacSmoke.cad',s.FIXTURE_BOARD);f.writeFileSync('macsmoke.pdf',s.makePdf());f.writeFileSync('macsmoke.png',s.makePng())"`), open `MacSmoke.cad` with the real Open dialog (not stubbed). Expect 2 components, 4 pins, 2 nets and a drawn board. | Screenshot of the rendered board with the status bar; the dialog screenshot (sheet or window, filters shown). |
| E | Documents and native dialogs: attach `macsmoke.pdf` and `macsmoke.png` with the real Attach dialog; open each; use Export workspace and its real Save dialog. | Screenshots of both viewers (PDF text and page drawn, image drawn) and of the Save dialog; the exported zip name. |
| F | Workspace save and restart: wait at least 3 seconds after attaching, quit normally, restart with the same `--user-data-dir` and no board argument. Expect the board back from the recents and both documents `ready`. | `<profile>/workspaces/<64-hex>.json` present, no `*.tmp` in `workspaces/` or `notes/`; screenshots before and after. |
| G | Finder paths (M-04, M-06): drag a board into the window; `open -a "<app>" MacSmoke.cad` with a window open and again after closing the window (expect the board to open; record if it waits for a Dock click); double-click in Finder (expected not to offer the app). | What happened in each case. |
| H | Text editing: Cmd+C / V / X / A / Z in the search field, the note editor and the PDF page box. | Result per shortcut (expected to fail until M-01 is fixed). |
| I | Gatekeeper path: download the artifact through a browser on a clean account (quarantine set), try to open it, then open it by the method of section 3. | macOS version, the exact dialog text, the steps that worked, `xattr` output. |
| J | Hygiene: note the default user-data location by running once without `--user-data-dir` on a dedicated test account only (M-08); list files created outside the profile (for example `~/Library/Saved Application State/hu.trace.boardviewer.savedState`, UNVERIFIED); delete the temporary profile and fixtures afterwards. | The paths, no file content. |
| K | Automated run: `node scripts/mac-smoke.cjs ...` (or the workflow) covers launch, runtime facts, one window, import and render, attach, PDF and PNG render, workspace manifest, normal quit with exit code 0, restart with the same profile, restore, simulated window-close and `activate`, second quit. | The evidence JSON: `passed: true`, `nativeValidation: true`, `classification`, `checks`, `notCovered`. |

Acceptance of a native run needs the matching architecture, `nativeValidation: true`, every automated check passed, and the manual items above recorded (a recorded failure is a valid result; a missing record is not). Even then it is a validated baseline of an unsigned build, not a release.

## 5. Blockers and gaps

1. No macOS runtime evidence exists. Everything above is static analysis, builder-source reading and Linux experiments.
2. Runner label, architecture and cost are UNVERIFIED. A single lookup of the docs.github.com runner reference (2026-10-05) reported `macos-latest` as arm64 (`macos-26-arm64`), `macos-14`, `macos-15`, `macos-26` as arm64 and `macos-15-intel`, `macos-26-intel` as Intel; it contained no billing multiplier. The workflow therefore takes the label as an input with the documented default `macos-latest`. To verify at dispatch: the label exists for this repository, its architecture, the minutes multiplier for private repositories, and that the runner reports the architecture you asked for (the smoke evidence will show a mismatch). Hosted macOS minutes are billed at a higher multiplier than Windows on private repositories. Check the current billing page before dispatching.
3. A GUI session on hosted runners is UNVERIFIED. If there is none, the launch step fails and the evidence says so.
4. The builder downloads Electron from GitHub at build time (network needed; its checksum verification is UNVERIFIED). `node_modules/electron/checksums.json` could be used for an explicit check later.
5. Icon: derived from `assets/icon.png`; a visual check on a Mac is outstanding.
6. Signing, hardened runtime, entitlements, notarization and a Developer ID are out of scope and need an Apple account and a human decision.
7. M-01, M-03 and M-04 need `electron/main.cjs` changes that are not applied (section 6).
8. Deferred: dmg and pkg, universal build, file associations, auto-update, a `package:mac` script.
9. `.gitignore` has `release/` but not `release-mac/` (patch 6.4); the smoke and workflow evidence go to `test-results/mac/`, which is already ignored.
10. Possible Windows follow-ups found on the way (not mine to change): the Windows build probably ships the host's `@napi-rs/canvas` binary and an `app-update.yml` with the repository name (6.5).

## 6. Proposed shared-code changes (NOT applied)

Each patch is a proposal with its rationale.

### 6.1 macOS application menu (M-01)

`electron/main.cjs`, inside `app.whenReady()`:

```diff
     await loadConfig();
-    Menu.setApplicationMenu(null);
+    // macOS needs an application menu: it carries Cmd+Q, Cmd+H, Cmd+M, Cmd+W and the Edit key equivalents.
+    // Windows and Linux keep no menu bar.
+    Menu.setApplicationMenu(process.platform === 'darwin'
+      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
+      : null);
     installIpc();
```

`tests/desktop-checks.cjs:106` (the mock has no `buildFromTemplate`, and the M01 case already runs `platform: 'darwin'`):

```diff
-    app, BrowserWindow: MockBrowserWindow, dialog, Menu: { setApplicationMenu() {} },
+    app, BrowserWindow: MockBrowserWindow, dialog, Menu: { setApplicationMenu() {}, buildFromTemplate: (template) => template },
```

Rationale: Cmd+Q and the Edit shortcuts are menu-routed on macOS. The roles exist in Electron 44 (`appMenu`, `editMenu`, `windowMenu`). Add a desktop-checks case asserting `null` off darwin and a template on darwin. Whether the three roles are enough (a File or View menu is not needed) is for the Mac validator to judge.

### 6.2 Do not create windows before startup finished (M-03)

```diff
 let quitting = false;
 let finalQuit = false;
+let windowsAllowed = false; // set once the startup chain created the first window
 let shutdown = null;
```
```diff
     installIpc();
     createWindow();
+    windowsAllowed = true;
   }).catch((error) => {
```
```diff
-  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
+  app.on('activate', () => { if (windowsAllowed && !quitting && BrowserWindow.getAllWindows().length === 0) createWindow(); });
```

Rationale: an early `activate` can neither throw before ready nor create a window before `installIpc()` / a second window beside the startup one. Also stops a window appearing during the quit drain.

### 6.3 `open-file` with no window (M-04)

```diff
   app.on('open-file', (event, filename) => {
     event.preventDefault();
     if (!app.isReady()) startupBoardPath = filename;
-    else void deliverBoard(filename);
+    else {
+      void deliverBoard(filename);
+      // The process stays alive without a window on macOS; the board waits in pendingBoardPath for the new renderer.
+      if (windowsAllowed && !quitting && BrowserWindow.getAllWindows().length === 0) createWindow();
+    }
   });
```

Depends on 6.2 (`windowsAllowed`). Known behaviour: a stale `startupBoardPath` from the original launch is read first by the new window and then replaced by the pending board. Needs a desktop-checks case ("open-file with zero windows creates one and delivers the board").

### 6.4 package.json scripts and .gitignore

```diff
     "package:dir": "pnpm run build && electron-builder --win dir --x64 --publish never"
+    "package:mac:arm64": "pnpm run build && electron-builder --mac zip --arm64 --config config/electron-builder.mac.yml --publish never",
+    "package:mac:x64": "pnpm run build && electron-builder --mac zip --x64 --config config/electron-builder.mac.yml --publish never"
```
```diff
-    "test:desktop": "node --test tests/desktop-checks.cjs tests/store-checks.cjs tests/workspace-checks.cjs tests/portable-config-checks.cjs",
+    "test:desktop": "node --test tests/desktop-checks.cjs tests/store-checks.cjs tests/workspace-checks.cjs tests/portable-config-checks.cjs tests/mac-config-checks.cjs",
```
```diff
 release/
+release-mac/
```

Rationale: `tests/mac-config-checks.cjs` is static and fast, and running it in the Windows gate catches drift of `appId`, `productName`, `asar` and `files` between `package.json` and the Mac config. Add a comma after the previous script entry when applying. The workflow already runs the test itself and does not depend on these scripts.

### 6.5 Windows build hygiene (optional, affects the Windows package)

```diff
   "build": {
     "appId": "hu.trace.boardviewer",
+    "publish": null,
```
```diff
       "LICENSE",
-      "THIRD_PARTY_NOTICES.md"
+      "THIRD_PARTY_NOTICES.md",
+      "!node_modules/@napi-rs/**"
     ],
```

Rationale: both effects were reproduced with the same builder version in a Linux dir build (section 2.3 and 2.4); on Windows they are inferred (UNVERIFIED): the host `@napi-rs/canvas` binary is bundled although nothing loads it, and `app-update.yml` names the private repository. The drift test accepts the negation in both files (`ALLOWED_NEGATIONS`); `publish: null` would need an equality assertion added to the test if it should be kept in sync.

## 7. Native results (2026-10-06, macOS 26.6.2, Apple M3, arm64, Electron 44.5.1)

First native run. This corrects the static findings above:

* **M-01 is refuted.** `Menu.setApplicationMenu(null)` is ignored on macOS: Electron's default menu (App, File, Edit, View, Window) stays, Cmd+Q, Cmd+W and Cmd+A/C/X/V/Z work. Patch 6.1 as written would drop Close Window (Cmd+W) and View. What the default menu does ship is View > Toggle Developer Tools / Reload, which Windows and Linux do not have.
* **M-04 is confirmed** (no window after `open -a` with the last window closed) and fixed; **M-03** could not be reproduced natively, its guard is kept because the M-04 fix needs the same flag. M-02 is true by sight (no traffic lights).
* The line numbers of `electron/main.cjs` quoted in section 2 are stale by about 71 lines.
* `tests/desktop-checks.cjs` `W-fin-lifecycle-01` fails on darwin (`electron/store.cjs:60` reads the real `process.platform`); every other suite in the Windows gate passes on macOS.
