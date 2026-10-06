import { describe, expect, it, vi } from 'vitest';
import type { ViewerCamera } from '../components/viewer-contracts';
import { SheetBuilder, buildSchematic } from '../lib/schematic/testing';
import type { Board } from '../lib/types';
import { createHarness, designOf, dividerBoard, dividerDesign, makeBoard, openNative, registerBoard, seedWorkspace, twinNetDesign } from './testing';
import type { Harness, SeedDocument } from './testing';

const SCH: SeedDocument = { id: 'doc-sch', path: '/boards/docs/top.kicad_sch', kind: 'schematic', key: 41 };
const PDF: SeedDocument = { id: 'doc-pdf', path: '/boards/docs/service.pdf', kind: 'pdf', key: 42 };

async function withSchematic(board: Board, design = twinNetDesign(), extra: SeedDocument[] = []): Promise<Harness> {
  const h = createHarness();
  seedWorkspace(h, 1, '/boards/a.cad', [SCH, ...extra]);
  h.schematicWorkers.designs['top.kicad_sch'] = design;
  await openNative(h, 'a.cad', 1, board);
  expect(h.state().documents[0].designState).toBe('ready');
  return h;
}
const netIdOf = (h: Harness, name: string) => h.state().documents[0].design!.connectivity.nets.filter(net => net.name === name).map(net => net.id);

/** R1/R2 on a board net "OUT" and a global "VCC"; "ONLY_BOARD" has no schematic counterpart. */
const twinBoard = () => makeBoard('a.cad', [
  { ref: 'R1', id: 'r1', pins: [['1', 'VCC'], ['2', 'OUT']] },
  { ref: 'R2', id: 'r2', pins: [['1', 'VCC'], ['2', 'OUT']] },
  { ref: 'U9', id: 'u9', pins: [['1', 'ONLY_BOARD'], ['2', 'OUT']] },
]);

describe('net-only selection: board net → schematic nets', () => {
  it('a net carried by two schematic placements is an explicit choice: nothing is selected until chosen', async () => {
    const h = await withSchematic(twinBoard());
    expect(netIdOf(h, 'OUT')).toHaveLength(2);
    h.controller.actions.selectNet('OUT');
    expect(h.state().selection).toEqual({ componentId: null, pinId: null, net: 'OUT' });
    const probe = h.state().probe;
    expect(probe.schematicNetMapping).toMatchObject({ status: 'ambiguous', total: 2, reasons: ['several-schematic-nets'] });
    expect(probe.schematicNetMapping!.candidates.map(c => [c.name, c.scope, c.scopePath, c.documentId])).toEqual([['OUT', 'local', '/amp1', 'doc-sch'], ['OUT', 'local', '/amp2', 'doc-sch']]);
    expect(probe.schematic).toMatchObject({ documentId: 'doc-sch', selection: {} });
    expect(probe.schematicMapping).toBeNull();
    expect(probe.nonce).toBe(1);

    h.controller.actions.chooseSchematicNet(9);
    expect(h.state().probe).toBe(probe);
    h.controller.actions.chooseSchematicNet(-1);
    expect(h.state().probe).toBe(probe);

    const chosen = probe.schematicNetMapping!.candidates[1];
    h.controller.actions.chooseSchematicNet(1);
    const after = h.state().probe;
    expect(after.schematic).toEqual({ documentId: 'doc-sch', instancePath: '/amp2', selection: { netId: chosen.netId } });
    expect(after.schematicNetMapping).toBeNull();
    expect(after.nonce).toBe(2);
    expect(after.origin).toBe('board');
    expect(h.state().selection).toEqual({ componentId: null, pinId: null, net: 'OUT' });
    h.controller.actions.chooseSchematicNet(1);
    expect(h.state().probe).toBe(after);
  });

  it('a unique schematic net (here a global one) is followed as before and is reported as unique', async () => {
    const h = await withSchematic(twinBoard());
    expect(netIdOf(h, 'VCC')).toHaveLength(1);
    h.controller.actions.selectNet('VCC');
    const probe = h.state().probe;
    expect(probe.schematicNetMapping).toMatchObject({ status: 'unique', total: 1, reasons: [] });
    expect(probe.schematic?.selection).toEqual({ netId: netIdOf(h, 'VCC')[0] });
    expect(probe.nonce).toBe(1);
  });

  it('a net without schematic counterpart keeps its mapping with the reason and links nothing', async () => {
    const h = await withSchematic(twinBoard());
    h.controller.actions.selectNet('ONLY_BOARD');
    expect(h.state().selection.net).toBe('ONLY_BOARD');
    expect(h.state().probe.schematicNetMapping).toMatchObject({ status: 'missing', total: 0, reasons: ['no-schematic-net'], candidates: [] });
    expect(h.state().probe.schematic?.selection).toEqual({});
    h.controller.actions.chooseSchematicNet(0);
    expect(h.state().probe.nonce).toBe(1);
  });

  it('mappings are cleared by every selection change, a cleared selection and a board switch', async () => {
    const h = await withSchematic(twinBoard());
    const { selectNet, selectComponent, clearSelection } = h.controller.actions;
    selectNet('OUT');
    expect(h.state().probe.schematicNetMapping?.status).toBe('ambiguous');
    selectComponent('r1');
    expect(h.state().probe.schematicNetMapping).toBeNull();
    expect(h.state().probe.schematicMapping?.status).toBe('unique');
    selectNet('OUT');
    expect(h.state().probe.schematicNetMapping?.status).toBe('ambiguous');
    selectNet(null);
    expect(h.state().probe.schematicNetMapping).toBeNull();
    selectNet('OUT');
    clearSelection();
    expect(h.state().probe).toMatchObject({ schematicNetMapping: null, boardNetMapping: null });
    selectNet('OUT');
    registerBoard(h, 'b.cad', 2, dividerBoard('b.cad'));
    await h.controller.actions.openRecent('/boards/b.cad');
    await h.controller.idle();
    expect(h.state().probe).toMatchObject({ schematicNetMapping: null, boardNetMapping: null, nonce: 0 });
    selectNet('OUT');
    h.controller.actions.closeBoard();
    expect(h.state().probe).toMatchObject({ schematicNetMapping: null, boardNetMapping: null });
  });

  it('removing the schematic drops a pending candidate list; a user alias can make a missing net unique', async () => {
    const h = await withSchematic(twinBoard(), twinNetDesign());
    h.controller.actions.selectNet('OUT');
    expect(h.state().probe.schematicNetMapping?.status).toBe('ambiguous');
    h.controller.actions.removeDocument('doc-sch');
    expect(h.state().probe.schematicNetMapping).toBeNull();
    expect(h.state().probe.schematic).toBeNull();
  });

  it('a user net alias turns a missing board net into a unique schematic target (explicit, never guessed)', async () => {
    const board = makeBoard('a.cad', [{ ref: 'R1', id: 'r1', pins: [['1', 'VCC'], ['2', 'VOUT']] }]);
    const h = await withSchematic(board, dividerDesign());
    h.controller.actions.selectNet('VOUT');
    expect(h.state().probe.schematicNetMapping).toMatchObject({ status: 'missing' });
    h.controller.actions.setAlias('nets', 'OUT', 'VOUT');
    expect(h.state().probe.schematicNetMapping).toMatchObject({ status: 'unique', candidates: [{ name: 'OUT', via: 'alias' }] });
    expect(h.state().probe.schematic?.selection.netId).toBe(netIdOf(h, 'OUT')[0]);
  });
});

/** One schematic net carrying two names (SIGA, SIGB), a plain GND and a net that is not on the board. */
function aliasedDesign() {
  const sheet = new SheetBuilder('root', 'alias')
    .part('R1', [{ n: '1', x: 0, y: 0 }, { n: '2', x: 0, y: 10 }])
    .part('R2', [{ n: '1', x: 20, y: 0 }, { n: '2', x: 20, y: 10 }])
    .wire(0, 0, 20, 0).local('SIGA', 5, 0).local('SIGB', 15, 0)
    .wire(0, 10, 20, 10).local('GND', 10, 10)
    .part('R3', [{ n: '1', x: 40, y: 0 }, { n: '2', x: 40, y: 10 }])
    .wire(40, 0, 50, 0).local('ONLY_SCH', 45, 0);
  return designOf(buildSchematic([sheet]));
}
const aliasedBoard = () => makeBoard('a.cad', [
  { ref: 'R1', id: 'r1', pins: [['1', 'SIGA'], ['2', 'GND']] },
  { ref: 'R2', id: 'r2', pins: [['1', 'SIGB'], ['2', 'GND']] },
]);

describe('net-only selection: schematic net → board nets', () => {
  it('a schematic net that matches several board nets is an explicit choice: nothing is selected until chosen', async () => {
    const h = await withSchematic(aliasedBoard(), aliasedDesign());
    const nets = h.state().documents[0].design!.connectivity.nets;
    const sig = nets.find(net => net.aliases.includes('SIGB'))!;
    h.controller.actions.selectSchematicNet('doc-sch', sig.id);
    expect(h.state().selection).toEqual({ componentId: null, pinId: null, net: null });
    const probe = h.state().probe;
    expect(probe.boardNetMapping).toMatchObject({ status: 'ambiguous', total: 2, reasons: ['several-board-nets'] });
    expect(probe.boardNetMapping!.candidates.map(c => c.name)).toEqual(['SIGA', 'SIGB']);
    expect(probe).toMatchObject({ origin: 'schematic', nonce: 1, schematicNetMapping: null, boardMapping: null, documentRef: null });
    expect(probe.schematic?.selection).toEqual({ netId: sig.id });
    // The old informational toast is replaced by the explicit candidate list.
    expect(h.state().notices.some(notice => 'text' in notice.message && notice.message.text.includes('Several nets'))).toBe(false);

    h.controller.actions.chooseBoardNet(5);
    expect(h.state().probe).toBe(probe);
    h.controller.actions.chooseBoardNet(1);
    expect(h.state().selection).toEqual({ componentId: null, pinId: null, net: 'SIGB' });
    const after = h.state().probe;
    expect(after).toMatchObject({ origin: 'schematic', boardNetMapping: null, documentRef: 'SIGB', nonce: 2 });
    // The schematic keeps showing the net the user clicked (the choice does not bounce back).
    expect(after.schematic?.selection).toEqual({ netId: sig.id });
    h.controller.actions.chooseBoardNet(0);
    expect(h.state().selection.net).toBe('SIGB');
  });

  it('a unique match selects the board net; a net absent on the board explains why and selects nothing', async () => {
    const h = await withSchematic(aliasedBoard(), aliasedDesign());
    const nets = h.state().documents[0].design!.connectivity.nets;
    const gnd = nets.find(net => net.name === 'GND')!, only = nets.find(net => net.name === 'ONLY_SCH')!;
    h.controller.actions.selectSchematicNet('doc-sch', gnd.id);
    expect(h.state().selection).toEqual({ componentId: null, pinId: null, net: 'GND' });
    expect(h.state().probe.boardNetMapping).toMatchObject({ status: 'unique', candidates: [{ name: 'GND', via: 'exact' }] });
    h.controller.actions.selectSchematicNet('doc-sch', only.id);
    expect(h.state().selection).toEqual({ componentId: null, pinId: null, net: null });
    expect(h.state().probe.boardNetMapping).toMatchObject({ status: 'missing', reasons: ['no-board-net'], candidates: [] });
    h.controller.actions.chooseBoardNet(0);
    expect(h.state().selection.net).toBeNull();
  });

  it('pending board candidates are dropped by a new selection, a deselected net and a board switch', async () => {
    const h = await withSchematic(aliasedBoard(), aliasedDesign());
    const sig = h.state().documents[0].design!.connectivity.nets.find(net => net.aliases.includes('SIGB'))!;
    const { selectSchematicNet, selectComponent, selectSchematicSymbol } = h.controller.actions;
    selectSchematicNet('doc-sch', sig.id);
    expect(h.state().probe.boardNetMapping?.status).toBe('ambiguous');
    selectSchematicNet('doc-sch', null);
    expect(h.state().probe.boardNetMapping).toBeNull();
    selectSchematicNet('doc-sch', sig.id);
    selectComponent('r1');
    expect(h.state().probe.boardNetMapping).toBeNull();
    selectSchematicNet('doc-sch', sig.id);
    selectSchematicSymbol({ documentId: 'doc-sch', instancePath: '', symbolId: 'R2', ref: 'R2' });
    expect(h.state().probe.boardNetMapping).toBeNull();
    expect(h.state().probe.boardMapping?.status).toBe('unique');
    selectSchematicNet('doc-sch', sig.id);
    registerBoard(h, 'b.cad', 2, dividerBoard('b.cad'));
    await h.controller.actions.openRecent('/boards/b.cad');
    await h.controller.idle();
    expect(h.state().probe.boardNetMapping).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Board camera
// ---------------------------------------------------------------------------------------------------------------

const boardCamera = { zoom: 12.5, x: 3.25, y: -4, rotation: 90, side: 'bottom' } as ViewerCamera;

describe('board camera persistence (core)', () => {
  it('round-trips through save → close → reopen of the same board and is not applied to another board', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    expect(h.controller.actions.cameraOf('board')).toEqual({});
    h.controller.actions.setCamera('board', boardCamera);
    expect(h.controller.actions.cameraOf('board')).toEqual(boardCamera);
    expect(h.controller.actions.cameraOf('board')).toBe(h.controller.actions.cameraOf('board'));
    await h.controller.flush();
    expect(h.desktop.workspaces.get(h.state().boardKey!)?.cameras.board).toEqual(boardCamera);

    h.controller.actions.closeBoard();
    expect(h.controller.actions.cameraOf('board')).toEqual({});
    await openNative(h, 'b.cad', 2);
    expect(h.controller.actions.cameraOf('board')).toEqual({});
    h.controller.actions.setCamera('board', { zoom: 2, x: 1, y: 1, rotation: 0, side: 'top' } as ViewerCamera);
    await openNative(h, 'a.cad', 1);
    expect(h.controller.actions.cameraOf('board')).toEqual(boardCamera);
    await openNative(h, 'b.cad', 2);
    expect(h.controller.actions.cameraOf('board')).toEqual({ zoom: 2, x: 1, y: 1, rotation: 0, side: 'top' });
  });

  it('a camera replaces the previous one as a whole; document cameras never take a board side', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF]);
    await openNative(h, 'a.cad', 1);
    const { setCamera, cameraOf } = h.controller.actions;
    setCamera('board', boardCamera);
    setCamera('board', { zoom: 3, x: 0, y: 0 });
    expect(cameraOf('board')).toEqual({ zoom: 3, x: 0, y: 0 });
    setCamera('doc-pdf', { page: 2, zoom: 1.5, side: 'bottom' } as ViewerCamera);
    expect(cameraOf('doc-pdf')).toEqual({ page: 2, zoom: 1.5 });
    setCamera('ghost', { zoom: 2 });
    expect(cameraOf('ghost')).toEqual({});
  });

  it('invalid numbers are rejected silently: the stored camera, the state and the saver stay as they were', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    const { setCamera, cameraOf } = h.controller.actions;
    setCamera('board', boardCamera);
    await h.controller.flush();
    const before = h.state();
    const listener = vi.fn();
    h.controller.subscribe(listener);
    for (const bad of [
      { zoom: Number.NaN }, { zoom: 0 }, { zoom: -2 }, { zoom: Number.POSITIVE_INFINITY }, { zoom: 1, x: Number.NaN }, { zoom: 1, y: Number.NEGATIVE_INFINITY },
      { zoom: 1, rotation: Number.NaN }, { zoom: 1, side: 'left' }, { zoom: '2' }, { zoom: 1, x: '3' },
    ]) setCamera('board', bad as unknown as ViewerCamera);
    expect(listener).not.toHaveBeenCalled();
    expect(h.state()).toBe(before);
    expect(cameraOf('board')).toEqual(boardCamera);
    expect(h.state().notices).toEqual(before.notices);
    // The saver is untouched and keeps persisting valid cameras.
    setCamera('board', { ...boardCamera, zoom: 20 } as ViewerCamera);
    await h.controller.flush();
    expect(h.state().save).toEqual({ dirty: false, saving: false, failure: null });
    expect(h.desktop.workspaces.get(h.state().boardKey!)?.cameras.board?.zoom).toBe(20);
  });

  it('a camera update leaves documents, selection, probe, notes, link, overlays and search referentially untouched', async () => {
    const h = await withSchematic(twinBoard(), twinNetDesign(), [PDF]);
    h.controller.actions.selectNet('OUT');
    h.controller.actions.setSearchQuery('R1');
    await h.controller.actions.upsertNote({ componentId: 'r1' }, { text: 'checked' });
    await h.controller.idle();
    const before = h.state();
    const listener = vi.fn();
    h.controller.subscribe(listener);
    h.controller.actions.setCamera('board', boardCamera);
    const after = h.state();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(after.manifest?.cameras.board).toEqual(boardCamera);
    for (const key of ['board', 'documents', 'selection', 'probe', 'notes', 'link', 'pdfLinks', 'overlays', 'search', 'import', 'save', 'split', 'activeTab'] as const) expect(after[key], key).toBe(before[key]);
    // The same camera again is not a change.
    h.controller.actions.setCamera('board', { ...boardCamera });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.state()).toBe(after);
  });

  it('browser fallback keeps the board camera in memory for the open board only', async () => {
    const h = createHarness({ browser: true });
    h.boardWorkers.replies['a.cad'] = dividerBoard('a.cad');
    h.boardWorkers.replies['b.cad'] = dividerBoard('b.cad');
    await h.controller.actions.openDropped([new File([new TextEncoder().encode('GENCAD a')], 'a.cad')]);
    await h.controller.idle();
    h.controller.actions.setCamera('board', boardCamera);
    expect(h.controller.actions.cameraOf('board')).toEqual(boardCamera);
    expect(h.state().manifest).toBeNull();
    await h.controller.actions.openDropped([new File([new TextEncoder().encode('GENCAD b')], 'b.cad')]);
    await h.controller.idle();
    expect(h.controller.actions.cameraOf('board')).toEqual({});
  });
});
