# TRACE Boardviewer on Linux (experimental)

Linux builds are experimental. They are built and smoke-tested automatically on Ubuntu 24.04. They have not been tested on a desktop Linux machine yet, so expect rough edges and please tell us about them (see [Reporting a problem](#reporting-a-problem)). The short install steps are in the [README](../README.md#run-on-linux-experimental); this page has the details.

## Packages

Each release from 1.3.0 on carries two packages of the same x86-64 build, each with a `.sha256` file. Neither package is signed. Check the download before you run it:

```bash
sha256sum -c TRACE-Boardviewer-<version>-linux-amd64.deb.sha256
```

| File | For | What it does |
| --- | --- | --- |
| `TRACE-Boardviewer-<version>-linux-amd64.deb` | Ubuntu 24.04 or newer, Debian 12 or newer (recommended) | Installs to `/opt/TRACE Boardviewer`, adds an application menu entry and icons, and keeps Chromium's sandbox on (see [Sandbox](#sandbox)). |
| `TRACE-Boardviewer-<version>-linux-x86_64.AppImage` | Other distributions, or when you do not want to install anything | One portable file. Nothing is installed and no entry is added to your menu. |

Install the `.deb` with `sudo apt install ./TRACE-Boardviewer-<version>-linux-amd64.deb` (the `./` is needed, otherwise apt looks for a package of that name in its lists). Start TRACE Boardviewer from the application menu, or run `trace-boardviewer`. Remove it with `sudo apt remove trace-boardviewer`. Your settings and notes are in your home folder and stay.

Make the AppImage executable and run it:

```bash
chmod +x TRACE-Boardviewer-<version>-linux-x86_64.AppImage
./TRACE-Boardviewer-<version>-linux-x86_64.AppImage
```

The AppImage uses the static AppImage runtime, so it does not need `libfuse2`. It still needs a working FUSE mount, which desktop distributions provide (see [Troubleshooting](#troubleshooting) if yours does not).

To update, download the new package and install or replace it. The update check inside TRACE only shows a link to the release page; it never downloads or installs anything. Only x86-64 is built. An arm64 build may follow later.

## Sandbox

Chromium's sandbox keeps the processes that read board, PDF and image files apart from the rest of your system. On Linux it needs unprivileged user namespaces (or a setuid helper). Ubuntu 23.10 and newer, including 24.04, restrict unprivileged user namespaces with AppArmor, so a program needs an AppArmor profile that allows them.

- **The `.deb` keeps the sandbox on.** On systems with AppArmor 4, such as Ubuntu 24.04, it installs the profile `/etc/apparmor.d/trace-boardviewer`, which allows user namespaces (`userns,`) for TRACE only. On systems with an older AppArmor, such as Ubuntu 22.04 and Debian 12, the profile is not needed and is skipped. On systems that have no user namespaces at all, the package marks Chromium's setuid helper instead. Removing the package removes the profile.
- **An AppImage cannot carry such a profile.** It is a file in your home folder, mounted without setuid. Its launcher checks whether user namespaces work. If they do (Fedora, Debian, Arch and openSUSE by default), Chromium's sandbox works as usual. If they do not (Ubuntu 23.10 and newer), the launcher starts TRACE with `--no-sandbox`.
- **TRACE never turns the sandbox off by itself, and it asks first.** When it finds that it was started without the sandbox, it shows a warning before any window opens: "The Chromium sandbox is not available on this system." **Quit** is the default button (Esc does the same). **Start without sandbox** continues. The checkbox **Do not ask again** remembers your choice in a small file named `linux-no-sandbox-accepted` in the profile folder; delete that file to be asked again. A warning line is always written to the standard error output: `TRACE: running without the Chromium sandbox (--no-sandbox).`
- **Scripts.** Setting `TRACE_ACCEPT_NO_SANDBOX=1` in the environment skips the question for scripted use, such as automated tests. The warning line is still written. Do not set it in a launcher you use every day on a restricted system; use the `.deb` there instead.

Without the sandbox, a malicious board, PDF or image file that exploits a bug in the viewer has a better chance of reaching the rest of your system. On Ubuntu 23.10 and newer, install the `.deb` instead of using the AppImage. Ubuntu documents the system setting `kernel.apparmor_restrict_unprivileged_userns` that controls the restriction. We do not recommend switching the restriction off for the whole machine just to run an AppImage.

## Where data lives

| System | Settings, recent boards, workspaces and notes |
| --- | --- |
| Linux | `~/.config/trace-boardviewer` (`$XDG_CONFIG_HOME/trace-boardviewer`) |
| Windows | `%APPDATA%\TRACE Boardviewer` |

The Linux folder is fixed by TRACE, so a newer Electron version cannot move your notes. Both Linux packages use it. Board files are only read. TRACE writes nothing into the install folder or next to the AppImage; the AppImage's own contents are read-only.

To keep the data next to an AppImage, use the AppImage runtime's portable mode: create a folder named like the AppImage file plus `.config` beside it (for example `TRACE-Boardviewer-<version>-linux-x86_64.AppImage.config`). TRACE then keeps its data in a `trace-boardviewer` folder inside it. To keep existing data, copy the folder `~/.config/trace-boardviewer` there first. Rename the AppImage to a fixed name (for example `TRACE-Boardviewer.AppImage`) if you want the same folder to keep working after an update. This mode comes from the AppImage runtime and is not part of the automated checks below.

## Integration

- TRACE registers no file associations on Linux (as on Windows and macOS), because board extensions such as `.brd`, `.cad` and `.xml` are ambiguous. Use **Open** in the app, drag a file into the window, or pass the board's absolute path: `trace-boardviewer /path/to/Board.cad`. Addresses of the form `file://...`, which desktop launchers pass to a program, are understood as well.
- The `.deb` installs a desktop entry (`trace-boardviewer.desktop`, category Development and Electronics) and icons in the standard places.
- The AppImage adds nothing to your system. If you want a menu entry and an icon for it, use an AppImage integration tool. Without an installed desktop entry, GNOME under Wayland shows a generic icon for the window.
- The window has no menu bar and draws its own title bar and window buttons, as on Windows.

## What is tested

Every run of the release workflow includes the `linux` job on a GitHub Actions runner with Ubuntu 24.04 and a virtual X display (Xvfb, no window manager). The job builds both packages and then checks them:

- **Package contents.** The desktop entry and icons of the AppImage and the `.deb`, the executable and the `chrome-sandbox` helper, the package fields of the `.deb` (name, architecture, homepage), the bundled AppArmor profile, the Electron fuses in the executable, and the absence of update metadata. Every package is scanned for build-machine names and paths before it is uploaded.
- **Running the packaged app.** Launch, import of a board, attaching a PDF and an image (the native file chooser is replaced by a stand-in), rendering of both, saving and restoring the workspace after a restart, quitting cleanly, a second launch handing its board to the running instance (single instance), opening a support link in the browser (checked with a stand-in for `xdg-open`), the window class and icon under X11, and the default data location.
- **Sandbox state, measured.** For each run the job reads `/proc` for every renderer process: the sandbox counts as on only if the process has the seccomp filter active and sits in its own nested PID namespace.

| Scenario | User namespaces | Expected |
| --- | --- | --- |
| `.deb` installed | Restricted (Ubuntu 24.04 default) | Sandbox on, through the AppArmor profile |
| AppImage | Restricted | Sandbox off, warning written, started only because the consent was given through `TRACE_ACCEPT_NO_SANDBOX=1` |
| AppImage | Allowed | Sandbox on |
| Unpacked app | Allowed | Sandbox on |

The question TRACE asks before it starts without the sandbox is covered by the desktop shell's own unit tests, not by a click in the packaged app.

## Not tested

- Real desktop sessions: GNOME, KDE and others, and Wayland (the checks use X11 without a window manager).
- Distributions and releases other than Ubuntu 24.04, including Debian 12, Fedora, Arch and openSUSE.
- HiDPI screens and fractional scaling.
- The native GTK or portal file chooser, and drag and drop from a file manager.
- AppImage desktop integration tools, and the AppImage portable mode.
- Keyring prompts on a real desktop.
- Upgrading or removing the `.deb` (one install is covered).
- Resizing, maximizing and snapping of the frameless window.
- Performance.
- arm64.

## Troubleshooting

- **The AppImage does not start and mentions FUSE.** This AppImage does not need `libfuse2`, so `dlopen(): error loading libfuse.so.2` is not expected. If FUSE cannot be used at all (a container, or no `/dev/fuse`), extract and run it instead: `./TRACE-Boardviewer-<version>-linux-x86_64.AppImage --appimage-extract-and-run`.
- **A dialog says the Chromium sandbox is not available.** See [Sandbox](#sandbox). On Ubuntu 23.10 and newer, install the `.deb`.
- **`The SUID sandbox helper binary was found, but is not configured correctly`.** The program was started outside the AppImage launcher or the `.deb` (for example the `trace-boardviewer` file inside an extracted AppImage, or a copy of the unpacked app) on a system that restricts user namespaces. Start the AppImage itself or install the `.deb`.
- **Nothing happens when you click Download or a support link.** TRACE hands the address to `xdg-open`. Check that `xdg-open https://example.org` opens your browser.
- **The icon in the dock or task bar is missing or generic.** The icon comes from an installed desktop entry. The `.deb` installs one; for an AppImage use an AppImage integration tool.
- **Your settings look reset.** Close TRACE and look in `~/.config/trace-boardviewer`. A `config.json.bak-<timestamp>` file there is a copy kept when TRACE replaced a damaged settings file.

## Building the packages yourself

The AppImage and the `.deb` are built on Linux (the release workflow uses Ubuntu 24.04). You need Node.js 24 or newer and pnpm, with `pnpm` on `PATH` (electron-builder collects the dependency tree with it).

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm exec electron-builder --linux AppImage deb --x64 --config config/electron-builder.linux.yml --publish never
```

The packages and their `linux-unpacked` directory are written to `release-linux/`. Always name the targets and pass the config file: a bare `--linux` would also try to build a snap. The configuration is `config/electron-builder.linux.yml`, which `tests/linux-config-checks.cjs` checks against `package.json` and the pinned builder.

## Reporting a problem

Use the [bug report form](https://github.com/trace-boardviewer/trace-boardviewer/issues/new?template=bug_report.yml) or the Report a bug button in the app. Choose **Linux (.deb)**, **Linux (AppImage)** or **Linux (other)** as the operating system, and write your distribution and version, your desktop environment and whether you use X11 or Wayland in the description. If the sandbox dialog appeared, say so. Please do not attach proprietary or customer boardview files.
