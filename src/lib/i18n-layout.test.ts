import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, catalogs, type CatalogValue, type Language, type PluralForms } from './i18n';

/**
 * Layout of the catalogs: electron/locales/<language>/<namespace>.json, one folder per language, the same namespace files in
 * every folder, every key in exactly one namespace and in the same namespace in every language. English is the reference:
 * it types `MessageKey` and every other language must have exactly its keys, placeholders and plural structure.
 * The checks read the files themselves and the merged catalogs of the renderer and of the native twin, so a forgotten
 * registration, a misplaced key or a language that drifted from English fails here with the file and the key named.
 */
const nativeRequire = createRequire(import.meta.url);
const nativeCatalogs = nativeRequire('../../electron/locale-catalogs.cjs') as {
  LOCALES_DIRECTORY: string;
  namespaceFiles(language: string, root?: string): string[];
  loadCatalog(language: string, root?: string): Record<string, CatalogValue>;
};
const nativeI18n = nativeRequire('../../electron/i18n.cjs') as { catalogs: Record<string, Record<string, CatalogValue>> };

const ROOT = new URL('../../', import.meta.url);
const LOCALES = nativeCatalogs.LOCALES_DIRECTORY;
const readText = (file: string): string => readFileSync(file, 'utf8');
const projectText = (relative: string): string => readFileSync(new URL(relative, ROOT), 'utf8');
const NON_EN = LANGUAGES.filter(lang => lang !== 'en');

type Namespaces = Record<string, Record<string, CatalogValue>>;
const namespacesOf = (lang: Language): Namespaces => {
  const result: Namespaces = {};
  for (const name of nativeCatalogs.namespaceFiles(lang)) result[name.replace(/\.json$/, '')] = JSON.parse(readText(path.join(LOCALES, lang, name))) as Record<string, CatalogValue>;
  return result;
};
const EN_NAMESPACES = namespacesOf('en');
const EN = catalogs.en as Record<string, CatalogValue>;

const isPlural = (value: CatalogValue): value is PluralForms => typeof value === 'object' && value !== null;
const formsOf = (value: CatalogValue): string[] => (typeof value === 'string' ? [value] : Object.values(value));
const placeholders = (value: CatalogValue): string[] => [...new Set(formsOf(value).flatMap(form => [...form.matchAll(/\{(\w+)\}/g)].map(match => match[1])))].sort();
const areaOf = (key: string): string => key.split('.')[0];

function expectNoProblems(problems: readonly string[], title: string): void {
  const shown = problems.slice(0, 30).map(problem => `  - ${problem}`).join('\n');
  const more = problems.length > 30 ? `\n  ... and ${problems.length - 30} more` : '';
  expect(problems.length, `${title} (${problems.length}):\n${shown}${more}`).toBe(0);
}

describe('catalog layout: electron/locales/<language>/<namespace>.json', () => {
  it('electron/locales holds exactly one folder per supported language and nothing else', () => {
    const entries = readdirSync(LOCALES, { withFileTypes: true });
    expect(entries.filter(entry => !entry.isDirectory()).map(entry => entry.name), 'stray files next to the language folders (a flat <language>.json is the old layout)').toEqual([]);
    expect(entries.map(entry => entry.name).sort()).toEqual([...LANGUAGES].sort());
  });

  it('every language folder holds only namespace files, and the same ones as English', () => {
    const english = readdirSync(path.join(LOCALES, 'en')).sort();
    expect(english.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const lang of LANGUAGES) {
      const entries = readdirSync(path.join(LOCALES, lang), { withFileTypes: true });
      for (const entry of entries) if (!entry.isFile() || !/^[a-z][A-Za-z0-9]*\.json$/.test(entry.name)) problems.push(`${lang}/${entry.name} is not a namespace file (<name>.json)`);
      const own = entries.map(entry => entry.name).sort();
      for (const name of english) if (!own.includes(name)) problems.push(`${lang}/${name} is missing (English has it)`);
      for (const name of own) if (!english.includes(name)) problems.push(`${lang}/${name} has no English counterpart`);
    }
    expectNoProblems(problems, 'namespace files differ between languages');
  });

  it.each(NON_EN)('%s: every namespace holds exactly the keys of the English namespace of the same name', (lang) => {
    const own = namespacesOf(lang);
    const problems: string[] = [];
    for (const [name, english] of Object.entries(EN_NAMESPACES)) {
      const keys = new Set(Object.keys(own[name] ?? {}));
      for (const key of Object.keys(english)) if (!keys.has(key)) problems.push(`${lang}/${name}.json lacks ${key}`);
      for (const key of keys) if (!Object.hasOwn(english, key)) problems.push(`${lang}/${name}.json has ${key}, which is not in en/${name}.json (a key lives in the same namespace in every language)`);
    }
    expectNoProblems(problems, `${lang} namespace contents differ from English`);
  });

  it('a key is defined once per language: no key appears in two namespace files', () => {
    const problems: string[] = [];
    for (const lang of LANGUAGES) {
      const seen = new Map<string, string>();
      for (const [name, part] of Object.entries(namespacesOf(lang))) {
        for (const key of Object.keys(part)) {
          if (seen.has(key)) problems.push(`${lang}: ${key} is in ${seen.get(key)}.json and ${name}.json`);
          seen.set(key, name);
        }
      }
    }
    expectNoProblems(problems, 'duplicate keys across namespaces');
  });

  it('each key area ("<area>.<name>") lives in one namespace, so the namespace of a new key follows from its area', () => {
    const namespacesOfArea = new Map<string, Set<string>>();
    for (const [name, part] of Object.entries(EN_NAMESPACES)) {
      for (const key of Object.keys(part)) {
        if (!namespacesOfArea.has(areaOf(key))) namespacesOfArea.set(areaOf(key), new Set());
        namespacesOfArea.get(areaOf(key))!.add(name);
      }
    }
    const split = [...namespacesOfArea].filter(([, names]) => names.size > 1).map(([area, names]) => `area "${area}" is in ${[...names].sort().join(' and ')}`);
    expectNoProblems(split, 'key areas spread over several namespaces');
  });
});

describe('English is the reference of every language', () => {
  it('the typed English registry (src/lib/i18n-english.ts) lists every English namespace file', () => {
    const source = projectText('src/lib/i18n-english.ts');
    const missing = Object.keys(EN_NAMESPACES).filter(name => !source.includes(`'../../electron/locales/en/${name}.json'`));
    expectNoProblems(missing.map(name => `en/${name}.json is not imported in src/lib/i18n-english.ts (add the import and the spread)`), 'unregistered English namespaces');
    const merged = Object.assign({}, ...Object.values(EN_NAMESPACES)) as Record<string, CatalogValue>;
    expect(Object.keys(EN).sort()).toEqual(Object.keys(merged).sort());
    expect(EN).toEqual(merged);
  });

  it('MessageKey is derived from the English catalog, not from another language', () => {
    const source = projectText('src/lib/i18n.ts');
    expect(source).toMatch(/export type MessageKey = keyof typeof en;/);
    expect(source).not.toMatch(/keyof typeof (?:hu|de|fr|it|sk|pl|uk)\b/);
  });

  it.each(NON_EN)('%s: exactly the English key set, with the same placeholders and plural structure', (lang) => {
    const own = catalogs[lang] as Record<string, CatalogValue>;
    const problems: string[] = [];
    for (const key of Object.keys(EN)) if (!Object.hasOwn(own, key)) problems.push(`missing ${key}`);
    for (const key of Object.keys(own)) if (!Object.hasOwn(EN, key)) problems.push(`extra ${key}`);
    for (const [key, english] of Object.entries(EN)) {
      const value = own[key];
      if (value === undefined) continue;
      const expected = placeholders(english).join(',');
      for (const form of formsOf(value)) {
        const found = [...new Set([...form.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort().join(',');
        if (found !== expected) problems.push(`${key}: a form has {${found}}, English has {${expected}}`);
      }
      if (isPlural(english)) {
        // Hungarian counts without a plural form ("5 érintkező"), so a plain string carrying {count} is its legal shape.
        if (!isPlural(value)) { if (lang !== 'hu') problems.push(`${key}: English has plural forms, ${lang} a plain string`); }
        else if (typeof value.other !== 'string') problems.push(`${key}: plural forms lack "other"`);
      } else if (isPlural(value)) problems.push(`${key}: English is a plain string, ${lang} has plural forms`);
    }
    expectNoProblems(problems, `${lang} differs from the English reference`);
  });
});

describe('merged catalogs', () => {
  it.each(LANGUAGES)('%s: the renderer (src/lib/i18n.ts) and the native twin (electron/i18n.cjs) merge to the same catalog as the namespace files', (lang) => {
    const merged = Object.assign({}, ...Object.values(namespacesOf(lang))) as Record<string, CatalogValue>;
    expect(catalogs[lang]).toEqual(merged);
    expect(nativeI18n.catalogs[lang]).toEqual(merged);
    expect(nativeCatalogs.loadCatalog(lang)).toEqual(merged);
    expect(Object.keys(catalogs[lang]).length).toBe(Object.keys(merged).length);
  });
});

describe('the native loader (electron/locale-catalogs.cjs)', () => {
  const withTree = (files: Record<string, string>, run: (root: string) => void): void => {
    const root = mkdtempSync(path.join(tmpdir(), 'trace-locales-'));
    try {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        writeFileSync(path.join(root, name), text);
      }
      run(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  };

  it('merges the .json files of a language in name order and ignores anything else', () => {
    withTree({
      'en/zeta.json': '{ "zeta.one": "Z" }', 'en/alpha.json': '{ "alpha.one": "A", "alpha.two": { "one": "{count} x", "other": "{count} xs" } }',
      'en/notes.txt': 'not a catalog', 'en/empty.json': '{}',
    }, (root) => {
      expect(nativeCatalogs.namespaceFiles('en', root)).toEqual(['alpha.json', 'empty.json', 'zeta.json']);
      const merged = nativeCatalogs.loadCatalog('en', root);
      expect(Object.keys(merged)).toEqual(['alpha.one', 'alpha.two', 'zeta.one']);
      expect(merged['alpha.two']).toEqual({ one: '{count} x', other: '{count} xs' });
    });
  });

  it('refuses a key that two namespaces define, and a language without a folder, instead of choosing one silently', () => {
    withTree({ 'en/a.json': '{ "x.key": "one" }', 'en/b.json': '{ "x.key": "two" }' }, (root) => {
      expect(() => nativeCatalogs.loadCatalog('en', root)).toThrow(/"x\.key" of "en" is defined in both a\.json and b\.json/);
      expect(() => nativeCatalogs.loadCatalog('de', root)).toThrow(/Locale directory "de" is missing/);
    });
  });
});
