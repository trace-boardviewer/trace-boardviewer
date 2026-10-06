import { describe, expect, it, vi } from 'vitest';
import { pinKey, symbolKey } from '../lib/schematic/model';
import { setCalibration, upsertBookmark } from '../lib/workspace';
import type { DocumentRuntime } from './api';
import {
  createHarness, deferred, designOf, dividerBoard, dividerDesign, documentPayload, enc, hexKey, hit, kicadText, makeBoard, openNative, registerBoard, seedWorkspace, T0, twinDesign,
} from './testing';
import type { Harness, SeedDocument } from './testing';

const doc = (h: Harness, id: string): DocumentRuntime => h.state().documents.find(d => d.record.id === id)!;
const SCH_PATH = '/boards/docs/divider.kicad_sch';
const SCH: SeedDocument = { id: 'doc-sch', path: SCH_PATH, kind: 'schematic', key: 41 };
const PDF: SeedDocument = { id: 'doc-pdf', path: '/boards/docs/service.pdf', kind: 'pdf', key: 42 };

/** A native board whose workspace already holds a schematic (the fake worker returns `design` for it). */
async function withSchematic(design = dividerDesign(), board = dividerBoard('a.cad'), extra: SeedDocument[] = []): Promise<Harness> {
  const h = createHarness();
  seedWorkspace(h, 1, '/boards/a.cad', [SCH, ...extra]);
  h.schematicWorkers.designs['divider.kicad_sch'] = design;
  await openNative(h, 'a.cad', 1, board);
  expect(doc(h, 'doc-sch').designState).toBe('ready');
  return h;
}
const pinOf = (h: Harness, componentId: string, number: string) => h.state().board!.pins.find(pin => pin.componentId === componentId && pin.number === number)!;

describe('document restore (locate statuses)', () => {
  it('maps ok / moved / changed / missing / unreadable to runtimes with an explanation and the right resources', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [
      { id: 'd-ok', path: '/boards/docs/ok.pdf', kind: 'pdf', key: 11 },
      { id: 'd-moved', path: '/old/moved.png', kind: 'image', key: 12, present: false },
      { id: 'd-changed', path: '/boards/docs/changed.pdf', kind: 'pdf', key: 13 },
      { id: 'd-missing', path: '/boards/docs/missing.pdf', kind: 'pdf', key: 14, present: false },
      { id: 'd-bad', path: '/boards/docs/bad.png', kind: 'image', key: 15 },
    ]);
    h.desktop.docs.set('/boards/docs/moved.png', documentPayload('/boards/docs/moved.png', 'image', 12));
    h.desktop.locate['d-moved'] = { status: 'moved', path: '/boards/docs/moved.png', key: hexKey(12), size: 112 };
    h.desktop.docs.set('/boards/docs/changed.pdf', documentPayload('/boards/docs/changed.pdf', 'pdf', 99));
    h.desktop.locate['d-bad'] = { status: 'unreadable', message: 'Access denied.' };
    await openNative(h, 'a.cad', 1);
    const [ok, moved, changed, missing, bad] = ['d-ok', 'd-moved', 'd-changed', 'd-missing', 'd-bad'].map(id => doc(h, id));
    expect(ok.status).toBe('ready');
    expect(ok.pdf?.id).toBe('d-ok');
    expect(ok.bytes).toBeUndefined();
    expect(moved.status).toBe('ready');
    expect(moved.bytes).toBeInstanceOf(Uint8Array);
    expect(moved.record).toMatchObject({ path: '/boards/docs/moved.png', relativePath: 'docs/moved.png' });
    expect(moved.record.missing).toBeUndefined();
    expect(changed.status).toBe('changed');
    expect(changed.message).toMatch(/different content/);
    expect(changed.pdf).toBeUndefined();
    expect(changed.record.key).toBe(hexKey(13));
    expect(missing).toMatchObject({ status: 'missing' });
    expect(missing.message).toMatch(/Relink/);
    expect(bad).toMatchObject({ status: 'unreadable' });
    expect(bad.message).toContain('Access denied.');
    expect(h.pdf.sessions.map(s => s.id)).toEqual(['d-ok']);
    expect(h.state().manifest?.documents.find(d => d.id === 'd-missing')?.missing).toBe(true);
    // The hint is persisted (a save follows the locate step).
    await h.controller.flush();
    expect(h.desktop.workspaces.get(hexKey(1))?.documents.find(d => d.id === 'd-missing')?.missing).toBe(true);
  });

  it('records the page count of a PDF once its session knows it', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF]);
    await openNative(h, 'a.cad', 1);
    expect(doc(h, 'doc-pdf').record.pageCount).toBe(3);
    h.pdf.sessions[0].update({ pageCount: 7 });
    expect(doc(h, 'doc-pdf').record.pageCount).toBe(3);
  });

  it('reads at most two documents at a time', async () => {
    const h = createHarness();
    const docs: SeedDocument[] = [1, 2, 3, 4, 5].map(n => ({ id: `d${n}`, path: `/boards/docs/p${n}.pdf`, kind: 'pdf', key: 50 + n }));
    seedWorkspace(h, 1, '/boards/a.cad', docs);
    const gates = new Map(docs.map(d => [d.path, deferred()]));
    h.desktop.holds.readDocument = path => gates.get(path)?.promise;
    h.boardWorkers.replies['a.cad'] = dividerBoard('a.cad');
    h.desktop.boards.set('/boards/a.cad', { name: 'a.cad', path: '/boards/a.cad', data: enc('a'), key: hexKey(1) });
    await h.controller.actions.openRecent('/boards/a.cad');
    await vi.waitFor(() => expect(h.desktop.activeReads).toBe(2));
    expect(h.desktop.log.filter(l => l.startsWith('readDocument'))).toHaveLength(2);
    for (const gate of gates.values()) { gate.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); }
    await h.controller.idle();
    expect(h.desktop.maxActiveReads).toBe(2);
    expect(h.state().documents.every(d => d.status === 'ready')).toBe(true);
  });

  it('opening another board never attaches an old document, and drops every session of the old one', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF, SCH]);
    h.schematicWorkers.designs['divider.kicad_sch'] = dividerDesign();
    await openNative(h, 'a.cad', 1);
    expect(h.state().documents).toHaveLength(2);
    const [session] = h.pdf.sessions;
    await openNative(h, 'b.cad', 2);
    expect(session.disposed).toBe(true);
    expect(h.schematicWorkers.terminated).toBe(1);
    expect(h.state().documents).toEqual([]);
    expect(h.state().link).toBeNull();
    expect(h.state().pdfLinks).toEqual({});
    expect(h.state().manifest?.documents).toEqual([]);
    expect(h.desktop.log.filter(l => l.startsWith('loadWorkspace'))).toEqual([`loadWorkspace:${hexKey(1)}`, `loadWorkspace:${hexKey(2)}`]);
  });

  it('a document read that returns after the board switched is ignored', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF]);
    const gate = deferred();
    h.desktop.holds.readDocument = () => gate.promise;
    h.boardWorkers.replies['a.cad'] = dividerBoard('a.cad');
    h.desktop.boards.set('/boards/a.cad', { name: 'a.cad', path: '/boards/a.cad', data: enc('a'), key: hexKey(1) });
    await h.controller.actions.openRecent('/boards/a.cad');
    await vi.waitFor(() => expect(h.desktop.activeReads).toBe(1));
    // idle() would wait for the held read: await the switch through its outcome.
    registerBoard(h, 'b.cad', 2);
    await h.controller.actions.openRecent('/boards/b.cad');
    await vi.waitFor(() => expect(h.state().manifest?.board.key).toBe(hexKey(2)));
    gate.resolve();
    await h.controller.idle();
    expect(h.pdf.sessions).toHaveLength(0);
    expect(h.state().documents).toEqual([]);
  });
});

describe('attaching, relinking and editing documents', () => {
  const pdfPayload = (path: string, key = 21) => documentPayload(path, 'pdf', key);

  it('attaches picked documents; the same bytes attach once; PDF bytes belong to the session', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    const image = documentPayload('/boards/docs/photo.png', 'image', 22);
    h.desktop.picks.push([pdfPayload('/boards/docs/a.pdf'), pdfPayload('/boards/copy/a-copy.pdf'), image]);
    await h.controller.actions.attachDocuments(['pdf', 'image']);
    expect(h.desktop.pickOptions).toEqual([{ kinds: ['pdf', 'image'], multiple: true }]);
    expect(h.state().documents.map(d => [d.record.id, d.record.kind, d.status])).toEqual([['id-1', 'pdf', 'ready'], ['id-2', 'image', 'ready']]);
    expect(h.state().documents[0].bytes).toBeUndefined();
    expect(h.pdf.sessions).toHaveLength(1);
    expect(h.pdf.sessions[0].options.data).toEqual(enc('bytes of a.pdf'));
    expect(h.state().documents[1].bytes).toEqual(enc('bytes of photo.png'));
    expect(h.messages().slice(-2)).toEqual(['Attached 2 documents.', '1 of the files is already attached to this workspace.'.replace('1 of the files is', '"a-copy.pdf" is')]);
    // Again: nothing is added, no second session.
    h.desktop.picks.push([pdfPayload('/boards/docs/a.pdf')]);
    await h.controller.actions.attachDocuments();
    expect(h.state().documents).toHaveLength(2);
    expect(h.pdf.sessions).toHaveLength(1);
    expect(h.state().notices.at(-1)?.message).toEqual({ text: '"a.pdf" is already attached to this workspace.' });
    // Saved with the workspace.
    await h.controller.flush();
    expect(h.desktop.workspaces.get(hexKey(1))?.documents.map(d => d.name)).toEqual(['a.pdf', 'photo.png']);
  });

  it('cancelling the dialog attaches nothing; attaching needs an open board', async () => {
    const h = createHarness();
    await h.controller.actions.attachDocuments();
    expect(h.state().notices.at(-1)?.message).toEqual({ text: 'Open a board before attaching documents.' });
    await openNative(h, 'a.cad', 1);
    await h.controller.actions.attachDocuments();
    expect(h.state().documents).toEqual([]);
  });

  it('attaches dropped files through their native path (no path: an error notice)', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    h.desktop.docs.set('/drop/x.pdf', pdfPayload('/drop/x.pdf', 31));
    const dropped = Object.assign(new File([enc('x')], 'x.pdf'), { path: '/drop/x.pdf' });
    await h.controller.actions.attachFiles([dropped, new File([enc('y')], 'y.pdf')]);
    expect(h.state().documents.map(d => d.record.name)).toEqual(['x.pdf']);
    expect(h.state().notices.some(n => 'text' in n.message && n.message.text.includes('no file path'))).toBe(true);
  });

  it('browser fallback: sniffs by bytes, ignores unknown files, keeps companions, attaches duplicates once', async () => {
    const h = createHarness({ browser: true });
    h.boardWorkers.replies['a.cad'] = dividerBoard('a.cad');
    h.pickQueue.push([new File([enc('GENCAD')], 'a.cad')]);
    await h.controller.actions.openBoard();
    await h.controller.idle();
    h.schematicWorkers.designs['top.kicad_sch'] = dividerDesign();
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const files = [new File([enc('%PDF-1.7 x')], 'manual.bin'), new File([pngBytes], 'photo.dat'), new File([enc(kicadText())], 'top.kicad_sch'), new File([enc('EESchema-LIBRARY Version 2.4')], 'sym.lib'), new File([enc('plain text')], 'notes.txt')];
    await h.controller.actions.attachFiles(files);
    await h.controller.idle();
    expect(h.state().documents.map(d => [d.record.name, d.record.kind])).toEqual([['manual.bin', 'pdf'], ['photo.dat', 'image'], ['top.kicad_sch', 'schematic']]);
    expect(h.state().manifest).toBeNull();
    expect(Object.keys(h.schematicWorkers.posted[0].companions ?? {})).toEqual(['sym.lib']);
    await h.controller.actions.attachFiles([new File([enc('%PDF-1.7 x')], 'again.pdf')]);
    expect(h.state().documents).toHaveLength(3);
    await h.controller.actions.attachFiles([new File([enc('plain text')], 'notes.txt')]);
    expect(h.state().notices.at(-1)?.message).toEqual({ text: 'None of the selected files is a PDF, image or schematic that TRACE can open.' });
  });

  it('relink: a file with the same SHA-256 is accepted, a different one changes nothing', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [{ ...PDF, present: false }]);
    await openNative(h, 'a.cad', 1);
    expect(doc(h, 'doc-pdf').status).toBe('missing');
    const manifest = h.state().manifest;
    h.desktop.picks.push([pdfPayload('/elsewhere/other.pdf', 77)]);
    await h.controller.actions.relinkDocument('doc-pdf');
    expect(h.desktop.pickOptions.at(-1)).toEqual({ kinds: ['pdf'], multiple: false });
    expect(h.state().manifest).toBe(manifest);
    expect(doc(h, 'doc-pdf').status).toBe('missing');
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(h.state().notices.at(-1))).toMatch(/SHA-256 mismatch/);
    h.desktop.picks.push([documentPayload('/elsewhere/service-copy.pdf', 'pdf', 42)]);
    await h.controller.actions.relinkDocument('doc-pdf');
    expect(doc(h, 'doc-pdf').status).toBe('ready');
    expect(doc(h, 'doc-pdf').record).toMatchObject({ path: '/elsewhere/service-copy.pdf', key: hexKey(42), name: 'service-copy.pdf' });
    expect(doc(h, 'doc-pdf').record.missing).toBeUndefined();
    expect(h.pdf.sessions).toHaveLength(1);
    h.desktop.picks.push([]);
    await h.controller.actions.relinkDocument('doc-pdf');
    expect(doc(h, 'doc-pdf').status).toBe('ready');
  });

  it('accepting a changed file keeps bookmarks and drops the calibration; it needs an explicit action', async () => {
    const h = createHarness();
    let manifest = seedWorkspace(h, 1, '/boards/a.cad', [{ id: 'd-img', path: '/boards/docs/photo.png', kind: 'image', key: 61 }]);
    manifest = setCalibration(upsertBookmark(manifest, 'd-img', { id: 'bm', page: 1, label: 'Corner' }), 'd-img', { pixelsPerMm: 12, confirmed: true });
    h.desktop.workspaces.set(hexKey(1), manifest);
    h.desktop.docs.set('/boards/docs/photo.png', documentPayload('/boards/docs/photo.png', 'image', 62));
    await openNative(h, 'a.cad', 1);
    expect(doc(h, 'd-img')).toMatchObject({ status: 'changed' });
    expect(doc(h, 'd-img').record.key).toBe(hexKey(61));
    await h.controller.actions.acceptChangedDocument('d-img');
    expect(doc(h, 'd-img').status).toBe('ready');
    expect(doc(h, 'd-img').record).toMatchObject({ key: hexKey(62), bookmarks: [{ id: 'bm' }] });
    expect(doc(h, 'd-img').record.calibration).toBeUndefined();
    expect(doc(h, 'd-img').bytes).toEqual(enc('bytes of photo.png'));
    await h.controller.actions.acceptChangedDocument('d-img');
    expect(h.state().notices.at(-1)?.message).toEqual({ text: 'There is no changed file to accept for this document.' });
  });

  it('removing a document disposes its session, clears the split pane and its links', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF]);
    await openNative(h, 'a.cad', 1);
    h.controller.actions.setSplit({ enabled: true, right: { kind: 'document', id: 'doc-pdf' } });
    h.controller.actions.removeDocument('doc-pdf');
    await h.controller.idle();
    expect(h.pdf.sessions[0].disposed).toBe(true);
    expect(h.state().documents).toEqual([]);
    expect(h.state().split.right).toBeNull();
    expect(h.state().overlays).toEqual({});
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'success' });
    h.controller.actions.removeDocument('doc-pdf');
  });

  it('bookmarks, annotations and calibration go through the workspace operations; invalid changes become notices', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF, { id: 'd-img', path: '/boards/docs/photo.png', kind: 'image', key: 63 }]);
    await openNative(h, 'a.cad', 1);
    const { setBookmarks, setAnnotations, setCalibration: calibrate } = h.controller.actions;
    setBookmarks('doc-pdf', [{ id: 'b1', page: 2, label: ' Power rail ' }, { id: 'b2', page: 3, label: 'Clock' }]);
    expect(doc(h, 'doc-pdf').record.bookmarks).toEqual([{ id: 'b1', page: 2, label: 'Power rail' }, { id: 'b2', page: 3, label: 'Clock' }]);
    setBookmarks('doc-pdf', [{ id: 'b2', page: 3, label: 'Clock' }]);
    expect(doc(h, 'doc-pdf').record.bookmarks.map(b => b.id)).toEqual(['b2']);
    h.clock.now = T0 + 5000;
    setAnnotations('doc-pdf', [{ id: 'a1', page: 1, x: 3, y: 4, text: ' check C12 ', updatedAt: '' }]);
    expect(doc(h, 'doc-pdf').record.annotations).toEqual([{ id: 'a1', page: 1, x: 3, y: 4, text: 'check C12', updatedAt: new Date(T0 + 5000).toISOString() }]);
    calibrate('d-img', { pixelsPerMm: 8, confirmed: true });
    expect(doc(h, 'd-img').record.calibration).toEqual({ pixelsPerMm: 8, confirmed: true });
    calibrate('d-img', undefined);
    expect(doc(h, 'd-img').record.calibration).toBeUndefined();
    const before = h.state().manifest;
    calibrate('doc-pdf', { pixelsPerMm: 8, confirmed: true });
    expect(h.state().manifest).toBe(before);
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error', message: { text: 'Only images can be calibrated.' } });
  });

  it('exports after flushing the workspace, only the known documents the user listed', async () => {
    const h = createHarness({ saveDelayMs: 10_000 });
    seedWorkspace(h, 1, '/boards/a.cad', [PDF]);
    await openNative(h, 'a.cad', 1);
    h.controller.actions.setActiveTab('documents');
    const result = await h.controller.actions.exportWorkspace({ documentIds: ['doc-pdf', 'ghost'], includeBoard: false, includeNotes: true });
    expect(result).toEqual({ path: '/exports/bundle.zip', files: 3, bytes: 1234 });
    expect(h.desktop.exportRequests).toEqual([{ boardKey: hexKey(1), documentIds: ['doc-pdf'], includeBoard: false, includeNotes: true }]);
    const log = h.desktop.log;
    expect(log.indexOf(`saveWorkspace:${hexKey(1)}`)).toBeGreaterThan(-1);
    expect(log.indexOf(`saveWorkspace:${hexKey(1)}`)).toBeLessThan(log.indexOf('exportWorkspace'));
    h.desktop.exportResult = null;
    expect(await h.controller.actions.exportWorkspace({ documentIds: [], includeBoard: true, includeNotes: false })).toBeNull();
    h.desktop.failures.saveWorkspace = () => new Error('[STORE_CLOSING] closing');
    h.controller.actions.setActiveTab('board');
    const exports = h.desktop.exportRequests.length;
    expect(await h.controller.actions.exportWorkspace({ documentIds: [], includeBoard: false, includeNotes: false })).toBeNull();
    expect(h.desktop.exportRequests).toHaveLength(exports);
  });
});

describe('structured schematics', () => {
  it('parses a real KiCad schematic in the (fake) worker with the real parser and compares it with the board', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    const gate = deferred();
    h.schematicWorkers.gates['tiny.kicad_sch'] = gate.promise;
    h.desktop.picks.push([documentPayload('/boards/docs/tiny.kicad_sch', 'schematic', 71, { data: enc(kicadText()) })]);
    await h.controller.actions.attachDocuments(['schematic']);
    expect(doc(h, 'id-1')).toMatchObject({ designState: 'parsing', status: 'loading' });
    gate.resolve();
    await h.controller.idle();
    const runtime = doc(h, 'id-1');
    expect(runtime).toMatchObject({ status: 'ready', designState: 'ready' });
    expect(runtime.design?.schematic.format).toBe('kicad-sch');
    expect(h.controller.sheetsOf('id-1').map(s => s.path)).toEqual(['']);
    expect(h.controller.sheetsOf('nope')).toEqual([]);
    const link = h.state().link;
    expect(link?.summary.refs).toMatchObject({ unique: 2, boardOnly: 1, schematicOnly: 0 });
    expect(link?.refs.rows.find(row => row.ref === 'U1')?.status).toBe('board-only');
    // The same R1 pin (number 1) is on net SIG in the schematic and VCC on the board: a visible disagreement, never auto-resolved.
    expect(link?.summary.pins.netDiffers).toBeGreaterThan(0);
  });

  it('reports an unrecognized or malformed schematic as a structured error, with no index', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    h.desktop.picks.push([documentPayload('/boards/docs/junk.kicad_sch', 'schematic', 72, { data: enc('hello') })]);
    await h.controller.actions.attachDocuments();
    await h.controller.idle();
    expect(doc(h, 'id-1')).toMatchObject({ status: 'error', designState: 'error', designError: { code: 'UNRECOGNIZED' } });
    expect(doc(h, 'id-1').design).toBeUndefined();
    expect(h.state().link).toBeNull();
    expect(h.state().probe.schematic).toBeNull();
  });

  it('ignores a reply of an older request and applies the matching one (latest wins)', async () => {
    const h = createHarness();
    await openNative(h, 'a.cad', 1);
    const gate = deferred();
    h.schematicWorkers.gates['divider.kicad_sch'] = gate.promise;
    h.schematicWorkers.designs['divider.kicad_sch'] = dividerDesign();
    h.desktop.picks.push([documentPayload(SCH_PATH, 'schematic', 73)]);
    await h.controller.actions.attachDocuments();
    h.schematicWorkers.emit[0]({ requestId: 999, design: designOf(dividerDesign().schematic) });
    expect(doc(h, 'id-1').designState).toBe('parsing');
    gate.resolve();
    await h.controller.idle();
    expect(doc(h, 'id-1').designState).toBe('ready');
  });

  it('removing a schematic terminates its worker and drops the link report and the probe view', async () => {
    const h = await withSchematic();
    expect(h.state().link).not.toBeNull();
    expect(h.state().probe.schematic).toMatchObject({ documentId: 'doc-sch', instancePath: '', selection: {} });
    h.controller.actions.removeDocument('doc-sch');
    await h.controller.idle();
    expect(h.schematicWorkers.terminated).toBe(1);
    expect(h.state().link).toBeNull();
    expect(h.state().probe.schematic).toBeNull();
  });
});

describe('selection and cross-probe', () => {
  it('one selection reaches subscribers as one notification, however many slices it changes', async () => {
    const h = await withSchematic(dividerDesign(), dividerBoard('a.cad'), [PDF]);
    const listener = vi.fn();
    h.controller.subscribe(listener);
    h.controller.actions.selectPin(pinOf(h, 'r1', '1').id, { center: true });
    expect(listener).toHaveBeenCalledTimes(1);
    h.controller.actions.selectSchematicSymbol({ documentId: 'doc-sch', instancePath: '', symbolId: 'R2', ref: 'R2' });
    expect(listener).toHaveBeenCalledTimes(2);
    h.controller.actions.selectComponent('r2');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('board part / pad / net → unique schematic target with symbol, pin and net keys', async () => {
    const h = await withSchematic();
    const design = h.state().documents[0].design!;
    const { selectComponent, selectPin, selectNet } = h.controller.actions;
    selectComponent('r1');
    expect(h.state().selection).toEqual({ componentId: 'r1', pinId: null, net: null });
    expect(h.state().probe).toMatchObject({ origin: 'board', nonce: 0, documentRef: 'R1', schematicMapping: { status: 'unique' }, schematic: { documentId: 'doc-sch', instancePath: '', selection: { symbolKey: symbolKey('', 'R1') } } });
    const pin = pinOf(h, 'r1', '1');
    selectPin(pin.id, { center: true });
    const netId = design.connectivity.pinNet[pinKey('', 'R1', 'R1#1')];
    expect(netId).toBeDefined();
    expect(h.state().selection).toEqual({ componentId: 'r1', pinId: pin.id, net: 'VCC' });
    expect(h.state().probe.nonce).toBe(1);
    expect(h.state().probe.schematic?.selection).toEqual({ symbolKey: symbolKey('', 'R1'), pinKey: pinKey('', 'R1', 'R1#1'), netId });
    // Another net keeps neither the pad nor the part; the pad's own net keeps both.
    selectNet('VCC');
    expect(h.state().selection).toEqual({ componentId: 'r1', pinId: pin.id, net: 'VCC' });
    selectNet('OUT');
    expect(h.state().selection).toEqual({ componentId: null, pinId: null, net: 'OUT' });
    expect(h.state().probe).toMatchObject({ origin: 'board', documentRef: 'OUT', schematicMapping: null });
    expect(h.state().probe.schematic?.selection.netId).toBe(design.connectivity.nets.find(n => n.name === 'OUT')?.id);
    selectNet('NO-SUCH-NET');
    expect(h.state().selection.net).toBe('OUT');
    selectComponent('missing-id');
    expect(h.state().selection.net).toBe('OUT');
  });

  it('keeps `missing` mappings visible but links nothing: a part without schematic counterpart and partial names', async () => {
    const board = makeBoard('a.cad', [{ ref: 'U1', id: 'u1', pins: [['1', 'X']] }, { ref: 'R10', id: 'r10', pins: [['1', 'X']] }, { ref: 'R1', id: 'r1', pins: [['1', 'VCC'], ['2', 'OUT']] }]);
    const h = await withSchematic(dividerDesign(), board);
    h.controller.actions.selectComponent('u1');
    expect(h.state().probe.schematicMapping).toMatchObject({ status: 'missing', reasons: ['no-schematic-part'] });
    expect(h.state().probe.schematic?.selection).toEqual({});
    h.controller.actions.selectComponent('r10');
    expect(h.state().probe.schematicMapping?.status).toBe('missing');
    h.controller.actions.selectComponent('r1');
    expect(h.state().probe.schematicMapping?.status).toBe('unique');
    h.controller.actions.clearSelection();
    expect(h.state().selection).toEqual({ componentId: null, pinId: null, net: null });
    expect(h.state().probe).toMatchObject({ origin: null, schematicMapping: null, boardMapping: null, documentRef: null });
    expect(h.state().probe.schematic).toMatchObject({ documentId: 'doc-sch', selection: {} });
  });

  it('ambiguous schematic placements need an explicit choice (index into the candidates)', async () => {
    const board = makeBoard('a.cad', [{ ref: 'R1', id: 'r1', pins: [['1', 'A'], ['2', 'B']] }]);
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [{ id: 'doc-twin', path: '/boards/docs/twin.kicad_sch', kind: 'schematic', key: 81 }]);
    h.schematicWorkers.designs['twin.kicad_sch'] = twinDesign();
    await openNative(h, 'a.cad', 1, board);
    h.controller.actions.selectComponent('r1');
    const probe = h.state().probe;
    expect(probe.schematicMapping).toMatchObject({ status: 'ambiguous', total: 2, reasons: ['several-schematic-placements'] });
    expect(probe.schematic?.selection).toEqual({});
    h.controller.actions.chooseSchematicTarget(7);
    expect(h.state().probe).toBe(probe);
    h.controller.actions.chooseSchematicTarget(1);
    const chosen = h.state().probe;
    expect(chosen.schematic).toEqual({ documentId: 'doc-twin', instancePath: '/amp2', selection: { symbolKey: symbolKey('/amp2', 'r') } });
    expect(chosen.nonce).toBe(1);
    expect(chosen.schematicMapping?.status).toBe('ambiguous');
    expect(h.controller.sheetsOf('doc-twin').map(s => s.path)).toEqual(['', '/amp1', '/amp2']);
    h.controller.actions.setSchematicInstance('doc-twin', '/amp1');
    expect(h.state().probe.schematic).toMatchObject({ instancePath: '/amp1', selection: { symbolKey: symbolKey('/amp2', 'r') } });
    h.controller.actions.setSchematicInstance('doc-twin', '/nope');
    h.controller.actions.setSchematicInstance('ghost', '');
    expect(h.state().probe.schematic?.instancePath).toBe('/amp1');
  });

  it('schematic symbol / pin / net → board selection (origin schematic), without bouncing back', async () => {
    const h = await withSchematic();
    const { selectSchematicSymbol, selectSchematicPin, selectSchematicNet } = h.controller.actions;
    selectSchematicSymbol({ documentId: 'doc-sch', instancePath: '', symbolId: 'R2', ref: 'R2' });
    expect(h.state().selection).toEqual({ componentId: 'r2', pinId: null, net: null });
    expect(h.state().probe).toMatchObject({ origin: 'schematic', nonce: 1, documentRef: 'R2', boardMapping: { status: 'unique' }, schematicMapping: null, schematic: { selection: { symbolKey: symbolKey('', 'R2') } } });
    selectSchematicPin({ documentId: 'doc-sch', instancePath: '', symbolId: 'R2', pinId: 'R2#2', ref: 'R2', pinNumber: '2' });
    expect(h.state().selection).toEqual({ componentId: 'r2', pinId: pinOf(h, 'r2', '2').id, net: 'GND' });
    expect(h.state().probe.schematic?.selection).toMatchObject({ symbolKey: symbolKey('', 'R2'), pinKey: pinKey('', 'R2', 'R2#2') });
    expect(h.state().probe.schematic?.selection.netId).toBeDefined();
    expect(h.state().probe.nonce).toBe(2);
    const netId = h.state().documents[0].design!.connectivity.nets.find(n => n.name === 'OUT')!.id;
    selectSchematicNet('doc-sch', netId);
    expect(h.state().selection).toEqual({ componentId: null, pinId: null, net: 'OUT' });
    expect(h.state().probe.schematic?.selection).toEqual({ netId });
    selectSchematicNet('doc-sch', null);
    expect(h.state().probe.schematic?.selection).toEqual({});
    selectSchematicSymbol({ documentId: 'ghost', instancePath: '', symbolId: 'R2', ref: 'R2' });
    expect(h.state().probe.nonce).toBe(3);
  });

  it('a duplicated board reference is never picked automatically (chooseBoardTarget); a part missing on the board links nothing', async () => {
    const board = makeBoard('a.cad', [{ ref: 'R2', id: 'r2a', pins: [['1', 'OUT'], ['2', 'GND']] }, { ref: 'R2', id: 'r2b', pins: [['1', 'OUT'], ['2', 'GND']] }]);
    const h = await withSchematic(dividerDesign(), board);
    h.controller.actions.selectComponent('r2a');
    h.controller.actions.selectSchematicSymbol({ documentId: 'doc-sch', instancePath: '', symbolId: 'R2', ref: 'R2' });
    expect(h.state().selection.componentId).toBeNull();
    const mapping = h.state().probe.boardMapping;
    expect(mapping).toMatchObject({ status: 'ambiguous', total: 2, reasons: expect.arrayContaining(['several-board-parts']) });
    h.controller.actions.chooseBoardTarget(1);
    expect(h.state().selection.componentId).toBe('r2b');
    expect(h.state().probe).toMatchObject({ origin: 'schematic', boardMapping: null });
    h.controller.actions.chooseBoardTarget(0);
    expect(h.state().selection.componentId).toBe('r2b');
    h.controller.actions.selectSchematicSymbol({ documentId: 'doc-sch', instancePath: '', symbolId: 'R1', ref: 'R1' });
    expect(h.state().selection.componentId).toBeNull();
    expect(h.state().probe.boardMapping).toMatchObject({ status: 'missing', reasons: ['no-board-component'] });
  });

  it('user aliases link on request only, rebuild the link report, and can be removed again', async () => {
    const board = makeBoard('a.cad', [{ ref: 'R9', id: 'r9', pins: [['1', 'OUT'], ['2', 'GND']] }, { ref: 'R1', id: 'r1', pins: [['1', 'VCC'], ['2', 'OUT']] }]);
    const h = await withSchematic(dividerDesign(), board);
    h.controller.actions.selectComponent('r9');
    expect(h.state().probe.schematicMapping?.status).toBe('missing');
    const link = h.state().link;
    h.controller.actions.setCamera('board', { zoom: 2 });
    expect(h.state().link).toBe(link);
    h.controller.actions.setAlias('refs', 'R2', 'R9');
    expect(h.state().manifest?.aliases?.refs).toEqual({ R2: 'R9' });
    expect(h.state().link).not.toBe(link);
    expect(h.state().link?.refs.rows.find(row => row.ref === 'R9')?.status).toBe('alias');
    expect(h.state().probe.schematicMapping).toMatchObject({ status: 'unique' });
    expect(h.state().probe.schematic?.selection.symbolKey).toBe(symbolKey('', 'R2'));
    h.controller.actions.setAlias('refs', 'R9', 'R9');
    expect(h.state().notices.at(-1)).toMatchObject({ kind: 'error' });
    h.controller.actions.removeAlias('refs', 'R2');
    expect(h.state().manifest?.aliases).toBeUndefined();
    expect(h.state().probe.schematicMapping?.status).toBe('missing');
  });
});

describe('PDF cross-reference', () => {
  const candidates = () => [
    { kind: 'ref' as const, name: 'R1', hits: [hit(1, 10, 'R1')] },
    { kind: 'ref' as const, name: 'R9', hits: [hit(1, 30, 'R9')] },
    { kind: 'ref' as const, name: 'U1', hits: [hit(1, 50, 'U1'), hit(2, 50, 'U1')] },
    { kind: 'net' as const, name: 'GND', hits: [hit(3, 70, 'GND')] },
  ];
  async function withPdf(board = dividerBoard('a.cad'), setup: (h: Harness) => void = () => {}): Promise<Harness> {
    const h = createHarness();
    h.pdf.defaults.candidates = candidates();
    setup(h);
    seedWorkspace(h, 1, '/boards/a.cad', [PDF]);
    await openNative(h, 'a.cad', 1, board);
    return h;
  }

  it('scans for the board references and nets once and links every hit with an explicit status', async () => {
    const h = await withPdf();
    const [session] = h.pdf.sessions;
    expect(session.scans).toHaveLength(1);
    expect([...session.scans[0].refs].sort()).toEqual(['R1', 'R2', 'U1']);
    expect([...session.scans[0].nets].sort()).toEqual(['GND', 'OUT', 'VCC']);
    const report = h.state().pdfLinks['doc-pdf'];
    expect(report.links.map(link => [link.name, link.status])).toEqual([['R1', 'unique'], ['R9', 'missing'], ['U1', 'duplicate-hits'], ['GND', 'unique']]);
    expect(report.truncated).toBe(false);
    const overlay = h.state().overlays['doc-pdf'];
    expect(overlay.state).toBe('ready');
    expect(overlay.probeRegions.map(region => [region.id, region.label, region.page])).toEqual([['0:0', 'R1', 1], ['2:0', 'U1', 1], ['2:1', 'U1', 2], ['3:0', 'GND', 3]]);
    expect(overlay.highlights).toEqual([]);
  });

  it('discloses a truncated scan in the report and the overlay state', async () => {
    const h = await withPdf(dividerBoard('a.cad'), harness => { harness.pdf.defaults.truncated = true; });
    expect(h.state().pdfLinks['doc-pdf'].truncated).toBe(true);
    expect(h.state().overlays['doc-pdf'].state).toBe('truncated');
  });

  it('highlights the literal hits of the selected reference and keeps unchanged overlays referentially stable', async () => {
    const h = await withPdf();
    const regions = h.state().overlays['doc-pdf'].probeRegions;
    h.controller.actions.selectComponent('r1');
    const overlay = h.state().overlays['doc-pdf'];
    expect(h.state().probe.documentRef).toBe('R1');
    expect(overlay.highlights).toMatchObject([{ kind: 'selection', page: 1, label: 'R1', active: true }]);
    expect(overlay.probeRegions).toBe(regions);
    h.controller.actions.selectComponent('u1');
    expect(h.state().overlays['doc-pdf'].highlights).toHaveLength(2);
    h.controller.actions.selectComponent('r2');
    expect(h.state().overlays['doc-pdf'].highlights).toEqual([]);
  });

  it('activating a region selects the board part (a click on one of several hits picks that occurrence); nets select by name', async () => {
    const h = await withPdf();
    h.controller.actions.activateProbeRegion('doc-pdf', '0:0');
    expect(h.state().selection.componentId).toBe('r1');
    expect(h.state().probe).toMatchObject({ origin: 'document', nonce: 1 });
    h.controller.actions.activateProbeRegion('doc-pdf', '2:1');
    expect(h.state().selection.componentId).toBe('u1');
    h.controller.actions.activateProbeRegion('doc-pdf', '3:0');
    expect(h.state().selection).toEqual({ componentId: null, pinId: null, net: 'GND' });
    const probe = h.state().probe;
    h.controller.actions.activateProbeRegion('doc-pdf', '1:0');
    h.controller.actions.activateProbeRegion('ghost', '0:0');
    expect(h.state().probe).toBe(probe);
  });

  it('several board parts with the same reference are presented as an explicit choice, never auto-linked', async () => {
    const board = makeBoard('a.cad', [{ ref: 'R1', id: 'r1a', pins: [['1', 'A']] }, { ref: 'R1', id: 'r1b', pins: [['1', 'B']] }]);
    const h = await withPdf(board);
    expect(h.state().pdfLinks['doc-pdf'].links.find(link => link.name === 'R1')).toMatchObject({ status: 'ambiguous-board-ref', needsTargetChoice: true });
    h.controller.actions.activateProbeRegion('doc-pdf', '0:0');
    expect(h.state().selection.componentId).toBeNull();
    expect(h.state().probe.boardMapping).toMatchObject({ status: 'ambiguous', total: 2, candidates: [{ componentId: 'r1a' }, { componentId: 'r1b' }] });
    expect(h.state().probe).toMatchObject({ origin: 'document', nonce: 1 });
    h.controller.actions.chooseBoardTarget(1);
    expect(h.state().selection.componentId).toBe('r1b');
    expect(h.state().probe).toMatchObject({ origin: 'document', boardMapping: null, nonce: 2 });
  });

  it('scans one PDF at a time (every scan builds a full text index)', async () => {
    const h = createHarness();
    const gate = deferred();
    h.pdf.scanGates['doc-a'] = gate.promise;
    h.pdf.defaults.candidates = candidates();
    seedWorkspace(h, 1, '/boards/a.cad', [{ id: 'doc-a', path: '/boards/docs/a.pdf', kind: 'pdf', key: 91 }, { id: 'doc-b', path: '/boards/docs/b.pdf', kind: 'pdf', key: 92 }]);
    h.boardWorkers.replies['a.cad'] = dividerBoard('a.cad');
    h.desktop.boards.set('/boards/a.cad', { name: 'a.cad', path: '/boards/a.cad', data: enc('a'), key: hexKey(1) });
    await h.controller.actions.openRecent('/boards/a.cad');
    await vi.waitFor(() => expect(h.pdf.sessions).toHaveLength(2));
    await vi.waitFor(() => expect(h.pdf.sessions[0].scans).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.pdf.sessions[1].scans).toHaveLength(0);
    expect(h.state().overlays['doc-b'].state).toBe('working');
    gate.resolve();
    await h.controller.idle();
    expect(h.pdf.sessions[1].scans).toHaveLength(1);
    expect(Object.keys(h.state().pdfLinks).sort()).toEqual(['doc-a', 'doc-b']);
  });

  it('a scan-only PDF gets an empty overlay and is never scanned; a verdict that arrives later starts the scan', async () => {
    const scanOnly = await withPdf(dividerBoard('a.cad'), harness => { harness.pdf.defaults.searchable = false; });
    expect(scanOnly.pdf.sessions[0].scans).toHaveLength(0);
    expect(scanOnly.state().overlays['doc-pdf']).toEqual({ highlights: [], probeRegions: [], state: 'idle' });
    expect(scanOnly.state().pdfLinks).toEqual({});
    const late = await withPdf(dividerBoard('a.cad'), harness => { harness.pdf.defaults.searchable = null; });
    expect(late.pdf.sessions[0].scans).toHaveLength(0);
    late.pdf.sessions[0].update({ searchable: true });
    await late.controller.idle();
    expect(late.pdf.sessions[0].scans).toHaveLength(1);
    late.pdf.sessions[0].update({ index: { state: 'done', indexedPages: 3, pageCount: 3, items: 9 } });
    expect(late.pdf.sessions[0].scans).toHaveLength(1);
  });
});

describe('unified search', () => {
  it('searches board and schematic synchronously, nothing for an empty query, and resets on a board switch', async () => {
    const h = await withSchematic();
    h.controller.actions.setSearchQuery('R1');
    const search = h.state().search;
    expect(search).toMatchObject({ query: 'R1', pending: false });
    expect(search.result?.groups[0].rows.map(row => row.ref)).toContain('R1');
    expect(search.result?.groups[2].rows.map(row => row.ref)).toContain('R1');
    expect(search.result?.groups[3].rows.map(row => row.name)).not.toContain('R1');
    h.controller.actions.setSearchQuery('  ');
    expect(h.state().search).toEqual({ query: '  ', result: null, pending: false });
    h.controller.actions.setSearchQuery('OUT');
    await openNative(h, 'b.cad', 2);
    expect(h.state().search).toEqual({ query: '', result: null, pending: false });
  });

  it('latest query wins: a slow document search of an older query never replaces the newer result', async () => {
    const h = createHarness();
    seedWorkspace(h, 1, '/boards/a.cad', [PDF]);
    await openNative(h, 'a.cad', 1);
    const [session] = h.pdf.sessions;
    session.hits['R1'] = [hit(1, 5, 'R1 old')];
    session.hits['U1'] = [hit(2, 6, 'U1 new')];
    const gate = deferred();
    session.findGate = gate.promise;
    h.controller.actions.setSearchQuery('R1');
    expect(h.state().search.pending).toBe(true);
    expect(h.state().search.result?.groups[0].rows.map(row => row.ref)).toEqual(['R1']);
    h.controller.actions.setSearchQuery('U1');
    expect(session.searches).toEqual(['R1', 'U1']);
    gate.resolve();
    await h.controller.idle();
    const { search } = h.state();
    expect(search).toMatchObject({ query: 'U1', pending: false });
    expect(search.result?.groups[4].rows).toMatchObject([{ documentId: 'doc-pdf', documentName: 'service.pdf', page: 2, context: 'U1 new' }]);
    expect(search.result?.groups[0].rows.map(row => row.ref)).toEqual(['U1']);
  });

  it('activating a row selects/centers on the board, opens the sheet or the document page', async () => {
    const h = await withSchematic(dividerDesign(), dividerBoard('a.cad'), [PDF]);
    const { setSearchQuery, activateSearchRow } = h.controller.actions;
    h.pdf.sessions[0].hits['R2'] = [hit(2, 9, 'R2', { x: 11, y: 12, width: 13, height: 14 }), hit(3, 9, 'see R2 here')];
    setSearchQuery('R2');
    await h.controller.idle();
    const groups = h.state().search.result!.groups;
    activateSearchRow(groups[0].rows[0]);
    expect(h.state().selection.componentId).toBe('r2');
    expect(h.state().probe).toMatchObject({ origin: 'search', nonce: 1 });
    activateSearchRow(groups[2].rows[0]);
    expect(h.state().activeTab).toBe('schematic');
    expect(h.state().probe).toMatchObject({ origin: 'search', schematic: { documentId: 'doc-sch', selection: { symbolKey: symbolKey('', 'R2') } } });
    expect(h.state().selection.componentId).toBe('r2');
    // A document hit that is literally the reference selects the part; otherwise only the page and a highlight move.
    h.controller.actions.clearSelection();
    activateSearchRow(groups[4].rows[0]);
    expect(h.state().activeTab).toBe('documents');
    expect(h.controller.actions.cameraOf('doc-pdf')).toMatchObject({ page: 2 });
    expect(h.state().overlays['doc-pdf'].highlights.find(item => item.id.startsWith('search:'))).toMatchObject({ kind: 'selection', page: 2, rect: { x: 11, y: 12, width: 13, height: 14 } });
    expect(h.state().selection.componentId).toBe('r2');
    h.controller.actions.clearSelection();
    activateSearchRow(groups[4].rows[1]);
    expect(h.state().selection.componentId).toBeNull();
    expect(h.controller.actions.cameraOf('doc-pdf')).toMatchObject({ page: 3 });
    // Net rows.
    setSearchQuery('GND');
    activateSearchRow(h.state().search.result!.groups[1].rows[0]);
    expect(h.state().selection.net).toBe('GND');
    const netRow = h.state().search.result!.groups[3].rows.find(row => row.name === 'GND')!;
    activateSearchRow(netRow);
    expect(h.state().probe.origin).toBe('search');
    expect(h.state().probe.schematic?.selection.netId).toBe(netRow.netId);
  });

  it('a split pane that already shows the target document keeps the active tab', async () => {
    const h = await withSchematic();
    h.controller.actions.setSplit({ enabled: true, right: { kind: 'schematic', id: 'doc-sch' } });
    h.controller.actions.setSearchQuery('R1');
    h.controller.actions.activateSearchRow(h.state().search.result!.groups[2].rows[0]);
    expect(h.state().activeTab).toBe('board');
  });
});
