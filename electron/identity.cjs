'use strict';

// Identities used by the native process.
//
// 1. Board key (B32). A single file is identified by the plain SHA-256 of its bytes, which keeps
//    every note saved before companions existed. A board made of several files (the ASC trio) is
//    identified by the SHA-256 over the COMPLETE file set, primary included, ordered by lowercase
//    basename and encoded per entry as  utf8(name) 0x00 uint64be(byteLength) bytes . The key therefore
//    does not depend on which entry file the user picked, and changes when any file of the set changes.
//    src/lib/workspace.ts (boardIdentityKey) must produce the same hex for the same input.
//
// 2. Path identity (M01). Paths are compared case-insensitively only on platforms whose volumes
//    are: Windows. POSIX paths are never lowercased unconditionally, otherwise /Boards/U1.cad and
//    /Boards/u1.cad (two different files on a case-sensitive volume) collapse into one. macOS volumes
//    may be either: until a runtime probe result is passed in (`caseInsensitive`, see
//    probeCaseInsensitive; wired in phase 3 on a real Mac) darwin keeps paths exact, which can at worst
//    show one file twice and never merges two files.
//
// Text is English with a stable `code` (// i18n: pending): the catalogs are frozen.

const { createHash } = require('node:crypto');

const MAX_ENTRIES = 64;

function identityError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const toBytes = (data) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
// The lowercase basename of an entry, whichever separator the caller used.
const entryName = (name) => name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).toLowerCase();

function uint64be(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

/** `entries`: Array<{ name: string; data: Uint8Array }> holding the complete file set of one board. */
function boardKey(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) {
    throw identityError('A board identity needs between 1 and 64 files.', 'IDENTITY_INVALID_ENTRIES'); // i18n: pending
  }
  const normalized = entries.map((entry) => {
    if (!entry || typeof entry.name !== 'string' || !ArrayBuffer.isView(entry.data)) {
      throw identityError('Invalid board file entry.', 'IDENTITY_INVALID_ENTRIES'); // i18n: pending
    }
    const name = entryName(entry.name);
    if (!name) throw identityError('Invalid board file entry name.', 'IDENTITY_INVALID_ENTRIES'); // i18n: pending
    return { name, data: toBytes(entry.data) };
  });
  if (normalized.length === 1) return sha256Hex(normalized[0].data);
  normalized.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index].name === normalized[index - 1].name) throw identityError('Two board files share one name.', 'IDENTITY_DUPLICATE_NAME'); // i18n: pending
  }
  const hash = createHash('sha256');
  for (const { name, data } of normalized) {
    hash.update(name, 'utf8').update(Buffer.from([0])).update(uint64be(data.byteLength)).update(data);
  }
  return hash.digest('hex');
}

/** Whether paths of this platform compare case-insensitively when nothing better is known. */
function defaultCaseInsensitive(platform) { return platform === 'win32'; }

/** Comparable form of an already normalized absolute path (case folded only where the volume folds). */
function pathIdentity(filename, options = {}) {
  const platform = options.platform ?? process.platform;
  const fold = typeof options.caseInsensitive === 'boolean' ? options.caseInsensitive : defaultCaseInsensitive(platform);
  return fold ? filename.toLowerCase() : filename;
}

function samePath(a, b, options) { return pathIdentity(a, options) === pathIdentity(b, options); }

// Tells whether the volume holding `filename` folds case: true / false, or null when it cannot be
// decided (no letters in the name, or the probe failed). A case-swapped spelling that resolves to the
// same device and inode is the same file, so the volume is case-insensitive.
async function probeCaseInsensitive(filename, fs = require('node:fs/promises')) {
  const separator = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const base = filename.slice(separator + 1);
  const swapped = [...base].map((character) => (character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase())).join('');
  if (!base || swapped === base) return null;
  try {
    const original = await fs.stat(filename);
    try {
      const other = await fs.stat(filename.slice(0, separator + 1) + swapped);
      return original.dev === other.dev && original.ino === other.ino && original.ino !== 0;
    } catch (error) {
      return error && error.code === 'ENOENT' ? false : null;
    }
  } catch { return null; }
}

module.exports = Object.freeze({ boardKey, sha256Hex, entryName, pathIdentity, samePath, defaultCaseInsensitive, probeCaseInsensitive });
