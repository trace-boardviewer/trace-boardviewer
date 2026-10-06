import { describe, expect, it } from 'vitest';
import { errorText, isAbortError, isClosingError, nativeCode, nativeFailure, parseNativeError, UiError } from './errors';

describe('native error mapping', () => {
  it('strips Electron\'s remote-method wrapper and reads the "[CODE] text" prefix', () => {
    const error = new Error("Error invoking remote method 'trace:save-workspace': Error: [STORE_CLOSING] The application is quitting.");
    expect(parseNativeError(error)).toEqual({ code: 'STORE_CLOSING', text: 'The application is quitting.' });
    expect(nativeCode(error)).toBe('STORE_CLOSING');
    expect(nativeFailure(error, { text: 'fallback' })).toEqual({ text: 'The application is quitting.' });
  });

  it('handles the preload form (already stripped, code also on the error) and a bare message', () => {
    expect(parseNativeError(Object.assign(new Error('[DOCUMENT_NOT_FOUND] No such file.'), { code: 'DOCUMENT_NOT_FOUND' }))).toEqual({ code: 'DOCUMENT_NOT_FOUND', text: 'No such file.' });
    expect(parseNativeError(new Error('plain failure'))).toEqual({ text: 'plain failure' });
    expect(parseNativeError(Object.assign(new Error('no prefix'), { code: 'ENOENT' }))).toEqual({ code: 'ENOENT', text: 'no prefix' });
  });

  it('does not mistake text in brackets in the middle of a message for a code', () => {
    expect(parseNativeError(new Error('The file [ABC] is odd'))).toEqual({ text: 'The file [ABC] is odd' });
    expect(parseNativeError(new Error('[ab] lower case is not a code'))?.code).toBeUndefined();
  });

  it('falls back for values without a message and for empty text', () => {
    expect(parseNativeError(42)).toBeNull();
    expect(parseNativeError(undefined)).toBeNull();
    expect(nativeFailure(undefined, { text: 'fallback' })).toEqual({ text: 'fallback' });
    expect(nativeFailure(new Error(''), { text: 'fallback' })).toEqual({ text: 'fallback' });
    expect(errorText(new Error("Error invoking remote method 'x': Error: [A_B_C] boom"), 'f')).toBe('boom');
    expect(errorText(null, 'fallback text')).toBe('fallback text');
  });

  it('UiError keeps its message object for later localisation', () => {
    const message = { key: 'toast.parseFailed' as const };
    expect(nativeFailure(new UiError(message), { text: 'x' })).toBe(message);
  });

  it('recognizes abort-like errors', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError(Object.assign(new Error('x'), { code: 'ABORTED' }))).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
  });
});

describe('quit-time codes', () => {
  it('treats every *_CLOSING code as a closing error, however the bridge delivered it', () => {
    for (const code of ['BOARD_CLOSING', 'DOCUMENT_CLOSING', 'STORE_CLOSING', 'EXPORT_CLOSING']) {
      expect(isClosingError(new Error(`Error invoking remote method 'trace:x': Error: [${code}] The application is quitting.`)), code).toBe(true);
      expect(isClosingError(Object.assign(new Error('quitting'), { code })), code).toBe(true);
    }
    expect(isClosingError(new Error('[STORE_TOO_LARGE] too big'))).toBe(false);
    expect(isClosingError(new Error('The window is CLOSING'))).toBe(false);
    expect(isClosingError(undefined)).toBe(false);
  });
});
