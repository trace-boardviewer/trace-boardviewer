/*
 * The format registry (original TRACE module, MIT): the single source for every derived format table.
 *
 * Adapters are discovered at build time from src/lib/formats/adapters/<id>/index.ts (Vite's import.meta.glob, eager), so a
 * new reader is registered by adding its folder and nothing else. Derived from this module:
 *   BOARD_ADAPTERS / FORMAT_CAPABILITIES   the board adapters and their capability records (dispatcher, support table, tests)
 *   CONTAINER_ADAPTERS / CONTAINER_CAPABILITIES   archives a board may arrive in (ZIP)
 *   BOARD_EVIDENCE                         real-file evidence overlays for docs/SUPPORT.md
 *   SUPPORTED_EXTENSIONS, companionNames   what the renderer offers and gathers
 *   buildFormatsManifest()                 electron/formats.json for the main process (registry.test.ts fails on drift)
 * Detection never depends on the order here: the dispatcher ranks adapters by their sniff confidence.
 */
import { ADAPTER_API_VERSION, DIALOG_FAMILIES, type BoardAdapter, type ContainerAdapter, type ContainerCapability, type FormatAdapter, type FormatCapability, type RealFileEvidence } from './adapter';

const EXTENSION = /^\.[a-z0-9_]+$/, ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/, COMPANION = /^@?[a-z0-9_][a-z0-9_. -]*$/;

const modules = import.meta.glob<FormatAdapter>('./adapters/*/index.ts', { eager: true, import: 'default' });

/** Structural checks that must hold for the application to start; the semantic rules (collisions, status evidence) live in registry.test.ts. */
export function validateAdapters(entries: ReadonlyArray<readonly [string, FormatAdapter]>): FormatAdapter[] {
  const ids = new Set<string>(), adapters: FormatAdapter[] = [];
  for (const [path, adapter] of entries) {
    const folder = /(?:^|\/)adapters\/([^/]+)\/index\.ts$/.exec(path)?.[1];
    if (!adapter || typeof adapter !== 'object' || adapter.apiVersion !== ADAPTER_API_VERSION) throw new Error(`format registry: ${path} must default-export defineBoardAdapter(...) or defineContainerAdapter(...).`);
    if (!ID.test(adapter.id) || folder !== adapter.id) throw new Error(`format registry: adapter id "${adapter.id}" must be lowercase and equal its folder name (${folder}).`);
    if (ids.has(adapter.id)) throw new Error(`format registry: duplicate adapter id ${adapter.id}.`);
    ids.add(adapter.id);
    if (!adapter.extensions.length || adapter.extensions.some(extension => !EXTENSION.test(extension)) || new Set(adapter.extensions).size !== adapter.extensions.length) {
      throw new Error(`format registry: ${adapter.id} needs unique lowercase extensions with a leading dot.`);
    }
    if (!(DIALOG_FAMILIES as readonly string[]).includes(adapter.family)) throw new Error(`format registry: ${adapter.id} has an unknown dialog family ${adapter.family}.`);
    if (!Number.isFinite(adapter.listOrder)) throw new Error(`format registry: ${adapter.id} needs a numeric listOrder.`);
    if (typeof adapter.sniff !== 'function') throw new Error(`format registry: ${adapter.id} has no sniff().`);
    if (adapter.kind === 'board') {
      if (typeof adapter.parse !== 'function') throw new Error(`format registry: ${adapter.id} has no parse().`);
      for (const set of adapter.companions?.sets ?? []) {
        if (set.length < 2 || set.some(name => !COMPANION.test(name)) || new Set(set).size !== set.length) throw new Error(`format registry: ${adapter.id} has an invalid companion set.`);
      }
    } else if (adapter.kind !== 'container' || typeof adapter.open !== 'function') throw new Error(`format registry: ${adapter.id} has no parse() or open().`);
    adapters.push(adapter);
  }
  return adapters.sort((a, b) => a.listOrder - b.listOrder || (a.id < b.id ? -1 : 1));
}

const ADAPTERS = validateAdapters(Object.entries(modules));
/** Every board adapter in list order (support table order; detection ignores it). */
export const BOARD_ADAPTERS: readonly BoardAdapter[] = Object.freeze(ADAPTERS.filter((adapter): adapter is BoardAdapter => adapter.kind === 'board'));
export const FORMAT_CAPABILITIES: readonly FormatCapability[] = Object.freeze(BOARD_ADAPTERS.map(adapter => adapter.capability as FormatCapability));
export const BOARD_EVIDENCE: Readonly<Record<string, RealFileEvidence>> = Object.freeze(Object.fromEntries(BOARD_ADAPTERS.flatMap(adapter => adapter.evidence ? [[adapter.id, adapter.evidence]] : [])));
export const CONTAINER_ADAPTERS: readonly ContainerAdapter[] = Object.freeze(ADAPTERS.filter((adapter): adapter is ContainerAdapter => adapter.kind === 'container'));
export const CONTAINER_CAPABILITIES: readonly ContainerCapability[] = Object.freeze(CONTAINER_ADAPTERS.map(adapter => adapter.capability as ContainerCapability));

const unique = (values: readonly string[]): string[] => [...new Set(values)];
/** Lowercase extensions with a leading dot, in list order: everything the chooser may open, recognized-unsupported families and archives included. */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.freeze(unique(ADAPTERS.flatMap(adapter => adapter.extensions)));

const COMPANION_SETS = BOARD_ADAPTERS.flatMap(adapter => adapter.companions?.sets ?? []);
const companionTable = (sets: readonly (readonly string[])[]): Map<string, string[]> => {
  const table = new Map<string, string[]>();
  for (const set of sets) for (const member of set) table.set(member, unique([...(table.get(member) ?? []), ...set.filter(other => other !== member)]));
  return table;
};
const COMPANIONS = companionTable(COMPANION_SETS);
const basename = (name: string): string => name.split(/[\\/]/).pop()?.toLowerCase() ?? '';
/** Choose among overlapping sets by available fixed names; declaration order breaks ties. Missing siblings remain a parser error. */
export function selectCompanionSet(sets: readonly (readonly string[])[], name: string, availableNames: readonly string[]): readonly string[] | undefined {
  const base = basename(name), available = new Set(availableNames.map(basename));
  available.add(base);
  let chosen: readonly string[] | undefined, most = -1;
  for (const set of sets) {
    if (!set.includes(base)) continue;
    const present = set.filter(member => available.has(member)).length;
    if (present > most) { chosen = set; most = present; }
  }
  return chosen;
}
/** Lowercase basenames of the sidecars that belong to `name` in the same directory ([] for single-file formats). */
export function companionNames(name: string, availableNames?: readonly string[]): string[] {
  const base = basename(name);
  if (availableNames) return [...selectCompanionSet(COMPANION_SETS, base, availableNames) ?? []].filter(member => member !== base);
  return [...COMPANIONS.get(base) ?? []];
}

export interface FormatsManifest {
  extensions: string[];
  companions: Record<string, string[]>;
  /** Ordered sets preserve selection when two fixed outlines share the same pin files. */
  companionSets: string[][];
  /** Secondary filters of the open dialog: every extension belongs to the family of the first adapter (in list order) that declares it. */
  families: Array<{ name: string; extensions: string[] }>;
}
/** The exact content of electron/formats.json (the main process reads only that file). */
export function buildFormatsManifest(adapters: readonly FormatAdapter[] = ADAPTERS): FormatsManifest {
  const familyOf = new Map<string, string>();
  for (const adapter of adapters) for (const extension of adapter.extensions) if (!familyOf.has(extension)) familyOf.set(extension, adapter.family);
  const extensions = unique(adapters.flatMap(adapter => adapter.extensions));
  const companionSets = adapters.flatMap(adapter => adapter.kind === 'board' ? (adapter.companions?.sets ?? []).map(set => [...set]) : []);
  const companions = companionTable(companionSets);
  return {
    extensions,
    companions: Object.fromEntries(companions),
    companionSets,
    families: DIALOG_FAMILIES.map(name => ({ name, extensions: extensions.filter(extension => familyOf.get(extension) === name) })).filter(family => family.extensions.length),
  };
}
/** electron/formats.json as written to disk: two-space JSON with a trailing newline. */
export const formatsManifestText = (adapters?: readonly FormatAdapter[]): string => `${JSON.stringify(buildFormatsManifest(adapters), null, 2)}\n`;
