/**
 * Revision parser: finds board and document revisions in names, titles and title blocks, and orders them within one scheme.
 *
 * Forms read (case-insensitive, each must stand alone: no letter or digit touches it):
 *  - a label word and a value: "REV A", "Rev.B", "REV: 02", "REVISION 1.0", "REV_A1", and the joined forms "REVA", "REV1.0";
 *  - a revision that belongs to a board number: the "-A" of "820-01234-A" and the "-MB-A02" of an Inventec code;
 *  - "R" and a dotted number: "R1.0", "R2.1" ("R1" alone is a reference designator and is not read);
 *  - the build stages EVT, DVT, PVT and FVT with an optional number ("EVT2", "DVT-1"), and "MP" on its own;
 *  - a version: "V2.5", "V1", "VER 3", "VERSION 1.2";
 *  - a board word and a single letter: "MLB-A", "MB_B", "MAINBOARD C".
 *
 * Every result carries a scheme and a rank. The schemes are `letter` (A, B, AB), `alnum` (A01, B2), `number` (1, 2, 1.0, 2.1.3),
 * `stage` (EVT before DVT before PVT before MP) and `version` (V2.5). Two revisions can only be ordered when they are in the
 * same scheme (`compareRevisions`); across schemes the order is unknown and the caller says so. Normalised forms drop leading
 * zeros ("REV 02" is "2", "A01" is "A1").
 *
 * Linear time: one pass over the alphanumeric runs of the text; each run is looked at a constant number of times and the
 * value after a label is at most 8 characters. At most `MAX_TEXT_LENGTH` units are read and `MAX_MATCHES` results returned.
 */
import { MAX_MATCHES, foldedAt, isAlnumCode, isDigitCode, isLetterCode, scanLength, tick, type RecognitionScope, type WorkMeter } from './chars';
import { recognizeBoardNumbers } from './board-numbers';

export type RevisionScheme = 'letter' | 'alnum' | 'number' | 'stage' | 'version';
export type RevisionBasis = 'label' | 'joined-label' | 'dotted-r' | 'stage' | 'version-label' | 'version' | 'board-word' | 'board-number';

export interface RevisionMatch {
  /** The revision value as written ("A", "1.0", "EVT2"). */
  raw: string;
  /** Upper case; leading zeros dropped ("02" gives "2", "A01" gives "A1"); a version keeps its "V". */
  normalized: string;
  scheme: RevisionScheme;
  /** Sort key within the scheme; compare with `compareRevisions`. */
  rank: number[];
  basis: RevisionBasis;
  /** 0..100 */
  confidence: number;
  /** Span `[start, end)` of the evidence in the text, label included. */
  start: number;
  end: number;
}

export interface RevisionOptions {
  /** Where the text comes from; default 'name'. Used for the revisions that belong to board numbers. */
  scope?: RecognitionScope;
  /** Counts the characters examined (for tests). */
  meter?: WorkMeter;
}

const MAX_RUN = 32;
const STAGES: Readonly<Record<string, number>> = { EVT: 1, DVT: 2, FVT: 3, PVT: 4, MP: 5 };
/** Two-letter words that must not read as a revision ("REV IS ..."). */
const WORDS: ReadonlySet<string> = new Set(['AN', 'AS', 'AT', 'BE', 'BY', 'DO', 'GO', 'HE', 'IF', 'IN', 'IS', 'IT', 'ME', 'MY', 'NO', 'OF', 'ON', 'OR', 'SO', 'TO', 'UP', 'US', 'WE']);
const BOARD_WORDS: ReadonlySet<string> = new Set(['MLB', 'MB', 'MAINBOARD', 'MOTHERBOARD']);

const stripZeros = (digits: string): string => { const value = String(Number(digits)); return value === 'NaN' ? digits : value; };
const base26 = (letters: string): number => (letters.length === 2 ? 26 * (letters.charCodeAt(0) - 64) + (letters.charCodeAt(1) - 64) : letters.charCodeAt(0) - 64);

interface Run { start: number; end: number; text: string }

/** The folded alphanumeric run that starts at `pos`, at most MAX_RUN long (longer runs have text ''). */
function runAt(text: string, length: number, pos: number): Run {
  let end = pos;
  let out = '';
  while (end < length) {
    const code = foldedAt(text, end, length);
    if (!isAlnumCode(code)) break;
    if (out.length <= MAX_RUN) out += String.fromCharCode(code);
    end++;
  }
  return { start: pos, end, text: out.length > MAX_RUN ? '' : out };
}

interface Value { end: number; raw: string; normalized: string; scheme: RevisionScheme; rank: number[] }

/** Reads a revision value at `pos`: digits with dotted groups, one or two letters, or letters and digits. Null when the text is not one. */
function readValue(text: string, length: number, pos: number): Value | null {
  const run = runAt(text, length, pos);
  const value = run.text;
  if (value === '' || value.length > 8) return null;
  let letters = 0;
  while (letters < value.length && isLetterCode(value.charCodeAt(letters))) letters++;
  if (letters === 0) {
    // digits, maybe with dotted groups
    if (value.length > 3 || !/^[0-9]+$/.test(value)) return null;
    const parts = [stripZeros(value)];
    let end = run.end;
    while (parts.length < 3 && foldedAt(text, end, length) === 46 && isDigitCode(foldedAt(text, end + 1, length))) {
      const next = runAt(text, length, end + 1);
      if (next.text === '' || next.text.length > 3 || !/^[0-9]+$/.test(next.text)) break;
      parts.push(stripZeros(next.text));
      end = next.end;
    }
    return { end, raw: text.slice(pos, end), normalized: parts.join('.'), scheme: 'number', rank: parts.map(Number) };
  }
  if (letters > 2) return null;
  const letterPart = value.slice(0, letters), digitPart = value.slice(letters);
  if (digitPart === '') {
    if (letters === 2 && WORDS.has(letterPart)) return null;
    return { end: run.end, raw: text.slice(pos, run.end), normalized: letterPart, scheme: 'letter', rank: [base26(letterPart)] };
  }
  if (digitPart.length > 2 || !/^[0-9]+$/.test(digitPart)) return null;
  return { end: run.end, raw: text.slice(pos, run.end), normalized: letterPart + stripZeros(digitPart), scheme: 'alnum', rank: [base26(letterPart), Number(digitPart)] };
}

/** Skips up to three separator characters (blank . _ - :) after a label; returns the new position. */
function skipSeparators(text: string, length: number, pos: number): number {
  let at = pos, count = 0;
  while (count < 3) {
    const code = foldedAt(text, at, length);
    if (code === 32 || code === 46 || code === 95 || code === 45 || code === 58) { at++; count++; } else break;
  }
  return at;
}

/**
 * Reads the revisions in `text`, sorted by position. Total: any input gives an array.
 */
export function parseRevisions(text: string, options: RevisionOptions = {}): RevisionMatch[] {
  const length = scanLength(text);
  if (length === 0) return [];
  const meter = options.meter;
  const found: RevisionMatch[] = [];
  const add = (match: RevisionMatch): void => { if (found.length < MAX_MATCHES) found.push(match); };

  let index = 0;
  while (index < length && found.length < MAX_MATCHES) {
    const code = foldedAt(text, index, length);
    if (!isAlnumCode(code)) { index++; tick(meter); continue; }
    const run = runAt(text, length, index);
    tick(meter, run.end - index + 1);
    const word = run.text;
    let consumed = run.end;
    if (word !== '') {
      if (word === 'REV' || word === 'REVISION') {
        const at = skipSeparators(text, length, run.end);
        const value = at > run.end || foldedAt(text, run.end, length) === -1 ? readValue(text, length, at) : null;
        if (value) {
          add({ raw: value.raw, normalized: value.normalized, scheme: value.scheme, rank: value.rank, basis: 'label', confidence: value.scheme === 'alnum' ? 85 : 90, start: index, end: value.end });
          consumed = value.end;
        }
      } else if (word.length > 3 && word.startsWith('REV') && word !== 'REVISION') {
        const value = readValue(text, length, index + 3);
        if (value) {
          add({ raw: value.raw, normalized: value.normalized, scheme: value.scheme, rank: value.rank, basis: 'joined-label', confidence: 80, start: index, end: value.end });
          consumed = value.end;
        }
      } else if (word.length >= 2 && word.length <= 3 && word.charCodeAt(0) === 82 && /^R[0-9]{1,2}$/.test(word) && foldedAt(text, run.end, length) === 46 && isDigitCode(foldedAt(text, run.end + 1, length))) {
        const value = readValue(text, length, index + 1);
        if (value && value.scheme === 'number') {
          add({ raw: value.raw, normalized: value.normalized, scheme: 'number', rank: value.rank, basis: 'dotted-r', confidence: 70, start: index, end: value.end });
          consumed = value.end;
        }
      } else if (word === 'MP') {
        add({ raw: 'MP', normalized: 'MP', scheme: 'stage', rank: [STAGES.MP, 0], basis: 'stage', confidence: 50, start: index, end: run.end });
      } else if (/^(?:EVT|DVT|PVT|FVT)[0-9]{0,2}$/.test(word)) {
        const stage = word.slice(0, 3), number = word.slice(3);
        let end = run.end, digits = number;
        if (digits === '') {
          const sep = foldedAt(text, run.end, length);
          if (sep === 45 || sep === 95 || sep === 32) {
            const next = runAt(text, length, run.end + 1);
            if (next.text !== '' && next.text.length <= 2 && /^[0-9]+$/.test(next.text)) { digits = next.text; end = next.end; }
          }
        }
        add({ raw: text.slice(index, end), normalized: stage + (digits === '' ? '' : stripZeros(digits)), scheme: 'stage', rank: [STAGES[stage], digits === '' ? 0 : Number(digits)], basis: 'stage', confidence: 80, start: index, end });
        consumed = end;
      } else if (word === 'VER' || word === 'VERSION') {
        const at = skipSeparators(text, length, run.end);
        const value = at > run.end ? readValue(text, length, at) : null;
        if (value && value.scheme === 'number') {
          add({ raw: value.raw, normalized: 'V' + value.normalized, scheme: 'version', rank: value.rank, basis: 'version-label', confidence: 70, start: index, end: value.end });
          consumed = value.end;
        }
      } else if (/^V[0-9]{1,3}$/.test(word)) {
        const value = readValue(text, length, index + 1);
        if (value && value.scheme === 'number') {
          add({ raw: text.slice(index, value.end), normalized: 'V' + value.normalized, scheme: 'version', rank: value.rank, basis: 'version', confidence: value.rank.length > 1 ? 60 : 40, start: index, end: value.end });
          consumed = value.end;
        }
      } else if (BOARD_WORDS.has(word)) {
        const sep = foldedAt(text, run.end, length);
        if (sep === 45 || sep === 95 || sep === 32) {
          const next = runAt(text, length, run.end + 1);
          if (next.text.length === 1 && isLetterCode(next.text.charCodeAt(0)) && foldedAt(text, next.end, length) !== 46) {
            add({ raw: next.text, normalized: next.text, scheme: 'letter', rank: [base26(next.text)], basis: 'board-word', confidence: 55, start: index, end: next.end });
            consumed = next.end;
          }
        }
      }
    }
    index = Math.max(consumed, index + 1);
  }

  // Revisions written as part of a board number ("820-01234-A").
  for (const number of recognizeBoardNumbers(text, { scope: options.scope, meter })) {
    if (number.revision === undefined || found.length >= MAX_MATCHES) continue;
    const revision = number.revision;
    const letters = /^[A-Z]+$/.test(revision), single = letters && revision.length <= 2;
    const value = single ? null : readValue(revision, revision.length, 0);
    const scheme: RevisionScheme = single ? 'letter' : value?.scheme ?? 'alnum';
    const rank = single ? [base26(revision)] : value?.rank ?? [0];
    found.push({ raw: revision, normalized: single ? revision : value?.normalized ?? revision, scheme, rank, basis: 'board-number', confidence: Math.min(80, number.confidence), start: number.start, end: number.end });
  }

  found.sort((a, b) => a.start - b.start || a.end - b.end);
  return found;
}

/** The most confident revision (then the first), or undefined. */
export function bestRevision(matches: readonly RevisionMatch[]): RevisionMatch | undefined {
  let best: RevisionMatch | undefined;
  for (const match of matches) if (!best || match.confidence > best.confidence) best = match;
  return best;
}

/** A key that is equal for equal revisions of one scheme: "letter:A", "number:1.0", "stage:EVT2". */
export function revisionKey(revision: Pick<RevisionMatch, 'scheme' | 'normalized'>): string {
  return `${revision.scheme}:${revision.normalized}`;
}

/**
 * Orders two revisions: negative when `a` is older, positive when newer, 0 when equal. Returns undefined when the revisions
 * are in different schemes, because their order cannot be known from the text (the caller shows "order unknown" and may use
 * the file's modification time as a labelled hint).
 */
export function compareRevisions(a: Pick<RevisionMatch, 'scheme' | 'rank'>, b: Pick<RevisionMatch, 'scheme' | 'rank'>): number | undefined {
  if (a.scheme !== b.scheme) return undefined;
  const size = Math.max(a.rank.length, b.rank.length);
  for (let index = 0; index < size; index++) {
    const left = a.rank[index] ?? 0, right = b.rank[index] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
