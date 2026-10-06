# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue: use the repository's
**Security, Report a vulnerability** form on GitHub. Say what you found, how to reproduce it and which version it affects.
Never attach proprietary or customer files; a description or a small file of your own is enough.

## What TRACE does and does not do

- Board, schematic and document files are read locally and are never uploaded; there is no account and no telemetry.
- The only network request of the app is an optional update check to `api.github.com` (one request when TRACE starts, switchable in
  Settings). It sends no data about you or your files, never downloads or runs anything, and only shows a link to the release page.
- The support and bug report buttons ask the main process to open one of three fixed addresses in your browser; the interface
  never passes an address of its own.
- Releases are built by GitHub Actions from a tagged commit and created as drafts; each release lists the SHA-256 of the file.
  The builds are not code-signed yet: verify the hash and expect the operating system to warn you once.

## Supported versions

Only the newest release receives fixes.
