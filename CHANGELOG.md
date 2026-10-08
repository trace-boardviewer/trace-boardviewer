# Changelog

## 1.3.1-rc.1 — 2026-10-08

This is a prerelease for testing. The app's update check continues to offer stable releases only. Windows x64, macOS Apple silicon and Linux x86-64 packages carry the same application features; macOS and Linux remain experimental.

### New

- Readers for IPC-2581 revisions B/C, HyperLynx, Fabmaster FATF, EasyEDA Standard/Pro PCB, IPC-D-356 and CSV/TSV pin lists, plus Altium SchDoc schematics. EasyEDA Pro and SchDoc have selected real-file checks; IPC-2581 and IPC-D-356 were validated with open tool-written exports. HyperLynx, Fabmaster, EasyEDA Standard and pin lists remain draft with synthetic fixtures only. [The support table](docs/SUPPORT.md) gives the status and limits of each reader.
- ODB++ product models from tgz, tar.gz, tar, tar.Z and ZIP archives, including a nested model archive. Components, pins, nets, pads, package bodies and the board profile are read. Validation used open tool-written exports; vendor-written models remain unverified.
- Open a single board and its companions directly from a ZIP, by Open, drag and drop or the command line. Extraction stays in memory. Multiple boards, encrypted or split archives, unsafe paths and damaged entries are refused. The generic ZIP container is draft, validated with synthetic fixtures.
- Offline English text recognition for scanned PDFs. Recognized words carry confidence marks and are searchable; only exact board references or net names with at least 60% confidence become links. Progress and Cancel are available, completed pages stay recognized for the session, and no OCR data is downloaded or uploaded.
- Import progress for GenCAD and KiCad, Cancel for every format, and a watchdog for readers that stop making progress.
- Settings > Network lists permitted features and hosts and shows a bounded, clearable request log without query values, response bodies, credentials or file contents.
- Unresolved notes remain visible in a list with Copy and Delete rather than disappearing when a reader no longer finds their target.
- A small support heart and optional reminders at startup and once per hour. They wait for imports and other dialogs and can be dismissed with Not now, Escape or a click outside. A provider-confirmed Stripe or Ko-fi payment hides both for one calendar year, including offline use. Verification is optional; it sends only a random support code to the receipt service. Key entry also has an explicit Skip button.
- Local format diagnostic reports from Help, with counts, sizes, detection and structural facts. File names, content, coordinates and keys are excluded. Optional structural detail and a local repeat-detection code are off by default. The user reviews and saves or copies the report; nothing is uploaded automatically. A separate format-request issue form accepts this report.

### Improved and fixed

- FZ/CAE open automatically with published default format keys. Session-only overrides remain available for other variants. Container framing, declared sizes and both checksums are validated, and diagnostics use the same rules as import. Outlines are unavailable and physical pad dimensions remain unverified.
- Selected Honhan BDV exports now accept shortened headers, UTF-16 text, radius columns, wrapped/blank/comma-separated probe lists and spaced net names. Nonzero outline radii are disclosed as straight segments.
- Selected Landrex/TestLink BRD exports accept extra signed header fields and test points without nets. Samsung CAD includes N_VIA test points under their net and correct side. These checks establish the selected export families, not every dialect.
- TVW reads full component tables, physical pad positions and pin UID links, including test points, reordered pins and selected metadata variants. Layer types determine sides. Unsupported layer/header layouts fail explicitly; outlines and copper traces are absent and custom pads use bounding boxes.
- Notes use component reference and pin number instead of reader output order. Existing notes convert once and retain a backup. Ambiguous or unnamed targets are disclosed; indistinguishable targets cannot receive a misleading note.
- Shared part classification makes the canvas, inspector, search and icons agree. IC/PMIC, connectors, test points, resistor arrays, oscillators, ferrite beads, LEDs, switches, jumpers and mechanical parts receive consistent labels.
- One shared board index reduces repeated lookup work. Search and schematic comparison run in a background worker with a fallback if that worker stops; stale results never replace a newer query.
- Readers detect content by certainty rather than registration order. Equally certain matches fail with both format names in all eight languages. Open-dialog filters include all registered extensions.
- The support table distinguishes files written by open tools from vendor-written files; BVRAW_FORMAT_3, IPC-2581, IPC-D-356 and ODB++ disclose that validation scope.
- KiCad copper layers are read by number and type, so renamed KiCad 5 layers open. Selected KiCad 9 teardrop records with a missing opening parenthesis are recovered with a counted note.
- Altium PcbDoc ignores and reports unsupported non-copper/inner-layer objects instead of rejecting an otherwise readable board. Hole-only pads retain their drill size; multiline ASCII text and selected record layouts open.
- Fit sheet uses the schematic paper frame and handles outlying notes without shrinking the page unnecessarily.
- The inspector retains a selected part's schematic counterpart after Show in schematic or schematic selection.
- Unnumbered BVR pads receive distinct synthetic numbers and cannot collide with numbered pads.
- More ground aliases, case variants and hierarchy-qualified names are recognized.
- Crafted GenCAD and KiCad/EAGLE schematic inputs no longer trigger excessive outline or connectivity work. Non-finite/out-of-range schematic geometry fails explicitly, duplicate EAGLE symbol pin names produce a warning, and quoted error text stays bounded.
- All main-process network requests pass through one audited HTTPS allow-list with size/time limits, no redirects, cookies or credentials, and feature-specific opt-in controls.
- The Windows download omits an unused native canvas component and update metadata. The AppImage documentation reflects its static runtime, which needs no libfuse2.

### Developer foundations

- Shared board scenes and ordered rendering layers preserve selection, measurement and camera behavior. Seeded synthetic benchmarks, load-aware reports, fuzz/property tests and bounded diagnostics exercise large and malformed inputs.
- Shared value parsing, net classification, board fingerprints and a net graph support future tools. Photo/thermal registration, probe ranking, rail/tree/fan/shared-path analysis, short-suspect ranking and drop-location modules are foundations; their interfaces are not exposed in this release.
- Local readings contracts, storage, JSON/CSV packs, comparison, reference capture, meter decoders, a simulated meter and licensed OpenBoardData import are present as foundations. The dedicated readings interface is not exposed.
- Library contracts, bounded sniffing, knowledge rules and synthetic generators are present; the Library browser and device catalogue are not exposed.
- Eight translation catalogs use feature namespaces with key/placeholder/plural parity and a lint gate for new untranslated interface text. Existing untranslated workspace text remains documented.
- The release workflow validates suffixed versions on every platform and creates prerelease drafts with an explicit testing notice.

### Limits

- Packages are unsigned. macOS is Apple silicon only; Linux is x86-64 and is smoke-tested automatically on Ubuntu 24.04. The current release's native macOS/Linux evidence comes from CI.
- Files are limited to 64 MiB. Generic ZIPs allow one board, 4,096 entries and 64 MiB of selected unpacked board/companion data, with expansion and CRC checks.
- ODB++ does not draw copper, drills, mask or silkscreen; complex pad shapes use bounding rectangles.
- OCR is English only, with a 40-megapixel and two-minute limit per page.
- XZZ requires a user-supplied session key and is not claimed as supported. Other encrypted variants without usable key material may remain unreadable, while the app stays usable and key entry can be skipped.
- Existing support payments without the application-generated code require a separate verified recovery process. Deleting the local receipt loses local suppression; no supporter identity is stored in the application.

## 1.3.0

- **Linux (experimental):** a .deb and an AppImage for x86-64, built and smoke-tested automatically on Ubuntu 24.04 and attached to the release with their SHA256 files. They are unsigned and have not been tried on a desktop Linux machine yet; other distributions, desktop environments, Wayland sessions and arm64 are not tested. The .deb installs an AppArmor profile so that Chromium's sandbox stays on under Ubuntu's user-namespace restriction. The AppImage uses the static AppImage runtime, so it needs no libfuse2. See `docs/LINUX.md`.
- **Linux sandbox consent:** an AppImage that the system forces to run without the Chromium sandbox (Ubuntu 23.10 and newer restrict user namespaces) asks before it opens a window. Quit is the default, and "Do not ask again" remembers a yes. Use the .deb on Ubuntu.
- **Desktop shell on Linux:** the window icon comes from the PNG, settings, recent boards and notes live in `~/.config/trace-boardviewer` (`$XDG_CONFIG_HOME/trace-boardviewer`), and `file://` arguments from desktop launchers open the board.
- **Documentation:** the README has a Linux section and download button, `SECURITY.md` explains the Linux sandbox, and the bug report form offers Linux (.deb), Linux (AppImage) and Linux (other). The README's `app.asar` sentence now says that the integrity check is available on Windows and macOS only: Electron does not offer it on Linux.
- **Security hardening:** file readers and search no longer slow down on crafted input. Long runs of digits, blanks, NULs or repeated markup in a board, schematic, PDF or typed value used to make some patterns take seconds; they are now read in linear time with the same results. Dependency advisories are fixed, and a test-only library is no longer shipped inside the app.

## 1.2.0

- **Boardview formats:** a byte-based dispatcher with adapters for Landrex/TestLink BRD, TOPTEST BRD2, Honhan BDV, BVR (including BVRAW_FORMAT_3 as written by kicad-boardview), the ASC trio, FZ/CAE and XZZ (both with your own key), CAST CST, KiCad PCB, EAGLE board XML, Samsung CAD (draft) and Altium PcbDoc (draft), plus explained recognition of unsupported families. `docs/SUPPORT.md` lists what is validated with real files and what is not.
- **Validated with real open designs:** KiCad PCB, EAGLE board XML, the KiCad and EAGLE schematic readers and BVRAW_FORMAT_3 were checked against the KiCad 9 demo, the SparkFun RedBoard, the Antmicro Jetson Nano baseboard and Raspberry Pi Pico boards. A 28 MB KiCad board now opens, outline corners that are almost equal close the contour, pads without a number no longer collide with real pad numbers, power flags and `{slash}` names no longer merge nets, and sheet-qualified and automatic KiCad net names cross-probe between board and schematic.
- **Technician workspace:** Board, Schematic and Documents tabs, split view, unified search, an offline PDF viewer, an image viewer with explicit calibration, structured KiCad and EAGLE schematics with connectivity and board cross-probe, per-board workspaces that survive a restart, pin notes with measurements, and export of selected files.
- **Reliability:** queued atomic storage that drains pending writes at quit; per-board view (camera and side) persistence; a newer file-open request supersedes older loading work; the board canvas repaints after a lost GPU context; document views keep their fit mode across remounts and restarts; a rejected PDF shows an error instead of a Ready chip; layouts stay usable down to 960×640.
- **Support notice:** a short, skippable notice ("TRACE is free and stays free") appears once on every start. Not now has the initial focus, so Enter, Esc or a click outside skips it; there is no "don't show again". Two buttons open the Stripe and Ko-fi pages and a third opens the bug report form. The interface sends only an id to the main process, which holds the three fixed addresses. Copy in all eight languages.
- **Bug reports:** a Report a bug button in the top bar and in the support notice opens the GitHub bug report form in your browser. The repository has an issue form that asks you not to attach proprietary files.
- **Update notification:** at start TRACE can ask the GitHub releases API once whether a newer stable release exists and, if so, shows a small dismissible strip with a Download button that opens the release page. TRACE never downloads, unpacks or runs anything. The request is made by the main process only: one HTTPS GET to a fixed address, no cookies or credentials, no referrer, no redirect followed, fixed headers (the system language is not sent), 8 s timeout, at most 256 KiB read. The switch is in Settings ("Check for updates when TRACE starts", on by default) next to a Check now button. This is the only network request TRACE makes.
- **Windows portable build:** every launch extracts into its own temporary folder, so closing or starting one instance no longer removes another running instance's runtime; two launches within a few milliseconds no longer share the wrapper's plug-in folder; the wrapper retries the removal of its extraction folder while a child process still holds a file. A launch that is killed or crashes can leave its folder in `%TEMP%`.
- **macOS (experimental):** an unsigned, ad-hoc signed build from the manual macOS workflow, with a smoke script and static checks. It is not notarized: a downloaded copy needs the Gatekeeper override (right-click, Open, or `xattr -dr com.apple.quarantine`).
- **Security:** `CODEOWNERS` for the sensitive paths, importable repository rulesets, and `SECURITY.md`.

## 1.1.0

- Interface localization in Hungarian, English, German, French, Italian, Slovak, Polish and Ukrainian, with an instant language switch in Settings.
- A fresh profile follows the system language; profiles saved before this release keep their Hungarian interface, settings, recent boards and notes. One damaged stored setting no longer resets the other valid settings.
- Importer errors and warnings, native file dialogs and messages, numbers and dates follow the selected language. Board data, net names, notes and `mm` units are never translated.
- Translation catalogs in `electron/locales/` shared by the interface and the desktop shell, with automated checks for key, placeholder, plural and native/web consistency.
- Long translated measurement instructions stay clear of board-side controls in small windows, with room for translated pin-table headings.
- Faster interaction on dense nets through reduced redraw work and geometry processing.
- A complete portable Windows x64 application in one EXE.
- Recent boards are saved only after successful parsing. Startup restoration skips invalid legacy recent files and tries the remaining entries.
- A newer file-open request supersedes older loading work, preventing stale board payloads and error dialogs from replacing the current board. Cancelling a newer file chooser also suppresses an older pending delivery.
- Closing during startup no longer shows a misleading interface-loading error.
- Public development documentation, MIT license, bundled dependency notices and Windows build/draft-release automation.
- Portable QA configuration without developer-specific paths or a bundled private board.

## 1.0.0

- Initial GENCAD 1.4 desktop viewer with component and pin search, net highlighting, top/bottom views, pan, zoom and rotation.
- Workshop and Focus layouts, dark/light/system themes, distance measurement and local component notes.
- Local recent-board restoration and isolated native file/persistence APIs.
