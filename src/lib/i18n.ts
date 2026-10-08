import { en } from './i18n-english';

/**
 * One translation core shared (by contract) with electron/i18n.cjs: the same catalogs in
 * electron/locales/<language>/<namespace>.json, the same lookup, plural and interpolation rules. Both are covered by
 * a parity test, so a native dialog and the web UI always say the same thing in a language.
 */
export const LANGUAGES = ['hu', 'en', 'de', 'fr', 'it', 'sk', 'pl', 'uk'] as const;
export type Language = (typeof LANGUAGES)[number];

/** The original UI language: profiles saved before language support keep it. */
export const LEGACY_LANGUAGE: Language = 'hu';
/** Used when the system language is none of the supported ones. */
export const DETECTION_FALLBACK: Language = 'en';

/** Native names (autonyms) for the language selector. They are never translated. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  hu: 'Magyar', en: 'English', de: 'Deutsch', fr: 'Français', it: 'Italiano', sk: 'Slovenčina', pl: 'Polski', uk: 'Українська',
};
export const LOCALE_TAGS: Readonly<Record<Language, string>> = {
  hu: 'hu-HU', en: 'en-GB', de: 'de-DE', fr: 'fr-FR', it: 'it-IT', sk: 'sk-SK', pl: 'pl-PL', uk: 'uk-UA',
};
/** Board data (references, net names) is ordered the same way in every UI language. */
export const DATA_LOCALE = 'en';

/** English is the type source: a key exists when `electron/locales/en/` has it (see ./i18n-english.ts). */
export type MessageKey = keyof typeof en;
export type Params = Readonly<Record<string, string | number>>;
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type CatalogValue = string | PluralForms;
export type Catalog = Readonly<Record<string, CatalogValue>>;
export type Translator = (key: MessageKey, params?: Params) => string;

/**
 * Every namespace file of the other seven languages (English is imported by name in ./i18n-english.ts, which gives it its type).
 * The glob is resolved by Vite at build time; a new namespace needs no registration here.
 */
const namespaceFiles = import.meta.glob<Catalog>(['../../electron/locales/*/*.json', '!../../electron/locales/en/*.json'], { eager: true, import: 'default' });

/** Merges the namespace files of each language into one flat catalog; a key defined twice is a defect and throws. */
function mergeCatalogs(): Readonly<Record<Language, Catalog>> {
  const merged: Record<Language, Record<string, CatalogValue>> = { hu: {}, en: { ...en }, de: {}, fr: {}, it: {}, sk: {}, pl: {}, uk: {} };
  const origin = new Map<string, string>();
  for (const [file, part] of Object.entries(namespaceFiles).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const match = /\/locales\/([a-z]+)\/([^/]+)\.json$/.exec(file);
    const language = match?.[1] as Language | undefined;
    if (!match || !language || !Object.hasOwn(merged, language)) continue;
    for (const [key, value] of Object.entries(part)) {
      const id = `${language}:${key}`;
      if (origin.has(id)) throw new Error(`Locale key "${key}" of "${language}" is defined in both ${origin.get(id)}.json and ${match[2]}.json`);
      origin.set(id, match[2]);
      merged[language][key] = value;
    }
  }
  return merged;
}

export const catalogs: Readonly<Record<Language, Catalog>> = mergeCatalogs();

export type ParseKey = Extract<MessageKey, `parse.error.${string}` | `parse.warning.${string}`>;
/** A parser message that stays structured, so it can be shown in whichever language is active. */
export interface ParseIssue { key: ParseKey; params?: Params; line?: number }

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}
export function normalizeLanguage(value: unknown): Language | undefined {
  return isLanguage(value) ? value : undefined;
}

/** First supported language among BCP 47 tags such as ["de-AT", "en-US"]; otherwise English. */
export function detectLanguage(input: string | null | undefined | readonly (string | null | undefined)[]): Language {
  const tags: readonly unknown[] = Array.isArray(input) ? input : [input];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (isLanguage(primary)) return primary;
  }
  return DETECTION_FALLBACK;
}

/**
 * Language migration: a stored valid language always wins. A profile that predates language
 * support keeps the Hungarian UI it was used with; only a fresh profile follows the system.
 */
export function resolveLanguage(stored: unknown, options?: { fresh: boolean; system?: string | null | readonly (string | null | undefined)[] }): Language {
  const explicit = normalizeLanguage(stored);
  if (explicit) return explicit;
  return options?.fresh ? detectLanguage(options.system) : LEGACY_LANGUAGE;
}

const FALLBACK_CHAIN: readonly Language[] = ['en', 'hu'];
const pluralRules = new Map<Language, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(language: Language, digits?: number): Intl.NumberFormat {
  const id = `${language}:${digits ?? ''}`;
  let format = numberFormats.get(id);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE_TAGS[language], digits === undefined ? undefined : { minimumFractionDigits: digits, maximumFractionDigits: digits });
    numberFormats.set(id, format);
  }
  return format;
}

function lookup(language: Language, key: string): CatalogValue | undefined {
  for (const candidate of [language, ...FALLBACK_CHAIN]) {
    const catalog = catalogs[candidate];
    if (Object.hasOwn(catalog, key)) return catalog[key];
  }
  return undefined;
}

/**
 * Plural objects are chosen by the CLDR rules of the language through `params.count`, which must be
 * a number. Numeric params are formatted for the language; string params are inserted verbatim.
 * An unknown language falls back to the legacy Hungarian one instead of throwing.
 */
export function translate(language: Language, key: string, params?: Params): string {
  const lang: Language = isLanguage(language) ? language : LEGACY_LANGUAGE;
  const value = lookup(lang, key);
  if (value === undefined) return key;
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    let rules = pluralRules.get(lang);
    if (!rules) { rules = new Intl.PluralRules(LOCALE_TAGS[lang]); pluralRules.set(lang, rules); }
    const count = params?.count;
    text = (typeof count === 'number' ? value[rules.select(count)] : undefined) ?? value.other;
  }
  // A replacer function keeps "$" in catalog text (e.g. "$END") literal.
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const parameter = params?.[name];
    return parameter === undefined ? match : typeof parameter === 'number' ? numberFormat(lang).format(parameter) : parameter;
  });
}

const translators = new Map<Language, Translator>();
export function createTranslator(language: Language): Translator {
  const lang: Language = isLanguage(language) ? language : LEGACY_LANGUAGE;
  let translator = translators.get(lang);
  if (!translator) { translator = (key, params) => translate(lang, key, params); translators.set(lang, translator); }
  return translator;
}

export function formatIssue(language: Language, issue: ParseIssue): string {
  const text = translate(language, issue.key, issue.params);
  return issue.line ? `${text} ${translate(language, 'parse.lineSuffix', { line: String(issue.line) })}` : text;
}

/**
 * A user-facing message kept as data until it is drawn, so one that is still on screen (a toast,
 * a note warning, a file warning) switches language together with the rest of the interface.
 * `text` is text that is already localized elsewhere, e.g. an error produced by the native process.
 */
export type MessageParam = string | number | Message;
export type Message =
  | { key: MessageKey; params?: Readonly<Record<string, MessageParam>> }
  | { issue: ParseIssue }
  | { text: string };

export function renderMessage(language: Language, message: Message): string {
  if ('text' in message) return message.text;
  if ('issue' in message) return formatIssue(language, message.issue);
  const params = message.params && Object.fromEntries(Object.entries(message.params).map(([name, value]) => [name, typeof value === 'object' ? renderMessage(language, value) : value]));
  return translate(language, message.key, params);
}

export interface Formatters {
  /** Millimetre value with exactly two decimals; the unit stays "mm" in every language. */
  mm(value: number): string;
  count(value: number): string;
  date(iso: string): string;
}
const formatters = new Map<Language, Formatters>();
export function createFormatters(language: Language): Formatters {
  const lang: Language = isLanguage(language) ? language : LEGACY_LANGUAGE;
  let value = formatters.get(lang);
  if (!value) {
    const dates = new Intl.DateTimeFormat(LOCALE_TAGS[lang], { dateStyle: 'medium' });
    value = {
      mm: n => numberFormat(lang, 2).format(n),
      count: n => numberFormat(lang).format(n),
      date: iso => { const time = Date.parse(iso); return Number.isFinite(time) ? dates.format(time) : '—'; },
    };
    formatters.set(lang, value);
  }
  return value;
}
