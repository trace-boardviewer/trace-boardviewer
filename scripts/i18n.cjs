'use strict';

// Catalog helper (docs/I18N.md). The catalogs are namespace files, electron/locales/<language>/<namespace>.json, one folder per
// language. This script adds a key to the right namespace of all eight languages in one step, with the checks the tests would
// make afterwards, and moves keys of an older flat catalog layout into the namespaces.
//
//   node scripts/i18n.cjs add <key> --values <file.json> [--namespace <name>] [--create-namespace]
//   node scripts/i18n.cjs add <key> --en "..." --hu "..." --de "..." --fr "..." --it "..." --sk "..." --pl "..." --uk "..." [...]
//   node scripts/i18n.cjs import-flat <folder> [--base <folder>] [--namespace <name>] [--apply-changes] [--dry-run]
//   node scripts/i18n.cjs namespaces
//
// import-flat takes over keys that a branch added to the old flat <language>.json catalogs: <folder> holds the branch's eight files
// and --base the eight files of the merge base, so only what the branch changed is taken (see docs/I18N.md).
//
// A value is a text or, for a plural, a JSON object: --en '{"one":"{count} pin","other":"{count} pins"}'. A --values file is
// { "en": value, "hu": value, ... } (easier than shell quoting). The namespace is the one that already holds keys of the same area
// ("<area>.<name>"), else the one named like the area, else --namespace; --create-namespace adds a new namespace (eight empty
// files; also register the English one in src/lib/i18n-english.ts). New lines go after the last key of the same area, so two
// branches that add keys of different areas do not touch the same lines.
const fs = require('node:fs');
const path = require('node:path');

const LOCALES = path.join(__dirname, '..', 'electron', 'locales');
const LANGUAGES = ['hu', 'en', 'de', 'fr', 'it', 'sk', 'pl', 'uk'];
const KEY = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/;
const NAMESPACE = /^[a-z][A-Za-z0-9]*$/;
const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];
const LOCALE_TAGS = { hu: 'hu-HU', en: 'en-GB', de: 'de-DE', fr: 'fr-FR', it: 'it-IT', sk: 'sk-SK', pl: 'pl-PL', uk: 'uk-UA' };
const ENTRY_START = /^ {2}"((?:[^"\\]|\\.)*)":/;

class UsageError extends Error {}

const areaOf = (key) => key.split('.')[0];
const placeholdersOf = (value) => new Set((typeof value === 'string' ? [value] : Object.values(value)).flatMap((form) => [...form.matchAll(/\{(\w+)\}/g)].map((match) => match[1])));
/** The plural categories the language uses for the integers 0..1000, plus "other": a plural object needs all of them. */
function neededForms(language) {
  const rules = new Intl.PluralRules(LOCALE_TAGS[language]);
  const found = new Set(['other']);
  for (let count = 0; count <= 1000; count++) found.add(rules.select(count));
  return found;
}
const sameSet = (a, b) => a.size === b.size && [...a].every((item) => b.has(item));
const isPlural = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------
// The catalogs in memory: texts[language][namespace] = file text
// ---------------------------------------------------------------------------------------------
function loadModel(root = LOCALES) {
  const folders = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (folders.join() !== [...LANGUAGES].sort().join()) throw new UsageError(`electron/locales must hold exactly the language folders ${LANGUAGES.join(', ')} (found: ${folders.join(', ') || 'none'})`);
  const texts = {};
  for (const language of LANGUAGES) {
    texts[language] = {};
    for (const name of fs.readdirSync(path.join(root, language)).filter((file) => file.endsWith('.json')).sort()) {
      texts[language][name.replace(/\.json$/, '')] = fs.readFileSync(path.join(root, language, name), 'utf8').replace(/\r\n/g, '\n');
    }
  }
  return { root, texts, changed: new Set() };
}
function namespacesOf(model) {
  return Object.keys(model.texts.en).sort();
}
/** { key: namespace } of the English catalog; the other languages mirror it (the tests check that). */
function keyLocations(model) {
  const where = new Map();
  for (const namespace of namespacesOf(model)) {
    for (const key of Object.keys(JSON.parse(model.texts.en[namespace]))) where.set(key, namespace);
  }
  return where;
}
function valueIn(model, language, namespace, key) {
  const text = model.texts[language][namespace];
  const part = text === undefined ? {} : JSON.parse(text);
  return Object.hasOwn(part, key) ? part[key] : undefined;
}
function saveModel(model) {
  for (const [language, namespaces] of Object.entries(model.texts)) {
    for (const [namespace, text] of Object.entries(namespaces)) {
      if (!model.changed.has(`${language}/${namespace}`)) continue;
      JSON.parse(text); // never write a file that is not JSON
      fs.mkdirSync(path.join(model.root, language), { recursive: true });
      fs.writeFileSync(path.join(model.root, language, `${namespace}.json`), text, 'utf8');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Text edits that keep the file as it is (one entry per line, blank lines between groups)
// ---------------------------------------------------------------------------------------------
function entryLines(key, value) {
  const head = `  ${JSON.stringify(key)}: `;
  if (typeof value === 'string') return [head + JSON.stringify(value)];
  const forms = PLURAL_CATEGORIES.filter((form) => Object.hasOwn(value, form));
  const inline = `${head}{ ${forms.map((form) => `${JSON.stringify(form)}: ${JSON.stringify(value[form])}`).join(', ')} }`;
  if (inline.length <= 110) return [inline];
  return [`${head}{`, ...forms.map((form, index) => `    ${JSON.stringify(form)}: ${JSON.stringify(value[form])}${index < forms.length - 1 ? ',' : ''}`), '  }'];
}
function entriesOfText(lines) {
  const entries = [];
  for (let index = 0; index < lines.length; index++) {
    const match = ENTRY_START.exec(lines[index]);
    if (match) entries.push({ key: JSON.parse(`"${match[1]}"`), first: index, last: index });
    else if (entries.length && lines[index] !== '' && lines[index] !== '}') entries[entries.length - 1].last = index;
  }
  return entries;
}
const withComma = (line) => (line.endsWith(',') ? line : `${line},`);

/** The text of a namespace file with a new entry after the last key of the same area (else at the end, as a new group). */
function insertEntry(text, key, value) {
  const lines = text.split('\n');
  const entries = entriesOfText(lines);
  const block = entryLines(key, value);
  if (entries.length === 0) return `{\n${block.join('\n')}\n}\n`;
  const sameArea = entries.filter((entry) => areaOf(entry.key) === areaOf(key));
  const after = sameArea.length ? sameArea[sameArea.length - 1] : entries[entries.length - 1];
  const isLast = after === entries[entries.length - 1];
  const inserted = [...(sameArea.length ? [] : ['']), ...block];
  if (!isLast) inserted[inserted.length - 1] = withComma(inserted[inserted.length - 1]);
  lines[after.last] = withComma(lines[after.last]);
  lines.splice(after.last + 1, 0, ...inserted);
  return lines.join('\n');
}
/** The text with the value of an existing key replaced (the entry keeps its place and its trailing comma). */
function replaceEntry(text, key, value) {
  const lines = text.split('\n');
  const entry = entriesOfText(lines).find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`key ${key} is not in the file`);
  const comma = lines[entry.last].endsWith(',');
  const block = entryLines(key, value);
  if (comma) block[block.length - 1] = withComma(block[block.length - 1]);
  lines.splice(entry.first, entry.last - entry.first + 1, ...block);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Validation (the rules of src/lib/i18n.test.ts and i18n-layout.test.ts, checked before anything is written)
// ---------------------------------------------------------------------------------------------
function checkValues(key, values) {
  const problems = [];
  if (!KEY.test(key)) problems.push(`key "${key}" is not "<area>.<name>" (letters and digits, dot separated)`);
  const missing = LANGUAGES.filter((language) => values[language] === undefined);
  if (missing.length) problems.push(`no value for ${missing.join(', ')}: all eight languages are required`);
  if (missing.includes('en')) return problems;
  const english = values.en;
  const expected = placeholdersOf(english);
  for (const language of LANGUAGES) {
    const value = values[language];
    if (value === undefined) continue;
    if (typeof value !== 'string' && !(isPlural(value) && typeof value.other === 'string')) { problems.push(`${language}: a value is a text or a plural object with at least "other"`); continue; }
    if (isPlural(value)) {
      for (const form of Object.keys(value)) if (!PLURAL_CATEGORIES.includes(form)) problems.push(`${language}: unknown plural category "${form}"`);
      for (const form of neededForms(language)) if (typeof value[form] !== 'string') problems.push(`${language}: plural form "${form}" is missing (${language} uses ${[...neededForms(language)].join(', ')})`);
    }
    const forms = typeof value === 'string' ? [value] : Object.values(value);
    for (const form of forms) {
      if (typeof form !== 'string' || form.trim() === '') problems.push(`${language}: empty or non-text form`);
      else {
        if (form !== form.trim()) problems.push(`${language}: leading or trailing whitespace in ${JSON.stringify(form)}`);
        if (form !== form.normalize('NFC')) problems.push(`${language}: not NFC-normalised (${JSON.stringify(form)})`);
        if (/[\u0000-\u001f\u007f]/.test(form)) problems.push(`${language}: control character in ${JSON.stringify(form)}`);
        if (!sameSet(placeholdersOf(form), expected)) problems.push(`${language}: placeholders {${[...placeholdersOf(form)].join(',')}} differ from English {${[...expected].join(',')}} in ${JSON.stringify(form)}`);
      }
    }
    if (isPlural(english) && !isPlural(value) && language !== 'hu') problems.push(`${language}: English has plural forms, give ${language} its plural forms as well`);
    if (!isPlural(english) && isPlural(value)) problems.push(`${language}: English is a plain text, ${language} must be one too`);
    if (isPlural(english) && language === 'hu' && typeof value === 'string' && !/\{count\}/.test(value)) problems.push('hu: a plain text for a plural key must contain {count}');
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------
function resolveNamespace(model, key, requested, createNamespace) {
  const existing = namespacesOf(model);
  if (requested) {
    if (!NAMESPACE.test(requested)) throw new UsageError(`"${requested}" is not a namespace name (letters and digits, starting with a letter)`);
    if (!existing.includes(requested)) {
      if (!createNamespace) throw new UsageError(`namespace "${requested}" does not exist (${existing.join(', ')}); add --create-namespace to create it`);
      createNamespaceFiles(model, requested);
    }
    return requested;
  }
  const area = areaOf(key);
  const sameArea = [...keyLocations(model)].find(([other]) => areaOf(other) === area);
  if (sameArea) return sameArea[1];
  if (existing.includes(area)) return area;
  throw new UsageError(`no namespace holds keys of the area "${area}": pass --namespace <name> (existing: ${existing.join(', ')})`);
}
function createNamespaceFiles(model, namespace) {
  for (const language of LANGUAGES) { model.texts[language][namespace] = '{}\n'; model.changed.add(`${language}/${namespace}`); }
}

/** Adds a key to every language; returns the namespace used. Throws UsageError listing the problems; changes nothing then. */
function addKey(model, key, values, { namespace, createNamespace = false } = {}) {
  const problems = checkValues(key, values);
  if (problems.length) throw new UsageError(problems.join('\n'));
  const where = keyLocations(model);
  if (where.has(key)) throw new UsageError(`key "${key}" already exists in ${where.get(key)}.json; edit the namespace files to change its text`);
  const target = resolveNamespace(model, key, namespace, createNamespace);
  for (const language of LANGUAGES) {
    model.texts[language][target] = insertEntry(model.texts[language][target], key, values[language]);
    model.changed.add(`${language}/${target}`);
  }
  return target;
}
function changeKey(model, key, values) {
  const namespace = keyLocations(model).get(key);
  for (const language of LANGUAGES) {
    model.texts[language][namespace] = replaceEntry(model.texts[language][namespace], key, values[language]);
    model.changed.add(`${language}/${namespace}`);
  }
  return namespace;
}

function readFlat(folder) {
  const flat = {};
  const absent = [];
  for (const language of LANGUAGES) {
    const file = path.join(folder, `${language}.json`);
    if (fs.existsSync(file)) flat[language] = JSON.parse(fs.readFileSync(file, 'utf8')); else absent.push(language);
  }
  return { flat, absent };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Takes over the keys of flat catalogs (<folder>/<language>.json, the layout before the namespaces) that the namespace files lack.
 * With `base` (the flat catalogs of the merge base) only what the branch changed against it counts: a key it added, or a text it
 * changed that the namespace files still have as in the base; a text changed on both sides is a conflict and is left alone, and
 * a key the branch removed is listed, not removed. Without `base` every key of the folder counts and a differing text is
 * reported as changed. Changed texts are replaced only with applyChanges. Returns { added, changed, removed, unchanged, problems }.
 */
function importFlat(model, folder, { namespace, applyChanges = false, base } = {}) {
  const { flat, absent } = readFlat(folder);
  const baseCatalogs = base ? readFlat(base).flat : undefined;
  const where = keyLocations(model);
  const added = [], changed = [], removed = [], problems = [];
  let unchanged = 0;
  const has = (catalog, key) => catalog !== undefined && Object.hasOwn(catalog, key);
  // What the branch did to a key in a language: nothing (undefined), or a value it added or changed.
  const touched = (language, key) => has(flat[language], key) && !(baseCatalogs && has(baseCatalogs[language], key) && same(baseCatalogs[language][key], flat[language][key]));
  const keys = [...new Set(Object.values(flat).flatMap((catalog) => Object.keys(catalog)))].filter((key) => LANGUAGES.some((language) => touched(language, key)));
  if (baseCatalogs) {
    for (const key of new Set(Object.values(baseCatalogs).flatMap((catalog) => Object.keys(catalog)))) {
      if (LANGUAGES.some((language) => has(baseCatalogs[language], key) && flat[language] && !has(flat[language], key))) removed.push(key);
    }
  }
  for (const key of keys) {
    if (where.has(key)) {
      const namespaceOfKey = where.get(key);
      const differs = LANGUAGES.filter((language) => touched(language, key) && !same(flat[language][key], valueIn(model, language, namespaceOfKey, key)));
      if (!differs.length) { unchanged++; continue; }
      // Both sides changed the text (or both added the key with different texts): not ours to decide.
      const conflicts = baseCatalogs ? differs.filter((language) => !has(baseCatalogs[language], key) || !same(baseCatalogs[language][key], valueIn(model, language, namespaceOfKey, key))) : [];
      if (conflicts.length) problems.push(`${key}: changed in the namespace files and in the branch (${conflicts.join(', ')}); decide by hand`);
      else changed.push({ key, languages: differs });
      continue;
    }
    const values = Object.fromEntries(LANGUAGES.filter((language) => has(flat[language], key)).map((language) => [language, flat[language][key]]));
    try { added.push({ key, namespace: addKey(model, key, values, { namespace }) }); } catch (error) { if (!(error instanceof UsageError)) throw error; problems.push(`${key}: ${error.message.split('\n').join('; ')}`); }
  }
  if (absent.length) problems.push(`no flat catalog for ${absent.join(', ')} in ${folder}: keys that exist in the files given are reported above, but a new key needs all eight`);
  if (applyChanges) {
    for (const item of changed) {
      const namespaceOfKey = where.get(item.key);
      const values = Object.fromEntries(LANGUAGES.map((language) => [language, item.languages.includes(language) ? flat[language][item.key] : valueIn(model, language, namespaceOfKey, item.key)]));
      const issues = checkValues(item.key, values);
      if (issues.length) problems.push(`${item.key}: ${issues.join('; ')}`); else changeKey(model, item.key, values);
    }
  }
  return { added, changed, removed, unchanged, problems };
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------
function parseArguments(argv) {
  const options = { positional: [], values: {} };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) { options.positional.push(argument); continue; }
    const name = argument.slice(2);
    if (['dry-run', 'apply-changes', 'create-namespace'].includes(name)) { options[name] = true; continue; }
    const value = argv[++index];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    if (LANGUAGES.includes(name)) options.values[name] = parseValue(value);
    else if (name === 'values') options.valuesFile = value;
    else if (name === 'namespace') options.namespace = value;
    else if (name === 'base') options.base = value;
    else throw new UsageError(`unknown option --${name}`);
  }
  return options;
}
function parseValue(text) {
  if (text.startsWith('{') && text.endsWith('}')) { try { const parsed = JSON.parse(text); if (isPlural(parsed)) return parsed; } catch { /* a text such as "{pins} · {components}" */ } }
  return text;
}

function main(argv) {
  const [command, ...rest] = argv;
  const options = parseArguments(rest);
  const model = loadModel();
  if (command === 'namespaces') {
    const where = keyLocations(model);
    for (const namespace of namespacesOf(model)) {
      const keys = [...where].filter(([, name]) => name === namespace).map(([key]) => key);
      const areas = [...new Set(keys.map(areaOf))];
      console.log(`${namespace.padEnd(12)} ${String(keys.length).padStart(4)} keys   areas: ${areas.join(', ') || '(none yet)'}`);
    }
    return;
  }
  if (command === 'add') {
    const [key] = options.positional;
    if (!key) throw new UsageError('usage: node scripts/i18n.cjs add <key> --values <file.json> | --en "..." --hu "..." ...');
    const fromFile = options.valuesFile ? JSON.parse(fs.readFileSync(options.valuesFile, 'utf8')) : {};
    const namespace = addKey(model, key, { ...fromFile, ...options.values }, { namespace: options.namespace, createNamespace: options['create-namespace'] });
    saveModel(model);
    console.log(`added ${key} to ${namespace}.json in ${LANGUAGES.length} languages`);
    if (options['create-namespace'] && !fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'i18n-english.ts'), 'utf8').includes(`en/${namespace}.json`)) {
      console.log(`new namespace: import en/${namespace}.json and spread it in src/lib/i18n-english.ts (the layout test checks it)`);
    }
    return;
  }
  if (command === 'import-flat') {
    const [folder] = options.positional;
    if (!folder) throw new UsageError('usage: node scripts/i18n.cjs import-flat <folder with <language>.json> [--base <folder>] [--namespace <name>] [--apply-changes] [--dry-run]');
    const result = importFlat(model, path.resolve(folder), { namespace: options.namespace, applyChanges: options['apply-changes'], base: options.base && path.resolve(options.base) });
    for (const item of result.added) console.log(`add      ${item.key} -> ${item.namespace}.json`);
    for (const item of result.changed) console.log(`${options['apply-changes'] ? 'replaced' : 'differs '} ${item.key} (${item.languages.join(', ')})${options['apply-changes'] ? '' : ': pass --apply-changes to take the flat text'}`);
    for (const key of result.removed) console.log(`removed in the branch, kept here: ${key}`);
    console.log(`${result.added.length} added, ${result.changed.length} differing, ${result.unchanged} unchanged`);
    for (const problem of result.problems) console.error(`problem  ${problem}`);
    if (result.problems.length) throw new UsageError(`${result.problems.length} problem(s); nothing was written`);
    if (options['dry-run']) console.log('dry run: nothing written'); else saveModel(model);
    return;
  }
  throw new UsageError('commands: add, import-flat, namespaces (see the header of scripts/i18n.cjs and docs/I18N.md)');
}

module.exports = { LANGUAGES, KEY, UsageError, loadModel, keyLocations, namespacesOf, saveModel, insertEntry, replaceEntry, entryLines, checkValues, addKey, changeKey, importFlat, parseArguments, parseValue };

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    if (error instanceof UsageError) { console.error(error.message); process.exitCode = 1; } else throw error;
  }
}
