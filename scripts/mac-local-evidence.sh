#!/usr/bin/env bash
# Collects host and binary facts for a macOS validation run into a directory of plain-text files.
# Read-only: it runs uname/sw_vers/sysctl/lipo/file/codesign/spctl/xattr/shasum and writes only into --out.
# It refuses to run anywhere but macOS (exit 2), so it can never produce "Mac" evidence on Linux/Windows.
#
#   bash scripts/mac-local-evidence.sh --app "release-mac/mac-arm64/TRACE Boardviewer.app" \
#        --zip release-mac/TRACE-Boardviewer-1.2.0-mac-arm64.zip --out test-results/mac/host-arm64
#
# Exit codes: 0 facts collected (individual commands may still have failed; see the files), 2 refused / bad arguments.
# Collects host and binary facts of a packaged macOS app. Not a test; it asserts nothing.
set -u

APP=""; ZIP=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="${2:-}"; shift 2 ;;
    --zip) ZIP="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "mac-local-evidence.sh refuses to run: this is not macOS ($(uname -s))." >&2
  exit 2
fi
if [ -z "$APP" ] || [ -z "$OUT" ]; then
  echo "usage: bash scripts/mac-local-evidence.sh --app <path-to.app> [--zip <zip>] --out <directory>" >&2
  exit 2
fi
if [ ! -d "$APP" ]; then
  echo "app bundle not found: $APP" >&2
  exit 2
fi

mkdir -p "$OUT" || { echo "cannot create $OUT" >&2; exit 2; }
BIN="$APP/Contents/MacOS/TRACE Boardviewer"

{
  echo "date_utc: $(date -u +%FT%TZ)"
  echo "commit: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "git_status_short: $(git status --short 2>/dev/null | wc -l | tr -d ' ') changed paths"
  echo "uname_m: $(uname -m)"
  echo "uname_a: $(uname -a)"
  echo "--- sw_vers"; sw_vers 2>&1
  echo "--- cpu"; sysctl -n machdep.cpu.brand_string 2>&1
  echo "--- hw.model"; sysctl -n hw.model 2>&1
  echo "--- sysctl.proc_translated (1 = running under Rosetta; NOT native Intel validation)"
  sysctl -n sysctl.proc_translated 2>&1 || echo "unavailable"
  echo "--- tool versions"
  echo "node: $(node --version 2>&1)"; echo "pnpm: $(pnpm --version 2>&1)"; echo "git: $(git --version 2>&1)"
  echo "xcode-select: $(xcode-select -p 2>&1)"
} > "$OUT/host.txt" 2>&1

{
  echo "--- file"; file "$BIN" 2>&1
  echo "--- lipo -info"; lipo -info "$BIN" 2>&1
  echo "--- Info.plist"
  plutil -p "$APP/Contents/Info.plist" 2>&1 | grep -E "CFBundleIdentifier|CFBundleShortVersionString|CFBundleExecutable|LSMinimumSystemVersion|NSHighResolutionCapable"
  echo "--- bundle size"; du -sh "$APP" 2>&1
} > "$OUT/binary.txt" 2>&1

{
  echo "--- codesign -dv --verbose=4"; codesign -dv --verbose=4 "$APP" 2>&1
  echo "--- codesign --verify --deep --strict --verbose=2"; codesign --verify --deep --strict --verbose=2 "$APP" 2>&1
  echo "exit: $?"
} > "$OUT/codesign.txt" 2>&1

{
  echo "--- spctl --assess -vv (an ad-hoc signed app is expected to be rejected; record the exact text)"
  spctl --assess -vv "$APP" 2>&1
  echo "exit: $?"
} > "$OUT/spctl.txt" 2>&1

{
  echo "--- xattr -lr (first 30 lines)"; xattr -lr "$APP" 2>&1 | head -30
  if [ -n "$ZIP" ] && [ -f "$ZIP" ]; then echo "--- xattr -l zip"; xattr -l "$ZIP" 2>&1; fi
} > "$OUT/xattr.txt" 2>&1

if [ -n "$ZIP" ] && [ -f "$ZIP" ]; then
  { shasum -a 256 "$ZIP"; ls -l "$ZIP"; } > "$OUT/zip.sha256.txt" 2>&1
fi

echo "wrote: $OUT/host.txt binary.txt codesign.txt spctl.txt xattr.txt$([ -n "$ZIP" ] && echo ' zip.sha256.txt')"
exit 0
