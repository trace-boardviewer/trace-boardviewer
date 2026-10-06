'use strict';

const path = require('node:path');
// Single source of truth shared with the renderer dispatcher (src/lib/formats/index.ts): the native
// process only decides which files may travel; recognition happens in the renderer parser.
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

// i18n: pending — English family names for the optional secondary filters of the open dialog.
const FAMILIES = Object.freeze([
  ['GenCAD', ['.cad', '.gcd']],
  ['Boardview', ['.brd', '.bdv', '.bv', '.bvr', '.fz', '.cae', '.asc', '.pcb', '.cst', '.xzz', '.tvw']],
  ['ECAD design', ['.kicad_pcb', '.pcbdoc', '.cmpcbdoc', '.cspcbdoc', '.neu', '.xml']],
  ['Gerber', ['.gbr']],
].map(([name, extensions]) => Object.freeze({ name, extensions: Object.freeze(extensions) })));

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
