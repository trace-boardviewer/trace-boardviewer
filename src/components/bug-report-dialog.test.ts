import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LANGUAGES, catalogs, createTranslator } from '../lib/i18n';
import type { Language } from '../lib/i18n';
import BugReportDialog, { BUG_REPORT_CLOSE_TEST_IDS, BUG_REPORT_SEND_ENABLED, bugReportLeaveWarning, copyBugReportText, handleBugReportPromptKey, trapBugReportPromptTab } from './BugReportDialog';

const markup = (language: Language) => renderToStaticMarkup(createElement(BugReportDialog, {
  t: createTranslator(language), surface: 'welcome', lastImport: null, onClose: () => undefined,
}));

describe('in-app bug report dialog markup', () => {
  it('enables the explicit desktop send action after receiver proof', () => {
    expect(BUG_REPORT_SEND_ENABLED).toBe(true);
  });

  it('uses distinct header/result close hooks and truthful leave warnings', () => {
    expect(BUG_REPORT_CLOSE_TEST_IDS).toEqual({ header: 'bug-report-close', result: 'bug-report-result-close' });
    expect(new Set(Object.values(BUG_REPORT_CLOSE_TEST_IDS)).size).toBe(2);
    expect(bugReportLeaveWarning({ attempted: false, outcome: 'idle' }, false, false)).toBe('diagnostic.bugStorageUnavailable');
    expect(bugReportLeaveWarning({ attempted: false, outcome: 'idle' }, true, true)).toBe('diagnostic.bugUnconfirmed');
    expect(bugReportLeaveWarning({ attempted: true, outcome: 'uncertain' }, false, true)).toBe('diagnostic.bugUnconfirmed');
    expect(bugReportLeaveWarning({ attempted: true, outcome: 'received' }, false, true)).toBe('diagnostic.bugReceived');
    expect(bugReportLeaveWarning({ attempted: false, outcome: 'idle' }, false, true)).toBe('diagnostic.bugDraftLocalInfo');
  });

  it.each(LANGUAGES)('%s exposes the localized local form, privacy, cleanup timing, and stable native hooks', language => {
    const html = markup(language);
    const text = catalogs[language] as Record<string, string>;
    for (const [id, key] of [
      ['bug-report-dialog', 'diagnostic.bugTitle'], ['bug-report-description', 'diagnostic.bugWhatHappened'],
      ['bug-report-diagnostics', 'diagnostic.bugIncludeTechnical'], ['bug-report-review', 'diagnostic.bugReview'],
      ['bug-report-save-draft', 'diagnostic.bugSaveDraft'], ['bug-report-cancel', 'diagnostic.cancel'], ['bug-report-copy', 'diagnostic.copy'],
      [BUG_REPORT_CLOSE_TEST_IDS.header, 'common.close'],
    ]) expect(html, `${language} ${id}`).toContain(`data-testid="${id}"`);
    expect(html).toContain(text['diagnostic.bugCleanupTiming']);
    expect(html).toContain(text['diagnostic.bugRetention']);
    expect(html).toContain(text['diagnostic.bugDraftLocalInfo']);
    expect(html).not.toMatch(/https?:|github\.com|dashboard/i);
  });

  it('keeps browser sending unavailable and does not render external account or attachment fields', () => {
    const html = markup('en');
    expect(html).toContain('Report sending is unavailable in the web version.');
    expect(html).not.toMatch(/type="(?:email|password|file)"|name="(?:email|password|account|attachment)"/i);
  });

  it('copies only after an explicit call and writes only the current description', async () => {
    const clipboard = { writeText: vi.fn(async () => undefined) };
    expect(await copyBugReportText('Current local text.', clipboard)).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith('Current local text.');
    expect(Object.keys(clipboard)).toEqual(['writeText']);
  });

  it('wraps Tab and Shift+Tab inside the dirty-close prompt controls', () => {
    const first = { focus: vi.fn() };
    const last = { focus: vi.fn() };
    const preventShift = vi.fn();
    trapBugReportPromptTab({ key: 'Tab', shiftKey: true, preventDefault: preventShift }, [first, last], 0);
    expect(preventShift).toHaveBeenCalledOnce();
    expect(last.focus).toHaveBeenCalledOnce();
    const preventTab = vi.fn();
    trapBugReportPromptTab({ key: 'Tab', shiftKey: false, preventDefault: preventTab }, [first, last], 1);
    expect(preventTab).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledOnce();
  });

  it('Escape dismisses the dirty-close prompt and prevents the underlying report dialog from closing', () => {
    const preventDefault = vi.fn();
    const dismiss = vi.fn();
    handleBugReportPromptKey({ key: 'Escape', shiftKey: false, preventDefault }, [], -1, dismiss);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
