# Releasing TRACE

## Local Windows build

1. Update `package.json` and `CHANGELOG.md` for the release.
2. Install locked dependencies with `pnpm install --frozen-lockfile`, then run `pnpm setup:electron`.
3. Run `pnpm test` and `pnpm test:desktop`.
4. Run `pnpm package` on Windows x64.
5. Copy only `release/TRACE-Boardviewer-<version>.exe` into a separate directory. Launch that copied EXE with an isolated `--user-data-dir=<absolute-path>` and a local board, verify loading/search/net highlighting, then close it normally.
6. Verify the mirrored bottom side, geometry and note/settings restoration. Keep customer board files and QA outputs outside the source release.

The portable EXE already contains the runtime, renderer, preload, icons, fonts and license notices. `release/win-unpacked` is a packaging intermediate. The application does not need it after delivery.

Generate a checksum next to the final EXE:

```powershell
$traceVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
$traceExe = Join-Path release "TRACE-Boardviewer-$traceVersion.exe"
$traceHash = (Get-FileHash -LiteralPath $traceExe -Algorithm SHA256).Hash.ToLowerInvariant()
"$traceHash  $([IO.Path]::GetFileName($traceExe))" | Set-Content "$traceExe.sha256" -Encoding ascii
```

The Windows build is currently unsigned. Code signing can be added to the packaging configuration when a signing identity is available.

## GitHub workflow

The repository includes [`.github/workflows/windows.yml`](.github/workflows/windows.yml), the release workflow for all three platforms. It runs on pull requests, pushes to `main`, manual dispatches and `v*` tags. It can also be called from another workflow using `workflow_call` and exposes the built version and the Windows, macOS and Linux artifact names.

Every run installs locked dependencies, runs parser/geometry and desktop checks, builds the portable Windows EXE, generates its SHA256 file and uploads both as a workflow artifact. The `mac` job (skipped for pull requests: hosted macOS minutes are free for public repositories but billed, at a higher rate than Windows minutes, for private ones) builds the experimental unsigned macOS zip for Apple silicon on an arm64 runner, runs the packaged-app smoke test, scans every file of the bundle for private names and paths (one hit fails the job before anything is uploaded) and uploads the zip with its SHA256 file. The `linux` job (it runs for pull requests too) builds the experimental x86-64 .deb and AppImage on an Ubuntu 24.04 runner, runs the static packaging checks, the test suites and packaged smoke tests under a virtual X display (the .deb under Ubuntu's user-namespace restriction, where its AppArmor profile keeps Chromium's sandbox on; the AppImage under the same restriction, where it can only run without the sandbox after the user agrees in a dialog, which the smoke test answers; the AppImage and the unpacked app with user namespaces allowed), scans every package for private names and paths and uploads both packages with their SHA256 files. Its step summary has one row per scenario, and the `linux-smoke-evidence-<version>` artifact holds the evidence JSON of each one. These steps use synthetic tests and do not require a private board or a signing secret.

After a repository exists, pushing a release tag such as `v1.1.0` triggers a draft GitHub Release. The tag must exactly match `package.json`. The draft is created only when the Windows, macOS and Linux jobs all passed. The release job downloads the three build artifacts, checks the EXE, the zip, the AppImage and the .deb against their SHA256 files and attaches all eight files to the draft; the notes name every download, the macOS open instruction and the Linux install line. A version with a prerelease suffix (for example `1.3.0-rc.1`) is created as a prerelease, so the in-app update check, which only reads the latest stable release, never sees it; its notes start with a notice that it is a prerelease for testing, the file names keep the suffix and the version field of the `.deb` is written with a tilde (`1.3.0~rc.1`), which sorts before the final release. `tests/release-version-checks.cjs` runs the version steps of the workflow (validation, tag match, draft creation with a stand-in for `gh`) for a stable and a suffixed version. Review and smoke-test all artifacts before publishing the draft. Re-running a tag job does not replace an existing release; inspect the existing draft if creation fails.

The repository slug `trace-boardviewer/trace-boardviewer` is compiled into the app (`electron/repository.json`: the update check, the release page and the bug report link all use it). Renaming the organization or the repository breaks the update check of every shipped build, because the app refuses redirects by design, and frees the old name for anyone. Do not rename; if it is ever unavoidable, ship a release with the new slug first and keep the old name registered. Release tags are `v<major>.<minor>.<patch>` without leading zeros; the app treats a tag with a suffix (`v1.3.0-rc.1`) as a pre-release and never offers it.

Only the draft-release job receives `contents: write`; normal checks use `contents: read`. Checkout credentials are not persisted. Actions are pinned to verified upstream commits: [checkout](https://github.com/actions/checkout), [setup-node](https://github.com/actions/setup-node), [pnpm setup](https://github.com/pnpm/action-setup), [upload-artifact](https://github.com/actions/upload-artifact) and [download-artifact](https://github.com/actions/download-artifact). Draft creation uses the official [GitHub CLI release command](https://cli.github.com/manual/gh_release_create).

This project does not create a GitHub repository or publish itself. The local preparation can be reviewed before any repository creation or push. Commit source, documentation, lockfile, icons and license notices; distribute generated binaries through Releases.
