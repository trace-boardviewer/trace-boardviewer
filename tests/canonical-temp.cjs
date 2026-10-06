'use strict';

// Temporary directories for the native test suites are created under the CANONICAL temp root.
// Production code resolves every file with fs.realpath() and keys its decisions on the canonical path,
// while several checks inject hooks keyed on the path the test itself wrote. On Windows runners
// os.tmpdir() is an 8.3 short path (C:\Users\RUNNER~1\...) whereas realpath() returns the long one
// (C:\Users\runneradmin\...), and a symlinked TMPDIR behaves the same on POSIX: a hook keyed on the
// non-canonical spelling never matches and the check silently tests nothing. Creating every fixture
// below realpath(tmpdir) makes the test paths identical to what the product resolves, so the production
// guarantees are exercised for real on every platform.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const canonicalTempRoot = () => fs.realpath(os.tmpdir());

// Creates a fresh directory under the canonical temp root and returns its canonical path.
async function makeTempDir(prefix) {
  const directory = await fs.mkdtemp(path.join(await canonicalTempRoot(), prefix));
  return fs.realpath(directory);
}

// Cleanup guard: only a path strictly inside the canonical temp root may be removed
// (case-insensitive where the platform's volume is).
async function isInsideTemp(candidate) {
  const root = await canonicalTempRoot();
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  return fold(path.resolve(candidate)).startsWith(`${fold(root)}${path.sep}`);
}

module.exports = Object.freeze({ canonicalTempRoot, makeTempDir, isInsideTemp });
