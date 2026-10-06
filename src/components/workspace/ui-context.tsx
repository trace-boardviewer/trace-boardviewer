import { createContext, useContext } from 'react';
import type { Formatters, Language, Message, Translator } from '../../lib/i18n';

/** Language services shared by every panel (stable until the language changes) plus the clipboard helper. */
export interface UiContextValue {
  t: Translator;
  fmt: Formatters;
  language: Language;
  /** Renders a Message in the active language. */
  text(message: Message): string;
  copy(value: string): void;
}
export const UiContext = createContext<UiContextValue | null>(null);
export function useUi(): UiContextValue {
  const value = useContext(UiContext);
  if (!value) throw new Error('UiContext is missing');
  return value;
}
