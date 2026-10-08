# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue: use the repository's
**Security, Report a vulnerability** form on GitHub. Say what you found, how to reproduce it and which version it affects.
Never attach proprietary or customer files; a description or a small file of your own is enough.

## What TRACE does and does not do

- Board, schematic and document files are read locally and are never uploaded; there is no account and no telemetry.
- The only network request of the app is an optional update check to `api.github.com` (one request when TRACE starts, switchable in
  Settings). It sends no data about you or your files, never downloads or runs anything, and only shows a link to the release page.
- Network requests are made by one module of the main process only (`electron/net/egress.cjs`): https, an exact host list per feature,
  no cookies, no redirects, size and time limits, a fixed User-Agent and language. The page itself cannot connect anywhere but to itself
  (Content-Security-Policy). Settings > Network lists the features and every request since TRACE started (time, feature, host, path
  without query, result); the list is kept in memory and can be cleared.
- The support notice, the heart (support) button and the bug report button ask the main process to open one of four fixed addresses
  in your browser (the two donation pages, the project's support page and the bug report form); the interface never passes an
  address of its own.
- Releases are built by GitHub Actions from a tagged commit and created as drafts; each release lists the SHA-256 of the file.
  The builds are not code-signed yet: verify the hash and expect the operating system to warn you once.
- On Linux the Chromium sandbox depends on the system: the .deb keeps it on with an AppArmor profile; an AppImage on Ubuntu 23.10 and
  newer can only run without it and asks before it starts that way. Electron does not offer its ASAR integrity check on Linux, so on
  Linux the checksum of the download (or the root-owned install folder of the .deb) is the integrity boundary.

## Supported versions

Only the newest release receives fixes.
