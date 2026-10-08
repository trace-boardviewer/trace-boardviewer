'use strict';

/**
 * Update NOTIFICATION (not an installer). TRACE asks GitHub once whether a newer release exists and, if so, tells the user and sends them
 * to the release page in the browser. It never downloads, unpacks or runs anything: the Windows build is an unsigned portable EXE and the
 * macOS build is unsigned, so replacing an executable silently would be a supply-chain risk.
 *
 * The request itself is made by electron/net/egress.cjs, the one place of the main process that may use the network: this module registers the
 * feature there (FEATURE: one host, one path, GET only, the headers below, 8 s, 256 KiB, redirects refused, the `updateCheck` setting as its opt-in) and
 * only turns the answer into a result. It is pure and injectable: main.cjs passes the shared egress (so the request shows up in the network activity
 * log), tests pass a fake fetch, from which a private egress is built.
 * It reads nothing from the page it talks to except the release tag, and only after the tag matched a strict pattern; the release page
 * URL is built from that validated tag alone, never from text the server sent (html_url, name, body and every other field are ignored).
 * Every failure is reported as the same bare { status: 'unavailable' }: no error text and no response content leave this module. The one
 * addition is retryAfterMs after a 403 or 429: a clamped number read from the rate-limit headers, so that main.cjs can stay quiet that long.
 */

// One repository slug for everything that points at GitHub: both URLs here, the bug report link of main.cjs and the web fallback of
// src/lib/support-notice.ts all read electron/repository.json. Never a renamed owner or repository: redirects are refused by design (egress),
// so a build with an old slug would report "unavailable" forever.
const { repository: REPOSITORY } = require('./repository.json');
const { createEgress, VERSION_PATTERN } = require('./net/egress.cjs');
const RELEASES_PATH = `/repos/${REPOSITORY}/releases/latest`;
const RELEASES_API = `https://api.github.com${RELEASES_PATH}`;
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

/**
 * The update check as a network feature. Exactly the headers Accept and X-GitHub-Api-Version here, plus the fixed Accept-Language (en) and
 * User-Agent (TRACE-Boardviewer/<version>) of egress: the fixed language keeps the system language private, the User-Agent carries only the app
 * version (no Electron, Chrome or operating-system tokens), the API version pins the shape of the answer. Nothing about the user or the machine is sent.
 * Opt-in: the `updateCheck` setting (on by default, switchable in Settings). The explicit Check now button is a user action and goes through
 * with the setting off; the start-up check is the renderer's to skip (src/lib/update-check.ts), because the two share one channel.
 */
const FEATURE = Object.freeze({
  id: 'update-check',
  hosts: Object.freeze([API_HOST]),
  methods: Object.freeze(['GET']),
  paths: Object.freeze([RELEASES_PATH]),
  maxBytes: DEFAULT_MAX_BYTES,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  headers: Object.freeze({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION }),
  // Only the waiting time is read from an answer that refuses the request.
  responseHeaders: Object.freeze(['retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset']),
  bodyStatuses: Object.freeze([200]),
  optIn: Object.freeze({ setting: 'updateCheck', bypassWithUserAction: true }),
});

// Only plain release tags: v<major>.<minor>.<patch>, one to four digits each, no leading zeros. A pre-release suffix ("-rc.1") is a release that
// is never offered; anything else ("+build", a trailing newline, a fourth part) is not a release tag at all.
const TAG_PATTERN = /^v(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
const PRERELEASE_TAG_PATTERN = /^v(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})-[0-9A-Za-z.-]{1,32}$/;

const unavailable = () => ({ status: 'unavailable' });

/** [major, minor, patch] compared as numbers (1.10.0 is newer than 1.9.0); an equal triple is newer only than its own pre-release (1.3.0 is newer than 1.3.0-rc.1). */
function isNewer(candidate, current, currentIsPrerelease) {
  for (let index = 0; index < 3; index++) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  return currentIsPrerelease;
}

/** How long to stay quiet after a 403 or 429, in milliseconds: a number between RETRY_MIN_MS and RETRY_MAX_MS, never text from the response. `headers` are the lower-case response headers egress hands over. */
function retryAfterMs(headers, now = Date.now()) {
  const clamp = (ms) => Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, Math.ceil(ms)));
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return clamp(retryAfter * 1000);
  const reset = Number(headers['x-ratelimit-reset']);
  if (headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset)) return clamp(reset * 1000 - now);
  return RETRY_MIN_MS;
}

async function request({ currentVersion, egress, timeoutMs, maxBytes }) {
  const current = VERSION_PATTERN.exec(currentVersion);
  if (!current || !egress || typeof egress.request !== 'function') return unavailable();
  // One GET to the fixed URL; the deadline and the size cap cover the whole exchange, body included (a caller's limit can only be smaller than the feature's).
  const answer = await egress.request(FEATURE.id, RELEASES_API, { userAction: true, timeoutMs, maxBytes });
  if (!answer || !answer.ok) return unavailable();
  // Rate limited or refused: only the waiting time is read from the answer, as a number.
  if (answer.status === 403 || answer.status === 429) return { status: 'unavailable', retryAfterMs: retryAfterMs(answer.headers ?? {}) };
  if (answer.status !== 200 || !answer.body) return unavailable();
  let release;
  try { release = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(answer.body)); }
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
 * One GET to RELEASES_API through egress. Resolves to exactly one of { status: 'available', version, tag }, { status: 'current' }, { status: 'unavailable' } or,
 * after a 403 or 429, { status: 'unavailable', retryAfterMs }; it never rejects. The whole exchange, body included, is limited to timeoutMs and maxBytes.
 * `egress` is the shared layer of main.cjs with FEATURE registered; without it a private layer is built around `fetchImpl` (tests, standalone use).
 */
async function checkForUpdate({ currentVersion, fetchImpl, egress, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const cap = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  try {
    let layer = egress;
    if (!layer) {
      if (typeof fetchImpl !== 'function' || typeof currentVersion !== 'string') return unavailable();
      layer = createEgress({ fetchImpl, version: currentVersion, isEnabled: () => true });
      layer.register(FEATURE);
    }
    return await request({ currentVersion, egress: layer, timeoutMs: limit, maxBytes: cap });
  } catch {
    return unavailable();
  }
}

module.exports = { REPOSITORY, RELEASES_API, RELEASE_PAGE_BASE, TAG_PATTERN, FEATURE, checkForUpdate };
