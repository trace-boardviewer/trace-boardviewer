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

function isSupportedExtension(filename) {
  return typeof filename === 'string' && SUPPORTED_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}

/** Lowercase sidecar basenames to gather next to `filename` (the ASC trio); empty for single-file formats. */
function companionNames(filename) {
  if (typeof filename !== 'string') return [];
  return [...(COMPANIONS.get(path.basename(filename).toLowerCase()) ?? [])];
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

/** Open-dialog filters: every supported extension under the localized name first, then the English families. */
function dialogFilters(everyFormatName) {
  const bare = (extensions) => extensions.map((extension) => extension.slice(1));
  return [
    { name: everyFormatName, extensions: bare(SUPPORTED_EXTENSIONS) },
    ...FAMILIES
      .map(({ name, extensions }) => ({ name, extensions: bare(extensions.filter((extension) => SUPPORTED_EXTENSIONS.includes(extension))) }))
      .filter((filter) => filter.extensions.length),
  ];
}

module.exports = Object.freeze({ SUPPORTED_EXTENSIONS, FAMILIES, companionNames, isSupportedExtension, dialogFilters });
