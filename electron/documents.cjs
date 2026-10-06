'use strict';

// Native document reading for the technician workspace: PDF datasheets, reference images and
// structured schematics attached to a board. Every read follows the main.cjs board contract:
// absolute local path only, realpath, extension allow-list per kind, content sniffing (the
// extension alone is never trusted), size bound, growth-safe bounded read, SHA-256 of the
// original bytes. Companion files (ASC-style multi-file boards) are gathered only from the
// directory of the selected file and may not escape it through links.
//
// On top of single reads this module also provides the multi-document selection (bounded count and
// bytes, bounded schematic companions), re-finding remembered documents (locateDocuments: absolute
// path, then path relative to the board directory, verified by SHA-256) and the workspace export bundle
// (a zip with ONLY what the user selected, atomic write, zip-slip-safe names).
//
// User-visible texts go through the injected translator t(key, params) where a catalog key fits;
// the remaining English texts are marked `// i18n: pending`. Errors carry a stable `code`.

const defaultFs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { localAbsolutePath, readBounded, renameWithRetry } = require('./store.cjs');
const ids = require('./identity.cjs');
const formats = require('./formats.cjs');
const { xmlRoot } = require('./xml-prolog.mjs');

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 200;
const MAX_SELECTION_FILES = 16;
const MAX_SELECTION_BYTES = 256 * 1024 * 1024;
const COMPANION_FILES = 32;
const MAX_LOCATE_REQUESTS = 200;
const LOCATE_CONCURRENCY = 4;
const HASH_CHUNK_BYTES = 1024 * 1024;
const DEFLATE_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_SKIPPED = 64;
const KEY_PATTERN = /^[a-f0-9]{64}$/;
const MAX_EXTENSIONS = 32;
const SNIFF_WINDOW = 4096;
const PDF_HEADER_WINDOW = 1024; // The PDF specification allows the header within the first 1024 bytes.
const identity = (key) => key;

const KINDS = Object.freeze({
  pdf: Object.freeze({ label: 'PDF documents', extensions: Object.freeze(['.pdf']) }), // i18n: pending
  image: Object.freeze({ label: 'Images', extensions: Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.svg']) }), // i18n: pending
  schematic: Object.freeze({ label: 'Schematics', extensions: Object.freeze(['.kicad_sch', '.sch', '.lib']) }), // i18n: pending
});
const KIND_NAMES = Object.freeze(Object.keys(KINDS));
// Content formats each extension may carry; the first entry's kind is the extension's kind.
const EXTENSION_CONTENT = Object.freeze({
  '.pdf': ['pdf'], '.png': ['png'], '.jpg': ['jpeg'], '.jpeg': ['jpeg'], '.webp': ['webp'], '.svg': ['svg'],
  '.kicad_sch': ['kicad_sch'], '.sch': ['eeschema', 'eagle', 'kicad_sch'], '.lib': ['eeschema-lib'],
});
const CONTENT = Object.freeze({
  pdf: { kind: 'pdf', label: 'PDF' }, png: { kind: 'image', label: 'PNG image' }, jpeg: { kind: 'image', label: 'JPEG image' },
  webp: { kind: 'image', label: 'WebP image' }, svg: { kind: 'image', label: 'SVG image' },
  kicad_sch: { kind: 'schematic', label: 'KiCad schematic' }, eeschema: { kind: 'schematic', label: 'KiCad legacy schematic' },
  eagle: { kind: 'schematic', label: 'EAGLE XML' }, 'eeschema-lib': { kind: 'schematic', label: 'KiCad legacy symbol library' },
}); // i18n: pending (labels appear in mismatch diagnostics only)

function documentError(message, code, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

// Maps file-system and store errors to document errors; document errors pass through.
function mapError(error, t) {
  const code = error && error.code;
  if (typeof code === 'string' && code.startsWith('DOCUMENT_')) return error;
  if (code === 'STORE_INVALID_PATH') return documentError(error.message, 'DOCUMENT_INVALID_PATH');
  if (code === 'STORE_TOO_LARGE') return documentError(error.message, 'DOCUMENT_TOO_LARGE');
  if (code === 'STORE_CHANGED') return documentError(error.message, 'DOCUMENT_CHANGED');
  if (code === 'ENOENT') return documentError('The document file was not found. It may have been moved or deleted.', 'DOCUMENT_NOT_FOUND', error); // i18n: pending
  if (code === 'EACCES' || code === 'EPERM') return documentError('The document file cannot be read. Check the access permissions.', 'DOCUMENT_NOT_READABLE', error); // i18n: pending
  if (code) return documentError('The document file could not be read.', 'DOCUMENT_READ_FAILED', error); // i18n: pending
  return error;
}

function normalizeKinds(value) {
  const list = value === undefined ? KIND_NAMES : typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.length === 0 || list.some((kind) => !Object.hasOwn(KINDS, kind))) {
    throw documentError('Unknown document kind.', 'DOCUMENT_INVALID_KIND'); // i18n: pending
  }
  return KIND_NAMES.filter((kind) => list.includes(kind));
}

function normalizeExtensions(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXTENSIONS) {
    throw documentError('Companion extensions must be a non-empty list.', 'DOCUMENT_INVALID_EXTENSION'); // i18n: pending
  }
  const wanted = new Set();
  for (const item of value) {
    const extension = typeof item === 'string' ? `.${item.replace(/^\./, '').toLowerCase()}` : '';
    if (!/^\.[a-z0-9_]{1,32}$/.test(extension)) throw documentError('Invalid companion extension.', 'DOCUMENT_INVALID_EXTENSION'); // i18n: pending
    wanted.add(extension);
  }
  return wanted;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw documentError(`${name} must be a positive integer.`, 'DOCUMENT_INVALID_OPTIONS'); // i18n: pending
  return value;
}

// Platform aware (M01): case-insensitive only where the platform's volumes are (see identity.cjs).
const samePath = (a, b, platform) => ids.samePath(a, b, { platform });
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
// A plain Uint8Array over the read buffer's own ArrayBuffer (never the Buffer pool), safe to clone to the renderer.
const plainBytes = (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

// { format, unsafe }: the detected content format (or null), and whether an XML file was refused for
// declaring entities (B34; the root element comes from the prolog scanner the renderer sniffers share,
// electron/xml-prolog.mjs, so both sides reach the same verdict). Binary signatures first, then the text
// formats (which never contain NUL bytes) within the first 4 KiB.
function inspectContent(data) {
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, SNIFF_WINDOW));
  const found = (format) => ({ format, unsafe: false });
  if (head.byteLength >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) return found('png');
  if (head.byteLength >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return found('jpeg');
  if (head.byteLength >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return found('webp');
  const pdfAt = head.indexOf('%PDF-', 0, 'latin1');
  if (pdfAt >= 0 && pdfAt < PDF_HEADER_WINDOW) return found('pdf');
  if (head.includes(0)) return found(null);
  const text = head.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (text.startsWith('(kicad_sch')) return found('kicad_sch');
  if (text.startsWith('EESchema Schematic File')) return found('eeschema');
  if (text.startsWith('EESchema-LIBRARY')) return found('eeschema-lib');
  if (text.startsWith('<')) {
    const xml = xmlRoot(text);
    if (xml && xml.unsafe) return { format: null, unsafe: true };
    if (xml && xml.root === 'svg') return found('svg');
    if (xml && xml.root === 'eagle') return found('eagle');
  }
  return found(null);
}

// Returns the detected content format or null.
function sniffContent(data) { return inspectContent(data).format; }

// Reads one document: { name, path, kind, format, data: Uint8Array, key: sha256 hex, size }.
async function readDocument(filename, options = {}) {
  const { t = identity, fs = defaultFs } = options;
  const allowed = normalizeKinds(options.kinds);
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  let handle;
  let release = null;
  try {
    const requested = localAbsolutePath(filename, t);
    const canonical = localAbsolutePath(await fs.realpath(requested), t);
    const extension = path.extname(canonical).toLowerCase();
    const accepted = EXTENSION_CONTENT[extension];
    const kind = accepted ? CONTENT[accepted[0]].kind : null;
    if (!kind || !allowed.includes(kind)) {
      const list = allowed.flatMap((name) => KINDS[name].extensions).join(', ');
      throw documentError(`Unsupported document type "${extension || path.basename(canonical)}". Allowed: ${list}.`, 'DOCUMENT_UNSUPPORTED_EXTENSION'); // i18n: pending
    }
    handle = await fs.open(canonical, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw documentError(t('native.error.notAFile'), 'DOCUMENT_NOT_A_FILE');
    if (stat.size > maxBytes) throw documentError(t('native.error.fileLimitExceeded'), 'DOCUMENT_TOO_LARGE');
    if (stat.size === 0) throw documentError('The document file is empty.', 'DOCUMENT_EMPTY'); // i18n: pending
    if (options.budget) release = await options.budget.acquire(stat.size); // Aggregate bound on concurrent reads.
    const buffer = await readBounded(handle, stat.size, maxBytes, t);
    const { format, unsafe } = inspectContent(buffer);
    if (unsafe) throw documentError('The XML document declares entities in its DOCTYPE and was rejected for safety.', 'DOCUMENT_UNSAFE_XML'); // i18n: pending
    if (!format || !accepted.includes(format)) {
      const detected = format ? CONTENT[format].label : 'unrecognized data';
      throw documentError(`The file extension "${extension}" does not match the file content (${detected}).`, 'DOCUMENT_CONTENT_MISMATCH'); // i18n: pending
    }
    return { name: path.basename(canonical), path: canonical, kind, format, data: plainBytes(buffer), key: sha256(buffer), size: buffer.byteLength };
  } catch (error) {
    throw mapError(error, t);
  } finally {
    if (handle) await handle.close();
    if (release) release();
  }
}

// Gathers sibling files of the selected file by extension (case-insensitive), bounded by count
// and total bytes, each required to resolve inside the selected file's directory.
// Returns { directory, files: Record<lowercase basename, Uint8Array>, skipped: { name, reason }[] }.
async function gatherCompanions(filename, options = {}) {
  const { t = identity, fs = defaultFs } = options;
  const wanted = normalizeExtensions(options.extensions);
  const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES, 'maxFiles');
  const maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_BYTES, 'maxTotalBytes');
  const maxBytes = positiveInteger(options.maxBytes, maxTotalBytes, 'maxBytes');
  const { platform } = options;
  let canonical, entries;
  try {
    canonical = localAbsolutePath(await fs.realpath(localAbsolutePath(filename, t)), t);
    entries = await fs.readdir(path.dirname(canonical), { withFileTypes: true });
  } catch (error) {
    throw mapError(error, t);
  }
  const directory = path.dirname(canonical);
  const files = {};
  const skipped = [];
  let total = 0;
  let count = 0;
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (!wanted.has(path.extname(lower))) continue;
    // A crowded directory must not turn into unbounded work: stop listing once enough reasons are known.
    if (skipped.length >= MAX_SKIPPED) { skipped.push({ name: '…', reason: 'more files were skipped' }); break; } // i18n: pending
    if (entry.isDirectory()) { skipped.push({ name: entry.name, reason: 'not a file' }); continue; } // i18n: pending (all reasons)
    if (Object.hasOwn(files, lower)) { skipped.push({ name: entry.name, reason: 'duplicate name' }); continue; }
    let handle;
    let release = null;
    try {
      const real = localAbsolutePath(await fs.realpath(path.join(directory, entry.name)), t);
      if (samePath(real, canonical, platform)) continue; // The selected file is not its own companion.
      if (!samePath(path.dirname(real), directory, platform)) { skipped.push({ name: entry.name, reason: 'outside the selected directory' }); continue; }
      if (count >= maxFiles) { skipped.push({ name: entry.name, reason: 'file limit reached' }); continue; }
      handle = await fs.open(real, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) { skipped.push({ name: entry.name, reason: 'not a file' }); continue; }
      const budget = Math.min(maxBytes, maxTotalBytes - total);
      if (stat.size > budget) { skipped.push({ name: entry.name, reason: 'size limit reached' }); continue; }
      if (options.budget) release = await options.budget.acquire(stat.size);
      const buffer = await readBounded(handle, stat.size, budget, t);
      total += buffer.byteLength;
      count++;
      files[lower] = plainBytes(buffer);
    } catch (error) {
      skipped.push({ name: entry.name, reason: error && error.code === 'STORE_CHANGED' ? 'changed while reading' : 'not readable' });
    } finally {
      if (handle) await handle.close();
      if (release) release();
    }
  }
  return { directory, files, skipped };
}

// ---------------------------------------------------------------------------------------------
// Selection: several documents in one call
// ---------------------------------------------------------------------------------------------

// Reads the chosen files one after the other: at most 16 files and 256 MiB in total (companions
// included), each file at most 64 MiB. A schematic carries the schematic files of its own directory
// (bounded in count and bytes, never through a link that leaves the directory) as companions.
async function readSelection(filenames, options = {}) {
  const { t = identity, fs = defaultFs } = options;
  if (!Array.isArray(filenames)) throw documentError('The document selection must be a list.', 'DOCUMENT_INVALID_OPTIONS'); // i18n: pending
  if (filenames.length > MAX_SELECTION_FILES) {
    throw documentError(`Select at most ${MAX_SELECTION_FILES} documents at a time.`, 'DOCUMENT_TOO_MANY'); // i18n: pending
  }
  const perFile = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  let remaining = positiveInteger(options.maxTotalBytes, MAX_SELECTION_BYTES, 'maxTotalBytes');
  const batchTooLarge = () => documentError(`The selected documents together exceed ${Math.round(MAX_SELECTION_BYTES / 1048576)} MiB.`, 'DOCUMENT_BATCH_TOO_LARGE'); // i18n: pending
  const payloads = [];
  for (const filename of filenames) {
    if (remaining <= 0) throw batchTooLarge();
    let payload;
    try {
      payload = await readDocument(filename, { ...options, maxBytes: Math.min(perFile, remaining) });
    } catch (error) {
      if (error && error.code === 'DOCUMENT_TOO_LARGE' && remaining < perFile) throw batchTooLarge();
      throw error;
    }
    remaining -= payload.size;
    if (payload.kind === 'schematic') {
      if (remaining > 0) {
        const gathered = await gatherCompanions(payload.path, {
          ...options, extensions: KINDS.schematic.extensions, maxFiles: COMPANION_FILES, maxBytes: undefined,
          maxTotalBytes: Math.min(perFile, remaining),
        });
        const names = Object.keys(gathered.files);
        if (names.length) payload.companions = gathered.files;
        if (gathered.skipped.length) payload.skipped = gathered.skipped;
        for (const name of names) remaining -= gathered.files[name].byteLength;
      } else {
        payload.skipped = [{ name: '…', reason: 'selection size limit reached' }]; // i18n: pending
      }
    }
    payloads.push(payload);
  }
  return payloads;
}

// ---------------------------------------------------------------------------------------------
// Locating remembered documents
// ---------------------------------------------------------------------------------------------

// SHA-256 and size of a file read in fixed chunks (never the whole file in memory). A file that
// shrinks or grows while it is read is reported as changed instead of hashed.
async function hashFile(filename, options = {}) {
  const { t = identity, fs = defaultFs } = options;
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  let handle;
  try {
    handle = await fs.open(filename, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw documentError(t('native.error.notAFile'), 'DOCUMENT_NOT_A_FILE');
    if (stat.size > maxBytes) throw documentError(t('native.error.fileLimitExceeded'), 'DOCUMENT_TOO_LARGE');
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(Math.max(1, Math.min(HASH_CHUNK_BYTES, stat.size)));
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.byteLength, stat.size - offset), offset);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const probe = offset === stat.size ? (await handle.read(Buffer.alloc(1), 0, 1, stat.size)).bytesRead : 0;
    if (offset !== stat.size || probe > 0) throw documentError(t('native.error.fileChangedWhileReading'), 'DOCUMENT_CHANGED');
    return { key: hash.digest('hex'), size: stat.size };
  } catch (error) {
    throw mapError(error, t);
  } finally {
    if (handle) await handle.close();
  }
}

// A stored relative path: '/'-separated segments below the board directory, never absolute, never
// '..', no empty or dot segments, no drive or stream separators. Returns the segments or null.
function relativeSegments(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32767 || value.includes('\0')) return null;
  if (/^[A-Za-z]:/.test(value) || value.startsWith('/') || value.startsWith('\\')) return null;
  const segments = value.split(/[\\/]/);
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes(':')) ? null : segments;
}

// Path of `filename` below `root` with '/' separators, or undefined when it is not inside the tree.
function relativeInside(root, filename) {
  if (!root) return undefined;
  const relative = path.relative(root, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const index = next++; results[index] = await work(items[index], index); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.id !== 'string' || request.id.length === 0 || request.id.length > 128 ||
      !Object.hasOwn(KINDS, request.kind) || typeof request.path !== 'string' || request.path.length > 32767 ||
      (request.relativePath !== undefined && (typeof request.relativePath !== 'string' || request.relativePath.length > 32767)) ||
      typeof request.key !== 'string' || !KEY_PATTERN.test(request.key)) {
    throw documentError('Invalid document locate request.', 'DOCUMENT_INVALID_REQUEST'); // i18n: pending
  }
  return request;
}

// Resolves the board directory the relative paths are anchored to; null when it is not available
// (only the absolute candidates are tried then).
async function boardRoot(boardPath, options) {
  const { t = identity, fs = defaultFs } = options;
  let board;
  try { board = localAbsolutePath(boardPath, t); } catch (error) { throw mapError(error, t); }
  if (!formats.isSupportedExtension(board)) throw documentError(t('native.error.unsupportedFile'), 'DOCUMENT_INVALID_PATH');
  try { return localAbsolutePath(await fs.realpath(path.dirname(board)), t); } catch { return null; }
}

// One remembered document: tries the absolute path, then the path relative to the board directory
// (never leaving that tree), and verifies the SHA-256 of what it finds. A file with the remembered
// bytes wins ('ok' at the absolute path, 'moved' through the relative one); otherwise the first file
// found is reported as 'changed'. Only files of the request's kind (by extension) are considered.
async function locateOne(request, root, options) {
  const { t = identity, fs = defaultFs, platform } = options;
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  const candidates = [];
  let problem = null;
  try { candidates.push({ via: 'path', filename: localAbsolutePath(request.path, t) }); } catch { /* No usable absolute path. */ }
  if (request.relativePath !== undefined && root) {
    const segments = relativeSegments(request.relativePath);
    if (segments) candidates.push({ via: 'relative', filename: path.join(root, ...segments) });
    else problem = 'The stored relative path is not valid.'; // i18n: pending
  }
  const kindExtensions = KINDS[request.kind].extensions;
  const seen = [];
  let changed = null;
  for (const candidate of candidates) {
    let canonical;
    try {
      canonical = localAbsolutePath(await fs.realpath(candidate.filename), t);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      problem ??= mapError(error, t).message;
      continue;
    }
    if (candidate.via === 'relative' && relativeInside(root, canonical) === undefined) {
      problem ??= 'The relative path leaves the board directory.'; // i18n: pending
      continue;
    }
    if (seen.some((other) => samePath(other, canonical, platform))) continue;
    seen.push(canonical);
    if (!kindExtensions.includes(path.extname(canonical).toLowerCase())) {
      problem ??= `The file is not a ${request.kind} document.`; // i18n: pending
      continue;
    }
    let found;
    try {
      found = await hashFile(canonical, { t, fs, maxBytes });
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      problem ??= error.message;
      continue;
    }
    const relativePath = relativeInside(root, canonical);
    const where = { path: canonical, ...(relativePath === undefined ? {} : { relativePath }) };
    if (found.key === request.key) return { id: request.id, status: candidate.via === 'relative' ? 'moved' : 'ok', ...where, key: found.key, size: found.size };
    changed ??= { id: request.id, status: 'changed', ...where, key: found.key, size: found.size, message: 'The file exists but its content differs from the attached document.' }; // i18n: pending
  }
  if (changed) return changed;
  if (problem) return { id: request.id, status: 'unreadable', message: problem };
  return { id: request.id, status: 'missing' };
}

// Re-finds remembered documents (see locateOne) with bounded concurrency; results keep request order.
async function locateDocuments(boardPath, requests, options = {}) {
  if (!Array.isArray(requests) || requests.length > MAX_LOCATE_REQUESTS) {
    throw documentError(`At most ${MAX_LOCATE_REQUESTS} documents can be located at once.`, 'DOCUMENT_INVALID_REQUEST'); // i18n: pending
  }
  const checked = requests.map(validateRequest);
  const root = await boardRoot(boardPath, options);
  return mapLimit(checked, positiveInteger(options.concurrency, LOCATE_CONCURRENCY, 'concurrency'), (request) => locateOne(request, root, options));
}

// ---------------------------------------------------------------------------------------------
// Workspace export bundle
// ---------------------------------------------------------------------------------------------

// One zip segment that can neither climb out of its folder nor name a device or hidden file.
function safeFileName(name, fallback = 'file') {
  let base = String(name).replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!base) base = fallback;
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(base)) base = `_${base}`;
  if (base.length > 120) {
    const extension = path.extname(base).slice(0, 16);
    base = base.slice(0, 120 - extension.length) + extension;
  }
  return base;
}

function uniqueName(name, taken) {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let candidate = name;
  for (let index = 2; taken.has(candidate.toLowerCase()); index++) candidate = `${stem} (${index})${extension}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

function assertSafeZipName(name) {
  const segments = name.split('/');
  if (!name || name.startsWith('/') || /[\\\0]/.test(name) || segments.some((segment) => !segment || segment === '.' || segment === '..' || /^[A-Za-z]:/.test(segment))) {
    throw documentError('Unsafe name in the export bundle.', 'EXPORT_UNSAFE_NAME'); // i18n: pending
  }
  return name;
}

const defineValue = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
const COMPRESSED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.zip', '.tgz', '.gz', '.fz']);

// The manifest stored in the bundle: only the selected documents, paths relative to the bundle root
// (never an absolute local path), cameras/split restricted to what is included.
function bundleManifest(manifest, selected, entryNames, boardEntry) {
  const kept = new Set(selected.map((record) => record.id));
  const documents = selected.map((record) => {
    const { missing: _missing, ...rest } = record;
    return { ...rest, path: entryNames.get(record.id), relativePath: entryNames.get(record.id) };
  });
  const cameras = {};
  for (const key of Object.keys(manifest.cameras)) if (key === 'board' || kept.has(key)) defineValue(cameras, key, manifest.cameras[key]);
  const right = manifest.split.right && kept.has(manifest.split.right.id) ? manifest.split.right : null;
  return {
    ...manifest,
    board: { key: manifest.board.key, name: manifest.board.name, path: boardEntry ?? manifest.board.name, format: manifest.board.format },
    documents,
    split: { enabled: manifest.split.enabled && right !== null, ratio: manifest.split.ratio, right },
    cameras,
    ...(manifest.aliases ? { aliases: manifest.aliases } : {}),
  };
}

// Writes the zip next to its destination under a temporary name and renames it into place, so a
// failed export never leaves a partial file at the chosen path. Entries load lazily, one at a time.
// The final rename is retried a bounded number of times on EPERM/EACCES/EBUSY (W-win-lifecycle-01: on
// Windows a scanner or indexer holding the destination makes rename-over-existing fail for a moment);
// after the last attempt the temporary file is removed and the error is reported as before.
async function writeZipAtomically(fs, target, entries, fflate, renameDelaysMs) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  let bytes = 0;
  const pending = [];
  const zip = new fflate.Zip((error, chunk) => {
    if (error) pending.push(error);
    else pending.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  });
  // FileHandle#write may legally accept fewer bytes than offered; the rest of the chunk is offered again. A count that
  // is not a positive integer within what was offered means the handle is not progressing: fail instead of guessing.
  const writeFully = async (chunk) => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const offered = chunk.byteLength - offset;
      const { bytesWritten } = await handle.write(chunk, offset, offered);
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > offered) {
        throw documentError('The export file could not be written completely.', 'EXPORT_WRITE_FAILED'); // i18n: pending
      }
      offset += bytesWritten;
      bytes += bytesWritten;
    }
  };
  const flush = async () => {
    for (const chunk of pending.splice(0)) {
      if (chunk instanceof Error) throw chunk;
      await writeFully(chunk);
    }
  };
  try {
    handle = await fs.open(temporary, 'wx');
    for (const entry of entries) {
      const data = await entry.load();
      const file = entry.deflate && data.byteLength <= DEFLATE_LIMIT_BYTES ? new fflate.ZipDeflate(entry.name, { level: 6 }) : new fflate.ZipPassThrough(entry.name);
      zip.add(file);
      file.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength), true);
      await flush();
    }
    zip.end();
    await flush();
    await handle.close();
    handle = undefined;
    await renameWithRetry(fs, temporary, target, renameDelaysMs);
    return bytes;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

// Bundles ONLY what was asked for: the documents named in `documentIds` (each re-read and verified
// against its remembered SHA-256), the board files when `includeBoard`, the notes when `notes` is given.
// `boardFiles` is the board payload of main.cjs readBoard (already verified against the manifest key).
// Layout: workspace.json, notes.json?, board/<file>..., documents/<file>... Originals are only read.
async function exportBundle(options) {
  const { manifest, notes = null, documentIds, includeBoard = false, boardFiles = null, t = identity, fs = defaultFs, platform } = options;
  const maxTotalBytes = positiveInteger(options.maxTotalBytes, MAX_SELECTION_BYTES, 'maxTotalBytes');
  if (!Array.isArray(documentIds) || documentIds.length > MAX_LOCATE_REQUESTS || new Set(documentIds).size !== documentIds.length) {
    throw documentError('Invalid export document list.', 'EXPORT_INVALID_REQUEST'); // i18n: pending
  }
  if (includeBoard && (!Array.isArray(boardFiles) || boardFiles.length === 0)) throw documentError('The board files are required to include the board.', 'EXPORT_INVALID_REQUEST'); // i18n: pending
  const records = new Map(manifest.documents.map((record) => [record.id, record]));
  const selected = documentIds.map((id) => {
    const record = typeof id === 'string' ? records.get(id) : undefined;
    if (!record) throw documentError('The export names a document that is not in the workspace.', 'EXPORT_UNKNOWN_DOCUMENT'); // i18n: pending
    return record;
  });
  let target;
  try { target = localAbsolutePath(options.target, t); } catch (error) { throw mapError(error, t); }
  const fflate = require('fflate');

  // Verify every selected document before anything is written.
  const root = await boardRoot(manifest.board.path, options);
  const located = await mapLimit(selected, LOCATE_CONCURRENCY, async (record) => {
    const result = await locateOne({ id: record.id, kind: record.kind, path: record.path, relativePath: record.relativePath, key: record.key }, root, { t, fs, platform });
    if (result.status !== 'ok' && result.status !== 'moved') {
      throw documentError(`The document "${safeFileName(record.name, 'document')}" cannot be exported (${result.status}${result.message ? `: ${result.message}` : ''}).`, 'EXPORT_DOCUMENT_UNAVAILABLE'); // i18n: pending
    }
    return result;
  });

  const taken = new Set();
  const entryNames = new Map();
  const entries = [];
  const sources = [];
  let total = 0;
  const account = (bytes) => {
    total += bytes;
    if (total > maxTotalBytes) throw documentError(`The export exceeds ${Math.round(maxTotalBytes / 1048576)} MiB.`, 'EXPORT_TOO_LARGE'); // i18n: pending
  };
  const boardEntries = [];
  if (includeBoard) {
    const boardTaken = new Set();
    for (const file of boardFiles) {
      const name = assertSafeZipName(`board/${uniqueName(safeFileName(file.name), boardTaken)}`);
      if (file.primary) boardEntries.unshift(name); else boardEntries.push(name);
      account(file.data.byteLength);
      entries.push({ name, deflate: !COMPRESSED_EXTENSIONS.has(path.extname(name).toLowerCase()), load: () => file.data });
      if (file.path) sources.push(file.path);
    }
  }
  selected.forEach((record, index) => {
    const found = located[index];
    const name = assertSafeZipName(`documents/${uniqueName(safeFileName(path.basename(found.path)), taken)}`);
    entryNames.set(record.id, name);
    account(found.size);
    sources.push(found.path);
    entries.push({
      name, deflate: !COMPRESSED_EXTENSIONS.has(path.extname(name).toLowerCase()),
      load: async () => {
        const changedWhileExporting = (detail) => documentError(`The document "${safeFileName(record.name, 'document')}" changed while it was exported${detail ? ` (${detail})` : ''}.`, 'EXPORT_DOCUMENT_UNAVAILABLE'); // i18n: pending
        let document;
        try { document = await readDocument(found.path, { kinds: [record.kind], t, fs, maxBytes: found.size }); }
        catch (error) { throw changedWhileExporting(error && error.message); }
        if (document.key !== record.key) throw changedWhileExporting();
        return document.data;
      },
    });
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(bundleManifest(manifest, selected, entryNames, boardEntries[0]), null, 2)}\n`, 'utf8');
  const notesBytes = notes === null ? null : Buffer.from(`${JSON.stringify(notes, null, 2)}\n`, 'utf8');
  account(manifestBytes.byteLength + (notesBytes ? notesBytes.byteLength : 0));
  const ordered = [
    { name: 'workspace.json', deflate: true, load: () => manifestBytes },
    ...(notesBytes ? [{ name: 'notes.json', deflate: true, load: () => notesBytes }] : []),
    ...entries,
  ];

  // The bundle may never replace one of the files it was built from.
  const existing = await fs.stat(target).catch((error) => {
    if (error && error.code === 'ENOENT') return null;
    throw mapExportError(error);
  });
  if (existing) {
    for (const source of sources) {
      const stat = await fs.stat(source).catch(() => null);
      if (samePath(source, target, platform) || (stat && stat.ino !== 0 && stat.dev === existing.dev && stat.ino === existing.ino)) {
        throw documentError('The export cannot overwrite one of the original files.', 'EXPORT_OVERWRITES_SOURCE'); // i18n: pending
      }
    }
  }
  try {
    const bytes = await writeZipAtomically(fs, target, ordered, fflate, options.renameRetryDelaysMs);
    return { path: target, files: ordered.length, bytes };
  } catch (error) {
    throw mapExportError(error);
  }
}

function mapExportError(error) {
  const code = error && error.code;
  if (typeof code === 'string' && (code.startsWith('DOCUMENT_') || code.startsWith('EXPORT_'))) return error;
  if (typeof code === 'string' && code.startsWith('STORE_')) return mapError(error);
  return documentError('The export file could not be written. Check the destination and free space.', 'EXPORT_WRITE_FAILED', error); // i18n: pending
}

// Filter definitions for dialog.showOpenDialog. One kind → its filter; several → a combined
// "All supported documents" entry first, then one per kind.
function dialogFilters(kinds) {
  const list = normalizeKinds(kinds);
  const filters = list.map((kind) => ({ name: KINDS[kind].label, extensions: KINDS[kind].extensions.map((extension) => extension.slice(1)) }));
  if (list.length > 1) filters.unshift({ name: 'All supported documents', extensions: filters.flatMap((filter) => filter.extensions) }); // i18n: pending
  return filters;
}

module.exports = Object.freeze({
  DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, MAX_SELECTION_FILES, MAX_SELECTION_BYTES, KINDS,
  readDocument, readSelection, gatherCompanions, locateDocuments, hashFile, exportBundle,
  dialogFilters, sniffContent, safeFileName,
});
