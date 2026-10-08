import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  DATA_LOCALE, DETECTION_FALLBACK, LANGUAGE_NAMES, LANGUAGES, LEGACY_LANGUAGE, LOCALE_TAGS,
  catalogs, createFormatters, createTranslator, detectLanguage, formatIssue, isLanguage, normalizeLanguage,
  resolveLanguage, translate,
  type CatalogValue, type Language, type Params, type ParseIssue, type PluralForms,
} from './i18n';

/**
 * Localization contract tests. Three groups:
 *  - pure functions and hu/en reference catalogs: always meaningful;
 *  - catalog-dependent checks for de/fr/it/sk/pl/uk: they inspect electron/locales/<lang>/<namespace>.json as the
 *    translators deliver it, and only report real defects once those catalogs are complete;
 *  - native/web parity: src/lib/i18n.ts and electron/i18n.cjs must produce identical text.
 * Everything uses the catalogs and synthetic values only; no board file is read.
 */

// ---------------------------------------------------------------------------------------------
// Native twin and file helpers
// ---------------------------------------------------------------------------------------------
interface NativeI18n {
  LANGUAGES: readonly string[]; LEGACY_LANGUAGE: string; DETECTION_FALLBACK: string;
  LOCALE_TAGS: Readonly<Record<string, string>>;
  catalogs: Readonly<Record<string, Readonly<Record<string, CatalogValue>>>>;
  isLanguage(value: unknown): boolean;
  normalizeLanguage(value: unknown): string | undefined;
  detectLanguage(input: unknown): string;
  resolveLanguage(stored: unknown, options?: { fresh: boolean; system?: unknown }): string;
  translate(language: string, key: string, params?: Params): string;
  createTranslator(language: string): (key: string, params?: Params) => string;
}
const nativeRequire = createRequire(import.meta.url);
const native = nativeRequire('../../electron/i18n.cjs') as NativeI18n;

const projectFile = (relative: string): URL => new URL(`../../${relative}`, import.meta.url);
const readText = (relative: string): string => readFileSync(projectFile(relative), 'utf8');
/** The folder of a language's namespace files (electron/locales/<lang>/<namespace>.json), used in messages. */
const localeFile = (lang: Language): string => `electron/locales/${lang}/`;
/** The namespace files of a language with their text, in file-name order. */
const namespaceFilesOf = (lang: Language): Array<{ name: string; text: string }> =>
  readdirSync(projectFile(`electron/locales/${lang}`)).filter(name => name.endsWith('.json')).sort().map(name => ({ name, text: readText(`electron/locales/${lang}/${name}`) }));

// ---------------------------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------------------------
const NON_EN = LANGUAGES.filter(lang => lang !== 'en');
const NON_HU = LANGUAGES.filter(lang => lang !== 'hu');
/** Languages translated from the English/Hungarian reference catalogs. */
const TRANSLATED = LANGUAGES.filter(lang => lang !== 'hu' && lang !== 'en');
const EN = catalogs.en;
const EN_KEYS = Object.keys(EN);

const PLURAL_CATEGORIES: readonly string[] = ['zero', 'one', 'two', 'few', 'many', 'other'];
const isPluralObject = (value: unknown): value is PluralForms =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const formsOf = (value: CatalogValue): string[] => (typeof value === 'string' ? [value] : Object.values(value));
const entriesOf = (lang: Language): Array<[string, CatalogValue]> => Object.entries(catalogs[lang]) as Array<[string, CatalogValue]>;
const valueOf = (lang: Language, key: string): CatalogValue | undefined =>
  Object.hasOwn(catalogs[lang], key) ? (catalogs[lang] as Record<string, CatalogValue>)[key] : undefined;
const placeholdersOf = (text: string): Set<string> => new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]));
const sortedSet = (set: ReadonlySet<string>): string[] => [...set].sort();
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every(item => b.has(item));
const q = (text: string): string => JSON.stringify(text);

/** Walk every English key that `lang` also defines; missing keys are reported by the completeness tests only. */
function forEachCommonKey(lang: Language, visit: (key: string, own: CatalogValue, english: CatalogValue) => void): void {
  for (const key of EN_KEYS) {
    const own = valueOf(lang, key);
    if (own !== undefined) visit(key, own, EN[key]);
  }
}

function expectNoProblems(problems: readonly string[], title: string): void {
  const shown = problems.slice(0, 30).map(problem => `  - ${problem}`).join('\n');
  const more = problems.length > 30 ? `\n  ... and ${problems.length - 30} more` : '';
  expect(problems.length, `${title} (${problems.length}):\n${shown}${more}`).toBe(0);
}

/** Top-level keys of a JSON object text, duplicates included (JSON.parse silently keeps the last one). */
function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      let j = i + 1;
      let raw = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { raw += text[j] + text[j + 1]; j += 2; } else raw += text[j++];
      }
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (depth === 1 && text[k] === ':') keys.push(JSON.parse(`"${raw}"`) as string);
      i = j;
    } else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
  }
  return keys;
}

// ---------------------------------------------------------------------------------------------
// Sample parameters
// ---------------------------------------------------------------------------------------------
const COUNT_SAMPLES = [0, 1, 2, 3, 4, 5, 6, 11, 12, 14, 21, 22, 25, 100, 101, 1000, 1234567, 0.5, 1.5, -1];
const OTHER_NUMBERS = [65536, 0.5, 1234567.891, -3];

/** Parameter sets covering a message: string params, numeric params (auto-formatted) and, for plurals, many counts. */
function sampleParamSets(names: readonly string[]): Array<Params | undefined> {
  const others = names.filter(name => name !== 'count');
  const asStrings = Object.fromEntries(others.map(name => [name, `<${name}>`]));
  const asNumbers = Object.fromEntries(others.map((name, index) => [name, OTHER_NUMBERS[index % OTHER_NUMBERS.length]]));
  const sets: Array<Params | undefined> = [undefined, {}];
  if (!names.includes('count')) return [...sets, asStrings, asNumbers];
  for (const count of COUNT_SAMPLES) sets.push({ ...asStrings, count }, { ...asNumbers, count });
  return sets;
}
function allPlaceholders(...values: Array<CatalogValue | undefined>): string[] {
  const names = new Set<string>();
  for (const value of values) if (value !== undefined) for (const form of formsOf(value)) for (const name of placeholdersOf(form)) names.add(name);
  return [...names].sort();
}
/** Complete parameter set: every placeholder of the key is supplied. */
function fullParams(key: string, count = 3): Params {
  const params: Record<string, string | number> = {};
  for (const name of allPlaceholders(EN[key])) params[name] = name === 'count' ? count : `<${name}>`;
  return params;
}

// ---------------------------------------------------------------------------------------------
// Text classification helpers
// ---------------------------------------------------------------------------------------------
/** Fixed technical tokens that never get translated; letters left after removing them are "words". */
const TECHNICAL_WORDS = /GENCAD|TRACE|(?<![\p{L}\p{N}])(?:mm|MB)(?![\p{L}\p{N}])|\.(?:cad|gcd)\b/gu;
/** True for pure templates such as "{pins} · {components}". */
function hasNoWords(text: string): boolean {
  return !/\p{L}/u.test(text.replace(/\{\w+\}/g, ' ').replace(TECHNICAL_WORDS, ' '));
}
const BADGE = /^[A-Z](?:\/[A-Z])?$/;
const hasCyrillic = (text: string): boolean => /\p{Script=Cyrillic}/u.test(text);

/** Fixed tokens that must survive translation: record keywords, units, file extensions, version numbers. */
function fixedTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const stripped = text.replace(/\{\w+\}/g, ' ');
  if (/\p{Ll}/u.test(stripped)) {
    for (const match of stripped.matchAll(/(?<![A-Za-z0-9])[A-Z][A-Z0-9]{2,}(?![A-Za-z0-9])/g)) tokens.add(match[0]);
  }
  for (const brand of ['GENCAD', 'TRACE']) if (text.includes(brand)) tokens.add(brand);
  for (const match of text.matchAll(/(?<![\p{L}\p{N}])(?:mm|MB)(?![\p{L}\p{N}])/gu)) tokens.add(match[0]);
  for (const match of text.matchAll(/\.(?:cad|gcd)\b/g)) tokens.add(match[0]);
  for (const match of text.matchAll(/\d+(?:\.\d+)*°?/g)) tokens.add(match[0]);
  return tokens;
}

/** Latin letters each language may use besides a-z. Anything else means a leaked foreign letter. */
const LATIN_EXTRA: Readonly<Record<Language, string>> = {
  hu: 'áéíóöőúüű', en: '', de: 'äöüß', fr: 'àâæçéèêëîïôœùûüÿ', it: 'àèéìíîòóùú',
  sk: 'áäčďéíĺľňóôŕšťúýž', pl: 'ąćęłńóśźż', uk: '',
};
const UKRAINIAN_LETTERS = 'абвгґдеєжзиіїйклмнопрстуфхцчшщьюя';
function foreignLetters(lang: Language, text: string): string[] {
  const bad: string[] = [];
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    const lower = char.toLowerCase();
    if (/\p{Script=Latin}/u.test(char)) {
      if (!`abcdefghijklmnopqrstuvwxyz${LATIN_EXTRA[lang]}`.includes(lower)) bad.push(char);
    } else if (lang === 'uk' && /\p{Script=Cyrillic}/u.test(char)) {
      if (!UKRAINIAN_LETTERS.includes(lower)) bad.push(char);
    } else if (!(lang === 'uk' && char === 'ʼ')) bad.push(char); // U+02BC: the Ukrainian apostrophe
  }
  return bad;
}

const wordList = (words: readonly string[]): RegExp => new RegExp(`(?<![\\p{L}])(?:${words.join('|')})(?![\\p{L}])`, 'iu');
/** Words that only occur in English. Their presence in another catalog means untranslated text. */
const ENGLISH_WORDS = wordList(['the', 'and', 'with', 'from', 'this', 'that', 'were', 'could', 'cannot', 'please', 'choose', 'instead', 'available', 'loaded', 'saved', 'failed', 'because']);
/** Hungarian-only words (not words of de/fr/it/sk/pl/uk). */
const HUNGARIAN_WORDS = wordList(['nyák\\p{L}*', 'fájl\\p{L}*', 'alkatrész\\p{L}*', 'hálózat\\p{L}*', 'sikerült', 'megnyit\\p{L}*', 'kattints\\p{L}*', 'nincs', 'vagy', 'legutóbbi', 'beállítás\\p{L}*', 'megjegyzés\\p{L}*', 'mentés\\p{L}*', 'keresés\\p{L}*', 'nem', 'és', 'egy', 'hiba\\p{L}*']);

// ---------------------------------------------------------------------------------------------
// Allow-lists (each entry justified)
// ---------------------------------------------------------------------------------------------
interface Allowance { languages: readonly Language[] | 'all'; reason: string }
/**
 * Values that may be identical to the English text. The rule is "same word, not an omission":
 * format names, EDA jargon the Hungarian catalog also keeps untranslated, and real cognates. Each
 * entry lists exactly the languages where the identical text is the correct one, so a new
 * untranslated leftover in any other language (or key) still fails. Pure templates without words
 * ("{pins} · {components}") and one-letter badges ("T", "B",
 * "T/B") are exempt automatically and therefore not listed. Everything else must be translated.
 */
const SAME_AS_ENGLISH: Readonly<Record<string, Allowance>> = {
  'inspector.colPin': { languages: ['de', 'it', 'sk', 'pl'], reason: '"Pin" is the EDA term and stays untranslated (the hu catalog keeps it); fr/uk translate it' },
  'inspector.pinTitle': { languages: ['de', 'it', 'sk', 'pl'], reason: '"Pin {number} · {name} · {net}": the EDA term plus placeholders, same decision as inspector.colPin' },
  'inspector.pins': { languages: ['de'], reason: 'German uses the English plural "Pins" for pin lists' },
  'inspector.colNet': { languages: ['it'], reason: 'Italian EDA jargon keeps "Net" (hu keeps it too); it is a column header, not a sentence' },
  'unit.pins': { languages: ['it'], reason: 'Italian "pin" is invariable: "1 pin", "2 pin" (the only plural object whose one/other forms are legitimately equal)' },
  'unit.nets': { languages: ['it'], reason: 'Italian EDA jargon "net" is invariable: "1 net", "2 net"' },
  'inspector.colSignal': { languages: ['de', 'fr'], reason: 'cognate: "Signal" is the German and French word' },
  'inspector.position': { languages: ['de', 'fr'], reason: 'cognate: "Position" is the German and French word' },
  'inspector.package': { languages: ['it'], reason: 'Italian EDA text says "package" for the component package' },
  'info.format': { languages: ['de', 'fr', 'pl'], reason: 'cognate: "Format" is the German, French and Polish word' },
  'settings.layout': { languages: ['de', 'it'], reason: '"Layout" is the standard German and Italian loanword' },
  'settings.themeSystem': { languages: ['de'], reason: 'cognate: "System" is the German word' },
  'common.note': { languages: ['fr'], reason: 'cognate: "Note" is a French word' },
  'help.note': { languages: ['fr'], reason: 'cognate: "Note" is a French word' },
  'layout.focus': { languages: ['fr', 'it'], reason: '"Focus" is used as-is in French and Italian UIs' },
  'kind.diode': { languages: ['de', 'fr'], reason: 'cognate: "Diode" is the German and French word' },
  'kind.transistor': { languages: ['de', 'fr', 'it'], reason: 'cognate: "Transistor" is the German, French and Italian word' },
};
/** Values that may be identical to the Hungarian text because Hungarian and the language share the word. */
const SAME_AS_HUNGARIAN: Readonly<Record<string, Allowance>> = {
  'kind.capacitor': { languages: ['sk'], reason: 'Slovak "Kondenzátor" is spelled exactly like Hungarian' },
  'kind.diode': { languages: ['sk'], reason: 'Slovak "Dióda" is spelled exactly like Hungarian' },
};
const isAllowed = (table: Readonly<Record<string, Allowance>>, key: string, lang: Language): boolean => {
  const entry = table[key];
  return entry !== undefined && (entry.languages === 'all' || entry.languages.includes(lang));
};
/** Keys whose Ukrainian value may stay Latin-only (none at present; pure templates are exempt by rule). */
const UK_LATIN_ONLY_OK: ReadonlySet<string> = new Set();

// ---------------------------------------------------------------------------------------------
// 1. Catalog completeness
// ---------------------------------------------------------------------------------------------
describe('catalog completeness', () => {
  it('English and Hungarian are complete, non-trivial reference catalogs of the same size', () => {
    expect(EN_KEYS.length).toBeGreaterThan(200);
    expect(Object.keys(catalogs.hu).length).toBe(EN_KEYS.length);
  });

  it.each(LANGUAGES)('%s: keys follow the dotted semantic naming scheme', (lang) => {
    const bad = Object.keys(catalogs[lang]).filter(key => !/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/.test(key));
    expectNoProblems(bad, `${localeFile(lang)}: keys that are not "area.name" dotted identifiers`);
  });

  it.each(NON_EN)('%s: key set equals the English key set (nothing missing, nothing extra)', (lang) => {
    const own = new Set(Object.keys(catalogs[lang]));
    const english = new Set(EN_KEYS);
    const missing = EN_KEYS.filter(key => !own.has(key)).map(key => `missing key ${key}`);
    const extra = [...own].filter(key => !english.has(key)).map(key => `extra key ${key}`);
    expectNoProblems([...missing, ...extra], `${localeFile(lang)} key set differs from electron/locales/en/`);
  });

  it.each(LANGUAGES)('%s: values are non-empty strings (plural forms included), trimmed, NFC and free of control characters', (lang) => {
    const problems: string[] = [];
    for (const [key, value] of entriesOf(lang)) {
      if (typeof value !== 'string' && !isPluralObject(value)) { problems.push(`${key}: value is neither a string nor a plural object`); continue; }
      const labelled = typeof value === 'string' ? [['', value] as const] : Object.entries(value).map(([form, text]) => [`.${form}`, text] as const);
      for (const [suffix, text] of labelled) {
        const id = `${key}${suffix}`;
        if (typeof text !== 'string' || text.trim() === '') { problems.push(`${id}: empty or non-string`); continue; }
        if (text !== text.trim()) problems.push(`${id}: leading/trailing whitespace ${q(text)}`);
        if (text !== text.normalize('NFC')) problems.push(`${id}: not NFC-normalised (decomposed accents)`);
        if (/[\u0000-\u001f\u007f]/.test(text)) problems.push(`${id}: contains a control character`);
        if (/<\/?[a-z][^>]*>/i.test(text)) problems.push(`${id}: contains HTML-like markup ${q(text)}`);
      }
    }
    expectNoProblems(problems, `${localeFile(lang)} has malformed values`);
  });

  it.each(NON_EN)('%s: uses plural objects exactly where English does (hu may use plain strings)', (lang) => {
    const problems: string[] = [];
    forEachCommonKey(lang, (key, own, english) => {
      if (isPluralObject(english)) {
        if (typeof own === 'string' && lang === 'hu') return;
        if (!isPluralObject(own)) { problems.push(`${key}: English has plural forms, ${lang} has a plain string`); return; }
      } else if (isPluralObject(own)) problems.push(`${key}: English is a plain string, ${lang} has plural forms`);
      if (isPluralObject(own)) {
        if (typeof own.other !== 'string') problems.push(`${key}: plural object lacks the required "other" form`);
        for (const form of Object.keys(own)) if (!PLURAL_CATEGORIES.includes(form)) problems.push(`${key}: unknown plural category "${form}"`);
      }
    });
    expectNoProblems(problems, `${localeFile(lang)} plural structure differs from electron/locales/en/`);
  });

  it.each(LANGUAGES)('%s: JSON files are BOM-free, have no duplicate keys (also across namespaces) and no encoding damage', (lang) => {
    const problems: string[] = [];
    const seen = new Map<string, string>();
    for (const { name, text } of namespaceFilesOf(lang)) {
      if (text.charCodeAt(0) === 0xfeff) problems.push(`${name} starts with a UTF-8 BOM`);
      for (const key of topLevelKeys(text)) {
        if (seen.has(key)) problems.push(`duplicate key ${key} (${seen.get(key)} and ${name})`);
        seen.set(key, name);
      }
    }
    // Mojibake: UTF-8 text decoded as a single-byte code page (e.g. "Ã©", "Ä…", "Ð¿") or replacement characters.
    const mojibake = /[ÃÂÅÄÐÑ][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™]/;
    for (const [key, value] of entriesOf(lang)) {
      for (const form of formsOf(value)) {
        if (form.includes('�')) problems.push(`${key}: contains U+FFFD replacement character`);
        else if (mojibake.test(form)) problems.push(`${key}: looks like mojibake ${q(form)}`);
      }
    }
    expectNoProblems(problems, `${localeFile(lang)} file/encoding problems`);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Placeholder parity
// ---------------------------------------------------------------------------------------------
describe('placeholder parity', () => {
  it.each(NON_EN)('%s: every form carries exactly the English {placeholders}', (lang) => {
    const problems: string[] = [];
    forEachCommonKey(lang, (key, own, english) => {
      const expected = new Set(allPlaceholders(english));
      const union = new Set<string>();
      for (const form of formsOf(own)) {
        const found = placeholdersOf(form);
        for (const name of found) union.add(name);
        if (!sameSet(found, expected)) problems.push(`${key}: form ${q(form)} has {${sortedSet(found).join(',')}} but English has {${sortedSet(expected).join(',')}}`);
      }
      if (!sameSet(union, expected)) problems.push(`${key}: placeholder union {${sortedSet(union).join(',')}} != English {${sortedSet(expected).join(',')}}`);
    });
    expectNoProblems(problems, `${localeFile(lang)} placeholder mismatch`);
  });

  it.each(LANGUAGES)('%s: every plural form of a plural key contains {count}', (lang) => {
    const problems: string[] = [];
    forEachCommonKey(lang, (key, own, english) => {
      if (!isPluralObject(english)) return;
      for (const [form, text] of Object.entries(isPluralObject(own) ? own : { plain: own })) {
        if (!/\{count\}/.test(text)) problems.push(`${key}.${form}: missing {count} in ${q(text)}`);
      }
    });
    expectNoProblems(problems, `${localeFile(lang)} plural forms without {count}`);
  });

  it.each(LANGUAGES)('%s: braces are only used for well-formed {name} placeholders', (lang) => {
    const problems: string[] = [];
    for (const [key, value] of entriesOf(lang)) {
      for (const form of formsOf(value)) {
        if (/[{}]/.test(form.replace(/\{\w+\}/g, ''))) problems.push(`${key}: stray or malformed brace in ${q(form)}`);
      }
    }
    expectNoProblems(problems, `${localeFile(lang)} malformed placeholders`);
  });

  it.each(NON_EN)('%s: the literal "$" of GENCAD section markers ($END{section}, ${section}) is preserved in the same keys', (lang) => {
    const problems: string[] = [];
    forEachCommonKey(lang, (key, own, english) => {
      const dollars = (text: string): number => (text.match(/\$/g) ?? []).length;
      const markers = formsOf(english).flatMap(form => form.match(/\$[A-Z]*\{\w+\}/g) ?? []);
      for (const form of formsOf(own)) {
        if (dollars(form) !== Math.max(...formsOf(english).map(dollars))) problems.push(`${key}: "$" count differs from English in ${q(form)}`);
        for (const marker of new Set(markers)) if (!form.includes(marker)) problems.push(`${key}: ${q(form)} lacks the literal marker ${marker}`);
      }
    });
    expectNoProblems(problems, `${localeFile(lang)} section-marker dollar signs`);
  });

  it('English keeps exactly three keys with a literal "$" (the parser section markers)', () => {
    const keys = EN_KEYS.filter(key => formsOf(EN[key]).some(form => form.includes('$')));
    expect(keys.sort()).toEqual(['parse.error.duplicateSection', 'parse.error.missingSection', 'parse.error.missingSectionEnd']);
  });

  it.each(LANGUAGES)('%s: section markers render as $ENDPADS / $PADS and params are never re-interpreted as "$" patterns', (lang) => {
    for (const run of [(key: string, params: Params) => translate(lang, key, params), (key: string, params: Params) => native.translate(lang, key, params)]) {
      expect(run('parse.error.missingSectionEnd', { section: 'PADS' })).toContain('$ENDPADS');
      expect(run('parse.error.duplicateSection', { section: 'PADS' })).toContain('$PADS');
      expect(run('parse.error.missingSection', { section: 'PADS' })).toContain('$PADS');
      expect(run('parse.error.duplicateSection', { section: '$&' })).toContain('$$&');
      expect(run('parse.error.duplicateSection', { section: "$1$'" })).toContain("$$1$'");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Plural completeness
// ---------------------------------------------------------------------------------------------
const integerCategories = (lang: Language): string[] => {
  const rules = new Intl.PluralRules(LOCALE_TAGS[lang]);
  const found = new Set<string>();
  for (let n = 0; n <= 1000; n++) found.add(rules.select(n));
  return [...found].sort();
};
const pluralKeys = EN_KEYS.filter(key => isPluralObject(EN[key]));

describe('plural completeness', () => {
  it('English declares the nine plural messages the UI and parser use', () => {
    expect(pluralKeys.sort()).toEqual([
      'parse.warning.approximatedPads', 'parse.warning.danglingNodes', 'parse.warning.fallbackComponents', 'parse.warning.fallbackPads', 'parse.warning.unsupportedRecords',
      'unit.components', 'unit.nets', 'unit.pins', 'unit.results',
    ]);
  });

  it('plural categories of the supported languages match the CLDR assumptions made by the catalogs', () => {
    expect(integerCategories('hu')).toEqual(['one', 'other']);
    expect(integerCategories('en')).toEqual(['one', 'other']);
    expect(integerCategories('de')).toEqual(['one', 'other']);
    expect(integerCategories('fr')).toEqual(['one', 'other']);
    expect(integerCategories('it')).toEqual(['one', 'other']);
    expect(integerCategories('sk')).toEqual(['few', 'one', 'other']);
    expect(integerCategories('pl')).toEqual(['few', 'many', 'one']);
    expect(integerCategories('uk')).toEqual(['few', 'many', 'one']);
    const select = (lang: Language, ...counts: number[]): string[] => counts.map(n => new Intl.PluralRules(LOCALE_TAGS[lang]).select(n));
    expect(select('pl', 1, 2, 5, 22)).toEqual(['one', 'few', 'many', 'few']);
    expect(select('uk', 1, 2, 5, 22)).toEqual(['one', 'few', 'many', 'few']);
    expect(select('sk', 1, 2, 5, 22)).toEqual(['one', 'few', 'other', 'other']);
  });

  it.each(LANGUAGES)('%s: every plural object has all CLDR categories of integers 0..1000, plus "other"', (lang) => {
    const needed = new Set([...integerCategories(lang), 'other']);
    const problems: string[] = [];
    forEachCommonKey(lang, (key, own) => {
      if (!isPluralObject(own)) return; // plain strings are reported by the structure test (only hu may use them)
      for (const category of needed) if (typeof own[category as keyof PluralForms] !== 'string') problems.push(`${key}: missing plural form "${category}"`);
    });
    expectNoProblems(problems, `${localeFile(lang)} (${LOCALE_TAGS[lang]}) incomplete plural objects`);
  });

  it.each(LANGUAGES)('%s: plural objects contain no category the language cannot select', (lang) => {
    const allowed = new Set(new Intl.PluralRules(LOCALE_TAGS[lang]).resolvedOptions().pluralCategories as string[]);
    allowed.add('other');
    const problems: string[] = [];
    forEachCommonKey(lang, (key, own) => {
      if (!isPluralObject(own)) return;
      for (const category of Object.keys(own)) if (!allowed.has(category)) problems.push(`${key}: "${category}" is never selected for ${LOCALE_TAGS[lang]}`);
    });
    expectNoProblems(problems, `${localeFile(lang)} unreachable plural forms (copied from another language?)`);
  });

  it.each(LANGUAGES)('%s: translate() renders the form of the CLDR category for each sample count (web and native)', (lang) => {
    const rules = new Intl.PluralRules(LOCALE_TAGS[lang]);
    const number = new Intl.NumberFormat(LOCALE_TAGS[lang]);
    const problems: string[] = [];
    for (const key of pluralKeys) {
      const own = valueOf(lang, key) ?? EN[key];
      for (const count of [0, 1, 2, 3, 4, 5, 11, 12, 21, 22, 25, 101, 1234567]) {
        const params = { ...fullParams(key, count) };
        const form = typeof own === 'string' ? own : own[rules.select(count) as keyof PluralForms] ?? own.other;
        const expected = form.replace(/\{(\w+)\}/g, (_, name: string) => (name === 'count' ? number.format(count) : String(params[name])));
        for (const [label, actual] of [['web', translate(lang, key, params)], ['native', native.translate(lang, key, params)]]) {
          if (actual !== expected) problems.push(`${label} ${key} count=${count}: got ${q(actual)}, expected ${q(expected)}`);
        }
      }
    }
    expectNoProblems(problems, `${lang} plural selection`);
  });

  /** Rendered text per CLDR category with the localized number replaced by "#", for counts that select that category. */
  function templatesByCategory(lang: Language, key: string, samples: readonly number[]): { byCategory: Map<string, string>; problems: string[] } {
    const rules = new Intl.PluralRules(LOCALE_TAGS[lang]);
    const number = new Intl.NumberFormat(LOCALE_TAGS[lang]);
    const byCategory = new Map<string, string>();
    const problems: string[] = [];
    for (const count of samples) {
      const category = rules.select(count);
      const text = translate(lang, key, { ...fullParams(key, count) }).split(number.format(count)).join('#');
      const previous = byCategory.get(category);
      if (previous !== undefined && previous !== text) problems.push(`${key}: count ${count} (${category}) reads ${q(text)} but an earlier count of the same category read ${q(previous)}`);
      byCategory.set(category, text);
    }
    return { byCategory, problems };
  }
  const SAMPLE_COUNTS = [0, 1, 2, 3, 4, 5, 6, 11, 12, 21, 22, 25, 100, 101, 1000];
  /** Italian "pin"/"net" are invariable loanwords, so their one and other forms are legitimately equal. */
  const ONE_EQUALS_OTHER: Readonly<Record<string, readonly Language[]>> = { 'unit.pins': ['it'], 'unit.nets': ['it'] };

  it.each(NON_HU)('%s: the singular reads differently from the other forms, and a category always reads the same', (lang) => {
    const problems: string[] = [];
    for (const key of pluralKeys) {
      if (!isPluralObject(valueOf(lang, key))) continue; // structure problems are reported by the completeness tests
      const { byCategory, problems: inconsistent } = templatesByCategory(lang, key, SAMPLE_COUNTS);
      problems.push(...inconsistent);
      const one = byCategory.get('one');
      for (const [category, text] of byCategory) {
        if (category !== 'one' && text === one && !ONE_EQUALS_OTHER[key]?.includes(lang)) problems.push(`${key}: "one" and "${category}" are identical (${q(text)})`);
      }
    }
    expectNoProblems(problems, `${lang} plural forms that do not differ`);
  });

  it.each(NON_HU.filter(lang => integerCategories(lang).length >= 3))('%s: languages with three plural categories really distinguish them in the common noun counts', (lang) => {
    // Genitive-plural syncretism (few = many = other) is correct in many sentences; it must not be the case everywhere.
    const distinguished = pluralKeys.filter((key) => {
      if (!isPluralObject(valueOf(lang, key))) return false;
      const texts = [...templatesByCategory(lang, key, SAMPLE_COUNTS).byCategory.values()];
      return new Set(texts).size === texts.length;
    });
    expect(distinguished.length, `${lang}: only ${distinguished.join(', ') || 'no key'} tell all plural categories apart`).toBeGreaterThanOrEqual(3);
  });

  it.each(['pl', 'uk', 'sk'] as const)('%s: counts 1, 2, 5 and 22 of components, pins and results read differently where the language distinguishes them', (lang) => {
    const rules = new Intl.PluralRules(LOCALE_TAGS[lang]);
    const number = new Intl.NumberFormat(LOCALE_TAGS[lang]);
    for (const key of ['unit.components', 'unit.pins', 'unit.results']) {
      const texts = new Map([1, 2, 5, 22].map(count => [count, translate(lang, key, { count }).split(number.format(count)).join('#')]));
      for (const [a, b] of [[1, 2], [1, 5], [1, 22], [2, 5], [5, 22], [2, 22]] as const) {
        const sameCategory = rules.select(a) === rules.select(b);
        const label = `${key}: ${a} (${rules.select(a)}) vs ${b} (${rules.select(b)})`;
        if (sameCategory) expect(texts.get(a), label).toBe(texts.get(b));
        else expect(texts.get(a), label).not.toBe(texts.get(b));
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 4. No leftover English / Hungarian, script and alphabet hygiene
// ---------------------------------------------------------------------------------------------
describe('no leftover English or Hungarian', () => {
  it('the identical-to-English allow-list only names real keys and languages', () => {
    for (const table of [SAME_AS_ENGLISH, SAME_AS_HUNGARIAN]) {
      for (const [key, entry] of Object.entries(table)) {
        expect(EN_KEYS, `allow-list key ${key} must exist in the English catalog`).toContain(key);
        expect(entry.reason.length, `${key} needs a justification`).toBeGreaterThan(15);
        if (entry.languages !== 'all') for (const lang of entry.languages) expect(TRANSLATED).toContain(lang);
      }
    }
  });

  it.each(TRANSLATED)('%s: no value is left identical to English (except the justified allow-list)', (lang) => {
    const problems: string[] = [];
    forEachCommonKey(lang, (key, own, english) => {
      const englishForms = formsOf(english);
      if (englishForms.every(form => hasNoWords(form) || BADGE.test(form))) return; // pure templates and one-letter badges
      if (isAllowed(SAME_AS_ENGLISH, key, lang)) return;
      if (formsOf(own).every(form => englishForms.includes(form))) problems.push(`${key}: ${q(formsOf(own).join(' | '))} is still the English text`);
    });
    expectNoProblems(problems, `${localeFile(lang)} untranslated (English) values; translate them or justify them in SAME_AS_ENGLISH`);
  });

  it.each(TRANSLATED)('%s: no value is left in Hungarian', (lang) => {
    const problems: string[] = [];
    forEachCommonKey(lang, (key, own) => {
      const hungarian = valueOf('hu', key);
      const english = EN[key];
      if (hungarian === undefined || isAllowed(SAME_AS_HUNGARIAN, key, lang)) return;
      const huForms = formsOf(hungarian);
      const wordLetters = (text: string): number => (text.replace(/\{\w+\}/g, '').replace(TECHNICAL_WORDS, '').match(/\p{L}/gu) ?? []).length;
      const sameAsHungarian = formsOf(own).every(form => huForms.includes(form)) && huForms.some(form => wordLetters(form) >= 4);
      const sameAsEnglish = formsOf(own).every(form => formsOf(english).includes(form));
      if (sameAsHungarian && !sameAsEnglish) problems.push(`${key}: ${q(formsOf(own).join(' | '))} is still the Hungarian text`);
      for (const form of formsOf(own)) if (HUNGARIAN_WORDS.test(form)) problems.push(`${key}: Hungarian word in ${q(form)}`);
    });
    expectNoProblems(problems, `${localeFile(lang)} Hungarian leftovers`);
  });

  it.each(NON_EN)('%s: contains no stray English words (the, and, with, could, ...)', (lang) => {
    const problems: string[] = [];
    for (const [key, value] of entriesOf(lang)) for (const form of formsOf(value)) if (ENGLISH_WORDS.test(form)) problems.push(`${key}: English word in ${q(form)}`);
    expectNoProblems(problems, `${localeFile(lang)} English leftovers inside translations`);
  });

  it.each(NON_HU)('%s: never uses the Hungarian-only letters ő / ű', (lang) => {
    const problems: string[] = [];
    for (const [key, value] of entriesOf(lang)) for (const form of formsOf(value)) if (/[őűŐŰ]/.test(form)) problems.push(`${key}: ${q(form)}`);
    expectNoProblems(problems, `${localeFile(lang)} contains Hungarian letters`);
  });

  it.each(LANGUAGES.filter(lang => lang !== 'uk'))('%s: contains no Cyrillic letters', (lang) => {
    const problems: string[] = [];
    for (const [key, value] of entriesOf(lang)) for (const form of formsOf(value)) if (hasCyrillic(form)) problems.push(`${key}: ${q(form)}`);
    expectNoProblems(problems, `${localeFile(lang)} contains Cyrillic`);
  });

  it('uk: every user-facing value contains Cyrillic letters (Latin-only values only for allowed technical keys and pure templates)', () => {
    const problems: string[] = [];
    forEachCommonKey('uk', (key, own) => {
      for (const form of formsOf(own)) {
        if (hasCyrillic(form) || hasNoWords(form) || UK_LATIN_ONLY_OK.has(key)) continue;
        problems.push(`${key}: ${q(form)} has no Cyrillic letters`);
      }
    });
    expectNoProblems(problems, `${localeFile('uk')} untranslated Latin-only values`);
  });

  it('uk: uses Ukrainian, not Russian, letters and no word mixes Latin with Cyrillic homoglyphs', () => {
    const problems: string[] = [];
    for (const [key, value] of entriesOf('uk')) {
      for (const form of formsOf(value)) {
        if (/[ыэъёЫЭЪЁ]/.test(form)) problems.push(`${key}: Russian-only letter in ${q(form)}`);
        for (const word of form.match(/[\p{L}\p{M}]+/gu) ?? []) {
          if (/\p{Script=Latin}/u.test(word) && hasCyrillic(word)) problems.push(`${key}: word ${q(word)} mixes Latin and Cyrillic letters`);
        }
      }
    }
    expectNoProblems(problems, `${localeFile('uk')} script problems`);
  });

  it('uk: units stay Latin "mm" / "MB" (no Cyrillic "мм", "МБ", "Мб")', () => {
    const problems: string[] = [];
    for (const [key, value] of entriesOf('uk')) {
      for (const form of formsOf(value)) if (/(?<![\p{L}])(?:мм|МБ|Мб|мб|Мбайт)(?![\p{L}])/u.test(form)) problems.push(`${key}: ${q(form)}`);
    }
    expectNoProblems(problems, 'Cyrillic unit spellings');
  });

  it.each(LANGUAGES)('%s: uses only the letters of its own alphabet', (lang) => {
    const problems: string[] = [];
    for (const [key, value] of entriesOf(lang)) {
      for (const form of formsOf(value)) {
        const bad = foreignLetters(lang, form);
        if (bad.length > 0) problems.push(`${key}: foreign letter(s) ${[...new Set(bad)].join(' ')} in ${q(form)}`);
      }
    }
    expectNoProblems(problems, `${localeFile(lang)} letters outside the ${lang} alphabet`);
  });

  it.each(LANGUAGES)('%s: keeps its diacritics (not ASCII-stripped)', (lang) => {
    const distinctive: Record<Language, { pattern: RegExp; minimum: number }> = {
      hu: { pattern: /[áéíóöőúüű]/giu, minimum: 100 }, en: { pattern: /[·–…°]/gu, minimum: 10 },
      de: { pattern: /[äöüß]/giu, minimum: 20 }, fr: { pattern: /[àâçéèêëîôùû]/giu, minimum: 50 },
      it: { pattern: /[àèéìòù]/giu, minimum: 30 }, sk: { pattern: /[áäčďéíĺľňóôŕšťúýž]/giu, minimum: 80 },
      pl: { pattern: /[ąćęłńóśźż]/giu, minimum: 80 }, uk: { pattern: /[іїєґ]/giu, minimum: 60 },
    };
    const { pattern, minimum } = distinctive[lang];
    const text = entriesOf(lang).flatMap(([, value]) => formsOf(value)).join('\n');
    expect((text.match(pattern) ?? []).length, `${localeFile(lang)} should contain at least ${minimum} of ${pattern}`).toBeGreaterThanOrEqual(minimum);
  });

  it.each(NON_EN)('%s: sentence punctuation (".", "…", ",") at the end matches English', (lang) => {
    const trailing = (text: string): string => (['.', '…', ','].includes(text.at(-1) ?? '') ? text.at(-1)! : '');
    const problems: string[] = [];
    forEachCommonKey(lang, (key, own, english) => {
      // welcome.lead1 is the first line of one sentence shown on two lines: whether a comma ends it is
      // grammar of the language (no comma before German "und" or French "et"), not truncation.
      if (key === 'welcome.lead1') return;
      const expected = trailing(formsOf(english).at(-1)!);
      for (const form of formsOf(own)) if (trailing(form) !== expected) problems.push(`${key}: ${q(form)} ends with ${q(trailing(form))}, English ends with ${q(expected)}`);
    });
    expectNoProblems(problems, `${localeFile(lang)} truncated or over-punctuated values`);
  });

  it.each(NON_EN)('%s: no value is absurdly longer or shorter than English (layout / truncation guard)', (lang) => {
    const problems: string[] = [];
    forEachCommonKey(lang, (key, own, english) => {
      const englishLength = Math.max(...formsOf(english).map(form => form.length));
      for (const form of formsOf(own)) {
        if (form.length > Math.max(englishLength * 3, englishLength + 30)) problems.push(`${key}: ${form.length} chars vs English ${englishLength} (too long)`);
        if (englishLength >= 20 && form.length < englishLength * 0.3) problems.push(`${key}: ${form.length} chars vs English ${englishLength} (truncated?)`);
      }
    });
    expectNoProblems(problems, `${localeFile(lang)} suspicious value lengths`);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Fixed tokens
// ---------------------------------------------------------------------------------------------
describe('fixed tokens are preserved', () => {
  it('English really contains the tokens this suite protects', () => {
    const all = new Set<string>();
    for (const value of Object.values(EN)) for (const form of formsOf(value)) for (const token of fixedTokens(form)) all.add(token);
    for (const token of ['GENCAD', 'PIN', 'PAD', 'PADSTACK', 'SHAPE', 'COMPONENT', 'PLACE', 'FLIP', 'USER', 'NODE', 'SIGNAL', 'POLYGON', 'END', 'HTTP', 'TRACE', 'MB', 'EAGLE', 'XZZ', '1.4', '64', '90°']) {
      expect(all, `token ${token}`).toContain(token);
    }
  });

  it.each(NON_EN)('%s: record keywords, units (MB), extensions (.cad/.gcd), versions and numbers stay wherever English has them', (lang) => {
    const problems: string[] = [];
    forEachCommonKey(lang, (key, own, english) => {
      const tokens = new Set<string>();
      for (const form of formsOf(english)) for (const token of fixedTokens(form)) tokens.add(token);
      for (const form of formsOf(own)) {
        const missing = [...tokens].filter(token => !form.includes(token));
        if (missing.length > 0) problems.push(`${key}: ${q(form)} lost ${missing.map(q).join(', ')}`);
      }
    });
    expectNoProblems(problems, `${localeFile(lang)} translated fixed tokens`);
  });

  it('the millimetre unit is never localized: no catalog spells it in Cyrillic and the number formatter adds no unit text', () => {
    // English has no standalone "mm" in its catalog (the unit is appended by the UI); any future one must stay Latin "mm".
    const problems: string[] = [];
    for (const lang of LANGUAGES) {
      for (const [key, value] of entriesOf(lang)) for (const form of formsOf(value)) {
        if (/(?<![\p{L}])(?:мм|Мм)(?![\p{L}])/u.test(form)) problems.push(`${lang} ${key}: ${q(form)}`);
      }
    }
    expectNoProblems(problems, 'millimetre unit spelled in Cyrillic');
    for (const lang of LANGUAGES) expect(createFormatters(lang).mm(1)).toMatch(/^[\d.,\s  ]+$/);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Native / web parity
// ---------------------------------------------------------------------------------------------
describe('native and web translators agree', () => {
  it('expose the same languages, tags, defaults and catalogs', () => {
    expect([...native.LANGUAGES]).toEqual([...LANGUAGES]);
    expect(native.LOCALE_TAGS).toEqual(LOCALE_TAGS);
    expect(native.LEGACY_LANGUAGE).toBe(LEGACY_LANGUAGE);
    expect(native.DETECTION_FALLBACK).toBe(DETECTION_FALLBACK);
    for (const lang of LANGUAGES) expect(native.catalogs[lang], `${lang} catalog`).toEqual(catalogs[lang]);
  });

  it('the language list, native names and locale tags are well-formed', () => {
    expect([...LANGUAGES]).toEqual(['hu', 'en', 'de', 'fr', 'it', 'sk', 'pl', 'uk']);
    expect(Object.keys(LANGUAGE_NAMES)).toEqual([...LANGUAGES]);
    expect(Object.keys(LOCALE_TAGS)).toEqual([...LANGUAGES]);
    expect({ ...LANGUAGE_NAMES }).toEqual({
      hu: 'Magyar', en: 'English', de: 'Deutsch', fr: 'Français', it: 'Italiano', sk: 'Slovenčina', pl: 'Polski', uk: 'Українська',
    });
    for (const lang of LANGUAGES) {
      const tag = LOCALE_TAGS[lang];
      expect(tag.split('-')[0]).toBe(lang);
      for (const supported of [Intl.NumberFormat.supportedLocalesOf([tag]), Intl.DateTimeFormat.supportedLocalesOf([tag]), Intl.PluralRules.supportedLocalesOf([tag])]) {
        expect(supported, `${tag} must be supported by the runtime ICU data`).toEqual([tag]);
      }
    }
    expect(DATA_LOCALE).toBe('en');
  });

  it.each(LANGUAGES)('%s: translate() output is identical for every key and sample parameter set', (lang) => {
    const keys = new Set([...EN_KEYS, ...Object.keys(catalogs[lang]), 'no.such.key']);
    const problems: string[] = [];
    for (const key of keys) {
      const names = allPlaceholders(valueOf(lang, key), EN[key]);
      for (const params of sampleParamSets(names)) {
        const web = translate(lang, key, params);
        const twin = native.translate(lang, key, params);
        if (web !== twin) problems.push(`${key} ${JSON.stringify(params)}: web ${q(web)} != native ${q(twin)}`);
      }
    }
    expectNoProblems(problems, `${lang} web/native output differs`);
  });

  it.each(LANGUAGES)('%s: createTranslator() matches translate() on both sides', (lang) => {
    const webT = createTranslator(lang);
    const nativeT = native.createTranslator(lang);
    for (const key of ['header.open', 'unit.pins', 'toast.fileTooLarge', 'parse.warning.danglingNodes', 'no.such.key']) {
      const params = fullParams(key, 22);
      expect(webT(key as never, params)).toBe(translate(lang, key, params));
      expect(nativeT(key, params)).toBe(native.translate(lang, key, params));
      expect(webT(key as never, params)).toBe(nativeT(key, params));
    }
  });

  it('web translators and formatters are memoised so React dependencies stay stable', () => {
    for (const lang of LANGUAGES) {
      expect(createTranslator(lang)).toBe(createTranslator(lang));
      expect(createFormatters(lang)).toBe(createFormatters(lang));
    }
  });

  const TAGS: unknown[] = [
    'de-AT', 'DE-at', 'de', 'fr-CA', 'fr', 'it-CH', 'sk-SK', 'sk', 'pl-PL', 'pl', 'uk-UA', 'uk_UA', 'uk', 'hu-HU', 'hu', 'en-GB', 'EN-us', 'en',
    'pt-BR', 'zz', 'zh-Hans-CN', 'und', 'ukr', 'deu', 'English', '', '  ', '  de-DE  ', '-', '_de', 'de_', 'sl-SI', 'cs-CZ', 'ru-RU', 'nb-NO',
    null, undefined,
    ['fr-CA', 'en'], ['zz', 'pl-PL'], ['pt-BR', 'es-ES'], ['pt-BR', 'uk-UA', 'de'], [], [null, 'it'], ['', 'sk'], [undefined, 3, 'hu-HU'], ['EN', 'de'],
  ];
  it('detectLanguage() agrees on many tags and tag lists', () => {
    for (const input of TAGS) {
      const expected = detectLanguage(input as never);
      expect(native.detectLanguage(input), `detectLanguage(${JSON.stringify(input)})`).toBe(expected);
      expect(isLanguage(expected)).toBe(true);
    }
  });

  it('resolveLanguage(), isLanguage() and normalizeLanguage() agree for stored values, fresh/legacy profiles and system lists', () => {
    const stored: unknown[] = [...LANGUAGES, 'xx', 'DE', ' de', '', null, undefined, 3, {}, ['de'], 'hu-HU'];
    const systems: unknown[] = [undefined, null, '', 'de-AT', 'fr-CA', 'uk-UA', 'pt-BR', ['zz', 'pl-PL'], ['pt-BR'], []];
    for (const value of stored) {
      expect(native.isLanguage(value)).toBe(isLanguage(value));
      expect(native.normalizeLanguage(value)).toBe(normalizeLanguage(value));
      for (const fresh of [true, false]) for (const system of systems) {
        expect(native.resolveLanguage(value, { fresh, system }), `resolveLanguage(${JSON.stringify(value)}, fresh=${fresh}, ${JSON.stringify(system)})`)
          .toBe(resolveLanguage(value, { fresh, system: system as never }));
      }
    }
  });

  it('native-only tolerance: an unknown language falls back to Hungarian, and missing resolve options mean a legacy profile', () => {
    expect(native.translate('xx', 'header.open')).toBe(translate('hu', 'header.open'));
    expect(native.translate(undefined as never, 'header.open')).toBe(translate('hu', 'header.open'));
    expect(native.resolveLanguage('xx')).toBe('hu');
    expect(native.resolveLanguage('de')).toBe('de');
  });
});

// ---------------------------------------------------------------------------------------------
// 7. Fallback behaviour (patched copies of the catalogs, always restored)
// ---------------------------------------------------------------------------------------------
type Translate = (language: string, key: string, params?: Params) => string;
type Removal = readonly [Language, string];

/** Native twin built from the real source, with catalogs that lack the removed keys. No shared state is touched. */
function nativeWithout(removals: readonly Removal[]): NativeI18n {
  const source = readText('electron/i18n.cjs');
  const module = { exports: {} as unknown };
  const localRequire = (request: string): unknown => {
    if (request !== './locale-catalogs.cjs') return nativeRequire(request);
    const real = nativeRequire('../../electron/locale-catalogs.cjs') as { loadCatalog(language: string): Record<string, CatalogValue> };
    return {
      loadCatalog: (language: string) => {
        const copy = { ...real.loadCatalog(language) };
        for (const [lang, key] of removals) if (lang === language) delete copy[key];
        return copy;
      },
    };
  };
  new Function('module', 'exports', 'require', source)(module, module.exports, localRequire);
  return module.exports as NativeI18n;
}
/** Run `check` against the web translator (exported `catalogs` temporarily swapped, restored in finally) and the native twin. */
function withoutKeys(removals: readonly Removal[], check: (translateWith: Translate, side: string) => void): void {
  const mutable = catalogs as unknown as Record<Language, Record<string, CatalogValue>>;
  const originals = new Map<Language, Record<string, CatalogValue>>();
  try {
    for (const lang of new Set(removals.map(([language]) => language))) {
      originals.set(lang, mutable[lang]);
      const copy = { ...mutable[lang] };
      for (const [removedLang, key] of removals) if (removedLang === lang) delete copy[key];
      mutable[lang] = copy;
    }
    check(translate, 'web');
  } finally {
    for (const [lang, original] of originals) mutable[lang] = original;
  }
  check(nativeWithout(removals).translate, 'native');
}

describe('fallback behaviour', () => {
  const PLAIN = 'header.open';
  const PLURAL = 'unit.pins';

  it('an unknown key renders as the key itself, never as undefined, on both sides', () => {
    for (const lang of LANGUAGES) {
      expect(translate(lang, 'no.such.key')).toBe('no.such.key');
      expect(translate(lang, 'no.such.key', { count: 3, name: 'x' })).toBe('no.such.key');
      expect(native.translate(lang, 'no.such.key', { count: 3 })).toBe('no.such.key');
    }
    expect(translate('de', 'constructor')).toBe('constructor');
    expect(translate('de', 'toString')).toBe('toString');
    expect(translate('de', '__proto__')).toBe('__proto__');
    expect(native.translate('de', 'hasOwnProperty')).toBe('hasOwnProperty');
  });

  it('a missing placeholder parameter stays visible instead of throwing or printing undefined', () => {
    expect(translate('en', 'list.rowTitle', { ref: 'R1' })).toBe('R1 · {value} · {side}');
    expect(native.translate('hu', 'list.rowTitle')).toBe('{ref} · {value} · {side}');
  });

  it.each(TRANSLATED)('%s: a key missing from the catalog falls back to English, then Hungarian, then the key', (lang) => {
    const english = EN[PLAIN] as string;
    const hungarian = catalogs.hu[PLAIN] as string;
    withoutKeys([[lang, PLAIN]], (translateWith, side) => expect(translateWith(lang, PLAIN), `${side}: ${lang} lacks the key`).toBe(english));
    withoutKeys([[lang, PLAIN], ['en', PLAIN]], (translateWith, side) => expect(translateWith(lang, PLAIN), `${side}: ${lang} and en lack the key`).toBe(hungarian));
    withoutKeys([[lang, PLAIN], ['en', PLAIN], ['hu', PLAIN]], (translateWith, side) => expect(translateWith(lang, PLAIN), `${side}: all lack the key`).toBe(PLAIN));
    withoutKeys([['en', PLAIN]], (translateWith, side) => expect(translateWith(lang, PLAIN), `${side}: ${lang} keeps its own value when en lacks the key`).toBe(catalogs[lang][PLAIN] ?? hungarian));
  });

  it.each(TRANSLATED)('%s: a missing plural key falls back to the English plural forms chosen with the language rules and number format', (lang) => {
    const number = new Intl.NumberFormat(LOCALE_TAGS[lang]);
    withoutKeys([[lang, PLURAL]], (translateWith, side) => {
      expect(translateWith(lang, PLURAL, { count: 1 }), side).toBe('1 pin');
      expect(translateWith(lang, PLURAL, { count: 2 }), side).toBe('2 pins');
      expect(translateWith(lang, PLURAL, { count: 5 }), side).toBe('5 pins');
      expect(translateWith(lang, PLURAL, { count: 1234567 }), side).toBe(`${number.format(1234567)} pins`);
    });
  });

  it('English falls back to Hungarian, and Hungarian to English, for a missing key', () => {
    withoutKeys([['en', PLAIN]], (translateWith, side) => expect(translateWith('en', PLAIN), side).toBe(catalogs.hu[PLAIN] as string));
    withoutKeys([['hu', PLAIN]], (translateWith, side) => expect(translateWith('hu', PLAIN), side).toBe(EN[PLAIN] as string));
    withoutKeys([['hu', PLAIN], ['en', PLAIN]], (translateWith, side) => expect(translateWith('hu', PLAIN), side).toBe(PLAIN));
  });

  it('patching leaves the shared catalogs untouched', () => {
    const before = LANGUAGES.map(lang => catalogs[lang]);
    withoutKeys([['de', PLAIN], ['en', PLAIN]], () => undefined);
    expect(LANGUAGES.map(lang => catalogs[lang])).toEqual(before);
    for (const [index, lang] of LANGUAGES.entries()) expect(catalogs[lang]).toBe(before[index]);
    expect(translate('en', PLAIN)).toBe(EN[PLAIN]);
  });
});

// ---------------------------------------------------------------------------------------------
// 8. Language selection and migration
// ---------------------------------------------------------------------------------------------
describe('language selection and migration', () => {
  it.each([
    ['de-AT', 'de'], ['DE-at', 'de'], ['de', 'de'], ['fr-CA', 'fr'], ['fr_FR', 'fr'], ['it-CH', 'it'], ['sk-SK', 'sk'], ['pl-PL', 'pl'], ['uk-UA', 'uk'], ['uk_UA', 'uk'],
    ['hu-HU', 'hu'], ['en-GB', 'en'], ['EN-us', 'en'], ['  de-DE  ', 'de'],
    ['pt-BR', 'en'], ['zh-Hans-CN', 'en'], ['ru-RU', 'en'], ['ukr', 'en'], ['', 'en'], ['und', 'en'], ['-', 'en'],
  ] as const)('detectLanguage(%j) = %s', (tag, expected) => {
    expect(detectLanguage(tag)).toBe(expected);
  });

  it('detectLanguage() takes the first supported tag of a preference list and otherwise English', () => {
    expect(detectLanguage(['fr-CA', 'en'])).toBe('fr');
    expect(detectLanguage(['zz', 'pl-PL'])).toBe('pl');
    expect(detectLanguage(['pt-BR', 'uk-UA', 'de'])).toBe('uk');
    expect(detectLanguage([null, undefined, '', 'sk'])).toBe('sk');
    expect(detectLanguage(['pt-BR', 'es-ES'])).toBe('en');
    expect(detectLanguage([])).toBe('en');
    expect(detectLanguage(null)).toBe('en');
    expect(detectLanguage(undefined)).toBe('en');
  });

  it('an explicit valid language always wins, for fresh and for existing profiles', () => {
    for (const lang of LANGUAGES) {
      for (const fresh of [true, false]) {
        expect(resolveLanguage(lang, { fresh, system: 'de-AT' })).toBe(lang);
        expect(resolveLanguage(lang, { fresh })).toBe(lang);
      }
    }
    expect(resolveLanguage('it', { fresh: true, system: ['fr-FR'] })).toBe('it');
  });

  it.each([['xx'], ['DE'], [' de'], [''], [null], [undefined], [3], [{}], [['de']], ['hu-HU']] as const)('an invalid stored language (%j) on a fresh profile follows the system language', (stored) => {
    expect(resolveLanguage(stored, { fresh: true, system: 'de-AT' })).toBe('de');
    expect(resolveLanguage(stored, { fresh: true, system: 'fr-CA' })).toBe('fr');
    expect(resolveLanguage(stored, { fresh: true, system: 'uk-UA' })).toBe('uk');
    expect(resolveLanguage(stored, { fresh: true, system: ['zz', 'pl-PL'] })).toBe('pl');
    expect(resolveLanguage(stored, { fresh: true, system: 'pt-BR' })).toBe('en');
    expect(resolveLanguage(stored, { fresh: true, system: [] })).toBe('en');
    expect(resolveLanguage(stored, { fresh: true })).toBe('en');
  });

  it.each([['xx'], [''], [null], [undefined], [3], [{}]] as const)('an existing profile without a valid language (%j) keeps the Hungarian UI it was used with', (stored) => {
    expect(LEGACY_LANGUAGE).toBe('hu');
    for (const system of [undefined, 'de-AT', 'fr-CA', ['uk-UA'], 'pt-BR']) {
      expect(resolveLanguage(stored, { fresh: false, system: system as never })).toBe('hu');
    }
  });

  it('isLanguage()/normalizeLanguage() accept exactly the eight codes', () => {
    for (const lang of LANGUAGES) { expect(isLanguage(lang)).toBe(true); expect(normalizeLanguage(lang)).toBe(lang); }
    for (const value of ['DE', 'de-AT', 'xx', '', null, undefined, 1, {}, ['de'], 'toString', '__proto__', 'constructor']) {
      expect(isLanguage(value)).toBe(false);
      expect(normalizeLanguage(value)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 9. Formatting and parser messages
// ---------------------------------------------------------------------------------------------
describe('locale formatting', () => {
  it('formats millimetres with exactly two decimals using the locale separators', () => {
    // 12 345.5 has a group separator in every locale; 1 234.5 shows the per-locale minimum grouping digits (hu/it/pl write 1234,50).
    expect(createFormatters('hu').mm(12345.5)).toBe('12 345,50');
    expect(createFormatters('hu').mm(1234.5)).toBe('1234,50');
    expect(createFormatters('en').mm(12345.5)).toBe('12,345.50');
    expect(createFormatters('en').mm(1234.5)).toBe('1,234.50');
    expect(createFormatters('de').mm(12345.5)).toBe('12.345,50');
    expect(createFormatters('de').mm(1234.5)).toBe('1.234,50');
    expect(createFormatters('fr').mm(12345.5)).toBe('12 345,50');
    expect(createFormatters('fr').mm(1234.5)).toBe('1 234,50');
    expect(createFormatters('en').mm(2)).toBe('2.00');
    expect(createFormatters('de').mm(0)).toBe('0,00');
    expect(createFormatters('en').mm(0.5)).toBe('0.50');
    expect(createFormatters('en').mm(-1234.567)).toBe('-1,234.57');
  });

  it.each(LANGUAGES)('%s: mm() and count() follow Intl.NumberFormat of the locale tag', (lang) => {
    const tag = LOCALE_TAGS[lang];
    const two = new Intl.NumberFormat(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const plain = new Intl.NumberFormat(tag);
    const formatters = createFormatters(lang);
    for (const value of [0, 0.5, 1, 7.125, 1234.5, 12345.5, 1234567.891, -42.42]) {
      expect(formatters.mm(value)).toBe(two.format(value));
      expect(formatters.mm(value)).toMatch(/[,.]\d\d$/);
      expect(formatters.count(value)).toBe(plain.format(value));
    }
  });

  it('formats counts with the locale grouping', () => {
    expect(createFormatters('hu').count(1234567)).toBe('1 234 567');
    expect(createFormatters('en').count(1234567)).toBe('1,234,567');
    expect(createFormatters('de').count(1234567)).toBe('1.234.567');
    expect(createFormatters('fr').count(1234567)).toBe('1 234 567');
    expect(createFormatters('uk').count(1234567)).toMatch(/^1\s234\s567$/);
  });

  it('formats dates with dateStyle medium and shows an em dash for invalid dates', () => {
    const local = '2026-03-15T12:00:00'; // no zone designator: the calendar day is the same in every time zone
    expect(createFormatters('en').date(local)).toBe('15 Mar 2026');
    expect(createFormatters('de').date(local)).toBe('15.03.2026');
    expect(createFormatters('hu').date(local)).toBe('2026. márc. 15.');
    for (const lang of LANGUAGES) {
      const expected = new Intl.DateTimeFormat(LOCALE_TAGS[lang], { dateStyle: 'medium' });
      expect(createFormatters(lang).date(local)).toBe(expected.format(Date.parse(local)));
      expect(createFormatters(lang).date('2026-03-15T12:00:00.000Z')).toBe(expected.format(Date.parse('2026-03-15T12:00:00.000Z')));
      for (const invalid of ['', 'not a date', 'Infinity', '2026-13-45', 'undefined']) expect(createFormatters(lang).date(invalid)).toBe('—');
    }
  });
});

describe('parser messages', () => {
  it('formatIssue() appends the localized "(line N)" suffix to the message', () => {
    expect(formatIssue('en', { key: 'parse.error.empty', line: 12 })).toBe('The file is empty. (line 12)');
    expect(formatIssue('hu', { key: 'parse.error.empty', line: 12 })).toBe('A fájl üres. (12. sor)');
    for (const lang of LANGUAGES) {
      const base = translate(lang, 'parse.error.empty');
      const suffix = translate(lang, 'parse.lineSuffix', { line: '12' });
      expect(formatIssue(lang, { key: 'parse.error.empty', line: 12 })).toBe(`${base} ${suffix}`);
      expect(suffix, `${lang} suffix`).toMatch(/^\(.*\b12\b.*\)$/);
      expect(formatIssue(lang, { key: 'parse.error.empty' })).toBe(base);
      // Line numbers are identifiers, not quantities: they are not grouped by the locale.
      expect(formatIssue(lang, { key: 'parse.error.empty', line: 1234567 })).toContain('1234567');
    }
  });

  it.each(LANGUAGES)('%s: numeric ParseIssue parameters are localized, string parameters are kept verbatim', (lang) => {
    const grouped = new Intl.NumberFormat(LOCALE_TAGS[lang]).format(1234567);
    const issue: ParseIssue = { key: 'parse.warning.danglingNodes', params: { count: 1234567, examples: 'R1.1, U2.7' } };
    const text = formatIssue(lang, issue);
    expect(text).toContain(grouped);
    expect(text).toContain('R1.1, U2.7');
    const tooLarge = formatIssue(lang, { key: 'parse.error.tooLarge' });
    expect(tooLarge).toContain('64');
    const issueWithString: ParseIssue = { key: 'parse.warning.danglingNodes', params: { count: 1234567, examples: '1234567' } };
    expect(formatIssue(lang, issueWithString).split('1234567').length - 1).toBe(1);
  });

  const PARSE_KEYS = EN_KEYS.filter(key => /^parse\.(?:error|warning)\./.test(key));
  it('there are parser error and warning messages to render', () => {
    expect(PARSE_KEYS.length).toBeGreaterThan(50);
    expect(PARSE_KEYS.filter(key => key.startsWith('parse.warning.')).length).toBeGreaterThanOrEqual(7);
  });

  it.each(LANGUAGES)('%s: formatIssue() renders every parse.* key without leftover {placeholders}', (lang) => {
    const problems: string[] = [];
    for (const key of PARSE_KEYS) {
      for (const count of isPluralObject(EN[key]) ? [0, 1, 2, 5, 22, 1234567] : [3]) {
        for (const line of [undefined, 7]) {
          const issue = { key, params: fullParams(key, count), line } as ParseIssue;
          const text = formatIssue(lang, issue);
          if (/\{\w*\}/.test(text)) problems.push(`${key} count=${count} line=${line}: leftover placeholder in ${q(text)}`);
          if (/undefined|NaN|\[object/.test(text)) problems.push(`${key}: bad interpolation in ${q(text)}`);
          if (text === key) problems.push(`${key}: not found in ${lang} (renders as the key)`);
          for (const name of allPlaceholders(EN[key])) {
            const value = String((issue.params as Params)[name]);
            if (name !== 'count' && !text.includes(value)) problems.push(`${key}: parameter {${name}} is not rendered in ${q(text)}`);
          }
        }
      }
    }
    expectNoProblems(problems, `${lang} parser messages`);
  });
});

// ---------------------------------------------------------------------------------------------
// Documentation and native integration gates
// ---------------------------------------------------------------------------------------------
describe('documentation', () => {
  it('README names every supported language by its native name', () => {
    const readme = readText('README.md');
    for (const lang of LANGUAGES) expect(readme, `README should list ${LANGUAGE_NAMES[lang]}`).toContain(LANGUAGE_NAMES[lang]);
  });

  it('CONTRIBUTING explains where the catalogs live', () => {
    const contributing = readText('CONTRIBUTING.md');
    expect(contributing).toContain('electron/locales/');
    expect(contributing).toMatch(/\{count\}/);
  });
});

// These checks switch on automatically once electron/main.cjs uses the shared catalogs (t('native.…')).
// main.cjs hands its translator to store.cjs, repair-store.cjs and documents.cjs, so the keys they look up count as used too.
const mainSource = readText('electron/main.cjs');
const preloadSource = readText('electron/preload.cjs');
const nativeKeySource = ['main', 'store', 'repair-store', 'documents', 'workspace', 'identity', 'formats'].map(name => readText(`electron/${name}.cjs`)).join('\n');
const nativeKeysUsed = [...nativeKeySource.matchAll(/\bt\(\s*'([^']+)'/g)].map(match => match[1]);
const HUNGARIAN_LETTERS = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/;

describe.skipIf(nativeKeysUsed.length === 0)('native shell uses the shared catalogs', () => {
  it('every t() key used by the native modules is a native.* key that exists in the English catalog', () => {
    const problems = nativeKeysUsed.filter(key => !key.startsWith('native.') || !Object.hasOwn(EN, key));
    expectNoProblems(problems, 'unknown or non-native keys in the electron/*.cjs modules');
  });

  it('every native.* catalog key is used by the native modules (no dead messages, no forgotten Hungarian string)', () => {
    const unused = EN_KEYS.filter(key => key.startsWith('native.') && !nativeKeysUsed.includes(key));
    expectNoProblems(unused, 'native.* keys never used by the electron/*.cjs modules');
  });

  it('electron/main.cjs and electron/preload.cjs contain no Hungarian text, and preload stays standalone', () => {
    const lines = (source: string): string[] => source.split(/\r?\n/).map((line, index) => `${index + 1}: ${line.trim()}`).filter(line => HUNGARIAN_LETTERS.test(line));
    expectNoProblems(lines(mainSource), 'Hungarian text left in electron/main.cjs');
    expectNoProblems(lines(preloadSource), 'Hungarian text left in electron/preload.cjs');
    expect(preloadSource, 'the sandboxed preload cannot require local modules').not.toMatch(/require\(\s*['"]\.\//);
  });
});
