/**
 * Typed messages between the UI thread and the model worker of an open board (model-host.ts runs the worker side,
 * src/app/model-client.ts the UI side). Plain structured-clone data only.
 *
 * Life cycle: the board worker parses the file, posts `{ board, model: MODEL_PROTOCOL }` and then stays alive as the board's model
 * worker: it builds its own board index (the same `buildBoardIndex`) and answers queries until the board is closed. The UI never sends
 * the board back; schematic designs travel once per design (`token`), later requests name them by token.
 *
 * Every request carries an `id` chosen by the client; every request is answered exactly once, by a response with the same `id`:
 * its result, `cancelled` (a `cancel` for it arrived, or a newer request of the same type superseded it before it ran) or `error`.
 * A `cancel` itself is never answered. The client drops any response whose id it no longer waits for (stale-result protection), so a
 * late answer can never reach a newer query or another board.
 */
import type { BoardIndexStats } from './board-index';
import type { BoardSearchGroups, LinkOptions, LinkReport, SearchLimits } from './crossprobe';
import type { WorkspaceAliases } from './documents';
import type { SchematicDesign } from './schematic/model';

/** Version of this protocol; the parse reply announces it (`model`), and only then does the client use the worker. */
export const MODEL_PROTOCOL = 1;

/** A schematic of the link request: `design` is sent the first time its token is used, afterwards only the token. */
export interface ModelSchematicRef { documentId: string; token: number; design?: SchematicDesign }

export interface ModelSearchRequest { type: 'search'; id: number; query: string; limits?: Partial<SearchLimits> }
export interface ModelLinkRequest { type: 'link'; id: number; schematics: ModelSchematicRef[]; aliases?: WorkspaceAliases | null; options?: LinkOptions }
/** Builds the worker's index now (if it is not built yet) and reports its size and the time it took. */
export interface ModelIndexRequest { type: 'index'; id: number }
export interface ModelCancelRequest { type: 'cancel'; id: number }
export type ModelRequest = ModelSearchRequest | ModelLinkRequest | ModelIndexRequest | ModelCancelRequest;

export interface ModelIndexInfo { stats: BoardIndexStats; /** Wall time of the index build inside the worker, ms (0 when it was already built). */ buildMs: number }
export type ModelErrorCode = 'BAD_REQUEST' | 'UNKNOWN_SCHEMATIC' | 'FAILED';
export type ModelResponse =
  | { type: 'search'; id: number; result: BoardSearchGroups }
  | { type: 'link'; id: number; result: LinkReport }
  | { type: 'index'; id: number; result: ModelIndexInfo }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; code: ModelErrorCode; message: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Shape check of an incoming request (the worker side); anything else is answered with BAD_REQUEST when it has an id, or ignored. */
export function isModelRequest(value: unknown): value is ModelRequest {
  if (!isObject(value) || !isId(value.id)) return false;
  switch (value.type) {
    case 'search': return typeof value.query === 'string' && (value.limits === undefined || isObject(value.limits));
    case 'link': return Array.isArray(value.schematics) && value.schematics.every(item => isObject(item) && typeof item.documentId === 'string' && isId(item.token) && (item.design === undefined || isObject(item.design)));
    case 'index': case 'cancel': return true;
    default: return false;
  }
}

/** Shape check of an incoming response (the client side). */
export function isModelResponse(value: unknown): value is ModelResponse {
  if (!isObject(value) || !isId(value.id)) return false;
  switch (value.type) {
    case 'search': case 'link': case 'index': return isObject(value.result);
    case 'cancelled': return true;
    case 'error': return typeof value.code === 'string' && typeof value.message === 'string';
    default: return false;
  }
}
