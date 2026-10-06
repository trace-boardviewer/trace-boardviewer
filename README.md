<p align="center">
  <img src="assets/icon.png" width="96" height="96" alt="TRACE Boardviewer icon">
</p>

<h1 align="center">TRACE Boardviewer</h1>

<p align="center"><strong>Board, schematic and datasheet in one offline window.</strong><br>
A free boardviewer and repair workspace for electronics technicians.</p>

<p align="center">
  <a href="https://github.com/trace-boardviewer/trace-boardviewer/releases/latest"><img src="docs/readme/download-windows.svg" width="248" height="56" alt="Download for Windows"></a>
  <a href="https://github.com/trace-boardviewer/trace-boardviewer/releases/latest"><img src="docs/readme/download-apple-silicon.svg" width="248" height="56" alt="Download for macOS, experimental"></a>
  <a href="https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00"><img src="docs/readme/support.svg" width="248" height="56" alt="Support TRACE"></a>
</p>

<p align="center">Free and open source (MIT) · no account, no telemetry · 
<a href="https://ko-fi.com/tracerboardview">Ko-fi</a> · 
<a href="https://github.com/trace-boardviewer/trace-boardviewer/issues/new?template=bug_report.yml">Report a bug</a> · 
<a href="docs/SUPPORT.md">Supported formats</a></p>

<p align="center"><img src="docs/readme/hero.png" width="900" alt="TRACE Boardviewer showing a KiCad board with a highlighted net, its search results, and the connected parts"></p>

An offline boardviewer and repair workspace for Windows. Open a board (GenCAD plus several boardview, EDA and encrypted formats — see the [exact support table](docs/SUPPORT.md)), attach its schematics, PDF datasheets and reference images, search across all of them, cross-probe between board, schematic and documents, and keep local repair notes that survive a restart. The interface is available in eight languages; see [Languages](#languages). The support notice shown at start opens the Stripe or Ko-fi page in your browser only when you click one of its buttons, and Not now skips it.

At start TRACE can ask GitHub once whether a newer release exists (one request that carries nothing about you or your files) and, if there is one, shows a dismissible notice whose Download button opens the release page in your browser; TRACE itself never downloads or installs anything. This is the only network request TRACE makes, and Settings can turn it off.

**Found a bug?** Thank you for testing and for telling us. Use the Report a bug button in the top bar of the app (or in the support notice at start), or open the [bug report form](https://github.com/trace-boardviewer/trace-boardviewer/issues/new?template=bug_report.yml) directly. Please do not attach proprietary or customer boardview files.

## Run the portable app

Download `TRACE-Boardviewer-<version>.exe` from a published GitHub release, or build it with the instructions below. The EXE contains the complete application and its Electron runtime. Copying that one file is enough: no installer, Node.js, source folder or `win-unpacked` directory is required to run it.

Open a `.cad` or `.gcd` GENCAD file with **Open** (or the localized equivalent) or drag it into the window. TRACE restores the last available board at the next launch.

The portable launcher extracts its runtime (about 500 MB) into a private temporary folder of its own for every launch (`%TEMP%\nsXXXX.tmp\app`; while the instance runs that folder holds about 1.1 GB in total, because the launcher keeps the packed archive and a second extracted copy next to the runtime) and removes it on normal exit, so several running instances — and a second launch that hands a board to a running instance — never touch each other's runtime. If a launch is killed (for example with Task Manager) or crashes, its folder may stay behind in `%TEMP%`; delete it by hand once no TRACE process is running. A 0-byte `%TEMP%\trace-boardviewer-portable-init.lock` is shared by all launches (it serializes their start-up for a few milliseconds) and can stay; it is safe to delete when no TRACE launch is starting. Settings, recent files and notes are stored separately in `%APPDATA%\TRACE Boardviewer`. Notes are associated with the board file's content hash, so renaming the board keeps its notes. Board files are read without modification. No board data is uploaded; the app works offline.

Current release builds target Windows x64. A macOS build for Apple silicon is offered as an experimental download (`TRACE-Boardviewer-<version>-mac-arm64.zip`): it is unsigned (ad-hoc signed, not notarized), so macOS blocks a downloaded copy until you allow it once. Move `TRACE Boardviewer.app` to Applications, run `xattr -dr com.apple.quarantine "/Applications/TRACE Boardviewer.app"` in Terminal and open the app normally; this removes only the download quarantine flag of that copy (on macOS 15 and newer, System Settings > Privacy & Security > Open Anyway also works when it is offered). It was validated on an Apple M3; Intel Macs, a universal build and Linux are not packaged or tested (see [docs/MAC_VALIDATION.md](docs/MAC_VALIDATION.md)).

## Features

- Search by component reference, value, package and net name — across the board, structured schematics and the text of attached PDFs, with results grouped by source and page/sheet.
- **Technician workspace:** Board, Schematic and Documents tabs, a split view with an adjustable divider, and a compact status area. Attach PDFs, images and KiCad/EAGLE schematics to a board; they are remembered per board (by SHA-256, with a board-relative path) and restored after a restart. Moved files are found again, missing ones can be relinked, changed ones are never adopted silently.
- **Schematic cross-probe:** exact reference/pin matching between board and schematic with disagreements, unmatched and ambiguous parts listed explicitly (never guessed); hierarchical sheets, repeated sub-sheets and multi-unit parts keep their identity.
- **PDF viewer:** offline pdf.js rendering, text search, selectable text, bookmarks and page notes; board references found in the text link to board parts. Scanned PDFs are shown and marked as not searchable.
- **Images:** PNG/JPEG/WebP and sanitized SVG with zoom, rotation, bookmarks and notes; millimetre measurement only after an explicit two-point calibration.
- Notes per component or per pin with technician-entered voltage/resistance values; project export of only the documents you tick.
- Board view (zoom, position, rotation, side) is remembered per board; the **Link and aliases** panel lists reference/net differences between board and schematic and lets you confirm aliases explicitly.
- Component and pin inspection with a connected-component list and net highlighting.
- Top and mirrored bottom views, rotation, cursor-centred zoom, pan, board fit and selection fit.
- Two-point distance measurement in millimetres, with pin snapping.
- Per-component notes, recent boards and persistent appearance settings.
- Workshop and Focus layouts and dark/light/system themes.
- Interface in Hungarian, English, German, French, Italian, Slovak, Polish and Ukrainian, with instant switching (the technician-workspace features added in 1.2.0 are still English in every language; see [Languages](#languages)).
- Rendering optimizations for dense nets and large boards.

| Action | Shortcut |
| --- | --- |
| Open board | Ctrl + O |
| Search | Ctrl + F |
| Fit board | F |
| Rotate | R |
| Measure | M |
| Toggle labels | L |
| Component note | N |
| Zoom in / out | + / − |
| Workshop / Focus layout | Ctrl + 1 / 2 |
| Clear highlight / measurement | Esc |
| Board / Schematic / Documents tab | Alt + 1 / 2 / 3 |
| Split view on / off | Ctrl + \ |
| Keyboard shortcuts (help) | ? or F1 |

On macOS, Cmd replaces Ctrl and Option replaces Alt.

## Languages

| Language | Native name | Code |
| --- | --- | --- |
| Hungarian | Magyar | `hu` |
| English | English | `en` |
| German | Deutsch | `de` |
| French | Français | `fr` |
| Italian | Italiano | `it` |
| Slovak | Slovenčina | `sk` |
| Polish | Polski | `pl` |
| Ukrainian | Українська | `uk` |

- **Choosing the language.** A fresh profile follows the system language when it is one of the eight, otherwise English. A profile saved before language support existed keeps the Hungarian interface it was used with; its theme, layout, recent boards and notes are unchanged. Once you pick a language it is saved with the other settings and always wins.
- **Switching.** Choose **Settings → Language**, where each language is listed by its own name. The interface changes instantly; the open board, selection and notes are not reloaded.
- **What is translated.** The welcome screen, the board view and its tools, the component inspector (selection, pins and nets, connections), settings, board information, recent boards and the first part of the help dialog, the support and update notices, loading and error messages, the native file dialog and the importer's errors and warnings.
- **Not translated yet.** The technician-workspace features added in 1.2.0 are English in every language: the Board / Schematic / Documents tabs and the save status, the search field and its results, the Documents and Schematic views and the PDF, image and schematic viewers, the note, link-and-aliases, export and encryption-key dialogs, the schematic, documents, notes and bookmarks sections of the inspector, the last rows of the help dialog and the workspace messages.
- **What is never translated.** Board data: component references, values, packages, net names and file names. Your own notes stay exactly as you wrote them. Units stay `mm`, and keyboard shortcuts do not change. Numbers and dates follow the selected language's conventions.

Translations live in `electron/locales/`. See [CONTRIBUTING.md](CONTRIBUTING.md) to add or improve one.

## Supported data and limitations

**[docs/SUPPORT.md](docs/SUPPORT.md) is the exact, generated support table**: every recognized format with its variants, units, side rules, geometry (real or estimated), key and companion requirements, and what is not supported. Short version:

- **GenCAD 1.4** (`.cad`, `.gcd`), **KiCad PCB**, **EAGLE board XML** and **BVRAW_FORMAT_3** boardviews (as written by kicad-boardview) are validated with real files, and so are the KiCad and EAGLE schematic readers and the PDF and image viewers (open designs: KiCad 9 demo, SparkFun RedBoard, Antmicro Jetson Nano baseboard, Raspberry Pi Pico). See the table for what each validation covers and what it does not.
- Landrex/TestLink BRD, TOPTEST BRD2, Honhan BDV, BVR (other than BVRAW_FORMAT_3), the ASC trio, FZ/CAE (RC6 key), XZZ PCB (optional DES key), CAST CST, Samsung CAD and Altium PcbDoc are **draft**: adapters exist and are proven on original synthetic fixtures only. No vendor file was available, no key ships with TRACE, and encrypted files need a key the user supplies for the session.
- Mentor Neutral, Allegro BRD, Gerber, ODB++ and IPC-2581 are **recognized by their bytes and explained, not imported**; TVW is accepted by extension only.
- Schematics: KiCad `.kicad_sch` (6.0–9.0), KiCad legacy `.sch` (with its `-cache.lib`/`.lib`) and EAGLE `.sch`. Altium schematics are not read.
- A PDF is a document, not a boardview or a netlist. There is no OCR.
- Files are limited to 64 MiB; larger or pathological inputs are rejected with a precise error rather than guessed.

No customer or manufacturer board file is included in this repository or in the application. A `.cad` (or any) extension alone never identifies a format: TRACE detects formats by their bytes.

The importer preserves physical dimensions for pads whose shape the format states exactly. Other pad shapes are approximated by their bounds and reported in the board information panel; if pad dimensions are missing the view uses display markers and says so.

Connection guides show logical net relationships. They do not show actual copper traces. Schematic connectivity comes from the schematic file (KiCad: computed from wires, junctions, labels and power symbols; EAGLE: the nets the file declares), never from a PDF or an image.

## Develop and build

Use Node.js 24 or newer and the pnpm version declared in `package.json`.

```powershell
pnpm install --frozen-lockfile
pnpm setup:electron
pnpm dev:desktop
```

For a production renderer and native app:

```powershell
pnpm build
pnpm start
```

For a standalone portable Windows x64 release:

```powershell
pnpm package
```

The result is `release/TRACE-Boardviewer-<version>.exe`. The generated `release/win-unpacked` directory is a build intermediate and is not needed alongside the portable EXE. To create only the unpacked app for development, run `pnpm package:dir`. Packaging needs the `pnpm` executable on `PATH` (electron-builder collects the dependency tree with it; `corepack enable` provides it), and the wrapper patch in `patches/` is applied by `pnpm install`, so package only from a checkout installed that way.

Development and QA can use a separate data profile:

```powershell
pnpm dev:desktop --user-data-dir="$PWD\test-results\manual-profile"
```

The desktop shell uses a sandboxed renderer, context isolation and a restricted preload API; the packaged binaries carry Electron fuses that disable `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` and load the application only from the integrity-checked `app.asar`. Project layout:

- `src/`: React UI and the workspace shell (`src/app/`, `src/components/`), canvas and geometry, board adapters and the dispatcher (`src/lib/formats/`), schematic parsers, connectivity and cross-probe (`src/lib/schematic/`, `src/lib/crossprobe.ts`), the PDF layer (`src/lib/pdf/`), images, the workspace model and parser workers.
- `electron/`: desktop window, local file access, the queued atomic store, document/workspace validation, project export and the translation catalogs in `electron/locales/`.
- `docs/`: the [support table](docs/SUPPORT.md) (generated) and the macOS notes.
- `assets/`: original TRACE icons and third-party license notices.
- `tests/`: native-shell, store and workspace checks (plus an opt-in real-Electron smoke test: `TRACE_ELECTRON_SMOKE=1 xvfb-run -a node --test tests/electron-smoke.cjs`).
- `scripts/`: development helpers and optional UI/performance checks.

## Verify changes

The normal test suite uses synthetic data and needs no private board:

```powershell
pnpm test
pnpm test:desktop
pnpm build
```

The technician-workspace flow (open board → attach PDF/image/schematic → search → cross-probe → note → restart → relink) has a synthetic end-to-end check that drives the real built Electron app; it needs a production build and a display (on Linux: `xvfb-run -a`):

```bash
pnpm build
xvfb-run -a pnpm qa:e2e
```

`pnpm qa:workspace` runs the shell's browser checks against a mock workspace (start with `pnpm dev` in another terminal; see the script header for the Chromium note), and the viewers have their own `scripts/qa-pdf-viewer.cjs`, `qa-schematic-viewer.cjs` and `qa-image-viewer.cjs` harness checks.

For synthetic async and renderer interaction checks, install Playwright Chromium and run a Vite server in another terminal with `pnpm dev`. These checks need no external board:

```powershell
pnpm exec playwright install chromium
pnpm qa:races
pnpm qa:renderer
```

The localization checks use their own synthetic board and exercise all eight languages, Unicode notes, settings migration and language restoration. Browser mode uses the running Vite server; the native modes load the production build:

```powershell
pnpm qa:localization --browser
pnpm build
pnpm qa:localization --electron
pnpm package:dir
pnpm qa:localization --packaged
```

Packaged localization checks default to `release/win-unpacked/TRACE Boardviewer.exe`. To verify another build, set `TRACE_PACKAGED_EXE` to the absolute path of its unpacked application executable:

```powershell
$env:TRACE_PACKAGED_EXE = (Resolve-Path 'test-results\final-release\win-unpacked\TRACE Boardviewer.exe').Path
pnpm qa:localization --packaged
```

Real-board UI and performance checks are optional local tools. Supply your own board outside the repository with `TRACE_TEST_BOARD` or `--board=<absolute-path>`. The UI scenario expects `AC1`, `AC15`, `U1`, `VU13` and `AGND_AUD`; adapt the script if your board differs.

```powershell
$env:TRACE_TEST_BOARD = 'C:\boards\reference-board.cad'
pnpm qa:browser
pnpm qa:electron
pnpm package:dir
pnpm qa:packaged
```

The performance workload expects `AC1` on the bottom side with a `GND` pin, and `GND` pads on both sides. Keep the same board and browser for a before/after comparison:

```powershell
pnpm qa:performance --label=before
# Apply the renderer change, then run the same workload again.
pnpm qa:performance --label=after
```

`before` is the default label and writes `test-results/performance-before.json`. The `after` run reads that baseline, checks that board/net counts are preserved and checks zoom timing for regressions. For a separate diagnostic run, `pnpm qa:performance --label=diagnostic --profile-zoom` also saves a Chromium CPU profile of the top-side GND zoom workload. Callback timings, frame gaps and forced canvas readback timings are reported separately.

`TRACE_QA_URL` sets the Vite URL for browser, race, renderer, localization browser and performance checks. They default to the local server on port 5173 (`localhost`, or `127.0.0.1` for renderer checks). `TRACE_BROWSER_CHANNEL=msedge` uses an installed Edge browser. `TRACE_EXPECT_COUNTS` can specify expected `components,pins,nets` counts for real-board UI and performance checks. Normal QA uses the project's declared Playwright dependency; the renderer harness additionally accepts `TRACE_PLAYWRIGHT_PATH` as an advanced fallback for environments that require an alternate installed Playwright module. QA output and isolated profiles stay under the ignored `test-results/` directory.

## Share and contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) for code, translation and format contributions, and [RELEASING.md](RELEASING.md) for the Windows build and draft-release workflow. GitHub Actions tests and builds the application without any private board data. Release binaries belong in GitHub Releases rather than in Git history.

TRACE's original code and artwork use the [MIT license](LICENSE). Bundled dependencies and fonts retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
