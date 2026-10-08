import type { BoardSearchGroups, LinkOptions, LinkReport, SchematicSource, SearchLimits } from '../lib/crossprobe';
import type { WorkspaceAliases } from '../lib/documents';
import { isModelResponse } from '../lib/model-protocol';
import type { ModelErrorCode, ModelIndexInfo, ModelRequest, ModelResponse, ModelSchematicRef } from '../lib/model-protocol';
import type { SchematicDesign } from '../lib/schematic/model';
import type { WorkerPort } from './controller';

/**
 * UI side of the model protocol (src/lib/model-protocol.ts): typed requests to the model worker of the open board, each a promise.
 *
 *  - Latest wins: a new search (or link) request cancels the one still waiting; the older promise rejects with an AbortError.
 *  - Cancellation: an AbortSignal cancels a request (a `cancel` message goes to the worker, the promise rejects with an AbortError).
 *  - Stale results: a response is applied only while its request id is waited for; anything else (a superseded or cancelled request,
 *    an unknown id, a malformed message) is dropped, so a late answer never reaches a newer query, and none reaches another board
 *    (one client per board; `dispose` ends it with its worker).
 *  - A crashed worker (`fail`) rejects everything waiting and every later call; the caller falls back to its own index.
 */
export class ModelError extends Error {
  constructor(readonly code: ModelErrorCode | 'STOPPED', message: string) { super(message); this.name = 'ModelError'; }
}
const aborted = (message: string) => new DOMException(message, 'AbortError');

export interface ModelClient {
  readonly alive: boolean;
  search(query: string, options?: { limits?: Partial<SearchLimits>; signal?: AbortSignal }): Promise<BoardSearchGroups>;
  link(sources: readonly SchematicSource[], aliases: WorkspaceAliases | null | undefined, options?: { signal?: AbortSignal; link?: LinkOptions }): Promise<LinkReport>;
  index(options?: { signal?: AbortSignal }): Promise<ModelIndexInfo>;
  /** One message from the worker. */
  receive(data: unknown): void;
  /** The worker stopped (crash): everything waiting rejects with a ModelError, and so does every later call. */
  fail(): void;
  /** Ends the worker; everything waiting rejects with an AbortError. */
  dispose(): void;
}

type Body = ModelRequest extends infer R ? R extends { id: number } ? Omit<R, 'id'> : never : never;
interface Waiting { type: 'search' | 'link' | 'index'; resolve(value: unknown): void; reject(error: unknown): void; detach(): void }

export function createModelClient(port: WorkerPort): ModelClient {
  let nextId = 0;
  let alive = true;
  const waiting = new Map<number, Waiting>();
  const tokens = new WeakMap<SchematicDesign, number>();
  let nextToken = 0;
  /** Tokens whose design the worker holds (the worker keeps exactly the tokens of the last link request it ran). */
  let sent = new Set<number>();

  const settle = (id: number): Waiting | undefined => { const entry = waiting.get(id); if (entry) { waiting.delete(id); entry.detach(); } return entry; };
  const cancel = (id: number, error: unknown) => {
    const entry = settle(id);
    if (!entry) return;
    try { port.post({ type: 'cancel', id }); } catch { /* the worker is gone; nothing waits for the answer anyway */ }
    entry.reject(error);
  };
  const request = <T>(body: Body, signal?: AbortSignal): Promise<T> => {
    if (!alive) return Promise.reject(new ModelError('STOPPED', 'The board model is not running.'));
    if (signal?.aborted) return Promise.reject(aborted('The request was cancelled.'));
    const type = body.type as Waiting['type'];
    // Latest wins: the previous request of this type is no longer wanted.
    if (type !== 'index') for (const [id, entry] of [...waiting]) if (entry.type === type) cancel(id, aborted('A newer request replaced this one.'));
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => cancel(id, aborted('The request was cancelled.'));
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.set(id, { type, resolve: resolve as (value: unknown) => void, reject, detach: () => signal?.removeEventListener('abort', onAbort) });
      try { port.post({ ...body, id } as ModelRequest); }
      catch (error) { settle(id); reject(error); }
    });
  };
  const tokenOf = (design: SchematicDesign): number => { let token = tokens.get(design); if (token === undefined) tokens.set(design, token = ++nextToken); return token; };
  const refsOf = (sources: readonly SchematicSource[]): ModelSchematicRef[] => {
    const refs = sources.map(source => { const token = tokenOf(source.design); return { documentId: source.documentId, token, ...(sent.has(token) ? {} : { design: source.design }) }; });
    sent = new Set(refs.map(ref => ref.token));
    return refs;
  };

  return {
    get alive() { return alive; },
    search: (query, options = {}) => request<BoardSearchGroups>({ type: 'search', query, ...(options.limits ? { limits: options.limits } : {}) }, options.signal),
    async link(sources, aliases, options = {}) {
      const send = () => request<LinkReport>({ type: 'link', schematics: refsOf(sources), aliases: aliases ?? null, ...(options.link ? { options: options.link } : {}) }, options.signal);
      try { return await send(); }
      catch (error) {
        // The worker no longer holds a design the client thought it had sent: send every design once more.
        if (error instanceof ModelError && error.code === 'UNKNOWN_SCHEMATIC') { sent = new Set(); return send(); }
        throw error;
      }
    },
    index: (options = {}) => request<ModelIndexInfo>({ type: 'index' }, options.signal),
    receive(data) {
      if (!isModelResponse(data)) return;
      const response = data as ModelResponse;
      const entry = settle(response.id);
      if (!entry) return; // stale: superseded, cancelled or unknown
      if (response.type === 'cancelled') entry.reject(aborted('The model cancelled the request.'));
      else if (response.type === 'error') entry.reject(new ModelError(response.code, response.message));
      else if (response.type !== entry.type) entry.reject(new ModelError('FAILED', 'The model answered with another kind of result.'));
      else entry.resolve(response.result);
    },
    fail() {
      if (!alive) return;
      alive = false;
      for (const id of [...waiting.keys()]) settle(id)?.reject(new ModelError('STOPPED', 'The board model stopped unexpectedly.'));
      try { port.terminate(); } catch { /* already gone */ }
    },
    dispose() {
      if (!alive) return;
      alive = false;
      for (const id of [...waiting.keys()]) settle(id)?.reject(aborted('The board was closed.'));
      try { port.terminate(); } catch { /* already gone */ }
    },
  };
}
