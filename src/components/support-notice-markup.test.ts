import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, catalogs, createTranslator } from '../lib/i18n';
import type { Language } from '../lib/i18n';
import { SUPPORT_NOTICE_KEYS } from '../lib/support-notice';
import { SupportDialog } from './SupportNotice';
import { createSupportPreparationFlow } from './SupportVerification';

/**
 * Markup of the support notice (server-side render, no DOM needed): accessibility wiring, button order and the absence of any
 * "do not show again" control. Focus, Esc and backdrop clicks are DOM behaviour: they are checked in the source-electron smoke.
 */
const markup = (lang: Language): string => renderToStaticMarkup(createElement(SupportDialog, { t: createTranslator(lang), open: async () => undefined, onClose: () => undefined }));
const decode = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const textOf = (html: string, pattern: RegExp): string => {
  const match = pattern.exec(html);
  expect(match, String(pattern)).not.toBeNull();
  return decode(match![1]);
};

describe('SupportDialog markup', () => {
  it.each(LANGUAGES)('%s: a labelled dialog with title, body, thanks and testing lines and the four buttons in the catalog language', (lang) => {
    const html = markup(lang);
    const catalog = catalogs[lang] as Record<string, string>;
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(html).toMatch(/^<dialog /);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('data-testid="support-notice"');
    const title = new RegExp(`<h2 id="${labelledBy!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">([^<]*)</h2>`);
    expect(textOf(html, title)).toBe(catalog[SUPPORT_NOTICE_KEYS.title]);
    expect(textOf(html, new RegExp(`<p id="${describedBy!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" class="support-notice-body">([^<]*)</p>`))).toBe(catalog[SUPPORT_NOTICE_KEYS.body]);
    expect(textOf(html, /<p class="support-notice-thanks">([^<]*)<\/p>/)).toBe(catalog[SUPPORT_NOTICE_KEYS.thanks]);
    expect(textOf(html, /<p class="support-notice-testing">([^<]*)<\/p>/)).toBe(catalog[SUPPORT_NOTICE_KEYS.testing]);
    expect(textOf(html, /data-testid="support-stripe"[^>]*>([^<]*)<\/button>/)).toBe(catalog[SUPPORT_NOTICE_KEYS.stripe]);
    expect(textOf(html, /data-testid="support-kofi"[^>]*>([^<]*)<\/button>/)).toBe(catalog[SUPPORT_NOTICE_KEYS.kofi]);
    expect(textOf(html, /data-testid="support-bug"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/button>/)).toBe(catalog[SUPPORT_NOTICE_KEYS.bug]);
    expect(textOf(html, /data-testid="support-not-now"[^>]*>([^<]*)<\/button>/)).toBe(catalog[SUPPORT_NOTICE_KEYS.notNow]);
  });

  it('the buttons come in this order: support (primary), Ko-fi, Report a bug, Not now; none is disabled at the start', () => {
    const html = markup('en');
    const order = [...html.matchAll(/data-testid="(support-[a-z-]+)"/g)].map(match => match[1]).filter(id => id !== 'support-notice');
    expect(order).toEqual(['support-stripe', 'support-kofi', 'support-bug', 'support-not-now']);
    expect(html).toMatch(/<button type="button" class="primary-button" data-testid="support-stripe"/);
    expect(html).not.toMatch(/disabled/);
    expect([...html.matchAll(/<button /g)]).toHaveLength(4);
  });

  it('external link buttons name only stripe and kofi; bug reporting has no external link target', () => {
    const html = markup('en');
    expect([...html.matchAll(/data-support-link="([^"]+)"/g)].map(match => match[1])).toEqual(['stripe', 'kofi']);
    expect(html).not.toMatch(/data-support-link="bug"/);
    // The only URL-like text allowed is the SVG namespace of the icon inside the bug button.
    const withoutNamespace = html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '');
    expect(withoutNamespace).not.toMatch(/https?:|href=|donate\.stripe|ko-fi\.com|github\.com/);
  });

  it('there is no "do not show again" control, no countdown and no other interactive element: no input, checkbox, progress, meter or link', () => {
    for (const lang of LANGUAGES) {
      const html = markup(lang);
      expect(html, lang).not.toMatch(/<(?:input|select|textarea|progress|meter|a|label)\b|type="checkbox"|role="(?:progressbar|timer|checkbox)"|aria-live/);
    }
  });
});

describe('SupportVerification preparation behavior', () => {
  it('shows the unavailable state after preparation fails and an explicit retry publishes the recovered reference', async () => {
    const published: Array<{ code: string; available: boolean; busy: boolean; result: 'pending' | 'unavailable' | null }> = [];
    let calls = 0;
    const flow = createSupportPreparationFlow(async () => {
      calls++;
      if (calls === 1) return { status: 'unavailable', expiresAt: null, available: true, code: '' };
      return { status: 'inactive', expiresAt: null, available: true, code: 'a'.repeat(32) };
    }, state => published.push(state));

    await flow.run();
    expect(published.at(-1)).toEqual({ code: '', available: true, busy: false, result: 'unavailable' });
    await flow.run();
    expect(calls).toBe(2);
    expect(published.at(-1)).toEqual({ code: 'a'.repeat(32), available: true, busy: false, result: null });
    flow.dispose();
  });

  it('publishes an announced busy transition without dropping the retryable unavailable state', async () => {
    const published: Array<{ code: string; available: boolean; busy: boolean; result: 'pending' | 'unavailable' | null }> = [];
    let resolve!: (value: { status: 'inactive'; expiresAt: null; available: true; code: string }) => void;
    let calls = 0;
    const flow = createSupportPreparationFlow(async () => {
      if (calls++ === 0) return { status: 'unavailable', expiresAt: null, available: true, code: '' };
      return new Promise(resolveValue => { resolve = resolveValue; });
    }, state => published.push(state));

    await flow.run();
    expect(published.at(-1)).toEqual({ code: '', available: true, busy: false, result: 'unavailable' });
    const pending = flow.run();
    expect(published.at(-1)).toEqual({ code: '', available: true, busy: true, result: null });
    resolve({ status: 'inactive', expiresAt: null, available: true, code: 'b'.repeat(32) });
    await pending;
    expect(published.at(-1)).toEqual({ code: 'b'.repeat(32), available: true, busy: false, result: null });
    flow.dispose();
  });

  it.each(LANGUAGES)('%s provides the localized retry action', lang => {
    const retry = (catalogs[lang] as Record<string, unknown>)['support.retry'];
    expect(typeof retry).toBe('string');
    expect((retry as string).trim().length).toBeGreaterThan(3);
  });
});
