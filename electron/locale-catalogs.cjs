'use strict';

// Loads one language's catalog from its namespace files: electron/locales/<language>/<namespace>.json.
// A namespace is a feature area (app, board, notes, network, ...); the key names do not change with the split, a key is
// "<area>.<name>" and lives in exactly one namespace file per language. The files are merged in file-name order into one flat
// object, so lookups, plurals and interpolation (electron/i18n.cjs, src/lib/i18n.ts) see the same catalog as before.
// The directory listing is the registry: a new namespace is a new set of files, nothing here changes. Both the main process and
// the checks use this module; the renderer merges the same files in src/lib/i18n.ts (Vite's import.meta.glob).
const fs = require('node:fs');
const path = require('node:path');

const LOCALES_DIRECTORY = path.join(__dirname, 'locales');

/** The namespace file names of a language, sorted: ['app.json', 'board.json', ...]. `root` is a parameter for the tests only. */
function namespaceFiles(language, root = LOCALES_DIRECTORY) {
  const directory = path.join(root, language);
  let names;
  try { names = fs.readdirSync(directory); } catch (error) { throw new Error(`Locale directory "${language}" is missing (${error.code ?? error.message})`); }
  return names.filter((name) => name.endsWith('.json')).sort();
}

/** One namespace file, parsed. Read each time (no module cache), so a catalog that was edited is read again. */
function readNamespace(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** The merged flat catalog of a language. A key defined in two namespaces is a defect and throws. */
function loadCatalog(language, root = LOCALES_DIRECTORY) {
  const catalog = {};
  const origin = new Map();
  for (const name of namespaceFiles(language, root)) {
    const part = readNamespace(path.join(root, language, name));
    for (const key of Object.keys(part)) {
      if (origin.has(key)) throw new Error(`Locale key "${key}" of "${language}" is defined in both ${origin.get(key)} and ${name}`);
      origin.set(key, name);
      catalog[key] = part[key];
    }
  }
  return catalog;
}

module.exports = Object.freeze({ LOCALES_DIRECTORY, namespaceFiles, loadCatalog });
