/*
 * Names of the synthetic library: file and folder names in the styles of a technician's collection (board numbers, model names,
 * opaque dump names, dates, copies), name decoration (spaces, case, unicode, "(1)", "copy", very long names), a path book that keeps
 * every path valid and unique on case-insensitive file systems, and the detection of what a name gives away about its family.
 */
import type { Evidence } from './ground-truth.ts';
import type { Rng } from './rng.ts';
import { DEVICE_WORDS, FOLDER_WORDS, OPAQUE_STEMS, ROLE_WORDS } from './words.ts';
import type { DeviceType } from './words.ts';

/** Case and diacritics folded away, everything but letters and digits removed: the form in which names are compared. */
export function foldForMatch(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface NamedFamily { vendor: string; model: string; boardNumber: string; deviceType: DeviceType }

/** What a path says about a family: the board number or the model in the file name, or in a folder name. */
export function nameEvidence(segments: readonly string[], family: NamedFamily): Evidence[] {
  const number = foldForMatch(family.boardNumber), model = foldForMatch(family.model), vendor = foldForMatch(family.vendor);
  const out: Evidence[] = [];
  const file = foldForMatch(segments[segments.length - 1]);
  const folders = segments.slice(0, -1).map(foldForMatch);
  if (number.length >= 5 && file.includes(number)) out.push('name-id');
  if (model.length >= 5 && file.includes(model)) out.push('name-model');
  if (number.length >= 5 && folders.some(folder => folder.includes(number))) out.push('folder-id');
  if (model.length >= 5 && folders.some(folder => folder.includes(model))) out.push('folder-model');
  if (!out.includes('name-model') && !out.includes('folder-model') && vendor.length >= 5 && model.length >= 3 && folders.some(folder => folder.includes(vendor) && folder.includes(foldForMatch(family.model.split(' ')[0])))) out.push('folder-model');
  return out;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A segment that is valid on Windows, macOS and Linux and at most 200 characters. */
export function sanitizeSegment(text: string): string {
  let out = text.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').replace(/^ +/, '');
  if (!out) out = '_';
  if (RESERVED.test(out.split('.')[0])) out = `_${out}`;
  if (out.length > 200) out = out.slice(0, 200).replace(/[. ]+$/, '');
  return out;
}

const keyOf = (text: string): string => text.normalize('NFC').toLowerCase();

/** Hands out paths that never collide, also when file names differ only in case or in Unicode normalisation. */
export class PathBook {
  #dirs = new Map<string, string>();
  #names = new Map<string, Set<string>>();

  /** The spelling the first user of this folder chose, so "Alder" and "ALDER" never become two folders. */
  directory(segments: readonly string[]): string[] {
    const out: string[] = [];
    let key = '';
    for (const raw of segments) {
      const segment = sanitizeSegment(raw);
      key += `/${keyOf(segment)}`;
      const known = this.#dirs.get(key);
      if (known) out.push(known); else { this.#dirs.set(key, segment); out.push(segment); }
    }
    return out;
  }

  /** A unique file path below the directory: " (2)", " (3)" ... is added before the extension on a clash. */
  file(directory: readonly string[], name: string): string[] {
    const dir = this.directory(directory);
    const dirKey = dir.map(keyOf).join('/');
    const used = this.#names.get(dirKey) ?? this.#names.set(dirKey, new Set()).get(dirKey)!;
    let candidate = sanitizeSegment(name);
    const dot = candidate.lastIndexOf('.');
    const stem = dot > 0 ? candidate.slice(0, dot) : candidate, extension = dot > 0 ? candidate.slice(dot) : '';
    for (let n = 2; used.has(keyOf(candidate)); n++) candidate = sanitizeSegment(`${stem} (${n})${extension}`);
    used.add(keyOf(candidate));
    return [...dir, candidate];
  }

  has(segments: readonly string[]): boolean {
    const dir = this.directory(segments.slice(0, -1));
    return (this.#names.get(dir.map(keyOf).join('/')) ?? new Set()).has(keyOf(segments[segments.length - 1]));
  }
}

// ---- name styles -------------------------------------------------------------------------------------------------------------

export type NameStyle = 'number' | 'model-number' | 'vendor-model-role' | 'model-role' | 'opaque' | 'date-model';

export interface NameParts {
  boardNumber: string;
  /** Revision as written into names ("rev B", "R1.1"), or empty. */
  revision: string;
  vendor: string;
  model: string;
  /** Word for the role ("schematic", "boardview"). */
  role: string;
  /** YYYY-MM-DD for dated names. */
  date: string;
}

const SEPARATORS = [' ', '_', '-', '.', ' - '];

export function pickStyle(rng: Rng, role: string): NameStyle {
  const weights: Record<string, ReadonlyArray<readonly [NameStyle, number]>> = {
    board: [['number', 35], ['model-number', 20], ['vendor-model-role', 20], ['model-role', 10], ['opaque', 10], ['date-model', 5]],
    schematic: [['number', 30], ['model-number', 20], ['vendor-model-role', 20], ['model-role', 15], ['opaque', 10], ['date-model', 5]],
    firmware: [['number', 35], ['model-role', 35], ['opaque', 20], ['vendor-model-role', 10]],
    photo: [['opaque', 70], ['model-role', 30]],
  };
  return rng.weighted(weights[role] ?? [['model-role', 50], ['vendor-model-role', 30], ['opaque', 20]]);
}

/** The stem of a file name (no extension) in the given style. */
export function composeStem(style: NameStyle, parts: NameParts, rng: Rng, index: number): string {
  const sep = rng.pick(SEPARATORS);
  const join = (...items: string[]): string => items.filter(Boolean).join(sep);
  let stem: string;
  switch (style) {
    case 'number': stem = join(parts.boardNumber, parts.revision); break;
    case 'model-number': stem = join(parts.model, parts.boardNumber, parts.revision); break;
    case 'vendor-model-role': stem = join(parts.vendor, parts.model, parts.role, parts.revision); break;
    case 'model-role': stem = join(parts.model, parts.role); break;
    case 'date-model': stem = join(parts.date, parts.model, parts.role); break;
    default: stem = `${rng.pick(OPAQUE_STEMS)}${rng.pick([' ', '_', ''])}${index > 0 ? index : rng.int(1, 99)}`;
  }
  const casing = rng.weighted([['keep', 60], ['upper', 15], ['lower', 20], ['camel', 5]] as const);
  if (casing === 'upper') stem = stem.toUpperCase();
  else if (casing === 'lower') stem = stem.toLowerCase();
  else if (casing === 'camel') stem = stem.replace(/[ _.-]+/g, '');
  return stem;
}

const ACCENTS: Readonly<Record<string, string>> = { e: 'é', o: 'ő', u: 'ü', a: 'á', i: 'í' };

/** Replaces some letters by accented ones (the folded form is unchanged, the exact string is). */
export function accentuate(text: string, rng: Rng): string {
  let changed = false;
  const out = text.replace(/[eouai]/g, letter => { if (!changed || rng.chance(0.3)) { changed = true; return ACCENTS[letter]; } return letter; });
  return out;
}

export type Decoration = 'none' | 'number' | 'copy' | 'copy-of' | 'long' | 'unicode' | 'bidi';

/** Decoration of a copied or sloppy name; `long` pads to about 200 characters in total, `bidi` hides a direction override in the stem. */
export function decorateStem(stem: string, decoration: Decoration, rng: Rng, extensionLength: number): string {
  switch (decoration) {
    case 'number': return `${stem} (${rng.int(1, 4)})`;
    case 'copy': return `${stem} - Copy`;
    case 'copy-of': return `Copy of ${stem}`;
    case 'unicode': return accentuate(stem, rng);
    case 'bidi': return `${stem}‮txt.fdp`;
    case 'long': {
      let out = stem;
      while (out.length < 200 - extensionLength - 12) out += `_${rng.pick(FOLDER_WORDS).replace(/ /g, '_')}`;
      return out.slice(0, 200 - extensionLength);
    }
    default: return stem;
  }
}

export function styleExtension(extension: string, rng: Rng): string {
  if (!extension) return extension;
  const roll = rng.next();
  if (roll < 0.08) return extension.toUpperCase();
  if (roll < 0.11) return extension[0] + extension[1].toUpperCase() + extension.slice(2);
  return extension;
}

export function roleWord(role: string, rng: Rng): string {
  return rng.pick(ROLE_WORDS[role] ?? ['file']).replace(/ /g, rng.pick([' ', '_']));
}

export function deviceWord(type: DeviceType, rng: Rng): string { return rng.pick(DEVICE_WORDS[type]); }

/** Year folder names and month names for "by year" collections. */
export const MONTHS: readonly string[] = ['01 January', '02 February', '03 March', '04 April', '05 May', '06 June', '07 July', '08 August', '09 September', '10 October', '11 November', '12 December'];
