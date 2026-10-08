import { describe, expect, it } from 'vitest';
import { dividerBoard, dividerDesign, makeBoard, twinDesign } from '../app/testing';
import { buildBoardIndex } from './board-index';
import { buildSchematicIndex, linkBoardSchematic, searchBoardGroups } from './crossprobe';
import { createModelHost } from './model-host';
import { isModelRequest, isModelResponse, MODEL_PROTOCOL } from './model-protocol';
import type { ModelResponse } from './model-protocol';

/** A host whose queue runs only when the test says so (`run()`), with every response collected. */
function manualHost(board = dividerBoard()) {
  const responses: ModelResponse[] = [];
  const tasks: Array<() => void> = [];
  let clock = 0;
  const host = createModelHost(board, response => responses.push(structuredClone(response)), { schedule: task => { tasks.push(task); }, now: () => (clock += 5) });
  const run = () => { while (tasks.length) tasks.shift()!(); };
  return { host, responses, run, tasks };
}

describe('model protocol shapes', () => {
  it('accepts exactly the request shapes of the protocol', () => {
    expect(MODEL_PROTOCOL).toBe(1);
    expect(isModelRequest({ type: 'search', id: 1, query: 'R1' })).toBe(true);
    expect(isModelRequest({ type: 'search', id: 1, query: 'R1', limits: { boardComponents: 5 } })).toBe(true);
    expect(isModelRequest({ type: 'index', id: 2 })).toBe(true);
    expect(isModelRequest({ type: 'cancel', id: 3 })).toBe(true);
    expect(isModelRequest({ type: 'link', id: 4, schematics: [{ documentId: 'd', token: 1, design: {} }] })).toBe(true);
    for (const bad of [null, 1, 'search', {}, { type: 'search', query: 'x' }, { type: 'search', id: 0, query: 'x' }, { type: 'search', id: 1.5, query: 'x' }, { type: 'search', id: -1, query: 'x' },
      { type: 'search', id: 1 }, { type: 'search', id: 1, query: 7 }, { type: 'search', id: 1, query: 'x', limits: 3 }, { type: 'link', id: 1 }, { type: 'link', id: 1, schematics: [{ documentId: 'd' }] },
      { type: 'link', id: 1, schematics: [{ documentId: 'd', token: 0 }] }, { type: 'link', id: 1, schematics: [{ documentId: 'd', token: 1, design: 'x' }] }, { type: 'drop', id: 1 }]) {
      expect(isModelRequest(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts exactly the response shapes of the protocol', () => {
    expect(isModelResponse({ type: 'search', id: 1, result: { query: '', groups: [] } })).toBe(true);
    expect(isModelResponse({ type: 'cancelled', id: 1 })).toBe(true);
    expect(isModelResponse({ type: 'error', id: 1, code: 'FAILED', message: 'x' })).toBe(true);
    for (const bad of [null, { type: 'search', id: 1 }, { type: 'search', id: 1, result: 3 }, { type: 'error', id: 1 }, { type: 'progress', id: 1 }, { board: {} }, { type: 'cancelled' }]) {
      expect(isModelResponse(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('model host (worker side)', () => {
  it('answers a search with exactly what the shared index answers on the UI thread', () => {
    const board = makeBoard('b.cad', [{ ref: 'R1', pins: [['1', 'VCC']] }, { ref: 'R10', pins: [['1', 'GND']] }, { ref: 'C1', pins: [['1', 'VCC']] }]);
    const { host, responses, run } = manualHost(board);
    host.receive({ type: 'search', id: 1, query: 'r1' });
    host.receive({ type: 'search', id: 2, query: 'vcc', limits: { boardComponents: 1 } });
    expect(responses).toEqual([]); // never inside the message event
    run();
    const index = buildBoardIndex(board);
    expect(responses).toEqual([
      { type: 'cancelled', id: 1 }, // superseded by the newer search waiting behind it
      { type: 'search', id: 2, result: searchBoardGroups('vcc', index, { boardComponents: 1 }) },
    ]);
    host.receive({ type: 'search', id: 3, query: 'r1' });
    run();
    expect(responses[2]).toEqual({ type: 'search', id: 3, result: searchBoardGroups('r1', index) });
    expect((responses[2] as { result: { groups: Array<{ rows: Array<{ ref: string }> }> } }).result.groups[0].rows.map(row => row.ref)).toEqual(['R1', 'R10']);
  });

  it('reports the index size and its build time once', () => {
    const { host, responses, run } = manualHost();
    host.receive({ type: 'index', id: 1 });
    host.receive({ type: 'index', id: 2 }); // index requests are never superseded
    run();
    expect(responses.map(r => r.type)).toEqual(['index', 'index']);
    const first = responses[0] as Extract<ModelResponse, { type: 'index' }>;
    expect(first.result.stats).toMatchObject({ components: 3, pins: 6, nets: 3 });
    expect(first.result.buildMs).toBe(5);
    expect((responses[1] as typeof first).result.buildMs).toBe(5); // the same build, not a second one
  });

  it('warm() builds the index in a scheduled task, so the first query does not pay for it', () => {
    const { host, responses, run, tasks } = manualHost();
    host.warm();
    expect(tasks).toHaveLength(1);
    run();
    host.receive({ type: 'index', id: 1 });
    run();
    expect((responses[0] as Extract<ModelResponse, { type: 'index' }>).result.buildMs).toBe(5);
  });

  it('cancels a queued request on `cancel` (answered once, as cancelled) and ignores a cancel for anything else', () => {
    const { host, responses, run } = manualHost();
    host.receive({ type: 'search', id: 1, query: 'R' });
    host.receive({ type: 'cancel', id: 1 });
    host.receive({ type: 'cancel', id: 99 });
    run();
    expect(responses).toEqual([{ type: 'cancelled', id: 1 }]);
  });

  it('answers malformed requests with BAD_REQUEST when they name an id, and ignores the rest', () => {
    const { host, responses, run } = manualHost();
    host.receive({ type: 'search', id: 5 });
    host.receive({ type: 'nope' });
    host.receive(null);
    host.receive('text');
    run();
    expect(responses).toEqual([{ type: 'error', id: 5, code: 'BAD_REQUEST', message: 'Malformed model request.' }]);
  });

  it('computes the link report from designs sent once and named by token afterwards', () => {
    const board = dividerBoard(), design = dividerDesign();
    const { host, responses, run } = manualHost(board);
    host.receive({ type: 'link', id: 1, schematics: [{ documentId: 'd1', token: 1, design: structuredClone(design) }], aliases: null });
    run();
    const expected = linkBoardSchematic(buildBoardIndex(board), buildSchematicIndex([{ documentId: 'd1', design }]), null);
    expect(responses[0]).toEqual({ type: 'link', id: 1, result: expected });
    host.receive({ type: 'link', id: 2, schematics: [{ documentId: 'd1', token: 1 }], aliases: { components: [], nets: [] } });
    run();
    expect(responses[1]).toMatchObject({ type: 'link', id: 2 });
    expect((responses[1] as Extract<ModelResponse, { type: 'link' }>).result.summary).toEqual(expected.summary);
  });

  it('keeps the designs of the last link it ran and asks for any other one (UNKNOWN_SCHEMATIC)', () => {
    const { host, responses, run } = manualHost();
    host.receive({ type: 'link', id: 1, schematics: [{ documentId: 'd1', token: 1, design: dividerDesign() }, { documentId: 'd2', token: 2, design: twinDesign() }] });
    run();
    host.receive({ type: 'link', id: 2, schematics: [{ documentId: 'd2', token: 2 }] });
    run();
    host.receive({ type: 'link', id: 3, schematics: [{ documentId: 'd1', token: 1 }] }); // dropped by link 2
    host.receive({ type: 'search', id: 4, query: 'R1' });
    run();
    expect(responses.map(r => r.type)).toEqual(['link', 'link', 'error', 'search']);
    expect(responses[2]).toMatchObject({ id: 3, code: 'UNKNOWN_SCHEMATIC' });
  });

  it('keeps a design that arrived with a superseded link request', () => {
    const { host, responses, run } = manualHost();
    host.receive({ type: 'link', id: 1, schematics: [{ documentId: 'd1', token: 1, design: dividerDesign() }] });
    host.receive({ type: 'link', id: 2, schematics: [{ documentId: 'd1', token: 1 }] });
    run();
    expect(responses.map(r => r.type)).toEqual(['cancelled', 'link']);
  });

  it('answers a request that throws with FAILED and keeps serving', () => {
    const { host, responses, run } = manualHost();
    host.receive({ type: 'link', id: 1, schematics: [{ documentId: 'd1', token: 1, design: { schematic: null, connectivity: null } }] });
    host.receive({ type: 'index', id: 2 });
    run();
    expect(responses[0]).toMatchObject({ type: 'error', id: 1, code: 'FAILED' });
    expect(responses[1]).toMatchObject({ type: 'index', id: 2 });
  });
});
