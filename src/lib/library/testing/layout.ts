/*
 * Folder layouts of the synthetic library. A library is a handful of collections (drives, backup folders, a download dump), each
 * with its own way of ordering families: by vendor, by model, by file type, by board number, by year, as a flat dump or buried in a
 * deep chain of folders. Every family picks a collection, and every file gets its folder from the collection's style and its role.
 */
import type { Rng } from './rng.ts';
import type { NamedFamily } from './names.ts';
import { FOLDER_WORDS, MODEL_NUMBERS } from './words.ts';
import { MONTHS } from './names.ts';

export const LAYOUT_STYLES = ['by-vendor', 'by-model', 'by-type', 'by-number', 'by-year', 'flat-dump', 'deep'] as const;
export type LayoutStyle = (typeof LAYOUT_STYLES)[number];

export interface Collection {
  id: number;
  /** Folders above everything the collection holds. */
  root: string[];
  style: LayoutStyle;
  /** Share of a family's files that are copied to another folder of the collection (0.10 to 0.30). */
  duplicateRate: number;
  /** Folder for copies ("Backup", "Old"). */
  copyFolder: string;
  /** The collection has role sub-folders ("Boardview", "Schematics") below the family folder. */
  roleFolders: boolean;
}

const ROOTS: ReadonlyArray<readonly string[]> = [
  ['Drive D', 'Repair files'], ['Work'], ['Downloads'], ['Backup', 'Old disk'], ['Repair files', 'Boards'], ['Stuff'], ['Misc'], ['Customers'], ['Drive E'], ['New folder'],
];

const ROLE_FOLDERS: Readonly<Record<string, readonly string[]>> = {
  board: ['Boardview', 'Boardviews', 'Board files', 'BV', 'boards'],
  schematic: ['Schematics', 'Schematic', 'Schemas', 'SCH'],
  'board-pdf': ['Boardview PDF', 'Layout', 'PCB layout'],
  datasheet: ['Datasheets', 'Datasheet', 'DS'],
  'service-manual': ['Manuals', 'Service manuals'],
  bom: ['BOM', 'Parts lists'],
  photo: ['Photos', 'Pics', 'Board photos'],
  firmware: ['BIOS', 'Firmware', 'EC'],
  archive: ['Downloads', 'Zips'],
  other: ['Misc'],
};

export function makeCollections(rng: Rng, count: number): Collection[] {
  const roots = rng.shuffle(ROOTS);
  const styles = rng.shuffle(LAYOUT_STYLES);
  return Array.from({ length: count }, (_, id) => {
    const root = roots[id % roots.length];
    // the first collections take every style once, so a set of seven or more has them all; later ones are drawn
    const style = id < styles.length ? styles[id] : rng.weighted<LayoutStyle>([['by-vendor', 24], ['by-model', 20], ['by-type', 14], ['by-number', 12], ['by-year', 8], ['flat-dump', 10], ['deep', 5]]);
    return {
      id, root: id >= roots.length ? [...root, `Part ${id + 1}`] : [...root], style, duplicateRate: 0.1 + rng.next() * 0.2, copyFolder: rng.pick(['Backup', 'Old', 'Copy', 'Archive', 'Before cleanup']),
      roleFolders: rng.chance(0.65),
    };
  });
}

/** A chain of short folder names, 6 to 20 deep, shared by every family of a deep collection. */
export function deepChain(rng: Rng): string[] {
  const depth = rng.int(6, 16);
  return Array.from({ length: depth }, (_, i) => (i % 3 === 0 ? rng.pick(FOLDER_WORDS) : `${rng.pick(['a', 'b', 'x', 'dir', 'f'])}${rng.int(1, 99)}`));
}

export interface PlaceInput {
  family: NamedFamily & { year: number; month: number };
  role: string;
  collection: Collection;
  /** The chain of a 'deep' collection. */
  chain: readonly string[];
  /** Adds "2nd copy" style variation to the folder. */
  alt?: boolean;
}

/** The folders of a file of the given role in a collection (below the library root). */
export function placeFolder(input: PlaceInput, rng: Rng): string[] {
  const { family, role, collection } = input;
  const sub = collection.roleFolders ? [rng.pick(ROLE_FOLDERS[role] ?? ROLE_FOLDERS.other)] : [];
  const model = `${family.model}`;
  switch (collection.style) {
    case 'by-vendor': return [...collection.root, family.vendor, model, ...sub];
    case 'by-model': return [...collection.root, `${family.vendor} ${model}`, ...(rng.chance(0.3) ? sub : [])];
    case 'by-type': return [...collection.root, rng.pick(ROLE_FOLDERS[role] ?? ROLE_FOLDERS.other)];
    case 'by-number': return [...collection.root, family.boardNumber, ...(rng.chance(0.5) ? sub : [])];
    case 'by-year': return [...collection.root, String(family.year), MONTHS[family.month - 1], model];
    case 'flat-dump': return [...collection.root, 'To sort'];
    default: return [...collection.root, ...input.chain, family.vendor, model, ...sub];
  }
}

/** A different folder of the collection, for a copy: the copy folder, below the file's original place or at the root. */
export function copyFolderOf(original: readonly string[], collection: Collection, rng: Rng): string[] {
  const roll = rng.next();
  if (roll < 0.45) return [...collection.root, collection.copyFolder];
  if (roll < 0.8) return [...original, collection.copyFolder];
  return [...collection.root, collection.copyFolder, rng.pick(FOLDER_WORDS)];
}

/** A generic model suffix such as "14" or "200" used to make sibling names. */
export const modelNumber = (rng: Rng): string => rng.pick(MODEL_NUMBERS);
