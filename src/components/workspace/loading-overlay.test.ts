import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { catalogs, createFormatters, createTranslator, LANGUAGES, renderMessage } from '../../lib/i18n';
import type { Language } from '../../lib/i18n';
import { LoadingOverlay } from './LoadingOverlay';
import type { LoadingOverlayProps } from './LoadingOverlay';
import { UiContext } from './ui-context';
import type { UiContextValue } from './ui-context';

const decode = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const uiFor = (lang: Language): UiContextValue => ({ t: createTranslator(lang), fmt: createFormatters(lang), language: lang, text: message => renderMessage(lang, message), copy: () => {} });
const render = (lang: Language, props: Partial<LoadingOverlayProps>) =>
  decode(renderToStaticMarkup(createElement(UiContext.Provider, { value: uiFor(lang) }, createElement(LoadingOverlay, { phase: 'processing', progress: null, onCancel: () => {}, ...props }))));
const KEYS = ['loading.progress', 'loading.stalled', 'loading.cancel', 'toast.importCancelled', 'toast.importStopped'] as const;

describe('import overlay: progress text and Cancel in all eight languages', () => {
  it('every language has its own text for the new strings, with the same placeholders as English', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const key of KEYS) {
      const english = (catalogs.en as Record<string, string>)[key];
      for (const lang of LANGUAGES) {
        const text = (catalogs[lang] as Record<string, string>)[key];
        expect(typeof text === 'string' && text.length > 1, `${lang} ${key}`).toBe(true);
        expect(placeholders(text), `${lang} ${key}`).toEqual(placeholders(english));
        if (lang !== 'en' && key !== 'loading.progress') expect(text, `${lang} ${key}`).not.toBe(english);
      }
    }
  });

  it('shows an indeterminate track and the hint until the parser reports a position', () => {
    for (const lang of LANGUAGES) {
      const html = render(lang, { phase: 'reading', progress: null });
      expect(html).toContain(createTranslator(lang)('loading.reading'));
      expect(html).toContain(createTranslator(lang)('loading.hint'));
      expect(html).toContain(createTranslator(lang)('loading.cancel'));
      expect(html).not.toContain('aria-valuenow');
      expect(html).not.toContain('determinate');
    }
  });

  it('shows the percentage the parser reported (rounded down) as text and as progressbar value', () => {
    for (const lang of LANGUAGES) {
      const t = createTranslator(lang);
      const html = render(lang, { progress: { fraction: 0.426, stalled: false } });
      expect(html).toContain(t('loading.processing'));
      expect(html).toContain(t('loading.progress', { percent: 42 }));
      expect(html).toContain('aria-valuenow="42"');
      expect(html).toContain('width:42%');
    }
  });

  it('says that the file takes unusually long once the watchdog saw no progress, Cancel still offered', () => {
    for (const lang of LANGUAGES) {
      const t = createTranslator(lang);
      const html = render(lang, { progress: { fraction: null, stalled: true } });
      expect(html).toContain(t('loading.stalled'));
      expect(html).toContain('data-stalled="true"');
      expect(html).toContain(`data-testid="loading-cancel">${t('loading.cancel')}<`);
    }
  });
});
