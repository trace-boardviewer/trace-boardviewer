/** A sensitive span in the original description, using JavaScript UTF-16 offsets. */
export type SensitiveDescriptionDetail = Readonly<{
  start: number;
  end: number;
  kind: 'path' | 'private-key' | 'credential';
}>;

const MAX_UTF8_BYTES = 8192;
const MAX_CODE_POINTS = 2000;
const MAX_REPLACEMENT_CODE_POINTS = 128;
const UNSUPPORTED_TEXT = 'Unsupported description text.';

type Candidate = { start: number; end: number; kind: SensitiveDescriptionDetail['kind'] };

/**
 * Enforces the description boundary without normalizing it. CR, LF, and tab are
 * retained as entered; other control characters and unpaired surrogates fail
 * with one fixed, content-free error.
 */
function validateText(text: string, maxCodePoints = MAX_CODE_POINTS): void {
  if (typeof text !== 'string') throw new TypeError(UNSUPPORTED_TEXT);
  let bytes = 0;
  let points = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(UNSUPPORTED_TEXT);
      index += 1;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(UNSUPPORTED_TEXT);
    } else {
      if ((unit < 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d) || (unit >= 0x7f && unit <= 0x9f)) {
        throw new TypeError(UNSUPPORTED_TEXT);
      }
      bytes += unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 : 3;
    }
    points += 1;
    if (points > maxCodePoints || bytes > MAX_UTF8_BYTES) throw new RangeError(UNSUPPORTED_TEXT);
  }
}

function trimPathEnd(text: string, start: number, end: number): number {
  while (end > start && /[),.;!?\]}]/.test(text[end - 1])) end -= 1;
  return end;
}

function addMatches(candidates: Candidate[], text: string, pattern: RegExp, kind: Candidate['kind'], capture = 0): void {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index + (capture ? match[0].lastIndexOf(match[capture] ?? '') : 0);
    const value = capture ? match[capture] : match[0];
    if (!value) continue;
    let end = start + value.length;
    if (kind === 'path') end = trimPathEnd(text, start, end);
    if (end > start) candidates.push({ start, end, kind });
    // Every expression is non-empty, but keep this guard explicit if one changes.
    if (pattern.lastIndex <= match.index) pattern.lastIndex = match.index + match[0].length + 1;
  }
}

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\r\n<>:"|?*]+/g;
const UNC_PATH = /(?:\\\\|(?<!:)\/\/)[^\\/\s<>:"|?*]+[\\/][^\r\n<>:"|?*]+/g;
const POSIX_HOME_PATH = /(?:^|[\s("'=])((?:\/(?:home|Users|user|root|private|Volumes|mnt|media|tmp|var|opt)\/)[^\r\n<>"']+)/gm;
const CREDENTIAL_ASSIGNMENT = /\b(?:password|passwd|pwd|token|api[_-]?key|secret|access[_-]?key|client[_-]?secret|authorization)\b\s*[:=]\s*(["']?)([^\s"'&,;]{8,})/gi;
const KNOWN_TOKEN = /\b(?:[sr]k[_-](?:live|test|ant|proj|svcacct)[_-]|gh[pousr]_|github_pat[_-]|xox[baprs]-)[A-Za-z0-9_-]{10,}\b|\bAKIA[0-9A-Z]{16}\b|\bAIza[A-Za-z0-9_-]{30,}\b/g;

const KIND_ORDER: Record<Candidate['kind'], number> = { path: 0, credential: 1, 'private-key': 2 };

function collectDetails(text: string): SensitiveDescriptionDetail[] {
  const candidates: Candidate[] = [];
  addMatches(candidates, text, PRIVATE_KEY, 'private-key');
  addMatches(candidates, text, WINDOWS_PATH, 'path');
  addMatches(candidates, text, UNC_PATH, 'path');
  addMatches(candidates, text, POSIX_HOME_PATH, 'path', 1);
  addMatches(candidates, text, CREDENTIAL_ASSIGNMENT, 'credential', 2);
  addMatches(candidates, text, KNOWN_TOKEN, 'credential');
  candidates.sort((left, right) => left.start - right.start || right.end - left.end || KIND_ORDER[right.kind] - KIND_ORDER[left.kind]);

  const merged: Candidate[] = [];
  for (const candidate of candidates) {
    const previous = merged[merged.length - 1];
    if (previous && candidate.start < previous.end) {
      previous.end = Math.max(previous.end, candidate.end);
      if (KIND_ORDER[candidate.kind] > KIND_ORDER[previous.kind]) previous.kind = candidate.kind;
    } else {
      merged.push({ ...candidate });
    }
  }
  return merged.map(({ start, end, kind }) => Object.freeze({ start, end, kind }));
}

/** Finds obvious local paths, PEM private-key blocks, and credential-like values. */
export function findSensitiveDescriptionDetails(text: string): readonly SensitiveDescriptionDetail[] {
  validateText(text);
  return Object.freeze(collectDetails(text));
}

/** Replaces only detected spans; all text outside those spans is preserved exactly. */
export function removeSensitiveDescriptionDetails(text: string, replacement: string): string {
  validateText(text);
  validateText(replacement, MAX_REPLACEMENT_CODE_POINTS);
  const details = collectDetails(text);
  if (details.length === 0) return text;

  const parts: string[] = [];
  let cursor = 0;
  for (const detail of details) {
    parts.push(text.slice(cursor, detail.start), replacement);
    cursor = detail.end;
  }
  parts.push(text.slice(cursor));
  const result = parts.join('');
  validateText(result);
  return result;
}
