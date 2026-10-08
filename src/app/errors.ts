import type { Message } from '../lib/i18n';
import type { FormatFailure } from '../lib/types';

/** An error whose text is chosen when it is shown, in the language active at that moment. */
export class UiError extends Error {
  readonly msg: Message;
  constructor(msg: Message) { super('UiError'); this.msg = msg; }
}

/** A recognized format the parser could not read: its catalog message in the active language, or else its English text verbatim; its code may ask for a key. */
export class FormatFailureError extends UiError {
  readonly failure: FormatFailure;
  constructor(failure: FormatFailure) { super(failure.issue ? { issue: failure.issue } : { text: failure.message }); this.failure = failure; }
}

export interface NativeError {
  /** Stable machine code from a `[CODE] text` prefix (or a `.code` property that survived the bridge), when there is one. */
  code?: string;
  /** English text without Electron's `Error invoking remote method '<channel>': Error: ` wrapper and without the `[CODE] ` prefix. */
  text: string;
}

// Electron wraps a rejected invoke() as "Error invoking remote method '<channel>': Error: <text>" and the context bridge keeps
// only message and stack, so electron/preload.cjs puts the stable code in front of the text as "[CODE] text".
const REMOTE_PREFIX = /^Error invoking remote method '[^']*':\s*/;
const ERROR_PREFIX = /^(?:[A-Za-z]*Error:\s*)/;
const CODE_PREFIX = /^\[([A-Z][A-Z0-9_]{2,47})\]\s*/;

const messageOf = (error: unknown): string | undefined => {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
  return undefined;
};

/** Splits a native rejection into its code and clean English text; `null` when the value carries no message at all. */
export function parseNativeError(error: unknown): NativeError | null {
  const raw = messageOf(error);
  if (raw === undefined) return null;
  let text = raw.replace(REMOTE_PREFIX, '').replace(ERROR_PREFIX, '');
  let code: string | undefined;
  const match = CODE_PREFIX.exec(text);
  if (match) { code = match[1]; text = text.slice(match[0].length); }
  else if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') code = (error as { code: string }).code;
  return { ...(code ? { code } : {}), text: text.trim() };
}

export const nativeCode = (error: unknown): string | undefined => parseNativeError(error)?.code;

/** `BOARD_CLOSING`, `DOCUMENT_CLOSING`, `STORE_CLOSING`, `EXPORT_CLOSING`: the application is quitting, so the failure is neither shown nor retried. */
export const isClosingError = (error: unknown): boolean => nativeCode(error)?.endsWith('_CLOSING') === true;

/** Text of an error raised by the (already localized or English) native process is shown verbatim; anything else uses the fallback. */
export function nativeFailure(error: unknown, fallback: Message): Message {
  if (error instanceof UiError) return error.msg;
  const parsed = parseNativeError(error);
  return parsed?.text ? { text: parsed.text } : fallback;
}

/** Plain English text of an error for places that hold a string (save failures). */
export function errorText(error: unknown, fallback: string): string {
  if (error instanceof UiError) return 'text' in error.msg ? error.msg.text : fallback;
  return parseNativeError(error)?.text || fallback;
}

export const isAbortError = (error: unknown): boolean => typeof error === 'object' && error !== null && ((error as { name?: unknown }).name === 'AbortError' || (error as { code?: unknown }).code === 'ABORTED');
