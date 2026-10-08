/*
 * Consistency checks of a ground truth: the invariants every generated library keeps, so a change to the generator (or a hand-edited
 * truth) cannot quietly break what the metrics are scored against. Pure; the file checks take a reader for the library's files.
 */
import { GROUND_TRUTH_SCHEMA } from './ground-truth.ts';
import type { GroundTruth, TruthItem } from './ground-truth.ts';
import { validateJson } from './json-schema.ts';
import type { Hasher } from './sha256.ts';
import { BOMB_LIMITS } from './zip.ts';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Problems of the truth itself (empty when it is consistent). `limit` bounds the list. */
export function checkTruth(truth: GroundTruth, limit = 40): string[] {
  const problems: string[] = [];
  const add = (message: string): void => { if (problems.length < limit) problems.push(message); };
  for (const message of validateJson(GROUND_TRUTH_SCHEMA as unknown as Record<string, unknown>, truth, limit)) add(`schema ${message}`);
  if (problems.length) return problems;

  const families = new Map(truth.families.map(family => [family.id, family] as const));
  if (families.size !== truth.families.length) add('duplicate family ids');
  const ids = new Map<string, TruthItem>();
  for (const item of truth.items) { if (ids.has(item.id)) add(`duplicate item id ${item.id}`); ids.set(item.id, item); }
  const loose = truth.items.filter(item => !item.container);
  const lower = new Set<string>();
  for (const item of loose) {
    const key = item.path.normalize('NFC').toLowerCase();
    if (lower.has(key)) add(`paths collide on a case-insensitive file system: ${item.path}`);
    lower.add(key);
    const segments = item.path.split('/');
    if (segments.some(segment => !segment || /[<>:"\\|?*\u0000-\u001f]/.test(segment) || /[. ]$/.test(segment) || RESERVED.test(segment.split('.')[0]) || segment.length > 255)) add(`unsafe path ${item.path}`);
    if (item.path.length > 255) add(`path over 255 characters: ${item.path.slice(0, 60)}...`);
  }

  const shaGroups = new Map<string, TruthItem[]>();
  for (const item of truth.items) {
    if (item.container) {
      const archive = ids.get(item.container.archive);
      if (!archive || archive.container) add(`${item.id}: its archive ${item.container.archive} is not a file of the library`);
      else if (item.path !== archive.path) add(`${item.id}: path differs from the archive's`);
      if (!item.flags.includes('in-archive')) add(`${item.id}: archive member without the in-archive flag`);
    } else if (item.flags.includes('in-archive')) add(`${item.id}: in-archive flag on a loose file`);
    if (item.familyId && !families.has(item.familyId)) add(`${item.id}: unknown family ${item.familyId}`);
    if (item.revision !== null) {
      const family = item.familyId ? families.get(item.familyId) : undefined;
      if (!family || !family.revisions.some(revision => revision.revision === item.revision)) add(`${item.id}: revision ${item.revision} is not a revision of the family`);
    }
    if ((item.joinStrength === 'strong') !== (item.component !== null)) add(`${item.id}: strong and component disagree`);
    if (item.component && !item.component.startsWith(`${item.familyId}.`)) add(`${item.id}: component ${item.component} is not of family ${item.familyId}`);
    if (item.joinStrength !== 'none' && !item.familyId) add(`${item.id}: strength without a family`);
    if (item.sha256 === null && !(item.flags.includes('zip-bomb') && item.declaredSize !== undefined)) add(`${item.id}: no hash`);
    if (item.flags.includes('zip-bomb') && item.container) {
      if ((item.declaredSize ?? 0) > BOMB_LIMITS.maxEntryBytes) add(`${item.id}: bomb entry over the bound`);
      if (item.familyId !== null) add(`${item.id}: bomb entry with a family`);
    }
    if (item.role === 'photo' && item.kind !== 'image') add(`${item.id}: photo that is not an image`);
    if (item.role === 'firmware' && item.kind !== 'firmware') add(`${item.id}: firmware role with kind ${item.kind}`);
    if (item.flags.includes('copy') && !item.duplicateSet) add(`${item.id}: copy that is in no duplicate set`);
    if (item.fingerprint && !(item.pinSetSize && item.pinSetSize > 0)) add(`${item.id}: fingerprint of an empty pin set`);
    if (item.sha256 && item.size > 0) (shaGroups.get(item.sha256) ?? shaGroups.set(item.sha256, []).get(item.sha256)!).push(item);
  }

  // components: at least two distinct contents each
  const components = new Map<string, Set<string>>();
  for (const item of truth.items) if (item.component) (components.get(item.component) ?? components.set(item.component, new Set()).get(item.component)!).add(item.sha256 ?? item.id);
  for (const [component, contents] of components) if (contents.size < 2) add(`component ${component} holds one content`);

  // duplicate sets: identical sets share bytes; every shared hash is a set
  const setOf = new Map<string, string>();
  for (const set of truth.duplicateSets) {
    const members = set.members.map(id => ids.get(id));
    if (members.some(member => !member)) { add(`duplicate set ${set.id} names an unknown item`); continue; }
    for (const member of members as TruthItem[]) {
      if (member.duplicateSet !== set.id && set.kind === 'identical') add(`${member.id}: duplicateSet ${member.duplicateSet} but listed in ${set.id}`);
    }
    if (set.kind === 'identical') {
      const first = members[0] as TruthItem;
      if (!(members as TruthItem[]).every(member => member.sha256 === first.sha256)) add(`identical set ${set.id} holds different bytes`);
      if (first.sha256) setOf.set(first.sha256, set.id);
      const owners = new Set((members as TruthItem[]).map(member => member.familyId));
      if (owners.size > 1) add(`identical set ${set.id} spans several families (or a family and none)`);
    } else {
      const sizes = new Set((members as TruthItem[]).map(member => member.sha256));
      if (sizes.size < 2) add(`re-saved set ${set.id} holds identical bytes`);
    }
  }
  for (const [sha, items] of shaGroups) if (items.length > 1 && !setOf.has(sha)) add(`${items.length} items share bytes (${items[0].id}) but are in no identical set`);

  // groups
  const grouped = new Set<string>();
  for (const group of truth.groups) {
    if (!families.has(group.familyId)) add(`group ${group.id}: unknown family`);
    for (const member of group.members) {
      const item = ids.get(member.item);
      if (!item) { add(`group ${group.id}: unknown item ${member.item}`); continue; }
      if (item.familyId !== group.familyId) add(`group ${group.id}: ${member.item} belongs to ${item.familyId}`);
      if (item.joinStrength !== member.strength) add(`group ${group.id}: ${member.item} strength differs`);
      grouped.add(member.item);
    }
  }
  for (const item of truth.items) if (item.joinStrength !== 'none' && !grouped.has(item.id)) add(`${item.id}: strong or weak but in no group`);

  // part index
  for (const [part, owners] of Object.entries(truth.partIndex)) for (const owner of owners) if (!families.has(owner)) add(`part ${part}: unknown family ${owner}`);

  // totals
  const members = truth.items.length - loose.length;
  const bytes = loose.reduce((sum, item) => sum + item.size, 0);
  if (truth.totals.files !== loose.length) add(`totals.files ${truth.totals.files} but ${loose.length} files`);
  if (truth.totals.members !== members) add(`totals.members ${truth.totals.members} but ${members} members`);
  if (truth.totals.bytes !== bytes) add(`totals.bytes ${truth.totals.bytes} but the files add up to ${bytes}`);
  if (truth.totals.families !== truth.families.length) add('totals.families');
  if (truth.totals.groups !== truth.groups.length) add('totals.groups');
  if (bytes > truth.options.bytes) add(`the files add up to ${bytes} bytes, over the budget of ${truth.options.bytes}`);
  if (loose.length !== truth.options.files) add(`${loose.length} files, ${truth.options.files} asked for`);
  return problems;
}

/** Problems between the truth and the files: a missing file, another size, another hash, a file the truth does not know. */
export function checkFiles(truth: GroundTruth, files: ReadonlyMap<string, Uint8Array>, hash: Hasher, limit = 40): string[] {
  const problems: string[] = [];
  const known = new Set<string>();
  for (const item of truth.items) {
    if (item.container) continue;
    known.add(item.path);
    const bytes = files.get(item.path);
    if (!bytes) { if (problems.length < limit) problems.push(`missing ${item.path}`); continue; }
    if (bytes.length !== item.size) { if (problems.length < limit) problems.push(`${item.path}: ${bytes.length} bytes, the truth says ${item.size}`); continue; }
    if (hash(bytes) !== item.sha256 && problems.length < limit) problems.push(`${item.path}: hash differs`);
  }
  for (const path of files.keys()) if (!known.has(path) && problems.length < limit) problems.push(`unknown file ${path}`);
  return problems;
}
