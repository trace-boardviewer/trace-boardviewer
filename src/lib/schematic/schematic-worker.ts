import { loadSchematicDesign, SchematicError } from './index';
import type { SchematicDesign, SchematicErrorCode, SchematicFormat } from './model';

/**
 * Dedicated worker for ONE schematic document (parse + connectivity). The shell posts the ORIGINAL bytes (transferred,
 * never decoded by the transport); cancellation is `worker.terminate()` and latest-request-wins is the caller's
 * `requestId` check, exactly like board-worker.ts.
 */
export interface SchematicWorkerRequest {
  requestId: number;
  name: string;
  data: Uint8Array;
  /** Sibling schematic/library files of the same directory, lowercase basename keys. */
  companions?: Record<string, Uint8Array>;
}
export interface SchematicWorkerFailure { code: SchematicErrorCode | 'UNKNOWN'; message: string; format?: SchematicFormat }
export type SchematicWorkerResponse =
  | { requestId: number; design: SchematicDesign }
  | { requestId: number; error: SchematicWorkerFailure };

self.onmessage = (event: MessageEvent<SchematicWorkerRequest>) => {
  const { requestId, name, data, companions } = event.data;
  try {
    if (typeof name !== 'string' || !(data instanceof Uint8Array)) throw new SchematicError('Invalid schematic import message.', 'INVALID_FORMAT');
    const design = loadSchematicDesign({ name, data, companions });
    (self as unknown as Worker).postMessage({ requestId, design } satisfies SchematicWorkerResponse);
  } catch (error) {
    const failure: SchematicWorkerFailure = error instanceof SchematicError
      ? { code: error.code, message: error.message, ...(error.format ? { format: error.format } : {}) }
      : { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
    (self as unknown as Worker).postMessage({ requestId, error: failure } satisfies SchematicWorkerResponse);
  }
};
