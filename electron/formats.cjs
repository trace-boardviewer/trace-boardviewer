'use strict';

const path = require('node:path');
// Generated from the renderer's format registry (src/lib/formats/registry.ts; registry.test.ts fails when it drifts): the
// native process only decides which files may travel; recognition happens in the renderer parser.
const manifest = require('./formats.json');

function lowercaseName(value, label) {
  if (typeof value !== 'string' || !value || value !== value.toLowerCase() || /[\\/\0]/.test(value)) {
    throw new TypeError(`formats.json: invalid ${label} ${JSON.stringify(value)}.`); // Packaging defect, developer-facing.
  }
  return value;
}

if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.extensions) || !manifest.extensions.length) {
  throw new TypeError('formats.json: "extensions" must be a non-empty array.');
}
const SUPPORTED_EXTENSIONS = Object.freeze(manifest.extensions.map((value) => {
  if (!/^\.[a-z0-9_]+$/.test(lowercaseName(value, 'extension'))) throw new TypeError(`formats.json: invalid extension ${JSON.stringify(value)}.`);
  return value;
}));
if (new Set(SUPPORTED_EXTENSIONS).size !== SUPPORTED_EXTENSIONS.length) throw new TypeError('formats.json: duplicate extension.');

const companionTable = manifest.companions ?? {};
if (!companionTable || typeof companionTable !== 'object' || Array.isArray(companionTable)) throw new TypeError('formats.json: "companions" must be an object.');
const COMPANIONS = new Map(Object.entries(companionTable).map(([primary, siblings]) => {
  lowercaseName(primary, 'companion primary');
  if (!Array.isArray(siblings)) throw new TypeError(`formats.json: companions of ${primary} must be an array.`);
  return [primary, Object.freeze(siblings.map((sibling) => {
    if (lowercaseName(sibling, 'companion') === primary) throw new TypeError(`formats.json: ${primary} lists itself as a companion.`);
    return sibling;
  }))];
}));
const EXTENSIONLESS_COMPANIONS = new Set(
  [...COMPANIONS].flatMap(([primary, siblings]) => [primary, ...siblings]).filter((name) => !path.extname(name)),
);
const companionSets = manifest.companionSets ?? [];
if (!Array.isArray(companionSets)) throw new TypeError('formats.json: "companionSets" must be an array.');
const COMPANION_SETS = Object.freeze(companionSets.map((set) => {
  if (!Array.isArray(set) || set.length < 2) throw new TypeError('formats.json: invalid companion set.');
  const names = set.map((name) => lowercaseName(name, 'companion set member'));
  if (new Set(names).size !== names.length) throw new TypeError('formats.json: duplicate companion set member.');
  for (const name of names) for (const sibling of names) {
    if (sibling !== name && !COMPANIONS.get(name)?.includes(sibling)) throw new TypeError('formats.json: companion set differs from companion table.');
  }
  return Object.freeze(names);
}));

function isSupportedExtension(filename) {
  if (typeof filename !== 'string') return false;
  const extension = path.extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(extension)
    || (!extension && EXTENSIONLESS_COMPANIONS.has(path.basename(filename).toLowerCase()));
}

/** Lowercase sidecar basenames to gather next to `filename`; empty for single-file formats. */
function companionNames(filename, availableNames) {
  if (typeof filename !== 'string') return [];
  const base = path.basename(filename).toLowerCase();
  if (availableNames && COMPANION_SETS.length) {
    const available = new Set(availableNames.map((name) => path.basename(name).toLowerCase()));
    available.add(base);
    let chosen, most = -1;
    for (const set of COMPANION_SETS) {
      if (!set.includes(base)) continue;
      const present = set.filter((name) => available.has(name)).length;
      if (present > most) { chosen = set; most = present; }
    }
    return (chosen ?? []).filter((name) => name !== base);
  }
  return [...(COMPANIONS.get(base) ?? [])];
}

// i18n: pending — English family names for the optional secondary filters of the open dialog (generated with the rest of
// the manifest from the format registry; every listed extension must be one of the supported ones).
const familyTable = manifest.families ?? [];
if (!Array.isArray(familyTable)) throw new TypeError('formats.json: "families" must be an array.');
const FAMILIES = Object.freeze(familyTable.map((family) => {
  if (!family || typeof family.name !== 'string' || !/^[\x20-\x7e]{1,40}$/.test(family.name) || !Array.isArray(family.extensions)) {
    throw new TypeError(`formats.json: invalid family ${JSON.stringify(family)}.`);
  }
  for (const extension of family.extensions) {
    if (!SUPPORTED_EXTENSIONS.includes(extension)) throw new TypeError(`formats.json: family ${family.name} lists an unsupported extension ${JSON.stringify(extension)}.`);
  }
  return Object.freeze({ name: family.name, extensions: Object.freeze([...family.extensions]) });
}));

/** Supported extensions, then families, plus a localized all-files choice for fixed extensionless companion roles. */
function dialogFilters(everyFormatName, allFilesName) {
  const bare = (extensions) => extensions.map((extension) => extension.slice(1));
  return [
    { name: everyFormatName, extensions: bare(SUPPORTED_EXTENSIONS) },
    ...FAMILIES
      .map(({ name, extensions }) => ({ name, extensions: bare(extensions.filter((extension) => SUPPORTED_EXTENSIONS.includes(extension))) }))
      .filter((filter) => filter.extensions.length),
    ...(EXTENSIONLESS_COMPANIONS.size && typeof allFilesName === 'string' && allFilesName
      ? [{ name: allFilesName, extensions: ['*'] }] : []),
  ];
}

module.exports = Object.freeze({ SUPPORTED_EXTENSIONS, FAMILIES, companionNames, isSupportedExtension, dialogFilters });
