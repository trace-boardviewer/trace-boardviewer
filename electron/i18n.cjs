'use strict';

// Native twin of src/lib/i18n.ts: same catalogs (electron/locales/*.json), same lookup, plural,
// interpolation and language-migration rules. tests verify that both produce identical text.
const LANGUAGES = Object.freeze(['hu', 'en', 'de', 'fr', 'it', 'sk', 'pl', 'uk']);
const LEGACY_LANGUAGE = 'hu';
const DETECTION_FALLBACK = 'en';
const LOCALE_TAGS = Object.freeze({
  hu: 'hu-HU', en: 'en-GB', de: 'de-DE', fr: 'fr-FR', it: 'it-IT', sk: 'sk-SK', pl: 'pl-PL', uk: 'uk-UA',
});
const catalogs = Object.freeze({
  hu: require('./locales/hu.json'), en: require('./locales/en.json'), de: require('./locales/de.json'),
  fr: require('./locales/fr.json'), it: require('./locales/it.json'), sk: require('./locales/sk.json'),
  pl: require('./locales/pl.json'), uk: require('./locales/uk.json'),
});
const FALLBACK_CHAIN = ['en', 'hu'];
const pluralRules = new Map();
const numberFormats = new Map();

function isLanguage(value) { return typeof value === 'string' && LANGUAGES.includes(value); }
function normalizeLanguage(value) { return isLanguage(value) ? value : undefined; }

function detectLanguage(input) {
  const tags = Array.isArray(input) ? input : [input];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (isLanguage(primary)) return primary;
  }
  return DETECTION_FALLBACK;
}

function resolveLanguage(stored, options) {
  const explicit = normalizeLanguage(stored);
  if (explicit) return explicit;
  return options && options.fresh ? detectLanguage(options.system) : LEGACY_LANGUAGE;
}

function numberFormat(language) {
  let format = numberFormats.get(language);
  if (!format) { format = new Intl.NumberFormat(LOCALE_TAGS[language]); numberFormats.set(language, format); }
  return format;
}

function lookup(language, key) {
  for (const candidate of [language, ...FALLBACK_CHAIN]) {
    const catalog = catalogs[candidate];
    if (catalog && Object.hasOwn(catalog, key)) return catalog[key];
  }
  return undefined;
}

function translate(language, key, params) {
  const lang = isLanguage(language) ? language : LEGACY_LANGUAGE;
  const value = lookup(lang, key);
  if (value === undefined) return key;
  let text;
  if (typeof value === 'string') text = value;
  else {
    let rules = pluralRules.get(lang);
    if (!rules) { rules = new Intl.PluralRules(LOCALE_TAGS[lang]); pluralRules.set(lang, rules); }
    const count = params && params.count;
    text = (typeof count === 'number' ? value[rules.select(count)] : undefined) ?? value.other;
  }
  return text.replace(/\{(\w+)\}/g, (match, name) => {
    const parameter = params ? params[name] : undefined;
    return parameter === undefined ? match : typeof parameter === 'number' ? numberFormat(lang).format(parameter) : String(parameter);
  });
}

function createTranslator(language) { return (key, params) => translate(language, key, params); }

module.exports = Object.freeze({
  LANGUAGES, LEGACY_LANGUAGE, DETECTION_FALLBACK, LOCALE_TAGS, catalogs,
  isLanguage, normalizeLanguage, detectLanguage, resolveLanguage, translate, createTranslator,
});
