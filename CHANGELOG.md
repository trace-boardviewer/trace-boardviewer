# Changelog

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
