'use strict';

/**
 * Egress: the one place in the main process that may make a network request. Every other main-process file, the preload and the renderer
 * (CSP connect-src 'self') are kept away from the network by tests/desktop-checks.cjs; a feature that needs the internet registers here and
 * asks here. The renderer never gets a URL-taking API: it can read the activity log and clear it, nothing else (see the two
 * 'trace:*-network-activity' channels of main.cjs).
 *
 * What a registered feature gets, and what it can never change:
 *  - https only, an exact host allow-list (no wildcards, no IP literals, no ports, no credentials in the URL, no fragment, no query unless the
 *    feature says so), optionally an exact path or path prefix allow-list; the URL must already be in its normalized form;
 *  - methods GET and HEAD only, never a request body; the request headers are the feature's fixed ones plus a fixed Accept-Language (en) and the
 *    fixed User-Agent TRACE-Boardviewer/<version>; no caller-supplied header, no cookie, no authorization, no referrer (credentials 'omit');
 *  - redirects are refused (redirect 'error', and a response that reports a redirect, a 3xx redirect status or another URL is refused too);
 *  - a response size cap and a time cap for the whole exchange, body included (the deadline also wins against a fetch that ignores the abort
 *    signal); a per-feature limit of requests in flight;
 *  - an optional opt-in: a setting that must be on (read from main-process state at the moment of the request, never cached and never sent by
 *    the renderer); a feature may let an explicit user action (for example a Check now button) through while the setting is off;
 *  - an in-memory ring log of every request and its outcome (time, feature, host, path WITHOUT the query, status, bytes, duration and an error
 *    CLASS from a fixed list, never an error message). Nothing in a log entry can carry a query secret, a header, a body or a server text.
 * The one function that touches the network is the injected fetchImpl (production: createElectronFetch below, an in-memory partition with no
 * cache, no cookies, no permissions and no downloads; tests: a fake). request() and download() never reject.
 *
 * download() is the separate, audited path for a response that must land on disk. It exists with tests but no feature uses it yet. The folder is
 * chosen by main at creation (downloadDirectory), the caller supplies no path and no file name (the name is the SHA-256 of the bytes plus one
 * extension fixed by the feature), the file is written exclusively to a private temporary name, size-capped, hashed while it is written and only
 * then renamed; it returns the path and the SHA-256 and leaves nothing behind on any failure.
 */

const crypto = require('node:crypto');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

/** The in-memory (no "persist:" prefix) Electron partition every request goes through: no cookies or cache survive, and none are shared with the page. */
const PARTITION = 'trace-egress';
const ACCEPT_LANGUAGE = 'en';
// The running version, as app.getVersion() reports it. It goes into the User-Agent header, so its characters are restricted.
const VERSION_PATTERN = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(-[0-9A-Za-z.]{1,24})?$/;

const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 1000;
const DEFAULT_MAX_IN_FLIGHT = 2;
const MAX_URL_LENGTH = 2048;
const MAX_LOGGED_PATH = 120;
const MAX_HEADER_VALUE = 256;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120 * 1000;
// A download that is cut off gets this long to remove its temporary file before the caller is answered.
const CLEANUP_GRACE_MS = 250;

/**
 * The error classes of a log entry and of a result, a closed list (the Settings view has a label for each group of them).
 * Refused before anything was sent: disabled, not-registered, invalid-url, scheme, host, path, method, busy, not-allowed.
 * Sent, then failed or cut off: redirect, too-large, timeout, network, bad-response, storage, hash-mismatch.
 */
const ERROR_CLASSES = Object.freeze([
  'disabled', 'not-registered', 'invalid-url', 'scheme', 'host', 'path', 'method', 'busy', 'not-allowed',
  'redirect', 'too-large', 'timeout', 'network', 'bad-response', 'storage', 'hash-mismatch',
]);

const FEATURE_ID = /^[a-z][a-z0-9-]{1,47}$/;
// A registered name with at least one dot and a letter-only (or punycode) last label: no wildcard, no IP literal, no bare "localhost".
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const EXTENSION = /^[a-z0-9]{1,8}$/;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/;
// Headers a feature may not set: the ones egress owns, anything that identifies the user or the session, and anything that frames a body.
const FORBIDDEN_HEADER = /^(?:authorization|proxy-authorization|cookie2?|set-cookie|referer|origin|host|user-agent|accept-language|content-[a-z-]+|transfer-encoding|connection|upgrade|te|trailer|expect|keep-alive|via|forwarded|x-forwarded-[a-z-]+|x-real-ip)$|token|secret|passw|api-?key|session|credential/i;
const RESPONSE_HEADER = /^[a-z][a-z0-9-]{0,63}$/;
// What a 3xx answer means here: the server wants the client to go somewhere else, which is never followed.
const REDIRECT_STATUSES = new Set([300, 301, 302, 303, 305, 307, 308]);
const KNOWN_FIELDS = new Set([
  'id', 'hosts', 'methods', 'paths', 'pathPrefixes', 'allowQuery', 'maxBytes', 'timeoutMs', 'maxInFlight', 'headers', 'responseHeaders',
  'bodyStatuses', 'optIn', 'redirect', 'download',
]);

const invalid = (message) => new TypeError(`Invalid network feature: ${message}`); // Developer-facing; a registration error is a programming error.

function integerIn(value, name, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function stringList(value, name, pattern, { min = 0, max = 16, lower = false } = {}) {
  if (value === undefined) value = [];
  if (!Array.isArray(value) || value.length < min || value.length > max) throw invalid(`${name} must be a list of ${min} to ${max} entries.`);
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || !pattern.test(entry) || (lower && entry !== entry.toLowerCase())) throw invalid(`${name} has an entry that is not allowed.`);
    if (seen.has(entry)) throw invalid(`${name} lists an entry twice.`);
    seen.add(entry);
  }
  return Object.freeze([...value]);
}

/** A registered feature, validated and frozen. A bad descriptor throws at registration: the layer fails closed, never open. */
function normalizeFeature(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw invalid('a feature is a plain object.');
  for (const key of Object.keys(descriptor)) if (!KNOWN_FIELDS.has(key)) throw invalid(`unknown field "${key}".`);
  if (typeof descriptor.id !== 'string' || !FEATURE_ID.test(descriptor.id)) throw invalid('id must be lowercase letters, digits and hyphens.');
  const hosts = stringList(descriptor.hosts, 'hosts', HOSTNAME, { min: 1, max: 8, lower: true });
  const methods = stringList(descriptor.methods ?? ['GET'], 'methods', /^(?:GET|HEAD)$/, { min: 1, max: 2 }); // No other method, and no request body, exists in this layer.
  const paths = stringList(descriptor.paths, 'paths', /^\/[\x21-\x7e]{0,199}$/, { max: 8 });
  const pathPrefixes = stringList(descriptor.pathPrefixes, 'pathPrefixes', /^\/(?:[\x21-\x7e]{0,198}\/)?$/, { max: 8 });
  for (const entry of [...paths, ...pathPrefixes]) if (/[?#\\]/.test(entry)) throw invalid('a path must not contain ?, # or a backslash.');
  if (descriptor.allowQuery !== undefined && typeof descriptor.allowQuery !== 'boolean') throw invalid('allowQuery must be a boolean.');
  if (descriptor.redirect !== undefined && descriptor.redirect !== 'refuse') throw invalid('redirects can only be refused.');
  const maxBytes = integerIn(descriptor.maxBytes, 'maxBytes', 1, MAX_RESPONSE_BYTES, undefined);
  const timeoutMs = integerIn(descriptor.timeoutMs, 'timeoutMs', 1, MAX_TIMEOUT_MS, undefined);
  if (maxBytes === undefined || timeoutMs === undefined) throw invalid('maxBytes and timeoutMs are required.');
  const maxInFlight = integerIn(descriptor.maxInFlight, 'maxInFlight', 1, 8, DEFAULT_MAX_IN_FLIGHT);
  let headers = {};
  if (descriptor.headers !== undefined) {
    if (!descriptor.headers || typeof descriptor.headers !== 'object' || Array.isArray(descriptor.headers)) throw invalid('headers must be a plain object.');
    const names = new Set();
    for (const [name, value] of Object.entries(descriptor.headers)) {
      if (!HEADER_NAME.test(name) || FORBIDDEN_HEADER.test(name)) throw invalid(`the header "${name}" is not allowed.`);
      if (names.has(name.toLowerCase())) throw invalid('a header is listed twice.');
      names.add(name.toLowerCase());
      if (typeof value !== 'string' || !HEADER_VALUE.test(value)) throw invalid(`the value of the header "${name}" is not allowed.`);
    }
    headers = { ...descriptor.headers };
  }
  const responseHeaders = stringList(descriptor.responseHeaders, 'responseHeaders', RESPONSE_HEADER, { max: 8, lower: true });
  if (responseHeaders.some((name) => /^set-cookie2?$/.test(name))) throw invalid('a cookie is never read from an answer.');
  let bodyStatuses = [200];
  if (descriptor.bodyStatuses !== undefined) {
    if (!Array.isArray(descriptor.bodyStatuses) || descriptor.bodyStatuses.length > 8 || descriptor.bodyStatuses.some((status) => !Number.isInteger(status) || status < 200 || status > 299)) {
      throw invalid('bodyStatuses must list at most eight 2xx statuses.');
    }
    bodyStatuses = [...descriptor.bodyStatuses];
  }
  let optIn = null;
  if (descriptor.optIn !== undefined && descriptor.optIn !== null) {
    const value = descriptor.optIn;
    if (typeof value !== 'object' || Array.isArray(value) || typeof value.setting !== 'string' || !SETTING_KEY.test(value.setting) ||
        (value.bypassWithUserAction !== undefined && typeof value.bypassWithUserAction !== 'boolean') ||
        Object.keys(value).some((key) => key !== 'setting' && key !== 'bypassWithUserAction')) {
      throw invalid('optIn is { setting, bypassWithUserAction? }.');
    }
    optIn = Object.freeze({ setting: value.setting, bypassWithUserAction: value.bypassWithUserAction === true });
  }
  let download = null;
  if (descriptor.download !== undefined && descriptor.download !== null) {
    const value = descriptor.download;
    if (typeof value !== 'object' || Array.isArray(value) || typeof value.extension !== 'string' || !EXTENSION.test(value.extension) ||
        Object.keys(value).some((key) => key !== 'maxBytes' && key !== 'extension')) {
      throw invalid('download is { maxBytes, extension }.');
    }
    const downloadMax = integerIn(value.maxBytes, 'download.maxBytes', 1, MAX_DOWNLOAD_BYTES, undefined);
    if (downloadMax === undefined) throw invalid('download.maxBytes is required.');
    download = Object.freeze({ maxBytes: downloadMax, extension: value.extension });
  }
  return Object.freeze({
    id: descriptor.id, hosts, methods, paths, pathPrefixes, allowQuery: descriptor.allowQuery === true, maxBytes, timeoutMs, maxInFlight,
    headers: Object.freeze(headers), responseHeaders, bodyStatuses: Object.freeze(bodyStatuses), optIn, download,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------------------------------------------

/** One response header, or null when the response has no readable headers. */
function headerValue(response, name) {
  try { return response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null; } catch { return null; }
}

/** An unread body is released at once (best effort; nothing it holds is used). */
function discard(response) {
  try { if (response && response.body && typeof response.body.cancel === 'function') void response.body.cancel().catch(() => {}); } catch { /* Nothing to release. */ }
}

/** A failure that carries its class out of the body reader. */
const failure = (error) => Object.assign(new Error(error), { egressError: error });

/**
 * Reads the body chunk by chunk, never more than maxBytes: a larger declared or streamed size is cancelled and refused. The abort signal cancels
 * a stalled read. Resolves to the number of bytes read; `onChunk` gets every chunk (a Uint8Array) in order.
 */
async function readLimited(response, maxBytes, signal, onChunk) {
  const declared = Number(headerValue(response, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { discard(response); throw failure('too-large'); }
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') throw failure('bad-response');
  const reader = body.getReader();
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  let total = 0;
  try {
    for (;;) {
      let step;
      try { step = await reader.read(); } catch { throw failure(signal.aborted ? 'timeout' : 'network'); }
      const { done, value } = step;
      if (done) break;
      if (!ArrayBuffer.isView(value)) { await reader.cancel().catch(() => {}); throw failure('bad-response'); }
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => {}); throw failure('too-large'); }
      await onChunk(value);
    }
    if (signal.aborted) throw failure('timeout');
  } finally {
    signal.removeEventListener('abort', stop);
  }
  return total;
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) throw failure('storage');
    offset += bytesWritten;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Log helpers: what is shown is rebuilt from parsed parts, never copied from the caller's string
// ---------------------------------------------------------------------------------------------------------------

// Only the host and the path of an http(s) URL are ever shown; any other scheme (data:, javascript:, file:) puts its content in the "path".
const webUrl = (url) => Boolean(url) && (url.protocol === 'https:' || url.protocol === 'http:');
function loggedHost(url) {
  const host = webUrl(url) ? url.hostname.toLowerCase().replace(/[^a-z0-9.:-]/g, '') : '';
  return host.slice(0, 253);
}
function loggedPath(url) {
  if (!webUrl(url)) return '';
  const text = url.pathname.replace(/[^\x20-\x7e]/g, '?');
  return text.length > MAX_LOGGED_PATH ? `${text.slice(0, MAX_LOGGED_PATH - 1)}…` : text; // The query and the fragment are never part of it.
}
const loggedFeature = (id) => (typeof id === 'string' && /^[a-z0-9-]{1,48}$/.test(id) ? id : '?');
const loggedMethod = (method) => (typeof method === 'string' && /^[A-Z]{3,7}$/.test(method) ? method : 'GET');
function parsedUrl(rawUrl) {
  try { return typeof rawUrl === 'string' && rawUrl.length <= MAX_URL_LENGTH ? new URL(rawUrl) : null; } catch { return null; }
}
/** A caller's limit can only make a feature's limit smaller. */
const tighten = (limit, wanted) => (Number.isFinite(wanted) && wanted > 0 ? Math.min(limit, Math.ceil(wanted)) : limit);

// ---------------------------------------------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------------------------------------------

/**
 * createEgress({ fetchImpl, version, isEnabled, now, logLimit, downloadDirectory, fs }):
 *  fetchImpl         (url, init) => Promise<Response>: the only function that reaches the network (required).
 *  version           the running version (digits only); without a valid one nothing is sent.
 *  isEnabled         (settingKey) => boolean, asked at request time for every feature with an opt-in; without it every opt-in feature is off.
 *  now               () => milliseconds, for the log.
 *  logLimit          the size of the ring log (default 200, at most 1000).
 *  downloadDirectory the absolute folder main chose for download(); without it no download can be made.
 *  fs                node:fs/promises (tests may inject another).
 */
function createEgress(options = {}) {
  const { fetchImpl, version, isEnabled = () => false, now = Date.now, downloadDirectory = null } = options;
  if (typeof fetchImpl !== 'function') throw new TypeError('createEgress needs a fetch function.');
  const fsImpl = options.fs ?? fsPromises;
  const userAgent = typeof version === 'string' && VERSION_PATTERN.test(version) ? `TRACE-Boardviewer/${version}` : null;
  const limit = Number.isSafeInteger(options.logLimit) && options.logLimit > 0 ? Math.min(options.logLimit, MAX_LOG_LIMIT) : DEFAULT_LOG_LIMIT;
  const directory = typeof downloadDirectory === 'string' && path.isAbsolute(downloadDirectory) && !downloadDirectory.includes('\0') ? path.normalize(downloadDirectory) : null;
  const registry = new Map();
  const inFlight = new Map();
  const entries = [];
  let dropped = 0;
  let sequence = 0;

  const clock = () => { const value = now(); return Number.isFinite(value) ? value : Date.now(); };
  const enabled = (setting) => { try { return isEnabled(setting) === true; } catch { return false; } };

  function openEntry(kind, featureId, method, url) {
    const entry = {
      id: ++sequence, time: new Date(clock()).toISOString(), kind, feature: loggedFeature(featureId), method: loggedMethod(method),
      host: loggedHost(url), path: loggedPath(url), outcome: 'pending', status: null, bytes: 0, durationMs: null, error: null,
    };
    entries.push(entry);
    while (entries.length > limit) { entries.shift(); dropped++; }
    return entry;
  }
  function closeEntry(entry, started, outcome, { status = null, bytes = 0, error = null } = {}) {
    entry.outcome = outcome;
    entry.status = Number.isInteger(status) ? status : null;
    entry.bytes = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
    entry.durationMs = Math.max(0, Math.round(clock() - started));
    entry.error = error;
  }

  /** Every check that happens before anything is sent. Returns { error } or { feature, url, method }. */
  function admit(kind, featureId, rawUrl, callOptions) {
    const feature = typeof featureId === 'string' ? registry.get(featureId) : undefined;
    if (!feature) return { error: 'not-registered' };
    if (userAgent === null) return { error: 'not-allowed' };
    if (feature.optIn && !(callOptions.userAction === true && feature.optIn.bypassWithUserAction) && !enabled(feature.optIn.setting)) return { error: 'disabled' };
    if (kind === 'download' && (!feature.download || directory === null)) return { error: 'not-allowed' };
    // An expected digest that is not a lower-case SHA-256 hex string would silently check nothing: refused instead.
    if (callOptions.expectedSha256 !== undefined && !(kind === 'download' && typeof callOptions.expectedSha256 === 'string' && /^[0-9a-f]{64}$/.test(callOptions.expectedSha256))) return { error: 'not-allowed' };
    const method = callOptions.method ?? feature.methods[0];
    if (typeof method !== 'string' || !feature.methods.includes(method)) return { error: 'method', feature };
    const url = parsedUrl(rawUrl);
    if (!url || url.href !== rawUrl || rawUrl.includes('#') || url.username || url.password || url.port !== '') return { error: 'invalid-url', feature, method };
    if (url.protocol !== 'https:') return { error: 'scheme', feature, method };
    if (!feature.hosts.includes(url.hostname)) return { error: 'host', feature, method };
    if (!feature.allowQuery && (url.search !== '' || rawUrl.includes('?'))) return { error: 'invalid-url', feature, method };
    if ((feature.paths.length || feature.pathPrefixes.length) && !feature.paths.includes(url.pathname) && !feature.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
      return { error: 'path', feature, method };
    }
    if ((inFlight.get(feature.id) ?? 0) >= feature.maxInFlight) return { error: 'busy', feature, method };
    return { feature, url, method };
  }

  /** The checks on what came back; shared by request and download. Resolves to { error } or { status, headers }. */
  function inspect(response, feature, url) {
    if (!response || typeof response !== 'object') return { error: 'bad-response' };
    if (response.redirected === true) { discard(response); return { error: 'redirect' }; }
    const reported = response.url; // net.fetch does not fill it in; a fetch that does must name the host that was asked.
    if (reported !== undefined && reported !== null && reported !== '') {
      const parsed = parsedUrl(reported);
      if (!parsed) { discard(response); return { error: 'bad-response' }; }
      if (parsed.protocol !== 'https:' || parsed.hostname !== url.hostname) { discard(response); return { error: 'redirect' }; }
    }
    const status = response.status;
    if (!Number.isInteger(status) || status < 100 || status > 599) { discard(response); return { error: 'bad-response' }; }
    if (REDIRECT_STATUSES.has(status)) { discard(response); return { error: 'redirect', status }; }
    const headers = {};
    for (const name of feature.responseHeaders) {
      const value = headerValue(response, name);
      if (typeof value === 'string') headers[name] = value.replace(/[^\x20-\x7e]/g, '').slice(0, MAX_HEADER_VALUE);
    }
    return { status, headers };
  }

  async function runRequest({ feature, url, method }, init, maxBytes, signal) {
    const response = await fetchImpl(url.href, init);
    const checked = inspect(response, feature, url);
    if (checked.error) return { ok: false, error: checked.error, status: checked.status };
    const { status, headers } = checked;
    // The body is read only for the statuses the feature has a use for; any other answer releases it unread.
    if (method === 'HEAD' || !feature.bodyStatuses.includes(status)) { discard(response); return { ok: true, status, headers, body: null }; }
    const chunks = [];
    await readLimited(response, maxBytes, signal, (chunk) => { chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)); });
    return { ok: true, status, headers, body: Buffer.concat(chunks) };
  }

  async function runDownload({ feature, url, method }, init, maxBytes, signal, expectedSha256) {
    const response = await fetchImpl(url.href, init);
    const checked = inspect(response, feature, url);
    if (checked.error) return { ok: false, error: checked.error, status: checked.status };
    if (method !== 'GET' || checked.status !== 200) { discard(response); return { ok: false, error: 'bad-response', status: checked.status }; }
    // The folder was chosen by main. It is created private, and a link standing in for it is refused.
    try {
      await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await fsImpl.lstat(directory)).isDirectory()) throw new Error('not a folder');
    } catch { discard(response); return { ok: false, error: 'storage' }; }
    const temporary = path.join(directory, `.download-${crypto.randomBytes(12).toString('hex')}.part`);
    const hash = crypto.createHash('sha256');
    let handle = null;
    let kept = false;
    try {
      try { handle = await fsImpl.open(temporary, 'wx', 0o600); } catch { discard(response); throw failure('storage'); }
      const bytes = await readLimited(response, maxBytes, signal, async (chunk) => {
        try { hash.update(chunk); await writeAll(handle, chunk); } catch { throw failure('storage'); }
      });
      await handle.sync();
      await handle.close();
      handle = null;
      if (signal.aborted) throw failure('timeout'); // The deadline passed while the file was being flushed: the caller was told "timeout", so nothing is kept.
      const sha256 = hash.digest('hex');
      if (expectedSha256 !== undefined && sha256 !== expectedSha256) throw failure('hash-mismatch');
      // The name is the digest and the feature's one extension: nothing from the URL or from the server reaches the file system.
      const target = path.join(directory, `${sha256}.${feature.download.extension}`);
      await fsImpl.rename(temporary, target);
      kept = true;
      return { ok: true, status: checked.status, path: target, sha256, bytes };
    } catch (error) {
      if (error && error.egressError) throw error;
      throw failure('storage');
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (!kept) await fsImpl.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function execute(kind, featureId, rawUrl, rawOptions) {
    const callOptions = rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions) ? rawOptions : {};
    const started = clock();
    const admitted = admit(kind, featureId, rawUrl, callOptions);
    const url = admitted.url ?? parsedUrl(rawUrl);
    const entry = openEntry(kind, featureId, admitted.method ?? callOptions.method, url);
    if (admitted.error) { closeEntry(entry, started, 'refused', { error: admitted.error }); return { ok: false, error: admitted.error }; }
    const { feature, method } = admitted;
    const expectedSha256 = callOptions.expectedSha256;
    const maxBytes = tighten(kind === 'download' ? feature.download.maxBytes : feature.maxBytes, callOptions.maxBytes);
    const timeoutMs = tighten(feature.timeoutMs, callOptions.timeoutMs);
    const controller = new AbortController();
    // Exactly these keys: no cookies and no authorization, no referrer, no redirect, only the fixed headers.
    const init = {
      method,
      headers: { ...feature.headers, 'Accept-Language': ACCEPT_LANGUAGE, 'User-Agent': userAgent },
      credentials: 'omit',
      redirect: 'error',
      referrer: '',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    };
    inFlight.set(feature.id, (inFlight.get(feature.id) ?? 0) + 1);
    let timer;
    const TIMED_OUT = Symbol('timed out');
    // The deadline also wins against a fetch that ignores the abort signal.
    const deadline = new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(TIMED_OUT); }, timeoutMs); });
    const work = (async () => {
      try {
        const target = { feature, url, method };
        return kind === 'download' ? await runDownload(target, init, maxBytes, controller.signal, expectedSha256) : await runRequest(target, init, maxBytes, controller.signal);
      } catch (error) {
        return { ok: false, error: error && error.egressError ? error.egressError : controller.signal.aborted ? 'timeout' : 'network' };
      }
    })();
    let result;
    try {
      result = await Promise.race([work, deadline]);
      if (result === TIMED_OUT) {
        // A download that was cut off removes its temporary file before the answer.
        if (kind === 'download') await new Promise((resolve) => { const wait = setTimeout(resolve, CLEANUP_GRACE_MS); work.then(() => { clearTimeout(wait); resolve(); }); });
        result = { ok: false, error: 'timeout' };
      }
    } finally {
      clearTimeout(timer);
      inFlight.set(feature.id, Math.max(0, (inFlight.get(feature.id) ?? 1) - 1));
    }
    if (result.ok) {
      closeEntry(entry, started, 'ok', { status: result.status, bytes: kind === 'download' ? result.bytes : result.body ? result.body.length : 0 });
      return kind === 'download' ? { ok: true, status: result.status, path: result.path, sha256: result.sha256, bytes: result.bytes } : { ok: true, status: result.status, headers: result.headers, body: result.body };
    }
    closeEntry(entry, started, 'error', { status: result.status, error: ERROR_CLASSES.includes(result.error) ? result.error : 'network' });
    return { ok: false, error: entry.error, ...(Number.isInteger(result.status) ? { status: result.status } : {}) };
  }

  const api = {
    /** Registers a feature (see the header of this file). A bad descriptor or a repeated id throws. */
    register(descriptor) {
      const feature = normalizeFeature(descriptor);
      if (registry.has(feature.id)) throw invalid(`"${feature.id}" is registered twice.`);
      registry.set(feature.id, feature);
      return feature;
    },
    /**
     * One GET (or HEAD) for a registered feature. Resolves, never rejects, to { ok: true, status, headers, body } (headers: only the feature's
     * response header allow-list, lower-case; body: a Buffer, or null when the status has no use for it) or { ok: false, error, status? }.
     * options: { userAction } (true only when the request answers a direct user action), { method }, { timeoutMs, maxBytes } (smaller only).
     */
    request: (featureId, url, callOptions) => execute('request', featureId, url, callOptions),
    /**
     * The audited path to disk (needs `downloadDirectory` and a feature with `download`). Resolves, never rejects, to
     * { ok: true, status, path, sha256, bytes } or { ok: false, error, status? }. options: { userAction, timeoutMs, maxBytes (smaller only), expectedSha256 }.
     */
    download: (featureId, url, callOptions) => execute('download', featureId, url, callOptions),
    /** True for an https URL without credentials whose host some feature may reach. A second line of defence for the network session, not the policy. */
    isAllowedUrl(value) {
      const url = parsedUrl(value);
      return Boolean(url && url.protocol === 'https:' && !url.username && !url.password && url.port === '' && [...registry.values()].some((feature) => feature.hosts.includes(url.hostname)));
    },
    /** The registered features as the Settings view lists them (plain data): hosts, whether an opt-in applies and whether the feature is on. */
    features() {
      return [...registry.values()].map((feature) => ({
        id: feature.id, hosts: [...feature.hosts], methods: [...feature.methods], optIn: feature.optIn ? feature.optIn.setting : null,
        enabled: feature.optIn ? enabled(feature.optIn.setting) : true,
      }));
    },
    /** The log, oldest first, as plain copies: { limit, dropped (older entries that no longer fit), entries }. */
    activity: () => ({ limit, dropped, entries: entries.map((entry) => ({ ...entry })) }),
    /** Empties the log (the sequence numbers keep counting). */
    clearLog() { entries.length = 0; dropped = 0; },
    userAgent,
    logLimit: limit,
  };
  return Object.freeze(api);
}

/**
 * The production transport: Electron's session.fetch on the in-memory partition, created on first use. The session grants no permission, starts
 * no download and, as a second line of defence, cancels any request to a URL that no feature may reach. `isAllowed` is egress.isAllowedUrl.
 * This file is the only place of the main process where a fetch is made.
 */
function createElectronFetch({ session, isAllowed }) {
  let partition = null;
  const sessionOfPartition = () => {
    if (partition) return partition;
    const created = session.fromPartition(PARTITION, { cache: false });
    if (typeof created.setPermissionRequestHandler === 'function') created.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    if (typeof created.setPermissionCheckHandler === 'function') created.setPermissionCheckHandler(() => false);
    if (typeof created.on === 'function') created.on('will-download', (event) => event.preventDefault());
    if (created.webRequest && typeof created.webRequest.onBeforeRequest === 'function') {
      created.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => callback({ cancel: !isAllowed(details.url) }));
    }
    partition = created;
    return partition;
  };
  return (url, init) => sessionOfPartition().fetch(url, init);
}

module.exports = { PARTITION, VERSION_PATTERN, ERROR_CLASSES, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT, createEgress, createElectronFetch };
