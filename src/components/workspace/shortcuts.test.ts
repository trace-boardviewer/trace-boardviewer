import { describe, expect, it } from 'vitest';
import { isApplePlatform, modifierLabels, resolveShortcut } from './shortcuts';
import type { ShortcutContext, ShortcutKey } from './shortcuts';

/** The shell's global shortcuts (Shell.tsx hands the decision to resolveShortcut): which dialog swallows which key, and the Mac readings. */
const press = (key: string, over: Partial<ShortcutKey> = {}): ShortcutKey => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...over });
const ctrl = (key: string, over: Partial<ShortcutKey> = {}) => press(key, { ctrlKey: true, ...over });
const alt = (key: string, over: Partial<ShortcutKey> = {}) => press(key, { altKey: true, ...over });
const base: ShortcutContext = { modal: false, note: false, keyRequest: false, hasBoard: true, boardVisible: true, editable: false, viewer: false, pdf: false };
const ctx = (over: Partial<ShortcutContext> = {}): ShortcutContext => ({ ...base, ...over });
const action = (event: ShortcutKey, over: Partial<ShortcutContext> = {}) => resolveShortcut(event, ctx(over))?.action ?? null;
const EMPTY = { hasBoard: false, boardVisible: false };

// Every shortcut the shell knows, including the ones that leaked behind the key dialog (F1, ?, Alt+2, Ctrl+\, m, Ctrl+O).
const EVERY_KEY: ShortcutKey[] = [press('F1'), press('?'), alt('2', { code: 'Digit2' }), ctrl('\\'), press('m'), ctrl('o'), ctrl('f'), ctrl('1'), ctrl('2'), press('f'), press('r'), press('l'), press('n'), press('Escape'), press('+'), press('='), press('-')];

describe('resolveShortcut: dialogs own the keyboard', () => {
  it('H3-02: while an encryption key is being asked for, no shortcut fires, Esc included (the dialog cancels itself)', () => {
    for (const event of EVERY_KEY) expect(resolveShortcut(event, ctx({ keyRequest: true })), event.key).toBeNull();
    for (const event of EVERY_KEY) expect(resolveShortcut(event, ctx({ keyRequest: true, ...EMPTY })), event.key).toBeNull();
  });

  it('the note editor swallows everything; the other modals let only Esc through, which closes them', () => {
    for (const event of EVERY_KEY) expect(resolveShortcut(event, ctx({ note: true })), event.key).toBeNull();
    for (const event of EVERY_KEY) expect(resolveShortcut(event, ctx({ modal: true })), event.key).toEqual(event.key === 'Escape' ? { action: 'close-modal', prevent: true } : null);
  });

  it('a pending key request wins over an open modal: Esc goes to the key dialog, not to the modal behind it', () => {
    expect(resolveShortcut(press('Escape'), ctx({ modal: true, keyRequest: true }))).toBeNull();
  });
});

describe('resolveShortcut: without a board', () => {
  it('only Open, the help (F1 / ?) and a swallowed Ctrl+F remain', () => {
    expect(resolveShortcut(ctrl('o'), ctx(EMPTY))).toEqual({ action: 'open', prevent: true });
    expect(resolveShortcut(ctrl('f'), ctx(EMPTY))).toEqual({ action: null, prevent: true });
    expect(resolveShortcut(press('F1'), ctx(EMPTY))).toEqual({ action: 'help', prevent: true });
    expect(action(press('?'), EMPTY)).toBe('help');
    for (const event of [press('f'), press('m'), press('n'), ctrl('1'), ctrl('\\'), alt('2', { code: 'Digit2' }), press('Escape')]) expect(action(event, EMPTY), event.key).toBeNull();
  });

  it('a "?" typed into a text field stays text; F1 still opens the help', () => {
    expect(action(press('?'), { ...EMPTY, editable: true })).toBeNull();
    expect(action(press('F1'), { ...EMPTY, editable: true })).toBe('help');
    expect(action(press('?'), { editable: true })).toBeNull();
  });
});

describe('resolveShortcut: with a board', () => {
  it('Ctrl and Cmd are the same modifier (Open, search, layouts, split view)', () => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(action(press('o', modifier))).toBe('open');
      expect(action(press('O', modifier))).toBe('open');
      expect(action(press('f', modifier))).toBe('search');
      expect(action(press('f', modifier), { pdf: true, viewer: true })).toBe('pdf-search');
      expect(action(press('1', modifier))).toBe('layout-workshop');
      expect(action(press('2', modifier))).toBe('layout-focus');
      expect(action(press('\\', modifier))).toBe('split');
    }
  });

  it('Open, search, the layouts, the split view and the tab keys also work from a text field', () => {
    expect(action(ctrl('o'), { editable: true })).toBe('open');
    expect(action(ctrl('f'), { editable: true })).toBe('search');
    expect(action(ctrl('1'), { editable: true })).toBe('layout-workshop');
    expect(action(ctrl('\\'), { editable: true })).toBe('split');
    expect(action(alt('3', { code: 'Digit3' }), { editable: true })).toBe('tab-documents');
  });

  it('Alt+1/2/3 switch the tabs by physical key: on a Mac Option+digit reports a symbol, the numpad reports a digit', () => {
    expect(action(alt('1', { code: 'Digit1' }))).toBe('tab-board');
    expect(action(alt('2', { code: 'Digit2' }))).toBe('tab-schematic');
    expect(action(alt('3', { code: 'Digit3' }))).toBe('tab-documents');
    expect(action(alt('¡', { code: 'Digit1' }))).toBe('tab-board'); // macOS, US layout
    expect(action(alt('™', { code: 'Digit2' }))).toBe('tab-schematic');
    expect(action(alt('£', { code: 'Digit3' }))).toBe('tab-documents');
    expect(action(alt('2', { code: 'Numpad2' }))).toBe('tab-schematic');
    expect(action(alt('2'))).toBe('tab-schematic'); // no code at all: the key is enough
    expect(resolveShortcut(alt('¡', { code: 'Digit1' }), ctx())?.prevent).toBe(true);
    expect(action(alt('4', { code: 'Digit4' }))).toBeNull();
    expect(action(alt('1', { code: 'Digit1', ctrlKey: true }))).toBe('layout-workshop'); // Ctrl wins (AltGr reports Ctrl+Alt)
    expect(action(press('1', { code: 'Digit1' }))).toBeNull();
    expect(action(alt('1', { code: 'Digit1' }), EMPTY)).toBeNull();
  });

  it('the board keys apply to the visible board only and leave the browser default alone (except N, which opens the note)', () => {
    const expected: Array<[ShortcutKey, string, boolean]> = [
      [press('f'), 'fit', false], [press('R'), 'rotate', false], [press('m'), 'measure', false], [press('l'), 'labels', false], [press('n'), 'note', true],
      [press('+'), 'zoom-in', false], [press('='), 'zoom-in', false], [press('-'), 'zoom-out', false], [press('Escape'), 'clear', false],
    ];
    for (const [event, name, prevent] of expected) expect(resolveShortcut(event, ctx()), event.key).toEqual({ action: name, prevent });
    for (const [event] of expected) {
      expect(action(event, { boardVisible: false }), `${event.key} with the board hidden`).toBeNull();
      expect(action(event, { viewer: true }), `${event.key} inside a viewer`).toBeNull();
      expect(action(event, { editable: true }), `${event.key} in a text field`).toBeNull();
      expect(action(press(event.key, { altKey: true })), `Alt+${event.key}`).toBeNull();
      expect(action(press(event.key, { ctrlKey: true })), `Ctrl+${event.key}`).toBe(event.key === 'f' ? 'search' : null);
    }
    expect(resolveShortcut(press('?'), ctx())).toEqual({ action: 'help', prevent: true });
    expect(resolveShortcut(press('F1'), ctx({ boardVisible: false }))).toEqual({ action: 'help', prevent: true });
    expect(action(press('x'))).toBeNull();
  });
});

describe('shortcut hints', () => {
  it('name the platform modifier: Cmd / Option on Apple platforms (userAgentData or the legacy platform string), Ctrl / Alt elsewhere', () => {
    expect(isApplePlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isApplePlatform({ userAgentData: { platform: 'macOS' } })).toBe(true);
    expect(isApplePlatform({ userAgentData: { platform: 'Windows' }, platform: 'Win32' })).toBe(false);
    expect(isApplePlatform({ platform: 'Linux x86_64' })).toBe(false);
    expect(isApplePlatform({})).toBe(false);
    expect(modifierLabels({ platform: 'MacIntel' })).toEqual({ mod: 'Cmd', alt: 'Option' });
    expect(modifierLabels({ platform: 'Win32' })).toEqual({ mod: 'Ctrl', alt: 'Alt' });
    expect(['Ctrl', 'Cmd']).toContain(modifierLabels().mod);
  });
});
