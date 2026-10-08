# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue: use the repository's
**Security, Report a vulnerability** form on GitHub. Say what you found, how to reproduce it and which version it affects.
Never attach proprietary or customer files; a description or a small file of your own is enough.

## What TRACE does and does not do

- Board, schematic and document files are read locally and are never uploaded; there is no account and no telemetry.
- An optional stable-update check contacts `api.github.com` once at start, switchable in Settings. It sends no board data, never
  downloads or runs an update, and only shows a release-page link.
- Optional support verification contacts `trace-support.trace-boardviewer.workers.dev` only after the user's explicit Verify
  payment action. It sends a random app-generated reference, never a name, email, amount, board, note or credential. Stripe and
  Ko-fi independently send authenticated payment notifications to that service; it retains the reference, verification times
  and a payment-ID hash without storing supporter identity. Signed local receipts suppress reminders and the heart for one
  calendar year and remain verifiable offline. Failed or skipped verification never restricts application features.
- Network requests are made by one module of the main process only (`electron/net/egress.cjs`): https, an exact host list per feature,
  no cookies, no redirects, size and time limits, a fixed User-Agent and language. The page itself cannot connect anywhere but to itself
  (Content-Security-Policy). Settings > Network lists the features and every request since TRACE started (time, feature, host, path
  without query, result); the list is kept in memory and can be cleared.
- Support and bug-report controls ask the main process to open fixed allowed destinations in your browser; the interface never
  supplies an arbitrary address. Stripe links can carry the app's random reference; Ko-fi uses a code the user may copy into the
  payment message. Every reminder, verification and encryption-key step can be skipped.
- Releases are built by GitHub Actions from a tagged commit and created as drafts; each release lists the SHA-256 of the file.
  The builds are not code-signed yet: verify the hash and expect the operating system to warn you once.
- On Linux the Chromium sandbox depends on the system: the .deb keeps it on with an AppArmor profile; an AppImage on Ubuntu 23.10 and
  newer can only run without it and asks before it starts that way. Electron does not offer its ASAR integrity check on Linux, so on
  Linux the checksum of the download (or the root-owned install folder of the .deb) is the integrity boundary.

## Supported versions

Only the newest release receives fixes.
