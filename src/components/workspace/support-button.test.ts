import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, catalogs, createTranslator } from '../../lib/i18n';
import type { Language } from '../../lib/i18n';
import { SUPPORT_BUTTON_KEY } from '../../lib/support-notice';
import { TopBar } from './TopBar';
import type { TopBarProps } from './TopBar';

/**
 * The support (heart) button of the top bar. Markup (server-side render, no DOM needed): accessible label and tooltip in every language, the
 * position among its neighbours and the absence of any URL (the click sends the fixed id 'support' to the main process, which holds the address).
 * Style (support-button.css, read as text): the occasional glow can neither come more often than every few minutes nor move the layout, and it is
 * switched off by the two motion switches. How it looks and the real click are DOM matters: checked in the source-electron smoke and by eye.
 */
const noop = (): void => undefined;
const topBar = (lang: Language, over: Partial<TopBarProps> = {}): string => renderToStaticMarkup(createElement(TopBar, {
  t: createTranslator(lang), hasBoard: false, boardName: '', format: '', fileName: '', filePath: '', componentCount: 0, layoutName: '', activeTab: 'board', splitEnabled: false,
  documentCount: 0, schematicCount: 0, focusLayout: false, leftOpen: false, rightOpen: false, maximized: false, desktop: undefined,
  onTab: noop, onSplit: noop, onOpen: noop, onHome: noop, onToggleFocus: noop, onSettings: noop, onPanels: noop, onReportBug: noop, onSupport: noop, ...over,
}));
const decode = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const buttonTag = (html: string, testId: string): string => {
  const match = new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  expect(match, testId).not.toBeNull();
  return match![0];
};
const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decode(match[1]) : undefined;
};
const readSource = (relative: string): string => readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8');

describe('support button markup', () => {
  it.each(LANGUAGES)('%s: the heart button has the catalog text as accessible label and as tooltip, is a plain button and holds an icon but no text', (lang) => {
    const html = topBar(lang);
    const tag = buttonTag(html, 'support-button');
    const label = (catalogs[lang] as Record<string, string>)[SUPPORT_BUTTON_KEY];
    expect(label).toBeTruthy();
    expect(attribute(tag, 'aria-label')).toBe(label);
    expect(attribute(tag, 'title')).toBe(label);
    expect(tag).toContain('type="button"');
    expect(attribute(tag, 'class')).toBe('tool-button support-heart');
    expect(tag, 'it is not a toggle').not.toMatch(/aria-pressed/);
    expect(tag).not.toMatch(/disabled/);
    const body = new RegExp(`${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s\\S]*?)</button>`).exec(html)![1];
    expect(body).toMatch(/^<svg\b[\s\S]*<\/svg>$/);
    expect(body.replace(/<svg\b[\s\S]*<\/svg>/, ''), 'the icon is the only content').toBe('');
  });

  it('the label is "Support TRACE" in English and the button sits next to the bug button, before it, in the same group', () => {
    const html = topBar('en');
    expect(attribute(buttonTag(html, 'support-button'), 'aria-label')).toBe('Support TRACE');
    const order = [...html.matchAll(/data-testid="([a-z-]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(['open-board', 'support-button', 'report-bug-button', 'language-button', 'settings-button']);
    expect(html.indexOf('data-testid="support-button"')).toBeGreaterThan(html.indexOf('class="header-actions"'));
    expect(attribute(buttonTag(html, 'report-bug-button'), 'aria-label')).toBe((catalogs.en as Record<string, string>)['support.bug']);
  });

  it('it is there with and without a board, in both layouts, and the markup names no URL (the main process holds the address)', () => {
    for (const over of [{ hasBoard: false }, { hasBoard: true, boardName: 'B', format: 'GENCAD 1.4', componentCount: 3, layoutName: 'Workshop' }, { hasBoard: true, focusLayout: true }] satisfies Partial<TopBarProps>[]) {
      const html = topBar('en', over);
      expect(html, JSON.stringify(over)).toContain('data-testid="support-button"');
      expect([...html.matchAll(/data-testid="support-button"/g)]).toHaveLength(1);
      expect(html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, ''), JSON.stringify(over)).not.toMatch(/https?:|href=|github\.io|trace-boardviewer/);
    }
  });

  it('every other top bar button keeps its label (the new one is an addition, nothing moved or lost)', () => {
    const html = topBar('en', { hasBoard: true, boardName: 'B', format: 'GENCAD 1.4', componentCount: 3, layoutName: 'Workshop' });
    for (const id of ['split-toggle', 'toggle-left', 'toggle-right', 'open-board', 'focus-toggle', 'report-bug-button', 'language-button', 'settings-button']) expect(html, id).toContain(`data-testid="${id}"`);
  });

  it.each(LANGUAGES)('%s: verified support hides the heart without hiding the bug report or settings', language => {
    const html = topBar(language, { supportHidden: true });
    expect(html).not.toContain('data-testid="support-button"');
    expect(html).toContain('data-testid="report-bug-button"');
    expect(html).toContain('data-testid="settings-button"');
  });
});

describe('support button style (support-button.css)', () => {
  const css = readSource('src/components/workspace/support-button.css');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const keyframes = /@keyframes\s+support-heart-glow\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(rules);
  const animation = /\.support-heart>svg\{animation:support-heart-glow\s+(\d+(?:\.\d+)?)s\s+([a-z-]+)\s+(infinite|\d+)\}/.exec(rules);
  /** The percent stops of the keyframes with the declarations of each (a stop list such as "0%,25%" gives every stop the same declarations). */
  const stops = (): Array<{ at: number; declarations: string }> => [...keyframes![1].matchAll(/([\d.%,\s]+)\{([^}]*)\}/g)]
    .flatMap((match) => match[1].split(',').map((stop) => ({ at: parseFloat(stop), declarations: match[2].trim() })))
    .sort((a, b) => a.at - b.at);

  it('one animation on the icon, one keyframes block, a cycle of at least three minutes that repeats for ever', () => {
    expect(keyframes, 'the keyframes').not.toBeNull();
    expect(animation, 'the animation rule').not.toBeNull();
    expect(rules.match(/@keyframes/g)).toHaveLength(1);
    expect(Number(animation![1]), 'cycle in seconds').toBeGreaterThanOrEqual(180);
    expect(animation![3]).toBe('infinite');
    expect(rules).not.toMatch(/animation-delay/);
  });

  it('the glow lasts about 1.5 s and at most 2 s of each cycle, with nothing else going on the rest of the time', () => {
    const list = stops();
    expect(list[0].at).toBe(0);
    expect(list[list.length - 1].at).toBe(100);
    // The resting stops hold the same shadow as the peak, fully transparent and without blur, in the accent colour: the browser then fades in and out in one colour.
    const resting = (declarations: string): boolean => declarations === 'filter:drop-shadow(0 0 0 color-mix(in srgb,var(--accent) 0%,transparent))';
    const glowing = list.filter((stop) => !resting(stop.declarations));
    expect(glowing).toHaveLength(1);
    const peak = glowing[0];
    expect(peak.declarations).toMatch(/^filter:drop-shadow\(0 0 \d+px color-mix\(in srgb,var\(--accent\) \d+%,transparent\)\)$/);
    const before = list.filter((stop) => stop.at < peak.at).pop()!;
    const after = list.find((stop) => stop.at > peak.at)!;
    expect(resting(before.declarations) && resting(after.declarations)).toBe(true);
    const seconds = ((after.at - before.at) / 100) * Number(animation![1]);
    expect(seconds, 'glow duration in seconds').toBeGreaterThan(1);
    expect(seconds, 'glow duration in seconds').toBeLessThanOrEqual(2);
    expect(before.at, 'the first glow comes well after the start, when the support notice is long gone').toBeGreaterThan(5);
  });

  it('only the icon\'s filter is animated: no property that could move or resize anything, and no transition or will-change on the button', () => {
    for (const { declarations } of stops()) expect(declarations, declarations).toMatch(/^filter:/);
    expect(rules).not.toMatch(/(?:^|[;{])\s*(?:width|height|margin|padding|top|left|right|bottom|transform|position|display|flex|font-size|border|line-height|gap)\s*:/);
    expect(rules).not.toMatch(/transition|will-change/);
  });

  it('colours are theme tokens only, so both themes read well (no fixed colour anywhere in the file)', () => {
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\b(?:red|pink|white|black)\b/);
    expect(rules).toContain('var(--accent)');
    const styles = readSource('src/styles.css');
    expect(styles, 'both themes define the accent token').toMatch(/:root\{[^}]*--accent:#[0-9a-f]{6}/);
    expect(styles).toMatch(/:root\[data-theme=light\]\{[^}]*--accent:#[0-9a-f]{6}/);
  });

  it('prefers-reduced-motion and the Motion setting turn the animation off for this button (and the global switches do too)', () => {
    expect(rules).toMatch(/@media\(prefers-reduced-motion:reduce\)\{\.support-heart>svg\{animation:none\}\}/);
    expect(rules).toMatch(/:root\[data-motion=off\] \.support-heart>svg\{animation:none\}/);
    const styles = readSource('src/styles.css');
    expect(styles).toContain(':root[data-motion=off] *, :root[data-motion=off] *::before,:root[data-motion=off] *::after{animation:none!important;transition:none!important}');
    expect(styles).toContain('@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}');
  });

  it('the stylesheet is loaded by the top bar that renders the button', () => {
    expect(readSource('src/components/workspace/TopBar.tsx')).toContain("import './support-button.css';");
  });
});
