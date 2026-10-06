'use strict';

/**
 * Update NOTIFICATION (not an installer). TRACE asks GitHub once whether a newer release exists and, if so, tells the user and sends them
 * to the release page in the browser. It never downloads, unpacks or runs anything: the Windows build is an unsigned portable EXE and the
 * macOS build is unsigned, so replacing an executable silently would be a supply-chain risk.
 *
 * This module is pure and injectable: the network function is a parameter (production passes Electron's net.fetch from main.cjs, tests pass
 * a fake). It reads nothing from the page it talks to except the release tag, and only after the tag matched a strict pattern; the release page
 * URL is built from that validated tag alone, never from text the server sent (html_url, name, body and every other field are ignored).
 * Every failure is reported as the same bare { status: 'unavailable' }: no error text and no response content leave this module. The one
 * addition is retryAfterMs after a 403 or 429: a clamped number read from the rate-limit headers, so that main.cjs can stay quiet that long.
 */

// One repository slug for everything that points at GitHub: both URLs here, the bug report link of main.cjs and the web fallback of
// src/lib/support-notice.ts all read electron/repository.json. Never a renamed owner or repository: redirects are refused by design (below),
// so a build with an old slug would report "unavailable" forever.
const { repository: REPOSITORY } = require('./repository.json');
const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASE_PAGE_BASE = `https://github.com/${REPOSITORY}/releases/tag/`;
const API_HOST = 'api.github.com';
// The REST API version the parsed shape (tag_name, draft, prerelease) is pinned to. Supported until 2028-03-10; after that a newer date is needed.
const API_VERSION = '2022-11-28';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 262144;
// After a 403 or 429 (unauthenticated clients share 60 requests per hour per address, with every other GitHub client behind the same connection)
// the caller stays quiet for retry-after seconds, else until x-ratelimit-reset once x-ratelimit-remaining is 0, else one minute; never less than
// a minute and never more than an hour, whatever the headers say.
const RETRY_MIN_MS = 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;

// Only plain release tags: v<major>.<minor>.<patch>, one to four digits each, no leading zeros. A pre-release suffix ("-rc.1") is a release that
// is never offered; anything else ("+build", a trailing newline, a fourth part) is not a release tag at all.
const TAG_PATTERN = /^v(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
const PRERELEASE_TAG_PATTERN = /^v(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})-[0-9A-Za-z.-]{1,32}$/;
// The running version, as app.getVersion() reports it. It goes into the User-Agent header, so its characters are restricted.
const VERSION_PATTERN = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(-[0-9A-Za-z.]{1,24})?$/;

const unavailable = () => ({ status: 'unavailable' });

/** [major, minor, patch] compared as numbers (1.10.0 is newer than 1.9.0); an equal triple is newer only than its own pre-release (1.3.0 is newer than 1.3.0-rc.1). */
function isNewer(candidate, current, currentIsPrerelease) {
  for (let index = 0; index < 3; index++) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  return currentIsPrerelease;
}

/** One response header, or null when the response has no readable headers. */
function header(response, name) {
  return response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null;
}

/** How long to stay quiet after a 403 or 429, in milliseconds: a number between RETRY_MIN_MS and RETRY_MAX_MS, never text from the response. */
function retryAfterMs(response, now = Date.now()) {
  const clamp = (ms) => Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, Math.ceil(ms)));
  const retryAfter = Number(header(response, 'retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return clamp(retryAfter * 1000);
  const reset = Number(header(response, 'x-ratelimit-reset'));
  if (header(response, 'x-ratelimit-remaining') === '0' && Number.isFinite(reset)) return clamp(reset * 1000 - now);
  return RETRY_MIN_MS;
}

/** Reads the whole body but never more than maxBytes: a larger one is cancelled and rejected. */
async function readBounded(response, maxBytes) {
  const declared = Number(header(response, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { discard(response); throw new Error('too large'); }
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') throw new Error('no body');
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
}

/** An unread body is released at once (best effort; nothing it holds is used). */
function discard(response) {
  try { if (response.body && typeof response.body.cancel === 'function') void response.body.cancel().catch(() => {}); } catch { /* Nothing to release. */ }
}

/** The response must come from the API host over HTTPS. Redirects are refused outright (redirect: 'error'); this also rejects a response that reports another URL. */
function fromApiHost(response) {
  if (response.redirected === true) return false;
  const url = response.url; // net.fetch does not fill it in; a fetch that does must name the API host.
  if (url === undefined || url === null || url === '') return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === API_HOST;
  } catch { return false; }
}

async function request({ currentVersion, fetchImpl, signal, maxBytes }) {
  const current = VERSION_PATTERN.exec(currentVersion);
  if (!current || typeof fetchImpl !== 'function') return unavailable();
  const response = await fetchImpl(RELEASES_API, {
    method: 'GET',
    // Exactly these four headers: the fixed language keeps the system language private, the User-Agent carries only the app version
    // (no Electron, Chrome or operating-system tokens), the API version pins the shape of the answer. Nothing about the user or the machine is sent.
    headers: { Accept: 'application/vnd.github+json', 'Accept-Language': 'en', 'User-Agent': `TRACE-Boardviewer/${currentVersion}`, 'X-GitHub-Api-Version': API_VERSION },
    credentials: 'omit', // no cookies, no authorization
    redirect: 'error', // never follow a redirect to another host
    referrer: '',
    referrerPolicy: 'no-referrer',
    signal,
  });
  if (!response) return unavailable();
  if (!fromApiHost(response)) { discard(response); return unavailable(); }
  // Rate limited or refused: only the waiting time is read from the answer, as a number.
  if (response.status === 403 || response.status === 429) { discard(response); return { status: 'unavailable', retryAfterMs: retryAfterMs(response) }; }
  if (response.status !== 200) { discard(response); return unavailable(); }
  let release;
  try { release = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response, maxBytes))); }
  catch { return unavailable(); }
  if (!release || typeof release !== 'object' || Array.isArray(release)) return unavailable();
  // A draft or a pre-release is never offered; it is not a newer release for this user.
  if (release.draft === true || release.prerelease === true) return { status: 'current' };
  const tagName = typeof release.tag_name === 'string' ? release.tag_name : '';
  const tag = TAG_PATTERN.exec(tagName);
  // A pre-release by its tag alone (the flag unset) is not offered either, but it is no error.
  if (!tag) return PRERELEASE_TAG_PATTERN.test(tagName) ? { status: 'current' } : unavailable();
  const latest = [Number(tag[1]), Number(tag[2]), Number(tag[3])];
  if (!isNewer(latest, [Number(current[1]), Number(current[2]), Number(current[3])], current[4] !== undefined)) return { status: 'current' };
  return { status: 'available', version: tag[0].slice(1), tag: tag[0] };
}

/**
 * One GET to RELEASES_API. Resolves to exactly one of { status: 'available', version, tag }, { status: 'current' }, { status: 'unavailable' } or,
 * after a 403 or 429, { status: 'unavailable', retryAfterMs }; it never rejects. The whole exchange, body included, is limited to timeoutMs and maxBytes.
 */
async function checkForUpdate({ currentVersion, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const cap = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  let timer;
  // The deadline also wins against a fetch that ignores the abort signal.
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(unavailable()); }, limit);
  });
  try {
    return await Promise.race([request({ currentVersion, fetchImpl, signal: controller.signal, maxBytes: cap }), deadline]);
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { REPOSITORY, RELEASES_API, RELEASE_PAGE_BASE, TAG_PATTERN, checkForUpdate };
