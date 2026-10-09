import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, catalogs, createTranslator } from '../lib/i18n';
import type { Language } from '../lib/i18n';
import type { NetworkActivityEntry, NetworkActivityReport } from '../lib/network-activity';
import type { AppSettings } from '../lib/types';
import NetworkSettings from './NetworkSettings';

const catalog = (lang: Language): Record<string, string> => catalogs[lang] as Record<string, string>;
const settings = (language: Language): AppSettings => ({
  language, theme: 'dark', layout: 'workshop', motion: true, showLabels: true, showConnections: true, updateCheck: true,
});
const feature = { id: 'bug-report', hosts: ['reports.example.org'], optIn: null, enabled: true };
const entry: NetworkActivityEntry = {
  id: 1, time: '2026-10-07T10:00:00.000Z', kind: 'request', feature: 'bug-report', method: 'POST', host: 'reports.example.org', path: '/submit',
  outcome: 'ok', status: 202, bytes: 32, durationMs: 40, error: null,
};
const report: NetworkActivityReport = { features: [feature], entries: [entry], dropped: 0, limit: 200 };
const markup = (language: Language): string => renderToStaticMarkup(createElement(NetworkSettings, {
  t: createTranslator(language), language, settings: settings(language), actions: { read: async () => report, clear: async () => true }, initialOpen: true, initialReport: report,
}));
const decode = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

describe('bug report network feature markup', () => {
  it.each(LANGUAGES)('%s: shows the localized name and hint in the feature list and localized name in its activity row', (language) => {
    const html = markup(language);
    const name = catalog(language)['network.bugReport'];
    const hint = catalog(language)['network.bugReportHint'];
    const featureMarkup = html.slice(html.indexOf('data-testid="network-feature-bug-report"'));
    const rowMarkup = html.split('data-testid="network-row"').at(1)!;

    expect(featureMarkup).toContain(`<strong>${decode(name)}</strong>`);
    expect(featureMarkup).toContain(`<small>${decode(hint).replace(/'/g, '&#x27;')}</small>`);
    expect(rowMarkup).toContain(`<td>${decode(name)}</td>`);
    expect(featureMarkup).not.toContain('<strong>bug-report</strong>');
    expect(rowMarkup).not.toContain('<td>bug-report</td>');
  });
});
