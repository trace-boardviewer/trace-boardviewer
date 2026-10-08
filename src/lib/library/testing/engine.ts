/*
 * The engine under the library generator: contents (distinct bytes, rebuilt on demand and cached), files and archive members with
 * their records, the path book, the budget counters and the sink the bytes go to. Families (families.ts) and the hostile and
 * filler files (chaos.ts) only talk to this class.
 */
import type { Evidence, ItemFlag, LibraryKind, Role } from './ground-truth.ts';
import type { Content, Item, Union } from './records.ts';
import type { NamedFamily } from './names.ts';
import { PathBook, nameEvidence } from './names.ts';
import type { ResolvedOptions } from './presets.ts';
import type { Rng } from './rng.ts';
import { createRng } from './rng.ts';
import type { Hasher } from './sha256.ts';
import { sha256Hex } from './sha256.ts';
import type { ZipEntry } from './zip.ts';
import { buildZip, zeroBombEntry } from './zip.ts';

/** Receives the files of the library as they are made. `bytes` is only valid during the call. */
export interface LibrarySink {
  writeFile(file: { path: readonly string[]; bytes: Uint8Array; mtimeMs: number }): void;
}

export interface ContentSpec {
  kind: LibraryKind;
  format: string | null;
  variant?: string;
  role: Role;
  familyId: string | null;
  revision: string | null;
  flags?: ItemFlag[];
  idEvidence?: 'header-id' | 'title-id';
  fingerprint?: string;
  pinSetSize?: number;
  partNumbers?: string[];
  decoys?: string[];
  refCount?: number;
  coverage?: number;
  pages?: number;
  needsKey?: 'fz' | 'xzz';
  evidence?: Evidence[];
  /** Pure: the same bytes every time it is called. */
  build(): Uint8Array;
  /** Bytes already made by the caller (the first `bytesOf` uses them instead of calling `build`). */
  prebuilt?: Uint8Array;
}

export interface ItemSpec {
  dir: readonly string[];
  name: string;
  content: Content;
  familyId: string | null;
  revision: string | null;
  role: Role;
  flags?: ItemFlag[];
  mtimeMs: number;
  /** The family the names are compared with (for name evidence). */
  named?: NamedFamily | null;
  override?: Item['override'];
}

export interface ArchiveEntrySpec {
  /** The entry name as it is stored in the archive (hostile names stay as they are). */
  name: string;
  content?: Content;
  /** A bomb entry that inflates to this many MiB of zeros (never built or hashed). */
  bombMiB?: number;
  /** Stored with the "encrypted" flag; `content` holds the ciphertext. */
  encrypted?: boolean;
  familyId?: string | null;
  revision?: string | null;
  role?: Role;
  flags?: ItemFlag[];
  /** An archive inside the archive: its members are listed but never opened. */
  nested?: Array<{ name: string; content: Content; familyId?: string | null; revision?: string | null; role?: Role; flags?: ItemFlag[] }>;
}

export interface ArchiveSpec {
  dir: readonly string[];
  name: string;
  entries: ArchiveEntrySpec[];
  familyId: string | null;
  revision: string | null;
  flags?: ItemFlag[];
  mtimeMs: number;
  named?: NamedFamily | null;
  comment?: string;
  /** The end of the file is missing (an interrupted download). */
  truncateTail?: boolean;
}

const CACHE_BYTES_DISK = 128 * 1024 * 1024;

const UPPER = /[A-Z]/;
/** Flags a path earns by itself. */
export function nameFlags(segments: readonly string[]): ItemFlag[] {
  const flags = new Set<ItemFlag>();
  const last = segments[segments.length - 1];
  const dot = last.lastIndexOf('.');
  if (dot <= 0) flags.add('no-extension');
  else if (UPPER.test(last.slice(dot))) flags.add('upper-case-extension');
  if (last.length >= 120) flags.add('long-name');
  if (segments.some(segment => /[^\x00-\x7f]/.test(segment))) flags.add('unicode-name');
  if (segments.some(segment => /[\u202a-\u202e\u2066-\u2069]/.test(segment))) flags.add('bidi-name');
  if (segments.length - 1 >= 10) flags.add('deep-path');
  if (last.startsWith('.') && last !== '.') flags.add('hidden-file');
  if (segments.some(segment => ['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information'].includes(segment))) flags.add('excluded-folder');
  return [...flags];
}

/** Longest relative path (below the library root, "/" separated) the generator writes. */
export const MAX_RELATIVE_PATH = 250;

/** The name, with its stem cut short when the whole path would be longer than MAX_RELATIVE_PATH. */
function fitName(dir: readonly string[], name: string): string {
  const room = MAX_RELATIVE_PATH - dir.reduce((sum, part) => sum + part.length + 1, 0) - 6; // 6: room for " (99)"
  if (name.length <= room) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  const stem = (dot > 0 ? name.slice(0, dot) : name).slice(0, Math.max(4, room - extension.length)).replace(/[. ]+$/, '');
  return (stem || 'file') + extension;
}

export class Engine {
  readonly options: ResolvedOptions;
  readonly root: Rng;
  readonly contents = new Map<number, Content>();
  readonly items: Item[] = [];
  readonly unions: Union[] = [];
  readonly resaved: Array<[number, number]> = [];
  readonly paths = new PathBook();
  /** Files on disk so far (archives count once, members not at all). */
  diskFiles = 0;
  diskBytes = 0;
  /** Files the current phase may still add up to (a total, not a remainder). */
  limit = 0;
  /** Size scale of the next family (see library.ts); 1 is a board of about 150 parts. */
  scale = 1;
  readonly hash: Hasher;
  readonly sink: LibrarySink;
  readonly keepAll: boolean;
  #nextContent = 1;
  #cache = new Map<number, Uint8Array>();
  #cacheBytes = 0;
  #prebuilt = new Map<number, Uint8Array>();
  #cacheLimit: number;

  constructor(options: ResolvedOptions, sink: LibrarySink, cacheBytes = CACHE_BYTES_DISK) {
    this.options = options;
    this.root = createRng(options.seed);
    this.hash = options.hasher ?? sha256Hex;
    this.sink = sink;
    this.#cacheLimit = cacheBytes;
    this.keepAll = cacheBytes === Infinity;
  }

  hasRoom(count = 1): boolean { return this.diskFiles + count <= this.limit; }

  newContent(spec: ContentSpec): Content {
    const { prebuilt, evidence, flags, ...rest } = spec;
    const content: Content = { id: this.#nextContent++, ...rest, flags: flags ?? [], evidence: new Set(evidence ?? []) };
    this.contents.set(content.id, content);
    if (prebuilt) this.#prebuilt.set(content.id, prebuilt);
    return content;
  }

  /** The bytes of a content: cached, or built; the first call fixes its size and hash, later calls check the size. */
  bytesOf(content: Content): Uint8Array {
    const hit = this.#cache.get(content.id);
    if (hit) { this.#cache.delete(content.id); this.#cache.set(content.id, hit); return hit; }
    const early = this.#prebuilt.get(content.id);
    let bytes: Uint8Array;
    if (early) { bytes = early; this.#prebuilt.delete(content.id); }
    else bytes = content.build();
    if (content.size === undefined) { content.size = bytes.length; content.sha256 = this.hash(bytes); }
    else if (content.size !== bytes.length) throw new Error(`content ${content.id} (${content.kind}) was rebuilt with another size: the generator is not deterministic`);
    this.#cache.set(content.id, bytes);
    this.#cacheBytes += bytes.length;
    for (const [id, old] of this.#cache) {
      if (this.#cacheBytes <= this.#cacheLimit || id === content.id) break;
      this.#cache.delete(id);
      this.#cacheBytes -= old.length;
    }
    return bytes;
  }

  union(a: Content, b: Content, evidence: Evidence): void { if (a.id !== b.id) this.unions.push({ a: a.id, b: b.id, evidence }); }

  /** Writes a file; returns null (and writes nothing) when the file budget is used up. */
  addFile(spec: ItemSpec): Item | null {
    if (!this.hasRoom()) return null;
    const segments = this.paths.file(spec.dir, fitName(spec.dir, spec.name));
    const bytes = this.bytesOf(spec.content);
    this.sink.writeFile({ path: segments, bytes, mtimeMs: spec.mtimeMs });
    this.diskFiles++;
    this.diskBytes += bytes.length;
    const flags = [...new Set<ItemFlag>([...(spec.flags ?? []), ...nameFlags(segments)])];
    const path = segments.join('/');
    const item: Item = {
      id: path, path, contentId: spec.content.id, familyId: spec.familyId, revision: spec.revision, role: spec.role, flags,
      nameEvidence: spec.named ? nameEvidence(segments, spec.named) : [], directory: segments.slice(0, -1).join('/'), mtimeMs: spec.mtimeMs, size: bytes.length, sha256: spec.content.sha256,
      ...(spec.override ? { override: spec.override } : {}),
    };
    this.items.push(item);
    return item;
  }

  /** Writes a ZIP archive and the records of its members. Returns null when the file budget is used up. */
  addArchive(spec: ArchiveSpec): { archive: Item; archiveContent: Content; members: Item[] } | null {
    if (!this.hasRoom()) return null;
    const planned: Array<{ entry: ArchiveEntrySpec; content: Content | null }> = [];
    const innerBytesOf = (entries: Array<{ name: string; content: Content }>): Uint8Array => buildZip(entries.map(entry => ({ name: entry.name, data: this.bytesOf(entry.content) })));
    for (const entry of spec.entries) {
      if (entry.bombMiB) planned.push({ entry, content: null });
      else if (entry.nested) {
        const nested = entry.nested;
        const inner = this.newContent({ kind: 'archive', format: 'zip', role: 'other', familyId: entry.familyId ?? null, revision: null, flags: ['nested-archive'], build: () => innerBytesOf(nested) });
        planned.push({ entry, content: inner });
      } else planned.push({ entry, content: entry.content ?? null });
    }
    const zipEntriesOf = (): ZipEntry[] => planned.map(({ entry, content }): ZipEntry => {
      if (entry.bombMiB) return zeroBombEntry(entry.name, entry.bombMiB);
      if (!content) return { name: entry.name };
      return { name: entry.name, data: this.bytesOf(content), ...(entry.nested ? { method: 'store' as const } : {}), ...(entry.encrypted ? { encrypted: true } : {}) };
    });
    const archiveContent = this.newContent({
      kind: 'archive', format: 'zip', role: 'other', familyId: spec.familyId, revision: spec.revision, flags: spec.truncateTail ? ['truncated'] : [],
      build: () => buildZip(zipEntriesOf(), { ...(spec.comment ? { comment: spec.comment } : {}), ...(spec.truncateTail ? { truncateTail: true } : {}) }),
    });
    const archive = this.addFile({ dir: spec.dir, name: spec.name, content: archiveContent, familyId: spec.familyId, revision: spec.revision, role: 'other', flags: spec.flags, mtimeMs: spec.mtimeMs, named: spec.named });
    if (!archive) return null;
    const members: Item[] = [];
    if (spec.truncateTail) return { archive, archiveContent, members };
    const archiveSegments = archive.path.split('/');
    const context = [...archiveSegments];
    for (const { entry, content } of planned) {
      const base = { container: { archive: archive.path, entry: entry.name }, directory: archive.path, mtimeMs: spec.mtimeMs };
      const memberFlags = (extra: ItemFlag[] = []): ItemFlag[] => [...new Set<ItemFlag>(['in-archive', ...(entry.flags ?? []), ...extra])];
      const safeName = (name: string): string[] => name.split(/[\\/]/).filter(part => part && part !== '.' && part !== '..' && !/^[A-Za-z]:$/.test(part));
      const evidenceFor = (family: NamedFamily | null | undefined): Evidence[] => (family ? nameEvidence([...context, ...safeName(entry.name)], family) : []);
      if (entry.bombMiB) {
        const bombContent = this.newContent({ kind: 'unknown', format: null, role: 'other', familyId: null, revision: null, flags: ['zip-bomb'], build: () => { throw new Error('a bomb entry is never built'); } });
        const declared = entry.bombMiB * 1024 * 1024;
        this.items.push({ id: `${archive.path}!/${entry.name}`, path: archive.path, ...base, contentId: bombContent.id, familyId: null, revision: null, role: 'other', flags: memberFlags(['zip-bomb']), nameEvidence: [], declaredSize: declared, size: declared, sha256: null });
        members.push(this.items[this.items.length - 1]);
        continue;
      }
      if (!content) continue;
      const record: Item = {
        id: `${archive.path}!/${entry.name}`, path: archive.path, ...base, contentId: content.id, familyId: entry.familyId ?? null, revision: entry.revision ?? null, role: entry.role ?? content.role,
        flags: memberFlags(entry.encrypted ? ['encrypted-entry'] : []), nameEvidence: evidenceFor(spec.named), size: content.size, sha256: content.sha256,
      };
      this.items.push(record);
      members.push(record);
      if (entry.nested) {
        for (const child of entry.nested) {
          const childItem: Item = {
            id: `${archive.path}!/${entry.name}!/${child.name}`, path: archive.path, container: { archive: archive.path, entry: `${entry.name}!/${child.name}` }, directory: archive.path, mtimeMs: spec.mtimeMs,
            contentId: child.content.id, familyId: child.familyId ?? null, revision: child.revision ?? null, role: child.role ?? child.content.role, flags: [...new Set<ItemFlag>(['in-archive', 'nested-archive', ...(child.flags ?? [])])],
            nameEvidence: [], unreachable: true, size: child.content.size, sha256: child.content.sha256,
          };
          this.items.push(childItem);
          members.push(childItem);
        }
      }
    }
    return { archive, archiveContent, members };
  }
}
