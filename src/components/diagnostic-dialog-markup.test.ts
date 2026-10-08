import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiagnosticSession } from '../app/diagnostic-session';
import type { DiagnosticSession } from '../app/diagnostic-session';
import type { WorkerFactory } from '../app/controller';
import { LANGUAGES, catalogs, createFormatters, createTranslator } from '../lib/i18n';
import type { Language } from '../lib/i18n';
import { kicad } from '../lib/diagnostics/canary-kit';
import { collectDiagnostic } from '../lib/diagnostics/collect';
import type { DiagnosticFilePayload } from '../lib/types';
import { DIAGNOSTIC_KEYS, DiagnosticView, includedKeys } from './DiagnosticDialog';
import { HelpDialog } from './workspace/Dialogs';
import { UiContext } from './workspace/ui-context';
import type { UiContextValue } from './workspace/ui-context';

/**
 * Markup of the format diagnostic report dialog (server-side render, no DOM needed), in all eight languages: the start view with the plain-language list,
 * the review with the JSON exactly as it will be saved, both opt-in switches off, the residual-risk notice, and the Help entry that opens it.
 */
const decode = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const catalog = (lang: Language): Record<string, string> => catalogs[lang] as Record<string, string>;
const textIn = (html: string, testId: string): string => {
  const match = new RegExp(`data-testid="${testId}"[^>]*>([\\s\\S]*?)</(?:pre|p|ul|button)>`).exec(html);
  expect(match, testId).not.toBeNull();
  return decode(match![1].replace(/<[^>]*>/g, ''));
};

const CODE = 'fedcba9876543210';
const payload = (over: Partial<DiagnosticFilePayload> = {}): DiagnosticFilePayload => ({ name: 'diagnostic.kicad_pcb', data: kicad().data, os: 'win32', dedupe: CODE, ...over });
const workerThatAnswers: WorkerFactory = onMessage => ({
  post(message) {
    const request = message as { name: string; data: Uint8Array; os: 'win32'; dedupe: string | null };
    void collectDiagnostic({ name: request.name, data: request.data }, { os: request.os, dedupe: request.dedupe, appVersion: '1.3.0' }).then(report => onMessage({ report }));
  },
  terminate() {},
});
async function reviewSession(over: Partial<DiagnosticFilePayload> = {}): Promise<DiagnosticSession> {
  const session = createDiagnosticSession({ desktop: { pickDiagnosticFile: async () => payload(over), saveDiagnosticReport: async () => ({ bytes: 1 }) }, createWorker: workerThatAnswers });
  await session.start();
  for (let turn = 0; turn < 500 && session.getSnapshot().phase !== 'review'; turn++) await new Promise(resolve => setTimeout(resolve, 2));
  expect(session.getSnapshot().phase).toBe('review');
  return session;
}
const idleSession = (): DiagnosticSession => createDiagnosticSession({ desktop: { pickDiagnosticFile: async () => null, saveDiagnosticReport: async () => null }, createWorker: workerThatAnswers });
const render = (session: DiagnosticSession, lang: Language): string => renderToStaticMarkup(createElement(DiagnosticView, { session, t: createTranslator(lang) }));

describe('Help > Format diagnostic report: the start view', () => {
  it.each(LANGUAGES)('%s: says what the report is, lists what it contains and what it never contains, and offers the file choice', (lang) => {
    const html = render(idleSession(), lang);
    expect(decode(html)).toContain(catalog(lang)[DIAGNOSTIC_KEYS.intro]);
    expect(decode(html)).toContain(catalog(lang)[DIAGNOSTIC_KEYS.includedTitle]);
    expect(decode(html)).toContain(catalog(lang)[DIAGNOSTIC_KEYS.neverTitle]);
    expect(decode(html)).toContain(catalog(lang)[DIAGNOSTIC_KEYS.never]);
    for (const key of includedKeys({ level: 1, dedupe: false, hasDedupe: false, facts: null })) expect(decode(html)).toContain(catalog(lang)[key]);
    expect(decode(html)).not.toContain(catalog(lang)[DIAGNOSTIC_KEYS.incLevel2]);
    expect(decode(html)).not.toContain(catalog(lang)[DIAGNOSTIC_KEYS.incDedupe]);
    expect(textIn(html, 'diagnostic-choose')).toBe(catalog(lang)[DIAGNOSTIC_KEYS.choose]);
    expect(html).not.toContain('diagnostic-save');
    expect(html).not.toContain('diagnostic-json');
  });
});

describe('Help > Format diagnostic report: the review', () => {
  it.each(LANGUAGES)('%s: shows the outcome, the list, the risk notice, both switches off and the JSON exactly as it will be saved', async (lang) => {
    const session = await reviewSession();
    const html = render(session, lang);
    expect(textIn(html, 'diagnostic-outcome')).toBe(catalog(lang)[DIAGNOSTIC_KEYS.outcomeOpened]);
    expect(textIn(html, 'diagnostic-risk')).toBe(catalog(lang)[DIAGNOSTIC_KEYS.risk]);
    expect(textIn(html, 'diagnostic-json')).toBe(session.getSnapshot().text);
    const switches = [...html.matchAll(/<input type="checkbox" role="switch" data-testid="(diagnostic-(?:level2|dedupe))"([^>]*)>/g)];
    expect(switches.map(match => match[1])).toEqual(['diagnostic-level2', 'diagnostic-dedupe']);
    for (const match of switches) expect(match[2]).not.toContain('checked');
    const list = textIn(html, 'diagnostic-included');
    expect(list).toContain(catalog(lang)[DIAGNOSTIC_KEYS.incResult]);
    expect(list).not.toContain(catalog(lang)[DIAGNOSTIC_KEYS.incLevel2]);
    expect(list).not.toContain(catalog(lang)[DIAGNOSTIC_KEYS.incDedupe]);
    expect(textIn(html, 'diagnostic-save')).toBe(catalog(lang)[DIAGNOSTIC_KEYS.save]);
    expect(textIn(html, 'diagnostic-copy')).toBe(catalog(lang)[DIAGNOSTIC_KEYS.copy]);
    expect(textIn(html, 'diagnostic-again')).toBe(catalog(lang)[DIAGNOSTIC_KEYS.chooseAnother]);
  });

  it('adds the two opt-in lines to the list exactly when their switch is on', async () => {
    const session = await reviewSession();
    session.setLevel(2);
    let html = render(session, 'en');
    expect(textIn(html, 'diagnostic-included')).toContain(catalog('en')[DIAGNOSTIC_KEYS.incLevel2]);
    expect(textIn(html, 'diagnostic-included')).not.toContain(catalog('en')[DIAGNOSTIC_KEYS.incDedupe]);
    expect(html).toMatch(/data-testid="diagnostic-level2" checked/);
    session.setDedupe(true);
    html = render(session, 'en');
    expect(textIn(html, 'diagnostic-included')).toContain(catalog('en')[DIAGNOSTIC_KEYS.incDedupe]);
    expect(textIn(html, 'diagnostic-json')).toContain(`"dedupe": "${CODE}"`);
    session.setDedupe(false);
    expect(textIn(render(session, 'en'), 'diagnostic-json')).not.toContain(CODE);
  });

  it('has no repeat-detection switch when the main process gave no code, and says so in the list', async () => {
    const session = await reviewSession({ dedupe: '' });
    const html = render(session, 'en');
    expect(html).not.toContain('diagnostic-dedupe');
    expect(textIn(html, 'diagnostic-included')).not.toContain(catalog('en')[DIAGNOSTIC_KEYS.incDedupe]);
  });

  it('leaves out the result lines for a file TRACE could not open', async () => {
    const session = await reviewSession({ data: Uint8Array.from({ length: 800 }, (_, index) => (index * 31 + 7) & 255), name: 'diagnostic.bin' });
    const html = render(session, 'en');
    expect(textIn(html, 'diagnostic-outcome')).toBe(catalog('en')[DIAGNOSTIC_KEYS.outcomeUnrecognized]);
    expect(textIn(html, 'diagnostic-included')).not.toContain(catalog('en')[DIAGNOSTIC_KEYS.incResult]);
    expect(textIn(html, 'diagnostic-included')).not.toContain(catalog('en')[DIAGNOSTIC_KEYS.incChecks]);
  });

  it('has no network, upload or clipboard element: the only actions are choose, copy (a button), save and cancel', async () => {
    const html = render(await reviewSession(), 'en');
    expect(html.replace(/xmlns="[^"]*"/g, '')).not.toMatch(/<(?:form|a|iframe|img|script|link)\b|href=|src=|action=|upload/i);
    expect([...html.matchAll(/data-testid="(diagnostic-[a-z0-9]+)"/g)].map(match => match[1]).filter(id => /choose|copy|save|again|cancel/.test(id)).sort()).toEqual(['diagnostic-again', 'diagnostic-copy', 'diagnostic-save']);
  });
});

describe('the Help dialog entry', () => {
  const ui = (lang: Language): UiContextValue => {
    const t = createTranslator(lang);
    return { t, fmt: createFormatters(lang), language: lang, text: () => '', copy: () => {} };
  };
  const helpHtml = (lang: Language, withEntry: boolean) => {
    const element = createElement(UiContext.Provider, { value: ui(lang) }, createElement(HelpDialog, { onClose: () => {}, ...(withEntry ? { onDiagnostic: () => {} } : {}) }));
    return renderToStaticMarkup(element);
  };
  const bridge = (traceDesktop?: object) => {
    vi.stubGlobal('HTMLElement', class {});
    vi.stubGlobal('document', { activeElement: null });
    vi.stubGlobal('window', traceDesktop === undefined ? {} : { traceDesktop });
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each(LANGUAGES)('%s: the entry and its hint appear with a bridge that has both calls', (lang) => {
    bridge({ pickDiagnosticFile: async () => null, saveDiagnosticReport: async () => null });
    const html = helpHtml(lang, true);
    expect(textIn(html, 'help-diagnostic')).toBe(catalog(lang)['help.diagnosticReport']);
    expect(decode(html)).toContain(catalog(lang)['help.diagnosticHint']);
  });

  it('is not shown without the bridge, with an older preload, or without a handler', () => {
    bridge();
    expect(helpHtml('en', true)).not.toContain('help-diagnostic');
    bridge({ pickDiagnosticFile: async () => null });
    expect(helpHtml('en', true)).not.toContain('help-diagnostic');
    bridge({ pickDiagnosticFile: async () => null, saveDiagnosticReport: async () => null });
    expect(helpHtml('en', false)).not.toContain('help-diagnostic');
  });
});
