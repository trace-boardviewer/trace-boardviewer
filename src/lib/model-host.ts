/**
 * Worker side of the model protocol (model-protocol.ts): owns one board, its board index and the schematics it was sent, and answers
 * search, index and link requests. Environment-agnostic: the board worker wires it to `postMessage`; tests run it in-process.
 *
 * The host keeps a copy of the board without geometry (`leanBoard`): search and the link report read ids, references, values,
 * packages, sides, pin numbers and names and nets only, so the worker does not hold a second full board next to the UI's.
 *
 * Requests are queued and run from a scheduled task, never inside the message event, so that a `cancel` or a newer request that is
 * already waiting is seen first: a search (or link) request with a newer one of its type behind it in the queue is answered `cancelled`
 * without running. A request that is running is not interrupted (each one is a bounded, synchronous computation); the client drops its
 * answer when nobody waits for it any more.
 */
import { buildBoardIndex } from './board-index';
import type { BoardIndex } from './board-index';
import { buildSchematicIndex, linkBoardSchematic, searchBoardGroups } from './crossprobe';
import type { SchematicIndex, SchematicSource } from './crossprobe';
import { isModelRequest } from './model-protocol';
import type { ModelRequest, ModelResponse } from './model-protocol';
import type { SchematicDesign } from './schematic/model';
import type { Board, BoardComponent, BoardPin, Bounds, Point } from './types';

export interface ModelHostOptions {
  /** Runs the queue soon; default `setTimeout(run, 0)`. Tests pass a manual scheduler. */
  schedule?(run: () => void): void;
  now?(): number;
}
export interface ModelHost {
  /** One incoming message (anything: a malformed one is answered BAD_REQUEST when it names an id, otherwise ignored). */
  receive(message: unknown): void;
  /** Builds the index in a scheduled task, so the first query does not pay for it. */
  warm(): void;
}

const NO_POINTS: Point[] = [];
const NO_POINT: Point = { x: 0, y: 0 };
const NO_BOUNDS: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
/** The board as the model reads it: every id, name, side and net kept, all geometry (outlines, bounds, pad shapes) dropped. */
export function leanBoard(board: Board): Board {
  const components = board.components.map((c): BoardComponent => ({
    id: c.id, ref: c.ref, ...(c.refGenerated ? { refGenerated: true as const } : {}), value: c.value, package: c.package, side: c.side,
    bounds: NO_BOUNDS, position: NO_POINT, rotation: 0, pinIds: c.pinIds, outline: NO_POINTS,
  }));
  const pins = board.pins.map((p): BoardPin => ({
    id: p.id, componentId: p.componentId, number: p.number, ...(p.numberGenerated ? { numberGenerated: true as const } : {}), name: p.name, net: p.net, side: p.side,
    x: 0, y: 0, radius: 0, shape: 'round',
  }));
  return { name: board.name, format: board.format, units: board.units, components, pins, nets: board.nets, outline: NO_POINTS, bounds: board.bounds, warnings: [] };
}

export function createModelHost(input: Board, post: (response: ModelResponse) => void, options: ModelHostOptions = {}): ModelHost {
  const board = leanBoard(input);
  const schedule = options.schedule ?? (run => { setTimeout(run, 0); });
  const now = options.now ?? (() => performance.now());
  let index: BoardIndex | null = null;
  let buildMs = 0;
  const designs = new Map<number, { documentId: string; design: SchematicDesign }>();
  let schematicCache: { key: string; index: SchematicIndex } | null = null;
  const queue: ModelRequest[] = [];
  let scheduled = false;

  /** The index with the layers every query reads (references, nets, search records) already built. */
  const ensureIndex = (): BoardIndex => {
    if (!index) {
      const started = now();
      const built = buildBoardIndex(board);
      void built.search; void built.nets;
      buildMs = now() - started;
      index = built;
    }
    return index;
  };

  const run = (request: Exclude<ModelRequest, { type: 'cancel' }>): ModelResponse => {
    switch (request.type) {
      case 'search': return { type: 'search', id: request.id, result: searchBoardGroups(request.query, ensureIndex(), request.limits) };
      case 'index': { const built = ensureIndex(); return { type: 'index', id: request.id, result: { stats: built.stats, buildMs } }; }
      case 'link': {
        const sources: SchematicSource[] = [];
        for (const ref of request.schematics) {
          const known = designs.get(ref.token);
          if (!known) return { type: 'error', id: request.id, code: 'UNKNOWN_SCHEMATIC', message: `Schematic ${ref.token} was never sent.` };
          sources.push({ documentId: ref.documentId, design: known.design });
        }
        // Designs the client no longer names are dropped; the client resends a design whenever it uses a token the worker did not keep.
        const wanted = new Set(request.schematics.map(ref => ref.token));
        for (const token of [...designs.keys()]) if (!wanted.has(token)) designs.delete(token);
        const key = request.schematics.map(ref => `${ref.token}:${ref.documentId}`).join('|');
        if (schematicCache?.key !== key) schematicCache = { key, index: buildSchematicIndex(sources) };
        return { type: 'link', id: request.id, result: linkBoardSchematic(ensureIndex(), schematicCache.index, request.aliases, request.options) };
      }
    }
  };

  const drain = (): void => {
    scheduled = false;
    while (queue.length) {
      const request = queue.shift()!;
      if (request.type === 'cancel') continue;
      if ((request.type === 'search' || request.type === 'link') && queue.some(other => other.type === request.type)) { post({ type: 'cancelled', id: request.id }); continue; }
      let response: ModelResponse;
      try { response = run(request); }
      catch (error) { response = { type: 'error', id: request.id, code: 'FAILED', message: error instanceof Error ? error.message : String(error) }; }
      post(response);
    }
  };
  const kick = () => { if (!scheduled) { scheduled = true; schedule(drain); } };

  return {
    receive(message) {
      if (!isModelRequest(message)) {
        const id = (message as { id?: unknown } | null)?.id;
        if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) post({ type: 'error', id, code: 'BAD_REQUEST', message: 'Malformed model request.' });
        return;
      }
      if (message.type === 'cancel') {
        const at = queue.findIndex(request => request.id === message.id);
        if (at >= 0) { queue.splice(at, 1); post({ type: 'cancelled', id: message.id }); }
        return;
      }
      // Designs are kept on arrival, even when the request itself is superseded before it runs: later requests name them by token only.
      if (message.type === 'link') for (const ref of message.schematics) if (ref.design) designs.set(ref.token, { documentId: ref.documentId, design: ref.design });
      queue.push(message);
      kick();
    },
    warm() { schedule(() => { try { ensureIndex(); } catch { /* the first query reports the failure */ } }); },
  };
}
