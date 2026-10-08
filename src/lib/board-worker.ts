import { GenCadParseError } from './gencad';
import { parseBoard } from './formats';
import { BoardFormatError } from './formats/common';
import { createModelHost } from './model-host';
import type { ModelHost } from './model-host';
import { MODEL_PROTOCOL } from './model-protocol';
import { withParseProgress } from './parse-progress';
import type { FormatFailure, ImportOptions } from './types';

interface ImportMessage { name: string; data: Uint8Array; companions?: Record<string, Uint8Array>; options?: ImportOptions }
/** A progress message is posted when the parser advanced by at least this fraction (at most about a hundred per file). */
const PROGRESS_STEP = 0.01;

// One worker per import. The original bytes arrive here (transferred, never decoded by the transport) and the dispatcher
// recognizes the format; meanwhile `{ progress: { fraction } }` messages report how far a parser that knows it got (the UI's
// watchdog reads them as signs of life). A failure travels structured: a GenCAD issue (localized when shown), a recognized-format
// failure with the parser's English text and code (key dialogs key off it), or an unexpected error; the UI then ends the worker.
// After a successful parse the worker stays alive as the board's model worker (model-protocol.ts): every later message is a
// model request about this board, answered by the model host, until the UI terminates the worker.
let host: ModelHost | null = null;
self.onmessage = (event: MessageEvent<ImportMessage>) => {
  if (host) { host.receive(event.data); return; }
  const { name, data, companions, options } = event.data;
  try {
    if (typeof name !== 'string' || !(data instanceof Uint8Array)) throw new Error('Invalid import message.');
    let posted = 0;
    const board = withParseProgress(fraction => {
      if (fraction - posted < PROGRESS_STEP && fraction < 1) return;
      posted = fraction;
      self.postMessage({ progress: { fraction } });
    }, () => parseBoard({ name, data, companions, options }));
    self.postMessage({ board, model: MODEL_PROTOCOL });
    host = createModelHost(board, response => self.postMessage(response));
    host.warm();
  } catch (error) {
    if (error instanceof GenCadParseError) self.postMessage({ issue: error.issue });
    else if (error instanceof BoardFormatError) {
      const formatError: FormatFailure = { message: error.message, code: error.code, ...(error.format ? { format: error.format } : {}), ...(error.keyKind ? { keyKind: error.keyKind } : {}) };
      self.postMessage({ formatError });
    } else self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
