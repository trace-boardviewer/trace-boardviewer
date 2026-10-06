/**
 * The shell's global keyboard shortcuts as a pure decision: Shell.tsx hands over the key event and what is on screen and performs
 * the action named here. Keeping the rules in one place makes every guard testable without a DOM: which dialog swallows which key,
 * where a typed "?" stays text, how Alt+digit is read on a Mac, which keys the viewers keep for themselves.
 */
export interface ShortcutKey { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }

export interface ShortcutContext {
  /** One of the shell's modal dialogs (settings, help, recents, info, export, link) is open. */
  modal: boolean;
  /** The note editor is open. */
  note: boolean;
  /** An encryption key is being asked for (the dialog may still wait behind the support notice): nothing may disturb the request. */
  keyRequest: boolean;
  hasBoard: boolean;
  /** The board canvas is on screen (Board tab, or the split view). */
  boardVisible: boolean;
  /** The key was typed into a text field (input, textarea, select, contenteditable). */
  editable: boolean;
  /** The key was pressed inside a document viewer (.pdfv, .schv, .imgv), which owns its keys. */
  viewer: boolean;
  /** The key was pressed inside the PDF viewer: Ctrl+F searches the document, not the board. */
  pdf: boolean;
}

export type ShortcutAction =
  | 'close-modal' | 'open' | 'search' | 'pdf-search' | 'help' | 'layout-workshop' | 'layout-focus' | 'split'
  | 'tab-board' | 'tab-schematic' | 'tab-documents' | 'fit' | 'rotate' | 'measure' | 'labels' | 'note' | 'zoom-in' | 'zoom-out' | 'clear';

/** What the shell does with the key: the action (null = nothing, the key is only swallowed) and whether the browser default is suppressed. */
export interface ShortcutResult { action: ShortcutAction | null; prevent: boolean }

const act = (action: ShortcutAction | null, prevent = true): ShortcutResult => ({ action, prevent });

/** The digit of Alt+1/2/3, by physical key first: on macOS Option+digit types a symbol ("¡", "™", "£"), so `key` never reads "1" there. */
function tabDigit(event: ShortcutKey): '1' | '2' | '3' | null {
  const digit = /^(?:Digit|Numpad)([123])$/.exec(event.code ?? '')?.[1] ?? (/^[123]$/.test(event.key) ? event.key : null);
  return digit === '1' || digit === '2' || digit === '3' ? digit : null;
}

/** `null` means the key is not a shortcut here and stays with the focused element. */
export function resolveShortcut(event: ShortcutKey, ctx: ShortcutContext): ShortcutResult | null {
  // A modal dialog owns the keyboard. The key dialog and the note editor handle Esc themselves (the dialog's cancel); the other
  // modals also close through the shell, which covers a key that reaches the window from outside the dialog.
  if (ctx.keyRequest || ctx.note) return null;
  if (ctx.modal) return event.key === 'Escape' ? act('close-modal') : null;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (mod && key === 'o') return act('open');
  if (mod && key === 'f') return act(ctx.pdf ? 'pdf-search' : ctx.hasBoard ? 'search' : null);
  // Without a board only the help shortcut remains; a "?" typed into a text field is text.
  if (!ctx.hasBoard) return key === 'f1' || (key === '?' && !ctx.editable) ? act('help') : null;
  if (mod && key === '1') return act('layout-workshop');
  if (mod && key === '2') return act('layout-focus');
  if (mod && event.key === '\\') return act('split');
  if (event.altKey && !mod) {
    const digit = tabDigit(event);
    if (digit) return act(digit === '1' ? 'tab-board' : digit === '2' ? 'tab-schematic' : 'tab-documents');
  }
  if (ctx.editable) return null;
  if (key === '?' || key === 'f1') return act('help');
  // The viewers own their keys (pan, zoom, page navigation); the board shortcuts apply to the board only.
  if (!ctx.boardVisible || ctx.viewer || mod || event.altKey) return null;
  switch (key) {
    case 'f': return act('fit', false);
    case 'r': return act('rotate', false);
    case 'm': return act('measure', false);
    case 'l': return act('labels', false);
    // preventDefault: the dialog takes focus during this keydown, and its default action would type "n" into the note (B13).
    case 'n': return act('note');
    case '+': case '=': return act('zoom-in', false);
    case '-': return act('zoom-out', false);
    case 'escape': return act('clear', false);
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Shortcut hints
// ---------------------------------------------------------------------------------------------------------------

export interface PlatformSource { platform?: string; userAgentData?: { platform?: string } }
const currentNavigator = (): PlatformSource => (typeof navigator === 'undefined' ? {} : navigator);

/** True on Apple platforms, where the Command key plays the part of Ctrl (`navigator.platform` still says "MacIntel" on Apple silicon). */
export function isApplePlatform(nav: PlatformSource = currentNavigator()): boolean {
  const platform = nav.userAgentData?.platform || nav.platform || '';
  return /^(?:mac|iphone|ipad|ipod)/i.test(platform);
}

/** The modifier names shown in shortcut hints: the handlers accept Ctrl and Cmd alike, the labels name the keys of the platform. */
export function modifierLabels(nav: PlatformSource = currentNavigator()): { mod: string; alt: string } {
  return isApplePlatform(nav) ? { mod: 'Cmd', alt: 'Option' } : { mod: 'Ctrl', alt: 'Alt' };
}
