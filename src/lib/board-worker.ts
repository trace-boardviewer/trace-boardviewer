import { GenCadParseError } from './gencad';
import { parseBoard } from './formats';
import { BoardFormatError } from './formats/common';
import type { FormatFailure, ImportOptions } from './types';

interface ImportMessage { name: string; data: Uint8Array; companions?: Record<string, Uint8Array>; options?: ImportOptions }
// The original bytes arrive here (transferred, never decoded by the transport) and the dispatcher recognizes the
// format. A failure travels structured: a GenCAD issue (localized when shown), a recognized-format failure with
// the parser's English text and code (key dialogs key off it), or an unexpected error.
self.onmessage = (event: MessageEvent<ImportMessage>) => {
  const { name, data, companions, options } = event.data;
  try {
    if (typeof name !== 'string' || !(data instanceof Uint8Array)) throw new Error('Invalid import message.');
    self.postMessage({ board: parseBoard({ name, data, companions, options }) });
  } catch (error) {
    if (error instanceof GenCadParseError) self.postMessage({ issue: error.issue });
    else if (error instanceof BoardFormatError) {
      const formatError: FormatFailure = { message: error.message, code: error.code, ...(error.format ? { format: error.format } : {}), ...(error.keyKind ? { keyKind: error.keyKind } : {}) };
      self.postMessage({ formatError });
    } else self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
