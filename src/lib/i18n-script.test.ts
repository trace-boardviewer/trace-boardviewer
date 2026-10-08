import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * scripts/i18n.cjs: adds a key to the right namespace of all eight languages and moves keys of an older flat layout into the
 * namespaces. Every test works on a copy of electron/locales in a temporary folder; the real catalogs are never written.
 */
type Value = string | Record<string, string>;
interface Model { root: string; texts: Record<string, Record<string, string>>; changed: Set<string> }
interface Script {
  LANGUAGES: string[];
  UsageError: new (message: string) => Error;
  loadModel(root: string): Model;
  keyLocations(model: Model): Map<string, string>;
  namespacesOf(model: Model): string[];
  saveModel(model: Model): void;
  insertEntry(text: string, key: string, value: Value): string;
  replaceEntry(text: string, key: string, value: Value): string;
  checkValues(key: string, values: Record<string, Value>): string[];
  addKey(model: Model, key: string, values: Record<string, Value>, options?: { namespace?: string; createNamespace?: boolean }): string;
  changeKey(model: Model, key: string, values: Record<string, Value>): string;
  importFlat(model: Model, folder: string, options?: { namespace?: string; applyChanges?: boolean; base?: string }): { added: Array<{ key: string; namespace: string }>; changed: Array<{ key: string; languages: string[] }>; removed: string[]; unchanged: number; problems: string[] };
  parseArguments(argv: string[]): { positional: string[]; values: Record<string, Value>; valuesFile?: string; namespace?: string; [flag: string]: unknown };
  parseValue(text: string): Value;
}
const nativeRequire = createRequire(import.meta.url);
const script = nativeRequire('../../scripts/i18n.cjs') as Script;
const catalogs = nativeRequire('../../electron/locale-catalogs.cjs') as { LOCALES_DIRECTORY: string; loadCatalog(language: string, root?: string): Record<string, Value> };
const { LANGUAGES } = script;
// Every test copies the catalogs and reads them back: a few hundred milliseconds alone, seconds on a busy machine. The limit only ends a test that never returns.
const LOADED_MACHINE = { timeout: 120_000 };

function withCopy<T>(run: (root: string) => T): T {
  const directory = mkdtempSync(path.join(tmpdir(), 'trace-i18n-script-'));
  try {
    const root = path.join(directory, 'locales');
    cpSync(catalogs.LOCALES_DIRECTORY, root, { recursive: true });
    return run(root);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const forms = (language: string): string[] => ({ pl: ['one', 'few', 'many', 'other'], uk: ['one', 'few', 'many', 'other'], sk: ['one', 'few', 'other'] }[language] ?? ['one', 'other']);
const textValues = (label: string): Record<string, Value> => Object.fromEntries(LANGUAGES.map(language => [language, `${label} ${language}`]));
const pluralValues = (): Record<string, Value> => Object.fromEntries(LANGUAGES.map(language => [language, Object.fromEntries(forms(language).map(form => [form, `{count} ${language}-${form}`]))]));
const merged = (root: string, language: string): Record<string, Value> => catalogs.loadCatalog(language, root);
const lines = (text: string): string[] => text.split('\n');

describe('adding a key', LOADED_MACHINE, () => {
  it('writes it into the namespace of its area, after the last key of that area, in all eight languages', () => {
    withCopy((root) => {
      const before = Object.fromEntries(LANGUAGES.map(language => [language, merged(root, language)]));
      const model = script.loadModel(root);
      expect(script.addKey(model, 'notes.sampleKey', textValues('Sample'))).toBe('notes');
      script.saveModel(model);
      const files = readdirSync(path.join(root, 'en'));
      expect(files).toContain('notes.json');
      for (const language of LANGUAGES) {
        const text = readFileSync(path.join(root, language, 'notes.json'), 'utf8');
        const keys = Object.keys(JSON.parse(text) as object);
        expect(keys.at(-1), `${language}: the new key follows the last notes key`).toBe('notes.sampleKey');
        const after = merged(root, language);
        expect(after['notes.sampleKey']).toBe(`Sample ${language}`);
        // Nothing else changed: same keys and values; the file differs by the new line and one trailing comma.
        const { 'notes.sampleKey': added, ...rest } = after;
        expect(added).toBeDefined();
        expect(rest).toEqual(before[language]);
        expect(readFileSync(path.join(root, language, 'notes.json'), 'utf8').endsWith('\n}\n')).toBe(true);
      }
    });
  });

  it('puts the new key between the keys of its area when the area is not the last one, keeping the blank line between groups', () => {
    withCopy((root) => {
      const model = script.loadModel(root);
      script.addKey(model, 'side.sampleKey', textValues('Sample'));
      const text = model.texts.en.common;
      const order = Object.keys(JSON.parse(text) as object);
      expect(order[order.indexOf('side.sampleKey') - 1]).toBe('side.badgeBoth');
      expect(text).toContain('"side.badgeBoth": "T/B",\n  "side.sampleKey": "Sample en"\n}');
      // A key of an earlier area: its group stays separated from the next one by the blank line.
      const previousCommon = Object.keys(JSON.parse(model.texts.en.common)).filter(key => key.startsWith('common.')).at(-1);
      script.addKey(model, 'common.sampleKey', textValues('Sample'));
      const commonOrder = Object.keys(JSON.parse(model.texts.en.common));
      expect(commonOrder[commonOrder.indexOf('common.sampleKey') - 1]).toBe(previousCommon);
      expect(model.texts.en.common).toContain('"common.sampleKey": "Sample en",\n\n  "unit.components"');
    });
  });

  it('adds plural keys with the forms of every language and keeps the file valid JSON', () => {
    withCopy((root) => {
      const model = script.loadModel(root);
      expect(script.addKey(model, 'unit.sampleThings', pluralValues())).toBe('common');
      script.saveModel(model);
      for (const language of LANGUAGES) {
        expect(merged(root, language)['unit.sampleThings']).toEqual(Object.fromEntries(forms(language).map(form => [form, `{count} ${language}-${form}`])));
      }
      // The long forms of pl/uk break over several lines like the existing plural entries.
      expect(readFileSync(path.join(root, 'pl', 'common.json'), 'utf8')).toMatch(/"unit.sampleThings": \{\n {4}"one"/);
      expect(readFileSync(path.join(root, 'en', 'common.json'), 'utf8')).toMatch(/"unit.sampleThings": \{ "one": /);
    });
  });

  it('uses a namespace named like the area, even an empty one, and creates a namespace only on request', () => {
    withCopy((root) => {
      const model = script.loadModel(root);
      expect(script.addKey(model, 'workspace.sampleKey', textValues('Sample'))).toBe('workspace');
      expect(model.texts.de.workspace).toBe('{\n  "workspace.sampleKey": "Sample de"\n}\n');
      expect(() => script.addKey(model, 'diagnostics.sampleKey', textValues('Sample'))).toThrow(/no namespace holds keys of the area "diagnostics"/);
      expect(() => script.addKey(model, 'diagnostics.sampleKey', textValues('Sample'), { namespace: 'report' })).toThrow(/namespace "report" does not exist/);
      expect(() => script.addKey(model, 'diagnostics.sampleKey', textValues('Sample'), { namespace: 'Bad Name', createNamespace: true })).toThrow(/not a namespace name/);
      expect(script.addKey(model, 'diagnostics.sampleKey', textValues('Sample'), { namespace: 'report', createNamespace: true })).toBe('report');
      script.saveModel(model);
      for (const language of LANGUAGES) expect(existsSync(path.join(root, language, 'report.json'))).toBe(true);
      expect(merged(root, 'fr')['diagnostics.sampleKey']).toBe('Sample fr');
      expect(script.keyLocations(script.loadModel(root)).get('diagnostics.sampleKey')).toBe('report');
    });
  });

  it('refuses incomplete or inconsistent values and writes nothing', () => {
    withCopy((root) => {
      const model = script.loadModel(root);
      const before = JSON.stringify(model.texts);
      const withOut = (language: string): Record<string, Value> => { const values = textValues('Sample'); delete values[language]; return values; };
      expect(() => script.addKey(model, 'notes.sampleKey', withOut('uk'))).toThrow(/no value for uk/);
      expect(() => script.addKey(model, 'notes.sampleKey', { ...textValues('Sample'), de: 'Sample {count}' })).toThrow(/placeholders \{count\} differ from English \{\}/);
      expect(() => script.addKey(model, 'notes.sampleKey', { ...pluralValues(), pl: { one: '{count} a', other: '{count} b' } })).toThrow(/pl: plural form "few" is missing/);
      expect(() => script.addKey(model, 'notes.sampleKey', { ...pluralValues(), de: '{count} Dinge' })).toThrow(/de: English has plural forms/);
      expect(() => script.addKey(model, 'notes.sampleKey', { ...textValues('Sample'), fr: { one: 'a', other: 'b' } })).toThrow(/fr: English is a plain text/);
      expect(() => script.addKey(model, 'notes.sampleKey', { ...textValues('Sample'), it: ' padded ' })).toThrow(/leading or trailing whitespace/);
      expect(() => script.addKey(model, 'notes.sampleKey', { ...textValues('Sample'), sk: '' })).toThrow(/empty or non-text/);
      expect(() => script.addKey(model, 'BadKey', textValues('Sample'))).toThrow(/is not "<area>.<name>"/);
      expect(() => script.addKey(model, 'notes.unresolvedTitle', textValues('Sample'))).toThrow(/already exists in notes\.json/);
      expect(script.checkValues('unit.sampleThings', { ...pluralValues(), hu: '{count} dolog' })).toEqual([]);
      expect(script.checkValues('unit.sampleThings', { ...pluralValues(), hu: 'dolog' }).join()).toMatch(/hu: placeholders/);
      expect(JSON.stringify(model.texts)).toBe(before);
      expect(model.changed.size).toBe(0);
    });
  });

  it('inserts and replaces entries without touching the other lines', () => {
    const text = '{\n  "a.one": "1",\n  "a.two": { "one": "x", "other": "y" },\n\n  "b.one": {\n    "one": "p",\n    "other": "q"\n  }\n}\n';
    expect(script.insertEntry(text, 'a.three', '3')).toBe('{\n  "a.one": "1",\n  "a.two": { "one": "x", "other": "y" },\n  "a.three": "3",\n\n  "b.one": {\n    "one": "p",\n    "other": "q"\n  }\n}\n');
    expect(script.insertEntry(text, 'b.two', '2')).toBe('{\n  "a.one": "1",\n  "a.two": { "one": "x", "other": "y" },\n\n  "b.one": {\n    "one": "p",\n    "other": "q"\n  },\n  "b.two": "2"\n}\n');
    expect(script.insertEntry(text, 'c.one', '"quoted" \\ text')).toContain('  },\n\n  "c.one": "\\"quoted\\" \\\\ text"\n}\n');
    expect(script.insertEntry('{}\n', 'a.one', '1')).toBe('{\n  "a.one": "1"\n}\n');
    expect(script.replaceEntry(text, 'a.two', 'z')).toBe('{\n  "a.one": "1",\n  "a.two": "z",\n\n  "b.one": {\n    "one": "p",\n    "other": "q"\n  }\n}\n');
    expect(script.replaceEntry(text, 'b.one', { one: 'n', other: 'm' })).toBe('{\n  "a.one": "1",\n  "a.two": { "one": "x", "other": "y" },\n\n  "b.one": { "one": "n", "other": "m" }\n}\n');
    expect(lines(script.insertEntry(text, 'a.zz', 'é€…')).filter(line => line.includes('a.zz'))).toEqual(['  "a.zz": "é€…",']);
  });
});

describe('moving keys of a flat catalog layout into the namespaces', LOADED_MACHINE, () => {
  const writeFlat = (folder: string, root: string, extra: (language: string, flat: Record<string, Value>) => void): void => {
    for (const language of LANGUAGES) {
      const flat = { ...merged(root, language) };
      extra(language, flat);
      writeFileSync(path.join(folder, `${language}.json`), JSON.stringify(flat, null, 2));
    }
  };

  it('a flat catalog equal to the namespaces adds and changes nothing', () => {
    withCopy((root) => {
      const folder = path.join(root, '..', 'flat');
      cpSync(root, folder, { recursive: true });
      for (const language of LANGUAGES) { rmSync(path.join(folder, language), { recursive: true }); }
      writeFlat(folder, root, () => {});
      const result = script.importFlat(script.loadModel(root), folder);
      expect(result.added).toEqual([]);
      expect(result.changed).toEqual([]);
      expect(result.problems).toEqual([]);
      expect(result.unchanged).toBe(Object.keys(merged(root, 'en')).length);
    });
  });

  it('adds the keys another branch added to its flat files, reports changed texts and replaces them on request', () => {
    withCopy((root) => {
      const folder = path.join(root, '..', 'flat');
      cpSync(root, folder, { recursive: true });
      for (const language of LANGUAGES) rmSync(path.join(folder, language), { recursive: true });
      const sample = textValues('Imported');
      const plural = pluralValues();
      writeFlat(folder, root, (language, flat) => {
        flat['support.importedKey'] = sample[language];
        flat['unit.importedThings'] = plural[language];
        flat['header.open'] = `Changed ${language}`;
      });
      const model = script.loadModel(root);
      const dry = script.importFlat(model, folder);
      expect(dry.added).toEqual([{ key: 'support.importedKey', namespace: 'support' }, { key: 'unit.importedThings', namespace: 'common' }]);
      expect(dry.changed).toEqual([{ key: 'header.open', languages: LANGUAGES }]);
      expect(dry.problems).toEqual([]);
      expect(Object.keys(JSON.parse(model.texts.en.app) as object)).toContain('header.open');
      expect(JSON.parse(model.texts.en.app)['header.open']).toBe('Open');
      script.saveModel(model);
      expect(merged(root, 'de')['support.importedKey']).toBe('Imported de');
      expect(merged(root, 'de')['header.open']).not.toBe('Changed de');

      const second = script.loadModel(root);
      const again = script.importFlat(second, folder, { applyChanges: true });
      expect(again.added).toEqual([]);
      expect(again.changed.map(item => item.key)).toEqual(['header.open']);
      script.saveModel(second);
      expect(merged(root, 'uk')['header.open']).toBe('Changed uk');
      for (const language of LANGUAGES) {
        const expected = JSON.parse(readFileSync(path.join(folder, `${language}.json`), 'utf8')) as Record<string, Value>;
        expect(merged(root, language), language).toEqual(expected);
      }
    });
  });

  it('reports a key it cannot place instead of guessing, and a language without a flat file', () => {
    withCopy((root) => {
      const folder = path.join(root, '..', 'flat');
      cpSync(root, folder, { recursive: true });
      for (const language of LANGUAGES) rmSync(path.join(folder, language), { recursive: true });
      writeFlat(folder, root, (language, flat) => { flat['diagnostics.newKey'] = `New ${language}`; });
      rmSync(path.join(folder, 'sk.json'));
      const model = script.loadModel(root);
      const result = script.importFlat(model, folder);
      expect(result.added).toEqual([]);
      expect(result.problems.join('\n')).toMatch(/diagnostics\.newKey: no value for sk/);
      expect(result.problems.join('\n')).toMatch(/no flat catalog for sk/);
      const placed = script.importFlat(script.loadModel(root), folder, { namespace: 'workspace' });
      expect(placed.problems.join('\n')).toMatch(/no value for sk/);
    });
  });

  describe('against the merge base (--base): only what the branch changed is taken', () => {
    /** Flat catalogs of the merge base, of a branch (base plus its edits) and the repository that moved on since the base. */
    function scenario(root: string, branchEdit: (language: string, flat: Record<string, Value>) => void, repositoryEdit: (model: Model) => void): { base: string; branch: string; model: Model } {
      const holder = path.join(root, '..');
      const base = path.join(holder, 'base');
      const branch = path.join(holder, 'branch');
      for (const folder of [base, branch]) cpSync(root, folder, { recursive: true });
      for (const folder of [base, branch]) for (const language of LANGUAGES) rmSync(path.join(folder, language), { recursive: true });
      writeFlat(base, root, () => {});
      writeFlat(branch, root, branchEdit);
      const repository = script.loadModel(root);
      repositoryEdit(repository);
      script.saveModel(repository);
      return { base, branch, model: script.loadModel(root) };
    }
    const everyLanguage = (text: string): Record<string, Value> => Object.fromEntries(LANGUAGES.map(language => [language, `${text} ${language}`]));

    it('adds the branch key and the text it changed, leaves the texts only the repository changed, lists what the branch removed', () => {
      withCopy((root) => {
        const branchOnly = textValues('Branch');
        const { base, branch, model } = scenario(root, (language, flat) => {
          flat['support.branchKey'] = branchOnly[language];
          flat['header.open'] = `Branch open ${language}`;
          delete flat['toast.copied'];
        }, (repository) => {
          script.changeKey(repository, 'settings.title', everyLanguage('Repository title') as Record<string, Value>);
          script.addKey(repository, 'support.repositoryKey', textValues('Repository'));
        });
        // Control: without the base the older text of the branch looks like a change to take.
        const flatOnly = script.importFlat(model, branch);
        expect(flatOnly.changed.map(item => item.key).sort()).toEqual(['header.open', 'settings.title']);

        const fresh = script.loadModel(root);
        const result = script.importFlat(fresh, branch, { base, applyChanges: true });
        expect(result.problems).toEqual([]);
        expect(result.added).toEqual([{ key: 'support.branchKey', namespace: 'support' }]);
        expect(result.changed.map(item => item.key)).toEqual(['header.open']);
        expect(result.removed).toEqual(['toast.copied']);
        script.saveModel(fresh);
        for (const language of LANGUAGES) {
          const after = merged(root, language);
          expect(after['support.branchKey']).toBe(`Branch ${language}`);
          expect(after['header.open']).toBe(`Branch open ${language}`);
          expect(after['settings.title']).toBe(`Repository title ${language}`);
          expect(after['support.repositoryKey']).toBe(`Repository ${language}`);
          expect(after['toast.copied']).toBeDefined();
        }
      });
    });

    it('leaves a text that both sides changed alone and says so', () => {
      withCopy((root) => {
        const { base, branch, model } = scenario(root, (language, flat) => { flat['header.open'] = `Branch open ${language}`; }, (repository) => {
          script.changeKey(repository, 'header.open', everyLanguage('Repository open') as Record<string, Value>);
        });
        const result = script.importFlat(model, branch, { base, applyChanges: true });
        expect(result.changed).toEqual([]);
        expect(result.problems.join('\n')).toMatch(/header\.open: changed in the namespace files and in the branch/);
        expect(script.keyLocations(model).has('header.open')).toBe(true);
        expect(JSON.parse(model.texts.en.app)['header.open']).toBe('Repository open en');
      });
    });
  });
});

describe('the command line', LOADED_MACHINE, () => {
  it('parses values, plural objects and flags', () => {
    expect(script.parseValue('{count} pins')).toBe('{count} pins');
    expect(script.parseValue('{pins} · {components}')).toBe('{pins} · {components}');
    expect(script.parseValue('{"one":"{count} pin","other":"{count} pins"}')).toEqual({ one: '{count} pin', other: '{count} pins' });
    const parsed = script.parseArguments(['notes.x', '--en', 'Hello', '--hu', '{"one":"a","other":"b"}', '--namespace', 'notes', '--create-namespace', '--values', 'v.json']);
    expect(parsed.positional).toEqual(['notes.x']);
    expect(parsed.values).toEqual({ en: 'Hello', hu: { one: 'a', other: 'b' } });
    expect(parsed.namespace).toBe('notes');
    expect(parsed['create-namespace']).toBe(true);
    expect(parsed.valuesFile).toBe('v.json');
    expect(() => script.parseArguments(['--nope', 'x'])).toThrow(/unknown option --nope/);
    expect(() => script.parseArguments(['--en'])).toThrow(/--en needs a value/);
  });

  it('lists the namespaces of the real catalogs (read-only)', () => {
    const output = execFileSync(process.execPath, [path.join(catalogs.LOCALES_DIRECTORY, '..', '..', 'scripts', 'i18n.cjs'), 'namespaces'], { encoding: 'utf8' });
    for (const namespace of ['app', 'board', 'common', 'dialogs', 'formats', 'kinds', 'native', 'network', 'notes', 'settings', 'support']) expect(output).toContain(namespace);
    expect(output).toMatch(/workspace\s+0 keys/);
  });

  it('exits with a message and a non-zero code on a usage error, writing nothing', () => {
    let failure: { status?: number; stderr?: Buffer } | undefined;
    try { execFileSync(process.execPath, [path.join(catalogs.LOCALES_DIRECTORY, '..', '..', 'scripts', 'i18n.cjs'), 'add', 'notes.neverWritten', '--en', 'only English'], { stdio: 'pipe' }); } catch (error) { failure = error as typeof failure; }
    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr)).toMatch(/no value for hu/);
    expect(JSON.stringify(catalogs.loadCatalog('en'))).not.toContain('neverWritten');
  });
});
