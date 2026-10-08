import { describe, expect, it } from 'vitest';
import { buildBoardIndex } from '../lib/board-index';
import { buildSchematicIndex, linkBoardSchematic, searchBoardGroups } from '../lib/crossprobe';
import { createModelHost } from '../lib/model-host';
import type { ModelHost } from '../lib/model-host';
import { createModelClient, ModelError } from './model-client';
import { dividerBoard, dividerDesign, flushMicrotasks, twinDesign } from './testing';

/** A client wired to a recording port; the test answers by hand (`answer`). */
function manualClient() {
  const posted: Array<Record<string, unknown>> = [];
  let terminated = 0;
  const client = createModelClient({ post: message => { posted.push(message as Record<string, unknown>); }, terminate: () => { terminated++; } });
  return { client, posted, terminated: () => terminated };
}
const rejection = async (promise: Promise<unknown>): Promise<unknown> => { try { await promise; } catch (error) { return error; } throw new Error('resolved'); };
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** A client and a real host, connected like the UI and the worker: every message is structured-cloned, the host runs from microtasks. */
function connected(board = dividerBoard()) {
  const requests: Array<{ type: string; id: number; schematics?: Array<{ design?: unknown }> }> = [];
  let host: ModelHost | null = null;
  let hold: Promise<unknown> | null = null;
  const client = createModelClient({
    post: message => { requests.push(structuredClone(message) as (typeof requests)[number]); host!.receive(structuredClone(message)); },
    terminate: () => { host = null; },
  });
  host = createModelHost(structuredClone(board), response => { void (async () => { await hold; client.receive(structuredClone(response)); })(); }, { schedule: run => { void Promise.resolve().then(run); } });
  return { client, requests, holdResponses: (promise: Promise<unknown> | null) => { hold = promise; } };
}

describe('model client (UI side)', () => {
  it('resolves a search with the worker’s board groups (the same rows the UI thread would compute)', async () => {
    const board = dividerBoard();
    const { client, requests } = connected(board);
    const groups = await client.search('R');
    expect(groups).toEqual(searchBoardGroups('R', buildBoardIndex(board)));
    expect(requests).toEqual([{ type: 'search', id: 1, query: 'R' }]);
    expect(client.alive).toBe(true);
  });

  it('latest wins: a newer search cancels the waiting one, whose late answer is dropped', async () => {
    const { client, posted } = manualClient();
    const first = client.search('R');
    const second = client.search('R1');
    expect(isAbort(await rejection(first))).toBe(true);
    expect(posted.map(m => m.type)).toEqual(['search', 'cancel', 'search']);
    expect(posted[1]).toEqual({ type: 'cancel', id: 1 });
    // The worker answers the first request anyway (it was already running): nobody waits for it any more.
    client.receive({ type: 'search', id: 1, result: { query: 'R', groups: [] } });
    client.receive({ type: 'search', id: 2, result: { query: 'R1', groups: [] } });
    expect(await second).toEqual({ query: 'R1', groups: [] });
  });

  it('cancels through an AbortSignal (a cancel message goes to the worker)', async () => {
    const { client, posted } = manualClient();
    const abort = new AbortController();
    const pending = client.index({ signal: abort.signal });
    abort.abort();
    expect(isAbort(await rejection(pending))).toBe(true);
    expect(posted).toEqual([{ type: 'index', id: 1 }, { type: 'cancel', id: 1 }]);
    const already = new AbortController(); already.abort();
    expect(isAbort(await rejection(client.search('x', { signal: already.signal })))).toBe(true);
    expect(posted).toHaveLength(2); // an aborted signal sends nothing
  });

  it('drops stale, unknown and malformed responses and rejects a response of the wrong kind', async () => {
    const { client } = manualClient();
    const pending = client.search('R');
    client.receive({ type: 'search', id: 77, result: { query: 'R', groups: [] } }); // unknown id
    client.receive({ type: 'search', id: 1 }); // malformed
    client.receive('noise');
    client.receive(null);
    client.receive({ type: 'index', id: 1, result: { stats: {}, buildMs: 0 } });
    const error = await rejection(pending);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).code).toBe('FAILED');
  });

  it('maps worker answers: cancelled rejects as AbortError, error as ModelError with its code', async () => {
    const { client } = manualClient();
    const a = client.search('a');
    client.receive({ type: 'cancelled', id: 1 });
    expect(isAbort(await rejection(a))).toBe(true);
    const b = client.index();
    client.receive({ type: 'error', id: 2, code: 'BAD_REQUEST', message: 'Malformed model request.' });
    const error = await rejection(b);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ code: 'BAD_REQUEST', message: 'Malformed model request.' });
  });

  it('a crashed worker rejects everything waiting and every later call (STOPPED), and is terminated once', async () => {
    const { client, terminated } = manualClient();
    const a = client.search('a'), b = client.index();
    client.fail();
    for (const pending of [a, b]) expect(await rejection(pending)).toMatchObject({ code: 'STOPPED' });
    expect(await rejection(client.search('b'))).toMatchObject({ code: 'STOPPED' });
    expect(client.alive).toBe(false);
    client.fail(); client.dispose();
    expect(terminated()).toBe(1);
  });

  it('dispose() ends the worker and rejects what is waiting as AbortError', async () => {
    const { client, terminated } = manualClient();
    const a = client.search('a');
    client.dispose();
    expect(isAbort(await rejection(a))).toBe(true);
    expect(terminated()).toBe(1);
    expect(await rejection(client.index())).toMatchObject({ code: 'STOPPED' });
  });

  it('sends a schematic design once and names it by token afterwards; the report equals the UI-thread report', async () => {
    const board = dividerBoard(), design = dividerDesign(), twin = twinDesign();
    const { client, requests } = connected(board);
    const sources = [{ documentId: 'd1', design }];
    const report = await client.link(sources, null);
    expect(report).toEqual(linkBoardSchematic(buildBoardIndex(board), buildSchematicIndex(sources), null));
    await client.link(sources, null);
    const both = [{ documentId: 'd1', design }, { documentId: 'd2', design: twin }];
    expect(await client.link(both, null)).toEqual(linkBoardSchematic(buildBoardIndex(board), buildSchematicIndex(both), null));
    const sent = requests.filter(r => r.type === 'link').map(r => r.schematics!.map(s => s.design !== undefined));
    expect(sent).toEqual([[true], [false], [false, true]]);
  });

  it('resends every design when the worker no longer holds one (UNKNOWN_SCHEMATIC)', async () => {
    const { client, posted } = manualClient();
    const design = dividerDesign();
    const sources = [{ documentId: 'd1', design }];
    const first = client.link(sources, null);
    client.receive({ type: 'link', id: 1, result: { version: 1 } });
    await first;
    const second = client.link(sources, null);
    expect((posted[1].schematics as Array<{ design?: unknown }>)[0].design).toBeUndefined();
    client.receive({ type: 'error', id: 2, code: 'UNKNOWN_SCHEMATIC', message: 'Schematic 1 was never sent.' });
    await flushMicrotasks();
    expect(posted[2]).toMatchObject({ type: 'link', id: 3 });
    expect((posted[2].schematics as Array<{ design?: unknown }>)[0].design).toBe(design);
    client.receive({ type: 'link', id: 3, result: { version: 1 } });
    expect(await second).toEqual({ version: 1 });
  });

  it('a late answer of a request superseded while the worker was busy never reaches the newer caller', async () => {
    const { client, holdResponses } = connected();
    let release!: () => void;
    holdResponses(new Promise<void>(resolve => { release = resolve; }));
    const first = client.search('R1');
    await flushMicrotasks(); // the worker ran the first search; its answer is held in transit
    const second = client.search('U1');
    release();
    expect(isAbort(await rejection(first))).toBe(true);
    const groups = await second;
    expect(groups.query).toBe('U1');
    expect(groups.groups[0].rows.map(row => (row as { ref: string }).ref)).toEqual(['U1']);
  });
});
